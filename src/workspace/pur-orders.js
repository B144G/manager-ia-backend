'use strict';
// Achats · bons de commande (en-tête + lignes), approbation par seuil, envoi au fournisseur (e-mail avec PDF ou remise manuelle), réceptions partielles
// avec contrôle (reçu / refusé / motif), lot, péremption et numéros de série (entrée en stock par stock-lib.adjust), bons de réception en PDF.
// États : brouillon → approuvé → envoyé → partiellement reçu → reçu → clos ; annulé tant que rien n'est reçu. Numérotation BC-AAAA-0001 par année.
// La réception n'écrit PAS en comptabilité : la charge (601/4452/401) naît de la facture fournisseur validée (pur-invoices.js), sans double compte.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./stock-lib');
const P = require('./pur-lib');
const PDF = require('../services/pdf');
const { sendMail, mailEnabled } = require('../services/notify');
const { HttpError, isEmail, log, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const STATUSES = ['draft', 'approved', 'sent', 'partial', 'received', 'closed', 'cancelled'];
const LABEL = { draft: 'Brouillon', approved: 'Approuvé', sent: 'Envoyé', partial: 'Partiellement reçu', received: 'Reçu', closed: 'Clos', cancelled: 'Annulé' };
const nameOf = async (id) => (id ? ((await db.prepare('SELECT name FROM users WHERE id = ?').get(id)) || {}).name || '' : '');
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('fr-FR');

async function orderOf(req, id) {
  const o = await db.prepare('SELECT * FROM pur_orders WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!o || !(A.visible(req, o))) throw new HttpError(404, 'Bon de commande introuvable.');
  return o;
}
async function lineRows(orderId) {
  return await db.prepare(`SELECT l.*, i.name AS item_name, i.tracking, COALESCE((SELECT SUM(il.quantity) FROM pur_invoice_lines il JOIN pur_invoices v ON v.id = il.invoice_id WHERE il.order_line_id = l.id AND v.status <> 'cancelled'), 0) AS invoiced_qty
    FROM pur_order_lines l LEFT JOIN stock_items i ON i.id = l.item_id WHERE l.order_id = ? ORDER BY l.id`).all(orderId);
}
const lineView = (l) => ({ id: Number(l.id), itemId: l.item_id === null ? null : Number(l.item_id), item: l.item_name || '', tracking: l.tracking || 'none', description: l.description, unit: l.unit, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), amount: P.lineAmount(l.quantity, l.unit_price),
  receivedQty: Number(l.received_qty), rejectedQty: Number(l.rejected_qty), remainingQty: Math.max(P.round3(Number(l.quantity) - Number(l.received_qty)), 0), invoicedQty: Number(l.invoiced_qty) });

async function view(req, o, full) {
  const t = P.today();
  const sup = await db.prepare('SELECT s.name, p.email FROM suppliers s LEFT JOIN pur_supplier_profiles p ON p.supplier_id = s.id WHERE s.id = ?').get(o.supplier_id);
  const out = {
    id: Number(o.id), number: o.number, supplierId: Number(o.supplier_id), supplier: (sup && sup.name) || o.supplier_name, supplierEmail: (sup && sup.email) || '', requestId: o.request_id === null ? null : Number(o.request_id), rfqId: o.rfq_id === null ? null : Number(o.rfq_id),
    status: o.status, statusLabel: LABEL[o.status], orderDate: o.order_date, expectedDate: o.expected_date, paymentDays: Number(o.payment_days), vatRate: Number(o.vat_rate), category: o.category,
    branchId: o.branch_id === null ? null : Number(o.branch_id), projectId: o.project_id === null ? null : Number(o.project_id), deliveryAddress: o.delivery_address, notes: o.notes,
    totalHt: Number(o.total_ht), vatAmount: Number(o.vat_amount), totalTtc: Number(o.total_ttc), requiredRole: o.required_role, requiredRoleLabel: A.ROLE_LABEL[o.required_role],
    createdBy: Number(o.created_by), creator: await nameOf(o.created_by), approvedBy: o.approved_by === null ? null : Number(o.approved_by), approver: await nameOf(o.approved_by), approvedAt: o.approved_at, sentAt: o.sent_at, sentTo: o.sent_to,
    closedAt: o.closed_at, cancelReason: o.cancel_reason, createdAt: o.created_at,
    late: ['sent', 'partial'].includes(o.status) && Boolean(o.expected_date) && o.expected_date < t,
    canApprove: o.status === 'draft' && !P.approvalError(req, o.required_role, o.created_by),
  };
  const lines = (await lineRows(o.id)).map(lineView);
  out.receivedPct = lines.length ? Math.round((lines.reduce((s, l) => s + Math.min(l.receivedQty, l.quantity), 0) / Math.max(lines.reduce((s, l) => s + l.quantity, 0), 1e-9)) * 100) : 0;
  if (full) {
    out.lines = lines;
    out.receipts = (await db.prepare('SELECT id, number, receipt_date, delivery_note, created_by, created_at FROM pur_receipts WHERE order_id = ? ORDER BY id').all(o.id)).map((r) => ({ id: Number(r.id), number: r.number, date: r.receipt_date, deliveryNote: r.delivery_note }));
    out.invoices = (await db.prepare("SELECT id, number, supplier_ref, status, total_ttc FROM pur_invoices WHERE order_id = ? AND status <> 'cancelled' ORDER BY id").all(o.id)).map((v) => ({ id: Number(v.id), number: v.number, supplierRef: v.supplier_ref, status: v.status, totalTtc: Number(v.total_ttc) }));
    out.budget = o.category ? await P.budgetStatus(req.org.id, o.category, o.order_date.slice(0, 4), ['draft'].includes(o.status) ? Number(o.total_ttc) : 0, o.id) : null;
  }
  return out;
}

// ---------- Création (utilisée aussi par les demandes d'achat et les appels d'offres) ----------
async function createOrder(req, o) {
  const orderDate = o.orderDate || P.today();
  const expected = o.expectedDate || null;
  if (expected && expected < orderDate) throw new HttpError(400, 'La date de livraison prévue précède la date de commande.');
  const st = await P.settings(req.org.id);
  const paymentDays = P.days(o.paymentDays, st.defaultTermsDays, 'Délai de paiement');
  const vatRate = P.vatRateOf(req, o.vatRate);
  const t = P.totals(o.lines, vatRate);
  const role = await P.requiredRole(req.org.id, 'order', t.ttc);
  return await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'order', 'BC', orderDate);
    const now = nowISO();
    const id = Number((await db.prepare(`INSERT INTO pur_orders (org_id, number, supplier_id, supplier_name, request_id, rfq_id, status, order_date, expected_date, payment_days, vat_rate, category, branch_id, project_id, delivery_address, notes, total_ht, vat_amount, total_ttc, required_role, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, number, o.supplier.id, o.supplier.name, o.requestId || null, o.rfqId || null, orderDate, expected, paymentDays, vatRate, o.category || '', o.branchId || null, o.projectId || null,
      o.deliveryAddress || '', o.notes || '', t.ht, t.vat, t.ttc, role, req.user.id, now, now)).lastInsertRowid);
    for (const l of o.lines) await db.prepare('INSERT INTO pur_order_lines (org_id, order_id, item_id, description, unit, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, l.itemId, l.description, l.unit, l.quantity, l.price);
    return id;
  })();
}

async function headerOf(req, b, cur) {
  const has = (k) => b[k] !== undefined;
  const orderDate = has('orderDate') ? A.date(b.orderDate) || P.today() : cur ? cur.order_date : P.today();
  const expectedDate = has('expectedDate') ? A.date(b.expectedDate) : cur ? cur.expected_date : null;
  if (expectedDate && expectedDate < orderDate) throw new HttpError(400, 'La date de livraison prévue précède la date de commande.');
  return {
    orderDate, expectedDate, paymentDays: has('paymentDays') ? b.paymentDays : cur ? cur.payment_days : undefined, vatRate: has('vatRate') ? b.vatRate : cur ? cur.vat_rate : undefined,
    category: has('category') ? P.catOf(b.category) : cur ? cur.category : '', branchId: has('branchId') ? await A.branchOf(req, b.branchId) : cur ? cur.branch_id : null,
    projectId: has('projectId') ? await P.projectOf(req, b.projectId) : cur ? cur.project_id : null, deliveryAddress: has('deliveryAddress') ? A.text(b.deliveryAddress, 200) : cur ? cur.delivery_address : '',
    notes: has('notes') ? A.text(b.notes, 1000) : cur ? cur.notes : '',
  };
}

router.get('/orders', async (req, res) => {
  const w = ['o.org_id = ?']; const a = [req.org.id];
  if (req.query.status) { w.push('o.status = ?'); a.push(A.oneOf(req.query.status, STATUSES, undefined, 'Statut inconnu.')); }
  if (req.query.supplierId) { w.push('o.supplier_id = ?'); a.push(A.id(req.query.supplierId, 'Fournisseur invalide.')); }
  const sc = A.scope(req, 'o.branch_id');
  const rows = await db.prepare(`SELECT o.* FROM pur_orders o WHERE ${w.join(' AND ')}${sc.sql} ORDER BY CASE o.status WHEN 'draft' THEN 0 WHEN 'approved' THEN 1 WHEN 'sent' THEN 2 WHEN 'partial' THEN 2 ELSE 3 END, o.id DESC LIMIT 300`).all(...a, ...sc.args);
  const orders = []; for (const o of rows) orders.push(await view(req, o, false));
  res.json({ orders, counts: Object.fromEntries(STATUSES.map((s) => [s, orders.filter((x) => x.status === s).length])), late: orders.filter((x) => x.late).length });
});

router.post('/orders', async (req, res) => {
  const b = req.body || {};
  const sup = await P.supplierOf(req, b.supplierId);
  const lines = await P.cleanLines(req, b.lines, 'unit');
  const h = await headerOf(req, b, null);
  let requestId = null;
  if (b.requestId !== undefined && b.requestId !== null && b.requestId !== '') {
    const r = await db.prepare('SELECT * FROM pur_requests WHERE id = ? AND org_id = ?').get(A.id(b.requestId, 'Demande invalide.'), req.org.id);
    if (!r) throw new HttpError(400, "Demande d'achat introuvable.");
    requestId = Number(r.id);
  }
  const id = await createOrder(req, { supplier: sup, requestId, ...h, lines });
  const o = await db.prepare('SELECT number FROM pur_orders WHERE id = ?').get(id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Bon de commande ${o.number} créé (${sup.name})`);
  res.status(201).json({ id, number: o.number });
});

router.get('/orders/:id', async (req, res) => res.json({ order: await view(req, await orderOf(req, req.params.id), true) }));

router.put('/orders/:id', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'draft') throw new HttpError(400, 'Seul un bon de commande en brouillon se modifie.');
  const b = req.body || {};
  const sup = b.supplierId === undefined ? await P.supplierOf(req, o.supplier_id) : await P.supplierOf(req, b.supplierId);
  const h = await headerOf(req, b, o);
  const lines = b.lines === undefined ? null : await P.cleanLines(req, b.lines, 'unit');
  const st = await P.settings(req.org.id);
  const paymentDays = P.days(h.paymentDays, st.defaultTermsDays, 'Délai de paiement');
  const vatRate = P.vatRateOf(req, h.vatRate);
  await db.transaction(async () => {
    if (lines) { await db.prepare('DELETE FROM pur_order_lines WHERE order_id = ?').run(o.id); for (const l of lines) await db.prepare('INSERT INTO pur_order_lines (org_id, order_id, item_id, description, unit, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, o.id, l.itemId, l.description, l.unit, l.quantity, l.price); }
    const t = P.totals(await db.prepare('SELECT quantity, unit_price FROM pur_order_lines WHERE order_id = ?').all(o.id), vatRate);
    const role = await P.requiredRole(req.org.id, 'order', t.ttc);
    await db.prepare(`UPDATE pur_orders SET supplier_id = ?, supplier_name = ?, order_date = ?, expected_date = ?, payment_days = ?, vat_rate = ?, category = ?, branch_id = ?, project_id = ?, delivery_address = ?, notes = ?, total_ht = ?, vat_amount = ?, total_ttc = ?, required_role = ?, updated_at = ? WHERE id = ?`)
      .run(sup.id, sup.name, h.orderDate, h.expectedDate, paymentDays, vatRate, h.category, h.branchId, h.projectId, h.deliveryAddress, h.notes, t.ht, t.vat, t.ttc, role, nowISO(), o.id);
  })();
  res.json({ ok: true });
});

router.delete('/orders/:id', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'draft') throw new HttpError(400, 'Seul un brouillon se supprime ; annulez les autres bons de commande.');
  await db.prepare('DELETE FROM pur_orders WHERE id = ?').run(o.id);
  res.json({ ok: true });
});

router.post('/orders/:id/approve', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'draft') throw new HttpError(400, "Ce bon de commande n'est pas en brouillon.");
  const role = await P.requiredRole(req.org.id, 'order', Number(o.total_ttc));
  const err = P.approvalError(req, role, o.created_by);
  if (err) throw new HttpError(403, err);
  const sup = await P.supplierOf(req, o.supplier_id);
  const budget = o.category ? await P.budgetGuard(req, o.category, o.order_date, Number(o.total_ttc), Number(o.id), (req.body || {}).overrideBudget === true) : null;
  const upd = await db.prepare("UPDATE pur_orders SET status = 'approved', required_role = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'").run(role, req.user.id, nowISO(), nowISO(), o.id);
  if (!upd.changes) throw new HttpError(409, 'Ce bon de commande vient de changer : rechargez la page.');
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Bon de commande ${o.number} approuvé (${sup.name}, ${fmt(o.total_ttc)} FCFA)`);
  res.json({ ok: true, budgetWarning: budget && budget.over ? budget : null });
});

// ---------- PDF et envoi ----------
async function orderPdf(req, o) {
  const v = await view(req, o, true);
  const org = req.org;
  const sup = await db.prepare('SELECT s.*, p.address, p.city, p.email, p.phone FROM suppliers s LEFT JOIN pur_supplier_profiles p ON p.supplier_id = s.id WHERE s.id = ?').get(o.supplier_id) || {};
  return PDF.render({
    org: org.name, title: `Bon de commande ${v.number}`, subtitle: v.statusLabel,
    meta: [['Fournisseur', v.supplier], ...(sup.address || sup.city ? [['Adresse', [sup.address, sup.city].filter(Boolean).join(', ')]] : []), ['Date de commande', PDF.dfr(v.orderDate)], ['Livraison prévue', v.expectedDate ? PDF.dfr(v.expectedDate) : 'À convenir'],
      ['Paiement', `${v.paymentDays} jours`], ...(v.deliveryAddress ? [['Livrer à', v.deliveryAddress]] : []), ...(org.niu ? [['NIU', org.niu]] : [])],
    blocks: [
      { type: 'table', cols: [{ key: 'n', label: '#', width: 0.5 }, { key: 'd', label: 'Désignation', width: 4 }, { key: 'q', label: 'Qté', width: 1.2, align: 'right' }, { key: 'p', label: 'Prix unitaire', width: 1.8, align: 'right' }, { key: 'a', label: 'Montant', width: 1.8, align: 'right' }],
        rows: v.lines.map((l, i) => ({ n: String(i + 1), d: l.description, q: `${l.quantity} ${l.unit}`, p: fmt(l.unitPrice), a: fmt(l.amount) })),
        totals: [['Total HT', `${fmt(v.totalHt)} FCFA`], [`TVA ${v.vatRate} %`, `${fmt(v.vatAmount)} FCFA`], ['Total TTC', `${fmt(v.totalTtc)} FCFA`, true]] },
      ...(v.notes ? [{ type: 'note', text: v.notes }] : []),
    ],
    footer: 'Merci de rappeler le numéro de ce bon de commande sur votre bon de livraison et votre facture.',
  });
}
router.get('/orders/:id/pdf', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const buf = await orderPdf(req, o);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${o.number}.pdf"`, 'Cache-Control': 'private, no-store' });
  res.send(buf);
});

router.post('/orders/:id/send', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['approved', 'sent'].includes(o.status) && !(['partial'].includes(o.status))) throw new HttpError(400, 'Approuvez le bon de commande avant de l\'envoyer.');
  const b = req.body || {};
  const via = A.oneOf(b.via, ['email', 'manual'], 'manual', "Mode d'envoi : e-mail ou remise manuelle.");
  let to = '';
  if (via === 'email') {
    if (!mailEnabled()) throw new HttpError(400, "L'envoi d'e-mails n'est pas activé sur ce serveur. Téléchargez le PDF, puis choisissez « Marquer comme envoyé ».");
    const p = await db.prepare('SELECT email FROM pur_supplier_profiles WHERE supplier_id = ?').get(o.supplier_id);
    to = A.text(b.to, 120) || (p ? p.email : '');
    if (!to) throw new HttpError(400, "Indiquez l'adresse e-mail du fournisseur (ou renseignez-la dans sa fiche).");
    if (!isEmail(to)) throw new HttpError(400, 'Adresse e-mail invalide.');
    const buf = await orderPdf(req, o);
    const v = await view(req, o, false);
    try {
      const ok = await sendMail({ to, subject: `Bon de commande ${o.number} - ${req.org.name}`, text: `Bonjour,\n\nVeuillez trouver ci-joint notre bon de commande ${o.number} (${fmt(v.totalTtc)} FCFA TTC)${o.expected_date ? `, livraison souhaitée le ${PDF.dfr(o.expected_date)}` : ''}.\nMerci de nous en accuser réception et de rappeler ce numéro sur votre bon de livraison et votre facture.\n\n${req.org.name}`,
        fromName: req.org.name, replyTo: undefined, attachments: [{ filename: `${o.number}.pdf`, content: buf, contentType: 'application/pdf' }] });
      if (!ok) throw new HttpError(400, "L'envoi d'e-mails n'est pas activé sur ce serveur.");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      log.warn('Achats : envoi du bon de commande :', oneLine(e.message, 140));
      throw new HttpError(502, "L'e-mail n'a pas pu partir. Le bon de commande reste inchangé ; réessayez ou téléchargez le PDF.");
    }
  }
  await db.prepare("UPDATE pur_orders SET status = CASE WHEN status = 'approved' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, ?), sent_to = ?, updated_at = ? WHERE id = ?").run(nowISO(), to || (via === 'manual' ? 'remise manuelle' : ''), nowISO(), o.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Bon de commande ${o.number} ${via === 'email' ? `envoyé par e-mail à ${to}` : 'marqué comme envoyé'}`);
  res.json({ ok: true, via, to });
});

// ---------- Réceptions ----------
async function receiptOf(req, id) {
  const r = await db.prepare('SELECT * FROM pur_receipts WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!r) throw new HttpError(404, 'Bon de réception introuvable.');
  return r;
}
async function receiptView(req, r) {
  const o = await db.prepare('SELECT number, supplier_id, supplier_name FROM pur_orders WHERE id = ?').get(r.order_id);
  const lines = (await db.prepare(`SELECT rl.*, ol.description, ol.unit, ol.quantity AS ordered FROM pur_receipt_lines rl JOIN pur_order_lines ol ON ol.id = rl.order_line_id WHERE rl.receipt_id = ? ORDER BY rl.id`).all(r.id))
    .map((l) => ({ id: Number(l.id), orderLineId: Number(l.order_line_id), description: l.description, unit: l.unit, ordered: Number(l.ordered), receivedQty: Number(l.received_qty), rejectedQty: Number(l.rejected_qty), reason: l.reason, lotNo: l.lot_no, expiry: l.expiry }));
  return { id: Number(r.id), number: r.number, orderId: Number(r.order_id), orderNumber: o.number, supplier: o.supplier_name, date: r.receipt_date, deliveryNote: r.delivery_note, note: r.note, receiver: await nameOf(r.created_by), createdAt: r.created_at, lines };
}

router.post('/orders/:id/receipts', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['approved', 'sent', 'partial'].includes(o.status)) throw new HttpError(400, o.status === 'draft' ? "Approuvez le bon de commande avant d'enregistrer une réception." : 'Ce bon de commande ne reçoit plus de marchandises.');
  const b = req.body || {};
  const date = A.date(b.receiptDate) || P.today();
  if (date > P.today()) throw new HttpError(400, 'La date de réception ne peut pas être dans le futur.');
  if (date < o.order_date) throw new HttpError(400, 'La réception précède la date de la commande.');
  if (!Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Indiquez les quantités reçues.');
  const st = await P.settings(req.org.id);
  const olines = new Map((await lineRows(o.id)).map((l) => [Number(l.id), l]));
  const seen = new Set(); const todo = [];
  for (const l of b.lines) {
    const ol = olines.get(Number(l && l.orderLineId));
    if (!ol) throw new HttpError(400, "Une ligne de réception n'appartient pas à ce bon de commande.");
    if (seen.has(Number(ol.id))) throw new HttpError(400, `La ligne « ${ol.description} » apparaît deux fois.`);
    seen.add(Number(ol.id));
    const recv = l.receivedQty === undefined || l.receivedQty === '' ? 0 : A.qty(l.receivedQty, { allowZero: true });
    const rej = l.rejectedQty === undefined || l.rejectedQty === '' ? 0 : A.qty(l.rejectedQty, { allowZero: true });
    if (recv === 0 && rej === 0) continue;
    const reason = A.text(l.reason, 200);
    if (rej > 0 && !reason) throw new HttpError(400, `Indiquez le motif du refus pour « ${ol.description} ».`);
    const max = Number(ol.quantity) * (1 + st.tolQtyPct / 100);
    if (P.round3(Number(ol.received_qty) + recv) > max + 1e-9) throw new HttpError(400, `« ${ol.description} » : ${P.round3(Number(ol.received_qty) + recv)} reçu(s) pour ${ol.quantity} commandé(s) (tolérance ${st.tolQtyPct} %).`);
    if (ol.item_id && recv > 0 && ol.tracking === 'serial' && !Number.isInteger(recv)) throw new HttpError(400, `« ${ol.description} » est suivi par numéro de série : quantité entière.`);
    let locationId = null;
    if (l.locationId !== undefined && l.locationId !== null && l.locationId !== '') {
      // Emplacement de réception (module Stock WMS) : sans WMS installé, on refuse plutôt que d'ignorer en silence.
      const hasWms = await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'wms_locations'").get();
      if (!hasWms) throw new HttpError(400, "Les emplacements d'entrepôt ne sont pas disponibles : laissez le rangement automatique.");
      const loc = await db.prepare('SELECT id FROM wms_locations WHERE id = ? AND org_id = ?').get(A.id(l.locationId, 'Emplacement invalide.'), req.org.id);
      if (!loc) throw new HttpError(400, 'Emplacement inconnu.');
      locationId = Number(loc.id);
    }
    todo.push({ ol, recv, rej, reason, lotNo: A.text(l.lotNo, 40), expiry: A.date(l.expiry), serials: l.serials, locationId });
  }
  if (!todo.length) throw new HttpError(400, 'Aucune quantité reçue ou refusée : rien à enregistrer.');
  let rid; let number;
  await db.transaction(async () => {
    // verrou : deux réceptions simultanées ne dépassent pas la commande
    await db.prepare('SELECT id FROM pur_orders WHERE id = ? FOR UPDATE').get(o.id);
    const fresh = await db.prepare('SELECT status FROM pur_orders WHERE id = ?').get(o.id);
    if (!['approved', 'sent', 'partial'].includes(fresh.status)) throw new HttpError(409, 'Ce bon de commande vient de changer : rechargez la page.');
    for (const t of todo) {
      const cur = await db.prepare('SELECT received_qty FROM pur_order_lines WHERE id = ? FOR UPDATE').get(t.ol.id);
      if (P.round3(Number(cur.received_qty) + t.recv) > Number(t.ol.quantity) * (1 + st.tolQtyPct / 100) + 1e-9) throw new HttpError(409, `« ${t.ol.description} » vient d'être reçu par quelqu'un d'autre : rechargez la page.`);
    }
    number = await P.nextNumber(req.org.id, 'receipt', 'BR', date);
    rid = Number((await db.prepare('INSERT INTO pur_receipts (org_id, order_id, number, receipt_date, delivery_note, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, o.id, number, date, A.text(b.deliveryNote, 60), A.text(b.note, 500), req.user.id, nowISO())).lastInsertRowid);
    for (const t of todo) {
      await db.prepare('INSERT INTO pur_receipt_lines (org_id, receipt_id, order_line_id, received_qty, rejected_qty, reason, lot_no, expiry, location_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, rid, t.ol.id, t.recv, t.rej, t.reason, t.lotNo, t.expiry, t.locationId);
      await db.prepare('UPDATE pur_order_lines SET received_qty = received_qty + ?, rejected_qty = rejected_qty + ? WHERE id = ?').run(t.recv, t.rej, t.ol.id);
      if (t.ol.item_id && t.recv > 0) {
        const serials = t.ol.tracking === 'serial' ? L.parseSerials(t.serials) : undefined;
        // Le prix reçu alimente la fiche « prix par fournisseur » du module Stock et achats (comparaison de prix, note du fournisseur).
        await db.prepare('INSERT INTO supplier_prices (org_id, item_id, supplier_id, unit_price) VALUES (?, ?, ?, ?) ON CONFLICT (item_id, supplier_id) DO UPDATE SET unit_price = EXCLUDED.unit_price').run(req.org.id, t.ol.item_id, o.supplier_id, Number(t.ol.unit_price));
        await L.adjust(req, t.ol.item_id, t.recv, `Réception ${number} (${o.number})`, { unitCost: Number(t.ol.unit_price), lotNo: t.lotNo, expiry: t.expiry || undefined, serials, strict: true, refKind: 'pur_receipt', refId: rid, locationId: t.locationId || undefined });
      }
    }
    const all = await db.prepare('SELECT quantity, received_qty FROM pur_order_lines WHERE order_id = ?').all(o.id);
    const done = all.every((l) => Number(l.received_qty) + 1e-9 >= Number(l.quantity));
    await db.prepare('UPDATE pur_orders SET status = ?, updated_at = ? WHERE id = ?').run(done ? 'received' : 'partial', nowISO(), o.id);
  })();
  const after = await db.prepare('SELECT status FROM pur_orders WHERE id = ?').get(o.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Réception ${number} enregistrée sur ${o.number}`);
  if (todo.some((t) => t.rej > 0)) await W.pushRole(req.org.id, 'manager', 'purchasing', `Réception ${number} : des marchandises ont été refusées sur ${o.number}.`, `pur-order:${o.id}`);
  res.status(201).json({ id: rid, number, orderStatus: after.status });
});

router.get('/orders/:id/receipts', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const rows = await db.prepare('SELECT * FROM pur_receipts WHERE order_id = ? ORDER BY id').all(o.id);
  const receipts = []; for (const r of rows) receipts.push(await receiptView(req, r));
  res.json({ receipts });
});
router.get('/receipts', async (req, res) => {
  const rows = await db.prepare('SELECT r.* FROM pur_receipts r WHERE r.org_id = ? ORDER BY r.id DESC LIMIT 100').all(req.org.id);
  const receipts = []; for (const r of rows) receipts.push(await receiptView(req, r));
  res.json({ receipts });
});
router.get('/receipts/:id', async (req, res) => res.json({ receipt: await receiptView(req, await receiptOf(req, req.params.id)) }));
router.get('/receipts/:id/pdf', async (req, res) => {
  const v = await receiptView(req, await receiptOf(req, req.params.id));
  const buf = await PDF.render({
    org: req.org.name, title: `Bon de réception ${v.number}`, subtitle: `Commande ${v.orderNumber}`,
    meta: [['Fournisseur', v.supplier], ['Date', PDF.dfr(v.date)], ...(v.deliveryNote ? [["N° du bon de livraison", v.deliveryNote]] : []), ['Reçu par', v.receiver]],
    blocks: [{ type: 'table', cols: [{ key: 'd', label: 'Désignation', width: 3.5 }, { key: 'o', label: 'Commandé', width: 1.3, align: 'right' }, { key: 'r', label: 'Reçu', width: 1.2, align: 'right' }, { key: 'x', label: 'Refusé', width: 1.2, align: 'right' }, { key: 'm', label: 'Lot / péremption / motif', width: 2.8 }],
      rows: v.lines.map((l) => ({ d: l.description, o: `${l.ordered} ${l.unit}`, r: String(l.receivedQty), x: String(l.rejectedQty), m: [l.lotNo && `Lot ${l.lotNo}`, l.expiry && `péremption ${PDF.dfr(l.expiry)}`, l.reason].filter(Boolean).join(' · ') })) },
      ...(v.note ? [{ type: 'note', text: v.note }] : [])],
  });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${v.number}.pdf"`, 'Cache-Control': 'private, no-store' });
  res.send(buf);
});

// ---------- Clôture, annulation ----------
router.post('/orders/:id/close', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['received', 'partial'].includes(o.status)) throw new HttpError(400, 'On ne clôt qu\'un bon de commande reçu ou partiellement reçu.');
  await db.prepare("UPDATE pur_orders SET status = 'closed', closed_at = ?, updated_at = ?, cancel_reason = ? WHERE id = ?").run(nowISO(), nowISO(), A.text((req.body || {}).reason, 300), o.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Bon de commande ${o.number} clos`);
  res.json({ ok: true });
});
router.post('/orders/:id/cancel', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['draft', 'approved', 'sent'].includes(o.status)) throw new HttpError(400, o.status === 'partial' ? 'Des marchandises sont déjà reçues : clôturez ce bon de commande au lieu de l\'annuler.' : 'Ce bon de commande ne peut plus être annulé.');
  const reason = A.text((req.body || {}).reason, 300, { required: o.status !== 'draft', msg: "Indiquez le motif de l'annulation." });
  if (await db.prepare("SELECT 1 FROM pur_invoices WHERE order_id = ? AND status <> 'cancelled'").get(o.id)) throw new HttpError(400, 'Une facture fournisseur est liée à ce bon de commande : supprimez-la ou annulez sa validation d\'abord.');
  await db.prepare("UPDATE pur_orders SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(reason, nowISO(), o.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Bon de commande ${o.number} annulé`);
  res.json({ ok: true });
});

// Brouillon de facture : ce qui est reçu et pas encore facturé, avec les prix du bon de commande.
router.get('/orders/:id/invoice-draft', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const lines = (await lineRows(o.id)).map(lineView).map((l) => ({ orderLineId: l.id, description: l.description, unit: l.unit, quantity: Math.max(P.round3(l.receivedQty - l.invoicedQty), 0), unitPrice: l.unitPrice, ordered: l.quantity, received: l.receivedQty, invoiced: l.invoicedQty })).filter((l) => l.quantity > 0);
  res.json({ supplierId: Number(o.supplier_id), orderId: Number(o.id), vatRate: Number(o.vat_rate), paymentDays: Number(o.payment_days), lines });
});

module.exports = router;
module.exports.createOrder = createOrder;
module.exports.orderOf = orderOf;
module.exports.lineRows = lineRows;
