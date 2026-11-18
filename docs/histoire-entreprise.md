# Module « Histoire de l'entreprise »

Branche `histoire-entreprise` (serveur depuis `fusion-final-serveur` 47a83d0 ; site depuis `fusion-final-site` 3b9b93c). Rien n'est poussé.

## Ce que fait le module
- **Organigramme** (SVG) : fondateur → DG → directeurs → responsables → équipes. Déplier/replier, zoom, ajustement à la largeur, mode liste (téléphone), impression PDF (`window.print`, paysage) et export image PNG. **Curseur d'année** : présents (normaux), partants de l'année (bordure orange), anciens (grisés, option), pas encore arrivés (masqués). Fiches simples ou reliées aux employés RH (`employee_id`, import en un clic des employés non reliés).
- **Frise** : bande horizontale (forts en vert au-dessus, durs en rouge dessous, formes différentes pour le daltonisme) + années.
- **Moments forts / durs** séparés (deux colonnes ou un seul onglet). Chaque événement a une nature obligatoire `good|bad` ; durs → « ce qu'on en a retenu », forts → « ce qui a fait le succès ». Rencontres : compte rendu, invités externes, participants internes.
- **Statistiques** : par année, courbe de trajectoire cumulée, camembert, catégories, effectif (Recharts lazy).
- **Médias** : images (JPEG/PNG/WebP/GIF, 8 Mo) et vidéos (MP4/WebM/MOV, 20 Mo), type vérifié sur le contenu (`library-core.checkUpload`), chiffrés AES-GCM en base (comme la bibliothèque), quota 200 Mo/organisation (`HISTORY_QUOTA_MB`), lecture par `fetch` avec cookie + Range. Galerie par année, lecteur vidéo.
- **Vie privée** : visibilité `internal`/`direction` (événements et médias) ; un média où des personnes sont reconnaissables n'est vu des non-direction que si le consentement est coché ; photo de profil idem. « Direction » = rôle administrateur ou propriétaire (+ l'auteur voit ses propres éléments).
- **Droits de saisie** : lecture pour tout membre ; saisie = rôle minimum réglé par un admin/propriétaire (défaut : responsable) + personnes désignées. Le propriétaire peut toujours saisir.
- **Traçabilité** : `audit_log` (entités `history_*`, avant/après), écran « Journal » réservé à la direction ; exports CSV/PDF aussi tracés.
- **Livre d'or** : page de lecture par année, imprimable.

## Fichiers
Serveur : `src/workspace/history.js`, `src/migrations/histoire.js`, `scripts/test-history.js` (92 vérifications), `scripts/lib/demo-history.js` (données d'essai).
Modifiés (minimum) : `src/db.js` (+2 lignes : migrations à la fin), `src/workspace/index.js` (+1 route `/history`), `src/workspace/modules.js` (+1 module `history`, après `team`), `package.json` (script `test:history`, ajouté en fin de `test:chain`), `scripts/demo-local.js` (appel du jeu d'essai + `client.cookie()`).
Site : `src/ws/modules/history.jsx`, `src/ws/parts/history/*` (+ `history.css`, préfixe `hst-`), `src/i18n/{en,de,es}/ws-history.js` (210 textes). L'icône de la barre latérale est le nom `history` (déjà enregistré) : aucun fichier partagé du site modifié.

## API (`/api/ws/orgs/:id/history`)
`GET/PUT /settings` · `GET /people`, `GET /tree?year=&former=0`, `POST/PUT/DELETE /people[/:id]`, `GET /employees`, `POST /people/import-employees` · `GET/POST/PUT/DELETE /events[/:id]` (filtres `year, nature, category, q`) · `GET /stats` · `GET/POST /media`, `GET /media/:id/file`, `PUT/DELETE /media/:id` · `GET /journal` · `GET /export.csv?what=events|people`, `GET /export.pdf`. Le site calcule l'année côté client (même règle que `/tree`).

## Tests lancés
`node scripts/test-history.js` : 92 réussis, 0 échec. `eslint src` propre, `scripts/i18n-check.mjs` 100 % (en/de/es), `vite build` OK. Test de fumée navigateur sur `demo-local.js` (port libre, arrêté par port) : livre d'or (13 pages), organigramme (11 nœuds, anciens grisés), frise, moments forts/durs OK ; statistiques/galerie/journal non revus à l'œil (panneau navigateur masqué, session expirée) — couverts par le test serveur et le build.

## Limites connues
- Les messages d'erreur du serveur sont en français (comme les autres modules ; non ajoutés au dictionnaire).
- Les vidéos sont lues en entier avant lecture (blob), pas de streaming.
- Pas d'élément « futur » (dates au plus l'an prochain).

## Fusion (à faire par le fondateur, rien n'est poussé)
```bash
cd ~/Downloads/manager-ia-backend && git checkout fusion-final-serveur && git merge histoire-entreprise
cd ~/Downloads/MANAGER-IA/site && git checkout fusion-final-site && git merge histoire-entreprise
```
Conflits probables : fin de `src/db.js`, `src/workspace/index.js`, `modules.js`, `package.json` (lignes ajoutées en fin de liste) — garder les deux côtés.
