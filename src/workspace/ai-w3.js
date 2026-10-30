'use strict';
// Contextes IA de la vague 3 : données que l'IA « voit » en plus (délais SLA, base de connaissances, soldes de congés, échéances RH, budget des projets,
// registres et conformité, consentements, codes promo, postes vacants, révisions de procédures). Filtrés par rôle ; l'IA reste en LECTURE SEULE.
const { db } = require('../db');
const A = require('./access');
const W = require('./w3');
const { oneLine } = require('../util');

const safe = (fn) => async (req) => { try { return await fn(req); } catch { return ''; } };
const money = (n, cur) => `${Number(n).toLocaleString('fr-FR')} ${cur}`;

const support = safe(async (req) => {
  const sc = A.scope(req, 't.branch_id');
  const now = new Date().toISOString();
  const br = await db.prepare(`SELECT COUNT(*) c FROM tickets t WHERE t.org_id = ? AND t.status != 'resolved' AND ((t.first_response_at IS NULL AND t.first_due_at < ?) OR t.due_at < ?)${sc.sql}`).get(req.org.id, now, now, ...sc.args);
  const cs = await db.prepare(`SELECT AVG(csat) a, COUNT(csat) n FROM tickets t WHERE t.org_id = ? AND t.csat IS NOT NULL${sc.sql}`).get(req.org.id, ...sc.args);
  const kb = await require('./support-w3').kbForAi(req.org.id, 12);
  return `\nDÉLAIS (SLA) : ${br.c} demande(s) ont dépassé leur délai. Satisfaction moyenne : ${cs.a ? `${(Math.round(Number(cs.a) * 10) / 10)}/5 sur ${cs.n} avis` : 'aucun avis'}.` +
    `\nBASE DE CONNAISSANCES (réponses validées par l'entreprise : appuie-toi dessus pour répondre aux clients, ne les contredis pas) :\n` + (kb.map((a) => `- Q : ${oneLine(a.title, 120)} -> R : ${oneLine(a.body, 360)}`).join('\n') || '(aucun article publié)');
});

const hr = safe(async (req) => {
  if (!A.can(req, 'manager')) return '';
  const H = require('./hr-w3');
  const st = await W.settings(req.org.id);
  const emps = (await require('./hr').employees(req)).filter((e) => e.status === 'active').slice(0, 25);
  const bal = [];
  for (const e of emps) { const b = await H.balanceFor(req, e, new Date().toISOString().slice(0, 4), st); bal.push(`${oneLine(e.name, 40)} ${b.balance} j`); }
  const due = (await H.dueItems(req)).slice(0, 8).map((d) => `${d.kind} ${oneLine(d.who, 40)} ${d.date}${d.expired ? ' (DÉPASSÉE)' : ''}`);
  const jobs = await db.prepare("SELECT j.title, (SELECT COUNT(*) FROM hr_candidates c WHERE c.job_id = j.id) n FROM hr_jobs j WHERE j.org_id = ? AND j.status = 'open' LIMIT 8").all(req.org.id);
  return `\nCONGÉS (jours ouvrables, ${st.leave_accrual} j acquis par mois, report max ${st.leave_carry_max} j ; règles à valider) — soldes : ${bal.join(' ; ') || 'aucun employé'}.` +
    `\nÉCHÉANCES RH (fin de CDD/essai, visites médicales, habilitations) : ${due.join(' ; ') || 'aucune dans la période'}.` +
    `\nRECRUTEMENT : ${jobs.map((j) => `${oneLine(j.title, 50)} (${j.n} candidat(s))`).join(' ; ') || 'aucune offre ouverte'}.`;
});

const projects = safe(async (req) => {
  const sc = A.scope(req, 'p.branch_id');
  const ps = await db.prepare(`SELECT p.id, p.name, p.budget FROM projects p WHERE p.org_id = ? AND p.status = 'active'${sc.sql} ORDER BY p.id DESC LIMIT 8`).all(req.org.id, ...sc.args);
  const st = await W.settings(req.org.id);
  const lines = [];
  for (const p of ps) {
    const h = Number((await db.prepare('SELECT COALESCE(SUM(hours), 0) h FROM time_entries WHERE project_id = ?').get(p.id)).h);
    const c = Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM project_costs WHERE project_id = ?').get(p.id)).s);
    lines.push(`- ${oneLine(p.name, 60)} : ${h} h passées${A.can(req, 'manager') && Number(p.budget) ? `, coût ${money(c + Math.round(h * st.project_hourly_cost), req.org.currency)} / budget ${money(p.budget, req.org.currency)}` : ''}`);
  }
  const load = A.can(req, 'manager') ? await db.prepare("SELECT u.name, COUNT(*) n FROM tasks t JOIN users u ON u.id = t.assignee_id WHERE t.org_id = ? AND t.status != 'done' GROUP BY u.name ORDER BY n DESC LIMIT 8").all(req.org.id) : [];
  return `\nTEMPS ET COÛT DES PROJETS :\n${lines.join('\n') || '(aucun projet actif)'}` + (load.length ? `\nCharge (tâches ouvertes par personne) : ${load.map((l) => `${oneLine(l.name, 30)} ${l.n}`).join(', ')}.` : '');
});

const legal = safe(async (req) => {
  if (!A.can(req, 'manager')) return '';
  const L = require('./legal-w3');
  const due = await L.alertItems(req);
  const partners = await db.prepare("SELECT holder, SUM(shares) s FROM legal_registers WHERE org_id = ? AND kind = 'associe' GROUP BY holder").all(req.org.id);
  return `\nCONFORMITÉ (calendrier de travail, dates à vérifier auprès d'un juriste) : ${due.map((d) => `${oneLine(d.title, 70)} avant ${d.due}${d.verify ? ' (à vérifier)' : ''}`).join(' ; ') || 'aucune échéance proche'}.` +
    `\nREGISTRES : associés ${partners.map((p) => `${oneLine(p.holder || '—', 40)} ${p.s} parts`).join(', ') || 'non renseignés'}.`;
});

const marketing = safe(async (req) => {
  if (!A.can(req, 'manager')) return '';
  const c = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(marketing_consent), 0) k FROM customers WHERE org_id = ?').get(req.org.id);
  const b = await db.prepare('SELECT name, channel, sent FROM broadcasts WHERE org_id = ? ORDER BY id DESC LIMIT 3').all(req.org.id);
  const p = await db.prepare('SELECT code, kind, value, used FROM promo_codes WHERE org_id = ? AND active = 1 LIMIT 5').all(req.org.id);
  return `\nENVOIS GROUPÉS : ${c.k}/${c.n} clients ont donné leur consentement (aucun envoi sans consentement). Derniers envois : ${b.map((x) => `${oneLine(x.name, 40)} (${x.channel}, ${x.sent})`).join(' ; ') || 'aucun'}.` +
    `\nCODES PROMO actifs : ${p.map((x) => `${x.code} -${x.value}${x.kind === 'percent' ? ' %' : ''} (${x.used} utilisation(s))`).join(' ; ') || 'aucun'}.`;
});

const structure = safe(async (req) => {
  const v = await db.prepare('SELECT title FROM positions WHERE org_id = ? AND holder_id IS NULL LIMIT 10').all(req.org.id);
  return `\nPOSTES VACANTS : ${v.map((x) => oneLine(x.title, 50)).join(', ') || 'aucun'}.`;
});
const processes = safe(async (req) => {
  const r = await db.prepare('SELECT title, next_review FROM processes WHERE org_id = ? AND next_review IS NOT NULL AND next_review <= ? LIMIT 10').all(req.org.id, W.today());
  return `\nPROCÉDURES À RÉVISER : ${r.map((x) => `${oneLine(x.title, 60)} (depuis ${x.next_review})`).join(', ') || 'aucune'}.`;
});


// Vague 4 : négociation des prix et relances. L'IA voit les règles et l'état, JAMAIS les prix planchers ni les remises maximales (le serveur décide des prix).
const sales = safe(async (req) => {
  if (!A.can(req, 'manager')) return '';
  const N = require('./negotiation'); const F = require('./followups');
  const s = await N.settingsOf(req.org.id);
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const c = async (k) => Number((await db.prepare('SELECT COUNT(*) c FROM neg_log WHERE org_id = ? AND kind = ? AND created_at >= ?').get(req.org.id, k, since)).c);
  const wait = Number((await db.prepare("SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'order' AND approval = 'needed'").get(req.org.id)).c);
  const q = await F.queueSummary(req);
  return `\nNÉGOCIATION DE L'ASSISTANT : ${s.enabled ? 'activée' : 'désactivée'} (${s.maxCounters} contre-offre(s) au plus par article, validation d'un responsable au-delà de ${s.approvalPct} % de remise). Sur 30 jours : ${await c('offer')} offre(s) de clients, ${await c('accept')} prix accepté(s), ${await c('refused')} refus du serveur. Commandes remisées en attente de validation : ${wait}. Les prix planchers et les remises maximales ne te sont pas communiqués : ne les devine pas et ne promets aucune remise.` +
    `\nCENTRE DE RELANCES : mode ${q.mode === 'auto' ? 'automatique' : 'proposer, une personne valide'}, canal par défaut ${q.channel}. À envoyer : ${q.toSend}, reportées : ${q.postponed}, envoyées sur 7 jours : ${q.sent7}. Tu peux rédiger un brouillon de relance ; la personne le relit et l'envoie depuis l'onglet Relances (jamais d'envoi sans validation hors mode automatique).`;
});
const crm = safe(async (req) => {
  if (!A.can(req, 'manager')) return '';
  const n = await db.prepare('SELECT COUNT(*) c FROM customer_prices WHERE org_id = ?').get(req.org.id);
  const d = await db.prepare('SELECT COUNT(*) c FROM customers WHERE org_id = ? AND default_discount > 0').get(req.org.id);
  const o = await db.prepare('SELECT COUNT(*) c FROM customers WHERE org_id = ? AND followup_optout = 1').get(req.org.id);
  const f = await require('./followups').queueSummary(req);
  return `\nPRIX ET RELANCES CLIENTS : ${n.c} prix négocié(s) par client, ${d.c} client(s) avec une remise de fidélité, ${o.c} client(s) opposé(s) aux relances (ne jamais les relancer). Relances à envoyer : ${f.toSend} (factures échues : cadence J+3, J+10, J+20 par défaut). Un devis ou une facture ne peut pas descendre sous le prix plancher d'un article, sauf décision motivée d'un administrateur.`;
});

module.exports = { support, hr, projects, legal, marketing, structure, processes, sales, crm };
