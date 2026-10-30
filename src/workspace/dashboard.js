'use strict';
// Tableau de bord : un coup d'œil sur toutes les sous-applications.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const insights = require('./insights');
const decisions = require('./decisions');

const router = express.Router({ mergeParams: true });

/** Chiffres clés de l'organisation (aussi utilisés par l'IA pour son point de situation). */
async function stats(req) {
  const o = req.org.id;
  const sc = A.scope(req);
  const today = nowISO().slice(0, 10);
  const one = async (sql, ...a) => (await db.prepare(sql).get(o, ...a, ...sc.args)).c;
  const out = {
    tickets: { open: await one(`SELECT COUNT(*) c FROM tickets WHERE org_id = ? AND status = 'open'${sc.sql}`), pending: await one(`SELECT COUNT(*) c FROM tickets WHERE org_id = ? AND status = 'pending'${sc.sql}`), urgent: await one(`SELECT COUNT(*) c FROM tickets WHERE org_id = ? AND status != 'resolved' AND priority = 'high'${sc.sql}`) },
    projects: { active: await one(`SELECT COUNT(*) c FROM projects WHERE org_id = ? AND status = 'active'${sc.sql}`) },
    tasks: {
      todo: await one(`SELECT COUNT(*) c FROM tasks WHERE org_id = ? AND status != 'done'${sc.sql}`),
      overdue: (await db.prepare(`SELECT COUNT(*) c FROM tasks WHERE org_id = ? AND status != 'done' AND due IS NOT NULL AND due < ?${sc.sql}`).get(o, today, ...sc.args)).c,
      mine: (await db.prepare("SELECT COUNT(*) c FROM tasks WHERE org_id = ? AND status != 'done' AND assignee_id = ?").get(o, req.user.id)).c,
    },
    team: { members: (await db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(o)).c, branches: (await db.prepare('SELECT COUNT(*) c FROM branches WHERE org_id = ?').get(o)).c },
    structure: { positions: (await db.prepare('SELECT COUNT(*) c FROM positions WHERE org_id = ?').get(o)).c, processes: (await db.prepare('SELECT COUNT(*) c FROM processes WHERE org_id = ?').get(o)).c },
  };
  if (A.can(req, 'manager')) {
    const r = A.monthRange();
    const t = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount END), 0) i, COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount END), 0) e FROM budget_entries WHERE org_id = ? AND date >= ? AND date < ?${sc.sql}`).get(o, r.from, r.to, ...sc.args);
    out.budget = { month: r.month, income: t.i, expense: t.e, balance: t.i - t.e };
  }
  return out;
}

router.get('/', async (req, res) => {
  const mine = await db.prepare(`SELECT t.id, t.title, t.status, t.priority, t.due, p.name AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.org_id = ? AND t.assignee_id = ? AND t.status != 'done' ORDER BY t.due IS NULL, t.due LIMIT 6`).all(req.org.id, req.user.id);
  const sc = A.scope(req, 'p.branch_id');
  const projects = await db.prepare(`SELECT p.id, p.name, p.due, COUNT(t.id) AS tasks, COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.org_id = ? AND p.status = 'active'${sc.sql} GROUP BY p.id ORDER BY p.id DESC LIMIT 4`).all(req.org.id, ...sc.args);
  const list = await insights.alerts(req);
  res.json({
    stats: await stats(req), myTasks: mine, alerts: list, health: insights.health(list),
    series: A.can(req, 'manager') ? await insights.series(req) : null,
    projects: projects.map((p) => ({ id: p.id, name: p.name, due: p.due, tasks: p.tasks, done: p.done, percent: p.tasks ? Math.round((100 * p.done) / p.tasks) : 0 })),
    decisions: await decisions.pending(req, 5), canDecide: A.can(req, 'manager'),
  });
});

router.get('/alerts', async (req, res) => res.json({ alerts: await insights.alerts(req) }));

module.exports = router;
module.exports.stats = stats;
