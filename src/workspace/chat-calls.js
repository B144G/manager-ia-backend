'use strict';
// Chat interne (4/5) : appels audio / vidéo et réunions de groupe en WebRTC, partage d'écran, historique, lien avec le module Réunions.
// Le serveur ne fait QUE la signalisation (il relaie les offres / réponses / candidats ICE entre participants) : l'audio et la vidéo passent
// directement entre les appareils (pair à pair, « maillage »). Conséquences assumées (voir docs/chat-interne.md) :
//  - adapté aux petits groupes (6 personnes par défaut, CHAT_CALL_MAX) : chaque personne envoie son flux à chacune des autres ;
//  - derrière certains réseaux mobiles / pare-feu, une connexion directe est impossible : il faut un serveur TURN (variables CHAT_TURN_*) ;
//  - rien n'est enregistré par le serveur.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const hub = require('./chat-hub');
const L = require('./chat-lib');
const { HttpError, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const MAX_PARTS = Math.max(2, Math.min(parseInt(process.env.CHAT_CALL_MAX, 10) || 6, 12));
const RING_MS = { direct: 45000, group: 60000 };
const startLimit = L.userLimit('callstart', 60 * 1000, 10, 'Vous lancez trop d’appels à la suite. Patientez une minute.');
const signalLimit = L.userLimit('signal', 60 * 1000, 900);
const active = new Map(); // callId -> { orgId, convId, direct, kind, joined: Set<userId>, startedAt, ringUntil }

// ---------- Serveurs STUN / TURN ----------
function iceServers(userId) {
  const stun = (process.env.CHAT_STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean);
  const out = stun.length ? [{ urls: stun }] : [];
  const turn = (process.env.CHAT_TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let hasTurn = false;
  if (turn.length) {
    if (process.env.CHAT_TURN_SECRET) { // identifiants temporaires (coturn « use-auth-secret ») : jamais de mot de passe fixe envoyé aux navigateurs
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${userId}`;
      out.push({ urls: turn, username, credential: crypto.createHmac('sha1', process.env.CHAT_TURN_SECRET).update(username).digest('base64') });
      hasTurn = true;
    } else if (process.env.CHAT_TURN_USERNAME && process.env.CHAT_TURN_CREDENTIAL) {
      out.push({ urls: turn, username: process.env.CHAT_TURN_USERNAME, credential: process.env.CHAT_TURN_CREDENTIAL });
      hasTurn = true;
    }
  }
  return { iceServers: out, turn: hasTurn };
}
router.get('/ice', async (req, res) => {
  const set = await L.getSettings(req.org.id);
  res.json({ ...iceServers(req.user.id), maxParticipants: MAX_PARTS, enabled: set.callsEnabled });
});

// ---------- Utilitaires ----------
async function callFor(req, id) {
  const c = await db.prepare('SELECT * FROM ci_calls WHERE id = ? AND org_id = ?').get(A.id(id, 'Appel introuvable.'), req.org.id);
  if (!c) throw new HttpError(404, 'Appel introuvable.');
  const conv = await L.loadConv(req, c.conv_id); // seuls les participants de la conversation
  return { c, conv };
}
const isOpen = (c) => ['ringing', 'active'].includes(c.status);
async function updateCallMessage(req, c, patch) {
  const m = await db.prepare("SELECT * FROM ci_messages WHERE conv_id = ? AND kind = 'call' AND meta LIKE ? ORDER BY id DESC LIMIT 1").get(c.conv_id, `%"callId":${c.id},%`);
  if (!m) return;
  const meta = { ...L.parseJSON(m.meta, {}), ...patch };
  await db.prepare('UPDATE ci_messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), m.id);
  const conv = await db.prepare('SELECT * FROM ci_conversations WHERE id = ?').get(c.conv_id);
  const mem = await L.members(c.conv_id, req.org.id);
  const [v] = await L.views({ org: req.org, user: { id: 0 } }, conv, [{ ...m, meta: JSON.stringify(meta) }], mem);
  hub.publish(req.org.id, mem.map((x) => Number(x.user_id)), 'message.update', { convId: Number(c.conv_id), message: { ...v, mine: false } });
}
async function endCall(req, c, status) {
  const st = active.get(Number(c.id));
  const now = nowISO();
  const r = await db.prepare("UPDATE ci_calls SET status = ?, ended_at = ? WHERE id = ? AND status IN ('ringing', 'active')").run(status, now, c.id);
  if (!r.changes) return;
  await db.prepare("UPDATE ci_call_parts SET left_at = ? WHERE call_id = ? AND state = 'joined' AND left_at IS NULL").run(now, c.id);
  const dur = c.answered_at ? Math.max(0, Math.round((Date.now() - Date.parse(c.answered_at)) / 1000)) : 0;
  const mem = await L.members(c.conv_id, c.org_id);
  hub.publish(c.org_id, mem.map((m) => Number(m.user_id)), 'call.ended', { callId: Number(c.id), convId: Number(c.conv_id), status, durationSec: dur });
  active.delete(Number(c.id));
  await updateCallMessage({ org: { id: c.org_id } }, c, { status, durationSec: dur });
  if (status === 'missed') { // personne n'a répondu : on prévient (sans contenu) ceux qui étaient hors ligne
    const W = require('./w3');
    const who = (mem.find((m) => Number(m.user_id) === Number(c.initiator_id)) || {}).name || '';
    for (const m of mem) if (Number(m.user_id) !== Number(c.initiator_id) && !hub.isOnline(c.org_id, Number(m.user_id))) W.push(c.org_id, Number(m.user_id), 'chat', `Appel manqué de ${who}.`, `chat:${c.conv_id}`).catch(() => {});
  }
  void st;
}

// ---------- Lancer un appel ----------
router.post('/', startLimit, async (req, res) => {
  const set = await L.getSettings(req.org.id);
  if (!set.callsEnabled) throw new HttpError(403, "Les appels sont désactivés dans les réglages du chat de votre entreprise.");
  const b = req.body || {};
  const conv = await L.loadConv(req, b.convId);
  const kind = A.oneOf(b.kind, ['audio', 'video'], 'audio', 'Type d’appel inconnu.');
  const mem = await L.members(conv.id, req.org.id);
  if (mem.length < 2) throw new HttpError(400, "Il n'y a personne à appeler dans cette conversation.");
  const open = await db.prepare("SELECT * FROM ci_calls WHERE conv_id = ? AND status IN ('ringing', 'active') ORDER BY id DESC LIMIT 1").get(conv.id);
  if (open && active.has(Number(open.id))) return res.json({ call: await callView(open), joined: false, existing: true });
  const now = nowISO();
  const id = Number((await db.prepare('INSERT INTO ci_calls (org_id, conv_id, kind, initiator_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, conv.id, kind, req.user.id, 'ringing', now)).lastInsertRowid);
  for (const m of mem) await db.prepare('INSERT INTO ci_call_parts (call_id, user_id, state, joined_at) VALUES (?, ?, ?, ?)').run(id, m.user_id, Number(m.user_id) === req.user.id ? 'joined' : 'invited', Number(m.user_id) === req.user.id ? now : null);
  const direct = conv.kind === 'direct';
  active.set(id, { orgId: req.org.id, convId: Number(conv.id), direct, kind, joined: new Set([req.user.id]), startedAt: Date.now(), ringUntil: Date.now() + (direct ? RING_MS.direct : RING_MS.group) });
  await db.prepare('UPDATE ci_calls SET peak = 1 WHERE id = ?').run(id);
  await L.postMessage(req, conv, { kind: 'call', body: '', meta: { callId: id, kind, status: 'ringing' }, noMentions: true, members: mem });
  const row = await db.prepare('SELECT * FROM ci_calls WHERE id = ?').get(id);
  hub.publish(req.org.id, mem.map((m) => Number(m.user_id)).filter((u) => u !== req.user.id), 'call.incoming', { callId: id, convId: Number(conv.id), kind, group: !direct, convName: conv.kind === 'direct' ? req.user.name : conv.name, from: { id: req.user.id, name: req.user.name } });
  res.status(201).json({ call: await callView(row), joined: true, peers: [], ...iceServers(req.user.id), maxParticipants: MAX_PARTS });
});

async function callView(c) {
  const parts = await db.prepare('SELECT p.user_id, p.state, p.joined_at, p.left_at, u.name FROM ci_call_parts p JOIN users u ON u.id = p.user_id WHERE p.call_id = ? ORDER BY p.joined_at NULLS LAST, u.name').all(c.id);
  const st = active.get(Number(c.id));
  return { id: Number(c.id), convId: Number(c.conv_id), kind: c.kind, status: c.status, initiatorId: c.initiator_id == null ? null : Number(c.initiator_id), startedAt: c.started_at, answeredAt: c.answered_at, endedAt: c.ended_at, meetingId: c.meeting_id == null ? null : Number(c.meeting_id),
    participants: parts.map((p) => ({ userId: Number(p.user_id), name: p.name, state: p.state, joinedAt: p.joined_at, leftAt: p.left_at, inCall: st ? st.joined.has(Number(p.user_id)) : false })) };
}

router.post('/:id/join', startLimit, async (req, res) => {
  const { c, conv } = await callFor(req, req.params.id);
  const st = active.get(Number(c.id));
  if (!isOpen(c) || !st) throw new HttpError(410, "Cet appel est terminé.");
  if (!st.joined.has(req.user.id) && st.joined.size >= MAX_PARTS) throw new HttpError(409, `Cet appel est complet : ${MAX_PARTS} personnes au plus (les appels se font en connexion directe entre les appareils).`);
  const peers = [...st.joined].filter((u) => u !== req.user.id);
  const now = nowISO();
  st.joined.add(req.user.id);
  await db.prepare("UPDATE ci_call_parts SET state = 'joined', joined_at = ?, left_at = NULL WHERE call_id = ? AND user_id = ?").run(now, c.id, req.user.id);
  await db.prepare("UPDATE ci_calls SET status = 'active', answered_at = COALESCE(answered_at, ?), peak = GREATEST(peak, ?) WHERE id = ?").run(now, st.joined.size, c.id);
  const u = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
  hub.publish(req.org.id, peers, 'call.joined', { callId: Number(c.id), convId: Number(conv.id), userId: req.user.id, name: u.name });
  await updateCallMessage(req, c, { status: 'active' });
  res.json({ call: await callView(await db.prepare('SELECT * FROM ci_calls WHERE id = ?').get(c.id)), peers, ...iceServers(req.user.id), maxParticipants: MAX_PARTS });
});

router.post('/:id/signal', signalLimit, async (req, res) => {
  const { c } = await callFor(req, req.params.id);
  const st = active.get(Number(c.id));
  if (!isOpen(c) || !st) throw new HttpError(410, "Cet appel est terminé.");
  const b = req.body || {};
  const to = A.id(b.to, 'Destinataire invalide.');
  if (!st.joined.has(req.user.id) || !st.joined.has(to) || to === req.user.id) throw new HttpError(403, "Ce destinataire n'est pas dans l'appel.");
  const type = A.oneOf(b.type, ['offer', 'answer', 'candidate'], undefined, 'Signal inconnu.');
  const data = b.data;
  if (!data || typeof data !== 'object' || JSON.stringify(data).length > 20000) throw new HttpError(400, 'Signal invalide.');
  hub.publish(req.org.id, [to], 'call.signal', { callId: Number(c.id), from: req.user.id, type, data });
  res.json({ ok: true });
});

router.post('/:id/state', signalLimit, async (req, res) => {
  const { c } = await callFor(req, req.params.id);
  const st = active.get(Number(c.id));
  if (!isOpen(c) || !st || !st.joined.has(req.user.id)) throw new HttpError(410, "Cet appel est terminé.");
  const b = req.body || {};
  hub.publish(req.org.id, [...st.joined].filter((u) => u !== req.user.id), 'call.state', { callId: Number(c.id), userId: req.user.id, muted: Boolean(b.muted), video: Boolean(b.video), screen: Boolean(b.screen) });
  res.json({ ok: true });
});

router.post('/:id/decline', async (req, res) => {
  const { c, conv } = await callFor(req, req.params.id);
  if (!isOpen(c)) return res.json({ ok: true });
  await db.prepare("UPDATE ci_call_parts SET state = 'declined' WHERE call_id = ? AND user_id = ? AND state = 'invited'").run(c.id, req.user.id);
  const st = active.get(Number(c.id));
  hub.publish(req.org.id, [Number(c.initiator_id)], 'call.declined', { callId: Number(c.id), userId: req.user.id });
  if (conv.kind === 'direct' && st && st.joined.size <= 1) await endCall(req, c, 'declined');
  res.json({ ok: true });
});

router.post('/:id/leave', async (req, res) => {
  const { c } = await callFor(req, req.params.id);
  const st = active.get(Number(c.id));
  if (!isOpen(c) || !st) return res.json({ ok: true });
  st.joined.delete(req.user.id);
  await db.prepare("UPDATE ci_call_parts SET state = 'left', left_at = ? WHERE call_id = ? AND user_id = ?").run(nowISO(), c.id, req.user.id);
  hub.publish(req.org.id, [...st.joined], 'call.left', { callId: Number(c.id), userId: req.user.id });
  if (st.joined.size === 0 || (st.direct && c.answered_at) || (st.joined.size === 1 && c.status === 'ringing' && false)) await endCall(req, c, c.answered_at ? 'ended' : 'cancelled');
  res.json({ ok: true });
});

router.get('/active', async (req, res) => {
  const rows = await db.prepare(`SELECT c.* FROM ci_calls c JOIN ci_members m ON m.conv_id = c.conv_id AND m.user_id = ? AND m.left_at IS NULL WHERE c.org_id = ? AND c.status IN ('ringing', 'active') ORDER BY c.id DESC LIMIT 20`).all(req.user.id, req.org.id);
  const out = [];
  for (const r of rows) if (active.has(Number(r.id))) out.push(await callView(r));
  res.json({ calls: out });
});

// Historique des appels (de mes conversations).
router.get('/', async (req, res) => {
  const where = ['c.org_id = ?']; const args = [req.user.id, req.org.id];
  if (req.query.conv) { where.push('c.conv_id = ?'); args.push(A.id(req.query.conv)); }
  const rows = await db.prepare(`SELECT c.*, cv.kind AS conv_kind, cv.name AS conv_name, u.name AS initiator FROM ci_calls c JOIN ci_members m ON m.conv_id = c.conv_id AND m.user_id = ? AND m.left_at IS NULL
    JOIN ci_conversations cv ON cv.id = c.conv_id LEFT JOIN users u ON u.id = c.initiator_id WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT 100`).all(...args);
  const out = [];
  for (const r of rows) {
    let name = r.conv_name;
    if (r.conv_kind === 'direct') { const o = await db.prepare('SELECT u.name FROM ci_members m JOIN users u ON u.id = m.user_id WHERE m.conv_id = ? AND m.user_id <> ? LIMIT 1').get(r.conv_id, req.user.id); name = o ? o.name : ''; }
    const parts = await db.prepare('SELECT p.user_id, p.state, u.name FROM ci_call_parts p JOIN users u ON u.id = p.user_id WHERE p.call_id = ?').all(r.id);
    out.push({ id: Number(r.id), convId: Number(r.conv_id), convName: name, group: r.conv_kind === 'group', kind: r.kind, status: r.status, initiator: r.initiator || '', initiatorId: r.initiator_id == null ? null : Number(r.initiator_id), startedAt: r.started_at, endedAt: r.ended_at, durationSec: r.answered_at && r.ended_at ? Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.answered_at)) / 1000)) : 0, peak: Number(r.peak), outgoing: Number(r.initiator_id) === req.user.id, joined: parts.filter((p) => ['joined', 'left'].includes(p.state)).map((p) => p.name) });
  }
  res.json({ calls: out });
});

// ---------- Lien avec le module Réunions : annoncer une réunion planifiée dans la conversation ----------
router.post('/meeting-link', async (req, res) => {
  const b = req.body || {};
  const conv = await L.loadConv(req, b.convId);
  const M = require('./meetings-lib');
  const { m } = await M.load(req, b.meetingId); // 404 si la réunion n'existe pas ou n'est pas visible par cette personne (réunion confidentielle)
  const view = await L.postMessage(req, conv, { kind: 'meeting', body: oneLine(m.title, 160), meta: { meetingId: Number(m.id), title: m.title, date: m.date, time: m.start_time, durationMin: Number(m.duration_min) }, noMentions: true });
  res.status(201).json({ message: view });
});
router.get('/meetings/upcoming', async (req, res) => {
  const M = require('./meetings-lib');
  const cfg = await M.getConfig(req.org.id);
  const vis = M.visibleSql(req, cfg);
  const rows = await db.prepare(`SELECT m.id, m.title, m.date, m.start_time, m.duration_min FROM mtg_meetings m WHERE m.org_id = ? AND m.status = 'planned' AND m.date >= ?${vis.sql} ORDER BY m.date, m.start_time LIMIT 30`).all(req.org.id, nowISO().slice(0, 10), ...vis.args);
  res.json({ meetings: rows.map((r) => ({ id: Number(r.id), title: r.title, date: r.date, time: r.start_time, durationMin: Number(r.duration_min) })) });
});

// ---------- Ménage : appels sans réponse, appels orphelins après un redémarrage ----------
async function sweep() {
  const now = Date.now();
  for (const [id, st] of [...active]) {
    const c = await db.prepare('SELECT * FROM ci_calls WHERE id = ?').get(id);
    if (!c || !isOpen(c)) { active.delete(id); continue; }
    if (c.status === 'ringing' && now > st.ringUntil) await endCall({ org: { id: c.org_id } }, c, 'missed');
    else if (st.joined.size === 0) await endCall({ org: { id: c.org_id } }, c, c.answered_at ? 'ended' : 'cancelled');
  }
}
async function closeStale() {
  const rows = await db.prepare("SELECT * FROM ci_calls WHERE status IN ('ringing', 'active')").all();
  for (const c of rows) if (!active.has(Number(c.id))) await endCall({ org: { id: c.org_id } }, c, 'ended');
}

module.exports = { router, sweep, closeStale, iceServers, active, MAX_PARTS };
