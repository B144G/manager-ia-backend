# Compte d'entreprise (étapes 1 à 6)

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
| 2 | Connexion employé par code d'entreprise + e-mail + secret personnel (mot de passe ou PIN), appareils de confiance 30 à 90 jours avec retour automatique, double authentification des postes sensibles | **livrée** |
| 3 | Moteur de profils de rôle : interface propre à chaque poste, jusqu'au chauffeur (22 profils de base) | **livrée** |
| 4 | Organisations liées par lien d'association (code à usage unique, copie de la structure, DG commun) | **livrée** |
| 5 | Module Partenaires + espaces partagés (chat, réunions, bibliothèque) entre organisations liées et avec des partenaires | **livrée** |
| 6 | Limites par abonnement appliquées partout, écran d'usage, quota IA partagé | **livrée** |

## 2. Modèle de données

Migrations **400 à 404** (fichier `src/migrations/compte-entreprise.js`), additives et rejouables ; 310 à 399 sont réservées (migrations vides). Réservation de numéros pour la suite : 410–419 étape 2, 420–429 étape 3, 430–439 étape 4 (liens d'association, début des espaces partagés), 440–449 étape 5 (partenaires, suite des espaces partagés), 450–459 étape 6.

| N° | Table | Rôle |
|---|---|---|
| 400 | `entreprises` ; colonne `orgs.entreprise_id` | titulaire : raison sociale, secteur, pays, devise, adresse, ville, taille, contacts, identifiants légaux **facultatifs** (`rccm`, `niu`, `vat_number`, `legal_form`). Colonnes déjà prévues pour la suite : `company_code` (étape 2), `plan_json` et `limits_json` (étape 6). `legacy_org_id` : organisation d'origine (rattachement). |
| 401 | `ent_people`, `ent_dg` | **personne** = identité individuelle dans l'entreprise (nom, e-mail et téléphone facultatifs, `user_id` quand elle a un compte, statut, code d'invitation personnel) ; direction générale (une ou plusieurs personnes, au niveau de l'entreprise). |
| 402 | `ent_directions`, `ent_departments`, `ent_posts` | structure **d'une organisation** (`org_id`). Un poste porte son type (directeur, responsable, équipe), son nombre de places, ses accès (`spaces`, JSON espace → visiteur / membre / responsable) et `tkey` (clé du modèle, pour ne jamais dupliquer). |
| 403 | `ent_assignments`, `ent_setup` | affectation personne ↔ poste **par organisation** ; avancement de l'assistant, secteur appliqué, réglage « lien avec les droits ». |
| 404 | (données) | rattachement des organisations existantes : une entreprise par organisation, chaque membre reçoit une fiche, **le propriétaire devient directeur général**. Idempotente. |

Tables ajoutées aux étapes suivantes (migrations additives, `src/migrations/compte-entreprise-2.js` à `-5.js`) :

| N° | Tables | Rôle |
|---|---|---|
| 410 | `ent_credentials` | secret personnel de la personne (empreinte bcrypt du mot de passe ou du PIN, méthode, dernière connexion) |
| 411 | `ent_devices` | appareils de confiance : jeton long (seule l'empreinte est stockée), libellé, session ouverte, expiration (30 à 90 jours), révocation |
| 412 | `entreprises.sensitive_2fa` | double authentification exigée pour les profils sensibles (activée par défaut) |
| 420 / 421 | `ent_profiles`, `ent_posts.profile_key` | profils de rôle modifiés par organisation ; profil choisi pour un poste |
| 430 à 432 | `ent_links`, `orgs.linked_via`, `ent_link_log` | liens d'association (empreinte, expiration, révocation, copie de structure), origine d'une organisation liée, journal des rattachements |
| 440 | `ent_partnerships` | partenariat entre deux organisations d'entreprises différentes (invitation, confirmation des deux côtés, type vu de chaque côté, durée, révocation) |
| 441 | `shared_spaces`, `shared_space_orgs`, `shared_space_members` | **espace partagé** : une organisation propriétaire, les organisations participantes, les personnes membres avec droits lecture / écriture / validation |
| 442 | `shared_space_objects`, `shared_messages`, `shared_files`, `shared_validations` | objets partagés explicitement (copies), discussion, fichiers déposés, validations |
| 443 | `shared_audit` | journal d'audit des partenariats et des espaces (visible des deux côtés, jamais de contenu) |

Réserves : 405 à 409, 413 à 419, 422 à 429, 433 à 439 et 310 à 399 sont des migrations vides réservées.

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

## 3 bis. Espaces partagés (chat, réunions, bibliothèque) : conception, réalisée à l'étape 5

Exigence du fondateur : chaque entreprise a sa page de chat ; il y a des chats, des **réunions** et une **bibliothèque** entre organisations liées d'une même entreprise (étape 4) et entre entreprises partenaires (étape 5). Conçu à l'étape 1, réalisé à l'étape 5 (voir 4 bis ; tables réelles : `shared_spaces`, `shared_space_orgs`, `shared_space_members`, `shared_space_objects`, `shared_messages`, `shared_files`, `shared_validations`, `shared_audit`, migrations 440 à 443). L'isolation actuelle (tout est filtré par `org_id`) n'est pas modifiée. La conception d'origine ci-dessous a servi de base ; la réalisation en diffère sur un point : le chat partagé a ses propres messages (`shared_messages`) au lieu de réutiliser `ci_*`, ce qui évite de toucher au chat interne.

**Concept unique : l'« espace partagé »** (`shared_spaces`), réutilisé par les trois modules.

| Table (prévue) | Contenu |
|---|---|
| `shared_spaces` | `id`, `kind` (`chat`, `meeting`, `library`), `owner_org_id` (entité propriétaire), `link_id` (lien d'association, étape 4, ou partenariat, étape 5), `title`, `status` (actif / archivé en lecture seule), `expires_at`, `created_by`, `revoked_at` |
| `shared_space_parties` | une ligne par entité destinataire : organisation liée (`org_id`) ou partenaire (`entreprise_id`), avec `rights` par défaut (lecture / écriture / validation) |
| `shared_space_members` | **appartenance explicite par personne** (`user_id`, `org_id` d'origine, `rights` lecture / écriture / validation, `added_by`, `removed_at`) : personne n'entre dans un espace partagé par son seul rôle |
| `shared_space_objects` | objets partagés explicitement : `object_type` (`chat_conversation`, `meeting`, `agenda`, `minutes`, `library_folder`, `library_document`), `object_id`, `org_id` propriétaire, `rights`, `expires_at` |
| `shared_space_audit` | qui a consulté, déposé, modifié, retiré, révoqué ; jamais le contenu |

Règles de sécurité (communes) : l'espace ne donne accès **qu'aux objets listés** dans `shared_space_objects` et **qu'aux personnes listées** ; aucun accès aux discussions, réunions ou documents internes de l'autre côté ; chaque lecture passe par un contrôle serveur « personne ∈ membres ET objet ∈ objets ET non expiré ET non révoqué » ; **révoquer** un lien ou un partenariat archive tous ses espaces en lecture seule (le contenu déjà échangé reste chez chacun, rien n'est effacé) ; fichiers partagés limités aux types d'objets autorisés par le lien ; journal d'audit systématique.

Cas d'usage : (1) chat interne par organisation (existe) ; (2) canaux entre organisations liées : direction générale commune, départements homologues (DAF principal ↔ comptable de la filiale B) ; (3) canal partenaire créé à la connexion d'un partenaire, membres désignés des DEUX côtés ; (4) réunions inter-organisations ou avec partenaires : invités des deux côtés, ordre du jour et procès-verbal partagés seulement aux invités, les décisions et tâches restant chez chacun selon ce qui est partagé ; (5) bibliothèque partagée : dossiers ou documents partagés (lecture seule, ou lecture + dépôt), avec expiration et révocation.

**Comment les modules actuels s'y branchent (sans changer leur isolation)**
- **Chat** (`ci_*`, migrations 300+) : toutes les tables portent `org_id` et les membres sont des `ci_members` (utilisateurs de l'organisation). Extension simple : une conversation partagée est une ligne de `ci_conversations` de l'organisation propriétaire, exposée à l'autre côté **uniquement** via `shared_space_objects` ; l'autre côté n'écrit pas dans les tables de la première, il passe par des routes dédiées `/shared/...` qui vérifient l'appartenance. Ce qu'il faudrait changer : (a) `ci_members` suppose des membres de l'organisation propriétaire (chargement d'organisation par `loadOrg`) : les participants externes seraient portés par `shared_space_members` et non ajoutés à `org_members` ; (b) les messages gardent un `org_id` unique : la liste des conversations d'une personne doit fusionner ses conversations internes et ses espaces partagés ; (c) fichiers (`ci_files`) et appels : n'autoriser que les types prévus par le lien. Aucune migration existante n'est modifiée ; seules des tables de liaison et de nouvelles routes sont nécessaires.
- **Réunions** (`mtg_*`) : une réunion partagée est une `mtg_meetings` de l'organisation organisatrice ; ordre du jour et PV sont publiés vers l'autre côté comme objets (`agenda`, `minutes`), en copie de lecture au moment du partage ; décisions et tâches restent créées chez chacun. Invités externes via `shared_space_members`.
- **Bibliothèque** (`lib_*`, avec droits par rôle, par personne et délégations) : un dossier ou document partagé devient un objet de l'espace (lecture, ou lecture + dépôt, expiration, révocation) ; les droits existants de la bibliothèque ne sont pas touchés et le reste de la bibliothèque n'est jamais visible de l'extérieur ; les accès sont journalisés.

## 4. Comparaison avec le modèle actuel

| | Avant | Étape 1 |
|---|---|---|
| Titulaire | la personne (propriétaire de l'organisation) | l'entreprise (avec sa direction générale) |
| Structure | postes libres (module « Organisation »), rôles propres à quelques modules | directions → départements → postes, modèles par secteur, postes vacants |
| Droits | rôle d'organisation + espaces affectés à la main, personne par personne | idem, **plus** : le poste affecté donne ses espaces automatiquement |
| Employé | compte qui rejoint par code générique d'équipe | personne avec code personnel à usage unique, fiche d'entreprise, poste |
| Connexion | e-mail / téléphone + mot de passe | inchangée (étape 2 : code d'entreprise) |

Le module « Organisation » (postes libres) existant reste en place, sans changement.

## 4 bis. Étapes 2 à 6 : ce qui est livré

### Étape 2 : connexion employé (`src/routes/entreprise-auth.js`, page `/connexion-entreprise`)
- **Code d'entreprise** : 6 caractères sans O/0/I/1 (ex. `ABC-123`), identifiant public (pas un secret), visible des administrateurs (Entreprise › onglet Entreprise), renouvelable par le propriétaire.
- **Première connexion** (`POST /api/entreprise-auth/activate`) : code d'entreprise + code d'invitation personnel + e-mail + secret choisi (mot de passe, ou PIN de 6 à 8 chiffres sans suite ni répétition). Le compte est créé, la personne rejoint l'organisation et retrouve son poste. Un PIN ne devient jamais un mot de passe de l'ancienne connexion.
- **Connexion** (`POST /login`) : code + e-mail + secret ; messages d'erreur génériques et identiques (on ne révèle ni le code, ni l'e-mail) ; verrouillage progressif après 8 échecs (15 min, puis plus long) ; limitation de débit partagée.
- **Appareils de confiance** : à la connexion, « retenir cet appareil » 30, 60 ou 90 jours ; cookie `mia_dev` (jeton long, empreinte seule en base). `POST /resume` rouvre la session sans ressaisie (redirection automatique vers l'espace) ; jamais d'erreur, la page de connexion s'affiche sinon. Liste et révocation par la personne (Sécurité du compte) et par l'administrateur (Entreprise) ; changer son secret ferme tous les appareils ; un compte suspendu n'est pas reconnecté.
- **Double authentification** : obligatoire pour la direction générale, les directeurs et les postes de la finance / trésorerie **qui utilisent la connexion employé** (réglage de l'entreprise, propriétaire). Elle est vérifiée à chaque accès aux données (`loadOrg`) ; si la personne a déjà activé la double authentification, le code est demandé à la connexion. Les comptes actuels (propriétaires compris) ne sont **jamais** concernés tant qu'ils n'ont pas de secret employé.
- **Reconnaissance** : la réponse indique l'organisation (la dernière utilisée par défaut), le rôle et les postes / départements.
- L'**ancienne connexion** (contact + mot de passe, `/api/login`) est conservée telle quelle ; un compte actuel active la connexion employé avec son mot de passe actuel (`PUT /secret`).

### Étape 3 : profils de rôle (`src/workspace/ent-profiles.js`, écran « Mon espace de travail »)
- **22 profils de base** : DG, DAF, comptable, trésorier, caissier, contrôleur de gestion, directeur commercial, commercial / vendeur, directeur de production, chef de production, métreur (BTP), directeur logistique, dispatcheur, chauffeur, acheteur, magasinier, DRH, directeur IT et maintenance, directeur sécurité, directeur marketing, directeur stockage et achats, assistant(e) de direction, chef de projet / consultant.
- Un profil = **blocs** du tableau de bord (indicateurs d'un espace, 12 listes prêtes : factures en retard, stock sous le seuil, livraisons du jour, interventions ouvertes…, mes tâches, composants du chauffeur), **écrans** proposés, **actions rapides**, **mode mobile** (standard, compact, chauffeur). Il s'appuie sur les modules existants.
- **Chauffeur (écran mobile)** : missions du jour, itinéraire, preuve de livraison (écran de tournée existant), plein de carburant (`/logistics/fuel`), signalement d'incident (crée une intervention de maintenance).
- **Un profil ne donne aucun droit.** Un bloc, une liste ou un écran auquel la personne n'a pas accès (espace, module) est simplement absent de son profil ; les droits restent ceux du poste et du système d'espaces par rôle.
- Modifiable par l'entreprise (onglet Profils) : blocs, écrans, actions rapides, mode mobile, avec validation stricte (aucun contenu libre exécutable) et retour au profil de base. Le profil d'un poste se choisit (sinon déduit du modèle). Une personne affectée à un poste arrive sur « Mon espace de travail » ; les comptes sans poste, propriétaire compris, gardent leur arrivée habituelle.

### Étape 4 : organisations liées (`src/workspace/ent-links.js`)
- Le propriétaire de l'organisation principale (ou un DG administrateur) crée un **lien d'association** (`ASSO-…`, à copier, montré une seule fois, 1 à 30 jours, à usage unique, révocable ; seule l'empreinte est stockée).
- La personne qui crée l'organisation colle le code dans « Code d'association » : l'organisation rejoint la **même entreprise** (pas une nouvelle), la **structure est copiée** (option, sans les personnes), la **direction générale est commune** (les DG sont ajoutés administrateurs de la filiale), et **les affectations restent propres à chaque organisation**.
- L'**abonnement de l'entreprise principale** s'applique à l'organisation liée (personnes, antennes, IA) ; le nombre d'organisations est limité par cet abonnement.
- Les réglages qui engagent toute l'entreprise (informations, DG, code, double authentification, liens) sont réservés à la direction générale / organisation principale ; les organisations liées les voient sans les modifier. La direction générale peut faire entrer dans une filiale une personne d'une autre organisation de l'entreprise.

### Étape 5 : partenaires et espaces partagés (`src/workspace/ent-partners.js`)
- **Partenaires** : code `PART-…` à usage unique, expiration, **confirmation des deux côtés**, types (client, fournisseur, sous-traitant, transporteur, distributeur, cabinet comptable, partenaire stratégique) vus de chaque côté, contacts, durée, **révocation immédiate**, journal visible des deux côtés, limites par type selon l'abonnement. Entre organisations d'une même entreprise, on utilise les liens d'association, pas un partenariat.
- **Espace partagé** (chat, réunion, bibliothèque), entre partenaires **et** entre organisations liées : une organisation propriétaire, les organisations participantes, des **personnes désignées une à une** (chaque côté désigne les siennes), droits lecture / écriture / validation, durée, archivage, journal d'audit. Un canal de discussion est créé automatiquement à la confirmation d'un partenariat.
- **Réunions** : l'ordre du jour et le procès-verbal **validé** sont partagés sous forme de **copie** (« Republier » pour mettre à jour) ; décisions et tâches restent chez chacun ; les invités à droit de validation approuvent ou refusent (tracé).
- **Bibliothèque** : un dossier ou un document désigné est lisible (jamais le reste de la bibliothèque), un dépôt de fichiers (lecture + dépôt) limité par l'abonnement, chaque accès journalisé, expiration et retrait immédiats.
- **Révocation ou expiration** d'un partenariat : espaces archivés en lecture seule, accès aux réunions et documents partagés coupé tout de suite, historique de discussion lisible.
- Les modules Chat interne, Réunions et Bibliothèque ne sont **pas modifiés** : leurs tables gardent leur isolation par organisation ; l'espace partagé n'expose que des copies ou des fichiers désignés, à des personnes désignées.

### Étape 6 : limites par abonnement (`src/workspace/ent-limits.js`)
- Trois paliers déduits des limites d'organisations existantes de l'offre (base, Pro, illimité) : organisations, personnes, antennes, messages IA, directions, départements, postes, personnes de l'entreprise, profils personnalisés, partenaires (total et par type), espaces partagés, objets par espace, taille des fichiers déposés. Jamais plus bas que les limites déjà appliquées ailleurs.
- Appliquées partout : création de structure, modèles par secteur (tout ou rien), personnes, profils, partenaires, espaces, objets, fichiers, organisations liées. Refus avec un message clair invitant à changer d'offre.
- Le **quota IA est partagé** entre les organisations liées (abonnement de l'entreprise principale) ; une organisation seule garde son quota propre.
- **Écran « Abonnement et usage »** (Entreprise, administrateurs) : barres d'usage pour chaque limite.

## 5. Limites honnêtes

- Les **liens d'association** et les **partenariats** ne s'utilisent qu'avec une personne qui possède déjà un compte MABAH (ou en crée un) : il n'y a pas d'envoi automatique du code par e-mail, on le copie et on le transmet.
- **Rattacher** une organisation déjà existante à une entreprise, ou **détacher** une organisation liée, n'est pas encore possible : le lien d'association se colle à la création de l'organisation.
- La connexion employé ne couvre que les personnes **avec une adresse e-mail** (identifiant de connexion) ; le secret oublié se réinitialise par l'administrateur (nouveau code d'invitation) ; la réinitialisation par e-mail de l'ancienne connexion n'est pas branchée à ce secret.
- Un PIN protège moins qu'un mot de passe long : il est protégé par le verrouillage, la limitation de débit et, pour les postes sensibles, la double authentification ; un appareil de confiance volé reste valable jusqu'à sa révocation ou son expiration (90 jours au plus).
- Les profils de rôle organisent l'écran d'accueil : ils ne créent pas de nouveaux modules. L'incident du chauffeur exige un véhicule relié à la maintenance ; la preuve de livraison et l'itinéraire sont ceux de l'écran de tournée existant.
- Les réunions partagées sont des **copies** : une modification interne n'est visible qu'après « Republier » ; un document de bibliothèque est lu dans sa version courante (pas de verrouillage de version).
- Les messages d'erreur du serveur qui contiennent un nombre (limites d'abonnement) restent en français ; les autres sont traduits.
- Les limites sont déduites des offres existantes (3 paliers) : un forfait « sur mesure » reçoit le palier correspondant à son nombre d'organisations ; ajuster finement exigera une table de tarifs dédiée.
- Retirer une personne de l'équipe se fait toujours depuis « Équipe et antennes » (cela supprime ses affectations et ferme ses sessions) ; on ne retire d'ici que les invitations en attente.
- Le menu « Entreprise et organigramme » et « Partenaires et espaces partagés » sont dans les espaces Compte et Projets ; l'organigramme est lisible de tout membre, les partenaires seulement pour les espaces dont on est membre.
- Les textes des modèles sont fournis en français, anglais, allemand et espagnol ; un nom saisi par l'entreprise n'est évidemment pas traduit.
- Comptable et trésorier : poste de niveau responsable de l'espace Finances (la comptabilité exige le rang administrateur) ; à ajuster poste par poste.

## 6. Mise en ligne

1. Pousser la branche (voir le rapport) : **les migrations 400 à 443 s'appliquent toutes seules au démarrage** du serveur sur Render (rien à lancer à la main). Elles sont additives : aucune table existante n'est modifiée sauf l'ajout de la colonne `orgs.entreprise_id`.
2. Vérifier au démarrage : l'application répond ; `GET /api/ws/orgs/<id>/entreprise` renvoie l'entreprise de l'organisation (créée par la migration ou à la première visite).
3. Pousser le site (Vercel) : l'écran apparaît dans l'espace Compte.
4. Aucune variable d'environnement obligatoire. Facultatives : `ENTREPRISE_RIGHTS=off` (interrupteur général du lien postes → droits, voir plus bas) et `ENTREPRISE_WRITE_RATE` (écritures par 10 minutes, 400 par défaut).
5. Après la mise en ligne, un administrateur ouvre Entreprise › onglet Entreprise : le **code d'entreprise** y est affiché ; c'est lui que les employés saisiront sur la page `/connexion-entreprise`.

## 7. Retour arrière

- **Étapes 2 à 6** : elles sont additives. Sans secret employé, personne n'utilise la connexion employé (l'ancienne connexion reste la seule en usage) ; sans lien ni partenariat, aucune organisation n'est liée ; sans profil de poste, l'écran d'accueil reste l'actuel. Pour couper la double authentification des postes sensibles : réglage de l'entreprise (propriétaire). Pour révoquer tous les appareils de confiance d'une personne : Sécurité du compte ou administrateur. Un lien d'association ou un partenariat se révoque à tout moment ; la révocation d'un partenariat archive ses espaces.

- **Par entreprise** : le propriétaire coupe « Affectations et droits » (onglet Entreprise) ou `PUT /entreprise/settings {rightsLink:false}` : la structure reste, les accès redeviennent ceux d'avant. Rétablir remet tout sans ressaisie.
- **Pour toutes les entreprises** : variable d'environnement **`ENTREPRISE_RIGHTS=off`** sur Render (retirer la variable pour revenir) ; aucune structure ni affectation n'est perdue.
- **Données** : aucune donnée existante n'est modifiée ; supprimer les tables `ent_*` et `entreprises` ne perdrait que la structure (les comptes, organisations et droits actuels n'en dépendent pas). Les migrations ne sont jamais défaites.

## 8. Tests et démonstration

Tests : `test:entreprise` (étape 1), `test:entreprise-auth` (étape 2, 74 vérifications), `test:entreprise-profils` (étape 3, 50), `test:entreprise-liens` (étape 4, 62), `test:entreprise-partenaires` (étape 5, 106), `test:entreprise-limites` (étape 6, 26), tous dans `npm test`. `npm run test:entreprise` (126 vérifications : migrations et rattachement rejoué, aucun changement pour les comptes actuels, droits de chaque route, assistant, modèles par secteur, invitation et arrivée, droits donnés par un poste, retour arrière, isolation entre entreprises et organisations, DG, journal, suppression, limitation de débit) ; inclus dans `npm test`. Démonstration : `scripts/demo/entreprise-seed.js` puis `scripts/demo/entreprise-captures.js` ; captures dans `docs/captures-entreprise/`.
