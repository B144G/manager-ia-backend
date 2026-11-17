'use strict';
// Stock WMS : lots et numéros de série PAR EMPLACEMENT. Les lots (stock_lots) restent globaux comme avant (même quantité par lot) ; wms_lot_levels dit où se trouve chaque lot.
// Invariants : somme des emplacements d'un lot = quantité du lot ; somme des lots présents dans un emplacement = quantité de l'article dans cet emplacement.
// Si une écriture directe les a séparés, sync() reconstruit la répartition (premier entré, premier placé). Les séries portent leur emplacement (stock_serials.location_id).
const { db } = require('../db');
const { HttpError } = require('../util');
const W = require('./wms-core'); // fusion : couche d'entrepôt de A (wms_stock) ; B utilisait wms-lib / wms_levels
const kindUsable = (kind) => W.USABLE.includes(kind);
/** Quantités par emplacement d'un article (forme attendue par ce fichier). */
const levelRows = async (itemId) => (await db.prepare(`SELECT s.location_id, s.quantity, l.kind, l.code, l.warehouse_id FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND s.quantity > 0 ORDER BY s.location_id`).all(itemId))
  .map((r) => ({ location_id: Number(r.location_id), quantity: Number(r.quantity), kind: r.kind, code: r.code, warehouse_id: Number(r.warehouse_id) }));

const round3 = (n) => Math.round(n * 1000) / 1000;
const EPS = 0.0005;
const today = () => new Date().toISOString().slice(0, 10);

/** Répartition des lots par emplacement, remise d'accord avec les quantités si besoin. */
async function sync(it) {
  if (it.tracking === 'serial') return syncSerials(it);
  if (it.tracking !== 'lot') return;
  const lots = await db.prepare('SELECT id, quantity FROM stock_lots WHERE item_id = ? AND quantity > 0 ORDER BY received_at, id').all(it.id);
  const levels = await db.prepare('SELECT location_id, quantity FROM wms_stock WHERE item_id = ? AND quantity > 0 ORDER BY location_id').all(it.id);
  const cells = await db.prepare('SELECT c.lot_id, c.location_id, c.quantity FROM wms_lot_levels c JOIN stock_lots l ON l.id = c.lot_id WHERE l.item_id = ? AND c.quantity > 0').all(it.id);
  const byLot = new Map(); const byLoc = new Map();
  for (const c of cells) { byLot.set(c.lot_id, (byLot.get(c.lot_id) || 0) + c.quantity); byLoc.set(c.location_id, (byLoc.get(c.location_id) || 0) + c.quantity); }
  const ok = lots.every((l) => Math.abs((byLot.get(l.id) || 0) - l.quantity) < EPS) && levels.every((v) => Math.abs((byLoc.get(v.location_id) || 0) - v.quantity) < EPS)
    && cells.every((c) => lots.some((l) => l.id === c.lot_id) && levels.some((v) => v.location_id === c.location_id));
  if (ok) return;
  await db.prepare('DELETE FROM wms_lot_levels WHERE lot_id IN (SELECT id FROM stock_lots WHERE item_id = ?)').run(it.id);
  const room = levels.map((v) => ({ id: v.location_id, left: v.quantity }));
  let k = 0;
  for (const l of lots) {
    let left = l.quantity;
    while (left > EPS && k < room.length) {
      const take = round3(Math.min(left, room[k].left));
      if (take > EPS) await db.prepare('INSERT INTO wms_lot_levels (lot_id, location_id, quantity) VALUES (?, ?, ?) ON CONFLICT (lot_id, location_id) DO UPDATE SET quantity = wms_lot_levels.quantity + EXCLUDED.quantity').run(l.id, room[k].id, take);
      room[k].left = round3(room[k].left - take); left = round3(left - take);
      if (room[k].left <= EPS) k++;
    }
  }
}

async function syncSerials(it) {
  const ser = await db.prepare("SELECT id, location_id FROM stock_serials WHERE item_id = ? AND status = 'in_stock' ORDER BY id").all(it.id);
  const levels = await db.prepare('SELECT location_id, quantity FROM wms_stock WHERE item_id = ? AND quantity > 0 ORDER BY location_id').all(it.id);
  const count = new Map(); for (const s of ser) count.set(s.location_id, (count.get(s.location_id) || 0) + 1);
  if (levels.every((v) => count.get(v.location_id) === v.quantity) && [...count.keys()].every((k) => levels.some((v) => v.location_id === k))) return;
  const room = levels.map((v) => ({ id: v.location_id, left: v.quantity })); let k = 0;
  for (const s of ser) {
    while (k < room.length && room[k].left < 1) k++;
    const loc = k < room.length ? room[k].id : (levels[0] ? levels[0].location_id : null);
    if (k < room.length) room[k].left -= 1;
    await db.prepare('UPDATE stock_serials SET location_id = ? WHERE id = ?').run(loc, s.id);
  }
}

const addCell = (lotId, locId, q) => db.prepare('INSERT INTO wms_lot_levels (lot_id, location_id, quantity) VALUES (?, ?, ?) ON CONFLICT (lot_id, location_id) DO UPDATE SET quantity = wms_lot_levels.quantity + EXCLUDED.quantity').run(lotId, locId, round3(q));
async function subCell(lotId, locId, q) {
  const r = await db.prepare('UPDATE wms_lot_levels SET quantity = quantity - ? WHERE lot_id = ? AND location_id = ? AND quantity - ? >= -0.0005').run(round3(q), lotId, locId, round3(q));
  if (!r.changes) throw new HttpError(409, 'Répartition des lots incohérente : réessayez.');
  await db.prepare('DELETE FROM wms_lot_levels WHERE lot_id = ? AND location_id = ? AND quantity <= 0.0005').run(lotId, locId);
}

/** Entrée de lots : les quantités des lots (allocations) sont rangées dans les emplacements du plan, dans l'ordre. */
async function lotsIn(allocations, parts) {
  const slots = parts.map((p) => ({ id: p.locationId, left: p.quantity }));
  let k = 0;
  for (const a of allocations) {
    let left = a.quantity;
    while (left > EPS && k < slots.length) {
      const take = round3(Math.min(left, slots[k].left));
      if (take > EPS) await addCell(a.lotId, slots[k].id, take);
      slots[k].left = round3(slots[k].left - take); left = round3(left - take);
      if (slots[k].left <= EPS) k++;
    }
  }
}

/**
 * Sortie de lots : FEFO ou FIFO (selon l'article) parmi les lots présents dans les emplacements autorisés (celui demandé, sinon les emplacements disponibles).
 * Met à jour les lots et leur répartition. Renvoie { allocations, parts } (parts = quantités négatives par emplacement, avec leur type).
 */
async function lotsOut(it, need, opts = {}) {
  const levels = await levelRows(it.id);
  const kindOf = new Map(levels.map((l) => [l.location_id, l.kind]));
  const qOf = new Map(levels.map((l) => [l.location_id, l.quantity]));
  const allowed = (locId) => (opts.locationId ? locId === Number(opts.locationId) : kindUsable(kindOf.get(locId)));
  const order = it.pick_rule === 'fifo' ? 'l.received_at, l.id' : 'l.expiry IS NULL, l.expiry, l.received_at, l.id';
  const lots = await db.prepare(`SELECT l.* FROM stock_lots l WHERE l.item_id = ? AND l.quantity > 0 ORDER BY ${order}`).all(it.id);
  // preferLot ({ lotNo, expiry }) : la sortie concerne un lot précis (refus au contrôle qualité, rebut d'un retour) : ce lot part d'abord (tri stable).
  const want = opts.preferLot && String(opts.preferLot.lotNo || '').trim();
  if (want) { const hit = (l) => l.lot_no === want && (!opts.preferLot.expiry || l.expiry === opts.preferLot.expiry); lots.sort((a, b) => Number(hit(b)) - Number(hit(a))); }
  const cells = await db.prepare('SELECT c.* FROM wms_lot_levels c JOIN stock_lots l ON l.id = c.lot_id WHERE l.item_id = ? AND c.quantity > 0').all(it.id);
  const t = today();
  const live = (l) => opts.allowExpired || !l.expiry || l.expiry >= t;
  const avail = round3(cells.filter((c) => allowed(c.location_id) && live(lots.find((l) => l.id === c.lot_id) || { expiry: null })).reduce((a, c) => a + c.quantity, 0));
  if (avail + EPS < need) {
    if (opts.locationId) throw new HttpError(400, `Pas assez de « ${it.name} » à l'emplacement ${(await W.locationOf(it.org_id, Number(opts.locationId))).code} : il y en a ${round3(qOf.get(Number(opts.locationId)) || 0)} ${it.unit}${avail < (qOf.get(Number(opts.locationId)) || 0) ? ' utilisables (le reste est périmé)' : ''}.`);
    const allUsable = round3(cells.filter((c) => allowed(c.location_id)).reduce((a, c) => a + c.quantity, 0));
    const expired = round3(allUsable - avail);
    if (expired > 0) throw new HttpError(400, `Stock utilisable insuffisant pour « ${it.name} » : il reste ${avail} ${it.unit} hors lots périmés (${expired} ${it.unit} périmés).`);
    if (round3(it.quantity) - allUsable > EPS && allUsable + EPS >= 0) throw new HttpError(400, `Stock disponible insuffisant pour « ${it.name} » : ${allUsable} ${it.unit} utilisable(s) sur ${it.quantity} (le reste est en transit, en quarantaine, en retour ou au rebut).`);
    throw new HttpError(400, `Stock insuffisant pour « ${it.name} » : il reste ${allUsable} ${it.unit}.`);
  }
  let left = need; const allocations = []; const parts = new Map();
  for (const l of lots) {
    if (left <= EPS) break;
    if (!live(l)) continue;
    const mine = cells.filter((c) => c.lot_id === l.id && allowed(c.location_id)).sort((a, b) => (kindOf.get(a.location_id) === 'picking' ? 0 : 1) - (kindOf.get(b.location_id) === 'picking' ? 0 : 1) || a.quantity - b.quantity || a.location_id - b.location_id);
    let take = 0;
    for (const c of mine) {
      if (left <= EPS) break;
      const q = round3(Math.min(c.quantity, left));
      await subCell(l.id, c.location_id, q);
      parts.set(c.location_id, round3((parts.get(c.location_id) || 0) + q));
      take = round3(take + q); left = round3(left - q);
    }
    if (take > 0) {
      await db.prepare('UPDATE stock_lots SET quantity = ? WHERE id = ?').run(round3(l.quantity - take), l.id);
      allocations.push({ lotId: l.id, lotNo: l.lot_no, expiry: l.expiry, quantity: take });
    }
  }
  return { allocations, parts: [...parts.entries()].map(([locationId, q]) => ({ locationId, quantity: -q, kind: kindOf.get(locationId) })) };
}

/** Déplace des lots d'un emplacement à un autre (relocate) : lotId précisé, sinon dans l'ordre FEFO / FIFO. */
async function moveLots(it, fromId, toId, qty, lotId) {
  const order = it.pick_rule === 'fifo' ? 'l.received_at, l.id' : 'l.expiry IS NULL, l.expiry, l.received_at, l.id';
  const rows = await db.prepare(`SELECT c.lot_id, c.quantity FROM wms_lot_levels c JOIN stock_lots l ON l.id = c.lot_id WHERE l.item_id = ? AND c.location_id = ? AND c.quantity > 0${lotId ? ' AND c.lot_id = ?' : ''} ORDER BY ${order}`).all(it.id, fromId, ...(lotId ? [lotId] : []));
  let left = qty;
  for (const c of rows) {
    if (left <= EPS) break;
    const q = round3(Math.min(c.quantity, left));
    await subCell(c.lot_id, fromId, q); await addCell(c.lot_id, toId, q); left = round3(left - q);
  }
  if (left > EPS) throw new HttpError(400, lotId ? 'Ce lot n\'a pas assez de quantité à cet emplacement.' : 'Répartition des lots incohérente : réessayez.');
}

/** Séries : entrée (emplacements du plan, dans l'ordre), sortie (parts déduites de leurs emplacements), déplacement. */
async function serialsIn(orgId, serials, parts) {
  let i = 0;
  for (const p of parts) for (let n = 0; n < p.quantity && i < serials.length; n++, i++) await db.prepare('UPDATE stock_serials SET location_id = ? WHERE org_id = ? AND serial = ?').run(p.locationId, orgId, serials[i]);
}
async function serialsOutParts(orgId, it, serials, opts = {}) {
  const levels = await levelRows(it.id);
  const kindOf = new Map(levels.map((l) => [l.location_id, l.kind]));
  const by = new Map();
  for (const s of serials) {
    const row = await db.prepare("SELECT location_id FROM stock_serials WHERE org_id = ? AND serial = ? AND item_id = ? AND status = 'in_stock'").get(orgId, s, it.id);
    if (!row) continue; // l'erreur « pas en stock » est levée par adjust
    if (opts.locationId && row.location_id !== Number(opts.locationId)) throw new HttpError(400, `Le numéro de série ${s} n'est pas à l'emplacement demandé.`);
    if (!opts.locationId && !kindUsable(kindOf.get(row.location_id))) throw new HttpError(400, `Le numéro de série ${s} n'est pas dans un emplacement disponible (transit, quarantaine, retour ou rebut).`);
    by.set(row.location_id, (by.get(row.location_id) || 0) + 1);
  }
  return [...by.entries()].map(([locationId, q]) => ({ locationId, quantity: -q, kind: kindOf.get(locationId) }));
}
async function moveSerials(orgId, it, fromId, toId, qty, serials) {
  let list = serials;
  if (!list || !list.length) list = (await db.prepare("SELECT serial FROM stock_serials WHERE org_id = ? AND item_id = ? AND status = 'in_stock' AND location_id = ? ORDER BY id LIMIT ?").all(orgId, it.id, fromId, Math.round(qty))).map((r) => r.serial);
  if (list.length !== Math.round(qty)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : indiquez ${Math.round(qty)} numéro(s) présent(s) à cet emplacement.`);
  for (const s of list) {
    const r = await db.prepare("UPDATE stock_serials SET location_id = ? WHERE org_id = ? AND serial = ? AND item_id = ? AND status = 'in_stock' AND location_id = ?").run(toId, orgId, s, it.id, fromId);
    if (!r.changes) throw new HttpError(400, `Le numéro de série ${s} n'est pas à l'emplacement de départ.`);
  }
}

module.exports = { sync, lotsIn, lotsOut, moveLots, serialsIn, serialsOutParts, moveSerials };
