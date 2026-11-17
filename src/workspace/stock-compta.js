'use strict';
// Échanges entre le Stock / l'Entrepôt, les Achats, la Comptabilité et la Trésorerie. Un seul sens à chaque fois, jamais de double comptage :
//  - Avoir fournisseur (retour fournisseur) → comptabilité : écriture AC (D 401 / 409, C 609 et TVA récupérable), imputé sur les dettes ouvertes du fournisseur
//    (supplier_bills : la trésorerie prévue baisse d'autant). Annulable (écriture inverse, dettes remises comme avant).
//  - Retour client → avoir client : émis par le module Clients et ventes sur la facture d'origine (lignes et prix de la facture), qui passe elle-même son écriture.
//  - Facture d'achat (Achats) → frais d'arrivée : le montant d'une facture de transport ou de douane déjà validée est rattaché à la réception (coût de revient) ; la charge
//    reste celle de la facture, il n'y a donc AUCUNE nouvelle écriture. Un même montant ne peut pas être réparti deux fois.
//  - Stock ↔ comptabilité : valeur du stock face aux comptes de classe 3, et ce qui reste à constater.
//  - Trésorerie du stock : argent immobilisé, engagements d'achat, dettes à échéance, avoirs attendus, réapprovisionnement à prévoir.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const accounting = () => require('./accounting');
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const r3 = (n) => Math.round(n * 1000) / 1000;

const returnOf = async (req, id) => {
  const r = await db.prepare('SELECT * FROM wms_returns WHERE id = ? AND org_id = ?').get(A.id(id, 'Retour invalide.'), req.org.id);
  if (!r) throw new HttpError(404, 'Retour introuvable.');
  return r;
};

// =====================================================================================================  AVOIR FOURNISSEUR
/**
 * Comptabilise l'avoir reçu pour un retour fournisseur validé. `amount` = montant TTC de l'avoir, `vat` = part de TVA récupérable (0 si inconnue).
 * Imputé sur les dettes ouvertes du fournisseur (échéance la plus proche d'abord) ; ce qui dépasse devient un solde débiteur (409). Dans la transaction de l'appelant.
 */
async function bookSupplierCredit(req, r, amount, vat = 0) {
  if (r.credit_entry_id) throw new HttpError(409, 'Cet avoir est déjà comptabilisé : annulez-le avant de le refaire.');
  if (!r.supplier_id) throw new HttpError(400, 'Ce retour n\'a pas de fournisseur : impossible d\'imputer l\'avoir sur ses dettes.');
  if (vat < 0 || vat >= amount) throw new HttpError(400, 'La TVA de l\'avoir doit être comprise entre 0 et son montant.');
  const sup = await db.prepare('SELECT name FROM suppliers WHERE id = ? AND org_id = ?').get(r.supplier_id, req.org.id);
  const bills = await db.prepare("SELECT * FROM supplier_bills WHERE org_id = ? AND supplier_id = ? AND status IN ('open', 'partial') AND amount > paid ORDER BY due_date, id FOR UPDATE").all(req.org.id, r.supplier_id);
  let left = amount; const applied = [];
  for (const b of bills) {
    if (left <= 0) break;
    const take = Math.min(left, Number(b.amount) - Number(b.paid));
    await db.prepare("UPDATE supplier_bills SET paid = paid + ?, status = CASE WHEN paid + ? >= amount THEN 'paid' ELSE 'partial' END WHERE id = ?").run(take, take, b.id);
    await db.prepare('INSERT INTO wms_credit_applications (return_id, bill_id, amount) VALUES (?, ?, ?)').run(r.id, b.id, take);
    applied.push({ billId: Number(b.id), number: b.number, amount: take }); left -= take;
  }
  const name = sup ? sup.name : '';
  const lines = [];
  const on401 = amount - left;
  if (on401 > 0) lines.push({ account: '401', debit: on401, memo: name });
  if (left > 0) lines.push({ account: '409', debit: left, memo: name });
  lines.push({ account: '609', credit: amount - vat, memo: name });
  if (vat > 0) lines.push({ account: '4452', credit: vat, memo: name });
  const e = await accounting().recordEntry(req.org, req.user.id, { journal: 'AC', date: today(), label: `Avoir fournisseur ${name} (retour ${r.code})`.slice(0, 200), piece: r.code, lines, source: 'wms_supplier_credit', sourceId: Number(r.id) });
  await db.prepare('UPDATE wms_returns SET credit_entry_id = ?, credit_vat = ? WHERE id = ?').run(e.id, vat, r.id);
  return { entry: e.number, entryId: e.id, applied, unapplied: left };
}

/** Annule un avoir comptabilisé : écriture inverse, dettes remises dans leur état. */
router.post('/returns/:id/credit/reverse', A.need('admin'), async (req, res) => {
  const r = await returnOf(req, req.params.id);
  if (!r.credit_entry_id) throw new HttpError(400, "Cet avoir n'est pas comptabilisé.");
  await db.transaction(async () => {
    await accounting().reverseEntry(req.org, req.user.id, Number(r.credit_entry_id), today(), { source: 'wms_supplier_credit_reverse', sourceId: Number(r.id) });
    for (const a of await db.prepare('SELECT * FROM wms_credit_applications WHERE return_id = ?').all(r.id)) {
      await db.prepare("UPDATE supplier_bills SET paid = GREATEST(paid - ?, 0), status = CASE WHEN paid - ? <= 0 THEN 'open' WHEN paid - ? >= amount THEN 'paid' ELSE 'partial' END WHERE id = ? AND status <> 'cancelled'").run(a.amount, a.amount, a.amount, a.bill_id);
    }
    await db.prepare('DELETE FROM wms_credit_applications WHERE return_id = ?').run(r.id);
    await db.prepare("UPDATE wms_returns SET credit_entry_id = NULL, credit_vat = 0, credit_status = '', credit_amount = NULL, credited_at = NULL WHERE id = ?").run(r.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Avoir fournisseur du retour ${r.code} annulé`);
  res.json({ ok: true });
});

router.get('/returns/:id/credit', mgr, async (req, res) => {
  const r = await returnOf(req, req.params.id);
  const apps = await db.prepare('SELECT a.bill_id, a.amount, b.number, b.supplier_name FROM wms_credit_applications a JOIN supplier_bills b ON b.id = a.bill_id WHERE a.return_id = ? ORDER BY a.id').all(r.id);
  const e = r.credit_entry_id ? await db.prepare('SELECT number, date FROM acc_entries WHERE id = ?').get(r.credit_entry_id) : null;
  res.json({ amount: r.credit_amount === null ? null : Number(r.credit_amount), vat: Number(r.credit_vat), status: r.credit_status || '', creditedAt: r.credited_at || null, entry: e ? { number: e.number, date: e.date } : null,
    applied: apps.map((a) => ({ billId: Number(a.bill_id), number: a.number, amount: Number(a.amount) })), unapplied: r.credit_amount === null ? 0 : Math.max(Number(r.credit_amount) - apps.reduce((s, a) => s + Number(a.amount), 0), 0) });
});

// =====================================================================================================  RETOUR CLIENT → AVOIR CLIENT
router.post('/returns/:id/credit-note', mgr, async (req, res) => {
  const r = await returnOf(req, req.params.id);
  if (r.kind !== 'customer' || r.status !== 'done') throw new HttpError(400, 'Seul un retour client validé donne lieu à un avoir.');
  if (r.credit_note_doc_id) throw new HttpError(409, 'Un avoir a déjà été émis pour ce retour.');
  if (!r.document_id) throw new HttpError(400, "Ce retour n'est lié à aucune facture : l'avoir se fait depuis la facture (Clients et ventes).");
  const crm = require('./crm');
  const d = await db.prepare("SELECT * FROM documents WHERE id = ? AND org_id = ? AND kind = 'invoice'").get(r.document_id, req.org.id);
  if (!d) throw new HttpError(400, "Le document lié n'est pas une facture : l'avoir ne peut se rattacher qu'à une facture.");
  const sold = JSON.parse(d.lines);
  const back = await db.prepare('SELECT l.item_id, SUM(l.quantity) q, MAX(i.name) AS name FROM wms_return_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.return_id = ? GROUP BY l.item_id').all(r.id);
  const lines = back.map((x) => {
    const sl = sold.find((l) => Number(l.itemId) === Number(x.item_id));
    if (!sl) throw new HttpError(400, `« ${x.name} » ne figure pas sur la facture ${d.number} avec un article du stock : faites l'avoir à la main depuis la facture.`);
    return { itemId: Number(x.item_id), label: sl.label, quantity: r3(Number(x.q)), price: Number(sl.price) };
  });
  const cn = await db.transaction(async () => {
    const out = await crm.issueCreditNote(req, d, { reason: `Retour client ${r.code}${r.reason ? ' : ' + r.reason : ''}`, lines, note: `Suite au retour ${r.code}` });
    await db.prepare('UPDATE wms_returns SET credit_note_doc_id = ? WHERE id = ?').run(out.id, r.id);
    return out;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Avoir ${cn.number} émis pour le retour client ${r.code}`);
  res.status(201).json(cn);
});

// =====================================================================================================  FACTURE D'ACHAT → FRAIS D'ARRIVÉE
/** Factures d'achat validées dont le montant HT n'est pas encore entièrement réparti en frais d'arrivée. */
async function invoiceCandidates(req) {
  const rows = await db.prepare(`SELECT v.id, v.number, v.supplier_ref, v.invoice_date, v.total_ht, v.status, s.name AS supplier,
      COALESCE((SELECT SUM(c.amount) FROM wms_receipt_costs c WHERE c.invoice_id = v.id), 0) AS used
    FROM pur_invoices v JOIN suppliers s ON s.id = v.supplier_id WHERE v.org_id = ? AND v.status IN ('approved', 'paid') ORDER BY v.id DESC LIMIT 100`).all(req.org.id);
  return rows.map((v) => ({ id: Number(v.id), number: v.number, supplierRef: v.supplier_ref, supplier: v.supplier, date: v.invoice_date, totalHt: Number(v.total_ht), used: Number(v.used), remaining: Math.max(Number(v.total_ht) - Number(v.used), 0) })).filter((v) => v.remaining > 0);
}
router.get('/receipts/invoice-candidates', mgr, async (req, res) => res.json({ invoices: await invoiceCandidates(req) }));

/** Contrôle le rattachement d'un montant à une facture d'achat ; renvoie la facture et le montant retenu (par défaut, tout ce qui reste). */
async function checkInvoiceShare(req, invoiceId, amount) {
  const v = await db.prepare("SELECT v.*, s.name AS supplier FROM pur_invoices v JOIN suppliers s ON s.id = v.supplier_id WHERE v.id = ? AND v.org_id = ?").get(A.id(invoiceId, 'Facture invalide.'), req.org.id);
  if (!v) throw new HttpError(404, "Facture d'achat introuvable.");
  if (!['approved', 'paid'].includes(v.status)) throw new HttpError(400, "Seule une facture d'achat validée (donc déjà comptabilisée) peut être rattachée à des frais d'arrivée.");
  const used = Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) q FROM wms_receipt_costs WHERE invoice_id = ?').get(v.id)).q);
  const remaining = Number(v.total_ht) - used;
  if (remaining <= 0) throw new HttpError(409, `La facture ${v.number} est déjà entièrement répartie en frais d'arrivée.`);
  const take = amount === undefined || amount === null || amount === '' ? remaining : A.amount(amount);
  if (take > remaining) throw new HttpError(400, `Il ne reste que ${remaining} (HT) à répartir sur la facture ${v.number}.`);
  return { invoice: v, amount: take };
}

// =====================================================================================================  STOCK ↔ COMPTABILITÉ
const NATURES = [['goods', '311', 'marchandises'], ['raw', '321', 'matières premières'], ['supplies', '331', 'matières consommables']];
async function accountingBalance(orgId, account, date) {
  return Number((await db.prepare('SELECT COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS bal FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account = ? AND e.date <= ?').get(orgId, account, date)).bal);
}
router.get('/accounting-link', mgr, async (req, res) => {
  const t = today();
  const sc = A.scope(req, 'branch_id');
  const items = await db.prepare(`SELECT quantity, avg_cost, unit_cost FROM stock_items WHERE org_id = ?${sc.sql}`).all(req.org.id, ...sc.args);
  const stockValue = Math.round(items.reduce((a, i) => a + Number(i.quantity) * L.unitValue(i), 0));
  const balances = []; for (const [k, acc, label] of NATURES) balances.push({ nature: k, account: acc, label, balance: await accountingBalance(req.org.id, acc, t) });
  const accounted = balances.reduce((a, b) => a + b.balance, 0);
  const last = await db.prepare("SELECT e.number, e.date FROM acc_entries e WHERE e.org_id = ? AND e.source = 'stock_valuation' ORDER BY e.id DESC LIMIT 1").get(req.org.id);
  const credits = await db.prepare("SELECT COUNT(*) c, COALESCE(SUM(credit_amount), 0) s FROM wms_returns WHERE org_id = ? AND kind = 'supplier' AND credit_status = 'received' AND credit_entry_id IS NULL").get(req.org.id);
  const asSold = await db.prepare("SELECT COUNT(*) c FROM wms_returns WHERE org_id = ? AND kind = 'customer' AND status = 'done' AND document_id IS NOT NULL AND credit_note_doc_id IS NULL").get(req.org.id);
  const expensed = Number((await db.prepare('SELECT COALESCE(SUM(expensed), 0) q FROM wms_receipt_costs c JOIN wms_receipts r ON r.id = c.receipt_id WHERE r.org_id = ?').get(req.org.id)).q);
  res.json({ date: t, stockValue, accounted, gap: stockValue - accounted, balances, lastPosting: last ? { number: last.number, date: last.date } : null,
    toBook: { supplierCredits: Number(credits.c), supplierCreditsAmount: Number(credits.s), customerReturnsWithoutCreditNote: Number(asSold.c), landedCostsToExpense: expensed },
    note: 'La valeur du stock vient du coût moyen pondéré ; la comptabilité la constate à une date d\'inventaire (Comptabilité › Stocks).' });
});

// =====================================================================================================  TRÉSORERIE DU STOCK
router.get('/cash', mgr, async (req, res) => {
  const horizon = Math.min(Math.max(Math.round(Number(req.query.days)) || 30, 7), 180);
  const t = today(); const until = addDays(t, horizon);
  const sc = A.scope(req, 'i.branch_id');
  const items = await db.prepare(`SELECT i.id, i.quantity, i.avg_cost, i.unit_cost FROM stock_items i WHERE i.org_id = ?${sc.sql}`).all(req.org.id, ...sc.args);
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const moving = new Set((await db.prepare("SELECT DISTINCT item_id FROM stock_moves WHERE org_id = ? AND delta < 0 AND created_at >= ? AND ref_kind NOT IN ('count','transfer','return','scrap')").all(req.org.id, since)).map((x) => Number(x.item_id)));
  let tied = 0; let dormant = 0;
  for (const i of items) { const v = Number(i.quantity) * L.unitValue(i); tied += v; if (Number(i.quantity) > 0 && !moving.has(Number(i.id))) dormant += v; }
  // engagements d'achat : bons de commande approuvés / envoyés / reçus en partie, pour ce qui n'est pas encore reçu (TTC)
  const open = await db.prepare(`SELECT o.id, o.number, o.status, o.expected_date, o.vat_rate, s.name AS supplier,
      COALESCE((SELECT SUM(GREATEST(l.quantity - COALESCE((SELECT SUM(rl.received_qty) FROM pur_receipt_lines rl WHERE rl.order_line_id = l.id), 0), 0) * l.unit_price) FROM pur_order_lines l WHERE l.order_id = o.id), 0) AS ht
    FROM pur_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND o.status IN ('approved', 'sent', 'partial') ORDER BY o.expected_date NULLS LAST, o.id`).all(req.org.id);
  const commitments = open.map((o) => ({ id: Number(o.id), number: o.number, supplier: o.supplier, expectedDate: o.expected_date, amount: Math.round(Number(o.ht) * (1 + Number(o.vat_rate) / 100)) })).filter((o) => o.amount > 0);
  const bills = await db.prepare("SELECT amount, paid, due_date FROM supplier_bills WHERE org_id = ? AND status IN ('open', 'partial')").all(req.org.id);
  const payOpen = bills.reduce((a, b) => a + (Number(b.amount) - Number(b.paid)), 0);
  const payDue = bills.filter((b) => b.due_date <= until).reduce((a, b) => a + (Number(b.amount) - Number(b.paid)), 0);
  const payOver = bills.filter((b) => b.due_date < t).reduce((a, b) => a + (Number(b.amount) - Number(b.paid)), 0);
  // avoirs attendus : retours fournisseur validés dont l'avoir n'est pas encore reçu (valeur au coût)
  const pend = await db.prepare("SELECT r.id, r.code, COALESCE((SELECT SUM(l.value) FROM wms_return_lines l WHERE l.return_id = r.id), 0) AS v FROM wms_returns r WHERE r.org_id = ? AND r.kind = 'supplier' AND r.status = 'done' AND r.credit_status <> 'received'").all(req.org.id).catch(() => []);
  const creditsExpected = pend.reduce((a, r) => a + Number(r.v), 0);
  let reorder = { suggestions: [], estimate: 0, critical: 0 };
  try { reorder = await require('./stock-wms-forecast').reorderList(req); } catch { /* prévision indisponible : on ne bloque pas l'état */ }
  const need = commitments.filter((c) => !c.expectedDate || c.expectedDate <= until).reduce((a, c) => a + c.amount, 0) + payDue + reorder.estimate - creditsExpected;
  res.json({ horizonDays: horizon, until, tiedUp: Math.round(tied), dormant: Math.round(dormant), dormantShare: tied > 0 ? Math.round((1000 * dormant) / tied) / 10 : 0,
    commitments: { total: commitments.reduce((a, c) => a + c.amount, 0), inHorizon: commitments.filter((c) => !c.expectedDate || c.expectedDate <= until).reduce((a, c) => a + c.amount, 0), orders: commitments.slice(0, 20) },
    payables: { open: payOpen, dueInHorizon: payDue, overdue: payOver }, creditsExpected: Math.round(creditsExpected), reorder: { estimate: reorder.estimate, critical: reorder.critical, items: reorder.suggestions.slice(0, 10).map((x) => ({ itemId: x.itemId, name: x.name, toOrder: x.toOrder, estimate: x.estimate, urgency: x.urgency })) },
    cashNeed: Math.round(need), note: "Besoin = bons de commande à recevoir + dettes fournisseurs à échéance + réapprovisionnement conseillé − avoirs attendus (sur l'horizon)." });
});

module.exports = router;
module.exports.bookSupplierCredit = bookSupplierCredit;
module.exports.checkInvoiceShare = checkInvoiceShare;
