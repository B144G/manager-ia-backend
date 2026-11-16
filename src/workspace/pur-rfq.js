'use strict';
// Achats · appels d'offres (demandes de devis) : consulter plusieurs fournisseurs, saisir les devis reçus (prix par ligne, délai, conditions), tableau comparatif,
// attribution (motif obligatoire si ce n'est pas l'offre la moins chère) et génération du bon de commande en brouillon. L'économie obtenue
// est mesurée par rapport au budget de référence (prix de référence saisis) ou, à défaut, à la moyenne des devis complets.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const P = require('./pur-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const STATUSES = ['open', 'awarded', 'cancelled'];
const LABEL = { open: 'En cours', awarded: 'Attribué', cancelled: 'Annulé' };

async function rfqOf(req, id) {
  const r = await db.prepare('SELECT * FROM pur_rfqs WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!r) throw new HttpError(404, "Appel d'offres introuvable.");
  return r;
}
const ranked = (a, b) => a.total - b.total || (a.deliveryDays === null ? 1e9 : a.deliveryDays) - (b.deliveryDays === null ? 1e9 : b.deliveryDays);

/** Tableau comparatif : une colonne par fournisseur, le meilleur prix de chaque ligne, le classement. */
async function comparison(r) {
  const t = P.today();
  const lines = (await db.prepare('SELECT * FROM pur_rfq_lines WHERE rfq_id = ? ORDER BY id').all(r.id)).map((l) => ({ id: Number(l.id), itemId: l.item_id === null ? null : Number(l.item_id), description: l.description, unit: l.unit, quantity: Number(l.quantity), refPrice: Number(l.ref_price) }));
  const sups = [];
  for (const s of await db.prepare('SELECT q.*, s.name FROM pur_rfq_suppliers q JOIN suppliers s ON s.id = q.supplier_id WHERE q.rfq_id = ? ORDER BY q.id').all(r.id)) {
    const prices = Object.fromEntries((await db.prepare('SELECT rfq_line_id, unit_price FROM pur_quote_lines WHERE rfq_supplier_id = ?').all(s.id)).map((x) => [Number(x.rfq_line_id), Number(x.unit_price)]));
    const complete = lines.length > 0 && lines.every((l) => prices[l.id] > 0);
    const total = lines.reduce((sum, l) => sum + (prices[l.id] ? P.lineAmount(l.quantity, prices[l.id]) : 0), 0);
    sups.push({ supplierId: Number(s.supplier_id), name: s.name, status: s.status, deliveryDays: s.delivery_days === null ? null : Number(s.delivery_days), paymentDays: s.payment_days === null ? null : Number(s.payment_days), terms: s.terms, validUntil: s.valid_until, note: s.note, quotedAt: s.quoted_at,
      prices, complete, total: complete ? total : null, partialTotal: total, expired: Boolean(s.valid_until) && s.valid_until < t });
  }
  const eligible = sups.filter((s) => s.status === 'quoted' && s.complete && !s.expired).sort((a, b) => ranked({ total: a.total, deliveryDays: a.deliveryDays }, { total: b.total, deliveryDays: b.deliveryDays }));
  const lowest = eligible.length ? eligible[0] : null;
  const fastest = eligible.length ? [...eligible].sort((a, b) => (a.deliveryDays === null ? 1e9 : a.deliveryDays) - (b.deliveryDays === null ? 1e9 : b.deliveryDays))[0] : null;
  for (const l of lines) {
    const cands = sups.filter((s) => s.prices[l.id] > 0);
    l.bestPrice = cands.length ? Math.min(...cands.map((s) => s.prices[l.id])) : null;
    l.bestSuppliers = cands.filter((s) => s.prices[l.id] === l.bestPrice).map((s) => s.supplierId);
  }
  const refTotal = lines.every((l) => l.refPrice > 0) ? lines.reduce((s, l) => s + P.lineAmount(l.quantity, l.refPrice), 0) : 0;
  const completeAll = sups.filter((s) => s.status === 'quoted' && s.complete);
  const average = completeAll.length >= 2 ? Math.round(completeAll.reduce((s, x) => s + x.total, 0) / completeAll.length) : 0;
  eligible.forEach((s, i) => { s.rank = i + 1; });
  return { lines, suppliers: sups, recommended: lowest ? lowest.supplierId : null, fastest: fastest ? fastest.supplierId : null, referenceTotal: refTotal, averageTotal: average, baseline: refTotal || average };
}

async function view(req, r, full) {
  const out = {
    id: Number(r.id), number: r.number, title: r.title, requestId: r.request_id === null ? null : Number(r.request_id), status: r.status, statusLabel: LABEL[r.status], deadline: r.deadline, notes: r.notes, category: r.category,
    awardedSupplierId: r.awarded_supplier_id === null ? null : Number(r.awarded_supplier_id), awardReason: r.award_reason, orderId: r.order_id === null ? null : Number(r.order_id), baseline: Number(r.baseline), awardedTotal: Number(r.awarded_total), savings: Number(r.savings),
    createdAt: r.created_at, closedAt: r.closed_at, late: r.status === 'open' && Boolean(r.deadline) && r.deadline < P.today(),
  };
  const sc = await db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN status = \'quoted\' THEN 1 ELSE 0 END) AS q FROM pur_rfq_suppliers WHERE rfq_id = ?').get(r.id);
  out.suppliersCount = Number(sc.n); out.quotesCount = Number(sc.q || 0);
  if (full) out.comparison = await comparison(r);
  return out;
}

router.get('/rfqs', async (req, res) => {
  const w = ['org_id = ?']; const a = [req.org.id];
  if (req.query.status) { w.push('status = ?'); a.push(A.oneOf(req.query.status, STATUSES, undefined, 'Statut inconnu.')); }
  const rows = await db.prepare(`SELECT * FROM pur_rfqs WHERE ${w.join(' AND ')} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC LIMIT 200`).all(...a);
  const rfqs = []; for (const r of rows) rfqs.push(await view(req, r, false));
  res.json({ rfqs, savings: rfqs.reduce((s, x) => s + x.savings, 0) });
});

router.post('/rfqs', async (req, res) => {
  const b = req.body || {};
  const title = A.text(b.title, 150, { required: true, msg: "Donnez un titre à l'appel d'offres." });
  const deadline = A.date(b.deadline);
  if (deadline && deadline < P.today()) throw new HttpError(400, 'La date limite est déjà passée.');
  const ids = Array.isArray(b.supplierIds) ? [...new Set(b.supplierIds.map((x) => A.id(x, 'Fournisseur invalide.')))] : [];
  if (!ids.length) throw new HttpError(400, 'Choisissez au moins un fournisseur à consulter.');
  if (ids.length > 20) throw new HttpError(400, '20 fournisseurs au plus par appel d\'offres.');
  const sups = []; for (const id of ids) sups.push(await P.supplierOf(req, id));
  let lines; let category = P.catOf(b.category); let requestId = null;
  if (b.requestId !== undefined && b.requestId !== null && b.requestId !== '') {
    const rq = await db.prepare('SELECT * FROM pur_requests WHERE id = ? AND org_id = ?').get(A.id(b.requestId, 'Demande invalide.'), req.org.id);
    if (!rq) throw new HttpError(400, "Demande d'achat introuvable.");
    if (rq.status !== 'approved') throw new HttpError(400, 'Seule une demande approuvée peut donner lieu à un appel d\'offres.');
    requestId = Number(rq.id); category = category || rq.category;
    if (b.lines === undefined) lines = (await db.prepare('SELECT * FROM pur_request_lines WHERE request_id = ? ORDER BY id').all(rq.id)).map((l) => ({ itemId: l.item_id === null ? null : Number(l.item_id), description: l.description, unit: l.unit, quantity: Number(l.quantity), price: Number(l.est_price) }));
  }
  if (!lines) lines = await P.cleanLines(req, b.lines, 'ref');
  const id = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'rfq', 'AO', P.today());
    const rid = Number((await db.prepare('INSERT INTO pur_rfqs (org_id, number, title, request_id, status, deadline, notes, category, created_by, created_at) VALUES (?, ?, ?, ?, \'open\', ?, ?, ?, ?, ?)')
      .run(req.org.id, number, title, requestId, deadline, A.text(b.notes, 1000), category, req.user.id, nowISO())).lastInsertRowid);
    for (const l of lines) await db.prepare('INSERT INTO pur_rfq_lines (org_id, rfq_id, item_id, description, unit, quantity, ref_price) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, rid, l.itemId, l.description, l.unit, l.quantity, l.price);
    for (const s of sups) await db.prepare('INSERT INTO pur_rfq_suppliers (org_id, rfq_id, supplier_id) VALUES (?, ?, ?)').run(req.org.id, rid, s.id);
    return rid;
  })();
  const r = await db.prepare('SELECT number FROM pur_rfqs WHERE id = ?').get(id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Appel d'offres ${r.number} lancé (${sups.length} fournisseur(s))`);
  res.status(201).json({ id, number: r.number });
});

router.get('/rfqs/:id', async (req, res) => res.json({ rfq: await view(req, await rfqOf(req, req.params.id), true) }));

router.post('/rfqs/:id/suppliers', async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
  const sup = await P.supplierOf(req, (req.body || {}).supplierId);
  if (await db.prepare('SELECT 1 FROM pur_rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?').get(r.id, sup.id)) throw new HttpError(409, 'Ce fournisseur est déjà consulté.');
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM pur_rfq_suppliers WHERE rfq_id = ?').get(r.id)).c);
  if (n >= 20) throw new HttpError(400, '20 fournisseurs au plus par appel d\'offres.');
  await db.prepare('INSERT INTO pur_rfq_suppliers (org_id, rfq_id, supplier_id) VALUES (?, ?, ?)').run(req.org.id, r.id, sup.id);
  res.status(201).json({ ok: true });
});
router.delete('/rfqs/:id/suppliers/:supplierId', async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
  const q = await db.prepare('SELECT * FROM pur_rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?').get(r.id, A.id(req.params.supplierId));
  if (!q) throw new HttpError(404, "Ce fournisseur n'est pas consulté.");
  if (q.status === 'quoted') throw new HttpError(400, 'Ce fournisseur a déjà remis un devis : marquez-le « décliné » plutôt que de le retirer.');
  await db.prepare('DELETE FROM pur_rfq_suppliers WHERE id = ?').run(q.id);
  res.json({ ok: true });
});

// Saisie du devis reçu d'un fournisseur (remplace le précédent).
router.put('/rfqs/:id/quotes/:supplierId', async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
  const q = await db.prepare('SELECT * FROM pur_rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?').get(r.id, A.id(req.params.supplierId));
  if (!q) throw new HttpError(404, "Ce fournisseur n'est pas consulté dans cet appel d'offres.");
  const b = req.body || {};
  if (b.declined === true) {
    await db.prepare("UPDATE pur_rfq_suppliers SET status = 'declined', note = ?, quoted_at = ? WHERE id = ?").run(A.text(b.note, 500), nowISO(), q.id);
    await db.prepare('DELETE FROM pur_quote_lines WHERE rfq_supplier_id = ?').run(q.id);
    return res.json({ ok: true, status: 'declined' });
  }
  if (!Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Indiquez au moins un prix.');
  const lineIds = new Set((await db.prepare('SELECT id FROM pur_rfq_lines WHERE rfq_id = ?').all(r.id)).map((x) => Number(x.id)));
  const seen = new Set(); const prices = [];
  for (const l of b.lines) {
    const lid = Number(l && l.rfqLineId);
    if (!lineIds.has(lid)) throw new HttpError(400, "Une ligne du devis n'appartient pas à cet appel d'offres.");
    if (seen.has(lid)) throw new HttpError(400, 'Une ligne apparaît deux fois dans le devis.');
    seen.add(lid);
    prices.push({ lid, price: A.amount(l.unitPrice) });
  }
  const validUntil = A.date(b.validUntil);
  await db.transaction(async () => {
    await db.prepare("UPDATE pur_rfq_suppliers SET status = 'quoted', delivery_days = ?, payment_days = ?, terms = ?, valid_until = ?, note = ?, quoted_at = ? WHERE id = ?")
      .run(b.deliveryDays === undefined || b.deliveryDays === '' ? null : P.days(b.deliveryDays, null, 'Délai de livraison'), b.paymentDays === undefined || b.paymentDays === '' ? null : P.days(b.paymentDays, null, 'Délai de paiement'), A.text(b.terms, 500), validUntil, A.text(b.note, 500), nowISO(), q.id);
    await db.prepare('DELETE FROM pur_quote_lines WHERE rfq_supplier_id = ?').run(q.id);
    for (const p of prices) await db.prepare('INSERT INTO pur_quote_lines (rfq_supplier_id, rfq_line_id, unit_price) VALUES (?, ?, ?)').run(q.id, p.lid, p.price);
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Devis saisi pour l'appel d'offres ${r.number}`);
  res.json({ ok: true, status: 'quoted' });
});

router.post('/rfqs/:id/award', async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est déjà terminé.");
  const b = req.body || {};
  const sup = await P.supplierOf(req, b.supplierId);
  const cmp = await comparison(r);
  const q = cmp.suppliers.find((s) => s.supplierId === Number(sup.id));
  if (!q || q.status !== 'quoted') throw new HttpError(400, "Ce fournisseur n'a pas remis de devis.");
  if (!q.complete) throw new HttpError(400, 'Le devis de ce fournisseur est incomplet : il manque des prix.');
  if (q.expired) throw new HttpError(400, 'Le devis de ce fournisseur n\'est plus valable.');
  const lowest = cmp.suppliers.filter((s) => s.status === 'quoted' && s.complete && !s.expired).sort((a, c) => ranked({ total: a.total, deliveryDays: a.deliveryDays }, { total: c.total, deliveryDays: c.deliveryDays }))[0];
  const reason = A.text(b.reason, 300);
  if (lowest && lowest.supplierId !== q.supplierId && lowest.total < q.total && !reason) throw new HttpError(400, `Ce n'est pas l'offre la moins chère (${lowest.name} : ${lowest.total.toLocaleString('fr-FR')} FCFA). Indiquez le motif du choix.`);
  const lines = cmp.lines.map((l) => ({ itemId: l.itemId, description: l.description, unit: l.unit, quantity: l.quantity, price: q.prices[l.id] }));
  const baseline = cmp.baseline;
  const savings = Math.max(baseline - q.total, 0);
  let orderId;
  await db.transaction(async () => {
    const upd = await db.prepare("UPDATE pur_rfqs SET status = 'awarded', awarded_supplier_id = ?, award_reason = ?, baseline = ?, awarded_total = ?, savings = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(sup.id, reason, baseline, q.total, savings, nowISO(), r.id);
    if (!upd.changes) throw new HttpError(409, "Cet appel d'offres vient de changer : rechargez la page.");
    const rq = r.request_id ? await db.prepare('SELECT * FROM pur_requests WHERE id = ?').get(r.request_id) : null;
    const expected = q.deliveryDays !== null ? P.addDays(P.today(), q.deliveryDays) : rq && rq.needed_date && rq.needed_date >= P.today() ? rq.needed_date : null;
    orderId = await require('./pur-orders').createOrder(req, { supplier: sup, requestId: r.request_id, rfqId: r.id, orderDate: P.today(), expectedDate: expected, paymentDays: q.paymentDays === null ? undefined : q.paymentDays, category: r.category, branchId: rq ? rq.branch_id : null, projectId: rq ? rq.project_id : null, notes: `${r.number} : ${r.title}${q.terms ? ' - ' + q.terms : ''}`.slice(0, 1000), lines });
    await db.prepare('UPDATE pur_rfqs SET order_id = ? WHERE id = ?').run(orderId, r.id);
    if (rq && rq.status === 'approved') await db.prepare("UPDATE pur_requests SET status = 'ordered', updated_at = ? WHERE id = ?").run(nowISO(), rq.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Appel d'offres ${r.number} attribué à ${sup.name} (${q.total.toLocaleString('fr-FR')} FCFA HT, économie ${savings.toLocaleString('fr-FR')})`);
  res.status(201).json({ ok: true, orderId, savings, total: q.total });
});

router.post('/rfqs/:id/cancel', async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est déjà terminé.");
  const reason = A.text((req.body || {}).reason, 300, { required: true, msg: "Indiquez le motif de l'annulation." });
  await db.prepare("UPDATE pur_rfqs SET status = 'cancelled', award_reason = ?, closed_at = ? WHERE id = ?").run(reason, nowISO(), r.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Appel d'offres ${r.number} annulé`);
  res.json({ ok: true });
});

module.exports = router;
