'use strict';
// Sous-application « Projets et tâches ».
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const PSTATUS = ['active', 'paused', 'done'];
const TSTATUS = ['todo', 'doing', 'done'];
const PRIORITY = ['low', 'normal', 'high'];

const projectRow = (p) => ({ id: p.id, name: p.name, description: p.description, status: p.status, due: p.due, branchId: p.branch_id, tasks: p.tasks, done: p.done, overdue: p.overdue });
const taskRow = (t) => ({ id: t.id, projectId: t.project_id, title: t.title, description: t.description, status: t.status, priority: t.priority, assigneeId: t.assignee_id, assignee: t.assignee || null, due: t.due, branchId: t.branch_id, project: t.project || null });

async function getProject(req, id) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(404, 'Projet introuvable.');
  return p;
}

router.get('/', async (req, res) => {
  const sc = A.scope(req, 'p.branch_id');
  const today = nowISO().slice(0, 10);
  const rows = await db.prepare(`
    SELECT p.*, COUNT(t.id) AS tasks, COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
           COALESCE(SUM(CASE WHEN t.status != 'done' AND t.due IS NOT NULL AND t.due < ? THEN 1 ELSE 0 END), 0) AS overdue
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.org_id = ?${sc.sql} GROUP BY p.id ORDER BY (p.status = 'done'), p.id DESC`).all(today, req.org.id, ...sc.args);
  res.json({ projects: rows.map(projectRow) });
});

/** Création d'un projet avec ses tâches (utilisée aussi par l'IA, après validation de la personne). */
async function createProject(req, b) {
  const name = A.text(b.name, 120, { required: true, msg: 'Indiquez le nom du projet.' });
  const tasks = Array.isArray(b.tasks) ? b.tasks.slice(0, 40) : [];
  const now = nowISO();
  const branch = await A.branchOf(req, b.branchId);
  return await db.transaction(async () => {
    const pid = (await db.prepare('INSERT INTO projects (org_id, branch_id, name, description, due, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, branch, name, A.text(b.description, 2000), A.date(b.due), req.user.id, now)).lastInsertRowid;
    for (const t of tasks) {
      const title = A.text(t && t.title, 160);
      if (!title) continue;
      const days = t.dueInDays !== undefined && t.dueInDays !== null && Number.isFinite(Number(t.dueInDays)) ? Math.min(Math.max(Math.round(Number(t.dueInDays)), 0), 365) : null;
      const due = t.due ? A.date(t.due) : days === null ? null : new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      await db.prepare('INSERT INTO tasks (org_id, project_id, branch_id, title, description, priority, due, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.org.id, pid, branch, title, A.text(t.description, 1000), PRIORITY.includes(t.priority) ? t.priority : 'normal', due, req.user.id, now);
    }
    await A.logActivity(req.org.id, req.user.id, 'projects', `Projet « ${name} » créé`);
    return Number(pid);
  })();
}

router.post('/', A.need('manager'), async (req, res) => res.status(201).json({ id: await createProject(req, req.body || {}) }));

// ---- Tâches (déclarées avant /:id) ----
router.get('/tasks', async (req, res) => {
  const q = req.query;
  const sc = A.scope(req, 't.branch_id');
  const where = ['t.org_id = ?'];
  const args = [req.org.id];
  if (q.project) { where.push('t.project_id = ?'); args.push(A.id(q.project)); }
  if (q.status) { where.push('t.status = ?'); args.push(A.oneOf(q.status, TSTATUS)); }
  if (q.mine) { where.push('t.assignee_id = ?'); args.push(req.user.id); }
  const rows = await db.prepare(`
    SELECT t.*, u.name AS assignee, p.name AS project FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE ${where.join(' AND ')}${sc.sql}
    ORDER BY (t.status = 'done'), CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.due IS NULL, t.due, t.id DESC LIMIT 300`).all(...args, ...sc.args);
  res.json({ tasks: rows.map(taskRow) });
});

router.post('/tasks', async (req, res) => {
  const b = req.body || {};
  const title = A.text(b.title, 160, { required: true, msg: 'Indiquez le titre de la tâche.' });
  let branch = null;
  let pid = null;
  if (b.projectId) { const p = await getProject(req, b.projectId); pid = p.id; branch = p.branch_id; } else branch = await A.branchOf(req, b.branchId);
  const assignee = await A.memberOf(req, b.assigneeId);
  const id = (await db.prepare('INSERT INTO tasks (org_id, project_id, branch_id, title, description, status, priority, assignee_id, due, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, pid, branch, title, A.text(b.description, 1000), A.oneOf(b.status, TSTATUS, 'todo'), A.oneOf(b.priority, PRIORITY, 'normal'), assignee, A.date(b.due), req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});

router.put('/tasks/:id', async (req, res) => {
  const t = await db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t || !A.visible(req, t)) throw new HttpError(404, 'Tâche introuvable.');
  const b = req.body || {};
  const mine = t.assignee_id === req.user.id || t.created_by === req.user.id;
  if (!A.can(req, 'manager') && !mine) throw new HttpError(403, 'Vous pouvez modifier seulement vos tâches.');
  // Une personne assignée (sans rôle de responsable) peut changer l'avancement ; le reste revient au créateur ou aux responsables.
  const full = A.can(req, 'manager') || t.created_by === req.user.id;
  const status = b.status === undefined ? t.status : A.oneOf(b.status, TSTATUS);
  const n = full ? {
    title: b.title === undefined ? t.title : A.text(b.title, 160, { required: true, msg: 'Le titre ne peut pas être vide.' }),
    description: b.description === undefined ? t.description : A.text(b.description, 1000),
    priority: b.priority === undefined ? t.priority : A.oneOf(b.priority, PRIORITY),
    assignee: b.assigneeId === undefined ? t.assignee_id : await A.memberOf(req, b.assigneeId),
    due: b.due === undefined ? t.due : A.date(b.due),
  } : { title: t.title, description: t.description, priority: t.priority, assignee: t.assignee_id, due: t.due };
  await db.prepare('UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, due = ? WHERE id = ?').run(n.title, n.description, status, n.priority, n.assignee, n.due, t.id);
  if (status === 'done' && t.status !== 'done') await A.logActivity(req.org.id, req.user.id, 'projects', `Tâche terminée : ${t.title}`);
  res.json({ ok: true });
});

router.delete('/tasks/:id', async (req, res) => {
  const t = await db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t || !A.visible(req, t)) throw new HttpError(404, 'Tâche introuvable.');
  if (!A.can(req, 'manager') && t.created_by !== req.user.id) throw new HttpError(403, 'Vous pouvez supprimer seulement les tâches que vous avez créées.');
  await db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

// ---- Projet seul ----
router.get('/:id', async (req, res) => {
  const p = await getProject(req, req.params.id);
  const tasks = await db.prepare(`SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id = ?
    ORDER BY (t.status = 'done'), CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.id`).all(p.id);
  res.json({ project: { id: p.id, name: p.name, description: p.description, status: p.status, due: p.due, branchId: p.branch_id }, tasks: tasks.map(taskRow) });
});

router.put('/:id', A.need('manager'), async (req, res) => {
  const p = await getProject(req, req.params.id);
  const b = req.body || {};
  await db.prepare('UPDATE projects SET name = ?, description = ?, status = ?, due = ?, branch_id = ? WHERE id = ?').run(
    b.name === undefined ? p.name : A.text(b.name, 120, { required: true, msg: 'Le nom ne peut pas être vide.' }),
    b.description === undefined ? p.description : A.text(b.description, 2000),
    b.status === undefined ? p.status : A.oneOf(b.status, PSTATUS),
    b.due === undefined ? p.due : A.date(b.due),
    b.branchId === undefined ? p.branch_id : await A.branchOf(req, b.branchId), p.id);
  res.json({ ok: true });
});

router.delete('/:id', A.need('manager'), async (req, res) => {
  const p = await getProject(req, req.params.id);
  await db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  await A.logActivity(req.org.id, req.user.id, 'projects', `Projet « ${p.name} » supprimé`);
  res.json({ ok: true });
});

module.exports = router;
module.exports.createProject = createProject;
