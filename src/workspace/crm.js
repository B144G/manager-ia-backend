'use strict';
// Sous-application « Clients et ventes » : fiches clients, devis et factures, paiements reçus, avoirs, impayés.
// Les devis/factures sont réservés aux responsables et plus ; les fiches clients sont ouvertes à toute l'équipe.
// Facture : HT, taux et montant de TVA (par défaut celui de l'organisation, 19,25 %), NIU, numérotation par séquence (sans trou ni doublon),
// mode et référence de chaque paiement (espèces, virement, MTN Mobile Money, Orange Money, chèque), avoirs, page imprimable, e-mail, lien WhatsApp.
// Ce sont des « documents de travail » : à faire valider par un expert-comptable avant tout usage légal ou fiscal.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const D = require('./invoice-doc');
const limits = require('../middleware/limits');
const { sendMail, mailEnabled } = require('../services/notify');
const { amap, afilter, HttpError, asyncHandler, isEmail, oneLine, log } = require('../util');

const router = express.Router({ mergeParams: true });

const customerOf = async (req, id) => {
  const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!c || !A.visible(req, c)) throw new HttpError(404, 'Client introuvable.');
  return c;
};
const docOf = async (req, id) => {
  const d = await db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!d || !A.visible(req, d)) throw new HttpError(404, 'Document introuvable.');
  return d;
};
const today = () => nowISO().slice(0, 10);
const METHODS = Object.keys(D.METHODS);
const NEEDS_REF = ['transfer', 'mtn_momo', 'orange_money', 'cheque'];
const MOBILE = { mtn_momo: 'MTN', orange_money: 'Orange' };

/** Lignes validées : [{label, quantity, price}] ; les totaux sont TOUJOURS recalculés ici (jamais ceux envoyés par l'écran). */
function cleanLines(v) {
  if (!Array.isArray(v) || !v.length || v.length > 40) throw new HttpError(400, 'Ajoutez au moins une ligne (40 au plus).');
  return v.map((l) => ({ label: A.text(l && l.label, 150, { required: true, msg: 'Chaque ligne doit avoir un libellé.' }), quantity: A.qty(l.quantity === undefined || l.quantity === '' ? 1 : l.quantity), price: Number(l.price) < 0 && /^Remise/i.test(String(l.label || '')) ? -A.amount(-Number(l.price)) : A.amount(l.price) })); // seule une ligne « Remise… » (code promo) peut être négative
}
const vatRate = (v, def) => {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (!Number.isFinite(n) || n < 0 || n > 30) throw new HttpError(400, 'Taux de TVA invalide (0 à 30 %).');
  return Math.round(n * 1000) / 1000;
};
const bool = (v, def) => (v === undefined || v === null || v === '' ? def : v === true || v === 1 || v === '1' || v === 'true');

/** Un document « en retard » : facture envoyée, non soldée, échéance dépassée. */
const isOverdue = (d) => d.kind === 'invoice' && d.status === 'sent' && d.paid < d.total - d.credited && d.due && d.due < today();
const balanceOf = (d) => Math.max(d.total - d.credited - d.paid, 0);

const view = (d, extra = {}, org) => {
  const a = D.amounts(d, org || { vat_rate: 19.25 });
  return {
    id: d.id, kind: d.kind, number: d.number, status: d.status, total: d.total, paid: d.paid, credited: d.credited, balance: d.kind === 'invoice' ? balanceOf(d) : undefined,
    refundDue: d.kind === 'invoice' && d.paid > d.total - d.credited ? d.paid - (d.total - d.credited) : undefined,
    subtotalHt: a.ht, vatRate: a.rate, vatAmount: a.vat, pricesIncl: Number(d.prices_incl) === 1, creditOf: d.credit_of, creditReason: d.credit_reason || undefined,
    issued: d.issued, due: d.due, note: d.note, customerId: d.customer_id, promoCode: d.promo_code || undefined, discount: Number(d.discount || 0) || undefined, overdue: isOverdue(d), lines: JSON.parse(d.lines), ...extra,
  };
};

// ---------- Réglages de facturation (mentions légales, NIU, TVA) ----------
const settingsView = (o) => ({ niu: o.niu, rccm: o.rccm, address: o.address, payInfo: o.pay_info, footer: o.invoice_footer, vatRate: Number(o.vat_rate), currency: o.currency, methods: D.METHODS });
router.get('/invoice-settings', A.need('manager'), (req, res) => res.json(settingsView(req.org)));
router.put('/invoice-settings', A.need('admin'), async (req, res) => {
  const b = req.body || {}; const o = req.org;
  const pick = (k, col, max) => (b[k] === undefined ? o[col] : A.text(b[k], max));
  await db.prepare('UPDATE orgs SET niu = ?, rccm = ?, address = ?, pay_info = ?, invoice_footer = ?, vat_rate = ? WHERE id = ?').run(pick('niu', 'niu', 40), pick('rccm', 'rccm', 60), pick('address', 'address', 300), pick('payInfo', 'pay_info', 600), pick('footer', 'invoice_footer', 600), b.vatRate === undefined ? o.vat_rate : vatRate(b.vatRate, o.vat_rate), o.id);
  await A.logActivity(o.id, req.user.id, 'crm', 'Mentions et TVA des factures modifiées');
  res.json({ ok: true });
});

// ---------- Clients ----------
router.get('/customers', async (req, res) => {
  const sc = A.scope(req, 'c.branch_id');
  const rows = await db.prepare(`SELECT c.*, COALESCE((SELECT SUM(total - credited - paid) FROM documents d WHERE d.customer_id = c.id AND d.kind = 'invoice' AND d.status = 'sent'), 0) AS owed,
      (SELECT COUNT(*) FROM documents d WHERE d.customer_id = c.id AND d.kind = 'invoice') AS invoices FROM customers c WHERE c.org_id = ?${sc.sql} ORDER BY c.name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  res.json({ customers: rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, notes: c.notes, niu: c.niu, address: c.address, stage: c.stage, source: c.source, branchId: c.branch_id, owed: A.can(req, 'manager') ? c.owed : undefined, invoices: A.can(req, 'manager') ? c.invoices : undefined })) });
});

router.post('/customers', async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO customers (org_id, branch_id, name, phone, email, notes, niu, address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, await A.branchOf(req, b.branchId === undefined ? req.member.branch_id : b.branchId), A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du client.' }), A.text(b.phone, 40), A.text(b.email, 120), A.text(b.notes, 800), A.text(b.niu, 40), A.text(b.address, 300), nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'crm', `Client « ${A.text(b.name, 100)} » ajouté`);
  require('../services/webhooks').emit(req.org.id, 'customer.created', { id: Number(id), name: A.text(b.name, 100) });
  res.status(201).json({ id: Number(id) });
});

router.put('/customers/:id', async (req, res) => {
  const c = await customerOf(req, req.params.id);
  const b = req.body || {};
  await db.prepare('UPDATE customers SET name = ?, phone = ?, email = ?, notes = ?, niu = ?, address = ? WHERE id = ?').run(b.name === undefined ? c.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du client.' }),
    b.phone === undefined ? c.phone : A.text(b.phone, 40), b.email === undefined ? c.email : A.text(b.email, 120), b.notes === undefined ? c.notes : A.text(b.notes, 800),
    b.niu === undefined ? c.niu : A.text(b.niu, 40), b.address === undefined ? c.address : A.text(b.address, 300), c.id);
  res.json({ ok: true });
});

router.delete('/customers/:id', A.need('manager'), async (req, res) => {
  const c = await customerOf(req, req.params.id);
  // Une facture émise ne disparaît pas avec le client (numérotation continue, pièces comptables).
  const issued = (await db.prepare("SELECT COUNT(*) c FROM documents WHERE customer_id = ? AND kind IN ('invoice','credit') AND status <> 'draft'").get(c.id)).c;
  if (issued) throw new HttpError(409, `Ce client a ${issued} facture(s) ou avoir(s) émis : ils doivent être conservés. Modifiez la fiche plutôt que de la supprimer.`);
  await db.prepare('DELETE FROM documents WHERE customer_id = ?').run(c.id);
  await db.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

router.get('/customers/:id', A.need('manager'), async (req, res) => {
  const c = await customerOf(req, req.params.id);
  const docs = await amap(await db.prepare('SELECT * FROM documents WHERE customer_id = ? ORDER BY id DESC LIMIT 50').all(c.id), (d) => view(d, {}, req.org));
  res.json({ customer: { id: c.id, name: c.name, phone: c.phone, email: c.email, notes: c.notes, niu: c.niu, address: c.address }, documents: docs });
});

// ---------- Devis et factures (responsables et plus) ----------
router.get('/documents', A.need('manager'), async (req, res) => {
  const kind = req.query.kind === undefined ? null : A.oneOf(req.query.kind, ['quote', 'invoice', 'credit']);
  const sc = A.scope(req, 'd.branch_id');
  const rows = await db.prepare(`SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ?${kind ? ' AND d.kind = ?' : ''}${sc.sql} ORDER BY d.id DESC LIMIT 100`).all(req.org.id, ...(kind ? [kind] : []), ...sc.args);
  const all = (await db.prepare("SELECT * FROM documents WHERE org_id = ? AND kind = 'invoice'").all(req.org.id)).filter((d) => A.visible(req, d));
  const month = today().slice(0, 7);
  res.json({
    documents: await amap(rows, (d) => view(d, { customer: d.customer }, req.org)),
    summary: {
      owed: all.filter((d) => d.status === 'sent').reduce((a, d) => a + balanceOf(d), 0),
      overdue: all.filter(isOverdue).reduce((a, d) => a + balanceOf(d), 0), overdueCount: all.filter(isOverdue).length,
      invoicedMonth: all.filter((d) => d.status !== 'draft' && d.status !== 'cancelled' && d.issued.startsWith(month)).reduce((a, d) => a + d.total, 0),
      paidMonth: all.filter((d) => d.issued.startsWith(month)).reduce((a, d) => a + d.paid, 0),
      creditedMonth: all.filter((d) => d.issued.startsWith(month)).reduce((a, d) => a + d.credited, 0),
    },
  });
});

/**
 * Numéro suivant, par organisation, type et année, depuis une séquence : sans trou ni doublon (même en cas de demandes simultanées, et
 * le compteur est annulé avec la transaction si la création échoue). À appeler dans la transaction qui insère le document.
 */
async function nextNumber(orgId, kind) {
  const year = today().slice(0, 4);
  const row = await db.prepare('INSERT INTO doc_sequences (org_id, kind, year, last) VALUES (?, ?, ?, 1) ON CONFLICT (org_id, kind, year) DO UPDATE SET last = doc_sequences.last + 1 RETURNING last').get(orgId, kind, year);
  return `${{ quote: 'D', invoice: 'F', order: 'C', credit: 'AV' }[kind] || 'F'}-${year}-${String(row.last).padStart(4, '0')}`;
}

async function createDoc(req, b, kind, extra = {}) {
  const c = await customerOf(req, b.customerId);
  const lines = cleanLines(b.lines);
  const rate = b.vatRate !== undefined ? vatRate(b.vatRate, Number(req.org.vat_rate)) : extra.vatRate !== undefined ? extra.vatRate : Number(req.org.vat_rate);
  const incl = kind === 'order' ? true : bool(b.pricesIncl, extra.pricesIncl !== undefined ? extra.pricesIncl : true);
  const t = D.totals(lines, rate, incl);
  const now = nowISO();
  return await db.transaction(async () => {
    const id = (await db.prepare('INSERT INTO documents (org_id, branch_id, customer_id, kind, number, status, lines, total, issued, due, note, created_by, created_at, updated_at, vat_rate, prices_incl, subtotal_ht, vat_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.org.id, c.branch_id, c.id, kind, await nextNumber(req.org.id, kind), extra.status || 'draft', JSON.stringify(lines), t.total, A.date(b.issued) || today(), A.date(b.due), A.text(b.note, 500), req.user.id, now, now, rate, incl ? 1 : 0, t.ht, t.vat)).lastInsertRowid;
    await A.logActivity(req.org.id, req.user.id, 'crm', `${kind === 'quote' ? 'Devis' : kind === 'credit' ? 'Avoir' : 'Facture'} créé(e) pour ${c.name}`);
    if (kind === 'invoice') require('../services/webhooks').emit(req.org.id, 'invoice.created', { id: Number(id), customer: c.name, total: t.total });
    return Number(id);
  })();
}

router.post('/documents', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  res.status(201).json({ id: await createDoc(req, b, A.oneOf(b.kind, ['quote', 'invoice'], undefined, 'Choisissez devis ou facture.')) });
});

router.put('/documents/:id', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  const b = req.body || {};
  if (d.kind === 'credit') throw new HttpError(400, "Un avoir émis ne se modifie pas : émettez un autre avoir ou contactez l'administrateur.");
  if (b.lines !== undefined || b.vatRate !== undefined || b.pricesIncl !== undefined) {
    if (d.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être modifié dans ses lignes ou sa TVA.');
    const lines = b.lines !== undefined ? cleanLines(b.lines) : JSON.parse(d.lines);
    const rate = vatRate(b.vatRate, d.vat_rate === null ? Number(req.org.vat_rate) : Number(d.vat_rate));
    const incl = bool(b.pricesIncl, Number(d.prices_incl) === 1);
    const t = D.totals(lines, rate, incl);
    await db.prepare('UPDATE documents SET lines = ?, total = ?, vat_rate = ?, prices_incl = ?, subtotal_ht = ?, vat_amount = ? WHERE id = ?').run(JSON.stringify(lines), t.total, rate, incl ? 1 : 0, t.ht, t.vat, d.id);
  }
  if (b.due !== undefined) await db.prepare('UPDATE documents SET due = ? WHERE id = ?').run(A.date(b.due), d.id);
  if (b.note !== undefined) await db.prepare('UPDATE documents SET note = ? WHERE id = ?').run(A.text(b.note, 500), d.id);
  if (b.status !== undefined) {
    const allowed = d.kind === 'quote' ? ['draft', 'sent', 'accepted', 'refused'] : ['draft', 'sent', 'cancelled'];
    const st = A.oneOf(b.status, allowed, undefined, 'Statut inconnu.');
    if (d.kind === 'invoice' && ['paid', 'credited'].includes(d.status)) throw new HttpError(400, 'Une facture payée ou soldée par avoir ne peut plus changer de statut.');
    if (d.kind === 'invoice' && st === 'draft' && (d.paid > 0 || d.credited > 0)) throw new HttpError(400, 'Cette facture a déjà reçu un paiement ou un avoir.');
    if (d.kind === 'invoice' && st === 'cancelled' && d.paid > 0) throw new HttpError(400, 'Cette facture a reçu un paiement : émettez un avoir pour l\'annuler.');
    await db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(st, d.id);
  }
  await db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(nowISO(), d.id);
  res.json({ ok: true });
});

router.delete('/documents/:id', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  if (d.status !== 'draft' && !A.can(req, 'admin')) throw new HttpError(403, 'Seul un administrateur peut supprimer un document déjà envoyé.');
  if (d.paid > 0) throw new HttpError(400, 'Ce document a reçu des paiements : annulez-le plutôt que de le supprimer.');
  if (d.credited > 0 || d.kind === 'credit') throw new HttpError(400, 'Un avoir ou une facture avec avoir ne se supprime pas (pièce comptable).');
  await db.transaction(async () => {
    // Facture : on ne supprime qu'un brouillon portant le DERNIER numéro de la séquence (sinon trou dans la numérotation) ; la séquence recule alors d'un cran.
    if (d.kind === 'invoice') {
      const m = /^[A-Z]+-(\d{4})-(\d+)$/.exec(d.number);
      if (d.status !== 'draft') throw new HttpError(400, 'Une facture émise ne se supprime pas (numérotation continue) : annulez-la, ou émettez un avoir.');
      if (m) {
        const seq = await db.prepare('SELECT last FROM doc_sequences WHERE org_id = ? AND kind = ? AND year = ?').get(req.org.id, 'invoice', m[1]);
        if (seq && Number(m[2]) !== seq.last) throw new HttpError(400, "Pour garder une numérotation continue, cette facture ne peut pas être supprimée : annulez-la à la place.");
        if (seq) await db.prepare('UPDATE doc_sequences SET last = last - 1 WHERE org_id = ? AND kind = ? AND year = ?').run(req.org.id, 'invoice', m[1]);
      }
    }
    await db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  })();
  res.json({ ok: true });
});

// Un devis accepté devient une facture (brouillon) avec les mêmes lignes et la même TVA.
router.post('/documents/:id/convert', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  if (d.kind !== 'quote' || d.status !== 'accepted') throw new HttpError(400, 'Seul un devis accepté peut devenir une facture.');
  const id = await createDoc(req, { customerId: d.customer_id, lines: JSON.parse(d.lines).map((l) => ({ label: l.label, quantity: l.quantity, price: l.price })), note: `Suite au devis ${d.number}`, due: req.body && req.body.due }, 'invoice',
    { vatRate: d.vat_rate === null ? undefined : Number(d.vat_rate), pricesIncl: Number(d.prices_incl) === 1 });
  res.status(201).json({ id });
});

// ---------- Paiements ----------
const payView = (p) => ({ id: p.id, amount: Number(p.amount), date: p.date, method: p.method, methodLabel: D.METHODS[p.method] || '', reference: p.reference, operator: p.operator, payerPhone: p.payer_phone, status: p.status, note: p.note });

/** Met à jour le solde et le statut d'une facture après un paiement confirmé ou un avoir. */
async function settle(d, paid, credited) {
  const due = d.total - credited;
  const status = paid > 0 && paid >= due ? 'paid' : paid === 0 && credited >= d.total ? 'credited' : 'sent';
  await db.prepare('UPDATE documents SET paid = ?, credited = ?, status = ?, updated_at = ? WHERE id = ?').run(paid, credited, status, nowISO(), d.id);
  return status;
}

/** Valide la saisie d'un paiement (mode, référence, opérateur, statut). */
function cleanPayment(b) {
  const method = b.method === undefined || b.method === '' || b.method === null ? '' : A.oneOf(b.method, METHODS, undefined, 'Mode de paiement inconnu (espèces, virement, MTN Mobile Money, Orange Money, chèque).');
  const reference = A.text(b.reference, 80);
  if (NEEDS_REF.includes(method) && !reference) throw new HttpError(400, method === 'cheque' ? 'Indiquez le numéro du chèque.' : method === 'transfer' ? 'Indiquez la référence du virement.' : "Indiquez la référence de la transaction (reçue par SMS du fournisseur de mobile money).");
  const status = A.oneOf(b.status, ['confirmed', 'pending'], 'confirmed', 'Statut de paiement inconnu.');
  if (status === 'pending' && !NEEDS_REF.includes(method)) throw new HttpError(400, "Un paiement « à vérifier » doit avoir une référence : choisissez virement, chèque ou mobile money.");
  const phone = A.text(b.payerPhone, 30);
  if (phone && !/^[+\d\s().-]{6,30}$/.test(phone)) throw new HttpError(400, 'Numéro de téléphone du payeur invalide.');
  return { method, reference, status, phone, operator: MOBILE[method] || '', note: A.text(b.note, 200) };
}

router.get('/documents/:id/payments', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  res.json({ payments: (await db.prepare('SELECT * FROM doc_payments WHERE doc_id = ? ORDER BY date, id').all(d.id)).map(payView), methods: D.METHODS });
});

/** Enregistre un paiement confirmé : solde, statut, budget, webhook. */
async function applyPayment(req, d, amount, row) {
  const paid = d.paid + amount;
  let status;
  await db.transaction(async () => {
    status = await settle(d, paid, d.credited);
    // Ligne « miroir » (source = facture) : quand la facture est en comptabilité, le budget lit la compta et ignore cette ligne (une seule source de vérité).
    await db.prepare("INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at, source, source_id) VALUES (?, ?, 'income', 'Ventes', ?, ?, ?, ?, ?, 'invoice', ?)").run(req.org.id, d.branch_id, `Paiement ${d.number}`, amount, today(), req.user.id, nowISO(), d.id);
  })();
  require('../services/webhooks').emit(req.org.id, 'payment.received', { invoice_id: d.id, number: d.number, amount, paid, total: d.total, status, method: row.method, reference: row.reference });
  if (status === 'paid') require('../services/webhooks').emit(req.org.id, 'invoice.paid', { invoice_id: d.id, number: d.number, total: d.total });
  return { paid, status };
}

// Paiement reçu : met à jour le solde, solde la facture si tout est payé, et (par défaut) inscrit l'entrée d'argent au budget.
// Mobile money / virement / chèque : la référence de la transaction est obligatoire (une même référence ne peut servir deux fois) ;
// « status: pending » enregistre une référence à vérifier SANS toucher au solde, jusqu'à confirmation.
router.post('/documents/:id/payments', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  if (d.kind !== 'invoice' || !['sent', 'draft'].includes(d.status)) throw new HttpError(400, 'Les paiements se saisissent sur une facture envoyée.');
  if (d.status === 'draft') throw new HttpError(400, "Marquez d'abord la facture comme envoyée.");
  const b = req.body || {};
  const amount = A.amount(b.amount);
  const p = cleanPayment(b);
  if (d.paid + amount > d.total - d.credited) throw new HttpError(400, `Ce paiement dépasse le solde (${balanceOf(d)}).`);
  if (p.reference && await db.prepare("SELECT 1 FROM doc_payments WHERE org_id = ? AND method = ? AND reference = ? AND status <> 'failed'").get(req.org.id, p.method, p.reference)) throw new HttpError(409, 'Cette référence de transaction est déjà enregistrée sur un paiement.');
  const row = { method: p.method, reference: p.reference };
  const pid = (await db.prepare('INSERT INTO doc_payments (org_id, doc_id, amount, date, created_by, created_at, method, reference, operator, payer_phone, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, d.id, amount, A.date(b.date) || today(), req.user.id, nowISO(), p.method, p.reference, p.operator, p.phone, p.status, p.note)).lastInsertRowid;
  if (p.status === 'pending') { await A.logActivity(req.org.id, req.user.id, 'crm', `Paiement à vérifier sur ${d.number}`); return res.status(201).json({ id: Number(pid), pending: true, paid: d.paid, status: d.status }); }
  const r = b.toBudget === false ? await db.transaction(async () => ({ paid: d.paid + amount, status: await settle(d, d.paid + amount, d.credited) }))() : await applyPayment(req, d, amount, row);
  if (b.toBudget === false) require('../services/webhooks').emit(req.org.id, 'payment.received', { invoice_id: d.id, number: d.number, amount, paid: r.paid, total: d.total, status: r.status, method: p.method, reference: p.reference });
  await A.logActivity(req.org.id, req.user.id, 'crm', `Paiement reçu sur ${d.number}`);
  res.json({ id: Number(pid), paid: r.paid, status: r.status });
});

// Confirmer (la référence a été vérifiée chez l'opérateur ou la banque) ou rejeter un paiement « à vérifier ».
router.post('/documents/:id/payments/:pid/:action(confirm|reject)', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  const p = await db.prepare('SELECT * FROM doc_payments WHERE id = ? AND doc_id = ?').get(A.id(req.params.pid), d.id);
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  if (p.status !== 'pending') throw new HttpError(400, 'Ce paiement a déjà été traité.');
  if (req.params.action === 'reject') {
    await db.prepare("UPDATE doc_payments SET status = 'failed' WHERE id = ?").run(p.id);
    await A.logActivity(req.org.id, req.user.id, 'crm', `Paiement rejeté sur ${d.number}`);
    return res.json({ ok: true });
  }
  if (d.paid + Number(p.amount) > d.total - d.credited) throw new HttpError(400, `Ce paiement dépasse le solde (${balanceOf(d)}).`);
  await db.prepare("UPDATE doc_payments SET status = 'confirmed' WHERE id = ?").run(p.id);
  const r = await applyPayment(req, d, Number(p.amount), p);
  await A.logActivity(req.org.id, req.user.id, 'crm', `Paiement confirmé sur ${d.number}`);
  res.json({ paid: r.paid, status: r.status });
});

// ---------- Avoirs (notes de crédit) ----------
/** Écriture comptable inverse de la vente (si la comptabilité est utilisée) ; en cas d'échec (période clôturée…), l'avoir reste « à comptabiliser ». */
async function postCreditEntry(req, cn, customerName) {
  if (!await db.prepare('SELECT 1 FROM acc_entries WHERE org_id = ? LIMIT 1').get(req.org.id)) return false;
  const a = D.amounts(cn, req.org);
  const lines = [{ account: '701', debit: a.ht }];
  if (a.vat > 0) lines.push({ account: '4431', debit: a.vat });
  lines.push({ account: '411', credit: a.total, memo: customerName });
  try {
    await require('./accounting').recordEntry(req.org, req.user.id, { journal: 'VT', date: cn.issued, label: `Avoir ${cn.number} - ${customerName}`, piece: cn.number, lines, source: 'credit_note', sourceId: cn.id });
    return true;
  } catch (e) { log.warn('Avoir : écriture non passée :', oneLine(e.message, 160)); return false; }
}

router.post('/documents/:id/credit-note', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  if (d.kind !== 'invoice' || !['sent', 'paid'].includes(d.status)) throw new HttpError(400, 'Un avoir se rattache à une facture envoyée ou payée.');
  const b = req.body || {};
  const reason = A.text(b.reason, 300, { required: true, msg: "Indiquez le motif de l'avoir (retour, erreur de facturation, remise…)." });
  const lines = b.lines === undefined ? JSON.parse(d.lines) : cleanLines(b.lines);
  if (b.lines === undefined && d.credited > 0) throw new HttpError(400, 'Cette facture a déjà un avoir : indiquez les lignes à créditer.');
  const rate = d.vat_rate === null ? Number(req.org.vat_rate) : Number(d.vat_rate);
  const incl = Number(d.prices_incl) === 1;
  const t = D.totals(lines, rate, incl);
  if (t.total > d.total - d.credited) throw new HttpError(400, `L'avoir (${t.total}) dépasse ce qui peut encore être crédité sur cette facture (${d.total - d.credited}).`);
  let cnId;
  await db.transaction(async () => {
    cnId = await createDoc(req, { customerId: d.customer_id, lines, note: A.text(b.note, 500), vatRate: rate, pricesIncl: incl }, 'credit', { status: 'sent', vatRate: rate, pricesIncl: incl });
    await db.prepare('UPDATE documents SET credit_of = ?, credit_reason = ? WHERE id = ?').run(d.id, reason, cnId);
    // Après un avoir, le montant dû baisse ; si l'argent a déjà été encaissé, la facture reste « payée » et la différence est à rembourser.
    await settle(d, d.paid, d.credited + t.total);
  })();
  const cn = await db.prepare('SELECT * FROM documents WHERE id = ?').get(cnId);
  const cust = await db.prepare('SELECT name FROM customers WHERE id = ?').get(d.customer_id);
  const posted = await postCreditEntry(req, cn, cust.name);
  await A.logActivity(req.org.id, req.user.id, 'crm', `Avoir ${cn.number} sur la facture ${d.number}`);
  res.status(201).json({ id: cnId, number: cn.number, total: t.total, accountingPosted: posted });
});

// ---------- Impression, e-mail, WhatsApp ----------
router.get('/documents/:id/print', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  res.json(await D.printData(req, d));
});

// Lien WhatsApp (wa.me) avec un message prêt : rien n'est envoyé automatiquement, la personne appuie sur Envoyer dans WhatsApp.
router.get('/documents/:id/share', A.need('manager'), async (req, res) => {
  const d = await docOf(req, req.params.id);
  const p = await D.printData(req, d);
  const digits = String(p.customer.phone || '').replace(/\D/g, '').replace(/^00/, '');
  const message = D.shareText(p);
  res.json({ phone: digits, message, url: digits.length >= 8 ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null,
    warning: digits.length < 8 ? "Ajoutez le numéro de téléphone du client (avec l'indicatif du pays) pour générer le lien." : digits.length <= 9 ? "Vérifiez que le numéro commence par l'indicatif du pays (ex. 237 pour le Cameroun), sinon WhatsApp ne le trouvera pas." : '' });
});

// E-mail au client : texte + page HTML imprimable en pièce jointe. Mêmes garde-fous que le module E-mails (client enregistré, quota par jour, journal).
router.post('/documents/:id/email', A.need('manager'), limits.make(60 * 1000, 8, 'Vous envoyez trop vite. Patientez une minute.'), asyncHandler(async (req, res) => {
  if (!mailEnabled()) throw new HttpError(503, "L'envoi d'e-mails n'est pas encore activé sur ce serveur.");
  const d = await docOf(req, req.params.id);
  if (d.status === 'draft') throw new HttpError(400, "Marquez d'abord le document comme envoyé.");
  const cu = await customerOf(req, d.customer_id);
  if (!isEmail(cu.email)) throw new HttpError(400, `${cu.name} n'a pas d'adresse e-mail : ajoutez-la sur sa fiche.`);
  const lim = A.limitsFor(await A.ownerPlan(req.org)).emailDay;
  const used = (await db.prepare("SELECT COUNT(*) c FROM outbox WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(req.org.id, `${nowISO().slice(0, 10)}T00:00:00.000Z`)).c;
  if (used >= lim) throw new HttpError(429, `Limite de ${lim} e-mails par jour atteinte pour votre offre. Réessayez demain.`);
  const p = await D.printData(req, d);
  const b = req.body || {};
  const label = D.KIND_LABEL[d.kind] || 'Document';
  const subject = oneLine(A.text(b.subject, 150) || `${label} ${d.number} - ${req.org.name}`, 150);
  const body = A.text(b.message, 3000) || D.shareText(p);
  const owner = await db.prepare('SELECT contact FROM users WHERE id = ?').get(req.org.owner_id);
  const replyTo = [req.user.contact, owner && owner.contact].find((c) => isEmail(c));
  const fname = `${label.toLowerCase()}-${d.number}.html`;
  let status = 'sent'; let error = '';
  try { await sendMail({ to: cu.email, subject, text: `${body}\n\n—\n${req.org.name}\nMessage envoyé avec Brij-IA`, replyTo, fromName: req.org.name, attachments: [{ filename: fname, content: Buffer.from(D.html(p), 'utf8'), contentType: 'text/html; charset=utf-8' }] }); } catch (e) { status = 'failed'; error = oneLine(e.message, 200); log.warn('E-mail de facture non envoyé :', error); }
  await db.prepare('INSERT INTO outbox (org_id, user_id, customer_id, to_email, subject, body, attachments, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, req.user.id, cu.id, cu.email, subject, body, JSON.stringify([fname]), status, error, nowISO());
  if (status === 'failed') throw new HttpError(502, "Le message n'a pas pu partir. Vérifiez l'adresse e-mail du client puis réessayez.");
  await A.logActivity(req.org.id, req.user.id, 'crm', `${label} ${d.number} envoyé(e) par e-mail à ${cu.name}`);
  res.json({ ok: true });
}));

/** Résumé pour l'IA et les alertes. */
async function overdueList(req) {
  return (await db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'sent' AND d.due IS NOT NULL AND d.due < ? AND d.paid < d.total - d.credited ORDER BY d.due").all(req.org.id, today())).filter((d) => A.visible(req, d));
}

module.exports = router;
module.exports.overdueList = overdueList;
module.exports.createDoc = createDoc;
module.exports.nextNumber = nextNumber;
