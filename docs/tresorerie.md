# Module Trésorerie

Branches : serveur `tresorerie-module` (depuis `fusion-final-serveur`, 47a83d0), site `tresorerie-module` (depuis `fusion-final-site`, 3b9b93c).
Entrée du menu : « Trésorerie », juste après « Comptabilité ». Accès : propriétaire, administrateurs, responsable de trésorerie, trésoriers.

## 1. Rôles, séparation des tâches, traçabilité

| Qui | Peut |
|---|---|
| Propriétaire / administrateur | tout ; désigne le responsable et les trésoriers (Trésorerie › Équipe et droits) |
| Responsable de trésorerie (un seul à la fois) | valide, refuse, annule ; crée les comptes ; fixe seuil de double validation, fonds de sécurité, solde minimal, objectifs en jours, taux de provision ; saisit éléments prévus et scénarios ; lance les relances ; exporte ; lit le journal |
| Trésorier (plusieurs) | prépare encaissements, décaissements, virements ; consulte soldes, calendrier, prévision, créances, dettes, indicateurs ; retire ce qu'il a préparé |
| Autres membres | aucun accès ; le module n'apparaît même pas dans leur menu |

* **Double validation** : au-delà du seuil réglable (500 000 par défaut, test `montant > seuil`), deux validations par deux personnes différentes, ni l'une ni l'autre n'étant le préparateur.
* **Séparation des tâches** : nul ne valide ce qu'il a préparé. Un administrateur peut assouplir cette règle SOUS le seuil (petite structure) ; au-delà du seuil elle reste stricte.
* **Journal chaîné** (`tre_log`) : chaque ligne contient l'empreinte SHA-256 de la précédente ; une ligne modifiée ou supprimée après coup rompt la chaîne, détectée et affichée (Trésorerie › Journal).
* Isolation : toutes les requêtes portent `org_id` ; une autre organisation reçoit 404 (testé).

## 2. Comptabilité (SYSCOHADA)

* Chaque compte de trésorerie (banque, caisse, mobile money MTN / Orange) est rattaché à un compte de classe 5 : 1re banque `521`, 1re caisse `571`, 1er mobile money `589` ; les suivants reçoivent un sous-compte (`5212`, `5712`, `5892`…) créé au plan comptable de l'organisation. Un compte du rapprochement bancaire (`bank_accounts`) est créé en même temps : les relevés se chargent et se pointent dans Comptabilité › Banque comme avant.
* Chaque opération validée passe UNE écriture par `accounting.recordEntry()` (équilibre, mois clôturés, jamais modifiée ; annulation = écriture inverse) :
  * encaissement d'une facture : D `5xx` / C `411` (journal BQ / CA / MM), le règlement est inscrit dans `doc_payments` avec `source='payment'` : la comptabilité ne le recompte pas ;
  * règlement d'une dette : D `401` / C `5xx`, `supplier_payments` mis à jour (même source `supplier_payment` que le règlement existant) ;
  * encaissement ou décaissement libre : contrepartie par catégorie (clients 411, acompte 419, fournisseurs 401, salaires 422, cotisations 431, impôts 447, TVA 4441, loyers 622, **frais bancaires 631**, emprunt 162, intérêts 671, dividendes 465, investissement 244…), modifiable ;
  * virement interne : D compte reçu / C compte débité ; entre deux monnaies, la différence va en `676` (perte) ou `776` (gain de change), l'écriture reste équilibrée.
* **Multi-comptes, multi-sites, multi-devises** : soldes consolidés par type, par monnaie et par antenne ; compte en devise = solde en devise + valeur comptable + valeur au taux courant (écart de conversion affiché).
* Rapprochement : par compte, solde du grand livre face au dernier relevé importé et écart restant (Trésorerie › Rapprochement).
* Annulation d'une opération comptabilisée (responsable, motif obligatoire) : écriture inverse, facture ou dette rouverte.

## 3. Prévision glissante (`tre-forecast.js`, `tre-data.js`)

Solde de départ = soldes consolidés des comptes. Flux collectés à chaque ouverture (aucune saisie) :

| Source | Date | Montant |
|---|---|---|
| Factures clients ouvertes | échéance + retard habituel du client (sinon moyenne de l'organisation) ; échue : +7 / +21 / +45 / +90 jours selon l'ancienneté | reste dû × (1 − taux de provision de la tranche) |
| Dettes fournisseurs | échéance (échue : J+3) | reste à payer |
| Commandes d'achat en cours (approuvées, envoyées, reçues en partie) | date prévue + délai de paiement | reste à recevoir TTC |
| Paie | jour de paie ; cotisations le 15 du mois suivant | mois connus (fiches validées) puis moyenne des 3 derniers |
| Emprunts | échéances du tableau d'amortissement | capital + intérêts |
| Impôts et obligations | échéance (non faites) | montant |
| Éléments prévus saisis | ponctuels ou récurrents | montant |
| Opérations préparées non validées | date de l'opération (ou déplace l'échéance de la facture / dette liée) | montant |
| Tendance (réglable) | ventes et achats moyens des 3 derniers mois pleins, encaissés / payés avec le délai DSO / DPO | par semaine |

Sorties : 13 semaines (S1 commence aujourd'hui), 12 mois, solde jour par jour (400 jours), point bas, **date du premier découvert** et du premier passage sous le solde minimal, calendrier mensuel + tableau + courbe.

**Scénarios** (`applyScenario`) : ventes ± %, retard clients, impayés, coûts d'achat, masse salariale, report des paiements fournisseurs, investissement, nouveau prêt (annuités), événements ponctuels. Enregistrés par organisation, comparés côte à côte ; comparaison standard pessimiste / central / optimiste. La liste d'origine n'est jamais modifiée.

## 4. Créances, dettes, fonds de sécurité

* **Créances** : balance âgée (non échu, 1-30, 31-60, 61-90, +90), score de risque 0-100 par client (part échue, plus gros retard, habitude), provision conseillée par tranche (taux réglables : 0 / 1 / 5 / 25 / 50 %), vérifiée contre le compte `411`. **Relances** : le bouton réutilise le balayage du centre de relances de l'Assistant commercial (`followups.scan`), cadence, canaux et journal inchangés.
* **Dettes** : échéancier par semaine, retards ; conditions par fournisseur (escompte %, délai, priorité) ; **paiements optimisés** avec la trésorerie disponible après le fonds de sécurité : critiques et très en retard d'abord, puis escomptes (rendement annualisé décroissant), puis échéances proches ; le reste est reporté avec une date conseillée.
* **Fonds de sécurité** : cible en jours de charges (décaissements d'exploitation moyens des 90 jours, comptabilité) ou montant fixe ; niveaux ok / un peu bas / insuffisant / critique ; reconstitution conseillée sur 12 semaines ; semaines prévues sous la cible.

## 5. Indicateurs (`tre-calc.js`, grand livre)

* Tableau des flux : chaque écriture touchant un compte 52/53/54/57/589 est classée par la contrepartie (exploitation / investissement / financement, par nature) ; ouverture + flux = clôture, vérifié et affiché.
* **FRNG** = capitaux propres (10-15) + dettes financières (16-18) + provisions (19) + résultat en cours − immobilisations (2x) ; **BFR** = stocks (3x) + classe 4 ; **TN = FRNG − BFR**, vérifiée contre la somme de la classe 5 (équilibre du grand livre).
* **DSO** = créances (41) ÷ ventes TTC des 90 jours × 90 ; **DPO** = dettes (40) ÷ achats TTC × 90 ; **DIO** = stocks (3x) ÷ coût des achats (60x) × 90 ; **CCC** = DSO + DIO − DPO. Évolution sur 12 mois, objectifs, alertes, phrase d'interprétation.
* Écarts prévu / réalisé : prévu = échéances du mois (factures, dettes, paie, emprunts, impôts, éléments prévus) ; réalisé = mouvements de trésorerie classés ; cascade, tendance sur 6 mois, causes probables.

## 6. Exports

`GET /treasury/export/plan.pdf` et `plan.xlsx` (responsable) : synthèse, 13 semaines, 12 mois, calendrier 90 jours, créances, dettes. Le classeur est écrit par `src/services/xlsx-lite.js` (fflate, textes toujours en texte, jamais en formule).

## 7. Liens avec les autres sessions

* **Stock** : la prévision lit déjà les commandes d'achat en cours, les dettes et les avoirs fournisseurs (qui réduisent les dettes ouvertes). Le tableau de bord appelle `require('./stock-compta').cashSnapshot(req)` si ce module l'exporte (sinon le bloc « Trésorerie du stock » reste masqué, sans erreur). Pour afficher l'état de `fusion-stock-serveur`, il suffit d'y ajouter l'export `module.exports.cashSnapshot = async (req) => ({ tiedUp, dormant, cashNeed })` (extraction de la logique de `GET /cash`). Aucun fichier de cette branche n'est modifié ici.
* Fichiers partagés modifiés (strict minimum) : `src/db.js` (1 ligne : migrations ajoutées en fin de tableau), `src/workspace/index.js` (montage `/treasury` + masquage du module sans droit), `src/workspace/modules.js` (1 ligne), `scripts/lib/wave1.js` (`TEST_START_TRIES`, identique à `fusion-stock-serveur`), `package.json` (`test:treasury` en fin de `test:chain`).

## 8. Tests

`npm run test:treasury` (`scripts/test-treasury.js`, 147 vérifications) : formules DSO / DPO / DIO / CCC, BFR / FRNG / TN (dont crédit de trésorerie), scénarios, prêt, paiements optimisés, balance âgée, fonds de sécurité ; puis de bout en bout : droits des rôles, double validation, séparation des tâches, écritures équilibrées (et grand livre équilibré), virement en devise (457 × 655,957 = 299 772, perte de change 228), prévision = départ + flux, découvert futur daté, scénarios, créances = compte 411, dettes, escompte 2 %, tableau des flux, journal chaîné et détection d'altération, exports PDF / Excel, isolation entre organisations.

## 8 bis. Vérifications finales

* `test:treasury` 147/147 ; non-régression : `smoke:ws` 517/517, `test:security` (5 étapes), `test:secnew` 28/28, `test:fusion` 20/20, `test:accpro` 207/207, `test:acclot3` 48/48, `test:accstock` 13/13, `test:adminlive` 50/50. La suite complète `test:chain` (49 étapes) n'a pas été rejouée en entier : machine à charge ~540.
* Site : `eslint src` propre, `i18n-check` complet (EN/DE/ES), `vite build` réussi.
* Fumée sur `scripts/demo-local.js` (port 3917, arrêté ensuite) : 17 routes Trésorerie en 200, création de comptes, export PDF. `scripts/smoke-workspace.js` lit désormais `TEST_START_TRIES`.
* Non vérifié : rendu visuel des écrans dans un navigateur (build et lint seulement).

## 9. Commandes de fusion (le fondateur pousse lui-même)

```bash
# serveur
cd ~/Downloads/manager-ia-backend
git checkout claude/postgres-react && git merge tresorerie-module

# site
cd ~/Downloads/MANAGER-IA/site
git checkout main && git merge tresorerie-module
```

Les migrations Trésorerie sont à la fin du tableau (`src/migrations/tresorerie.js`) : si une autre branche (Stock, Projets, Réunions…) ajoute aussi des migrations à la fin, garder les deux appels dans `src/db.js` (`MIGRATIONS.push(...a, ...b)`), l'ordre n'a pas d'importance entre elles (tables indépendantes).
