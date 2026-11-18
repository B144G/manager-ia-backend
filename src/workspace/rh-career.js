'use strict';
// RH Talents · carrières et succession (parcours, postes clés, successeurs et degré de préparation, risque de vacance, risque de départ, plans de rétention)
// et engagement (enquêtes pulsées anonymes, eNPS, plans d'action).
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, W, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const T = need('talent');
const jobTitles = async (req) => new Map((await db.prepare('SELECT id, title FROM rh_job_profiles WHERE org_id = ?').all(req.org.id)).map((j) => [Number(j.id), j.title]));

// ---------- Parcours de carrière ----------
C.simple(router, { path: '/career/paths', table: 'rh_career_paths', entity: 'career_path', read: ['talent'], write: ['talent'], order: 'from_job_id, to_job_id', noCreated: true,
  fields: [{ k: 'fromJobId', t: 'ref', ref: 'rh_job_profiles', req: true, label: 'Emploi de départ', msg: "Choisissez l'emploi de départ." }, { k: 'toJobId', t: 'ref', ref: 'rh_job_profiles', req: true, label: "Emploi d'arrivée", msg: "Choisissez l'emploi d'arrivée." }, { k: 'typicalYears', t: 'int', min: 0, max: 40, def: 2 }, { k: 'note', t: 'text', max: 300 }],
  validate: async (req, v, cur) => { if (Number(v.from_job_id ?? cur?.from_job_id) === Number(v.to_job_id ?? cur?.to_job_id)) throw new HttpError(400, 'Départ et arrivée sont identiques.'); },
  decorate: async (req, rows) => { const j = await jobTitles(req); return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), from: j.get(Number(r.from_job_id)) || '', to: j.get(Number(r.to_job_id)) || '' } })); } });
/** Préparation d'un employé à un emploi cible : taux de couverture de ses compétences face à celles de l'emploi. */
async function readinessFor(empId, jobId) {
  const rq = (await db.prepare('SELECT * FROM rh_job_competencies WHERE job_profile_id = ?').all(jobId)).map((r) => ({ competencyId: Number(r.competency_id), required: Number(r.required_level), weight: Number(r.weight) }));
  if (!rq.length) return { coverage: null, suggested: null, gaps: [] };
  const held = new Map((await db.prepare('SELECT competency_id, level FROM rh_emp_skills WHERE employee_id = ?').all(empId)).map((s) => [Number(s.competency_id), Number(s.level)]));
  const g = L.gaps(rq, held); const cov = L.coverage(g.map((x) => ({ held: x.held, required: x.required, weight: x.weight })));
  return { coverage: cov, suggested: cov >= 90 ? 'now' : cov >= 70 ? '1-2y' : '3y+', gaps: g.filter((x) => x.gap > 0).length };
}
router.get('/career/employee/:id', async (req, res) => {
  const e = await C.emp(req, req.params.id);
  if (!((await has(req, 'talent')) || (await C.isSelf(req, e.id)) || (await C.isManagerOf(req, e.id)))) throw new HttpError(403, 'Accès non autorisé.');
  const p = await db.prepare('SELECT * FROM rh_emp_profile WHERE employee_id = ?').get(e.id); const j = await jobTitles(req);
  const from = p && p.job_profile_id ? Number(p.job_profile_id) : null;
  const next = from ? await db.prepare('SELECT * FROM rh_career_paths WHERE org_id = ? AND from_job_id = ?').all(req.org.id, from) : [];
  const out = []; for (const n of next) out.push({ jobProfileId: Number(n.to_job_id), job: j.get(Number(n.to_job_id)) || '', typicalYears: Number(n.typical_years), note: n.note, ...(await readinessFor(e.id, n.to_job_id)) });
  res.json({ employee: { id: Number(e.id), name: e.name, job: from ? j.get(from) || e.job : e.job, hiredAt: e.hired_at }, options: out.sort((a, b) => (b.coverage ?? -1) - (a.coverage ?? -1)) });
});

// ---------- Postes clés et succession ----------
C.simple(router, { path: '/career/key-positions', table: 'rh_key_positions', entity: 'key_position', read: ['talent'], write: ['talent'], order: 'criticality DESC, title',
  fields: [{ k: 'title', t: 'text', max: 120, req: true, msg: 'Indiquez le poste clé.' }, { k: 'jobProfileId', t: 'ref', ref: 'rh_job_profiles', label: 'Emploi' }, { k: 'holderId', t: 'ref', ref: 'employees', label: 'Titulaire' }, { k: 'criticality', t: 'int', min: 1, max: 3, def: 2 }, { k: 'note', t: 'text', max: 400 }] });

async function successionRows(req) {
  const kps = await db.prepare('SELECT * FROM rh_key_positions WHERE org_id = ? ORDER BY criticality DESC, title').all(req.org.id);
  const succ = await db.prepare('SELECT * FROM rh_successors WHERE org_id = ?').all(req.org.id);
  const nm = await C.names(req); const today = C.today();
  const emps = new Map((await db.prepare('SELECT id, status, birth_date FROM employees WHERE org_id = ?').all(req.org.id)).map((e) => [Number(e.id), e]));
  const ret = new Map((await db.prepare('SELECT * FROM rh_retention WHERE org_id = ?').all(req.org.id)).map((r) => [Number(r.employee_id), r]));
  const out = [];
  for (const k of kps) {
    const holder = k.holder_id ? emps.get(Number(k.holder_id)) : null;
    const vacant = !holder || holder.status !== 'active';
    const list = succ.filter((s) => Number(s.key_position_id) === Number(k.id));
    const sx = []; for (const s of list) sx.push({ employeeId: Number(s.employee_id), name: nm.get(Number(s.employee_id)) || '', readiness: s.readiness, note: s.note, suggested: k.job_profile_id ? (await readinessFor(s.employee_id, k.job_profile_id)).suggested : null, coverage: k.job_profile_id ? (await readinessFor(s.employee_id, k.job_profile_id)).coverage : null });
    const hr = holder && ret.get(Number(k.holder_id)) ? ret.get(Number(k.holder_id)).risk : 'low';
    const age = holder ? L.ageOf(holder.birth_date, today) : null;
    const risk = L.vacancyRisk({ criticality: Number(k.criticality), successors: sx, holderRisk: hr, holderAge: age, vacant });
    out.push({ id: Number(k.id), title: k.title, jobProfileId: k.job_profile_id == null ? null : Number(k.job_profile_id), holderId: k.holder_id == null ? null : Number(k.holder_id), holder: k.holder_id ? nm.get(Number(k.holder_id)) || '' : '', vacant, criticality: Number(k.criticality), holderRisk: hr, holderAge: age, successors: sx, vacancyRisk: risk.level, riskPoints: risk.points, readyNow: risk.readyNow, ready12: risk.ready12, note: k.note });
  }
  return out;
}
router.get('/career/succession', T, async (req, res) => {
  const items = await successionRows(req);
  await audit(req, 'succession', null, 'read', null, null);
  res.json({ items, summary: { positions: items.length, critical: items.filter((i) => i.vacancyRisk === 'critical').length, high: items.filter((i) => i.vacancyRisk === 'high').length, noSuccessor: items.filter((i) => !i.successors.length).length, covered: items.filter((i) => i.readyNow > 0).length } });
});
router.put('/career/key-positions/:id/successors', T, async (req, res) => {
  const k = await C.fromOrg(req, 'rh_key_positions', req.params.id, 'Poste clé introuvable.'); const b = req.body || {};
  const e = await C.emp(req, b.employeeId);
  if (k.holder_id && Number(k.holder_id) === Number(e.id)) throw new HttpError(400, 'Le titulaire ne peut pas être son propre successeur.');
  const readiness = A.oneOf(b.readiness, L.READY_OK, undefined, 'Degré de préparation : now (prêt maintenant), 1-2y, 3y+.');
  await db.prepare(`INSERT INTO rh_successors (org_id, key_position_id, employee_id, readiness, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (key_position_id, employee_id) DO UPDATE SET readiness = EXCLUDED.readiness, note = EXCLUDED.note`).run(req.org.id, k.id, e.id, readiness, A.text(b.note, 300));
  await audit(req, 'successor', k.id, 'set', null, { employeeId: Number(e.id), readiness });
  res.json({ ok: true });
});
router.delete('/career/key-positions/:id/successors/:employeeId', T, async (req, res) => {
  const k = await C.fromOrg(req, 'rh_key_positions', req.params.id, 'Poste clé introuvable.');
  await db.prepare('DELETE FROM rh_successors WHERE key_position_id = ? AND employee_id = ?').run(k.id, A.id(req.params.employeeId));
  await audit(req, 'successor', k.id, 'remove', { employeeId: req.params.employeeId }, null);
  res.json({ ok: true });
});

// ---------- Risque de départ et rétention ----------
router.get('/career/retention', T, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM rh_retention WHERE org_id = ? ORDER BY CASE risk WHEN \'high\' THEN 0 WHEN \'medium\' THEN 1 ELSE 2 END, id').all(req.org.id);
  const nm = await C.names(req); const acts = await db.prepare("SELECT employee_id, status FROM rh_actions WHERE org_id = ? AND kind = 'retention'").all(req.org.id);
  await audit(req, 'retention', null, 'read', null, null);
  res.json({ items: rows.map((r) => ({ employeeId: Number(r.employee_id), employee: nm.get(Number(r.employee_id)) || '', risk: r.risk, reason: r.reason, plan: r.plan, updatedAt: r.updated_at, actions: acts.filter((a) => Number(a.employee_id) === Number(r.employee_id)).length })) });
});
router.put('/career/retention/:employeeId', T, async (req, res) => {
  const e = await C.emp(req, req.params.employeeId); const b = req.body || {};
  const risk = A.oneOf(b.risk, ['low', 'medium', 'high'], undefined, 'Risque : faible, moyen ou élevé.');
  const prev = await db.prepare('SELECT * FROM rh_retention WHERE employee_id = ?').get(e.id);
  await db.prepare(`INSERT INTO rh_retention (org_id, employee_id, risk, reason, plan, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, employee_id) DO UPDATE SET risk = EXCLUDED.risk, reason = EXCLUDED.reason, plan = EXCLUDED.plan, updated_at = EXCLUDED.updated_at`).run(req.org.id, e.id, risk, A.text(b.reason, 400), A.text(b.plan, 800), nowISO());
  await audit(req, 'retention', e.id, prev ? 'update' : 'create', prev ? { risk: prev.risk } : null, { risk });
  res.json({ ok: true });
});

// ---------- Engagement : enquêtes pulsées, eNPS ----------
const qList = (s) => { try { return JSON.parse(s); } catch { return []; } };
router.get('/engagement/surveys', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM rh_surveys WHERE org_id = ? ORDER BY id DESC').all(req.org.id);
  const priv = await has(req, 'talent');
  const done = new Set((await db.prepare('SELECT survey_id FROM rh_survey_participation WHERE org_id = ? AND user_id = ?').all(req.org.id, req.user.id)).map((r) => Number(r.survey_id)));
  const cnt = new Map((await db.prepare('SELECT survey_id, COUNT(*) n FROM rh_survey_participation WHERE org_id = ? GROUP BY survey_id').all(req.org.id)).map((r) => [Number(r.survey_id), Number(r.n)]));
  res.json({ items: rows.filter((s) => priv || s.status === 'open').map((s) => ({ id: Number(s.id), title: s.title, status: s.status, minResponses: Number(s.min_responses), questions: qList(s.questions), responses: priv ? cnt.get(Number(s.id)) || 0 : undefined, answered: done.has(Number(s.id)), createdAt: s.created_at })) });
});
router.post('/engagement/surveys', T, async (req, res) => {
  const b = req.body || {};
  const min = b.minResponses === undefined ? 5 : Number(b.minResponses);
  if (!Number.isInteger(min) || min < 3 || min > 50) throw new HttpError(400, 'Seuil minimum de répondants : entre 3 et 50.');
  const qs = Array.isArray(b.questions) ? b.questions : [];
  if (qs.length > 30) throw new HttpError(400, '30 questions au plus.');
  const questions = [{ id: 'enps', kind: 'enps', text: 'Sur une échelle de 0 à 10, recommanderiez-vous cette organisation comme employeur ?' }, ...qs.map((q, i) => ({ id: 'q' + (i + 1), kind: 'scale', text: A.text(q.text || q, 200, { required: true, msg: 'Chaque question doit avoir un texte.' }) }))];
  const id = Number((await db.prepare('INSERT INTO rh_surveys (org_id, title, min_responses, questions, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, A.text(b.title, 120, { required: true, msg: "Indiquez le titre de l'enquête." }), min, JSON.stringify(questions), req.user.id, nowISO())).lastInsertRowid);
  await audit(req, 'survey', id, 'create', null, { questions: questions.length });
  res.status(201).json({ id });
});
router.put('/engagement/surveys/:id/status', T, async (req, res) => {
  const s = await C.fromOrg(req, 'rh_surveys', req.params.id, 'Enquête introuvable.');
  const to = A.oneOf((req.body || {}).status, ['open', 'closed'], undefined, 'Statut inconnu.');
  if ((s.status === 'draft' && to !== 'open') || (s.status === 'open' && to !== 'closed') || s.status === 'closed') throw new HttpError(400, `Passage impossible : ${s.status} → ${to}.`);
  await db.prepare('UPDATE rh_surveys SET status = ?, closed_at = ? WHERE id = ?').run(to, to === 'closed' ? nowISO() : null, s.id);
  await audit(req, 'survey', s.id, 'status', { status: s.status }, { status: to });
  res.json({ ok: true });
});
/** Réponse anonyme : la participation est notée à part (une réponse par personne) et la réponse ne garde ni la personne ni l'heure précise. */
router.post('/engagement/surveys/:id/respond', async (req, res) => {
  const s = await C.fromOrg(req, 'rh_surveys', req.params.id, 'Enquête introuvable.');
  if (s.status !== 'open') throw new HttpError(409, "L'enquête n'est pas ouverte.");
  const qs = qList(s.questions); const a = (req.body || {}).answers || {}; const clean = {};
  for (const q of qs) {
    const v = Number(a[q.id]);
    if (!Number.isInteger(v)) throw new HttpError(400, 'Répondez à toutes les questions.');
    if (q.kind === 'enps' ? v < 0 || v > 10 : v < 1 || v > 5) throw new HttpError(400, q.kind === 'enps' ? 'Note de 0 à 10.' : 'Note de 1 à 5.');
    clean[q.id] = v;
  }
  const me = await C.meEmp(req); const p = me ? await db.prepare('SELECT department_id FROM rh_emp_profile WHERE employee_id = ?').get(me.id) : null;
  await db.transaction(async () => {
    const ins = await db.prepare('INSERT INTO rh_survey_participation (org_id, survey_id, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(req.org.id, s.id, req.user.id);
    if (!ins.changes) throw new HttpError(409, 'Vous avez déjà répondu à cette enquête.');
    await db.prepare('INSERT INTO rh_survey_responses (org_id, survey_id, department_id, answers, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, s.id, p && p.department_id ? p.department_id : null, JSON.stringify(clean), nowISO().slice(0, 10));
  })();
  res.status(201).json({ ok: true });
});
async function surveyResults(req, s) {
  const qs = qList(s.questions); const min = Number(s.min_responses);
  const rows = await db.prepare('SELECT * FROM rh_survey_responses WHERE survey_id = ?').all(s.id);
  const members = Number((await db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(req.org.id)).c);
  const base = { id: Number(s.id), title: s.title, status: s.status, responses: rows.length, participation: members ? L.r1(100 * rows.length / members) : null, minResponses: min };
  if (rows.length < min) return { ...base, hidden: true, enps: null, questions: [], departments: [] };
  const ans = rows.map((r) => JSON.parse(r.answers));
  const deps = new Map((await db.prepare('SELECT id, name FROM rh_departments WHERE org_id = ?').all(req.org.id)).map((d) => [Number(d.id), d.name]));
  const byDep = new Map(); rows.forEach((r, i) => { const k = r.department_id == null ? 0 : Number(r.department_id); byDep.set(k, [...(byDep.get(k) || []), ans[i]]); });
  const shownDeps = [...byDep.entries()].filter(([, l]) => l.length >= min);
  // si un seul service est masqué, l'ensemble moins les services montrés le révélerait : on masque alors aussi le détail par service
  const hiddenAny = [...byDep.values()].some((l) => l.length < min);
  const departments = hiddenAny ? [] : shownDeps.map(([k, l]) => ({ departmentId: k, name: deps.get(k) || 'Non rattaché', responses: l.length, enps: L.enps(l.map((x) => x.enps)).score, avg: L.r2(L.avg(l.flatMap((x) => qs.filter((q) => q.kind === 'scale').map((q) => x[q.id])))) }));
  return { ...base, hidden: false, enps: L.enps(ans.map((x) => x.enps)), questions: qs.filter((q) => q.kind === 'scale').map((q) => ({ id: q.id, text: q.text, avg: L.r2(L.avg(ans.map((x) => x[q.id]))) })), departments, departmentsHidden: hiddenAny, avg: L.r2(L.avg(ans.flatMap((x) => qs.filter((q) => q.kind === 'scale').map((q) => x[q.id])))) };
}
router.get('/engagement/surveys/:id/results', T, async (req, res) => {
  const s = await C.fromOrg(req, 'rh_surveys', req.params.id, 'Enquête introuvable.');
  await audit(req, 'survey_results', s.id, 'read', null, null);
  res.json(await surveyResults(req, s));
});
router.get('/engagement/trend', T, async (req, res) => {
  const rows = await db.prepare("SELECT * FROM rh_surveys WHERE org_id = ? AND status IN ('open','closed') ORDER BY id").all(req.org.id);
  const out = []; for (const s of rows) { const r = await surveyResults(req, s); out.push({ id: r.id, title: r.title, responses: r.responses, hidden: r.hidden, enps: r.enps ? r.enps.score : null, avg: r.avg ?? null }); }
  res.json({ items: out });
});

module.exports = router;
module.exports.successionRows = successionRows;
module.exports.surveyResults = surveyResults;
