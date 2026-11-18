'use strict';
// Migrations du module Trésorerie. Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (voir le bas de ce fichier).
// Règles : jamais de renommage ni de suppression ; CREATE TABLE IF NOT EXISTS ; chaque migration peut être rejouée sur une base déjà migrée.
//
//  tre_settings   réglages (seuil de double validation, fonds de sécurité, taux de provision, objectifs des indicateurs)
//  tre_roles      responsable de trésorerie et trésoriers (désignés par le propriétaire ou un administrateur)
//  tre_accounts   comptes de trésorerie : banque, caisse, mobile money — chacun rattaché à un compte de classe 5 du plan comptable
//  tre_fx         taux de change vers la monnaie de l'organisation
//  tre_ops        encaissements, décaissements et virements internes (préparés, validés puis comptabilisés)
//  tre_plan       éléments prévisionnels saisis (loyer, impôt, prêt à venir…), ponctuels ou récurrents
//  tre_scenarios  scénarios « et si » nommés
//  tre_terms      conditions fournisseurs (escompte, priorité) pour optimiser les paiements
//  tre_log        journal de traçabilité chaîné (chaque ligne contient l'empreinte de la précédente)
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS tre_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    approval_threshold BIGINT NOT NULL DEFAULT 500000,
    safety_mode TEXT NOT NULL DEFAULT 'days',
    safety_days BIGINT NOT NULL DEFAULT 30,
    safety_amount BIGINT NOT NULL DEFAULT 0,
    min_balance BIGINT NOT NULL DEFAULT 0,
    provision_json TEXT NOT NULL DEFAULT '',
    targets_json TEXT NOT NULL DEFAULT '',
    payday BIGINT NOT NULL DEFAULT 28,
    strict_separation BIGINT NOT NULL DEFAULT 1,
    include_trend BIGINT NOT NULL DEFAULT 1,
    updated_by BIGINT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tre_roles (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    role TEXT NOT NULL,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS tre_accounts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'bank',
    provider TEXT NOT NULL DEFAULT '',
    account_no TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '',
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    gl_account TEXT NOT NULL,
    bank_id BIGINT,
    native_open BIGINT NOT NULL DEFAULT 0,
    active BIGINT NOT NULL DEFAULT 1,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, gl_account)
  );
  CREATE INDEX IF NOT EXISTS idx_tre_accounts_org ON tre_accounts(org_id);
  CREATE TABLE IF NOT EXISTS tre_fx (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    currency TEXT NOT NULL,
    rate DOUBLE PRECISION NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, currency)
  );
  CREATE TABLE IF NOT EXISTS tre_ops (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    account_id BIGINT NOT NULL,
    to_account_id BIGINT,
    date TEXT NOT NULL,
    amount BIGINT NOT NULL,
    amount_to BIGINT,
    amount_base BIGINT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    counterparty TEXT NOT NULL DEFAULT '',
    ref_kind TEXT NOT NULL DEFAULT '',
    ref_id BIGINT,
    method TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'prepared',
    need_double BIGINT NOT NULL DEFAULT 0,
    prepared_by BIGINT NOT NULL,
    prepared_at TEXT NOT NULL,
    approval1_by BIGINT,
    approval1_at TEXT,
    approval2_by BIGINT,
    approval2_at TEXT,
    rejected_by BIGINT,
    rejected_at TEXT,
    reject_reason TEXT NOT NULL DEFAULT '',
    entry_id BIGINT,
    cancel_entry_id BIGINT,
    pay_row_id BIGINT,
    posted_at TEXT,
    cancelled_by BIGINT,
    cancelled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tre_ops_org ON tre_ops(org_id, status, date);
  CREATE TABLE IF NOT EXISTS tre_plan (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    label TEXT NOT NULL,
    amount BIGINT NOT NULL,
    start_date TEXT NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'none',
    end_date TEXT,
    active BIGINT NOT NULL DEFAULT 1,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tre_plan_org ON tre_plan(org_id);
  CREATE TABLE IF NOT EXISTS tre_scenarios (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tre_scenarios_org ON tre_scenarios(org_id);
  CREATE TABLE IF NOT EXISTS tre_terms (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    supplier_id BIGINT NOT NULL,
    discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    discount_days BIGINT NOT NULL DEFAULT 0,
    priority BIGINT NOT NULL DEFAULT 2,
    PRIMARY KEY (org_id, supplier_id)
  );
  CREATE TABLE IF NOT EXISTS tre_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL DEFAULT '',
    entity_id BIGINT,
    detail TEXT NOT NULL DEFAULT '',
    prev_hash TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tre_log_org ON tre_log(org_id, id);
  `,
];
