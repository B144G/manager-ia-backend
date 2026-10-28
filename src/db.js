'use strict';
// Base de données PostgreSQL (Neon en production, PGlite en test). Le schéma est créé / mis à jour automatiquement au démarrage.
// API conservée proche de l'ancienne version SQLite, mais ASYNCHRONE : await db.prepare(sql).get(...) / .all(...) / .run(...).
const { createDb } = require('./db-driver');
const config = require('./config');
const { parseJSON } = require('./util');

const db = createDb(config.database);

// Chaque élément = une migration, appliquée une seule fois dans l'ordre (numéro enregistré dans schema_migrations).
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'Gratuit',
    plan_expires TEXT,
    interests TEXT NOT NULL DEFAULT '[]',
    progress TEXT NOT NULL DEFAULT '{}',
    project TEXT NOT NULL DEFAULT '{}',
    reminded_for TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_users_contact ON users(contact);
  CREATE INDEX idx_users_plan ON users(plan);

  CREATE TABLE leads (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    what TEXT,
    message TEXT,
    contact TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE payments (
    id BIGSERIAL PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    operator TEXT,
    phone TEXT,
    amount_xaf BIGINT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_ref TEXT,
    transaction_id TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE INDEX idx_payments_reference ON payments(reference);
  CREATE INDEX idx_payments_user ON payments(user_id);
  CREATE INDEX idx_payments_status ON payments(status);
  CREATE INDEX idx_payments_provider ON payments(provider_ref);

  CREATE TABLE notifications (
    id BIGSERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    channels TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE conversations (
    id BIGSERIAL PRIMARY KEY,
    channel TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_conv_contact ON conversations(channel, contact_id, id);
  `,
  `
  -- ===== Espace de travail IA (organisations et modules) =====
  CREATE TABLE orgs (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    sector TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'FCFA',
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    intake_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_orgs_owner ON orgs(owner_id);

  CREATE TABLE branches (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_branches_org ON branches(org_id);

  CREATE TABLE org_members (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    title TEXT NOT NULL DEFAULT '',
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, user_id)
  );
  CREATE INDEX idx_members_user ON org_members(user_id);

  CREATE TABLE invites (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'member',
    title TEXT NOT NULL DEFAULT '',
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    created_by BIGINT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE projects (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    due TEXT,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_projects_org ON projects(org_id);

  CREATE TABLE tasks (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee_id BIGINT,
    due TEXT,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_org ON tasks(org_id, status);
  CREATE INDEX idx_tasks_project ON tasks(project_id);

  CREATE TABLE budget_entries (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    category TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    amount BIGINT NOT NULL,
    date TEXT NOT NULL,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_budget_org_date ON budget_entries(org_id, date);

  CREATE TABLE budget_plans (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    monthly_limit BIGINT NOT NULL,
    PRIMARY KEY (org_id, category)
  );

  CREATE TABLE tickets (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_contact TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'manuel',
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee_id BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_tickets_org ON tickets(org_id, status);

  CREATE TABLE ticket_messages (
    id BIGSERIAL PRIMARY KEY,
    ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    user_id BIGINT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tmsg_ticket ON ticket_messages(ticket_id, id);

  CREATE TABLE positions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    parent_id BIGINT REFERENCES positions(id) ON DELETE SET NULL,
    holder_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_positions_org ON positions(org_id);

  CREATE TABLE processes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_processes_org ON processes(org_id);

  CREATE TABLE ai_messages (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    module TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_ai_org_user ON ai_messages(org_id, user_id, module, id);

  CREATE TABLE activity (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT,
    module TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_activity_org ON activity(org_id, id);
  `,
  // Demandes de validation (décisions à prendre) : une personne soumet, un responsable valide ou refuse.
  `
  CREATE TABLE decisions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    amount BIGINT,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by BIGINT NOT NULL,
    decided_by BIGINT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX idx_decisions_org ON decisions(org_id, status);
  `,
  // Demandes de contact : traitées ou non (tableau de bord administrateur).
  `
  ALTER TABLE leads ADD COLUMN handled BIGINT NOT NULL DEFAULT 0;
  `,
  // Modules « Stock et achats », « Clients et ventes » et « Ressources humaines ».
  `
  CREATE TABLE suppliers (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_suppliers_org ON suppliers(org_id);

  CREATE TABLE stock_items (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'pièce',
    quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
    min_quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
    unit_cost BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_stock_items_org ON stock_items(org_id);

  CREATE TABLE supplier_prices (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    unit_price BIGINT NOT NULL,
    lead_days BIGINT,
    UNIQUE(item_id, supplier_id)
  );

  CREATE TABLE stock_moves (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    delta DOUBLE PRECISION NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_stock_moves_item ON stock_moves(item_id, id);

  CREATE TABLE purchase_orders (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    quantity DOUBLE PRECISION NOT NULL,
    unit_price BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by BIGINT NOT NULL,
    decided_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_po_org ON purchase_orders(org_id, status);

  CREATE TABLE customers (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_customers_org ON customers(org_id);

  CREATE TABLE documents (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    lines TEXT NOT NULL DEFAULT '[]',
    total BIGINT NOT NULL DEFAULT 0,
    paid BIGINT NOT NULL DEFAULT 0,
    issued TEXT NOT NULL,
    due TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_documents_org ON documents(org_id, kind, status);
  CREATE INDEX idx_documents_customer ON documents(customer_id);

  CREATE TABLE employees (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    job TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    hired_at TEXT,
    salary BIGINT,
    status TEXT NOT NULL DEFAULT 'active',
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_employees_org ON employees(org_id);

  CREATE TABLE leaves (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'annual',
    start TEXT NOT NULL,
    "end" TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT NOT NULL DEFAULT '',
    requested_by BIGINT NOT NULL,
    decided_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_leaves_org ON leaves(org_id, status);

  CREATE TABLE shifts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_shifts_org ON shifts(org_id, day);
  `,
  // Compteur des messages IA (quota mensuel commun à l'organisation) : indépendant de l'historique de discussion, qu'un utilisateur peut effacer.
  `
  CREATE TABLE ai_usage (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_ai_usage_org ON ai_usage(org_id, created_at);
  INSERT INTO ai_usage (org_id, user_id, created_at) SELECT org_id, user_id, created_at FROM ai_messages WHERE role = 'user';
  `,
  // E-mails envoyés aux clients (journal) et fichiers joints (images, PDF) stockés dans la base.
  `
  CREATE TABLE org_files (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    data BYTEA NOT NULL,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_org_files_org ON org_files(org_id);
  CREATE TABLE outbox (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    customer_id BIGINT,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_outbox_org ON outbox(org_id, id);
  `,
  // Assistant commercial public : catalogue, conversations avec les prospects, commandes ; prospects/clients.
  `
  ALTER TABLE orgs ADD COLUMN chat_enabled BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE orgs ADD COLUMN sales_info TEXT NOT NULL DEFAULT '';
  ALTER TABLE customers ADD COLUMN stage TEXT NOT NULL DEFAULT 'client';
  ALTER TABLE customers ADD COLUMN source TEXT NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN chat_id BIGINT;
  CREATE TABLE catalog (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price BIGINT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    active BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_catalog_org ON catalog(org_id);
  CREATE TABLE chats (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    session TEXT NOT NULL UNIQUE,
    customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    campaign TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_chats_org ON chats(org_id, updated_at);
  CREATE TABLE chat_messages (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_chat_messages ON chat_messages(chat_id, id);
  `,
  // WhatsApp par organisation (API officielle de Meta) : jetons chiffrés ; conversations WhatsApp.
  `
  ALTER TABLE orgs ADD COLUMN wa_phone_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN wa_token TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN wa_secret TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN wa_verify TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN wa_number TEXT NOT NULL DEFAULT '';
  ALTER TABLE chats ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';
  ALTER TABLE chats ADD COLUMN contact TEXT NOT NULL DEFAULT '';
  `,
  // Mot de passe oublié (liens à usage unique) ; attribution des conversations à un commercial et fiche prospect.
  `
  ALTER TABLE users ADD COLUMN pass_changed_at TEXT;
  CREATE TABLE password_resets (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_by TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );
  ALTER TABLE chats ADD COLUMN assignee_id BIGINT;
  ALTER TABLE chats ADD COLUMN assigned_at TEXT;
  ALTER TABLE chats ADD COLUMN lead TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE orgs ADD COLUMN auto_assign BIGINT NOT NULL DEFAULT 0;
  `,
  // Inscription avec code envoyé par e-mail (valable 1 minute) : le compte n'existe qu'après vérification.
  `
  CREATE TABLE signup_codes (
    contact TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    interests TEXT NOT NULL DEFAULT '[]',
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts BIGINT NOT NULL DEFAULT 0,
    sent_at TEXT NOT NULL,
    sends BIGINT NOT NULL DEFAULT 1,
    window_start TEXT NOT NULL
  );
  `,
  // Sécurité : verrouillage après échecs de connexion et journal de sécurité.
  `
  CREATE TABLE login_fails (
    k TEXT PRIMARY KEY,
    fails BIGINT NOT NULL DEFAULT 0,
    first_at TEXT NOT NULL,
    locked_until TEXT
  );
  CREATE TABLE security_log (
    id BIGSERIAL PRIMARY KEY,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    user_id BIGINT,
    ip TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX security_log_at ON security_log(at);
  `,
  // Messages WhatsApp sortants (modèles approuvés par Meta) : modèles, journal d'envoi, désabonnements, relances automatiques.
  `
  CREATE TABLE wa_templates (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'fr',
    purpose TEXT NOT NULL DEFAULT 'general',
    params BIGINT NOT NULL DEFAULT 0,
    preview TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (org_id, name, language)
  );
  CREATE TABLE wa_outbound (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    chat_id BIGINT,
    ref_kind TEXT NOT NULL DEFAULT '',
    ref_id BIGINT,
    phone TEXT NOT NULL,
    template TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_wa_outbound ON wa_outbound(org_id, ref_kind, ref_id, created_at);
  CREATE TABLE wa_optout (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (org_id, phone)
  );
  ALTER TABLE orgs ADD COLUMN wa_followup BIGINT NOT NULL DEFAULT 0;
  `,
  // Images et documents envoyés par les prospects (WhatsApp) : conservés pour l'équipe, lus par l'IA.
  `
  CREATE TABLE chat_media (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    data BYTEA NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_chat_media ON chat_media(chat_id, id);
  `,
  // Comptabilité simple (plan comptable OHADA de base) : comptes, écritures équilibrées non modifiables, réglages ; paiements de factures détaillés.
  `
  CREATE TABLE doc_payments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    doc_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL,
    date TEXT NOT NULL,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_doc_payments ON doc_payments(org_id, doc_id);
  INSERT INTO doc_payments (org_id, doc_id, amount, date, created_by, created_at)
    SELECT org_id, id, paid, substr(updated_at, 1, 10), NULL, updated_at FROM documents WHERE kind = 'invoice' AND paid > 0;
  CREATE TABLE acc_accounts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    label TEXT NOT NULL,
    custom BIGINT NOT NULL DEFAULT 0,
    UNIQUE (org_id, code)
  );
  CREATE TABLE acc_entries (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    journal TEXT NOT NULL,
    number TEXT NOT NULL,
    date TEXT NOT NULL,
    label TEXT NOT NULL,
    piece TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    source_id BIGINT,
    reversed_of BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, number)
  );
  CREATE UNIQUE INDEX idx_acc_source ON acc_entries(org_id, source, source_id) WHERE source != '';
  CREATE INDEX idx_acc_entries_date ON acc_entries(org_id, date);
  CREATE TABLE acc_lines (
    id BIGSERIAL PRIMARY KEY,
    entry_id BIGINT NOT NULL REFERENCES acc_entries(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL,
    account TEXT NOT NULL,
    debit BIGINT NOT NULL DEFAULT 0,
    credit BIGINT NOT NULL DEFAULT 0,
    memo TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_acc_lines_account ON acc_lines(org_id, account);
  CREATE INDEX idx_acc_lines_entry ON acc_lines(entry_id);
  CREATE TABLE acc_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    vat_rate DOUBLE PRECISION NOT NULL DEFAULT 19.25,
    pay_account TEXT NOT NULL DEFAULT '571',
    purchase_vat BIGINT NOT NULL DEFAULT 0,
    locked_until TEXT
  );
  `,
  // Messenger et Instagram (messages privés) par organisation ; clés d'API et webhooks sortants (intégrations).
  `
  ALTER TABLE orgs ADD COLUMN fb_page_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN fb_token TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN fb_secret TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN fb_verify TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN ig_id TEXT NOT NULL DEFAULT '';
  CREATE TABLE api_keys (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL DEFAULT 'read',
    last_used TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE webhooks_out (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT NOT NULL,
    secret TEXT NOT NULL,
    active BIGINT NOT NULL DEFAULT 1,
    fails BIGINT NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT '',
    last_at TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // Photos et vidéos des articles du catalogue, envoyées aux clients par WhatsApp (identifiant Meta gardé 25 jours pour ne pas renvoyer le fichier).
  `
  CREATE TABLE catalog_media (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES catalog(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    data BYTEA NOT NULL,
    wa_media_id TEXT NOT NULL DEFAULT '',
    wa_phone_id TEXT NOT NULL DEFAULT '',
    wa_media_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_catalog_media ON catalog_media(item_id, id);
  `,
  // Délai de réponse choisi par l'organisation (0 à 180 s), réponse vocale, file des réponses en attente, fichiers temporaires (voix) servis par lien signé.
  `
  ALTER TABLE orgs ADD COLUMN reply_delay BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE orgs ADD COLUMN voice_reply TEXT NOT NULL DEFAULT 'mirror';
  CREATE TABLE reply_queue (
    chat_id BIGINT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    due_at TEXT NOT NULL,
    via_voice BIGINT NOT NULL DEFAULT 0,
    media_id BIGINT,
    last_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_reply_queue_due ON reply_queue(due_at);
  CREATE TABLE tmp_files (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
  // Rendez-vous pris par l'assistant public, passage automatique à l'équipe après une commande ou un rendez-vous, dossier préparé par l'IA interne.
  `
  CREATE TABLE appointments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    chat_id BIGINT REFERENCES chats(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    duration BIGINT NOT NULL DEFAULT 60,
    purpose TEXT NOT NULL DEFAULT '',
    place TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'assistant',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_appointments ON appointments(org_id, date, time);
  ALTER TABLE orgs ADD COLUMN handoff_order BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE orgs ADD COLUMN handoff_appt BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE chats ADD COLUMN brief TEXT NOT NULL DEFAULT '';
  `,
  // Rappel de rendez-vous la veille, et lien d'agenda (Google Agenda, Outlook, Apple) propre à chaque organisation.
  `
  ALTER TABLE appointments ADD COLUMN reminded_at TEXT;
  ALTER TABLE orgs ADD COLUMN cal_token TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN appt_reminder BIGINT NOT NULL DEFAULT 1;
  `,
  // Centre de sécurité : sessions révocables, journal d'audit chaîné, blocage d'adresses IP, limites de débit partagées, double authentification (TOTP).
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'user',
    user_id BIGINT,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    ua TEXT NOT NULL DEFAULT '',
    revoked_at TEXT,
    revoke_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id, revoked_at);
  CREATE INDEX idx_sessions_kind ON sessions(kind, revoked_at);

  CREATE TABLE audit_trail (
    id BIGSERIAL PRIMARY KEY,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'system',
    actor_id BIGINT,
    org_id BIGINT,
    action TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    target TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    ua TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX idx_audit_at ON audit_trail(at);
  CREATE INDEX idx_audit_sev ON audit_trail(severity, id);
  CREATE INDEX idx_audit_actor ON audit_trail(actor_type, actor_id);
  CREATE INDEX idx_audit_org ON audit_trail(org_id, id);

  CREATE TABLE ip_blocks (
    ip TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    blocked_until TEXT,
    permanent BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'auto'
  );
  CREATE TABLE ip_strikes (
    ip TEXT PRIMARY KEY,
    score BIGINT NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL
  );
  CREATE TABLE rate_hits (
    k TEXT PRIMARY KEY,
    hits BIGINT NOT NULL,
    reset_at BIGINT NOT NULL
  );

  ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN totp_enabled BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_step BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE admin_2fa (
    id BIGINT PRIMARY KEY,
    totp_secret TEXT NOT NULL DEFAULT '',
    enabled BIGINT NOT NULL DEFAULT 0,
    totp_step BIGINT NOT NULL DEFAULT 0,
    recovery_codes TEXT NOT NULL DEFAULT '[]'
  );
  INSERT INTO admin_2fa (id) VALUES (1);
  `,
  /* SLOT finance : migration réservée */ `
  CREATE TABLE payroll_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    rules TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE payroll_slips (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL,
    employee_name TEXT NOT NULL,
    job TEXT NOT NULL DEFAULT '',
    month TEXT NOT NULL,
    base BIGINT NOT NULL DEFAULT 0,
    bonuses BIGINT NOT NULL DEFAULT 0,
    overtime BIGINT NOT NULL DEFAULT 0,
    advances BIGINT NOT NULL DEFAULT 0,
    other_deductions BIGINT NOT NULL DEFAULT 0,
    gross BIGINT NOT NULL DEFAULT 0,
    employee_deductions BIGINT NOT NULL DEFAULT 0,
    employer_charges BIGINT NOT NULL DEFAULT 0,
    net BIGINT NOT NULL DEFAULT 0,
    employer_cost BIGINT NOT NULL DEFAULT 0,
    lines TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    validated_at TEXT,
    validated_by BIGINT,
    paid_date TEXT,
    pay_method TEXT NOT NULL DEFAULT '',
    budget_entry_id BIGINT,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, employee_id, month)
  );
  CREATE INDEX idx_payroll_slips_month ON payroll_slips(org_id, month);
  CREATE TABLE fiscal_obligations (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    period TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    amount BIGINT NOT NULL DEFAULT 0,
    reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    recurrence TEXT NOT NULL DEFAULT 'none',
    done_date TEXT,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_fiscal_obligations_due ON fiscal_obligations(org_id, due_date);
  `,
  /* SLOT commerce : migration réservée */ `
  CREATE TABLE marketing_campaigns (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'other',
    objective TEXT NOT NULL DEFAULT '',
    budget BIGINT NOT NULL DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    code TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_mkt_campaigns_org ON marketing_campaigns(org_id, status);
  CREATE TABLE marketing_expenses (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    campaign_id BIGINT NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    amount BIGINT NOT NULL,
    date TEXT NOT NULL,
    budget_entry_id BIGINT,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_mkt_expenses_org ON marketing_expenses(org_id, date);
  CREATE TABLE marketing_posts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    campaign_id BIGINT REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'other',
    text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idea',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_mkt_posts_org ON marketing_posts(org_id, date);
  CREATE TABLE marketing_offers (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'percent',
    value BIGINT NOT NULL DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    description TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_mkt_offers_org ON marketing_offers(org_id);

  CREATE TABLE logistics_carriers (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    zones TEXT NOT NULL DEFAULT '',
    rate BIGINT NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    active BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_log_carriers_org ON logistics_carriers(org_id);
  CREATE TABLE logistics_zones (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    fee BIGINT NOT NULL DEFAULT 0,
    delay_days BIGINT NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_log_zones_org ON logistics_zones(org_id);
  CREATE TABLE logistics_rounds (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    carrier_id BIGINT REFERENCES logistics_carriers(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_log_rounds_org ON logistics_rounds(org_id, date);
  CREATE TABLE logistics_deliveries (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    doc_id BIGINT REFERENCES documents(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    zone_id BIGINT REFERENCES logistics_zones(id) ON DELETE SET NULL,
    carrier_id BIGINT REFERENCES logistics_carriers(id) ON DELETE SET NULL,
    round_id BIGINT REFERENCES logistics_rounds(id) ON DELETE SET NULL,
    round_pos BIGINT NOT NULL DEFAULT 0,
    fee BIGINT NOT NULL DEFAULT 0,
    planned_date TEXT,
    status TEXT NOT NULL DEFAULT 'to_prepare',
    tracking TEXT NOT NULL DEFAULT '',
    received_by TEXT NOT NULL DEFAULT '',
    proof TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_log_deliveries_org ON logistics_deliveries(org_id, status, planned_date);
  CREATE INDEX idx_log_deliveries_round ON logistics_deliveries(round_id);
  CREATE TABLE logistics_events (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    delivery_id BIGINT NOT NULL REFERENCES logistics_deliveries(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_log_events_delivery ON logistics_events(delivery_id, id);

  CREATE TABLE legal_contracts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    parties TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    amount BIGINT NOT NULL DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    tacit BIGINT NOT NULL DEFAULT 0,
    notice_days BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    doc_ref TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_contracts_org ON legal_contracts(org_id, status, end_date);
  CREATE TABLE legal_obligations (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    due_date TEXT,
    recurrence_months BIGINT NOT NULL DEFAULT 0,
    responsible_id BIGINT,
    status TEXT NOT NULL DEFAULT 'pending',
    proof TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    last_done TEXT,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_obligations_org ON legal_obligations(org_id, status, due_date);
  CREATE TABLE legal_disputes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'dispute',
    title TEXT NOT NULL,
    counterparty TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    amount BIGINT NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    next_step TEXT NOT NULL DEFAULT '',
    next_date TEXT,
    outcome TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_disputes_org ON legal_disputes(org_id, status);
  CREATE TABLE legal_privacy (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    data_kind TEXT NOT NULL,
    people TEXT NOT NULL DEFAULT '',
    stored_where TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    retention TEXT NOT NULL DEFAULT '',
    shared_with TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_privacy_org ON legal_privacy(org_id);
  `,
  /* SLOT ops : migration réservée */ `
  CREATE TABLE production_boms (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    labor_cost BIGINT NOT NULL DEFAULT 0,
    other_cost BIGINT NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(product_id)
  );
  CREATE INDEX idx_production_boms_org ON production_boms(org_id);
  CREATE TABLE production_bom_lines (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    bom_id BIGINT NOT NULL REFERENCES production_boms(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    quantity DOUBLE PRECISION NOT NULL
  );
  CREATE INDEX idx_production_bom_lines_bom ON production_bom_lines(bom_id);
  CREATE TABLE production_orders (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    code TEXT NOT NULL,
    bom_id BIGINT REFERENCES production_boms(id) ON DELETE SET NULL,
    product_id BIGINT REFERENCES stock_items(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL DEFAULT '',
    quantity DOUBLE PRECISION NOT NULL,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    produced_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
    scrap_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
    unit_cost BIGINT NOT NULL DEFAULT 0,
    total_cost BIGINT NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    launched_at TEXT,
    closed_at TEXT,
    UNIQUE(org_id, seq)
  );
  CREATE INDEX idx_production_orders_org ON production_orders(org_id, status);

  CREATE TABLE maintenance_equipment (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'machine',
    reference TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    purchased_at TEXT,
    value BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    meter DOUBLE PRECISION NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_maintenance_equipment_org ON maintenance_equipment(org_id);
  CREATE TABLE maintenance_plans (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    equipment_id BIGINT NOT NULL REFERENCES maintenance_equipment(id) ON DELETE CASCADE,
    task TEXT NOT NULL,
    period_kind TEXT NOT NULL DEFAULT 'days',
    period_value DOUBLE PRECISION NOT NULL,
    last_done_at TEXT,
    last_meter DOUBLE PRECISION NOT NULL DEFAULT 0,
    next_due_at TEXT,
    next_meter DOUBLE PRECISION,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_maintenance_plans_eq ON maintenance_plans(equipment_id);
  CREATE TABLE maintenance_orders (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    code TEXT NOT NULL,
    equipment_id BIGINT NOT NULL REFERENCES maintenance_equipment(id) ON DELETE CASCADE,
    plan_id BIGINT REFERENCES maintenance_plans(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'corrective',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee_id BIGINT,
    contractor TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TEXT NOT NULL,
    started_at TEXT,
    closed_at TEXT,
    downtime_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
    labor_cost BIGINT NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE(org_id, seq)
  );
  CREATE INDEX idx_maintenance_orders_org ON maintenance_orders(org_id, status);
  CREATE INDEX idx_maintenance_orders_eq ON maintenance_orders(equipment_id);
  CREATE TABLE maintenance_parts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    order_id BIGINT NOT NULL REFERENCES maintenance_orders(id) ON DELETE CASCADE,
    item_id BIGINT REFERENCES stock_items(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    quantity DOUBLE PRECISION NOT NULL,
    unit_cost BIGINT NOT NULL DEFAULT 0,
    from_stock BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_maintenance_parts_order ON maintenance_parts(order_id);

  CREATE TABLE construction_sites (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    client TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    foreman_id BIGINT,
    start_date TEXT,
    end_date TEXT,
    budget BIGINT NOT NULL DEFAULT 0,
    cost_budget BIGINT NOT NULL DEFAULT 0,
    remaining_estimate BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'preparation',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_construction_sites_org ON construction_sites(org_id, status);
  CREATE TABLE construction_phases (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    site_id BIGINT NOT NULL REFERENCES construction_sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    weight DOUBLE PRECISION NOT NULL DEFAULT 1,
    progress DOUBLE PRECISION NOT NULL DEFAULT 0,
    planned_start TEXT,
    planned_end TEXT,
    actual_start TEXT,
    actual_end TEXT,
    notes TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_construction_phases_site ON construction_phases(site_id);
  CREATE TABLE construction_expenses (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    site_id BIGINT NOT NULL REFERENCES construction_sites(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    amount BIGINT NOT NULL,
    date TEXT NOT NULL,
    budget_entry_id BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_construction_expenses_site ON construction_expenses(site_id, date);
  CREATE TABLE construction_timesheets (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    site_id BIGINT NOT NULL REFERENCES construction_sites(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    worker TEXT NOT NULL DEFAULT '',
    headcount BIGINT NOT NULL DEFAULT 1,
    hours DOUBLE PRECISION NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_construction_timesheets_site ON construction_timesheets(site_id, date);
  CREATE TABLE construction_reports (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    site_id BIGINT NOT NULL REFERENCES construction_sites(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    weather TEXT NOT NULL DEFAULT '',
    work TEXT NOT NULL DEFAULT '',
    headcount BIGINT NOT NULL DEFAULT 0,
    incidents TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_construction_reports_site ON construction_reports(site_id, date);
  CREATE TABLE construction_issues (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    site_id BIGINT NOT NULL REFERENCES construction_sites(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'incident',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_at TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_construction_issues_site ON construction_issues(site_id, status);
  CREATE TABLE construction_billings (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    site_id BIGINT NOT NULL REFERENCES construction_sites(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    amount BIGINT NOT NULL,
    billed_at TEXT NOT NULL,
    due_date TEXT,
    paid_amount BIGINT NOT NULL DEFAULT 0,
    paid_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_construction_billings_site ON construction_billings(site_id);
  `,
  /* SLOT intelligence : migration réservée */ `
  CREATE TABLE memory_entries (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL,
    author_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    link_kind TEXT NOT NULL DEFAULT '',
    link_id BIGINT,
    link_label TEXT NOT NULL DEFAULT '',
    restricted BIGINT NOT NULL DEFAULT 0,
    search_text TEXT NOT NULL DEFAULT '',
    version BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_memory_org ON memory_entries(org_id, event_date);
  CREATE INDEX idx_memory_fts ON memory_entries USING GIN (to_tsvector('french', search_text));
  CREATE TABLE memory_versions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    entry_id BIGINT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    version BIGINT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    edited_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_memory_versions ON memory_versions(entry_id, version);
  CREATE TABLE agents_config (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    agent_key TEXT NOT NULL,
    enabled BIGINT NOT NULL DEFAULT 1,
    extra_prompt TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, agent_key)
  );
  CREATE TABLE agents_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    mode TEXT NOT NULL,
    question TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_agents_log ON agents_log(org_id, user_id, id);
  CREATE TABLE digest_settings (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
    tz_offset BIGINT NOT NULL DEFAULT 60,
    urgent_max_day BIGINT NOT NULL DEFAULT 5,
    handoff_hours BIGINT NOT NULL DEFAULT 4,
    invoice_late_days BIGINT NOT NULL DEFAULT 30,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE digest_subs (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL DEFAULT '',
    morning BIGINT NOT NULL DEFAULT 0,
    urgent BIGINT NOT NULL DEFAULT 0,
    send_minute BIGINT NOT NULL DEFAULT 480,
    template_name TEXT NOT NULL DEFAULT '',
    consent_at TEXT,
    consent_text TEXT NOT NULL DEFAULT '',
    unsub_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, user_id)
  );
  CREATE TABLE digest_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    batch TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    wa_error TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (org_id, user_id, kind, dedupe_key)
  );
  CREATE INDEX idx_digest_log ON digest_log(org_id, user_id, id);
  `,
  // Juridique : modèles propres à l'organisation, pièces jointes (chiffrées), historique des contrats, signature (suivi interne), rappels attribués.
  `
  ALTER TABLE legal_contracts ADD COLUMN assignee_id BIGINT;
  ALTER TABLE legal_contracts ADD COLUMN sign_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE legal_contracts ADD COLUMN signed_at TEXT;
  ALTER TABLE legal_contracts ADD COLUMN signers TEXT NOT NULL DEFAULT '';
  ALTER TABLE legal_obligations ADD COLUMN doc_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE legal_disputes ADD COLUMN assignee_id BIGINT;
  ALTER TABLE legal_disputes ADD COLUMN doc_ref TEXT NOT NULL DEFAULT '';
  CREATE TABLE legal_templates (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'document',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_templates_org ON legal_templates(org_id, kind);
  CREATE TABLE legal_files (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parent_type TEXT NOT NULL,
    parent_id BIGINT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    data BYTEA NOT NULL,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_files_parent ON legal_files(org_id, parent_type, parent_id);
  CREATE TABLE legal_history (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    contract_id BIGINT NOT NULL REFERENCES legal_contracts(id) ON DELETE CASCADE,
    user_id BIGINT,
    user_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    changes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_history_contract ON legal_history(contract_id, id);
  `,
  /* finance 2 : heures supplémentaires, 13e mois, comptabilisation de la paie, réouverture, clôture d'exercice, répétition des échéances */ `
  ALTER TABLE payroll_settings ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE payroll_slips ADD COLUMN overtime_hours TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE payroll_slips ADD COLUMN hourly_rate BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE payroll_slips ADD COLUMN annual_bonus BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE payroll_slips ADD COLUMN annual_bonus_label TEXT NOT NULL DEFAULT '';
  ALTER TABLE payroll_slips ADD COLUMN acc_entry_id BIGINT;
  ALTER TABLE payroll_slips ADD COLUMN acc_pay_entry_id BIGINT;
  ALTER TABLE payroll_slips ADD COLUMN reopened_count BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE payroll_slips ADD COLUMN reopen_reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE payroll_slips ADD COLUMN reopened_at TEXT;
  ALTER TABLE payroll_slips ADD COLUMN reopened_by BIGINT;
  ALTER TABLE fiscal_obligations ADD COLUMN auto_repeat BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE fiscal_obligations ADD COLUMN parent_id BIGINT;
  CREATE TABLE fiscal_closings (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    year TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_fiscal_closings ON fiscal_closings(org_id, year, id);
  `,
  `
  ALTER TABLE orgs ADD COLUMN wa_waba TEXT NOT NULL DEFAULT '';
  `,
  /* WhatsApp par QR code (appareil connecté, méthode non officielle) : mode de l'organisation, session, et état d'authentification CHIFFRÉ (jamais de fichier sur disque) */ `
  ALTER TABLE orgs ADD COLUMN wa_mode TEXT NOT NULL DEFAULT 'meta';
  CREATE TABLE wa_qr_sessions (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    accepted_at TEXT NOT NULL,
    accepted_by BIGINT,
    number TEXT NOT NULL DEFAULT '',
    since TEXT,
    day_key TEXT NOT NULL DEFAULT '',
    day_count BIGINT NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE wa_qr_auth (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    item_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, item_key)
  );
  `,
  /* VAGUE 1 · facture conforme : NIU, TVA, mentions, numérotation par séquence, modes de paiement, avoirs. Les anciens documents gardent total = TTC (vat_rate vide = « ancien document »). */ `
  ALTER TABLE orgs ADD COLUMN niu TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN rccm TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN address TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN pay_info TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN invoice_footer TEXT NOT NULL DEFAULT '';
  ALTER TABLE orgs ADD COLUMN vat_rate DOUBLE PRECISION NOT NULL DEFAULT 19.25;
  ALTER TABLE customers ADD COLUMN niu TEXT NOT NULL DEFAULT '';
  ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN vat_rate DOUBLE PRECISION;
  ALTER TABLE documents ADD COLUMN prices_incl BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE documents ADD COLUMN subtotal_ht BIGINT;
  ALTER TABLE documents ADD COLUMN vat_amount BIGINT;
  ALTER TABLE documents ADD COLUMN credited BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE documents ADD COLUMN credit_of BIGINT REFERENCES documents(id) ON DELETE SET NULL;
  ALTER TABLE documents ADD COLUMN credit_reason TEXT NOT NULL DEFAULT '';
  CREATE TABLE doc_sequences (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    year TEXT NOT NULL,
    last BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, kind, year)
  );
  INSERT INTO doc_sequences (org_id, kind, year, last)
    SELECT org_id, kind, split_part(number, '-', 2), MAX(CAST(split_part(number, '-', 3) AS BIGINT)) FROM documents
    WHERE number ~ '^[A-Z]+-[0-9]{4}-[0-9]+$' GROUP BY org_id, kind, split_part(number, '-', 2);
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM documents GROUP BY org_id, number HAVING COUNT(*) > 1) THEN
      CREATE UNIQUE INDEX uq_documents_number ON documents(org_id, number);
    END IF;
  END $$;
  ALTER TABLE doc_payments ADD COLUMN method TEXT NOT NULL DEFAULT '';
  ALTER TABLE doc_payments ADD COLUMN reference TEXT NOT NULL DEFAULT '';
  ALTER TABLE doc_payments ADD COLUMN operator TEXT NOT NULL DEFAULT '';
  ALTER TABLE doc_payments ADD COLUMN payer_phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE doc_payments ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
  ALTER TABLE doc_payments ADD COLUMN note TEXT NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX uq_doc_payments_ref ON doc_payments(org_id, method, reference) WHERE reference <> '' AND status <> 'failed';
  `,
  /* VAGUE 1 · stock : lots et péremption, séries / VIN, CUMP, SKU et codes-barres, stock maximum, inventaire physique, réceptions partielles et retards fournisseurs */ `
  ALTER TABLE stock_items ADD COLUMN sku TEXT NOT NULL DEFAULT '';
  ALTER TABLE stock_items ADD COLUMN barcode TEXT NOT NULL DEFAULT '';
  ALTER TABLE stock_items ADD COLUMN max_quantity DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE stock_items ADD COLUMN tracking TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE stock_items ADD COLUMN pick_rule TEXT NOT NULL DEFAULT 'fefo';
  ALTER TABLE stock_items ADD COLUMN avg_cost DOUBLE PRECISION NOT NULL DEFAULT 0;
  UPDATE stock_items SET avg_cost = unit_cost;
  CREATE UNIQUE INDEX uq_stock_items_sku ON stock_items(org_id, sku) WHERE sku <> '';
  CREATE UNIQUE INDEX uq_stock_items_barcode ON stock_items(org_id, barcode) WHERE barcode <> '';
  ALTER TABLE stock_moves ADD COLUMN unit_cost DOUBLE PRECISION;
  ALTER TABLE stock_moves ADD COLUMN ref_kind TEXT NOT NULL DEFAULT '';
  ALTER TABLE stock_moves ADD COLUMN ref_id BIGINT;
  CREATE TABLE stock_lots (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    lot_no TEXT NOT NULL,
    expiry TEXT,
    quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
    unit_cost BIGINT NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_stock_lots_item ON stock_lots(item_id, expiry);
  CREATE INDEX idx_stock_lots_org ON stock_lots(org_id, expiry);
  CREATE TABLE stock_serials (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    serial TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_stock',
    received_at TEXT NOT NULL,
    out_at TEXT,
    out_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (org_id, serial)
  );
  CREATE INDEX idx_stock_serials_item ON stock_serials(item_id, status);
  ALTER TABLE purchase_orders ADD COLUMN promised_date TEXT;
  ALTER TABLE purchase_orders ADD COLUMN received_qty DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE purchase_orders ADD COLUMN received_at TEXT;
  UPDATE purchase_orders SET received_qty = quantity, received_at = updated_at WHERE status = 'received';
  CREATE TABLE purchase_receipts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    order_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    quantity DOUBLE PRECISION NOT NULL,
    unit_price BIGINT NOT NULL DEFAULT 0,
    lot_no TEXT NOT NULL DEFAULT '',
    expiry TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_purchase_receipts_order ON purchase_receipts(order_id);
  CREATE TABLE stock_counts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    seq BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    decided_by BIGINT,
    decided_at TEXT,
    decision_note TEXT NOT NULL DEFAULT '',
    UNIQUE (org_id, seq)
  );
  CREATE TABLE stock_count_lines (
    id BIGSERIAL PRIMARY KEY,
    count_id BIGINT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    expected DOUBLE PRECISION NOT NULL,
    counted DOUBLE PRECISION,
    unit_value DOUBLE PRECISION NOT NULL DEFAULT 0,
    UNIQUE (count_id, item_id)
  );
  `,
  /* VAGUE 1 · logistique et parc : véhicules, chauffeurs, échéances réglementaires, carburant, stock des livraisons */ `
  CREATE TABLE logistics_vehicles (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    plate TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'van',
    vin TEXT NOT NULL DEFAULT '',
    capacity TEXT NOT NULL DEFAULT '',
    odometer DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    equipment_id BIGINT REFERENCES maintenance_equipment(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (org_id, plate)
  );
  CREATE TABLE logistics_drivers (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    license_no TEXT NOT NULL DEFAULT '',
    license_category TEXT NOT NULL DEFAULT '',
    active BIGINT NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE logistics_compliance (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    vehicle_id BIGINT REFERENCES logistics_vehicles(id) ON DELETE CASCADE,
    driver_id BIGINT REFERENCES logistics_drivers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_log_compliance_org ON logistics_compliance(org_id, expires_at);
  CREATE TABLE logistics_fuel (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    vehicle_id BIGINT NOT NULL REFERENCES logistics_vehicles(id) ON DELETE CASCADE,
    driver_id BIGINT REFERENCES logistics_drivers(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    liters DOUBLE PRECISION NOT NULL,
    amount BIGINT NOT NULL DEFAULT 0,
    odometer DOUBLE PRECISION NOT NULL,
    station TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_log_fuel_vehicle ON logistics_fuel(vehicle_id, odometer);
  ALTER TABLE logistics_rounds ADD COLUMN vehicle_id BIGINT REFERENCES logistics_vehicles(id) ON DELETE SET NULL;
  ALTER TABLE logistics_rounds ADD COLUMN driver_id BIGINT REFERENCES logistics_drivers(id) ON DELETE SET NULL;
  ALTER TABLE logistics_deliveries ADD COLUMN stock_out BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE logistics_deliveries ADD COLUMN stock_back BIGINT NOT NULL DEFAULT 0;
  CREATE TABLE logistics_delivery_items (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    delivery_id BIGINT NOT NULL REFERENCES logistics_deliveries(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    quantity DOUBLE PRECISION NOT NULL,
    serials TEXT NOT NULL DEFAULT '[]',
    allocations TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX idx_log_delivery_items ON logistics_delivery_items(delivery_id);
  `,
  /* VAGUE 2 · paie Cameroun : modèle versionné + surcharges de l'organisation, absences non payées, solde de tout compte, coordonnées de paiement des employés */ `
  ALTER TABLE employees ADD COLUMN cnps_no TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN niu TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN pay_channel TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN pay_account TEXT NOT NULL DEFAULT '';
  ALTER TABLE payroll_slips ADD COLUMN engine TEXT NOT NULL DEFAULT '';
  ALTER TABLE payroll_slips ADD COLUMN model_version TEXT NOT NULL DEFAULT '';
  ALTER TABLE payroll_slips ADD COLUMN absence_days DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE payroll_slips ADD COLUMN absence_deduction BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE payroll_slips ADD COLUMN calc_detail TEXT NOT NULL DEFAULT '';
  CREATE TABLE payroll_cm_overrides (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    updated_by BIGINT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, key)
  );
  CREATE TABLE payroll_settlements (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL,
    employee_name TEXT NOT NULL,
    exit_date TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    total BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_payroll_settlements ON payroll_settlements(org_id, exit_date);
  `,
  /* VAGUE 2 · comptabilité : rapprochement bancaire, lettrage, dettes fournisseurs, immobilisations, clôture mensuelle, écarts de caisse */ `
  CREATE TABLE bank_accounts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    gl_account TEXT NOT NULL DEFAULT '521',
    account_no TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE bank_lines (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    bank_id BIGINT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    amount BIGINT NOT NULL,
    balance BIGINT,
    status TEXT NOT NULL DEFAULT 'unmatched',
    acc_line_id BIGINT,
    matched_by BIGINT,
    matched_at TEXT,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (bank_id, hash)
  );
  CREATE INDEX idx_bank_lines_bank ON bank_lines(bank_id, date);
  CREATE UNIQUE INDEX uq_bank_lines_acc ON bank_lines(acc_line_id) WHERE acc_line_id IS NOT NULL;
  ALTER TABLE acc_lines ADD COLUMN letter TEXT NOT NULL DEFAULT '';
  CREATE TABLE acc_lettering (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    account TEXT NOT NULL,
    code TEXT NOT NULL,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, account, code)
  );
  CREATE TABLE supplier_bills (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name TEXT NOT NULL DEFAULT '',
    number TEXT NOT NULL DEFAULT '',
    bill_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    amount BIGINT NOT NULL,
    paid BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT NOT NULL DEFAULT 'manual',
    source_id BIGINT,
    acc_entry_id BIGINT,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_supplier_bills ON supplier_bills(org_id, status, due_date);
  CREATE UNIQUE INDEX uq_supplier_bills_src ON supplier_bills(org_id, source, source_id) WHERE source <> 'manual';
  CREATE TABLE supplier_payments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    bill_id BIGINT NOT NULL REFERENCES supplier_bills(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL,
    date TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'bank',
    reference TEXT NOT NULL DEFAULT '',
    acc_entry_id BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE fixed_assets (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'equipment',
    acquired_on TEXT NOT NULL,
    start_month TEXT NOT NULL,
    cost BIGINT NOT NULL,
    residual BIGINT NOT NULL DEFAULT 0,
    life_months BIGINT NOT NULL,
    asset_account TEXT NOT NULL,
    amort_account TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    disposed_on TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE asset_depreciations (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    asset_id BIGINT NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    amount BIGINT NOT NULL,
    acc_entry_id BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (asset_id, period)
  );
  CREATE TABLE month_closings (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    checks TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    closed_by BIGINT,
    closed_at TEXT,
    reopen_reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (org_id, month)
  );
  CREATE TABLE acc_adjustments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    amount BIGINT NOT NULL,
    account TEXT NOT NULL,
    entry_id BIGINT,
    reversal_id BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE cash_counts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    expected BIGINT NOT NULL,
    counted BIGINT NOT NULL,
    diff BIGINT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    entry_id BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  `,
  /* VAGUE 2 · budget : budget annuel, une seule source de vérité avec la compta (lignes miroirs repérées), validation des dépenses par seuil */ `
  ALTER TABLE budget_entries ADD COLUMN source TEXT NOT NULL DEFAULT '';
  ALTER TABLE budget_entries ADD COLUMN source_id BIGINT;
  ALTER TABLE budget_entries ADD COLUMN acc_entry_id BIGINT;
  ALTER TABLE budget_entries ADD COLUMN in_ledger BIGINT NOT NULL DEFAULT 0;
  UPDATE budget_entries SET source = 'payroll', source_id = s.id FROM payroll_slips s WHERE s.budget_entry_id = budget_entries.id AND s.org_id = budget_entries.org_id;
  UPDATE budget_entries SET source = 'invoice', source_id = d.id FROM documents d
    WHERE d.org_id = budget_entries.org_id AND budget_entries.source = '' AND budget_entries.kind = 'income' AND budget_entries.category = 'Ventes' AND budget_entries.label = 'Paiement ' || d.number;
  CREATE TABLE budget_annual (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    year TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT NOT NULL,
    amounts TEXT NOT NULL DEFAULT '[]',
    UNIQUE (org_id, year, kind, category)
  );
  CREATE TABLE budget_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    approval_threshold BIGINT NOT NULL DEFAULT 0
  );
  CREATE TABLE expense_requests (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    amount BIGINT NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by BIGINT NOT NULL,
    decided_by BIGINT,
    decided_at TEXT,
    decision_note TEXT NOT NULL DEFAULT '',
    budget_entry_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_expense_requests ON expense_requests(org_id, status);
  CREATE TABLE budget_account_map (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    prefix TEXT NOT NULL,
    category TEXT NOT NULL,
    PRIMARY KEY (org_id, prefix)
  );
  `,
  /* VAGUE 3 · socle : réglages par organisation, notifications internes, journal d'audit */ `
  CREATE TABLE org_settings (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (org_id, key)
  );
  CREATE TABLE notices (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    is_read BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_notices ON notices(org_id, user_id, is_read);
  CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT,
    entity TEXT NOT NULL,
    entity_id BIGINT,
    action TEXT NOT NULL,
    before_json TEXT NOT NULL DEFAULT '',
    after_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_audit_log_org ON audit_log(org_id, id);
  `,
  /* VAGUE 3 · RH : soldes de congés, jours fériés, dossier du personnel, contrats, pointage, recrutement, évaluations, formations */ `
  ALTER TABLE employees ADD COLUMN cni_no TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN birth_date TEXT;
  ALTER TABLE employees ADD COLUMN address TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN emergency_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN emergency_phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN diplomas TEXT NOT NULL DEFAULT '';
  CREATE TABLE hr_holidays (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    UNIQUE (org_id, date)
  );
  CREATE TABLE leave_adjustments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    year TEXT NOT NULL,
    days DOUBLE PRECISION NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE hr_contracts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'cdi',
    start_date TEXT,
    end_date TEXT,
    trial_end TEXT,
    medical_due TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE hr_attendance (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'present',
    minutes_late BIGINT NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    UNIQUE (employee_id, day)
  );
  CREATE TABLE hr_jobs (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    position_id BIGINT REFERENCES positions(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  );
  CREATE TABLE hr_candidates (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    job_id BIGINT NOT NULL REFERENCES hr_jobs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT 'new',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE hr_reviews (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    score BIGINT NOT NULL DEFAULT 3,
    strengths TEXT NOT NULL DEFAULT '',
    goals TEXT NOT NULL DEFAULT '',
    reviewer_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE hr_trainings (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'training',
    done_at TEXT,
    expires_at TEXT,
    provider TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  `,
  /* VAGUE 3 · décisions à circuit, projets, juridique, procédures */ `
  ALTER TABLE decisions ADD COLUMN link_kind TEXT NOT NULL DEFAULT '';
  ALTER TABLE decisions ADD COLUMN link_id BIGINT;
  ALTER TABLE decisions ADD COLUMN reminded_at TEXT;
  CREATE TABLE decision_rules (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    min_amount BIGINT NOT NULL,
    role TEXT NOT NULL,
    UNIQUE (org_id, min_amount, role)
  );
  CREATE TABLE decision_steps (
    id BIGSERIAL PRIMARY KEY,
    decision_id BIGINT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL,
    step_no BIGINT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by BIGINT,
    decided_at TEXT,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_decision_steps ON decision_steps(decision_id, step_no);
  CREATE TABLE decision_delegations (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    from_user BIGINT NOT NULL,
    to_user BIGINT NOT NULL,
    until_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  ALTER TABLE projects ADD COLUMN budget BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN estimate_hours DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN depends_on BIGINT;
  ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT '';
  ALTER TABLE tasks ADD COLUMN recur_next TEXT;
  CREATE TABLE time_entries (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    task_id BIGINT,
    project_id BIGINT,
    user_id BIGINT NOT NULL,
    day TEXT NOT NULL,
    hours DOUBLE PRECISION NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_time_entries ON time_entries(org_id, project_id);
  CREATE TABLE project_costs (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    amount BIGINT NOT NULL,
    date TEXT NOT NULL,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE project_milestones (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    due TEXT,
    done BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE task_comments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE legal_registers (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT,
    ref TEXT NOT NULL DEFAULT '',
    holder TEXT NOT NULL DEFAULT '',
    shares BIGINT NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE legal_compliance (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    recurrence TEXT NOT NULL DEFAULT 'once',
    status TEXT NOT NULL DEFAULT 'todo',
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    verify BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  ALTER TABLE processes ADD COLUMN owner_id BIGINT;
  ALTER TABLE processes ADD COLUMN version BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE processes ADD COLUMN review_months BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE processes ADD COLUMN next_review TEXT;
  CREATE TABLE process_versions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    process_id BIGINT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
    version BIGINT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    edited_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE process_reads (
    process_id BIGINT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    version BIGINT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (process_id, user_id, version)
  );
  `,
  /* VAGUE 3 · service client (SLA, satisfaction, base de connaissances, lien client), marketing (consentement, segments, envois groupés, codes promo) */ `
  ALTER TABLE tickets ADD COLUMN customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL;
  ALTER TABLE tickets ADD COLUMN ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE tickets ADD COLUMN first_due_at TEXT;
  ALTER TABLE tickets ADD COLUMN due_at TEXT;
  ALTER TABLE tickets ADD COLUMN first_response_at TEXT;
  ALTER TABLE tickets ADD COLUMN resolved_at TEXT;
  ALTER TABLE tickets ADD COLUMN csat BIGINT;
  ALTER TABLE tickets ADD COLUMN csat_comment TEXT NOT NULL DEFAULT '';
  ALTER TABLE tickets ADD COLUMN csat_token TEXT NOT NULL DEFAULT '';
  ALTER TABLE tickets ADD COLUMN csat_at TEXT;
  ALTER TABLE ticket_messages ADD COLUMN sent_via TEXT NOT NULL DEFAULT '';
  ALTER TABLE ticket_messages ADD COLUMN send_status TEXT NOT NULL DEFAULT '';
  ALTER TABLE ticket_messages ADD COLUMN send_error TEXT NOT NULL DEFAULT '';
  CREATE TABLE kb_articles (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    published BIGINT NOT NULL DEFAULT 1,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE customers ADD COLUMN marketing_consent BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE customers ADD COLUMN consent_at TEXT;
  ALTER TABLE customers ADD COLUMN consent_source TEXT NOT NULL DEFAULT '';
  CREATE TABLE marketing_segments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filter TEXT NOT NULL DEFAULT '{}',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE broadcasts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    channel TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    filter TEXT NOT NULL DEFAULT '{}',
    template_id BIGINT,
    total BIGINT NOT NULL DEFAULT 0,
    sent BIGINT NOT NULL DEFAULT 0,
    skipped BIGINT NOT NULL DEFAULT 0,
    failed BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE broadcast_sends (
    id BIGSERIAL PRIMARY KEY,
    broadcast_id BIGINT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL,
    customer_id BIGINT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE promo_codes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'percent',
    value BIGINT NOT NULL,
    starts TEXT,
    ends TEXT,
    max_uses BIGINT NOT NULL DEFAULT 0,
    used BIGINT NOT NULL DEFAULT 0,
    active BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, code)
  );
  ALTER TABLE documents ADD COLUMN promo_code TEXT NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN discount BIGINT NOT NULL DEFAULT 0;
  `,
  /* VAGUE 3 · agents planifiés et actions confirmées, historique de livraison des webhooks */ `
  CREATE TABLE agent_schedules (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    enabled BIGINT NOT NULL DEFAULT 0,
    weekday BIGINT NOT NULL DEFAULT 1,
    hour BIGINT NOT NULL DEFAULT 8,
    agent_key TEXT NOT NULL DEFAULT 'direction',
    last_run TEXT,
    last_status TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE agent_actions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    ref_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE webhook_deliveries (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    hook_id BIGINT NOT NULL,
    event TEXT NOT NULL,
    ok BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '',
    attempts BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_webhook_deliveries ON webhook_deliveries(org_id, id);
  `,
  /* Résumé du matin et alertes : canal de réception par abonné (e-mail par défaut, WhatsApp facultatif) + adresse e-mail dédiée.
     Les abonnements existants passent sur « e-mail » (le défaut de la colonne s'applique à toutes les lignes) sans perdre numéro, horaires ni consentement. */ `
  ALTER TABLE digest_subs ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';
  ALTER TABLE digest_subs ADD COLUMN email TEXT NOT NULL DEFAULT '';
  UPDATE digest_subs SET channel = 'email';
  `,
  /* VAGUE 4 · Négociation des prix (plancher, remise maximale, paliers, prix par client, règles de l'assistant, journal) et centre de relances
     (réglages, modèles, file, journal, opposition des clients). Les articles existants restent « non négociables » (plancher 0). */ `
  UPDATE digest_subs SET channel = 'email' WHERE channel <> 'email';
  ALTER TABLE catalog ADD COLUMN floor_price BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE catalog ADD COLUMN max_discount DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE catalog ADD COLUMN tiers TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE customers ADD COLUMN default_discount DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE customers ADD COLUMN followup_optout BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE customers ADD COLUMN followup_optout_at TEXT;
  ALTER TABLE documents ADD COLUMN negotiated BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE documents ADD COLUMN discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE documents ADD COLUMN approval TEXT NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN decision_id BIGINT;
  CREATE TABLE customer_prices (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES catalog(id) ON DELETE CASCADE,
    price BIGINT NOT NULL,
    valid_until TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (customer_id, item_id)
  );
  CREATE TABLE neg_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    enabled BIGINT NOT NULL DEFAULT 0,
    max_counters BIGINT NOT NULL DEFAULT 3,
    approval_pct DOUBLE PRECISION NOT NULL DEFAULT 10,
    handoff_message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE neg_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    chat_id BIGINT,
    doc_id BIGINT,
    item_id BIGINT,
    item_label TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    price BIGINT,
    quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
    discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    user_id BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_neg_log_chat ON neg_log(org_id, chat_id);
  CREATE INDEX idx_neg_log_doc ON neg_log(org_id, doc_id);
  CREATE TABLE fu_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'propose',
    channel TEXT NOT NULL DEFAULT 'email',
    cad_prospect TEXT NOT NULL DEFAULT '2,7',
    cad_quote TEXT NOT NULL DEFAULT '3,10',
    cad_invoice TEXT NOT NULL DEFAULT '3,10,20',
    cad_order TEXT NOT NULL DEFAULT '1,3',
    cad_unpaid TEXT NOT NULL DEFAULT '7,15',
    max_per_item BIGINT NOT NULL DEFAULT 3,
    day_quota BIGINT NOT NULL DEFAULT 30,
    hour_from BIGINT NOT NULL DEFAULT 8,
    hour_to BIGINT NOT NULL DEFAULT 18,
    tz_offset BIGINT NOT NULL DEFAULT 60,
    notified_on TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE fu_templates (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, kind)
  );
  CREATE TABLE fu_items (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref_id BIGINT NOT NULL,
    step BIGINT NOT NULL DEFAULT 1,
    customer_id BIGINT,
    state TEXT NOT NULL DEFAULT 'to_send',
    channel TEXT NOT NULL DEFAULT '',
    postponed_until TEXT,
    attempts BIGINT NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    stop_reason TEXT NOT NULL DEFAULT '',
    handled_by BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, kind, ref_id, step)
  );
  CREATE INDEX idx_fu_items_org ON fu_items(org_id, state);
  CREATE TABLE fu_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    item_id BIGINT,
    kind TEXT NOT NULL,
    ref_id BIGINT,
    step BIGINT NOT NULL DEFAULT 1,
    customer_id BIGINT,
    user_id BIGINT,
    channel TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_fu_log_org ON fu_log(org_id, id);
  CREATE TABLE relay_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    enabled BIGINT NOT NULL DEFAULT 1,
    max_per_hour BIGINT NOT NULL DEFAULT 6,
    quiet_from BIGINT NOT NULL DEFAULT -1,
    quiet_to BIGINT NOT NULL DEFAULT -1,
    tz_offset BIGINT NOT NULL DEFAULT 60,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE relay_contacts (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    phone TEXT NOT NULL,
    priority BIGINT NOT NULL,
    UNIQUE (org_id, priority)
  );
  CREATE TABLE relay_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    chat_id BIGINT,
    dedupe_key TEXT NOT NULL,
    contact_user BIGINT,
    channel TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (org_id, dedupe_key)
  );
  CREATE INDEX idx_relay_log_org ON relay_log(org_id, id);
  `,
  // Critères de passation à un humain selon le type d'entreprise : marchandises (commande), services, établissement (prospect). 'auto' = déduit du secteur et du catalogue.
  `
  ALTER TABLE orgs ADD COLUMN handoff_kind TEXT NOT NULL DEFAULT 'auto';
  `,
];


db.ready = db.migrate(MIGRATIONS);


// ---------- Aides ----------
const nowISO = () => new Date().toISOString();

/** Convertit une ligne users en objet "user" public (jamais de hash). */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    contact: row.contact,
    plan: row.plan,
    planExpires: row.plan_expires || null,
    interests: parseJSON(row.interests, []),
    progress: parseJSON(row.progress, {}),
    project: parseJSON(row.project, {}),
    created: row.created_at,
  };
}

/** Récupère un utilisateur et le repasse à "Gratuit" si son offre a expiré. */
async function getUserFresh(id) {
  let row = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (row && row.plan !== 'Gratuit' && row.plan_expires && new Date(row.plan_expires).getTime() <= Date.now()) {
    await db.prepare("UPDATE users SET plan = 'Gratuit', plan_expires = NULL WHERE id = ?").run(id);
    row = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  return row;
}

module.exports = { db, nowISO, publicUser, getUserFresh, MIGRATIONS };
