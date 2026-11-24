# Information Security Policy

*Version 2026-11-16. This document describes what MABAH implements and verifies through automated tests; it does not constitute a certification. An independent penetration test remains to be carried out.*

## 1. Principles
Least privilege; defence in depth; security by default; verifiable logging; transparency (incidents notified); continuous improvement.

## 2. Governance
Security officer: [TO COMPLETE]. Review of this policy at least once a year and after any major incident. Every developer reads and applies section 5.

## 3. Access control
- **Users**: hashed passwords (bcrypt, cost 12); in production, minimum 10 characters and rejection of common words, keyboard sequences and "word + digits"; progressive lockout (15 min up to 24 h); server-side, revocable sessions, list of devices, login alert on an unknown device.
- **Two-factor authentication** (TOTP + backup codes) offered to everyone, recommended for owners and administrators, mandatory on request by an organisation.
- **Organisations**: a user sees only the organisations of which they are a member; hierarchical roles (member, manager, administrator, owner); filter by branch. Tested automatically on all routes (404 refusal for any outsider).
- **Administration**: single account, 12 h session, rate limiter, 2FA recommended [TO COMPLETE: make mandatory].
- Accounts are suspended or deleted without delay when a person leaves.

## 4. Cryptography and secrets
HTTPS everywhere; encrypted database connection; integration secrets (WhatsApp/Meta tokens, TOTP secrets, webhook secrets) and employees' social identifiers encrypted in the database (AES-256-GCM); `DATA_KEY` key distinct from `JWT_SECRET`, rotation possible without loss (`DATA_KEY_PREVIOUS`); encrypted backups; no secret in the repository or in the logs (tokens present in addresses are masked); startup refused in production with a weak configuration.

## 5. Secure development
Prepared SQL queries; strict input validation; neutralised CSV exports; verification of the actual content of files; outgoing calls only to public addresses over HTTPS; dependencies monitored (`npm audit`); code review; security tests run at each `npm test` (routes, isolation, authentication, data, privacy, hostile inputs).

## 6. Artificial intelligence
One organisation's data never mixed with another's; context limited by role and branch; third-party text treated as data (tags neutralised); prices and amounts taken from the databases, never invented by the AI; sensitive actions validated by a person; cost ceilings (global, site, per organisation); monthly quotas.

## 7. Logging and detection
Chained and anchored audit log (verifiable at the administrator's request); abuse points per address and automatic blocking; alerts to the administrator for serious events; register of access to payroll and HR data viewable by the organisation's administrators; request number propagated.

## 8. Operations
Stateless server (data in the database); container run as a non-privileged user; security headers (HSTS, nosniff, content policy, no-store on the API); configuration checked by `npm run security:check`.

## 9. Incident management and continuity
See documents 08 (breaches) and 10 (continuity and backup).

## 10. Providers
Selection based on security and location criteria; list in document 07; annual review.

## 11. Awareness
Persons with access to the data or to administration are trained on phishing, password management and the incident procedure [TO COMPLETE: frequency].

## 12. Known limitations
See `docs/securite/AUDIT.md` (open findings): business fields not individually encrypted, 2FA not mandatory, session inactivity expiry, possible replay of signed webhooks, retention period of the audit log to be defined.
