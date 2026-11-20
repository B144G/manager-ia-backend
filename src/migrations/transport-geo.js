'use strict';
// Migrations du module « Transport · géolocalisation » et de la gestion typée des clients / fournisseurs.
// Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (voir le bas de db.js : le tableau est complété pour que la première migration
// de ce fichier porte le numéro 140 ; les numéros 116 à 139 sont réservés aux autres modules, ex. Avis = 116).
// Règles : jamais de modification d'une ancienne migration ; CREATE TABLE / INDEX IF NOT EXISTS ; ALTER TABLE … ADD COLUMN IF NOT EXISTS
// (rejouables). Aucune table existante n'est renommée ni supprimée : les clients (customers) et fournisseurs (suppliers) sont ÉTENDUS.
//
//  tg_settings     réglages de la géolocalisation (ancienneté d'une position, conservation, durée de service)
//  tg_driver       un transporteur (fiche chauffeur existante) : véhicule habituel, consentement, service, statut manuel, dernière position
//  tg_positions    historique des positions reçues (conservation limitée, purgé automatiquement)
//  tg_requests     demandes de localisation envoyées à un client (lien secret) pour une livraison
//  tg_audit        journal d'audit (consentements, positions, consultations de la carte, affectations)
//  pty_terms       conditions propres à chaque type de client / fournisseur (remise, délai de paiement, délai de livraison, plafond)
//  pty_type_log    historique des changements de type
//  pty_notes       notes datées sur une fiche
//  customers / suppliers : colonnes additives (type, fin de validité, GPS, étiquettes, statut, conditions propres)
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS tg_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    stale_min BIGINT NOT NULL DEFAULT 30,
    lost_min BIGINT NOT NULL DEFAULT 240,
    retention_days BIGINT NOT NULL DEFAULT 14,
    shift_max_h BIGINT NOT NULL DEFAULT 12,
    ping_min BIGINT NOT NULL DEFAULT 5,
    updated_by BIGINT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tg_driver (
    driver_id BIGINT PRIMARY KEY REFERENCES logistics_drivers(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    vehicle_id BIGINT REFERENCES logistics_vehicles(id) ON DELETE SET NULL,
    consent_at TEXT,
    consent_revoked_at TEXT,
    shift_on BIGINT NOT NULL DEFAULT 0,
    shift_started_at TEXT,
    manual_state TEXT NOT NULL DEFAULT '',
    manual_reason TEXT NOT NULL DEFAULT '',
    manual_until TEXT,
    last_lat DOUBLE PRECISION,
    last_lng DOUBLE PRECISION,
    last_accuracy DOUBLE PRECISION,
    last_at TEXT,
    last_source TEXT NOT NULL DEFAULT '',
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tg_driver_org ON tg_driver(org_id);
  CREATE TABLE IF NOT EXISTS tg_positions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    driver_id BIGINT NOT NULL REFERENCES logistics_drivers(id) ON DELETE CASCADE,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    accuracy DOUBLE PRECISION,
    source TEXT NOT NULL DEFAULT 'phone',
    round_id BIGINT,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tg_positions_driver ON tg_positions(driver_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_tg_positions_org ON tg_positions(org_id, recorded_at);
  CREATE TABLE IF NOT EXISTS tg_requests (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    delivery_id BIGINT NOT NULL REFERENCES logistics_deliveries(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    located_at TEXT,
    source TEXT NOT NULL DEFAULT '',
    consent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tg_requests_delivery ON tg_requests(delivery_id);
  CREATE TABLE IF NOT EXISTS tg_audit (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT,
    driver_id BIGINT,
    delivery_id BIGINT,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tg_audit_org ON tg_audit(org_id, id);
  ALTER TABLE logistics_deliveries ADD COLUMN IF NOT EXISTS geo_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE logistics_deliveries ADD COLUMN IF NOT EXISTS geo_at TEXT;
  ALTER TABLE logistics_deliveries ADD COLUMN IF NOT EXISTS geo_accuracy DOUBLE PRECISION;
  `,
  `
  CREATE TABLE IF NOT EXISTS pty_terms (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    party_type TEXT NOT NULL,
    discount_pct DOUBLE PRECISION,
    payment_days BIGINT,
    delivery_days BIGINT,
    credit_limit BIGINT,
    note TEXT NOT NULL DEFAULT '',
    updated_by BIGINT,
    updated_at TEXT,
    PRIMARY KEY (org_id, kind, party_type)
  );
  CREATE TABLE IF NOT EXISTS pty_type_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    party_id BIGINT NOT NULL,
    from_type TEXT NOT NULL DEFAULT '',
    to_type TEXT NOT NULL,
    valid_until TEXT,
    reason TEXT NOT NULL DEFAULT '',
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pty_type_log ON pty_type_log(org_id, kind, party_id, id);
  CREATE TABLE IF NOT EXISTS pty_notes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    party_id BIGINT NOT NULL,
    body TEXT NOT NULL,
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pty_notes ON pty_notes(org_id, kind, party_id, id);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS party_type TEXT NOT NULL DEFAULT 'simple';
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS valid_until TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS geo_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS geo_at TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '';
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS party_status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS pty_discount DOUBLE PRECISION;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS pty_pay_days BIGINT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS pty_delivery_days BIGINT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS pty_credit_limit BIGINT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS type_changed_at TEXT;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS party_type TEXT NOT NULL DEFAULT 'simple';
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS valid_until TEXT;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS geo_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS geo_at TEXT;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '';
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS party_status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pty_discount DOUBLE PRECISION;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pty_pay_days BIGINT;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pty_delivery_days BIGINT;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pty_credit_limit BIGINT;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS type_changed_at TEXT;
  CREATE INDEX IF NOT EXISTS idx_customers_ptype ON customers(org_id, party_type);
  CREATE INDEX IF NOT EXISTS idx_suppliers_ptype ON suppliers(org_id, party_type);
  `,
];
