'use strict';
// Migrations du module « Commercial » (Salesforce-like) : rôles commerciaux, CRM 360°, prospection, pipeline, segmentation, SPIN/BANT,
// prévision, devis versionnés, politique tarifaire, fidélisation, force de vente. Toutes les tables sont préfixées cp_ et liées à l'organisation
// (suppression en cascade). Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js. Jamais de renommage ni de suppression ;
// chaque migration est rejouable (IF NOT EXISTS). Une chaîne = une migration (une par étape de livraison, dans l'ordre).
module.exports = [
  // ---------- Étape 1 : rôles, CRM complet, prospection, pipeline, segmentation ----------
  `
  CREATE TABLE IF NOT EXISTS cp_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_zones (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cities TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_teams (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    leader_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_roles (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    team_id BIGINT REFERENCES cp_teams(id) ON DELETE SET NULL,
    zone_ids TEXT NOT NULL DEFAULT '[]',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS cp_audit (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT,
    crole TEXT NOT NULL DEFAULT '',
    entity TEXT NOT NULL,
    entity_id BIGINT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cp_audit_org ON cp_audit (org_id, id);
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_kind TEXT NOT NULL DEFAULT 'company';
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS sector TEXT NOT NULL DEFAULT '';
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '';
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS owner_id BIGINT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS zone_id BIGINT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS potential TEXT NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS cp_contacts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    job_title TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    is_primary BIGINT NOT NULL DEFAULT 0,
    is_decider BIGINT NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_leads (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'other',
    campaign TEXT NOT NULL DEFAULT '',
    product TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    zone_id BIGINT,
    owner_id BIGINT,
    status TEXT NOT NULL DEFAULT 'new',
    temperature TEXT NOT NULL DEFAULT '',
    budget_est BIGINT NOT NULL DEFAULT 0,
    score BIGINT NOT NULL DEFAULT 0,
    score_detail TEXT NOT NULL DEFAULT '{}',
    bant TEXT NOT NULL DEFAULT '{}',
    bant_score BIGINT NOT NULL DEFAULT 0,
    chat_id BIGINT REFERENCES chats(id) ON DELETE SET NULL,
    customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    notes TEXT NOT NULL DEFAULT '',
    lost_reason TEXT NOT NULL DEFAULT '',
    last_contact_at TEXT,
    assigned_at TEXT,
    converted_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS cp_leads_chat ON cp_leads (org_id, chat_id) WHERE chat_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS cp_leads_org ON cp_leads (org_id, status);
  CREATE TABLE IF NOT EXISTS cp_assign_rules (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    priority BIGINT NOT NULL DEFAULT 100,
    zone_id BIGINT,
    product TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    min_score BIGINT NOT NULL DEFAULT 0,
    assignees TEXT NOT NULL DEFAULT '[]',
    strategy TEXT NOT NULL DEFAULT 'load',
    active BIGINT NOT NULL DEFAULT 1,
    last_user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_cadences (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT 'lead',
    steps TEXT NOT NULL DEFAULT '[]',
    auto_send BIGINT NOT NULL DEFAULT 0,
    active BIGINT NOT NULL DEFAULT 1,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_cadence_runs (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    cadence_id BIGINT NOT NULL REFERENCES cp_cadences(id) ON DELETE CASCADE,
    lead_id BIGINT REFERENCES cp_leads(id) ON DELETE CASCADE,
    customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
    doc_id BIGINT REFERENCES documents(id) ON DELETE CASCADE,
    step_idx BIGINT NOT NULL DEFAULT 0,
    next_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    stop_reason TEXT NOT NULL DEFAULT '',
    started_by BIGINT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_cadence_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id BIGINT NOT NULL REFERENCES cp_cadence_runs(id) ON DELETE CASCADE,
    step_idx BIGINT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_stages (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position BIGINT NOT NULL DEFAULT 0,
    probability DOUBLE PRECISION NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'open',
    min_bant BIGINT NOT NULL DEFAULT 0,
    stagnant_days BIGINT NOT NULL DEFAULT 14,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_reasons (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_opps (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
    lead_id BIGINT REFERENCES cp_leads(id) ON DELETE SET NULL,
    owner_id BIGINT,
    stage_id BIGINT NOT NULL REFERENCES cp_stages(id),
    amount BIGINT NOT NULL DEFAULT 0,
    probability DOUBLE PRECISION,
    close_date TEXT,
    product TEXT NOT NULL DEFAULT '',
    zone_id BIGINT,
    source TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    reason_id BIGINT,
    reason_text TEXT NOT NULL DEFAULT '',
    bant TEXT NOT NULL DEFAULT '{}',
    bant_score BIGINT NOT NULL DEFAULT 0,
    next_step TEXT NOT NULL DEFAULT '',
    stage_entered_at TEXT NOT NULL,
    closed_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cp_opps_org ON cp_opps (org_id, status);
  CREATE TABLE IF NOT EXISTS cp_stage_history (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    opp_id BIGINT NOT NULL REFERENCES cp_opps(id) ON DELETE CASCADE,
    from_stage_id BIGINT,
    to_stage_id BIGINT NOT NULL,
    user_id BIGINT,
    note TEXT NOT NULL DEFAULT '',
    entered_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_activities (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
    lead_id BIGINT REFERENCES cp_leads(id) ON DELETE CASCADE,
    opp_id BIGINT REFERENCES cp_opps(id) ON DELETE CASCADE,
    user_id BIGINT,
    outcome TEXT NOT NULL DEFAULT '',
    duration_min BIGINT NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    happened_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_notes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
    lead_id BIGINT REFERENCES cp_leads(id) ON DELETE CASCADE,
    opp_id BIGINT REFERENCES cp_opps(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_attachments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
    lead_id BIGINT REFERENCES cp_leads(id) ON DELETE CASCADE,
    opp_id BIGINT REFERENCES cp_opps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    data BYTEA NOT NULL,
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_tasks (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
    lead_id BIGINT REFERENCES cp_leads(id) ON DELETE CASCADE,
    opp_id BIGINT REFERENCES cp_opps(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'todo',
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    assignee_id BIGINT,
    notified_at TEXT,
    done_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cp_segments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rules TEXT NOT NULL DEFAULT '[]',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  `,
];
