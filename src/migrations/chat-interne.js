'use strict';
// Chat interne (tables chat_) : migrations 300 et suivantes (append-only : ne jamais modifier une migration existante).
//  300 : réglages de l'entreprise, préférences de chaque personne, conversations, participants, messages, fichiers, messages épinglés ;
//  301 : sondages, messages programmés, rappels, tâches créées depuis un message ;
//  302 : appels et réunions audio / vidéo (historique, participants) ;
//  303 : position en direct, activée librement par chaque employé (consentement, effaçable) ;
//  304 : chiffrement de bout en bout des conversations à deux (clés PUBLIQUES seulement : les clés privées ne quittent jamais l'appareil).
// Les fichiers sont stockés dans la base (colonne BYTEA), comme le reste du produit : le disque du serveur peut être éphémère.
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS ci_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    max_file_mb BIGINT NOT NULL DEFAULT 8,
    allowed_kinds TEXT NOT NULL DEFAULT '["image","pdf","word","excel","video","audio","text"]',
    ai_enabled BIGINT NOT NULL DEFAULT 1,
    calls_enabled BIGINT NOT NULL DEFAULT 1,
    groups_by TEXT NOT NULL DEFAULT 'all',
    updated_by BIGINT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ci_prefs (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_receipts BIGINT NOT NULL DEFAULT 1,
    show_presence BIGINT NOT NULL DEFAULT 1,
    last_seen TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS ci_conversations (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'direct',
    purpose TEXT NOT NULL DEFAULT 'general',
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
    direct_key TEXT,
    ai_enabled BIGINT NOT NULL DEFAULT 0,
    only_admins_post BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    last_message_id BIGINT,
    last_at TEXT NOT NULL,
    UNIQUE (org_id, direct_key)
  );
  CREATE INDEX IF NOT EXISTS idx_ci_conv_org ON ci_conversations(org_id, last_at);
  CREATE TABLE IF NOT EXISTS ci_members (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    conv_id BIGINT NOT NULL REFERENCES ci_conversations(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    from_id BIGINT NOT NULL DEFAULT 0,
    last_read_id BIGINT NOT NULL DEFAULT 0,
    last_delivered_id BIGINT NOT NULL DEFAULT 0,
    muted BIGINT NOT NULL DEFAULT 0,
    archived BIGINT NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL,
    left_at TEXT,
    UNIQUE (conv_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ci_members_user ON ci_members(org_id, user_id);
  CREATE TABLE IF NOT EXISTS ci_files (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    conv_id BIGINT NOT NULL REFERENCES ci_conversations(id) ON DELETE CASCADE,
    message_id BIGINT,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    folder TEXT NOT NULL DEFAULT '',
    size BIGINT NOT NULL,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    data BYTEA NOT NULL,
    uploader_id BIGINT,
    scan TEXT NOT NULL DEFAULT 'ok',
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ci_files_conv ON ci_files(conv_id, id);
  CREATE TABLE IF NOT EXISTS ci_messages (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    conv_id BIGINT NOT NULL REFERENCES ci_conversations(id) ON DELETE CASCADE,
    sender_id BIGINT,
    kind TEXT NOT NULL DEFAULT 'text',
    body TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '{}',
    reply_to_id BIGINT,
    file_id BIGINT,
    urgent BIGINT NOT NULL DEFAULT 0,
    mentions TEXT NOT NULL DEFAULT '[]',
    mention_all BIGINT NOT NULL DEFAULT 0,
    visible_to BIGINT,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ci_msg_conv ON ci_messages(conv_id, id);
  CREATE INDEX IF NOT EXISTS idx_ci_msg_org ON ci_messages(org_id, id);
  CREATE TABLE IF NOT EXISTS ci_pins (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    conv_id BIGINT NOT NULL REFERENCES ci_conversations(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES ci_messages(id) ON DELETE CASCADE,
    pinned_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (conv_id, message_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS ci_polls (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    conv_id BIGINT NOT NULL REFERENCES ci_conversations(id) ON DELETE CASCADE,
    message_id BIGINT,
    question TEXT NOT NULL,
    multiple BIGINT NOT NULL DEFAULT 0,
    anonymous BIGINT NOT NULL DEFAULT 0,
    closed_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ci_poll_options (
    id BIGSERIAL PRIMARY KEY,
    poll_id BIGINT NOT NULL REFERENCES ci_polls(id) ON DELETE CASCADE,
    position BIGINT NOT NULL DEFAULT 0,
    label TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ci_poll_votes (
    poll_id BIGINT NOT NULL REFERENCES ci_polls(id) ON DELETE CASCADE,
    option_id BIGINT NOT NULL REFERENCES ci_poll_options(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (poll_id, option_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS ci_scheduled (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    conv_id BIGINT NOT NULL REFERENCES ci_conversations(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    urgent BIGINT NOT NULL DEFAULT 0,
    reply_to_id BIGINT,
    send_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    message_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ci_sched_due ON ci_scheduled(status, send_at);
  CREATE TABLE IF NOT EXISTS ci_reminders (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conv_id BIGINT NOT NULL REFERENCES ci_conversations(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES ci_messages(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    remind_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ci_rem_due ON ci_reminders(status, remind_at);
  CREATE TABLE IF NOT EXISTS ci_msg_tasks (
    message_id BIGINT NOT NULL REFERENCES ci_messages(id) ON DELETE CASCADE,
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, task_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS ci_calls (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    conv_id BIGINT NOT NULL REFERENCES ci_conversations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'audio',
    initiator_id BIGINT,
    status TEXT NOT NULL DEFAULT 'ringing',
    meeting_id BIGINT,
    started_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    peak BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ci_calls_conv ON ci_calls(conv_id, id);
  CREATE TABLE IF NOT EXISTS ci_call_parts (
    call_id BIGINT NOT NULL REFERENCES ci_calls(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'invited',
    joined_at TEXT,
    left_at TEXT,
    PRIMARY KEY (call_id, user_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS ci_geo (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enabled BIGINT NOT NULL DEFAULT 0,
    consent_at TEXT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    accuracy BIGINT NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (org_id, user_id)
  );
  `,
  `
  ALTER TABLE ci_conversations ADD COLUMN IF NOT EXISTS e2ee BIGINT NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS ci_keys (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );
  `,
];
