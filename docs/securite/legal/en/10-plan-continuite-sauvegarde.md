# Continuity and Backup Plan

*Version 2026-11-16. This plan distinguishes what **exists in the code** from what **must be put in place or confirmed** with providers. No scheduled backup is configured in the repository.*

## 1. Architecture and points of failure
Site (Vercel) → server (Render) → PostgreSQL database (Neon). The server keeps no data on disk: it can be replaced at any time. The **database** is the only element to be protected in the long term. External dependencies: Meta/WhatsApp, AI provider, payment provider, e-mail.

## 2. Objectives (to be validated by management)
Maximum acceptable data loss (RPO): [TO COMPLETE: e.g. 24 h] · Maximum interruption time (RTO): [TO COMPLETE: e.g. 4 h].

## 3. Backups
| Means | Status | Detail |
|---|---|---|
| Point-in-time restore and database branches (Neon) | **To be confirmed** on the Neon dashboard | Retention window according to the Neon plan: [TO COMPLETE] |
| `npm run backup` script | **Exists, not scheduled** | Logical copy of all tables, **encrypted** (AES-256-GCM, `BACKUP_KEY` or `DATA_KEY`), in `BACKUP_DIR`, 14 copies kept. Render's disk is ephemeral: **copy the file outside Render** |
| Decryption | `BACKUP_KEY=… node scripts/backup-decrypt.js fichier.json.gz.enc > sauvegarde.json` | Tested automatically (round trip, wrong key refused) |
| `pg_dump` of the direct Neon address | Manual, recommended as a complement | `pg_dump "$DATABASE_URL_UNPOOLED" -Fc -f sauvegarde.dump` |

**To be put in place:** a daily scheduled task (Render Cron Job or GitHub Actions) that runs the backup and deposits it in encrypted storage outside Render, with an alert in case of failure; keep the `BACKUP_KEY` key **separately** (secrets manager): without it, the backup is unreadable.

## 4. Keys and secrets
`JWT_SECRET`, `DATA_KEY`, `ADMIN_PASSWORD`, `BACKUP_KEY`: stored in Render's variable manager **and** in a secure offline copy. Losing `DATA_KEY` makes the encrypted secrets unreadable (WhatsApp tokens, 2FA, social identifiers): users would have to reconfigure their links and their 2FA. Rotation: `DATA_KEY_PREVIOUS` + `npm run security:rotate-keys`.

## 5. Scenarios and responses
| Scenario | Response |
|---|---|
| Render server failure | Redeploy (the `render.yaml` blueprint recreates the service); the database is intact |
| Corrupted database or accidental deletion | Neon point-in-time restore, otherwise the latest encrypted backup |
| Secret leak | Rotation of secrets, revocation of sessions, procedure in document 08 |
| WhatsApp/Meta, AI or payment unavailability | The service remains usable; pending messages are resumed; manual payment remains available |
| Host unavailability | Redeployment with another provider from the repository and the latest backup [TO COMPLETE: tested procedure] |

## 6. Tests
A full **restore test** (backup → blank database → startup → login) at least twice a year, recorded [TO COMPLETE: date of the first test]. Until it has been carried out, it cannot be guaranteed that a backup is usable.

## 7. Communication
In the event of a long interruption: message on the site and by e-mail to the organisations, status update every [TO COMPLETE: 2] hours.
