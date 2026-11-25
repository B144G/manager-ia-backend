# Compte d'entreprise (étape 1 sur 6)

MABAH passe d'un modèle « un compte = une personne » à un modèle où **l'entreprise est le titulaire du compte**, et où chaque employé garde **sa propre identité** à l'intérieur (traçabilité, révocation, droits par personne). Ce document décrit la cible complète, ce qui est livré à l'étape 1, ce qui reste, les limites, la mise en ligne et le retour arrière.

## 1. Architecture cible (étapes 1 à 6)

```
Entreprise (titulaire : abonnement, configuration, limites)
 └─ Direction générale (un ou plusieurs DG ; commune à toutes les organisations de l'entreprise)
     └─ Directions du pilotage (DAF, technique, commerciale, production, logistique, IT et maintenance, stockage et achats, sécurité, DRH, marketing…)
         └─ Départements (Finance, Pilotage, RH, Commercial, Marketing, Production, Achats, Logistique + personnalisés)
             └─ Postes (DAF, comptable, trésorier, contrôleur de gestion, caissier ; métreur et conducteur de travaux en BTP ; dispatcheur, chef de parc, chauffeur en transport…)
 └─ Organisations liées (filiales, sites) — étape 4
 └─ Partenaires — étape 5
```

Règle de fond : **les affectations de personnes se font PAR organisation**. Le comptable de l'organisation B n'est pas celui de A ni celui de l'entreprise principale ; seule la direction générale peut être commune.

| Étape | Contenu | État |
|---|---|---|
| 1 | Entreprise au-dessus des organisations, structure, postes, affectations, assistant, modèles par secteur, lien avec les espaces par rôle, écran « Entreprise et organigramme » | **livrée** |
| 2 | Connexion employé par code d'entreprise + e-mail + secret personnel, appareils de confiance, redirection automatique vers son espace | à faire |
| 3 | Moteur de profils de rôle : interface propre à chaque métier, jusqu'au chauffeur | à faire |
| 4 | Organisations liées par lien d'association, avec copie de la structure | à faire |
| 5 | Module Partenaires | à faire |
| 6 | Limites par abonnement (personnes, organisations, départements…) au niveau de l'entreprise | à faire |

## 2. Modèle de données

Migrations **400 à 404** (fichier `src/migrations/compte-entreprise.js`), additives et rejouables ; 310 à 399 sont réservées (migrations vides). Réservation de numéros pour la suite : 410–419 étape 2, 420–429 étape 3, 430–439 étape 4, 440–449 étape 5, 450–459 étape 6.

| N° | Table | Rôle |
|---|---|---|
| 400 | `entreprises` ; colonne `orgs.entreprise_id` | titulaire : raison sociale, secteur, pays, devise, adresse, ville, taille, contacts, identifiants légaux **facultatifs** (`rccm`, `niu`, `vat_number`, `legal_form`). Colonnes déjà prévues pour la suite : `company_code` (étape 2), `plan_json` et `limits_json` (étape 6). `legacy_org_id` : organisation d'origine (rattachement). |
| 401 | `ent_people`, `ent_dg` | **personne** = identité individuelle dans l'entreprise (nom, e-mail et téléphone facultatifs, `user_id` quand elle a un compte, statut, code d'invitation personnel) ; direction générale (une ou plusieurs personnes, au niveau de l'entreprise). |
| 402 | `ent_directions`, `ent_departments`, `ent_posts` | structure **d'une organisation** (`org_id`). Un poste porte son type (directeur, responsable, équipe), son nombre de places, ses accès (`spaces`, JSON espace → visiteur / membre / responsable) et `tkey` (clé du modèle, pour ne jamais dupliquer). |
| 403 | `ent_assignments`, `ent_setup` | affectation personne ↔ poste **par organisation** ; avancement de l'assistant, secteur appliqué, réglage « lien avec les droits ». |
| 404 | (données) | rattachement des organisations existantes : une entreprise par organisation, chaque membre reçoit une fiche, **le propriétaire devient directeur général**. Idempotente. |

Étapes futures déjà compatibles : la personne (`ent_people`) est liée à l'entreprise et non à une organisation, ce qui permet la connexion par code d'entreprise (étape 2) ; la structure est copiable d'une organisation à l'autre (`tkey`, étape 4) ; les limites iront dans `entreprises.limits_json` (étape 6).

## 3. Ce qui est livré à l'étape 1

**Rattachement sans perte.** La migration 404 crée l'entreprise de chaque organisation existante et relie les membres ; une organisation créée par un autre chemin est rattachée à sa première visite (création paresseuse) ; `POST /orgs` crée désormais l'entreprise avec le créateur comme DG. Les comptes, la connexion, les rôles (membre, responsable, administrateur, propriétaire), les antennes et les accès actuels ne changent pas : la structure est vide au départ et **ne donne aucun droit à quelqu'un qui n'est affecté à rien**. Le nom de l'organisation (affiché partout) n'est jamais renommé par la raison sociale.

**Assistant « Configurer mon entreprise »** (site, cinq étapes sautables et reprenables, enregistrées à chaque action) : informations de l'entreprise (identifiants légaux facultatifs, jamais inventés), direction générale, directions du pilotage, départements et postes (avec choix du directeur / responsable), employés (création de la personne et **code d'invitation personnel**, via la table `invites` existante). Il s'ouvre après la création d'une entreprise et reste accessible à toute entreprise existante (écran « Entreprise et organigramme », page Équipe).

**Modèles par secteur** : commerce, BTP et construction, transport et logistique, services (+ « autre activité »). Le secteur précharge les départements et postes adaptés (le métreur et le conducteur de travaux n'existent qu'en BTP ; le chauffeur, le dispatcheur et le chef de parc qu'en transport ; le livreur en commerce ; chef de projet et consultant en services). Les huit départements de base existent pour tous (désactivés d'emblée s'ils ne concernent pas le secteur). Tout est modifiable : renommer, ajouter, désactiver. Réappliquer un modèle n'ajoute que ce qui manque.

**Lien avec les droits** (`src/workspace/ent-lib.js`, `structureLevels`, branché dans `levelsFor` du système d'espaces par rôle) :
- affecter une personne à un poste lui donne les espaces et niveaux de ce poste : *membre* pour un poste d'équipe, *responsable de l'espace* pour un directeur / responsable (et pour comptable et trésorier, comme le modèle de fonction existant, car la comptabilité exige un rang administrateur) ;
- les directeurs généraux ont la Direction en responsable et consultent les autres espaces (jamais l'espace Compte) ;
- plusieurs postes : niveau le plus haut par espace ; poste ou département désactivé : aucun droit ;
- l'affectation explicite du propriétaire (écran Espaces par rôle, même « aucun accès ») l'emporte sur la structure ;
- propriétaire et administrateurs voient toujours tout ; personne ne peut donner « responsable de l'espace Compte » sans être propriétaire ;
- une personne affectée à rien garde son **repli sûr** actuel, à l'identique (test de non-régression).

**Écran « Entreprise et organigramme »** (espace Compte) : organigramme (DG → directions → départements → postes avec personnes et places vacantes), personnes, informations, journal ; clair et sombre, mobile 375 px.

**Sécurité** : lecture pour tout membre (sans coordonnées ni identifiants légaux pour un simple membre), écriture réservée aux administrateurs, direction générale et lien avec les droits réservés au propriétaire ; tout est filtré par organisation et par entreprise (un identifiant d'ailleurs répond « introuvable ») ; journal d'audit (`audit_log`, entités `ent_*`, jamais le code d'invitation) ; limitation de débit des écritures (400 par 10 minutes, `ENTREPRISE_WRITE_RATE`) ; un code d'invitation est à usage unique, secret réservé aux administrateurs.

### Routes (`/api/ws/orgs/:orgId/entreprise/…`)
`GET /` vue d'ensemble · `GET /templates` · `POST /template` · `PUT /info` · `GET /chart` · `PUT /dg` (propriétaire) · `POST|PUT|DELETE /directions|/departments|/posts` · `GET|POST /people`, `PUT|DELETE /people/:id`, `POST /people/:id/invite` · `POST /assignments`, `DELETE /assignments/:id` · `PUT /setup` · `PUT /settings` (propriétaire) · `GET /log`.

## 4. Comparaison avec le modèle actuel

| | Avant | Étape 1 |
|---|---|---|
| Titulaire | la personne (propriétaire de l'organisation) | l'entreprise (avec sa direction générale) |
| Structure | postes libres (module « Organisation »), rôles propres à quelques modules | directions → départements → postes, modèles par secteur, postes vacants |
| Droits | rôle d'organisation + espaces affectés à la main, personne par personne | idem, **plus** : le poste affecté donne ses espaces automatiquement |
| Employé | compte qui rejoint par code générique d'équipe | personne avec code personnel à usage unique, fiche d'entreprise, poste |
| Connexion | e-mail / téléphone + mot de passe | inchangée (étape 2 : code d'entreprise) |

Le module « Organisation » (postes libres) existant reste en place, sans changement.

## 5. Limites honnêtes (étape 1)

- Une entreprise = une organisation pour l'instant : relier plusieurs organisations (filiales) et copier la structure est l'étape 4. Le modèle est prêt, pas l'interface.
- La connexion reste celle d'aujourd'hui : l'employé crée son compte puis saisit son code personnel. Pas encore de code d'entreprise, d'appareils de confiance ni de redirection automatique (étape 2).
- Les profils de rôle (interface propre au chauffeur, au magasinier…) n'existent pas : le poste donne des espaces, pas encore un écran sur mesure (étape 3).
- Pas de limites par abonnement au niveau de l'entreprise (étape 6) ; seules les limites existantes de l'offre de la personne s'appliquent, y compris au nombre de personnes à l'arrivée.
- Retirer une personne de l'équipe se fait toujours depuis « Équipe et antennes » (cela supprime ses affectations) ; on ne retire d'ici que les invitations en attente.
- Le menu « Entreprise et organigramme » est dans l'espace Compte : une personne qui n'y a pas accès ne voit pas l'organigramme dans son menu (la route reste lisible).
- Les textes des modèles sont fournis en français, anglais, allemand et espagnol ; un nom de département ou de poste saisi par l'entreprise n'est évidemment pas traduit.
- Accès « comptable » et « trésorier » : poste de niveau responsable de l'espace Finances (la comptabilité exige le rang administrateur) ; à ajuster poste par poste si besoin.

## 6. Mise en ligne

1. Pousser la branche (voir le rapport) : **les migrations 400 à 404 s'appliquent toutes seules au démarrage** du serveur sur Render (rien à lancer à la main). Elles sont additives : aucune table existante n'est modifiée sauf l'ajout de la colonne `orgs.entreprise_id`.
2. Vérifier au démarrage : l'application répond ; `GET /api/ws/orgs/<id>/entreprise` renvoie l'entreprise de l'organisation (créée par la migration ou à la première visite).
3. Pousser le site (Vercel) : l'écran apparaît dans l'espace Compte.
4. Aucune variable d'environnement obligatoire. Facultatives : `ENTREPRISE_RIGHTS=off` (interrupteur général, voir plus bas) et `ENTREPRISE_WRITE_RATE` (écritures par 10 minutes, 400 par défaut).

## 7. Retour arrière

- **Par entreprise** : le propriétaire coupe « Affectations et droits » (onglet Entreprise) ou `PUT /entreprise/settings {rightsLink:false}` : la structure reste, les accès redeviennent ceux d'avant. Rétablir remet tout sans ressaisie.
- **Pour toutes les entreprises** : variable d'environnement **`ENTREPRISE_RIGHTS=off`** sur Render (retirer la variable pour revenir) ; aucune structure ni affectation n'est perdue.
- **Données** : aucune donnée existante n'est modifiée ; supprimer les tables `ent_*` et `entreprises` ne perdrait que la structure (les comptes, organisations et droits actuels n'en dépendent pas). Les migrations ne sont jamais défaites.

## 8. Tests et démonstration

`npm run test:entreprise` (126 vérifications : migrations et rattachement rejoué, aucun changement pour les comptes actuels, droits de chaque route, assistant, modèles par secteur, invitation et arrivée, droits donnés par un poste, retour arrière, isolation entre entreprises et organisations, DG, journal, suppression, limitation de débit) ; inclus dans `npm test`. Démonstration : `scripts/demo/entreprise-seed.js` puis `scripts/demo/entreprise-captures.js` ; captures dans `docs/captures-entreprise/`.
