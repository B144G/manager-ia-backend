'use strict';
// Comptabilité pro (2/4) : clôture annuelle. Détermination du résultat (journal OD, au 31/12), écritures d'à-nouveaux (journal AN, au 01/01 suivant)
// et verrouillage de la période. Réouverture réservée au propriétaire, par écritures inverses, avec motif. Document de travail à faire valider par
// un expert-comptable : l'affectation du résultat (réserves, report à nouveau, dividendes) reste une décision d'assemblée à saisir à la main.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');
const L = require('./acc-pro-lib');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting');
const LINES_MAX = 1000; // une écriture de clôture ou d'à-nouveaux regroupe tous les comptes (au-delà des 50 lignes d'une saisie manuelle)
const NOTES = [
  "La clôture solde les comptes de gestion (classes 6, 7 et 8) vers le compte 131 (bénéfice) ou 139 (perte), reporte les soldes du bilan dans le journal À-nouveaux au 1er janvier suivant, puis verrouille l'exercice.",
  "L'affectation du résultat (réserves, report à nouveau, dividendes) n'est pas passée : elle se décide en assemblée et se saisit en opération diverse.",
  'Document de travail : à faire valider par un expert-comptable avant toute utilisation officielle.',
];

const yearParam = (v) => {
  if (v === undefined || v === null || v === '') throw new HttpError(400, "Indiquez l'année de l'exercice.");
  return L.yearOf(v);
};
const stateOf = async (orgId, year) => await db.prepare('SELECT * FROM acc_year_ends WHERE org_id = ? AND year = ?').get(orgId, String(year));
const parseIds = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; } };

/** Calcule tout ce que la clôture écrirait, sans rien écrire. */
async function compute(req, year) {
  const org = req.org; const start = `${year}-01-01`; const end = `${year}-12-31`;
  const st = await stateOf(org.id, year); const closed = Boolean(st && st.status === 'closed');
  // Résultat de l'exercice (comme statements) : mouvements de l'année, sans l'écriture de clôture elle-même.
  const yr = await L.balances(org.id, start, end, { noClose: true });
  const resultat = -yr.filter((r) => /^[678]/.test(r.account)).reduce((a, r) => a + r.balance, 0);
  // Soldes cumulés depuis l'ouverture (les à-nouveaux dupliqueraient l'historique) : base du solde des comptes de gestion et du report.
  const cum = await L.balances(org.id, '0001-01-01', end, { noOpen: true });
  const closingLines = cum.filter((r) => /^[678]/.test(r.account) && r.balance !== 0)
    .map((r) => ({ account: r.account, label: r.label, debit: r.balance < 0 ? -r.balance : 0, credit: r.balance > 0 ? r.balance : 0 }));
  const swept = -cum.filter((r) => /^[678]/.test(r.account)).reduce((a, r) => a + r.balance, 0); // résultat viré dans 131 / 139 (inclut un éventuel exercice antérieur non clôturé)
  const bil = new Map(cum.filter((r) => /^[1-5]/.test(r.account)).map((r) => [r.account, { label: r.label, balance: r.balance }]));
  if (!closed && swept !== 0) { // résultat pas encore viré : on le simule pour présenter le report tel qu'il sera écrit
    const acct = swept > 0 ? '131' : '139';
    const label = swept > 0 ? "Résultat net de l'exercice : bénéfice" : "Résultat net de l'exercice : perte";
    const cur = bil.get(acct) || { label, balance: 0 };
    bil.set(acct, { label: cur.label || label, balance: cur.balance - swept });
  }
  const carry = [...bil.entries()].filter(([, v]) => v.balance !== 0).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([account, v]) => ({ account, label: v.label, debit: v.balance > 0 ? v.balance : 0, credit: v.balance < 0 ? -v.balance : 0 }));
  const carryForward = { lines: carry, totalDebit: carry.reduce((a, l) => a + l.debit, 0), totalCredit: carry.reduce((a, l) => a + l.credit, 0) };

  // ---- Contrôles ----
  const checks = [];
  const add = (code, ok, label, detail, blocking) => checks.push({ code, ok, label, detail: detail || '', blocking: Boolean(blocking) });
  const pend = await L.pendingIn(org, '0000-01-01', end);
  add('operations', pend.total === 0, 'Toutes les opérations sont comptabilisées', pend.total ? `${pend.total} opération(s) à comptabiliser (${pend.invoices} facture(s), ${pend.payments} paiement(s), ${pend.purchases} achat(s))` : '', true);
  const dep = await require('./acc-ops').dueDepreciation(org.id, `${year}-12`, false);
  add('depreciation', dep.length === 0, "Amortissements de l'année comptabilisés", dep.length ? `${dep.length} dotation(s) aux amortissements à comptabiliser` : '', true);
  const months = (await db.prepare("SELECT DISTINCT substr(date, 1, 7) AS m FROM acc_entries WHERE org_id = ? AND date >= ? AND date <= ? ORDER BY 1").all(org.id, start, end)).map((r) => r.m);
  const shut = new Set((await db.prepare("SELECT month FROM month_closings WHERE org_id = ? AND status = 'closed'").all(org.id)).map((r) => r.month));
  const openMonths = months.filter((m) => !shut.has(m));
  add('months', openMonths.length === 0, 'Mois clôturés', openMonths.length ? `Mois non clôturés : ${openMonths.join(', ')}` : '', false);
  const banks = await db.prepare('SELECT id FROM bank_accounts WHERE org_id = ?').all(org.id);
  let unm = 0;
  for (const b of banks) unm += Number((await db.prepare("SELECT COUNT(*) c FROM bank_lines WHERE bank_id = ? AND status = 'unmatched' AND date <= ?").get(b.id, end)).c);
  add('bank', unm === 0, 'Relevés bancaires rapprochés', unm ? `${unm} ligne(s) de relevé non pointée(s)` : (banks.length ? '' : 'Aucun compte bancaire suivi'), false);
  const tot = await db.prepare(`SELECT COALESCE(SUM(l.debit), 0) d, COALESCE(SUM(l.credit), 0) c FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND e.date <= ? AND ${L.NOT_OPEN}`).get(org.id, end);
  const balanced = Number(tot.d) === Number(tot.c) && carryForward.totalDebit === carryForward.totalCredit;
  add('balance', balanced, 'Balance équilibrée', balanced ? '' : `Débits ${L.fmt(tot.d)} / crédits ${L.fmt(tot.c)} ; report ${L.fmt(carryForward.totalDebit)} / ${L.fmt(carryForward.totalCredit)}`, true);
  const earlier = (await db.prepare(`SELECT DISTINCT substr(e.date, 1, 4) AS y FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND e.date < ? AND (l.account LIKE '6%' OR l.account LIKE '7%' OR l.account LIKE '8%') AND ${L.NOT_CLOSE} AND ${L.NOT_OPEN} ORDER BY 1`).all(org.id, start)).map((r) => r.y);
  const locked = req.acc.locked_until || '';
  const closedYears = new Set((await db.prepare("SELECT year FROM acc_year_ends WHERE org_id = ? AND status = 'closed'").all(org.id)).map((r) => r.year));
  const todo = earlier.filter((y) => !closedYears.has(y) && !(locked && locked >= `${y}-12-31`));
  add('previous_year', todo.length === 0, 'Exercices précédents clôturés', todo.length ? `À clôturer d'abord : ${todo.join(', ')}` : '', true);
  const after = Number((await db.prepare("SELECT COUNT(*) c FROM acc_entries WHERE org_id = ? AND date > ? AND source NOT IN ('year_open', 'year_open_rev')").get(org.id, end)).c);
  add('after_year_end', after === 0, `Aucune écriture après le 31/12/${year}`, after ? `${after} écriture(s) datée(s) après le 31/12/${year} : elles ne sont pas touchées par la clôture` : '', false);
  return { year: Number(year), closed, lockedUntil: locked, resultat, checks, carryForward, nextYear: Number(year) + 1, closingLines, swept, state: st };
}

router.get('/year-end', async (req, res) => {
  const year = yearParam(req.query.year || L.today().slice(0, 4));
  const c = await compute(req, year);
  res.json({ year: c.year, closed: c.closed, lockedUntil: c.lockedUntil, resultat: c.resultat, checks: c.checks, carryForward: c.carryForward, nextYear: c.nextYear,
    closedAt: c.state && c.state.status === 'closed' ? c.state.closed_at : null, reopenReason: c.state ? c.state.reopen_reason : '', notes: NOTES });
});

const audit = async (req, action, severity, target, detail) => { try { await require('../security/audit').record(req, action, { orgId: req.org.id, target, severity, detail }); } catch { /* l'audit ne bloque jamais */ } };

router.post('/year-end/close', async (req, res) => {
  const b = req.body || {};
  const year = yearParam(b.year); const end = `${year}-12-31`; const next = Number(year) + 1;
  if (year > L.today().slice(0, 4)) throw new HttpError(400, "Cet exercice n'a pas encore commencé : il ne peut pas être clôturé.");
  const c = await compute(req, year);
  if (c.closed) throw new HttpError(409, `L'exercice ${year} est déjà clôturé.`);
  if (c.lockedUntil && c.lockedUntil >= end) throw new HttpError(400, `Les écritures sont déjà verrouillées jusqu'au ${c.lockedUntil} : l'exercice ${year} ne peut plus recevoir d'écriture de clôture.`);
  const blockers = c.checks.filter((k) => !k.ok && k.blocking);
  const force = Boolean(b.force);
  if (blockers.length && !force) throw new HttpError(400, `Clôture impossible, il reste à faire : ${blockers.map((k) => `${k.label} (${k.detail || 'à vérifier'})`).join(' ; ')}.`);
  if (blockers.length && req.member.role !== 'owner') throw new HttpError(403, 'Seul le propriétaire peut forcer la clôture malgré des contrôles bloquants.');
  const note = A.text(b.reason || b.note, 300);
  if (blockers.length && note.length < 5) throw new HttpError(400, 'Pour clôturer malgré des contrôles bloquants, indiquez le motif (5 caractères au moins).');
  if (!c.closingLines.length && !c.carryForward.lines.length) throw new HttpError(400, `Aucune écriture sur l'exercice ${year} : il n'y a rien à clôturer.`);
  const cycle = c.state ? Number(c.state.cycle) + 1 : 1; const sid = Number(year) * 100 + cycle;

  let closingEntry = null; const openingEntries = [];
  await db.transaction(async () => {
    const acc = accounting();
    if (c.closingLines.length) { // 1. détermination du résultat : on solde les classes 6, 7 et 8 contre 131 (bénéfice) ou 139 (perte)
      const lines = c.closingLines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, memo: 'Solde du compte de gestion' }));
      if (c.swept > 0) lines.push({ account: '131', credit: c.swept, memo: `Bénéfice ${year}` });
      else if (c.swept < 0) lines.push({ account: '139', debit: -c.swept, memo: `Perte ${year}` });
      const e = await acc.recordEntry(req.org, req.user.id, { journal: 'OD', date: end, label: `Détermination du résultat ${year}`, piece: `CLOT-${year}`, lines, source: 'year_end', sourceId: sid, allowClosedMonth: true, maxLines: LINES_MAX });
      closingEntry = { id: e.id, number: e.number };
    }
    // 2. à-nouveaux : soldes du bilan (classes 1 à 5) après l'écriture de résultat
    const cum = await L.balances(req.org.id, '0001-01-01', end, { noOpen: true });
    const open = cum.filter((r) => /^[1-5]/.test(r.account) && r.balance !== 0).map((r) => ({ account: r.account, debit: r.balance > 0 ? r.balance : 0, credit: r.balance < 0 ? -r.balance : 0, memo: `À-nouveau ${next}` }));
    const d = open.reduce((a, l) => a + l.debit, 0); const cr = open.reduce((a, l) => a + l.credit, 0);
    if (d !== cr) throw new HttpError(400, `Le bilan à reporter n'est pas équilibré (débits ${L.fmt(d)} ≠ crédits ${L.fmt(cr)}) : vérifiez les écritures avant de clôturer.`);
    if (open.length) {
      const e = await acc.recordEntry(req.org, req.user.id, { journal: 'AN', date: `${next}-01-01`, label: `À-nouveaux ${next} (report de l'exercice ${year})`, piece: `AN-${next}`, lines: open.map((l) => ({ ...l })), source: 'year_open', sourceId: sid, allowClosedMonth: true, maxLines: LINES_MAX });
      openingEntries.push({ id: e.id, number: e.number });
    }
    // 3. verrou jusqu'au 31/12 ; on retient l'ancien verrou pour la réouverture
    await db.prepare('UPDATE acc_settings SET locked_until = ? WHERE org_id = ?').run(end, req.org.id);
    const vals = [cycle, closingEntry ? closingEntry.id : null, JSON.stringify(openingEntries.map((x) => x.id)), c.lockedUntil || null, c.swept, blockers.length ? 1 : 0, note, req.user.id, nowISO()];
    if (c.state) await db.prepare("UPDATE acc_year_ends SET status = 'closed', cycle = ?, closing_entry_id = ?, opening_entry_ids = ?, prev_locked = ?, resultat = ?, forced = ?, note = ?, closed_by = ?, closed_at = ? WHERE org_id = ? AND year = ?").run(...vals, req.org.id, String(year));
    else await db.prepare("INSERT INTO acc_year_ends (org_id, year, status, cycle, closing_entry_id, opening_entry_ids, prev_locked, resultat, forced, note, closed_by, closed_at) VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(req.org.id, String(year), ...vals);
  })();
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Exercice ${year} clôturé${blockers.length ? ' (contrôles forcés)' : ''}`);
  await audit(req, 'accounting.year_close', blockers.length ? 'warn' : 'info', `exercice:${year}`, `${year}${blockers.length ? ' ; forcé : ' + note : ''}`);
  res.status(201).json({ closingEntry, openingEntries, lockedUntil: end });
});

router.post('/year-end/reopen', async (req, res) => {
  if (req.member.role !== 'owner') throw new HttpError(403, "Seul le propriétaire de l'organisation peut rouvrir un exercice clôturé.");
  const b = req.body || {};
  const year = yearParam(b.year); const end = `${year}-12-31`; const next = Number(year) + 1;
  const reason = A.text(b.reason, 200, { required: true, msg: 'Indiquez le motif de la réouverture.' });
  if (reason.length < 5) throw new HttpError(400, 'Le motif de la réouverture est trop court (5 caractères au moins).');
  const st = await stateOf(req.org.id, year);
  if (!st || st.status !== 'closed') throw new HttpError(409, `L'exercice ${year} n'est pas clôturé par la clôture annuelle.`);
  const lock = req.acc.locked_until || '';
  if (lock > end) throw new HttpError(400, `Une période postérieure est verrouillée (jusqu'au ${lock}) : rouvrez-la d'abord.`);
  const later = Number((await db.prepare("SELECT COUNT(*) c FROM acc_entries WHERE org_id = ? AND date > ? AND source NOT IN ('year_open', 'year_open_rev')").get(req.org.id, end)).c);
  if (later) throw new HttpError(400, `Réouverture impossible : ${later} écriture(s) existent après le 31/12/${year} (autres que les à-nouveaux). Annulez-les d'abord.`);
  const reversed = [];
  await db.transaction(async () => {
    await db.prepare('UPDATE acc_settings SET locked_until = ? WHERE org_id = ?').run(st.prev_locked || null, req.org.id); // le verrou saute avant les écritures inverses
    const acc = accounting();
    for (const id of parseIds(st.opening_entry_ids)) {
      const r = await acc.reverseEntry(req.org, req.user.id, id, `${next}-01-01`, { allowClosedMonth: true, source: 'year_open_rev', sourceId: id, maxLines: LINES_MAX });
      reversed.push(r.reversed);
    }
    if (st.closing_entry_id) {
      const r = await acc.reverseEntry(req.org, req.user.id, Number(st.closing_entry_id), end, { allowClosedMonth: true, source: 'year_end_rev', sourceId: Number(st.closing_entry_id), maxLines: LINES_MAX });
      reversed.push(r.reversed);
    }
    await db.prepare("UPDATE acc_year_ends SET status = 'open', reopen_reason = ?, reopened_by = ?, reopened_at = ? WHERE org_id = ? AND year = ?").run(reason, req.user.id, nowISO(), req.org.id, String(year));
  })();
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Exercice ${year} rouvert : ${reason}`);
  await audit(req, 'accounting.year_reopen', 'warn', `exercice:${year}`, `${year} : ${reason}`);
  res.json({ ok: true, reversed, lockedUntil: st.prev_locked || '' });
});

module.exports = router;
