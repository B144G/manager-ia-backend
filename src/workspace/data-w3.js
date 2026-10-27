'use strict';
// Export et import CSV : clients, factures, stock et tickets en export ; clients et stock en import (aperçu avant import, doublons repérés, erreurs ligne par ligne).
// Séparateur « ; » et en-tête UTF-8 pour Excel ; aucune formule exécutée à l'ouverture (cellules protégées).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const D = require('./invoice-doc');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));
const MAX_ROWS = 2000;
const digits = (v) => String(v || '').replace(/\D/g, '');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

router.get('/export/:kind', async (req, res) => {
  const kind = req.params.kind;
  const sc = A.scope(req, 'branch_id');
  let header; let rows; let name;
  if (kind === 'customers') {
    header = ['Nom', 'Téléphone', 'E-mail', 'Statut', 'Source', 'NIU', 'Adresse', 'Consentement marketing', 'Notes']; name = 'clients.csv';
    rows = (await db.prepare(`SELECT * FROM customers WHERE org_id = ?${sc.sql} ORDER BY name`).all(req.org.id, ...sc.args)).map((c) => [c.name, c.phone, c.email, c.stage, c.source, c.niu, c.address, Number(c.marketing_consent) ? 'oui' : 'non', c.notes]);
  } else if (kind === 'invoices') {
    header = ['Numéro', 'Type', 'Statut', 'Client', 'Date', 'Échéance', 'Total HT', 'TVA', 'Total TTC', 'Payé', 'Avoirs', 'Reste à payer']; name = 'factures.csv';
    rows = (await db.prepare(`SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind IN ('invoice','credit')${sc.sql.replace(/branch_id/g, 'd.branch_id')} ORDER BY d.id`).all(req.org.id, ...sc.args))
      .map((d) => { const a = D.amounts(d, req.org); return [d.number, d.kind === 'credit' ? 'Avoir' : 'Facture', d.status, d.customer, d.issued, d.due || '', a.ht, a.vat, d.total, d.paid, d.credited, d.kind === 'invoice' ? Math.max(d.total - d.credited - d.paid, 0) : '']; });
  } else if (kind === 'stock') {
    header = ['Article', 'SKU', 'Code-barres', 'Unité', 'Quantité', 'Seuil minimum', 'Coût unitaire']; name = 'stock.csv';
    rows = (await require('./stock').items(req)).map((i) => [i.name, i.sku, i.barcode, i.unit, i.quantity, i.min_quantity, i.unit_cost]);
  } else if (kind === 'tickets') {
    header = ['Référence', 'Date', 'Client', 'Contact', 'Canal', 'Sujet', 'Statut', 'Priorité', 'Assigné à', 'Première réponse', 'Résolu le', 'Satisfaction']; name = 'tickets.csv';
    rows = (await db.prepare(`SELECT t.*, u.name AS assignee FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.org_id = ?${sc.sql.replace(/branch_id/g, 't.branch_id')} ORDER BY t.id`).all(req.org.id, ...sc.args))
      .map((t) => [t.ref, t.created_at.slice(0, 10), t.customer_name, t.customer_contact, t.channel, t.subject, t.status, t.priority, t.assignee || '', t.first_response_at || '', t.resolved_at || '', t.csat || '']);
  } else throw new HttpError(404, 'Export inconnu (customers, invoices, stock ou tickets).');
  await W.audit(req, 'export', null, kind, null, { rows: rows.length });
  W.sendCsv(res, name, header, rows);
});

/** Lit le CSV envoyé en JSON ({ csv }) et associe les colonnes par leur nom (français ou anglais, accents ignorés). */
function table(body, aliases) {
  const text = typeof (body || {}).csv === 'string' ? body.csv : '';
  if (!text.trim()) throw new HttpError(400, 'Collez ou chargez le contenu du fichier CSV.');
  const rows = W.parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'Le fichier doit contenir une ligne d\'en-tête puis au moins une ligne de données.');
  if (rows.length - 1 > MAX_ROWS) throw new HttpError(400, `${MAX_ROWS} lignes au maximum par import.`);
  const head = rows[0].map(norm); const idx = {};
  for (const [key, names] of Object.entries(aliases)) { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) idx[key] = i; }
  return { idx, rows: rows.slice(1) };
}
const cellOf = (r, idx, k) => (idx[k] === undefined ? '' : String(r[idx[k]] || '').trim());

router.post('/import/customers', async (req, res) => {
  const { idx, rows } = table(req.body, { name: ['nom', 'name', 'client', 'nomduclient'], phone: ['telephone', 'tel', 'phone', 'mobile', 'portable'], email: ['email', 'mail', 'courriel'], notes: ['notes', 'note', 'commentaire'], niu: ['niu'], address: ['adresse', 'address'] });
  if (idx.name === undefined) throw new HttpError(400, 'Colonne « Nom » introuvable dans l\'en-tête.');
  const dry = Boolean((req.body || {}).dryRun);
  const existing = await db.prepare('SELECT email, phone FROM customers WHERE org_id = ?').all(req.org.id);
  const seenMail = new Set(existing.map((c) => String(c.email).trim().toLowerCase()).filter(Boolean)); const seenPhone = new Set(existing.map((c) => digits(c.phone).slice(-9)).filter((p) => p.length >= 8));
  const errors = []; let created = 0; let duplicates = 0;
  const branch = A.can(req, 'admin') ? null : req.member.branch_id;
  await db.transaction(async () => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; const line = i + 2;
      const name = cellOf(r, idx, 'name'); const phone = cellOf(r, idx, 'phone'); const email = cellOf(r, idx, 'email').toLowerCase();
      if (name.length < 2) { errors.push({ line, message: 'Nom manquant.' }); continue; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { errors.push({ line, message: 'E-mail invalide.' }); continue; }
      if (phone && (digits(phone).length < 8 || digits(phone).length > 15)) { errors.push({ line, message: 'Téléphone invalide.' }); continue; }
      const p9 = digits(phone).slice(-9);
      if ((email && seenMail.has(email)) || (p9.length >= 8 && seenPhone.has(p9))) { duplicates++; continue; }
      if (email) seenMail.add(email); if (p9.length >= 8) seenPhone.add(p9);
      created++;
      if (!dry) await db.prepare("INSERT INTO customers (org_id, branch_id, name, phone, email, notes, niu, address, stage, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prospect', 'import', ?)")
        .run(req.org.id, branch, A.text(name, 100), A.text(phone, 40), email, A.text(cellOf(r, idx, 'notes'), 800), A.text(cellOf(r, idx, 'niu'), 40), A.text(cellOf(r, idx, 'address'), 300), nowISO());
    }
  })();
  if (!dry) { await W.audit(req, 'import', null, 'customers', null, { created, duplicates, errors: errors.length }); await A.logActivity(req.org.id, req.user.id, 'crm', `Import de clients : ${created} créé(s)`); }
  res.json({ dryRun: dry, created, duplicates, errors: errors.slice(0, 50), errorCount: errors.length, note: "Le consentement marketing n'est jamais importé : il se recueille client par client." });
});

router.post('/import/stock', async (req, res) => {
  const { idx, rows } = table(req.body, { name: ['article', 'nom', 'name', 'designation', 'produit'], unit: ['unite', 'unit'], quantity: ['quantite', 'quantity', 'qte', 'stock'], min: ['seuilminimum', 'seuil', 'min', 'minimum', 'seuilmin'], cost: ['coutunitaire', 'cout', 'cost', 'prixachat'], sku: ['sku', 'reference', 'ref'], barcode: ['codebarres', 'codebarre', 'barcode', 'ean'] });
  if (idx.name === undefined) throw new HttpError(400, 'Colonne « Article » introuvable dans l\'en-tête.');
  const dry = Boolean((req.body || {}).dryRun);
  const L = require('./stock-lib');
  const have = await db.prepare('SELECT sku, barcode, name FROM stock_items WHERE org_id = ?').all(req.org.id);
  const skus = new Set(have.map((i) => i.sku).filter(Boolean)); const codes = new Set(have.map((i) => i.barcode).filter(Boolean)); const names = new Set(have.map((i) => i.name.toLowerCase()));
  const errors = []; let created = 0; let duplicates = 0;
  const num = (v) => { if (v === '') return 0; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : NaN; };
  await db.transaction(async () => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; const line = i + 2;
      const name = cellOf(r, idx, 'name'); const sku = cellOf(r, idx, 'sku'); const barcode = cellOf(r, idx, 'barcode');
      if (!name) { errors.push({ line, message: "Nom de l'article manquant." }); continue; }
      const q = num(cellOf(r, idx, 'quantity')); const min = num(cellOf(r, idx, 'min')); const cost = num(cellOf(r, idx, 'cost'));
      if ([q, min, cost].some(Number.isNaN)) { errors.push({ line, message: 'Quantité, seuil ou coût invalide.' }); continue; }
      if (barcode && !/^[A-Za-z0-9._-]{4,40}$/.test(barcode)) { errors.push({ line, message: 'Code-barres invalide.' }); continue; }
      if ((sku && skus.has(sku)) || (barcode && codes.has(barcode)) || (!sku && !barcode && names.has(name.toLowerCase()))) { duplicates++; continue; }
      if (sku) skus.add(sku); if (barcode) codes.add(barcode); names.add(name.toLowerCase());
      created++;
      if (!dry) {
        const iid = Number((await db.prepare("INSERT INTO stock_items (org_id, branch_id, name, unit, quantity, min_quantity, unit_cost, created_at, sku, barcode, max_quantity, tracking, pick_rule, avg_cost) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, 'none', 'fefo', ?)")
          .run(req.org.id, A.can(req, 'admin') ? null : req.member.branch_id, A.text(name, 120), A.text(cellOf(r, idx, 'unit'), 20) || 'pièce', min, Math.round(cost), nowISO(), A.text(sku, 40), barcode, Math.round(cost))).lastInsertRowid);
        if (q > 0) await L.adjust(req, iid, q, 'Stock de départ (import CSV)', { unitCost: Math.round(cost) || undefined, lotNo: 'INITIAL' });
      }
    }
  })();
  if (!dry) { await W.audit(req, 'import', null, 'stock', null, { created, duplicates, errors: errors.length }); await A.logActivity(req.org.id, req.user.id, 'stock', `Import de stock : ${created} article(s)`); }
  res.json({ dryRun: dry, created, duplicates, errors: errors.slice(0, 50), errorCount: errors.length });
});

module.exports = router;
