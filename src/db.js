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

module.exports = { db, nowISO, publicUser, getUserFresh };
