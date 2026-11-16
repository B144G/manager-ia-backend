'use strict';
// Stock WMS : fonctions avancées — vagues de préparation, palettes (unités logistiques) et colisage.
//  - Vague : plusieurs commandes préparées en une seule tournée. Chaque commande garde sa liste de préparation (et sa réservation) ; la vague présente les lignes regroupées
//    par emplacement et article, dans l'ordre du parcours, et répartit chaque prélèvement entre les commandes.
//  - Palette / carton (unité logistique) : regroupe du stock d'un emplacement sous un code scannable (PAL-…), peut en contenir d'autres (carton sur palette). Déplacer l'unité
//    déplace tout son contenu. Le stock reste compté emplacement par emplacement : une unité ne peut pas contenir plus que ce qui est là.
//  - Colisage : après la préparation, on répartit ce qui est prélevé en colis (COL-…) avec leur poids ; l'expédition exige que tout soit emballé dès qu'un colis existe.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-lib');
const P = require('./stock-wms-picking');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgrOf = (req) => A.can(req, 'manager');
const natural = (a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true });
const WSTATUS = { open: 'En cours', done: 'Terminée', cancelled: 'Annulée' };

// =====================================================================================================  VAGUES
const waveOf = async (req, id) => {
  const w = await db.prepare('SELECT * FROM wms_waves WHERE id = ? AND org_id = ?').get(A.id(id, 'Vague invalide.'), req.org.id);
  if (!w) throw new HttpError(404, 'Vague introuvable.');
  return w;
};
const wavePicks = (waveId) => db.prepare('SELECT * FROM wms_picks WHERE wave_id = ? ORDER BY id').all(waveId);

async function waveView(req, w, full) {
  const picks = await wavePicks(w.id);
  const live = picks.filter((p) => p.status !== 'cancelled');
  const status = !live.length ? 'cancelled' : live.every((p) => p.status === 'issued') ? 'done' : 'open';
  const out = { id: w.id, code: w.code, status, statusLabel: WSTATUS[status], label: w.label, createdAt: w.created_at, picks: picks.length, issued: picks.filter((p) => p.status === 'issued').length, picked: picks.filter((p) => ['picked', 'issued'].includes(p.status)).length };
  if (full) {
    const lines = await db.prepare(`SELECT l.*, i.name, i.unit, i.sku, i.barcode, loc.code AS loc_code, p.code AS pick_code, p.label AS pick_label, p.status AS pick_status FROM wms_pick_lines l JOIN wms_picks p ON p.id = l.pick_id JOIN stock_items i ON i.id = l.item_id JOIN wms_locations loc ON loc.id = l.location_id WHERE p.wave_id = ? AND p.status <> 'cancelled' ORDER BY l.id`).all(w.id);
    const m = new Map();
    for (const l of lines) {
      const k = `${l.location_id}:${l.item_id}`;
      const x = m.get(k) || { locationId: l.location_id, location: l.loc_code, itemId: l.item_id, name: l.name, unit: l.unit, sku: l.sku, barcode: l.barcode, quantity: 0, pickedQty: 0, orders: [] };
      x.quantity = W.round3(x.quantity + l.quantity); x.pickedQty = W.round3(x.pickedQty + l.picked_qty);
      x.orders.push({ pickId: l.pick_id, pick: l.pick_code, label: l.pick_label, quantity: l.quantity, pickedQty: l.picked_qty });
      m.set(k, x);
    }
    out.lines = [...m.values()].map((x) => ({ ...x, done: x.pickedQty + W.EPS >= x.quantity })).sort((a, b) => natural(a.location, b.location) || a.name.localeCompare(b.name));
    out.orders = picks.map((p) => ({ id: p.id, code: p.code, label: p.label, status: p.status }));
  }
  return out;
}

router.get('/waves', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM wms_waves WHERE org_id = ? ORDER BY id DESC LIMIT 50').all(req.org.id);
  const out = []; for (const w of rows) out.push(await waveView(req, w, false));
  res.json({ waves: out });
});
router.get('/waves/:id', async (req, res) => res.json({ wave: await waveView(req, await waveOf(req, req.params.id), true) }));

router.post('/waves', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.documentIds) ? b.documentIds : []).map((x) => A.id(x, 'Document invalide.')))];
  if (ids.length < 2 || ids.length > 30) throw new HttpError(400, 'Une vague regroupe de 2 à 30 commandes.');
  const id = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'wms_wave', 'VAG');
    const wid = Number((await db.prepare('INSERT INTO wms_waves (org_id, code, status, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, code, 'open', A.text(b.label, 150), req.user.id, nowISO())).lastInsertRowid);
    for (const d of ids) await P.createPick(req, { documentId: d, warehouseId: b.warehouseId, priority: b.priority, assignedTo: b.assignedTo }, wid);
    return wid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Vague de préparation créée (${ids.length} commandes)`);
  res.status(201).json({ id });
});

/** Prélèvement d'une ligne regroupée : la quantité est répartie entre les commandes de la vague, dans l'ordre. */
router.post('/waves/:id/confirm', async (req, res) => {
  const w = await waveOf(req, req.params.id);
  const b = req.body || {};
  const itemId = A.id(b.itemId, 'Article invalide.'); const locId = A.id(b.locationId, 'Emplacement invalide.');
  await db.transaction(async () => {
    const lines = await db.prepare(`SELECT l.*, p.id AS pid FROM wms_pick_lines l JOIN wms_picks p ON p.id = l.pick_id WHERE p.wave_id = ? AND p.status IN ('open','in_progress') AND l.item_id = ? AND l.location_id = ? AND l.picked_qty < l.quantity ORDER BY l.id`).all(w.id, itemId, locId);
    if (!lines.length) throw new HttpError(404, 'Rien à prélever sur cette ligne de la vague.');
    const total = W.round3(lines.reduce((a, l) => a + (l.quantity - l.picked_qty), 0));
    let left = b.quantity === undefined || b.quantity === '' ? total : A.qty(b.quantity, { allowZero: true });
    if (left - total > W.EPS) throw new HttpError(400, `Il ne reste que ${total} à prélever sur cette ligne de la vague.`);
    for (const l of lines) {
      if (left <= W.EPS) break;
      const q = W.round3(Math.min(left, l.quantity - l.picked_qty));
      const pick = await P.pickOf(req, l.pid);
      P.canWork(req, pick);
      await P.confirmLine(req, pick, l.id, { quantity: q, itemCode: b.itemCode, locationCode: b.locationCode });
      left = W.round3(left - q);
    }
  })();
  res.json({ ok: true });
});

router.post('/waves/:id/complete', async (req, res) => {
  const w = await waveOf(req, req.params.id);
  const allowShort = (req.body || {}).allowShort === true || (req.body || {}).allowShort === 'true';
  await db.transaction(async () => {
    for (const p of await wavePicks(w.id)) if (['open', 'in_progress'].includes(p.status)) { P.canWork(req, p); await P.completePick(req, p, allowShort); }
  })();
  res.json({ ok: true });
});
router.post('/waves/:id/issue', A.need('manager'), async (req, res) => {
  const w = await waveOf(req, req.params.id);
  let n = 0;
  await db.transaction(async () => {
    for (const p of await wavePicks(w.id)) if (p.status === 'picked') { await P.issuePick(req, p, req.body || {}); n++; }
    if (!n) throw new HttpError(409, "Aucune commande de la vague n'est prête à expédier : terminez d'abord la préparation.");
    const left = (await wavePicks(w.id)).filter((p) => !['issued', 'cancelled'].includes(p.status)).length;
    if (!left) await db.prepare("UPDATE wms_waves SET status = 'done', closed_at = ? WHERE id = ?").run(nowISO(), w.id);
  })();
  res.json({ ok: true, orders: n });
});
router.post('/waves/:id/cancel', A.need('manager'), async (req, res) => {
  const w = await waveOf(req, req.params.id);
  await db.transaction(async () => {
    for (const p of await wavePicks(w.id)) {
      if (['issued', 'cancelled'].includes(p.status)) continue;
      await db.prepare("UPDATE wms_picks SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(nowISO(), p.id);
      await db.prepare("UPDATE wms_reservations SET status = 'released', closed_at = ?, closed_by = ?, close_reason = 'Vague annulée' WHERE org_id = ? AND source_kind = 'pick' AND source_id = ? AND status = 'active'").run(nowISO(), req.user.id, req.org.id, p.id);
    }
    await db.prepare("UPDATE wms_waves SET status = 'cancelled', closed_at = ? WHERE id = ?").run(nowISO(), w.id);
  })();
  res.json({ ok: true });
});

// =====================================================================================================  PALETTES (UNITÉS LOGISTIQUES)
const UKIND = { pallet: ['Palette', 'PAL'], carton: ['Carton', 'CAR'], box: ['Caisse', 'CAI'] };
const unitOf = async (req, id) => {
  const u = await db.prepare('SELECT u.*, w.branch_id AS branch_id FROM wms_units u JOIN wms_locations l ON l.id = u.location_id JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE u.id = ? AND u.org_id = ?').get(A.id(id, 'Unité invalide.'), req.org.id);
  if (!u || !A.visible(req, u)) throw new HttpError(404, 'Unité introuvable.');
  return u;
};
async function descendants(unitId) {
  const out = []; let frontier = [unitId];
  for (let d = 0; d < 6 && frontier.length; d++) {
    const kids = await db.prepare(`SELECT id FROM wms_units WHERE parent_id IN (${frontier.map(() => '?').join(',')})`).all(...frontier);
    frontier = kids.map((k) => k.id); out.push(...frontier);
  }
  return out;
}
async function unitView(req, u, full) {
  const mgr = mgrOf(req);
  const loc = await db.prepare('SELECT code FROM wms_locations WHERE id = ?').get(u.location_id);
  const items = await db.prepare('SELECT ui.item_id, ui.quantity, i.name, i.unit, i.avg_cost, i.unit_cost FROM wms_unit_items ui JOIN stock_items i ON i.id = ui.item_id WHERE ui.unit_id = ? ORDER BY i.name COLLATE NOCASE').all(u.id);
  const kids = await db.prepare('SELECT id, code, kind FROM wms_units WHERE parent_id = ? ORDER BY id').all(u.id);
  const parent = u.parent_id ? await db.prepare('SELECT code FROM wms_units WHERE id = ?').get(u.parent_id) : null;
  const out = { id: u.id, code: u.code, kind: u.kind, kindLabel: (UKIND[u.kind] || [u.kind])[0], locationId: u.location_id, location: loc ? loc.code : null, parentId: u.parent_id, parent: parent ? parent.code : null, note: u.note, createdAt: u.created_at,
    lines: items.length, quantity: W.round3(items.reduce((a, x) => a + x.quantity, 0)), children: kids.length,
    value: mgr ? Math.round(items.reduce((a, x) => a + x.quantity * (Number(x.avg_cost) > 0 ? Number(x.avg_cost) : Number(x.unit_cost) || 0), 0)) : undefined };
  if (full) { out.items = items.map((x) => ({ itemId: x.item_id, name: x.name, unit: x.unit, quantity: x.quantity })); out.kids = kids.map((k) => ({ id: k.id, code: k.code, kind: k.kind })); }
  return out;
}

router.get('/units', async (req, res) => {
  const sc = A.scope(req, 'w.branch_id');
  const loc = req.query.locationId ? A.id(req.query.locationId) : null;
  const rows = await db.prepare(`SELECT u.* FROM wms_units u JOIN wms_locations l ON l.id = u.location_id JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE u.org_id = ?${loc ? ' AND u.location_id = ?' : ''}${sc.sql} ORDER BY u.id DESC LIMIT 200`).all(req.org.id, ...(loc ? [loc] : []), ...sc.args);
  const out = []; for (const u of rows) out.push(await unitView(req, u, false));
  res.json({ units: out, kinds: Object.fromEntries(Object.entries(UKIND).map(([k, v]) => [k, v[0]])) });
});
router.get('/units/:id', async (req, res) => res.json({ unit: await unitView(req, await unitOf(req, req.params.id), true) }));

router.post('/units', async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, Object.keys(UKIND), 'pallet', "Type d'unité inconnu (palette, carton ou caisse).");
  const loc = await W.locationFor(req, b.locationId);
  if (loc.kind === 'transit') throw new HttpError(400, "L'emplacement « En transit » ne reçoit pas d'unités : déplacez l'unité par un transfert.");
  let parentId = null;
  if (b.parentId) { const par = await unitOf(req, b.parentId); if (par.location_id !== loc.id) throw new HttpError(400, "Une unité posée sur une autre doit être au même emplacement."); parentId = par.id; }
  const id = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'wms_unit_' + kind, UKIND[kind][1]);
    return Number((await db.prepare('INSERT INTO wms_units (org_id, code, kind, location_id, parent_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, code, kind, loc.id, parentId, A.text(b.note, 200), req.user.id, nowISO())).lastInsertRowid);
  })();
  res.status(201).json({ id });
});

/** Quantité d'un article de cet emplacement qui n'est dans aucune unité. */
const freeAt = async (itemId, locId) => W.round3((await W.levelAt(itemId, locId)) - Number((await db.prepare('SELECT COALESCE(SUM(ui.quantity), 0) q FROM wms_unit_items ui JOIN wms_units u ON u.id = ui.unit_id WHERE ui.item_id = ? AND u.location_id = ?').get(itemId, locId)).q));

router.post('/units/:id/items', async (req, res) => {
  const u = await unitOf(req, req.params.id);
  const b = req.body || {};
  const q = A.qty(b.quantity);
  await db.transaction(async () => {
    const it = await W.lockItem(req.org.id, A.id(b.itemId, 'Article invalide.'));
    if (!A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
    if (it.tracking === 'serial') throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : il ne se range pas par quantité dans une unité.`);
    const free = await freeAt(it.id, u.location_id);
    if (q - free > W.EPS) throw new HttpError(409, `Il n'y a que ${Math.max(free, 0)} ${it.unit} de « ${it.name} » libre(s) à cet emplacement (le reste est déjà dans une unité ou absent).`);
    await db.prepare('INSERT INTO wms_unit_items (unit_id, item_id, quantity) VALUES (?, ?, ?) ON CONFLICT (unit_id, item_id) DO UPDATE SET quantity = wms_unit_items.quantity + EXCLUDED.quantity').run(u.id, it.id, q);
  })();
  res.json({ ok: true });
});
router.delete('/units/:id/items/:itemId', async (req, res) => {
  const u = await unitOf(req, req.params.id);
  const iid = A.id(req.params.itemId);
  const cur = await db.prepare('SELECT quantity FROM wms_unit_items WHERE unit_id = ? AND item_id = ?').get(u.id, iid);
  if (!cur) throw new HttpError(404, "Cet article n'est pas dans l'unité.");
  const q = req.query.quantity ? A.qty(req.query.quantity) : cur.quantity;
  if (q >= cur.quantity - W.EPS) await db.prepare('DELETE FROM wms_unit_items WHERE unit_id = ? AND item_id = ?').run(u.id, iid);
  else await db.prepare('UPDATE wms_unit_items SET quantity = quantity - ? WHERE unit_id = ? AND item_id = ?').run(q, u.id, iid);
  res.json({ ok: true });
});

router.post('/units/:id/nest', async (req, res) => {
  const u = await unitOf(req, req.params.id);
  const pid = (req.body || {}).parentId;
  if (pid === null || pid === undefined || pid === '') { await db.prepare('UPDATE wms_units SET parent_id = NULL WHERE id = ?').run(u.id); return res.json({ ok: true }); }
  const par = await unitOf(req, pid);
  if (par.id === u.id || (await descendants(u.id)).includes(par.id)) throw new HttpError(400, 'Une unité ne peut pas se poser sur elle-même ni sur ce qu\'elle contient.');
  if (par.location_id !== u.location_id) throw new HttpError(400, 'Les deux unités doivent être au même emplacement.');
  await db.prepare('UPDATE wms_units SET parent_id = ? WHERE id = ?').run(par.id, u.id);
  res.json({ ok: true });
});

/** Déplace l'unité et tout ce qu'elle contient (autres unités comprises) vers un autre emplacement. */
router.post('/units/:id/move', async (req, res) => {
  const u = await unitOf(req, req.params.id);
  const to = await W.locationFor(req, (req.body || {}).toLocationId);
  if (to.id === u.location_id) throw new HttpError(400, "L'unité est déjà à cet emplacement.");
  if (to.kind === 'transit') throw new HttpError(400, "L'emplacement « En transit » ne reçoit que des transferts.");
  const from = await W.locationOf(req.org.id, u.location_id);
  await db.transaction(async () => {
    const ids = [u.id, ...(await descendants(u.id))];
    const contents = await db.prepare(`SELECT item_id, SUM(quantity) q FROM wms_unit_items WHERE unit_id IN (${ids.map(() => '?').join(',')}) GROUP BY item_id ORDER BY item_id`).all(...ids);
    await db.prepare(`UPDATE wms_units SET location_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(to.id, ...ids); // d'abord : le retrait à l'origine ne doit pas rogner l'unité qui part
    if (u.parent_id) await db.prepare('UPDATE wms_units SET parent_id = NULL WHERE id = ?').run(u.id);
    for (const c of contents) {
      const it = await W.lockItem(req.org.id, c.item_id);
      await W.reconcile(req.org.id, it);
      if (W.isUsable(from.kind) && !W.isUsable(to.kind)) await W.reservedGuard(it, c.q);
      if (W.isUsable(from.kind) && (!W.isUsable(to.kind) || to.warehouse_id !== from.warehouse_id)) await W.whGuard(it, from.warehouse_id, c.q);
      await W.relocate(req, it, from.id, to.id, c.q, { kind: 'move', reason: `Unité ${u.code} déplacée`, refKind: 'unit', refId: u.id });
    }
  })();
  res.json({ ok: true });
});

/** Dépalettiser : l'unité disparaît, son contenu reste en stock à l'emplacement (libre). */
router.delete('/units/:id', async (req, res) => {
  const u = await unitOf(req, req.params.id);
  await db.prepare('UPDATE wms_units SET parent_id = ? WHERE parent_id = ?').run(u.parent_id, u.id);
  await db.prepare('DELETE FROM wms_units WHERE id = ?').run(u.id);
  res.json({ ok: true });
});

// =====================================================================================================  COLISAGE
const pickFor = async (req, id) => { const p = await P.pickOf(req, id); return p; };
async function pkgView(p) {
  const items = await db.prepare('SELECT pi.item_id, pi.quantity, i.name, i.unit FROM wms_package_items pi JOIN stock_items i ON i.id = pi.item_id WHERE pi.package_id = ? ORDER BY i.name COLLATE NOCASE').all(p.id);
  return { id: p.id, code: p.code, weight: p.weight, note: p.note, pickId: p.pick_id, quantity: W.round3(items.reduce((a, x) => a + x.quantity, 0)), items: items.map((x) => ({ itemId: x.item_id, name: x.name, unit: x.unit, quantity: x.quantity })) };
}
router.get('/picks/:id/packages', async (req, res) => {
  const pk = await pickFor(req, req.params.id);
  const rows = await db.prepare('SELECT * FROM wms_packages WHERE pick_id = ? ORDER BY id').all(pk.id);
  const pkgs = []; for (const r of rows) pkgs.push(await pkgView(r));
  res.json({ packages: pkgs, unpacked: await W.unpackedOf(pk.id), weight: W.round3(pkgs.reduce((a, x) => a + x.weight, 0)) });
});

router.post('/picks/:id/packages', async (req, res) => {
  const pk = await pickFor(req, req.params.id);
  P.canWork(req, pk);
  const b = req.body || {};
  const weight = b.weight === undefined || b.weight === '' ? 0 : A.qty(b.weight, { allowZero: true });
  const id = await db.transaction(async () => {
    const cur = await db.prepare('SELECT * FROM wms_picks WHERE id = ? FOR UPDATE').get(pk.id);
    if (['issued', 'cancelled'].includes(cur.status)) throw new HttpError(409, 'Cette liste est terminée : on ne fait plus de colis.');
    let lines = Array.isArray(b.lines) ? b.lines : [];
    const rest = await W.unpackedOf(pk.id);
    if (b.all === true || b.all === 'true') lines = rest.map((x) => ({ itemId: x.itemId, quantity: x.q }));
    if (!lines.length || lines.length > 100) throw new HttpError(400, 'Indiquez ce que contient le colis.');
    const code = await W.nextCode(req.org.id, 'wms_package', 'COL');
    const cid = Number((await db.prepare('INSERT INTO wms_packages (org_id, pick_id, code, weight, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, pk.id, code, weight, A.text(b.note, 200), req.user.id, nowISO())).lastInsertRowid);
    const seen = new Set();
    for (const x of lines) {
      const itemId = A.id(x && x.itemId, 'Article invalide.'); const q = A.qty(x.quantity);
      if (seen.has(itemId)) throw new HttpError(400, 'Un article apparaît deux fois dans le colis.');
      seen.add(itemId);
      const r = rest.find((y) => y.itemId === itemId);
      if (!r) throw new HttpError(400, "Cet article n'a pas été prélevé pour cette liste, ou il est déjà entièrement emballé.");
      if (q - r.q > W.EPS) throw new HttpError(400, `« ${r.name} » : ${r.q} seulement reste(nt) à emballer.`);
      await db.prepare('INSERT INTO wms_package_items (package_id, item_id, quantity) VALUES (?, ?, ?)').run(cid, itemId, q);
    }
    return cid;
  })();
  res.status(201).json({ id });
});
router.delete('/packages/:id', async (req, res) => {
  const pkg = await db.prepare('SELECT * FROM wms_packages WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!pkg) throw new HttpError(404, 'Colis introuvable.');
  const pk = await pickFor(req, pkg.pick_id);
  if (['issued', 'cancelled'].includes(pk.status)) throw new HttpError(409, 'Cette liste est terminée : le colis ne se défait plus.');
  await db.prepare('DELETE FROM wms_packages WHERE id = ?').run(pkg.id);
  res.json({ ok: true });
});

module.exports = router;
