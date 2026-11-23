# Portée des réponses automatiques de l'assistant WhatsApp

Le responsable choisit à qui l'assistant a le droit de répondre **tout seul** sur WhatsApp : **tout le monde** (défaut, comportement historique), **uniquement les prospects** ou **uniquement les contacts venant d'une publicité**. Réglage par entreprise, avec une surcharge facultative par ligne (API officielle Meta / code QR).
Écran : Assistant commercial › **Périmètre** (administrateurs). Captures : `docs/wa-portee/captures/` (réglage, étiquettes, conversation, mobile 375 px).

## Définitions (affichées aussi dans l'écran)
- **Contact venant d'une publicité** : premier message reçu via une publicité « cliquer pour discuter » (Meta : champ `referral` du webhook officiel, `source_type` ad/post ; WhatsApp Web : `contextInfo.externalAdReply` avec identifiant d'annonce, `ctwaClid` ou type « ad »), **ou** message d'entrée contenant un mot-clé de campagne configuré (sans casse ni accents) ou le marqueur `#campagne` du lien, **ou** contact marqué « publicité » à la main ou par import. Un contact organique qui clique ensuite sur une publicité devient « publicité » ; une origine posée à la main ou par import n'est jamais écrasée automatiquement.
- **Prospect** : pas encore client. Ne sont pas des prospects : fiche client (étape « client »), contact ayant une commande ou une facture non brouillon/annulée, fournisseur, employé (même numéro, 9 derniers chiffres), prospect Commercial « converti » ou « disqualifié », contact de la liste « jamais ». Un contact nouveau, une fiche « prospect », un simple devis ou un prospect en pipeline restent des prospects. Aucune donnée n'est dupliquée : on lit `customers`, `documents`, `suppliers`, `employees`, `cp_leads`.
- **Tout le monde** : comportement actuel.

Ordre de décision : liste « jamais » > liste « toujours » > mode. (Les exclusions du Suivi de l'IA sont vérifiées avant, comme avant.)

## Hors périmètre
Le message est enregistré normalement, l'équipe reçoit la notice existante du Suivi de l'IA (« hors périmètre… »), l'assistant n'envoie **rien** (pas même « message non pris en charge »). Dans la liste des conversations : étiquette « Hors périmètre — pas de réponse automatique » + boutons « Répondre avec l'assistant quand même » (une réponse, déclenchée par un humain, sur le dernier message) et « Ajouter ce contact au périmètre » (liste « toujours »). Un changement de mode ou de liste réévalue les conversations ; une réponse différée (délai de réponse) est revérifiée au moment de l'envoi.
Inchangés : « STOP » / « REPRENDRE », exclusions du Suivi de l'IA, brouillons à valider, promptguard, plafonds et limites de débit (y compris plafonds d'envoi QR).

## Données (migrations 143 à 145, `src/migrations/wa-portee.js`)
`wa_scope_settings` (mode, surcharges meta/qr, mots-clés) · `wa_scope_exceptions` (toujours/jamais par numéro) · `wa_contact_origin` (source ad/organic/import/manual, annonce, campagne, dates) · `wa_chat_scope` (état par conversation) · `wa_scope_log` (audit : qui, quand, quoi ; numéros tronqués aux 4 derniers chiffres). Toutes les tables portent `org_id` avec suppression en cascade ; chaque route filtre par organisation.
Statistiques : la source du prospect du module Commercial passe à `ad` (avec campagne/annonce) quand l'origine est « publicité » (`syncChats` et mise à jour des prospects existants).

## API (`/api/ws/orgs/:id/wa-scope`)
`GET /` (responsable) · `PUT /` (admin : `mode`, `modeMeta`, `modeQr`, `keywords`) · `POST /exceptions`, `DELETE /exceptions/:id` (admin) · `PUT /origin` (responsable) · `POST /import` (admin, 500 max) · `POST /chats/:id/reply-anyway`, `POST /chats/:id/add-to-scope` (responsable). `GET /sales/chats` ajoute `outOfScope` et `scopeReason` ; `GET /sales/chats/:id` ajoute `scope`.

## Tests
`npm run test:waportee` (100 contrôles : publicité reçue / organique / client existant / prospect / listes / changement de mode en cours de conversation y compris réponse différée / webhook officiel signé avec faux serveur Meta / canal QR avec bibliothèque simulée / isolation / audit) ; `test:migrations` mis à jour (145 migrations).

## Limites connues
- WhatsApp Web ne fournit pas toujours la source de l'annonce : le **mot-clé / #campagne** est la solution de repli. La détection `externalAdReply` repose sur le format observé de Baileys, non vérifié contre une vraie annonce.
- Le champ `referral` de Meta ne donne pas l'identifiant de campagne, seulement celui de l'annonce et son titre.
- Les relances automatiques (suivi, factures, cadences du module Commercial) ne sont pas filtrées par la portée : elles gardent leurs règles actuelles. Messenger et Instagram ne sont pas concernés (WhatsApp seulement).
- Le mot-clé ne vaut que pour le message d'entrée d'un contact encore inconnu ; un contact connu avant l'activation est « organique » tant qu'il n'est pas marqué.
- La barre « L'IA répond normalement à ce contact » du Suivi de l'IA ne tient pas compte de la portée ; l'étiquette orange au-dessus fait foi.
- La portée n'est pas affichée dans « Mes conversations » ni dans le tableau du Suivi de l'IA.
