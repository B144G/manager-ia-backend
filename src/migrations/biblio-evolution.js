'use strict';
// Évolution de la Bibliothèque (classification, catalogue, prêts, versions documentaires, puis droits, archivage, recherche, inventaire).
// Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js. Règles : jamais de renommage ni de suppression ; CREATE TABLE IF NOT EXISTS,
// ADD COLUMN IF NOT EXISTS ; chaque migration peut être rejouée. Toutes les tables portent org_id (export et suppression d'une organisation).
module.exports = [
  // ----- Étape 1 : plan de classement, notices (catalogue), vocabulaire contrôlé, prêts, réservations, règles de prêt, blocages -----
  `
  CREATE TABLE IF NOT EXISTS lib_classes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id BIGINT REFERENCES lib_classes(id) ON DELETE SET NULL,
    position BIGINT NOT NULL DEFAULT 0,
    retention_months BIGINT,
    confidentiality TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lib_classes_code ON lib_classes(org_id, code);
  CREATE INDEX IF NOT EXISTS idx_lib_classes_parent ON lib_classes(parent_id);

  CREATE TABLE IF NOT EXISTS lib_records (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    doc_id BIGINT REFERENCES lib_docs(id) ON DELETE SET NULL,
    rtype TEXT NOT NULL DEFAULT 'document',
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    publisher TEXT NOT NULL DEFAULT '',
    pub_date TEXT,
    year BIGINT,
    language TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    call_number TEXT NOT NULL DEFAULT '',
    inventory_no TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    condition TEXT NOT NULL DEFAULT 'good',
    status TEXT NOT NULL DEFAULT 'available',
    class_id BIGINT REFERENCES lib_classes(id) ON DELETE SET NULL,
    confidentiality TEXT NOT NULL DEFAULT 'internal',
    loanable BIGINT NOT NULL DEFAULT 1,
    acquired_at TEXT,
    acquired_price BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lib_records_org ON lib_records(org_id, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_lib_records_class ON lib_records(class_id);
  CREATE INDEX IF NOT EXISTS idx_lib_records_doc ON lib_records(doc_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lib_records_inv ON lib_records(org_id, inventory_no) WHERE inventory_no <> '';

  CREATE TABLE IF NOT EXISTS lib_thesaurus (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    broader_id BIGINT REFERENCES lib_thesaurus(id) ON DELETE SET NULL,
    synonyms TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lib_thesaurus_term ON lib_thesaurus(org_id, LOWER(term));

  CREATE TABLE IF NOT EXISTS lib_cat_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    loan_days BIGINT NOT NULL DEFAULT 14,
    max_renewals BIGINT NOT NULL DEFAULT 2,
    max_loans BIGINT NOT NULL DEFAULT 5,
    fine_per_day BIGINT NOT NULL DEFAULT 0,
    block_after_days BIGINT NOT NULL DEFAULT 14,
    block_days BIGINT NOT NULL DEFAULT 30,
    hold_days BIGINT NOT NULL DEFAULT 3,
    remind_before_days BIGINT NOT NULL DEFAULT 2,
    remind_every_days BIGINT NOT NULL DEFAULT 3,
    strict_vocab BIGINT NOT NULL DEFAULT 0,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS lib_loans (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    record_id BIGINT NOT NULL REFERENCES lib_records(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    loaned_by BIGINT,
    loaned_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    returned_at TEXT,
    returned_by BIGINT,
    renewals BIGINT NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active',
    fine BIGINT NOT NULL DEFAULT 0,
    fine_paid BIGINT NOT NULL DEFAULT 0,
    reminders BIGINT NOT NULL DEFAULT 0,
    last_reminder_at TEXT,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_lib_loans_org ON lib_loans(org_id, state);
  CREATE INDEX IF NOT EXISTS idx_lib_loans_record ON lib_loans(record_id);
  CREATE INDEX IF NOT EXISTS idx_lib_loans_user ON lib_loans(user_id);

  CREATE TABLE IF NOT EXISTS lib_reservations (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    record_id BIGINT NOT NULL REFERENCES lib_records(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT NOT NULL,
    ready_at TEXT,
    ready_until TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lib_resa_record ON lib_reservations(record_id, state);
  CREATE INDEX IF NOT EXISTS idx_lib_resa_org ON lib_reservations(org_id, state);

  CREATE TABLE IF NOT EXISTS lib_borrower_blocks (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    until TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    auto BIGINT NOT NULL DEFAULT 0,
    lifted_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lib_bblocks ON lib_borrower_blocks(org_id, user_id);
  `,
  // ----- Étape 1 : versions documentaires (numérotation majeure/mineure, statut, verrouillage) -----
  `
  ALTER TABLE lib_docs ADD COLUMN IF NOT EXISTS doc_status TEXT NOT NULL DEFAULT 'published';
  ALTER TABLE lib_docs ADD COLUMN IF NOT EXISTS locked_by BIGINT;
  ALTER TABLE lib_docs ADD COLUMN IF NOT EXISTS locked_at TEXT;
  ALTER TABLE lib_versions ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
  ALTER TABLE lib_versions ADD COLUMN IF NOT EXISTS bump TEXT NOT NULL DEFAULT 'minor';
  UPDATE lib_versions SET label = '1.' || (n - 1) WHERE label = '';
  `,

  // ----- Étape 2 : droits d'accès (par classe / par notice), délégations, journal de consultation -----
  `
  CREATE TABLE IF NOT EXISTS lib_acl (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    scope_id BIGINT NOT NULL,
    subject_type TEXT NOT NULL,
    subject TEXT NOT NULL,
    effect TEXT NOT NULL DEFAULT 'allow',
    p_read BIGINT NOT NULL DEFAULT 0,
    p_download BIGINT NOT NULL DEFAULT 0,
    p_edit BIGINT NOT NULL DEFAULT 0,
    p_loan BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lib_acl_scope ON lib_acl(org_id, scope, scope_id);
  CREATE TABLE IF NOT EXISTS lib_delegations (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    from_user BIGINT NOT NULL,
    to_user BIGINT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'record',
    scope_id BIGINT,
    p_read BIGINT NOT NULL DEFAULT 1,
    p_download BIGINT NOT NULL DEFAULT 0,
    p_edit BIGINT NOT NULL DEFAULT 0,
    p_loan BIGINT NOT NULL DEFAULT 0,
    until TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lib_deleg ON lib_delegations(org_id, to_user);
  CREATE TABLE IF NOT EXISTS lib_consult (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    record_id BIGINT,
    doc_id BIGINT,
    user_id BIGINT NOT NULL,
    action TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lib_consult_rec ON lib_consult(org_id, record_id);
  CREATE INDEX IF NOT EXISTS idx_lib_consult_at ON lib_consult(org_id, at);
  `,
  // ----- Étape 2 : archivage (cycle de vie, conservation, scellés, gels légaux, certificats de destruction) -----
  `
  ALTER TABLE lib_classes ADD COLUMN IF NOT EXISTS final_fate TEXT NOT NULL DEFAULT 'destroy';
  ALTER TABLE lib_cat_settings ADD COLUMN IF NOT EXISTS active_months BIGINT NOT NULL DEFAULT 12;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS lifecycle_at TEXT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS ret_start TEXT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS ret_months BIGINT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS ret_until TEXT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS sealed_hash TEXT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS sealed_at TEXT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS sealed_by BIGINT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS destroy_ok_by BIGINT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS destroy_ok_at TEXT;
  ALTER TABLE lib_records ADD COLUMN IF NOT EXISTS lost_at TEXT;
  CREATE TABLE IF NOT EXISTS lib_holds (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    released_at TEXT,
    released_by BIGINT
  );
  CREATE TABLE IF NOT EXISTS lib_hold_items (
    hold_id BIGINT NOT NULL REFERENCES lib_holds(id) ON DELETE CASCADE,
    record_id BIGINT NOT NULL REFERENCES lib_records(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    PRIMARY KEY (hold_id, record_id)
  );
  CREATE INDEX IF NOT EXISTS idx_lib_hold_items_rec ON lib_hold_items(record_id);
  CREATE TABLE IF NOT EXISTS lib_destructions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    cert_no TEXT NOT NULL,
    record_id BIGINT,
    title TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT '',
    validated_by BIGINT,
    destroyed_by BIGINT,
    destroyed_at TEXT NOT NULL,
    prev_hash TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lib_destr_no ON lib_destructions(org_id, cert_no);
  `,
  // ----- Étape 2 : texte intégral des documents (recherche) et inventaires (récolements) -----
  `
  CREATE TABLE IF NOT EXISTS lib_doc_text (
    doc_id BIGINT PRIMARY KEY REFERENCES lib_docs(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    n BIGINT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    indexed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lib_inventories (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    scope_type TEXT NOT NULL DEFAULT 'all',
    scope_value TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    started_by BIGINT,
    started_at TEXT NOT NULL,
    closed_by BIGINT,
    closed_at TEXT,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_lib_inv_org ON lib_inventories(org_id, status);
  CREATE TABLE IF NOT EXISTS lib_inventory_lines (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    inventory_id BIGINT NOT NULL REFERENCES lib_inventories(id) ON DELETE CASCADE,
    record_id BIGINT REFERENCES lib_records(id) ON DELETE CASCADE,
    unknown_code TEXT NOT NULL DEFAULT '',
    expected BIGINT NOT NULL DEFAULT 1,
    expected_location TEXT NOT NULL DEFAULT '',
    found_location TEXT,
    scanned_at TEXT,
    scanned_by BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_lib_invl_inv ON lib_inventory_lines(inventory_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lib_invl_rec ON lib_inventory_lines(inventory_id, record_id) WHERE record_id IS NOT NULL;
  `,
];
