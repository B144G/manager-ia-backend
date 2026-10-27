'use strict';
// Paie CAMEROUN (sous-module de la Paie, administrateurs et propriétaire) : modèle chiffré et versionné (CNPS, IRPP, CAC, CFC, FNE),
// surcharges par l'organisation, absences non payées, solde de tout compte (document de travail), états déclaratifs CSV et fichier de virement.
// TOUT ce que produit ce module est un DOCUMENT DE TRAVAIL : voir payroll-cm-model.js (niveau de confiance et source supposée de chaque taux).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');
const M = require('./payroll-cm-model');

const router = express.Router({ mergeParams: true });
router.use(A.need('admin'));

const DOC_NOTICE = 'DOCUMENT DE TRAVAIL - barème à faire valider par un expert-comptable ou le CNPS/DGI avant usage officiel';
const today = () => nowISO().slice(0, 10);
const payroll = () => require('./payroll'); // require paresseux : pas de dépendance circulaire
const pad = (n) => String(n).padStart(2, '0');
const monthBounds = (month) => { const [y, m] = month.split('-').map(Number); return { from: `${month}-01`, to: `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` }; };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

// ---------- Modèle et surcharges ----------
async function overridesOf(orgId) {
  const rows = await db.prepare('SELECT key, value FROM payroll_cm_overrides WHERE org_id = ?').all(orgId);
  return new Map(rows.map((r) => [r.key, Number(r.value)]));
}
/** Modèle résolu (version applicable au mois + surcharges de l'organisation). */
async function loadModel(orgId, month) {
  return M.resolve(M.versionFor(month || today().slice(0, 7)), await overridesOf(orgId));
}
const missingOf = (model) => model.list.filter((x) => x.value === null && x.key !== 'irpp.quotite');

/** Absences non payées approuvées d'un employé sur un mois : jours calendaires et retenue (plafonnée au salaire de base). */
async function absenceFor(orgId, empId, month, base, divisor) {
  const { from, to } = monthBounds(month);
  const rows = await db.prepare(`SELECT start, "end" AS finish FROM leaves WHERE org_id = ? AND employee_id = ? AND kind = 'unpaid' AND status = 'approved' AND start <= ? AND "end" >= ?`).all(orgId, empId, to, from);
  let days = 0;
  for (const l of rows) days += daysBetween(l.start > from ? l.start : from, l.finish < to ? l.finish : to);
  const div = divisor > 0 ? divisor : 30;
  return { days, deduction: Math.min(Math.max(base, 0), Math.round(Math.max(base, 0) * days / div)) };
}

router.get('/model', async (req, res) => {
  const st = await payroll().loadRules(req.org.id);
  const month = A.monthRange(req.query.month).month;
  const model = await loadModel(req.org.id, month);
  res.json({
    warning: M.WARNING, notice: DOC_NOTICE, country: 'Cameroun', currency: 'XAF',
    version: model.version, validFrom: model.validFrom, asOf: model.asOf, versions: M.VERSIONS.map((v) => ({ version: v.version, validFrom: v.validFrom, asOf: v.asOf })),
    params: model.list.map((x) => ({ key: x.key, group: x.group, label: x.label, unit: x.unit, default: x.default, override: x.override, value: x.value, overridden: x.overridden, confidence: x.confidence, source: x.source, note: x.note, needsInput: x.value === null })),
    missing: missingOf(model).map((x) => x.key), notModeled: M.NOT_MODELED,
    engine: st.options.engine || '', absenceAuto: Boolean(st.options.absenceAuto),
    validation: { ratesAsOf: st.options.ratesAsOf || '', ...(st.options.cmValidation || {}) },
  });
});

const PCT_KEYS = (model) => new Set(model.list.filter((x) => x.unit === '%').map((x) => x.key));

router.put('/overrides', async (req, res) => {
  const b = (req.body || {}).overrides;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Indiquez les valeurs à modifier.');
  const base = M.resolve(M.versionFor(today().slice(0, 7)), new Map());
  const keys = new Set(base.list.map((x) => x.key)); const pct = PCT_KEYS(base);
  const cur = await overridesOf(req.org.id);
  const next = new Map(cur);
  for (const [k, raw] of Object.entries(b)) {
    if (!keys.has(k)) throw new HttpError(400, `Paramètre inconnu : ${k}.`);
    if (raw === null || raw === '') { next.delete(k); continue; }
    const n = Number(typeof raw === 'string' ? raw.replace(/\s/g, '').replace(',', '.') : raw);
    if (!Number.isFinite(n) || n < 0 || n > 1e11) throw new HttpError(400, `Valeur invalide pour ${k}.`);
    if (pct.has(k) && n > 100) throw new HttpError(400, `Un pourcentage ne peut pas dépasser 100 (${k}).`);
    if (k === 'irpp.cnps.deductible' && n !== 0 && n !== 1) throw new HttpError(400, 'Cette option vaut 0 (non) ou 1 (oui).');
    next.set(k, n);
  }
  const eff = (k) => (next.has(k) ? next.get(k) : base.values[k]);
  if (!(eff('irpp.t1.limit') < eff('irpp.t2.limit') && eff('irpp.t2.limit') < eff('irpp.t3.limit'))) throw new HttpError(400, 'Les tranches de l\'IRPP doivent être croissantes.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM payroll_cm_overrides WHERE org_id = ?').run(req.org.id);
    for (const [k, v] of next) await db.prepare('INSERT INTO payroll_cm_overrides (org_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, k, v, req.user.id, nowISO());
  })();
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Barème de paie Cameroun : ${Object.keys(b).length} paramètre(s) modifié(s)`);
  res.json({ ok: true, overrides: Object.fromEntries(next), note: 'Les bulletins validés ne changent pas ; les brouillons se recalculent à leur prochaine modification.' });
});

router.post('/activate', async (req, res) => {
  await payroll().saveOptions(req, { engine: 'cm', absenceAuto: true, templateId: 'cm' });
  await A.logActivity(req.org.id, req.user.id, 'payroll', 'Modèle de paie Cameroun activé');
  res.json({ ok: true, warning: M.WARNING });
});
router.post('/deactivate', async (req, res) => {
  await payroll().saveOptions(req, { engine: '' });
  await A.logActivity(req.org.id, req.user.id, 'payroll', 'Modèle de paie Cameroun désactivé');
  res.json({ ok: true });
});
// Date « à jour au » : posée par l'organisation APRÈS vérification du barème par un expert-comptable ou auprès du CNPS/DGI.
router.put('/validation', async (req, res) => {
  const b = req.body || {};
  const by = A.text(b.by, 100, { required: true, msg: 'Indiquez qui a vérifié le barème (expert-comptable, CNPS, DGI…).' });
  const at = A.date(b.date);
  if (!at) throw new HttpError(400, 'Indiquez la date de vérification (« à jour au »).');
  if (at > today()) throw new HttpError(400, 'La date de vérification ne peut pas être dans le futur.');
  await payroll().saveOptions(req, { ratesAsOf: at, cmValidation: { by, at, note: A.text(b.note, 200) } });
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Barème de paie Cameroun vérifié par ${by} (à jour au ${at})`);
  res.json({ ok: true });
});

// Simulation sans enregistrer : brut -> retenues -> net.
router.post('/simulate', async (req, res) => {
  const b = req.body || {};
  const month = A.monthRange(b.month).month;
  const num = (v) => (v === undefined || v === null || v === '' ? 0 : A.amount(v));
  const f = { base: num(b.base), bonuses: num(b.bonuses), overtime: num(b.overtime), annualBonus: num(b.annualBonus), advances: num(b.advances), otherDeductions: num(b.otherDeductions), absenceDeduction: num(b.absenceDeduction) };
  if (!(f.base > 0)) throw new HttpError(400, 'Le salaire de base doit être supérieur à zéro.');
  const model = await loadModel(req.org.id, month);
  res.json({ ...M.compute(model, f), warning: M.WARNING, missing: missingOf(model).map((x) => x.key), version: model.version });
});

// ---------- États et fichiers ----------
const cell = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
function sendCsv(res, name, rows) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.send('﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n'));
}
const lineOf = (lines, code) => lines.find((l) => l.code === code) || { amount: 0, basis: 0 };
const parse = (s) => { try { return JSON.parse(s); } catch { return []; } };

async function slipsOf(orgId, month) {
  return await db.prepare(`SELECT s.*, e.cnps_no, e.niu, e.pay_channel, e.pay_account, e.phone FROM payroll_slips s LEFT JOIN employees e ON e.id = s.employee_id WHERE s.org_id = ? AND s.month = ? ORDER BY s.employee_name, s.id`).all(orgId, month);
}
const STATUS_FR = { draft: 'brouillon', validated: 'validé', paid: 'payé' };

// Récapitulatif mensuel des cotisations CNPS (document de travail, pas la déclaration officielle).
router.get('/export/cnps.csv', async (req, res) => {
  const month = A.monthRange(req.query.month).month;
  const slips = await slipsOf(req.org.id, month);
  const rows = [[DOC_NOTICE], ['mois', 'matricule_cnps', 'nom', 'statut_bulletin', 'salaire_brut', 'assiette_plafonnee', 'pvid_salarie', 'pvid_employeur', 'prestations_familiales', 'accidents_travail', 'total_cotisations']];
  const tot = { gross: 0, capped: 0, pe: 0, pr: 0, pf: 0, at: 0, all: 0 };
  for (const s of slips) {
    const lines = parse(s.lines);
    const pe = lineOf(lines, 'cnps_pension_emp'); const pr = lineOf(lines, 'cnps_pension_er'); const pf = lineOf(lines, 'cnps_family_er'); const at = lineOf(lines, 'cnps_accident_er');
    const all = pe.amount + pr.amount + pf.amount + at.amount;
    rows.push([month, s.cnps_no || '', s.employee_name, STATUS_FR[s.status] || s.status, s.gross, pe.basis || 0, pe.amount, pr.amount, pf.amount, at.amount, all]);
    tot.gross += s.gross; tot.capped += pe.basis || 0; tot.pe += pe.amount; tot.pr += pr.amount; tot.pf += pf.amount; tot.at += at.amount; tot.all += all;
  }
  rows.push([month, '', 'TOTAL', '', tot.gross, tot.capped, tot.pe, tot.pr, tot.pf, tot.at, tot.all]);
  rows.push([`Modèle ${M.versionFor(month).version} - ${M.WARNING}`]);
  sendCsv(res, `recapitulatif-cnps-${month}-document-de-travail.csv`, rows);
});

// État des retenues d'IRPP (avec CAC et CFC) : document de travail, pas la déclaration officielle.
router.get('/export/irpp.csv', async (req, res) => {
  const month = A.monthRange(req.query.month).month;
  const slips = await slipsOf(req.org.id, month);
  const rows = [[DOC_NOTICE], ['mois', 'niu', 'nom', 'statut_bulletin', 'salaire_brut', 'base_imposable_mensuelle', 'irpp', 'cac', 'cfc_salarie', 'total_retenues_fiscales']];
  const tot = { gross: 0, irpp: 0, cac: 0, cfc: 0, all: 0 };
  for (const s of slips) {
    const lines = parse(s.lines);
    const irpp = lineOf(lines, 'irpp'); const cac = lineOf(lines, 'cac'); const cfc = lineOf(lines, 'cfc_emp');
    const all = irpp.amount + cac.amount + cfc.amount;
    rows.push([month, s.niu || '', s.employee_name, STATUS_FR[s.status] || s.status, s.gross, irpp.basis || 0, irpp.amount, cac.amount, cfc.amount, all]);
    tot.gross += s.gross; tot.irpp += irpp.amount; tot.cac += cac.amount; tot.cfc += cfc.amount; tot.all += all;
  }
  rows.push([month, '', 'TOTAL', '', tot.gross, '', tot.irpp, tot.cac, tot.cfc, tot.all]);
  rows.push([`Modèle ${M.versionFor(month).version} - ${M.WARNING}`]);
  sendCsv(res, `etat-retenues-irpp-${month}-document-de-travail.csv`, rows);
});

/** Virements à faire : bulletins validés ou payés, net > 0, par canal (banque ou mobile money). */
async function transfersOf(req, month, channel) {
  const slips = (await slipsOf(req.org.id, month)).filter((s) => s.status !== 'draft' && s.net > 0);
  const rows = []; const missing = [];
  for (const s of slips) {
    const ch = s.pay_channel || '';
    if (channel && ch !== channel) { if (!ch) missing.push({ slipId: s.id, employee: s.employee_name, reason: 'canal de paiement non renseigné' }); continue; }
    if (!s.pay_account) { missing.push({ slipId: s.id, employee: s.employee_name, reason: 'compte ou numéro non renseigné' }); continue; }
    rows.push({ slipId: s.id, reference: `PAIE-${month.replace('-', '')}-${s.id}`, employee: s.employee_name, channel: ch, account: s.pay_account, amount: s.net, status: s.status });
  }
  return { rows, missing, total: rows.reduce((a, r) => a + r.amount, 0) };
}
router.get('/transfers', async (req, res) => {
  const month = A.monthRange(req.query.month).month;
  const channel = req.query.channel === 'bank' || req.query.channel === 'mobile' ? req.query.channel : '';
  res.json({ month, channel, ...(await transfersOf(req, month, channel)), notice: DOC_NOTICE });
});
router.get('/export/transfers.csv', async (req, res) => {
  const month = A.monthRange(req.query.month).month;
  const channel = A.oneOf(req.query.channel, ['bank', 'mobile'], undefined, 'Choisissez banque ou mobile money.');
  const t = await transfersOf(req, month, channel);
  const head = channel === 'bank' ? ['reference', 'beneficiaire', 'compte_bancaire', 'montant', 'devise', 'motif'] : ['reference', 'beneficiaire', 'numero_mobile_money', 'montant', 'devise', 'motif'];
  const rows = [head, ...t.rows.map((r) => [r.reference, r.employee, r.account, r.amount, req.org.currency, `Salaire ${month}`])];
  rows.push(['', 'TOTAL', '', t.total, req.org.currency, `${DOC_NOTICE} - à adapter au format exigé par votre banque ou opérateur`]);
  sendCsv(res, `virements-${channel === 'bank' ? 'banque' : 'mobile-money'}-${month}-document-de-travail.csv`, rows);
});

// ---------- Solde de tout compte (document de travail) ----------
const optAmount = (v) => (v === undefined || v === null || v === '' || Number(v) === 0 ? 0 : A.amount(v));

/** Calcule le solde de tout compte. Les indemnités de préavis et de licenciement sont SAISIES (barème de la convention collective : non calculé). */
async function computeSettlement(req, emp, b) {
  const exit = A.date(b.exitDate);
  if (!exit) throw new HttpError(400, 'Indiquez la date de sortie.');
  if (!(emp.salary > 0)) throw new HttpError(400, "Cet employé n'a pas de salaire de base enregistré.");
  const month = exit.slice(0, 7);
  const model = await loadModel(req.org.id, month);
  const v = model.values;
  const base = emp.salary;
  const divisor = v['absence.divisor'] > 0 ? v['absence.divisor'] : 30;
  const warnings = [M.WARNING, 'Les charges sociales et impôts sur ces éléments ne sont pas calculés ici : à faire avec un expert-comptable.'];
  const lines = [];
  // 1. Salaire du mois de sortie, au prorata (sauf si un bulletin existe déjà ce mois-là).
  const slip = await db.prepare('SELECT id FROM payroll_slips WHERE org_id = ? AND employee_id = ? AND month = ?').get(req.org.id, emp.id, month);
  const dayOfMonth = Math.min(Number(exit.slice(8, 10)), divisor);
  const prorata = slip ? 0 : Math.round(base * dayOfMonth / divisor);
  lines.push({ code: 'salary', label: slip ? `Salaire de ${month} : déjà couvert par le bulletin #${slip.id}` : `Salaire de ${month} au prorata (${dayOfMonth}/${divisor} jours)`, amount: prorata, meta: { month, days: dayOfMonth, divisor, slipId: slip ? slip.id : null } });
  // 2. Congés payés non pris.
  const startRef = emp.hired_at && emp.hired_at > `${exit.slice(0, 4)}-01-01` ? emp.hired_at : `${exit.slice(0, 4)}-01-01`;
  const monthsWorked = Math.max(Math.round(daysBetween(startRef, exit) / 30 * 2) / 2, 0);
  const accrued = Math.round(monthsWorked * (v['leave.daysPerMonth'] || 0) * 100) / 100;
  const taken = (await db.prepare(`SELECT start, "end" AS finish FROM leaves WHERE org_id = ? AND employee_id = ? AND kind = 'annual' AND status = 'approved' AND "end" >= ? AND start <= ?`).all(req.org.id, emp.id, startRef, exit))
    .reduce((a, l) => a + daysBetween(l.start > startRef ? l.start : startRef, l.finish < exit ? l.finish : exit), 0);
  const given = b.unusedLeaveDays !== undefined && b.unusedLeaveDays !== '' && b.unusedLeaveDays !== null ? Number(String(b.unusedLeaveDays).replace(',', '.')) : null;
  if (given !== null && (!Number.isFinite(given) || given < 0 || given > 365)) throw new HttpError(400, 'Nombre de jours de congé invalide.');
  const unused = given !== null ? given : Math.max(Math.round((accrued - taken) * 100) / 100, 0);
  const leaveAmount = Math.round(base * unused / divisor);
  lines.push({ code: 'leave', label: `Congés payés non pris : ${unused} jour(s)${given === null ? ` (acquis ${accrued} - pris ${taken})` : ' (saisi)'}`, amount: leaveAmount, meta: { days: unused, accrued, taken, given: given !== null } });
  // 3. Éléments saisis.
  const notice = optAmount(b.noticeIndemnity); const severance = optAmount(b.severance); const other = optAmount(b.otherDue);
  if (notice) lines.push({ code: 'notice', label: 'Indemnité de préavis (saisie)', amount: notice });
  if (severance) lines.push({ code: 'severance', label: 'Indemnité de licenciement (saisie)', amount: severance });
  if (other) lines.push({ code: 'other', label: A.text(b.otherLabel, 80) || 'Autre somme due (saisie)', amount: other });
  if (!notice && !severance) warnings.push('Préavis et indemnité de licenciement : non calculés (barème de la convention collective). Saisissez-les si elles sont dues.');
  const deductions = optAmount(b.deductions);
  const gross = lines.reduce((a, l) => a + l.amount, 0);
  return { month, exitDate: exit, base, divisor, lines, gross, deductions, total: Math.max(gross - deductions, 0), warnings, modelVersion: model.version };
}

router.post('/settlements', async (req, res) => {
  const b = req.body || {};
  const emp = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(A.id(b.employeeId, 'Employé invalide.'), req.org.id);
  if (!emp) throw new HttpError(404, 'Employé introuvable.');
  const data = await computeSettlement(req, emp, b);
  const reason = A.text(b.reason, 200);
  const id = (await db.prepare('INSERT INTO payroll_settlements (org_id, employee_id, employee_name, exit_date, reason, data, total, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, emp.id, emp.name, data.exitDate, reason, JSON.stringify(data), data.total, req.user.id, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Solde de tout compte (brouillon) préparé pour ${emp.name}`);
  res.status(201).json({ id: Number(id), ...data, employee: emp.name, reason, notice: DOC_NOTICE });
});
const settlementView = (s) => ({ id: s.id, employeeId: s.employee_id, employee: s.employee_name, exitDate: s.exit_date, reason: s.reason, total: s.total, createdAt: s.created_at, ...parse2(s.data), notice: DOC_NOTICE, status: 'document de travail' });
function parse2(s) { try { return JSON.parse(s); } catch { return {}; } }
router.get('/settlements', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM payroll_settlements WHERE org_id = ? ORDER BY id DESC LIMIT 100').all(req.org.id);
  res.json({ settlements: rows.map(settlementView), notice: DOC_NOTICE });
});
router.get('/settlements/:id', async (req, res) => {
  const s = await db.prepare('SELECT * FROM payroll_settlements WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Document introuvable.');
  res.json(settlementView(s));
});
router.delete('/settlements/:id', async (req, res) => {
  const r = await db.prepare('DELETE FROM payroll_settlements WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Document introuvable.');
  res.json({ ok: true });
});

module.exports = router;
module.exports.loadModel = loadModel;
module.exports.absenceFor = absenceFor;
module.exports.missingOf = missingOf;
module.exports.WARNING = M.WARNING;
