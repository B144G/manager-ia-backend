'use strict';
// RH Talents · évaluation 360° : campagnes, évaluateurs (soi, manager, pairs, subordonnés, clients), questionnaires par compétences,
// anonymisation (seuil minimum de répondants), radar, écarts perception de soi / autres, plan de progrès.
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const T = need('talent');
const STATES = ['draft', 'open', 'closed', 'released'];

const camp = (req, id) => C.fromOrg(req, 'rh_360_campaigns', id, 'Campagne introuvable.');
async function compsOf(campId) {
  return (await db.prepare('SELECT c.id, c.name, c.category FROM rh_360_comps k JOIN rh_competencies c ON c.id = k.competency_id WHERE k.campaign_id = ? ORDER BY c.name').all(campId)).map((c) => ({ id: Number(c.id), name: c.name, category: c.category }));
}

router.get('/360/campaigns', T, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM rh_360_campaigns WHERE org_id = ? ORDER BY id DESC').all(req.org.id);
  const out = [];
  for (const c of rows) {
    const st = await db.prepare('SELECT COUNT(DISTINCT s.id) subjects, COUNT(r.id) raters, COALESCE(SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END), 0) done FROM rh_360_subjects s LEFT JOIN rh_360_raters r ON r.subject_id = s.id WHERE s.campaign_id = ?').get('done', c.id);
    out.push({ id: Number(c.id), title: c.title, period: c.period, status: c.status, minResponses: Number(c.min_responses), dueDate: c.due_date, subjects: Number(st.subjects), raters: Number(st.raters), done: Number(st.done), competencies: await compsOf(c.id) });
  }
  res.json({ items: out });
});
router.post('/360/campaigns', T, async (req, res) => {
  const b = req.body || {};
  const min = b.minResponses === undefined ? 3 : Number(b.minResponses);
  if (!Number.isInteger(min) || min < 2 || min > 20) throw new HttpError(400, 'Seuil minimum de répondants : entre 2 et 20 (en dessous, aucun anonymat).');
  const ids = Array.isArray(b.competencyIds) ? [...new Set(b.competencyIds.map(Number))] : [];
  if (!ids.length || ids.length > 25) throw new HttpError(400, 'Choisissez de 1 à 25 compétences pour le questionnaire.');
  for (const i of ids) await C.fromOrg(req, 'rh_competencies', i, 'Compétence inconnue.');
  const id = await db.transaction(async () => {
    const cid = Number((await db.prepare('INSERT INTO rh_360_campaigns (org_id, title, period, min_responses, due_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, A.text(b.title, 120, { required: true, msg: 'Indiquez le titre de la campagne.' }), A.text(b.period, 40), min, A.date(b.dueDate), req.user.id, nowISO())).lastInsertRowid);
    for (const i of ids) await db.prepare('INSERT INTO rh_360_comps (org_id, campaign_id, competency_id) VALUES (?, ?, ?)').run(req.org.id, cid, i);
    return cid;
  })();
  await audit(req, '360_campaign', id, 'create', null, { title: A.text(b.title, 80), min });
  res.status(201).json({ id });
});
router.put('/360/campaigns/:id/status', T, async (req, res) => {
  const c = await camp(req, req.params.id);
  const to = A.oneOf((req.body || {}).status, STATES, undefined, 'Statut inconnu.');
  if (STATES.indexOf(to) !== STATES.indexOf(c.status) + 1) throw new HttpError(400, `Passage impossible : ${c.status} → ${to} (étapes : brouillon, ouverte, clôturée, diffusée).`);
  if (to === 'open') {
    const n = await db.prepare('SELECT COUNT(*) c FROM rh_360_subjects WHERE campaign_id = ?').get(c.id);
    if (!Number(n.c)) throw new HttpError(400, 'Ajoutez au moins une personne évaluée avant d\'ouvrir la campagne.');
  }
  await db.prepare('UPDATE rh_360_campaigns SET status = ? WHERE id = ?').run(to, c.id);
  await audit(req, '360_campaign', c.id, 'status', { status: c.status }, { status: to });
  if (to === 'open') { // prévenir les évaluateurs
    const rs = await db.prepare('SELECT DISTINCT e.user_id FROM rh_360_raters r JOIN employees e ON e.id = r.rater_employee_id WHERE r.campaign_id = ? AND e.user_id IS NOT NULL').all(c.id);
    for (const r of rs) await C.W.push(req.org.id, r.user_id, '360', `Évaluation 360° « ${c.title} » : un questionnaire vous attend.`, '360:' + c.id);
  }
  if (to === 'released') {
    const subs = await db.prepare('SELECT e.user_id FROM rh_360_subjects s JOIN employees e ON e.id = s.employee_id WHERE s.campaign_id = ? AND e.user_id IS NOT NULL').all(c.id);
    for (const r of subs) await C.W.push(req.org.id, r.user_id, '360', `Vos résultats de l'évaluation 360° « ${c.title} » sont disponibles.`, '360:' + c.id);
  }
  res.json({ ok: true });
});
router.delete('/360/campaigns/:id', T, async (req, res) => {
  const c = await camp(req, req.params.id);
  if (c.status !== 'draft') throw new HttpError(409, 'Seule une campagne en brouillon peut être supprimée.');
  await db.prepare('DELETE FROM rh_360_campaigns WHERE id = ?').run(c.id);
  await audit(req, '360_campaign', c.id, 'delete', { title: c.title }, null);
  res.json({ ok: true });
});

// Évalués et évaluateurs. raters = [{ employeeId | label, relation }]. « soi » est ajouté automatiquement ; le responsable direct aussi s'il est connu.
router.post('/360/campaigns/:id/subjects', T, async (req, res) => {
  const c = await camp(req, req.params.id);
  if (c.status === 'closed' || c.status === 'released') throw new HttpError(409, 'Campagne terminée.');
  const b = req.body || {}; const e = await C.emp(req, b.employeeId);
  const list = Array.isArray(b.raters) ? b.raters : [];
  const norm = [];
  for (const x of list) {
    const rel = A.oneOf(x.relation, L.RELATIONS, undefined, 'Relation inconnue (soi, manager, pair, subordonné, client).');
    if (rel === 'self') continue;
    if (rel === 'client') { norm.push({ emp: null, label: A.text(x.label, 80, { required: true, msg: 'Indiquez le nom du client évaluateur.' }), rel }); continue; }
    const re = await C.emp(req, x.employeeId);
    if (Number(re.id) === Number(e.id)) throw new HttpError(400, 'Une personne ne peut pas être évaluateur « autre » de sa propre évaluation.');
    norm.push({ emp: Number(re.id), label: '', rel });
  }
  const p = await db.prepare('SELECT manager_id FROM rh_emp_profile WHERE employee_id = ?').get(e.id);
  if (p && p.manager_id && !norm.some((r) => r.rel === 'manager')) norm.push({ emp: Number(p.manager_id), label: '', rel: 'manager' });
  const keys = norm.map((r) => `${r.rel}:${r.emp ?? r.label}`);
  if (new Set(keys).size !== keys.length) throw new HttpError(400, 'Évaluateur en double.');
  const sid = await db.transaction(async () => {
    const ex = await db.prepare('SELECT id FROM rh_360_subjects WHERE campaign_id = ? AND employee_id = ?').get(c.id, e.id);
    if (ex) throw new HttpError(409, 'Cette personne est déjà évaluée dans la campagne.');
    const id = Number((await db.prepare('INSERT INTO rh_360_subjects (org_id, campaign_id, employee_id) VALUES (?, ?, ?)').run(req.org.id, c.id, e.id)).lastInsertRowid);
    for (const r of [{ emp: Number(e.id), label: '', rel: 'self' }, ...norm]) await db.prepare('INSERT INTO rh_360_raters (org_id, campaign_id, subject_id, rater_employee_id, rater_label, relation) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, c.id, id, r.emp, r.label, r.rel);
    return id;
  })();
  await audit(req, '360_subject', sid, 'create', null, { employeeId: Number(e.id), raters: norm.length + 1 });
  res.status(201).json({ id: sid });
});
router.get('/360/campaigns/:id/subjects', T, async (req, res) => {
  const c = await camp(req, req.params.id); const nm = await C.names(req);
  const subs = await db.prepare('SELECT * FROM rh_360_subjects WHERE campaign_id = ? ORDER BY id').all(c.id);
  const raters = await db.prepare('SELECT * FROM rh_360_raters WHERE campaign_id = ? ORDER BY id').all(c.id);
  res.json({ campaign: { id: Number(c.id), title: c.title, status: c.status, minResponses: Number(c.min_responses) }, items: subs.map((s) => ({ id: Number(s.id), employeeId: Number(s.employee_id), employee: nm.get(Number(s.employee_id)) || '',
    raters: raters.filter((r) => Number(r.subject_id) === Number(s.id)).map((r) => ({ id: Number(r.id), relation: r.relation, name: r.rater_employee_id ? nm.get(Number(r.rater_employee_id)) || '' : r.rater_label, status: r.status })) })) });
});

// Mes questionnaires à remplir (jamais les réponses des autres).
router.get('/360/todo', async (req, res) => {
  const me = await C.meEmp(req);
  if (!me) return res.json({ items: [] });
  const rows = await db.prepare("SELECT r.*, c.title, c.due_date, s.employee_id AS subject_emp FROM rh_360_raters r JOIN rh_360_campaigns c ON c.id = r.campaign_id JOIN rh_360_subjects s ON s.id = r.subject_id WHERE r.org_id = ? AND r.rater_employee_id = ? AND c.status = 'open' ORDER BY r.id").all(req.org.id, me.id);
  const nm = await C.names(req); const out = [];
  for (const r of rows) out.push({ raterId: Number(r.id), campaign: r.title, dueDate: r.due_date, relation: r.relation, subject: r.relation === 'self' ? nm.get(Number(r.subject_emp)) || '' : nm.get(Number(r.subject_emp)) || '', status: r.status, competencies: await compsOf(r.campaign_id) });
  res.json({ items: out });
});
router.post('/360/raters/:id/answers', async (req, res) => {
  const r = await C.fromOrg(req, 'rh_360_raters', req.params.id, 'Questionnaire introuvable.');
  const c = await db.prepare('SELECT * FROM rh_360_campaigns WHERE id = ?').get(r.campaign_id);
  const mine = r.rater_employee_id != null && (await C.isSelf(req, r.rater_employee_id));
  const onBehalf = r.rater_employee_id == null && (await has(req, 'talent')); // évaluateur externe (client) : saisie par la RH
  if (!mine && !onBehalf) throw new HttpError(403, "Ce questionnaire n'est pas le vôtre.");
  if (c.status !== 'open') throw new HttpError(409, "La campagne n'est pas ouverte.");
  const comps = await compsOf(c.id); const answers = (req.body || {}).answers;
  if (!Array.isArray(answers)) throw new HttpError(400, 'Réponses manquantes.');
  const byId = new Map(answers.map((a) => [Number(a.competencyId), a]));
  for (const k of comps) if (!byId.has(k.id)) throw new HttpError(400, `Répondez à toutes les compétences : « ${k.name} » manque.`);
  for (const a of answers) if (!comps.some((k) => k.id === Number(a.competencyId))) throw new HttpError(400, 'Compétence hors questionnaire.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM rh_360_answers WHERE rater_id = ?').run(r.id);
    for (const a of answers) await db.prepare('INSERT INTO rh_360_answers (org_id, rater_id, competency_id, score, comment) VALUES (?, ?, ?, ?, ?)').run(req.org.id, r.id, Number(a.competencyId), C.level(a.score, 'Note invalide (1 à 5).'), A.text(a.comment, 500));
    await db.prepare("UPDATE rh_360_raters SET status = 'done', answered_at = ? WHERE id = ?").run(nowISO(), r.id);
  })();
  await audit(req, '360_answers', r.id, 'create', null, { count: answers.length }); // le journal ne garde ni notes ni relation : seulement le fait de répondre
  res.json({ ok: true });
});

/** Résultats d'un évalué, anonymisés. */
async function resultsOf(req, c, subject) {
  const comps = await compsOf(c.id);
  const rows = (await db.prepare('SELECT r.id AS rid, r.relation, a.competency_id, a.score, a.comment FROM rh_360_raters r JOIN rh_360_answers a ON a.rater_id = r.id WHERE r.subject_id = ? AND r.status = ?').all(subject.id, 'done'))
    .map((x) => ({ raterId: Number(x.rid), relation: x.relation, competencyId: Number(x.competency_id), score: Number(x.score), comment: x.comment }));
  const agg = L.aggregate360(rows, comps.map((k) => k.id), Number(c.min_responses));
  const nm = new Map(comps.map((k) => [k.id, k.name]));
  const competencies = agg.competencies.map((k) => ({ ...k, name: nm.get(k.competencyId) }));
  const gaps = competencies.filter((k) => k.gap !== null).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const totals = await db.prepare('SELECT relation, COUNT(*) n, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) d FROM rh_360_raters WHERE subject_id = ? GROUP BY relation').all('done', subject.id);
  return { campaign: { id: Number(c.id), title: c.title, status: c.status, minResponses: Number(c.min_responses) }, subjectId: Number(subject.id), employeeId: Number(subject.employee_id), ...agg, competencies, radar: competencies.map((k) => ({ name: k.name, self: k.self, others: k.others, manager: k.manager })),
    blindSpots: gaps.filter((k) => k.gap >= 0.5).map((k) => ({ competencyId: k.competencyId, name: k.name, gap: k.gap })), hiddenStrengths: gaps.filter((k) => k.gap <= -0.5).map((k) => ({ competencyId: k.competencyId, name: k.name, gap: k.gap })),
    participation: totals.map((t) => ({ relation: t.relation, invited: Number(t.n), answered: Number(t.d || 0) })) };
}
router.get('/360/campaigns/:id/results/:subjectId', async (req, res) => {
  const c = await camp(req, req.params.id);
  const s = C.must(await db.prepare('SELECT * FROM rh_360_subjects WHERE id = ? AND campaign_id = ?').get(A.id(req.params.subjectId), c.id), 'Évalué introuvable.');
  const priv = await has(req, 'talent'); const self = await C.isSelf(req, s.employee_id);
  if (!priv && !self) throw new HttpError(403, 'Ces résultats sont confidentiels.');
  if (priv ? c.status === 'draft' || c.status === 'open' : c.status !== 'released') throw new HttpError(409, priv ? "Les résultats sont disponibles à la clôture de la campagne." : "Vos résultats ne sont pas encore diffusés.");
  await audit(req, '360_results', s.id, 'read', null, { by: priv ? 'rh' : 'self' });
  res.json(await resultsOf(req, c, s));
});
router.get('/360/mine', async (req, res) => {
  const me = await C.meEmp(req);
  if (!me) return res.json({ items: [] });
  const rows = await db.prepare("SELECT s.id sid, c.* FROM rh_360_subjects s JOIN rh_360_campaigns c ON c.id = s.campaign_id WHERE s.org_id = ? AND s.employee_id = ? AND c.status = 'released' ORDER BY c.id DESC").all(req.org.id, me.id);
  const out = [];
  for (const r of rows) { await audit(req, '360_results', r.sid, 'read', null, { by: 'self' }); out.push(await resultsOf(req, r, { id: r.sid, employee_id: me.id })); }
  res.json({ items: out });
});
/** Plan de progrès : actions créées pour l'évalué à partir des écarts (rattachées au sujet de l'évaluation). */
router.post('/360/subjects/:id/plan', T, async (req, res) => {
  const s = C.must(await db.prepare('SELECT * FROM rh_360_subjects WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id), 'Évalué introuvable.');
  const list = (req.body || {}).actions;
  if (!Array.isArray(list) || !list.length || list.length > 10) throw new HttpError(400, 'Indiquez de 1 à 10 actions.');
  const ids = [];
  for (const a of list) ids.push(Number((await db.prepare("INSERT INTO rh_actions (org_id, kind, ref_id, title, employee_id, competency_id, due_date, created_by, created_at) VALUES (?, 'progress', ?, ?, ?, ?, ?, ?, ?)").run(req.org.id, s.id, A.text(a.title, 200, { required: true, msg: "Indiquez l'action." }), s.employee_id, await C.optRef(req, 'rh_competencies', a.competencyId, 'Compétence inconnue.'), A.date(a.dueDate), req.user.id, nowISO())).lastInsertRowid));
  await audit(req, '360_plan', s.id, 'create', null, { actions: ids.length });
  res.status(201).json({ ids });
});

module.exports = router;
