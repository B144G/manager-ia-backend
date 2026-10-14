'use strict';
// Sous-application « Service client » : boîte de tickets (formulaire public, saisie manuelle, réponses de l'équipe).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const STATUS = ['open', 'pending', 'resolved'];
const PRIORITY = ['low', 'normal', 'high'];
const CHANNELS = ['manuel', 'formulaire', 'whatsapp', 'messenger', 'instagram', 'email', 'telephone'];

const row = (t) => ({ id: t.id, customerName: t.customer_name, customerContact: t.customer_contact, channel: t.channel, subject: t.subject, status: t.status, priority: t.priority, assigneeId: t.assignee_id, assignee: t.assignee || null, branchId: t.branch_id, createdAt: t.created_at, updatedAt: t.updated_at });

function getTicket(req, id) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!t || !A.visible(req, t)) throw new HttpError(404, 'Demande introuvable.');
  return t;
}

router.get('/', (req, res) => {
  const sc = A.scope(req, 't.branch_id');
  const where = ['t.org_id = ?'];
  const args = [req.org.id];
  if (req.query.status) { where.push('t.status = ?'); args.push(A.oneOf(req.query.status, STATUS)); }
  const rows = db.prepare(`SELECT t.*, u.name AS assignee FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE ${where.join(' AND ')}${sc.sql}
    ORDER BY (t.status = 'resolved'), CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 200`).all(...args, ...sc.args);
  const counts = db.prepare(`SELECT status, COUNT(*) c FROM tickets t WHERE org_id = ?${sc.sql} GROUP BY status`).all(req.org.id, ...sc.args);
  res.json({ tickets: rows.map(row), counts: Object.fromEntries(counts.map((c) => [c.status, c.c])) });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const now = nowISO();
  const name = A.text(b.customerName, 100, { required: true, msg: 'Indiquez le nom du client.' });
  const message = A.text(b.message, 2000);
  const subject = A.text(b.subject, 150) || message.slice(0, 80);
  if (!subject) throw new HttpError(400, 'Indiquez le sujet de la demande.');
  const id = db.transaction(() => {
    const tid = db.prepare('INSERT INTO tickets (org_id, branch_id, customer_name, customer_contact, channel, subject, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, A.branchOf(req, b.branchId) || (A.can(req, 'admin') ? null : req.member.branch_id), name, A.text(b.customerContact, 120), A.oneOf(b.channel, CHANNELS, 'manuel'), subject, A.oneOf(b.priority, PRIORITY, 'normal'), now, now).lastInsertRowid;
    if (message) db.prepare("INSERT INTO ticket_messages (ticket_id, author, user_id, content, created_at) VALUES (?, 'customer', NULL, ?, ?)").run(tid, message, now);
    return Number(tid);
  })();
  A.logActivity(req.org.id, req.user.id, 'support', `Nouvelle demande de ${name}`);
  res.status(201).json({ id });
});

router.get('/:id', (req, res) => {
  const t = getTicket(req, req.params.id);
  const msgs = db.prepare(`SELECT m.id, m.author, m.content, m.created_at AS at, u.name AS who FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id`).all(t.id);
  res.json({ ticket: row(t), messages: msgs });
});

router.post('/:id/messages', (req, res) => {
  const t = getTicket(req, req.params.id);
  const b = req.body || {};
  const content = A.text(b.content, 3000, { required: true, msg: 'Écrivez un message.' });
  const author = b.author === 'customer' ? 'customer' : 'staff'; // « customer » : on note ce que le client a répondu par un autre canal
  const now = nowISO();
  db.transaction(() => {
    db.prepare('INSERT INTO ticket_messages (ticket_id, author, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)').run(t.id, author, author === 'staff' ? req.user.id : null, content, now);
    db.prepare('UPDATE tickets SET updated_at = ?, status = ?, assignee_id = COALESCE(assignee_id, ?) WHERE id = ?')
      .run(now, author === 'staff' && t.status === 'open' ? 'pending' : author === 'customer' && t.status !== 'open' ? 'open' : t.status, author === 'staff' ? req.user.id : null, t.id);
  })();
  res.status(201).json({ ok: true });
});

router.put('/:id', (req, res) => {
  const t = getTicket(req, req.params.id);
  const b = req.body || {};
  const assignee = b.assigneeId === undefined ? t.assignee_id : A.memberOf(req, b.assigneeId);
  const status = b.status === undefined ? t.status : A.oneOf(b.status, STATUS);
  db.prepare('UPDATE tickets SET status = ?, priority = ?, assignee_id = ?, updated_at = ? WHERE id = ?')
    .run(status, b.priority === undefined ? t.priority : A.oneOf(b.priority, PRIORITY), assignee, nowISO(), t.id);
  if (status === 'resolved' && t.status !== 'resolved') A.logActivity(req.org.id, req.user.id, 'support', `Demande résolue : ${t.subject}`);
  res.json({ ok: true });
});

router.delete('/:id', A.need('manager'), (req, res) => {
  const t = getTicket(req, req.params.id);
  db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

module.exports = router;
