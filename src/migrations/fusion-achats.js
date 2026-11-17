'use strict';
// Migrations de la fusion des lignes A et B — module : achats.
// Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (voir le bas de ce fichier), dans l'ordre achats → bibliothèque → entrepôt.
// Règles : jamais de renommage ni de suppression ; ALTER TABLE ... ADD COLUMN IF NOT EXISTS ; CREATE TABLE IF NOT EXISTS ;
// chaque migration doit pouvoir être rejouée sur une base déjà migrée.
//
// Le schéma pur_* de la ligne A est conservé tel quel. On y AJOUTE les colonnes dont la ligne B avait besoin :
//  - demandes et bons : projet et antenne, rôle d'approbation requis, date de soumission ;
//  - bons et factures : totaux enregistrés (HT, TVA, TTC), nom du fournisseur au moment de la commande ;
//  - factures : numéro de tentative de validation (identifiant d'écriture = facture × 100 + tentative) et dette fournisseur liée (supplier_bills) ;
//  - appels d'offres : demande d'origine et date de clôture ; évaluations : bon de commande concerné.
module.exports = [
  `
  ALTER TABLE pur_requests ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
  ALTER TABLE pur_requests ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL;
  ALTER TABLE pur_requests ADD COLUMN IF NOT EXISTS required_role TEXT NOT NULL DEFAULT 'manager';
  ALTER TABLE pur_requests ADD COLUMN IF NOT EXISTS submitted_at TEXT;
  ALTER TABLE pur_orders ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
  ALTER TABLE pur_orders ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL;
  ALTER TABLE pur_orders ADD COLUMN IF NOT EXISTS supplier_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE pur_orders ADD COLUMN IF NOT EXISTS required_role TEXT NOT NULL DEFAULT 'manager';
  ALTER TABLE pur_orders ADD COLUMN IF NOT EXISTS total_ht BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE pur_orders ADD COLUMN IF NOT EXISTS vat_amount BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE pur_orders ADD COLUMN IF NOT EXISTS total_ttc BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE pur_invoices ADD COLUMN IF NOT EXISTS supplier_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE pur_invoices ADD COLUMN IF NOT EXISTS attempts BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE pur_invoices ADD COLUMN IF NOT EXISTS bill_id BIGINT REFERENCES supplier_bills(id) ON DELETE SET NULL;
  ALTER TABLE pur_invoices ADD COLUMN IF NOT EXISTS total_ht BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE pur_invoices ADD COLUMN IF NOT EXISTS vat_amount BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE pur_invoices ADD COLUMN IF NOT EXISTS total_ttc BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE pur_rfqs ADD COLUMN IF NOT EXISTS request_id BIGINT REFERENCES pur_requests(id) ON DELETE SET NULL;
  ALTER TABLE pur_rfqs ADD COLUMN IF NOT EXISTS closed_at TEXT;
  ALTER TABLE pur_evaluations ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES pur_orders(id) ON DELETE SET NULL;
  `,
  // Reprise des données existantes : totaux et noms de fournisseurs (même calcul que le code : arrondi par ligne, TVA arrondie sur le HT).
  `
  UPDATE pur_orders SET total_ht = COALESCE((SELECT SUM(ROUND((quantity * unit_price)::numeric)) FROM pur_order_lines WHERE order_id = pur_orders.id), 0)::bigint;
  UPDATE pur_orders SET vat_amount = ROUND((total_ht * vat_rate / 100)::numeric)::bigint, total_ttc = total_ht + ROUND((total_ht * vat_rate / 100)::numeric)::bigint;
  UPDATE pur_orders SET supplier_name = COALESCE((SELECT name FROM suppliers WHERE suppliers.id = pur_orders.supplier_id), '') WHERE supplier_name = '';
  UPDATE pur_invoices SET total_ht = COALESCE((SELECT SUM(ROUND((quantity * unit_price)::numeric)) FROM pur_invoice_lines WHERE invoice_id = pur_invoices.id), 0)::bigint;
  UPDATE pur_invoices SET vat_amount = ROUND((total_ht * vat_rate / 100)::numeric)::bigint, total_ttc = total_ht + ROUND((total_ht * vat_rate / 100)::numeric)::bigint;
  UPDATE pur_invoices SET supplier_name = COALESCE((SELECT name FROM suppliers WHERE suppliers.id = pur_invoices.supplier_id), '') WHERE supplier_name = '';
  UPDATE pur_requests SET submitted_at = updated_at WHERE submitted_at IS NULL AND status <> 'draft';
  UPDATE pur_rfqs SET closed_at = awarded_at WHERE closed_at IS NULL AND awarded_at IS NOT NULL;
  `,
];
