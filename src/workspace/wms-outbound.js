'use strict';
// Stock entrepôt (WMS) — préparation avancée : aides communes aux vagues, à l'emballage et aux expéditions. Aucune route ici.
// Une ligne de préparation garde, dans picked_from, où se trouve physiquement la marchandise prélevée : [{ locationId, quantity, huId? }].
// Tant qu'elle est dans un emplacement utilisable, la réservation de la liste la protège ; dès qu'elle passe en dépose / emballage ou à quai
// (emplacements non disponibles à la vente), la réservation est « servie » d'autant : le disponible reste juste, sans double compte.
const { db, nowISO } = require('../db');
const W = require('./wms-core');
const { HttpError } = require('../util');

const r3 = W.round3;
const entriesOf = (line) => { try { const e = JSON.parse(line.picked_from || '[]'); return Array.isArray(e) ? e : []; } catch { return []; } };
/** Regroupe les entrées identiques (même emplacement, même colis) et retire les vides. */
function tidy(list) {
  const out = [];
  for (const e of list) {
    if (!(Number(e.quantity) > W.EPS)) continue;
    const k = out.find((x) => Number(x.locationId || 0) === Number(e.locationId || 0) && Number(x.huId || 0) === Number(e.huId || 0));
    if (k) k.quantity = r3(k.quantity + Number(e.quantity));
    else out.push({ locationId: e.locationId ? Number(e.locationId) : null, quantity: r3(e.quantity), ...(e.huId ? { huId: Number(e.huId) } : {}) });
  }
  return out;
}
const saveEntries = (lineId, list) => db.prepare('UPDATE wms_pick_lines SET picked_from = ? WHERE id = ?').run(JSON.stringify(tidy(list)), lineId);

const kindCache = new Map();
async function kindOf(locId) {
  if (!locId) return null;
  if (kindCache.has(Number(locId))) return kindCache.get(Number(locId));
  const l = await db.prepare('SELECT kind FROM wms_locations WHERE id = ?').get(locId);
  const k = l ? l.kind : null;
  if (kindCache.size > 2000) kindCache.clear();
  if (l && W.OUTBOUND.includes(k)) kindCache.set(Number(locId), k); // le type d'un emplacement ne change pas
  return k;
}
const isOutbound = async (locId) => W.OUTBOUND.includes(await kindOf(locId));

/** La marchandise d'une liste quitte le disponible (dépose, emballage) : la réservation est servie d'autant. */
const stageRes = (pickId, itemId, q) => db.prepare("UPDATE wms_reservations SET fulfilled_qty = LEAST(quantity, fulfilled_qty + ?) WHERE pick_id = ? AND item_id = ? AND status = 'active'").run(r3(q), pickId, itemId);
/** Retour dans un emplacement utilisable : la réservation reprend d'autant. */
const unstageRes = (pickId, itemId, q) => db.prepare("UPDATE wms_reservations SET fulfilled_qty = GREATEST(0, fulfilled_qty - ?) WHERE pick_id = ? AND item_id = ? AND status = 'active'").run(r3(q), pickId, itemId);

/** Article par code-barres ou référence (scan). */
async function itemByCode(orgId, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  return db.prepare('SELECT * FROM stock_items WHERE org_id = ? AND (UPPER(barcode) = UPPER(?) OR UPPER(sku) = UPPER(?)) ORDER BY id LIMIT 1').get(orgId, c, c);
}

/** Colis d'une liste : codes, état, contenu. */
async function boxesOf(pickId) {
  const rows = await db.prepare("SELECT h.*, l.code AS loc FROM wms_hus h LEFT JOIN wms_locations l ON l.id = h.location_id WHERE h.pick_id = ? AND h.status != 'empty' ORDER BY h.id").all(pickId);
  const out = [];
  for (const h of rows) {
    const contents = await db.prepare('SELECT c.*, i.name, i.unit, i.sku FROM wms_hu_contents c JOIN stock_items i ON i.id = c.item_id WHERE c.hu_id = ? ORDER BY i.name').all(h.id);
    const unit = await db.prepare("SELECT s.code, s.status FROM wms_shipment_units u JOIN wms_shipments s ON s.id = u.shipment_id WHERE u.hu_id = ? AND s.status != 'cancelled'").get(h.id);
    out.push({ id: Number(h.id), code: h.code, status: h.status, location: h.loc || null, locationId: h.location_id ? Number(h.location_id) : null, parentId: h.parent_id ? Number(h.parent_id) : null,
      weight: h.weight == null ? null : Number(h.weight), length: h.length_cm == null ? null : Number(h.length_cm), width: h.width_cm == null ? null : Number(h.width_cm), height: h.height_cm == null ? null : Number(h.height_cm),
      shipment: unit ? unit.code : null, shipmentStatus: unit ? unit.status : null,
      contents: contents.map((c) => ({ itemId: Number(c.item_id), name: c.name, unit: c.unit, sku: c.sku || '', lotNo: c.lot_no || null, quantity: r3(c.quantity) })) });
  }
  return out;
}

/** Bilan d'une liste par article : commandé (à préparer), prélevé, emballé, reste à emballer. */
async function packState(pickId) {
  const lines = await db.prepare('SELECT pl.*, i.name, i.unit, i.sku, i.barcode, i.tracking FROM wms_pick_lines pl JOIN stock_items i ON i.id = pl.item_id WHERE pl.pick_id = ? ORDER BY i.name, pl.id').all(pickId);
  const by = new Map();
  for (const l of lines) {
    const k = Number(l.item_id);
    if (!by.has(k)) by.set(k, { itemId: k, name: l.name, unit: l.unit, sku: l.sku || '', barcode: l.barcode || '', tracking: l.tracking || 'none', quantity: 0, picked: 0, packed: 0 });
    const x = by.get(k);
    x.quantity = r3(x.quantity + Number(l.quantity)); x.picked = r3(x.picked + Number(l.picked_qty));
    for (const e of entriesOf(l)) if (e.huId) x.packed = r3(x.packed + Number(e.quantity));
  }
  const items = [...by.values()].map((x) => ({ ...x, toPack: r3(Math.max(0, x.picked - x.packed)) }));
  return { lines, items, picked: r3(items.reduce((s, x) => s + x.picked, 0)), packed: r3(items.reduce((s, x) => s + x.packed, 0)), toPack: r3(items.reduce((s, x) => s + x.toPack, 0)) };
}

/**
 * Remet en stock utilisable la marchandise d'une liste annulée : ce qui est en dépose, emballé ou à quai retourne à son emplacement de prélèvement.
 * Refusé si un colis de la liste est sur une expédition en cours.
 */
async function unstagePick(req, pick) {
  const boxes = await db.prepare("SELECT * FROM wms_hus WHERE pick_id = ? AND status != 'shipped'").all(pick.id);
  for (const b of boxes) {
    const u = await db.prepare("SELECT s.code FROM wms_shipment_units u JOIN wms_shipments s ON s.id = u.shipment_id WHERE u.hu_id = ? AND s.status IN ('open','loading')").get(b.id);
    if (u) throw new HttpError(400, `Le colis ${b.code} est sur l'expédition ${u.code} : retirez-le d'abord de l'expédition.`);
  }
  const loc = {};
  for (const b of boxes) loc[Number(b.id)] = b.location_id ? Number(b.location_id) : null;
  // Les colis se défont d'abord : sinon la sortie de leur emplacement viderait d'autres colis posés au même endroit.
  for (const b of boxes) {
    await db.prepare('DELETE FROM wms_hu_contents WHERE hu_id = ?').run(b.id);
    await db.prepare('UPDATE wms_hus SET parent_id = NULL WHERE parent_id = ?').run(b.id);
    await db.prepare('DELETE FROM wms_hus WHERE id = ?').run(b.id);
    if (b.parent_id) await W.markEmpty(b.parent_id);
  }
  const lines = await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ?').all(pick.id);
  let fallback = null;
  for (const l of lines) {
    const keep = [];
    for (const e of entriesOf(l)) {
      const at = e.huId ? loc[Number(e.huId)] : e.locationId;
      if (!at || !(await isOutbound(at))) { keep.push(e); continue; }
      let to = l.location_id ? await db.prepare('SELECT * FROM wms_locations WHERE id = ?').get(l.location_id) : null;
      if (!to || !W.isUsable(to)) to = fallback || (fallback = await W.defaultOf(req.org.id));
      const q = r3(Math.min(Number(e.quantity), await W.qtyAt(at, l.item_id)));
      if (q > W.EPS) await W.move(req, l.item_id, at, to.id, q, { kind: 'unstage', refKind: 'pick', refId: pick.id, reason: `Liste ${pick.code} annulée` });
      keep.push({ locationId: Number(to.id), quantity: q });
    }
    await saveEntries(l.id, keep);
  }
}

/** Liste prête à sortir : tout ce qui a été prélevé est expédié (ou rien ne reste). */
async function closeIfShipped(req, pickId) {
  const p = await db.prepare('SELECT * FROM wms_picks WHERE id = ?').get(pickId);
  if (!p || p.status !== 'picked') return false;
  const lines = await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ?').all(p.id);
  if (lines.some((l) => entriesOf(l).some((e) => Number(e.quantity) > W.EPS))) return false;
  const now = nowISO();
  await db.prepare("UPDATE wms_reservations SET status = 'fulfilled', fulfilled_qty = quantity WHERE pick_id = ? AND status = 'active'").run(p.id);
  await db.prepare("UPDATE wms_picks SET status = 'issued', done_at = ?, shipped_at = ? WHERE id = ?").run(now, now, p.id);
  return true;
}

module.exports = { entriesOf, tidy, saveEntries, isOutbound, kindOf, stageRes, unstageRes, itemByCode, boxesOf, packState, unstagePick, closeIfShipped };
