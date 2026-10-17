'use strict';
// Plan comptable de base, inspiré du SYSCOHADA révisé (zone OHADA). Liste de départ pour une PME : l'organisation peut ajouter ses propres comptes.
// À faire valider par un expert-comptable avant tout usage officiel.
const PLAN = [
  // Classe 1 : ressources durables
  ['101', 'Capital social'], ['105', 'Primes liées au capital social'], ['111', 'Réserve légale'], ['118', 'Autres réserves'], ['121', 'Report à nouveau créditeur'], ['129', 'Report à nouveau débiteur'],
  ['131', 'Résultat net de l\'exercice : bénéfice'], ['139', 'Résultat net de l\'exercice : perte'], ['162', 'Emprunts et dettes auprès des établissements de crédit'], ['165', 'Dépôts et cautionnements reçus'], ['168', 'Autres emprunts et dettes'],
  // Classe 2 : actif immobilisé
  ['211', 'Frais de développement'], ['213', 'Logiciels'], ['221', 'Terrains agricoles et forestiers'], ['222', 'Terrains nus'], ['231', 'Bâtiments industriels, agricoles, commerciaux'], ['241', 'Matériel et outillage industriel et commercial'],
  ['244', 'Matériel et mobilier de bureau'], ['245', 'Matériel de transport'], ['2183', 'Matériel informatique'], ['275', 'Dépôts et cautionnements versés'],
  ['2813', 'Amortissements des logiciels'], ['2841', 'Amortissements du matériel et outillage'], ['2844', 'Amortissements du matériel et mobilier de bureau'], ['2845', 'Amortissements du matériel de transport'],
  // Classe 3 : stocks
  ['311', 'Marchandises'], ['321', 'Matières premières et fournitures liées'], ['331', 'Matières consommables'], ['351', 'Produits finis'], ['391', 'Dépréciations des stocks de marchandises'],
  // Classe 4 : tiers
  ['401', 'Fournisseurs, dettes en compte'], ['408', 'Fournisseurs, factures non parvenues'], ['409', 'Fournisseurs débiteurs (avances et acomptes versés)'],
  ['411', 'Clients'], ['412', 'Clients, effets à recevoir'], ['416', 'Clients douteux ou litigieux'], ['419', 'Clients créditeurs (avances et acomptes reçus)'],
  ['421', 'Personnel, avances et acomptes'], ['422', 'Personnel, rémunérations dues'], ['424', 'Personnel, oeuvres sociales'], ['431', 'Sécurité sociale (CNPS)'], ['447', 'État, impôts retenus à la source'],
  ['441', 'État, impôt sur les bénéfices'], ['4431', 'TVA facturée sur ventes'], ['4432', 'TVA facturée sur prestations de services'], ['4441', 'État, TVA due'], ['4449', 'État, crédit de TVA à reporter'],
  ['4451', 'TVA récupérable sur immobilisations'], ['4452', 'TVA récupérable sur achats'], ['4454', 'TVA récupérable sur services extérieurs'], ['4471', 'État, impôts et taxes directs'], ['4472', 'État, impôts et taxes indirects'], ['448', 'État, charges à payer'],
  ['462', 'Associés, comptes courants'], ['465', 'Associés, dividendes à payer'], ['471', 'Comptes d\'attente, débiteurs'], ['472', 'Comptes d\'attente, créditeurs'], ['476', 'Charges constatées d\'avance'], ['477', 'Produits constatés d\'avance'],
  // Classe 5 : trésorerie
  ['521', 'Banques'], ['5211', 'Banque, compte courant'], ['531', 'Chèques postaux'], ['571', 'Caisse'], ['585', 'Virements de fonds'], ['589', 'Mobile money (monnaie électronique)'],
  // Classe 6 : charges
  ['601', 'Achats de marchandises'], ['602', 'Achats de matières premières et fournitures liées'], ['604', 'Achats stockés de matières et fournitures consommables'], ['605', 'Autres achats'], ['608', 'Achats d\'emballages'],
  ['6031', 'Variations des stocks de marchandises'], ['611', 'Transports sur achats'], ['612', 'Transports sur ventes'], ['614', 'Transports du personnel'], ['616', 'Transports de plis'], ['618', 'Autres frais de transport'],
  ['621', 'Sous-traitance générale'], ['622', 'Locations et charges locatives'], ['623', 'Redevances de crédit-bail'], ['624', 'Entretien, réparations et maintenance'], ['625', 'Primes d\'assurance'], ['627', 'Publicité, publications, relations publiques'],
  ['628', 'Frais de télécommunications'], ['631', 'Frais bancaires'], ['632', 'Rémunérations d\'intermédiaires et de conseils (honoraires)'], ['633', 'Frais de formation du personnel'], ['638', 'Autres charges externes'],
  ['641', 'Impôts et taxes directs'], ['645', 'Impôts et taxes indirects'], ['646', 'Droits d\'enregistrement'], ['658', 'Charges diverses'], ['661', 'Rémunérations directes versées au personnel national'], ['662', 'Rémunérations directes versées au personnel non national'],
  ['664', 'Charges sociales'], ['671', 'Intérêts des emprunts'], ['676', 'Pertes de change'], ['681', 'Dotations aux amortissements d\'exploitation'],
  // Classe 7 : produits
  ['701', 'Ventes de marchandises'], ['702', 'Ventes de produits finis'], ['705', 'Travaux facturés'], ['706', 'Services vendus'], ['707', 'Produits accessoires'], ['711', 'Subventions d\'exploitation'], ['754', 'Produits des cessions courantes d\'immobilisations'],
  ['771', 'Intérêts de prêts'], ['776', 'Gains de change'], ['781', 'Transferts de charges d\'exploitation'],
  // Classe 8 : hors activités ordinaires
  ['811', 'Valeurs comptables des cessions d\'immobilisations incorporelles'], ['821', 'Produits des cessions d\'immobilisations incorporelles'], ['831', 'Charges H.A.O. constatées'], ['841', 'Produits H.A.O. constatés'], ['891', 'Impôts sur le résultat'],
];
const JOURNALS = { VT: 'Ventes', AC: 'Achats', BQ: 'Banque', CA: 'Caisse', MM: 'Mobile money', OD: 'Opérations diverses' };
module.exports = { PLAN, JOURNALS };
