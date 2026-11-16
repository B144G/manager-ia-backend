'use strict';
// Stock WMS · lot 2 : transferts entre entrepôts / emplacements. Demande (tout membre) → expédition (responsable ; le stock sort du départ et passe « En transit »)
// → réception (un AUTRE responsable, sauf administrateur ; le stock entre à l'arrivée). Un manquant à la réception est passé en perte, avec son motif, valorisé.
// Pendant le transit le stock reste compté (quantité et valeur) mais n'est ni vendable ni prélevable. Chaque étape est dans le journal du transfert.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgrOf = (req) => A.can(req, 'manager');
const STATUS = { requested: 'Demandé', shipped: 'En transit', received: 'Reçu', cancelled: 'Annulé' };

const whOf = async (req, id) => {
  const w = await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(id, 'Entrepôt invalide.'), req.org.id);
  if (!w || !A.visible(req, w)) throw new HttpError(404, 'Entrepôt introuvable.');
  if (!w.active) throw new HttpError(400, `L'entrepôt « ${w.name} » est désactivé.`);
  return w;
};
const trOf = async (req, id) => {
  const t = await db.prepare('SELECT t.*, f.name AS from_name, f.branch_id AS from_branch, g.name AS to_name, g.branch_id AS to_branch FROM wms_transfers t JOIN wms_warehouses f ON f.id = t.from_warehouse_id JOIN wms_warehouses g ON g.id = t.to_warehouse_id WHERE t.id = ? AND t.org_id = ?').get(A.id(id, 'Transfert invalide.'), req.org.id);
  if (!t || !(A.visible(req, { branch_id: t.from_branch }) || A.visible(req, { branch_id: t.to_branch }))) throw new HttpError(404, 'Transfert introuvable.');
  return t;
};
const event = (req, t, action, note) => db.prepare('INSERT INTO wms_transfer_events (org_id, transfer_id, action, user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, t.id, action, req.user.id, String(note || '').slice(0, 300), nowISO());
const userNames = async (ids) => {
  const u = ids.filter(Boolean); if (!u.length) return new Map();
  const rows = await db.prepare(`SELECT id, name FROM users WHERE id IN (${u.map(() => '?').join(',')})`).all(...u);
  return new Map(rows.map((x) => [x.id, x.name]));
};

async function view(req, t, full) {
  const mgr = mgrOf(req);
  const lines = await db.prepare(`SELECT l.*, i.name, i.unit, i.tracking, fl.code AS from_code, tl.code AS to_code FROM wms_transfer_lines l JOIN stock_items i ON i.id = l.item_id
    LEFT JOIN wms_locations fl ON fl.id = l.from_location_id LEFT JOIN wms_locations tl ON tl.id = l.to_location_id WHERE l.transfer_id = ? ORDER BY l.id`).all(t.id);
  const names = await userNames([t.requested_by, t.shipped_by, t.received_by, t.cancelled_by]);
  const out = { id: t.id, code: t.code, status: t.status, statusLabel: STATUS[t.status], fromWarehouseId: t.from_warehouse_id, from: t.from_name, toWarehouseId: t.to_warehouse_id, to: t.to_name, note: t.note,
    requestedBy: names.get(t.requested_by) || null, requestedById: t.requested_by, requestedAt: t.requested_at, shippedBy: names.get(t.shipped_by) || null, shippedAt: t.shipped_at, receivedBy: names.get(t.received_by) || null, receivedAt: t.received_at,
    cancelledAt: t.cancelled_at, cancelReason: t.cancel_reason, lineCount: lines.length,
    gapQty: lines.reduce((a, l) => a + l.gap_qty, 0), gapValue: mgr ? lines.reduce((a, l) => a + Number(l.gap_value), 0) : undefined };
  if (full) {
    out.lines = lines.map((l) => ({ id: l.id, itemId: l.item_id, name: l.name, unit: l.unit, tracking: l.tracking, quantity: l.quantity, shippedQty: l.shipped_qty, receivedQty: l.received_qty, fromLocationId: l.from_location_id, from: l.from_code, toLocationId: l.to_location_id, to: l.to_code,
      gapQty: l.gap_qty, gapValue: mgr ? Number(l.gap_value) : undefined, gapReason: l.gap_reason }));
    const ev = await db.prepare('SELECT e.action, e.note, e.created_at AS at, u.name FROM wms_transfer_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.transfer_id = ? ORDER BY e.id').all(t.id);
    out.journal = ev.map((e) => ({ action: e.action, note: e.note, at: e.at, by: e.name }));
  }
  return out;
}

router.get('/transfers', async (req, res) => {
  const status = req.query.status ? A.oneOf(req.query.status, Object.keys(STATUS), undefined, 'Statut inconnu.') : null;
  const sc1 = A.scope(req, 'f.branch_id'); const sc2 = A.scope(req, 'g.branch_id');
  const rows = await db.prepare(`SELECT t.*, f.name AS from_name, f.branch_id AS from_branch, g.name AS to_name, g.branch_id AS to_branch FROM wms_transfers t JOIN wms_warehouses f ON f.id = t.from_warehouse_id JOIN wms_warehouses g ON g.id = t.to_warehouse_id
    WHERE t.org_id = ?${status ? ' AND t.status = ?' : ''} AND (1=1${sc1.sql} OR 1=1${sc2.sql}) ORDER BY t.id DESC LIMIT 100`).all(req.org.id, ...(status ? [status] : []), ...sc1.args, ...sc2.args);
  const out = [];
  for (const t of rows) out.push(await view(req, t, false));
  res.json({ transfers: out, inTransit: out.filter((x) => x.status === 'shipped').length });
});
router.get('/transfers/:id', async (req, res) => res.json({ transfer: await view(req, await trOf(req, req.params.id), true) }));

// ---------- Demande ----------
router.post('/transfers', async (req, res) => {
  const b = req.body || {};
  const from = await whOf(req, b.fromWarehouseId); const to = await whOf(req, b.toWarehouseId);
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw new HttpError(400, 'Ajoutez au moins une ligne (100 au plus).');
  const seen = new Set(); const lines = [];
  for (const x of b.lines) {
    const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(x && x.itemId, 'Article invalide.'), req.org.id);
    if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
    if (seen.has(it.id)) throw new HttpError(400, `« ${it.name} » apparaît deux fois : une seule ligne par article.`);
    seen.add(it.id);
    const q = A.qty(x.quantity);
    if (it.tracking === 'serial' && !Number.isInteger(q)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : la quantité est un nombre entier.`);
    let fl = null; let tl = null;
    if (x.fromLocationId) { fl = await W.locationFor(req, x.fromLocationId); if (fl.warehouse_id !== from.id) throw new HttpError(400, `L'emplacement ${fl.code} n'est pas dans l'entrepôt de départ.`); if (!W.isUsable(fl.kind)) throw new HttpError(400, `L'emplacement ${fl.code} (${W.LOCATION_KINDS[fl.kind]}) n'est pas disponible à l'expédition.`); }
    if (x.toLocationId) { tl = await W.locationFor(req, x.toLocationId); if (tl.warehouse_id !== to.id) throw new HttpError(400, `L'emplacement ${tl.code} n'est pas dans l'entrepôt d'arrivée.`); if (!tl.active || tl.kind === 'transit') throw new HttpError(400, `L'emplacement ${tl.code} ne peut pas recevoir.`); }
    if (from.id === to.id && (!fl || !tl)) throw new HttpError(400, "Entre deux emplacements d'un même entrepôt, indiquez l'emplacement de départ et celui d'arrivée.");
    if (fl && tl && fl.id === tl.id) throw new HttpError(400, "L'emplacement de départ et celui d'arrivée sont identiques.");
    lines.push({ it, q, fl, tl });
  }
  const id = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'wms_transfer', 'TR');
    const tid = Number((await db.prepare('INSERT INTO wms_transfers (org_id, code, status, from_warehouse_id, to_warehouse_id, note, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, code, 'requested', from.id, to.id, A.text(b.note, 300), req.user.id, nowISO())).lastInsertRowid);
    for (const l of lines) await db.prepare('INSERT INTO wms_transfer_lines (org_id, transfer_id, item_id, quantity, from_location_id, to_location_id) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, tid, l.it.id, l.q, l.fl ? l.fl.id : null, l.tl ? l.tl.id : null);
    await event(req, { id: tid }, 'requested', A.text(b.note, 300));
    return tid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Transfert demandé : ${from.name} → ${to.name}`);
  res.status(201).json({ id });
});

// ---------- Expédition : le stock sort du départ et passe « En transit » ----------
router.post('/transfers/:id/ship', A.need('manager'), async (req, res) => {
  const t0 = await trOf(req, req.params.id);
  const given = new Map(((req.body || {}).lines || []).map((x) => [Number(x.lineId), x]));
  await db.transaction(async () => {
    const t = await db.prepare('SELECT * FROM wms_transfers WHERE id = ? FOR UPDATE').get(t0.id);
    if (t.status !== 'requested') throw new HttpError(409, 'Ce transfert a déjà été expédié ou annulé.');
    const transit = await W.ensureTransit(req.org.id);
    const lines = (await db.prepare('SELECT * FROM wms_transfer_lines WHERE transfer_id = ? ORDER BY item_id').all(t.id));
    let any = 0;
    for (const l of lines) {
      const g = given.get(l.id);
      const q = g && g.quantity !== undefined && g.quantity !== '' ? A.qty(g.quantity, { allowZero: true }) : l.quantity;
      if (q - l.quantity > W.EPS) throw new HttpError(400, `Impossible d'expédier plus que demandé (${l.quantity}).`);
      if (q <= 0) { await db.prepare('UPDATE wms_transfer_lines SET shipped_qty = 0 WHERE id = ?').run(l.id); continue; }
      const it = await W.lockItem(req.org.id, l.item_id);
      await W.reconcile(req.org.id, it);
      if (it.tracking === 'serial' && !Number.isInteger(q)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : la quantité est un nombre entier.`);
      const parts = l.from_location_id ? [{ locationId: l.from_location_id, quantity: q }] : await W.planFromWarehouse(it, t.from_warehouse_id, q);
      await W.reservedGuard(it, q);
      await W.whGuard(it, t.from_warehouse_id, q); // pas de stock réservé pour l'entrepôt de départ
      for (const p of parts) await W.relocate(req, it, p.locationId, transit.id, p.quantity, { kind: 'transfer_out', reason: `Expédition ${t.code}`, refKind: 'transfer', refId: t.id, allowTransit: true });
      await db.prepare('UPDATE wms_transfer_lines SET shipped_qty = ?, src = ?, unit_value = ? WHERE id = ?').run(q, JSON.stringify(parts), L.unitValue(it), l.id);
      any++;
    }
    if (!any) throw new HttpError(400, 'Aucune quantité à expédier.');
    await db.prepare("UPDATE wms_transfers SET status = 'shipped', shipped_by = ?, shipped_at = ? WHERE id = ?").run(req.user.id, nowISO(), t.id);
    await event(req, t, 'shipped', A.text((req.body || {}).note, 300));
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Transfert ${t0.code} expédié (en transit)`);
  res.json({ ok: true });
});

// ---------- Réception : le stock entre à l'arrivée ; un manquant est passé en perte avec son motif ----------
router.post('/transfers/:id/receive', A.need('manager'), async (req, res) => {
  const t0 = await trOf(req, req.params.id);
  const given = new Map(((req.body || {}).lines || []).map((x) => [Number(x.lineId), x]));
  let gapValue = 0; let gapQty = 0;
  await db.transaction(async () => {
    const t = await db.prepare('SELECT * FROM wms_transfers WHERE id = ? FOR UPDATE').get(t0.id);
    if (t.status !== 'shipped') throw new HttpError(409, t.status === 'received' ? 'Ce transfert a déjà été reçu.' : "Ce transfert n'est pas en transit.");
    if (t.shipped_by === req.user.id && !A.can(req, 'admin')) throw new HttpError(403, "Une autre personne doit confirmer la réception (vous avez expédié ce transfert).");
    const transit = await W.ensureTransit(req.org.id);
    const lines = (await db.prepare('SELECT * FROM wms_transfer_lines WHERE transfer_id = ? AND shipped_qty > 0 ORDER BY item_id').all(t.id));
    for (const l of lines) {
      const g = given.get(l.id) || {};
      const got = g.receivedQty !== undefined && g.receivedQty !== '' ? A.qty(g.receivedQty, { allowZero: true }) : l.shipped_qty;
      if (got - l.shipped_qty > W.EPS) throw new HttpError(400, `Reçu plus que l'expédition (${l.shipped_qty}) : contrôlez le bon d'expédition.`);
      const gap = W.round3(l.shipped_qty - got);
      const it = await W.lockItem(req.org.id, l.item_id);
      await W.reconcile(req.org.id, it);
      let dest = null;
      if (got > 0) {
        dest = g.toLocationId ? await W.locationFor(req, g.toLocationId) : l.to_location_id ? await W.locationOf(req.org.id, l.to_location_id) : await W.warehouseDefault(req.org.id, t.to_warehouse_id);
        if (dest.warehouse_id !== t.to_warehouse_id) throw new HttpError(400, `L'emplacement ${dest.code} n'est pas dans l'entrepôt d'arrivée.`);
        await W.relocate(req, it, transit.id, dest.id, got, { kind: 'transfer_in', reason: `Réception ${t.code}`, refKind: 'transfer', refId: t.id, allowTransit: true });
      }
      let value = 0; const reason = A.text(g.reason, 200);
      if (gap > 0) {
        if (!reason) throw new HttpError(400, `Écart sur « ${it.name} » (${gap} ${it.unit} manquant) : indiquez le motif (casse, vol, erreur de comptage…).`);
        const serials = it.tracking === 'serial' ? L.parseSerials(g.serials) : undefined;
        value = Math.round(gap * L.unitValue(it));
        await L.adjust(req, it, -gap, `Écart de transfert ${t.code} : ${reason}`.slice(0, 150), { locationId: transit.id, refKind: 'transfer', refId: t.id, serials, allowExpired: true });
        gapValue += value; gapQty += gap;
      }
      await db.prepare('UPDATE wms_transfer_lines SET received_qty = ?, to_location_id = ?, gap_qty = ?, gap_value = ?, gap_reason = ? WHERE id = ?').run(got, dest ? dest.id : l.to_location_id, gap, value, reason, l.id);
    }
    await db.prepare("UPDATE wms_transfers SET status = 'received', received_by = ?, received_at = ? WHERE id = ?").run(req.user.id, nowISO(), t.id);
    await event(req, t, 'received', gapQty > 0 ? `Écart : ${gapQty} unité(s), valeur ${gapValue}` : 'Reçu sans écart');
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Transfert ${t0.code} reçu${gapQty > 0 ? ` avec écart (${gapValue} ${req.org.currency})` : ''}`);
  res.json({ ok: true, gapQty, gapValue: mgrOf(req) ? gapValue : undefined });
});

// ---------- Annulation : une demande (par son auteur ou un responsable) ou un transfert en transit (responsable : le stock retourne au départ) ----------
router.post('/transfers/:id/cancel', async (req, res) => {
  const t0 = await trOf(req, req.params.id);
  const reason = A.text((req.body || {}).reason, 200);
  await db.transaction(async () => {
    const t = await db.prepare('SELECT * FROM wms_transfers WHERE id = ? FOR UPDATE').get(t0.id);
    if (t.status === 'received' || t.status === 'cancelled') throw new HttpError(409, 'Ce transfert est terminé.');
    if (t.status === 'requested' && t.requested_by !== req.user.id && !mgrOf(req)) throw new HttpError(403, "Seule la personne qui a fait la demande, ou un responsable, peut l'annuler.");
    if (t.status === 'shipped') {
      if (!mgrOf(req)) throw new HttpError(403, "Votre rôle ne permet pas d'annuler un transfert en transit.");
      if (!reason) throw new HttpError(400, 'Indiquez le motif : la marchandise en transit retourne au départ.');
      const transit = await W.ensureTransit(req.org.id);
      for (const l of await db.prepare('SELECT * FROM wms_transfer_lines WHERE transfer_id = ? AND shipped_qty > 0 ORDER BY item_id').all(t.id)) {
        const it = await W.lockItem(req.org.id, l.item_id);
        await W.reconcile(req.org.id, it);
        for (const p of JSON.parse(l.src || '[]')) await W.relocate(req, it, transit.id, p.locationId, p.quantity, { kind: 'transfer_back', reason: `Annulation ${t.code}`, refKind: 'transfer', refId: t.id, allowTransit: true });
      }
    }
    await db.prepare("UPDATE wms_transfers SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(req.user.id, nowISO(), reason, t.id);
    await event(req, t, 'cancelled', reason);
  })();
  res.json({ ok: true });
});

module.exports = router;
