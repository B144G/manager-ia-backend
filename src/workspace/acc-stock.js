'use strict';
// Comptabilité : stocks. Valeur du stock du module Stock (coût moyen pondéré) à une date d'inventaire, face au stock comptabilisé (classe 3),
// et constatation de la variation de stock (inventaire intermittent SYSCOHADA : les achats sont en charges, le stock final passe au bilan).
// Écritures passées par accounting.recordEntry() : équilibrées, mois clôturés respectés, jamais modifiées (une erreur s'annule).
// FUSION des lignes A et B : valorisation au coût moyen pondéré, dates passées reconstituées (mouvements ultérieurs retirés, articles
// pas encore créés exclus), solde comptable par classe (A), identifiant d'écriture propre à chaque tentative pour qu'une annulation
// suivie d'une nouvelle constatation ne soit pas bloquée par l'unicité (source, sourceId) (B), historique sur les lignes du compte de stock
// (relit aussi les écritures passées avant la fusion, dont la pièce était « INV-date »).
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');
const L = require('./acc-pro-lib');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting');

const NATURES = {
  goods: { account: '311', prefix: '31', variation: '6031', label: 'marchandises' },
  raw: { account: '321', prefix: '32', variation: '6032', label: 'matières premières' },
  supplies: { account: '331', prefix: '33', variation: '6033', label: 'matières consommables' },
};
const natureOf = (v) => { const k = A.oneOf(v === undefined || v === '' ? 'goods' : v, Object.keys(NATURES), undefined, 'Nature de stock inconnue (marchandises, matières premières, matières consommables).'); return { ...NATURES[k], key: k }; };
function dateOf(v) {
  const d = v === undefined || v === '' ? L.today() : A.date(v);
  if (!d) throw new HttpError(400, "Date d'inventaire invalide.");
  if (d > L.today()) throw new HttpError(400, "La date d'inventaire ne peut pas être dans le futur.");
  return d;
}

/** Stock valorisé à la fin de la journée `date` : quantité reconstituée depuis les mouvements, au coût moyen actuel. */
async function valuation(org, date) {
  const end = `${date}T23:59:59.999Z`;
  const rows = await db.prepare(`SELECT i.id, i.name, i.unit, i.quantity, i.avg_cost, i.unit_cost, i.created_at,
      COALESCE((SELECT SUM(m.delta) FROM stock_moves m WHERE m.item_id = i.id AND m.created_at > ?), 0) AS after
    FROM stock_items i WHERE i.org_id = ? AND i.created_at <= ? ORDER BY i.name`).all(end, org.id, end);
  const items = [];
  for (const r of rows) {
    const quantity = Math.round((Number(r.quantity) - Number(r.after)) * 1000) / 1000;
    if (!(quantity > 0)) continue;
    const unitCost = Number(r.avg_cost) > 0 ? Number(r.avg_cost) : Number(r.unit_cost) || 0;
    items.push({ id: Number(r.id), name: r.name, unit: r.unit, quantity, unitCost: Math.round(unitCost * 100) / 100, value: Math.round(quantity * unitCost) });
  }
  return { items, totalValue: items.reduce((a, x) => a + x.value, 0) };
}

async function state(req, date, n) {
  const v = await valuation(req.org, date);
  const bal = await accounting().balance(req.org, '0000-01-01', date);
  const inBooks = Math.round(bal.filter((x) => x.account.startsWith(n.prefix)).reduce((a, x) => a + x.balance, 0));
  const hist = await db.prepare(`SELECT e.id, e.number, e.date, e.label, l.debit, l.credit,
      EXISTS (SELECT 1 FROM acc_entries r WHERE r.org_id = e.org_id AND r.reversed_of = e.id) AS cancelled
    FROM acc_entries e JOIN acc_lines l ON l.entry_id = e.id AND l.account = ?
    WHERE e.org_id = ? AND e.source = 'stock_valuation' ORDER BY e.date DESC, e.id DESC LIMIT 50`).all(n.account, req.org.id);
  return {
    date, nature: n.key, account: n.account, variationAccount: n.variation, totalValue: v.totalValue, accounting: inBooks, gap: v.totalValue - inBooks, items: v.items,
    natureLabel: n.label, history: hist.map((h) => ({ number: h.number, date: h.date, label: h.label, amount: Math.round(Math.abs(Number(h.debit) - Number(h.credit))), increase: Number(h.debit) > Number(h.credit), cancelled: Boolean(h.cancelled) })),
  };
}

router.get('/stock-valuation', async (req, res) => res.json(await state(req, dateOf(req.query.date), natureOf(req.query.nature))));

router.post('/stock-valuation/post', async (req, res) => {
  const b = req.body || {};
  const date = dateOf(b.date); const n = natureOf(b.nature);
  const s = await state(req, date, n);
  if (s.gap === 0) throw new HttpError(400, 'Aucun écart : la comptabilité est déjà à jour pour cette date.');
  const amt = Math.abs(s.gap);
  // identifiant propre à chaque tentative (jour × 100 + rang) : une écriture annulée n'empêche pas d'en passer une nouvelle
  const base = Number(date.replace(/-/g, '')) * 100;
  const tried = Number((await db.prepare('SELECT COUNT(*) AS n FROM acc_entries WHERE org_id = ? AND source = ? AND source_id >= ? AND source_id < ?').get(req.org.id, 'stock_valuation', base, base + 100)).n);
  if (tried >= 99) throw new HttpError(400, 'Trop de tentatives pour cette date : passez une écriture manuelle.');
  const lines = s.gap > 0
    ? [{ account: n.account, debit: amt, memo: `Stock de ${n.label} au ${date}` }, { account: n.variation, credit: amt, memo: 'Variation de stock' }]
    : [{ account: n.variation, debit: amt, memo: 'Variation de stock' }, { account: n.account, credit: amt, memo: `Stock de ${n.label} au ${date}` }];
  const r = await accounting().recordEntry(req.org, req.user.id, { journal: 'OD', date, label: `Variation de stock (${n.label}) au ${date.slice(8)}/${date.slice(5, 7)}/${date.slice(0, 4)}`.slice(0, 200), piece: `INV-${n.key}-${date}`, lines, source: 'stock_valuation', sourceId: base + tried + 1 });
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Variation de stock (${n.label}) passée au ${date} : ${L.fmt(amt)} FCFA`);
  res.status(201).json({ entry: r.number, id: r.id, amount: amt, increase: s.gap > 0 });
});

module.exports = router;
