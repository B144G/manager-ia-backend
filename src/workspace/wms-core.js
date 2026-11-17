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

const KINDS = { storage: 'Rayonnage', picking: 'Préparation', reception: 'Réception', quarantine: 'Quarantaine', returns: 'Retours', scrap: 'Rebut', transit: 'En transit', staging: 'Dépose et emballage', shipping: "Quai d'expédition" };
const ZONE_KINDS = { storage: 'Stockage', picking: 'Préparation', reception: 'Réception', quarantine: 'Quarantaine', returns: 'Retours', staging: 'Dépose et emballage', shipping: 'Expédition' };
// Dépose / emballage et quai d'expédition : la marchandise préparée y attend son expédition. Elle n'est plus disponible à la vente (elle appartient à sa commande).
const OUTBOUND = ['staging', 'shipping'];
const USABLE = ['storage', 'picking', 'reception'];
const isUsable = (l) => Boolean(Number(l.active)) && USABLE.includes(l.kind);
// Ordre de prélèvement par défaut : préparation, puis rayonnage, puis réception ; ensuite le reste (jamais le transit d'abord).
const TAKE_ORDER = "CASE l.kind WHEN 'picking' THEN 0 WHEN 'storage' THEN 1 WHEN 'reception' THEN 2 WHEN 'returns' THEN 3 WHEN 'quarantine' THEN 4 WHEN 'scrap' THEN 5 WHEN 'staging' THEN 7 WHEN 'shipping' THEN 8 ELSE 6 END";

const DEFAULTS = { abcA: 80, abcB: 95, abcDays: 365, cycleA: 30, cycleB: 90, cycleC: 180, forecastWeeks: 12, serviceLevel: 95, defaultLeadDays: 7, reviewDays: 7, crossDock: 'propose' };

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
/** Emplacement de dépose / emballage (kind « staging ») ou quai d'expédition (« shipping ») d'un entrepôt : le premier actif, sinon il est créé. */
async function outboundOf(orgId, kind, warehouseId) {
  await ensure(orgId);
  const w = warehouseId ? await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(warehouseId, orgId) : await db.prepare('SELECT * FROM wms_warehouses WHERE org_id = ? AND is_default = 1').get(orgId);
  if (!w) throw new HttpError(404, 'Entrepôt introuvable.');
  const l = await db.prepare('SELECT * FROM wms_locations WHERE warehouse_id = ? AND kind = ? AND active = 1 ORDER BY id LIMIT 1').get(w.id, kind);
  if (l) return l;
  const base = (Number(w.is_default) ? '' : `${w.code}-`) + (kind === 'staging' ? 'EMBALLAGE' : 'QUAI-EXP');
  let code = base; let n = 2;
  while (await db.prepare('SELECT 1 FROM wms_locations WHERE org_id = ? AND code = ?').get(orgId, code)) code = `${base}-${n++}`;
  const id = Number((await db.prepare('INSERT INTO wms_locations (org_id, warehouse_id, code, name, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(orgId, w.id, code, kind === 'staging' ? 'Dépose et emballage' : "Quai d'expédition", kind, nowISO())).lastInsertRowid);
  return db.prepare('SELECT * FROM wms_locations WHERE id = ?').get(id);
}
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
  const l = await db.prepare('SELECT l.*, w.branch_id AS branch_id FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE l.id = ? AND l.org_id = ?').get(Number(id), orgId);
  if (!l) throw new HttpError(404, msg);
  return l;
}
/** Comme locationOf, mais respecte les antennes : un membre rattaché à une antenne ne voit que ses emplacements et ceux du commun. */
async function locationFor(req, id, msg) {
  const l = await locationOf(req.org.id, id, msg);
  if (req.member && !require('./access').visible(req, l)) throw new HttpError(404, msg || 'Emplacement introuvable.');
  return l;
}

// ---------- Quantités par emplacement ----------
const qtyAt = async (locId, itemId) => Number(((await db.prepare('SELECT quantity FROM wms_stock WHERE location_id = ? AND item_id = ?').get(locId, itemId)) || {}).quantity || 0);
async function add(orgId, locId, itemId, delta) {
  if (delta > EPS) await capacityGuard(locId, delta);
  const r = await addRaw(orgId, locId, itemId, delta);
  if (delta < 0) await trimHus(locId, itemId);
  return r;
}
async function addRaw(orgId, locId, itemId, delta) {
  const cur = await qtyAt(locId, itemId);
  const next = round3(cur + delta);
  if (next < -EPS) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  if (Math.abs(next) < EPS) await db.prepare('DELETE FROM wms_stock WHERE location_id = ? AND item_id = ?').run(locId, itemId);
  else await db.prepare('INSERT INTO wms_stock (org_id, location_id, item_id, quantity, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (location_id, item_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at').run(orgId, locId, itemId, next, nowISO());
  return next;
}
/** Capacité d'un emplacement : une entrée ne la dépasse pas (emplacements « En transit » exceptés : ils ne sont jamais limités). */
async function capacityGuard(locId, delta) {
  const l = await db.prepare('SELECT code, kind, capacity FROM wms_locations WHERE id = ?').get(locId);
  if (!l || l.capacity === null || l.capacity === undefined || l.kind === 'transit') return;
  const used = Number((await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM wms_stock WHERE location_id = ?').get(locId)).q);
  if (used + delta - Number(l.capacity) > EPS) throw new HttpError(400, `L'emplacement ${l.code} est plein : il reste ${Math.max(0, round3(Number(l.capacity) - used))} de place.`);
}
/** Quantité d'un article sur les palettes (unités de manutention) d'un emplacement. */
const huSum = async (locId, itemId) => Number((await db.prepare("SELECT COALESCE(SUM(c.quantity), 0) AS q FROM wms_hu_contents c JOIN wms_hus h ON h.id = c.hu_id WHERE h.location_id = ? AND c.item_id = ?").get(locId, itemId)).q);
/** Stock « en vrac » (hors palettes) d'un article dans un emplacement. */
const looseAt = async (locId, itemId) => round3(await qtyAt(locId, itemId) - await huSum(locId, itemId));
/** Après une sortie : si le stock de l'emplacement est passé sous le contenu de ses palettes, les palettes se vident d'autant (péremption la plus proche d'abord). */
async function trimHus(locId, itemId) {
  let excess = round3(await huSum(locId, itemId) - await qtyAt(locId, itemId));
  if (excess <= EPS) return;
  const rows = await db.prepare("SELECT c.* FROM wms_hu_contents c JOIN wms_hus h ON h.id = c.hu_id WHERE h.location_id = ? AND c.item_id = ? ORDER BY c.expiry IS NULL, c.expiry, c.quantity, c.id").all(locId, itemId);
  for (const c of rows) {
    if (excess <= EPS) break;
    const take = round3(Math.min(excess, Number(c.quantity)));
    if (Number(c.quantity) - take <= EPS) await db.prepare('DELETE FROM wms_hu_contents WHERE id = ?').run(c.id);
    else await db.prepare('UPDATE wms_hu_contents SET quantity = ? WHERE id = ?').run(round3(Number(c.quantity) - take), c.id);
    excess = round3(excess - take);
    await markEmpty(c.hu_id);
  }
}
async function markEmpty(huId) {
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM wms_hu_contents WHERE hu_id = ?').get(huId)).c);
  const kids = Number((await db.prepare("SELECT COUNT(*) AS c FROM wms_hus WHERE parent_id = ? AND status != 'empty'").get(huId)).c);
  // Un colis fermé le reste tant qu'il a du contenu ; un colis expédié garde son état.
  await db.prepare("UPDATE wms_hus SET status = CASE WHEN status = 'shipped' THEN status WHEN ? > 0 THEN (CASE WHEN status = 'closed' THEN 'closed' ELSE 'open' END) ELSE 'empty' END, updated_at = ? WHERE id = ?").run(n || kids ? 1 : 0, nowISO(), huId);
}
/**
 * Verrou de ligne (dans une transaction) : sérialise les opérations concurrentes sur un même article ou un même document
 * (double clic, deux personnes en même temps). Renvoie la ligne relue après le verrou. `table` est toujours une constante du code.
 */
async function lockRow(table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? FOR UPDATE`).get(Number(id));
}
/** Verrouille l'article (même verrou que stock-lib.adjust) : les quantités par emplacement ne se lisent et ne s'écrivent qu'une opération à la fois. */
async function lockItem(orgId, itemId) {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ? FOR UPDATE').get(Number(itemId), orgId);
  if (!it) throw new HttpError(404, 'Article introuvable.');
  return it;
}
// Emplacements « sous contrôle » : seule une personne responsable (ou plus) en sort la marchandise (contrôle qualité, décision sur un retour, rebut).
const CONTROLLED = ['quarantine', 'returns', 'scrap'];
const CONTROLLED_MSG = 'Seul un responsable peut sortir la marchandise de la quarantaine, des retours à contrôler ou du rebut.';
const canLeaveControlled = (req) => !req.member || require('./access').can(req, 'manager');
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
  const rows = await db.prepare(`SELECT s.location_id, s.quantity FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND s.quantity > 0${includeTransit ? '' : " AND l.kind NOT IN ('transit','staging','shipping')"} ORDER BY l.active DESC, ${TAKE_ORDER}, s.quantity DESC`).all(itemId);
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
  const parts = []; // renvoie où la quantité est entrée (+) ou sortie (−) : [{ locationId, quantity }] (les lots et séries suivent ces emplacements)
  if (Math.abs(diff) < EPS) return parts;
  if (diff > 0) {
    if (opts.locationId) {
      const l = await locationFor(req, opts.locationId);
      if (!Number(l.active) || (l.kind === 'transit' && !opts.allowTransit)) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
      await add(orgId, l.id, it.id, diff);
      parts.push({ locationId: Number(l.id), quantity: diff });
    } else for (const d of await destinationsFor(orgId, it, diff, opts.warehouseId)) { await add(orgId, d.location.id, it.id, d.quantity); parts.push({ locationId: Number(d.location.id), quantity: d.quantity }); }
  } else {
    let taken;
    if (opts.parts) {
      // Sortie dont les emplacements sont déjà décidés (lots ou numéros de série : on sort là où ils se trouvent).
      taken = [];
      for (const p of opts.parts) { const q = round3(-p.quantity); await locationFor(req, p.locationId); await add(orgId, Number(p.locationId), it.id, -q); taken.push({ locationId: Number(p.locationId), quantity: q }); }
      if (Math.abs(round3(taken.reduce((a, x) => a + x.quantity, 0)) + diff) > 0.0005) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
    } else {
      if (opts.locationId) {
        const l = await locationFor(req, opts.locationId);
        if (await qtyAt(l.id, it.id) + EPS < -diff) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
      }
      taken = await takeFrom(orgId, it.id, -diff, { locationId: opts.locationId });
    }
    for (const t of taken) parts.push({ locationId: t.locationId, quantity: -t.quantity });
    // Réservations par entrepôt : une sortie ne mord pas sur ce qui est réservé pour l'entrepôt d'où elle part.
    if ((await db.prepare("SELECT 1 FROM wms_reservations WHERE item_id = ? AND warehouse_id IS NOT NULL AND status = 'active' LIMIT 1").get(it.id))) {
      const whs = new Set();
      for (const t of taken) { const l = await locationOf(orgId, t.locationId); if (isUsable(l)) whs.add(Number(l.warehouse_id)); }
      const cov = opts.covered || {};
      for (const w of whs) await whGuard(it.id, w, 0, Number(cov[w] || 0));
    }
  }
  return parts;
}
/** Exécute fn avec des options d'emplacement transmises à reconcile() (sans toucher à la signature de adjust). */
async function withLocation(req, opts, fn) {
  const prev = req.__wmsOpts;
  req.__wmsOpts = opts;
  try { return await fn(); } finally { req.__wmsOpts = prev; }
}

/** Déplacement interne (aucune quantité totale ne change). */
async function move(req, itemId, fromId, toId, qty, { kind = 'internal', refKind = '', refId = null, reason = '', allowTransit = false, guardReserved = false, lotId, serials } = {}) {
  const orgId = req.org.id;
  if (Number(fromId) === Number(toId)) throw new HttpError(400, "L'emplacement de départ et celui d'arrivée sont identiques.");
  const from = await locationFor(req, fromId); const to = await locationFor(req, toId);
  if (!allowTransit && (to.kind === 'transit' || from.kind === 'transit')) throw new HttpError(400, "L'emplacement « En transit » ne reçoit que des transferts.");
  if (CONTROLLED.includes(from.kind) && !canLeaveControlled(req)) throw new HttpError(403, CONTROLLED_MSG);
  const item = await lockItem(orgId, itemId);
  if (!Number(to.active)) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
  const q = round3(qty);
  const T = item.tracking !== 'none' ? require('./wms-track') : null; // lots et numéros de série suivent le déplacement
  if (T) await T.sync(item);
  if (await qtyAt(from.id, itemId) + EPS < q) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  // Déplacement demandé par une personne (pas un flux interne) : le stock réservé ne quitte pas les emplacements disponibles, ni l'entrepôt pour lequel il est réservé.
  if (guardReserved && isUsable(from) && !isUsable(to)) await reservedGuard(itemId, q);
  if (guardReserved && isUsable(from) && (!isUsable(to) || Number(to.warehouse_id) !== Number(from.warehouse_id))) await whGuard(itemId, from.warehouse_id, q);
  await add(orgId, from.id, itemId, -q);
  await add(orgId, to.id, itemId, q);
  if (T && item.tracking === 'lot') await T.moveLots(item, from.id, to.id, q, lotId);
  else if (T && item.tracking === 'serial') await T.moveSerials(orgId, item, from.id, to.id, q, serials);
  await db.prepare('INSERT INTO wms_moves (org_id, item_id, from_location_id, to_location_id, quantity, kind, ref_kind, ref_id, reason, created_by, created_at, unit_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(orgId, itemId, from.id, to.id, q, kind, refKind, refId, String(reason || '').slice(0, 200), req.user ? req.user.id : null, nowISO(), Number(item.avg_cost) > 0 ? Number(item.avg_cost) : Number(item.unit_cost) || 0);
  return { from, to, quantity: q };
}

// ---------- Disponibilité ----------
async function expireReservations(orgId) {
  await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Réservation expirée' WHERE org_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at < ?").run(orgId, today());
  // Une commande ou un devis annulé, refusé ou supprimé libère ses réservations (à chaque calcul de disponibilité : aucun écran ne peut l'oublier).
  await db.prepare(`UPDATE wms_reservations SET status = 'released', close_reason = 'Document annulé ou refusé' WHERE org_id = ? AND status = 'active' AND source_kind = 'document'
    AND document_id IN (SELECT id FROM documents WHERE org_id = ? AND status IN ('cancelled','refused'))`).run(orgId, orgId);
  await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Document supprimé' WHERE org_id = ? AND status = 'active' AND source_kind = 'document' AND document_id IS NOT NULL AND document_id NOT IN (SELECT id FROM documents WHERE org_id = ?)").run(orgId, orgId);
}
async function reservedOf(itemId, { exceptDocument, exceptPick } = {}) {
  return round3(Number((await db.prepare(`SELECT COALESCE(SUM(quantity - fulfilled_qty), 0) AS q FROM wms_reservations WHERE item_id = ? AND status = 'active'${exceptDocument ? ' AND COALESCE(document_id, 0) != ?' : ''}${exceptPick ? ' AND COALESCE(pick_id, 0) != ?' : ''}`).get(itemId, ...(exceptDocument ? [exceptDocument] : []), ...(exceptPick ? [exceptPick] : []))).q));
}
async function usableOf(itemId) {
  return round3(Number((await db.prepare(`SELECT COALESCE(SUM(s.quantity), 0) AS q FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND l.active = 1 AND l.kind IN ('storage','picking','reception')`).get(itemId)).q));
}
async function availability(itemId, opts) {
  const usable = await usableOf(itemId); const reserved = await reservedOf(itemId, opts);
  return { usable, reserved, available: round3(usable - reserved), short: Math.max(0, round3(reserved - usable)) };
}
// ---------- Réservations par entrepôt (ligne B) ----------
/** Quantité utilisable d'un article dans un entrepôt. */
async function usableIn(itemId, warehouseId) {
  return round3(Number((await db.prepare(`SELECT COALESCE(SUM(s.quantity), 0) AS q FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND l.warehouse_id = ? AND l.active = 1 AND l.kind IN ('storage','picking','reception')`).get(itemId, warehouseId)).q));
}
/** Quantité réservée POUR un entrepôt (réservations qui portent un entrepôt). */
async function reservedFor(itemId, warehouseId) {
  return round3(Number((await db.prepare("SELECT COALESCE(SUM(quantity - fulfilled_qty), 0) AS q FROM wms_reservations WHERE item_id = ? AND warehouse_id = ? AND status = 'active'").get(itemId, warehouseId)).q));
}
/** Disponibilité par entrepôt : [{ warehouseId, usable, reserved, available }] (entrepôts qui ont du stock utilisable ou une réservation). */
async function warehouseAvailability(itemId) {
  const rows = await db.prepare(`SELECT w.id, w.code, w.name FROM wms_warehouses w WHERE w.org_id = (SELECT org_id FROM stock_items WHERE id = ?) ORDER BY w.is_default DESC, w.name`).all(itemId);
  const out = [];
  for (const w of rows) {
    const usable = await usableIn(itemId, w.id); const reserved = await reservedFor(itemId, w.id);
    if (usable > EPS || reserved > EPS) out.push({ warehouseId: Number(w.id), code: w.code, name: w.name, usable, reserved, available: round3(usable - reserved) });
  }
  return out;
}
/**
 * Garde : une sortie de `qty` hors des emplacements utilisables de l'entrepôt ne mord pas sur ce qui est réservé pour lui.
 * `covered` : quantité qui livre une réservation de cet entrepôt (elle se libère en même temps). Appelée avant (qty > 0) ou après la sortie (qty = 0).
 */
async function whGuard(itemId, warehouseId, qty, covered = 0) {
  const reserved = await reservedFor(itemId, warehouseId);
  if (reserved <= EPS) return;
  const usable = await usableIn(itemId, warehouseId);
  if (usable - qty + covered + EPS < reserved) throw new HttpError(409, `Stock réservé pour cet entrepôt : il reste ${Math.max(0, round3(usable - reserved))} disponible(s) dans l'entrepôt.`);
}
/** Garde : une sortie ou un déplacement vers un emplacement non disponible ne mord pas sur le stock réservé (toutes réservations). */
async function reservedGuard(itemId, qty, covered = 0) {
  await expireReservationsOfItem(itemId);
  const a = await availability(itemId);
  if (a.reserved > EPS && a.available + covered + EPS < qty) throw new HttpError(409, `Stock réservé : il reste ${Math.max(0, a.available)} disponible(s) (${a.reserved} réservé(s)).`);
}
const expireReservationsOfItem = async (itemId) => { const it = await db.prepare('SELECT org_id FROM stock_items WHERE id = ?').get(itemId); if (it) await expireReservations(it.org_id); };
/** Une livraison liée à une commande consomme les réservations de la commande (stock sorti = réservation livrée). */
async function consumeDocReservations(req, itemId, qty, deliveryId) {
  const d = await db.prepare('SELECT doc_id FROM logistics_deliveries WHERE id = ? AND org_id = ?').get(deliveryId, req.org.id);
  if (!d || !d.doc_id) return 0;
  const rows = await db.prepare("SELECT * FROM wms_reservations WHERE org_id = ? AND item_id = ? AND status = 'active' AND source_kind = 'document' AND document_id = ? ORDER BY id FOR UPDATE").all(req.org.id, itemId, d.doc_id);
  let left = qty; let used = 0;
  for (const r of rows) {
    if (left <= EPS) break;
    const take = round3(Math.min(left, Number(r.quantity) - Number(r.fulfilled_qty)));
    if (take <= EPS) continue;
    const done = round3(Number(r.fulfilled_qty) + take);
    await db.prepare('UPDATE wms_reservations SET fulfilled_qty = ?, status = ? WHERE id = ?').run(done, done + EPS >= Number(r.quantity) ? 'fulfilled' : 'active', r.id);
    left = round3(left - take); used = round3(used + take);
  }
  return used;
}

/** Numérotation : TR-0001, PR-0001 (préparation), RT-0001, RC-0001. */
async function nextCode(orgId, prefix) {
  const row = await db.prepare('INSERT INTO wms_counters (org_id, kind, n) VALUES (?, ?, 1) ON CONFLICT (org_id, kind) DO UPDATE SET n = wms_counters.n + 1 RETURNING n').get(orgId, prefix);
  return `${prefix}-${String(row.n).padStart(4, '0')}`;
}

module.exports = {
  KINDS, ZONE_KINDS, USABLE, OUTBOUND, outboundOf, addRaw, DEFAULTS, isUsable, lockRow, lockItem, CONTROLLED, CONTROLLED_MSG, canLeaveControlled, round3, EPS, today, ensure, settingsOf, transitOf, quarantineOf, returnsOf, defaultOf, locationOf, locationFor,
  usableIn, reservedFor, warehouseAvailability, whGuard, reservedGuard, consumeDocReservations,
  qtyAt, add, locTotal, huSum, looseAt, markEmpty, putawayPlan, destinationsFor, takeFrom, reconcile, withLocation, move, expireReservations, reservedOf, usableOf, availability, nextCode,
};
