'use strict';
// Migrations de la fusion des lignes A et B — module : bibliotheque.
// Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js (voir le bas de ce fichier), dans l'ordre achats → bibliothèque → entrepôt.
// Règles : jamais de renommage ni de suppression ; ALTER TABLE ... ADD COLUMN IF NOT EXISTS ; CREATE TABLE IF NOT EXISTS ;
// chaque migration doit pouvoir être rejouée sur une base déjà migrée.
module.exports = [
  // Limitation PERSISTANTE des essais de mot de passe (portée de la table lib_attempts de la ligne B) : une ligne par personne et par bloc,
  // plus une ligne « tous blocs » (block_id = 0). Le blocage (locked_until) survit au redémarrage du serveur. org_id : pour l'export et la
  // suppression complète d'une organisation (NULL pour la ligne « tous blocs », qui suit la personne et non l'organisation).
  `
  CREATE TABLE IF NOT EXISTS lib_attempts (
    user_id BIGINT NOT NULL,
    block_id BIGINT NOT NULL,
    org_id BIGINT,
    fails BIGINT NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL,
    locked_until TEXT,
    PRIMARY KEY (user_id, block_id)
  );
  CREATE INDEX IF NOT EXISTS idx_lib_attempts_org ON lib_attempts(org_id);
  `,
  // Identifiant court stable d'un bloc (slug, comme chez B) ; dernière utilisation et empreinte du mot de passe pour les autorisations.
  `
  ALTER TABLE lib_blocks ADD COLUMN IF NOT EXISTS slug TEXT NOT NULL DEFAULT '';
  UPDATE lib_blocks SET slug = CASE name
    WHEN 'Mes documents' THEN 'personnel' WHEN 'Administratif' THEN 'administratif' WHEN 'Commercial' THEN 'commercial'
    WHEN 'Projets' THEN 'projets' WHEN 'Ressources humaines' THEN 'rh' WHEN 'Comptabilité et finances' THEN 'comptabilite'
    WHEN 'Juridique' THEN 'juridique' ELSE slug END
    WHERE slug = '' AND builtin = 1;
  ALTER TABLE lib_grants ADD COLUMN IF NOT EXISTS last_used_at TEXT;
  ALTER TABLE lib_grants ADD COLUMN IF NOT EXISTS pass_stamp TEXT;
  `,
  // Droits par rôle et par personne : org_id (copie de celui du bloc) pour que l'export et la sauvegarde d'une organisation les incluent (le reste suit déjà par org_id).
  `
  ALTER TABLE lib_role_perms ADD COLUMN IF NOT EXISTS org_id BIGINT;
  ALTER TABLE lib_user_perms ADD COLUMN IF NOT EXISTS org_id BIGINT;
  UPDATE lib_role_perms SET org_id = (SELECT org_id FROM lib_blocks WHERE lib_blocks.id = lib_role_perms.block_id) WHERE org_id IS NULL;
  UPDATE lib_user_perms SET org_id = (SELECT org_id FROM lib_blocks WHERE lib_blocks.id = lib_user_perms.block_id) WHERE org_id IS NULL;
  `,
];
