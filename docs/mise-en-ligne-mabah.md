# Mise en ligne de MABAH (fusion « fusion-mabah »)

Procédure à suivre **par le fondateur**. Rien n'a été poussé : les deux dossiers de travail (`~/Downloads/MANAGER-IA/fusion/serveur` et `fusion/site`) n'ont **aucun lien avec GitHub** ; vous ajoutez le lien vous-même (étape 3).

La même copie de ce document se trouve dans `fusion/serveur/docs/` et `fusion/site/docs/`.

## 0. Ce que contient la mise en ligne

| Chantier | Serveur (Render) | Site (Vercel) |
|---|---|---|
| Réunions avancées (quorum, votes, procès-verbaux, signatures, conflits d'agenda, visioconférence) | migrations **146 à 149** | écrans Réunions |
| Espaces par rôle — **activés pour tout le monde** | migrations **170 à 173** | menu par espace, message d'information |
| Marque de l'entreprise (« Personnalisation de mon entreprise ») | migrations **200 et 201** | écran de personnalisation |
| Renommage Brij-IA → **MABAH** (assistante **MABAH IA**), logo, palette du logo, slogan « Pilotez votre entreprise avec le meilleur outil. » | textes, e-mails, PDF, invites de l'IA | tout le site, icônes, SEO |
| Nouvelle adresse publique **https://mabah.vercel.app** | constante centrale + origines acceptées | redirection des anciennes adresses, sitemap, robots |

Les migrations sont **ajoutées à la suite** (aucune ancienne n'est modifiée) ; les numéros libres (150 à 169, 174 à 199) sont des migrations vides « réservées » : le module Chat interne et les suivants prendront ces numéros.

**À faire avant d'aller plus loin** : la base de production n'est jamais touchée par le script de renommage (il ne change que du code). Mais le serveur applique tout seul les nouvelles migrations **au démarrage** : d'où la sauvegarde ci-dessous.

## 1. Sauvegarde de la base (Render) — AVANT de pousser

1. Render → votre base PostgreSQL → onglet **Backups** (ou **Recovery**) → **Create backup** / « Export » selon votre formule. Si votre formule ne propose pas de sauvegarde automatique, utilisez l'export manuel :
   ```bash
   pg_dump "ADRESSE_EXTERNE_DE_LA_BASE_RENDER" --format=custom --file=~/Downloads/sauvegarde-avant-mabah-$(date +%Y%m%d).dump
   ```
   (l'adresse « External Database URL » est dans Render → base → *Connections*).
2. Vérifiez que le fichier existe et n'est pas vide (`ls -lh`). **Ne continuez pas sans sauvegarde.**
3. Notez le **dernier déploiement qui fonctionne** du service Render (Render → service → *Events*) : c'est votre point de retour (§8).

## 2. Variables d'environnement du serveur (Render → service → *Environment*)

À vérifier **avant** la poussée (le serveur actuel les ignorera ou les acceptera sans problème) :

| Variable | Valeur | Remarque |
|---|---|---|
| `SITE_URL` | `https://mabah.vercel.app` | liens des e-mails, WhatsApp, PDF |
| `ALLOWED_ORIGINS` | `https://mabah.vercel.app,https://brij-ia.vercel.app,https://manager-ia-frontend.vercel.app` | pendant la transition : les trois adresses (le serveur contrôle l'origine des formulaires et le CORS). Quand tout est stable (plusieurs semaines), ne garder que `https://mabah.vercel.app`. |
| `ADMIN_EMAIL` | votre adresse de notification (déjà présente en général) | à vérifier, ne pas laisser vide |
| `TRUST_PROXY` | `3` | Render + Vercel (réécriture `/api`) : nécessaire pour que le serveur voie la vraie adresse des visiteurs |
| `SPACES_BY_ROLE` | **vide** (ou `on`) = espaces par rôle activés pour tout le monde. **`off`** = interrupteur de retour arrière général (toutes les entreprises retrouvent l'ancien menu, sans redéployer le site). | voir §8 |
| `SMTP_FROM` | `MABAH <votre-adresse-déjà-validée-chez-Brevo>` | seul le nom d'affichage change ; l'adresse doit rester celle déjà validée dans Brevo (*Senders*). Vérifier aussi le nom d'expéditeur dans Brevo. |
| `API_PUBLIC_URL` | inchangée si elle existe | |
| `COOKIE_*` | ne pas toucher | les cookies sont posés par le serveur à travers la réécriture `/api` de chaque adresse du site |

Vercel (site) : `SITE_URL=https://mabah.vercel.app` est facultative (valeur par défaut du code).

## 3. Lier les dossiers à GitHub (une seule fois), puis vérifier

Les deux dossiers n'ont pas de `origin`. À copier **tel quel** dans le Terminal :

```bash
cd ~/Downloads/MANAGER-IA/fusion/serveur
git remote add origin https://github.com/B144G/manager-ia-backend.git
git fetch origin
git merge-base --is-ancestor origin/claude/postgres-react fusion-mabah && echo "OK : serveur claude/postgres-react est un ancêtre"
git merge-base --is-ancestor origin/master fusion-mabah && echo "OK : serveur master est un ancêtre"
```

```bash
cd ~/Downloads/MANAGER-IA/fusion/site
git remote add origin https://github.com/B144G/manager-ia-frontend.git
git fetch origin
git merge-base --is-ancestor origin/main fusion-mabah && echo "OK : site main est un ancêtre"
```

**Chaque commande doit afficher « OK … ».** Si l'une n'affiche rien, **ne poussez pas** : cela veut dire que GitHub contient des modifications absentes de ce dossier (arrêtez-vous et dites-le moi). Le `git push` sans option `--force` refuse de toute façon d'écraser l'historique.

> Si `fetch` réclame une identification GitHub, utilisez votre compte habituel (jeton personnel ou `gh auth login`).

## 4. Ordre de poussée : le serveur d'abord, puis le site

### 4.1 Serveur → `claude/postgres-react` ET `master`

```bash
cd ~/Downloads/MANAGER-IA/fusion/serveur
git push origin fusion-mabah:claude/postgres-react
git push origin fusion-mabah:master
```

Render redéploie la branche configurée (`claude/postgres-react`). Surveillez Render → *Events / Logs* : le démarrage applique les migrations 146 à 201 (quelques secondes). Contrôlez ensuite :

```bash
curl -s https://manager-ia-backend.onrender.com/api/health
```

(doit répondre « ok »). **Tant que le site n'est pas poussé**, l'ancien site continue de fonctionner avec le nouveau serveur (les ajouts sont compatibles) ; les espaces par rôle sont déjà actifs côté serveur mais l'ancien site ne les affiche pas : c'est sans danger, ne laissez pas cet état plus de quelques minutes.

### 4.2 Site → `main` (Vercel)

```bash
cd ~/Downloads/MANAGER-IA/fusion/site
git push origin fusion-mabah:main
```

Vercel construit et déploie le projet `brij-ia` (nom du projet inchangé).

### 4.3 Domaine principal sur Vercel (manuel)

Vercel → projet → *Settings → Domains* : ajouter **`mabah.vercel.app`**, le définir comme **domaine de production** ; laisser `brij-ia.vercel.app` et `manager-ia-frontend.vercel.app` rattachés au même projet : la redirection permanente est dans `vercel.json` (par hôte, `/api` exclu : les liens signés déjà envoyés et les rappels de paiement vers l'ancienne adresse continuent de fonctionner).

> Limite de ce que j'ai pu vérifier : la **redirection réelle** de `brij-ia.vercel.app` et `manager-ia-frontend.vercel.app` vers `mabah.vercel.app` ne se teste que sur Vercel. Contrôle après déploiement : `curl -sI https://brij-ia.vercel.app/connexion | grep -i "^location\|^HTTP"` doit montrer un code 308 et `location: https://mabah.vercel.app/connexion`. Même contrôle avec `manager-ia-frontend.vercel.app`, puis `curl -s https://brij-ia.vercel.app/api/health` (doit répondre sans redirection).

## 5. Les utilisateurs devront se reconnecter

Les cookies de connexion sont liés au domaine : à la première visite sur `mabah.vercel.app`, **chaque personne doit se reconnecter une fois** (mêmes identifiants). Le choix de cookies et les guides déjà vus sont aussi redemandés (le navigateur ne partage rien entre deux adresses). Les données, comptes et abonnements ne changent pas. Les applications ajoutées à l'écran d'accueil depuis l'ancienne adresse doivent être rajoutées (ancienne icône jusqu'à là).

Message à envoyer aux clients (e-mail, WhatsApp, bandeau) :

> « Brij-IA devient MABAH. Notre adresse change : retrouvez-nous sur https://mabah.vercel.app (l'ancienne adresse vous y redirige). Vos données, vos comptes et vos abonnements sont inchangés ; vous devrez simplement vous reconnecter une fois avec les mêmes identifiants. Votre menu est maintenant organisé par espaces de travail (Commercial, Stock, Comptabilité…) : vos accès restent les mêmes. »

## 6. Espaces par rôle : ce que les clients verront

Dès la mise en ligne, **toutes les entreprises** (existantes et nouvelles) ont les espaces par rôle ; plus de menu latéral général unique. Chaque personne voit une fois un message d'information.

* Le **propriétaire et les administrateurs voient tout**.
* Une personne à qui aucun espace n'a été affecté **garde ses accès actuels**, regroupés par espace (aucun droit n'est retiré ni ajouté). Dès que le propriétaire lui affecte un espace (Équipe et antennes → Espaces par rôle → *Affecter*), elle ne voit plus que ses espaces affectés. À dire aux propriétaires : « affectez les espaces à vos équipes ».
* Retour arrière **par entreprise** : le propriétaire peut désactiver le réglage ; retour **général** : `SPACES_BY_ROLE=off` sur Render (puis *Save, rebuild and deploy* ou redémarrage selon Render).

## 7. Google Search Console

La balise de vérification déjà présente dans `index.html` (jeton `uOEcJIaq…xmUsFfNIxbc`) est **conservée**. Après le déploiement :

1. Ajouter (ou ouvrir) la propriété **`https://mabah.vercel.app`** (type *Préfixe d'URL*). Elle se vérifie avec la même balise si Google la reconnaît ; sinon Google donne une nouvelle balise : la coller dans `index.html` à l'emplacement commenté « NOUVELLE propriété » (ligne 8), **sans retirer l'ancienne**, puis republier le site.
2. *Sitemaps* → soumettre **`https://mabah.vercel.app/sitemap.xml`** (déjà généré sur la nouvelle adresse) ; `robots.txt` pointe lui aussi vers `mabah.vercel.app`.
3. *Inspection de l'URL* → `https://mabah.vercel.app/` → **Demander l'indexation** (une fois).
4. L'outil « Changement d'adresse » n'existe pas pour les sous-domaines `vercel.app` : Google suit la **redirection permanente** (garder `vercel.json` tel quel au moins 12 mois). L'alias « Brij-IA » est déclaré dans les données structurées (`alternateName`) pour relier l'ancien nom au nouveau.
5. Délais indicatifs (non garantis) : quelques jours pour la nouvelle page d'accueil, 1 à 4 semaines pour le nouveau nom dans les résultats.

## 8. Retour arrière

| Problème | Action |
|---|---|
| Les espaces par rôle posent problème | Render → `SPACES_BY_ROLE=off` (effet immédiat après redémarrage) ; ou, pour une entreprise, le propriétaire désactive le réglage. Aucune donnée perdue. |
| Le **site** pose problème | Vercel → *Deployments* → l'ancien déploiement → **Promote to Production** (instantané). Les anciens domaines restent disponibles. |
| Le **serveur** pose problème | Render → service → *Events* → le dernier déploiement qui fonctionnait → **Rollback**. Les migrations 146 à 201 ne sont **que des ajouts** (nouvelles tables et colonnes avec `IF NOT EXISTS`) : le serveur précédent fonctionne sans les retirer. La sauvegarde du §1 ne sert qu'en dernier recours. |
| Une adresse pose problème | Remettre `SITE_URL` sur l'ancienne adresse dans Render **et** Vercel, retirer la règle de redirection de `vercel.json` (deux premières lignes de `redirects`). |

## 9. Ce qui reste à faire par vous (hors code)

* **Textes légaux** : le nom est remplacé, mais l'identité de l'éditeur, l'adresse, le numéro d'immatriculation et le contact restent aux marqueurs « [À COMPLÉTER] » : rien n'a été inventé.
* **Vidéo de présentation** de la page d'accueil (`public/video/manager-ia.mp4`) : elle affiche encore l'ancien nom ; à refaire ou à retirer.
* **WhatsApp Business / Meta**, TikTok, Facebook, Instagram, LinkedIn, YouTube, Brevo (nom d'expéditeur), Campay (adresses de retour si l'ancienne adresse y est saisie) : nom, logo et adresse à mettre à jour (détail : `docs/renommage-mabah.md` §8).
* **Chat interne** : pas inclus dans cette mise en ligne (il sera fusionné ensuite, sur les migrations libres 150 à 169 / 174 à 199).

## 10. Résultats des contrôles de cette fusion

Voir `docs/fusion-mabah-resultats.md` (suite complète, i18n, build, captures).
