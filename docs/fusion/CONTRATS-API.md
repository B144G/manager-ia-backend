# Contrats d'API : changements de la fusion serveur (A + B)

Principe : les formes de réponse de la ligne A (en production) sont conservées ; la fusion AJOUTE des champs et des routes. Détail par module :
`contrats/achats.md`, `contrats/bibliotheque.md`, `contrats/entrepot.md` (reproduits ci-dessous).

## Transversal (sécurité, ligne B)
- Nouvelles routes : `/api/privacy/*` (consentements `GET|POST /consents`, export personnel `GET /export`, suppression avec délai `POST|DELETE /erasure`, aperçu `GET /overview`), par organisation `/api/privacy/orgs/:orgId/{export,retention,security,require-2fa,access-log}`, `POST /api/admin/privacy/run` (administration, exécution des suppressions échues).
- Toutes les réponses `/api/**` portent `Cache-Control: no-store` et une CSP `default-src 'none'; frame-ancestors 'none'` ; les routes de fichiers (aperçu bibliothèque, PDF, pièces) fixent leur propre CSP. Un PDF/aperçu affiché dans une iframe doit venir d'une route qui l'autorise (bibliothèque : `frame-ancestors 'self'`) ; à vérifier côté site pour les PDF d'Achats.
- Connexion : verrouillage progressif (429), alerte d'appareil inconnu, sessions actives listables et révocables ; une organisation peut exiger la 2FA des administrateurs (403 avec message explicite sinon).
- Un gros corps JSON (assistant avec pièces, imports) n'est lu qu'après vérification de la connexion (401 pour un anonyme). Pièces jointes de l'assistant : contenu réel vérifié (signature), sinon refus.
- Import bancaire : `POST …/accounting/bank/:id/import` accepte aussi `xlsxBase64` ; OFX/MT940/CAMT.053 sont détectés dans `csv` ; `detected.format` indique le format.
- Stock en écritures : `GET …/accounting/stock-valuation` renvoie en plus `nature`, `natureLabel`, `history[].label` ; `POST …/stock-valuation/post` : pièce `INV-<nature>-<date>`, libellé « Variation de stock (…) ».
- Public : `GET /api/ws/public/track/:token` (suivi de livraison) reste public.


## Module achats
### Contrat d'API — Achats (fusion)

Routes inchangées (aucune supprimée, aucune renommée). Formes JSON de A conservées ; tout ce qui suit est AJOUTÉ.

## Routes ajoutées
- `POST /purchasing/rfqs/:id/suppliers` { supplierId } -> 201 ; `DELETE /purchasing/rfqs/:id/suppliers/:supplierId`.
- `GET /purchasing/receipts/:id` -> `{ receipt, ...receipt }` ; `GET /purchasing/orders/:id/receipts` -> `{ receipts }` (ordre croissant).

## Changements de comportement
- `GET /settings` : lisible par tout membre (avant : responsable). `PUT /settings` répond maintenant avec les réglages (+ `ok: true`).
- Demande : `neededDate` passée refusée ; `projectId` / `branchId` validés par organisation (400 sinon) ; `PUT` partiel.
- `to-order` : fournisseur d'une autre organisation = 404 ; prix obligatoire pour chaque ligne (400).
- Bon de commande : prix > 0, TVA <= 40 % ; un responsable n'approuve pas son propre bon (403, sauf propriétaire) ; `overrideBudget: true` (administrateur) passe outre le blocage de budget.
- Réception : une ligne ne peut apparaître deux fois ; tolérance = cumul reçu <= commandé x (1 + tolérance) ; emplacement inconnu = 400 ; contrôle qualité refusé pour un article en série.
- Facture : bon inconnu = 400 ; fournisseur différent du bon = 400 ; échéance avant facture = 400 ; compte de charge de classe 4 ou 5 refusé ; TVA <= 40 % ; `PUT` partiel ; seconde validation = **409** (avant 400) ; passer outre sans motif = 400.
- Écriture comptable de facture : source `pur_invoice`, identifiant = facture x 100 + tentative ; dette fournisseur (`supplier_bills`, source `pur_invoice`) créée à la validation ; règlements en écriture `supplier_payment` (reliés aux dettes de la comptabilité).
- Devis d'AO : prix > 0, une seule fois par ligne, au moins un prix. Tableau de bord : `year` invalide = 400. Fournisseur : `status` validé (`active`/`blocked`).
- `POST /inspections` : 400 si vide ou ligne en double, destination validée (rangement, préparation, réception).

## Champs ajoutés (réponses)
- `/summary` : `canManage`, `canAdmin`. Demande : `requiredRole`, `projectId`, `branchId`, `submittedAt` ; création : `status`.
- Bon : `requestId`, `rfqId`, `projectId`, `branchId`, `requiredRole` ; liste : `projectId`, `branchId` et filtre `?supplierId=`. Réception (création) : `orderStatus` (= `status`) ; lignes de réception : `orderLineId`, `locationId`.
- Facture : création renvoie `issues` ; détail `billId` ; annulation de validation : `reversedEntry` (numéro de l'écriture annulée), `reversalEntry` ; validation : `billId`. `balance` vaut 0 tant que la facture n'est pas validée.
- AO : `requestId`, `suppliersCount`, `quotesCount`, `late` (détail) ; comparatif : `referenceTotal`, `averageTotal`, par fournisseur `complete`, `partialTotal`, `rank`, par ligne `bestPrice` ; devis : `status` (`quoted`/`declined`) ; attribution : `ok`, `total`. `baseline` retombe sur la moyenne des devis complets (>= 2) sans prix de référence.
- Fournisseur : `status` ; stats : `grade`, `onTime`, `late`, `accepted`, `rejected`, `invoices`, `qualityRateExact` ; évaluation : `orderId` (entrée) et `stats` (réponse).
- Inspections : `accepted`, `rejected` (totaux). Dashboard : `spend.totalHt`, `spend.invoices`, `pending{...,invoicesBlocked}`, `deliveries.delivered`, `lateDelivered`, `bySupplier[].totalHt/count/supplierId`, `byCategory[].totalHt/count`, `byMonth[].invoicedHt/orderedTtc`. Budget : `alerts`.
- Notifications internes (table `notices`) : soumission (approbateurs), approbation/refus (demandeur), refus à la réception (responsables).

## Module bibliotheque
### Contrat d'API — Bibliothèque (fusion) : AJOUTS uniquement, aucune forme de A changée

Routes inchangées (mêmes URL, mêmes statuts de succès). Ajouts de champs ou de paramètres :

- `GET /overview` (et `GET /blocks/:id`) : chaque bloc porte `slug` (identifiant court stable : `personnel`, `administratif`, `commercial`, `projets`, `rh`, `comptabilite`, `juridique` pour les blocs de départ ; généré depuis le nom pour les blocs créés).
- Listes de documents (`docs[]` : bloc, favoris, récents, recherche) : `linkType`, `linkId`, `folderId`.
- `POST /blocks/:id/docs?name=&folderId=` accepte en plus `tags=a,b`, `linkType=project|contract` et `linkId` (400 si le projet/contrat n'est pas de l'organisation).
- `PUT /docs/:id` accepte `folderId` (déplacement dans le même bloc ; `null` = racine).
- `GET /search` : paramètres `linkType` + `linkId` (la recherche peut se faire sans `q` ni `tag`).
- `PUT /settings` : la réponse contient aussi `settings`.
- `GET /audit` : chaque entrée porte `userId` ; nouvelle action `view_doc` ; le paramètre `action` accepte aussi les noms de B (`unlock_ok`, `add`, `delete`, `restore_version`, `folder_add`, `folder_edit`, `block_add`, `block_edit`, `trash_auto`). Dans un dossier personnel, `detail` est toujours vide (aucun nom de document).
- `POST /blocks/:id/unlock` : la réponse contient aussi `hardExpiresAt`.

Changements de comportement (messages et codes) :
- 5e mot de passe raté : `429` immédiat (avant : `403` puis `429` au suivant). Blocage 15 min, persistant, valable pour tous les blocs de la personne.
- `PUT /blocks/:id/perms` : `400` si une exception vise une personne qui n'est pas membre ; `403` si un administrateur MODIFIE les droits du rôle administrateur (valeur inchangée : ignorée).
- Document d'un bloc invisible pour la personne : `404 « Document introuvable. »` (avant : « Bloc introuvable. »).
- `POST /docs/:id/versions` : `400` si le contenu n'a pas le même type que le document.
- Un nom de fichier envoyé avec un chemin est réduit à son dernier segment.
- Texte sans extension (`note`) : accepté, devient `note.txt`.
- La consultation de `GET /trash` supprime aussi les documents à la corbeille depuis plus de 30 jours.

Base : nouvelle table `lib_attempts`; colonnes ajoutées `lib_blocks.slug`, `lib_grants.last_used_at`, `lib_grants.pass_stamp`, `lib_role_perms.org_id`, `lib_user_perms.org_id` (migrations rejouables dans `src/migrations/fusion-bibliotheque.js`).

## Module entrepot
### Contrats d'API — module ENTREPÔT (fusion A + B)

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
