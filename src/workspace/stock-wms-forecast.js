'use strict';
// Stock WMS · lot 8 : prévision simple de la demande (moyenne mobile sur les sorties hebdomadaires) et réapprovisionnement amélioré.
//  - Demande = sorties de la période (ventes, livraisons, ateliers, chantiers) ; sont exclus : écarts d'inventaire, pertes de transfert, retours, rebuts.
//  - Prévision = moyenne des N dernières semaines (N réglable, 8 par défaut) ; tendance = moyenne des 4 dernières semaines comparée à cette moyenne.
//    Un article récent n'est moyenné que sur les semaines depuis sa création. Avec plus de 14 mois d'historique, la moyenne est corrigée par un indice saisonnier (même période l'an dernier ÷ moyenne de l'année, borné de 0,5 à 2). Aucune promotion n'est vue.
//  - Point de commande = demande pendant le délai fournisseur + stock de sécurité. Stock de sécurité : valeur fixée sur l'article, sinon z × écart-type hebdomadaire × √(délai / 7 jours),
//    z venant du niveau de service réglé (95 % → 1,645). Délai : celui de l'article, sinon celui du fournisseur au meilleur prix, sinon le délai par défaut.
//  - Position de stock = disponible à promettre + déjà commandé. On propose de commander quand la position tombe au point de commande, pour remonter jusqu'au point de commande
//    plus la demande des « jours entre deux commandes » (ou jusqu'au stock maximum de l'article s'il existe).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-b-lib'); // fusion : socle de B servi par la couche de A
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(['/forecast', '/reorder', '/items/:id/params'], A.need('manager'));
const DAY = 86400000;
const NOT_CONSUMPTION = ['count', 'transfer', 'return', 'scrap'];
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

/** Facteur z d'un niveau de service (interpolation entre des valeurs usuelles). */
function zOf(level) {
  const T = [[50, 0], [80, 0.8416], [85, 1.0364], [90, 1.2816], [95, 1.6449], [97.5, 1.96], [99, 2.3263], [99.9, 3.0902]];
  if (level <= T[0][0]) return 0;
  for (let i = 1; i < T.length; i++) if (level <= T[i][0]) { const [x0, y0] = T[i - 1]; const [x1, y1] = T[i]; return y0 + ((y1 - y0) * (level - x0)) / (x1 - x0); }
  return T[T.length - 1][1];
}

/** Demande hebdomadaire d'un article : { series (ancienne → récente), weeks, avg, sd, ma4, trend }. */
function demandOf(it, moves, nowMs, N) {
  const created = Date.parse(it.created_at) || nowMs;
  const weeks = Math.max(1, Math.min(N, Math.ceil((nowMs - created) / (7 * DAY))));
  const buckets = new Array(weeks).fill(0);
  for (const m of moves) {
    const k = Math.floor((nowMs - Date.parse(m.created_at)) / (7 * DAY));
    if (k >= 0 && k < weeks) buckets[k] += m.q;
  }
  const series = buckets.map((x) => W.round3(x)).reverse(); // ancienne → récente
  const avg = series.reduce((a, x) => a + x, 0) / weeks;
  const sd = weeks > 1 ? Math.sqrt(series.reduce((a, x) => a + (x - avg) ** 2, 0) / (weeks - 1)) : 0;
  const last = series.slice(-Math.min(4, weeks));
  const ma4 = last.reduce((a, x) => a + x, 0) / last.length;
  const trend = weeks < 4 || avg <= 0 ? 'flat' : ma4 > avg * 1.15 ? 'up' : ma4 < avg * 0.85 ? 'down' : 'flat';
  return { series, weeks, avg, sd, ma4, trend };
}

async function load(req, cfg) {
  const nowMs = Date.now();
  const since = new Date(nowMs - cfg.forecastWeeks * 7 * DAY).toISOString();
  const sc = A.scope(req, 'i.branch_id');
  const items = await db.prepare(`SELECT i.* FROM stock_items i WHERE i.org_id = ?${sc.sql} ORDER BY i.name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  const mv = await db.prepare(`SELECT m.item_id, m.created_at, -m.delta AS q FROM stock_moves m WHERE m.org_id = ? AND m.delta < 0 AND m.created_at >= ? AND m.ref_kind NOT IN (${NOT_CONSUMPTION.map(() => '?').join(',')})`).all(req.org.id, since, ...NOT_CONSUMPTION);
  const longSince = new Date(nowMs - 400 * DAY).toISOString();
  const lg = await db.prepare(`SELECT m.item_id, m.created_at, -m.delta AS q FROM stock_moves m WHERE m.org_id = ? AND m.delta < 0 AND m.created_at >= ? AND m.ref_kind NOT IN (${NOT_CONSUMPTION.map(() => '?').join(',')})`).all(req.org.id, longSince, ...NOT_CONSUMPTION);
  const long = new Map();
  for (const m of lg) { if (!long.has(m.item_id)) long.set(m.item_id, []); long.get(m.item_id).push(m); }
  const by = new Map();
  for (const m of mv) { if (!by.has(m.item_id)) by.set(m.item_id, []); by.get(m.item_id).push(m); }
  const params = new Map((await db.prepare('SELECT * FROM wms_item_params WHERE org_id = ?').all(req.org.id)).map((p) => [p.item_id, p]));
  const av = await W.availabilityMap(req.org.id);
  let ordered = new Map();
  try { ordered = new Map((await db.prepare("SELECT item_id, SUM(quantity - received_qty) q FROM purchase_orders WHERE org_id = ? AND status IN ('pending','ordered','partial') GROUP BY item_id").all(req.org.id)).map((x) => [x.item_id, x.q])); } catch { ordered = new Map(); }
  const best = new Map((await db.prepare('SELECT p.item_id, p.supplier_id, s.name AS supplier, p.unit_price, p.lead_days FROM supplier_prices p JOIN suppliers s ON s.id = p.supplier_id WHERE p.org_id = ? ORDER BY p.unit_price').all(req.org.id)).reverse().reduce((m, x) => m.set(x.item_id, x), new Map()));
  return { nowMs, long, items, by, params, av, ordered, best };
}

/** Indice saisonnier : demande moyenne des 5 semaines qui entourent la même période l'an dernier, comparée à la moyenne de l'année. Null sans 14 mois d'historique. */
function seasonOf(it, moves, nowMs) {
  if ((nowMs - Date.parse(it.created_at)) < 380 * DAY || !moves || !moves.length) return null;
  const wk = new Array(58).fill(0);
  for (const m of moves) { const k = Math.floor((nowMs - Date.parse(m.created_at)) / (7 * DAY)); if (k >= 0 && k < 58) wk[k] += m.q; }
  const year = wk.slice(0, 52).reduce((a, x) => a + x, 0) / 52;
  if (year <= 0) return null;
  const ly = wk.slice(50, 55).reduce((a, x) => a + x, 0) / 5; // semaines 50 à 54 : même période, un an plus tôt
  return Math.min(Math.max(ly / year, 0.5), 2);
}

/** Prévision et paramètres de réapprovisionnement d'un article. */
function analyse(it, ctx, cfg) {
  const d = demandOf(it, ctx.by.get(it.id) || [], ctx.nowMs, cfg.forecastWeeks);
  const season = seasonOf(it, ctx.long.get(it.id), ctx.nowMs);
  if (season !== null) { d.avg *= season; d.sd *= season; }
  d.season = season;
  const p = ctx.params.get(it.id) || {};
  const sup = ctx.best.get(it.id) || null;
  const leadDays = p.lead_days !== null && p.lead_days !== undefined ? Number(p.lead_days) : sup && sup.lead_days !== null && sup.lead_days !== undefined ? Number(sup.lead_days) : cfg.defaultLeadDays;
  const avgDaily = d.avg / 7;
  const safetyAuto = zOf(cfg.serviceLevel) * d.sd * Math.sqrt(leadDays / 7);
  const safety = p.safety_stock !== null && p.safety_stock !== undefined ? Number(p.safety_stock) : safetyAuto;
  const leadDemand = avgDaily * leadDays;
  const rop = p.reorder_point !== null && p.reorder_point !== undefined ? Number(p.reorder_point) : leadDemand + safety;
  const a = ctx.av.get(it.id) || { available: 0, usable: 0, reserved: 0 };
  const onOrder = W.round3(ctx.ordered.get(it.id) || 0);
  const position = W.round3(a.available + onOrder);
  const target = it.max_quantity > 0 ? it.max_quantity : rop + avgDaily * cfg.reviewDays;
  let toOrder = 0;
  const needs = (avgDaily > 0 || p.reorder_point !== null && p.reorder_point !== undefined || it.min_quantity > 0) && position <= Math.max(rop, it.min_quantity > 0 ? it.min_quantity : 0) + 1e-9;
  if (needs) {
    toOrder = Math.max(target - position, 0);
    const mult = p.order_multiple ? Number(p.order_multiple) : 0;
    toOrder = mult > 0 ? Math.ceil(toOrder / mult) * mult : Math.ceil(toOrder);
  }
  const cover = avgDaily > 0 ? a.available / avgDaily : null;
  const urgency = !needs || toOrder <= 0 ? 'ok' : cover !== null && cover < leadDays ? 'critical' : cover !== null && cover < leadDays + 7 ? 'soon' : a.available <= 0 ? 'critical' : 'soon';
  return { d, leadDays, leadSource: p.lead_days !== null && p.lead_days !== undefined ? 'article' : sup && sup.lead_days !== null && sup.lead_days !== undefined ? 'fournisseur' : 'défaut',
    safety: r1(safety), safetySource: p.safety_stock !== null && p.safety_stock !== undefined ? 'article' : 'calculé', rop: r1(rop), ropSource: p.reorder_point !== null && p.reorder_point !== undefined ? 'article' : 'calculé', leadDemand: r1(leadDemand),
    available: a.available, reserved: a.reserved, onOrder, position, toOrder, cover: cover === null ? null : r1(cover), stockoutOn: cover === null ? null : new Date(ctx.nowMs + cover * DAY).toISOString().slice(0, 10), urgency, sup };
}

router.get('/forecast', async (req, res) => {
  const cfg = await W.settings(req.org.id);
  const ctx = await load(req, cfg);
  const rows = ctx.items.filter((i) => i.tracking !== 'serial' || true).map((it) => {
    const x = analyse(it, ctx, cfg);
    return { itemId: it.id, name: it.name, unit: it.unit, weeks: x.d.weeks, avgWeekly: r2(x.d.avg), ma4: r2(x.d.ma4), sdWeekly: r2(x.d.sd), trend: x.d.trend, seasonalIndex: x.d.season === null ? null : r2(x.d.season), nextWeeks: r2(x.d.avg), nextMonth: r2(x.d.avg * 4.345), series: x.d.series, available: x.available, cover: x.cover, stockoutOn: x.stockoutOn };
  });
  res.json({ weeksWindow: cfg.forecastWeeks, items: rows.filter((r) => req.query.all || r.avgWeekly > 0 || r.available > 0).sort((a, b) => b.avgWeekly - a.avgWeekly), method: 'moyenne mobile sur les sorties hebdomadaires' });
});

router.get('/forecast/:id', async (req, res) => {
  const cfg = await W.settings(req.org.id);
  const ctx = await load(req, cfg);
  const it = ctx.items.find((i) => i.id === A.id(req.params.id));
  if (!it) throw new HttpError(404, 'Article introuvable.');
  const x = analyse(it, ctx, cfg);
  res.json({ itemId: it.id, name: it.name, unit: it.unit, weeks: x.d.weeks, series: x.d.series, avgWeekly: r2(x.d.avg), ma4: r2(x.d.ma4), sdWeekly: r2(x.d.sd), trend: x.d.trend, seasonalIndex: x.d.season === null ? null : r2(x.d.season), nextWeeks: [1, 2, 3, 4].map((n) => ({ week: n, quantity: r2(x.d.avg) })), cover: x.cover, stockoutOn: x.stockoutOn });
});

// ---------- Réapprovisionnement amélioré ----------
router.get('/reorder', async (req, res) => {
  const cfg = await W.settings(req.org.id);
  const ctx = await load(req, cfg);
  const out = [];
  for (const it of ctx.items) {
    const x = analyse(it, ctx, cfg);
    if (x.toOrder <= 0) continue;
    out.push({ itemId: it.id, name: it.name, unit: it.unit, urgency: x.urgency, available: x.available, reserved: x.reserved, onOrder: x.onOrder, position: x.position, reorderPoint: x.rop, reorderPointSource: x.ropSource, safetyStock: x.safety, safetySource: x.safetySource,
      leadDays: x.leadDays, leadSource: x.leadSource, avgWeekly: r2(x.d.avg), trend: x.d.trend, coverDays: x.cover, stockoutOn: x.stockoutOn, toOrder: x.toOrder,
      supplier: x.sup ? { supplierId: x.sup.supplier_id, name: x.sup.supplier, unitPrice: Number(x.sup.unit_price), leadDays: x.sup.lead_days === null ? null : Number(x.sup.lead_days) } : null, estimate: x.sup ? Math.round(x.toOrder * Number(x.sup.unit_price)) : null });
  }
  const rank = { critical: 0, soon: 1, ok: 2 };
  out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.coverDays === null) - (b.coverDays === null) || (a.coverDays || 0) - (b.coverDays || 0));
  res.json({ suggestions: out, critical: out.filter((x) => x.urgency === 'critical').length, estimate: out.reduce((a, x) => a + (x.estimate || 0), 0), serviceLevel: cfg.serviceLevel, z: r2(zOf(cfg.serviceLevel)) });
});

// ---------- Paramètres par article ----------
const itemOf = async (req, id) => {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(id, 'Article invalide.'), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  return it;
};
const pview = (p) => ({ safetyStock: p && p.safety_stock !== null ? p.safety_stock : null, leadDays: p && p.lead_days !== null ? Number(p.lead_days) : null, reorderPoint: p && p.reorder_point !== null ? p.reorder_point : null, orderMultiple: p && p.order_multiple !== null ? p.order_multiple : null });
router.get('/items/:id/params', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  res.json({ itemId: it.id, params: pview(await db.prepare('SELECT * FROM wms_item_params WHERE item_id = ?').get(it.id)) });
});
router.put('/items/:id/params', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const b = req.body || {};
  const cur = await db.prepare('SELECT * FROM wms_item_params WHERE item_id = ?').get(it.id);
  const pick = (k, col, parse) => (b[k] === undefined ? (cur ? cur[col] : null) : b[k] === null || b[k] === '' ? null : parse(b[k]));
  const next = {
    safety: pick('safetyStock', 'safety_stock', (v) => A.qty(v, { allowZero: true })),
    lead: pick('leadDays', 'lead_days', (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 365) throw new HttpError(400, 'Délai fournisseur : un nombre entier de jours (0 à 365).'); return n; }),
    rop: pick('reorderPoint', 'reorder_point', (v) => A.qty(v, { allowZero: true })),
    mult: pick('orderMultiple', 'order_multiple', (v) => A.qty(v)),
  };
  await db.prepare('INSERT INTO wms_item_params (item_id, org_id, safety_stock, lead_days, reorder_point, order_multiple, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET safety_stock = EXCLUDED.safety_stock, lead_days = EXCLUDED.lead_days, reorder_point = EXCLUDED.reorder_point, order_multiple = EXCLUDED.order_multiple, updated_at = EXCLUDED.updated_at')
    .run(it.id, req.org.id, next.safety, next.lead, next.rop, next.mult, nowISO());
  res.json({ ok: true, params: pview(await db.prepare('SELECT * FROM wms_item_params WHERE item_id = ?').get(it.id)) });
});

module.exports = router;
