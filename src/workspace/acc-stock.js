'use strict';
// Comptabilité : stock en écritures (inventaire intermittent, comme le plan SYSCOHADA le prévoit pour une PME).
// Les achats sont déjà comptabilisés en charges (601…) par les factures et réceptions. Le stock final, valorisé au coût moyen pondéré du module Stock,
// est constaté en classe 3 ; la variation de stock (603x) retire de la charge ce qui n'a pas été consommé. Une écriture par date d'inventaire,
// calculée sur l'écart avec le solde déjà comptabilisé : la rejouer ne double jamais rien. Réservé aux administrateurs (le routeur parent l'impose déjà).
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');
const L = require('./acc-pro-lib');
const SL = require('./stock-lib');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting'); // require paresseux (évite toute dépendance circulaire)

// nature du stock → compte de stock, compte de variation, libellé
const NATURES = {
  goods: { stock: '311', variation: '6031', label: 'marchandises' },
  raw: { stock: '321', variation: '6032', label: 'matières premières et fournitures liées' },
  supplies: { stock: '331', variation: '6033', label: 'matières consommables et autres approvisionnements' },
};
const SRC = 'stock_valuation';

/** Quantité d'un article à la fin d'une date : quantité actuelle moins les mouvements enregistrés après cette date. */
async function valuation(org, date, nature) {
  const N = NATURES[nature];
  const end = `${date}T23:59:59.999Z`;
  const rows = await db.prepare(`SELECT i.id, i.name, i.unit, i.quantity, i.unit_cost, i.avg_cost, i.created_at,
      (SELECT COALESCE(SUM(m.delta), 0) FROM stock_moves m WHERE m.item_id = i.id AND m.created_at > ?) AS after
    FROM stock_items i WHERE i.org_id = ? ORDER BY i.name`).all(end, org.id);
  const items = rows.filter((r) => r.created_at <= end).map((r) => {
    const quantity = Math.max(SL.round3(Number(r.quantity) - Number(r.after)), 0);
    const unitCost = SL.unitValue(r);
    return { id: Number(r.id), name: r.name, unit: r.unit, quantity, unitCost, value: Math.round(quantity * unitCost) };
  });
  const totalValue = items.reduce((s, x) => s + x.value, 0);
  const b = await db.prepare(`SELECT COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS bal FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    WHERE l.org_id = ? AND l.account = ? AND e.date <= ?`).get(org.id, N.stock, date);
  const accounting_ = Number(b.bal);
  return { date, nature, account: N.stock, variationAccount: N.variation, natureLabel: N.label, items, totalValue, accounting: accounting_, gap: totalValue - accounting_ };
}

const parseQuery = (src) => {
  const date = src.date === undefined || src.date === '' ? L.today() : String(src.date);
  if (!L.isDate(date)) throw new HttpError(400, 'Date invalide (AAAA-MM-JJ).');
  const nature = src.nature === undefined || src.nature === '' ? 'goods' : String(src.nature);
  if (!NATURES[nature]) throw new HttpError(400, 'Nature du stock : marchandises, matières premières ou matières consommables.');
  return { date, nature };
};

router.get('/stock-valuation', async (req, res) => {
  const { date, nature } = parseQuery(req.query);
  const v = await valuation(req.org, date, nature);
  const hist = await db.prepare(`SELECT e.number, e.date, e.label, (SELECT COALESCE(SUM(l.debit), 0) FROM acc_lines l WHERE l.entry_id = e.id) AS total,
      (SELECT COALESCE(SUM(l.debit), 0) FROM acc_lines l WHERE l.entry_id = e.id AND l.account = ?) AS up,
      EXISTS (SELECT 1 FROM acc_entries r WHERE r.org_id = e.org_id AND r.reversed_of = e.id) AS cancelled
    FROM acc_entries e WHERE e.org_id = ? AND e.source = ? AND e.piece LIKE ? ORDER BY e.id DESC LIMIT 20`).all(NATURES[nature].stock, req.org.id, SRC, `INV-${nature}-%`);
  res.json({ ...v, history: hist.map((h) => ({ number: h.number, date: h.date, label: h.label, amount: Number(h.total), increase: Number(h.up) > 0, cancelled: Boolean(h.cancelled) })) });
});

/** Constate le stock à la date choisie : débit du stock et crédit de la variation (hausse), ou l'inverse (baisse). */
router.post('/stock-valuation/post', async (req, res) => {
  const { date, nature } = parseQuery(req.body || {});
  const N = NATURES[nature];
  if (date > L.today()) throw new HttpError(400, "La date d'inventaire ne peut pas être dans le futur.");
  const v = await valuation(req.org, date, nature);
  if (v.gap === 0) throw new HttpError(400, 'Le stock en comptabilité correspond déjà au stock valorisé à cette date : rien à passer.');
  const amt = Math.abs(v.gap);
  const tried = Number((await db.prepare('SELECT COUNT(*) AS n FROM acc_entries WHERE org_id = ? AND source = ? AND source_id >= ? AND source_id < ?').get(req.org.id, SRC, Number(date.replace(/-/g, '')) * 100, Number(date.replace(/-/g, '')) * 100 + 100)).n);
  if (tried >= 99) throw new HttpError(400, 'Trop de tentatives pour cette date : passez une écriture manuelle.');
  const lines = v.gap > 0
    ? [{ account: N.stock, debit: amt, memo: 'Stock final' }, { account: N.variation, credit: amt, memo: 'Variation de stock' }]
    : [{ account: N.variation, debit: amt, memo: 'Variation de stock' }, { account: N.stock, credit: amt, memo: 'Stock final' }];
  const r = await accounting().recordEntry(req.org, req.user.id, { journal: 'OD', date, label: `Variation de stock (${N.label}) au ${date.slice(8)}/${date.slice(5, 7)}/${date.slice(0, 4)}`.slice(0, 200), piece: `INV-${nature}-${date}`, lines, source: SRC, sourceId: Number(date.replace(/-/g, '')) * 100 + tried + 1 });
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Stock constaté au ${date} : ${v.gap > 0 ? '+' : '−'}${amt}`);
  res.status(201).json({ entry: r.number, amount: amt, increase: v.gap > 0, totalValue: v.totalValue });
});

module.exports = router;
