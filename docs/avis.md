# Module « Avis et recommandations »

Branche `avis-module` (serveur et site, depuis `fusion-modules`). Rien n'est poussé.

## Ce que fait le module
**Pour l'utilisateur connecté** (bouton discret « Donner mon avis » dans le pied de page de l'espace de travail ; absent des écrans de connexion, de création d'organisation et de chargement) :
- note de 1 à 5 étoiles (obligatoire) et score de recommandation de 0 à 10 (type NPS, facultatif) ;
- type : avis, suggestion, problème ou commentaire ; module concerné (ou « ensemble du logiciel ») ; message libre (2 000 caractères) ;
- capture d'écran facultative (PNG, JPEG ou WebP, 2 Mo ; une grosse image est réduite côté navigateur) ;
- case « anonyme » ; case de consentement à un affichage public (réservée aux avis rédigés d'au moins 10 caractères) ;
- onglet « Mes avis » : état de traitement, retrait du consentement, autorisation après coup, suppression.

**Pour le fondateur** (espace `/admin`, onglet « Avis » dans « Commercial ») :
- indicateurs : note moyenne, NPS (promoteurs 9-10, passifs 7-8, détracteurs 0-6), nombre d'avis avec évolution sur la période précédente, courbe de la note, répartition des étoiles, modules les plus cités (nombre, note moyenne, problèmes), résumé du jour ;
- liste filtrable (type, module, note, statut, témoignage à approuver / publié, recherche dans le texte) ;
- fiche : message, capture, statut (nouveau → lu → en cours → traité → archivé ; « nouveau » passe à « lu » à l'ouverture), **réponses internes** (jamais visibles de l'utilisateur), approbation / retrait du témoignage ;
- export CSV (UTF-8 avec BOM, séparateur `;`, formules neutralisées) avec les mêmes filtres.

**Notification** : à chaque nouvel avis, un e-mail texte brut au fondateur (`ADMIN_EMAIL`) par le mécanisme existant (`services/notify.js` : Brevo ou SMTP). Si aucun e-mail n'est configuré, rien ne casse : trace dans les logs et dans « Notifications » de l'administration. Un **résumé quotidien** de la veille part une fois par jour (après 6 h UTC, via la tâche horaire `jobs.js`) s'il y a eu des avis. `FEEDBACK_NOTIFY=off` coupe ces e-mails.
**WhatsApp** : pas d'API officielle. Il existe seulement un point d'extension (`registerChannel('whatsapp', …)` dans `services/feedback.js`), **désactivé par défaut** : il ne s'active que si un canal est branché ET `FEEDBACK_WHATSAPP=on`. Aucun message WhatsApp n'est envoyé.

**Témoignages publics** : la page d'accueil affiche une section « Ils utilisent Brij-IA » (masquée s'il n'y en a aucun) alimentée par `GET /api/ws/public/testimonials`. Un avis n'y figure que s'il est **approuvé par l'administrateur ET consenti par son auteur** ; seuls y sortent l'identifiant, la note, le texte, le prénom + initiale du nom, le module et la date. Un avis anonyme n'a **jamais** de nom (le serveur ne le renvoie pas, même si une donnée l'avait contenu). Le retrait du consentement par l'auteur annule aussitôt l'approbation et la publication ; un nouveau consentement demande une nouvelle approbation.

## Anonymat — ce que cela signifie exactement
Un avis anonyme n'enregistre ni `user_id` ni nom, et l'administration n'affiche ni nom ni organisation. Pour limiter la fréquence et permettre à son auteur de retrouver, retirer ou supprimer ses avis, le serveur garde une **empreinte à clé secrète** (`author_hash`, HMAC-SHA-256 de l'identifiant avec `DATA_KEY`/`JWT_SECRET`) : elle ne permet pas de remonter à la personne sans la clé du serveur. Changer cette clé fait perdre à l'auteur l'accès à ses anciens avis (ils restent en base, anonymes). Le rattachement à une organisation (`org_id`) est conservé pour l'isolation et la suppression en cascade, mais n'est pas montré.

## Sécurité
- Validation stricte côté serveur (note entière 1-5, score entier 0-10, types et modules en liste fermée, longueurs, caractères de contrôle et d'inversion de texte retirés). Le texte est stocké tel quel et **échappé à l'affichage** (React et DOM texte ; e-mail en texte brut ; CSV neutralisé).
- Capture : type déterminé **sur le contenu** (signatures PNG/JPEG/WebP ; SVG, GIF, HTML refusés même si le nom ou l'en-tête dit « image »), 2 Mo au plus (413 avant lecture complète), une par avis, dans l'heure suivant l'envoi, par son auteur seulement, **chiffrée au repos** (AES-GCM, comme la bibliothèque), servie avec `Content-Type` fixé par le serveur, `nosniff`, `Content-Security-Policy: sandbox`, sans cache.
- Anti-abus : 1 avis par minute et 5 par jour et par personne (`FEEDBACK_MIN_GAP_S`, `FEEDBACK_PER_DAY`), plus limiteurs par adresse (partagés en base) sur l'envoi et la capture.
- Isolation : un utilisateur ne voit, ne modifie, ne supprime que ses propres avis, dans l'organisation dont il est membre (404 sinon). L'administration exige la session administrateur.
- Journal d'audit : `feedback.create`, `feedback.screenshot`, `feedback.consent_given/withdrawn`, `feedback.delete_own`, `feedback.admin_update` (et toute écriture d'administration par le routeur admin).

## Droits des personnes
- **Export** (`/api/privacy/export`) : les avis nominatifs (table `fb_feedback`, par `user_id`) et les avis anonymes de la personne (`fb_feedback_anonymes`) sont inclus ; ni capture, ni empreinte, ni note interne.
- **Export d'organisation** : les avis ne sont **pas** inclus (ils sont adressés à la plateforme, pas à l'organisation).
- **Suppression du compte** : texte, capture, nom et page effacés, consentement et approbation retirés ; seules les notes chiffrées restent, sans identité (statistiques). Suppression d'un avis par son auteur : immédiate. Suppression de l'organisation : avis supprimés en cascade.

## Fichiers
Serveur : `src/migrations/avis.js` (migration **116**, tables `fb_feedback`, `fb_notes`, `fb_state`), `src/services/feedback.js` (cœur), `src/workspace/feedback.js` (utilisateur + public), `src/routes/admin-feedback.js` (administration), `admin/views-d.js` (écran), `scripts/test-feedback.js` (95 vérifications).
Modifiés (minimum) : `src/db.js` (+2 lignes), `src/workspace/index.js` (+2), `src/routes/admin.js` (+1), `src/jobs.js` (+1 tâche), `src/security/privacy.js` (export des avis anonymes, exclusion de l'export d'organisation, effacement), `admin/admin.js` / `index.html` / `admin.css`, `package.json` (`test:feedback` avant `test:migrations`).
Site : `src/ws/Feedback.jsx`, `src/pages/vitrine/Testimonials.jsx`, `src/styles/ws-feedback.css`, `src/i18n/{en,de,es}/ws-feedback.js` ; modifiés : `Workspace.jsx`, `shell/Frame.jsx`, `wsStyles.js`, `Home.jsx`, `vitrine.css`.

## API
Utilisateur `/api/ws/orgs/:id/feedback` : `GET /meta` · `POST /` · `POST /:id/screenshot` (corps binaire) · `GET /mine` · `GET /mine/:id/screenshot` · `PUT /mine/:id/consent` · `DELETE /mine/:id`.
Public : `GET /api/ws/public/testimonials?limit=`.
Administration `/api/admin/feedback` : `GET /` (filtres `kind, module, stars, maxStars, status, open, public=pending|approved, q, from, to, limit, offset`) · `GET /stats?days=` · `GET /digest?day=` · `GET /export.csv` · `GET /:id` · `GET /:id/screenshot` · `PUT /:id` (`status`, `note`, `approved`).

## Variables d'environnement (toutes facultatives)
`FEEDBACK_NOTIFY=off` (pas d'e-mail), `FEEDBACK_PER_DAY` (5), `FEEDBACK_MIN_GAP_S` (60), `FEEDBACK_SHOT_MAX_MB` (2), `FEEDBACK_WHATSAPP=on` (inutile tant qu'aucun canal n'est branché).

## Captures
`docs/avis/captures/` : formulaire, « Mes avis », administration (liste, fiche), témoignages de la page d'accueil, en 375 px et en 1280 px (serveur de démonstration `scripts/demo-local.js`).

## Limites connues
- Les messages d'erreur du serveur sont en français ; ceux de ce module sont traduits dans `ws-feedback.js`, les autres tombent sur le français.
- Pas de réponse publique à l'utilisateur : la « réponse interne » reste interne (choix de conception).
- Le témoignage affiche le texte tel que saisi (pas de modification par l'administrateur : approuver ou non).
- Le compteur de nouveaux avis n'est pas dans la pastille du menu d'administration (visible dans l'écran « Avis »).
