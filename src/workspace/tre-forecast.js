'use strict';
// Trésorerie : moteur de prévision. FONCTIONS PURES (aucun accès à la base) : la prévision glissante, les scénarios « et si », la comparaison,
// l'échéancier de paiements optimisé, la balance âgée et la jauge du fonds de sécurité sont testables avec des nombres seulement.
// Un flux = { date:'AAAA-MM-JJ', amount (signé : + encaissement, − décaissement), group, source, label, ref? }.
const { addDays, diffDays, addMonths } = require('./tre-dates');

const r0 = (n) => Math.round(n);
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
const GROUPS = ['clients', 'fournisseurs', 'personnel', 'impots', 'emprunts', 'financiers', 'capital', 'investissements', 'autres'];

// ---------- Scénarios « et si » ----------
/** Normalise les paramètres d'un scénario (tout est facultatif ; nombres bornés). */
function cleanParams(p = {}) {
  const n = (v, lo, hi, d = 0) => { const x = Number(v); return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d; };
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const list = (a) => (Array.isArray(a) ? a.slice(0, 20) : []);
  const loan = p.loan && Number(p.loan.amount) > 0 && day(p.loan.date) ? { amount: r0(n(p.loan.amount, 0, 1e12)), date: day(p.loan.date), months: Math.round(n(p.loan.months, 1, 120, 12)), ratePct: n(p.loan.ratePct, 0, 60, 0) } : null;
  return {
    salesPct: n(p.salesPct, -100, 500), delayDays: Math.round(n(p.delayDays, 0, 365)), collectionLossPct: n(p.collectionLossPct, 0, 100), costPct: n(p.costPct, -100, 500),
    wagePct: n(p.wagePct, -100, 500), supplierDelayDays: Math.round(n(p.supplierDelayDays, 0, 365)), loan,
    capex: list(p.capex).filter((x) => day(x && x.date) && Number(x.amount) > 0).map((x) => ({ date: day(x.date), amount: r0(n(x.amount, 0, 1e12)), label: String(x.label || '').slice(0, 80) })),
    oneOffs: list(p.oneOffs).filter((x) => day(x && x.date) && Number(x.amount)).map((x) => ({ date: day(x.date), amount: r0(n(x.amount, -1e12, 1e12)), label: String(x.label || '').slice(0, 80) })),
  };
}

/** Annuité constante : échéances (capital + intérêts) d'un prêt à taux annuel `ratePct`. */
function loanSchedule({ amount, date, months, ratePct }) {
  const r = ratePct / 100 / 12;
  const pay = r > 0 ? amount * r / (1 - (1 + r) ** -months) : amount / months;
  let left = amount; const out = [];
  for (let i = 1; i <= months; i++) {
    const interest = r0(left * r); const principal = i === months ? left : Math.min(left, r0(pay) - interest);
    out.push({ date: addMonths(date, i), principal, interest, total: principal + interest }); left -= principal;
  }
  return out;
}

/** Applique un scénario à une liste de flux : renvoie une NOUVELLE liste (l'originale n'est jamais modifiée). */
function applyScenario(flows, params) {
  const p = cleanParams(params);
  const out = [];
  for (const f of flows) {
    let { date, amount } = f;
    const sale = f.group === 'clients' && amount > 0 && (f.source === 'invoice' || f.source === 'trend_sales');
    if (f.source === 'trend_sales') amount = amount * (1 + p.salesPct / 100);
    if (sale && p.delayDays) date = addDays(date, p.delayDays);
    if (sale && f.source === 'invoice' && p.collectionLossPct) amount = amount * (1 - p.collectionLossPct / 100);
    if (amount < 0 && ['bill', 'order', 'trend_purchases'].includes(f.source)) { amount = amount * (1 + p.costPct / 100); if (p.supplierDelayDays) date = addDays(date, p.supplierDelayDays); }
    if (amount < 0 && f.source === 'plan' && f.group === 'fournisseurs') amount = amount * (1 + p.costPct / 100);
    if (amount < 0 && f.group === 'personnel' && f.source === 'payroll') amount = amount * (1 + p.wagePct / 100);
    out.push({ ...f, date, amount: r0(amount) });
  }
  for (const c of p.capex) out.push({ date: c.date, amount: -c.amount, group: 'investissements', source: 'scenario', label: c.label || 'Investissement' });
  for (const o of p.oneOffs) out.push({ date: o.date, amount: o.amount, group: 'autres', source: 'scenario', label: o.label || 'Événement' });
  if (p.loan) {
    out.push({ date: p.loan.date, amount: p.loan.amount, group: 'emprunts', source: 'scenario', label: 'Nouveau prêt' });
    for (const e of loanSchedule(p.loan)) out.push({ date: e.date, amount: -e.total, group: 'emprunts', source: 'scenario', label: 'Échéance du nouveau prêt' });
  }
  return out;
}

// ---------- Prévision ----------
/**
 * Projette le solde jour après jour. Les flux déjà échus (date < from) sont ramenés au premier jour. opening = solde de départ.
 * Renvoie la série quotidienne, le point bas, le premier jour de découvert (solde < 0) et le premier jour sous le seuil minimal.
 */
function project({ flows, opening, from, days = 400, minBalance = 0 }) {
  const end = addDays(from, days - 1);
  const byDay = new Map();
  for (const f of flows) {
    const d = f.date < from ? from : f.date;
    if (d > end || !f.amount) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(f);
  }
  const daily = []; let bal = opening; let low = { date: from, balance: opening }; let overdraft = null; let belowMin = null;
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i); const list = byDay.get(date) || [];
    const inn = sum(list.filter((f) => f.amount > 0), (f) => f.amount); const out = -sum(list.filter((f) => f.amount < 0), (f) => f.amount);
    bal += inn - out;
    if (bal < low.balance || i === 0) low = { date, balance: bal };
    if (overdraft === null && bal < 0) overdraft = { date, balance: bal, daysAway: i };
    if (belowMin === null && bal < minBalance) belowMin = { date, balance: bal, daysAway: i };
    daily.push({ date, in: inn, out, net: inn - out, balance: bal, count: list.length });
  }
  return { from, end, opening, daily, low, overdraft, belowMin, closing: bal };
}

function bucketize(proj, flows, ranges) {
  return ranges.map((r) => {
    const days = proj.daily.filter((d) => d.date >= r.from && d.date <= r.to);
    const inn = sum(days, (d) => d.in); const out = sum(days, (d) => d.out);
    const by = {};
    for (const f of flows) {
      const d = f.date < proj.from ? proj.from : f.date;
      if (d >= r.from && d <= r.to) by[f.group] = (by[f.group] || 0) + f.amount;
    }
    const first = days[0];
    return { label: r.label, from: r.from, to: r.to, opening: first ? first.balance - first.net : proj.opening, in: inn, out, net: inn - out, closing: days.length ? days[days.length - 1].balance : proj.opening,
      min: days.length ? Math.min(...days.map((d) => d.balance)) : proj.opening, byGroup: by };
  });
}
/** 13 semaines glissantes : la semaine 1 commence aujourd'hui. */
function weekly(proj, flows, weeks = 13) {
  const ranges = Array.from({ length: weeks }, (_, i) => ({ label: `S${i + 1}`, from: addDays(proj.from, i * 7), to: addDays(proj.from, i * 7 + 6) }));
  return bucketize(proj, flows, ranges);
}
/** 12 mois glissants : le mois en cours (à partir d'aujourd'hui) puis les 11 suivants. */
function monthly(proj, flows, months = 12) {
  const ranges = []; const [y, m] = proj.from.split('-').map(Number);
  for (let i = 0; i < months; i++) {
    const first = new Date(Date.UTC(y, m - 1 + i, 1)); const last = new Date(Date.UTC(y, m + i, 0));
    const label = first.toISOString().slice(0, 7);
    ranges.push({ label, from: i === 0 ? proj.from : first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) });
  }
  return bucketize(proj, flows, ranges.filter((r) => r.from <= proj.end));
}

/** Prévision complète d'un jeu de flux. */
function forecast({ flows, opening, from, minBalance = 0 }) {
  const proj = project({ flows, opening, from, days: 400, minBalance });
  const w = weekly(proj, flows); const m = monthly(proj, flows);
  const w13 = proj.daily.slice(0, 91);
  return {
    from, opening, weeks: w, months: m, daily: proj.daily.slice(0, 120),
    low13: w13.reduce((a, d) => (d.balance < a.balance ? d : a), w13[0]),
    overdraft: proj.overdraft, belowMin: proj.belowMin, closing13: w13[w13.length - 1].balance, closing12m: proj.closing,
    totals13: { in: sum(w, (x) => x.in), out: sum(w, (x) => x.out) },
  };
}

/** Compare des scénarios côte à côte : [{ name, params }] appliqués aux mêmes flux. */
function compare({ flows, opening, from, minBalance = 0, scenarios }) {
  return scenarios.map((s) => {
    const f = s.params ? applyScenario(flows, s.params) : flows;
    const fc = forecast({ flows: f, opening, from, minBalance });
    return { id: s.id || null, name: s.name, params: s.params ? cleanParams(s.params) : null, weeks: fc.weeks.map((x) => ({ label: x.label, closing: x.closing, net: x.net })), months: fc.months.map((x) => ({ label: x.label, closing: x.closing, net: x.net })),
      low: fc.low13, overdraft: fc.overdraft, belowMin: fc.belowMin, closing13: fc.closing13, closing12m: fc.closing12m };
  });
}

/** Les trois scénarios de référence tirés d'un scénario central : pessimiste (−15 % de ventes, retard de 15 jours, 3 % d'impayés, +5 % de coûts) / optimiste (+10 % de ventes, coûts −3 %). */
const BASE_SCENARIOS = [
  { name: 'Pessimiste', key: 'pessimistic', params: { salesPct: -15, delayDays: 15, collectionLossPct: 3, costPct: 5 } },
  { name: 'Central', key: 'central', params: null },
  { name: 'Optimiste', key: 'optimistic', params: { salesPct: 10, costPct: -3 } },
];

// ---------- Calendrier ----------
/** Calendrier jour par jour d'un mois : flux du jour, détail et solde de fin de journée. */
function calendar(proj, flows, month) {
  const days = proj.daily.filter((d) => d.date.slice(0, 7) === month);
  return days.map((d) => ({ ...d, items: flows.filter((f) => (f.date < proj.from ? proj.from : f.date) === d.date).map((f) => ({ label: f.label, amount: f.amount, group: f.group, source: f.source })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 30) }));
}

// ---------- Balance âgée et risque d'impayé ----------
const BUCKETS = [['notDue', 'Non échu'], ['d30', '1 à 30 jours'], ['d60', '31 à 60 jours'], ['d90', '61 à 90 jours'], ['d90p', 'Plus de 90 jours']];
const bucketOf = (late) => (late <= 0 ? 'notDue' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'd90p');
/** invoices : [{ id, customerId, customer, number, due, left }] ; renvoie tranches, clients (avec risque) et provision conseillée. */
function aging(invoices, today, provision, history = {}) {
  const totals = Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));
  const byCust = new Map(); const items = [];
  for (const i of invoices) {
    const late = i.due ? diffDays(i.due, today) : 0; const b = bucketOf(late);
    totals[b] += i.left;
    const prov = r0(i.left * (provision[b] || 0) / 100);
    items.push({ ...i, late: Math.max(late, 0), bucket: b, provision: prov });
    const k = i.customerId; if (!byCust.has(k)) byCust.set(k, { customerId: k, customer: i.customer, total: 0, overdue: 0, maxLate: 0, count: 0, buckets: Object.fromEntries(BUCKETS.map(([x]) => [x, 0])), provision: 0 });
    const c = byCust.get(k); c.total += i.left; c.count++; c.buckets[b] += i.left; c.provision += prov;
    if (late > 0) { c.overdue += i.left; c.maxLate = Math.max(c.maxLate, late); }
  }
  const customers = [...byCust.values()].map((c) => {
    const avgDelay = (history[c.customerId] && history[c.customerId].avgDelay) || 0;
    const score = Math.min(100, r0((c.total ? c.overdue / c.total : 0) * 50 + Math.min(c.maxLate, 180) / 180 * 30 + Math.min(avgDelay, 60) / 60 * 20));
    return { ...c, avgDelay, riskScore: score, risk: score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low' };
  }).sort((a, b) => b.riskScore - a.riskScore || b.total - a.total);
  const total = sum(Object.values(totals));
  return { total, overdue: total - totals.notDue, buckets: BUCKETS.map(([k, label]) => ({ key: k, label, amount: totals[k], share: total ? Math.round(totals[k] / total * 1000) / 10 : 0 })), customers, items: items.sort((a, b) => b.late - a.late), provision: sum(items, (i) => i.provision) };
}

// ---------- Dettes fournisseurs : échéancier et paiements optimisés ----------
/**
 * Choisit quoi payer maintenant avec la trésorerie disponible (solde − fonds de sécurité) :
 *  1. dettes critiques (priorité 1) ou échues depuis plus de 30 jours ; 2. escomptes à saisir (rendement annualisé le plus fort d'abord) ; 3. échéances les plus proches.
 * bills : [{ id, supplier, supplierId, number, due, left, priority(1 critique,2 normal,3 reportable), discountPct, discountDays, billDate }]
 */
function optimizePayments({ bills, available, today }) {
  const info = bills.map((b) => {
    const late = diffDays(b.due, today);
    const canDiscount = b.discountPct > 0 && b.billDate && diffDays(b.billDate, today) <= b.discountDays;
    const saving = canDiscount ? r0(b.left * b.discountPct / 100) : 0;
    // rendement annualisé de l'escompte : on gagne `saving` en payant (due − today) jours plus tôt
    const early = Math.max(diffDays(today, b.due), 1);
    const yieldPct = canDiscount ? Math.round(b.discountPct / (100 - b.discountPct) * 365 / early * 100) : 0;
    const tier = b.priority === 1 || late > 30 ? 0 : canDiscount ? 1 : late > 0 ? 2 : 3;
    return { ...b, late: Math.max(late, 0), canDiscount, saving, yieldPct, tier };
  }).sort((a, b) => a.tier - b.tier || (a.tier === 1 ? b.yieldPct - a.yieldPct : 0) || a.due.localeCompare(b.due) || a.id - b.id);
  let cash = Math.max(available, 0); const pay = []; const defer = [];
  for (const b of info) {
    const due = b.canDiscount ? b.left - b.saving : b.left;
    const want = b.tier <= 2 || (diffDays(today, b.due) <= 7 && b.priority !== 3);
    if (want && due <= cash) { cash -= due; pay.push({ ...b, payAmount: due, reason: b.tier === 0 ? 'critical' : b.canDiscount ? 'discount' : b.late > 0 ? 'overdue' : 'soon' }); }
    else defer.push({ ...b, reason: !want ? (b.priority === 3 ? 'deferrable' : 'later') : 'cash', suggestedDate: addDays(today, b.priority === 3 ? 30 : 14) });
  }
  return { available: Math.max(available, 0), payNow: pay, defer, cashAfter: cash, paid: sum(pay, (x) => x.payAmount), saved: sum(pay, (x) => (x.reason === 'discount' ? x.saving : 0)), deferred: sum(defer, (x) => x.left) };
}

// ---------- Fonds de sécurité ----------
/** Jauge du fonds de sécurité : cible (montant, ou jours de charges), niveau actuel (trésorerie disponible), niveau d'alerte et recommandation. */
function safetyGauge({ mode, days, amount, dailyOut, available }) {
  const target = mode === 'amount' ? amount : r0(days * dailyOut);
  const coverageDays = dailyOut > 0 ? Math.round(available / dailyOut * 10) / 10 : null;
  const ratio = target > 0 ? available / target : null;
  const level = target <= 0 ? 'unset' : ratio >= 1 ? 'ok' : ratio >= 0.6 ? 'low' : ratio >= 0.25 ? 'alert' : 'critical';
  const gap = Math.max(target - available, 0);
  const weekly = gap > 0 ? r0(gap / 12) : 0; // reconstitution sur 12 semaines
  return { mode, target, available, coverageDays, dailyOut: r0(dailyOut), ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000, level, gap, surplus: Math.max(available - target, 0), recommendedWeekly: weekly };
}

module.exports = { GROUPS, cleanParams, loanSchedule, applyScenario, project, weekly, monthly, forecast, compare, BASE_SCENARIOS, calendar, bucketOf, aging, BUCKETS, optimizePayments, safetyGauge };
