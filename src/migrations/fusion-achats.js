'use strict';
// Migrations de la fusion des lignes A et B — module : achats.
// Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (voir le bas de ce fichier), dans l'ordre achats → bibliothèque → entrepôt.
// Règles : jamais de renommage ni de suppression ; ALTER TABLE ... ADD COLUMN IF NOT EXISTS ; CREATE TABLE IF NOT EXISTS ;
// chaque migration doit pouvoir être rejouée sur une base déjà migrée.
module.exports = [
  // (une chaîne SQL par migration)
];
