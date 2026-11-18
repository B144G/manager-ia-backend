'use strict';
// RH Talents · droits, services, profils, GPEC : référentiel emplois/compétences (niveaux 1–5), compétences par employé,
// matrice, écarts requis/détenus, besoins futurs contre ressources actuelles, plan d'actions.
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, W, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const READ = ['talent', 'recrut', 'remun']; const WRITE = ['talent'];

// ---------- Qui suis-je, rôles RH ----------
router.get('/me', async (req, res) => {
  const e = await C.meEmp(req);
  res.json({ roles: [...(await C.rolesOf(req))], isOwner: req.member.role === 'owner', employee: e ? { id: Number(e.id), name: e.name } : null, reports: await C.reports(req) });
});
router.get('/roles', need(), async (req, res) => {
  const rows = await db.prepare('SELECT r.user_id, r.role, u.name FROM rh_roles r LEFT JOIN users u ON u.id = r.user_id WHERE r.org_id = ? ORDER BY u.name, r.role').all(req.org.id);
  const members = await db.prepare('SELECT m.user_id, m.role, u.name FROM org_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name').all(req.org.id);
  res.json({ roles: C.ROLES, members: members.map((m) => ({ userId: Number(m.user_id), name: m.name, orgRole: m.role, rhRoles: rows.filter((r) => r.user_id === m.user_id).map((r) => r.role) })) });
});
router.put('/roles/:userId', async (req, res) => {
  if (req.member.role !== 'owner') throw new HttpError(403, "Seul le propriétaire de l'organisation désigne les rôles RH.");
  const uid = A.id(req.params.userId, 'Personne invalide.');
  const m = await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!m) throw new HttpError(404, 'Personne introuvable.');
  const roles = (req.body || {}).roles;
  if (!Array.isArray(roles) || roles.some((r) => !C.ROLES.includes(r))) throw new HttpError(400, 'Rôles RH inconnus.');
  const before = (await db.prepare('SELECT role FROM rh_roles WHERE org_id = ? AND user_id = ?').all(req.org.id, uid)).map((r) => r.role);
  await db.transaction(async () => {
    await db.prepare('DELETE FROM rh_roles WHERE org_id = ? AND user_id = ?').run(req.org.id, uid);
    for (const r of new Set(roles)) await db.prepare('INSERT INTO rh_roles (org_id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, uid, r, req.user.id, nowISO());
  })();
  await audit(req, 'role', uid, 'update', { roles: before }, { roles: [...new Set(roles)] });
  res.json({ ok: true });
});
router.get('/audit', need(), async (req, res) => {
  const rows = await db.prepare("SELECT a.id, a.user_id, u.name AS who, a.entity, a.entity_id, a.action, a.created_at FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = ? AND a.entity LIKE 'rh\\_%' ESCAPE '\\' ORDER BY a.id DESC LIMIT 300").all(req.org.id);
  res.json({ items: rows.map((r) => ({ id: Number(r.id), who: r.who, entity: r.entity, entityId: r.entity_id == null ? null : Number(r.entity_id), action: r.action, at: r.created_at })) });
});

// ---------- Services ----------
C.simple(router, { path: '/departments', table: 'rh_departments', entity: 'department', read: READ, write: WRITE, order: 'name',
  fields: [{ k: 'name', t: 'text', max: 80, req: true, msg: 'Indiquez le nom du service.' }, { k: 'budgetHeadcount', t: 'int', min: 0, max: 100000, def: 0 }],
  decorate: async (req, rows) => {
    const cnt = await db.prepare("SELECT p.department_id d, COUNT(*) n FROM rh_emp_profile p JOIN employees e ON e.id = p.employee_id WHERE p.org_id = ? AND e.status = 'active' GROUP BY p.department_id").all(req.org.id);
    const m = new Map(cnt.map((c) => [Number(c.d), Number(c.n)]));
    return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), headcount: m.get(Number(r.id)) || 0 } }));
  } });

// ---------- Fiches complémentaires des employés (profil RH) ----------
const profView = (p, e) => ({ employeeId: Number(e.id), name: e.name, job: e.job, status: e.status, hiredAt: e.hired_at, departmentId: p ? p.department_id && Number(p.department_id) : null, jobProfileId: p ? p.job_profile_id && Number(p.job_profile_id) : null,
  managerId: p ? p.manager_id && Number(p.manager_id) : null, gender: p ? p.gender : '', level: p ? Number(p.level) : 1, leftAt: p ? p.left_at : null, leftReason: p ? p.left_reason : '' });
router.get('/profiles', need(...READ), async (req, res) => {
  const emps = await require('./hr').employees(req);
  const ps = new Map((await db.prepare('SELECT * FROM rh_emp_profile WHERE org_id = ?').all(req.org.id)).map((p) => [Number(p.employee_id), p]));
  res.json({ items: emps.map((e) => profView(ps.get(Number(e.id)), e)) });
});
router.put('/profiles/:employeeId', need('talent'), async (req, res) => {
  const e = await C.emp(req, req.params.employeeId); const b = req.body || {};
  if (!A.visible(req, e)) throw new HttpError(404, 'Employé introuvable.');
  const cur = (await db.prepare('SELECT * FROM rh_emp_profile WHERE employee_id = ?').get(e.id)) || {};
  const pick = (k, col, fn) => (b[k] === undefined ? cur[col] ?? null : fn(b[k]));
  const dep = b.departmentId === undefined ? cur.department_id ?? null : await C.optRef(req, 'rh_departments', b.departmentId, 'Service inconnu.');
  const job = b.jobProfileId === undefined ? cur.job_profile_id ?? null : await C.optRef(req, 'rh_job_profiles', b.jobProfileId, 'Emploi inconnu.');
  let mgr = b.managerId === undefined ? cur.manager_id ?? null : await C.optRef(req, 'employees', b.managerId, 'Responsable inconnu.');
  if (mgr !== null && Number(mgr) === Number(e.id)) throw new HttpError(400, 'Une personne ne peut pas être son propre responsable.');
  const gender = pick('gender', 'gender', (v) => A.oneOf(v, ['', 'F', 'M'], '', 'Genre : F, M ou vide.')) ?? '';
  const lvl = pick('level', 'level', (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 20) throw new HttpError(400, 'Échelon invalide (1 à 20).'); return n; }) ?? 1;
  await db.prepare(`INSERT INTO rh_emp_profile (org_id, employee_id, department_id, job_profile_id, manager_id, gender, level, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (employee_id) DO UPDATE SET department_id = EXCLUDED.department_id, job_profile_id = EXCLUDED.job_profile_id, manager_id = EXCLUDED.manager_id, gender = EXCLUDED.gender, level = EXCLUDED.level, updated_at = EXCLUDED.updated_at`).run(req.org.id, e.id, dep, job, mgr, gender, lvl, nowISO());
  await audit(req, 'profile', e.id, 'update', { department: cur.department_id, job: cur.job_profile_id, manager: cur.manager_id }, { department: dep, job, manager: mgr });
  res.json({ ok: true });
});
router.post('/employees/:id/exit', need('rh'), async (req, res) => {
  const e = await C.emp(req, req.params.id); const b = req.body || {};
  const leftAt = A.date(b.leftAt) || C.today();
  await db.transaction(async () => {
    await db.prepare("UPDATE employees SET status = 'left' WHERE id = ?").run(e.id);
    await db.prepare(`INSERT INTO rh_emp_profile (org_id, employee_id, left_at, left_reason, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (employee_id) DO UPDATE SET left_at = EXCLUDED.left_at, left_reason = EXCLUDED.left_reason, updated_at = EXCLUDED.updated_at`).run(req.org.id, e.id, leftAt, A.text(b.reason, 200), nowISO());
  })();
  await audit(req, 'profile', e.id, 'exit', { status: e.status }, { status: 'left', leftAt });
  res.json({ ok: true });
});

// ---------- Référentiel : compétences et emplois ----------
C.simple(router, { path: '/competencies', table: 'rh_competencies', entity: 'competency', read: [...READ], write: WRITE, order: 'category, name',
  fields: [{ k: 'name', t: 'text', max: 80, req: true, msg: 'Indiquez le nom de la compétence.' }, { k: 'category', t: 'text', max: 60 }, { k: 'description', t: 'text', max: 400 }],
  validate: async (req, v, cur) => { const d = await db.prepare('SELECT id FROM rh_competencies WHERE org_id = ? AND name = ?').get(req.org.id, v.name); if (d && (!cur || Number(d.id) !== Number(cur.id))) throw new HttpError(409, 'Cette compétence existe déjà.'); } });
// Lecture des compétences ouverte aux autres rôles RH (rh couvre tout) ; les évaluateurs 360 lisent via leurs tâches.

const jobView = async (req, rows) => {
  const reqs = await db.prepare('SELECT jc.*, c.name AS cname FROM rh_job_competencies jc JOIN rh_competencies c ON c.id = jc.competency_id WHERE jc.org_id = ?').all(req.org.id);
  const holders = await db.prepare("SELECT p.job_profile_id j, COUNT(*) n FROM rh_emp_profile p JOIN employees e ON e.id = p.employee_id WHERE p.org_id = ? AND e.status = 'active' GROUP BY p.job_profile_id").all(req.org.id);
  const hm = new Map(holders.map((h) => [Number(h.j), Number(h.n)]));
  return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), holders: hm.get(Number(r.id)) || 0, competencies: reqs.filter((x) => Number(x.job_profile_id) === Number(r.id)).map((x) => ({ competencyId: Number(x.competency_id), name: x.cname, requiredLevel: Number(x.required_level), weight: Number(x.weight) })) } }));
};
C.simple(router, { path: '/job-profiles', table: 'rh_job_profiles', entity: 'job_profile', read: READ, write: WRITE, order: 'title', decorate: jobView,
  fields: [{ k: 'title', t: 'text', max: 100, req: true, msg: "Indiquez l'intitulé de l'emploi." }, { k: 'family', t: 'text', max: 60 }, { k: 'description', t: 'text', max: 2000 }, { k: 'departmentId', t: 'ref', ref: 'rh_departments', label: 'Service' }],
  validate: async (req, v, cur) => { const d = await db.prepare('SELECT id FROM rh_job_profiles WHERE org_id = ? AND title = ?').get(req.org.id, v.title); if (d && (!cur || Number(d.id) !== Number(cur.id))) throw new HttpError(409, 'Cet emploi existe déjà.'); } });
router.put('/job-profiles/:id/competencies', need(...WRITE), async (req, res) => {
  const jp = await C.fromOrg(req, 'rh_job_profiles', req.params.id, 'Emploi introuvable.');
  const list = (req.body || {}).competencies;
  if (!Array.isArray(list) || list.length > 60) throw new HttpError(400, 'Liste de compétences invalide.');
  const rows = [];
  for (const x of list) {
    const c = await C.fromOrg(req, 'rh_competencies', x.competencyId, 'Compétence inconnue.');
    const w = x.weight === undefined ? 1 : Number(x.weight);
    if (!Number.isInteger(w) || w < 1 || w > 5) throw new HttpError(400, 'Poids invalide (1 à 5).');
    rows.push([Number(c.id), C.level(x.requiredLevel, 'Niveau requis invalide (1 à 5).'), w]);
  }
  if (new Set(rows.map((r) => r[0])).size !== rows.length) throw new HttpError(400, 'Compétence en double.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM rh_job_competencies WHERE job_profile_id = ?').run(jp.id);
    for (const [c, lv, w] of rows) await db.prepare('INSERT INTO rh_job_competencies (org_id, job_profile_id, competency_id, required_level, weight) VALUES (?, ?, ?, ?, ?)').run(req.org.id, jp.id, c, lv, w);
  })();
  await audit(req, 'job_profile', jp.id, 'competencies', null, { count: rows.length });
  res.json({ ok: true });
});

// ---------- Compétences détenues ----------
async function canSeeSkills(req, empId) {
  return (await has(req, 'talent')) || (await C.isSelf(req, empId)) || (await C.isManagerOf(req, empId));
}
router.get('/skills', async (req, res) => {
  const empId = A.id(req.query.employeeId, 'Employé invalide.');
  await C.emp(req, empId);
  if (!(await canSeeSkills(req, empId))) throw new HttpError(403, 'Accès non autorisé.');
  const rows = await db.prepare('SELECT s.*, c.name FROM rh_emp_skills s JOIN rh_competencies c ON c.id = s.competency_id WHERE s.employee_id = ? AND s.org_id = ? ORDER BY c.name').all(empId, req.org.id);
  res.json({ items: rows.map((s) => ({ competencyId: Number(s.competency_id), name: s.name, level: Number(s.level), source: s.source, assessedAt: s.assessed_at })) });
});
router.put('/skills', async (req, res) => {
  const b = req.body || {}; const e = await C.emp(req, b.employeeId);
  if (!((await has(req, 'talent')) || (await C.isManagerOf(req, e.id)))) throw new HttpError(403, 'Seuls les responsables RH et le responsable direct évaluent les compétences.');
  const c = await C.fromOrg(req, 'rh_competencies', b.competencyId, 'Compétence inconnue.');
  const lv = C.level(b.level);
  await db.prepare(`INSERT INTO rh_emp_skills (org_id, employee_id, competency_id, level, source, assessed_at, assessed_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (employee_id, competency_id) DO UPDATE SET level = EXCLUDED.level, source = EXCLUDED.source, assessed_at = EXCLUDED.assessed_at, assessed_by = EXCLUDED.assessed_by`).run(req.org.id, e.id, c.id, lv, A.oneOf(b.source, ['manual', 'training', '360', 'recruitment'], 'manual', 'Source inconnue.'), nowISO(), req.user.id);
  await audit(req, 'skill', e.id, 'set', null, { competencyId: Number(c.id), level: lv });
  res.json({ ok: true });
});
router.delete('/skills', need(...WRITE), async (req, res) => {
  const e = await C.emp(req, req.query.employeeId);
  await db.prepare('DELETE FROM rh_emp_skills WHERE employee_id = ? AND competency_id = ? AND org_id = ?').run(e.id, A.id(req.query.competencyId), req.org.id);
  await audit(req, 'skill', e.id, 'delete', { competencyId: req.query.competencyId }, null);
  res.json({ ok: true });
});

// ---------- Calculs GPEC ----------
/** Données communes : employés actifs avec leur emploi, exigences, compétences détenues. */
async function gpecData(req) {
  const emps = (await require('./hr').employees(req)).filter((e) => e.status === 'active');
  const profs = new Map((await db.prepare('SELECT * FROM rh_emp_profile WHERE org_id = ?').all(req.org.id)).map((p) => [Number(p.employee_id), p]));
  const jobs = new Map((await db.prepare('SELECT * FROM rh_job_profiles WHERE org_id = ?').all(req.org.id)).map((j) => [Number(j.id), j]));
  const reqRows = await db.prepare('SELECT * FROM rh_job_competencies WHERE org_id = ?').all(req.org.id);
  const reqBy = new Map();
  for (const r of reqRows) { const a = reqBy.get(Number(r.job_profile_id)) || []; a.push({ competencyId: Number(r.competency_id), required: Number(r.required_level), weight: Number(r.weight) }); reqBy.set(Number(r.job_profile_id), a); }
  const comps = await db.prepare('SELECT * FROM rh_competencies WHERE org_id = ? ORDER BY category, name').all(req.org.id);
  const skills = new Map();
  for (const s of await db.prepare('SELECT * FROM rh_emp_skills WHERE org_id = ?').all(req.org.id)) { const m = skills.get(Number(s.employee_id)) || new Map(); m.set(Number(s.competency_id), Number(s.level)); skills.set(Number(s.employee_id), m); }
  return { emps, profs, jobs, reqBy, comps, skills };
}
router.get('/gpec/matrix', need('talent'), async (req, res) => {
  const d = await gpecData(req);
  const rows = d.emps.map((e) => {
    const p = d.profs.get(Number(e.id)); const jid = p && p.job_profile_id ? Number(p.job_profile_id) : null;
    const rq = new Map((d.reqBy.get(jid) || []).map((r) => [r.competencyId, r.required]));
    const held = d.skills.get(Number(e.id)) || new Map();
    return { employeeId: Number(e.id), name: e.name, job: jid ? d.jobs.get(jid)?.title || e.job : e.job, cells: d.comps.map((c) => { const lv = held.get(Number(c.id)) || 0; const rqd = rq.get(Number(c.id)) || 0; return { competencyId: Number(c.id), level: lv, required: rqd, gap: rqd ? rqd - lv : null }; }) };
  });
  await audit(req, 'gpec_matrix', null, 'read', null, null);
  res.json({ competencies: d.comps.map((c) => ({ id: Number(c.id), name: c.name, category: c.category })), rows });
});
router.get('/gpec/gaps', need('talent'), async (req, res) => {
  const d = await gpecData(req);
  const items = []; const byComp = new Map();
  for (const e of d.emps) {
    const p = d.profs.get(Number(e.id)); const jid = p && p.job_profile_id ? Number(p.job_profile_id) : null;
    if (!jid) continue;
    const g = L.gaps(d.reqBy.get(jid) || [], d.skills.get(Number(e.id)) || new Map());
    items.push({ employeeId: Number(e.id), name: e.name, job: d.jobs.get(jid)?.title || '', coverage: L.coverage(g.map((x) => ({ held: x.held, required: x.required, weight: x.weight }))), gaps: g.filter((x) => x.gap > 0).map((x) => ({ competencyId: x.competencyId, required: x.required, held: x.held, gap: x.gap, critical: x.gap >= 2 || x.status === 'missing' })) });
    for (const x of g) { const o = byComp.get(x.competencyId) || { competencyId: x.competencyId, employees: 0, below: 0, totalGap: 0 }; o.employees++; if (x.gap > 0) { o.below++; o.totalGap += x.gap; } byComp.set(x.competencyId, o); }
  }
  const nm = new Map(d.comps.map((c) => [Number(c.id), c.name]));
  const comps = [...byComp.values()].map((o) => ({ ...o, name: nm.get(o.competencyId), avgGap: o.below ? L.r2(o.totalGap / o.below) : 0 })).sort((a, b) => b.below - a.below || b.totalGap - a.totalGap);
  const covs = items.filter((i) => i.coverage !== null).map((i) => i.coverage);
  res.json({ items, byCompetency: comps, summary: { assessed: items.length, avgCoverage: covs.length ? L.r1(L.avg(covs)) : null, withGaps: items.filter((i) => i.gaps.length).length, criticalGaps: items.reduce((s, i) => s + i.gaps.filter((g) => g.critical).length, 0) } });
});
router.get('/gpec/needs', need('talent', 'remun'), async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : Number(C.today().slice(0, 4));
  const retire = Number(req.query.retireAge) || 60;
  const d = await gpecData(req);
  const needs = new Map((await db.prepare('SELECT * FROM rh_future_needs WHERE org_id = ? AND year = ?').all(req.org.id, year)).map((n) => [Number(n.job_profile_id), n]));
  const end = `${year}-12-31`;
  const items = [...d.jobs.values()].map((j) => {
    const holders = d.emps.filter((e) => { const p = d.profs.get(Number(e.id)); return p && Number(p.job_profile_id) === Number(j.id); });
    const retiring = holders.filter((e) => { const a = L.ageOf(e.birth_date, end); return a !== null && a >= retire; }).length;
    const need = needs.get(Number(j.id)); const needed = need ? Number(need.needed) : 0;
    const current = holders.length; const available = current - retiring;
    return { jobProfileId: Number(j.id), title: j.title, current, retiring, available, needed, shortfall: Math.max(needed - available, 0), surplus: Math.max(available - needed, 0), note: need ? need.note : '' };
  }).filter((i) => i.current || i.needed).sort((a, b) => b.shortfall - a.shortfall);
  res.json({ year, retireAge: retire, items, summary: { current: items.reduce((s, i) => s + i.current, 0), needed: items.reduce((s, i) => s + i.needed, 0), retiring: items.reduce((s, i) => s + i.retiring, 0), shortfall: items.reduce((s, i) => s + i.shortfall, 0) } });
});
router.put('/gpec/needs', need(...WRITE), async (req, res) => {
  const b = req.body || {}; const jp = await C.fromOrg(req, 'rh_job_profiles', b.jobProfileId, 'Emploi introuvable.');
  const year = Number(b.year); const needed = Number(b.needed);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'Année invalide.');
  if (!Number.isInteger(needed) || needed < 0 || needed > 100000) throw new HttpError(400, 'Effectif invalide.');
  await db.prepare(`INSERT INTO rh_future_needs (org_id, year, job_profile_id, needed, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (org_id, year, job_profile_id) DO UPDATE SET needed = EXCLUDED.needed, note = EXCLUDED.note`).run(req.org.id, year, jp.id, needed, A.text(b.note, 300));
  await audit(req, 'future_need', jp.id, 'set', null, { year, needed });
  res.json({ ok: true });
});

// ---------- Plan d'actions (GPEC, progrès 360°, PDI, rétention, engagement) ----------
const KINDS = ['gpec', 'progress', 'pdi', 'retention', 'engagement'];
const actView = (a, nm) => ({ id: Number(a.id), kind: a.kind, refId: a.ref_id == null ? null : Number(a.ref_id), title: a.title, description: a.description, employeeId: a.employee_id == null ? null : Number(a.employee_id), employee: a.employee_id == null ? '' : nm.get(Number(a.employee_id)) || '',
  competencyId: a.competency_id == null ? null : Number(a.competency_id), dueDate: a.due_date, status: a.status, cost: Number(a.cost), doneAt: a.done_at });
router.get('/actions', async (req, res) => {
  const privileged = await has(req, 'talent');
  const where = ['org_id = ?']; const args = [req.org.id];
  if (req.query.kind) { where.push('kind = ?'); args.push(A.oneOf(req.query.kind, KINDS, undefined, 'Type inconnu.')); }
  if (req.query.employeeId) { where.push('employee_id = ?'); args.push(A.id(req.query.employeeId)); }
  if (req.query.refId) { where.push('ref_id = ?'); args.push(A.id(req.query.refId)); }
  let rows = await db.prepare(`SELECT * FROM rh_actions WHERE ${where.join(' AND ')} ORDER BY CASE status WHEN 'done' THEN 1 ELSE 0 END, COALESCE(due_date, '9999') , id DESC LIMIT 500`).all(...args);
  if (!privileged) { // un membre ne voit que ses propres actions (ou celles qui lui sont confiées) ; un responsable, celles de ses collaborateurs directs
    const me = await C.meEmp(req); const rep = new Set(await C.reports(req));
    rows = rows.filter((a) => Number(a.owner_id) === Number(req.user.id) || (me && Number(a.employee_id) === Number(me.id)) || (a.employee_id != null && rep.has(Number(a.employee_id))));
  }
  const nm = await C.names(req);
  res.json({ items: rows.map((a) => actView(a, nm)) });
});
router.post('/actions', async (req, res) => {
  const b = req.body || {}; const kind = A.oneOf(b.kind, KINDS, undefined, 'Type d\'action inconnu.');
  const e = b.employeeId ? await C.emp(req, b.employeeId) : null;
  if (!((await has(req, 'talent')) || (e && (await C.isManagerOf(req, e.id))))) throw new HttpError(403, 'Accès non autorisé.');
  const id = Number((await db.prepare('INSERT INTO rh_actions (org_id, kind, ref_id, title, description, employee_id, competency_id, owner_id, due_date, cost, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, kind, b.refId ? A.id(b.refId) : null,
    A.text(b.title, 200, { required: true, msg: "Indiquez l'action." }), A.text(b.description, 1000), e ? e.id : null, await C.optRef(req, 'rh_competencies', b.competencyId, 'Compétence inconnue.'), await A.memberOf(req, b.ownerId), A.date(b.dueDate), b.cost ? A.amount(b.cost) : 0, req.user.id, nowISO())).lastInsertRowid);
  await audit(req, 'action', id, 'create', null, { kind, title: A.text(b.title, 80) });
  res.status(201).json({ id });
});
router.put('/actions/:id', async (req, res) => {
  const a = await C.fromOrg(req, 'rh_actions', req.params.id, 'Action introuvable.'); const b = req.body || {};
  const mine = Number(a.owner_id) === Number(req.user.id);
  const priv = (await has(req, 'talent')) || (a.employee_id != null && (await C.isManagerOf(req, a.employee_id)));
  if (!priv && !mine) throw new HttpError(403, 'Accès non autorisé.');
  const status = b.status === undefined ? a.status : A.oneOf(b.status, ['todo', 'doing', 'done', 'cancelled'], undefined, 'Statut inconnu.');
  const sets = { status, done_at: status === 'done' ? a.done_at || nowISO() : null };
  if (priv) { if (b.title !== undefined) sets.title = A.text(b.title, 200, { required: true }); if (b.dueDate !== undefined) sets.due_date = A.date(b.dueDate); if (b.description !== undefined) sets.description = A.text(b.description, 1000); }
  await db.prepare(`UPDATE rh_actions SET ${Object.keys(sets).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(sets), a.id);
  await audit(req, 'action', a.id, 'update', { status: a.status }, { status });
  res.json({ ok: true });
});
router.delete('/actions/:id', need(...WRITE), async (req, res) => {
  const a = await C.fromOrg(req, 'rh_actions', req.params.id, 'Action introuvable.');
  await db.prepare('DELETE FROM rh_actions WHERE id = ?').run(a.id);
  await audit(req, 'action', a.id, 'delete', { title: a.title }, null);
  res.json({ ok: true });
});

module.exports = router;
module.exports.gpecData = gpecData;
