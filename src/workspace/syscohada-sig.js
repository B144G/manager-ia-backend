'use strict';
// Classement des comptes inspiré du SYSCOHADA révisé (classes 1 à 8), sous forme de tables lisibles, et tableau de correspondance
// « compte -> ligne des soldes intermédiaires de gestion (SIG) ». Utilisé par fiscal.js ; modifiable sans toucher au code de calcul.
// Document de travail : le classement officiel dépend de la version du plan comptable et du pays ; à faire valider par un expert-comptable.

/** Classes et groupes (2 chiffres) : sert à l'affichage et à vérifier qu'un compte est rattaché à une classe connue. */
const CLASSES = {
  1: { label: 'Ressources durables', groups: [['10', 'Capital'], ['11', 'Réserves'], ['12', 'Report à nouveau'], ['13', "Résultat net de l'exercice"], ['14', "Subventions d'investissement"], ['15', 'Provisions réglementées et fonds assimilés'], ['16', 'Emprunts et dettes assimilées'], ['17', 'Dettes de location-acquisition'], ['18', 'Dettes liées à des participations et comptes de liaison'], ['19', 'Provisions financières pour risques et charges']] },
  2: { label: 'Actif immobilisé', groups: [['21', 'Immobilisations incorporelles'], ['22', 'Terrains'], ['23', 'Bâtiments, installations techniques et agencements'], ['24', 'Matériel, mobilier et actifs biologiques'], ['25', 'Avances et acomptes versés sur immobilisations'], ['26', 'Titres de participation'], ['27', 'Autres immobilisations financières'], ['28', 'Amortissements'], ['29', 'Dépréciations des immobilisations']] },
  3: { label: 'Stocks', groups: [['31', 'Marchandises'], ['32', 'Matières premières et fournitures liées'], ['33', 'Autres approvisionnements'], ['34', 'Produits en cours'], ['35', 'Services en cours'], ['36', 'Produits finis'], ['37', 'Produits intermédiaires et résiduels'], ['38', 'Stocks en cours de route, en consignation ou en dépôt'], ['39', 'Dépréciations des stocks']] },
  4: { label: 'Comptes de tiers', groups: [['40', 'Fournisseurs et comptes rattachés'], ['41', 'Clients et comptes rattachés'], ['42', 'Personnel'], ['43', 'Organismes sociaux'], ['44', 'État et collectivités publiques'], ['45', 'Organismes internationaux'], ['46', 'Associés et groupe'], ['47', 'Débiteurs et créditeurs divers'], ['48', 'Créances et dettes hors activités ordinaires'], ['49', 'Dépréciations et risques provisionnés (tiers)']] },
  5: { label: 'Comptes de trésorerie', groups: [['50', 'Titres de placement'], ['51', 'Valeurs à encaisser'], ['52', 'Banques'], ['53', 'Établissements financiers et assimilés'], ['54', 'Instruments de trésorerie'], ['55', 'Instruments de monnaie électronique'], ['56', 'Banques, crédits de trésorerie et d\'escompte'], ['57', 'Caisse'], ['58', "Régies d'avances, accréditifs et virements internes"], ['59', 'Dépréciations et risques provisionnés (trésorerie)']] },
  6: { label: 'Charges des activités ordinaires', groups: [['60', 'Achats et variations de stocks'], ['61', 'Transports'], ['62', 'Services extérieurs A'], ['63', 'Services extérieurs B'], ['64', 'Impôts et taxes'], ['65', 'Autres charges'], ['66', 'Charges de personnel'], ['67', 'Frais financiers et charges assimilées'], ['68', "Dotations aux amortissements"], ['69', 'Dotations aux provisions et dépréciations']] },
  7: { label: 'Produits des activités ordinaires', groups: [['70', 'Ventes'], ['71', "Subventions d'exploitation"], ['72', 'Production immobilisée'], ['73', 'Variations de stocks de biens et de services produits'], ['75', 'Autres produits'], ['77', 'Revenus financiers et produits assimilés'], ['78', 'Transferts de charges'], ['79', 'Reprises de provisions, dépréciations et autres']] },
  8: { label: 'Autres charges et autres produits (hors activités ordinaires)', groups: [['81', "Valeurs comptables des cessions d'immobilisations"], ['82', "Produits des cessions d'immobilisations"], ['83', 'Charges hors activités ordinaires'], ['84', 'Produits hors activités ordinaires'], ['85', 'Dotations hors activités ordinaires'], ['86', 'Reprises hors activités ordinaires'], ['87', 'Participation des travailleurs'], ['88', "Subventions d'équilibre"], ['89', 'Impôts sur le résultat']] },
};

/** Sous-comptes usuels (3 ou 4 chiffres) : indicatif, pour aider à choisir un compte. */
const USUAL = [
  ['101', 'Capital social'], ['121', 'Report à nouveau créditeur'], ['129', 'Report à nouveau débiteur'], ['131', 'Résultat net : bénéfice'], ['139', 'Résultat net : perte'],
  ['213', 'Logiciels'], ['244', 'Matériel et mobilier de bureau'], ['245', 'Matériel de transport'], ['2183', 'Matériel informatique'],
  ['311', 'Marchandises'], ['401', 'Fournisseurs'], ['411', 'Clients'], ['421', 'Personnel, avances et acomptes'], ['422', 'Personnel, rémunérations dues'], ['431', 'Sécurité sociale'], ['447', 'Impôts retenus à la source'], ['4431', 'TVA facturée sur ventes'], ['4452', 'TVA récupérable sur achats'],
  ['521', 'Banques'], ['571', 'Caisse'], ['589', 'Mobile money'],
  ['601', 'Achats de marchandises'], ['6031', 'Variations des stocks de marchandises'], ['622', 'Locations et charges locatives'], ['625', "Primes d'assurance"], ['631', 'Frais bancaires'], ['641', 'Impôts et taxes directs'], ['661', 'Rémunérations directes du personnel national'], ['664', 'Charges sociales'], ['671', 'Intérêts des emprunts'], ['681', "Dotations aux amortissements d'exploitation"],
  ['701', 'Ventes de marchandises'], ['706', 'Services vendus'], ['707', 'Produits accessoires'], ['771', 'Intérêts de prêts'], ['891', 'Impôts sur le résultat'],
];

/** Lignes des SIG : clé -> sens (produit ou charge) et libellé. */
const SIG_KEYS = {
  ventesMarch: ['produit', 'Ventes de marchandises'], ventesProd: ['produit', 'Production vendue (biens et services)'], prodStockee: ['produit', 'Production stockée (variation)'], prodImmo: ['produit', 'Production immobilisée'],
  subv: ['produit', "Subventions d'exploitation"], autresProduits: ['produit', 'Autres produits'], reprises: ['produit', "Transferts de charges et reprises d'exploitation"], prodFin: ['produit', 'Revenus financiers et reprises financières'],
  achatsMarch: ['charge', 'Achats de marchandises'], varStockMarch: ['charge', 'Variation de stock de marchandises'], achatsMat: ['charge', 'Achats de matières et fournitures'], varStockMat: ['charge', "Variation de stock de matières et d'approvisionnements"],
  transports: ['charge', 'Transports'], servicesExt: ['charge', 'Services extérieurs'], impots: ['charge', 'Impôts et taxes'], autresCharges: ['charge', 'Autres charges'], personnel: ['charge', 'Charges de personnel'],
  chFin: ['charge', 'Frais financiers et dotations financières'], dotations: ['charge', "Dotations d'exploitation (amortissements et provisions)"],
  haoProd: ['produit', 'Produits hors activités ordinaires'], haoCharges: ['charge', 'Charges hors activités ordinaires'], participation: ['charge', 'Participation des travailleurs'], impotResultat: ['charge', 'Impôts sur le résultat'],
};

/** Correspondance préfixe de compte -> ligne des SIG. Le préfixe le plus long l'emporte (6031 avant 603 avant 60). */
const SIG_RULES = [
  ['701', 'ventesMarch'], ['70', 'ventesProd'], ['71', 'subv'], ['72', 'prodImmo'], ['73', 'prodStockee'], ['75', 'autresProduits'],
  ['77', 'prodFin'], ['787', 'prodFin'], ['797', 'prodFin'], ['78', 'reprises'], ['79', 'reprises'],
  ['601', 'achatsMarch'], ['6031', 'varStockMarch'], ['603', 'varStockMat'], ['60', 'achatsMat'], ['61', 'transports'], ['62', 'servicesExt'], ['63', 'servicesExt'],
  ['64', 'impots'], ['65', 'autresCharges'], ['66', 'personnel'], ['67', 'chFin'], ['687', 'chFin'], ['697', 'chFin'], ['68', 'dotations'], ['69', 'dotations'],
  ['81', 'haoCharges'], ['83', 'haoCharges'], ['85', 'haoCharges'], ['82', 'haoProd'], ['84', 'haoProd'], ['86', 'haoProd'], ['88', 'haoProd'], ['87', 'participation'], ['89', 'impotResultat'],
];
const SORTED = [...SIG_RULES].sort((a, b) => b[0].length - a[0].length);

/** Ligne des SIG d'un compte (null pour les classes 1 à 5). Compte inconnu de la classe 6/7/8 : « autres charges » / « autres produits » / HAO. */
function sigKeyOf(account) {
  const a = String(account || '');
  const hit = SORTED.find(([p]) => a.startsWith(p));
  if (hit) return hit[1];
  if (a[0] === '6') return 'autresCharges';
  if (a[0] === '7') return 'autresProduits';
  if (a[0] === '8') return 'haoCharges';
  return null;
}

/** Description lisible du classement (pour l'écran « Classement des comptes »). */
function describe() {
  return {
    classes: Object.entries(CLASSES).map(([c, v]) => ({ class: c, label: v.label, groups: v.groups.map(([prefix, label]) => ({ prefix, label, sig: [...new Set(SIG_RULES.filter(([p]) => p.startsWith(prefix) || prefix.startsWith(p)).map(([, k]) => k))].map((k) => (SIG_KEYS[k] || [])[1]).filter(Boolean) })) })),
    usual: USUAL.map(([code, label]) => ({ code, label, sig: sigKeyOf(code) ? (SIG_KEYS[sigKeyOf(code)] || [])[1] : '' })),
    sigRules: SIG_RULES.map(([prefix, key]) => ({ prefix, key, label: SIG_KEYS[key][1], side: SIG_KEYS[key][0] })),
    notice: "Classement indicatif inspiré du SYSCOHADA révisé. Les comptes d'une classe 6, 7 ou 8 non listés sont rangés dans « autres charges », « autres produits » ou « hors activités ordinaires ». À faire valider par un expert-comptable.",
  };
}

module.exports = { CLASSES, USUAL, SIG_KEYS, SIG_RULES, sigKeyOf, describe };
