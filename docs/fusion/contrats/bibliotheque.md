# Contrat d'API — Bibliothèque (fusion) : AJOUTS uniquement, aucune forme de A changée

Routes inchangées (mêmes URL, mêmes statuts de succès). Ajouts de champs ou de paramètres :

- `GET /overview` (et `GET /blocks/:id`) : chaque bloc porte `slug` (identifiant court stable : `personnel`, `administratif`, `commercial`, `projets`, `rh`, `comptabilite`, `juridique` pour les blocs de départ ; généré depuis le nom pour les blocs créés).
- Listes de documents (`docs[]` : bloc, favoris, récents, recherche) : `linkType`, `linkId`, `folderId`.
- `POST /blocks/:id/docs?name=&folderId=` accepte en plus `tags=a,b`, `linkType=project|contract` et `linkId` (400 si le projet/contrat n'est pas de l'organisation).
- `PUT /docs/:id` accepte `folderId` (déplacement dans le même bloc ; `null` = racine).
- `GET /search` : paramètres `linkType` + `linkId` (la recherche peut se faire sans `q` ni `tag`).
- `PUT /settings` : la réponse contient aussi `settings`.
- `GET /audit` : chaque entrée porte `userId` ; nouvelle action `view_doc` ; le paramètre `action` accepte aussi les noms de B (`unlock_ok`, `add`, `delete`, `restore_version`, `folder_add`, `folder_edit`, `block_add`, `block_edit`, `trash_auto`). Dans un dossier personnel, `detail` est toujours vide (aucun nom de document).
- `POST /blocks/:id/unlock` : la réponse contient aussi `hardExpiresAt`.

Changements de comportement (messages et codes) :
- 5e mot de passe raté : `429` immédiat (avant : `403` puis `429` au suivant). Blocage 15 min, persistant, valable pour tous les blocs de la personne.
- `PUT /blocks/:id/perms` : `400` si une exception vise une personne qui n'est pas membre ; `403` si un administrateur MODIFIE les droits du rôle administrateur (valeur inchangée : ignorée).
- Document d'un bloc invisible pour la personne : `404 « Document introuvable. »` (avant : « Bloc introuvable. »).
- `POST /docs/:id/versions` : `400` si le contenu n'a pas le même type que le document.
- Un nom de fichier envoyé avec un chemin est réduit à son dernier segment.
- Texte sans extension (`note`) : accepté, devient `note.txt`.
- La consultation de `GET /trash` supprime aussi les documents à la corbeille depuis plus de 30 jours.

Base : nouvelle table `lib_attempts`; colonnes ajoutées `lib_blocks.slug`, `lib_grants.last_used_at`, `lib_grants.pass_stamp`, `lib_role_perms.org_id`, `lib_user_perms.org_id` (migrations rejouables dans `src/migrations/fusion-bibliotheque.js`).
