'use strict';
// RH Talents · formation et développement des compétences : catalogue, plan annuel avec budget, demandes, sessions, présence,
// évaluation à chaud / à froid, lien avec les écarts de compétences, certificats (reportés dans les formations existantes hr_trainings).
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, W, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const T = need('talent');
const year = (v) => (/^\d{4}$/.test(String(v || '')) ? Number(v) : Number(C.today().slice(0, 4)));

C.simple(router, { path: '/training/courses', table: 'rh_courses', entity: 'course', read: ['talent', 'remun'], write: ['talent'], order: 'title',
  fields: [{ k: 'title', t: 'text', max: 120, req: true, msg: 'Indiquez le titre de la formation.' }, { k: 'category', t: 'text', max: 60 }, { k: 'provider', t: 'text', max: 100 }, { k: 'hours', t: 'int', min: 0, max: 2000, def: 0 }, { k: 'unitCost', t: 'int', min: 0, max: 1e10, def: 0 }, { k: 'description', t: 'text', max: 1000 }],
  decorate: async (req, rows) => {
    const cc = await db.prepare('SELECT cc.*, c.name FROM rh_course_competencies cc JOIN rh_competencies c ON c.id = cc.competency_id WHERE cc.org_id = ?').all(req.org.id);
    return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), competencies: cc.filter((x) => Number(x.course_id) === Number(r.id)).map((x) => ({ competencyId: Number(x.competency_id), name: x.name, targetLevel: Number(x.target_level) })) } }));
  } });
router.put('/training/courses/:id/competencies', T, async (req, res) => {
  const c = await C.fromOrg(req, 'rh_courses', req.params.id, 'Formation introuvable.');
  const list = (req.body || {}).competencies;
  if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'Liste de compétences invalide.');
  const rows = []; for (const x of list) rows.push([Number((await C.fromOrg(req, 'rh_competencies', x.competencyId, 'Compétence inconnue.')).id), C.level(x.targetLevel, 'Niveau visé invalide (1 à 5).')]);
  await db.transaction(async () => {
    await db.prepare('DELETE FROM rh_course_competencies WHERE course_id = ?').run(c.id);
    for (const [k, lv] of rows) await db.prepare('INSERT INTO rh_course_competencies (org_id, course_id, competency_id, target_level) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(req.org.id, c.id, k, lv);
  })();
  await audit(req, 'course', c.id, 'competencies', null, { count: rows.length });
  res.json({ ok: true });
});

// ---------- Budget et plan annuel ----------
async function budgetOf(req, y) {
  const b = await db.prepare('SELECT amount FROM rh_train_budgets WHERE org_id = ? AND year = ?').get(req.org.id, y);
  const planned = Number((await db.prepare("SELECT COALESCE(SUM(est_cost), 0) s FROM rh_train_requests WHERE org_id = ? AND year = ? AND status IN ('approved','planned')").get(req.org.id, y)).s);
  const done = Number((await db.prepare("SELECT COALESCE(SUM(est_cost), 0) s FROM rh_train_requests WHERE org_id = ? AND year = ? AND status = 'done'").get(req.org.id, y)).s);
  const sess = Number((await db.prepare("SELECT COALESCE(SUM(cost), 0) s FROM rh_train_sessions WHERE org_id = ? AND status != 'cancelled' AND start_date >= ? AND start_date <= ?").get(req.org.id, `${y}-01-01`, `${y}-12-31`)).s);
  const amount = b ? Number(b.amount) : 0;
  return { year: y, amount, planned, done, sessionsCost: sess, committed: planned + done, remaining: amount - planned - done, usedPct: amount ? L.r1(100 * (planned + done) / amount) : null };
}
router.get('/training/budget', need('talent', 'remun'), async (req, res) => res.json(await budgetOf(req, year(req.query.year))));
router.put('/training/budget', need('talent', 'remun'), async (req, res) => {
  const y = year((req.body || {}).year); const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e13) throw new HttpError(400, 'Budget invalide.');
  await db.prepare('INSERT INTO rh_train_budgets (org_id, year, amount) VALUES (?, ?, ?) ON CONFLICT (org_id, year) DO UPDATE SET amount = EXCLUDED.amount').run(req.org.id, y, Math.round(amount));
  await audit(req, 'train_budget', y, 'set', null, { year: y, amount });
  res.json({ ok: true });
});

const reqView = (r, nm, cn) => ({ id: Number(r.id), employeeId: Number(r.employee_id), employee: nm.get(Number(r.employee_id)) || '', courseId: Number(r.course_id), course: cn.get(Number(r.course_id)) || '', year: Number(r.year), reason: r.reason, estCost: Number(r.est_cost), status: r.status });
router.get('/training/requests', async (req, res) => {
  const y = year(req.query.year); const priv = await has(req, 'talent');
  let rows = await db.prepare('SELECT * FROM rh_train_requests WHERE org_id = ? AND year = ? ORDER BY id DESC').all(req.org.id, y);
  if (!priv) { const me = await C.meEmp(req); const rep = new Set(await C.reports(req)); rows = rows.filter((r) => (me && Number(r.employee_id) === Number(me.id)) || rep.has(Number(r.employee_id))); }
  const nm = await C.names(req); const cn = new Map((await db.prepare('SELECT id, title FROM rh_courses WHERE org_id = ?').all(req.org.id)).map((c) => [Number(c.id), c.title]));
  res.json({ items: rows.map((r) => reqView(r, nm, cn)) });
});
router.post('/training/requests', async (req, res) => {
  const b = req.body || {}; const e = await C.emp(req, b.employeeId);
  if (!((await has(req, 'talent')) || (await C.isSelf(req, e.id)) || (await C.isManagerOf(req, e.id)))) throw new HttpError(403, 'Accès non autorisé.');
  const course = await C.fromOrg(req, 'rh_courses', b.courseId, 'Formation introuvable.');
  const y = year(b.year);
  if (await db.prepare("SELECT 1 FROM rh_train_requests WHERE employee_id = ? AND course_id = ? AND year = ? AND status != 'refused'").get(e.id, course.id, y)) throw new HttpError(409, 'Une demande existe déjà pour cette personne et cette formation.');
  const id = Number((await db.prepare('INSERT INTO rh_train_requests (org_id, employee_id, course_id, year, reason, est_cost, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, e.id, course.id, y, A.text(b.reason, 300), Number(course.unit_cost), req.user.id, nowISO())).lastInsertRowid);
  await audit(req, 'train_request', id, 'create', null, { employeeId: Number(e.id), courseId: Number(course.id) });
  await W.pushRole(req.org.id, 'owner', 'training', `Nouvelle demande de formation : ${e.name} — ${course.title}`, 'train:' + id);
  res.status(201).json({ id });
});
router.put('/training/requests/:id/decision', T, async (req, res) => {
  const r = await C.fromOrg(req, 'rh_train_requests', req.params.id, 'Demande introuvable.');
  if (r.status !== 'requested') throw new HttpError(400, 'Cette demande a déjà été traitée.');
  const d = A.oneOf((req.body || {}).decision, ['approved', 'refused'], undefined, 'Décision inconnue.');
  await db.prepare('UPDATE rh_train_requests SET status = ?, decided_by = ? WHERE id = ?').run(d, req.user.id, r.id);
  await audit(req, 'train_request', r.id, 'decision', { status: r.status }, { status: d });
  const b = await budgetOf(req, Number(r.year));
  const e = await db.prepare('SELECT user_id, name FROM employees WHERE id = ?').get(r.employee_id);
  if (e && e.user_id) await C.W.push(req.org.id, e.user_id, 'training', `Votre demande de formation est ${d === 'approved' ? 'acceptée' : 'refusée'}.`, 'train:' + r.id);
  res.json({ ok: true, overBudget: d === 'approved' && b.amount > 0 && b.remaining < 0, budget: b });
});

// ---------- Sessions, présence, évaluations ----------
const sessView = (s, cn, att) => ({ id: Number(s.id), courseId: Number(s.course_id), course: cn.get(Number(s.course_id)) || '', startDate: s.start_date, endDate: s.end_date, place: s.place, trainer: s.trainer, cost: Number(s.cost), capacity: Number(s.capacity), status: s.status,
  attendees: att.filter((a) => Number(a.session_id) === Number(s.id)).length, present: att.filter((a) => Number(a.session_id) === Number(s.id) && a.presence === 'present').length });
router.get('/training/sessions', T, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM rh_train_sessions WHERE org_id = ? ORDER BY start_date DESC, id DESC LIMIT 300').all(req.org.id);
  const att = await db.prepare('SELECT session_id, presence FROM rh_train_attendees WHERE org_id = ?').all(req.org.id);
  const cn = new Map((await db.prepare('SELECT id, title FROM rh_courses WHERE org_id = ?').all(req.org.id)).map((c) => [Number(c.id), c.title]));
  res.json({ items: rows.map((s) => sessView(s, cn, att)) });
});
router.post('/training/sessions', T, async (req, res) => {
  const b = req.body || {}; const c = await C.fromOrg(req, 'rh_courses', b.courseId, 'Formation introuvable.');
  const start = A.date(b.startDate); if (!start) throw new HttpError(400, 'Indiquez la date de début.');
  const end = A.date(b.endDate) || start; if (end < start) throw new HttpError(400, 'La fin est avant le début.');
  const cap = b.capacity === undefined ? 0 : Number(b.capacity);
  if (!Number.isInteger(cap) || cap < 0 || cap > 10000) throw new HttpError(400, 'Capacité invalide.');
  const id = Number((await db.prepare('INSERT INTO rh_train_sessions (org_id, course_id, start_date, end_date, place, trainer, cost, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, c.id, start, end, A.text(b.place, 100), A.text(b.trainer, 100), b.cost ? A.amount(b.cost) : Number(c.unit_cost), cap, nowISO())).lastInsertRowid);
  await audit(req, 'train_session', id, 'create', null, { courseId: Number(c.id), start });
  res.status(201).json({ id });
});
const session = (req, id) => C.fromOrg(req, 'rh_train_sessions', id, 'Session introuvable.');
router.post('/training/sessions/:id/attendees', T, async (req, res) => {
  const s = await session(req, req.params.id);
  if (s.status !== 'planned') throw new HttpError(409, 'Cette session est terminée ou annulée.');
  const ids = (req.body || {}).employeeIds;
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Indiquez les participants.');
  const have = Number((await db.prepare('SELECT COUNT(*) c FROM rh_train_attendees WHERE session_id = ?').get(s.id)).c);
  const add = []; for (const i of ids) { const e = await C.emp(req, i); if (!(await db.prepare('SELECT 1 FROM rh_train_attendees WHERE session_id = ? AND employee_id = ?').get(s.id, e.id))) add.push(Number(e.id)); }
  if (Number(s.capacity) > 0 && have + add.length > Number(s.capacity)) throw new HttpError(400, `Capacité dépassée : ${Number(s.capacity)} place(s), ${have} déjà inscrit(s).`);
  for (const e of add) {
    await db.prepare('INSERT INTO rh_train_attendees (org_id, session_id, employee_id) VALUES (?, ?, ?)').run(req.org.id, s.id, e);
    await db.prepare("UPDATE rh_train_requests SET status = 'planned' WHERE employee_id = ? AND course_id = ? AND status = 'approved'").run(e, s.course_id);
  }
  await audit(req, 'train_session', s.id, 'attendees', null, { added: add.length });
  res.status(201).json({ added: add.length });
});
router.get('/training/sessions/:id', T, async (req, res) => {
  const s = await session(req, req.params.id); const nm = await C.names(req);
  const att = await db.prepare('SELECT * FROM rh_train_attendees WHERE session_id = ? ORDER BY employee_id').all(s.id);
  const c = await db.prepare('SELECT * FROM rh_courses WHERE id = ?').get(s.course_id);
  res.json({ session: sessView(s, new Map([[Number(c.id), c.title]]), att), attendees: att.map((a) => ({ employeeId: Number(a.employee_id), employee: nm.get(Number(a.employee_id)) || '', presence: a.presence, hot: a.hot_score == null ? null : Number(a.hot_score), cold: a.cold_score == null ? null : Number(a.cold_score), certNo: a.cert_no, certExpires: a.cert_expires })) });
});
router.put('/training/sessions/:id/attendance', T, async (req, res) => {
  const s = await session(req, req.params.id); const b = req.body || {};
  const a = C.must(await db.prepare('SELECT * FROM rh_train_attendees WHERE session_id = ? AND employee_id = ?').get(s.id, A.id(b.employeeId)), 'Participant introuvable.');
  const pr = A.oneOf(b.presence, ['registered', 'present', 'absent'], undefined, 'Présence inconnue.');
  await db.prepare('UPDATE rh_train_attendees SET presence = ? WHERE session_id = ? AND employee_id = ?').run(pr, s.id, a.employee_id);
  await audit(req, 'train_attendance', s.id, 'update', { presence: a.presence }, { employeeId: Number(a.employee_id), presence: pr });
  res.json({ ok: true });
});
/** Évaluation à chaud (fin de session, par le participant lui-même ou la RH) et à froid (quelques semaines après, par la RH ou le responsable). */
router.put('/training/sessions/:id/evaluation', async (req, res) => {
  const s = await session(req, req.params.id); const b = req.body || {};
  const kind = A.oneOf(b.kind, ['hot', 'cold'], undefined, 'Type d\'évaluation : à chaud ou à froid.');
  const a = C.must(await db.prepare('SELECT * FROM rh_train_attendees WHERE session_id = ? AND employee_id = ?').get(s.id, A.id(b.employeeId)), 'Participant introuvable.');
  if (a.presence !== 'present') throw new HttpError(400, "Seuls les participants présents sont évalués.");
  const priv = await has(req, 'talent');
  const ok = kind === 'hot' ? priv || (await C.isSelf(req, a.employee_id)) : priv || (await C.isManagerOf(req, a.employee_id));
  if (!ok) throw new HttpError(403, 'Accès non autorisé.');
  const sc = C.level(b.score, 'Note invalide (1 à 5).');
  if (kind === 'hot') await db.prepare('UPDATE rh_train_attendees SET hot_score = ? WHERE session_id = ? AND employee_id = ?').run(sc, s.id, a.employee_id);
  else await db.prepare('UPDATE rh_train_attendees SET cold_score = ?, cold_at = ? WHERE session_id = ? AND employee_id = ?').run(sc, nowISO(), s.id, a.employee_id);
  await audit(req, 'train_eval', s.id, kind, null, { employeeId: Number(a.employee_id), score: sc });
  res.json({ ok: true });
});
router.put('/training/sessions/:id/certificate', T, async (req, res) => {
  const s = await session(req, req.params.id); const b = req.body || {};
  const a = C.must(await db.prepare('SELECT * FROM rh_train_attendees WHERE session_id = ? AND employee_id = ?').get(s.id, A.id(b.employeeId)), 'Participant introuvable.');
  if (a.presence !== 'present') throw new HttpError(400, 'Un certificat se délivre à un participant présent.');
  const no = A.text(b.certNo, 60, { required: true, msg: 'Indiquez le numéro du certificat.' }); const exp = A.date(b.expires);
  await db.prepare('UPDATE rh_train_attendees SET cert_no = ?, cert_expires = ? WHERE session_id = ? AND employee_id = ?').run(no, exp, s.id, a.employee_id);
  if (s.status === 'done') await recordTraining(req, s, a.employee_id, no, exp);
  await audit(req, 'train_cert', s.id, 'issue', null, { employeeId: Number(a.employee_id) });
  res.json({ ok: true });
});
async function recordTraining(req, s, empId, certNo, exp) {
  const c = await db.prepare('SELECT * FROM rh_courses WHERE id = ?').get(s.course_id);
  const title = `${c.title}${certNo ? ` (certificat ${certNo})` : ''}`;
  if (await db.prepare('SELECT 1 FROM hr_trainings WHERE org_id = ? AND employee_id = ? AND title = ? AND done_at = ?').get(req.org.id, empId, title, s.end_date || s.start_date)) return;
  await db.prepare('INSERT INTO hr_trainings (org_id, employee_id, title, kind, done_at, expires_at, provider, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, empId, title, certNo ? 'certification' : 'training', s.end_date || s.start_date, exp || null, c.provider || s.trainer || '', 'Session RH Talents #' + s.id, nowISO());
}
/** Clôture : les présents montent au niveau visé de chaque compétence de la formation (jamais de baisse), la formation est inscrite à leur dossier, les demandes sont soldées. */
router.post('/training/sessions/:id/close', T, async (req, res) => {
  const s = await session(req, req.params.id);
  if (s.status !== 'planned') throw new HttpError(409, 'Session déjà clôturée ou annulée.');
  const att = await db.prepare("SELECT * FROM rh_train_attendees WHERE session_id = ? AND presence = 'present'").all(s.id);
  const cc = await db.prepare('SELECT * FROM rh_course_competencies WHERE course_id = ?').all(s.course_id);
  let updated = 0;
  await db.transaction(async () => {
    await db.prepare("UPDATE rh_train_sessions SET status = 'done' WHERE id = ?").run(s.id);
    for (const a of att) {
      for (const k of cc) {
        const cur = await db.prepare('SELECT level FROM rh_emp_skills WHERE employee_id = ? AND competency_id = ?').get(a.employee_id, k.competency_id);
        if (!cur || Number(cur.level) < Number(k.target_level)) {
          await db.prepare(`INSERT INTO rh_emp_skills (org_id, employee_id, competency_id, level, source, assessed_at, assessed_by) VALUES (?, ?, ?, ?, 'training', ?, ?)
            ON CONFLICT (employee_id, competency_id) DO UPDATE SET level = EXCLUDED.level, source = EXCLUDED.source, assessed_at = EXCLUDED.assessed_at, assessed_by = EXCLUDED.assessed_by`).run(req.org.id, a.employee_id, k.competency_id, Number(k.target_level), nowISO(), req.user.id);
          updated++;
        }
      }
      await recordTraining(req, s, a.employee_id, a.cert_no, a.cert_expires);
      await db.prepare("UPDATE rh_train_requests SET status = 'done' WHERE employee_id = ? AND course_id = ? AND status IN ('approved','planned')").run(a.employee_id, s.course_id);
    }
  })();
  await audit(req, 'train_session', s.id, 'close', { status: 'planned' }, { status: 'done', present: att.length, skillsUpdated: updated });
  res.json({ ok: true, present: att.length, skillsUpdated: updated });
});

/** Lien avec les écarts de compétences : formations qui comblent chaque écart (niveau visé ≥ niveau requis). */
router.get('/training/suggestions', T, async (req, res) => {
  const d = await require('./rh-gpec').gpecData(req);
  const courses = await db.prepare('SELECT c.*, cc.competency_id, cc.target_level FROM rh_course_competencies cc JOIN rh_courses c ON c.id = cc.course_id WHERE cc.org_id = ?').all(req.org.id);
  const items = [];
  for (const e of d.emps) {
    const p = d.profs.get(Number(e.id)); const jid = p && p.job_profile_id ? Number(p.job_profile_id) : null; if (!jid) continue;
    for (const g of L.gaps(d.reqBy.get(jid) || [], d.skills.get(Number(e.id)) || new Map())) {
      if (g.gap <= 0) continue;
      const cs = courses.filter((c) => Number(c.competency_id) === g.competencyId && Number(c.target_level) >= g.required).sort((a, b) => Number(a.unit_cost) - Number(b.unit_cost));
      items.push({ employeeId: Number(e.id), employee: e.name, competencyId: g.competencyId, required: g.required, held: g.held, gap: g.gap, courses: cs.map((c) => ({ id: Number(c.id), title: c.title, cost: Number(c.unit_cost), hours: Number(c.hours) })), covered: cs.length > 0 });
    }
  }
  const cost = items.reduce((s, i) => s + (i.courses[0] ? i.courses[0].cost : 0), 0);
  res.json({ items, summary: { gaps: items.length, covered: items.filter((i) => i.covered).length, uncovered: items.filter((i) => !i.covered).length, estimatedCost: cost } });
});
router.get('/training/summary', T, async (req, res) => {
  const y = year(req.query.year);
  const rows = await db.prepare("SELECT s.*, c.hours FROM rh_train_sessions s JOIN rh_courses c ON c.id = s.course_id WHERE s.org_id = ? AND s.status = 'done' AND s.start_date >= ? AND s.start_date <= ?").all(req.org.id, `${y}-01-01`, `${y}-12-31`);
  const ids = rows.map((r) => Number(r.id));
  const att = ids.length ? await db.prepare(`SELECT * FROM rh_train_attendees WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const present = att.filter((a) => a.presence === 'present');
  const hot = present.filter((a) => a.hot_score != null).map((a) => Number(a.hot_score)); const cold = present.filter((a) => a.cold_score != null).map((a) => Number(a.cold_score));
  const hours = present.reduce((s, a) => s + Number(rows.find((r) => Number(r.id) === Number(a.session_id)).hours), 0);
  const cost = rows.reduce((s, r) => s + Number(r.cost), 0);
  res.json({ year: y, sessions: rows.length, registered: att.length, present: present.length, attendanceRate: att.length ? L.r1(100 * present.length / att.length) : null, trainedPeople: new Set(present.map((a) => Number(a.employee_id))).size, hours, cost, costPerParticipant: present.length ? Math.round(cost / present.length) : null,
    hotAvg: hot.length ? L.r2(L.avg(hot)) : null, coldAvg: cold.length ? L.r2(L.avg(cold)) : null, budget: await budgetOf(req, y) });
});

module.exports = router;
module.exports.budgetOf = budgetOf;
