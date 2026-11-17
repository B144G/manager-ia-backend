# Contrat d'API — Achats (fusion)

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
