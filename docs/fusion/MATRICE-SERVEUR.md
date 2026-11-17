# Matrice de fusion du serveur Brij-IA (ligne A + ligne B)

Ligne A = `origin/master` (tête 20cb7ab). Ligne B = `claude/postgres-react` (Achats, Bibliothèque, Stock WMS, stock en écritures, import bancaire),
`claude/stock-wms-26eb73` (lots 11a–11d) et `claude/securite-784605` (sécurité et confidentialité).
Légende décision : **A** = garder A · **B** = garder B (ajouté) · **A+B** = réunion · **B→A** = capacité de B portée sur le schéma/les routes de A.
La matrice est mise à jour à chaque étape ; les cases « test » citent le script qui prouve la fonction.

## Import bancaire
| Fonction | A | B | Décision | Test |
|---|---|---|---|---|
| Import CSV avec détection de colonnes, doublons par empreinte | oui | oui | A (identique) | test-wave2-accounting |
| OFX, MT940, CAMT.053 détectés d'après le contenu | non | oui | B ajouté (`acc-bank-formats.js`, branché dans `readStatement`) | test-bank-formats (32 contrôles) |
| Excel (.xlsx en base64, dépendance fflate) | non | oui | B ajouté | test-bank-formats |

## Stock en écritures (acc-stock)
| Fonction | A | B | Décision | Test |
|---|---|---|---|---|
| Valorisation au coût moyen pondéré (avg_cost sinon unit_cost) | oui | oui | A+B (même formule) | test-acc-stock, test-acc-stock-ecritures |
| Constatation de la variation 311/6031, 321/6032, 331/6033 | oui | oui | A+B | idem |
| Solde comptable par classe (31, 32, 33) | oui (balance()) | compte exact | A (classe entière) | idem |
| Dates passées reconstituées (mouvements ultérieurs retirés) | oui | oui | A+B ; B ajoute l'exclusion des articles pas encore créés | test-acc-stock-ecritures |
| Historique | sur les lignes du compte de stock | sur la pièce INV-nature-% | A (relit aussi les anciennes écritures de la production), avec `label` ajouté | idem |
| Annulation puis nouvelle constatation | oui (pas de sourceId) | sourceId par tentative (jour×100+rang), 99 essais max | B ajouté ; le libellé et la pièce de B (`INV-nature-date`) l'emportent pour les nouvelles écritures | test-acc-stock-ecritures |
| Périodes clôturées, droits administrateur, cloisonnement | oui | oui | A+B | idem |

<!-- fiche détaillée : matrice/achats.md -->
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

<!-- fiche détaillée : matrice/bibliotheque.md -->
# Fusion — Bibliothèque (blocs protégés)

Code branché : ligne A (`src/workspace/library.js`, tables `lib_*` de A). Capacités de B portées sur A. Tests : `scripts/test-library.js` (A, 104 contrôles) et `scripts/test-library-b.js` (B adapté + ajouts, 237 contrôles), sans l'outil « tolerant ».

## Matrice

| Fonction | A | B | Décision | Test |
|---|---|---|---|---|
| Mot de passe ressaisi (bcrypt contre le compte connecté), jamais renvoyé ni journalisé | oui | oui | garder A | test-library-b « le mot de passe saisi n'est jamais renvoyé », « aucun mot de passe dans les journaux » |
| Limitation des essais persistante par personne et par bloc, déblocage après durée | non (comptage dans `lib_audit`, fenêtre glissante) | oui (`lib_attempts`) | porter B sur A : table `lib_attempts` (migration), compteur par bloc + compteur « tous blocs », blocage 15 min dès le 5e échec (429), `locked_until` | « 5e échec : blocage », « blocage levé après le délai », « lignes lib_attempts… » |
| Essais comptés toutes organisations confondues | oui | non (par bloc) | garder A (plus protecteur) : le blocage d'une personne vaut pour tous ses blocs | « blocage : suit la personne… » ; test-security-new |
| Autorisation courte côté serveur liée à la session, renouvelée, plafonnée | oui | oui | garder A ; ajout `last_used_at` et `pass_stamp` (autorisation refusée si le mot de passe a changé depuis) | « durée courte », « l'activité renouvelle », « le renouvellement ne dépasse jamais le plafond », « plafond dépassé » |
| Autorisation vérifiée sur TOUTES les routes de documents (fiche, téléchargement, aperçu, versions, favoris, récents, recherche, corbeille, dossiers, envoi) | oui | oui | garder A, preuve ajoutée | balayage de 17 routes + 6 listes depuis une autre session (« autre session, bloc verrouillé : … ») |
| Fermeture de session / déconnexion / changement de mot de passe : autorisations supprimées | oui (`sessions.js`) | révocation (`revoked_at`) | garder A (suppression des lignes) | « déconnexion : autorisations révoquées en base », « changement de mot de passe : … » |
| Droits par rôle et par personne (exception remplaçante), effet immédiat | oui | oui (table `lib_perms`) | garder A | section « Droits par bloc » |
| Exception pour une personne inconnue | ignorée | refusée (400) | porter B : 400 | « exception pour une personne inconnue refusée » |
| Administrateur modifiant les droits des administrateurs | ignoré en silence | refusé (403) | réunir : 403 seulement si la valeur change (une valeur inchangée envoyée par l'interface est ignorée) | « administrateur : ne touche pas aux droits des administrateurs » |
| Document d'un bloc non visible : « Document introuvable » (sans indice) | « Bloc introuvable » | « Document introuvable » | porter B | « membre : document d'un bloc non autorisé introuvable, sans indice » |
| Versions (20 max), rétablir, supprimer ; nouvelle version = même type que le document | oui, type libre | oui, type identique | porter B : 400 si le contenu n'a pas le type du document | « nouvelle version : le contenu doit correspondre… » |
| Corbeille 30 jours, restauration, purge | oui (tâche horaire) | oui (purge aussi à la consultation) | réunir : la consultation de la corbeille purge aussi l'organisation | « plus de 30 jours : supprimé définitivement » |
| Favoris, récents, recherche (nom, étiquette, lien projet) | oui, sans filtre de lien | oui | porter B : `search?linkType&linkId` | « documents d'un projet », « recherche : le caractère % est littéral » |
| Étiquettes et lien projet/contrat à l'envoi (`?tags=&linkType=&linkId=`) | non (seulement en modification) | oui | porter B | « envoi d'un PDF », « document lié à un projet », « isolation : lien vers le projet d'une autre organisation refusé » |
| Déplacer un document (`PUT /docs/:id {folderId}`) | non | oui | porter B | « déplacer un document à la racine » |
| Aperçu PDF/image, téléchargement forcé, en-têtes (nosniff, no-store, CSP) | oui | oui | garder A | « téléchargement : mêmes octets… », « aperçu PDF en ligne », « aperçu image » |
| Type reconnu d'après le CONTENU, programmes/pages/scripts refusés, chiffrement AES-256-GCM | oui | oui | garder A (B : texte sans extension `note` → `.txt`, porté) | section « Fichiers falsifiés », test-library « chiffrement » |
| Extension qui ne correspond pas au contenu | corrigée (le type suit le contenu) | refusée | garder A (testé par test-library) : type et extension suivent TOUJOURS le contenu réel | « PDF renommé .png : type et extension suivent le contenu » |
| ZIP quelconque | accepté (application/zip) | refusé | garder A ; servi en pièce jointe seulement, aucun aperçu | « ZIP quelconque : accepté… » |
| Nom de fichier : chemin retiré (`../../etc/passwd.pdf` → `passwd.pdf`) | remplacé par `_` | dernier segment | porter B | « traversée de chemin… » |
| Quotas par offre, taille maximale | oui | oui | garder A | « quota de l'offre atteint », « fichier trop gros pour l'offre » |
| Blocs de départ | 7 blocs | 16 blocs à slug | garder A (production) ; ajout de la colonne `slug` à tous les blocs | « blocs de départ de A (7) + 2 blocs ajoutés, tous avec un slug » |
| Dossiers personnels privés, journal sans nom de document | privés ; noms visibles au journal | privés ; journal sans nom | réunir : le journal n'expose jamais le nom d'un document d'un dossier personnel | « les dossiers personnels n'exposent aucun nom de document » |
| Journal d'audit (filtre, pagination) | oui (`lib_audit`) | oui | garder A ; ajouts : action `view_doc`, champ `userId`, filtre accepte les noms d'actions de B | section « Journal d'audit », « le filtre accepte aussi les noms d'actions de B » |
| Journal CENTRAL (`audit_trail`) : `library.unlock_fail` / `library.unlock_locked` | échec seulement | oui | réunir : A écrit aussi `unlock_locked` (gravité haute) ; alimente `alerts.js` | « échecs enregistrés au journal central », « alerte library_fails » |
| Alerte « library_fails » (src/services/alerts.js) | n/a | oui | prouvée (scan réel) | « alerte « library_fails » : créée… » |
| Réglages de sécurité (durée, plafond, taille) ; `PUT` renvoie les réglages | oui, `{ok}` | oui, `{ok, settings}` | réunir (ajout `settings`) | section « Réglages de sécurité » |
| Liens signés | non | **absents du code de B** (aucune route, aucun jeton) | rien à porter | — |
| Export / suppression d'organisation | cascade | cascade | garder ; `org_id` ajouté à `lib_role_perms`/`lib_user_perms`/`lib_attempts` pour l'export schéma-dirigé | « export d'organisation… », « suppression d'organisation : plus aucune ligne lib_* » |
| Limiteurs de débit | déverrouillage 20/15 min, envois 60/10 min (par adresse) | 40 / 60 | porter B pour le déverrouillage (bureau derrière une seule adresse) ; envois relevés à 120 | — |

## Adaptations du test de B (aucune n'affaiblit une garantie de sécurité)
- 16 blocs de B → 7 blocs de A + « Achats » et « Formation » créés par le test ; `slug` ajouté à A (colonne, vue `overview`/blocs).
- « Commercial » : A laisse les membres ajouter ; le test aligne d'abord les droits sur ceux de B (membre en lecture seule).
- `lib_grants` : A n'a ni `id` ni `revoked_at` (les autorisations sont supprimées, pas révoquées) : requêtes adaptées (clé `session_id, block_id`).
- `lib_perms` (B) → `lib_user_perms` (A) pour contrôler l'exception d'un autre administrateur.
- Noms d'actions du journal : `unlock_ok→unlock`, `add→upload`, `delete→trash`, `block_add→block_create`, `block_edit→block_update`, `trash_auto→auto_purge`, `view_doc` ajouté ; le filtre de A accepte aussi les noms de B.
- Blocage : B isolait chaque bloc ; A bloque la personne partout (tranché : le plus protecteur).
- Mot de passe vide : 403 chez A (compté comme un échec) contre 400 chez B (garder A, `test-library.js` l'exige).
- Aperçu d'un fichier Office : 400 chez A, 415 chez B (garder A ; le test accepte les deux).
- Extension ≠ contenu et ZIP : voir la matrice (A gardé).
- Étiquettes : A garde la casse saisie (B passait en minuscules) ; le test compare sans tenir compte de la casse.

## Intégration sécurité
- (i) Journal central : la Bibliothèque de A écrit `library.unlock_fail` et `library.unlock_locked` dans `audit_trail` ; l'alerte `library_fails` est créée par `alerts.scan()` (test).
- (ii) `src/security/sessions.js` supprime les `lib_grants` de la session fermée : prouvé (déconnexion, changement de mot de passe).
- (iii) Suppression d'organisation : tout `lib_*` porte `org_id` ou cascade depuis `lib_blocks`/`orgs` ; prouvé par comptage après suppression. Export : `lib_blocks`, `lib_docs`, `lib_versions` (sans le contenu), `lib_role_perms`, `lib_audit`… inclus.
- (iv) `test-security-idor.js` (1 échec) et `test-security-routes.js` (1 échec) : échecs déjà présents avant mes changements (achats/projet B ; route publique `/track/:token`), sans lien avec `/library`.

<!-- fiche détaillée : matrice/entrepot.md -->
# Matrice de fusion — module ENTREPÔT / WMS

Couche retenue : celle de A (`wms-core.js`, `wms.js`, `wms-*.js`, tables `wms_*` de A, `stock-lib.adjust()` → `wms-core.reconcile()`).
Le code de B (`wms-lib.js`, `stock-wms*.js`) n'est PAS monté tel quel (routes et tables en double) : ses capacités sont portées sur le schéma de A.
Test de B : `scripts/test-stock-wms.js` (504 contrôles, bloc vagues/palettes/colisage compris), adapté à A. Entrée unique : `node scripts/test-stock-wms.js`.
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
| Vagues de préparation | oui (wms-waves, plus riche) | oui | R (voir « Suite ») | test-stock-wms, test-wms4c |
| Palettes / cartons / colisage | oui (wms-hu, wms-ship) | oui (`wms_units`, `wms_packages`) | R : les deux (voir « Suite ») | test-hu, test-wms4c, test-stock-wms |
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

## Suite (portage des « non portés »)
| Fonction | Décision | Test |
|---|---|---|
| Palettes / cartons / caisses de B (`wms_units`, `wms_unit_items`) : `/units…` | PBA, tables nouvelles (migration), fichier `wms-b-units.js` monté à la racine ; cohabite avec les unités de manutention de A (`/hus`) ; une unité se réduit quand le stock sort (`trimUnits`) ; scan `/b/scan` reconnaît PAL-/CAR-/CAI- | test-stock-wms (bloc vagues/palettes/colisage) |
| Colisage de B (`wms_packages`, `wms_package_items`) : `/picks/:id/packages`, poids, `all`, « Colisage incomplet » à l'expédition | PBA, idem ; `POST /picks/:id/issue` renvoie 409 « Colisage incomplet » dès qu'un colis existe et que tout n'est pas emballé ; colis de A (wms-ship, `wms_hus` box) inchangés | idem |
| Vague depuis ≥ 2 commandes en tout-ou-rien | R : `POST /waves { documentIds, strict: true }` (400 si < 2, 409 et rien créé si une commande ne passe pas), `POST /waves/:id/issue` (expédie toutes les listes préparées), prélèvement > reste d'un arrêt → 400, `cancel` avec `cancelPicks: true` (listes annulées, commandes remises à leur réservation) | idem |
| Préparation partielle : manque gardé réservé | R, optionnel : `POST /picks/:id/complete { keepShortfall: true }` — par défaut A libère le manque (test-wms.js « ligne non prélevée : la réservation est libérée » le prouve) : TRANCHÉ A par défaut, B en option | test-stock-wms (lot 7) |
| Messages d'erreur « traduisibles » | Aucun mécanisme dans B : la convention (commit dc6d395, Bibliothèque) est « message sans variables = texte fixe que le site fait correspondre à une traduction ». Pas de champ `code` à porter. Les messages de l'entrepôt de A et de B contiennent souvent des variables (nom d'article, quantités) : les rendre fixes est un travail de rédaction à faire avec le site (liste des modèles) — NON FAIT | — |
| Prévision / réappro / états / scan de B vs A | Gardés tous les deux (A inchangé, B sous `/b/`). Non unifiés : les formes de réponse diffèrent (A : `weeksWindow`, `cover`…, B : `seasonalIndex`, `urgency`, `toOrder`…). | test-stock-wms (lots 8, 10), test-wms4e |

Adaptations ajoutées pour le bloc vagues : vague lancée (`release`) avant prélèvement ; `route` au lieu de `lines` ; codes `VG-0001`, `PAL-0001`, `COL-0001` ; statut final de vague `picked` ; une quantité donnée inférieure à l'arrêt vaut « manque déclaré » chez A (la ligne B est laissée ouverte pour obtenir le 409) ; annulation avec `cancelPicks`.

## Non porté (à ne pas masquer)
1. Messages d'erreur sans variables sur l'entrepôt (voir ci-dessus) : rien de mécanique à porter ; rédaction à faire avec le site.
2. Unification des formes de `/forecast`, `/reorder`, `/reports/*`, `/scan` de A et de B : les deux existent (A et `/b/`).
3. Par défaut, A libère le manque après préparation partielle (B le gardait réservé) : disponible en option `keepShortfall`.
4. `wms-lib.js` et `stock-wms.js` (routeur) restent dans l'arbre, non montés ; les autres `stock-wms-*.js` sont montés ou remplacés comme indiqué ci-dessus.

<!-- fiche détaillée : matrice/securite.md -->
## Sécurité et confidentialité
(A = `scripts/test-security-new.js`, `smoke-security`, `src/security/*` de la ligne A ; B = branche `claude/securite-784605`, commits 44de8ad et 85a395c)

| Fonction | A | B | Décision | Test qui la prouve |
|---|---|---|---|---|
| Sécurité du stock/achats/bibliothèque face aux doubles envois, quarantaine, seuils d'approbation | oui | — | A conservé | test-security-new (28) |
| Énumération de toutes les routes : 401 sans connexion hors liste blanche, 404 pour une autre organisation | non | oui | B conservé ; liste blanche complétée de `GET /api/ws/public/track/:token` (suivi de livraison de A, jeton secret) ; contrôles de couverture ajoutés pour Transport, Budget pro, Projets pro, Entrepôt, Achats, Bibliothèque, Comptabilité (1 138 routes énumérées) | test-security-routes (13) |
| Dépendances à jour (package-lock) | — | oui | B repris (lock fusionné) ; `npm audit` non rejoué (réseau) | — non testé |
| Plafond de coût de l'IA publique (`security/aibudget.js`) | non | oui | B | test-security-data |
| Échappement du bloc `<donnees>` des prompts (`promptguard.js`) | non | oui | B | test-security-data |
| Contenu réel des pièces jointes (signatures) | non | oui | B ; `test-plan-margin` adapté (fichiers à vraie signature) | test-ai-attach, test-plan-margin |
| Chiffrement des champs sensibles (CNPS, NIU, CNI, compte de paie, secrets de webhooks, jetons) | jetons v1 seulement | v1 + v2 | B ; lecture tolérante (clair accepté), DATA_KEY absente → dérivée de JWT_SECRET, `SKIP_STARTUP_ENCRYPTION=1` pour couper le chiffrement des anciennes lignes au démarrage | test-security-data, test-fusion-integration |
| Vérification du journal d'audit (chaîne + ancrages signés) | non | oui | B | test-security-data |
| Limites de corps JSON avant connexion (gros corps lus seulement après vérification de la connexion) | non | oui | B | test-ai-attach (413) ; test-security-auth |
| Verrouillage progressif, alerte d'appareil inconnu, sessions actives, 2FA exigible par organisation | non | oui | B | test-security-auth |
| Suppression complète d'une organisation (aucune ligne restante dans aucune table `org_id`) | non | oui | B ; contrôle étendu à toutes les tables de A (215 tables) | test-security-privacy, test-fusion-integration |
| Export des données d'une personne et d'une organisation, suppression avec anonymisation et délai de réflexion, consentements versionnés, conservation configurable, registre des accès paie/RH | non | oui | B | test-security-privacy (37) |
| Sauvegardes chiffrables | non | oui (obligatoire) | **réunir** : chiffrement OPTIONNEL (BACKUP_KEY) ; sans clé, copie en clair avec avertissement ; `STRICT_PROD_CONFIG=1` en production l'exige | test-security-data |
| Démarrage en production : JWT_SECRET ≥ 32, ADMIN_PASSWORD ≥ 12, ALLOWED_ORIGINS sans joker ni http | seuils 16/10 bloquants | 32/12 bloquants | **trancher** : seuils de A bloquants (inchangés) ; seuils de B en AVERTISSEMENT très visible, bloquants seulement si `STRICT_PROD_CONFIG=1` | test-config-prod (11) |
| Durcissement du Dockerfile, .dockerignore | non | oui | B | (revue) |
| En-têtes : HSTS, Referrer-Policy, `Cache-Control: no-store` et CSP sur `/api` | partiel | oui | B (les routes de fichiers gardent leur CSP propre) | test-security-auth |
| 20 documents (AUDIT + 10 textes FR + 10 EN) | non | oui | B repris tel quel dans `docs/securite/` | — (documents) |
| Scripts `test-security-*.js` de B (routes, auth, data, idor, privacy, fuzz) | non | oui | tous conservés et dans la chaîne `npm test` | idem |

<!-- fiche détaillée : matrice/autres.md -->
## Modules conservés tels quels de la ligne A, et petites fonctions
| Module | A | B | Décision | Test |
|---|---|---|---|---|
| Import bancaire : CSV | oui | oui (identique) | A | test-wave2-accounting |
| Import bancaire : OFX, MT940, CAMT.053, Excel (.xlsx) | non | oui | B ajouté (`acc-bank-formats.js`, fflate) | test-bank-formats (32) |
| Stock en écritures (`acc-stock.js`) | oui (réécrit) | oui | réunis (voir MATRICE-SERVEUR.md) | test-acc-stock (13), test-acc-stock-ecritures (25) |
| Emprunts (`acc-loans.js`, échéancier) | oui | oui (ancêtre commun) | A (aucune différence) | test-acc-lot3 |
| Abonnement : offre « Illimité » 21 500 / 80 000 / 224 000 / 425 000 / 800 000 FCFA | oui | anciens prix | A conservé, `src/config.js` non modifié par la fusion (diff vérifié) | test-plan-margin, test-custom-plan |
| Transport (TMS) : routes, coûts, KPI, facturation transporteur | oui | non | A conservé | test-tms |
| Budget et Projets pro | oui | non | A conservé | test-budget-projets, test-wave6-projects |
| Démo Batimat (`scripts/demo/`), commandes clients, heures de livraison | oui | non (B a `scripts/demo-local.js` + `scripts/lib/demo-seed.js`) | A conservé ; les deux démos coexistent | test-commerce, test-tms |
