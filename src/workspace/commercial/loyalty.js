'use strict';
// Fidélisation et rétention : programme de points et de paliers, risque de départ (churn), taux de rétention et de réachat, valeur vie client (CLV),
// campagnes de réactivation (cadences WhatsApp validées par un humain), satisfaction (NPS) et réclamations.
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const W = require('../w3');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const Dt = require('./data');
const { HttpError } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;

// ---------- Programme de points ----------
router.get('/loyalty/program', P.need('view'), async (req, res) => { const s = await B.settings(req.org.id); res.json({ pointsPer1000: s.loyaltyPointsPer1000, tiers: s.loyaltyTiers }); });
router.put('/loyalty/program', P.need('pricing'), async (req, res) => {
  const b = req.body || {};
  const t = b.tiers || {};
  if (b.pointsPer1000 !== undefined && !(Number(b.pointsPer1000) >= 0 && Number(b.pointsPer1000) <= 1000)) throw new HttpError(400, 'Les points pour 1 000 dépensés vont de 0 à 1 000.');
  const cur = (await B.settings(req.org.id)).loyaltyTiers; const next = { ...cur, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Number(v)])) };
  if (!(next.silver < next.gold && next.gold < next.platinum)) throw new HttpError(400, 'Les paliers doivent être croissants : argent < or < platine.');
  const s = await B.saveSettings(req.org.id, { loyaltyPointsPer1000: b.pointsPer1000, loyaltyTiers: next });
  await P.audit(req, 'loyalty_program', null, 'update', b);
  res.json({ pointsPer1000: s.loyaltyPointsPer1000, tiers: s.loyaltyTiers });
});
/** Points gagnés = ⌊montant payé net / 1 000 × points par 1 000⌋ par facture soldée, une seule fois par facture. */
router.post('/loyalty/sync', P.need('write'), async (req, res) => {
  const s = await B.settings(req.org.id);
  const rows = await db.prepare("SELECT d.id, d.customer_id, d.total, d.credited, d.number FROM documents d WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'paid' AND NOT EXISTS (SELECT 1 FROM cp_loyalty_ledger l WHERE l.org_id = d.org_id AND l.doc_id = d.id AND l.kind = 'earn')").all(req.org.id);
  let n = 0; let pts = 0;
  for (const d of rows) {
    const p = Math.floor(((N(d.total) - N(d.credited)) / 1000) * Number(s.loyaltyPointsPer1000));
    if (p <= 0) continue;
    try { await db.prepare("INSERT INTO cp_loyalty_ledger (org_id, customer_id, points, kind, doc_id, note, user_id, created_at) VALUES (?, ?, ?, 'earn', ?, ?, ?, ?)").run(req.org.id, d.customer_id, p, d.id, `Facture ${d.number}`, req.user.id, nowISO()); n++; pts += p; } catch { /* déjà créditée en parallèle */ }
  }
  res.json({ invoices: n, points: pts });
});
async function balances(req) {
  const s = await B.settings(req.org.id);
  const rows = await db.prepare('SELECT customer_id, SUM(points) bal, SUM(CASE WHEN points > 0 AND kind = \'earn\' THEN points ELSE 0 END) earned FROM cp_loyalty_ledger WHERE org_id = ? GROUP BY customer_id').all(req.org.id);
  const names = new Map((await db.prepare('SELECT id, name FROM customers WHERE org_id = ?').all(req.org.id)).map((c) => [Number(c.id), c.name]));
  return rows.map((r) => ({ customerId: Number(r.customer_id), name: names.get(Number(r.customer_id)) || '', balance: N(r.bal), earned: N(r.earned), tier: L.loyaltyTier(N(r.earned), s.loyaltyTiers) })).sort((a, b) => b.earned - a.earned);
}
router.get('/loyalty/customers', P.need('view'), async (req, res) => {
  const list = await balances(req);
  const byTier = {}; for (const c of list) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
  res.json({ customers: list, byTier, totalBalance: list.reduce((a, c) => a + c.balance, 0) });
});
router.get('/loyalty/customers/:id', P.need('view'), async (req, res) => {
  const c = await require('./crm360').accountOf(req, req.params.id);
  const led = await db.prepare('SELECT * FROM cp_loyalty_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(c.id);
  const s = await B.settings(req.org.id);
  const earned = led.filter((l) => l.kind === 'earn').reduce((a, l) => a + N(l.points), 0);
  res.json({ customerId: Number(c.id), balance: led.reduce((a, l) => a + N(l.points), 0), earned, tier: L.loyaltyTier(earned, s.loyaltyTiers), ledger: led.map((l) => ({ id: Number(l.id), points: N(l.points), kind: l.kind, note: l.note, at: l.created_at })) });
});
router.post('/loyalty/redeem', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const c = await require('./crm360').accountOf(req, b.customerId);
  const pts = Math.round(Number(b.points));
  if (!(pts > 0 && pts <= 1e7)) throw new HttpError(400, 'Indiquez un nombre de points positif.');
  const bal = N((await db.prepare('SELECT COALESCE(SUM(points), 0) b FROM cp_loyalty_ledger WHERE customer_id = ?').get(c.id)).b);
  if (pts > bal) throw new HttpError(409, `Solde insuffisant : ${bal} point(s) disponibles.`);
  await db.prepare("INSERT INTO cp_loyalty_ledger (org_id, customer_id, points, kind, note, user_id, created_at) VALUES (?, ?, ?, 'redeem', ?, ?, ?)").run(req.org.id, c.id, -pts, A.text(b.note, 200) || 'Utilisation de points', req.user.id, nowISO());
  await P.audit(req, 'loyalty', c.id, 'redeem', { points: pts });
  res.json({ balance: bal - pts });
});
router.post('/loyalty/adjust', P.need('approve'), async (req, res) => {
  const b = req.body || {};
  const c = await require('./crm360').accountOf(req, b.customerId);
  const pts = Math.round(Number(b.points));
  if (!pts || Math.abs(pts) > 1e6) throw new HttpError(400, 'Indiquez un nombre de points (positif ou négatif).');
  const note = A.text(b.note, 200, { required: true, msg: 'Indiquez le motif de l’ajustement.' });
  await db.prepare("INSERT INTO cp_loyalty_ledger (org_id, customer_id, points, kind, note, user_id, created_at) VALUES (?, ?, ?, 'adjust', ?, ?, ?)").run(req.org.id, c.id, pts, note, req.user.id, nowISO());
  await P.audit(req, 'loyalty', c.id, 'adjust', { points: pts, note });
  res.json({ ok: true });
});

// ---------- Rétention, risque de départ, valeur vie client ----------
async function customerStats(req) {
  const s = await B.settings(req.org.id);
  const inv = await Dt.invoices(req.org.id, {});
  const today = B.today();
  const ow = await P.own(req, 'owner_id');
  const custs = await db.prepare(`SELECT * FROM customers WHERE org_id = ?${ow.sql}`).all(req.org.id, ...ow.args);
  const nps = await db.prepare('SELECT customer_id, score FROM cp_nps WHERE org_id = ? ORDER BY id').all(req.org.id);
  const lastNps = new Map(nps.map((n) => [Number(n.customer_id), N(n.score)]));
  const open = await db.prepare("SELECT customer_id, COUNT(*) n FROM cp_complaints WHERE org_id = ? AND status <> 'resolved' GROUP BY customer_id").all(req.org.id);
  const openMap = new Map(open.map((o) => [Number(o.customer_id), N(o.n)]));
  const by = new Map(); for (const d of inv) { if (!by.has(d.customerId)) by.set(d.customerId, []); by.get(d.customerId).push(d); }
  const out = [];
  for (const c of custs) {
    const ds = by.get(Number(c.id)) || [];
    if (!ds.length) continue;
    const dates = ds.map((d) => d.issued).sort();
    const revenue = ds.reduce((a, d) => a + d.net, 0);
    const last = dates[dates.length - 1]; const first = dates[0];
    const interval = L.purchaseInterval(dates, Number(s.defaultIntervalDays));
    const since90 = L.addDays(today, -90); const since180 = L.addDays(today, -180);
    const recent = ds.filter((d) => d.issued >= since90).reduce((a, d) => a + d.net, 0); const previous = ds.filter((d) => d.issued >= since180 && d.issued < since90).reduce((a, d) => a + d.net, 0);
    const ch = L.churnScore({ daysSinceLast: L.daysBetween(last, today), intervalDays: interval, openComplaints: openMap.get(Number(c.id)) || 0, lastNps: lastNps.has(Number(c.id)) ? lastNps.get(Number(c.id)) : null, recent, previous });
    const avgBasket = Math.round(revenue / ds.length);
    out.push({ id: Number(c.id), name: c.name, phone: c.phone, ownerId: c.owner_id ? Number(c.owner_id) : null, optout: Boolean(Number(c.followup_optout)), orders: ds.length, revenue, avgBasket, firstPurchase: first, lastPurchase: last, daysSinceLast: L.daysBetween(last, today), intervalDays: Math.round(interval), churn: ch.score, churnLevel: L.churnLevel(ch.score, Number(s.churnHigh), Number(s.churnMedium)), churnParts: ch.parts, clv: L.clv({ avgBasket, purchases: ds.length, tenureDays: Math.max(1, L.daysBetween(first, today)), years: Number(s.clvYears) }), history: ds.map((d) => d.issued) });
  }
  return out;
}
router.get('/retention/overview', P.need('view'), async (req, res) => {
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);
  const stats = await customerStats(req);
  const today = B.today();
  const curFrom = L.addDays(today, -Math.round(months * 30.4)); const prevFrom = L.addDays(curFrom, -Math.round(months * 30.4));
  const inPrev = stats.filter((c) => c.history.some((d) => d >= prevFrom && d < curFrom));
  const kept = inPrev.filter((c) => c.history.some((d) => d >= curFrom));
  const repeat = stats.filter((c) => c.orders >= 2);
  const lvl = { high: 0, medium: 0, low: 0 }; for (const c of stats) lvl[c.churnLevel]++;
  const nps = await db.prepare('SELECT score, created_at FROM cp_nps WHERE org_id = ?').all(req.org.id);
  const comp = await db.prepare('SELECT status, opened_at, resolved_at FROM cp_complaints WHERE org_id = ?').all(req.org.id);
  const resolved = comp.filter((c) => c.resolved_at);
  const atRisk = stats.filter((c) => c.churnLevel !== 'low');
  res.json({
    months, customers: stats.length, retentionRate: inPrev.length ? L.round((kept.length * 100) / inPrev.length, 1) : null, retained: kept.length, basePrevious: inPrev.length,
    repurchaseRate: stats.length ? L.round((repeat.length * 100) / stats.length, 1) : null, repeatCustomers: repeat.length,
    churnLevels: lvl, atRiskRevenue: atRisk.reduce((a, c) => a + c.revenue, 0), avgClv: stats.length ? Math.round(stats.reduce((a, c) => a + c.clv, 0) / stats.length) : 0, totalClv: stats.reduce((a, c) => a + c.clv, 0),
    topClv: [...stats].sort((a, b) => b.clv - a.clv).slice(0, 10).map((c) => ({ id: c.id, name: c.name, clv: c.clv, orders: c.orders, avgBasket: c.avgBasket })),
    nps: L.nps(nps.map((n) => N(n.score))), complaints: { open: comp.filter((c) => c.status !== 'resolved').length, resolved: resolved.length, avgResolutionDays: resolved.length ? L.round(resolved.reduce((a, c) => a + (Date.parse(c.resolved_at) - Date.parse(c.opened_at)) / 86400000, 0) / resolved.length, 1) : 0 },
  });
});
router.get('/retention/at-risk', P.need('view'), async (req, res) => {
  const names = await B.names(req.org.id);
  const list = (await customerStats(req)).filter((c) => c.churnLevel !== 'low' || req.query.all).sort((a, b) => b.churn - a.churn || b.revenue - a.revenue);
  res.json({ customers: list.slice(0, 200).map((c) => ({ ...c, history: undefined, owner: names.get(c.ownerId) || '' })), count: list.length });
});
router.post('/retention/reactivate', P.need('activity'), async (req, res) => {
  const b = req.body || {};
  const ids = (Array.isArray(b.customerIds) ? b.customerIds : []).map((x) => A.id(x));
  if (!ids.length || ids.length > 100) throw new HttpError(400, 'Choisissez de 1 à 100 clients à réactiver.');
  let cad = b.cadenceId ? await db.prepare("SELECT * FROM cp_cadences WHERE id = ? AND org_id = ? AND target = 'customer'").get(A.id(b.cadenceId), req.org.id) : await db.prepare("SELECT * FROM cp_cadences WHERE org_id = ? AND target = 'customer' AND active = 1 ORDER BY id LIMIT 1").get(req.org.id);
  if (!cad) {
    const steps = [{ day: 0, channel: 'whatsapp', text: 'Bonjour {prenom}, cela fait un moment ! Que pouvons-nous faire pour vous chez {organisation} ?' }, { day: 5, channel: 'task', text: 'Appeler {prenom} : client à réactiver' }, { day: 12, channel: 'whatsapp', text: 'Bonjour {prenom}, nous avons une offre pour vous. Souhaitez-vous la recevoir ?' }];
    const id = (await db.prepare("INSERT INTO cp_cadences (org_id, name, target, steps, created_by, created_at) VALUES (?, 'Réactivation de clients', 'customer', ?, ?, ?)").run(req.org.id, JSON.stringify(steps), req.user.id, nowISO())).lastInsertRowid;
    cad = await db.prepare('SELECT * FROM cp_cadences WHERE id = ?').get(id);
  }
  const started = []; const skipped = [];
  for (const id of ids) {
    const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(id, req.org.id);
    if (!c || !A.visible(req, c)) throw new HttpError(404, 'Client introuvable.');
    if (Number(c.followup_optout)) { skipped.push({ id, why: 'optout' }); continue; }
    if (await db.prepare("SELECT 1 FROM cp_cadence_runs WHERE cadence_id = ? AND customer_id = ? AND state IN ('active','sending')").get(cad.id, id)) { skipped.push({ id, why: 'running' }); continue; }
    const rid = (await db.prepare('INSERT INTO cp_cadence_runs (org_id, cadence_id, customer_id, step_idx, next_at, started_by, started_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)').run(req.org.id, cad.id, id, nowISO(), req.user.id, nowISO(), nowISO())).lastInsertRowid;
    started.push(Number(rid));
  }
  await P.audit(req, 'reactivation', cad.id, 'start', { started: started.length, skipped: skipped.length });
  res.status(201).json({ started, skipped, cadenceId: Number(cad.id) });
});

// ---------- Satisfaction (NPS) ----------
router.post('/nps', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const c = await require('./crm360').accountOf(req, b.customerId);
  const score = Math.round(Number(b.score));
  if (!(score >= 0 && score <= 10)) throw new HttpError(400, 'La note NPS va de 0 à 10.');
  const id = (await db.prepare('INSERT INTO cp_nps (org_id, customer_id, score, comment, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, c.id, score, A.text(b.comment, 500), req.user.id, nowISO())).lastInsertRowid;
  if (score <= 6) await W.pushRole(req.org.id, 'manager', 'commercial', `Client détracteur (${score}/10) : ${c.name}`, 'customer:' + c.id);
  res.status(201).json({ id: Number(id) });
});
router.get('/nps', P.need('view'), async (req, res) => {
  const rows = await db.prepare('SELECT n.*, c.name FROM cp_nps n JOIN customers c ON c.id = n.customer_id WHERE n.org_id = ? ORDER BY n.id DESC LIMIT 200').all(req.org.id);
  const byMonth = {}; for (const r of rows) { const m = r.created_at.slice(0, 7); (byMonth[m] = byMonth[m] || []).push(N(r.score)); }
  res.json({ ...L.nps(rows.map((r) => N(r.score))), trend: Object.entries(byMonth).sort().map(([month, s]) => ({ month, nps: L.nps(s).nps, responses: s.length })), responses: rows.slice(0, 50).map((r) => ({ id: Number(r.id), customerId: Number(r.customer_id), customer: r.name, score: N(r.score), comment: r.comment, at: r.created_at })) });
});

// ---------- Réclamations ----------
const compView = (c, names) => ({ id: Number(c.id), customerId: Number(c.customer_id), customer: c.customer, subject: c.subject, severity: c.severity, status: c.status, ownerId: c.owner_id ? Number(c.owner_id) : null, owner: names.get(Number(c.owner_id)) || '', resolution: c.resolution, openedAt: c.opened_at, resolvedAt: c.resolved_at });
router.get('/complaints', P.need('view'), async (req, res) => {
  const names = await B.names(req.org.id);
  const rows = await db.prepare(`SELECT k.*, c.name AS customer FROM cp_complaints k JOIN customers c ON c.id = k.customer_id WHERE k.org_id = ?${req.query.status ? ' AND k.status = ?' : ''} ORDER BY k.id DESC LIMIT 200`).all(req.org.id, ...(req.query.status ? [req.query.status] : []));
  res.json({ complaints: rows.map((c) => compView(c, names)) });
});
router.post('/complaints', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const c = await require('./crm360').accountOf(req, b.customerId);
  const owner = b.ownerId ? await A.memberOf(req, b.ownerId) : c.owner_id || req.user.id;
  const id = (await db.prepare('INSERT INTO cp_complaints (org_id, customer_id, subject, severity, owner_id, opened_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, c.id, A.text(b.subject, 200, { required: true, msg: 'Décrivez la réclamation.' }), A.oneOf(b.severity, ['low', 'normal', 'high'], 'normal', 'Gravité inconnue.'), owner, nowISO())).lastInsertRowid;
  if (owner && Number(owner) !== req.user.id) await W.push(req.org.id, Number(owner), 'commercial', `Réclamation à traiter : ${c.name}`, 'complaint:' + id);
  res.status(201).json({ id: Number(id) });
});
router.put('/complaints/:id', P.need('write'), async (req, res) => {
  const k = await db.prepare('SELECT * FROM cp_complaints WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!k) throw new HttpError(404, 'Réclamation introuvable.');
  const b = req.body || {};
  const status = b.status === undefined ? k.status : A.oneOf(b.status, ['open', 'in_progress', 'resolved'], undefined, 'Statut inconnu.');
  if (status === 'resolved' && !A.text(b.resolution, 500) && !k.resolution) throw new HttpError(400, 'Indiquez la solution apportée.');
  await db.prepare('UPDATE cp_complaints SET status = ?, resolution = ?, resolved_at = ?, severity = ? WHERE id = ?').run(status, b.resolution === undefined ? k.resolution : A.text(b.resolution, 500), status === 'resolved' ? (k.resolved_at || nowISO()) : null, b.severity === undefined ? k.severity : A.oneOf(b.severity, ['low', 'normal', 'high'], undefined, 'Gravité inconnue.'), k.id);
  res.json({ ok: true });
});

module.exports = { router, customerStats };
