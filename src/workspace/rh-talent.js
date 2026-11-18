'use strict';
// RH Talents · gestion des talents : matrice 9-box (performance × potentiel), viviers de talents, hauts potentiels, plans de développement individuels (PDI).
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, W, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const T = need('talent');
const scale = (v, what) => { const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < 1 || n > 5) throw new HttpError(400, `${what} : note de 1 à 5.`); return Math.round(n * 10) / 10; };

/** Dernière évaluation de chaque employé (ou celle de la période demandée). */
async function latestReviews(req, period) {
  const rows = await db.prepare(`SELECT * FROM rh_talent_reviews WHERE org_id = ?${period ? ' AND period = ?' : ''} ORDER BY period, id`).all(...(period ? [req.org.id, period] : [req.org.id]));
  const m = new Map(); for (const r of rows) m.set(Number(r.employee_id), r); // le plus récent (période la plus grande) écrase
  return m;
}
router.get('/talent/ninebox', T, async (req, res) => {
  const period = req.query.period ? String(req.query.period).slice(0, 40) : null;
  const emps = (await require('./hr').employees(req)).filter((e) => e.status === 'active');
  const rev = await latestReviews(req, period); const nm = await C.names(req);
  const goals = new Map((await require('./rh-mbo').scoresOf(req, null)).map((s) => [s.employeeId, s.score]));
  const cells = Array.from({ length: 9 }, (_, i) => ({ box: i + 1, key: Object.values(L.BOX_KEYS)[0], employees: [] }));
  const rated = []; const unrated = [];
  const keyOf = (b) => Object.entries(L.BOX_KEYS).map(([k, v]) => ({ k, v })).find((x) => { const [p, q] = x.k.split('-').map(Number); return (q - 1) * 3 + p === b; }).v;
  cells.forEach((c) => { c.key = keyOf(c.box); });
  for (const e of emps) {
    const r = rev.get(Number(e.id)); const suggested = L.perfFromScore(goals.get(Number(e.id)) ?? null);
    if (!r) { unrated.push({ employeeId: Number(e.id), name: e.name, suggestedPerformance: suggested }); continue; }
    const nb = L.nineBox(Number(r.performance), Number(r.potential));
    const item = { employeeId: Number(e.id), name: e.name, performance: Number(r.performance), potential: Number(r.potential), period: r.period, box: nb.box, key: nb.key, highPotential: nb.highPotential, suggestedPerformance: suggested };
    rated.push(item); cells[nb.box - 1].employees.push({ employeeId: item.employeeId, name: item.name });
  }
  await audit(req, 'ninebox', null, 'read', null, { period });
  res.json({ period, cells, rated, unrated, highPotentials: rated.filter((x) => x.highPotential), counts: { rated: rated.length, unrated: unrated.length, highPotential: rated.filter((x) => x.highPotential).length } });
});
router.get('/talent/reviews', T, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM rh_talent_reviews WHERE org_id = ?' + (req.query.employeeId ? ' AND employee_id = ?' : '') + ' ORDER BY period DESC, id DESC LIMIT 500').all(...(req.query.employeeId ? [req.org.id, A.id(req.query.employeeId)] : [req.org.id]));
  const nm = await C.names(req);
  await audit(req, 'talent_review', null, 'read', null, null);
  res.json({ items: rows.map((r) => ({ id: Number(r.id), employeeId: Number(r.employee_id), employee: nm.get(Number(r.employee_id)) || '', period: r.period, performance: Number(r.performance), potential: Number(r.potential), note: r.note, ...L.nineBox(Number(r.performance), Number(r.potential)) })) });
});
router.put('/talent/reviews', async (req, res) => {
  const b = req.body || {}; const e = await C.emp(req, b.employeeId);
  if (!((await has(req, 'talent')) || (await C.isManagerOf(req, e.id)))) throw new HttpError(403, 'Accès non autorisé.');
  const period = A.text(b.period, 40, { required: true, msg: 'Indiquez la période (ex. 2026).' });
  let perf = b.performance;
  if (perf === undefined || perf === null || perf === '') { // performance par défaut : score de réalisation des objectifs (MBO)
    const sc = (await require('./rh-mbo').scoresOf(req, null)).find((s) => s.employeeId === Number(e.id));
    perf = sc && sc.score !== null ? L.perfFromScore(sc.score) : null;
    if (perf === null) throw new HttpError(400, 'Indiquez la performance (aucun objectif noté pour la proposer).');
  }
  const performance = scale(perf, 'Performance'); const potential = scale(b.potential, 'Potentiel');
  const prev = await db.prepare('SELECT * FROM rh_talent_reviews WHERE employee_id = ? AND period = ?').get(e.id, period);
  await db.prepare(`INSERT INTO rh_talent_reviews (org_id, employee_id, period, performance, potential, note, reviewer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (employee_id, period) DO UPDATE SET performance = EXCLUDED.performance, potential = EXCLUDED.potential, note = EXCLUDED.note, reviewer_id = EXCLUDED.reviewer_id`).run(req.org.id, e.id, period, performance, potential, A.text(b.note, 600), req.user.id, nowISO());
  await audit(req, 'talent_review', e.id, prev ? 'update' : 'create', prev ? { performance: prev.performance, potential: prev.potential } : null, { period, performance, potential });
  res.json({ ok: true, ...L.nineBox(performance, potential) });
});
/** L'intéressé voit sa propre note de performance de la dernière période (pas son potentiel ni sa case). */
router.get('/talent/mine', async (req, res) => {
  const me = await C.meEmp(req); if (!me) return res.json({ item: null });
  const r = await db.prepare('SELECT * FROM rh_talent_reviews WHERE employee_id = ? ORDER BY period DESC, id DESC LIMIT 1').get(me.id);
  await audit(req, 'talent_review', me.id, 'read', null, { by: 'self' });
  res.json({ item: r ? { period: r.period, performance: Number(r.performance), note: r.note } : null });
});

// ---------- Viviers ----------
C.simple(router, { path: '/talent/pools', table: 'rh_pools', entity: 'pool', read: ['talent'], write: ['talent'], order: 'name',
  fields: [{ k: 'name', t: 'text', max: 80, req: true, msg: 'Indiquez le nom du vivier.' }, { k: 'description', t: 'text', max: 400 }],
  decorate: async (req, rows) => {
    const m = await db.prepare('SELECT pm.pool_id, pm.employee_id, pm.note, e.name FROM rh_pool_members pm JOIN employees e ON e.id = pm.employee_id WHERE pm.org_id = ? ORDER BY e.name').all(req.org.id);
    return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), members: m.filter((x) => Number(x.pool_id) === Number(r.id)).map((x) => ({ employeeId: Number(x.employee_id), name: x.name, note: x.note })) } }));
  } });
router.post('/talent/pools/:id/members', T, async (req, res) => {
  const p = await C.fromOrg(req, 'rh_pools', req.params.id, 'Vivier introuvable.'); const e = await C.emp(req, (req.body || {}).employeeId);
  await db.prepare('INSERT INTO rh_pool_members (org_id, pool_id, employee_id, note, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(req.org.id, p.id, e.id, A.text((req.body || {}).note, 200), nowISO());
  await audit(req, 'pool', p.id, 'member_add', null, { employeeId: Number(e.id) });
  res.status(201).json({ ok: true });
});
router.delete('/talent/pools/:id/members/:employeeId', T, async (req, res) => {
  const p = await C.fromOrg(req, 'rh_pools', req.params.id, 'Vivier introuvable.');
  await db.prepare('DELETE FROM rh_pool_members WHERE pool_id = ? AND employee_id = ?').run(p.id, A.id(req.params.employeeId));
  await audit(req, 'pool', p.id, 'member_remove', { employeeId: req.params.employeeId }, null);
  res.json({ ok: true });
});

// ---------- Plans de développement individuels ----------
async function idpAccess(req, idp) {
  return (await has(req, 'talent')) || (await C.isSelf(req, idp.employee_id)) || (await C.isManagerOf(req, idp.employee_id));
}
router.get('/talent/idp', async (req, res) => {
  const priv = await has(req, 'talent'); const me = await C.meEmp(req); const rep = new Set(await C.reports(req));
  let rows = await db.prepare('SELECT * FROM rh_idp WHERE org_id = ? ORDER BY id DESC').all(req.org.id);
  if (!priv) rows = rows.filter((i) => (me && Number(i.employee_id) === Number(me.id)) || rep.has(Number(i.employee_id)));
  const nm = await C.names(req); const acts = await db.prepare("SELECT ref_id, status FROM rh_actions WHERE org_id = ? AND kind = 'pdi'").all(req.org.id);
  const jobs = new Map((await db.prepare('SELECT id, title FROM rh_job_profiles WHERE org_id = ?').all(req.org.id)).map((j) => [Number(j.id), j.title]));
  res.json({ items: rows.map((i) => { const a = acts.filter((x) => Number(x.ref_id) === Number(i.id)); return { id: Number(i.id), employeeId: Number(i.employee_id), employee: nm.get(Number(i.employee_id)) || '', title: i.title, targetJobProfileId: i.target_job_profile_id == null ? null : Number(i.target_job_profile_id), targetJob: jobs.get(Number(i.target_job_profile_id)) || '', horizon: i.horizon, status: i.status, actions: a.length, actionsDone: a.filter((x) => x.status === 'done').length }; }) });
});
router.post('/talent/idp', async (req, res) => {
  const b = req.body || {}; const e = await C.emp(req, b.employeeId);
  if (!((await has(req, 'talent')) || (await C.isManagerOf(req, e.id)))) throw new HttpError(403, 'Accès non autorisé.');
  const id = Number((await db.prepare('INSERT INTO rh_idp (org_id, employee_id, title, target_job_profile_id, horizon, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, e.id, A.text(b.title, 160, { required: true, msg: 'Indiquez l\'objectif de développement.' }), await C.optRef(req, 'rh_job_profiles', b.targetJobProfileId, 'Emploi inconnu.'), A.text(b.horizon, 40), req.user.id, nowISO())).lastInsertRowid);
  await audit(req, 'idp', id, 'create', null, { employeeId: Number(e.id) });
  res.status(201).json({ id });
});
router.put('/talent/idp/:id', async (req, res) => {
  const i = await C.fromOrg(req, 'rh_idp', req.params.id, 'Plan introuvable.');
  if (!((await has(req, 'talent')) || (await C.isManagerOf(req, i.employee_id)))) throw new HttpError(403, 'Accès non autorisé.');
  const b = req.body || {};
  await db.prepare('UPDATE rh_idp SET title = ?, horizon = ?, status = ?, target_job_profile_id = ? WHERE id = ?').run(b.title === undefined ? i.title : A.text(b.title, 160, { required: true }), b.horizon === undefined ? i.horizon : A.text(b.horizon, 40), b.status === undefined ? i.status : A.oneOf(b.status, ['active', 'done', 'cancelled'], undefined, 'Statut inconnu.'),
    b.targetJobProfileId === undefined ? i.target_job_profile_id : await C.optRef(req, 'rh_job_profiles', b.targetJobProfileId, 'Emploi inconnu.'), i.id);
  await audit(req, 'idp', i.id, 'update', { status: i.status }, { status: b.status });
  res.json({ ok: true });
});
/** Écarts de compétences entre l'employé et l'emploi visé par son PDI. */
router.get('/talent/idp/:id/gaps', async (req, res) => {
  const i = await C.fromOrg(req, 'rh_idp', req.params.id, 'Plan introuvable.');
  if (!(await idpAccess(req, i))) throw new HttpError(403, 'Accès non autorisé.');
  const target = i.target_job_profile_id; if (!target) return res.json({ items: [], coverage: null });
  const rq = (await db.prepare('SELECT jc.*, c.name FROM rh_job_competencies jc JOIN rh_competencies c ON c.id = jc.competency_id WHERE jc.job_profile_id = ?').all(target)).map((r) => ({ competencyId: Number(r.competency_id), name: r.name, required: Number(r.required_level), weight: Number(r.weight) }));
  const held = new Map((await db.prepare('SELECT competency_id, level FROM rh_emp_skills WHERE employee_id = ?').all(i.employee_id)).map((s) => [Number(s.competency_id), Number(s.level)]));
  const g = L.gaps(rq, held).map((x, k) => ({ ...x, name: rq[k].name }));
  res.json({ items: g, coverage: L.coverage(g.map((x) => ({ held: x.held, required: x.required, weight: x.weight }))) });
});
router.delete('/talent/idp/:id', T, async (req, res) => {
  const i = await C.fromOrg(req, 'rh_idp', req.params.id, 'Plan introuvable.');
  await db.prepare("DELETE FROM rh_actions WHERE kind = 'pdi' AND ref_id = ? AND org_id = ?").run(i.id, req.org.id);
  await db.prepare('DELETE FROM rh_idp WHERE id = ?').run(i.id);
  await audit(req, 'idp', i.id, 'delete', { title: i.title }, null);
  res.json({ ok: true });
});

module.exports = router;
