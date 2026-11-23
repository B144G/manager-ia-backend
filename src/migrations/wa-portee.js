'use strict';
// Portée des réponses automatiques de l'assistant WhatsApp : migrations 143 et suivantes (append-only : ne jamais modifier une migration existante).
//  143 : réglage par entreprise (mode, mots-clés de campagne) et exceptions par numéro (toujours / jamais) ;
//  144 : origine du contact (publicité, organique, import, manuel) + état « hors périmètre » par conversation ;
//  145 : journal d'audit des changements du réglage.
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS wa_scope_settings (
    org_id BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'all',
    mode_meta TEXT,
    mode_qr TEXT,
    keywords TEXT NOT NULL DEFAULT '[]',
    updated_by BIGINT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wa_scope_exceptions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    phone9 TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, phone9)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS wa_contact_origin (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    phone9 TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'organic',
    is_ad INTEGER NOT NULL DEFAULT 0,
    ad_id TEXT NOT NULL DEFAULT '',
    campaign TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    first_at TEXT NOT NULL,
    ad_at TEXT,
    set_by BIGINT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, phone9)
  );
  CREATE INDEX IF NOT EXISTS wa_contact_origin_src ON wa_contact_origin (org_id, source);
  CREATE TABLE IF NOT EXISTS wa_chat_scope (
    chat_id BIGINT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    held INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wa_chat_scope_org ON wa_chat_scope (org_id, held);
  `,
  `
  CREATE TABLE IF NOT EXISTS wa_scope_log (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wa_scope_log_org ON wa_scope_log (org_id, id);
  `,
];
