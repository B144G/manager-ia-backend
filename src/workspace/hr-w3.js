'use strict';
// Ressources humaines · vague 3 : soldes de congés (acquisition mensuelle réglable, jours fériés du Cameroun modifiables, report), dossier du
// personnel (pièces chiffrées), contrats et échéances, pointage, recrutement, évaluations, formations et habilitations.
// Les règles légales (durée des congés, jours fériés, préavis) sont des REPÈRES de travail à faire valider : ils sont tous modifiables.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const F = require('./files-w3');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager'); const adm = A.need('admin');
const KEYS = ['leave_accrual', 'leave_carry_max', 'alert_contract_days'];
W.settingsRoutes(router, KEYS, 'admin', 'manager');
// Ces routes sont déclarées sur /hr/... pour les responsables (le module Ressources humaines leur est réservé).
const hrRouter = express.Router({ mergeParams: true });
hrRouter.use((req, res, next) => (req.path === '/my-balance' ? next('router') : mgr(req, res, next)));
// Un membre voit son propre solde : déclaré avant le filtre « responsables »
router.use(hrRouter);

// ---------- Jours fériés ----------
function easter(y) { // algorithme grégorien anonyme
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
/** Jours fériés du Cameroun donnés en EXEMPLE : fêtes fixes et fêtes mobiles chrétiennes. Les fêtes musulmanes dépendent de l'annonce officielle : à ajouter à la main. */
function cameroonHolidays(year) {
  const e = easter(year);
  return [
    [`${year}-01-01`, "Jour de l'An"], [`${year}-02-11`, 'Fête de la Jeunesse'], [W.addDays(e, -2), 'Vendredi saint'], [`${year}-05-01`, 'Fête du Travail'],
    [W.addDays(e, 39), 'Ascension'], [`${year}-05-20`, 'Fête nationale'], [`${year}-08-15`, 'Assomption'], [`${year}-12-25`, 'Noël'],
  ];
}
async function holidaysOf(req, year) {
  const have = await db.prepare('SELECT COUNT(*) c FROM hr_holidays WHERE org_id = ? AND date >= ? AND date <= ?').get(req.org.id, `${year}-01-01`, `${year}-12-31`);
  if (!Number(have.c) && !(await db.prepare("SELECT 1 FROM org_settings WHERE org_id = ? AND key = ?").get(req.org.id, 'holidays_seeded_' + year))) {
    for (const [d, n] of cameroonHolidays(Number(year))) await db.prepare("INSERT INTO hr_holidays (org_id, date, name, source) VALUES (?, ?, ?, 'exemple') ON CONFLICT DO NOTHING").run(req.org.id, d, n);
    await db.prepare("INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, '1') ON CONFLICT DO NOTHING").run(req.org.id, 'holidays_seeded_' + year);
  }
  return db.prepare('SELECT * FROM hr_holidays WHERE org_id = ? AND date >= ? AND date <= ? ORDER BY date').all(req.org.id, `${year}-01-01`, `${year}-12-31`);
}
hrRouter.get('/holidays', async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : nowISO().slice(0, 4);
  res.json({ year, items: (await holidaysOf(req, year)).map((h) => ({ id: h.id, date: h.date, name: h.name, source: h.source })), note: 'Jours fériés donnés en exemple, à vérifier et à compléter (fêtes musulmanes selon annonce officielle).' });
});
hrRouter.post('/holidays', adm, async (req, res) => {
  const date = A.date((req.body || {}).date); const name = A.text((req.body || {}).name, 80, { required: true, msg: 'Indiquez le nom du jour férié.' });
  if (!date) throw new HttpError(400, 'Indiquez la date.');
  if (await db.prepare('SELECT 1 FROM hr_holidays WHERE org_id = ? AND date = ?').get(req.org.id, date)) throw new HttpError(409, 'Ce jour est déjà dans la liste.');
  const id = Number((await db.prepare("INSERT INTO hr_holidays (org_id, date, name, source) VALUES (?, ?, ?, 'manual')").run(req.org.id, date, name)).lastInsertRowid);
  await W.audit(req, 'holiday', id, 'create', null, { date, name });
  res.status(201).json({ id });
});
hrRouter.put('/holidays/:id', adm, async (req, res) => {
  const h = await db.prepare('SELECT * FROM hr_holidays WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!h) throw new HttpError(404, 'Jour férié introuvable.');
  const b = req.body || {};
  const date = b.date === undefined ? h.date : A.date(b.date); const name = b.name === undefined ? h.name : A.text(b.name, 80, { required: true });
  await db.prepare("UPDATE hr_holidays SET date = ?, name = ?, source = 'manual' WHERE id = ?").run(date, name, h.id);
  await W.audit(req, 'holiday', h.id, 'update', { date: h.date, name: h.name }, { date, name });
  res.json({ ok: true });
});
hrRouter.delete('/holidays/:id', adm, async (req, res) => {
  const h = await db.prepare('SELECT * FROM hr_holidays WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!h) throw new HttpError(404, 'Jour férié introuvable.');
  await db.prepare('DELETE FROM hr_holidays WHERE id = ?').run(h.id);
  await W.audit(req, 'holiday', h.id, 'delete', { date: h.date, name: h.name }, null);
  res.json({ ok: true });
});

// ---------- Soldes de congés ----------
/** Jours ouvrables (lundi au samedi, hors jours fériés) entre deux dates, bornées à [from, to] si fournies. */
function workDays(start, end, hol, from, to) {
  let s = start; let e = end;
  if (from && s < from) s = from; if (to && e > to) e = to;
  let n = 0;
  for (let d = s; d <= e; d = W.addDays(d, 1)) { if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0 && !hol.has(d)) n++; }
  return n;
}
const monthsBetween = (a, b) => { // mois entiers entre a et b (b exclu)
  const [y1, m1, d1] = a.split('-').map(Number); const [y2, m2, d2] = b.split('-').map(Number);
  return Math.max((y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0), 0);
};
async function balanceFor(req, emp, year, st, depth = 0) {
  const y = Number(year);
  const hiredYear = emp.hired_at ? Number(emp.hired_at.slice(0, 4)) : y;
  const hol = new Set((await holidaysOf(req, String(y))).map((h) => h.date));
  const jan = `${y}-01-01`; const dec = `${y}-12-31`; const today = W.today();
  const start = emp.hired_at && emp.hired_at > jan ? emp.hired_at : jan;
  const end = today < dec ? today : dec;
  const accrued = emp.hired_at && emp.hired_at > dec || end < start ? 0 : Math.round(monthsBetween(start, W.addDays(end, 1)) * st.leave_accrual * 100) / 100;
  let carried = 0;
  if (depth < 4 && y - 1 >= hiredYear && st.leave_carry_max > 0) {
    const prev = await balanceFor(req, emp, String(y - 1), st, depth + 1);
    carried = Math.min(Math.max(prev.balance, 0), st.leave_carry_max);
  }
  const adj = Number((await db.prepare('SELECT COALESCE(SUM(days), 0) s FROM leave_adjustments WHERE employee_id = ? AND year = ?').get(emp.id, String(y))).s);
  const leaves = await db.prepare("SELECT start, \"end\", status FROM leaves WHERE employee_id = ? AND kind = 'annual' AND status IN ('approved','pending') AND start <= ? AND \"end\" >= ?").all(emp.id, dec, jan);
  let taken = 0; let pending = 0;
  for (const l of leaves) { const d = workDays(l.start, l.end, hol, jan, dec); if (l.status === 'approved') taken += d; else pending += d; }
  const balance = Math.round((carried + accrued + adj - taken) * 100) / 100;
  return { year: String(y), accrued, carried, adjustments: adj, taken, pending, balance, available: Math.round((balance - pending) * 100) / 100 };
}
hrRouter.get('/balances', async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : nowISO().slice(0, 4);
  const st = await W.settings(req.org.id);
  const emps = (await require('./hr').employees(req)).filter((e) => e.status === 'active');
  const out = [];
  for (const e of emps) out.push({ employeeId: e.id, name: e.name, ...(await balanceFor(req, e, year, st)) });
  res.json({ year, accrualPerMonth: st.leave_accrual, carryMax: st.leave_carry_max, items: out, note: "Jours ouvrables (lundi au samedi, hors jours fériés). Repère de travail : vérifiez les règles de votre convention collective." });
});
hrRouter.get('/leave-adjustments', async (req, res) => {
  const ids = new Set((await require('./hr').employees(req)).map((e) => Number(e.id)));
  const rows = await db.prepare('SELECT a.*, e.name FROM leave_adjustments a JOIN employees e ON e.id = a.employee_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT 100').all(req.org.id);
  res.json({ items: rows.filter((r) => ids.has(Number(r.employee_id))).map((r) => ({ id: r.id, employeeId: r.employee_id, employee: r.name, year: r.year, days: r.days, note: r.note, createdAt: r.created_at })) });
});
hrRouter.post('/leave-adjustments', adm, async (req, res) => {
  const b = req.body || {};
  const e = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(A.id(b.employeeId), req.org.id);
  if (!e) throw new HttpError(404, 'Employé introuvable.');
  const days = Number(String(b.days).replace(',', '.'));
  if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 60) throw new HttpError(400, 'Indiquez un nombre de jours non nul (60 au plus, positif ou négatif).');
  const year = /^\d{4}$/.test(String(b.year || '')) ? String(b.year) : nowISO().slice(0, 4);
  const id = Number((await db.prepare('INSERT INTO leave_adjustments (org_id, employee_id, year, days, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, e.id, year, days, A.text(b.note, 200), req.user.id, nowISO())).lastInsertRowid);
  await W.audit(req, 'leave_adjustment', id, 'create', null, { employee: e.name, year, days });
  res.status(201).json({ id });
});
// Un membre voit son propre solde (employé lié à son compte)
router.get('/my-balance', async (req, res) => {
  const e = await db.prepare("SELECT * FROM employees WHERE org_id = ? AND user_id = ? AND status = 'active'").get(req.org.id, req.user.id);
  if (!e) return res.json({ linked: false });
  res.json({ linked: true, ...(await balanceFor(req, e, nowISO().slice(0, 4), await W.settings(req.org.id))) });
});

/** Contrôle du solde avant qu'une demande de congé annuel soit enregistrée (la route d'origine suit si tout va bien). */
router.post('/leaves', mgr, async (req, res, next) => {
  const b = req.body || {};
  if ((b.kind || 'annual') !== 'annual' || !b.start || !b.end || !b.employeeId) return next();
  const start = A.date(b.start); const end = A.date(b.end);
  if (!start || !end || end < start || start.slice(0, 4) !== end.slice(0, 4)) return next(); // la route d'origine signale les erreurs ; une demande à cheval sur deux années n'est pas contrôlée
  const e = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(A.id(b.employeeId), req.org.id);
  if (!e) return next();
  const hol = new Set((await holidaysOf(req, start.slice(0, 4))).map((h) => h.date));
  const asked = workDays(start, end, hol);
  const bal = await balanceFor(req, e, start.slice(0, 4), await W.settings(req.org.id));
  if (asked > bal.available && !(b.force && A.can(req, 'admin'))) throw new HttpError(400, `Solde insuffisant : ${asked} jour(s) ouvrable(s) demandé(s), ${bal.available} disponible(s). Un administrateur peut forcer la demande.`);
  req.leaveDays = asked;
  next();
});

// ---------- Dossier du personnel (administrateurs) ----------
const FILE_FIELDS = { cniNo: 'cni_no', birthDate: 'birth_date', address: 'address', emergencyName: 'emergency_name', emergencyPhone: 'emergency_phone', diplomas: 'diplomas', email: null };
const fileView = (e) => ({ id: e.id, name: e.name, cniNo: e.cni_no, birthDate: e.birth_date, address: e.address, emergencyName: e.emergency_name, emergencyPhone: e.emergency_phone, diplomas: e.diplomas, cnpsNo: e.cnps_no, niu: e.niu });
const empScoped = async (req, id) => {
  const e = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!e || !A.visible(req, e)) throw new HttpError(404, 'Employé introuvable.');
  return e;
};
hrRouter.get('/employees/:id/file', adm, async (req, res) => {
  const e = await empScoped(req, req.params.id);
  await W.audit(req, 'employee_file', e.id, 'read', null, null);
  res.json({ file: fileView(e), note: 'Données personnelles : accès réservé aux administrateurs, chaque consultation et modification est journalisée.' });
});
hrRouter.put('/employees/:id/file', adm, async (req, res) => {
  const e = await empScoped(req, req.params.id); const b = req.body || {};
  const set = {};
  if (b.cniNo !== undefined) set.cni_no = A.text(b.cniNo, 40);
  if (b.birthDate !== undefined) set.birth_date = A.date(b.birthDate);
  if (b.address !== undefined) set.address = A.text(b.address, 300);
  if (b.emergencyName !== undefined) set.emergency_name = A.text(b.emergencyName, 100);
  if (b.emergencyPhone !== undefined) set.emergency_phone = A.text(b.emergencyPhone, 40);
  if (b.diplomas !== undefined) set.diplomas = A.text(b.diplomas, 600);
  if (b.cnpsNo !== undefined) set.cnps_no = A.text(b.cnpsNo, 30);
  if (Object.keys(set).length) {
    await db.prepare(`UPDATE employees SET ${Object.keys(set).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), e.id);
    await W.audit(req, 'employee_file', e.id, 'update', Object.fromEntries(Object.keys(set).map((c) => [c, e[c]])), set);
  }
  res.json({ ok: true });
});
F.mount(hrRouter, '/employees', { type: 'employee', table: 'employees', role: 'admin', label: 'Employé', module: 'hr', scopeCheck: (req, row) => A.visible(req, row) });

// ---------- Contrats, pointage, recrutement, évaluations, formations ----------
const emp = { k: 'employeeId', t: 'ref', ref: 'employees', req: true, label: 'Employé', msg: "Choisissez l'employé." };
W.crud(hrRouter, { path: '/contracts', table: 'hr_contracts', entity: 'contract', employeeScoped: true, order: 'COALESCE(end_date, \'9999-12-31\'), id DESC', filters: ['employeeId'],
  fields: [emp, { k: 'kind', t: 'enum', opts: ['cdi', 'cdd', 'stage', 'essai', 'prestation'], def: 'cdi' }, { k: 'startDate', t: 'date' }, { k: 'endDate', t: 'date' }, { k: 'trialEnd', t: 'date' }, { k: 'medicalDue', t: 'date' }, { k: 'note', t: 'text', max: 500 }],
  validate: async (req, v) => { if (v.start_date && v.end_date && v.end_date < v.start_date) throw new HttpError(400, 'La fin du contrat est avant son début.'); },
  decorate: async (req, rows) => { const n = new Map((await db.prepare('SELECT id, name FROM employees WHERE org_id = ?').all(req.org.id)).map((e) => [Number(e.id), e.name])); return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), employee: n.get(Number(r.employee_id)) } })); } });

const ATT = ['present', 'late', 'absent', 'justified'];
W.crud(hrRouter, { path: '/attendance', table: 'hr_attendance', entity: 'attendance', noCreated: true, employeeScoped: true, order: 'day DESC, id DESC', filters: ['employeeId', 'day'],
  fields: [emp, { k: 'day', t: 'date', req: true, msg: 'Indiquez le jour.' }, { k: 'status', t: 'enum', opts: ATT, def: 'present' }, { k: 'minutesLate', t: 'int', min: 0, max: 600 }, { k: 'note', t: 'text', max: 200 }],
  validate: async (req, v, cur) => { if (!cur && await db.prepare('SELECT 1 FROM hr_attendance WHERE employee_id = ? AND day = ?').get(v.employee_id, v.day)) throw new HttpError(409, 'Ce jour est déjà pointé pour cet employé : modifiez la ligne existante.'); if (v.status && v.status !== 'late' && !cur) v.minutes_late = 0; },
  decorate: async (req, rows) => { const n = new Map((await db.prepare('SELECT id, name FROM employees WHERE org_id = ?').all(req.org.id)).map((e) => [Number(e.id), e.name])); return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), employee: n.get(Number(r.employee_id)) } })); } });
hrRouter.get('/attendance-summary', async (req, res) => {
  const r = A.monthRange(req.query.month);
  const ids = new Set((await require('./hr').employees(req)).filter((e) => e.status === 'active').map((e) => Number(e.id)));
  const rows = await db.prepare('SELECT a.*, e.name FROM hr_attendance a JOIN employees e ON e.id = a.employee_id WHERE a.org_id = ? AND a.day >= ? AND a.day < ?').all(req.org.id, r.from, r.to);
  const by = new Map();
  for (const a of rows) {
    if (!ids.has(Number(a.employee_id))) continue;
    const o = by.get(a.employee_id) || { employeeId: a.employee_id, name: a.name, present: 0, late: 0, absent: 0, justified: 0, minutesLate: 0 };
    o[a.status] = (o[a.status] || 0) + 1; o.minutesLate += Number(a.minutes_late); by.set(a.employee_id, o);
  }
  res.json({ month: r.month, items: [...by.values()] });
});

W.crud(hrRouter, { path: '/jobs', table: 'hr_jobs', entity: 'job', order: "CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC",
  fields: [{ k: 'title', t: 'text', max: 120, req: true, msg: "Indiquez l'intitulé du poste." }, { k: 'description', t: 'text', max: 2000 }, { k: 'status', t: 'enum', opts: ['open', 'closed'], def: 'open' }, { k: 'positionId', t: 'ref', ref: 'positions', label: 'Poste' }],
  decorate: async (req, rows) => { const c = await db.prepare('SELECT job_id, COUNT(*) n FROM hr_candidates WHERE org_id = ? GROUP BY job_id').all(req.org.id); const m = new Map(c.map((x) => [Number(x.job_id), Number(x.n)])); return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), candidates: m.get(Number(r.id)) || 0 } })); } });
const STAGES = ['new', 'screening', 'interview', 'offer', 'hired', 'rejected'];
W.crud(hrRouter, { path: '/candidates', table: 'hr_candidates', entity: 'candidate', order: 'id DESC', filters: ['jobId', 'stage'],
  fields: [{ k: 'jobId', t: 'ref', ref: 'hr_jobs', req: true, label: 'Offre', msg: "Choisissez l'offre." }, { k: 'name', t: 'text', max: 100, req: true, msg: 'Indiquez le nom du candidat.' }, { k: 'phone', t: 'text', max: 40 }, { k: 'email', t: 'text', max: 120 }, { k: 'stage', t: 'enum', opts: STAGES, def: 'new' }, { k: 'note', t: 'text', max: 800 }] });
hrRouter.post('/candidates/:id/hire', adm, async (req, res) => {
  const c = await db.prepare('SELECT c.*, j.title AS job FROM hr_candidates c JOIN hr_jobs j ON j.id = c.job_id WHERE c.id = ? AND c.org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Candidat introuvable.');
  if (c.stage === 'hired') throw new HttpError(409, 'Ce candidat est déjà embauché.');
  const hiredAt = A.date((req.body || {}).hiredAt) || W.today();
  const empId = await db.transaction(async () => {
    const id = Number((await db.prepare('INSERT INTO employees (org_id, branch_id, name, job, phone, hired_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, A.can(req, 'admin') ? null : req.member.branch_id, c.name, c.job, c.phone, hiredAt, nowISO())).lastInsertRowid);
    await db.prepare("UPDATE hr_candidates SET stage = 'hired' WHERE id = ?").run(c.id);
    return id;
  })();
  await W.audit(req, 'candidate', c.id, 'update', { stage: c.stage }, { stage: 'hired', employeeId: empId });
  res.status(201).json({ employeeId: empId });
});
W.crud(hrRouter, { path: '/reviews', table: 'hr_reviews', entity: 'review', employeeScoped: true, filters: ['employeeId'], insertExtra: (req) => ({ reviewer_id: req.user.id }),
  fields: [emp, { k: 'period', t: 'text', max: 40, req: true, msg: 'Indiquez la période (ex. 2026 S1).' }, { k: 'score', t: 'int', min: 1, max: 5, def: 3 }, { k: 'strengths', t: 'text', max: 1000 }, { k: 'goals', t: 'text', max: 1000 }],
  decorate: async (req, rows) => { const n = new Map((await db.prepare('SELECT id, name FROM employees WHERE org_id = ?').all(req.org.id)).map((e) => [Number(e.id), e.name])); return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), employee: n.get(Number(r.employee_id)) } })); } });
W.crud(hrRouter, { path: '/trainings', table: 'hr_trainings', entity: 'training', employeeScoped: true, order: "COALESCE(expires_at, '9999-12-31'), id DESC", filters: ['employeeId'],
  fields: [emp, { k: 'title', t: 'text', max: 120, req: true, msg: 'Indiquez la formation ou habilitation.' }, { k: 'kind', t: 'enum', opts: ['training', 'certification'], def: 'training' }, { k: 'doneAt', t: 'date' }, { k: 'expiresAt', t: 'date' }, { k: 'provider', t: 'text', max: 120 }, { k: 'note', t: 'text', max: 300 }],
  decorate: async (req, rows) => { const n = new Map((await db.prepare('SELECT id, name FROM employees WHERE org_id = ?').all(req.org.id)).map((e) => [Number(e.id), e.name])); return rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), employee: n.get(Number(r.employee_id)) } })); } });

/** Échéances RH à surveiller : fin de CDD, fin d'essai, visite médicale, habilitations expirées (utilisé par les alertes). */
async function dueItems(req, days) {
  const st = await W.settings(req.org.id);
  const limit = W.addDays(W.today(), days === undefined ? st.alert_contract_days : days);
  const ids = new Set((await require('./hr').employees(req)).filter((e) => e.status === 'active').map((e) => Number(e.id)));
  const names = new Map((await db.prepare('SELECT id, name FROM employees WHERE org_id = ?').all(req.org.id)).map((e) => [Number(e.id), e.name]));
  const out = [];
  const push = (kind, r, date) => { if (ids.has(Number(r.employee_id)) && date && date <= limit) out.push({ kind, who: names.get(Number(r.employee_id)), employeeId: Number(r.employee_id), date, expired: date < W.today(), title: r.title || '' }); };
  for (const c of await db.prepare('SELECT * FROM hr_contracts WHERE org_id = ?').all(req.org.id)) {
    if (c.kind === 'cdd' || c.kind === 'stage') push('contract_end', c, c.end_date);
    push('trial_end', c, c.trial_end); push('medical', c, c.medical_due);
  }
  for (const t of await db.prepare('SELECT * FROM hr_trainings WHERE org_id = ? AND expires_at IS NOT NULL').all(req.org.id)) push('certification', t, t.expires_at);
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
hrRouter.get('/due', async (req, res) => res.json({ items: await dueItems(req) }));

// ---------- Recrutement depuis un poste vacant (Organisation) ----------
hrRouter.post('/jobs/from-position/:id', async (req, res) => {
  const p = await db.prepare('SELECT * FROM positions WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Poste introuvable.');
  if (p.holder_id) throw new HttpError(409, "Ce poste n'est pas vacant.");
  const dup = await db.prepare("SELECT id FROM hr_jobs WHERE org_id = ? AND position_id = ? AND status = 'open'").get(req.org.id, p.id);
  if (dup) return res.json({ id: dup.id, created: false });
  const id = Number((await db.prepare("INSERT INTO hr_jobs (org_id, position_id, title, description, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)").run(req.org.id, p.id, p.title, p.description || '', nowISO())).lastInsertRowid);
  await W.audit(req, 'job', id, 'create', null, { title: p.title, positionId: p.id });
  res.status(201).json({ id, created: true });
});

module.exports = router;
module.exports.dueItems = dueItems;
module.exports.balanceFor = balanceFor;
module.exports.workDays = workDays;
module.exports.holidaysOf = holidaysOf;
