'use strict';
// Budget · pilotage avancé : tableau de bord (prévu / réalisé / engagé, écarts en valeur et en %, rythme de consommation, reste, atterrissage
// de fin d'année avec fourchette), graphiques mensuels, écarts par catégorie avec alertes, scénarios, détail jusqu'à la source (écritures
// comptables, saisies hors compta, bons de commande) et export CSV.
// Mêmes données que le budget annuel (une seule source de vérité : la comptabilité + les saisies hors compta), donc réservé aux administrateurs.
// Les calculs sont dans bp-calc.js (fonctions pures, formules documentées) ; ici on ne fait que lire et assembler.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const Annual = require('./budget-annual');
const C = require('./bp-calc');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const admin = A.need('admin');
const today = () => nowISO().slice(0, 10);
const yearOf = (v) => { const y = String(v || today().slice(0, 4)); if (!/^\d{4}$/.test(y)) throw new HttpError(400, 'Année invalide.'); return y; };
const pctOf = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);
const TOL = 10; // tolérance (%) avant de signaler un écart à date
const pctParam = (v, def) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 90) throw new HttpError(400, 'Ajustement de scénario invalide (0 à 90 %).');
  return n;
};
const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Engagé non encore réalisé, par catégorie de dépense et par mois de l'année :
 *   - commandes de stock validées pas encore reçues (ancien circuit) : catégorie « Achats », mois de la date promise (sinon le mois courant) ;
 *   - bons de commande des Achats approuvés, envoyés, en partie ou entièrement reçus : montant HT de la commande - HT des factures déjà
 *     approuvées (celles-ci sont en comptabilité, donc déjà dans le réalisé) ; catégorie de la commande (vide = « Achats ») ; mois de la
 *     livraison prévue (sinon de la commande). La TVA récupérable n'est pas une charge : on compte hors taxes, comme la comptabilité.
 * Un engagement daté d'un mois déjà passé est ramené au mois courant (il n'est pas encore payé). Hors de l'année : ignoré.
 */
async function commitmentsByMonth(req, year) {
  const t = today(); const cur = t.startsWith(year) ? Number(t.slice(5, 7)) : year < t.slice(0, 4) ? 12 : 1;
  const out = new Map(); // catégorie (minuscules) -> { category, months[12], items[] }
  const put = (cat, date, amount, item) => {
    if (!(amount > 0)) return;
    const d = date || t;
    if (d.slice(0, 4) > year) return;
    let m = d.slice(0, 4) < year ? 1 : Number(d.slice(5, 7));
    if (m < cur) m = cur;
    const k = norm(cat || 'Achats');
    if (!out.has(k)) out.set(k, { category: cat || 'Achats', months: Array(12).fill(0), items: [] });
    const x = out.get(k); x.months[m - 1] += amount; x.items.push({ ...item, amount, month: m });
  };
  const old = await Annual.commitments(req);
  for (const o of old.orders.filter((x) => x.status !== 'pending')) put('Achats', o.promisedDate, o.amount, { source: 'stock_order', id: o.id, label: `Commande #${o.id} ${o.item}`, party: o.supplier, date: o.promisedDate });
  const orders = await db.prepare(`SELECT o.*, s.name AS supplier FROM pur_orders o LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND o.status IN ('approved','sent','partial','received') ORDER BY o.id`).all(req.org.id);
  for (const o of orders) {
    const ht = Number((await db.prepare('SELECT COALESCE(SUM(ROUND(quantity * unit_price)), 0) s FROM pur_order_lines WHERE order_id = ?').get(o.id)).s);
    const inv = Number((await db.prepare("SELECT COALESCE(SUM(ROUND(l.quantity * l.unit_price)), 0) s FROM pur_invoice_lines l JOIN pur_invoices i ON i.id = l.invoice_id WHERE i.order_id = ? AND i.status = 'approved'").get(o.id)).s);
    put(o.category || 'Achats', o.expected_date || o.order_date, Math.max(0, Math.round(ht - inv)), { source: 'pur_order', id: o.id, label: `Bon de commande ${o.number}`, party: o.supplier || '', date: o.expected_date || o.order_date, status: o.status });
  }
  return out;
}

/** Tableau de bord complet de l'année. */
async function dashboard(req, year, opts = {}) {
  const t = today(); const thisYear = t.slice(0, 4);
  // Mois en cours (1 à 12) et mois clos : l'année en cours n'a que les mois précédents de clos ; une année passée en a 12 ; une future, 0.
  const currentMonth = year === thisYear ? Number(t.slice(5, 7)) : year < thisYear ? 12 : 0;
  const closed = year === thisYear ? currentMonth - 1 : year < thisYear ? 12 : 0;
  const real = await Annual.realized(req.org.id, year);
  const prevReal = await Annual.realized(req.org.id, String(Number(year) - 1));
  const plans = await db.prepare('SELECT * FROM budget_annual WHERE org_id = ? AND year = ?').all(req.org.id, year);
  const commits = await commitmentsByMonth(req, year);
  const arr12 = (v) => { try { const a = JSON.parse(v); return Array.from({ length: 12 }, (_, i) => Number(a[i]) || 0); } catch { return Array(12).fill(0); } };
  const keys = new Map();
  const slot = (kind, category) => { const k = `${kind}|${norm(category)}`; if (!keys.has(k)) keys.set(k, { kind, category, planned: Array(12).fill(0), actual: Array(12).fill(0), prev: Array(12).fill(0), committed: Array(12).fill(0), commitItems: [] }); return keys.get(k); };
  for (const p of plans) slot(p.kind, p.category).planned = arr12(p.amounts);
  for (const v of real.values()) { const s = slot(v.kind, v.category); v.ledger.forEach((x, i) => { s.actual[i] += x + v.manual[i]; }); }
  for (const v of prevReal.values()) { const s = keys.get(`${v.kind}|${norm(v.category)}`); if (s) v.ledger.forEach((x, i) => { s.prev[i] += x + v.manual[i]; }); }
  for (const c of commits.values()) { const s = slot('expense', c.category); c.months.forEach((x, i) => { s.committed[i] += x; }); s.commitItems.push(...c.items); }
  const oPct = pctParam(opts.optimistic, 10); const pPct = pctParam(opts.pessimistic, 10);
  const lines = [...keys.values()].map((l) => {
    const plannedTotal = C.sum(l.planned); const actualTotal = C.sum(l.actual); const committed = C.sum(l.committed);
    const hasPrev = C.sum(l.prev) > 0;
    const f = C.forecastSeries({ actual: l.actual, planned: l.planned, prev: hasPrev ? l.prev : null, closed, committed: l.kind === 'expense' ? committed : 0, kind: l.kind });
    const ytdPlanned = C.sum(l.planned.slice(0, currentMonth)); const ytdActual = C.sum(l.actual.slice(0, currentMonth));
    const ytdVar = ytdActual - ytdPlanned;
    const projVar = f.landing - plannedTotal;
    // Statut d'une ligne. Dépense : « over » si réalisé + engagé > prévu ; « risk » si l'atterrissage dépasse le prévu ; « watch » si le réalisé
    // à date dépasse le prévu à date de plus de 10 % ; « unplanned » : dépense sans budget. Recette : « risk » si l'atterrissage reste sous le
    // prévu de plus de 10 %, « watch » si le réalisé à date est sous le prévu à date de plus de 10 %.
    let status = 'ok';
    if (l.kind === 'expense') {
      if (!plannedTotal && (actualTotal || committed)) status = 'unplanned';
      else if (plannedTotal && actualTotal + committed > plannedTotal) status = 'over';
      else if (plannedTotal && f.landing > plannedTotal) status = 'risk';
      else if (ytdPlanned && ytdVar * 100 > ytdPlanned * TOL) status = 'watch';
    } else if (plannedTotal && f.landing * 100 < plannedTotal * (100 - TOL)) status = 'risk';
    else if (ytdPlanned && -ytdVar * 100 > ytdPlanned * TOL) status = 'watch';
    const closedActual = C.sum(l.actual.slice(0, closed));
    const floor = l.kind === 'expense' ? actualTotal + committed : actualTotal;
    return {
      kind: l.kind, category: l.category, planned: l.planned, actual: l.actual, committedByMonth: l.committed, prevYear: hasPrev ? l.prev : null,
      plannedTotal, actualTotal, committed, ytdPlanned, ytdActual, ytdVariance: ytdVar, ytdVariancePct: pctOf(ytdVar, ytdPlanned),
      remaining: l.kind === 'expense' ? plannedTotal - actualTotal - committed : plannedTotal - actualTotal,
      consumedPct: pctOf(actualTotal + (l.kind === 'expense' ? committed : 0), plannedTotal),
      landing: f.landing, low: f.low, high: f.high, halfWidth: f.halfWidth, method: f.method, methods: f.methods, confidence: f.confidence, forecast: f.forecast, growth: f.growth,
      projectedVariance: projVar, projectedVariancePct: pctOf(projVar, plannedTotal), favorable: l.kind === 'expense' ? projVar <= 0 : projVar >= 0, status,
      scenarios: { optimistic: C.scenario(f.landing, closedActual, floor, l.kind, oPct, 'optimistic'), central: f.landing, pessimistic: C.scenario(f.landing, closedActual, floor, l.kind, pPct, 'pessimistic') },
      commitItems: l.commitItems.slice(0, 50),
    };
  }).sort((a, b) => (a.kind === b.kind ? b.plannedTotal + b.actualTotal - (a.plannedTotal + a.actualTotal) : a.kind === 'expense' ? -1 : 1));

  const side = (kind) => {
    const L = lines.filter((l) => l.kind === kind);
    const m = (f) => Array.from({ length: 12 }, (_, i) => C.sum(L.map((l) => f(l)[i] || 0)));
    const planned = m((l) => l.planned); const actual = m((l) => l.actual); const committed = m((l) => l.committedByMonth);
    const forecast = Array.from({ length: 12 }, (_, i) => (i < closed ? null : C.sum(L.map((l) => l.forecast[i] || 0))));
    const plannedTotal = C.sum(planned); const actualTotal = C.sum(actual); const committedTotal = C.sum(committed);
    const landing = C.sum(L.map((l) => l.landing));
    // Fourchette du total : les écarts des catégories sont supposés indépendants, les demi-largeurs s'additionnent « en quadrature ».
    const half = Math.sqrt(C.sum(L.map((l) => l.halfWidth * l.halfWidth)));
    const floor = actualTotal + (kind === 'expense' ? committedTotal : 0);
    const ytdPlanned = C.sum(planned.slice(0, currentMonth)); const ytdActual = C.sum(actual.slice(0, currentMonth));
    // Rythme de consommation (burn rate) : moyenne mensuelle du réalisé des mois clos, et des 3 derniers mois clos.
    const hist = actual.slice(0, closed);
    let cumP = 0; let cumA = 0;
    const cumPlanned = planned.map((x) => (cumP += x));
    const cumActual = actual.map((x, i) => (i < currentMonth ? (cumA += x) : null));
    let cumF = 0;
    const cumForecast = actual.map((x, i) => (cumF += i < closed ? x : forecast[i]));
    return {
      planned, actual, committed, forecast, cumPlanned, cumActual, cumForecast,
      plannedTotal, actualTotal, committedTotal, ytdPlanned, ytdActual, ytdVariance: ytdActual - ytdPlanned, ytdVariancePct: pctOf(ytdActual - ytdPlanned, ytdPlanned),
      remaining: plannedTotal - actualTotal - (kind === 'expense' ? committedTotal : 0), consumedPct: pctOf(actualTotal + (kind === 'expense' ? committedTotal : 0), plannedTotal),
      burnRate: hist.length ? Math.round(C.sum(hist) / hist.length) : null, burnRate3: hist.length ? Math.round(C.sum(hist.slice(-3)) / hist.slice(-3).length) : null,
      landing, low: Math.round(Math.max(floor, landing - half)), high: Math.round(landing + half), landingVariance: landing - plannedTotal, landingVariancePct: pctOf(landing - plannedTotal, plannedTotal),
      scenarios: { optimistic: C.sum(L.map((l) => l.scenarios.optimistic)), central: landing, pessimistic: C.sum(L.map((l) => l.scenarios.pessimistic)) },
    };
  };
  const expense = side('expense'); const income = side('income');
  const scen = (k) => ({ income: income.scenarios[k], expense: expense.scenarios[k], result: income.scenarios[k] - expense.scenarios[k] });
  const alerts = [];
  for (const l of lines) if (l.status !== 'ok') alerts.push({ code: l.status, kind: l.kind, category: l.category, planned: l.plannedTotal, actual: l.actualTotal, committed: l.committed, landing: l.landing, variance: l.kind === 'expense' && l.status === 'over' ? l.actualTotal + l.committed - l.plannedTotal : l.projectedVariance, ytdVariancePct: l.ytdVariancePct });
  const sev = { over: 0, unplanned: 1, risk: 2, watch: 3 };
  alerts.sort((a, b) => sev[a.code] - sev[b.code] || Math.abs(b.variance) - Math.abs(a.variance));
  const overruns = lines.filter((l) => l.kind === 'expense' && l.plannedTotal > 0)
    .map((l) => ({ category: l.category, planned: l.plannedTotal, actual: l.actualTotal, committed: l.committed, landing: l.landing, overrun: Math.max(l.actualTotal + l.committed, l.landing) - l.plannedTotal }))
    .filter((x) => x.overrun > 0).sort((a, b) => b.overrun - a.overrun).slice(0, 5);
  return {
    year, asOf: t, currentMonth, closedMonths: closed, hasPlan: plans.length > 0, hasPrevYear: [...prevReal.values()].some((v) => C.sum(v.ledger) + C.sum(v.manual) > 0),
    kpis: {
      expensePlanned: expense.plannedTotal, expenseActual: expense.actualTotal, committed: expense.committedTotal, expenseRemaining: expense.remaining, expenseConsumedPct: expense.consumedPct,
      expenseYtdPlanned: expense.ytdPlanned, expenseYtdActual: expense.ytdActual, expenseYtdVariance: expense.ytdVariance, expenseYtdVariancePct: expense.ytdVariancePct,
      burnRate: expense.burnRate, burnRate3: expense.burnRate3, expenseLanding: expense.landing, expenseLow: expense.low, expenseHigh: expense.high, expenseLandingVariance: expense.landingVariance, expenseLandingVariancePct: expense.landingVariancePct,
      incomePlanned: income.plannedTotal, incomeActual: income.actualTotal, incomeLanding: income.landing, incomeLow: income.low, incomeHigh: income.high, incomeYtdVariancePct: income.ytdVariancePct,
      resultPlanned: income.plannedTotal - expense.plannedTotal, resultActual: income.actualTotal - expense.actualTotal, resultLanding: income.landing - expense.landing,
      alerts: alerts.length,
    },
    monthly: { expense, income },
    categories: lines, alerts, topOverruns: overruns,
    scenarios: { optimisticPct: oPct, pessimisticPct: pPct, optimistic: scen('optimistic'), central: scen('central'), pessimistic: scen('pessimistic'), plan: { income: income.plannedTotal, expense: expense.plannedTotal, result: income.plannedTotal - expense.plannedTotal } },
    method: {
      closedMonths: 'Mois clos : les mois avant le mois en cours. Les prévisions partent des mois clos ; le mois en cours ne descend jamais sous ce qui est déjà constaté.',
      landing: "Atterrissage : saisonnalité de l'an passé si elle existe, sinon tendance linéaire (3 mois clos au moins), sinon rythme des 3 derniers mois, sinon le prévu.",
      range: 'Fourchette à 80 % : ± 1,28 × écart-type des écarts passés × racine du nombre de mois restants.',
      committed: 'Engagé : commandes validées pas encore facturées (hors taxes). Une dépense ne peut pas atterrir sous réalisé + engagé.',
    },
    notice: Annual.NOTICE,
  };
}

router.get('/pro', admin, async (req, res) => {
  const d = await dashboard(req, yearOf(req.query.year), { optimistic: req.query.optimistic, pessimistic: req.query.pessimistic });
  res.json(d);
});

/** Détail d'une case (catégorie, mois facultatif) jusqu'à la source : lignes d'écritures, saisies hors compta, engagements. */
router.get('/pro/drill', admin, async (req, res) => {
  const year = yearOf(req.query.year);
  const kind = A.oneOf(req.query.kind, ['income', 'expense'], 'expense', 'Type : entrée ou sortie.');
  const category = A.text(req.query.category, 60, { required: true, msg: 'Indiquez une catégorie.' });
  const month = req.query.month === undefined || req.query.month === '' ? null : Number(req.query.month);
  if (month !== null && !(Number.isInteger(month) && month >= 1 && month <= 12)) throw new HttpError(400, 'Mois invalide (1 à 12).');
  const from = month ? `${year}-${String(month).padStart(2, '0')}-01` : `${year}-01-01`;
  const to = month ? `${year}-${String(month).padStart(2, '0')}-31` : `${year}-12-31`;
  const map = await Annual.mapOf(req.org.id);
  const cls = kind === 'expense' ? '6' : '7';
  const rows = await db.prepare(`SELECT e.id AS entry_id, e.number, e.journal, e.date, e.label, e.source, l.account, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? AND l.account LIKE ? AND e.source NOT IN ('year_end', 'year_end_rev') ORDER BY e.date, e.id LIMIT 2000`).all(req.org.id, from, to, `${cls}%`);
  const ledger = rows.filter((r) => norm(Annual.categoryOf(map, r.account)) === norm(category))
    .map((r) => ({ entryId: r.entry_id, number: r.number, journal: r.journal, date: r.date, label: r.label, account: r.account, source: r.source, amount: kind === 'expense' ? r.debit - r.credit : r.credit - r.debit }));
  const manual = (await db.prepare(`SELECT b.id, b.date, b.label, b.amount, b.source FROM budget_entries b WHERE b.org_id = ? AND b.kind = ? AND LOWER(b.category) = LOWER(?) AND b.date >= ? AND b.date <= ? AND ${Annual.UNCOVERED} ORDER BY b.date, b.id LIMIT 1000`).all(req.org.id, kind, category, from, to))
    .map((b) => ({ id: b.id, date: b.date, label: b.label, amount: Number(b.amount), source: b.source }));
  let commitments = [];
  if (kind === 'expense') {
    const c = (await commitmentsByMonth(req, year)).get(norm(category));
    commitments = c ? c.items.filter((i) => !month || i.month === month) : [];
  }
  res.json({ year, kind, category, month, ledger, manual, commitments, totals: { ledger: C.sum(ledger.map((x) => x.amount)), manual: C.sum(manual.map((x) => x.amount)), commitments: C.sum(commitments.map((x) => x.amount)) } });
});

/** Export CSV (séparateur « ; », s'ouvre dans Excel) : une ligne par catégorie, avec les 12 mois du réalisé. */
router.get('/pro/export.csv', admin, async (req, res) => {
  const year = yearOf(req.query.year);
  const d = await dashboard(req, year, {});
  const head = ['Type', 'Catégorie', 'Prévu année', 'Prévu à date', 'Réalisé à date', 'Écart à date', 'Écart à date %', 'Engagé', 'Reste', 'Atterrissage', 'Fourchette basse', 'Fourchette haute', 'Écart prévu fin d\'année', 'Statut']
    .concat(Array.from({ length: 12 }, (_, i) => `Réalisé ${year}-${String(i + 1).padStart(2, '0')}`));
  const rows = [head].concat(d.categories.map((l) => [l.kind === 'expense' ? 'Dépense' : 'Recette', l.category, l.plannedTotal, l.ytdPlanned, l.ytdActual, l.ytdVariance, l.ytdVariancePct === null ? '' : l.ytdVariancePct, l.committed, l.remaining, l.landing, l.low, l.high, l.projectedVariance, l.status].concat(l.actual)));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="budget-${year}.csv"`);
  res.send(require('./purchasing-lib').csv(rows));
});

module.exports = router;
module.exports.dashboard = dashboard;
module.exports.commitmentsByMonth = commitmentsByMonth;
