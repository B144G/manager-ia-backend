# Data Breach Notification Procedure

*Version 2026-11-16.*

## 1. Definition
A breach is a security incident resulting in the destruction, loss, alteration, disclosure of, or unauthorised access to, personal data (database leak, compromised account, lost backup, message sent to the wrong organisation…).

## 2. Roles
| Role | Responsibility | Holder |
|---|---|---|
| Incident lead | Steers, decides, keeps the register | [TO COMPLETE] |
| Data protection contact | Assesses the risk to individuals, drafts the notifications | [TO COMPLETE] |
| Technical lead | Contains, investigates, fixes | [TO COMPLETE] |
| Management | Validates the notifications to the authority and to the public | [TO COMPLETE] |

## 3. Time limits
| Step | Target time limit |
|---|---|
| Detection → qualification (severity) | 4 business hours |
| Containment (cut access, revoke sessions and keys, close the blocked address) | Immediate |
| Information of the **customer organisations** whose data is concerned (MABAH as processor) | **At the latest 72 h** after becoming aware, as soon as possible |
| Notification to the **data protection authority** (MABAH as controller) | Within the time limit set by the applicable law [TO COMPLETE: exact time limit] and targeted at **72 h** |
| Information of the **data subjects** if high risk | Without undue delay |
| Post-incident review | 10 business days |

## 4. Steps
1. **Detect**: log alerts ("Security alert": audit chain break, administrator lockout, IP block), report from a customer or a researcher, `npm run security:check` check.
2. **Qualify**: which data, how many people, which organisation, what risk (identity, finances, payroll = high). Open an incident record (template below).
3. **Contain**: revoke sessions (`Administration → Security`), rotate secrets (`JWT_SECRET`, `DATA_KEY` via `DATA_KEY_PREVIOUS` and `npm run security:rotate-keys`), disable API keys and webhooks, block addresses, cut an organisation's WhatsApp link (`wa-disconnect`).
4. **Preserve evidence**: export the audit log, verify its chain (`POST /api/admin/security/audit/verify`), keep the server logs.
5. **Assess** then **notify** (templates below).
6. **Fix** the cause, test, document in the breach register (even without notification).
7. **Post-incident review** and update of the documents.

## 5. Incident record template
Date/time of detection · Detected by · Description · Data and categories of individuals · Number of individuals (estimated) · Organisations concerned · Probable cause · Measures taken · Assessed risk (low/medium/high) and justification · Notifications made (who, when) · Corrective actions.

## 6. Template message to a customer organisation
> **Subject: Security incident concerning your MABAH data**
> On [date] at [time], we detected [nature of the incident]. It concerns [categories of data] of [approximate number] people in your organisation. Known cause: [cause or "under analysis"]. Measures already taken: [measures]. What we recommend: [actions]. We will keep you informed at the latest on [date]. Contact: [contact person].

## 7. Template message to data subjects
> **Subject: Important information about your data**
> We found on [date] that [clear description]. The data concerned: [list]. Possible consequences: [risks]. What we have done: [measures]. What you can do: [change your password, check your accounts, be vigilant about suspicious messages]. For any question: [contact].

## 8. Template notification to the authority
Nature of the breach (categories and approximate number of individuals and records) · Contact details of the contact person · Likely consequences · Measures taken or proposed · Date of the breach and of its discovery · Reason for any delay.

## 9. Exercises
One simulation exercise per year (leak of an API key; compromised administrator account); results recorded.
