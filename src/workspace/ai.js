'use strict';
// IA de l'espace de travail : discussion par module (avec mémoire), point de situation, et propositions structurées
// que la personne valide avant qu'elles soient enregistrées (l'IA ne modifie jamais les données toute seule).
const express = require('express');
const { db, nowISO } = require('../db');
const config = require('../config');
const limits = require('../middleware/limits');
const claude = require('../services/claude');
const knowledge = require('../ai/knowledge');
const P = require('../ai/workspace-prompts');
const A = require('./access');
const { ids: MODULE_IDS } = require('./modules');
const { HttpError, asyncHandler, log, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const CHAT_MODULES = ['general', ...MODULE_IDS.filter((m) => m !== 'dashboard')];
const MODULE_MIN = { budget: 'manager', hr: 'manager', sales: 'manager' };

// ---------- Contexte : ce que l'IA « voit » de l'organisation (limité en taille, filtré par rôle et par antenne) ----------
const money = (n, cur) => `${Number(n).toLocaleString('fr-FR')} ${cur}`;

function ctxOrg(req) {
  const o = req.org;
  const branches = db.prepare('SELECT name, location FROM branches WHERE org_id = ?').all(o.id);
  const mem = db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(o.id).c;
  return [
    `Organisation : ${o.name}${o.sector ? ` (secteur : ${o.sector})` : ''}. Monnaie : ${o.currency}.`,
    o.description ? `Présentation : ${oneLine(o.description, 600)}` : '',
    `Équipe : ${mem} personne(s). Antennes : ${branches.length ? branches.map((b) => b.name + (b.location ? ` (${b.location})` : '')).join(' ; ') : 'aucune (activité centrale)'}.`,
    `Personne qui te parle : ${req.user.name}, rôle « ${A.ROLE_LABEL[req.member.role]} »${req.member.title ? `, poste « ${req.member.title} »` : ''}.`,
    `Date du jour : ${nowISO().slice(0, 10)}.`,
  ].filter(Boolean).join('\n');
}

function ctxSupport(req) {
  const sc = A.scope(req, 't.branch_id');
  const rows = db.prepare(`SELECT t.id, t.customer_name, t.channel, t.subject, t.status, t.priority, t.updated_at FROM tickets t WHERE t.org_id = ? AND t.status != 'resolved'${sc.sql}
    ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.updated_at LIMIT 20`).all(req.org.id, ...sc.args);
  const c = db.prepare(`SELECT status, COUNT(*) n FROM tickets t WHERE org_id = ?${sc.sql} GROUP BY status`).all(req.org.id, ...sc.args);
  return `SERVICE CLIENT — compteurs : ${c.map((x) => `${x.status}=${x.n}`).join(', ') || 'aucune demande'}.\nDemandes non résolues (les plus urgentes d'abord) :\n` +
    (rows.map((t) => `- #${t.id} [${t.status}/${t.priority}] ${oneLine(t.customer_name, 60)} via ${t.channel} : ${oneLine(t.subject, 120)} (maj ${t.updated_at.slice(0, 10)})`).join('\n') || '(aucune)');
}

function ctxProjects(req) {
  const sc = A.scope(req, 'p.branch_id');
  const today = nowISO().slice(0, 10);
  const ps = db.prepare(`SELECT p.id, p.name, p.status, p.due, COUNT(t.id) n, COALESCE(SUM(t.status='done'),0) d FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.org_id = ?${sc.sql} GROUP BY p.id ORDER BY p.id DESC LIMIT 15`).all(req.org.id, ...sc.args);
  const sct = A.scope(req, 't.branch_id');
  const ts = db.prepare(`SELECT t.title, t.status, t.priority, t.due, u.name AS who, p.name AS pname FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.org_id = ? AND t.status != 'done'${sct.sql} ORDER BY t.due IS NULL, t.due LIMIT 25`).all(req.org.id, ...sct.args);
  return 'PROJETS :\n' + (ps.map((p) => `- ${oneLine(p.name, 80)} [${p.status}] ${p.d}/${p.n} tâches faites${p.due ? `, échéance ${p.due}` : ''}`).join('\n') || '(aucun)') +
    '\nTâches ouvertes (échéances proches d\'abord) :\n' +
    (ts.map((t) => `- ${oneLine(t.title, 100)} [${t.status}/${t.priority}]${t.pname ? ` projet « ${oneLine(t.pname, 60)} »` : ''}${t.who ? `, assignée à ${t.who}` : ', non assignée'}${t.due ? `, échéance ${t.due}${t.due < today ? ' (EN RETARD)' : ''}` : ''}`).join('\n') || '(aucune)');
}

function ctxBudget(req) {
  if (!A.can(req, 'manager')) return 'BUDGET : non accessible pour le rôle de cette personne.';
  const s = require('./budget').summary(req);
  const cur = req.org.currency;
  return `BUDGET du mois ${s.month} : entrées ${money(s.income, cur)}, sorties ${money(s.expense, cur)}, solde ${money(s.balance, cur)}.\nDépenses par catégorie :\n` +
    (s.categories.map((c) => `- ${oneLine(c.category, 60)} : ${money(c.spent, cur)}${c.limit ? ` / limite ${money(c.limit, cur)}${c.spent > c.limit ? ' (DÉPASSÉE)' : ''}` : ''}`).join('\n') || '(aucune dépense)') +
    '\nDernières lignes :\n' + (s.entries.slice(0, 15).map((e) => `- ${e.date} ${e.kind === 'income' ? 'ENTRÉE' : 'SORTIE'} ${money(e.amount, cur)} (${oneLine(e.category, 40)}) ${oneLine(e.label, 80)}`).join('\n') || '(aucune)');
}

function ctxStructure(req) {
  const ps = db.prepare('SELECT p.title, p.description, pp.title AS parent, u.name AS holder FROM positions p LEFT JOIN positions pp ON pp.id = p.parent_id LEFT JOIN users u ON u.id = p.holder_id WHERE p.org_id = ? ORDER BY p.id LIMIT 60').all(req.org.id);
  return 'ORGANIGRAMME (postes) :\n' + (ps.map((p) => `- ${oneLine(p.title, 80)}${p.parent ? ` → rend compte à ${oneLine(p.parent, 80)}` : ' (sommet)'}${p.holder ? `, tenu par ${p.holder}` : ', poste libre'}${p.description ? ` : ${oneLine(p.description, 120)}` : ''}`).join('\n') || '(aucun poste défini)');
}

function ctxProcesses(req) {
  const ps = db.prepare('SELECT title, category, steps FROM processes WHERE org_id = ? ORDER BY category, title LIMIT 40').all(req.org.id);
  return 'PROCÉDURES :\n' + (ps.map((p) => `- ${p.category ? `[${oneLine(p.category, 40)}] ` : ''}${oneLine(p.title, 100)} (${JSON.parse(p.steps).length} étapes)`).join('\n') || '(aucune procédure écrite)');
}

function ctxTeam(req) {
  const rows = db.prepare('SELECT m.role, m.title, u.name, b.name AS branch FROM org_members m JOIN users u ON u.id = m.user_id LEFT JOIN branches b ON b.id = m.branch_id WHERE m.org_id = ? ORDER BY m.id LIMIT 60').all(req.org.id);
  return 'ÉQUIPE :\n' + rows.map((m) => `- ${oneLine(m.name, 60)} : ${A.ROLE_LABEL[m.role]}${m.title ? `, ${oneLine(m.title, 60)}` : ''}${m.branch ? `, antenne ${oneLine(m.branch, 60)}` : ''}`).join('\n');
}

function ctxAlerts(req) {
  const list = require('./insights').alerts(req);
  const h = require('./insights').health(list);
  return `ALERTES ACTUELLES (calculées par des règles, score de santé ${h.score}/100 « ${h.label} ») :\n` + (list.map((a) => `- [${a.level === 'high' ? 'URGENT' : a.level === 'medium' ? 'À SURVEILLER' : 'INFO'}] ${a.title} : ${oneLine(a.text, 160)}`).join('\n') || '(aucune alerte)');
}

function ctxStock(req) {
  const st = require('./stock');
  const list = st.items(req);
  const cur = req.org.currency;
  const lines = list.slice(0, 60).map((i) => {
    const b = st.bestPrice(i.id);
    return `- ${oneLine(i.name, 80)} : ${i.quantity} ${i.unit} (seuil ${i.min_quantity})${i.quantity <= 0 ? ' RUPTURE' : i.min_quantity > 0 && i.quantity <= i.min_quantity ? ' SOUS LE SEUIL' : ''}${b ? `, meilleur prix ${money(b.unitPrice, cur)} chez ${oneLine(b.supplier, 50)}` : ''}`;
  });
  const orders = db.prepare("SELECT o.status, o.quantity, i.name, s.name AS supplier FROM purchase_orders o JOIN stock_items i ON i.id = o.item_id LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND o.status IN ('pending','ordered') ORDER BY o.id DESC LIMIT 15").all(req.org.id);
  const sup = db.prepare('SELECT name FROM suppliers WHERE org_id = ? ORDER BY name LIMIT 20').all(req.org.id).map((s) => oneLine(s.name, 50));
  return `STOCK ET ACHATS :\n${lines.join('\n') || '(aucun article)'}\nFournisseurs : ${sup.join(', ') || 'aucun'}.\nCommandes en cours :\n` + (orders.map((o) => `- ${oneLine(o.name, 80)} × ${o.quantity} [${o.status === 'pending' ? 'À VALIDER' : 'commandée'}]${o.supplier ? ` chez ${oneLine(o.supplier, 50)}` : ''}`).join('\n') || '(aucune)');
}

function ctxCrm(req) {
  const sc = A.scope(req, 'c.branch_id');
  const n = db.prepare(`SELECT COUNT(*) c FROM customers c WHERE c.org_id = ?${sc.sql}`).get(req.org.id, ...sc.args).c;
  if (!A.can(req, 'manager')) return `CLIENTS : ${n} client(s) enregistré(s). Les devis et factures ne sont pas accessibles pour le rôle de cette personne.`;
  const cur = req.org.currency;
  const crm = require('./crm');
  const late = crm.overdueList(req);
  const open = db.prepare("SELECT d.number, d.kind, d.status, d.total, d.paid, d.due, c.name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND ((d.kind = 'invoice' AND d.status = 'sent') OR (d.kind = 'quote' AND d.status = 'sent')) ORDER BY d.id DESC LIMIT 20").all(req.org.id);
  return `CLIENTS ET VENTES : ${n} client(s).\nFactures en retard :\n` + (late.slice(0, 10).map((d) => `- ${d.number} ${oneLine(d.customer, 60)} : reste ${money(d.total - d.paid, cur)}, échéance ${d.due}`).join('\n') || '(aucune)') +
    '\nDevis et factures en attente :\n' + (open.map((d) => `- ${d.number} (${d.kind === 'quote' ? 'devis envoyé' : 'facture envoyée'}) ${oneLine(d.name, 60)} : ${money(d.total, cur)}${d.kind === 'invoice' ? `, payé ${money(d.paid, cur)}` : ''}${d.due ? `, échéance ${d.due}` : ''}`).join('\n') || '(aucun)');
}

function ctxSales(req) {
  if (!A.can(req, 'manager')) return 'ASSISTANT COMMERCIAL : non accessible pour le rôle de cette personne.';
  const o = req.org.id; const cur = req.org.currency;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const n = (sql, ...a) => db.prepare(sql).get(o, ...a).c;
  const camp = db.prepare("SELECT CASE WHEN campaign = '' THEN '(sans campagne)' ELSE campaign END AS c, COUNT(*) n, COUNT(DISTINCT customer_id) p FROM chats WHERE org_id = ? GROUP BY campaign ORDER BY n DESC LIMIT 8").all(o);
  const orders = db.prepare("SELECT d.number, d.total, d.status, c.name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = 'order' ORDER BY d.id DESC LIMIT 10").all(o);
  return `ASSISTANT COMMERCIAL PUBLIC : ${req.org.chat_enabled ? 'activé' : 'désactivé'}, ${n('SELECT COUNT(*) c FROM catalog WHERE org_id = ? AND active = 1')} article(s) au catalogue, ${n('SELECT COUNT(*) c FROM chats WHERE org_id = ? AND created_at >= ?', since)} conversation(s) sur 7 jours, ${n("SELECT COUNT(*) c FROM customers WHERE org_id = ? AND stage = 'prospect'")} prospect(s) non convertis, ${n("SELECT COUNT(*) c FROM chats WHERE org_id = ? AND status = 'handoff'")} conversation(s) en attente d'un conseiller.\nCampagnes (conversations / prospects enregistrés) :\n` + (camp.map((x) => `- ${oneLine(x.c, 40)} : ${x.n} / ${x.p}`).join('\n') || '(aucune)') +
    '\nDernières commandes :\n' + (orders.map((x) => `- ${x.number} ${oneLine(x.name, 60)} : ${money(x.total, cur)} [${x.status === 'pending' ? 'À VALIDER' : x.status}]`).join('\n') || '(aucune)');
}

function ctxHr(req) {
  if (!A.can(req, 'manager')) return 'RESSOURCES HUMAINES : non accessible pour le rôle de cette personne.';
  const hr = require('./hr');
  const emps = hr.employees(req).filter((e) => e.status === 'active');
  const showPay = A.can(req, 'admin');
  const pending = db.prepare("SELECT l.kind, l.start, l.end, e.name FROM leaves l JOIN employees e ON e.id = l.employee_id WHERE l.org_id = ? AND l.status = 'pending' ORDER BY l.start LIMIT 10").all(req.org.id);
  return `RESSOURCES HUMAINES : ${emps.length} employé(s) en poste, ${hr.leavesOn(req, nowISO().slice(0, 10)).length} en congé aujourd'hui.\n` +
    emps.slice(0, 40).map((e) => `- ${oneLine(e.name, 60)}${e.job ? `, ${oneLine(e.job, 60)}` : ''}${showPay && e.salary ? `, salaire ${money(e.salary, req.org.currency)}` : ''}`).join('\n') +
    '\nDemandes de congé à traiter :\n' + (pending.map((l) => `- ${oneLine(l.name, 60)} du ${l.start} au ${l.end}`).join('\n') || '(aucune)');
}

const BUILDERS = { sales: ctxSales, stock: ctxStock, crm: ctxCrm, hr: ctxHr, alerts: ctxAlerts, support: ctxSupport, projects: ctxProjects, budget: ctxBudget, structure: ctxStructure, processes: ctxProcesses, team: ctxTeam };

function buildData(req, module) {
  const parts = [ctxOrg(req)];
  const mods = module === 'general' ? Object.keys(BUILDERS) : [module];
  for (const m of mods) parts.push(BUILDERS[m](req));
  return parts.join('\n\n').slice(0, 16000);
}

// Renvoie { stable, system } : « stable » (règles + connaissances) est identique pour tous les appels d'un même module, donc mis en cache ;
// « system » contient les données propres à l'organisation.
function buildParts(req, module, extra) {
  const k = knowledge.load('workspace', module);
  return {
    stable: [P.BASE, P.MODULE[module] || '', extra || '', k ? `Connaissances de référence (fournies par MANAGER-IA) :\n${k}` : ''].filter(Boolean).join('\n\n'),
    system: `<donnees>\n${buildData(req, module)}\n</donnees>`,
  };
}
const buildSystem = (req, module, extra) => { const p = buildParts(req, module, extra); return `${p.stable}\n\n${p.system}`; };

// ---------- Quota de messages IA, commun à toute l'organisation (selon l'offre du propriétaire) ----------
// Compté dans ai_usage (et non dans l'historique de discussion, que chacun peut effacer). La période suit l'abonnement du propriétaire
// (30 jours à partir de la date d'échéance) ; en offre Gratuite, c'est le mois civil. Voir access.quotaWindow.
const usedMonth = (req) => A.aiUsed(req.org);
const monthlyLimit = (req) => A.limitsFor(A.ownerPlan(req.org)).aiMonth;
const fmtDay = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function checkQuota(req) {
  if (!claude.isConfigured()) throw new HttpError(503, "L'IA n'est pas encore activée sur ce serveur.");
  if (usedMonth(req) >= monthlyLimit(req)) throw new HttpError(429, `Limite de messages IA atteinte (${monthlyLimit(req)} messages pour toute l'organisation sur la période en cours). Elle se renouvelle le ${fmtDay(A.quotaWindow(req.org).end)}, ou passez à une offre supérieure à la fin de votre abonnement.`);
}
const remaining = (req) => Math.max(monthlyLimit(req) - usedMonth(req), 0);

function moduleOf(v, req) {
  if (!CHAT_MODULES.includes(v)) throw new HttpError(400, 'Module inconnu.');
  if (MODULE_MIN[v] && !A.can(req, MODULE_MIN[v])) throw new HttpError(403, "Votre rôle ne permet pas d'utiliser l'IA sur ce module.");
  return v;
}

async function ask(req, parts, messages, maxTokens) {
  try {
    return await claude.ask({ stable: parts.stable, system: parts.system, messages, maxTokens });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    log.warn('IA espace de travail : appel échoué :', oneLine(e.message, 200));
    throw new HttpError(502, "L'IA n'a pas pu répondre. Réessayez dans un instant.");
  }
}

function saveMsg(req, module, role, content) {
  if (role === 'user') db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, ?, ?)').run(req.org.id, req.user.id, nowISO());
  return db.prepare('INSERT INTO ai_messages (org_id, user_id, module, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, req.user.id, module, role, content.slice(0, 6000), nowISO());
}

function history(req, module, n = 12) {
  const rows = db.prepare('SELECT role, content FROM ai_messages WHERE org_id = ? AND user_id = ? AND module = ? ORDER BY id DESC LIMIT ?').all(req.org.id, req.user.id, module, n).reverse();
  while (rows.length && rows[0].role !== 'user') rows.shift();
  return rows;
}

router.get('/history', (req, res) => {
  const m = moduleOf(req.query.module || 'general', req);
  res.json({ messages: history(req, m, 30), remaining: remaining(req), limit: monthlyLimit(req), enabled: claude.isConfigured() });
});

router.delete('/history', (req, res) => {
  const m = moduleOf(req.query.module || 'general', req);
  db.prepare('DELETE FROM ai_messages WHERE org_id = ? AND user_id = ? AND module = ?').run(req.org.id, req.user.id, m);
  res.json({ ok: true });
});

router.post('/chat', limits.assistantMinute, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const module = moduleOf(b.module || 'general', req);
  const message = A.text(b.message, 2000, { required: true, msg: 'Écrivez votre message.' });
  checkQuota(req);
  const past = history(req, module);
  const text = await ask(req, buildParts(req, module), [...past, { role: 'user', content: message }], 700);
  saveMsg(req, module, 'user', message);
  saveMsg(req, module, 'assistant', text);
  res.json({ text, remaining: remaining(req) });
}));

// Point de situation de l'organisation : ce qu'il faut regarder en premier aujourd'hui.
router.post('/briefing', limits.assistantMinute, asyncHandler(async (req, res) => {
  checkQuota(req);
  const ask1 = "Fais le point sur mon organisation aujourd'hui : les 3 à 5 urgences ou points d'attention les plus importants, chacun avec l'action concrète à faire. Sois bref (moins de 180 mots). Si l'organisation est encore vide, dis par quoi commencer.";
  const text = await ask(req, buildParts(req, 'general'), [{ role: 'user', content: ask1 }], 500);
  saveMsg(req, 'general', 'user', ask1); // compté dans le quota du jour
  res.json({ text, remaining: remaining(req) });
}));

// ---------- Propositions structurées (validées par la personne, puis appliquées par des fonctions strictes) ----------
function extractJSON(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

function proposalInput(req, kind, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (kind) {
    case 'project-plan': return `Objectif du projet : ${A.text(i.goal, 1000, { required: true, msg: 'Décrivez le projet à réaliser.' })}${i.deadline ? `\nÉchéance souhaitée : ${A.text(i.deadline, 40)}` : ''}`;
    case 'org-structure': return `Complète mon organigramme.${i.context ? ` Précisions : ${A.text(i.context, 800)}` : ''}`;
    case 'process-draft': return `Procédure à rédiger : ${A.text(i.topic, 300, { required: true, msg: 'Indiquez le sujet de la procédure.' })}`;
    case 'budget-plan': return 'Propose mes limites mensuelles par catégorie.';
    case 'ticket-reply': {
      const t = db.prepare('SELECT * FROM tickets WHERE id = ? AND org_id = ?').get(A.id(i.ticketId), req.org.id);
      if (!t || !A.visible(req, t)) throw new HttpError(404, 'Demande introuvable.');
      const msgs = db.prepare('SELECT author, content FROM ticket_messages WHERE ticket_id = ? ORDER BY id DESC LIMIT 8').all(t.id).reverse();
      return `Demande de ${oneLine(t.customer_name, 60)} (canal ${t.channel}) — sujet : ${oneLine(t.subject, 150)}\nÉchange (le plus ancien d'abord) :\n` + msgs.map((m) => `[${m.author === 'customer' ? 'CLIENT' : 'ÉQUIPE'}] ${oneLine(m.content, 800)}`).join('\n');
    }
    case 'sales-proposal': {
      const types = { proposal: 'Offre commerciale', tender: "Réponse à un appel d'offres ou à une demande de devis", prospecting: 'Prospection (premier contact)', followup: 'Relance après un devis sans réponse' };
      const need = A.text(i.need, 1500, { required: true, msg: 'Décrivez le besoin du client ou le marché visé.' });
      let who = 'destinataire non précisé';
      if (i.customerId) { const c = db.prepare('SELECT name, notes FROM customers WHERE id = ? AND org_id = ?').get(A.id(i.customerId), req.org.id); if (!c) throw new HttpError(404, 'Client introuvable.'); who = `${oneLine(c.name, 80)}${c.notes ? ` (notes : ${oneLine(c.notes, 200)})` : ''}`; }
      return `Type : ${types[i.kind] || types.proposal}\nDestinataire : ${who}\nBesoin ou marché visé : ${need}`;
    }
    case 'reorder': return 'Propose les commandes à passer maintenant.';
    case 'payment-reminder': {
      const d = db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.org_id = ? AND d.kind = 'invoice'").get(A.id(i.documentId), req.org.id);
      if (!d || !A.visible(req, d)) throw new HttpError(404, 'Facture introuvable.');
      return `Facture ${d.number} de ${oneLine(d.customer, 80)} : total ${money(d.total, req.org.currency)}, reste à payer ${money(d.total - d.paid, req.org.currency)}, échéance ${d.due || 'non fixée'} (aujourd'hui : ${nowISO().slice(0, 10)}).`;
    }
    default: throw new HttpError(400, 'Type de proposition inconnu.');
  }
}

router.post('/propose', limits.assistantMinute, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const def = P.KINDS[b.kind];
  if (!def) throw new HttpError(400, 'Type de proposition inconnu.');
  if (!A.can(req, def.min)) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  const userMsg = proposalInput(req, b.kind, b.input);
  checkQuota(req);
  const k = knowledge.load('workspace', def.module);
  const out = await ask(req, { stable: `${def.system}${k ? `\n\nConnaissances de référence :\n${k}` : ''}`, system: `<donnees>\n${buildData(req, def.module)}\n</donnees>` }, [{ role: 'user', content: userMsg }], 1500);
  saveMsg(req, def.module, 'user', `(proposition : ${b.kind})`); // compte dans le quota, sans polluer la discussion
  const proposal = extractJSON(out);
  if (!proposal) throw new HttpError(502, "L'IA n'a pas produit de proposition exploitable. Réessayez en précisant votre demande.");
  res.json({ kind: b.kind, proposal, remaining: remaining(req) });
}));

router.post('/apply', (req, res) => {
  const b = req.body || {};
  const def = P.KINDS[b.kind];
  if (!def || def.noApply) throw new HttpError(400, 'Type de proposition inconnu.');
  if (!A.can(req, def.min)) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  const p = b.proposal && typeof b.proposal === 'object' ? b.proposal : {};
  switch (b.kind) {
    case 'project-plan': return res.status(201).json({ id: require('./projects').createProject(req, p) });
    case 'org-structure': return res.status(201).json({ created: require('./structure').createPositions(req, p.positions) });
    case 'process-draft': return res.status(201).json({ id: require('./structure').createProcess(req, p) });
    case 'budget-plan': require('./budget').setPlans(req, p.plans); return res.json({ ok: true });
    case 'reorder': {
      const st = require('./stock');
      const items = st.items(req);
      const sup = db.prepare('SELECT id, name FROM suppliers WHERE org_id = ?').all(req.org.id);
      const orders = (Array.isArray(p.orders) ? p.orders : []).map((o) => {
        const it = items.find((x) => x.name.toLowerCase() === String(o.item || '').trim().toLowerCase());
        if (!it) return null;
        const s = sup.find((x) => x.name.toLowerCase() === String(o.supplier || '').trim().toLowerCase());
        return { itemId: it.id, supplierId: s ? s.id : null, quantity: o.quantity };
      }).filter(Boolean);
      return res.status(201).json({ created: st.createOrders(req, orders) });
    }
    default: throw new HttpError(400, 'Type de proposition inconnu.');
  }
});

module.exports = { router, buildSystem, buildData, extractJSON };
