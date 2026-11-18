'use strict';
// Finances d'un projet : CBS (structure de décomposition des coûts), ABC (coûts par activités), ROI / VAN / TRI / délai de récupération,
// budget prévisionnel mensuel, analyse des écarts (budget, réel, reste à faire, écart prix / quantité). Calculs purs, testés par test-projets-ro.js.
const r0 = (n) => Math.round(n);
const r2 = (n) => Math.round(n * 100) / 100;
const CATS = ['labor', 'material', 'equipment', 'subcontract', 'overhead', 'other'];
const money = (v, label, { neg = false } = {}) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || (!neg && n < 0) || Math.abs(n) > 1e13) throw new Error(`${label} : nombre invalide.`);
  return n;
};
const opt = (v, label) => (v === undefined || v === null || v === '' ? null : money(v, label));
const str = (v, max, def = '') => String(v == null ? def : v).trim().slice(0, max);

// ---------- CBS ----------
function cleanCbs(d) {
  const lines = Array.isArray(d && d.lines) ? d.lines : [];
  if (lines.length > 120) throw new Error('120 lignes au plus dans la structure des coûts.');
  const seen = new Set();
  return { lines: lines.map((l, i) => {
    const id = str(l.id || `c${i + 1}`, 20).replace(/[^\w-]/g, '') || `c${i + 1}`;
    if (seen.has(id)) throw new Error('Identifiant de ligne en double.');
    seen.add(id);
    const name = str(l.name, 120); if (!name) throw new Error(`Ligne ${i + 1} : donnez un nom.`);
    return { id, parentId: l.parentId ? str(l.parentId, 20) : null, code: str(l.code, 20), name, category: CATS.includes(l.category) ? l.category : 'other',
      budget: money(l.budget, 'Budget'), actual: money(l.actual, 'Réel'), etc: opt(l.etc, 'Reste à faire'),
      qtyB: opt(l.qtyB, 'Quantité prévue'), priceB: opt(l.priceB, 'Prix prévu'), qtyA: opt(l.qtyA, 'Quantité réelle'), priceA: opt(l.priceA, 'Prix réel') };
  }) };
}
/** Cumule les lignes feuilles vers leurs parents, calcule la prévision à terminer (réel + reste à faire) et les écarts (positif = économie). */
function cbsAnalyze(doc) {
  const lines = doc.lines.map((l) => ({ ...l }));
  const ids = new Set(lines.map((l) => l.id));
  const idx = new Map(lines.map((l, i) => [l.id, i]));
  for (const l of lines) if (l.parentId && (!ids.has(l.parentId) || l.parentId === l.id || idx.get(l.parentId) > idx.get(l.id))) l.parentId = null; // parent inconnu ou après : racine
  const kids = new Map(); for (const l of lines) if (l.parentId) { if (!kids.has(l.parentId)) kids.set(l.parentId, []); kids.get(l.parentId).push(l); }
  const level = (l) => (l.parentId ? level(lines[idx.get(l.parentId)]) + 1 : 0);
  const calc = new Map();
  const roll = (l) => {
    if (calc.has(l.id)) return calc.get(l.id);
    const ch = kids.get(l.id) || [];
    let o;
    if (ch.length) { const cs = ch.map(roll); o = { budget: cs.reduce((a, c) => a + c.budget, 0), actual: cs.reduce((a, c) => a + c.actual, 0), eac: cs.reduce((a, c) => a + c.eac, 0) }; }
    else { const etc = l.etc !== null ? l.etc : Math.max(l.budget - l.actual, 0); o = { budget: l.budget, actual: l.actual, eac: l.actual + etc }; }
    calc.set(l.id, o); return o;
  };
  const rows = lines.map((l) => {
    const c = roll(l); const leaf = !(kids.get(l.id) || []).length;
    const row = { id: l.id, parentId: l.parentId, code: l.code, name: l.name, category: l.category, level: level(l), leaf, budget: r0(c.budget), actual: r0(c.actual), eac: r0(c.eac), etc: r0(c.eac - c.actual),
      variance: r0(c.budget - c.eac), variancePct: c.budget > 0 ? r2((c.budget - c.eac) / c.budget * 100) : null, spentPct: c.budget > 0 ? r2(c.actual / c.budget * 100) : null, qtyB: l.qtyB, priceB: l.priceB, qtyA: l.qtyA, priceA: l.priceA, etcIn: l.etc };
    if (leaf && l.qtyB !== null && l.priceB !== null && l.qtyA !== null && l.priceA !== null) {
      // Écart sur coût = écart sur quantité (à prix prévu) + écart sur prix (à quantité réelle). Positif = favorable.
      row.qtyVariance = r0((l.qtyB - l.qtyA) * l.priceB); row.priceVariance = r0((l.priceB - l.priceA) * l.qtyA);
    }
    return row;
  });
  const roots = rows.filter((r) => !r.parentId);
  const tot = { budget: roots.reduce((a, r) => a + r.budget, 0), actual: roots.reduce((a, r) => a + r.actual, 0), eac: roots.reduce((a, r) => a + r.eac, 0) };
  tot.etc = tot.eac - tot.actual; tot.variance = tot.budget - tot.eac; tot.variancePct = tot.budget > 0 ? r2(tot.variance / tot.budget * 100) : null;
  const byCat = {}; for (const r of rows) if (r.leaf) byCat[r.category] = (byCat[r.category] || 0) + r.budget;
  // Paretto : lignes feuilles triées par dépassement.
  const worst = rows.filter((r) => r.leaf && r.variance < 0).sort((a, b) => a.variance - b.variance).slice(0, 5).map((r) => ({ id: r.id, name: r.name, variance: r.variance }));
  return { rows, totals: tot, byCategory: Object.entries(byCat).map(([category, budget]) => ({ category, budget: r0(budget) })), worst };
}

// ---------- ABC ----------
function cleanAbc(d) {
  const acts = Array.isArray(d && d.activities) ? d.activities : []; const objs = Array.isArray(d && d.objects) ? d.objects : [];
  if (acts.length > 20 || objs.length > 20) throw new Error('20 activités et 20 produits au plus.');
  return {
    activities: acts.map((a, i) => ({ name: str(a.name, 80) || `Activité ${i + 1}`, cost: money(a.cost, 'Coût de l\'activité'), driver: str(a.driver, 60, 'unité'), driverQty: money(a.driverQty, 'Volume du générateur de coût') })),
    objects: objs.map((o, i) => ({ name: str(o.name, 80) || `Produit ${i + 1}`, units: money(o.units, 'Unités produites') || 1, directCost: money(o.directCost, 'Coûts directs'), usage: acts.map((_, j) => money((o.usage || [])[j], 'Consommation')) })),
  };
}
function abcAnalyze(doc) {
  const rates = doc.activities.map((a) => ({ name: a.name, driver: a.driver, cost: a.cost, driverQty: a.driverQty, rate: a.driverQty > 0 ? a.cost / a.driverQty : 0 }));
  const used = doc.activities.map((_, j) => doc.objects.reduce((s, o) => s + o.usage[j], 0));
  const objects = doc.objects.map((o) => {
    const parts = rates.map((r, j) => ({ activity: r.name, amount: r0(r.rate * o.usage[j]) }));
    const indirect = parts.reduce((s, p) => s + p.amount, 0); const total = o.directCost + indirect;
    return { name: o.name, units: o.units, directCost: r0(o.directCost), indirect, total, unitCost: r0(total / o.units), parts };
  });
  const allocated = objects.reduce((s, o) => s + o.indirect, 0); const pool = rates.reduce((s, r) => s + r.cost, 0);
  // Comparaison avec la méthode classique : frais indirects répartis au prorata des coûts directs.
  const dsum = objects.reduce((s, o) => s + o.directCost, 0);
  objects.forEach((o) => { o.classicIndirect = dsum > 0 ? r0(pool * o.directCost / dsum) : r0(pool / (objects.length || 1)); o.classicUnitCost = r0((o.directCost + o.classicIndirect) / o.units); o.gap = o.unitCost - o.classicUnitCost; });
  const capacity = rates.map((r, j) => ({ activity: r.name, driver: r.driver, used: r2(used[j]), available: r.driverQty, usedPct: r.driverQty > 0 ? r2(used[j] / r.driverQty * 100) : 0, idleCost: r0(Math.max(r.driverQty - used[j], 0) * r.rate) }));
  return { rates: rates.map((r) => ({ ...r, cost: r0(r.cost), rate: r2(r.rate) })), objects, pool: r0(pool), allocated, unallocated: r0(pool - allocated), capacity };
}

// ---------- ROI ----------
function cleanRoi(d) {
  const flows = Array.isArray(d && d.flows) ? d.flows : [];
  if (flows.length > 30) throw new Error('30 périodes au plus.');
  const rate = money(d && d.discountRate, 'Taux d\'actualisation'); if (rate > 100) throw new Error('Taux d\'actualisation : entre 0 et 100 %.');
  return { investment: money(d && d.investment, 'Investissement'), residual: money(d && d.residual, 'Valeur de revente'), discountRate: rate, flows: flows.map((f) => money(f, 'Flux de trésorerie', { neg: true })), unit: str(d && d.unit, 12, 'an') };
}
function irr(cfs) {
  const npv = (r) => cfs.reduce((s, c, t) => s + c / Math.pow(1 + r, t), 0);
  let lo = -0.99; let hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}
function roiAnalyze(doc) {
  const inv = doc.investment; const n = doc.flows.length; const rate = doc.discountRate / 100;
  const flows = doc.flows.map((f, i) => (i === n - 1 ? f + doc.residual : f));
  const gain = flows.reduce((a, b) => a + b, 0);
  const cfs = [-inv].concat(flows);
  const van = cfs.reduce((s, c, t) => s + c / Math.pow(1 + rate, t), 0);
  let cum = -inv; const series = [{ period: 0, flow: -inv, cumulative: r0(cum), discounted: r0(-inv) }]; let dcum = -inv; let payback = null; let dpayback = null;
  flows.forEach((f, i) => {
    const prev = cum; cum += f; const dprev = dcum; dcum += f / Math.pow(1 + rate, i + 1);
    if (payback === null && cum >= 0 && f > 0) payback = i + (-prev) / f;
    if (dpayback === null && dcum >= 0 && f > 0) dpayback = i + (-dprev) / (f / Math.pow(1 + rate, i + 1));
    series.push({ period: i + 1, flow: r0(f), cumulative: r0(cum), discounted: r0(dcum) });
  });
  const t = irr(cfs);
  return { investment: r0(inv), totalGain: r0(gain), netGain: r0(gain - inv), roiPct: inv > 0 ? r2((gain - inv) / inv * 100) : null, annualRoiPct: inv > 0 && n > 0 ? r2((gain - inv) / inv / n * 100) : null,
    van: r0(van), irrPct: t === null ? null : r2(t * 100), payback: payback === null ? null : r2(payback), discountedPayback: dpayback === null ? null : r2(dpayback), profitabilityIndex: inv > 0 ? r2((van + inv) / inv) : null, series, discountRate: doc.discountRate, unit: doc.unit,
    verdict: inv <= 0 ? 'none' : van > 0 ? 'good' : gain > inv ? 'weak' : 'bad' };
}

// ---------- Budget prévisionnel ----------
function cleanForecast(d) {
  const per = Array.isArray(d && d.periods) ? d.periods : [];
  if (per.length > 60) throw new Error('60 mois au plus.');
  return { periods: per.map((p) => { const month = str(p.month, 7); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Mois invalide (AAAA-MM).'); return { month, planned: money(p.planned, 'Budget du mois'), revenue: money(p.revenue, 'Recettes prévues') }; }).sort((a, b) => (a.month < b.month ? -1 : 1)) };
}
/** actualByMonth : { 'AAAA-MM': dépense réelle }. thisMonth : mois courant. */
function forecastAnalyze(doc, actualByMonth, thisMonth) {
  let cp = 0; let ca = 0; let cr = 0;
  const rows = doc.periods.map((p) => {
    const a = actualByMonth[p.month] || 0; cp += p.planned; cr += p.revenue;
    const past = p.month <= thisMonth; if (past) ca += a;
    return { month: p.month, planned: r0(p.planned), actual: past ? r0(a) : null, revenue: r0(p.revenue), variance: past ? r0(p.planned - a) : null, cumPlanned: r0(cp), cumActual: past ? r0(ca) : null, cumRevenue: r0(cr), net: r0(p.revenue - p.planned), cumNet: r0(cr - cp), past };
  });
  const pastRows = rows.filter((r) => r.past);
  const plannedToDate = pastRows.reduce((s, r) => s + r.planned, 0); const actualToDate = pastRows.reduce((s, r) => s + (r.actual || 0), 0);
  const total = rows.reduce((s, r) => s + r.planned, 0);
  const burn = plannedToDate > 0 ? actualToDate / plannedToDate : null;
  return { rows, total: r0(total), plannedToDate: r0(plannedToDate), actualToDate: r0(actualToDate), variance: r0(plannedToDate - actualToDate), burnRate: burn === null ? null : r2(burn), projectedTotal: burn === null ? null : r0(actualToDate + (total - plannedToDate) * burn), revenue: r0(cr), margin: r0(cr - total) };
}

const CLEAN = { cbs: cleanCbs, abc: cleanAbc, roi: cleanRoi, forecast: cleanForecast };
module.exports = { CATS, CLEAN, cbsAnalyze, abcAnalyze, roiAnalyze, forecastAnalyze, irr };
