# Résultats des tests : base renommée MABAH

Exécution du 24 novembre 2026, après le changement d'adresse publique vers mabah.vercel.app (la série du 23 novembre était aussi 75/75), machine chargée par d'autres sessions (`nice`, une seule exécution, `TEST_START_TRIES=200`).

## Serveur : `npm test` (chaîne complète de `package.json`, 75 étapes)

**Résultat : 75/75 étapes réussies en 1609 s**

| Statut | Étape (durée) |
|---|---|
| OK | npm run test:margin (2 s) |
| OK | npm run test:custom (12 s) |
| OK | npm run test:attach (9 s) |
| OK | npm run test:ai (74 s) |
| OK | npm run test:webhooks (10 s) |
| OK | npm run smoke (16 s) |
| OK | npm run smoke:signup (97 s) |
| OK | npm run smoke:security (19 s) |
| OK | npm run smoke:central (26 s) |
| OK | npm run smoke:ws (50 s) |
| OK | npm run test:finance (15 s) |
| OK | npm run test:commerce (13 s) |
| OK | npm run test:ops (12 s) |
| OK | npm run test:intelligence (23 s) |
| OK | npm run test:mail (1 s) |
| OK | npm run test:embedded (21 s) |
| OK | npm run test:waqr (15 s) |
| OK | npm run test:wave1 (54 s) |
| OK | npm run test:wave2 (48 s) |
| OK | npm run test:accpro (18 s) |
| OK | npm run test:acclot3 (13 s) |
| OK | npm run test:wave3 (59 s) |
| OK | npm run test:digest-email (35 s) |
| OK | npm run test:wave4 (49 s) |
| OK | npm run test:wave6 (12 s) |
| OK | npm run test:wave7 (11 s) |
| OK | npm run test:payflow (15 s) |
| OK | npm run test:clients (23 s) |
| OK | npm run test:aifollow (14 s) |
| OK | npm run test:library (23 s) |
| OK | npm run test:purchasing (16 s) |
| OK | npm run test:wms (13 s) |
| OK | npm run test:hu (14 s) |
| OK | npm run test:secnew (26 s) |
| OK | npm run test:wms4c (14 s) |
| OK | npm run test:bp (12 s) |
| OK | npm run test:wms4e (13 s) |
| OK | npm run test:wms4d (14 s) |
| OK | npm run test:tms (14 s) |
| OK | npm run test:accstock (11 s) |
| OK | npm run test:bankformats (12 s) |
| OK | npm run test:accstock2 (11 s) |
| OK | npm run test:configprod (2 s) |
| OK | npm run test:security (203 s) |
| OK | npm run test:fusion (12 s) |
| OK | npm run test:libraryb (31 s) |
| OK | npm run test:purchasingb (15 s) |
| OK | npm run test:purchasingwms (11 s) |
| OK | npm run test:stockwms (20 s) |
| OK | npm run test:adminlive (32 s) |
| OK | npm run test:stockcompta (12 s) |
| OK | npm run test:projetsro (13 s) |
| OK | npm run test:prodavancee (12 s) |
| OK | npm run test:meetings (16 s) |
| OK | npm run test:history (12 s) |
| OK | npm run test:treasury (13 s) |
| OK | npm run test:rh (15 s) |
| OK | npm run test:administration (14 s) |
| OK | npm run test:libraryevol1 (15 s) |
| OK | npm run test:libraryevol2 (19 s) |
| OK | npm run test:commercial (18 s) |
| OK | npm run test:commercial2 (13 s) |
| OK | npm run test:commercial3 (13 s) |
| OK | npm run test:campay (20 s) |
| OK | npm run test:paymanual (12 s) |
| OK | npm run test:prospects (7 s) |
| OK | npm run test:wave4kind (9 s) |
| OK | npm run test:wave5 (10 s) |
| OK | npm run test:feedback (10 s) |
| OK | npm run test:tmsgeo (11 s) |
| OK | npm run test:parties (10 s) |
| OK | npm run test:orggeo (10 s) |
| OK | npm run test:waportee (27 s) |
| OK | npm run test:migrations (8 s) |
| OK | npm run test:legacy-brand (2 s) |

Journal brut : non versionné (4 143 s) ; chaque étape a réussi du premier coup (aucun « 2e essai »). Les étapes qui contenaient l'ancien nom dans leurs attentes ont été mises à jour par le script lui-même : références de paiement (`MABAH-NNNNNN`, anciennes `BRIJ-` toujours acceptées), format d'export (`mabah-export`), pied de page des PDF, sujets et signatures d'e-mails, `SMTP_FROM` de test, etc. La base de connaissances de l'IA a reçu une phrase de transition (« MABAH est le nouveau nom de Brij-IA ») après le début de cette exécution : `test:ai`, `test:aifollow` et `test:legacy-brand` ont été relancés ensuite : tous réussis.

## Test ajouté : `npm run test:legacy-brand` (serveur, 15 contrôles) et `npm run test:brand` (site, 29 contrôles)

Serveur : aucune occurrence de « Brij » hors liste blanche · script idempotent · migrations non touchées · `product.js` · invites de l'IA (nom MABAH IA, « ne prétends jamais être une personne ni un humain », dans les trois invites) · PDF (créateur et pied MABAH, image du logo présente) · e-mail HTML de la plateforme (logo, échappement, lien cliquable, ajouté seulement aux e-mails de la plateforme) · administration (titre, logo, favicon) · références de paiement `MABAH-`.

Site : aucune occurrence hors liste blanche · idempotence · **dictionnaires EN/DE/ES : mêmes clés, aucune clé ni valeur avec l'ancien nom, « Demandez à MABAH IA » traduit dans les 3 langues** · chaque `t('… MABAH …')` du code a sa traduction · titre, `og:site_name`, slogan · **code Search Console identique octet pour octet** · JSON-LD WebSite + SoftwareApplication avec l'alias « Brij-IA » · aucune adresse en dur dans `index.html` · manifeste (nom, icônes, `start_url`/`scope`/`id` inchangés) · version du cache du service worker ≥ 6 · profil du fondateur · fichiers de logo · **migration douce des clés de stockage** (cookies, guide, pages vues ; valeur existante non écrasée ; idempotente) · palette dans un seul bloc, plus de violet de marque en dur.

## Site : contrôles

| Contrôle | Résultat |
|---|---|
| `npx eslint src` | 0 erreur |
| `node scripts/i18n-check.mjs` | **EN 12 233/12 233 · DE 12 233/12 233 · ES 12 233/12 233 (100 %)** |
| `npm run test:brand` | 29 OK, 0 échec |
| `vite build` (production) | réussi (17 s, relancé le 24 novembre après le changement d'adresse) ; `index.html` sans adresse en dur, `og:image` = `%SITE_URL%/assets/og-mabah.png` |

## Vrai navigateur (Google Chrome, démonstration locale : serveur :3500, site :5599, base PostgreSQL jetable, compte `demo@exemple.com`)

- Titre de l'onglet « MABAH · Pilotez votre entreprise avec le meilleur outil » ; favicon `/favicon.svg` + PNG 32 px (200), `apple-touch-icon.png` (200), `og-mabah.png` (200) ; manifeste `MABAH` ; code Search Console présent ; JSON-LD `WebSite` et `SoftwareApplication` « MABAH / alias Brij-IA, BRIJ-IA » ; administration : titre « Administration MABAH », favicon et logo.
- Page de présentation, connexion, inscription, tableau de bord, module Stock : bureau 1440 px et mobile 375 px, **thème clair et thème sombre**, en violet (actuel) et en bleu du logo : `captures/violet-*.png`, `captures/logo-*.png`, comparaison `captures/comparaison-palettes-tableau-de-bord.png`.
- Logo à petite taille (16, 24, 32, 48, 96 px), clair et sombre, barre du navigateur : `captures/logo-petites-tailles.png` (la tuile claire arrondie reste lisible à 16 px ; en thème sombre elle sert de pastille).
- Quatre langues sur le tableau de bord (FR, EN, DE, ES) : aucun « Brij » dans le texte de l'accueil ni de l'application ; « Demandez à MABAH IA… / Ask MABAH IA… / Fragen Sie MABAH IA … / Pregunte a MABAH IA… » et « Point de situation de MABAH IA / MABAH IA status update / Lagebericht von MABAH IA / Resumen de situación de MABAH IA » ; captures `captures/langue-{en,de,es}-tableau-de-bord.png`.
- Aperçus : e-mail de la plateforme avec logo (`captures/email-plateforme-mabah.png`), PDF avec logo et « Entreprise · MABAH » en pied (`captures/pdf-pied-de-page-mabah.png`), connexion de l'administration clair/sombre.

## Rejeu sur les autres branches (lecture seule / copies)

| Branche | Résultat |
|---|---|
| `marque/serveur` et `marque/site` (copies) | script appliqué, `--check` OK, 2e passe « aucun changement » ; `i18n-check` sur le site rejoué : 12 293/12 293 en EN, DE, ES ; `apply-logo` ancre PDF de la marque reconnue |
| `espaces/*`, `reunions-avance/*` (simulation, rien d'écrit) | 118/174 et 120/177 fichiers à modifier ; **aucune ligne « À EXAMINER »** (la branche `reunions-avance` contient déjà des textes « MABAH » en français et une coquille « Brij-AI » dans ses dictionnaires anglais : traités) |

## Contrôle navigateur après le changement d'adresse (24 novembre 2026)

Démonstration locale (Chrome, données fictives « Boutique Awa »). Captures `captures/controle-adresse-*.png` : présentation, connexion, tableau de bord et module Stock, bureau 1280 px et mobile 375 px, clair et sombre (20 images). Aucun débordement horizontal. En-tête rendu : titre « MABAH · Pilotez votre entreprise avec le meilleur outil », `canonical`, `og:url` = `https://mabah.vercel.app/`, `og:image` = `https://mabah.vercel.app/assets/og-mabah.png`, code Search Console présent. Seules erreurs de console : 401/403 de la vérification de session avant connexion. Non testé en local : la redirection `vercel.json` de l'ancien hôte (elle ne s'exécute que sur Vercel).
