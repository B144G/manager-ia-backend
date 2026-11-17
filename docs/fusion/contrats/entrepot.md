# Contrats d'API — module ENTREPÔT (fusion A + B)

Règle : les chemins et formes de A sont inchangés. Tout ce qui suit est un AJOUT (champ, route, paramètre) ou une règle plus stricte signalée.

## Routes ajoutées (préfixe `/api/ws/orgs/:org/stock/wms`)
- `GET /putaway-suggest?itemId&quantity[&warehouseId]` → `{ parts: [{ locationId, code, quantity, fallback }] }`
- `GET /integrity` (responsable) → `{ ok, mismatches: [{ itemId, name, quantity, locations }], negative }`
- `PUT /zones/:id`, `DELETE /zones/:id` (409 si la zone contient des emplacements)
- `GET /items/:id/tracking` → `{ tracking, lots: [{ id, lotNo, expiry, quantity, locations: [{ locationId, code, quantity }] }], serials: [{ serial, locationId, location }] }`
- `GET /documents/:id/reservations`
- `POST /picks/:id/start`
- `POST /abc/refresh` (responsable) → `{ ok, items, counts: { A, B, C } }`
- `POST /location-counts` `{ locationId, blind?, itemIds?, note? }` → 201 `{ id, items }` ; `POST /location-counts/:id/lines` `{ itemId }`
- Forme B sous `/b/` : `GET /b/forecast`, `/b/forecast/:id`, `/b/reorder`, `GET|PUT /b/items/:id/params`, `GET /b/reports/valuation|rotation|stockouts|aging|moves` (`?format=csv`), `GET /b/scan?code=`

## Routes ajoutées (suite)
- Palettes de B : `GET|POST /units`, `GET|DELETE /units/:id`, `POST /units/:id/items`, `DELETE /units/:id/items/:itemId`, `POST /units/:id/nest`, `POST /units/:id/move`.
- Colisage de B : `GET|POST /picks/:id/packages` (`{ weight, lines:[{itemId,quantity}] | all:true }`), `DELETE /packages/:id`.
- `POST /waves/:id/issue` (responsable) → `{ ok, orders }`.
- Paramètres : `POST /waves { strict }`, `POST /waves/:id/cancel { cancelPicks }`, `POST /picks/:id/complete { keepShortfall }`. `POST /picks/:id/issue` peut répondre 409 « Colisage incomplet ».

## Champs / paramètres ajoutés
- `locations/lookup` : `location` reçoit le détail (name, kind, warehouse, zone, capacity, quantity…) et la réponse un `content[]` (forme A `{ id, code }` conservée dans `location`).
- `POST /move` : `lotId`, `serials`. `POST /putaway` : `quantity` (rangement partiel). `POST /reservations` : `warehouseId`, `neededBy`. `POST /reservations/:id/fulfill` : `locationId` ; réponse + `status`, `remaining`, `quantity`.
- `POST /reservations/from-document` : `partial: false` = tout ou rien (409) ; réponse + `ignoredLines`.
- `GET /reservations` : `itemId` (sans `status`, tous les statuts), `warehouseId`/`documentId`/`documentNumber` dans chaque ligne ; réponse + `active`.
- `GET /items/:id/availability` : + `short`, `warehouses: [{ warehouseId, code, name, usable, reserved, available }]` ; `available` n'est jamais négatif. `GET /availability` : + `items`.
- `POST /transfers` : chaque ligne accepte `fromLocationId`/`toLocationId` ; `POST /transfers/:id/ship` accepte `lines: [{ lineId, quantity }]` ; `receive` : `toLocationId` par ligne, réponse + `gapValue` ; `GET /transfers/:id` + `gapQty`, `gapValue`.
- `POST /picks` : `strict`, `warehouseId` ; `GET /picks` : + `waiting`, `priorityLabel` ; `GET /picks/:id` : + `priorityLabel`.
- `POST /returns` : `orderId` (commande du module Stock), `GET /returns` : `status`; `GET /returns/:id` : `creditedAt` ; `dispose` : `locationId`. Codes de motifs de B acceptés en plus de ceux de A.
- `POST /receipts` : réponse + `costs` ; `GET /receipts/:id` : lignes et coûts + `incorporated`, `expensed` ; `POST /receipts/from-purchase` : `purchaseReceiptId` (ou `purchaseReceiptIds`).
- `GET /abc` : + `since`, `totalConsumption`, `totalStockValue`, `consumption`/`stockShare` par classe. `GET /cycle-counts/plan` : + `due`, `nextDue`. `GET /cycle-counts/variance` : classes + `lines`, `withGap`, `shortValue`, `surplusValue`. `POST /cycle-counts` : `limit`.
- `GET /api/ws/orgs/:org/stock/counts/:id` : + `blind`, `locationId`, `location`, `cycleClass` ; en comptage à l'aveugle ouvert, `expected`/`gap`/`withGap`/`gapValue` sont absents (`null`/`undefined`).

## Règles plus strictes (changement de comportement visible)
- Zone / emplacement : type inconnu → 400 (avant : repli silencieux sur « stockage »). Création d'un emplacement « En transit » à la main → 400.
- Emplacement : entrée au-delà de la capacité → 400 ; désactivation / suppression avec du stock → 409 ; entrepôt avec du stock : désactivation / suppression → 409.
- Transfert : expédier plus que demandé → 400 ; recevoir plus qu'expédié → 400 ; écart sans motif → 400.
- Déplacement (`/move`, transferts) qui mord sur du stock réservé : **409**. Sortie libre sur le stock réservé : 400 (inchangé, A) ; sortie qui mord sur le stock réservé POUR l'entrepôt (réservation par entrepôt) : 409.
- Réceptions : type de coût / base inconnus ou montant ≤ 0 → 400. Retour client lié à une commande : plus que vendu → 400. Prélèvement de plus que le reste de la ligne → 400.
- Retour fournisseur / rebut de stock réservé → 409.

## Migrations (src/migrations/fusion-entrepot.js, rejouables)
`wms_transfer_lines.from/to_location_id` ; `wms_reservations.warehouse_id` ; `wms_lot_levels` (nouvelle) ; `stock_serials.location_id` ; `stock_moves.location_id` ; `stock_counts.location_id/blind/cycle_class` ; `wms_returns.order_id/credited_at` ; `wms_item_class` (nouvelle) ; `wms_item_params.updated_at` ; `wms_units`, `wms_unit_items`, `wms_packages`, `wms_package_items` (nouvelles) ; `wms_landed_alloc` (nouvelle) ; `wms_moves.unit_value` ; clés étrangères différées (suppression d'organisation).

## Montage
Aucun changement de `index.js` : tout est requis depuis `wms.js` (`wms-b-routes.js`, `wms-b-counts.js`).
