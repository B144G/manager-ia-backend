'use strict';
// Achats (3/5) : factures fournisseurs. Rapprochement à trois (commande, réception, facture) avec tolérances ; validation pour paiement
// par un administrateur (écriture d'achat au journal AC) ; règlements (banque, mobile money, caisse) ; annulation de la validation tant que rien n'est payé.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const P = require('./purchasing-lib');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const admin = A.need('admin');
const acc = () => require('./accounting');

/** Clé d'origine unique de l'écriture (la comptabilité refuse deux écritures de même origine) : « pur_invoice », puis « pur_invoice#2 »… après une annulation. */
async function sourceKey(orgId, base, id) {
  const n = Number((await db.prepare("SELECT COUNT(*) AS c FROM acc_entries WHERE org_id = ? AND source_id = ? AND (source = ? OR source LIKE ?)").get(orgId, id, base, base + '#%')).c);
  return n ? `${base}#${n + 1}` : base;
}

const ISSUE_TEXT = {
  no_order: () => 'Facture sans bon de commande : vérifiez qui a commandé.',
  duplicate: (x) => `Doublon possible : la facture ${x.ref} de ce fournisseur est déjà saisie (${x.number}).`,
  order_status: () => "Le bon de commande n'est pas approuvé (ou a été annulé).",
  vat_gap: (x) => `Taux de TVA différent de la commande (${x.invoice} % au lieu de ${x.order} %).`,
  extra_line: (x) => `« ${x.d} » ne figure pas sur la commande.`,
  not_received: (x) => `« ${x.d} » : ${x.q} facturé(s) pour ${x.r} reçu(s).`,
  over_ordered: (x) => `« ${x.d} » : ${x.q} facturé(s) pour ${x.o} commandé(s).`,
  price_gap: (x) => `« ${x.d} » : prix facturé ${x.p} au lieu de ${x.op} (commande).`,
  total_mismatch: (x) => `Le total annoncé (${x.declared}) ne correspond pas au total calculé (${x.computed}).`,
};
const issue = (code, x = {}) => ({ code, message: ISSUE_TEXT[code](x) });

async function invoiceOf(req, idv) {
  const i = await db.prepare('SELECT * FROM pur_invoices WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!i) throw new HttpError(404, 'Facture fournisseur introuvable.');
  return i;
}
const linesOf = (id) => db.prepare('SELECT * FROM pur_invoice_lines WHERE invoice_id = ? ORDER BY position, id').all(id);
const paidOf = async (id) => Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM pur_payments WHERE invoice_id = ?').get(id)).s);

/** Rapprochement : renvoie { issues, matching } (sans rien enregistrer). */
async function match(req, inv, lines) {
  const s = await P.settingsOf(req.org);
  const issues = []; const matching = [];
  const o = inv.order_id ? await db.prepare('SELECT * FROM pur_orders WHERE id = ?').get(inv.order_id) : null;
  if (!o) issues.push(issue('no_order'));
  const dup = await db.prepare("SELECT number FROM pur_invoices WHERE org_id = ? AND supplier_id = ? AND LOWER(supplier_ref) = LOWER(?) AND status != 'cancelled' AND id != ? LIMIT 1").get(req.org.id, inv.supplier_id, inv.supplier_ref, inv.id || 0);
  if (dup) issues.push(issue('duplicate', { ref: inv.supplier_ref, number: dup.number }));
  const state = o ? Object.fromEntries((await P.orderLineState(o.id, inv.id)).map((l) => [Number(l.id), l])) : {};
  if (o) {
    if (!['approved', 'sent', 'partial', 'received', 'closed'].includes(o.status)) issues.push(issue('order_status'));
    if (Math.abs(Number(o.vat_rate) - Number(inv.vat_rate)) > 0.001) issues.push(issue('vat_gap', { invoice: Number(inv.vat_rate), order: Number(o.vat_rate) }));
  }
  const tq = 1 + s.tolQtyPct / 100;
  const fmt = (n) => `${Math.round(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} ${req.org.currency || 'FCFA'}`;
  for (const l of lines) {
    const q = Number(l.quantity); const p = Number(l.unit_price);
    const ol = l.order_line_id ? state[Number(l.order_line_id)] : null;
    if (!ol) {
      if (o) issues.push(issue('extra_line', { d: l.description }));
      matching.push({ description: l.description, quantity: q, unitPrice: p });
      continue;
    }
    const total = P.round3(ol.invoiced + q);
    if (total > P.round3(ol.received * tq) + 1e-9) issues.push(issue('not_received', { d: l.description, q: total, r: ol.received }));
    if (total > P.round3(ol.quantity * tq) + 1e-9) issues.push(issue('over_ordered', { d: l.description, q: total, o: ol.quantity }));
    if (Math.abs(p - ol.unit_price) > ol.unit_price * s.tolPricePct / 100 + 1e-9) issues.push(issue('price_gap', { d: l.description, p: fmt(p), op: fmt(ol.unit_price) }));
    matching.push({ description: l.description, ordered: ol.quantity, received: ol.received, invoicedBefore: ol.invoiced, quantity: q, unitPrice: p, orderPrice: ol.unit_price });
  }
  const t = P.orderTotals(lines, inv.vat_rate);
  if (inv.declared_total !== null && inv.declared_total !== undefined && Math.abs(Number(inv.declared_total) - t.ttc) > s.tolAmount) issues.push(issue('total_mismatch', { declared: fmt(inv.declared_total), computed: fmt(t.ttc) }));
  return { issues, matching, totals: t };
}
async function rematch(req, inv) {
  const r = await match(req, inv, await linesOf(inv.id));
  const status = r.issues.length ? 'blocked' : 'matched';
  // Jamais sur une facture validée ou annulée (un rapprochement simultané ne la ramène pas « à valider »).
  await db.prepare("UPDATE pur_invoices SET status = ?, issues = ?, updated_at = ? WHERE id = ? AND status IN ('entered','matched','blocked')").run(status, JSON.stringify(r.issues), nowISO(), inv.id);
  return { status, ...r };
}

// ---------- Saisie ----------
async function readInvoice(req, b, cur) {
  const supplierRef = cleanText(String(b.supplierRef || ''), 60);
  if (!supplierRef) throw new HttpError(400, 'Indiquez le numéro de la facture du fournisseur.');
  const invoiceDate = P.dateOrNull(b.invoiceDate) || P.today();
  if (invoiceDate > P.today()) throw new HttpError(400, 'La date de la facture ne peut pas être dans le futur.');
  let order = null; let supplierId;
  if (cur) { order = cur.order_id ? await db.prepare('SELECT * FROM pur_orders WHERE id = ?').get(cur.order_id) : null; supplierId = Number(cur.supplier_id); } else {
    if (b.orderId !== undefined && b.orderId !== null && b.orderId !== '') {
      order = await db.prepare('SELECT * FROM pur_orders WHERE id = ? AND org_id = ?').get(A.id(b.orderId), req.org.id);
      if (!order) throw new HttpError(404, 'Bon de commande introuvable.');
      supplierId = Number(order.supplier_id);
    } else {
      const s = await db.prepare('SELECT id FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(b.supplierId, 'Choisissez le fournisseur.'), req.org.id);
      if (!s) throw new HttpError(400, 'Fournisseur introuvable.');
      supplierId = Number(s.id);
    }
  }
  const sup = await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  const settings = await P.settingsOf(req.org);
  const terms = order ? Number(order.payment_days) : sup && sup.payment_days !== null ? Number(sup.payment_days) : settings.defaultTermsDays;
  const dueDate = P.dateOrNull(b.dueDate) || P.addDays(invoiceDate, terms);
  const vatRate = b.vatRate === undefined || b.vatRate === null || b.vatRate === '' ? (order ? Number(order.vat_rate) : Number(req.org.vat_rate) || 0) : P.pct(b.vatRate);
  const declared = b.declaredTotal === undefined || b.declaredTotal === null || b.declaredTotal === '' ? null : P.money(b.declaredTotal, 'Total annoncé invalide.');
  const account = String(b.expenseAccount || '601').trim();
  if (!/^[2-6]\d{1,5}$/.test(account)) throw new HttpError(400, 'Compte de charge invalide (ex. 601, 605, 622).');
  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (!raw.length) throw new HttpError(400, 'Ajoutez au moins une ligne.');
  if (raw.length > 200) throw new HttpError(400, 'Trop de lignes (200 au plus).');
  const valid = order ? Object.fromEntries((await db.prepare('SELECT * FROM pur_order_lines WHERE order_id = ?').all(order.id)).map((l) => [Number(l.id), l])) : {};
  const lines = raw.map((l) => {
    const x = l || {};
    const olId = x.orderLineId !== undefined && x.orderLineId !== null && x.orderLineId !== '' ? A.id(x.orderLineId) : null;
    if (olId && !valid[olId]) throw new HttpError(400, 'Ligne de commande inconnue.');
    const description = cleanText(String(x.description || ''), 200) || (olId ? valid[olId].description : '');
    if (!description) throw new HttpError(400, "Chaque ligne a besoin d'une désignation.");
    return { order_line_id: olId, description, quantity: P.qtyOf(x.quantity), unit_price: P.money(x.unitPrice, 'Prix invalide.') };
  });
  return { order, supplierId, supplierRef, invoiceDate, dueDate, vatRate, declared, account, notes: cleanText(String(b.notes || ''), 500), lines };
}
async function saveLines(id, lines) {
  await db.prepare('DELETE FROM pur_invoice_lines WHERE invoice_id = ?').run(id);
  let pos = 0;
  for (const l of lines) await db.prepare('INSERT INTO pur_invoice_lines (invoice_id, order_line_id, description, quantity, unit_price, position) VALUES (?, ?, ?, ?, ?, ?)').run(id, l.order_line_id, l.description, l.quantity, l.unit_price, pos++);
}
router.post('/invoices', mgr, async (req, res) => {
  const v = await readInvoice(req, req.body || {});
  const now = nowISO();
  const out = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'FF', v.invoiceDate);
    const id = Number((await db.prepare(`INSERT INTO pur_invoices (org_id, number, supplier_id, order_id, supplier_ref, invoice_date, due_date, vat_rate, declared_total, expense_account, notes, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'entered', ?, ?, ?)`).run(req.org.id, number, v.supplierId, v.order ? v.order.id : null, v.supplierRef, v.invoiceDate, v.dueDate, v.vatRate, v.declared, v.account, v.notes, req.user.id, now, now)).lastInsertRowid);
    await saveLines(id, v.lines);
    const r = await rematch(req, await db.prepare('SELECT * FROM pur_invoices WHERE id = ?').get(id));
    return { id, number, status: r.status };
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Facture fournisseur ${out.number} saisie`);
  res.status(201).json(out);
});
router.put('/invoices/:id', mgr, async (req, res) => {
  const i = await invoiceOf(req, req.params.id);
  if (!['entered', 'matched', 'blocked'].includes(i.status)) throw new HttpError(400, 'Cette facture ne se modifie plus.');
  const v = await readInvoice(req, req.body || {}, i);
  const out = await db.transaction(async () => {
    if (!['entered', 'matched', 'blocked'].includes((await P.lockRow('pur_invoices', i.id)).status)) throw new HttpError(400, 'Cette facture ne se modifie plus.');
    await db.prepare('UPDATE pur_invoices SET supplier_ref = ?, invoice_date = ?, due_date = ?, vat_rate = ?, declared_total = ?, expense_account = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(v.supplierRef, v.invoiceDate, v.dueDate, v.vatRate, v.declared, v.account, v.notes, nowISO(), i.id);
    await saveLines(i.id, v.lines);
    return rematch(req, await invoiceOf(req, i.id));
  })();
  res.json({ ok: true, status: out.status });
});
router.post('/invoices/:id/match', mgr, async (req, res) => {
  const i = await invoiceOf(req, req.params.id);
  if (!['entered', 'matched', 'blocked'].includes(i.status)) throw new HttpError(400, 'Cette facture est déjà validée pour paiement.');
  const r = await db.transaction(async () => {
    if (!['entered', 'matched', 'blocked'].includes((await P.lockRow('pur_invoices', i.id)).status)) throw new HttpError(400, 'Cette facture est déjà validée pour paiement.');
    return rematch(req, i);
  })();
  res.json({ ok: true, status: r.status, issues: r.issues });
});

// ---------- Lecture ----------
const payStatus = (i, paid, ttc) => (i.status !== 'approved' ? undefined : paid <= 0 ? 'unpaid' : paid >= ttc ? 'paid' : 'partial');
router.get('/invoices', mgr, async (req, res) => {
  const status = String((req.query || {}).status || '').trim();
  const rows = await db.prepare('SELECT i.*, s.name AS supplier, o.number AS order_number FROM pur_invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN pur_orders o ON o.id = i.order_id WHERE i.org_id = ? ORDER BY i.id DESC LIMIT 1000').all(req.org.id);
  const counts = {}; let toPay = 0; let overdue = 0; const out = [];
  for (const i of rows) {
    counts[i.status] = (counts[i.status] || 0) + 1;
    const t = await P.invoiceTotalsOf(i); const paid = i.status === 'approved' ? await paidOf(i.id) : 0;
    if (i.status === 'approved') { const bal = Math.max(0, t.ttc - paid); toPay += bal; if (bal > 0 && i.due_date < P.today()) overdue++; }
    if (status && i.status !== status) continue;
    let issues = []; try { issues = JSON.parse(i.issues); } catch { issues = []; }
    out.push({ id: Number(i.id), number: i.number, supplier: i.supplier, supplierRef: i.supplier_ref, invoiceDate: i.invoice_date, dueDate: i.due_date, orderNumber: i.order_number || null, issues, totalTtc: t.ttc, status: i.status, paymentStatus: payStatus(i, paid, t.ttc) });
  }
  res.json({ invoices: out, counts, toPay, overdue });
});
router.get('/invoices/:id', mgr, async (req, res) => {
  const i = await invoiceOf(req, req.params.id);
  const s = await db.prepare('SELECT name FROM suppliers WHERE id = ?').get(i.supplier_id);
  const o = i.order_id ? await db.prepare('SELECT number FROM pur_orders WHERE id = ?').get(i.order_id) : null;
  const lines = await linesOf(i.id);
  const m = await match(req, i, lines);
  const pays = await db.prepare('SELECT * FROM pur_payments WHERE invoice_id = ? ORDER BY date, id').all(i.id);
  const paid = pays.reduce((x, p) => x + Number(p.amount), 0);
  const entry = i.entry_id ? await db.prepare('SELECT number FROM acc_entries WHERE id = ?').get(i.entry_id) : null;
  let issues = []; try { issues = JSON.parse(i.issues); } catch { issues = []; }
  const METHOD = { bank: 'Virement bancaire', mobile: 'Mobile money', cash: 'Espèces' };
  res.json({ invoice: {
    id: Number(i.id), number: i.number, supplier: s ? s.name : '', supplierId: Number(i.supplier_id), supplierRef: i.supplier_ref, orderId: i.order_id ? Number(i.order_id) : null, orderNumber: o ? o.number : null,
    invoiceDate: i.invoice_date, dueDate: i.due_date, vatRate: Number(i.vat_rate), declaredTotal: i.declared_total === null ? null : Number(i.declared_total), expenseAccount: i.expense_account, notes: i.notes,
    status: i.status, paymentStatus: payStatus(i, paid, m.totals.ttc), entry: entry ? entry.number : null,
    issues: i.status === 'approved' || i.status === 'cancelled' ? issues : m.issues, overrideReason: i.override_reason || null,
    matching: m.matching,
    lines: lines.map((l) => ({ orderLineId: l.order_line_id ? Number(l.order_line_id) : null, description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price) })),
    totalHt: m.totals.ht, vatAmount: m.totals.vat, totalTtc: m.totals.ttc,
    payments: pays.map((p) => ({ id: Number(p.id), date: p.date, method: METHOD[p.method] || p.method, reference: p.reference || null, amount: Number(p.amount) })),
    balance: Math.max(0, m.totals.ttc - paid), paid, canPay: i.status === 'approved' && paid < m.totals.ttc && A.can(req, 'admin'),
  } });
});

// ---------- Validation pour paiement (administrateur) ----------
router.post('/invoices/:id/approve', admin, async (req, res) => {
  const i0 = await invoiceOf(req, req.params.id);
  const b = req.body || {};
  const reason = cleanText(String(b.overrideReason || ''), 500);
  // Tout sous verrou : une modification, un rapprochement ou une seconde validation simultanés ne passent pas (une seule écriture, sur les lignes validées).
  const { i, r, out } = await db.transaction(async () => {
    const i = await P.lockRow('pur_invoices', i0.id);
    if (i.status === 'approved') throw new HttpError(400, 'Cette facture est déjà validée pour paiement.');
    if (!['entered', 'matched', 'blocked'].includes(i.status)) throw new HttpError(400, 'Cette facture est annulée.');
    const r = await rematch(req, i);
    if (r.status === 'blocked' && !(b.override && reason)) return { i, r, out: null };
    const s = await db.prepare('SELECT name FROM suppliers WHERE id = ?').get(i.supplier_id);
    const t = r.totals;
    const lines = [{ account: i.expense_account, debit: t.ht, memo: `Facture ${i.supplier_ref}` }];
    if (t.vat) lines.push({ account: '4452', debit: t.vat, memo: 'TVA récupérable' });
    lines.push({ account: '401', credit: t.ttc, memo: s ? s.name : 'Fournisseur' });
    const e = await acc().recordEntry(req.org, req.user.id, { journal: 'AC', date: i.invoice_date, label: `Facture ${i.supplier_ref} - ${s ? s.name : ''}`.slice(0, 200), piece: i.number, lines: lines.filter((l) => (l.debit || l.credit) > 0), source: await sourceKey(req.org.id, 'pur_invoice', i.id), sourceId: i.id });
    await db.prepare("UPDATE pur_invoices SET status = 'approved', override_reason = ?, entry_id = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(r.status === 'blocked' ? reason : '', e.id, req.user.id, nowISO(), nowISO(), i.id);
    return { i, r, out: e };
  })();
  // Le nouveau statut du rapprochement (« bloquée ») reste enregistré : l'erreur est levée après la transaction.
  if (!out) throw new HttpError(400, 'Le rapprochement a relevé des anomalies : corrigez la facture ou validez malgré tout avec un motif.');
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Facture ${i.number} validée pour paiement${r.status === 'blocked' ? ' malgré les anomalies' : ''}`);
  res.json({ ok: true, entry: out.number });
});
router.post('/invoices/:id/unapprove', admin, async (req, res) => {
  const i0 = await invoiceOf(req, req.params.id);
  const reason = cleanText(String((req.body || {}).reason || ''), 500);
  await db.transaction(async () => {
    // Sous verrou (comme le paiement) : un règlement enregistré au même moment empêche l'annulation.
    const i = await P.lockRow('pur_invoices', i0.id);
    if (i.status !== 'approved') throw new HttpError(400, "Cette facture n'est pas validée.");
    if (await paidOf(i.id) > 0) throw new HttpError(400, 'Un règlement a déjà été enregistré : la validation ne peut plus être annulée.');
    if (!reason) throw new HttpError(400, 'Indiquez le motif.');
    if (i.entry_id) await acc().reverseEntry(req.org, req.user.id, i.entry_id, P.today(), { source: await sourceKey(req.org.id, 'pur_invoice_cancel', i.id), sourceId: i.id });
    await db.prepare("UPDATE pur_invoices SET status = 'entered', entry_id = NULL, approved_by = NULL, approved_at = NULL, override_reason = '', notes = ?, updated_at = ? WHERE id = ?").run(`${i.notes ? i.notes + '\n' : ''}Validation annulée : ${reason}`.slice(0, 1000), nowISO(), i.id);
    await rematch(req, await invoiceOf(req, i.id));
  })();
  res.json({ ok: true });
});
const MODES = { bank: ['521', 'BQ'], mobile: ['589', 'MM'], cash: ['571', 'CA'] };
router.post('/invoices/:id/pay', admin, async (req, res) => {
  const i0 = await invoiceOf(req, req.params.id);
  const b = req.body || {};
  let balance; let amount;
  const e = await db.transaction(async () => {
    // Reste à payer relu sous verrou : un double envoi ne paie jamais deux fois.
    const i = await P.lockRow('pur_invoices', i0.id);
    if (i.status !== 'approved') throw new HttpError(400, "Validez d'abord la facture pour paiement.");
    const t = await P.invoiceTotalsOf(i);
    balance = t.ttc - await paidOf(i.id);
    if (balance <= 0) throw new HttpError(400, 'Cette facture est déjà payée.');
    amount = b.amount === undefined || b.amount === '' ? balance : P.money(b.amount, 'Montant invalide.');
    if (amount <= 0) throw new HttpError(400, 'Montant invalide.');
    if (amount > balance) throw new HttpError(400, 'Le montant dépasse le reste à payer.');
    const method = MODES[b.method] ? b.method : null;
    if (!method) throw new HttpError(400, 'Choisissez le mode de paiement.');
    const date = P.dateOrNull(b.date) || P.today();
    if (date > P.today()) throw new HttpError(400, 'La date du règlement ne peut pas être dans le futur.');
    const ref = cleanText(String(b.reference || ''), 80);
    const s = await db.prepare('SELECT name FROM suppliers WHERE id = ?').get(i.supplier_id);
    const [account, journal] = MODES[method];
    const pid = Number((await db.prepare('INSERT INTO pur_payments (org_id, invoice_id, date, method, reference, amount, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, i.id, date, method, ref, amount, req.user.id, nowISO())).lastInsertRowid);
    const x = await acc().recordEntry(req.org, req.user.id, { journal, date, label: `Règlement ${i.supplier_ref} - ${s ? s.name : ''}`.slice(0, 200), piece: ref || i.number, lines: [{ account: '401', debit: amount, memo: s ? s.name : 'Fournisseur' }, { account, credit: amount, memo: `Règlement ${i.number}` }], source: 'pur_payment', sourceId: pid });
    await db.prepare('UPDATE pur_payments SET entry_id = ? WHERE id = ?').run(x.id, pid);
    return x;
  })();
  res.json({ ok: true, entry: e.number, balance: balance - amount });
});
router.delete('/invoices/:id', mgr, async (req, res) => {
  const i = await invoiceOf(req, req.params.id);
  if (!['entered', 'matched', 'blocked'].includes(i.status)) throw new HttpError(400, i.status === 'approved' ? 'Annulez d\'abord la validation de cette facture.' : 'Cette facture est déjà annulée.');
  const c = await db.prepare("UPDATE pur_invoices SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('entered','matched','blocked')").run(nowISO(), i.id);
  if (!c.changes) throw new HttpError(400, 'Cette facture vient d\'être validée ou annulée : rechargez-la.');
  res.json({ ok: true });
});

module.exports = router;
