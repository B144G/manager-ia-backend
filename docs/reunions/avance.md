# Réunions avancées — audit, conception, routes, limites

Ce document complète [README.md](README.md) (module Réunions livré). **La règle centrale est inchangée** : le propriétaire désigne qui convoque et qui valide, par personne / rôle / type ; un compte rendu validé est verrouillé et versionné ; les actions deviennent des tâches Projets à la validation ; les réunions confidentielles restent invisibles à qui n'y siège pas.

Branche : `reunions-avance` (serveur et site). Migrations **146 à 149** (`src/migrations/reunions-avance.js`, append-only, rejouables). Aucune migration existante n'a été modifiée.

## 1. Audit : ce qui existait, ce qui a été construit

Légende : **Existe** = livré avant ce lot · **Partiel** = base présente, complétée ici · **Manquant** = construit ici.

| # | Service demandé | État avant | Existant (code) | Construit dans ce lot |
|---|---|---|---|---|
| 1 | Planification des réunions | Existe | `meetings.js` : `POST /`, `PUT /:id`, `/cancel`, `/respond`, `/invite`, `.ics`, WhatsApp (liens `wa.me`), calendrier (`Calendar.jsx`) | Site d'accueil, service, président de séance, niveau d'urgence, conflits d'agenda (voir 3.4) |
| 2 | Gestion des types de réunions | Partiel | 6 catégories fixes `TYPES` (`meetings-lib.js`) qui portent les droits | **Types personnalisés** (`mtg_types`, `/types`) : nom, couleur, catégorie de droits, durée, confidentialité, rappel, modèle d'ordre du jour, règle de quorum propre. Les droits restent ceux de la catégorie |
| 3 | Gestion des ordres du jour | Existe | `mtg_agenda`, `cleanAgenda`, `syncAgenda`, modèles `mtg_templates`, `POST /ai/agenda` | Nature du point (information / discussion / décision), **propositions par les participants** (acceptées ou refusées par l'organisateur), durée réelle par point |
| 4 | Gestion du déroulement | Partiel | `PUT /:id/notes` (notes par point, présence réelle) | **Ouverture / levée de séance horodatées**, présences en direct avec **retards**, **quorum en direct**, poids de vote (`PUT /:id/presence`, `/start`, `/end`) |
| 5 | Comptes rendus **et** procès-verbaux | Partiel | Compte rendu : brouillon → soumis → validé/renvoyé → nouvelle version ; PDF (`meetings-minutes.js`) | **Procès-verbal** numéroté `PV-AAAA-NNN`, distinct du compte rendu : présences, quorum constaté, résolutions et votes, trace « sans quorum », exposé, signatures, PDF (`meetings-adv2.js`) |
| 6 | Décisions **et** résolutions | Partiel | `mtg_decisions` (texte libre) | **Résolutions** numérotées `RES-AAAA-NNN` : texte, porteur, échéance, statut (en attente / adoptée / rejetée / reportée / sans quorum), majorité, mode de vote. Une résolution adoptée crée la décision et l'action du porteur |
| 7 | Création automatique des tâches | Existe | `syncTasks` à la validation du compte rendu, synchro des statuts, rappels J-1 / J+1 | Les résolutions adoptées avec porteur/échéance alimentent la même chaîne ; **aucune tâche** pour une réunion sans quorum (décisions non valides) |
| 8 | Notifications et rappels automatiques | Partiel | Invitations (notice + e-mail + .ics), rappel de réunion, rappels d'actions (`meetings-jobs.js`) | **Notification prioritaire** des réunions urgentes ; **quorum menacé** (< 24 h) ; **signature en attente** > 48 h ; **engagement non tenu** > 7 jours (prévient aussi l'organisateur) ; relance manuelle de l'équipe |
| 9 | IA intégrée (MABAH) | Partiel | Résumé, extraction décisions/actions, ordre du jour proposé (`meetings-ai.js`) | **Résolutions proposées**, **exposé du PV**, **relances des engagements non tenus**. Sans clé : 503 clair. Aucune transcription audio |
| 10 | Documents et archives | Partiel | Pièces jointes (Bibliothèque), recherche, exports CSV | **Archivage** (`archived_at`) d'une réunion validée (+ PV signé), liste des archives, sortie des archives, PDF du compte rendu et du PV |
| 11 | Autorisations et confidentialité | Existe | `visibleSql`, `contextFor`, `load` | Étendues à toutes les nouvelles routes ; **vote secret** : aucun lien bulletin ↔ personne ; conflits d'agenda sans titre pour une réunion confidentielle invisible |
| 12 | Tableau de bord et statistiques | Partiel | `GET /dashboard` (mois, présence, actions) | **`GET /stats`** : taux de décision, présence, ponctualité, durée, tâches, par type / service / site / urgence, courbe mensuelle, filtres par période |
| 13 | Réunion multi-sites | Manquant | — | Site d'accueil + sites concernés (`mtg_scope`) ; marqueur déduit ; filtres |
| 14 | Réunion inter-services | Manquant | — | Service porteur + services concernés (service RH des participants pris en compte) ; filtres |
| 15 | Réunion urgente | Manquant | — | `urgency` (normale / urgente / critique) ; préavis minimal par niveau (réglable) ; invitations d'office ; rappel 15 min ; notice `meeting_urgent` ; `.ics` priorité 1 |
| 16 | Réunion périodique | Partiel | Séries hebdo / 2 semaines / mensuelle en copies indépendantes | **Trimestrielle**, **dates d'exception**, **jours fériés sautés** (jours fériés RH) |
| 17 | Validation électronique | Partiel | Validation du compte rendu (qui, quand) | **Signature électronique** : horodatage + empreinte SHA-256 du contenu figé, ordre facultatif, intégrité vérifiable (`mtg_signatures`) — compte rendu et PV |
| 18 | Vote électronique | Manquant | — | Voir 3.2 |
| 19 | Gestion des conflits d'agenda | Manquant | — | Voir 3.4 |
| 20 | Réunions sans quorum | Manquant | — | Voir 3.3 |
| 21 | Suivi des performances | Manquant | — | `GET /performance` |
| 22 | Historique des responsabilités | Manquant | — | `GET /responsibilities` (`mtg_resp`, repris de l'existant par la migration 149) |

## 2. Modèle de données (migrations)

- **146** : colonnes de `mtg_meetings` (`branch_id`, `department_id`, `type_id`, `urgency`, `chair_id`, `started_at`, `ended_at`, `quorum_mode`, `parent_id`, `no_quorum_reason`, `series_exceptions`, `archived_at`, `quorum_alerted_at`), de `mtg_participants` (`vote_weight` — `NULL` = 1 pour un membre, 0 pour un invité externe —, `late_min`), de `mtg_agenda` (`kind`, `proposed_by`, `accepted`, `spent_min`), de `mtg_decisions` (`resolution_id`) ; tables `mtg_types`, `mtg_scope`.
- **147** : `mtg_resolutions`, `mtg_votes` (clé de scrutin HMAC ; en vote secret `participant_id` et `cast_at` sont vides), `mtg_vote_roll` (émargement : qui a voté, jamais ce qu'il a voté).
- **148** : `mtg_pv`, `mtg_signatures`.
- **149** : `mtg_resp` (historique des responsabilités) + reprise des organisateurs, secrétaires et actions existants.

## 3. Conception

### 3.1 Règles de droits (inchangées, étendues)
- Écrire sur une réunion : organisateur, secrétaire, propriétaire, ou personne autorisée à convoquer ce type (`ctx.write`). Le **président de séance** peut en plus ouvrir et clore les votes.
- Types personnalisés, réglages avancés (quorum, préavis, conflits bloquants, signatures dans l'ordre) : **propriétaire** (types : administrateur et plus).
- Archiver, rouvrir un PV signé : personnes autorisées à valider (ou propriétaire).
- Statistiques et listes : même filtre de visibilité (`visibleSql`) que les fiches.
- **Performances et historique** : le propriétaire et les personnes qui convoquent ou valident voient l'équipe ; les autres ne voient que **leur propre** suivi (403 sinon).

### 3.2 Résolutions et vote électronique
- Une résolution : `number`, `title`, `text`, porteur (`carrierId` ou `carrierName`), `due`, `status`, `majority` (`simple` | `qualified` + seuil 51–100 % | `unanimity`), `weighted`, `voteMode` (`hand` | `named` | `secret`), `voteState` (`none` → `open` → `closed`).
- **Ouverture** (organisateur ou président, **quorum atteint**, un seul vote ouvert à la fois). Vote : `for` / `against` / `abstain`. **Un vote par participant, modifiable jusqu'à la clôture** (même clé de scrutin). Seuls les participants **marqués présents** et ayant un poids > 0 votent.
- **À main levée** : saisi par le secrétaire (`items:[{participantId, choice}]`) ; le participant ne vote pas lui-même.
- **Nominatif** : détail par personne visible une fois clos (et de l'organisateur pendant le vote).
- **Secret** : le bulletin n'est jamais lié à la personne (clé HMAC du serveur, pas de `participant_id`, pas d'heure) ; l'émargement dit seulement **qui a voté**. Résultat agrégé visible de tous ; aucun détail, même pour l'organisateur. Le journal ne contient jamais un choix.
- **Calcul** : abstentions exclues des suffrages exprimés. Simple : pour > contre (égalité = rejetée). Qualifiée : pour / (pour + contre) ≥ seuil. Unanimité : aucun contre et au moins un pour. Aucun suffrage exprimé = rejetée. Pondération : poids de vote du participant (sinon 1).
- **Clôture** : résultat + empreinte SHA-256 consignés, verrouillés. Si le quorum est perdu avant la clôture : statut `no_quorum`, résultat nul. Adoptée : décision créée (« RES-… — texte ») et, si porteur/échéance, **action** (→ tâche à la validation du compte rendu).
- **Report** (`/postpone`, motif obligatoire) : statut `postponed`, éventuellement copie (nouveau numéro) dans une autre réunion.

### 3.3 Quorum et réunion sans quorum
- Règle par **catégorie** (réglages) ou par **type personnalisé** : `minCount`, `minPercent`, `roles` (présences minimales par rôle : membre / responsable / administrateur / propriétaire), `reduced` (`allowed`, `minCount`, `minPercent`, `delayDays`).
- Calculé **en direct** sur les présences cochées pendant la séance (base : participants ayant voix et convoqués obligatoires). Sans règle : quorum non exigé.
- **Sans quorum** (`POST /:id/no-quorum`) : statut explicite `no_quorum`, résolutions en attente → `no_quorum`, aucune décision valable, aucune tâche créée à la validation, **report automatique** : si la règle l'autorise (`reduced.allowed`), nouvelle réunion (`parent_id`, `quorum_mode = reduced`) à `+delayDays`, mêmes participants et ordre du jour, participants prévenus. La 2ᵉ convocation ne se reporte pas indéfiniment. Trace dans le PV (motif, réunion de report).

### 3.4 Conflits d'agenda
`POST /conflicts` (avant d'enregistrer) et à la convocation / modification : participants déjà pris (chevauchement strict : 10:00–11:00 et 11:00–12:00 ne se chevauchent pas), **lieu occupé** (comparaison sans casse ni accents ni espaces multiples), **congés approuvés** du module RH (`leaves` ↔ `employees.user_id`), jours fériés RH. Renvoie jusqu'à 6 **créneaux alternatifs** (30 min de pas, 7 h 30 – 18 h, 5 jours, hors dimanche). Par défaut : **avertissement** non bloquant (`conflicts` dans la réponse). Le propriétaire peut les rendre **bloquants** (`blockConflicts`) : 409 `conflict`, contournable par `force: true`. Les réunions confidentielles invisibles sont signalées « occupé » sans titre.

### 3.5 Validation électronique
Compte rendu : à la validation, signature du validateur (horodatage, empreinte du contenu figé). PV : projet → **verrouillage + demande de signatures** (signataires, ordre facultatif, empreinte) → chaque signataire signe (refus si l'empreinte ne correspond plus au contenu) → `signed` quand tous ont signé ; nouvelle version = nouveau numéro `…-R2` (l'ancienne est conservée, `superseded`).

## 4. Routes (préfixe `/api/ws/orgs/:orgId/meetings`)

| Méthode et chemin | Rôle |
|---|---|
| `GET /settings` · `PUT /settings` | + `quorum`, `noticeH`, `blockConflicts`, `signOrdered` (écriture : propriétaire) |
| `GET /types` · `POST/PUT/DELETE /types[/:id]` | types personnalisés (admin) |
| `POST /conflicts` · `GET /:id/conflicts` | conflits d'agenda + créneaux |
| `GET /:id/quorum` · `PUT /:id/presence` · `POST /:id/start` · `POST /:id/end` · `POST /:id/no-quorum` | déroulé, quorum |
| `POST /:id/agenda/propose` · `POST /:id/agenda/:aid/decide` · `PUT /:id/agenda/:aid` | ordre du jour |
| `GET/POST /:id/resolutions` · `PUT/DELETE /:id/resolutions/:rid` · `POST …/open-vote` · `…/vote` · `…/close-vote` · `…/postpone` | résolutions et votes |
| `GET /resolutions` · `GET /resolutions.csv` | registre |
| `GET/POST/PUT /:id/pv` · `POST /:id/pv/request-signatures` · `POST /:id/pv/sign` · `POST /:id/pv/new-version` · `GET /:id/pv.pdf` · `GET /:id/signatures` | procès-verbal, signatures |
| `POST /:id/archive` · `POST /:id/unarchive` · `GET /archives` | archives |
| `GET /stats` | statistiques (`from`, `to`, `type`, `typeId`, `branchId`, `departmentId`, `urgency`) |
| `GET /performance` · `GET /responsibilities` · `GET /commitments/late` · `POST /commitments/remind` | suivi |
| `POST /:id/ai/resolutions` · `POST /:id/ai/pv` · `POST /ai/commitments` | IA |
| Liste `GET /` | + filtres `branchId`, `departmentId`, `urgency`, `urgent=1`, `typeId`, `archived=0|1`, `multiSite=1`, `interService=1`, statut `no_quorum` |
| `POST /` · `PUT /:id` | + `typeId`, `urgency`, `chairId`, `branchId`, `departmentId`, `sites[]`, `departments[]`, `force`, `recurrence.{freq: weekly|biweekly|monthly|quarterly, count, exceptions[], skipHolidays}`, `participants[].voteWeight` |

## 5. Tests
`npm run test:meetings-avance` (≈ 260 vérifications : migrations rejouables, quorum par rôle et réduit, types, urgence, conflits (participants, lieu, congés, fériés, confidentialité), multi-sites, séries et exceptions, votes à main levée / nominatif / secret, majorités simple / qualifiée / unanimité, pondération, quorum perdu, report, PV et signatures dans l'ordre, altération du contenu, archivage, statistiques, performances, responsabilités, rappels, IA factice, droits et isolation entre organisations) et `npm run test:meetings-avance-noai` (503 clair sans clé, reste fonctionnel). Les tests existants (`test:meetings`, `test:migrations`) passent sans modification de leurs vérifications (seul le décompte « exactement 145 migrations » devient « au moins 145 »).

## 6. Limites honnêtes
- **Signature électronique simple** : identité de la session connectée + horodatage + empreinte SHA-256 du contenu. Ce n'est **pas** une signature qualifiée (eIDAS) ; elle prouve qui a signé quoi et quand dans MABAH et que le contenu n'a pas changé depuis.
- **Vote secret** : le secret est garanti par l'application et l'API (aucun lien enregistré entre bulletin et personne). Une personne qui contrôle à la fois la base de données **et** la clé secrète du serveur (`DATA_KEY`/`JWT_SECRET`) pourrait recalculer les clés de scrutin ; l'heure de l'émargement n'est pas non plus reliée au bulletin. Le vote reste **en séance** (présents cochés), pas à distance différée.
- **Quorum** : calculé sur les présences saisies pendant la séance ; il dépend de la saisie de l'équipe.
- **Congés** : lus dans le module RH (congés approuvés) pour les membres reliés à une fiche employé ; sans fiche, aucun conflit de congé détectable.
- **Service d'une personne** : celui de son profil RH (`rh_emp_profile`), sinon non connu.
- **IA** : propositions à relire, rien n'est enregistré sans validation humaine ; sans clé 503 clair ; testée avec un fournisseur factice. **Aucune transcription audio** (inchangé).
- **Relances** : notices dans l'application et e-mail si le serveur d'e-mails est configuré ; **aucun envoi WhatsApp automatique** (message prêt à copier, inchangé).
- Les invités externes ne votent pas eux-mêmes (pas de page publique) : à main levée, le secrétaire saisit leur vote s'ils ont un poids de vote > 0.
- **Archivage** : verrouille l'état (compte rendu validé, PV signé) et facilite la recherche ; il ne remplace pas une sauvegarde ni une politique légale de conservation.
- Aucun texte « à valider par un expert-comptable » : sans objet pour ce module.

## 7. Captures (navigateur réel, serveur de démonstration, ports 3200 / 5299)
`docs/reunions/avance-*.jpg` : statistiques (camemberts taux de décision et types), vote ouvert (décompte réservé à l'organisateur), votes secret et à main levée (résultat agrégé, jamais le détail du secret), archives, procès-verbal signé, statistiques et conflits d'agenda à **375 px**. Contrôle de débordement horizontal à 375 px sur 10 écrans (convocation, déroulé, résolutions, procès-verbal, statistiques, suivi des personnes, registre, réglages, types, archives) : aucun. Jeu de données : `node scripts/demo/reunions-avance.js` (après `scripts/demo/seed.js`).

## 8. Site
`src/ws/parts/meetings/` : `Resolutions.jsx`, `Pv.jsx`, `Quorum.jsx`, `Conflicts.jsx`, `Types.jsx`, `Stats.jsx`, `People.jsx`, `Registry.jsx` (+ `Archives`), extensions de `Form.jsx`, `Detail.jsx`, `Minutes.jsx` (déroulé), `Settings.jsx` ; styles `ws-meetings-adv.css` et `ws-meetings-adv-a.css` ; traductions `src/i18n/{en,de,es}/ws-meetings-adv-a.js` et `-b.js` (12 622 / 12 622 textes traduits).

## 9. Limites réglables et partage d'écran
- **Participants par réunion** : 60 par défaut, réglable par le **propriétaire** de 10 à 500 (`PUT /settings`, champ `maxParticipants`, Réglages › Limites). Au-delà : refus clair (400) ; la fiche signale la proximité de la limite (≥ 90 %). Les autres limites (séries 26, 40 points d'ordre du jour, 20 pièces jointes, 40 types, 60 résolutions) restent fixes par sécurité.
- **Partage d'écran** : MABAH n'a pas de visio intégrée (limite honnête inchangée). Chaque réunion peut recevoir une **salle Jitsi Meet** gratuite (`autoRoom: true` à la convocation, ou `POST /:id/room`), au nom aléatoire non devinable ; bouton « Rejoindre et partager l'écran » ; les liens Meet / Zoom / Teams collés restent possibles. Le partage d'écran est fourni par la salle, sans limite fixée par MABAH ; le service public Jitsi Meet supporte de l'ordre d'une centaine de participants simultanés (au-delà : serveur Jitsi dédié, ou Zoom/Teams selon l'offre). Le partage n'est pas enregistré ni suivi par MABAH.
