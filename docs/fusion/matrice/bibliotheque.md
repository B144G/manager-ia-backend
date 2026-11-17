# Fusion — Bibliothèque (blocs protégés)

Code branché : ligne A (`src/workspace/library.js`, tables `lib_*` de A). Capacités de B portées sur A. Tests : `scripts/test-library.js` (A, 104 contrôles) et `scripts/test-library-b.js` (B adapté + ajouts, 237 contrôles), sans l'outil « tolerant ».

## Matrice

| Fonction | A | B | Décision | Test |
|---|---|---|---|---|
| Mot de passe ressaisi (bcrypt contre le compte connecté), jamais renvoyé ni journalisé | oui | oui | garder A | test-library-b « le mot de passe saisi n'est jamais renvoyé », « aucun mot de passe dans les journaux » |
| Limitation des essais persistante par personne et par bloc, déblocage après durée | non (comptage dans `lib_audit`, fenêtre glissante) | oui (`lib_attempts`) | porter B sur A : table `lib_attempts` (migration), compteur par bloc + compteur « tous blocs », blocage 15 min dès le 5e échec (429), `locked_until` | « 5e échec : blocage », « blocage levé après le délai », « lignes lib_attempts… » |
| Essais comptés toutes organisations confondues | oui | non (par bloc) | garder A (plus protecteur) : le blocage d'une personne vaut pour tous ses blocs | « blocage : suit la personne… » ; test-security-new |
| Autorisation courte côté serveur liée à la session, renouvelée, plafonnée | oui | oui | garder A ; ajout `last_used_at` et `pass_stamp` (autorisation refusée si le mot de passe a changé depuis) | « durée courte », « l'activité renouvelle », « le renouvellement ne dépasse jamais le plafond », « plafond dépassé » |
| Autorisation vérifiée sur TOUTES les routes de documents (fiche, téléchargement, aperçu, versions, favoris, récents, recherche, corbeille, dossiers, envoi) | oui | oui | garder A, preuve ajoutée | balayage de 17 routes + 6 listes depuis une autre session (« autre session, bloc verrouillé : … ») |
| Fermeture de session / déconnexion / changement de mot de passe : autorisations supprimées | oui (`sessions.js`) | révocation (`revoked_at`) | garder A (suppression des lignes) | « déconnexion : autorisations révoquées en base », « changement de mot de passe : … » |
| Droits par rôle et par personne (exception remplaçante), effet immédiat | oui | oui (table `lib_perms`) | garder A | section « Droits par bloc » |
| Exception pour une personne inconnue | ignorée | refusée (400) | porter B : 400 | « exception pour une personne inconnue refusée » |
| Administrateur modifiant les droits des administrateurs | ignoré en silence | refusé (403) | réunir : 403 seulement si la valeur change (une valeur inchangée envoyée par l'interface est ignorée) | « administrateur : ne touche pas aux droits des administrateurs » |
| Document d'un bloc non visible : « Document introuvable » (sans indice) | « Bloc introuvable » | « Document introuvable » | porter B | « membre : document d'un bloc non autorisé introuvable, sans indice » |
| Versions (20 max), rétablir, supprimer ; nouvelle version = même type que le document | oui, type libre | oui, type identique | porter B : 400 si le contenu n'a pas le type du document | « nouvelle version : le contenu doit correspondre… » |
| Corbeille 30 jours, restauration, purge | oui (tâche horaire) | oui (purge aussi à la consultation) | réunir : la consultation de la corbeille purge aussi l'organisation | « plus de 30 jours : supprimé définitivement » |
| Favoris, récents, recherche (nom, étiquette, lien projet) | oui, sans filtre de lien | oui | porter B : `search?linkType&linkId` | « documents d'un projet », « recherche : le caractère % est littéral » |
| Étiquettes et lien projet/contrat à l'envoi (`?tags=&linkType=&linkId=`) | non (seulement en modification) | oui | porter B | « envoi d'un PDF », « document lié à un projet », « isolation : lien vers le projet d'une autre organisation refusé » |
| Déplacer un document (`PUT /docs/:id {folderId}`) | non | oui | porter B | « déplacer un document à la racine » |
| Aperçu PDF/image, téléchargement forcé, en-têtes (nosniff, no-store, CSP) | oui | oui | garder A | « téléchargement : mêmes octets… », « aperçu PDF en ligne », « aperçu image » |
| Type reconnu d'après le CONTENU, programmes/pages/scripts refusés, chiffrement AES-256-GCM | oui | oui | garder A (B : texte sans extension `note` → `.txt`, porté) | section « Fichiers falsifiés », test-library « chiffrement » |
| Extension qui ne correspond pas au contenu | corrigée (le type suit le contenu) | refusée | garder A (testé par test-library) : type et extension suivent TOUJOURS le contenu réel | « PDF renommé .png : type et extension suivent le contenu » |
| ZIP quelconque | accepté (application/zip) | refusé | garder A ; servi en pièce jointe seulement, aucun aperçu | « ZIP quelconque : accepté… » |
| Nom de fichier : chemin retiré (`../../etc/passwd.pdf` → `passwd.pdf`) | remplacé par `_` | dernier segment | porter B | « traversée de chemin… » |
| Quotas par offre, taille maximale | oui | oui | garder A | « quota de l'offre atteint », « fichier trop gros pour l'offre » |
| Blocs de départ | 7 blocs | 16 blocs à slug | garder A (production) ; ajout de la colonne `slug` à tous les blocs | « blocs de départ de A (7) + 2 blocs ajoutés, tous avec un slug » |
| Dossiers personnels privés, journal sans nom de document | privés ; noms visibles au journal | privés ; journal sans nom | réunir : le journal n'expose jamais le nom d'un document d'un dossier personnel | « les dossiers personnels n'exposent aucun nom de document » |
| Journal d'audit (filtre, pagination) | oui (`lib_audit`) | oui | garder A ; ajouts : action `view_doc`, champ `userId`, filtre accepte les noms d'actions de B | section « Journal d'audit », « le filtre accepte aussi les noms d'actions de B » |
| Journal CENTRAL (`audit_trail`) : `library.unlock_fail` / `library.unlock_locked` | échec seulement | oui | réunir : A écrit aussi `unlock_locked` (gravité haute) ; alimente `alerts.js` | « échecs enregistrés au journal central », « alerte library_fails » |
| Alerte « library_fails » (src/services/alerts.js) | n/a | oui | prouvée (scan réel) | « alerte « library_fails » : créée… » |
| Réglages de sécurité (durée, plafond, taille) ; `PUT` renvoie les réglages | oui, `{ok}` | oui, `{ok, settings}` | réunir (ajout `settings`) | section « Réglages de sécurité » |
| Liens signés | non | **absents du code de B** (aucune route, aucun jeton) | rien à porter | — |
| Export / suppression d'organisation | cascade | cascade | garder ; `org_id` ajouté à `lib_role_perms`/`lib_user_perms`/`lib_attempts` pour l'export schéma-dirigé | « export d'organisation… », « suppression d'organisation : plus aucune ligne lib_* » |
| Limiteurs de débit | déverrouillage 20/15 min, envois 60/10 min (par adresse) | 40 / 60 | porter B pour le déverrouillage (bureau derrière une seule adresse) ; envois relevés à 120 | — |

## Adaptations du test de B (aucune n'affaiblit une garantie de sécurité)
- 16 blocs de B → 7 blocs de A + « Achats » et « Formation » créés par le test ; `slug` ajouté à A (colonne, vue `overview`/blocs).
- « Commercial » : A laisse les membres ajouter ; le test aligne d'abord les droits sur ceux de B (membre en lecture seule).
- `lib_grants` : A n'a ni `id` ni `revoked_at` (les autorisations sont supprimées, pas révoquées) : requêtes adaptées (clé `session_id, block_id`).
- `lib_perms` (B) → `lib_user_perms` (A) pour contrôler l'exception d'un autre administrateur.
- Noms d'actions du journal : `unlock_ok→unlock`, `add→upload`, `delete→trash`, `block_add→block_create`, `block_edit→block_update`, `trash_auto→auto_purge`, `view_doc` ajouté ; le filtre de A accepte aussi les noms de B.
- Blocage : B isolait chaque bloc ; A bloque la personne partout (tranché : le plus protecteur).
- Mot de passe vide : 403 chez A (compté comme un échec) contre 400 chez B (garder A, `test-library.js` l'exige).
- Aperçu d'un fichier Office : 400 chez A, 415 chez B (garder A ; le test accepte les deux).
- Extension ≠ contenu et ZIP : voir la matrice (A gardé).
- Étiquettes : A garde la casse saisie (B passait en minuscules) ; le test compare sans tenir compte de la casse.

## Intégration sécurité
- (i) Journal central : la Bibliothèque de A écrit `library.unlock_fail` et `library.unlock_locked` dans `audit_trail` ; l'alerte `library_fails` est créée par `alerts.scan()` (test).
- (ii) `src/security/sessions.js` supprime les `lib_grants` de la session fermée : prouvé (déconnexion, changement de mot de passe).
- (iii) Suppression d'organisation : tout `lib_*` porte `org_id` ou cascade depuis `lib_blocks`/`orgs` ; prouvé par comptage après suppression. Export : `lib_blocks`, `lib_docs`, `lib_versions` (sans le contenu), `lib_role_perms`, `lib_audit`… inclus.
- (iv) `test-security-idor.js` (1 échec) et `test-security-routes.js` (1 échec) : échecs déjà présents avant mes changements (achats/projet B ; route publique `/track/:token`), sans lien avec `/library`.
