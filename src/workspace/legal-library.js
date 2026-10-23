'use strict';
// Bibliothèque fournie par MANAGER-IA pour le module Juridique : modèles de documents, exemples d'obligations et de lignes du registre des données.
// Ce sont des textes informatifs : aucun ne prétend être conforme à la loi d'un pays précis. Chaque modèle de document se termine par la mention de relecture.
const MENTION = 'Modèle informatif à faire relire par un professionnel du droit.';

const CITY = ['city', 'Ville'];
const DATE = ['date', 'Date'];
const f = (list) => list.map(([key, label]) => ({ key, label }));

const DOCS = [
  {
    id: 'demand', title: 'Lettre de mise en demeure',
    fields: f([['creditor', 'Votre nom ou raison sociale'], ['creditorAddr', 'Votre adresse'], ['debtor', 'Nom du débiteur'], ['debtorAddr', 'Adresse du débiteur'], ['amount', 'Montant dû'], ['origin', 'Origine de la dette (facture n°, date)'], ['days', 'Délai accordé (jours)'], CITY, DATE]),
    body: `{{creditor}}\n{{creditorAddr}}\n\n{{debtor}}\n{{debtorAddr}}\n\n{{city}}, le {{date}}\n\nObjet : mise en demeure de payer\n\nMadame, Monsieur,\n\nSauf erreur de notre part, vous restez nous devoir la somme de {{amount}} au titre de : {{origin}}.\n\nMalgré nos précédents rappels, cette somme n'a pas été réglée. Nous vous mettons donc en demeure de la payer dans un délai de {{days}} jours à compter de la réception de la présente lettre.\n\nÀ défaut de paiement dans ce délai, nous nous réservons le droit d'engager les démarches possibles pour obtenir le règlement de cette somme.\n\nNous restons disponibles pour trouver une solution amiable.\n\nVeuillez agréer, Madame, Monsieur, nos salutations distinguées.\n\n{{creditor}}\nSignature :`,
  },
  {
    id: 'work', title: 'Attestation de travail',
    fields: f([['employer', 'Entreprise (nom)'], ['rep', 'Nom et fonction de la personne qui signe'], ['employee', "Nom de l'employé"], ['job', 'Poste occupé'], ['start', "Date d'entrée"], ['end', 'Date de sortie (ou « à ce jour »)'], CITY, DATE]),
    body: `ATTESTATION DE TRAVAIL\n\nJe soussigné(e), {{rep}}, agissant pour {{employer}}, atteste que {{employee}} a travaillé dans notre entreprise en qualité de {{job}} du {{start}} au {{end}}.\n\nCette attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.\n\nFait à {{city}}, le {{date}}\n\n{{rep}}\nSignature et cachet :`,
  },
  {
    id: 'debt', title: 'Reconnaissance de dette',
    fields: f([['debtor', 'Nom du débiteur (celui qui doit)'], ['creditor', 'Nom du créancier (celui qui prête)'], ['amount', 'Montant (en chiffres et en lettres)'], ['reason', 'Origine de la somme'], ['terms', 'Conditions de remboursement (dates, mensualités)'], CITY, DATE]),
    body: `RECONNAISSANCE DE DETTE\n\nJe soussigné(e) {{debtor}} reconnais devoir à {{creditor}} la somme de {{amount}}, correspondant à : {{reason}}.\n\nJe m'engage à rembourser cette somme selon les conditions suivantes : {{terms}}.\n\nFait à {{city}}, le {{date}}, en deux exemplaires.\n\nLe débiteur ({{debtor}}) :\nÉcrire « Lu et approuvé » puis signer.\n\nLe créancier ({{creditor}}) :\nSignature :`,
  },
  {
    id: 'service', title: 'Contrat de prestation simple',
    fields: f([['provider', 'Prestataire (nom)'], ['client', 'Client (nom)'], ['service', 'Description du travail à faire'], ['price', 'Prix'], ['payment', 'Modalités de paiement (acompte, solde, dates)'], ['start', 'Date de début'], ['duration', 'Durée ou date de fin'], CITY, DATE]),
    body: `CONTRAT DE PRESTATION DE SERVICES\n\nEntre {{provider}} (le prestataire) et {{client}} (le client).\n\nArticle 1 - Objet\nLe prestataire s'engage à réaliser pour le client : {{service}}.\n\nArticle 2 - Durée\nLa prestation commence le {{start}}. Durée ou date de fin : {{duration}}.\n\nArticle 3 - Prix et paiement\nLe prix est de {{price}}. Paiement : {{payment}}.\n\nArticle 4 - Obligations\nLe prestataire réalise le travail avec soin. Le client fournit les informations nécessaires et paie aux dates prévues.\n\nArticle 5 - Fin anticipée\nChaque partie peut mettre fin au contrat par écrit, en prévenant l'autre à l'avance et en réglant ce qui est déjà fait.\n\nArticle 6 - Désaccords\nEn cas de désaccord, les parties cherchent d'abord une solution amiable.\n\nFait à {{city}}, le {{date}}, en deux exemplaires.\n\nLe prestataire ({{provider}}) :        Le client ({{client}}) :\nSignature :                              Signature :`,
  },
  {
    id: 'lease', title: 'Contrat de bail simple',
    fields: f([['landlord', 'Bailleur (propriétaire)'], ['tenant', 'Locataire'], ['premises', 'Local ou logement loué (adresse, description)'], ['use', 'Usage prévu (habitation, commerce…)'], ['rent', 'Loyer par période (montant et fréquence)'], ['deposit', 'Dépôt de garantie (montant)'], ['start', 'Date de début'], ['duration', 'Durée du bail'], ['notice', 'Préavis pour mettre fin au bail'], CITY, DATE]),
    body: `CONTRAT DE BAIL SIMPLE\n\nEntre {{landlord}} (le bailleur) et {{tenant}} (le locataire).\n\nArticle 1 - Local loué\nLe bailleur loue au locataire : {{premises}}. Usage prévu : {{use}}.\n\nArticle 2 - Durée\nLe bail commence le {{start}} pour une durée de {{duration}}.\n\nArticle 3 - Loyer\nLe loyer est de {{rent}}. Il est payé à la date convenue entre les parties.\n\nArticle 4 - Dépôt de garantie\nLe locataire verse un dépôt de {{deposit}}. Il est rendu à la fin du bail, après vérification de l'état du local et paiement de ce qui reste dû.\n\nArticle 5 - Entretien\nLe locataire entretient le local et signale rapidement tout problème. Les grosses réparations sont discutées entre les parties.\n\nArticle 6 - Fin du bail\nChaque partie qui souhaite y mettre fin prévient l'autre par écrit avec un préavis de {{notice}}.\n\nArticle 7 - Désaccords\nEn cas de désaccord, les parties cherchent d'abord une solution amiable.\n\nFait à {{city}}, le {{date}}, en deux exemplaires.\n\nLe bailleur ({{landlord}}) :        Le locataire ({{tenant}}) :\nSignature :                          Signature :`,
  },
  {
    id: 'termination', title: 'Lettre de résiliation',
    fields: f([['sender', 'Votre nom ou raison sociale'], ['senderAddr', 'Votre adresse'], ['recipient', 'Nom du destinataire'], ['recipientAddr', 'Adresse du destinataire'], ['contract', 'Contrat concerné (nom, numéro, date)'], ['effective', 'Date de fin souhaitée'], ['reason', 'Motif (facultatif)'], CITY, DATE]),
    body: `{{sender}}\n{{senderAddr}}\n\n{{recipient}}\n{{recipientAddr}}\n\n{{city}}, le {{date}}\n\nObjet : résiliation du contrat {{contract}}\n\nMadame, Monsieur,\n\nPar la présente, nous vous informons de notre décision de mettre fin au contrat suivant : {{contract}}, avec effet au {{effective}}.\n\nMotif : {{reason}}.\n\nNous vous demandons de bien vouloir nous confirmer la réception de ce courrier et les démarches à suivre pour clôturer le contrat.\n\nVeuillez agréer, Madame, Monsieur, nos salutations distinguées.\n\n{{sender}}\nSignature :`,
  },
  {
    id: 'amendment', title: 'Avenant à un contrat',
    fields: f([['partyA', 'Première partie (nom)'], ['partyB', 'Seconde partie (nom)'], ['contract', 'Contrat modifié (nom, date)'], ['change', 'Ce qui change (article, ancienne et nouvelle règle)'], ['effective', "Date d'effet de la modification"], CITY, DATE]),
    body: `AVENANT AU CONTRAT : {{contract}}\n\nEntre {{partyA}} et {{partyB}}.\n\nLes parties ont conclu le contrat désigné ci-dessus et conviennent de le modifier comme suit.\n\nArticle 1 - Modification\n{{change}}\n\nArticle 2 - Date d'effet\nCette modification s'applique à partir du {{effective}}.\n\nArticle 3 - Le reste du contrat\nToutes les autres clauses du contrat restent inchangées.\n\nFait à {{city}}, le {{date}}, en deux exemplaires.\n\n{{partyA}} :        {{partyB}} :\nSignature :          Signature :`,
  },
  {
    id: 'settlement', title: "Protocole d'accord",
    fields: f([['partyA', 'Première partie (nom)'], ['partyB', 'Seconde partie (nom)'], ['subject', 'Sujet du désaccord'], ['commitA', 'Engagements de la première partie'], ['commitB', 'Engagements de la seconde partie'], ['deadline', "Date limite d'exécution"], CITY, DATE]),
    body: `PROTOCOLE D'ACCORD\n\nEntre {{partyA}} et {{partyB}}.\n\nExposé\nLes parties étaient en désaccord au sujet de : {{subject}}. Elles ont décidé de régler ce point à l'amiable selon les termes ci-dessous.\n\nArticle 1 - Engagements de {{partyA}}\n{{commitA}}\n\nArticle 2 - Engagements de {{partyB}}\n{{commitB}}\n\nArticle 3 - Délai\nChaque partie exécute ses engagements au plus tard le {{deadline}}.\n\nArticle 4 - Portée\nUne fois les engagements respectés, chaque partie considère le désaccord comme réglé, dans les limites de ce qui est écrit ici.\n\nFait à {{city}}, le {{date}}, en deux exemplaires.\n\n{{partyA}} :        {{partyB}} :\nSignature :          Signature :`,
  },
  {
    id: 'proxy', title: 'Procuration',
    fields: f([['principal', 'Votre nom (celui qui donne le pouvoir)'], ['principalId', "Pièce d'identité (type et numéro)"], ['agent', 'Nom de la personne qui vous représente'], ['agentId', "Pièce d'identité de cette personne"], ['purpose', 'Ce que cette personne peut faire en votre nom'], ['until', 'Valable jusqu\'au'], CITY, DATE]),
    body: `PROCURATION\n\nJe soussigné(e) {{principal}}, pièce d'identité : {{principalId}},\n\ndonne pouvoir à {{agent}}, pièce d'identité : {{agentId}},\n\nafin de me représenter et d'accomplir en mon nom l'acte suivant : {{purpose}}.\n\nCe pouvoir est valable jusqu'au {{until}}. Il se limite à l'acte décrit ci-dessus.\n\nFait à {{city}}, le {{date}}\n\nLe mandant ({{principal}}) :\nÉcrire « Bon pour pouvoir » puis signer.\n\nLe mandataire ({{agent}}) :\nSignature :`,
  },
  {
    id: 'rules', title: 'Règlement intérieur simplifié',
    fields: f([['company', "Nom de l'entreprise"], ['hours', 'Horaires de travail'], ['absence', "Règle pour prévenir en cas d'absence"], ['safety', 'Consignes de sécurité et d\'hygiène'], ['conduct', 'Règles de conduite (respect, matériel, caisse…)'], ['sanctions', 'Suites en cas de manquement'], ['contact', 'Personne à contacter pour toute question'], CITY, DATE]),
    body: `RÈGLEMENT INTÉRIEUR SIMPLIFIÉ : {{company}}\n\n1. Horaires\n{{hours}}\n\n2. Absences et retards\n{{absence}}\n\n3. Sécurité et hygiène\n{{safety}}\n\n4. Conduite et usage du matériel\n{{conduct}}\n\n5. En cas de manquement\n{{sanctions}}\n\n6. Questions\nPour toute question sur ce règlement : {{contact}}.\n\nFait à {{city}}, le {{date}}\n\nLa direction de {{company}} :\nSignature :\n\nLu et pris en compte par le membre du personnel (nom, date, signature) :`,
  },
  {
    id: 'privacy-policy', title: 'Politique de confidentialité du site',
    fields: f([['site', 'Nom du site ou de la boutique'], ['owner', 'Responsable du site (nom, adresse)'], ['contact', 'Adresse e-mail ou numéro pour vos questions'], ['collected', 'Informations collectées (nom, téléphone, adresse…)'], ['purpose', 'Pourquoi ces informations sont collectées'], ['shared', 'Avec qui elles sont partagées (livreur, comptable…)'], ['retention', 'Durée de conservation'], DATE]),
    body: `POLITIQUE DE CONFIDENTIALITÉ : {{site}}\n\nDernière mise à jour : {{date}}\n\nQui sommes-nous ?\nLe site {{site}} est tenu par {{owner}}.\n\nQuelles informations collectons-nous ?\n{{collected}}\n\nPourquoi ?\n{{purpose}}\n\nÀ qui sont-elles transmises ?\n{{shared}}\n\nCombien de temps les conservons-nous ?\n{{retention}}\n\nVos demandes\nVous pouvez nous demander de consulter, corriger ou supprimer les informations qui vous concernent en nous écrivant à : {{contact}}.\n\nCe texte décrit nos pratiques actuelles ; il sera mis à jour si elles changent.`,
  },
];

const OBLIGATIONS = [
  ['Licence ou patente commerciale', 'license', 12], ['Assurance des locaux et responsabilité civile', 'insurance', 12], ['Déclaration fiscale périodique', 'declaration', 1],
  ['Déclaration des salariés aux organismes sociaux', 'declaration', 3], ['Affichages obligatoires (prix, horaires, règlement)', 'display', 12], ['Contrôle des extincteurs et de la sécurité', 'inspection', 12],
  ['Visite médicale du personnel', 'inspection', 12], ["Autorisation d'exploitation ou d'hygiène", 'authorization', 12],
].map(([title, kind, rec], i) => ({ id: 'ob-' + i, title, data: { title, kind, recurrenceMonths: rec, notes: "Exemple à adapter à votre pays et votre activité : vérifiez la règle exacte et la fréquence auprès de l'administration." } }));

const PRIVACY = [
  ['Nom et téléphone des clients', 'Clients', 'Livrer, facturer, répondre aux demandes'], ['Adresses de livraison', 'Clients', 'Livrer les commandes'], ['Conversations WhatsApp avec les clients', 'Clients et prospects', 'Répondre et suivre les commandes'],
  ['Dossier du personnel (identité, contrat, salaire)', 'Employés', 'Gérer le travail et la paie'], ['Images des caméras de surveillance', 'Clients, employés, visiteurs', 'Sécurité des locaux'],
].map(([dataKind, people, purpose], i) => ({ id: 'pv-' + i, title: dataKind, data: { dataKind, people, purpose, retention: '', notes: "Exemple à adapter : précisez où c'est conservé et pour combien de temps." } }));

const builtins = () => [
  ...DOCS.map((d) => ({ id: 'b:' + d.id, builtin: true, kind: 'document', title: d.title, body: `${d.body}\n\n${MENTION}`, fields: d.fields, data: {}, updatedAt: null })),
  ...OBLIGATIONS.map((o) => ({ id: 'b:' + o.id, builtin: true, kind: 'obligation', title: o.title, body: '', fields: [], data: o.data, updatedAt: null })),
  ...PRIVACY.map((o) => ({ id: 'b:' + o.id, builtin: true, kind: 'privacy', title: o.title, body: '', fields: [], data: o.data, updatedAt: null })),
];

module.exports = { MENTION, builtins };
