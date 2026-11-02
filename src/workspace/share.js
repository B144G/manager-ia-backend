'use strict';
// Documents PDF : fabrication côté serveur (facture, devis, avoir ; rapport de projet ; bulletin de paie) et partage à une ou plusieurs personnes
// de l'entreprise : par personne, par poste, par antenne ou par rôle. Le PDF est un instantané chiffré (AES-256-GCM, comme les pièces jointes du juridique) ;
// chaque destinataire est prévenu dans l'application (et par e-mail si son contact en est un) et ouvre le document après connexion : pas de lien public.
// Les bulletins de paie ne vont qu'à leur salarié (et à l'administrateur qui les envoie), jamais à d'autres destinataires.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const X = require('./legal-extra');
const D = require('./invoice-doc');
const PDF = require('../services/pdf');
const limits = require('../middleware/limits');
const { HttpError, oneLine, cleanText, log } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const sendLimit = limits.make(60 * 1000, 20, 'Vous partagez trop vite. Patientez une minute.');
const MAX_ORG = 40 * 1024 * 1024; const MAX_RECIPIENTS = 200;
const KINDS = { invoice: 'Facture, devis ou avoir', project: 'Rapport de projet', payslip: 'Bulletin de paie' };
const WORKING_DOC = "Document de travail : à faire valider par l'expert-comptable ou le juriste de l'entreprise avant tout usage légal, fiscal ou social.";

const slug = (s) => cleanText(String(s || ''), 60).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';

// ---------- Fabrication des PDF ----------
async function invoicePdf(req, id) {
  if (!A.can(req, 'manager')) throw new HttpError(403, 'Seul un responsable peut produire ce document.');
  const d = await db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!d || !A.visible(req, d)) throw new HttpError(404, 'Document introuvable.');
  const p = await D.printData(req, d); const cur = p.org.currency; const label = D.KIND_LABEL[d.kind] || 'Document';
  const t = p.totals;
  const spec = {
    org: p.org.name, title: `${label} ${d.number}`, subtitle: `Date : ${PDF.dfr(d.issued)}${d.due ? ` · Échéance : ${PDF.dfr(d.due)}` : ''}`,
    meta: [['Émetteur', [p.org.name, p.org.address, p.org.niu ? `NIU : ${p.org.niu}` : '', p.org.rccm ? `RCCM : ${p.org.rccm}` : ''].filter(Boolean).join(' · ')],
      ['Client', [p.customer.name, p.customer.address, p.customer.niu ? `NIU : ${p.customer.niu}` : ''].filter(Boolean).join(' · ')]].concat(p.document.creditOf ? [['Avoir sur la facture', p.document.creditOf]] : []),
    blocks: [
      { type: 'table', cols: [{ key: 'label', label: 'Désignation', width: 5 }, { key: 'q', label: 'Qté', width: 1, align: 'right' }, { key: 'pu', label: p.pricesIncl ? 'Prix unit. TTC' : 'Prix unit. HT', width: 2, align: 'right' }, { key: 'amt', label: 'Montant', width: 2, align: 'right' }],
        rows: p.lines.map((l) => ({ label: l.label, q: String(l.quantity), pu: PDF.money(l.price), amt: PDF.money(l.amount) })),
        totals: [[p.pricesIncl ? 'Total HT (déduit)' : 'Total HT', PDF.money(t.ht, cur)], [`TVA ${t.vatRate || 0} %`, PDF.money(t.vat, cur)], ['Total TTC', PDF.money(t.total, cur), true]]
          .concat(d.kind === 'invoice' ? [['Déjà payé', PDF.money(t.paid, cur)], ['Reste à payer', PDF.money(t.balance, cur), true]] : []) },
    ].concat(p.document.note ? [{ type: 'text', text: p.document.note }] : [], p.org.payInfo ? [{ type: 'heading', text: 'Paiement' }, { type: 'text', text: p.org.payInfo }] : [], p.org.footer ? [{ type: 'note', text: p.org.footer }] : [],
      [{ type: 'note', text: p.missing.length ? `Mentions à compléter avant usage officiel : ${p.missing.map((k) => ({ org_niu: "NIU de l'entreprise", org_address: "adresse de l'entreprise", customer_niu: 'NIU du client' }[k])).join(', ')}. ${WORKING_DOC}` : WORKING_DOC }]),
  };
  return { title: `${label} ${d.number}`, spec, branchId: d.branch_id || null };
}

async function projectPdf(req, id, opts = {}) {
  const P6 = require('./projects-w6');
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(404, 'Projet introuvable.');
  const cur = req.org.currency; const today = W.today();
  const tasks = await db.prepare('SELECT t.*, u.name AS who FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id = ? ORDER BY (t.status = \'done\'), t.due IS NULL, t.due, t.id').all(p.id);
  const ms = await db.prepare('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY due IS NULL, due, id').all(p.id);
  const insight = await P6.insight(req.org.id, p);
  const STATUS = { todo: 'À faire', doing: 'En cours', done: 'Terminée' };
  const done = tasks.filter((t) => t.status === 'done').length;
  const blocks = [
    { type: 'kv', rows: [['Avancement', `${done} tâche(s) terminée(s) sur ${tasks.length}`], ['Échéance', p.due ? PDF.dfr(p.due) : 'non fixée'],
      ['Fin prévue (calcul)', insight.forecast.endDate ? `${PDF.dfr(insight.forecast.endDate)}${insight.forecast.lateDays ? ` (${insight.forecast.lateDays} j après l'échéance)` : ''}` : 'non calculable'],
      ['Fiabilité des données', `${insight.quality.score} / 100`]] },
    { type: 'heading', text: 'Tâches' },
    { type: 'table', cols: [{ key: 'title', label: 'Tâche', width: 5 }, { key: 'who', label: 'Responsable', width: 2.5 }, { key: 'status', label: 'État', width: 2 }, { key: 'due', label: 'Pour le', width: 1.7 }, { key: 'h', label: 'Heures', width: 1.2, align: 'right' }],
      rows: tasks.map((t) => ({ title: t.title, who: t.who || '—', status: t.status !== 'done' && t.due && t.due < today ? `${STATUS[t.status]} (en retard)` : STATUS[t.status], due: t.due ? PDF.dfr(t.due) : '—', h: Number(t.estimate_hours) ? String(t.estimate_hours) : '—' })) },
  ];
  if (ms.length) blocks.push({ type: 'heading', text: 'Jalons' }, { type: 'table', cols: [{ key: 'title', label: 'Jalon', width: 6 }, { key: 'due', label: 'Date', width: 2 }, { key: 'st', label: 'État', width: 2 }], rows: ms.map((m) => ({ title: m.title, due: m.due ? PDF.dfr(m.due) : '—', st: Number(m.done) ? 'Atteint' : m.due && m.due < today ? 'En retard' : 'À venir' })) });
  if (opts.includeCosts && A.can(req, 'manager')) {
    const c = insight.costs; const budget = Number(p.budget);
    blocks.push({ type: 'heading', text: 'Budget et coûts' }, { type: 'kv', rows: [['Budget', budget ? PDF.money(budget, cur) : 'non fixé'], ['Dépenses', PDF.money(c.expenses, cur)], ['Temps passé', `${c.hours} h (${PDF.money(c.timeCost, cur)})`], ['Coût total', PDF.money(c.spent, cur)]].concat(budget ? [['Reste', PDF.money(budget - c.spent, cur)]] : []) });
  }
  blocks.push({ type: 'note', text: `Les dates et la prévision sont calculées à partir des données saisies (jours entiers, week-ends non retirés). Si les estimations sont fausses, la prévision l'est aussi. Fiabilité : ${insight.quality.score}/100${insight.quality.gaps.length ? ` ; il manque : ${insight.quality.gaps.map((g) => g.text).join(' ; ')}` : ''}.` });
  return { title: `Projet ${p.name}`, spec: { org: req.org.name, title: `Rapport de projet : ${p.name}`, subtitle: `Établi le ${PDF.dfr(today)} par ${req.user.name}`, blocks }, branchId: p.branch_id || null };
}

const slipLines = (s) => { try { return JSON.parse(s.lines); } catch { return []; } };
async function payslipPdf(req, id) {
  if (!A.can(req, 'admin')) throw new HttpError(403, "Seul un administrateur peut produire un bulletin de paie.");
  const s = await db.prepare('SELECT * FROM payroll_slips WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!s) throw new HttpError(404, 'Bulletin introuvable.');
  const cur = req.org.currency; const m = (n) => PDF.money(n, cur);
  const earn = [['Salaire de base', s.base], ['Primes', s.bonuses], ['Heures supplémentaires', s.overtime], [s.annual_bonus_label || 'Prime annuelle / 13e mois', s.annual_bonus]].filter((r) => Number(r[1]) > 0);
  const ded = slipLines(s).filter((l) => l.kind === 'employee' && Number(l.amount) > 0);
  const rows = earn.map(([k, v]) => ({ k, rate: '', basis: '', amt: m(v) }))
    .concat(Number(s.absence_deduction) > 0 ? [{ k: 'Retenue pour absences', rate: '', basis: '', amt: '- ' + m(s.absence_deduction) }] : [])
    .concat(ded.map((l) => ({ k: l.label, rate: l.rate ? `${l.rate} %` : '', basis: l.basis ? m(l.basis) : '', amt: '- ' + m(l.amount) })))
    .concat(Number(s.other_deductions) > 0 ? [{ k: 'Autres retenues', rate: '', basis: '', amt: '- ' + m(s.other_deductions) }] : [], Number(s.advances) > 0 ? [{ k: 'Avances sur salaire', rate: '', basis: '', amt: '- ' + m(s.advances) }] : []);
  const spec = {
    org: req.org.name, title: `Bulletin de paie ${s.month}`, subtitle: `${s.employee_name}${s.job ? ' · ' + s.job : ''}`,
    meta: [['Employeur', [req.org.name, req.org.address, req.org.niu ? `NIU : ${req.org.niu}` : ''].filter(Boolean).join(' · ')], ['Salarié', `${s.employee_name}${s.job ? ' (' + s.job + ')' : ''}`], ['Période', s.month], ['Statut', { draft: 'Brouillon', validated: 'Validé', paid: 'Payé' }[s.status] || s.status]],
    blocks: [{ type: 'table', cols: [{ key: 'k', label: 'Rubrique', width: 5 }, { key: 'rate', label: 'Taux', width: 1.2, align: 'right' }, { key: 'basis', label: 'Base', width: 2.2, align: 'right' }, { key: 'amt', label: 'Montant', width: 2.4, align: 'right' }], rows,
      totals: [['Salaire brut', m(s.gross)], ['Total des retenues', '- ' + m(Number(s.employee_deductions) + Number(s.other_deductions) + Number(s.advances))], ['Net à payer', m(s.net), true]] },
    s.note ? { type: 'text', text: s.note } : { type: 'space' }, { type: 'note', text: WORKING_DOC }],
  };
  return { title: `Bulletin de paie ${s.month} : ${s.employee_name}`, spec, slip: s };
}

async function build(req, kind, id, opts) {
  if (kind === 'invoice') return invoicePdf(req, id);
  if (kind === 'project') return projectPdf(req, id, opts);
  if (kind === 'payslip') return payslipPdf(req, id);
  throw new HttpError(400, 'Type de document inconnu (invoice, project ou payslip).');
}

// ---------- Destinataires ----------
async function resolveAudience(req, b) {
  const ids = new Set(); const noAccount = [];
  const arr = (x) => (Array.isArray(x) ? x : []);
  const members = await db.prepare('SELECT m.user_id, m.role, m.branch_id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?').all(req.org.id);
  const byUser = new Map(members.map((m) => [Number(m.user_id), m]));
  for (const x of arr(b.userIds)) { const n = Number(x); if (byUser.has(n)) ids.add(n); }
  const roles = new Set(arr(b.roles).map(String)); const branches = new Set(arr(b.branchIds).map(Number));
  for (const m of members) if (roles.has(m.role) || (m.branch_id && branches.has(Number(m.branch_id)))) ids.add(Number(m.user_id));
  const jobs = arr(b.jobs).map((j) => cleanText(String(j), 80)).filter(Boolean);
  if (jobs.length) {
    const emps = await db.prepare(`SELECT name, job, user_id FROM employees WHERE org_id = ? AND status = 'active' AND job IN (${jobs.map(() => '?').join(',')})`).all(req.org.id, ...jobs);
    for (const e of emps) { if (e.user_id && byUser.has(Number(e.user_id))) ids.add(Number(e.user_id)); else noAccount.push({ name: e.name, job: e.job }); }
  }
  ids.delete(Number(req.user.id));
  if (ids.size > MAX_RECIPIENTS) throw new HttpError(400, `Trop de destinataires (${MAX_RECIPIENTS} au plus).`);
  return { ids: [...ids], names: [...ids].map((i) => byUser.get(i).name), noAccount };
}

router.get('/audience', mgr, async (req, res) => {
  const members = await db.prepare('SELECT m.user_id, m.role, m.title, m.branch_id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name').all(req.org.id);
  const jobs = await db.prepare("SELECT job, COUNT(*) n, SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) accounts FROM employees WHERE org_id = ? AND status = 'active' AND job <> '' GROUP BY job ORDER BY job").all(req.org.id);
  const branches = await db.prepare('SELECT id, name FROM branches WHERE org_id = ? ORDER BY name').all(req.org.id);
  res.json({ members: members.filter((m) => Number(m.user_id) !== Number(req.user.id)).map((m) => ({ userId: m.user_id, name: m.name, role: m.role, title: m.title, branchId: m.branch_id })),
    jobs: jobs.map((j) => ({ job: j.job, employees: Number(j.n), withAccount: Number(j.accounts) })), branches, roles: A.ROLES.filter((r) => r !== 'owner') });
});
router.post('/preview', mgr, async (req, res) => {
  const r = await resolveAudience(req, req.body || {});
  res.json({ count: r.ids.length, names: r.names.slice(0, 50), noAccount: r.noAccount.slice(0, 50) });
});

// ---------- Enregistrement d'un partage ----------
async function store(req, { kind, title, buf, sourceType, sourceId, message, recipients }) {
  const used = Number((await db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM legal_files WHERE org_id = ?').get(req.org.id)).s);
  if (used + buf.length > MAX_ORG) throw new HttpError(403, "Espace de fichiers plein (40 Mo). Supprimez d'anciens documents partagés.");
  return db.transaction(async () => {
    const id = Number((await db.prepare('INSERT INTO doc_shares (org_id, kind, title, source_type, source_id, message, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, kind, oneLine(title, 150), sourceType || kind, sourceId || null, cleanText(message || '', 500), req.user.id, nowISO())).lastInsertRowid);
    await db.prepare('INSERT INTO legal_files (org_id, parent_type, parent_id, name, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, 'share', id, `${slug(title)}.pdf`, 'application/pdf', buf.length, X.seal(buf), req.user.id, nowISO());
    for (const uid of recipients) await db.prepare('INSERT INTO doc_share_recipients (org_id, share_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(req.org.id, id, uid, nowISO());
    return id;
  })();
}

router.post('/send', mgr, sendLimit, async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (kind === 'payslip') throw new HttpError(400, 'Les bulletins de paie ne se partagent pas à des groupes : utilisez « Envoyer les bulletins à chaque salarié ».');
  const aud = await resolveAudience(req, b);
  if (!aud.ids.length) throw new HttpError(400, 'Choisissez au moins un destinataire (une personne, un poste, une antenne ou un rôle).');
  const built = await build(req, kind, b.sourceId, { includeCosts: Boolean(b.includeCosts) });
  const buf = await PDF.render(built.spec);
  const message = cleanText(b.message || '', 500);
  const id = await store(req, { kind, title: built.title, buf, sourceId: Number(b.sourceId), message, recipients: aud.ids });
  for (const uid of aud.ids) await W.push(req.org.id, uid, 'document', `${req.user.name} vous a partagé « ${oneLine(built.title, 80)} ».${message ? ' ' + oneLine(message, 120) : ''} Ouvrez Brij-IA > Tableau de bord > Documents reçus.`, 'share:' + id);
  await W.audit(req, 'doc_share', id, 'create', null, { kind, title: built.title, recipients: aud.ids.length });
  await A.logActivity(req.org.id, req.user.id, 'documents', `« ${built.title} » partagé avec ${aud.ids.length} personne(s)`);
  res.status(201).json({ id, recipients: aud.ids.length, names: aud.names.slice(0, 20), noAccount: aud.noAccount.slice(0, 50), size: buf.length });
});

/** Bulletins de paie du mois : un PDF par salarié, envoyé à lui seul. Les salariés sans compte sont listés (rien n'est envoyé pour eux). */
router.post('/payslips', A.need('admin'), sendLimit, async (req, res) => {
  const b = req.body || {};
  const month = A.monthRange(b.month).month;
  const slips = await db.prepare("SELECT * FROM payroll_slips WHERE org_id = ? AND month = ? ORDER BY employee_name, id").all(req.org.id, month);
  const out = { month, sent: 0, skipped: [] };
  for (const s of slips) {
    const skip = (reason) => out.skipped.push({ employee: s.employee_name, reason });
    if (s.status === 'draft') { skip('brouillon : validez d\'abord le bulletin'); continue; }
    const emp = await db.prepare('SELECT user_id FROM employees WHERE id = ? AND org_id = ?').get(s.employee_id, req.org.id);
    const uid = emp && emp.user_id ? Number(emp.user_id) : null;
    const mem = uid ? await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid) : null;
    if (!mem) { skip("pas de compte Brij-IA lié à ce salarié : téléchargez le PDF pour le lui remettre"); continue; }
    if (uid === Number(req.user.id)) { skip("c'est vous : téléchargez le PDF"); continue; }
    if (!b.resend && await db.prepare("SELECT 1 FROM doc_shares WHERE org_id = ? AND source_type = 'payslip' AND source_id = ?").get(req.org.id, s.id)) { skip('déjà envoyé'); continue; }
    const built = await payslipPdf(req, s.id);
    const buf = await PDF.render(built.spec);
    const id = await store(req, { kind: 'payslip', title: `Bulletin de paie ${s.month}`, buf, sourceType: 'payslip', sourceId: s.id, message: '', recipients: [uid] });
    await W.push(req.org.id, uid, 'document', `Votre bulletin de paie de ${s.month} est disponible. Ouvrez Brij-IA > Tableau de bord > Documents reçus.`, 'share:' + id);
    await W.audit(req, 'doc_share', id, 'create', null, { kind: 'payslip', slip: s.id });
    out.sent++;
  }
  await A.logActivity(req.org.id, req.user.id, 'payroll', `Bulletins ${month} envoyés : ${out.sent}`);
  res.json(out);
});

// ---------- PDF sans partage (téléchargement) ----------
const pdfHeaders = (res, name, len, inline) => res.set({ 'Content-Type': 'application/pdf', 'Content-Length': len, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${slug(name)}.pdf"` });
router.get('/pdf/:kind/:id', mgr, async (req, res) => {
  const built = await build(req, req.params.kind, req.params.id, { includeCosts: req.query.includeCosts === '1' });
  const buf = await PDF.render(built.spec);
  await W.audit(req, 'doc_pdf', Number(req.params.id) || null, 'download', null, { kind: req.params.kind });
  pdfHeaders(res, built.title, buf.length); res.end(buf);
});

// ---------- Boîte de réception et envois ----------
router.get('/inbox', async (req, res) => {
  const rows = await db.prepare(`SELECT s.id, s.kind, s.title, s.message, s.created_at, u.name AS sender, r.opened_at, f.size FROM doc_share_recipients r JOIN doc_shares s ON s.id = r.share_id LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN legal_files f ON f.parent_type = 'share' AND f.parent_id = s.id WHERE r.org_id = ? AND r.user_id = ? ORDER BY s.id DESC LIMIT 100`).all(req.org.id, req.user.id);
  res.json({ items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, message: r.message, sender: r.sender, at: r.created_at, opened: Boolean(r.opened_at), size: Number(r.size || 0) })), unread: rows.filter((r) => !r.opened_at).length });
});
router.get('/sent', mgr, async (req, res) => {
  const all = A.can(req, 'admin');
  const rows = await db.prepare(`SELECT s.id, s.kind, s.title, s.created_at, s.created_by, u.name AS sender FROM doc_shares s LEFT JOIN users u ON u.id = s.created_by WHERE s.org_id = ?${all ? '' : ' AND s.created_by = ?'} ORDER BY s.id DESC LIMIT 60`).all(...[req.org.id].concat(all ? [] : [req.user.id]));
  const ids = rows.map((r) => r.id);
  const rec = ids.length ? await db.prepare(`SELECT r.share_id, r.user_id, r.opened_at, u.name FROM doc_share_recipients r LEFT JOIN users u ON u.id = r.user_id WHERE r.share_id IN (${ids.map(() => '?').join(',')}) ORDER BY u.name`).all(...ids) : [];
  res.json({ items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, at: r.created_at, sender: r.sender, mine: Number(r.created_by) === Number(req.user.id),
    recipients: rec.filter((x) => x.share_id === r.id).map((x) => ({ userId: x.user_id, name: x.name, opened: Boolean(x.opened_at) })) })) });
});

async function shareFor(req, id) {
  const s = await db.prepare('SELECT * FROM doc_shares WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!s) throw new HttpError(404, 'Document introuvable.');
  const r = await db.prepare('SELECT * FROM doc_share_recipients WHERE share_id = ? AND user_id = ?').get(s.id, req.user.id);
  const mine = Number(s.created_by) === Number(req.user.id);
  if (!r && !mine && !A.can(req, 'admin')) throw new HttpError(404, 'Document introuvable.');
  return { s, r, mine };
}
router.get('/:id/file', async (req, res) => {
  const { s, r } = await shareFor(req, req.params.id);
  const f = await db.prepare("SELECT * FROM legal_files WHERE org_id = ? AND parent_type = 'share' AND parent_id = ?").get(req.org.id, s.id);
  if (!f) throw new HttpError(404, 'Fichier introuvable.');
  const data = X.unseal(f.data);
  if (!data) throw new HttpError(500, 'Ce document ne peut pas être relu (clé de chiffrement modifiée).');
  if (r && !r.opened_at) await db.prepare('UPDATE doc_share_recipients SET opened_at = ? WHERE id = ?').run(nowISO(), r.id);
  await W.audit(req, 'doc_share', s.id, 'open', null, { kind: s.kind });
  pdfHeaders(res, s.title, data.length, req.query.inline === '1'); res.end(data);
});
router.delete('/:id', mgr, async (req, res) => {
  const { s, mine } = await shareFor(req, req.params.id);
  if (!mine && !A.can(req, 'admin')) throw new HttpError(403, 'Vous pouvez retirer seulement vos partages.');
  await db.transaction(async () => {
    await db.prepare("DELETE FROM legal_files WHERE org_id = ? AND parent_type = 'share' AND parent_id = ?").run(req.org.id, s.id);
    await db.prepare('DELETE FROM doc_share_recipients WHERE share_id = ?').run(s.id);
    await db.prepare('DELETE FROM doc_shares WHERE id = ?').run(s.id);
  })();
  await W.audit(req, 'doc_share', s.id, 'delete', { title: s.title }, null);
  res.json({ ok: true });
});

module.exports = router;
Object.assign(module.exports, { build, resolveAudience, KINDS });
void log;
