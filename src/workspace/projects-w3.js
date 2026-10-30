'use strict';
// Projets · vague 3 : budget et coût, temps passé, charge par personne, jalons, dépendances entre tâches, commentaires, pièces jointes
// chiffrées et tâches récurrentes. Déclaré AVANT projects.js (chemins plus précis d'abord).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const F = require('./files-w3');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
W.settingsRoutes(router, ['project_hourly_cost'], 'admin', 'member');

async function projectOf(req, id) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(404, 'Projet introuvable.');
  return p;
}
async function taskOf(req, id) {
  const t = await db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!t || !A.visible(req, t)) throw new HttpError(404, 'Tâche introuvable.');
  return t;
}

// ---------- Charge par personne ----------
router.get('/workload', mgr, async (req, res) => {
  const sc = A.scope(req, 't.branch_id');
  const since = W.addDays(W.today(), -30);
  const rows = await db.prepare(`SELECT t.assignee_id, u.name, COUNT(*) AS open, COALESCE(SUM(CASE WHEN t.due IS NOT NULL AND t.due < ? THEN 1 ELSE 0 END), 0) AS overdue, COALESCE(SUM(t.estimate_hours), 0) AS hours
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.org_id = ? AND t.status != 'done'${sc.sql} GROUP BY t.assignee_id, u.name ORDER BY COUNT(*) DESC`).all(W.today(), req.org.id, ...sc.args);
  const logged = new Map((await db.prepare('SELECT user_id, SUM(hours) h FROM time_entries WHERE org_id = ? AND day >= ? GROUP BY user_id').all(req.org.id, since)).map((r) => [Number(r.user_id), Number(r.h)]));
  res.json({ items: rows.map((r) => ({ userId: r.assignee_id, name: r.name || null, openTasks: Number(r.open), overdue: Number(r.overdue), estimatedHours: Number(r.hours), loggedHours30d: r.assignee_id ? logged.get(Number(r.assignee_id)) || 0 : 0 })) });
});

// ---------- Budget, coûts, résumé ----------
router.put('/:id/budget', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const v = (req.body || {}).budget;
  const budget = v === '' || v === null || Number(v) === 0 ? 0 : A.amount(v);
  await db.prepare('UPDATE projects SET budget = ? WHERE id = ?').run(budget, p.id);
  await W.audit(req, 'project', p.id, 'update', { budget: p.budget }, { budget });
  res.json({ ok: true });
});
router.get('/:id/costs', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  res.json({ items: (await db.prepare('SELECT * FROM project_costs WHERE project_id = ? ORDER BY date DESC, id DESC').all(p.id)).map((r) => W.camelRow(r)) });
});
router.post('/:id/costs', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id); const b = req.body || {};
  const label = A.text(b.label, 150, { required: true, msg: 'Indiquez ce que couvre cette dépense.' });
  const id = Number((await db.prepare('INSERT INTO project_costs (org_id, project_id, label, amount, date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, p.id, label, A.amount(b.amount), A.date(b.date) || W.today(), req.user.id, nowISO())).lastInsertRowid);
  await W.audit(req, 'project_cost', id, 'create', null, { project: p.id, label, amount: b.amount });
  res.status(201).json({ id });
});
router.delete('/costs/:cid', mgr, async (req, res) => {
  const c = await db.prepare('SELECT * FROM project_costs WHERE id = ? AND org_id = ?').get(A.id(req.params.cid), req.org.id);
  if (!c) throw new HttpError(404, 'Dépense introuvable.');
  await db.prepare('DELETE FROM project_costs WHERE id = ?').run(c.id);
  await W.audit(req, 'project_cost', c.id, 'delete', c, null);
  res.json({ ok: true });
});
router.get('/:id/summary', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const st = await W.settings(req.org.id);
  const hours = Number((await db.prepare('SELECT COALESCE(SUM(hours), 0) h FROM time_entries WHERE org_id = ? AND project_id = ?').get(req.org.id, p.id)).h);
  const costs = Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM project_costs WHERE project_id = ?').get(p.id)).s);
  const timeCost = Math.round(hours * st.project_hourly_cost);
  const est = Number((await db.prepare('SELECT COALESCE(SUM(estimate_hours), 0) h FROM tasks WHERE project_id = ?').get(p.id)).h);
  const milestones = await db.prepare('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY due IS NULL, due, id').all(p.id);
  const budget = Number(p.budget); const spent = costs + timeCost;
  const mgrView = A.can(req, 'manager');
  res.json({ project: { id: p.id, name: p.name, budget: mgrView ? budget : undefined },
    cost: mgrView ? { budget, expenses: costs, timeCost, spent, remaining: budget ? budget - spent : null, overBudget: budget > 0 && spent > budget, hourlyCost: st.project_hourly_cost } : undefined,
    time: { hours, estimatedHours: est },
    milestones: milestones.map((m) => ({ id: m.id, title: m.title, due: m.due, done: Boolean(Number(m.done)), late: !Number(m.done) && Boolean(m.due) && m.due < W.today() })) });
});

// ---------- Jalons ----------
router.post('/:id/milestones', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id); const b = req.body || {};
  const id = Number((await db.prepare('INSERT INTO project_milestones (org_id, project_id, title, due, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, p.id, A.text(b.title, 150, { required: true, msg: 'Indiquez le jalon.' }), A.date(b.due), nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.put('/milestones/:mid', mgr, async (req, res) => {
  const m = await db.prepare('SELECT * FROM project_milestones WHERE id = ? AND org_id = ?').get(A.id(req.params.mid), req.org.id);
  if (!m) throw new HttpError(404, 'Jalon introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE project_milestones SET title = ?, due = ?, done = ? WHERE id = ?').run(b.title === undefined ? m.title : A.text(b.title, 150, { required: true }), b.due === undefined ? m.due : A.date(b.due), b.done === undefined ? m.done : (b.done ? 1 : 0), m.id);
  res.json({ ok: true });
});
router.delete('/milestones/:mid', mgr, async (req, res) => {
  const r = await db.prepare('DELETE FROM project_milestones WHERE id = ? AND org_id = ?').run(A.id(req.params.mid), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Jalon introuvable.');
  res.json({ ok: true });
});

// ---------- Temps passé ----------
router.get('/tasks/:id/time', async (req, res) => {
  const t = await taskOf(req, req.params.id);
  const rows = await db.prepare('SELECT e.*, u.name AS who FROM time_entries e LEFT JOIN users u ON u.id = e.user_id WHERE e.org_id = ? AND e.task_id = ? ORDER BY e.day DESC, e.id DESC').all(req.org.id, t.id);
  res.json({ items: rows.map((r) => ({ id: r.id, day: r.day, hours: Number(r.hours), note: r.note, who: r.who, userId: r.user_id })), total: rows.reduce((a, r) => a + Number(r.hours), 0) });
});
router.post('/tasks/:id/time', async (req, res) => {
  const t = await taskOf(req, req.params.id); const b = req.body || {};
  const hours = Number(String(b.hours).replace(',', '.'));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new HttpError(400, 'Indiquez un temps entre 0 et 24 heures.');
  const id = Number((await db.prepare('INSERT INTO time_entries (org_id, task_id, project_id, user_id, day, hours, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, t.id, t.project_id, req.user.id, A.date(b.day) || W.today(), Math.round(hours * 100) / 100, A.text(b.note, 200), nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.delete('/time/:eid', async (req, res) => {
  const e = await db.prepare('SELECT * FROM time_entries WHERE id = ? AND org_id = ?').get(A.id(req.params.eid), req.org.id);
  if (!e) throw new HttpError(404, 'Saisie introuvable.');
  if (e.user_id !== req.user.id && !A.can(req, 'manager')) throw new HttpError(403, 'Vous pouvez supprimer seulement vos saisies.');
  await db.prepare('DELETE FROM time_entries WHERE id = ?').run(e.id);
  res.json({ ok: true });
});

// ---------- Commentaires ----------
router.get('/tasks/:id/comments', async (req, res) => {
  const t = await taskOf(req, req.params.id);
  const rows = await db.prepare('SELECT c.id, c.content, c.created_at, c.user_id, u.name AS who FROM task_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id').all(t.id);
  res.json({ items: rows.map((r) => ({ id: r.id, content: r.content, at: r.created_at, who: r.who, userId: r.user_id })) });
});
router.post('/tasks/:id/comments', async (req, res) => {
  const t = await taskOf(req, req.params.id);
  const content = A.text((req.body || {}).content, 1500, { required: true, msg: 'Écrivez un commentaire.' });
  const id = Number((await db.prepare('INSERT INTO task_comments (org_id, task_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, t.id, req.user.id, content, nowISO())).lastInsertRowid);
  if (t.assignee_id && t.assignee_id !== req.user.id) await W.push(req.org.id, t.assignee_id, 'task', `${req.user.name} a commenté la tâche « ${t.title} ».`, 'task:' + t.id);
  res.status(201).json({ id });
});

// ---------- Planification d'une tâche : estimation, dépendance, récurrence ----------
const FREQ = ['', 'daily', 'weekly', 'monthly'];
const nextDate = (d, freq) => {
  if (freq === 'daily') return W.addDays(d, 1);
  if (freq === 'weekly') return W.addDays(d, 7);
  const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); return x.toISOString().slice(0, 10);
};
async function wouldCycle(taskId, dep) {
  for (let cur = dep, n = 0; cur && n < 60; n++) {
    if (Number(cur) === Number(taskId)) return true;
    cur = (await db.prepare('SELECT depends_on FROM tasks WHERE id = ?').get(cur) || {}).depends_on;
  }
  return false;
}
router.put('/tasks/:id/plan', async (req, res) => {
  const t = await taskOf(req, req.params.id); const b = req.body || {};
  if (!A.can(req, 'manager') && t.created_by !== req.user.id) throw new HttpError(403, 'Seuls le créateur de la tâche et les responsables peuvent la planifier.');
  const set = {};
  if (b.estimateHours !== undefined) { const h = b.estimateHours === '' ? 0 : Number(String(b.estimateHours).replace(',', '.')); if (!Number.isFinite(h) || h < 0 || h > 5000) throw new HttpError(400, 'Estimation invalide (en heures).'); set.estimate_hours = h; }
  if (b.dependsOn !== undefined) {
    if (b.dependsOn === null || b.dependsOn === '') set.depends_on = null;
    else {
      const dep = await taskOf(req, b.dependsOn);
      if (dep.id === t.id || await wouldCycle(t.id, dep.id)) throw new HttpError(400, 'Cette dépendance créerait une boucle.');
      set.depends_on = dep.id;
    }
  }
  if (b.recurrence !== undefined) {
    set.recurrence = A.oneOf(b.recurrence, FREQ, '', 'Récurrence inconnue (daily, weekly ou monthly).');
    set.recur_next = set.recurrence ? (A.date(b.recurNext) || nextDate(W.today(), set.recurrence)) : null;
  }
  if (Object.keys(set).length) {
    await db.prepare(`UPDATE tasks SET ${Object.keys(set).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), t.id);
    await W.audit(req, 'task', t.id, 'plan', Object.fromEntries(Object.keys(set).map((c) => [c, t[c]])), set);
  }
  res.json({ ok: true });
});
/** Une tâche ne démarre pas et ne se termine pas tant que la tâche dont elle dépend n'est pas terminée. */
router.put('/tasks/:id', async (req, res, next) => {
  const st = (req.body || {}).status;
  if (st !== 'doing' && st !== 'done') return next();
  const t = await db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t || !t.depends_on) return next();
  const dep = await db.prepare('SELECT title, status FROM tasks WHERE id = ?').get(t.depends_on);
  if (dep && dep.status !== 'done') throw new HttpError(409, `Cette tâche dépend de « ${dep.title} », pas encore terminée.`);
  next();
});

/** Crée les occurrences des tâches récurrentes arrivées à échéance (toutes les organisations si orgId est absent). */
async function runRecurring(orgId) {
  const rows = await db.prepare(`SELECT * FROM tasks WHERE recurrence != '' AND recur_next IS NOT NULL AND recur_next <= ?${orgId ? ' AND org_id = ?' : ''} LIMIT 500`).all(...[W.today(), ...(orgId ? [orgId] : [])]);
  let n = 0;
  for (const t of rows) {
    let next = t.recur_next; let guard = 0;
    await db.transaction(async () => {
      while (next <= W.today() && guard++ < 12) {
        // une seule occurrence par passage : la plus récente à créer, les jours manqués ne sont pas rattrapés
        next = nextDate(next, t.recurrence);
      }
      await db.prepare("INSERT INTO tasks (org_id, project_id, branch_id, title, description, status, priority, assignee_id, due, created_by, created_at, estimate_hours) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)")
        .run(t.org_id, t.project_id, t.branch_id, t.title, t.description, t.priority, t.assignee_id, t.recur_next, t.created_by, nowISO(), t.estimate_hours);
      await db.prepare('UPDATE tasks SET recur_next = ? WHERE id = ?').run(next, t.id);
    })();
    if (t.assignee_id) await W.push(t.org_id, t.assignee_id, 'task', `Tâche récurrente à faire : ${t.title}`, 'task:' + t.id);
    n++;
  }
  return n;
}
router.post('/recurring/run', mgr, async (req, res) => res.json({ created: await runRecurring(req.org.id) }));

F.mount(router, '', { type: 'project', table: 'projects', role: 'member', label: 'Projet', module: 'projects', scopeCheck: (req, row) => A.visible(req, row) });

module.exports = router;
module.exports.runRecurring = runRecurring;
