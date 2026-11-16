# Plan de continuité et de sauvegarde

*Version 2026-11-16. Ce plan distingue ce qui **existe dans le code** de ce qui **doit être mis en place ou confirmé** chez les fournisseurs. Aucune sauvegarde planifiée n'est configurée dans le dépôt.*

## 1. Architecture et points de défaillance
Site (Vercel) → serveur (Render) → base PostgreSQL (Neon). Le serveur ne garde aucune donnée sur disque : il peut être remplacé à tout moment. La **base de données** est le seul élément à protéger durablement. Dépendances externes : Meta/WhatsApp, fournisseur d'IA, prestataire de paiement, e-mail.

## 2. Objectifs (à valider par la direction)
Perte de données maximale acceptable (RPO) : [À COMPLÉTER : ex. 24 h] · Durée maximale d'interruption (RTO) : [À COMPLÉTER : ex. 4 h].

## 3. Sauvegardes
| Moyen | État | Détail |
|---|---|---|
| Restauration à un instant précis et branches de la base (Neon) | **À confirmer** sur le tableau de bord Neon | Fenêtre de conservation selon l'offre Neon : [À COMPLÉTER] |
| Script `npm run backup` | **Existe, non planifié** | Copie logique de toutes les tables, **chiffrée** (AES-256-GCM, `BACKUP_KEY` ou `DATA_KEY`), dans `BACKUP_DIR`, 14 copies conservées. Le disque de Render est éphémère : **copier le fichier hors de Render** |
| Déchiffrement | `BACKUP_KEY=… node scripts/backup-decrypt.js fichier.json.gz.enc > sauvegarde.json` | Testé automatiquement (aller-retour, mauvaise clé refusée) |
| `pg_dump` de l'adresse directe Neon | Manuel, recommandé en complément | `pg_dump "$DATABASE_URL_UNPOOLED" -Fc -f sauvegarde.dump` |

**À mettre en place :** une tâche planifiée quotidienne (Render Cron Job ou GitHub Actions) qui lance la sauvegarde et la dépose dans un stockage chiffré hors de Render, avec alerte en cas d'échec ; conserver la clé `BACKUP_KEY` **séparément** (gestionnaire de secrets) : sans elle, la sauvegarde est illisible.

## 4. Clés et secrets
`JWT_SECRET`, `DATA_KEY`, `ADMIN_PASSWORD`, `BACKUP_KEY` : stockés dans le gestionnaire de variables de Render **et** dans une copie sécurisée hors ligne. Perdre `DATA_KEY` rend illisibles les secrets chiffrés (jetons WhatsApp, 2FA, identifiants sociaux) : les utilisateurs devraient reconfigurer leurs liaisons et leur 2FA. Rotation : `DATA_KEY_PREVIOUS` + `npm run security:rotate-keys`.

## 5. Scénarios et réponses
| Scénario | Réponse |
|---|---|
| Panne du serveur Render | Redéployer (le blueprint `render.yaml` recrée le service) ; la base est intacte |
| Base corrompue ou suppression accidentelle | Restauration Neon à un instant précis, sinon dernière sauvegarde chiffrée |
| Fuite de secret | Rotation des secrets, révocation des sessions, procédure du document 08 |
| Indisponibilité WhatsApp/Meta, IA ou paiement | Le service reste utilisable ; les messages en attente sont repris ; le paiement manuel reste disponible |
| Indisponibilité de l'hébergeur | Redéploiement chez un autre fournisseur à partir du dépôt et de la dernière sauvegarde [À COMPLÉTER : procédure testée] |

## 6. Tests
Un **test de restauration** complet (sauvegarde → base vierge → démarrage → connexion) au moins deux fois par an, consigné [À COMPLÉTER : date du premier test]. Tant qu'il n'a pas été réalisé, on ne peut pas garantir qu'une sauvegarde est exploitable.

## 7. Communication
En cas d'interruption longue : message sur le site et par e-mail aux organisations, point de situation toutes les [À COMPLÉTER : 2] heures.
