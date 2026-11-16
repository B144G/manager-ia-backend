'use strict';
// Achats · fournisseurs : fiche enrichie (coordonnées, NIU, RCCM, conditions de paiement, statut actif / bloqué), note calculée (délais, qualité, prix + avis saisis),
// historique des commandes et factures, documents (contrats, attestations : PDF ou image, chiffrés comme les pièces jointes du module Juridique).
// Les fournisseurs restent ceux du module Stock et achats (même table) : une fiche d'achats les complète sans rien casser.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const P = require('./pur-lib');
const X = require('./legal-extra');
const limits = require('../middleware/limits');
const { HttpError, isEmail, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const PARENT = 'pur_supplier';
const MAX_FILE = 2 * 1024 * 1024; const MAX_PER = 10; const MAX_ORG = 40 * 1024 * 1024;
const upLimit = limits.make(10 * 60 * 1000, 40, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");

async function supplierOf(req, id) {
  const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(id, 'Fournisseur invalide.'), req.org.id);
  if (!s) throw new HttpError(404, 'Fournisseur introuvable.');
  return s;
}
const profileView = (p) => ({ email: p ? p.email : '', phone: p ? p.phone : '', address: p ? p.address : '', city: p ? p.city : '', taxId: p ? p.tax_id : '', rccm: p ? p.rccm : '', contactPerson: p ? p.contact_person : '', category: p ? p.category : '',
  paymentDays: p ? Number(p.payment_days) : 30, bankInfo: p ? p.bank_info : '', status: p ? p.status : 'active' });

async function view(req, s, full) {
  const p = await db.prepare('SELECT * FROM pur_supplier_profiles WHERE supplier_id = ?').get(s.id);
  const stats = await P.supplierStats(req.org.id, s.id);
  const out = { id: Number(s.id), name: s.name, contact: s.contact, notes: s.notes, ...profileView(p), blocked: Boolean(p && p.status === 'blocked'), stats };
  if (full) {
    out.orders = (await db.prepare('SELECT id, number, status, order_date, expected_date, total_ttc FROM pur_orders WHERE org_id = ? AND supplier_id = ? ORDER BY id DESC LIMIT 30').all(req.org.id, s.id)).map((o) => ({ id: Number(o.id), number: o.number, status: o.status, orderDate: o.order_date, expectedDate: o.expected_date, totalTtc: Number(o.total_ttc) }));
    out.invoices = (await db.prepare('SELECT id, number, supplier_ref, status, invoice_date, total_ttc FROM pur_invoices WHERE org_id = ? AND supplier_id = ? ORDER BY id DESC LIMIT 30').all(req.org.id, s.id)).map((v) => ({ id: Number(v.id), number: v.number, supplierRef: v.supplier_ref, status: v.status, invoiceDate: v.invoice_date, totalTtc: Number(v.total_ttc) }));
    out.evaluations = (await db.prepare('SELECT e.*, u.name AS author FROM pur_evaluations e LEFT JOIN users u ON u.id = e.created_by WHERE e.org_id = ? AND e.supplier_id = ? ORDER BY e.id DESC LIMIT 30').all(req.org.id, s.id))
      .map((e) => ({ id: Number(e.id), orderId: e.order_id === null ? null : Number(e.order_id), deliveryScore: Number(e.delivery_score), qualityScore: Number(e.quality_score), priceScore: Number(e.price_score), comment: e.comment, author: e.author || '', createdAt: e.created_at }));
    out.documents = (await db.prepare('SELECT id, name, mime, size, created_at FROM legal_files WHERE org_id = ? AND parent_type = ? AND parent_id = ? ORDER BY id').all(req.org.id, PARENT, s.id)).map((f) => ({ id: Number(f.id), name: f.name, mime: f.mime, size: Number(f.size), createdAt: f.created_at }));
    out.sheet = await db.prepare('SELECT i.name AS item, sp.unit_price, sp.lead_days FROM supplier_prices sp JOIN stock_items i ON i.id = sp.item_id WHERE sp.org_id = ? AND sp.supplier_id = ? ORDER BY i.name').all(req.org.id, s.id)
      .then((rows) => rows.map((r) => ({ item: r.item, unitPrice: Number(r.unit_price), leadDays: r.lead_days === null ? null : Number(r.lead_days) })));
  }
  return out;
}

function profileFields(b, cur) {
  const has = (k) => b[k] !== undefined;
  const email = has('email') ? A.text(b.email, 120) : cur ? cur.email : '';
  if (email && !isEmail(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  const status = has('status') ? A.oneOf(b.status, ['active', 'blocked'], undefined, 'Statut : actif ou bloqué.') : cur ? cur.status : 'active';
  return {
    email, phone: has('phone') ? A.text(b.phone, 40) : cur ? cur.phone : '', address: has('address') ? A.text(b.address, 200) : cur ? cur.address : '', city: has('city') ? A.text(b.city, 80) : cur ? cur.city : '',
    taxId: has('taxId') ? A.text(b.taxId, 40) : cur ? cur.tax_id : '', rccm: has('rccm') ? A.text(b.rccm, 40) : cur ? cur.rccm : '', contactPerson: has('contactPerson') ? A.text(b.contactPerson, 100) : cur ? cur.contact_person : '',
    category: has('category') ? A.text(b.category, 60) : cur ? cur.category : '', paymentDays: has('paymentDays') ? P.days(b.paymentDays, 30, 'Délai de paiement') : cur ? Number(cur.payment_days) : 30,
    bankInfo: has('bankInfo') ? A.text(b.bankInfo, 300) : cur ? cur.bank_info : '', status,
  };
}
async function saveProfile(orgId, supplierId, f) {
  await db.prepare(`INSERT INTO pur_supplier_profiles (supplier_id, org_id, email, phone, address, city, tax_id, rccm, contact_person, category, payment_days, bank_info, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (supplier_id) DO UPDATE SET email = EXCLUDED.email, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city, tax_id = EXCLUDED.tax_id, rccm = EXCLUDED.rccm, contact_person = EXCLUDED.contact_person,
    category = EXCLUDED.category, payment_days = EXCLUDED.payment_days, bank_info = EXCLUDED.bank_info, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`)
    .run(supplierId, orgId, f.email, f.phone, f.address, f.city, f.taxId, f.rccm, f.contactPerson, f.category, f.paymentDays, f.bankInfo, f.status, nowISO());
}

router.get('/suppliers', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM suppliers WHERE org_id = ? ORDER BY name COLLATE NOCASE').all(req.org.id);
  const suppliers = []; for (const s of rows) suppliers.push(await view(req, s, false));
  res.json({ suppliers });
});
router.post('/suppliers', async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du fournisseur.' });
  if (await db.prepare('SELECT 1 FROM suppliers WHERE org_id = ? AND LOWER(name) = LOWER(?)').get(req.org.id, name)) throw new HttpError(409, 'Un fournisseur de ce nom existe déjà.');
  const f = profileFields(b, null);
  const id = await db.transaction(async () => {
    const sid = Number((await db.prepare('INSERT INTO suppliers (org_id, name, contact, notes, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, name, A.text(b.contact, 150) || [f.phone, f.email].filter(Boolean).join(' · '), A.text(b.notes, 500), nowISO())).lastInsertRowid);
    await saveProfile(req.org.id, sid, f);
    return sid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Fournisseur « ${name} » ajouté`);
  res.status(201).json({ id });
});
router.get('/suppliers/:id', async (req, res) => res.json({ supplier: await view(req, await supplierOf(req, req.params.id), true) }));
router.put('/suppliers/:id', async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  const b = req.body || {};
  const cur = await db.prepare('SELECT * FROM pur_supplier_profiles WHERE supplier_id = ?').get(s.id);
  const f = profileFields(b, cur);
  const name = b.name === undefined ? s.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du fournisseur.' });
  if (name.toLowerCase() !== s.name.toLowerCase() && await db.prepare('SELECT 1 FROM suppliers WHERE org_id = ? AND LOWER(name) = LOWER(?) AND id <> ?').get(req.org.id, name, s.id)) throw new HttpError(409, 'Un fournisseur de ce nom existe déjà.');
  await db.transaction(async () => {
    await db.prepare('UPDATE suppliers SET name = ?, contact = ?, notes = ? WHERE id = ?').run(name, b.contact === undefined ? s.contact : A.text(b.contact, 150), b.notes === undefined ? s.notes : A.text(b.notes, 500), s.id);
    await saveProfile(req.org.id, s.id, f);
  })();
  if (cur && cur.status !== f.status) await A.logActivity(req.org.id, req.user.id, 'purchasing', `Fournisseur « ${name} » ${f.status === 'blocked' ? 'bloqué' : 'débloqué'}`);
  else await A.logActivity(req.org.id, req.user.id, 'purchasing', `Fiche du fournisseur « ${name} » modifiée`);
  res.json({ ok: true });
});

// ---------- Évaluations ----------
const score = (v, label) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, `${label} : une note entière de 1 à 5.`); return n; };
router.post('/suppliers/:id/evaluations', async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  const b = req.body || {};
  const d = score(b.deliveryScore, 'Respect des délais'); const q = score(b.qualityScore, 'Qualité'); const p = score(b.priceScore, 'Prix');
  let orderId = null;
  if (b.orderId !== undefined && b.orderId !== null && b.orderId !== '') {
    const o = await db.prepare('SELECT id FROM pur_orders WHERE id = ? AND org_id = ? AND supplier_id = ?').get(A.id(b.orderId, 'Commande invalide.'), req.org.id, s.id);
    if (!o) throw new HttpError(400, "Ce bon de commande n'est pas celui de ce fournisseur.");
    orderId = Number(o.id);
  }
  const id = Number((await db.prepare('INSERT INTO pur_evaluations (org_id, supplier_id, order_id, delivery_score, quality_score, price_score, comment, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, s.id, orderId, d, q, p, A.text(b.comment, 500), req.user.id, nowISO())).lastInsertRowid);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Évaluation du fournisseur « ${s.name} » enregistrée`);
  res.status(201).json({ id, stats: await P.supplierStats(req.org.id, s.id) });
});
router.delete('/evaluations/:id', A.need('admin'), async (req, res) => {
  const r = await db.prepare('DELETE FROM pur_evaluations WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Évaluation introuvable.');
  res.json({ ok: true });
});

// ---------- Documents ----------
router.post('/suppliers/:id/documents', upLimit, express.raw({ type: () => true, limit: MAX_FILE + 1024 }), async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const t = X.sniff(buf);
  if (!t) throw new HttpError(400, 'Fichier non reconnu : envoyez un PDF ou une image (JPEG, PNG, WebP).');
  if (buf.length > MAX_FILE) throw new HttpError(413, 'Fichier trop lourd (2 Mo au plus).');
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM legal_files WHERE org_id = ? AND parent_type = ? AND parent_id = ?').get(req.org.id, PARENT, s.id)).c);
  if (n >= MAX_PER) throw new HttpError(403, `Il y a déjà ${MAX_PER} documents sur cette fiche. Supprimez-en un pour en ajouter.`);
  const used = Number((await db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM legal_files WHERE org_id = ?').get(req.org.id)).s);
  if (used + buf.length > MAX_ORG) throw new HttpError(403, "Espace de fichiers plein (40 Mo). Supprimez d'anciens fichiers.");
  const base = cleanText(String(req.query.name || ''), 80).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'document';
  const name = `${base}.${t.ext}`;
  const id = Number((await db.prepare('INSERT INTO legal_files (org_id, parent_type, parent_id, name, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, PARENT, s.id, name, t.mime, buf.length, X.seal(buf), req.user.id, nowISO())).lastInsertRowid);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Document « ${name} » ajouté au fournisseur « ${s.name} »`);
  res.status(201).json({ id, name, mime: t.mime });
});
const docOf = async (req) => {
  const x = await db.prepare('SELECT * FROM legal_files WHERE id = ? AND org_id = ? AND parent_type = ?').get(A.id(req.params.id), req.org.id, PARENT);
  if (!x) throw new HttpError(404, 'Document introuvable.');
  return x;
};
router.get('/documents/:id/file', async (req, res) => {
  const x = await docOf(req);
  const data = X.unseal(x.data);
  if (!data) throw new HttpError(500, 'Ce fichier ne peut pas être relu (clé de chiffrement modifiée).');
  res.set({ 'Content-Type': x.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `attachment; filename="${x.name.replace(/[^A-Za-z0-9._ -]/g, '_')}"` });
  res.end(data);
});
router.delete('/documents/:id', async (req, res) => {
  const x = await docOf(req);
  if (!A.can(req, 'admin') && Number(x.created_by) !== Number(req.user.id)) throw new HttpError(403, 'Seul son auteur ou un administrateur peut supprimer ce document.');
  await db.prepare('DELETE FROM legal_files WHERE id = ?').run(x.id);
  res.json({ ok: true });
});

module.exports = router;
