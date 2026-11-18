'use strict';
// Recherche opérationnelle : simplexe (programmation linéaire, deux phases, règle de Bland), prix duaux, élasticité-prix.
// Calculs purs, sans dépendance. Deux scénarios prêts à l'emploi :
//  - « sale » : mix de produits qui MAXIMISE la marge sous contraintes (matières, heures, capacité, demande) + prix de vente optimal par élasticité ;
//  - « production » : répartition d'une demande entre sources (atelier, sous-traitant…) qui MINIMISE le coût, avec prix de vente conseillé.
const EPS = 1e-9;
const r0 = (n) => Math.round(n);
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Résout : opt (max|min) c·x  sous  rows[i].a·x (<=|>=|=) rows[i].b,  lb ≤ x ≤ ub.
 * Renvoie { status: 'optimal'|'infeasible'|'unbounded', x, value }.
 */
function solveLP({ sense = 'max', c, lb, ub, rows }) {
  const n = c.length;
  const lo = c.map((_, j) => (lb && Number.isFinite(lb[j]) ? lb[j] : 0));
  const hi = c.map((_, j) => (ub && ub[j] !== undefined && ub[j] !== null && Number.isFinite(ub[j]) ? ub[j] : Infinity));
  for (let j = 0; j < n; j++) if (hi[j] < lo[j] - EPS) return { status: 'infeasible' };
  const sgn = sense === 'max' ? -1 : 1; // on minimise toujours sgn × c · x
  const cost = c.map((v) => sgn * v);
  const R = [];
  for (const r of rows) R.push({ a: r.a.slice(), op: r.op, b: r.b - r.a.reduce((s, v, j) => s + v * lo[j], 0) });
  for (let j = 0; j < n; j++) if (hi[j] !== Infinity) { const a = Array(n).fill(0); a[j] = 1; R.push({ a, op: '<=', b: hi[j] - lo[j] }); }
  for (const r of R) if (r.b < 0) { r.a = r.a.map((v) => -v); r.b = -r.b; r.op = r.op === '<=' ? '>=' : r.op === '>=' ? '<=' : '='; }
  const m = R.length;
  let cols = n; const slackOf = []; const artOf = [];
  for (const r of R) { if (r.op === '<=' || r.op === '>=') slackOf.push(cols++); else slackOf.push(-1); }
  for (const r of R) { if (r.op === '>=' || r.op === '=') artOf.push(cols++); else artOf.push(-1); }
  const T = R.map((r, i) => {
    const row = Array(cols + 1).fill(0);
    r.a.forEach((v, j) => { row[j] = v; });
    if (slackOf[i] >= 0) row[slackOf[i]] = r.op === '<=' ? 1 : -1;
    if (artOf[i] >= 0) row[artOf[i]] = 1;
    row[cols] = r.b;
    return row;
  });
  const basis = R.map((r, i) => (artOf[i] >= 0 ? artOf[i] : slackOf[i]));
  const isArt = (j) => artOf.includes(j) && j >= 0;
  const pivot = (pi, pj) => {
    const pv = T[pi][pj];
    for (let j = 0; j <= cols; j++) T[pi][j] /= pv;
    for (let i = 0; i < m; i++) if (i !== pi && Math.abs(T[i][pj]) > 0) { const f = T[i][pj]; for (let j = 0; j <= cols; j++) T[i][j] -= f * T[pi][j]; }
    basis[pi] = pj;
  };
  // Optimise la fonction objectif obj (à minimiser) ; allowed(j) : colonnes autorisées à entrer.
  const optimise = (obj, allowed) => {
    for (let it = 0; it < 5000; it++) {
      // coûts réduits : obj_j - Σ obj_B(i) T[i][j]
      let enter = -1;
      for (let j = 0; j < cols; j++) {
        if (!allowed(j)) continue;
        let rc = obj[j];
        for (let i = 0; i < m; i++) rc -= obj[basis[i]] * T[i][j];
        if (rc < -1e-9) { enter = j; break; } // Bland : plus petit indice
      }
      if (enter < 0) return 'optimal';
      let leave = -1; let best = Infinity;
      for (let i = 0; i < m; i++) if (T[i][enter] > 1e-9) { const ratio = T[i][cols] / T[i][enter]; if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && basis[i] < basis[leave])) { best = ratio; leave = i; } }
      if (leave < 0) return 'unbounded';
      pivot(leave, enter);
    }
    return 'unbounded';
  };
  if (artOf.some((a) => a >= 0)) {
    const o1 = Array(cols).fill(0); artOf.forEach((a) => { if (a >= 0) o1[a] = 1; });
    optimise(o1, () => true);
    const infeas = T.reduce((s, row, i) => s + (isArt(basis[i]) ? row[cols] : 0), 0);
    if (infeas > 1e-7) return { status: 'infeasible' };
    for (let i = 0; i < m; i++) if (isArt(basis[i])) { const j = [...Array(cols).keys()].find((k) => !isArt(k) && Math.abs(T[i][k]) > 1e-9); if (j !== undefined) pivot(i, j); }
  }
  const o2 = Array(cols).fill(0); cost.forEach((v, j) => { o2[j] = v; });
  const st = optimise(o2, (j) => !isArt(j));
  if (st === 'unbounded') return { status: 'unbounded' };
  const x = lo.slice();
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] += T[i][cols];
  return { status: 'optimal', x: x.map((v) => (Math.abs(v) < 1e-9 ? 0 : v)), value: c.reduce((s, v, j) => s + v * x[j], 0) };
}

// ---------- Validation des hypothèses saisies ----------
function num(v, label, { min = 0, max = 1e12, required = true, def = 0 } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw new Error(`${label} : valeur manquante.`); return def; }
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} : nombre invalide.`);
  return n;
}
const name = (v, def) => String(v == null || String(v).trim() === '' ? def : v).trim().slice(0, 80);

function readSale(inp) {
  const prods = Array.isArray(inp.products) ? inp.products : [];
  if (!prods.length) throw new Error('Ajoutez au moins un produit.');
  if (prods.length > 12) throw new Error('12 produits au plus.');
  const res = Array.isArray(inp.resources) ? inp.resources : [];
  if (res.length > 12) throw new Error('12 contraintes au plus.');
  const products = prods.map((p, i) => ({
    name: name(p.name, `Produit ${i + 1}`), price: num(p.price, 'Prix de vente'), unitCost: num(p.unitCost, 'Coût variable unitaire', { required: false }),
    minQty: num(p.minQty, 'Quantité minimale', { required: false }), maxQty: p.maxQty === undefined || p.maxQty === null || p.maxQty === '' ? null : num(p.maxQty, 'Demande maximale'),
  }));
  const resources = res.map((r, i) => {
    const uses = Array.isArray(r.uses) ? r.uses : [];
    return { name: name(r.name, `Ressource ${i + 1}`), unit: name(r.unit, ''), capacity: num(r.capacity, 'Capacité'), uses: products.map((_, j) => num(uses[j], 'Consommation', { required: false })) };
  });
  const fixedCosts = num(inp.fixedCosts, 'Charges fixes', { required: false });
  let priceAnalysis = null;
  const pa = inp.priceAnalysis;
  if (pa && pa.basePrice !== undefined && pa.basePrice !== '' && pa.baseQty !== undefined && pa.baseQty !== '') {
    const basePrice = num(pa.basePrice, 'Prix actuel', { min: 0.0001 });
    priceAnalysis = {
      basePrice, baseQty: num(pa.baseQty, 'Ventes actuelles', { min: 0.0001 }), unitCost: num(pa.unitCost, 'Coût unitaire', { required: false }),
      elasticity: num(pa.elasticity, 'Élasticité', { min: 0.05, max: 20 }), capacityQty: pa.capacityQty === undefined || pa.capacityQty === null || pa.capacityQty === '' ? null : num(pa.capacityQty, 'Capacité de production', { min: 0.0001 }),
      fixedCosts: num(pa.fixedCosts, 'Charges fixes', { required: false }),
    };
  }
  return { kind: 'sale', products, resources, fixedCosts, priceAnalysis };
}
function readProduction(inp) {
  const srcs = Array.isArray(inp.sources) ? inp.sources : [];
  if (!srcs.length) throw new Error('Ajoutez au moins une source de production.');
  if (srcs.length > 12) throw new Error('12 sources au plus.');
  const res = Array.isArray(inp.resources) ? inp.resources : [];
  if (res.length > 12) throw new Error('12 contraintes au plus.');
  const d = inp.demand || {};
  const sources = srcs.map((s, i) => ({ name: name(s.name, `Source ${i + 1}`), unitCost: num(s.unitCost, 'Coût unitaire'), capacity: s.capacity === undefined || s.capacity === null || s.capacity === '' ? null : num(s.capacity, 'Capacité'), minQty: num(s.minQty, 'Quantité minimale', { required: false }) }));
  const resources = res.map((r, i) => {
    const uses = Array.isArray(r.uses) ? r.uses : [];
    return { name: name(r.name, `Ressource ${i + 1}`), unit: name(r.unit, ''), capacity: num(r.capacity, 'Capacité'), uses: sources.map((_, j) => num(uses[j], 'Consommation', { required: false })) };
  });
  return {
    kind: 'production', demand: { name: name(d.name, 'Production demandée'), qty: num(d.qty, 'Quantité à produire', { min: 0.0001 }), unit: name(d.unit, 'unités') },
    sources, resources, fixedCosts: num(inp.fixedCosts, 'Charges fixes', { required: false }),
    targetMarginPct: inp.targetMarginPct === undefined || inp.targetMarginPct === '' || inp.targetMarginPct === null ? null : num(inp.targetMarginPct, 'Marge visée (%)', { max: 95 }),
  };
}

// ---------- Prix de vente optimal (élasticité constante) ----------
function priceCurve(pa) {
  const { basePrice: p0, baseQty: q0, unitCost: c, elasticity: e, capacityQty: cap, fixedCosts: fx } = pa;
  const qAt = (p) => { const q = q0 * Math.pow(p / p0, -e); return cap !== null && cap !== undefined ? Math.min(q, cap) : q; };
  const marginAt = (p) => (p - c) * qAt(p);
  const lo = Math.max(c * 1.001, p0 * 0.5, 0.0001); const hi = Math.max(p0 * 2, lo * 1.5);
  const pts = []; const N = 40;
  for (let k = 0; k <= N; k++) { const p = lo + (hi - lo) * k / N; pts.push({ price: r2(p), qty: r2(qAt(p)), margin: r0(marginAt(p)), revenue: r0(p * qAt(p)), profit: r0(marginAt(p) - fx) }); }
  // Optimum : formule fermée c·e/(e-1) si e > 1 ; recherche fine sur la grille sinon ou si la capacité limite les ventes.
  let best = { price: p0, margin: marginAt(p0) };
  for (let k = 0; k <= 4000; k++) { const p = lo + (hi - lo) * k / 4000; const mg = marginAt(p); if (mg > best.margin + 1e-9) best = { price: p, margin: mg }; }
  const closed = e > 1 ? c * e / (e - 1) : null;
  const atEdge = best.price >= hi - (hi - lo) / 4000 * 2;
  return {
    points: pts, current: { price: p0, qty: r2(q0), margin: r0(marginAt(p0)), profit: r0(marginAt(p0) - fx) },
    optimal: { price: r0(best.price), qty: r2(qAt(best.price)), margin: r0(best.margin), profit: r0(best.margin - fx), formulaPrice: closed === null ? null : r0(closed), atEdge, gain: r0(best.margin - marginAt(p0)), changePct: r2((best.price / p0 - 1) * 100) },
    range: { from: r2(lo), to: r2(hi) }, elasticity: e,
  };
}

function lpRows(items, resources, extra) {
  return resources.map((r) => ({ a: r.uses.slice(), op: '<=', b: r.capacity, name: r.name })).concat(extra || []);
}
/** Valeur d'une unité de capacité en plus : on résout à nouveau avec la capacité augmentée (prix dual, lu comme un gain concret). */
function shadow(base, rowIndex, bump, obj, solveWith) {
  const alt = solveWith(rowIndex, bump);
  if (!alt || alt.status !== 'optimal') return 0;
  return r4((alt.value - base.value) / bump);
}


/** Contraintes sous forme de lignes (ressources, plafonds), puis tableau lisible : utilisé, marge restante, saturation et valeur d'une unité en plus. */
function constraintTable(rows, x, sol, run, firstIdx, sign) {
  return rows.slice(firstIdx).map((r, k) => {
    const i = firstIdx + k;
    const used = r.a.reduce((s, v, j) => s + v * x[j], 0);
    const bump = Math.max(r.b * 0.01, 1);
    return { name: r.name, unit: r.unit || '', kind: r.kind, capacity: r.b, used: r2(used), slack: r2(r.b - used), usePct: r.b > 0 ? r2(used / r.b * 100) : 0, saturated: r.b - used < 1e-6 * Math.max(1, r.b), shadowPrice: sign * shadow(sol, i, bump, null, run) };
  });
}

// ---------- Scénario VENTE ----------
function solveSale(inp) {
  const n = inp.products.length;
  const c = inp.products.map((p) => p.price - p.unitCost);
  const lb = inp.products.map((p) => p.minQty);
  const rows = lpRows(inp.products, inp.resources).map((r, i) => ({ ...r, unit: inp.resources[i].unit, kind: 'resource' }));
  inp.products.forEach((p, j) => { if (p.maxQty !== null) rows.push({ a: inp.products.map((_, k) => (k === j ? 1 : 0)), op: '<=', b: p.maxQty, name: `Demande maximale : ${p.name}`, unit: '', kind: 'demand' }); });
  const run = (rowIdx, bump) => { const rr = rows.map((r, i) => (i === rowIdx ? { ...r, b: r.b + bump } : r)); return solveLP({ sense: 'max', c, lb, rows: rr }); };
  const sol = solveLP({ sense: 'max', c, lb, rows });
  const out = { kind: 'sale', status: sol.status, objective: 'max' };
  if (sol.status === 'optimal') {
    const x = sol.x;
    const lines = inp.products.map((p, j) => ({ name: p.name, qty: r2(x[j]), price: p.price, unitCost: p.unitCost, unitMargin: r2(p.price - p.unitCost), revenue: r0(p.price * x[j]), variableCost: r0(p.unitCost * x[j]), margin: r0((p.price - p.unitCost) * x[j]), maxQty: p.maxQty, atDemand: p.maxQty !== null && Math.abs(x[j] - p.maxQty) < 1e-6 }));
    const cons = constraintTable(rows, x, sol, run, 0, 1);
    const totals = { revenue: lines.reduce((s, l) => s + l.revenue, 0), variableCost: lines.reduce((s, l) => s + l.variableCost, 0), margin: lines.reduce((s, l) => s + l.margin, 0) };
    totals.fixedCosts = r0(inp.fixedCosts); totals.profit = totals.margin - totals.fixedCosts; totals.marginPct = totals.revenue > 0 ? r2(totals.margin / totals.revenue * 100) : 0;
    const split = lines.filter((l) => l.variableCost > 0).map((l) => ({ name: l.name, value: l.variableCost }));
    if (inp.fixedCosts > 0) split.push({ name: '__fixed', value: r0(inp.fixedCosts) });
    // Quels produits ne sont pas fabriqués ? Pourquoi ?
    const unproduced = lines.filter((l) => l.qty < 1e-6).map((l) => l.name);
    // Marge de chaque produit par unité de la ressource la plus saturée (explique l'ordre de priorité).
    const tight = cons.filter((k) => k.saturated).sort((a, b) => b.shadowPrice - a.shadowPrice);
    Object.assign(out, { lines, constraints: cons, totals, costSplit: split, unproduced, binding: tight.map((k) => k.name) });
    // Valeur d'une unité de demande en plus pour les produits plafonnés par la demande.
  } else out.reason = sol.status;
  if (inp.priceAnalysis) out.price = priceCurve(inp.priceAnalysis);
  out.conclusion = conclude(out, inp);
  return out;
}

// ---------- Scénario PRODUCTION (coût minimal) ----------
function solveProduction(inp) {
  const n = inp.sources.length;
  const c = inp.sources.map((s) => s.unitCost);
  const lb = inp.sources.map((s) => s.minQty);
  const demandRow = { a: Array(n).fill(1), op: '>=', b: inp.demand.qty, name: inp.demand.name, kind: 'need' };
  const rows = [demandRow].concat(lpRows(null, inp.resources).map((r, i) => ({ ...r, unit: inp.resources[i].unit, kind: 'resource' })));
  inp.sources.forEach((s, j) => { if (s.capacity !== null) rows.push({ a: inp.sources.map((_, k) => (k === j ? 1 : 0)), op: '<=', b: s.capacity, name: `Capacité : ${s.name}`, unit: inp.demand.unit, kind: 'capacity' }); });
  const run = (rowIdx, bump) => { const rr = rows.map((r, i) => (i === rowIdx ? { ...r, b: r.b + bump } : r)); return solveLP({ sense: 'min', c, lb, rows: rr }); };
  const sol = solveLP({ sense: 'min', c, lb, rows });
  const out = { kind: 'production', status: sol.status, objective: 'min' };
  if (sol.status === 'optimal') {
    const x = sol.x; const total = x.reduce((s, v) => s + v, 0);
    const lines = inp.sources.map((s, j) => ({ name: s.name, qty: r2(x[j]), unitCost: s.unitCost, cost: r0(s.unitCost * x[j]), sharePct: total > 0 ? r2(x[j] / total * 100) : 0, capacity: s.capacity, atCapacity: s.capacity !== null && Math.abs(x[j] - s.capacity) < 1e-6 }));
    const cons = constraintTable(rows, x, sol, run, 1, -1);
    const variable = lines.reduce((s, l) => s + l.cost, 0);
    const totals = { variableCost: variable, fixedCosts: r0(inp.fixedCosts), totalCost: variable + r0(inp.fixedCosts), qty: r2(total) };
    totals.unitCost = total > 0 ? r2(totals.totalCost / total) : 0;
    totals.marginalCost = shadow(sol, 0, Math.max(inp.demand.qty * 0.01, 1), null, run); // coût de la dernière unité demandée
    if (inp.targetMarginPct !== null && inp.targetMarginPct !== undefined) totals.suggestedPrice = r0(totals.unitCost / (1 - inp.targetMarginPct / 100));
    // Référence : le coût si l'on produisait tout chez la source la moins chère, sans aucune limite.
    const cheapest = Math.min(...inp.sources.map((s) => s.unitCost));
    totals.idealCost = r0(cheapest * inp.demand.qty + inp.fixedCosts);
    totals.extraVsIdeal = totals.totalCost - totals.idealCost;
    const split = lines.filter((l) => l.cost > 0).map((l) => ({ name: l.name, value: l.cost }));
    if (inp.fixedCosts > 0) split.push({ name: '__fixed', value: r0(inp.fixedCosts) });
    Object.assign(out, { lines, constraints: cons, totals, costSplit: split, binding: cons.filter((k) => k.saturated).map((k) => k.name) });
  } else out.reason = sol.status;
  out.conclusion = conclude(out, inp);
  return out;
}

/** Phrase de conclusion pour un non-spécialiste : un code et des paramètres, traduits par le site. */
function conclude(res, inp) {
  if (res.status !== 'optimal') return { code: res.status === 'infeasible' ? 'infeasible' : 'unbounded', params: {} };
  if (res.kind === 'sale') {
    const top = [...res.lines].filter((l) => l.qty > 1e-6).sort((a, b) => b.margin - a.margin)[0];
    const tight = [...res.constraints].filter((k) => k.saturated && k.shadowPrice > 0).sort((a, b) => b.shadowPrice - a.shadowPrice)[0];
    const params = { profit: res.totals.profit, margin: res.totals.margin, top: top ? top.name : '', topQty: top ? top.qty : 0, limit: tight ? tight.name : '', gain: tight ? tight.shadowPrice : 0, unit: tight ? tight.unit : '' };
    if (res.price && res.price.optimal) { params.price = res.price.optimal.price; params.pricePct = res.price.optimal.changePct; params.priceGain = res.price.optimal.gain; }
    return { code: tight ? (res.price ? 'saleLimitPrice' : 'saleLimit') : (res.price ? 'saleFreePrice' : 'saleFree'), params };
  }
  const main = [...res.lines].sort((a, b) => b.qty - a.qty)[0];
  const tight = [...res.constraints].filter((k) => k.saturated && k.shadowPrice > 0).sort((a, b) => b.shadowPrice - a.shadowPrice)[0];
  const params = { cost: res.totals.totalCost, unitCost: res.totals.unitCost, main: main ? main.name : '', mainPct: main ? main.sharePct : 0, extra: res.totals.extraVsIdeal, limit: tight ? tight.name : '', gain: tight ? tight.shadowPrice : 0, unit: tight ? tight.unit : '', price: res.totals.suggestedPrice || 0 };
  return { code: tight ? 'prodLimit' : 'prodFree', params };
}

function solveScenario(kind, raw) {
  const inp = kind === 'sale' ? readSale(raw || {}) : kind === 'production' ? readProduction(raw || {}) : null;
  if (!inp) throw new Error('Type de scénario inconnu.');
  return { inputs: inp, result: kind === 'sale' ? solveSale(inp) : solveProduction(inp) };
}

/** Indicateurs clés d'un scénario enregistré, pour la comparaison. */
function keyMetrics(result) {
  if (!result || result.status !== 'optimal') return null;
  const t = result.totals;
  if (result.kind === 'sale') return { profit: t.profit, margin: t.margin, revenue: t.revenue, marginPct: t.marginPct, cost: t.variableCost + t.fixedCosts, price: result.price ? result.price.optimal.price : null };
  return { cost: t.totalCost, unitCost: t.unitCost, qty: t.qty, price: t.suggestedPrice || null };
}

module.exports = { solveLP, solveScenario, solveSale, solveProduction, priceCurve, keyMetrics, readSale, readProduction };
