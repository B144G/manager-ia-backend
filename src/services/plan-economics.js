'use strict';
// Économie des forfaits : combien de messages IA peut-on accorder pour une somme encaissée sans jamais travailler à perte ?
// Aucune dépendance (ni config, ni base) : utilisé par la configuration, le forfait sur mesure et le script d'audit.
//   somme nette = somme encaissée x (1 - frais de paiement)
//   messages permis par période de quota = somme nette x (1 - marge) / coût d'un message / nombre de périodes de quota dans la durée payée
// Réglages (variables d'environnement) :
//   AI_COST_PER_MSG_XAF  coût MAXIMAL d'un message IA en FCFA (défaut 13 = Claude Sonnet 5.5 avec ~8 000 mots-jetons en entrée et 600 en sortie, 1 $ = 600 FCFA).
//                        Avec un modèle très bon marché (Qwen ≈ 0,2 FCFA) on peut le baisser, par exemple à 2, pour accorder plus de messages.
//   PAYMENT_FEE_PCT      frais de l'opérateur de paiement, en % (défaut 3)
//   PLAN_TARGET_MARGIN   marge visée, en % de la somme nette (défaut 50)
//   PLAN_MIN_MARGIN      plancher absolu, en % : aucun forfait ne peut descendre dessous, même avec le quota de l'offre Gratuite (défaut 30)
const num = (k, d) => { const n = parseFloat(process.env[k]); return Number.isFinite(n) && n >= 0 ? n : d; };

const COST_XAF = Math.max(num('AI_COST_PER_MSG_XAF', 13), 0.01);
const FEE = Math.min(num('PAYMENT_FEE_PCT', 3), 50) / 100;
const TARGET = Math.min(num('PLAN_TARGET_MARGIN', 50), 95) / 100;
const FLOOR = Math.min(num('PLAN_MIN_MARGIN', 30), TARGET * 100) / 100;

const net = (amount) => amount * (1 - FEE);
const cap = (amount, blocks, margin) => Math.max(0, Math.floor(net(amount) * (1 - margin) / COST_XAF / Math.max(1, blocks) / 5) * 5);
/** Nombre de périodes de quota dans une durée payée (une semaine = 1 ; un mois = 1 ; un trimestre = 3 ; six mois = 6 ; un an = 12). */
const blocksOf = (days, monthDays) => Math.max(1, Math.round(days / monthDays));

module.exports = {
  COST_XAF, FEE, TARGET, FLOOR, net, blocksOf,
  targetCap: (amount, blocks = 1) => cap(amount, blocks, TARGET), // messages par période pour garder la marge visée
  floorCap: (amount, blocks = 1) => cap(amount, blocks, FLOOR),   // messages par période au-delà desquels la marge passe sous le plancher
  marginOf: (amount, messages, blocks = 1) => (net(amount) - messages * Math.max(1, blocks) * COST_XAF) / net(amount),
};
