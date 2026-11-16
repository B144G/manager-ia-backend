'use strict';
// Entrepôt (WMS) : socle partagé par stock-lib.adjust et les routes stock-wms-*.js (aucune route ici).
// Règle d'or : la quantité d'un article (stock_items.quantity) est TOUJOURS la somme de ses emplacements (wms_levels),
// emplacement « En transit » compris. La valeur du stock pour la comptabilité (acc-stock.js) reste donc quantité × coût moyen.
const { db, nowISO } = require('../db');
const { HttpError } = require('../util');
const A = require('./access');

const round3 = (n) => Math.round(n * 1000) / 1000;
const EPS = 0.0005;

// Types d'emplacement. « Disponible » = peut être servi à un client ou à un atelier ; les autres types sont comptés dans le stock (et sa valeur)
// mais ne sont ni vendables ni prélevés automatiquement.
const LOCATION_KINDS = { storage: 'Rayonnage', picking: 'Préparation', reception: 'Réception', quarantine: 'Quarantaine', returns: 'Retours', scrap: 'Rebut', transit: 'En transit' };
const USABLE_KINDS = ['storage', 'picking', 'reception'];
const ZONE_KINDS = { storage: 'Stockage', picking: 'Préparation', reception: 'Réception', quarantine: 'Quarantaine', returns: 'Retours', scrap: 'Rebut' };
const isUsable = (kind) => USABLE_KINDS.includes(kind);

const stamp = () => nowISO();

/** Entrepôt et emplacement « Principal » d'une organisation : créés à la demande (organisations nées après la migration). */
async function ensureDefault(orgId) {
  let loc = await db.prepare('SELECT * FROM wms_locations WHERE org_id = ? AND is_default = 1').get(orgId);
  if (loc) return loc;
  const now = stamp();
  await db.prepare("INSERT INTO wms_warehouses (org_id, branch_id, code, name, is_default, created_at) VALUES (?, NULL, 'PRINC', 'Entrepôt principal', 1, ?) ON CONFLICT DO NOTHING").run(orgId, now);
  const wh = await db.prepare('SELECT * FROM wms_warehouses WHERE org_id = ? AND is_default = 1').get(orgId);
  await db.prepare("INSERT INTO wms_locations (org_id, warehouse_id, code, name, kind, is_default, created_at) VALUES (?, ?, 'PRINCIPAL', 'Principal', 'storage', 1, ?) ON CONFLICT DO NOTHING").run(orgId, wh.id, now);
  loc = await db.prepare('SELECT * FROM wms_locations WHERE org_id = ? AND is_default = 1').get(orgId);
  if (!loc) throw new HttpError(409, "L'emplacement par défaut n'a pas pu être créé : réessayez.");
  return loc;
}

/** Emplacement virtuel « En transit » (marchandise expédiée, pas encore reçue). */
async function ensureTransit(orgId) {
  let loc = await db.prepare("SELECT * FROM wms_locations WHERE org_id = ? AND kind = 'transit' ORDER BY id LIMIT 1").get(orgId);
  if (loc) return loc;
  const def = await ensureDefault(orgId);
  await db.prepare("INSERT INTO wms_locations (org_id, warehouse_id, code, name, kind, created_at) VALUES (?, ?, 'TRANSIT', 'En transit', 'transit', ?) ON CONFLICT DO NOTHING").run(orgId, def.warehouse_id, stamp());
  loc = await db.prepare("SELECT * FROM wms_locations WHERE org_id = ? AND kind = 'transit' ORDER BY id LIMIT 1").get(orgId);
  if (!loc) throw new HttpError(409, "L'emplacement « En transit » n'a pas pu être créé : réessayez.");
  return loc;
}

const locationOf = async (orgId, id) => {
  const l = await db.prepare('SELECT l.*, w.branch_id AS branch_id, w.name AS warehouse, w.code AS warehouse_code FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE l.id = ? AND l.org_id = ?').get(id, orgId);
  if (!l) throw new HttpError(404, 'Emplacement introuvable.');
  return l;
};

/** Emplacement visible par la personne connectée (cloisonnement par antenne via l'entrepôt). */
const locationFor = async (req, id) => {
  const l = await locationOf(req.org.id, A.id(id, 'Emplacement invalide.'));
  if (!A.visible(req, l)) throw new HttpError(404, 'Emplacement introuvable.');
  return l;
};

/** Niveaux d'un article par emplacement (avec le type et l'entrepôt). */
const levelRows = async (itemId) => (await db.prepare(`SELECT v.location_id, v.quantity, l.code, l.name, l.kind, l.warehouse_id, l.is_default, w.name AS warehouse, w.branch_id AS branch_id
  FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE v.item_id = ? AND v.quantity > 0 ORDER BY l.kind = 'transit', l.code`).all(itemId));

const levelAt = async (itemId, locId) => {
  const r = await db.prepare('SELECT quantity FROM wms_levels WHERE item_id = ? AND location_id = ?').get(itemId, locId);
  return r ? r.quantity : 0;
};

/** Quantité d'un article dans un emplacement (ou dans tous les emplacements de ce type). */
const usableQty = async (itemId) => round3((await db.prepare(`SELECT COALESCE(SUM(v.quantity), 0) q FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id WHERE v.item_id = ? AND l.kind IN ('storage','picking','reception')`).get(itemId)).q);

/** Ajoute (ou retire) une quantité dans un emplacement. Ne jamais appeler hors transaction avec l'article verrouillé. */
async function bump(orgId, itemId, locId, delta) {
  delta = round3(delta);
  if (!delta) return;
  if (delta > 0) {
    await db.prepare('INSERT INTO wms_levels (org_id, item_id, location_id, quantity) VALUES (?, ?, ?, ?) ON CONFLICT (item_id, location_id) DO UPDATE SET quantity = wms_levels.quantity + EXCLUDED.quantity').run(orgId, itemId, locId, delta);
  } else {
    const r = await db.prepare('UPDATE wms_levels SET quantity = quantity + ? WHERE item_id = ? AND location_id = ? AND quantity + ? >= -0.0005').run(delta, itemId, locId, delta);
    if (!r.changes) throw new HttpError(400, "Pas assez de stock dans cet emplacement.");
    await db.prepare('DELETE FROM wms_levels WHERE item_id = ? AND location_id = ? AND quantity <= 0.0005').run(itemId, locId);
  }
}

/** Remet d'accord les emplacements et la quantité de l'article si une écriture directe les a séparés (anciens scripts, import). */
async function reconcile(orgId, it) {
  const sum = round3((await db.prepare('SELECT COALESCE(SUM(quantity), 0) q FROM wms_levels WHERE item_id = ?').get(it.id)).q);
  const diff = round3(it.quantity - sum);
  if (Math.abs(diff) < EPS) return;
  if (diff > 0) { await bump(orgId, it.id, (await ensureDefault(orgId)).id, diff); return; }
  let left = -diff;
  for (const l of await db.prepare('SELECT * FROM wms_levels WHERE item_id = ? ORDER BY quantity DESC').all(it.id)) {
    if (left <= EPS) break;
    const take = round3(Math.min(l.quantity, left));
    await bump(orgId, it.id, l.location_id, -take);
    left = round3(left - take);
  }
}

/** Place restante dans un emplacement (null = illimité). */
async function room(loc) {
  if (loc.capacity === null || loc.capacity === undefined) return Infinity;
  const used = (await db.prepare('SELECT COALESCE(SUM(quantity), 0) q FROM wms_levels WHERE location_id = ?').get(loc.id)).q;
  return round3(Math.max(Number(loc.capacity) - used, 0));
}

/** Règles de rangement : où ranger une entrée de `qty`. Plusieurs emplacements si un seul est trop petit ; le reste va à l'emplacement par défaut. */
async function putawayParts(orgId, it, qty) {
  const rules = await db.prepare(`SELECT r.*, l.active, l.capacity, l.kind FROM wms_putaway_rules r JOIN wms_locations l ON l.id = r.location_id
    WHERE r.org_id = ? AND (r.item_id = ? OR (r.item_id IS NULL AND (r.tracking IS NULL OR r.tracking = ?))) AND l.active = 1 AND l.kind <> 'transit'
    ORDER BY r.item_id IS NULL, r.priority, r.id`).all(orgId, it.id, it.tracking || 'none');
  const parts = []; let left = qty; const seen = new Set();
  for (const r of rules) {
    if (left <= EPS) break;
    if (seen.has(r.location_id)) continue;
    seen.add(r.location_id);
    const free = await room({ id: r.location_id, capacity: r.capacity });
    const put = round3(Math.min(free, left));
    if (put > EPS) { parts.push({ locationId: r.location_id, quantity: put }); left = round3(left - put); }
  }
  if (left > EPS) parts.push({ locationId: (await ensureDefault(orgId)).id, quantity: left, fallback: true });
  return parts;
}

/**
 * Plan de répartition d'un mouvement dans les emplacements : [{ locationId, quantity }] (quantité signée).
 * Entrée : emplacement demandé (opts.locationId) sinon règles de rangement sinon « Principal ». Sortie : emplacement demandé, sinon on prélève
 * dans les emplacements disponibles (préparation d'abord, puis les plus petites quantités pour vider les bacs).
 */
async function plan(req, it, delta, opts = {}) {
  const orgId = req.org.id;
  await reconcile(orgId, it);
  if (delta > 0) {
    if (opts.locationId) {
      const loc = await locationOf(orgId, Number(opts.locationId));
      if (!loc.active) throw new HttpError(400, `L'emplacement ${loc.code} est désactivé.`);
      if (loc.kind === 'transit' && !opts.allowTransit) throw new HttpError(400, "L'emplacement « En transit » ne reçoit que des transferts.");
      if (delta - (await room(loc)) > EPS) throw new HttpError(400, `L'emplacement ${loc.code} est plein (capacité ${loc.capacity}).`);
      return [{ locationId: loc.id, quantity: delta }];
    }
    return (await putawayParts(orgId, it, delta)).map((p) => ({ locationId: p.locationId, quantity: p.quantity }));
  }
  const need = -delta;
  if (opts.locationId) {
    const loc = await locationOf(orgId, Number(opts.locationId));
    const have = await levelAt(it.id, loc.id);
    if (have + EPS < need) throw new HttpError(400, `Pas assez de « ${it.name} » à l'emplacement ${loc.code} : il y en a ${have} ${it.unit}.`);
    return [{ locationId: loc.id, quantity: -need, kind: loc.kind }];
  }
  const rows = (await levelRows(it.id)).filter((l) => isUsable(l.kind));
  rows.sort((a, b) => (a.kind === 'picking' ? 0 : 1) - (b.kind === 'picking' ? 0 : 1) || a.quantity - b.quantity || a.location_id - b.location_id);
  const usable = round3(rows.reduce((a, l) => a + l.quantity, 0));
  if (usable + EPS < need) throw new HttpError(400, `Stock disponible insuffisant pour « ${it.name} » : ${usable} ${it.unit} utilisable(s) sur ${it.quantity} (le reste est en transit, en quarantaine, en retour ou au rebut).`);
  const parts = []; let left = need;
  for (const l of rows) {
    if (left <= EPS) break;
    const take = round3(Math.min(l.quantity, left));
    parts.push({ locationId: l.location_id, quantity: -take, kind: l.kind });
    left = round3(left - take);
  }
  return parts;
}

/** Applique le plan et renvoie les parties (chacune garde son emplacement pour l'historique). */
async function applyPlan(orgId, itemId, parts) {
  for (const p of parts) await bump(orgId, itemId, p.locationId, p.quantity);
}

/** Journal des déplacements internes (transferts, rangement, retours…) : n'a aucun effet sur la quantité totale. */
async function logMove(req, it, { from, to, quantity, kind, reason, refKind, refId }) {
  await db.prepare('INSERT INTO wms_moves (org_id, item_id, from_location_id, to_location_id, quantity, kind, reason, ref_kind, ref_id, unit_value, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, it.id, from || null, to || null, quantity, kind || 'move', String(reason || '').slice(0, 150), refKind || '', refId || null, Number(it.avg_cost) > 0 ? Number(it.avg_cost) : Number(it.unit_cost) || 0, req.user ? req.user.id : null, stamp());
}

/** Déplace `qty` d'un article d'un emplacement à un autre (même organisation). L'article doit déjà être verrouillé (FOR UPDATE). */
async function relocate(req, it, fromId, toId, qty, meta = {}) {
  qty = round3(qty);
  if (qty <= 0) throw new HttpError(400, 'Quantité invalide : indiquez un nombre positif.');
  if (fromId === toId) throw new HttpError(400, "L'emplacement de départ et celui d'arrivée sont identiques.");
  const to = await locationOf(req.org.id, toId);
  const from = await locationOf(req.org.id, fromId);
  if (!to.active) throw new HttpError(400, `L'emplacement ${to.code} est désactivé.`);
  if (to.kind === 'transit' && !meta.allowTransit) throw new HttpError(400, "L'emplacement « En transit » ne reçoit que des transferts.");
  const have = await levelAt(it.id, from.id);
  if (have + EPS < qty) throw new HttpError(400, `Pas assez de « ${it.name} » à l'emplacement ${from.code} : il y en a ${have} ${it.unit}.`);
  if (qty - (await room(to)) > EPS) throw new HttpError(400, `L'emplacement ${to.code} est plein (capacité ${to.capacity}).`);
  await bump(req.org.id, it.id, from.id, -qty);
  await bump(req.org.id, it.id, to.id, qty);
  await logMove(req, it, { from: from.id, to: to.id, quantity: qty, kind: meta.kind, reason: meta.reason, refKind: meta.refKind, refId: meta.refId });
}

/** Emplacement « Retours » (marchandise revenue, en attente de décision) : créé à la demande dans l'entrepôt principal. */
async function ensureReturns(orgId) {
  let loc = await db.prepare("SELECT * FROM wms_locations WHERE org_id = ? AND kind IN ('returns','quarantine') AND active = 1 ORDER BY (kind = 'returns') DESC, id LIMIT 1").get(orgId);
  if (loc) return loc;
  const def = await ensureDefault(orgId);
  await db.prepare("INSERT INTO wms_locations (org_id, warehouse_id, code, name, kind, created_at) VALUES (?, ?, 'RETOURS', 'Retours à contrôler', 'returns', ?) ON CONFLICT DO NOTHING").run(orgId, def.warehouse_id, stamp());
  loc = await db.prepare("SELECT * FROM wms_locations WHERE org_id = ? AND code = 'RETOURS'").get(orgId);
  return loc;
}

/** Numéro de document suivant (TR-2026-001…), par organisation, type et année : sans trou ni doublon (même en cas de demandes simultanées). Dans la transaction du document. */
async function nextCode(orgId, kind, prefix) {
  const year = nowISO().slice(0, 4);
  const row = await db.prepare('INSERT INTO doc_sequences (org_id, kind, year, last) VALUES (?, ?, ?, 1) ON CONFLICT (org_id, kind, year) DO UPDATE SET last = doc_sequences.last + 1 RETURNING last').get(orgId, kind, year);
  return `${prefix}-${year}-${String(row.last).padStart(3, '0')}`;
}

/** Emplacement qui reçoit les arrivées d'un entrepôt : « Réception » d'abord, sinon un rayonnage, sinon l'emplacement par défaut. */
async function warehouseDefault(orgId, whId) {
  const l = await db.prepare(`SELECT * FROM wms_locations WHERE org_id = ? AND warehouse_id = ? AND active = 1 AND kind IN ('reception','storage','picking') ORDER BY (kind = 'reception') DESC, is_default DESC, id LIMIT 1`).get(orgId, whId);
  if (!l) throw new HttpError(409, "Cet entrepôt n'a aucun emplacement actif : créez-en un avant de recevoir du stock.");
  return l;
}

/** Prélèvement dans UN entrepôt : emplacements disponibles de cet entrepôt (préparation d'abord, puis les plus petites quantités). */
async function planFromWarehouse(it, whId, qty) {
  const rows = (await levelRows(it.id)).filter((l) => l.warehouse_id === whId && isUsable(l.kind));
  rows.sort((a, b) => (a.kind === 'picking' ? 0 : 1) - (b.kind === 'picking' ? 0 : 1) || a.quantity - b.quantity || a.location_id - b.location_id);
  const have = round3(rows.reduce((a, l) => a + l.quantity, 0));
  if (have + EPS < qty) throw new HttpError(400, `Pas assez de « ${it.name} » disponible dans cet entrepôt : ${have} ${it.unit}.`);
  const parts = []; let left = qty;
  for (const l of rows) { if (left <= EPS) break; const take = round3(Math.min(l.quantity, left)); parts.push({ locationId: l.location_id, quantity: take }); left = round3(left - take); }
  return parts;
}

// ---------- Réservations ----------
/** Libère les réservations dont la commande est annulée ou supprimée, ou dont la date limite est passée (appelé avant tout calcul de disponible). */
async function sweep(orgId) {
  const now = stamp();
  await db.prepare(`UPDATE wms_reservations SET status = 'released', closed_at = ?, close_reason = 'Commande annulée ou supprimée'
    WHERE org_id = ? AND status = 'active' AND source_kind = 'document' AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = wms_reservations.source_id AND d.org_id = wms_reservations.org_id AND d.status NOT IN ('cancelled','refused'))`).run(now, orgId);
  await db.prepare("UPDATE wms_reservations SET status = 'released', closed_at = ?, close_reason = 'Date limite dépassée' WHERE org_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at < ?").run(now, orgId, now.slice(0, 10));
}
/** Quantité encore réservée (non livrée) d'un article. */
const reservedQty = async (itemId) => round3((await db.prepare("SELECT COALESCE(SUM(quantity - fulfilled_qty), 0) q FROM wms_reservations WHERE item_id = ? AND status = 'active'").get(itemId)).q);

/** Disponibilité de tous les articles d'une organisation : { quantity, usable, reserved, available } par article. */
async function availabilityMap(orgId) {
  await sweep(orgId);
  const rows = await db.prepare(`SELECT i.id, i.quantity,
      COALESCE((SELECT SUM(v.quantity) FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id WHERE v.item_id = i.id AND l.kind IN ('storage','picking','reception')), 0) AS usable,
      COALESCE((SELECT SUM(r.quantity - r.fulfilled_qty) FROM wms_reservations r WHERE r.item_id = i.id AND r.status = 'active'), 0) AS reserved
    FROM stock_items i WHERE i.org_id = ?`).all(orgId);
  const m = new Map();
  for (const r of rows) {
    m.set(r.id, { quantity: r.quantity, usable: round3(r.usable), reserved: round3(r.reserved), available: Math.max(round3(r.usable - r.reserved), 0), short: round3(r.reserved - r.usable) > EPS ? round3(r.reserved - r.usable) : 0 });
  }
  return m;
}

/** Refuse qu'une sortie / un déplacement entame du stock réservé. `covered` = part de la sortie qui consomme justement une réservation. */
async function reservedGuard(it, qty, covered = 0) {
  await sweep(it.org_id);
  const usable = await usableQty(it.id);
  const reserved = await reservedQty(it.id);
  if (usable - reserved + covered + EPS < qty) {
    const free = Math.max(round3(usable - reserved + covered), 0);
    throw new HttpError(409, `« ${it.name} » : ${free} ${it.unit} disponible(s) à promettre seulement (${usable} en stock utilisable, dont ${round3(reserved - covered)} réservé(s)). Libérez une réservation ou réduisez la quantité.`);
  }
}

/**
 * Sortie de stock disponible : consomme les réservations visées (réservation précisée, ou commande liée à la livraison) puis vérifie
 * que le reste ne mord pas sur d'autres réservations. Appelée par adjust() ; la ligne de réservation est verrouillée.
 */
async function takeOut(req, it, qty, opts = {}) {
  const orgId = req.org.id;
  await sweep(orgId);
  const uses = []; let covered = 0;
  let rows = [];
  if (opts.reservationId) rows = await db.prepare("SELECT * FROM wms_reservations WHERE id = ? AND org_id = ? AND item_id = ? AND status = 'active' FOR UPDATE").all(opts.reservationId, orgId, it.id);
  else if (opts.refKind === 'delivery' && opts.refId) {
    const d = await db.prepare('SELECT doc_id FROM logistics_deliveries WHERE id = ? AND org_id = ?').get(opts.refId, orgId);
    if (d && d.doc_id) rows = await db.prepare("SELECT * FROM wms_reservations WHERE org_id = ? AND item_id = ? AND status = 'active' AND source_kind = 'document' AND source_id = ? ORDER BY id FOR UPDATE").all(orgId, it.id, d.doc_id);
  }
  let left = qty;
  for (const r of rows) {
    if (left <= EPS) break;
    const take = round3(Math.min(left, r.quantity - r.fulfilled_qty));
    if (take > EPS) { uses.push({ r, take }); covered = round3(covered + take); left = round3(left - take); }
  }
  await reservedGuard(it, qty, covered);
  for (const u of uses) {
    const done = round3(u.r.fulfilled_qty + u.take);
    const full = done + EPS >= u.r.quantity;
    await db.prepare('UPDATE wms_reservations SET fulfilled_qty = ?, status = ?, closed_at = ?, close_reason = ? WHERE id = ?').run(done, full ? 'fulfilled' : 'active', full ? stamp() : null, full ? 'Livrée' : '', u.r.id);
  }
  return covered;
}

/** Libère les réservations d'un document (commande annulée ou supprimée). Renvoie le nombre de réservations libérées. */
async function releaseForDocument(orgId, docId, reason, userId) {
  const r = await db.prepare("UPDATE wms_reservations SET status = 'released', closed_at = ?, closed_by = ?, close_reason = ? WHERE org_id = ? AND status = 'active' AND source_kind = 'document' AND source_id = ?").run(stamp(), userId || null, String(reason || 'Commande annulée').slice(0, 150), orgId, docId);
  return r.changes;
}

/** Verrouille un article (pour une opération qui ne passe pas par adjust). */
async function lockItem(orgId, id) {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ? FOR UPDATE').get(id, orgId);
  if (!it) throw new HttpError(404, 'Article introuvable.');
  return it;
}

/** Contrôle de cohérence : articles dont la quantité diffère de la somme de leurs emplacements. */
async function integrity(orgId) {
  return await db.prepare(`SELECT i.id, i.name, i.quantity, COALESCE((SELECT SUM(v.quantity) FROM wms_levels v WHERE v.item_id = i.id), 0) AS levels
    FROM stock_items i WHERE i.org_id = ? AND ABS(i.quantity - COALESCE((SELECT SUM(v.quantity) FROM wms_levels v WHERE v.item_id = i.id), 0)) > 0.0005`).all(orgId);
}

module.exports = { ensureReturns, sweep, reservedQty, availabilityMap, takeOut, releaseForDocument, nextCode, warehouseDefault, planFromWarehouse, reservedGuard, locationFor, LOCATION_KINDS, ZONE_KINDS, USABLE_KINDS, isUsable, ensureDefault, ensureTransit, locationOf, levelRows, levelAt, usableQty, bump, reconcile, room, putawayParts, plan, applyPlan, logMove, relocate, lockItem, integrity, round3, EPS };
