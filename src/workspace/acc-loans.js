'use strict';
// Comptabilité : emprunts. Tableau d'amortissement (annuités constantes ou amortissement constant), déblocage des fonds et chaque remboursement
// passés en écritures équilibrées par accounting.recordEntry() (une seule écriture par opération grâce à source + sourceId ; périodes clôturées respectées).
// Les écritures ne se modifient jamais : une erreur se corrige par une annulation. Réservé aux administrateurs (le routeur parent l'impose déjà).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');
const L = require('./acc-pro-lib');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting'); // require paresseux (évite toute dépendance circulaire)

const METHODS = ['annuity', 'constant_principal'];
const RECEIPT = { 521: 'BQ', 589: 'MM', 571: 'CA' }; // compte de réception ou de règlement → journal
const { addMonths, buildSchedule } = require('./acc-loan-schedule');

// Identifiant d'opération d'une échéance : id * 100 + numéro de tentative (1 à 99). La base n'accepte qu'une écriture par (source, identifiant), même annulée :
// après une annulation, la tentative suivante reçoit un nouvel identifiant, donc jamais de doublon actif.
const ATTEMPTS = 99;

/** Échéances déjà comptabilisées (écriture non annulée) : n° d'échéance → numéro de l'écriture. */
async function paidMap(orgId, loanId) {
  const rows = await db.prepare(`SELECT g.n, e.number FROM acc_loan_lines g JOIN acc_entries e ON e.org_id = ? AND e.source = 'loan_pay' AND e.source_id >= g.id * 100 AND e.source_id < g.id * 100 + 100
    WHERE g.loan_id = ? AND NOT EXISTS (SELECT 1 FROM acc_entries r WHERE r.org_id = e.org_id AND r.reversed_of = e.id)`).all(orgId, loanId);
  return new Map(rows.map((r) => [Number(r.n), r.number]));
}
async function disbursed(orgId, loanId) {
  const e = await db.prepare(`SELECT e.number FROM acc_entries e WHERE e.org_id = ? AND e.source = 'loan_disburse' AND e.source_id = ?
    AND NOT EXISTS (SELECT 1 FROM acc_entries r WHERE r.org_id = e.org_id AND r.reversed_of = e.id) LIMIT 1`).get(orgId, loanId);
  return e ? e.number : '';
}
async function view(org, ln, withLines) {
  const lines = (await db.prepare('SELECT * FROM acc_loan_lines WHERE loan_id = ? ORDER BY n').all(ln.id)).map((g) => ({ id: Number(g.id), n: Number(g.n), dueDate: g.due_date, principal: Number(g.principal), interest: Number(g.interest), balanceAfter: Number(g.balance_after) }));
  const paid = await paidMap(org.id, ln.id);
  const today = L.today();
  const done = lines.filter((g) => paid.has(g.n));
  const next = lines.find((g) => !paid.has(g.n));
  const out = {
    id: Number(ln.id), label: ln.label, lender: ln.lender, principal: Number(ln.principal), ratePct: Number(ln.rate_bp) / 100, months: Number(ln.months), method: ln.method,
    startDate: ln.start_date, firstDue: ln.first_due, disbursedEntry: await disbursed(org.id, ln.id),
    paidCount: done.length, outstanding: Number(ln.principal) - done.reduce((s, g) => s + g.principal, 0),
    paidInterest: done.reduce((s, g) => s + g.interest, 0), totalInterest: lines.reduce((s, g) => s + g.interest, 0),
    next: next ? { n: next.n, dueDate: next.dueDate, principal: next.principal, interest: next.interest, late: next.dueDate < today } : null,
  };
  if (withLines) out.lines = lines.map((g) => ({ ...g, entry: paid.get(g.n) || '', late: !paid.has(g.n) && g.dueDate < today }));
  return out;
}

router.get('/loans', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM acc_loans WHERE org_id = ? ORDER BY id DESC').all(req.org.id);
  const loans = []; for (const r of rows) loans.push(await view(req.org, r, false));
  res.json({ loans, outstanding: loans.reduce((s, l) => s + l.outstanding, 0) });
});

router.get('/loans/:id', async (req, res) => {
  const ln = await db.prepare('SELECT * FROM acc_loans WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!ln) throw new HttpError(404, 'Emprunt introuvable.');
  res.json(await view(req.org, ln, true));
});

router.post('/loans', async (req, res) => {
  const b = req.body || {};
  const label = A.text(b.label, 120, { required: true, msg: "Donnez un nom à l'emprunt (ex. Prêt de la banque X)." });
  const lender = A.text(b.lender, 120);
  const principal = A.amount(b.principal);
  const ratePct = Number(String(b.ratePct === undefined || b.ratePct === '' ? 0 : b.ratePct).replace(',', '.'));
  if (!(ratePct >= 0 && ratePct <= 60)) throw new HttpError(400, "Taux d'intérêt annuel invalide (0 à 60 %).");
  const months = Number(b.months);
  if (!Number.isInteger(months) || months < 1 || months > 360) throw new HttpError(400, 'La durée est un nombre entier de mois, de 1 à 360.');
  const method = A.oneOf(b.method, METHODS, 'annuity', 'Mode de remboursement : annuités constantes ou capital constant.');
  const startDate = A.date(b.startDate) || L.today();
  const firstDue = A.date(b.firstDue) || addMonths(startDate, 1);
  if (firstDue < startDate) throw new HttpError(400, "La première échéance ne peut pas précéder le déblocage des fonds.");
  const account = String(b.account === undefined || b.account === '' ? '521' : b.account);
  if (!RECEIPT[account]) throw new HttpError(400, 'Compte de réception des fonds : banque (521), mobile money (589) ou caisse (571).');
  const rateBp = Math.round(ratePct * 100);
  const rows = buildSchedule({ principal, rateBp, months, method, firstDue });
  const id = await db.transaction(async () => {
    const newId = (await db.prepare('INSERT INTO acc_loans (org_id, label, lender, principal, rate_bp, months, method, start_date, first_due, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, label, lender, principal, rateBp, months, method, startDate, firstDue, req.user.id, nowISO())).lastInsertRowid;
    const ins = db.prepare('INSERT INTO acc_loan_lines (loan_id, n, due_date, principal, interest, balance_after) VALUES (?, ?, ?, ?, ?, ?)');
    for (const g of rows) await ins.run(newId, g.n, g.dueDate, g.principal, g.interest, g.balanceAfter);
    return Number(newId);
  })();
  let entry = null;
  if (b.disburse !== false) { // déblocage des fonds : débit banque, crédit 162 ; si la période est clôturée, l'emprunt n'est pas créé
    try {
      entry = await accounting().recordEntry(req.org, req.user.id, { journal: RECEIPT[account], date: startDate, label: `Déblocage de l'emprunt : ${label}`.slice(0, 200), piece: `EMP-${id}`,
        lines: [{ account, debit: principal, memo: lender }, { account: '162', credit: principal, memo: label }], source: 'loan_disburse', sourceId: id });
    } catch (e) {
      await db.prepare('DELETE FROM acc_loans WHERE id = ? AND org_id = ?').run(id, req.org.id);
      throw e;
    }
  }
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Emprunt « ${label} » enregistré`);
  res.status(201).json({ id, entry: entry ? entry.number : '' });
});

/** Comptabilise une échéance : débit 162 (capital) et 671 (intérêts), crédit banque / caisse / mobile money. Les échéances se paient dans l'ordre. */
router.post('/loans/:id/pay', async (req, res) => {
  const ln = await db.prepare('SELECT * FROM acc_loans WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!ln) throw new HttpError(404, 'Emprunt introuvable.');
  const b = req.body || {};
  const account = String(b.account === undefined || b.account === '' ? '521' : b.account);
  if (!RECEIPT[account]) throw new HttpError(400, 'Compte de règlement : banque (521), mobile money (589) ou caisse (571).');
  const date = A.date(b.date) || L.today();
  const paid = await paidMap(req.org.id, ln.id);
  const lines = await db.prepare('SELECT * FROM acc_loan_lines WHERE loan_id = ? ORDER BY n').all(ln.id);
  const g = lines.find((x) => !paid.has(Number(x.n)));
  if (!g) throw new HttpError(400, 'Toutes les échéances de cet emprunt sont déjà comptabilisées.');
  if (!(await disbursed(req.org.id, ln.id))) throw new HttpError(400, "Les fonds de cet emprunt n'ont pas été comptabilisés : enregistrez d'abord leur déblocage.");
  const cap = Number(g.principal), itr = Number(g.interest);
  if (cap + itr <= 0) throw new HttpError(400, 'Cette échéance est nulle.');
  const entryLines = [];
  if (cap > 0) entryLines.push({ account: '162', debit: cap, memo: `Capital échéance ${g.n}/${ln.months}` });
  if (itr > 0) entryLines.push({ account: '671', debit: itr, memo: `Intérêts échéance ${g.n}/${ln.months}` });
  entryLines.push({ account, credit: cap + itr, memo: ln.label });
  const tried = Number((await db.prepare("SELECT COUNT(*) AS n FROM acc_entries WHERE org_id = ? AND source = 'loan_pay' AND source_id >= ? AND source_id < ?").get(req.org.id, Number(g.id) * 100, Number(g.id) * 100 + 100)).n);
  if (tried >= ATTEMPTS) throw new HttpError(400, 'Cette échéance a été comptabilisée puis annulée trop de fois : passez une écriture manuelle.');
  const r = await accounting().recordEntry(req.org, req.user.id, { journal: RECEIPT[account], date, label: `Emprunt ${ln.label} : échéance ${g.n}/${ln.months}`.slice(0, 200), piece: `EMP-${ln.id}-${g.n}`, lines: entryLines, source: 'loan_pay', sourceId: Number(g.id) * 100 + tried + 1 });
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Emprunt « ${ln.label} » : échéance ${g.n} comptabilisée`);
  res.status(201).json({ n: Number(g.n), entry: r.number, principal: cap, interest: itr });
});

module.exports = router;
