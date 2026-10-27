'use strict';
// Analyses de l'organisation : alertes, score de santé, séries du budget. Règles claires et vérifiables (pas d'IA ici) :
// l'IA s'en sert ensuite pour expliquer et conseiller.
const { db, nowISO } = require('../db');
const A = require('./access');

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const LEVEL_RANK = { high: 0, medium: 1, info: 2 };

async function alerts(req) {
  const o = req.org.id;
  const sc = A.scope(req);
  const today = nowISO().slice(0, 10);
  const out = [];
  const add = (level, module, title, text, at) => out.push({ level, module, title, text, at: at || null });
  const count = async (sql, ...args) => (await db.prepare(sql).get(o, ...args, ...sc.args)).c;

  // Service client
  const urgent = await count(`SELECT COUNT(*) c FROM tickets WHERE org_id = ? AND status != 'resolved' AND priority = 'high'${sc.sql}`);
  const lastUrgent = (await db.prepare(`SELECT MAX(updated_at) m FROM tickets WHERE org_id = ? AND status != 'resolved' AND priority = 'high'${sc.sql}`).get(o, ...sc.args)).m;
  if (urgent) add('high', 'support', 'Service client', `${plural(urgent, 'demande urgente en attente', 'demandes urgentes en attente')}`, lastUrgent);
  const stale = await count(`SELECT COUNT(*) c FROM tickets WHERE org_id = ? AND status = 'open' AND updated_at < ?${sc.sql}`, new Date(Date.now() - 48 * 3600000).toISOString());
  if (stale) add('medium', 'support', 'Service client', `${plural(stale, 'demande sans réponse', 'demandes sans réponse')} depuis plus de 48 h`);

  // Tâches et projets
  const overdue = await count(`SELECT COUNT(*) c FROM tasks WHERE org_id = ? AND status != 'done' AND due IS NOT NULL AND due < ?${sc.sql}`, today);
  const oldest = (await db.prepare(`SELECT MIN(due) m FROM tasks WHERE org_id = ? AND status != 'done' AND due IS NOT NULL AND due < ?${sc.sql}`).get(o, today, ...sc.args)).m;
  if (overdue) add(overdue >= 5 ? 'high' : 'medium', 'projects', 'Tâches', `${plural(overdue, 'tâche en retard', 'tâches en retard')}`, oldest ? oldest + 'T00:00:00.000Z' : null);
  const lateProjects = await db.prepare(`SELECT name, due FROM projects WHERE org_id = ? AND status = 'active' AND due IS NOT NULL AND due < ?${sc.sql} LIMIT 3`).all(o, today, ...sc.args);
  for (const p of lateProjects) add('high', 'projects', `Projet « ${p.name} »`, "L'échéance du projet est dépassée", p.due + 'T00:00:00.000Z');

  // Conversations attribuées à la personne (commercial) : à traiter
  const mineC = await db.prepare("SELECT COUNT(*) c, MIN(assigned_at) m FROM chats WHERE org_id = ? AND assignee_id = ? AND status = 'handoff'").get(o, req.user.id);
  if (mineC.c) add('medium', 'sales', 'Assistant commercial', `${plural(mineC.c, 'conversation client vous est attribuée', 'conversations clients vous sont attribuées')}`, mineC.m);

  // Stock : ruptures et niveaux bas (toute l'équipe voit son stock)
  const stock = await require('./stock').items(req);
  const out0 = stock.filter((i) => i.quantity <= 0);
  const low = stock.filter((i) => i.quantity > 0 && i.min_quantity > 0 && i.quantity <= i.min_quantity);
  if (out0.length) add('high', 'stock', 'Stock', `${plural(out0.length, 'article en rupture', 'articles en rupture')} : ${out0.slice(0, 3).map((i) => i.name).join(', ')}`);
  if (low.length) add('medium', 'stock', 'Stock', `${plural(low.length, 'article sous son seuil', 'articles sous leur seuil')} : ${low.slice(0, 3).map((i) => i.name).join(', ')}`);
  const over = stock.filter((i) => i.max_quantity > 0 && i.quantity > i.max_quantity);
  if (over.length) add('info', 'stock', 'Stock', `${plural(over.length, 'article en surstock', 'articles en surstock')} : ${over.slice(0, 3).map((i) => i.name).join(', ')}`);
  const lots = await require('./stock').expiringLots(req, 30);
  const lotsOut = lots.filter((l) => l.expired); const lotsSoon = lots.filter((l) => !l.expired);
  if (lotsOut.length) add('high', 'stock', 'Stock', `${plural(lotsOut.length, 'lot périmé', 'lots périmés')} encore en stock : ${lotsOut.slice(0, 3).map((l) => `${l.item} (${l.lotNo})`).join(', ')}`, lotsOut[0].expiry + 'T00:00:00.000Z');
  if (lotsSoon.length) add('medium', 'stock', 'Stock', `${plural(lotsSoon.length, 'lot périme', 'lots périment')} dans moins de 30 jours : ${lotsSoon.slice(0, 3).map((l) => `${l.item} (${l.lotNo})`).join(', ')}`, lotsSoon[0].expiry + 'T00:00:00.000Z');
  // Parc : assurance, visite technique, permis (échéances périmées ou à moins de 30 jours)
  for (const c of await require('./logistics-fleet').alertItems(req)) {
    const what = { insurance: 'assurance', inspection: 'visite technique', tax: 'vignette / taxe', license: 'permis', medical: 'visite médicale', other: 'échéance' }[c.kind] || c.kind;
    add(c.state === 'soon' ? 'medium' : 'high', 'logistics', 'Parc', c.state === 'expired' ? `${what} de ${c.who} périmée depuis le ${c.expiresAt}` : `${what} de ${c.who} à renouveler avant le ${c.expiresAt}`, c.expiresAt + 'T00:00:00.000Z');
  }
  if (A.can(req, 'manager')) {
    const lateOrd = (await db.prepare("SELECT o.*, i.name AS item FROM purchase_orders o JOIN stock_items i ON i.id = o.item_id WHERE o.org_id = ? AND o.status IN ('ordered','partial') AND o.promised_date IS NOT NULL AND o.promised_date < ?").all(o, today));
    if (lateOrd.length) add('medium', 'stock', 'Achats', `${plural(lateOrd.length, 'commande fournisseur en retard', 'commandes fournisseurs en retard')} sur la date promise : ${lateOrd.slice(0, 3).map((x) => x.item).join(', ')}`, lateOrd[0].promised_date + 'T00:00:00.000Z');
    const waiting = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM purchase_orders WHERE org_id = ? AND status = 'pending'").get(o);
    if (waiting.c) add('info', 'stock', 'Achats', `${plural(waiting.c, 'commande attend', 'commandes attendent')} votre validation`, waiting.m);
    // Ventes : factures impayées (responsables et plus)
    const late = await require('./crm').overdueList(req);
    if (late.length) {
      const sum = late.reduce((a, d) => a + d.total - d.credited - d.paid, 0);
      const oldest = late[0];
      const age = Math.round((Date.now() - Date.parse(oldest.due)) / 86400000);
      add(age > 30 ? 'high' : 'medium', 'crm', 'Clients et ventes', `${plural(late.length, 'facture impayée en retard', 'factures impayées en retard')} (${Number(sum).toLocaleString('fr-FR')} ${req.org.currency}), la plus ancienne depuis ${age} jours`, oldest.due + 'T00:00:00.000Z');
    }
    // Commandes de prospects et conversations en attente (assistant commercial public)
    const po = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM documents WHERE org_id = ? AND kind = 'order' AND status = 'pending'").get(o);
    if (po.c) add('medium', 'sales', 'Assistant commercial', `${plural(po.c, 'commande de client attend', 'commandes de clients attendent')} votre validation`, po.m);
    const hw = await db.prepare("SELECT COUNT(*) c, MIN(updated_at) m FROM chats WHERE org_id = ? AND status = 'handoff'").get(o);
    if (hw.c) add('medium', 'sales', 'Assistant commercial', `${plural(hw.c, 'conversation attend', 'conversations attendent')} un conseiller`, hw.m);
    const ap = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM appointments WHERE org_id = ? AND status = 'pending' AND date >= ?").get(o, new Date(Date.now() + 3600000).toISOString().slice(0, 10));
    if (ap.c) add('medium', 'sales', 'Assistant commercial', `${plural(ap.c, 'rendez-vous attend', 'rendez-vous attendent')} votre confirmation`, ap.m);
    // Ressources humaines
    const pl = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM leaves WHERE org_id = ? AND status = 'pending'").get(o);
    if (pl.c) add('info', 'hr', 'Ressources humaines', `${plural(pl.c, 'demande de congé attend', 'demandes de congé attendent')} une réponse`, pl.m);
  }

  // Juridique : rappels d'échéances à 30 et 7 jours, une alerte par élément (responsables et plus)
  if (A.can(req, 'manager')) for (const l of await require('./legal').alertItems(req)) add(l.level, 'legal', l.title, l.text, l.at);

  // Budget (responsables et plus)
  if (A.can(req, 'manager')) {
    const s = await require('./budget').summary(req);
    const cur = req.org.currency;
    const fmt = (n) => `${Number(n).toLocaleString('fr-FR')} ${cur}`;
    for (const c of s.categories) {
      // Seuil fixé par le fondateur : à partir de 20 % au-dessus de la limite c'est « à surveiller » ; en dessous, un simple conseil.
      if (c.limit && c.spent > c.limit) { const over = Math.round((c.spent / c.limit - 1) * 100); add(over >= 20 ? 'medium' : 'info', 'budget', `Budget · ${c.category}`, `${over} % au-dessus de la limite (${fmt(c.spent)} pour ${fmt(c.limit)})`); }
    }
    if (s.balance < 0) add('high', 'budget', 'Budget', `Les sorties dépassent les entrées ce mois-ci (solde ${fmt(s.balance)})`);
    const pend = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM decisions WHERE org_id = ? AND status = 'pending'").get(o);
    if (pend.c) add('info', 'dashboard', 'Décisions', `${plural(pend.c, 'décision attend', 'décisions attendent')} votre validation`, pend.m);
  }

  // Mise en place de l'organisation (conseils)
  if (A.can(req, 'admin')) {
    if (!await db.prepare('SELECT 1 FROM positions WHERE org_id = ? LIMIT 1').get(o)) add('info', 'structure', 'Organisation', "Aucun poste n'est défini : demandez une proposition à l'IA");
    if (!await db.prepare('SELECT 1 FROM processes WHERE org_id = ? LIMIT 1').get(o)) add('info', 'processes', 'Fonctionnement', "Aucune procédure écrite : l'IA peut vous aider à en rédiger");
  }
  return out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

/** Score de santé de 25 à 100 : simple et explicable (chaque alerte importante retire des points). */
function health(list) {
  const high = list.filter((a) => a.level === 'high').length;
  const medium = list.filter((a) => a.level === 'medium').length;
  const score = Math.max(25, 100 - high * 14 - medium * 6);
  const label = score >= 80 ? 'Bonne santé' : score >= 60 ? 'À surveiller' : 'Attention requise';
  const mods = [...new Set(list.filter((a) => a.level !== 'info').map((a) => a.title.split(' · ')[0]))].slice(0, 3);
  const summary = mods.length ? `À surveiller : ${mods.join(', ').toLowerCase()}.` : 'Aucune alerte importante : continuez ainsi.';
  return { score, label, summary, high, medium };
}

/** Entrées et sorties des 6 derniers mois (responsables et plus). */
async function series(req) {
  const sc = A.scope(req);
  const d = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    months.push(m.toISOString().slice(0, 7));
  }
  const rows = await db.prepare(`SELECT substr(date, 1, 7) m, kind, SUM(amount) t FROM budget_entries WHERE org_id = ? AND date >= ?${sc.sql} GROUP BY m, kind`).all(req.org.id, months[0] + '-01', ...sc.args);
  return months.map((m) => ({
    month: m,
    income: (rows.find((r) => r.m === m && r.kind === 'income') || {}).t || 0,
    expense: (rows.find((r) => r.m === m && r.kind === 'expense') || {}).t || 0,
  }));
}

module.exports = { alerts, health, series };
