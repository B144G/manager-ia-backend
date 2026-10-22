'use strict';
// Sous-application « Juridique et conformité » (responsables et plus) : contrats et échéances, obligations récurrentes, litiges, protection des données.
// Aide-mémoire d'organisation : ce n'est PAS un avis juridique.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError, oneLine } = require('../util');

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

// ---------- Contrats ----------
/** Alertes d'un contrat en cours : fin dans 30/7 jours, date limite de préavis dans 30/7 jours ou dépassée, contrat expiré. */
function contractView(c) {
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
  };
}
function contractFields(b, c) {
  const start = b.startDate === undefined ? (c ? c.start_date : null) : A.date(b.startDate);
  const end = b.endDate === undefined ? (c ? c.end_date : null) : A.date(b.endDate);
  if (start && end && end < start) throw new HttpError(400, 'La date de fin est avant la date de début.');
  return [b.type === undefined ? c.type : A.oneOf(b.type, TYPES, undefined, 'Type de contrat inconnu.'), b.title === undefined ? c.title : A.text(b.title, 150, { required: true, msg: 'Donnez un titre au contrat.' }),
    b.parties === undefined ? c.parties : A.text(b.parties, 200), b.subject === undefined ? c.subject : A.text(b.subject, 400), b.amount === undefined ? c.amount : money0(b.amount), start, end,
    b.tacit === undefined ? c.tacit : (b.tacit ? 1 : 0), b.noticeDays === undefined ? c.notice_days : intIn(b.noticeDays, 0, 730, 'Préavis invalide : indiquez un nombre de jours entre 0 et 730.'),
    b.status === undefined ? c.status : A.oneOf(b.status, CONTRACT_STATUS, undefined, 'Statut inconnu.'), b.docRef === undefined ? c.doc_ref : A.text(b.docRef, 300), b.notes === undefined ? c.notes : A.text(b.notes, 1000)];
}
const BLANK_CONTRACT = { type: 'other', title: '', parties: '', subject: '', amount: 0, start_date: null, end_date: null, tacit: 0, notice_days: 0, status: 'active', doc_ref: '', notes: '' };

router.get('/contracts', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM legal_contracts WHERE org_id = ? ORDER BY end_date IS NULL, end_date, id DESC LIMIT 300').all(req.org.id);
  res.json({ contracts: rows.map(contractView), types: TYPE_LABEL });
});
router.post('/contracts', async (req, res) => {
  const f = contractFields(req.body || {}, BLANK_CONTRACT);
  const id = (await db.prepare('INSERT INTO legal_contracts (org_id, type, title, parties, subject, amount, start_date, end_date, tacit, notice_days, status, doc_ref, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, ...f, req.user.id, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'legal', `Contrat « ${f[1]} » enregistré`);
  res.status(201).json({ id: Number(id) });
});
router.put('/contracts/:id', async (req, res) => {
  const c = await one(req, 'legal_contracts', req.params.id, 'Contrat');
  await db.prepare('UPDATE legal_contracts SET type = ?, title = ?, parties = ?, subject = ?, amount = ?, start_date = ?, end_date = ?, tacit = ?, notice_days = ?, status = ?, doc_ref = ?, notes = ? WHERE id = ?').run(...contractFields(req.body || {}, c), c.id);
  res.json({ ok: true });
});
router.delete('/contracts/:id', async (req, res) => {
  const c = await one(req, 'legal_contracts', req.params.id, 'Contrat');
  await db.prepare('DELETE FROM legal_contracts WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// ---------- Obligations de conformité ----------
const obView = (o, name) => ({
  id: o.id, kind: o.kind, kindLabel: OB_LABEL[o.kind], title: o.title, dueDate: o.due_date, recurrenceMonths: Number(o.recurrence_months), responsibleId: o.responsible_id, responsible: name || null, status: o.status,
  proof: o.proof, notes: o.notes, lastDone: o.last_done, overdue: o.status === 'pending' && Boolean(o.due_date) && o.due_date < today(), daysLeft: o.status === 'pending' && o.due_date ? daysTo(o.due_date) : null,
});
async function obFields(req, b, o) {
  const resp = b.responsibleId === undefined ? (o ? o.responsible_id : null) : await A.memberOf(req, b.responsibleId);
  return [b.kind === undefined ? o.kind : A.oneOf(b.kind, OB_KINDS, undefined, 'Type d\'obligation inconnu.'), b.title === undefined ? o.title : A.text(b.title, 150, { required: true, msg: 'Donnez un titre à l\'obligation.' }),
    b.dueDate === undefined ? o.due_date : A.date(b.dueDate), b.recurrenceMonths === undefined ? o.recurrence_months : intIn(b.recurrenceMonths, 0, 120, 'Récurrence invalide : indiquez un nombre de mois entre 0 et 120.'),
    resp, b.status === undefined ? o.status : A.oneOf(b.status, ['pending', 'done'], undefined, 'Statut inconnu.'), b.proof === undefined ? o.proof : A.text(b.proof, 400), b.notes === undefined ? o.notes : A.text(b.notes, 800)];
}
const BLANK_OB = { kind: 'other', title: '', due_date: null, recurrence_months: 0, responsible_id: null, status: 'pending', proof: '', notes: '' };

router.get('/obligations', async (req, res) => {
  const rows = await db.prepare('SELECT o.*, u.name AS who FROM legal_obligations o LEFT JOIN users u ON u.id = o.responsible_id WHERE o.org_id = ? ORDER BY CASE o.status WHEN \'pending\' THEN 0 ELSE 1 END, o.due_date IS NULL, o.due_date, o.id LIMIT 300').all(req.org.id);
  const members = await db.prepare('SELECT m.user_id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name LIMIT 100').all(req.org.id);
  res.json({ obligations: rows.map((o) => obView(o, o.who)), members: members.map((m) => ({ userId: m.user_id, name: m.name })), kinds: OB_LABEL });
});
router.post('/obligations', async (req, res) => {
  const f = await obFields(req, req.body || {}, BLANK_OB);
  if (!f[1]) throw new HttpError(400, "Donnez un titre à l'obligation.");
  const id = (await db.prepare('INSERT INTO legal_obligations (org_id, kind, title, due_date, recurrence_months, responsible_id, status, proof, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, ...f, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/obligations/:id', async (req, res) => {
  const o = await one(req, 'legal_obligations', req.params.id, 'Obligation');
  await db.prepare('UPDATE legal_obligations SET kind = ?, title = ?, due_date = ?, recurrence_months = ?, responsible_id = ?, status = ?, proof = ?, notes = ? WHERE id = ?').run(...await obFields(req, req.body || {}, o), o.id);
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
  await db.prepare('DELETE FROM legal_obligations WHERE id = ?').run(o.id);
  res.json({ ok: true });
});

// ---------- Litiges et incidents ----------
function disputeFields(b, d) {
  return [b.kind === undefined ? d.kind : A.oneOf(b.kind, DISPUTE_KINDS, undefined, 'Type inconnu.'), b.title === undefined ? d.title : A.text(b.title, 150, { required: true, msg: 'Donnez un titre.' }),
    b.counterparty === undefined ? d.counterparty : A.text(b.counterparty, 150), b.openedAt === undefined ? d.opened_at : (A.date(b.openedAt) || today()), b.status === undefined ? d.status : A.oneOf(b.status, DISPUTE_STATUS, undefined, 'Statut inconnu.'),
    b.amount === undefined ? d.amount : money0(b.amount), b.description === undefined ? d.description : A.text(b.description, 1500), b.nextStep === undefined ? d.next_step : A.text(b.nextStep, 300),
    b.nextDate === undefined ? d.next_date : A.date(b.nextDate), b.outcome === undefined ? d.outcome : A.text(b.outcome, 500)];
}
const BLANK_DISPUTE = { kind: 'dispute', title: '', counterparty: '', opened_at: today(), status: 'open', amount: 0, description: '', next_step: '', next_date: null, outcome: '' };
router.get('/disputes', async (req, res) => {
  const rows = await db.prepare("SELECT * FROM legal_disputes WHERE org_id = ? ORDER BY CASE status WHEN 'closed' THEN 1 ELSE 0 END, next_date IS NULL, next_date, id DESC LIMIT 200").all(req.org.id);
  res.json({ disputes: rows.map((d) => ({ id: d.id, kind: d.kind, kindLabel: DISPUTE_LABEL[d.kind], title: d.title, counterparty: d.counterparty, openedAt: d.opened_at, status: d.status, amount: Number(d.amount), description: d.description, nextStep: d.next_step, nextDate: d.next_date, outcome: d.outcome })) });
});
router.post('/disputes', async (req, res) => {
  const f = disputeFields({ ...(req.body || {}), openedAt: (req.body || {}).openedAt === undefined ? today() : (req.body || {}).openedAt }, BLANK_DISPUTE);
  if (!f[1]) throw new HttpError(400, 'Donnez un titre.');
  const id = (await db.prepare('INSERT INTO legal_disputes (org_id, kind, title, counterparty, opened_at, status, amount, description, next_step, next_date, outcome, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, ...f, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/disputes/:id', async (req, res) => {
  const d = await one(req, 'legal_disputes', req.params.id, 'Dossier');
  await db.prepare('UPDATE legal_disputes SET kind = ?, title = ?, counterparty = ?, opened_at = ?, status = ?, amount = ?, description = ?, next_step = ?, next_date = ?, outcome = ? WHERE id = ?').run(...disputeFields(req.body || {}, d), d.id);
  res.json({ ok: true });
});
router.delete('/disputes/:id', async (req, res) => {
  const d = await one(req, 'legal_disputes', req.params.id, 'Dossier');
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
  const contracts = (await db.prepare("SELECT * FROM legal_contracts WHERE org_id = ? AND status = 'active'").all(req.org.id)).map(contractView);
  const obs = (await db.prepare("SELECT o.*, u.name AS who FROM legal_obligations o LEFT JOIN users u ON u.id = o.responsible_id WHERE o.org_id = ? AND o.status = 'pending'").all(req.org.id)).map((o) => obView(o, o.who));
  const upcoming = [];
  for (const c of contracts) {
    if (c.endDate && !c.expired) {
      const d = daysTo(c.endDate);
      if (d <= 30) upcoming.push({ kind: 'contract_end', title: c.title, date: c.endDate, days: d });
    }
    if (c.noticeDate && !c.expired) {
      const d = daysTo(c.noticeDate);
      if (d >= 0 && d <= 30) upcoming.push({ kind: 'notice', title: c.title, date: c.noticeDate, days: d });
    }
  }
  for (const o of obs) if (o.dueDate && !o.overdue && o.daysLeft <= 30) upcoming.push({ kind: 'obligation', title: o.title, date: o.dueDate, days: o.daysLeft, responsible: o.responsible });
  upcoming.sort((a, b) => a.days - b.days);
  const toRenew = contracts.filter((c) => c.alerts.some((a) => ['end7', 'end30', 'notice7', 'notice30', 'notice_passed'].includes(a.code)));
  const disputes = Number((await db.prepare("SELECT COUNT(*) AS c FROM legal_disputes WHERE org_id = ? AND status != 'closed'").get(req.org.id)).c);
  return { upcoming, toRenew: toRenew.map((c) => ({ id: c.id, title: c.title, endDate: c.endDate, noticeDate: c.noticeDate, alerts: c.alerts })), expired: contracts.filter((c) => c.expired).map((c) => ({ id: c.id, title: c.title, endDate: c.endDate })),
    overdueObligations: obs.filter((o) => o.overdue).map((o) => ({ id: o.id, title: o.title, dueDate: o.dueDate, responsible: o.responsible })), openDisputes: disputes };
}
router.get('/', async (req, res) => {
  const s = await summary(req);
  res.json({ summary: { upcoming: s.upcoming.length, toRenew: s.toRenew.length, overdue: s.overdueObligations.length, expired: s.expired.length, openDisputes: s.openDisputes }, ...s });
});

module.exports = router;
// Crochets lus par ai.js
module.exports.ctx = async (req) => {
  if (!A.can(req, 'manager')) return 'JURIDIQUE ET CONFORMITÉ : non accessible pour le rôle de cette personne.';
  const s = await summary(req);
  const cs = (await db.prepare("SELECT status, COUNT(*) AS n FROM legal_contracts WHERE org_id = ? GROUP BY status").all(req.org.id)).map((x) => `${x.status}=${x.n}`).join(', ');
  const out = [`JURIDIQUE ET CONFORMITÉ (aide-mémoire, pas un avis juridique) : contrats [${cs || 'aucun'}], ${s.openDisputes} litige(s)/incident(s) ouvert(s).`];
  out.push('Échéances des 30 prochains jours :', ...(s.upcoming.slice(0, 12).map((u) => `- ${u.date} (${u.days} j) ${{ contract_end: 'fin du contrat', notice: 'limite de préavis', obligation: 'obligation' }[u.kind]} « ${oneLine(u.title, 80)} »${u.responsible ? ` (${oneLine(u.responsible, 40)})` : ''}`)), ...(s.upcoming.length ? [] : ['(aucune)']));
  out.push('Contrats expirés :', ...(s.expired.slice(0, 6).map((c) => `- « ${oneLine(c.title, 80)} » depuis ${c.endDate}`)), ...(s.expired.length ? [] : ['(aucun)']));
  out.push('Obligations en retard :', ...(s.overdueObligations.slice(0, 8).map((o) => `- « ${oneLine(o.title, 80)} » échéance ${o.dueDate}${o.responsible ? `, responsable ${oneLine(o.responsible, 40)}` : ''}`)), ...(s.overdueObligations.length ? [] : ['(aucune)']));
  return out.join('\n').slice(0, 3000);
};
module.exports.prompt = "Tu aides à organiser et à rappeler : échéances de contrats, délais de préavis, obligations de conformité récurrentes, suivi des litiges, aide-mémoire sur les données personnelles. Tu ne remplaces pas un avocat ni un juriste : tu ne donnes pas d'avis juridique, tu n'affirmes jamais qu'un contrat, un document ou une pratique est « légal » ou « conforme », et tu rappelles de faire relire par un professionnel du droit de leur pays les textes importants. Les lois varient selon les pays : n'invente aucun article de loi, délai légal ou montant de sanction. Réponds en français simple et propose des actions concrètes (qui, quoi, pour quelle date). Tu ne modifies rien toi-même.";
module.exports.min = 'manager';
