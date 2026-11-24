'use strict';
// Chat interne : rattachement à N'IMPORTE QUEL module (type d'objet + identifiant) et registre extensible.
//  - « Discuter » : un fil de discussion par objet (conversation de groupe rattachée à l'objet) ;
//  - cartes d'objets dans les messages : aperçu résolu AU MOMENT DE LA LECTURE, pour CHAQUE lecteur, selon SES droits dans le module d'origine
//    (un objet qu'on n'a pas le droit de voir ne montre ni titre ni détail : « objet non accessible ») ;
//  - un fil d'objet n'est lisible que par les personnes qui ont encore le droit de voir l'objet ;
//  - événements des modules (ordre du jour, décisions, PV, tâches d'une réunion…) publiés comme messages système dans le fil.
// POUR BRANCHER UN NOUVEAU MODULE, sans toucher au chat :  require('./chat-objects').register('mon_type', { label, icon, module, min, resolve, search, suggest })
//   resolve(req, id)  -> { title, subtitle } ou null (introuvable OU pas le droit) ; req = { org, user, member } de la PERSONNE qui regarde ;
//   search(req, q)    -> [{ id, title, subtitle }] déjà filtré selon les droits (facultatif : sinon pas de recherche dans le sélecteur) ;
//   suggest(req, id)  -> [userId] personnes à inviter d'office dans le fil (facultatif).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const hub = require('./chat-hub');
const L = require('./chat-lib');
const { HttpError, oneLine } = require('../util');

const REG = new Map();
function register(type, def) {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(type)) throw new Error('Type d\'objet invalide');
  REG.set(type, { type, label: def.label, icon: def.icon || 'layer-group', module: def.module, min: def.min || 'member', resolve: def.resolve, search: def.search, suggest: def.suggest });
}
const types = () => [...REG.values()];

/** « req » d'une autre personne (pour vérifier SES droits) : null si elle n'est pas membre de l'entreprise. */
async function reqFor(org, userId) {
  const member = await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(org.id, userId);
  const user = member && await db.prepare('SELECT id, name, totp_enabled FROM users WHERE id = ?').get(userId);
  return member && user ? { org, user, member } : null;
}
const likeOf = (q) => '%' + String(q).replace(/[\\%_]/g, '\\$&') + '%';

/** Résolution protégée : jamais d'exception vers l'appelant ; null = pas d'accès (ou introuvable). */
async function resolve(req, type, id) {
  const d = REG.get(type);
  if (!d || !Number.isInteger(Number(id)) || Number(id) < 1) return null;
  if (A.RANK[req.member.role] < A.RANK[d.min]) return null;
  try { const r = await d.resolve(req, Number(id)); return r ? { title: oneLine(String(r.title || ''), 160), subtitle: oneLine(String(r.subtitle || ''), 160) } : null; } catch { return null; }
}
const canView = async (org, userId, type, id) => { const r = await reqFor(org, userId); return Boolean(r && await resolve(r, type, id)); };
const open = (d, orgId, id) => `/app/${orgId}/${d.module}?open=${d.type}:${id}`;

/** Vue d'une carte pour UN lecteur donné. */
async function cardFor(org, userId, type, id) {
  const d = REG.get(type);
  if (!d) return { type, id, accessible: false, label: '', icon: 'layer-group' };
  const r = await reqFor(org, userId);
  const info = r && await resolve(r, type, id);
  return info ? { type, id, accessible: true, label: d.label, icon: d.icon, module: d.module, title: info.title, subtitle: info.subtitle, path: open(d, org.id, id) } : { type, id, accessible: false, label: d.label, icon: d.icon };
}

// ---------- Objets des modules existants (droits identiques à ceux des modules ; prudents quand les droits du module sont plus fins) ----------
const row = (table, cols) => async (req, id) => db.prepare(`SELECT ${cols} FROM ${table} WHERE id = ? AND org_id = ?`).get(id, req.org.id);
const scoped = (req, r) => r && A.visible(req, r); // filtre par antenne, comme les modules
const simple = (type, label, icon, module, min, table, titleCol, subCol, extra = '') => register(type, {
  label, icon, module, min,
  resolve: async (req, id) => { const r = await row(table, `*`)(req, id); return scoped(req, r) ? { title: String(r[titleCol] || ''), subtitle: subCol ? String(r[subCol] || '') : '' } : null; },
  search: async (req, q) => {
    const sc = A.scope(req);
    return (await db.prepare(`SELECT id, ${titleCol} AS t${subCol ? `, ${subCol} AS s` : ''} FROM ${table} WHERE org_id = ?${table === 'suppliers' || table.startsWith('pur_') ? '' : sc.sql} AND ${titleCol} ILIKE ? ESCAPE '\\' ${extra} ORDER BY id DESC LIMIT 15`).all(req.org.id, ...(table === 'suppliers' || table.startsWith('pur_') ? [] : sc.args), likeOf(q))).map((r) => ({ id: Number(r.id), title: r.t, subtitle: r.s || '' }));
  },
});
simple('task', 'Tâche', 'list-check', 'projects', 'member', 'tasks', 'title', 'status');
simple('project', 'Projet', 'diagram-project', 'projects', 'member', 'projects', 'name', 'status');
simple('customer', 'Client', 'address-book', 'crm', 'member', 'customers', 'name', null);
simple('stock_item', 'Article en stock', 'boxes-stacked', 'stock', 'member', 'stock_items', 'name', null);
simple('ticket', 'Demande client', 'headset', 'support', 'member', 'tickets', 'subject', 'status');
simple('sales_document', 'Devis / facture', 'file-invoice-dollar', 'crm', 'member', 'documents', 'number', 'status');
simple('employee', 'Employé', 'users', 'hr', 'manager', 'employees', 'name', 'job');
simple('supplier', 'Fournisseur', 'truck', 'purchasing', 'manager', 'suppliers', 'name', null);
simple('pur_order', "Bon de commande", 'cart-shopping', 'purchasing', 'manager', 'pur_orders', 'number', 'status');
simple('pur_invoice', "Facture d'achat", 'file-invoice-dollar', 'purchasing', 'manager', 'pur_invoices', 'number', 'status');
// Réunions : mêmes règles de visibilité que le module (réunions confidentielles).
register('meeting', {
  label: 'Réunion', icon: 'calendar-check', module: 'meetings',
  resolve: async (req, id) => { const M = require('./meetings-lib'); const { m } = await M.load(req, id); return { title: m.title, subtitle: `${m.date} · ${m.start_time}` }; },
  search: async (req, q) => { const M = require('./meetings-lib'); const vis = M.visibleSql(req, await M.getConfig(req.org.id)); return (await db.prepare(`SELECT m.id, m.title, m.date FROM mtg_meetings m WHERE m.org_id = ?${vis.sql} AND m.title ILIKE ? ESCAPE '\\' ORDER BY m.date DESC LIMIT 15`).all(req.org.id, ...vis.args, likeOf(q))).map((r) => ({ id: Number(r.id), title: r.title, subtitle: r.date })); },
  suggest: async (req, id) => (await db.prepare('SELECT user_id FROM mtg_participants WHERE meeting_id = ? AND user_id IS NOT NULL').all(id)).map((r) => Number(r.user_id)),
});
// Bibliothèque : même contrôle que les pièces jointes des Réunions (accès au bloc, document non supprimé). Rien n'est dupliqué : la carte renvoie au document.
register('library_doc', {
  label: 'Document de la Bibliothèque', icon: 'book-open', module: 'library',
  resolve: async (req, id) => {
    const d = await db.prepare('SELECT id, name, block_id, size, mime FROM lib_docs WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(id, req.org.id);
    if (!d) return null;
    await require('./library-core').blockFor(req, d.block_id); // lève si pas de droit sur le bloc
    return { title: d.name, subtitle: `${Math.max(1, Math.round(Number(d.size) / 1024))} Ko` };
  },
  search: async (req, q) => {
    const C = require('./library-core');
    const rows = await db.prepare("SELECT id, name, block_id, size FROM lib_docs WHERE org_id = ? AND deleted_at IS NULL AND name ILIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 40").all(req.org.id, likeOf(q));
    const out = [];
    for (const d of rows) { try { await C.blockFor(req, d.block_id); out.push({ id: Number(d.id), title: d.name, subtitle: `${Math.max(1, Math.round(Number(d.size) / 1024))} Ko` }); } catch { /* pas de droit : absent */ } if (out.length >= 15) break; }
    return out;
  },
});

// ---------- Routes ----------
const router = express.Router({ mergeParams: true });
const limit = L.userLimit('objects', 60 * 1000, 120);

router.get('/types', (req, res) => res.json({ types: types().filter((d) => A.RANK[req.member.role] >= A.RANK[d.min]).map((d) => ({ type: d.type, label: d.label, icon: d.icon, module: d.module, searchable: Boolean(d.search) })) }));
router.get('/search', limit, async (req, res) => {
  const d = REG.get(String(req.query.type || ''));
  if (!d || A.RANK[req.member.role] < A.RANK[d.min] || !d.search) throw new HttpError(400, "Ce type d'objet ne peut pas être recherché.");
  const q = String(req.query.q || '').slice(0, 60);
  res.json({ results: q.length < 1 ? [] : await d.search(req, q) });
});
router.get('/:type/:id', limit, async (req, res) => {
  const c = await cardFor(req.org, req.user.id, req.params.type, A.id(req.params.id));
  if (!c.accessible) throw new HttpError(404, 'Objet introuvable.');
  res.json({ object: c });
});

/** Fil de discussion de l'objet : le crée au besoin, y ajoute la personne (qui doit avoir le droit de voir l'objet). */
async function threadFor(req, type, id, { invite = [] } = {}) {
  const d = REG.get(type);
  const info = d && await resolve(req, type, id);
  if (!info) throw new HttpError(404, 'Objet introuvable.');
  const now = nowISO();
  let c = await db.prepare('SELECT * FROM ci_conversations WHERE org_id = ? AND object_type = ? AND object_id = ?').get(req.org.id, type, id);
  if (!c) {
    try {
      const cid = Number((await db.prepare("INSERT INTO ci_conversations (org_id, kind, purpose, name, object_type, object_id, created_by, created_at, last_at) VALUES (?, 'group', 'object', ?, ?, ?, ?, ?, ?)").run(req.org.id, info.title.slice(0, 80), type, id, req.user.id, now, now)).lastInsertRowid);
      await db.prepare("INSERT INTO ci_members (org_id, conv_id, user_id, role, joined_at) VALUES (?, ?, ?, 'admin', ?)").run(req.org.id, cid, req.user.id, now);
      c = { id: cid };
    } catch { c = await db.prepare('SELECT * FROM ci_conversations WHERE org_id = ? AND object_type = ? AND object_id = ?').get(req.org.id, type, id); }
  }
  const add = async (uid) => {
    const m = await db.prepare('SELECT id, left_at FROM ci_members WHERE conv_id = ? AND user_id = ?').get(c.id, uid);
    if (!m) await db.prepare("INSERT INTO ci_members (org_id, conv_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)").run(req.org.id, c.id, uid, now);
    else if (m.left_at) await db.prepare('UPDATE ci_members SET left_at = NULL WHERE id = ?').run(m.id);
  };
  await add(req.user.id);
  const wanted = [...new Set([...invite, ...(d.suggest ? await d.suggest(req, id).catch(() => []) : [])])].filter((u) => u !== req.user.id);
  for (const u of wanted) if (await canView(req.org, u, type, id)) await add(u); // jamais quelqu'un qui n'a pas le droit de voir l'objet
  hub.publish(req.org.id, wanted, 'conversation', { convId: Number(c.id) });
  return Number(c.id);
}
router.post('/:type/:id/thread', limit, async (req, res) => {
  const invite = (Array.isArray((req.body || {}).invite) ? req.body.invite : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  const cid = await threadFor(req, req.params.type, A.id(req.params.id), { invite });
  res.json({ conversation: await L.convSummary(req, await L.loadConv(req, cid)) });
});

/** Partager la carte d'un objet dans une conversation (l'expéditeur doit voir l'objet ; chaque lecteur est contrôlé séparément). */
router.post('/share', limit, async (req, res) => {
  const b = req.body || {};
  const conv = await L.loadConv(req, b.convId);
  L.needPlain(conv, "Le partage d'un objet");
  const type = String(b.type || ''); const id = A.id(b.id, 'Objet introuvable.');
  if (!await resolve(req, type, id)) throw new HttpError(404, 'Objet introuvable.');
  const view = await L.postMessage(req, conv, { kind: 'object', body: '', meta: { type, id }, noMentions: true });
  res.status(201).json({ message: view });
});

// ---------- Événements des modules → messages système dans le fil ----------
/** À appeler par un module : poste un message système dans le fil de l'objet, s'il existe. Ne lève jamais d'erreur. */
async function notify(org, type, id, event, data = {}, actor = null) {
  try {
    const c = await db.prepare('SELECT * FROM ci_conversations WHERE org_id = ? AND object_type = ? AND object_id = ?').get(org.id, type, id);
    if (!c) return;
    const req = { org, user: actor || { id: 0, name: '' }, member: null };
    await L.postMessage(req, c, { kind: 'system', senderId: null, body: '', meta: { event: `obj_${event}`, ...data }, noMentions: true });
  } catch { /* le module d'origine ne doit jamais échouer à cause du chat */ }
}
/** Crée le fil d'une réunion et y invite les participants (appelé à la convocation). */
async function ensureMeetingThread(req, meetingId, extra = {}) {
  try {
    const cid = await threadFor(req, 'meeting', meetingId);
    const c = await db.prepare('SELECT * FROM ci_conversations WHERE id = ?').get(cid);
    const empty = Number((await db.prepare("SELECT COUNT(*) c FROM ci_messages WHERE conv_id = ? AND kind = 'system'").get(cid)).c) === 0;
    if (empty) await L.postMessage(req, c, { kind: 'system', senderId: null, body: '', meta: { event: 'obj_meeting_convened', title: extra.title || '', date: extra.date || '', time: extra.time || '', place: extra.place || '', agenda: (extra.agenda || []).slice(0, 12) }, noMentions: true });
    return cid;
  } catch { return null; }
}

/** Retire des fils d'objets les personnes qui n'ont plus le droit de voir l'objet (listes, recherche, fichiers : tout passe par les participations actives). */
const pruned = new Map();
async function prune(req, force = false) {
  const k = `${req.org.id}:${req.user.id}`;
  if (!force && Date.now() - (pruned.get(k) || 0) < (process.env.CHAT_PRUNE_MS === undefined ? 20000 : Number(process.env.CHAT_PRUNE_MS))) return;
  pruned.set(k, Date.now());
  const rows = await db.prepare("SELECT c.id, c.object_type, c.object_id FROM ci_conversations c JOIN ci_members m ON m.conv_id = c.id AND m.user_id = ? AND m.left_at IS NULL WHERE c.org_id = ? AND c.object_type IS NOT NULL").all(req.user.id, req.org.id);
  for (const c of rows) if (!await resolve(req, c.object_type, Number(c.object_id))) await db.prepare('UPDATE ci_members SET left_at = ? WHERE conv_id = ? AND user_id = ?').run(nowISO(), c.id, req.user.id);
}
const _resetPrune = () => pruned.clear();

/** Événements du journal des Réunions → messages système dans le fil (ordre du jour, décisions, actions, compte rendu). */
async function meetingEvent(org, meetingId, action, detail, user) {
  const c = await db.prepare("SELECT id FROM ci_conversations WHERE org_id = ? AND object_type = 'meeting' AND object_id = ?").get(org.id, meetingId);
  if (!c) return;
  let data = { text: oneLine(detail || '', 200) };
  if (action === 'agenda') data.items = (await db.prepare('SELECT title FROM mtg_agenda WHERE meeting_id = ? ORDER BY position, id LIMIT 12').all(meetingId)).map((r) => r.title);
  else if (action === 'decision') data.items = (await db.prepare('SELECT text FROM mtg_decisions WHERE meeting_id = ? ORDER BY id DESC LIMIT 5').all(meetingId)).map((r) => oneLine(r.text, 160)).reverse();
  else if (action === 'action') data.items = (await db.prepare('SELECT text, assignee_name, due FROM mtg_actions WHERE meeting_id = ? ORDER BY id DESC LIMIT 5').all(meetingId)).map((r) => `${oneLine(r.text, 140)}${r.assignee_name ? ` — ${r.assignee_name}` : ''}${r.due ? ` (${r.due})` : ''}`).reverse();
  else if (!['submitted', 'validated', 'returned'].includes(action)) return;
  await notify(org, 'meeting', meetingId, `meeting_${action}`, { ...data, actorName: user ? user.name : '' }, user);
}

module.exports = { prune, _resetPrune, meetingEvent, router, register, types, resolve, canView, cardFor, reqFor, threadFor, notify, ensureMeetingThread };
