# Module Commercial (niveau Salesforce) — documentation

Module `commercial` (menu « Commercial »), monté sur `/api/ws/orgs/:orgId/commercial`. Code : `src/workspace/commercial/`, tables `cp_*` (`src/migrations/commercial-pro.js`, ajoutées EN FIN de `MIGRATIONS`).
Il **réutilise** l'existant sans le dupliquer : un compte = une fiche `customers`, un devis = un `documents` (kind `quote`) avec sa numérotation, ses conversions et paiements ; prix plancher, paliers et prix négociés = `pricing.js` ; relances WhatsApp = `waOrg.sendText` (**code QR uniquement, jamais l'API officielle**), avec opposition (`wa-out.isOptedOut`), exclusion de l'IA (`ai-rules.autoBlocked`) et arrêt dès que le client répond.

## Rôles et droits (traçabilité dans `cp_audit`, onglet « Journal »)
| Rôle | Désigné par | Droits |
|---|---|---|
| Propriétaire / administrateur | — | tous (dont désigner le responsable commercial) |
| Responsable commercial (`sales_manager`) | responsable du compte | valide les remises (jusqu'à son plafond), objectifs, zones, équipes, règles, tarifs, commissions, fusion, coaching, exports ; désigne assistants et terrain |
| Assistant commercial (`sales_assistant`) | responsable commercial | prépare : fiches, devis (brouillon), relances, saisies, activités ; ne valide rien |
| Commercial terrain (`sales_field`) | responsable commercial | idem, limité à SES comptes, prospects, opportunités, visites, relevés |
| Responsable de l'organisation non désigné | — | lecture seule |
| Membre non désigné | — | aucun accès (403) |

## Fonctions et calculs (tous testés avec chiffres : `scripts/test-commercial*.js`)
- **Score prospect (0-100)** = profil (tél. 8, e-mail 6, entreprise 6, ville 3, produit 4) + source (recommandation 18, WhatsApp 14, salon 12, terrain 10, publicité 7, site 6, autre 3) + intention (chaud 20, tiède 10, froid 2) + budget 5 + échanges (≤ 10) + récence (≤ 3 j : 10, ≤ 14 j : 5, ≤ 30 j : 2) + 15 % du score BANT ; plafonné à 100. Grades A ≥ 70, B ≥ 45, C ≥ 25. Réglable.
- **BANT** : note 0-4 par critère, score = Σ poids × note/4 (poids 25 chacun). Seuls les critères **validés par un humain** comptent ; la suggestion tirée de la conversation WhatsApp est rangée à part. Règle de passage d'étape : `min_bant` de l'étape (dérogation du responsable avec motif, journalisée).
- **Attribution automatique** : première règle active (priorité) qui correspond (zone, produit, source, score min.), puis le moins chargé (ou tour de rôle) ; à défaut tout l'effectif commercial.
- **Pipeline** : étapes paramétrables (probabilité, type ouvert/gagné/perdu, BANT minimal, jours avant stagnation) ; valeur pondérée = montant × probabilité (étape ou saisie) ; durée par étape via `cp_stage_history` ; entonnoir = affaires ayant atteint au moins chaque étape ; motifs de gain/perte.
- **Segmentation** : RFM (note 1-5 = 1 + ⌊5 × valeurs strictement moins bonnes / n⌋ ; 8 segments), ABC (Pareto 80/95), secteur, ville, potentiel, segments personnalisés (règles ET), actions suggérées + création de tâches.
- **SPIN** : 4 rubriques ; complétude = 15 (2 situations) + 25 (1 problème) + 30 (2 implications) + 30 (1 bénéfice) ; maturité du besoin explicite/implicite.
- **Prévision** : pipeline pondéré par mois de clôture ; tendance = moyenne mobile (3) et lissage exponentiel (α 0,4) sur le CA net des mois complets ; atterrissage = réalisé + pondéré × (0,7 / 1 / 1,25 plafonné au pipeline non pondéré) ; consolidé = 60 % pipeline + 40 % tendance ; objectifs mensuels (`cp_targets`) ; rétro-test (MAPE).
- **Devis** : versions (groupe) et variantes, validité, conditions ; remise = 1 − vendu / prix de liste du catalogue ; plafond par rôle (assistant 5 %, terrain 8 %, responsable 30 %, responsable du compte illimité, réglables) ; au-delà : demande de validation, envoi/acceptation/commande **bloqués** tant qu'elle n'est pas validée (crochets additifs dans `crm.js`) ; acceptation par lien secret (48 hex) `/devis/:token` = acceptation simple (nom + horodatage), pas une signature qualifiée ; relance de devis par cadence.
- **Marges** : coût = `catalog.cost`, sinon coût moyen du stock ; marge HT par ligne/devis/commande/facture/client/produit, avec **couverture** (part du CA dont le coût est connu) ; alerte sous le seuil (10 %) ; simulation de prix (volume = base × (1 + élasticité × variation)) avec point mort ; listes de prix par segment/canal (jamais sous le plancher) ; historique des prix (`cp_price_history`, alimenté par `PUT /sales/catalog/:id`).
- **Fidélisation** : points (1 par 1 000 payés, factures soldées, une fois), paliers, utilisation/ajustement ; risque de départ = retard sur le rythme d'achat (≤ 70) + réclamation ouverte 15 + NPS ≤ 6 15 + baisse des achats 10 ; rétention, réachat, CLV = panier × achats/an × 3 ans, NPS, réclamations ; réactivation par cadence WhatsApp validée par un humain.
- **Force de vente** : équipes, zones, objectifs décomposés sans perte (plus fort reste), classement, commissions progressives par tranches + primes d'atteinte (relevés brouillon → validé → payé), visites, tournées, agenda, coaching (codes + chiffres).
- **Performance** : KPI avec comparaison (période précédente ou année précédente), répartitions, résumé en phrases (codes traduits par l'écran), exports PDF / Excel (.xlsx réel) / CSV.

## Fichiers touchés hors module (tous additifs)
`src/db.js` (1 ligne de migration), `src/workspace/modules.js`, `src/workspace/index.js` (2 montages), `src/jobs.js` (1 ligne), `src/server.js` (limite de corps des pièces jointes), `src/workspace/crm.js` (export `cleanLines`, 3 crochets du circuit de remise), `src/workspace/sales.js` (historique des prix), `scripts/lib/wave1.js` (`TEST_START_TRIES`), `package.json` (scripts `test:commercial`, `test:commercial2`, `test:commercial3` dans `test:chain`).

## Tests
`node scripts/test-commercial.js` (141), `test-commercial-2.js` (55), `test-commercial-3.js` (78). Machine chargée : `TEST_START_TRIES=480`.

## Fusion (rien n'a été poussé)
```bash
cd ~/Downloads/manager-ia-backend   # serveur
git merge --no-ff commercial-pro    # conflits probables et triviaux : src/db.js, modules.js, workspace/index.js, jobs.js, package.json (lignes ajoutées par d'autres sessions)
cd ~/Downloads/MANAGER-IA/site      # site
git merge --no-ff commercial-pro
```
Après fusion : `npm run test:commercial && npm run test:commercial2 && npm run test:commercial3`, puis `npx eslint src && node scripts/i18n-check.mjs && npx vite build` côté site.
