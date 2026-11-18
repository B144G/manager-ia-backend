'use strict';
// Production avancée, étape 1 : MPS (plan directeur), MRP (besoins en matières), capacités, ordonnancement. Calculs purs, testés par test-production-avancee.js.
// Périodes = semaines (0 à N-1). Les documents sont nettoyés par clean*(), puis calculés par compute*().
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v, label, { min = 0, max = 1e9, def = 0 } = {}) => {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} : nombre invalide.`);
  return n;
};
const str = (v, max, def = '') => String(v == null ? def : v).trim().slice(0, max);
const series = (a, n, label) => Array.from({ length: n }, (_, i) => num(Array.isArray(a) ? a[i] : 0, label));
const nPer = (v) => { const n = Math.round(num(v, 'Nombre de périodes', { min: 1, max: 26, def: 8 })); return n; };
const lotUp = (need, rule, size, min) => {
  if (need <= 0) return 0;
  if (rule === 'fixed' && size > 0) return Math.ceil(need / size - 1e-9) * size;
  if (rule === 'min') return Math.max(need, min || size || 0);
  return need; // lot pour lot
};

// ---------- MPS : plan directeur de production ----------
function cleanMps(d) {
  const N = nPer(d && d.periods);
  const prods = Array.isArray(d && d.products) ? d.products : [];
  if (prods.length > 15) throw new Error('15 produits finis au plus.');
  return { periods: N, level: Boolean(d && d.level), products: prods.map((p, i) => ({
    id: str(p.id || `p${i + 1}`, 20).replace(/[^\w-]/g, '') || `p${i + 1}`, name: str(p.name, 80) || `Produit ${i + 1}`, onHand: num(p.onHand, 'Stock'), safety: num(p.safety, 'Stock de sécurité'),
    lotSize: num(p.lotSize, 'Taille de lot'), maxPerPeriod: p.maxPerPeriod === '' || p.maxPerPeriod == null ? null : num(p.maxPerPeriod, 'Production maximale'),
    forecast: series(p.forecast, N, 'Prévision'), firm: series(p.firm, N, 'Commandes fermes') })) };
}
function computeMps(doc) {
  const N = doc.periods;
  const products = doc.products.map((p) => {
    const demand = p.forecast.map((f, t) => Math.max(f, p.firm[t])); // la demande retenue : le plus élevé entre prévision et commandes fermes
    let prod = Array(N).fill(0); let proj = []; let shortage = [];
    const run = (plan) => { let st = p.onHand; return plan.map((q, t) => { st = st + q - demand[t]; return st; }); };
    // Plan : on produit au plus tard, par lots, pour ne jamais passer sous le stock de sécurité.
    let st = p.onHand;
    for (let t = 0; t < N; t++) {
      const after = st - demand[t];
      let q = 0;
      if (after < p.safety) q = lotUp(p.safety - after, p.lotSize > 0 ? 'fixed' : 'l4l', p.lotSize, 0);
      prod[t] = q; st = after + q;
    }
    let leveled = null; let unmet = 0;
    if (doc.level && p.maxPerPeriod !== null) {
      // Lissage : ce qui dépasse la production maximale d'une période est avancé sur les périodes précédentes qui ont de la marge.
      const L = prod.slice();
      for (let t = N - 1; t >= 0; t--) {
        let ex = Math.max(L[t] - p.maxPerPeriod, 0);
        L[t] -= ex;
        for (let k = t - 1; k >= 0 && ex > 0; k--) { const room = Math.max(p.maxPerPeriod - L[k], 0); const mv = Math.min(room, ex); L[k] += mv; ex -= mv; }
        unmet += ex;
      }
      leveled = L; prod = L;
    }
    proj = run(prod);
    shortage = proj.map((v, t) => (v < 0 ? t : -1)).filter((t) => t >= 0);
    // Disponible à promettre (ATP) : sur chaque période de production, ce qui n'est pas déjà couvert par les commandes fermes jusqu'à la prochaine production.
    const atp = Array(N).fill(null);
    for (let t = 0; t < N; t++) {
      if (t > 0 && prod[t] <= 0) continue;
      let next = t + 1; while (next < N && prod[next] <= 0) next++;
      const committed = p.firm.slice(t, next).reduce((a, b) => a + b, 0);
      atp[t] = (t === 0 ? p.onHand : 0) + prod[t] - committed;
    }
    return { id: p.id, name: p.name, demand, plan: prod, projected: proj, atp, shortages: shortage, unmetByLeveling: r1(unmet), onHand: p.onHand, safety: p.safety, totalPlan: prod.reduce((a, b) => a + b, 0), totalDemand: demand.reduce((a, b) => a + b, 0) };
  });
  return { periods: N, products, issues: products.flatMap((x) => [].concat(x.shortages.length ? [{ code: 'mpsShortage', product: x.name, period: x.shortages[0] + 1 }] : [], x.unmetByLeveling > 0 ? [{ code: 'mpsCapacity', product: x.name, qty: x.unmetByLeveling }] : [])) };
}

// ---------- MRP : besoins en matières ----------
function cleanMrp(d) {
  const N = nPer(d && d.periods);
  const items = Array.isArray(d && d.items) ? d.items : [];
  if (items.length > 60) throw new Error('60 articles au plus.');
  const seen = new Set();
  const out = items.map((it, i) => {
    const code = str(it.code, 30).replace(/\s+/g, '_') || `A${i + 1}`;
    if (seen.has(code)) throw new Error(`Article « ${code} » en double.`);
    seen.add(code);
    return { code, name: str(it.name, 80) || code, type: it.type === 'buy' ? 'buy' : 'make', leadTime: Math.round(num(it.leadTime, 'Délai', { max: 26 })), lotRule: ['fixed', 'min'].includes(it.lotRule) ? it.lotRule : 'l4l', lotSize: num(it.lotSize, 'Taille de lot'), onHand: num(it.onHand, 'Stock'), safety: num(it.safety, 'Stock de sécurité'),
      receipts: series(it.receipts, N, 'Réceptions prévues'), demand: series(it.demand, N, 'Demande externe'), bom: (Array.isArray(it.bom) ? it.bom : []).slice(0, 20).map((b) => ({ child: str(b.child, 30).replace(/\s+/g, '_'), qty: num(b.qty, 'Quantité par parent', { min: 0.0001 }) })).filter((b) => b.child) };
  });
  return { periods: N, useMps: Boolean(d && d.useMps), items: out };
}
/** mpsPlan : { 'code_du_produit': [quantités par période] } injecté comme demande externe si useMps. */
function computeMrp(doc, mpsPlan = {}) {
  const N = doc.periods; const by = new Map(doc.items.map((i) => [i.code, i]));
  // Niveau le plus bas de chaque article : un composant n'est calculé qu'après tous ses parents.
  const llc = new Map(); const visiting = new Set(); const issues = [];
  const level = (c, depth = 0) => {
    if (llc.has(c)) return llc.get(c);
    if (visiting.has(c) || depth > 40) { issues.push({ code: 'mrpLoop', item: c }); return 0; }
    visiting.add(c); let l = 0;
    for (const p of doc.items) if (p.bom.some((b) => b.child === c)) l = Math.max(l, level(p.code, depth + 1) + 1);
    visiting.delete(c); llc.set(c, l); return l;
  };
  doc.items.forEach((i) => level(i.code));
  for (const i of doc.items) for (const b of i.bom) if (!by.has(b.child)) issues.push({ code: 'mrpMissing', item: i.code, child: b.child });
  const order = [...doc.items].sort((a, b) => llc.get(a.code) - llc.get(b.code));
  const releases = new Map(doc.items.map((i) => [i.code, Array(N).fill(0)]));
  const out = new Map(); const orders = [];
  for (const it of order) {
    const gross = Array(N).fill(0);
    for (let t = 0; t < N; t++) gross[t] += it.demand[t] + (doc.useMps && mpsPlan[it.code] ? Number(mpsPlan[it.code][t]) || 0 : 0);
    for (const p of doc.items) for (const b of p.bom) if (b.child === it.code) { const rel = releases.get(p.code); for (let t = 0; t < N; t++) gross[t] += rel[t] * b.qty; }
    const projected = []; const net = []; const planned = Array(N).fill(0); const rel = releases.get(it.code); let stock = it.onHand;
    for (let t = 0; t < N; t++) {
      const avail = stock + it.receipts[t];
      const need = Math.max(gross[t] + it.safety - avail, 0);
      const q = lotUp(need, it.lotRule, it.lotSize, it.lotSize);
      planned[t] = q; net.push(r1(need)); stock = avail + q - gross[t]; projected.push(r1(stock));
      if (q > 0) {
        const at = t - it.leadTime; const late = at < 0;
        rel[Math.max(at, 0)] += q;
        orders.push({ item: it.code, name: it.name, kind: it.type === 'buy' ? 'purchase' : 'production', qty: r1(q), release: Math.max(at, 0), receipt: t, late, lateBy: late ? -at : 0 });
      }
    }
    out.set(it.code, { code: it.code, name: it.name, type: it.type, level: llc.get(it.code), leadTime: it.leadTime, gross: gross.map(r1), receipts: it.receipts, projected, net, plannedReceipts: planned.map(r1), plannedReleases: rel.map(r1), onHand: it.onHand });
  }
  const lateOrders = orders.filter((o) => o.late);
  orders.sort((a, b) => a.release - b.release || (a.item < b.item ? -1 : 1));
  return { periods: N, items: doc.items.map((i) => out.get(i.code)), orders, issues: issues.concat(lateOrders.map((o) => ({ code: 'mrpLate', item: o.item, days: o.lateBy }))) };
}

// ---------- Capacités ----------
function cleanCapacity(d) {
  const N = nPer(d && d.periods);
  const centers = Array.isArray(d && d.centers) ? d.centers : []; const routings = Array.isArray(d && d.routings) ? d.routings : [];
  if (centers.length > 20 || routings.length > 20) throw new Error('20 postes et 20 gammes au plus.');
  return { periods: N, useMps: d && d.useMps !== false, overtimeMaxPct: num(d && d.overtimeMaxPct, 'Heures supplémentaires maximales', { max: 100, def: 20 }),
    centers: centers.map((c, i) => ({ name: str(c.name, 60) || `Poste ${i + 1}`, hours: num(c.hours, 'Heures disponibles par période'), efficiency: num(c.efficiency, 'Rendement', { min: 1, max: 100, def: 100 }) })),
    routings: routings.map((r, i) => ({ product: str(r.product, 80) || `Produit ${i + 1}`, ops: (Array.isArray(r.ops) ? r.ops : []).slice(0, 15).map((o) => ({ center: str(o.center, 60), hoursPerUnit: num(o.hoursPerUnit, 'Heures par unité'), setup: num(o.setup, 'Réglage') })).filter((o) => o.center) })),
    manual: Array.isArray(d && d.manual) ? d.manual.slice(0, 20).map((m) => ({ product: str(m.product, 80), qty: series(m.qty, N, 'Quantités') })) : [] };
}
/** mpsProducts : [{ name, plan: [...] }] */
function computeCapacity(doc, mpsProducts = []) {
  const N = doc.periods;
  const plans = new Map();
  if (doc.useMps) for (const p of mpsProducts) plans.set(p.name, p.plan);
  for (const m of doc.manual) plans.set(m.product, m.qty);
  const rows = doc.centers.map((c) => {
    const cap = c.hours * c.efficiency / 100; const load = Array(N).fill(0);
    for (const r of doc.routings) { const plan = plans.get(r.product); if (!plan) continue; for (const o of r.ops) if (o.center === c.name) for (let t = 0; t < N; t++) if (plan[t] > 0) load[t] += plan[t] * o.hoursPerUnit + o.setup; }
    const util = load.map((l) => (cap > 0 ? r1(l / cap * 100) : (l > 0 ? 999 : 0)));
    // Lissage : on avance l'excès vers les périodes précédentes qui ont de la marge.
    const L = load.slice(); let stuck = 0;
    for (let t = N - 1; t >= 0; t--) { let ex = Math.max(L[t] - cap, 0); L[t] -= ex; for (let k = t - 1; k >= 0 && ex > 0; k--) { const room = Math.max(cap - L[k], 0); const mv = Math.min(room, ex); L[k] += mv; ex -= mv; } stuck += ex; }
    const overloads = load.map((l, t) => ({ t, l })).filter((x) => x.l > cap + 1e-9).map(({ t, l }) => {
      const excess = l - cap; const ot = Math.min(excess, cap * doc.overtimeMaxPct / 100); const sub = excess - ot;
      return { period: t, load: r1(l), capacity: r1(cap), excess: r1(excess), solutions: [{ id: 'overtime', hours: r1(ot) }].concat(sub > 1e-9 ? [{ id: 'subcontract', hours: r1(sub) }] : []).concat(t > 0 ? [{ id: 'shift', hours: r1(Math.min(excess, Math.max(cap - load[t - 1], 0))) }] : []) };
    });
    return { name: c.name, capacity: r1(cap), load: load.map(r1), utilization: util, leveled: L.map(r1), leveledStuck: r1(stuck), overloads, avgUtil: r1(util.reduce((a, b) => a + b, 0) / (N || 1)) };
  });
  const bottleneck = [...rows].sort((a, b) => b.avgUtil - a.avgUtil)[0];
  const missing = [...new Set(doc.routings.flatMap((r) => r.ops.map((o) => o.center)).filter((n) => !doc.centers.some((c) => c.name === n)))];
  return { periods: N, centers: rows, bottleneck: bottleneck ? bottleneck.name : null, overloadCount: rows.reduce((a, r) => a + r.overloads.length, 0), issues: missing.map((c) => ({ code: 'capUnknownCenter', center: c })) };
}

// ---------- Ordonnancement ----------
const RULES = ['fifo', 'spt', 'edd', 'cr'];
function cleanSchedule(d) {
  const jobs = Array.isArray(d && d.jobs) ? d.jobs : [];
  if (jobs.length > 30) throw new Error('30 ordres de fabrication au plus.');
  return { hoursPerDay: num(d && d.hoursPerDay, 'Heures par jour', { min: 1, max: 24, def: 8 }), rule: RULES.includes(d && d.rule) ? d.rule : 'edd',
    jobs: jobs.map((j, i) => ({ id: str(j.id || `OF${i + 1}`, 20), name: str(j.name, 80) || `OF${i + 1}`, release: num(j.release, 'Début possible (jour)'), due: num(j.due, 'Échéance (jour)', { def: 10 }),
      ops: (Array.isArray(j.ops) ? j.ops : []).slice(0, 12).map((o) => ({ center: str(o.center, 60) || 'Poste', hours: num(o.hours, 'Durée', { min: 0.01 }) })) })).filter((j) => j.ops.length) };
}
function simulate(doc, rule) {
  const H = doc.hoursPerDay; const jobs = doc.jobs.map((j, idx) => ({ ...j, idx, next: 0, ready: j.release * H, finish: null, remaining: j.ops.reduce((a, o) => a + o.hours, 0), arrival: j.release * H }));
  const free = new Map(); const segs = []; let left = jobs.reduce((a, j) => a + j.ops.length, 0);
  while (left > 0) {
    // Pour chaque poste : plus tôt où il peut démarrer, parmi les opérations prêtes.
    const cands = new Map();
    for (const j of jobs) if (j.next < j.ops.length) { const c = j.ops[j.next].center; if (!cands.has(c)) cands.set(c, []); cands.get(c).push(j); }
    let best = null;
    for (const [c, list] of cands) { const t = Math.max(free.get(c) || 0, Math.min(...list.map((j) => j.ready))); if (!best || t < best.t) best = { c, t, list }; }
    const ready = best.list.filter((j) => j.ready <= best.t + 1e-9);
    const key = (j) => { const op = j.ops[j.next]; if (rule === 'spt') return [op.hours, j.idx]; if (rule === 'edd') return [j.due * H, j.idx]; if (rule === 'cr') return [(j.due * H - best.t) / Math.max(j.remaining, 0.01), j.idx]; return [j.ready, j.idx]; };
    ready.sort((a, b) => { const x = key(a); const y = key(b); return x[0] - y[0] || x[1] - y[1]; });
    const j = ready[0]; const op = j.ops[j.next];
    segs.push({ job: j.id, name: j.name, op: j.next + 1, center: best.c, start: r2(best.t), end: r2(best.t + op.hours) });
    free.set(best.c, best.t + op.hours); j.ready = best.t + op.hours; j.remaining -= op.hours; j.next++; left--;
    if (j.next === j.ops.length) j.finish = j.ready;
  }
  const res = jobs.map((j) => ({ id: j.id, name: j.name, release: j.release, due: j.due, finishDay: r2(j.finish / H), tardiness: r2(Math.max(j.finish / H - j.due, 0)), flow: r2((j.finish - j.arrival) / H), late: j.finish / H > j.due + 1e-9 }));
  const makespan = Math.max(0, ...segs.map((s) => s.end));
  const centers = [...new Set(segs.map((s) => s.center))];
  const busy = segs.reduce((a, s) => a + (s.end - s.start), 0);
  const totalFlow = res.reduce((a, j) => a + j.flow * H, 0);
  return { rule, segments: segs, jobs: res, metrics: { avgTardiness: r2(res.reduce((a, j) => a + j.tardiness, 0) / (res.length || 1)), maxTardiness: r2(Math.max(0, ...res.map((j) => j.tardiness))), lateJobs: res.filter((j) => j.late).length, avgFlow: r2(res.reduce((a, j) => a + j.flow, 0) / (res.length || 1)), makespanDays: r2(makespan / H), avgWip: makespan > 0 ? r2(totalFlow / makespan) : 0, utilization: makespan > 0 && centers.length ? r1(busy / (makespan * centers.length) * 100) : 0 }, centers };
}
function computeSchedule(doc) {
  if (!doc.jobs.length) return { rule: doc.rule, compare: [], chosen: null };
  const compare = RULES.map((r) => simulate(doc, r));
  const bestBy = (k) => compare.reduce((a, b) => (b.metrics[k] < a.metrics[k] ? b : a)).rule;
  return { rule: doc.rule, chosen: compare.find((c) => c.rule === doc.rule), compare: compare.map((c) => ({ rule: c.rule, metrics: c.metrics })), best: { tardiness: bestBy('avgTardiness'), flow: bestBy('avgFlow'), lateJobs: bestBy('lateJobs'), wip: bestBy('avgWip') } };
}

module.exports = { cleanMps, computeMps, cleanMrp, computeMrp, cleanCapacity, computeCapacity, cleanSchedule, computeSchedule, lotUp, RULES };
