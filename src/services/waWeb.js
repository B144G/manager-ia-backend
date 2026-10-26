'use strict';
// WhatsApp « Appareils connectés » (méthode NON officielle, bibliothèque Baileys) : une session par organisation.
//  - L'état d'authentification est enregistré dans PostgreSQL, valeurs CHIFFRÉES (vault) : jamais de fichier sur disque (le disque de Render est éphémère).
//  - Un verrou consultatif PostgreSQL par organisation évite que deux serveurs ouvrent le même numéro en même temps.
//  - Envois « humains » : indicateur « en train d'écrire », délai aléatoire de 1 à 4 s, plafonds par minute et par jour, file d'attente (jamais de rafale).
//  - On ne répond qu'aux messages ENTRANTS de conversations individuelles ; on n'écrit jamais en premier à un inconnu.
// Rien ici n'écrit dans les journaux le QR code, le code de jumelage, un jeton ou le contenu d'un message.
const config = require('../config');
const vault = require('./vault');
const { log, oneLine, makeSeen } = require('../util');

const SILENT = { level: 'silent', child() { return SILENT; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const digits = (x) => String(x || '').replace(/\D/g, '');
const UNSUPPORTED_SKIP = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage', 'messageContextInfo', 'keepInChatMessage', 'encReactionMessage']);

// Sérialisation des Buffer (même format que Baileys : { type: 'Buffer', data: <base64> })
const replacer = (k, v) => {
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return { type: 'Buffer', data: Buffer.from(v).toString('base64') };
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { type: 'Buffer', data: Buffer.from(v.data).toString('base64') };
  return v;
};
const reviver = (k, v) => {
  if (v && v.type === 'Buffer' && typeof v.data === 'string') return Buffer.from(v.data, 'base64');
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  return v;
};

const defaultLoadLib = async () => await import('@whiskeysockets/baileys'); // import() : fonctionne sur toutes les versions de Node 20+, même si le paquet est « ESM »

function createManager(opts = {}) {
  const db = opts.db || require('../db').db;
  let loadLib = opts.loadLib || defaultLoadLib;
  const clock = opts.clock || { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const lim = () => ({ ...config.waQr, ...(opts.limits || {}) });
  const handlers = opts.handlers || {};     // { processMessage(org, from, payload) } injectable pour les tests
  const sessions = new Map();               // orgId -> état en mémoire
  const seen = makeSeen();
  let lib = null; let libError = ''; let libTried = false;
  let watcher = null;

  const nowISO = () => new Date(clock.now()).toISOString();

  async function getLib() {
    if (lib) return lib;
    if (libTried && libError) return null;
    try { const m = await loadLib(); if (!m) throw new Error('vide'); lib = m; libError = ''; } catch (e) { libTried = true; libError = oneLine(e && e.message, 120); log.warn('WhatsApp par QR code indisponible (bibliothèque non chargée) :', libError); return null; }
    return lib;
  }
  const makeSock = (l) => (typeof l.default === 'function' ? l.default : l.makeWASocket);

  /** Fonction utilisable ? { ok, reason } */
  async function availability() {
    if (!lim().enabled) return { ok: false, reason: "La connexion WhatsApp par QR code est désactivée sur ce serveur." };
    if (!(await getLib())) return { ok: false, reason: "La connexion par QR code n'est pas disponible sur ce serveur (composant manquant). Contactez le support." };
    return { ok: true, reason: '' };
  }

  // ---------- État d'authentification chiffré dans PostgreSQL ----------
  const enc = (v) => vault.encrypt(JSON.stringify(v, replacer));
  const dec = (blob) => { const t = vault.decrypt(blob); return t ? JSON.parse(t, reviver) : null; };
  async function readItem(orgId, key) { const r = await db.prepare('SELECT item_value FROM wa_qr_auth WHERE org_id = ? AND item_key = ?').get(orgId, key); return r ? dec(r.item_value) : null; }
  async function writeItem(orgId, key, value) {
    await db.prepare('INSERT INTO wa_qr_auth (org_id, item_key, item_value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, item_key) DO UPDATE SET item_value = excluded.item_value, updated_at = excluded.updated_at')
      .run(orgId, key, enc(value), nowISO());
  }
  async function clearAuth(orgId) { await db.prepare('DELETE FROM wa_qr_auth WHERE org_id = ?').run(orgId); }

  async function authState(orgId, l) {
    const creds = (await readItem(orgId, 'creds')) || l.initAuthCreds();
    let chain = Promise.resolve();
    const keys = {
      get: async (type, ids) => {
        const out = {};
        await Promise.all(ids.map(async (id) => {
          let v = await readItem(orgId, `${type}:${id}`);
          if (type === 'app-state-sync-key' && v && l.proto && l.proto.Message && l.proto.Message.AppStateSyncKeyData) v = l.proto.Message.AppStateSyncKeyData.fromObject(v);
          out[id] = v;
        }));
        return out;
      },
      set: async (data) => {
        await db.transaction(async () => {
          for (const type of Object.keys(data)) for (const id of Object.keys(data[type])) {
            const v = data[type][id];
            if (v) await writeItem(orgId, `${type}:${id}`, v);
            else await db.prepare('DELETE FROM wa_qr_auth WHERE org_id = ? AND item_key = ?').run(orgId, `${type}:${id}`);
          }
        })();
      },
    };
    const saveCreds = () => { chain = chain.then(() => writeItem(orgId, 'creds', creds)).catch((e) => log.warn('WhatsApp QR : sauvegarde impossible :', oneLine(e.message, 120))); return chain; };
    const store = typeof l.makeCacheableSignalKeyStore === 'function' ? l.makeCacheableSignalKeyStore(keys, SILENT) : keys;
    return { state: { creds, keys: store }, creds, saveCreds };
  }

  // ---------- Session ----------
  const get = (orgId) => sessions.get(Number(orgId));
  const isOpen = (orgId) => { const s = get(orgId); return Boolean(s && s.status === 'open' && s.sock); };
  const openCount = () => [...sessions.values()].filter((s) => s.status !== 'disconnected').length;

  function status(orgId) {
    const s = get(orgId);
    if (!s) return { status: 'disconnected', qr: null, number: '', since: null };
    return { status: s.status, qr: s.status === 'qr' ? s.qr : null, number: s.number || '', since: s.since || null };
  }

  async function setMode(orgId, mode) { await db.prepare('UPDATE orgs SET wa_mode = ? WHERE id = ?').run(mode, orgId); }

  /** Démarre (ou reprend) la session d'une organisation. opts : { accepted: { at, by } } la première fois. */
  async function start(orgId, o = {}) {
    orgId = Number(orgId);
    const av = await availability();
    if (!av.ok) { const e = new Error(av.reason); e.code = 'unavailable'; throw e; }
    const cur = get(orgId);
    if (cur && cur.status !== 'disconnected') return status(orgId);
    if (openCount() >= lim().maxSessions) { const e = new Error("Ce serveur a atteint le nombre maximal de connexions WhatsApp par QR code. Réessayez plus tard."); e.code = 'full'; throw e; }
    if (!(await db.locks.tryAcquire(orgId))) { const e = new Error("Cette connexion est déjà ouverte par un autre serveur. Patientez une minute puis réessayez."); e.code = 'locked'; throw e; }
    if (o.accepted) {
      await db.prepare('INSERT INTO wa_qr_sessions (org_id, accepted_at, accepted_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET accepted_at = excluded.accepted_at, accepted_by = excluded.accepted_by, updated_at = excluded.updated_at')
        .run(orgId, o.accepted.at || nowISO(), o.accepted.by || null, nowISO());
    }
    await setMode(orgId, 'qr');
    const s = { orgId, status: 'connecting', qr: null, number: '', since: null, sock: null, retry: 0, timer: null, stopping: false, q: [], pumping: false, sent: [], jids: new Map(), recent: new Map(), deadline: clock.now() + 5 * 60000, gen: 0 };
    sessions.set(orgId, s);
    await connect(s).catch((e) => { log.warn('WhatsApp QR : ouverture impossible :', oneLine(e.message, 120)); scheduleRetry(s); });
    return status(orgId);
  }

  async function connect(s) {
    const l = await getLib();
    if (!l) throw new Error('bibliothèque absente');
    const { state, creds, saveCreds } = await authState(s.orgId, l);
    s.registered = Boolean(creds.me);
    if (s.registered) s.number = digits(String(creds.me.id || '').split(':')[0].split('@')[0]);
    let version;
    if (typeof l.fetchLatestBaileysVersion === 'function') {
      try { const r = await Promise.race([l.fetchLatestBaileysVersion(), new Promise((res) => setTimeout(() => res(null), 5000))]); if (r && r.version) version = r.version; } catch { /* version intégrée */ }
    }
    const gen = ++s.gen;
    const cfg = { auth: state, logger: SILENT, markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false, getMessage: async () => undefined,
      browser: l.Browsers && l.Browsers.ubuntu ? l.Browsers.ubuntu('Chrome') : ['MANAGER-IA', 'Chrome', '1.0'] };
    if (version) cfg.version = version;
    const sock = makeSock(l)(cfg);
    s.sock = sock;
    sock.ev.on('creds.update', (u) => { Object.assign(creds, u); saveCreds(); });
    sock.ev.on('connection.update', (u) => { if (gen === s.gen) onConnection(s, u, creds).catch((e) => log.warn('WhatsApp QR : événement :', oneLine(e.message, 120))); });
    sock.ev.on('messages.upsert', (ev) => { if (gen === s.gen && ev && ev.type === 'notify') for (const m of ev.messages || []) onMessage(s, m).catch((e) => log.warn('WhatsApp QR : message non traité :', oneLine(e.message, 120))); });
  }

  async function onConnection(s, u, creds) {
    if (s.stopping) return;
    if (u.qr) { s.qr = u.qr; s.status = 'qr'; }
    if (u.connection === 'connecting' && s.status !== 'qr') s.status = 'connecting';
    if (u.connection === 'open') {
      const me = (s.sock && s.sock.user) || creds.me || {};
      s.number = digits(String(me.id || '').split(':')[0].split('@')[0]);
      s.status = 'open'; s.qr = null; s.retry = 0; s.registered = true; s.since = nowISO();
      await db.prepare('UPDATE wa_qr_sessions SET number = ?, since = ?, updated_at = ? WHERE org_id = ?').run(s.number, s.since, nowISO(), s.orgId);
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect && u.lastDisconnect.error;
      const code = Number(err && err.output && err.output.statusCode) || 0;
      const DR = (lib && lib.DisconnectReason) || {};
      const loggedOut = DR.loggedOut || 401;
      s.qr = null;
      try { s.sock && s.sock.ev && s.sock.ev.removeAllListeners && s.sock.ev.removeAllListeners(); } catch { /* ignoré */ }
      s.sock = null;
      if (code === loggedOut) return await teardown(s.orgId, { clear: true });
      if (code === (DR.connectionReplaced || 440)) { await teardown(s.orgId, { clear: false }); return; }
      if (!s.registered && clock.now() > s.deadline) return await teardown(s.orgId, { clear: true });  // QR jamais scanné
      s.status = 'connecting';
      if (code === (DR.restartRequired || 515)) { await connect(s).catch(() => scheduleRetry(s)); return; }
      scheduleRetry(s);
    }
  }

  function scheduleRetry(s) {
    if (s.stopping || get(s.orgId) !== s) return;
    s.status = 'connecting';
    const wait = Math.min(300000, 2000 * 2 ** Math.min(s.retry, 8)); s.retry++;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; if (!s.stopping && get(s.orgId) === s) connect(s).catch(() => scheduleRetry(s)); }, wait);
    if (s.timer.unref) s.timer.unref();
  }

  /** Arrête la session en mémoire ; clear = efface les identifiants (déconnexion définitive). */
  async function teardown(orgId, { clear = false, logout = false } = {}) {
    orgId = Number(orgId);
    const s = get(orgId);
    if (s) {
      s.stopping = true; s.status = 'disconnected'; s.qr = null;
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      const sock = s.sock; s.sock = null; s.gen++;
      if (sock) {
        if (logout) { try { await Promise.race([sock.logout(), new Promise((r) => setTimeout(r, 5000))]); } catch { /* déjà déconnecté */ } }
        try { sock.ev && sock.ev.removeAllListeners && sock.ev.removeAllListeners(); } catch { /* ignoré */ }
        try { if (typeof sock.end === 'function') sock.end(undefined); } catch { /* ignoré */ }
      }
      for (const it of s.q.splice(0)) it.reject(new Error("WhatsApp n'est plus connecté."));
      sessions.delete(orgId);
    }
    if (clear) {
      await clearAuth(orgId);
      await db.prepare('UPDATE wa_qr_sessions SET number = ?, since = NULL, updated_at = ? WHERE org_id = ?').run('', nowISO(), orgId);
      await setMode(orgId, 'meta');
    }
    await db.locks.release(orgId);
  }

  /** Déconnexion voulue par l'administrateur : retire l'appareil côté WhatsApp si possible, efface tout. */
  async function stop(orgId) { await teardown(orgId, { clear: true, logout: true }); }
  /** Suppression de l'organisation : fermeture sans toucher aux données (la base les efface en cascade). */
  async function dropOrg(orgId) { await teardown(orgId, { clear: false }); }

  async function pairing(orgId, phone) {
    const s = get(orgId);
    if (!s || !s.sock || s.status === 'disconnected') throw Object.assign(new Error("Affichez d'abord le QR code, puis demandez le code."), { code: 'state' });
    if (s.status === 'open') throw Object.assign(new Error('WhatsApp est déjà connecté.'), { code: 'state' });
    const n = digits(phone);
    if (n.length < 8 || n.length > 15) throw Object.assign(new Error("Numéro invalide : indiquez-le avec l'indicatif du pays, par exemple 237677112233."), { code: 'input' });
    for (let i = 0; i < 20 && s.status === 'connecting'; i++) await clock.sleep(500);  // la demande n'est possible qu'une fois la connexion prête
    const code = String(await s.sock.requestPairingCode(n)).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (code.length !== 8) throw new Error('Code de jumelage inattendu.');
    return code;
  }

  // ---------- Messages entrants ----------
  function unwrap(msg) { const l = lib || {}; try { return (l.normalizeMessageContent ? l.normalizeMessageContent(msg.message) : msg.message) || {}; } catch { return msg.message || {}; } }
  const tsOf = (m) => { const t = m.messageTimestamp; const n = typeof t === 'object' && t ? (typeof t.toNumber === 'function' ? t.toNumber() : Number(t.low)) : Number(t); return Number.isFinite(n) ? n : 0; };

  async function onMessage(s, msg) {
    const key = (msg && msg.key) || {};
    const jid = String(key.remoteJid || '');
    if (key.fromMe || !msg.message) return;
    if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) return;           // ni groupes, ni statuts, ni diffusions, ni chaînes
    const ts = tsOf(msg);
    if (ts && clock.now() / 1000 - ts > lim().maxAgeMin * 60) return;                // ancien message revu à la reconnexion
    if (key.id && seen(`${s.orgId}:${key.id}`)) return;
    const content = unwrap(msg);
    if (!Object.keys(content).some((k) => !UNSUPPORTED_SKIP.has(k))) return;        // réaction, accusé, etc. : rien à faire
    let from = digits(jid.split('@')[0].split(':')[0]);
    if (jid.endsWith('@lid')) {
      let pn = key.remoteJidAlt || '';
      if (!pn && lib && s.sock && s.sock.signalRepository && s.sock.signalRepository.lidMapping && s.sock.signalRepository.lidMapping.getPNForLID) { try { pn = (await s.sock.signalRepository.lidMapping.getPNForLID(jid)) || ''; } catch { /* inconnu */ } }
      if (pn) from = digits(String(pn).split('@')[0].split(':')[0]);
    }
    if (!from || from.length > 15) return;
    s.jids.set(from, jid); s.recent.set(from, clock.now()); if (s.jids.size > 2000) { s.jids.clear(); s.recent.clear(); }
    const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(s.orgId);
    if (!org) return void (await dropOrg(s.orgId));
    if (org.wa_mode !== 'qr') return;
    try { if (s.sock && s.sock.readMessages) await s.sock.readMessages([key]); } catch { /* sans importance */ }
    const wa = handlers.module || require('../workspace/whatsapp');
    if (wa.tooMany(`${org.id}:${from}`)) return;
    const reply = (t) => sendText(s.orgId, from, t, { reply: true });

    let text = ''; let viaVoice = false; let attachment = null;
    const c = content;
    if (typeof c.conversation === 'string') text = c.conversation;
    else if (c.extendedTextMessage && typeof c.extendedTextMessage.text === 'string') text = c.extendedTextMessage.text;
    else if (c.audioMessage) {
      const stt = require('./stt');
      if (!stt.isConfigured()) return void (await reply(wa.UNSUPPORTED));
      try { const buf = await download(s, msg, c.audioMessage); text = (await stt.transcribe(buf)) || ''; viaVoice = true; } catch (e) { log.warn('WhatsApp QR : message vocal illisible :', oneLine(e.message, 120)); }
      if (!text.trim()) return void (await reply("Je n'ai pas pu comprendre votre message vocal. Pouvez-vous le réécrire ou le renvoyer ?"));
    } else if (c.imageMessage || (c.documentMessage && /pdf/i.test(String(c.documentMessage.mimetype || '')))) {
      const doc = c.imageMessage || c.documentMessage;
      try { attachment = await download(s, msg, doc); } catch (e) { log.warn('WhatsApp QR : pièce jointe illisible :', oneLine(e.message, 120)); return void (await reply("Je n'ai pas pu ouvrir votre fichier. Pouvez-vous le renvoyer ou m'écrire votre demande ?")); }
      text = String(doc.caption || '');
    } else return void (await reply(wa.UNSUPPORTED));
    await wa.processIncoming(org, from, { text, viaVoice, attachment });
  }

  async function download(s, msg, part) {
    if (Number(part.fileLength) > 5 * 1024 * 1024) throw new Error('Média trop volumineux');
    const l = await getLib();
    const buf = await l.downloadMediaMessage(msg, 'buffer', {}, { logger: SILENT, reuploadRequest: s.sock.updateMediaMessage });
    if (!buf || buf.length > 5 * 1024 * 1024) throw new Error('Média trop volumineux');
    return buf;
  }

  // ---------- Envoi « humain » : file d'attente, plafonds, indicateur d'écriture ----------
  async function known(orgId, to) {
    if (await db.prepare("SELECT 1 FROM chats WHERE org_id = ? AND channel = 'whatsapp' AND contact = ?").get(orgId, to)) return true;
    const last = to.slice(-9);
    return (await db.prepare('SELECT phone FROM digest_subs WHERE org_id = ?').all(orgId)).some((r) => digits(r.phone).slice(-9) === last && last.length >= 8);
  }
  const typingMs = (len) => { const lo = 1000 + Math.min(1500, len * 8); const hi = Math.min(4000, 1500 + Math.min(2500, len * 20)); return Math.round(lo + Math.random() * Math.max(0, hi - lo)); };

  function enqueue(s, job) {
    return new Promise((resolve, reject) => {
      if (s.q.length >= lim().maxQueue) return reject(new Error("Trop de messages en attente d'envoi. Réessayez dans quelques minutes."));
      s.q.push({ job, resolve, reject }); pump(s);
    });
  }
  async function pump(s) {
    if (s.pumping) return;
    s.pumping = true;
    try {
      while (s.q.length) {
        const it = s.q.shift();
        try {
          // plafond par minute : on attend (jamais de rafale)
          for (;;) {
            const t = clock.now(); s.sent = s.sent.filter((x) => t - x < 60000);
            if (s.sent.length < lim().perMinute) break;
            await clock.sleep(Math.max(250, s.sent[0] + 60000 - t + 100));
          }
          const day = nowISO().slice(0, 10);
          const row = await db.prepare('SELECT day_key, day_count FROM wa_qr_sessions WHERE org_id = ?').get(s.orgId);
          if (row && row.day_key === day && row.day_count >= lim().perDay) throw new Error(`Plafond de ${lim().perDay} messages par jour atteint pour WhatsApp (protection du numéro). Reprise demain.`);
          if (!s.sock || s.status !== 'open') throw new Error("WhatsApp n'est pas connecté.");
          const res = await it.job(s.sock);
          s.sent.push(clock.now());
          await db.prepare('UPDATE wa_qr_sessions SET day_key = ?, day_count = CASE WHEN day_key = ? THEN day_count + 1 ELSE 1 END WHERE org_id = ?').run(day, day, s.orgId);
          it.resolve(res);
        } catch (e) { it.reject(e); }
      }
    } finally { s.pumping = false; }
  }

  async function prepareSend(orgId, to, o) {
    const s = get(orgId);
    if (!s || s.status !== 'open' || !s.sock) throw new Error("WhatsApp n'est pas connecté.");
    const n = digits(to);
    if (n.length < 8 || n.length > 15) throw new Error('Numéro de téléphone invalide.');
    const lastIn = s.recent.get(n);
    if (!(lastIn && clock.now() - lastIn < 24 * 3600000) && !(await known(Number(orgId), n))) throw new Error("Message refusé : on n'écrit jamais en premier à une personne inconnue.");
    return { s, jid: s.jids.get(n) || `${n}@s.whatsapp.net`, n, o };
  }
  async function humanSend(s, sock, jid, content, len) {
    try { if (sock.presenceSubscribe) await sock.presenceSubscribe(jid); } catch { /* facultatif */ }
    try { await sock.sendPresenceUpdate('composing', jid); } catch { /* facultatif */ }
    await clock.sleep(typingMs(len));
    try { await sock.sendPresenceUpdate('paused', jid); } catch { /* facultatif */ }
    return await sock.sendMessage(jid, content);
  }
  async function sendText(orgId, to, text, o = {}) {
    const { s, jid } = await prepareSend(orgId, to, o);
    const body = String(text || '').slice(0, 4000);
    if (!body.trim()) return null;
    return await enqueue(s, (sock) => humanSend(s, sock, jid, { text: body }, body.length));
  }
  /** kind : 'image' | 'video' | 'audio' (message vocal) | 'document'. */
  async function sendFile(orgId, to, kind, buf, mime, caption) {
    const { s, jid } = await prepareSend(orgId, to, {});
    let content;
    if (kind === 'audio') content = { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    else if (kind === 'document') content = { document: buf, mimetype: mime, fileName: 'document' };
    else content = { [kind]: buf, mimetype: mime, ...(caption ? { caption: String(caption).slice(0, 1000) } : {}) };
    return await enqueue(s, (sock) => humanSend(s, sock, jid, content, 60));
  }

  // ---------- Reprise au démarrage, échelonnée ----------
  async function resumable() {
    return await db.prepare("SELECT q.org_id FROM wa_qr_sessions q JOIN orgs o ON o.id = q.org_id WHERE o.wa_mode = 'qr' AND q.number <> '' ORDER BY q.org_id").all();
  }
  async function resumeAll({ staggerMs = 2000 } = {}) {
    if (!(await availability()).ok) return 0;
    let n = 0;
    for (const r of await resumable()) {
      if (get(r.org_id)) continue;
      try { await start(r.org_id); n++; } catch (e) { if (e.code === 'full') break; }
      if (staggerMs) await clock.sleep(staggerMs);
    }
    return n;
  }
  /** Au démarrage du serveur : reprise échelonnée, puis nouvelle tentative chaque minute (verrou tenu ailleurs, base indisponible…). */
  function startWatcher({ staggerMs = 2000, everyMs = 60000 } = {}) {
    if (watcher) return;
    db.locks.onLost((ids) => { for (const id of ids) teardown(id, { clear: false }).catch(() => {}); });
    const tick = () => resumeAll({ staggerMs }).catch((e) => log.warn('WhatsApp QR : reprise :', oneLine(e.message, 120)));
    const first = setTimeout(tick, 5000); if (first.unref) first.unref();
    watcher = setInterval(tick, everyMs); if (watcher.unref) watcher.unref();
  }
  async function shutdown() {
    if (watcher) { clearInterval(watcher); watcher = null; }
    for (const id of [...sessions.keys()]) await teardown(id, { clear: false });
  }

  return {
    availability, start, stop, dropOrg, pairing, status, isOpen, sendText, sendFile, resumeAll, startWatcher, shutdown, hasSession: (id) => Boolean(get(id)),
    /** Réservé aux tests : remplace le chargeur de la bibliothèque (fabrique de socket factice). */
    setLibLoader(fn) { loadLib = fn; lib = null; libTried = false; libError = ''; },
    _sessions: sessions,
  };
}

// Instance unique du serveur ; ses méthodes sont exposées directement.
let single = null;
const inst = () => single || (single = createManager());
const api = { createManager };
for (const k of ['availability', 'start', 'stop', 'dropOrg', 'pairing', 'status', 'isOpen', 'sendText', 'sendFile', 'resumeAll', 'startWatcher', 'shutdown', 'hasSession', 'setLibLoader']) api[k] = (...a) => inst()[k](...a);
api.instance = inst;
/** Réservé aux tests : remplace l'instance unique (horloge factice, plafonds, bibliothèque factice). */
api.resetForTest = (o) => { single = createManager(o); return single; };
module.exports = api;
