'use strict';
// Forfait sur mesure : l'utilisateur choisit une somme et une durée (semaine, mois ou an) ; les capacités du forfait se déduisent de la somme.
// Règle : on ramène la somme à un équivalent MENSUEL (somme ÷ nombre de mois de la durée), puis on lit les capacités sur une échelle qui passe par les offres existantes :
//   10 000 FCFA/mois (forfait minimum) -> Pro 50 000 -> Pro Max 75 000 -> Méga Pro 100 000 -> Illimité 150 000 ; entre deux points, on interpole ; au-delà d'Illimité rien de plus n'est donné.
// Le forfait est mémorisé dans le NOM de l'offre de l'abonné (« Sur mesure|15000|7 » = 15 000 FCFA pour 7 jours) : aucune nouvelle colonne, et les limites se recalculent à la demande.
const config = require('../config');

const PREFIX = 'Sur mesure|';
const STEP = 500; // la somme est un multiple de 500 FCFA
const int = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n > 0 ? n : d; };
const MIN_MONTH = int('CUSTOM_MIN_MONTH', 10000); // forfait minimum, ramené à un mois
// Messages IA d'un forfait sur mesure : l'échelle des offres habituelles multipliée par ce coefficient (1,5 = 50 % de messages en plus). CUSTOM_AI_BOOST le règle (1 à 5).
const AI_BOOST = Math.min(Math.max(parseFloat(process.env.CUSTOM_AI_BOOST) || 1.5, 1), 5);

const PERIODS = {
  week: { id: 'week', label: 'semaine', days: 7, months: 7 / 30 },
  month: { id: 'month', label: 'mois', days: config.durationDays, months: 1 },
  year: { id: 'year', label: 'an', days: 365, months: 12 },
};
const ceilStep = (n) => Math.ceil(n / STEP) * STEP;
const floorStep = (n) => Math.floor(n / STEP) * STEP;
const maxMonth = () => config.plans.illimite.priceXAF;
const minFor = (p) => ceilStep(MIN_MONTH * p.months);
const maxFor = (p) => floorStep(maxMonth() * p.months);

/** Points de l'échelle : [équivalent mensuel en FCFA, capacités]. Les offres existantes servent de repères. */
function anchors() {
  const W = config.workspaceLimits, P = config.plans;
  const pick = (name) => ({ orgs: W[name].orgs, members: W[name].members, branches: W[name].branches, aiMonth: W[name].aiMonth, emailDay: W[name].emailDay });
  return [
    [MIN_MONTH, { orgs: 1, members: 5, branches: 1, aiMonth: 200, emailDay: 10 }],
    [P.pro.priceXAF, pick('Pro')], [P.promax.priceXAF, pick('Pro Max')], [P.megapro.priceXAF, pick('Méga Pro')], [P.illimite.priceXAF, pick('Illimité')],
  ];
}
const round = (n, to) => Math.max(to, Math.round(n / to) * to);

/** Capacités pour un équivalent mensuel (FCFA). */
function capacityAt(E) {
  const a = anchors();
  const e = Math.min(Math.max(E, a[0][0]), a[a.length - 1][0]);
  let i = 0; while (i < a.length - 2 && e > a[i + 1][0]) i++;
  const [x0, c0] = a[i], [x1, c1] = a[i + 1];
  const t = x1 === x0 ? 0 : (e - x0) / (x1 - x0);
  const lerp = (k) => c0[k] + (c1[k] - c0[k]) * t;
  return { orgs: Math.round(lerp('orgs')), members: Math.round(lerp('members')), branches: Math.round(lerp('branches')), aiMonth: round(lerp('aiMonth') * AI_BOOST, 10), emailDay: round(lerp('emailDay'), 5) };
}

const periodOfDays = (days) => Object.values(PERIODS).find((p) => p.days === days) || null;
const nameOf = (amount, days) => `${PREFIX}${amount}|${days}`;

/** Lit un nom d'offre « Sur mesure|somme|jours ». Renvoie null si ce n'est pas un forfait sur mesure valide. */
function parse(name) {
  const m = /^Sur mesure\|(\d{3,9})\|(\d{1,4})$/.exec(String(name || ''));
  if (!m) return null;
  const amount = Number(m[1]), days = Number(m[2]), period = periodOfDays(days);
  return period ? { name: String(name), amount, days, period, equivalentMonth: Math.round(amount / period.months) } : null;
}
const isCustom = (name) => String(name || '').startsWith(PREFIX);

/** Vérifie une demande (somme + durée) ; lève une Error (.status = 400) avec un message clair. */
function check(amount, periodId) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
  const period = Object.prototype.hasOwnProperty.call(PERIODS, periodId) ? PERIODS[periodId] : null;
  if (!period) throw bad('Choisissez la durée : une semaine, un mois ou un an.');
  const a = Number(amount);
  if (!Number.isInteger(a) || a <= 0) throw bad('Indiquez une somme en FCFA (nombre entier).');
  if (a % STEP) throw bad(`La somme doit être un multiple de ${STEP} FCFA (exemple : 15 000).`);
  if (a < minFor(period)) throw bad(`Le forfait minimum pour ${period.id === 'week' ? 'une semaine' : period.id === 'month' ? 'un mois' : 'un an'} est de ${minFor(period).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} FCFA.`);
  if (a > maxFor(period)) throw bad(`Au-delà de ${maxFor(period).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} FCFA, le forfait n'apporte plus rien de plus (il est déjà illimité). Choisissez une somme plus basse.`);
  return { period, amount: a };
}

/** Détail d'un forfait : somme, durée, capacités. Pour une semaine, le quota de messages IA est celui de la durée (proportionnel). */
function quote(amount, periodId) {
  const { period, amount: a } = check(amount, periodId);
  const eq = Math.round(a / period.months);
  const cap = capacityAt(eq);
  const aiPeriod = period.id === 'week' ? Math.max(20, round(cap.aiMonth * period.months, 5)) : cap.aiMonth;
  return {
    plan: nameOf(a, period.days), amount: a, period: period.id, periodLabel: period.label, days: period.days, equivalentMonth: eq,
    limits: { orgs: cap.orgs, members: cap.members, branches: cap.branches, aiMonth: aiPeriod, emailDay: cap.emailDay },
    aiPerLabel: period.id === 'week' ? 'sur la semaine' : 'par mois',
    rank: rankOfEquivalent(eq),
    features: featuresAt(rankOfEquivalent(eq)),
  };
}

/** Accès : pour chaque fonction réservée à une offre, indique si ce forfait la contient (selon son niveau). */
function featuresAt(rank) {
  const F = require('../workspace/features');
  return Object.entries(F.FEATURES).map(([key, [minPlan, label]]) => ({ key, label, minPlan, included: (F.PLAN_RANK[minPlan] || 0) <= rank }));
}

/** Niveau de fonctions : tout forfait sur mesure ouvre au moins les fonctions « Pro » ; au-dessus, il suit les paliers des offres (Pro Max à 75 000/mois, etc.). */
function rankOfEquivalent(eq) {
  const P = config.plans;
  return eq >= P.illimite.priceXAF ? 4 : eq >= P.megapro.priceXAF ? 3 : eq >= P.promax.priceXAF ? 2 : 1;
}

/** Limites appliquées à un abonné dont l'offre est « Sur mesure|… » (null sinon). */
function limitsOf(name) {
  const p = parse(name);
  if (!p) return null;
  const cap = capacityAt(p.equivalentMonth);
  const aiMonth = p.period.id === 'week' ? Math.max(20, round(cap.aiMonth * p.period.months, 5)) : cap.aiMonth;
  return { orgs: cap.orgs, members: cap.members, branches: cap.branches, aiMonth, emailDay: cap.emailDay };
}
const rankOf = (name) => { const p = parse(name); return p ? rankOfEquivalent(p.equivalentMonth) : null; };
const fmt = (n) => Number(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ');
/** Nom lisible d'une offre (les offres habituelles gardent leur nom). */
const label = (name) => { const p = parse(name); return p ? `Sur mesure (${fmt(p.amount)} FCFA / ${p.period.label})` : String(name || ''); };
/** Durée du bloc de quota IA : une semaine pour un forfait d'une semaine, sinon la durée habituelle de l'abonnement. */
const quotaDays = (name) => { const p = parse(name); return p && p.period.id === 'week' ? 7 : config.durationDays; };

function info() {
  return { step: STEP, minMonth: MIN_MONTH, periods: Object.values(PERIODS).map((p) => ({ id: p.id, label: p.label, days: p.days, min: minFor(p), max: maxFor(p) })) };
}

module.exports = { AI_BOOST, PERIODS, parse, isCustom, check, quote, limitsOf, rankOf, label, quotaDays, nameOf, info, capacityAt };
