'use strict';
// Stock entrepôt (WMS) — optimisation des emplacements (slotting, 4E).
// 1. Fréquence de prélèvement d'un article = nombre de lignes de préparation prélevées sur la période (vagues comprises), « visites ».
//    Classe de rotation : articles triés par visites ; part cumulée ≤ 80 % → A (rapides), ≤ 95 % → B, au-delà → C.
// 2. Distance d'un emplacement au quai (mètres) : la distance saisie sur l'emplacement, sinon
//    distance de base de la zone + distance de l'allée (réglage par allée, sinon rang de l'allée × pas entre allées) + numéro du rayon × pas entre rayons.
//    Un emplacement sans distance ni allée n'entre pas dans le calcul.
// 3. Proposition (glouton, du plus visité au moins visité) : chaque article vise l'emplacement libre le plus proche qui lui convient
//    (capacité, et pour un article lourd un niveau bas : niveau ≤ réglage « heavyMaxLevel ») ; si l'emplacement visé contient un seul
//    article moins visité, les deux échangent leur place. Un article lourd rangé trop haut descend même sans gain de distance.
// 4. Gain simulé : parcours = Σ visites × 2 × distance (aller-retour depuis le quai) ; gain = parcours actuel − parcours proposé.
// 5. Les propositions deviennent des tâches de déplacement (SL-0001…), exécutées par scan (départ, article, arrivée).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const P = require('./wms-pilot');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const H = () => require('./wms');
const SLOT_KINDS = ['picking', 'storage'];
const TASK_STATUS = { open: 'À faire', done: 'Faite', cancelled: 'Annulée' };
const natural = (a, b) => String(a || '').localeCompare(String(b || ''), 'fr', { numeric: true, sensitivity: 'base' });

async function warehouseFor(req, v) {
  if (v === undefined || v === null || v === '') return db.prepare('SELECT * FROM wms_warehouses WHERE org_id = ? AND is_default = 1').get(req.org.id);
  const w = await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(v), req.org.id);
  if (!w) throw new HttpError(404, 'Entrepôt introuvable.');
  return w;
}

/** Emplacements d'un entrepôt avec leur distance au quai (calculée ou saisie). */
async function locationsWithDistance(warehouseId, pilot, { all = false } = {}) {
  const rows = await db.prepare(`SELECT l.*, z.distance AS zone_distance, z.name AS zone FROM wms_locations l LEFT JOIN wms_zones z ON z.id = l.zone_id
    WHERE l.warehouse_id = ?${all ? '' : " AND l.active = 1 AND l.kind IN ('picking','storage')"} ORDER BY l.aisle, l.rack, l.bin, l.code`).all(warehouseId);
  const aisles = [...new Set(rows.filter((l) => l.aisle).map((l) => l.aisle))].sort(natural);
  const racksOf = {};
  for (const l of rows) if (l.aisle) (racksOf[l.aisle] = racksOf[l.aisle] || new Set()).add(l.rack || '');
  return rows.map((l) => {
    let distance = null; let source = null;
    if (l.distance !== null && l.distance !== undefined) { distance = Number(l.distance); source = 'manual'; } else if (l.aisle) {
      const set = pilot.aisleDistances || {};
      const aisleD = set[l.aisle] !== undefined ? Number(set[l.aisle]) : (aisles.indexOf(l.aisle) + 1) * Number(pilot.aislePitch);
      const n = /^\d+$/.test(l.rack || '') ? Number(l.rack) : [...racksOf[l.aisle]].sort(natural).indexOf(l.rack || '') + 1;
      distance = Number(l.zone_distance || 0) + aisleD + n * Number(pilot.rackPitch);
      source = 'derived';
    }
    return { id: Number(l.id), code: l.code, kind: l.kind, aisle: l.aisle || '', rack: l.rack || '', bin: l.bin || '', zone: l.zone || null, zoneId: l.zone_id ? Number(l.zone_id) : null,
      level: l.level === null || l.level === undefined ? null : Number(l.level), capacity: l.capacity === null || l.capacity === undefined ? null : Number(l.capacity),
      manualDistance: l.distance === null || l.distance === undefined ? null : Number(l.distance), distance: distance === null ? null : P.round2(distance), source, active: Boolean(Number(l.active)) };
  });
}

/** Visites (lignes prélevées) et unités par article depuis `since`. */
async function hitsSince(orgId, since) {
  const rows = await db.prepare(`SELECT pl.item_id, COUNT(*) AS n, COALESCE(SUM(pl.picked_qty), 0) AS q FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id
    WHERE p.org_id = ? AND p.status != 'cancelled' AND pl.picked_qty > 0 AND COALESCE(pl.picked_at, p.created_at) >= ? GROUP BY pl.item_id`).all(orgId, since);
  return new Map(rows.map((r) => [Number(r.item_id), { hits: Number(r.n), units: r3(Number(r.q)) }]));
}

async function analyse(req, { warehouseId, days } = {}) {
  const orgId = req.org.id;
  const pilot = await P.pilotOf(orgId);
  const w = await warehouseFor(req, warehouseId);
  const nDays = days === undefined || days === null || days === '' ? Number(pilot.slotDays) : Number(days);
  if (!Number.isInteger(nDays) || nDays < 1 || nDays > 730) throw new HttpError(400, 'Période : un nombre entier de jours, de 1 à 730.');
  const since = new Date(Date.now() - nDays * 86400000).toISOString();
  const locs = (await locationsWithDistance(w.id, pilot)).filter((l) => l.distance !== null);
  const locById = new Map(locs.map((l) => [l.id, l]));
  const ids = locs.map((l) => l.id);
  const stock = ids.length ? await db.prepare(`SELECT s.location_id, s.item_id, s.quantity, i.name, i.unit, i.sku, i.branch_id, p.weight_kg FROM wms_stock s JOIN stock_items i ON i.id = s.item_id LEFT JOIN wms_item_params p ON p.item_id = s.item_id
    WHERE s.location_id IN (${ids.map(() => '?').join(',')}) AND s.quantity > 0`).all(...ids) : [];
  const hits = await hitsSince(orgId, since);
  const openTasks = await db.prepare("SELECT item_id, to_location_id FROM wms_slot_tasks WHERE org_id = ? AND status = 'open'").all(orgId);
  const busy = new Set(openTasks.map((t) => Number(t.item_id)));

  // Emplacement principal de chaque article : celui qui en contient le plus (le plus proche à égalité).
  const occ = new Map(ids.map((id) => [id, new Set()]));
  const items = new Map();
  for (const s of stock) {
    const iid = Number(s.item_id); const lid = Number(s.location_id); const q = Number(s.quantity);
    occ.get(lid).add(iid);
    const cur = items.get(iid);
    const better = !cur || q > cur.quantity + W.EPS || (Math.abs(q - cur.quantity) <= W.EPS && locById.get(lid).distance < locById.get(cur.primary).distance);
    if (better) items.set(iid, { itemId: iid, name: s.name, unit: s.unit, sku: s.sku || '', branch_id: s.branch_id, weight: s.weight_kg === null || s.weight_kg === undefined ? null : Number(s.weight_kg), primary: lid, quantity: r3(q), ...(hits.get(iid) || { hits: 0, units: 0 }) });
  }
  const list = [...items.values()].filter((x) => A.visible(req, x));
  // Classe de rotation (visites cumulées).
  const ranked = list.filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits || a.itemId - b.itemId);
  const totalHits = ranked.reduce((s, x) => s + x.hits, 0);
  let cum = 0;
  for (const x of ranked) { cum += x.hits; const share = (100 * cum) / totalHits; x.velocity = share <= 80 + 1e-9 ? 'A' : share <= 95 + 1e-9 ? 'B' : 'C'; }
  for (const x of list) if (!x.velocity) x.velocity = x.hits > 0 ? 'C' : '-';

  const heavyKg = Number(pilot.heavyKg); const maxLevel = Number(pilot.heavyMaxLevel);
  const isHeavy = (x) => x.weight !== null && x.weight >= heavyKg;
  const levelOk = (x, l) => !(isHeavy(x) && l.level !== null && l.level > maxLevel);
  const capOk = (x, l) => l.capacity === null || x.quantity <= l.capacity + W.EPS;
  const pos = new Map(list.map((x) => [x.itemId, x.primary]));
  const locked = new Set(openTasks.map((t) => Number(t.to_location_id)).filter(Boolean));
  const byDist = locs.slice().sort((a, b) => a.distance - b.distance || natural(a.code, b.code));
  for (const x of ranked) {
    if (busy.has(x.itemId)) { locked.add(pos.get(x.itemId)); continue; }
    const c = locById.get(pos.get(x.itemId));
    const needDown = !levelOk(x, c);
    let moved = false;
    for (const s of byDist) {
      if (s.id === c.id || locked.has(s.id)) continue;
      if (!needDown && s.distance >= c.distance - 1e-9) break;
      if (!levelOk(x, s) || !capOk(x, s)) continue;
      const there = occ.get(s.id);
      if (!there.size) {
        occ.get(c.id).delete(x.itemId); there.add(x.itemId); pos.set(x.itemId, s.id); moved = true;
      } else if (there.size === 1 && occ.get(c.id).size === 1) {
        const jid = [...there][0]; const j = items.get(jid);
        if (j && !busy.has(jid) && pos.get(jid) === s.id && j.hits < x.hits && levelOk(j, c) && capOk(j, c)) {
          there.clear(); there.add(x.itemId); occ.get(c.id).clear(); occ.get(c.id).add(jid);
          pos.set(x.itemId, s.id); pos.set(jid, c.id); moved = true;
        }
      }
      if (moved) { locked.add(s.id); break; }
    }
    if (!moved) locked.add(c.id);
  }

  const travel = (x, lid) => x.hits * 2 * locById.get(lid).distance;
  let current = 0; let proposed = 0;
  for (const x of list) { current += travel(x, x.primary); proposed += travel(x, pos.get(x.itemId)); }
  const proposals = [];
  for (const x of list) {
    const to = pos.get(x.itemId);
    if (to === x.primary) continue;
    const loose = await W.looseAt(x.primary, x.itemId);
    const f = locById.get(x.primary); const t = locById.get(to);
    proposals.push({ itemId: x.itemId, name: x.name, unit: x.unit, fromLocationId: f.id, from: f.code, toLocationId: t.id, to: t.code, fromDistance: f.distance, toDistance: t.distance,
      quantity: r3(Math.max(0, loose)), onPallet: loose + W.EPS < x.quantity, hits: x.hits, velocity: x.velocity, reason: !levelOk(x, f) ? 'heavy' : 'velocity', gain: P.round2(travel(x, x.primary) - travel(x, to)) });
  }
  proposals.sort((a, b) => b.gain - a.gain || a.itemId - b.itemId);
  const gain = P.round2(current - proposed);
  return {
    warehouse: { id: Number(w.id), name: w.name }, days: nDays, since,
    totals: { items: list.length, picked: ranked.length, hits: totalHits, locations: locs.length, currentTravel: P.round2(current), proposedTravel: P.round2(proposed), gain, gainPct: current > 0 ? P.round1((100 * gain) / current) : 0, moves: proposals.length },
    items: list.sort((a, b) => b.hits - a.hits || natural(a.name, b.name)).map((x) => {
      const l = locById.get(x.primary);
      return { itemId: x.itemId, name: x.name, unit: x.unit, sku: x.sku, hits: x.hits, units: x.units, velocity: x.velocity, weight: x.weight, heavy: isHeavy(x), location: l.code, locationId: l.id, distance: l.distance, level: l.level, quantity: x.quantity, proposed: pos.get(x.itemId) === x.primary ? null : locById.get(pos.get(x.itemId)).code, pending: busy.has(x.itemId) };
    }),
    proposals,
  };
}

// ---------- Réglages ----------
const num = (v, min, max, msg) => { const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, msg); return n; };
router.get('/slotting/config', async (req, res) => {
  const p = await P.pilotOf(req.org.id);
  res.json({ config: { slotDays: p.slotDays, aislePitch: p.aislePitch, rackPitch: p.rackPitch, heavyKg: p.heavyKg, heavyMaxLevel: p.heavyMaxLevel, aisleDistances: p.aisleDistances } });
});
router.put('/slotting/config', mgr, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.slotDays !== undefined && b.slotDays !== '') { const n = Number(b.slotDays); if (!Number.isInteger(n) || n < 1 || n > 730) throw new HttpError(400, 'Période : un nombre entier de jours, de 1 à 730.'); patch.slotDays = n; }
  if (b.aislePitch !== undefined && b.aislePitch !== '') patch.aislePitch = num(b.aislePitch, 0, 1000, 'Distance entre allées invalide (0 à 1000 m).');
  if (b.rackPitch !== undefined && b.rackPitch !== '') patch.rackPitch = num(b.rackPitch, 0, 1000, 'Distance entre rayons invalide (0 à 1000 m).');
  if (b.heavyKg !== undefined && b.heavyKg !== '') patch.heavyKg = num(b.heavyKg, 0, 100000, 'Poids « lourd » invalide.');
  if (b.heavyMaxLevel !== undefined && b.heavyMaxLevel !== '') { const n = Number(b.heavyMaxLevel); if (!Number.isInteger(n) || n < 0 || n > 50) throw new HttpError(400, 'Niveau maximal des articles lourds : un nombre entier de 0 à 50.'); patch.heavyMaxLevel = n; }
  if (b.aisleDistances !== undefined) {
    if (typeof b.aisleDistances !== 'object' || b.aisleDistances === null || Array.isArray(b.aisleDistances)) throw new HttpError(400, 'Distances par allée invalides.');
    const out = {};
    for (const [k, v] of Object.entries(b.aisleDistances)) {
      const code = String(k).trim().toUpperCase().slice(0, 10);
      if (!code || v === '' || v === null) continue;
      out[code] = num(v, 0, 100000, 'Distance d\'allée invalide.');
    }
    if (Object.keys(out).length > 200) throw new HttpError(400, '200 allées au plus.');
    patch.aisleDistances = out;
  }
  const p = await P.savePilot(req.org.id, patch);
  res.json({ ok: true, config: { slotDays: p.slotDays, aislePitch: p.aislePitch, rackPitch: p.rackPitch, heavyKg: p.heavyKg, heavyMaxLevel: p.heavyMaxLevel, aisleDistances: p.aisleDistances } });
});
router.get('/slotting/locations', async (req, res) => {
  const w = await warehouseFor(req, req.query.warehouseId);
  res.json({ warehouse: { id: Number(w.id), name: w.name }, locations: await locationsWithDistance(w.id, await P.pilotOf(req.org.id), { all: true }) });
});
router.put('/slotting/locations/:id', mgr, async (req, res) => {
  const l = await W.locationOf(req.org.id, A.id(req.params.id));
  const b = req.body || {};
  const distance = b.distance === undefined ? l.distance : b.distance === '' || b.distance === null ? null : num(b.distance, 0, 100000, 'Distance invalide (en mètres).');
  let level = l.level;
  if (b.level !== undefined) {
    if (b.level === '' || b.level === null) level = null;
    else { const n = Number(b.level); if (!Number.isInteger(n) || n < 0 || n > 50) throw new HttpError(400, 'Niveau : un nombre entier de 0 (sol) à 50.'); level = n; }
  }
  await db.prepare('UPDATE wms_locations SET distance = ?, level = ? WHERE id = ?').run(distance, level, l.id);
  res.json({ ok: true });
});
router.put('/slotting/zones/:id', mgr, async (req, res) => {
  const z = await db.prepare('SELECT * FROM wms_zones WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!z) throw new HttpError(404, 'Zone introuvable.');
  const b = req.body || {};
  const distance = b.distance === '' || b.distance === null || b.distance === undefined ? null : num(b.distance, 0, 100000, 'Distance invalide (en mètres).');
  await db.prepare('UPDATE wms_zones SET distance = ? WHERE id = ?').run(distance, z.id);
  res.json({ ok: true });
});
router.put('/slotting/items/:id', mgr, async (req, res) => {
  const it = await H().itemOf(req, req.params.id);
  const b = req.body || {};
  const w = b.weightKg === '' || b.weightKg === null || b.weightKg === undefined ? null : num(b.weightKg, 0, 100000, 'Poids invalide (en kg).');
  await db.prepare('INSERT INTO wms_item_params (item_id, org_id, weight_kg) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET weight_kg = excluded.weight_kg').run(it.id, req.org.id, w);
  res.json({ ok: true });
});

// ---------- Analyse et tâches ----------
router.get('/slotting/analysis', mgr, async (req, res) => res.json(await analyse(req, { warehouseId: req.query.warehouseId, days: req.query.days })));
router.post('/slotting/tasks', mgr, async (req, res) => {
  const b = req.body || {};
  const a = await analyse(req, { warehouseId: b.warehouseId, days: b.days });
  const only = Array.isArray(b.itemIds) && b.itemIds.length ? new Set(b.itemIds.map((x) => A.id(x))) : null;
  const created = []; const skipped = [];
  await db.transaction(async () => {
    for (const p of a.proposals) {
      if (only && !only.has(p.itemId)) continue;
      if (!(p.quantity > W.EPS)) { skipped.push({ itemId: p.itemId, name: p.name, reason: 'Ce stock est sur une palette : déplacez la palette entière.' }); continue; }
      await W.lockItem(req.org.id, p.itemId);
      if (await db.prepare("SELECT 1 FROM wms_slot_tasks WHERE item_id = ? AND status = 'open'").get(p.itemId)) { skipped.push({ itemId: p.itemId, name: p.name, reason: 'Une tâche est déjà ouverte pour cet article.' }); continue; }
      const code = await W.nextCode(req.org.id, 'SL');
      const id = Number((await db.prepare('INSERT INTO wms_slot_tasks (org_id, code, item_id, from_location_id, to_location_id, quantity, reason, hits, gain, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.org.id, code, p.itemId, p.fromLocationId, p.toLocationId, p.quantity, p.reason, p.hits, p.gain, req.user.id, nowISO())).lastInsertRowid);
      created.push({ id, code, itemId: p.itemId, from: p.from, to: p.to, quantity: p.quantity });
    }
  })();
  res.status(201).json({ created, skipped });
});
async function taskOf(req, idv) {
  const t = await db.prepare('SELECT * FROM wms_slot_tasks WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!t) throw new HttpError(404, 'Tâche introuvable.');
  return t;
}
router.get('/slotting/tasks', async (req, res) => {
  const st = TASK_STATUS[req.query.status] ? req.query.status : 'open';
  const rows = await db.prepare(`SELECT t.*, i.name, i.unit, i.sku, i.branch_id, f.code AS fc, f.aisle, f.rack, f.bin, d.code AS tc, u.name AS who FROM wms_slot_tasks t JOIN stock_items i ON i.id = t.item_id
    LEFT JOIN wms_locations f ON f.id = t.from_location_id LEFT JOIN wms_locations d ON d.id = t.to_location_id LEFT JOIN users u ON u.id = t.done_by
    WHERE t.org_id = ? AND t.status = ? ORDER BY ${st === 'open' ? 'f.aisle, f.rack, f.bin, f.code, t.id' : 't.id DESC'} LIMIT 300`).all(req.org.id, st);
  res.json({ tasks: rows.filter((r) => A.visible(req, r)).map((t) => ({ id: Number(t.id), code: t.code, status: t.status, statusLabel: TASK_STATUS[t.status], itemId: Number(t.item_id), item: t.name, unit: t.unit, sku: t.sku || '',
    from: t.fc || null, fromLocationId: t.from_location_id ? Number(t.from_location_id) : null, to: t.tc || null, toLocationId: t.to_location_id ? Number(t.to_location_id) : null,
    quantity: r3(t.quantity), doneQty: r3(t.done_qty), reason: t.reason, hits: Number(t.hits), gain: Number(t.gain), createdAt: t.created_at, doneAt: t.done_at || null, doneBy: t.who || null })) });
});
/** Exécution par scan : emplacement de départ, article, emplacement d'arrivée. La quantité déplacée est ce qui reste en vrac au départ (au plus celle de la tâche). */
router.post('/slotting/tasks/:id/confirm', async (req, res) => {
  const t0 = await taskOf(req, req.params.id);
  const b = req.body || {};
  const it = await H().itemOf(req, t0.item_id);
  if (!t0.from_location_id || !t0.to_location_id) throw new HttpError(400, "Un des emplacements de cette tâche n'existe plus : annulez-la.");
  const from = await W.locationOf(req.org.id, t0.from_location_id); const to = await W.locationOf(req.org.id, t0.to_location_id);
  if (b.fromLocationCode && String(b.fromLocationCode).trim().toUpperCase() !== from.code.toUpperCase()) throw new HttpError(400, `Ce n'est pas le bon emplacement : prenez en ${from.code}.`);
  if (b.itemCode && ![it.barcode, it.sku].filter(Boolean).map((x) => x.toUpperCase()).includes(String(b.itemCode).trim().toUpperCase())) throw new HttpError(400, `Ce n'est pas le bon article : attendu « ${it.name} ».`);
  if (b.toLocationCode && String(b.toLocationCode).trim().toUpperCase() !== to.code.toUpperCase()) throw new HttpError(400, `Ce n'est pas le bon emplacement : déposez en ${to.code}.`);
  let done;
  await db.transaction(async () => {
    const t = await W.lockRow('wms_slot_tasks', t0.id);
    if (t.status !== 'open') throw new HttpError(400, 'Cette tâche est terminée ou annulée.');
    await W.lockItem(req.org.id, t.item_id);
    const loose = await W.looseAt(from.id, t.item_id);
    const wanted = b.quantity === undefined || b.quantity === null || b.quantity === '' ? r3(Math.min(Number(t.quantity), loose)) : H().qty(b.quantity);
    if (!(wanted > W.EPS)) throw new HttpError(400, "Il n'y a plus rien à déplacer dans cet emplacement : annulez la tâche.");
    if (loose + W.EPS < wanted) throw new HttpError(400, 'Pas assez de stock en vrac dans cet emplacement (le reste est sur une palette).');
    done = wanted;
    await W.move(req, t.item_id, from.id, to.id, done, { kind: 'slotting', refKind: 'slot', refId: t.id, reason: `Optimisation ${t.code}` });
    await db.prepare("UPDATE wms_slot_tasks SET done_qty = ?, status = 'done', done_by = ?, done_at = ? WHERE id = ?").run(done, req.user.id, nowISO(), t.id);
    await P.record(req, 'slotting', { lines: 1, units: done, refKind: 'slot', refId: t.id });
  })();
  res.json({ ok: true, quantity: done, from: from.code, to: to.code });
});
router.post('/slotting/tasks/:id/cancel', mgr, async (req, res) => {
  const t0 = await taskOf(req, req.params.id);
  await db.transaction(async () => {
    const t = await W.lockRow('wms_slot_tasks', t0.id);
    if (t.status !== 'open') throw new HttpError(400, 'Cette tâche est terminée ou annulée.');
    await db.prepare("UPDATE wms_slot_tasks SET status = 'cancelled', done_by = ?, done_at = ? WHERE id = ?").run(req.user.id, nowISO(), t.id);
  })();
  res.json({ ok: true });
});

module.exports = router;
module.exports.analyse = analyse;
module.exports.locationsWithDistance = locationsWithDistance;
