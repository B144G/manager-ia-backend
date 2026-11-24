# Module Administration (MABAH)

Branches : serveur `administration-module` (depuis `fusion-final-serveur` 47a83d0), site `administration-module` (depuis `fusion-final-site` 3b9b93c). Rien n'est poussé.

Identifiant du module : `administration` (menu « Administration », rôle minimal : membre ; les droits fins sont contrôlés côté serveur).
Routes : `/api/ws/orgs/:orgId/administration/...`. Tables : préfixe `adm_` (une seule migration rejouable, `src/migrations/administration.js`, branchée en **fin** du tableau `MIGRATIONS` par une ligne dans `src/db.js`).

## Ce qui est lu, jamais modifié
| Source | Usage |
|---|---|
| `positions`, `org_members`, `users` | organigramme, titulaires, personnes |
| `fixed_assets` (Comptabilité) | lien facultatif d'un bien avec son immobilisation (administrateurs) |
| `legal_contracts` (Juridique) | reprise facultative des contrats dans le registre |
| `pur_orders`, `pur_invoices`, `pur_payments` (Achats) | activité réelle observée pour détecter les cumuls de fonctions |
| `mtg_meetings` (module Réunions, **si présent**) | prochaines réunions non confidentielles dans le tableau de bord ; sinon lien vide |
| `rh_goals` (RH talents, **si présent**) | objectifs d'entreprise et de service (jamais individuels) ; sinon le petit tableau `adm_goals` sert de suivi |

Le module Réunions et RH talents (sessions parallèles) ne sont pas recréés ici : l'Administration ajoute un raccourci (entrée de menu « Réunions » si le module existe) et lit leurs tables par `to_regclass` (aucune erreur si elles sont absentes).

## Droits désignés par le propriétaire (`/settings`, PUT réservé au propriétaire)
Dix droits, chacun désignable **par personne ou par rôle** : `flow_design` (créer les circuits), `flow_validate` (les valider / mettre en service), `sop_write`, `sop_approve`, `docs_manage`, `docs_destroy`, `control_manage`, `assets_manage`, `contracts_manage`, `org_manage`.
Par défaut : circuits = propriétaire seul ; les autres suivent un rôle minimal (responsable ou administrateur). Une désignation **remplace** la règle par défaut. L'option `distinct` impose « créé par l'un, validé par l'autre » (circuits, procédures), sauf si personne d'autre n'a le droit.

## Les huit parties
1. **Organisation** (`/org`) : services (`adm_units`), fiches de poste (`adm_posts`, une par poste de `positions`), matrice RACI (R réalise, A dirige et valide, S supervise, C consulté, I informé ; contrôle : un seul A et au moins un R par activité), délégations et intérim avec plafond (`adm_delegations`), export PDF (l'image PNG est produite par le site à partir du SVG).
2. **Procédures** (`/sops`) : 11 modèles de PME, statuts brouillon → relue → approuvée → obsolète, version à chaque modification d'une procédure déjà relue/approuvée, comparaison de versions, accusé de lecture par version (lecteurs = rôles / personnes), rappel de révision (une seule fois par échéance).
3. **GED et archives** (`/docs`) : plan de classement, types de documents avec **durée de conservation réglable** (`active_years` avant archive, `retention_years` total, 0 = permanente ; changer la règle recalcule les échéances), versions chiffrées (AES-256-GCM) avec empreinte SHA-256, confidentialité public / interne / restreint / secret + désignations, recherche plein texte (nom, métadonnées, contenu des fichiers texte et PDF — texte des PDF extrait quand il n'est pas dans des flux exotiques), verrou et prêt (423 si autrui), archivage **scellé** (empreinte sur versions + métadonnées, `GET /:id/verify` détecte toute altération), destruction demandée puis validée par **une autre personne** (le contenu est effacé, les empreintes restent), corbeille 30 jours, journal d'accès.
4. **Circuits** (`/flow`) : étapes séquentielles, approbateurs en parallèle (`any` un seul / `all` chacun), approbateur par rôle / personne / poste, seuil de montant par étape (une étape hors seuil est ignorée), délai et **escalade automatique** (déclenchée à la lecture de la boîte, des demandes ou des indicateurs, et par `POST /flow/sweep` ; une fois par étape ; la personne d'escalade peut trancher seule), suppléant, intérim/délégation avec plafond, demandeur jamais approbateur de sa propre demande (un dirigeant décide à sa place), boîte « à valider », historique, indicateurs de délai.
5. **Contrôle interne** (`/control`) : 20 fonctions (autoriser / exécuter / enregistrer / contrôler) et 12 règles d'incompatibilité prêtes à charger (`/sod/seed`), affectations directes, par rôle, par poste, et **activité observée** dans Achats ; détection automatique des conflits (gravité haute/moyenne/faible), dérogations motivées avec contrôle compensatoire, registre des risques (carte 5×5), registre des contrôles (fréquence, preuve, résultat, échéance calculée), actions correctives (créées automatiquement quand un contrôle échoue), **score de maturité** sur 100 en 6 domaines pondérés (niveau 1 à 5).
6. **Moyens généraux** (`/means`) : inventaire (catégories, véhicules : plaque et kilométrage), attribution avec historique, échéances récurrentes (assurance, contrôle technique, entretien), coûts par bien/mois/nature, locaux et salles avec réservations sans chevauchement, fournitures avec seuil d'alerte, demandes de moyens (la remise sort le stock).
7. **Contrats et conformité** (`/contracts`) : contrats avec préavis, reconduction tacite (fin effective recalculée), alertes (`notice_soon`, `notice_missed`, `ending_soon`, `expired`), pièces de la GED, valeur annuelle ; registre de conformité sans texte de loi inventé (autorité et référence saisies par l'entreprise, 12 suggestions génériques), preuve obligatoire, échéance suivante calculée pour les obligations récurrentes. Lecture réservée aux responsables et plus.
8. **Reporting** (`/report`) : tableau de bord (16 indicateurs, liste « à traiter » classée par urgence, graphiques), rapport mensuel `monthly`, `monthly.pdf`, `monthly.xlsx` (classeur écrit sans dépendance, `src/services/mini-xlsx.js`), objectifs.

## Alertes
Notifications internes (`notices`), **une seule fois par échéance** (table `adm_alerts`) : procédures à réviser, documents à archiver / à détruire, échéances de moyens, contrats, obligations. Elles sont émises au passage du tableau de bord (`/report/dashboard`, `POST /report/sweep`) : aucun fichier partagé (`jobs.js`) n'a été modifié.

## Tests et vérifications
- `node scripts/test-administration.js` (aussi `npm run test:administration`, ajouté à la fin de `test:chain` ; exécuté par `scripts/run-all-tests.js`) : **222 contrôles** sur serveur et PostgreSQL jetables, dont détection de conflits (1 puis 3 puis 2 conflits selon affectations et dérogation), escalade (étape marquée, escaladeur tranche), durées de conservation (2022-01-15 / 2030-01-15 puis 2025-01-15 après changement de règle), alertes d'échéance de contrats (3 alertes sur 5, reconduction tacite = 2 périodes, valeur annuelle 5 400 000), droits par rôle (403 pour un membre, désignations), isolation entre organisations (404 sur chaque module), falsification détectée, rapport mensuel PDF/Excel.
- `scripts/lib/wave1.js` : la durée d'attente du démarrage du serveur de test se règle par `TEST_START_TRIES` (250 ms par essai, 80 par défaut).

## Limites connues
- Les messages d'erreur du serveur sont en français (comme le reste du serveur) ; le site traduit ses propres textes (FR/EN/DE/ES).
- Le texte d'un PDF n'est extrait que si les chaînes sont lisibles dans le flux (PDF générés par traitement de texte ou pdfkit : oui ; scans : non).
- Un fichier de GED fait au plus 8 Mo, 150 Mo par organisation (stockés chiffrés dans PostgreSQL : surveiller la taille de la base).
- Les durées de conservation fournies sont **indicatives** ; aucune référence légale n'est écrite dans le logiciel.

## Fusion
Serveur (depuis le dépôt `manager-ia-backend`, branche de production `claude/postgres-react` ou la ligne `fusion-final-serveur`) :
```bash
git merge --no-ff administration-module
```
Conflits probables, d'une ligne chacun : `src/db.js` (ligne `MIGRATIONS.push(...require('./migrations/administration'))` à placer après celles des autres modules), `src/workspace/index.js` (`orgRouter.use('/administration', ...)`), `src/workspace/modules.js` (entrée `administration`), `package.json` (`test:administration`, fin de `test:chain`) et `scripts/lib/wave1.js` (`TEST_START_TRIES`, déjà présent dans `fusion-stock-serveur`).
Site :
```bash
git merge --no-ff administration-module
```
Conflits probables : `src/ws/registry.js` (icône `administration`). Ajouts seuls ailleurs : `src/ws/modules/administration.jsx`, `src/ws/parts/administration/`, `src/styles/ws-administration.css`, `src/i18n/{en,de,es}/ws-administration.js`.
