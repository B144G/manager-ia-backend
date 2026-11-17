# Matrice de fusion — module ENTREPÔT / WMS

Couche retenue : celle de A (`wms-core.js`, `wms.js`, `wms-*.js`, tables `wms_*` de A, `stock-lib.adjust()` → `wms-core.reconcile()`).
Le code de B (`wms-lib.js`, `stock-wms*.js`) n'est PAS monté tel quel (routes et tables en double) : ses capacités sont portées sur le schéma de A.
Test de B : `scripts/test-stock-wms.js` (456 contrôles ; 445 avant le gel du bloc « vagues/palettes/colisage », voir plus bas), adapté à A. Entrée unique : `node scripts/test-stock-wms.js`.
Légende décision : GA = garder A ; PBA = porter B sur A ; R = réunir (A étendu) ; BM = capacité de B montée sous `/stock/wms/b/…` (forme de B) ; NP = non porté.

| Fonction | A ? | B ? | Décision | Test qui la prouve |
|---|---|---|---|---|
| Entrepôts / zones / emplacements (CRUD, création en série, scan) | oui | oui | R : validation stricte de B (type de zone/emplacement inconnu → 400, « En transit » non choisissable), type d'emplacement déduit de la zone, `PUT/DELETE /zones/:id`, `PUT /locations/:id` étendu (code, position, zone, type), lookup enrichi (détail + contenu) | test-stock-wms (lot 1) |
| Capacité d'un emplacement | colonne seule | appliquée | PBA : `wms-core.add()` refuse une entrée au-delà (400 « plein ») ; capacité < contenu → 409 | test-stock-wms (lot 1) |
| Désactiver / supprimer un emplacement ou un entrepôt qui contient du stock | non | 409 | PBA (409) | test-stock-wms (lot 1) |
| Antennes (branch) : membre limité à son entrepôt + commun | non | oui | PBA : `overview`, `zones`, `locations`, `locationFor()` (404 hors antenne) | test-stock-wms (lot 1) |
| Règles de rangement, `putaway-suggest` | règles + `pending` | règles + `putaway-suggest` | R : `GET /putaway-suggest` ajouté ; `POST /putaway` accepte `quantity` (rangement partiel). A garde 400 « choisissez la destination » quand aucune règle (B rangeait au défaut : tranché A) | test-stock-wms (lots 1, 7), test-wms |
| Contrôle de cohérence `/integrity` | non | oui | PBA | test-stock-wms (lot 1) |
| Déplacement interne `/move` | oui | oui | R : garde « stock réservé » (409) vers un emplacement non disponible / un autre entrepôt réservé, `lotId` et `serials` | test-stock-wms (lots 3, 11) |
| Transferts entre entrepôts (demande, expédition en transit, réception, écarts, annulation, journal) | oui | oui | R : transfert entre deux emplacements d'un même entrepôt (colonnes `from/to_location_id` des lignes), quantité expédiée ≤ demandée, quantité reçue ≤ expédiée, motif d'écart obligatoire, emplacement d'arrivée choisi, `gapQty/gapValue` au niveau du transfert. Code `TR-0001` (A) et 400 (A) gardés | test-stock-wms (lot 2), test-wms |
| Réservations (commande, devis, demande interne, libre) | oui | oui | R : libération automatique à l'annulation / au refus / à la **suppression** du document (à chaque calcul de disponibilité, `expireReservations`) ; `GET /documents/:id/reservations` ; filtre `itemId` (tous statuts) ; `partial:false` = tout ou rien ; `ignoredLines` ; réponse de `fulfill` enrichie | test-stock-wms (lot 3) |
| Réservations PAR ENTREPÔT | non | oui | PBA : colonne `wms_reservations.warehouse_id`, `usable/reserved/available` par entrepôt (`/items/:id/availability.warehouses`), gardes `whGuard` sur sorties, déplacements et transferts, `fulfill` avec `locationId` | test-stock-wms (fin) |
| Livraison liée à une commande consomme la réservation | non | oui | PBA : `stock-lib.adjust` (`refKind: 'delivery'`) → `wms-core.consumeDocReservations` | test-stock-wms (lot 3) |
| Disponible à promettre = utilisable − réservé, `reserved/available` dans la liste des articles | oui | oui | GA (+ `short`, `available` ≥ 0 dans la route de disponibilité) | test-stock-wms (lot 3), test-wave1-stock |
| Retours client / fournisseur / rebut, décision sur marchandise à contrôler | oui (+ RMA, avoir fournisseur) | oui | R : retour client limité à la quantité vendue (cumul), retour fournisseur lié à une commande du module Stock (`orderId`) limité à la quantité reçue, lot exigé, stock réservé non rendable (409), destination de remise en stock contrôlée, codes de motifs de B acceptés en plus, `status` en filtre, valeurs/avoir cachés à un membre, `creditedAt` | test-stock-wms (lot 4), test-wms, test-wms4d |
| Réceptions et coûts d'arrivée (landed costs) | oui (`wms_receipt_costs`) | oui | R : validation stricte (type/base inconnus, montant nul → 400), `costs` dans la réponse, journal `stock_moves` « landed_cost » à la création, part de chaque coût par ligne (`wms_landed_alloc`) → `incorporated/expensed` par ligne et par coût, verrou d'article (3 coûts simultanés), `from-purchase` accepte `purchaseReceiptId` | test-stock-wms (lot 5), test-purchasing |
| Classement ABC | oui | oui | R : `totalConsumption`, `totalStockValue`, `since`, `consumption/stockShare` par classe ; `POST /abc/refresh` (table `wms_item_class`) | test-stock-wms (lot 6), test-wms4e |
| Inventaires tournants par classe | oui | oui | R : classe inconnue → 400, `limit`, `cycle_class` mémorisé et exposé, plan avec `due` et `nextDue`, écarts par classe (`lines`, `withGap`, `shortValue`) | test-stock-wms (lot 6) |
| Inventaire PAR EMPLACEMENT + comptage à l'AVEUGLE | non | oui | PBA : `POST /location-counts` (+ `/:id/lines`), colonnes `stock_counts.location_id/blind/cycle_class`, `stock.js` cache attendu/écart tant que le comptage est ouvert, validation → ajuste CET emplacement (lots compris) | test-stock-wms (fin) |
| Lots et numéros de série PAR EMPLACEMENT | non | oui | PBA : table `wms_lot_levels`, `stock_serials.location_id`, `wms-track.js` porté sur `wms_stock`, intégré à `stock-lib.adjust` (sortie FEFO/FIFO là où est le lot, préférence de lot conservée), aux déplacements et aux inventaires ; `GET /items/:id/tracking` ; reconstruction automatique (`sync`) | test-stock-wms (lot 11) |
| Historique des mouvements par emplacement | non | oui | PBA : `stock_moves.location_id` (une ligne par emplacement touché, somme des deltas inchangée), `wms_moves.unit_value` | test-stock-wms (lot 10), test-acc-stock |
| Listes de préparation (picks) | oui (PR-, vagues, dépose, expédition) | oui | R : `strict` (tout ou rien, 409), verrou d'article (course entre listes), `POST /picks/:id/start`, `warehouseId` inconnu → 404, `waiting`, `priorityLabel`, quantité > reste → 400. Codes `PR-0001`, 400 d'état gardés | test-stock-wms (lot 7), test-wms4c |
| Vagues de préparation | oui (wms-waves, plus riche) | oui | GA ; test de B conservé mais désactivé (voir « non porté ») | test-wms4c |
| Palettes / cartons / colisage | oui (wms-hu, wms-ship) | oui (`wms_units`, `wms_packages`) | GA ; B non porté | test-hu, test-wms4c |
| Prévision (moyenne mobile, indice saisonnier), `forecast/:id` | oui (forme A) | oui | BM : `/b/forecast`, `/b/forecast/:id` | test-stock-wms (lot 8) |
| Réapprovisionnement (point de commande, stock de sécurité, délai fournisseur, multiple) | oui (wms-replen + `/reorder`) | oui | BM : `/b/reorder`, `/b/items/:id/params` (A inchangé) | test-stock-wms (lot 8) |
| États : valorisation par emplacement, rotation, ruptures, vieillissement, journal | oui (forme A) | oui | BM : `/b/reports/*` (+ CSV `?format=csv`) | test-stock-wms (lot 10) |
| Résolution des codes scannés | oui (`/scan`) | oui | BM : `/b/scan` (A inchangé ; reconnaît aussi PR-, RT-, RC-, VG-, palettes) | test-stock-wms (lot 10) |
| Lien comptabilité (valeur du stock) et Achats | oui | oui | GA : `acc-stock` lit toujours `stock_items` / `stock_moves` | test-acc-stock, test-acc-stock-ecritures, test-purchasing |
| Suppression d'une organisation | cascade | cascade | R : clés étrangères sans CASCADE rendues « différées » (migration) — la suppression complète d'une organisation avec transferts/listes/retours/réceptions échouait (500) | test-stock-wms (dernier bloc), test-security-privacy |
| Messages d'erreur « traduisibles » (~71 modèles) | — | — | NP : aucun mécanisme de traduction trouvé côté serveur dans le code d'entrepôt de B (`wms-track.js` = lots/séries, pas des messages). Messages en français fixes, sans variables superflues | — |

## Adaptations du test de B (aucune n'affaiblit une vérification : elles suivent le comportement de A, tranché)
- Tables : `wms_levels` → `wms_stock` ; la reprise de données de la migration de B est remplacée par la reprise de `wms-core.ensure()` (réglages effacés → ré-initialisation).
- Codes : entrepôt par défaut `PRINCIPAL` (B : `PRINC`) ; `TR-0001`, `PR-0001`, `RT-0001`, `RC-0001` (B : `TR-AAAA-001`, `PREP-…`, `RET-…`, `REC-…`).
- Emplacement d'arrivée d'un nouvel entrepôt : « Principal » du dépôt (B créait une « Réception »). Retours à contrôler : emplacement `RETOURS`.
- Statuts : A répond 400 (B 409) pour double expédition/réception, libération/validation en double, annulation d'un retour validé, liste expédiée non annulable, réservation/sortie libre sur stock réservé ; 404 pour une zone inconnue.
- Retour fournisseur sans fournisseur : accepté (prouvé par test-wms.js). Rangement sans règle : refusé (400) au lieu de ranger au défaut. Après une liste partielle, A solde toute la réservation de la commande. Parcours : emplacements sans position en premier.
- Appels de prévision / réapprovisionnement / états / scan : préfixe `/b/`. Listes strictes : paramètre `strict: true`. `partial: false` pour une réservation tout-ou-rien.
- Les contrôles du type `x === undefined` (valeurs cachées à un membre) sont prouvés en exécution normale ; ils échouent seulement sous l'outil `tolerant.js` (artefact de l'outil).

## Non porté (à ne pas masquer)
1. **Vagues / palettes / colisage de B** : bloc de test conservé (`if (process.env.WMS_B_VAGUES === '1')`) mais non exécuté ; A a ses vagues, unités de manutention et colis (autre API). Manque par rapport à B : tables `wms_units`, `wms_unit_items`, `wms_packages`, `wms_package_items` ; routes `/units…` et `/picks/:id/packages` (poids, `all`, « Colisage incomplet » à l'expédition) ; création d'une vague directement depuis ≥ 2 commandes avec tout-ou-rien.
2. **Réservation résiduelle** d'une commande après une préparation partielle (B garde le manque réservé ; A solde).
3. **Prévision / réapprovisionnement / états de B** : disponibles sous `/b/…`, pas fusionnés dans les routes de A (formes différentes). À unifier côté site si besoin.
4. Mécanisme de messages traduisibles : non trouvé (voir ci-dessus).
5. `wms-lib.js`, `stock-wms*.js` (routeur `stock-wms.js`) restent dans l'arbre, non montés (sauf `forecast` et `reports` montés via `wms-b-routes.js` sur le socle `wms-b-lib.js`).
