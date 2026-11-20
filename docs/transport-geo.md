# Transport · géolocalisation et clients / fournisseurs typés

Branche `transport-geo` (serveur et site), partie de `fusion-modules`. Ce document décrit ce qui a été ajouté au module Transport (TMS) et à la gestion des clients et fournisseurs, comment c'est calculé, ce qui est protégé, et comment le vérifier.

## 1. En deux mots

* **Carte** (Leaflet + fonds OpenStreetMap, gratuits, mention d'attribution affichée sur la carte) : le client, tous les transporteurs de l'entreprise, le dépôt. **Point vert ✓ = disponible, point rouge ✕ = indisponible** (le signe double la couleur), contour en pointillé = position ancienne. Légende et filtres (tous / disponibles / indisponibles, positions récentes seulement). Distance et durée estimées entre chaque transporteur et le client.
* **Deux recommandations chiffrées** (distance, disponibilité, capacité et charge, coût estimé, fiabilité historique, délai estimé). Le responsable choisit ; l'affectation **crée (ou complète) la tournée existante** du Transport.
* **Position du client** : adresse saisie (recherche OpenStreetMap à la demande), point posé sur la carte, ou position GPS partagée depuis son téléphone **avec consentement** (lien secret envoyé par WhatsApp : page publique `/localiser/:jeton`).
* **Position des transporteurs** : envoyée depuis leur téléphone (écran « Ma position », consentement explicite, mise à jour périodique tant que la page est ouverte) ou saisie à la main par un responsable. L'âge de la position est affiché ; une position ancienne est signalée, une position trop ancienne est masquée.
* **Clients et fournisseurs typés** : simple, temporaire (avec date de fin), permanent, haut de gamme (VIP), avec conditions propres au type, historique des changements, notes, étiquettes, recherche, filtres, import / export CSV, carte. Les fiches sont **celles des tables existantes** `customers` et `suppliers` (aucune duplication).

Aucun service de cartes payant, aucune clé : les distances sont à vol d'oiseau × coefficient routier (réglage existant du Transport, 1,3 par défaut), la durée est la distance ÷ la vitesse moyenne (réglage existant, 30 km/h par défaut).

## 2. Migrations (numéros 140 et 141)

Le numéro d'une migration est sa position dans le tableau `MIGRATIONS` (`schema_migrations.version`). Le module Avis occupe la 116. Pour qu'aucune migration ne bouge quand les deux branches seront réunies, `src/db.js` complète le tableau par des migrations vides (`SELECT n AS reserve`) jusqu'à la position 139 puis ajoute `src/migrations/transport-geo.js` :

| N° | Contenu |
|---|---|
| 140 | `tg_settings`, `tg_driver`, `tg_positions`, `tg_requests`, `tg_audit` + 3 colonnes de `logistics_deliveries` (`geo_source`, `geo_at`, `geo_accuracy`) |
| 141 | `pty_terms`, `pty_type_log`, `pty_notes` + colonnes additives sur `customers` et `suppliers` (`party_type`, `valid_until`, `lat`, `lng`, `geo_source`, `geo_at`, `tags`, `party_status`, `pty_discount`, `pty_pay_days`, `pty_delivery_days`, `pty_credit_limit`, `type_changed_at`) |

Aucune migration existante n'est modifiée ; tout est `IF NOT EXISTS` (rejouable, vérifié par `test-migrations.js`).
Important pour la fusion avec Avis : la ligne `MIGRATIONS.push(...require('./migrations/avis'))` doit être **avant** le bloc « Transport · géolocalisation » de `src/db.js` (sinon Avis passerait en position 140+).

## 3. Statut d'un transporteur (vert / rouge)

Un « transporteur » est une fiche **chauffeur** existante (`logistics_drivers`), avec son véhicule habituel (`tg_driver.vehicle_id`, sinon le véhicule de sa tournée du jour). Ordre de priorité :

1. **Blocage réel** → rouge, *hors service* : fiche en pause, véhicule hors parc ou en maintenance, assurance / visite technique du véhicule périmée, permis périmé. Aucun statut manuel ne le contourne.
2. **Statut manuel** (responsable, avec motif et fin facultative) : *absent*, *hors service*, *chargement plein*, *en mission* → rouge ; *disponible* → vert (forcé).
3. **En mission** : une tournée du jour en cours → rouge.
4. **Chargement plein** : poids, volume ou palettes déjà affectés aujourd'hui ≥ capacité du véhicule → rouge.
5. Sinon → **vert**.

Un véhicule déjà pris le même jour par la tournée d'un autre chauffeur est signalé (« son véhicule est déjà pris ») et le transporteur n'est pas recommandé.

## 4. Position : âge, affichage, conservation

* `ageMin` = minutes depuis la dernière position. Au-delà de **30 min** (réglage `staleMin`) : *ancienne*, affichée en pointillé avec un avertissement, et −15 points au score. Au-delà de **240 min** (`lostMin`) : *masquée*, jamais recommandée.
* Une position envoyée depuis un téléphone n'est **affichée que** si le transporteur a donné son accord **et** est en service (ou en tournée). Hors service : « non suivi ». Une position saisie à la main par un responsable est affichée tant qu'elle n'est pas trop ancienne.
* Le service (début / fin) est activé par le transporteur ; il s'arrête tout seul après `shiftMaxH` (12 h).
* Les positions sont **supprimées après `retentionDays` (14 jours par défaut, 1 à 90)** par la tâche horaire (`src/jobs.js`) et à chaque réception ; la dernière position est effacée avec elles.

## 5. Les deux recommandations (formules)

Pour chaque transporteur **disponible**, avec une position affichée, un véhicule libre ce jour-là, et dont la charge **tient** dans le véhicule (poids, volume, palettes ; capacité non renseignée = on ne bloque pas) :

* trajet jusqu'au client : `km = arrondi1(haversine × coefficient routier)`, `durée = max(1, arrondi(km ÷ vitesse × 60))` min ;
* coût estimé : `(km aller + km retour du client au dépôt, ou le même trajet s'il n'y a pas de dépôt) × coût au km du véhicule + indemnité journalière du chauffeur` (indemnité comptée seulement s'il n'a pas déjà une tournée ce jour) ;
* fiabilité : livraisons réussies ÷ (réussies + échecs + retours) sur 90 jours ; moins de 3 livraisons → 75 % « peu d'historique » ;
* capacité : 0,6 si inconnue, sinon `0,7 + 0,3 × (1 − part de la capacité occupée après ajout)`.

Chaque critère est ramené entre 0 et 1 face au meilleur candidat (`meilleur ÷ valeur`), puis :

`score = 100 × (0,30 distance + 0,15 délai + 0,20 coût + 0,20 fiabilité + 0,15 charge) − 15 si position ancienne`

Les deux meilleurs scores sont proposés (rang 1 et 2) avec leur justificatif chiffré. Les tests recalculent ces valeurs à la main (`scripts/test-tms-geo.js`). Le justificatif affiché au moment du choix (rang, score, chiffres) est conservé dans le journal d'audit.

## 6. Affectation

`POST /logistics/tms/geo/assign { deliveryId, driverId, date?, startTime?, vehicleId? }` (responsable) :

* contrôles existants du Transport (`assignment()` : véhicule actif, papiers à jour, pas deux tournées le même jour) ;
* si le transporteur a déjà une tournée **prévue ou répartie** ce jour-là, la livraison s'y ajoute (ordre de passage recalculé) ; s'il est **en tournée**, refus (409) ; sinon une **nouvelle tournée** est créée (`logistics_rounds`, état « planifiée », coût estimé enregistré) ;
* un événement est ajouté à l'historique de la livraison et une ligne `assign` au journal d'audit.

## 7. Vie privée

| Exigence | Réalisation |
|---|---|
| Suivi limité aux transporteurs de l'entreprise | seules les fiches `logistics_drivers` de l'organisation ; toutes les routes sont sous `/orgs/:orgId` (404 pour une autre entreprise) ; la carte est réservée aux responsables |
| Heures de mission seulement | pas d'envoi ni d'affichage hors service ou hors tournée (403) ; fin de service automatique |
| Consentement explicite | case + bouton « J'accepte » avec finalité, durée, personnes qui voient ; retrait à tout moment (efface l'historique et arrête le service) |
| Conservation limitée | purge automatique (14 j par défaut) ; effacement manuel par le transporteur ou un responsable |
| Journal d'audit | `tg_audit` : consentements, service, positions saisies, consultations de la carte (nombre de points, jamais de coordonnées), demandes et réponses des clients, affectations (avec justificatif), purge, réglages ; conservé 1 an ; lisible par les administrateurs |
| Isolation par entreprise | tests inter-entreprises dans `test-tms-geo.js` et `test-parties.js` ; routes publiques en liste blanche (`test-security-routes.js`) |
| Client | lien secret de 48 caractères hexadécimaux, 48 h, débit limité ; la page publique ne montre que la boutique et le prénom ; GPS seulement après case cochée ; recherche d'adresse (OpenStreetMap/Nominatim) seulement sur clic, avec avis que l'adresse lui est transmise |

## 8. Routes

Toutes sous `/api/ws/orgs/:orgId` (sauf mention) :

| Route | Rôle | Usage |
|---|---|---|
| `GET /logistics/tms/geo/map?deliveryId&date` | responsable | carte du client + transporteurs + 2 recommandations |
| `GET /logistics/tms/geo/fleet` | responsable | carte sans livraison |
| `POST /logistics/tms/geo/assign` | responsable | affectation → tournée |
| `PUT /logistics/tms/geo/deliveries/:id/location` | membre | position du client (adresse, point, saisie) |
| `POST/GET /logistics/tms/geo/requests`, `POST …/:id/cancel` | membre | lien de localisation du client |
| `GET/PUT /logistics/tms/geo/settings` | lecture membre, écriture admin | réglages |
| `GET /logistics/tms/geo/drivers`, `PUT …/drivers/:id`, `POST …/drivers/:id/position`, `DELETE …/drivers/:id/history` | responsable | fiches des transporteurs |
| `GET /logistics/tms/geo/me`, `POST …/me/consent`, `…/me/shift`, `…/me/position`, `DELETE …/me/history` | le transporteur | page « Ma position » |
| `GET /logistics/tms/geo/audit`, `POST …/purge` | admin | audit, purge |
| `GET/POST /api/ws/public/geo/:jeton` | public (jeton) | page du client |
| `GET /parties/types`, `PUT /parties/terms/:kind/:type` | membre / responsable | types et conditions |
| `GET/POST /parties/:kind` (`customers`, `suppliers`), `GET/PUT /parties/:kind/:id` | membre (clients), responsable (fournisseurs) | liste filtrée, fiche |
| `POST /parties/:kind/:id/type`, `…/location`, `…/notes`, `…/apply-terms` | responsable pour type et conditions | changement de type, position, notes, report des conditions |
| `GET /parties/:kind/export.csv`, `POST /parties/:kind/import` (`dryRun`), `POST /parties/:kind/revert-expired` | responsable | CSV, temporaires expirés |

## 9. Clients et fournisseurs typés

* **Types** : `simple`, `temporary` (date de fin obligatoire, date future), `permanent`, `vip`. Un temporaire dont la date est passée est signalé « expiré » (filtre dédié) ; le bouton « Ramener à simple » les convertit avec trace.
* **Fiche** : coordonnées, adresse géolocalisable (point sur la carte, recherche d'adresse), N° contribuable, secteur / catégorie, étiquettes, statut (actif, inactif, archivé ; *bloqué* pour un fournisseur = champ existant `blocked`), notes datées, historique des changements de type (de, vers, fin de validité, motif, auteur).
* **Conditions** : remise, délai de paiement, délai de livraison, plafond de crédit. Ordre : valeur de la fiche, sinon valeur du **type** (réglée par un responsable, vide tant qu'elle n'est pas réglée : rien n'est inventé), sinon ancien champ (remise par défaut du client, délai de paiement du fournisseur). Pour un fournisseur, le délai de paiement de la fiche **est** `suppliers.payment_days` (le même champ que dans Achats).
* **Liens sans duplication** : la fiche lit les factures et devis (Clients et ventes), les contacts et opportunités (Commercial), les livraisons (Transport), les commandes et factures d'achat (Achats), l'escompte (`tre_terms`, Trésorerie). Le bouton « Appliquer » reporte la remise effective dans `customers.default_discount` (utilisé pour les devis et factures) ou le délai dans `suppliers.payment_days` (utilisé par les achats).
* **CSV** : export (BOM, `;`, protection contre l'injection de formule) ; import (séparateur `;` ou `,`, guillemets, simulation `dryRun`, lignes refusées listées avec leur numéro, mise à jour d'une fiche de même nom, 2 000 lignes au plus).
* Nouveau module `parties` (« Clients et fournisseurs ») dans le menu ; les écrans Clients et ventes et Achats continuent de fonctionner sur les mêmes tables.

## 10. Tests

| Script | Contenu |
|---|---|
| `node scripts/test-tms-geo.js` | statuts, distances, scores recalculés, fiabilité, ancienneté, consentement, service, conservation, audit, lien client, affectation, isolation |
| `node scripts/test-parties.js` | types, conditions, historique, expirés, CSV, liens, rôles, isolation |
| `node scripts/test-migrations.js` | numéros 140 / 141, rejouabilité |
| `node scripts/test-security-routes.js` | routes publiques en liste blanche, isolation sur toutes les routes |

Ajoutés à `npm run test:chain` (`test:tmsgeo`, `test:parties`). Côté site : `node scripts/i18n-check.mjs` (FR / EN / DE / ES).

## 11. Limites connues

* La distance est à vol d'oiseau × coefficient (pas de calcul d'itinéraire réel : pas de service payant). La durée est une estimation à vitesse moyenne constante.
* Un navigateur n'envoie pas la position en arrière-plan : la page « Ma position » doit rester ouverte pendant le service (avis affiché au transporteur).
* La recherche d'adresse passe par le service public Nominatim d'OpenStreetMap (limites d'usage : une requête par clic, jamais en arrière-plan). Sans elle, le point se pose à la main.
* La fiabilité utilise les livraisons des tournées des 90 derniers jours ; sans historique elle vaut 75 % (signalé).
