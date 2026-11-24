'use strict';
// Marque de l'entreprise (personnalisation du compte) : migrations 200 et suivantes (append-only : ne jamais modifier une migration existante).
//  200 : réglages de marque par entreprise (configuration JSON validée, logo et favicon, jeton public des images) ;
//  201 : journal des changements de marque (qui, quand, quoi) ; index de détection d'usurpation du nom affiché.
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS org_brand (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    config TEXT NOT NULL DEFAULT '{}',
    name_norm TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL,
    logo_mime TEXT,
    logo_data BYTEA,
    logo_hash TEXT,
    favicon_mime TEXT,
    favicon_data BYTEA,
    favicon_hash TEXT,
    version BIGINT NOT NULL DEFAULT 0,
    updated_by BIGINT,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS org_brand_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS org_brand_log_org ON org_brand_log (org_id, id);
  CREATE INDEX IF NOT EXISTS org_brand_name_norm ON org_brand (name_norm);
  CREATE UNIQUE INDEX IF NOT EXISTS org_brand_token ON org_brand (token);
  `,
];
