# Matrice de fusion — module Achats

Base retenue : couche de la ligne A (`purchasing*.js`, tables `pur_*` de A). Les fichiers de B (`pur-*.js`) restent dans l'arbre, NON branchés (routes en double). Colonnes ajoutées : `src/migrations/fusion-achats.js`.

| Fonction | A ? | B ? | Décision | Test |
|---|---|---|---|---|
| Droits par rôle, isolation entre organisations | oui | oui | garder A | test-purchasing, test-purchasing-b |
| Lecture des réglages/seuils par un membre | non (responsable) | oui | porter B | test-purchasing-b (« un membre lit les réglages ») |
| Résumé `canManage` / `canAdmin` | non | oui | porter B | test-purchasing-b |
| Réglages : réponse = réglages, deux seuils au même montant refusés | non | oui | porter B | test-purchasing-b |
| Demandes : brouillon, soumission, retrait, approbation par seuil, refus motivé | oui | oui | garder A | les deux |
| Demande : date souhaitée passée refusée (création) | non | oui | porter B | test-purchasing-b |
| Demande : projet / antenne validés par organisation (IDOR) | non | oui | porter B (colonnes `project_id`, `branch_id`) | test-purchasing-b, test-security-idor |
| Demande : `requiredRole` exposé | non (label seul) | oui | ajouter le champ | test-purchasing-b |
| Demande : PUT partiel (champs non envoyés conservés) | non | oui | porter B | test-purchasing-b |
| Notifications internes (soumission, approbation, refus, refus à la réception) | non | oui | porter B (`w3.push/pushRole`) | non testé en détail (best effort) |
| Approbation : propre demande interdite (sauf propriétaire) | oui | oui (sauf admin) | garder A (plus strict) | les deux |
| Approbation de son PROPRE bon de commande interdite (sauf propriétaire) | non | oui | porter B (règle A du propriétaire) | test-purchasing-b |
| Demande -> bon : fournisseur autre organisation = 404, prix obligatoire | 400 / prix 0 accepté | 404 / refus | porter B | test-purchasing-b |
| BC : prix nul, TVA > 40 % refusés | non | oui | porter B | test-purchasing-b |
| BC multi-lignes, PDF, e-mail (adresse de la fiche, PDF joint, 502 si échec) | partiel | oui | porter B | test-purchasing-b |
| Pas d'envoi ni de réception avant approbation | oui | oui | garder A | test-purchasing-b |
| Réception : même ligne deux fois, tolérance cumulée, date < commande, `orderStatus` | non | oui | porter B | test-purchasing-b |
| `GET /orders/:id/receipts`, `GET /receipts/:id` | non | oui | porter B | test-purchasing-b |
| Lot / péremption / série à la réception, rollback | oui | oui | garder A | les deux |
| Emplacement WMS à la réception (inconnu = 400) | oui | oui | garder A (wms-core) + validation 400 | test-purchasing-wms |
| Contrôle qualité à l'entrée (quarantaine -> libération / refus) | oui | oui | garder A + totaux `accepted/rejected`, doublons, destination validée | test-purchasing-wms, test-purchasing |
| Réapprovisionnement | oui | oui | garder A | les deux |
| Factures : rapprochement à trois, tolérances, doublon, anomalies | oui | oui | garder A | les deux |
| Facture : échéance avant facture, fournisseur ≠ bon, bon inconnu = 400, TVA > 40 %, compte de classe 4/5 refusé | non | oui | porter B (classes 2, 3, 6 acceptées : A) | test-purchasing-b |
| Facture : PUT partiel | non | oui | porter B | test-purchasing-b |
| Écritures idempotentes : source `pur_invoice`, identifiant = facture x 100 + n | source_id = id | oui | porter B (migration `attempts`) | test-purchasing-b, test-purchasing |
| Dette fournisseur (`supplier_bills`) créée à la validation, règlement relié (`supplier_payments`, source `supplier_payment`) | non | oui | porter B (`bill_id`) ; `pur_payments` conservée en parallèle | test-purchasing-b, test-security-new |
| Annulation de validation (écriture inverse, dette annulée, `reversedEntry`) | oui | oui | garder A + champs B | les deux |
| Évaluation fournisseur : note entière, bon (`order_id`), `stats` renvoyées, `late`, `grade` | partiel | oui | porter B | test-purchasing-b |
| Fiche fournisseur enrichie (e-mail, tél., adresse, ville, NIU, RCCM, délai, banque, statut) | oui (sur `suppliers`) | oui (`pur_supplier_profiles`) | garder A (colonnes de `suppliers`) | test-purchasing-b |
| Statut fournisseur validé (`active`/`blocked`) | non | oui | porter B | test-purchasing-b |
| Documents fournisseur (suppression : auteur ou admin) | oui | oui | garder A + règle B | test-purchasing-b |
| Appels d'offres : comparatif, meilleur prix par ligne (`bestPrice`), `referenceTotal`, `averageTotal`, rang, devis expiré non attribuable, motif | oui | oui | garder A + champs B | les deux |
| AO depuis une demande approuvée (`requestId`) ; la demande passe à « commandée » | non | oui | porter B (`pur_rfqs.request_id`) | test-purchasing-b |
| `POST /rfqs/:id/suppliers`, `DELETE /rfqs/:id/suppliers/:supplierId` | non | oui | porter B | test-purchasing-b (bloc « Fusion ») |
| Devis : prix > 0, ligne unique, au moins un prix | non | oui | porter B | test-purchasing-b |
| Économie AO : référence, sinon moyenne des devis complets | référence seule | oui | porter B | test-purchasing-b |
| Budgets / engagements / blocage / passer outre (`overrideBudget`, administrateur) | oui (sans override) | oui | porter B | test-purchasing-b |
| Tableau de bord (`spend.totalHt`, `invoices`, `pending`, `deliveries.delivered`...), année invalide = 400 | partiel | oui | porter B | test-purchasing-b |
| Exports CSV (7 types) | oui | oui | garder A | les deux |
| Alertes (budget, retard, factures bloquées...) | oui (déjà portées) | oui | garder | test-purchasing-b |
| Totaux enregistrés (`total_ht`, `vat_amount`, `total_ttc`) sur bons et factures | non (calculés) | oui | ajouter (colonnes tenues à jour) | test-purchasing-b |

## Tranchages et adaptations des tests

Tests de B adaptés (rien d'affaibli) :
- Attribution d'un AO et règlement d'une facture répondent **200** (forme de A, déjà consommée) au lieu de 201.
- Blocage de budget : **403** (A) au lieu de 400 ; `budgetBlock` est un booléen (A) : test sur la valeur logique.
- Facture dont la validation est annulée : `entry` vaut `null` (A) : test sur l'absence de valeur.
- Total annoncé inférieur au HT : la facture est saisie puis **bloquée** (`total_mismatch`) au lieu d'être refusée (le test de A l'exige) ; le test vérifie le blocage.
- `qualityRate` reste un entier (A) ; la décimale est dans le champ ajouté `qualityRateExact`.
- Suppression d'un fournisseur ayant des achats via Stock : **409** (protection de A, `stock.js`) au lieu d'un succès.
- `test-purchasing-wms.js` : l'entrepôt est désigné (`warehouseId`) à la création d'un emplacement ; la quarantaine est l'emplacement spécial « QUARANTAINE » de A.

Tests de A adaptés (contradictions assumées) : identifiant d'origine de l'écriture d'achat = facture x 100 + 1 (au lieu de l'identifiant de facture) ; seconde validation = 409 ; règlements en écriture `supplier_payment` (au lieu de `pur_payment`).

Compatibilité production : les écritures déjà passées (source `pur_invoice`, identifiant = id, ou `pur_invoice#n`) ne sont pas touchées ; le numéro de tentative saute les identifiants déjà pris. Les factures déjà validées n'ont pas de dette liée : leurs règlements restent dans `pur_payments` (ancien chemin conservé).
