'use strict';
// Achats (4/5) : fiches fournisseurs (les mêmes que dans « Stock et achats »), évaluation (ponctualité, qualité, prix, avis), documents chiffrés.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const P = require('./purchasing-lib');
const X = require('./legal-extra');
const limits = require('../middleware/limits');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const MAX_DOC = 2 * 1024 * 1024;
const upLimit = limits.make(10 * 60 * 1000, 40, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");

async function supplierOf(req, idv) {
  const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!s) throw new HttpError(404, 'Fournisseur introuvable.');
  return s;
}

/** Statistiques d'un fournisseur : ponctualité, délai moyen, qualité, indice de prix, dépenses, note globale sur 5. */
async function statsOf(orgId, s) {
  const orders = await db.prepare("SELECT * FROM pur_orders WHERE supplier_id = ? AND org_id = ? AND status NOT IN ('draft','cancelled')").all(s.id, orgId);
  let onTime = 0; let timed = 0; const leads = [];
  for (const o of orders) {
    const r = await db.prepare('SELECT MIN(date) AS first, MAX(date) AS last FROM pur_receipts WHERE order_id = ?').get(o.id);
    if (r && r.first) leads.push(Math.max(0, (new Date(r.first + 'T00:00:00Z') - new Date(o.order_date + 'T00:00:00Z')) / 86400000));
    if (o.expected_date && ['received', 'closed'].includes(o.status) && r && r.last) { timed++; if (r.last <= o.expected_date) onTime++; } else if (P.isLate(o)) timed++;
  }
  const q = await db.prepare(`SELECT COALESCE(SUM(rl.received_qty - rl.insp_rejected), 0) AS a, COALESCE(SUM(rl.rejected_qty + rl.insp_rejected), 0) AS j FROM pur_receipt_lines rl JOIN pur_receipts r ON r.id = rl.receipt_id JOIN pur_orders o ON o.id = r.order_id WHERE o.supplier_id = ? AND o.org_id = ?`).get(s.id, orgId);
  const accepted = Number(q.a); const rejected = Number(q.j);
  // Indice de prix : prix payé / meilleur prix connu (tous fournisseurs) pour les mêmes articles. 1,00 = le moins cher.
  const pl = await db.prepare(`SELECT l.item_id, l.unit_price FROM pur_order_lines l JOIN pur_orders o ON o.id = l.order_id WHERE o.supplier_id = ? AND o.org_id = ? AND o.status NOT IN ('draft','cancelled') AND l.item_id IS NOT NULL AND l.unit_price > 0`).all(s.id, orgId);
  const ratios = [];
  for (const l of pl) {
    const best = await db.prepare(`SELECT MIN(p) AS m FROM (SELECT l2.unit_price AS p FROM pur_order_lines l2 JOIN pur_orders o2 ON o2.id = l2.order_id WHERE o2.org_id = ? AND l2.item_id = ? AND l2.unit_price > 0 AND o2.status NOT IN ('draft','cancelled')
      UNION ALL SELECT unit_price AS p FROM supplier_prices WHERE item_id = ? AND unit_price > 0) x`).get(orgId, l.item_id, l.item_id);
    if (best && Number(best.m) > 0) ratios.push(Number(l.unit_price) / Number(best.m));
  }
  const spentRows = await db.prepare("SELECT * FROM pur_invoices WHERE supplier_id = ? AND org_id = ? AND status = 'approved'").all(s.id, orgId);
  let spent = 0; for (const i of spentRows) spent += (await P.invoiceTotalsOf(i)).ttc;
  const ev = await db.prepare('SELECT COUNT(*) AS n, AVG(delivery_score) AS d, AVG(quality_score) AS q, AVG(price_score) AS p FROM pur_evaluations WHERE supplier_id = ?').get(s.id);
  const nEv = Number(ev.n) || 0;
  const onTimeRate = timed ? Math.round((onTime / timed) * 100) : null;
  const qualityRate = accepted + rejected > 0 ? Math.round((accepted / (accepted + rejected)) * 100) : null;
  const priceIndex = ratios.length ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100) / 100 : null;
  const mix = (measured, evalAvg) => { const v = [measured, evalAvg].filter((x) => x !== null && x !== undefined && Number.isFinite(x)); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const scores = {
    delivery: mix(onTimeRate === null ? null : onTimeRate / 20, nEv ? Number(ev.d) : null),
    quality: mix(qualityRate === null ? null : qualityRate / 20, nEv ? Number(ev.q) : null),
    price: mix(priceIndex === null ? null : Math.max(0, Math.min(5, 5 - (priceIndex - 1) * 10)), nEv ? Number(ev.p) : null),
  };
  const parts = Object.values(scores).filter((x) => x !== null);
  return {
    orders: orders.length, spent, score: parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 10) / 10 : null,
    onTimeRate, avgLeadDays: leads.length ? Math.round((leads.reduce((a, b) => a + b, 0) / leads.length) * 10) / 10 : null, qualityRate, priceIndex, scores, evaluations: nEv,
  };
}

router.get('/suppliers', mgr, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM suppliers WHERE org_id = ? ORDER BY LOWER(name)').all(req.org.id);
  const out = [];
  for (const s of rows) {
    const st = await statsOf(req.org.id, s);
    out.push({ id: Number(s.id), name: s.name, blocked: Boolean(Number(s.blocked)), category: s.category || null, city: s.city || null, phone: s.phone || null, email: s.email || null, paymentDays: s.payment_days === null ? null : Number(s.payment_days), stats: { orders: st.orders, spent: st.spent, score: st.score } });
  }
  res.json({ suppliers: out });
});
router.get('/suppliers/:id', mgr, async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  const orders = [];
  for (const o of await db.prepare('SELECT * FROM pur_orders WHERE supplier_id = ? ORDER BY id DESC LIMIT 50').all(s.id)) orders.push({ id: Number(o.id), number: o.number, orderDate: o.order_date, status: o.status, totalTtc: (await P.orderTotalsOf(o)).ttc });
  const invoices = [];
  for (const i of await db.prepare("SELECT * FROM pur_invoices WHERE supplier_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 50").all(s.id)) invoices.push({ id: Number(i.id), number: i.number, supplierRef: i.supplier_ref, invoiceDate: i.invoice_date, status: i.status, totalTtc: (await P.invoiceTotalsOf(i)).ttc });
  const evs = await db.prepare('SELECT e.*, u.name AS author FROM pur_evaluations e LEFT JOIN users u ON u.id = e.author_id WHERE e.supplier_id = ? ORDER BY e.id DESC').all(s.id);
  const docs = await db.prepare('SELECT id, name, mime, size, created_at FROM pur_documents WHERE supplier_id = ? ORDER BY id DESC').all(s.id);
  res.json({ supplier: {
    id: Number(s.id), name: s.name, contactPerson: s.contact_person, email: s.email, phone: s.phone, address: s.address, city: s.city, taxId: s.tax_id, rccm: s.rccm, category: s.category,
    paymentDays: s.payment_days === null ? null : Number(s.payment_days), bankInfo: s.bank_info, notes: s.notes, blocked: Boolean(Number(s.blocked)),
    stats: await statsOf(req.org.id, s), orders, invoices,
    evaluations: evs.map((e) => ({ id: Number(e.id), createdAt: e.created_at, author: e.author || '', deliveryScore: Number(e.delivery_score), qualityScore: Number(e.quality_score), priceScore: Number(e.price_score), comment: e.comment || null })),
    documents: docs.map((d) => ({ id: Number(d.id), name: d.name, mime: d.mime, size: Number(d.size), createdAt: d.created_at })),
  } });
});

async function readSupplier(req, b, cur) {
  const pick = (k, max) => (b[k] === undefined && cur ? undefined : cleanText(String(b[k] || ''), max));
  const name = b.name === undefined && cur ? cur.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du fournisseur.' });
  const dup = await db.prepare('SELECT id FROM suppliers WHERE org_id = ? AND LOWER(name) = LOWER(?) AND id != ?').get(req.org.id, name, cur ? cur.id : 0);
  if (dup) throw new HttpError(409, 'Un fournisseur de ce nom existe déjà.');
  const email = pick('email', 150);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  let pd;
  if (b.paymentDays === undefined) pd = cur ? cur.payment_days : null;
  else if (b.paymentDays === null || b.paymentDays === '') pd = null;
  else { pd = Number(b.paymentDays); if (!Number.isInteger(pd) || pd < 0 || pd > 365) throw new HttpError(400, 'Délai de paiement : entre 0 et 365 jours.'); }
  const blocked = b.status === undefined ? (cur ? Number(cur.blocked) : 0) : b.status === 'blocked' ? 1 : 0;
  const v = { name, contact_person: pick('contactPerson', 100), email, phone: pick('phone', 40), address: pick('address', 200), city: pick('city', 80), tax_id: pick('taxId', 40), rccm: pick('rccm', 40), category: pick('category', 60), bank_info: pick('bankInfo', 300), notes: pick('notes', 500), payment_days: pd, blocked };
  if (cur) for (const k of Object.keys(v)) if (v[k] === undefined) v[k] = cur[k];
  return v;
}
router.post('/suppliers', mgr, async (req, res) => {
  const v = await readSupplier(req, req.body || {});
  const id = Number((await db.prepare(`INSERT INTO suppliers (org_id, name, contact, notes, created_at, contact_person, email, phone, address, city, tax_id, rccm, category, payment_days, bank_info, blocked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.org.id, v.name, v.email || v.phone || '', v.notes || '', nowISO(), v.contact_person || '', v.email || '', v.phone || '', v.address || '', v.city || '', v.tax_id || '', v.rccm || '', v.category || '', v.payment_days, v.bank_info || '', v.blocked)).lastInsertRowid);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Fournisseur « ${v.name} » ajouté`);
  res.status(201).json({ id });
});
router.put('/suppliers/:id', mgr, async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  const v = await readSupplier(req, req.body || {}, s);
  await db.prepare('UPDATE suppliers SET name = ?, contact = ?, notes = ?, contact_person = ?, email = ?, phone = ?, address = ?, city = ?, tax_id = ?, rccm = ?, category = ?, payment_days = ?, bank_info = ?, blocked = ? WHERE id = ?')
    .run(v.name, v.email || v.phone || s.contact || '', v.notes || '', v.contact_person || '', v.email || '', v.phone || '', v.address || '', v.city || '', v.tax_id || '', v.rccm || '', v.category || '', v.payment_days, v.bank_info || '', v.blocked, s.id);
  if (v.blocked !== Number(s.blocked)) await A.logActivity(req.org.id, req.user.id, 'purchasing', `Fournisseur « ${v.name} » ${v.blocked ? 'bloqué' : 'débloqué'}`);
  res.json({ ok: true });
});

// ---------- Évaluations ----------
router.post('/suppliers/:id/evaluations', mgr, async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  const b = req.body || {};
  const sc = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, 'Chaque note va de 1 à 5.'); return n; };
  const id = Number((await db.prepare('INSERT INTO pur_evaluations (org_id, supplier_id, author_id, delivery_score, quality_score, price_score, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, s.id, req.user.id, sc(b.deliveryScore), sc(b.qualityScore), sc(b.priceScore), cleanText(String(b.comment || ''), 500), nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.delete('/evaluations/:id', A.need('admin'), async (req, res) => {
  const r = await db.prepare('DELETE FROM pur_evaluations WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Évaluation introuvable.');
  res.json({ ok: true });
});

// ---------- Documents (PDF ou image, 2 Mo, chiffrés) ----------
router.post('/suppliers/:id/documents', mgr, upLimit, express.raw({ type: () => true, limit: MAX_DOC + 1024 }), async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const t = X.sniff(buf);
  if (!t) throw new HttpError(400, 'Fichier non reconnu : envoyez un PDF ou une image (JPEG, PNG, WebP).');
  if (buf.length > MAX_DOC) throw new HttpError(413, 'Fichier trop lourd (2 Mo au plus).');
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM pur_documents WHERE supplier_id = ?').get(s.id)).c);
  if (n >= 30) throw new HttpError(403, 'Il y a déjà 30 documents pour ce fournisseur. Supprimez-en un pour en ajouter.');
  const base = cleanText(String(req.query.name || ''), 80).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'document';
  const name = `${base}.${t.ext}`;
  const id = Number((await db.prepare('INSERT INTO pur_documents (org_id, supplier_id, name, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, s.id, name, t.mime, buf.length, X.seal(buf), req.user.id, nowISO())).lastInsertRowid);
  res.status(201).json({ id, name });
});
router.get('/documents/:id/file', mgr, async (req, res) => {
  const d = await db.prepare('SELECT * FROM pur_documents WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Document introuvable.');
  const data = X.unseal(d.data);
  if (!data) throw new HttpError(500, 'Fichier illisible.');
  res.set({ 'Content-Type': d.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `attachment; filename="${d.name.replace(/[^A-Za-z0-9._ -]/g, '_')}"` });
  res.end(data);
});
router.delete('/documents/:id', mgr, async (req, res) => {
  const r = await db.prepare('DELETE FROM pur_documents WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Document introuvable.');
  res.json({ ok: true });
});

module.exports = router;
module.exports.statsOf = statsOf;
