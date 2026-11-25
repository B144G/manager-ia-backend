'use strict';
// Compte d'entreprise, étape 2 : connexion employé (code d'entreprise + e-mail + secret personnel) et appareils de confiance. Migrations 410 à 412. Append-only, additives.
//  410 : secret personnel de la personne (mot de passe ou PIN, jamais en clair) et état de verrouillage propre à l'entreprise ;
//  411 : appareils de confiance (jeton long révocable, 30 à 90 jours) ;
//  412 : réglage de l'entreprise : double authentification obligatoire pour les profils sensibles (DG, directeurs, finance, trésorerie).
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS ent_credentials (
    person_id BIGINT PRIMARY KEY REFERENCES ent_people(id) ON DELETE CASCADE,
    method TEXT NOT NULL DEFAULT 'password',
    secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS ent_devices (
    id BIGSERIAL PRIMARY KEY,
    person_id BIGINT NOT NULL REFERENCES ent_people(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ent_devices_token ON ent_devices (token_hash);
  CREATE INDEX IF NOT EXISTS ent_devices_person ON ent_devices (person_id);
  `,
  `
  ALTER TABLE entreprises ADD COLUMN IF NOT EXISTS sensitive_2fa INTEGER NOT NULL DEFAULT 1;
  `,
];
