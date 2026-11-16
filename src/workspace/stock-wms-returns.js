'use strict';
// Stock WMS · lot 4 : retours client, retours fournisseur et mises au rebut. Chaque retour est un document numéroté (RET-AAAA-001) lié à ses mouvements de stock.
//  - Retour client : remise en stock (emplacement au choix, valeur au coût moyen du jour : le CUMP ne bouge pas), mise en « Retours à contrôler » en attendant une décision,
//    ou rebut (la marchandise n'est jamais rentrée : aucun mouvement, la perte est tracée). Peut citer une commande / facture : on ne rend pas plus que vendu.
//  - Retour fournisseur : le stock sort (valorisé), avec l'avoir attendu puis l'avoir reçu.
//  - Mise au rebut : sortie de stock avec motif obligatoire (casse, péremption, vol…), valorisée.
// Brouillon : tout membre ; validation et décisions : responsable. Les écritures de stock passent par stock-lib.adjust (lots, séries, emplacements, réservations).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgrOf = (req) => A.can(req, 'manager');
const KIND = { customer: 'Retour client', supplier: 'Retour fournisseur', scrap: 'Mise au rebut' };
const REASONS = {
  customer: { defective: 'Défectueux', wrong: 'Erreur de commande', damaged: 'Abîmé au transport', unwanted: 'Ne convient pas', expired: 'Périmé', other: 'Autre' },
  supplier: { defective: 'Défectueux', wrong: 'Erreur de livraison', damaged: 'Abîmé à la livraison', excess: 'Surplus', expired: 'Périmé', other: 'Autre' },
  scrap: { damaged: 'Casse', expired: 'Péremption', lost: 'Perte ou vol', defective: 'Défaut', other: 'Autre' },
};
const STATUS = { draft: 'Brouillon', done: 'Validé', cancelled: 'Annulé' };

const retOf = async (req, id) => {
  const r = await db.prepare('SELECT * FROM wms_returns WHERE id = ? AND org_id = ?').get(A.id(id, 'Retour invalide.'), req.org.id);
  if (!r) throw new HttpError(404, 'Retour introuvable.');
  return r;
};
const itemOf = async (req, id) => {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(id, 'Article invalide.'), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  return it;
};

async function view(req, r, full) {
  const mgr = mgrOf(req);
  const lines = await db.prepare('SELECT l.*, i.name, i.unit, i.tracking, loc.code AS loc_code FROM wms_return_lines l JOIN stock_items i ON i.id = l.item_id LEFT JOIN wms_locations loc ON loc.id = l.location_id WHERE l.return_id = ? ORDER BY l.id').all(r.id);
  const cust = r.customer_id ? await db.prepare('SELECT name FROM customers WHERE id = ?').get(r.customer_id) : null;
  const sup = r.supplier_id ? await db.prepare('SELECT name FROM suppliers WHERE id = ?').get(r.supplier_id) : null;
  const doc = r.doc_id ? await db.prepare('SELECT number FROM documents WHERE id = ?').get(r.doc_id) : null;
  const by = r.created_by ? await db.prepare('SELECT name FROM users WHERE id = ?').get(r.created_by) : null;
  const out = { id: r.id, code: r.code, kind: r.kind, kindLabel: KIND[r.kind], status: r.status, statusLabel: STATUS[r.status], customerId: r.customer_id, customer: cust ? cust.name : null, supplierId: r.supplier_id, supplier: sup ? sup.name : null,
    documentId: r.doc_id, documentNumber: doc ? doc.number : null, orderId: r.order_id, reason: r.reason, note: r.note, createdBy: by ? by.name : null, createdAt: r.created_at, validatedAt: r.validated_at, lineCount: lines.length,
    pending: lines.filter((l) => r.status === 'done' && l.disposition === 'quarantine' && !l.final).length,
    value: mgr ? lines.reduce((a, l) => a + Number(l.value), 0) : undefined, creditAmount: mgr ? Number(r.credit_amount) : undefined, creditedAt: r.credited_at };
  if (full) out.lines = lines.map((l) => ({ id: l.id, itemId: l.item_id, name: l.name, unit: l.unit, tracking: l.tracking, quantity: l.quantity, reasonCode: l.reason_code, reasonLabel: (REASONS[r.kind] || {})[l.reason_code], disposition: l.disposition, final: l.final, locationId: l.location_id, location: l.loc_code, lotNo: l.lot_no, expiry: l.expiry, serials: JSON.parse(l.serials || '[]'), unitValue: mgr ? l.unit_value : undefined, value: mgr ? Number(l.value) : undefined }));
  return out;
}

router.get('/returns/reasons', (req, res) => res.json({ reasons: REASONS, kinds: KIND }));

router.get('/returns', async (req, res) => {
  const kind = req.query.kind ? A.oneOf(req.query.kind, Object.keys(KIND), undefined, 'Type de retour inconnu.') : null;
  const status = req.query.status ? A.oneOf(req.query.status, Object.keys(STATUS), undefined, 'Statut inconnu.') : null;
  const item = req.query.itemId ? A.id(req.query.itemId) : null;
  const rows = await db.prepare(`SELECT r.* FROM wms_returns r WHERE r.org_id = ?${kind ? ' AND r.kind = ?' : ''}${status ? ' AND r.status = ?' : ''}${item ? ' AND EXISTS (SELECT 1 FROM wms_return_lines l WHERE l.return_id = r.id AND l.item_id = ?)' : ''} ORDER BY r.id DESC LIMIT 100`).all(req.org.id, ...(kind ? [kind] : []), ...(status ? [status] : []), ...(item ? [item] : []));
  const out = []; for (const r of rows) out.push(await view(req, r, false));
  res.json({ returns: out, toDecide: out.reduce((a, r) => a + r.pending, 0) });
});
router.get('/returns/:id', async (req, res) => res.json({ return: await view(req, await retOf(req, req.params.id), true) }));

// ---------- Création (brouillon, ou validation immédiate par un responsable) ----------
router.post('/returns', async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, Object.keys(KIND), undefined, 'Choisissez retour client, retour fournisseur ou mise au rebut.');
  const validate = b.validate === true || b.validate === 'true';
  if (validate && !mgrOf(req)) throw new HttpError(403, 'Seul un responsable valide un retour : enregistrez-le comme brouillon.');
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 60) throw new HttpError(400, 'Ajoutez au moins une ligne (60 au plus).');
  let customerId = null; let supplierId = null; let docId = null; let orderId = null; let doc = null;
  if (kind === 'customer') {
    if (b.documentId) {
      doc = await db.prepare("SELECT * FROM documents WHERE id = ? AND org_id = ? AND kind IN ('order','invoice')").get(A.id(b.documentId, 'Document invalide.'), req.org.id);
      if (!doc || !A.visible(req, doc)) throw new HttpError(404, 'Commande ou facture introuvable.');
      docId = doc.id; customerId = doc.customer_id;
    } else if (b.customerId) {
      const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId, 'Client invalide.'), req.org.id);
      if (!c) throw new HttpError(404, 'Client introuvable.');
      customerId = c.id;
    }
  } else if (kind === 'supplier') {
    const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(b.supplierId, 'Choisissez le fournisseur.'), req.org.id);
    if (!s) throw new HttpError(404, 'Fournisseur introuvable.');
    supplierId = s.id;
    if (b.orderId) {
      const o = await db.prepare('SELECT id FROM purchase_orders WHERE id = ? AND org_id = ?').get(A.id(b.orderId, 'Commande invalide.'), req.org.id);
      if (!o) throw new HttpError(404, "Commande d'achat introuvable.");
      orderId = o.id;
    }
  }
  const seen = new Set(); const lines = [];
  for (const x of b.lines) {
    const it = await itemOf(req, x && x.itemId);
    const q = A.qty(x.quantity);
    const key = `${it.id}:${x.lotNo || ''}`;
    if (seen.has(key)) throw new HttpError(400, `« ${it.name} » apparaît deux fois : une seule ligne par article.`);
    seen.add(key);
    if (it.tracking === 'serial' && !Number.isInteger(q)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : la quantité est un nombre entier.`);
    const reasonCode = A.oneOf(x.reasonCode, Object.keys(REASONS[kind]), 'other', 'Motif inconnu.');
    const disposition = kind === 'customer' ? A.oneOf(x.disposition, ['restock', 'quarantine', 'scrap'], undefined, 'Choisissez : remettre en stock, à contrôler ou rebut.') : kind === 'supplier' ? 'to_supplier' : 'scrap';
    if (kind === 'scrap' && reasonCode === 'other' && !A.text(b.reason, 200) && !A.text(x.note, 200)) throw new HttpError(400, 'Précisez le motif de la mise au rebut.');
    const serials = it.tracking === 'serial' ? L.parseSerials(x.serials) : [];
    if (it.tracking === 'serial' && serials.length !== q) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : indiquez exactement ${q} numéro(s).`);
    let loc = null;
    if (x.locationId) loc = await W.locationFor(req, x.locationId);
    if (loc && kind === 'customer' && disposition === 'restock' && !W.isUsable(loc.kind)) throw new HttpError(400, `L'emplacement ${loc.code} n'est pas un emplacement de stockage disponible.`);
    if (doc) {
      const sold = JSON.parse(doc.lines).filter((l) => Number(l.itemId) === it.id).reduce((a, l) => a + Number(l.quantity), 0);
      if (!sold) throw new HttpError(400, `« ${it.name} » ne figure pas sur ${doc.number}.`);
      const back = Number((await db.prepare("SELECT COALESCE(SUM(l.quantity), 0) q FROM wms_return_lines l JOIN wms_returns r ON r.id = l.return_id WHERE r.org_id = ? AND r.doc_id = ? AND r.status <> 'cancelled' AND l.item_id = ?").get(req.org.id, doc.id, it.id)).q);
      if (q + back - sold > W.EPS) throw new HttpError(400, `« ${it.name} » : ${sold} vendu(s) sur ${doc.number}, ${back} déjà rendu(s) : on ne peut rendre que ${W.round3(Math.max(sold - back, 0))}.`);
    }
    if (it.tracking === 'lot' && kind === 'customer' && disposition !== 'scrap' && !A.text(x.lotNo, 40)) throw new HttpError(400, `« ${it.name} » est suivi par lot : indiquez le numéro de lot rendu.`);
    lines.push({ it, q, reasonCode, disposition, loc, lotNo: A.text(x.lotNo, 40), expiry: A.date(x.expiry), serials });
  }
  const id = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'wms_return', 'RET');
    const rid = Number((await db.prepare('INSERT INTO wms_returns (org_id, code, kind, status, customer_id, supplier_id, doc_id, order_id, reason, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, code, kind, 'draft', customerId, supplierId, docId, orderId, A.text(b.reason, 200), A.text(b.note, 300), req.user.id, nowISO())).lastInsertRowid);
    for (const l of lines) await db.prepare('INSERT INTO wms_return_lines (org_id, return_id, item_id, quantity, reason_code, disposition, location_id, lot_no, expiry, serials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, rid, l.it.id, l.q, l.reasonCode, l.disposition, l.loc ? l.loc.id : null, l.lotNo, l.expiry, JSON.stringify(l.serials));
    if (validate) await post(req, rid);
    return rid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `${KIND[kind]} enregistré${validate ? ' et validé' : ' (brouillon)'}`);
  res.status(201).json({ id });
});

/** Écrit les mouvements de stock d'un retour (dans la transaction de l'appelant). */
async function post(req, rid) {
  const r = await db.prepare('SELECT * FROM wms_returns WHERE id = ? FOR UPDATE').get(rid);
  if (r.status !== 'draft') throw new HttpError(409, r.status === 'done' ? 'Ce retour est déjà validé.' : 'Ce retour est annulé.');
  const lines = await db.prepare('SELECT * FROM wms_return_lines WHERE return_id = ? ORDER BY item_id, id').all(r.id);
  const now = nowISO();
  for (const l of lines) {
    const it = await W.lockItem(req.org.id, l.item_id);
    const uv = L.unitValue(it);
    const reason = `${KIND[r.kind]} ${r.code}`;
    const serials = JSON.parse(l.serials || '[]');
    const opts = { refKind: 'return', refId: r.id, serials: serials.length ? serials : undefined, locationId: l.location_id || undefined };
    let final = l.disposition; let locId = l.location_id;
    if (r.kind === 'customer') {
      if (l.disposition === 'restock') {
        await L.adjust(req, it, l.quantity, reason, { ...opts, unitCost: uv > 0 ? uv : undefined, lotNo: l.lot_no || undefined, expiry: l.expiry || undefined, strict: it.tracking === 'lot' });
      } else if (l.disposition === 'quarantine') {
        const hold = l.location_id ? { id: l.location_id } : await W.ensureReturns(req.org.id);
        locId = hold.id;
        await L.adjust(req, it, l.quantity, reason, { ...opts, locationId: hold.id, unitCost: uv > 0 ? uv : undefined, lotNo: l.lot_no || undefined, expiry: l.expiry || undefined, strict: it.tracking === 'lot' });
        final = '';
      } // rebut : la marchandise n'est jamais rentrée en stock ; seul le document garde la trace (valeur de la perte)
    } else {
      await L.adjust(req, it, -l.quantity, `${reason}${r.reason ? ' : ' + r.reason : ''}`.slice(0, 150), { ...opts, allowExpired: true });
    }
    await db.prepare('UPDATE wms_return_lines SET unit_value = ?, value = ?, final = ?, location_id = ?, resolved_at = ? WHERE id = ?').run(uv, Math.round(l.quantity * uv), final, locId, final ? now : null, l.id);
  }
  await db.prepare("UPDATE wms_returns SET status = 'done', validated_by = ?, validated_at = ? WHERE id = ?").run(req.user.id, now, r.id);
}

router.post('/returns/:id/validate', A.need('manager'), async (req, res) => {
  const r = await retOf(req, req.params.id);
  await db.transaction(async () => { await post(req, r.id); })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `${KIND[r.kind]} ${r.code} validé`);
  res.json({ ok: true });
});

router.post('/returns/:id/cancel', async (req, res) => {
  const r = await retOf(req, req.params.id);
  if (r.status !== 'draft') throw new HttpError(409, 'Seul un brouillon peut être annulé (un retour validé a déjà bougé le stock).');
  if (r.created_by !== req.user.id && !mgrOf(req)) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  await db.prepare("UPDATE wms_returns SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(nowISO(), r.id);
  res.json({ ok: true });
});

// ---------- Décision sur une marchandise « à contrôler » : remise en stock ou rebut ----------
router.post('/returns/:id/lines/:lineId/dispose', A.need('manager'), async (req, res) => {
  const r = await retOf(req, req.params.id);
  const b = req.body || {};
  const disposition = A.oneOf(b.disposition, ['restock', 'scrap'], undefined, 'Choisissez : remettre en stock ou mettre au rebut.');
  await db.transaction(async () => {
    const l = await db.prepare('SELECT * FROM wms_return_lines WHERE id = ? AND return_id = ? FOR UPDATE').get(A.id(req.params.lineId), r.id);
    if (!l) throw new HttpError(404, 'Ligne introuvable.');
    if (r.status !== 'done' || l.disposition !== 'quarantine' || l.final) throw new HttpError(409, "Cette ligne n'attend pas de décision.");
    const it = await W.lockItem(req.org.id, l.item_id);
    const hold = l.location_id;
    if (disposition === 'restock') {
      const to = b.locationId ? await W.locationFor(req, b.locationId) : null;
      if (to && !W.isUsable(to.kind)) throw new HttpError(400, `L'emplacement ${to.code} n'est pas un emplacement de stockage disponible.`);
      const destId = to ? to.id : (await W.putawayParts(req.org.id, it, l.quantity))[0].locationId;
      await W.relocate(req, it, hold, destId, l.quantity, { kind: 'return_restock', reason: `Retour ${r.code} contrôlé : remis en stock`, refKind: 'return', refId: r.id });
    } else {
      await L.adjust(req, it, -l.quantity, `Retour ${r.code} contrôlé : mis au rebut${A.text(b.reason, 100) ? ' (' + A.text(b.reason, 100) + ')' : ''}`.slice(0, 150), { locationId: hold, refKind: 'return', refId: r.id, serials: JSON.parse(l.serials || '[]').length ? JSON.parse(l.serials) : undefined, allowExpired: true });
    }
    await db.prepare('UPDATE wms_return_lines SET final = ?, resolved_at = ? WHERE id = ?').run(disposition, nowISO(), l.id);
  })();
  res.json({ ok: true });
});

// ---------- Avoir fournisseur ----------
router.post('/returns/:id/credit', A.need('manager'), async (req, res) => {
  const r = await retOf(req, req.params.id);
  if (r.kind !== 'supplier' || r.status !== 'done') throw new HttpError(400, 'Seul un retour fournisseur validé reçoit un avoir.');
  await db.prepare('UPDATE wms_returns SET credit_amount = ?, credited_at = ? WHERE id = ?').run(A.amount((req.body || {}).amount), nowISO(), r.id);
  res.json({ ok: true });
});

module.exports = router;
