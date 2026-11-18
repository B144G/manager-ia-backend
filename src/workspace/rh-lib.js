'use strict';
// RH Talents · calculs purs (aucun accès base) : testables seuls et réutilisés par les routes.
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// ---------- Compétences : écarts, correspondance ----------
/** Écarts entre niveaux requis (poste) et détenus (employé). req = [{competencyId, required, weight}], held = Map(competencyId → niveau). */
function gaps(req, held) {
  return req.map((r) => {
    const have = held.get(Number(r.competencyId)) || 0;
    return { competencyId: Number(r.competencyId), required: r.required, held: have, gap: r.required - have, weight: r.weight || 1, status: have >= r.required ? (have > r.required ? 'above' : 'ok') : have === 0 ? 'missing' : 'gap' };
  });
}
/** Taux de couverture d'un profil (0–100) : Σ poids × min(niveau/requis, 1) / Σ poids. Compétence non évaluée = 0. */
function coverage(list) {
  const tw = list.reduce((s, x) => s + (x.weight || 1), 0);
  if (!tw) return null;
  return r1(100 * list.reduce((s, x) => s + (x.weight || 1) * Math.min((x.held ?? x.score ?? 0) / x.required, 1), 0) / tw);
}
/** Score de correspondance candidat/poste : scores moyens par compétence évaluée face aux niveaux requis. */
function matchScore(req, scores) {
  const items = req.map((r) => {
    const sc = scores.get(Number(r.competencyId));
    return { competencyId: Number(r.competencyId), required: r.required, weight: r.weight || 1, score: sc == null ? null : r2(sc), evaluated: sc != null };
  });
  const score = coverage(items.map((i) => ({ held: i.score || 0, required: i.required, weight: i.weight })));
  return { score, evaluated: items.filter((i) => i.evaluated).length, total: items.length, items, missing: items.filter((i) => !i.evaluated).map((i) => i.competencyId) };
}

// ---------- MBO / SMART ----------
const VAGUE = ['améliorer', 'ameliorer', 'mieux', 'plus', 'optimiser', 'meilleur', 'bien', 'faire', 'essayer', 'développer', 'developper'];
const ACTION = ['augmenter', 'réduire', 'reduire', 'atteindre', 'lancer', 'former', 'recruter', 'livrer', 'ouvrir', 'signer', 'vendre', 'collecter', 'recouvrer', 'diminuer', 'mettre', 'déployer', 'deployer', 'obtenir', 'réaliser', 'realiser', 'produire', 'certifier', 'automatiser', 'fidéliser', 'fideliser', 'conclure', 'documenter', 'former', 'passer', 'ramener', 'porter', 'maintenir'];
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/**
 * Vérifie qu'un objectif est SMART. g = { title, description, unit, start, target, due, today, weight, parentId, ownerId, level }.
 * Renvoie { criteria: {S,M,A,R,T: {ok, note}}, score (0–5), isSmart, missing: [clé,...], tips: [texte,...] }.
 * Les messages sont des codes (clé) : le site les traduit.
 */
function smartCheck(g) {
  const title = String(g.title || '').trim();
  const desc = String(g.description || '').trim();
  const words = title.split(/\s+/).filter(Boolean);
  const toks = title.toLowerCase().split(/[^a-zàâäéèêëîïôöùûüç]+/).filter(Boolean);
  const hasAction = toks.some((t) => ACTION.includes(t) || ACTION.some((a) => a.length > 5 && t.startsWith(a.slice(0, -2))));
  const vagueOnly = words.length > 0 && toks.some((t) => VAGUE.includes(t)) && !/\d/.test(title) && desc.length < 30;
  const c = {};
  // S : spécifique — une action claire, un objet précis (assez de mots), pas de termes vagues sans précision.
  const sOk = words.length >= 4 && (hasAction || desc.length >= 30) && !vagueOnly;
  c.S = { ok: sOk, note: sOk ? 'ok' : words.length < 4 ? 'title_short' : vagueOnly ? 'vague' : 'no_action' };
  // M : mesurable — une cible chiffrée différente de la valeur de départ et une unité.
  const start = num(g.start) ?? 0; const target = num(g.target);
  const mOk = target !== null && target !== start && String(g.unit || '').trim() !== '';
  c.M = { ok: mOk, note: mOk ? 'ok' : target === null ? 'no_target' : target === start ? 'target_equals_start' : 'no_unit' };
  // A : atteignable — l'effort demandé (progression relative) reste raisonnable : ≤ +50 % ok ; jusqu'à +100 % douteux ; au-delà non atteignable sans justification.
  let aOk = false; let aNote = 'cannot_judge';
  if (target !== null && target !== start) {
    const rel = start !== 0 ? Math.abs((target - start) / start) : null;
    if (rel === null) { aOk = true; aNote = 'no_baseline'; }
    else if (rel <= 0.5) { aOk = true; aNote = 'ok'; }
    else if (rel <= 1) { aOk = desc.length >= 30; aNote = aOk ? 'ambitious_justified' : 'ambitious'; }
    else { aOk = false; aNote = 'too_high'; }
  }
  c.A = { ok: aOk, note: aNote };
  // R : réaliste / pertinent — rattaché à un objectif supérieur (sauf objectif d'entreprise), un responsable et un poids entre 1 et 100.
  const w = num(g.weight);
  const rOk = (g.level === 'company' || !!g.parentId) && (g.level === 'company' || !!g.ownerId || g.level === 'team') && w !== null && w >= 1 && w <= 100;
  c.R = { ok: rOk, note: rOk ? 'ok' : !(g.level === 'company' || g.parentId) ? 'no_parent' : w === null || w < 1 || w > 100 ? 'bad_weight' : 'no_owner' };
  // T : temporel — une échéance valide, postérieure à aujourd'hui, à 18 mois au plus.
  const today = g.today || new Date().toISOString().slice(0, 10);
  let tOk = false; let tNote = 'no_due';
  if (g.due && /^\d{4}-\d{2}-\d{2}$/.test(g.due)) {
    const days = Math.round((Date.parse(g.due) - Date.parse(today)) / 86400000);
    if (days < 0) tNote = 'past'; else if (days > 548) tNote = 'too_far'; else { tOk = true; tNote = 'ok'; }
  }
  c.T = { ok: tOk, note: tNote };
  const keys = ['S', 'M', 'A', 'R', 'T'];
  const missing = keys.filter((k) => !c[k].ok);
  return { criteria: c, score: keys.length - missing.length, isSmart: missing.length === 0, missing, tips: missing.map((k) => `${k}:${c[k].note}`) };
}
/** Avancement d'un objectif en % (0–100) entre la valeur de départ et la cible ; sans cible : 0 (100 si terminé). */
function goalProgress(g) {
  const t = num(g.target); const s = num(g.start) ?? 0; const cur = num(g.current) ?? s;
  if (t === null || t === s) return g.status === 'done' ? 100 : 0;
  return r1(Math.max(0, Math.min(100, 100 * (cur - s) / (t - s))));
}
/** Score de réalisation pondéré (0–100) d'une liste d'objectifs [{progress, weight}]. */
function goalScore(list) {
  const tw = list.reduce((s, x) => s + (x.weight || 0), 0);
  return tw ? r1(list.reduce((s, x) => s + (x.weight || 0) * x.progress, 0) / tw) : null;
}

// ---------- Évaluation 360° ----------
const RELATIONS = ['self', 'manager', 'peer', 'subordinate', 'client'];
/**
 * Agrège les réponses d'un évalué en respectant l'anonymat. rows = [{raterId, relation, competencyId, score, comment}].
 * - « soi » et « manager » toujours montrés (identifiables par nature) ; pairs / subordonnés / clients : un groupe n'est montré que s'il compte
 *   au moins `min` répondants ; « autres » (tous sauf soi) n'est montré que si au moins `min` répondants.
 * - un groupe masqué est signalé (hidden) sans aucune de ses valeurs ; les commentaires des groupes masqués disparaissent.
 */
function aggregate360(rows, comps, min) {
  const raters = new Map();
  for (const r of rows) raters.set(r.raterId, r.relation);
  const countBy = {};
  for (const rel of raters.values()) countBy[rel] = (countBy[rel] || 0) + 1;
  const peerRels = ['peer', 'subordinate', 'client'];
  const others = [...raters.values()].filter((rel) => peerRels.includes(rel)).length; // « autres » = pairs + subordonnés + clients (le responsable est montré à part)
  // Anonymat : le détail par groupe n'est montré que si CHAQUE groupe non vide compte au moins `min` répondants ; sinon on ne montre que l'ensemble
  // (sinon, par soustraction, on retrouverait la note d'un groupe masqué). L'ensemble n'est montré qu'à partir de `min` répondants.
  const breakdownOk = peerRels.every((rel) => !(countBy[rel] > 0) || countBy[rel] >= min);
  const othersShown = others >= min;
  const groups = {};
  for (const rel of RELATIONS) groups[rel] = { count: countBy[rel] || 0, hidden: peerRels.includes(rel) && (countBy[rel] || 0) > 0 && !breakdownOk };
  const shown = (rel) => rel === 'self' || rel === 'manager' || (breakdownOk && (countBy[rel] || 0) >= min);
  const byComp = comps.map((cid) => {
    const mine = rows.filter((r) => Number(r.competencyId) === Number(cid));
    const by = (rels) => avg(mine.filter((r) => rels.includes(r.relation)).map((r) => r.score));
    const out = { competencyId: Number(cid), self: by(['self']) };
    for (const rel of RELATIONS.slice(1)) out[rel] = shown(rel) ? by([rel]) : null;
    out.others = othersShown ? by(peerRels) : null;
    for (const k of ['self', ...RELATIONS.slice(1), 'others']) if (out[k] !== null) out[k] = r2(out[k]);
    out.gap = out.self !== null && out.others !== null ? r2(out.self - out.others) : null; // > 0 : se surestime ; < 0 : se sous-estime
    return out;
  });
  const comments = rows.filter((r) => r.comment && (r.relation === 'self' || r.relation === 'manager' || othersShown)).map((r) => ({ relation: r.relation === 'self' || r.relation === 'manager' ? r.relation : shown(r.relation) ? r.relation : 'others', competencyId: Number(r.competencyId), text: r.comment }))
    .sort((a, b) => a.text.localeCompare(b.text));
  const so = byComp.filter((c) => c.self !== null).map((c) => c.self); const ot = byComp.filter((c) => c.others !== null).map((c) => c.others);
  return { groups, minResponses: min, othersCount: others, othersHidden: others > 0 && !othersShown, breakdownHidden: !breakdownOk, competencies: byComp, comments, selfAvg: so.length ? r2(avg(so)) : null, othersAvg: ot.length ? r2(avg(ot)) : null };
}

// ---------- Talents : 9-box ----------
/** Niveau 1 (faible) / 2 (moyen) / 3 (élevé) à partir d'une note de 1 à 5 : < 2,5 faible, < 3,75 moyen, sinon élevé. */
const band = (v) => (v < 2.5 ? 1 : v < 3.75 ? 2 : 3);
const BOX_KEYS = { '3-3': 'star', '2-3': 'future_leader', '1-3': 'enigma', '3-2': 'high_performer', '2-2': 'core', '1-2': 'dilemma', '3-1': 'trusted_expert', '2-1': 'effective', '1-1': 'risk' };
/** Case 9-box (performance en x, potentiel en y) : box 1..9 (7 8 9 en haut = fort potentiel). */
function nineBox(performance, potential) {
  const p = band(performance); const q = band(potential);
  return { perf: p, pot: q, box: (q - 1) * 3 + p, key: BOX_KEYS[`${p}-${q}`], highPotential: q === 3 && p >= 2 };
}
/** Note de performance 1–5 proposée à partir d'un score de réalisation 0–100 (MBO). */
const perfFromScore = (s) => (s === null || s === undefined ? null : r1(1 + 4 * Math.max(0, Math.min(100, s)) / 100));

// ---------- Rémunération ----------
const compaRatio = (salary, mid) => (mid > 0 ? r2(salary / mid) : null);
const rangePenetration = (salary, min, max) => (max > min ? r1(Math.max(0, Math.min(1, (salary - min) / (max - min))) * 100) : null);
/** Simulation de révision : params = { generalPct, meritByBox: {box:pct}, minToGrade: bool, capPct }. */
function simulateRaise(rows, params) {
  const out = rows.map((r) => {
    let pct = Number(params.generalPct || 0);
    if (params.meritByBox && r.box && params.meritByBox[r.box] != null) pct += Number(params.meritByBox[r.box]);
    if (params.capPct != null) pct = Math.min(pct, Number(params.capPct));
    let ns = Math.round(r.salary * (1 + pct / 100));
    if (params.minToGrade && r.min && ns < r.min) ns = r.min;
    if (params.capToMax && r.max && ns > r.max) ns = r.max;
    return { ...r, newSalary: ns, delta: ns - r.salary, pct: r.salary ? r2(100 * (ns - r.salary) / r.salary) : 0, newCompa: r.mid ? compaRatio(ns, r.mid) : null };
  });
  const before = out.reduce((s, x) => s + x.salary, 0); const after = out.reduce((s, x) => s + x.newSalary, 0);
  return { lines: out, monthlyBefore: before, monthlyAfter: after, monthlyDelta: after - before, annualDelta: (after - before) * 12 };
}

// ---------- Effectifs ----------
/** Coût d'une ligne de scénario sur l'année : qty × salaire mensuel × mois restants × (1 + charges). */
const lineCost = (l, rate) => Math.round(l.qty * l.monthlySalary * (13 - l.startMonth) * (1 + rate));

// ---------- Carrières / succession ----------
const READY = { now: 0, '1-2y': 1, '3y+': 2, later: 2 };
const READY_OK = ['now', '1-2y', '3y+'];
/** Risque de vacance : 'critical' | 'high' | 'medium' | 'low' (déterministe). */
function vacancyRisk({ criticality, successors, holderRisk, holderAge, vacant }) {
  const ready = successors.filter((s) => s.readiness === 'now').length;
  const soon = successors.filter((s) => s.readiness === '1-2y').length;
  const holderThreat = vacant || holderRisk === 'high' || (holderAge !== null && holderAge !== undefined && holderAge >= 58);
  let pts = 0;
  if (ready === 0) pts += soon === 0 ? 3 : 2;
  else if (ready === 1) pts += 1;
  if (holderThreat) pts += 2; else if (holderRisk === 'medium') pts += 1;
  if (criticality === 3) pts += 1;
  return { points: pts, level: pts >= 5 ? 'critical' : pts >= 3 ? 'high' : pts >= 2 ? 'medium' : 'low', readyNow: ready, ready12: soon };
}

// ---------- Engagement ----------
/** eNPS : % promoteurs (9–10) − % détracteurs (0–6), sur des notes de 0 à 10. */
function enps(scores) {
  const n = scores.length;
  if (!n) return null;
  const p = scores.filter((s) => s >= 9).length; const d = scores.filter((s) => s <= 6).length;
  return { n, promoters: p, passives: n - p - d, detractors: d, score: Math.round(100 * (p - d) / n) };
}

// ---------- KPI ----------
const ageOf = (birth, today) => { if (!birth) return null; const [y, m, d] = birth.split('-').map(Number); const [Y, M, D] = today.split('-').map(Number); return Y - y - (M < m || (M === m && D < d) ? 1 : 0); };
const yearsBetween = (a, b) => (a && b ? r1((Date.parse(b) - Date.parse(a)) / 86400000 / 365.25) : null);
const AGE_BANDS = [['<25', 0, 24], ['25-34', 25, 34], ['35-44', 35, 44], ['45-54', 45, 54], ['55+', 55, 200]];
function pyramid(people, today) {
  const rows = AGE_BANDS.map(([label, lo, hi]) => ({ band: label, male: 0, female: 0, other: 0 }));
  let unknown = 0;
  for (const p of people) {
    const a = ageOf(p.birth, today);
    if (a === null) { unknown++; continue; }
    const i = AGE_BANDS.findIndex(([, lo, hi]) => a >= lo && a <= hi);
    rows[i][p.gender === 'M' ? 'male' : p.gender === 'F' ? 'female' : 'other']++;
  }
  return { bands: rows, unknown };
}

module.exports = { r1, r2, avg, gaps, coverage, matchScore, smartCheck, goalProgress, goalScore, RELATIONS, aggregate360, band, nineBox, BOX_KEYS, perfFromScore, compaRatio, rangePenetration, simulateRaise, lineCost, vacancyRisk, READY_OK, READY, enps, ageOf, yearsBetween, pyramid };
