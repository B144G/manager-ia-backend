'use strict';
// Achats : outils communs (aucune route ici) — réglages et seuils d'approbation, numérotation par année, lignes, totaux, budget, notes des fournisseurs, alertes.
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const round3 = (n) => Math.round(n * 1000) / 1000;
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// ---------- Réglages ----------
const DEFAULTS = { tolQtyPct: 5, tolPricePct: 2, tolAmount: 500, budgetBlock: 0, defaultTermsDays: 30 };
const APPROVER_ROLES = ['manager', 'admin', 'owner'];
const KINDS = ['request', 'order'];

async function settings(orgId) {
  const r = await db.prepare('SELECT * FROM pur_settings WHERE org_id = ?').get(orgId);
  if (!r) return { ...DEFAULTS };
  return { tolQtyPct: Number(r.tol_qty_pct), tolPricePct: Number(r.tol_price_pct), tolAmount: Number(r.tol_amount), budgetBlock: Number(r.budget_block), defaultTermsDays: Number(r.default_terms_days) };
}
async function thresholds(orgId) {
  const rows = await db.prepare('SELECT kind, min_amount, role FROM pur_thresholds WHERE org_id = ? ORDER BY kind, min_amount').all(orgId);
  const out = { request: [], order: [] };
  for (const r of rows) out[r.kind].push({ minAmount: Number(r.min_amount), role: r.role });
  return out;
}

/** Rôle minimal pour approuver un montant : le plus haut palier atteint ; sans palier, un responsable suffit. */
async function requiredRole(orgId, kind, total) {
  const rows = await db.prepare('SELECT min_amount, role FROM pur_thresholds WHERE org_id = ? AND kind = ? AND min_amount <= ? ORDER BY min_amount DESC LIMIT 1').all(orgId, kind, total);
  return rows.length ? rows[0].role : 'manager';
}
/** Peut-on approuver ? Rôle suffisant, et jamais sa propre demande sauf administrateur ou propriétaire. */
function approvalError(req, role, authorId) {
  if (A.RANK[req.member.role] < A.RANK[role]) return `Ce montant demande l'approbation d'un ${A.ROLE_LABEL[role].toLowerCase()} ou d'un rôle supérieur.`;
  if (Number(authorId) === Number(req.user.id) && !A.can(req, 'admin')) return 'Vous ne pouvez pas approuver votre propre demande : un autre responsable doit le faire.';
  return null;
}

// ---------- Numérotation par année (dans la transaction qui insère le document) ----------
async function nextNumber(orgId, kind, prefix, date) {
  const year = String(date || today()).slice(0, 4);
  const row = await db.prepare('INSERT INTO pur_counters (org_id, kind, year, last) VALUES (?, ?, ?, 1) ON CONFLICT (org_id, kind, year) DO UPDATE SET last = pur_counters.last + 1 RETURNING last').get(orgId, kind, year);
  return `${prefix}-${year}-${String(row.last).padStart(4, '0')}`;
}

// ---------- Contrôles d'entrée ----------
function pct(v, def, max = 100) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `Pourcentage invalide : un nombre de 0 à ${max}.`);
  return Math.round(n * 100) / 100;
}
function days(v, def, label = 'Délai') {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 730) throw new HttpError(400, `${label} invalide : un nombre entier de jours (0 à 730).`);
  return n;
}
const vatRateOf = (req, v) => pct(v, Number(req.org.vat_rate) || 0, 40);
const catOf = (v) => A.text(v, 60);

/** Lignes d'un document. kind = 'est' (prix estimé facultatif), 'ref' (prix de référence facultatif) ou 'unit' (prix unitaire obligatoire). */
async function cleanLines(req, raw, kind) {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Ajoutez au moins une ligne.');
  if (raw.length > 100) throw new HttpError(400, '100 lignes au plus par document.');
  const out = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') throw new HttpError(400, 'Ligne invalide.');
    let item = null;
    if (l.itemId !== undefined && l.itemId !== null && l.itemId !== '') {
      item = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(l.itemId, 'Article invalide.'), req.org.id);
      if (!item || !A.visible(req, item)) throw new HttpError(400, 'Article du stock introuvable.');
    }
    const description = A.text(l.description, 200) || (item ? item.name : '');
    if (!description) throw new HttpError(400, 'Chaque ligne a besoin d\'un article du stock ou d\'une désignation.');
    const quantity = A.qty(l.quantity);
    const raw$ = kind === 'est' ? l.estPrice : kind === 'ref' ? l.refPrice : l.unitPrice;
    let price = 0;
    if (kind === 'unit') price = A.amount(raw$);
    else if (raw$ !== undefined && raw$ !== null && raw$ !== '' && Number(raw$) !== 0) price = A.amount(raw$);
    out.push({ itemId: item ? Number(item.id) : null, description, unit: A.text(l.unit, 20) || (item ? item.unit : 'pièce'), quantity, price, tracking: item ? item.tracking : 'none' });
  }
  return out;
}
const lineAmount = (qty, price) => Math.round(Number(qty) * Number(price));
function totals(lines, vatRate) {
  const ht = lines.reduce((s, l) => s + lineAmount(l.quantity, l.price !== undefined ? l.price : l.unit_price), 0);
  const vat = Math.round((ht * vatRate) / 100);
  return { ht, vat, ttc: ht + vat };
}

async function supplierOf(req, id, { allowBlocked = false } = {}) {
  const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(id, 'Fournisseur invalide.'), req.org.id);
  if (!s) throw new HttpError(404, 'Fournisseur introuvable.');
  if (!allowBlocked) {
    const p = await db.prepare('SELECT status FROM pur_supplier_profiles WHERE supplier_id = ?').get(s.id);
    if (p && p.status === 'blocked') throw new HttpError(400, `Le fournisseur « ${s.name} » est bloqué : débloquez-le dans sa fiche avant de lui commander.`);
  }
  return s;
}
async function projectOf(req, v) {
  const id = A.idOrNull(v, 'Projet invalide.');
  if (id === null) return null;
  if (!await db.prepare('SELECT 1 FROM projects WHERE id = ? AND org_id = ?').get(id, req.org.id)) throw new HttpError(400, 'Projet introuvable.');
  return id;
}

// ---------- Budget (lien avec le module Budget) ----------
const arr12 = (v) => { try { const a = JSON.parse(v); return Array.from({ length: 12 }, (_, i) => Number(a[i]) || 0); } catch { return Array(12).fill(0); } };

/** Budget de dépenses d'une catégorie pour une année : budget annuel, sinon plafond mensuel × 12. Null si aucun budget n'est prévu. */
async function plannedOf(orgId, category, year) {
  if (!category) return null;
  const a = await db.prepare("SELECT amounts FROM budget_annual WHERE org_id = ? AND year = ? AND kind = 'expense' AND LOWER(category) = LOWER(?)").get(orgId, String(year), category);
  if (a) return arr12(a.amounts).reduce((s, x) => s + x, 0);
  const p = await db.prepare('SELECT monthly_limit FROM budget_plans WHERE org_id = ? AND LOWER(category) = LOWER(?)').get(orgId, category);
  return p ? Number(p.monthly_limit) * 12 : null;
}
const ENGAGED = "('approved', 'sent', 'partial', 'received')";
/** Engagé (commandes approuvées pas encore facturées) et facturé (factures validées) d'une catégorie sur une année. */
async function spentOf(orgId, category, year, excludeOrderId = 0) {
  const y = String(year);
  const inv = await db.prepare(`SELECT COALESCE(SUM(i.total_ttc), 0) AS s FROM pur_invoices i JOIN pur_orders o ON o.id = i.order_id
    WHERE i.org_id = ? AND LOWER(o.category) = LOWER(?) AND i.status = 'approved' AND substr(i.invoice_date, 1, 4) = ?`).get(orgId, category, y);
  const ords = await db.prepare(`SELECT o.id, o.total_ttc, (SELECT COALESCE(SUM(i.total_ttc), 0) FROM pur_invoices i WHERE i.order_id = o.id AND i.status = 'approved') AS billed
    FROM pur_orders o WHERE o.org_id = ? AND LOWER(o.category) = LOWER(?) AND o.status IN ${ENGAGED} AND substr(o.order_date, 1, 4) = ? AND o.id <> ?`).all(orgId, category, y, excludeOrderId);
  const engaged = ords.reduce((s, o) => s + Math.max(Number(o.total_ttc) - Number(o.billed), 0), 0);
  return { engaged, invoiced: Number(inv.s) };
}
async function budgetStatus(orgId, category, year, extra = 0, excludeOrderId = 0) {
  const planned = await plannedOf(orgId, category, year);
  if (planned === null) return null;
  const s = await spentOf(orgId, category, year, excludeOrderId);
  const after = s.engaged + s.invoiced + extra;
  return { category, year: String(year), planned, engaged: s.engaged, invoiced: s.invoiced, extra, after, available: planned - after, usedPct: planned > 0 ? Math.round((after / planned) * 1000) / 10 : (after > 0 ? 999 : 0), over: after > planned };
}
/** Contrôle à l'approbation : renvoie l'avertissement ; refuse si le réglage « bloquer » est actif et que l'approbateur n'est pas administrateur ou ne passe pas outre. */
async function budgetGuard(req, category, date, amount, excludeOrderId, override) {
  const b = await budgetStatus(req.org.id, category, String(date || today()).slice(0, 4), amount, excludeOrderId);
  if (!b || !b.over) return b;
  const st = await settings(req.org.id);
  if (st.budgetBlock && !(override === true && A.can(req, 'admin'))) {
    throw new HttpError(400, `Le budget « ${category} » serait dépassé de ${(b.after - b.planned).toLocaleString('fr-FR')} FCFA. Un administrateur peut approuver malgré tout (« passer outre »).`);
  }
  return b;
}

// ---------- Évaluation des fournisseurs ----------
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const r1 = (n) => Math.round(n * 10) / 10;
const GRADE = (s) => (s === null ? '' : s >= 4.5 ? 'Excellent' : s >= 3.5 ? 'Bon' : s >= 2.5 ? 'Moyen' : 'À surveiller');

/** Statistiques et note d'un fournisseur : délais (commandes livrées à la date promise), qualité (reçu accepté / reçu), prix (écart avec le meilleur prix connu), avis saisis. */
async function supplierStats(orgId, supplierId) {
  const orders = await db.prepare("SELECT * FROM pur_orders WHERE org_id = ? AND supplier_id = ? AND status IN ('sent', 'partial', 'received', 'closed') ORDER BY id").all(orgId, supplierId);
  const t = today();
  let onTime = 0; let late = 0; let leadSum = 0; let leadN = 0; const lateOrders = [];
  for (const o of orders) {
    const rc = await db.prepare('SELECT MAX(receipt_date) AS last, MIN(receipt_date) AS first FROM pur_receipts WHERE order_id = ?').get(o.id);
    const lines = await db.prepare('SELECT quantity, received_qty FROM pur_order_lines WHERE order_id = ?').all(o.id);
    const complete = lines.length > 0 && lines.every((l) => Number(l.received_qty) + 1e-9 >= Number(l.quantity));
    const delivered = complete && rc.last ? rc.last : null;
    const start = String(o.sent_at || o.approved_at || o.created_at).slice(0, 10);
    if (delivered) { leadSum += Math.max(daysBetween(start, delivered), 0); leadN++; }
    if (o.expected_date) {
      if (delivered) { if (delivered > o.expected_date) { late++; lateOrders.push(o.id); } else onTime++; }
      else if (o.expected_date < t && o.status !== 'closed') { late++; lateOrders.push(o.id); }
    }
  }
  const q = await db.prepare(`SELECT COALESCE(SUM(l.received_qty), 0) AS ok, COALESCE(SUM(l.rejected_qty), 0) AS ko FROM pur_order_lines l JOIN pur_orders o ON o.id = l.order_id WHERE o.org_id = ? AND o.supplier_id = ?`).get(orgId, supplierId);
  const accepted = Number(q.ok); const rejected = Number(q.ko);
  // Prix : chaque ligne comparée au prix le plus bas payé ou proposé à un autre fournisseur pour le même article.
  const lines = await db.prepare(`SELECT l.item_id, l.unit_price, l.quantity FROM pur_order_lines l JOIN pur_orders o ON o.id = l.order_id WHERE o.org_id = ? AND o.supplier_id = ? AND o.status IN ('approved', 'sent', 'partial', 'received', 'closed') AND l.item_id IS NOT NULL`).all(orgId, supplierId);
  let idxSum = 0; let idxW = 0;
  for (const l of lines) {
    const other = await db.prepare(`SELECT MIN(p) AS p FROM (
      SELECT l2.unit_price AS p FROM pur_order_lines l2 JOIN pur_orders o2 ON o2.id = l2.order_id WHERE o2.org_id = ? AND l2.item_id = ? AND o2.supplier_id <> ? AND o2.status IN ('approved', 'sent', 'partial', 'received', 'closed')
      UNION ALL SELECT unit_price AS p FROM supplier_prices WHERE org_id = ? AND item_id = ? AND supplier_id <> ?) x`).get(orgId, l.item_id, supplierId, orgId, l.item_id, supplierId);
    if (other && other.p !== null && Number(other.p) > 0) { const w = Number(l.quantity) * Number(l.unit_price); idxSum += (Number(l.unit_price) / Number(other.p)) * w; idxW += w; }
  }
  const priceIndex = idxW > 0 ? idxSum / idxW : null;
  const ev = await db.prepare('SELECT COUNT(*) AS n, AVG(delivery_score) AS d, AVG(quality_score) AS q, AVG(price_score) AS p FROM pur_evaluations WHERE org_id = ? AND supplier_id = ?').get(orgId, supplierId);
  const auto = {
    delivery: onTime + late > 0 ? 1 + 4 * (onTime / (onTime + late)) : null,
    quality: accepted + rejected > 0 ? 1 + 4 * (accepted / (accepted + rejected)) : null,
    price: priceIndex === null ? null : clamp(5 - (priceIndex - 1) / 0.05, 1, 5),
  };
  const manual = Number(ev.n) > 0 ? { delivery: Number(ev.d), quality: Number(ev.q), price: Number(ev.p) } : { delivery: null, quality: null, price: null };
  const mix = (k) => { const v = [auto[k], manual[k]].filter((x) => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const scores = { delivery: mix('delivery'), quality: mix('quality'), price: mix('price') };
  const W = { delivery: 0.4, quality: 0.4, price: 0.2 };
  let ws = 0; let acc = 0;
  for (const k of Object.keys(W)) if (scores[k] !== null) { ws += W[k]; acc += W[k] * scores[k]; }
  const score = ws > 0 ? r1(acc / ws) : null;
  const money = await db.prepare("SELECT COALESCE(SUM(total_ttc), 0) AS s, COUNT(*) AS n FROM pur_invoices WHERE org_id = ? AND supplier_id = ? AND status = 'approved'").get(orgId, supplierId);
  return {
    orders: orders.length, onTime, late, lateOrders, onTimeRate: onTime + late > 0 ? Math.round((onTime / (onTime + late)) * 100) : null,
    avgLeadDays: leadN ? r1(leadSum / leadN) : null, accepted: round3(accepted), rejected: round3(rejected), qualityRate: accepted + rejected > 0 ? Math.round((accepted / (accepted + rejected)) * 1000) / 10 : null,
    priceIndex: priceIndex === null ? null : Math.round(priceIndex * 1000) / 1000, evaluations: Number(ev.n), spent: Number(money.s), invoices: Number(money.n),
    scores: { delivery: scores.delivery === null ? null : r1(scores.delivery), quality: scores.quality === null ? null : r1(scores.quality), price: scores.price === null ? null : r1(scores.price) },
    score, grade: GRADE(score),
  };
}

// ---------- Alertes (module Alertes) ----------
async function alertItems(req) {
  if (!A.can(req, 'manager')) return [];
  const o = req.org.id; const t = today(); const out = [];
  const add = (level, title, text, at) => out.push({ level, module: 'purchasing', title, text, at: at || null });
  const reqs = await db.prepare("SELECT COUNT(*) c, MIN(submitted_at) m FROM pur_requests WHERE org_id = ? AND status = 'submitted'").get(o);
  if (Number(reqs.c)) add('info', 'Achats', `${plural(Number(reqs.c), "demande d'achat attend", "demandes d'achat attendent")} votre décision`, reqs.m);
  const ords = await db.prepare("SELECT COUNT(*) c, MIN(created_at) m FROM pur_orders WHERE org_id = ? AND status = 'draft'").get(o);
  if (Number(ords.c)) add('info', 'Achats', `${plural(Number(ords.c), 'bon de commande à approuver', 'bons de commande à approuver')}`, ords.m);
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
  for (const b of await budgetAlerts(o, t.slice(0, 4))) add(b.over ? 'high' : 'medium', 'Achats', b.over ? `Budget « ${b.category} » dépassé de ${(b.after - b.planned).toLocaleString('fr-FR')} FCFA par les achats` : `Budget « ${b.category} » consommé à ${b.usedPct} % par les achats`);
  return out;
}
/** Catégories budgétées dont les achats (engagés + facturés) atteignent 90 % ou plus. */
async function budgetAlerts(orgId, year) {
  const cats = await db.prepare("SELECT DISTINCT category FROM pur_orders WHERE org_id = ? AND category <> '' AND status IN ('approved', 'sent', 'partial', 'received', 'closed') AND substr(order_date, 1, 4) = ?").all(orgId, year);
  const out = [];
  for (const c of cats) { const b = await budgetStatus(orgId, c.category, year); if (b && b.planned > 0 && (b.over || b.usedPct >= 90)) out.push(b); }
  return out;
}

module.exports = { today, addDays, daysBetween, round3, plural, DEFAULTS, APPROVER_ROLES, KINDS, settings, thresholds, requiredRole, approvalError, nextNumber, pct, days, vatRateOf, catOf, cleanLines, lineAmount, totals, supplierOf, projectOf, plannedOf, spentOf, budgetStatus, budgetGuard, budgetAlerts, supplierStats, alertItems, GRADE };
