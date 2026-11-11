'use strict';
// Plan comptable de base, inspiré du SYSCOHADA révisé (zone OHADA). Liste de départ pour une PME : l'organisation peut ajouter ses propres comptes.
// À faire valider par un expert-comptable avant tout usage officiel.
const PLAN = [
  // Classe 1 : ressources durables
  ['101', 'Capital social'], ['105', 'Primes liées au capital social'], ['111', 'Réserve légale'], ['118', 'Autres réserves'], ['121', 'Report à nouveau créditeur'], ['129', 'Report à nouveau débiteur'],
  ['131', 'Résultat net de l\'exercice : bénéfice'], ['139', 'Résultat net de l\'exercice : perte'], ['191', 'Provisions pour litiges'], ['162', 'Emprunts et dettes auprès des établissements de crédit'], ['165', 'Dépôts et cautionnements reçus'], ['168', 'Autres emprunts et dettes'],
  // Classe 2 : actif immobilisé
  ['211', 'Frais de développement'], ['213', 'Logiciels'], ['221', 'Terrains agricoles et forestiers'], ['222', 'Terrains nus'], ['231', 'Bâtiments industriels, agricoles, commerciaux'], ['241', 'Matériel et outillage industriel et commercial'],
  ['244', 'Matériel et mobilier de bureau'], ['245', 'Matériel de transport'], ['2183', 'Matériel informatique'], ['275', 'Dépôts et cautionnements versés'],
  ['2813', 'Amortissements des logiciels'], ['2831', 'Amortissements des bâtiments'], ['28183', 'Amortissements du matériel informatique'], ['2841', 'Amortissements du matériel et outillage'], ['2844', 'Amortissements du matériel et mobilier de bureau'], ['2845', 'Amortissements du matériel de transport'],
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
  ['664', 'Charges sociales'], ['671', 'Intérêts des emprunts'], ['676', 'Pertes de change'], ['681', 'Dotations aux amortissements d\'exploitation'], ['691', 'Dotations aux provisions d\'exploitation'],
  // Classe 7 : produits
  ['701', 'Ventes de marchandises'], ['702', 'Ventes de produits finis'], ['705', 'Travaux facturés'], ['706', 'Services vendus'], ['707', 'Produits accessoires'], ['711', 'Subventions d\'exploitation'], ['754', 'Produits des cessions courantes d\'immobilisations'], ['758', 'Produits divers'],
  ['771', 'Intérêts de prêts'], ['776', 'Gains de change'], ['781', 'Transferts de charges d\'exploitation'],
  // Classe 8 : hors activités ordinaires
  ['811', 'Valeurs comptables des cessions d\'immobilisations incorporelles'], ['821', 'Produits des cessions d\'immobilisations incorporelles'], ['831', 'Charges H.A.O. constatées'], ['841', 'Produits H.A.O. constatés'], ['891', 'Impôts sur le résultat'],
];
// Comptes courants complémentaires d'une PME de la zone OHADA (SYSCOHADA révisé). Ils s'ajoutent au plan de base ci-dessus : en cas de même numéro, la liste de
// base l'emporte, et les comptes personnalisés d'une organisation ne sont jamais touchés. Seuls les comptes dont le libellé est certain figurent ici.
const EXTRA = [
  // Classe 1
  ['104', 'Compte de l\'exploitant'], ['106', 'Écarts de réévaluation'], ['109', 'Actionnaires, capital souscrit non appelé'], ['112', 'Réserves statutaires ou contractuelles'], ['113', 'Réserves réglementées'], ['141', 'Subventions d\'équipement'],
  ['151', 'Amortissements dérogatoires'], ['161', 'Emprunts obligataires'], ['163', 'Avances reçues de l\'État'], ['164', 'Avances reçues et comptes courants bloqués'], ['167', 'Avances assorties de conditions particulières'],
  ['172', 'Dettes de crédit-bail immobilier'], ['173', 'Dettes de crédit-bail mobilier'], ['192', 'Provisions pour garanties données aux clients'], ['194', 'Provisions pour pertes de change'], ['195', 'Provisions pour impôts'], ['196', 'Provisions pour pensions et obligations similaires'],
  // Classe 2
  ['212', 'Brevets, licences, concessions et droits similaires'], ['214', 'Marques'], ['215', 'Fonds commercial'], ['216', 'Droit au bail'], ['223', 'Terrains bâtis'], ['234', 'Aménagements, agencements et installations techniques'], ['235', 'Aménagements de bureaux'],
  ['242', 'Matériel et outillage agricole'], ['2441', 'Matériel de bureau'], ['2444', 'Mobilier de bureau'], ['2451', 'Matériel automobile'], ['251', 'Avances et acomptes versés sur immobilisations incorporelles'], ['252', 'Avances et acomptes versés sur immobilisations corporelles'],
  ['261', 'Titres de participation'], ['271', 'Prêts et créances non commerciales'], ['272', 'Prêts au personnel'],
  ['281', 'Amortissements des immobilisations incorporelles'], ['283', 'Amortissements des bâtiments, installations techniques et agencements'], ['284', 'Amortissements du matériel'],
  ['291', 'Dépréciations des immobilisations incorporelles'], ['292', 'Dépréciations des terrains'], ['293', 'Dépréciations des bâtiments, installations techniques et agencements'], ['294', 'Dépréciations du matériel'], ['296', 'Dépréciations des titres de participation'], ['297', 'Dépréciations des autres immobilisations financières'],
  // Classe 3
  ['332', 'Matières combustibles'], ['333', 'Produits d\'entretien'], ['334', 'Fournitures d\'atelier et d\'usine'], ['335', 'Fournitures de magasin'], ['336', 'Fournitures de bureau'], ['381', 'Marchandises en cours de route'],
  ['392', 'Dépréciations des matières premières et fournitures liées'], ['393', 'Dépréciations des autres approvisionnements'],
  // Classe 4
  ['402', 'Fournisseurs, effets à payer'], ['414', 'Créances sur cessions courantes d\'immobilisations'], ['415', 'Clients, effets escomptés non échus'], ['418', 'Clients, produits à recevoir'],
  ['423', 'Personnel, oppositions, saisies-arrêts'], ['425', 'Personnel, représentants du personnel'], ['427', 'Personnel, dépôts'], ['428', 'Personnel, charges à payer et produits à recevoir'],
  ['432', 'Caisses de retraite complémentaire'], ['433', 'Autres organismes sociaux'], ['438', 'Organismes sociaux, charges à payer et produits à recevoir'],
  ['442', 'État, autres impôts et taxes'], ['446', 'État, autres taxes sur le chiffre d\'affaires'], ['449', 'État, créances et dettes diverses'], ['461', 'Associés, opérations sur le capital'], ['463', 'Associés, comptes courants'],
  ['478', 'Écarts de conversion - Actif'], ['479', 'Écarts de conversion - Passif'], ['491', 'Dépréciations des comptes clients'],
  // Classe 5
  ['511', 'Effets à encaisser'], ['513', 'Chèques à encaisser'], ['525', 'Banques, dépôts à terme'], ['561', 'Crédits de trésorerie'], ['572', 'Caisse succursale (ou usine) A'], ['581', 'Régies d\'avance'], ['588', 'Autres virements internes'],
  // Classe 6
  ['603', 'Variations des stocks de biens achetés'], ['6032', 'Variations des stocks de matières premières et fournitures liées'], ['6033', 'Variations des stocks d\'autres approvisionnements'],
  ['6041', 'Achats de matières consommables'], ['6042', 'Achats de matières combustibles'], ['6043', 'Achats de produits d\'entretien'], ['6044', 'Achats de fournitures d\'atelier et d\'usine'], ['6045', 'Achats de fournitures de magasin'], ['6046', 'Achats de fournitures de bureau'],
  ['6051', 'Fournitures non stockables : eau'], ['6052', 'Fournitures non stockables : électricité'], ['6055', 'Fournitures de bureau non stockables'], ['6056', 'Achats de petit matériel et outillage'], ['609', 'Rabais, remises et ristournes obtenus sur achats'],
  ['613', 'Transports pour le compte de tiers'], ['626', 'Études, recherches et documentation'], ['6222', 'Locations de bâtiments'], ['6281', 'Frais de téléphone'],
  ['634', 'Redevances pour brevets, licences, logiciels, concessions et droits similaires'], ['635', 'Cotisations'], ['637', 'Rémunérations de personnel extérieur à l\'entité'],
  ['6411', 'Impôts fonciers et taxes annexes'], ['6412', 'Patentes, licences et taxes annexes'], ['6413', 'Taxes sur appointements et salaires'], ['647', 'Pénalités et amendes fiscales'], ['648', 'Autres impôts et taxes'],
  ['651', 'Pertes sur créances clients et autres débiteurs'], ['654', 'Valeurs comptables des cessions courantes d\'immobilisations'], ['656', 'Pertes de change sur créances et dettes commerciales'], ['657', 'Pénalités et amendes pénales'],
  ['663', 'Indemnités forfaitaires versées au personnel'], ['666', 'Rémunérations et charges sociales de l\'exploitant individuel'], ['668', 'Autres charges sociales'],
  ['6611', 'Appointements, salaires et commissions'], ['6612', 'Primes et gratifications'], ['6613', 'Congés payés'], ['6641', 'Charges sociales sur rémunérations du personnel national'],
  ['673', 'Escomptes accordés'], ['674', 'Autres intérêts'], ['675', 'Escomptes des effets de commerce'],
  // Classe 7
  ['709', 'Rabais, remises et ristournes accordés par l\'entité'], ['773', 'Escomptes obtenus'], ['791', 'Reprises de provisions et dépréciations d\'exploitation'], ['797', 'Reprises de provisions et dépréciations financières'],
  // Classe 8 : hors activités ordinaires (H.A.O.)
  ['812', 'Valeurs comptables des cessions d\'immobilisations corporelles'], ['816', 'Valeurs comptables des cessions d\'immobilisations financières'], ['822', 'Produits des cessions d\'immobilisations corporelles'],
  ['835', 'Dons et libéralités accordés'], ['836', 'Abandons de créances consentis'], ['838', 'Autres charges H.A.O.'], ['845', 'Dons et libéralités obtenus'], ['846', 'Abandons de créances obtenus'], ['848', 'Autres produits H.A.O.'],
  ['852', 'Dotations aux amortissements H.A.O.'], ['853', 'Dotations aux dépréciations H.A.O.'], ['854', 'Dotations aux provisions pour risques et charges H.A.O.'],
  ['862', 'Reprises d\'amortissements H.A.O.'], ['863', 'Reprises de dépréciations H.A.O.'], ['864', 'Reprises de provisions pour risques et charges H.A.O.'],
  ['871', 'Participation légale aux bénéfices'], ['892', 'Rappel d\'impôts sur résultats antérieurs'], ['895', 'Impôt minimum forfaitaire (I.M.F.)'], ['899', 'Dégrèvements d\'impôts sur résultats antérieurs'],
];
const seen = new Set(PLAN.map((p) => p[0]));
for (const e of EXTRA) if (!seen.has(e[0])) { seen.add(e[0]); PLAN.push(e); }
const JOURNALS = { VT: 'Ventes', AC: 'Achats', BQ: 'Banque', CA: 'Caisse', MM: 'Mobile money', OD: 'Opérations diverses', AN: 'À-nouveaux' };
module.exports = { PLAN, JOURNALS };
