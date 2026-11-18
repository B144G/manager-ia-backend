# Projets et Production : PERT, dépendances, recherche opérationnelle, finances, circuit de production

Branches : serveur `projets-ro-production` (depuis `fusion-final-serveur`, 47a83d0), site `projets-ro-production` (depuis `fusion-final-site`, 3b9b93c).

## Ce qui est fait

**Projets (nouveaux onglets du projet)**
- **PERT** : réseau d'activités dessiné, dates au plus tôt / au plus tard, marges, chemin critique en rouge, estimation optimiste / probable / pessimiste (modifiable par tâche, sinon estimation automatique), durée attendue, écart-type, probabilité de tenir une date choisie, simulation Monte-Carlo (2 000 tirages, graine fixe, donc résultat reproductible) avec percentiles 50 / 80 / 90. Les 4 types de liens (fin-début, début-début, fin-fin, début-fin) avec décalage sont pris en compte.
- **Risques et dépendances** : le registre existant reçoit une *nature* du risque (délai, coût, ressource, fournisseur, qualité, autre). Dépendances entre tâches et dépendances externes (fournisseur, client, autorisation) avec date attendue et état. Détection : boucles, auto-dépendance, doublons, dates incohérentes, tâche terminée avant sa précédente, attente externe en retard / bloquée / arrivant après le début de la tâche.
- **Outils conseillés** : selon les risques et les dépendances, le système propose l'outil (PERT, pilotage / courbe en S, charge, achats, planification, optimisation, circuit) avec un bouton qui l'ouvre.
- **Budget et coûts** (responsables) : valeur acquise (PV, EV, AC, SPI, CPI, EAC, VAC — calculée par le module existant), **CBS** (structure des coûts hiérarchique, réel, reste à faire, prévision à terminer), **ABC** (taux par activité, coût complet par produit, comparaison avec la méthode classique, capacité inutilisée), **ROI / VAN / TRI / délai de récupération**, **budget prévisionnel mensuel** (prévu contre réel, rythme de consommation, dépense finale probable), **analyse des écarts** (budget − prévision, effet quantité et effet prix).
- **Optimisation** (responsables, projets de vente ou de production) : simplexe écrit sans dépendance (deux phases, règle de Bland). Vente : mix de produits qui maximise la marge sous contraintes (matières, heures, demande) + prix optimal par élasticité constante. Production : répartition qui minimise le coût (capacités, ressources, quantité demandée) + prix conseillé pour une marge visée. Hypothèses saisies, solution, contraintes saturées, prix duaux (« une unité de plus vaut… »), graphiques, phrase de conclusion, scénarios enregistrés et comparés. Le type de projet (général / vente / production) se choisit à la création.

**Production (nouvel onglet « Circuit de production »)**
- Circuit type par secteur (général, BTP, alimentaire, cosmétique, commerce) : approvisionnement, préparation, fabrication, contrôle qualité, conditionnement, stockage, expédition.
- Circuit personnalisé : étapes, ordre (« après »), responsable, doublure, durée par lot, postes en parallèle, visa.
- Analyse : étape sans responsable, goulot, charge au-dessus de la capacité, absence de contrôle qualité, boucle infinie, étape isolée, dépendance non résolue, point unique de défaillance (étape ou personne), absence de validation avant expédition, durée manquante. Chaque faille a ses solutions (appliquer en un clic, ou écarter / rétablir) et un score sur 100.

## Fichiers
Serveur : `src/workspace/{pert-lib,ro-lib,prod-flow-lib,proj-fin-lib}.js` (calculs purs), `projects-ro.js`, `projects-fin.js`, `production-flows.js` (routes, montées dans `index.js`), `src/migrations/projets-ro.js` (5 migrations ajoutées à la FIN du tableau, rejouables), `scripts/test-projets-ro.js` (ajouté à `test:chain`). Petites retouches : `projects.js` (type du projet), `projects-pro.js` (nature du risque).
Site : `src/ws/parts/projects/{Pert,Deps,Optim,Finance,ro-common}.jsx`, `src/ws/parts/production/Flow.jsx`, `src/styles/ws-ro.css`, `src/i18n/{en,de,es}/ws-projets-ro.js`.

## Limites
- Calendrier en jours entiers (week-ends et jours fériés non retirés), comme le reste du module.
- Le PERT ne prend pas en compte la disponibilité des ressources, ni les dates attendues des dépendances externes dans le calcul du réseau (elles sont contrôlées et signalées, pas intégrées).
- Programmation linéaire seulement (quantités continues, pas d'entiers) ; affectation et transport non faits. Élasticité supposée constante. Les prix duaux sont obtenus en recalculant avec une unité de plus : en cas de dégénérescence (plusieurs contraintes saturées en même temps) un prix dual peut apparaître à 0.
- CBS / ABC / ROI / budget prévisionnel : saisis à la main (documents enregistrés), seul le réel mensuel du budget prévisionnel vient des coûts du projet ; la différence avec les dépenses non rattachées à un poste est signalée.
- Les noms des étapes des circuits types sont enregistrés en français (traduits à l'affichage s'ils sont inchangés).
- Le circuit de production est une analyse de conception : il n'est pas relié aux ordres de fabrication.
- Vérification visuelle dans un navigateur non faite faute de volet disponible : build, eslint, contrôle des traductions, tests et appels API de démonstration réussis.

## Tests
`node scripts/test-projets-ro.js` (139 vérifications : calculs, HTTP, droits, cloisonnement des organisations), ou `node scripts/run-all-tests.js projetsro`.

## Fusion
```bash
# serveur
cd ~/Downloads/manager-ia-backend && git checkout claude/postgres-react && git merge --no-ff projets-ro-production
# site
cd ~/Downloads/MANAGER-IA/site && git checkout main && git merge --no-ff projets-ro-production
```
Ou en patchs : `git format-patch fusion-final-serveur..projets-ro-production -o /tmp/patch-serveur` (idem côté site avec `fusion-final-site`). Conflits probables et simples : la ligne `MIGRATIONS.push` de `src/db.js`, la liste des routes de `src/workspace/index.js` et `package.json` (autres branches qui ajoutent aussi à la fin).
