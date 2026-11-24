'use strict';
// Espaces par rôle : migrations 170 et suivantes (append-only : ne jamais modifier une migration existante).
// Tout est additif : une entreprise sans réglage garde l'ancien menu général (espaces désactivés par défaut).
//  170 : réglage par entreprise (activé ou non, lecture ouverte) + journal des changements ;
//  171 : affectations d'espaces par personne (niveau visiteur / membre / responsable) + rôles fonctionnels ;
//  172 : dernier espace choisi par personne (mémorisé d'un appareil à l'autre) ;
//  173 : photo de profil de la personne dans l'organisation (affichée dans l'en-tête de chaque tableau de bord).
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS space_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    open_read INTEGER NOT NULL DEFAULT 0,
    updated_by BIGINT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS space_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS space_log_org ON space_log (org_id, id);
  `,
  `
  CREATE TABLE IF NOT EXISTS member_spaces (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space TEXT NOT NULL,
    access TEXT NOT NULL DEFAULT 'write',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id, space)
  );
  CREATE TABLE IF NOT EXISTS member_func_roles (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    func_role TEXT NOT NULL,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id, func_role)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS member_space_prefs (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_space TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS member_photos (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );
  `,
];
