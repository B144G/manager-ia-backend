# MANAGER-IA : serveur (backend)

## Liaison site (frontend) ↔ serveur (backend)

Deux dossiers, deux adresses. Le site doit connaître l'adresse du serveur, et le serveur doit autoriser l'adresse du site.

| | Dossier | Adresse en essai local | Où se règle le lien |
|---|---|---|---|
| **Serveur (API)** | `manager-ia-backend` | `http://localhost:3000` | fichier `.env` du serveur : `PORT`, `SITE_URL`, `ALLOWED_ORIGINS` |
| **Site** | `manager-ia-frontend` | `http://localhost:5173` | fichier `.env` du site : `API_BASE` (puis `npm run config`) |

## Essayer sur votre ordinateur (3 commandes de chaque côté)

```bash
# 1) Le serveur
cd manager-ia-backend
npm run setup      # crée .env avec des secrets aléatoires et affiche le mot de passe administrateur
npm install
npm start          # http://localhost:3000

# 2) Le site (autre terminal)
cd manager-ia-frontend
npm start          # écrit config.js depuis .env puis sert le site sur http://localhost:5173
```

Ouvrez <http://localhost:5173>. Si le port 3000 est déjà pris sur votre machine, changez `PORT` dans le `.env` du serveur **et** `API_BASE` dans le `.env` du site (puis `npm run config`).

## En ligne

| Situation | `.env` du site | `.env` du serveur |
|---|---|---|
| **Même domaine** (recommandé : copiez le site dans `manager-ia-backend/public`) | `API_BASE=` (vide) | `ALLOWED_ORIGINS` vide, `COOKIE_SAMESITE=lax` |
| **Deux domaines** (site `https://manager-ia.com`, serveur `https://api.manager-ia.com`) | `API_BASE=https://api.manager-ia.com` | `ALLOWED_ORIGINS=https://manager-ia.com`, `SITE_URL=https://manager-ia.com`, `COOKIE_SAMESITE=none`, `COOKIE_SECURE=true` (HTTPS obligatoire) |

Vérifications : `https://<serveur>/api/health` doit répondre `{"ok":true}` ; dans le navigateur, la connexion crée un cookie `mia_token`. Une erreur « Origine non autorisée » signifie que `ALLOWED_ORIGINS` ne contient pas l'adresse exacte du site (avec `http`/`https` et sans `/` final).

Le `.env` du site ne contient **aucun secret** (l'adresse du serveur est publique). Celui du serveur en contient : ne le publiez jamais (il est exclu des zips et de Git).

---


Ce dossier contient le « cerveau » du site MANAGER-IA : comptes des utilisateurs, offres Gratuit / Pro / Pro Max / Méga Pro / Illimité, paiements, assistant IA, agent de service client (WhatsApp, Messenger, Instagram), notifications pour vous, et une page d'administration (`/admin`).

Il fonctionne avec **Node.js 20 ou plus** et une base de données **PostgreSQL** (gratuite et hébergée chez **Neon**, voir la section 4). Le serveur est prévu pour **Render**, le frontend React pour **Vercel**.

> **Important : à lire avant de commencer**
> - Ce code a été écrit et vérifié sans accès à vos vrais comptes (Campay, Meta/WhatsApp, e-mail, Anthropic). Faites **toujours un essai réel** de chaque service après le déploiement (voir « Check-list de mise en ligne » à la fin).
> - Les appels vocaux (téléphone) **ne sont pas gérés** par ce serveur : voir la section « Agent de service client ».

---

## 1. Installation sur votre ordinateur (essai)

1. Installez Node.js 20 ou plus : <https://nodejs.org> (version « LTS »).
2. Ouvrez un terminal dans ce dossier, puis :
   ```bash
   npm install
   cp .env.example .env        # sous Windows : copy .env.example .env
   ```
3. Ouvrez le fichier `.env` avec un éditeur de texte et remplissez au minimum :
   ```
   ADMIN_USERNAME=votre_identifiant
   ADMIN_PASSWORD=un_mot_de_passe_long_et_unique
   ```
   (Tout le reste est facultatif pour un premier essai.)
4. Lancez :
   ```bash
   npm start
   ```
5. Ouvrez <http://localhost:3000/api/health> : vous devez voir `{"ok":true}`. La page d'administration est sur <http://localhost:3000/admin>.

Sans aucune clé externe, le serveur démarre quand même : les notifications s'affichent dans le terminal, les paiements sont en mode manuel et l'assistant IA répond « indisponible » (le site a un plan B).

**Commandes utiles**
- `npm start` : démarre le serveur.
- `npm run dev` : démarre et redémarre tout seul quand vous modifiez le code.
- `npm run smoke` : lance un test automatique complet sur une base temporaire (rien n'est modifié chez vous). Tout doit afficher « OK ».

---

## 2. Brancher le frontend

**Cas simple (recommandé) : même adresse.** Copiez les fichiers de votre site (le `index.html` et ses fichiers) dans le dossier `public/`. Le serveur les affiche à la racine (`/`), et l'API est sur `/api/...`. Rien d'autre à régler : les cookies de connexion fonctionnent directement.

**Frontend sur un autre domaine** (par exemple le site sur `https://manager-ia.com` et le serveur sur `https://api.manager-ia.com`) :
1. Dans les variables : `ALLOWED_ORIGINS=https://manager-ia.com,https://www.manager-ia.com`
2. `COOKIE_SAMESITE=none` et `COOKIE_SECURE=true` (le HTTPS est obligatoire).
3. Côté frontend, chaque appel doit envoyer les cookies : `fetch(url, { credentials: "include", ... })`.

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

## 4. Mise en ligne, pas à pas

Dans tous les cas, définissez au minimum : `NODE_ENV=production`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, et vos numéros de paiement (`MTN_NUMBER`, `ORANGE_NUMBER`, `PAYMENT_HOLDER_NAME`).

Générer un `JWT_SECRET` :
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Étape 1 : la base PostgreSQL sur Neon

1. Créez un compte gratuit sur <https://neon.tech> (vous le faites vous-même) puis *New Project*. Choisissez la région la plus proche de vos clients et de votre serveur (ex. *AWS Europe (Frankfurt)*).
2. Sur le tableau de bord du projet, bouton **Connect** : copiez deux adresses.
   - **Pooled connection** (contient `-pooler`) → variable `DATABASE_URL`.
   - **Direct connection** (sans `-pooler`) → variable `DATABASE_URL_UNPOOLED` (utilisée seulement pour créer/mettre à jour les tables).
3. Ne les envoyez à personne et ne les mettez jamais dans le dépôt GitHub : elles contiennent le mot de passe de la base.
4. Au premier démarrage, le serveur crée **toutes les tables tout seul** (migrations numérotées, table `schema_migrations`). Rien d'autre à faire.
5. Pour vérifier depuis votre machine : mettez les adresses dans `.env`, puis `npm run db:check`.

Neon met la base en veille après quelques minutes sans activité (offre gratuite) : le premier message après une pause peut prendre 1 à 3 secondes de plus. Le serveur réessaie automatiquement la connexion pendant ce réveil.

**Vous avez déjà des données dans l'ancienne base SQLite ?** Une seule fois, sur une base Neon vide :
```bash
npm i --no-save better-sqlite3
npm run db:import-sqlite -- chemin/vers/manager-ia.db
```
L'ancien fichier n'est jamais modifié.

### Étape 2 : Option A — Render (recommandé)

Le fichier `render.yaml` décrit tout le service. Deux façons :

- **Blueprint (le plus rapide)** : <https://render.com> → *New* → *Blueprint* → choisissez ce dépôt GitHub **privé**. Render vous demande les valeurs « secrètes » (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`…) : saisissez-les vous-même dans son tableau de bord.
- **À la main** : *New* → *Web Service* → votre dépôt ; *Runtime* = Node ; *Build Command* = `npm ci --omit=dev --omit=optional` ; *Start Command* = `node src/server.js` ; *Health Check Path* = `/api/health` ; puis ajoutez les variables de la section 3.

Variables à régler pour un frontend sur **Vercel** : `SITE_URL` et `ALLOWED_ORIGINS` = l'adresse Vercel du frontend ; `API_PUBLIC_URL` = l'adresse Render de ce serveur ; `COOKIE_SAMESITE=lax` si Vercel redirige `/api` vers Render (fichier `vercel.json` du frontend, **recommandé** : les cookies restent « du même site », ce qui marche aussi sur Safari/iPhone), sinon `none`.

Aucun disque n'est nécessaire : tout est dans Neon. Testez `https://votre-service.onrender.com/api/health` (doit répondre `{"ok":true,"db":true}`). Les adresses de webhook (WhatsApp, Messenger, Campay) pointent vers l'adresse Render.

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
2. Allez sur <https://myaccount.google.com/apppasswords>, donnez un nom (ex : « MANAGER-IA ») et créez le mot de passe : Google affiche 16 lettres.
3. Dans les variables :
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=votre.adresse@gmail.com
   SMTP_PASS=les16lettres (sans espaces)
   SMTP_FROM=MANAGER-IA <votre.adresse@gmail.com>
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
     Notification MANAGER-IA : {{1}} Consultez votre espace administrateur pour la suite.
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
