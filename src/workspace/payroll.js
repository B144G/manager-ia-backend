'use strict';
// Sous-application « Paie » (administrateurs et propriétaire) : paramètres de retenues et de charges (modifiables), bulletins de paie mensuels
// (brouillon → validé → payé, verrouillés après validation), lancement de la paie du mois, récapitulatif et lien vers le budget.
// Tous les montants sont des entiers (FCFA, sans décimales). Les taux fournis par défaut sont des EXEMPLES à vérifier : ce module ne connaît pas
// les barèmes officiels de votre pays. Il prépare et contrôle la paie ; il ne remplace ni un expert ni l'administration.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('admin'));

const DISCLAIMER = "Exemple à vérifier : barèmes à confirmer auprès de votre administration. Les taux ci-dessous ne sont pas officiels ; modifiez-les selon la réglementation de votre pays.";
const METHODS = { cash: 'Espèces', bank: 'Virement bancaire', mobile: 'Mobile money', cheque: 'Chèque' };
const MAX = 1e10; // plafond de sécurité par montant
const today = () => nowISO().slice(0, 10);

// Jeu d'exemple (non officiel) : proposé tant que l'organisation n'a pas enregistré ses propres paramètres.
const DEFAULT_RULES = [
  { kind: 'employee', label: 'Retenue sociale salariale (exemple)', rate: 4.2, ceiling: 750000 },
  { kind: 'employee', label: 'Impôt sur les salaires (exemple)', rate: 5, ceiling: 0 },
  { kind: 'employer', label: 'Cotisation sociale patronale (exemple)', rate: 11.2, ceiling: 750000 },
  { kind: 'employer', label: 'Taxe sur les salaires (exemple)', rate: 1, ceiling: 0 },
];

const money = (v, msg) => {
  const n = v === undefined || v === null || v === '' || Number(v) === 0 ? 0 : A.amount(v);
  if (n > MAX) throw new HttpError(400, msg || 'Montant trop élevé.');
  return n;
};

/** Valide la liste des lignes de retenues et de charges. */
function cleanRules(list) {
  if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'Liste de retenues invalide (20 lignes au plus).');
  return list.map((r) => {
    const b = r || {};
    const kind = A.oneOf(b.kind, ['employee', 'employer'], undefined, 'Type de ligne : retenue salariale ou charge patronale.');
    const label = A.text(b.label, 80, { required: true, msg: 'Chaque ligne doit avoir un nom.' });
    const rate = Number(typeof b.rate === 'string' ? b.rate.replace(/\s/g, '').replace(',', '.') : b.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new HttpError(400, `Taux invalide pour « ${label} » (0 à 100 %).`);
    return { kind, label, rate: Math.round(rate * 100) / 100, ceiling: money(b.ceiling === undefined ? 0 : b.ceiling, 'Plafond trop élevé.') };
  });
}

async function loadRules(orgId) {
  const row = await db.prepare('SELECT rules, updated_at FROM payroll_settings WHERE org_id = ?').get(orgId);
  if (!row) return { rules: DEFAULT_RULES, isDefault: true, updatedAt: null };
  let rules = [];
  try { rules = cleanRules(JSON.parse(row.rules)); } catch { rules = []; }
  return { rules, isDefault: false, updatedAt: row.updated_at };
}

/** Calcul d'un bulletin (entiers). Base de calcul des retenues = brut (base + primes + heures supplémentaires), limitée au plafond s'il y en a un. */
function computeSlip(rules, f) {
  const base = f.base || 0; const bonuses = f.bonuses || 0; const overtime = f.overtime || 0;
  const advances = f.advances || 0; const other = f.otherDeductions || 0;
  const gross = base + bonuses + overtime;
  const lines = rules.map((r) => {
    const basis = r.ceiling > 0 ? Math.min(gross, r.ceiling) : gross;
    return { kind: r.kind, label: r.label, rate: r.rate, ceiling: r.ceiling, basis, amount: Math.round(basis * r.rate / 100) };
  });
  const employeeDeductions = lines.filter((l) => l.kind === 'employee').reduce((a, l) => a + l.amount, 0);
  const employerCharges = lines.filter((l) => l.kind === 'employer').reduce((a, l) => a + l.amount, 0);
  const net = gross - employeeDeductions - other - advances;
  return { gross, employeeDeductions, employerCharges, net, employerCost: gross + employerCharges, lines };
}

const view = (s) => ({
  id: s.id, employeeId: s.employee_id, employee: s.employee_name, job: s.job, month: s.month, status: s.status,
  base: s.base, bonuses: s.bonuses, overtime: s.overtime, advances: s.advances, otherDeductions: s.other_deductions,
  gross: s.gross, employeeDeductions: s.employee_deductions, employerCharges: s.employer_charges, net: s.net, employerCost: s.employer_cost,
  lines: (() => { try { return JSON.parse(s.lines); } catch { return []; } })(), note: s.note,
  validatedAt: s.validated_at, paidDate: s.paid_date, payMethod: s.pay_method, payMethodLabel: METHODS[s.pay_method] || '', budgetEntryId: s.budget_entry_id,
});

const slipOf = async (req, id) => {
  const s = await db.prepare('SELECT * FROM payroll_slips WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!s) throw new HttpError(404, 'Bulletin introuvable.');
  return s;
};

const figures = (b, cur) => {
  const c = cur || {};
  const pick = (k, ck) => (b[k] === undefined ? (c[ck] || 0) : money(b[k]));
  return { base: pick('base', 'base'), bonuses: pick('bonuses', 'bonuses'), overtime: pick('overtime', 'overtime'), advances: pick('advances', 'advances'), otherDeductions: pick('otherDeductions', 'other_deductions') };
};

function checked(rules, f) {
  if (!(f.base > 0)) throw new HttpError(400, 'Le salaire de base doit être supérieur à zéro.');
  const c = computeSlip(rules, f);
  if (c.net < 0) throw new HttpError(400, 'Le net à payer serait négatif : vérifiez les avances et les retenues.');
  return c;
}

async function insertSlip(req, emp, month, f, rules, note) {
  const c = checked(rules, f);
  const id = (await db.prepare(`INSERT INTO payroll_slips (org_id, employee_id, employee_name, job, month, base, bonuses, overtime, advances, other_deductions, gross, employee_deductions, employer_charges, net, employer_cost, lines, note, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`).run(
    req.org.id, emp.id, emp.name, emp.job || '', month, f.base, f.bonuses, f.overtime, f.advances, f.otherDeductions, c.gross, c.employeeDeductions, c.employerCharges, c.net, c.employerCost, JSON.stringify(c.lines), note, req.user.id, nowISO())).lastInsertRowid;
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

router.get('/', async (req, res) => {
  const r = A.monthRange(req.query.month);
  const st = await loadRules(req.org.id);
  const o = await recap(req.org.id, r.month);
  res.json({ ...o, pending: o.counts.draft + o.counts.validated, settings: { rules: st.rules, isDefault: st.isDefault, disclaimer: DISCLAIMER }, methods: METHODS, currency: req.org.currency });
});

router.get('/settings', async (req, res) => {
  const st = await loadRules(req.org.id);
  res.json({ rules: st.rules, isDefault: st.isDefault, updatedAt: st.updatedAt, disclaimer: DISCLAIMER });
});

router.put('/settings', async (req, res) => {
  const rules = cleanRules((req.body || {}).rules);
  await db.transaction(async () => {
    await db.prepare('DELETE FROM payroll_settings WHERE org_id = ?').run(req.org.id);
    await db.prepare('INSERT INTO payroll_settings (org_id, rules, updated_at) VALUES (?, ?, ?)').run(req.org.id, JSON.stringify(rules), nowISO());
  })();
  await A.logActivity(req.org.id, req.user.id, 'payroll', 'Paramètres de paie modifiés');
  res.json({ ok: true, note: 'Les bulletins déjà validés ne changent pas ; les brouillons se recalculent à leur prochaine modification.' });
});

router.get('/slips', async (req, res) => res.json({ slips: (await recap(req.org.id, A.monthRange(req.query.month).month)).slips }));
router.get('/slips/:id', async (req, res) => res.json({ slip: view(await slipOf(req, req.params.id)), currency: req.org.currency }));

// Lancement de la paie du mois : un brouillon par employé actif qui a un salaire et pas encore de bulletin ce mois-ci.
router.post('/run', async (req, res) => {
  const month = A.monthRange((req.body || {}).month).month;
  const { rules } = await loadRules(req.org.id);
  const emps = await db.prepare("SELECT * FROM employees WHERE org_id = ? AND status = 'active' ORDER BY name").all(req.org.id);
  const out = { month, created: 0, existing: 0, noSalary: [] };
  await db.transaction(async () => {
    for (const e of emps) {
      if (await db.prepare('SELECT 1 FROM payroll_slips WHERE org_id = ? AND employee_id = ? AND month = ?').get(req.org.id, e.id, month)) { out.existing++; continue; }
      if (!(e.salary > 0)) { out.noSalary.push(e.name); continue; }
      await insertSlip(req, e, month, { base: Math.min(e.salary, MAX), bonuses: 0, overtime: 0, advances: 0, otherDeductions: 0 }, rules, '');
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
  const f = figures({ ...b, base: b.base === undefined || b.base === '' ? emp.salary : b.base }, null);
  const id = await insertSlip(req, emp, month, f, (await loadRules(req.org.id)).rules, A.text(b.note, 200));
  res.status(201).json({ id });
});

router.put('/slips/:id', async (req, res) => {
  const s = await slipOf(req, req.params.id);
  if (s.status !== 'draft') throw new HttpError(400, 'Ce bulletin est validé : il ne peut plus être modifié.');
  const b = req.body || {};
  const f = figures(b, s);
  const c = checked((await loadRules(req.org.id)).rules, f);
  await db.prepare(`UPDATE payroll_slips SET base = ?, bonuses = ?, overtime = ?, advances = ?, other_deductions = ?, gross = ?, employee_deductions = ?, employer_charges = ?, net = ?, employer_cost = ?, lines = ?, note = ? WHERE id = ? AND status = 'draft'`).run(
    f.base, f.bonuses, f.overtime, f.advances, f.otherDeductions, c.gross, c.employeeDeductions, c.employerCharges, c.net, c.employerCost, JSON.stringify(c.lines), b.note === undefined ? s.note : A.text(b.note, 200), s.id);
  res.json({ ok: true });
});

router.delete('/slips/:id', async (req, res) => {
  const s = await slipOf(req, req.params.id);
  if (s.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être supprimé.');
  await db.prepare("DELETE FROM payroll_slips WHERE id = ? AND status = 'draft'").run(s.id);
  res.json({ ok: true });
});

router.post('/slips/:id/validate', async (req, res) => {
  const s = await slipOf(req, req.params.id);
  if (s.status !== 'draft') throw new HttpError(400, 'Ce bulletin est déjà validé.');
  await db.prepare("UPDATE payroll_slips SET status = 'validated', validated_at = ?, validated_by = ? WHERE id = ? AND status = 'draft'").run(nowISO(), req.user.id, s.id);
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Bulletin de ${s.employee_name} (${s.month}) validé`);
  res.json({ ok: true });
});

router.post('/slips/:id/pay', async (req, res) => {
  const s = await slipOf(req, req.params.id);
  if (s.status === 'draft') throw new HttpError(400, "Validez d'abord le bulletin avant de le marquer payé.");
  if (s.status === 'paid') throw new HttpError(400, 'Ce bulletin est déjà payé.');
  const b = req.body || {};
  const method = A.oneOf(b.method, Object.keys(METHODS), undefined, 'Choisissez le mode de paiement.');
  const date = A.date(b.date) || today();
  await db.prepare("UPDATE payroll_slips SET status = 'paid', paid_date = ?, pay_method = ? WHERE id = ? AND status = 'validated'").run(date, method, s.id);
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Bulletin de ${s.employee_name} (${s.month}) payé`);
  res.json({ ok: true });
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
module.exports.DEFAULT_RULES = DEFAULT_RULES;

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
    st.isDefault ? 'ATTENTION : les taux de retenues sont encore ceux de l\'exemple par défaut (non vérifiés).' : `Paramètres de paie enregistrés : ${st.rules.map((r) => `${String(r.label).slice(0, 50)} ${r.rate} %`).join(' ; ').slice(0, 500)}.`,
    waiting.length ? 'Bulletins en attente :\n' + waiting.join('\n') : 'Aucun bulletin en attente.'].join('\n').slice(0, 2900);
};
module.exports.min = 'admin';
module.exports.prompt = `Tu aides l'administrateur à PRÉPARER et CONTRÔLER la paie : bulletins du mois, cohérence des montants (brut, retenues, net, coût employeur), employés oubliés, avances à déduire, bulletins à valider ou à payer.
Règles : les taux de retenues et de charges sont des paramètres modifiés par l'organisation ; s'ils sont encore « d'exemple », dis clairement qu'ils ne sont pas officiels. Tu ne donnes JAMAIS de conseil juridique, fiscal ou social définitif : pour un barème, un droit ou une obligation légale, renvoie vers l'administration du pays ou un expert. Ne divulgue des montants de paie qu'à cet administrateur. Tu ne modifies rien toi-même : explique ce qu'il faut faire dans le module.`;
