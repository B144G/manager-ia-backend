'use strict';
// Sous-application « Paie » (administrateurs et propriétaire) : paramètres de retenues et de charges (modifiables), bulletins de paie mensuels
// (brouillon → validé → payé, verrouillés après validation), lancement de la paie du mois, récapitulatif et lien vers le budget.
// Tous les montants sont des entiers (FCFA, sans décimales). Les taux fournis par défaut sont des EXEMPLES à vérifier : ce module ne connaît pas
// les barèmes officiels de votre pays. Il prépare et contrôle la paie ; il ne remplace ni un expert ni l'administration.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');
const TPL = require('./payroll-templates');
const CM = require('./payroll-cm');
const CMM = require('./payroll-cm-model');

const router = express.Router({ mergeParams: true });
router.use(A.need('admin'));
router.use('/cm', CM); // Paie Cameroun : modèle versionné, absences, solde de tout compte, états CSV (VAGUE 2)

const DISCLAIMER = "Exemple à vérifier : barèmes à confirmer auprès de votre administration. Les taux ci-dessous ne sont pas officiels ; modifiez-les selon la réglementation de votre pays.";
const METHODS = { cash: 'Espèces', bank: 'Virement bancaire', mobile: 'Mobile money', cheque: 'Chèque' };
const MAX = 1e10; // plafond de sécurité par montant
const today = () => nowISO().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const lastDayOf = (month) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const accounting = () => require('./accounting'); // require paresseux : pas de dépendance circulaire
/** Nature probable d'une ligne d'après son nom (impôt/taxe ou organisme social) : utilisée quand elle n'est pas précisée. */
const guessTarget = (label) => (/imp[oô]t|taxe|irpp|\bits\b|\bir\b|\bipr\b|iuts|contribution nationale|foncier/i.test(label || '') ? 'tax' : 'social');
const TARGETS = { social: 'Organisme social', tax: 'Impôt ou taxe' };
// Comptes SYSCOHADA utilisés pour l'écriture de paie (de base dans le plan comptable).
const ACC = { gross: '661', employerSocial: '664', employerTax: '641', social: '431', tax: '447', advances: '421', net: '422' };
const PAY_ACC = { cash: ['571', 'CA'], bank: ['521', 'BQ'], cheque: ['521', 'BQ'], mobile: ['589', 'MM'] };

// Jeu d'exemple (non officiel) : proposé tant que l'organisation n'a pas enregistré ses propres paramètres.
const DEFAULT_RULES = [
  { kind: 'employee', target: 'social', label: 'Retenue sociale salariale (exemple)', rate: 4.2, ceiling: 750000 },
  { kind: 'employee', target: 'tax', label: 'Impôt sur les salaires (exemple)', rate: 5, ceiling: 0 },
  { kind: 'employer', target: 'social', label: 'Cotisation sociale patronale (exemple)', rate: 11.2, ceiling: 750000 },
  { kind: 'employer', target: 'tax', label: 'Taxe sur les salaires (exemple)', rate: 1, ceiling: 0 },
];
const DEFAULT_OPTIONS = { autoAccount: false, monthlyHours: 173.33, tiers: TPL.DEFAULT_TIERS, ratesAsOf: '', templateId: '', engine: '', absenceAuto: false, cmValidation: null };

const money = (v, msg) => {
  const n = v === undefined || v === null || v === '' || Number(v) === 0 ? 0 : A.amount(v);
  if (n > MAX) throw new HttpError(400, msg || 'Montant trop élevé.');
  return n;
};

/** Valide la liste des lignes de retenues et de charges. Une ligne issue d'un modèle de pays peut rester « à compléter » (taux vide, todo). */
function cleanRules(list) {
  if (!Array.isArray(list) || list.length > 30) throw new HttpError(400, 'Liste de retenues invalide (30 lignes au plus).');
  return list.map((r) => {
    const b = r || {};
    const kind = A.oneOf(b.kind, ['employee', 'employer'], undefined, 'Type de ligne : retenue salariale ou charge patronale.');
    const label = A.text(b.label, 100, { required: true, msg: 'Chaque ligne doit avoir un nom.' });
    const target = A.oneOf(b.target, Object.keys(TARGETS), guessTarget(label), 'Nature de la ligne : organisme social ou impôt/taxe.');
    const blank = b.rate === undefined || b.rate === null || (typeof b.rate === 'string' && b.rate.trim() === '');
    if (blank && b.todo) return { kind, target, label, rate: 0, ceiling: money(b.ceiling === undefined ? 0 : b.ceiling, 'Plafond trop élevé.'), todo: true };
    const rate = Number(typeof b.rate === 'string' ? b.rate.replace(/\s/g, '').replace(',', '.') : (blank ? NaN : b.rate));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new HttpError(400, `Taux invalide pour « ${label} » (0 à 100 %).`);
    return { kind, target, label, rate: Math.round(rate * 100) / 100, ceiling: money(b.ceiling === undefined ? 0 : b.ceiling, 'Plafond trop élevé.') };
  });
}

/** Valide les options de paie (fusionnées avec les options actuelles). */
function cleanOptions(b, cur) {
  const o = { ...DEFAULT_OPTIONS, ...(cur || {}) };
  if (b === undefined || b === null) return o;
  if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Options de paie invalides.');
  if (b.autoAccount !== undefined) o.autoAccount = Boolean(b.autoAccount);
  if (b.monthlyHours !== undefined) {
    const h = Number(typeof b.monthlyHours === 'string' ? b.monthlyHours.replace(',', '.') : b.monthlyHours);
    if (!Number.isFinite(h) || h < 1 || h > 744) throw new HttpError(400, "Heures mensuelles de référence invalides (1 à 744).");
    o.monthlyHours = Math.round(h * 100) / 100;
  }
  if (b.tiers !== undefined) {
    if (!Array.isArray(b.tiers) || b.tiers.length > 8) throw new HttpError(400, 'Paliers invalides (8 au plus).');
    o.tiers = b.tiers.map((t) => {
      const rate = Number(typeof (t || {}).rate === 'string' ? t.rate.replace(',', '.') : (t || {}).rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 300) throw new HttpError(400, 'Majoration invalide (0 à 300 %).');
      return { label: A.text((t || {}).label, 60, { required: true, msg: 'Chaque palier doit avoir un nom.' }), rate: Math.round(rate * 100) / 100 };
    });
  }
  if (b.ratesAsOf !== undefined) o.ratesAsOf = A.date(b.ratesAsOf) || '';
  if (b.engine !== undefined) o.engine = b.engine ? A.oneOf(b.engine, ['cm'], undefined, 'Moteur de paie inconnu.') : '';
  if (b.absenceAuto !== undefined) o.absenceAuto = Boolean(b.absenceAuto);
  if (b.cmValidation !== undefined) o.cmValidation = b.cmValidation ? { by: A.text(b.cmValidation.by, 100), at: A.date(b.cmValidation.at) || '', note: A.text(b.cmValidation.note, 200) } : null;
  if (b.templateId !== undefined) o.templateId = b.templateId ? A.oneOf(b.templateId, TPL.TEMPLATES.map((t) => t.id), undefined, 'Modèle de pays inconnu.') : '';
  return o;
}

async function loadRules(orgId) {
  const row = await db.prepare('SELECT rules, options, updated_at FROM payroll_settings WHERE org_id = ?').get(orgId);
  if (!row) return { rules: DEFAULT_RULES, options: { ...DEFAULT_OPTIONS }, isDefault: true, updatedAt: null };
  let rules = [];
  try { rules = cleanRules(JSON.parse(row.rules)); } catch { rules = []; }
  let options = { ...DEFAULT_OPTIONS };
  try { options = cleanOptions(JSON.parse(row.options || '{}'), null); } catch { /* options abîmées : valeurs par défaut */ }
  const st = { rules, options, isDefault: false, updatedAt: row.updated_at };
  if (options.engine === 'cm') st.cm = await CM.loadModel(orgId, today().slice(0, 7));
  return st;
}

/** Enregistre des options de paie (fusionnées avec les options actuelles) en gardant les lignes de retenues. */
async function saveOptions(req, patch) {
  const cur = await loadRules(req.org.id);
  const options = cleanOptions(patch, cur.options);
  await db.transaction(async () => {
    await db.prepare('DELETE FROM payroll_settings WHERE org_id = ?').run(req.org.id);
    await db.prepare('INSERT INTO payroll_settings (org_id, rules, options, updated_at) VALUES (?, ?, ?, ?)').run(req.org.id, JSON.stringify(cur.rules), JSON.stringify(options), nowISO());
  })();
  return options;
}

/** Éléments à compléter avant de se fier aux calculs : rubriques sans taux, barème de modèle sans date de vérification. */
const incompleteOf = (st) => {
  const out = [];
  const n = st.rules.filter((r) => r.todo).length;
  if (n) out.push(`${n} rubrique(s) sans taux (« à compléter »).`);
  if (st.options.templateId && !st.options.ratesAsOf) out.push('Indiquez la date « à jour au » après avoir vérifié le barème de votre pays.');
  if (st.options.engine === 'cm') {
    if (!st.options.ratesAsOf) out.push("Barème Cameroun non validé : faites-le vérifier par un expert-comptable ou le CNPS/DGI, puis indiquez la date « à jour au ».");
    const miss = st.cm ? CM.missingOf(st.cm) : [];
    if (miss.length) out.push(`Barème Cameroun : ${miss.length} taux à renseigner (par exemple le taux accidents du travail).`);
  }
  return out;
};

const settingsView = (st) => ({ rules: st.rules, options: st.options, isDefault: st.isDefault, updatedAt: st.updatedAt, incomplete: incompleteOf(st), targets: TARGETS, disclaimer: DISCLAIMER });

/** Heures supplémentaires : montant = heures × taux horaire × (1 + majoration %). Le taux horaire est saisi, sinon salaire de base ÷ heures mensuelles de référence. */
function cleanHours(list) {
  if (!Array.isArray(list) || list.length > 10) throw new HttpError(400, "Heures supplémentaires invalides (10 lignes au plus).");
  return list.map((x) => {
    const rate = Number(typeof (x || {}).rate === 'string' ? x.rate.replace(',', '.') : (x || {}).rate);
    const hours = Number(typeof (x || {}).hours === 'string' ? x.hours.replace(/\s/g, '').replace(',', '.') : (x || {}).hours);
    if (!Number.isFinite(rate) || rate < 0 || rate > 300) throw new HttpError(400, 'Majoration invalide (0 à 300 %).');
    if (!Number.isFinite(hours) || hours <= 0 || hours > 400) throw new HttpError(400, "Nombre d'heures invalide (plus de 0 et 400 au plus).");
    return { rate: Math.round(rate * 100) / 100, hours: Math.round(hours * 100) / 100 };
  });
}
const overtimeAmount = (rows, hourly) => rows.map((r) => ({ ...r, hourly, amount: Math.round(r.hours * hourly * (1 + r.rate / 100)) }));

/** Calcul d'un bulletin (entiers). Base de calcul des retenues = brut (base + primes + heures supplémentaires + 13e mois/prime annuelle), limitée au plafond s'il y en a un. */
function computeSlip(rules, f, cm) {
  if (cm) return CMM.compute(cm, f); // modèle Cameroun (VAGUE 2) : même forme de résultat
  const base = f.base || 0; const bonuses = f.bonuses || 0; const overtime = f.overtime || 0; const annual = f.annualBonus || 0;
  const advances = f.advances || 0; const other = f.otherDeductions || 0;
  const gross = Math.max(base + bonuses + overtime + annual - (f.absenceDeduction || 0), 0);
  const lines = rules.map((r) => {
    const basis = r.ceiling > 0 ? Math.min(gross, r.ceiling) : gross;
    return { kind: r.kind, target: r.target || guessTarget(r.label), label: r.label, rate: r.rate, ceiling: r.ceiling, basis, amount: Math.round(basis * r.rate / 100) };
  });
  const employeeDeductions = lines.filter((l) => l.kind === 'employee').reduce((a, l) => a + l.amount, 0);
  const employerCharges = lines.filter((l) => l.kind === 'employer').reduce((a, l) => a + l.amount, 0);
  const net = gross - employeeDeductions - other - advances;
  return { gross, employeeDeductions, employerCharges, net, employerCost: gross + employerCharges, lines };
}

/** Nature d'une ligne de bulletin (les bulletins anciens n'ont pas de nature : on la déduit du nom). */
const targetOf = (l) => l.target || guessTarget(l.label);

const view = (s) => ({
  id: s.id, employeeId: s.employee_id, employee: s.employee_name, job: s.job, month: s.month, status: s.status,
  base: s.base, bonuses: s.bonuses, overtime: s.overtime, advances: s.advances, otherDeductions: s.other_deductions,
  gross: s.gross, employeeDeductions: s.employee_deductions, employerCharges: s.employer_charges, net: s.net, employerCost: s.employer_cost,
  lines: (() => { try { return JSON.parse(s.lines); } catch { return []; } })(), note: s.note,
  validatedAt: s.validated_at, paidDate: s.paid_date, payMethod: s.pay_method, payMethodLabel: METHODS[s.pay_method] || '', budgetEntryId: s.budget_entry_id,
  overtimeHours: (() => { try { return JSON.parse(s.overtime_hours); } catch { return []; } })(), hourlyRate: s.hourly_rate || 0, annualBonus: s.annual_bonus || 0, annualBonusLabel: s.annual_bonus_label || '',
  engine: s.engine || '', modelVersion: s.model_version || '', absenceDays: s.absence_days || 0, absenceDeduction: s.absence_deduction || 0,
  calcDetail: (() => { try { return s.calc_detail ? JSON.parse(s.calc_detail) : null; } catch { return null; } })(),
  accEntryId: s.acc_entry_id || null, accPayEntryId: s.acc_pay_entry_id || null, reopenedCount: s.reopened_count || 0, reopenReason: s.reopen_reason || '', reopenedAt: s.reopened_at || null,
});

const slipOf = async (req, id) => {
  const s = await db.prepare('SELECT * FROM payroll_slips WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!s) throw new HttpError(404, 'Bulletin introuvable.');
  return s;
};

/** Montants d'un bulletin à partir de la saisie (b) et de l'ancien bulletin (cur). opts = options de paie (heures mensuelles). */
const figures = (b, cur, opts) => {
  const c = cur || {};
  const pick = (k, ck) => (b[k] === undefined ? (c[ck] || 0) : money(b[k]));
  const base = pick('base', 'base');
  let hours = [];
  try { hours = JSON.parse(c.overtime_hours || '[]'); } catch { hours = []; }
  if (b.overtimeHours !== undefined) hours = cleanHours(b.overtimeHours);
  const hourlyRate = b.hourlyRate === undefined ? (c.hourly_rate || 0) : money(b.hourlyRate);
  let overtime = pick('overtime', 'overtime');
  if (hours.length) {
    const hourly = hourlyRate > 0 ? hourlyRate : Math.round(base / ((opts && opts.monthlyHours) || DEFAULT_OPTIONS.monthlyHours));
    hours = overtimeAmount(hours.map((h) => ({ rate: h.rate, hours: h.hours })), hourly);
    overtime = hours.reduce((a, h) => a + h.amount, 0);
  }
  let annualBonus = pick('annualBonus', 'annual_bonus');
  let annualLabel = b.annualBonusLabel === undefined ? (c.annual_bonus_label || '') : A.text(b.annualBonusLabel, 60);
  if (b.thirteenth === true && b.annualBonus === undefined) { annualBonus = base; annualLabel = annualLabel || '13e mois'; }
  if (b.thirteenth === false && b.annualBonus === undefined) { annualBonus = 0; annualLabel = ''; }
  if (annualBonus > 0 && !annualLabel) annualLabel = 'Prime annuelle';
  if (!(annualBonus > 0)) annualLabel = '';
  const absenceDeduction = b.absenceDeduction === undefined || b.absenceDeduction === '' ? (c.absence_deduction || 0) : Math.min(money(b.absenceDeduction), base);
  const absenceDays = b.absenceDays === undefined || b.absenceDays === '' ? (c.absence_days || 0) : Math.min(Math.max(Number(b.absenceDays) || 0, 0), 366);
  return { absenceDeduction, absenceDays, base, bonuses: pick('bonuses', 'bonuses'), overtime, overtimeHours: hours, hourlyRate, annualBonus, annualBonusLabel: annualLabel, advances: pick('advances', 'advances'), otherDeductions: pick('otherDeductions', 'other_deductions') };
};

/** Contexte de calcul : modèle Cameroun du mois (si activé) et retenue automatique des absences non payées (sauf montant saisi). */
async function context(req, st, empId, month, b, f) {
  const cm = st.options.engine === 'cm' || st.options.absenceAuto ? await CM.loadModel(req.org.id, month) : null;
  if (st.options.absenceAuto && (b.absenceDeduction === undefined || b.absenceDeduction === '')) {
    const a = await CM.absenceFor(req.org.id, empId, month, f.base, cm ? cm.values['absence.divisor'] : 30);
    f.absenceDays = a.days; f.absenceDeduction = a.deduction;
  }
  return st.options.engine === 'cm' ? cm : null;
}

function checked(rules, f, cm) {
  if (!(f.base > 0)) throw new HttpError(400, 'Le salaire de base doit être supérieur à zéro.');
  const c = computeSlip(rules, f, cm);
  if (c.net < 0) throw new HttpError(400, 'Le net à payer serait négatif : vérifiez les avances et les retenues.');
  return c;
}

async function insertSlip(req, emp, month, f, rules, note, cm) {
  const c = checked(rules, f, cm);
  const id = (await db.prepare(`INSERT INTO payroll_slips (org_id, employee_id, employee_name, job, month, base, bonuses, overtime, advances, other_deductions, gross, employee_deductions, employer_charges, net, employer_cost, lines, note, status, created_by, created_at, overtime_hours, hourly_rate, annual_bonus, annual_bonus_label, engine, model_version, absence_days, absence_deduction, calc_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.org.id, emp.id, emp.name, emp.job || '', month, f.base, f.bonuses, f.overtime, f.advances, f.otherDeductions, c.gross, c.employeeDeductions, c.employerCharges, c.net, c.employerCost, JSON.stringify(c.lines), note, req.user.id, nowISO(),
    JSON.stringify(f.overtimeHours || []), f.hourlyRate || 0, f.annualBonus || 0, f.annualBonusLabel || '', cm ? 'cm' : '', cm ? cm.version : '', f.absenceDays || 0, f.absenceDeduction || 0, c.detail ? JSON.stringify(c.detail) : '')).lastInsertRowid;
  return Number(id);
}

/** Récapitulatif d'un mois : totaux, bulletins, employés actifs sans bulletin. */
async function recap(orgId, month) {
  const slips = (await db.prepare('SELECT * FROM payroll_slips WHERE org_id = ? AND month = ? ORDER BY employee_name, id').all(orgId, month)).map(view);
  const sum = (k) => slips.reduce((a, s) => a + s[k], 0);
  const have = new Set(slips.map((s) => s.employeeId));
  const missing = (await db.prepare("SELECT id, name, salary FROM employees WHERE org_id = ? AND status = 'active' ORDER BY name").all(orgId)).filter((e) => !have.has(e.id)).map((e) => ({ id: e.id, name: e.name, salary: e.salary || 0 }));
  return {
    month, slips, missing,
    totals: { gross: sum('gross'), employeeDeductions: sum('employeeDeductions'), advances: sum('advances'), net: sum('net'), employerCharges: sum('employerCharges'), employerCost: sum('employerCost') },
    counts: { draft: slips.filter((s) => s.status === 'draft').length, validated: slips.filter((s) => s.status === 'validated').length, paid: slips.filter((s) => s.status === 'paid').length },
  };
}

// ---------- Comptabilisation (écritures automatiques ou à la demande) ----------
/** Lignes de l'écriture de validation : charges de personnel (661, 664, 641) contre organismes sociaux (431), impôts retenus (447), personnel (421, 422). */
function validationLines(s) {
  let lines = [];
  try { lines = JSON.parse(s.lines); } catch { lines = []; }
  const sum = (kind, target) => lines.filter((l) => l.kind === kind && targetOf(l) === target).reduce((a, l) => a + l.amount, 0);
  const socEmp = sum('employee', 'social'); const taxEmp = sum('employee', 'tax'); const socEr = sum('employer', 'social'); const taxEr = sum('employer', 'tax');
  const out = [];
  const add = (account, side, amount, memo) => { if (amount > 0) out.push({ account, [side]: amount, memo }); };
  add(ACC.gross, 'debit', s.gross, `Rémunération brute ${s.employee_name}`);
  add(ACC.employerSocial, 'debit', socEr, 'Charges sociales patronales');
  add(ACC.employerTax, 'debit', taxEr, 'Taxes patronales sur salaires');
  add(ACC.social, 'credit', socEmp + socEr, 'Organismes sociaux');
  add(ACC.tax, 'credit', taxEmp + taxEr, 'Impôts retenus et taxes sur salaires');
  add(ACC.advances, 'credit', (s.advances || 0) + (s.other_deductions || 0), 'Avances et retenues diverses');
  add(ACC.net, 'credit', s.net, `Net à payer ${s.employee_name}`);
  return out;
}

/** Une écriture par événement : la réservation atomique (acc_entry_id = 0) empêche les doublons même si deux requêtes arrivent ensemble. */
async function accountEvent(req, s, kind, dateOverride) {
  const col = kind === 'validate' ? 'acc_entry_id' : 'acc_pay_entry_id';
  if (s[col]) return { event: kind, status: 'exists', entryId: s[col] };
  let entry;
  if (kind === 'validate') {
    entry = { journal: 'OD', date: dateOverride || lastDayOf(s.month), label: `Paie ${s.month} - ${s.employee_name}`, piece: `PAIE-${s.id}`, lines: validationLines(s), source: s.reopened_count > 0 ? `payroll-r${s.reopened_count}` : 'payroll', sourceId: s.id }; // un bulletin rouvert puis revalidé reçoit une nouvelle écriture (l'index unique impose une clé par écriture)
  } else {
    if (!(s.net > 0)) return { event: kind, status: 'none', reason: 'Net à payer nul : aucune écriture de paiement.' };
    const [account, journal] = PAY_ACC[s.pay_method] || PAY_ACC.bank;
    entry = { journal, date: dateOverride || s.paid_date || today(), label: `Paiement salaire ${s.month} - ${s.employee_name}`, piece: `PAIE-${s.id}`, lines: [{ account: ACC.net, debit: s.net, memo: s.employee_name }, { account, credit: s.net }], source: 'payroll_pay', sourceId: s.id };
  }
  const claim = await db.prepare(`UPDATE payroll_slips SET ${col} = 0 WHERE id = ? AND org_id = ? AND ${col} IS NULL`).run(s.id, req.org.id);
  if (!claim.changes) return { event: kind, status: 'busy', reason: "Une comptabilisation est déjà en cours pour ce bulletin." };
  try {
    const r = await accounting().recordEntry(req.org, req.user.id, entry);
    await db.prepare(`UPDATE payroll_slips SET ${col} = ? WHERE id = ?`).run(r.id, s.id);
    return { event: kind, status: r.existing ? 'exists' : 'posted', entryId: r.id, number: r.number };
  } catch (e) {
    await db.prepare(`UPDATE payroll_slips SET ${col} = NULL WHERE id = ? AND ${col} = 0`).run(s.id);
    if (e instanceof HttpError) return { event: kind, status: 'skipped', reason: e.message };
    throw e;
  }
}

router.get('/', async (req, res) => {
  const r = A.monthRange(req.query.month);
  const st = await loadRules(req.org.id);
  const o = await recap(req.org.id, r.month);
  res.json({ ...o, pending: o.counts.draft + o.counts.validated, settings: settingsView(st), methods: METHODS, currency: req.org.currency });
});

router.get('/settings', async (req, res) => res.json(settingsView(await loadRules(req.org.id))));

router.get('/templates', (req, res) => res.json({ templates: TPL.TEMPLATES.map(TPL.view), notice: TPL.NOTICE, tiers: TPL.DEFAULT_TIERS,
  warning: "Ces modèles sont des points de départ : ils ne contiennent aucun taux officiel. Complétez chaque rubrique d'après les textes de votre pays, puis indiquez la date « à jour au »." }));

router.put('/settings', async (req, res) => {
  const b = req.body || {};
  const cur = await loadRules(req.org.id);
  const rules = b.rules === undefined ? cur.rules : cleanRules(b.rules);
  const options = cleanOptions(b.options, cur.options);
  await db.transaction(async () => {
    await db.prepare('DELETE FROM payroll_settings WHERE org_id = ?').run(req.org.id);
    await db.prepare('INSERT INTO payroll_settings (org_id, rules, options, updated_at) VALUES (?, ?, ?, ?)').run(req.org.id, JSON.stringify(rules), JSON.stringify(options), nowISO());
  })();
  await A.logActivity(req.org.id, req.user.id, 'payroll', 'Paramètres de paie modifiés' + (options.autoAccount !== cur.options.autoAccount ? ` (comptabilisation automatique ${options.autoAccount ? 'activée' : 'désactivée'})` : ''));
  res.json({ ok: true, incomplete: incompleteOf({ rules, options }), note: 'Les bulletins déjà validés ne changent pas ; les brouillons se recalculent à leur prochaine modification.' });
});

router.get('/slips', async (req, res) => res.json({ slips: (await recap(req.org.id, A.monthRange(req.query.month).month)).slips }));
router.get('/slips/:id', async (req, res) => res.json({ slip: view(await slipOf(req, req.params.id)), currency: req.org.currency }));

// Lancement de la paie du mois : un brouillon par employé actif qui a un salaire et pas encore de bulletin ce mois-ci.
router.post('/run', async (req, res) => {
  const month = A.monthRange((req.body || {}).month).month;
  const st = await loadRules(req.org.id);
  const { rules } = st;
  const emps = await db.prepare("SELECT * FROM employees WHERE org_id = ? AND status = 'active' ORDER BY name").all(req.org.id);
  const out = { month, created: 0, existing: 0, noSalary: [] };
  await db.transaction(async () => {
    for (const e of emps) {
      if (await db.prepare('SELECT 1 FROM payroll_slips WHERE org_id = ? AND employee_id = ? AND month = ?').get(req.org.id, e.id, month)) { out.existing++; continue; }
      if (!(e.salary > 0)) { out.noSalary.push(e.name); continue; }
      const f0 = { base: Math.min(e.salary, MAX), bonuses: 0, overtime: 0, overtimeHours: [], hourlyRate: 0, annualBonus: 0, annualBonusLabel: '', advances: 0, otherDeductions: 0, absenceDeduction: 0, absenceDays: 0 };
      const cm = await context(req, st, e.id, month, {}, f0);
      await insertSlip(req, e, month, f0, rules, '', cm);
      out.created++;
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Paie de ${month} lancée : ${out.created} brouillon(s)`);
  res.status(201).json(out);
});

router.post('/slips', async (req, res) => {
  const b = req.body || {};
  const month = A.monthRange(b.month).month;
  const emp = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(A.id(b.employeeId, 'Employé invalide.'), req.org.id);
  if (!emp) throw new HttpError(404, 'Employé introuvable.');
  if (await db.prepare('SELECT 1 FROM payroll_slips WHERE org_id = ? AND employee_id = ? AND month = ?').get(req.org.id, emp.id, month)) throw new HttpError(409, 'Cet employé a déjà un bulletin pour ce mois.');
  const st = await loadRules(req.org.id);
  const f = figures({ ...b, base: b.base === undefined || b.base === '' ? emp.salary : b.base }, null, st.options);
  const cm = await context(req, st, emp.id, month, b, f);
  const id = await insertSlip(req, emp, month, f, st.rules, A.text(b.note, 200), cm);
  res.status(201).json({ id });
});

router.put('/slips/:id', async (req, res) => {
  const s = await slipOf(req, req.params.id);
  if (s.status !== 'draft') throw new HttpError(400, 'Ce bulletin est validé : il ne peut plus être modifié. Un administrateur peut le rouvrir (avec un motif) tant qu\'il n\'est pas payé.');
  const b = req.body || {};
  const st = await loadRules(req.org.id);
  const f = figures(b, s, st.options);
  const cm = await context(req, st, s.employee_id, s.month, b, f);
  const c = checked(st.rules, f, cm);
  await db.prepare(`UPDATE payroll_slips SET base = ?, bonuses = ?, overtime = ?, advances = ?, other_deductions = ?, gross = ?, employee_deductions = ?, employer_charges = ?, net = ?, employer_cost = ?, lines = ?, note = ?,
    overtime_hours = ?, hourly_rate = ?, annual_bonus = ?, annual_bonus_label = ?, engine = ?, model_version = ?, absence_days = ?, absence_deduction = ?, calc_detail = ? WHERE id = ? AND status = 'draft'`).run(
    f.base, f.bonuses, f.overtime, f.advances, f.otherDeductions, c.gross, c.employeeDeductions, c.employerCharges, c.net, c.employerCost, JSON.stringify(c.lines), b.note === undefined ? s.note : A.text(b.note, 200),
    JSON.stringify(f.overtimeHours || []), f.hourlyRate || 0, f.annualBonus || 0, f.annualBonusLabel || '', cm ? 'cm' : '', cm ? cm.version : '', f.absenceDays || 0, f.absenceDeduction || 0, c.detail ? JSON.stringify(c.detail) : '', s.id);
  res.json({ ok: true });
});

router.delete('/slips/:id', async (req, res) => {
  const s = await slipOf(req, req.params.id);
  if (s.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être supprimé.');
  await db.prepare("DELETE FROM payroll_slips WHERE id = ? AND status = 'draft'").run(s.id);
  res.json({ ok: true });
});

router.post('/slips/:id/validate', async (req, res) => {
  let s = await slipOf(req, req.params.id);
  if (s.status !== 'draft') throw new HttpError(400, 'Ce bulletin est déjà validé.');
  const ok = await db.prepare("UPDATE payroll_slips SET status = 'validated', validated_at = ?, validated_by = ? WHERE id = ? AND status = 'draft'").run(nowISO(), req.user.id, s.id);
  if (!ok.changes) throw new HttpError(400, 'Ce bulletin est déjà validé.');
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Bulletin de ${s.employee_name} (${s.month}) validé`);
  const st = await loadRules(req.org.id);
  const out = { ok: true, accounting: null, warnings: incompleteOf(st) };
  if (st.options.autoAccount) {
    s = await slipOf(req, s.id);
    out.accounting = await accountEvent(req, s, 'validate');
    if (out.accounting.status === 'posted') await A.logActivity(req.org.id, req.user.id, 'payroll', `Écriture ${out.accounting.number} : paie de ${s.employee_name} (${s.month})`);
  }
  res.json(out);
});

router.post('/slips/:id/pay', async (req, res) => {
  let s = await slipOf(req, req.params.id);
  if (s.status === 'draft') throw new HttpError(400, "Validez d'abord le bulletin avant de le marquer payé.");
  if (s.status === 'paid') throw new HttpError(400, 'Ce bulletin est déjà payé.');
  const b = req.body || {};
  const method = A.oneOf(b.method, Object.keys(METHODS), undefined, 'Choisissez le mode de paiement.');
  const date = A.date(b.date) || today();
  const ok = await db.prepare("UPDATE payroll_slips SET status = 'paid', paid_date = ?, pay_method = ? WHERE id = ? AND status = 'validated'").run(date, method, s.id);
  if (!ok.changes) throw new HttpError(400, 'Ce bulletin est déjà payé.');
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Bulletin de ${s.employee_name} (${s.month}) payé`);
  const out = { ok: true, accounting: null };
  if ((await loadRules(req.org.id)).options.autoAccount) {
    s = await slipOf(req, s.id);
    const v = await accountEvent(req, s, 'validate'); // au cas où la validation n'avait pas été comptabilisée (option activée après coup)
    s = await slipOf(req, s.id);
    const p = await accountEvent(req, s, 'pay');
    out.accounting = { validation: v, payment: p };
    if (p.status === 'posted') await A.logActivity(req.org.id, req.user.id, 'payroll', `Écriture ${p.number} : paiement de ${s.employee_name} (${s.month})`);
  }
  res.json(out);
});

// Comptabilisation à la demande (ou rattrapage) : crée les écritures manquantes, jamais en double.
router.post('/slips/:id/accounting', async (req, res) => {
  let s = await slipOf(req, req.params.id);
  if (s.status === 'draft') throw new HttpError(400, "Validez d'abord le bulletin avant de le comptabiliser.");
  const date = A.date((req.body || {}).date) || undefined;
  const out = { validation: await accountEvent(req, s, 'validate', date) };
  if (s.status === 'paid') { s = await slipOf(req, s.id); out.payment = await accountEvent(req, s, 'pay'); }
  const bad = [out.validation, out.payment].find((x) => x && (x.status === 'skipped' || x.status === 'busy'));
  if (bad) throw new HttpError(400, `Écriture non enregistrée : ${bad.reason}`);
  const made = [out.validation, out.payment].filter((x) => x && x.status === 'posted');
  if (made.length) await A.logActivity(req.org.id, req.user.id, 'payroll', `Bulletin de ${s.employee_name} (${s.month}) comptabilisé (${made.map((x) => x.number).join(', ')})`);
  res.status(made.length ? 201 : 200).json({ ok: true, ...out });
});

// Réouverture d'un bulletin validé mais non payé : motif obligatoire, contre-passation de l'écriture, journal d'activité et journal d'audit.
router.post('/slips/:id/reopen', async (req, res) => {
  const s = await slipOf(req, req.params.id);
  const reason = A.text((req.body || {}).reason, 200, { required: true, msg: 'Indiquez le motif de la réouverture.' });
  if (reason.length < 5) throw new HttpError(400, 'Le motif de la réouverture est trop court (5 caractères au moins).');
  if (s.status === 'draft') throw new HttpError(400, "Ce bulletin est déjà un brouillon.");
  if (s.status === 'paid') throw new HttpError(400, "Un bulletin payé ne peut pas être rouvert. Corrigez-le sur le bulletin du mois suivant.");
  if (s.budget_entry_id) throw new HttpError(409, "Ce bulletin est enregistré au budget : supprimez d'abord cette ligne dans le module Budget, puis rouvrez le bulletin.");
  const claim = await db.prepare("UPDATE payroll_slips SET status = 'draft' WHERE id = ? AND org_id = ? AND status = 'validated'").run(s.id, req.org.id);
  if (!claim.changes) throw new HttpError(409, 'Ce bulletin vient de changer : rechargez la page.');
  let reversal = null;
  try {
    if (s.acc_entry_id) reversal = await accounting().reverseEntry(req.org, req.user.id, Number(s.acc_entry_id), today());
  } catch (e) {
    await db.prepare("UPDATE payroll_slips SET status = 'validated' WHERE id = ? AND status = 'draft'").run(s.id);
    throw e instanceof HttpError && e.status !== 409 ? new HttpError(400, `Réouverture impossible : l'annulation de l'écriture comptable a échoué (${e.message})`) : e;
  }
  await db.prepare(`UPDATE payroll_slips SET validated_at = NULL, validated_by = NULL, acc_entry_id = NULL, reopened_count = reopened_count + 1, reopen_reason = ?, reopened_at = ?, reopened_by = ? WHERE id = ?`).run(reason, nowISO(), req.user.id, s.id);
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Bulletin de ${s.employee_name} (${s.month}) rouvert : ${reason}`);
  try {
    await require('../security/audit').record(req, 'payroll.slip_reopen', { orgId: req.org.id, target: `payroll_slip:${s.id}`, severity: 'warn', detail: `${s.month} ${s.employee_name} : ${reason}${reversal ? ' ; écriture annulée ' + reversal.reversed : ''}` });
  } catch { /* le journal d'audit ne doit jamais bloquer */ }
  res.json({ ok: true, reversedEntry: reversal ? reversal.reversed : null });
});

// Au budget : une ligne de sortie « Salaires » (coût total employeur), une seule fois par bulletin.
router.post('/slips/:id/budget', async (req, res) => {
  const s = await slipOf(req, req.params.id);
  if (s.status === 'draft') throw new HttpError(400, "Validez d'abord le bulletin.");
  if (s.budget_entry_id) throw new HttpError(409, 'Ce bulletin est déjà enregistré au budget.');
  if (!(s.employer_cost > 0)) throw new HttpError(400, 'Montant nul : rien à enregistrer.');
  const date = s.paid_date || today();
  let id;
  await db.transaction(async () => {
    const lock = await db.prepare('UPDATE payroll_slips SET budget_entry_id = 0 WHERE id = ? AND budget_entry_id IS NULL').run(s.id);
    if (!lock.changes) throw new HttpError(409, 'Ce bulletin est déjà enregistré au budget.');
    id = Number((await db.prepare('INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)').run(
      req.org.id, 'expense', 'Salaires', `Paie ${s.month} - ${s.employee_name}`.slice(0, 150), s.employer_cost, date, req.user.id, nowISO())).lastInsertRowid);
    await db.prepare('UPDATE payroll_slips SET budget_entry_id = ? WHERE id = ?').run(id, s.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Bulletin de ${s.employee_name} (${s.month}) enregistré au budget`);
  res.status(201).json({ ok: true, budgetEntryId: id });
});

module.exports = router;
module.exports.computeSlip = computeSlip;
module.exports.loadRules = loadRules;
module.exports.saveOptions = saveOptions;
module.exports.DEFAULT_RULES = DEFAULT_RULES;
module.exports.validationLines = validationLines;

// Crochets lus par ai.js : ctx(req) = ce que l'IA voit (réservé aux administrateurs : aucun montant de paie pour un rôle inférieur).
module.exports.ctx = async (req) => {
  if (!A.can(req, 'admin')) return '';
  const month = nowISO().slice(0, 7);
  const o = await recap(req.org.id, month);
  const cur = req.org.currency;
  const f = (n) => `${Number(n).toLocaleString('fr-FR')} ${cur}`;
  const st = await loadRules(req.org.id);
  const waiting = o.slips.filter((s) => s.status !== 'paid').slice(0, 15).map((s) => `- ${String(s.employee).slice(0, 50)} : ${s.status === 'draft' ? 'brouillon' : 'validé, à payer'}, net ${f(s.net)}`);
  return [`PAIE ${month} : ${o.slips.length} bulletin(s) (${o.counts.draft} brouillon, ${o.counts.validated} validé, ${o.counts.paid} payé). Salaires bruts ${f(o.totals.gross)}, net à payer ${f(o.totals.net)}, coût total employeur ${f(o.totals.employerCost)}.`,
    `Employés actifs sans bulletin ce mois : ${o.missing.length}${o.missing.length ? ' (' + o.missing.slice(0, 10).map((e) => String(e.name).slice(0, 40)).join(', ') + ')' : ''}.`,
    st.options.autoAccount ? 'Comptabilisation automatique de la paie : activée.' : 'Comptabilisation automatique de la paie : désactivée (écritures à la demande).',
    ...incompleteOf(st).map((x) => 'À COMPLÉTER : ' + x),
    st.options.engine === 'cm' ? `MODÈLE CAMEROUN actif (version ${st.cm.version}, barème du ${st.cm.asOf}) : ${st.options.ratesAsOf ? `vérifié par ${(st.options.cmValidation || {}).by || 'une tierce personne'} (à jour au ${st.options.ratesAsOf})` : 'NON VALIDÉ par un expert-comptable ou le CNPS/DGI'}. Absences non payées déduites automatiquement : ${st.options.absenceAuto ? 'oui' : 'non'}.` : '',
    st.isDefault ? 'ATTENTION : les taux de retenues sont encore ceux de l\'exemple par défaut (non vérifiés).' : `Paramètres de paie enregistrés : ${st.rules.map((r) => `${String(r.label).slice(0, 50)} ${r.rate} %`).join(' ; ').slice(0, 500)}.`,
    waiting.length ? 'Bulletins en attente :\n' + waiting.join('\n') : 'Aucun bulletin en attente.'].join('\n').slice(0, 2900);
};
module.exports.min = 'admin';
module.exports.prompt = `Tu aides l'administrateur à PRÉPARER et CONTRÔLER la paie : bulletins du mois, cohérence des montants (brut, retenues, net, coût employeur), employés oubliés, avances à déduire, bulletins à valider ou à payer.
Règles : les taux de retenues et de charges sont des paramètres modifiés par l'organisation ; s'ils sont encore « d'exemple », dis clairement qu'ils ne sont pas officiels. Tu ne donnes JAMAIS de conseil juridique, fiscal ou social définitif : pour un barème, un droit ou une obligation légale, renvoie vers l'administration du pays ou un expert. Les barèmes par pays sont des points de départ à compléter (aucun taux n'est fourni) : rappelle de vérifier chaque taux et la date « à jour au ». La comptabilisation automatique de la paie est une option : sans elle, les écritures se créent à la demande. Un bulletin validé peut être rouvert avec un motif tant qu'il n'est pas payé. Le modèle de paie Cameroun (CNPS, IRPP progressif, CAC, CFC, FNE) est chiffré mais n'est JAMAIS officiel : cite toujours son niveau de confiance et la mention « à faire valider par un expert-comptable ou le CNPS/DGI » ; le solde de tout compte, le récapitulatif CNPS, l'état IRPP et le fichier de virement sont des documents de travail. Une absence « sans solde » approuvée dans les RH se déduit automatiquement du bulletin. Ne divulgue des montants de paie qu'à cet administrateur. Tu ne modifies rien toi-même : explique ce qu'il faut faire dans le module.`;
