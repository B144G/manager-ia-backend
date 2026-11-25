'use strict';
// Compte d'entreprise (étape 1) : migrations 400 et suivantes. Append-only : ne JAMAIS modifier une migration existante ; tout est additif et rejouable.
// Numérotation de la famille « compte d'entreprise » (voir docs/compte-entreprise.md) :
//   400 à 409  étape 1 : entreprise au-dessus des organisations, personnes, direction générale, structure, affectations, réglages (CE fichier) ;
//   410 à 419  étape 2 : connexion employé (code d'entreprise, e-mail, secret personnel, appareils de confiance) ;
//   420 à 429  étape 3 : moteur de profils de rôle ;  430 à 439 étape 4 : organisations liées (lien d'association) ;
//   440 à 449  étape 5 : partenaires ;  450 à 459 étape 6 : limites par abonnement.
// Les emplacements non utilisés ne sont comblés que lorsqu'une étape suivante est livrée (le numéro d'une migration est sa position).
//  400 : entreprises (le titulaire du compte) + rattachement des organisations ;
//  401 : personnes (identité individuelle dans l'entreprise) et direction générale ;
//  402 : structure d'une organisation : directions du pilotage, départements, postes ;
//  403 : affectations des personnes aux postes (PAR organisation) et réglages / avancement de la configuration ;
//  404 : rattachement des organisations existantes (données) : une entreprise par organisation, le propriétaire devient directeur général.
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS entreprises (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    sector TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'Cameroun',
    currency TEXT NOT NULL DEFAULT 'FCFA',
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    legal_form TEXT NOT NULL DEFAULT '',
    rccm TEXT NOT NULL DEFAULT '',
    niu TEXT NOT NULL DEFAULT '',
    vat_number TEXT NOT NULL DEFAULT '',
    company_code TEXT,
    plan_json TEXT NOT NULL DEFAULT '',
    limits_json TEXT NOT NULL DEFAULT '',
    owner_user_id BIGINT,
    legacy_org_id BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS entreprises_company_code ON entreprises (company_code) WHERE company_code IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS entreprises_legacy_org ON entreprises (legacy_org_id) WHERE legacy_org_id IS NOT NULL;
  ALTER TABLE orgs ADD COLUMN IF NOT EXISTS entreprise_id BIGINT;
  CREATE INDEX IF NOT EXISTS orgs_entreprise ON orgs (entreprise_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS ent_people (
    id BIGSERIAL PRIMARY KEY,
    entreprise_id BIGINT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    invite_code TEXT,
    invite_org_id BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ent_people_user ON ent_people (entreprise_id, user_id) WHERE user_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ent_people_ent ON ent_people (entreprise_id, id);
  CREATE INDEX IF NOT EXISTS ent_people_invite ON ent_people (invite_code);
  CREATE TABLE IF NOT EXISTS ent_dg (
    entreprise_id BIGINT NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
    person_id BIGINT NOT NULL REFERENCES ent_people(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entreprise_id, person_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS ent_directions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    tkey TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ent_directions_org ON ent_directions (org_id, sort, id);
  CREATE TABLE IF NOT EXISTS ent_departments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    direction_id BIGINT REFERENCES ent_directions(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    tkey TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ent_departments_org ON ent_departments (org_id, sort, id);
  CREATE TABLE IF NOT EXISTS ent_posts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    direction_id BIGINT REFERENCES ent_directions(id) ON DELETE SET NULL,
    department_id BIGINT REFERENCES ent_departments(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'staff',
    spaces TEXT NOT NULL DEFAULT '{}',
    headcount INTEGER NOT NULL DEFAULT 1,
    tkey TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ent_posts_org ON ent_posts (org_id, sort, id);
  `,
  `
  CREATE TABLE IF NOT EXISTS ent_assignments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    post_id BIGINT NOT NULL REFERENCES ent_posts(id) ON DELETE CASCADE,
    person_id BIGINT NOT NULL REFERENCES ent_people(id) ON DELETE CASCADE,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (post_id, person_id)
  );
  CREATE INDEX IF NOT EXISTS ent_assignments_org ON ent_assignments (org_id, person_id);
  CREATE TABLE IF NOT EXISTS ent_setup (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    steps TEXT NOT NULL DEFAULT '{}',
    template TEXT NOT NULL DEFAULT '',
    rights_link INTEGER NOT NULL DEFAULT 1,
    updated_by BIGINT,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  `,
  `
  INSERT INTO entreprises (name, currency, owner_user_id, legacy_org_id, created_at, updated_at)
    SELECT o.name, COALESCE(NULLIF(o.currency, ''), 'FCFA'), o.owner_id, o.id, o.created_at, o.created_at
    FROM orgs o WHERE o.entreprise_id IS NULL AND NOT EXISTS (SELECT 1 FROM entreprises e WHERE e.legacy_org_id = o.id);
  UPDATE orgs SET entreprise_id = (SELECT e.id FROM entreprises e WHERE e.legacy_org_id = orgs.id) WHERE entreprise_id IS NULL;
  INSERT INTO ent_people (entreprise_id, user_id, full_name, email, status, created_at)
    SELECT o.entreprise_id, m.user_id, u.name, CASE WHEN u.contact LIKE '%@%' THEN u.contact ELSE '' END, 'active', m.created_at
    FROM org_members m JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
    WHERE o.entreprise_id IS NOT NULL ON CONFLICT DO NOTHING;
  INSERT INTO ent_dg (entreprise_id, person_id, created_at)
    SELECT p.entreprise_id, p.id, e.created_at FROM ent_people p JOIN entreprises e ON e.id = p.entreprise_id
    WHERE p.user_id = e.owner_user_id ON CONFLICT DO NOTHING;
  `,
];
