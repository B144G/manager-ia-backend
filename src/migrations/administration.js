'use strict';
// Module « Administration » : migrations rejouables (CREATE TABLE / INDEX IF NOT EXISTS), tables préfixées adm_.
// Aucune table existante n'est modifiée : les postes (positions), personnes (org_members, employees), immobilisations (fixed_assets)
// et contrats juridiques (legal_contracts) sont seulement LUS. Branchée à la fin du tableau MIGRATIONS de src/db.js (une ligne).
// Une chaîne = une migration. Étape 1 : organisation, procédures, GED, circuits, contrôle interne. Étape 2 : moyens généraux, contrats, conformité.
module.exports = [
  // ---------- Étape 1 · réglages, organisation, RACI, délégations ----------
  `
  CREATE TABLE IF NOT EXISTS adm_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    config TEXT NOT NULL DEFAULT '{}',
    updated_by BIGINT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_alerts (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, key)
  );
  CREATE TABLE IF NOT EXISTS adm_units (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    parent_id BIGINT,
    head_user_id BIGINT,
    mission TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_units_org ON adm_units(org_id);
  CREATE TABLE IF NOT EXISTS adm_posts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    position_id BIGINT NOT NULL,
    unit_id BIGINT,
    mission TEXT NOT NULL DEFAULT '',
    responsibilities TEXT NOT NULL DEFAULT '[]',
    skills TEXT NOT NULL DEFAULT '',
    kpis TEXT NOT NULL DEFAULT '',
    functions TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, position_id)
  );
  CREATE TABLE IF NOT EXISTS adm_processes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_activities (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    process_id BIGINT NOT NULL REFERENCES adm_processes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_adm_act_proc ON adm_activities(process_id);
  CREATE TABLE IF NOT EXISTS adm_raci (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    activity_id BIGINT NOT NULL REFERENCES adm_activities(id) ON DELETE CASCADE,
    actor_kind TEXT NOT NULL,
    actor_id BIGINT NOT NULL,
    letter TEXT NOT NULL,
    UNIQUE (activity_id, actor_kind, actor_id)
  );
  CREATE TABLE IF NOT EXISTS adm_delegations (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'delegation',
    delegator_id BIGINT NOT NULL,
    delegate_id BIGINT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    scope_key TEXT NOT NULL DEFAULT 'all',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    ceiling BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    reason TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_deleg ON adm_delegations(org_id, status, end_date);
  `,
  // ---------- Procédures (SOP) ----------
  `
  CREATE TABLE IF NOT EXISTS adm_sops (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    owner_id BIGINT,
    steps TEXT NOT NULL DEFAULT '[]',
    linked_docs TEXT NOT NULL DEFAULT '[]',
    indicators TEXT NOT NULL DEFAULT '[]',
    version BIGINT NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    review_months BIGINT NOT NULL DEFAULT 12,
    next_review TEXT,
    audience TEXT NOT NULL DEFAULT '{}',
    mandatory_read BIGINT NOT NULL DEFAULT 0,
    template_key TEXT NOT NULL DEFAULT '',
    approved_by BIGINT,
    approved_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_sops_org ON adm_sops(org_id, status);
  CREATE TABLE IF NOT EXISTS adm_sop_versions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    sop_id BIGINT NOT NULL REFERENCES adm_sops(id) ON DELETE CASCADE,
    version BIGINT NOT NULL,
    snapshot TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (sop_id, version)
  );
  CREATE TABLE IF NOT EXISTS adm_sop_acks (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    sop_id BIGINT NOT NULL REFERENCES adm_sops(id) ON DELETE CASCADE,
    version BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    read_at TEXT NOT NULL,
    UNIQUE (sop_id, version, user_id)
  );
  `,
  // ---------- GED et archives ----------
  `
  CREATE TABLE IF NOT EXISTS adm_plan (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parent_id BIGINT,
    code TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_doc_types (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    active_years DOUBLE PRECISION NOT NULL DEFAULT 1,
    retention_years DOUBLE PRECISION NOT NULL DEFAULT 5,
    basis TEXT NOT NULL DEFAULT 'doc_date',
    end_action TEXT NOT NULL DEFAULT 'destroy',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_docs (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    plan_id BIGINT,
    type_id BIGINT,
    confidentiality TEXT NOT NULL DEFAULT 'internal',
    allowed_roles TEXT NOT NULL DEFAULT '[]',
    allowed_users TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    author TEXT NOT NULL DEFAULT '',
    doc_date TEXT,
    version BIGINT NOT NULL DEFAULT 0,
    file_name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '',
    size BIGINT NOT NULL DEFAULT 0,
    text_content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    lock_user_id BIGINT,
    lock_kind TEXT NOT NULL DEFAULT '',
    lock_at TEXT,
    lock_due TEXT,
    lock_note TEXT NOT NULL DEFAULT '',
    archive_due TEXT,
    destroy_due TEXT,
    archived_at TEXT,
    archived_by BIGINT,
    seal_hash TEXT NOT NULL DEFAULT '',
    destroy_state TEXT NOT NULL DEFAULT '',
    destroy_requested_by BIGINT,
    destroy_decided_by BIGINT,
    destroyed_at TEXT,
    deleted_at TEXT,
    deleted_by BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_docs_org ON adm_docs(org_id, status);
  CREATE TABLE IF NOT EXISTS adm_doc_versions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    doc_id BIGINT NOT NULL REFERENCES adm_docs(id) ON DELETE CASCADE,
    n BIGINT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    data BYTEA,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (doc_id, n)
  );
  CREATE TABLE IF NOT EXISTS adm_doc_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    doc_id BIGINT,
    user_id BIGINT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_doc_log ON adm_doc_log(org_id, doc_id, id);
  `,
  // ---------- Circuits de validation ----------
  `
  CREATE TABLE IF NOT EXISTS adm_flows (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    description TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    min_amount BIGINT NOT NULL DEFAULT 0,
    max_amount BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    version BIGINT NOT NULL DEFAULT 1,
    created_by BIGINT,
    validated_by BIGINT,
    validated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_requests (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    ref TEXT NOT NULL DEFAULT '',
    flow_id BIGINT,
    flow_version BIGINT NOT NULL DEFAULT 1,
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    amount BIGINT NOT NULL DEFAULT 0,
    requester_id BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    current_step BIGINT NOT NULL DEFAULT 0,
    link_type TEXT NOT NULL DEFAULT '',
    link_id BIGINT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_adm_req_org ON adm_requests(org_id, status);
  CREATE TABLE IF NOT EXISTS adm_request_steps (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    request_id BIGINT NOT NULL REFERENCES adm_requests(id) ON DELETE CASCADE,
    idx BIGINT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'any',
    groups TEXT NOT NULL DEFAULT '[]',
    delay_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
    escalate_to TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'waiting',
    started_at TEXT,
    due_at TEXT,
    escalated BIGINT NOT NULL DEFAULT 0,
    done_at TEXT,
    UNIQUE (request_id, idx)
  );
  CREATE TABLE IF NOT EXISTS adm_request_actions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    request_id BIGINT NOT NULL REFERENCES adm_requests(id) ON DELETE CASCADE,
    idx BIGINT,
    user_id BIGINT,
    action TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    via TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_req_act ON adm_request_actions(request_id, id);
  `,
  // ---------- Contrôle interne ----------
  `
  CREATE TABLE IF NOT EXISTS adm_sod_funcs (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'execute',
    description TEXT NOT NULL DEFAULT '',
    UNIQUE (org_id, code)
  );
  CREATE TABLE IF NOT EXISTS adm_sod_rules (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    func_a BIGINT NOT NULL REFERENCES adm_sod_funcs(id) ON DELETE CASCADE,
    func_b BIGINT NOT NULL REFERENCES adm_sod_funcs(id) ON DELETE CASCADE,
    severity TEXT NOT NULL DEFAULT 'high',
    reason TEXT NOT NULL DEFAULT '',
    UNIQUE (org_id, func_a, func_b)
  );
  CREATE TABLE IF NOT EXISTS adm_sod_assign (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    func_id BIGINT NOT NULL REFERENCES adm_sod_funcs(id) ON DELETE CASCADE,
    subject_kind TEXT NOT NULL,
    subject_id BIGINT,
    subject_role TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_adm_sod_assign ON adm_sod_assign(org_id, func_id, subject_kind, COALESCE(subject_id, 0), subject_role);
  CREATE TABLE IF NOT EXISTS adm_sod_waivers (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    rule_id BIGINT NOT NULL REFERENCES adm_sod_rules(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    compensating TEXT NOT NULL DEFAULT '',
    until_date TEXT,
    approved_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (rule_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS adm_risks (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    process TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    likelihood BIGINT NOT NULL DEFAULT 3,
    impact BIGINT NOT NULL DEFAULT 3,
    owner_id BIGINT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_controls (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    objective TEXT NOT NULL DEFAULT '',
    process TEXT NOT NULL DEFAULT '',
    risk_id BIGINT,
    kind TEXT NOT NULL DEFAULT 'preventive',
    frequency TEXT NOT NULL DEFAULT 'monthly',
    owner_id BIGINT,
    start_date TEXT,
    active BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_control_runs (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    control_id BIGINT NOT NULL REFERENCES adm_controls(id) ON DELETE CASCADE,
    done_on TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'ok',
    evidence TEXT NOT NULL DEFAULT '',
    doc_id BIGINT,
    notes TEXT NOT NULL DEFAULT '',
    done_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_actions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    source_kind TEXT NOT NULL DEFAULT 'other',
    source_id BIGINT,
    owner_id BIGINT,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    progress BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  );
  `,
  // ---------- Objectifs administratifs (suivi propre au module ; MBO complet : module RH talents) ----------
  `
  CREATE TABLE IF NOT EXISTS adm_goals (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '',
    owner_id BIGINT,
    target DOUBLE PRECISION NOT NULL DEFAULT 100,
    current DOUBLE PRECISION NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT '%',
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // ---------- Étape 2 · moyens généraux ----------
  `
  CREATE TABLE IF NOT EXISTS adm_assets (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'equipment',
    brand TEXT NOT NULL DEFAULT '',
    serial TEXT NOT NULL DEFAULT '',
    plate TEXT NOT NULL DEFAULT '',
    mileage BIGINT NOT NULL DEFAULT 0,
    location TEXT NOT NULL DEFAULT '',
    purchase_date TEXT,
    cost BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'in_use',
    assignee_id BIGINT,
    unit_id BIGINT,
    fixed_asset_id BIGINT,
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_assets_org ON adm_assets(org_id, status);
  CREATE TABLE IF NOT EXISTS adm_asset_assign (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    asset_id BIGINT NOT NULL REFERENCES adm_assets(id) ON DELETE CASCADE,
    user_id BIGINT,
    unit_id BIGINT,
    from_date TEXT NOT NULL,
    to_date TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT
  );
  CREATE TABLE IF NOT EXISTS adm_asset_events (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    asset_id BIGINT REFERENCES adm_assets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'maintenance',
    event_date TEXT NOT NULL,
    amount BIGINT NOT NULL DEFAULT 0,
    vendor TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_asset_events ON adm_asset_events(org_id, event_date);
  CREATE TABLE IF NOT EXISTS adm_asset_deadlines (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    asset_id BIGINT REFERENCES adm_assets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'maintenance',
    title TEXT NOT NULL,
    due_date TEXT NOT NULL,
    recurrence_months BIGINT NOT NULL DEFAULT 0,
    cost BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    last_done TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_asset_dl ON adm_asset_deadlines(org_id, status, due_date);
  CREATE TABLE IF NOT EXISTS adm_places (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'room',
    name TEXT NOT NULL,
    parent_id BIGINT,
    address TEXT NOT NULL DEFAULT '',
    capacity BIGINT NOT NULL DEFAULT 0,
    surface DOUBLE PRECISION NOT NULL DEFAULT 0,
    monthly_rent BIGINT NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_bookings (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    place_id BIGINT NOT NULL REFERENCES adm_places(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    user_id BIGINT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'booked',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_book ON adm_bookings(place_id, start_at);
  CREATE TABLE IF NOT EXISTS adm_supplies (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'pièce',
    quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
    min_quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
    unit_cost BIGINT NOT NULL DEFAULT 0,
    location TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adm_means_requests (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'supply',
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
    need_date TEXT,
    est_cost BIGINT NOT NULL DEFAULT 0,
    requester_id BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    handled_by BIGINT,
    handled_note TEXT NOT NULL DEFAULT '',
    asset_id BIGINT,
    supply_id BIGINT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_adm_means_req ON adm_means_requests(org_id, status);
  `,
  // ---------- Étape 2 · contrats et conformité ----------
  `
  CREATE TABLE IF NOT EXISTS adm_contracts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    ref TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    counterparty TEXT NOT NULL DEFAULT '',
    parties TEXT NOT NULL DEFAULT '',
    start_date TEXT,
    end_date TEXT,
    notice_days BIGINT NOT NULL DEFAULT 0,
    tacit_renewal BIGINT NOT NULL DEFAULT 0,
    renewal_months BIGINT NOT NULL DEFAULT 12,
    amount BIGINT NOT NULL DEFAULT 0,
    periodicity TEXT NOT NULL DEFAULT 'once',
    owner_id BIGINT,
    status TEXT NOT NULL DEFAULT 'active',
    doc_ids TEXT NOT NULL DEFAULT '[]',
    legal_id BIGINT,
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_contracts_org ON adm_contracts(org_id, status, end_date);
  CREATE TABLE IF NOT EXISTS adm_compliance (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    authority TEXT NOT NULL DEFAULT '',
    reference_text TEXT NOT NULL DEFAULT '',
    frequency_months BIGINT NOT NULL DEFAULT 0,
    due_date TEXT,
    responsible_id BIGINT,
    status TEXT NOT NULL DEFAULT 'todo',
    proof TEXT NOT NULL DEFAULT '',
    proof_doc_id BIGINT,
    last_done TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adm_compliance_org ON adm_compliance(org_id, status, due_date);
  CREATE TABLE IF NOT EXISTS adm_compliance_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    compliance_id BIGINT NOT NULL REFERENCES adm_compliance(id) ON DELETE CASCADE,
    done_on TEXT NOT NULL,
    due_was TEXT,
    proof TEXT NOT NULL DEFAULT '',
    proof_doc_id BIGINT,
    done_by BIGINT,
    created_at TEXT NOT NULL
  );
  `,
];
