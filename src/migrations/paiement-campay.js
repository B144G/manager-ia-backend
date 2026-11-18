'use strict';
// Migrations du paiement automatique Campay. Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (après les migrations de fusion).
// Règles : jamais de renommage ni de suppression ; IF NOT EXISTS partout (rejouable). La table « payments » reste la table des transactions de paiement.
module.exports = [
  `
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'XAF';
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS org_id BIGINT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS ext_ref TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '';
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_checked_at TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS check_count BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS operator_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_via TEXT NOT NULL DEFAULT '';
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS admin_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS test_mode BIGINT NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_ext_ref ON payments(ext_ref) WHERE ext_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_ref ON payments(provider_ref) WHERE provider_ref IS NOT NULL AND mode = 'push';
  UPDATE payments SET status = 'expired' WHERE mode = 'push' AND status = 'pending' AND id NOT IN (SELECT MAX(id) FROM payments WHERE mode = 'push' AND status = 'pending' GROUP BY user_id);
  -- un seul paiement automatique en attente par client à la fois : protège du double clic et des deux onglets
  CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_pending_push ON payments(user_id) WHERE mode = 'push' AND status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
  CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id BIGSERIAL PRIMARY KEY,
    sig_hash TEXT NOT NULL UNIQUE,
    received_at TEXT NOT NULL,
    campay_ref TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT 'received'
  );
  CREATE INDEX IF NOT EXISTS idx_pwe_received ON payment_webhook_events(received_at);
  `,
  // Paiement manuel de secours : nom du payeur, identifiant de transaction normalisé (anti-rejeu), nombre de soumissions, administrateur qui a décidé.
  `
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS tx_norm TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS attempts BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS decided_by TEXT NOT NULL DEFAULT '';
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS submitted_at TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_tx_norm ON payments(tx_norm) WHERE tx_norm IS NOT NULL;
  `,
];
