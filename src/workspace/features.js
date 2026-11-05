'use strict';
// Fonctions réservées par offre. Le contrôle est fait ICI, côté serveur ; le site ne fait que l'afficher.
// Tant que FEATURE_GATING n'est pas « on », rien n'est bloqué (les organisations existantes gardent tout) : on voit seulement ce que chaque offre débloquerait.
const { HttpError } = require('../util');
const A = require('./access');

const PLAN_RANK = { Gratuit: 0, Pro: 1, 'Pro Max': 2, 'Méga Pro': 3, 'Illimité': 4 };
// key: [offre minimale, libellé simple, questions du profil nécessaires pour bien automatiser]
const FEATURES = {
  assistant: ['Pro', 'Assistant commercial sur WhatsApp et le site', ['kind', 'channels']],
  followups: ['Pro', 'Relances automatiques des clients', ['payment', 'channels']],
  negotiation: ['Pro', 'Négociation de prix dans les limites fixées', ['kind']],
  handoff: ['Pro Max', 'Passation à un humain selon le type d\'entreprise', ['kind']],
  approvals: ['Pro Max', 'Validations par montant', ['threshold']],
  reports: ['Pro Max', 'Rapports automatiques', ['goal']],
  project_study: ['Méga Pro', 'Étude de projet et scénarios', ['kind', 'machines']],
  reservations: ['Méga Pro', 'Réservation des matières et prévu contre réel', ['kind', 'stock']],
  multisite: ['Illimité', 'Vision consolidée de toutes les antennes', ['sites']],
  anomalies: ['Illimité', 'Détection d\'anomalies et prévision des achats', ['sites', 'stock']],
};
const gatingOn = () => String(process.env.FEATURE_GATING || '').toLowerCase() === 'on';
const rank = (plan) => (PLAN_RANK[plan] !== undefined ? PLAN_RANK[plan] : require('../services/custom-plan').rankOf(plan) || 0); // forfait sur mesure : au moins « Pro »
const allowed = (plan, key) => !FEATURES[key] || rank(plan) >= rank(FEATURES[key][0]);

/** Middleware : refuse (402) si l'offre du propriétaire ne contient pas la fonction ET que le contrôle est actif. */
const need = (key) => async (req, res, next) => {
  try {
    if (!gatingOn()) return next();
    const plan = await A.ownerPlan(req.org);
    if (allowed(plan, key)) return next();
    throw new HttpError(402, `« ${FEATURES[key][1]} » est disponible à partir de l'offre ${FEATURES[key][0]}. Votre offre actuelle : ${require('../services/custom-plan').label(plan)}.`);
  } catch (e) { next(e); }
};
module.exports = { FEATURES, PLAN_RANK, allowed, need, gatingOn, rank };
