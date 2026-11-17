# Déploiement du serveur fusionné — risques et variables

## Variables d'environnement (Render)
| Variable | Rôle | Obligatoire ? |
|---|---|---|
| `STRICT_PROD_CONFIG=1` | Refuse de démarrer si JWT_SECRET < 32, ADMIN_PASSWORD < 12 ou ALLOWED_ORIGINS en `*`/http ; exige BACKUP_KEY pour sauvegarder | Non. Sans elle : simple AVERTISSEMENT très visible dans les journaux. À activer une fois la configuration corrigée. |
| `DATA_KEY` | Clé de chiffrement des champs sensibles (CNPS, NIU, CNI, comptes de paie, secrets). Absente : dérivée de JWT_SECRET comme avant | Recommandée. **Ne jamais la perdre ni la changer sans `DATA_KEY_PREVIOUS` + `npm run security:rotate-keys`.** |
| `BACKUP_KEY` | Chiffre les sauvegardes (`scripts/backup.js`) ; déchiffrement `scripts/backup-decrypt.js` | Non (sans elle : copie en clair + avertissement) |
| `SKIP_STARTUP_ENCRYPTION=1` | Coupe le chiffrement automatique, au démarrage, des anciennes lignes en clair | Non. Utile pour garder la possibilité de revenir à l'ancien code (voir ci-dessous). |
| `SECURITY_REWRAP=1` | Rechiffre avec la clé actuelle (rotation) | Non |
| `ALERT_LIBRARY_FAILS`, `ALERT_LIBRARY_WINDOW_MIN` | Seuils de l'alerte « mots de passe de la bibliothèque ratés » | Non (5 / 60) |

## Migrations (ajoutées uniquement en fin de MIGRATIONS ; rejouables)
1. Sécurité (dans `src/db.js`) : `login_fails.lock_level`, `login_devices`, `consents`, `data_requests`, `users.erase_after/anonymized_at`, `ai_budget`, `audit_checkpoints`, `orgs.require_2fa`, `retention_rules`.
2. `src/migrations/fusion-achats.js`, `fusion-bibliotheque.js`, `fusion-entrepot.js` (colonnes `ADD COLUMN IF NOT EXISTS`, tables `IF NOT EXISTS`, reprise des lignes existantes ; `org_id` ajouté à `lib_role_perms`/`lib_user_perms` avec rattrapage ; six clés étrangères du WMS rendues `DEFERRABLE INITIALLY DEFERRED` pour que la suppression d'une organisation ne tombe plus en 500).
Aucune table ni colonne de la production n'est renommée ou supprimée. Durée attendue : quelques secondes sur de petits volumes ; les rattrapages (`UPDATE … SET org_id`, totaux d'Achats) sont proportionnels au nombre de lignes. Faire une sauvegarde Neon avant le déploiement (non testé sur une copie réelle de la base de production).

## Risques à connaître
- **Retour arrière** : après le démarrage, les anciennes lignes en clair sont chiffrées (`v2:`). L'ancien code (ligne A) ne sait pas les lire. Pour garder cette porte ouverte, déployer d'abord avec `SKIP_STARTUP_ENCRYPTION=1` ; les nouvelles écritures sont chiffrées dans tous les cas.
- Verrouillage progressif, alerte d'appareil inconnu, 2FA exigible : de nouveaux comportements visibles par les utilisateurs (voir CONTRATS-API.md).
- `Cache-Control: no-store` et CSP sur `/api` : le site doit vérifier l'affichage en iframe des PDF (Achats, factures) ; seule la bibliothèque autorise explicitement l'aperçu intégré.
- Entrepôt : règles plus strictes (400/409 là où A repliait en silence) listées dans `contrats/entrepot.md` ; le site de production doit en afficher les messages.
- Deux couches de prévision/réappro/états coexistent (`/stock/wms/…` de A et `/stock/wms/b/…` de B).
- Dépendances : `package-lock.json` de B repris ; `npm audit` non rejoué (hors ligne).
