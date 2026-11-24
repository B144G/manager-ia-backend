# Chat interne (par entreprise, lié à l'assistante)

Page « Chat interne » de l'espace de travail : conversations privées entre employés, groupes, fichiers, appels audio / vidéo, géolocalisation volontaire,
recherche, tâches, rappels, et assistante invitée dans une conversation. Migrations **300 à 304** (tables `ci_*`). Menu : module `chat`
(clé de permission dédiée `chat`, déclarée dans `src/workspace/modules.js`). Tests : `npm run test:chat` (≈ 230 contrôles, branché dans `npm test`).

Captures (clair, sombre, bureau, mobile 375 px) : `docs/chat-interne/captures/`.

## Ce que fait le module

| Besoin | Réalisation |
|---|---|
| Liste des conversations | nom de l'interlocuteur, dernier message, heure / jour, non lus (pastille rouge si mention ou urgent), présence, « écrit… » |
| Messages privés | texte, émojis, vocaux (MediaRecorder), fichiers, citation d'un message, modification (24 h), suppression, urgent |
| Accusés | envoyé ✓ · distribué ✓✓ · lu ✓✓ bleu ; en groupe « Lu par n ». Chacun peut désactiver ses accusés de lecture et sa présence |
| En ligne / hors ligne, « écrit… », « enregistre un audio… » | présence calculée côté serveur (flux ouvert ou signe de vie < 45 s) ; masquable par chacun |
| Groupes | créés librement, **par département** (nom du département), **par projet** (membres = personnes ayant des tâches du projet) ou par antenne ; ajout / retrait, administrateurs de groupe, renommage, quitter (un autre administrateur est nommé automatiquement), « seuls les admins écrivent », historique partagé ou non aux nouveaux membres, mentions `@nom` et `@tous` |
| Journal d'audit | création, ajout, retrait, promotion / rétrogradation, renommage, suppression de message par un admin, départ, invitation de l'assistante : table `audit_log` (entité `chat_group`) |
| Fichiers | PDF, Word, Excel, PowerPoint, images, vidéos, audio, texte ; aperçu (image, PDF, audio, vidéo), téléchargement, classement par dossier, historique, recherche ; **formats et taille maximale réglables par l'entreprise** (administrateur) |
| Appels et réunions | appel audio / vidéo, réunion de groupe, partage d'écran, historique ; planification **via le module Réunions** (convocation créée par l'API Réunions avec le lien de la salle ; réunions existantes annonçables dans la conversation) |
| Recherche | messages, fichiers, personnes ; « recherche intelligente » = l'IA propose des mots proches, puis recherche texte ; **repli automatique** sur le texte seul |
| Épingles, sondages, programmés, rappels | épingles par conversation (20 max), sondages (choix unique ou multiple, anonyme), messages programmés (50 max), rappels (notification **sans recopier le message**) |
| Tâche depuis un message | crée une vraie tâche dans « Projets et tâches » (responsable, échéance, projet) |
| Position ponctuelle | une seule fois, **consentement explicite** (confirmation + champ `consent` exigé par le serveur) |
| Géolocalisation en direct | voir plus bas |
| Traduction, transcription | via le service IA existant (traduction) et le service de transcription existant (vocaux) ; message clair si la clé est absente ou le plafond atteint |
| Assistante | voir plus bas |

## Lien avec tous les modules (objets rattachés)

Mécanisme générique **type d'objet + identifiant** et **registre extensible** (`src/workspace/chat-objects.js`, migration 305).
* **« Discuter »** : composant `DiscussButton` (site, `parts/chat/ObjectUI.jsx`) → `POST /chat/objects/:type/:id/thread` crée (ou retrouve) **un fil de discussion par objet**. Branché aujourd'hui sur **Réunions** (fiche d'une réunion) et **Bibliothèque** (fiche d'un document). Pour les autres modules : une ligne `<DiscussButton type="task" id={…} />` sur la fiche (non faite partout, pour limiter les conflits de fusion avec les autres sessions).
* **Types branchés** : tâche, projet, client, article en stock, demande client, devis / facture, employé (responsable et plus), fournisseur / commande / facture d'achat (responsable et plus : volontairement prudent, les droits d'Achats sont plus fins), **réunion**, **document de la Bibliothèque**. Un module futur s'ajoute côté serveur en une ligne : `register('mon_type', { label, icon, module, min, resolve, search, suggest })` ; le chat ne change pas.
* **Partager un objet dans une conversation** (menu « + » → « Objet d'un module ») : carte avec aperçu (titre, détail) et bouton « Ouvrir » (ouvre le module : `/app/<entreprise>/<module>?open=<type>:<id>` ; **les modules doivent lire `?open=` pour se placer sur la fiche, non fait**). L'aperçu est résolu **à chaque lecture, pour chaque lecteur, selon SES droits** dans le module : sans droit, la carte dit « objet non accessible » sans titre ni détail (ni dans l'historique, ni dans le flux temps réel). On ne peut partager qu'un objet qu'on a le droit de voir.
* **Droits d'un fil d'objet** : on ne peut ouvrir le fil que si l'on voit l'objet ; inviter quelqu'un qui n'a pas le droit est ignoré ; si quelqu'un **perd** le droit (ex. retiré d'une réunion confidentielle), le fil disparaît de sa liste, de la recherche et des fichiers, et ses messages deviennent illisibles. Les réunions confidentielles gardent leurs règles (participants, organisateur, validateurs).
* **Bibliothèque** : la carte d'un document renvoie au document **sans le dupliquer** ; les droits du bloc s'appliquent. « Enregistrer dans la Bibliothèque » (menu d'un fichier du chat) envoie le fichier par la route de la Bibliothèque elle-même (droit de dépôt, contrôles, journal) ; il reste aussi dans le chat. Les fichiers du chat figurent dans l'historique des fichiers.
* **Réunions** : la convocation crée le fil de la réunion et y rattache les participants (message système avec date et ordre du jour). Ensuite l'**ordre du jour, les décisions, les actions, la soumission / validation / renvoi du compte rendu** sont publiés comme messages système dans le fil (via le journal des réunions, `mlog`, 400 ms après l'action). Depuis le chat on planifie une réunion (module Réunions) ou on annonce une réunion existante.
* Limites : le PV complet reste dans le module Réunions (le fil ne reçoit que l'événement et les éléments clés) ; pas de mention `#objet` dans le texte (on partage une carte).

## Confidentialité et sécurité (règles appliquées côté serveur)

* **Isolation par entreprise** : toutes les routes sont sous `/api/ws/orgs/:orgId/chat` (membre de l'entreprise obligatoire) et chaque requête filtre sur `org_id`.
* **Un message privé n'est lisible que par ses participants** : toute lecture passe par `loadConv()` (participant actif). Le propriétaire et les administrateurs de l'entreprise **n'ont aucun accès** à une conversation dont ils ne font pas partie (404, comme si elle n'existait pas) : messages, fichiers, sondages, appels, recherche, assistante, tâches, rappels. Testé route par route.
* Quelqu'un retiré d'un groupe ou qui le quitte perd tout accès ; quelqu'un ajouté sans « historique partagé » ne voit que ce qui suit son arrivée.
* Texte jamais interprété (React échappe tout, liens `http(s)` seulement avec `rel="noopener noreferrer nofollow"`) ; JSON avec `nosniff`.
* Limites de débit par personne : 60 messages / min, 20 fichiers / min, appels, signalisation, recherche, IA (15 / min), position.
* Fichiers : voir « Stockage et sécurité des fichiers ».
* Chiffrement au repos : les messages sont dans PostgreSQL (chiffrement du disque de l'hébergeur Neon). Ils ne sont **pas** chiffrés champ par champ côté serveur (sinon la recherche serait impossible) — pour cela, utiliser le chiffrement de bout en bout.
* Suppression d'un compte : le nom est anonymisé par le mécanisme existant (« Utilisateur supprimé ») ; les messages restent dans les conversations des autres. Suppression d'une entreprise : tout part en cascade.

## Chiffrement de bout en bout (conversations à DEUX)

Option « Chiffrée de bout en bout » à la création d'une conversation privée. Chaque appareil crée une paire de clés ECDH P-256 (WebCrypto, aucune bibliothèque) ; la clé **privée** reste dans le navigateur (IndexedDB, non exportable) et n'est jamais envoyée. Le serveur ne garde que la clé **publique** (`ci_keys`, refus d'une clé qui contiendrait une partie privée). Messages, vocaux et fichiers (nom compris) sont chiffrés en AES-256-GCM, un IV par élément. Un **code de sécurité** (empreinte des deux clés) s'affiche pour comparaison de vive voix.

Conséquences assumées : le serveur, l'administrateur et l'assistante ne peuvent pas lire ces conversations, donc **pas de recherche, d'assistante, de traduction, de transcription, de sondage, de message programmé ni de position** dedans (le serveur refuse). Les fichiers chiffrés ne peuvent pas être contrôlés (type réel, antivirus) puisque le serveur ne les voit pas : seule la taille est limitée. **Limites** : pas de synchronisation entre appareils (une clé par navigateur) ; si les données du navigateur sont effacées, l'historique chiffré devient illisible ; **pas de chiffrement de bout en bout dans les groupes** (il faudrait une gestion de clés de groupe : à faire) ; la clé est dérivée directement de l'échange ECDH (pas de HKDF ni de « double ratchet » : pas de confidentialité persistante par message).

## Géolocalisation en direct (volontaire)

Bouton « Géolocalisation » dans l'en-tête de toute conversation (et sur l'accueil du chat) : carte (OpenStreetMap / Leaflet) des collègues **connectés qui l'ont activée**.
* **Activée par chacun, jamais imposée** (ni par un responsable, ni par l'administrateur). Confirmation explicite ; le serveur refuse l'activation sans `consent`.
* Désactivation à tout moment : les coordonnées sont **effacées immédiatement**. Positions de plus de 24 h effacées automatiquement.
* Visible seulement des membres de la même entreprise, et seulement si la personne est **en ligne** (position de moins de 5 minutes).
* Tant que l'employé est connecté à l'application (n'importe quel écran, pas seulement le chat), l'appareil envoie sa position toutes les 30 s (composant `Beacon`). Fermer l'onglet = plus rien n'est envoyé. **Limite** : un navigateur ne peut pas suivre en arrière-plan quand l'onglet est fermé ou le téléphone verrouillé.
* Activations et désactivations dans le journal d'audit (`chat_geo`).

## L'assistante dans une conversation

* Elle n'est présente que si elle a été **invitée** (n'importe quel participant d'un échange à deux ; un administrateur pour un groupe) ; un message système prévient tout le monde. Jamais dans une conversation chiffrée de bout en bout.
* Actions : **résumer**, **poser une question**, **extraire tâches et décisions** (boutons « Créer la tâche »), traduction, recherche intelligente, et réponse publique à un `@ia` écrit dans un message.
* Elle ne lit que **la conversation concernée**, limitée à ce que la personne qui la sollicite a le droit de lire ; jamais une autre conversation (testé : un secret placé dans une autre conversation n'arrive jamais à l'IA).
* Ses réponses sont des **notes privées** (visibles de la seule personne qui a demandé, trait pointillé) tant qu'elle ne clique pas « Partager avec la conversation ». Les données de l'entreprise ne sont ajoutées qu'à la demande de la personne et **selon ses droits** (même contrôle que l'assistante de l'espace de travail) ; une telle réponse **ne peut pas être partagée telle quelle**. Une réponse à un `@ia` public n'utilise **que** la conversation.
* Le nom affiché vient de la constante unique `src/workspace/chat-brand.js` (serveur, variable `PRODUCT_NAME`) : à brancher sur la constante centrale du nom du produit après la fusion / le renommage. Le site reçoit le nom de l'assistante du serveur : aucun nom en dur dans le code du site.
* Clé IA absente, quota du forfait atteint, plafond journalier, panne : message clair en français (`{ ok: false, code, message }`), jamais d'erreur brute ; le chat fonctionne normalement sans IA. L'IA compte dans le quota mensuel de l'entreprise.

## Temps réel

* **Flux SSE** `GET /chat/stream` (un par personne, 4 au plus), battement de cœur toutes les 20 s, tampon des 300 derniers événements par personne.
* **Repli** : si le flux tombe ou se tait 65 s, le site passe à l'interrogation `GET /chat/updates` toutes les 5 s (mêmes événements) et retente le flux toutes les 40 s. Un redémarrage du serveur est détecté (`epoch`) : le site recharge tout.
* **Limite assumée** : le bus est **en mémoire d'un seul processus** (comme l'hébergement actuel sur Render). Avec plusieurs instances, il faudra le remplacer (Redis, LISTEN/NOTIFY). Le proxy de Vercel peut couper les flux longs : le repli sert précisément à cela. L'interrogation compte dans la limite générale de requêtes (3000 par 15 min et par adresse IP, `RATE_LIMIT_GLOBAL`) : un grand bureau derrière une seule adresse peut devoir l'augmenter.

## Stockage et sécurité des fichiers

* Stockage **dans PostgreSQL** (colonne `BYTEA`, table `ci_files`), comme les pièces jointes des autres modules : le disque de Render peut être éphémère, donc aucun fichier n'est écrit sur disque. Téléversement en binaire brut (`Content-Type: application/octet-stream`), pas de base64.
* Taille : réglage de l'entreprise (1 Mo à `CHAT_HARD_MAX_FILE_MB`, 25 Mo par défaut) ; refus dès l'en-tête `Content-Length`. **Non vérifié** : la limite de taille du proxy de Vercel pour les gros corps de requête — à tester avec un fichier de 8 Mo en production ; si besoin, baisser le réglage.
* Contrôles (`chat-upload.js`) : **type réel** lu dans les premiers octets (jamais le type annoncé) ; extension cohérente ; refus des exécutables, scripts, pages web et SVG ; refus des documents Office avec macros (`vbaProject.bin`, anciens formats `.doc/.xls` contenant des macros), des ZIP quelconques, des PDF avec JavaScript ; signature de virus de test EICAR ; fichier texte = UTF-8 sans octet nul.
* **Ce n'est pas un antivirus complet.** Pour une vraie analyse, définir `CHAT_CLAMAV_HOST` (démon ClamAV `clamd`, port `CHAT_CLAMAV_PORT`, 3310 par défaut) ; `CHAT_CLAMAV_REQUIRED=1` refuse les envois si l'antivirus est indisponible.
* Téléchargement : `Content-Disposition`, `nosniff`, `Content-Security-Policy: sandbox`, jamais de type inventé. Accès : participants de la conversation uniquement, et seulement aux fichiers postérieurs à leur arrivée.
* **Partage depuis les autres modules** : composant `src/ws/parts/chat/ShareToChat.jsx` (`<ShareToChat name getBlob />`) : le fichier passe par le même circuit sécurisé. **Non branché** dans chaque module (pour ne pas créer de conflits de fusion avec les sessions en cours) : chaque module n'ajoute qu'une ligne. Le module qui l'utilise garde la responsabilité de n'offrir le bouton que pour les fichiers que la personne a le droit de lire.

## Appels et réunions (WebRTC)

* Le serveur ne fait **que la signalisation** (offres, réponses, candidats ICE relayés entre participants déjà « dans l'appel » ; taille limitée) ; l'audio et la vidéo passent directement entre les appareils. **Rien n'est enregistré.**
* Négociation « parfaite » (les deux côtés peuvent proposer sans blocage), partage d'écran par remplacement de piste, coupure micro / caméra.
* **Limites honnêtes** : maillage pair à pair → **petits groupes** (6 personnes par défaut, `CHAT_CALL_MAX`, 12 au plus) : chaque personne envoie son flux à chacune des autres, la bande passante monte vite. **Derrière certains réseaux mobiles (4G / CGNAT) ou pare-feu d'entreprise, la connexion directe est impossible sans serveur TURN** : l'interface le dit clairement. Une sonnerie sonore n'est pas jouée (notification du navigateur seulement si autorisée). Un appel est coupé si plus personne n'y est ; sans réponse : « manqué » après 45 s (échange à deux) ou 60 s (groupe), avec notification aux absents. Non testable automatiquement ici : le flux audio/vidéo réel (testé : signalisation, droits, historique, limites).
* Planification : « Planifier une réunion » crée la réunion dans le module **Réunions** (mêmes droits de convocation que dans ce module : sinon refus explicite) avec le lien `…/app/<entreprise>/chat?room=<conversation>` qui ouvre la salle ; la réunion est annoncée dans la conversation. Les réunions confidentielles ne peuvent être annoncées que par ceux qui y sont invités.

## Variables d'environnement (toutes facultatives)

| Variable | Rôle | Défaut |
|---|---|---|
| `PRODUCT_NAME` | nom du produit utilisé pour nommer l'assistante (« … IA ») ; à remplacer par la constante centrale après le renommage | `Brij-IA` |
| `CHAT_STUN_URLS` | serveurs STUN, séparés par des virgules | STUN publics de Google |
| `CHAT_TURN_URLS` | serveurs TURN (ex. `turn:turn.exemple.com:3478,turns:turn.exemple.com:5349`) | aucun |
| `CHAT_TURN_SECRET` | secret partagé coturn (`use-auth-secret`) : identifiants **temporaires** (1 h) calculés par le serveur | — |
| `CHAT_TURN_USERNAME` / `CHAT_TURN_CREDENTIAL` | alternative : identifiants fixes (moins sûr : visibles du navigateur) | — |
| `CHAT_CALL_MAX` | personnes maximum dans un appel (2 à 12) | 6 |
| `CHAT_HARD_MAX_FILE_MB` | plafond absolu de taille de fichier (Mo) | 25 |
| `CHAT_CLAMAV_HOST` / `CHAT_CLAMAV_PORT` / `CHAT_CLAMAV_REQUIRED` | analyse antivirus ClamAV (`clamd`) | désactivée |
| `CHAT_JOBS` | `off` : n'exécute pas les tâches de fond (messages programmés, rappels, appels sans réponse) — utile pour une seconde instance | actives |

Aucun secret dans le code ni dans le chat. La clé IA, les clés TURN et le secret restent dans l'environnement du serveur.

## Compatibilité avec les autres sessions

* Uniquement de **nouvelles migrations 300–304** (rembourrage de 146 à 299 par des migrations vides « réservées » dans `src/db.js`, avant la 300 : à placer **après** les modules 146–149, 170+, 200–201 lors de la fusion — chaque module remplit « son » emplacement). Test de migrations : la ligne « 145 migrations au total » est devenue « au moins 145 ».
* Fichiers nouveaux : `src/workspace/chat*.js`, `src/migrations/chat-interne.js`, `scripts/test-chat*.js`, `scripts/demo-chat.js`, `docs/chat-interne*`. Côté site : `src/ws/modules/chat.jsx`, `src/ws/parts/chat/*`, `src/styles/ws-chat.css`, `src/i18n/*/ws-chat.js`.
* Lignes ajoutées dans des fichiers existants : `db.js` (migrations), `workspace/index.js` (route), `workspace/modules.js` (entrée de menu), `server.js` (en-tête Permissions-Policy : caméra, micro, localisation, partage d'écran autorisés pour le site lui-même), `vercel.json` (idem), `registry.js` (icône), `Workspace.jsx` (pastille « non lus » et balise de position, 4 lignes), `package.json` / `run-all-tests` (via `test:chain`).
* « Espaces par rôle » : l'entrée de menu est exposée par `modules.js` avec `perm: 'chat'` ; l'espace par rôle n'a qu'à rattacher la clé `chat`.

## Ce qui reste à faire

* Chiffrement de bout en bout des **groupes** (clés de groupe) et sauvegarde / synchronisation des clés entre appareils (avec phrase secrète).
* Brancher `ShareToChat` dans chaque module (Bibliothèque, Commercial, Achats, Réunions…).
* Serveur TURN à fournir et à tester sur réseau mobile réel (variables `CHAT_TURN_*`) ; test réel de la limite de taille d'envoi à travers Vercel.
* Notifications « push » (application fermée) : seules les notifications internes / e-mail sans contenu existent aujourd'hui.
* Bus temps réel partagé si le serveur passe à plusieurs instances.
* Suivi de position en arrière-plan (application mobile native) ; aujourd'hui, seulement navigateur ouvert.
* Antivirus ClamAV à installer pour une analyse complète des fichiers.
