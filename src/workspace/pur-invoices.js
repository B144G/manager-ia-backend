'use strict';
// Achats · factures fournisseurs : saisie, rapprochement à trois (commande / réception / facture) avec tolérances réglables, anomalies listées,
// validation pour paiement (écriture AC : 601 ou compte de charge choisi + 4452 / 401, une seule fois grâce à source + identifiant par tentative),
// dette fournisseur créée dans la comptabilité (supplier_bills) et règlement relié aux dettes existantes. Les écritures ne se modifient jamais :
// annuler une validation passe une écriture inverse (accounting.reverseEntry) et rouvre la facture.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const P = require('./pur-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));
const accounting = () => require('./accounting'); // require paresseux

const STATUSES = ['entered', 'matched', 'blocked', 'approved', 'cancelled'];
const LABEL = { entered: 'Saisie', matched: 'Rapprochée', blocked: 'Bloquée (anomalies)', approved: 'Validée pour paiement', cancelled: 'Annulée' };
const PAY = { cash: ['571', 'CA'], bank: ['521', 'BQ'], mobile: ['589', 'MM'] };
const ATTEMPTS = 99; // identifiant d'écriture = facture × 100 + tentative : une annulation puis une nouvelle validation ne produit jamais de doublon actif
const ORDER_OK = ['approved', 'sent', 'partial', 'received', 'closed'];
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('fr-FR');

async function invoiceOf(req, id) {
  const v = await db.prepare('SELECT * FROM pur_invoices WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!v) throw new HttpError(404, 'Facture fournisseur introuvable.');
  return v;
}
const linesOf = async (id) => await db.prepare('SELECT * FROM pur_invoice_lines WHERE invoice_id = ? ORDER BY id').all(id);

/** Rapprochement à trois : renvoie { issues, rows } sans rien écrire. */
async function computeMatch(req, v, lines) {
  const st = await P.settings(req.org.id);
  const issues = []; const rows = [];
  const add = (code, message, line) => issues.push({ code, message, ...(line ? { line } : {}) });
  const order = v.order_id ? await db.prepare('SELECT * FROM pur_orders WHERE id = ?').get(v.order_id) : null;
  if (!order) add('no_order', 'Facture sans bon de commande : aucun rapprochement possible.');
  else {
    if (!ORDER_OK.includes(order.status)) add('order_status', `Le bon de commande ${order.number} n'est pas approuvé (${order.status}).`);
    if (Math.abs(Number(order.vat_rate) - Number(v.vat_rate)) > 1e-9) add('vat_gap', `TVA de la facture (${v.vat_rate} %) différente de celle du bon de commande (${order.vat_rate} %).`);
  }
  const dup = await db.prepare("SELECT number FROM pur_invoices WHERE org_id = ? AND id <> ? AND supplier_id = ? AND status <> 'cancelled' AND LOWER(TRIM(supplier_ref)) = LOWER(TRIM(?)) AND TRIM(?) <> '' LIMIT 1").get(req.org.id, v.id, v.supplier_id, v.supplier_ref, v.supplier_ref);
  if (dup) add('duplicate', `Le numéro de facture « ${v.supplier_ref} » de ce fournisseur est déjà saisi (${dup.number}).`);
  for (const l of lines) {
    const row = { description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), orderLineId: l.order_line_id === null ? null : Number(l.order_line_id) };
    if (order && !l.order_line_id) { add('extra_line', `« ${l.description} » ne figure pas sur le bon de commande.`, l.description); rows.push(row); continue; }
    if (l.order_line_id) {
      const ol = await db.prepare('SELECT * FROM pur_order_lines WHERE id = ?').get(l.order_line_id);
      const before = Number((await db.prepare("SELECT COALESCE(SUM(il.quantity), 0) AS s FROM pur_invoice_lines il JOIN pur_invoices i ON i.id = il.invoice_id WHERE il.order_line_id = ? AND i.id <> ? AND i.status <> 'cancelled'").get(l.order_line_id, v.id)).s);
      Object.assign(row, { ordered: Number(ol.quantity), received: Number(ol.received_qty), rejected: Number(ol.rejected_qty), invoicedBefore: before, orderPrice: Number(ol.unit_price) });
      const cum = P.round3(before + Number(l.quantity));
      if (cum > Number(ol.received_qty) * (1 + st.tolQtyPct / 100) + 1e-9) add('not_received', `« ${l.description} » : ${cum} facturé(s) en cumul pour ${ol.received_qty} reçu(s) (tolérance ${st.tolQtyPct} %).`, l.description);
      else if (cum > Number(ol.quantity) * (1 + st.tolQtyPct / 100) + 1e-9) add('over_ordered', `« ${l.description} » : ${cum} facturé(s) pour ${ol.quantity} commandé(s).`, l.description);
      const gap = Number(ol.unit_price) > 0 ? (Math.abs(Number(l.unit_price) - Number(ol.unit_price)) * 100) / Number(ol.unit_price) : 100;
      row.priceGapPct = Math.round(gap * 100) / 100;
      if (gap > st.tolPricePct + 1e-9) add('price_gap', `« ${l.description} » : prix facturé ${fmt(l.unit_price)} au lieu de ${fmt(ol.unit_price)} sur le bon de commande (${row.priceGapPct} % d'écart, tolérance ${st.tolPricePct} %).`, l.description);
    }
    rows.push(row);
  }
  if (v.declared_total !== null && Math.abs(Number(v.declared_total) - (Number(v.total_ht) + Math.round((Number(v.total_ht) * Number(v.vat_rate)) / 100))) > st.tolAmount) add('total_mismatch', `Total annoncé par le fournisseur (${fmt(v.declared_total)}) différent du total calculé (${fmt(Number(v.total_ht) + Math.round((Number(v.total_ht) * Number(v.vat_rate)) / 100))}).`);
  return { issues, rows };
}
async function runMatch(req, id) {
  const v = await db.prepare('SELECT * FROM pur_invoices WHERE id = ?').get(id);
  if (!['entered', 'matched', 'blocked'].includes(v.status)) return v;
  const m = await computeMatch(req, v, await linesOf(id));
  await db.prepare('UPDATE pur_invoices SET status = ?, issues = ?, updated_at = ? WHERE id = ?').run(m.issues.length ? 'blocked' : 'matched', JSON.stringify(m.issues), nowISO(), id);
  return await db.prepare('SELECT * FROM pur_invoices WHERE id = ?').get(id);
}

async function view(req, v, full) {
  const sup = await db.prepare('SELECT name FROM suppliers WHERE id = ?').get(v.supplier_id);
  const ord = v.order_id ? await db.prepare('SELECT number FROM pur_orders WHERE id = ?').get(v.order_id) : null;
  const bill = v.bill_id ? await db.prepare('SELECT paid, amount, status FROM supplier_bills WHERE id = ?').get(v.bill_id) : null;
  const t = P.today();
  const paid = bill ? Number(bill.paid) : 0;
  const payStatus = v.status !== 'approved' ? '' : paid >= Number(v.total_ttc) ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  const entry = v.acc_entry_id ? await db.prepare('SELECT number FROM acc_entries WHERE id = ?').get(v.acc_entry_id) : null;
  const out = {
    id: Number(v.id), number: v.number, supplierId: Number(v.supplier_id), supplier: (sup && sup.name) || v.supplier_name, orderId: v.order_id === null ? null : Number(v.order_id), orderNumber: ord ? ord.number : '',
    supplierRef: v.supplier_ref, invoiceDate: v.invoice_date, dueDate: v.due_date, vatRate: Number(v.vat_rate), totalHt: Number(v.total_ht), vatAmount: Number(v.vat_amount), totalTtc: Number(v.total_ttc), declaredTotal: v.declared_total === null ? null : Number(v.declared_total),
    expenseAccount: v.expense_account, status: v.status, statusLabel: LABEL[v.status], issues: JSON.parse(v.issues || '[]'), overrideReason: v.override_reason, paid, balance: v.status === 'approved' ? Number(v.total_ttc) - paid : 0, paymentStatus: payStatus,
    overdue: v.status === 'approved' && payStatus !== 'paid' && v.due_date < t, entry: entry ? entry.number : '', billId: v.bill_id === null ? null : Number(v.bill_id), approvedAt: v.approved_at, notes: v.notes, createdAt: v.created_at, canPay: v.status === 'approved' && payStatus !== 'paid',
  };
  if (full) {
    const lines = await linesOf(v.id);
    const m = ['entered', 'matched', 'blocked'].includes(v.status) ? await computeMatch(req, v, lines) : { rows: null };
    out.lines = lines.map((l) => ({ id: Number(l.id), orderLineId: l.order_line_id === null ? null : Number(l.order_line_id), description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), amount: P.lineAmount(l.quantity, l.unit_price) }));
    out.matching = m.rows || out.lines;
    out.payments = v.bill_id ? (await db.prepare('SELECT amount, date, method, reference FROM supplier_payments WHERE bill_id = ? ORDER BY id').all(v.bill_id)).map((p) => ({ amount: Number(p.amount), date: p.date, method: p.method, reference: p.reference })) : [];
  }
  return out;
}

async function parse(req, b, cur) {
  const has = (k) => b[k] !== undefined;
  let order = null;
  const orderId = has('orderId') ? (b.orderId === null || b.orderId === '' ? null : A.id(b.orderId, 'Bon de commande invalide.')) : cur ? cur.order_id : null;
  if (orderId) {
    order = await db.prepare('SELECT * FROM pur_orders WHERE id = ? AND org_id = ?').get(orderId, req.org.id);
    if (!order) throw new HttpError(400, 'Bon de commande introuvable.');
    if (!ORDER_OK.includes(order.status)) throw new HttpError(400, `Le bon de commande ${order.number} doit être approuvé avant d'être facturé.`);
  }
  const supplierId = has('supplierId') ? A.id(b.supplierId, 'Fournisseur invalide.') : order ? Number(order.supplier_id) : cur ? Number(cur.supplier_id) : A.id(b.supplierId, 'Indiquez le fournisseur.');
  const sup = await P.supplierOf(req, supplierId, { allowBlocked: true });
  if (order && Number(order.supplier_id) !== Number(sup.id)) throw new HttpError(400, "Le fournisseur de la facture n'est pas celui du bon de commande.");
  const supplierRef = has('supplierRef') || !cur ? A.text(b.supplierRef, 60, { required: true, msg: 'Indiquez le numéro de la facture du fournisseur.' }) : cur.supplier_ref;
  const invoiceDate = has('invoiceDate') ? A.date(b.invoiceDate) || P.today() : cur ? cur.invoice_date : P.today();
  if (invoiceDate > P.today()) throw new HttpError(400, 'La date de la facture ne peut pas être dans le futur.');
  const prof = await db.prepare('SELECT payment_days FROM pur_supplier_profiles WHERE supplier_id = ?').get(sup.id);
  const terms = order ? Number(order.payment_days) : prof ? Number(prof.payment_days) : (await P.settings(req.org.id)).defaultTermsDays;
  const dueDate = has('dueDate') && b.dueDate ? A.date(b.dueDate) : P.addDays(invoiceDate, terms);
  if (dueDate < invoiceDate) throw new HttpError(400, "L'échéance précède la date de la facture.");
  const vatRate = has('vatRate') ? P.vatRateOf(req, b.vatRate) : order ? Number(order.vat_rate) : cur ? Number(cur.vat_rate) : P.vatRateOf(req, undefined);
  const account = has('expenseAccount') && b.expenseAccount !== '' ? String(b.expenseAccount).trim() : cur ? cur.expense_account : '601';
  if (!/^6\d{1,5}$/.test(account)) throw new HttpError(400, 'Compte de charge invalide : un compte de la classe 6 (ex. 601, 604, 605, 622).');
  let lines = null;
  if (b.lines !== undefined || !cur) {
    if (!Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Ajoutez au moins une ligne à la facture.');
    if (b.lines.length > 100) throw new HttpError(400, '100 lignes au plus par facture.');
    lines = []; const used = new Set();
    for (const l of b.lines) {
      let ol = null;
      if (l && l.orderLineId !== undefined && l.orderLineId !== null && l.orderLineId !== '') {
        if (!order) throw new HttpError(400, "Choisissez d'abord le bon de commande de cette facture.");
        ol = await db.prepare('SELECT * FROM pur_order_lines WHERE id = ? AND order_id = ?').get(A.id(l.orderLineId, 'Ligne invalide.'), order.id);
        if (!ol) throw new HttpError(400, "Une ligne de facture n'appartient pas au bon de commande choisi.");
        if (used.has(Number(ol.id))) throw new HttpError(400, `La ligne « ${ol.description} » apparaît deux fois.`);
        used.add(Number(ol.id));
      }
      const description = A.text(l && l.description, 200) || (ol ? ol.description : '');
      if (!description) throw new HttpError(400, 'Chaque ligne a besoin d\'une désignation.');
      lines.push({ orderLineId: ol ? Number(ol.id) : null, description, quantity: A.qty(l.quantity), price: l.unitPrice === undefined && ol ? Number(ol.unit_price) : A.amount(l.unitPrice) });
    }
  }
  const current = lines || (await linesOf(cur.id)).map((l) => ({ quantity: l.quantity, price: l.unit_price }));
  const ht = current.reduce((s, l) => s + P.lineAmount(l.quantity, l.price), 0);
  const vatCalc = Math.round((ht * vatRate) / 100);
  const declared = has('declaredTotal') ? (b.declaredTotal === null || b.declaredTotal === '' ? null : A.amount(b.declaredTotal)) : cur && cur.declared_total !== null ? Number(cur.declared_total) : null;
  if (declared !== null && declared < ht) throw new HttpError(400, 'Le total annoncé est inférieur au total hors taxe : vérifiez les montants.');
  const ttc = declared !== null ? declared : ht + vatCalc;
  return { order, supplier: sup, supplierRef, invoiceDate, dueDate, vatRate, account, lines, ht, vat: ttc - ht, ttc, declared, notes: has('notes') ? A.text(b.notes, 500) : cur ? cur.notes : '' };
}

router.get('/invoices', async (req, res) => {
  const w = ['org_id = ?']; const a = [req.org.id];
  if (req.query.status) { w.push('status = ?'); a.push(A.oneOf(req.query.status, STATUSES, undefined, 'Statut inconnu.')); }
  if (req.query.supplierId) { w.push('supplier_id = ?'); a.push(A.id(req.query.supplierId, 'Fournisseur invalide.')); }
  const rows = await db.prepare(`SELECT * FROM pur_invoices WHERE ${w.join(' AND ')} ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'matched' THEN 1 WHEN 'entered' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END, id DESC LIMIT 300`).all(...a);
  let invoices = []; for (const v of rows) invoices.push(await view(req, v, false));
  if (req.query.paymentStatus) { const ps = A.oneOf(req.query.paymentStatus, ['unpaid', 'partial', 'paid'], undefined, 'Statut de paiement inconnu.'); invoices = invoices.filter((x) => x.paymentStatus === ps); }
  res.json({ invoices, counts: Object.fromEntries(STATUSES.map((s) => [s, invoices.filter((x) => x.status === s).length])),
    toPay: invoices.filter((x) => x.status === 'approved' && x.paymentStatus !== 'paid').reduce((s, x) => s + x.balance, 0), overdue: invoices.filter((x) => x.overdue).length });
});

router.post('/invoices', async (req, res) => {
  const p = await parse(req, req.body || {}, null);
  const id = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'invoice', 'FF', p.invoiceDate);
    const now = nowISO();
    const iid = Number((await db.prepare(`INSERT INTO pur_invoices (org_id, number, supplier_id, supplier_name, order_id, supplier_ref, invoice_date, due_date, vat_rate, total_ht, vat_amount, total_ttc, declared_total, expense_account, status, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'entered', ?, ?, ?, ?)`).run(req.org.id, number, p.supplier.id, p.supplier.name, p.order ? p.order.id : null, p.supplierRef, p.invoiceDate, p.dueDate, p.vatRate, p.ht, p.vat, p.ttc, p.declared, p.account, p.notes, req.user.id, now, now)).lastInsertRowid);
    for (const l of p.lines) await db.prepare('INSERT INTO pur_invoice_lines (org_id, invoice_id, order_line_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, iid, l.orderLineId, l.description, l.quantity, l.price);
    await runMatch(req, iid);
    return iid;
  })();
  const v = await db.prepare('SELECT * FROM pur_invoices WHERE id = ?').get(id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Facture fournisseur ${v.number} saisie (${p.supplier.name}, ${fmt(v.total_ttc)} FCFA) : ${LABEL[v.status].toLowerCase()}`);
  res.status(201).json({ id, number: v.number, status: v.status, issues: JSON.parse(v.issues) });
});

router.get('/invoices/:id', async (req, res) => res.json({ invoice: await view(req, await invoiceOf(req, req.params.id), true) }));

router.put('/invoices/:id', async (req, res) => {
  const v = await invoiceOf(req, req.params.id);
  if (!['entered', 'matched', 'blocked'].includes(v.status)) throw new HttpError(400, v.status === 'approved' ? "Cette facture est validée : annulez d'abord sa validation pour la corriger." : 'Cette facture ne se modifie plus.');
  const p = await parse(req, req.body || {}, v);
  await db.transaction(async () => {
    await db.prepare(`UPDATE pur_invoices SET supplier_id = ?, supplier_name = ?, order_id = ?, supplier_ref = ?, invoice_date = ?, due_date = ?, vat_rate = ?, total_ht = ?, vat_amount = ?, total_ttc = ?, declared_total = ?, expense_account = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .run(p.supplier.id, p.supplier.name, p.order ? p.order.id : null, p.supplierRef, p.invoiceDate, p.dueDate, p.vatRate, p.ht, p.vat, p.ttc, p.declared, p.account, p.notes, nowISO(), v.id);
    if (p.lines) { await db.prepare('DELETE FROM pur_invoice_lines WHERE invoice_id = ?').run(v.id); for (const l of p.lines) await db.prepare('INSERT INTO pur_invoice_lines (org_id, invoice_id, order_line_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, v.id, l.orderLineId, l.description, l.quantity, l.price); }
    await runMatch(req, v.id);
  })();
  res.json({ ok: true });
});

router.post('/invoices/:id/match', async (req, res) => {
  const v = await invoiceOf(req, req.params.id);
  if (!['entered', 'matched', 'blocked'].includes(v.status)) throw new HttpError(400, 'Cette facture est déjà traitée.');
  const r = await runMatch(req, v.id);
  res.json({ status: r.status, issues: JSON.parse(r.issues) });
});

router.delete('/invoices/:id', async (req, res) => {
  const v = await invoiceOf(req, req.params.id);
  if (!['entered', 'matched', 'blocked'].includes(v.status)) throw new HttpError(400, v.status === 'approved' ? "Cette facture est validée : annulez d'abord sa validation." : 'Cette facture est déjà annulée.');
  await db.prepare("UPDATE pur_invoices SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowISO(), v.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Facture fournisseur ${v.number} annulée`);
  res.json({ ok: true });
});

// ---------- Validation pour paiement (écriture comptable) ----------
router.post('/invoices/:id/approve', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  let v = await invoiceOf(req, req.params.id);
  if (v.status === 'approved') throw new HttpError(409, 'Cette facture est déjà validée pour paiement.');
  if (!['matched', 'blocked', 'entered'].includes(v.status)) throw new HttpError(400, 'Cette facture ne peut pas être validée.');
  const out = await db.transaction(async () => {
    v = await runMatch(req, v.id); // données fraîches : une réception ou une autre facture a pu changer le résultat
    let override = '';
    if (v.status === 'blocked') {
      if (b.override !== true) throw new HttpError(400, `Le rapprochement a relevé ${JSON.parse(v.issues).length} anomalie(s) : corrigez la facture ou validez malgré tout avec un motif.`);
      override = A.text(b.overrideReason, 300, { required: true, msg: 'Indiquez pourquoi vous validez malgré les anomalies.' });
    }
    const attempt = Number(v.attempts) + 1;
    if (attempt > ATTEMPTS) throw new HttpError(400, 'Cette facture a été validée puis annulée trop de fois : saisissez-la de nouveau.');
    const sid = Number(v.id) * 100 + attempt;
    const name = v.supplier_name;
    const lines = [{ account: v.expense_account, debit: Number(v.total_ht), memo: name }];
    if (Number(v.vat_amount) > 0) lines.push({ account: '4452', debit: Number(v.vat_amount), memo: name });
    lines.push({ account: '401', credit: Number(v.total_ttc), memo: name });
    const entry = await accounting().recordEntry(req.org, req.user.id, { journal: 'AC', date: v.invoice_date, label: `Facture fournisseur ${v.supplier_ref} - ${name}`.slice(0, 200), piece: v.supplier_ref || v.number, lines, source: 'pur_invoice', sourceId: sid });
    const billId = Number((await db.prepare("INSERT INTO supplier_bills (org_id, supplier_id, supplier_name, number, bill_date, due_date, amount, source, source_id, acc_entry_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pur_invoice', ?, ?, ?, ?, ?)")
      .run(req.org.id, v.supplier_id, name, v.supplier_ref || v.number, v.invoice_date, v.due_date, v.total_ttc, sid, entry.id, `Achats ${v.number}`, req.user.id, nowISO())).lastInsertRowid);
    await db.prepare("UPDATE pur_invoices SET status = 'approved', attempts = ?, bill_id = ?, acc_entry_id = ?, approved_by = ?, approved_at = ?, override_reason = ?, updated_at = ? WHERE id = ? AND status IN ('matched', 'blocked')").run(attempt, billId, entry.id, req.user.id, nowISO(), override, nowISO(), v.id);
    return { entry: entry.number, billId };
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Facture fournisseur ${v.number} validée pour paiement (${fmt(v.total_ttc)} FCFA)`);
  res.json({ ok: true, entry: out.entry, billId: out.billId });
});

router.post('/invoices/:id/unapprove', A.need('admin'), async (req, res) => {
  const v = await invoiceOf(req, req.params.id);
  if (v.status !== 'approved') throw new HttpError(400, "Cette facture n'est pas validée.");
  const reason = A.text((req.body || {}).reason, 300, { required: true, msg: "Indiquez le motif de l'annulation de la validation." });
  const bill = await db.prepare('SELECT * FROM supplier_bills WHERE id = ?').get(v.bill_id);
  if (bill && Number(bill.paid) > 0) throw new HttpError(400, 'Un règlement a déjà été enregistré : la validation ne peut plus être annulée.');
  let rev = null;
  await db.transaction(async () => {
    if (v.acc_entry_id) rev = await accounting().reverseEntry(req.org, req.user.id, Number(v.acc_entry_id), P.today());
    if (bill) await db.prepare("UPDATE supplier_bills SET status = 'cancelled' WHERE id = ? AND paid = 0").run(bill.id);
    await db.prepare("UPDATE pur_invoices SET status = 'entered', bill_id = NULL, acc_entry_id = NULL, approved_by = NULL, approved_at = NULL, override_reason = '', notes = ?, updated_at = ? WHERE id = ?")
      .run(`${v.notes}${v.notes ? ' · ' : ''}Validation annulée : ${reason}`.slice(0, 500), nowISO(), v.id);
    await runMatch(req, v.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Validation de la facture ${v.number} annulée`);
  res.json({ ok: true, reversedEntry: rev ? rev.reversed : null });
});

// ---------- Règlement (relié aux dettes fournisseurs de la comptabilité) ----------
router.post('/invoices/:id/pay', A.need('admin'), async (req, res) => {
  const v = await invoiceOf(req, req.params.id);
  if (v.status !== 'approved' || !v.bill_id) throw new HttpError(400, "Validez d'abord la facture pour paiement.");
  const bill = await db.prepare('SELECT * FROM supplier_bills WHERE id = ?').get(v.bill_id);
  if (!bill || !['open', 'partial'].includes(bill.status)) throw new HttpError(400, "Cette facture n'est plus à payer.");
  const b = req.body || {};
  const left = Number(bill.amount) - Number(bill.paid);
  const amount = A.amount(b.amount === undefined || b.amount === '' ? left : b.amount);
  if (amount > left) throw new HttpError(400, `Ce règlement dépasse le solde (${fmt(left)}).`);
  const method = A.oneOf(b.method, Object.keys(PAY), 'bank', 'Mode de règlement : espèces, banque ou mobile money.');
  const date = A.date(b.date) || P.today();
  const [acct, journal] = PAY[method];
  const ref = A.text(b.reference, 80);
  let pid; let entry;
  await db.transaction(async () => {
    const upd = await db.prepare("UPDATE supplier_bills SET paid = paid + ?, status = CASE WHEN paid + ? >= amount THEN 'paid' ELSE 'partial' END WHERE id = ? AND status IN ('open', 'partial') AND paid + ? <= amount").run(amount, amount, bill.id, amount);
    if (!upd.changes) throw new HttpError(409, 'Cette facture vient de changer : rechargez la page.');
    pid = Number((await db.prepare('INSERT INTO supplier_payments (org_id, bill_id, amount, date, method, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, bill.id, amount, date, method, ref, req.user.id, nowISO())).lastInsertRowid);
    entry = await accounting().recordEntry(req.org, req.user.id, { journal, date, label: `Règlement fournisseur ${v.supplier_name} ${v.supplier_ref}`.trim().slice(0, 200), piece: ref || v.supplier_ref || v.number,
      lines: [{ account: '401', debit: amount, memo: v.supplier_name }, { account: acct, credit: amount, memo: ref }], source: 'supplier_payment', sourceId: pid });
    await db.prepare('UPDATE supplier_payments SET acc_entry_id = ? WHERE id = ?').run(entry.id, pid);
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Règlement de ${fmt(amount)} FCFA : facture ${v.number} (${v.supplier_name})`);
  res.status(201).json({ id: pid, entry: entry.number, balance: left - amount });
});

module.exports = router;
