'use strict';
// Circuit de production : modèles par secteur, analyse des failles et risques, solutions applicables. Calculs purs (testés dans test-projets-ro.js).
// Une étape : { id, name, kind, after: [ids], ownerId, backupId, hours (durée d'un lot), slots (postes en parallèle), validation (visa requis) }.
// Le serveur envoie des CODES (traduits par le site) et jamais de phrases toutes faites : chaque avis a une clé stable (code + étapes).
const { topo } = require('./pert-lib');

const KINDS = ['supply', 'prep', 'make', 'qc', 'pack', 'store', 'ship', 'other'];
const SECTORS = ['general', 'btp', 'food', 'cosmetics', 'trade'];
const r1 = (n) => Math.round(n * 10) / 10;

// [nom, type, heures par lot, visa requis]
const TEMPLATES = {
  general: [['Approvisionnement', 'supply', 2, false], ['Préparation', 'prep', 3, false], ['Fabrication', 'make', 6, false], ['Contrôle qualité', 'qc', 1.5, true], ['Conditionnement', 'pack', 2, false], ['Stockage', 'store', 1, false], ['Expédition', 'ship', 2, false]],
  btp: [['Approvisionnement des matériaux', 'supply', 4, false], ['Préparation du chantier', 'prep', 6, false], ['Réalisation des travaux', 'make', 24, false], ['Contrôle qualité et réception', 'qc', 3, true], ['Finitions et nettoyage', 'pack', 6, false], ['Stockage du matériel', 'store', 2, false], ['Remise au client', 'ship', 2, false]],
  food: [['Approvisionnement en matières premières', 'supply', 3, false], ['Préparation (tri, lavage, pesée)', 'prep', 4, false], ['Fabrication (cuisson, transformation)', 'make', 6, false], ['Contrôle qualité (hygiène, goût, date limite)', 'qc', 1.5, true], ['Conditionnement et étiquetage du lot', 'pack', 3, false], ['Stockage (froid, sec)', 'store', 1, false], ['Expédition et livraison', 'ship', 2, false]],
  cosmetics: [['Approvisionnement (actifs, flacons)', 'supply', 3, false], ['Préparation (pesée, phases)', 'prep', 3, false], ['Fabrication (mélange, émulsion)', 'make', 5, false], ['Contrôle qualité (pH, texture, microbiologie)', 'qc', 2, true], ['Conditionnement et étiquetage', 'pack', 3, false], ['Stockage et quarantaine', 'store', 1, false], ['Expédition', 'ship', 2, false]],
  trade: [['Commande aux fournisseurs', 'supply', 2, false], ['Réception et tri', 'prep', 3, false], ['Mise en état de vente', 'make', 3, false], ['Contrôle des produits', 'qc', 1, true], ['Emballage', 'pack', 1.5, false], ['Stockage', 'store', 1, false], ['Livraison', 'ship', 2, false]],
};

function template(sector) {
  const rows = TEMPLATES[SECTORS.includes(sector) ? sector : 'general'];
  return rows.map((r, i) => ({ id: `s${i + 1}`, name: r[0], kind: r[1], after: i ? [`s${i}`] : [], ownerId: null, backupId: null, hours: r[2], slots: 1, validation: r[3] }));
}

/** Nettoie les étapes reçues du site (types, bornes, identifiants uniques). Lève une Error française si c'est inutilisable. */
function cleanSteps(raw) {
  if (!Array.isArray(raw)) throw new Error('Les étapes doivent former une liste.');
  if (raw.length > 40) throw new Error('40 étapes au plus.');
  const seen = new Set();
  return raw.map((s, i) => {
    const id = String(s.id || `s${i + 1}`).slice(0, 20).replace(/[^\w-]/g, '');
    if (!id || seen.has(id)) throw new Error('Identifiant d\'étape en double.');
    seen.add(id);
    const name = String(s.name || '').trim().slice(0, 120);
    if (!name) throw new Error(`Étape ${i + 1} : donnez-lui un nom.`);
    const hours = Number(s.hours); const slots = Number(s.slots === undefined ? 1 : s.slots);
    if (!Number.isFinite(hours) || hours < 0 || hours > 10000) throw new Error(`« ${name} » : durée invalide.`);
    if (!Number.isInteger(slots) || slots < 1 || slots > 50) throw new Error(`« ${name} » : nombre de postes invalide (1 à 50).`);
    const idOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    return { id, name, kind: KINDS.includes(s.kind) ? s.kind : 'other', after: Array.isArray(s.after) ? [...new Set(s.after.map(String))].slice(0, 20) : [], ownerId: idOrNull(s.ownerId), backupId: idOrNull(s.backupId), hours, slots, validation: Boolean(s.validation) };
  });
}

function ancestors(id, byId) {
  const out = new Set(); const st = [id];
  while (st.length) { const c = st.pop(); for (const p of (byId.get(c) || { after: [] }).after) if (byId.has(p) && !out.has(p)) { out.add(p); st.push(p); } }
  return out;
}

/** Étapes par lesquelles passent TOUS les chemins (points uniques de défaillance du flux). */
function cutSteps(steps) {
  const ids = steps.map((s) => s.id); const set = new Set(ids);
  const edges = []; for (const s of steps) for (const a of s.after) if (set.has(a)) edges.push({ from: a, to: s.id });
  const starts = ids.filter((i) => !edges.some((e) => e.to === i)); const ends = ids.filter((i) => !edges.some((e) => e.from === i));
  if (!starts.length || !ends.length) return [];
  const reach = (skip) => {
    const seen = new Set(); const st = starts.filter((s) => s !== skip);
    while (st.length) { const c = st.pop(); if (seen.has(c)) continue; seen.add(c); for (const e of edges) if (e.from === c && e.to !== skip) st.push(e.to); }
    return ends.some((e) => e !== skip && seen.has(e));
  };
  return ids.filter((i) => !reach(i) && ids.length > 2);
}

/**
 * Analyse d'un circuit.
 * settings : { targetPerDay (lots/jour), hoursPerDay } ; ctx : { members: [{ userId, name }] } ; dismissed : clés d'avis écartés.
 */
function analyze(steps, settings, ctx = {}, dismissed = []) {
  const target = Math.max(Number(settings.targetPerDay) || 0, 0); const hpd = Math.max(Number(settings.hoursPerDay) || 8, 0.5);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const members = ctx.members || [];
  const edges = []; const unresolved = [];
  for (const s of steps) for (const a of s.after) { if (byId.has(a) && a !== s.id) edges.push({ from: a, to: s.id }); else unresolved.push({ step: s.id, ref: a }); }
  const tp = topo(steps.map((s) => s.id), edges);
  const cycle = tp.cycle || null;
  const hasSucc = new Set(edges.map((e) => e.from)); const hasPred = new Set(edges.map((e) => e.to));
  const cap = (s) => (s.hours > 0 ? s.slots * hpd / s.hours : Infinity);
  const rows = steps.map((s) => {
    const c = cap(s); const load = target > 0 && c !== Infinity ? target / c * 100 : 0;
    return { id: s.id, capacityPerDay: c === Infinity ? null : r1(c), load: r1(load), overloaded: load > 100 + 1e-9 };
  });
  const loadOf = new Map(rows.map((r) => [r.id, r]));
  const caps = rows.filter((r) => r.capacityPerDay !== null).sort((a, b) => a.capacityPerDay - b.capacityPerDay);
  const bottleneck = caps[0] || null;
  // Délai de traversée d'un lot (chemin le plus long en heures) si le circuit n'a pas de boucle.
  let leadTime = null; let criticalIds = [];
  if (!cycle && steps.length) {
    const best = new Map(); const from = new Map();
    for (const id of tp.order) {
      const s = byId.get(id); let b = 0; let f = null;
      for (const a of s.after) if (best.has(a) && best.get(a) > b) { b = best.get(a); f = a; }
      best.set(id, b + s.hours); from.set(id, f);
    }
    let tail = null; for (const [id, v] of best) if (tail === null || v > best.get(tail)) tail = id;
    leadTime = r1(best.get(tail)); for (let c = tail; c; c = from.get(c)) criticalIds.unshift(c);
  }
  const F = [];
  const add = (code, severity, stepIds, params, solutions) => { const key = `${code}:${[...stepIds].sort().join(',')}`; F.push({ key, code, severity, stepIds, params: params || {}, solutions, state: dismissed.includes(key) ? 'dismissed' : 'open' }); };
  const tag = (stepIds) => stepIds.map((i) => (byId.get(i) || {}).name).filter(Boolean);
  const least = (n, exclude = []) => {
    const count = new Map(members.map((m) => [m.userId, 0])); for (const s of steps) { if (count.has(s.ownerId)) count.set(s.ownerId, count.get(s.ownerId) + 1); }
    return [...members].filter((m) => !exclude.includes(m.userId)).sort((a, b) => count.get(a.userId) - count.get(b.userId)).slice(0, n);
  };

  if (!steps.length) add('empty', 'high', [], {}, [{ id: 'template', apply: true }]);
  // Boucle infinie.
  if (cycle) add('loop', 'high', cycle, { chain: tag(cycle).concat(tag([cycle[0]])).join(' → ') }, [{ id: 'breakLoop', apply: true, params: { from: byId.get(cycle[cycle.length - 1]).name, to: byId.get(cycle[0]).name } }]);
  // Dépendance non résolue.
  for (const u of unresolved) add('unresolved', 'high', [u.step], { step: byId.get(u.step).name, ref: u.ref }, [{ id: 'dropRef', apply: true, params: { ref: u.ref } }]);
  // Étape isolée.
  if (steps.length > 1) for (const s of steps) if (!hasPred.has(s.id) && !hasSucc.has(s.id) && !s.after.length) {
    const prev = steps[steps.indexOf(s) - 1];
    add('isolated', 'medium', [s.id], { step: s.name }, [].concat(prev ? [{ id: 'linkPrev', apply: true, params: { prev: prev.name } }] : []).concat([{ id: 'removeStep', apply: true }]));
  }
  // Sans responsable (un seul avis pour l'ensemble).
  const noOwner = steps.filter((s) => s.ownerId === null);
  if (noOwner.length) add('noOwner', noOwner.length >= Math.ceil(steps.length / 2) ? 'high' : 'medium', noOwner.map((s) => s.id), { n: noOwner.length, steps: tag(noOwner.map((s) => s.id)).slice(0, 4).join(', ') },
    members.length ? [{ id: 'spreadOwners', apply: true, params: { n: Math.min(members.length, noOwner.length) } }] : [{ id: 'inviteMembers', apply: false }]);
  // Durée manquante.
  const noHours = steps.filter((s) => !(s.hours > 0));
  if (noHours.length) add('noDuration', 'low', noHours.map((s) => s.id), { n: noHours.length, steps: tag(noHours.map((s) => s.id)).join(', ') }, [{ id: 'defaultHours', apply: true, params: { hours: 1 } }]);
  // Contrôle qualité.
  if (steps.length && !steps.some((s) => s.kind === 'qc')) {
    const afterMake = [...steps].reverse().find((s) => s.kind === 'make' || s.kind === 'prep');
    add('noQc', 'high', [], {}, [{ id: 'insertQc', apply: true, params: { after: afterMake ? afterMake.name : '' } }]);
  }
  // Validation avant expédition.
  const ship = steps.filter((s) => s.kind === 'ship');
  for (const s of ship) {
    const anc = ancestors(s.id, byId);
    if (!s.validation && ![...anc].some((i) => byId.get(i).validation)) {
      const qc = [...anc].map((i) => byId.get(i)).find((x) => x.kind === 'qc');
      add('noShipCheck', 'high', [s.id], { step: s.name }, (qc ? [{ id: 'validateQc', apply: true, params: { qc: qc.name } }] : []).concat([{ id: 'insertValidation', apply: true, params: { before: s.name } }]));
    }
  }
  // Charge au-dessus de la capacité, puis goulot d'étranglement.
  const over = rows.filter((r) => r.overloaded);
  for (const r of over) {
    const s = byId.get(r.id); const need = Math.ceil(target * s.hours / hpd - 1e-9);
    add('overload', 'high', [s.id], { step: s.name, load: r.load, cap: r.capacityPerDay, target, need }, [{ id: 'addSlot', apply: true, params: { to: need } }, { id: 'lowerTarget', apply: true, params: { to: Math.floor(r.capacityPerDay * 10) / 10 } }]);
  }
  if (bottleneck && !bottleneck.overloaded && steps.length > 2 && caps.length > 1) {
    const second = caps[1];
    const ratio = second.capacityPerDay > 0 ? second.capacityPerDay / bottleneck.capacityPerDay : 1;
    if (ratio >= 1.4 || bottleneck.load >= 85) {
      const s = byId.get(bottleneck.id);
      add('bottleneck', bottleneck.load >= 85 ? 'medium' : 'low', [s.id], { step: s.name, cap: bottleneck.capacityPerDay, next: second.capacityPerDay, load: bottleneck.load }, [{ id: 'addSlot', apply: true, params: { to: s.slots + 1 } }, { id: 'manualShorten', apply: false }]);
    }
  }
  // Points uniques de défaillance : étape de transformation / contrôle sans doublure ni poste de secours, et personne qui porte trop d'étapes.
  if (!cycle) for (const id of cutSteps(steps)) {
    const s = byId.get(id);
    if ((s.kind === 'make' || s.kind === 'qc') && s.backupId === null && s.slots <= 1) {
      const load = (loadOf.get(id) || {}).load || 0;
      const subs = least(1, [s.ownerId]).map((m) => ({ id: 'setBackup', apply: true, params: { userId: m.userId, name: m.name } }));
      add('spofStep', load >= 70 ? 'medium' : 'low', [id], { step: s.name, load }, subs.concat([{ id: 'addSlot', apply: true, params: { to: s.slots + 1 } }]));
    }
  }
  const byOwner = new Map();
  for (const s of steps) if (s.ownerId !== null) { if (!byOwner.has(s.ownerId)) byOwner.set(s.ownerId, []); byOwner.get(s.ownerId).push(s); }
  const fair = members.length > 1 ? Math.max(2, Math.ceil(steps.length / members.length)) : 2; // part équitable d'étapes par personne
  for (const [uid, list] of byOwner) if (list.length > fair && list.length >= 3 && steps.length >= 4) {
    const m = members.find((x) => x.userId === uid);
    const move = list[list.length - 1]; const alt = least(1, [uid])[0];
    add('spofPerson', list.length >= 4 ? 'medium' : 'low', list.map((s) => s.id), { person: m ? m.name : '?', n: list.length, steps: tag(list.map((s) => s.id)).join(', ') },
      alt ? [{ id: 'reassign', apply: true, params: { stepId: move.id, step: move.name, userId: alt.userId, name: alt.name } }] : [{ id: 'inviteMembers', apply: false }]);
  }
  const open = F.filter((f) => f.state === 'open');
  const pen = { high: 14, medium: 7, low: 3 };
  const score = Math.max(0, 100 - open.reduce((a, f) => a + pen[f.severity], 0));
  const level = score >= 85 ? 'solid' : score >= 65 ? 'correct' : score >= 40 ? 'fragile' : 'critical';
  const order = { high: 0, medium: 1, low: 2 };
  F.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    score, level, findings: F, steps: rows,
    metrics: { steps: steps.length, leadTimeHours: leadTime, capacityPerDay: bottleneck ? bottleneck.capacityPerDay : null, bottleneckId: bottleneck ? bottleneck.id : null, targetPerDay: target, criticalIds, hoursPerDay: hpd, openFindings: open.length, high: open.filter((f) => f.severity === 'high').length },
  };
}

/** Applique UNE solution à une copie des étapes. Renvoie { steps, settings } modifiés. */
function applySolution(steps, settings, finding, solutionId, ctx = {}) {
  let S = steps.map((s) => ({ ...s, after: s.after.slice() })); const set = { ...settings };
  const byId = (id) => S.find((s) => s.id === id);
  const nextId = () => { let n = S.length + 1; while (S.some((s) => s.id === `s${n}`)) n++; return `s${n}`; };
  const sol = finding.solutions.find((x) => x.id === solutionId);
  if (!sol || !sol.apply) throw new Error('Cette solution ne peut pas être appliquée automatiquement.');
  const ids = finding.stepIds; const members = ctx.members || [];
  switch (`${finding.code}/${solutionId}`) {
    case 'empty/template': S = template(ctx.sector); break;
    case 'loop/breakLoop': { const last = byId(ids[ids.length - 1]); last.after = last.after.filter((a) => a !== ids[0]); break; }
    case 'unresolved/dropRef': { const s = byId(ids[0]); s.after = s.after.filter((a) => S.some((x) => x.id === a)); break; }
    case 'isolated/linkPrev': { const i = S.findIndex((s) => s.id === ids[0]); if (i > 0) S[i].after = [S[i - 1].id]; break; }
    case 'isolated/removeStep': S = S.filter((s) => s.id !== ids[0]).map((s) => ({ ...s, after: s.after.filter((a) => a !== ids[0]) })); break;
    case 'noOwner/spreadOwners': {
      if (!members.length) throw new Error('Aucune personne disponible.');
      const load = new Map(members.map((m) => [m.userId, S.filter((s) => s.ownerId === m.userId).length]));
      for (const id of ids) { const m = [...members].sort((a, b) => load.get(a.userId) - load.get(b.userId))[0]; byId(id).ownerId = m.userId; load.set(m.userId, load.get(m.userId) + 1); }
      break;
    }
    case 'noDuration/defaultHours': for (const id of ids) byId(id).hours = 1; break;
    case 'noQc/insertQc': {
      const prev = [...S].reverse().find((s) => s.kind === 'make' || s.kind === 'prep') || S[S.length - 1];
      const q = { id: nextId(), name: 'Contrôle qualité', kind: 'qc', after: prev ? [prev.id] : [], ownerId: null, backupId: null, hours: 1.5, slots: 1, validation: true };
      if (prev) for (const s of S) if (s.after.includes(prev.id)) s.after = s.after.map((a) => (a === prev.id ? q.id : a));
      S.splice(prev ? S.indexOf(prev) + 1 : S.length, 0, q); break;
    }
    case 'noShipCheck/validateQc': {
      const anc = ancestors(ids[0], new Map(S.map((s) => [s.id, s]))); const q = [...anc].map((i) => byId(i)).find((x) => x.kind === 'qc'); q.validation = true; break;
    }
    case 'noShipCheck/insertValidation': {
      const ship = byId(ids[0]);
      const v = { id: nextId(), name: 'Validation avant expédition', kind: 'other', after: ship.after.slice(), ownerId: null, backupId: null, hours: 0.5, slots: 1, validation: true };
      ship.after = [v.id]; S.splice(S.indexOf(ship), 0, v); break;
    }
    case 'overload/addSlot': case 'bottleneck/addSlot': case 'spofStep/addSlot': byId(ids[0]).slots = Math.min(50, Math.max(sol.params.to, byId(ids[0]).slots + 1)); break;
    case 'overload/lowerTarget': set.targetPerDay = Math.max(sol.params.to, 0.1); break;
    case 'spofStep/setBackup': byId(ids[0]).backupId = sol.params.userId; break;
    case 'spofPerson/reassign': byId(sol.params.stepId).ownerId = sol.params.userId; break;
    default: throw new Error('Solution inconnue.');
  }
  return { steps: S, settings: set };
}

module.exports = { KINDS, SECTORS, template, cleanSteps, analyze, applySolution, cutSteps };
