'use strict';
// RH Talents · indicateurs RH : effectif, turnover, absentéisme, ancienneté, masse salariale, coût et délai de recrutement, taux de formation, parité,
// pyramide des âges, engagement. Tableau de bord avec alertes. Les montants de rémunération ne sont fournis qu'au rôle « remun ».
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, A, HttpError, need, has, audit } = C;

const router = express.Router({ mergeParams: true });
const eom = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // dernier jour du mois m (1–12)

/** Effectif à une date : embauché au plus tard ce jour-là et pas encore parti. Un départ sans date connue n'est compté nulle part (voir la note du rapport). */
const activeOn = (e, left, day) => (!e.hired_at || e.hired_at <= day) && (left ? left > day : e.status === 'active');

async function compute(req, y) {
  const money = await has(req, 'remun');
  const today = C.today(); const jan = `${y}-01-01`; const dec = `${y}-12-31`;
  const all = await require('./hr').employees(req);
  const profs = new Map((await db.prepare('SELECT * FROM rh_emp_profile WHERE org_id = ?').all(req.org.id)).map((p) => [Number(p.employee_id), p]));
  // date de départ : celle du profil RH, sinon la date de sortie du solde de tout compte de la paie
  const settle = new Map((await db.prepare('SELECT employee_id, exit_date FROM payroll_settlements WHERE org_id = ?').all(req.org.id)).map((s) => [Number(s.employee_id), s.exit_date]));
  const leftOf = (e) => (e.status === 'left' ? (profs.get(Number(e.id)) || {}).left_at || settle.get(Number(e.id)) || null : null);
  const active = all.filter((e) => e.status === 'active');
  const start = all.filter((e) => activeOn(e, leftOf(e), jan)).length;
  const refDay = y < Number(today.slice(0, 4)) ? dec : today;
  const end = all.filter((e) => activeOn(e, leftOf(e), refDay)).length;
  const departures = all.filter((e) => { const l = leftOf(e); return l && l >= jan && l <= dec; }).length;
  const arrivals = all.filter((e) => e.hired_at && e.hired_at >= jan && e.hired_at <= dec).length;
  const avgHead = (start + end) / 2;
  const turnover = avgHead > 0 ? L.r1(100 * departures / avgHead) : null;
  const trend = Array.from({ length: 12 }, (_, i) => { const d = eom(y, i + 1); return { month: `${y}-${String(i + 1).padStart(2, '0')}`, headcount: d > today && y >= Number(today.slice(0, 4)) ? null : all.filter((e) => activeOn(e, leftOf(e), d)).length }; });
  // absentéisme (pointage de l'année) et congés maladie
  const att = await db.prepare('SELECT status, COUNT(*) n FROM hr_attendance WHERE org_id = ? AND day >= ? AND day <= ? GROUP BY status').all(req.org.id, jan, dec);
  const a = Object.fromEntries(att.map((r) => [r.status, Number(r.n)])); const totalAtt = Object.values(a).reduce((s, n) => s + n, 0);
  const absent = (a.absent || 0) + (a.justified || 0);
  const sick = (await db.prepare("SELECT start, \"end\" FROM leaves WHERE org_id = ? AND kind = 'sick' AND status = 'approved' AND start <= ? AND \"end\" >= ?").all(req.org.id, dec, jan)).reduce((s, l) => s + Math.round((Date.parse(l.end < dec ? l.end : dec) - Date.parse(l.start > jan ? l.start : jan)) / 86400000) + 1, 0);
  // ancienneté
  const sen = active.map((e) => L.yearsBetween(e.hired_at, today)).filter((v) => v !== null);
  // recrutement
  const jobs = await db.prepare('SELECT * FROM hr_jobs WHERE org_id = ?').all(req.org.id);
  const cands = (await db.prepare('SELECT * FROM hr_candidates WHERE org_id = ?').all(req.org.id)).filter((c) => c.stage !== 'hired' || (c.hired_at && c.hired_at >= jan && c.hired_at <= dec));
  const rec = await require('./rh-recruit').recruitStats(req, jobs, cands);
  // formation : personnes ayant suivi au moins une session (présence) ou une formation enregistrée dans l'année
  const trained = new Set((await db.prepare("SELECT a.employee_id FROM rh_train_attendees a JOIN rh_train_sessions s ON s.id = a.session_id WHERE a.org_id = ? AND a.presence = 'present' AND s.start_date >= ? AND s.start_date <= ?").all(req.org.id, jan, dec)).map((r) => Number(r.employee_id)));
  for (const t of await db.prepare('SELECT employee_id FROM hr_trainings WHERE org_id = ? AND done_at >= ? AND done_at <= ?').all(req.org.id, jan, dec)) trained.add(Number(t.employee_id));
  const activeIds = new Set(active.map((e) => Number(e.id)));
  const trainedActive = [...trained].filter((i) => activeIds.has(i)).length;
  const budget = await require('./rh-training').budgetOf(req, y);
  // parité et pyramide
  const gender = (e) => (profs.get(Number(e.id)) || {}).gender || '';
  const f = active.filter((e) => gender(e) === 'F').length; const m = active.filter((e) => gender(e) === 'M').length; const known = f + m;
  const pyr = L.pyramid(active.map((e) => ({ birth: e.birth_date, gender: gender(e) })), today);
  // engagement : dernière enquête dont les résultats sont publiables
  const surveys = await db.prepare("SELECT * FROM rh_surveys WHERE org_id = ? AND status IN ('open','closed') ORDER BY id DESC").all(req.org.id);
  let eng = null; for (const s of surveys) { const r = await require('./rh-career').surveyResults(req, s); if (!r.hidden) { eng = { surveyId: r.id, title: r.title, enps: r.enps ? r.enps.score : null, avg: r.avg, responses: r.responses, participation: r.participation }; break; } }
  // masse salariale (rémunération : rôle remun seulement)
  let payroll;
  if (money) {
    const monthly = active.reduce((s, e) => s + Number(e.salary || 0), 0);
    const last = await db.prepare('SELECT month, COALESCE(SUM(employer_cost), 0) c FROM payroll_slips WHERE org_id = ? GROUP BY month ORDER BY month DESC LIMIT 1').get(req.org.id);
    payroll = { monthlyBase: monthly, annualBase: monthly * 12, avgSalary: active.length ? Math.round(monthly / active.length) : null, lastPayroll: last ? { month: last.month, employerCost: Number(last.c) } : null };
  }
  // alertes
  const alerts = []; const push = (key, severity, value, extra) => alerts.push({ key, severity, value, ...extra });
  if (turnover !== null) { if (turnover > 25) push('turnover', 'high', turnover, { threshold: 25 }); else if (turnover > 15) push('turnover', 'medium', turnover, { threshold: 15 }); }
  const absRate = totalAtt ? L.r1(100 * absent / totalAtt) : null;
  if (absRate !== null) { if (absRate > 10) push('absenteeism', 'high', absRate, { threshold: 10 }); else if (absRate > 5) push('absenteeism', 'medium', absRate, { threshold: 5 }); }
  if (known >= 5 && Math.min(f, m) / known < 0.3) push('parity', 'medium', L.r1(100 * f / known), { threshold: 30 });
  const trainRate = active.length ? L.r1(100 * trainedActive / active.length) : null;
  if (trainRate !== null && active.length >= 3 && trainRate < 30) push('training_rate', 'medium', trainRate, { threshold: 30 });
  if (budget.amount > 0 && budget.remaining < 0) push('training_budget', 'high', budget.usedPct, { threshold: 100 });
  if (eng && eng.enps !== null) { if (eng.enps < -20) push('enps', 'high', eng.enps, { threshold: -20 }); else if (eng.enps < 0) push('enps', 'medium', eng.enps, { threshold: 0 }); }
  const due = await require('./hr-w3').dueItems(req);
  const expired = due.filter((d) => d.expired).length; if (expired) push('due_expired', 'high', expired, {});
  const slow = jobs.filter((j) => j.status === 'open' && j.opened_at && Math.round((Date.parse(today) - Date.parse(j.opened_at)) / 86400000) > 60).length; if (slow) push('slow_recruitment', 'medium', slow, { threshold: 60 });
  const succ = await require('./rh-career').successionRows(req); const crit = succ.filter((s) => s.vacancyRisk === 'critical').length; if (crit) push('vacancy_critical', 'high', crit, {});
  const high = Number((await db.prepare("SELECT COUNT(*) c FROM rh_retention WHERE org_id = ? AND risk = 'high'").get(req.org.id)).c); if (high) push('flight_risk', 'medium', high, {});
  const gp = await db.prepare('SELECT * FROM rh_goals WHERE org_id = ? AND level = ? AND status = ? AND due_date < ?').all(req.org.id, 'individual', 'active', today); if (gp.length) push('goals_overdue', 'medium', gp.length, {});
  if (money) { const pos = (await require('./rh-comp').positioning(req)); const below = pos.filter((p) => p.status === 'below_min').length; if (below) push('below_min_salary', 'medium', below, {}); }
  const sev = { high: 0, medium: 1, low: 2 }; alerts.sort((a1, b1) => sev[a1.severity] - sev[b1.severity]);
  return { year: y, headcount: { active: active.length, start, end, arrivals, departures, trend }, turnover: { rate: turnover, departures, avgHeadcount: L.r1(avgHead) }, absenteeism: { rate: absRate, absentDays: absent, records: totalAtt, sickLeaveDays: sick }, seniority: { avgYears: sen.length ? L.r1(L.avg(sen)) : null, people: sen.length },
    payroll, recruitment: { openJobs: rec.openJobs, hires: rec.hires, avgDaysToHire: rec.avgDaysToHire, costPerHire: money ? rec.costPerHire : undefined, funnel: rec.funnel }, training: { rate: trainRate, trained: trainedActive, hours: undefined, budgetUsedPct: money || (await has(req, 'talent')) ? budget.usedPct : undefined },
    parity: { female: f, male: m, unknown: active.length - known, femalePct: known ? L.r1(100 * f / known) : null }, pyramid: pyr, engagement: eng, alerts };
}
router.get('/kpi/dashboard', need('talent', 'recrut', 'remun'), async (req, res) => {
  const y = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : Number(C.today().slice(0, 4));
  await audit(req, 'kpi', null, 'read', null, { year: y });
  res.json(await compute(req, y));
});

module.exports = router;
module.exports.compute = compute;
