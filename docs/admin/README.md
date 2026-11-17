# Administration Brij-IA : refonte de l'interface et inscriptions en direct

Captures `avant-*` (ancienne interface) et `apres-*` (nouvelle) à 390, 768 et 1280 px, en clair et en sombre.

## Fichiers (dossier `admin/`)
- `admin.css` : jetons (couleurs clair/sombre, échelle typographique, espacements, rayons) + composants (boutons, champs, badges, cartes, tableaux, onglets, dialogues, palette, tiroir).
- `theme.js` : applique le thème avant l'affichage (la CSP interdit les scripts en ligne). `fonts/` : Inter (licence SIL OFL), servie par le serveur.
- `ui.js` (éléments, icônes, formats, tableau trié/paginé qui devient cartes sur téléphone, dialogues), `charts.js` (barres, courbe, anneau, mini-courbes en SVG avec axes, infobulles et tableau lisible par les lecteurs d'écran), `live.js` (direct), `views-a.js` / `views-b.js` (écrans), `admin.js` (menu, fil d'Ariane, routage par `#/…`, recherche Ctrl K, connexion).

## Direct
- `GET /api/admin/live/stream` (SSE, session administrateur) : `hello`, `account`, `pending`, `summary`, `ping` toutes les 20 s.
- `GET /api/admin/live/accounts` : instantané, utilisé en repli (toutes les 12 s) si le flux est coupé ou muet depuis 45 s ; le flux est retenté toutes les 30 s.
- `GET /api/admin/search?q=` : utilisateurs, organisations, paiements.
- Le serveur observe la base toutes les 2 s tant qu'une page est connectée (aucune modification de `routes/auth.js`).
- Jamais de mot de passe, de hachage ni de code ; adresses des inscriptions en attente masquées.

## Prix
`/api/admin/overview` et `/api/admin/settings` renvoient `catalog` (issu de `src/config.js`). Aucun prix n'est écrit dans l'interface.
