'use strict';
// Segmentation de la clientèle : RFM (récence, fréquence, montant), ABC (Pareto), secteur, ville, potentiel, et segments personnalisés par règles.
// Base de calcul : les factures émises (envoyées ou payées), nettes des avoirs, sur une fenêtre glissante (réglage « rfmWindowMonths », 24 mois par défaut).
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const { HttpError } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;

// Actions suggérées par segment (codes ; l'écran les traduit).
const ACTIONS = {
  champions: ['reward', 'ask_referral', 'upsell'],
  loyal: ['loyalty_offer', 'upsell', 'ask_review'],
  promising: ['nurture', 'second_offer'],
  new: ['welcome', 'follow_first_order'],
  need_attention: ['reminder_offer', 'check_satisfaction'],
  at_risk: ['call_now', 'win_back_offer', 'check_satisfaction'],
  hibernating: ['reactivation_campaign', 'special_offer'],
  lost: ['last_chance', 'ask_why_left'],
};

/** Mesures de chaque compte de l'organisation (une ligne par client), avec RFM et ABC. */
async function metrics(req, { windowMonths } = {}) {
  const set = await B.settings(req.org.id);
  const months = windowMonths || set.rfmWindowMonths;
  const since = `${L.addMonths(B.today().slice(0, 7), -months)}-${B.today().slice(8, 10)}`;
  const sc = A.scope(req, 'c.branch_id'); const ow = await P.own(req, 'c.owner_id');
  const custs = await db.prepare(`SELECT c.* FROM customers c WHERE c.org_id = ?${sc.sql}${ow.sql}`).all(req.org.id, ...sc.args, ...ow.args);
  const inv = await db.prepare(`SELECT customer_id, issued, total, credited FROM documents WHERE org_id = ? AND kind = 'invoice' AND status IN ('sent','paid') AND issued >= ?`).all(req.org.id, since);
  const by = new Map();
  for (const d of inv) { const k = Number(d.customer_id); if (!by.has(k)) by.set(k, []); by.get(k).push(d); }
  const today = B.today();
  const rows = custs.map((c) => {
    const ds = by.get(Number(c.id)) || [];
    const revenue = ds.reduce((a, d) => a + N(d.total) - N(d.credited), 0);
    const last = ds.reduce((m, d) => (d.issued > m ? d.issued : m), '');
    const first = ds.reduce((m, d) => (!m || d.issued < m ? d.issued : m), '');
    return { id: Number(c.id), name: c.name, kind: c.account_kind, city: c.city || '', sector: c.sector || '', potential: c.potential || '', stage: c.stage, ownerId: c.owner_id ? Number(c.owner_id) : null, orders: ds.length, revenue, avgBasket: ds.length ? Math.round(revenue / ds.length) : 0, lastPurchase: last || null, firstPurchase: first || null, recencyDays: last ? L.daysBetween(last, today) : null };
  });
  const buyers = rows.filter((r) => r.orders > 0 && r.revenue > 0);
  const scored = L.rfm(buyers.map((r) => ({ id: r.id, recencyDays: r.recencyDays, frequency: r.orders, monetary: r.revenue })));
  const abcs = new Map(L.abc(buyers.map((r) => ({ id: r.id, monetary: r.revenue }))).map((r) => [r.id, r]));
  const sm = new Map(scored.map((r) => [r.id, r]));
  const out = rows.map((r) => {
    const s = sm.get(r.id); const a = abcs.get(r.id);
    return { ...r, r: s ? s.r : null, f: s ? s.f : null, m: s ? s.m : null, rfm: s ? s.rfm : null, segment: s ? s.segment : null, abc: a ? a.abc : null, share: a ? a.share : 0, cumShare: a ? a.cumShare : 0 };
  });
  return { rows: out, months, since };
}

const group = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r) || ''; const v = m.get(k) || { key: k, count: 0, revenue: 0 }; v.count++; v.revenue += r.revenue; m.set(k, v); }
  const total = [...m.values()].reduce((a, v) => a + v.revenue, 0);
  return [...m.values()].map((v) => ({ ...v, share: total ? L.round((v.revenue * 100) / total, 1) : 0 })).sort((a, b) => b.revenue - a.revenue || b.count - a.count);
};

router.get('/segments/overview', P.need('view'), async (req, res) => {
  const { rows, months } = await metrics(req);
  const buyers = rows.filter((r) => r.segment);
  const total = buyers.reduce((a, r) => a + r.revenue, 0);
  const segs = L.RFM_SEGMENTS.map((key) => {
    const x = buyers.filter((r) => r.segment === key);
    const rev = x.reduce((a, r) => a + r.revenue, 0);
    return { key, count: x.length, revenue: rev, share: total ? L.round((rev * 100) / total, 1) : 0, avgRecencyDays: x.length ? L.round(x.reduce((a, r) => a + r.recencyDays, 0) / x.length, 1) : 0, avgOrders: x.length ? L.round(x.reduce((a, r) => a + r.orders, 0) / x.length, 1) : 0, avgBasket: x.length ? Math.round(rev / Math.max(1, x.reduce((a, r) => a + r.orders, 0))) : 0, actions: ACTIONS[key] };
  });
  const matrix = [5, 4, 3, 2, 1].map((f) => [1, 2, 3, 4, 5].map((r) => { const x = buyers.filter((b) => b.r === r && b.f === f); return { r, f, count: x.length, revenue: x.reduce((a, b) => a + b.revenue, 0) }; }));
  const abc = ['A', 'B', 'C'].map((k) => { const x = buyers.filter((r) => r.abc === k); const rev = x.reduce((a, r) => a + r.revenue, 0); return { class: k, count: x.length, revenue: rev, share: total ? L.round((rev * 100) / total, 1) : 0, customersShare: buyers.length ? L.round((x.length * 100) / buyers.length, 1) : 0 }; });
  const curve = [...buyers].sort((a, b) => b.revenue - a.revenue).map((r, i) => ({ rank: i + 1, cumShare: r.cumShare, name: r.name }));
  res.json({
    windowMonths: months, customers: rows.length, buyers: buyers.length, nonBuyers: rows.length - buyers.length, revenue: total,
    rfm: segs, matrix, abc, curve,
    sector: group(rows, (r) => r.sector), city: group(rows, (r) => r.city), potential: group(rows, (r) => r.potential), kind: group(rows, (r) => r.kind),
    top: [...buyers].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
  });
});

const FIELDS = ['revenue', 'orders', 'recencyDays', 'avgBasket', 'city', 'sector', 'potential', 'stage', 'kind', 'abc', 'segment', 'r', 'f', 'm', 'ownerId'];
router.get('/segments/members', P.need('view'), async (req, res) => {
  const { rows } = await metrics(req);
  const type = A.oneOf(req.query.type, ['rfm', 'abc', 'sector', 'city', 'potential', 'kind', 'nonbuyers'], undefined, 'Type de segment inconnu.');
  const key = String(req.query.key || '');
  const f = { rfm: (r) => r.segment === key, abc: (r) => r.abc === key, sector: (r) => (r.sector || '') === key, city: (r) => (r.city || '') === key, potential: (r) => (r.potential || '') === key, kind: (r) => r.kind === key, nonbuyers: (r) => !r.segment }[type];
  const list = rows.filter(f).sort((a, b) => b.revenue - a.revenue);
  res.json({ members: list.slice(0, 500), count: list.length, revenue: list.reduce((a, r) => a + r.revenue, 0) });
});

const cleanRules = (v) => {
  if (!Array.isArray(v) || !v.length || v.length > 8) throw new HttpError(400, 'Un segment compte de 1 à 8 règles.');
  return v.map((r) => {
    const field = A.oneOf(r && r.field, FIELDS, undefined, 'Champ de règle inconnu.');
    const op = A.oneOf(r && r.op, L.RULE_OPS, undefined, 'Opérateur de règle inconnu.');
    if (r.value === undefined || r.value === null || r.value === '') throw new HttpError(400, 'Chaque règle a une valeur.');
    return { field, op, value: Array.isArray(r.value) ? r.value.slice(0, 20).map((x) => String(x).slice(0, 60)) : typeof r.value === 'number' ? r.value : String(r.value).slice(0, 120) };
  });
};
const segView = (s, stats) => ({ id: Number(s.id), name: s.name, rules: JSON.parse(s.rules || '[]'), createdAt: s.created_at, ...stats });
router.get('/segments/custom', P.need('view'), async (req, res) => {
  const { rows } = await metrics(req);
  const segs = await db.prepare('SELECT * FROM cp_segments WHERE org_id = ? ORDER BY id').all(req.org.id);
  res.json({ fields: FIELDS, ops: L.RULE_OPS, segments: segs.map((s) => { const m = rows.filter((r) => L.matchRules(r, JSON.parse(s.rules || '[]'))); return segView(s, { count: m.length, revenue: m.reduce((a, r) => a + r.revenue, 0) }); }) });
});
router.post('/segments/custom', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO cp_segments (org_id, name, rules, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 80, { required: true, msg: 'Nommez le segment.' }), JSON.stringify(cleanRules(b.rules)), req.user.id, nowISO())).lastInsertRowid;
  await P.audit(req, 'segment', id, 'create', b.name);
  res.status(201).json({ id: Number(id) });
});
router.put('/segments/custom/:id', P.need('write'), async (req, res) => {
  const s = await db.prepare('SELECT * FROM cp_segments WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Segment introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE cp_segments SET name = ?, rules = ? WHERE id = ?').run(A.text(b.name, 80) || s.name, b.rules === undefined ? s.rules : JSON.stringify(cleanRules(b.rules)), s.id);
  res.json({ ok: true });
});
router.delete('/segments/custom/:id', P.need('write'), async (req, res) => {
  const x = await db.prepare('DELETE FROM cp_segments WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!x.changes) throw new HttpError(404, 'Segment introuvable.');
  res.json({ ok: true });
});
router.get('/segments/custom/:id/members', P.need('view'), async (req, res) => {
  const s = await db.prepare('SELECT * FROM cp_segments WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Segment introuvable.');
  const { rows } = await metrics(req);
  const m = rows.filter((r) => L.matchRules(r, JSON.parse(s.rules || '[]'))).sort((a, b) => b.revenue - a.revenue);
  res.json({ segment: segView(s, { count: m.length, revenue: m.reduce((a, r) => a + r.revenue, 0) }), members: m.slice(0, 500) });
});
// Action suggérée → une tâche par compte du segment (au plus 50), pour le commercial qui le suit (sinon pour vous).
router.post('/segments/tasks', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const { rows } = await metrics(req);
  let list;
  if (b.customId) { const s = await db.prepare('SELECT * FROM cp_segments WHERE id = ? AND org_id = ?').get(A.id(b.customId), req.org.id); if (!s) throw new HttpError(404, 'Segment introuvable.'); list = rows.filter((r) => L.matchRules(r, JSON.parse(s.rules || '[]'))); }
  else list = rows.filter((r) => r.segment === A.oneOf(b.rfm, L.RFM_SEGMENTS, undefined, 'Segment inconnu.'));
  const title = A.text(b.title, 160, { required: true, msg: 'Indiquez la tâche à créer.' });
  const due = b.dueAt ? new Date(b.dueAt) : new Date(Date.now() + 3 * 86400000);
  if (Number.isNaN(due.getTime())) throw new HttpError(400, 'Date invalide.');
  const cap = list.slice(0, 50);
  for (const r of cap) await db.prepare('INSERT INTO cp_tasks (org_id, customer_id, title, kind, due_at, assignee_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, r.id, `${title} — ${r.name}`.slice(0, 200), 'todo', due.toISOString(), r.ownerId || req.user.id, req.user.id, nowISO());
  await P.audit(req, 'segment', null, 'tasks', { created: cap.length });
  res.status(201).json({ created: cap.length, skipped: Math.max(0, list.length - cap.length) });
});

module.exports = { router, metrics, ACTIONS };
