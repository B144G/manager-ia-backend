'use strict';
// Prévision des ventes : (1) pipeline pondéré par mois de clôture prévue, (2) tendance historique (moyenne mobile et lissage exponentiel simple),
// (3) scénarios pessimiste / central / optimiste, (4) atterrissage face à l'objectif, par commercial, produit, zone ou mois, avec rétro-test de la méthode.
// « Réalisé » = factures émises nettes d'avoirs. Les objectifs (quotas) viennent de cp_targets (voir aussi la force de vente).
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const Dt = require('./data');
const { HttpError } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;

// ---------- Objectifs mensuels ----------
const monthParam = (v, msg = 'Mois invalide (AAAA-MM).') => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''))) throw new HttpError(400, msg); return v; };
const METRICS = ['revenue', 'margin', 'new_customers', 'visits', 'opps_won'];
router.get('/targets', P.need('view'), async (req, res) => {
  const from = monthParam(req.query.from || B.today().slice(0, 7)); const to = monthParam(req.query.to || L.addMonths(from, 11));
  const cp = await P.load(req);
  const rows = await db.prepare(`SELECT * FROM cp_targets WHERE org_id = ? AND period >= ? AND period <= ?${cp.scopeOwn ? ' AND (user_id = ? OR user_id = 0)' : ''} ORDER BY period, user_id`).all(req.org.id, from, to, ...(cp.scopeOwn ? [req.user.id] : []));
  res.json({ targets: rows.map((t) => ({ id: Number(t.id), userId: N(t.user_id) || null, period: t.period, metric: t.metric, value: N(t.value) })) });
});
router.put('/targets', P.need('targets'), async (req, res) => {
  const b = req.body || {};
  const period = monthParam(b.period);
  const metric = A.oneOf(b.metric, METRICS, 'revenue', 'Indicateur d’objectif inconnu.');
  const uid = b.userId ? await A.memberOf(req, b.userId) : 0;
  const value = Math.round(Number(b.value));
  if (!Number.isFinite(value) || value < 0 || value > 1e13) throw new HttpError(400, 'Objectif invalide : indiquez un nombre positif ou zéro.');
  await db.prepare('INSERT INTO cp_targets (org_id, user_id, period, metric, value, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, user_id, period, metric) DO UPDATE SET value = excluded.value, created_by = excluded.created_by')
    .run(req.org.id, uid || 0, period, metric, value, req.user.id, nowISO());
  await P.audit(req, 'target', null, 'set', { period, metric, userId: uid || 0, value });
  res.json({ ok: true });
});
router.delete('/targets', P.need('targets'), async (req, res) => {
  const period = monthParam(req.query.period);
  await db.prepare('DELETE FROM cp_targets WHERE org_id = ? AND period = ? AND user_id = ? AND metric = ?').run(req.org.id, period, req.query.userId ? A.id(req.query.userId) : 0, A.oneOf(req.query.metric, METRICS, 'revenue'));
  await P.audit(req, 'target', null, 'delete', { period });
  res.json({ ok: true });
});
/** Objectif de chiffre d'affaires d'un mois : la ligne « organisation » si elle existe, sinon la somme des objectifs individuels. */
async function revenueTarget(orgId, month) {
  const rows = await db.prepare("SELECT user_id, value FROM cp_targets WHERE org_id = ? AND period = ? AND metric = 'revenue'").all(orgId, month);
  const org = rows.find((r) => N(r.user_id) === 0);
  return org ? N(org.value) : rows.reduce((a, r) => a + N(r.value), 0);
}

// ---------- Pipeline ----------
async function openPipeline(req, { ownerId, product, zoneId } = {}) {
  const stages = await require('./pipeline').stagesOf(req.org.id); const sm = new Map(stages.map((s) => [s.id, s]));
  const ow = await P.own(req, 'owner_id');
  let rows = await db.prepare(`SELECT * FROM cp_opps WHERE org_id = ? AND status = 'open'${ow.sql}`).all(req.org.id, ...ow.args);
  if (ownerId) rows = rows.filter((o) => Number(o.owner_id) === Number(ownerId));
  if (zoneId) rows = rows.filter((o) => Number(o.zone_id) === Number(zoneId));
  if (product) rows = rows.filter((o) => L.normName(o.product).includes(L.normName(product)));
  return rows.map((o) => { const st = sm.get(Number(o.stage_id)); const prob = require('./pipeline').oppProb(o, st); return { id: Number(o.id), ownerId: o.owner_id ? Number(o.owner_id) : null, product: o.product, zoneId: o.zone_id ? Number(o.zone_id) : null, stage: st.name, amount: N(o.amount), probability: prob, weighted: L.weighted(o.amount, prob), closeDate: o.close_date }; });
}

router.get('/forecast', P.need('view'), async (req, res) => {
  const set = await B.settings(req.org.id);
  const cp = await P.load(req);
  const horizon = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 12);
  const filters = { ownerId: cp.scopeOwn ? req.user.id : req.query.ownerId, product: req.query.product, zoneId: req.query.zoneId };
  const m0 = B.today().slice(0, 7);
  const histFrom = L.addMonths(m0, -24);
  const inv = await Dt.invoices(req.org.id, { from: `${histFrom}-01` });
  const map = Dt.byMonth(inv, filters);
  const past = Dt.series(map, histFrom, L.addMonths(m0, -1)); // mois complets seulement
  let first = past.findIndex((x) => x > 0); first = first < 0 ? past.length : first;
  const hist = past.slice(first); // on ignore les mois d'avant le premier chiffre d'affaires
  const alpha = Number(set.forecastAlpha); const win = Math.round(Number(set.forecastWindow));
  const ma = Math.round(L.movingAverage(hist, win)); const sesV = Math.round(L.ses(hist, alpha));
  const pipe = await openPipeline(req, filters);
  const months = Array.from({ length: horizon }, (_, i) => L.addMonths(m0, i));
  const bucket = (o) => { const m = o.closeDate ? o.closeDate.slice(0, 7) : null; return m ? (m < m0 ? m0 : m) : null; };
  const factors = set.scenarioFactors;
  const rows = [];
  for (const mo of months) {
    const mine = pipe.filter((o) => bucket(o) === mo);
    const W = mine.reduce((a, o) => a + o.weighted, 0); const Aamt = mine.reduce((a, o) => a + o.amount, 0);
    const realized = mo === m0 ? N(map.get(m0)) : 0;
    const sc = L.landing(realized, W, Aamt, factors);
    const trend = hist.length ? sesV : 0;
    const bw = Math.min(Math.max(Number(set.blendPipeline), 0), 100) / 100;
    const blended = Math.round(bw * sc.central + (1 - bw) * (mo === m0 ? Math.max(trend, realized) : trend));
    const target = await revenueTarget(req.org.id, mo);
    rows.push({ month: mo, realized, pipelineCount: mine.length, pipelineAmount: Aamt, weighted: W, scenarios: sc, trendSes: trend, trendMa: ma, blended, target, gapCentral: target ? sc.central - target : null, attainmentCentral: target ? L.round((sc.central * 100) / target, 1) : null, attainmentBlended: target ? L.round((blended * 100) / target, 1) : null });
  }
  const undated = pipe.filter((o) => !o.closeDate);
  const overdue = pipe.filter((o) => o.closeDate && o.closeDate.slice(0, 7) < m0 || (o.closeDate && o.closeDate < B.today() && o.closeDate.slice(0, 7) === m0));
  const bt = L.backtest(hist, alpha, win);
  const histMonths = L.monthsBetween(L.addMonths(m0, -hist.length), L.addMonths(m0, -1));
  res.json({
    month: m0, settings: { alpha, window: win, factors, blendPipeline: Number(set.blendPipeline) },
    history: hist.map((v, i) => ({ month: histMonths[i], value: v })).slice(-12), trend: { movingAverage: ma, ses: sesV, months: hist.length },
    backtest: { mape: bt.mape, rows: bt.rows.map((r) => ({ month: histMonths[r.index], actual: r.actual, forecast: r.forecast, errorPct: r.errorPct })).slice(-6) },
    months: rows, pipeline: { count: pipe.length, amount: pipe.reduce((a, o) => a + o.amount, 0), weighted: pipe.reduce((a, o) => a + o.weighted, 0), undated: { count: undated.length, amount: undated.reduce((a, o) => a + o.amount, 0), weighted: undated.reduce((a, o) => a + o.weighted, 0) }, overdue: { count: overdue.length, amount: overdue.reduce((a, o) => a + o.amount, 0) } },
    total: { central: rows.reduce((a, r) => a + r.scenarios.central, 0), pessimistic: rows.reduce((a, r) => a + r.scenarios.pessimistic, 0), optimistic: rows.reduce((a, r) => a + r.scenarios.optimistic, 0), target: rows.reduce((a, r) => a + r.target, 0) },
  });
});

router.get('/forecast/breakdown', P.need('view'), async (req, res) => {
  const by = A.oneOf(req.query.by, ['owner', 'product', 'zone', 'month', 'stage'], 'owner', 'Axe inconnu (commercial, produit, zone, mois, étape).');
  const cp = await P.load(req);
  const pipe = await openPipeline(req, { ownerId: cp.scopeOwn ? req.user.id : req.query.ownerId });
  const names = await B.names(req.org.id);
  const zones = new Map((await db.prepare('SELECT id, name FROM cp_zones WHERE org_id = ?').all(req.org.id)).map((z) => [Number(z.id), z.name]));
  const keyOf = { owner: (o) => String(o.ownerId || 0), product: (o) => o.product || '', zone: (o) => String(o.zoneId || 0), month: (o) => (o.closeDate ? o.closeDate.slice(0, 7) : ''), stage: (o) => o.stage }[by];
  const labelOf = { owner: (k) => names.get(Number(k)) || '', zone: (k) => zones.get(Number(k)) || '' }[by] || ((k) => k);
  const m = new Map();
  for (const o of pipe) { const k = keyOf(o); const v = m.get(k) || { key: k, label: labelOf(k), count: 0, amount: 0, weighted: 0 }; v.count++; v.amount += o.amount; v.weighted += o.weighted; m.set(k, v); }
  const total = [...m.values()].reduce((a, v) => a + v.weighted, 0);
  res.json({ by, rows: [...m.values()].map((v) => ({ ...v, avgProbability: v.amount ? L.round((v.weighted * 100) / v.amount, 1) : 0, share: total ? L.round((v.weighted * 100) / total, 1) : 0 })).sort((a, b) => (by === 'month' ? a.key.localeCompare(b.key) : b.weighted - a.weighted)), total: { count: pipe.length, amount: pipe.reduce((a, o) => a + o.amount, 0), weighted: total } });
});

router.get('/forecast/variance', P.need('view'), async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
  const m0 = B.today().slice(0, 7);
  const cp = await P.load(req);
  const from = L.addMonths(m0, -(n - 1));
  const map = Dt.byMonth(await Dt.invoices(req.org.id, { from: `${from}-01` }), { ownerId: cp.scopeOwn ? req.user.id : req.query.ownerId });
  const rows = []; let cumT = 0; let cumA = 0;
  for (const mo of L.monthsBetween(from, m0)) {
    const target = await revenueTarget(req.org.id, mo); const actual = N(map.get(mo));
    cumT += target; cumA += actual;
    rows.push({ month: mo, target, actual, gap: actual - target, gapPct: target ? L.round(((actual - target) * 100) / target, 1) : null, cumTarget: cumT, cumActual: cumA, inProgress: mo === m0 });
  }
  res.json({ rows, totals: { target: cumT, actual: cumA, gap: cumA - cumT, attainment: cumT ? L.round((cumA * 100) / cumT, 1) : null } });
});

module.exports = { router, revenueTarget, openPipeline };
