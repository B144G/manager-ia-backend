# Déploiement du serveur fusionné — risques et variables

## Variables d'environnement (Render)
| Variable | Rôle | Obligatoire ? |
|---|---|---|
| `STRICT_PROD_CONFIG=1` | Refuse de démarrer si JWT_SECRET < 32, ADMIN_PASSWORD < 12 ou ALLOWED_ORIGINS en `*`/http ; exige BACKUP_KEY pour sauvegarder | Non. Sans elle : simple AVERTISSEMENT très visible dans les journaux. À activer une fois la configuration corrigée. |
| `DATA_KEY` | Clé de chiffrement des champs sensibles (CNPS, NIU, CNI, comptes de paie, secrets). Absente : dérivée de JWT_SECRET comme avant | Recommandée. **Ne jamais la perdre ni la changer sans `DATA_KEY_PREVIOUS` + `npm run security:rotate-keys`.** |
| `BACKUP_KEY` | Chiffre les sauvegardes (`scripts/backup.js`) ; déchiffrement `scripts/backup-decrypt.js` | Non (sans elle : copie en clair + avertissement) |
| `SKIP_STARTUP_ENCRYPTION=1` | Coupe le chiffrement automatique, au démarrage, des anciennes lignes en clair | Non. Utile pour garder la possibilité de revenir à l'ancien code (voir ci-dessous). |
| `SECURITY_REWRAP=1` | Rechiffre avec la clé actuelle (rotation) | Non |
| `ALERT_LIBRARY_FAILS`, `ALERT_LIBRARY_WINDOW_MIN` | Seuils de l'alerte « mots de passe de la bibliothèque ratés » | Non (5 / 60) |

## Migrations (ajoutées uniquement en fin de MIGRATIONS ; rejouables)
1. Sécurité (dans `src/db.js`) : `login_fails.lock_level`, `login_devices`, `consents`, `data_requests`, `users.erase_after/anonymized_at`, `ai_budget`, `audit_checkpoints`, `orgs.require_2fa`, `retention_rules`.
2. `src/migrations/fusion-achats.js`, `fusion-bibliotheque.js`, `fusion-entrepot.js` (colonnes `ADD COLUMN IF NOT EXISTS`, tables `IF NOT EXISTS`, reprise des lignes existantes ; `org_id` ajouté à `lib_role_perms`/`lib_user_perms` avec rattrapage ; six clés étrangères du WMS rendues `DEFERRABLE INITIALLY DEFERRED` pour que la suppression d'une organisation ne tombe plus en 500).
Aucune table ni colonne de la production n'est renommée ou supprimée. Durée attendue : quelques secondes sur de petits volumes ; les rattrapages (`UPDATE … SET org_id`, totaux d'Achats) sont proportionnels au nombre de lignes. Faire une sauvegarde Neon avant le déploiement (non testé sur une copie réelle de la base de production).

## Risques à connaître
- **Retour arrière** : après le démarrage, les anciennes lignes en clair sont chiffrées (`v2:`). L'ancien code (ligne A) ne sait pas les lire. Pour garder cette porte ouverte, déployer d'abord avec `SKIP_STARTUP_ENCRYPTION=1` ; les nouvelles écritures sont chiffrées dans tous les cas.
- Verrouillage progressif, alerte d'appareil inconnu, 2FA exigible : de nouveaux comportements visibles par les utilisateurs (voir CONTRATS-API.md).
- `Cache-Control: no-store` et CSP sur `/api` : le site doit vérifier l'affichage en iframe des PDF (Achats, factures) ; seule la bibliothèque autorise explicitement l'aperçu intégré.
- Entrepôt : règles plus strictes (400/409 là où A repliait en silence) listées dans `contrats/entrepot.md` ; le site de production doit en afficher les messages.
- Deux couches de prévision/réappro/états coexistent (`/stock/wms/…` de A et `/stock/wms/b/…` de B).
- Dépendances : `package-lock.json` de B repris ; `npm audit` non rejoué (hors ligne).


---
# Complément — fusion des modules (branche `fusion-modules`)

## Variables d'environnement NOUVELLES (Render ; ne jamais écrire les valeurs dans un fichier ni un message)
Toutes facultatives : sans elles le serveur démarre et se comporte comme avant (Campay désactivé, paiement manuel non proposé).

| Variable | Rôle | Défaut |
|---|---|---|
| `CAMPAY_MODE` | `test` (serveur de démonstration Campay, aucun argent réel) ou `reel`. Toute autre valeur : le serveur refuse de démarrer | `test` |
| `CAMPAY_APP_USERNAME` + `CAMPAY_APP_PASSWORD` (ou `CAMPAY_APP_TOKEN`) | Identifiants de l'application Campay (anciens noms `CAMPAY_USERNAME` / `CAMPAY_PASSWORD` acceptés) | absents = paiement automatique inactif |
| `CAMPAY_WEBHOOK_KEY` | Clé de signature (HS256) des rappels Campay. **Obligatoire avec `CAMPAY_MODE=reel`** | — |
| `CAMPAY_BASE_URL` | Adresse de l'API Campay si elle doit être forcée | selon le mode |
| `CAMPAY_PENDING_TTL_MIN`, `CAMPAY_RECONCILE_AFTER_MIN` | Expiration (10) et délai de réconciliation (3) des paiements en attente, en minutes | 10 / 3 |
| `CAMPAY_WEBHOOK_RATE`, `CAMPAY_FAIL_ALERT_COUNT` | Webhooks acceptés par minute (120) ; échecs d'un client avant alerte e-mail (3) | 120 / 3 |
| `PAYMENTS_INIT_RATE`, `PAYMENTS_CONFIRM_RATE` | Demandes de paiement (10) et confirmations (20) par 10 minutes | 10 / 20 |
| `MANUAL_PAY_MTN_NUMBER`, `MANUAL_PAY_ORANGE_NUMBER`, `MANUAL_PAY_ACCOUNT_NAME` | Numéros de réception et nom du titulaire du paiement manuel de secours (anciens noms `MTN_NUMBER`, `ORANGE_NUMBER`, `PAYMENT_HOLDER_NAME` acceptés). **Sans numéro, le paiement manuel n'est pas proposé** | absents |
| `MANUAL_PAY_ENABLED` | `1` / `0`. Absent : manuel actif seulement si Campay est inactif | — |
| `MANUAL_PAY_TTL_HOURS`, `MANUAL_PAY_MAX_ATTEMPTS` | Expiration d'une commande manuelle (48 h) ; essais d'identifiant par commande (5) | 48 / 5 |
| `DEFAULT_COUNTRY_CODE` | Indicatif pays pour normaliser les numéros (Mobile Money) | `237` |
| `HISTORY_QUOTA_MB` | Quota de médias du module Histoire par organisation | 200 |

Variables de test seulement (ignorées en production) : `CAMPAY_RECONCILE_TICK_MS`, `TEST_START_TRIES`, `DEMO_CAMPAY`.
Rappel : `RATE_LIMIT_GLOBAL` existe déjà (3 000 requêtes / 15 min / adresse) ; à relever seulement pour des démonstrations.

## Ordre de déploiement
1. **Sauvegarde de la base** (Neon : branche/« restore point » ou `scripts/backup.js` avec `BACKUP_KEY`) — avant tout.
2. Saisir dans Render les variables voulues (aucune n'est requise ; garder `CAMPAY_MODE=test` tant que le compte Campay réel n'est pas ouvert).
3. Pousser le **serveur** (`claude/postgres-react` puis `master`), attendre `/api/health` OK : les migrations s'appliquent au démarrage, sous verrou.
4. Pousser le **site** (`main`, Vercel) seulement ensuite : les nouveaux écrans appellent des routes qui doivent déjà exister.
5. Vérifier avec un compte propriétaire : ouvrir Commercial, Trésorerie, Talents, Réunions, Histoire, Administration, Bibliothèque, Abonnement ; faire un paiement en mode test.

## Migrations ajoutées par cette fusion (37, numéros 79 à 115, en fin de tableau, rejouables)
Fichiers : `projets-ro`, `projets-production-avancee`, `reunions`, `histoire`, `tresorerie`, `rh-talents`, `administration`, `biblio-evolution`, `commercial-pro`, `paiement-campay`.
Elles créent des **tables nouvelles** (`mtg_*`, `history_*`, `tre_*`, `rh_*`, `adm_*`, `cp_*`, `lib_*` nouvelles, `project_pert`, `project_deps`, `ro_scenarios`, `production_flows`, `production_docs`, `project_fin_docs`, `payment_webhook_events`) et ajoutent quelques **colonnes avec valeur par défaut** (`projects.kind`, `project_risks.category`, colonnes de paiement, de bibliothèque). Aucun DROP / RENAME / DELETE / TRUNCATE (vérifié par `test:migrations`). **Risque : faible** — pas de réécriture de tables existantes ; durée de quelques secondes. L'empreinte des 78 premières migrations est figée par test : ne jamais modifier ni réordonner une migration existante, seulement en ajouter à la fin.
Si la première production reçoit directement ce lot, les migrations de la fusion précédente (stock, comptabilité, sécurité) passent aussi : voir la liste ci-dessus.

## Retour arrière
- **Code** : redéployer l'ancien commit sur Render (serveur) et Vercel (site). Les tables ajoutées restent en place sans gêner l'ancien code (il ne les connaît pas) ; les colonnes ajoutées ont une valeur par défaut.
- **Données** : restaurer la sauvegarde Neon seulement en dernier recours (perte des écritures faites depuis). Ne jamais supprimer de lignes `schema_migrations`.
- Paiement : repasser `CAMPAY_MODE=test` ou retirer les identifiants désactive Campay immédiatement, sans redéploiement de code.
- Attention aux anciennes valeurs chiffrées : voir « Risques » plus haut (`SKIP_STARTUP_ENCRYPTION=1`).

## Champs légaux encore à compléter (non bloquant pour le démarrage, bloquant pour une mise en service publique)
Les modèles de `docs/securite/legal/fr/` contiennent encore ~58 marques `[À COMPLÉTER]` : dénomination, forme juridique et capital, siège, **RCCM**, **NIU**, directeur de la publication, e-mails de contact et de « vie privée », régions d'hébergement Render et Neon, sous-traitants et transferts (07), durées de conservation, accord de sous-traitance (06), plan de continuité (10). Le **taux de chaque rubrique de paie** et la date « à jour au » restent à saisir par l'entreprise (aucun taux n'est inventé). Côté module Administration, la « référence du texte applicable » est à renseigner par l'entreprise cliente. Côté Campay : identifiants et clé webhook du compte réel, et adresse de l'API de production à confirmer.


---
# Complément — fusion « Avis » + « Transport géolocalisé » (branche `fusion-avis-transport`)

Base : `fusion-modules` (serveur `a34cce2`, site `06d462a`) + `avis-module` + `transport-geo`. Les branches sources et la production ne sont pas modifiées.

## Migrations (141 → 142 au total ; 1 à 115 inchangées)
- Les 115 premières migrations sont **identiques octet pour octet** à la production (empreinte SHA-1 du tableau, comparée entre `fusion-modules` et la branche fusionnée : `08da46a4a8725a63f6c2ed18a4d2c0ace30ba42c` des deux côtés).
- **116 = Avis** (`src/migrations/avis.js`, tables `fb_feedback`, `fb_notes`, `fb_state`) : elle occupe l'emplacement que la branche Transport réservait par une migration vide. Aucune migration vide n'est plus au numéro 116.
- **117 à 139** : migrations vides réservées (`SELECT n AS reserve`), laissées pour les futurs modules : on ne les renumérote jamais.
- **140 à 142 = Transport géolocalisé** (`src/migrations/transport-geo.js` : `tg_*`, clients / fournisseurs typés, position d'entreprise). Mêmes numéros que dans la branche source.
- Piège évité : si la production recevait d'abord Transport seul, le numéro 116 serait marqué « appliqué » avec une migration vide et Avis ne créerait jamais ses tables. **Déployer cette branche d'un seul bloc (Avis + Transport), jamais la branche Transport seule avant Avis.**
- `scripts/test-migrations.js` vérifie désormais : 78 premières inchangées, 116 = tables `fb_` (et non un emplacement vide), 117 à 139 exactement `SELECT n AS reserve`, 142 migrations au total.

## Variables d'environnement à régler sur Render
| Variable | Rôle | Valeur / remarque |
|---|---|---|
| `SITE_URL` | **À régler.** Adresse publique du site (ex. celle de Vercel, sans `/` final). Sert à construire le lien envoyé au client pour partager sa position (`<SITE_URL>/localiser/<jeton>`). Sans elle, le lien est relatif et inutilisable dans un message WhatsApp. | recommandée (obligatoire en pratique pour la géolocalisation des clients) |
| `ADMIN_EMAIL` | Destinataire de la notification de chaque nouvel avis et du résumé quotidien. Défaut dans le code : l'adresse du fondateur. | à vérifier |
| `BREVO_API_KEY` + expéditeur, ou `SMTP_*` | Un des deux moyens d'envoi d'e-mail déjà utilisés par `services/notify.js`. **Sans l'un d'eux, aucun e-mail d'avis ne part** (rien ne casse : trace dans les journaux et dans « Notifications » de l'administration). | à vérifier |
| `FEEDBACK_NOTIFY=off` | Coupe l'e-mail à chaque avis (le résumé quotidien reste) | facultative |
| `FEEDBACK_PER_DAY` (5), `FEEDBACK_MIN_GAP_S` (60), `FEEDBACK_SHOT_MAX_MB` (2) | Limites anti-abus et taille des captures | facultatives |
| `FEEDBACK_WHATSAPP=on` | Sans effet tant qu'aucun canal WhatsApp n'est branché (pas d'API officielle) | laisser absente |
| `DATA_KEY` | Chiffre les captures d'avis et sert de clé à l'empreinte des avis anonymes. **La même clé qu'aujourd'hui : ne pas la changer** (les captures déjà enregistrées deviendraient illisibles). | déjà recommandée |
Aucune autre variable nouvelle : Transport n'en ajoute pas. La carte utilise les fonds OpenStreetMap (gratuits) ; la recherche d'adresse passe par Nominatim, seulement au clic.

## Ordre de déploiement
1. **Sauvegarde de la base** (Neon : point de restauration / branche, ou `scripts/backup.js` avec `BACKUP_KEY`) — avant tout. Noter l'heure.
2. Régler sur Render `SITE_URL` (et vérifier `ADMIN_EMAIL`, l'envoi d'e-mail).
3. Pousser le **serveur** : `fusion-avis-transport` vers `claude/postgres-react` puis `master`. Attendre `/api/health` = OK ; les migrations 116 et 140-142 s'appliquent au démarrage, sous verrou, en quelques secondes (tables nouvelles et colonnes avec valeur par défaut uniquement).
4. Pousser le **site** (`main`, Vercel) seulement ensuite : les écrans Avis et Transport appellent des routes qui doivent déjà exister. Le site ajoute la dépendance `leaflet@1.9.4` (installée par `npm ci` sur Vercel).
5. Contrôles : (a) propriétaire : bouton « Donner mon avis » → envoyer un avis de test → « Mes avis » ; (b) `/admin` › Commercial › Avis : l'avis apparaît, e-mail reçu ; (c) Logistique › Géolocalisation › Carte et affectation : la carte s'affiche, points verts/rouges ; (d) Clients et fournisseurs : types, filtre « Localisés sur la carte » ; (e) Équipe et antennes › Position de l'entreprise ; `/admin#/geo` : carte des entreprises ; (f) page d'accueil : la section « Ils utilisent Brij-IA » reste masquée tant qu'aucun témoignage n'est approuvé.

## Sauvegarde et retour arrière
- **Code** : redéployer les commits précédents (serveur `a34cce2`, site `06d462a`) sur Render et Vercel. Les tables `fb_*` et `tg_*`, ainsi que les colonnes ajoutées, restent en place sans gêner l'ancien code (valeurs par défaut) ; ne jamais supprimer de lignes de `schema_migrations`.
- **Données** : restaurer la sauvegarde seulement en dernier recours (perte des écritures faites depuis le déploiement, y compris des avis reçus).
- Notification d'avis : `FEEDBACK_NOTIFY=off` la coupe sans redéploiement. Géolocalisation : chaque transporteur et chaque entreprise garde la main (consentement, arrêt du partage, suppression des positions après 14 jours par défaut).

## Points d'attention
- **Un seul bloc** : ne pas déployer Transport sans Avis (voir « Migrations »). Les deux modules ont été testés ensemble ; la suite complète est donnée plus bas.
- **Administration** : deux écrans ajoutés dans `/admin` : « Carte des entreprises » (Pilotage, `admin/views-geo.js`) et « Avis » (Commercial, `admin/views-d.js`). Le fichier de Transport s'appelait aussi `views-d.js` : il a été renommé `views-geo.js` pour la fusion. La politique de sécurité de `/admin` autorise uniquement `tile.openstreetmap.org` en plus d'elle-même.
- **Vie privée** : les positions des transporteurs ne sont collectées qu'avec leur accord ; les avis anonymes ne gardent qu'une empreinte à clé secrète ; un témoignage n'est public que s'il est approuvé par le fondateur ET consenti par son auteur. Le registre des traitements et la politique de confidentialité devront mentionner ces deux traitements (avis ; positions) : à faire avant la mise en service publique.
- **Services externes appelés depuis le navigateur** : OpenStreetMap (fonds de carte ; l'adresse IP de l'utilisateur est vue par OSM) et Nominatim (adresse saisie, seulement au clic). Les citer dans la liste des sous-traitants si le fondateur le juge nécessaire. Pas d'appel depuis le serveur.
- **Charge** : `RATE_LIMIT_GLOBAL` n'est relevée que pour les tests ; ne pas la relever en production.
- Le site de production (Vercel) reste valable sans le nouveau serveur uniquement pour les écrans existants ; les nouveaux écrans exigent le nouveau serveur (d'où l'ordre).

## Résultats de vérification (20/11/2026, `TEST_START_TRIES=200`)
- Suite complète serveur (`npm test`) : **73 étapes sur 73 réussies, 0 échec, aucun second essai** (1 202 s), dont `test:feedback`, `test:tmsgeo`, `test:parties`, `test:orggeo` et `test:migrations` (10 vérifications, dont les deux nouvelles sur 116 et 140-142).
- Site : `npm ci` (leaflet 1.9.4), `eslint src` sans erreur, `i18n-check` FR/EN/DE/ES 12 184/12 184 textes, `vite build` réussi. Aucun conflit de fusion côté site.
- Test de fumée navigateur : captures dans `docs/fusion/captures-avis-transport/` (20 images, bureau et 375 px).
- Correctif trouvé pendant le test : en mobile, la barre basse masquait le pied de page (dont « Donner mon avis ») ; `shell.css` ajoute désormais la hauteur de la barre au bas du pied de page.
- Observations non bloquantes : la démonstration `scripts/demo/index.js` signale 59 échecs, tous dans son groupe « stock › Achats » (le script de démonstration approuve son propre bon de commande, refusé par la règle de double approbation ; sans lien avec cette fusion) ; la graphique « Évolution de la note moyenne » de l'admin affiche un axe jusqu'à 6 ; le champ d'adresse de « Position de l'entreprise » est prérempli avec l'adresse de l'entreprise, téléphone compris (envoyé à OpenStreetMap seulement au clic sur « Rechercher ») ; en 375 px le sélecteur de langue de la page `/localiser/:jeton` chevauche légèrement le logo.
