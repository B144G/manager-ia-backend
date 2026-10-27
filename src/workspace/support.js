'use strict';
// Sous-application « Service client » : boîte de tickets (formulaire public, saisie manuelle, réponses de l'équipe).
// Vague 3 : délais (SLA) de première réponse et de résolution, satisfaction (CSAT) à la résolution, lien avec la fiche client, réponse envoyée
// au client par e-mail ou WhatsApp (sauf s'il a demandé à ne plus être contacté).
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const wh = require('../services/webhooks');
const { sendMail, mailEnabled } = require('../services/notify');
const { HttpError, isEmail, oneLine, log } = require('../util');

const router = express.Router({ mergeParams: true });
const STATUS = ['open', 'pending', 'resolved'];
const PRIORITY = ['low', 'normal', 'high'];
const CHANNELS = ['manuel', 'formulaire', 'whatsapp', 'messenger', 'instagram', 'email', 'telephone'];
const digits = (v) => String(v || '').replace(/\D/g, '');
const hoursAfter = (iso, h) => new Date(Date.parse(iso) + h * 3600000).toISOString();

function slaState(due, doneAt, now = Date.now()) {
  if (!due) return 'none';
  if (doneAt) return doneAt <= due ? 'met' : 'missed';
  return Date.parse(due) < now ? 'breached' : 'pending';
}
const row = (t) => ({ id: t.id, ref: t.ref, customerName: t.customer_name, customerContact: t.customer_contact, customerId: t.customer_id, channel: t.channel, subject: t.subject, status: t.status, priority: t.priority, assigneeId: t.assignee_id, assignee: t.assignee || null, branchId: t.branch_id, createdAt: t.created_at, updatedAt: t.updated_at,
  firstDueAt: t.first_due_at, dueAt: t.due_at, firstResponseAt: t.first_response_at, resolvedAt: t.resolved_at,
  slaFirst: slaState(t.first_due_at, t.first_response_at), slaResolve: slaState(t.due_at, t.resolved_at), csat: t.csat, csatComment: t.csat_comment || undefined });

/** Crée un ticket (saisie manuelle, formulaire public) : délais SLA selon la priorité, lien automatique avec une fiche client de même téléphone ou e-mail. */
async function createTicket(org, d) {
  const now = nowISO();
  const st = await W.settings(org.id);
  const pr = PRIORITY.includes(d.priority) ? d.priority : 'normal';
  let customerId = d.customerId || null;
  if (!customerId && (d.contact || d.email || d.phone)) {
    const em = String(d.email || (isEmail(d.contact) ? d.contact : '')).trim().toLowerCase(); const ph = digits(d.phone || (!isEmail(d.contact) ? d.contact : '')).slice(-9);
    for (const c of await db.prepare('SELECT id, email, phone FROM customers WHERE org_id = ?').all(org.id)) {
      if ((em && String(c.email).trim().toLowerCase() === em) || (ph.length >= 8 && digits(c.phone).slice(-9) === ph)) { customerId = Number(c.id); break; }
    }
  }
  const id = await db.transaction(async () => {
    const tid = Number((await db.prepare('INSERT INTO tickets (org_id, branch_id, customer_id, customer_name, customer_contact, channel, subject, priority, first_due_at, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(org.id, d.branchId || null, customerId, d.name, d.contact || d.email || d.phone || '', CHANNELS.includes(d.channel) ? d.channel : 'manuel', d.subject, pr, hoursAfter(now, st['sla_first_' + pr]), hoursAfter(now, st['sla_resolve_' + pr]), now, now)).lastInsertRowid);
    await db.prepare('UPDATE tickets SET ref = ? WHERE id = ?').run(`T-${now.slice(0, 4)}-${String(tid).padStart(4, '0')}`, tid);
    if (d.message) await db.prepare("INSERT INTO ticket_messages (ticket_id, author, user_id, content, created_at) VALUES (?, 'customer', NULL, ?, ?)").run(tid, d.message, now);
    return tid;
  })();
  wh.emit(org.id, 'ticket.created', { id, ref: `T-${now.slice(0, 4)}-${String(id).padStart(4, '0')}`, subject: d.subject, channel: d.channel || 'manuel', customer: d.name });
  return id;
}

/** Délais, référence et lien client pour un ticket créé ailleurs (conversation transmise par l'assistant commercial). */
async function applySla(org, ticketId, customerId) {
  const t = await db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  const st = await W.settings(org.id);
  await db.prepare('UPDATE tickets SET ref = ?, customer_id = ?, first_due_at = ?, due_at = ? WHERE id = ?')
    .run(`T-${t.created_at.slice(0, 4)}-${String(t.id).padStart(4, '0')}`, customerId || null, hoursAfter(t.created_at, st['sla_first_' + t.priority]), hoursAfter(t.created_at, st['sla_resolve_' + t.priority]), t.id);
}

async function getTicket(req, id) {
  const t = await db.prepare('SELECT * FROM tickets WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!t || !A.visible(req, t)) throw new HttpError(404, 'Demande introuvable.');
  return t;
}

router.get('/', async (req, res) => {
  const sc = A.scope(req, 't.branch_id');
  const where = ['t.org_id = ?'];
  const args = [req.org.id];
  if (req.query.status) { where.push('t.status = ?'); args.push(A.oneOf(req.query.status, STATUS)); }
  if (req.query.customerId) { where.push('t.customer_id = ?'); args.push(A.id(req.query.customerId)); }
  const rows = await db.prepare(`SELECT t.*, u.name AS assignee FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE ${where.join(' AND ')}${sc.sql}
    ORDER BY (t.status = 'resolved'), CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 200`).all(...args, ...sc.args);
  const counts = await db.prepare(`SELECT status, COUNT(*) c FROM tickets t WHERE org_id = ?${sc.sql} GROUP BY status`).all(req.org.id, ...sc.args);
  res.json({ tickets: rows.map(row), counts: Object.fromEntries(counts.map((c) => [c.status, c.c])), breached: rows.filter((t) => t.status !== 'resolved' && (slaState(t.first_due_at, t.first_response_at) === 'breached' || slaState(t.due_at, t.resolved_at) === 'breached')).length });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.customerName, 100, { required: true, msg: 'Indiquez le nom du client.' });
  const message = A.text(b.message, 2000);
  const subject = A.text(b.subject, 150) || message.slice(0, 80);
  if (!subject) throw new HttpError(400, 'Indiquez le sujet de la demande.');
  let customerId = null;
  if (b.customerId) { const c = await db.prepare('SELECT id FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId), req.org.id); if (!c) throw new HttpError(404, 'Client introuvable.'); customerId = c.id; }
  const id = await createTicket(req.org, { name, contact: A.text(b.customerContact, 120), channel: b.channel, subject, message, priority: b.priority, customerId,
    branchId: await A.branchOf(req, b.branchId) || (A.can(req, 'admin') ? null : req.member.branch_id) });
  await A.logActivity(req.org.id, req.user.id, 'support', `Nouvelle demande de ${name}`);
  res.status(201).json({ id });
});

router.get('/:id', async (req, res) => {
  const t = await getTicket(req, req.params.id);
  const msgs = await db.prepare(`SELECT m.id, m.author, m.content, m.created_at AS at, m.sent_via AS "sentVia", m.send_status AS "sendStatus", m.send_error AS "sendError", u.name AS who FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id`).all(t.id);
  const cust = t.customer_id ? await db.prepare('SELECT id, name, phone, email FROM customers WHERE id = ?').get(t.customer_id) : null;
  res.json({ ticket: { ...row(t), csatLink: t.csat_token ? `${require('../config').siteUrl || ''}/satisfaction/${t.csat_token}` : undefined }, messages: msgs, customer: cust });
});

/** Envoie la réponse au client sur le canal de son contact. Ne plante jamais : renvoie { via, status, error }. */
async function deliver(req, t, text) {
  let contact = String(t.customer_contact || '').trim();
  const cust = t.customer_id ? await db.prepare('SELECT * FROM customers WHERE id = ?').get(t.customer_id) : null;
  if (!contact && cust) contact = cust.email || cust.phone || '';
  if (!contact) return { via: '', status: 'skipped', error: "Aucun contact (e-mail ou téléphone) pour répondre au client." };
  const body = `${text}\n\n—\n${req.org.name}`;
  if (isEmail(contact)) {
    if (!mailEnabled()) return { via: 'email', status: 'failed', error: "L'envoi d'e-mails n'est pas activé sur ce serveur." };
    const lim = A.limitsFor(await A.ownerPlan(req.org)).emailDay;
    const used = Number((await db.prepare("SELECT COUNT(*) c FROM outbox WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(req.org.id, `${nowISO().slice(0, 10)}T00:00:00.000Z`)).c);
    if (used >= lim) return { via: 'email', status: 'failed', error: `Limite de ${lim} e-mails par jour atteinte.` };
    let status = 'sent'; let error = '';
    try { await sendMail({ to: contact, subject: `Re : ${t.subject}`.slice(0, 150), text: body, replyTo: [req.user.contact].find(isEmail), fromName: req.org.name }); } catch (e) { status = 'failed'; error = oneLine(e.message, 160); log.warn('Réponse ticket non envoyée :', error); }
    await db.prepare('INSERT INTO outbox (org_id, user_id, customer_id, to_email, subject, body, attachments, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, req.user.id, t.customer_id, contact, `Re : ${t.subject}`.slice(0, 150), text, '[]', status, error, nowISO());
    return { via: 'email', status, error };
  }
  const waOrg = require('../services/waOrg'); const out = require('./wa-out');
  const phone = digits(contact);
  if (phone.length < 8) return { via: 'whatsapp', status: 'failed', error: 'Numéro de téléphone invalide.' };
  if (!waOrg.isConnected(req.org)) return { via: 'whatsapp', status: 'failed', error: "WhatsApp n'est pas connecté." };
  if (await out.isOptedOut(req.org.id, phone)) return { via: 'whatsapp', status: 'skipped', error: 'Ce client a demandé à ne plus recevoir de messages.' };
  try { await waOrg.sendText(req.org, phone.length === 9 ? '237' + phone : phone, body); return { via: 'whatsapp', status: 'sent', error: '' }; } catch (e) { return { via: 'whatsapp', status: 'failed', error: oneLine(e.message, 160) }; }
}

router.post('/:id/messages', async (req, res) => {
  const t = await getTicket(req, req.params.id);
  const b = req.body || {};
  const content = A.text(b.content, 3000, { required: true, msg: 'Écrivez un message.' });
  const author = b.author === 'customer' ? 'customer' : 'staff'; // « customer » : on note ce que le client a répondu par un autre canal
  const now = nowISO();
  let sent = { via: '', status: '', error: '' };
  if (author === 'staff' && b.send) sent = await deliver(req, t, content);
  await db.transaction(async () => {
    await db.prepare('INSERT INTO ticket_messages (ticket_id, author, user_id, content, created_at, sent_via, send_status, send_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(t.id, author, author === 'staff' ? req.user.id : null, content, now, sent.via, sent.status, sent.error);
    await db.prepare('UPDATE tickets SET updated_at = ?, status = ?, assignee_id = COALESCE(assignee_id, ?), first_response_at = COALESCE(first_response_at, ?) WHERE id = ?')
      .run(now, author === 'staff' && t.status === 'open' ? 'pending' : author === 'customer' && t.status !== 'open' ? 'open' : t.status, author === 'staff' ? req.user.id : null, author === 'staff' ? now : null, t.id);
  })();
  res.status(201).json({ ok: true, delivery: sent.status ? sent : undefined });
});

/** Demande d'avis au client à la résolution (e-mail ou WhatsApp, selon son contact) ; le lien public est aussi montré à l'équipe. */
async function askCsat(req, t, token) {
  const link = `${require('../config').siteUrl || ''}/satisfaction/${token}`;
  const r = await deliver(req, { ...t, customer_contact: t.customer_contact }, `Votre demande « ${t.subject} » est traitée. Pour nous dire si vous êtes satisfait(e), répondez en 1 minute : ${link}`);
  return r;
}

router.put('/:id', async (req, res) => {
  const t = await getTicket(req, req.params.id);
  const b = req.body || {};
  const assignee = b.assigneeId === undefined ? t.assignee_id : await A.memberOf(req, b.assigneeId);
  const status = b.status === undefined ? t.status : A.oneOf(b.status, STATUS);
  const priority = b.priority === undefined ? t.priority : A.oneOf(b.priority, PRIORITY);
  let customerId = t.customer_id;
  if (b.customerId !== undefined) {
    if (b.customerId === null || b.customerId === '') customerId = null;
    else { const c = await db.prepare('SELECT id FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId), req.org.id); if (!c) throw new HttpError(404, 'Client introuvable.'); customerId = c.id; }
  }
  const now = nowISO();
  const st = await W.settings(req.org.id);
  const resolving = status === 'resolved' && t.status !== 'resolved';
  const reopening = status !== 'resolved' && t.status === 'resolved';
  const token = resolving && !t.csat_token ? crypto.randomBytes(12).toString('hex') : t.csat_token;
  await db.prepare('UPDATE tickets SET status = ?, priority = ?, assignee_id = ?, customer_id = ?, updated_at = ?, resolved_at = ?, csat_token = ?, first_due_at = ?, due_at = ? WHERE id = ?')
    .run(status, priority, assignee, customerId, now, resolving ? now : reopening ? null : t.resolved_at, token, priority === t.priority ? t.first_due_at : hoursAfter(t.created_at, st['sla_first_' + priority]), priority === t.priority ? t.due_at : hoursAfter(t.created_at, st['sla_resolve_' + priority]), t.id);
  let csat;
  if (resolving) {
    await A.logActivity(req.org.id, req.user.id, 'support', `Demande résolue : ${t.subject}`);
    wh.emit(req.org.id, 'ticket.resolved', { id: t.id, ref: t.ref, subject: t.subject });
    if (b.askFeedback !== false) csat = await askCsat(req, t, token);
  }
  res.json({ ok: true, csat });
});

router.delete('/:id', A.need('manager'), async (req, res) => {
  const t = await getTicket(req, req.params.id);
  await W.audit(req, 'ticket', t.id, 'delete', { ref: t.ref, subject: t.subject, status: t.status }, null);
  await db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.createTicket = createTicket;
module.exports.applySla = applySla;
module.exports.slaState = slaState;
