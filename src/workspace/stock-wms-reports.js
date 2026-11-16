'use strict';
// Stock WMS · lot 10 : états. Valorisation par entrepôt / emplacement, rotation, ruptures, vieillissement, journal des mouvements (stock + déplacements internes),
// exports CSV (séparateur « ; », virgule décimale, BOM : s'ouvre directement dans Excel), et résolution d'un code scanné (article, emplacement, liste, transfert…).
// La valeur totale du stock est celle qui alimente la comptabilité (acc-stock.js) : somme de tous les emplacements = quantité × coût moyen de chaque article.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const DAY = 86400000;
const NOT_CONSUMPTION = ['count', 'transfer', 'return', 'scrap'];
const REF_LABEL = { order: 'Réception de commande', delivery: 'Livraison', count: 'Inventaire', transfer: 'Transfert', return: 'Retour / rebut', reservation: 'Réservation livrée', pick: 'Préparation', receipt: 'Réception', landed_cost: "Coût d'arrivée", project: 'Projet', production: 'Production', maintenance: 'Maintenance' };
const MOVE_LABEL = { move: 'Déplacement', putaway: 'Rangement', transfer_out: 'Transfert : sortie', transfer_in: 'Transfert : arrivée', transfer_back: 'Transfert annulé', return_restock: 'Retour remis en stock' };
const r1 = (n) => Math.round(n * 10) / 10;

// ---------- CSV ----------
const cell = (v) => {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000).replace('.', ',')) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // une cellule ne doit jamais être lue comme une formule
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function csv(res, name, headers, rows) {
  const body = '﻿' + [headers.map(cell).join(';'), ...rows.map((r) => r.map(cell).join(';'))].join('\r\n') + '\r\n';
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}-${nowISO().slice(0, 10)}.csv"`, 'Cache-Control': 'private, no-store' });
  res.send(body);
}
const wantsCsv = (req) => String(req.query.format || '').toLowerCase() === 'csv';

// ---------- Valorisation ----------
router.get('/reports/valuation', A.need('manager'), async (req, res) => {
  await W.ensureDefault(req.org.id);
  const sc = A.scope(req, 'w.branch_id');
  const rows = await db.prepare(`SELECT w.id AS wid, w.name AS warehouse, l.id AS lid, l.code, l.kind, i.id AS iid, i.name, i.unit, v.quantity, i.avg_cost, i.unit_cost
    FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id JOIN wms_warehouses w ON w.id = l.warehouse_id JOIN stock_items i ON i.id = v.item_id
    WHERE v.org_id = ? AND v.quantity > 0${sc.sql} ORDER BY w.name, l.code, i.name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  const lines = rows.map((r) => ({ warehouseId: r.wid, warehouse: r.warehouse, locationId: r.lid, location: r.code, kind: r.kind, kindLabel: W.LOCATION_KINDS[r.kind], itemId: r.iid, item: r.name, unit: r.unit, quantity: r.quantity, unitValue: L.unitValue(r), value: Math.round(r.quantity * L.unitValue(r)) }));
  const total = lines.reduce((a, l) => a + l.value, 0);
  const by = (key, label) => { const m = new Map(); for (const l of lines) { const k = l[key]; const x = m.get(k) || { id: k, name: l[label], quantity: 0, value: 0 }; x.quantity = W.round3(x.quantity + l.quantity); x.value += l.value; m.set(k, x); } return [...m.values()]; };
  if (wantsCsv(req)) return csv(res, 'valorisation-stock', ['Entrepôt', 'Emplacement', 'Type', 'Article', 'Unité', 'Quantité', 'Valeur unitaire', 'Valeur'], lines.map((l) => [l.warehouse, l.location, l.kindLabel, l.item, l.unit, l.quantity, l.unitValue, l.value]));
  const sci = A.scope(req, 'i.branch_id');
  const items = await db.prepare(`SELECT COALESCE(SUM(i.quantity * CASE WHEN i.avg_cost > 0 THEN i.avg_cost ELSE i.unit_cost END), 0) v FROM stock_items i WHERE i.org_id = ?${sci.sql}`).get(req.org.id, ...sci.args);
  res.json({ totalValue: total, itemsValue: Math.round(Number(items.v)), warehouses: by('warehouseId', 'warehouse'), locations: by('locationId', 'location').map((x) => ({ ...x, kind: lines.find((l) => l.locationId === x.id).kind })), lines, note: 'Cette valeur est celle qui alimente la comptabilité (stock valorisé au coût moyen pondéré).' });
});

// ---------- Rotation ----------
router.get('/reports/rotation', A.need('manager'), async (req, res) => {
  const days = Math.min(Math.max(Math.round(Number(req.query.days)) || 365, 30), 1095);
  const since = new Date(Date.now() - days * DAY).toISOString();
  const sc = A.scope(req, 'i.branch_id');
  const items = await db.prepare(`SELECT i.* FROM stock_items i WHERE i.org_id = ?${sc.sql} ORDER BY i.name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  const out = new Map((await db.prepare(`SELECT item_id, SUM(-delta) q FROM stock_moves WHERE org_id = ? AND delta < 0 AND created_at >= ? AND ref_kind NOT IN (${NOT_CONSUMPTION.map(() => '?').join(',')}) GROUP BY item_id`).all(req.org.id, since, ...NOT_CONSUMPTION)).map((x) => [x.item_id, x.q]));
  const net = new Map((await db.prepare('SELECT item_id, SUM(delta) q FROM stock_moves WHERE org_id = ? AND created_at >= ? GROUP BY item_id').all(req.org.id, since)).map((x) => [x.item_id, x.q]));
  const rows = items.map((i) => {
    const uv = L.unitValue(i); const consumed = W.round3(out.get(i.id) || 0);
    const startQty = Math.max(W.round3(i.quantity - (net.get(i.id) || 0)), 0);
    const avgQty = (startQty + i.quantity) / 2;
    const rotation = avgQty > 0 ? consumed / avgQty : null;
    const daily = consumed / days;
    return { itemId: i.id, name: i.name, unit: i.unit, quantity: i.quantity, consumedQty: consumed, consumedValue: Math.round(consumed * uv), averageQty: W.round3(avgQty), stockValue: Math.round(i.quantity * uv),
      turnover: rotation === null ? null : r1(rotation * (365 / days) * 10) / 10, coverDays: daily > 0 ? r1(i.quantity / daily) : null, status: consumed <= 0 ? 'dormant' : rotation !== null && rotation * (365 / days) < 2 ? 'slow' : 'active' };
  }).sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  if (wantsCsv(req)) return csv(res, 'rotation-stock', ['Article', 'Unité', 'Quantité', 'Sorties', 'Valeur sorties', 'Stock moyen', 'Valeur du stock', 'Rotation annuelle', 'Jours de couverture', 'Statut'], rows.map((r) => [r.name, r.unit, r.quantity, r.consumedQty, r.consumedValue, r.averageQty, r.stockValue, r.turnover, r.coverDays, r.status]));
  res.json({ days, items: rows, dormant: rows.filter((r) => r.status === 'dormant' && r.quantity > 0).length, dormantValue: rows.filter((r) => r.status === 'dormant').reduce((a, r) => a + r.stockValue, 0) });
});

// ---------- Ruptures ----------
router.get('/reports/stockouts', async (req, res) => {
  const mgr = A.can(req, 'manager');
  const sc = A.scope(req, 'i.branch_id');
  const items = await db.prepare(`SELECT i.* FROM stock_items i WHERE i.org_id = ?${sc.sql} ORDER BY i.name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  const av = await W.availabilityMap(req.org.id);
  const last = new Map((await db.prepare('SELECT item_id, MAX(created_at) d FROM stock_moves WHERE org_id = ? AND delta <> 0 GROUP BY item_id').all(req.org.id)).map((x) => [x.item_id, x.d]));
  const lastOut = new Map((await db.prepare('SELECT item_id, MAX(created_at) d FROM stock_moves WHERE org_id = ? AND delta < 0 GROUP BY item_id').all(req.org.id)).map((x) => [x.item_id, x.d]));
  const rows = [];
  for (const i of items) {
    const a = av.get(i.id) || { available: 0, usable: 0, reserved: 0, short: 0 };
    let kind = null;
    if (i.quantity <= 0) kind = 'out';
    else if (a.short > 0) kind = 'short';
    else if (i.min_quantity > 0 && i.quantity <= i.min_quantity) kind = 'low';
    else if (a.available <= 0) kind = 'unavailable';
    if (!kind) continue;
    if (i.quantity <= 0 && !last.has(i.id) && !(i.min_quantity > 0)) continue; // article jamais mouvementé, sans seuil : pas une rupture
    const lo = lastOut.get(i.id);
    rows.push({ itemId: i.id, name: i.name, unit: i.unit, kind, kindLabel: { out: 'Rupture de stock', short: 'Réservations non couvertes', low: 'Sous le seuil d\'alerte', unavailable: 'Tout est réservé ou hors disponibilité' }[kind], quantity: i.quantity, usable: a.usable, reserved: a.reserved, available: a.available, minQuantity: i.min_quantity,
      lastMovement: last.get(i.id) ? last.get(i.id).slice(0, 10) : null, daysSinceLastOut: lo ? Math.floor((Date.now() - Date.parse(lo)) / DAY) : null, value: mgr ? Math.round(i.quantity * L.unitValue(i)) : undefined });
  }
  const order = { out: 0, short: 1, unavailable: 2, low: 3 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  if (wantsCsv(req)) return csv(res, 'ruptures-stock', ['Article', 'Unité', 'Situation', 'Quantité', 'Réservé', 'Disponible', 'Seuil', 'Dernier mouvement'], rows.map((r) => [r.name, r.unit, r.kindLabel, r.quantity, r.reserved, r.available, r.minQuantity, r.lastMovement]));
  res.json({ items: rows, counts: { out: rows.filter((r) => r.kind === 'out').length, short: rows.filter((r) => r.kind === 'short').length, low: rows.filter((r) => r.kind === 'low').length, unavailable: rows.filter((r) => r.kind === 'unavailable').length } });
});

// ---------- Vieillissement : à quelle date le stock actuel est-il entré ? (les entrées les plus récentes couvrent le stock d'abord) ----------
const BUCKETS = [[30, '0-30 jours'], [90, '31-90 jours'], [180, '91-180 jours'], [365, '181-365 jours'], [Infinity, 'Plus d\'un an']];
router.get('/reports/aging', A.need('manager'), async (req, res) => {
  const sc = A.scope(req, 'i.branch_id');
  const items = await db.prepare(`SELECT i.* FROM stock_items i WHERE i.org_id = ? AND i.quantity > 0${sc.sql} ORDER BY i.name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  const entries = await db.prepare('SELECT item_id, delta, created_at FROM stock_moves WHERE org_id = ? AND delta > 0 ORDER BY created_at DESC, id DESC').all(req.org.id);
  const by = new Map(); for (const e of entries) { if (!by.has(e.item_id)) by.set(e.item_id, []); by.get(e.item_id).push(e); }
  const now = Date.now();
  const totals = BUCKETS.map(([, label]) => ({ label, quantity: 0, value: 0 }));
  const rows = items.map((i) => {
    const uv = L.unitValue(i); let left = i.quantity; const bk = BUCKETS.map(() => 0); let oldest = null;
    for (const e of by.get(i.id) || []) {
      if (left <= 1e-9) break;
      const take = Math.min(left, e.delta); left = W.round3(left - take);
      const age = Math.floor((now - Date.parse(e.created_at)) / DAY);
      bk[BUCKETS.findIndex(([max]) => age <= max)] += take; oldest = e.created_at.slice(0, 10);
    }
    if (left > 1e-9) { bk[BUCKETS.length - 1] += left; oldest = oldest || null; } // reste sans date d'entrée connue : compté comme le plus ancien
    bk.forEach((q, k) => { totals[k].quantity = W.round3(totals[k].quantity + q); totals[k].value += Math.round(q * uv); });
    return { itemId: i.id, name: i.name, unit: i.unit, quantity: i.quantity, stockValue: Math.round(i.quantity * uv), oldestEntry: oldest, buckets: bk.map((q, k) => ({ label: BUCKETS[k][1], quantity: W.round3(q), value: Math.round(q * uv) })) };
  });
  if (wantsCsv(req)) return csv(res, 'vieillissement-stock', ['Article', 'Unité', 'Quantité', 'Valeur', 'Plus ancienne entrée', ...BUCKETS.map((b) => `${b[1]} (valeur)`)], rows.map((r) => [r.name, r.unit, r.quantity, r.stockValue, r.oldestEntry, ...r.buckets.map((b) => b.value)]));
  res.json({ buckets: totals, items: rows, totalValue: rows.reduce((a, r) => a + r.stockValue, 0) });
});

// ---------- Journal des mouvements (stock + déplacements internes) ----------
router.get('/reports/moves', async (req, res) => {
  const mgr = A.can(req, 'manager');
  const lim = Math.min(Math.max(Math.round(Number(req.query.limit)) || 100, 1), csvLimit(req));
  const off = Math.max(Math.round(Number(req.query.offset)) || 0, 0);
  const from = req.query.from ? `${A.date(req.query.from)}T00:00:00.000Z` : null; const to = req.query.to ? `${A.date(req.query.to)}T23:59:59.999Z` : null;
  const item = req.query.itemId ? A.id(req.query.itemId) : null; const loc = req.query.locationId ? A.id(req.query.locationId) : null;
  const kind = req.query.kind ? A.oneOf(req.query.kind, ['in', 'out', 'internal'], undefined, 'Type inconnu (entrée, sortie, interne).') : null;
  const sc = A.scope(req, 'i.branch_id');
  const f = (col) => `${from ? ` AND ${col} >= ?` : ''}${to ? ` AND ${col} <= ?` : ''}${item ? ' AND i.id = ?' : ''}`;
  const args = [...(from ? [from] : []), ...(to ? [to] : []), ...(item ? [item] : [])];
  const a1 = kind === 'internal' ? [] : await db.prepare(`SELECT m.id, m.delta, m.reason, m.created_at, m.ref_kind, m.ref_id, m.unit_cost, l.code AS location, u.name AS by_name, i.id AS iid, i.name, i.unit, i.avg_cost, i.unit_cost AS ucost
    FROM stock_moves m JOIN stock_items i ON i.id = m.item_id LEFT JOIN wms_locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.created_by
    WHERE m.org_id = ?${f('m.created_at')}${loc ? ' AND m.location_id = ?' : ''}${kind === 'in' ? ' AND m.delta > 0' : kind === 'out' ? ' AND m.delta < 0' : ''}${sc.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(req.org.id, ...args, ...(loc ? [loc] : []), ...sc.args, lim + off);
  const a2 = kind === 'in' || kind === 'out' ? [] : await db.prepare(`SELECT m.id, m.quantity, m.reason, m.created_at, m.kind, m.ref_kind, m.ref_id, m.unit_value, fl.code AS from_code, tl.code AS to_code, u.name AS by_name, i.id AS iid, i.name, i.unit
    FROM wms_moves m JOIN stock_items i ON i.id = m.item_id LEFT JOIN wms_locations fl ON fl.id = m.from_location_id LEFT JOIN wms_locations tl ON tl.id = m.to_location_id LEFT JOIN users u ON u.id = m.created_by
    WHERE m.org_id = ?${f('m.created_at')}${loc ? ' AND (m.from_location_id = ? OR m.to_location_id = ?)' : ''}${sc.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(req.org.id, ...args, ...(loc ? [loc, loc] : []), ...sc.args, lim + off);
  const all = [
    ...a1.map((m) => ({ at: m.created_at, key: `s${m.id}`, type: m.delta === 0 ? 'value' : m.delta > 0 ? 'in' : 'out', label: m.delta === 0 ? "Coût d'arrivée" : m.delta > 0 ? 'Entrée' : 'Sortie', itemId: m.iid, item: m.name, unit: m.unit, quantity: m.delta, from: m.delta < 0 ? m.location : null, to: m.delta > 0 ? m.location : null, reason: m.reason, document: REF_LABEL[m.ref_kind] || (m.ref_kind || ''), documentId: m.ref_id, by: m.by_name, value: mgr ? Math.round(Math.abs(m.delta) * (Number(m.avg_cost) > 0 ? Number(m.avg_cost) : Number(m.ucost) || 0)) : undefined })),
    ...a2.map((m) => ({ at: m.created_at, key: `w${m.id}`, type: 'internal', label: MOVE_LABEL[m.kind] || 'Déplacement', itemId: m.iid, item: m.name, unit: m.unit, quantity: m.quantity, from: m.from_code, to: m.to_code, reason: m.reason, document: REF_LABEL[m.ref_kind] || '', documentId: m.ref_id, by: m.by_name, value: mgr ? Math.round(m.quantity * m.unit_value) : undefined })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key));
  const page = all.slice(off, off + lim);
  if (wantsCsv(req)) return csv(res, 'journal-mouvements', ['Date', 'Type', 'Article', 'Unité', 'Quantité', 'De', 'Vers', 'Document', 'Motif', 'Par', ...(mgr ? ['Valeur'] : [])], page.map((m) => [m.at.replace('T', ' ').slice(0, 19), m.label, m.item, m.unit, m.quantity, m.from, m.to, m.document, m.reason, m.by, ...(mgr ? [m.value] : [])]));
  res.json({ moves: page, count: page.length, hasMore: all.length > off + lim });
});
function csvLimit(req) { return wantsCsv(req) ? 5000 : 500; }

// ---------- Que veut dire ce code scanné ? ----------
router.get('/scan', async (req, res) => {
  const code = A.text(req.query.code, 60, { required: true, msg: 'Aucun code lu.' });
  const up = code.toUpperCase();
  const it = await db.prepare('SELECT * FROM stock_items WHERE org_id = ? AND (barcode = ? OR sku = ?)').get(req.org.id, code, code);
  if (it && A.visible(req, it)) return res.json({ type: 'item', id: it.id, label: it.name, code });
  const loc = await db.prepare('SELECT l.*, w.branch_id AS branch_id FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE l.org_id = ? AND l.code = ?').get(req.org.id, up);
  if (loc && A.visible(req, loc)) return res.json({ type: 'location', id: loc.id, label: loc.name || loc.code, code: loc.code });
  const docs = [['PREP-', 'pick', 'wms_picks'], ['TR-', 'transfer', 'wms_transfers'], ['RET-', 'return', 'wms_returns'], ['REC-', 'receipt', 'wms_receipts']];
  for (const [prefix, type, table] of docs) {
    if (!up.startsWith(prefix)) continue;
    const d = await db.prepare(`SELECT id, code FROM ${table} WHERE org_id = ? AND code = ?`).get(req.org.id, up);
    if (d) return res.json({ type, id: d.id, label: d.code, code: d.code });
  }
  throw new HttpError(404, 'Code inconnu : ni article, ni emplacement, ni document.');
});

module.exports = router;
