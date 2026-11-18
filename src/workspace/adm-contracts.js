'use strict';
// Administration · 7. Contrats et conformité. Registre des contrats (parties, dates, préavis, reconduction tacite, montants, pièces de la GED, alertes
// d'échéance et de renouvellement) et registre de conformité (obligations récurrentes avec responsable, échéance, preuve, statut).
// AUCUN texte de loi n'est inventé : l'entreprise remplit elle-même l'autorité et la référence ; les modèles sont des suggestions génériques.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./adm-lib');
const T = require('./adm-templates');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const manage = L.needPerm('contracts_manage');
const mgrRead = A.need('manager'); // contrats et conformité : lecture réservée aux responsables et plus
const KINDS = ['client', 'supplier', 'lease', 'insurance', 'employment', 'partnership', 'service', 'other'];
const KIND_LABEL = { client: 'Client', supplier: 'Fournisseur', lease: 'Bail', insurance: 'Assurance', employment: 'Travail', partnership: 'Partenariat', service: 'Prestation', other: 'Autre' };
const PERIODS = { once: 1, monthly: 12, quarterly: 4, semiannual: 2, yearly: 1 };

// ---------- Contrats : calcul de la situation à une date ----------
/** Fin effective (la reconduction tacite prolonge d'autant de périodes que nécessaire), date limite de résiliation, état et alerte. */
function situation(c, alertDays, today = L.today()) {
  const out = { effectiveEnd: c.end_date || null, renewals: 0, noticeDeadline: null, state: 'ok', alert: null, daysToEnd: null, daysToNotice: null };
  if (!c.end_date || c.status !== 'active') { out.state = c.status === 'active' ? 'open_ended' : c.status; return out; }
  let end = c.end_date; const tacit = Number(c.tacit_renewal) === 1; const months = Math.max(1, Number(c.renewal_months) || 12);
  if (tacit) while (end < today && out.renewals < 200) { end = L.addMonths(end, months); out.renewals++; }
  out.effectiveEnd = end;
  out.daysToEnd = L.daysBetween(today, end);
  const notice = Number(c.notice_days) > 0 ? L.addDays(end, -Number(c.notice_days)) : null;
  out.noticeDeadline = notice;
  out.daysToNotice = notice ? L.daysBetween(today, notice) : null;
  if (!tacit && end < today) { out.state = 'expired'; out.alert = 'expired'; }
  else if (tacit && notice && notice < today) { out.state = 'notice_missed'; out.alert = 'notice_missed'; } // trop tard pour résilier : le contrat se reconduit
  else if (tacit && notice && notice <= L.addDays(today, alertDays)) { out.state = 'notice_soon'; out.alert = 'notice_soon'; }
  else if (end <= L.addDays(today, alertDays)) { out.state = 'ending_soon'; out.alert = 'ending_soon'; }
  return out;
}
const ALERT_LABEL = { expired: 'Contrat expiré', notice_missed: 'Préavis dépassé : reconduit tacitement', notice_soon: 'Dernier jour pour résilier proche', ending_soon: 'Arrive à échéance' };
const annual = (c) => (Number(c.amount) || 0) * (PERIODS[c.periodicity] || 1);
function contractView(c, names, cfg, docs) {
  const s = situation(c, cfg.contractAlertDays);
  return L.out(c, { kindLabel: KIND_LABEL[c.kind] || c.kind, owner: names.get(Number(c.owner_id)) || null, amount: Number(c.amount), tacitRenewal: Number(c.tacit_renewal) === 1, noticeDays: Number(c.notice_days), renewalMonths: Number(c.renewal_months), docIds: L.jparse(c.doc_ids, []), docs: docs || undefined, ...s, alertLabel: s.alert ? ALERT_LABEL[s.alert] : null, annualValue: annual(c) });
}
async function docIdsIn(req, v) {
  const ids = [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  const cfg = await L.getConfig(req.org.id); const D = require('./adm-docs');
  for (const id of ids) { const d = await db.prepare('SELECT * FROM adm_docs WHERE id = ? AND org_id = ?').get(id, req.org.id); if (!d || !D.visible(req, cfg, d)) throw new HttpError(400, 'Une pièce jointe est inconnue ou inaccessible.'); }
  return ids;
}
router.get('/contracts', mgrRead, async (req, res) => {
  const cfg = await L.getConfig(req.org.id); const names = await L.nameMap(req.org.id);
  const where = ['org_id = ?']; const args = [req.org.id];
  if (req.query.kind && KINDS.includes(req.query.kind)) { where.push('kind = ?'); args.push(req.query.kind); }
  if (req.query.status && ['draft', 'active', 'terminated', 'expired'].includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
  const rows = await db.prepare(`SELECT * FROM adm_contracts WHERE ${where.join(' AND ')} ORDER BY end_date IS NULL, end_date LIMIT 1000`).all(...args);
  const list = rows.map((c) => contractView(c, names, cfg));
  const active = list.filter((c) => c.status === 'active');
  res.json({
    contracts: list, perms: { manage: L.allowed(req, cfg, 'contracts_manage') },
    summary: { total: list.length, active: active.length, alerts: active.filter((c) => c.alert).length, annualValue: active.reduce((s, c) => s + c.annualValue, 0), byKind: KINDS.map((k) => ({ key: k, label: KIND_LABEL[k], count: active.filter((c) => c.kind === k).length })).filter((k) => k.count) },
    byMonth: (() => { const m = []; for (let i = 0; i < 12; i++) { const key = L.addMonths(L.today(), i).slice(0, 7); m.push({ month: key, count: active.filter((c) => c.effectiveEnd && c.effectiveEnd.slice(0, 7) === key).length }); } return m; })(),
  });
});
router.get('/contracts/alerts', mgrRead, async (req, res) => {
  const cfg = await L.getConfig(req.org.id); const names = await L.nameMap(req.org.id);
  const rows = await db.prepare("SELECT * FROM adm_contracts WHERE org_id = ? AND status = 'active'").all(req.org.id);
  const alerts = rows.map((c) => contractView(c, names, cfg)).filter((c) => c.alert).sort((a, b) => (a.daysToNotice ?? a.daysToEnd) - (b.daysToNotice ?? b.daysToEnd));
  res.json({ alerts, count: alerts.length, windowDays: cfg.contractAlertDays });
});
async function contractBody(req, b, base = {}) {
  const t = (k, col, max) => (b[k] === undefined ? base[col] || '' : A.text(b[k], max));
  const start = b.startDate === undefined ? base.start_date || null : A.date(b.startDate); const end = b.endDate === undefined ? base.end_date || null : A.date(b.endDate);
  if (start && end && end < start) throw new HttpError(400, 'La date de fin précède la date de début.');
  return {
    kind: A.oneOf(b.kind, KINDS, base.kind || 'other', 'Type de contrat inconnu.'), title: b.title === undefined ? base.title : A.text(b.title, 200, { required: true, msg: 'Indiquez l’intitulé du contrat.' }), counterparty: t('counterparty', 'counterparty', 160), parties: t('parties', 'parties', 500),
    start, end, noticeDays: b.noticeDays === undefined ? Number(base.notice_days || 0) : L.intIn(b.noticeDays, 0, 730, 0), tacit: b.tacitRenewal === undefined ? Number(base.tacit_renewal || 0) : L.flag(b.tacitRenewal), renewalMonths: b.renewalMonths === undefined ? Number(base.renewal_months || 12) : L.intIn(b.renewalMonths, 1, 120, 12),
    amount: b.amount === undefined ? Number(base.amount || 0) : L.money(b.amount), periodicity: A.oneOf(b.periodicity, Object.keys(PERIODS), base.periodicity || 'once', 'Périodicité inconnue.'), owner: b.ownerId === undefined ? base.owner_id || null : await A.memberOf(req, b.ownerId),
    status: A.oneOf(b.status, ['draft', 'active', 'terminated', 'expired'], base.status || 'active', 'Statut inconnu.'), docIds: b.docIds === undefined ? L.jparse(base.doc_ids, []) : await docIdsIn(req, b.docIds), notes: t('notes', 'notes', 2000),
  };
}
router.post('/contracts', manage, async (req, res) => {
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_contracts WHERE org_id = ?').get(req.org.id)).c >= 3000) throw new HttpError(403, 'Limite de 3 000 contrats atteinte.');
  const c = await contractBody(req, req.body || {});
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM adm_contracts WHERE org_id = ?').get(req.org.id)).c) + 1; const now = nowISO();
  const id = (await db.prepare('INSERT INTO adm_contracts (org_id, ref, kind, title, counterparty, parties, start_date, end_date, notice_days, tacit_renewal, renewal_months, amount, periodicity, owner_id, status, doc_ids, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, 'CTR-' + String(n).padStart(4, '0'), c.kind, c.title, c.counterparty, c.parties, c.start, c.end, c.noticeDays, c.tacit, c.renewalMonths, c.amount, c.periodicity, c.owner, c.status, JSON.stringify(c.docIds), c.notes, req.user.id, now, now)).lastInsertRowid;
  await W.audit(req, 'adm_contract', id, 'create', null, { title: c.title, end: c.end });
  res.status(201).json({ id: Number(id), ref: 'CTR-' + String(n).padStart(4, '0') });
});
router.get('/contracts/:id', mgrRead, async (req, res) => {
  const cfg = await L.getConfig(req.org.id);
  const c = await db.prepare('SELECT * FROM adm_contracts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Contrat introuvable.');
  const D = require('./adm-docs');
  const docs = [];
  for (const id of L.jparse(c.doc_ids, [])) { const d = await db.prepare('SELECT * FROM adm_docs WHERE id = ? AND org_id = ?').get(id, req.org.id); if (d && D.visible(req, cfg, d)) docs.push({ id: Number(d.id), title: d.title, fileName: d.file_name }); }
  res.json({ contract: contractView(c, await L.nameMap(req.org.id), cfg, docs) });
});
router.put('/contracts/:id', manage, async (req, res) => {
  const x = await db.prepare('SELECT * FROM adm_contracts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Contrat introuvable.');
  const c = await contractBody(req, req.body || {}, x);
  await db.prepare('UPDATE adm_contracts SET kind = ?, title = ?, counterparty = ?, parties = ?, start_date = ?, end_date = ?, notice_days = ?, tacit_renewal = ?, renewal_months = ?, amount = ?, periodicity = ?, owner_id = ?, status = ?, doc_ids = ?, notes = ?, updated_at = ? WHERE id = ?')
    .run(c.kind, c.title, c.counterparty, c.parties, c.start, c.end, c.noticeDays, c.tacit, c.renewalMonths, c.amount, c.periodicity, c.owner, c.status, JSON.stringify(c.docIds), c.notes, nowISO(), x.id);
  await W.audit(req, 'adm_contract', x.id, 'update', { end: x.end_date, status: x.status }, { end: c.end, status: c.status });
  res.json({ ok: true });
});
/** Renouvellement explicite : nouvelle date de fin. */
router.post('/contracts/:id/renew', manage, async (req, res) => {
  const x = await db.prepare('SELECT * FROM adm_contracts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Contrat introuvable.');
  const b = req.body || {};
  const s = situation(x, 0);
  const end = A.date(b.endDate) || L.addMonths(s.effectiveEnd || L.today(), Number(x.renewal_months) || 12);
  if (s.effectiveEnd && end <= s.effectiveEnd) throw new HttpError(400, 'La nouvelle fin doit être postérieure à la fin actuelle.');
  await db.prepare("UPDATE adm_contracts SET end_date = ?, status = 'active', amount = ?, updated_at = ? WHERE id = ?").run(end, b.amount === undefined ? x.amount : L.money(b.amount), nowISO(), x.id);
  await W.audit(req, 'adm_contract', x.id, 'renew', { end: s.effectiveEnd }, { end });
  res.json({ ok: true, endDate: end });
});
router.post('/contracts/:id/terminate', manage, async (req, res) => {
  const x = await db.prepare('SELECT * FROM adm_contracts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Contrat introuvable.');
  await db.prepare("UPDATE adm_contracts SET status = 'terminated', notes = ?, updated_at = ? WHERE id = ?").run(A.text(`${x.notes}\nRésilié le ${L.today()} ${A.text((req.body || {}).reason, 300)}`, 2000), nowISO(), x.id);
  await W.audit(req, 'adm_contract', x.id, 'terminate', { status: x.status }, { status: 'terminated' });
  res.json({ ok: true });
});
router.delete('/contracts/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_contracts WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Contrat introuvable.');
  res.json({ ok: true });
});
/** Reprend les contrats du module Juridique qui ne sont pas encore au registre (lecture seule côté Juridique). */
router.post('/contracts/import-legal', manage, async (req, res) => {
  if (!await L.hasTable('legal_contracts')) return res.json({ ok: true, imported: 0 });
  const have = new Set((await db.prepare('SELECT legal_id FROM adm_contracts WHERE org_id = ? AND legal_id IS NOT NULL').all(req.org.id)).map((r) => Number(r.legal_id)));
  const rows = await db.prepare('SELECT * FROM legal_contracts WHERE org_id = ?').all(req.org.id);
  const map = { client: 'client', supplier: 'supplier', lease: 'lease', work: 'employment', insurance: 'insurance', partnership: 'partnership' };
  let n = 0; const now = nowISO();
  for (const c of rows) {
    if (have.has(Number(c.id))) continue;
    const count = Number((await db.prepare('SELECT COUNT(*) c FROM adm_contracts WHERE org_id = ?').get(req.org.id)).c) + 1;
    await db.prepare('INSERT INTO adm_contracts (org_id, ref, kind, title, counterparty, parties, start_date, end_date, notice_days, tacit_renewal, amount, status, legal_id, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, 'CTR-' + String(count).padStart(4, '0'), map[c.type] || 'other', c.title, '', c.parties, c.start_date, c.end_date, c.notice_days, c.tacit, c.amount, ['active', 'draft', 'terminated', 'expired'].includes(c.status) ? c.status : 'active', c.id, c.notes, req.user.id, now, now);
    n++;
  }
  res.json({ ok: true, imported: n });
});

// ---------- Conformité ----------
const CATEGORIES = ['declaration', 'license', 'insurance', 'register', 'audit', 'other'];
const CAT_LABEL = { declaration: 'Déclaration', license: 'Licence / autorisation', insurance: 'Assurance', register: 'Registre obligatoire', audit: 'Contrôle', other: 'Autre' };
function compView(c, names, cfg) {
  const today = L.today(); const active = ['todo', 'in_progress'].includes(c.status);
  const days = c.due_date ? L.daysBetween(today, c.due_date) : null;
  return L.out(c, { categoryLabel: CAT_LABEL[c.category] || c.category, responsible: names.get(Number(c.responsible_id)) || null, frequencyMonths: Number(c.frequency_months), daysLeft: days, overdue: Boolean(active && c.due_date && c.due_date < today), soon: Boolean(active && c.due_date && c.due_date >= today && c.due_date <= L.addDays(today, cfg.complianceAlertDays)), noDate: active && !c.due_date });
}
router.get('/compliance', mgrRead, async (req, res) => {
  const cfg = await L.getConfig(req.org.id); const names = await L.nameMap(req.org.id);
  const where = ['org_id = ?']; const args = [req.org.id];
  if (req.query.status && ['todo', 'in_progress', 'done', 'na'].includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
  if (req.query.category && CATEGORIES.includes(req.query.category)) { where.push('category = ?'); args.push(req.query.category); }
  const rows = await db.prepare(`SELECT * FROM adm_compliance WHERE ${where.join(' AND ')} ORDER BY due_date IS NULL, due_date LIMIT 1000`).all(...args);
  const list = rows.map((c) => compView(c, names, cfg));
  res.json({ items: list, perms: { manage: L.allowed(req, cfg, 'contracts_manage') }, categories: CATEGORIES.map((c) => ({ key: c, label: CAT_LABEL[c] })),
    summary: { total: list.length, overdue: list.filter((c) => c.overdue).length, soon: list.filter((c) => c.soon).length, done: list.filter((c) => c.status === 'done' || (c.lastDone && c.status === 'todo')).length, noDate: list.filter((c) => c.noDate).length, byStatus: ['todo', 'in_progress', 'done', 'na'].map((s) => ({ key: s, count: list.filter((c) => c.status === s).length })) } });
});
router.get('/compliance/suggestions', mgrRead, (req, res) => res.json({ suggestions: T.COMPLIANCE_SUGGESTIONS.map((s, i) => ({ index: i, ...s, categoryLabel: CAT_LABEL[s.category] })), note: 'Suggestions génériques : renseignez vous-même l’autorité, la référence du texte applicable et les dates propres à votre activité.' }));
async function compBody(req, b, base = {}) {
  const t = (k, col, max) => (b[k] === undefined ? base[col] || '' : A.text(b[k], max));
  return { title: b.title === undefined ? base.title : A.text(b.title, 200, { required: true, msg: 'Indiquez l’obligation.' }), category: A.oneOf(b.category, CATEGORIES, base.category || 'other', 'Catégorie inconnue.'), authority: t('authority', 'authority', 200), reference: t('referenceText', 'reference_text', 400),
    freq: b.frequencyMonths === undefined ? Number(base.frequency_months || 0) : L.intIn(b.frequencyMonths, 0, 120, 0), due: b.dueDate === undefined ? base.due_date || null : A.date(b.dueDate), responsible: b.responsibleId === undefined ? base.responsible_id || null : await A.memberOf(req, b.responsibleId),
    status: A.oneOf(b.status, ['todo', 'in_progress', 'done', 'na'], base.status || 'todo', 'Statut inconnu.'), notes: t('notes', 'notes', 1500) };
}
router.post('/compliance', manage, async (req, res) => {
  const c = await compBody(req, req.body || {});
  const id = (await db.prepare('INSERT INTO adm_compliance (org_id, title, category, authority, reference_text, frequency_months, due_date, responsible_id, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, c.title, c.category, c.authority, c.reference, c.freq, c.due, c.responsible, c.status, c.notes, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.post('/compliance/suggestions/add', manage, async (req, res) => {
  const idx = [...new Set((Array.isArray((req.body || {}).indexes) ? req.body.indexes : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < T.COMPLIANCE_SUGGESTIONS.length))];
  if (!idx.length) throw new HttpError(400, 'Choisissez au moins une suggestion.');
  const have = new Set((await db.prepare('SELECT title FROM adm_compliance WHERE org_id = ?').all(req.org.id)).map((r) => r.title));
  let n = 0;
  for (const i of idx) { const s = T.COMPLIANCE_SUGGESTIONS[i]; if (have.has(s.title)) continue; await db.prepare("INSERT INTO adm_compliance (org_id, title, category, frequency_months, notes, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)").run(req.org.id, s.title, s.category, s.frequencyMonths, s.note, req.user.id, nowISO()); n++; }
  res.json({ ok: true, added: n });
});
router.put('/compliance/:id', manage, async (req, res) => {
  const x = await db.prepare('SELECT * FROM adm_compliance WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Obligation introuvable.');
  const c = await compBody(req, req.body || {}, x);
  await db.prepare('UPDATE adm_compliance SET title = ?, category = ?, authority = ?, reference_text = ?, frequency_months = ?, due_date = ?, responsible_id = ?, status = ?, notes = ? WHERE id = ?').run(c.title, c.category, c.authority, c.reference, c.freq, c.due, c.responsible, c.status, c.notes, x.id);
  res.json({ ok: true });
});
router.delete('/compliance/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_compliance WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Obligation introuvable.');
  res.json({ ok: true });
});
/** Marque l'obligation accomplie : une preuve est exigée ; si elle se répète, la prochaine échéance est calculée. */
router.post('/compliance/:id/done', async (req, res) => {
  const x = await db.prepare('SELECT * FROM adm_compliance WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Obligation introuvable.');
  req.admCfg = await L.getConfig(req.org.id);
  if (Number(x.responsible_id) !== req.user.id && !L.allowed(req, req.admCfg, 'contracts_manage')) throw new HttpError(403, 'Seul le responsable de l’obligation (ou un gestionnaire) la déclare accomplie.');
  const b = req.body || {};
  const proof = A.text(b.proof, 800); const docId = A.idOrNull(b.docId);
  if (!proof && !docId) throw new HttpError(400, 'Une preuve est exigée : référence du récépissé, ou document de la GED.');
  if (docId) await docIdsIn(req, [docId]);
  const doneOn = A.date(b.doneOn) || L.today();
  if (doneOn > L.today()) throw new HttpError(400, 'La date d’accomplissement ne peut pas être dans le futur.');
  let next = null; const freq = Number(x.frequency_months);
  await db.transaction(async () => {
    await db.prepare('INSERT INTO adm_compliance_log (org_id, compliance_id, done_on, due_was, proof, proof_doc_id, done_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, x.id, doneOn, x.due_date, proof, docId, req.user.id, nowISO());
    if (freq > 0) {
      next = L.addMonths(x.due_date || doneOn, freq);
      while (next <= doneOn) next = L.addMonths(next, freq);
      await db.prepare("UPDATE adm_compliance SET status = 'todo', due_date = ?, last_done = ?, proof = ?, proof_doc_id = ? WHERE id = ?").run(next, doneOn, proof, docId, x.id);
    } else await db.prepare("UPDATE adm_compliance SET status = 'done', last_done = ?, proof = ?, proof_doc_id = ? WHERE id = ?").run(doneOn, proof, docId, x.id);
  })();
  await W.audit(req, 'adm_compliance', x.id, 'done', { due: x.due_date }, { doneOn, next });
  res.json({ ok: true, next });
});
router.get('/compliance/:id/history', mgrRead, async (req, res) => {
  const names = await L.nameMap(req.org.id);
  const rows = await db.prepare('SELECT * FROM adm_compliance_log WHERE compliance_id = ? AND org_id = ? ORDER BY id DESC LIMIT 100').all(A.id(req.params.id), req.org.id);
  res.json({ history: rows.map((r) => ({ doneOn: r.done_on, dueWas: r.due_was, late: Boolean(r.due_was && r.done_on > r.due_was), proof: r.proof, docId: r.proof_doc_id == null ? null : Number(r.proof_doc_id), by: names.get(Number(r.done_by)) || null })) });
});

async function summary(orgId) {
  const cfg = await L.getConfig(orgId); const names = new Map();
  const contracts = (await db.prepare("SELECT * FROM adm_contracts WHERE org_id = ? AND status = 'active'").all(orgId)).map((c) => contractView(c, names, cfg));
  const comp = (await db.prepare('SELECT * FROM adm_compliance WHERE org_id = ?').all(orgId)).map((c) => compView(c, names, cfg));
  return { contractsActive: contracts.length, contractAlerts: contracts.filter((c) => c.alert).length, contractsExpired: contracts.filter((c) => c.alert === 'expired').length, noticeMissed: contracts.filter((c) => c.alert === 'notice_missed').length, annualValue: contracts.reduce((s, c) => s + c.annualValue, 0),
    complianceTotal: comp.length, complianceOverdue: comp.filter((c) => c.overdue).length, complianceSoon: comp.filter((c) => c.soon).length, complianceNoDate: comp.filter((c) => c.noDate).length, alertList: contracts.filter((c) => c.alert).slice(0, 8), overdueList: comp.filter((c) => c.overdue).slice(0, 8) };
}
router.get('/summary', mgrRead, async (req, res) => res.json(await summary(req.org.id)));

/** Alertes uniques par échéance : contrats (résiliation, fin, expiration) et obligations en retard ou proches. */
async function sweep(orgId) {
  const cfg = await L.getConfig(orgId); const names = new Map(); let n = 0;
  const admins = await L.ownerIds(orgId);
  for (const c of await db.prepare("SELECT * FROM adm_contracts WHERE org_id = ? AND status = 'active'").all(orgId)) {
    const v = contractView(c, names, cfg);
    if (v.alert && await L.notifyOnce(orgId, `contract:${c.id}:${v.alert}:${v.noticeDeadline || v.effectiveEnd}`, [c.owner_id, ...admins], `${ALERT_LABEL[v.alert]} : ${c.title} (${v.alert.startsWith('notice') ? 'résiliation avant le ' + v.noticeDeadline : 'fin le ' + v.effectiveEnd})`, 'contract:' + c.id)) n++;
  }
  for (const c of await db.prepare("SELECT * FROM adm_compliance WHERE org_id = ? AND status IN ('todo','in_progress') AND due_date IS NOT NULL").all(orgId)) {
    const v = compView(c, names, cfg);
    if ((v.overdue || v.soon) && await L.notifyOnce(orgId, `compliance:${c.id}:${c.due_date}:${v.overdue ? 'late' : 'soon'}`, [c.responsible_id, ...admins], `${v.overdue ? 'Obligation en retard' : 'Obligation à venir'} : ${c.title} (${c.due_date})`, 'compliance:' + c.id)) n++;
  }
  return n;
}

module.exports = { router, summary, sweep, situation, contractView };
