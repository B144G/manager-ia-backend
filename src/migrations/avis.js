'use strict';
// Migrations du module « Avis et recommandations » (tables fb_) — ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (append-only, rejouables).
// Numéro 116. Aucune ancienne migration n'est modifiée.
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS fb_feedback (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    author_hash TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'review',
    module TEXT NOT NULL DEFAULT 'general',
    stars BIGINT NOT NULL,
    nps BIGINT,
    body TEXT NOT NULL DEFAULT '',
    page TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT 'fr',
    anonymous BIGINT NOT NULL DEFAULT 0,
    display_name TEXT NOT NULL DEFAULT '',
    public_consent BIGINT NOT NULL DEFAULT 0,
    consent_at TEXT,
    approved_at TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    shot BYTEA,
    shot_mime TEXT NOT NULL DEFAULT '',
    shot_size BIGINT NOT NULL DEFAULT 0,
    notified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fb_feedback_org ON fb_feedback(org_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_fb_feedback_author ON fb_feedback(author_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_fb_feedback_status ON fb_feedback(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_fb_feedback_public ON fb_feedback(approved_at);
  CREATE TABLE IF NOT EXISTS fb_notes (
    id BIGSERIAL PRIMARY KEY,
    feedback_id BIGINT NOT NULL REFERENCES fb_feedback(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fb_notes_feedback ON fb_notes(feedback_id, id);
  CREATE TABLE IF NOT EXISTS fb_state (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL DEFAULT ''
  );
  `,
];
