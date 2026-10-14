'use strict';
// Sous-application « Budget » : réservée aux responsables et plus.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const KINDS = ['income', 'expense'];

/** Totaux du mois : entrées, sorties, solde, détail par catégorie avec la limite prévue. */
function summary(req, month) {
  const r = A.monthRange(month);
  const sc = A.scope(req);
  const entries = db.prepare(`SELECT * FROM budget_entries WHERE org_id = ? AND date >= ? AND date < ?${sc.sql} ORDER BY date DESC, id DESC`).all(req.org.id, r.from, r.to, ...sc.args);
  const plans = Object.fromEntries(db.prepare('SELECT category, monthly_limit FROM budget_plans WHERE org_id = ?').all(req.org.id).map((p) => [p.category, p.monthly_limit]));
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

router.get('/', (req, res) => {
  const s = summary(req, req.query.month);
  res.json({ ...s, entries: s.entries.map((e) => ({ id: e.id, kind: e.kind, category: e.category, label: e.label, amount: e.amount, date: e.date, branchId: e.branch_id })) });
});

router.post('/entries', (req, res) => {
  const b = req.body || {};
  const id = db.prepare('INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, A.branchOf(req, b.branchId), A.oneOf(b.kind, KINDS, undefined, 'Choisissez entrée ou sortie.'),
    A.text(b.category, 60, { required: true, msg: 'Indiquez une catégorie.' }), A.text(b.label, 150), A.amount(b.amount), A.date(b.date) || nowISO().slice(0, 10), req.user.id, nowISO()).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});

router.put('/entries/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM budget_entries WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!e || !A.visible(req, e)) throw new HttpError(404, 'Ligne introuvable.');
  const b = req.body || {};
  db.prepare('UPDATE budget_entries SET kind = ?, category = ?, label = ?, amount = ?, date = ? WHERE id = ?').run(
    b.kind === undefined ? e.kind : A.oneOf(b.kind, KINDS), b.category === undefined ? e.category : A.text(b.category, 60, { required: true, msg: 'Indiquez une catégorie.' }),
    b.label === undefined ? e.label : A.text(b.label, 150), b.amount === undefined ? e.amount : A.amount(b.amount), b.date === undefined ? e.date : A.date(b.date) || e.date, e.id);
  res.json({ ok: true });
});

router.delete('/entries/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM budget_entries WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!e || !A.visible(req, e)) throw new HttpError(404, 'Ligne introuvable.');
  db.prepare('DELETE FROM budget_entries WHERE id = ?').run(e.id);
  res.json({ ok: true });
});

/** Remplace les limites mensuelles par catégorie (utilisée aussi par l'IA, après validation). */
function setPlans(req, list) {
  if (!Array.isArray(list) || list.length > 40) throw new HttpError(400, 'Liste de limites invalide.');
  const clean = new Map();
  for (const p of list) {
    const category = A.text(p && p.category, 60);
    if (!category) continue;
    clean.set(category, A.amount(p.monthlyLimit));
  }
  db.transaction(() => {
    db.prepare('DELETE FROM budget_plans WHERE org_id = ?').run(req.org.id);
    for (const [category, lim] of clean) db.prepare('INSERT INTO budget_plans (org_id, category, monthly_limit) VALUES (?, ?, ?)').run(req.org.id, category, lim);
  })();
  A.logActivity(req.org.id, req.user.id, 'budget', 'Limites mensuelles du budget mises à jour');
}
router.put('/plans', A.need('admin'), (req, res) => {
  setPlans(req, (req.body || {}).plans);
  res.json({ ok: true });
});

module.exports = router;
module.exports.summary = summary;
module.exports.setPlans = setPlans;
