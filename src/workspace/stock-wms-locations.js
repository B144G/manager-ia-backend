'use strict';
// Stock WMS · lot 1 : entrepôts → zones → emplacements (allée / rayon / bac), stock par emplacement, déplacements internes, règles de rangement.
// La quantité d'un article reste la somme de ses emplacements (voir wms-lib.js). Lecture : tout membre ; structure et règles : responsable ;
// déplacer du stock d'un emplacement à l'autre : tout membre (c'est le geste du magasinier).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgrOf = (req) => A.can(req, 'manager');
const code = (v, label, req_ = true) => {
  const c = String(v === undefined || v === null ? '' : v).trim().toUpperCase().replace(/\s+/g, '-');
  if (!c) { if (req_) throw new HttpError(400, `Indiquez le code ${label}.`); return ''; }
  if (!/^[A-Z0-9][A-Z0-9._\/-]{0,29}$/.test(c)) throw new HttpError(400, `Code ${label} invalide : lettres, chiffres, tirets et points (30 caractères au plus).`);
  return c;
};
const part = (v) => A.text(v, 12).toUpperCase();

const itemOf = async (req, id) => {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(id, 'Article invalide.'), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  return it;
};
const whOf = async (req, id) => {
  const w = await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(id, 'Entrepôt invalide.'), req.org.id);
  if (!w || !A.visible(req, w)) throw new HttpError(404, 'Entrepôt introuvable.');
  return w;
};

// ---------- Vue d'ensemble ----------
router.get('/overview', async (req, res) => {
  await W.ensureDefault(req.org.id);
  const sc = A.scope(req, 'w.branch_id');
  const mgr = mgrOf(req);
  const rows = await db.prepare(`SELECT w.*, b.name AS branch,
      (SELECT COUNT(*) FROM wms_zones z WHERE z.warehouse_id = w.id) AS zones,
      (SELECT COUNT(*) FROM wms_locations l WHERE l.warehouse_id = w.id AND l.kind <> 'transit') AS locations,
      (SELECT COALESCE(SUM(v.quantity), 0) FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id WHERE l.warehouse_id = w.id) AS quantity,
      (SELECT COALESCE(SUM(v.quantity * CASE WHEN i.avg_cost > 0 THEN i.avg_cost ELSE i.unit_cost END), 0) FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id JOIN stock_items i ON i.id = v.item_id WHERE l.warehouse_id = w.id) AS value
    FROM wms_warehouses w LEFT JOIN branches b ON b.id = w.branch_id WHERE w.org_id = ?${sc.sql} ORDER BY w.is_default DESC, w.name`).all(req.org.id, ...sc.args);
  res.json({ warehouses: rows.map((w) => ({ id: w.id, code: w.code, name: w.name, address: w.address, branchId: w.branch_id, branch: w.branch, isDefault: Boolean(w.is_default), active: Boolean(w.active), zones: w.zones, locations: w.locations, quantity: W.round3(w.quantity), value: mgr ? Math.round(w.value) : undefined })),
    kinds: W.LOCATION_KINDS, zoneKinds: W.ZONE_KINDS });
});

// ---------- Entrepôts ----------
router.post('/warehouses', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'entrepôt." });
  const c = code(b.code || name.slice(0, 12), "de l'entrepôt");
  if (await db.prepare('SELECT 1 FROM wms_warehouses WHERE org_id = ? AND code = ?').get(req.org.id, c)) throw new HttpError(409, 'Ce code d\'entrepôt existe déjà.');
  const id = Number((await db.prepare('INSERT INTO wms_warehouses (org_id, branch_id, code, name, address, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, await A.branchOf(req, b.branchId), c, name, A.text(b.address, 200), nowISO())).lastInsertRowid);
  await db.prepare("INSERT INTO wms_locations (org_id, warehouse_id, code, name, kind, created_at) VALUES (?, ?, ?, 'Réception', 'reception', ?) ON CONFLICT DO NOTHING").run(req.org.id, id, `${c}-RECEPTION`.slice(0, 30), nowISO()); // emplacement d'arrivée par défaut
  await A.logActivity(req.org.id, req.user.id, 'stock', `Entrepôt « ${name} » créé`);
  res.status(201).json({ id });
});
router.put('/warehouses/:id', A.need('manager'), async (req, res) => {
  const w = await whOf(req, req.params.id);
  const b = req.body || {};
  const active = b.active === undefined ? w.active : b.active ? 1 : 0;
  if (!active && w.active) {
    if (w.is_default) throw new HttpError(400, "L'entrepôt principal ne peut pas être désactivé.");
    const left = (await db.prepare('SELECT COALESCE(SUM(v.quantity), 0) q FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id WHERE l.warehouse_id = ?').get(w.id)).q;
    if (left > 0) throw new HttpError(409, `Cet entrepôt contient encore du stock (${W.round3(left)}) : transférez-le avant de le désactiver.`);
  }
  await db.prepare('UPDATE wms_warehouses SET name = ?, address = ?, branch_id = ?, active = ? WHERE id = ?').run(A.text(b.name, 100) || w.name, b.address === undefined ? w.address : A.text(b.address, 200), b.branchId === undefined ? w.branch_id : await A.branchOf(req, b.branchId), active, w.id);
  if (!active) await db.prepare('UPDATE wms_locations SET active = 0 WHERE warehouse_id = ? AND is_default = 0').run(w.id);
  res.json({ ok: true });
});
router.delete('/warehouses/:id', A.need('manager'), async (req, res) => {
  const w = await whOf(req, req.params.id);
  if (w.is_default) throw new HttpError(400, "L'entrepôt principal ne peut pas être supprimé.");
  const left = (await db.prepare('SELECT COALESCE(SUM(v.quantity), 0) q FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id WHERE l.warehouse_id = ?').get(w.id)).q;
  if (left > 0) throw new HttpError(409, `Cet entrepôt contient encore du stock (${W.round3(left)}) : transférez-le avant de le supprimer.`);
  if (await db.prepare('SELECT 1 FROM wms_transfers WHERE org_id = ? AND (from_warehouse_id = ? OR to_warehouse_id = ?) LIMIT 1').get(req.org.id, w.id, w.id)) throw new HttpError(409, "Cet entrepôt a des transferts dans l'historique : désactivez-le plutôt que de le supprimer.");
  await db.prepare('DELETE FROM wms_warehouses WHERE id = ?').run(w.id);
  res.json({ ok: true });
});

// ---------- Zones ----------
router.get('/zones', async (req, res) => {
  const sc = A.scope(req, 'w.branch_id');
  const rows = await db.prepare(`SELECT z.*, w.name AS warehouse FROM wms_zones z JOIN wms_warehouses w ON w.id = z.warehouse_id WHERE z.org_id = ?${sc.sql} ORDER BY w.name, z.code`).all(req.org.id, ...sc.args);
  res.json({ zones: rows.map((z) => ({ id: z.id, warehouseId: z.warehouse_id, warehouse: z.warehouse, code: z.code, name: z.name, kind: z.kind, kindLabel: W.ZONE_KINDS[z.kind] })) });
});
router.post('/zones', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const w = await whOf(req, b.warehouseId);
  const name = A.text(b.name, 80, { required: true, msg: 'Indiquez le nom de la zone.' });
  const c = code(b.code || name.slice(0, 10), 'de la zone');
  const kind = A.oneOf(b.kind, Object.keys(W.ZONE_KINDS), 'storage', 'Type de zone inconnu.');
  if (await db.prepare('SELECT 1 FROM wms_zones WHERE warehouse_id = ? AND code = ?').get(w.id, c)) throw new HttpError(409, 'Ce code de zone existe déjà dans cet entrepôt.');
  const id = Number((await db.prepare('INSERT INTO wms_zones (org_id, warehouse_id, code, name, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, w.id, c, name, kind, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.put('/zones/:id', A.need('manager'), async (req, res) => {
  const z = await db.prepare('SELECT z.*, w.branch_id AS branch_id FROM wms_zones z JOIN wms_warehouses w ON w.id = z.warehouse_id WHERE z.id = ? AND z.org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!z || !A.visible(req, z)) throw new HttpError(404, 'Zone introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE wms_zones SET name = ?, kind = ? WHERE id = ?').run(A.text(b.name, 80) || z.name, b.kind === undefined ? z.kind : A.oneOf(b.kind, Object.keys(W.ZONE_KINDS), undefined, 'Type de zone inconnu.'), z.id);
  res.json({ ok: true });
});
router.delete('/zones/:id', A.need('manager'), async (req, res) => {
  const z = await db.prepare('SELECT z.*, w.branch_id AS branch_id FROM wms_zones z JOIN wms_warehouses w ON w.id = z.warehouse_id WHERE z.id = ? AND z.org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!z || !A.visible(req, z)) throw new HttpError(404, 'Zone introuvable.');
  const n = (await db.prepare('SELECT COUNT(*) c FROM wms_locations WHERE zone_id = ?').get(z.id)).c;
  if (n) throw new HttpError(409, `Cette zone contient ${n} emplacement(s) : déplacez-les ou supprimez-les d'abord.`);
  await db.prepare('DELETE FROM wms_zones WHERE id = ?').run(z.id);
  res.json({ ok: true });
});

// ---------- Emplacements ----------
const locView = (l, mgr, extra = {}) => ({ id: l.id, code: l.code, name: l.name, aisle: l.aisle, rack: l.rack, bin: l.bin, kind: l.kind, kindLabel: W.LOCATION_KINDS[l.kind], usable: W.isUsable(l.kind),
  warehouseId: l.warehouse_id, warehouse: l.warehouse, zoneId: l.zone_id, zone: l.zone || null, isDefault: Boolean(l.is_default), active: Boolean(l.active), capacity: l.capacity === null ? null : Number(l.capacity),
  quantity: l.quantity === undefined ? undefined : W.round3(l.quantity), items: l.items, value: mgr && l.value !== undefined ? Math.round(l.value) : undefined, ...extra });

router.get('/locations', async (req, res) => {
  await W.ensureDefault(req.org.id);
  const sc = A.scope(req, 'w.branch_id');
  const mgr = mgrOf(req);
  const wh = req.query.warehouseId ? A.id(req.query.warehouseId) : null;
  const rows = await db.prepare(`SELECT l.*, w.name AS warehouse, w.branch_id AS branch_id, z.name AS zone,
      COALESCE(s.q, 0) AS quantity, COALESCE(s.n, 0) AS items, COALESCE(s.v, 0) AS value
    FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id LEFT JOIN wms_zones z ON z.id = l.zone_id
    LEFT JOIN (SELECT v.location_id, SUM(v.quantity) q, COUNT(*) n, SUM(v.quantity * CASE WHEN i.avg_cost > 0 THEN i.avg_cost ELSE i.unit_cost END) v FROM wms_levels v JOIN stock_items i ON i.id = v.item_id GROUP BY v.location_id) s ON s.location_id = l.id
    WHERE l.org_id = ?${wh ? ' AND l.warehouse_id = ?' : ''}${sc.sql} ORDER BY w.is_default DESC, w.name, l.code`).all(req.org.id, ...(wh ? [wh] : []), ...sc.args);
  res.json({ locations: rows.map((l) => locView(l, mgr)) });
});

/** Recherche par code (lecteur de codes-barres ou saisie) : l'emplacement et ce qu'il contient. */
router.get('/locations/lookup', async (req, res) => {
  const c = code(req.query.code, "de l'emplacement");
  const l = await db.prepare('SELECT l.*, w.name AS warehouse, w.branch_id AS branch_id FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE l.org_id = ? AND l.code = ?').get(req.org.id, c);
  if (!l || !A.visible(req, l)) throw new HttpError(404, 'Aucun emplacement avec ce code.');
  res.json({ location: locView(l, false), content: await contentOf(req, l) });
});

async function contentOf(req, l) {
  const mgr = mgrOf(req);
  const rows = await db.prepare('SELECT v.item_id, v.quantity, i.name, i.unit, i.sku, i.barcode, i.tracking, i.avg_cost, i.unit_cost FROM wms_levels v JOIN stock_items i ON i.id = v.item_id WHERE v.location_id = ? AND v.quantity > 0 ORDER BY i.name COLLATE NOCASE').all(l.id);
  return rows.map((r) => ({ itemId: r.item_id, name: r.name, unit: r.unit, sku: r.sku, barcode: r.barcode, tracking: r.tracking, quantity: r.quantity, value: mgr ? Math.round(r.quantity * L.unitValue(r)) : undefined }));
}

router.get('/locations/:id', async (req, res) => {
  const l = await W.locationFor(req, req.params.id);
  const z = l.zone_id ? await db.prepare('SELECT name FROM wms_zones WHERE id = ?').get(l.zone_id) : null;
  res.json({ location: locView({ ...l, zone: z && z.name }, mgrOf(req)), content: await contentOf(req, l) });
});

async function locFields(req, b, w, cur) {
  const has = (k) => b[k] !== undefined;
  const aisle = has('aisle') ? part(b.aisle) : cur ? cur.aisle : ''; const rack = has('rack') ? part(b.rack) : cur ? cur.rack : ''; const bin = has('bin') ? part(b.bin) : cur ? cur.bin : '';
  const auto = [aisle, rack, bin].filter(Boolean).join('-');
  const c = cur && !has('code') ? cur.code : code(b.code || auto, "de l'emplacement");
  if (await db.prepare(`SELECT 1 FROM wms_locations WHERE org_id = ? AND code = ?${cur ? ' AND id <> ?' : ''}`).get(req.org.id, c, ...(cur ? [cur.id] : []))) throw new HttpError(409, 'Ce code d\'emplacement existe déjà (il doit être unique dans l\'organisation pour être scanné).');
  let zoneId = has('zoneId') ? A.idOrNull(b.zoneId, 'Zone invalide.') : cur ? cur.zone_id : null;
  let zoneKind = null;
  if (zoneId) {
    const z = await db.prepare('SELECT * FROM wms_zones WHERE id = ? AND org_id = ? AND warehouse_id = ?').get(zoneId, req.org.id, w.id);
    if (!z) throw new HttpError(400, 'Cette zone ne fait pas partie de cet entrepôt.');
    zoneKind = z.kind;
  }
  const kind = has('kind') ? A.oneOf(b.kind, Object.keys(W.LOCATION_KINDS).filter((k) => k !== 'transit'), undefined, "Type d'emplacement inconnu.") : cur ? cur.kind : zoneKind || 'storage';
  const capacity = has('capacity') ? (b.capacity === null || b.capacity === '' ? null : A.qty(b.capacity)) : cur ? cur.capacity : null;
  return { code: c, name: has('name') ? A.text(b.name, 80) : cur ? cur.name : '', aisle, rack, bin, zoneId, kind, capacity };
}

router.post('/locations', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const w = b.warehouseId ? await whOf(req, b.warehouseId) : await db.prepare('SELECT * FROM wms_warehouses WHERE org_id = ? AND is_default = 1').get(req.org.id);
  if (!w) throw new HttpError(400, 'Choisissez un entrepôt.');
  if (!w.active) throw new HttpError(400, 'Cet entrepôt est désactivé.');
  const f = await locFields(req, b, w, null);
  const id = Number((await db.prepare('INSERT INTO wms_locations (org_id, warehouse_id, zone_id, code, name, aisle, rack, bin, kind, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, w.id, f.zoneId, f.code, f.name, f.aisle, f.rack, f.bin, f.kind, f.capacity, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});

/** Création en série : allées × rayons × bacs (jusqu'à 300 emplacements d'un coup), pour monter un entrepôt rapidement. */
router.post('/locations/bulk', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const w = await whOf(req, b.warehouseId);
  const aisles = String(b.aisles || '').split(/[,\s;]+/).map(part).filter(Boolean);
  const racks = Math.floor(Number(b.racks)); const bins = Math.floor(Number(b.bins) || 1);
  if (!aisles.length || !(racks >= 1) || !(bins >= 1)) throw new HttpError(400, 'Indiquez les allées (A, B…), le nombre de rayons et de bacs.');
  if (aisles.length * racks * bins > 300) throw new HttpError(400, '300 emplacements au plus par création en série.');
  if (!w.active) throw new HttpError(400, 'Cet entrepôt est désactivé.');
  const zoneId = A.idOrNull(b.zoneId, 'Zone invalide.');
  let zk = null;
  if (zoneId) { const z = await db.prepare('SELECT * FROM wms_zones WHERE id = ? AND org_id = ? AND warehouse_id = ?').get(zoneId, req.org.id, w.id); if (!z) throw new HttpError(400, 'Cette zone ne fait pas partie de cet entrepôt.'); zk = z.kind; }
  const kind = A.oneOf(b.kind, Object.keys(W.LOCATION_KINDS).filter((k) => k !== 'transit'), zk || 'storage', "Type d'emplacement inconnu.");
  const capacity = b.capacity === undefined || b.capacity === '' || b.capacity === null ? null : A.qty(b.capacity);
  let created = 0;
  await db.transaction(async () => {
    const pad = (n) => String(n).padStart(2, '0');
    for (const a of aisles) for (let r = 1; r <= racks; r++) for (let n = 1; n <= bins; n++) {
      const c = bins > 1 ? `${a}-${pad(r)}-${pad(n)}` : `${a}-${pad(r)}`;
      const r2 = await db.prepare('INSERT INTO wms_locations (org_id, warehouse_id, zone_id, code, aisle, rack, bin, kind, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(req.org.id, w.id, zoneId, c, a, pad(r), bins > 1 ? pad(n) : '', kind, capacity, nowISO());
      created += r2.changes;
    }
  })();
  res.status(201).json({ created, skipped: aisles.length * racks * bins - created });
});

router.put('/locations/:id', A.need('manager'), async (req, res) => {
  const l = await W.locationFor(req, req.params.id);
  if (l.kind === 'transit') throw new HttpError(400, "L'emplacement « En transit » est géré par les transferts.");
  const b = req.body || {};
  const w = await db.prepare('SELECT * FROM wms_warehouses WHERE id = ?').get(l.warehouse_id);
  const f = await locFields(req, b, w, l);
  const active = b.active === undefined ? l.active : b.active ? 1 : 0;
  if (!active && l.active) {
    if (l.is_default) throw new HttpError(400, "L'emplacement par défaut ne peut pas être désactivé.");
    const left = await db.prepare('SELECT COALESCE(SUM(quantity), 0) q FROM wms_levels WHERE location_id = ?').get(l.id);
    if (left.q > 0) throw new HttpError(409, `L'emplacement ${l.code} contient encore du stock (${W.round3(left.q)}) : déplacez-le avant de le désactiver.`);
  }
  if (f.capacity !== null) {
    const used = (await db.prepare('SELECT COALESCE(SUM(quantity), 0) q FROM wms_levels WHERE location_id = ?').get(l.id)).q;
    if (used - f.capacity > W.EPS) throw new HttpError(409, `Cet emplacement contient déjà ${W.round3(used)} : la capacité ne peut pas être inférieure.`);
  }
  await db.prepare('UPDATE wms_locations SET code = ?, name = ?, aisle = ?, rack = ?, bin = ?, zone_id = ?, kind = ?, capacity = ?, active = ? WHERE id = ?').run(f.code, f.name, f.aisle, f.rack, f.bin, f.zoneId, f.kind, f.capacity, active, l.id);
  res.json({ ok: true });
});

router.delete('/locations/:id', A.need('manager'), async (req, res) => {
  const l = await W.locationFor(req, req.params.id);
  if (l.is_default || l.kind === 'transit') throw new HttpError(400, 'Cet emplacement est indispensable : il ne peut pas être supprimé.');
  const left = (await db.prepare('SELECT COALESCE(SUM(quantity), 0) q FROM wms_levels WHERE location_id = ?').get(l.id)).q;
  if (left > 0) throw new HttpError(409, `L'emplacement ${l.code} contient encore du stock (${W.round3(left)}) : déplacez-le avant de le supprimer.`);
  await db.prepare('DELETE FROM wms_locations WHERE id = ?').run(l.id);
  res.json({ ok: true });
});

// ---------- Stock d'un article par emplacement ----------
router.get('/items/:id/levels', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const mgr = mgrOf(req);
  await W.ensureDefault(req.org.id);
  const rows = await W.levelRows(it.id);
  const uv = L.unitValue(it);
  res.json({ itemId: it.id, name: it.name, unit: it.unit, quantity: it.quantity, usable: await W.usableQty(it.id),
    levels: rows.map((l) => ({ locationId: l.location_id, code: l.code, name: l.name, kind: l.kind, kindLabel: W.LOCATION_KINDS[l.kind], warehouseId: l.warehouse_id, warehouse: l.warehouse, quantity: l.quantity, value: mgr ? Math.round(l.quantity * uv) : undefined })) });
});

// ---------- Déplacement interne d'un emplacement à un autre ----------
router.post('/move', async (req, res) => {
  const b = req.body || {};
  const qty = A.qty(b.quantity);
  const from = await W.locationFor(req, b.fromLocationId); const to = await W.locationFor(req, b.toLocationId);
  const it0 = await itemOf(req, b.itemId);
  await db.transaction(async () => {
    const it = await W.lockItem(req.org.id, it0.id);
    if (it.tracking === 'serial' && !Number.isInteger(qty)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : la quantité est un nombre entier.`);
    await W.reconcile(req.org.id, it);
    // Un déplacement ne doit pas faire passer du stock réservé hors des emplacements disponibles.
    if (W.isUsable(from.kind) && !W.isUsable(to.kind)) await W.reservedGuard(it, qty);
    if (W.isUsable(from.kind) && (!W.isUsable(to.kind) || to.warehouse_id !== from.warehouse_id)) await W.whGuard(it, from.warehouse_id, qty); // réservations d'entrepôt
    await W.relocate(req, it, from.id, to.id, qty, { kind: 'move', reason: A.text(b.reason, 150) || 'Déplacement interne', lotId: b.lotId ? A.id(b.lotId, 'Lot invalide.') : undefined, serials: it.tracking === 'serial' && b.serials ? L.parseSerials(b.serials) : undefined });
  })();
  res.json({ ok: true });
});

/** Où se trouvent les lots et les numéros de série d'un article (par emplacement). */
router.get('/items/:id/tracking', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  await W.ensureDefault(req.org.id);
  await db.transaction(async () => { await W.lockItem(req.org.id, it.id); await W.reconcile(req.org.id, it); await require('./wms-track').sync(it); })();
  const lots = await db.prepare('SELECT l.id, l.lot_no, l.expiry, l.quantity FROM stock_lots l WHERE l.item_id = ? AND l.quantity > 0 ORDER BY l.expiry IS NULL, l.expiry, l.id').all(it.id);
  const cells = await db.prepare('SELECT c.lot_id, c.quantity, loc.code, loc.id AS lid FROM wms_lot_levels c JOIN wms_locations loc ON loc.id = c.location_id JOIN stock_lots l ON l.id = c.lot_id WHERE l.item_id = ? AND c.quantity > 0 ORDER BY loc.code').all(it.id);
  const ser = await db.prepare("SELECT s.serial, loc.code, loc.id AS lid FROM stock_serials s LEFT JOIN wms_locations loc ON loc.id = s.location_id WHERE s.item_id = ? AND s.status = 'in_stock' ORDER BY s.id").all(it.id);
  res.json({ tracking: it.tracking, lots: lots.map((l) => ({ id: l.id, lotNo: l.lot_no, expiry: l.expiry, quantity: l.quantity, locations: cells.filter((c) => c.lot_id === l.id).map((c) => ({ locationId: c.lid, code: c.code, quantity: c.quantity })) })),
    serials: ser.map((x) => ({ serial: x.serial, locationId: x.lid, location: x.code })) });
});

// ---------- Règles de rangement ----------
router.get('/putaway-rules', async (req, res) => {
  const rows = await db.prepare(`SELECT r.*, l.code AS location, i.name AS item FROM wms_putaway_rules r JOIN wms_locations l ON l.id = r.location_id LEFT JOIN stock_items i ON i.id = r.item_id WHERE r.org_id = ? ORDER BY r.priority, r.id`).all(req.org.id);
  res.json({ rules: rows.map((r) => ({ id: r.id, itemId: r.item_id, item: r.item, tracking: r.tracking, locationId: r.location_id, location: r.location, priority: r.priority })) });
});
router.post('/putaway-rules', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const loc = await W.locationFor(req, b.locationId);
  if (loc.kind === 'transit' || !loc.active) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
  const itemId = b.itemId === undefined || b.itemId === '' || b.itemId === null ? null : (await itemOf(req, b.itemId)).id;
  const tracking = itemId || b.tracking === undefined || b.tracking === '' || b.tracking === null ? null : A.oneOf(b.tracking, L.TRACKING, undefined, 'Suivi inconnu.');
  if (!itemId && !tracking) throw new HttpError(400, 'Une règle vise un article ou un type de suivi (lot, numéro de série).');
  const priority = b.priority === undefined || b.priority === '' ? 100 : Math.min(Math.max(Math.round(Number(b.priority)) || 100, 1), 9999);
  const id = Number((await db.prepare('INSERT INTO wms_putaway_rules (org_id, item_id, tracking, location_id, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, itemId, tracking, loc.id, priority, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.delete('/putaway-rules/:id', A.need('manager'), async (req, res) => {
  const r = await db.prepare('DELETE FROM wms_putaway_rules WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Règle introuvable.');
  res.json({ ok: true });
});
/** Où irait une entrée (sans l'enregistrer). */
router.get('/putaway-suggest', async (req, res) => {
  const it = await itemOf(req, req.query.itemId);
  const qty = A.qty(req.query.quantity);
  const parts = await W.putawayParts(req.org.id, it, qty);
  const locs = await db.prepare('SELECT id, code FROM wms_locations WHERE org_id = ?').all(req.org.id);
  const by = new Map(locs.map((l) => [l.id, l.code]));
  res.json({ parts: parts.map((p) => ({ locationId: p.locationId, code: by.get(p.locationId), quantity: p.quantity, fallback: Boolean(p.fallback) })) });
});

// ---------- Cohérence ----------
router.get('/integrity', A.need('manager'), async (req, res) => {
  await W.ensureDefault(req.org.id);
  const bad = await W.integrity(req.org.id);
  const neg = (await db.prepare('SELECT COUNT(*) c FROM wms_levels WHERE org_id = ? AND quantity < 0').get(req.org.id)).c;
  res.json({ ok: bad.length === 0 && neg === 0, mismatches: bad.map((x) => ({ itemId: x.id, name: x.name, quantity: x.quantity, locations: W.round3(x.levels) })), negative: neg });
});

module.exports = router;
