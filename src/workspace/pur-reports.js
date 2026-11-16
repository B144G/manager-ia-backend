'use strict';
// Achats · tableau de bord (dépenses par fournisseur, catégorie et mois ; délais de livraison réels ; retards ; économies des appels d'offres),
// budgets et engagements (lien avec le module Budget) et exports CSV.
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const W = require('./w3');
const P = require('./pur-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const yearOf = (v) => {
  const y = v === undefined || v === '' ? P.today().slice(0, 4) : String(v);
  if (!/^\d{4}$/.test(y) || Number(y) < 2000 || Number(y) > 2100) throw new HttpError(400, 'Année invalide.');
  return y;
};
const NOCAT = 'Non classé';

async function compute(req, year) {
  const o = req.org.id; const t = P.today();
  const inv = await db.prepare(`SELECT i.*, COALESCE(NULLIF(po.category, ''), NULLIF(sp.category, ''), ?) AS cat, s.name AS sname FROM pur_invoices i LEFT JOIN pur_orders po ON po.id = i.order_id LEFT JOIN pur_supplier_profiles sp ON sp.supplier_id = i.supplier_id LEFT JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.org_id = ? AND i.status = 'approved' AND substr(i.invoice_date, 1, 4) = ?`).all(NOCAT, o, year);
  const group = (keyFn, nameFn) => {
    const m = new Map();
    for (const v of inv) { const k = keyFn(v); const g = m.get(k) || { key: k, name: nameFn(v), count: 0, totalHt: 0, totalTtc: 0 }; g.count++; g.totalHt += Number(v.total_ht); g.totalTtc += Number(v.total_ttc); m.set(k, g); }
    return [...m.values()].sort((a, b) => b.totalTtc - a.totalTtc);
  };
  const bySupplier = group((v) => Number(v.supplier_id), (v) => v.sname || v.supplier_name).map((g) => ({ supplierId: g.key, name: g.name, count: g.count, totalHt: g.totalHt, totalTtc: g.totalTtc }));
  const byCategory = group((v) => v.cat, (v) => v.cat).map((g) => ({ category: g.name, count: g.count, totalHt: g.totalHt, totalTtc: g.totalTtc }));
  const months = Array.from({ length: 12 }, (_, i) => ({ month: `${year}-${String(i + 1).padStart(2, '0')}`, invoicedHt: 0, invoicedTtc: 0, orderedTtc: 0 }));
  for (const v of inv) { const m = months[Number(v.invoice_date.slice(5, 7)) - 1]; m.invoicedHt += Number(v.total_ht); m.invoicedTtc += Number(v.total_ttc); }
  const orders = await db.prepare("SELECT o.*, s.name AS sname FROM pur_orders o LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND o.status IN ('approved', 'sent', 'partial', 'received', 'closed') AND substr(o.order_date, 1, 4) = ?").all(o, year);
  for (const x of orders) months[Number(x.order_date.slice(5, 7)) - 1].orderedTtc += Number(x.total_ttc);

  // Délais de livraison réels et retards
  let leadSum = 0; let leadN = 0; let onTime = 0; let lateDone = 0; const lateOpen = [];
  for (const x of orders) {
    const rc = await db.prepare('SELECT MAX(receipt_date) AS last FROM pur_receipts WHERE order_id = ?').get(x.id);
    const lines = await db.prepare('SELECT quantity, received_qty FROM pur_order_lines WHERE order_id = ?').all(x.id);
    const complete = lines.length > 0 && lines.every((l) => Number(l.received_qty) + 1e-9 >= Number(l.quantity));
    const start = String(x.sent_at || x.approved_at || x.created_at).slice(0, 10);
    if (complete && rc.last) {
      leadSum += Math.max(P.daysBetween(start, rc.last), 0); leadN++;
      if (x.expected_date) { if (rc.last > x.expected_date) lateDone++; else onTime++; }
    } else if (['approved', 'sent', 'partial'].includes(x.status) && x.expected_date && x.expected_date < t) {
      lateOpen.push({ id: Number(x.id), number: x.number, supplier: x.sname || x.supplier_name, expectedDate: x.expected_date, daysLate: P.daysBetween(x.expected_date, t), status: x.status, totalTtc: Number(x.total_ttc) });
    }
  }
  lateOpen.sort((a, b) => b.daysLate - a.daysLate);
  const rf = await db.prepare("SELECT r.*, s.name AS sname FROM pur_rfqs r LEFT JOIN suppliers s ON s.id = r.awarded_supplier_id WHERE r.org_id = ? AND r.status = 'awarded' AND substr(r.closed_at, 1, 4) = ? ORDER BY r.id DESC").all(o, year);
  const eng = await db.prepare(`SELECT o.id, o.total_ttc, (SELECT COALESCE(SUM(i.total_ttc), 0) FROM pur_invoices i WHERE i.order_id = o.id AND i.status = 'approved') AS billed FROM pur_orders o WHERE o.org_id = ? AND o.status IN ('approved', 'sent', 'partial', 'received')`).all(o);
  const unpaid = await db.prepare("SELECT i.total_ttc, i.due_date, b.paid FROM pur_invoices i JOIN supplier_bills b ON b.id = i.bill_id WHERE i.org_id = ? AND i.status = 'approved' AND b.status IN ('open', 'partial')").all(o);
  const cnt = async (sql) => Number((await db.prepare(sql).get(o)).c);
  return {
    year, spend: { totalHt: inv.reduce((s, v) => s + Number(v.total_ht), 0), totalTtc: inv.reduce((s, v) => s + Number(v.total_ttc), 0), invoices: inv.length, ordered: orders.reduce((s, x) => s + Number(x.total_ttc), 0) },
    bySupplier, byCategory, byMonth: months,
    deliveries: { avgLeadDays: leadN ? Math.round((leadSum / leadN) * 10) / 10 : null, delivered: leadN, onTimeRate: onTime + lateDone > 0 ? Math.round((onTime / (onTime + lateDone)) * 100) : null, lateDelivered: lateDone, lateOpen },
    savings: { rfqs: rf.length, total: rf.reduce((s, r) => s + Number(r.savings), 0), baseline: rf.reduce((s, r) => s + Number(r.baseline), 0), awarded: rf.reduce((s, r) => s + Number(r.awarded_total), 0),
      items: rf.map((r) => ({ id: Number(r.id), number: r.number, title: r.title, supplier: r.sname || '', baseline: Number(r.baseline), awardedTotal: Number(r.awarded_total), savings: Number(r.savings) })) },
    commitments: { engaged: eng.reduce((s, x) => s + Math.max(Number(x.total_ttc) - Number(x.billed), 0), 0), toPay: unpaid.reduce((s, x) => s + Number(x.total_ttc) - Number(x.paid), 0), overdue: unpaid.filter((x) => x.due_date < t).length },
    pending: { requests: await cnt("SELECT COUNT(*) c FROM pur_requests WHERE org_id = ? AND status = 'submitted'"), orders: await cnt("SELECT COUNT(*) c FROM pur_orders WHERE org_id = ? AND status = 'draft'"), invoicesBlocked: await cnt("SELECT COUNT(*) c FROM pur_invoices WHERE org_id = ? AND status = 'blocked'"), invoicesToApprove: await cnt("SELECT COUNT(*) c FROM pur_invoices WHERE org_id = ? AND status = 'matched'"), rfqs: await cnt("SELECT COUNT(*) c FROM pur_rfqs WHERE org_id = ? AND status = 'open'") },
  };
}

router.get('/dashboard', async (req, res) => res.json(await compute(req, yearOf(req.query.year))));

// ---------- Budgets et engagements ----------
router.get('/budget', async (req, res) => {
  const year = yearOf(req.query.year);
  const o = req.org.id;
  const names = new Map();
  const add = (c) => { if (c && !names.has(c.toLowerCase())) names.set(c.toLowerCase(), c); };
  for (const r of await db.prepare("SELECT category FROM budget_annual WHERE org_id = ? AND year = ? AND kind = 'expense'").all(o, year)) add(r.category);
  for (const r of await db.prepare('SELECT category FROM budget_plans WHERE org_id = ?').all(o)) add(r.category);
  for (const r of await db.prepare("SELECT DISTINCT category FROM pur_orders WHERE org_id = ? AND category <> '' AND substr(order_date, 1, 4) = ?").all(o, year)) add(r.category);
  const rows = [];
  for (const c of names.values()) {
    const planned = await P.plannedOf(o, c, year);
    const s = await P.spentOf(o, c, year);
    const be = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM budget_entries WHERE org_id = ? AND kind = 'expense' AND LOWER(category) = LOWER(?) AND substr(date, 1, 4) = ?").get(o, c, year);
    const used = s.engaged + s.invoiced;
    rows.push({ category: c, planned, engaged: s.engaged, invoiced: s.invoiced, available: planned === null ? null : planned - used, usedPct: planned === null ? null : planned > 0 ? Math.round((used / planned) * 1000) / 10 : (used > 0 ? 999 : 0), over: planned !== null && used > planned, budgetEntries: Number(be.s) });
  }
  rows.sort((a, b) => (b.over - a.over) || ((b.usedPct || 0) - (a.usedPct || 0)));
  res.json({ year, categories: rows, alerts: rows.filter((r) => r.planned !== null && (r.over || r.usedPct >= 90)).length, note: "Engagé = bons de commande approuvés pas encore facturés ; facturé = factures fournisseurs validées. Les budgets viennent du module Budget." });
});
router.get('/categories', async (req, res) => {
  const set = new Set();
  for (const r of await db.prepare("SELECT category FROM budget_annual WHERE org_id = ? AND kind = 'expense'").all(req.org.id)) set.add(r.category);
  for (const r of await db.prepare('SELECT category FROM budget_plans WHERE org_id = ?').all(req.org.id)) set.add(r.category);
  for (const r of await db.prepare("SELECT DISTINCT category FROM pur_orders WHERE org_id = ? AND category <> ''").all(req.org.id)) set.add(r.category);
  res.json({ categories: [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr')) });
});

// ---------- Exports CSV ----------
const KINDS = ['suppliers', 'categories', 'months', 'orders', 'invoices', 'late', 'rfqs'];
router.get('/export', async (req, res) => {
  const kind = A.oneOf(req.query.kind, KINDS, undefined, 'Export inconnu (fournisseurs, catégories, mois, commandes, factures, retards ou appels d\'offres).');
  const year = yearOf(req.query.year);
  const d = await compute(req, year);
  const name = `achats-${kind}-${year}.csv`;
  if (kind === 'suppliers') return W.sendCsv(res, name, ['Fournisseur', 'Factures', 'Total HT', 'Total TTC'], d.bySupplier.map((x) => [x.name, x.count, x.totalHt, x.totalTtc]));
  if (kind === 'categories') return W.sendCsv(res, name, ['Catégorie', 'Factures', 'Total HT', 'Total TTC'], d.byCategory.map((x) => [x.category, x.count, x.totalHt, x.totalTtc]));
  if (kind === 'months') return W.sendCsv(res, name, ['Mois', 'Commandé TTC', 'Facturé HT', 'Facturé TTC'], d.byMonth.map((x) => [x.month, x.orderedTtc, x.invoicedHt, x.invoicedTtc]));
  if (kind === 'late') return W.sendCsv(res, name, ['Bon de commande', 'Fournisseur', 'Livraison prévue', 'Jours de retard', 'Total TTC'], d.deliveries.lateOpen.map((x) => [x.number, x.supplier, x.expectedDate, x.daysLate, x.totalTtc]));
  if (kind === 'rfqs') return W.sendCsv(res, name, ['Appel d\'offres', 'Titre', 'Fournisseur retenu', 'Référence', 'Montant attribué', 'Économie'], d.savings.items.map((x) => [x.number, x.title, x.supplier, x.baseline, x.awardedTotal, x.savings]));
  if (kind === 'orders') {
    const rows = await db.prepare("SELECT o.number, o.order_date, o.expected_date, o.status, o.category, o.total_ht, o.total_ttc, COALESCE(s.name, o.supplier_name) AS supplier FROM pur_orders o LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND substr(o.order_date, 1, 4) = ? ORDER BY o.id").all(req.org.id, year);
    return W.sendCsv(res, name, ['Numéro', 'Date', 'Livraison prévue', 'Statut', 'Catégorie', 'Fournisseur', 'Total HT', 'Total TTC'], rows.map((r) => [r.number, r.order_date, r.expected_date || '', r.status, r.category, r.supplier, r.total_ht, r.total_ttc]));
  }
  const rows = await db.prepare("SELECT i.number, i.supplier_ref, i.invoice_date, i.due_date, i.status, i.total_ht, i.vat_amount, i.total_ttc, COALESCE(s.name, i.supplier_name) AS supplier, COALESCE(b.paid, 0) AS paid FROM pur_invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN supplier_bills b ON b.id = i.bill_id WHERE i.org_id = ? AND substr(i.invoice_date, 1, 4) = ? ORDER BY i.id").all(req.org.id, year);
  return W.sendCsv(res, name, ['Numéro', 'Facture fournisseur', 'Date', 'Échéance', 'Statut', 'Fournisseur', 'HT', 'TVA', 'TTC', 'Payé'], rows.map((r) => [r.number, r.supplier_ref, r.invoice_date, r.due_date, r.status, r.supplier, r.total_ht, r.vat_amount, r.total_ttc, r.paid]));
});

module.exports = router;
module.exports.compute = compute;
