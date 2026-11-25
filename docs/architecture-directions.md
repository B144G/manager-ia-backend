# Architecture des directions de MABAH

Source : spécification du fondateur (`specs/directions-specification.md`). Règle centrale : **un commercial n'est pas le directeur commercial** (idem pour chaque branche). Chaque directeur a son espace « Direction de département », séparé de l'espace opérationnel de son équipe, qu'il ne voit qu'en visiteur.

## 1. Audit réel : spécification → existant

Méthode : lecture du code (routes, tables, modules), pas seulement une recherche de mots. « oui » = écran et données existent ; « partiel » = existe mais incomplet ; « absent » = rien.

### A. Direction générale
| Fonction / KPI | Existant | État |
|---|---|---|
| Objectifs stratégiques annuels/trimestriels/mensuels | `dir_objectives` (espace de direction) | oui (nouveau) |
| Supervision de toutes les directions | cockpit `dir_general` + vue visiteur sur les autres directions | oui |
| Validation budgets / investissements / contrats / recrutements | circuits `adm-flow` (achat, marché, recrutement, paiement) | oui |
| Rentabilité des projets | `projects-fin`, `proj-fin-lib` | partiel (par projet, pas par affaire) |
| Risques de l'entreprise | Administration › Contrôle interne (registre des risques) | oui |
| Évaluer les performances des directeurs | objectifs de direction (taux d'atteinte) | partiel |
| Arbitrage entre directions | décisions (`decisions.js`) | partiel |

### B. Direction commerciale (fiche à concevoir)
Rôle : générer le chiffre d'affaires et fidéliser les clients. Missions : piloter le pipeline, fixer et suivre les objectifs de vente, valider remises et marchés, suivre devis, factures et satisfaction. Fonctionnalités : pipeline, prospects, devis, clients, satisfaction (module Commercial existant). KPI : pipeline, taux de conversion, nouveaux prospects, devis en attente, NPS, factures en retard. État : **oui** (cockpit réel).

### C. DAF
| Fonction | Existant | État |
|---|---|---|
| Comptabilité générale, SYSCOHADA, liasse | `accounting`, `syscohada`, `fiscal` | oui |
| Comptabilité analytique | `acc-pro` (sections/projets) | partiel (non actif par défaut) |
| Budget annuel | `budget-annual`, `budget-pro` | oui |
| Trésorerie, banques, caisses | `treasury`, `acc-bank` | oui |
| Créances / dettes, factures | `crm` factures, `pur-invoices` | oui |
| Immobilisations | `acc-ops`, `adm-assets` | oui |
| Avances et prêts au personnel | paie (acomptes) | partiel |
| Contrôle de gestion (écarts, marges) | `projects-fin`, `acc-pro-analytics` | partiel — pas de module dédié |
| KPI coût de revient, taux d'endettement | — | « non disponible » affiché avec la consigne |

### D. Direction technique
| Fonction | Existant | État |
|---|---|---|
| Chantiers, phases, avancement, coûts | `construction` | oui |
| Incidents, sécurité, réserves (déclaration) | `construction` (issues incident/safety/snag) | partiel (pas de traitement ni de clôture contrôlée) |
| Équipements, maintenance | `maintenance` | oui |
| Qualité de production | `prod-quality-lib` | partiel (production seulement) |
| Non-conformités, réception technique | — | **absent** (P2) |
| Devis quantitatifs, métrés | — | **absent** (P3) |
| Études et plans | bibliothèque / documents | partiel |

### E. DRH
Effectifs, recrutement, contrats, formations, évaluations, carrières, paie, congés, pointage : `rh-*`, `payroll` — **oui**. Sanctions disciplinaires : seulement côté juridique, pas de registre RH — **absent** (P3). Accidents du travail : taux de paie seulement — **absent** (P2, QHSE).

### F. Opérations / Production
Ordres de fabrication, rendements, pertes, TRS, qualité : `production*`, `prod-*` — **oui**. Tableau de bord opérationnel : cockpit `dir_production`. Gestion des incidents : partiel.

### G. Achats et logistique
Demandes d'achat, appels d'offres, commandes, réceptions, fournisseurs, notation : `pur-*` — **oui**. Stocks, inventaires, transferts : `stock`, `wms-*` — **oui**. Véhicules, tournées, livraisons : `logistics`, `tms-*` — **oui**. Approvisionnement par projet : partiel.

### Fonctions intermédiaires (section 3)
Responsable comptable, trésorier, contrôleur de gestion, responsable administratif/juridique/magasin/maintenance, chef de chantier/production : couverts par les écrans existants et les postes ; **espace « responsable » opérationnel, sans accès au cockpit** (règle appliquée : le cockpit exige le niveau « manage » de l'espace de direction, réservé au directeur). QHSE et auditeur interne : **absents** (P2).

### Modules transversaux (section 5)
| Module | État |
|---|---|
| Direction générale, CRM, Projets, Technique, Finance, RH, Achats, Stocks, Production, Logistique, Maintenance, Administration, Juridique, Workflow, GED | oui |
| Reporting | oui (rapports de direction) |
| Contrôle de gestion | partiel |
| QHSE | absent (P2) |
| Audit | partiel (journal de traçabilité, pas d'audit interne structuré) (P2) |
| Gestion des affaires | absent (P2) |

## 2. Architecture par direction

Chaque direction (11 espaces `dir_*`) a : **cockpit** (indicateurs calculés sur des données réelles ; sinon « non disponible » + ce qu'il faut renseigner), **file de validations** (circuits adm-flow), **missions** (liens vers les écrans de l'équipe, en consultation), **rapports**, **tâches / notes / objectifs** privés de la direction. Un seul point d'entrée par direction ; aucun écran du personnel n'est dupliqué.

Séparation : le personnel n'obtient jamais l'espace de direction ; le directeur obtient l'espace opérationnel en visiteur (lecture) par défaut, relevable par le DG/propriétaire.

## 3. Validations et séparation des tâches

Aucun moteur parallèle : les circuits utilisent `adm-flow` (délégations, intérim, escalade, journal). Ajouts : validateurs de type « poste » (`epost`) et « direction générale » (`edg`). Règle appliquée par le moteur : **l'initiateur ne valide jamais sa propre demande**. Seuil de montant configurable (étape DG au-delà de 5 000 000).

| Opération | Initiateur | Validateur(s) |
|---|---|---|
| Demande d'achat | Chef de chantier / responsable | Responsable technique |
| Vérification du budget | DAF / contrôle de gestion | DAF ou délégataire |
| Commande fournisseur | Achats | Direction des achats (+ DG au-delà du seuil) |
| Recrutement | DRH | DG ou délégataire |
| Paiement fournisseur | Comptabilité | DAF (+ DG au-delà du seuil) |
| Validation d'un marché | Direction commerciale | DG |
| Réception technique | Chef de projet | Direction technique |
| Clôture financière | Comptabilité / contrôle de gestion | DAF |

Réglage : Entreprise › Circuits de validation (installer, modifier étapes et montants). Limite honnête : les approbations de dépenses et de commandes déjà existantes restent dans leurs écrans (le cockpit les liste et renvoie).

## 4. Interactions (cycle d'un projet BTP)
Commercial (marché) → technique (étude, planning) → finances (budget) → achats/logistique → RH (affectation) → opérations → chef de chantier → contrôle de gestion → DG. Aujourd'hui les liens passent par les circuits de validation ; le dossier « affaire » qui les relie est prévu en P2.

## 5. Priorités
- **P1** (fait) : cockpits réels, circuits de validation, séparation des tâches.
- **P2** : QHSE (incidents, accidents, inspections), non-conformités et réserves, réception technique, audit interne, gestion des affaires.
- **P3** (documenté) : sanctions disciplinaires, devis quantitatifs et métrés, contrôle de gestion dédié, avances au personnel.
