'use strict';
// Sous-application « Budget » : réservée aux responsables et plus.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const KINDS = ['income', 'expense'];
const Annual = require('./budget-annual'); // budget annuel, trésorerie, seuil de validation (VAGUE 2)
router.use(Annual);

/** Totaux du mois : entrées, sorties, solde, détail par catégorie avec la limite prévue. */
async function summary(req, month) {
  const r = A.monthRange(month);
  const sc = A.scope(req);
  const entries = await db.prepare(`SELECT * FROM budget_entries WHERE org_id = ? AND date >= ? AND date < ?${sc.sql} ORDER BY date DESC, id DESC`).all(req.org.id, r.from, r.to, ...sc.args);
  const plans = Object.fromEntries((await db.prepare('SELECT category, monthly_limit FROM budget_plans WHERE org_id = ?').all(req.org.id)).map((p) => [p.category, p.monthly_limit]));
  let income = 0;
  let expense = 0;
  const cat = {};
  for (const e of entries) {
    if (e.kind === 'income') income += e.amount;
    else {
      expense += e.amount;
      cat[e.category] = (cat[e.category] || 0) + e.amount;
    }
  }
  const categories = Object.entries(cat).map(([category, spent]) => ({ category, spent, limit: plans[category] || null })).sort((a, b) => b.spent - a.spent);
  for (const c of Object.keys(plans)) if (!(c in cat)) categories.push({ category: c, spent: 0, limit: plans[c] });
  return { month: r.month, income, expense, balance: income - expense, categories, entries, plans };
}

router.get('/', async (req, res) => {
  const s = await summary(req, req.query.month);
  res.json({ ...s, entries: s.entries.map((e) => ({ id: e.id, kind: e.kind, category: e.category, label: e.label, amount: e.amount, date: e.date, branchId: e.branch_id })) });
});

const PAY = { cash: ['571', 'CA'], bank: ['521', 'BQ'], mobile: ['589', 'MM'] };

/** Inscrit aussi la ligne en comptabilité (UNE saisie pour le budget ET la compta) : administrateurs seulement, compte obligatoire. */
async function postToLedger(req, id, v, b) {
  const account = String(b.account || '').trim();
  if (!account) throw new HttpError(400, 'Pour inscrire aussi en comptabilité, indiquez le compte (ex. 622 pour un loyer, 701 pour une vente).');
  if (account[0] !== (v.kind === 'expense' ? '6' : '7')) throw new HttpError(400, v.kind === 'expense' ? 'Une sortie s\'inscrit sur un compte de charges (classe 6).' : 'Une entrée s\'inscrit sur un compte de produits (classe 7).');
  const [treasury, journal] = PAY[A.oneOf(b.payment, Object.keys(PAY), 'cash', 'Règlement : espèces, banque ou mobile money.')];
  const lines = v.kind === 'expense' ? [{ account, debit: v.amount }, { account: treasury, credit: v.amount }] : [{ account: treasury, debit: v.amount }, { account, credit: v.amount }];
  const r = await require('./accounting').recordEntry(req.org, req.user.id, { journal, date: v.date, label: `Budget : ${v.category}${v.label ? ' - ' + v.label : ''}`.slice(0, 200), piece: `BUD-${id}`, lines, source: 'budget_entry', sourceId: id });
  await db.prepare('UPDATE budget_entries SET acc_entry_id = ?, in_ledger = 1 WHERE id = ?').run(r.id, id);
  return r;
}

router.post('/entries', async (req, res) => {
  const b = req.body || {};
  const v = { kind: A.oneOf(b.kind, KINDS, undefined, 'Choisissez entrée ou sortie.'), category: A.text(b.category, 60, { required: true, msg: 'Indiquez une catégorie.' }), label: A.text(b.label, 150), amount: A.amount(b.amount), date: A.date(b.date) || nowISO().slice(0, 10) };
  const branch = await A.branchOf(req, b.branchId);
  if (b.ledger === true && !A.can(req, 'admin')) throw new HttpError(403, 'Seul un administrateur peut inscrire une ligne en comptabilité.');
  // Dépense au-dessus du seuil : un responsable ne l'inscrit pas lui-même, il la soumet à validation.
  const thr = await Annual.thresholdOf(req.org.id);
  if (v.kind === 'expense' && thr > 0 && v.amount >= thr && !A.can(req, 'admin')) {
    const rid = (await db.prepare('INSERT INTO expense_requests (org_id, branch_id, category, label, amount, date, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, branch, v.category, v.label, v.amount, v.date, req.user.id, nowISO())).lastInsertRowid;
    await A.logActivity(req.org.id, req.user.id, 'budget', `Dépense de ${v.amount} (${v.category}) soumise à validation`);
    return res.status(202).json({ pending: true, requestId: Number(rid), threshold: thr });
  }
  let id; let entry = null;
  await db.transaction(async () => {
    id = Number((await db.prepare('INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.org.id, branch, v.kind, v.category, v.label, v.amount, v.date, req.user.id, nowISO())).lastInsertRowid);
    if (b.ledger === true) entry = await postToLedger(req, id, v, b);
  })();
  res.status(201).json({ id, entry: entry ? entry.number : undefined });
});

router.put('/entries/:id', async (req, res) => {
  const e = await db.prepare('SELECT * FROM budget_entries WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!e || !A.visible(req, e)) throw new HttpError(404, 'Ligne introuvable.');
  const b = req.body || {};
  const thr = await Annual.thresholdOf(req.org.id);
  if (thr > 0 && !A.can(req, 'admin') && (b.kind === undefined ? e.kind : b.kind) === 'expense' && b.amount !== undefined && A.amount(b.amount) >= thr && A.amount(b.amount) !== e.amount) throw new HttpError(403, `Ce montant atteint le seuil de validation (${thr}) : faites une nouvelle demande, un administrateur doit la valider.`);
  if (e.acc_entry_id && (b.amount !== undefined || b.kind !== undefined) && A.can(req, 'admin') === false) throw new HttpError(403, 'Cette ligne est liée à une écriture comptable : seul un administrateur la modifie (et la compta se corrige par une écriture inverse).');
  await db.prepare('UPDATE budget_entries SET kind = ?, category = ?, label = ?, amount = ?, date = ? WHERE id = ?').run(
    b.kind === undefined ? e.kind : A.oneOf(b.kind, KINDS), b.category === undefined ? e.category : A.text(b.category, 60, { required: true, msg: 'Indiquez une catégorie.' }),
    b.label === undefined ? e.label : A.text(b.label, 150), b.amount === undefined ? e.amount : A.amount(b.amount), b.date === undefined ? e.date : A.date(b.date) || e.date, e.id);
  res.json({ ok: true });
});

router.delete('/entries/:id', async (req, res) => {
  const e = await db.prepare('SELECT * FROM budget_entries WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!e || !A.visible(req, e)) throw new HttpError(404, 'Ligne introuvable.');
  await db.prepare('DELETE FROM budget_entries WHERE id = ?').run(e.id);
  res.json({ ok: true });
});

/** Remplace les limites mensuelles par catégorie (utilisée aussi par l'IA, après validation). */
async function setPlans(req, list) {
  if (!Array.isArray(list) || list.length > 40) throw new HttpError(400, 'Liste de limites invalide.');
  const clean = new Map();
  for (const p of list) {
    const category = A.text(p && p.category, 60);
    if (!category) continue;
    clean.set(category, A.amount(p.monthlyLimit));
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM budget_plans WHERE org_id = ?').run(req.org.id);
    for (const [category, lim] of clean) await db.prepare('INSERT INTO budget_plans (org_id, category, monthly_limit) VALUES (?, ?, ?)').run(req.org.id, category, lim);
  })();
  await A.logActivity(req.org.id, req.user.id, 'budget', 'Limites mensuelles du budget mises à jour');
}
router.put('/plans', A.need('admin'), async (req, res) => {
  await setPlans(req, (req.body || {}).plans);
  res.json({ ok: true });
});

module.exports = router;
module.exports.summary = summary;
module.exports.setPlans = setPlans;
module.exports.postToLedger = postToLedger;
