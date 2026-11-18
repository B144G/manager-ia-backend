'use strict';
// RH Talents · rémunération et avantages : grilles salariales par emploi et échelon, positionnement (compa-ratio), primes et avantages en nature,
// simulation de révision, masse salariale prévisionnelle. S'APPUIE sur la paie existante (employees.salary, payroll_slips) sans la remplacer :
// seule l'application explicite d'une simulation modifie le salaire de base lu par la paie.
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, W, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const M = need('remun');

C.simple(router, { path: '/comp/grades', table: 'rh_pay_grades', entity: 'pay_grade', read: ['remun'], write: ['remun'], order: 'job_profile_id, level', noCreated: true,
  fields: [{ k: 'jobProfileId', t: 'ref', ref: 'rh_job_profiles', req: true, label: 'Emploi', msg: "Choisissez l'emploi." }, { k: 'level', t: 'int', min: 1, max: 20, def: 1 }, { k: 'minSalary', t: 'int', min: 1, max: 1e11, req: true, msg: 'Indiquez le minimum.' }, { k: 'midSalary', t: 'int', min: 1, max: 1e11, req: true, msg: 'Indiquez le point médian.' }, { k: 'maxSalary', t: 'int', min: 1, max: 1e11, req: true, msg: 'Indiquez le maximum.' }],
  validate: async (req, v, cur) => {
    const mn = v.min_salary ?? cur.min_salary; const md = v.mid_salary ?? cur.mid_salary; const mx = v.max_salary ?? cur.max_salary;
    if (!(Number(mn) <= Number(md) && Number(md) <= Number(mx))) throw new HttpError(400, 'La grille doit respecter minimum ≤ médian ≤ maximum.');
    const jp = v.job_profile_id ?? cur?.job_profile_id; const lv = v.level ?? cur?.level;
    const d = await db.prepare('SELECT id FROM rh_pay_grades WHERE job_profile_id = ? AND level = ?').get(jp, lv);
    if (d && (!cur || Number(d.id) !== Number(cur.id))) throw new HttpError(409, 'Cette grille existe déjà pour cet emploi et cet échelon.');
  },
  decorate: async (req, rows) => { const j = new Map((await db.prepare('SELECT id, title FROM rh_job_profiles WHERE org_id = ?').all(req.org.id)).map((x) => [Number(x.id), x.title])); return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), job: j.get(Number(r.job_profile_id)) || '' } })); } });

const ITEM_KINDS = ['bonus', 'benefit_in_kind', 'allowance'];
const monthlyOf = (it) => (it.recurrence === 'monthly' ? Number(it.amount) : it.recurrence === 'annual' ? Math.round(Number(it.amount) / 12) : 0);
router.get('/comp/items', async (req, res) => {
  const all = await has(req, 'remun'); let rows;
  if (req.query.employeeId) {
    const e = await C.emp(req, req.query.employeeId);
    if (!all && !(await C.isSelf(req, e.id))) throw new HttpError(403, 'Données de rémunération confidentielles.');
    rows = await db.prepare('SELECT * FROM rh_pay_items WHERE org_id = ? AND employee_id = ? ORDER BY id').all(req.org.id, e.id);
  } else { if (!all) throw new HttpError(403, 'Données de rémunération confidentielles.'); rows = await db.prepare('SELECT * FROM rh_pay_items WHERE org_id = ? ORDER BY employee_id, id').all(req.org.id); }
  const nm = await C.names(req);
  await audit(req, 'pay_items', req.query.employeeId ? Number(req.query.employeeId) : null, 'read', null, null);
  res.json({ items: rows.map((i) => ({ id: Number(i.id), employeeId: Number(i.employee_id), employee: nm.get(Number(i.employee_id)) || '', kind: i.kind, label: i.label, amount: Number(i.amount), recurrence: i.recurrence, monthly: monthlyOf(i) })) });
});
router.post('/comp/items', M, async (req, res) => {
  const b = req.body || {}; const e = await C.emp(req, b.employeeId);
  const id = Number((await db.prepare('INSERT INTO rh_pay_items (org_id, employee_id, kind, label, amount, recurrence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, e.id, A.oneOf(b.kind, ITEM_KINDS, 'bonus', 'Type inconnu.'), A.text(b.label, 100, { required: true, msg: 'Indiquez le libellé.' }), A.amount(b.amount), A.oneOf(b.recurrence, ['monthly', 'annual', 'once'], 'monthly', 'Périodicité inconnue.'), nowISO())).lastInsertRowid);
  await audit(req, 'pay_item', id, 'create', null, { employeeId: Number(e.id), kind: b.kind, label: A.text(b.label, 60) });
  res.status(201).json({ id });
});
router.delete('/comp/items/:id', M, async (req, res) => {
  const i = await C.fromOrg(req, 'rh_pay_items', req.params.id, 'Élément introuvable.');
  await db.prepare('DELETE FROM rh_pay_items WHERE id = ?').run(i.id);
  await audit(req, 'pay_item', i.id, 'delete', { label: i.label }, null);
  res.json({ ok: true });
});

/** Positionnement salarial de chaque employé actif face à la grille de son emploi et de son échelon, et lien avec la dernière fiche de paie. */
async function positioning(req) {
  const emps = (await require('./hr').employees(req)).filter((e) => e.status === 'active');
  const profs = new Map((await db.prepare('SELECT * FROM rh_emp_profile WHERE org_id = ?').all(req.org.id)).map((p) => [Number(p.employee_id), p]));
  const grades = await db.prepare('SELECT * FROM rh_pay_grades WHERE org_id = ?').all(req.org.id);
  const jobs = new Map((await db.prepare('SELECT id, title FROM rh_job_profiles WHERE org_id = ?').all(req.org.id)).map((j) => [Number(j.id), j.title]));
  const slips = await db.prepare('SELECT s.employee_id, s.base, s.month FROM payroll_slips s WHERE s.org_id = ? ORDER BY s.month').all(req.org.id);
  const last = new Map(); for (const s of slips) last.set(Number(s.employee_id), s);
  return emps.map((e) => {
    const p = profs.get(Number(e.id)); const jid = p && p.job_profile_id ? Number(p.job_profile_id) : null; const lvl = p ? Number(p.level) : 1;
    const g = jid ? grades.find((x) => Number(x.job_profile_id) === jid && Number(x.level) === lvl) : null;
    const sal = e.salary == null ? null : Number(e.salary);
    let status = 'no_grade'; if (g && sal !== null) status = sal < Number(g.min_salary) ? 'below_min' : sal > Number(g.max_salary) ? 'above_max' : 'in_range';
    const sl = last.get(Number(e.id));
    return { employeeId: Number(e.id), name: e.name, jobProfileId: jid, job: jid ? jobs.get(jid) || e.job : e.job, level: lvl, salary: sal, min: g ? Number(g.min_salary) : null, mid: g ? Number(g.mid_salary) : null, max: g ? Number(g.max_salary) : null,
      compaRatio: g && sal !== null ? L.compaRatio(sal, Number(g.mid_salary)) : null, penetration: g && sal !== null ? L.rangePenetration(sal, Number(g.min_salary), Number(g.max_salary)) : null, status,
      payroll: sl ? { month: sl.month, base: Number(sl.base), diff: sal === null ? null : Number(sl.base) - sal } : null };
  });
}
router.get('/comp/positioning', M, async (req, res) => {
  const items = await positioning(req);
  await audit(req, 'comp_positioning', null, 'read', null, null);
  const cr = items.filter((i) => i.compaRatio !== null).map((i) => i.compaRatio);
  res.json({ items, summary: { avgCompaRatio: cr.length ? L.r2(L.avg(cr)) : null, belowMin: items.filter((i) => i.status === 'below_min').length, aboveMax: items.filter((i) => i.status === 'above_max').length, inRange: items.filter((i) => i.status === 'in_range').length, noGrade: items.filter((i) => i.status === 'no_grade').length,
    payrollMismatch: items.filter((i) => i.payroll && i.payroll.diff !== null && i.payroll.diff !== 0).length } });
});
router.get('/comp/mine', async (req, res) => {
  const me = await C.meEmp(req); if (!me) return res.json({ item: null });
  const p = (await positioning(req)).find((i) => i.employeeId === Number(me.id));
  const items = await db.prepare('SELECT * FROM rh_pay_items WHERE employee_id = ? ORDER BY id').all(me.id);
  await audit(req, 'comp_positioning', me.id, 'read', null, { by: 'self' });
  res.json({ item: p ? { salary: p.salary, compaRatio: p.compaRatio, status: p.status, min: p.min, max: p.max, items: items.map((i) => ({ kind: i.kind, label: i.label, amount: Number(i.amount), recurrence: i.recurrence })) } : null });
});

/** Taux de charges patronales : réel (paie validée : coût employeur / brut) s'il existe, sinon repère modifiable. */
async function chargesRate(req, v) {
  if (v !== undefined && v !== null && v !== '') { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, 'Taux de charges : entre 0 et 1 (0,2 = 20 %).'); return { rate: n, source: 'param' }; }
  const r = await db.prepare('SELECT COALESCE(SUM(employer_cost), 0) c, COALESCE(SUM(gross), 0) g FROM payroll_slips WHERE org_id = ? AND gross > 0').get(req.org.id);
  if (Number(r.g) > 0 && Number(r.c) >= Number(r.g)) return { rate: Math.round((Number(r.c) / Number(r.g) - 1) * 10000) / 10000, source: 'payroll' };
  return { rate: 0.2, source: 'default' };
}
router.get('/comp/charges-rate', M, async (req, res) => res.json(await chargesRate(req)));

async function simRows(req) {
  const pos = await positioning(req);
  const rev = await (async () => { const rows = await db.prepare('SELECT * FROM rh_talent_reviews WHERE org_id = ? ORDER BY period, id').all(req.org.id); const m = new Map(); for (const r of rows) m.set(Number(r.employee_id), L.nineBox(Number(r.performance), Number(r.potential)).box); return m; })();
  return pos.filter((p) => p.salary !== null).map((p) => ({ employeeId: p.employeeId, name: p.name, salary: p.salary, min: p.min, mid: p.mid, max: p.max, box: rev.get(p.employeeId) || null }));
}
/** Simulation de révision : augmentation générale + mérite selon la case 9-box + remise au minimum de la grille + plafonds. */
async function simulate(req, params) {
  const p = { generalPct: Number(params.generalPct || 0), meritByBox: params.meritByBox || {}, minToGrade: !!params.minToGrade, capToMax: !!params.capToMax, capPct: params.capPct === undefined || params.capPct === null || params.capPct === '' ? null : Number(params.capPct) };
  if (!Number.isFinite(p.generalPct) || p.generalPct < -50 || p.generalPct > 100) throw new HttpError(400, 'Augmentation générale : entre -50 et 100 %.');
  for (const [k, v] of Object.entries(p.meritByBox)) if (!/^[1-9]$/.test(k) || !Number.isFinite(Number(v)) || Number(v) < -50 || Number(v) > 100) throw new HttpError(400, 'Mérite par case : cases 1 à 9, pourcentages entre -50 et 100.');
  const cr = await chargesRate(req, params.chargesRate);
  const sim = L.simulateRaise(await simRows(req), p);
  return { params: p, chargesRate: cr, ...sim, annualDeltaWithCharges: Math.round(sim.annualDelta * (1 + cr.rate)), raised: sim.lines.filter((l) => l.delta > 0).length, lines: sim.lines.map((l) => ({ employeeId: l.employeeId, name: l.name, salary: l.salary, newSalary: l.newSalary, delta: l.delta, pct: l.pct, box: l.box, compa: l.mid ? L.compaRatio(l.salary, l.mid) : null, newCompa: l.newCompa })) };
}
router.post('/comp/simulate', M, async (req, res) => {
  const b = req.body || {}; const out = await simulate(req, b);
  let id = null;
  if (b.save) {
    id = Number((await db.prepare('INSERT INTO rh_pay_sims (org_id, name, params, result, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 100, { required: true, msg: 'Nommez la simulation.' }), JSON.stringify(out.params), JSON.stringify({ lines: out.lines.map((l) => [l.employeeId, l.salary, l.newSalary]), monthlyDelta: out.monthlyDelta }), req.user.id, nowISO())).lastInsertRowid);
    await audit(req, 'pay_sim', id, 'create', null, { monthlyDelta: out.monthlyDelta });
  }
  res.status(b.save ? 201 : 200).json({ id, ...out });
});
router.get('/comp/simulations', M, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM rh_pay_sims WHERE org_id = ? ORDER BY id DESC').all(req.org.id);
  res.json({ items: rows.map((s) => ({ id: Number(s.id), name: s.name, status: s.status, params: JSON.parse(s.params), monthlyDelta: JSON.parse(s.result).monthlyDelta, createdAt: s.created_at, appliedAt: s.applied_at })) });
});
/** Applique une simulation enregistrée : met à jour employees.salary (le salaire de base lu par la paie). Confirmation explicite obligatoire, tracée employé par employé. */
router.post('/comp/simulations/:id/apply', M, async (req, res) => {
  const s = await C.fromOrg(req, 'rh_pay_sims', req.params.id, 'Simulation introuvable.');
  if (s.status === 'applied') throw new HttpError(409, 'Cette simulation a déjà été appliquée.');
  if ((req.body || {}).confirm !== true) throw new HttpError(400, 'Confirmez explicitement l\'application (confirm: true) : elle modifie les salaires de base utilisés par la paie.');
  const lines = JSON.parse(s.result).lines; let n = 0;
  await db.transaction(async () => {
    for (const [eid, before, after] of lines) {
      if (before === after) continue;
      const e = await db.prepare('SELECT salary FROM employees WHERE id = ? AND org_id = ?').get(eid, req.org.id);
      if (!e || Number(e.salary) !== Number(before)) throw new HttpError(409, 'Un salaire a changé depuis la simulation : refaites-la.');
      await db.prepare('UPDATE employees SET salary = ? WHERE id = ?').run(after, eid);
      await audit(req, 'salary', eid, 'update', { salary: before }, { salary: after }); n++;
    }
    await db.prepare("UPDATE rh_pay_sims SET status = 'applied', applied_at = ? WHERE id = ?").run(nowISO(), s.id);
  })();
  res.json({ ok: true, updated: n });
});

/** Masse salariale prévisionnelle sur 12 mois : salaires de base + primes/avantages récurrents + embauches d'un scénario + effet d'une simulation, avec charges. */
router.get('/comp/forecast', M, async (req, res) => {
  const y = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : Number(C.today().slice(0, 4));
  const emps = (await require('./hr').employees(req)).filter((e) => e.status === 'active');
  const base = emps.reduce((s, e) => s + Number(e.salary || 0), 0);
  const items = (await db.prepare('SELECT * FROM rh_pay_items WHERE org_id = ?').all(req.org.id)).reduce((s, i) => s + monthlyOf(i), 0);
  let sim = 0; let simFrom = 1;
  if (req.query.simulationId) { const sm = await C.fromOrg(req, 'rh_pay_sims', req.query.simulationId, 'Simulation introuvable.'); sim = sm.status === 'applied' ? 0 : JSON.parse(sm.result).monthlyDelta; simFrom = Math.min(12, Math.max(1, Number(req.query.simFrom) || 1)); }
  let lines = []; let rate = (await chargesRate(req, req.query.chargesRate)).rate;
  if (req.query.scenarioId) { const sc = await C.fromOrg(req, 'rh_scenarios', req.query.scenarioId, 'Scénario introuvable.'); lines = await db.prepare('SELECT * FROM rh_scenario_lines WHERE scenario_id = ?').all(sc.id); if (req.query.chargesRate === undefined) rate = Number(sc.charges_rate); }
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1; const hires = lines.reduce((s, l) => s + (m >= Number(l.start_month) ? Number(l.qty) * Number(l.monthly_salary) : 0), 0); const raise = m >= simFrom ? sim : 0;
    const gross = base + items + hires + raise;
    return { month: `${y}-${String(m).padStart(2, '0')}`, base, items, hires, raise, gross, withCharges: Math.round(gross * (1 + rate)) };
  });
  res.json({ year: y, chargesRate: rate, months, totalGross: months.reduce((s, m) => s + m.gross, 0), totalWithCharges: months.reduce((s, m) => s + m.withCharges, 0) });
});

module.exports = router;
module.exports.positioning = positioning;
module.exports.chargesRate = chargesRate;
