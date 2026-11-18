'use strict';
// Migrations « Projets & Production » : PERT, dépendances, catégories de risque, recherche opérationnelle, circuits de production.
// Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (append-only). Rejouables : IF NOT EXISTS partout, jamais de renommage ni de suppression.
module.exports = [
  // Type de projet (général / vente / production) et catégorie de risque (délai, coût, ressource, fournisseur, qualité, autre).
  `
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'general';
  ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other';
  `,
  // Estimations PERT par tâche (jours) et dépendances (entre tâches avec type et décalage, ou externes : fournisseur, client, autorisation).
  `
  CREATE TABLE IF NOT EXISTS project_pert (
    task_id BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    optimistic DOUBLE PRECISION NOT NULL,
    likely DOUBLE PRECISION NOT NULL,
    pessimistic DOUBLE PRECISION NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_pert ON project_pert(org_id, project_id);
  CREATE TABLE IF NOT EXISTS project_deps (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'task',
    dep_type TEXT NOT NULL DEFAULT 'FS',
    pred_task_id BIGINT,
    succ_task_id BIGINT,
    lag_days BIGINT NOT NULL DEFAULT 0,
    ext_kind TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    expected_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    owner_id BIGINT,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_deps ON project_deps(org_id, project_id);
  `,
  // Recherche opérationnelle : scénarios enregistrés (hypothèses + résultat) d'un projet de vente ou de production.
  `
  CREATE TABLE IF NOT EXISTS ro_scenarios (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    inputs TEXT NOT NULL,
    result TEXT NOT NULL,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ro_scenarios ON ro_scenarios(org_id, project_id);
  `,
  // Circuits de production (workflows) : étapes en JSON, avis écartés par l'utilisateur.
  `
  CREATE TABLE IF NOT EXISTS production_flows (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sector TEXT NOT NULL DEFAULT 'general',
    source TEXT NOT NULL DEFAULT 'custom',
    target_per_day DOUBLE PRECISION NOT NULL DEFAULT 1,
    hours_per_day DOUBLE PRECISION NOT NULL DEFAULT 8,
    steps TEXT NOT NULL DEFAULT '[]',
    dismissed TEXT NOT NULL DEFAULT '[]',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_production_flows ON production_flows(org_id);
  `,
  // Finances du projet : structure des coûts (CBS), coûts par activités (ABC), rentabilité (ROI), budget prévisionnel — un document JSON par type.
  `
  CREATE TABLE IF NOT EXISTS project_fin_docs (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_by BIGINT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, kind)
  );
  `,
];
