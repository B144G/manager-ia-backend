# Brij-IA : serveur (backend)

## GUIDE COMPLET : mettre Brij-IA en ligne (base de données, serveur, site)

Trois services, tous créés par **vous** avec **vos** comptes (ne donnez jamais vos mots de passe ni vos clés à personne, ni dans un chat) :

```
Visiteurs ──► Vercel (le site React : manager-ia-frontend)
                │  tout ce qui commence par /api est transmis au serveur
                ▼
              Render (le serveur Node.js : manager-ia-backend) ──► Neon (la base PostgreSQL)
```

| Service | Rôle | Dépôt GitHub | Prix de départ |
|---|---|---|---|
| **Neon** | base de données PostgreSQL | — | offre gratuite (sans carte) ; la base se met en veille quand elle n'est pas utilisée |
| **Render** | serveur (API, assistant, WhatsApp, paiements) | `manager-ia-backend` | offre gratuite (le serveur s'endort après ~15 min sans visite) ; offre payante « Starter » pour un serveur toujours réveillé |
| **Vercel** | le site que voient les visiteurs | `manager-ia-frontend` | offre gratuite « Hobby » (réservée à un usage **non commercial** : pour une activité commerciale, prévoyez l'offre Pro) |

> Les prix et limites changent : vérifiez-les sur les sites de chaque service avant de choisir. Pour une vraie activité (clients, paiements, WhatsApp), prévoyez un serveur Render payant : un serveur qui dort répond lentement et peut rater des messages WhatsApp.

Durée : environ 45 minutes la première fois. **Suivez l'ordre : Neon → Render → Vercel → réglages finaux.**

---

### Étape 0 : préparer (10 min)

1. **Fusionnez le code sur GitHub.** Pour chaque dépôt (`manager-ia-backend` et `manager-ia-frontend`) : onglet *Pull requests* → la demande de la branche `claude/postgres-react` → **Merge pull request**. Sans cela, Render et Vercel déploieraient l'ancienne version.
2. **Créez vos comptes** (inscription avec votre e-mail, vous-même) : <https://neon.tech>, <https://render.com>, <https://vercel.com>. Choisissez « Continue with GitHub » pour Render et Vercel : cela leur permet de lire vos dépôts.
3. **Préparez 3 secrets** (sur votre ordinateur, dans un terminal). Notez-les dans un gestionnaire de mots de passe, jamais dans un fichier du projet :
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # à lancer 2 fois : JWT_SECRET puis DATA_KEY
   ```
   - `JWT_SECRET` : protège les connexions.
   - `DATA_KEY` : chiffre les jetons WhatsApp/Meta et les secrets de double authentification. **Ne la changez plus jamais ensuite** (les jetons déjà enregistrés deviendraient illisibles).
   - `ADMIN_PASSWORD` : choisissez une phrase longue (12 caractères minimum, mélangés) et un `ADMIN_USERNAME` pas trop prévisible (évitez « admin »).

---

### Étape 1 : la base de données sur Neon (5 min)

1. Sur <https://console.neon.tech> : **New Project**. Nom : `manager-ia`. Région : choisissez la plus proche de vos clients, par exemple **AWS Europe (Francfort)**. Notez-la : vous prendrez la même région sur Render.
2. Une fois le projet créé, cliquez sur le bouton **Connect**. Une fenêtre affiche une adresse commençant par `postgresql://…`.
3. Il vous faut **deux adresses**, en basculant l'option **« Connection pooling »** :
   - **Pooled connection** (option activée, l'adresse contient `-pooler`) → ce sera `DATABASE_URL`.
   - **Direct connection** (option désactivée, sans `-pooler`) → ce sera `DATABASE_URL_UNPOOLED`.
   Copiez-les dans votre gestionnaire de mots de passe. **Elles contiennent le mot de passe de la base : ne les publiez jamais** (ni dans GitHub, ni dans un message).
4. (Facultatif mais conseillé) Testez depuis votre ordinateur, dans le dossier `manager-ia-backend` :
   ```bash
   npm install
   DATABASE_URL='collez-ici-l-adresse-pooled' JWT_SECRET=test npm run db:check
   ```
   Vous devez voir « Connexion OK ». Les tables se créeront toutes seules au premier démarrage du serveur : **rien à créer à la main**.

> Vous avez déjà des données dans l'ancienne base SQLite ? Une seule fois, sur une base Neon vide : `npm i --no-save better-sqlite3` puis `npm run db:import-sqlite -- chemin/vers/manager-ia.db`. L'ancien fichier n'est jamais modifié.

---

### Étape 2 : le serveur sur Render (15 min)

**Méthode rapide (recommandée) : Blueprint.** Le fichier `render.yaml` du dépôt décrit tout.

1. Sur <https://dashboard.render.com> : **New +** → **Blueprint** → choisissez le dépôt `manager-ia-backend` → **Connect**.
2. Render lit `render.yaml` et vous demande les valeurs « secrètes ». Saisissez-les **vous-même** :

| Variable | Valeur à saisir |
|---|---|
| `DATABASE_URL` | l'adresse **Pooled** de Neon |
| `DATABASE_URL_UNPOOLED` | l'adresse **Direct** de Neon |
| `ADMIN_PASSWORD` | votre mot de passe administrateur (12+ caractères) |
| `SITE_URL`, `ALLOWED_ORIGINS`, `API_PUBLIC_URL` | laissez vide pour l'instant : vous les remplirez à l'étape 4 |
| `ANTHROPIC_API_KEY` | votre clé d'IA (facultatif pour démarrer ; vous pourrez l'ajouter plus tard) |

   `JWT_SECRET` et `DATA_KEY` sont **générés automatiquement** par Render (vous pouvez les remplacer par ceux de l'étape 0). Déjà réglés pour vous : `NODE_ENV=production`, `TRUST_PROXY=2`, `COOKIE_SAMESITE=lax`, `ADMIN_USERNAME`.
3. Choisissez la **région** (la même que Neon, par exemple Francfort) et l'offre (voir le tableau plus haut). Cliquez **Apply** / **Deploy**.

**Méthode manuelle (si vous ne voulez pas du Blueprint) :** **New +** → **Web Service** → dépôt `manager-ia-backend`. Runtime **Node**, *Build Command* `npm ci --omit=dev --omit=optional`, *Start Command* `node src/server.js`, *Health Check Path* `/api/health`. Ajoutez ensuite les variables du tableau ci-dessus et celles de l'étape 4 dans l'onglet **Environment**.

4. Attendez que l'état passe à **Live** (3 à 5 minutes la première fois). Le journal (*Logs*) doit afficher « Brij-IA démarré… » puis « Base de données : PostgreSQL ».
5. **Notez l'adresse de votre serveur**, en haut de la page du service, par exemple `https://manager-ia-backend.onrender.com`.
6. **Testez** en ouvrant dans le navigateur `https://VOTRE-SERVEUR.onrender.com/api/health` : la réponse doit être `{"ok":true,"db":true}`. (Si le serveur dormait, la première réponse peut prendre 30 à 60 secondes.)

---

### Étape 3 : le site sur Vercel (10 min)

1. **Indiquez l'adresse de votre serveur Render au site.** Dans le dépôt `manager-ia-frontend`, ouvrez le fichier `vercel.json` et remplacez `https://VOTRE-SERVEUR.onrender.com` par l'adresse notée à l'étape 2 (ligne `"destination": "https://…/api/:path*"`). Modifiez-le directement sur GitHub (icône crayon → *Commit changes*) ou chez vous, puis :
   ```bash
   cd ~/Downloads/manager-ia-frontend
   git add vercel.json && git commit -m "Adresse du serveur" && git push
   ```
   C'est ce réglage qui permet au site et au serveur de se comporter comme **un seul site** (indispensable pour que la connexion fonctionne partout, y compris sur iPhone/Safari).
2. Sur <https://vercel.com/new> : **Import** le dépôt `manager-ia-frontend`.
3. Vercel détecte **Vite** tout seul (commande `npm run build`, dossier `dist`). Ne changez rien. **Aucune variable n'est obligatoire.** Cliquez **Deploy**.
4. À la fin, Vercel affiche l'adresse de votre site, par exemple `https://manager-ia-frontend.vercel.app`. **Notez-la.**

---

### Étape 4 : relier le serveur et le site (5 min)

Retournez sur **Render** → votre service → **Environment** et renseignez (sans `/` à la fin) :

| Variable | Valeur | Pourquoi |
|---|---|---|
| `SITE_URL` | `https://votre-site.vercel.app` | liens des e-mails (mot de passe oublié…) |
| `ALLOWED_ORIGINS` | `https://votre-site.vercel.app` | le serveur n'accepte que les requêtes venant de votre site |
| `API_PUBLIC_URL` | `https://VOTRE-SERVEUR.onrender.com` | liens de médias et adresses de webhook affichées dans l'application |
| `TRUST_PROXY` | `2` | Vercel puis Render : sans cela, tous les visiteurs auraient la même adresse IP et les protections seraient faussées |
| `COOKIE_SAMESITE` | `lax` | connexion fiable (cookies « du même site ») |

Enregistrez : Render redéploie automatiquement (1 à 3 minutes).

---

### Étape 5 : vérifier que tout marche (10 min)

1. Ouvrez `https://votre-site.vercel.app/api/health` : `{"ok":true,"db":true}` (cette réponse vient du serveur *à travers* Vercel : le lien fonctionne).
2. Ouvrez `https://votre-site.vercel.app` : la page de présentation s'affiche.
3. **Créez un compte** (Inscription), puis créez votre organisation : vous arrivez dans l'espace de travail.
4. Ouvrez-le **sur votre téléphone** (iPhone et Android si possible) : menu ☰, une page, un formulaire.
5. **Administration** : `https://VOTRE-SERVEUR.onrender.com/admin` (l'administration est servie par le serveur, pas par Vercel). Identifiant et mot de passe de l'étape 0.
6. Dans **Sécurité**, activez la **double authentification** de l'administrateur (scannez avec Google Authenticator, Microsoft Authenticator, Authy…) et **notez les 10 codes de secours** hors ligne.

---

### Étape 6 : brancher les services (quand vous êtes prêt)

À faire **dans Render → Environment** (les clés se saisissent là, jamais dans un chat ni dans GitHub) :

| Fonction | Variables | Détail |
|---|---|---|
| **IA (Anthropic)** | `ANTHROPIC_API_KEY` | l'assistant et les propositions de l'IA ; le coût dépend de l'usage |
| **E-mails** (code d'inscription, mot de passe oublié) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | avec Gmail : mot de passe d'application (voir la section 5 du README du dépôt `manager-ia-backend`) ; active la vérification de l'e-mail à l'inscription |
| **Paiement manuel / Mobile Money** | `MTN_NUMBER`, `ORANGE_NUMBER`, `PAYMENT_HOLDER_NAME` | les numéros affichés aux clients |
| **Paiement automatique** | `CAMPAY_USERNAME`, `CAMPAY_PASSWORD` | voir la section 6 du README du dépôt `manager-ia-backend` |
| **Notifications administrateur** | `ADMIN_EMAIL`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_TEMPLATE` | voir la section 5 du README du dépôt `manager-ia-backend` |
| **WhatsApp, Messenger, Instagram** | `META_APP_SECRET`, `META_VERIFY_TOKEN` | voir la section 7 du README du dépôt `manager-ia-backend` |

**Adresses de webhook** (à coller chez Meta / Campay) : elles pointent vers **Render**, pas vers Vercel. Exemples : `https://VOTRE-SERVEUR.onrender.com/webhooks/whatsapp` et `https://VOTRE-SERVEUR.onrender.com/webhooks/meta`. Pour le WhatsApp **de chaque organisation**, l'adresse exacte s'affiche dans l'application (sous-application *Assistant commercial* → *Canaux*), à condition que `API_PUBLIC_URL` soit réglée.

---

### Étape 7 : votre propre nom de domaine (facultatif)

1. Achetez un domaine (chez le registrar de votre choix).
2. **Vercel** → votre projet → **Settings → Domains** → ajoutez `votre-domaine.com` et suivez les enregistrements DNS indiqués (le certificat HTTPS est automatique).
3. Sur **Render**, remplacez `SITE_URL` et `ALLOWED_ORIGINS` par `https://votre-domaine.com` (et `https://www.votre-domaine.com` si vous l'utilisez, séparés par une virgule).
4. Sur **Render** → **Settings → Custom Domains**, vous pouvez aussi donner un domaine au serveur (ex. `api.votre-domaine.com`) : mettez-le dans `API_PUBLIC_URL` et dans `vercel.json`.

---

### Étape 8 : mises à jour, sauvegardes, surveillance

- **Mettre à jour le site ou le serveur** : poussez le code sur la branche principale de GitHub (`git push`) ; Render et Vercel redéploient tout seuls. Les tables de la base se mettent à jour automatiquement au démarrage (migrations numérotées).
- **Revenir en arrière** : Render → *Events/Deploys* → *Rollback* ; Vercel → *Deployments* → *Promote to Production* sur une version précédente.
- **Sauvegardes** : Neon garde un historique restaurable (*Restore* : revenir à un instant précis) et permet de créer une **branche** (copie instantanée) avant une grosse modification. En plus, `npm run backup` écrit une copie compressée de toutes les tables dans `data/backups/` : programmez-la chaque nuit si vous avez un ordinateur toujours allumé, et copiez le dossier **ailleurs**.
- **Surveillance** : Render → *Logs*. Dans l'administration, l'écran **Sécurité** montre le journal d'audit, les adresses bloquées et l'état de la configuration (`npm run security:check` donne le même contrôle en ligne de commande).

---

### Dépannage

| Symptôme | Cause probable | Que faire |
|---|---|---|
| Le serveur ne démarre pas, journal : « DATABASE_URL manquant » | variable absente ou mal collée | Render → Environment : recollez l'adresse **Pooled** de Neon (commence par `postgresql://`) |
| « Origine non autorisée » à l'inscription ou à la connexion | `ALLOWED_ORIGINS` ne contient pas l'adresse exacte du site | mettez l'adresse Vercel **sans** `/` à la fin (et avec `https://`) |
| La connexion ne « tient » pas (déconnecté tout de suite) | `vercel.json` ne renvoie pas `/api` vers Render, ou `COOKIE_SAMESITE`/`TRUST_PROXY` mal réglés | vérifiez l'adresse dans `vercel.json`, puis `COOKIE_SAMESITE=lax` et `TRUST_PROXY=2` |
| Premier chargement très lent (30–60 s) | serveur Render gratuit endormi, ou base Neon en veille | normal sur l'offre gratuite ; prenez l'offre payante pour un serveur toujours réveillé |
| `/api/health` répond `db:false` | base inaccessible | vérifiez les adresses Neon (pooled), que le projet n'est pas suspendu, et la région |
| Page blanche ou 404 en ouvrant directement `/app/…` | le site n'a pas été déployé depuis le bon dépôt | le fichier `vercel.json` (redirections) doit être à la racine du dépôt déployé |
| Message « Trop de requêtes » (429) | limite de débit atteinte (ou adresse bloquée) | attendez quelques minutes ; administration → Sécurité → *Adresses bloquées* pour débloquer |
| Les e-mails n'arrivent pas | SMTP non configuré | renseignez les variables `SMTP_*` (section 5 du README du backend) ; l'inscription fonctionne sans e-mail, mais sans vérification |
| Les messages WhatsApp n'arrivent pas | adresse de webhook ou jeton incorrects, ou serveur endormi | vérifiez l'adresse (Render, pas Vercel), `META_APP_SECRET`, et prenez un serveur toujours réveillé |

---

### Check-list finale

- [ ] Les deux dépôts sont fusionnés dans la branche principale
- [ ] Neon : projet créé, deux adresses (pooled et directe) notées en lieu sûr
- [ ] Render : service **Live**, `/api/health` répond `{"ok":true,"db":true}`
- [ ] Vercel : site déployé, `vercel.json` pointe vers l'adresse Render
- [ ] Render : `SITE_URL`, `ALLOWED_ORIGINS`, `API_PUBLIC_URL`, `TRUST_PROXY=2`, `COOKIE_SAMESITE=lax` réglés
- [ ] Inscription, création d'organisation et connexion testées, sur ordinateur **et** téléphone
- [ ] Administration : double authentification activée, codes de secours notés
- [ ] `npm run security:check` : aucun point « dangereux »
- [ ] Les jetons GitHub utilisés pour pousser le code sont supprimés
- [ ] Un essai réel de chaque service branché (IA, e-mail, WhatsApp, paiement) a été fait

---

### Annexe : essayer sur votre ordinateur (sans rien mettre en ligne)

```bash
# 1) Le serveur (dossier manager-ia-backend) : il a besoin d'une base PostgreSQL (un projet Neon gratuit suffit pour les essais)
cd manager-ia-backend
npm run setup                 # crée .env avec des secrets aléatoires et affiche le mot de passe administrateur
# ouvrez .env et collez DATABASE_URL (adresse Neon), puis :
npm install
npm start                     # http://localhost:3000   (si le port 3000 est pris : PORT=3100 dans .env)

# 2) Le site (autre terminal, dossier manager-ia-frontend)
cd manager-ia-frontend
npm install
cp .env.example .env          # DEV_API_TARGET = adresse du serveur local
npm run dev                   # http://localhost:5173
```

Vite renvoie les appels `/api` vers le serveur local : le navigateur ne voit qu'un seul site, la connexion fonctionne sans réglage. Les tests automatiques (`npm test` dans le backend) démarrent leur propre base PostgreSQL jetable : rien à installer.

## GUIDE WHATSAPP : obtenir les identifiants (Phone number ID, jeton, secret) et brancher Brij-IA

> **Les écrans de Meta changent souvent** : les noms des menus ci-dessous sont ceux de la dernière version connue, vos écrans peuvent différer légèrement. Tout se fait avec **votre** compte Meta. Ne collez jamais un jeton ou un secret dans un chat, un e-mail ou GitHub : seulement dans les champs prévus (Render, ou l'écran *Canaux* de l'application).

### Deux usages de WhatsApp dans Brij-IA (ne les confondez pas)

| | **A. Notifications pour vous (administrateur)** | **B. Assistant commercial d'une entreprise** |
|---|---|---|
| À quoi ça sert | vous recevez un message WhatsApp à chaque inscription, contact, paiement | l'IA répond aux clients de l'entreprise, prend les commandes, relance |
| Où se saisissent les valeurs | variables d'environnement du serveur (Render) | écran **Assistant commercial → Canaux → WhatsApp** de l'application |
| Adresse de rappel (webhook) | `https://VOTRE-SERVEUR/webhooks/whatsapp` (jeton = `META_VERIFY_TOKEN`) | affichée dans l'écran *Canaux* (un jeton propre à chaque organisation) |

Vous pouvez faire A seul, B seul, ou les deux. Pour **A**, il faut en plus créer le modèle `nouvelle_notification` (voir la section 5 du README du dépôt `manager-ia-backend`) et renseigner `ADMIN_WHATSAPP` et `WHATSAPP_TEMPLATE`.

> **À savoir (important)** : une application Meta n'a **qu'une seule adresse de rappel** pour WhatsApp. Chaque organisation qui active l'assistant commercial utilise donc **sa propre application Meta** (ou celle de son entreprise), avec son propre secret et son propre numéro. Pour vos clients, ce sont eux qui créent leur application en suivant ce guide.

---

### Étape 1 : le compte Meta Business (10 min)

1. Créez ou ouvrez votre compte sur <https://business.facebook.com> (« portefeuille d'entreprise » / *Business portfolio*). Renseignez le nom légal de l'entreprise, son adresse et son site : Meta les revérifie plus tard.
2. Créez un compte développeur sur <https://developers.facebook.com> (avec le même compte Facebook), et acceptez les conditions.

### Étape 2 : créer l'application Meta avec WhatsApp (10 min)

1. <https://developers.facebook.com/apps> → **Créer une application**.
2. Cas d'utilisation : choisissez **« Se connecter avec les clients sur WhatsApp »** (ou, selon l'écran, type **Entreprise** puis **Ajouter le produit WhatsApp**). Nommez-la (ex. `Brij-IA Boutique Awa`) et **rattachez-la à votre portefeuille d'entreprise**.
3. Dans le menu de gauche : **WhatsApp → Configuration de l'API** (*API Setup*). Cette page est votre tableau de bord de départ. Meta vous y donne **gratuitement** :
   - un **numéro de test** ;
   - le **Phone number ID** (identifiant du numéro) ;
   - le **WhatsApp Business Account ID** ;
   - un **jeton temporaire** (valable ~24 h : bon pour un premier essai seulement).
4. Dans le même écran, section **« À »** (*To*) : ajoutez **votre numéro personnel** comme destinataire de test. Meta vous envoie un code par WhatsApp pour le confirmer. **Tant que l'application est en mode développement, le numéro de test ne peut écrire qu'à ces numéros** (5 maximum).

### Étape 3 : où trouver chaque valeur

| Valeur demandée par Brij-IA | Où la trouver chez Meta | Où la mettre dans Brij-IA |
|---|---|---|
| **Phone number ID** (chiffres, ex. `106540352242922`) | WhatsApp → Configuration de l'API, sous le numéro d'envoi (ne confondez pas avec le *numéro de téléphone* ni avec le *WhatsApp Business Account ID*) | A : `WHATSAPP_PHONE_ID` · B : champ « Identifiant du numéro » |
| **Numéro WhatsApp** | le numéro lui-même, avec l'indicatif, sans `+` ni espaces : `237677112233` | B : champ « Numéro » |
| **Jeton d'accès permanent** | voir l'étape 4 ci-dessous | A : `WHATSAPP_TOKEN` · B : champ « Jeton d'accès » |
| **Secret de l'application** | Paramètres de l'application → **Paramètres → Général** → *Clé secrète de l'application* → **Afficher** (Meta peut redemander votre mot de passe) | A : `META_APP_SECRET` · B : champ « Secret de l'application » |
| **Jeton de vérification du webhook** | **vous l'inventez** (phrase longue, lettres et chiffres) pour A ; pour B, il est **généré et affiché** par l'écran *Canaux* | A : `META_VERIFY_TOKEN` (et le même chez Meta) · B : à copier chez Meta |
| **Adresse de rappel (webhook)** | c'est Brij-IA qui la fournit (voir l'étape 6) | à coller chez Meta |

### Étape 4 : le jeton d'accès PERMANENT (10 min)

Le jeton de la page « Configuration de l'API » **expire en 24 heures** : ne l'utilisez que pour tester. Pour un vrai usage, créez un jeton permanent :

1. <https://business.facebook.com/settings> → **Utilisateurs → Utilisateurs système** → **Ajouter** → nom `manager-ia`, rôle **Administrateur**.
2. Sélectionnez cet utilisateur système → **Ajouter des actifs** :
   - **Applications** : votre application → contrôle total (*Gérer l'application*) ;
   - **Comptes WhatsApp** : votre compte WhatsApp Business → contrôle total.
3. **Générer un jeton** → choisissez votre application → durée **Jamais** (*Never expires*) → cochez les autorisations **`whatsapp_business_messaging`** et **`whatsapp_business_management`** → **Générer**.
4. **Copiez le jeton tout de suite** (Meta ne le réaffiche plus) et mettez-le directement dans Render (A) ou dans l'écran *Canaux* (B). S'il fuit : supprimez-le et régénérez-en un.

### Étape 5 : brancher votre vrai numéro (quelques jours)

Pour répondre à de **vrais clients** (et non plus seulement à 5 numéros de test) :

1. **WhatsApp → Configuration de l'API → Ajouter un numéro de téléphone** (ou *WhatsApp Manager → Numéros de téléphone*). Le numéro **ne doit pas être inscrit dans l'application WhatsApp classique** (ni WhatsApp Business sur téléphone) : sinon, supprimez d'abord ce compte WhatsApp.
2. Choisissez le **nom d'affichage** (le nom de votre entreprise, qui doit correspondre à votre site/marque) : Meta l'approuve.
3. **Vérifiez le numéro** par SMS ou appel (code à 6 chiffres), puis créez un **code PIN à 6 chiffres** (validation en deux étapes) : notez-le.
4. Mettez à jour dans Brij-IA le **Phone number ID** et le **numéro** (ceux du numéro réel, pas ceux du numéro de test).
5. **Passez l'application en mode « Live »** (interrupteur en haut du tableau de bord de l'application) et **vérifiez votre entreprise** : *Business Settings → Centre de sécurité → Vérification de l'entreprise* (documents d'immatriculation). Sans cette vérification, le nombre de clients contactés par jour reste limité.
6. **Moyen de paiement** : *WhatsApp Manager → Paramètres de paiement* : Meta facture ses « conversations ». Vérifiez les tarifs de votre pays sur le site de Meta avant toute campagne.

### Étape 6 : l'adresse de rappel (webhook) : recevoir les messages

C'est ce qui permet à Meta d'envoyer chaque message de client à votre serveur. **Le serveur doit être en ligne, en https.**

1. **Usage B (assistant d'une entreprise)** : dans l'application, **Assistant commercial → Canaux → WhatsApp**, saisissez le Phone number ID, le numéro, le jeton permanent et le secret de l'application, puis **Enregistrer**. L'écran affiche alors l'**adresse de rappel** et le **jeton de vérification**. (Pour que l'adresse soit la bonne, `API_PUBLIC_URL` doit valoir l'adresse Render.)
   **Usage A (notifications pour vous)** : adresse `https://VOTRE-SERVEUR.onrender.com/webhooks/whatsapp` et le jeton `META_VERIFY_TOKEN` que vous avez inventé.
2. Chez Meta : **WhatsApp → Configuration** → section **Webhook** → **Modifier** → collez l'**adresse de rappel** et le **jeton de vérification** → **Vérifier et enregistrer**.
   - Si Meta refuse : adresse non https, serveur endormi (réveillez-le en ouvrant `/api/health`), ou jeton différent.
3. Sous **Champs du webhook**, cliquez **Gérer** et **abonnez le champ `messages`** (c'est lui qui apporte les messages des clients).
4. Dans Brij-IA, cliquez **Tester la connexion** : le nom affiché du numéro doit apparaître.

### Étape 7 : premier essai (5 min)

1. Dans *Réglages* de l'assistant commercial : **activez l'assistant public**. Vérifiez que le serveur a la clé d'IA (`ANTHROPIC_API_KEY`) : sans elle, l'assistant ne répond pas.
2. Depuis **votre téléphone** (numéro ajouté à la liste de test), écrivez au numéro WhatsApp de l'entreprise : « Bonjour, c'est combien ? ». L'IA doit répondre avec les prix du catalogue.
3. Essayez un **message vocal** et une **photo** : ils sont compris (transcription et lecture de l'image).
4. Faites une commande : elle apparaît dans *Commandes* « à valider ».

### Étape 8 : les modèles de message (obligatoires pour les relances)

WhatsApp interdit d'écrire à un client **plus de 24 heures après son dernier message**, sauf avec un **modèle approuvé par Meta**. Brij-IA en utilise trois (créez-les dans *WhatsApp Manager → Modèles de message → Créer un modèle*, langue **Français**, un nom en minuscules sans espace) :

| Usage dans Brij-IA | Catégorie Meta | Texte du modèle (variables `{{1}}`…) |
|---|---|---|
| **Relance d'un prospect** (2 variables) | Utilitaire ou Marketing | `Bonjour {{1}}, c'est {{2}}. Vous nous avez écrit récemment : souhaitez-vous que nous reprenions votre demande ?` |
| **Rappel de facture impayée** (4 variables) | Utilitaire | `Bonjour {{1}}, la facture {{2}} de {{4}} présente un reste à payer de {{3}}. Merci de régulariser dès que possible.` |
| **Rappel de rendez-vous** (4 variables) | Utilitaire | `Bonjour {{1}}, rappel : votre rendez-vous est prévu le {{2}} à {{3}} chez {{4}}.` |

1. Meta demande un **exemple** de chaque variable (ex. `Awa`, `F-2026-0007`, `15 000 FCFA`, `Boutique Awa`).
2. Attendez le statut **Approuvé** (minutes à quelques heures).
3. Dans Brij-IA : **Assistant commercial → Relances → Ajouter un modèle** : saisissez **le nom exact**, la langue, l'usage et le texte (aperçu). Le nombre de variables est contrôlé.
4. Le client qui écrit **STOP** n'est plus jamais relancé.

### Étape 9 : suivre la qualité et les limites

- **Palier d'envoi** : au départ, un nombre limité de clients « nouveaux » par jour ; il augmente avec la vérification de l'entreprise et la qualité de vos messages. Si trop de clients bloquent ou signalent vos messages, Meta réduit vos droits : **ne relancez que ceux qui ont écrit**.
- **Pas d'appels vocaux** : seuls les messages (écrits, vocaux, images, PDF) sont gérés.
- **Fenêtre de 24 h** : l'IA répond librement pendant 24 h après le message du client ; après, seulement avec un modèle approuvé.

### Dépannage WhatsApp

| Symptôme | Cause probable | Que faire |
|---|---|---|
| Meta refuse l'adresse de rappel | serveur endormi / non https / mauvais jeton de vérification | ouvrez `/api/health` pour réveiller Render ; recopiez le jeton exact |
| Aucun message n'arrive | champ **`messages`** non abonné, application pas en « Live », ou numéro de l'expéditeur absent de la liste de test | abonnez `messages` ; ajoutez le numéro à la liste de test ; passez l'app en Live |
| Journal du serveur : « signature invalide » | **secret de l'application** faux (ou celui d'une autre application) | recopiez la *clé secrète* depuis Paramètres → Général |
| « Meta a refusé la connexion » au test | jeton expiré (24 h) ou sans les autorisations `whatsapp_business_*`, ou mauvais Phone number ID | régénérez un jeton permanent (étape 4) ; vérifiez l'identifiant |
| Erreur « destinataire non autorisé » (#131030) | application en développement et numéro hors liste de test | ajoutez-le à la liste, ou passez en Live |
| Erreur « hors fenêtre de 24 h » (#131047) | le client n'a pas écrit depuis plus de 24 h | utilisez un **modèle approuvé** (étape 8) |
| Modèle refusé par Meta | texte promotionnel dans un modèle « Utilitaire », variable collée au début/à la fin | reformulez, ou choisissez la catégorie Marketing |
| L'IA ne répond pas | assistant public désactivé, clé d'IA absente, quota de messages IA atteint | Réglages de l'assistant ; `ANTHROPIC_API_KEY` ; écran Abonnement |
| Les réponses arrivent avec du retard | délai de réponse réglé, ou serveur Render qui se réveille | Réglages : délai de réponse ; offre Render toujours réveillée |

### Check-list WhatsApp

- [ ] Compte Meta Business et application créés, WhatsApp ajouté
- [ ] Phone number ID, numéro, **jeton permanent** et **secret de l'application** notés en lieu sûr
- [ ] Webhook vérifié chez Meta, champ **`messages`** abonné
- [ ] Valeurs saisies dans l'écran *Canaux* (ou dans Render pour les notifications) ; « Tester la connexion » réussi
- [ ] Essai réel : texte, vocal, photo, commande
- [ ] Trois modèles de message approuvés et ajoutés dans *Relances*
- [ ] Application en mode Live, entreprise vérifiée, moyen de paiement renseigné (pour de vrais clients)

---

---

## Connexion WhatsApp par QR code (« Appareils connectés »)

**Ce que c'est.** L'administrateur d'une organisation ouvre *Assistant commercial → WhatsApp*, lit l'avertissement, coche « Je comprends les risques », puis scanne un QR code avec WhatsApp (*Paramètres → Appareils connectés → Connecter un appareil*), comme pour WhatsApp Web. Un code de jumelage à 8 caractères est possible à la place. Ensuite l'IA répond depuis ce numéro, avec la même logique que par Meta (prospects, commandes, prise en main par un conseiller, délai avant réponse, messages vocaux si la transcription est activée, photos et PDF). Le parcours Meta (identifiants, webhook, connexion en un clic, Messenger, Instagram) est **masqué** (`META_CHANNELS=0`) mais le code est conservé.

**Comment ça marche.** Bibliothèque `@whiskeysockets/baileys` (version exacte 7.0.0-rc14 : la branche « legacy » 6.7.x dépend d'un dépôt Git pour `libsignal`, plus fragile pour `npm ci` sur Render ; les deux sont publiées le même jour). Elle est chargée à la demande : si elle manque, la fonction se désactive avec un message clair et le serveur démarre quand même. L'état d'authentification est enregistré dans PostgreSQL (tables `wa_qr_auth` et `wa_qr_sessions`), chaque valeur **chiffrée** avec `DATA_KEY` (comme les jetons Meta) : aucun fichier sur le disque. Un verrou consultatif PostgreSQL par organisation empêche deux serveurs d'ouvrir le même numéro. Les sessions sont reprises au démarrage, de façon échelonnée. Routes (administrateurs) : `GET /api/ws/orgs/:orgId/sales/wa-qr/status`, `POST .../start` (`{ "accept": true }`), `POST .../pairing` (`{ "phone": "237…" }`), `POST .../stop`.

**Comportement « humain » (réduit le risque de blocage, ne l'élimine pas).** Réponses seulement aux messages entrants de conversations individuelles (groupes, statuts, diffusions, messages de soi-même et messages de plus de 10 minutes ignorés) ; jamais d'écriture en premier à un inconnu ; « en train d'écrire » puis délai aléatoire de 1 à 4 secondes selon la longueur ; file d'attente par organisation, 20 messages par minute et 1 000 par jour par défaut. Les modèles de message Meta (relances automatiques, rappels de facture) ne sont **pas** envoyés dans ce mode.

**Risques, à dire honnêtement aux clients.**
- Méthode **non officielle** : WhatsApp peut **bloquer le numéro**, y compris définitivement. N'utilisez pas un numéro que vous ne pouvez pas perdre.
- Connexion **fragile** : elle peut sauter (déconnexion depuis le téléphone, mise à jour de WhatsApp, changement du protocole) et demander un nouveau scan.
- Le serveur doit être **toujours allumé**. Sur Render : plan payant (Starter). Astuce non garantie : un service gratuit de ping (par exemple UptimeRobot) appelle `/api/health` toutes les 10 minutes pour empêcher l'endormissement du plan gratuit ; les messages reçus pendant l'endormissement peuvent être perdus ou arriver en retard.
- Neon : pour que les verrous consultatifs fonctionnent, renseignez `DATABASE_URL_UNPOOLED` (connexion directe) ; l'adresse « pooled » ne conserve pas les verrous de session.

**Variables** (voir `.env.example`) : `WA_QR_ENABLED` (défaut `1`), `WA_QR_MAX_SESSIONS` (défaut `20`, sessions simultanées par serveur), `META_CHANNELS` (défaut `0` : interface Meta masquée ; `1` pour la réafficher), `WA_QR_SEND_PER_MIN` (20), `WA_QR_SEND_PER_DAY` (1000), `WA_QR_MAX_QUEUE` (60), `WA_QR_MAX_AGE_MIN` (10). Le serveur accepte toujours les webhooks Meta existants.

**Ce qui N'A PAS été testé avec le vrai WhatsApp.** Tous les tests (`npm run test:waqr`, 69 cas) utilisent une fausse socket : aucun scan réel, aucun vrai code de jumelage, aucune vraie reconnexion, aucune réception de vocal, photo ou PDF réels, aucune résolution réelle des identifiants « LID », aucun envoi réel d'image, de vidéo ou de message vocal. Le comportement face aux blocages de WhatsApp est inconnu. À faire avant de vendre la fonction : un essai avec un numéro jetable (scan, code de jumelage, redémarrage du serveur, message texte, vocal, photo).

## Connexion WhatsApp en un clic (Embedded Signup de Meta)

**Ce que c'est.** Un bouton « Connecter WhatsApp » dans l'onglet Canaux : une fenêtre de Meta s'ouvre, l'entreprise cliente choisit son compte et son numéro, et Brij-IA reçoit un code qu'il échange côté serveur contre un jeton, enregistre le numéro, abonne l'application au compte WhatsApp Business et range les identifiants chiffrés. Le client ne copie plus aucun identifiant. L'outil est gratuit chez Meta (les conversations restent facturées selon les tarifs de Meta). La saisie manuelle reste disponible, repliée sous « Avancé : saisir les identifiants à la main ».

**La fonction est désactivée tant que les variables ne sont pas renseignées** (le bouton n'apparaît pas).

**Prérequis chez Meta (à faire par vous, l'éditeur) :**
- entreprise vérifiée dans le Gestionnaire d'entreprise ;
- application en mode **Live** ;
- statut de **fournisseur de technologie** (Tech Provider) ;
- revue (App Review) des permissions `whatsapp_business_management` et `whatsapp_business_messaging`, avec une vidéo de démonstration ;
- une configuration **« Facebook Login for Business »** avec le produit **WhatsApp Embedded Signup** (son identifiant devient `META_EMBEDDED_CONFIG_ID`) ;
- vos domaines autorisés (domaine du site et de l'application) déclarés dans les réglages de connexion de l'application.

**Variables d'environnement :**
| Variable | Rôle |
|---|---|
| `META_APP_ID` | identifiant de l'application Meta |
| `META_APP_SECRET` | secret de l'application : échange du code et signature des webhooks |
| `META_EMBEDDED_CONFIG_ID` | identifiant de configuration « Facebook Login for Business » |
| `META_WEBHOOK_VERIFY_TOKEN` | texte au choix, à coller aussi dans Meta pour le webhook commun |

**Webhook commun à coller dans Meta** (produit WhatsApp, champ `messages`) : `https://VOTRE-SERVEUR/api/webhooks/whatsapp`, avec le jeton `META_WEBHOOK_VERIFY_TOKEN`. Les messages de tous les numéros arrivent là ; chacun est rangé dans l'organisation propriétaire du numéro (un numéro ne peut être rattaché qu'à une seule organisation). Les messages d'un numéro inconnu sont ignorés.

**Routes** (administrateurs de l'organisation) : `GET /api/ws/orgs/:id/sales/whatsapp/embedded/config` et `POST .../sales/whatsapp/embedded/complete`. Tests : `npm run test:embedded`.

**Ce qui n'a PAS été testé contre le vrai Meta.** Tout a été vérifié avec un faux serveur Graph local : les échanges réels (format exact des réponses, erreur « déjà enregistré », code PIN de l'authentification en deux étapes d'un numéro, événements du kit JavaScript, délai d'expiration du code) peuvent différer et demanderont un premier essai réel avec un compte de test avant tout lancement.

## 1. Installation sur votre ordinateur (essai)

1. Installez Node.js 20 ou plus : <https://nodejs.org> (version « LTS »).
2. Ouvrez un terminal dans ce dossier, puis :
   ```bash
   npm install
   cp .env.example .env        # sous Windows : copy .env.example .env
   ```
3. Ouvrez le fichier `.env` avec un éditeur de texte et remplissez au minimum (ou lancez `npm run setup`, qui crée `.env` avec des secrets aléatoires) :
   ```
   DATABASE_URL=l'adresse PostgreSQL de votre projet Neon (voir le guide ci-dessus, étape 1)
   ADMIN_USERNAME=votre_identifiant
   ADMIN_PASSWORD=un_mot_de_passe_long_et_unique
   ```
   (Tout le reste est facultatif pour un premier essai.)
4. Lancez :
   ```bash
   npm start
   ```
5. Ouvrez <http://localhost:3000/api/health> : vous devez voir `{"ok":true,"db":true}`. La page d'administration est sur <http://localhost:3000/admin>.

Sans aucune clé externe, le serveur démarre quand même : les notifications s'affichent dans le terminal, les paiements sont en mode manuel et l'assistant IA répond « indisponible » (le site a un plan B).

**Commandes utiles**
- `npm start` : démarre le serveur.
- `npm run dev` : démarre et redémarre tout seul quand vous modifiez le code.
- `npm run smoke` : lance un test automatique complet sur une base temporaire (rien n'est modifié chez vous). Tout doit afficher « OK ».

---

## 2. Brancher le frontend

Le site est une application React (dépôt `manager-ia-frontend`, hébergée sur Vercel). Il appelle le serveur par des adresses `/api/...` **sur son propre domaine** ; c'est le fichier `vercel.json` du site qui transmet ces appels à ce serveur (cookies « du même site », donc fiables partout, y compris sur iPhone). Réglages côté serveur : `SITE_URL` et `ALLOWED_ORIGINS` = adresse du site, `API_PUBLIC_URL` = adresse de ce serveur, `COOKIE_SAMESITE=lax`, `TRUST_PROXY=2`. Tout est expliqué pas à pas dans le **guide complet** en haut de ce fichier.

Variante (non recommandée, cookies tiers bloqués par Safari) : le site appelle directement le serveur (`VITE_API_BASE` côté site, `COOKIE_SAMESITE=none` et `COOKIE_SECURE=true` côté serveur).

Le serveur renvoie toujours les erreurs sous la forme `{"error":"message en français"}`.

---

## 3. Les variables d'environnement

Elles sont toutes décrites et commentées dans `.env.example`. Résumé :

| Variable | À quoi ça sert | Obligatoire ? |
|---|---|---|
| `NODE_ENV` | `production` en ligne | conseillé en ligne |
| `JWT_SECRET` | secret qui protège les connexions | **oui en production** (le serveur refuse de démarrer sans) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | accès à `/admin` | oui pour utiliser l'admin |
| `ALLOWED_ORIGINS`, `COOKIE_SAMESITE`, `COOKIE_SECURE` | frontend sur un autre domaine | seulement dans ce cas |
| `TRUST_PROXY` | nombre de relais devant le serveur : `1` derrière Render/Railway/nginx seul, **`2` avec Vercel (redirection `/api`) puis Render**. Trop bas, tous les visiteurs auraient la même adresse IP (limites et blocages faussés) : le serveur le détecte et suspend alors le blocage automatique | **oui derrière Vercel** |
| `DATABASE_URL` | adresse PostgreSQL (Neon, « Pooled connection ») | **oui** |
| `DATABASE_URL_UNPOOLED` | adresse directe Neon, pour les migrations | non |
| `ADMIN_EMAIL`, `ADMIN_WHATSAPP` | où vous recevez les notifications | non (valeurs par défaut) |
| `SMTP_*` | envoi des e-mails | non |
| `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_TEMPLATE` | WhatsApp (notifications + agent client) | non |
| `META_VERIFY_TOKEN`, `META_APP_SECRET`, `PAGE_ACCESS_TOKEN` | agent client WhatsApp/Messenger/Instagram | non |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | assistant IA et agent client | non |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`, `AI_MODEL_FAST`, `AI_PROMPT_CACHE` | changer de fournisseur d'IA (Anthropic ou compatible OpenAI), petit modèle économique, cache — voir `.env.example`. Test : `npm run test:ai` | non |
| `CAMPAY_USERNAME`, `CAMPAY_PASSWORD`, `CAMPAY_BASE_URL` | paiement automatique | non |
| `MTN_NUMBER`, `ORANGE_NUMBER`, `PAYMENT_HOLDER_NAME` | paiement manuel | oui si pas de Campay |

Ne mettez **jamais** vos clés dans le code ni dans un fichier publié sur Internet (GitHub public, etc.).

---

### Nouveautés de la version 22

| Fonction | Où | À savoir |
|---|---|---|
| Abonnement et paiement MTN / Orange | Sous-application « Abonnement » (propriétaire) | Automatique avec Campay (`CAMPAY_*`), sinon manuel (numéros `MTN_NUMBER`, `ORANGE_NUMBER`, validation par l'administrateur) |
| Relances WhatsApp (modèles Meta) | Assistant commercial > Relances | Il faut créer et faire approuver les modèles dans Meta ; STOP/REPRENDRE gérés ; `DEFAULT_COUNTRY_CODE` (237 par défaut) |
| Photos et PDF reçus sur WhatsApp | Automatique | Le modèle d'IA doit savoir lire les images (Claude : oui). Un PDF n'est lu qu'avec Anthropic. Conservés 90 jours |
| Comptabilité simple (plan OHADA de base) | Sous-application « Comptabilité » (administrateurs) | Outil d'aide : à faire valider par un expert-comptable ; pas de liasse fiscale officielle |
| Agenda (lien .ics Google/Outlook/Apple) et rappels la veille | Assistant commercial > Rendez-vous | Lien secret en lecture seule (actualisation par l'agenda, `API_PUBLIC_URL` en HTTPS pour Google) ; rappels des rendez-vous confirmés à partir de 16 h ; modèle Meta « Rappel de rendez-vous » après 24 h. Pas de synchronisation à double sens (il faudrait une application Google OAuth) |
| Prospection : rendez-vous, passage à l'équipe, dossier de l'IA interne | Assistant commercial > Rendez-vous, Réglages | Rendez-vous de 60 min (6 h-21 h, heure du Cameroun), pas de double réservation ; après commande/rendez-vous : conversation à l'équipe + dossier préparé (1 message IA) |
| Photos et vidéos d'articles sur WhatsApp | Assistant commercial > Catalogue > « Photos et vidéos » | Images 3 Mo, vidéos MP4 16 Mo (limite WhatsApp), 8 fichiers par article, 80 Mo par organisation ; stockés dans la base (pensez aux sauvegardes) |
| Réponses vocales, délai de réponse (0 à 180 s) | Assistant commercial > Réglages | Voix : `TTS_API_KEY` (ou la clé de transcription). Délai : file en base, survit au redémarrage. Messenger/Instagram : `API_PUBLIC_URL` pour envoyer fichiers et voix |
| Messenger et Instagram | Assistant commercial > Canaux | Page Facebook + jeton de Page + secret de l'application Meta ; texte seulement |
| Intégrations : API et webhooks | Sous-application « Intégrations » (administrateurs) | API `/api/v1`, webhooks signés ; adresses privées refusées (protection SSRF) |
| Application web installable (PWA) | `manifest.webmanifest`, `sw.js` | Nécessite HTTPS en production ; ce n'est pas une application des boutiques |
| Sécurité | voir plus haut | 0 faille connue dans les dépendances au moment de la livraison |

Tests : `npm run smoke:ws` (412 contrôles), `npm run smoke`, `npm run smoke:signup`, `npm run smoke:security`, `npm run test:ai`, `npm run test:webhooks`.

**Jamais vérifié avec de vrais services** : l'IA (clé Anthropic), WhatsApp / Messenger / Instagram (Meta), Campay, l'envoi d'e-mails et la transcription vocale ont été testés uniquement avec des faux serveurs locaux. Faites un essai réel de chacun avant d'ouvrir à des clients.

### Sécurité : ce qui est en place

- **Mots de passe** : 8 caractères minimum, refus des mots de passe courants, de ceux qui contiennent le nom ou l'e-mail ; chiffrés (bcrypt coût 12). En production, `ADMIN_PASSWORD` doit faire au moins 10 caractères (le serveur refuse de démarrer sinon).
- **Verrouillage** : 8 échecs de connexion en 15 minutes bloquent le compte (ou l'administration) pendant 15 minutes ; l'administrateur est alerté. Un compte inexistant répond comme un compte existant.
- **Changer son mot de passe** : `POST /api/me/password` (mot de passe actuel + nouveau). Les autres appareils sont déconnectés et un e-mail d'alerte est envoyé.
- **Journal de sécurité** (connexions, échecs, verrouillages, changements) : `GET /api/admin/security-log` (administrateur). Conservé 180 jours, sans mot de passe ni code.
- **En-têtes** : HSTS, `nosniff`, `Permissions-Policy`, politique de contenu (CSP) stricte sur le site et l'administration (aucun script en ligne autorisé).
- **Sauvegarde** : `npm run backup` (copie cohérente + contrôle d'intégrité + rotation `BACKUP_KEEP`, 14 par défaut). Planifiez-la chaque nuit et copiez-la ailleurs.
- **Dépendances** : `npm audit --omit=dev` doit afficher 0 faille ; relancez-le régulièrement.
- Tests : `npm run smoke:security`.
- **Reste à faire de votre côté** : un audit de sécurité par un tiers avant d'accueillir beaucoup d'utilisateurs ; activer la double authentification de l'administrateur (voir « Centre de sécurité »).

### Centre de sécurité (version 23)

Tout est regroupé dans `src/security/` (un seul endroit, une seule logique) et visible dans **/admin → Sécurité** :

| Protection | Ce que ça fait |
|---|---|
| **Sessions révocables** | Chaque connexion est une session enregistrée en base. On peut la fermer à tout moment : « Déconnecter cet appareil », « tous les autres », mot de passe changé ou réinitialisé (coupe tout), ou, côté administrateur, tous les appareils d'un compte suspect. Un cookie volé après déconnexion ne sert plus. |
| **Journal d'audit chaîné** | Chaque événement important (connexions, échecs, changements de rôle, clés d'API, suppression d'organisation, actions de l'administrateur, canaux WhatsApp/Meta…) est inscrit avec qui, quand, depuis quelle adresse, quel appareil et un numéro de requête (`X-Request-Id`). Chaque ligne contient l'empreinte SHA-256 de la précédente : modifier ou effacer une ligne **casse la chaîne**, et « Vérifier l'intégrité » (ou `npm run security:check`) le détecte. |
| **Double authentification (2FA)** | Code à 6 chiffres (Google Authenticator, Microsoft Authenticator, Authy, 2FAS…) + 10 codes de secours à usage unique, pour les utilisateurs (⚙ « Sécurité du compte » dans l'espace de travail) **et** l'administrateur (/admin → Sécurité). Secrets chiffrés (AES-256-GCM), codes rejoués refusés. |
| **Blocage automatique d'adresses IP** | Des points d'abus s'accumulent (mots de passe faux, code 2FA faux, origine interdite, signature de webhook invalide, limites dépassées). Au-delà du seuil (`SECURITY_BAN_SCORE`, 40 par défaut), l'adresse est bloquée 1 h (24 h en cas de récidive) et l'administrateur est prévenu. Blocage / déblocage manuel dans l'administration. Les adresses locales et privées ne sont jamais bloquées automatiquement. |
| **Limites de débit partagées** | Connexion, inscription, paiements, mot de passe, administrateur : comptées dans PostgreSQL, donc valables même avec plusieurs serveurs Render. |
| **Actions sensibles surveillées** | Une seule table (`src/security/sensitive.js`) liste les actions à inscrire au journal : pour en surveiller une de plus, ajoutez une ligne. |
| **Alertes** | Les événements graves ou critiques préviennent l'administrateur (e-mail / WhatsApp). |
| **Contrôle de configuration** | `npm run security:check` (et l'écran Sécurité) liste ce qui est solide, à améliorer ou dangereux : secrets trop courts, cookies non sécurisés, 2FA administrateur absente, origines trop larges… Il ne montre jamais un secret. |

**À faire en ligne** : sur `/admin → Sécurité`, activer la 2FA de l'administrateur et noter les codes de secours ; puis `npm run security:check` doit ne montrer aucun point « dangereux ». Les connexions ouvertes avant la mise à jour sont fermées une fois : chacun se reconnecte.


### Inscription avec code par e-mail

Dès que l'envoi d'e-mails est configuré (`SMTP_HOST`…), l'inscription demande une vérification : le visiteur reçoit un code à 6 chiffres **valable 1 minute** (5 essais maximum par code, 5 codes par heure et par adresse, renvoi possible après 20 s). Le compte n'est créé qu'après la saisie du bon code, puis la personne arrive directement dans son espace. Un téléphone seul n'est alors plus accepté à l'inscription (il n'y a pas d'envoi de SMS). Variable `SIGNUP_VERIFY` : `auto` (par défaut), `on` ou `off` (pour des essais en local sans e-mail). Test : `npm run smoke:signup`.

## 4. Mise en ligne : autres hébergeurs

La méthode recommandée (Neon + Render + Vercel) est le **guide complet** en haut de ce fichier. Les variantes ci-dessous sont pour d'autres hébergeurs : dans tous les cas, définissez au minimum `NODE_ENV=production`, `DATABASE_URL` (PostgreSQL, par exemple Neon), `JWT_SECRET`, `DATA_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, et vos numéros de paiement (`MTN_NUMBER`, `ORANGE_NUMBER`, `PAYMENT_HOLDER_NAME`).

### Option B : Railway

1. Dépôt GitHub privé, puis <https://railway.app> → *New Project* → *Deploy from GitHub repo*.
2. Onglet *Variables* : ajoutez les variables.
3. Ajoutez `DATABASE_URL` (Neon, voir l'étape 1) : aucun volume n'est nécessaire.
4. *Settings* → *Networking* → *Generate Domain* (ou votre domaine).
5. Le fichier `Dockerfile` fourni est utilisé automatiquement.

### Option C : un serveur à vous (VPS Ubuntu)

```bash
# 1. Installer Node 20+, nginx et pm2 (voir la doc de votre hébergeur pour Node)
sudo npm install -g pm2
# 2. Copier le dossier sur le serveur, puis :
cd manager-ia-backend
npm install --omit=dev
nano .env          # remplir les variables (NODE_ENV=production, JWT_SECRET, ...)
pm2 start src/server.js --name manager-ia
pm2 save && pm2 startup       # redémarre tout seul après un redémarrage du serveur
```
Ensuite, mettez nginx devant (pour le HTTPS) et installez un certificat gratuit avec `certbot` :
```nginx
server {
  server_name manager-ia.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
`sudo certbot --nginx -d manager-ia.com`

### Option D : Docker

```bash
docker build -t manager-ia .
docker run -d --name manager-ia -p 3000:3000 --env-file .env -v manager-ia-data:/app/data manager-ia
```

---

## 5. Notifications pour vous (e-mail + WhatsApp)

À chaque **nouvelle inscription**, **nouvelle demande de contact**, **paiement à valider** et **paiement confirmé**, vous recevez un e-mail (à `ADMIN_EMAIL`) et un message WhatsApp (à `ADMIN_WHATSAPP`). Si un des deux canaux n'est pas configuré, le serveur continue sans problème. Toutes les notifications sont aussi visibles dans l'onglet *Notifications* de `/admin`. Elles ne ralentissent jamais le site.

### E-mail avec Gmail (mot de passe d'application)

Gmail refuse votre mot de passe normal pour ce genre d'usage. Il faut un « mot de passe d'application » :
1. Activez la **validation en deux étapes** sur votre compte Google (<https://myaccount.google.com/security>).
2. Allez sur <https://myaccount.google.com/apppasswords>, donnez un nom (ex : « Brij-IA ») et créez le mot de passe : Google affiche 16 lettres.
3. Dans les variables :
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=votre.adresse@gmail.com
   SMTP_PASS=les16lettres (sans espaces)
   SMTP_FROM=Brij-IA <votre.adresse@gmail.com>
   ```
Gmail limite le nombre d'e-mails par jour (environ 500) : c'est largement suffisant pour démarrer.

### WhatsApp : créer le modèle de message (obligatoire)

WhatsApp n'autorise l'envoi d'un message « à froid » (hors des 24 h après la dernière réponse du client) qu'avec un **modèle approuvé par Meta**. Voici comment le créer :

1. Créez une application sur <https://developers.facebook.com> (type « Entreprise »), ajoutez le produit **WhatsApp**, et rattachez un numéro WhatsApp Business. Notez le **Phone number ID** → `WHATSAPP_PHONE_ID`.
2. Créez un **jeton permanent** : dans *Business Settings* → *Users* → *System users*, créez un utilisateur système, donnez-lui l'accès à l'application et au compte WhatsApp, puis générez un jeton avec les permissions `whatsapp_business_messaging` et `whatsapp_business_management` → `WHATSAPP_TOKEN`. (Le jeton temporaire du tableau de bord expire en 24 h : ne l'utilisez que pour un essai.)
3. Dans le **Gestionnaire WhatsApp** (WhatsApp Manager) → *Modèles de message* (Message templates) → *Créer un modèle* :
   - **Catégorie** : Utilitaire (*Utility*)
   - **Nom** : `nouvelle_notification` (exactement, en minuscules)
   - **Langue** : Français (`fr`)
   - **Corps** (exactement une variable `{{1}}`) :
     ```
     Notification Brij-IA : {{1}} Consultez votre espace administrateur pour la suite.
     ```
   - **Exemple de valeur pour {{1}}** (Meta le demande) : `Nouvelle inscription : Awa (237670000000)`
   - Pas d'en-tête, pas de boutons.
4. Envoyez pour approbation (de quelques minutes à quelques heures). Quand le statut est « Approuvé », c'est prêt. Si vous donnez un autre nom au modèle, changez `WHATSAPP_TEMPLATE`.
5. Tant que votre application Meta est en mode « développement », vous ne pouvez écrire qu'aux numéros ajoutés dans la liste de test du tableau de bord WhatsApp : ajoutez-y votre numéro d'administrateur.

Le serveur envoie ce modèle avec le texte de la notification dans `{{1}}` (sur une seule ligne, 600 caractères maximum).

---

## 6. Activer les paiements

### Paiement manuel (aucune inscription nécessaire)
Renseignez `MTN_NUMBER`, `ORANGE_NUMBER` et `PAYMENT_HOLDER_NAME`. Le déroulement :
1. L'utilisateur choisit une offre. Il reçoit une référence `MI-XXXXXX`, le montant et vos numéros.
2. Il envoie l'argent en indiquant la référence en motif, puis saisit l'ID de transaction reçu par SMS.
3. Vous recevez une notification, vous **vérifiez sur votre téléphone que l'argent est bien arrivé**, puis vous ouvrez `/admin` → *Paiements* → **Valider** (ou *Refuser*). L'offre est alors activée pour 30 jours.

### Paiement automatique avec Campay
1. Créez un compte marchand sur <https://www.campay.net> et créez une **application** : vous obtenez un *nom d'utilisateur* et un *mot de passe* d'API → `CAMPAY_USERNAME`, `CAMPAY_PASSWORD`.
2. Pour essayer d'abord : `CAMPAY_BASE_URL=https://demo.campay.net/api` (avec les identifiants du compte de démonstration). Pour le réel : `https://www.campay.net/api`.
3. Dans les réglages de votre application Campay, indiquez l'adresse de notification (webhook) : `https://VOTRE-DOMAINE/api/payments/webhook/campay`
4. Dès que `CAMPAY_USERNAME` et `CAMPAY_PASSWORD` sont définis, le site passe en mode « push » : le client reçoit la demande de paiement sur son téléphone et l'offre s'active automatiquement.

Sécurité : le serveur **ne croit jamais** ce que le webhook affirme. Il demande lui-même à Campay l'état réel du paiement avant d'activer l'offre, et une offre n'est jamais activée deux fois.

> À vérifier dans la documentation officielle de Campay (<https://documenter.getpostman.com/view/2391374/T1LV8PVA>) : adresses d'API, format du champ `from`, valeurs de statut, et l'adresse de webhook. Je n'ai pas pu tester avec un vrai compte.

---

## 7. Agent de service client (WhatsApp, Messenger, Instagram)

L'agent répond automatiquement aux clients de **votre entreprise** (ou de celle d'un client que vous gérez) en s'appuyant sur Claude.

1. Copiez `business.example.json` en `business.json` et remplacez **tout** par les vraies informations : nom, description, produits avec prix, horaires, livraison, paiement, ton, consignes. (L'exemple décrit une boutique de vêtements fictive à Douala ; tous les produits sont marqués EXEMPLE.) Le fichier est relu automatiquement quand vous le modifiez.
2. Dans la partie `media`, associez des mots-clés à une image ou une vidéo (lien public en `https://`) : quand le client écrit l'un de ces mots, l'image ou la vidéo est envoyée après la réponse.
3. Renseignez `ANTHROPIC_API_KEY`, `META_VERIFY_TOKEN` (un mot de votre choix) et `META_APP_SECRET` (clé secrète de l'application Meta).

**WhatsApp** : dans le tableau de bord de l'application Meta → WhatsApp → *Configuration* → *Webhook* : adresse de rappel `https://VOTRE-DOMAINE/webhooks/whatsapp`, jeton de vérification = votre `META_VERIFY_TOKEN`, puis abonnez-vous au champ **messages**.

**Messenger et Instagram** : adresse de rappel `https://VOTRE-DOMAINE/webhooks/meta`, même jeton, abonnement aux messages de la Page (et d'Instagram). Mettez le jeton de la Page dans `PAGE_ACCESS_TOKEN`.

Comment ça marche :
- Le serveur vérifie la **signature** de chaque message de Meta (`X-Hub-Signature-256`) ; un message non signé est rejeté.
- Il répond tout de suite « 200 » à Meta, puis traite le message et répond au client.
- Il garde les 10 derniers échanges de chaque client pour comprendre le contexte.
- Si le client écrit « humain », « conseiller » ou « responsable », ou si l'IA n'est pas sûre : le client reçoit un message « un conseiller va reprendre », **vous êtes notifié**, et le robot se tait pendant `HANDOFF_SILENCE_HOURS` heures (2 par défaut).
- Les messages vocaux, images et documents reçus ne sont pas lus : le client est invité à écrire.

Limites à connaître :
- **Les appels vocaux ne sont PAS gérés.** Répondre à des appels téléphoniques par une IA demande un service de téléphonie voix + IA à part (fournisseur de numéros, reconnaissance vocale, synthèse vocale). Ce n'est pas inclus ici.
- WhatsApp n'autorise les réponses libres que dans les 24 h suivant le dernier message du client.
- Pour répondre à de vrais clients (pas seulement vos testeurs), l'application Meta doit passer en mode « Live » et votre entreprise doit être vérifiée par Meta. Voir la documentation Meta.

---

## 8. La page d'administration (`/admin`)

Elle a la même présentation que le tableau de bord des utilisateurs : **Vue d'ensemble** (à traiter aujourd'hui, santé du système, indicateurs, revenus et inscriptions, répartition des offres, paiements à valider, demandes de contact, derniers inscrits, activité récente), puis Utilisateurs, Organisations, Paiements, Offres et abonnements, Contacts reçus, Utilisation de l'IA, Notifications et Paramètres. Elle n'affiche jamais de secret (clés, mots de passe) : seulement « configuré » ou non.


Connectez-vous avec `ADMIN_USERNAME` / `ADMIN_PASSWORD` (10 essais maximum par 15 minutes). Vous y trouvez : les chiffres clés (inscrits, offres, paiements à valider, revenus du mois), la liste des **inscrits** (recherche, changement d'offre, liens WhatsApp et e-mail), les **paiements** (Valider / Refuser), les **demandes de contact**, les **notifications**, et l'export CSV des inscrits (s'ouvre directement dans Excel). Elle fonctionne sur téléphone.

---

## 8 bis. L'espace de travail IA (`/app.html`)

C'est l'application maîtresse : chaque utilisateur crée une **organisation** (entreprise, boutique, association…) et gère son activité avec l'aide de l'IA, dans des **sous-applications** séparées :

| Sous-application | Ce qu'elle fait | Qui y a accès |
|---|---|---|
| Tableau de bord | point de situation, **score de santé**, chiffres clés, graphique entrées/sorties (responsables), alertes, **décisions à prendre** (demandes de validation), projets, tâches | tous |
| Alertes | alertes calculées par des règles claires (demandes urgentes, tâches/projets en retard, dépassement de budget, solde négatif…), avec « Que faire ? » (IA) | tous (alertes budget : responsables et plus) |
| Service client | boîte de demandes, réponses, brouillon de réponse par l'IA, lien de formulaire public pour les clients | tous |
| Projets et tâches | projets, tâches, assignation, retards, plan de projet proposé par l'IA | tous (créer un projet : responsable et plus) |
| Budget | entrées / sorties, limites par catégorie, conseils de l'IA | responsables et plus |
| Organisation | fiche de l'organisation, organigramme des postes, structure proposée par l'IA | tous (modifier : administrateur) |
| Fonctionnement | procédures étape par étape, rédaction par l'IA | tous (modifier : administrateur) |
| Équipe et antennes | rôles, invitations par lien, antennes (succursales / extensions) | tous (gérer : administrateur) |

**Rôles** : Propriétaire > Administrateur > Responsable > Membre. **Antennes** : une personne rattachée à une antenne ne voit que les données de cette antenne et les données communes ; les administrateurs et les personnes sans antenne voient tout.

**Demandes de validation** : toute personne soumet une décision (achat, embauche…) ; un responsable la valide ou la refuse (jamais sa propre demande, sauf administrateur). C'est la base du futur système d'autorisations.

**L'IA ne modifie jamais rien toute seule.** Quand elle propose un plan, des postes, une procédure ou des limites de budget, la personne relit, puis valide : seulement alors le serveur enregistre (en revérifiant tout). Les messages de clients et les noms saisis sont traités comme des *données*, jamais comme des consignes (protection contre l'injection de consignes).

**Limites par offre** (de la personne qui possède l'organisation) : voir `workspaceLimits` dans `src/config.js` — Gratuit : 1 organisation, 3 personnes, 1 antenne, 40 messages IA par mois ; Pro (50 000 FCFA) : 3 / 15 / 5 / 1 000 ; Pro Max (75 000) : 10 / 100 / 50 / 2 000 ; Méga Pro (100 000) : 25 / 300 / 150 / 3 500 ; Illimité (150 000) : sans limite pratique / 6 000. Les messages IA sont comptés **pour toute l'organisation** (table `ai_usage`) par période d'abonnement de 30 jours alignée sur l'échéance du propriétaire (mois civil en offre Gratuite) ; **une offre payante ne peut changer qu'à la fin de l'abonnement** (renouvellement de la même offre possible à tout moment ; l'administrateur peut forcer un changement à la main). Valeurs de départ, modifiables : `WS_AI_FREE`, `WS_AI_PRO`, `WS_AI_PROMAX`, `WS_AI_MEGAPRO`, `WS_AI_ILLIMITE` (messages) et `PRICE_PRO`, `PRICE_PROMAX`, `PRICE_MEGAPRO`, `PRICE_ILLIMITE` (prix).

**Assistant commercial public** (`src/workspace/sales-public.js`, `sales.js`, page `chat.html`) : chaque organisation reçoit un lien `chat.html?o=<jeton>&c=<campagne>` à mettre dans ses publicités. L'IA répond aux prospects d'après le catalogue (table `catalog`) et les informations pratiques, enregistre le prospect (table `customers`, `stage = prospect`, `source = campagne`), puis crée une commande « à valider » (`documents.kind = 'order'`, prix calculés par le serveur d'après le catalogue, jamais par l'IA). Garde-fous : limite de débit par IP, quota de messages IA de l'organisation, remise interdite, passage de la main (ticket du service client) pour les réclamations. **Messages vocaux** : `POST /api/ws/public/chat/:jeton/voice` (audio transcrit via `STT_*`, API compatible OpenAI) ; sans `STT_API_KEY`, la page utilise la dictée du navigateur. Pas encore de WhatsApp par organisation. Test : `npm run smoke:ws`.

**WhatsApp par organisation** (`src/workspace/whatsapp.js`, `src/services/waOrg.js`, `src/services/vault.js`) : chaque organisation connecte son numéro via l'API officielle (Cloud API) de Meta : l'administrateur saisit l'identifiant du numéro, le jeton d'accès et le secret de l'application (chiffrés en AES-256-GCM dans la base, jamais renvoyés), puis colle dans Meta l'adresse `/api/ws/public/whatsapp/<jeton>` et le jeton de vérification affichés dans l'onglet WhatsApp. Chaque message est vérifié par sa signature (`X-Hub-Signature-256`, corps brut), dédoublonné, limité (25 messages par 10 min et par numéro), puis traité comme sur la page web (même assistant, même quota IA). Les messages vocaux sont téléchargés chez Meta et transcrits (`STT_*`). Un responsable peut reprendre la conversation (`POST /api/ws/orgs/:id/sales/chats/:id/reply`, 24 h après le dernier message du client) ; l'IA se tait alors. Les conversations utilisent `#nom-de-campagne` dans le premier message (lien `wa.me`). Les QR codes (page de discussion et lien WhatsApp) sont générés dans le navigateur avec une bibliothèque locale (`assets/vendor/qrcode.min.js`, licence MIT). Aucune connexion par QR sur un WhatsApp personnel (méthode non officielle, numéros bloqués). Test : `npm run smoke:ws`.

**Attribution, fiche prospect, mot de passe oublié** : l'assistant public remplit une fiche (`chats.lead` : besoin, quantité, délai, lieu, budget, température) à chaque message ; elle est jointe au ticket de passage de main. Un responsable attribue une conversation à un membre (`PUT /sales/chats/:id/assign`), qui reçoit une alerte et un e-mail ; l'option « répartition automatique » (`orgs.auto_assign`) choisit le commercial (poste contenant commercial/vente/vendeur/sales) ayant le moins de conversations en cours. Tout membre voit « Mes conversations » (`/sales-mine/...`) : seulement celles qui lui sont attribuées. Mot de passe oublié : `POST /api/password/forgot` (réponse toujours identique), lien à usage unique de 1 h (empreinte SHA-256 en base), `POST /api/password/reset` ; les sessions plus anciennes sont refusées (`users.pass_changed_at`) ; comptes téléphone : l'administrateur génère le lien (`POST /api/admin/users/:id/reset-link`). Pages `reinitialiser.html` et lien sur `connexion.html`.

**E-mails aux clients** (`src/workspace/mail.js`) : depuis « Clients et ventes », l'IA rédige et la personne relit puis envoie. Destinataire = un client enregistré avec une adresse e-mail (pas d'envoi libre) ; jusqu'à 3 pièces jointes (images PNG/JPEG/GIF/WebP ou PDF, 2 Mo chacune, type vérifié sur le contenu) ; quota par jour selon l'offre (`MAIL_DAY_*`) ; journal des envois (table `outbox`). Il faut renseigner `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Les vidéos ne se joignent pas (lien dans le message).

**Ajouter une sous-application** : une ligne dans `src/workspace/modules.js`, un fichier de routes dans `src/workspace/`, un fichier `assets/ws/xxx.js` côté site (et sa ligne dans `app.html`).

**Tester** : `npm run smoke:ws` (base temporaire + faux serveur Claude : aucun appel externe, rien d'installé chez vous).

### Les deux IA (éducation, étape suivante)

- **IA de l'espace de travail** (gère l'activité des utilisateurs) : consignes dans `src/ai/workspace-prompts.js`, connaissances dans `knowledge/workspace/*.md`.
- **IA du site** (assistant des visiteurs) : consignes dans `src/services/claude.js`, connaissances dans `knowledge/site/*.md`.

Déposez simplement des fichiers `.md` dans ces dossiers : ils sont lus automatiquement (voir `knowledge/README.md`).

---

## 8 ter. Les modules ERP (paie, fiscalité, marketing, logistique, production, chantiers, maintenance, juridique, mémoire, agents)

Tous sont dans l'espace de travail (`/app`), réservés selon le rôle (voir `src/workspace/modules.js`). Chaque module a ses tables (préfixées), ses routes sous `/api/ws/orgs/:orgId/<module>`, un test (`npm run test:finance`, `test:commerce`, `test:ops`, `test:intelligence`) et fournit à l'IA ses données (`ctx`) filtrées par rôle.

| Module | Rôle minimal | Ce qu'il fait | Limites à connaître |
|---|---|---|---|
| Paie | administrateur | Bulletins mensuels (brouillon, validé, payé), retenues et charges **paramétrables**, heures supplémentaires calculées (heures x taux horaire x majoration par palier), 13e mois ou prime annuelle, bulletin imprimable, export CSV, écriture au budget, **comptabilisation automatique en option** (désactivée par défaut : une écriture par événement, validation puis paiement, contre-passée si le bulletin est rouvert), réouverture d'un bulletin validé non payé (administrateur, motif obligatoire, journal d'activité et d'audit), modèles de barèmes par pays | Les taux fournis par défaut sont des **exemples**. Les modèles de pays (Cameroun, Côte d'Ivoire, Sénégal, Congo, Gabon, RDC, Bénin, Togo, Mali, Burkina Faso, générique) ne sont que des **points de départ : ils ne contiennent aucun taux ni plafond** (rubriques « à compléter », mention « À vérifier auprès de votre administration », date « à jour au » à renseigner par vous) ; l'application ne connaît pas les barèmes officiels. Pas de calcul d'impôt progressif ni de déclarations sociales. Les écritures utilisent les comptes SYSCOHADA de base (661, 664, 641, 431, 447, 421, 422, 571/521/589) ; une période comptable clôturée refuse l'écriture (la validation reste possible). Un bulletin payé ou déjà enregistré au budget ne peut pas être rouvert. |
| Fiscalité et liasse | administrateur | Bilan (soldes **cumulés depuis l'ouverture**, avec le résultat des exercices précédents non affecté), compte de résultat, soldes intermédiaires de gestion détaillés avec classement SYSCOHADA classes 1 à 8 (tableau de correspondance lisible dans `src/workspace/syscohada-sig.js`, consultable à l'écran), contrôles de cohérence, clôture et réouverture d'exercice (verrou des écritures, motif et journal d'audit), TVA estimée avec détail par compte, calendrier des déclarations paramétrable avec **« Répéter »** (l'échéance suivante est créée quand la précédente est déposée ou payée ; rappel dans le contexte de l'IA) | Document de travail à **faire valider par un expert-comptable** : ce n'est pas une liasse officielle. La clôture est un verrou interne : elle ne génère **aucune écriture d'affectation du résultat ni à-nouveaux** (le report est calculé par cumul) et ne remplace pas la clôture légale ; seul le dernier exercice clôturé peut être rouvert. Le classement est indicatif et à valider. La TVA reste calculée sur les comptes 443/445 : le plan distingue la TVA par nature, pas par taux ; plusieurs taux ne sont gérés que si vous créez un compte par taux (le taux affiché vient du nom du compte). |
| Marketing | membre | Campagnes liées aux conversations et commandes de l'assistant commercial, coût par prospect, calendrier de contenu, offres | L'aide à la rédaction est un conseil de l'IA, rien n'est publié automatiquement. |
| Logistique | membre | Livraisons (statuts, historique, preuve), transporteurs, zones, tournées, lien WhatsApp « prévenir le client » | Le lien ouvre WhatsApp avec un message prérempli : aucun envoi automatique. |
| Production | membre | Nomenclatures, coût de revient, ordres de fabrication (matières sorties et produit fini entré en stock, en une transaction) | Une seule nomenclature par produit. |
| Maintenance | membre | Équipements, plans préventifs, interventions, pièces prélevées du stock, indicateurs d'arrêt | — |
| Chantiers (BTP) | membre | Chantiers, phases, dépenses et budget, pointages, rapports, incidents, situations de travaux | Pas de photos, un seul budget par chantier. |
| Juridique et conformité | responsable | Contrats et alertes de fin (30 et 7 jours, visibles dans « Alertes » et pour l'IA, rappels attribuables à un membre), obligations, litiges, registre des données personnelles, historique des modifications d'un contrat, suivi de signature, pièces jointes (PDF ou image de 2 Mo, chiffrées), 11 modèles de documents fournis et modèles propres à l'organisation (créer, modifier, dupliquer, supprimer) | Aide-mémoire et modèles **à faire relire par un professionnel du droit**, sans affirmation de conformité à un droit national. Le suivi « à signer / signé » est une simple note interne : **pas de signature électronique**, aucune valeur légale. Pièces jointes limitées à 2 Mo, 10 par élément et 40 Mo par organisation (PDF, JPEG, PNG, WebP ; type vérifié d'après le contenu), stockées chiffrées dans la base avec la clé `DATA_KEY` (la perdre rend les fichiers illisibles). Pas de rappel par e-mail ou WhatsApp : les rappels apparaissent dans « Alertes » et dans l'IA. L'historique ne couvre que les contrats. Les modèles se remplissent par champs `{{nom}}` en texte brut (pas de mise en page, pas d'export PDF : impression ou copie). |
| Mémoire de l'entreprise | membre | Décisions, incidents, procédures, recherche, question en langage naturel (réponse tirée uniquement des notes, avec sources) | Non filtrée par antenne. |
| Agents spécialisés | membre | Une équipe d'agents par domaine et un mode « réunion » avec synthèse (4 messages IA au plus par question) | Les agents ne modifient jamais les données. |
| Résumé du matin et alertes | responsable | Résumé du matin et alertes urgentes, au choix **par e-mail (défaut, recommandé)** ou par WhatsApp ; consentement daté (lié à l'adresse ou au numéro), désabonnement en un clic (lien signé dans chaque e-mail, `/api/ws/public/digest-unsub/…`), journal des envois, quota d'e-mails de l'offre (`outbox`) | E-mail : aucun numéro ni connexion WhatsApp, pas de fenêtre 24 h ; il faut un service d'e-mail configuré (Brevo ou SMTP) ; `SITE_URL` ajoute le lien vers l'application, `API_PUBLIC_URL` (ou `SITE_URL`) le lien de désinscription. **Contrainte Meta (canal WhatsApp seulement)** : un message libre n'est livré que si la personne a écrit au numéro de l'entreprise dans les 24 dernières heures. Sinon l'envoi bascule sur l'e-mail, ou utilise un modèle de message approuvé si vous renseignez son nom. |

### Vague 1 : facture conforme, stock avancé, parc

Tout est détaillé dans les tests `scripts/test-wave1-*.js` (`npm run test:wave1`). Les sorties légales et fiscales sont des **documents de travail** à faire valider par un expert-comptable.

- **Facture conforme** (`/crm`) : HT, taux et montant de TVA (19,25 % par défaut, réglable par organisation via `PUT /crm/invoice-settings`, réservé aux administrateurs), NIU de l'organisation et du client, adresse, RCCM, coordonnées de paiement, pied de page libre. Les prix saisis sont TTC par défaut (comportement historique) ; `pricesIncl: false` les traite comme HT. Les anciens documents (taux vide) gardent leur total comme TTC. Numérotation `F-AAAA-0001` par **séquence** (table `doc_sequences`) : sans doublon même en concurrence ; un brouillon n'est supprimable que s'il porte le dernier numéro. Avoirs : `POST /crm/documents/:id/credit-note` (numéro `AV-`, motif obligatoire, écriture comptable inverse passée si la comptabilité est utilisée). Impression : `GET /crm/documents/:id/print` (le frontend produit la page imprimable / PDF du navigateur), e-mail : `POST /crm/documents/:id/email` (texte + page HTML en pièce jointe, mêmes quotas que le module E-mails), WhatsApp : `GET /crm/documents/:id/share` (lien `wa.me`, rien n'est envoyé automatiquement).
- **Mobile Money** : chaque paiement porte un mode (`cash`, `transfer`, `mtn_momo`, `orange_money`, `cheque`), une référence (obligatoire hors espèces, unique) et un statut. `status: "pending"` enregistre une référence « à vérifier » sans toucher au solde ; `POST …/payments/:pid/confirm` ou `/reject` la traite. **Le suivi est manuel** : la « demande de paiement » automatique via Campay n'est pas branchée pour les factures, car les identifiants Campay du serveur encaissent les abonnements de la plateforme (voir `.env.example`).
- **Stock** (`/stock`) : lots avec péremption (sortie FEFO ou FIFO, lots périmés exclus des sorties), numéros de série / VIN, coût moyen pondéré (CUMP), SKU et code-barres (`GET /stock/lookup?code=`), stock maximum (surstock), inventaire physique (`/stock/counts` : comptage, écart valorisé, ajustement validé par un responsable), réception partielle (`POST /stock/orders/:id/receive`), date promise et taux de retard fournisseur (`GET /stock/supplier-stats`), suppression d'un article utilisé refusée. La logique commune est dans `src/workspace/stock-lib.js`.
- **Logistique et parc** (`/logistics`) : une livraison peut porter des articles du stock (expédier les sort, « retournée » les réintègre, une seule fois), véhicules, chauffeurs, affectation aux tournées (pas de double affectation le même jour, permis périmé refusé), échéances réglementaires (assurance, visite technique, permis) avec alertes dans le tableau de bord, relevés de carburant et consommation aux 100 km, lien avec les équipements de maintenance de type « véhicule » (le kilométrage met à jour leur compteur).

### Vague 2 : paie Cameroun, comptabilité, budget

Tests : `scripts/test-wave2-*.js` (`npm run test:wave2`). Toutes les sorties (bulletins, états CNPS / IRPP, fichiers de virement, solde de tout compte, rapprochements, balance âgée, plans d'amortissement, clôture, prévisions) sont des **documents de travail** à faire valider par un expert-comptable.

- **Paie Cameroun** (`/payroll/cm`, administrateurs) : modèle chiffré **versionné** dans `src/workspace/payroll-cm-model.js` (CNPS salarié / employeur avec plafond, IRPP progressif avec abattements, CAC, CFC, FNE). **Ces taux ne sont pas officiels** : ils viennent de la connaissance de l'auteur ; chaque paramètre porte un niveau de confiance (`high` / `medium` / `low`) et une source *supposée* ; les valeurs douteuses sont **vides** (taux accidents du travail, quotité) et signalées « à compléter ». L'organisation peut surcharger chaque valeur (`PUT /payroll/cm/overrides`), consigner la vérification par un expert (`PUT /payroll/cm/validation`, date « à jour au » + qui) ; `POST /payroll/cm/activate` fait calculer les bulletins avec ce modèle (les bulletins existants et le moteur par rubriques restent intacts). Pour changer le barème : **ajouter** une entrée à `VERSIONS` (jamais modifier l'ancienne). Absences : un congé de type `unpaid` approuvé dans les RH est déduit automatiquement du brouillon (jours calendaires ÷ diviseur, 30 par défaut, modifiable). Solde de tout compte (`/payroll/cm/settlements`) : prorata du mois, congés non pris ; préavis et indemnité de licenciement **saisis**, jamais calculés. États CSV : `/payroll/cm/export/cnps.csv`, `/irpp.csv`, `/transfers.csv?channel=bank|mobile` (matricule CNPS, NIU, canal et compte de paiement se saisissent sur la fiche employé, réservés aux administrateurs).
- **Comptabilité** (`/accounting`, administrateurs) : rapprochement bancaire (`/bank` : import CSV avec détection du séparateur, du format de date, du séparateur décimal et des colonnes, ré-import sans doublon, suggestions par montant + date + référence, pointage manuel, écriture depuis une ligne de relevé, écarts) ; lettrage 411 / 401 (`/lettering`) et balance âgée (`/aged`) ; dettes fournisseurs avec échéances (`/payables`, alimentées par les réceptions du module Stock via `POST /payables/from-purchases`, sans seconde écriture d'achat) ; immobilisations et amortissement linéaire (`/assets`, dotation mensuelle `POST /assets/depreciate`, aucune durée imposée) ; clôture mensuelle guidée (`/closing` : liste de contrôle, charges constatées d'avance et charges à payer contre-passées le mois suivant, provisions ; un mois clôturé refuse toute écriture jusqu'à sa réouverture motivée) ; écarts de caisse (`/cash-counts`).
- **Budget** (`/budget`) : budget annuel par catégorie sur 12 mois (`/annual`), réalisé **lu dans la comptabilité** (table de correspondance compte -> catégorie, `/map`) : **une seule source de vérité**. Les lignes miroir créées par un paiement de facture, une réception d'achat ou un bulletin (colonnes `source` / `source_id` de `budget_entries`) sont ignorées dès que la compta contient l'écriture ; les saisies à la main non comptabilisées sont comptées « hors compta » ; les doublons probables sont proposés à la liaison (`/duplicates`). `POST /budget/entries` accepte `ledger: true` (administrateur) pour saisir **une fois** budget et compta. Engagements (`/commitments`), prévision de trésorerie à 3 mois (`/cashflow`, hypothèses listées), seuil de validation des dépenses (`/settings`, `/requests`) : au-dessus du seuil, la dépense d'un responsable devient une demande (`202`) qu'un administrateur accepte ou refuse. Les données existantes et la vue mensuelle ne changent pas.

### Vague 3 : RH, décisions, projets, juridique, service client, marketing, tableau de bord, données

- **RH** (`/hr`) : jours fériés du Cameroun donnés en exemple (modifiables), soldes de congés en jours ouvrables (1,5 j par mois par défaut, report plafonné, ajustements), contrôle du solde à la demande, notifications (`/notices`), dossier du personnel réservé aux administrateurs (CNI, contact d'urgence, diplômes, matricule CNPS, pièces chiffrées AES-256-GCM), contrats et échéances (fin de CDD, fin d'essai, visite médicale, habilitations) repris dans les alertes, pointage, recrutement (offres, candidats, embauche), évaluations, formations.
- **Décisions** : circuit à plusieurs niveaux selon des seuils de montant (`/decisions/rules`), délégation temporaire, rappels (route et tâche horaire), notification du demandeur, lien vers un achat, une dépense ou un projet.
- **Projets** : budget et coûts, temps passé, charge par personne, jalons, dépendances, commentaires, pièces chiffrées, tâches récurrentes (tâche horaire). **Juridique** : registres (statuts, AG, PV, associés, RCCM) et calendrier de conformité Cameroun étiqueté « à vérifier ». **Procédures** : versions, propriétaire, révision, accusé de lecture. **Équipe** : journal d'audit (`/audit`, valeurs avant / après, champs sensibles masqués) et transfert de propriété.
- **Service client** : délais SLA réglables, satisfaction (lien public envoyé à la résolution), base de connaissances lue par l'IA, lien ticket - fiche client, formulaire public (`POST /api/ws/public/intake/:token`), réponse envoyée par e-mail ou WhatsApp (opposition respectée), rapports.
- **Marketing** : consentement enregistré par client, segments, envoi groupé e-mail / WhatsApp (modèle approuvé) avec quotas journaliers et lien de désinscription, codes promo appliqués aux devis et factures (ligne « Remise »).
- **Tableau de bord** : CA, marge estimée, créances par âge, trésorerie, objectifs, seuils d'alertes par organisation, export CSV (le PDF est la page imprimable du site). **Données** : export CSV (clients, factures, stock, tickets) et import (clients, stock) avec aperçu.
- **Agents** : digest planifié (texte seulement) et création de tâches / relances **après confirmation d'une personne**. **Abonnement** : reçu imprimable (`GET /api/payments/:reference/receipt`, aussi joint à l'e-mail de confirmation). **API publique** : `/api/v1/products`, `/stock`, `/payments` ; nouveaux événements de webhook et historique de livraison avec nouvel essai.
- Tout ce qui touche au juridique, à la paie, aux congés et aux jours fériés est un **document de travail** à faire valider. Tests : `npm run test:wave3`.

## 9. Sauvegarde de la base de données

Vos données sont dans PostgreSQL (Neon). Trois niveaux de protection :

- **Neon, automatique** : historique des modifications (*Restore* : revenir à un instant précis, la durée dépend de votre offre) et **branches** (une copie instantanée de la base, pratique avant une grosse modification). Rien à installer.
- **Copie chez vous** : `npm run backup` écrit un fichier `data/backups/manager-ia-AAAA-MM-JJ….json.gz` (toutes les tables, les 14 dernières sont gardées ; `BACKUP_DIR` et `BACKUP_KEEP` règlent le dossier et le nombre). Lancez-la chaque nuit (cron) et copiez le dossier **ailleurs** (autre ordinateur, Google Drive…) : une sauvegarde au même endroit que la base ne protège de rien.
- **Sauvegarde SQL standard** (si vous avez les outils PostgreSQL) : `pg_dump "$DATABASE_URL_UNPOOLED" -Fc -f sauvegarde.dump`, restauration avec `pg_restore`.

Exportez aussi de temps en temps la liste des inscrits en CSV depuis `/admin`.

---

## 10. Sécurité : ce qui est fait, et ce qui vous revient

Fait par le serveur : mots de passe chiffrés (bcrypt), cookies `httpOnly` (invisibles pour le JavaScript du site), en-têtes de sécurité (helmet), limites de débit (globale et par action sensible), validation de toutes les entrées, requêtes SQL paramétrées, taille des requêtes limitée (100 Ko), vérification de l'origine des requêtes, journaux sans mots de passe ni jetons, offre et date d'expiration impossibles à modifier par le client, signature des webhooks Meta vérifiée, webhook Campay recontrôlé auprès de Campay.

À votre charge :
- Utilisez **HTTPS** partout (Render/Railway le fournissent ; sur un VPS, certbot).
- Choisissez un `ADMIN_PASSWORD` long et unique ; ne le partagez pas ; activez la double authentification de l administrateur.
- Gardez vos clés secrètes : si l'une fuit, **changez-la immédiatement** chez le fournisseur.
- Faites des sauvegardes (section 9) et mettez à jour les dépendances de temps en temps (`npm audit`, `npm update`).
- Respectez la protection des données de vos inscrits (noms, numéros, e-mails).

Remarque : les numéros camerounais à 9 chiffres commençant par 6 sont enregistrés avec le préfixe `237` (ex : `653621388` devient `237653621388`) pour qu'un même numéro écrit de plusieurs façons soit reconnu.

---

## 11. Référence rapide de l'API

Utilisateur (cookie `mia_token`, 30 jours) :
`POST /api/register` · `POST /api/login` · `POST /api/logout` · `GET /api/me` · `PUT /api/me/state` · `POST /api/contact` · `POST /api/assistant` · `GET /api/plans` · `POST /api/payments/initiate` · `POST /api/payments/confirm-manual` · `GET /api/payments/:reference` · `POST|GET /api/payments/webhook/campay` · `GET /api/health`

Administrateur (cookie `mia_admin`) :
`POST /api/admin/login` · `POST /api/admin/logout` · `GET /api/admin/stats` · `GET /api/admin/users?q=&plan=` · `GET /api/admin/payments?status=` · `POST /api/admin/payments/:id/validate` · `POST /api/admin/payments/:id/reject` · `POST /api/admin/users/:id/plan` · `GET /api/admin/leads` · `GET /api/admin/notifications` · `GET /api/admin/export/users.csv`

Webhooks Meta : `GET|POST /webhooks/whatsapp` · `GET|POST /webhooks/meta`

Tâches automatiques (toutes les heures) : les offres expirées repassent à « Gratuit » ; un rappel est envoyé 3 jours avant l'expiration (e-mail si le contact est un e-mail, et notification pour vous), une seule fois par période.

---

## 12. Check-list de mise en ligne

- [ ] `https://VOTRE-DOMAINE/api/health` répond `{"ok":true}`
- [ ] Je peux créer un compte, me déconnecter, me reconnecter
- [ ] Je me connecte à `/admin` et je vois mon inscription de test
- [ ] J'ai reçu l'e-mail et le message WhatsApp de notification
- [ ] Un paiement de test (manuel ou Campay) active bien l'offre
- [ ] L'assistant du site répond (clé Anthropic)
- [ ] Message de test envoyé au numéro WhatsApp de l'entreprise : l'agent répond
- [ ] La base Neon est reliée (`npm run db:check` répond « Connexion OK ») et `npm run backup` est programmé
- [ ] `JWT_SECRET` et `ADMIN_PASSWORD` sont longs et secrets
