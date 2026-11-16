'use strict';
// Stock entrepôt (WMS) — structure : entrepôts, zones, emplacements, stock par emplacement, déplacements, rangement, réglages, scan.
// Les flux (transferts, réservations, préparation, retours), les réceptions avec coûts d'arrivée et les analyses sont dans wms-flows, wms-receipts, wms-analytics.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const L = require('./stock-lib');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;

router.use(async (req, res, next) => { await W.ensure(req.org.id); next(); });

// ---------- Saisie ----------
function qty(v) {
  const n = Number(String(v === undefined || v === null ? '' : v).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw new HttpError(400, 'Quantité invalide : indiquez un nombre positif.');
  return r3(n);
}
const optNum = (v, { min = 0, max = 1e9, int = false, msg = 'Valeur invalide.' } = {}) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new HttpError(400, msg);
  return n;
};
const codeOf = (s, max = 30) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
async function itemOf(req, idv) {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  return it;
}
async function warehouseOf(req, idv) {
  const w = await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(idv, 'Choisissez un entrepôt.'), req.org.id);
  if (!w) throw new HttpError(404, 'Entrepôt introuvable.');
  return w;
}
const unitValue = (it) => L.unitValue(it);

// ---------- Vues ----------
async function locationRows(orgId, warehouseId) {
  return db.prepare(`SELECT l.*, w.name AS warehouse, z.name AS zone,
      (SELECT COUNT(*) FROM wms_stock s WHERE s.location_id = l.id AND s.quantity > 0) AS n_items,
      (SELECT COALESCE(SUM(s.quantity), 0) FROM wms_stock s WHERE s.location_id = l.id) AS qty,
      (SELECT COALESCE(SUM(s.quantity * CASE WHEN i.avg_cost > 0 THEN i.avg_cost ELSE i.unit_cost END), 0) FROM wms_stock s JOIN stock_items i ON i.id = s.item_id WHERE s.location_id = l.id) AS val
    FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id LEFT JOIN wms_zones z ON z.id = l.zone_id
    WHERE l.org_id = ?${warehouseId ? ' AND l.warehouse_id = ?' : ''} ORDER BY w.is_default DESC, w.name, l.aisle, l.rack, l.bin, l.code`).all(orgId, ...(warehouseId ? [warehouseId] : []));
}
const locView = (l, m) => ({
  id: Number(l.id), code: l.code, name: l.name || l.code, kind: l.kind, kindLabel: W.KINDS[l.kind], warehouse: l.warehouse, zone: l.zone || null,
  active: Boolean(Number(l.active)), usable: W.isUsable(l), capacity: l.capacity === null || l.capacity === undefined ? null : Number(l.capacity),
  items: Number(l.n_items) || 0, quantity: r3(Number(l.qty) || 0), value: m ? Math.round(Number(l.val) || 0) : undefined, isDefault: Boolean(Number(l.is_default)),
  aisle: l.aisle || '', rack: l.rack || '', bin: l.bin || '',
});

router.get('/overview', async (req, res) => {
  const m = A.can(req, 'manager');
  const whs = await db.prepare('SELECT w.*, b.name AS branch FROM wms_warehouses w LEFT JOIN branches b ON b.id = w.branch_id WHERE w.org_id = ? ORDER BY w.is_default DESC, w.name').all(req.org.id);
  const out = [];
  for (const w of whs) {
    const locs = await locationRows(req.org.id, w.id);
    const zones = Number((await db.prepare('SELECT COUNT(*) AS c FROM wms_zones WHERE warehouse_id = ?').get(w.id)).c);
    out.push({ id: Number(w.id), name: w.name, code: w.code, branch: w.branch || null, isDefault: Boolean(Number(w.is_default)), active: Boolean(Number(w.active)), address: w.address,
      zones, locations: locs.length, quantity: r3(locs.reduce((s, l) => s + Number(l.qty), 0)), value: m ? Math.round(locs.reduce((s, l) => s + Number(l.val), 0)) : undefined });
  }
  res.json({ warehouses: out, kinds: W.KINDS, zoneKinds: W.ZONE_KINDS });
});

// ---------- Entrepôts ----------
async function uniqueLocCode(orgId, base) {
  let code = base; let n = 2;
  while (await db.prepare('SELECT 1 FROM wms_locations WHERE org_id = ? AND code = ?').get(orgId, code)) code = `${base}-${n++}`;
  return code;
}
router.post('/warehouses', mgr, async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 80, { required: true, msg: "Indiquez le nom de l'entrepôt." });
  const code = b.code ? codeOf(b.code, 20) : codeOf(name, 12) || 'ENT';
  if (!code) throw new HttpError(400, "Code d'entrepôt invalide : lettres et chiffres.");
  if (await db.prepare('SELECT 1 FROM wms_warehouses WHERE org_id = ? AND code = ?').get(req.org.id, code)) throw new HttpError(409, "Ce code d'entrepôt existe déjà.");
  const branch = b.branchId === undefined || b.branchId === '' ? null : await A.branchOf(req, b.branchId);
  const now = nowISO();
  const id = await db.transaction(async () => {
    const wid = Number((await db.prepare('INSERT INTO wms_warehouses (org_id, name, code, branch_id, address, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, name, code, branch, cleanText(String(b.address || ''), 200), now)).lastInsertRowid);
    const lc = await uniqueLocCode(req.org.id, `${code}-PRINC`);
    const r = await db.prepare("INSERT INTO wms_locations (org_id, warehouse_id, code, name, kind, is_default, created_at) VALUES (?, ?, ?, 'Principal', 'storage', 1, ?)").run(req.org.id, wid, lc, now);
    if (!r.lastInsertRowid) throw new HttpError(500, "L'emplacement par défaut n'a pas pu être créé : réessayez.");
    return wid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Entrepôt « ${name} » créé`);
  res.status(201).json({ id, code });
});
router.put('/warehouses/:id', mgr, async (req, res) => {
  const w = await warehouseOf(req, req.params.id);
  const b = req.body || {};
  const active = b.active === undefined ? Number(w.active) : (b.active ? 1 : 0);
  if (!active && Number(w.is_default)) throw new HttpError(400, "L'entrepôt principal ne peut pas être désactivé.");
  await db.prepare('UPDATE wms_warehouses SET name = ?, address = ?, active = ? WHERE id = ?').run(b.name === undefined ? w.name : A.text(b.name, 80, { required: true, msg: "Indiquez le nom de l'entrepôt." }), b.address === undefined ? w.address : cleanText(String(b.address || ''), 200), active, w.id);
  res.json({ ok: true });
});
router.delete('/warehouses/:id', mgr, async (req, res) => {
  const w = await warehouseOf(req, req.params.id);
  if (Number(w.is_default)) throw new HttpError(400, "L'entrepôt principal ne peut pas être supprimé.");
  if (await db.prepare('SELECT 1 FROM wms_transfers WHERE from_warehouse_id = ? OR to_warehouse_id = ? LIMIT 1').get(w.id, w.id)) throw new HttpError(400, "Cet entrepôt a des transferts dans l'historique : désactivez-le plutôt que de le supprimer.");
  const q = Number((await db.prepare('SELECT COALESCE(SUM(s.quantity), 0) AS q FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE l.warehouse_id = ?').get(w.id)).q);
  if (q > W.EPS) throw new HttpError(400, 'Cet entrepôt contient encore du stock : déplacez-le avant de le supprimer.');
  await db.prepare('DELETE FROM wms_warehouses WHERE id = ?').run(w.id);
  res.json({ ok: true });
});

// ---------- Zones ----------
router.get('/zones', async (req, res) => {
  const rows = await db.prepare('SELECT z.*, w.name AS warehouse FROM wms_zones z JOIN wms_warehouses w ON w.id = z.warehouse_id WHERE z.org_id = ? ORDER BY w.name, z.name').all(req.org.id);
  res.json({ zones: rows.map((z) => ({ id: Number(z.id), name: z.name, code: z.code, kind: z.kind, warehouseId: Number(z.warehouse_id), warehouse: z.warehouse })) });
});
router.post('/zones', mgr, async (req, res) => {
  const b = req.body || {};
  const w = await warehouseOf(req, b.warehouseId);
  const name = A.text(b.name, 60, { required: true, msg: 'Indiquez le nom de la zone.' });
  const code = codeOf(b.code || name, 20) || 'ZONE';
  const kind = W.ZONE_KINDS[b.kind] ? b.kind : 'storage';
  if (await db.prepare('SELECT 1 FROM wms_zones WHERE warehouse_id = ? AND code = ?').get(w.id, code)) throw new HttpError(409, 'Ce code de zone existe déjà dans cet entrepôt.');
  const id = Number((await db.prepare('INSERT INTO wms_zones (org_id, warehouse_id, name, code, kind) VALUES (?, ?, ?, ?, ?)').run(req.org.id, w.id, name, code, kind)).lastInsertRowid);
  res.status(201).json({ id });
});
async function zoneFor(req, w, zv) {
  if (zv === undefined || zv === null || zv === '') return null;
  const z = await db.prepare('SELECT * FROM wms_zones WHERE id = ? AND org_id = ?').get(A.id(zv), req.org.id);
  if (!z) throw new HttpError(404, 'Zone introuvable.');
  if (Number(z.warehouse_id) !== Number(w.id)) throw new HttpError(400, 'Cette zone ne fait pas partie de cet entrepôt.');
  return z;
}

// ---------- Emplacements ----------
router.get('/locations', async (req, res) => {
  const wid = req.query.warehouseId ? A.id(req.query.warehouseId) : null;
  res.json({ locations: (await locationRows(req.org.id, wid)).map((l) => locView(l, A.can(req, 'manager'))) });
});
router.get('/locations/lookup', async (req, res) => {
  const code = cleanText(String(req.query.code || ''), 60);
  const l = code ? await db.prepare('SELECT id, code FROM wms_locations WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, code) : null;
  if (!l) throw new HttpError(404, 'Aucun emplacement avec ce code.');
  res.json({ location: { id: Number(l.id), code: l.code } });
});
const capacityOf = (v) => optNum(v, { min: 0, max: 1e9, msg: 'Capacité invalide.' });
router.post('/locations', mgr, async (req, res) => {
  const b = req.body || {};
  const w = await warehouseOf(req, b.warehouseId);
  if (!Number(w.active)) throw new HttpError(400, 'Cet entrepôt est désactivé.');
  const kind = W.KINDS[b.kind] && b.kind !== 'transit' ? b.kind : 'storage';
  const aisle = codeOf(b.aisle, 10); const rack = codeOf(b.rack, 10); const bin = codeOf(b.bin, 10);
  const code = b.code ? codeOf(b.code, 30) : [aisle, rack, bin].filter(Boolean).join('-');
  if (!code) throw new HttpError(400, 'Indiquez un code ou une position (allée, rayon, bac).');
  if (await db.prepare('SELECT 1 FROM wms_locations WHERE org_id = ? AND code = ?').get(req.org.id, code)) throw new HttpError(409, "Ce code d'emplacement existe déjà (il doit être unique dans l'organisation pour être scanné).");
  const z = await zoneFor(req, w, b.zoneId);
  const id = Number((await db.prepare('INSERT INTO wms_locations (org_id, warehouse_id, zone_id, code, name, kind, aisle, rack, bin, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, w.id, z ? z.id : null, code, cleanText(String(b.name || ''), 60) || code, kind, aisle, rack, bin, capacityOf(b.capacity), nowISO())).lastInsertRowid);
  res.status(201).json({ id, code });
});
router.post('/locations/bulk', mgr, async (req, res) => {
  const b = req.body || {};
  const w = await warehouseOf(req, b.warehouseId);
  if (!Number(w.active)) throw new HttpError(400, 'Cet entrepôt est désactivé.');
  const aisles = [...new Set(String(b.aisles || '').split(/[,;\s]+/).map((x) => codeOf(x, 10)).filter(Boolean))];
  const racks = Number(b.racks); const bins = Number(b.bins);
  if (!aisles.length || !Number.isInteger(racks) || racks < 1 || !Number.isInteger(bins) || bins < 1) throw new HttpError(400, 'Indiquez les allées (A, B…), le nombre de rayons et de bacs.');
  if (aisles.length * racks * bins > 300) throw new HttpError(400, '300 emplacements au plus par création en série.');
  const z = await zoneFor(req, w, b.zoneId);
  const cap = capacityOf(b.capacity);
  const kind = W.KINDS[b.kind] && b.kind !== 'transit' ? b.kind : 'storage';
  let created = 0; let skipped = 0; const now = nowISO();
  await db.transaction(async () => {
    for (const a of aisles) for (let r = 1; r <= racks; r++) for (let x = 1; x <= bins; x++) {
      const rk = String(r).padStart(2, '0'); const bn = String(x).padStart(2, '0');
      const code = `${a}-${rk}-${bn}`;
      if (await db.prepare('SELECT 1 FROM wms_locations WHERE org_id = ? AND code = ?').get(req.org.id, code)) { skipped++; continue; }
      await db.prepare('INSERT INTO wms_locations (org_id, warehouse_id, zone_id, code, name, kind, aisle, rack, bin, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, w.id, z ? z.id : null, code, code, kind, a, rk, bn, cap, now);
      created++;
    }
  })();
  res.status(201).json({ created, skipped });
});
router.get('/locations/:id', async (req, res) => {
  const [l] = (await locationRows(req.org.id)).filter((x) => Number(x.id) === A.id(req.params.id));
  if (!l) throw new HttpError(404, 'Emplacement introuvable.');
  const m = A.can(req, 'manager');
  const rows = await db.prepare('SELECT i.*, s.quantity AS loc_qty FROM wms_stock s JOIN stock_items i ON i.id = s.item_id WHERE s.location_id = ? AND s.quantity > 0 ORDER BY i.name').all(l.id);
  const v = locView(l, m);
  res.json({
    location: { id: v.id, code: v.code, name: v.name, kind: v.kind, kindLabel: v.kindLabel, warehouse: v.warehouse, zone: v.zone, capacity: v.capacity, active: v.active, isDefault: v.isDefault, usable: v.usable, quantity: v.quantity },
    content: rows.map((r) => ({ itemId: Number(r.id), name: r.name, sku: r.sku || '', quantity: r3(Number(r.loc_qty)), unit: r.unit, value: m ? Math.round(Number(r.loc_qty) * unitValue(r)) : undefined })),
  });
});
router.put('/locations/:id', mgr, async (req, res) => {
  const l = await W.locationOf(req.org.id, A.id(req.params.id));
  if (l.kind === 'transit') throw new HttpError(400, "L'emplacement « En transit » est géré par les transferts.");
  const b = req.body || {};
  const active = b.active === undefined ? Number(l.active) : (b.active ? 1 : 0);
  if (!active && Number(l.is_default)) throw new HttpError(400, "L'emplacement par défaut ne peut pas être désactivé.");
  const capacity = b.capacity === undefined ? l.capacity : capacityOf(b.capacity);
  await db.prepare('UPDATE wms_locations SET name = ?, capacity = ?, active = ? WHERE id = ?').run(b.name === undefined ? l.name : cleanText(String(b.name || ''), 60) || l.code, capacity, active, l.id);
  res.json({ ok: true });
});
router.delete('/locations/:id', mgr, async (req, res) => {
  const l = await W.locationOf(req.org.id, A.id(req.params.id));
  if (Number(l.is_default) || ['transit', 'quarantine', 'returns'].includes(l.kind) && ['TRANSIT', 'QUARANTAINE', 'RETOURS'].includes(l.code)) throw new HttpError(400, 'Cet emplacement est indispensable : il ne peut pas être supprimé.');
  if (await W.locTotal(l.id) > W.EPS) throw new HttpError(400, 'Cet emplacement contient du stock : déplacez-le avant de le supprimer.');
  await db.prepare('DELETE FROM wms_locations WHERE id = ?').run(l.id);
  res.json({ ok: true });
});

// ---------- Stock d'un article par emplacement ----------
async function levelsOf(req, it) {
  const m = A.can(req, 'manager');
  const rows = await db.prepare('SELECT s.quantity, l.id, l.code, l.kind, l.active, w.name AS warehouse FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE s.item_id = ? AND s.quantity > 0 ORDER BY w.is_default DESC, l.code').all(it.id);
  return rows.map((r) => ({ locationId: Number(r.id), code: r.code, kind: r.kind, kindLabel: W.KINDS[r.kind], warehouse: r.warehouse, usable: W.isUsable(r), quantity: r3(Number(r.quantity)), value: m ? Math.round(Number(r.quantity) * unitValue(it)) : undefined }));
}
router.get('/items/:id/levels', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  res.json({ quantity: r3(Number(it.quantity)), usable: await W.usableOf(it.id), unit: it.unit, levels: await levelsOf(req, it) });
});
router.get('/items/:id/availability', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  await W.expireReservations(req.org.id);
  const a = await W.availability(it.id);
  res.json({ quantity: r3(Number(it.quantity)), usable: a.usable, reserved: a.reserved, available: a.available, unit: it.unit });
});
router.get('/availability', async (req, res) => {
  await W.expireReservations(req.org.id);
  const items = await db.prepare("SELECT DISTINCT item_id FROM wms_reservations WHERE org_id = ? AND status = 'active'").all(req.org.id);
  let short = 0;
  for (const x of items) if ((await W.availability(Number(x.item_id))).available < -W.EPS) short++;
  res.json({ reservedItems: items.length, shortItems: short });
});

// ---------- Déplacement entre emplacements ----------
router.post('/move', async (req, res) => {
  const b = req.body || {};
  const it = await itemOf(req, b.itemId);
  const q = qty(b.quantity);
  const r = await db.transaction(() => W.move(req, it.id, A.id(b.fromLocationId, 'Emplacement introuvable.'), A.id(b.toLocationId, 'Emplacement introuvable.'), q, { reason: cleanText(String(b.reason || ''), 150) }))();
  res.json({ ok: true, from: r.from.code, to: r.to.code, quantity: r.quantity });
});

// ---------- Rangement ----------
router.get('/putaway/pending', async (req, res) => {
  const rows = await db.prepare(`SELECT s.item_id, s.quantity, l.id AS lid, l.code, l.warehouse_id, i.name, i.unit, i.tracking FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id JOIN stock_items i ON i.id = s.item_id
    WHERE s.org_id = ? AND l.kind = 'reception' AND s.quantity > 0 ORDER BY l.code, i.name`).all(req.org.id);
  const tasks = [];
  for (const r of rows) {
    const p = await W.putawayPlan(req.org.id, { id: r.item_id, tracking: r.tracking }, Number(r.quantity), { exclude: r.lid });
    tasks.push({ itemId: Number(r.item_id), fromLocationId: Number(r.lid), from: r.code, name: r.name, quantity: r3(Number(r.quantity)), unit: r.unit, suggestion: p.plan.map((x) => ({ locationId: Number(x.location.id), code: x.location.code, quantity: x.quantity })) });
  }
  res.json({ tasks });
});
router.post('/putaway', async (req, res) => {
  const b = req.body || {};
  const it = await itemOf(req, b.itemId);
  const from = await W.locationOf(req.org.id, A.id(b.fromLocationId, 'Emplacement introuvable.'));
  const q = await W.qtyAt(from.id, it.id);
  if (q <= W.EPS) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  await db.transaction(async () => {
    if (b.toLocationId) { await W.move(req, it.id, from.id, A.id(b.toLocationId), q, { kind: 'putaway', reason: 'Rangement' }); return; }
    const p = await W.putawayPlan(req.org.id, it, q, { exclude: from.id });
    if (!p.plan.length) throw new HttpError(400, 'Aucune règle de rangement ne désigne un autre emplacement : choisissez la destination.');
    for (const x of p.plan) await W.move(req, it.id, from.id, x.location.id, x.quantity, { kind: 'putaway', reason: 'Rangement' });
  })();
  res.json({ ok: true });
});
router.get('/putaway-rules', async (req, res) => {
  const rows = await db.prepare('SELECT r.*, i.name AS item, l.code FROM wms_putaway_rules r LEFT JOIN stock_items i ON i.id = r.item_id JOIN wms_locations l ON l.id = r.location_id WHERE r.org_id = ? ORDER BY r.priority, r.id').all(req.org.id);
  res.json({ rules: rows.map((r) => ({ id: Number(r.id), itemId: r.item_id ? Number(r.item_id) : null, item: r.item || null, tracking: r.item_id ? null : r.tracking, locationId: Number(r.location_id), location: r.code, priority: Number(r.priority) })) });
});
router.post('/putaway-rules', mgr, async (req, res) => {
  const b = req.body || {};
  const it = b.itemId !== undefined && b.itemId !== null && b.itemId !== '' ? await itemOf(req, b.itemId) : null;
  const tracking = it ? null : (L.TRACKING.includes(b.tracking) ? b.tracking : null);
  if (!it && !tracking) throw new HttpError(400, 'Une règle vise un article ou un type de suivi (lot, numéro de série).');
  const l = await W.locationOf(req.org.id, A.id(b.locationId, 'Emplacement introuvable.'));
  if (!W.isUsable(l)) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
  const priority = optNum(b.priority === undefined || b.priority === '' ? 100 : b.priority, { min: 1, max: 9999, int: true, msg: 'Priorité : un nombre entier de 1 à 9999.' });
  const id = Number((await db.prepare('INSERT INTO wms_putaway_rules (org_id, item_id, tracking, location_id, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, it ? it.id : null, tracking, l.id, priority, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.delete('/putaway-rules/:id', mgr, async (req, res) => {
  const r = await db.prepare('DELETE FROM wms_putaway_rules WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Règle introuvable.');
  res.json({ ok: true });
});

// ---------- Réglages (ABC, inventaire tournant, prévisions) ----------
router.get('/settings', async (req, res) => res.json({ settings: await W.settingsOf(req.org.id) }));
router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const cur = await W.settingsOf(req.org.id);
  const spec = { abcA: [1, 99], abcB: [2, 100], abcDays: [30, 730], cycleA: [1, 365], cycleB: [1, 365], cycleC: [1, 730], forecastWeeks: [4, 52], serviceLevel: [50, 99.9], defaultLeadDays: [0, 365], reviewDays: [0, 90] };
  const next = { ...cur };
  for (const [k, [mn, mx]] of Object.entries(spec)) if (b[k] !== undefined && b[k] !== '') next[k] = optNum(b[k], { min: mn, max: mx, msg: `Valeur invalide pour ${k} (entre ${mn} et ${mx}).` });
  if (next.abcA >= next.abcB) throw new HttpError(400, 'Le seuil A doit être plus petit que le seuil B.');
  await db.prepare('UPDATE wms_settings SET data = ? WHERE org_id = ?').run(JSON.stringify(next), req.org.id);
  res.json({ ok: true, settings: next });
});

// ---------- Paramètres de réapprovisionnement d'un article ----------
router.get('/items/:id/params', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const p = await db.prepare('SELECT * FROM wms_item_params WHERE item_id = ?').get(it.id) || {};
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  res.json({ params: { leadDays: n(p.lead_days), safetyStock: n(p.safety_stock), reorderPoint: n(p.reorder_point), orderMultiple: n(p.order_multiple) } });
});
router.put('/items/:id/params', mgr, async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const b = req.body || {};
  const lead = optNum(b.leadDays, { min: 0, max: 365, int: true, msg: 'Délai fournisseur : un nombre entier de jours (0 à 365).' });
  const safety = optNum(b.safetyStock, { msg: 'Stock de sécurité invalide.' });
  const rop = optNum(b.reorderPoint, { msg: 'Point de commande invalide.' });
  const mult = optNum(b.orderMultiple, { min: 0, msg: 'Multiple de commande invalide.' });
  await db.prepare('INSERT INTO wms_item_params (item_id, org_id, lead_days, safety_stock, reorder_point, order_multiple) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET lead_days = excluded.lead_days, safety_stock = excluded.safety_stock, reorder_point = excluded.reorder_point, order_multiple = excluded.order_multiple')
    .run(it.id, req.org.id, lead, safety, rop, mult || null);
  res.json({ ok: true });
});

// ---------- Scan : un code, quel qu'il soit ----------
router.get('/scan', async (req, res) => {
  const code = cleanText(String(req.query.code || ''), 60);
  if (!code) throw new HttpError(404, 'Code inconnu : ni article, ni emplacement, ni document.');
  const it = await db.prepare('SELECT * FROM stock_items WHERE org_id = ? AND (barcode = ? OR sku = ?)').get(req.org.id, code, code);
  if (it && A.visible(req, it)) return res.json({ type: 'item', id: Number(it.id), label: it.name });
  const l = await db.prepare('SELECT * FROM wms_locations WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, code);
  if (l) return res.json({ type: 'location', id: Number(l.id), label: l.code });
  for (const [type, table] of [['pick', 'wms_picks'], ['transfer', 'wms_transfers'], ['return', 'wms_returns'], ['receipt', 'wms_receipts']]) {
    const x = await db.prepare(`SELECT id, code FROM ${table} WHERE org_id = ? AND UPPER(code) = UPPER(?)`).get(req.org.id, code);
    if (x) return res.json({ type, id: Number(x.id), label: x.code });
  }
  throw new HttpError(404, 'Code inconnu : ni article, ni emplacement, ni document.');
});

router.use('/', require('./wms-flows'));
router.use('/', require('./wms-receipts'));
router.use('/', require('./wms-analytics'));

module.exports = { router, itemOf, qty, optNum, levelsOf };
