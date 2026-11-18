# Fusion des modules construits en parallèle — rapport

Branche `fusion-modules` des deux côtés (serveur : `4fddd7b`, site : `06d462a`), construite à partir de `fusion-stock-serveur` (4a6c1e4) et `fusion-stock-site` (45810ca).
**Rien n'a été poussé.** Aucun jeton ni secret dans les fichiers.

## 1. Ce qui est fusionné (9 branches sur 9, aucune mise de côté)

| # | Module | Branche serveur / site | Tests propres au module (serveur) |
|---|---|---|---|
| 1 | Projets & production avancée (PERT, risques, recherche opérationnelle, MRP/MPS/Lean/TOC/Six Sigma/TPM/qualité) | `projets-production-avancee` (contient `projets-ro-production`) | `test:projetsro` 139, `test:prodavancee` 123 |
| 2 | Réunions | `claude/reunions-module-06cfe6` / `reunions-module` | `test:meetings` 247 |
| 3 | Histoire de l'entreprise | `histoire-entreprise` | `test:history` 92 |
| 4 | Trésorerie | `tresorerie-module` | `test:treasury` 147 |
| 5 | RH talents | `rh-talents` | `test:rh` 197 |
| 6 | Administration | `administration-module` | `test:administration` 221 |
| 7 | Bibliothèque évolution (+ un bloc par module) | `bibliotheque-evolution` (contient `bibliotheque-tous-modules`) | `test:libraryevol1` 124, `test:libraryevol2` 117 |
| 8 | Commercial pro | `commercial-pro` | `test:commercial` 141, `…2` 55, `…3` 78 |
| 9 | Paiement Campay + secours manuel | `paiement-campay` | `test:campay` 83, `test:paymanual` 46 |

Une fusion = un commit (`git log --first-parent`), dans l'ordre ci-dessus, avec contrôle après chacune (tests du module + eslint / i18n / build côté site).
Registre des modules : 34 modules, identifiants uniques (`commercial`, `talents`, `treasury`, `meetings`, `history`, `administration` ajoutés). Le menu est une liste plate (pas de groupes côté serveur) : chaque module est à sa place, aucun doublon.
Routes : 1 189 → 1 903 routes, aucune collision nouvelle (les deux doublons exacts `POST …/hr/leaves` et `PUT …/projects/tasks/:id` existaient déjà dans la base).
Tables : aucun nom en commun (préfixes `mtg_`, `history_`, `tre_`, `rh_`, `adm_`, `lib_`, `cp_`, `ro_`/`project_`, `production_`, `payment_webhook_events`).

## 2. Conflits résolus

| Où | Conflit | Résolution |
|---|---|---|
| `src/db.js` (fin de MIGRATIONS) | chaque branche ajoute sa ligne au même endroit | toutes gardées, en ajout seulement, **une ligne `MIGRATIONS.push` par module**. Piège évité : trésorerie et RH avaient accolé leur fichier à la ligne `fusion-achats…` ; un simple « garder les deux » aurait **rejoué trois fois** ces fichiers et décalé la numérotation des migrations (qui est positionnelle). Corrigé et verrouillé par un test. |
| `package.json` | `test:chain` modifiée par les 9 branches | une seule chaîne, sans doublon, 69 étapes (voir §4) |
| `scripts/lib/wave1.js` | attente de démarrage (`TEST_START_TRIES`) réécrite différemment | version la plus tolérante : `TEST_START_TRIES` ou `TEST_BOOT_TRIES`, sinon 80 |
| `scripts/demo-local.js` | Histoire et RH talents ajoutent chacun leurs données d'essai | les deux gardées |
| `node_modules` | la branche Commercial avait **commité** un lien `node_modules` | retiré du suivi, `.gitignore` corrigé (`node_modules` sans barre finale pour couvrir un lien) — aussi côté site |
| site `src/ws/registry.js` | table des icônes (une ligne) modifiée par 5 branches | union des entrées (`talents`, `treasury`, `administration`, `commercial`, `meetings`) |

## 3. Bugs de fusion trouvés et corrigés (rien n'est supprimé)

1. **Bibliothèque : limite de 40 blocs.** Le bloc créé d'office par module + les blocs de départ atteignaient 40 : plus aucun bloc personnalisé possible. La limite ne compte désormais que les blocs personnalisés (`builtin = 0`). Test `test:libraryb` de nouveau vert.
2. **Bibliothèque : prêt d'une ressource non prêtable** renvoyait 403 au lieu du message 400 (le droit « prêt » inclut « prêtable ») — défaut présent dans la branche seule ; ordre des contrôles corrigé.
3. **Bibliothèque : blocs pour tous les modules.** Les blocs sont déduits de `modules.js` : Réunions, Histoire, Trésorerie, RH talents, Administration, Commercial, Achats ont leur bloc (`mod-<id>`) ; couleurs et icônes ajoutées pour Commercial, Talents, Trésorerie, Achats, Histoire, Administration. Les projets avancés et le paiement n'ont pas de module propre (ils vivent dans Projets, Production et Abonnement : leurs documents se classent dans ces blocs).
4. **Tests adaptés (pas affaiblis)** : devis publics du Commercial (`/public/quote/:token`, protégés par jeton) ajoutés à la liste blanche du test de sécurité ; le balayage des 1 900 routes dépasse la limite globale de production (3 000 req / 15 min) : limite relevée **dans ce test seulement** ; `smoke:ws` fournit des numéros de paiement manuel (le paiement manuel exige maintenant un numéro configuré).
5. **Trois tests orphelins** ajoutés à la chaîne (`test:prospects`, `test:wave4kind`, `test:wave5`) ; ils passent.
6. **Interface** : icônes absentes dans le menu (Talents, Trésorerie) ; avertissement React `<div>` dans `<p>` (état vide) ; débordement horizontal d'un tableau (éléments `sr-only` hors du cadre défilant) ; noms des blocs de la bibliothèque non traduits (« Mes documents », « Administratif », « Comptabilité et finances » + blocs de modules) ; fenêtre cookies masquant les captures (le test la ferme).

## 4. Tests (une chaîne lourde à la fois, `TEST_START_TRIES=1200`)

- **Serveur** `node scripts/run-all-tests.js` : 69 étapes ; première passe 67/69, puis les 2 échecs (`smoke:ws`, `test:security`) corrigés comme décrit en §3.4 et **relancés seuls : verts**. Journal de la première passe : `docs/fusion/TESTS-FUSION-MODULES.txt`. Aucune modification de code serveur n'a eu lieu entre cette passe et le dernier état, hors tests.
- **Nouveau** `test:migrations` (8 contrôles) : empreinte des 78 premières migrations identique à la base, aucun doublon, 115 migrations appliquées sur base neuve, les 37 ajoutées se rejouent sans erreur, aucune table/index/colonne déclarés par deux fichiers, **aucune instruction destructive** (DROP / TRUNCATE / DELETE / RENAME).
- **Site** : `eslint src` propre, `scripts/i18n-check.mjs` **100 %** (11 911 textes × FR/EN/DE/ES), `vite build` OK.
- **Navigateur réel** (Chrome + puppeteer, serveur `scripts/demo-local.js` sur un port libre, site Vite) : `scripts/smoke-fusion-ui.js` — 34 modules ouverts, **chaque onglet / entrée de menu** des 10 modules de la fusion (projets, production, réunions, histoire, trésorerie, talents, administration, bibliothèque, commercial, abonnement), mobile 375 px pour chacun, mode anglais, écran `/admin`. 189 écrans, **175 captures** dans `docs/fusion/captures/` (+ `RESULTAT-SMOKE.json`). Aucun écran blanc, aucune erreur JS, aucune réponse HTTP ≥ 500, aucun débordement. Restent 8 remarques **non bloquantes** : « IA non activée » et « e-mail non activé » (démo sans clé), « Coaching : ce commercial ne figure pas dans la force de vente » (le propriétaire de démo n'est pas commercial), et 5 textes français en mode anglais qui sont des **données d'essai** saisies en français (projets, ordres de fabrication, histoire, objectifs), pas des libellés d'interface.
- Serveurs de démonstration arrêtés par port uniquement.

## 5. Limites et points à connaître

- Paiement : mode `test` par défaut ; le passage en `reel` exige les identifiants Campay et la clé webhook (le serveur refuse de démarrer sinon). L'adresse de production de Campay est à confirmer à l'ouverture du compte réel (voir `docs/paiement-campay.md`). Le paiement manuel n'est proposé que si un numéro de réception est configuré.
- Deux couches parallèles existent déjà (stock WMS A/B) ; non modifié ici.
- La limite de 40 blocs de la bibliothèque ne s'applique plus aux blocs créés d'office : une organisation a désormais ~41 blocs visibles selon ses droits (les administrateurs voient tout). Les blocs de module sont masquables.
- Les captures sont des JPEG (≈ 12 Mo au total).
- Pas de passe `npm audit` (hors ligne).

## 6. Recoupements à connaître (données NON fusionnées, volontairement)

- **Organigrammes** : trois sources distinctes — `structure` (Organisation : unités et postes, existant), `history_people` (Histoire : personnes et dates de l'entreprise), `adm_units` / `adm_posts` (Administration : unités, postes, RACI, délégations). Aucune synchronisation : modifier l'un ne modifie pas les autres.
- **Fiches RH** : `rh_emp_profile` / `rh_job_profiles` / `rh_departments` (Talents) recoupent `hr` (fiches employés), `adm_posts` (postes) et `history_people`. Les départements RH et les unités d'Administration sont deux listes.
- **Trésorerie** : `tre_*` (module Trésorerie) coexiste avec la « trésorerie du stock » et la comptabilité (`accounting`, banque) ; tables séparées, aucun lien automatique (non vérifié module par module : à surveiller si les deux sont utilisés pour les mêmes soldes).
- **Commercial** : `cp_contacts` / `cp_opps` coexistent avec le module Clients et ventes (`crm`) et l'assistant commercial (`sales`).
- **Actions** : `mtg_actions` (Réunions), `adm_actions` (Administration), `rh_actions` / `rh_goals` (Talents) et les tâches de projets sont des listes séparées.

## 7. Commandes de poussée (à lancer par le fondateur)

Vérifié : `47a83d0`, `fusion-stock-serveur`, `origin/claude/postgres-react` et `origin/master` sont **ancêtres** de `fusion-modules` (serveur) ; `3b9b93c`, `fusion-stock-site` et `origin/main` le sont côté site (`git merge-base --is-ancestor`) : ce sont des **avances rapides**. Refaire `git fetch` d'abord et revérifier.

Sauvegarde Neon **avant** (voir `RAPPORT-DEPLOIEMENT.md`), puis, dans le dépôt serveur :

```bash
cd ~/Downloads/manager-ia-backend
git fetch origin
git merge-base --is-ancestor origin/claude/postgres-react fusion-modules && git merge-base --is-ancestor origin/master fusion-modules && echo "avance rapide OK"
git push origin fusion-modules:claude/postgres-react
git push origin fusion-modules:master
```

Attendre que Render ait déployé et que `/api/health` réponde (les migrations passent au démarrage), puis le site :

```bash
cd ~/Downloads/MANAGER-IA/site
git fetch origin
git merge-base --is-ancestor origin/main fusion-modules && echo "avance rapide OK"
git push origin fusion-modules:main
```

(Aucune option `--force`.)
