'use strict';
// Achats : outils communs (réglages, numérotation, montants, seuils d'approbation, budgets, quantités reçues et facturées).
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError, cleanText } = require('../util');

const today = () => nowISO().slice(0, 10);
const yearOf = (d) => String(d || today()).slice(0, 4);
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
const amount = (qty, price) => Math.round(Number(qty) * Number(price || 0));
const vatOf = (ht, rate) => Math.round(ht * Number(rate || 0) / 100);

// ---------- Réglages ----------
const DEFAULTS = { tolQtyPct: 5, tolPricePct: 2, tolAmount: 500, budgetBlock: false, defaultTermsDays: 30, thresholds: { request: [], order: [] } };
const APPROVER_ROLES = ['manager', 'admin', 'owner'];
async function settingsOf(org) {
  const row = await db.prepare('SELECT data FROM pur_settings WHERE org_id = ?').get(org.id);
  let d = {};
  try { d = row ? JSON.parse(row.data) : {}; } catch { d = {}; }
  const s = { ...DEFAULTS, ...d };
  s.thresholds = { request: Array.isArray(d.thresholds && d.thresholds.request) ? d.thresholds.request : [], order: Array.isArray(d.thresholds && d.thresholds.order) ? d.thresholds.order : [] };
  return s;
}
/** Rôle minimal pour approuver ce montant : la règle la plus haute dont le seuil est atteint (sans règle : responsable). */
function requiredRole(settings, kind, total) {
  let role = 'manager';
  for (const r of settings.thresholds[kind] || []) if (total >= Number(r.minAmount) && A.RANK[r.role] > A.RANK[role]) role = r.role;
  return role;
}

// ---------- Numérotation : DA-2026-0001, AO-, BC-, BR-, FF- ----------
async function nextNumber(orgId, prefix, date) {
  const y = yearOf(date);
  const row = await db.prepare('INSERT INTO pur_counters (org_id, kind, year, n) VALUES (?, ?, ?, 1) ON CONFLICT (org_id, kind, year) DO UPDATE SET n = pur_counters.n + 1 RETURNING n').get(orgId, prefix, y);
  return `${prefix}-${y}-${String(row.n).padStart(4, '0')}`;
}

// ---------- Saisie ----------
function dateOrNull(v, msg = 'Date invalide (AAAA-MM-JJ).') {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(s + 'T00:00:00Z').getTime())) throw new HttpError(400, msg);
  return s;
}
function money(v, msg = 'Montant invalide.') {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e13) throw new HttpError(400, msg);
  return Math.round(n);
}
function qtyOf(v, { zero = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!zero && n === 0) || n > 1e9) throw new HttpError(400, 'Quantité invalide.');
  return round3(n);
}
const pct = (v, max = 100) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, 'Taux invalide.'); return Math.round(n * 100) / 100; };
const category = (v) => cleanText(String(v || ''), 60);
/** Lignes saisies : article du stock (de l'organisation) ou désignation libre. priceKey : estPrice, refPrice ou unitPrice. */
async function readLines(req, lines, priceKey, { priceRequired = false } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Ajoutez au moins une ligne.');
  if (lines.length > 200) throw new HttpError(400, 'Trop de lignes (200 au plus).');
  const out = [];
  for (const l of lines) {
    const x = l || {};
    let item = null;
    if (x.itemId !== undefined && x.itemId !== null && x.itemId !== '') {
      item = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(x.itemId, 'Article invalide.'), req.org.id);
      if (!item) throw new HttpError(400, 'Article du stock introuvable.');
    }
    const description = cleanText(String(x.description || ''), 200) || (item ? item.name : '');
    if (!description) throw new HttpError(400, "Chaque ligne a besoin d'un article du stock ou d'une désignation.");
    const raw = x[priceKey];
    const price = raw === undefined || raw === null || raw === '' ? null : money(raw, 'Prix invalide.');
    if (priceRequired && price === null) throw new HttpError(400, 'Indiquez le prix unitaire de chaque ligne.');
    out.push({ itemId: item ? Number(item.id) : null, description, unit: cleanText(String(x.unit || ''), 20) || (item ? item.unit : ''), quantity: qtyOf(x.quantity), price });
  }
  return out;
}

// ---------- Quantités d'une commande ----------
/** Par ligne de commande : reçu (accepté, y compris en contrôle), refusé, facturé (factures non annulées, sauf `exceptInvoice`). */
async function orderLineState(orderId, exceptInvoice) {
  const lines = await db.prepare('SELECT * FROM pur_order_lines WHERE order_id = ? ORDER BY position, id').all(orderId);
  const rec = await db.prepare(`SELECT rl.order_line_id, SUM(rl.received_qty - rl.insp_rejected) AS r, SUM(rl.rejected_qty + rl.insp_rejected) AS j, SUM(rl.insp_pending) AS p
    FROM pur_receipt_lines rl JOIN pur_receipts r ON r.id = rl.receipt_id WHERE r.order_id = ? GROUP BY rl.order_line_id`).all(orderId);
  const inv = await db.prepare(`SELECT il.order_line_id, SUM(il.quantity) AS q FROM pur_invoice_lines il JOIN pur_invoices i ON i.id = il.invoice_id
    WHERE i.order_id = ? AND i.status != 'cancelled' AND i.id != ? GROUP BY il.order_line_id`).all(orderId, exceptInvoice || 0);
  const R = Object.fromEntries(rec.map((x) => [Number(x.order_line_id), x]));
  const I = Object.fromEntries(inv.map((x) => [Number(x.order_line_id), Number(x.q) || 0]));
  return lines.map((l) => {
    const r = R[Number(l.id)] || {};
    const received = round3(Number(r.r) || 0);
    return { ...l, quantity: Number(l.quantity), unit_price: Number(l.unit_price), received, rejected: round3(Number(r.j) || 0), pending: round3(Number(r.p) || 0), invoiced: round3(I[Number(l.id)] || 0), remaining: round3(Math.max(0, Number(l.quantity) - received)) };
  });
}
function orderTotals(lines, vatRate) {
  const ht = lines.reduce((s, l) => s + amount(l.quantity, l.unit_price), 0);
  const vat = vatOf(ht, vatRate);
  return { ht, vat, ttc: ht + vat };
}
async function orderTotalsOf(o) {
  const lines = await db.prepare('SELECT quantity, unit_price FROM pur_order_lines WHERE order_id = ?').all(o.id);
  return orderTotals(lines, o.vat_rate);
}
async function invoiceTotalsOf(inv) {
  const lines = await db.prepare('SELECT quantity, unit_price FROM pur_invoice_lines WHERE invoice_id = ?').all(inv.id);
  return orderTotals(lines, inv.vat_rate);
}
const OPEN_ORDER = ['approved', 'sent', 'partial'];
const isLate = (o) => OPEN_ORDER.includes(o.status) && o.expected_date && o.expected_date < today();

// ---------- Budgets (module Budget) ----------
/** Budget prévu d'une catégorie pour l'année (budget annuel, sinon plafond mensuel × 12), ou null. */
async function plannedOf(orgId, cat, year) {
  if (!cat) return null;
  const rows = await db.prepare("SELECT category, amounts FROM budget_annual WHERE org_id = ? AND year = ? AND kind = 'expense'").all(orgId, String(year));
  const hit = rows.find((r) => r.category.toLowerCase() === cat.toLowerCase());
  if (hit) { let a = []; try { a = JSON.parse(hit.amounts); } catch { a = []; } return Math.round(a.reduce((s, x) => s + (Number(x) || 0), 0)); }
  const p = (await db.prepare('SELECT category, monthly_limit FROM budget_plans WHERE org_id = ?').all(orgId)).find((r) => r.category.toLowerCase() === cat.toLowerCase());
  return p ? Math.round(Number(p.monthly_limit) * 12) : null;
}
/** Engagé (commandes approuvées non encore facturées) et facturé (factures validées) d'une catégorie pour l'année. */
async function usedOf(orgId, cat, year, { exceptOrder } = {}) {
  const y = String(year);
  const orders = await db.prepare(`SELECT * FROM pur_orders WHERE org_id = ? AND LOWER(category) = LOWER(?) AND status IN ('approved','sent','partial','received') AND SUBSTR(order_date, 1, 4) = ? AND id != ?`).all(orgId, cat, y, exceptOrder || 0);
  let engaged = 0;
  for (const o of orders) {
    const t = await orderTotalsOf(o);
    const inv = await db.prepare("SELECT * FROM pur_invoices WHERE order_id = ? AND status = 'approved'").all(o.id);
    let done = 0; for (const i of inv) done += (await invoiceTotalsOf(i)).ttc;
    engaged += Math.max(0, t.ttc - done);
  }
  const invs = await db.prepare(`SELECT i.* FROM pur_invoices i LEFT JOIN pur_orders o ON o.id = i.order_id WHERE i.org_id = ? AND i.status = 'approved' AND SUBSTR(i.invoice_date, 1, 4) = ? AND LOWER(COALESCE(o.category, '')) = LOWER(?)`).all(orgId, y, cat);
  let invoiced = 0; for (const i of invs) invoiced += (await invoiceTotalsOf(i)).ttc;
  return { engaged, invoiced };
}
async function budgetOf(orgId, cat, year, opts = {}) {
  const planned = await plannedOf(orgId, cat, year);
  if (planned === null) return null;
  const u = await usedOf(orgId, cat, year, opts);
  return { category: cat, planned, engaged: u.engaged, invoiced: u.invoiced, available: planned - u.engaged - u.invoiced, over: u.engaged + u.invoiced + (opts.extra || 0) > planned };
}
/** Contrôle de budget avant une approbation : renvoie { budgetWarning } ou lève une erreur si le réglage bloque. */
async function budgetCheck(req, cat, year, extra, opts = {}) {
  const b = await budgetOf(req.org.id, cat, year, { ...opts, extra });
  if (!b || !b.over) return {};
  const s = await settingsOf(req.org);
  if (s.budgetBlock && !opts.warnOnly) throw new HttpError(403, `Budget « ${cat} » dépassé : l'approbation est bloquée par les réglages des achats.`);
  return { budgetWarning: { category: cat } };
}

/** Verrou de ligne (dans une transaction) : relit un document sous verrou pour que deux envois simultanés (double clic, deux personnes)
 * ne passent pas tous les deux le même contrôle de statut. `table` est toujours une constante du code. */
const lockRow = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ? FOR UPDATE`).get(Number(id));
const nameMap = async (ids) => {
  const list = [...new Set(ids.filter((x) => x != null).map(Number))];
  if (!list.length) return {};
  const rows = await db.prepare(`SELECT id, name FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list);
  return Object.fromEntries(rows.map((r) => [Number(r.id), r.name]));
};
// Une cellule qui commence par = + - @ serait exécutée comme formule par un tableur : on la neutralise (sauf les nombres).
const csvCell = (v) => { let s = String(v == null ? '' : v); if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + Number(n || 0)); return x.toISOString().slice(0, 10); };

// ---------- Alertes (module Alertes) — porté de la ligne B sur le schéma de la ligne A ----------
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
async function alertItems(req) {
  if (!A.can(req, 'manager')) return [];
  const o = req.org.id; const t = today(); const out = [];
  const add = (level, title, text, at) => out.push({ level, module: 'purchasing', title, text, at: at || null });
  const reqs = await db.prepare("SELECT COUNT(*) c, MIN(updated_at) m FROM pur_requests WHERE org_id = ? AND status = 'submitted'").get(o);
  if (Number(reqs.c)) add('info', 'Achats', `${plural(Number(reqs.c), "demande d'achat attend", "demandes d'achat attendent")} votre décision`, reqs.m);
  const ords = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM pur_orders WHERE org_id = ? AND status = 'draft'").get(o);
  if (Number(ords.c)) add('info', 'Achats', plural(Number(ords.c), 'bon de commande à approuver', 'bons de commande à approuver'), ords.m);
  const late = await db.prepare("SELECT number, expected_date FROM pur_orders WHERE org_id = ? AND status IN ('sent', 'partial') AND expected_date IS NOT NULL AND expected_date < ? ORDER BY expected_date LIMIT 20").all(o, t);
  if (late.length) add('medium', 'Achats', `${plural(late.length, 'livraison fournisseur en retard', 'livraisons fournisseurs en retard')} : ${late.slice(0, 3).map((x) => x.number).join(', ')}`, `${late[0].expected_date}T00:00:00.000Z`);
  const blocked = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM pur_invoices WHERE org_id = ? AND status = 'blocked'").get(o);
  if (Number(blocked.c)) add('medium', 'Achats', `${plural(Number(blocked.c), 'facture fournisseur bloquée', 'factures fournisseurs bloquées')} par le rapprochement (anomalies à traiter)`, blocked.m);
  if (A.can(req, 'admin')) {
    const ready = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM pur_invoices WHERE org_id = ? AND status = 'matched'").get(o);
    if (Number(ready.c)) add('info', 'Achats', `${plural(Number(ready.c), 'facture fournisseur rapprochée à valider', 'factures fournisseurs rapprochées à valider')} pour paiement`, ready.m);
  }
  const rfq = await db.prepare("SELECT number FROM pur_rfqs WHERE org_id = ? AND status = 'open' AND deadline IS NOT NULL AND deadline < ? LIMIT 5").all(o, t);
  if (rfq.length) add('info', 'Achats', `${plural(rfq.length, "appel d'offres dont la date limite est passée", "appels d'offres dont la date limite est passée")} sans attribution : ${rfq.map((x) => x.number).join(', ')}`);
  const cats = await db.prepare("SELECT DISTINCT category FROM pur_orders WHERE org_id = ? AND category <> '' AND status IN ('approved', 'sent', 'partial', 'received', 'closed') AND SUBSTR(order_date, 1, 4) = ?").all(o, t.slice(0, 4));
  for (const c of cats) {
    const b = await budgetOf(o, c.category, t.slice(0, 4));
    if (!b || !(b.planned > 0)) continue;
    const used = b.engaged + b.invoiced; const pct = Math.round((used / b.planned) * 100);
    if (used > b.planned || pct >= 90) add(used > b.planned ? 'high' : 'medium', 'Achats', used > b.planned ? `Budget « ${c.category} » dépassé de ${(used - b.planned).toLocaleString('fr-FR')} FCFA par les achats` : `Budget « ${c.category} » consommé à ${pct} % par les achats`);
  }
  return out;
}

module.exports = {
  alertItems, plural,
  today, yearOf, round3, amount, vatOf, DEFAULTS, APPROVER_ROLES, settingsOf, requiredRole, nextNumber, dateOrNull, money, qtyOf, pct, category, readLines,
  orderLineState, orderTotals, orderTotalsOf, lockRow, invoiceTotalsOf, OPEN_ORDER, isLate, plannedOf, usedOf, budgetOf, budgetCheck, nameMap, csv, addDays,
};
