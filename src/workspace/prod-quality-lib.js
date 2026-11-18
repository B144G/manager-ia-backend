'use strict';
// Production avancée, étape 3 : Six Sigma (DMAIC, cartes de contrôle, capabilité, DPMO, Pareto, Ishikawa), TPM (TRS/OEE, 6 grandes pertes, MTBF/MTTR, calendrier de maintenance)
// et contrôle qualité (plans de contrôle, échantillonnage AQL, non-conformités, CAPA, traçabilité des lots). Calculs purs.
const { normCdf } = require('./pert-lib');
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const num = (v, label, { min = 0, max = 1e12, def = 0 } = {}) => {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} : nombre invalide.`);
  return n;
};
const opt = (v, label, o) => (v === undefined || v === null || v === '' ? null : num(v, label, o));
const str = (v, max, def = '') => String(v == null ? def : v).trim().slice(0, max);
const id = (v, i, p) => str(v || `${p}${i + 1}`, 24).replace(/[^\w-]/g, '') || `${p}${i + 1}`;
const date = (v) => { const s = str(v, 10); if (!s) return ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error('Date invalide (AAAA-MM-JJ).'); return s; };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const list = (a, max) => (Array.isArray(a) ? a.slice(0, max) : []);

/** Inverse de la loi normale (dichotomie). */
function normInv(p) { if (p <= 0) return -8; if (p >= 1) return 8; let lo = -8; let hi = 8; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
/** Niveau sigma à long terme depuis un DPMO (convention : décalage de 1,5 sigma). */
const sigmaFromDpmo = (dpmo) => (dpmo <= 0 ? null : dpmo >= 1e6 ? 0 : r2(normInv(1 - dpmo / 1e6) + 1.5));

// ---------- Six Sigma ----------
const CONST = { 2: [1.88, 0, 3.267, 1.128], 3: [1.023, 0, 2.574, 1.693], 4: [0.729, 0, 2.282, 2.059], 5: [0.577, 0, 2.114, 2.326], 6: [0.483, 0, 2.004, 2.534], 7: [0.419, 0.076, 1.924, 2.704], 8: [0.373, 0.136, 1.864, 2.847], 9: [0.337, 0.184, 1.816, 2.970], 10: [0.308, 0.223, 1.777, 3.078] };
const PHASES = ['define', 'measure', 'analyze', 'improve', 'control'];
const CATS6M = ['man', 'machine', 'method', 'material', 'measure', 'environment'];
function cleanSix(d) {
  d = d || {};
  const groups = list(d.xr && d.xr.subgroups, 60).map((g) => list(g, 10).map((v) => num(v, 'Mesure', { min: -1e9 }))).filter((g) => g.length);
  if (groups.length && (new Set(groups.map((g) => g.length)).size > 1 || groups[0].length < 2)) throw new Error('Cartes X-barre/R : chaque sous-groupe doit avoir le même nombre de mesures (2 à 10).');
  return {
    spec: { lsl: opt(d.spec && d.spec.lsl, 'Limite inférieure', { min: -1e9 }), usl: opt(d.spec && d.spec.usl, 'Limite supérieure', { min: -1e9 }), unit: str(d.spec && d.spec.unit, 12) },
    xr: { subgroups: groups }, p: { samples: list(d.p && d.p.samples, 60).map((s) => ({ n: num(s.n, 'Taille', { min: 1 }), d: num(s.d, 'Défauts') })).filter((s) => s.d <= s.n) },
    dpmo: { units: num(d.dpmo && d.dpmo.units, 'Unités'), opportunities: num(d.dpmo && d.dpmo.opportunities, 'Occasions de défaut', { def: 1, min: 1 }), defects: num(d.dpmo && d.dpmo.defects, 'Défauts') },
    defects: list(d.defects, 30).map((x) => ({ cause: str(x.cause, 80), count: num(x.count, 'Nombre') })).filter((x) => x.cause),
    ishikawa: { problem: str(d.ishikawa && d.ishikawa.problem, 120), causes: Object.fromEntries(CATS6M.map((c) => [c, list(d.ishikawa && d.ishikawa.causes && d.ishikawa.causes[c], 12).map((x) => str(x, 100)).filter(Boolean)])) },
    projects: list(d.projects, 15).map((p, i) => ({ id: id(p.id, i, 'dm'), title: str(p.title, 120) || `Projet ${i + 1}`, phase: PHASES.includes(p.phase) ? p.phase : 'define', problem: str(p.problem, 400), goal: str(p.goal, 300), owner: str(p.owner, 60), tasks: list(p.tasks, 40).map((t) => ({ text: str(t.text, 160), phase: PHASES.includes(t.phase) ? t.phase : 'define', done: Boolean(t.done) })).filter((t) => t.text) })),
  };
}
function runRules(values, cl, ucl, lcl) {
  const out = [];
  values.forEach((v, i) => { if (v > ucl + 1e-12 || v < lcl - 1e-12) out.push({ index: i, rule: 'limit' }); });
  for (let i = 0; i + 6 < values.length; i++) { const w = values.slice(i, i + 7); if (w.every((v) => v > cl) || w.every((v) => v < cl)) { out.push({ index: i + 6, rule: 'run' }); break; } }
  return out;
}
function computeSix(doc) {
  const out = { phases: PHASES };
  const g = doc.xr.subgroups;
  if (g.length >= 2) {
    const n = g[0].length; const [A2, D3, D4, d2] = CONST[n];
    const means = g.map((x) => x.reduce((a, b) => a + b, 0) / n); const ranges = g.map((x) => Math.max(...x) - Math.min(...x));
    const xbb = means.reduce((a, b) => a + b, 0) / means.length; const rb = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const x = { center: r3(xbb), ucl: r3(xbb + A2 * rb), lcl: r3(xbb - A2 * rb), values: means.map(r3) }; const rr = { center: r3(rb), ucl: r3(D4 * rb), lcl: r3(D3 * rb), values: ranges.map(r3) };
    x.signals = runRules(means, x.center, x.ucl, x.lcl); rr.signals = runRules(ranges, rr.center, rr.ucl, rr.lcl);
    out.xr = { n, x, r: rr, sigmaWithin: r3(rb / d2), stable: !x.signals.length && !rr.signals.length };
    // Capabilité (Cp, Cpk à court terme avec sigma intra-groupe ; Pp, Ppk avec l'écart-type global)
    const all = g.flat(); const mu = all.reduce((a, b) => a + b, 0) / all.length; const sd = Math.sqrt(all.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(all.length - 1, 1));
    const { lsl, usl } = doc.spec; const sw = rb / d2;
    if ((lsl !== null || usl !== null) && sw > 0 && sd > 0) {
      const cp = lsl !== null && usl !== null ? (usl - lsl) / (6 * sw) : null;
      const cu = usl !== null ? (usl - mu) / (3 * sw) : null; const cl = lsl !== null ? (mu - lsl) / (3 * sw) : null; const cpk = Math.min(...[cu, cl].filter((v) => v !== null));
      const pu = usl !== null ? (usl - mu) / (3 * sd) : null; const pl = lsl !== null ? (mu - lsl) / (3 * sd) : null; const ppk = Math.min(...[pu, pl].filter((v) => v !== null));
      const out_p = (usl !== null ? 1 - normCdf((usl - mu) / sd) : 0) + (lsl !== null ? normCdf((lsl - mu) / sd) : 0);
      const dpmo = Math.round(out_p * 1e6);
      out.capability = { mean: r3(mu), sd: r3(sd), sigmaWithin: r3(sw), cp: cp === null ? null : r2(cp), cpk: r2(cpk), pp: lsl !== null && usl !== null ? r2((usl - lsl) / (6 * sd)) : null, ppk: r2(ppk), dpmo, sigmaLevel: sigmaFromDpmo(Math.max(dpmo, 1)), shortTermSigma: r2(cpk * 3), verdict: cpk >= 1.67 ? 'excellent' : cpk >= 1.33 ? 'good' : cpk >= 1 ? 'marginal' : 'poor', centered: cp !== null ? cpk >= cp * 0.9 : true };
    }
  }
  const ps = doc.p.samples;
  if (ps.length >= 2) {
    const tn = ps.reduce((a, s) => a + s.n, 0); const pbar = ps.reduce((a, s) => a + s.d, 0) / tn;
    const pts = ps.map((s) => { const p = s.d / s.n; const w = 3 * Math.sqrt(pbar * (1 - pbar) / s.n); return { p: r3(p), ucl: r3(Math.min(pbar + w, 1)), lcl: r3(Math.max(pbar - w, 0)), out: p > pbar + w + 1e-12 || p < pbar - w - 1e-12 }; });
    out.p = { center: r3(pbar), points: pts, stable: !pts.some((x) => x.out), signals: pts.map((x, i) => (x.out ? i : -1)).filter((i) => i >= 0) };
  }
  const dd = doc.dpmo;
  if (dd.units > 0) { const dpmo = Math.round(dd.defects / (dd.units * dd.opportunities) * 1e6); out.dpmo = { dpmo, yieldPct: r2((1 - dd.defects / (dd.units * dd.opportunities)) * 100), sigmaLevel: dpmo > 0 ? sigmaFromDpmo(dpmo) : null }; }
  if (doc.defects.length) {
    const tot = doc.defects.reduce((a, x) => a + x.count, 0); let cum = 0;
    out.pareto = [...doc.defects].sort((a, b) => b.count - a.count).map((x) => { cum += x.count; return { cause: x.cause, count: x.count, pct: tot ? r1(x.count / tot * 100) : 0, cumPct: tot ? r1(cum / tot * 100) : 0 }; });
    const vital = []; for (const x of out.pareto) { vital.push(x.cause); if (x.cumPct >= 80) break; } out.vitalFew = vital;
  }
  const I = doc.ishikawa; const counts = CATS6M.map((c) => ({ category: c, n: I.causes[c].length })); out.ishikawa = { problem: I.problem, counts, causes: I.causes, main: [...counts].sort((a, b) => b.n - a.n)[0] && [...counts].sort((a, b) => b.n - a.n)[0].n > 0 ? [...counts].sort((a, b) => b.n - a.n)[0].category : null };
  out.projects = doc.projects.map((p) => { const tasks = p.tasks; const done = tasks.filter((t) => t.done).length; const idx = PHASES.indexOf(p.phase); return { ...p, progress: tasks.length ? Math.round(done / tasks.length * 100) : 0, phaseIndex: idx, nextStep: p.phase === 'define' ? 'charter' : p.phase === 'measure' ? (out.xr || out.p || out.dpmo ? 'baseline' : 'collect') : p.phase === 'analyze' ? (out.pareto ? 'rootcause' : 'pareto') : p.phase === 'improve' ? 'pilot' : 'control' }; });
  return out;
}

// ---------- TPM ----------
function cleanTpm(d) {
  const ms = list(d && d.machines, 30);
  return { machines: ms.map((m, i) => ({ id: id(m.id, i, 'm'), name: str(m.name, 80) || `Machine ${i + 1}`, plannedHours: num(m.plannedHours, 'Temps planifié', { def: 160 }),
    breakdownHours: num(m.breakdownHours, 'Pannes'), setupHours: num(m.setupHours, 'Réglages'), minorStopHours: num(m.minorStopHours, 'Micro-arrêts'), idealCycleMin: num(m.idealCycleMin, 'Cadence idéale (min par pièce)', { def: 1, min: 0.0001 }),
    totalCount: num(m.totalCount, 'Pièces produites'), goodCount: num(m.goodCount, 'Pièces bonnes'), startupRejects: num(m.startupRejects, 'Rebuts de démarrage'),
    failures: list(m.failures, 60).map((f) => ({ date: date(f.date), hours: num(f.hours, 'Durée de panne') })),
    pm: list(m.pm, 30).map((p) => ({ task: str(p.task, 120), everyDays: num(p.everyDays, 'Périodicité (jours)', { min: 1, max: 3650, def: 30 }), lastDone: date(p.lastDone), kind: p.kind === 'autonomous' ? 'autonomous' : 'preventive' })).filter((p) => p.task) })) };
}
function computeTpm(doc, today = new Date().toISOString().slice(0, 10)) {
  const machines = doc.machines.map((m) => {
    const run = Math.max(m.plannedHours - m.breakdownHours - m.setupHours, 0);
    const avail = m.plannedHours > 0 ? run / m.plannedHours : 0;
    const idealHours = m.totalCount * m.idealCycleMin / 60;
    const operating = Math.max(run - m.minorStopHours, 0);
    const perf = run > 0 ? Math.min(idealHours / run, 1) : 0;
    const qual = m.totalCount > 0 ? Math.min(m.goodCount / m.totalCount, 1) : 0;
    const oee = avail * perf * qual;
    const lossHours = [
      { loss: 'breakdown', hours: m.breakdownHours }, { loss: 'setup', hours: m.setupHours }, { loss: 'minorStops', hours: m.minorStopHours },
      { loss: 'reducedSpeed', hours: Math.max(run - m.minorStopHours - idealHours, 0) },
      { loss: 'defects', hours: Math.max(m.totalCount - m.goodCount - m.startupRejects, 0) * m.idealCycleMin / 60 }, { loss: 'startup', hours: m.startupRejects * m.idealCycleMin / 60 },
    ].map((x) => ({ ...x, hours: r1(x.hours), pct: m.plannedHours > 0 ? r1(x.hours / m.plannedHours * 100) : 0 }));
    const nf = m.failures.length; const repair = m.failures.reduce((a, f) => a + f.hours, 0);
    const cal = m.pm.map((p) => { const next = p.lastDone ? addDays(p.lastDone, p.everyDays) : today; const left = diffDays(next, today); return { task: p.task, kind: p.kind, everyDays: p.everyDays, lastDone: p.lastDone, next, daysLeft: left, status: !p.lastDone || left < 0 ? 'overdue' : left <= 7 ? 'soon' : 'ok' }; });
    const biggest = [...lossHours].sort((a, b) => b.hours - a.hours)[0];
    return { id: m.id, name: m.name, plannedHours: m.plannedHours, availability: r1(avail * 100), performance: r1(perf * 100), quality: r1(qual * 100), oee: r1(oee * 100), level: oee >= 0.85 ? 'world' : oee >= 0.6 ? 'good' : oee >= 0.4 ? 'fair' : 'poor',
      losses: lossHours, biggestLoss: biggest && biggest.hours > 0 ? biggest.loss : null, failures: nf, mtbf: nf ? r1(operating / nf) : null, mttr: nf ? r1(repair / nf) : null, calendar: cal.sort((a, b) => a.daysLeft - b.daysLeft), hasPlan: m.pm.length > 0, autonomous: m.pm.filter((p) => p.kind === 'autonomous').length, preventive: m.pm.filter((p) => p.kind === 'preventive').length };
  });
  const avg = machines.length ? r1(machines.reduce((a, x) => a + x.oee, 0) / machines.length) : null;
  const calendar = machines.flatMap((m) => m.calendar.map((c) => ({ machine: m.name, ...c }))).sort((a, b) => a.daysLeft - b.daysLeft);
  return { machines, oeeAverage: avg, calendar, overdue: calendar.filter((c) => c.status === 'overdue').length, noPlan: machines.filter((m) => !m.hasPlan).map((m) => m.name), worst: machines.length ? [...machines].sort((a, b) => a.oee - b.oee)[0].name : null };
}

// ---------- Contrôle qualité ----------
const AQL_LETTERS = [[8, 'A', 2], [15, 'B', 3], [25, 'C', 5], [50, 'D', 8], [90, 'E', 13], [150, 'F', 20], [280, 'G', 32], [500, 'H', 50], [1200, 'J', 80], [3200, 'K', 125], [10000, 'L', 200], [35000, 'M', 315], [150000, 'N', 500], [500000, 'P', 800], [Infinity, 'Q', 1250]];
/** Probabilité d'avoir au plus c défauts dans un échantillon de n quand le taux de défaut est p (loi binomiale). */
function binCdf(c, n, p) { let sum = 0; let term = Math.pow(1 - p, n); for (let k = 0; k <= c; k++) { sum += term; term *= (n - k) / (k + 1) * p / (1 - p); } return Math.min(sum, 1); }
/** Plan d'échantillonnage simple, contrôle normal, niveau II : taille d'échantillon (ISO 2859-1) ; nombre d'acceptation = plus petit c qui accepte au moins 95 % des lots au niveau de qualité acceptable. */
function sampling(lot, aql) {
  const row = AQL_LETTERS.find((r) => lot <= r[0]); let n = Math.min(row[2], Math.max(Math.round(lot), 1)); const p = aql / 100;
  let c = 0; while (c < n && binCdf(c, n, p) < 0.95) c++; // plus petit nombre d'acceptation qui accepte au moins 95 % des lots au niveau AQL
  const oc = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 15].map((d) => ({ defectPct: d, accept: r1(binCdf(c, n, d / 100) * 100) }));
  return { lot, letter: row[1], sample: n, aql, accept: c, reject: c + 1, oc, full: lot <= n };
}
function cleanQuality(d) {
  d = d || {};
  return {
    produced: num(d.produced, 'Production de la période'),
    plans: list(d.plans, 40).map((p, i) => ({ id: id(p.id, i, 'cp'), stage: ['incoming', 'inprocess', 'final'].includes(p.stage) ? p.stage : 'final', product: str(p.product, 80), characteristic: str(p.characteristic, 120), method: str(p.method, 120), frequency: str(p.frequency, 80), aql: [1, 2.5, 4].includes(Number(p.aql)) ? Number(p.aql) : 2.5, lotSize: num(p.lotSize, 'Taille de lot', { def: 500, min: 1 }), owner: str(p.owner, 60) })).filter((p) => p.characteristic),
    ncs: list(d.ncs, 200).map((n, i) => ({ id: id(n.id, i, 'nc'), date: date(n.date), lot: str(n.lot, 40), product: str(n.product, 80), qty: num(n.qty, 'Quantité'), disposition: ['scrap', 'rework', 'accept', 'return'].includes(n.disposition) ? n.disposition : 'scrap', category: CATS6M.includes(n.category) ? n.category : 'method', cause: str(n.cause, 160), description: str(n.description, 300), status: n.status === 'closed' ? 'closed' : 'open',
      capa: { type: n.capa && n.capa.type === 'preventive' ? 'preventive' : 'corrective', action: str(n.capa && n.capa.action, 200), owner: str(n.capa && n.capa.owner, 60), due: date(n.capa && n.capa.due), done: Boolean(n.capa && n.capa.done), effective: Boolean(n.capa && n.capa.effective) } })),
    lots: list(d.lots, 200).map((l, i) => ({ code: str(l.code, 40) || `L${i + 1}`, product: str(l.product, 80), date: date(l.date), qty: num(l.qty, 'Quantité'), materialLots: list(l.materialLots, 10).map((m) => str(m, 40)).filter(Boolean), status: ['released', 'hold', 'rejected'].includes(l.status) ? l.status : 'released' })),
  };
}
function computeQuality(doc, today = new Date().toISOString().slice(0, 10)) {
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const scrap = sum(doc.ncs.filter((n) => n.disposition === 'scrap'), (n) => n.qty); const rework = sum(doc.ncs.filter((n) => n.disposition === 'rework'), (n) => n.qty);
  const rate = (q) => (doc.produced > 0 ? r2(q / doc.produced * 100) : null);
  const byCause = new Map(); for (const n of doc.ncs) { const k = n.cause || n.category; byCause.set(k, (byCause.get(k) || 0) + n.qty); }
  const tot = sum([...byCause.values()], (v) => v); let cum = 0;
  const pareto = [...byCause].sort((a, b) => b[1] - a[1]).map(([cause, qty]) => { cum += qty; return { cause, qty, pct: tot ? r1(qty / tot * 100) : 0, cumPct: tot ? r1(cum / tot * 100) : 0 }; });
  const open = doc.ncs.filter((n) => n.status === 'open'); const capaDue = doc.ncs.filter((n) => n.capa.action && !n.capa.done);
  const stages = ['incoming', 'inprocess', 'final'].map((s) => ({ stage: s, plans: doc.plans.filter((p) => p.stage === s).length }));
  const plans = doc.plans.map((p) => ({ ...p, sampling: sampling(p.lotSize, p.aql) }));
  const matUse = new Map(); for (const l of doc.lots) for (const m of l.materialLots) { if (!matUse.has(m)) matUse.set(m, []); matUse.get(m).push(l.code); }
  const lots = doc.lots.map((l) => ({ ...l, ncs: doc.ncs.filter((n) => n.lot === l.code).map((n) => n.id), ncQty: sum(doc.ncs.filter((n) => n.lot === l.code), (n) => n.qty) }));
  return { rates: { scrapPct: rate(scrap), reworkPct: rate(rework), scrap, rework, produced: doc.produced }, pareto, open: open.length, ncCount: doc.ncs.length, plans, stages, missingStages: stages.filter((s) => s.plans === 0).map((s) => s.stage),
    capa: { open: capaDue.length, late: capaDue.filter((n) => n.capa.due && n.capa.due < today).length, withoutAction: open.filter((n) => !n.capa.action).length, effective: doc.ncs.filter((n) => n.capa.effective).length },
    lots, materialUse: [...matUse].map(([material, used]) => ({ material, lots: used })), hold: doc.lots.filter((l) => l.status !== 'released').length };
}

module.exports = { cleanSix: cleanSix, computeSix, cleanTpm, computeTpm, cleanQuality, computeQuality, sampling, binCdf, normInv, sigmaFromDpmo, CONST };
