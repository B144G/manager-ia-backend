'use strict';
// PERT / chemin critique : calculs purs (aucune base de données), testés par scripts/test-projets-ro.js.
// Durées en jours. Durée attendue d'une tâche = (optimiste + 4 × probable + pessimiste) / 6 ; écart-type = (pessimiste - optimiste) / 6.
// Dépendances : FS fin-début, SS début-début, FF fin-fin, SF début-fin, avec décalage (jours, négatif = chevauchement autorisé).
const DAY = 86400000;
const dn = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
const dd = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const addDays = (d, n) => dd(dn(d) + n);
const r2 = (n) => Math.round(n * 100) / 100;
const TYPES = ['FS', 'SS', 'FF', 'SF'];
const EPS = 1e-9;

/** Fonction de répartition de la loi normale centrée réduite (approximation d'Abramowitz et Stegun, erreur < 1e-7). */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
/** Générateur pseudo-aléatoire reproductible (mulberry32) : même graine = mêmes résultats. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const expected = (o, m, p) => (o + 4 * m + p) / 6;
const sigma = (o, p) => (p - o) / 6;

/** Ordre topologique (Kahn). Renvoie { order } ou { cycle } avec les identifiants d'une boucle. */
function topo(ids, edges) {
  const indeg = new Map(ids.map((i) => [i, 0]));
  const out = new Map(ids.map((i) => [i, []]));
  for (const e of edges) { if (!indeg.has(e.from) || !indeg.has(e.to)) continue; indeg.set(e.to, indeg.get(e.to) + 1); out.get(e.from).push(e.to); }
  const q = ids.filter((i) => indeg.get(i) === 0);
  const order = [];
  while (q.length) {
    const i = q.shift(); order.push(i);
    for (const j of out.get(i)) { indeg.set(j, indeg.get(j) - 1); if (indeg.get(j) === 0) q.push(j); }
  }
  if (order.length === ids.length) return { order };
  // Une boucle : on suit les liens parmi les nœuds restants jusqu'à retomber sur un nœud déjà vu.
  const rest = new Set(ids.filter((i) => !order.includes(i)));
  const next = new Map();
  for (const e of edges) if (rest.has(e.from) && rest.has(e.to) && !next.has(e.from)) next.set(e.from, e.to);
  let cur = [...rest][0]; const seen = []; 
  while (cur !== undefined && !seen.includes(cur)) { seen.push(cur); cur = next.get(cur); }
  const cycle = cur === undefined ? [...rest] : seen.slice(seen.indexOf(cur));
  return { cycle };
}

/** Contrainte sur le début de la tâche suivante (j) donnée par la tâche précédente (i). */
function startBound(e, ES_i, EF_i, d_j) {
  const lag = e.lag || 0;
  switch (e.type) {
    case 'SS': return ES_i + lag;
    case 'FF': return EF_i + lag - d_j;
    case 'SF': return ES_i + lag - d_j;
    default: return EF_i + lag; // FS
  }
}

/** Passe avant pour des durées données : renvoie { ES, EF, end }. order : ordre topologique. */
function forward(order, dur, preds) {
  const ES = new Map(); const EF = new Map(); let end = 0;
  for (const j of order) {
    let s = 0;
    for (const e of preds.get(j) || []) s = Math.max(s, startBound(e, ES.get(e.from), EF.get(e.from), dur.get(j)));
    ES.set(j, s); EF.set(j, s + dur.get(j));
    if (EF.get(j) > end) end = EF.get(j);
  }
  return { ES, EF, end };
}

/**
 * Analyse PERT complète.
 * tasks : [{ id, title, o, m, p, status, assignee }] (jours) ; edges : [{ from, to, type, lag }] ; startDate : AAAA-MM-JJ ;
 * targetDate : date visée (facultative) ; runs : nombre de tirages Monte-Carlo ; seed : graine.
 */
function analyze({ tasks, edges, startDate, targetDate = null, runs = 2000, seed = 12345 }) {
  const ids = tasks.map((t) => t.id);
  const idSet = new Set(ids);
  const okEdges = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to).map((e) => ({ ...e, type: TYPES.includes(e.type) ? e.type : 'FS', lag: Number(e.lag) || 0 }));
  const tp = topo(ids, okEdges);
  if (tp.cycle) return { ok: false, cycle: tp.cycle };
  const preds = new Map(ids.map((i) => [i, []])); const succs = new Map(ids.map((i) => [i, []]));
  for (const e of okEdges) { preds.get(e.to).push(e); succs.get(e.from).push(e); }
  const by = new Map(tasks.map((t) => [t.id, t]));
  const dur = new Map(tasks.map((t) => [t.id, expected(t.o, t.m, t.p)]));
  const f = forward(tp.order, dur, preds);
  const T = f.end;
  // Passe arrière.
  const LF = new Map(); const LS = new Map();
  for (const i of [...tp.order].reverse()) {
    let lf = T;
    for (const e of succs.get(i)) {
      const j = e.to; const lag = e.lag; let v;
      if (e.type === 'SS') v = LS.get(j) - lag + dur.get(i);
      else if (e.type === 'FF') v = LF.get(j) - lag;
      else if (e.type === 'SF') v = LF.get(j) - lag + dur.get(i);
      else v = LS.get(j) - lag;
      lf = Math.min(lf, v);
    }
    LF.set(i, lf); LS.set(i, lf - dur.get(i));
  }
  const flt = (i) => Math.max(0, LS.get(i) - f.ES.get(i));
  const critical = new Set(ids.filter((i) => flt(i) < 1e-6));
  // Chemin critique « porteur » : parmi les liens serrés, la chaîne qui cumule le plus de variance (sert à l'écart-type du projet).
  const tight = (e) => critical.has(e.from) && critical.has(e.to) && Math.abs(startBound(e, f.ES.get(e.from), f.EF.get(e.from), dur.get(e.to)) - f.ES.get(e.to)) < 1e-6;
  const variance = (i) => { const t = by.get(i); return sigma(t.o, t.p) ** 2; };
  const best = new Map(); const from = new Map();
  for (const i of tp.order) {
    if (!critical.has(i)) continue;
    let b = 0; let bf = null;
    for (const e of preds.get(i)) if (tight(e) && best.has(e.from) && best.get(e.from) > b - EPS && (bf === null || best.get(e.from) > b)) { b = best.get(e.from); bf = e.from; }
    best.set(i, b + variance(i)); from.set(i, bf);
  }
  let tail = null;
  for (const i of critical) if (Math.abs(f.EF.get(i) - T) < 1e-6 && (tail === null || best.get(i) > best.get(tail))) tail = i;
  const path = [];
  for (let c = tail; c !== null && c !== undefined; c = from.get(c)) path.unshift(c);
  const varProject = tail === null ? 0 : best.get(tail);
  const sd = Math.sqrt(varProject);
  // Niveaux d'affichage (colonne = plus long enchaînement de prédécesseurs).
  const level = new Map();
  for (const i of tp.order) level.set(i, Math.max(-1, ...preds.get(i).map((e) => level.get(e.from))) + 1);
  const start = startDate;
  const dateOfStart = (x) => addDays(start, Math.floor(x + 1e-9));
  const dateOfEnd = (x) => addDays(start, Math.max(Math.ceil(x - 1e-9) - 1, 0));
  const nodes = tp.order.map((i) => {
    const t = by.get(i);
    return {
      id: i, title: t.title, status: t.status || 'todo', assignee: t.assignee || null, o: t.o, m: t.m, p: t.p, estimated: Boolean(t.estimated),
      duration: r2(dur.get(i)), sd: r2(sigma(t.o, t.p)), es: r2(f.ES.get(i)), ef: r2(f.EF.get(i)), ls: r2(LS.get(i)), lf: r2(LF.get(i)), float: r2(flt(i)),
      critical: critical.has(i), onPath: path.includes(i), level: level.get(i),
      earliestStart: dateOfStart(f.ES.get(i)), earliestFinish: dateOfEnd(f.EF.get(i)), latestStart: dateOfStart(LS.get(i)), latestFinish: dateOfEnd(LF.get(i)),
    };
  });
  const result = {
    ok: true, startDate: start, duration: r2(T), sd: r2(sd), variance: r2(varProject), end: dateOfEnd(T), path, nodes,
    edges: okEdges.map((e) => ({ from: e.from, to: e.to, type: e.type, lag: e.lag, tight: tight(e) })),
    ranges: { p68: [r2(Math.max(T - sd, 0)), r2(T + sd)], p95: [r2(Math.max(T - 2 * sd, 0)), r2(T + 2 * sd)] },
  };
  if (targetDate) {
    const budget = dn(targetDate) - dn(start) + 1; // jours disponibles, début et fin inclus
    const z = sd > 0 ? (budget - T) / sd : (budget >= T - EPS ? Infinity : -Infinity);
    result.target = { date: targetDate, daysAvailable: budget, probability: r2(sd > 0 ? normCdf(z) : (budget >= T - EPS ? 1 : 0)), marginDays: r2(budget - T) };
  }
  if (runs > 0) result.simulation = simulate({ order: tp.order, preds, tasks, runs, seed, start, targetDate });
  return result;
}

/** Monte-Carlo : durées tirées selon une loi triangulaire (optimiste, probable, pessimiste). */
function simulate({ order, preds, tasks, runs, seed, start, targetDate }) {
  const rand = rng(seed);
  const tri = (a, c, b) => { if (b - a < EPS) return a; const u = rand(); const fc = (c - a) / (b - a); return u < fc ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c)); };
  const ends = [];
  for (let r = 0; r < runs; r++) {
    const dur = new Map(tasks.map((t) => [t.id, tri(t.o, Math.min(Math.max(t.m, t.o), t.p), t.p)]));
    ends.push(forward(order, dur, preds).end);
  }
  ends.sort((a, b) => a - b);
  const pct = (q) => ends[Math.min(ends.length - 1, Math.floor(q * ends.length))];
  const lo = ends[0]; const hi = ends[ends.length - 1];
  const bins = 12; const w = (hi - lo) / bins || 1;
  const hist = Array.from({ length: bins }, (_, k) => ({ from: r2(lo + k * w), to: r2(lo + (k + 1) * w), count: 0 }));
  for (const v of ends) hist[Math.min(bins - 1, Math.floor((v - lo) / w))].count++;
  const dateOf = (x) => addDays(start, Math.max(Math.ceil(x - 1e-9) - 1, 0));
  const out = { runs, mean: r2(ends.reduce((a, b) => a + b, 0) / runs), min: r2(lo), max: r2(hi), p50: r2(pct(0.5)), p80: r2(pct(0.8)), p90: r2(pct(0.9)), p50Date: dateOf(pct(0.5)), p80Date: dateOf(pct(0.8)), p90Date: dateOf(pct(0.9)), histogram: hist };
  if (targetDate) { const budget = dn(targetDate) - dn(start) + 1; out.probabilityTarget = r2(ends.filter((v) => v <= budget + EPS).length / runs); }
  return out;
}

/**
 * Contrôle des dépendances.
 * tasks : [{ id, title, start, end, status }] ; edges : [{ id?, from, to, type, lag }] ; externals : [{ id, title, kind, status, expectedDate, taskId }].
 * Renvoie une liste de problèmes { code, severity, ids, params }.
 */
function checkDeps({ tasks, edges, externals = [], today }) {
  const out = [];
  const by = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set();
  for (const e of edges) {
    if (e.from === e.to) { out.push({ code: 'self', severity: 'high', ids: [e.from], params: { a: (by.get(e.from) || {}).title }, edgeId: e.id }); continue; }
    if (!by.has(e.from) || !by.has(e.to)) { out.push({ code: 'missing', severity: 'high', ids: [e.from, e.to].filter((x) => x != null), params: {}, edgeId: e.id }); continue; }
    const k = `${e.from}>${e.to}`;
    if (seen.has(k)) out.push({ code: 'duplicate', severity: 'low', ids: [e.from, e.to], params: { a: by.get(e.from).title, b: by.get(e.to).title }, edgeId: e.id }); else seen.add(k);
  }
  const valid = edges.filter((e) => e.from !== e.to && by.has(e.from) && by.has(e.to));
  const tp = topo(tasks.map((t) => t.id), valid);
  if (tp.cycle) out.push({ code: 'cycle', severity: 'high', ids: tp.cycle, params: { chain: tp.cycle.map((i) => by.get(i).title).concat(by.get(tp.cycle[0]).title).join(' → ') } });
  // Opposés : A → B et B → A (cas particulier d'une boucle, signalé aussi comme tel).
  for (const e of valid) {
    const a = by.get(e.from); const b = by.get(e.to);
    if (!a.start || !a.end || !b.start || !b.end) continue;
    const lag = Number(e.lag) || 0; const type = TYPES.includes(e.type) ? e.type : 'FS';
    let bad = false; let need = '';
    if (type === 'FS' && dn(b.start) < dn(a.end) + 1 + lag) { bad = true; need = addDays(a.end, 1 + lag); }
    else if (type === 'SS' && dn(b.start) < dn(a.start) + lag) { bad = true; need = addDays(a.start, lag); }
    else if (type === 'FF' && dn(b.end) < dn(a.end) + lag) { bad = true; need = addDays(a.end, lag); }
    else if (type === 'SF' && dn(b.end) < dn(a.start) + lag) { bad = true; need = addDays(a.start, lag); }
    if (bad && !(b.status === 'done')) out.push({ code: 'dates', severity: 'medium', ids: [e.from, e.to], params: { a: a.title, b: b.title, type, need }, edgeId: e.id });
    if (b.status === 'done' && a.status !== 'done') out.push({ code: 'doneBefore', severity: 'medium', ids: [e.from, e.to], params: { a: a.title, b: b.title }, edgeId: e.id });
    if ((b.status === 'doing') && a.status === 'todo' && type === 'FS') out.push({ code: 'startedBefore', severity: 'low', ids: [e.from, e.to], params: { a: a.title, b: b.title }, edgeId: e.id });
  }
  for (const x of externals) {
    const t = x.taskId != null ? by.get(x.taskId) : null;
    if (x.taskId != null && !t) out.push({ code: 'extMissing', severity: 'medium', ids: [], params: { title: x.title }, extId: x.id });
    if (x.status === 'blocked') out.push({ code: 'extBlocked', severity: 'high', ids: x.taskId != null ? [x.taskId] : [], params: { title: x.title }, extId: x.id });
    if (x.status === 'pending' && x.expectedDate && today && x.expectedDate < today) out.push({ code: 'extLate', severity: 'high', ids: x.taskId != null ? [x.taskId] : [], params: { title: x.title, date: x.expectedDate }, extId: x.id });
    if (t && t.start && x.expectedDate && x.status !== 'received' && x.expectedDate >= t.start) out.push({ code: 'extAfterStart', severity: 'medium', ids: [x.taskId], params: { title: x.title, date: x.expectedDate, task: t.title, start: t.start }, extId: x.id });
    if (x.taskId == null) out.push({ code: 'extUnlinked', severity: 'low', ids: [], params: { title: x.title }, extId: x.id });
  }
  return out;
}

module.exports = { TYPES, normCdf, rng, expected, sigma, topo, analyze, simulate, checkDeps, addDays, dn };
