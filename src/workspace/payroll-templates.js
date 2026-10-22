'use strict';
// Modèles de barèmes de paie par pays : POINTS DE DÉPART modifiables, jamais des barèmes officiels.
// Règle d'honnêteté : ce fichier ne contient AUCUN taux ni plafond. Chaque rubrique est à compléter par l'organisation d'après
// les textes en vigueur dans son pays (administration fiscale, caisse de sécurité sociale, expert-comptable).
// Les intitulés et les noms d'organismes sont des usages courants, donnés à titre indicatif ; ils peuvent être inexacts ou dépassés.
// Chaque modèle porte la mention « À vérifier auprès de votre administration » et une date « à jour au » (asOf) qui reste VIDE :
// c'est l'utilisateur qui la renseigne après avoir vérifié les taux.

const NOTICE = 'À vérifier auprès de votre administration';

// kind : employee (retenue sur le salarié) ou employer (charge patronale) ; target : social (organisme social) ou tax (impôt ou taxe).
const r = (kind, target, label) => ({ kind, target, label, rate: null, ceiling: 0, todo: true });

/** Rubriques communes à tous les pays : l'organisation les renomme selon ses organismes. */
const common = (social, taxEmployee, taxEmployer) => [
  r('employee', 'social', `Cotisation sociale salariale : pension / retraite (${social})`),
  r('employee', 'tax', `Impôt sur les salaires (${taxEmployee})`),
  r('employer', 'social', `Cotisation sociale patronale : pension / retraite (${social})`),
  r('employer', 'social', `Cotisation patronale : prestations familiales (${social})`),
  r('employer', 'social', `Cotisation patronale : accidents du travail (${social})`),
  r('employer', 'tax', `Taxe patronale sur les salaires (${taxEmployer})`),
];

const T = (id, country, currency, social, taxEmployee, taxEmployer, extra) => ({
  id, country, currency, notice: NOTICE, asOf: '', socialBody: social,
  rules: [...common(social, taxEmployee, taxEmployer), ...(extra || [])],
});

const TEMPLATES = [
  T('cm', 'Cameroun', 'XAF', 'CNPS', 'IRPP', 'à préciser', [r('employee', 'tax', 'Contribution crédit foncier (salarié)'), r('employer', 'tax', 'Contribution fonds national de l\'emploi (employeur)')]),
  T('ci', "Côte d'Ivoire", 'XOF', 'CNPS', 'ITS', 'à préciser', [r('employee', 'tax', 'Contribution nationale (salarié)'), r('employer', 'tax', 'Taxe d\'apprentissage et formation continue (employeur)')]),
  T('sn', 'Sénégal', 'XOF', 'IPRES / caisse de sécurité sociale', 'IR', 'à préciser', [r('employee', 'tax', 'Contribution forfaitaire (salarié)'), r('employer', 'tax', 'Contribution forfaitaire à la charge de l\'employeur')]),
  T('cg', 'Congo (Brazzaville)', 'XAF', 'CNSS', 'IRPP', 'à préciser'),
  T('ga', 'Gabon', 'XAF', 'CNSS', 'IRPP', 'à préciser', [r('employee', 'social', 'Cotisation assurance maladie (salarié)'), r('employer', 'social', 'Cotisation assurance maladie (employeur)')]),
  T('cd', 'RDC (Congo-Kinshasa)', 'CDF', 'INSS', 'IPR', 'à préciser', [r('employer', 'tax', 'Contribution formation professionnelle (employeur)')]),
  T('bj', 'Bénin', 'XOF', 'CNSS', 'impôt sur le traitement des salaires', 'versement patronal sur salaires'),
  T('tg', 'Togo', 'XOF', 'CNSS', 'IRPP', 'à préciser'),
  T('ml', 'Mali', 'XOF', 'INPS', 'impôt sur les traitements et salaires', 'à préciser', [r('employee', 'social', 'Assurance maladie obligatoire (salarié)'), r('employer', 'social', 'Assurance maladie obligatoire (employeur)')]),
  T('bf', 'Burkina Faso', 'XOF', 'CNSS', 'impôt unique sur les traitements et salaires', 'taxe patronale d\'apprentissage'),
  T('other', 'Autre pays (modèle générique)', '', 'organisme social', 'impôt sur les salaires', 'taxe patronale'),
];

/** Palier(s) d'heures supplémentaires proposés par défaut : EXEMPLES à confirmer (le taux de majoration dépend du pays et de la convention). */
const DEFAULT_TIERS = [
  { label: 'Heures majorées (palier 1, exemple)', rate: 25 },
  { label: 'Heures majorées (palier 2, exemple)', rate: 50 },
];

const view = (t) => ({ id: t.id, country: t.country, currency: t.currency, notice: t.notice, asOf: t.asOf, socialBody: t.socialBody, rules: t.rules.map((x) => ({ ...x })), count: t.rules.length });

module.exports = { TEMPLATES, DEFAULT_TIERS, NOTICE, view };
