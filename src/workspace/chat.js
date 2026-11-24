'use strict';
// Chat interne (1/5) : conversations, messages, accusés, présence, groupes. Voir docs/chat-interne.md.
// Les autres parties : chat-files (fichiers, réglages), chat-extras (épingles, sondages, programmés, rappels, tâches, position, recherche, traduction),
// chat-calls (appels et réunions WebRTC), chat-ai (assistante dans la conversation).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const hub = require('./chat-hub');
const L = require('./chat-lib');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const sendLimit = L.userLimit('send', 60 * 1000, 60, 'Vous envoyez trop de messages à la suite. Patientez une minute.');
const typingLimit = L.userLimit('typing', 60 * 1000, 120);
const groupLimit = L.userLimit('group', 10 * 60 * 1000, 30, 'Trop de modifications de groupes. Réessayez dans quelques minutes.');
const MAX_GROUP = 200;

// ---------- Présence : signe de vie à chaque appel, annonce aux autres quand on apparaît ----------
router.use(async (req, res, next) => {
  if (hub.touch(req.org.id, req.user.id)) {
    const p = await L.getPrefs(req.org.id, req.user.id);
    if (p.showPresence) hub.publishOrg(req.org.id, 'presence', { userId: req.user.id, online: true }, req.user.id);
    db.prepare('INSERT INTO ci_prefs (org_id, user_id, last_seen, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET last_seen = EXCLUDED.last_seen').run(req.org.id, req.user.id, nowISO(), nowISO()).catch(() => {});
  }
  next();
});

/** Remise : tout ce qui est arrivé pour cette personne est « distribué » ; les expéditeurs en sont prévenus. */
async function markDelivered(req) {
  const rows = await db.prepare(`SELECT m.conv_id, c.last_message_id FROM ci_members m JOIN ci_conversations c ON c.id = m.conv_id
    WHERE m.org_id = ? AND m.user_id = ? AND m.left_at IS NULL AND c.last_message_id IS NOT NULL AND m.last_delivered_id < c.last_message_id`).all(req.org.id, req.user.id);
  for (const r of rows) {
    await db.prepare('UPDATE ci_members SET last_delivered_id = ? WHERE conv_id = ? AND user_id = ?').run(r.last_message_id, r.conv_id, req.user.id);
    const mem = await L.members(r.conv_id, req.org.id);
    hub.publish(req.org.id, mem.map((m) => Number(m.user_id)).filter((u) => u !== req.user.id), 'receipt', { convId: Number(r.conv_id), userIds: [req.user.id], kind: 'delivered', upTo: Number(r.last_message_id) });
  }
}

// ---------- Général ----------
router.get('/', async (req, res) => {
  const [settings, prefs] = await Promise.all([L.getSettings(req.org.id), L.getPrefs(req.org.id, req.user.id)]);
  const ai = require('./chat-ai');
  res.json({ settings: { ...settings, hardMaxFileMb: L.HARD_MAX_FILE_MB }, prefs, me: { userId: req.user.id, role: req.member.role, canAdmin: A.can(req, 'admin'), canCreateGroup: settings.groupsBy === 'all' || A.can(req, 'manager') }, ai: await ai.status(req), brand: require('./chat-brand').AI_NAME, epoch: hub.EPOCH });
});

router.get('/stream', async (req, res) => {
  await markDelivered(req);
  const prefs = await L.getPrefs(req.org.id, req.user.id);
  const orgId = req.org.id; const uid = req.user.id;
  hub.openStream(req, res, orgId, uid, {
    onOpen: () => { if (prefs.showPresence) hub.publishOrg(orgId, 'presence', { userId: uid, online: true }, uid); },
    onClose: () => setTimeout(() => { if (!hub.isOnline(orgId, uid) && prefs.showPresence) hub.publishOrg(orgId, 'presence', { userId: uid, online: false, lastSeen: hub.lastSeen(orgId, uid) }, uid); }, hub.ONLINE_MS + 3000).unref(),
  });
});

router.get('/updates', async (req, res) => {
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  await markDelivered(req);
  res.json(hub.since(req.org.id, req.user.id, after, String(req.query.epoch || '')));
});

router.get('/unread', async (req, res) => {
  const rows = await db.prepare('SELECT c.*, m.role AS my_role, m.from_id AS my_from, m.last_read_id AS my_read, m.muted AS my_muted, m.archived AS my_archived FROM ci_conversations c JOIN ci_members m ON m.conv_id = c.id AND m.user_id = ? AND m.left_at IS NULL WHERE c.org_id = ?').all(req.user.id, req.org.id);
  let total = 0; let mentions = 0;
  for (const c of rows) { if (Number(c.my_muted) === 1 || Number(c.my_archived) === 1) continue; const s = await L.convSummary(req, c, [], false); total += s.unread; mentions += s.mentioned; }
  res.json({ total, mentions });
});

router.put('/prefs', async (req, res) => {
  const b = req.body || {};
  const cur = await L.getPrefs(req.org.id, req.user.id);
  const n = { readReceipts: b.readReceipts === undefined ? cur.readReceipts : Boolean(b.readReceipts), showPresence: b.showPresence === undefined ? cur.showPresence : Boolean(b.showPresence) };
  await db.prepare(`INSERT INTO ci_prefs (org_id, user_id, read_receipts, show_presence, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (org_id, user_id) DO UPDATE SET read_receipts = EXCLUDED.read_receipts, show_presence = EXCLUDED.show_presence, updated_at = EXCLUDED.updated_at`).run(req.org.id, req.user.id, n.readReceipts ? 1 : 0, n.showPresence ? 1 : 0, nowISO());
  res.json({ prefs: n });
});

// ---------- Personnes ----------
router.get('/people', async (req, res) => {
  const q = cleanText(String(req.query.q || ''), 60).toLowerCase();
  const rows = await db.prepare(`SELECT om.user_id, om.role, om.title, om.branch_id, u.name, COALESCE(p.show_presence, 1) AS show_presence, p.last_seen FROM org_members om JOIN users u ON u.id = om.user_id
    LEFT JOIN ci_prefs p ON p.org_id = om.org_id AND p.user_id = om.user_id WHERE om.org_id = ? ORDER BY u.name`).all(req.org.id);
  const direct = new Map((await db.prepare(`SELECT c.id, c.direct_key FROM ci_conversations c JOIN ci_members m ON m.conv_id = c.id AND m.user_id = ? AND m.left_at IS NULL WHERE c.org_id = ? AND c.kind = 'direct'`).all(req.user.id, req.org.id)).map((r) => [r.direct_key, Number(r.id)]));
  res.json({ people: rows.filter((r) => !q || `${r.name} ${r.title}`.toLowerCase().includes(q)).map((r) => {
    const uid = Number(r.user_id); const show = Number(r.show_presence) === 1 || uid === req.user.id;
    return { userId: uid, name: r.name, title: r.title, role: r.role, branchId: r.branch_id == null ? null : Number(r.branch_id), me: uid === req.user.id, online: show ? hub.isOnline(req.org.id, uid) : null, lastSeen: show ? (hub.lastSeen(req.org.id, uid) || r.last_seen || null) : null, directId: direct.get(L.directKey(req.user.id, uid)) || null };
  }) });
});

// ---------- Conversations ----------
router.get('/conversations', async (req, res) => {
  await markDelivered(req);
  const archived = req.query.archived === '1' ? 1 : 0;
  const rows = await db.prepare(`SELECT c.*, m.role AS my_role, m.from_id AS my_from, m.last_read_id AS my_read, m.muted AS my_muted, m.archived AS my_archived
    FROM ci_conversations c JOIN ci_members m ON m.conv_id = c.id AND m.user_id = ? AND m.left_at IS NULL
    WHERE c.org_id = ? AND m.archived = ? ORDER BY c.last_at DESC, c.id DESC LIMIT 300`).all(req.user.id, req.org.id, archived);
  const out = [];
  for (const c of rows) out.push(await L.convSummary(req, c));
  res.json({ conversations: out });
});

// ---------- Clés publiques (chiffrement de bout en bout) : le serveur ne garde QUE les clés publiques ----------
router.get('/keys/me', async (req, res) => {
  const k = await db.prepare('SELECT public_key, created_at FROM ci_keys WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  res.json({ publicKey: k ? k.public_key : null, createdAt: k ? k.created_at : null });
});
router.put('/keys/me', L.userLimit('keys', 60 * 60 * 1000, 10, 'Trop de changements de clé. Réessayez plus tard.'), async (req, res) => {
  const pk = (req.body || {}).publicKey;
  let j = null;
  try { j = typeof pk === 'string' ? JSON.parse(pk) : null; } catch { j = null; }
  if (!j || j.kty !== 'EC' || j.crv !== 'P-256' || typeof j.x !== 'string' || typeof j.y !== 'string' || j.d !== undefined || pk.length > 400) throw new HttpError(400, 'Clé publique invalide (elle ne doit jamais contenir la partie privée).');
  const old = await db.prepare('SELECT public_key FROM ci_keys WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  await db.prepare('INSERT INTO ci_keys (org_id, user_id, public_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET public_key = EXCLUDED.public_key, created_at = EXCLUDED.created_at').run(req.org.id, req.user.id, JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y }), nowISO());
  if (old && old.public_key !== pk) await W.audit(req, 'chat_keys', req.user.id, 'rotate', null, null);
  res.json({ ok: true });
});
router.get('/keys/:userId', async (req, res) => {
  const uid = A.id(req.params.userId);
  await A.memberOf(req, uid);
  const k = await db.prepare('SELECT public_key FROM ci_keys WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  res.json({ publicKey: k ? k.public_key : null });
});

router.post('/conversations/direct', async (req, res) => {
  const other = A.id((req.body || {}).userId, 'Choisissez une personne.');
  const encrypted = (req.body || {}).encrypted === true;
  if (other === req.user.id) throw new HttpError(400, "Vous ne pouvez pas ouvrir une conversation avec vous-même.");
  await A.memberOf(req, other);
  if (encrypted) {
    const ks = await db.prepare('SELECT user_id FROM ci_keys WHERE org_id = ? AND user_id IN (?, ?)').all(req.org.id, req.user.id, other);
    if (ks.length < 2) throw new HttpError(409, "Les deux personnes doivent d'abord activer le chiffrement (ouvrir le chat une fois sur leur appareil).");
  }
  const key = L.directKey(req.user.id, other) + (encrypted ? ':e' : '');
  let c = await db.prepare('SELECT id FROM ci_conversations WHERE org_id = ? AND direct_key = ?').get(req.org.id, key);
  if (!c) {
    const now = nowISO();
    try {
      const id = Number((await db.prepare("INSERT INTO ci_conversations (org_id, kind, direct_key, e2ee, created_by, created_at, last_at) VALUES (?, 'direct', ?, ?, ?, ?, ?)").run(req.org.id, key, encrypted ? 1 : 0, req.user.id, now, now)).lastInsertRowid);
      for (const u of [req.user.id, other]) await db.prepare('INSERT INTO ci_members (org_id, conv_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, id, u, 'member', now);
      c = { id };
    } catch { c = await db.prepare('SELECT id FROM ci_conversations WHERE org_id = ? AND direct_key = ?').get(req.org.id, key); } // créée en même temps par l'autre personne
  }
  // Une personne qui avait archivé ou quitté l'échange le retrouve.
  await db.prepare('UPDATE ci_members SET archived = 0, left_at = NULL WHERE conv_id = ? AND user_id = ?').run(c.id, req.user.id);
  const conv = await L.loadConv(req, c.id);
  res.json({ conversation: await L.convSummary(req, conv) });
});

router.get('/conversations/:id', async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  const mem = await L.members(conv.id, req.org.id);
  const pins = await db.prepare(`SELECT p.message_id FROM ci_pins p JOIN ci_messages m ON m.id = p.message_id WHERE p.conv_id = ? AND m.deleted_at IS NULL AND m.id > ? ORDER BY p.id DESC LIMIT 20`).all(conv.id, Number(conv.my_from) || 0);
  const pinRows = pins.length ? await db.prepare(`SELECT * FROM ci_messages WHERE id IN (${pins.map(() => '?').join(',')}) ORDER BY id DESC`).all(...pins.map((p) => p.message_id)) : [];
  const prefs = new Map();
  res.json({
    conversation: await L.convSummary(req, conv, mem),
    members: mem.map((m) => { const uid = Number(m.user_id); const show = Number(m.show_presence) === 1 || uid === req.user.id; void prefs; return { userId: uid, name: m.name, title: m.title, role: m.role, online: show ? hub.isOnline(req.org.id, uid) : null, lastSeen: show ? hub.lastSeen(req.org.id, uid) : null }; }),
    pins: await L.views(req, conv, pinRows, mem), typing: hub.typingIn(conv.id, req.user.id),
  });
});

router.get('/conversations/:id/messages', async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  const vis = L.visibleSql(conv, req.user.id);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 200);
  let rows;
  if (req.query.after) {
    rows = await db.prepare(`SELECT m.* FROM ci_messages m WHERE m.conv_id = ?${vis.sql} AND m.id > ? ORDER BY m.id ASC LIMIT ?`).all(conv.id, ...vis.args, A.id(req.query.after), limit);
  } else {
    const before = req.query.before ? A.id(req.query.before) : Number.MAX_SAFE_INTEGER;
    rows = (await db.prepare(`SELECT m.* FROM ci_messages m WHERE m.conv_id = ?${vis.sql} AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(conv.id, ...vis.args, before, limit)).reverse();
  }
  const mem = await L.members(conv.id, req.org.id);
  const out = await L.views(req, conv, rows, mem);
  const hasMore = req.query.after ? rows.length === limit : (rows.length === limit && Number((await db.prepare(`SELECT COUNT(*) c FROM ci_messages m WHERE m.conv_id = ?${vis.sql} AND m.id < ?`).get(conv.id, ...vis.args, rows[0].id)).c) > 0);
  res.json({ messages: out, hasMore, typing: hub.typingIn(conv.id, req.user.id) });
});

async function canPost(conv) {
  if (Number(conv.only_admins_post) === 1 && conv.my_role !== 'admin') throw new HttpError(403, "Dans ce groupe, seuls les administrateurs du groupe peuvent écrire.");
}

router.post('/conversations/:id/messages', sendLimit, async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  await canPost(conv);
  const b = req.body || {};
  let body;
  if (L.isE2ee(conv)) {
    body = typeof b.cipher === 'string' ? b.cipher : '';
    if (!L.CIPHER_RX.test(body)) throw new HttpError(400, 'Cette conversation est chiffrée de bout en bout : le message doit être chiffré par votre appareil.');
  } else {
    if (b.cipher !== undefined) throw new HttpError(400, "Cette conversation n'est pas chiffrée.");
    body = cleanText(b.body, L.MAX_BODY);
  }
  if (!body) throw new HttpError(400, 'Écrivez un message.');
  let replyTo = null;
  if (b.replyToId) {
    replyTo = await db.prepare('SELECT id FROM ci_messages WHERE id = ? AND conv_id = ? AND id > ? AND (visible_to IS NULL OR visible_to = ?)').get(A.id(b.replyToId), conv.id, Number(conv.my_from) || 0, req.user.id);
    if (!replyTo) throw new HttpError(404, 'Le message cité est introuvable.');
  }
  const view = await L.postMessage(req, conv, { body, replyToId: replyTo ? Number(replyTo.id) : null, urgent: b.urgent === true });
  if (!L.isE2ee(conv)) require('./chat-ai').afterPost(req, conv, view).catch(() => {}); // @assistante dans un message : réponse en arrière-plan
  res.status(201).json({ message: view });
});

router.post('/conversations/:id/read', async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  const up = (req.body || {}).upTo ? A.id(req.body.upTo) : 0;
  res.json({ lastRead: await L.markRead(req, conv, up || undefined) });
});

router.post('/conversations/:id/typing', typingLimit, async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  const kind = A.oneOf((req.body || {}).kind, ['typing', 'recording', 'none'], 'typing');
  hub.setTyping(req.org.id, conv.id, req.user.id, kind === 'none' ? null : kind);
  const mem = await L.members(conv.id, req.org.id);
  hub.publish(req.org.id, mem.map((m) => Number(m.user_id)).filter((u) => u !== req.user.id), 'typing', { convId: Number(conv.id), userId: req.user.id, name: req.user.name, kind: kind === 'none' ? null : kind });
  res.json({ ok: true });
});

router.put('/conversations/:id/me', async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  const b = req.body || {};
  await db.prepare('UPDATE ci_members SET muted = ?, archived = ? WHERE conv_id = ? AND user_id = ?').run(b.muted === undefined ? conv.my_muted : (b.muted ? 1 : 0), b.archived === undefined ? conv.my_archived : (b.archived ? 1 : 0), conv.id, req.user.id);
  res.json({ ok: true });
});

// ---------- Modifier / supprimer un message ----------
async function ownMessage(req, id) {
  const m = await db.prepare('SELECT * FROM ci_messages WHERE id = ? AND org_id = ?').get(A.id(id, 'Message introuvable.'), req.org.id);
  if (!m) throw new HttpError(404, 'Message introuvable.');
  const conv = await L.loadConv(req, m.conv_id); // refuse (404) si la personne n'est pas participante
  if (Number(m.id) <= Number(conv.my_from) || (m.visible_to != null && Number(m.visible_to) !== req.user.id)) throw new HttpError(404, 'Message introuvable.');
  return { m, conv };
}
router.put('/messages/:id', sendLimit, async (req, res) => {
  const { m, conv } = await ownMessage(req, req.params.id);
  if (Number(m.sender_id) !== req.user.id || !['text'].includes(m.kind) || m.deleted_at) throw new HttpError(403, 'Vous ne pouvez modifier que vos propres messages texte.');
  if (Date.now() - Date.parse(m.created_at) > 24 * 3600 * 1000) throw new HttpError(403, 'Un message ne peut plus être modifié après 24 heures.');
  const enc = L.isE2ee(conv);
  const body = enc ? String((req.body || {}).cipher || '') : cleanText((req.body || {}).body, L.MAX_BODY);
  if (!body || (enc && !L.CIPHER_RX.test(body))) throw new HttpError(400, 'Le message ne peut pas être vide.');
  const mem = await L.members(conv.id, req.org.id);
  const men = enc ? { ids: [], all: false } : L.detectMentions(body, mem, req.user.id, conv.kind === 'group');
  await db.prepare('UPDATE ci_messages SET body = ?, edited_at = ?, mentions = ?, mention_all = ? WHERE id = ?').run(body, nowISO(), JSON.stringify(men.ids), men.all ? 1 : 0, m.id);
  const [v] = await L.views(req, conv, [await db.prepare('SELECT * FROM ci_messages WHERE id = ?').get(m.id)], mem);
  hub.publish(req.org.id, mem.map((x) => Number(x.user_id)), 'message.update', { convId: Number(conv.id), message: { ...v, mine: false, delivered: undefined, read: undefined, readBy: undefined } });
  res.json({ message: v });
});
router.delete('/messages/:id', async (req, res) => {
  const { m, conv } = await ownMessage(req, req.params.id);
  const mine = Number(m.sender_id) === req.user.id;
  if (!mine && !(L.isGroupAdmin(conv) && m.sender_id != null)) throw new HttpError(403, "Vous ne pouvez supprimer que vos propres messages (les administrateurs du groupe peuvent supprimer ceux des autres).");
  if (m.deleted_at) return res.json({ ok: true });
  await db.prepare("UPDATE ci_messages SET deleted_at = ?, body = '', meta = '{}' WHERE id = ?").run(nowISO(), m.id);
  if (m.file_id) await db.prepare('UPDATE ci_files SET deleted_at = ?, data = ? WHERE id = ? AND org_id = ?').run(nowISO(), Buffer.alloc(0), m.file_id, req.org.id);
  await db.prepare('DELETE FROM ci_pins WHERE message_id = ?').run(m.id);
  if (!mine) await W.audit(req, 'chat_group', conv.id, 'delete_message', { messageId: Number(m.id), senderId: num(m.sender_id) }, null);
  const mem = await L.members(conv.id, req.org.id);
  hub.publish(req.org.id, mem.map((x) => Number(x.user_id)), 'message.delete', { convId: Number(conv.id), messageId: Number(m.id) });
  res.json({ ok: true });
});
const num = (v) => (v == null ? null : Number(v));

// ---------- Groupes ----------
async function sysMessage(req, conv, event, extra = {}, body = '') {
  return L.postMessage(req, conv, { kind: 'system', senderId: req.user.id, body, meta: { event, actorId: req.user.id, actorName: req.user.name, ...extra }, noMentions: true });
}
async function validMembers(req, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return [];
  const ok = new Set((await db.prepare(`SELECT user_id FROM org_members WHERE org_id = ? AND user_id IN (${list.map(() => '?').join(',')})`).all(req.org.id, ...list)).map((r) => Number(r.user_id)));
  if (list.some((u) => !ok.has(u))) throw new HttpError(400, "Une des personnes ne fait pas partie de l'entreprise.");
  return list;
}
router.post('/groups', groupLimit, async (req, res) => {
  const set = await L.getSettings(req.org.id);
  if (set.groupsBy === 'manager' && !A.can(req, 'manager')) throw new HttpError(403, "Dans cette entreprise, seuls les responsables peuvent créer des groupes.");
  const b = req.body || {};
  const name = A.text(b.name, 80, { required: true, msg: 'Donnez un nom au groupe.' });
  const purpose = A.oneOf(b.purpose, ['general', 'department', 'project'], 'general', 'Type de groupe inconnu.');
  const department = purpose === 'department' ? A.text(b.department, 80) : '';
  let projectId = null; let ids = await validMembers(req, b.memberIds);
  if (purpose === 'project' && b.projectId) {
    const p = await db.prepare('SELECT id, branch_id FROM projects WHERE id = ? AND org_id = ?').get(A.id(b.projectId, 'Projet inconnu.'), req.org.id);
    if (!p || !A.visible(req, p)) throw new HttpError(400, 'Projet inconnu.');
    projectId = Number(p.id);
    if (!ids.length) ids = (await db.prepare('SELECT DISTINCT t.assignee_id AS u FROM tasks t JOIN org_members om ON om.user_id = t.assignee_id AND om.org_id = t.org_id WHERE t.project_id = ? AND t.org_id = ?').all(projectId, req.org.id)).map((r) => Number(r.u));
  }
  if (b.branchId) { const br = await A.branchOf(req, b.branchId); ids = [...new Set([...ids, ...(await db.prepare('SELECT user_id FROM org_members WHERE org_id = ? AND branch_id = ?').all(req.org.id, br)).map((r) => Number(r.user_id))])]; }
  ids = ids.filter((u) => u !== req.user.id);
  if (ids.length + 1 > MAX_GROUP) throw new HttpError(400, `Un groupe compte ${MAX_GROUP} personnes au plus.`);
  const now = nowISO();
  const id = await db.transaction(async () => {
    const cid = Number((await db.prepare("INSERT INTO ci_conversations (org_id, kind, purpose, name, description, department, project_id, ai_enabled, created_by, created_at, last_at) VALUES (?, 'group', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(req.org.id, purpose, name, A.text(b.description, 300), department, projectId, set.aiEnabled && b.aiEnabled ? 1 : 0, req.user.id, now, now)).lastInsertRowid);
    await db.prepare("INSERT INTO ci_members (org_id, conv_id, user_id, role, joined_at) VALUES (?, ?, ?, 'admin', ?)").run(req.org.id, cid, req.user.id, now);
    for (const u of ids) await db.prepare("INSERT INTO ci_members (org_id, conv_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)").run(req.org.id, cid, u, now);
    return cid;
  })();
  await W.audit(req, 'chat_group', id, 'create', null, { name, purpose, department, projectId, members: ids.length + 1 });
  const conv = await L.loadConv(req, id);
  await sysMessage(req, conv, 'created', { name });
  res.status(201).json({ conversation: await L.convSummary(req, await L.loadConv(req, id)) });
});

function needGroup(conv) { if (conv.kind !== 'group') throw new HttpError(400, "Cette action concerne seulement les groupes."); }
function needAdmin(conv) { needGroup(conv); if (!L.isGroupAdmin(conv)) throw new HttpError(403, "Seuls les administrateurs du groupe peuvent faire cela."); }

router.put('/conversations/:id', groupLimit, async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  needAdmin(conv);
  const b = req.body || {};
  const set = await L.getSettings(req.org.id);
  const n = {
    name: b.name === undefined ? conv.name : A.text(b.name, 80, { required: true, msg: 'Donnez un nom au groupe.' }),
    description: b.description === undefined ? conv.description : A.text(b.description, 300),
    department: b.department === undefined ? conv.department : A.text(b.department, 80),
    onlyAdminsPost: b.onlyAdminsPost === undefined ? Number(conv.only_admins_post) : (b.onlyAdminsPost ? 1 : 0),
    aiEnabled: b.aiEnabled === undefined ? Number(conv.ai_enabled) : (b.aiEnabled && set.aiEnabled ? 1 : 0),
  };
  await db.prepare('UPDATE ci_conversations SET name = ?, description = ?, department = ?, only_admins_post = ?, ai_enabled = ? WHERE id = ?').run(n.name, n.description, n.department, n.onlyAdminsPost, n.aiEnabled, conv.id);
  await W.audit(req, 'chat_group', conv.id, 'update', { name: conv.name, onlyAdminsPost: Number(conv.only_admins_post), aiEnabled: Number(conv.ai_enabled) }, { name: n.name, onlyAdminsPost: n.onlyAdminsPost, aiEnabled: n.aiEnabled });
  if (n.name !== conv.name) await sysMessage(req, conv, 'renamed', { name: n.name, before: conv.name });
  if (n.aiEnabled !== Number(conv.ai_enabled)) await sysMessage(req, conv, n.aiEnabled ? 'ai_on' : 'ai_off');
  const mem = await L.members(conv.id, req.org.id);
  const fresh = await L.loadConv(req, conv.id);
  hub.publish(req.org.id, mem.map((m) => Number(m.user_id)), 'conversation', { convId: Number(conv.id) });
  res.json({ conversation: await L.convSummary(req, fresh, mem) });
});

router.post('/conversations/:id/members', groupLimit, async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  needAdmin(conv);
  const b = req.body || {};
  const ids = await validMembers(req, b.userIds);
  if (!ids.length) throw new HttpError(400, 'Choisissez au moins une personne.');
  const cur = await L.members(conv.id, req.org.id);
  if (cur.length + ids.length > MAX_GROUP) throw new HttpError(400, `Un groupe compte ${MAX_GROUP} personnes au plus.`);
  const lastId = Number((await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ci_messages WHERE conv_id = ?').get(conv.id)).m);
  const added = [];
  for (const u of ids) {
    if (cur.some((m) => Number(m.user_id) === u)) continue;
    const from = b.shareHistory ? 0 : lastId; // sans partage de l'historique, la personne ne voit que ce qui suit son arrivée
    const old = await db.prepare('SELECT id FROM ci_members WHERE conv_id = ? AND user_id = ?').get(conv.id, u);
    if (old) await db.prepare("UPDATE ci_members SET left_at = NULL, role = 'member', from_id = ?, last_read_id = ?, last_delivered_id = ?, joined_at = ? WHERE id = ?").run(from, lastId, lastId, nowISO(), old.id);
    else await db.prepare("INSERT INTO ci_members (org_id, conv_id, user_id, role, from_id, last_read_id, last_delivered_id, joined_at) VALUES (?, ?, ?, 'member', ?, ?, ?, ?)").run(req.org.id, conv.id, u, from, lastId, lastId, nowISO());
    added.push(u);
  }
  if (added.length) {
    await W.audit(req, 'chat_group', conv.id, 'add_members', null, { userIds: added, shareHistory: Boolean(b.shareHistory) });
    await sysMessage(req, conv, 'added', { userIds: added, names: (await db.prepare(`SELECT name FROM users WHERE id IN (${added.map(() => '?').join(',')})`).all(...added)).map((r) => r.name) });
    hub.publish(req.org.id, added, 'conversation', { convId: Number(conv.id) });
  }
  res.json({ added });
});

router.put('/conversations/:id/members/:userId', groupLimit, async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  needAdmin(conv);
  const uid = A.id(req.params.userId);
  const role = A.oneOf((req.body || {}).role, ['admin', 'member'], undefined, 'Rôle inconnu.');
  const t = await db.prepare('SELECT * FROM ci_members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL').get(conv.id, uid);
  if (!t) throw new HttpError(404, 'Cette personne ne fait pas partie du groupe.');
  if (t.role === role) return res.json({ ok: true });
  if (role === 'member' && t.role === 'admin' && Number((await db.prepare("SELECT COUNT(*) c FROM ci_members WHERE conv_id = ? AND role = 'admin' AND left_at IS NULL").get(conv.id)).c) <= 1) throw new HttpError(400, "Il faut au moins un administrateur dans le groupe : nommez-en un autre d'abord.");
  await db.prepare('UPDATE ci_members SET role = ? WHERE id = ?').run(role, t.id);
  await W.audit(req, 'chat_group', conv.id, role === 'admin' ? 'promote' : 'demote', { userId: uid, role: t.role }, { userId: uid, role });
  const name = (await db.prepare('SELECT name FROM users WHERE id = ?').get(uid)).name;
  await sysMessage(req, conv, role === 'admin' ? 'promoted' : 'demoted', { userId: uid, name });
  hub.publish(req.org.id, [uid], 'conversation', { convId: Number(conv.id) });
  res.json({ ok: true });
});

async function dropIfEmpty(conv, orgId) {
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM ci_members WHERE conv_id = ? AND left_at IS NULL').get(conv.id)).c);
  if (!n) await db.prepare('DELETE FROM ci_conversations WHERE id = ? AND org_id = ?').run(conv.id, orgId);
  return n === 0;
}
async function ensureAdmin(conv) {
  if (Number((await db.prepare("SELECT COUNT(*) c FROM ci_members WHERE conv_id = ? AND role = 'admin' AND left_at IS NULL").get(conv.id)).c) > 0) return null;
  const next = await db.prepare('SELECT id, user_id FROM ci_members WHERE conv_id = ? AND left_at IS NULL ORDER BY joined_at, id LIMIT 1').get(conv.id);
  if (next) { await db.prepare("UPDATE ci_members SET role = 'admin' WHERE id = ?").run(next.id); return Number(next.user_id); }
  return null;
}
router.delete('/conversations/:id/members/:userId', groupLimit, async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  needAdmin(conv);
  const uid = A.id(req.params.userId);
  if (uid === req.user.id) throw new HttpError(400, "Pour partir, utilisez « Quitter le groupe ».");
  const t = await db.prepare('SELECT * FROM ci_members WHERE conv_id = ? AND user_id = ? AND left_at IS NULL').get(conv.id, uid);
  if (!t) throw new HttpError(404, 'Cette personne ne fait pas partie du groupe.');
  const name = (await db.prepare('SELECT name FROM users WHERE id = ?').get(uid)).name;
  await db.prepare('UPDATE ci_members SET left_at = ? WHERE id = ?').run(nowISO(), t.id);
  await sysMessage(req, conv, 'removed', { userId: uid, name }); // écrit après le retrait : la personne retirée ne le reçoit pas
  await W.audit(req, 'chat_group', conv.id, 'remove_member', { userId: uid }, null);
  hub.publish(req.org.id, [uid], 'conversation', { convId: Number(conv.id), removed: true });
  res.json({ ok: true });
});

router.post('/conversations/:id/leave', groupLimit, async (req, res) => {
  const conv = await L.loadConv(req, req.params.id);
  needGroup(conv);
  await db.prepare('UPDATE ci_members SET left_at = ? WHERE conv_id = ? AND user_id = ?').run(nowISO(), conv.id, req.user.id);
  const promoted = await ensureAdmin(conv);
  await W.audit(req, 'chat_group', conv.id, 'leave', { userId: req.user.id }, promoted ? { newAdmin: promoted } : null);
  if (!await dropIfEmpty(conv, req.org.id)) {
    const row = await db.prepare('SELECT * FROM ci_conversations WHERE id = ?').get(conv.id);
    await L.postMessage(req, row, { kind: 'system', senderId: null, body: '', meta: { event: 'left', name: req.user.name, actorId: req.user.id }, noMentions: true });
  }
  hub.publish(req.org.id, [req.user.id], 'conversation', { convId: Number(conv.id), removed: true });
  res.json({ ok: true });
});

router.use('/', require('./chat-files').router);
router.use('/', require('./chat-extras').router);
router.use('/calls', require('./chat-calls').router);
router.use('/geo', require('./chat-geo').router); // position en direct (opt-in par employé)
router.use('/ai', require('./chat-ai').router);
require('./chat-jobs');

module.exports = { router, markDelivered };
