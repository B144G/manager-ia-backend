# Module Réunions — notes de livraison

Module id `meetings`, titre « Réunions ». Serveur : `src/workspace/meetings*.js`, migration `src/migrations/reunions.js` (tables `mtg_*`). Site : `src/ws/modules/meetings.jsx`, `src/ws/parts/meetings/`, `src/styles/ws-meetings.css`, `src/i18n/{en,de,es}/ws-meetings.js`.

## Règle centrale : qui convoque, qui valide
Réglages du propriétaire (écran « Réglages des réunions », `GET/PUT /meetings/settings`) : par personne, par rôle (membre, responsable, administrateur), par type (direction, équipe, chantier, client, comité, autre). Une règle propre à un type REMPLACE la règle générale. Par défaut : propriétaire seul. Option « validateur distinct de l'auteur » (auteur = la personne qui soumet). Le propriétaire a toujours les deux droits. Toutes les routes appliquent ces droits côté serveur (`meetings-lib.js`).

## Choix de conception à connaître
- Les droits d'écriture sur une réunion : organisateur, secrétaire, propriétaire, ou toute personne autorisée à convoquer pour ce type.
- Réunion confidentielle : visible par ses participants, l'organisateur/secrétaire, le propriétaire et les validateurs de son type (pour qu'ils puissent valider). Titre jamais écrit dans le fil d'activité.
- Le compte rendu validé est un instantané verrouillé (`mtg_minutes`). Modification = nouvelle version (historique conservé). Les lecteurs simples ne voient que la dernière version validée.
- Les actions deviennent des tâches Projets à la VALIDATION (rattachées au projet lié à la réunion s'il y en a un). Le statut est synchronisé dans les deux sens ; rappels à J-1 et au premier jour de retard.
- Fuseau : décalage de l'organisation (défaut UTC+1, Cameroun) pour les rappels et les agendas .ics.

## Limites honnêtes
- IA : dépend d'une clé configurée (`AI_API_KEY`/`ANTHROPIC_API_KEY`) ; testée avec un fournisseur factice seulement. Sans clé : 503 clair, sauf l'ordre du jour proposé qui retombe sur une proposition de base. Les appels comptent dans le quota de messages IA de l'organisation.
- Transcription audio : NON utilisée (les enregistrements de réunion dépassent ce que `stt.js` accepte : délai de 30 s, un seul fichier) ; aucune promesse faite.
- WhatsApp : message prêt à copier et liens `wa.me` ; aucun envoi automatique (canal par code QR).
- Les invités externes ne répondent pas eux-mêmes (pas de page publique) : l'organisateur enregistre leur réponse (« Réponse reçue »).
- E-mails : service existant ; limite quotidienne de l'offre partagée avec les e-mails clients ; sans SMTP/Brevo configuré, seules les notices dans l'application partent.
- Pièces jointes : références vers la Bibliothèque (le contrôle d'accès reste celui de la Bibliothèque ; un bloc verrouillé par mot de passe se déverrouille dans la Bibliothèque).
- Série récurrente : copies indépendantes ; l'annulation peut viser « cette réunion et les suivantes ».

## Captures
`docs/reunions/*.png` (1280 px = bureau ; 390 et 768 px ; thème sombre à 390 px). Vérification de débordement et de cibles ≥ 44 px : 26/26 écrans à 360 et 768 px, 0 problème à 390 et 412 px dans le premier passage (cibles de 30–40 px à 1280 px = densité bureau).
