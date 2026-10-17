'use strict';
// API publique (v1) : lecture et écriture limitées, avec une clé d'API par organisation (en-tête « Authorization: Bearer mia_… »).
// Pour Zapier, Make, n8n ou un site web. La clé n'est jamais stockée en clair ; chaque clé a ses droits (lecture, ou lecture + écriture).
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const wh = require('../services/webhooks');
const { HttpError, cleanText } = require('../util');

const router = express.Router();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const digits = (v) => String(v || '').replace(/\D/g, '');

router.use((req, res, next) => {
  const m = /^Bearer (mia_[a-f0-9]{40})$/.exec(req.get('authorization') || '');
  const k = m ? db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(sha(m[1])) : null;
  if (!k) return res.status(401).json({ error: "Clé d'API absente ou invalide. Envoyez « Authorization: Bearer mia_… »." });
  req.apiKey = k; req.org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(k.org_id);
  if (!req.org) return res.status(401).json({ error: "Clé d'API invalide." });
  db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(nowISO(), k.id);
  next();
});
router.use(limits.make(60 * 1000, 120, 'Trop de requêtes : 120 par minute et par clé.'));
const needWrite = (req) => { if (req.apiKey.scope !== 'write') throw new HttpError(403, "Cette clé est en lecture seule. Créez une clé avec le droit d'écriture."); };
const page = (req) => ({ limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200), after: Math.max(parseInt(req.query.after, 10) || 0, 0) });

router.get('/me', (req, res) => res.json({ organisation: req.org.name, currency: req.org.currency, scope: req.apiKey.scope }));

router.get('/customers', (req, res) => {
  const { limit, after } = page(req);
  const rows = db.prepare('SELECT id, name, phone, email, stage, source, created_at FROM customers WHERE org_id = ? AND id > ? ORDER BY id LIMIT ?').all(req.org.id, after, limit);
  res.json({ data: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, stage: r.stage, source: r.source, created_at: r.created_at })), next: rows.length === limit ? rows[rows.length - 1].id : null });
});
router.post('/customers', (req, res) => {
  needWrite(req);
  const b = req.body || {};
  const name = cleanText(b.name, 100); const phone = cleanText(b.phone, 40); const email = cleanText(b.email, 120);
  if (name.length < 2) throw new HttpError(400, 'Le nom est obligatoire.');
  if (!phone && !email) throw new HttpError(400, 'Indiquez au moins un téléphone ou un e-mail.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'E-mail invalide.');
  if (phone && (digits(phone).length < 8 || digits(phone).length > 15)) throw new HttpError(400, 'Téléphone invalide.');
  const last = digits(phone).slice(-9);
  const dup = last.length >= 8 ? db.prepare('SELECT id, phone FROM customers WHERE org_id = ?').all(req.org.id).find((r) => digits(r.phone).slice(-9) === last) : null;
  if (dup) return res.json({ id: dup.id, created: false });
  const id = db.prepare("INSERT INTO customers (org_id, name, phone, email, notes, stage, source, created_at) VALUES (?, ?, ?, ?, ?, 'prospect', 'api', ?)").run(req.org.id, name, phone, email, cleanText(b.notes, 500), nowISO()).lastInsertRowid;
  wh.emit(req.org.id, 'prospect.created', { id: Number(id), name, phone, email, source: 'api' });
  res.status(201).json({ id: Number(id), created: true });
});
router.get('/orders', (req, res) => {
  const { limit, after } = page(req);
  const rows = db.prepare("SELECT d.id, d.number, d.status, d.total, d.issued, d.note, c.name AS customer, c.phone FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = 'order' AND d.id > ? ORDER BY d.id LIMIT ?").all(req.org.id, after, limit);
  res.json({ data: rows, next: rows.length === limit ? rows[rows.length - 1].id : null });
});
router.get('/invoices', (req, res) => {
  const { limit, after } = page(req);
  const st = ['draft', 'sent', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`SELECT d.id, d.number, d.status, d.total, d.paid, d.issued, d.due, c.name AS customer, c.phone FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = 'invoice' AND d.id > ?${st ? ' AND d.status = ?' : ''} ORDER BY d.id LIMIT ?`).all(...[req.org.id, after, ...(st ? [st] : []), limit]);
  res.json({ data: rows.map((r) => ({ ...r, balance: Math.max(r.total - r.paid, 0) })), next: rows.length === limit ? rows[rows.length - 1].id : null });
});
router.use((req, res) => res.status(404).json({ error: 'Route introuvable.' }));

module.exports = router;
