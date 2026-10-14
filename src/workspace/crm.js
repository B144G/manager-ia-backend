'use strict';
// Sous-application « Clients et ventes » : fiches clients, devis et factures, paiements reçus, impayés.
// Les devis/factures sont réservés aux responsables et plus ; les fiches clients sont ouvertes à toute l'équipe.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });

const customerOf = (req, id) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!c || !A.visible(req, c)) throw new HttpError(404, 'Client introuvable.');
  return c;
};
const docOf = (req, id) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!d || !A.visible(req, d)) throw new HttpError(404, 'Document introuvable.');
  return d;
};
const today = () => nowISO().slice(0, 10);

/** Lignes validées : [{label, quantity, price}] ; le total est TOUJOURS recalculé ici. */
function cleanLines(v) {
  if (!Array.isArray(v) || !v.length || v.length > 40) throw new HttpError(400, 'Ajoutez au moins une ligne (40 au plus).');
  const lines = v.map((l) => ({ label: A.text(l && l.label, 150, { required: true, msg: 'Chaque ligne doit avoir un libellé.' }), quantity: A.qty(l.quantity === undefined || l.quantity === '' ? 1 : l.quantity), price: A.amount(l.price) }));
  return { lines, total: lines.reduce((a, l) => a + Math.round(l.quantity * l.price), 0) };
}

/** Un document « en retard » : facture envoyée, non soldée, échéance dépassée. */
const isOverdue = (d) => d.kind === 'invoice' && d.status === 'sent' && d.paid < d.total && d.due && d.due < today();

const view = (d, extra = {}) => ({ id: d.id, kind: d.kind, number: d.number, status: d.status, total: d.total, paid: d.paid, balance: d.kind === 'invoice' ? Math.max(d.total - d.paid, 0) : undefined, issued: d.issued, due: d.due, note: d.note, customerId: d.customer_id, overdue: isOverdue(d), lines: JSON.parse(d.lines), ...extra });

// ---------- Clients ----------
router.get('/customers', (req, res) => {
  const sc = A.scope(req, 'c.branch_id');
  const rows = db.prepare(`SELECT c.*, COALESCE((SELECT SUM(total - paid) FROM documents d WHERE d.customer_id = c.id AND d.kind = 'invoice' AND d.status = 'sent'), 0) AS owed,
      (SELECT COUNT(*) FROM documents d WHERE d.customer_id = c.id AND d.kind = 'invoice') AS invoices FROM customers c WHERE c.org_id = ?${sc.sql} ORDER BY c.name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  res.json({ customers: rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, notes: c.notes, stage: c.stage, source: c.source, branchId: c.branch_id, owed: A.can(req, 'manager') ? c.owed : undefined, invoices: A.can(req, 'manager') ? c.invoices : undefined })) });
});

router.post('/customers', (req, res) => {
  const b = req.body || {};
  const id = db.prepare('INSERT INTO customers (org_id, branch_id, name, phone, email, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, A.branchOf(req, b.branchId === undefined ? req.member.branch_id : b.branchId), A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du client.' }), A.text(b.phone, 40), A.text(b.email, 120), A.text(b.notes, 800), nowISO()).lastInsertRowid;
  A.logActivity(req.org.id, req.user.id, 'crm', `Client « ${A.text(b.name, 100)} » ajouté`);
  res.status(201).json({ id: Number(id) });
});

router.put('/customers/:id', (req, res) => {
  const c = customerOf(req, req.params.id);
  const b = req.body || {};
  db.prepare('UPDATE customers SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?').run(b.name === undefined ? c.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du client.' }),
    b.phone === undefined ? c.phone : A.text(b.phone, 40), b.email === undefined ? c.email : A.text(b.email, 120), b.notes === undefined ? c.notes : A.text(b.notes, 800), c.id);
  res.json({ ok: true });
});

router.delete('/customers/:id', A.need('manager'), (req, res) => {
  const c = customerOf(req, req.params.id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(c.id); // supprime aussi ses devis et factures
  res.json({ ok: true });
});

router.get('/customers/:id', A.need('manager'), (req, res) => {
  const c = customerOf(req, req.params.id);
  const docs = db.prepare('SELECT * FROM documents WHERE customer_id = ? ORDER BY id DESC LIMIT 50').all(c.id).map((d) => view(d));
  res.json({ customer: { id: c.id, name: c.name, phone: c.phone, email: c.email, notes: c.notes }, documents: docs });
});

// ---------- Devis et factures (responsables et plus) ----------
router.get('/documents', A.need('manager'), (req, res) => {
  const kind = req.query.kind === undefined ? null : A.oneOf(req.query.kind, ['quote', 'invoice']);
  const sc = A.scope(req, 'd.branch_id');
  const rows = db.prepare(`SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ?${kind ? ' AND d.kind = ?' : ''}${sc.sql} ORDER BY d.id DESC LIMIT 100`).all(req.org.id, ...(kind ? [kind] : []), ...sc.args);
  const all = db.prepare("SELECT * FROM documents WHERE org_id = ? AND kind = 'invoice'").all(req.org.id).filter((d) => A.visible(req, d));
  const month = today().slice(0, 7);
  res.json({
    documents: rows.map((d) => view(d, { customer: d.customer })),
    summary: {
      owed: all.filter((d) => d.status === 'sent').reduce((a, d) => a + d.total - d.paid, 0),
      overdue: all.filter(isOverdue).reduce((a, d) => a + d.total - d.paid, 0), overdueCount: all.filter(isOverdue).length,
      invoicedMonth: all.filter((d) => d.status !== 'draft' && d.status !== 'cancelled' && d.issued.startsWith(month)).reduce((a, d) => a + d.total, 0),
      paidMonth: all.filter((d) => d.issued.startsWith(month)).reduce((a, d) => a + d.paid, 0),
    },
  });
});

function nextNumber(orgId, kind) {
  const n = db.prepare('SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = ?').get(orgId, kind).c + 1;
  return `${{ quote: 'D', invoice: 'F', order: 'C' }[kind] || 'F'}-${today().slice(0, 4)}-${String(n).padStart(4, '0')}`;
}

function createDoc(req, b, kind) {
  const c = customerOf(req, b.customerId);
  const { lines, total } = cleanLines(b.lines);
  const now = nowISO();
  const id = db.prepare('INSERT INTO documents (org_id, branch_id, customer_id, kind, number, status, lines, total, issued, due, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, c.branch_id, c.id, kind, nextNumber(req.org.id, kind), 'draft', JSON.stringify(lines), total, A.date(b.issued) || today(), A.date(b.due), A.text(b.note, 500), req.user.id, now, now).lastInsertRowid;
  A.logActivity(req.org.id, req.user.id, 'crm', `${kind === 'quote' ? 'Devis' : 'Facture'} créé(e) pour ${c.name}`);
  return Number(id);
}

router.post('/documents', A.need('manager'), (req, res) => {
  const b = req.body || {};
  res.status(201).json({ id: createDoc(req, b, A.oneOf(b.kind, ['quote', 'invoice'], undefined, 'Choisissez devis ou facture.')) });
});

router.put('/documents/:id', A.need('manager'), (req, res) => {
  const d = docOf(req, req.params.id);
  const b = req.body || {};
  if (b.lines !== undefined) {
    if (d.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être modifié dans ses lignes.');
    const { lines, total } = cleanLines(b.lines);
    db.prepare('UPDATE documents SET lines = ?, total = ? WHERE id = ?').run(JSON.stringify(lines), total, d.id);
  }
  if (b.due !== undefined) db.prepare('UPDATE documents SET due = ? WHERE id = ?').run(A.date(b.due), d.id);
  if (b.note !== undefined) db.prepare('UPDATE documents SET note = ? WHERE id = ?').run(A.text(b.note, 500), d.id);
  if (b.status !== undefined) {
    const allowed = d.kind === 'quote' ? ['draft', 'sent', 'accepted', 'refused'] : ['draft', 'sent', 'cancelled'];
    const st = A.oneOf(b.status, allowed, undefined, 'Statut inconnu.');
    if (d.kind === 'invoice' && d.status === 'paid') throw new HttpError(400, 'Une facture payée ne peut plus changer de statut.');
    if (d.kind === 'invoice' && st === 'draft' && d.paid > 0) throw new HttpError(400, 'Cette facture a déjà reçu un paiement.');
    db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(st, d.id);
  }
  db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(nowISO(), d.id);
  res.json({ ok: true });
});

router.delete('/documents/:id', A.need('manager'), (req, res) => {
  const d = docOf(req, req.params.id);
  if (d.status !== 'draft' && !A.can(req, 'admin')) throw new HttpError(403, 'Seul un administrateur peut supprimer un document déjà envoyé.');
  if (d.paid > 0) throw new HttpError(400, 'Ce document a reçu des paiements : annulez-le plutôt que de le supprimer.');
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

// Un devis accepté devient une facture (brouillon) avec les mêmes lignes.
router.post('/documents/:id/convert', A.need('manager'), (req, res) => {
  const d = docOf(req, req.params.id);
  if (d.kind !== 'quote' || d.status !== 'accepted') throw new HttpError(400, 'Seul un devis accepté peut devenir une facture.');
  const id = createDoc(req, { customerId: d.customer_id, lines: JSON.parse(d.lines).map((l) => ({ label: l.label, quantity: l.quantity, price: l.price })), note: `Suite au devis ${d.number}`, due: req.body && req.body.due }, 'invoice');
  res.status(201).json({ id });
});

// Paiement reçu : met à jour le solde, solde la facture si tout est payé, et (par défaut) inscrit l'entrée d'argent au budget.
router.post('/documents/:id/payments', A.need('manager'), (req, res) => {
  const d = docOf(req, req.params.id);
  if (d.kind !== 'invoice' || !['sent', 'draft'].includes(d.status)) throw new HttpError(400, 'Les paiements se saisissent sur une facture envoyée.');
  if (d.status === 'draft') throw new HttpError(400, "Marquez d'abord la facture comme envoyée.");
  const amount = A.amount((req.body || {}).amount);
  if (d.paid + amount > d.total) throw new HttpError(400, `Ce paiement dépasse le solde (${d.total - d.paid}).`);
  const paid = d.paid + amount;
  db.transaction(() => {
    db.prepare('UPDATE documents SET paid = ?, status = ?, updated_at = ? WHERE id = ?').run(paid, paid >= d.total ? 'paid' : 'sent', nowISO(), d.id);
    if ((req.body || {}).toBudget !== false) {
      db.prepare("INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, ?, 'income', 'Ventes', ?, ?, ?, ?, ?)")
        .run(req.org.id, d.branch_id, `Paiement ${d.number}`, amount, today(), req.user.id, nowISO());
    }
  })();
  A.logActivity(req.org.id, req.user.id, 'crm', `Paiement reçu sur ${d.number}`);
  res.json({ paid, status: paid >= d.total ? 'paid' : 'sent' });
});

/** Résumé pour l'IA et les alertes. */
function overdueList(req) {
  return db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'sent' AND d.due IS NOT NULL AND d.due < ? AND d.paid < d.total ORDER BY d.due").all(req.org.id, today()).filter((d) => A.visible(req, d));
}

module.exports = router;
module.exports.overdueList = overdueList;
module.exports.createDoc = createDoc;
module.exports.nextNumber = nextNumber;
