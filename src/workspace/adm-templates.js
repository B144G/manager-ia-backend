'use strict';
// Administration : modèles prêts à l'emploi (procédures de PME, suggestions de conformité, durées de conservation, fonctions et règles de séparation des tâches).
// Ce sont des SUGGESTIONS GÉNÉRIQUES à adapter : aucune référence à un texte de loi précis (l'entreprise remplit la sienne), et les durées de
// conservation sont indicatives et réglables : à confirmer avec votre conseil juridique ou comptable.

const sop = (key, title, domain, purpose, steps, indicators, reviewMonths = 12) => ({ key, title, domain, purpose, steps: steps.map((s) => (typeof s === 'string' ? { text: s } : s)), indicators, reviewMonths });

const SOP_TEMPLATES = [
  sop('recrutement', 'Recrutement d’un employé', 'Ressources humaines', 'Recruter la bonne personne de façon équitable, traçable et dans le budget prévu.',
    ['Le responsable exprime le besoin (poste, profil, budget) et le fait valider par la direction.', 'Rédiger et diffuser l’offre (réseaux, affichage, bouche-à-oreille).', 'Présélectionner les candidatures sur des critères écrits.', 'Mener les entretiens avec une grille identique pour tous.', 'Vérifier les références et les pièces demandées.', 'Établir et faire signer le contrat de travail ; remettre la fiche de poste.', 'Accueillir et former le nouvel employé (voir la procédure d’accueil).'],
    ['Délai moyen de recrutement (jours)', 'Part des recrutements à l’intérieur du budget']),
  sop('achat', 'Achat de biens et services', 'Achats', 'Acheter au bon prix, avec une autorisation préalable et une séparation entre celui qui demande, celui qui commande et celui qui paie.',
    ['Le demandeur remplit une demande d’achat (besoin, quantité, budget).', 'Le responsable valide selon le seuil de montant.', 'Demander au moins deux ou trois devis au-dessus du seuil fixé par l’entreprise.', 'Émettre le bon de commande signé par la personne autorisée.', 'Réceptionner et contrôler la livraison (quantité, qualité) par une personne différente de l’acheteur.', 'Rapprocher bon de commande, bon de livraison et facture avant paiement.', 'Archiver les pièces dans le dossier d’achat.'],
    ['Part des achats avec bon de commande préalable', 'Écart moyen entre commande et facture']),
  sop('encaissement', 'Encaissement des ventes et suivi des créances', 'Finance', 'Sécuriser les encaissements et relancer les impayés à temps.',
    ['Émettre la facture ou le reçu numéroté pour chaque vente.', 'Encaisser (espèces, mobile money, virement) et enregistrer le jour même.', 'Déposer les espèces en banque dans le délai fixé.', 'Rapprocher les encaissements du relevé bancaire chaque semaine.', 'Relancer les clients en retard (rappel, appel, courrier) selon un calendrier fixe.', 'Escalader au responsable les impayés au-delà du délai défini.'],
    ['Délai moyen d’encaissement (jours)', 'Taux d’impayés']),
  sop('caisse', 'Gestion de la caisse', 'Finance', 'Éviter les écarts et les détournements dans la manipulation des espèces.',
    ['Un seul caissier responsable de la caisse par jour.', 'Enregistrer chaque entrée et sortie avec une pièce justificative.', 'Compter la caisse en fin de journée, en présence d’un second contrôleur.', 'Consigner l’écart éventuel et son explication.', 'Verser l’excédent en banque ; ne pas garder plus que le plafond de caisse.', 'Faire contrôler l’ensemble par un responsable au moins une fois par mois.'],
    ['Nombre de jours avec écart de caisse', 'Montant cumulé des écarts'], 6),
  sop('conges', 'Demande et validation des congés', 'Ressources humaines', 'Planifier les absences sans désorganiser le service.',
    ['L’employé dépose sa demande avec les dates souhaitées.', 'Le responsable vérifie l’effectif minimum du service et le solde.', 'Décision rendue dans le délai fixé, avec motif en cas de refus.', 'Désigner un remplaçant pour la période.', 'RH met à jour le solde et le planning.'],
    ['Délai de réponse (jours)', 'Taux de demandes acceptées']),
  sop('inventaire', 'Inventaire physique des stocks', 'Stock', 'Vérifier que le stock réel correspond au stock enregistré.',
    ['Planifier la date et prévenir les équipes ; geler les mouvements.', 'Constituer des équipes de comptage de deux personnes.', 'Compter chaque article, noter les quantités sur des fiches numérotées.', 'Faire un second comptage indépendant sur les écarts.', 'Valider les écarts par un responsable avant de régulariser.', 'Analyser les causes et décider des actions correctives.'],
    ['Taux d’écart d’inventaire (%)', 'Valeur des écarts'], 12),
  sop('accueil', 'Accueil d’un nouvel employé', 'Ressources humaines', 'Rendre le nouvel arrivant autonome rapidement.',
    ['Préparer le poste de travail, les accès et la présentation de l’équipe.', 'Remettre la fiche de poste, le règlement intérieur et les procédures clés.', 'Faire signer l’accusé de lecture des procédures obligatoires.', 'Désigner un référent pour les premières semaines.', 'Faire un point à 1 mois et à 3 mois.'],
    ['Délai avant autonomie (jours)', 'Taux de départs pendant la période d’essai']),
  sop('reclamation', 'Traitement des réclamations clients', 'Relation client', 'Répondre vite et apprendre de chaque réclamation.',
    ['Enregistrer la réclamation (date, client, objet).', 'Accuser réception au client dans les 48 heures.', 'Analyser la cause avec le service concerné.', 'Proposer une solution et la faire valider si elle a un coût.', 'Répondre au client et clôturer.', 'Relever les causes récurrentes chaque mois.'],
    ['Délai moyen de traitement (jours)', 'Taux de clients satisfaits après traitement']),
  sop('sauvegarde', 'Sauvegarde et protection des données', 'Informatique', 'Ne pas perdre ni exposer les données de l’entreprise.',
    ['Lister les données essentielles et leur emplacement.', 'Sauvegarder selon la fréquence fixée sur un support distinct.', 'Tester la restauration au moins une fois par trimestre.', 'Limiter les accès aux personnes qui en ont besoin ; retirer les accès des départs.', 'Changer les mots de passe partagés au départ d’un employé.'],
    ['Nombre de restaurations testées / an', 'Accès retirés dans les 48 h après un départ'], 6),
  sop('cloture', 'Clôture mensuelle', 'Finance', 'Disposer chaque mois de chiffres fiables.',
    ['Enregistrer toutes les opérations du mois avec leurs pièces.', 'Rapprocher la banque et la caisse.', 'Contrôler les comptes clients et fournisseurs.', 'Passer les écritures de régularisation.', 'Faire relire les états par un responsable puis les présenter à la direction.'],
    ['Jour de clôture (J + n)', 'Nombre de corrections après clôture'], 12),
  sop('maintenance', 'Entretien des équipements et véhicules', 'Moyens généraux', 'Éviter les pannes et suivre les échéances (assurance, contrôle technique).',
    ['Tenir le registre des équipements avec leurs échéances.', 'Planifier les entretiens préventifs.', 'Faire valider toute réparation au-dessus du seuil fixé.', 'Consigner chaque intervention (date, coût, prestataire).', 'Renouveler assurances et contrôles avant la date limite.'],
    ['Part des échéances respectées', 'Coût de maintenance par équipement'], 12),
];

const COMPLIANCE_SUGGESTIONS = [
  { title: 'Déclaration fiscale périodique', category: 'declaration', frequencyMonths: 1, note: 'Renseignez l’administration concernée, la référence du texte applicable et la date limite propres à votre activité.' },
  { title: 'Déclaration sociale périodique', category: 'declaration', frequencyMonths: 1, note: 'Cotisations et déclarations liées au personnel : indiquez l’organisme et la périodicité.' },
  { title: 'Déclaration annuelle de résultats', category: 'declaration', frequencyMonths: 12, note: 'Dépôt des états annuels : précisez l’échéance et le destinataire.' },
  { title: 'Renouvellement de licence ou autorisation d’exercer', category: 'license', frequencyMonths: 12, note: 'Notez l’autorité qui délivre l’autorisation et sa date d’expiration.' },
  { title: 'Assurance responsabilité civile', category: 'insurance', frequencyMonths: 12, note: 'Date de renouvellement de la police et attestation à conserver.' },
  { title: 'Assurance des locaux et du matériel', category: 'insurance', frequencyMonths: 12, note: 'Vérifier les capitaux garantis chaque année.' },
  { title: 'Registre du personnel à jour', category: 'register', frequencyMonths: 3, note: 'Vérifier que les entrées et sorties sont consignées.' },
  { title: 'Registre des visiteurs / des accidents', category: 'register', frequencyMonths: 3, note: 'Selon votre activité : à confirmer avec votre conseil.' },
  { title: 'Contrôle périodique des extincteurs et de la sécurité', category: 'audit', frequencyMonths: 12, note: 'Garder la preuve d’intervention du prestataire.' },
  { title: 'Visites médicales du personnel', category: 'audit', frequencyMonths: 12, note: 'Planifier selon la périodicité qui s’applique à vos postes.' },
  { title: 'Mise à jour des statuts et du registre des décisions', category: 'register', frequencyMonths: 12, note: 'Après chaque assemblée ou décision importante.' },
  { title: 'Protection des données personnelles', category: 'other', frequencyMonths: 12, note: 'Revue annuelle des données collectées, des accès et des durées de conservation.' },
];

// Durées de conservation INDICATIVES (années) : réglables par l'entreprise. activeYears = durée en archivage « courant » avant l'archive.
const RETENTION_DEFAULTS = [
  { name: 'Pièces comptables (factures, relevés)', activeYears: 2, retentionYears: 10, basis: 'doc_date', endAction: 'review', note: 'Indicatif : à confirmer avec votre comptable.' },
  { name: 'Contrats commerciaux', activeYears: 1, retentionYears: 10, basis: 'doc_date', endAction: 'review', note: 'À compter de la fin du contrat dans la pratique : ajustez.' },
  { name: 'Dossiers du personnel', activeYears: 1, retentionYears: 5, basis: 'doc_date', endAction: 'review', note: 'Indicatif : à confirmer avec votre conseil.' },
  { name: 'Bulletins de paie', activeYears: 1, retentionYears: 5, basis: 'doc_date', endAction: 'review', note: 'Indicatif.' },
  { name: 'Correspondance courante', activeYears: 0.5, retentionYears: 2, basis: 'doc_date', endAction: 'destroy', note: 'Peut être détruite après validation.' },
  { name: 'Procès-verbaux et décisions de direction', activeYears: 2, retentionYears: 0, basis: 'doc_date', endAction: 'keep', note: '0 = conservation permanente.' },
  { name: 'Dossiers clients prospects sans suite', activeYears: 0.5, retentionYears: 3, basis: 'doc_date', endAction: 'destroy', note: 'Données personnelles : ne pas les garder sans raison.' },
];

// Fonctions de séparation des tâches : autoriser / exécuter / enregistrer / contrôler. Codes stables, utilisés par les règles ci-dessous.
const SOD_FUNCTIONS = [
  { code: 'supplier_create', name: 'Créer ou modifier un fournisseur', category: 'record' },
  { code: 'purchase_approve', name: 'Autoriser un achat', category: 'authorize' },
  { code: 'purchase_order', name: 'Passer une commande', category: 'execute' },
  { code: 'goods_receive', name: 'Réceptionner la marchandise', category: 'execute' },
  { code: 'invoice_record', name: 'Enregistrer une facture fournisseur', category: 'record' },
  { code: 'payment_make', name: 'Effectuer un paiement', category: 'execute' },
  { code: 'payment_approve', name: 'Autoriser un paiement', category: 'authorize' },
  { code: 'cash_handle', name: 'Manipuler la caisse', category: 'execute' },
  { code: 'cash_reconcile', name: 'Rapprocher caisse et banque', category: 'control' },
  { code: 'stock_keep', name: 'Garder le stock', category: 'execute' },
  { code: 'stock_count', name: 'Faire l’inventaire', category: 'control' },
  { code: 'employee_create', name: 'Créer un employé', category: 'record' },
  { code: 'payroll_run', name: 'Préparer la paie', category: 'execute' },
  { code: 'payroll_approve', name: 'Valider la paie', category: 'authorize' },
  { code: 'sale_invoice', name: 'Émettre une facture client', category: 'record' },
  { code: 'credit_note', name: 'Autoriser un avoir ou une remise', category: 'authorize' },
  { code: 'accounting_post', name: 'Passer des écritures comptables', category: 'record' },
  { code: 'accounting_review', name: 'Relire et contrôler la comptabilité', category: 'control' },
  { code: 'access_grant', name: 'Donner des accès au système', category: 'authorize' },
  { code: 'system_use', name: 'Utiliser le système au quotidien', category: 'execute' },
];
// [fonction A, fonction B, gravité, raison]
const SOD_RULES = [
  ['supplier_create', 'payment_make', 'high', 'Créer un faux fournisseur puis le payer : risque de fraude.'],
  ['purchase_approve', 'goods_receive', 'medium', 'Celui qui autorise l’achat ne doit pas réceptionner la marchandise.'],
  ['purchase_order', 'invoice_record', 'medium', 'Commander et enregistrer la facture : risque de facture fictive.'],
  ['invoice_record', 'payment_make', 'high', 'Enregistrer la facture et la payer : plus aucun contrôle.'],
  ['payment_make', 'payment_approve', 'high', 'Le même qui autorise et exécute un paiement.'],
  ['cash_handle', 'cash_reconcile', 'high', 'Le caissier ne doit pas contrôler sa propre caisse.'],
  ['stock_keep', 'stock_count', 'medium', 'Le magasinier ne doit pas faire seul l’inventaire.'],
  ['employee_create', 'payroll_run', 'high', 'Créer un salarié fictif puis le payer.'],
  ['payroll_run', 'payroll_approve', 'high', 'Préparer et valider sa propre paie.'],
  ['sale_invoice', 'credit_note', 'medium', 'Facturer et annuler : risque de détournement.'],
  ['accounting_post', 'accounting_review', 'medium', 'Relire sa propre comptabilité.'],
  ['access_grant', 'system_use', 'low', 'Se donner à soi-même des accès.'],
];

module.exports = { SOP_TEMPLATES, COMPLIANCE_SUGGESTIONS, RETENTION_DEFAULTS, SOD_FUNCTIONS, SOD_RULES };
