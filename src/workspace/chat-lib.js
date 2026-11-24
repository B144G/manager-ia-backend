'use strict';
// Chat interne : socle commun (droits d'accès aux conversations, vues des messages, envoi, limites de débit, réglages de l'entreprise).
// RÈGLE CENTRALE : une conversation n'est lisible que par ses participants actifs. Aucun rôle (même propriétaire ou administrateur de
// l'entreprise) ne donne accès aux messages d'une conversation dont on ne fait pas partie : toutes les lectures passent par loadConv().
const { db, nowISO } = require('../db');
const A = require('./access');
const hub = require('./chat-hub');
const brand = require('./chat-brand');
const { HttpError, cleanText, oneLine, log } = require('../util');

const MAX_BODY = 4000;
const KINDS = ['text', 'voice', 'file', 'location', 'poll', 'system', 'call', 'ai', 'meeting'];
const FILE_KINDS = ['image', 'pdf', 'word', 'excel', 'presentation', 'video', 'audio', 'text'];
const HARD_MAX_FILE_MB = Math.max(1, Math.min(parseInt(process.env.CHAT_HARD_MAX_FILE_MB, 10) || 25, 100));
const num = (v) => (v === null || v === undefined ? null : Number(v));

// ---------- Limites de débit par personne (en mémoire : un seul processus) ----------
const buckets = new Map();
/** Prend un jeton dans la fenêtre (false si la limite est atteinte). */
function allow(k, windowMs, max) {
  const now = Date.now();
  const arr = (buckets.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(k, arr); return false; }
  arr.push(now); buckets.set(k, arr);
  return true;
}
function userLimit(name, windowMs, max, msg) {
  return (req, res, next) => (allow(`${name}:${req.org ? req.org.id : 0}:${req.user.id}`, windowMs, max) ? next() : next(new HttpError(429, msg || 'Vous allez trop vite. Patientez un instant.')));
}
setInterval(() => { const now = Date.now(); for (const [k, a] of buckets) { const f = a.filter((t) => now - t < 3600000); if (f.length) buckets.set(k, f); else buckets.delete(k); } }, 5 * 60 * 1000).unref();
const _resetLimits = () => buckets.clear();

// ---------- Réglages de l'entreprise ----------
async function getSettings(orgId) {
  const r = await db.prepare('SELECT * FROM ci_settings WHERE org_id = ?').get(orgId);
  let kinds = FILE_KINDS;
  if (r) { try { const k = JSON.parse(r.allowed_kinds); if (Array.isArray(k)) kinds = k.filter((x) => FILE_KINDS.includes(x)); } catch { /* valeurs par défaut */ } }
  return {
    maxFileMb: Math.min(r ? Number(r.max_file_mb) : 8, HARD_MAX_FILE_MB), allowedKinds: kinds,
    aiEnabled: r ? Number(r.ai_enabled) === 1 : true, callsEnabled: r ? Number(r.calls_enabled) === 1 : true,
    groupsBy: r ? r.groups_by : 'all', // qui peut créer des groupes : 'all' (tous) ou 'manager' (responsables et plus)
  };
}
async function getPrefs(orgId, userId) {
  const r = await db.prepare('SELECT * FROM ci_prefs WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  return { readReceipts: r ? Number(r.read_receipts) === 1 : true, showPresence: r ? Number(r.show_presence) === 1 : true };
}

// ---------- Accès aux conversations ----------
/** La conversation, si la personne en est participante ACTIVE (sinon 404 : on ne révèle pas son existence). */
async function loadConv(req, id) {
  const cid = A.id(id, 'Conversation introuvable.');
  const c = await db.prepare(`SELECT c.*, m.role AS my_role, m.from_id AS my_from, m.last_read_id AS my_read, m.muted AS my_muted, m.archived AS my_archived
    FROM ci_conversations c JOIN ci_members m ON m.conv_id = c.id AND m.user_id = ? AND m.left_at IS NULL
    WHERE c.id = ? AND c.org_id = ?`).get(req.user.id, cid, req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  return c;
}
const isGroupAdmin = (c) => c.kind === 'group' && c.my_role === 'admin';
/** Participants actifs (encore membres de l'entreprise). */
async function members(convId, orgId) {
  return db.prepare(`SELECT m.user_id, m.role, m.from_id, m.last_read_id, m.last_delivered_id, m.joined_at, u.name, om.title, om.role AS org_role,
      COALESCE(p.read_receipts, 1) AS read_receipts, COALESCE(p.show_presence, 1) AS show_presence
    FROM ci_members m JOIN users u ON u.id = m.user_id JOIN org_members om ON om.user_id = m.user_id AND om.org_id = ?
    LEFT JOIN ci_prefs p ON p.org_id = ? AND p.user_id = m.user_id
    WHERE m.conv_id = ? AND m.left_at IS NULL ORDER BY u.name`).all(orgId, orgId, convId);
}
const directKey = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;

// ---------- Vues des messages ----------
const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const snippet = (m) => (m.deleted_at ? '' : m.kind === 'voice' ? '🎤' : m.kind === 'file' ? `📎 ${oneLine(m.body, 60)}` : oneLine(m.body, 90));

/** Transforme des lignes ci_messages en objets pour l'interface (réponses citées, fichiers, sondages, accusés). */
async function views(req, conv, rows, memberList) {
  if (!rows.length) return [];
  const mem = memberList || await members(conv.id, req.org.id);
  const ids = rows.map((r) => Number(r.id));
  const ph = (a) => a.map(() => '?').join(',');
  const userIds = [...new Set(rows.map((r) => num(r.sender_id)).filter(Boolean))];
  const names = new Map(mem.map((m) => [Number(m.user_id), m.name]));
  const missing = userIds.filter((u) => !names.has(u));
  if (missing.length) for (const u of await db.prepare(`SELECT id, name FROM users WHERE id IN (${ph(missing)})`).all(...missing)) names.set(Number(u.id), u.name);
  const replyIds = [...new Set(rows.map((r) => num(r.reply_to_id)).filter(Boolean))];
  const replies = new Map();
  if (replyIds.length) for (const r of await db.prepare(`SELECT id, sender_id, kind, body, deleted_at, visible_to FROM ci_messages WHERE conv_id = ? AND id IN (${ph(replyIds)})`).all(conv.id, ...replyIds)) {
    if (r.visible_to != null && Number(r.visible_to) !== req.user.id) continue; // réponse privée d'une autre personne : jamais citée
    replies.set(Number(r.id), { id: Number(r.id), senderId: num(r.sender_id), senderName: r.sender_id ? names.get(Number(r.sender_id)) || '' : brand.AI_NAME, snippet: snippet(r), deleted: Boolean(r.deleted_at) });
  }
  const fileIds = rows.map((r) => num(r.file_id)).filter(Boolean);
  const files = new Map();
  if (fileIds.length) for (const f of await db.prepare(`SELECT id, name, mime, category, size, duration_ms, folder, deleted_at FROM ci_files WHERE conv_id = ? AND id IN (${ph(fileIds)})`).all(conv.id, ...fileIds)) files.set(Number(f.id), { id: Number(f.id), name: f.name, mime: f.mime, category: f.category, size: Number(f.size), durationMs: Number(f.duration_ms), folder: f.folder, removed: Boolean(f.deleted_at) });
  const pollMsgs = rows.filter((r) => r.kind === 'poll').map((r) => Number(r.id));
  const polls = new Map();
  if (pollMsgs.length) {
    for (const p of await db.prepare(`SELECT * FROM ci_polls WHERE conv_id = ? AND message_id IN (${ph(pollMsgs)})`).all(conv.id, ...pollMsgs)) {
      const opts = await db.prepare('SELECT id, label FROM ci_poll_options WHERE poll_id = ? ORDER BY position, id').all(p.id);
      const votes = await db.prepare('SELECT option_id, user_id FROM ci_poll_votes WHERE poll_id = ?').all(p.id);
      polls.set(Number(p.message_id), {
        id: Number(p.id), question: p.question, multiple: Number(p.multiple) === 1, anonymous: Number(p.anonymous) === 1, closed: Boolean(p.closed_at),
        options: opts.map((o) => { const v = votes.filter((x) => Number(x.option_id) === Number(o.id)); return { id: Number(o.id), label: o.label, votes: v.length, mine: v.some((x) => Number(x.user_id) === req.user.id), voters: Number(p.anonymous) === 1 ? undefined : v.map((x) => names.get(Number(x.user_id)) || '') }; }),
        total: new Set(votes.map((v) => Number(v.user_id))).size,
      });
    }
  }
  const pinned = new Set((await db.prepare(`SELECT message_id FROM ci_pins WHERE conv_id = ? AND message_id IN (${ph(ids)})`).all(conv.id, ...ids)).map((r) => Number(r.message_id)));
  const tasks = new Map();
  for (const t of await db.prepare(`SELECT mt.message_id, mt.task_id, t.title FROM ci_msg_tasks mt JOIN tasks t ON t.id = mt.task_id WHERE t.org_id = ? AND mt.message_id IN (${ph(ids)})`).all(req.org.id, ...ids)) tasks.set(Number(t.message_id), { id: Number(t.task_id), title: t.title });
  const mine = (r) => num(r.sender_id) === req.user.id;
  const others = (r) => mem.filter((m) => Number(m.user_id) !== num(r.sender_id));
  return rows.map((r) => {
    const del = Boolean(r.deleted_at);
    const v = {
      id: Number(r.id), convId: Number(r.conv_id), senderId: num(r.sender_id), senderName: r.sender_id ? names.get(Number(r.sender_id)) || '' : (r.kind === 'ai' ? brand.AI_NAME : ''),
      kind: r.kind, body: del ? '' : r.body, meta: del ? {} : parseJSON(r.meta, {}), createdAt: r.created_at, editedAt: r.edited_at || null, deleted: del,
      urgent: Number(r.urgent) === 1, mentions: del ? [] : parseJSON(r.mentions, []), mentionAll: Number(r.mention_all) === 1, mine: mine(r),
      replyTo: r.reply_to_id ? replies.get(Number(r.reply_to_id)) || { id: Number(r.reply_to_id), senderName: '', snippet: '', deleted: true } : null,
      file: !del && r.file_id ? files.get(Number(r.file_id)) || null : null, poll: !del && polls.get(Number(r.id)) || null, pinned: pinned.has(Number(r.id)), task: tasks.get(Number(r.id)) || null,
      privateToMe: r.visible_to != null, // note de l'assistante visible par vous seul
    };
    if (mine(r) && !del && r.kind !== 'system') {
      const o = others(r);
      v.delivered = o.length > 0 && o.every((m) => Number(m.last_delivered_id) >= Number(r.id) || Number(m.last_read_id) >= Number(r.id));
      v.readBy = o.filter((m) => Number(m.read_receipts) === 1 && Number(m.last_read_id) >= Number(r.id)).map((m) => ({ userId: Number(m.user_id), name: m.name }));
      v.read = o.length > 0 && o.every((m) => Number(m.read_receipts) === 1 && Number(m.last_read_id) >= Number(r.id));
    }
    return v;
  });
}
/** Filtre SQL : seulement ce que cette personne a le droit de voir dans la conversation. */
const visibleSql = (conv, userId) => ({ sql: ' AND m.id > ? AND (m.visible_to IS NULL OR m.visible_to = ?)', args: [Number(conv.my_from) || 0, userId] });

// ---------- Mentions ----------
function detectMentions(body, memberList, selfId, isGroup) {
  const low = body.toLowerCase();
  const ids = [];
  const sorted = [...memberList].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    if (Number(m.user_id) === selfId) continue;
    const needle = '@' + m.name.toLowerCase();
    let from = 0;
    for (;;) {
      const i = low.indexOf(needle, from);
      if (i < 0) break;
      const after = low[i + needle.length];
      if ((i === 0 || /[\s([{>,;:!?'"«]/.test(low[i - 1])) && (!after || !/[\p{L}\p{N}_]/u.test(after))) { ids.push(Number(m.user_id)); break; }
      from = i + 1;
    }
  }
  const all = isGroup && /(^|[\s([{>,;:!?'"«])@(tous|all|everyone)(?![\p{L}\p{N}_])/iu.test(body);
  return { ids: [...new Set(ids)], all };
}

// ---------- Envoi ----------
/** Insère un message, met à jour la conversation, prévient les participants en temps réel. Renvoie la vue du message pour l'expéditeur. */
async function postMessage(req, conv, o) {
  const orgId = req.org.id;
  const sender = o.senderId === undefined ? req.user.id : o.senderId; // null = assistante
  const mem = o.members || await members(conv.id, orgId);
  const body = o.rawBody ? String(o.rawBody).slice(0, MAX_BODY) : cleanText(o.body, MAX_BODY);
  const men = o.noMentions ? { ids: [], all: false } : detectMentions(body, mem, sender, conv.kind === 'group');
  const now = o.at || nowISO();
  const id = Number((await db.prepare(`INSERT INTO ci_messages (org_id, conv_id, sender_id, kind, body, meta, reply_to_id, file_id, urgent, mentions, mention_all, visible_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(orgId, conv.id, sender, o.kind || 'text', body, JSON.stringify(o.meta || {}), o.replyToId || null, o.fileId || null, o.urgent ? 1 : 0, JSON.stringify(men.ids), men.all ? 1 : 0, o.visibleTo || null, now)).lastInsertRowid);
  if (o.fileId) await db.prepare('UPDATE ci_files SET message_id = ? WHERE id = ? AND org_id = ?').run(id, o.fileId, orgId);
  if (!o.visibleTo) await db.prepare('UPDATE ci_conversations SET last_message_id = ?, last_at = ? WHERE id = ?').run(id, now, conv.id);
  if (sender) await db.prepare('UPDATE ci_members SET last_read_id = ?, last_delivered_id = ? WHERE conv_id = ? AND user_id = ? AND last_read_id < ?').run(id, id, conv.id, sender, id);
  const row = await db.prepare('SELECT * FROM ci_messages WHERE id = ?').get(id);
  const targets = mem.filter((m) => (!o.visibleTo || Number(m.user_id) === o.visibleTo)).map((m) => Number(m.user_id));
  hub.setTyping(orgId, conv.id, sender || 0, null);
  // Remise : les personnes en ligne reçoivent le message tout de suite, donc « distribué ».
  const online = targets.filter((u) => u !== sender && hub.isOnline(orgId, u));
  if (online.length) await db.prepare(`UPDATE ci_members SET last_delivered_id = ? WHERE conv_id = ? AND user_id IN (${online.map(() => '?').join(',')}) AND last_delivered_id < ?`).run(id, conv.id, ...online, id);
  const fresh = o.members ? mem : await members(conv.id, orgId);
  const [view] = await views({ ...req, user: { id: sender || 0 } }, conv, [row], fresh);
  for (const u of targets) {
    const mineView = u === sender ? view : { ...view, mine: false, delivered: undefined, read: undefined, readBy: undefined };
    hub.publish(orgId, [u], 'message', { convId: Number(conv.id), message: mineView, unreadFor: u !== sender });
  }
  if (online.length && sender) hub.publish(orgId, [sender], 'receipt', { convId: Number(conv.id), userIds: online, kind: 'delivered', upTo: id });
  // Alertes hors ligne : message urgent ou mention — jamais le contenu du message dans la notification.
  if (sender && (o.urgent || men.ids.length || men.all)) {
    const W = require('./w3');
    for (const m of mem) {
      const u = Number(m.user_id);
      if (u === sender || hub.isOnline(orgId, u) || (o.visibleTo && o.visibleTo !== u)) continue;
      if (o.urgent || men.all || men.ids.includes(u)) {
        const who = (mem.find((x) => Number(x.user_id) === sender) || {}).name || '';
        W.push(orgId, u, 'chat', o.urgent ? `Message urgent de ${who} dans le chat.` : `${who} vous a mentionné dans le chat.`, `chat:${conv.id}`).catch(() => {});
      }
    }
  }
  return view;
}

/** Rend le nom affichable d'une conversation pour une personne (pour un échange à deux : le nom de l'autre). */
async function convSummary(req, c, memberList, withLast = true) {
  const mem = memberList || await members(c.id, req.org.id);
  const other = c.kind === 'direct' ? mem.find((m) => Number(m.user_id) !== req.user.id) || mem[0] : null;
  const myFrom = Number(c.my_from) || 0;
  const unread = Number((await db.prepare(`SELECT COUNT(*) c FROM ci_messages m WHERE m.conv_id = ? AND m.id > ? AND m.id > ? AND m.deleted_at IS NULL AND (m.sender_id IS NULL OR m.sender_id <> ?) AND m.visible_to IS NULL AND ? > 0 AND m.kind NOT IN ('system', 'call')`).get(c.id, Number(c.my_read) || 0, myFrom, req.user.id, req.user.id)).c);
  const mentioned = unread ? Number((await db.prepare(`SELECT COUNT(*) c FROM ci_messages m WHERE m.conv_id = ? AND m.id > ? AND m.id > ? AND m.deleted_at IS NULL AND (m.sender_id IS NULL OR m.sender_id <> ?) AND m.visible_to IS NULL AND ? > 0 AND (m.mention_all = 1 OR m.urgent = 1 OR m.mentions LIKE ?)`).get(c.id, Number(c.my_read) || 0, myFrom, req.user.id, req.user.id, `%${req.user.id}%`)).c) : 0;
  let last = null;
  if (withLast) {
    const lr = await db.prepare(`SELECT m.* FROM ci_messages m WHERE m.conv_id = ? AND m.id > ? AND (m.visible_to IS NULL OR m.visible_to = ?) ORDER BY m.id DESC LIMIT 1`).get(c.id, myFrom, req.user.id);
    if (lr) last = { id: Number(lr.id), kind: lr.kind, senderId: num(lr.sender_id), senderName: lr.sender_id ? ((mem.find((m) => Number(m.user_id) === Number(lr.sender_id)) || {}).name || '') : (lr.kind === 'ai' ? brand.AI_NAME : ''), text: lr.deleted_at ? '' : oneLine(lr.body, 120), deleted: Boolean(lr.deleted_at), at: lr.created_at, urgent: Number(lr.urgent) === 1 };
  }
  return {
    id: Number(c.id), kind: c.kind, purpose: c.purpose, name: c.kind === 'direct' ? (other ? other.name : '') : c.name, description: c.description, department: c.department, projectId: num(c.project_id),
    otherUserId: other ? Number(other.user_id) : null, aiEnabled: Number(c.ai_enabled) === 1, onlyAdminsPost: Number(c.only_admins_post) === 1, myRole: c.my_role, muted: Number(c.my_muted) === 1, archived: Number(c.my_archived) === 1,
    memberCount: mem.length, unread, mentioned, last, lastAt: c.last_at, createdAt: c.created_at,
  };
}

/** Marque comme lu jusqu'à `upTo` (ou la fin) ; prévient les autres si les accusés de lecture sont activés. */
async function markRead(req, conv, upTo) {
  const max = upTo || Number((await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ci_messages WHERE conv_id = ?').get(conv.id)).m);
  const r = await db.prepare('UPDATE ci_members SET last_read_id = ?, last_delivered_id = GREATEST(last_delivered_id, ?) WHERE conv_id = ? AND user_id = ? AND last_read_id < ?').run(max, max, conv.id, req.user.id, max);
  if (r.changes) {
    const prefs = await getPrefs(req.org.id, req.user.id);
    const mem = await members(conv.id, req.org.id);
    hub.publish(req.org.id, [req.user.id], 'read', { convId: Number(conv.id), upTo: max }); // synchronise ses autres appareils
    if (prefs.readReceipts) hub.publish(req.org.id, mem.map((m) => Number(m.user_id)).filter((u) => u !== req.user.id), 'receipt', { convId: Number(conv.id), userIds: [req.user.id], kind: 'read', upTo: max });
  }
  return max;
}

module.exports = { allow, MAX_BODY, KINDS, FILE_KINDS, HARD_MAX_FILE_MB, userLimit, _resetLimits, getSettings, getPrefs, loadConv, isGroupAdmin, members, directKey, views, visibleSql, detectMentions, postMessage, convSummary, markRead, parseJSON, log };
