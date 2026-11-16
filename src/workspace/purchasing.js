'use strict';
// Sous-application « Achats » (id « purchasing ») : demandes d'achat, appels d'offres, bons de commande, réceptions, factures fournisseurs avec rapprochement
// à trois, fournisseurs et évaluations, budgets et engagements, tableau de bord. Un membre demande ; un responsable ou plus approuve, commande et réceptionne ;
// un administrateur valide les factures pour paiement (écritures comptables) et les règle. Tout est cloisonné par organisation (req.org.id).
const express = require('express');
const { db } = require('../db');
const P = require('./pur-lib');

const router = express.Router({ mergeParams: true });
const A = require('./access');

router.get('/summary', async (req, res) => {
  const o = req.org.id;
  const mine = await db.prepare('SELECT status, COUNT(*) AS n FROM pur_requests WHERE org_id = ? AND requested_by = ? GROUP BY status').all(o, req.user.id);
  const out = { myRequests: Object.fromEntries(mine.map((r) => [r.status, Number(r.n)])), canManage: A.can(req, 'manager'), canAdmin: A.can(req, 'admin') };
  if (A.can(req, 'manager')) {
    const c = async (sql) => Number((await db.prepare(sql).get(o)).c);
    out.pending = { requests: await c("SELECT COUNT(*) c FROM pur_requests WHERE org_id = ? AND status = 'submitted'"), orders: await c("SELECT COUNT(*) c FROM pur_orders WHERE org_id = ? AND status = 'draft'"),
      late: await c(`SELECT COUNT(*) c FROM pur_orders WHERE org_id = ? AND status IN ('sent', 'partial') AND expected_date < '${P.today()}'`), invoices: await c("SELECT COUNT(*) c FROM pur_invoices WHERE org_id = ? AND status IN ('matched', 'blocked')"), rfqs: await c("SELECT COUNT(*) c FROM pur_rfqs WHERE org_id = ? AND status = 'open'") };
  }
  res.json(out);
});

/** Réapprovisionnement : articles du stock sous leur seuil, en tenant compte de ce qui est déjà commandé et pas encore reçu (bons d'achat ouverts). */
router.get('/reorder', A.need('manager'), async (req, res) => {
  const sc = A.scope(req, 'i.branch_id');
  const rows = await db.prepare(`SELECT i.id, i.name, i.unit, i.quantity, i.min_quantity, i.max_quantity,
    COALESCE((SELECT SUM(GREATEST(l.quantity - l.received_qty, 0)) FROM pur_order_lines l JOIN pur_orders o ON o.id = l.order_id WHERE l.item_id = i.id AND o.status IN ('approved', 'sent', 'partial')), 0) AS on_order
    FROM stock_items i WHERE i.org_id = ? AND i.min_quantity > 0${sc.sql} ORDER BY i.name`).all(req.org.id, ...sc.args);
  const out = [];
  for (const r of rows) {
    const qty = Number(r.quantity); const onOrder = Number(r.on_order); const min = Number(r.min_quantity); const max = Number(r.max_quantity);
    if (qty + onOrder > min) continue;
    const target = max > 0 ? max : min * 2;
    const best = await db.prepare('SELECT p.supplier_id, s.name, p.unit_price, p.lead_days FROM supplier_prices p JOIN suppliers s ON s.id = p.supplier_id WHERE p.item_id = ? ORDER BY p.unit_price LIMIT 1').get(r.id);
    out.push({ itemId: Number(r.id), name: r.name, unit: r.unit, quantity: qty, minQuantity: min, onOrder, suggested: P.round3(Math.max(target - qty - onOrder, 0)), supplier: best ? { id: Number(best.supplier_id), name: best.name, unitPrice: Number(best.unit_price), leadDays: best.lead_days === null ? null : Number(best.lead_days) } : null });
  }
  res.json({ items: out });
});

router.use(require('./pur-requests'));   // réglages + demandes (ouvert à tout membre, le reste exige « responsable »)
router.use(require('./pur-orders'));
router.use(require('./pur-invoices'));
router.use(require('./pur-rfq'));
router.use(require('./pur-suppliers'));
router.use(require('./pur-reports'));

module.exports = router;
module.exports.min = 'member';
