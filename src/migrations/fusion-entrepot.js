'use strict';
// Migrations de la fusion des lignes A et B — module : entrepot.
// Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (voir le bas de ce fichier), dans l'ordre achats → bibliothèque → entrepôt.
// Règles : jamais de renommage ni de suppression ; ALTER TABLE ... ADD COLUMN IF NOT EXISTS ; CREATE TABLE IF NOT EXISTS ;
// chaque migration doit pouvoir être rejouée sur une base déjà migrée.
module.exports = [
  // (une chaîne SQL par migration)
  // Transferts : emplacements de départ / d'arrivée par ligne (transfert entre deux emplacements d'un même entrepôt).
  `
  ALTER TABLE wms_transfer_lines ADD COLUMN IF NOT EXISTS from_location_id BIGINT;
  ALTER TABLE wms_transfer_lines ADD COLUMN IF NOT EXISTS to_location_id BIGINT;
  `,
  // Réservations par entrepôt : une réservation peut porter l'entrepôt pour lequel le stock est mis de côté.
  `
  ALTER TABLE wms_reservations ADD COLUMN IF NOT EXISTS warehouse_id BIGINT;
  `,
  // Lots et numéros de série PAR EMPLACEMENT (les lots restent globaux : stock_lots) ; historique des mouvements par emplacement ;
  // inventaire d'un emplacement (comptage à l'aveugle) et inventaires tournants par classe ABC.
  `
  CREATE TABLE IF NOT EXISTS wms_lot_levels (
    lot_id BIGINT NOT NULL REFERENCES stock_lots(id) ON DELETE CASCADE,
    location_id BIGINT NOT NULL REFERENCES wms_locations(id) ON DELETE CASCADE,
    quantity DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (lot_id, location_id)
  );
  CREATE INDEX IF NOT EXISTS idx_wms_lot_levels_loc ON wms_lot_levels(location_id);
  ALTER TABLE stock_serials ADD COLUMN IF NOT EXISTS location_id BIGINT;
  ALTER TABLE stock_moves ADD COLUMN IF NOT EXISTS location_id BIGINT;
  ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS location_id BIGINT;
  ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS blind BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS cycle_class TEXT NOT NULL DEFAULT '';
  `,
  // Retours fournisseur liés à une commande du module Stock (purchase_orders) : limités à la quantité reçue.
  `
  ALTER TABLE wms_returns ADD COLUMN IF NOT EXISTS order_id BIGINT;
  ALTER TABLE wms_returns ADD COLUMN IF NOT EXISTS credited_at TEXT;
  `,
  // Classement ABC enregistré (planification des inventaires tournants).
  `
  CREATE TABLE IF NOT EXISTS wms_item_class (
    item_id BIGINT PRIMARY KEY REFERENCES stock_items(id) ON DELETE CASCADE,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    class TEXT NOT NULL,
    consumption BIGINT NOT NULL DEFAULT 0,
    rank BIGINT NOT NULL DEFAULT 0,
    computed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wms_item_class_org ON wms_item_class(org_id, class);
  `,
  // Paramètres de réapprovisionnement : date de dernière modification (ligne B).
  `
  ALTER TABLE wms_item_params ADD COLUMN IF NOT EXISTS updated_at TEXT;
  `,
  // Coûts d'arrivée : part de chaque coût sur chaque ligne de réception (incorporée au coût moyen ou « à passer en charge »).
  `
  CREATE TABLE IF NOT EXISTS wms_landed_alloc (
    cost_id BIGINT NOT NULL REFERENCES wms_receipt_costs(id) ON DELETE CASCADE,
    line_id BIGINT NOT NULL REFERENCES wms_receipt_lines(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL DEFAULT 0,
    expensed BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (cost_id, line_id)
  );
  `,
  // Journal des mouvements internes : valeur unitaire au moment du déplacement (états de la ligne B).
  `
  ALTER TABLE wms_moves ADD COLUMN IF NOT EXISTS unit_value DOUBLE PRECISION;
  `,
  // Suppression d'une organisation : ces clés étrangères (sans CASCADE) faisaient échouer la suppression en cascade (500) dès qu'une organisation avait des
  // transferts, listes de préparation, retours ou réceptions. Elles deviennent « différées » : la règle reste vérifiée (on ne supprime pas un article utilisé), mais à la fin de l'opération.
  `
  ALTER TABLE wms_transfer_lines DROP CONSTRAINT IF EXISTS wms_transfer_lines_item_id_fkey;
  ALTER TABLE wms_transfer_lines ADD CONSTRAINT wms_transfer_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES stock_items(id) DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE wms_pick_lines DROP CONSTRAINT IF EXISTS wms_pick_lines_item_id_fkey;
  ALTER TABLE wms_pick_lines ADD CONSTRAINT wms_pick_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES stock_items(id) DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE wms_return_lines DROP CONSTRAINT IF EXISTS wms_return_lines_item_id_fkey;
  ALTER TABLE wms_return_lines ADD CONSTRAINT wms_return_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES stock_items(id) DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE wms_receipt_lines DROP CONSTRAINT IF EXISTS wms_receipt_lines_item_id_fkey;
  ALTER TABLE wms_receipt_lines ADD CONSTRAINT wms_receipt_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES stock_items(id) DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE wms_transfers DROP CONSTRAINT IF EXISTS wms_transfers_from_warehouse_id_fkey;
  ALTER TABLE wms_transfers ADD CONSTRAINT wms_transfers_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES wms_warehouses(id) DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE wms_transfers DROP CONSTRAINT IF EXISTS wms_transfers_to_warehouse_id_fkey;
  ALTER TABLE wms_transfers ADD CONSTRAINT wms_transfers_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES wms_warehouses(id) DEFERRABLE INITIALLY DEFERRED;
  `,
  // Palettes / cartons / caisses (unités logistiques de la ligne B) et colisage des listes de préparation (poids, contenu).
  `
  CREATE TABLE IF NOT EXISTS wms_units (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'pallet',
    location_id BIGINT NOT NULL REFERENCES wms_locations(id) ON DELETE CASCADE,
    parent_id BIGINT REFERENCES wms_units(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, code)
  );
  CREATE INDEX IF NOT EXISTS idx_wms_units_loc ON wms_units(location_id);
  CREATE TABLE IF NOT EXISTS wms_unit_items (
    unit_id BIGINT NOT NULL REFERENCES wms_units(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    quantity DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (unit_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS wms_packages (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    pick_id BIGINT NOT NULL REFERENCES wms_picks(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    weight DOUBLE PRECISION NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, code)
  );
  CREATE INDEX IF NOT EXISTS idx_wms_packages_pick ON wms_packages(pick_id);
  CREATE TABLE IF NOT EXISTS wms_package_items (
    package_id BIGINT NOT NULL REFERENCES wms_packages(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    quantity DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (package_id, item_id)
  );
  `,
];
