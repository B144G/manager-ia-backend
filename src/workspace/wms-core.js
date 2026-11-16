'use strict';
// Stock entrepôt (WMS) : le cœur. Aucune route ici.
// Règle d'or : pour chaque article, la somme des quantités par emplacement (wms_stock) est TOUJOURS égale à stock_items.quantity.
// stock-lib.adjust() appelle reconcile() dans sa transaction : une entrée va dans l'emplacement demandé, sinon selon les règles de rangement,
// sinon dans l'emplacement principal ; une sortie se prend dans l'emplacement demandé, sinon dans les emplacements utilisables (préparation d'abord).
// Au premier usage, l'organisation reçoit un entrepôt principal (emplacements Principal, En transit, Retours à contrôler, Quarantaine)
// et tout son stock existant est rangé dans « Principal ».
const { db, nowISO } = require('../db');
const { HttpError } = require('../util');

const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
const EPS = 1e-9;
const today = () => nowISO().slice(0, 10);

const KINDS = { storage: 'Rayonnage', picking: 'Préparation', reception: 'Réception', quarantine: 'Quarantaine', returns: 'Retours', scrap: 'Rebut', transit: 'En transit' };
const ZONE_KINDS = { storage: 'Stockage', picking: 'Préparation', reception: 'Réception', quarantine: 'Quarantaine', returns: 'Retours' };
const USABLE = ['storage', 'picking', 'reception'];
const isUsable = (l) => Boolean(Number(l.active)) && USABLE.includes(l.kind);
// Ordre de prélèvement par défaut : préparation, puis rayonnage, puis réception ; ensuite le reste (jamais le transit d'abord).
const TAKE_ORDER = "CASE l.kind WHEN 'picking' THEN 0 WHEN 'storage' THEN 1 WHEN 'reception' THEN 2 WHEN 'returns' THEN 3 WHEN 'quarantine' THEN 4 WHEN 'scrap' THEN 5 ELSE 6 END";

const DEFAULTS = { abcA: 80, abcB: 95, abcDays: 365, cycleA: 30, cycleB: 90, cycleC: 180, forecastWeeks: 12, serviceLevel: 95, defaultLeadDays: 7, reviewDays: 7 };

// ---------- Mise en place ----------
async function ensure(orgId) {
  const r = await db.prepare("INSERT INTO wms_settings (org_id, data, created_at) VALUES (?, '{}', ?) ON CONFLICT (org_id) DO NOTHING").run(orgId, nowISO());
  if (!r.changes) return;
  const now = nowISO();
  const wh = Number((await db.prepare("INSERT INTO wms_warehouses (org_id, name, code, is_default, active, created_at) VALUES (?, 'Entrepôt principal', 'PRINCIPAL', 1, 1, ?)").run(orgId, now)).lastInsertRowid);
  const mk = (code, name, kind, def) => db.prepare('INSERT INTO wms_locations (org_id, warehouse_id, code, name, kind, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(orgId, wh, code, name, kind, def, now);
  const main = Number((await mk('PRINCIPAL', 'Principal', 'storage', 1)).lastInsertRowid);
  await mk('TRANSIT', 'En transit', 'transit', 0);
  await mk('RETOURS', 'Retours à contrôler', 'returns', 0);
  await mk('QUARANTAINE', 'Quarantaine', 'quarantine', 0);
  await db.prepare('INSERT INTO wms_stock (org_id, location_id, item_id, quantity, updated_at) SELECT org_id, ?, id, quantity, ? FROM stock_items WHERE org_id = ? AND quantity > 0').run(main, now, orgId);
}
async function settingsOf(orgId) {
  await ensure(orgId);
  const row = await db.prepare('SELECT data FROM wms_settings WHERE org_id = ?').get(orgId);
  let d = {}; try { d = JSON.parse(row.data); } catch { d = {}; }
  return { ...DEFAULTS, ...d };
}
const special = async (orgId, kind) => {
  await ensure(orgId);
  return db.prepare(`SELECT l.* FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE l.org_id = ? AND l.kind = ? ORDER BY w.is_default DESC, l.id LIMIT 1`).get(orgId, kind);
};
const transitOf = (orgId) => special(orgId, 'transit');
const quarantineOf = (orgId) => special(orgId, 'quarantine');
const returnsOf = (orgId) => special(orgId, 'returns');
/** Emplacement par défaut d'un entrepôt (ou de l'entrepôt principal). */
async function defaultOf(orgId, warehouseId) {
  await ensure(orgId);
  const w = warehouseId ? { id: warehouseId } : await db.prepare('SELECT id FROM wms_warehouses WHERE org_id = ? AND is_default = 1').get(orgId);
  let l = await db.prepare("SELECT * FROM wms_locations WHERE warehouse_id = ? AND is_default = 1 AND active = 1").get(w.id);
  if (!l) l = await db.prepare(`SELECT * FROM wms_locations WHERE warehouse_id = ? AND active = 1 AND kind IN ('storage','picking','reception') ORDER BY id LIMIT 1`).get(w.id);
  if (!l) throw new HttpError(400, "Cet entrepôt n'a aucun emplacement actif : créez-en un avant de recevoir du stock.");
  return l;
}
async function locationOf(orgId, id, msg = 'Emplacement introuvable.') {
  const l = await db.prepare('SELECT * FROM wms_locations WHERE id = ? AND org_id = ?').get(Number(id), orgId);
  if (!l) throw new HttpError(404, msg);
  return l;
}

// ---------- Quantités par emplacement ----------
const qtyAt = async (locId, itemId) => Number(((await db.prepare('SELECT quantity FROM wms_stock WHERE location_id = ? AND item_id = ?').get(locId, itemId)) || {}).quantity || 0);
async function add(orgId, locId, itemId, delta) {
  const cur = await qtyAt(locId, itemId);
  const next = round3(cur + delta);
  if (next < -EPS) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  if (Math.abs(next) < EPS) await db.prepare('DELETE FROM wms_stock WHERE location_id = ? AND item_id = ?').run(locId, itemId);
  else await db.prepare('INSERT INTO wms_stock (org_id, location_id, item_id, quantity, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (location_id, item_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at').run(orgId, locId, itemId, next, nowISO());
  return next;
}
const locTotal = async (locId) => Number((await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM wms_stock WHERE location_id = ?').get(locId)).q);

/** Destinations de rangement d'un article (règles par priorité, capacité respectée), limitées à un entrepôt si demandé. Renvoie [{ location, quantity }]. */
async function putawayPlan(orgId, it, qty, { warehouseId, exclude } = {}) {
  const rules = await db.prepare(`SELECT r.*, l.capacity, l.code FROM wms_putaway_rules r JOIN wms_locations l ON l.id = r.location_id
    WHERE r.org_id = ? AND l.active = 1 AND l.kind IN ('storage','picking','reception') AND (r.item_id = ? OR (r.item_id IS NULL AND r.tracking = ?))${warehouseId ? ' AND l.warehouse_id = ?' : ''}
    ORDER BY CASE WHEN r.item_id IS NULL THEN 1 ELSE 0 END, r.priority, r.id`).all(orgId, it.id, it.tracking || 'none', ...(warehouseId ? [warehouseId] : []));
  const plan = []; let left = round3(qty); const seen = new Set();
  for (const r of rules) {
    if (left <= EPS) break;
    const lid = Number(r.location_id);
    if (seen.has(lid) || lid === Number(exclude)) continue;
    seen.add(lid);
    let room = left;
    if (r.capacity !== null && r.capacity !== undefined) room = Math.max(0, round3(Number(r.capacity) - await locTotal(lid)));
    const take = round3(Math.min(room, left));
    if (take > EPS) { plan.push({ location: await locationOf(orgId, lid), quantity: take }); left = round3(left - take); }
  }
  return { plan, left, ruled: rules.length > 0 };
}
/** Où ranger une entrée sans emplacement : règles, sinon emplacement principal (de l'entrepôt). */
async function destinationsFor(orgId, it, qty, warehouseId) {
  const p = await putawayPlan(orgId, it, qty, { warehouseId });
  if (p.left > EPS) p.plan.push({ location: await defaultOf(orgId, warehouseId), quantity: p.left });
  return p.plan;
}

/** Sort `qty` d'un article : de l'emplacement donné, sinon dans l'ordre utile. Renvoie [{ locationId, quantity }]. */
async function takeFrom(orgId, itemId, qty, { locationId, includeTransit = false } = {}) {
  let left = round3(qty); const out = [];
  if (locationId) {
    await add(orgId, Number(locationId), itemId, -left);
    return [{ locationId: Number(locationId), quantity: left }];
  }
  const rows = await db.prepare(`SELECT s.location_id, s.quantity FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND s.quantity > 0${includeTransit ? '' : " AND l.kind != 'transit'"} ORDER BY l.active DESC, ${TAKE_ORDER}, s.quantity DESC`).all(itemId);
  for (const r of rows) {
    if (left <= EPS) break;
    const t = round3(Math.min(Number(r.quantity), left));
    await add(orgId, Number(r.location_id), itemId, -t);
    out.push({ locationId: Number(r.location_id), quantity: t });
    left = round3(left - t);
  }
  if (left > EPS && !includeTransit) return out.concat(await takeFrom(orgId, itemId, left, { includeTransit: true }));
  if (left > EPS) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  return out;
}

/**
 * Appelé par stock-lib.adjust() (même transaction) après la mise à jour de la quantité totale.
 * opts.locationId : emplacement d'entrée ou de sortie ; opts.warehouseId : entrepôt d'entrée.
 */
async function reconcile(req, it, next, o = {}) {
  const orgId = req.org.id;
  await ensure(orgId);
  const opts = { ...(req.__wmsOpts || {}), ...o };
  const sum = Number((await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM wms_stock WHERE item_id = ?').get(it.id)).q);
  const diff = round3(next - sum);
  if (Math.abs(diff) < EPS) return;
  if (diff > 0) {
    if (opts.locationId) {
      const l = await locationOf(orgId, opts.locationId);
      if (!Number(l.active) || (l.kind === 'transit' && !opts.allowTransit)) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
      await add(orgId, l.id, it.id, diff);
    } else for (const d of await destinationsFor(orgId, it, diff, opts.warehouseId)) await add(orgId, d.location.id, it.id, d.quantity);
  } else {
    if (opts.locationId) {
      const l = await locationOf(orgId, opts.locationId);
      if (await qtyAt(l.id, it.id) + EPS < -diff) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
    }
    await takeFrom(orgId, it.id, -diff, { locationId: opts.locationId });
  }
}
/** Exécute fn avec des options d'emplacement transmises à reconcile() (sans toucher à la signature de adjust). */
async function withLocation(req, opts, fn) {
  const prev = req.__wmsOpts;
  req.__wmsOpts = opts;
  try { return await fn(); } finally { req.__wmsOpts = prev; }
}

/** Déplacement interne (aucune quantité totale ne change). */
async function move(req, itemId, fromId, toId, qty, { kind = 'internal', refKind = '', refId = null, reason = '', allowTransit = false } = {}) {
  const orgId = req.org.id;
  if (Number(fromId) === Number(toId)) throw new HttpError(400, "L'emplacement de départ et celui d'arrivée sont identiques.");
  const from = await locationOf(orgId, fromId); const to = await locationOf(orgId, toId);
  if (!allowTransit && (to.kind === 'transit' || from.kind === 'transit')) throw new HttpError(400, "L'emplacement « En transit » ne reçoit que des transferts.");
  if (!Number(to.active)) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
  const q = round3(qty);
  if (await qtyAt(from.id, itemId) + EPS < q) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  await add(orgId, from.id, itemId, -q);
  await add(orgId, to.id, itemId, q);
  await db.prepare('INSERT INTO wms_moves (org_id, item_id, from_location_id, to_location_id, quantity, kind, ref_kind, ref_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(orgId, itemId, from.id, to.id, q, kind, refKind, refId, String(reason || '').slice(0, 200), req.user ? req.user.id : null, nowISO());
  return { from, to, quantity: q };
}

// ---------- Disponibilité ----------
async function expireReservations(orgId) {
  await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Réservation expirée' WHERE org_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at < ?").run(orgId, today());
}
async function reservedOf(itemId, { exceptDocument, exceptPick } = {}) {
  return round3(Number((await db.prepare(`SELECT COALESCE(SUM(quantity - fulfilled_qty), 0) AS q FROM wms_reservations WHERE item_id = ? AND status = 'active'${exceptDocument ? ' AND COALESCE(document_id, 0) != ?' : ''}${exceptPick ? ' AND COALESCE(pick_id, 0) != ?' : ''}`).get(itemId, ...(exceptDocument ? [exceptDocument] : []), ...(exceptPick ? [exceptPick] : []))).q));
}
async function usableOf(itemId) {
  return round3(Number((await db.prepare(`SELECT COALESCE(SUM(s.quantity), 0) AS q FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND l.active = 1 AND l.kind IN ('storage','picking','reception')`).get(itemId)).q));
}
async function availability(itemId, opts) {
  const usable = await usableOf(itemId); const reserved = await reservedOf(itemId, opts);
  return { usable, reserved, available: round3(usable - reserved) };
}

/** Numérotation : TR-0001, PR-0001 (préparation), RT-0001, RC-0001. */
async function nextCode(orgId, prefix) {
  const row = await db.prepare('INSERT INTO wms_counters (org_id, kind, n) VALUES (?, ?, 1) ON CONFLICT (org_id, kind) DO UPDATE SET n = wms_counters.n + 1 RETURNING n').get(orgId, prefix);
  return `${prefix}-${String(row.n).padStart(4, '0')}`;
}

module.exports = {
  KINDS, ZONE_KINDS, USABLE, DEFAULTS, isUsable, round3, EPS, today, ensure, settingsOf, transitOf, quarantineOf, returnsOf, defaultOf, locationOf,
  qtyAt, add, locTotal, putawayPlan, destinationsFor, takeFrom, reconcile, withLocation, move, expireReservations, reservedOf, usableOf, availability, nextCode,
};
