'use strict';
// Module « Réunions » : une seule migration, rejouable (CREATE TABLE / INDEX IF NOT EXISTS), tables préfixées mtg_.
// Aucune table existante n'est modifiée : les tâches de Projets sont référencées (task_id → tasks, ON DELETE SET NULL) sans changer tasks.
// Branchée à la fin du tableau MIGRATIONS de src/db.js (une ligne).
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS mtg_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    config TEXT NOT NULL DEFAULT '{}',
    updated_by BIGINT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mtg_meetings (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    series_id BIGINT,
    series_idx BIGINT NOT NULL DEFAULT 0,
    series_freq TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'team',
    date TEXT NOT NULL,
    start_time TEXT NOT NULL DEFAULT '09:00',
    duration_min BIGINT NOT NULL DEFAULT 60,
    place TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    link_kind TEXT NOT NULL DEFAULT '',
    objective TEXT NOT NULL DEFAULT '',
    confidential BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned',
    cancel_reason TEXT NOT NULL DEFAULT '',
    organizer_id BIGINT,
    secretary_id BIGINT,
    project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
    minutes_status TEXT NOT NULL DEFAULT 'none',
    minutes_version BIGINT NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    next_meeting TEXT NOT NULL DEFAULT '',
    return_reason TEXT NOT NULL DEFAULT '',
    reminder_min BIGINT NOT NULL DEFAULT 0,
    reminded_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_meetings_org ON mtg_meetings(org_id, date);
  CREATE INDEX IF NOT EXISTS idx_mtg_meetings_series ON mtg_meetings(series_id);

  CREATE TABLE IF NOT EXISTS mtg_participants (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    user_id BIGINT,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    required BIGINT NOT NULL DEFAULT 1,
    response TEXT NOT NULL DEFAULT 'pending',
    reason TEXT NOT NULL DEFAULT '',
    responded_at TEXT,
    attended TEXT NOT NULL DEFAULT 'unknown',
    invited_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_part_meeting ON mtg_participants(meeting_id);
  CREATE INDEX IF NOT EXISTS idx_mtg_part_user ON mtg_participants(org_id, user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mtg_part_unique_user ON mtg_participants(meeting_id, user_id) WHERE user_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS mtg_agenda (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    position BIGINT NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    owner_id BIGINT,
    owner_name TEXT NOT NULL DEFAULT '',
    duration_min BIGINT NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    done BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_agenda_meeting ON mtg_agenda(meeting_id, position);

  CREATE TABLE IF NOT EXISTS mtg_decisions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    agenda_id BIGINT REFERENCES mtg_agenda(id) ON DELETE SET NULL,
    position BIGINT NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_decisions_meeting ON mtg_decisions(meeting_id, position);

  CREATE TABLE IF NOT EXISTS mtg_actions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    agenda_id BIGINT REFERENCES mtg_agenda(id) ON DELETE SET NULL,
    position BIGINT NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    assignee_id BIGINT,
    assignee_name TEXT NOT NULL DEFAULT '',
    due TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
    reminded_stage BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_actions_meeting ON mtg_actions(meeting_id, position);
  CREATE INDEX IF NOT EXISTS idx_mtg_actions_org ON mtg_actions(org_id, status, due);
  CREATE INDEX IF NOT EXISTS idx_mtg_actions_task ON mtg_actions(task_id);

  CREATE TABLE IF NOT EXISTS mtg_minutes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    version BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted',
    content TEXT NOT NULL DEFAULT '{}',
    reason TEXT NOT NULL DEFAULT '',
    submitted_by BIGINT,
    submitted_at TEXT NOT NULL,
    decided_by BIGINT,
    decided_at TEXT,
    UNIQUE (meeting_id, version)
  );

  CREATE TABLE IF NOT EXISTS mtg_attachments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    doc_id BIGINT REFERENCES lib_docs(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    added_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_att_meeting ON mtg_attachments(meeting_id);

  CREATE TABLE IF NOT EXISTS mtg_templates (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'team',
    duration_min BIGINT NOT NULL DEFAULT 60,
    items TEXT NOT NULL DEFAULT '[]',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_templates_org ON mtg_templates(org_id);

  CREATE TABLE IF NOT EXISTS mtg_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT,
    user_id BIGINT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    n BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_log_meeting ON mtg_log(meeting_id, id);
  CREATE INDEX IF NOT EXISTS idx_mtg_log_org ON mtg_log(org_id, action, created_at);
  `,
];
