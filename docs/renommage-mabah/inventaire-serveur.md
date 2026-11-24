# Inventaire des occurrences de « Brij » : serveur

Généré par `scripts/rename-brand.mjs --inventory` sur l'état d'origine du dépôt. 279 lignes concernées, dans 123 fichiers.

## Synthèse par classe

| Classe | Lignes |
|---|---|
| RENOMMER | 264 |
| RENOMMER (+ partie conservée) | 6 |
| CONSERVER | 9 |

## Synthèse par domaine

| Domaine | Lignes | dont à conserver |
|---|---|---|
| Autre code et configuration | 37 | 3 |
| Documentation | 26 | 0 |
| Administration (interface) | 13 | 0 |
| Textes légaux (conditions, confidentialité, registre…) | 50 | 0 |
| Invites et connaissances de l'IA | 28 | 0 |
| Tests, scripts et démonstrations | 76 | 6 |
| E-mails | 37 | 0 |
| PDF et documents imprimables | 8 | 0 |
| WhatsApp / canaux | 4 | 0 |

## Éléments conservés volontairement (liste blanche)

| Motif | Raison |
|---|---|
| `url-technique` | adresse publique actuelle : le domaine définitif n'est pas choisi (constante publicUrl / SITE_URL) |
| `chemin-local` | dossier local de l'ordinateur du fondateur (outil de captures), pas du produit |
| `mot-de-passe-demo` | mot de passe de comptes de démonstration/tests existants |
| `sel-chiffrement` | sel de dérivation de la clé de chiffrement des champs : le changer rendrait les données illisibles |
| `uid-calendrier` | UID des événements .ics déjà abonnés : le changer créerait des doublons dans les agendas |
| `alias-transition` | nom alternatif JSON-LD : relie l'ancien nom au nouveau pour Google (transition) |
| `ancien-code-paiement` | références de paiement déjà émises (BRIJ-123456) : toujours acceptées en lecture |
| `mots-de-passe-faibles` | listes de mots de passe trop courants : l'ancien nom y reste (le nouveau y est ajouté) |
| `ancien-nom-legacy` | motif qui accepte les anciennes références |

## Fichiers historiques ignorés (jamais réécrits)

| Fichier | Lignes |
|---|---|
| `scripts/rename-brand.mjs` | 75 |
| `docs/fusion/MATRICE-SERVEUR.md` | 1 |
| `docs/fusion/RAPPORT-DEPLOIEMENT.md` | 1 |
| `docs/fusion/TESTS-FUSION-MODULES.txt` | 37 |
| `docs/fusion/TESTS.txt` | 18 |
| `docs/fusion/captures-avis-transport/LISEZ-MOI.md` | 1 |

## Détail

| Fichier:ligne | Domaine | Classe | Règles / conservé | Extrait |
|---|---|---|---|---|
| `.env.example:20` | Autre code et configuration | RENOMMER | general | #  Brij-IA : variables d'environnement |
| `.env.example:81` | Autre code et configuration | RENOMMER | general | # Adresse d'expéditeur affichée, ex : Brij-IA <tendabrandon9@gmail.com> |
| `.env.example:202` | Autre code et configuration | RENOMMER | general | # SMTP_FROM=Brij-IA <votre-adresse-validee@exemple.com>   # adresse d'expéditeur validée chez Brevo (Senders) |
| `Dockerfile:1` | Autre code et configuration | RENOMMER | general | # Image Docker de Brij-IA (Node 20). Les données sont dans PostgreSQL (Neon) : le conteneur ne garde rien, il peut être remplacé à tout moment. |
| `README.md:1` | Documentation | RENOMMER | general | # Brij-IA : serveur (backend) |
| `README.md:3` | Documentation | RENOMMER | general | ## GUIDE COMPLET : mettre Brij-IA en ligne (base de données, serveur, site) |
| `README.md:79` | Documentation | RENOMMER | general | 4. Attendez que l'état passe à **Live** (3 à 5 minutes la première fois). Le journal (*Logs*) doit afficher « Brij-IA démarré… » puis « Base de données : PostgreSQL ». |
| `README.md:211` | Documentation | RENOMMER | general | ## GUIDE WHATSAPP : obtenir les identifiants (Phone number ID, jeton, secret) et brancher Brij-IA |
| `README.md:215` | Documentation | RENOMMER | general | ### Deux usages de WhatsApp dans Brij-IA (ne les confondez pas) |
| `README.md:237` | Documentation | RENOMMER | general | 2. Cas d'utilisation : choisissez **« Se connecter avec les clients sur WhatsApp »** (ou, selon l'écran, type **Entreprise** puis **Ajouter le produit WhatsApp**). Nommez |
| `README.md:247` | Documentation | RENOMMER | general | \| Valeur demandée par Brij-IA \| Où la trouver chez Meta \| Où la mettre dans Brij-IA \| |
| `README.md:254` | Documentation | RENOMMER | general | \| **Adresse de rappel (webhook)** \| c'est Brij-IA qui la fournit (voir l'étape 6) \| à coller chez Meta \| |
| `README.md:274` | Documentation | RENOMMER | general | 4. Mettez à jour dans Brij-IA le **Phone number ID** et le **numéro** (ceux du numéro réel, pas ceux du numéro de test). |
| `README.md:287` | Documentation | RENOMMER | general | 4. Dans Brij-IA, cliquez **Tester la connexion** : le nom affiché du numéro doit apparaître. |
| `README.md:298` | Documentation | RENOMMER | general | WhatsApp interdit d'écrire à un client **plus de 24 heures après son dernier message**, sauf avec un **modèle approuvé par Meta**. Brij-IA en utilise trois (créez-les dan |
| `README.md:300` | Documentation | RENOMMER | general | \| Usage dans Brij-IA \| Catégorie Meta \| Texte du modèle (variables '{{1}}'…) \| |
| `README.md:308` | Documentation | RENOMMER | general | 3. Dans Brij-IA : **Assistant commercial → Relances → Ajouter un modèle** : saisissez **le nom exact**, la langue, l'usage et le texte (aperçu). Le nombre de variables es |
| `README.md:365` | Documentation | RENOMMER | general | **Ce que c'est.** Un bouton « Connecter WhatsApp » dans l'onglet Canaux : une fenêtre de Meta s'ouvre, l'entreprise cliente choisit son compte et son numéro, et Brij-IA r |
| `README.md:573` | Documentation | RENOMMER | general | 2. Allez sur <https://myaccount.google.com/apppasswords>, donnez un nom (ex : « Brij-IA ») et créez le mot de passe : Google affiche 16 lettres. |
| `README.md:580` | Documentation | RENOMMER | general | SMTP_FROM=Brij-IA <votre.adresse@gmail.com> |
| `README.md:596` | Documentation | RENOMMER | general | Notification Brij-IA : {{1}} Consultez votre espace administrateur pour la suite. |
| `admin/admin.css:1` | Administration | RENOMMER | general | /* Administration Brij-IA — système de design. |
| `admin/admin.js:2` | Administration | RENOMMER | general | // Administration Brij-IA — coque (menu, en-tête, routage, recherche Ctrl K, connexion). Les écrans sont dans views-a.js et views-b.js. |
| `admin/admin.js:33` | Administration | RENOMMER | general | function setTitle() { const c = counts(); const n = c.payments + c.alerts + c.clients; document.title = (n ? '(' + n + ') ' : '') + 'Administration Brij-IA'; } |
| `admin/admin.js:40` | Administration | RENOMMER | logo-texte-admin, general | h('div', { class: 'brand' }, h('a', { href: '#/overview', 'aria-label': 'Brij-IA, accueil de l’administration' }, 'BRIJ', h('b', {}, '-IA')), h('span', { class: 'env' },  |
| `admin/admin.js:206` | Administration | RENOMMER | general | function showLogin() { A.live.stop(); S.ov = null; $('app').classList.add('hidden'); $('login').classList.remove('hidden'); document.title = 'Connexion · Administration B |
| `admin/index.html:8` | Administration | RENOMMER | general | <title>Administration Brij-IA</title> |
| `admin/index.html:20` | Administration | RENOMMER | logo-texte-balises | <div class="logo">BRIJ<b>-IA</b></div> |
| `admin/index.html:30` | Administration | RENOMMER | logo-texte-balises | <div class="logo-m">BRIJ<b>-IA</b></div> |
| `admin/live.js:54` | Administration | RENOMMER | id-notification-tag, general | try { new Notification('Nouveau compte Brij-IA', { body: a.name + ' · ' + a.plan + (a.interests.length ? ' · ' + a.interests.slice(0, 3).join(', ') : ''), tag: 'brij-acc- |
| `admin/ui.js:2` | Administration | RENOMMER | general | // Administration Brij-IA — briques d'interface (aucune dépendance externe). |
| `admin/views-b.js:127` | Administration | RENOMMER | general | if (c.includes('@')) return h('a', { class: 'btn sm', href: 'mailto:' + c + '?subject=' + encodeURIComponent('Brij-IA') + '&body=' + encodeURIComponent(text) }, icon('con |
| `admin/views-c.js:66` | Administration | RENOMMER | general | const msg = (u, gone) => 'Bonjour ' + u.name + ', votre abonnement Brij-IA ' + (gone ? 'a pris fin le ' : 'arrive à échéance le ') + fmtDate(u.planExpires) + '. Souhaitez |
| `admin/views-c.js:67` | Administration | RENOMMER | general | const link = (u, gone) => { const c = String(u.contact \|\| ''); if (c.includes('@')) return h('a', { class: 'btn sm', href: 'mailto:' + c + '?subject=' + encodeURIComponen |
| `docs/admin/README.md:1` | Documentation | RENOMMER | general | # Administration Brij-IA : refonte de l'interface et inscriptions en direct |
| `docs/administration.md:1` | Documentation | RENOMMER | general | # Module Administration (Brij-IA) |
| `docs/avis.md:22` | Documentation | RENOMMER | general | **Témoignages publics** : la page d'accueil affiche une section « Ils utilisent Brij-IA » (masquée s'il n'y en a aucun) alimentée par 'GET /api/ws/public/testimonials'. U |
| `docs/paiement-campay.md:3` | Documentation | RENOMMER | general | Brij-IA encaisse les abonnements par **Campay** (campay.net) : le client saisit son numéro Mobile Money, reçoit l'invite sur son téléphone, confirme avec son code secret, |
| `docs/paiement-campay.md:114` | Documentation | RENOMMER (+ partie conservée) | paiement-doc, conservé:ancien-code-paiement | **Parcours client** : choix du plan (le serveur calcule le montant) → commande « en attente » avec un code 'BRIJ-NNNNNN' (tiré au hasard côté serveur, unique) → l'écran a |
| `docs/paiement-campay.md:116` | Documentation | RENOMMER | paiement-doc-points | **Procédure de vérification du SMS (administrateur)** : Administration > Paiements > onglet « À vérifier ». Comparez avec le SMS ou le relevé de votre compte Mobile Money |
| `docs/securite/AUDIT.md:1` | Documentation | RENOMMER | general | # Audit de sécurité de Brij-IA — serveur (Node/Express, PostgreSQL) |
| `docs/securite/AUDIT.md:77` | Documentation | RENOMMER | general | **M12 — Droits des personnes non outillés.** Ni export, ni demande de suppression, ni consentements datés, ni durées de conservation paramétrables, ni registre des accès  |
| `docs/securite/legal/en/01-politique-de-confidentialite.md:5` | Textes légaux | RENOMMER | general | This policy explains what data Brij-IA collects, why, how long we keep it, with whom it is shared and how to exercise your rights. It is based on the principles of the Ge |
| `docs/securite/legal/en/01-politique-de-confidentialite.md:9` | Textes légaux | RENOMMER | general | **Brij-IA** — [TO COMPLETE: company name, legal form, registered office address, RCCM, NIU]. |
| `docs/securite/legal/en/01-politique-de-confidentialite.md:14` | Textes légaux | RENOMMER | general | - **Your Brij-IA account** (name, contact details, password, subscription, security log): Brij-IA is the **data controller**. |
| `docs/securite/legal/en/01-politique-de-confidentialite.md:15` | Textes légaux | RENOMMER | general | - **The data your organisation enters or receives in Brij-IA** (customers, employees, payslips, invoices, WhatsApp conversations with your customers, etc.): **your organi |
| `docs/securite/legal/en/01-politique-de-confidentialite.md:35` | Textes légaux | RENOMMER | general | Brij-IA's assistant sends to an **AI provider** (see document 07) the messages you write and, in order to answer accurately, a limited summary of **your** organisation's  |
| `docs/securite/legal/en/01-politique-de-confidentialite.md:36` | Textes légaux | RENOMMER | general | Brij-IA does not use your data to train models. The AI provider applies its own processing terms: [TO COMPLETE: recall the commitments of the selected provider]. |
| `docs/securite/legal/en/01-politique-de-confidentialite.md:41` | Textes légaux | RENOMMER | general | If your organisation links a messaging channel, its customers' messages pass through Brij-IA (and through Meta). Two modes exist: Meta's **official API**, and the **QR co |
| `docs/securite/legal/en/01-politique-de-confidentialite.md:63` | Textes légaux | RENOMMER | general | Brij-IA is intended for professionals and is not intended for persons under [TO COMPLETE: 18] years of age. |
| `docs/securite/legal/en/02-conditions-generales-utilisation.md:7` | Textes légaux | RENOMMER | general | Brij-IA is an online service (ERP and artificial intelligence sales agent) intended for businesses, shops, associations and teams: management of customers, stock, invoici |
| `docs/securite/legal/en/02-conditions-generales-utilisation.md:19` | Textes légaux | RENOMMER | general | The data you enter or receive in Brij-IA (customers, employees, invoices, messages) remains **yours**: you are responsible for its lawfulness and for informing the data s |
| `docs/securite/legal/en/02-conditions-generales-utilisation.md:39` | Textes légaux | RENOMMER | general | Brij-IA, its code, its texts and its trademarks remain our property. We grant you a personal, non-exclusive and non-transferable right to use the service for the duration |
| `docs/securite/legal/en/03-politique-cookies.md:7` | Textes légaux | RENOMMER | general | Brij-IA uses **no advertising cookies and no third-party trackers**. It uses only **strictly necessary** cookies and storage for operation, plus — **only if you accept it |
| `docs/securite/legal/en/04-mentions-legales.md:28` | Textes légaux | RENOMMER | general | The Brij-IA name, the logo, the code, the texts and the graphic elements are protected. Any unauthorised reproduction is prohibited. |
| `docs/securite/legal/en/05-registre-des-traitements.md:3` | Textes légaux | RENOMMER | general | *Version 2026-11-16 — record kept by Brij-IA as **data controller** (part A) and as **processor** on behalf of its customers (part B).* |
| `docs/securite/legal/en/05-registre-des-traitements.md:7` | Textes légaux | RENOMMER | general | ## A. Processing for which Brij-IA is the controller |
| `docs/securite/legal/en/05-registre-des-traitements.md:19` | Textes légaux | RENOMMER | general | ## B. Processing on behalf of organisations (Brij-IA = processor) |
| `docs/securite/legal/en/05-registre-des-traitements.md:21` | Textes légaux | RENOMMER | general | The organisation (controller) decides the purposes; Brij-IA provides the tool. Categories of data and data subjects: |
| `docs/securite/legal/en/06-accord-de-sous-traitance-modele.md:3` | Textes légaux | RENOMMER | general | *Version 2026-11-16 — template to be signed or accepted online between a customer organisation (the "Controller") and Brij-IA (the "Processor"). It forms part of the term |
| `docs/securite/legal/en/06-accord-de-sous-traitance-modele.md:5` | Textes légaux | RENOMMER | general | **Between** [TO COMPLETE: customer organisation, address, representative] **and** [TO COMPLETE: name of Brij-IA, address, representative]. |
| `docs/securite/legal/en/06-accord-de-sous-traitance-modele.md:8` | Textes légaux | RENOMMER | general | The Processor processes personal data on behalf of the Controller in order to provide the Brij-IA service. The agreement lasts as long as the service is provided. |
| `docs/securite/legal/en/07-sous-traitants-et-transferts.md:19` | Textes légaux | RENOMMER | general | **Services chosen by the organisation (not Brij-IA processors):** tools linked by webhook or API key (Zapier, Make, n8n, own server). The organisation is responsible for  |
| `docs/securite/legal/en/08-procedure-violation-donnees.md:21` | Textes légaux | RENOMMER | general | \| Information of the **customer organisations** whose data is concerned (Brij-IA as processor) \| **At the latest 72 h** after becoming aware, as soon as possible \| |
| `docs/securite/legal/en/08-procedure-violation-donnees.md:22` | Textes légaux | RENOMMER | general | \| Notification to the **data protection authority** (Brij-IA as controller) \| Within the time limit set by the applicable law [TO COMPLETE: exact time limit] and targeted |
| `docs/securite/legal/en/08-procedure-violation-donnees.md:39` | Textes légaux | RENOMMER | general | > **Subject: Security incident concerning your Brij-IA data** |
| `docs/securite/legal/en/09-politique-securite-information.md:3` | Textes légaux | RENOMMER | general | *Version 2026-11-16. This document describes what Brij-IA implements and verifies through automated tests; it does not constitute a certification. An independent penetrat |
| `docs/securite/legal/fr/01-politique-de-confidentialite.md:5` | Textes légaux | RENOMMER | general | Cette politique explique quelles données Brij-IA collecte, pourquoi, combien de temps nous les gardons, à qui elles sont confiées et comment exercer vos droits. Elle s'ap |
| `docs/securite/legal/fr/01-politique-de-confidentialite.md:9` | Textes légaux | RENOMMER | general | **Brij-IA** — [À COMPLÉTER : dénomination sociale, forme juridique, adresse du siège, RCCM, NIU]. |
| `docs/securite/legal/fr/01-politique-de-confidentialite.md:14` | Textes légaux | RENOMMER | general | - **Votre compte Brij-IA** (nom, contact, mot de passe, abonnement, journal de sécurité) : Brij-IA est **responsable du traitement**. |
| `docs/securite/legal/fr/01-politique-de-confidentialite.md:15` | Textes légaux | RENOMMER | general | - **Les données que votre organisation saisit ou reçoit dans Brij-IA** (clients, employés, fiches de paie, factures, conversations WhatsApp avec vos clients, etc.) : **vo |
| `docs/securite/legal/fr/01-politique-de-confidentialite.md:35` | Textes légaux | RENOMMER | ia-lassistant-fr | L'assistant de Brij-IA envoie à un **fournisseur d'IA** (voir document 07) les messages que vous écrivez et, pour répondre avec précision, un résumé limité des données de |
| `docs/securite/legal/fr/01-politique-de-confidentialite.md:36` | Textes légaux | RENOMMER | general | Brij-IA n'utilise pas vos données pour entraîner des modèles. Le fournisseur d'IA applique ses propres conditions de traitement : [À COMPLÉTER : rappeler les engagements  |
| `docs/securite/legal/fr/01-politique-de-confidentialite.md:41` | Textes légaux | RENOMMER | general | Si votre organisation relie un canal de messagerie, les messages de ses clients transitent par Brij-IA (et par Meta). Deux modes existent : l'**API officielle** de Meta,  |
| `docs/securite/legal/fr/01-politique-de-confidentialite.md:63` | Textes légaux | RENOMMER | general | Brij-IA s'adresse à des professionnels et n'est pas destiné aux personnes de moins de [À COMPLÉTER : 18] ans. |
| `docs/securite/legal/fr/02-conditions-generales-utilisation.md:7` | Textes légaux | RENOMMER | general | Brij-IA est un service en ligne (ERP et agent commercial par intelligence artificielle) destiné aux entreprises, commerces, associations et équipes : gestion des clients, |
| `docs/securite/legal/fr/02-conditions-generales-utilisation.md:19` | Textes légaux | RENOMMER | general | Les données que vous saisissez ou recevez dans Brij-IA (clients, employés, factures, messages) restent **les vôtres** : vous êtes responsable de leur licéité et d'informe |
| `docs/securite/legal/fr/02-conditions-generales-utilisation.md:39` | Textes légaux | RENOMMER | general | Brij-IA, son code, ses textes et ses marques restent notre propriété. Nous vous accordons un droit personnel, non exclusif et non transférable d'utiliser le service penda |
| `docs/securite/legal/fr/03-politique-cookies.md:7` | Textes légaux | RENOMMER | general | Brij-IA n'utilise **aucun cookie publicitaire et aucun pisteur tiers**. Il n'utilise que des cookies et stockages **strictement nécessaires** au fonctionnement, plus — ** |
| `docs/securite/legal/fr/04-mentions-legales.md:28` | Textes légaux | RENOMMER | general | Le nom Brij-IA, le logo, le code, les textes et les éléments graphiques sont protégés. Toute reproduction non autorisée est interdite. |
| `docs/securite/legal/fr/05-registre-des-traitements.md:3` | Textes légaux | RENOMMER | general | *Version 2026-11-16 — registre tenu par Brij-IA en tant que **responsable de traitement** (partie A) et en tant que **sous-traitant** pour le compte de ses clients (parti |
| `docs/securite/legal/fr/05-registre-des-traitements.md:7` | Textes légaux | RENOMMER | general | ## A. Traitements dont Brij-IA est responsable |
| `docs/securite/legal/fr/05-registre-des-traitements.md:19` | Textes légaux | RENOMMER | general | ## B. Traitements pour le compte des organisations (Brij-IA = sous-traitant) |
| `docs/securite/legal/fr/05-registre-des-traitements.md:21` | Textes légaux | RENOMMER | general | L'organisation (responsable) décide des finalités ; Brij-IA fournit l'outil. Catégories de données et personnes concernées : |
| `docs/securite/legal/fr/06-accord-de-sous-traitance-modele.md:3` | Textes légaux | RENOMMER | general | *Version 2026-11-16 — modèle à signer ou à accepter en ligne entre une organisation cliente (le « Responsable ») et Brij-IA (le « Sous-traitant »). Il fait partie des con |
| `docs/securite/legal/fr/06-accord-de-sous-traitance-modele.md:5` | Textes légaux | RENOMMER | general | **Entre** [À COMPLÉTER : organisation cliente, adresse, représentant] **et** [À COMPLÉTER : dénomination de Brij-IA, adresse, représentant]. |
| `docs/securite/legal/fr/06-accord-de-sous-traitance-modele.md:8` | Textes légaux | RENOMMER | general | Le Sous-traitant traite des données à caractère personnel pour le compte du Responsable afin de fournir le service Brij-IA. L'accord dure aussi longtemps que le service e |
| `docs/securite/legal/fr/07-sous-traitants-et-transferts.md:19` | Textes légaux | RENOMMER | general | **Services choisis par l'organisation (non sous-traitants de Brij-IA) :** outils reliés par webhook ou clé d'API (Zapier, Make, n8n, serveur propre). L'organisation en es |
| `docs/securite/legal/fr/08-procedure-violation-donnees.md:21` | Textes légaux | RENOMMER | general | \| Information des **organisations clientes** dont les données sont concernées (Brij-IA sous-traitant) \| **Au plus tard 72 h** après la connaissance, dès que possible \| |
| `docs/securite/legal/fr/08-procedure-violation-donnees.md:22` | Textes légaux | RENOMMER | general | \| Notification à l'**autorité de protection des données** (Brij-IA responsable) \| Dans le délai fixé par la loi applicable [À COMPLÉTER : délai exact] et visé à **72 h**  |
| `docs/securite/legal/fr/08-procedure-violation-donnees.md:39` | Textes légaux | RENOMMER | general | > **Objet : Incident de sécurité concernant vos données Brij-IA** |
| `docs/securite/legal/fr/09-politique-securite-information.md:3` | Textes légaux | RENOMMER | general | *Version 2026-11-16. Ce document décrit ce que Brij-IA met en œuvre et vérifie par des tests automatiques ; il ne constitue pas une certification. Un test d'intrusion ind |
| `docs/transport-geo.md:133` | Documentation | RENOMMER | general | Chaque entreprise ayant un compte Brij-IA peut **partager volontairement** la position de son siège avec l'administration de la plateforme (statistiques par pays et par v |
| `knowledge/site/faq.md:3` | Invites et connaissances de l'IA | RENOMMER | general | **C'est quoi Brij-IA ?** Une plateforme camerounaise où une intelligence artificielle vous aide à gérer votre activité : service client, projets, budget, stock et achats, |
| `knowledge/site/faq.md:14` | Invites et connaissances de l'IA | RENOMMER | general | **Qui est derrière Brij-IA ?** Brij-IA a été créé par son fondateur, **Tenda Steve Brandon**. Ne donne rien de plus sur sa biographie, son adresse ou le statut juridique  |
| `knowledge/site/faq.md:15` | Invites et connaissances de l'IA | RENOMMER | general | **Êtes-vous une vraie entreprise ? Où êtes-vous ?** Brij-IA est une plateforme camerounaise, créée par Tenda Steve Brandon. N'invente ni adresse ni statut ; pour plus d'i |
| `knowledge/site/fonctions-recentes.md:3` | Invites et connaissances de l'IA | RENOMMER | general | **Profil de l'entreprise** (Tableau de bord, carte « Faisons connaissance ») : l'application pose une question à la fois, avec des boutons (activité, nombre de sites, équ |
| `knowledge/site/fonctions-recentes.md:13` | Invites et connaissances de l'IA | RENOMMER | general | **Documents PDF et partage** : Brij-IA fabrique des PDF côté serveur pour une facture, un devis ou un avoir (Clients et ventes > « Télécharger le PDF » ou « Partager à l' |
| `knowledge/site/fonctions-recentes.md:14` | Invites et connaissances de l'IA | RENOMMER | general | **Partager à l'équipe** (responsables et plus) : choisir un poste (ex. tous les Menuisiers), une antenne, un rôle ou des personnes. Un aperçu indique combien de personnes |
| `knowledge/site/fonctions-recentes.md:15` | Invites et connaissances de l'IA | RENOMMER | general | **Bulletins de paie** (administrateurs) : « Envoyer les bulletins à chaque salarié » envoie à chacun seulement son bulletin validé du mois. Sont signalés et non envoyés : |
| `knowledge/site/fonctions-recentes.md:32` | Invites et connaissances de l'IA | RENOMMER | general | **Journal du Suivi de l'IA** : qui a exclu, levé, validé, modifié ou refusé quoi, quand et pour combien de temps. Il reste dans l'organisation : l'administration de la pl |
| `knowledge/site/mission.md:1` | Invites et connaissances de l'IA | RENOMMER | general | # Ce qu'est Brij-IA (vision du fondateur) |
| `knowledge/site/mission.md:3` | Invites et connaissances de l'IA | RENOMMER | general | Brij-IA est une intelligence artificielle pensée pour devenir le cerveau opérationnel et stratégique d'une entreprise : elle observe, comprend, analyse, prévoit, recomman |
| `knowledge/site/mission.md:11` | Invites et connaissances de l'IA | RENOMMER | general | Fondateur : Tenda Steve Brandon. Tu peux le citer quand on demande qui est derrière Brij-IA, sans rien inventer d'autre à son sujet. |
| `knowledge/site/mode-emploi.md:18` | Invites et connaissances de l'IA | RENOMMER | general | **Relances WhatsApp** (onglet Relances de l'assistant commercial) : après 24 h, WhatsApp n'autorise que des modèles de messages approuvés par Meta. L'administrateur enreg |
| `knowledge/site/ton-et-regles.md:8` | Invites et connaissances de l'IA | RENOMMER | general | - **Honnêteté d'abord** : n'invente ni prix, ni fonctionnalité, ni délai de Brij-IA. Si tu ne sais pas : « Je ne peux pas le confirmer, l'équipe vous répond » et donne le |
| `knowledge/site/ton-et-regles.md:12` | Invites et connaissances de l'IA | RENOMMER | general | - **Sujets** : tu es spécialisé dans Brij-IA et la gestion d'activité. Pour un sujet hors sujet, réponds brièvement puis recentre. Pour le juridique ou le fiscal : donne  |
| `knowledge/workspace/general-limites.md:4` | Invites et connaissances de l'IA | RENOMMER | general | - **Capacités réelles** : n'affirme jamais une capacité que l'application n'a pas (commande passée automatiquement sans validation, envoi automatique de messages aux clie |
| `knowledge/workspace/general-limites.md:6` | Invites et connaissances de l'IA | RENOMMER | general | - **Prix, délais, fonctionnalités inconnus** : pour l'activité de l'utilisateur (délai de livraison, temps pour ouvrir une boutique…), tu peux donner une estimation signa |
| `knowledge/workspace/mission-vision.md:1` | Invites et connaissances de l'IA | RENOMMER | general | # Mission et vision de Brij-IA (source : le fondateur) |
| `knowledge/workspace/mission-vision.md:6` | Invites et connaissances de l'IA | RENOMMER | general | Brij-IA est une intelligence artificielle destinée à devenir le cerveau opérationnel et stratégique d'une entreprise. Elle ne se limite pas à répondre à des questions : e |
| `knowledge/workspace/mission-vision.md:19` | Invites et connaissances de l'IA | RENOMMER | general | Brij-IA ne doit pas attendre les questions : elle surveille en continu et alerte. Exemples : « Le stock de ce produit risque d'être épuisé dans 9 jours. » « Trois projets |
| `knowledge/workspace/mission-vision.md:29` | Invites et connaissances de l'IA | RENOMMER | general | Brij-IA Central coordonne des agents spécialisés : RH, Finance, Comptabilité, Commercial, CRM, Marketing, Achats, Stock, Logistique, Production, Projets, Chantier, Mainte |
| `knowledge/workspace/mission-vision.md:34` | Invites et connaissances de l'IA | RENOMMER | general | ## Tableau de bord intelligent (Brij-IA CENTER) |
| `knowledge/workspace/mission-vision.md:50` | Invites et connaissances de l'IA | RENOMMER | general | - Fondateur de Brij-IA : Tenda Steve Brandon. |
| `package.json:4` | Autre code et configuration | RENOMMER | general | "description": "Serveur (API) de Brij-IA : comptes, abonnements et paiements, espace de travail (stock, clients, RH, comptabilité), assistant IA, WhatsApp / Messenger / I |
| `scripts/backup-decrypt.js:11` | Tests, scripts et démonstrations | RENOMMER | general | if (raw.subarray(0, 6).toString() !== 'MIABK1') { console.error("Ce fichier n'est pas une sauvegarde chiffrée Brij-IA."); process.exit(1); } |
| `scripts/demo-local.js:8` | Tests, scripts et démonstrations | CONSERVER | conservé:mot-de-passe-demo | const PASS = 'Essai-2026-brij'; |
| `scripts/demo-wa-portee.js:6` | Tests, scripts et démonstrations | CONSERVER | conservé:mot-de-passe-demo | const PASS = 'Essai-2026-brij'; |
| `scripts/demo/finance-acc.js:171` | Tests, scripts et démonstrations | RENOMMER | general | // Salaires avant la mise en place de la paie dans Brij-IA : saisie guidée |
| `scripts/demo/finance-acc.js:172` | Tests, scripts et démonstrations | RENOMMER | general | if (opts.salary === 'template') await tpl(h, 'Salaires ${ym} (saisie guidée, avant la paie Brij-IA)', 'salary_bank', h.on(ym, 28), 2950000, { options: { charges: 545000 } |
| `scripts/demo/finance-hr.js:43` | Tests, scripts et démonstrations | RENOMMER | general | E[k] = ex ? ex.id : (await hrDo('RH : embaucher ${name} (${job})${m && m.userId ? ' — relié à son compte' : ' — sans compte Brij-IA'}', 'POST', '/employees', body, { as:  |
| `scripts/demo/index.js:2` | Tests, scripts et démonstrations | RENOMMER | general | // Démonstration complète de Brij-IA : crée l'entreprise « Batimat Afrique SARL » et utilise toutes les fonctions du site (sauf l'assistant WhatsApp). |
| `scripts/demo/lib.js:2` | Tests, scripts et démonstrations | RENOMMER | general | // Démonstration Brij-IA — socle commun : connexion au serveur (local jetable ou en ligne), comptes de l'équipe, journal des fonctions utilisées. |
| `scripts/demo/seed.js:466` | Tests, scripts et démonstrations | RENOMMER | general | await post('/legal/privacy', { dataKind: 'Nom et téléphone des clientes', people: 'Clientes et prospects', storedWhere: 'Fichier clients de Brij-IA', purpose: 'Suivi des  |
| `scripts/demo/seed.js:488` | Tests, scripts et démonstrations | RENOMMER | general | await post('/structure/processes', { title: 'Prise de commande sur mesure', category: 'Ventes', steps: ['Accueillir la cliente et écouter son besoin', 'Prendre les mesure |
| `scripts/demo/work-legal.js:62` | Tests, scripts et démonstrations | RENOMMER | general | for (const b of [{ dataKind: 'Nom, téléphone et adresse de chantier des clients', people: 'Clients', storedWhere: 'Brij-IA (Clients et ventes)', purpose: 'Livrer, facture |
| `scripts/demo/work-legal.js:63` | Tests, scripts et démonstrations | RENOMMER | general | { dataKind: 'Dossier du personnel (CNI, contrat, salaire, CNPS)', people: 'Employés', storedWhere: 'Brij-IA (RH, paie) et classeur RH', purpose: 'Gestion du personnel et  |
| `scripts/demo/work-org.js:64` | Tests, scripts et démonstrations | RENOMMER | general | await proc('reception', { title: "Réception d'une livraison fournisseur", category: 'Stock', ownerId: U('storekeeper'), reviewMonths: 12, steps: ['Vérifier le bon de comm |
| `scripts/demo/work-org.js:99` | Tests, scripts et démonstrations | RENOMMER | general | const up1 = await ctx.do('Mémoire : compléter une entrée (nouvelle version)', 'PUT', '/memory/${memIds[1]}', { content: "L'usine de Bonabéri a arrêté une ligne pour maint |
| `scripts/demo/work-projects.js:22` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet-cle, general | await mk('brij', { name: 'Déploiement de Brij-IA et inventaire tournant', description: 'Former les équipes, paramétrer les seuils de réapprovisionnement et faire un inven |
| `scripts/demo/work-projects.js:66` | Tests, scripts et démonstrations | RENOMMER | general | // Brij-IA : projet en retard et au-delà de son budget |
| `scripts/demo/work-projects.js:67` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | await task('formation', P.brij, { title: "Formation de l'équipe (ventes, stock, caisse)", assigneeId: U('manager'), due: ctx.day(-40), status: 'done' }); |
| `scripts/demo/work-projects.js:68` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | await task('seuils', P.brij, { title: 'Paramétrage des seuils de réapprovisionnement', assigneeId: U('storekeeper'), due: ctx.day(-30), status: 'done' }); |
| `scripts/demo/work-projects.js:69` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | await task('invA', P.brij, { title: 'Inventaire tournant — dépôt de Douala (allées A à F)', assigneeId: U('storekeeper'), due: ctx.day(-18), status: 'done' }); |
| `scripts/demo/work-projects.js:70` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | await task('invB', P.brij, { title: 'Inventaire tournant — dépôt de Yaoundé', assigneeId: U('storekeeper'), due: ctx.day(-6), status: 'doing', priority: 'high' }); |
| `scripts/demo/work-projects.js:71` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | await task('hebdo', P.brij, { title: 'Comptage hebdomadaire des sacs de ciment', assigneeId: U('storekeeper'), due: ctx.day(-1) }); |
| `scripts/demo/work-projects.js:127` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | await ms(P.brij, 'Inventaire des deux dépôts terminé', ctx.day(-6)); |
| `scripts/demo/work-projects.js:135` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet, general | await budget(P.showroom, 15000000, 'showroom'); await budget(P.ecole, 3500000, 'école de Kotto'); await budget(P.brij, 1200000, 'Brij-IA'); await budget(P.foire, 2200000, |
| `scripts/demo/work-projects.js:145` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | await cost(P.brij, 'Formation sur site (2 jours)', 450000, -42); |
| `scripts/demo/work-projects.js:146` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | await cost(P.brij, 'Deux tablettes et lecteurs de codes-barres', 760000, -35); |
| `scripts/demo/work-projects.js:198` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet, general | const occ = ((await ctx.do('Tâches : tâches du projet Brij-IA', 'GET', '/projects/tasks?project=${P.brij}', undefined, { as: 'manager' })).tasks \|\| []).filter((t) => t.ti |
| `scripts/demo/work-projects.js:218` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet, general | const sb = await ctx.do('Projets : résumé du projet Brij-IA', 'GET', '/projects/${P.brij}/summary', undefined, { as: 'manager' }); |
| `scripts/demo/work-projects.js:219` | Tests, scripts et démonstrations | RENOMMER | general | ctx.check('Budget : le projet Brij-IA est au-delà de son budget', sb.cost && sb.cost.overBudget === true, sb.cost); |
| `scripts/demo/work-projects.js:245` | Tests, scripts et démonstrations | RENOMMER | id-demo-projet | const s3 = !team ? {} : await ctx.do('Partage : envoi par erreur', 'POST', '/share/send', { kind: 'project', sourceId: P.brij, roles: ['admin'] }, { as: 'manager' }); |
| `scripts/eval-ai.js:43` | Tests, scripts et démonstrations | RENOMMER | general | const siteSystem = () => { const extra = knowledge.load('site'); return claude.SITE_PROMPT + (extra ? '\n\nConnaissances supplémentaires fournies par Brij-IA :\n${extra}' |
| `scripts/eval-ai.js:79` | Tests, scripts et démonstrations | RENOMMER | general | let md = '# Essai des IA Brij-IA — ${new Date().toLocaleString('fr-FR')}\n\nModèle : ${config.ai.model}\n\n**Résultat : ${results.length - bad.length} réponses conformes  |
| `scripts/eval-scenarios.json:4` | Tests, scripts et démonstrations | RENOMMER | general | "q": "C'est quoi Brij-IA ?", |
| `scripts/eval-scenarios.json:57` | Tests, scripts et démonstrations | RENOMMER | ia-lassistant-fr | "Tu es l'assistant de Brij-IA, une plateforme camerounaise" |
| `scripts/eval-scenarios.json:90` | Tests, scripts et démonstrations | RENOMMER | general | "gestion\|Brij-IA\|activité" |
| `scripts/eval-scenarios.json:181` | Tests, scripts et démonstrations | RENOMMER | general | "q": "Qui a créé Brij-IA ?", |
| `scripts/eval-scenarios.json:193` | Tests, scripts et démonstrations | RENOMMER | general | "q": "Est-ce que je peux faire mes factures avec Brij-IA ?", |
| `scripts/eval-scenarios.json:235` | Tests, scripts et démonstrations | RENOMMER | general | "q": "Après une pub, est-ce que Brij-IA peut répondre aux clients et prendre leurs commandes ?", |
| `scripts/eval-scenarios.json:247` | Tests, scripts et démonstrations | RENOMMER | general | "q": "Est-ce que Brij-IA peut répondre à mes clients sur mon WhatsApp ?", |
| `scripts/eval-scenarios.json:403` | Tests, scripts et démonstrations | RENOMMER | general | "<donnees>\|DONNÉES\\)\|Tu es l'IA de gestion de Brij-IA" |
| `scripts/mock-campay.js:10` | Tests, scripts et démonstrations | RENOMMER | general | // JWT HS256 fabriqué ici (le faux serveur ne dépend d'aucun code de Brij-IA : il se comporte comme Campay, indépendamment). |
| `scripts/mock-campay.js:109` | Tests, scripts et démonstrations | RENOMMER | general | console.log('Variables à donner au serveur Brij-IA :'); |
| `scripts/security-check.js:12` | Tests, scripts et démonstrations | RENOMMER | general | console.log('\nContrôle de sécurité Brij-IA\n'); |
| `scripts/smoke-fusion-ui.js:15` | Tests, scripts et démonstrations | CONSERVER | conservé:chemin-local | const PUPPETEER = process.env.PUPPETEER_CORE \|\| '/Users/macboockpro/Downloads/MANAGER-IA/video-brij-ia-problemes/node_modules/puppeteer-core'; |
| `scripts/smoke-fusion-ui.js:54` | Tests, scripts et démonstrations | CONSERVER | conservé:mot-de-passe-demo | const inputs = await p.$$('input'); await inputs[0].type('proprietaire@exemple.com'); await inputs[1].type('Essai-2026-brij'); |
| `scripts/smoke-rh-talents.js:22` | Tests, scripts et démonstrations | CONSERVER | conservé:mot-de-passe-demo | const PASS = 'Essai-2026-brij'; |
| `scripts/smoke-workspace.js:65` | Tests, scripts et démonstrations | RENOMMER | general | if (/\/subscribed_apps$/.test(req.url)) { (seen.subs = seen.subs \|\| []).push({ method: req.method, url: req.url, auth }); return res.end(req.method === 'POST' ? JSON.stri |
| `scripts/smoke-workspace.js:628` | Tests, scripts et démonstrations | RENOMMER | general | check('e-mail reçu : destinataire, objet sans injection d\'en-tête, signature, pièce jointe PNG', got && /^To: .*marie@exemple\.com/m.test(got) && !/^Bcc:/mi.test(got) && |
| `scripts/smoke-workspace.js:763` | Tests, scripts et démonstrations | RENOMMER | general | check('WhatsApp : abonnement de l\'application au compte (jeton envoyé, liste renvoyée)', r.status === 200 && r.json.subscribed === true && r.json.apps.includes('Brij-IA' |
| `scripts/smoke-workspace.js:819` | Tests, scripts et démonstrations | RENOMMER | general | check('un responsable écrit au client sur WhatsApp depuis Brij-IA', r.status === 200 && fake.seen.wa[6].to === '237611223344' && /responsable/.test(fake.seen.wa[6].body), |
| `scripts/smoke-workspace.js:1148` | Tests, scripts et démonstrations | RENOMMER | general | // L'IA se tait après passage à un humain, et un responsable répond depuis Brij-IA |
| `scripts/smoke-workspace.js:1157` | Tests, scripts et démonstrations | RENOMMER | general | check('un responsable répond sur Messenger depuis Brij-IA', r.status === 200 && fake.seen.ms[4].to === '5551001' && /responsable/.test(fake.seen.ms[4].text), [r.json, fak |
| `scripts/smoke-workspace.js:1244` | Tests, scripts et démonstrations | RENOMMER | general | check('un responsable envoie une photo sur Instagram depuis Brij-IA', r.status === 200 && fake.seen.ms.slice(vx_m6).some((x) => x.attachment && x.attachment.type === 'ima |
| `scripts/smoke.js:155` | Tests, scripts et démonstrations | RENOMMER (+ partie conservée) | paiement-regex-test, conservé:ancien-code-paiement | check('initiate manuel', r.status === 200 && pay.mode === 'manual' && pay.status === 'pending' && pay.amountXAF === 80000 && /^(MI-[A-Z0-9]{6}\|BRIJ-\d{6})$/.test(pay.refe |
| `scripts/smoke.js:218` | Tests, scripts et démonstrations | RENOMMER | general | check('page /admin servie', r.status === 200 && r.text.includes('Administration Brij-IA') && /content-security-policy/i.test([...r.headers.keys()].join(','))); |
| `scripts/smoke.js:220` | Tests, scripts et démonstrations | RENOMMER | general | check('/admin/admin.js servi', r.status === 200 && r.text.includes('Brij-IA')); |
| `scripts/test-admin-clients.js:32` | Tests, scripts et démonstrations | RENOMMER | general | BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: 'http://127.0.0.1:${mport}/v3', SMTP_FROM: 'Brij-IA <contact@exemple.com>', |
| `scripts/test-admin-live.js:157` | Tests, scripts et démonstrations | RENOMMER | general | return { env: { SIGNUP_VERIFY: 'on', BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: 'http://127.0.0.1:${port}/v3', SMTP_FROM: 'Brij-IA <contact@exemple.com>' }, mails, srv } |
| `scripts/test-commerce.js:368` | Tests, scripts et démonstrations | RENOMMER | general | r = await mgr('POST', '${J}/privacy', { dataKind: 'Nom et téléphone des clients', storedWhere: 'Brij-IA, carnet papier', purpose: 'Livrer et facturer', retention: '3 ans  |
| `scripts/test-config-prod.js:14` | Tests, scripts et démonstrations | RENOMMER | domaine-test | const good = { JWT_SECRET: 'j'.repeat(48), ADMIN_PASSWORD: 'MotDePasseSolide-2026', DATA_KEY: 'd'.repeat(48), ALLOWED_ORIGINS: 'https://brij-ia.example.com' }; |
| `scripts/test-config-prod.js:35` | Tests, scripts et démonstrations | RENOMMER | domaine-test | r = boot({ ...good, ALLOWED_ORIGINS: 'http://localhost:5173,https://brij-ia.example.com', STRICT_PROD_CONFIG: '1' }); |
| `scripts/test-custom-plan.js:77` | Tests, scripts et démonstrations | CONSERVER | conservé:mot-de-passe-demo | r = await web('POST', '/api/register', { name: 'Awa Sur Mesure', contact: mail, pass: 'Essai-2026-brij-x' }); |
| `scripts/test-digest-email.js:93` | Tests, scripts et démonstrations | RENOMMER | general | ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', TRUST_PROXY: '0', SIGNUP_VERIFY: 'off', SMTP_FROM: 'Brij-IA <noreply@manager-ia.test>', SITE_URL: |
| `scripts/test-digest-email.js:143` | Tests, scripts et démonstrations | RENOMMER | general | check('texte : salutation, impayés, tâches, « Ouvrez Brij-IA pour le détail », lien vers l\'application', /Bonjour Awa/.test(m1.textContent) && /Impayés : 1 facture/.test |
| `scripts/test-digest-email.js:173` | Tests, scripts et démonstrations | RENOMMER | general | check('alerte urgente envoyée par e-mail (rupture de stock, facture très en retard)', gotU && /Rupture de stock : Savon noir/.test(al.textContent) && /FA-9001 .* impayée  |
| `scripts/test-embedded.js:53` | Tests, scripts et démonstrations | RENOMMER | general | if ((m = /^\/(\d+)\/subscribed_apps$/.exec(p))) { seen.subs.push({ method: req.method, waba: m[1], auth }); return res.end(req.method === 'POST' ? JSON.stringify({ succes |
| `scripts/test-finance.js:228` | Tests, scripts et démonstrations | RENOMMER | general | check('mention honnête présente sur la liasse', /Document de travail préparé par Brij-IA, à faire valider par un expert-comptable avant tout dépôt officiel/.test(L.notice |
| `scripts/test-fusion-integration.js:43` | Tests, scripts et démonstrations | RENOMMER | general | check('export d\'organisation : 200 et format Brij-IA', r.status === 200 && ex.format, [r.status, ex.format]); |
| `scripts/test-mail-api.js:23` | Tests, scripts et démonstrations | RENOMMER | general | Object.assign(process.env, { BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: 'http://127.0.0.1:${port}/v3', SMTP_FROM: 'Brij-IA <contact@exemple.com>', SMTP_HOST: '', DATABAS |
| `scripts/test-mail-api.js:32` | Tests, scripts et démonstrations | RENOMMER | general | check('expéditeur repris de SMTP_FROM', r && r.body.sender.email === 'contact@exemple.com' && r.body.sender.name === 'Brij-IA', r && r.body.sender); |
| `scripts/test-meetings.js:258` | Tests, scripts et démonstrations | RENOMMER | general | return { a, s, env: { ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:${a.port}', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_FROM: 'B |
| `scripts/test-payment-campay.js:58` | Tests, scripts et démonstrations | RENOMMER | general | ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', ADMIN_EMAIL: 'fondateur@exemple.com', BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: 'http://127.0.0 |
| `scripts/test-payment-flow.js:34` | Tests, scripts et démonstrations | RENOMMER | general | BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: 'http://127.0.0.1:${mport}/v3', SMTP_FROM: 'Brij-IA <contact@exemple.com>' }); |
| `scripts/test-payment-manual.js:34` | Tests, scripts et démonstrations | RENOMMER | general | ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', ADMIN_EMAIL: 'fondateur@exemple.com', BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: 'http://127.0.0 |
| `scripts/test-payment-manual.js:73` | Tests, scripts et démonstrations | RENOMMER (+ partie conservée) | paiement-regex-test2, paiement-doc, conservé:ancien-code-paiement | check('commande « en attente » avec code BRIJ-NNNNNN, montant du catalogue (le prix du client est ignoré)', r.status === 200 && /^BRIJ-\d{6}$/.test(r.json.reference) && r |
| `scripts/test-prospects.js:29` | Tests, scripts et démonstrations | RENOMMER | domaine-test, general | Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'of |
| `scripts/test-security-privacy.js:26` | Tests, scripts et démonstrations | RENOMMER | id-export | check("export : JSON ouvert avec le profil, les consentements et les messages de la personne", r.status === 200 && j.format === 'brij-ia-export' && j.person.name === 'Pau |
| `src/ai/sales-agent.js:35` | Invites et connaissances de l'IA | RENOMMER | general | return k ? '${RULES}\n\nÉducation (fournie par Brij-IA) :\n${k}' : RULES; |
| `src/ai/workspace-prompts.js:5` | Invites et connaissances de l'IA | RENOMMER | prompt-gestion | const BASE = 'Tu es l'IA de gestion de Brij-IA : tu aides un responsable d'activité (entreprise, boutique, association, équipe) à mieux gérer son service client, ses proj |
| `src/jobs.js:26` | E-mails | RENOMMER | general | 'Votre offre Brij-IA expire bientôt', |
| `src/jobs.js:27` | E-mails | RENOMMER | general | 'Bonjour ${u.name},\n\nVotre offre ${require('./services/custom-plan').label(u.plan)} expire le ${fmtDate(u.plan_expires)}. Pour continuer sans interruption, pensez à la  |
| `src/routes/admin-security.js:42` | Autre code et configuration | RENOMMER | general | res.json({ secret, uri: central.totp.uri(config.admin.username \|\| 'admin', secret, 'Brij-IA Admin') }); |
| `src/routes/assistant.js:17` | Autre code et configuration | RENOMMER | general | let system = claude.SITE_PROMPT + (extra ? '\n\nConnaissances supplémentaires fournies par Brij-IA :\n${extra}' : ''); |
| `src/routes/auth.js:81` | E-mails | RENOMMER | general | subject: 'Votre code de vérification Brij-IA', |
| `src/routes/auth.js:82` | E-mails | RENOMMER | general | text: 'Bonjour ${name},\n\nVotre code de vérification : ${code}\n\nIl est valable 1 minute. Saisissez-le sur la page d'inscription pour terminer la création de votre comp |
| `src/routes/auth.js:256` | E-mails | RENOMMER | general | mailUser(row.contact, 'Réinitialisation de votre mot de passe - Brij-IA', 'Bonjour ${row.name},\n\nVous avez demandé à changer votre mot de passe. Ouvrez ce lien (valable |
| `src/routes/auth.js:295` | E-mails | RENOMMER | general | if (req.user.contact.includes('@')) mailUser(req.user.contact, 'Votre mot de passe Brij-IA a été modifié', 'Bonjour ${req.user.name},\n\nVotre mot de passe vient d'être m |
| `src/routes/contact.js:48` | Autre code et configuration | RENOMMER | general | '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brij-IA</title><body style="font-family:sy |
| `src/routes/payments.js:112` | Autre code et configuration | RENOMMER | paiement-prefixe | const code = 'BRIJ-' + String(crypto.randomInt(100000, 1000000)); |
| `src/routes/privacy.js:47` | Autre code et configuration | RENOMMER | id-export-fichier | res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="mes-donnees-brij-ia-${data.exportedAt.slice(0, 10)}.json"', 'Ca |
| `src/security/devices.js:28` | E-mails | RENOMMER | general | if (u && u.contact.includes('@')) require('../services/notify').mailUser(u.contact, 'Nouvelle connexion à votre compte Brij-IA', 'Bonjour ${u.name},\n\nUne connexion à vo |
| `src/security/index.js:2` | Autre code et configuration | RENOMMER | general | // Centre de sécurité : un seul point d'entrée pour tout ce qui protège Brij-IA. |
| `src/security/privacy.js:4` | Autre code et configuration | RENOMMER | general | // Brij-IA est responsable de traitement pour les comptes (users) et sous-traitant pour les données saisies par les organisations (clients, employés…) : |
| `src/security/privacy.js:66` | Autre code et configuration | RENOMMER | id-export | const out = { format: 'brij-ia-export', version: 1, exportedAt: nowISO(), person: u, tables: {}, notes: [ |
| `src/security/privacy.js:86` | Autre code et configuration | RENOMMER | id-export-org | const out = { format: 'brij-ia-org-export', version: 1, exportedAt: nowISO(), org, tables: {}, notes: ['Fichiers binaires (photos du catalogue, médias) et secrets non inc |
| `src/security/totp.js:36` | Autre code et configuration | RENOMMER | general | const uri = (label, secret, issuer = 'Brij-IA') => 'otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent |
| `src/server.js:153` | Autre code et configuration | RENOMMER | general | log.info('Brij-IA démarré sur le port ${config.port} (${config.isProd ? 'production' : 'développement'})'); |
| `src/services/accounts.js:104` | E-mails | RENOMMER | general | const MAIL_FOOTER = "\n\nL'équipe Brij-IA"; |
| `src/services/accounts.js:124` | E-mails | RENOMMER | general | if (isEmail(u.contact)) require('./notify').mailUser(u.contact, 'Votre compte Brij-IA est suspendu', 'Bonjour ${u.name},\n\nVotre compte Brij-IA a été suspendu.\nMotif :  |
| `src/services/accounts.js:137` | E-mails | RENOMMER | general | if (isEmail(u.contact)) require('./notify').mailUser(u.contact, 'Votre compte Brij-IA est de nouveau actif', 'Bonjour ${u.name},\n\nVotre compte Brij-IA est de nouveau ac |
| `src/services/campay-pay.js:81` | Autre code et configuration | RENOMMER | general | try { c = await client.collect({ amount, from: phone, externalReference: extRef, externalUser: String(user.id), description: 'Brij-IA ${custom.label(plan.name)} ${referen |
| `src/services/claude.js:7` | Invites et connaissances de l'IA | RENOMMER | prompt-site | const SITE_PROMPT = 'Tu es l'assistant de Brij-IA, une plateforme camerounaise de gestion d'activité assistée par l'IA. Tu réponds en français simple, de façon courte, cl |
| `src/services/claude.js:9` | Invites et connaissances de l'IA | RENOMMER | general | Ce que propose Brij-IA : |
| `src/services/claude.js:31` | Invites et connaissances de l'IA | RENOMMER | prompt-app | const APP_PROMPT = 'Tu aides un futur client de Brij-IA à préparer une application sur mesure. À partir de son activité et de son besoin, propose un plan d'application si |
| `src/services/claude.js:78` | Invites et connaissances de l'IA | RENOMMER (+ partie conservée) | url-prospects, general, conservé:url-technique | headers: { ...(c.authHeader ? { [c.authHeader]: c.key } : { authorization: 'Bearer ${c.key}' }), ...(/openrouter\.ai/.test(c.baseUrl) ? { 'HTTP-Referer': config.siteUrl \| |
| `src/services/feedback.js:177` | E-mails | RENOMMER | general | const subject = '[Brij-IA] Nouvel avis ${r.stars}/5 : ${oneLineClean(KIND_LABEL[r.kind] + ' · ' + moduleTitle(r.module), 90)}'; |
| `src/services/feedback.js:218` | E-mails | RENOMMER | general | try { await channels.get('email').send('[Brij-IA] Résumé des avis du ${yesterday} : ${d.count} avis', d.text); return true; } catch (e) { log.warn('Résumé quotidien des a |
| `src/services/notify.js:33` | E-mails | RENOMMER | general | const name = String(fromName \|\| (/^\s*"?([^"<]+?)"?\s*</.exec(config.smtp.from \|\| '') \|\| [])[1] \|\| 'Brij-IA').replace(/["<>\r\n]/g, '').slice(0, 80); |
| `src/services/notify.js:73` | E-mails | RENOMMER | general | const subject = '[Brij-IA] ${text}'.slice(0, 150); |
| `src/services/payments.js:23` | E-mails | RENOMMER | general | customer: { name: user.name, contact: user.contact }, durationDays: (planOf(p.plan) \|\| {}).days \|\| config.durationDays, issuer: config.payment.holder \|\| 'Brij-IA', test:  |
| `src/services/payments.js:82` | E-mails | RENOMMER | general | await sendMail({ to: r.user.contact, subject: '${Number(r.payment.test_mode) ? '[TEST] ' : ''}Votre offre ${r.planLabel} est active - Brij-IA', text: 'Bonjour ${r.user.na |
| `src/services/payments.js:83` | E-mails | RENOMMER | general | 'Votre offre ${r.planLabel} est active jusqu'au ${fmtDate(r.expires)}.\n\nMerci pour votre confiance.\nL'équipe Brij-IA\n\nVotre reçu ${receipt.number} est joint à ce mes |
| `src/services/payments.js:114` | E-mails | RENOMMER | general | await sendMail({ to: user.contact, subject: 'Votre paiement ${p.reference} n'a pas pu être validé - Brij-IA', text: 'Bonjour ${user.name},\n\nNous n'avons pas pu valider  |
| `src/services/payments.js:115` | E-mails | RENOMMER | general | 'Aucune offre n'a été activée. Vous pouvez refaire un paiement depuis « Abonnement », ou nous écrire sur WhatsApp (+237 653 62 13 88) en indiquant la référence ${p.refere |
| `src/services/pdf.js:22` | PDF et documents imprimables | RENOMMER | general | const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, compress: options.compress !== false, info: { Title: clean(spec.title).slice(0, 120), Author: cle |
| `src/services/pdf.js:59` | PDF et documents imprimables | RENOMMER | general | doc.text(clean('${spec.org \|\| ''} · Brij-IA'), L, y, { width: W / 2, lineBreak: false }); |
| `src/services/prospects.js:13` | E-mails | RENOMMER (+ partie conservée) | url-prospects, conservé:url-technique | const siteUrl = () => (config.siteUrl \|\| 'https://brij-ia.vercel.app').replace(/\/+$/, ''); |
| `src/services/prospects.js:28` | E-mails | RENOMMER | general | (n) => ({ subject: 'Brij-IA : bien démarrer en 5 minutes', text: 'Bonjour ${n},\n\nMerci de l'intérêt que vous portez à Brij-IA. Pour essayer sans rien payer :\n\n1. Crée |
| `src/services/prospects.js:29` | E-mails | RENOMMER | general | (n) => ({ subject: 'Brij-IA : ce que vous pouvez faire dès aujourd\'hui', text: 'Bonjour ${n},\n\nQuelques exemples de ce que Brij-IA prend en charge pour une petite entr |
| `src/services/prospects.js:30` | E-mails | RENOMMER | general | (n) => ({ subject: 'Brij-IA : on vous aide à démarrer ?', text: 'Bonjour ${n},\n\nSi vous n'avez pas encore eu le temps d'essayer Brij-IA, nous pouvons le faire ensemble  |
| `src/services/prospects.js:33` | E-mails | RENOMMER | general | const unsubText = (token) => '\n\n—\nVous recevez ce message car vous avez demandé à être contacté(e) par Brij-IA. Pour ne plus recevoir nos e-mails : ${apiUrl()}/api/uns |
| `src/services/security.js:14` | Autre code et configuration | RENOMMER (+ partie conservée) | mdp-communs, conservé:mots-de-passe-faibles | 'letmein iloveyou jetaime chocolat doudou princesse cheri cherie camerounais cameroun cameroon douala yaounde bafoussam garoua bamenda limbe kribi lions lionsindomptables |
| `src/services/security.js:16` | Autre code et configuration | CONSERVER | conservé:mots-de-passe-faibles | const COMMON = new Set(['12345678', '123456789', '1234567890', '0123456789', '987654321', '87654321', 'password', 'password1', 'password123', 'motdepasse', 'motdepasse1', |
| `src/services/vault.js:11` | Autre code et configuration | CONSERVER | conservé:sel-chiffrement | const SALT = { v1: 'manager-ia-vault-v1', v2: 'brij-ia-fields-v2' }; |
| `src/services/waWeb.js:141` | WhatsApp / canaux | RENOMMER | general | browser: l.Browsers && l.Browsers.ubuntu ? l.Browsers.ubuntu('Chrome') : ['Brij-IA', 'Chrome', '1.0'] }; |
| `src/services/webhooks.js:2` | Autre code et configuration | RENOMMER | general | // Webhooks sortants : Brij-IA prévient un outil externe (Zapier, Make, n8n, votre propre serveur) quand quelque chose arrive. |
| `src/workspace/adm-report.js:157` | PDF et documents imprimables | RENOMMER | general | const buf = await require('../services/pdf').render({ title: 'Rapport administratif mensuel', subtitle: r.month, org: r.org, blocks, footer: 'Généré par Brij-IA le ' + r. |
| `src/workspace/ai.js:151` | Autre code et configuration | RENOMMER | general | const waLine = 'CONNEXION WHATSAPP (état seulement, jamais de valeurs secrètes) : identifiant du numéro ${org.wa_phone_id ? 'enregistré' : 'manquant'}, jeton ${org.wa_tok |
| `src/workspace/ai.js:189` | Autre code et configuration | RENOMMER | general | stable: [P.BASE, P.MODULE[module] \|\| extPrompt(module), extra \|\| '', k ? 'Connaissances de référence (fournies par Brij-IA) :\n${k}' : ''].filter(Boolean).join('\n\n'), |
| `src/workspace/crm.js:405` | E-mails | RENOMMER | general | try { await sendMail({ to: cu.email, subject, text: '${body}\n\n—\n${req.org.name}\nMessage envoyé avec Brij-IA', replyTo, fromName: req.org.name, attachments: [{ filenam |
| `src/workspace/digest.js:75` | E-mails | RENOMMER | general | return { text: '${head}\n${body}\nOuvrez Brij-IA pour le détail. Pour ne plus recevoir ce message : Alertes > Résumé du matin.'.slice(0, 1500), empty: !lines.length, head |
| `src/workspace/digest.js:95` | E-mails | RENOMMER | general | const composeUrgent = (org, events) => 'Alerte urgente — ${org.name}\n${urgentLines(events).map((l) => '- ${l}').join('\n')}\nOuvrez Brij-IA pour agir.'.slice(0, 1500); |
| `src/workspace/digest.js:107` | E-mails | RENOMMER | general | const open = app ? 'Ouvrez Brij-IA pour le détail : ${app}' : 'Ouvrez Brij-IA pour le détail.'; |
| `src/workspace/digest.js:108` | E-mails | RENOMMER | general | const stop = link ? 'Pour ne plus recevoir ces e-mails, cliquez ici : ${link}' : 'Pour ne plus recevoir ces e-mails : ouvrez Brij-IA > Alertes > « Résumé du matin et aler |
| `src/workspace/digest.js:112` | E-mails | RENOMMER | general | + '<p>${app ? '<a href="${esc(app)}">Ouvrez Brij-IA pour le détail</a>' : 'Ouvrez Brij-IA pour le détail.'}</p>' |
| `src/workspace/digest.js:315` | E-mails | RENOMMER | general | return page('<h1 style="font-size:20px">C'est fait</h1><p>Vous ne recevrez plus le résumé du matin ni les alertes de ${esc(row.org)}. Vous pouvez vous réabonner à tout mo |
| `src/workspace/fiscal.js:14` | PDF et documents imprimables | RENOMMER | general | const NOTICE = "Document de travail préparé par Brij-IA, à faire valider par un expert-comptable avant tout dépôt officiel."; |
| `src/workspace/fiscal.js:257` | PDF et documents imprimables | RENOMMER | general | if (prior !== 0) add('info', 'carry-result', 'Le bilan cumule les écritures depuis l'ouverture et affiche ${prior.toLocaleString('fr-FR')} de résultat des exercices précé |
| `src/workspace/fiscal.js:274` | PDF et documents imprimables | RENOMMER | general | 'Cette clôture est un verrou interne de Brij-IA : elle ne remplace ni la clôture légale ni la validation par votre expert-comptable.', |
| `src/workspace/integrations.js:2` | Autre code et configuration | RENOMMER | general | // Sous-application « Intégrations » (administrateurs) : clés d'API et webhooks sortants pour relier Brij-IA à Zapier, Make, n8n, un site web, etc. |
| `src/workspace/integrations.js:47` | Autre code et configuration | RENOMMER | general | res.status(201).json({ id: Number(id), secret, note: "Conservez ce secret : il sert à vérifier que les messages viennent bien de Brij-IA (en-tête X-MIA-Signature). Il ne  |
| `src/workspace/integrations.js:75` | Autre code et configuration | RENOMMER | general | const r = await wh.deliver(h, 'test', { message: 'Test depuis Brij-IA', organisation: req.org.name }); |
| `src/workspace/invoice-doc.js:75` | PDF et documents imprimables | RENOMMER | general | <div class="wd">Document de travail généré par Brij-IA : à faire valider par votre expert-comptable avant tout usage légal ou fiscal.</div></body></html>'; |
| `src/workspace/legal-extra.js:163` | Autre code et configuration | RENOMMER | general | if (String(req.params.id).startsWith('b:')) throw new HttpError(403, 'Ce modèle est fourni par Brij-IA : dupliquez-le pour en faire votre propre version.'); |
| `src/workspace/legal-library.js:2` | Autre code et configuration | RENOMMER | general | // Bibliothèque fournie par Brij-IA pour le module Juridique : modèles de documents, exemples d'obligations et de lignes du registre des données. |
| `src/workspace/mail.js:85` | E-mails | RENOMMER | general | const text = '${body}\n\n—\n${req.org.name}\nMessage envoyé avec Brij-IA'; |
| `src/workspace/meetings-lib.js:265` | Autre code et configuration | RENOMMER | general | const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brij-IA//Reunions//FR', 'CALSCALE:GREGORIAN', 'METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}']; |
| `src/workspace/meetings-lib.js:269` | Autre code et configuration | CONSERVER | conservé:uid-calendrier | lines.push('BEGIN:VEVENT', 'UID:mtg-${m.id}-${org.id}@brij-ia', 'DTSTAMP:${icsDate(Date.now())}', 'DTSTART:${icsDate(s)}', 'DTEND:${icsDate(s + Number(m.duration_min) * 6 |
| `src/workspace/meetings.js:415` | Autre code et configuration | RENOMMER | general | lines.push('', 'Merci de confirmer votre présence en répondant à ce message (ou dans Brij-IA, rubrique Réunions).'); |
| `src/workspace/org-geo.js:20` | Autre code et configuration | RENOMMER | general | if (b.consent !== true) throw new HttpError(400, 'Cochez la case pour accepter de partager la position de votre entreprise avec Brij-IA.'); |
| `src/workspace/org-geo.js:27` | Autre code et configuration | RENOMMER | general | await A.logActivity(req.org.id, req.user.id, 'team', 'Position de l\'entreprise partagée avec Brij-IA'); |
| `src/workspace/profile-questions.js:18` | Autre code et configuration | RENOMMER | general | { id: 'goal', tier: 'later', ask: 'Qu\'attendez-vous d\'abord de Brij-IA ?', type: 'one', options: [['sell', 'Vendre davantage'], ['track', 'Mieux suivre mon activité'],  |
| `src/workspace/relay.js:67` | WhatsApp / canaux | RENOMMER | general | const head = st ? 'Brij-IA · ${HK.titleOf(st)} (${org.name})' : 'Brij-IA : une conversation attend un conseiller (${org.name}).'; |
| `src/workspace/relay.js:109` | WhatsApp / canaux | RENOMMER | general | const r = await sendWhatsApp(org, contacts, 'Brij-IA (${org.name}) : plusieurs conversations attendent un conseiller. Ouvrez Assistant commercial > Conversations.${link(o |
| `src/workspace/relay.js:173` | WhatsApp / canaux | RENOMMER | general | const text = 'Brij-IA (${req.org.name}) : ceci est un TEST du passage de relais. Si vous le lisez, les alertes de conversations à reprendre arriveront ici.'; |
| `src/workspace/sales-appt.js:112` | Autre code et configuration | RENOMMER | general | 'DESCRIPTION:${icsEsc([a.customer && 'Client : ${a.customer}', a.phone && 'Téléphone : ${a.phone}', a.channel && 'Canal : ${a.channel}', a.note, 'Géré avec Brij-IA'].filt |
| `src/workspace/sales-appt.js:121` | Autre code et configuration | RENOMMER | general | return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brij-IA//Rendez-vous//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:${icsEsc('Rendez-vous - ${org.name}' |
| `src/workspace/sales-appt.js:138` | Autre code et configuration | RENOMMER | general | res.send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brij-IA//Rendez-vous//FR', icsEvent(req.org, a), 'END:VCALENDAR'].join('\r\n') + '\r\n'); |
| `src/workspace/sales-assign.js:57` | E-mails | RENOMMER | general | 'Bonjour ${who.name},\n\nUne conversation client vous a été attribuée dans Brij-IA (${org.name}).\nClient : ${cu ? '${cu.name} ${cu.phone \|\| ''}' : 'visiteur ${chat.conta |
| `src/workspace/share.js:158` | E-mails | RENOMMER | general | for (const uid of aud.ids) await W.push(req.org.id, uid, 'document', '${req.user.name} vous a partagé « ${oneLine(built.title, 80)} ».${message ? ' ' + oneLine(message, 1 |
| `src/workspace/share.js:176` | E-mails | RENOMMER | general | if (!mem) { skip("pas de compte Brij-IA lié à ce salarié : téléchargez le PDF pour le lui remettre"); continue; } |
| `src/workspace/share.js:182` | E-mails | RENOMMER | general | await W.push(req.org.id, uid, 'document', 'Votre bulletin de paie de ${s.month} est disponible. Ouvrez Brij-IA > Tableau de bord > Documents reçus.', 'share:' + id); |
| `src/workspace/w3.js:58` | E-mails | RENOMMER | general | if (u) require('../services/notify').mailUser(u.contact, 'Brij-IA : ' + oneLine(text, 80), text); |
| `src/workspace/wms-hu.js:271` | PDF et documents imprimables | RENOMMER | general | const doc = new PDFDocument({ size: [W2, H2], margin: 14, info: { Title: code, Creator: 'Brij-IA' } }); |
