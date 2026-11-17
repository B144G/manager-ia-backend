'use strict';
// Entrepôt (fusion, apport de la ligne B) : palettes / cartons / caisses (unités logistiques « wms_units ») et COLISAGE d'une liste de préparation (wms_packages).
// Réuni avec A : les unités de manutention de A (wms-hu : /hus, étiquettes, réception sur palette) et les colis d'expédition de A (wms-ship) restent ;
// ces unités-ci sont un regroupement léger d'un emplacement (code PAL-/CAR-/CAI-), le colisage par liste ajoute le poids et le contrôle « Colisage incomplet » à l'expédition.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgrOf = (req) => A.can(req, 'manager');
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
  const loc = await W.locationFor(req, A.id(b.locationId, 'Emplacement introuvable.'));
  if (loc.kind === 'transit') throw new HttpError(400, "L'emplacement « En transit » ne reçoit pas d'unités : déplacez l'unité par un transfert.");
  let parentId = null;
  if (b.parentId) { const par = await unitOf(req, b.parentId); if (par.location_id !== loc.id) throw new HttpError(400, "Une unité posée sur une autre doit être au même emplacement."); parentId = par.id; }
  const id = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, UKIND[kind][1]);
    return Number((await db.prepare('INSERT INTO wms_units (org_id, code, kind, location_id, parent_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, code, kind, loc.id, parentId, A.text(b.note, 200), req.user.id, nowISO())).lastInsertRowid);
  })();
  res.status(201).json({ id });
});

/** Quantité d'un article de cet emplacement qui n'est dans aucune unité. */
const freeAt = async (itemId, locId) => W.round3((await W.qtyAt(locId, itemId)) - Number((await db.prepare('SELECT COALESCE(SUM(ui.quantity), 0) q FROM wms_unit_items ui JOIN wms_units u ON u.id = ui.unit_id WHERE ui.item_id = ? AND u.location_id = ?').get(itemId, locId)).q));

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
  const to = await W.locationFor(req, A.id((req.body || {}).toLocationId, 'Emplacement introuvable.'));
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
      await W.reconcile(req, it, it.quantity);
      if (W.isUsable(from) && !W.isUsable(to)) await W.reservedGuard(it.id, c.q);
      if (W.isUsable(from) && (!W.isUsable(to) || to.warehouse_id !== from.warehouse_id)) await W.whGuard(it.id, from.warehouse_id, c.q);
      await W.move(req, it.id, from.id, to.id, c.q, { kind: 'move', reason: `Unité ${u.code} déplacée`, refKind: 'unit', refId: u.id });
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
const pickFor = async (req, id) => {
  const p = await db.prepare('SELECT * FROM wms_picks WHERE id = ? AND org_id = ?').get(A.id(id, 'Liste invalide.'), req.org.id);
  if (!p) throw new HttpError(404, 'Liste de préparation introuvable.');
  return p;
};
/** Ce qui a été prélevé pour une liste mais n'est pas encore dans un colis : [{ itemId, name, q }]. */
async function unpackedOf(pickId) {
  const rows = await db.prepare(`SELECT l.item_id, i.name, SUM(l.picked_qty) AS picked, COALESCE((SELECT SUM(pi.quantity) FROM wms_package_items pi JOIN wms_packages pk ON pk.id = pi.package_id WHERE pk.pick_id = l.pick_id AND pi.item_id = l.item_id), 0) AS packed
    FROM wms_pick_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.pick_id = ? GROUP BY l.item_id, l.pick_id, i.name`).all(pickId);
  return rows.filter((r) => Number(r.picked) - Number(r.packed) > W.EPS).map((r) => ({ itemId: Number(r.item_id), name: r.name, q: W.round3(Number(r.picked) - Number(r.packed)) }));
}
const canWork = (req, p) => { if (p.assigned_to && Number(p.assigned_to) !== Number(req.user.id) && !A.can(req, 'manager')) throw new HttpError(403, 'Cette liste est confiée à une autre personne.'); };
async function pkgView(p) {
  const items = await db.prepare('SELECT pi.item_id, pi.quantity, i.name, i.unit FROM wms_package_items pi JOIN stock_items i ON i.id = pi.item_id WHERE pi.package_id = ? ORDER BY i.name COLLATE NOCASE').all(p.id);
  return { id: p.id, code: p.code, weight: p.weight, note: p.note, pickId: p.pick_id, quantity: W.round3(items.reduce((a, x) => a + x.quantity, 0)), items: items.map((x) => ({ itemId: x.item_id, name: x.name, unit: x.unit, quantity: x.quantity })) };
}
router.get('/picks/:id/packages', async (req, res) => {
  const pk = await pickFor(req, req.params.id);
  const rows = await db.prepare('SELECT * FROM wms_packages WHERE pick_id = ? ORDER BY id').all(pk.id);
  const pkgs = []; for (const r of rows) pkgs.push(await pkgView(r));
  res.json({ packages: pkgs, unpacked: await unpackedOf(pk.id), weight: W.round3(pkgs.reduce((a, x) => a + x.weight, 0)) });
});

router.post('/picks/:id/packages', async (req, res) => {
  const pk = await pickFor(req, req.params.id);
  canWork(req, pk);
  const b = req.body || {};
  const weight = b.weight === undefined || b.weight === '' ? 0 : A.qty(b.weight, { allowZero: true });
  const id = await db.transaction(async () => {
    const cur = await db.prepare('SELECT * FROM wms_picks WHERE id = ? FOR UPDATE').get(pk.id);
    if (['issued', 'done', 'cancelled'].includes(cur.status)) throw new HttpError(409, 'Cette liste est terminée : on ne fait plus de colis.');
    let lines = Array.isArray(b.lines) ? b.lines : [];
    const rest = await unpackedOf(pk.id);
    if (b.all === true || b.all === 'true') lines = rest.map((x) => ({ itemId: x.itemId, quantity: x.q }));
    if (!lines.length || lines.length > 100) throw new HttpError(400, 'Indiquez ce que contient le colis.');
    const code = await W.nextCode(req.org.id, 'COL');
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
  if (['issued', 'done', 'cancelled'].includes(pk.status)) throw new HttpError(409, 'Cette liste est terminée : le colis ne se défait plus.');
  await db.prepare('DELETE FROM wms_packages WHERE id = ?').run(pkg.id);
  res.json({ ok: true });
});

module.exports = router;
Object.assign(module.exports, { unpackedOf });
