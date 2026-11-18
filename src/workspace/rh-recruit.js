'use strict';
// RH Talents · recrutement par compétences : fiche de poste liée aux compétences requises, offres, candidats, grille d'évaluation par compétence,
// score de correspondance, entretiens structurés, pipeline kanban, passage candidat → employé. Réutilise hr_jobs et hr_candidates (complétés, jamais remplacés).
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const R = need('recrut');
const STAGES = ['new', 'screening', 'interview', 'offer', 'hired', 'rejected'];

async function requirements(profileId) {
  if (!profileId) return [];
  return (await db.prepare('SELECT jc.*, c.name FROM rh_job_competencies jc JOIN rh_competencies c ON c.id = jc.competency_id WHERE jc.job_profile_id = ? ORDER BY c.name').all(profileId))
    .map((r) => ({ competencyId: Number(r.competency_id), name: r.name, required: Number(r.required_level), weight: Number(r.weight) }));
}
/** Moyenne des notes par compétence pour un candidat (toutes les évaluations de tous les évaluateurs). */
async function scoreMap(candidateId) {
  const rows = await db.prepare('SELECT competency_id, AVG(score) a, COUNT(*) n FROM rh_cand_scores WHERE candidate_id = ? GROUP BY competency_id').all(candidateId);
  return new Map(rows.map((r) => [Number(r.competency_id), Number(r.a)]));
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const jobView = async (req, j, counts) => ({ id: Number(j.id), title: j.title, description: j.description, status: j.status, profileId: j.profile_id == null ? null : Number(j.profile_id), departmentId: j.department_id == null ? null : Number(j.department_id), positionId: j.position_id == null ? null : Number(j.position_id),
  openedAt: j.opened_at || String(j.created_at).slice(0, 10), closedAt: j.closed_at, recruitCost: Number(j.recruit_cost), candidates: counts.get(Number(j.id)) || 0, requirements: await requirements(j.profile_id) });

router.get('/jobs', R, async (req, res) => {
  const rows = await db.prepare("SELECT * FROM hr_jobs WHERE org_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC").all(req.org.id);
  const counts = new Map((await db.prepare('SELECT job_id, COUNT(*) n FROM hr_candidates WHERE org_id = ? GROUP BY job_id').all(req.org.id)).map((c) => [Number(c.job_id), Number(c.n)]));
  const items = []; for (const j of rows) items.push(await jobView(req, j, counts));
  res.json({ items });
});
router.post('/jobs', R, async (req, res) => {
  const b = req.body || {};
  const prof = await C.optRef(req, 'rh_job_profiles', b.profileId, 'Emploi inconnu.');
  const pr = prof ? await db.prepare('SELECT * FROM rh_job_profiles WHERE id = ?').get(prof) : null;
  const title = A.text(b.title || (pr && pr.title), 120, { required: true, msg: "Indiquez l'intitulé du poste." });
  const id = Number((await db.prepare("INSERT INTO hr_jobs (org_id, position_id, title, description, status, created_at, profile_id, department_id, opened_at, recruit_cost) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)").run(req.org.id, await C.optRef(req, 'positions', b.positionId, 'Poste inconnu.'), title,
    A.text(b.description || (pr && pr.description), 2000), nowISO(), prof, await C.optRef(req, 'rh_departments', b.departmentId, 'Service inconnu.'), A.date(b.openedAt) || C.today(), b.recruitCost ? A.amount(b.recruitCost) : 0)).lastInsertRowid);
  await audit(req, 'job', id, 'create', null, { title, profileId: prof });
  res.status(201).json({ id });
});
router.put('/jobs/:id', R, async (req, res) => {
  const j = await C.fromOrg(req, 'hr_jobs', req.params.id, 'Offre introuvable.'); const b = req.body || {};
  const sets = {};
  if (b.profileId !== undefined) sets.profile_id = await C.optRef(req, 'rh_job_profiles', b.profileId, 'Emploi inconnu.');
  if (b.departmentId !== undefined) sets.department_id = await C.optRef(req, 'rh_departments', b.departmentId, 'Service inconnu.');
  if (b.recruitCost !== undefined) sets.recruit_cost = b.recruitCost ? A.amount(b.recruitCost) : 0;
  if (b.openedAt !== undefined) sets.opened_at = A.date(b.openedAt);
  if (b.title !== undefined) sets.title = A.text(b.title, 120, { required: true });
  if (b.description !== undefined) sets.description = A.text(b.description, 2000);
  if (b.status !== undefined) { sets.status = A.oneOf(b.status, ['open', 'closed'], undefined, 'Statut inconnu.'); sets.closed_at = sets.status === 'closed' ? A.date(b.closedAt) || C.today() : null; }
  if (Object.keys(sets).length) await db.prepare(`UPDATE hr_jobs SET ${Object.keys(sets).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(sets), j.id);
  await audit(req, 'job', j.id, 'update', { status: j.status }, sets);
  res.json({ ok: true });
});
/** Fiche de poste : intitulé, mission, compétences requises avec niveau — prête à publier. */
router.get('/jobs/:id/sheet', R, async (req, res) => {
  const j = await C.fromOrg(req, 'hr_jobs', req.params.id, 'Offre introuvable.');
  const prof = j.profile_id ? await db.prepare('SELECT * FROM rh_job_profiles WHERE id = ?').get(j.profile_id) : null;
  res.json({ title: j.title, description: j.description, family: prof ? prof.family : '', requirements: await requirements(j.profile_id) });
});

async function candView(req, c, scoresByCand) {
  const job = await db.prepare('SELECT * FROM hr_jobs WHERE id = ?').get(c.job_id);
  const rq = await requirements(job && job.profile_id);
  const sm = scoresByCand ? scoresByCand.get(Number(c.id)) || new Map() : await scoreMap(c.id);
  const m = L.matchScore(rq, sm);
  return { id: Number(c.id), jobId: Number(c.job_id), job: job ? job.title : '', name: c.name, phone: c.phone, email: c.email, stage: c.stage, note: c.note, source: c.source || '', expectedSalary: Number(c.expected_salary || 0), rejectReason: c.reject_reason || '',
    hiredEmployeeId: c.hired_employee_id == null ? null : Number(c.hired_employee_id), match: m.score, evaluated: m.evaluated, requiredCount: m.total, createdAt: c.created_at };
}
async function allScores(req) {
  const rows = await db.prepare('SELECT candidate_id, competency_id, AVG(score) a FROM rh_cand_scores WHERE org_id = ? GROUP BY candidate_id, competency_id').all(req.org.id);
  const m = new Map(); for (const r of rows) { const x = m.get(Number(r.candidate_id)) || new Map(); x.set(Number(r.competency_id), Number(r.a)); m.set(Number(r.candidate_id), x); }
  return m;
}
router.get('/candidates', R, async (req, res) => {
  const rows = req.query.jobId ? await db.prepare('SELECT * FROM hr_candidates WHERE org_id = ? AND job_id = ? ORDER BY id DESC').all(req.org.id, A.id(req.query.jobId)) : await db.prepare('SELECT * FROM hr_candidates WHERE org_id = ? ORDER BY id DESC LIMIT 500').all(req.org.id);
  const sc = await allScores(req); const items = [];
  for (const c of rows) items.push(await candView(req, c, sc));
  res.json({ items: items.sort((a, b) => (b.match ?? -1) - (a.match ?? -1)) });
});
router.post('/candidates', R, async (req, res) => {
  const b = req.body || {}; const job = await C.fromOrg(req, 'hr_jobs', b.jobId, "Offre introuvable.");
  const id = Number((await db.prepare('INSERT INTO hr_candidates (org_id, job_id, name, phone, email, stage, note, created_at, source, stage_at, expected_salary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, job.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du candidat.' }), A.text(b.phone, 40), A.text(b.email, 120), 'new', A.text(b.note, 1000), nowISO(), A.text(b.source, 60), nowISO(), b.expectedSalary ? A.amount(b.expectedSalary) : 0)).lastInsertRowid);
  await audit(req, 'candidate', id, 'create', null, { jobId: Number(job.id) });
  res.status(201).json({ id });
});
router.put('/candidates/:id', R, async (req, res) => {
  const c = await C.fromOrg(req, 'hr_candidates', req.params.id, 'Candidat introuvable.'); const b = req.body || {}; const sets = {};
  if (b.name !== undefined) sets.name = A.text(b.name, 100, { required: true });
  for (const [k, col, n] of [['phone', 'phone', 40], ['email', 'email', 120], ['note', 'note', 1000], ['source', 'source', 60]]) if (b[k] !== undefined) sets[col] = A.text(b[k], n);
  if (b.expectedSalary !== undefined) sets.expected_salary = b.expectedSalary ? A.amount(b.expectedSalary) : 0;
  if (b.stage !== undefined && b.stage !== c.stage) {
    const st = A.oneOf(b.stage, STAGES, undefined, 'Étape inconnue.');
    if (st === 'hired') throw new HttpError(400, "Utilisez « Embaucher » pour passer un candidat en employé.");
    if (c.stage === 'hired') throw new HttpError(409, 'Ce candidat est déjà embauché.');
    sets.stage = st; sets.stage_at = nowISO();
    if (st === 'rejected') sets.reject_reason = A.text(b.rejectReason, 300);
  }
  if (Object.keys(sets).length) await db.prepare(`UPDATE hr_candidates SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(sets), c.id);
  await audit(req, 'candidate', c.id, 'update', { stage: c.stage }, { stage: sets.stage || c.stage });
  res.json({ ok: true });
});
router.delete('/candidates/:id', R, async (req, res) => {
  const c = await C.fromOrg(req, 'hr_candidates', req.params.id, 'Candidat introuvable.');
  if (c.stage === 'hired') throw new HttpError(409, 'Un candidat embauché ne se supprime pas.');
  await db.prepare('DELETE FROM hr_candidates WHERE id = ?').run(c.id);
  await audit(req, 'candidate', c.id, 'delete', { name: c.name }, null);
  res.json({ ok: true });
});
/** Pipeline kanban d'une offre. */
router.get('/pipeline', R, async (req, res) => {
  const job = await C.fromOrg(req, 'hr_jobs', req.query.jobId, 'Offre introuvable.');
  const rows = await db.prepare('SELECT * FROM hr_candidates WHERE job_id = ? AND org_id = ? ORDER BY id').all(job.id, req.org.id);
  const sc = await allScores(req); const cards = []; for (const c of rows) cards.push(await candView(req, c, sc));
  res.json({ job: await jobView(req, job, new Map([[Number(job.id), rows.length]])), columns: STAGES.map((s) => ({ stage: s, items: cards.filter((x) => x.stage === s).sort((a, b) => (b.match ?? -1) - (a.match ?? -1)) })) });
});
/** Grille d'évaluation d'un candidat : pour chaque compétence requise, niveau requis, note moyenne, nombre d'évaluateurs. */
router.get('/candidates/:id/grid', R, async (req, res) => {
  const c = await C.fromOrg(req, 'hr_candidates', req.params.id, 'Candidat introuvable.');
  const job = await db.prepare('SELECT * FROM hr_jobs WHERE id = ?').get(c.job_id);
  const rq = await requirements(job.profile_id);
  const rows = await db.prepare('SELECT competency_id, AVG(score) a, COUNT(*) n FROM rh_cand_scores WHERE candidate_id = ? GROUP BY competency_id').all(c.id);
  const by = new Map(rows.map((r) => [Number(r.competency_id), r]));
  const m = L.matchScore(rq, new Map([...by.entries()].map(([k, v]) => [k, Number(v.a)])));
  res.json({ candidate: await candView(req, c), grid: rq.map((r) => ({ ...r, score: by.has(r.competencyId) ? L.r2(Number(by.get(r.competencyId).a)) : null, evaluators: by.has(r.competencyId) ? Number(by.get(r.competencyId).n) : 0, gap: by.has(r.competencyId) ? L.r2(r.required - Number(by.get(r.competencyId).a)) : null })), match: m.score });
});
router.post('/candidates/:id/scores', R, async (req, res) => {
  const c = await C.fromOrg(req, 'hr_candidates', req.params.id, 'Candidat introuvable.'); const b = req.body || {};
  const job = await db.prepare('SELECT * FROM hr_jobs WHERE id = ?').get(c.job_id);
  const rq = await requirements(job.profile_id);
  const comp = await C.fromOrg(req, 'rh_competencies', b.competencyId, 'Compétence inconnue.');
  if (!rq.some((r) => r.competencyId === Number(comp.id))) throw new HttpError(400, "Cette compétence n'est pas requise par la fiche de poste de l'offre.");
  const score = C.level(b.score, 'Note invalide (1 à 5).');
  let interview = null; if (b.interviewId) { interview = await C.fromOrg(req, 'rh_interviews', b.interviewId, 'Entretien inconnu.'); if (Number(interview.candidate_id) !== Number(c.id)) throw new HttpError(400, 'Cet entretien concerne un autre candidat.'); }
  // une seule note par évaluateur, compétence et entretien : la nouvelle remplace l'ancienne
  await db.prepare('DELETE FROM rh_cand_scores WHERE candidate_id = ? AND competency_id = ? AND evaluator_id = ? AND interview_id IS NOT DISTINCT FROM ?::bigint').run(c.id, comp.id, req.user.id, interview ? interview.id : null);
  await db.prepare('INSERT INTO rh_cand_scores (org_id, candidate_id, interview_id, competency_id, evaluator_id, score, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, c.id, interview ? interview.id : null, comp.id, req.user.id, score, A.text(b.comment, 500), nowISO());
  await audit(req, 'candidate_score', c.id, 'create', null, { competencyId: Number(comp.id), score });
  res.status(201).json({ ok: true, match: L.matchScore(rq, await scoreMap(c.id)).score });
});
// Entretiens structurés : guide de questions par compétence requise (méthode STAR), notes liées à l'entretien.
router.get('/candidates/:id/interviews', R, async (req, res) => {
  const c = await C.fromOrg(req, 'hr_candidates', req.params.id, 'Candidat introuvable.');
  const rows = await db.prepare('SELECT * FROM rh_interviews WHERE candidate_id = ? ORDER BY id').all(c.id);
  res.json({ items: rows.map((i) => ({ id: Number(i.id), kind: i.kind, scheduledAt: i.scheduled_at, interviewerId: i.interviewer_id == null ? null : Number(i.interviewer_id), status: i.status, summary: i.summary })) });
});
router.post('/candidates/:id/interviews', R, async (req, res) => {
  const c = await C.fromOrg(req, 'hr_candidates', req.params.id, 'Candidat introuvable.'); const b = req.body || {};
  const id = Number((await db.prepare('INSERT INTO rh_interviews (org_id, candidate_id, kind, scheduled_at, interviewer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, c.id, A.oneOf(b.kind, ['phone', 'structured', 'technical', 'final'], 'structured', 'Type d\'entretien inconnu.'), A.date(b.scheduledAt), await A.memberOf(req, b.interviewerId) || req.user.id, nowISO())).lastInsertRowid);
  await audit(req, 'interview', id, 'create', null, { candidateId: Number(c.id) });
  res.status(201).json({ id });
});
router.put('/interviews/:id', R, async (req, res) => {
  const i = await C.fromOrg(req, 'rh_interviews', req.params.id, 'Entretien introuvable.'); const b = req.body || {};
  await db.prepare('UPDATE rh_interviews SET status = ?, summary = ?, scheduled_at = ? WHERE id = ?').run(b.status === undefined ? i.status : A.oneOf(b.status, ['planned', 'done', 'cancelled'], undefined, 'Statut inconnu.'), b.summary === undefined ? i.summary : A.text(b.summary, 2000), b.scheduledAt === undefined ? i.scheduled_at : A.date(b.scheduledAt), i.id);
  await audit(req, 'interview', i.id, 'update', { status: i.status }, { status: b.status });
  res.json({ ok: true });
});
router.get('/interviews/:id/guide', R, async (req, res) => {
  const i = await C.fromOrg(req, 'rh_interviews', req.params.id, 'Entretien introuvable.');
  const c = await db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(i.candidate_id);
  const job = await db.prepare('SELECT * FROM hr_jobs WHERE id = ?').get(c.job_id);
  res.json({ questions: (await requirements(job.profile_id)).map((r) => ({ competencyId: r.competencyId, competency: r.name, required: r.required, question: 'star', anchors: { 1: 'novice', 3: 'autonomous', 5: 'expert' } })) });
});

/** Candidat → employé : crée la fiche, le profil RH (emploi, service, responsable) et reprend les notes d'évaluation comme compétences détenues. */
router.post('/candidates/:id/hire', R, async (req, res) => {
  const c = await C.fromOrg(req, 'hr_candidates', req.params.id, 'Candidat introuvable.'); const b = req.body || {};
  if (c.stage === 'hired') throw new HttpError(409, 'Ce candidat est déjà embauché.');
  if (c.stage === 'rejected') throw new HttpError(400, 'Ce candidat a été écarté : replacez-le dans le processus avant de l’embaucher.');
  const job = await db.prepare('SELECT * FROM hr_jobs WHERE id = ?').get(c.job_id);
  const hiredAt = A.date(b.hiredAt) || C.today();
  const canPay = await has(req, 'remun');
  const salary = canPay && b.salary ? A.amount(b.salary) : null;
  const dep = b.departmentId !== undefined ? await C.optRef(req, 'rh_departments', b.departmentId, 'Service inconnu.') : job.department_id;
  const mgr = await C.optRef(req, 'employees', b.managerId, 'Responsable inconnu.');
  const sm = await scoreMap(c.id);
  const empId = await db.transaction(async () => {
    const id = Number((await db.prepare('INSERT INTO employees (org_id, branch_id, name, job, phone, hired_at, salary, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)').run(req.org.id, c.name, job.title, c.phone, hiredAt, salary, nowISO())).lastInsertRowid);
    await db.prepare('INSERT INTO rh_emp_profile (org_id, employee_id, department_id, job_profile_id, manager_id, gender, level, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(req.org.id, id, dep, job.profile_id, mgr, A.oneOf(b.gender, ['', 'F', 'M'], '', 'Genre : F, M ou vide.'), nowISO());
    for (const [cid, avg] of sm) await db.prepare('INSERT INTO rh_emp_skills (org_id, employee_id, competency_id, level, source, assessed_at, assessed_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, cid, Math.max(1, Math.min(5, Math.round(avg))), 'recruitment', nowISO(), req.user.id);
    await db.prepare("UPDATE hr_candidates SET stage = 'hired', stage_at = ?, hired_employee_id = ?, hired_at = ? WHERE id = ?").run(nowISO(), id, hiredAt, c.id);
    if (b.closeJob) await db.prepare("UPDATE hr_jobs SET status = 'closed', closed_at = ? WHERE id = ?").run(hiredAt, job.id);
    return id;
  })();
  await audit(req, 'candidate', c.id, 'hire', { stage: c.stage }, { stage: 'hired', employeeId: empId });
  res.status(201).json({ employeeId: empId, skillsImported: sm.size });
});
router.get('/stats', R, async (req, res) => {
  const jobs = await db.prepare('SELECT * FROM hr_jobs WHERE org_id = ?').all(req.org.id);
  const cands = await db.prepare('SELECT * FROM hr_candidates WHERE org_id = ?').all(req.org.id);
  res.json(await recruitStats(req, jobs, cands));
});
/** Statistiques de recrutement (aussi utilisées par les KPI) : délai moyen d'embauche, coût par recrutement, entonnoir. */
async function recruitStats(req, jobs, cands) {
  const hired = cands.filter((c) => c.stage === 'hired' && c.hired_at);
  const jm = new Map(jobs.map((j) => [Number(j.id), j]));
  const delays = hired.map((c) => { const j = jm.get(Number(c.job_id)); const o = j && (j.opened_at || String(j.created_at).slice(0, 10)); return o ? daysBetween(o, c.hired_at) : null; }).filter((d) => d !== null && d >= 0);
  const costJobs = [...new Set(hired.map((c) => Number(c.job_id)))].map((id) => jm.get(id)).filter(Boolean);
  const totalCost = costJobs.reduce((s, j) => s + Number(j.recruit_cost || 0), 0);
  return { openJobs: jobs.filter((j) => j.status === 'open').length, candidates: cands.length, hires: hired.length, avgDaysToHire: delays.length ? L.r1(L.avg(delays)) : null, totalRecruitCost: totalCost, costPerHire: hired.length ? Math.round(totalCost / hired.length) : null,
    funnel: STAGES.map((s) => ({ stage: s, count: cands.filter((c) => c.stage === s).length })) };
}

module.exports = router;
module.exports.recruitStats = recruitStats;
