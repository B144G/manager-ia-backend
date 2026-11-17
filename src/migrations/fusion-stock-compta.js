'use strict';
// Migrations de l'échange Stock/Entrepôt ↔ Achats ↔ Comptabilité et trésorerie. Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js ; rejouables.
module.exports = [
  `
  ALTER TABLE wms_returns ADD COLUMN IF NOT EXISTS credit_entry_id BIGINT;
  ALTER TABLE wms_returns ADD COLUMN IF NOT EXISTS credit_vat BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE wms_returns ADD COLUMN IF NOT EXISTS credit_note_doc_id BIGINT;
  ALTER TABLE wms_receipt_costs ADD COLUMN IF NOT EXISTS invoice_id BIGINT;
  CREATE INDEX IF NOT EXISTS idx_wms_costs_invoice ON wms_receipt_costs(invoice_id);
  CREATE TABLE IF NOT EXISTS wms_credit_applications (
    id BIGSERIAL PRIMARY KEY,
    return_id BIGINT NOT NULL REFERENCES wms_returns(id) ON DELETE CASCADE,
    bill_id BIGINT NOT NULL REFERENCES supplier_bills(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wms_credit_app_return ON wms_credit_applications(return_id);
  `,
];
