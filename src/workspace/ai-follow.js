'use strict';
// Sous-application « Suivi de l'IA » (responsables et plus) : tous les clients de l'entreprise (fiches + contacts de messagerie sans fiche), état de l'IA pour chacun,
// exclusion totale ou partielle, brouillons à valider, conversation en direct et journal. Les règles elles-mêmes (et leur application) sont dans ai-rules.js.
// Confidentialité : ces routes sont propres à l'organisation (middleware loadOrg + rôle) ; l'administration de la plateforme (/api/admin) n'a AUCUNE route vers ce contenu.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const R = require('./ai-rules');
const channels = require('./channels');
const { HttpError, asyncHandler, oneLine, stripAccents } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('manager'));

const STATES = ['active', 'excluded', 'partial', 'waiting', 'draft'];
const SORTS = ['name', 'last', 'messages', 'ordered', 'owed', 'stage'];
const num = (v) => Number(v) || 0;
const fold = (s) => stripAccents(String(s || '').toLowerCase());

// ---------- Fil de conversation (utilisé aussi par « Assistant commercial > Conversations » et « Mes conversations ») ----------
const msgView = (m) => ({ id: Number(m.id), role: m.role, content: m.content, at: m.created_at, staffId: m.staff_id ? Number(m.staff_id) : null, staff: m.staff || null });
const MSG_SQL = 'SELECT m.id, m.role, m.content, m.created_at, m.staff_id, u.name AS staff FROM chat_messages m LEFT JOIN users u ON u.id = m.staff_id WHERE m.chat_id = ?';
const PAGE = 200;

async function ruleOfChat(orgId, chat) {
  const ident = await R.identityOfChat(orgId, chat);
  const eff = await R.effectiveFor(orgId, ident);
  return { ident, eff };
}
const ruleSummary = (eff) => (eff.rules.length ? {
  mode: eff.excluded ? 'full' : 'partial', excluded: eff.excluded, noPrice: eff.noPrice, noOrder: eff.noOrder, noAppt: eff.noAppt, noFollowup: eff.noFollowup, draft: eff.draft,
  expiresAt: eff.expiresAt, reason: (eff.rules.find((r) => r.reason) || {}).reason || '',
} : null);

/**
 * Messages d'une conversation + état du contact. since = n'envoyer que les messages d'identifiant plus grand (mise à jour en direct) ;
 * before = messages plus anciens (« voir plus haut »). Sans paramètre : les 200 derniers messages.
 */
async function thread(org, chat, q = {}) {
  const since = Math.floor(Number(q.since)); const before = Math.floor(Number(q.before));
  let rows; let hasMore = false;
  if (since > 0) rows = await db.prepare(`${MSG_SQL} AND m.id > ? ORDER BY m.id LIMIT ${PAGE}`).all(chat.id, since);
  else if (before > 0) { rows = (await db.prepare(`${MSG_SQL} AND m.id < ? ORDER BY m.id DESC LIMIT ${PAGE + 1}`).all(chat.id, before)); hasMore = rows.length > PAGE; rows = rows.slice(0, PAGE).reverse(); }
  else { rows = (await db.prepare(`${MSG_SQL} ORDER BY m.id DESC LIMIT ${PAGE + 1}`).all(chat.id)); hasMore = rows.length > PAGE; rows = rows.slice(0, PAGE).reverse(); }
  const fresh = await db.prepare('SELECT status, assignee_id FROM chats WHERE id = ?').get(chat.id);
  const { ident, eff } = await ruleOfChat(org.id, chat);
  const cu = ident.customerId ? await db.prepare('SELECT id, name, phone, stage FROM customers WHERE id = ?').get(ident.customerId) : null;
  const drafts = await db.prepare("SELECT id, body, created_at FROM ai_drafts WHERE chat_id = ? AND status = 'pending' ORDER BY id").all(chat.id);
  const last = await db.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE chat_id = ?').get(chat.id);
  return {
    messages: rows.map(msgView), hasMore, lastId: Number(last.id) || 0,
    status: fresh ? fresh.status : chat.status, assigneeId: fresh && fresh.assignee_id ? Number(fresh.assignee_id) : null,
    rule: ruleSummary(eff),
    drafts: drafts.map((d) => ({ id: Number(d.id), body: d.body, at: d.created_at })),
    person: { customerId: cu ? Number(cu.id) : null, name: cu ? cu.name : '', phone: cu ? cu.phone : '', stage: cu ? cu.stage : '', channel: chat.channel, contact: chat.contact || '', label: await R.labelOfChat({ ...chat, customer_id: ident.customerId || chat.customer_id }) },
  };
}

// ---------- Tableau de tous les clients ----------
async function buildContacts(req) {
  const o = req.org.id; const now = nowISO();
  const allRules = await db.prepare('SELECT * FROM ai_rules WHERE org_id = ?').all(o);
  if (allRules.some((r) => r.expires_at && r.expires_at <= now)) await R.liftExpired(o, allRules);
  const rules = allRules.filter((r) => !r.expires_at || r.expires_at > now);

  const customers = (await db.prepare('SELECT id, name, phone, email, stage, branch_id, source, created_at FROM customers WHERE org_id = ?').all(o)).filter((c) => A.visible(req, c));
  const byId = new Map(customers.map((c) => [Number(c.id), c]));
  const hidden = new Set((await db.prepare('SELECT id, branch_id FROM customers WHERE org_id = ?').all(o)).filter((c) => !A.visible(req, c)).map((c) => Number(c.id)));
  const byPhone = new Map();
  for (const c of customers) { const p = R.phone9(c.phone); if (p && !byPhone.has(p)) byPhone.set(p, c); }

  const totals = new Map();
  for (const d of await db.prepare('SELECT customer_id, kind, status, SUM(total) AS t, SUM(CASE WHEN kind = \'invoice\' AND status = \'sent\' THEN total - credited - paid ELSE 0 END) AS owed FROM documents WHERE org_id = ? GROUP BY customer_id, kind, status').all(o)) {
    const x = totals.get(Number(d.customer_id)) || { ordered: 0, invoiced: 0, owed: 0 };
    if (d.kind === 'order' && ['pending', 'confirmed', 'invoiced'].includes(d.status)) x.ordered += num(d.t);
    if (d.kind === 'invoice' && !['draft', 'cancelled'].includes(d.status)) x.invoiced += num(d.t);
    x.owed += num(d.owed);
    totals.set(Number(d.customer_id), x);
  }

  const chats = await db.prepare('SELECT c.id, c.session, c.channel, c.contact, c.customer_id, c.status, c.assignee_id, c.updated_at, c.created_at, au.name AS assignee FROM chats c LEFT JOIN users au ON au.id = c.assignee_id WHERE c.org_id = ?').all(o);
  const stats = new Map((await db.prepare('SELECT m.chat_id, COUNT(*) AS n, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE c.org_id = ? GROUP BY m.chat_id').all(o)).map((s) => [Number(s.chat_id), s]));
  const drafts = new Map((await db.prepare("SELECT chat_id, COUNT(*) AS n FROM ai_drafts WHERE org_id = ? AND status = 'pending' GROUP BY chat_id").all(o)).map((d) => [Number(d.chat_id), num(d.n)]));

  const groups = new Map();
  const slot = (key, init) => { if (!groups.has(key)) groups.set(key, { key, customer: null, chats: [], ...init }); return groups.get(key); };
  for (const c of customers) slot(`c:${c.id}`, { customer: c });
  for (const ch of chats) {
    let cid = ch.customer_id ? Number(ch.customer_id) : null;
    if (cid && hidden.has(cid)) continue;                                   // fiche d'une autre antenne : invisible
    const p9 = ch.channel === 'whatsapp' ? R.phone9(ch.contact) : '';
    if (!cid && p9 && byPhone.has(p9)) cid = Number(byPhone.get(p9).id);
    if (cid && !byId.has(cid)) cid = null;
    const key = cid ? `c:${cid}` : p9 ? `p:${p9}` : `s:${ch.session}`;
    slot(key, { customer: cid ? byId.get(cid) : null }).chats.push(ch);
  }

  const out = [];
  for (const g of groups.values()) {
    const cs = g.chats.map((ch) => ({ ...ch, st: stats.get(Number(ch.id)) || { n: 0, last_id: 0, last_at: null } })).sort((a, b) => String(b.st.last_at || b.updated_at).localeCompare(String(a.st.last_at || a.updated_at)));
    const main = cs[0] || null;
    const cu = g.customer;
    const keys = new Set([g.key]);
    if (cu) { keys.add(`c:${cu.id}`); const p = R.phone9(cu.phone); if (p) keys.add(`p:${p}`); }
    for (const ch of cs) { keys.add(`s:${ch.session}`); const p = ch.channel === 'whatsapp' ? R.phone9(ch.contact) : ''; if (p) keys.add(`p:${p}`); }
    const mine = rules.filter((r) => keys.has(r.rkey)).map(R.ruleView);
    const full = mine.find((r) => r.mode === 'full');
    const partials = mine.filter((r) => r.mode === 'partial');
    const pend = cs.reduce((n, ch) => n + (drafts.get(Number(ch.id)) || 0), 0);
    const waiting = cs.some((ch) => ch.status === 'handoff');
    const state = full ? 'excluded' : pend ? 'draft' : partials.length ? 'partial' : waiting ? 'waiting' : 'active';
    const t = cu ? totals.get(Number(cu.id)) || { ordered: 0, invoiced: 0, owed: 0 } : null;
    const lastAt = cs.reduce((m, ch) => (ch.st.last_at && ch.st.last_at > m ? ch.st.last_at : m), '') || null;
    const lastId = cs.reduce((m, ch) => Math.max(m, num(ch.st.last_id)), 0);
    const name = cu ? cu.name : main && main.contact ? `+${R.digits(main.contact) || main.contact}` : main ? `Visiteur du site (${String(main.session).slice(0, 6)})` : '';
    const phone = cu && cu.phone ? cu.phone : main && main.channel === 'whatsapp' ? `+${R.digits(main.contact)}` : '';
    out.push({
      key: g.key, customerId: cu ? Number(cu.id) : null, chatId: main ? Number(main.id) : null, name, phone, email: cu ? cu.email : '',
      channel: main ? main.channel : '', channels: [...new Set(cs.map((ch) => ch.channel))], stage: cu ? cu.stage : 'contact', hasCustomer: Boolean(cu),
      ordered: t ? t.ordered : null, invoiced: t ? t.invoiced : null, owed: t ? t.owed : null,
      lastAt, lastId, messages: cs.reduce((n, ch) => n + num(ch.st.n), 0), assigneeId: main && main.assignee_id ? Number(main.assignee_id) : null, assignee: main ? main.assignee : null,
      state, waiting, drafts: pend,
      rule: mine.length ? { mode: full ? 'full' : 'partial', noPrice: mine.some((r) => r.noPrice), noOrder: mine.some((r) => r.noOrder), noAppt: mine.some((r) => r.noAppt), noFollowup: mine.some((r) => r.noFollowup), draft: mine.some((r) => r.draft), expiresAt: mine.some((r) => !r.expiresAt) ? null : mine.map((r) => r.expiresAt).sort().pop(), reason: (mine.find((r) => r.reason) || {}).reason || '' } : null,
      threads: cs.map((ch) => ({ id: Number(ch.id), channel: ch.channel, at: ch.st.last_at, messages: num(ch.st.n) })),
      _text: fold(`${name} ${phone} ${cu ? cu.email : ''} ${main ? main.contact : ''}`),
    });
  }
  return out;
}

router.get('/contacts', asyncHandler(async (req, res) => {
  const q = req.query || {};
  let list = await buildContacts(req);
  const term = fold(q.q).trim();
  const digitsQ = R.digits(q.q);
  if (term) list = list.filter((c) => c._text.includes(term) || (digitsQ.length >= 3 && R.digits(c.phone).includes(digitsQ)));
  if (q.channel) list = list.filter((c) => (q.channel === 'none' ? !c.channels.length : c.channels.includes(String(q.channel))));
  if (q.stage) list = list.filter((c) => c.stage === String(q.stage));
  const counts = Object.fromEntries(STATES.map((s) => [s, list.filter((c) => c.state === s).length]));
  counts.all = list.length;
  if (q.state && q.state !== 'all') { if (!STATES.includes(q.state)) throw new HttpError(400, "État de l'IA inconnu."); list = list.filter((c) => c.state === q.state); }
  const sort = SORTS.includes(q.sort) ? q.sort : 'last'; const dir = q.dir === 'asc' ? 1 : -1;
  const keyOf = { name: (c) => fold(c.name), last: (c) => c.lastAt || '', messages: (c) => c.messages, ordered: (c) => c.ordered || 0, owed: (c) => c.owed || 0, stage: (c) => c.stage }[sort];
  list.sort((a, b) => { const x = keyOf(a); const y = keyOf(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name); });
  const pageSize = Math.min(100, Math.max(5, Math.floor(Number(q.pageSize)) || 25));
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(q.page)) || 1));
  const slice = list.slice((page - 1) * pageSize, page * pageSize);
  // Dernier message : lu seulement pour la page affichée.
  const ids = slice.map((c) => c.lastId).filter(Boolean);
  const texts = new Map();
  if (ids.length) for (const m of await db.prepare(`SELECT id, role, content FROM chat_messages WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) texts.set(Number(m.id), m);
  const maxId = Number((await db.prepare('SELECT MAX(m.id) AS id FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE c.org_id = ?').get(req.org.id)).id) || 0;
  res.json({
    contacts: slice.map(({ _text, ...c }) => { const m = texts.get(c.lastId); return { ...c, lastText: m ? oneLine(m.content, 140) : '', lastRole: m ? m.role : '' }; }),
    total: list.length, page, pages, pageSize, counts, maxId,
  });
}));

/** Léger : sert à la mise à jour automatique du tableau (le tableau se recharge seulement si quelque chose a changé). */
router.get('/pulse', asyncHandler(async (req, res) => {
  const o = req.org.id;
  const maxId = Number((await db.prepare('SELECT MAX(m.id) AS id FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE c.org_id = ?').get(o)).id) || 0;
  const drafts = num((await db.prepare("SELECT COUNT(*) AS c FROM ai_drafts WHERE org_id = ? AND status = 'pending'").get(o)).c);
  const rules = num((await db.prepare('SELECT COUNT(*) AS c FROM ai_rules WHERE org_id = ?').get(o)).c);
  const lastLog = Number((await db.prepare('SELECT MAX(id) AS id FROM ai_rule_log WHERE org_id = ?').get(o)).id) || 0;
  const waiting = num((await db.prepare("SELECT COUNT(*) AS c FROM chats WHERE org_id = ? AND status = 'handoff'").get(o)).c);
  res.json({ maxId, drafts, rules, lastLog, waiting, stamp: `${maxId}:${drafts}:${rules}:${lastLog}:${waiting}` });
}));

// ---------- Cibles (une fiche client ou une conversation) ----------
async function targetOf(req, b) {
  const o = req.org.id;
  if (b.customerId !== undefined && b.customerId !== null && b.customerId !== '') {
    const id = A.id(b.customerId, 'Client invalide.');
    const cu = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(id, o);
    if (!cu || !A.visible(req, cu)) throw new HttpError(404, 'Client introuvable.');
    const ident = await R.identityOfCustomer(o, id);
    // Les conversations déjà liées à cette fiche (ou à son numéro) : leurs clés de session font aussi partie du contact.
    for (const ch of await db.prepare('SELECT session FROM chats WHERE org_id = ? AND customer_id = ?').all(o, id)) ident.keys.push(`s:${ch.session}`);
    return { ident, label: cu.name, customer: cu };
  }
  if (b.chatId !== undefined && b.chatId !== null && b.chatId !== '') {
    const chat = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(b.chatId, 'Conversation invalide.'), o);
    if (!chat) throw new HttpError(404, 'Conversation introuvable.');
    const ident = await R.identityOfChat(o, chat);
    if (ident.customerId) { const cu = await db.prepare('SELECT * FROM customers WHERE id = ?').get(ident.customerId); if (cu && !A.visible(req, cu)) throw new HttpError(404, 'Conversation introuvable.'); }
    return { ident, label: await R.labelOfChat({ ...chat, customer_id: ident.customerId || chat.customer_id }), chat };
  }
  throw new HttpError(400, 'Indiquez le client ou la conversation.');
}

router.get('/rules/current', asyncHandler(async (req, res) => {
  const t = await targetOf(req, req.query || {});
  const eff = await R.effectiveFor(req.org.id, t.ident);
  res.json({ rule: ruleSummary(eff), label: t.label });
}));

router.post('/rules', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const mode = A.oneOf(b.mode, ['full', 'partial'], undefined, 'Choisissez « Exclure » ou « Exclusion partielle ».');
  const duration = A.oneOf(b.duration, Object.keys(R.DURATIONS), 'none', 'Durée inconnue : 24 h, 7 jours ou sans limite.');
  const f = b.flags && typeof b.flags === 'object' ? b.flags : {};
  const flags = Object.fromEntries(R.FLAGS.map(([k]) => [k, Boolean(f[k])]));
  if (mode === 'partial' && !Object.values(flags).some(Boolean)) throw new HttpError(400, 'Cochez au moins une chose que l\'IA n\'a pas le droit de faire pour ce contact.');
  const t = await targetOf(req, b);
  const reason = A.text(b.reason, 300);
  const r = await R.setRule(req.org.id, t.ident, { mode, flags, duration, reason, label: t.label, userId: req.user.id });
  await A.logActivity(req.org.id, req.user.id, 'aifollow', mode === 'full' ? "IA exclue pour un contact" : "Exclusion partielle de l'IA pour un contact");
  res.status(201).json({ ok: true, key: r.key, expiresAt: r.expiresAt });
}));

router.post('/rules/lift', asyncHandler(async (req, res) => {
  const t = await targetOf(req, req.body || {});
  const n = await R.liftRule(req.org.id, t.ident, { userId: req.user.id, label: t.label });
  if (n) await A.logActivity(req.org.id, req.user.id, 'aifollow', "Règle de l'IA levée pour un contact");
  res.json({ ok: true, lifted: n });
}));

// ---------- Créer la fiche client d'un contact de messagerie ----------
router.post('/customers', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const o = req.org.id;
  const chat = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(A.id(b.chatId, 'Conversation invalide.'), o);
  if (!chat) throw new HttpError(404, 'Conversation introuvable.');
  const before = await R.identityOfChat(o, chat);
  if (before.customerId) throw new HttpError(409, 'Ce contact a déjà une fiche client.');
  const phone = chat.channel === 'whatsapp' ? R.digits(chat.contact) : '';
  const name = A.text(b.name, 100) || (phone ? `+${phone}` : 'Visiteur du site');
  const id = Number((await db.prepare("INSERT INTO customers (org_id, branch_id, name, phone, email, notes, stage, source, created_at) VALUES (?, ?, ?, ?, '', ?, 'prospect', ?, ?)")
    .run(o, req.member.branch_id || null, name, phone, 'Fiche créée depuis le Suivi de l\'IA', chat.channel === 'whatsapp' ? 'whatsapp' : 'site', nowISO())).lastInsertRowid);
  const p9 = R.phone9(phone);
  await db.prepare("UPDATE chats SET customer_id = ? WHERE org_id = ? AND customer_id IS NULL AND (id = ? OR (channel = 'whatsapp' AND ? <> '' AND right(regexp_replace(contact, '\\D', '', 'g'), 9) = ?))").run(id, o, chat.id, p9, p9);
  await R.rekey(o, { customerId: id, phone9: p9, session: chat.session, keys: [`c:${id}`, ...before.keys] });
  await A.logActivity(o, req.user.id, 'crm', `Client « ${name} » créé depuis une conversation`);
  require('../services/webhooks').emit(o, 'customer.created', { id, name });
  res.status(201).json({ id });
}));

// ---------- Journal ----------
router.get('/journal', asyncHandler(async (req, res) => {
  const pageSize = Math.min(100, Math.max(5, Math.floor(Number(req.query.pageSize)) || 25));
  const total = num((await db.prepare('SELECT COUNT(*) AS c FROM ai_rule_log WHERE org_id = ?').get(req.org.id)).c);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(req.query.page)) || 1));
  const rows = await db.prepare('SELECT l.*, u.name AS user_name FROM ai_rule_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? ORDER BY l.id DESC LIMIT ? OFFSET ?').all(req.org.id, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pages, pageSize, entries: rows.map((l) => { let info = {}; try { info = JSON.parse(l.detail) || {}; } catch { /* ancien texte libre */ } return { id: Number(l.id), at: l.created_at, action: l.action, label: l.label, user: l.user_name || null, detail: l.detail, info, expiresAt: l.expires_at || null }; }) });
}));

// ---------- Brouillons de réponse à valider ----------
const draftView = (d) => ({ id: Number(d.id), chatId: Number(d.chat_id), body: d.body, finalBody: d.final_body, status: d.status, at: d.created_at, decidedAt: d.decided_at || null, label: d.label || '', channel: d.channel || '', lastText: d.last_text ? oneLine(d.last_text, 160) : '' });
router.get('/drafts', asyncHandler(async (req, res) => {
  const st = A.oneOf(req.query.status, ['pending', 'all'], 'pending', 'Statut inconnu.');
  const rows = await db.prepare(`SELECT d.*, c.channel, c.contact, c.customer_id, cu.name AS cname,
      (SELECT content FROM chat_messages m WHERE m.chat_id = d.chat_id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS last_text
    FROM ai_drafts d JOIN chats c ON c.id = d.chat_id LEFT JOIN customers cu ON cu.id = c.customer_id WHERE d.org_id = ?${st === 'pending' ? " AND d.status = 'pending'" : ''} ORDER BY d.id DESC LIMIT 100`).all(req.org.id);
  res.json({ drafts: rows.map((d) => draftView({ ...d, label: d.cname || (d.contact ? `+${R.digits(d.contact)}` : 'Visiteur du site') })) });
}));

const draftOf = async (req) => {
  const d = await db.prepare('SELECT * FROM ai_drafts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Brouillon introuvable.');
  return d;
};
router.post('/drafts/:id/approve', asyncHandler(async (req, res) => {
  const d = await draftOf(req);
  if (d.status !== 'pending') throw new HttpError(409, 'Ce brouillon a déjà été traité.');
  const chat = await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(d.chat_id, req.org.id);
  if (!chat) throw new HttpError(404, 'Conversation introuvable.');
  const edited = (req.body || {}).text === undefined ? d.body : A.text(req.body.text, 1000, { required: true, msg: 'Le message ne peut pas être vide.' });
  if (chat.channel === 'web') throw new HttpError(400, "Une personne qui écrit depuis le site ne peut pas recevoir de message après coup. Refusez ce brouillon, ou contactez-la par téléphone si elle a laissé son numéro.");
  if (!channels.isConnected(req.org, chat.channel)) throw new HttpError(400, "Ce canal n'est pas connecté.");
  const last = await db.prepare("SELECT created_at FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chat.id);
  if (!last || Date.now() - Date.parse(last.created_at) > 24 * 3600000) throw new HttpError(400, "Plus de 24 h depuis le dernier message du client : l'écriture libre n'est plus possible. Refusez ce brouillon et attendez que la personne vous réécrive.");
  const claim = await db.prepare("UPDATE ai_drafts SET status = 'sending' WHERE id = ? AND status = 'pending'").run(d.id);
  if (!claim.changes) throw new HttpError(409, 'Ce brouillon a déjà été traité.');
  try { await channels.sendText(req.org, chat, edited); } catch (e) {
    await db.prepare("UPDATE ai_drafts SET status = 'pending' WHERE id = ?").run(d.id);
    throw new HttpError(502, "Le message n'a pas pu partir. Vérifiez la connexion dans les réglages.");
  }
  const was = edited !== d.body;
  await db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at, staff_id) VALUES (?, 'assistant', ?, ?, ?)").run(chat.id, edited, nowISO(), req.user.id);
  await db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(nowISO(), chat.id);
  await db.prepare('UPDATE ai_drafts SET status = ?, final_body = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(was ? 'edited' : 'approved', edited, req.user.id, nowISO(), d.id);
  const label = await R.labelOfChat(chat);
  await R.addLog(req.org.id, { label, userId: req.user.id, action: was ? 'draft_edited' : 'draft_approved', detail: JSON.stringify({}) });
  await A.logActivity(req.org.id, req.user.id, 'aifollow', `Réponse de l'IA ${was ? 'modifiée puis ' : ''}validée`);
  res.json({ ok: true, edited: was });
}));
router.post('/drafts/:id/reject', asyncHandler(async (req, res) => {
  const d = await draftOf(req);
  const r = await db.prepare("UPDATE ai_drafts SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(req.user.id, nowISO(), d.id);
  if (!r.changes) throw new HttpError(409, 'Ce brouillon a déjà été traité.');
  const chat = await db.prepare('SELECT * FROM chats WHERE id = ?').get(d.chat_id);
  await R.addLog(req.org.id, { label: chat ? await R.labelOfChat(chat) : '', userId: req.user.id, action: 'draft_rejected', detail: JSON.stringify({ note: A.text((req.body || {}).note, 200) }) });
  await A.logActivity(req.org.id, req.user.id, 'aifollow', "Réponse de l'IA refusée");
  res.json({ ok: true });
}));

module.exports = { router, thread, buildContacts, ruleSummary };
