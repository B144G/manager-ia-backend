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
