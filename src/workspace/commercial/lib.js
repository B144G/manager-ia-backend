'use strict';
// Module Commercial : calculs PURS (aucun accès à la base) — scores, segmentation, prévision, marges, commissions, fidélité.
// Tous les nombres sont testés avec des valeurs chiffrées (scripts/test-commercial.js). Rien ici n'engage l'entreprise : ce sont des aides à la décision.

const clamp = (n, a = 0, b = 100) => Math.min(b, Math.max(a, n));
const round = (n, d = 0) => { const k = 10 ** d; return Math.round((Number(n) || 0) * k) / k; };
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const dayMs = 86400000;
const toDay = (iso) => String(iso || '').slice(0, 10);
const daysBetween = (a, b) => Math.floor((Date.parse(`${toDay(b)}T00:00:00Z`) - Date.parse(`${toDay(a)}T00:00:00Z`)) / dayMs);
const addDays = (d, n) => { const x = new Date(`${toDay(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monthOf = (iso) => String(iso || '').slice(0, 7);
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const monthsBetween = (from, to) => { const out = []; for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m); return out; };

// ---------- Réglages par défaut (fusionnés avec ceux de l'organisation) ----------
const DEFAULTS = {
  sourceWeights: { referral: 18, whatsapp: 14, trade_show: 12, field: 10, ad: 7, web: 6, other: 3 },
  tempWeights: { chaud: 20, tiede: 10, froid: 2 },
  bantWeights: { budget: 25, authority: 25, need: 25, timing: 25 },
  leadGrades: { A: 70, B: 45, C: 25 },
  rfmWindowMonths: 24,
  staleLeadDays: 7,
  defaultStagnantDays: 14,
  forecastAlpha: 0.4,
  forecastWindow: 3,
  blendPipeline: 60,
  scenarioFactors: { pessimistic: 0.7, central: 1, optimistic: 1.25 },
  discountCaps: { sales_manager: 30, sales_assistant: 5, sales_field: 8 },
  quoteValidityDays: 30,
  marginMinPct: 10,
  loyaltyPointsPer1000: 1,
  loyaltyTiers: { silver: 500, gold: 2000, platinum: 5000 },
  clvYears: 3,
  churnHigh: 70,
  churnMedium: 40,
  defaultIntervalDays: 90,
  elasticity: -1,
};
const mergeSettings = (stored) => {
  const s = stored && typeof stored === 'object' ? stored : {};
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) out[k] = v && typeof v === 'object' ? { ...v, ...(s[k] && typeof s[k] === 'object' ? s[k] : {}) } : (s[k] !== undefined ? s[k] : v);
  for (const [k, v] of Object.entries(s)) if (!(k in out)) out[k] = v;
  return out;
};

// ---------- BANT (Budget, Autorité, Besoin, Délai) ----------
const BANT_KEYS = ['budget', 'authority', 'need', 'timing'];
/** Note de 0 à 4 par critère (0 inconnu … 4 confirmé). Seuls les critères VALIDÉS PAR UN HUMAIN comptent : une suggestion de l'IA ne vaut rien tant qu'elle n'est pas validée. */
function bantScore(bant, weights = DEFAULTS.bantWeights) {
  const b = bant && typeof bant === 'object' ? bant : {};
  const total = BANT_KEYS.reduce((a, k) => a + num(weights[k], 25), 0) || 100;
  let s = 0;
  for (const k of BANT_KEYS) {
    const c = b[k];
    if (c && c.validated) s += num(weights[k], 25) * clamp(num(c.rating), 0, 4) / 4;
  }
  return Math.round((s * 100) / total);
}

// ---------- Score d'un prospect (0 à 100) ----------
/** Profil (max 27) + source (max 18) + intention (max 20) + budget (5) + échanges (max 10) + récence (max 10) + BANT (15 % du score BANT, max 15) = 105, plafonné à 100. */
function scoreLead(l, o = {}) {
  const set = mergeSettings(o.settings);
  const parts = {};
  parts.profile = (l.phone ? 8 : 0) + (l.email ? 6 : 0) + (l.company ? 6 : 0) + (l.city ? 3 : 0) + (l.product ? 4 : 0);
  parts.source = num(set.sourceWeights[l.source], set.sourceWeights.other);
  parts.intent = num(set.tempWeights[l.temperature], 0);
  parts.budget = num(l.budget_est) > 0 ? 5 : 0;
  parts.engagement = Math.min(10, Math.max(0, Math.floor(num(o.messages))));
  const d = o.lastContactDays;
  parts.recency = d === null || d === undefined ? 0 : d <= 3 ? 10 : d <= 14 ? 5 : d <= 30 ? 2 : 0;
  parts.bant = Math.round(clamp(num(l.bant_score)) * 0.15);
  const total = clamp(Object.values(parts).reduce((a, b) => a + b, 0));
  const g = set.leadGrades;
  return { score: total, grade: total >= g.A ? 'A' : total >= g.B ? 'B' : total >= g.C ? 'C' : 'D', parts };
}

// ---------- Attribution automatique ----------
/** candidates : [{ userId, load }]. 'load' : le moins chargé (à égalité, le plus petit identifiant) ; 'round_robin' : le suivant après lastUserId. */
function pickAssignee(candidates, strategy = 'load', lastUserId = null) {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => a.userId - b.userId);
  if (strategy === 'round_robin') {
    const next = sorted.find((c) => c.userId > num(lastUserId, -1));
    return (next || sorted[0]).userId;
  }
  return [...sorted].sort((a, b) => a.load - b.load || a.userId - b.userId)[0].userId;
}

// ---------- Texte : doublons ----------
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const LEGAL = /\b(sarl|sa|sas|sasu|ets|etablissements?|entreprise|societe|groupe|cie|ltd|llc|gie)\b/g;
const normName = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
const phoneKey = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-9) : ''; };
const emailKey = (e) => { const x = String(e || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x) ? x : ''; };
const bigrams = (s) => { const t = ` ${s} `; const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
/** Coefficient de Dice sur les bigrammes (0 à 1). */
function dice(a, b) {
  const x = normName(a); const y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x); const by = bigrams(y);
  let inter = 0; let nx = 0; let ny = 0;
  for (const [g, c] of bx) { nx += c; if (by.has(g)) inter += Math.min(c, by.get(g)); }
  for (const c of by.values()) ny += c;
  return (2 * inter) / (nx + ny);
}
/** Groupes de doublons probables : même téléphone (9 derniers chiffres), même e-mail, ou nom très proche (Dice ≥ 0,85). rows : [{id, name, phone, email}] */
function duplicateGroups(rows, threshold = 0.85) {
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const reasons = new Map();
  const link = (a, b, why) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); const k = find(a); if (!reasons.has(k)) reasons.set(k, new Set()); reasons.get(k).add(why); };
  const by = (fn, why) => { const m = new Map(); for (const r of rows) { const k = fn(r); if (k) { if (m.has(k)) link(m.get(k), r.id, why); else m.set(k, r.id); } } };
  by((r) => phoneKey(r.phone), 'phone');
  by((r) => emailKey(r.email), 'email');
  by((r) => normName(r.name), 'name');
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (find(rows[i].id) !== find(rows[j].id) && dice(rows[i].name, rows[j].name) >= threshold) link(rows[i].id, rows[j].id, 'similar_name');
  const groups = new Map();
  for (const r of rows) { const k = find(r.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    const why = new Set();
    // Les raisons sont recalculées sur le groupe final (les fusions de groupes déplacent la racine).
    for (const [rk, set] of reasons) if (list.some((r) => find(r.id) === find(rk))) for (const w of set) why.add(w);
    out.push({ key: k, reasons: [...why].sort(), rows: list });
  }
  return out;
}

// ---------- Segmentation RFM et ABC ----------
/** Note de 1 à 5 d'une valeur parmi toutes : 1 + ⌊5 × (nombre de valeurs strictement moins bonnes) / n⌋, plafonnée à 5. higherIsBetter=false pour la récence (moins de jours = mieux). */
function quintile(v, all, higherIsBetter = true) {
  const n = all.length;
  if (!n) return 1;
  const worse = all.filter((x) => (higherIsBetter ? x < v : x > v)).length;
  return Math.min(5, 1 + Math.floor((5 * worse) / n));
}
const RFM_SEGMENTS = ['champions', 'loyal', 'promising', 'new', 'need_attention', 'at_risk', 'hibernating', 'lost'];
function rfmSegment(R, F) {
  if (R >= 4 && F >= 4) return 'champions';
  if (R >= 3 && F >= 3) return 'loyal';
  if (R >= 4 && F === 1) return 'new';
  if (R >= 4) return 'promising';
  if (R === 3) return 'need_attention';
  if (F >= 3) return 'at_risk';
  if (R === 2) return 'hibernating';
  return 'lost';
}
/** rows : [{ id, recencyDays, frequency, monetary }] → ajoute r, f, m (1 à 5), rfm ('545'), segment. */
function rfm(rows) {
  const rec = rows.map((r) => r.recencyDays); const fre = rows.map((r) => r.frequency); const mon = rows.map((r) => r.monetary);
  return rows.map((r) => {
    const R = quintile(r.recencyDays, rec, false); const F = quintile(r.frequency, fre); const M = quintile(r.monetary, mon);
    return { ...r, r: R, f: F, m: M, rfm: `${R}${F}${M}`, segment: rfmSegment(R, F) };
  });
}
/** Classes ABC (Pareto) : A tant que le cumul AVANT le client est < 80 % du total, B < 95 %, sinon C. rows : [{ id, monetary }] */
function abc(rows, a = 80, b = 95) {
  const total = rows.reduce((s, r) => s + Math.max(0, num(r.monetary)), 0);
  const sorted = [...rows].sort((x, y) => y.monetary - x.monetary || x.id - y.id);
  let cum = 0;
  return sorted.map((r) => {
    const before = total ? (cum * 100) / total : 100;
    cum += Math.max(0, num(r.monetary));
    return { ...r, share: total ? round((Math.max(0, num(r.monetary)) * 100) / total, 1) : 0, cumShare: total ? round((cum * 100) / total, 1) : 0, abc: before < a ? 'A' : before < b ? 'B' : 'C' };
  });
}

/** Règles d'un segment personnalisé : [{ field, op, value }] toutes vraies (ET). op : eq, ne, gt, gte, lt, lte, in, contains. */
const RULE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'];
function matchRules(obj, rules) {
  return (rules || []).every((r) => {
    const v = obj[r.field];
    const w = r.value;
    switch (r.op) {
      case 'eq': return String(v ?? '').toLowerCase() === String(w ?? '').toLowerCase();
      case 'ne': return String(v ?? '').toLowerCase() !== String(w ?? '').toLowerCase();
      case 'gt': return num(v) > num(w);
      case 'gte': return num(v) >= num(w);
      case 'lt': return num(v) < num(w);
      case 'lte': return num(v) <= num(w);
      case 'in': return (Array.isArray(w) ? w : String(w ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).includes(String(v ?? '').toLowerCase());
      case 'contains': return stripAccents(v).toLowerCase().includes(stripAccents(w).toLowerCase());
      default: return false;
    }
  });
}

const weighted = (amount, prob) => Math.round((num(amount) * clamp(num(prob))) / 100);


// ---------- SPIN Selling : synthèse du besoin ----------
const SPIN_KEYS = ['situation', 'problem', 'implication', 'payoff'];
const SPIN_NEEDED = { situation: 2, problem: 1, implication: 2, payoff: 1 };
const SPIN_WEIGHTS = { situation: 15, problem: 25, implication: 30, payoff: 30 };
const answered = (list) => (Array.isArray(list) ? list : []).filter((x) => x && String(x.a || '').trim());
/** Synthèse de fiches SPIN : réponses utiles par rubrique, complétude 0-100 (chaque rubrique compte jusqu'à son nombre de réponses attendu), maturité du besoin et rubriques manquantes. */
function spinSynthesis(sheets) {
  const out = {};
  for (const k of SPIN_KEYS) out[k] = (sheets || []).flatMap((sh) => answered(sh[k])).map((x) => ({ q: String(x.q || ''), a: String(x.a).trim(), key: Boolean(x.key) }));
  let completeness = 0;
  for (const k of SPIN_KEYS) completeness += SPIN_WEIGHTS[k] * Math.min(1, out[k].length / SPIN_NEEDED[k]);
  const missing = SPIN_KEYS.filter((k) => out[k].length < SPIN_NEEDED[k]);
  const pick = (k) => (out[k].find((x) => x.key) || out[k][0] || {}).a || '';
  const maturity = out.problem.length && out.implication.length && out.payoff.length ? 'explicit' : out.problem.length ? 'implicit' : 'none';
  return { sections: out, counts: Object.fromEntries(SPIN_KEYS.map((k) => [k, out[k].length])), completeness: Math.round(completeness), missing, maturity, need: { problem: pick('problem'), implication: pick('implication'), payoff: pick('payoff') } };
}

// ---------- Prévision ----------
/** Moyenne mobile des k dernières valeurs. */
const movingAverage = (series, k = 3) => { const t = series.slice(-k); return t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0; };
/** Lissage exponentiel simple : niveau_0 = y_0, niveau_t = α·y_t + (1−α)·niveau_(t−1) ; la prévision est le dernier niveau. */
function ses(series, alpha = 0.4) {
  if (!series.length) return 0;
  let l = series[0];
  for (let i = 1; i < series.length; i++) l = alpha * series[i] + (1 - alpha) * l;
  return l;
}
/** Rétro-test : pour chaque mois t ≥ minHistory, prévision faite avec les mois avant t, comparée au réalisé ; erreur moyenne en % (MAPE) sur les mois non nuls. */
function backtest(series, alpha = 0.4, minHistory = 3) {
  const rows = [];
  for (let t = minHistory; t < series.length; t++) {
    const f = ses(series.slice(0, t), alpha);
    rows.push({ index: t, actual: series[t], forecast: Math.round(f), errorPct: series[t] ? Math.round((Math.abs(series[t] - f) * 1000) / series[t]) / 10 : null });
  }
  const ok = rows.filter((r) => r.errorPct !== null);
  return { rows, mape: ok.length ? Math.round((ok.reduce((a, r) => a + r.errorPct, 0) / ok.length) * 10) / 10 : null };
}
/** Atterrissage d'un mois = déjà réalisé + pipeline pondéré (W) selon le scénario ; l'optimiste est plafonné au pipeline non pondéré (A). */
function landing(realized, W, A, f = DEFAULTS.scenarioFactors) {
  return { pessimistic: Math.round(realized + W * f.pessimistic), central: Math.round(realized + W * f.central), optimistic: Math.round(realized + Math.min(W * f.optimistic, A)) };
}

// ---------- Devis : remise par rapport au prix de liste ----------
/** Remise en % (1 décimale) = 1 − total vendu / total au prix de liste. Un prix de liste inconnu (0) se compte au prix de la ligne. */
function discountPct(lines) {
  let sold = 0; let list = 0;
  for (const l of lines) { const q = num(l.quantity); const p = num(l.price); const lp = num(l.listPrice) > 0 ? num(l.listPrice) : p; sold += q * p; list += q * Math.max(lp, p); }
  return list > 0 ? Math.round((1 - sold / list) * 1000) / 10 : 0;
}
/** Plafond de remise (en %) d'un rôle ; le responsable du compte n'a pas de plafond. */
const discountCap = (role, boss, caps = DEFAULTS.discountCaps) => (boss ? 100 : num(caps[role], 0));

// ---------- Marges ----------
/** Chiffre d'affaires HT d'une ligne (les prix saisis sont TTC si pricesIncl) puis marge. cost : coût unitaire connu, ou null (marge inconnue). */
function lineMargin(line, { vatRate = 0, pricesIncl = true } = {}, cost) {
  const q = num(line.quantity); const gross = q * num(line.price);
  const ht = pricesIncl && vatRate > 0 ? gross / (1 + vatRate / 100) : gross;
  if (cost === null || cost === undefined) return { revenue: Math.round(ht), cost: null, margin: null, pct: null };
  const c = Math.round(q * num(cost));
  return { revenue: Math.round(ht), cost: c, margin: Math.round(ht) - c, pct: ht > 0 ? round(((ht - c) * 100) / ht, 1) : null };
}
/** Marge d'un ensemble de lignes déjà calculées ; les lignes sans coût sont exclues et la couverture (part du CA dont le coût est connu) est donnée. */
function sumMargins(list) {
  const known = list.filter((m) => m.margin !== null);
  const revAll = list.reduce((a, m) => a + m.revenue, 0); const rev = known.reduce((a, m) => a + m.revenue, 0);
  const margin = known.reduce((a, m) => a + m.margin, 0);
  return { revenue: revAll, knownRevenue: rev, cost: known.reduce((a, m) => a + m.cost, 0), margin, pct: rev > 0 ? round((margin * 100) / rev, 1) : null, coverage: revAll > 0 ? round((rev * 100) / revAll, 1) : 0 };
}
/** Simulation d'un changement de prix : volume = base × (1 + élasticité × variation du prix en %). */
function simulatePrice({ qty, price, cost = 0, newPrice, elasticity = -1 }) {
  const pctPrice = price > 0 ? ((newPrice - price) * 100) / price : 0;
  const volPct = elasticity * pctPrice;
  const q1 = Math.max(0, qty * (1 + volPct / 100));
  const base = { qty, revenue: Math.round(qty * price), margin: Math.round(qty * (price - cost)) };
  const sim = { qty: round(q1, 1), revenue: Math.round(q1 * newPrice), margin: Math.round(q1 * (newPrice - cost)) };
  const be = newPrice - cost > 0 ? (qty * (price - cost)) / (newPrice - cost) : null;
  return { priceChangePct: round(pctPrice, 1), volumeChangePct: round(volPct, 1), base, simulated: sim, deltaRevenue: sim.revenue - base.revenue, deltaMargin: sim.margin - base.margin, breakEvenQty: be === null ? null : round(be, 1), breakEvenVolumePct: be === null || !qty ? null : round(((be - qty) * 100) / qty, 1) };
}

// ---------- Commissions et objectifs ----------
/** Commission progressive : tiers [{ upTo (null = sans limite), rate % }] appliqués par tranche ; prime = la plus haute prime dont le seuil d'atteinte (%) est atteint. */
function commission(basis, tiers, bonuses = [], attainmentPct = null) {
  let prev = 0; let total = 0; const detail = [];
  for (const t of tiers) {
    const top = t.upTo === null || t.upTo === undefined ? Infinity : num(t.upTo);
    const slice = Math.max(0, Math.min(basis, top) - prev);
    const amount = (slice * num(t.rate)) / 100;
    detail.push({ upTo: t.upTo ?? null, rate: num(t.rate), base: Math.round(slice), amount: Math.round(amount) });
    total += amount; prev = top;
    if (basis <= top) break;
  }
  const hit = attainmentPct === null ? [] : bonuses.filter((b) => attainmentPct >= num(b.attainmentPct));
  const bonus = hit.length ? Math.max(...hit.map((b) => num(b.bonus))) : 0;
  return { commission: Math.round(total), bonus, total: Math.round(total) + bonus, detail };
}
/** Répartition d'un total entier selon des poids, sans perte (méthode du plus fort reste). */
function decompose(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = Math.round(total) - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++;
  return out;
}

// ---------- Fidélisation ----------
/** Score de risque de départ (0-100) : retard sur le rythme d'achat habituel (jusqu'à 70), réclamation ouverte (+15), note NPS ≤ 6 (+15), achats récents en baisse de plus de moitié (+10). */
function churnScore({ daysSinceLast, intervalDays, openComplaints = 0, lastNps = null, recent = 0, previous = 0 }) {
  const ratio = intervalDays > 0 ? daysSinceLast / intervalDays : 0;
  const parts = { delay: Math.min(70, Math.round(ratio * 35)), complaint: openComplaints > 0 ? 15 : 0, nps: lastNps !== null && lastNps <= 6 ? 15 : 0, decline: previous > 0 && recent < previous * 0.5 ? 10 : 0 };
  return { score: clamp(Object.values(parts).reduce((a, b) => a + b, 0)), parts };
}
const churnLevel = (score, high = 70, med = 40) => (score >= high ? 'high' : score >= med ? 'medium' : 'low');
/** Rythme d'achat : écart moyen entre premier et dernier achat (jours) divisé par (achats − 1) ; un seul achat → valeur par défaut. */
const purchaseInterval = (dates, def = 90) => { const d = [...dates].sort(); return d.length >= 2 ? Math.max(1, daysBetween(d[0], d[d.length - 1]) / (d.length - 1)) : def; };
/** Valeur vie client prévue = panier moyen × achats par an × durée de vie (années) × taux de marge (1 si inconnu). */
function clv({ avgBasket, purchases, tenureDays, years = 3, marginRate = 1 }) {
  const perYear = purchases / Math.max(tenureDays / 365, 0.25);
  return Math.round(avgBasket * perYear * years * marginRate);
}
/** NPS = % de promoteurs (9-10) − % de détracteurs (0-6). */
function nps(scores) {
  if (!scores.length) return { nps: null, promoters: 0, passives: 0, detractors: 0, total: 0 };
  const p = scores.filter((s) => s >= 9).length; const d = scores.filter((s) => s <= 6).length;
  return { nps: Math.round(((p - d) * 100) / scores.length), promoters: p, passives: scores.length - p - d, detractors: d, total: scores.length };
}
const loyaltyTier = (lifetime, tiers = DEFAULTS.loyaltyTiers) => (lifetime >= tiers.platinum ? 'platinum' : lifetime >= tiers.gold ? 'gold' : lifetime >= tiers.silver ? 'silver' : 'base');

module.exports = {
  lineMargin, sumMargins, simulatePrice, commission, decompose, churnScore, churnLevel, purchaseInterval, clv, nps, loyaltyTier,
  SPIN_KEYS, SPIN_NEEDED, spinSynthesis, movingAverage, ses, backtest, landing, discountPct, discountCap,
  clamp, round, num, dayMs, toDay, daysBetween, addDays, monthOf, addMonths, monthsBetween,
  DEFAULTS, mergeSettings, BANT_KEYS, bantScore, scoreLead, pickAssignee,
  normName, phoneKey, emailKey, dice, duplicateGroups, quintile, RFM_SEGMENTS, rfmSegment, rfm, abc, RULE_OPS, matchRules, weighted, stripAccents,
};
