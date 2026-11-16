'use strict';
// Stock WMS · lot 3 : réservations. Une commande client (module Clients et ventes) ou une demande interne met du stock de côté :
// disponible à promettre = stock utilisable − réservé. Les sorties « libres » ne peuvent pas entamer le stock réservé ; la livraison d'une commande
// (ou « livrer » une réservation) consomme sa propre réservation. Annulation / suppression de la commande, ou date limite dépassée : libération automatique.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgrOf = (req) => A.can(req, 'manager');
const KINDS = { internal: 'Demande interne', pick: 'Liste de préparation', manual: 'Réservation libre', document: 'Commande ou devis client' };

const itemOf = async (req, id) => {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(id, 'Article invalide.'), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  return it;
};
const resOf = async (req, id) => {
  const r = await db.prepare('SELECT r.*, i.branch_id AS branch_id FROM wms_reservations r JOIN stock_items i ON i.id = r.item_id WHERE r.id = ? AND r.org_id = ?').get(A.id(id, 'Réservation invalide.'), req.org.id);
  if (!r || !A.visible(req, r)) throw new HttpError(404, 'Réservation introuvable.');
  return r;
};
const view = (r) => ({ id: r.id, itemId: r.item_id, item: r.item, unit: r.unit, quantity: r.quantity, fulfilledQty: r.fulfilled_qty, remaining: W.round3(r.quantity - r.fulfilled_qty), status: r.status,
  sourceKind: r.source_kind, sourceLabel: KINDS[r.source_kind], documentId: r.source_kind === 'document' ? r.source_id : null, documentNumber: r.doc_number || null, label: r.label, neededBy: r.needed_by, expiresAt: r.expires_at,
  createdBy: r.by_name || null, createdById: r.created_by, createdAt: r.created_at, closedAt: r.closed_at, closeReason: r.close_reason });
const BASE = 'SELECT r.*, i.name AS item, i.unit, i.branch_id AS branch_id, u.name AS by_name, d.number AS doc_number FROM wms_reservations r JOIN stock_items i ON i.id = r.item_id LEFT JOIN users u ON u.id = r.created_by LEFT JOIN documents d ON d.id = r.source_id AND r.source_kind = \'document\'';

// ---------- Disponible à promettre ----------
router.get('/availability', async (req, res) => {
  const sc = A.scope(req, 'branch_id');
  const items = await db.prepare(`SELECT id, name, unit, sku, barcode, quantity FROM stock_items WHERE org_id = ?${sc.sql} ORDER BY name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  const m = await W.availabilityMap(req.org.id);
  const rows = items.map((i) => ({ itemId: i.id, name: i.name, unit: i.unit, sku: i.sku, barcode: i.barcode, ...m.get(i.id) }));
  res.json({ items: req.query.onlyReserved ? rows.filter((x) => x.reserved > 0) : rows, reservedItems: rows.filter((x) => x.reserved > 0).length, shortItems: rows.filter((x) => x.short > 0).length });
});
router.get('/items/:id/availability', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const m = await W.availabilityMap(req.org.id);
  res.json({ itemId: it.id, name: it.name, unit: it.unit, ...m.get(it.id) });
});

// ---------- Liste ----------
router.get('/reservations', async (req, res) => {
  await W.sweep(req.org.id);
  const sc = A.scope(req, 'i.branch_id');
  const status = req.query.status ? A.oneOf(req.query.status, ['active', 'fulfilled', 'released'], undefined, 'Statut inconnu.') : null;
  const item = req.query.itemId ? A.id(req.query.itemId) : null;
  const rows = await db.prepare(`${BASE} WHERE r.org_id = ?${status ? ' AND r.status = ?' : ''}${item ? ' AND r.item_id = ?' : ''}${sc.sql} ORDER BY (r.status = 'active') DESC, r.id DESC LIMIT 200`).all(req.org.id, ...(status ? [status] : []), ...(item ? [item] : []), ...sc.args);
  res.json({ reservations: rows.map(view), active: rows.filter((r) => r.status === 'active').length });
});
router.get('/documents/:id/reservations', async (req, res) => {
  await W.sweep(req.org.id);
  const sc = A.scope(req, 'i.branch_id');
  const rows = await db.prepare(`${BASE} WHERE r.org_id = ? AND r.source_kind = 'document' AND r.source_id = ?${sc.sql} ORDER BY r.id`).all(req.org.id, A.id(req.params.id), ...sc.args);
  res.json({ reservations: rows.map(view) });
});

/** Crée une réservation (article verrouillé : deux réservations simultanées ne dépassent jamais le disponible). */
async function reserve(req, it0, qty, meta) {
  return await db.transaction(async () => {
    const it = await W.lockItem(req.org.id, it0.id);
    await W.reconcile(req.org.id, it);
    const a = (await W.availabilityMap(req.org.id)).get(it.id);
    if (qty - a.available > W.EPS) throw new HttpError(409, `« ${it.name} » : ${a.available} ${it.unit} disponible(s) à promettre (${a.usable} en stock utilisable, ${a.reserved} déjà réservé(s)).`);
    return Number((await db.prepare('INSERT INTO wms_reservations (org_id, item_id, quantity, source_kind, source_id, label, needed_by, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, it.id, qty, meta.kind, meta.sourceId || null, A.text(meta.label, 150), meta.neededBy || null, meta.expiresAt || null, req.user.id, nowISO())).lastInsertRowid);
  })();
}

router.post('/reservations', async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, ['internal', 'manual'], 'internal', 'Type de réservation inconnu (demande interne ou réservation libre).');
  if (kind === 'manual' && !mgrOf(req)) throw new HttpError(403, 'Une réservation libre est réservée aux responsables (une demande interne est ouverte à tous).');
  const it = await itemOf(req, b.itemId);
  const qty = A.qty(b.quantity);
  if (it.tracking === 'serial' && !Number.isInteger(qty)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : la quantité est un nombre entier.`);
  const label = A.text(b.label, 150, { required: true, msg: 'Indiquez pour qui ou pour quoi (chantier, client, atelier…).' });
  const id = await reserve(req, it, qty, { kind, label, neededBy: A.date(b.neededBy), expiresAt: A.date(b.expiresAt) });
  await A.logActivity(req.org.id, req.user.id, 'stock', `Réservation de ${qty} ${it.unit} de « ${it.name} » : ${label}`);
  res.status(201).json({ id });
});

// ---------- Depuis une commande, un devis ou une facture : une réservation par ligne rattachée à un article ----------
router.post('/reservations/from-document', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const d = await db.prepare('SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.org_id = ?').get(A.id(b.documentId, 'Document invalide.'), req.org.id);
  if (!d || !A.visible(req, d)) throw new HttpError(404, 'Document introuvable.');
  if (!['order', 'quote', 'invoice'].includes(d.kind)) throw new HttpError(400, 'Seule une commande, un devis ou une facture peut réserver du stock.');
  if (['cancelled', 'refused', 'credited', 'paid'].includes(d.status) && d.kind !== 'order') throw new HttpError(400, 'Ce document est terminé ou refusé : il ne réserve plus de stock.');
  if (['cancelled', 'refused'].includes(d.status)) throw new HttpError(400, 'Cette commande est annulée : elle ne réserve plus de stock.');
  const { reserved: out, short, ignoredLines: ignored } = await W.reserveDocument(req, d, { partial: b.partial === true || b.partial === 'true', neededBy: A.date(b.neededBy) });
  await A.logActivity(req.org.id, req.user.id, 'stock', `Stock réservé pour ${d.number} (${out.length} article(s))`);
  res.status(201).json({ reserved: out, short, ignoredLines: ignored });
});

// ---------- Modifier la quantité, livrer, libérer ----------
router.put('/reservations/:id', async (req, res) => {
  const r0 = await resOf(req, req.params.id);
  if (!(mgrOf(req) || (r0.source_kind === 'internal' && r0.created_by === req.user.id))) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  const b = req.body || {};
  await db.transaction(async () => {
    const it = await W.lockItem(req.org.id, r0.item_id);
    const r = await db.prepare('SELECT * FROM wms_reservations WHERE id = ? FOR UPDATE').get(r0.id);
    if (r.status !== 'active') throw new HttpError(409, 'Cette réservation est terminée.');
    let qty = r.quantity;
    if (b.quantity !== undefined) {
      qty = A.qty(b.quantity);
      if (qty < r.fulfilled_qty - W.EPS) throw new HttpError(400, `${r.fulfilled_qty} ${it.unit} déjà livré(s) : la réservation ne peut pas être plus petite.`);
      const a = (await W.availabilityMap(req.org.id)).get(it.id);
      if (qty - r.quantity - a.available > W.EPS) throw new HttpError(409, `« ${it.name} » : ${a.available} ${it.unit} disponible(s) à promettre seulement.`);
    }
    await db.prepare('UPDATE wms_reservations SET quantity = ?, needed_by = ?, expires_at = ?, label = ? WHERE id = ?').run(qty, b.neededBy === undefined ? r.needed_by : A.date(b.neededBy), b.expiresAt === undefined ? r.expires_at : A.date(b.expiresAt), b.label === undefined ? r.label : A.text(b.label, 150) || r.label, r.id);
  })();
  res.json({ ok: true });
});

/** Livre (sort du stock) tout ou partie d'une réservation, d'un emplacement précis ou des emplacements disponibles. */
router.post('/reservations/:id/fulfill', A.need('manager'), async (req, res) => {
  const r0 = await resOf(req, req.params.id);
  const b = req.body || {};
  let out;
  await db.transaction(async () => {
    const r = await db.prepare('SELECT * FROM wms_reservations WHERE id = ? FOR UPDATE').get(r0.id);
    if (r.status !== 'active') throw new HttpError(409, 'Cette réservation est terminée.');
    const left = W.round3(r.quantity - r.fulfilled_qty);
    const q = b.quantity === undefined || b.quantity === '' ? left : A.qty(b.quantity);
    if (q - left > W.EPS) throw new HttpError(400, `Il ne reste que ${left} à livrer sur cette réservation.`);
    const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(r.item_id);
    const serials = it.tracking === 'serial' ? L.parseSerials(b.serials) : undefined;
    out = await L.adjust(req, it, -q, `Livraison de la réservation #${r.id}${r.label ? ` · ${r.label}` : ''}`.slice(0, 150), { reservationId: r.id, refKind: 'reservation', refId: r.id, serials, locationId: b.locationId ? (await W.locationFor(req, b.locationId)).id : undefined });
  })();
  const now = await db.prepare('SELECT * FROM wms_reservations WHERE id = ?').get(r0.id);
  res.json({ quantity: out.quantity, status: now.status, remaining: W.round3(now.quantity - now.fulfilled_qty) });
});

router.post('/reservations/:id/release', async (req, res) => {
  const r = await resOf(req, req.params.id);
  if (!(mgrOf(req) || (r.source_kind === 'internal' && r.created_by === req.user.id))) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  const x = await db.prepare("UPDATE wms_reservations SET status = 'released', closed_at = ?, closed_by = ?, close_reason = ? WHERE id = ? AND status = 'active'").run(nowISO(), req.user.id, A.text((req.body || {}).reason, 150) || 'Libérée', r.id);
  if (!x.changes) throw new HttpError(409, 'Cette réservation est déjà terminée.');
  res.json({ ok: true });
});

module.exports = router;
