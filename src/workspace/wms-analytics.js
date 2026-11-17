'use strict';
// Stock entrepôt (WMS) — analyses : classement ABC, inventaire tournant (plan, écarts), prévisions et réapprovisionnement, rapports
// (valorisation par emplacement, rotation, ruptures, vieillissement, journal des mouvements), exports CSV (?format=csv).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const L = require('./stock-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const r1 = (n) => Math.round(n * 10) / 10;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const daysAgo = (n) => iso(Date.now() - n * DAY);

// ---------- CSV ----------
const cell = (v) => { let s = String(v == null ? '' : v); if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function sendMaybeCsv(req, res, json, name, cols, rows) {
  if (req.query.format !== 'csv') return res.json(json);
  const body = '﻿' + [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => c[1](r)))].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="${name}.csv"` });
  return res.send(body);
}

// ---------- Données de base ----------
async function itemsOf(req) {
  const sc = A.scope(req);
  return db.prepare(`SELECT * FROM stock_items WHERE org_id = ?${sc.sql} ORDER BY name`).all(req.org.id, ...sc.args);
}
/** Sorties (consommation) par article depuis `since` : hors ajustements d'inventaire. */
async function issuesSince(orgId, since) {
  const rows = await db.prepare("SELECT item_id, SUM(-delta) AS q FROM stock_moves WHERE org_id = ? AND delta < 0 AND created_at >= ? AND ref_kind != 'count' GROUP BY item_id").all(orgId, since);
  return Object.fromEntries(rows.map((r) => [Number(r.item_id), Number(r.q)]));
}
const value = (it, q) => Math.round(Number(q) * L.unitValue(it));

// ---------- ABC ----------
async function abc(req) {
  const s = await W.settingsOf(req.org.id);
  const items = await itemsOf(req);
  const used = await issuesSince(req.org.id, daysAgo(s.abcDays));
  const list = items.map((it) => ({ it, qty: r3(used[it.id] || 0), cons: value(it, used[it.id] || 0) })).sort((a, b) => b.cons - a.cons || a.it.name.localeCompare(b.it.name));
  const total = list.reduce((x, l) => x + l.cons, 0);
  let cum = 0;
  const out = list.map((l, i) => {
    const before = total ? (cum / total) * 100 : 100;
    cum += l.cons;
    const cls = l.cons <= 0 ? 'C' : before < s.abcA ? 'A' : before < s.abcB ? 'B' : 'C';
    return { itemId: Number(l.it.id), rank: i + 1, name: l.it.name, class: cls, noMovement: l.cons <= 0, consumedQty: l.qty, share: total ? r1((l.cons / total) * 100) : 0, cumShare: total ? r1((cum / total) * 100) : 0, consumption: l.cons, stockValue: value(l.it, l.it.quantity), tracking: l.it.tracking };
  });
  return { s, total, items: out };
}
router.get('/abc', mgr, async (req, res) => {
  const { s, total, items } = await abc(req);
  const stockTotal = items.reduce((a, i) => a + i.stockValue, 0);
  const classes = ['A', 'B', 'C'].map((c) => { const x = items.filter((i) => i.class === c); const sv = x.reduce((a, i) => a + i.stockValue, 0); return { class: c, items: x.length, share: total ? r1((x.reduce((a, i) => a + i.consumption, 0) / total) * 100) : 0, stockValue: sv, consumption: x.reduce((a, i) => a + i.consumption, 0), stockShare: stockTotal ? r1((sv / stockTotal) * 100) : 0 }; });
  // Ajouts (ligne B) : totalConsumption, totalStockValue, since.
  res.json({ since: daysAgo(s.abcDays).slice(0, 10), days: s.abcDays, thresholds: { a: s.abcA, b: s.abcB }, totalConsumption: total, totalStockValue: stockTotal, classes, items });
});
/** Enregistre le classement (réutilisé pour planifier les inventaires tournants). */
router.post('/abc/refresh', mgr, async (req, res) => {
  const { items } = await abc(req);
  await db.transaction(async () => {
    for (const r of items) await db.prepare('INSERT INTO wms_item_class (item_id, org_id, class, consumption, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET class = EXCLUDED.class, consumption = EXCLUDED.consumption, rank = EXCLUDED.rank, computed_at = EXCLUDED.computed_at').run(r.itemId, req.org.id, r.class, r.consumption, r.rank, nowISO());
  })();
  res.json({ ok: true, items: items.length, counts: Object.fromEntries(['A', 'B', 'C'].map((c) => [c, items.filter((r) => r.class === c).length])) });
});

// ---------- Inventaire tournant ----------
async function lastCounted(orgId) {
  const rows = await db.prepare("SELECT l.item_id, MAX(c.decided_at) AS at FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id WHERE c.org_id = ? AND c.status = 'validated' AND l.counted IS NOT NULL GROUP BY l.item_id").all(orgId);
  return Object.fromEntries(rows.map((r) => [Number(r.item_id), String(r.at).slice(0, 10)]));
}
async function plan(req) {
  const { s, items } = await abc(req);
  const last = await lastCounted(req.org.id);
  const every = { A: s.cycleA, B: s.cycleB, C: s.cycleC };
  const today = W.today();
  const rows = items.filter((i) => i.tracking !== 'serial').map((i) => {
    const lc = last[i.itemId] || null;
    const dueOn = lc ? iso(Date.parse(lc) + every[i.class] * DAY).slice(0, 10) : today;
    return { ...i, lastCounted: lc, dueOn, due: dueOn <= today };
  });
  return { s, every, rows, today };
}
router.get('/cycle-counts/plan', mgr, async (req, res) => {
  const p = await plan(req);
  const soon = iso(Date.now() + 30 * DAY).slice(0, 10);
  const nextOf = (c) => { const x = p.rows.filter((r) => r.class === c).map((r) => r.dueOn).sort(); return x.length ? x[0] : null; };
  res.json({
    due: p.rows.filter((r) => r.due).length, // ajout (ligne B)
    classes: ['A', 'B', 'C'].map((c) => ({ class: c, everyDays: p.every[c], items: p.rows.filter((r) => r.class === c).length, due: p.rows.filter((r) => r.class === c && r.due).length, nextDue: nextOf(c) })),
    dueItems: p.rows.filter((r) => r.due).map((r) => ({ itemId: r.itemId, name: r.name, class: r.class, lastCounted: r.lastCounted, stockValue: r.stockValue })),
    upcoming: p.rows.filter((r) => !r.due && r.dueOn <= soon).sort((a, b) => a.dueOn.localeCompare(b.dueOn)).map((r) => ({ itemId: r.itemId, name: r.name, class: r.class, dueOn: r.dueOn })),
  });
});
router.post('/cycle-counts', mgr, async (req, res) => {
  const rawClasses = Array.isArray((req.body || {}).classes) && req.body.classes.length ? req.body.classes : ['A', 'B', 'C'];
  if (rawClasses.some((c) => !['A', 'B', 'C'].includes(String(c).toUpperCase()))) throw new HttpError(400, 'Classe inconnue (A, B ou C).');
  const classes = rawClasses.map((c) => String(c).toUpperCase());
  const limit = (req.body || {}).limit === undefined || req.body.limit === '' ? 500 : Math.min(Math.max(Math.round(Number(req.body.limit)) || 50, 1), 500);
  if (await db.prepare("SELECT 1 FROM stock_counts WHERE org_id = ? AND status IN ('open','submitted')").get(req.org.id)) throw new HttpError(409, "Un inventaire est déjà en cours : terminez-le (validation ou rejet) avant d'en ouvrir un autre.");
  const p = await plan(req);
  const due = p.rows.filter((r) => r.due && classes.includes(r.class)).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.rank - b.rank).slice(0, limit);
  if (!due.length) throw new HttpError(400, 'Aucun article à compter pour ces classes : tout est à jour.');
  const now = nowISO();
  const id = await db.transaction(async () => {
    const seq = Number((await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM stock_counts WHERE org_id = ?').get(req.org.id)).n);
    const cid = Number((await db.prepare('INSERT INTO stock_counts (org_id, branch_id, seq, status, note, created_by, created_at, cycle_class) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)').run(req.org.id, seq, 'open', `Inventaire tournant (classes ${classes.join(', ')})`, req.user.id, now, classes.join(','))).lastInsertRowid);
    for (const r of due) { const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(r.itemId); await db.prepare('INSERT INTO stock_count_lines (count_id, item_id, expected, unit_value) VALUES (?, ?, ?, ?)').run(cid, it.id, it.quantity, L.unitValue(it)); }
    return cid;
  })();
  res.status(201).json({ id, items: due.length });
});
router.get('/cycle-counts/variance', mgr, async (req, res) => {
  const { items } = await abc(req);
  const cls = Object.fromEntries(items.map((i) => [i.itemId, i.class]));
  const rows = await db.prepare("SELECT l.*, i.name, c.decided_at FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id JOIN stock_items i ON i.id = l.item_id WHERE c.org_id = ? AND c.status = 'validated' AND l.counted IS NOT NULL AND c.decided_at >= ? ORDER BY c.decided_at DESC").all(req.org.id, daysAgo(365));
  const gaps = rows.map((l) => ({ name: l.name, class: cls[Number(l.item_id)] || 'C', expected: r3(l.expected), counted: r3(l.counted), at: l.decided_at, gap: r3(l.counted - l.expected), gapValue: Math.round((l.counted - l.expected) * l.unit_value) }));
  res.json({
    classes: ['A', 'B', 'C'].map((c) => { const g = gaps.filter((x) => x.class === c); return { class: c, lines: g.length, withGap: g.filter((x) => Math.abs(x.gap) > 1e-9).length, accuracy: g.length ? r1((g.filter((x) => Math.abs(x.gap) < 1e-9).length / g.length) * 100) : null, shortValue: g.filter((x) => x.gapValue < 0).reduce((a, x) => a + x.gapValue, 0), surplusValue: g.filter((x) => x.gapValue > 0).reduce((a, x) => a + x.gapValue, 0), netValue: g.reduce((a, x) => a + x.gapValue, 0) }; }),
    netValue: gaps.reduce((a, x) => a + x.gapValue, 0),
    gaps: gaps.filter((g) => Math.abs(g.gap) > 1e-9).slice(0, 200),
  });
});

// ---------- Prévisions et réapprovisionnement ----------
async function weekly(orgId, weeks) {
  const start = Date.now() - weeks * 7 * DAY;
  const rows = await db.prepare("SELECT item_id, delta, created_at FROM stock_moves WHERE org_id = ? AND delta < 0 AND created_at >= ? AND ref_kind != 'count'").all(orgId, iso(start));
  const out = {};
  for (const m of rows) {
    const w = Math.min(weeks - 1, Math.floor((Date.parse(m.created_at) - start) / (7 * DAY)));
    (out[m.item_id] = out[m.item_id] || Array(weeks).fill(0))[w] += -Number(m.delta);
  }
  return out;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : 0; };
/** Quantile de la loi normale (niveau de service → coefficient z), approximation d'Acklam. */
function zOf(p) {
  p = Math.min(0.9999, Math.max(0.5, p));
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const trendOf = (series) => { const h = Math.floor(series.length / 2); const a = mean(series.slice(0, h)); const b = mean(series.slice(h)); return b > a * 1.15 && b - a > 1e-9 ? 'up' : b < a * 0.85 ? 'down' : 'flat'; };
async function onOrderOf(itemId) {
  const old = Number((await db.prepare("SELECT COALESCE(SUM(quantity - received_qty), 0) AS q FROM purchase_orders WHERE item_id = ? AND status IN ('pending','ordered','partial')").get(itemId)).q);
  const rows = await db.prepare(`SELECT l.quantity, (SELECT COALESCE(SUM(rl.received_qty - rl.insp_rejected), 0) FROM pur_receipt_lines rl WHERE rl.order_line_id = l.id) AS got FROM pur_order_lines l JOIN pur_orders o ON o.id = l.order_id WHERE l.item_id = ? AND o.status IN ('approved','sent','partial')`).all(itemId);
  return r3(old + rows.reduce((s, r) => s + Math.max(0, Number(r.quantity) - Number(r.got)), 0));
}
router.get('/forecast', mgr, async (req, res) => {
  const s = await W.settingsOf(req.org.id);
  const series = await weekly(req.org.id, s.forecastWeeks);
  const out = [];
  for (const it of await itemsOf(req)) {
    const sr = (series[it.id] || Array(s.forecastWeeks).fill(0)).map(r3);
    const avg = mean(sr);
    if (avg <= 0 && Number(it.quantity) <= 0) continue;
    const av = await W.availability(it.id);
    out.push({ itemId: Number(it.id), name: it.name, unit: it.unit, trend: trendOf(sr), avgWeekly: r3(avg), nextMonth: r3(avg * 4.33), cover: avg > 0 ? Math.round(Math.max(0, av.available) / (avg / 7)) : null, series: sr });
  }
  res.json({ weeksWindow: s.forecastWeeks, items: out.sort((a, b) => b.avgWeekly - a.avgWeekly) });
});
router.get('/reorder', mgr, async (req, res) => {
  const s = await W.settingsOf(req.org.id);
  await W.expireReservations(req.org.id);
  const series = await weekly(req.org.id, s.forecastWeeks);
  const z = zOf(s.serviceLevel / 100);
  const out = [];
  for (const it of await itemsOf(req)) {
    const sr = series[it.id] || Array(s.forecastWeeks).fill(0);
    const daily = mean(sr) / 7;
    if (daily <= 0 && !(Number(it.min_quantity) > 0)) continue;
    const p = await db.prepare('SELECT * FROM wms_item_params WHERE item_id = ?').get(it.id) || {};
    const best = await db.prepare('SELECT p.supplier_id, p.unit_price, p.lead_days, s.name FROM supplier_prices p JOIN suppliers s ON s.id = p.supplier_id WHERE p.item_id = ? AND COALESCE(s.blocked, 0) = 0 ORDER BY p.unit_price, COALESCE(p.lead_days, 999) LIMIT 1').get(it.id);
    const lead = p.lead_days !== null && p.lead_days !== undefined ? Number(p.lead_days) : best && best.lead_days !== null ? Number(best.lead_days) : s.defaultLeadDays;
    const safety = p.safety_stock !== null && p.safety_stock !== undefined ? Number(p.safety_stock) : z * (sd(sr) / Math.sqrt(7)) * Math.sqrt(Math.max(lead, 1));
    const rop = p.reorder_point !== null && p.reorder_point !== undefined ? Number(p.reorder_point) : Math.max(daily * lead + safety, Number(it.min_quantity) || 0);
    const av = await W.availability(it.id);
    const onOrder = await onOrderOf(it.id);
    const position = av.available + onOrder;
    if (position > rop + 1e-9) continue;
    let toOrder = Math.max(0, rop + daily * s.reviewDays - position);
    if (Number(it.max_quantity) > 0) toOrder = Math.min(toOrder, Math.max(0, Number(it.max_quantity) - position));
    const mult = Number(p.order_multiple) || 0;
    toOrder = mult > 0 ? Math.ceil(toOrder / mult) * mult : Math.ceil(toOrder * 100) / 100;
    if (toOrder <= 0) continue;
    const coverDays = daily > 0 ? Math.round(Math.max(0, av.available) / daily) : null;
    const urgency = av.available <= 0 || (coverDays !== null && coverDays < lead) ? 'critical' : 'soon';
    out.push({ itemId: Number(it.id), name: it.name, unit: it.unit, urgency, available: r3(av.available), onOrder, reorderPoint: r3(rop), safetyStock: r3(safety), leadDays: lead, coverDays, trend: trendOf(sr), toOrder: r3(toOrder),
      estimate: best ? Math.round(toOrder * Number(best.unit_price)) : null, supplier: best ? { supplierId: Number(best.supplier_id), name: best.name, unitPrice: Number(best.unit_price), leadDays: best.lead_days === null ? null : Number(best.lead_days) } : null });
  }
  out.sort((a, b) => (a.urgency === b.urgency ? a.name.localeCompare(b.name) : a.urgency === 'critical' ? -1 : 1));
  res.json({ suggestions: out, critical: out.filter((x) => x.urgency === 'critical').length, estimate: out.reduce((s2, x) => s2 + (x.estimate || 0), 0), serviceLevel: s.serviceLevel });
});

// ---------- Rapports ----------
router.get('/reports/valuation', mgr, async (req, res) => {
  const rows = await db.prepare(`SELECT i.*, s.quantity AS loc_qty, l.id AS lid, l.code, w.name AS wh FROM wms_stock s JOIN stock_items i ON i.id = s.item_id JOIN wms_locations l ON l.id = s.location_id JOIN wms_warehouses w ON w.id = l.warehouse_id
    WHERE s.org_id = ? AND s.quantity > 0 ORDER BY w.name, l.code, i.name`).all(req.org.id);
  const lines = rows.map((r) => ({ item: r.name, location: r.code, warehouse: r.wh, quantity: r3(r.loc_qty), unit: r.unit, unitValue: Math.round(L.unitValue(r) * 100) / 100, value: value(r, r.loc_qty), lid: Number(r.lid) }));
  const by = (key) => { const m = new Map(); for (const l of lines) { const k = key(l); const x = m.get(k) || { quantity: 0, value: 0 }; x.quantity = r3(x.quantity + l.quantity); x.value += l.value; m.set(k, x); } return m; };
  const json = {
    totalValue: lines.reduce((s, l) => s + l.value, 0),
    warehouses: [...by((l) => l.warehouse).entries()].map(([name, x]) => ({ name, value: x.value })),
    locations: [...by((l) => `${l.lid}|${l.location} (${l.warehouse})`).entries()].map(([k, x]) => ({ id: Number(k.split('|')[0]), name: k.split('|')[1], quantity: x.quantity, value: x.value })),
    lines: lines.map(({ lid, ...l }) => l),
  };
  return sendMaybeCsv(req, res, json, 'valorisation-stock', [['Article', (l) => l.item], ['Entrepôt', (l) => l.warehouse], ['Emplacement', (l) => l.location], ['Quantité', (l) => l.quantity], ['Unité', (l) => l.unit], ['Valeur unitaire', (l) => l.unitValue], ['Valeur', (l) => l.value]], json.lines);
});
router.get('/reports/rotation', mgr, async (req, res) => {
  const days = 365;
  const used = await issuesSince(req.org.id, daysAgo(days));
  const lastOut = Object.fromEntries((await db.prepare('SELECT item_id, MAX(created_at) AS at FROM stock_moves WHERE org_id = ? AND delta < 0 GROUP BY item_id').all(req.org.id)).map((r) => [Number(r.item_id), r.at]));
  const items = (await itemsOf(req)).map((it) => {
    const q = r3(used[it.id] || 0); const sv = value(it, it.quantity);
    const cover = q > 0 ? Math.round(Number(it.quantity) / (q / days)) : null;
    const lo = lastOut[it.id];
    const dormant = Number(it.quantity) > 0 && (!lo || Date.parse(lo) < Date.now() - 180 * DAY);
    return { itemId: Number(it.id), name: it.name, status: dormant ? 'dormant' : cover !== null && cover > 180 ? 'slow' : 'normal', consumedQty: q, coverDays: cover, turnover: sv > 0 ? r1(value(it, q) / sv) : null, stockValue: sv };
  }).sort((a, b) => b.stockValue - a.stockValue);
  const dormant = items.filter((i) => i.status === 'dormant');
  const json = { days, dormant: dormant.length, dormantValue: dormant.reduce((s, i) => s + i.stockValue, 0), items };
  return sendMaybeCsv(req, res, json, 'rotation-stock', [['Article', (i) => i.name], ['Statut', (i) => i.status], ['Consommé (1 an)', (i) => i.consumedQty], ['Couverture (jours)', (i) => i.coverDays ?? ''], ['Rotation (fois/an)', (i) => i.turnover ?? ''], ['Valeur du stock', (i) => i.stockValue]], items);
});
const STOCKOUT = { out: 'Rupture de stock', short: 'Réservations non couvertes', low: "Sous le seuil d'alerte", unavailable: 'Tout est réservé ou hors disponibilité' };
router.get('/reports/stockouts', async (req, res) => {
  await W.expireReservations(req.org.id);
  const m = A.can(req, 'manager');
  const last = Object.fromEntries((await db.prepare('SELECT item_id, MAX(created_at) AS at FROM stock_moves WHERE org_id = ? GROUP BY item_id').all(req.org.id)).map((r) => [Number(r.item_id), String(r.at).slice(0, 10)]));
  const items = [];
  for (const it of await itemsOf(req)) {
    const av = await W.availability(it.id);
    const q = Number(it.quantity); const min = Number(it.min_quantity) || 0;
    let kind = null;
    if (q <= 0 && (min > 0 || av.reserved > 0 || last[it.id])) kind = 'out';
    else if (av.reserved > av.usable + 1e-9) kind = 'short';
    else if (q > 0 && av.available <= 1e-9) kind = 'unavailable';
    else if (min > 0 && q <= min) kind = 'low';
    if (kind) items.push({ itemId: Number(it.id), name: it.name, kind, kindLabel: STOCKOUT[kind], quantity: r3(q), reserved: av.reserved, available: av.available, unit: it.unit, lastMovement: last[it.id] || null, value: m ? value(it, q) : undefined });
  }
  const json = { counts: { out: items.filter((i) => i.kind === 'out').length, short: items.filter((i) => i.kind === 'short').length, low: items.filter((i) => i.kind === 'low').length, unavailable: items.filter((i) => i.kind === 'unavailable').length }, items };
  return sendMaybeCsv(req, res, json, 'ruptures-stock', [['Article', (i) => i.name], ['Situation', (i) => i.kindLabel], ['Quantité', (i) => i.quantity], ['Réservé', (i) => i.reserved], ['Disponible', (i) => i.available], ['Dernier mouvement', (i) => i.lastMovement || '']], items);
});
const BUCKETS = [[30, '0-30 jours'], [90, '31-90 jours'], [180, '91-180 jours'], [365, '181-365 jours'], [Infinity, "Plus d'un an"]];
router.get('/reports/aging', mgr, async (req, res) => {
  const items = [];
  const totals = BUCKETS.map(([, label]) => ({ label, value: 0 }));
  for (const it of await itemsOf(req)) {
    let left = Number(it.quantity);
    if (left <= 0) continue;
    const ins = await db.prepare('SELECT delta, created_at FROM stock_moves WHERE item_id = ? AND delta > 0 ORDER BY created_at DESC, id DESC').all(it.id);
    const b = BUCKETS.map(([, label]) => ({ label, quantity: 0 }));
    let oldest = null;
    for (const m of ins) {
      if (left <= 1e-9) break;
      const q = Math.min(left, Number(m.delta)); left -= q;
      const age = (Date.now() - Date.parse(m.created_at)) / DAY;
      b[BUCKETS.findIndex(([max]) => age <= max)].quantity += q;
      oldest = m.created_at.slice(0, 10);
    }
    if (left > 1e-9) b[b.length - 1].quantity += left; // stock plus ancien que l'historique
    b.forEach((x, i) => { x.quantity = r3(x.quantity); totals[i].value += value(it, x.quantity); });
    items.push({ itemId: Number(it.id), name: it.name, quantity: r3(Number(it.quantity)), oldestEntry: oldest, buckets: b, stockValue: value(it, it.quantity) });
  }
  const json = { buckets: totals, items: items.sort((a, b) => b.stockValue - a.stockValue) };
  return sendMaybeCsv(req, res, json, 'vieillissement-stock', [['Article', (i) => i.name], ['Quantité', (i) => i.quantity], ['Plus ancienne entrée', (i) => i.oldestEntry || ''], ...BUCKETS.map(([, label], k) => [label, (i) => i.buckets[k].quantity]), ['Valeur', (i) => i.stockValue]], json.items);
});
const REF_LABEL = { pur_receipt: 'Réception de commande', wms_receipt: 'Réception', delivery: 'Livraison', count: 'Inventaire', transfer: 'Transfert', return: 'Retour / rebut', reservation: 'Réservation livrée', pick: 'Liste de préparation', project: 'Projet', production: 'Production', maintenance: 'Maintenance', landed_cost: "Coût d'arrivée", hu: 'Palette ou colis', hu_item: 'Palette ou colis', wave: 'Vague de préparation', shipment: 'Expédition', replen: 'Réapprovisionnement', crossdock: 'Transbordement', kit_order: 'Assemblage de kits' };
const INTERNAL_LABEL = { internal: 'Déplacement', putaway: 'Déplacement', transfer_out: 'Transfert : sortie', transfer_in: 'Transfert : arrivée', transfer_cancel: 'Transfert annulé', return_restock: 'Retour remis en stock', hu_move: 'Déplacement de palette', wave_pick: 'Prélèvement en vague', pack: 'Emballage', replenish: 'Réapprovisionnement', unstage: 'Retour de dépose', ship_stage: 'Mise à quai', crossdock: 'Transbordement' };
router.get('/reports/moves', async (req, res) => {
  const q = req.query || {};
  const limit = Math.max(1, Math.min(1000, Number(q.limit) || 200));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? String(q.from) : '0000';
  const kind = ['in', 'out', 'internal'].includes(q.kind) ? q.kind : '';
  const m = A.can(req, 'manager');
  const out = [];
  if (kind !== 'internal') {
    const rows = await db.prepare(`SELECT sm.*, i.name, i.avg_cost, i.unit_cost, u.name AS who FROM stock_moves sm JOIN stock_items i ON i.id = sm.item_id LEFT JOIN users u ON u.id = sm.created_by
      WHERE sm.org_id = ? AND sm.delta != 0 AND sm.created_at >= ?${kind === 'in' ? ' AND sm.delta > 0' : kind === 'out' ? ' AND sm.delta < 0' : ''} ORDER BY sm.id DESC LIMIT ${limit}`).all(req.org.id, from);
    for (const r of rows) out.push({ key: `s${r.id}`, item: r.name, type: Number(r.delta) > 0 ? 'in' : 'out', label: Number(r.delta) > 0 ? 'Entrée' : 'Sortie', at: r.created_at, from: null, to: null, document: REF_LABEL[r.ref_kind] || null, reason: r.reason || null, by: r.who || null, quantity: r3(r.delta), value: m ? Math.round(Number(r.delta) * (r.unit_cost !== null && r.unit_cost !== undefined && Number(r.delta) > 0 ? Number(r.unit_cost) : L.unitValue(r))) : undefined });
  }
  if (!kind || kind === 'internal') {
    const rows = await db.prepare(`SELECT wm.*, i.name, i.avg_cost, i.unit_cost, f.code AS fc, t.code AS tc, u.name AS who FROM wms_moves wm JOIN stock_items i ON i.id = wm.item_id LEFT JOIN wms_locations f ON f.id = wm.from_location_id LEFT JOIN wms_locations t ON t.id = wm.to_location_id LEFT JOIN users u ON u.id = wm.created_by
      WHERE wm.org_id = ? AND wm.created_at >= ? ORDER BY wm.id DESC LIMIT ${limit}`).all(req.org.id, from);
    for (const r of rows) out.push({ key: `w${r.id}`, item: r.name, type: 'internal', label: INTERNAL_LABEL[r.kind] || 'Déplacement', at: r.created_at, from: r.fc || null, to: r.tc || null, document: REF_LABEL[r.ref_kind] || null, reason: r.reason || null, by: r.who || null, quantity: r3(r.quantity), value: m ? value(r, r.quantity) : undefined });
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  const moves = out.slice(0, limit);
  return sendMaybeCsv(req, res, { moves }, 'journal-mouvements', [['Date', (x) => x.at.replace('T', ' ').slice(0, 16)], ['Article', (x) => x.item], ['Type', (x) => x.label], ['Quantité', (x) => x.quantity], ['De', (x) => x.from || ''], ['Vers', (x) => x.to || ''], ['Origine', (x) => x.document || ''], ['Motif', (x) => x.reason || ''], ['Par', (x) => x.by || '']], moves);
});

module.exports = router;
module.exports.zOf = zOf;
