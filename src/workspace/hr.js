'use strict';
// Sous-application « Ressources humaines » : fiches employés, congés à valider, planning de la semaine.
// Réservée aux responsables et plus. Le salaire n'est vu et modifié que par les administrateurs et plus.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const wh = require('../services/webhooks');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const today = () => nowISO().slice(0, 10);
const LEAVE_KINDS = ['annual', 'sick', 'unpaid', 'other']; // « unpaid » : absence non payée, retenue automatique sur le bulletin (Paie)

const empOf = async (req, id) => {
  const e = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!e || !A.visible(req, e)) throw new HttpError(404, 'Employé introuvable.');
  return e;
};
const time = (v) => { if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError(400, 'Heure invalide (format HH:MM).'); return v; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

const empView = (req, e) => ({ id: e.id, name: e.name, job: e.job, phone: e.phone, hiredAt: e.hired_at, status: e.status, branchId: e.branch_id, salary: A.can(req, 'admin') ? e.salary : undefined,
  cnpsNo: A.can(req, 'admin') ? e.cnps_no : undefined, niu: A.can(req, 'admin') ? e.niu : undefined, payChannel: A.can(req, 'admin') ? e.pay_channel : undefined, payAccount: A.can(req, 'admin') ? e.pay_account : undefined });

async function employees(req) {
  const sc = A.scope(req);
  return await db.prepare(`SELECT * FROM employees WHERE org_id = ?${sc.sql} ORDER BY status, name COLLATE NOCASE`).all(req.org.id, ...sc.args);
}
async function leavesOn(req, day) {
  const ids = new Set((await employees(req)).map((e) => e.id));
  return (await db.prepare("SELECT l.*, e.name FROM leaves l JOIN employees e ON e.id = l.employee_id WHERE l.org_id = ? AND l.status = 'approved' AND l.start <= ? AND l.end >= ?").all(req.org.id, day, day)).filter((l) => ids.has(l.employee_id));
}

router.get('/', async (req, res) => {
  const list = await employees(req);
  const active = list.filter((e) => e.status === 'active');
  res.json({
    employees: list.map((e) => empView(req, e)),
    summary: {
      active: active.length, onLeave: (await leavesOn(req, today())).length,
      pendingLeaves: (await db.prepare("SELECT COUNT(*) c FROM leaves WHERE org_id = ? AND status = 'pending'").get(req.org.id)).c,
      payroll: A.can(req, 'admin') ? active.reduce((a, e) => a + (e.salary || 0), 0) : undefined,
    },
  });
});

/** Références sociales et coordonnées de paiement (administrateurs seulement) : matricule CNPS, NIU, canal et compte de virement. */
async function payInfo(req, id, b, cur) {
  const has = ['cnpsNo', 'niu', 'payChannel', 'payAccount'].some((k) => b[k] !== undefined);
  if (!has) return;
  const ch = b.payChannel === undefined ? cur.pay_channel || '' : A.oneOf(b.payChannel, ['', 'bank', 'mobile'], undefined, 'Canal de paiement : banque ou mobile money.');
  const acc = b.payAccount === undefined ? cur.pay_account || '' : A.text(b.payAccount, 60);
  if (acc && !/^[A-Za-z0-9 +().\-/]{4,60}$/.test(acc)) throw new HttpError(400, 'Compte bancaire ou numéro de mobile money invalide.');
  await db.prepare('UPDATE employees SET cnps_no = ?, niu = ?, pay_channel = ?, pay_account = ? WHERE id = ? AND org_id = ?').run(
    b.cnpsNo === undefined ? cur.cnps_no || '' : A.text(b.cnpsNo, 30), b.niu === undefined ? cur.niu || '' : A.text(b.niu, 30), ch, acc, id, req.org.id);
}

router.post('/employees', async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO employees (org_id, branch_id, name, job, phone, hired_at, salary, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, await A.branchOf(req, b.branchId), A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'employé." }), A.text(b.job, 100), A.text(b.phone, 40), A.date(b.hiredAt),
    A.can(req, 'admin') && b.salary !== undefined && b.salary !== '' ? A.amount(b.salary) : null, await A.memberOf(req, b.userId), nowISO())).lastInsertRowid;
  if (A.can(req, 'admin')) await payInfo(req, Number(id), b, {});
  await A.logActivity(req.org.id, req.user.id, 'hr', `Employé « ${A.text(b.name, 100)} » ajouté`);
  res.status(201).json({ id: Number(id) });
});

router.put('/employees/:id', async (req, res) => {
  const e = await empOf(req, req.params.id);
  const b = req.body || {};
  const salary = !A.can(req, 'admin') || b.salary === undefined ? e.salary : b.salary === '' || b.salary === null ? null : A.amount(b.salary);
  await db.prepare('UPDATE employees SET name = ?, job = ?, phone = ?, hired_at = ?, salary = ?, status = ? WHERE id = ?').run(
    b.name === undefined ? e.name : A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'employé." }), b.job === undefined ? e.job : A.text(b.job, 100), b.phone === undefined ? e.phone : A.text(b.phone, 40),
    b.hiredAt === undefined ? e.hired_at : A.date(b.hiredAt), salary, b.status === undefined ? e.status : A.oneOf(b.status, ['active', 'left'], undefined, 'Statut inconnu.'), e.id);
  if (A.can(req, 'admin')) await payInfo(req, e.id, b, e);
  const nu = { name: b.name === undefined ? e.name : b.name, job: b.job === undefined ? e.job : b.job, phone: b.phone === undefined ? e.phone : b.phone, status: b.status === undefined ? e.status : b.status, salary: salary };
  await W.audit(req, 'employee', e.id, 'update', { name: e.name, job: e.job, phone: e.phone, status: e.status, salary: e.salary }, nu);
  res.json({ ok: true });
});

router.delete('/employees/:id', A.need('admin'), async (req, res) => {
  const e = await empOf(req, req.params.id);
  await require('./files-w3').dropFor(req.org.id, 'employee', e.id);
  await W.audit(req, 'employee', e.id, 'delete', { name: e.name, job: e.job, status: e.status }, null);
  await db.prepare('DELETE FROM employees WHERE id = ?').run(e.id);
  res.json({ ok: true });
});

// ---------- Congés ----------
router.get('/leaves', async (req, res) => {
  const ids = new Set((await employees(req)).map((e) => e.id));
  const rows = (await db.prepare("SELECT l.*, e.name FROM leaves l JOIN employees e ON e.id = l.employee_id WHERE l.org_id = ? ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.start DESC LIMIT 60").all(req.org.id)).filter((l) => ids.has(l.employee_id));
  res.json({ leaves: rows.map((l) => ({ id: l.id, employeeId: l.employee_id, employee: l.name, kind: l.kind, start: l.start, end: l.end, days: days(l.start, l.end), status: l.status, note: l.note })) });
});

router.post('/leaves', async (req, res) => {
  const b = req.body || {};
  const e = await empOf(req, b.employeeId);
  const start = A.date(b.start); const end = A.date(b.end);
  if (!start || !end) throw new HttpError(400, 'Indiquez la date de début et la date de fin.');
  if (end < start) throw new HttpError(400, 'La fin du congé est avant son début.');
  if (days(start, end) > 120) throw new HttpError(400, 'Un congé ne peut pas dépasser 120 jours.');
  if (await db.prepare("SELECT 1 FROM leaves WHERE employee_id = ? AND status != 'refused' AND start <= ? AND end >= ?").get(e.id, end, start)) throw new HttpError(400, 'Cet employé a déjà un congé sur ces dates.');
  const id = (await db.prepare('INSERT INTO leaves (org_id, employee_id, kind, start, end, note, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, e.id, A.oneOf(b.kind, LEAVE_KINDS, 'annual', 'Type de congé inconnu.'), start, end, A.text(b.note, 300), req.user.id, nowISO())).lastInsertRowid;
  await W.pushRole(req.org.id, 'manager', 'leave', `Nouvelle demande de congé : ${e.name} du ${start} au ${end}`, 'leave:' + id);
  wh.emit(req.org.id, 'leave.requested', { id: Number(id), employee: e.name, start, end });
  res.status(201).json({ id: Number(id) });
});

router.put('/leaves/:id/decision', async (req, res) => {
  const l = await db.prepare('SELECT * FROM leaves WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!l) throw new HttpError(404, 'Demande introuvable.');
  const e = await empOf(req, l.employee_id);
  if (l.status !== 'pending') throw new HttpError(400, 'Cette demande a déjà été traitée.');
  if (e.user_id === req.user.id && !A.can(req, 'admin')) throw new HttpError(403, 'Une autre personne doit valider votre propre congé.');
  const status = A.oneOf((req.body || {}).decision, ['approved', 'refused'], undefined, 'Décision inconnue.');
  await db.prepare('UPDATE leaves SET status = ?, decided_by = ? WHERE id = ?').run(status, req.user.id, l.id);
  await A.logActivity(req.org.id, req.user.id, 'hr', `Congé de ${e.name} : ${status === 'approved' ? 'accepté' : 'refusé'}`);
  await W.audit(req, 'leave', l.id, 'decision', { status: l.status }, { status, employee: e.name });
  if (e.user_id) await W.push(req.org.id, e.user_id, 'leave', `Votre demande de congé du ${l.start} au ${l.end} est ${status === 'approved' ? 'acceptée' : 'refusée'}.`, 'leave:' + l.id);
  res.json({ ok: true });
});

router.delete('/leaves/:id', async (req, res) => {
  const l = await db.prepare('SELECT * FROM leaves WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!l) throw new HttpError(404, 'Demande introuvable.');
  await empOf(req, l.employee_id);
  await db.prepare('DELETE FROM leaves WHERE id = ?').run(l.id);
  res.json({ ok: true });
});

// ---------- Planning de la semaine ----------
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monday = (d) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));

router.get('/planning', async (req, res) => {
  const start = monday(A.date(req.query.week) || today());
  const end = addDays(start, 6);
  const emps = (await employees(req)).filter((e) => e.status === 'active');
  const ids = new Set(emps.map((e) => e.id));
  const shifts = (await db.prepare('SELECT * FROM shifts WHERE org_id = ? AND day >= ? AND day <= ? ORDER BY day, start_time').all(req.org.id, start, end)).filter((s) => ids.has(s.employee_id));
  const leaves = (await db.prepare("SELECT * FROM leaves WHERE org_id = ? AND status = 'approved' AND start <= ? AND end >= ?").all(req.org.id, end, start)).filter((l) => ids.has(l.employee_id));
  res.json({ start, end, employees: emps.map((e) => ({ id: e.id, name: e.name, job: e.job })), shifts: shifts.map((s) => ({ id: s.id, employeeId: s.employee_id, day: s.day, start: s.start_time, end: s.end_time, note: s.note })), leaves: leaves.map((l) => ({ employeeId: l.employee_id, start: l.start, end: l.end })) });
});

router.post('/shifts', async (req, res) => {
  const b = req.body || {};
  const e = await empOf(req, b.employeeId);
  if (e.status !== 'active') throw new HttpError(400, "Cet employé n'est plus en poste.");
  const day = A.date(b.day);
  if (!day) throw new HttpError(400, 'Indiquez le jour.');
  const st = time(b.start); const en = time(b.end);
  if (en <= st) throw new HttpError(400, "L'heure de fin doit être après l'heure de début.");
  if (await db.prepare("SELECT 1 FROM leaves WHERE employee_id = ? AND status = 'approved' AND start <= ? AND end >= ?").get(e.id, day, day)) throw new HttpError(400, `${e.name} est en congé ce jour-là.`);
  if (await db.prepare('SELECT 1 FROM shifts WHERE employee_id = ? AND day = ? AND start_time < ? AND end_time > ?').get(e.id, day, en, st)) throw new HttpError(400, 'Cet employé a déjà un horaire qui se chevauche ce jour-là.');
  const id = (await db.prepare('INSERT INTO shifts (org_id, employee_id, day, start_time, end_time, note) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, e.id, day, st, en, A.text(b.note, 100))).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});

router.delete('/shifts/:id', async (req, res) => {
  const s = await db.prepare('SELECT * FROM shifts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Horaire introuvable.');
  await empOf(req, s.employee_id);
  await db.prepare('DELETE FROM shifts WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.employees = employees;
module.exports.leavesOn = leavesOn;
