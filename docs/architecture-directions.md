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
- **Recadrage du fondateur** : seuls comptent les espaces de direction séparés (P1) et « un espace = un rôle » (§9). Les modules QHSE, Audit interne et Affaires (§6), construits avant ce recadrage, sont **masqués par défaut** (§10). Rien d'autre n'est construit.
- **P3** (documenté, rien à construire) : sanctions disciplinaires, devis quantitatifs et métrés, contrôle de gestion dédié, avances au personnel.

## 6. Modules ajoutés en P2

| Module | Espace | Contenu | Règles de séparation |
|---|---|---|---|
| QHSE (`qhse`) | Opérations | fiches : incident, accident du travail (personnes, jours d'arrêt), inspection, non-conformité, réserve, réception technique ; action corrective, responsable, échéance | le déclarant ne clôture jamais sa fiche ; une réception ne se clôture qu'après approbation du circuit « Réception technique » |
| Audit interne (`audit_interne`) | Administration et juridique | audits planifiés, constats (fiches de non-conformité rattachées), conclusion | seul l'auditeur désigné consigne et conclut ; il ne clôture pas ses propres constats ; un audit avec constats ne se supprime pas |
| Gestion des affaires (`affaires`) | Commercial | dossier d'un marché : prospection → négociation → contrat → étude → exécution → réception → clôture financière → clôturée (ou perdue avant contrat) ; fiche de synthèse (marge prévue, chantier relié et son avancement, projet, fiches qualité ouvertes) | une étape à la fois ; le contrat exige « Validation d'un marché » approuvée ; la clôture exige « Clôture financière » approuvée ; chaque étape indique la direction responsable |

Tables : `qhse_items`, `aud_audits`, `affaires` (migrations 453–455, additives). Indicateurs de cockpit désormais réels : accidents du travail et jours perdus, incidents ouverts, constats d'audit ouverts, taux de conformité technique (réceptions validées / réceptions), taux de reprise (non-conformités sur 90 jours rapportées aux contrôles, plafonné à 100 %).

Limites honnêtes : le taux de reprise est un indicateur de substitution (nous n'avons pas de saisie des reprises de travaux elle-même) ; une affaire ne crée pas automatiquement le chantier, le projet ni les achats : elle les relie (liens saisis) ; les dépenses réelles par affaire ne sont pas encore consolidées (voir P3).

## 7. P3 — écarts documentés, non traités

1. **Sanctions disciplinaires** : pas de registre RH (seul le juridique en parle).
2. **Devis quantitatifs et métrés** : absents ; les devis commerciaux existent mais sans bordereau de quantités.
3. **Contrôle de gestion dédié** : écarts budget/réel consolidés par affaire (achats, paie, sous-traitance) ; aujourd'hui seulement par projet et par chantier.
4. **Avances et prêts au personnel** : traités dans la paie uniquement.
5. **Approvisionnement par projet / affaire** : pas de lien direct commande → affaire.
6. **Habilitations et formations de sécurité** par poste (QHSE avancé), registre des risques par chantier.
7. **Validation des dépenses et commandes déjà existantes** : restent dans leurs écrans ; seule une file d'attente les liste dans le cockpit.
8. **Diffusion des rapports de direction** par courriel planifié.

## 8. Captures (démonstration locale)
`docs/captures-direction/` : directeur commercial (espace de direction) face au commercial (espace d'équipe), le directeur commercial en visiteur sur l'espace de son équipe, affaires, QHSE, directeur technique — en clair, sombre et mobile. Produites par `scripts/demo-direction.js` (entreprise BTP de démonstration, ports 3420/5420) et `scripts/demo/capture-direction.js`.

## 9. Un espace = un rôle (catalogue unique)

**Principe.** Le département n'est qu'un regroupement d'organigramme. Chaque rôle (poste du modèle d'entreprise) a son propre espace, avec uniquement les écrans de son métier. Une personne ne voit dans son pied de page que les espaces des rôles qu'elle détient (multi-rôles : union, sans doublon). Pour accéder à l'espace Marketing, il faut être marketeur ; un commercial, un assistant commercial ou le directeur commercial ne l'ont pas, sauf affectation explicite du propriétaire.

**Source unique de vérité** : `src/workspace/ent-roles.js` (rôle → écrans propres + écrans partagés d'un autre métier, déclarés un à un). Un même écran peut figurer dans plusieurs espaces de rôle (la contrainte « un module = un seul espace » est levée) ; l'accès à un écran est le niveau le plus haut parmi les espaces de la personne qui le contiennent, contrôlé côté serveur (visiteur : lecture ; membre : écriture ; responsable : gestion).

**Qui reçoit quoi.**
- Directeurs : espace de direction (§2) ; l'espace opérationnel de leur équipe seulement en visiteur ; jamais les espaces de rôle de leur équipe.
- Personnel : l'espace de SON rôle (niveau du modèle : responsable de département = responsable, sinon membre ou le niveau d'origine du poste) + « Projets et réunions » (ouvert à tous).
- Poste personnalisé par le propriétaire, poste sans rôle au catalogue (agent de sécurité) : ses espaces d'origine, inchangés.
- Personne sans poste affecté : **repli sûr** sur les 9 espaces historiques (aucun accès perdu), jamais d'espace de rôle ni de direction.
- Propriétaire et administrateurs : les 9 espaces historiques complets ; un espace de rôle seulement s'il leur est affecté explicitement.
- « Aucun » affecté explicitement sur un espace historique retire aussi les espaces de rôle de ce métier.

**Mode simple et retour arrière.** Les 9 espaces historiques restent : ils sont le repli et le **mode simple**, que le propriétaire choisit en coupant le réglage « espaces de direction » (Entreprise › Espaces de direction) ; les espaces de rôle disparaissent alors avec eux et chacun retrouve ses espaces historiques. Interrupteur général : `DIRECTION_SPACES=off`. Aucune migration destructive.

**Charge utile `spaces` inchangée** (id, libellé, icône, niveau, via, liste des modules) : la navigation l'affiche telle quelle.

### Catalogue rôle → écrans → niveau
| Espace de rôle | Poste du modèle (tkey) | Métier | Écrans propres | Écrans partagés d'un autre métier | Niveau |
|---|---|---|---|---|---|
| `r_finance_comptable` — Comptable | `finance.comptable` | finances | accounting, fiscal, treasury, budget | crm, parties | membre (écriture) ; niveau du modèle si plus élevé |
| `r_finance_tresorier` — Trésorier | `finance.tresorier` | finances | treasury, budget, accounting | crm | membre (écriture) ; niveau du modèle si plus élevé |
| `r_finance_caissier` — Caissier | `finance.caissier` | finances | treasury | crm | membre (écriture) ; niveau du modèle si plus élevé |
| `r_finance_controleur` — Contrôleur de gestion | `finance.controleur` | finances | budget, accounting | dashboard, aifollow, history | membre (écriture) ; niveau du modèle si plus élevé |
| `r_pilotage_resp_pilotage` — Responsable du pilotage | `pilotage.resp_pilotage` | direction | dashboard, aifollow, history, structure, processes, memory, agents | budget, accounting, audit_interne | responsable |
| `r_pilotage_analyste` — Analyste de gestion | `pilotage.analyste` | direction | dashboard, aifollow, history | budget, accounting | membre (écriture) ; niveau du modèle si plus élevé |
| `r_pilotage_assistant_dir` — Assistant(e) de direction | `pilotage.assistant_dir` | gestion | administration | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_rh_resp_rh` — Responsable des ressources humaines | `rh.resp_rh` | rh | hr, talents, payroll | — | responsable |
| `r_rh_paie` — Gestionnaire de paie | `rh.paie` | rh | payroll, hr | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_rh_recrutement` — Chargé(e) de recrutement | `rh.recrutement` | rh | talents, hr | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_commercial_resp_com` — Responsable commercial | `commercial.resp_com` | commercial | commercial, crm, sales, parties, support, affaires | — | responsable |
| `r_commercial_resp_terrain` — Responsable commercial terrain | `commercial.resp_terrain` | commercial | commercial, crm, parties, affaires | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_commercial_vendeur` — Commercial / vendeur | `commercial.vendeur` | commercial | commercial, crm, parties, affaires | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_commercial_assist_com` — Assistant(e) commercial(e) | `commercial.assist_com` | commercial | sales, crm | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_commercial_service_client` — Agent du service client | `commercial.service_client` | commercial | support, crm | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_marketing_resp_mkt` — Responsable marketing | `marketing.resp_mkt` | marketing | marketing | — | responsable |
| `r_marketing_community` — Community manager | `marketing.community` | marketing | marketing | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_production_chef_prod` — Chef de production | `production.chef_prod` | production | production | maintenance, stock, qhse | responsable |
| `r_production_operateur` — Opérateur de production | `production.operateur` | production | production | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_production_qualite` — Contrôleur qualité | `production.qualite` | production | production | qhse | membre (écriture) ; niveau du modèle si plus élevé |
| `r_production_conducteur` — Conducteur de travaux | `production.conducteur` | chantiers | construction | stock, projects, qhse | responsable |
| `r_production_metreur` — Métreur | `production.metreur` | chantiers | construction | stock | membre (écriture) ; niveau du modèle si plus élevé |
| `r_production_chef_chantier` — Chef de chantier | `production.chef_chantier` | chantiers | construction | qhse | membre (écriture) ; niveau du modèle si plus élevé |
| `r_production_chef_projet` — Chef de projet | `production.chef_projet` | projets | projects | — | responsable |
| `r_production_consultant` — Consultant(e) | `production.consultant` | projets | projects | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_achats_resp_stock` — Responsable stock et achats | `achats.resp_stock` | stock | stock, purchasing | parties | responsable |
| `r_achats_acheteur` — Acheteur | `achats.acheteur` | stock | purchasing, stock | parties | membre (écriture) ; niveau du modèle si plus élevé |
| `r_achats_magasinier` — Magasinier | `achats.magasinier` | stock | stock, purchasing | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_logistique_resp_log` — Responsable logistique | `logistique.resp_log` | logistique | logistics | maintenance, stock, qhse | responsable |
| `r_logistique_dispatcheur` — Dispatcheur | `logistique.dispatcheur` | logistique | logistics | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_logistique_chef_parc` — Chef de parc | `logistique.chef_parc` | logistique | logistics | maintenance | responsable |
| `r_logistique_chauffeur` — Chauffeur | `logistique.chauffeur` | logistique | logistics | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_logistique_livreur` — Livreur | `logistique.livreur` | logistique | logistics | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_informatique_resp_it` — Responsable informatique et maintenance | `informatique.resp_it` | maintenance | maintenance | logistics, integrations | responsable |
| `r_informatique_technicien` — Technicien(ne) | `informatique.technicien` | maintenance | maintenance | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_informatique_mecanicien` — Mécanicien | `informatique.mecanicien` | maintenance | maintenance | — | membre (écriture) ; niveau du modèle si plus élevé |
| `r_securite_resp_securite` — Responsable sécurité | `securite.resp_securite` | gestion | legal, administration, audit_interne | qhse | responsable |

Métiers des écrans (détection des recouvrements) : voir `METIER_OF` dans `ent-roles.js`.

### Garde-fous (testés : `npm run test:espaces-roles`)
1. **L'espace est la porte, pas l'ensemble des droits.** À l'intérieur d'un écran partagé, le serveur applique le niveau (visiteur/membre/responsable) puis la portée propre à l'écran. État réel, vérifié dans le code :
   - Commercial (pipeline, opportunités, prospects) : portée par rôle commercial (`commercial/perm.js`) — le commercial terrain ne voit que ses comptes ; l'assistant prépare sans valider ; le responsable voit tout. **OK**.
   - Clients et ventes (CRM), comptabilité, stock, achats : portée par **antenne** (`A.scope`) seulement ; pas de filtre « mes éléments » : un vendeur qui ouvre le CRM voit les clients de son antenne. **Écart documenté**, comportement identique à avant ce chantier ; à décider par le fondateur (portée « mes clients »).
   - Trésorerie et RH : rôles propres (`tre_roles`, `rh_roles`) en plus de l'espace. **OK**.
2. **Petites entreprises** : le mode simple (9 espaces) reste choisissable ; une personne multi-rôles voit ses espaces de rôle sans doublon.
3. **Catalogue testé** : aucun module orphelin, aucun recouvrement accidentel (un rôle ne reçoit un écran d'un autre métier que s'il est déclaré « partagé »), chaque rôle atteignable depuis un poste du modèle, cohérence avec les 22 profils de l'étape 3 (chaque rôle a son profil dont les écrans recoupent les siens).

## 10. Modules complémentaires masqués par défaut (QHSE, Audit interne, Affaires)
Construits avant le recadrage, conservés mais **invisibles** : sans activation du propriétaire (Entreprise › réglage « modules complémentaires », `POST /entreprise/extras/enable`), ni écran, ni route (404), ni entrée de menu ou d'espace. `EXTRA_MODULES=off` les coupe pour toutes les entreprises. Migrations 453–456 additives. Leurs commits sont distincts (voir le rapport final) : ils peuvent être exclus de la poussée sans toucher au cœur (directions séparées + espaces de rôle). Les indicateurs de cockpit qui en dépendent (accidents, constats d'audit, conformité, reprise) restent « non disponibles » tant qu'ils sont masqués.
