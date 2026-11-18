'use strict';
// Migrations du module « Histoire de l'entreprise » — ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (append-only, rejouables).
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS history_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    edit_min_role TEXT NOT NULL DEFAULT 'manager',
    editor_ids TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS history_people (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    level BIGINT NOT NULL DEFAULT 5,
    parent_id BIGINT REFERENCES history_people(id) ON DELETE SET NULL,
    employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
    start_date TEXT,
    end_date TEXT,
    departure_reason TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    photo_media_id BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history_people_org ON history_people(org_id);
  CREATE TABLE IF NOT EXISTS history_events (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    event_date TEXT NOT NULL,
    end_date TEXT,
    place TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    nature TEXT NOT NULL DEFAULT 'good',
    lesson TEXT NOT NULL DEFAULT '',
    success_factors TEXT NOT NULL DEFAULT '',
    minutes TEXT NOT NULL DEFAULT '',
    guests TEXT NOT NULL DEFAULT '[]',
    visibility TEXT NOT NULL DEFAULT 'internal',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history_events_org ON history_events(org_id, event_date);
  CREATE TABLE IF NOT EXISTS history_event_people (
    event_id BIGINT NOT NULL REFERENCES history_events(id) ON DELETE CASCADE,
    person_id BIGINT NOT NULL REFERENCES history_people(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, person_id)
  );
  CREATE TABLE IF NOT EXISTS history_media (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    event_id BIGINT REFERENCES history_events(id) ON DELETE CASCADE,
    person_id BIGINT REFERENCES history_people(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'image',
    size BIGINT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    taken_on TEXT,
    visibility TEXT NOT NULL DEFAULT 'internal',
    has_people BIGINT NOT NULL DEFAULT 0,
    consent BIGINT NOT NULL DEFAULT 0,
    data BYTEA NOT NULL,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_media_org ON history_media(org_id);
  CREATE INDEX IF NOT EXISTS idx_history_media_event ON history_media(event_id);
  `,
];
