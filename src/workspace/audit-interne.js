'use strict';
// Sous-application « Audit interne » : missions d'audit planifiées, constats (fiches de non-conformité rattachées à l'audit), conclusion.
// Séparation des tâches : l'auditeur constate mais ne clôture jamais ses propres constats (clôture par un responsable, voir qhse.js).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const STATUSES = ['planned', 'in_progress', 'done'];

const nameOf = async (orgId, id) => (id ? (await db.prepare('SELECT u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.id = ?').get(orgId, id) || {}).name || '' : '');
const view = async (orgId, a) => {
  const c = await db.prepare("SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status <> 'closed') open FROM qhse_items WHERE org_id = ? AND audit_id = ?").get(orgId, a.id);
  return { id: Number(a.id), title: a.title, scope: a.scope, plannedDate: a.planned_date, auditorId: a.auditor_id ? Number(a.auditor_id) : null, auditorName: await nameOf(orgId, a.auditor_id), status: a.status, conclusion: a.conclusion, doneAt: a.done_at, findings: Number(c.total), openFindings: Number(c.open) };
};
const auditOf = async (req, id) => {
  const a = await db.prepare('SELECT * FROM aud_audits WHERE id = ? AND org_id = ?').get(A.id(id, 'Audit invalide.'), req.org.id);
  if (!a) throw new HttpError(404, 'Audit introuvable.');
  return a;
};
const mgr = (req) => A.can(req, 'manager');

async function stats(orgId) {
  const one = async (sql, ...a) => Number((await db.prepare(sql).get(orgId, ...a)).c);
  return {
    planned: await one("SELECT COUNT(*) c FROM aud_audits WHERE org_id = ? AND status <> 'done'"),
    done: await one("SELECT COUNT(*) c FROM aud_audits WHERE org_id = ? AND status = 'done'"),
    openFindings: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND audit_id IS NOT NULL AND status <> 'closed'"),
  };
}

router.get('/', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM aud_audits WHERE org_id = ? ORDER BY (status = \'done\'), id DESC LIMIT 200').all(req.org.id);
  res.json({ audits: await Promise.all(rows.map((a) => view(req.org.id, a))), stats: await stats(req.org.id), canManage: mgr(req) });
});

router.post('/', async (req, res) => {
  if (!mgr(req)) throw new HttpError(403, 'Seul un responsable peut planifier un audit.');
  const b = req.body || {}; const t = nowISO();
  const id = Number((await db.prepare('INSERT INTO aud_audits (org_id, title, scope, planned_date, auditor_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, A.text(b.title, 160, { required: true, msg: "Indiquez l'objet de l'audit." }), A.text(b.scope, 1000), A.date(b.plannedDate) || null, A.idOrNull(b.auditorId), 'planned', req.user.id, t, t)).lastInsertRowid);
  await A.logActivity(req.org.id, req.user.id, 'audit_interne', `Audit planifié : ${b.title}`);
  res.status(201).json({ id });
});

router.get('/:id', async (req, res) => {
  const a = await auditOf(req, req.params.id);
  const f = await db.prepare('SELECT id, ref, title, detail, severity, status, due_date, corrective FROM qhse_items WHERE org_id = ? AND audit_id = ? ORDER BY id').all(req.org.id, a.id);
  res.json({ audit: await view(req.org.id, a), findings: f.map((x) => ({ id: Number(x.id), ref: x.ref, title: x.title, detail: x.detail, severity: x.severity, status: x.status, dueDate: x.due_date, corrective: x.corrective })) });
});

router.put('/:id', async (req, res) => {
  if (!mgr(req)) throw new HttpError(403, 'Seul un responsable peut modifier un audit.');
  const a = await auditOf(req, req.params.id); const b = req.body || {};
  if (a.status === 'done') throw new HttpError(409, 'Cet audit est terminé.');
  await db.prepare('UPDATE aud_audits SET title = ?, scope = ?, planned_date = ?, auditor_id = ?, status = ?, updated_at = ? WHERE id = ?').run(
    b.title !== undefined ? A.text(b.title, 160, { required: true, msg: "Indiquez l'objet de l'audit." }) : a.title, b.scope !== undefined ? A.text(b.scope, 1000) : a.scope,
    b.plannedDate !== undefined ? (A.date(b.plannedDate) || null) : a.planned_date, b.auditorId !== undefined ? A.idOrNull(b.auditorId) : a.auditor_id,
    b.status !== undefined ? A.oneOf(b.status, ['planned', 'in_progress'], undefined, 'Statut inconnu (la fin a sa propre action).') : a.status, nowISO(), a.id);
  res.json({ ok: true });
});

/** Constat : l'auditeur désigné (ou un administrateur) consigne un constat ; il devient une fiche de non-conformité rattachée à l'audit. */
router.post('/:id/findings', async (req, res) => {
  const a = await auditOf(req, req.params.id); const b = req.body || {};
  if (a.status === 'done') throw new HttpError(409, 'Cet audit est terminé.');
  if (!(Number(a.auditor_id) === req.user.id || A.can(req, 'admin'))) throw new HttpError(403, "Seul l'auditeur désigné consigne les constats.");
  const t = nowISO();
  const id = Number((await db.prepare("INSERT INTO qhse_items (org_id, kind, title, detail, place, audit_id, severity, status, declared_by, assignee_id, due_date, created_at, updated_at) VALUES (?, 'nonconformity', ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)")
    .run(req.org.id, A.text(b.title, 160, { required: true, msg: 'Indiquez le constat.' }), A.text(b.detail, 2000), A.text(a.title, 120), a.id, A.oneOf(b.severity, ['low', 'normal', 'high', 'critical'], 'normal', 'Gravité inconnue.'), req.user.id, A.idOrNull(b.assigneeId), A.date(b.dueDate) || null, t, t)).lastInsertRowid);
  await db.prepare('UPDATE qhse_items SET ref = ? WHERE id = ?').run('NC-' + String(id).padStart(4, '0'), id);
  if (a.status === 'planned') await db.prepare("UPDATE aud_audits SET status = 'in_progress', updated_at = ? WHERE id = ?").run(t, a.id);
  await A.logActivity(req.org.id, req.user.id, 'audit_interne', `Constat d'audit : ${b.title}`);
  res.status(201).json({ id });
});

router.post('/:id/complete', async (req, res) => {
  const a = await auditOf(req, req.params.id);
  if (!(Number(a.auditor_id) === req.user.id || A.can(req, 'admin'))) throw new HttpError(403, "Seul l'auditeur désigné conclut l'audit.");
  if (a.status === 'done') throw new HttpError(409, 'Cet audit est déjà terminé.');
  const t = nowISO();
  await db.prepare("UPDATE aud_audits SET status = 'done', conclusion = ?, done_at = ?, updated_at = ? WHERE id = ?").run(A.text((req.body || {}).conclusion, 4000), t, t, a.id);
  await A.logActivity(req.org.id, req.user.id, 'audit_interne', `Audit terminé : ${a.title}`);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const a = await auditOf(req, req.params.id);
  if (!A.can(req, 'admin')) throw new HttpError(403, 'Seul un administrateur peut supprimer un audit.');
  if (Number((await db.prepare('SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND audit_id = ?').get(req.org.id, a.id)).c)) throw new HttpError(409, 'Cet audit a des constats : conservez-le pour la traçabilité.');
  await db.prepare('DELETE FROM aud_audits WHERE id = ? AND org_id = ?').run(a.id, req.org.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.stats = stats;
module.exports.STATUSES = STATUSES;
