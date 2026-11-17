'use strict';
// Stock entrepôt (WMS) — transbordement (cross-docking) : la marchandise qui arrive et qu'une commande attend part directement vers la dépose
// (ou le quai d'expédition) au lieu d'être rangée.
//  - Planifié : un responsable lie à l'avance une arrivée attendue (bon de commande fournisseur, ou toute arrivée de l'article) à une commande client
//    ou une liste de préparation. À la réception, le transbordement passe « prêt » et la marchandise est mise de côté pour cette commande.
//  - Opportuniste : à chaque réception (réception WMS, réception d'achat, libération du contrôle qualité, réception sur palette), les quantités
//    attendues par les listes de préparation incomplètes et les commandes non couvertes sont détectées ; un transbordement est proposé (ou exécuté
//    tout de suite selon le réglage « crossDock » : propose, auto, off).
// Exécution (scan) : la marchandise passe de l'emplacement de réception à la dépose ; elle s'ajoute à la liste de préparation de la commande
// (ligne déjà prélevée, déposée), ou à une nouvelle liste « prélevée » si la commande n'en a pas. La réservation de la liste est servie d'autant :
// le disponible reste juste (la mise de côté du transbordement est libérée au même moment).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const H = () => require('./wms');
const F = () => require('./wms-flows');
const HU = () => require('./wms-hu');
const STATUS = { planned: 'Planifié', proposed: 'Proposé', ready: 'Prêt', done: 'Fait', cancelled: 'Annulé' };
const MODES = ['propose', 'auto', 'off'];
const PENDING = ['planned', 'proposed', 'ready'];
const ACTIVE_PICK = ['open', 'in_progress', 'picked'];
const SOURCES = { receipt: 'Réception', pur_receipt: "Réception d'achat", inspection: 'Contrôle qualité', hu: 'Réception sur palette', manual: 'Saisie' };

async function xdOf(req, idv) {
  const x = await db.prepare('SELECT * FROM wms_crossdocks WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!x) throw new HttpError(404, 'Transbordement introuvable.');
  return x;
}
const sum = (rows, f) => r3(rows.reduce((s, x) => s + Number(f(x)), 0));
const pendingFor = async ({ documentId, pickId, itemId }) => r3(Number((await db.prepare(`SELECT COALESCE(SUM(quantity - done_qty), 0) AS q FROM wms_crossdocks WHERE item_id = ? AND status IN ('planned','proposed','ready') AND ${documentId ? 'document_id = ?' : 'document_id IS NULL AND pick_id = ?'}`).get(itemId, documentId || pickId)).q));
const activePickOf = (docId) => db.prepare("SELECT * FROM wms_picks WHERE document_id = ? AND status IN ('open','in_progress','picked') ORDER BY id DESC LIMIT 1").get(docId);

/**
 * Ce qu'attendent les commandes pour un article : [{ targetKind, pickId, pickCode, documentId, documentNumber, customer, waveCode, missing }].
 * - commande (ou devis, facture) avec une liste en cours : besoin du document − ce que ses listes couvrent − réservations − transbordements en cours ;
 * - commande ouverte sans liste : même calcul ;
 * - liste sans document : ce qui manque sur ses lignes incomplètes.
 * Les listes passent avant les commandes sans liste ; ensuite la priorité, puis l'ancienneté. Le stock libre (`free`) couvre d'abord ces manques.
 */
async function demandFor(orgId, itemId, { free = 0 } = {}) {
  const out = [];
  const docs = await db.prepare(`SELECT d.id, d.number, d.lines, d.kind, d.status, c.name AS customer FROM documents d LEFT JOIN customers c ON c.id = d.customer_id
    WHERE d.org_id = ? AND d.status NOT IN ('cancelled','refused') AND ((d.kind = 'order' AND d.status IN ('pending','confirmed')) OR EXISTS (SELECT 1 FROM wms_picks p WHERE p.document_id = d.id AND p.status IN ('open','in_progress','picked')))
    ORDER BY d.id LIMIT 1000`).all(orgId);
  for (const d of docs) {
    const need = F().docNeeds(d)[Number(itemId)] || 0;
    if (need <= W.EPS) continue;
    const lines = await db.prepare("SELECT pl.*, p.status AS ps FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id WHERE p.document_id = ? AND pl.item_id = ? AND p.status != 'cancelled'").all(d.id, itemId);
    const covered = sum(lines, (l) => (l.ps === 'issued' || Number(l.done) ? l.picked_qty : l.quantity));
    const reserved = r3(Number((await db.prepare("SELECT COALESCE(SUM(quantity - fulfilled_qty), 0) AS q FROM wms_reservations WHERE document_id = ? AND item_id = ? AND status = 'active' AND source_kind = 'document'").get(d.id, itemId)).q));
    const missing = r3(need - covered - reserved - await pendingFor({ documentId: d.id, itemId }));
    if (missing <= W.EPS) continue;
    const p = await activePickOf(d.id);
    if (!p && !(d.kind === 'order' && ['pending', 'confirmed'].includes(d.status))) continue;
    const wave = p && p.wave_id ? await db.prepare('SELECT code FROM wms_waves WHERE id = ?').get(p.wave_id) : null;
    out.push({ targetKind: p ? 'pick' : 'document', pickId: p ? Number(p.id) : null, pickCode: p ? p.code : null, documentId: Number(d.id), documentNumber: d.number, customer: d.customer || null,
      waveCode: wave ? wave.code : null, priority: p ? Number(p.priority) : 2, missing, order: p ? 0 : 1, seq: Number(d.id) });
  }
  const picks = await db.prepare(`SELECT p.*, wv.code AS wave FROM wms_picks p LEFT JOIN wms_waves wv ON wv.id = p.wave_id WHERE p.org_id = ? AND p.document_id IS NULL AND p.status IN ('open','in_progress','picked')
    AND EXISTS (SELECT 1 FROM wms_pick_lines pl WHERE pl.pick_id = p.id AND pl.item_id = ? AND pl.short = 1) ORDER BY p.id`).all(orgId, itemId);
  for (const p of picks) {
    const lines = await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ? AND item_id = ? AND short = 1').all(p.id, itemId);
    const missing = r3(sum(lines, (l) => Math.max(0, Number(l.quantity) - Number(l.picked_qty))) - await pendingFor({ pickId: p.id, itemId }));
    if (missing <= W.EPS) continue;
    out.push({ targetKind: 'pick', pickId: Number(p.id), pickCode: p.code, documentId: null, documentNumber: null, customer: null, waveCode: p.wave || null, priority: Number(p.priority), missing, order: 0, seq: Number(p.id) });
  }
  out.sort((a, b) => a.order - b.order || a.priority - b.priority || a.seq - b.seq);
  // Le stock libre (déjà là avant l'arrivage) sert d'abord : il se prépare normalement ; seul le manque réel attend l'arrivage.
  let f = r3(Math.max(0, free));
  for (const d of out) if (f > W.EPS) { const t = r3(Math.min(f, d.missing)); d.missing = r3(d.missing - t); f = r3(f - t); }
  return out.filter((d) => d.missing > W.EPS).map(({ order, seq, ...d }) => d);
}

/** Met de côté `q` (au plus le disponible) pour le transbordement. Renvoie { reservationId, quantity }. */
async function hold(req, itemId, q, label) {
  const av = Math.max(0, (await W.availability(itemId)).available);
  const take = r3(Math.min(q, av));
  if (take <= W.EPS) return { reservationId: null, quantity: 0 };
  const id = Number((await db.prepare("INSERT INTO wms_reservations (org_id, item_id, quantity, status, source_kind, label, created_by, created_at) VALUES (?, ?, ?, 'active', 'crossdock', ?, ?, ?)")
    .run(req.org.id, itemId, take, label, req.user ? req.user.id : null, nowISO())).lastInsertRowid);
  return { reservationId: id, quantity: take };
}
const unhold = async (x, q) => {
  if (!x.reservation_id) return;
  await db.prepare("UPDATE wms_reservations SET quantity = GREATEST(0, quantity - ?) WHERE id = ? AND status = 'active'").run(r3(q), x.reservation_id);
  await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Transbordement terminé ou annulé' WHERE id = ? AND status = 'active' AND quantity <= 0.0000001").run(x.reservation_id);
};
/** La commande visée attend-elle encore ? */
async function targetAlive(x) {
  if (x.pick_id) { const p = await db.prepare('SELECT status FROM wms_picks WHERE id = ?').get(x.pick_id); if (p && ACTIVE_PICK.includes(p.status)) return true; }
  if (x.document_id) {
    const d = await db.prepare('SELECT kind, status FROM documents WHERE id = ?').get(x.document_id);
    if (!d || ['cancelled', 'refused'].includes(d.status)) return false;
    return Boolean(await activePickOf(x.document_id)) || (d.kind === 'order' && ['pending', 'confirmed'].includes(d.status));
  }
  return false;
}
async function insertXd(req, f) {
  const code = await W.nextCode(req.org.id, 'XD');
  const id = Number((await db.prepare(`INSERT INTO wms_crossdocks (org_id, code, status, mode, item_id, quantity, document_id, pick_id, purchase_order_id, reservation_id, source_kind, source_id, source_code, hu_id, from_location_id, note, created_by, created_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, code, f.status, f.mode, f.itemId, r3(f.quantity), f.documentId || null, f.pickId || null, f.purchaseOrderId || null, f.reservationId || null,
    f.sourceKind || '', f.sourceId || null, f.sourceCode || '', f.huId || null, f.fromLocationId || null, cleanText(String(f.note || ''), 300), req.user ? req.user.id : null, nowISO(), f.status === 'planned' ? null : nowISO())).lastInsertRowid);
  return db.prepare('SELECT * FROM wms_crossdocks WHERE id = ?').get(id);
}

/**
 * Appelé dans la transaction d'une réception, APRÈS l'entrée en stock : transbordements planifiés d'abord, puis opportunistes.
 * o = { itemId, quantity, locationId?, huId?, sourceKind, sourceId, sourceCode, purchaseOrderId? }. Renvoie les transbordements créés ou servis.
 */
async function onReceipt(req, o) {
  const s = await W.settingsOf(req.org.id);
  const mode = MODES.includes(s.crossDock) ? s.crossDock : 'propose';
  if (mode === 'off' || !(Number(o.quantity) > W.EPS)) return [];
  const it = await W.lockItem(req.org.id, o.itemId);
  let left = r3(o.quantity);
  const touched = [];
  const src = { sourceKind: o.sourceKind || 'receipt', sourceId: o.sourceId || null, sourceCode: cleanText(String(o.sourceCode || ''), 40), fromLocationId: o.locationId || null, huId: o.huId || null };
  const planned = await db.prepare("SELECT * FROM wms_crossdocks WHERE org_id = ? AND item_id = ? AND status = 'planned' AND (purchase_order_id IS NULL OR purchase_order_id = ?) ORDER BY CASE WHEN purchase_order_id IS NULL THEN 1 ELSE 0 END, id FOR UPDATE")
    .all(req.org.id, it.id, o.purchaseOrderId || 0);
  for (const x of planned) {
    if (left <= W.EPS) break;
    if (!(await targetAlive(x))) { await db.prepare("UPDATE wms_crossdocks SET status = 'cancelled', close_reason = ? WHERE id = ?").run("La commande n'attend plus cette marchandise.", x.id); continue; }
    const h = await hold(req, it.id, Math.min(left, Number(x.quantity)), x.code);
    if (h.quantity <= W.EPS) break;
    if (h.quantity + W.EPS < Number(x.quantity)) await insertXd(req, { status: 'planned', mode: 'planned', itemId: it.id, quantity: r3(Number(x.quantity) - h.quantity), documentId: x.document_id, pickId: x.pick_id, purchaseOrderId: x.purchase_order_id, note: x.note });
    await db.prepare("UPDATE wms_crossdocks SET status = 'ready', quantity = ?, reservation_id = ?, source_kind = ?, source_id = ?, source_code = ?, from_location_id = ?, hu_id = ?, received_at = ? WHERE id = ?")
      .run(h.quantity, h.reservationId, src.sourceKind, src.sourceId, src.sourceCode, src.fromLocationId, src.huId, nowISO(), x.id);
    touched.push(Number(x.id)); left = r3(left - h.quantity);
  }
  if (left > W.EPS) {
    const free = r3((await W.availability(it.id)).available - left);
    for (const d of await demandFor(req.org.id, it.id, { free })) {
      if (left <= W.EPS) break;
      const q = r3(Math.min(left, d.missing));
      const code = await W.nextCode(req.org.id, 'XD');
      const h = await hold(req, it.id, q, code);
      if (h.quantity <= W.EPS) break;
      const id = Number((await db.prepare(`INSERT INTO wms_crossdocks (org_id, code, status, mode, item_id, quantity, document_id, pick_id, reservation_id, source_kind, source_id, source_code, hu_id, from_location_id, created_by, created_at, received_at)
        VALUES (?, ?, 'proposed', 'opportunistic', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, code, it.id, h.quantity, d.documentId, d.pickId, h.reservationId, src.sourceKind, src.sourceId, src.sourceCode, src.huId, src.fromLocationId, req.user ? req.user.id : null, nowISO(), nowISO())).lastInsertRowid);
      touched.push(id); left = r3(left - h.quantity);
    }
  }
  if (mode === 'auto') for (const id of touched) await execute(req, await db.prepare('SELECT * FROM wms_crossdocks WHERE id = ?').get(id), {});
  const out = [];
  for (const id of touched) out.push(await xdView(await db.prepare('SELECT * FROM wms_crossdocks WHERE id = ?').get(id)));
  return out;
}

/** Où prendre la marchandise : l'emplacement noté à la réception s'il en a assez, sinon un emplacement utilisable de l'entrepôt (réception d'abord). */
async function sourceLocation(req, x, q, b) {
  if (b.fromLocationId || b.fromLocationCode) {
    const l = b.fromLocationId ? await W.locationOf(req.org.id, A.id(b.fromLocationId)) : await db.prepare('SELECT * FROM wms_locations WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, cleanText(String(b.fromLocationCode), 60));
    if (!l) throw new HttpError(404, 'Aucun emplacement avec ce code.');
    if (!W.isUsable(l)) throw new HttpError(400, 'Prenez la marchandise dans un emplacement utilisable (réception, rayonnage ou préparation) : libérez-la d\'abord du contrôle qualité.');
    if (await W.qtyAt(l.id, x.item_id) + W.EPS < q) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
    return l;
  }
  if (x.from_location_id) {
    const l = await db.prepare('SELECT * FROM wms_locations WHERE id = ?').get(x.from_location_id);
    if (l && W.isUsable(l) && await W.qtyAt(l.id, x.item_id) + W.EPS >= q) return l;
  }
  const wh = x.from_location_id ? await db.prepare('SELECT warehouse_id FROM wms_locations WHERE id = ?').get(x.from_location_id) : null;
  const rows = await db.prepare(`SELECT l.*, s.quantity AS q FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND s.quantity >= ? AND l.active = 1 AND l.kind IN ('reception','storage','picking')
    ORDER BY ${wh ? 'CASE WHEN l.warehouse_id = ? THEN 0 ELSE 1 END, ' : ''}CASE l.kind WHEN 'reception' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END, s.quantity DESC, l.id LIMIT 1`).all(x.item_id, q - W.EPS, ...(wh ? [wh.warehouse_id] : []));
  if (!rows.length) throw new HttpError(400, "La marchandise n'est plus dans un emplacement utilisable : indiquez où la prendre.");
  return rows[0];
}
async function destination(req, from, pick, b) {
  if (b.toLocationId || b.toLocationCode) {
    const l = b.toLocationId ? await W.locationOf(req.org.id, A.id(b.toLocationId)) : await db.prepare('SELECT * FROM wms_locations WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, cleanText(String(b.toLocationCode), 60));
    if (!l) throw new HttpError(404, 'Aucun emplacement avec ce code.');
    if (!W.OUTBOUND.includes(l.kind) || !Number(l.active)) throw new HttpError(400, "Déposez la marchandise en dépose / emballage ou sur un quai d'expédition.");
    return l;
  }
  if (pick && pick.wave_id) { const w = await db.prepare('SELECT staging_location_id FROM wms_waves WHERE id = ?').get(pick.wave_id); if (w && w.staging_location_id) return W.locationOf(req.org.id, w.staging_location_id); }
  return W.outboundOf(req.org.id, 'staging', Number(from.warehouse_id));
}

/** Exécute (dans la transaction de l'appelant) : marchandise vers la dépose, ajoutée à la liste de préparation de la commande. */
async function execute(req, x0, b = {}) {
  const x = await W.lockRow('wms_crossdocks', x0.id);
  if (x.status === 'planned') throw new HttpError(400, "La marchandise de ce transbordement n'est pas encore arrivée.");
  if (!['ready', 'proposed'].includes(x.status)) throw new HttpError(400, 'Ce transbordement est déjà fait ou annulé.');
  const it = await W.lockItem(req.org.id, x.item_id);
  const remaining = r3(Number(x.quantity) - Number(x.done_qty));
  const q = b.quantity === undefined || b.quantity === null || b.quantity === '' ? remaining : H().qty(b.quantity);
  if (q > remaining + W.EPS) throw new HttpError(400, `Il reste ${remaining} ${it.unit} à transborder.`);
  let pick = x.pick_id ? await db.prepare('SELECT * FROM wms_picks WHERE id = ?').get(x.pick_id) : null;
  if (pick && !ACTIVE_PICK.includes(pick.status)) pick = null;
  if (!pick && x.document_id) pick = await activePickOf(x.document_id) || null;
  const doc = x.document_id ? await db.prepare('SELECT * FROM documents WHERE id = ?').get(x.document_id) : null;
  if (!pick && (!doc || ['cancelled', 'refused'].includes(doc.status))) throw new HttpError(400, "La commande visée n'attend plus cette marchandise : annulez ce transbordement, la marchandise sera rangée normalement.");
  if (pick) pick = await W.lockRow('wms_picks', pick.id);
  if (pick && !ACTIVE_PICK.includes(pick.status)) throw new HttpError(400, 'La liste de préparation de cette commande est terminée.');
  await unhold(x, q);
  const av = await W.availability(it.id);
  if (av.available + W.EPS < q) throw new HttpError(400, `Pas assez de stock disponible pour « ${it.name} » : ${Math.max(0, av.available)} ${it.unit}.`);
  const from = await sourceLocation(req, x, q, b);
  const to = await destination(req, from, pick, b);
  // Palette reçue : le contenu sort d'abord de CETTE palette (et non d'une autre posée au même endroit).
  const huId = b.huId || x.hu_id;
  if (huId) {
    const hu = await db.prepare('SELECT * FROM wms_hus WHERE id = ? AND location_id = ?').get(huId, from.id);
    if (hu) {
      let left = q;
      for (const c of await db.prepare('SELECT * FROM wms_hu_contents WHERE hu_id = ? AND item_id = ? ORDER BY expiry IS NULL, expiry, id').all(hu.id, it.id)) {
        if (left <= W.EPS) break;
        const t = r3(Math.min(left, Number(c.quantity)));
        if (Number(c.quantity) - t <= W.EPS) await db.prepare('DELETE FROM wms_hu_contents WHERE id = ?').run(c.id);
        else await db.prepare('UPDATE wms_hu_contents SET quantity = ? WHERE id = ?').run(r3(Number(c.quantity) - t), c.id);
        left = r3(left - t);
      }
      await W.markEmpty(hu.id);
    }
  }
  await W.move(req, it.id, from.id, to.id, q, { kind: 'crossdock', refKind: 'crossdock', refId: x.id, reason: `Transbordement ${x.code}${doc ? ' · ' + doc.number : pick ? ' · ' + pick.code : ''}` });
  if (!pick) {
    const code = await W.nextCode(req.org.id, 'PR');
    const id = Number((await db.prepare("INSERT INTO wms_picks (org_id, code, status, priority, document_id, label, created_by, created_at) VALUES (?, ?, 'picked', 2, ?, ?, ?, ?)").run(req.org.id, code, doc.id, `${doc.number} · transbordement`, req.user.id, nowISO())).lastInsertRowid);
    pick = await db.prepare('SELECT * FROM wms_picks WHERE id = ?').get(id);
    await require('./wms-vas').autoAttach(req, 'pick', id, { customerId: doc.customer_id, items: [{ itemId: Number(it.id), quantity: q }] });
  }
  await db.prepare('INSERT INTO wms_pick_lines (pick_id, item_id, location_id, quantity, picked_qty, done, short, picked_from) VALUES (?, ?, ?, ?, ?, 1, 0, ?)').run(pick.id, it.id, from.id, q, q, JSON.stringify([{ locationId: Number(to.id), quantity: q }]));
  // La réservation de la liste couvre la marchandise transbordée, déjà servie (elle est en dépose, hors disponible).
  const r = await db.prepare("SELECT id FROM wms_reservations WHERE pick_id = ? AND item_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(pick.id, it.id);
  if (r) await db.prepare('UPDATE wms_reservations SET quantity = quantity + ?, fulfilled_qty = fulfilled_qty + ? WHERE id = ?').run(q, q, r.id);
  else await db.prepare("INSERT INTO wms_reservations (org_id, item_id, quantity, fulfilled_qty, status, source_kind, document_id, pick_id, label, created_by, created_at) VALUES (?, ?, ?, ?, 'active', 'pick', ?, ?, ?, ?, ?)").run(req.org.id, it.id, q, q, pick.document_id || null, pick.id, pick.code, req.user.id, nowISO());
  if (pick.status === 'open') await db.prepare("UPDATE wms_picks SET status = 'in_progress' WHERE id = ?").run(pick.id);
  if (pick.status === 'picked') await db.prepare('UPDATE wms_picks SET packed_at = NULL WHERE id = ?').run(pick.id);
  const done = r3(Number(x.done_qty) + q);
  const full = done + W.EPS >= Number(x.quantity);
  await db.prepare('UPDATE wms_crossdocks SET done_qty = ?, status = ?, pick_id = ?, from_location_id = ?, to_location_id = ?, done_by = ?, done_at = ? WHERE id = ?').run(done, full ? 'done' : x.status, pick.id, from.id, to.id, req.user.id, nowISO(), x.id);
  if (full) await unhold({ reservation_id: x.reservation_id }, 1e12);
  return { code: x.code, quantity: q, from: from.code, to: to.code, pickId: Number(pick.id), pickCode: pick.code, done: full };
}

async function xdView(x) {
  const row = await db.prepare(`SELECT x.*, i.name, i.unit, i.sku, i.barcode, d.number AS doc, c.name AS customer, p.code AS pick, p.status AS pick_status, wv.code AS wave, po.number AS po, f.code AS fc, t.code AS tc, h.code AS hc, u.name AS who
    FROM wms_crossdocks x JOIN stock_items i ON i.id = x.item_id LEFT JOIN documents d ON d.id = x.document_id LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN wms_picks p ON p.id = x.pick_id LEFT JOIN wms_waves wv ON wv.id = p.wave_id
    LEFT JOIN pur_orders po ON po.id = x.purchase_order_id LEFT JOIN wms_locations f ON f.id = x.from_location_id LEFT JOIN wms_locations t ON t.id = x.to_location_id LEFT JOIN wms_hus h ON h.id = x.hu_id LEFT JOIN users u ON u.id = x.done_by WHERE x.id = ?`).get(x.id);
  return { id: Number(row.id), code: row.code, status: row.status, statusLabel: STATUS[row.status], mode: row.mode, planned: row.mode === 'planned', itemId: Number(row.item_id), item: row.name, unit: row.unit, sku: row.sku || '', barcode: row.barcode || '',
    quantity: r3(row.quantity), doneQty: r3(row.done_qty), remaining: r3(Number(row.quantity) - Number(row.done_qty)), documentId: row.document_id ? Number(row.document_id) : null, documentNumber: row.doc || null, customer: row.customer || null,
    pickId: row.pick_id ? Number(row.pick_id) : null, pickCode: row.pick || null, waveCode: row.wave || null, purchaseOrderId: row.purchase_order_id ? Number(row.purchase_order_id) : null, purchaseOrder: row.po || null,
    source: row.source_kind ? SOURCES[row.source_kind] || row.source_kind : null, sourceKind: row.source_kind || null, sourceCode: row.source_code || null, huCode: row.hc || null,
    from: row.fc || null, fromLocationId: row.from_location_id ? Number(row.from_location_id) : null, to: row.tc || null, note: row.note || '', closeReason: row.close_reason || null,
    createdAt: row.created_at, receivedAt: row.received_at || null, doneAt: row.done_at || null, doneBy: row.who || null };
}

// ---------- Lecture ----------
router.get('/crossdock', async (req, res) => {
  const st = STATUS[req.query.status] ? [req.query.status] : req.query.status === 'history' ? ['done', 'cancelled'] : ['proposed', 'ready'];
  const rows = await db.prepare(`SELECT x.* FROM wms_crossdocks x LEFT JOIN wms_locations f ON f.id = x.from_location_id WHERE x.org_id = ? AND x.status IN (${st.map(() => '?').join(',')})
    ORDER BY CASE x.status WHEN 'ready' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, f.code, x.id DESC LIMIT 300`).all(req.org.id, ...st);
  const out = []; for (const x of rows) out.push(await xdView(x));
  const counts = Object.fromEntries((await db.prepare("SELECT status, COUNT(*) AS c FROM wms_crossdocks WHERE org_id = ? AND status IN ('planned','proposed','ready') GROUP BY status").all(req.org.id)).map((r) => [r.status, Number(r.c)]));
  res.json({ crossdocks: out, statuses: STATUS, counts: { planned: counts.planned || 0, proposed: counts.proposed || 0, ready: counts.ready || 0 }, mode: (await W.settingsOf(req.org.id)).crossDock || 'propose' });
});
/** Ce que les commandes attendent, article par article, avec les commandes fournisseurs en cours (pour planifier). */
router.get('/crossdock/demand', async (req, res) => {
  await F().syncReservations(req.org.id);
  const itemFilter = req.query.itemId ? [Number((await H().itemOf(req, req.query.itemId)).id)] : null;
  const ids = itemFilter || [...new Set([
    ...(await db.prepare("SELECT DISTINCT pl.item_id FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id WHERE p.org_id = ? AND p.status IN ('open','in_progress','picked')").all(req.org.id)).map((r) => Number(r.item_id)),
    ...(await db.prepare("SELECT lines FROM documents WHERE org_id = ? AND kind = 'order' AND status IN ('pending','confirmed') ORDER BY id DESC LIMIT 500").all(req.org.id)).flatMap((d) => Object.keys(F().docNeeds(d)).map(Number)),
  ])];
  const out = [];
  for (const itemId of ids.slice(0, 300)) {
    const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(itemId, req.org.id);
    if (!it || !A.visible(req, it)) continue;
    const av = await W.availability(itemId);
    const demands = await demandFor(req.org.id, itemId, { free: av.available });
    if (!demands.length) continue;
    const pos = await db.prepare(`SELECT o.id, o.number, o.expected_date, s.name AS supplier, ol.id AS lid, ol.quantity FROM pur_order_lines ol JOIN pur_orders o ON o.id = ol.order_id LEFT JOIN suppliers s ON s.id = o.supplier_id
      WHERE o.org_id = ? AND ol.item_id = ? AND o.status IN ('approved','sent','partial') ORDER BY o.id`).all(req.org.id, itemId);
    const inbound = [];
    for (const p of pos) {
      const st = (await require('./purchasing-lib').orderLineState(p.id)).find((l) => Number(l.id) === Number(p.lid));
      if (st && st.remaining > W.EPS) inbound.push({ purchaseOrderId: Number(p.id), number: p.number, supplier: p.supplier || null, expectedDate: p.expected_date || null, remaining: st.remaining });
    }
    const planned = r3(Number((await db.prepare("SELECT COALESCE(SUM(quantity - done_qty), 0) AS q FROM wms_crossdocks WHERE item_id = ? AND status = 'planned'").get(itemId)).q));
    out.push({ itemId, name: it.name, unit: it.unit, sku: it.sku || '', available: av.available, missing: sum(demands, (d) => d.missing), planned, demands, inbound });
  }
  res.json({ items: out });
});
/** Aperçu avant une réception : ce qui serait transbordé pour `quantity` de cet article. */
router.get('/crossdock/check', async (req, res) => {
  const it = await H().itemOf(req, req.query.itemId);
  const q = H().qty(req.query.quantity || 1);
  const planned = (await db.prepare("SELECT * FROM wms_crossdocks WHERE org_id = ? AND item_id = ? AND status = 'planned' ORDER BY id").all(req.org.id, it.id));
  const pv = []; for (const x of planned) pv.push(await xdView(x));
  const av = await W.availability(it.id);
  const demands = await demandFor(req.org.id, it.id, { free: av.available });
  res.json({ item: { id: Number(it.id), name: it.name, unit: it.unit }, quantity: q, mode: (await W.settingsOf(req.org.id)).crossDock || 'propose', planned: pv, demands, awaited: r3(sum(pv, (x) => x.remaining) + sum(demands, (d) => d.missing)) });
});
router.get('/crossdock/:id', async (req, res) => res.json({ crossdock: await xdView(await xdOf(req, req.params.id)) }));

// ---------- Planification ----------
router.post('/crossdock/plan', mgr, async (req, res) => {
  const b = req.body || {};
  const it = await H().itemOf(req, b.itemId);
  const q = H().qty(b.quantity);
  let doc = null; let pick = null;
  if (b.pickId) { pick = await F().pickOf(req, b.pickId); if (!ACTIVE_PICK.includes(pick.status)) throw new HttpError(400, 'Cette liste de préparation est terminée ou annulée.'); }
  if (b.documentId) doc = await F().documentOf(req, b.documentId);
  if (pick && pick.document_id) { if (doc && Number(doc.id) !== Number(pick.document_id)) throw new HttpError(400, "Cette liste ne prépare pas cette commande."); doc = doc || await db.prepare('SELECT * FROM documents WHERE id = ?').get(pick.document_id); }
  if (!doc && !pick) throw new HttpError(400, 'Choisissez la commande ou la liste de préparation qui attend la marchandise.');
  let poId = null;
  if (b.purchaseOrderId) {
    const po = await db.prepare('SELECT * FROM pur_orders WHERE id = ? AND org_id = ?').get(A.id(b.purchaseOrderId), req.org.id);
    if (!po) throw new HttpError(404, 'Bon de commande introuvable.');
    if (!['approved', 'sent', 'partial'].includes(po.status)) throw new HttpError(400, "Ce bon de commande n'attend plus de livraison.");
    if (!await db.prepare('SELECT 1 FROM pur_order_lines WHERE order_id = ? AND item_id = ?').get(po.id, it.id)) throw new HttpError(400, "Cet article ne figure pas sur ce bon de commande.");
    poId = Number(po.id);
  }
  const out = await db.transaction(async () => {
    await W.lockItem(req.org.id, it.id); // deux planifications simultanées ne promettent pas deux fois le même manque
    const d = (await demandFor(req.org.id, it.id)).find((x) => (doc ? x.documentId === Number(doc.id) : x.pickId === Number(pick.id)));
    const missing = d ? d.missing : 0;
    if (q > missing + W.EPS) throw new HttpError(400, missing > W.EPS ? `Cette commande n'attend que ${missing} ${it.unit} de « ${it.name} ».` : `Cette commande n'attend pas de « ${it.name} » (déjà couverte par le stock, une liste ou un transbordement).`);
    const x = await insertXd(req, { status: 'planned', mode: 'planned', itemId: it.id, quantity: q, documentId: doc ? doc.id : null, pickId: pick ? pick.id : (d && d.pickId) || null, purchaseOrderId: poId, note: b.note });
    return { id: Number(x.id), code: x.code };
  })();
  res.status(201).json(out);
});

/** Après une entrée saisie au scanner : la personne demande de chercher les commandes qui attendent ce qu'elle vient de recevoir. */
router.post('/crossdock/from-stock', async (req, res) => {
  const b = req.body || {};
  const it = await H().itemOf(req, b.itemId);
  const q = H().qty(b.quantity);
  let loc = null;
  if (b.locationId) { loc = await W.locationOf(req.org.id, A.id(b.locationId)); if (!W.isUsable(loc)) throw new HttpError(400, 'Prenez la marchandise dans un emplacement utilisable (réception, rayonnage ou préparation) : libérez-la d\'abord du contrôle qualité.'); }
  if (loc && await W.qtyAt(loc.id, it.id) + W.EPS < q) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  await F().syncReservations(req.org.id);
  const out = await db.transaction(() => onReceipt(req, { itemId: it.id, quantity: q, locationId: loc ? loc.id : undefined, sourceKind: 'manual' }))();
  res.json({ crossDock: out });
});

// ---------- Exécution ----------
router.post('/crossdock/:id/execute', async (req, res) => {
  const x = await xdOf(req, req.params.id);
  const b = req.body || {};
  if (b.huCode) b.huId = Number((await HU().huByCode(req, b.huCode)).id);
  const r = await db.transaction(() => execute(req, x, b))();
  res.json({ ok: true, ...r });
});
/** Scan : le code du transbordement, de l'article ou de la palette reçue ; puis, si besoin, l'emplacement de dépose. */
router.post('/crossdock/scan', async (req, res) => {
  const b = req.body || {};
  const code = cleanText(String(b.code || ''), 60);
  if (!code) throw new HttpError(400, 'Scannez un code.');
  let list = [];
  const x = await db.prepare("SELECT * FROM wms_crossdocks WHERE org_id = ? AND UPPER(code) = UPPER(?)").get(req.org.id, code);
  let huId = null;
  if (x) list = [x];
  else {
    const hu = await db.prepare('SELECT * FROM wms_hus WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, code);
    if (hu) {
      huId = Number(hu.id);
      list = await db.prepare("SELECT x.* FROM wms_crossdocks x WHERE x.org_id = ? AND x.status IN ('ready','proposed') AND (x.hu_id = ? OR (x.hu_id IS NULL AND x.item_id IN (SELECT item_id FROM wms_hu_contents WHERE hu_id = ?))) ORDER BY x.id").all(req.org.id, hu.id, hu.id);
      if (!list.length) throw new HttpError(404, 'Aucun transbordement en attente pour cette palette.');
    } else {
      const it = await require('./wms-outbound').itemByCode(req.org.id, code);
      if (!it) throw new HttpError(404, 'Code inconnu : ni transbordement, ni article, ni palette.');
      list = await db.prepare("SELECT * FROM wms_crossdocks WHERE org_id = ? AND item_id = ? AND status IN ('ready','proposed') ORDER BY CASE status WHEN 'ready' THEN 0 ELSE 1 END, id LIMIT 1").all(req.org.id, it.id);
      if (!list.length) throw new HttpError(404, `Aucun transbordement en attente pour « ${it.name} » : rangez-le normalement.`);
    }
  }
  const done = await db.transaction(async () => { const out = []; for (const y of list) out.push(await execute(req, y, { ...b, quantity: list.length > 1 ? undefined : b.quantity, huId: huId || undefined })); return out; })();
  res.json({ ok: true, done });
});
router.post('/crossdock/:id/cancel', mgr, async (req, res) => {
  const x = await xdOf(req, req.params.id);
  if (!PENDING.includes(x.status)) throw new HttpError(400, 'Ce transbordement est déjà fait ou annulé.');
  await db.transaction(async () => {
    const cur = await W.lockRow('wms_crossdocks', x.id);
    if (!PENDING.includes(cur.status)) throw new HttpError(400, 'Ce transbordement est déjà fait ou annulé.');
    await unhold(cur, 1e12);
    await db.prepare("UPDATE wms_crossdocks SET status = 'cancelled', close_reason = ?, done_by = ?, done_at = ? WHERE id = ?").run(cleanText(String((req.body || {}).reason || ''), 200) || 'Annulé', req.user.id, nowISO(), x.id);
  })();
  res.json({ ok: true });
});

/** Quantité d'un article mise de côté par des transbordements à faire, dans un emplacement (rangement : elle ne se range pas). */
const heldAt = async (locId, itemId) => r3(Number((await db.prepare("SELECT COALESCE(SUM(quantity - done_qty), 0) AS q FROM wms_crossdocks WHERE from_location_id = ? AND item_id = ? AND status IN ('proposed','ready')").get(locId, itemId)).q));

module.exports = router;
Object.assign(module.exports, { onReceipt, execute, demandFor, heldAt, MODES });
