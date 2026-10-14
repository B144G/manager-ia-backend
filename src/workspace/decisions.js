'use strict';
// Demandes de validation : une personne soumet, un responsable valide ou refuse (seed du système d'autorisations).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const view = (d) => ({ id: d.id, title: d.title, detail: d.detail, amount: d.amount, status: d.status, requestedBy: d.requested_by, requester: d.requester || null, note: d.note, createdAt: d.created_at, decidedAt: d.decided_at });

function pending(req, limit = 20) {
  const own = A.can(req, 'manager') ? '' : ' AND d.requested_by = ?';
  const args = A.can(req, 'manager') ? [req.org.id] : [req.org.id, req.user.id];
  return db.prepare(`SELECT d.*, u.name AS requester FROM decisions d LEFT JOIN users u ON u.id = d.requested_by WHERE d.org_id = ? AND d.status = 'pending'${own} ORDER BY d.id DESC LIMIT ${limit}`).all(...args).map(view);
}

router.get('/', (req, res) => {
  const status = req.query.status === 'all' ? null : 'pending';
  if (status) return res.json({ decisions: pending(req, 50) });
  const rows = db.prepare(`SELECT d.*, u.name AS requester FROM decisions d LEFT JOIN users u ON u.id = d.requested_by WHERE d.org_id = ? ORDER BY d.id DESC LIMIT 50`).all(req.org.id);
  res.json({ decisions: rows.filter((d) => A.can(req, 'manager') || d.requested_by === req.user.id).map(view) });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const title = A.text(b.title, 120, { required: true, msg: 'Indiquez ce que vous soumettez à validation.' });
  const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : A.amount(b.amount);
  const id = db.prepare('INSERT INTO decisions (org_id, title, detail, amount, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, title, A.text(b.detail, 600), amount, req.user.id, nowISO()).lastInsertRowid;
  A.logActivity(req.org.id, req.user.id, 'dashboard', `Demande de validation : ${title}`);
  res.status(201).json({ id: Number(id) });
});

router.put('/:id', A.need('manager'), (req, res) => {
  const d = db.prepare('SELECT * FROM decisions WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Demande introuvable.');
  if (d.status !== 'pending') throw new HttpError(409, 'Cette demande a déjà été traitée.');
  // Contrôle : un responsable ne valide pas sa propre demande (les administrateurs le peuvent).
  if (d.requested_by === req.user.id && !A.can(req, 'admin')) throw new HttpError(403, 'Vous ne pouvez pas valider votre propre demande.');
  const status = A.oneOf((req.body || {}).status, ['approved', 'rejected'], undefined, 'Choisissez valider ou refuser.');
  db.prepare('UPDATE decisions SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?').run(status, req.user.id, A.text((req.body || {}).note, 200), nowISO(), d.id);
  A.logActivity(req.org.id, req.user.id, 'dashboard', `${status === 'approved' ? 'Décision validée' : 'Décision refusée'} : ${d.title}`);
  res.json({ ok: true });
});

module.exports = router;
module.exports.pending = pending;
