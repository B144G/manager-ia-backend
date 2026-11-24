# Paiement automatique par Campay (MTN Mobile Money + Orange Money)

MABAH encaisse les abonnements par **Campay** (campay.net) : le client saisit son numéro Mobile Money, reçoit l'invite sur son téléphone, confirme avec son code secret, et l'abonnement s'active tout seul. Le code est prêt pour la **démonstration** (demo.campay.net) et bascule en **réel** en changeant uniquement des variables d'environnement.

Sans les variables ci-dessous, le paiement reste en mode « manuel » (ID de transaction validé par l'administrateur) : rien n'est cassé.

## 1. Variables d'environnement à saisir dans Render (vous les saisissez vous-même)

Ne les écrivez jamais dans le code, un fichier du dépôt, un e-mail ou une conversation.

| Variable | Rôle | Obligatoire |
|---|---|---|
| `CAMPAY_MODE` | `test` (défaut, démonstration, **aucun argent réel**) ou `reel` | non (défaut `test`) |
| `CAMPAY_APP_USERNAME` | nom d'utilisateur d'application Campay (page de votre application) | oui, avec le mot de passe… |
| `CAMPAY_APP_PASSWORD` | mot de passe d'application Campay | …ou le jeton permanent ci-dessous |
| `CAMPAY_APP_TOKEN` | jeton permanent (section « APP KEYS » de l'application) : alternative au couple nom/mot de passe | alternative |
| `CAMPAY_WEBHOOK_KEY` | clé du webhook de l'application (signe les rappels de Campay) | oui (obligatoire en mode `reel`) |
| `CAMPAY_BASE_URL` | adresse de l'API ; déduite du mode : `https://demo.campay.net/api` (test) ou `https://www.campay.net/api` (réel) | non (surcharge) |
| `CAMPAY_PENDING_TTL_MIN` | minutes avant qu'une demande sans réponse passe à « expiré » (défaut 10) | non |
| `CAMPAY_RECONCILE_AFTER_MIN` | la réconciliation revérifie les paiements en attente depuis plus de N minutes (défaut 3) | non |
| `CAMPAY_FAIL_ALERT_COUNT` | échecs d'un même client en 24 h avant l'alerte e-mail à l'administrateur (défaut 3) | non |
| `CAMPAY_WEBHOOK_RATE` | webhooks acceptés par minute et par adresse (défaut 120) | non |

- Les anciens noms `CAMPAY_USERNAME` / `CAMPAY_PASSWORD` restent acceptés.
- **Le serveur refuse de démarrer en `CAMPAY_MODE=reel`** si les identifiants ou `CAMPAY_WEBHOOK_KEY` manquent (message clair, sans afficher de valeur). Une valeur de `CAMPAY_MODE` autre que `test`/`reel` est refusée aussi.
- Prérequis déjà en place : e-mail administrateur (`ADMIN_EMAIL` + SMTP/Brevo) pour les alertes ; `DATA_KEY` et `STRICT_PROD_CONFIG` inchangés. Les clés Campay vivent uniquement dans les variables d'environnement (jamais en base, jamais envoyées au navigateur) ; les numéros de téléphone des paiements automatiques sont **masqués** (`237 6** *** 777`) dans la base, les listes, les journaux et l'audit.
- Attention : un serveur qui avait déjà `CAMPAY_USERNAME`/`CAMPAY_PASSWORD` sans `CAMPAY_MODE` passe désormais en **mode test (démonstration)** : ajoutez `CAMPAY_MODE=reel` (et la clé de webhook) le jour du passage en production.

## 2. URL du webhook à déclarer chez Campay

Dans votre application Campay, champ « Callback URL » (méthode **POST** conseillée ; GET fonctionne aussi) :

```
https://<adresse publique du serveur Render>/api/payments/webhook/campay
```

(La valeur exacte est affichée dans Administration > Paiements, bandeau en haut de page.) Campay envoie le rappel **une seule fois** et ne le renvoie pas : si le rappel est perdu, la réconciliation (toutes les minutes) retrouve le paiement.

Comment le serveur traite un rappel : signature JWT HS256 vérifiée avec `CAMPAY_WEBHOOK_KEY` → rejeu bloqué (empreinte de la signature) → commande retrouvée par la référence Campay → **statut relu chez Campay** (le contenu du rappel n'est jamais cru) → contrôle de la référence, de la référence externe, du montant et de la devise → activation idempotente. Écart = paiement bloqué « Encaissé : à vérifier » + alerte critique à l'administrateur, **rien n'est activé**.

## 3. Passage test → réel

1. Dossier « Go Live » accepté chez Campay ; créez l'application **de production** et notez ses identifiants et sa clé de webhook.
2. Dans Render, remplacez `CAMPAY_APP_USERNAME`, `CAMPAY_APP_PASSWORD` (ou `CAMPAY_APP_TOKEN`), `CAMPAY_WEBHOOK_KEY` par ceux de la production ; passez `CAMPAY_MODE=reel`. Ne mettez pas `CAMPAY_BASE_URL` (sinon vérifiez qu'elle pointe sur la production).
3. Déclarez l'URL du webhook (section 2) dans l'application de production.
4. Redéployez. Le bandeau rouge « MODE TEST : aucun argent réel » doit **disparaître** de l'administration et de l'écran de paiement.
5. Faites un premier paiement du plus petit montant avec votre propre numéro, vérifiez : activation, reçu, e-mail, ligne dans Administration > Paiements (sans mention TEST).
6. Les paiements faits en mode test restent marqués « TEST » (colonne `test_mode`), exclus du total « Encaissé (réel) ».

## 4. Check-list de recette en mode démonstration

Numéros de test de la documentation Campay (seuls autorisés en démo) :

| Numéro | Opérateur | Résultat |
|---|---|---|
| 237677777777 | MTN | PENDING puis SUCCESSFUL |
| 237677777770 | MTN | PENDING puis FAILED |
| 237699999999 | Orange | PENDING puis SUCCESSFUL |
| 237699999990 | Orange | PENDING puis FAILED |

Dans l'interface, saisissez `677777777`, `677777770`, `699999999`, `699999990`. Montant : celui du plan choisi (Illimité 1 mois = 80 000 FCFA ; la démo n'impose pas de montant précis).

- [ ] Bandeau rouge « MODE TEST : aucun argent réel » visible dans l'administration, sur Mon abonnement et dans la fenêtre de paiement.
- [ ] MTN réussit (677777777) : écran d'attente avec compte à rebours → « Paiement reçu », offre active, date d'échéance correcte, reçu numéroté (marqué TEST), e-mail [TEST] avec reçu en pièce jointe.
- [ ] Orange réussit (699999999) : idem.
- [ ] MTN échoue (677777770) : message « n'a pas abouti », bouton « Nouvelle tentative » ; 3 échecs en 24 h → e-mail d'alerte à l'administrateur.
- [ ] Numéro inconnu (ex. 677777701) : reste en attente puis passe à « Expiré » après 10 minutes ; nouvelle tentative possible.
- [ ] Renouvellement avec des jours restants : les jours s'ajoutent (10 restants + 30 = 40).
- [ ] Double clic sur « Payer » : une seule demande.
- [ ] Administration > Paiements : filtres statut/opérateur/dates, totaux, paiement « bloqué » signalé, « Revérifier chez Campay », « Activer manuellement » (motif obligatoire, visible dans le journal d'audit).
- [ ] Webhook : dans l'application Campay (démo), « renvoyer le rappel » sur une transaction : aucun effet en double.
- [ ] Journal d'audit : `payment.initiated`, `payment.paid`, `payment.webhook_rejected` (test avec une signature fausse), etc.

Sans compte, tout se teste en local contre le faux serveur : `npm run test:campay` (tests automatiques) ou `DEMO_CAMPAY=1 node scripts/demo-local.js` (parcours visuel avec le site : `npm run dev`, compte `client.paiement@exemple.com`). Le faux serveur seul : `node scripts/mock-campay.js`.

## 5. Ce qui a été vérifié dans la documentation Campay, et ce qui ne l'est pas

Lu le 18/11/2026 dans la collection Postman officielle « CamPay API » : jeton (`POST /token/` {username, password} → {token, expires_in}, en-tête `Authorization: Token …`, jeton permanent possible), `POST /collect/` ({amount, currency, from, description, external_reference, external_user} → {reference, ussd_code, operator}, `external_reference` = UUID4 unique, idempotent), `GET /transaction/{reference}/` (PENDING / SUCCESSFUL / FAILED), webhook (GET ou POST, champ `signature` = JWT HS256 signé avec la clé du webhook, envoyé une fois), numéros de test, codes ER101/ER102/ER201/ER301.

**Non vérifié (à confirmer à l'ouverture du compte réel)** :
- l'adresse de l'API de production (`https://www.campay.net/api` est la valeur du code existant ; la documentation ne montre que la démo) ;
- le contenu (claims) du JWT du webhook : seule la validité de la signature est contrôlée, le reste vient de la relecture de la transaction ;
- la durée pendant laquelle une demande reste valable côté opérateur (le délai `CAMPAY_PENDING_TTL_MIN` est le nôtre ; une confirmation tardive est quand même prise en compte par la réconciliation pendant 24 h) ;
- le montant minimal, les frais éventuels ajoutés au montant, la forme exacte des corps d'erreur HTTP (le code cherche `ERxxx` dans la réponse) ;
- que `amount` de la transaction soit bien le montant demandé (la documentation fournit `app_amount` pour le net après frais) : si Campay renvoyait un autre montant, les paiements seraient bloqués « à vérifier » plutôt qu'activés à tort.

## 6. Limites connues

- Un seul paiement automatique en attente par client à la fois ; changer d'offre pendant un paiement en cours est refusé (409).
- Si la réponse de Campay à la demande se perd, la demande est réessayée une fois avec la même référence externe (idempotente chez Campay) ; au pire le client paie sans activation : l'administrateur le voit dans la liste et active à la main.
- Paiement encaissé mais activation impossible (changement d'offre en cours d'abonnement, par exemple) : statut « Encaissé : à vérifier », alerte à l'administrateur ; à lui d'activer ou de rembourser (aucun remboursement automatique).
- Pas de prélèvement récurrent : chaque période se paie (ou se renouvelle) à la demande ; les rappels d'échéance existants restent en place.
- Les anciens tableaux de bord de revenus (vue d'ensemble) additionnent encore les paiements de test ; l'écran Paiements, lui, sépare « réel » et « test ».
- Reçu = document de travail numéroté (`R-AAAA-NNNNN`), pas une facture fiscale.
- L'opérateur choisi par le client sert d'indication ; l'opérateur enregistré est celui renvoyé par Campay.

## 7. Paiement manuel de secours (« Mobile Money direct, confirmé par l'administrateur »)

Même table de transactions (`payments`), mêmes reçus, même activation/prolongation que Campay (`markPaid`) : une seule source de vérité.

**Variables (Render, saisies par vous)**

| Variable | Rôle |
|---|---|
| `MANUAL_PAY_ENABLED` | `1` pour activer, `0` pour couper. Absente : actif seulement si Campay n'est pas configuré (comportement d'origine). Quand Campay est actif (même en mode réel), le manuel n'est proposé en alternative que si `MANUAL_PAY_ENABLED=1`. |
| `MANUAL_PAY_MTN_NUMBER` | numéro de réception MTN Mobile Money de l'entreprise |
| `MANUAL_PAY_ORANGE_NUMBER` | numéro de réception Orange Money |
| `MANUAL_PAY_ACCOUNT_NAME` | nom du titulaire des comptes |
| `MANUAL_PAY_TTL_HOURS` | validité d'une commande non soumise (défaut 48) |
| `MANUAL_PAY_MAX_ATTEMPTS` | soumissions d'identifiant par commande (défaut 5) |

(Les anciens `MTN_NUMBER`, `ORANGE_NUMBER`, `PAYMENT_HOLDER_NAME` restent acceptés.) Le mode manuel ne s'affiche **que si au moins un numéro est configuré**.

**Parcours client** : choix du plan (le serveur calcule le montant) → commande « en attente » avec un code `MABAH-NNNNNN` (tiré au hasard côté serveur, unique) → l'écran affiche les numéros MTN / Orange, le nom du compte, le montant exact et le code → le client paie depuis son téléphone → il saisit le **nom du payeur** et l'**identifiant de transaction** du SMS → « J'ai payé » → la commande passe « à vérifier » et vous recevez un e-mail (notify). Un identifiant déjà utilisé est refusé (anti-rejeu, insensible à la casse et aux séparateurs), les soumissions sont limitées par commande, une commande jamais soumise expire.

**Procédure de vérification du SMS (administrateur)** : Administration > Paiements > onglet « À vérifier ». Comparez avec le SMS ou le relevé de votre compte Mobile Money : (1) l'identifiant de transaction est identique, (2) le montant reçu est exactement celui de la commande, (3) le nom/numéro de l'expéditeur correspond au payeur indiqué, (4) le motif du transfert contient le code `MABAH-…`. Puis **Valider** (active l'offre, ajoute les jours sans en perdre, envoie le reçu au client) ou **Refuser** (motif obligatoire, le client est prévenu et peut refaire une commande ; l'identifiant refusé ne peut pas être réutilisé). Chaque décision est dans le journal d'audit avec le nom de l'administrateur.

**Limites** : la vérification est humaine (aucun contrôle automatique du SMS) ; un administrateur qui valide sans vérifier peut activer à tort — d'où le motif obligatoire au refus et la trace d'audit ; le numéro du payeur, facultatif, est masqué en base ; pas de rapprochement automatique avec un relevé.
