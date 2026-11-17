'use strict';
// Projets · pilotage avancé : portefeuille (feu tricolore par projet), valeur acquise (PV, EV, AC, SV, CV, SPI, CPI, EAC, ETC, VAC, TCPI),
// courbe en S, burn-down / burn-up, chemin critique et Gantt, plan de référence, registre des risques et des problèmes, charge prévue par
// personne et par semaine, prévisions de date de fin et de coût final, alertes et export CSV.
// Déclaré AVANT projects-w6.js, projects-w3.js et projects.js (chemins plus précis d'abord). Les calculs sont dans bp-calc.js.
// Droits : tout membre voit l'avancement et les délais des projets qu'il peut voir (antenne) ; les montants (budget, coûts, EAC…) sont
// réservés aux responsables et plus, comme dans le reste du module.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const P6 = require('./projects-w6');
const C = require('./bp-calc');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const KINDS = ['risk', 'issue'];
const RSTATUS = ['open', 'mitigating', 'closed'];
const MONEY_KEYS = ['bac', 'pv', 'ev', 'ac', 'sv', 'cv', 'cpi', 'eac', 'etc', 'vac', 'eacAtypical', 'eacComposite', 'tcpi', 'percentSpent', 'budgetExhausted'];

async function projectOf(req, id) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(404, 'Projet introuvable.');
  return p;
}
const maxD = (a) => a.filter(Boolean).reduce((x, y) => (x > y ? x : y), null);
const minD = (a) => a.filter(Boolean).reduce((x, y) => (x < y ? x : y), null);
const scoreOf = (r) => Number(r.probability) * Number(r.impact);
const riskRow = (r) => ({ id: r.id, projectId: r.project_id, kind: r.kind, title: r.title, description: r.description, probability: Number(r.probability), impact: Number(r.impact), score: scoreOf(r), level: C.riskLevel(scoreOf(r)), status: r.status, ownerId: r.owner_id, owner: r.owner || null, mitigation: r.mitigation, due: r.due, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });

/**
 * Analyse complète d'un projet (sans contrôle de droits : l'appelant a déjà vérifié l'accès au projet).
 * Plan utilisé pour la valeur planifiée : le plan de référence s'il a été figé (dates de chaque tâche au moment du gel), sinon le plan actuel.
 * Plan « actuel » : dates des tâches après la passe avant du planning (une tâche ne commence pas avant la fin de celle dont elle dépend).
 */
async function analyze(orgId, p, st) {
  const settings = st || await W.settings(orgId);
  const today = W.today();
  const rate = Number(settings.project_hourly_cost) || 0;
  const tasks = await db.prepare('SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id = ? AND t.org_id = ? ORDER BY t.id').all(p.id, orgId);
  const hours = await db.prepare('SELECT task_id, day, hours FROM time_entries WHERE org_id = ? AND project_id = ?').all(orgId, p.id);
  const costs = await db.prepare('SELECT date, amount, source FROM project_costs WHERE project_id = ? AND org_id = ?').all(p.id, orgId);
  const base = await db.prepare('SELECT * FROM project_baselines WHERE project_id = ? AND org_id = ?').get(p.id, orgId);
  let baseData = {};
  try { baseData = base ? JSON.parse(base.data) : {}; } catch { baseData = {}; }
  const risks = await db.prepare('SELECT r.*, u.name AS owner FROM project_risks r LEFT JOIN users u ON u.id = r.owner_id WHERE r.project_id = ? AND r.org_id = ? ORDER BY r.id').all(p.id, orgId);
  const plan = P6.computeReplan(tasks, today);
  const moved = new Map(plan.changes.map((c) => [Number(c.id), c]));
  const byTask = new Map();
  const extraHours = [];
  for (const h of hours) { if (h.task_id == null) { extraHours.push(h); continue; } const k = Number(h.task_id); if (!byTask.has(k)) byTask.set(k, []); byTask.get(k).push(h); }
  const cur = (t) => { const s = P6.span(t); const c = moved.get(Number(t.id)); return c ? { start: c.toStart, end: c.toEnd } : s; };
  const ref = (t) => (baseData.tasks && baseData.tasks[t.id]) || cur(t);
  const created = String(p.created_at || today).slice(0, 10);
  const winStart = minD([created, ...tasks.map((t) => { const s = ref(t); return s && s.start; })]) || today;
  let winEnd = maxD([p.due, baseData.due, ...tasks.map((t) => { const s = ref(t); return s && s.end; })]) || maxD([today, winStart]);
  if (winEnd < winStart) winEnd = winStart;
  const window = { start: winStart, end: winEnd };
  const budget = Number(p.budget) || 0;
  const e = C.evm({
    tasks: tasks.map((t) => { const s = ref(t); return { id: t.id, status: t.status, estimate: Number(t.estimate_hours) || 0, start: s ? s.start : null, end: s ? s.end : null, doneAt: t.done_at || null, hours: byTask.get(Number(t.id)) || [] }; }),
    costs, extraHours, rate, budget, window, today,
  });
  const m = e.metrics;
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'done');
  const es = tasks.length && !allDone ? C.earnedSchedule(e, window, today) : null;

  // Vitesse : effort terminé (heures estimées, ou nombre de tâches si rien n'est estimé) sur les 28 derniers jours, par jour.
  // Date de fin « à la vitesse actuelle » = aujourd'hui + reste à faire / vitesse.
  const anyEst = tasks.some((t) => Number(t.estimate_hours) > 0);
  const unit = (t) => (anyEst ? Number(t.estimate_hours) || 0 : 1);
  const since = C.addDays(today, -27);
  const doneRecent = C.sum(tasks.filter((t) => t.status === 'done' && (t.done_at || '') >= since).map(unit));
  const velocity = doneRecent / 28;
  const remainingEffort = C.sum(e.items.map((it) => (anyEst ? it.est : 1) * (1 - e.progress(it, today))));
  const endByVelocity = !allDone && velocity > 0 ? C.addDays(today, Math.ceil(remainingEffort / velocity - 1e-9)) : null;
  // Coût final « par le bas » : coût réel + heures restantes (estimation - temps saisi, par tâche ouverte) × coût horaire.
  const loggedOf = (t) => C.sum((byTask.get(Number(t.id)) || []).map((h) => Number(h.hours)));
  const restHours = C.sum(tasks.filter((t) => t.status !== 'done').map((t) => Math.max((Number(t.estimate_hours) || 0) - loggedOf(t), 0)));
  const acNow = Math.round(e.acAt(today));
  const bottomUp = rate > 0 ? Math.round(acNow + restHours * rate) : null;
  const lastDone = maxD(tasks.map((t) => t.done_at));
  const lateOf = (d) => (p.due && d && d > p.due ? C.dn(d) - C.dn(p.due) : 0);
  const forecast = {
    finished: allDone, finishedAt: allDone ? lastDone : null, dueDate: p.due || null,
    endByPlan: plan.forecastEnd, endByEarnedSchedule: es ? es.end : null, endByVelocity,
    earnedSchedule: es, velocityPerDay: Math.round(velocity * 100) / 100, remainingEffort: Math.round(remainingEffort * 10) / 10, effortUnit: anyEst ? 'hours' : 'tasks',
    lateDaysPlan: lateOf(plan.forecastEnd), lateDaysEarnedSchedule: es ? lateOf(es.end) : 0,
    eac: m.eac, eacAtypical: m.eacAtypical, eacComposite: m.eacComposite, eacBottomUp: bottomUp, remainingHours: Math.round(restHours * 10) / 10,
  };
  // Retard retenu pour la santé : le plus prudent entre le planning (dépendances) et le planning acquis.
  const lateDays = Math.max(forecast.lateDaysPlan, forecast.lateDaysEarnedSchedule);

  // Chemin critique sur le plan actuel.
  const cp = C.criticalPath(tasks.map((t) => { const s = cur(t); return { id: t.id, start: s && s.start, end: s && s.end, dependsOn: t.depends_on, status: t.status }; }));
  const cpBy = new Map(cp.tasks.map((x) => [String(x.id), x]));
  const itemBy = new Map(e.items.map((it) => [String(it.id), it]));
  const gantt = tasks.map((t) => {
    const s = cur(t); const b = baseData.tasks && baseData.tasks[t.id]; const c = cpBy.get(String(t.id)); const it = itemBy.get(String(t.id));
    return { id: t.id, title: t.title, status: t.status, assignee: t.assignee || null, dependsOn: t.depends_on, estimateHours: Number(t.estimate_hours) || 0, loggedHours: Math.round(loggedOf(t) * 100) / 100,
      start: s ? s.start : null, end: s ? s.end : null, baselineStart: b ? b.start : null, baselineEnd: b ? b.end : null,
      progress: it ? Math.round(e.progress(it, today) * 100) : 0, critical: Boolean(c && c.critical), float: c ? c.float : null, late: t.status !== 'done' && Boolean(t.due) && t.due < today, doneAt: t.done_at || null };
  });
  const milestones = (await db.prepare('SELECT * FROM project_milestones WHERE project_id = ? AND org_id = ? ORDER BY due IS NULL, due, id').all(p.id, orgId))
    .map((x) => ({ id: x.id, title: x.title, due: x.due, done: Boolean(Number(x.done)), late: !Number(x.done) && Boolean(x.due) && x.due < today }));
  const openRisks = risks.filter((r) => r.status !== 'closed');
  const riskSummary = { open: openRisks.length, high: openRisks.filter((r) => scoreOf(r) >= 15).length, medium: openRisks.filter((r) => scoreOf(r) >= 8 && scoreOf(r) < 15).length, low: openRisks.filter((r) => scoreOf(r) < 8).length, issues: openRisks.filter((r) => r.kind === 'issue').length,
    exposure: C.sum(openRisks.map(scoreOf)), matrix: Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => openRisks.filter((r) => Number(r.probability) === 5 - i && Number(r.impact) === j + 1).length)) };
  const overdueTasks = tasks.filter((t) => t.status !== 'done' && t.due && t.due < today).length;
  const h = C.health({ status: p.status, tasks: tasks.length, spi: es && es.spiT !== null && m.spi !== null ? Math.min(m.spi, es.spiT) : m.spi, cpi: m.cpi, ac: m.ac, bac: m.mode === 'money' ? m.bac : null, eac: m.eac, lateDays, overdueTasks, highRisks: riskSummary.high, due: p.due, today, money: m.mode === 'money' });
  // Alertes (codes traduits par le site) : indices bas, coût final au-dessus du budget, fin prévue après l'échéance, efficacité à atteindre
  // trop élevée (TCPI > 1,1 : il faudrait dépenser 10 % de moins par unité de travail que prévu), retards, risques élevés, pas de plan de référence.
  const alerts = [];
  if (m.spi !== null && m.spi < 0.95) alerts.push({ code: 'spi', value: m.spi, money: false });
  if (m.cpi !== null && m.cpi < 0.95) alerts.push({ code: 'cpi', value: m.cpi, money: true });
  if (m.mode === 'money' && m.eac > m.bac) alerts.push({ code: 'eac', value: m.eac - m.bac, money: true });
  if (m.tcpi !== null && m.tcpi > 1.1) alerts.push({ code: 'tcpi', value: m.tcpi, money: true });
  if (m.budgetExhausted) alerts.push({ code: 'budgetExhausted', value: m.ac, money: true });
  if (lateDays > 0) alerts.push({ code: 'late', value: lateDays, money: false });
  if (overdueTasks) alerts.push({ code: 'overdueTasks', value: overdueTasks, money: false });
  if (riskSummary.high) alerts.push({ code: 'highRisks', value: riskSummary.high, money: false });
  if (!base && tasks.length && p.status !== 'done') alerts.push({ code: 'noBaseline', value: 0, money: false });
  const series = tasks.length ? C.curve(e, window, today, { horizon: maxD([forecast.endByEarnedSchedule, forecast.endByPlan]) }) : [];
  const bySource = {};
  for (const c of costs) bySource[c.source || 'manual'] = (bySource[c.source || 'manual'] || 0) + Number(c.amount);
  if (rate > 0) bySource.time = Math.round(rate * C.sum(hours.map((x) => Number(x.hours))));
  return {
    project: { id: p.id, name: p.name, status: p.status, due: p.due || null, budget, branchId: p.branch_id, start: window.start, end: window.end },
    today, hourlyCost: rate, metrics: m, forecast, health: h, alerts, series, gantt, criticalPath: cp.path, milestones, risks: risks.map(riskRow), riskSummary,
    baseline: base ? { takenAt: base.taken_at, bac: Number(base.bac), tasks: Object.keys(baseData.tasks || {}).length } : null,
    costs: { bySource, hours: Math.round(C.sum(hours.map((x) => Number(x.hours))) * 100) / 100 },
    counts: { tasks: tasks.length, done: tasks.filter((t) => t.status === 'done').length, doing: tasks.filter((t) => t.status === 'doing').length, overdue: overdueTasks, milestones: milestones.length, milestonesLate: milestones.filter((x) => x.late).length },
    method: {
      pv: 'PV : part du budget de chaque tâche × part de sa durée prévue déjà écoulée (plan de référence s\'il existe).',
      ev: 'EV : part du budget de chaque tâche × avancement (1 si terminée ; sinon heures saisies / estimation, plafonné à 90 %).',
      ac: 'AC : dépenses du projet (achats, stock, saisies) + heures saisies × coût horaire.',
      eac: 'EAC = BAC / CPI ; ETC = EAC - AC ; VAC = BAC - EAC ; TCPI = (BAC - EV) / (BAC - AC).',
      end: 'Fin prévue : planning des dépendances, planning acquis (durée prévue / SPI(t)) et vitesse des 28 derniers jours.',
    },
  };
}

/** Retire les montants pour les personnes qui ne voient pas les coûts (simples membres). */
function stripMoney(a) {
  if (a.metrics.mode !== 'money') return { ...a, costs: undefined, hourlyCost: undefined, project: { ...a.project, budget: undefined }, forecast: { ...a.forecast, eac: undefined, eacAtypical: undefined, eacComposite: undefined, eacBottomUp: undefined } };
  const metrics = { ...a.metrics };
  for (const k of MONEY_KEYS) metrics[k] = undefined;
  return {
    ...a, metrics, costs: undefined, hourlyCost: undefined, project: { ...a.project, budget: undefined },
    forecast: { ...a.forecast, eac: undefined, eacAtypical: undefined, eacComposite: undefined, eacBottomUp: undefined },
    alerts: a.alerts.filter((x) => !x.money), health: { ...a.health, reasons: a.health.reasons.filter((r) => !['cpi', 'overBudget', 'eac'].includes(r)) },
    series: a.series.map((s) => ({ ...s, pv: undefined, ev: undefined, ac: undefined })), baseline: a.baseline ? { ...a.baseline, bac: undefined } : null,
  };
}

// ---------- Portefeuille ----------
async function portfolio(req, { includeDone = false } = {}) {
  const sc = A.scope(req, 'branch_id');
  const rows = await db.prepare(`SELECT * FROM projects WHERE org_id = ?${includeDone ? '' : " AND status != 'done'"}${sc.sql} ORDER BY (status = 'done'), id DESC LIMIT 200`).all(req.org.id, ...sc.args);
  const st = await W.settings(req.org.id);
  const money = A.can(req, 'manager');
  const items = [];
  for (const p of rows) {
    const a = await analyze(req.org.id, p, st);
    const m = a.metrics;
    items.push({
      id: p.id, name: p.name, status: p.status, due: p.due || null, branchId: p.branch_id, rag: a.health.rag, reasons: money ? a.health.reasons : a.health.reasons.filter((r) => !['cpi', 'overBudget', 'eac'].includes(r)),
      mode: m.mode, percentComplete: m.percentComplete, percentPlanned: m.percentPlanned, spi: m.spi, spiT: a.forecast.earnedSchedule ? a.forecast.earnedSchedule.spiT : null,
      tasks: a.counts.tasks, done: a.counts.done, overdue: a.counts.overdue, highRisks: a.riskSummary.high, openRisks: a.riskSummary.open,
      endForecast: a.forecast.finished ? a.forecast.finishedAt : maxD([a.forecast.endByPlan, a.forecast.endByEarnedSchedule]), lateDays: Math.max(a.forecast.lateDaysPlan, a.forecast.lateDaysEarnedSchedule),
      ...(money && m.mode === 'money' ? { bac: m.bac, pv: m.pv, ev: m.ev, ac: m.ac, cpi: m.cpi, eac: m.eac, vac: m.vac, percentSpent: m.percentSpent } : {}),
    });
  }
  // Indices du portefeuille : sommes des projets chiffrés (SPI = ΣEV / ΣPV, CPI = ΣEV / ΣAC).
  const mon = items.filter((x) => x.mode === 'money' && x.bac !== undefined);
  const S = (k) => C.sum(mon.map((x) => x[k] || 0));
  const totals = {
    projects: items.length, green: items.filter((x) => x.rag === 'green').length, amber: items.filter((x) => x.rag === 'amber').length, red: items.filter((x) => x.rag === 'red').length, grey: items.filter((x) => x.rag === 'grey').length,
    late: items.filter((x) => x.lateDays > 0).length, highRisks: C.sum(items.map((x) => x.highRisks)), overdueTasks: C.sum(items.map((x) => x.overdue)),
    avgComplete: items.length ? Math.round(C.sum(items.map((x) => x.percentComplete || 0)) / items.length * 10) / 10 : null,
    ...(money ? { bac: S('bac'), pv: S('pv'), ev: S('ev'), ac: S('ac'), eac: S('eac'), vac: S('bac') - S('eac'), spi: S('pv') ? Math.round(S('ev') / S('pv') * 100) / 100 : null, cpi: S('ac') ? Math.round(S('ev') / S('ac') * 100) / 100 : null, costed: mon.length } : {}),
  };
  return { today: W.today(), items, totals, canSeeCosts: money };
}

router.get('/portfolio', async (req, res) => res.json(await portfolio(req, { includeDone: req.query.all === '1' })));

router.get('/portfolio/export.csv', async (req, res) => {
  const d = await portfolio(req, { includeDone: req.query.all === '1' });
  const RAG = { green: 'Vert', amber: 'Orange', red: 'Rouge', grey: 'Gris' };
  const head = ['Projet', 'Statut', 'Santé', 'Échéance', 'Fin prévue', 'Jours de retard', 'Tâches', 'Terminées', 'En retard', 'Avancement %', 'Prévu %', 'SPI', 'Risques élevés']
    .concat(d.canSeeCosts ? ['Budget (BAC)', 'PV', 'EV', 'AC', 'CPI', 'EAC', 'VAC', 'Consommé %'] : []);
  const rows = [head].concat(d.items.map((x) => [x.name, x.status, RAG[x.rag], x.due || '', x.endForecast || '', x.lateDays, x.tasks, x.done, x.overdue, x.percentComplete, x.percentPlanned, x.spi === null ? '' : x.spi, x.highRisks]
    .concat(d.canSeeCosts ? [x.bac ?? '', x.pv ?? '', x.ev ?? '', x.ac ?? '', x.cpi ?? '', x.eac ?? '', x.vac ?? '', x.percentSpent ?? ''] : [])));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="portefeuille-projets.csv"');
  res.send(require('./purchasing-lib').csv(rows));
});

// ---------- Charge prévue par personne et par semaine ----------
router.get('/workload/plan', mgr, async (req, res) => {
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 1), 26);
  const capacity = req.query.capacity === undefined ? 40 : Number(req.query.capacity);
  if (!Number.isFinite(capacity) || capacity <= 0 || capacity > 168) throw new HttpError(400, 'Capacité invalide (heures par semaine, entre 1 et 168).');
  const sc = A.scope(req, 't.branch_id');
  const tasks = await db.prepare(`SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.org_id = ? AND t.status != 'done' AND (p.id IS NULL OR p.status != 'done')${sc.sql} ORDER BY t.id LIMIT 3000`).all(req.org.id, ...sc.args);
  const logged = new Map((await db.prepare('SELECT task_id, SUM(hours) h FROM time_entries WHERE org_id = ? AND task_id IS NOT NULL GROUP BY task_id').all(req.org.id)).map((r) => [Number(r.task_id), Number(r.h)]));
  const list = tasks.map((t) => { const s = P6.span(t); return { assigneeId: t.assignee_id, assignee: t.assignee, estimate: Number(t.estimate_hours) || 0, logged: logged.get(Number(t.id)) || 0, start: s ? s.start : t.start_date, end: s ? s.end : null, status: t.status }; });
  const out = C.weeklyLoad(list, W.today(), weeks, capacity);
  res.json({ ...out, unestimated: tasks.filter((t) => !(Number(t.estimate_hours) > 0)).length, overloaded: out.rows.filter((r) => r.userId !== null && r.peak > 100).length });
});

// ---------- Un projet : tableau de bord complet ----------
router.get('/:id/pro', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const a = await analyze(req.org.id, p);
  res.json(A.can(req, 'manager') ? { ...a, canSeeCosts: true } : { ...stripMoney(a), canSeeCosts: false });
});

// ---------- Plan de référence (gel des dates et du budget, pour mesurer les écarts) ----------
router.post('/:id/baseline', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const tasks = await db.prepare('SELECT * FROM tasks WHERE project_id = ? AND org_id = ? ORDER BY id').all(p.id, req.org.id);
  const plan = P6.computeReplan(tasks, W.today());
  const moved = new Map(plan.changes.map((c) => [Number(c.id), c]));
  const data = { due: p.due || null, tasks: {} };
  for (const t of tasks) { const c = moved.get(Number(t.id)); const s = c ? { start: c.toStart, end: c.toEnd } : P6.span(t); if (s) data.tasks[t.id] = s; }
  await db.prepare('INSERT INTO project_baselines (project_id, org_id, bac, data, taken_at, taken_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id) DO UPDATE SET bac = EXCLUDED.bac, data = EXCLUDED.data, taken_at = EXCLUDED.taken_at, taken_by = EXCLUDED.taken_by')
    .run(p.id, req.org.id, Number(p.budget) || 0, JSON.stringify(data), nowISO(), req.user.id);
  await W.audit(req, 'project', p.id, 'baseline', null, { tasks: Object.keys(data.tasks).length, budget: Number(p.budget) || 0 });
  await A.logActivity(req.org.id, req.user.id, 'projects', `Projet « ${p.name} » : plan de référence enregistré`);
  res.status(201).json({ ok: true, tasks: Object.keys(data.tasks).length });
});
router.delete('/:id/baseline', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const r = await db.prepare('DELETE FROM project_baselines WHERE project_id = ? AND org_id = ?').run(p.id, req.org.id);
  if (!r.changes) throw new HttpError(404, "Ce projet n'a pas de plan de référence.");
  await W.audit(req, 'project', p.id, 'baseline_delete', null, null);
  res.json({ ok: true });
});

// ---------- Risques et problèmes ----------
function readRisk(b, old) {
  const o = old || {};
  const num = (v, def, label) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, `${label} : un nombre entier de 1 à 5.`);
    return n;
  };
  return {
    kind: b.kind === undefined ? (o.kind || 'risk') : A.oneOf(b.kind, KINDS, undefined, 'Type : risque ou problème.'),
    title: b.title === undefined && old ? o.title : A.text(b.title, 160, { required: true, msg: 'Décrivez le risque en quelques mots.' }),
    description: b.description === undefined ? (o.description || '') : A.text(b.description, 2000),
    probability: num(b.probability, old ? Number(o.probability) : 3, 'Probabilité'),
    impact: num(b.impact, old ? Number(o.impact) : 3, 'Impact'),
    status: b.status === undefined ? (o.status || 'open') : A.oneOf(b.status, RSTATUS, undefined, 'Statut : ouvert, en traitement ou clos.'),
    mitigation: b.mitigation === undefined ? (o.mitigation || '') : A.text(b.mitigation, 2000),
    due: b.due === undefined ? (o.due || null) : A.date(b.due),
  };
}
router.get('/:id/risks', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const rows = await db.prepare('SELECT r.*, u.name AS owner FROM project_risks r LEFT JOIN users u ON u.id = r.owner_id WHERE r.project_id = ? AND r.org_id = ? ORDER BY (r.status = \'closed\'), r.probability * r.impact DESC, r.id').all(p.id, req.org.id);
  res.json({ items: rows.map(riskRow) });
});
// Tout membre qui voit le projet peut signaler un risque ou un problème ; le modifier revient à son auteur ou aux responsables.
router.post('/:id/risks', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const b = req.body || {};
  const v = readRisk(b);
  const owner = await A.memberOf(req, b.ownerId);
  const now = nowISO();
  const id = Number((await db.prepare('INSERT INTO project_risks (org_id, project_id, kind, title, description, probability, impact, status, owner_id, mitigation, due, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, p.id, v.kind, v.title, v.description, v.probability, v.impact, v.status, owner, v.mitigation, v.due, req.user.id, now, now)).lastInsertRowid);
  await W.audit(req, 'project_risk', id, 'create', null, { project: p.id, ...v });
  if (v.probability * v.impact >= 15 && v.status !== 'closed') await W.pushRole(req.org.id, 'manager', 'project', `Risque élevé signalé sur le projet « ${p.name} » : ${v.title}`, `projrisk:${id}`);
  res.status(201).json({ id, score: v.probability * v.impact, level: C.riskLevel(v.probability * v.impact) });
});
async function riskOf(req, rid) {
  const r = await db.prepare('SELECT * FROM project_risks WHERE id = ? AND org_id = ?').get(A.id(rid), req.org.id);
  if (!r) throw new HttpError(404, 'Risque introuvable.');
  await projectOf(req, r.project_id);
  if (!A.can(req, 'manager') && Number(r.created_by) !== Number(req.user.id)) throw new HttpError(403, 'Seuls son auteur et les responsables peuvent modifier ce risque.');
  return r;
}
router.put('/risks/:rid', async (req, res) => {
  const r = await riskOf(req, req.params.rid);
  const b = req.body || {};
  const v = readRisk(b, r);
  const owner = b.ownerId === undefined ? r.owner_id : await A.memberOf(req, b.ownerId);
  await db.prepare('UPDATE project_risks SET kind = ?, title = ?, description = ?, probability = ?, impact = ?, status = ?, owner_id = ?, mitigation = ?, due = ?, updated_at = ? WHERE id = ?')
    .run(v.kind, v.title, v.description, v.probability, v.impact, v.status, owner, v.mitigation, v.due, nowISO(), r.id);
  await W.audit(req, 'project_risk', r.id, 'update', { status: r.status, probability: r.probability, impact: r.impact }, { status: v.status, probability: v.probability, impact: v.impact });
  res.json({ ok: true, score: v.probability * v.impact, level: C.riskLevel(v.probability * v.impact) });
});
router.delete('/risks/:rid', async (req, res) => {
  const r = await riskOf(req, req.params.rid);
  await db.prepare('DELETE FROM project_risks WHERE id = ?').run(r.id);
  await W.audit(req, 'project_risk', r.id, 'delete', { title: r.title }, null);
  res.json({ ok: true });
});

module.exports = router;
module.exports.analyze = analyze;
module.exports.portfolio = portfolio;
