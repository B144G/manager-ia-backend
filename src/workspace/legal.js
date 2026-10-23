'use strict';
// Sous-application « Juridique et conformité » (responsables et plus) : contrats et échéances, obligations récurrentes, litiges, protection des données.
// Aide-mémoire d'organisation : ce n'est PAS un avis juridique.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError, oneLine } = require('../util');
const X = require('./legal-extra');

const money0 = (v) => (v === undefined || v === null || v === '' || Number(v) === 0 ? 0 : A.amount(v));
const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const TYPES = ['client', 'supplier', 'lease', 'work', 'insurance', 'partnership', 'other'];
const TYPE_LABEL = { client: 'Client', supplier: 'Fournisseur', lease: 'Bail', work: 'Travail', insurance: 'Assurance', partnership: 'Partenariat', other: 'Autre' };
const CONTRACT_STATUS = ['draft', 'active', 'terminated'];
const OB_KINDS = ['license', 'authorization', 'insurance', 'declaration', 'display', 'inspection', 'other'];
const OB_LABEL = { license: 'Licence', authorization: 'Autorisation', insurance: 'Assurance', declaration: 'Déclaration', display: 'Affichage obligatoire', inspection: 'Contrôle', other: 'Autre' };
const DISPUTE_KINDS = ['dispute', 'incident', 'claim', 'inspection'];
const DISPUTE_LABEL = { dispute: 'Litige', incident: 'Incident', claim: 'Réclamation', inspection: 'Contrôle / sanction' };
const DISPUTE_STATUS = ['open', 'in_progress', 'closed'];
const SIGN = ['none', 'to_sign', 'signed'];
const SIGN_LABEL = { none: 'Sans suivi', to_sign: 'À signer', signed: 'Signé' };
const STATUS_LABEL = { draft: 'Brouillon', active: 'En cours', terminated: 'Terminé ou résilié' };
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (d, n) => { const [y, m, day] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(day, last)); return t.toISOString().slice(0, 10); };
const daysTo = (d) => Math.round((Date.parse(d) - Date.parse(today())) / 86400000);

const one = async (req, table, id, label) => {
  const r = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`).get(A.id(id), req.org.id);
  if (!r) throw new HttpError(404, `${label} introuvable.`);
  return r;
};
const intIn = (v, min, max, msg) => { if (v === undefined || v === null || v === '') return 0; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, msg); return n; };

/** Membres de l'organisation : { userId: nom }. */
async function memberNames(orgId) {
  const rows = await db.prepare('SELECT m.user_id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? LIMIT 200').all(orgId);
  return Object.fromEntries(rows.map((r) => [Number(r.user_id), r.name]));
}

// ---------- Contrats ----------
/** Alertes d'un contrat en cours : fin dans 30/7 jours, date limite de préavis dans 30/7 jours ou dépassée, contrat expiré. */
function contractView(c, names = {}, files = {}) {
  const alerts = [];
  const end = c.end_date;
  const notice = end && Number(c.notice_days) > 0 ? addDays(end, -Number(c.notice_days)) : null;
  if (c.status === 'active' && end) {
    const dEnd = daysTo(end);
    if (dEnd < 0) alerts.push({ code: 'expired', level: 'high', text: Number(c.tacit) ? `Terminé depuis le ${end} (reconduction tacite : vérifiez si le contrat continue)` : `Expiré depuis le ${end}` });
    else {
      if (dEnd <= 7) alerts.push({ code: 'end7', level: 'high', text: `Se termine dans ${dEnd} jour(s)` });
      else if (dEnd <= 30) alerts.push({ code: 'end30', level: 'medium', text: `Se termine dans ${dEnd} jours` });
      if (notice) {
        const dN = daysTo(notice);
        if (dN < 0) alerts.push({ code: 'notice_passed', level: 'high', text: Number(c.tacit) ? `Date limite de préavis dépassée (${notice}) : le contrat peut se reconduire` : `Date limite de préavis dépassée (${notice})` });
        else if (dN <= 7) alerts.push({ code: 'notice7', level: 'high', text: `Préavis à envoyer avant le ${notice} (${dN} jour(s))` });
        else if (dN <= 30) alerts.push({ code: 'notice30', level: 'medium', text: `Préavis à envoyer avant le ${notice} (${dN} jours)` });
      }
    }
  }
  return {
    id: c.id, type: c.type, typeLabel: TYPE_LABEL[c.type], title: c.title, parties: c.parties, subject: c.subject, amount: Number(c.amount), startDate: c.start_date, endDate: end, tacit: Boolean(Number(c.tacit)),
    noticeDays: Number(c.notice_days), noticeDate: notice, status: c.status, docRef: c.doc_ref, notes: c.notes, alerts, expired: alerts.some((a) => a.code === 'expired'),
    assigneeId: c.assignee_id === null || c.assignee_id === undefined ? null : Number(c.assignee_id), assignee: names[Number(c.assignee_id)] || null,
    signStatus: c.sign_status, signLabel: SIGN_LABEL[c.sign_status], signedAt: c.signed_at, signers: c.signers, filesCount: files[Number(c.id)] || 0,
  };
}
const CCOLS = ['type', 'title', 'parties', 'subject', 'amount', 'start_date', 'end_date', 'tacit', 'notice_days', 'status', 'doc_ref', 'notes', 'assignee_id', 'sign_status', 'signed_at', 'signers'];
async function contractFields(req, b, c) {
  const start = b.startDate === undefined ? (c ? c.start_date : null) : A.date(b.startDate);
  const end = b.endDate === undefined ? (c ? c.end_date : null) : A.date(b.endDate);
  if (start && end && end < start) throw new HttpError(400, 'La date de fin est avant la date de début.');
  const sign = b.signStatus === undefined ? c.sign_status : A.oneOf(b.signStatus, SIGN, undefined, 'Statut de signature inconnu (none, to_sign ou signed).');
  let signedAt = null;
  if (sign === 'signed') {
    signedAt = b.signedAt === undefined || b.signedAt === '' ? (c.signed_at || today()) : A.date(b.signedAt);
    if (signedAt > today()) throw new HttpError(400, 'La date de signature est dans le futur.');
  }
  return {
    type: b.type === undefined ? c.type : A.oneOf(b.type, TYPES, undefined, 'Type de contrat inconnu.'), title: b.title === undefined ? c.title : A.text(b.title, 150, { required: true, msg: 'Donnez un titre au contrat.' }),
    parties: b.parties === undefined ? c.parties : A.text(b.parties, 200), subject: b.subject === undefined ? c.subject : A.text(b.subject, 400), amount: b.amount === undefined ? c.amount : money0(b.amount), start_date: start, end_date: end,
    tacit: b.tacit === undefined ? c.tacit : (b.tacit ? 1 : 0), notice_days: b.noticeDays === undefined ? c.notice_days : intIn(b.noticeDays, 0, 730, 'Préavis invalide : indiquez un nombre de jours entre 0 et 730.'),
    status: b.status === undefined ? c.status : A.oneOf(b.status, CONTRACT_STATUS, undefined, 'Statut inconnu.'), doc_ref: b.docRef === undefined ? c.doc_ref : A.text(b.docRef, 300), notes: b.notes === undefined ? c.notes : A.text(b.notes, 1000),
    assignee_id: b.assigneeId === undefined ? (c.assignee_id === undefined ? null : c.assignee_id) : await A.memberOf(req, b.assigneeId), sign_status: sign, signed_at: signedAt,
    signers: b.signers === undefined ? c.signers : A.text(b.signers, 300),
  };
}
// Historique d'un contrat : qui a changé quoi et quand (texte lisible, valeurs raccourcies).
const FIELD_LABEL = { type: 'Type', title: 'Titre', parties: 'Parties', subject: 'Objet', amount: 'Montant', start_date: 'Début', end_date: 'Fin', tacit: 'Reconduction tacite', notice_days: 'Préavis (jours)', status: 'Statut', doc_ref: 'Où est le document', notes: 'Notes', assignee_id: 'Rappels attribués à', sign_status: 'Signature', signed_at: 'Date de signature', signers: 'Signataires' };
function shown(col, v, names) {
  if (v === null || v === undefined || v === '') return '(vide)';
  if (col === 'tacit') return Number(v) ? 'Oui' : 'Non';
  if (col === 'type') return TYPE_LABEL[v] || v;
  if (col === 'status') return STATUS_LABEL[v] || v;
  if (col === 'sign_status') return SIGN_LABEL[v] || v;
  if (col === 'assignee_id') return names[Number(v)] || 'Personne retirée';
  return oneLine(v, 120);
}
async function recordHistory(req, contractId, action, before, after, names) {
  const changes = [];
  if (before) for (const col of CCOLS) {
    const a = before[col] === null || before[col] === undefined ? '' : String(before[col]);
    const b = after[col] === null || after[col] === undefined ? '' : String(after[col]);
    if (a !== b) changes.push({ field: col, label: FIELD_LABEL[col], from: shown(col, before[col], names), to: shown(col, after[col], names) });
  }
  if (before && !changes.length) return;
  const u = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
  await db.prepare('INSERT INTO legal_history (org_id, contract_id, user_id, user_name, action, changes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, contractId, req.user.id, u ? u.name : '', action, JSON.stringify(changes), nowISO());
}
const BLANK_CONTRACT = { type: 'other', title: '', parties: '', subject: '', amount: 0, start_date: null, end_date: null, tacit: 0, notice_days: 0, status: 'active', doc_ref: '', notes: '', assignee_id: null, sign_status: 'none', signed_at: null, signers: '' };

router.get('/contracts', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM legal_contracts WHERE org_id = ? ORDER BY end_date IS NULL, end_date, id DESC LIMIT 300').all(req.org.id);
  const names = await memberNames(req.org.id); const files = await X.countFiles(req.org.id, 'contract');
  res.json({ contracts: rows.map((c) => contractView(c, names, files)), types: TYPE_LABEL, members: Object.entries(names).map(([userId, name]) => ({ userId: Number(userId), name })) });
});
router.post('/contracts', async (req, res) => {
  const f = await contractFields(req, req.body || {}, BLANK_CONTRACT);
  const id = Number((await db.prepare(`INSERT INTO legal_contracts (org_id, ${CCOLS.join(', ')}, created_by, created_at) VALUES (?, ${CCOLS.map(() => '?').join(', ')}, ?, ?)`).run(req.org.id, ...CCOLS.map((k) => f[k]), req.user.id, nowISO())).lastInsertRowid);
  await recordHistory(req, id, 'Contrat créé', null, f, {});
  await A.logActivity(req.org.id, req.user.id, 'legal', `Contrat « ${f.title} » enregistré`);
  res.status(201).json({ id });
});
router.put('/contracts/:id', async (req, res) => {
  const c = await one(req, 'legal_contracts', req.params.id, 'Contrat');
  const f = await contractFields(req, req.body || {}, c);
  await db.prepare(`UPDATE legal_contracts SET ${CCOLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CCOLS.map((k) => f[k]), c.id);
  await recordHistory(req, Number(c.id), 'Contrat modifié', c, f, await memberNames(req.org.id));
  res.json({ ok: true });
});
router.get('/contracts/:id/history', async (req, res) => {
  const c = await one(req, 'legal_contracts', req.params.id, 'Contrat');
  const rows = await db.prepare('SELECT * FROM legal_history WHERE contract_id = ? AND org_id = ? ORDER BY id DESC LIMIT 200').all(c.id, req.org.id);
  res.json({ history: rows.map((h) => ({ id: h.id, action: h.action, userName: h.user_name, at: h.created_at, changes: JSON.parse(h.changes || '[]') })) });
});
router.delete('/contracts/:id', async (req, res) => {
  const c = await one(req, 'legal_contracts', req.params.id, 'Contrat');
  await X.dropFiles(req.org.id, 'contract', Number(c.id));
  await db.prepare('DELETE FROM legal_contracts WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// ---------- Obligations de conformité ----------
const obView = (o, name, files = {}) => ({
  id: o.id, kind: o.kind, kindLabel: OB_LABEL[o.kind], title: o.title, dueDate: o.due_date, recurrenceMonths: Number(o.recurrence_months), responsibleId: o.responsible_id, responsible: name || null, status: o.status,
  proof: o.proof, notes: o.notes, lastDone: o.last_done, overdue: o.status === 'pending' && Boolean(o.due_date) && o.due_date < today(), daysLeft: o.status === 'pending' && o.due_date ? daysTo(o.due_date) : null,
  docRef: o.doc_ref, filesCount: files[Number(o.id)] || 0,
});
async function obFields(req, b, o) {
  const resp = b.responsibleId === undefined ? (o ? o.responsible_id : null) : await A.memberOf(req, b.responsibleId);
  return [b.kind === undefined ? o.kind : A.oneOf(b.kind, OB_KINDS, undefined, 'Type d\'obligation inconnu.'), b.title === undefined ? o.title : A.text(b.title, 150, { required: true, msg: 'Donnez un titre à l\'obligation.' }),
    b.dueDate === undefined ? o.due_date : A.date(b.dueDate), b.recurrenceMonths === undefined ? o.recurrence_months : intIn(b.recurrenceMonths, 0, 120, 'Récurrence invalide : indiquez un nombre de mois entre 0 et 120.'),
    resp, b.status === undefined ? o.status : A.oneOf(b.status, ['pending', 'done'], undefined, 'Statut inconnu.'), b.proof === undefined ? o.proof : A.text(b.proof, 400), b.notes === undefined ? o.notes : A.text(b.notes, 800), b.docRef === undefined ? o.doc_ref : A.text(b.docRef, 300)];
}
const BLANK_OB = { kind: 'other', title: '', due_date: null, recurrence_months: 0, responsible_id: null, status: 'pending', proof: '', notes: '', doc_ref: '' };

router.get('/obligations', async (req, res) => {
  const rows = await db.prepare('SELECT o.*, u.name AS who FROM legal_obligations o LEFT JOIN users u ON u.id = o.responsible_id WHERE o.org_id = ? ORDER BY CASE o.status WHEN \'pending\' THEN 0 ELSE 1 END, o.due_date IS NULL, o.due_date, o.id LIMIT 300').all(req.org.id);
  const files = await X.countFiles(req.org.id, 'obligation');
  const members = await db.prepare('SELECT m.user_id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name LIMIT 100').all(req.org.id);
  res.json({ obligations: rows.map((o) => obView(o, o.who, files)), members: members.map((m) => ({ userId: m.user_id, name: m.name })), kinds: OB_LABEL });
});
router.post('/obligations', async (req, res) => {
  const f = await obFields(req, req.body || {}, BLANK_OB);
  if (!f[1]) throw new HttpError(400, "Donnez un titre à l'obligation.");
  const id = (await db.prepare('INSERT INTO legal_obligations (org_id, kind, title, due_date, recurrence_months, responsible_id, status, proof, notes, doc_ref, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, ...f, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/obligations/:id', async (req, res) => {
  const o = await one(req, 'legal_obligations', req.params.id, 'Obligation');
  await db.prepare('UPDATE legal_obligations SET kind = ?, title = ?, due_date = ?, recurrence_months = ?, responsible_id = ?, status = ?, proof = ?, notes = ?, doc_ref = ? WHERE id = ?').run(...await obFields(req, req.body || {}, o), o.id);
  res.json({ ok: true });
});
// « Fait » : si l'obligation se répète, l'échéance passe à la prochaine période et l'obligation reste à faire ; sinon elle est terminée.
router.post('/obligations/:id/done', async (req, res) => {
  const o = await one(req, 'legal_obligations', req.params.id, 'Obligation');
  if (o.status === 'done') throw new HttpError(400, 'Cette obligation est déjà terminée.');
  const b = req.body || {};
  const proof = b.proof === undefined ? o.proof : A.text(b.proof, 400);
  const rec = Number(o.recurrence_months);
  if (rec > 0) {
    const base = o.due_date && o.due_date > today() ? o.due_date : (o.due_date || today());
    let next = addMonths(base, rec);
    while (next <= today()) next = addMonths(next, rec);
    await db.prepare('UPDATE legal_obligations SET due_date = ?, last_done = ?, proof = ? WHERE id = ?').run(next, today(), proof, o.id);
  } else await db.prepare("UPDATE legal_obligations SET status = 'done', last_done = ?, proof = ? WHERE id = ?").run(today(), proof, o.id);
  await A.logActivity(req.org.id, req.user.id, 'legal', `Obligation « ${o.title} » marquée faite`);
  res.json({ ok: true, repeats: rec > 0 });
});
router.delete('/obligations/:id', async (req, res) => {
  const o = await one(req, 'legal_obligations', req.params.id, 'Obligation');
  await X.dropFiles(req.org.id, 'obligation', Number(o.id));
  await db.prepare('DELETE FROM legal_obligations WHERE id = ?').run(o.id);
  res.json({ ok: true });
});

// ---------- Litiges et incidents ----------
async function disputeFields(req, b, d) {
  return [b.kind === undefined ? d.kind : A.oneOf(b.kind, DISPUTE_KINDS, undefined, 'Type inconnu.'), b.title === undefined ? d.title : A.text(b.title, 150, { required: true, msg: 'Donnez un titre.' }),
    b.counterparty === undefined ? d.counterparty : A.text(b.counterparty, 150), b.openedAt === undefined ? d.opened_at : (A.date(b.openedAt) || today()), b.status === undefined ? d.status : A.oneOf(b.status, DISPUTE_STATUS, undefined, 'Statut inconnu.'),
    b.amount === undefined ? d.amount : money0(b.amount), b.description === undefined ? d.description : A.text(b.description, 1500), b.nextStep === undefined ? d.next_step : A.text(b.nextStep, 300),
    b.nextDate === undefined ? d.next_date : A.date(b.nextDate), b.outcome === undefined ? d.outcome : A.text(b.outcome, 500),
    b.assigneeId === undefined ? (d.assignee_id === undefined ? null : d.assignee_id) : await A.memberOf(req, b.assigneeId), b.docRef === undefined ? d.doc_ref : A.text(b.docRef, 300)];
}
const BLANK_DISPUTE = { kind: 'dispute', title: '', counterparty: '', opened_at: today(), status: 'open', amount: 0, description: '', next_step: '', next_date: null, outcome: '', assignee_id: null, doc_ref: '' };
router.get('/disputes', async (req, res) => {
  const rows = await db.prepare("SELECT * FROM legal_disputes WHERE org_id = ? ORDER BY CASE status WHEN 'closed' THEN 1 ELSE 0 END, next_date IS NULL, next_date, id DESC LIMIT 200").all(req.org.id);
  const names = await memberNames(req.org.id); const files = await X.countFiles(req.org.id, 'dispute');
  res.json({ members: Object.entries(names).map(([userId, name]) => ({ userId: Number(userId), name })), disputes: rows.map((d) => ({ id: d.id, kind: d.kind, kindLabel: DISPUTE_LABEL[d.kind], title: d.title, counterparty: d.counterparty, openedAt: d.opened_at, status: d.status, amount: Number(d.amount), description: d.description, nextStep: d.next_step, nextDate: d.next_date, outcome: d.outcome, assigneeId: d.assignee_id === null ? null : Number(d.assignee_id), assignee: names[Number(d.assignee_id)] || null, docRef: d.doc_ref, filesCount: files[Number(d.id)] || 0 })) });
});
router.post('/disputes', async (req, res) => {
  const f = await disputeFields(req, { ...(req.body || {}), openedAt: (req.body || {}).openedAt === undefined ? today() : (req.body || {}).openedAt }, BLANK_DISPUTE);
  if (!f[1]) throw new HttpError(400, 'Donnez un titre.');
  const id = (await db.prepare('INSERT INTO legal_disputes (org_id, kind, title, counterparty, opened_at, status, amount, description, next_step, next_date, outcome, assignee_id, doc_ref, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, ...f, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/disputes/:id', async (req, res) => {
  const d = await one(req, 'legal_disputes', req.params.id, 'Dossier');
  await db.prepare('UPDATE legal_disputes SET kind = ?, title = ?, counterparty = ?, opened_at = ?, status = ?, amount = ?, description = ?, next_step = ?, next_date = ?, outcome = ?, assignee_id = ?, doc_ref = ? WHERE id = ?').run(...await disputeFields(req, req.body || {}, d), d.id);
  res.json({ ok: true });
});
router.delete('/disputes/:id', async (req, res) => {
  const d = await one(req, 'legal_disputes', req.params.id, 'Dossier');
  await X.dropFiles(req.org.id, 'dispute', Number(d.id));
  await db.prepare('DELETE FROM legal_disputes WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

// ---------- Registre de protection des données personnelles (aide-mémoire) ----------
function privacyFields(b, p) {
  return [b.dataKind === undefined ? p.data_kind : A.text(b.dataKind, 150, { required: true, msg: 'Indiquez la donnée collectée (ex. nom et téléphone des clients).' }), b.people === undefined ? p.people : A.text(b.people, 150),
    b.storedWhere === undefined ? p.stored_where : A.text(b.storedWhere, 200), b.purpose === undefined ? p.purpose : A.text(b.purpose, 300), b.retention === undefined ? p.retention : A.text(b.retention, 150),
    b.sharedWith === undefined ? p.shared_with : A.text(b.sharedWith, 200), b.notes === undefined ? p.notes : A.text(b.notes, 500)];
}
const BLANK_PRIVACY = { data_kind: '', people: '', stored_where: '', purpose: '', retention: '', shared_with: '', notes: '' };
router.get('/privacy', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM legal_privacy WHERE org_id = ? ORDER BY id LIMIT 200').all(req.org.id);
  res.json({ items: rows.map((p) => ({ id: p.id, dataKind: p.data_kind, people: p.people, storedWhere: p.stored_where, purpose: p.purpose, retention: p.retention, sharedWith: p.shared_with, notes: p.notes })) });
});
router.post('/privacy', async (req, res) => {
  const f = privacyFields(req.body || {}, BLANK_PRIVACY);
  if (!f[0]) throw new HttpError(400, 'Indiquez la donnée collectée (ex. nom et téléphone des clients).');
  const id = (await db.prepare('INSERT INTO legal_privacy (org_id, data_kind, people, stored_where, purpose, retention, shared_with, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, ...f, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/privacy/:id', async (req, res) => {
  const p = await one(req, 'legal_privacy', req.params.id, 'Ligne du registre');
  await db.prepare('UPDATE legal_privacy SET data_kind = ?, people = ?, stored_where = ?, purpose = ?, retention = ?, shared_with = ?, notes = ? WHERE id = ?').run(...privacyFields(req.body || {}, p), p.id);
  res.json({ ok: true });
});
router.delete('/privacy/:id', async (req, res) => {
  const p = await one(req, 'legal_privacy', req.params.id, 'Ligne du registre');
  await db.prepare('DELETE FROM legal_privacy WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// ---------- Tableau de bord : échéances à venir, contrats à renouveler, obligations en retard ----------
async function summary(req) {
  const names = await memberNames(req.org.id);
  const contracts = (await db.prepare("SELECT * FROM legal_contracts WHERE org_id = ? AND status = 'active'").all(req.org.id)).map((c) => contractView(c, names));
  const obs = (await db.prepare("SELECT o.*, u.name AS who FROM legal_obligations o LEFT JOIN users u ON u.id = o.responsible_id WHERE o.org_id = ? AND o.status = 'pending'").all(req.org.id)).map((o) => obView(o, o.who));
  const steps = (await db.prepare("SELECT * FROM legal_disputes WHERE org_id = ? AND status != 'closed' AND next_date IS NOT NULL").all(req.org.id)).map((d) => ({ id: d.id, title: d.title, nextStep: d.next_step, date: d.next_date, days: daysTo(d.next_date), assignee: names[Number(d.assignee_id)] || null, assigneeId: d.assignee_id === null ? null : Number(d.assignee_id) }));
  const upcoming = [];
  for (const c of contracts) {
    if (c.endDate && !c.expired) {
      const d = daysTo(c.endDate);
      if (d <= 30) upcoming.push({ kind: 'contract_end', title: c.title, date: c.endDate, days: d, responsible: c.assignee });
    }
    if (c.noticeDate && !c.expired) {
      const d = daysTo(c.noticeDate);
      if (d >= 0 && d <= 30) upcoming.push({ kind: 'notice', title: c.title, date: c.noticeDate, days: d, responsible: c.assignee });
    }
  }
  for (const o of obs) if (o.dueDate && !o.overdue && o.daysLeft <= 30) upcoming.push({ kind: 'obligation', title: o.title, date: o.dueDate, days: o.daysLeft, responsible: o.responsible });
  for (const d of steps) if (d.days >= 0 && d.days <= 30) upcoming.push({ kind: 'dispute_step', title: d.title + (d.nextStep ? ' : ' + d.nextStep : ''), date: d.date, days: d.days, responsible: d.assignee });
  upcoming.sort((a, b) => a.days - b.days);
  const toRenew = contracts.filter((c) => c.alerts.some((a) => ['end7', 'end30', 'notice7', 'notice30', 'notice_passed'].includes(a.code)));
  const disputes = Number((await db.prepare("SELECT COUNT(*) AS c FROM legal_disputes WHERE org_id = ? AND status != 'closed'").get(req.org.id)).c);
  const toSign = (await db.prepare("SELECT id, title, signers FROM legal_contracts WHERE org_id = ? AND sign_status = 'to_sign' AND status != 'terminated' ORDER BY id").all(req.org.id)).map((c) => ({ id: c.id, title: c.title, signers: c.signers }));
  return { upcoming, toRenew: toRenew.map((c) => ({ id: c.id, title: c.title, endDate: c.endDate, noticeDate: c.noticeDate, alerts: c.alerts, assignee: c.assignee, assigneeId: c.assigneeId })), expired: contracts.filter((c) => c.expired).map((c) => ({ id: c.id, title: c.title, endDate: c.endDate, assignee: c.assignee, assigneeId: c.assigneeId })),
    overdueObligations: obs.filter((o) => o.overdue).map((o) => ({ id: o.id, title: o.title, dueDate: o.dueDate, responsible: o.responsible, responsibleId: o.responsibleId })), upcomingObligations: obs.filter((o) => o.dueDate && !o.overdue && o.daysLeft <= 30),
    lateSteps: steps.filter((d) => d.days < 0), upcomingSteps: steps.filter((d) => d.days >= 0 && d.days <= 30), openDisputes: disputes, toSign };
}
router.get('/', async (req, res) => {
  const s = await summary(req);
  res.json({ summary: { upcoming: s.upcoming.length, toRenew: s.toRenew.length, overdue: s.overdueObligations.length, expired: s.expired.length, openDisputes: s.openDisputes, toSign: s.toSign.length }, ...s });
});

router.use(X.router);

module.exports = router;

/**
 * Rappels pour le module « Alertes » : au plus UNE alerte par contrat, obligation ou dossier (jamais de doublon), calculée à chaque lecture.
 * Seuils : 30 jours (à surveiller) puis 7 jours (urgent) ; retard et préavis dépassé : urgent. Les premières sont détaillées, les autres regroupées.
 */
module.exports.alertItems = async (req) => {
  const s = await summary(req);
  const me = Number(req.user.id);
  const who = (name, id) => (name ? (id === me ? ' · attribué à vous' : ' · attribué à ' + name) : '');
  const items = [];
  const lvl = (days) => (days <= 7 ? 'high' : 'medium');
  const when = (days) => (days === 0 ? "aujourd'hui" : days === 1 ? 'demain' : `dans ${days} jours`);
  for (const c of s.expired) items.push({ level: 'high', title: 'Juridique · contrat expiré', text: `« ${oneLine(c.title, 70)} » est expiré depuis le ${c.endDate}${who(c.assignee, c.assigneeId)}`, at: c.endDate + 'T00:00:00.000Z', rank: -9999 });
  for (const c of s.toRenew) {
    const a = c.alerts[0];
    const days = c.endDate ? daysTo(c.endDate) : 0;
    items.push({ level: a.level === 'high' ? 'high' : 'medium', title: 'Juridique · contrat à renouveler', text: `« ${oneLine(c.title, 70)} » : ${a.text.charAt(0).toLowerCase()}${a.text.slice(1)}${who(c.assignee, c.assigneeId)}`, at: null, rank: Math.min(days, 0) - (a.level === 'high' ? 100 : 0) + days });
  }
  for (const o of s.overdueObligations) items.push({ level: 'high', title: 'Juridique · obligation en retard', text: `« ${oneLine(o.title, 70)} » était à faire le ${o.dueDate}${who(o.responsible, o.responsibleId)}`, at: o.dueDate + 'T00:00:00.000Z', rank: -5000 });
  for (const o of s.upcomingObligations) items.push({ level: lvl(o.daysLeft), title: 'Juridique · obligation à venir', text: `« ${oneLine(o.title, 70)} » à faire ${when(o.daysLeft)} (${o.dueDate})${who(o.responsible, o.responsibleId)}`, at: null, rank: o.daysLeft });
  for (const d of s.lateSteps) items.push({ level: 'high', title: 'Juridique · dossier en retard', text: `Étape du dossier « ${oneLine(d.title, 60)} » prévue le ${d.date}${who(d.assignee, d.assigneeId)}`, at: d.date + 'T00:00:00.000Z', rank: -4000 });
  for (const u of s.upcomingSteps) items.push({ level: lvl(u.days), title: 'Juridique · étape de dossier', text: `Dossier « ${oneLine(u.title, 60)} »${u.nextStep ? ' : ' + oneLine(u.nextStep, 60) : ''} ${when(u.days)} (${u.date})${who(u.assignee, u.assigneeId)}`, at: null, rank: u.days });
  if (s.toSign.length) items.push({ level: 'info', title: 'Juridique · signatures', text: `${s.toSign.length} contrat(s) à signer : ${s.toSign.slice(0, 3).map((c) => '« ' + oneLine(c.title, 40) + ' »').join(', ')}`, at: null, rank: 9999 });
  items.sort((a, b) => a.rank - b.rank);
  const shownItems = items.slice(0, 5).map(({ rank, ...x }) => ({ ...x, module: 'legal' }));
  if (items.length > 5) {
    const rest = items.slice(5);
    shownItems.push({ level: rest.some((x) => x.level === 'high') ? 'medium' : 'info', module: 'legal', title: 'Juridique · autres rappels', text: `${rest.length} autre(s) rappel(s) juridique(s) : ouvrez le module pour la liste complète`, at: null });
  }
  return shownItems;
};

// Crochets lus par ai.js
module.exports.ctx = async (req) => {
  if (!A.can(req, 'manager')) return 'JURIDIQUE ET CONFORMITÉ : non accessible pour le rôle de cette personne.';
  const s = await summary(req);
  const cs = (await db.prepare("SELECT status, COUNT(*) AS n FROM legal_contracts WHERE org_id = ? GROUP BY status").all(req.org.id)).map((x) => `${x.status}=${x.n}`).join(', ');
  const k = { contract_end: 'fin du contrat', notice: 'limite de préavis', obligation: 'obligation', dispute_step: 'étape de dossier' };
  const out = [`JURIDIQUE ET CONFORMITÉ (aide-mémoire, pas un avis juridique) : contrats [${cs || 'aucun'}], ${s.openDisputes} litige(s)/incident(s) ouvert(s), ${s.toSign.length} contrat(s) à signer (suivi interne, sans valeur de signature électronique).`];
  out.push('Échéances des 30 prochains jours (rappels à 30 et 7 jours) :', ...(s.upcoming.slice(0, 12).map((u) => `- ${u.date} (${u.days} j) ${k[u.kind]} « ${oneLine(u.title, 80)} »${u.responsible ? ` (attribué à ${oneLine(u.responsible, 40)})` : ''}`)), ...(s.upcoming.length ? [] : ['(aucune)']));
  out.push('Contrats expirés :', ...(s.expired.slice(0, 6).map((c) => `- « ${oneLine(c.title, 80)} » depuis ${c.endDate}${c.assignee ? `, attribué à ${oneLine(c.assignee, 40)}` : ''}`)), ...(s.expired.length ? [] : ['(aucun)']));
  out.push('Obligations en retard :', ...(s.overdueObligations.slice(0, 8).map((o) => `- « ${oneLine(o.title, 80)} » échéance ${o.dueDate}${o.responsible ? `, responsable ${oneLine(o.responsible, 40)}` : ''}`)), ...(s.overdueObligations.length ? [] : ['(aucune)']));
  if (s.toSign.length) out.push('Contrats à signer :', ...s.toSign.slice(0, 5).map((c) => `- « ${oneLine(c.title, 80)} »${c.signers ? ` (signataires : ${oneLine(c.signers, 80)})` : ''}`));
  return out.join('\n').slice(0, 3000);
};
module.exports.prompt = "Tu aides à organiser et à rappeler : échéances de contrats, délais de préavis, obligations de conformité récurrentes, suivi des litiges, aide-mémoire sur les données personnelles. Tu ne remplaces pas un avocat ni un juriste : tu ne donnes pas d'avis juridique, tu n'affirmes jamais qu'un contrat, un document ou une pratique est « légal » ou « conforme », et tu rappelles de faire relire par un professionnel du droit de leur pays les textes importants. Les statuts « à signer » et « signé » sont un simple suivi interne : ce n'est pas une signature électronique et cela n'a aucune valeur légale en soi. Les lois varient selon les pays : n'invente aucun article de loi, délai légal ou montant de sanction. Réponds en français simple et propose des actions concrètes (qui, quoi, pour quelle date). Tu ne modifies rien toi-même.";
module.exports.min = 'manager';
