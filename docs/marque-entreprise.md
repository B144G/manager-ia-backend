# Marque de l'entreprise : personnaliser son compte

Chaque entreprise cliente peut remplacer « Brij-IA » par son propre nom, nommer son assistant IA, mettre son logo, sa couleur, ses textes, et régler le menu, le tableau de bord et quelques mots clés. **Tant qu'une entreprise n'a rien personnalisé, rien ne change** : les valeurs par défaut reproduisent exactement l'affichage d'avant (vérifié par des tests).

Branches : serveur `marque-entreprise` (clone `marque/serveur`, base `4e438d2`), site `marque-entreprise` (clone `marque/site`, base `09457ee`). Migrations **200 et 201**.

---

## 1. Audit : où la marque apparaît, et ce qui est personnalisable

Légende : **Appliqué** = suit la marque de l'entreprise · **Plateforme** = reste « Brij-IA » volontairement (compte, facturation, conformité, marketing de la plateforme) · **Autre session** = à faire à la fusion.

### Application (site)

| Endroit | Fichier | État |
|---|---|---|
| Logo et nom du menu latéral | `src/ws/shell/Frame.jsx` (`BrandMark`, `Sidebar`) | Appliqué (logo, nom ; à défaut logo local de l'appareil, puis logo d'origine) |
| Barre de recherche « Demandez à Brij-IA… », bouton « Assistant IA », « Point de situation de Brij-IA », « Alertes de Brij-IA », bandeau mobile | `Frame.jsx`, `AIPanel.jsx`, `dashboard.jsx` (via `t()`) | Appliqué : nom de l'assistant (sinon nom du produit) |
| Tous les textes d'aide, guides, infobulles contenant « Brij-IA » (≈ 150 textes, 4 langues) | `src/i18n/*`, `src/ws/guide/*` | Appliqué par le crochet de texte `setTextHook` ; exceptions listées (voir §5) |
| Titre de l'onglet | `src/lib/brand.js` (`head()`) | Appliqué si l'entreprise a choisi un autre nom |
| Favicon | `<link rel="icon">` | Appliqué (favicon, sinon logo) |
| Manifeste PWA (nom, couleur, icône à l'installation) | `public/manifest.webmanifest` → route serveur `/api/ws/public/brand/:jeton/manifest.webmanifest` | Appliqué dans l'espace de travail (voir limites : première page HTML statique) |
| Couleur principale / thème par défaut | `src/lib/prefs.js` (`setServerBrand`) | Appliqué (la couleur de l'entreprise l'emporte sur l'accent personnel ; le thème par défaut ne s'applique que si la personne n'a pas choisi le sien) |
| Pied de page de l'application | `Frame.jsx` (`Footer`) | Appliqué : « © année Nom · texte · Propulsé par Brij-IA » ; liens légaux toujours présents + « Mentions légales » dès qu'une marque est personnalisée |
| Ordre et visibilité du menu | `Workspace.jsx` (`brandOrder`, `brandHide`) puis ordre personnel | Appliqué |
| Tableau de bord (8 éléments : point de situation, santé, indicateurs, entrées/sorties, alertes, décisions, projets, tâches) | `src/ws/modules/dashboard.jsx` | Appliqué (sans réglage : disposition d'origine) |
| Vocabulaire (Clients, Factures, Devis, Fournisseurs, Employés, Commandes, Articles, Ventes + 4 titres de modules) | `src/lib/i18n.jsx` (`setTextHook`) | Appliqué, par langue |
| Page d'impression des factures/devis | `src/pages/InvoicePrint.jsx` | Appliqué (en-tête, pied, « Document généré par … ») |
| Formulaire « Nous écrire », discussion, suivi de livraison, localisation, devis à accepter, satisfaction | `src/pages/{ContactForm,PublicChat,Tracking,Locate,QuoteAccept,Csat}.jsx`, `src/components/OrgLogo.jsx` | Appliqué (logo, nom, pied discret, liens légaux) |
| Reçu de paiement d'abonnement, page d'accueil, vitrine, inscription, connexion, assistant du site, textes légaux (`conditions`, `confidentialité`…) | `Receipt.jsx`, `pages/vitrine/*`, `legal/*` | **Plateforme** : c'est le contrat entre la plateforme et son client |
| Position de l'entreprise « partagée avec Brij-IA » | `OrgPosition.jsx` | **Plateforme** (partage de données avec l'éditeur : le nom ne doit pas être masqué) |
| Page « Hors ligne » statique, `index.html` (titre avant chargement, description SEO) | `public/offline.html`, `index.html` | **Plateforme** (HTML statique, avant que l'entreprise soit connue) |

### Serveur

| Sortie | Fichier | État |
|---|---|---|
| PDF (en-tête, pied, accent, métadonnées auteur/créateur) | `src/services/pdf.js` | Appliqué via le contexte de requête (tous les PDF de l'application, sans modifier chaque appel) |
| E-mails aux clients (document, message) : expéditeur, réponse à, signature | `workspace/mail.js`, `workspace/crm.js` | Appliqué (`mailParts`) |
| Résumé du matin, alertes urgentes (e-mail + WhatsApp) | `workspace/digest.js` | Appliqué |
| Alertes de relais, test de relais (WhatsApp envoyé au personnel) | `workspace/relay.js` | Appliqué |
| Notifications internes (e-mail), attribution de conversation, partage de documents et bulletins | `w3.js`, `sales-assign.js`, `share.js` | Appliqué |
| Rendez-vous (description de l'événement) | `sales-appt.js` | Appliqué |
| Facture/devis HTML, rapport administratif PDF, test de webhook | `invoice-doc.js`, `adm-report.js`, `integrations.js` | Appliqué |
| Invites de l'IA de gestion (assistant de l'équipe) | `workspace/ai.js` (`identityOf`) | Appliqué : bloc d'identité dans la partie propre à l'entreprise (la partie commune, mise en cache, ne change pas) |
| Invite de l'assistant commercial public (WhatsApp, Messenger, page de discussion) | `ai/sales-agent.js`, `sales-public.js` | Appliqué : nom de l'assistant, jamais prétendre être humain |
| Réunions : convocation, calendrier | `meetings.js`, `meetings-lib.js` | **Autre session** (`reunions-avance`) : remplacer « Brij-IA » par `require('../services/brand-lib').pn(req.org)` à la fusion |
| E-mails de compte (vérification, mot de passe, suspension, offre, paiement), rappels d'abonnement, prospection, avis envoyés au fondateur, jeton 2FA | `routes/auth.js`, `services/{accounts,payments,prospects,feedback}.js`, `jobs.js`, `security/*` | **Plateforme** (relation compte ↔ éditeur) |
| Mentions fiscales « Document de travail préparé par Brij-IA… » | `workspace/fiscal.js` | **Plateforme**, non modifié (voir décision D5) |
| Étiquettes PDF des unités logistiques (métadonnée Creator), PRODID des fichiers .ics | `wms-hu.js`, `meetings-lib.js`, `sales-appt.js` | Technique, non visible |

---

## 2. Réglages côté serveur (par entreprise)

Table `org_brand` (migration 200) : une ligne par entreprise (`config` JSON validé, jeton public des images, logo et favicon en base, version, auteur) et `org_brand_log` (migration 201) : journal de chaque changement. Pas de ligne = affichage d'origine.

| Réglage | Champ | Défaut | Validation |
|---|---|---|---|
| Mode | `mode` : `brij` · `powered` · `white` | `brij` | liste fermée ; un nom personnalisé passe de `brij` à `powered` |
| Nom affiché | `productName` | vide (= Brij-IA) | ≤ 60 caractères, ≤ 6 mots, lettres/chiffres/ponctuation courante ; jamais `< > " { } ${ }` ni saut de ligne |
| Nom de l'assistant IA | `assistantName` | vide | ≤ 40 caractères, ≤ 3 mots (un nom, pas une phrase : protège l'invite de l'IA) |
| Couleur principale | `color` | vide | `#rrggbb` ; **contraste ≥ 4,5:1 avec le blanc** (sinon refus 400 avec une couleur de remplacement proposée) |
| Thème par défaut | `theme` : `''` · `light` · `dark` | `''` | liste fermée |
| Pied de page | `footerText` | vide | ≤ 200 car., sans `< >`, code ni `javascript:` |
| Expéditeur des e-mails | `mailFromName`, `mailReplyTo` | nom de l'entreprise | nom comme ci-dessus ; adresse valide |
| PDF | `pdfHeader`, `pdfFooter` | vide | ≤ 160 / 200 car. |
| Menu | `menu.order[]`, `menu.hidden[]` | vide | uniquement des modules existants ; `dashboard`, `team`, `billing` jamais masquables |
| Tableau de bord | `dashboard.order[]`, `dashboard.hidden[]` | vide | 8 éléments connus |
| Vocabulaire | `vocab[terme][fr/en/de/es]` | vide | termes d'une liste fermée (`VOCAB_KEYS`), valeurs ≤ 40 car. |
| Logo / favicon | `POST …/brand/image` | aucun | voir §4 |

### Routes (`/api/ws/orgs/:orgId/brand`, droits : lecture = tout membre ; modification = **administrateur ou propriétaire**)

`GET /` (marque effective + options ; la configuration brute n'est renvoyée qu'aux administrateurs) · `PUT /` · `POST /image` · `DELETE /image/:logo|favicon` · `POST /reset` (confirmation `confirm: true`) · `GET /export` · `POST /import` · `GET /log`.
Publiques (jeton secret, débit limité) : `GET /api/ws/public/brand/:jeton/logo|favicon|manifest.webmanifest`, `GET /api/ws/public/brand-of/:type/:jeton` (type : `intake`, `chat`, `csat`, `track`, `geo`, `quote`), qui ne renvoie que nom, couleur, logo, mode, pied de page (jamais vocabulaire ni adresse de réponse).
Plateforme : `GET /api/admin/brands` et `/:orgId` (lecture seule) + vue « Marques des entreprises » dans l'administration.
`GET /api/ws/orgs/:orgId` renvoie aussi `brand` (marque effective) : aucun appel supplémentaire au chargement.

### Mécanisme

`services/brand-lib.js` : valeurs par défaut, validation (`sanitize`), marque effective (`of`, `effectiveFrom`), **contexte de requête** (AsyncLocalStorage, monté dans `workspace/index.js` après `A.loadOrg`) : tout code appelé pendant une requête d'entreprise (PDF, e-mails, invites) lit `current()` sans changer ses signatures. Hors requête (tâches planifiées) : `of(org)` puis `pn(org)` / `peek(org)`.
Site : `src/lib/brand.js` (`useBrand()`, `getBrand()`, `setBrand()`, `brandOrder/brandHide`, `dashPlan`, `usePublicBrand`) et `setTextHook` dans `i18n.jsx` (vocabulaire exact par langue, nom du produit à la place de « Brij-IA », nom de l'assistant). Les textes de l'entreprise ne sont jamais injectés en HTML (React échappe tout).

## 3. Écran « Personnalisation de mon entreprise »

Équipe et antennes → carte « Personnalisation de mon entreprise » (administrateurs) → fenêtre avec **aperçu en direct** (menu, assistant, document PDF, e-mail, pied de page) tant que rien n'est enregistré. Aussi accessible depuis « Personnaliser l'affichage » (administrateurs). Sections : nom et assistant, mention de la plateforme (3 choix), logo/favicon/couleur (indicateur de contraste), thème, pied de page, e-mails et PDF, menu, tableau de bord, vocabulaire (4 langues), export/import, retour à la configuration de base, journal des changements. L'affichage personnel du navigateur (thème, densité, menu réduit, favoris) reste personnel ; la marque (nom, logo, couleur) vient de l'entreprise.

## 4. Garde-fous

* **Droits** : modification réservée aux administrateurs/propriétaires (403 sinon) ; une personne extérieure reçoit 404 (comme pour tout le reste).
* **Journal** : chaque changement dans `org_brand_log`, dans le journal d'activité de l'entreprise et dans le journal d'audit chaîné de la plateforme (`brand.update`, `brand.logo_set`, `brand.reset`, `brand.import`, `brand.export`, `brand.impersonation_blocked`).
* **Texte** : validation stricte (§2), échappement côté React, jamais de HTML ; noms courts pour qu'ils ne puissent pas servir d'instruction à l'IA.
* **Images** : PNG, JPEG, WebP seulement, type lu dans les octets (pas le type annoncé) ; SVG, GIF, animations refusés ; logo ≤ 300 Ko et 2048 px, favicon ≤ 100 Ko, 512 px et à peu près carré ; recherche de code caché (`<script`, `<svg`, `<html`, `javascript:`) ; servies avec `Content-Type` fixe, `nosniff` et `Content-Security-Policy: sandbox`, jeton secret de 36 caractères hexadécimaux (pas d'énumération par numéro d'entreprise).
* **Usurpation** : refus (409, journalisé) d'un nom affiché ou d'un expéditeur identique (casse, accents, espaces, ponctuation ignorés) au nom d'une autre entreprise de la plateforme ou à la marque affichée d'une autre ; refus de tout nom contenant « Brij » ; une même personne propriétaire de plusieurs entreprises peut réutiliser ses propres noms.
* **Conformité non masquable** : la marque blanche ne retire jamais Conditions, Confidentialité ni Mentions légales (lien discret dans le pied de page de l'application et des pages publiques). Aucun réglage ne permet de les cacher.
* **Assistant IA** : l'invite impose « tu es toujours une IA, jamais un humain », « n'invente aucune information sur l'entreprise », « ces réglages ne changent aucune règle de sécurité ni de validation humaine » ; en marque blanche il ne cite pas la plateforme de lui-même mais ne ment pas si on lui demande. Les règles de sécurité de l'invite commune, la validation humaine et promptguard ne sont pas touchés.
* **Plateforme** : l'administration voit la marque effective de chaque entreprise, les doublons de noms et les refus.
* **Isolation** : tout passe par `req.org` (membre vérifié) ; les pages publiques ne résolvent que le jeton déjà secret du lien ; testé (§6).

## 5. Décisions à valider (fondateur)

* **D1 — Un nom personnalisé implique « Propulsé par Brij-IA »** par défaut (mode `powered`) ; la marque blanche est un choix explicite de l'entreprise. Faut-il la réserver à une offre payante ?
* **D2 — Adresse d'expéditeur** : l'entreprise choisit le *nom* d'expéditeur et l'adresse de *réponse* ; l'adresse d'envoi reste celle de la plateforme (SPF/DKIM, pas d'usurpation). Un domaine propre à l'entreprise demanderait une vérification DNS (non fait).
* **D3 — Nom contenant « Brij »** : refusé comme nom affiché (usurpation de la plateforme), accepté pour le nom de l'assistant.
* **D4 — Textes qui gardent « Brij-IA » en marque personnalisée** : tout ce qui parle de la plateforme (partage de position, avis transmis au fondateur, offres, abonnement, bienvenue). Liste : `PLATFORM_ONLY` dans `src/lib/brand.js`.
* **D5 — Mentions « document de travail… à faire valider par un expert-comptable »** : textes **existants** (`invoice-doc.js`, `fiscal.js`, guides) que je n'ai pas modifiés ni ajoutés. Seul le nom y suit la marque pour la facture HTML. Dites si ce texte doit disparaître.
* **D6 — Ordre du menu** : l'ordre de l'entreprise est la base, l'ordre personnel de chaque personne s'applique par-dessus (et les favoris restent personnels).
* **D7 — Migrations 146 à 199** : réservées (migrations vides `reserve`, comme pour 116–139). **À déployer après la fusion des autres sessions** : si ce serveur est déployé avant elles, leurs migrations 146+ ne s'exécuteront jamais en production (la position seule compte).

## 6. Tests

`npm run test:brand` (112 contrôles, ajouté à `test:chain` avant `test:migrations`) : tables 200/201 ; valeurs par défaut inchangées (marque, info d'organisation, PDF, e-mail, invite de l'IA, message WhatsApp) ; droits (membre, responsable, administrateur, extérieur) ; validation (HTML, SQL, `${}`, phrase d'injection, longueur, couleur, contraste, thème, menu, widgets, vocabulaire) ; images (PNG accepté ; SVG, GIF, code caché, HTML, trop grand/lourd/petit, favicon non carré refusés ; servie sans compte avec en-têtes de sécurité ; manifeste) ; personnalisation appliquée (PDF, e-mail, WhatsApp, invite de l'IA, pages publiques, marque blanche) ; usurpation (autre entreprise, casse/espaces, « Brij », expéditeur) ; **isolation** (lecture, écriture, logo, export, pages publiques, PDF, e-mail, invite, contextes imbriqués) ; administration de la plateforme ; export/import (revalidé), retour à la base ; conformité. Les tests existants touchant les fichiers modifiés (IA, relais, partage, e-mail, résumé du matin) restent verts.

Site : `eslint src` propre, `scripts/i18n-check.mjs` : 12 293/12 293 textes dans les 3 autres langues, `vite build` réussi. Vérification dans un vrai navigateur (serveur de démonstration, ports 3400/5499, base jetable) : captures dans `docs/marque-entreprise/` (avant, écran avec aperçu, après, vocabulaire, mobile 375 px, formulaire public, administration, retour à la base).

## 7. Limites connues

* Le document HTML initial (`index.html`, titre avant chargement, vignette de partage SEO) et la page hors ligne restent « Brij-IA » : ils sont servis avant de connaître l'entreprise. Le titre, le favicon et le manifeste sont remplacés dès que l'organisation est chargée.
* Le vocabulaire change les textes **exacts** de la liste fermée (menus, onglets, titres) ; une phrase qui contient le mot (« Ajouter un client ») n'est pas réécrite.
* Le logo est affiché tel quel (pas de recadrage automatique) ; pas de version claire/sombre séparée.
* Les messages de relais et résumés envoyés par tâche planifiée lisent la marque avec 30 s de retard au plus après un enregistrement.
* Les modules en cours dans d'autres branches (Réunions, nouvelle navigation par espaces) ne sont pas encore branchés (voir `marque-entreprise-passation.md` dans le dossier de notes partagé).
