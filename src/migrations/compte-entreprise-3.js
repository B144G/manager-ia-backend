'use strict';
// Compte d'entreprise, étape 3 : moteur de profils de rôle. Migrations 420 et 421 (413 à 419 réservées). Append-only, additives.
//  420 : profils modifiés par l'entreprise (un profil de base est fourni par le serveur ; la ligne ne contient que la version modifiée de CETTE organisation) ;
//  421 : profil choisi pour un poste (sans valeur : le profil de base du poste, déduit de son modèle).
module.exports = [
  `
  CREATE TABLE IF NOT EXISTS ent_profiles (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    config TEXT NOT NULL,
    updated_by BIGINT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, key)
  );
  `,
  `
  ALTER TABLE ent_posts ADD COLUMN IF NOT EXISTS profile_key TEXT;
  `,
];
