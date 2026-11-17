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
