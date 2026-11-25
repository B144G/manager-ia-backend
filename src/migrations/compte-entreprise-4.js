'use strict';
// Compte d'entreprise, étape 4 : organisations liées par lien d'association. Migrations 430 à 432 (422 à 429 réservées). Append-only, additives.
//  430 : liens d'association (jeton à usage unique, haché ; expiration ; révocation ; copie de la structure) ;
//  431 : origine d'une organisation liée (lien utilisé, organisation principale de l'entreprise) ;
//  432 : journal des rattachements (qui a lié quelle organisation, quand).
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS ent_links (
    id BIGSERIAL PRIMARY KEY,
    entreprise_id BIGINT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    copy_structure INTEGER NOT NULL DEFAULT 1,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_org_id BIGINT,
    revoked_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ent_links_token ON ent_links (token_hash);
  CREATE INDEX IF NOT EXISTS ent_links_ent ON ent_links (entreprise_id, id);
  `,
  `
  ALTER TABLE orgs ADD COLUMN IF NOT EXISTS linked_via BIGINT;
  `,
  `
  CREATE TABLE IF NOT EXISTS ent_link_log (
    id BIGSERIAL PRIMARY KEY,
    entreprise_id BIGINT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
    org_id BIGINT,
    link_id BIGINT,
    user_id BIGINT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ent_link_log_ent ON ent_link_log (entreprise_id, id);
  `,
];
