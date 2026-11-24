# Record of Processing Activities

*Version 2026-11-16 — record kept by MABAH as **data controller** (part A) and as **processor** on behalf of its customers (part B).*

Controller: [TO COMPLETE: name, address] · Data protection contact: [TO COMPLETE].

## A. Processing for which MABAH is the controller

| No. | Processing | Purpose | Data subjects | Data | Basis | Recipients | Transfers | Retention | Security |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Account management | Create, authenticate, manage accounts and subscriptions | Users | Name, contact details, hashed password, plan, interests | Contract | Host, database, e-mail | See doc 07 | Life of the account; anonymisation on request (14 d) | bcrypt hashing, revocable sessions, 2FA, lockout |
| A2 | Payments | Collect, prove, invoice | Paying users | Reference, operator, Mobile Money telephone, amount, transaction identifier | Contract; legal obligation | Payment provider | Cameroon | ≥ 10 years, without identity after deletion | Webhook not trusted: status re-read from the provider |
| A3 | Security and audit log | Detect abuse, prove the integrity of records | Users, visitors | IP, browser, actions, known devices | Legitimate interest | Host | See doc 07 | Closed sessions 30 d; security log 180 d; audit: [TO COMPLETE] | Hash chain and signed anchors |
| A4 | Consents and rights | Prove consents, handle requests | Users | Type, version, date, IP, requests | Legal obligation | — | — | Life of the account | Restricted access |
| A5 | Website assistant | Answer visitors | Visitors | Messages | Legitimate interest | AI provider | See doc 07 | 90 d | Cost ceilings, no organisation data |
| A6 | Contact and trials | Answer requests | Prospects | Name, contact details, message | Pre-contractual measures | E-mail | See doc 07 | 3 years | — |
| A7 | Audience measurement | Visit statistics | Visitors (if consent) | Page, origin, device — no IP or identifier | Consent | — | — | 13 months | Aggregation |

## B. Processing on behalf of organisations (MABAH = processor)

The organisation (controller) decides the purposes; MABAH provides the tool. Categories of data and data subjects:

| No. | Module | Data subjects | Data (examples) | Sensitivity | Specific protection |
|---|---|---|---|---|---|
| B1 | Customers and sales | Customers, prospects | Name, telephone, e-mail, NIU, address, history, WhatsApp/Messenger/Instagram conversations | Medium | Isolation by organisation, filter by branch |
| B2 | Human resources | Employees, candidates | Identity, position, national ID card (CNI), date of birth, emergency contact, contracts, evaluations | **High** | Administrator access, **encryption of identifiers (CNPS, NIU, CNI, account, emergency telephone)**, access register |
| B3 | Payroll | Employees | Salary, deductions, CNPS, NIU, payment account | **High** | Same + register of consultations and exports |
| B4 | Accounting, invoicing, purchasing | Customers, suppliers | Documents, entries, contact details | Medium | Accounting audit trail, period locking |
| B5 | Organisation's AI assistant | Organisation's users | Questions, summarised context of the organisation (limited by role) | Medium | Quota, human validation of actions |
| B6 | Messaging channels | Organisation's customers | Messages, media, numbers | Medium | Encrypted tokens, media purged after 90 days |

Retention periods: set by the organisation (AI history 365 d by default, adjustable from 30 d to 10 years; webhook log 90 d; activity feed 730 d; AI agents log 365 d). End of contract: complete deletion of the organisation at the request of its owner.

## C. Common technical and organisational measures

See document 09 (security policy). Record updated with each new processing activity or change of processor.
