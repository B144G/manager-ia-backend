'use strict';
// Forfait sur mesure : l'utilisateur choisit une somme et une durée (semaine, mois, trimestre, semestre ou an) ; les capacités du forfait se déduisent de la somme ET de la durée.
// Règle : on mesure la somme par rapport au prix de l'offre « Illimité » de la MÊME durée (config.plans) :
//   part = somme ÷ prix d'Illimité pour cette durée ; niveau = part × 150 000 (le niveau d'Illimité par mois).
// Puis les capacités se lisent sur une échelle qui passe par les offres de référence :
//   0 -> niveau de l'offre Gratuite ; 10 000 (forfait minimum) ; 50 000 (Pro) ; 75 000 (Pro Max) ; 100 000 (Méga Pro) ; 150 000 (Illimité).
// Conséquence voulue : pour la MÊME somme, plus la durée est courte, plus le forfait est élevé (10 000 FCFA pour 7 jours > pour 1 mois > pour 3 mois > pour 6 mois > pour 1 an).
// Le forfait est mémorisé dans le NOM de l'offre de l'abonné (« Sur mesure|15000|7 » = 15 000 FCFA pour 7 jours) : aucune nouvelle colonne, et les limites se recalculent à la demande.
const config = require('../config');

const PREFIX = 'Sur mesure|';
const STEP = 500; // la somme est un multiple de 500 FCFA
const int = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n > 0 ? n : d; };
const MIN_AMOUNT = int('CUSTOM_MIN_AMOUNT', int('CUSTOM_MIN_MONTH', 10000)); // forfait minimum, quelle que soit la durée
// Messages IA d'un forfait sur mesure : l'échelle des offres de référence multipliée par ce coefficient (1,5 = 50 % de messages en plus). CUSTOM_AI_BOOST le règle (1 à 5).
const AI_BOOST = Math.min(Math.max(parseFloat(process.env.CUSTOM_AI_BOOST) || 1.5, 1), 5);
const TOP_LEVEL = 150000; // niveau de l'offre Illimité

const PERIODS = {
  week: { id: 'week', label: 'semaine', plan: 'unl_week' },
  month: { id: 'month', label: 'mois', plan: 'unl_month' },
  quarter: { id: 'quarter', label: 'trimestre', plan: 'unl_quarter' },
  semester: { id: 'semester', label: 'semestre', plan: 'unl_semester' },
  year: { id: 'year', label: 'an', plan: 'unl_year' },
};
for (const p of Object.values(PERIODS)) { p.days = config.plans[p.plan].days; p.months = p.days / 30; p.unlimited = config.plans[p.plan].priceXAF; }

const floorStep = (n) => Math.floor(n / STEP) * STEP;
const minFor = () => MIN_AMOUNT;
const maxFor = (p) => floorStep(p.unlimited);

/** Points de l'échelle : [niveau, capacités]. */
function anchors() {
  const W = config.workspaceLimits;
  const pick = (name) => ({ orgs: W[name].orgs, members: W[name].members, branches: W[name].branches, aiMonth: W[name].aiMonth, emailDay: W[name].emailDay });
  return [
    [0, pick('Gratuit')],
    [MIN_AMOUNT, { orgs: 1, members: 5, branches: 1, aiMonth: 200, emailDay: 10 }],
    [50000, pick('Pro')], [75000, pick('Pro Max')], [100000, pick('Méga Pro')], [TOP_LEVEL, pick('Illimité')],
  ].sort((a, b) => a[0] - b[0]);
}
const round = (n, to) => Math.max(to, Math.round(n / to) * to);

/** Capacités pour un niveau (0 à 150 000). */
function capacityAt(level) {
  const a = anchors();
  const e = Math.min(Math.max(level, 0), TOP_LEVEL);
  let i = 0; while (i < a.length - 2 && e > a[i + 1][0]) i++;
  const [x0, c0] = a[i], [x1, c1] = a[i + 1];
  const t = x1 === x0 ? 0 : (e - x0) / (x1 - x0);
  const lerp = (k) => c0[k] + (c1[k] - c0[k]) * t;
  return { orgs: Math.max(1, Math.round(lerp('orgs'))), members: Math.max(1, Math.round(lerp('members'))), branches: Math.max(1, Math.round(lerp('branches'))), aiMonth: round(lerp('aiMonth') * AI_BOOST, 10), emailDay: round(lerp('emailDay'), 5) };
}
const levelOf = (amount, period) => Math.round((amount / period.unlimited) * TOP_LEVEL);

const periodOfDays = (days) => Object.values(PERIODS).find((p) => p.days === days) || null;
const nameOf = (amount, days) => `${PREFIX}${amount}|${days}`;

/** Lit un nom d'offre « Sur mesure|somme|jours ». Renvoie null si ce n'est pas un forfait sur mesure valide. */
function parse(name) {
  const m = /^Sur mesure\|(\d{3,9})\|(\d{1,4})$/.exec(String(name || ''));
  if (!m) return null;
  const amount = Number(m[1]), days = Number(m[2]), period = periodOfDays(days);
  return period ? { name: String(name), amount, days, period, level: levelOf(amount, period) } : null;
}
const isCustom = (name) => String(name || '').startsWith(PREFIX);

const fmt = (n) => Number(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ');
const DURATION_TEXT = { week: 'une semaine', month: 'un mois', quarter: 'un trimestre', semester: 'six mois', year: 'un an' };

/** Vérifie une demande (somme + durée) ; lève une Error (.status = 400) avec un message clair. */
function check(amount, periodId) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
  const period = Object.prototype.hasOwnProperty.call(PERIODS, periodId) ? PERIODS[periodId] : null;
  if (!period) throw bad("Choisissez le temps d'utilisation : une semaine, un mois, un trimestre, six mois ou un an.");
  const a = Number(amount);
  if (!Number.isInteger(a) || a <= 0) throw bad('Indiquez une somme en FCFA (nombre entier).');
  if (a % STEP) throw bad(`La somme doit être un multiple de ${STEP} FCFA (exemple : 15 000).`);
  if (a < minFor()) throw bad(`Le forfait minimum est de ${fmt(minFor())} FCFA.`);
  if (a > maxFor(period)) throw bad(`Au-delà de ${fmt(maxFor(period))} FCFA, le forfait n'apporte plus rien de plus pour ${DURATION_TEXT[period.id]} : c'est déjà l'offre Illimité. Choisissez une somme plus basse.`);
  return { period, amount: a };
}

const aiFor = (cap, period) => (period.id === 'week' ? Math.max(20, round(cap.aiMonth * period.months, 5)) : cap.aiMonth);
const perDay = (aiPeriod, period) => Math.round((aiPeriod / (period.id === 'week' ? 7 : 30)) * 10) / 10;

/** Niveau de fonctions : sous le forfait minimum, rien de réservé ; à partir du minimum, les fonctions « Pro » ; au-dessus, les paliers des offres de référence. */
function rankOfLevel(level) {
  return level >= TOP_LEVEL ? 4 : level >= 100000 ? 3 : level >= 75000 ? 2 : level >= MIN_AMOUNT ? 1 : 0;
}

/** Accès : pour chaque fonction réservée à une offre, indique si ce forfait la contient (selon son niveau). */
function featuresAt(rank) {
  const F = require('../workspace/features');
  return Object.entries(F.FEATURES).map(([key, [minPlan, label]]) => ({ key, label, minPlan, included: (F.PLAN_RANK[minPlan] || 0) <= rank }));
}

/** Détail d'un forfait : somme, durée, capacités. Pour une semaine, le quota de messages IA est celui de la semaine (proportionnel). */
function quote(amount, periodId) {
  const { period, amount: a } = check(amount, periodId);
  const level = levelOf(a, period);
  const cap = capacityAt(level);
  const aiPeriod = aiFor(cap, period);
  return {
    plan: nameOf(a, period.days), amount: a, period: period.id, periodLabel: period.label, days: period.days, level,
    sharePct: Math.round((a / period.unlimited) * 1000) / 10, unlimitedPrice: period.unlimited,
    limits: { orgs: cap.orgs, members: cap.members, branches: cap.branches, aiMonth: aiPeriod, emailDay: cap.emailDay },
    aiPerDay: perDay(aiPeriod, period),
    rank: rankOfLevel(level),
    features: featuresAt(rankOfLevel(level)),
  };
}

/** Limites appliquées à un abonné dont l'offre est « Sur mesure|… » (null sinon). */
function limitsOf(name) {
  const p = parse(name);
  if (!p) return null;
  const cap = capacityAt(p.level);
  return { orgs: cap.orgs, members: cap.members, branches: cap.branches, aiMonth: aiFor(cap, p.period), emailDay: cap.emailDay };
}
const rankOf = (name) => { const p = parse(name); return p ? rankOfLevel(p.level) : null; };
/** Nom lisible d'une offre (les offres habituelles gardent leur nom). */
const label = (name) => { const p = parse(name); return p ? `Sur mesure (${fmt(p.amount)} FCFA / ${p.period.label})` : String(name || ''); };
/** Durée du bloc de quota IA : une semaine pour un forfait d'une semaine, sinon la durée habituelle de l'abonnement. */
const quotaDays = (name) => { const p = parse(name); return p && p.period.id === 'week' ? 7 : config.durationDays; };

function info() {
  return { step: STEP, minAmount: MIN_AMOUNT, periods: Object.values(PERIODS).map((p) => ({ id: p.id, label: p.label, days: p.days, min: minFor(), max: maxFor(p), unlimited: p.unlimited })) };
}

module.exports = { AI_BOOST, PERIODS, parse, isCustom, check, quote, limitsOf, rankOf, label, quotaDays, nameOf, info, capacityAt, levelOf };
