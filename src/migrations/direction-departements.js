'use strict';
// Espaces de direction de département : migrations 450 et 451 (444 à 449 réservées). Append-only, additives.
//  450 : réglage par organisation « espaces de direction » (désactivé tant que le propriétaire ne l'active pas : aucune entreprise existante ne change) ;
//  451 : tâches, notes (dossiers) et objectifs PROPRES à un espace de direction : tables séparées, jamais visibles du personnel du département ;
//  452 : paramétrage par l'entreprise des circuits de validation de direction (installés dans le moteur de circuits d'Administration, adm_flows : aucun moteur parallèle).
module.exports = [
  `
  ALTER TABLE ent_setup ADD COLUMN IF NOT EXISTS dir_spaces INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE IF NOT EXISTS dir_tasks (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    space TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'todo',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE INDEX IF NOT EXISTS dir_tasks_space ON dir_tasks (org_id, space, id);
  CREATE TABLE IF NOT EXISTS dir_notes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    space TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dir_notes_space ON dir_notes (org_id, space, id);
  CREATE TABLE IF NOT EXISTS dir_objectives (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    space TEXT NOT NULL,
    title TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    target DOUBLE PRECISION NOT NULL DEFAULT 0,
    current DOUBLE PRECISION NOT NULL DEFAULT 0,
    due TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dir_objectives_space ON dir_objectives (org_id, space, id);
  `,
  `
  CREATE TABLE IF NOT EXISTS ent_workflows (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    flow_id BIGINT,
    updated_by BIGINT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, key)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS qhse_items (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    place TEXT NOT NULL DEFAULT '',
    site_id BIGINT,
    affaire_id BIGINT,
    audit_id BIGINT,
    severity TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open',
    declared_by BIGINT,
    assignee_id BIGINT,
    due_date TEXT,
    corrective TEXT NOT NULL DEFAULT '',
    persons INTEGER NOT NULL DEFAULT 0,
    days_lost INTEGER NOT NULL DEFAULT 0,
    request_id BIGINT,
    closed_by BIGINT,
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS qhse_items_org ON qhse_items (org_id, kind, status);
  `,
  `
  CREATE TABLE IF NOT EXISTS aud_audits (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    planned_date TEXT,
    auditor_id BIGINT,
    status TEXT NOT NULL DEFAULT 'planned',
    conclusion TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    done_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS aud_audits_org ON aud_audits (org_id, status);
  `,
  `
  CREATE TABLE IF NOT EXISTS affaires (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    ref TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    client TEXT NOT NULL DEFAULT '',
    amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    budget DOUBLE PRECISION NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'prospection',
    project_id BIGINT,
    site_id BIGINT,
    owner_id BIGINT,
    start_date TEXT,
    end_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS affaires_org ON affaires (org_id, stage);
  `,
  `ALTER TABLE ent_setup ADD COLUMN IF NOT EXISTS extra_modules INTEGER NOT NULL DEFAULT 0`,
];
