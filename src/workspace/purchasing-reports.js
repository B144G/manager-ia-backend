'use strict';
// Achats (5/5) : tableau de bord (dépenses, engagements, économies, délais), budgets par catégorie, exports CSV.
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const P = require('./purchasing-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const NO_CAT = 'Sans catégorie';

function yearParam(v) {
  const y = String(v || P.yearOf());
  if (!/^\d{4}$/.test(y) || Number(y) < 2000 || Number(y) > 2100) return P.yearOf();
  return y;
}
const days = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000;

/** Factures validées de l'année, avec fournisseur, catégorie (celle de la commande) et totaux. */
async function approvedInvoices(orgId, y) {
  const rows = await db.prepare(`SELECT i.*, s.name AS supplier, o.category AS cat, o.number AS order_number FROM pur_invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN pur_orders o ON o.id = i.order_id
    WHERE i.org_id = ? AND i.status = 'approved' AND SUBSTR(i.invoice_date, 1, 4) = ? ORDER BY i.invoice_date`).all(orgId, y);
  for (const i of rows) i.t = await P.invoiceTotalsOf(i);
  return rows;
}
async function yearOrders(orgId, y) {
  const rows = await db.prepare(`SELECT o.*, s.name AS supplier FROM pur_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND o.status NOT IN ('draft','cancelled') AND SUBSTR(o.order_date, 1, 4) = ? ORDER BY o.order_date`).all(orgId, y);
  for (const o of rows) o.t = await P.orderTotalsOf(o);
  return rows;
}
async function deliveries(orgId, orders) {
  let onTime = 0; let timed = 0; const leads = [];
  for (const o of orders) {
    const r = await db.prepare('SELECT MIN(date) AS first, MAX(date) AS last FROM pur_receipts WHERE order_id = ?').get(o.id);
    if (r && r.first) leads.push(Math.max(0, days(o.order_date, r.first)));
    if (o.expected_date && ['received', 'closed'].includes(o.status) && r && r.last) { timed++; if (r.last <= o.expected_date) onTime++; }
  }
  const late = await db.prepare(`SELECT o.*, s.name AS supplier FROM pur_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND o.status IN ('approved','sent','partial') AND o.expected_date IS NOT NULL AND o.expected_date < ? ORDER BY o.expected_date`).all(orgId, P.today());
  return {
    avgLeadDays: leads.length ? Math.round((leads.reduce((a, b) => a + b, 0) / leads.length) * 10) / 10 : null,
    onTimeRate: timed ? Math.round((onTime / timed) * 100) : null,
    lateOpen: late.map((o) => ({ id: Number(o.id), number: o.number, supplier: o.supplier, expectedDate: o.expected_date, daysLate: Math.round(days(o.expected_date, P.today())) })),
  };
}
async function savingsOf(orgId, y) {
  const rows = await db.prepare(`SELECT r.*, s.name AS supplier FROM pur_rfqs r LEFT JOIN suppliers s ON s.id = r.awarded_supplier_id WHERE r.org_id = ? AND r.status = 'awarded' AND SUBSTR(COALESCE(r.awarded_at, r.created_at), 1, 4) = ? ORDER BY r.id DESC`).all(orgId, y);
  const items = rows.map((r) => ({ id: Number(r.id), number: r.number, title: r.title, supplier: r.supplier || '', baseline: r.baseline === null ? null : Number(r.baseline), awardedTotal: Number(r.awarded_total) || 0, savings: Number(r.savings) || 0 }));
  return { total: items.reduce((s, x) => s + x.savings, 0), items };
}
async function toPayOf(orgId) {
  let toPay = 0;
  for (const i of await db.prepare("SELECT * FROM pur_invoices WHERE org_id = ? AND status = 'approved'").all(orgId)) {
    const paid = Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM pur_payments WHERE invoice_id = ?').get(i.id)).s);
    toPay += Math.max(0, (await P.invoiceTotalsOf(i)).ttc - paid);
  }
  return toPay;
}
async function engagedTotal(orgId) {
  let engaged = 0;
  for (const o of await db.prepare("SELECT * FROM pur_orders WHERE org_id = ? AND status IN ('approved','sent','partial','received')").all(orgId)) {
    let done = 0;
    for (const i of await db.prepare("SELECT * FROM pur_invoices WHERE order_id = ? AND status = 'approved'").all(o.id)) done += (await P.invoiceTotalsOf(i)).ttc;
    engaged += Math.max(0, (await P.orderTotalsOf(o)).ttc - done);
  }
  return engaged;
}
const groupSum = (rows, key, val) => { const m = new Map(); for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + val(r)); } return [...m.entries()]; };

router.get('/dashboard', mgr, async (req, res) => {
  const y = yearParam((req.query || {}).year);
  const inv = await approvedInvoices(req.org.id, y);
  const orders = await yearOrders(req.org.id, y);
  const byMonth = Array.from({ length: 12 }, (_, k) => { const m = `${y}-${String(k + 1).padStart(2, '0')}`; return { month: m, invoicedTtc: inv.filter((i) => i.invoice_date.slice(0, 7) === m).reduce((s, i) => s + i.t.ttc, 0) }; });
  res.json({
    year: Number(y),
    spend: { totalTtc: inv.reduce((s, i) => s + i.t.ttc, 0), ordered: orders.reduce((s, o) => s + o.t.ttc, 0) },
    commitments: { engaged: await engagedTotal(req.org.id), toPay: await toPayOf(req.org.id) },
    savings: await savingsOf(req.org.id, y),
    deliveries: await deliveries(req.org.id, orders),
    bySupplier: groupSum(inv, (i) => i.supplier, (i) => i.t.ttc).map(([name, totalTtc]) => ({ name, totalTtc })).sort((a, b) => b.totalTtc - a.totalTtc),
    byCategory: groupSum(inv, (i) => i.cat || NO_CAT, (i) => i.t.ttc).map(([category, totalTtc]) => ({ category, totalTtc })).sort((a, b) => b.totalTtc - a.totalTtc),
    byMonth,
  });
});

router.get('/budget', mgr, async (req, res) => {
  const y = yearParam((req.query || {}).year);
  const cats = new Map();
  const add = (c) => { const s = String(c || '').trim(); if (s && !cats.has(s.toLowerCase())) cats.set(s.toLowerCase(), s); };
  for (const r of await db.prepare("SELECT category FROM budget_annual WHERE org_id = ? AND year = ? AND kind = 'expense'").all(req.org.id, y)) add(r.category);
  for (const r of await db.prepare("SELECT DISTINCT category FROM pur_orders WHERE org_id = ? AND category != '' AND SUBSTR(order_date, 1, 4) = ?").all(req.org.id, y)) add(r.category);
  const out = [];
  for (const c of cats.values()) {
    const planned = await P.plannedOf(req.org.id, c, y);
    const u = await P.usedOf(req.org.id, c, y);
    const used = u.engaged + u.invoiced;
    out.push({ category: c, planned, engaged: u.engaged, invoiced: u.invoiced, available: planned === null ? 0 : planned - used, usedPct: planned ? Math.round((used / planned) * 1000) / 10 : 0, over: planned !== null && used > planned });
  }
  res.json({ year: Number(y), categories: out.sort((a, b) => a.category.localeCompare(b.category, 'fr')) });
});

// ---------- Exports CSV (séparateur « ; », lisible par Excel) ----------
router.get('/export', mgr, async (req, res) => {
  const q = req.query || {};
  const y = yearParam(q.year);
  const kind = String(q.kind || '');
  let rows;
  if (kind === 'suppliers') rows = [['Fournisseur', 'Facturé TTC'], ...groupSum(await approvedInvoices(req.org.id, y), (i) => i.supplier, (i) => i.t.ttc).sort((a, b) => b[1] - a[1])];
  else if (kind === 'categories') rows = [['Catégorie', 'Facturé TTC'], ...groupSum(await approvedInvoices(req.org.id, y), (i) => i.cat || NO_CAT, (i) => i.t.ttc)];
  else if (kind === 'months') { const inv = await approvedInvoices(req.org.id, y); rows = [['Mois', 'Facturé TTC'], ...Array.from({ length: 12 }, (_, k) => { const m = `${y}-${String(k + 1).padStart(2, '0')}`; return [m, inv.filter((i) => i.invoice_date.slice(0, 7) === m).reduce((s, i) => s + i.t.ttc, 0)]; })]; }
  else if (kind === 'orders') rows = [['Numéro', 'Date', 'Fournisseur', 'Catégorie', 'Statut', 'Livraison prévue', 'Total HT', 'TVA', 'Total TTC'], ...(await yearOrders(req.org.id, y)).map((o) => [o.number, o.order_date, o.supplier, o.category, o.status, o.expected_date || '', o.t.ht, o.t.vat, o.t.ttc])];
  else if (kind === 'invoices') rows = [['Numéro', 'Référence fournisseur', 'Date', 'Échéance', 'Fournisseur', 'Commande', 'Total HT', 'TVA', 'Total TTC'], ...(await approvedInvoices(req.org.id, y)).map((i) => [i.number, i.supplier_ref, i.invoice_date, i.due_date, i.supplier, i.order_number || '', i.t.ht, i.t.vat, i.t.ttc])];
  else if (kind === 'late') rows = [['Numéro', 'Fournisseur', 'Livraison prévue', 'Jours de retard'], ...(await deliveries(req.org.id, [])).lateOpen.map((o) => [o.number, o.supplier, o.expectedDate, o.daysLate])];
  else if (kind === 'rfqs') rows = [['Numéro', 'Objet', 'Fournisseur retenu', 'Référence', 'Montant retenu', 'Économie'], ...(await savingsOf(req.org.id, y)).items.map((r) => [r.number, r.title, r.supplier, r.baseline === null ? '' : r.baseline, r.awardedTotal, r.savings])];
  else throw new HttpError(400, 'Export inconnu.');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="achats-${kind}-${y}.csv"` });
  res.send(P.csv(rows));
});

module.exports = router;
