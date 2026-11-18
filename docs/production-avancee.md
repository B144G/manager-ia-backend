# Production avancée : MPS, MRP, capacités, ordonnancement, Lean, Kanban, 5S, TOC, JIT, Six Sigma, TPM, qualité

Branches `projets-production-avancee` (serveur et site), créées depuis `projets-ro-production`. Livraison en 3 étapes commitées :
1. **Étape 1** : MPS, MRP, capacités, ordonnancement.
2. **Étape 2** : Lean (cartographie de flux, 8 gaspillages, takt), Kanban, 5S, TOC, JIT.
3. **Étape 3** : Six Sigma, TPM, contrôle qualité, intégration complète à l'analyse du circuit.

Tout est calculé par le serveur (fonctions pures, sans dépendance) ; le site saisit, dessine et explique. Onglet **Production → Techniques avancées**. Les modifications sont réservées aux responsables, la consultation à tous les membres.

## Techniques et ce qu'elles calculent
| Technique | Calcul | Fichier serveur |
|---|---|---|
| **MPS** | demande retenue (max prévision / commandes fermes), production par lots sans passer sous le stock de sécurité, stock projeté, disponible à promettre (ATP), lissage par production maximale | `prod-plan-lib.js` |
| **MRP** | nomenclatures multi-niveaux (niveau le plus bas d'abord), besoins bruts → nets avec stock, réceptions prévues, stock de sécurité, règles de lot (lot pour lot, fixe, minimum), ordres de fabrication / d'achat suggérés décalés du délai, ordres déjà en retard, nomenclature circulaire ou composant inconnu | `prod-plan-lib.js` |
| **Capacités** | charge par poste et période (quantité × heures + réglage), surcharge, solutions chiffrées (heures supplémentaires plafonnées, sous-traitance, décalage), lissage vers les périodes précédentes | `prod-plan-lib.js` |
| **Ordonnancement** | simulation d'atelier : FIFO, plus courte durée, échéance, ratio critique ; Gantt, retards, en-cours, utilisation ; comparaison des 4 règles | `prod-plan-lib.js` |
| **Lean** | délai de traversée, temps de valeur ajoutée, takt time, étapes plus lentes que le takt, 8 gaspillages repérés dans le circuit | `prod-lean-lib.js` |
| **TOC** | contrainte (capacité la plus faible), 5 étapes de focalisation, tambour-tampon-corde, débit / dépenses opérationnelles / stocks, gain si on élève la contrainte et prochaine contrainte | `prod-lean-lib.js` |
| **JIT** | en-cours (lots, jours), lots trop gros, fournisseur unique, délai d'approvisionnement sans tampon | `prod-lean-lib.js` |
| **Kanban** | cartes = demande × (délai + attente) × (1 + sécurité) / quantité par bac, cartes pleines / en production / vides, signal de réapprovisionnement et quantité à produire | `prod-shop-lib.js` |
| **5S** | note de 0 à 4 par S et par zone, score %, radar, progression, S la plus faible, plan d'actions, actions en retard, photos facultatives (images ≤ 400 Ko, 2 par audit) | `prod-shop-lib.js` |
| **Six Sigma** | cartes X-barre/R et p, règles de signal, Cp / Cpk / Pp / Ppk, niveau sigma, DPMO, Pareto, Ishikawa (6M), projets DMAIC guidés | `prod-quality-lib.js` |
| **TPM** | disponibilité × performance × qualité = TRS (OEE), 6 grandes pertes en heures, MTBF, MTTR, calendrier de maintenance préventive / autonome | `prod-quality-lib.js` |
| **Qualité** | plans de contrôle (réception, en cours, final), échantillonnage AQL et courbe d'efficacité, non-conformités, CAPA, taux de rebut / retouche, traçabilité des lots | `prod-quality-lib.js` |

## Intégration à l'analyse du circuit (point 13)
Les étapes du circuit reçoivent des champs facultatifs (valeur ajoutée, attente, transport, mouvements inutiles, stock avant, % de défauts, taille de lot, nombre de fournisseurs, machine, talent inutilisé) et le circuit des réglages de débit (prix, coût matière, frais, valeur des stocks). **Aucun avis n'apparaît tant que la donnée n'est pas renseignée.** Nouveaux avis, chacun avec ses solutions applicables d'un clic (ou à écarter) : 8 gaspillages (transport, stocks, mouvements, attentes, surproduction, sur-traitement, défauts, talents), étape plus lente que le takt, pas de tampon devant la contrainte (TOC), fournisseur unique et délai long sans tampon (JIT), machine sans plan de maintenance et machine au TRS < 40 % (TPM, lu dans le document TPM et dans le module Maintenance), contrôle qualité sans plan de contrôle (qualité), faible taux de valeur ajoutée. Ils comptent dans le score global du circuit.

## Données et liens
Migrations ajoutées à la fin de `MIGRATIONS` (`src/migrations/projets-production-avancee.js`) : table `production_docs` (un document JSON par organisation et par technique) et colonne `production_flows.extra`. Routes : `GET/PUT /production/adv/:kind` (mps, mrp, capacity, schedule, kanban, fives, sixsigma, tpm, quality), `GET /production/adv/import/stock` et `/import/maintenance` (lecture seule : stock, recettes, achats en cours, équipements et plans de maintenance), `GET /production/flows/:id/(lean|toc|jit)`. Aucune écriture dans les tables Stock, Achats ou Maintenance : le site propose, l'utilisateur valide en enregistrant dans la technique concernée.

## Limites
- Périodes = semaines (26 maximum), pas de calendrier de jours ouvrés ; l'ordonnancement simule des postes à capacité 1 sans interruption.
- MRP : pas de multi-sites ni de lots par péremption ; les réceptions prévues sont saisies (les commandes d'achat en cours sont proposées à la lecture, pas reliées automatiquement).
- Échantillonnage : tailles d'échantillon de l'ISO 2859-1 (niveau II, contrôle normal) mais le nombre d'acceptation est **calculé** (plus petit nombre qui accepte au moins 95 % des lots au niveau AQL) : il coïncide avec les tables ISO sur les cas courants (ex. lot 500, AQL 2,5 : 50 pièces, 3 acceptées) sans être garanti identique partout.
- Niveau sigma avec la convention usuelle du décalage de 1,5 sigma.
- Cartes de contrôle : règles de signal limitées (hors limites, 7 points d'un même côté).
- Les photos 5S sont stockées dans la base (petites images seulement).
- Lean / TOC / JIT dépendent des champs saisis sur les étapes du circuit : sans données, ils ne signalent rien.

## Tests
`node scripts/test-production-avancee.js` (ajouté à `test:chain`, étapes 1 à 3 : calculs, droits, cloisonnement des organisations, intégration au circuit).
