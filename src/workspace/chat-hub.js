'use strict';
// Chat interne : bus temps réel en mémoire (un seul processus, comme l'hébergement actuel sur Render).
//  - flux SSE par personne (GET /chat/stream), avec battement de cœur ;
//  - tampon des derniers événements de chaque personne, relu par l'interrogation périodique (GET /chat/updates) quand le flux tombe ;
//  - présence (en ligne / hors ligne) et indicateurs « en train d'écrire ».
// LIMITE ASSUMÉE : si le serveur tourne en plusieurs processus, ce bus doit être remplacé (Redis, LISTEN/NOTIFY…). Voir docs/chat-interne.md.
const crypto = require('crypto');

const EPOCH = crypto.randomBytes(6).toString('hex'); // change à chaque démarrage : les clients voient qu'ils doivent tout recharger
const RING_MAX = 300;
const ONLINE_MS = 45 * 1000;      // sans signe de vie depuis ce délai : hors ligne
const TYPING_MS = 7 * 1000;       // « écrit… » s'éteint seul après ce délai
const ACTIVE_RING_MS = 20 * 60 * 1000; // on ne garde un tampon que pour les personnes vues récemment
const MAX_STREAMS_PER_USER = 4;

let seq = 0;
const key = (orgId, userId) => `${orgId}:${userId}`;
const users = new Map(); // key -> { orgId, userId, ring: [], streams: Set<res>, seen: number, state: Map<convId,{kind,at}> }
const typing = new Map(); // `${convId}:${userId}` -> { kind, at }

function entry(orgId, userId, create = true) {
  const k = key(orgId, userId);
  let e = users.get(k);
  if (!e && create) { e = { orgId: Number(orgId), userId: Number(userId), ring: [], streams: new Set(), seen: Date.now() }; users.set(k, e); }
  return e;
}
/** Signe de vie : la personne est en ligne (requête du chat, flux ouvert). Renvoie true si elle vient d'apparaître. */
function touch(orgId, userId) {
  const e = entry(orgId, userId);
  const wasOnline = isOnline(orgId, userId);
  e.seen = Date.now();
  return !wasOnline;
}
function isOnline(orgId, userId) {
  const e = entry(orgId, userId, false);
  return Boolean(e && (e.streams.size > 0 || Date.now() - e.seen < ONLINE_MS));
}
const lastSeen = (orgId, userId) => { const e = entry(orgId, userId, false); return e ? new Date(e.seen).toISOString() : null; };
const sseSend = (res, ev) => { try { res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`); } catch { /* flux fermé */ } };

/** Envoie un événement à ces personnes (flux ouverts + tampon pour l'interrogation). */
function publish(orgId, userIds, type, data, { buffer = true } = {}) {
  const ev = { seq: ++seq, type, data, at: Date.now() };
  for (const uid of new Set(userIds)) {
    const e = entry(orgId, uid, false);
    if (!e) continue; // personne jamais vue depuis le démarrage : elle rechargera tout à son arrivée
    if (buffer) { e.ring.push(ev); if (e.ring.length > RING_MAX) e.ring.splice(0, e.ring.length - RING_MAX); }
    for (const res of e.streams) sseSend(res, ev);
  }
  return ev.seq;
}
/** Tous les flux ouverts de l'organisation (présence). */
function publishOrg(orgId, type, data, exceptUser) {
  const ev = { seq: ++seq, type, data, at: Date.now() };
  for (const e of users.values()) if (e.orgId === Number(orgId) && e.userId !== exceptUser) for (const res of e.streams) sseSend(res, ev);
}

/** Événements depuis `after` (interrogation). `reset` : le tampon ne couvre plus l'écart, le client recharge tout. */
function since(orgId, userId, after, epoch) {
  const e = entry(orgId, userId);
  e.seen = Date.now();
  if (epoch !== EPOCH) return { epoch: EPOCH, seq, reset: true, events: [] };
  const cut = Date.now() - TYPING_MS;
  const events = e.ring.filter((x) => x.seq > after && !(x.type === 'typing' && x.at < cut));
  const first = e.ring[0];
  if (after > 0 && first && first.seq > after + 1 && e.ring.length >= RING_MAX) return { epoch: EPOCH, seq, reset: true, events: [] }; // tampon saturé
  return { epoch: EPOCH, seq, reset: false, events: events.map((x) => ({ seq: x.seq, type: x.type, data: x.data })) };
}

/** Ouvre le flux SSE d'une personne. `onOpen` / `onClose` : présence. Renvoie false si trop de flux. */
function openStream(req, res, orgId, userId, { onOpen, onClose } = {}) {
  const e = entry(orgId, userId);
  while (e.streams.size >= MAX_STREAMS_PER_USER) { const old = e.streams.values().next().value; try { old.end(); } catch { /* */ } e.streams.delete(old); } // onglets oubliés : on ferme les plus anciens
  req.socket.setTimeout(0); req.socket.setNoDelay(true);
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 4000\n\n');
  const wasOnline = isOnline(orgId, userId);
  e.streams.add(res); e.seen = Date.now();
  sseSend(res, { seq, type: 'hello', data: { epoch: EPOCH, seq } });
  const beat = setInterval(() => { e.seen = Date.now(); try { res.write('event: ping\ndata: 1\n\n'); } catch { /* */ } }, 20000);
  req.on('close', () => { clearInterval(beat); e.streams.delete(res); e.seen = Date.now(); if (onClose) onClose(); });
  if (!wasOnline && onOpen) onOpen();
  return true;
}

function setTyping(orgId, convId, userId, kind) {
  const k = `${convId}:${userId}`;
  if (!kind) typing.delete(k); else typing.set(k, { kind, at: Date.now(), orgId: Number(orgId) });
}
/** Qui écrit / enregistre dans cette conversation (hors la personne elle-même). */
function typingIn(convId, exceptUser) {
  const out = [];
  const cut = Date.now() - TYPING_MS;
  for (const [k, v] of typing) {
    if (v.at < cut) { typing.delete(k); continue; }
    const [c, u] = k.split(':').map(Number);
    if (c === Number(convId) && u !== exceptUser) out.push({ userId: u, kind: v.kind });
  }
  return out;
}

// Ménage : tampons des personnes inactives, indicateurs d'écriture périmés.
const sweep = setInterval(() => {
  const old = Date.now() - ACTIVE_RING_MS;
  for (const [k, e] of users) if (!e.streams.size && e.seen < old) users.delete(k);
  const cut = Date.now() - TYPING_MS;
  for (const [k, v] of typing) if (v.at < cut) typing.delete(k);
}, 60 * 1000);
if (sweep.unref) sweep.unref();

const _reset = () => { users.clear(); typing.clear(); }; // tests
module.exports = { EPOCH, touch, isOnline, lastSeen, publish, publishOrg, since, openStream, setTyping, typingIn, ONLINE_MS, TYPING_MS, _reset };
