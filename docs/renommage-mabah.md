# Renommage « Brij-IA » → « MABAH » (assistant : « MABAH IA »)

Ce document est le mode d'emploi du renommage : **un script rejouable** (pas une modification manuelle), validé aujourd'hui sur la base de production, à **rejouer en quelques minutes sur le code fusionné** (réunions avancées + espaces par rôle + marque d'entreprise) juste avant la mise en ligne. Il vaut pour les deux dépôts ; la même copie se trouve dans `serveur/docs/` et `site/docs/`.

| | Serveur (Render) | Site (Vercel) |
|---|---|---|
| Dépôt local de travail | `~/Downloads/MANAGER-IA/mabah/serveur` | `~/Downloads/MANAGER-IA/mabah/site` |
| Branche renommée | `renommage-mabah` | `renommage-mabah` |
| Partie de | `4e438d2` (production, branche `claude/postgres-react`) | `ac8d704` (branche `slogan-pilotage`, au-dessus de `09457ee`, production sur `main`) |
| Inventaire des occurrences | `docs/renommage-mabah/inventaire-serveur.md` | `docs/renommage-mabah/inventaire-site.md` |
| Captures | `docs/renommage-mabah/captures/` | `docs/renommage-mabah/captures/` |

---

## 1. Ce que fait le renommage

| Domaine | Résultat |
|---|---|
| Nom du produit | « Brij-IA », « BRIJ-IA », « BRIJ<b>-IA</b> » → **MABAH** (capitales) |
| Nom de l'assistant | « Assistant Brij-IA », « l'IA de Brij-IA », « Demandez à Brij-IA », « Point de situation de / Alertes de Brij-IA » (et leurs équivalents EN/DE/ES) → **MABAH IA** |
| Grammaire | « de MABAH », « à MABAH », « Dans MABAH », « l'assistant MABAH IA » : le nouveau nom commence par une consonne comme l'ancien, aucune élision à corriger ; DE : « MABAH-Konto », « MABAH-Nutzer »… |
| Traductions (EN/DE/ES) | Les textes français servent de **clés** des dictionnaires : le script applique **les mêmes règles** aux clés du code et aux clés/valeurs des dictionnaires (les règles ne dépendent que du texte voisin, jamais du fichier). Contrôle : `node scripts/i18n-check.mjs` = 100 % en EN, DE, ES (12 233 textes) ; test « mêmes clés dans les 3 langues ». |
| Textes légaux | `src/legal/content/*` (FR/EN) et `docs/securite/legal/*` : nom remplacé, **aucun champ « [À COMPLÉTER] » touché** (nombre identique avant/après). L'identité de l'éditeur reste à confirmer par le fondateur (§8). |
| E-mails, PDF, WhatsApp | Sujets, signatures (« L'équipe MABAH »), expéditeur par défaut, pied de page des PDF, métadonnées PDF, messages WhatsApp d'alerte/relais, nom de l'appareil lié (« MABAH (Chrome) »), émetteur TOTP (« MABAH »), en-tête `X-Title`. |
| Invites de l'IA | Nom **MABAH IA** ; ajout d'une phrase explicite dans les trois invites (gestion, assistant du site, assistant commercial public) : *« Tu es une intelligence artificielle : tu ne prétends jamais être une personne ni un humain… »*. |
| Pages publiques, `index.html`, manifeste | Titre, description, `og:*`, JSON-LD, manifeste, hors-ligne, profil du fondateur (`/steve-brandon-tenda/`). |
| Documentation | README, docs, base de connaissances de l'IA (`knowledge/`). L'historique (`docs/fusion/**`, anciens journaux `TESTS*.txt`, migrations) n'est **jamais réécrit**. |

Règles complètes : `scripts/rename-brand.mjs` (une règle = une ligne, avec son identifiant ; `--dry-run` les nomme).

## 2. Ce qui n'est volontairement PAS renommé (liste blanche)

Masqué pendant les remplacements, restitué tel quel. Chaque entrée a sa raison dans le script (`WHITELIST`) et dans l'inventaire.

| Conservé | Pourquoi |
|---|---|
| `manager-ia-backend.onrender.com`, dépôts `B144G/manager-ia-*` | Adresses techniques : inchangées. |
| `brij-ia.vercel.app` (**ancienne adresse du site**) | N'est conservée que pour sa **redirection** (`vercel.json`) et comme origine acceptée pendant la transition (`legacyUrls` de `product.js`). **Décision du fondateur : l'adresse publique devient `https://mabah.vercel.app`** (voir §12). |
| `<meta name="google-site-verification" …>` | Vérification Search Console (ancienne propriété) : conservée **octet pour octet** (testée) ; un emplacement est prévu juste dessous pour la balise de la nouvelle propriété (§12). |
| Sel de chiffrement `brij-ia-fields-v2` (`src/services/vault.js`) | Le changer rendrait illisibles les champs chiffrés déjà en base. |
| UID des événements calendrier `…@brij-ia` | Les agendas déjà abonnés créeraient des doublons. (Le `PRODID`, lui, est renommé : sans effet sur les abonnements.) |
| Références de paiement déjà émises `BRIJ-123456` | Toujours acceptées ; **les nouvelles commencent par `MABAH-`**. |
| Valeur interne `mode: 'brij'` de la marque d'entreprise (branche `marque-entreprise`) | Valeur enregistrée en base (`brij` · `powered` · `white`), jamais affichée. |
| `reservedTokens: ['mabah', 'brij']` ; mots de passe faibles `brijia`, `brij` | L'ancien nom reste réservé/interdit en plus du nouveau. |
| Mots de passe de comptes de démonstration `Essai-2026-brij`, chemin local `video-brij-ia-problemes` | Données de démonstration et dossier de l'ordinateur du fondateur. |
| Alias de transition `"alternateName": ["Brij-IA","BRIJ-IA"]` (JSON-LD) | Pour que Google relie l'ancien nom au nouveau. |
| Clés de stockage du navigateur (`brij-cookies`, `brij-guide-seen`, `brij-guide-done`, `brij-2fa-nudge`, `brij-seen:…`) | **Renommées en `mabah-…`**, mais l'ancienne valeur est **copiée** au démarrage (`src/lib/legacy-keys.js`, importé en première ligne de `main.jsx`, jamais effacée : retour arrière sûr). Personne n'est déconnecté, le choix de cookies et les guides déjà vus sont conservés. |
| Aucun cookie ni jeton n'a de « brij » dans son nom | Rien à migrer côté serveur (`mia-lang`, `mi_prefs_v1`… inchangés). |

Le test `test-no-legacy-brand` échoue s'il reste une occurrence hors de cette liste.

## 3. Logo, icônes, couleurs

Source : `~/Downloads/Logo-MABAH/` (icon-512/192/180/64/32, logo transparent 1024). Le logo est une **image** (pas un vrai dessin vectoriel) : `favicon.svg` et `logo.svg` sont des **enveloppes SVG qui intègrent le PNG** (les chemins et les balises `<img src="/logo.svg">` restent les mêmes). La **tuile claire arrondie** du logo sert de « pastille » : lisible en thème clair comme en thème sombre ; un liseré discret la détache d'un fond blanc.

`node scripts/apply-logo.mjs [--from ~/Downloads/Logo-MABAH]` (idempotent, mêmes octets à chaque passage) :

| Où | Fichiers |
|---|---|
| Site | `public/favicon.svg`, `public/logo.svg`, `public/assets/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon,favicon-32,favicon-64}.png`, aperçu de partage `public/assets/og-mabah.png` (1200×630, `og:image`), liens d'icônes de `index.html`, redirections apple-touch de `vercel.json`, **version du cache du service worker** (6 : les anciens logos en cache sont purgés). Le manifeste garde `start_url`, `scope`, `id` (l'application déjà installée reste la même). BrandMark, en-tête et pied de la présentation, connexion/inscription, administration du site : ils lisent tous `/logo.svg` et `/favicon.svg`. |
| Serveur | Administration : `admin/img/*` (logo en-tête, connexion, favicon). PDF : logo en pied de page (`src/assets/mabah-logo-128.png`, affiché seulement si le pied cite MABAH : pas en marque blanche). E-mails de la plateforme : `src/services/mail-html.js` ajoute une version HTML avec le logo (texte brut inchangé ; pas appliqué aux e-mails envoyés au nom d'une entreprise cliente). |
| Images de la présentation | Les 38 captures `public/vitrine/app-*.webp` et `mobile-*.webp` et les 22 vignettes `public/assets/mods/*.jpg` montraient l'ancienne marque (et une ancienne interface) : **régénérées** avec `scripts/vitrine-captures.mjs` + `scripts/vitrine-webp.mjs` (site) et `scripts/demo/capture.js` (serveur). À refaire si l'interface change. |

**Couleurs.** L'interface garde la couleur violette actuelle. Tous les jetons de couleur de marque sont dans **un seul bloc de `src/styles/tokens.css`** (entre les repères `PALETTE` et `FIN-PALETTE` : `--brand-base`, `--brand-dk-base`, `--brand-2`, `--brand-deep`, `--brand-mid`, `--brand-ink`, `--brand-rgb`, `--theme-color`). Les violets qui étaient écrits en dur dans six autres feuilles de style et dans `prefs.js` lisent maintenant ces jetons ; le test `test-no-legacy-brand` vérifie qu'il n'en reste pas.

```bash
node scripts/apply-palette.mjs logo      # bleu du logo (barre du navigateur et manifeste suivent)
node scripts/apply-palette.mjs violet    # retour à la palette actuelle
```

Variante prête et comparaison : `docs/renommage-mabah/palette-logo.css` ; captures `captures/violet-*.png` et `captures/logo-*.png` (mêmes écrans, clair/sombre, bureau/375 px). Les contrastes de la variante « logo » sont AA (#0b5fd6 sur blanc 5,8:1 ; #5da4ff sur fond sombre 6,8:1). La **page de présentation** garde sa direction « bleu nuit et or » (déjà proche du logo).

## 4. Slogan et textes d'accroche

- « **Pilotez votre entreprise avec le meilleur outil.** » : hero et titre (branche `slogan-pilotage`, 4 langues), titre de l'onglet et `og:title`.
- Anciens textes harmonisés (ERP d'abord, MABAH IA en renfort), par règles du script :
  - `<meta name="description">` : « MABAH réunit ventes, stock, factures, comptabilité, paie et équipe dans un seul outil, avec MABAH IA en renfort. Gratuit pour commencer, paiement MTN et Orange Money. »
  - `og:description` et description JSON-LD, description du manifeste : même ton.
  - E-mails : « L'équipe MABAH » ; contenu inchangé.
- Les clés orphelines « Gérez votre entreprise avec une IA qui travaille pour vous » des dictionnaires ne sont plus utilisées par le code (sans effet).

## 5. SEO

`index.html` : titre « MABAH · Pilotez votre entreprise avec le meilleur outil », `og:site_name` = MABAH, JSON-LD **WebSite** (nouveau, `name` « MABAH », `alternateName` « Brij-IA », « BRIJ-IA ») et **SoftwareApplication** (même nom/alias), `og:image` = `/assets/og-mabah.png`, canonical et `og:url` toujours en `%SITE_URL%` (= `https://mabah.vercel.app` par défaut). `sitemap.xml` et `robots.txt` **inchangés**. L'éditeur du JSON-LD reste « BrandX Creation » tel qu'il est aujourd'hui (rien d'inventé : à confirmer, §8).

## 6. Rejouer le script : mode d'emploi et ordre des opérations

**Principe : fusionner d'abord, renommer ensuite.** Les trois modules en validation (`reunions-avance`, `espaces-par-role`, `marque-entreprise`) sont fusionnés dans une branche de fusion ; on lance le script sur le résultat. Ne fusionnez **pas** la branche `renommage-mabah` avec eux : le script est la source du renommage (la branche ne sert qu'à valider et à prouver le résultat), sinon on retombe sur les conflits que le script évite.

Pour chaque dépôt, depuis la branche fusionnée, **arbre de travail propre** :

```bash
# 0. récupérer les scripts (au besoin, depuis la branche de validation)
git checkout renommage-mabah -- scripts/rename-brand.mjs scripts/apply-logo.mjs scripts/test-no-legacy-brand.*   # serveur : .js ; site : .mjs
git checkout renommage-mabah -- scripts/apply-palette.mjs scripts/vitrine-webp.mjs                               # site seulement

# 1. simulation (liste les remplacements ; « À EXAMINER » = une occurrence que les règles ne savent pas classer)
node scripts/rename-brand.mjs --dry-run
# 2. application, puis seconde passe : doit dire « Aucun changement »
node scripts/rename-brand.mjs
node scripts/rename-brand.mjs
node scripts/rename-brand.mjs --check          # « OK : aucune occurrence hors liste blanche »
# 3. logo et icônes (lignes « ATTENTION » = ancre de code modifiée par une branche : reporter à la main, voir §6.2)
node scripts/apply-logo.mjs
# 4. contrôles : serveur  npm test  (TEST_START_TRIES=200)   ·   site  node scripts/i18n-check.mjs && npm run lint && npm run build && npm run test:brand
```

### 6.1 Ce que le script gère quand les trois modules sont fusionnés (vérifié)

Le script a été rejoué sur des copies des branches `marque-entreprise` (serveur et site), qui contiennent `src/services/product.js` et `src/lib/product.js`, sans conflit ni reste :

- `product.js` (existe) : `name`, `shortName`, `mailFromName` → MABAH ; `assistantName` → **MABAH IA** ; `logoMarkup` → `['MABAH', '']` ; `reservedTokens` → `['mabah', 'brij']`. Sur la base de production (absent), le script **crée** `src/services/product.js` (serveur) et `src/lib/product.js` (site) avec les mêmes champs.
- `src/lib/brand.js` (marque, site) : le crochet « le nom de l'assistant de l'entreprise remplace celui de la plateforme » repose sur les clés « Demandez à… / Point de situation de… / Alertes de… / Ce que … a repéré » : le script les réécrit en « … MABAH IA » dans les clés **et** les valeurs, et adapte l'expression (`ASSISTANT_TEXT`) et le remplacement pour qu'ils cherchent `PRODUCT.assistantName` (« MABAH IA ») et non plus le nom du produit. Sans cela, un nom d'assistant d'entreprise ne s'appliquerait plus.
- `pdf.js` (marque) : le logo n'apparaît que si le pied de page cite MABAH (modes « MABAH » et « Propulsé par »), jamais en marque blanche.
- `mode: 'brij'` (valeur enregistrée) : conservé (liste blanche) ; les tests de marque qui vérifiaient « pas de Brij dans le PDF/la signature » vérifient maintenant « pas de MABAH » (règle `regex-test-ancien-nom`).
- Réunions (`meetings.js`, `meetings-lib.js`) : « Brij-IA » → MABAH (convocation) ; la note de la session marque demande en plus de passer par `brand-lib.pn(req.org)` : **hors du périmètre du renommage**, à faire à la fusion comme prévu.
- `i18n-check` sur la copie de la branche marque après rejeu : **12 293 / 12 293** textes traduits en EN, DE, ES.

### 6.2 Points de vigilance au rejeu

1. Une ligne « ATTENTION … ancre introuvable » d'`apply-logo.mjs` signifie qu'une branche a modifié le code visé (pied de page PDF, `sendMail`, en-tête de l'administration) : appliquer la même modification à la main (le script indique le fichier). Les fichiers image sont toujours posés.
2. Les nouveaux textes écrits par ces branches sont renommés comme les autres ; un texte où « Brij-IA » désigne **l'assistant** sans l'un des tournures reconnues (§1) devient « MABAH » : relire les lignes « MABAH » des écrans d'IA si besoin (la règle se complète en une ligne dans `rename-brand.mjs`).
3. Dictionnaires : si une branche ajoute des clés avec le nom, elles sont renommées de la même façon que dans le code ; `i18n-check` le confirme.
4. Les migrations 146+ et leur `padding` ne sont jamais touchées (`src/migrations/**` ignoré) ; le script n'écrit aucune donnée en base.

## 7. Résultats des tests (base renommée)

Détail complet : `docs/renommage-mabah/resultats-tests.md`.

- **Serveur** : `npm test` (chaîne de 75 étapes, `nice`, `TEST_START_TRIES=200`, une seule exécution) : **75/75 réussies** en 4 143 s, dont le nouveau `test:legacy-brand` (15 contrôles).
- **Site** : eslint 0 erreur ; **i18n-check 100 % en EN, DE, ES (12 233/12 233)** ; `npm run test:brand` 29/29 ; `vite build` réussi.
- **Vrai navigateur** (démonstration locale :3500 / :5599, `demo@exemple.com`) : onglet, favicon, manifeste, JSON-LD, présentation / connexion / inscription / tableau de bord / module, bureau et 375 px, clair et sombre, 4 langues, e-mail et PDF : captures dans `docs/renommage-mabah/captures/`.
- **Rejeu** du script sur des copies des branches `marque-entreprise` (aucun reste, i18n 12 293/12 293) et en simulation sur `espaces-par-role` et `reunions-avance` (aucune ligne « À EXAMINER »).

## 8. Étapes MANUELLES pour le fondateur (rien de tout cela n'est fait par le script)

### 8.1 Google

1. **(L'adresse change depuis la décision du fondateur : suivre d'abord §12 ; ce qui suit vaut pour le nom.)** **Search Console** (propriété `brij-ia.vercel.app`, vérifiée par la balise conservée) : **ne rien changer** tant que l'adresse ne change pas. Le changement de nom du site **n'exige pas** « Changement d'adresse ». Après la mise en ligne : *Inspection de l'URL* → page d'accueil → **Demander l'indexation** (une fois), et renvoyer `sitemap.xml` (inchangé) si Google l'a oublié.
2. **Nom du site** : il n'y a pas de réglage de nom dans Search Console. Google lit les données structurées **WebSite** (`name`, `alternateName`), `<title>` et `og:site_name` de la page d'accueil : déjà en place. Vérifier avec le « Test des résultats enrichis » (page d'accueil en production).
3. **Délais réalistes** (indicatifs, non garantis) : nouvelle page d'accueil explorée en quelques jours ; nouveau nom dans les résultats de recherche en 1 à 4 semaines ; l'ancien nom peut rester visible par endroits pendant plusieurs semaines à quelques mois. Garder **l'alias Brij-IA** (JSON-LD) et, si vous le souhaitez, une mention visible « MABAH (anciennement Brij-IA) » sur la page de présentation pendant la transition.
4. **Si un nouveau domaine est choisi** : (a) ajouter et vérifier la nouvelle propriété (pour le passage à `mabah.vercel.app`, voir §12) (propriété de type *Domaine* par DNS recommandée) ; (b) mettre `SITE_URL` (Vercel **et** Render) et `ALLOWED_ORIGINS` (Render) sur le nouveau domaine, redéployer ; (c) **redirections 301 page par page** de `brij-ia.vercel.app` vers le nouveau domaine (règles `redirects` de `vercel.json` avec condition sur l'hôte), conservées au moins 12 mois (180 jours minimum) ; (d) dans l'ancienne propriété : *Paramètres* → **Changement d'adresse** vers la nouvelle ; (e) mettre à jour `product.js` (`publicUrl`, 1 ligne côté serveur), les liens de la page du fondateur, les rappels d'adresses chez Campay, Meta/WhatsApp (webhooks, domaines de l'application) et le domaine de l'expéditeur des e-mails (SPF/DKIM chez Brevo).
5. **Profil d'établissement Google** (Google Business Profile), s'il existe : modifier le nom de l'établissement (le nom doit correspondre à celui utilisé dans la vie réelle ; une re-vérification peut être demandée).

### 8.2 Render, Vercel, e-mail

| Où | Quoi |
|---|---|
| Vercel (site) | `SITE_URL` = `https://mabah.vercel.app` (§12) ; après déploiement, vérifier `view-source:` de la page d'accueil. |
| Render (serveur) | `SITE_URL` = `https://mabah.vercel.app` et `ALLOWED_ORIGINS` = les deux adresses (§12) ; **`SMTP_FROM`** : remplacer le nom d'affichage par `MABAH <adresse déjà validée chez Brevo>` (l'adresse, elle, reste la même) ; vérifier le nom d'expéditeur dans Brevo (*Senders*). Aucune variable ne fixe le nom de l'assistant : il est dans `src/services/product.js` (`assistantName`) ; après fusion, chaque entreprise peut le surcharger dans « Personnalisation ». |
| Application installée | Les téléphones qui ont **ajouté le site à l'écran d'accueil** gardent l'ancienne icône jusqu'à ce qu'on la rajoute ; ce n'est pas bloquant. |

### 8.3 WhatsApp, réseaux, communication

- **WhatsApp Business** (API officielle ou application) : demander le changement du *nom d'affichage* dans Meta Business (soumis à examen, de quelques heures à quelques jours) et mettre le logo (`Logo-MABAH/icon-512.png`) ; le **QR code** (WhatsApp Web) affiche « MABAH (Chrome) » dans *Appareils connectés* pour les **nouvelles** liaisons ; les liaisons existantes gardent l'ancien nom d'appareil jusqu'à une nouvelle liaison (sans conséquence).
- **TikTok, Facebook, Instagram, LinkedIn, YouTube** : nom du compte, identifiant (@) si souhaité, biographie, photo de profil (le logo), lien du site ; les anciens liens continuent de fonctionner.
- Fichiers de communication existants (`Brij-IA-posts-reseaux-sociaux.txt`, vidéos `brij-ia-*.mp4`, `Guide-Brij-IA.pdf`) : **non modifiés** (hors dépôts) ; à refaire ou à republier au fil de l'eau.
- **Vidéo de présentation** de la page d'accueil (`public/video/manager-ia.mp4` et `poster.jpg`) : elle affiche encore le nom « Brij-IA ». Je n'ai pas pu la refaire (montage vidéo) : **décision du fondateur** : la remplacer, ou masquer le bouton « Voir la vidéo de présentation » jusqu'au nouveau film.

### 8.4 Textes légaux et identité de l'éditeur

Le script ne change que le **nom du produit** dans les textes légaux. À confirmer par le fondateur, sans rien inventer : qui est l'éditeur et responsable de traitement (l'éditeur du JSON-LD est aujourd'hui « BrandX Creation », le fondateur est cité comme « Tenda Steve Brandon » dans la base de connaissances), adresse, numéro d'immatriculation, contact. Les champs « [À COMPLÉTER] » sont **intacts**. Les textes d'avertissement déjà présents dans l'application (« document de travail… à faire valider par un expert-comptable ») sont **inchangés** par ce renommage ; leur éventuel retrait est une décision de contenu distincte.

## 9. Limites connues

- Le **contenu déjà enregistré en base** (modèles de messages, textes d'accueil, journaux, noms saisis par les utilisateurs) n'est pas réécrit : le script ne touche que le code et les fichiers.
- Vidéo et visuels hors dépôt (§8.3).
- Le logo est une image : agrandi au-delà de ~1000 px, il serait flou ; un vrai fichier vectoriel (.svg/.ai) du graphiste le remplacerait sans autre changement (mêmes noms de fichiers).
- `og:image` : l'aperçu de partage généré (`og-mabah.png`) est une proposition ; les réseaux mettent les aperçus en cache (utiliser leurs outils de « rafraîchissement » : Facebook *Sharing Debugger*, LinkedIn *Post Inspector*).
- Le rendu « Propulsé par MABAH » / les textes d'assistant de la branche marque se règlent à la fusion (§6.1) : je les ai vérifiés par rejeu sur une copie, pas sur la branche fusionnée réelle (elle n'existe pas encore).
- Les captures utilisent des données fictives (« Atelier Nkoulou (TEST) », « Boutique Awa »).

## 10. Commandes de poussée (à exécuter par le fondateur ; je n'ai rien poussé)

Les deux clones de travail ont déjà un remote `github` (ajouté, jamais utilisé : aucun `fetch` ni `push` n'a été fait vers GitHub). **Ancêtre vérifié** localement : `4e438d2` (serveur, production `claude/postgres-react`) et `09457ee` (site, production `main`) sont des ancêtres des branches `renommage-mabah` ; les remotes de ces vérifications étant ceux de vos copies locales, **refaire la vérification après le `git fetch` ci-dessous**.

### Option A (recommandée maintenant) : publier seulement les branches de validation, sans rien déployer

```bash
cd ~/Downloads/MANAGER-IA/mabah/serveur
git fetch github
git merge-base --is-ancestor github/claude/postgres-react renommage-mabah && echo "OK : ancêtre"   # doit afficher « OK : ancêtre »
git push github renommage-mabah:renommage-mabah
```

```bash
cd ~/Downloads/MANAGER-IA/mabah/site
git fetch github
git merge-base --is-ancestor github/main renommage-mabah && echo "OK : ancêtre"                    # doit afficher « OK : ancêtre »
git push github renommage-mabah:renommage-mabah
```

(Vercel peut créer un aperçu de la branche `renommage-mabah` ; Render ne déploie que `claude/postgres-react`.)

### Option B : mettre le renommage en ligne tout de suite (avant la fusion des trois modules)

À ne faire que si vous acceptez que la fusion des trois modules se fasse ensuite **par le script** (on rejoue `rename-brand.mjs` sur chaque branche avant de la fusionner, ou après la fusion) et non par un `git merge` de `renommage-mabah` : sinon, conflits sur des centaines de lignes de textes. Les deux dépôts doivent être poussés **ensemble** (le serveur a de nouvelles références de paiement `MABAH-` et le site du nouveau logo).

```bash
cd ~/Downloads/MANAGER-IA/mabah/serveur
git fetch github
git merge-base --is-ancestor github/claude/postgres-react renommage-mabah && git push github renommage-mabah:claude/postgres-react   # avance rapide : refusé par Git si l'historique a divergé

cd ~/Downloads/MANAGER-IA/mabah/site
git fetch github
git merge-base --is-ancestor github/main renommage-mabah && git push github renommage-mabah:main
```

Après la mise en ligne : vérifier `https://<site>/` (titre, favicon, `view-source:` du JSON-LD), `https://<serveur>/api/health`, une connexion (personne n'est déconnecté), puis suivre §8.

### Rejouer sur le code fusionné (mode d'emploi court)

Voir §6 : fusionner, puis `rename-brand.mjs` (2 fois) → `--check` → `apply-logo.mjs` → tests.

## 12. Nouvelle adresse publique : https://mabah.vercel.app

**Où elle est définie (une seule fois par dépôt).** Serveur : `src/services/product.js` → `publicUrl` (`SITE_URL` prioritaire) et `legacyUrls`. Site : `vite.config.js` → `DEFAULT_SITE_URL` (variable `SITE_URL` prioritaire ; elle alimente canonical, `og:url`, `og:image`, JSON-LD, `sitemap.xml`, `robots.txt`) et `src/lib/product.js`. Le script (`rename-brand.mjs`) remplace partout `brij-ia.vercel.app` par `mabah.vercel.app` (page du fondateur, textes d'aide, docs, e-mails, PDF, liens WhatsApp). Liens d'e-mails et de WhatsApp : construits à partir de `SITE_URL`/`API_PUBLIC_URL` (Render).

**Redirection de l'ancienne adresse** (`vercel.json`, première règle de `redirects`) : redirection **permanente basée sur l'hôte** `brij-ia.vercel.app` → `https://mabah.vercel.app/:path`, chemin et paramètres conservés. Elle **exclut `/api`** : sur l'ancien hôte, `/api/...` continue d'être relayé vers Render (réécriture inchangée), de sorte que les pages ouvertes, les liens signés déjà envoyés (désinscription, etc.) et les appels de paiement/webhooks pointant sur l'ancienne adresse ne cassent pas ; les pages (`/localiser/…`, `/devis/…`, `/suivi/…`, `/form`, `/chat`, `/satisfaction/…`) sont, elles, redirigées. Vérifiée par test (structure) ; **à contrôler en vrai après déploiement** : `curl -sI "https://brij-ia.vercel.app/connexion?x=1"` doit répondre 308 vers `https://mabah.vercel.app/connexion?x=1`, et `https://brij-ia.vercel.app/api/health` doit répondre 200.

**Variables à régler sur Render (serveur)** : 
| Variable | Valeur pendant la transition | Après la transition |
|---|---|---|
| `SITE_URL` | `https://mabah.vercel.app` | idem |
| `ALLOWED_ORIGINS` | `https://mabah.vercel.app,https://brij-ia.vercel.app` (les deux : le serveur accepte les deux origines pour CORS **et** pour le contrôle d'origine des formulaires) | `https://mabah.vercel.app` seul |
| `API_PUBLIC_URL` | inchangée si définie (adresse Render ou du site) | idem |
Vercel : `SITE_URL=https://mabah.vercel.app` (facultatif, c'est la valeur par défaut). Les cookies sont posés par le serveur à travers la réécriture `/api` de chaque hôte : aucun réglage `COOKIE_DOMAIN`. Campay : les redirections/rappels de paiement passent par `SITE_URL`/`API_PUBLIC_URL` : à revérifier dans le tableau de bord Campay si l'adresse du site y est saisie ; Meta/WhatsApp : si l'adresse du site est enregistrée (domaines de l'application), ajouter `mabah.vercel.app`.

**Sessions : un changement d'adresse déconnecte tout le monde.** Les cookies de connexion sont liés à l'adresse (hôte) : à la première visite sur `mabah.vercel.app`, chaque personne devra **se reconnecter une fois** ; le choix de cookies et les guides déjà vus sont aussi liés à l'hôte (le stockage du navigateur ne passe pas d'une adresse à l'autre : la migration douce `legacy-keys` ne couvre que le renommage des clés sur un même hôte) et seront redemandés. Les données, elles, ne sont pas touchées. Les applications installées sur l'écran d'accueil depuis l'ancienne adresse redirigent vers la nouvelle ; il peut être utile de les réinstaller.

**Message d'information proposé pour les clients** (e-mail, WhatsApp, bandeau) : « Brij-IA devient MABAH. Notre adresse change : retrouvez-nous sur https://mabah.vercel.app. L'ancienne adresse vous y redirige. Vos données, vos comptes et vos abonnements sont inchangés ; vous devrez simplement vous reconnecter une fois avec les mêmes identifiants. »

**Étapes manuelles Vercel.** (1) Projet existant → *Settings → Domains* → ajouter `mabah.vercel.app` (le nom doit être disponible) ; (2) le définir comme **domaine principal** (*Production domain*) ; (3) laisser `brij-ia.vercel.app` rattaché au même projet : la règle de `vercel.json` le redirige (ne pas utiliser en plus la redirection de domaine de l'interface, ce serait redondant) ; (4) déployer ce site (`renommage-mabah`) puis exécuter les deux `curl` ci-dessus ; (5) pousser en même temps la variable `ALLOWED_ORIGINS` sur Render et redéployer le serveur **avant** de basculer le trafic.

**Étapes manuelles Google.** L'outil « Changement d'adresse » n'est **pas disponible** pour un sous-domaine `vercel.app` : on s'appuie sur (a) la **redirection 301/308 permanente** ci-dessus, (b) une **nouvelle propriété** Search Console pour `https://mabah.vercel.app` (type *Préfixe d'URL*), vérifiée par la balise HTML : coller la balise `<meta name="google-site-verification" …>` fournie par Google dans `index.html` à l'emplacement commenté « NOUVELLE propriété » (**garder** l'ancienne balise tant que l'ancienne propriété sert), (c) la soumission de `https://mabah.vercel.app/sitemap.xml` dans la nouvelle propriété, puis *Inspection de l'URL → Demander l'indexation* de l'accueil, (d) l'alias `"alternateName": ["Brij-IA", "BRIJ-IA"]` du JSON-LD. Conserver la redirection au moins 12 mois. Délais indicatifs : de quelques jours à plusieurs semaines avant que Google privilégie la nouvelle adresse ; l'ancienne peut rester visible un temps.

## 11. Fichiers livrés

| | Serveur | Site |
|---|---|---|
| Scripts | `scripts/rename-brand.mjs`, `scripts/apply-logo.mjs`, `scripts/test-no-legacy-brand.js` (`npm run test:legacy-brand`) | `scripts/rename-brand.mjs`, `scripts/apply-logo.mjs`, `scripts/apply-palette.mjs`, `scripts/vitrine-webp.mjs`, `scripts/test-no-legacy-brand.mjs` (`npm run test:brand`) |
| Docs | ce fichier, `docs/renommage-mabah/inventaire-serveur.md`, `resultats-tests.md`, `captures/` (administration, e-mail, PDF) | ce fichier, `docs/renommage-mabah/inventaire-site.md`, `palette-logo.css`, `captures/` |
| Nouveaux fichiers de code | `src/services/product.js`, `src/services/mail-html.js`, `src/assets/mabah-logo-128.png`, `admin/img/*` | `src/lib/product.js`, `src/lib/legacy-keys.js`, icônes et `og-mabah.png` |
