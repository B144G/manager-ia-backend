'use strict';
// Migrations « Production avancée » (MRP, MPS, capacités, ordonnancement, lean, kanban, 5S, TOC, JIT, Six Sigma, TPM, qualité).
// Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (append-only), rejouables. Un document JSON par organisation et par technique.
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS production_docs (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_by BIGINT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, kind)
  );
  `,
  // Circuit de production : réglages Lean / TOC (prix, coût matière, frais, stocks) en JSON.
  `
  ALTER TABLE production_flows ADD COLUMN IF NOT EXISTS extra TEXT NOT NULL DEFAULT '{}';
  `,
];
