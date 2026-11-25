'use strict';
// Compte d'entreprise, étape 5 : partenaires et espaces partagés (chat, réunions, bibliothèque). Migrations 440 à 443 (433 à 439 réservées). Append-only, additives.
// Aucune table existante n'est modifiée : le chat interne (ci_), les réunions (mtg_) et la bibliothèque (lib_) gardent leur isolation par organisation ; un espace partagé
// n'expose que des COPIES (instantanés) ou des fichiers désignés explicitement, à des personnes désignées explicitement.
//  440 : partenariats entre deux organisations d'entreprises différentes (invitation à usage unique, confirmation des deux côtés, types, durée, révocation) ;
//  441 : espaces partagés (une entité propriétaire, des organisations participantes, des personnes membres avec droits lecture / écriture / validation) ;
//  442 : objets partagés explicitement, messages, fichiers déposés, validations ;
//  443 : journal d'audit des partenariats et des espaces (visible des deux côtés).
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS ent_partnerships (
    id BIGSERIAL PRIMARY KEY,
    org_a BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    org_b BIGINT REFERENCES orgs(id) ON DELETE CASCADE,
    ent_a BIGINT,
    ent_b BIGINT,
    type_a TEXT NOT NULL DEFAULT 'strategique',
    type_b TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'invited',
    token_hash TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    duration_days INTEGER,
    contact_a TEXT NOT NULL DEFAULT '{}',
    contact_b TEXT NOT NULL DEFAULT '{}',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    joined_by BIGINT,
    joined_at TEXT,
    confirmed_by BIGINT,
    confirmed_at TEXT,
    ends_at TEXT,
    revoked_at TEXT,
    revoked_by_org BIGINT,
    revoke_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ent_partnerships_token ON ent_partnerships (token_hash);
  CREATE INDEX IF NOT EXISTS ent_partnerships_a ON ent_partnerships (org_a, id);
  CREATE INDEX IF NOT EXISTS ent_partnerships_b ON ent_partnerships (org_b, id);
  `,
  `
  CREATE TABLE IF NOT EXISTS shared_spaces (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    scope TEXT NOT NULL,
    partnership_id BIGINT REFERENCES ent_partnerships(id) ON DELETE CASCADE,
    entreprise_id BIGINT,
    owner_org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    archived_at TEXT,
    archive_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS shared_spaces_owner ON shared_spaces (owner_org_id, id);
  CREATE TABLE IF NOT EXISTS shared_space_orgs (
    space_id BIGINT NOT NULL REFERENCES shared_spaces(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    PRIMARY KEY (space_id, org_id)
  );
  CREATE INDEX IF NOT EXISTS shared_space_orgs_org ON shared_space_orgs (org_id);
  CREATE TABLE IF NOT EXISTS shared_space_members (
    id BIGSERIAL PRIMARY KEY,
    space_id BIGINT NOT NULL REFERENCES shared_spaces(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rights TEXT NOT NULL DEFAULT 'read',
    added_by BIGINT,
    added_at TEXT NOT NULL,
    removed_at TEXT,
    UNIQUE (space_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS shared_space_members_user ON shared_space_members (user_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS shared_space_objects (
    id BIGSERIAL PRIMARY KEY,
    space_id BIGINT NOT NULL REFERENCES shared_spaces(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    object_id BIGINT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    rights TEXT NOT NULL DEFAULT 'read',
    snapshot TEXT NOT NULL DEFAULT '{}',
    expires_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    refreshed_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS shared_space_objects_space ON shared_space_objects (space_id, id);
  CREATE TABLE IF NOT EXISTS shared_messages (
    id BIGSERIAL PRIMARY KEY,
    space_id BIGINT NOT NULL REFERENCES shared_spaces(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shared_messages_space ON shared_messages (space_id, id);
  CREATE TABLE IF NOT EXISTS shared_files (
    id BIGSERIAL PRIMARY KEY,
    space_id BIGINT NOT NULL REFERENCES shared_spaces(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    data BYTEA NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS shared_files_space ON shared_files (space_id, id);
  CREATE TABLE IF NOT EXISTS shared_validations (
    id BIGSERIAL PRIMARY KEY,
    object_id BIGINT NOT NULL REFERENCES shared_space_objects(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    decision TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS shared_audit (
    id BIGSERIAL PRIMARY KEY,
    space_id BIGINT,
    partnership_id BIGINT,
    org_id BIGINT,
    user_id BIGINT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shared_audit_space ON shared_audit (space_id, id);
  CREATE INDEX IF NOT EXISTS shared_audit_partner ON shared_audit (partnership_id, id);
  `,
];
