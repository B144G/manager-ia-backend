# Audit de sécurité de MABAH — serveur (Node/Express, PostgreSQL)

Date : 16 novembre 2026 · Branche : `claude/securite-784605` · Auteur : revue interne assistée par outils (lecture du code, tests automatiques, `npm audit`).

> **Ce que ce document est — et n'est pas.** C'est un audit interne, fait en lisant le code et en le mettant à l'épreuve avec des tests automatiques. Il dit ce qui est **vérifié par un test** et ce qui **reste ouvert**. Il n'atteste **aucune certification** (ISO 27001, SOC 2, etc.) et ne rend **aucun système « inviolable »** : un test qui passe prouve l'absence d'un défaut précis, pas l'absence de tous les défauts. Un test d'intrusion par un tiers indépendant reste nécessaire (voir §6).

## 1. Périmètre et méthode

Lu en entier ou en grande partie : `src/server.js`, `src/config.js`, `src/middleware/*`, `src/security/*`, `src/routes/*`, `src/services/*` (dont `waWeb.js`, `vault.js`, `webhooks.js`, `signedUrl.js`, `claude.js`), `src/workspace/*` (sondé par énumération automatique des routes + lecture ciblée : `ai.js`, `sales-public.js`, `hr*.js`, `payroll-cm.js`, `integrations.js`, exports CSV), `src/ai/*`, `Dockerfile`, `render.yaml`, `package.json`, `scripts/backup.js`, `vercel.json` du site.

Méthodes : (1) énumération des **962 routes** de l'application Express par un script (`scripts/lib/routes.js`) puis sondage de chacune avec et sans connexion ; (2) 852 requêtes hostiles (injection SQL, chemins, nombres géants) sur 284 routes de lecture et 491 routes d'écriture ; (3) lecture des requêtes SQL (~365 requêtes `WHERE id = ?` sans `org_id` repérées automatiquement, relues par échantillon) ; (4) `npm audit` ; (5) relecture des prompts de l'IA.

## 2. Surfaces d'attaque cartographiées

| Surface | Exposition | Protection constatée |
|---|---|---|
| `/api/*` authentifiées (cookie `mia_token`, JWT HS256 + session en base) | Internet | `requireUser` : jeton signé **et** session non révoquée **et** compte non suspendu **et** mot de passe inchangé depuis l'émission |
| `/api/ws/orgs/:orgId/**` (837 routes) | Utilisateurs connectés | `loadOrg` : 404 si non-membre ; rôle par `A.need()` ; filtre d'antenne |
| `/api/admin/**` | Administrateur unique | Cookie `mia_admin` (12 h), limiteur, verrouillage, 2FA optionnelle |
| `/api/ws/public/**` (intake, chat public, CSAT, fichiers signés, agenda `.ics`, désabonnements) | Anonyme, jeton secret dans l'URL | Limites de débit, jetons aléatoires, fichiers à lien signé HMAC 15 min |
| Webhooks entrants Meta (`/webhooks/*`, `/api/webhooks/whatsapp`, `/api/ws/public/whatsapp|meta/:token`) | Anonyme | Signature `X-Hub-Signature-256` sur corps brut, comparaison à temps constant |
| Webhook Campay (`/api/payments/webhook/campay`) | Anonyme | Le contenu n'est jamais cru : l'état du paiement est relu chez Campay |
| API publique `/api/v1/*` | Clé d'API | Clés hachées (SHA-256), portée par clé |
| Webhooks **sortants** (adresse saisie par l'utilisateur) | Appels sortants | HTTPS public seulement, résolution DNS contrôlée à la connexion, pas de redirection, corps signé HMAC |
| WhatsApp par code QR (`waWeb.js`, Baileys, méthode **non officielle**) | Sessions longues | État d'authentification chiffré dans PostgreSQL (coffre), jamais sur disque |
| Assistant IA (site public, espace de travail, agent WhatsApp/Messenger/Instagram) | Anonyme et connecté | Quotas, blocs `<donnees>` déclarés « données, jamais instructions », prix issus du catalogue, commandes « à valider » |
| Pièces jointes de l'assistant (images, PDF, texte, 8 Mo) | Connecté | Taille, nombre, type annoncé (contenu **non** vérifié à l'origine) |
| Dockerfile / Render / Vercel | Déploiement | Utilisateur non root, `NODE_ENV=production`, secrets en variables d'environnement |

## 3. Ce qui est déjà solide (vérifié par test)

- **Aucune route non publique n'est accessible sans connexion** : sur 962 routes, 42 sont publiques (liste blanche explicite dans `scripts/test-security-routes.js`, chacune justifiée) ; les 920 autres répondent 401.
- **Isolation entre organisations** : 843 routes d'organisation répondent 404 à un étranger ; 45 contrôles d'accès par identifiant à des ressources réelles d'une autre organisation (clients, projets, stock, employés, budget, assistance, antennes, devis) sont tous refusés (`test-security-idor.js`).
- **Aucune injection SQL trouvée** : 852 requêtes avec `1' OR '1'='1'; SELECT pg_sleep(4);--` dans les identifiants et ~22 paramètres de requête ; aucune erreur serveur, aucun ralentissement. Les requêtes sont préparées ; les rares interpolations portent sur des noms de tables ou colonnes issus de constantes du code.
- **CSV** : toutes les générations neutralisent `=`, `+`, `-`, `@` (apostrophe) ; vérifié sur un client nommé `=HYPERLINK(…)`.
- **SSRF** : les webhooks sortants refusent adresses privées, `localhost`, redirections, identifiants dans l'URL ; les téléchargements de médias Meta n'acceptent que les domaines de Meta, sans redirection.
- **Signatures de webhooks** vérifiées sur le corps brut avec `timingSafeEqual` ; chaque échec compte des points d'abus.
- **Mots de passe** : bcrypt coût 12, comparaison à durée constante même si le compte n'existe pas, réponse identique « inconnu / mauvais mot de passe » et « mot de passe oublié ».
- **Sessions** : liste, fermeture par appareil, fermeture globale au changement de mot de passe, session fermée = accès refusé aussitôt.
- **CSRF** : contrôle de l'en-tête `Origin` sur toute écriture ; cookie `HttpOnly`, `SameSite=Lax`, `Secure` en production.
- **Double authentification** TOTP (RFC 6238) avec anti-rejeu et 10 codes de secours à usage unique ; secret chiffré en base.

## 4. Constats

Gravité : **Critique** (compromission directe), **Élevée**, **Moyenne**, **Faible**, **Information**. Les numéros de ligne désignent l'état **d'origine** du code (avant correction). « Test » = script qui échouait avant la correction et passe après.

**Aucun constat critique n'a été trouvé.**

### Élevée

**E1 — Dépendances vulnérables.** `package-lock.json` : `body-parser` < 1.20.9 (GHSA-27r3-jxmh-p828, déni de service par octets après un corps compressé — gravité *high* selon npm), `nodemailer` ≤ 10.1.3 (3 avis, analyse d'adresses : un destinataire peut être injecté dans l'en-tête), `qs` ≤ 6.16.0 (déni de service). *Preuve :* `npm audit --omit=dev` → 3 vulnérabilités. *Correction :* `npm audit fix` (body-parser 1.20.9, nodemailer 10.6.0, qs 6.16.2) → 0 vulnérabilité. **Corrigé.** *Reste :* relancer `npm audit` à chaque mise à jour ; aucun outil de surveillance continue n'est configuré (voir O8).

### Moyenne

**M1 — Aucun plafond de coût global pour l'IA publique.** `src/routes/assistant.js:11` : limite de 200 requêtes/jour **par adresse IP**, en mémoire (remise à zéro à chaque redémarrage, non partagée entre instances) ; la conversation publique d'une organisation (`sales-public.js`) n'avait qu'une limite par IP. Un attaquant avec beaucoup d'adresses pouvait faire monter la facture du fournisseur sans limite. *Correction :* `src/security/aibudget.js` — compteurs par jour dans PostgreSQL : plafond global (`AI_GLOBAL_DAILY_CAP`, 20 000), plafond du site (`AI_SITE_DAILY_CAP`, 1 500), plafond par organisation pour sa conversation publique (`AI_PUBLIC_ORG_DAILY_CAP`, 400), appliqués dans `claude.ask`. **Corrigé** — test `test-security-data.js` (3 appels : 200, 200, 429 ; plafond global atteint → 429 y compris pour une organisation connectée). *Limite :* le quota mensuel des organisations connectées existait déjà ; en cas de panne de la base, le compteur « laisse passer » (choix documenté : disponibilité).

**M2 — Frontière des blocs de données de l'IA franchissable.** `src/ai/sales-agent.js:53`, `src/workspace/ai.js:190`, `agents.js:99`, `memory.js:158` : le texte d'un tiers (nom d'un client WhatsApp, description, note) est inséré entre `<donnees>` et `</donnees>` sans neutralisation. Une donnée contenant `</donnees>` pouvait « sortir » du bloc et se présenter comme une consigne. L'impact était limité (l'IA ne fixe jamais un prix, les commandes sont « à valider »), mais la protection reposait sur la seule obéissance du modèle. *Correction :* `src/security/promptguard.js` — neutralisation des balises de bloc à l'intérieur des blocs (conserve la première ouverture et la dernière fermeture posées par le code) et dans les messages des utilisateurs, appliquée centralement dans `claude.ask` et aux pièces jointes texte. **Corrigé** — test (un bloc hostile avec 3 fermetures n'en garde qu'une ; le message reçu par le modèle contient `‹/donnees›`). *Limite :* aucune défense ne rend une injection de prompt impossible ; voir O3.

**M3 — Pièces jointes de l'assistant non vérifiées.** `src/workspace/ai.js:268` : le type (`image/png`, `application/pdf`…) est celui **annoncé par le navigateur** ; un exécutable ou un fichier binaire pouvait être transmis comme « PDF » ou « texte ». *Correction :* vérification de la signature (PNG, JPEG, GIF, WebP, `%PDF-`), du texte UTF-8 sans octet nul. **Corrigé** — tests (faux PNG, faux PDF `MZ…`, texte binaire refusés ; vrai PNG accepté). Les fixtures de `test-plan-margin.js` et `test-ai-attach.js` utilisaient des contenus factices : mises à jour avec de vraies signatures.

**M4 — Données sensibles en clair en base.** Secret de signature des webhooks sortants (`integrations.js:45`, `webhooks_out.secret`), matricule CNPS, NIU, compte bancaire/mobile money, numéro de CNI, téléphone d'urgence des employés (`hr.js:26`, `hr-w3.js`, `payroll-cm.js`). Une fuite de la base (sauvegarde, accès Neon) exposait ces valeurs. *Correction :* coffre étendu (`vault.js` : `encryptField` / `decryptField`, AES-256-GCM, clé dérivée distincte, préfixe `v2:`), lecture/écriture adaptées, mise à niveau idempotente des anciennes valeurs au démarrage (`security/encryption.js`), rotation de clé (`DATA_KEY_PREVIOUS` + `npm run security:rotate-keys`). **Corrigé** — tests (valeur chiffrée en base, lisible via l'API pour un administrateur, ancienne valeur en clair restée lisible puis chiffrée, altération → illisible). *Reste ouvert (O1) :* salaires, noms, téléphones, e-mails, dates de naissance, contenu des messages et des clients **ne sont pas chiffrés au niveau du champ** (ils servent aux recherches, tris et totaux SQL) ; ils sont protégés par le chiffrement du disque du fournisseur de base de données, pas par la clé de l'application.

**M5 — Journal d'audit : suppression des dernières lignes non détectable.** `src/security/audit.js:59` : la chaîne de hachage détecte une ligne modifiée ou supprimée **au milieu**, pas la suppression des **dernières** lignes, ni une chaîne entièrement recalculée par quelqu'un qui a accès à la base. *Correction :* points d'ancrage signés (HMAC) enregistrés chaque heure (`audit_checkpoints`) ; `verify()` contrôle la chaîne **et** chaque ancrage. **Corrigé** — tests : modification détectée ; suppression du dernier bloc détectée ; ancrage falsifié détecté. *Limite :* qui possède à la fois la base **et** la clé de l'application peut recalculer chaîne et ancrages ; pour une preuve forte, exporter régulièrement l'empreinte du dernier ancrage vers un support extérieur (O5).

**M6 — Corps volumineux lus avant la connexion.** `src/server.js:67` : les routes `ai/chat` (9 Mo) et d'import (2 Mo) analysaient le JSON **avant** de vérifier la connexion : un anonyme pouvait faire lire des mégaoctets. *Correction :* `requireUser` s'exécute avant l'analyseur de gros corps. **Corrigé** — test (3 Mo envoyés sans connexion → 401, corps jamais analysé).

**M7 — Sauvegardes écrites en clair.** `scripts/backup.js:25` : un fichier `.json.gz` contenant **toutes** les tables, sans chiffrement. *Correction :* chiffrement AES-256-GCM (`BACKUP_KEY`, sinon `DATA_KEY`), refus d'écrire en clair sans clé, `scripts/backup-decrypt.js`. **Corrigé** — tests (refus sans clé, fichier sans texte lisible, aller-retour, mauvaise clé → échec). *Reste ouvert (O6) :* aucune sauvegarde n'est planifiée dans le dépôt ni dans `render.yaml` (voir plan de continuité).

**M8 — Politique de mots de passe trop faible.** `src/services/security.js:11` : 8 caractères, liste de 30 mots de passe. *Correction :* règle de base conservée (8 caractères, liste étendue, nom/e-mail interdits) ; **règle stricte active en production** (ou `PASSWORD_POLICY=strict`) : 10 caractères minimum, deux sortes de caractères (ou 16+), suites de clavier refusées, mot courant suivi de chiffres refusé (« Cameroun2024 »). **Corrigé** — tests. *Note :* la liste de mots courants est courte et locale ; elle ne remplace pas une vérification contre une base de mots de passe compromis (par exemple l'API « k-anonymity » de Have I Been Pwned — non branchée, car elle envoie un préfixe de hachage à un tiers : décision à prendre, O7).

**M9 — Double authentification jamais proposée ni exigible.** Elle existait mais n'était ni recommandée aux propriétaires/administrateurs ni exigible par une organisation. *Correction :* `GET /api/security/overview` renvoie `twofa.recommended` ; un propriétaire qui l'a activée peut **exiger** la 2FA de ses administrateurs (`PUT /api/privacy/orgs/:id/require-2fa`) ; sans 2FA, un administrateur reçoit 403 `twofa_required` (il peut toujours aller l'activer). **Corrigé** — tests. *Reste :* elle n'est pas obligatoire par défaut (O2).

**M10 — Configuration de production trop tolérante.** `src/config.js:26` : `JWT_SECRET` accepté dès 16 caractères, `ADMIN_PASSWORD` dès 10, `ALLOWED_ORIGINS` pouvait contenir `*` ou une adresse `http://`. *Correction :* démarrage refusé en production sous 32 caractères (secret JWT), 12 (mot de passe administrateur), avec joker ou `http://` (hors machine locale). **Corrigé.** (Contrôle par lecture et exécution du démarrage ; aucun test automatique ne lance le serveur en `NODE_ENV=production`.)

**M11 — Suppression d'organisation incomplète.** `src/workspace/index.js:134` : 206 tables portent `org_id`, 6 sans liaison en cascade (`tmp_files`, `broadcast_sends`, `chat_media`, `decision_steps`, `acc_lines`, `audit_trail`). Des fichiers générés (voix) et d'autres lignes pouvaient subsister après « suppression ». *Correction :* effacement explicite des tables sans cascade dans la même transaction (le journal d'audit, volontairement, est conservé). **Corrigé** — test : une organisation avec client, employé et fichier temporaire est supprimée ; **0 ligne** subsiste dans les 206 tables.

**M12 — Droits des personnes non outillés.** Ni export, ni demande de suppression, ni consentements datés, ni durées de conservation paramétrables, ni registre des accès aux données sensibles. *Correction :* module `src/security/privacy.js` et routes `/api/privacy/*` (voir `docs/securite/legal/`). **Implémenté et testé** (`test-security-privacy.js`, 36 contrôles). *Reste :* pas d'interface pour qu'une personne **cliente d'une organisation** (et non utilisatrice de MABAH) exerce ses droits : elle s'adresse à l'organisation (responsable) — fonction à prévoir (O4).

### Faible

**F1 — Jetons secrets dans les journaux.** `src/server.js:54` : le chemin des requêtes (`/api/ws/public/chat/<jeton>/message`, `…/calendar/<jeton>.ics`) était écrit tel quel dans les journaux Render. *Correction :* `safePath` masque tout segment de 20+ caractères. **Corrigé** — test.

**F2 — Valeurs hors limites → erreur 500.** 12+ routes (identifiants de 23 chiffres) renvoyaient 500 : dépassement de bigint PostgreSQL. Pas d'injection, mais bruit d'alertes et signal de robustesse. *Correction :* le gestionnaire d'erreurs traduit les erreurs de valeur de PostgreSQL (`22003`, `22P02`, `22007`, `22008`, `22001`, `22021`) en 400. **Corrigé** — test de 852 requêtes.

**F3 — Réponses de l'API sans `Cache-Control` ni politique de contenu.** *Correction :* `no-store` et `Content-Security-Policy: default-src 'none'…; frame-ancestors 'none'` sur `/api`, HSTS 2 ans explicite, `Referrer-Policy: no-referrer`, `Permissions-Policy` complétée. **Corrigé** — test d'en-têtes.

**F4 — Verrouillage non progressif, pas d'alerte de connexion inhabituelle.** *Correction :* 15 min, puis 30 min, 1 h… jusqu'à 24 h (retombe après 24 h calmes) ; un appareil jamais vu déclenche un message dans l'application, un e-mail (si possible) et une ligne d'audit. **Corrigé** — tests.

**F5 — Rejeu des webhooks Meta.** Les signatures sont vérifiées, mais sans horodatage : une requête signée interceptée peut être rejouée ; l'anti-doublon (`makeSeen`) est **en mémoire** (perdu au redémarrage, non partagé). L'impact est limité (messages dupliqués). **Ouvert** (O9).

**F6 — Sessions de 30 jours sans expiration d'inactivité.** `middleware/auth.js`. **Ouvert** (O10) — compromis confort/sécurité à décider.

**F7 — Inscription : « compte déjà existant » (409).** Permet de tester si une adresse a un compte. Compromis assumé ; atténué par la limite de débit. **Ouvert, accepté.**

**F8 — Dockerfile.** Utilisateur non root déjà présent ; `chown -R` dupliquait la couche (remplacé par `COPY --chown`) ; image non épinglée par empreinte ; `.dockerignore` complété (docs, tests). **Partiellement corrigé** ; épingler `node:20-bookworm-slim@sha256:…` à chaque version (O8).

**F9 — Site (Vercel) sans `Content-Security-Policy`.** `site/vercel.json` ne définit que `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`. Une politique stricte demande de tester toutes les pages (polices, scripts, WhatsApp, vidéos) : **Ouvert** (O11) ; démarrer par `Content-Security-Policy-Report-Only`.

**F10 — Journal d'audit jamais purgé et contenant des adresses IP.** La chaîne interdit de supprimer des lignes. Les adresses IP et navigateurs y restent sans limite de durée. **Ouvert** (O12) : prévoir une rotation de segments (clôture et archivage chiffré) ou ne conserver que des empreintes d'IP.

**F11 — Identité de l'administrateur.** `render.yaml` fixe `ADMIN_USERNAME=admin` (identifiant prévisible) ; compte administrateur unique et partagé. Le contrôle de configuration le signale. **Ouvert** (O13).

**F12 — Coordonnées personnelles par défaut dans le code.** `src/config.js:84-85` (e-mail et numéro WhatsApp du fondateur) et `src/services/claude.js:22` (consigne de l'assistant du site). Information publique de contact, mais mieux vaut des variables d'environnement. **Ouvert, information.**

### Information

- **WhatsApp par code QR** (Baileys) est une méthode **non officielle** : risque de restriction du numéro par WhatsApp, protocole susceptible de changer. À signaler aux clients (fait dans les conditions d'utilisation) et à préférer l'API officielle pour les usages critiques.
- Les ~283 requêtes `UPDATE/DELETE … WHERE id = ?` sans `org_id` sont **sûres par construction** tant que la ligne a été chargée par une fonction d'accès vérifiant l'organisation ; la défense en profondeur (ajouter `AND org_id = ?` partout) est recommandée, avec la liste dans l'historique de cet audit (O14).
- Les sessions WhatsApp par QR sont fermées à la suppression d'une organisation ; leurs clés sont chiffrées en base.

## 5. Constats ouverts (récapitulatif)

| N° | Sujet | Gravité | Action proposée |
|---|---|---|---|
| O1 | Chiffrement au niveau du champ pour salaires, noms, téléphones, messages | Moyenne | Chiffrer les champs non recherchables ; sinon s'appuyer sur le chiffrement du fournisseur et le documenter |
| O2 | 2FA non obligatoire par défaut | Moyenne | Rendre obligatoire pour propriétaires/administrateurs après une période de transition |
| O3 | Injection de prompt : aucune défense absolue | Information | Garder l'humain dans la boucle pour toute action sensible (déjà le cas) ; tests d'évaluation (`npm run eval:ai`) |
| O4 | Droits des clients finaux des organisations | Moyenne | Modèle de procédure + export par personne côté organisation |
| O5 | Preuve forte du journal d'audit | Faible | Exporter l'empreinte du dernier ancrage hors du serveur |
| O6 | Sauvegardes planifiées et restauration testée | Moyenne | Voir `docs/securite/legal/fr/10-plan-continuite-sauvegarde.md` |
| O7 | Vérification contre les mots de passe compromis | Faible | Décider d'un service tiers (anonymisé) |
| O8 | Surveillance continue des dépendances ; image Docker épinglée | Faible | Dependabot/`npm audit` en intégration continue |
| O9 | Rejeu des webhooks Meta | Faible | Dédoublonnage durable en base par identifiant de message |
| O10 | Expiration d'inactivité des sessions | Faible | Décision produit |
| O11 | CSP du site | Faible | `Report-Only` d'abord |
| O12 | Durée de conservation des IP dans l'audit | Faible | Rotation de segments |
| O13 | Compte administrateur unique | Faible | Plusieurs comptes nominatifs avec 2FA |
| O14 | `AND org_id = ?` partout | Faible | Refactorisation progressive |

## 6. Ce qui exige un audit externe

- **Test d'intrusion** indépendant (application web, API, WhatsApp par QR, infrastructure Render/Neon/Vercel).
- **Revue cryptographique** de l'usage de l'AES-GCM (dérivation par scrypt d'un secret unique, rotation) et du TOTP.
- **Audit de conformité** à la protection des données : base légale de chaque traitement, contrats avec chaque sous-traitant (existence et contenu réels des accords, clauses de transfert), analyse d'impact si exigée.
- **Évaluation de l'hébergeur** : région réelle de la base Neon et de Render, chiffrement au repos, sauvegardes et durées de conservation du fournisseur (non vérifiables depuis le dépôt).
- **Contrôle juridique** des textes légaux (voir le rapport de livraison).

## 7. Comment rejouer

```bash
npm run test:security     # 5 scripts : routes, authentification, données, confidentialité, entrées hostiles
npm test                  # toute la suite (dont la sécurité)
npm run security:check    # contrôle de la configuration (variables d'environnement)
npm audit --omit=dev      # dépendances
```
