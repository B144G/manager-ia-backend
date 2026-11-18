'use strict';
// Production avancée, étape 2 : Lean (cartographie de flux, 8 gaspillages, takt time), TOC (théorie des contraintes, tambour-tampon-corde, comptabilité de débit),
// JIT (juste-à-temps). Les trois lisent les étapes du circuit de production (champs facultatifs) et alimentent l'analyse des failles (findings / apply).
// Calculs purs. Les valeurs « par défaut » ne créent JAMAIS d'avis : un avis n'apparaît que si l'utilisateur a renseigné la donnée concernée.
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const half = (v) => { const h = nn(v) / 2; return h < 0.25 ? 0 : r2(h); };
const nn = (v, def = 0, max = 1e9) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : def; };
const DEFAULT_CLS = { make: 'va', pack: 'va', prep: 'bnva', qc: 'bnva', other: 'bnva', supply: 'nva', store: 'nva', ship: 'nva' };

/** Champs facultatifs d'une étape (Lean, TOC, JIT). cls : va = valeur ajoutée, bnva = nécessaire sans valeur ajoutée, nva = gaspillage pur. */
function stepExtras(s) {
  return { cls: ['va', 'bnva', 'nva'].includes(s.cls) ? s.cls : null, waitHours: nn(s.waitHours, 0, 10000), moveHours: nn(s.moveHours, 0, 10000), motionHours: nn(s.motionHours, 0, 10000),
    stockBefore: nn(s.stockBefore, 0, 1e7), defectPct: nn(s.defectPct, 0, 100), batch: nn(s.batch, 0, 1e7), suppliers: Math.round(nn(s.suppliers, 0, 50)), machine: String(s.machine == null ? '' : s.machine).trim().slice(0, 60), talentUnused: Boolean(s.talentUnused) };
}
function cleanExtra(e) {
  const o = e || {};
  return { unitPrice: nn(o.unitPrice), materialCost: nn(o.materialCost), opexPerDay: nn(o.opexPerDay), inventoryValue: nn(o.inventoryValue) };
}
const clsOf = (s) => s.cls || DEFAULT_CLS[s.kind] || 'bnva';
const cycle = (s) => (s.hours > 0 ? s.hours / Math.max(s.slots, 1) : 0);

// ---------- Lean : VSM, temps de cycle, takt, valeur ajoutée ----------
function lean(steps, st) {
  const hpd = Math.max(Number(st.hoursPerDay) || 8, 0.5); const target = Math.max(Number(st.targetPerDay) || 0, 0);
  const takt = target > 0 ? hpd / target : null; // heures disponibles par lot demandé
  const rows = steps.map((s) => {
    const x = stepExtras(s); const lead = s.hours + x.waitHours + x.moveHours + x.motionHours;
    return { id: s.id, name: s.name, kind: s.kind, cls: clsOf({ ...s, ...x }), process: r2(s.hours), cycle: r2(cycle(s)), wait: x.waitHours, move: x.moveHours, motion: x.motionHours, stock: x.stockBefore, defectPct: x.defectPct, lead: r2(lead), overTakt: takt !== null && cycle(s) > takt + 1e-9 };
  });
  const lead = rows.reduce((a, r) => a + r.lead, 0); const va = rows.filter((r) => r.cls === 'va').reduce((a, r) => a + r.process, 0);
  const bnva = rows.filter((r) => r.cls === 'bnva').reduce((a, r) => a + r.process, 0);
  const wasteTime = lead - va;
  return { takt: takt === null ? null : r2(takt), leadTime: r2(lead), valueAddedTime: r2(va), necessaryTime: r2(bnva), vaRatio: lead > 0 ? r1(va / lead * 100) : null, wasteTime: r2(wasteTime), steps: rows,
    slowest: rows.length ? [...rows].sort((a, b) => b.cycle - a.cycle)[0].id : null, overTakt: rows.filter((r) => r.overTakt).map((r) => r.id) };
}

// ---------- TOC : contrainte, 5 étapes, tambour-tampon-corde, comptabilité de débit ----------
function toc(steps, st, ex) {
  const hpd = Math.max(Number(st.hoursPerDay) || 8, 0.5); const target = Math.max(Number(st.targetPerDay) || 0, 0);
  const capOf = (s) => (s.hours > 0 ? s.slots * hpd / s.hours : Infinity);
  const ranked = steps.map((s) => ({ s, cap: capOf(s) })).filter((x) => x.cap !== Infinity).sort((a, b) => a.cap - b.cap);
  if (!ranked.length) return { constraint: null };
  const c = ranked[0]; const second = ranked[1] || null;
  const idx = steps.indexOf(c.s);
  const upstream = steps.slice(0, idx); // ordre de la liste : amont du tambour
  const bufferHours = r1(upstream.reduce((a, s) => a + s.hours + stepExtras(s).waitHours, 0) * 0.5);
  const sold = Math.min(c.cap, target || c.cap); // lots réellement sortis par jour
  const e = cleanExtra(ex);
  const T = sold * (e.unitPrice - e.materialCost);
  const NP = T - e.opexPerDay;
  // Élever la contrainte d'un poste : nouveau débit et nouvelle contrainte.
  const raised = ranked.map((x) => (x.s === c.s ? { ...x, cap: x.s.hours > 0 ? (x.s.slots + 1) * hpd / x.s.hours : Infinity } : x)).sort((a, b) => a.cap - b.cap);
  const newSold = Math.min(raised[0].cap, target || raised[0].cap);
  const newT = newSold * (e.unitPrice - e.materialCost);
  const next = second ? second.s : null;
  return {
    constraint: { id: c.s.id, name: c.s.name, capacityPerDay: r2(c.cap), load: target > 0 ? r1(target / c.cap * 100) : null, nextCapacity: second ? r2(second.cap) : null, nextName: next ? next.name : null },
    bufferHours, buffer: { before: c.s.id, name: c.s.name, hours: bufferHours, stock: stepExtras(c.s).stockBefore },
    rope: { releaseEveryHours: r2(c.s.hours / Math.max(c.s.slots, 1)), firstStep: steps[0] ? steps[0].name : null, leadBeforeHours: bufferHours },
    throughput: { lotsPerDay: r2(sold), perDay: Math.round(T), opexPerDay: Math.round(e.opexPerDay), netProfitPerDay: Math.round(NP), inventory: Math.round(e.inventoryValue), roiYearPct: e.inventoryValue > 0 ? r1(NP * 250 / e.inventoryValue * 100) : null, productivity: e.opexPerDay > 0 ? r2(T / e.opexPerDay) : null, hasMoney: e.unitPrice > 0 },
    elevate: { gainLotsPerDay: r2(newSold - sold), gainPerDay: Math.round(newT - T), newConstraint: raised[0].s.name, newCapacity: r2(raised[0].cap) },
    steps: ['identify', 'exploit', 'subordinate', 'elevate', 'repeat'],
  };
}

// ---------- JIT ----------
function jit(steps, st) {
  const target = Math.max(Number(st.targetPerDay) || 0, 0);
  const x = steps.map((s) => ({ s, e: stepExtras(s) }));
  const wip = x.reduce((a, o) => a + o.e.stockBefore, 0);
  const suppliers = x.filter((o) => o.s.kind === 'supply');
  const readiness = [];
  return {
    wipLots: r1(wip), wipDays: target > 0 ? r1(wip / target) : null,
    batches: x.filter((o) => o.e.batch > 0).map((o) => ({ id: o.s.id, name: o.s.name, batch: o.e.batch, days: target > 0 ? r1(o.e.batch / target) : null })),
    suppliers: suppliers.map((o) => ({ id: o.s.id, name: o.s.name, count: o.e.suppliers, wait: o.e.waitHours })),
    pullReady: x.filter((o) => o.e.stockBefore > 0).length, readiness,
  };
}

// ---------- Avis (intégrés à l'analyse du circuit) ----------
/** Chaque avis : { code, severity, stepIds, params, solutions: [{ id, apply, params }] } ; les clés sont fabriquées par prod-flow-lib. */
function findings(steps, st, ctx = {}) {
  const out = []; const hpd = Math.max(Number(st.hoursPerDay) || 8, 0.5); const target = Math.max(Number(st.targetPerDay) || 0, 0);
  const takt = target > 0 ? hpd / target : null;
  const info = steps.map((s) => ({ s, e: stepExtras(s) }));
  const name = (ids) => ids.map((i) => (steps.find((s) => s.id === i) || {}).name).filter(Boolean).join(', ');
  const group = (code, sev, list, params, sols) => { if (list.length) out.push({ code, severity: sev, stepIds: list.map((o) => o.s.id), params: { n: list.length, steps: name(list.map((o) => o.s.id)), ...(params || {}) }, solutions: sols }); };
  // 8 gaspillages (muda)
  group('mudaTransport', 'low', info.filter((o) => o.e.moveHours > 0), {}, [{ id: 'halveMove', apply: true, params: {} }, { id: 'manualLayout', apply: false }]);
  group('mudaInventory', 'medium', info.filter((o) => target > 0 && o.e.stockBefore / target > 1), { days: 1 }, [{ id: 'halveStock', apply: true, params: {} }, { id: 'manualKanban', apply: false }]);
  group('mudaMotion', 'low', info.filter((o) => o.e.motionHours > 0), {}, [{ id: 'halveMotion', apply: true, params: {} }, { id: 'manual5s', apply: false }]);
  group('mudaWaiting', 'medium', info.filter((o) => o.e.waitHours > 0 && o.e.waitHours >= Math.max(o.s.hours * 0.5, 1)), {}, [{ id: 'halveWait', apply: true, params: {} }, { id: 'manualBalance', apply: false }]);
  group('mudaOverproduction', 'medium', info.filter((o) => target > 0 && o.e.batch > target * 1.5), {}, [{ id: 'smallerBatch', apply: true, params: { to: Math.max(Math.ceil(target), 1) } }]);
  group('mudaOverprocessing', 'low', info.filter((o) => o.e.cls === 'nva' && !['supply', 'store', 'ship'].includes(o.s.kind) && o.s.hours > 0), {}, [{ id: 'removeOverprocessing', apply: false }]);
  group('mudaDefects', 'high', info.filter((o) => o.e.defectPct > 2), { pct: Math.max(0, ...info.map((o) => o.e.defectPct)) }, [{ id: 'halveDefects', apply: true, params: {} }, { id: 'manualPokaYoke', apply: false }]);
  group('mudaTalent', 'low', info.filter((o) => o.e.talentUnused), {}, [{ id: 'clearTalent', apply: true, params: {} }, { id: 'manualTalent', apply: false }]);
  // Takt time : étapes trop lentes pour le rythme demandé
  if (takt !== null) group('overTakt', 'high', info.filter((o) => o.s.hours > 0 && o.s.hours / Math.max(o.s.slots, 1) > takt + 1e-9), { takt: r2(takt) }, [{ id: 'addSlot', apply: true, params: {} }]);
  // Valeur ajoutée très faible (seulement si l'utilisateur a renseigné des attentes ou transports)
  const L = lean(steps, st);
  if (L.vaRatio !== null && info.some((o) => o.e.waitHours > 0 || o.e.moveHours > 0) && L.vaRatio < 25) out.push({ code: 'leanLowVa', severity: 'medium', stepIds: [], params: { pct: L.vaRatio, lead: L.leadTime, va: L.valueAddedTime }, solutions: [{ id: 'manualVsm', apply: false }] });
  // TOC : pas de tampon devant la contrainte
  const T = toc(steps, st, ctx.extra);
  if (T.constraint && T.constraint.load !== null && T.constraint.load >= 80 && steps.length > 2) {
    const s = steps.find((x) => x.id === T.constraint.id); const e = stepExtras(s); const first = steps[0] && steps[0].id === s.id;
    if (!first && e.stockBefore <= 0) out.push({ code: 'tocNoBuffer', severity: 'medium', stepIds: [s.id], params: { step: s.name, hours: T.bufferHours, load: T.constraint.load }, solutions: [{ id: 'setBuffer', apply: true, params: { to: Math.max(Math.ceil(target * T.bufferHours / hpd), 1) } }] });
  }
  // JIT : fournisseur unique, lots minimaux élevés
  const single = info.filter((o) => o.s.kind === 'supply' && o.e.suppliers === 1);
  group('jitSingleSupplier', 'medium', single, {}, [{ id: 'secondSupplier', apply: true, params: {} }, { id: 'manualBuffer', apply: false }]);
  const longSupply = info.filter((o) => o.s.kind === 'supply' && o.e.waitHours > hpd * 2 && o.e.stockBefore <= 0);
  group('jitLongLead', 'medium', longSupply, {}, [{ id: 'setBuffer', apply: true, params: { to: Math.max(Math.ceil(target), 1) } }]);
  // Machine déclarée sans plan de maintenance (TPM) : branché à l'étape 3 par ctx.maintenance (liste des machines couvertes)
  if (ctx.maintenance) {
    const bare = info.filter((o) => o.e.machine && !ctx.maintenance.includes(o.e.machine.toLowerCase()));
    group('tpmNoPlan', 'medium', bare, {}, [{ id: 'planMaintenance', apply: false }]);
  }
  return out;
}

/** Applique une solution (changements de champs d'étape ou de réglages). Renvoie true si elle est gérée ici. */
function apply(S, set, finding, sol) {
  const by = (id) => S.find((s) => s.id === id);
  const each = (f) => { for (const id of finding.stepIds) { const s = by(id); if (s) f(s); } };
  switch (`${finding.code}/${sol.id}`) {
    case 'mudaTransport/halveMove': each((s) => { s.moveHours = half(s.moveHours); }); return true;
    case 'mudaInventory/halveStock': each((s) => { s.stockBefore = Math.ceil(nn(s.stockBefore) / 2); }); return true;
    case 'mudaMotion/halveMotion': each((s) => { s.motionHours = half(s.motionHours); }); return true;
    case 'mudaWaiting/halveWait': each((s) => { s.waitHours = half(s.waitHours); }); return true;
    case 'mudaOverproduction/smallerBatch': each((s) => { s.batch = sol.params.to; }); return true;
    case 'mudaDefects/halveDefects': each((s) => { s.defectPct = half(s.defectPct); }); return true;
    case 'mudaTalent/clearTalent': each((s) => { s.talentUnused = false; }); return true;
    case 'overTakt/addSlot': each((s) => { s.slots = Math.min(50, Math.max(s.slots + 1, Math.ceil(s.hours / (Math.max(Number(set.hoursPerDay) || 8, 0.5) / Math.max(Number(set.targetPerDay) || 1, 0.001))))); }); return true;
    case 'tocNoBuffer/setBuffer': case 'jitLongLead/setBuffer': each((s) => { s.stockBefore = sol.params.to; }); return true;
    case 'jitSingleSupplier/secondSupplier': each((s) => { s.suppliers = 2; }); return true;
    default: return false;
  }
}

module.exports = { stepExtras, cleanExtra, lean, toc, jit, findings, apply, clsOf };
