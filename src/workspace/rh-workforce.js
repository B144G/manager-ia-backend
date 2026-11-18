'use strict';
// RH Talents · planification des effectifs : effectifs actuels vs budgétés par service, besoins, scénarios d'embauche et leur coût.
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, W, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const P = need('talent', 'remun');

router.get('/workforce/overview', P, async (req, res) => {
  const y = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : Number(C.today().slice(0, 4));
  const money = await has(req, 'remun');
  const emps = (await require('./hr').employees(req)).filter((e) => e.status === 'active');
  const profs = new Map((await db.prepare('SELECT * FROM rh_emp_profile WHERE org_id = ?').all(req.org.id)).map((p) => [Number(p.employee_id), p]));
  const deps = await db.prepare('SELECT * FROM rh_departments WHERE org_id = ? ORDER BY name').all(req.org.id);
  let lines = [];
  if (req.query.scenarioId) { const sc = await C.fromOrg(req, 'rh_scenarios', req.query.scenarioId, 'Scénario introuvable.'); lines = await db.prepare('SELECT * FROM rh_scenario_lines WHERE scenario_id = ?').all(sc.id); }
  const rows = deps.map((d) => {
    const mine = emps.filter((e) => { const p = profs.get(Number(e.id)); return p && Number(p.department_id) === Number(d.id); });
    const planned = lines.filter((l) => Number(l.department_id) === Number(d.id)).reduce((s, l) => s + Number(l.qty), 0);
    const budget = Number(d.budget_headcount); const current = mine.length;
    return { departmentId: Number(d.id), name: d.name, budget, current, vacancies: Math.max(budget - current, 0), over: Math.max(current - budget, 0), planned, afterPlan: current + planned, needs: Math.max(budget - current - planned, 0), monthlyPayroll: money ? mine.reduce((s, e) => s + Number(e.salary || 0), 0) : undefined };
  });
  const unassigned = emps.filter((e) => { const p = profs.get(Number(e.id)); return !p || !p.department_id; }).length;
  const tot = (k) => rows.reduce((s, r) => s + r[k], 0);
  res.json({ year: y, items: rows, unassigned, summary: { budget: tot('budget'), current: tot('current') + unassigned, vacancies: tot('vacancies'), planned: tot('planned'), needs: tot('needs') } });
});

C.simple(router, { path: '/workforce/scenarios', table: 'rh_scenarios', entity: 'scenario', read: ['talent', 'remun'], write: ['talent', 'remun'], order: 'year DESC, id DESC',
  fields: [{ k: 'name', t: 'text', max: 100, req: true, msg: 'Nommez le scénario.' }, { k: 'year', t: 'int', min: 2000, max: 2100, req: true, msg: "Indiquez l'année." }, { k: 'chargesRate', t: 'num', min: 0, max: 1, def: 0.2 }],
  onCreate: async (req, id) => { await db.prepare('UPDATE rh_scenarios SET created_by = ? WHERE id = ?').run(req.user.id, id); } });

async function scenarioDetail(req, sc) {
  const lines = await db.prepare('SELECT * FROM rh_scenario_lines WHERE scenario_id = ? ORDER BY id').all(sc.id);
  const deps = new Map((await db.prepare('SELECT id, name FROM rh_departments WHERE org_id = ?').all(req.org.id)).map((d) => [Number(d.id), d.name]));
  const jobs = new Map((await db.prepare('SELECT id, title FROM rh_job_profiles WHERE org_id = ?').all(req.org.id)).map((d) => [Number(d.id), d.title]));
  const rate = Number(sc.charges_rate);
  const items = lines.map((l) => ({ id: Number(l.id), departmentId: l.department_id == null ? null : Number(l.department_id), department: deps.get(Number(l.department_id)) || '', jobProfileId: l.job_profile_id == null ? null : Number(l.job_profile_id), job: jobs.get(Number(l.job_profile_id)) || '', qty: Number(l.qty), startMonth: Number(l.start_month), monthlySalary: Number(l.monthly_salary),
    yearCost: L.lineCost({ qty: Number(l.qty), monthlySalary: Number(l.monthly_salary), startMonth: Number(l.start_month) }, rate), fullYearCost: Math.round(Number(l.qty) * Number(l.monthly_salary) * 12 * (1 + rate)) }));
  const byDept = [...new Set(items.map((i) => i.department))].map((d) => ({ department: d, qty: items.filter((i) => i.department === d).reduce((s, i) => s + i.qty, 0), yearCost: items.filter((i) => i.department === d).reduce((s, i) => s + i.yearCost, 0) }));
  return { id: Number(sc.id), name: sc.name, year: Number(sc.year), chargesRate: rate, lines: items, byDepartment: byDept, totals: { hires: items.reduce((s, i) => s + i.qty, 0), yearCost: items.reduce((s, i) => s + i.yearCost, 0), fullYearCost: items.reduce((s, i) => s + i.fullYearCost, 0) } };
}
router.get('/workforce/scenarios/:id', P, async (req, res) => res.json(await scenarioDetail(req, await C.fromOrg(req, 'rh_scenarios', req.params.id, 'Scénario introuvable.'))));
router.post('/workforce/scenarios/:id/lines', P, async (req, res) => {
  const sc = await C.fromOrg(req, 'rh_scenarios', req.params.id, 'Scénario introuvable.'); const b = req.body || {};
  const qty = Number(b.qty === undefined ? 1 : b.qty); const sm = Number(b.startMonth === undefined ? 1 : b.startMonth);
  if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new HttpError(400, 'Nombre de postes invalide.');
  if (!Number.isInteger(sm) || sm < 1 || sm > 12) throw new HttpError(400, 'Mois de début invalide (1 à 12).');
  const dep = await C.optRef(req, 'rh_departments', b.departmentId, 'Service inconnu.'); const job = await C.optRef(req, 'rh_job_profiles', b.jobProfileId, 'Emploi inconnu.');
  let salary = b.monthlySalary ? A.amount(b.monthlySalary) : 0;
  if (!salary && job) { const g = await db.prepare('SELECT mid_salary FROM rh_pay_grades WHERE job_profile_id = ? ORDER BY level LIMIT 1').get(job); if (g) salary = Number(g.mid_salary); }
  if (!salary) throw new HttpError(400, 'Indiquez le salaire mensuel (aucune grille salariale pour cet emploi).');
  const id = Number((await db.prepare('INSERT INTO rh_scenario_lines (org_id, scenario_id, department_id, job_profile_id, qty, start_month, monthly_salary) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, sc.id, dep, job, qty, sm, salary)).lastInsertRowid);
  await audit(req, 'scenario_line', id, 'create', null, { scenarioId: Number(sc.id), qty });
  res.status(201).json({ id });
});
router.delete('/workforce/scenarios/:id/lines/:lineId', P, async (req, res) => {
  const sc = await C.fromOrg(req, 'rh_scenarios', req.params.id, 'Scénario introuvable.');
  await db.prepare('DELETE FROM rh_scenario_lines WHERE id = ? AND scenario_id = ?').run(A.id(req.params.lineId), sc.id);
  await audit(req, 'scenario_line', req.params.lineId, 'delete', null, null);
  res.json({ ok: true });
});
router.get('/workforce/compare', P, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM rh_scenarios WHERE org_id = ? ORDER BY year DESC, id DESC LIMIT 20').all(req.org.id);
  const out = []; for (const sc of rows) { const d = await scenarioDetail(req, sc); out.push({ id: d.id, name: d.name, year: d.year, hires: d.totals.hires, yearCost: d.totals.yearCost, fullYearCost: d.totals.fullYearCost }); }
  res.json({ items: out });
});

module.exports = router;
