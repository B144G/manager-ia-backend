'use strict';
// Questions du profil de l'entreprise : toutes à réponse par BOUTON (aucune saisie), une à la fois. « start » = les 5 de l'inscription ; « later » = au fil de l'eau.
// kinds : types d'entreprise concernés (absent = toutes). ctx : phrase donnée à l'IA. pub : phrase utilisable devant un client.
const Q = [
  { id: 'kind', tier: 'start', ask: 'Que fait votre entreprise ?', type: 'one', options: [['goods', 'Elle vend des produits'], ['service', 'Elle rend des services'], ['school', 'Une école, une université, une formation'], ['industry', 'Elle fabrique des produits'], ['btp', 'Elle réalise des chantiers']], ctx: 'Activité' },
  { id: 'sites', tier: 'start', ask: 'Combien de lieux de travail avez-vous ?', type: 'one', options: [['1', 'Un seul'], ['2-5', 'De 2 à 5'], ['6+', '6 ou plus']], ctx: 'Lieux de travail' },
  { id: 'team', tier: 'start', ask: 'Combien de personnes travaillent chez vous ?', type: 'one', options: [['solo', 'Je travaille seul(e)'], ['2-10', 'De 2 à 10'], ['11-50', 'De 11 à 50'], ['50+', 'Plus de 50']], ctx: 'Taille de l\'équipe' },
  { id: 'channels', tier: 'start', ask: 'Comment vos clients vous contactent-ils ?', hint: 'Plusieurs réponses possibles', type: 'many', options: [['whatsapp', 'WhatsApp'], ['social', 'Facebook ou Instagram'], ['shop', 'Sur place, à la boutique ou au bureau'], ['web', 'Votre site web'], ['phone', 'Par téléphone']], ctx: 'Canaux clients' },
  { id: 'payment', tier: 'start', ask: 'Comment vos clients vous paient-ils ?', hint: 'Plusieurs réponses possibles', type: 'many', options: [['cash', 'En espèces'], ['momo', 'Mobile Money'], ['transfer', 'Virement ou chèque'], ['credit', 'À crédit, plus tard']], ctx: 'Moyens de paiement', pub: 'Moyens de paiement acceptés' },
  { id: 'delivery', tier: 'later', kinds: ['goods', 'industry'], ask: 'Livrez-vous vos clients ?', type: 'one', options: [['yes', 'Oui, nous livrons'], ['no', 'Non, ils viennent chercher'], ['both', 'Les deux']], ctx: 'Livraison', pub: 'Livraison' },
  { id: 'hours', tier: 'later', ask: 'Quels jours êtes-vous ouvert ?', type: 'one', options: [['mon-fri', 'Du lundi au vendredi'], ['mon-sat', 'Du lundi au samedi'], ['all', 'Tous les jours'], ['rdv', 'Sur rendez-vous seulement']], ctx: 'Jours d\'ouverture', pub: 'Jours d\'ouverture' },
  { id: 'stock', tier: 'later', kinds: ['goods', 'industry', 'btp'], ask: 'Suivez-vous un stock de marchandises ou de matières ?', type: 'one', options: [['yes', 'Oui'], ['no', 'Non']], ctx: 'Suivi du stock' },
  { id: 'machines', tier: 'later', kinds: ['industry', 'btp'], ask: 'Utilisez-vous des machines ou des engins ?', type: 'one', options: [['none', 'Non'], ['few', 'Quelques-uns'], ['many', 'Beaucoup']], ctx: 'Machines et engins' },
  { id: 'custom', tier: 'later', kinds: ['industry', 'btp', 'service'], ask: 'Travaillez-vous surtout sur mesure, selon la demande du client ?', type: 'one', options: [['yes', 'Oui, chaque projet est différent'], ['mixed', 'En partie'], ['no', 'Non, toujours les mêmes produits']], ctx: 'Travail sur mesure' },
  { id: 'threshold', tier: 'later', ask: 'À partir de quel montant voulez-vous valider vous-même une dépense ou une remise ?', type: 'one', options: [['50000', 'Dès 50 000'], ['200000', 'Dès 200 000'], ['1000000', 'Dès 1 000 000'], ['never', 'Je ne valide pas']], ctx: 'Seuil de validation (dans la monnaie de l\'organisation)' },
  { id: 'vat', tier: 'later', ask: 'Votre entreprise facture-t-elle la TVA ?', type: 'one', options: [['yes', 'Oui'], ['no', 'Non'], ['unknown', 'Je ne sais pas']], ctx: 'TVA' },
  { id: 'payroll', tier: 'later', ask: 'Payez-vous des salaires chaque mois ?', type: 'one', options: [['yes', 'Oui'], ['no', 'Non']], ctx: 'Salaires' },
  { id: 'goal', tier: 'later', ask: 'Qu\'attendez-vous d\'abord de Brij-IA ?', type: 'one', options: [['sell', 'Vendre davantage'], ['track', 'Mieux suivre mon activité'], ['time', 'Gagner du temps'], ['team', 'Mieux organiser mon équipe']], ctx: 'Objectif principal' },
];
const byId = Object.fromEntries(Q.map((q) => [q.id, q]));
const labelOf = (q, v) => (Array.isArray(v) ? v : [v]).map((x) => (q.options.find((o) => o[0] === x) || [x, x])[1]).join(', ');
module.exports = { Q, byId, labelOf };
