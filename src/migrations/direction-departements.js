'use strict';
// Espaces de direction de département : migrations 450 et 451 (444 à 449 réservées). Append-only, additives.
//  450 : réglage par organisation « espaces de direction » (désactivé tant que le propriétaire ne l'active pas : aucune entreprise existante ne change) ;
//  451 : tâches, notes (dossiers) et objectifs PROPRES à un espace de direction : tables séparées, jamais visibles du personnel du département.
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
];
