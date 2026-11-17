'use strict';
// Stock entrepôt (WMS) — flux : transferts entre entrepôts (via l'emplacement « En transit »), réservations, listes de préparation, retours et rebuts.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const L = require('./stock-lib');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const H = () => require('./wms');
const nameMap = async (ids) => {
  const list = [...new Set(ids.filter((x) => x != null).map(Number))];
  if (!list.length) return {};
  return Object.fromEntries((await db.prepare(`SELECT id, name FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list)).map((r) => [Number(r.id), r.name]));
};
const unitValue = (it) => L.unitValue(it);
/** Lignes saisies (article + quantité), une seule par article. */
async function readLines(req, lines, max = 100) {
  if (!Array.isArray(lines) || !lines.length || lines.length > max) throw new HttpError(400, `Ajoutez au moins une ligne (${max} au plus).`);
  const seen = new Set(); const out = [];
  for (const l of lines) {
    const it = await H().itemOf(req, l && l.itemId);
    if (seen.has(Number(it.id))) throw new HttpError(400, 'Un article apparaît deux fois : une seule ligne par article.');
    seen.add(Number(it.id));
    out.push({ it, quantity: H().qty(l.quantity), raw: l });
  }
  return out;
}

// =====================================================================
// Transferts
// =====================================================================
const TR_LOG = { requested: 'requested', shipped: 'shipped', received: 'received', cancelled: 'cancelled' };
async function transferOf(req, idv) {
  const t = await db.prepare('SELECT * FROM wms_transfers WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!t) throw new HttpError(404, 'Transfert introuvable.');
  return t;
}
const log = (tid, action, by, note) => db.prepare('INSERT INTO wms_transfer_log (transfer_id, action, by_id, note, at) VALUES (?, ?, ?, ?, ?)').run(tid, TR_LOG[action], by, String(note || '').slice(0, 300), nowISO());

router.get('/transfers', async (req, res) => {
  const st = String(req.query.status || '');
  const m = A.can(req, 'manager');
  const rows = await db.prepare(`SELECT t.*, f.name AS f, d.name AS d, u.name AS who, (SELECT COUNT(*) FROM wms_transfer_lines l WHERE l.transfer_id = t.id) AS n,
      (SELECT COALESCE(SUM(gap_qty), 0) FROM wms_transfer_lines l WHERE l.transfer_id = t.id) AS gq, (SELECT COALESCE(SUM(gap_value), 0) FROM wms_transfer_lines l WHERE l.transfer_id = t.id) AS gv
    FROM wms_transfers t JOIN wms_warehouses f ON f.id = t.from_warehouse_id JOIN wms_warehouses d ON d.id = t.to_warehouse_id LEFT JOIN users u ON u.id = t.requested_by
    WHERE t.org_id = ?${st ? ' AND t.status = ?' : ''} ORDER BY t.id DESC LIMIT 300`).all(req.org.id, ...(st ? [st] : []));
  const inTransit = Number((await db.prepare("SELECT COUNT(*) AS c FROM wms_transfers WHERE org_id = ? AND status = 'shipped'").get(req.org.id)).c);
  res.json({ inTransit, transfers: rows.map((t) => ({ id: Number(t.id), code: t.code, status: t.status, from: t.f, to: t.d, lineCount: Number(t.n), requestedAt: t.created_at, requestedBy: t.who || null, gapQty: r3(Number(t.gq) || 0), gapValue: m ? Number(t.gv) || 0 : undefined })) });
});
router.get('/transfers/:id', async (req, res) => {
  const t = await transferOf(req, req.params.id);
  const m = A.can(req, 'manager');
  const wh = async (id) => (await db.prepare('SELECT name FROM wms_warehouses WHERE id = ?').get(id)).name;
  const lines = await db.prepare('SELECT l.*, i.name, i.unit, i.tracking FROM wms_transfer_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.transfer_id = ? ORDER BY l.id').all(t.id);
  const journal = await db.prepare('SELECT g.*, u.name FROM wms_transfer_log g LEFT JOIN users u ON u.id = g.by_id WHERE g.transfer_id = ? ORDER BY g.id').all(t.id);
  res.json({ transfer: {
    id: Number(t.id), code: t.code, status: t.status, from: await wh(t.from_warehouse_id), to: await wh(t.to_warehouse_id), note: t.note,
    gapQty: r3(lines.reduce((a, l) => a + Number(l.gap_qty), 0)), gapValue: m ? lines.reduce((a, l) => a + Number(l.gap_value), 0) : undefined,
    lines: lines.map((l) => ({ id: Number(l.id), itemId: Number(l.item_id), name: l.name, unit: l.unit, tracking: l.tracking || 'none', quantity: r3(l.quantity), shippedQty: r3(l.shipped_qty), receivedQty: r3(l.received_qty), gapQty: r3(l.gap_qty), gapValue: m ? Number(l.gap_value) : undefined, gapReason: l.gap_reason || null })),
    journal: journal.map((j) => ({ at: j.at, action: j.action, by: j.name || null, note: j.note || null })),
  } });
});
router.post('/transfers', async (req, res) => {
  const b = req.body || {};
  const from = await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(b.fromWarehouseId, 'Choisissez un entrepôt.'), req.org.id);
  const to = await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(b.toWarehouseId, 'Choisissez un entrepôt.'), req.org.id);
  if (!from || !to) throw new HttpError(404, 'Entrepôt introuvable.');
  const sameWh = Number(from.id) === Number(to.id);
  if (!Number(from.active) || !Number(to.active)) throw new HttpError(400, 'Cet entrepôt est désactivé.');
  const lines = await readLines(req, b.lines);
  // Entre deux emplacements d'un même entrepôt (ligne B) : chaque ligne indique l'emplacement de départ et celui d'arrivée.
  for (const l of lines) {
    const fl = l.raw.fromLocationId ? await W.locationFor(req, l.raw.fromLocationId) : null; const tl = l.raw.toLocationId ? await W.locationFor(req, l.raw.toLocationId) : null;
    if (sameWh && (!fl || !tl || Number(fl.id) === Number(tl.id))) throw new HttpError(400, "Entre deux emplacements d'un même entrepôt, indiquez l'emplacement de départ et celui d'arrivée.");
    if (fl && Number(fl.warehouse_id) !== Number(from.id)) throw new HttpError(400, "L'emplacement de départ n'est pas dans l'entrepôt de départ.");
    if (tl && (Number(tl.warehouse_id) !== Number(to.id) || !Number(tl.active) || tl.kind === 'transit')) throw new HttpError(400, "Choisissez un emplacement d'arrivée actif dans l'entrepôt d'arrivée.");
    l.fromLoc = fl ? Number(fl.id) : null; l.toLoc = tl ? Number(tl.id) : null;
  }
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'TR');
    const id = Number((await db.prepare('INSERT INTO wms_transfers (org_id, code, status, from_warehouse_id, to_warehouse_id, note, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, code, 'requested', from.id, to.id, cleanText(String(b.note || ''), 500), req.user.id, nowISO())).lastInsertRowid);
    for (const l of lines) await db.prepare('INSERT INTO wms_transfer_lines (transfer_id, item_id, quantity, from_location_id, to_location_id) VALUES (?, ?, ?, ?, ?)').run(id, l.it.id, l.quantity, l.fromLoc, l.toLoc);
    await log(id, 'requested', req.user.id, '');
    return { id, code };
  })();
  res.status(201).json(out);
});
router.post('/transfers/:id/ship', mgr, async (req, res) => {
  const t = await transferOf(req, req.params.id);
  if (t.status !== 'requested') throw new HttpError(400, 'Ce transfert a déjà été expédié ou annulé.');
  const transit = await W.transitOf(req.org.id);
  let total = 0;
  await db.transaction(async () => {
    // Double envoi : le statut se relit sous verrou, le second appel trouve le transfert déjà expédié.
    if ((await W.lockRow('wms_transfers', t.id)).status !== 'requested') throw new HttpError(400, 'Ce transfert a déjà été expédié ou annulé.');
    const lines = await db.prepare('SELECT * FROM wms_transfer_lines WHERE transfer_id = ?').all(t.id);
    const given = Object.fromEntries((Array.isArray((req.body || {}).lines) ? req.body.lines : []).map((x) => [Number(x && x.lineId), x]));
    for (const l of lines) {
      // Quantité à expédier : celle de la demande, ou moins (jamais plus) si l'expéditeur la précise.
      const g = given[Number(l.id)];
      if (g && g.quantity !== undefined && g.quantity !== '') {
        const q = H().qty(g.quantity);
        if (q > r3(l.quantity) + W.EPS) throw new HttpError(400, 'Vous ne pouvez pas expédier plus que la quantité demandée.');
        l.quantity = q;
      }
      const locs = l.from_location_id
        ? await db.prepare('SELECT location_id, quantity FROM wms_stock WHERE item_id = ? AND location_id = ? AND quantity > 0').all(l.item_id, l.from_location_id)
        : await db.prepare(`SELECT s.location_id, s.quantity FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND l.warehouse_id = ? AND l.active = 1 AND l.kind IN ('picking','storage','reception') AND s.quantity > 0
        ORDER BY CASE l.kind WHEN 'picking' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END, s.quantity DESC`).all(l.item_id, t.from_warehouse_id);
      let left = r3(l.quantity); const origins = [];
      for (const s of locs) {
        if (left <= W.EPS) break;
        const q = r3(Math.min(left, Number(s.quantity)));
        await W.move(req, l.item_id, s.location_id, transit.id, q, { kind: 'transfer_out', refKind: 'transfer', refId: t.id, reason: `Transfert ${t.code} : sortie`, allowTransit: true, guardReserved: true });
        origins.push({ locationId: Number(s.location_id), quantity: q }); left = r3(left - q);
      }
      const shipped = r3(Number(l.quantity) - left);
      total += shipped;
      await db.prepare('UPDATE wms_transfer_lines SET shipped_qty = ?, origins = ? WHERE id = ?').run(shipped, JSON.stringify(origins), l.id);
    }
    if (total <= W.EPS) throw new HttpError(400, 'Aucune quantité à expédier.');
    await db.prepare("UPDATE wms_transfers SET status = 'shipped', shipped_by = ? WHERE id = ?").run(req.user.id, t.id);
    await log(t.id, 'shipped', req.user.id, '');
  })();
  res.json({ ok: true });
});
router.post('/transfers/:id/receive', mgr, async (req, res) => {
  const t = await transferOf(req, req.params.id);
  if (t.status !== 'shipped') throw new HttpError(400, 'Ce transfert est terminé.');
  if (Number(t.shipped_by) === Number(req.user.id)) throw new HttpError(403, 'Une autre personne doit confirmer la réception (vous avez expédié ce transfert).');
  const transit = await W.transitOf(req.org.id);
  const linesOf = () => db.prepare('SELECT l.*, i.name, i.tracking, i.avg_cost, i.unit_cost FROM wms_transfer_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.transfer_id = ?').all(t.id);
  const input = Object.fromEntries((Array.isArray((req.body || {}).lines) ? req.body.lines : []).map((x) => [Number(x && x.lineId), x]));
  let gapTotal = 0; let gapVal = 0;
  await db.transaction(async () => {
    const cur = await W.lockRow('wms_transfers', t.id);
    if (cur.status !== 'shipped') throw new HttpError(400, 'Ce transfert est terminé.');
    if (Number(cur.shipped_by) === Number(req.user.id)) throw new HttpError(403, 'Une autre personne doit confirmer la réception (vous avez expédié ce transfert).');
    for (const l of await linesOf()) {
      const shipped = r3(l.shipped_qty);
      if (shipped <= W.EPS) continue;
      const x = input[Number(l.id)];
      let got = x && x.receivedQty !== undefined && x.receivedQty !== '' ? r3(Number(String(x.receivedQty).replace(',', '.'))) : shipped;
      if (!Number.isFinite(got) || got < 0) throw new HttpError(400, 'Quantité invalide : indiquez un nombre positif.');
      if (got > shipped + W.EPS) throw new HttpError(400, 'Vous ne pouvez pas recevoir plus que la quantité expédiée.');
      const gap = r3(shipped - got);
      if (gap > W.EPS && !cleanText(String((x && x.reason) || ''), 200)) throw new HttpError(400, `Indiquez le motif de l'écart pour « ${l.name} » (manquant ou abîmé).`);
      const dest = x && x.toLocationId ? await W.locationFor(req, x.toLocationId) : (l.to_location_id ? await W.locationOf(req.org.id, l.to_location_id) : null);
      if (dest && (Number(dest.warehouse_id) !== Number(t.to_warehouse_id) || !Number(dest.active) || dest.kind === 'transit')) throw new HttpError(400, "Choisissez un emplacement d'arrivée actif dans l'entrepôt d'arrivée.");
      if (got > W.EPS && dest) await W.move(req, l.item_id, transit.id, dest.id, got, { kind: 'transfer_in', refKind: 'transfer', refId: t.id, reason: `Transfert ${t.code} : arrivée`, allowTransit: true });
      else if (got > W.EPS) for (const d of await W.putawayPlan(req.org.id, { id: l.item_id, tracking: l.tracking }, got, { warehouseId: t.to_warehouse_id }).then(async (p) => (p.left > W.EPS ? [...p.plan, { location: await W.defaultOf(req.org.id, t.to_warehouse_id), quantity: p.left }] : p.plan))) {
        await W.move(req, l.item_id, transit.id, d.location.id, d.quantity, { kind: 'transfer_in', refKind: 'transfer', refId: t.id, reason: `Transfert ${t.code} : arrivée`, allowTransit: true });
      }
      let gapValue = 0;
      if (gap > W.EPS) {
        const reason = cleanText(String((x && x.reason) || ''), 200) || 'Écart à la réception du transfert';
        await W.withLocation(req, { locationId: transit.id }, () => L.adjust(req, l.item_id, -gap, `Transfert ${t.code} : écart (${reason})`, { serials: l.tracking === 'serial' ? (x && x.serials) : undefined, refKind: 'transfer', refId: t.id, allowExpired: true }));
        gapValue = Math.round(gap * unitValue(l)); gapTotal = r3(gapTotal + gap); gapVal += gapValue;
        await db.prepare('UPDATE wms_transfer_lines SET gap_reason = ? WHERE id = ?').run(reason, l.id);
      }
      await db.prepare('UPDATE wms_transfer_lines SET received_qty = ?, gap_qty = ?, gap_value = ? WHERE id = ?').run(got, gap, gapValue, l.id);
    }
    await db.prepare("UPDATE wms_transfers SET status = 'received' WHERE id = ?").run(t.id);
    await log(t.id, 'received', req.user.id, gapTotal ? `Écart : ${gapTotal}` : '');
  })();
  res.json({ ok: true, gapQty: gapTotal, gapValue: gapVal });
});
router.post('/transfers/:id/cancel', async (req, res) => {
  const t = await transferOf(req, req.params.id);
  if (t.status === 'requested') {
    if (Number(t.requested_by) !== Number(req.user.id) && !A.can(req, 'manager')) throw new HttpError(403, "Seule la personne qui a fait la demande, ou un responsable, peut l'annuler.");
    const c = await db.prepare("UPDATE wms_transfers SET status = 'cancelled' WHERE id = ? AND status = 'requested'").run(t.id);
    if (!c.changes) throw new HttpError(400, 'Ce transfert a déjà été expédié ou annulé.');
    await log(t.id, 'cancelled', req.user.id, '');
    return res.json({ ok: true });
  }
  if (t.status !== 'shipped') throw new HttpError(400, 'Ce transfert est terminé.');
  if (!A.can(req, 'manager')) throw new HttpError(403, "Votre rôle ne permet pas d'annuler un transfert en transit.");
  const reason = cleanText(String((req.body || {}).reason || ''), 300);
  if (!reason) throw new HttpError(400, 'Indiquez le motif : la marchandise en transit retourne au départ.');
  const transit = await W.transitOf(req.org.id);
  await db.transaction(async () => {
    if ((await W.lockRow('wms_transfers', t.id)).status !== 'shipped') throw new HttpError(400, 'Ce transfert est terminé.');
    for (const l of await db.prepare('SELECT * FROM wms_transfer_lines WHERE transfer_id = ?').all(t.id)) {
      let origins = []; try { origins = JSON.parse(l.origins); } catch { origins = []; }
      for (const o of origins) {
        const back = Math.min(o.quantity, await W.qtyAt(transit.id, l.item_id));
        if (back > W.EPS) await W.move(req, l.item_id, transit.id, o.locationId, back, { kind: 'transfer_cancel', refKind: 'transfer', refId: t.id, reason: `Transfert ${t.code} annulé`, allowTransit: true });
      }
    }
    await db.prepare("UPDATE wms_transfers SET status = 'cancelled' WHERE id = ?").run(t.id);
    await log(t.id, 'cancelled', req.user.id, reason);
  })();
  res.json({ ok: true });
});

// =====================================================================
// Réservations
// =====================================================================
const SOURCE = { document: 'Commande ou devis client', internal: 'Demande interne', manual: 'Réservation libre', pick: 'Liste de préparation', crossdock: 'Transbordement', kit: "Ordre d'assemblage" };
/** Une commande annulée, refusée ou supprimée libère ses réservations (voir wms-core.expireReservations). */
const syncReservations = (orgId) => W.expireReservations(orgId);
async function documentOf(req, idv) {
  const d = await db.prepare('SELECT d.*, c.name AS customer FROM documents d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.org_id = ?').get(A.id(idv), req.org.id);
  if (!d) throw new HttpError(404, 'Commande, devis ou facture introuvable.');
  if (!['order', 'quote', 'invoice'].includes(d.kind)) throw new HttpError(400, 'Seule une commande, un devis ou une facture peut réserver du stock.');
  if (['cancelled', 'refused'].includes(d.status)) throw new HttpError(400, 'Ce document est annulé ou refusé.');
  return d;
}
/** Lignes du document rattachées à un article : { itemId: quantité }. */
function docNeeds(d) {
  let lines = []; try { lines = JSON.parse(d.lines); } catch { lines = []; }
  const need = {};
  for (const l of lines) if (l && Number(l.itemId) > 0) need[Number(l.itemId)] = r3((need[Number(l.itemId)] || 0) + Number(l.quantity || 0));
  return need;
}
async function reserve(req, { itemId, quantity, sourceKind, documentId = null, pickId = null, label = '', neededBy = null, expiresAt = null, warehouseId = null }) {
  return Number((await db.prepare('INSERT INTO wms_reservations (org_id, item_id, quantity, status, source_kind, document_id, pick_id, label, needed_by, expires_at, created_by, created_at, warehouse_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, itemId, r3(quantity), 'active', sourceKind, documentId, pickId, label, neededBy, expiresAt, req.user.id, nowISO(), warehouseId)).lastInsertRowid);
}
const resView = (req) => (r) => ({
  id: Number(r.id), itemId: Number(r.item_id), item: r.item, unit: r.unit, quantity: r3(r.quantity), remaining: r3(r.quantity - r.fulfilled_qty), status: r.status,
  label: r.label || (r.doc ? r.doc : r.pick) || null, sourceLabel: SOURCE[r.source_kind], sourceKind: r.source_kind, fulfilledQty: r3(r.fulfilled_qty),
  neededBy: r.needed_by || null, expiresAt: r.expires_at || null, closeReason: r.close_reason || null, mine: Number(r.created_by) === Number(req.user.id),
  warehouseId: r.warehouse_id ? Number(r.warehouse_id) : null, documentId: r.document_id ? Number(r.document_id) : null, documentNumber: r.doc || null,
});
const RES_SQL = 'SELECT r.*, i.name AS item, i.unit, d.number AS doc, p.code AS pick FROM wms_reservations r JOIN stock_items i ON i.id = r.item_id LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN wms_picks p ON p.id = r.pick_id';
router.get('/documents/:id/reservations', async (req, res) => {
  await syncReservations(req.org.id);
  const rows = await db.prepare(`${RES_SQL} WHERE r.org_id = ? AND r.source_kind = 'document' AND r.document_id = ? ORDER BY r.id`).all(req.org.id, A.id(req.params.id));
  res.json({ reservations: rows.map(resView(req)) });
});
router.get('/reservations', async (req, res) => {
  await syncReservations(req.org.id);
  const item = req.query.itemId ? A.id(req.query.itemId) : null;
  // Forme de A : sans filtre, les réservations actives. Ajout (ligne B) : avec un article, tous les statuts (sauf si un statut est demandé).
  const st = ['active', 'fulfilled', 'released'].includes(req.query.status) ? req.query.status : (item ? null : 'active');
  const rows = await db.prepare(`${RES_SQL} WHERE r.org_id = ?${st ? ' AND r.status = ?' : ''}${item ? ' AND r.item_id = ?' : ''} ORDER BY (r.status = 'active') DESC, r.id DESC LIMIT 500`).all(req.org.id, ...(st ? [st] : []), ...(item ? [item] : []));
  res.json({ reservations: rows.map(resView(req)), active: rows.filter((r) => r.status === 'active').length });
});
router.post('/reservations', async (req, res) => {
  const b = req.body || {};
  const it = await H().itemOf(req, b.itemId);
  const q = H().qty(b.quantity);
  const label = A.text(b.label, 150, { required: true, msg: 'Indiquez pour quoi ou pour qui vous réservez.' });
  const kind = b.kind === 'manual' ? 'manual' : 'internal';
  if (kind === 'manual' && !A.can(req, 'manager')) throw new HttpError(403, 'Une réservation libre est réservée aux responsables (une demande interne est ouverte à tous).');
  const expires = A.date(b.expiresAt) || null;
  const wh = b.warehouseId ? await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(b.warehouseId, 'Entrepôt invalide.'), req.org.id) : null;
  if (b.warehouseId && (!wh || !A.visible(req, wh))) throw new HttpError(404, 'Entrepôt introuvable.');
  await syncReservations(req.org.id);
  const id = await db.transaction(async () => {
    await W.lockItem(req.org.id, it.id); // deux réservations simultanées ne dépassent jamais le disponible
    const av = await W.availability(it.id);
    if (av.available + W.EPS < q) throw new HttpError(400, `Pas assez de stock disponible pour « ${it.name} » : ${Math.max(0, av.available)} ${it.unit}.`);
    if (wh) {
      const free = r3((await W.usableIn(it.id, wh.id)) - (await W.reservedFor(it.id, wh.id)));
      if (q - free > W.EPS) throw new HttpError(409, `« ${it.name} » : ${Math.max(free, 0)} ${it.unit} seulement disponible(s) à promettre dans cet entrepôt.`);
    }
    return reserve(req, { itemId: it.id, quantity: q, sourceKind: kind, label, expiresAt: expires, neededBy: A.date(b.neededBy) || null, warehouseId: wh ? Number(wh.id) : null });
  })();
  res.status(201).json({ id });
});
router.post('/reservations/from-document', mgr, async (req, res) => {
  const b = req.body || {};
  const d = await documentOf(req, b.documentId);
  if (d.kind === 'invoice' && ['paid', 'credited'].includes(d.status)) throw new HttpError(400, 'Ce document est terminé ou refusé : il ne réserve plus de stock.');
  const need = docNeeds(d);
  if (!Object.keys(need).length) throw new HttpError(400, "Aucune ligne de ce document n'est rattachée à un article du stock.");
  let docLines = []; try { docLines = JSON.parse(d.lines); } catch { docLines = []; }
  const ignoredLines = docLines.filter((l) => !(l && Number(l.itemId) > 0)).length;
  await syncReservations(req.org.id);
  const reserved = []; const short = [];
  await db.transaction(async () => {
    for (const [itemId, q] of Object.entries(need).map(([k, v]) => [Number(k), v])) {
      const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(itemId, req.org.id);
      if (!it) continue;
      const already = r3(Number((await db.prepare("SELECT COALESCE(SUM(quantity - fulfilled_qty), 0) AS q FROM wms_reservations WHERE document_id = ? AND item_id = ? AND status = 'active'").get(d.id, itemId)).q));
      const want = r3(q - already);
      if (want <= W.EPS) { reserved.push({ itemId, name: it.name, quantity: already }); continue; }
      const av = Math.max(0, (await W.availability(itemId)).available);
      const take = b.partial ? r3(Math.min(av, want)) : (av + W.EPS >= want ? want : 0);
      if (take > W.EPS) { await reserve(req, { itemId, quantity: take, sourceKind: 'document', documentId: d.id, label: d.number }); reserved.push({ itemId, name: it.name, quantity: take }); }
      if (take + W.EPS < want) short.push({ itemId, name: it.name, missing: r3(want - take) });
    }
    // Ajout (ligne B) : « partial: false » explicite = tout ou rien (rien n'est réservé si un article manque).
    if (b.partial === false && short.length) throw new HttpError(409, `Stock insuffisant pour cette commande : ${short.map((x) => `${x.name} (il manque ${x.missing})`).join(', ')}.`);
  })();
  res.json({ reserved, short, ignoredLines });
});
async function reservationOf(req, idv) {
  const r = await db.prepare('SELECT r.*, i.name, i.unit FROM wms_reservations r JOIN stock_items i ON i.id = r.item_id WHERE r.id = ? AND r.org_id = ?').get(A.id(idv), req.org.id);
  if (!r) throw new HttpError(404, 'Réservation introuvable.');
  return r;
}
router.post('/reservations/:id/fulfill', mgr, async (req, res) => {
  const r = await reservationOf(req, req.params.id);
  if (r.status !== 'active') throw new HttpError(400, 'Cette réservation est déjà terminée.');
  const remaining = r3(r.quantity - r.fulfilled_qty);
  const q = (req.body || {}).quantity === undefined || req.body.quantity === '' ? remaining : H().qty(req.body.quantity);
  if (q > remaining + W.EPS) throw new HttpError(400, `Il reste ${remaining} ${r.unit} à livrer sur cette réservation.`);
  await db.transaction(async () => {
    // Relue sous verrou : un double envoi ne livre pas deux fois la même réservation.
    const cur = await W.lockRow('wms_reservations', r.id);
    const left = r3(cur.quantity - cur.fulfilled_qty);
    if (cur.status !== 'active' || q > left + W.EPS) throw new HttpError(400, cur.status !== 'active' ? 'Cette réservation est déjà terminée.' : `Il reste ${left} ${r.unit} à livrer sur cette réservation.`);
    const locId = (req.body || {}).locationId ? Number((await W.locationFor(req, A.id(req.body.locationId, 'Emplacement introuvable.'))).id) : undefined;
    await L.adjust(req, r.item_id, -q, `Réservation livrée${r.label ? ' : ' + r.label : ''}`, { refKind: 'reservation', refId: r.id, serials: (req.body || {}).serials, locationId: locId, covered: r.warehouse_id ? { [Number(r.warehouse_id)]: q } : undefined });
    const done = r3(Number(cur.fulfilled_qty) + q);
    await db.prepare('UPDATE wms_reservations SET fulfilled_qty = ?, status = ? WHERE id = ?').run(done, done + W.EPS >= Number(cur.quantity) ? 'fulfilled' : 'active', r.id);
  })();
  const after = await db.prepare('SELECT r.quantity, r.fulfilled_qty, r.status, i.quantity AS stock FROM wms_reservations r JOIN stock_items i ON i.id = r.item_id WHERE r.id = ?').get(r.id);
  res.json({ ok: true, status: after.status, remaining: r3(after.quantity - after.fulfilled_qty), quantity: r3(Number(after.stock)) }); // ajouts : état de la réservation et stock restant
});
router.post('/reservations/:id/release', async (req, res) => {
  const r = await reservationOf(req, req.params.id);
  if (r.status !== 'active') throw new HttpError(400, 'Cette réservation est terminée.');
  if (!A.can(req, 'manager') && !(r.source_kind === 'internal' && Number(r.created_by) === Number(req.user.id))) throw new HttpError(403, 'Votre rôle ne permet pas cette action.');
  const c = await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = ? WHERE id = ? AND status = 'active'").run(cleanText(String((req.body || {}).reason || ''), 200) || 'Libérée', r.id);
  if (!c.changes) throw new HttpError(400, 'Cette réservation est terminée.');
  res.json({ ok: true });
});

// =====================================================================
// Listes de préparation (picking)
// =====================================================================
async function pickOf(req, idv) {
  const p = await db.prepare('SELECT * FROM wms_picks WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!p) throw new HttpError(404, 'Liste de préparation introuvable.');
  return p;
}
/** Emplacements où prendre `qty` (préparation d'abord), dans la limite du disponible. Renvoie { plan: [{locationId, quantity}], got }. */
async function allocate(itemId, qty, { exceptDocument } = {}) {
  const av = await W.availability(itemId, { exceptDocument });
  let left = r3(Math.min(qty, Math.max(0, av.available)));
  const got = left; const plan = [];
  const rows = await db.prepare(`SELECT s.location_id, s.quantity FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND l.active = 1 AND l.kind IN ('picking','storage','reception') AND s.quantity > 0
    ORDER BY CASE l.kind WHEN 'picking' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END, l.aisle, l.rack, l.bin, l.code`).all(itemId);
  for (const s of rows) {
    if (left <= W.EPS) break;
    // Le stock de l'emplacement déjà promis aux listes en cours n'est pas promis deux fois.
    const held = r3(Number((await db.prepare("SELECT COALESCE(SUM(pl.quantity - pl.picked_qty), 0) AS q FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id WHERE pl.location_id = ? AND pl.item_id = ? AND pl.done = 0 AND p.status IN ('open','in_progress')").get(s.location_id, itemId)).q));
    const q = r3(Math.min(left, Number(s.quantity) - held));
    if (q <= W.EPS) continue;
    plan.push({ locationId: Number(s.location_id), quantity: q }); left = r3(left - q);
  }
  return { plan, got: r3(got - left) };
}
/** Crée une liste de préparation (dans la transaction de l'appelant) : emplacements alloués, réservation de la liste. Renvoie { id, code, short }. */
async function createPick(req, { doc = null, wants, priority = 2, label = '', assigned = null, waveId = null, strict = false }) {
  const plans = [];
  for (const w of wants) {
    await W.lockItem(req.org.id, w.itemId); // deux listes simultanées ne promettent jamais deux fois le même stock
    const a = await allocate(w.itemId, w.quantity, { exceptDocument: doc ? doc.id : undefined });
    // « strict » (ligne B) : tout ou rien — si un article manque, rien n'est créé (409).
    if (strict && a.got + W.EPS < w.quantity) throw new HttpError(409, `Stock disponible insuffisant pour préparer cette liste (article n° ${w.itemId} : ${a.got} sur ${w.quantity}).`);
    if (a.got > W.EPS) plans.push({ ...w, ...a });
  }
  if (!plans.length) throw new HttpError(400, doc ? `Rien à préparer pour ${doc.number} : aucun stock disponible.` : 'Rien à préparer : aucun stock disponible.');
  const code = await W.nextCode(req.org.id, 'PR');
  const id = Number((await db.prepare('INSERT INTO wms_picks (org_id, code, status, priority, document_id, label, assigned_to, created_by, created_at, wave_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, code, 'open', priority, doc ? doc.id : null, cleanText(String(label || ''), 150) || (doc ? doc.number : ''), assigned, req.user.id, nowISO(), waveId)).lastInsertRowid);
  // La réservation du document est reprise par la liste.
  if (doc) await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = ? WHERE document_id = ? AND status = 'active'").run(`Reprise par la liste ${code}`, doc.id);
  for (const p of plans) {
    for (const x of p.plan) await db.prepare('INSERT INTO wms_pick_lines (pick_id, item_id, location_id, quantity) VALUES (?, ?, ?, ?)').run(id, p.itemId, x.locationId, x.quantity);
    await reserve(req, { itemId: p.itemId, quantity: p.got, sourceKind: 'pick', pickId: id, documentId: doc ? doc.id : null, label: code });
  }
  // Services à valeur ajoutée prévus par les règles (article, client, toutes les préparations).
  await require('./wms-vas').autoAttach(req, 'pick', id, { customerId: doc ? doc.customer_id : null, items: plans.map((p) => ({ itemId: p.itemId, quantity: p.got })) });
  return { id, code, short: plans.length < wants.length || plans.some((p) => p.got + W.EPS < p.quantity) };
}
const PRIORITY = { 1: 'Urgente', 2: 'Normale', 3: 'Basse' };
router.get('/picks', async (req, res) => {
  const st = String(req.query.status || '');
  const all = A.can(req, 'manager') || String(req.query.mine) === '0';
  const rows = await db.prepare(`SELECT p.*, d.number AS doc, c.name AS customer, u.name AS assignee, wv.code AS wave, (SELECT COUNT(*) FROM wms_pick_lines l WHERE l.pick_id = p.id) AS n, (SELECT COUNT(*) FROM wms_pick_lines l WHERE l.pick_id = p.id AND l.short = 1) AS sh
    FROM wms_picks p LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN users u ON u.id = p.assigned_to LEFT JOIN wms_waves wv ON wv.id = p.wave_id
    WHERE p.org_id = ?${st ? ' AND p.status = ?' : " AND p.status != 'cancelled'"}${all ? '' : ' AND (p.assigned_to IS NULL OR p.assigned_to = ?)'} ORDER BY CASE WHEN p.status IN ('open','in_progress') THEN 0 ELSE 1 END, p.priority, p.id DESC LIMIT 300`)
    .all(req.org.id, ...(st ? [st] : []), ...(all ? [] : [req.user.id]));
  res.json({ waiting: rows.filter((p) => ['open', 'in_progress'].includes(p.status)).length, picks: rows.map((p) => ({ id: Number(p.id), code: p.code, status: p.status, priority: Number(p.priority), priorityLabel: PRIORITY[Number(p.priority)], documentNumber: p.doc || null, customer: p.customer || null, label: p.label || null, lineCount: Number(p.n), createdAt: p.created_at, assignedName: p.assignee || null, short: Number(p.sh) > 0, waveId: p.wave_id ? Number(p.wave_id) : null, waveCode: p.wave || null, packedAt: p.packed_at || null, shippedAt: p.shipped_at || null })) });
});
router.get('/picks/:id', async (req, res) => {
  const p = await pickOf(req, req.params.id);
  const d = p.document_id ? await db.prepare('SELECT d.number, c.name AS customer FROM documents d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = ?').get(p.document_id) : null;
  const lines = await db.prepare(`SELECT pl.*, i.name, i.unit, i.tracking, l.code, l.aisle, l.rack, l.bin FROM wms_pick_lines pl JOIN stock_items i ON i.id = pl.item_id LEFT JOIN wms_locations l ON l.id = pl.location_id
    WHERE pl.pick_id = ? ORDER BY COALESCE(l.aisle, ''), COALESCE(l.rack, ''), COALESCE(l.bin, ''), COALESCE(l.code, ''), pl.id`).all(p.id);
  res.json({ pick: {
    id: Number(p.id), code: p.code, status: p.status, priority: Number(p.priority), priorityLabel: PRIORITY[Number(p.priority)], documentNumber: d ? d.number : null, customer: d ? d.customer : null, label: p.label || null,
    waveId: p.wave_id ? Number(p.wave_id) : null, packedAt: p.packed_at || null, shippedAt: p.shipped_at || null,
    toPick: r3(lines.reduce((s, l) => s + Number(l.quantity), 0)), picked: r3(lines.reduce((s, l) => s + Number(l.picked_qty), 0)),
    lines: lines.map((l) => ({ id: Number(l.id), itemId: Number(l.item_id), name: l.name, unit: l.unit, tracking: l.tracking || 'none', location: l.code || null, locationId: l.location_id ? Number(l.location_id) : null, aisle: l.aisle || '', rack: l.rack || '', bin: l.bin || '', quantity: r3(l.quantity), pickedQty: r3(l.picked_qty), done: Boolean(Number(l.done)), short: Boolean(Number(l.short)) })),
  } });
});
router.post('/picks', mgr, async (req, res) => {
  const b = req.body || {};
  const priority = [1, 2, 3].includes(Number(b.priority)) ? Number(b.priority) : 2;
  let assigned = null;
  if (b.assignedTo !== undefined && b.assignedTo !== null && b.assignedTo !== '') assigned = await A.memberOf(req, b.assignedTo);
  let doc = null; let wants = [];
  if (b.documentId !== undefined && b.documentId !== null && b.documentId !== '') {
    doc = await documentOf(req, b.documentId);
    const need = docNeeds(doc);
    if (!Object.keys(need).length) throw new HttpError(400, "Aucune ligne de ce document n'est rattachée à un article du stock.");
    wants = Object.entries(need).map(([k, v]) => ({ itemId: Number(k), quantity: v }));
  } else {
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw new HttpError(400, 'Choisissez une commande ou ajoutez au moins une ligne (100 au plus).');
    wants = (await readLines(req, b.lines)).map((l) => ({ itemId: Number(l.it.id), quantity: l.quantity }));
  }
  if (b.warehouseId !== undefined && b.warehouseId !== null && b.warehouseId !== '') await H().warehouseOf(req, b.warehouseId); // entrepôt inconnu → 404
  await syncReservations(req.org.id);
  const out = await db.transaction(() => createPick(req, { doc, wants, priority, label: b.label, assigned, strict: b.strict === true }))();
  res.status(201).json(out);
});
router.post('/picks/:id/start', async (req, res) => {
  const p = await pickOf(req, req.params.id);
  if (p.assigned_to && Number(p.assigned_to) !== Number(req.user.id) && !A.can(req, 'manager')) throw new HttpError(403, 'Cette liste est confiée à une autre personne.');
  if (!['open', 'in_progress'].includes(p.status)) throw new HttpError(409, 'Cette liste est terminée ou annulée.');
  await db.prepare("UPDATE wms_picks SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ?").run(nowISO(), p.id);
  res.json({ ok: true });
});
router.post('/picks/:id/lines/:lineId/confirm', async (req, res) => {
  const p = await pickOf(req, req.params.id);
  if (!['open', 'in_progress'].includes(p.status)) throw new HttpError(400, 'Cette liste est terminée ou annulée.');
  if (p.assigned_to && Number(p.assigned_to) !== Number(req.user.id) && !A.can(req, 'manager')) throw new HttpError(403, 'Cette liste est confiée à une autre personne.');
  const line = await db.prepare('SELECT pl.*, i.barcode, i.sku, i.name, l.code FROM wms_pick_lines pl JOIN stock_items i ON i.id = pl.item_id LEFT JOIN wms_locations l ON l.id = pl.location_id WHERE pl.id = ? AND pl.pick_id = ?').get(A.id(req.params.lineId), p.id);
  if (!line) throw new HttpError(404, 'Ligne introuvable.');
  if (Number(line.done)) throw new HttpError(400, 'Cette ligne est déjà prélevée.');
  const b = req.body || {};
  if (b.itemCode && ![line.barcode, line.sku].filter(Boolean).map((x) => x.toUpperCase()).includes(String(b.itemCode).trim().toUpperCase())) throw new HttpError(400, `Ce n'est pas le bon article : attendu « ${line.name} ».`);
  let locId = line.location_id ? Number(line.location_id) : null;
  if (b.fromLocationId) {
    const l = await W.locationOf(req.org.id, A.id(b.fromLocationId));
    if (!W.isUsable(l)) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
    locId = Number(l.id);
  } else if (b.locationCode && line.code && String(b.locationCode).trim().toUpperCase() !== line.code.toUpperCase()) throw new HttpError(400, `Ce n'est pas le bon emplacement : allez en ${line.code}.`);
  const remaining = r3(line.quantity - line.picked_qty);
  if (b.quantity !== undefined && b.quantity !== null && b.quantity !== '' && H().qty(b.quantity) > remaining + W.EPS) throw new HttpError(400, `Il reste ${remaining} à prélever sur cette ligne.`);
  const q = b.quantity === undefined || b.quantity === null || b.quantity === '' ? remaining : H().qty(b.quantity);
  if (locId && await W.qtyAt(locId, line.item_id) + W.EPS < q) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  let from = []; try { from = JSON.parse(line.picked_from); } catch { from = []; }
  from.push({ locationId: locId, quantity: q });
  const picked = r3(line.picked_qty + q);
  const short = b.quantity !== undefined && b.quantity !== '' && picked + W.EPS < line.quantity;
  await db.prepare('UPDATE wms_pick_lines SET picked_qty = ?, picked_from = ?, done = ?, short = ?, picked_by = ?, picked_at = ? WHERE id = ?').run(picked, JSON.stringify(from), picked + W.EPS >= line.quantity || short ? 1 : 0, short ? 1 : 0, req.user.id, nowISO(), line.id);
  if (p.status === 'open') await db.prepare("UPDATE wms_picks SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ?").run(nowISO(), p.id);
  await require('./wms-pilot').record(req, 'pick', { lines: 1, units: q, refKind: 'pick', refId: p.id });
  res.json({ ok: true, pickedQty: picked, done: picked + W.EPS >= line.quantity || short });
});
router.post('/picks/:id/complete', async (req, res) => {
  const p = await pickOf(req, req.params.id);
  if (!['open', 'in_progress'].includes(p.status)) throw new HttpError(400, 'Cette liste est terminée.');
  if (p.assigned_to && Number(p.assigned_to) !== Number(req.user.id) && !A.can(req, 'manager')) throw new HttpError(403, 'Cette liste est confiée à une autre personne.');
  const lines = await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ?').all(p.id);
  if (!lines.some((l) => Number(l.picked_qty) > W.EPS)) throw new HttpError(400, "Rien n'a encore été prélevé.");
  const open = lines.filter((l) => !Number(l.done));
  if (open.length && !(req.body || {}).allowShort) throw new HttpError(409, `${open.length} ligne(s) ne sont pas entièrement prélevées. Terminer quand même ? Le reste ne sera pas préparé.`);
  await db.transaction(async () => {
    if (!['open', 'in_progress'].includes((await W.lockRow('wms_picks', p.id)).status)) throw new HttpError(400, 'Cette liste est terminée.');
    for (const l of open) await db.prepare('UPDATE wms_pick_lines SET done = 1, short = 1 WHERE id = ?').run(l.id);
    // La réservation se réduit à ce qui a été prélevé.
    const byItem = {}; for (const l of lines) byItem[l.item_id] = r3((byItem[l.item_id] || 0) + Number(l.picked_qty));
    for (const [itemId, q] of Object.entries(byItem)) await db.prepare("UPDATE wms_reservations SET quantity = ? WHERE pick_id = ? AND item_id = ? AND status = 'active'").run(q, p.id, Number(itemId));
    await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Rien prélevé' WHERE pick_id = ? AND status = 'active' AND quantity <= 0").run(p.id);
    await db.prepare("UPDATE wms_picks SET status = 'picked', picked_at = ? WHERE id = ?").run(nowISO(), p.id);
    // Préparation partielle (ligne B, option « keepShortfall: true » ; par défaut A libère le manque, prouvé par test-wms.js) : le manque reste réservé pour la commande, qui existe toujours (dans la limite de ce qui est disponible).
    if (p.document_id && (req.body || {}).keepShortfall === true) {
      const doc = await db.prepare('SELECT status FROM documents WHERE id = ?').get(p.document_id);
      if (doc && !['cancelled', 'refused'].includes(doc.status)) {
        const wanted = {}; for (const l of lines) wanted[l.item_id] = r3((wanted[l.item_id] || 0) + Number(l.quantity));
        for (const [itemId, q] of Object.entries(byItem)) {
          const miss = r3(wanted[itemId] - q); if (miss <= W.EPS) continue;
          const take = r3(Math.min(miss, Math.max(0, (await W.availability(Number(itemId))).available)));
          if (take > W.EPS) await db.prepare("INSERT INTO wms_reservations (org_id, item_id, quantity, status, source_kind, document_id, label, created_by, created_at) VALUES (?, ?, ?, 'active', 'document', ?, ?, ?, ?)").run(req.org.id, Number(itemId), take, p.document_id, p.label || '', req.user.id, nowISO());
        }
      }
    }
  })();
  res.json({ ok: true });
});
router.post('/picks/:id/issue', mgr, async (req, res) => {
  await issuePick(req, await pickOf(req, req.params.id));
  res.json({ ok: true });
});
/** Sort du stock ce qui a été prélevé pour une liste (route /picks/:id/issue et /waves/:id/issue). */
async function issuePick(req, p) {
  if (p.status !== 'picked') throw new HttpError(400, 'Terminez d\'abord la préparation.');
  if (await db.prepare("SELECT 1 FROM wms_hus WHERE pick_id = ? AND status NOT IN ('empty','shipped') LIMIT 1").get(p.id)) throw new HttpError(400, "Cette liste est emballée en colis : expédiez-la depuis l'écran Expéditions.");
  await require('./wms-vas').assertDone(req, { pickIds: [Number(p.id)] });
  // Colisage (ligne B) : dès qu'un colis existe, tout ce qui est prélevé doit être emballé.
  if (await db.prepare('SELECT 1 FROM wms_packages WHERE pick_id = ? LIMIT 1').get(p.id)) {
    const rest = await require('./wms-b-units').unpackedOf(p.id);
    if (rest.length) throw new HttpError(409, `Colisage incomplet : ${rest.map((x) => `${x.name} (${x.q})`).join(', ')} pas encore emballé(s).`);
  }
  const serials = (req.body || {}).serials || {};
  await db.transaction(async () => {
    // Double envoi : le second appel attend le premier puis trouve la liste déjà sortie (le stock ne sort qu'une fois).
    if ((await W.lockRow('wms_picks', p.id)).status !== 'picked') throw new HttpError(400, 'Cette liste a déjà été sortie du stock, ou n\'est pas terminée.');
    const lines = await db.prepare('SELECT pl.*, i.tracking, i.name FROM wms_pick_lines pl JOIN stock_items i ON i.id = pl.item_id WHERE pl.pick_id = ?').all(p.id);
    const serialLeft = {};
    for (const [k, v] of Object.entries(serials)) serialLeft[Number(k)] = L.parseSerials(v);
    for (const l of lines) {
      let from = []; try { from = JSON.parse(l.picked_from); } catch { from = []; }
      for (const f of from) {
        if (f.quantity <= W.EPS) continue;
        let sr;
        if (l.tracking === 'serial') { const all = serialLeft[Number(l.item_id)] || []; sr = all.splice(0, Math.round(f.quantity)); }
        await L.adjust(req, l.item_id, -f.quantity, `Liste de préparation ${p.code}`, { locationId: f.locationId || undefined, serials: sr, refKind: 'pick', refId: p.id });
      }
    }
    await db.prepare("UPDATE wms_reservations SET status = 'fulfilled', fulfilled_qty = quantity WHERE pick_id = ? AND status = 'active'").run(p.id);
    await db.prepare("UPDATE wms_picks SET status = 'issued', done_at = ? WHERE id = ?").run(nowISO(), p.id);
    // Réapprovisionnement automatique des emplacements de préparation passés sous leur minimum.
    for (const l of lines) for (const f of (() => { try { return JSON.parse(l.picked_from); } catch { return []; } })()) if (f.locationId) await require('./wms-replen').autoCheck(req, f.locationId, l.item_id);
  })();
}
router.post('/picks/:id/cancel', mgr, async (req, res) => {
  const p = await pickOf(req, req.params.id);
  if (!['open', 'in_progress', 'picked'].includes(p.status)) throw new HttpError(400, 'Cette liste est terminée ou annulée.');
  await db.transaction(async () => {
    if (!['open', 'in_progress', 'picked'].includes((await W.lockRow('wms_picks', p.id)).status)) throw new HttpError(400, 'Cette liste est terminée ou annulée.');
    // La marchandise déjà déposée ou emballée retourne à son emplacement de prélèvement.
    await require('./wms-outbound').unstagePick(req, p);
    await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Liste annulée' WHERE pick_id = ? AND status = 'active'").run(p.id);
    await db.prepare("UPDATE wms_picks SET status = 'cancelled' WHERE id = ?").run(p.id);
    await db.prepare("UPDATE wms_vas_tasks SET status = 'cancelled', result = 'Liste annulée' WHERE ref_kind = 'pick' AND ref_id = ? AND status IN ('open','in_progress')").run(p.id);
  })();
  res.json({ ok: true });
});

// =====================================================================
// Retours et rebuts
// =====================================================================
const RETURN_KIND = { customer: 'Retour client', supplier: 'Retour fournisseur', scrap: 'Mise au rebut' };
const REASONS = {
  // Les codes de la ligne A sont gardés ; ceux de la ligne B (wrong, damaged, unwanted, excess, lost…) sont acceptés aussi (ajout).
  customer: { defective: 'Défectueux', wrong_order: 'Erreur de commande', transport: 'Abîmé au transport', unsuitable: 'Ne convient pas', expired: 'Périmé', other: 'Autre', wrong: 'Erreur de commande', damaged: 'Abîmé au transport', unwanted: 'Ne convient pas' },
  supplier: { wrong_delivery: 'Erreur de livraison', damaged: 'Abîmé à la livraison', surplus: 'Surplus', defective: 'Défectueux', expired: 'Périmé', other: 'Autre', wrong: 'Erreur de livraison', excess: 'Surplus' },
  scrap: { breakage: 'Casse', expiry: 'Péremption', loss: 'Perte ou vol', defect: 'Défaut', other: 'Autre', damaged: 'Casse', expired: 'Péremption', lost: 'Perte ou vol', defective: 'Défaut' },
};
router.get('/returns/reasons', (req, res) => res.json({ reasons: REASONS }));
async function returnOf(req, idv) {
  const r = await db.prepare('SELECT r.*, c.name AS customer, s.name AS supplier, d.number AS doc, po.number AS po, pi.number AS pi FROM wms_returns r LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN pur_orders po ON po.id = r.purchase_order_id LEFT JOIN pur_invoices pi ON pi.id = r.purchase_invoice_id WHERE r.id = ? AND r.org_id = ?').get(A.id(idv), req.org.id);
  if (!r) throw new HttpError(404, 'Retour introuvable.');
  return r;
}
const retValue = (lines) => Math.round(lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_value), 0));
router.get('/returns', async (req, res) => {
  const kind = RETURN_KIND[req.query.kind] ? req.query.kind : '';
  const status = ['draft', 'done', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const m = A.can(req, 'manager');
  const rows = await db.prepare(`SELECT r.*, c.name AS customer, s.name AS supplier, d.number AS doc FROM wms_returns r LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN documents d ON d.id = r.document_id
    WHERE r.org_id = ?${kind ? ' AND r.kind = ?' : ''}${status ? ' AND r.status = ?' : ''} ORDER BY r.id DESC LIMIT 300`).all(req.org.id, ...(kind ? [kind] : []), ...(status ? [status] : []));
  const out = [];
  for (const r of rows) {
    const lines = await db.prepare('SELECT * FROM wms_return_lines WHERE return_id = ?').all(r.id);
    out.push({ id: Number(r.id), code: r.code, status: r.status, kind: r.kind, kindLabel: RETURN_KIND[r.kind], customer: r.customer || null, supplier: r.supplier || null, documentNumber: r.doc || null, lineCount: lines.length, rmaNo: r.rma_no || null, creditStatus: r.credit_status || null, createdAt: r.created_at, value: m ? retValue(lines) : undefined, pending: r.status === 'done' && lines.some((l) => l.disposition === 'quarantine' && !l.final) });
  }
  const toDecide = Number((await db.prepare("SELECT COUNT(*) AS c FROM wms_return_lines l JOIN wms_returns r ON r.id = l.return_id WHERE r.org_id = ? AND r.status = 'done' AND l.disposition = 'quarantine' AND l.final IS NULL").get(req.org.id)).c);
  res.json({ toDecide, returns: out });
});
router.get('/returns/:id', async (req, res) => {
  const r = await returnOf(req, req.params.id);
  const m = A.can(req, 'manager');
  const lines = await db.prepare('SELECT rl.*, i.name, l.code FROM wms_return_lines rl JOIN stock_items i ON i.id = rl.item_id LEFT JOIN wms_locations l ON l.id = rl.location_id WHERE rl.return_id = ? ORDER BY rl.id').all(r.id);
  res.json({ return: {
    id: Number(r.id), code: r.code, status: r.status, kind: r.kind, kindLabel: RETURN_KIND[r.kind], customer: r.customer || null, supplier: r.supplier || null, documentNumber: r.doc || null, reason: r.reason || null,
    creditAmount: !m ? undefined : r.credit_amount === null ? null : Number(r.credit_amount), creditedAt: r.credited_at || null, value: m ? retValue(lines) : undefined,
    rmaNo: r.rma_no || null, purchaseOrderId: r.purchase_order_id ? Number(r.purchase_order_id) : null, purchaseOrder: r.po || null, purchaseInvoiceId: r.purchase_invoice_id ? Number(r.purchase_invoice_id) : null, purchaseInvoice: r.pi || null, creditStatus: r.credit_status || null,
    lines: lines.map((l) => ({ id: Number(l.id), itemId: Number(l.item_id), name: l.name, quantity: r3(l.quantity), reasonCode: l.reason_code, reasonLabel: (REASONS[r.kind] || {})[l.reason_code] || 'Autre', disposition: l.disposition, final: l.final || null, location: l.code || null, value: m ? Math.round(Number(l.quantity) * Number(l.unit_value)) : undefined })),
  } });
});
async function validateReturn(req, r) {
  const lines = await db.prepare('SELECT rl.*, i.tracking FROM wms_return_lines rl JOIN stock_items i ON i.id = rl.item_id WHERE rl.return_id = ?').all(r.id);
  const label = `${RETURN_KIND[r.kind]} ${r.code}`;
  for (const l of lines) {
    const q = Number(l.quantity);
    const opts = { refKind: 'return', refId: r.id, serials: l.serials || undefined, lotNo: l.lot_no || undefined, allowExpired: true };
    if (r.kind === 'customer') {
      if (l.disposition === 'scrap') { await db.prepare("UPDATE wms_return_lines SET final = 'scrap' WHERE id = ?").run(l.id); continue; }
      if (l.disposition === 'quarantine') {
        const loc = await W.returnsOf(req.org.id);
        await L.adjust(req, l.item_id, q, `${label} : à contrôler`, { ...opts, locationId: loc.id, unitCost: Number(l.unit_value) || undefined });
        await db.prepare('UPDATE wms_return_lines SET location_id = ? WHERE id = ?').run(loc.id, l.id);
        continue;
      }
      await L.adjust(req, l.item_id, q, 'Retour remis en stock', { ...opts, locationId: l.location_id || undefined, unitCost: Number(l.unit_value) || undefined });
      await db.prepare("UPDATE wms_return_lines SET final = 'restock' WHERE id = ?").run(l.id);
    } else {
      // Le stock réservé ne retourne pas au fournisseur et ne se met pas au rebut (hors emplacement précisé : marchandise déjà isolée).
      if (!l.location_id) await W.reservedGuard(l.item_id, q);
      await L.adjust(req, l.item_id, -q, label, { ...opts, locationId: l.location_id || undefined, lotNo: undefined, preferLot: { lotNo: l.lot_no } });
      await db.prepare('UPDATE wms_return_lines SET final = ? WHERE id = ?').run(r.kind === 'scrap' ? 'scrap' : null, l.id);
    }
  }
  await db.prepare("UPDATE wms_returns SET status = 'done', validated_by = ? WHERE id = ?").run(req.user.id, r.id);
}
router.post('/returns', async (req, res) => {
  const b = req.body || {};
  const kind = RETURN_KIND[b.kind] ? b.kind : null;
  if (!kind) throw new HttpError(400, 'Type de retour inconnu.');
  if (b.validate && !A.can(req, 'manager')) throw new HttpError(403, 'Seul un responsable valide un retour : enregistrez-le comme brouillon.');
  const lines = await readLines(req, b.lines);
  const reason = cleanText(String(b.reason || ''), 500);
  let customerId = null; let supplierId = null; let documentId = null;
  if (kind === 'customer' && b.customerId) { const c = await db.prepare('SELECT id FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId), req.org.id); if (!c) throw new HttpError(404, 'Client introuvable.'); customerId = c.id; }
  if (kind === 'supplier' && b.supplierId) { const s = await db.prepare('SELECT id FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(b.supplierId), req.org.id); if (!s) throw new HttpError(404, 'Fournisseur introuvable.'); supplierId = s.id; }
  let doc = null;
  if (b.documentId) { doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(A.id(b.documentId), req.org.id); if (!doc) throw new HttpError(404, 'Commande ou facture introuvable.'); documentId = doc.id; if (kind === 'customer' && !customerId && doc.customer_id) customerId = doc.customer_id; }
  // Retour fournisseur lié à une commande du module Stock (ligne B) : on ne rend pas plus que ce qui a été reçu.
  let stockOrder = null;
  if (kind === 'supplier' && b.orderId) { stockOrder = await db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND org_id = ?').get(A.id(b.orderId, 'Commande invalide.'), req.org.id); if (!stockOrder) throw new HttpError(404, "Commande d'achat introuvable."); }
  const rma = kind === 'supplier' ? await rmaFields(req, b, { supplierId }) : {};
  if (rma.supplierId) supplierId = rma.supplierId;
  const rows = [];
  for (const l of lines) {
    const code = REASONS[kind][l.raw.reasonCode] ? l.raw.reasonCode : 'other';
    if (kind === 'scrap' && code === 'other' && !reason) throw new HttpError(400, 'Précisez le motif de la mise au rebut.');
    const disposition = kind === 'customer' ? (['restock', 'quarantine', 'scrap'].includes(l.raw.disposition) ? l.raw.disposition : 'restock') : kind === 'supplier' ? 'to_supplier' : 'scrap';
    let loc = null;
    if (l.raw.locationId) { const x = await W.locationOf(req.org.id, A.id(l.raw.locationId)); if (!Number(x.active) || x.kind === 'transit') throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).'); loc = x.id; }
    const q = l.quantity;
    if (l.it.tracking === 'lot' && kind === 'customer' && disposition !== 'scrap' && !cleanText(String(l.raw.lotNo || ''), 40)) throw new HttpError(400, `« ${l.it.name} » est suivi par lot : indiquez le numéro de lot rendu.`);
    if (loc && kind === 'customer' && disposition === 'restock') { const lx = await W.locationOf(req.org.id, loc); if (!W.isUsable(lx)) throw new HttpError(400, `L'emplacement ${lx.code} n'est pas un emplacement de stockage disponible.`); }
    if (doc && kind === 'customer') { // retour client lié à une commande : pas plus que vendu, retours cumulés compris
      let dl = []; try { dl = JSON.parse(doc.lines); } catch { dl = []; }
      const sold = dl.filter((x) => Number(x.itemId) === Number(l.it.id)).reduce((a, x) => a + Number(x.quantity || 0), 0);
      if (!sold) throw new HttpError(400, `« ${l.it.name} » ne figure pas sur ${doc.number}.`);
      const back = Number((await db.prepare("SELECT COALESCE(SUM(rl.quantity), 0) AS q FROM wms_return_lines rl JOIN wms_returns r ON r.id = rl.return_id WHERE r.org_id = ? AND r.document_id = ? AND r.kind = 'customer' AND r.status <> 'cancelled' AND rl.item_id = ?").get(req.org.id, doc.id, l.it.id)).q);
      if (q + back - sold > W.EPS) throw new HttpError(400, `« ${l.it.name} » : ${sold} vendu(s) sur ${doc.number}, ${back} déjà rendu(s) : on ne peut rendre que ${r3(Math.max(sold - back, 0))}.`);
    }
    if (stockOrder) {
      if (Number(stockOrder.item_id) !== Number(l.it.id)) throw new HttpError(400, `« ${l.it.name} » ne figure pas sur la commande d'achat n° ${stockOrder.id}.`);
      const back = Number((await db.prepare("SELECT COALESCE(SUM(rl.quantity), 0) AS q FROM wms_return_lines rl JOIN wms_returns r ON r.id = rl.return_id WHERE r.org_id = ? AND r.order_id = ? AND r.kind = 'supplier' AND r.status <> 'cancelled' AND rl.item_id = ?").get(req.org.id, stockOrder.id, l.it.id)).q);
      if (q + back - Number(stockOrder.received_qty) > W.EPS) throw new HttpError(400, `« ${l.it.name} » : ${stockOrder.received_qty} reçu(s) sur la commande n° ${stockOrder.id}, ${back} déjà rendu(s) : on ne peut rendre que ${r3(Math.max(Number(stockOrder.received_qty) - back, 0))}.`);
    }
    rows.push({ ...l, code, disposition, loc, lot: cleanText(String(l.raw.lotNo || ''), 40), serials: l.raw.serials ? L.parseSerials(l.raw.serials).join('\n') : '' });
  }
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'RT');
    const id = Number((await db.prepare('INSERT INTO wms_returns (org_id, code, kind, status, customer_id, supplier_id, document_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, code, kind, 'draft', customerId, supplierId, documentId, reason, req.user.id, nowISO())).lastInsertRowid);
    if (stockOrder) await db.prepare('UPDATE wms_returns SET order_id = ? WHERE id = ?').run(stockOrder.id, id);
    if (kind === 'supplier') await db.prepare('UPDATE wms_returns SET rma_no = ?, purchase_order_id = ?, purchase_invoice_id = ?, credit_status = ? WHERE id = ?').run(rma.rmaNo || '', rma.purchaseOrderId || null, rma.purchaseInvoiceId || null, rma.rmaNo ? 'requested' : '', id);
    for (const l of rows) await db.prepare('INSERT INTO wms_return_lines (return_id, item_id, quantity, reason_code, disposition, location_id, lot_no, serials, unit_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, l.it.id, l.quantity, l.code, l.disposition, l.loc, l.lot, l.serials, unitValue(l.it));
    if (b.validate) await validateReturn(req, await returnOf(req, id));
    return { id, code };
  })();
  res.status(201).json(out);
});
router.post('/returns/:id/validate', mgr, async (req, res) => {
  const r = await returnOf(req, req.params.id);
  if (r.status !== 'draft') throw new HttpError(400, 'Ce retour est déjà validé ou annulé.');
  await db.transaction(async () => {
    if ((await W.lockRow('wms_returns', r.id)).status !== 'draft') throw new HttpError(400, 'Ce retour est déjà validé ou annulé.');
    await validateReturn(req, r);
  })();
  res.json({ ok: true });
});
router.post('/returns/:id/cancel', async (req, res) => {
  const r = await returnOf(req, req.params.id);
  if (r.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être annulé (un retour validé a déjà bougé le stock).');
  if (Number(r.created_by) !== Number(req.user.id) && !A.can(req, 'manager')) throw new HttpError(403, 'Votre rôle ne permet pas cette action.');
  const c = await db.prepare("UPDATE wms_returns SET status = 'cancelled' WHERE id = ? AND status = 'draft'").run(r.id);
  if (!c.changes) throw new HttpError(400, 'Seul un brouillon peut être annulé (un retour validé a déjà bougé le stock).');
  res.json({ ok: true });
});
router.post('/returns/:id/lines/:lineId/dispose', mgr, async (req, res) => {
  const r = await returnOf(req, req.params.id);
  const l = await db.prepare('SELECT * FROM wms_return_lines WHERE id = ? AND return_id = ?').get(A.id(req.params.lineId), r.id);
  if (!l || r.status !== 'done' || l.disposition !== 'quarantine' || l.final) throw new HttpError(400, "Cette ligne n'attend pas de décision.");
  const to = (req.body || {}).disposition === 'scrap' ? 'scrap' : (req.body || {}).disposition === 'restock' ? 'restock' : null;
  if (!to) throw new HttpError(400, 'Choisissez : remettre en stock ou mettre au rebut.');
  const loc = l.location_id || (await W.returnsOf(req.org.id)).id;
  await db.transaction(async () => {
    if ((await W.lockRow('wms_return_lines', l.id)).final) throw new HttpError(400, "Cette ligne n'attend pas de décision.");
    if (to === 'restock') {
      const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(l.item_id);
      const want = (req.body || {}).locationId ? await W.locationFor(req, A.id(req.body.locationId, 'Emplacement introuvable.')) : null;
      if (want && !W.isUsable(want)) throw new HttpError(400, `L'emplacement ${want.code} n'est pas un emplacement de stockage disponible.`);
      for (const d of want ? [{ location: want, quantity: Number(l.quantity) }] : await W.destinationsFor(req.org.id, it, Number(l.quantity))) await W.move(req, l.item_id, loc, d.location.id, d.quantity, { kind: 'return_restock', refKind: 'return', refId: r.id, reason: 'Retour remis en stock' });
    } else await L.adjust(req, l.item_id, -Number(l.quantity), `Mise au rebut (retour ${r.code})`, { locationId: loc, refKind: 'return', refId: r.id, serials: l.serials || undefined, allowExpired: true, preferLot: { lotNo: l.lot_no } });
    await db.prepare('UPDATE wms_return_lines SET final = ? WHERE id = ?').run(to, l.id);
  })();
  res.json({ ok: true });
});
router.post('/returns/:id/credit', mgr, async (req, res) => {
  const r = await returnOf(req, req.params.id);
  if (r.kind !== 'supplier' || r.status !== 'done') throw new HttpError(400, 'Seul un retour fournisseur validé reçoit un avoir.');
  const amount = A.amount((req.body || {}).amount);
  await db.prepare("UPDATE wms_returns SET credit_amount = ?, credit_status = 'received', credited_at = ? WHERE id = ?").run(amount, nowISO(), r.id);
  res.json({ ok: true });
});
/**
 * Retour fournisseur : numéro d'autorisation de retour (RMA) donné par le fournisseur, bon de commande et facture d'achat d'origine.
 * Le fournisseur se déduit du bon de commande ou de la facture ; ils doivent concorder.
 */
async function rmaFields(req, b, { supplierId }) {
  const out = { rmaNo: cleanText(String(b.rmaNo || ''), 40).toUpperCase(), supplierId };
  if (b.purchaseOrderId) {
    const po = await db.prepare('SELECT id, supplier_id FROM pur_orders WHERE id = ? AND org_id = ?').get(A.id(b.purchaseOrderId), req.org.id);
    if (!po) throw new HttpError(404, 'Bon de commande introuvable.');
    if (out.supplierId && Number(out.supplierId) !== Number(po.supplier_id)) throw new HttpError(400, "Ce bon de commande est celui d'un autre fournisseur.");
    out.purchaseOrderId = Number(po.id); out.supplierId = Number(po.supplier_id);
  }
  if (b.purchaseInvoiceId) {
    const pi = await db.prepare('SELECT id, supplier_id, order_id FROM pur_invoices WHERE id = ? AND org_id = ?').get(A.id(b.purchaseInvoiceId), req.org.id);
    if (!pi) throw new HttpError(404, "Facture d'achat introuvable.");
    if (out.supplierId && Number(out.supplierId) !== Number(pi.supplier_id)) throw new HttpError(400, "Cette facture est celle d'un autre fournisseur.");
    out.purchaseInvoiceId = Number(pi.id); out.supplierId = Number(pi.supplier_id);
    if (!out.purchaseOrderId && pi.order_id) out.purchaseOrderId = Number(pi.order_id);
  }
  return out;
}
router.put('/returns/:id/rma', mgr, async (req, res) => {
  const r = await returnOf(req, req.params.id);
  if (r.kind !== 'supplier' || r.status === 'cancelled') throw new HttpError(400, 'Seul un retour fournisseur porte un numéro RMA.');
  const b = req.body || {};
  const f = await rmaFields(req, { rmaNo: b.rmaNo === undefined ? r.rma_no : b.rmaNo, purchaseOrderId: b.purchaseOrderId === undefined ? r.purchase_order_id : b.purchaseOrderId, purchaseInvoiceId: b.purchaseInvoiceId === undefined ? r.purchase_invoice_id : b.purchaseInvoiceId }, { supplierId: r.supplier_id });
  const credit = r.credit_status === 'received' ? 'received' : f.rmaNo ? 'requested' : '';
  await db.prepare('UPDATE wms_returns SET rma_no = ?, purchase_order_id = ?, purchase_invoice_id = ?, supplier_id = ?, credit_status = ? WHERE id = ?').run(f.rmaNo, f.purchaseOrderId || null, f.purchaseInvoiceId || null, f.supplierId || null, credit, r.id);
  res.json({ ok: true });
});

module.exports = router;
Object.assign(module.exports, { syncReservations, issuePick, createPick, documentOf, docNeeds, pickOf });
