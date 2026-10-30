'use strict';
// Organisation et procédures · vague 3 : historique des versions d'une procédure, accusé de lecture, révision périodique, postes vacants.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, parseJSON } = require('../util');

const router = express.Router({ mergeParams: true });
const procOf = async (req, id) => {
  const p = await db.prepare('SELECT * FROM processes WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p) throw new HttpError(404, 'Procédure introuvable.');
  return p;
};

router.get('/processes/:id/versions', async (req, res) => {
  const p = await procOf(req, req.params.id);
  const old = await db.prepare('SELECT v.*, u.name AS who FROM process_versions v LEFT JOIN users u ON u.id = v.edited_by WHERE v.process_id = ? ORDER BY v.version DESC').all(p.id);
  res.json({ current: { version: Number(p.version), title: p.title, steps: parseJSON(p.steps, []), updatedAt: p.updated_at },
    versions: old.map((v) => ({ version: Number(v.version), title: v.title, category: v.category, steps: parseJSON(v.steps, []), replacedBy: v.who, replacedAt: v.created_at })) });
});

/** Accusé de lecture de la version en cours. */
router.post('/processes/:id/read', async (req, res) => {
  const p = await procOf(req, req.params.id);
  await db.prepare('INSERT INTO process_reads (process_id, user_id, version, read_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(p.id, req.user.id, p.version, nowISO());
  res.json({ ok: true, version: Number(p.version) });
});
router.get('/processes/:id/reads', A.need('manager'), async (req, res) => {
  const p = await procOf(req, req.params.id);
  const members = await db.prepare('SELECT m.user_id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name').all(req.org.id);
  const reads = new Map((await db.prepare('SELECT user_id, read_at FROM process_reads WHERE process_id = ? AND version = ?').all(p.id, p.version)).map((r) => [Number(r.user_id), r.read_at]));
  res.json({ version: Number(p.version), items: members.map((m) => ({ userId: m.user_id, name: m.name, readAt: reads.get(Number(m.user_id)) || null })) });
});
/** Révision faite : la prochaine échéance repart de la période choisie. */
router.post('/processes/:id/reviewed', async (req, res) => {
  const p = await procOf(req, req.params.id);
  if (!A.can(req, 'admin') && p.owner_id !== req.user.id) throw new HttpError(403, 'Seuls le propriétaire de la procédure et les administrateurs valident la révision.');
  const months = Number(p.review_months || 0);
  const next = months ? (() => { const x = new Date(W.today() + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + months); return x.toISOString().slice(0, 10); })() : null;
  await db.prepare('UPDATE processes SET next_review = ? WHERE id = ?').run(next, p.id);
  await W.audit(req, 'process', p.id, 'reviewed', { nextReview: p.next_review }, { nextReview: next });
  res.json({ ok: true, nextReview: next });
});
router.get('/processes-due', A.need('manager'), async (req, res) => {
  const rows = await db.prepare("SELECT p.id, p.title, p.next_review, u.name AS owner FROM processes p LEFT JOIN users u ON u.id = p.owner_id WHERE p.org_id = ? AND p.next_review IS NOT NULL AND p.next_review <= ? ORDER BY p.next_review").all(req.org.id, W.today());
  res.json({ items: rows.map((r) => ({ id: r.id, title: r.title, nextReview: r.next_review, owner: r.owner })) });
});

/** Postes vacants (sans titulaire) et offre de recrutement liée. */
router.get('/vacancies', async (req, res) => {
  const rows = await db.prepare(`SELECT p.id, p.title, p.description, pp.title AS parent,
      (SELECT j.id FROM hr_jobs j WHERE j.position_id = p.id AND j.status = 'open' LIMIT 1) AS job_id
    FROM positions p LEFT JOIN positions pp ON pp.id = p.parent_id WHERE p.org_id = ? AND p.holder_id IS NULL ORDER BY p.title`).all(req.org.id);
  res.json({ items: rows.map((r) => ({ id: r.id, title: r.title, description: r.description, reportsTo: r.parent, jobId: r.job_id || null })) });
});

module.exports = router;

