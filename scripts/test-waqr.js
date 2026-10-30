'use strict';
// WhatsApp par QR code (Baileys) avec un FAUX socket : aucun appel réseau réel vers WhatsApp. Faux serveur d'IA local.
// Le serveur tourne dans ce processus (pour injecter la fabrique de socket factice). Lancez : npm run test:waqr
const http = require('http');
const { EventEmitter } = require('events');
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const origOut = process.stdout.write.bind(process.stdout); const origErr = process.stderr.write.bind(process.stderr);
let captured = ''; let printing = false;
process.stdout.write = (c, ...a) => { if (!printing) captured += String(c); return origOut(c, ...a); };
process.stderr.write = (c, ...a) => { if (!printing) captured += String(c); return origErr(c, ...a); };
const say = (t) => { printing = true; console.log(t); printing = false; };
const check = (name, cond, extra) => { if (cond) { passed++; say('  OK   ' + name); } else { failed++; say('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(40); } return false; };

const QR = '2@FAKEQRPAYLOAD-ne-doit-jamais-apparaitre-dans-les-journaux';
const PAIR = 'ABCD1234';
const MSG_TEXT = 'Bonjour, vous avez des chaussures rouges pointure 42 ?';
const SECRET_KEY = 'SUPERSECRETSESSIONKEY-lisible-si-pas-chiffre';

// ---------- Faux serveur d'IA ----------
function fakeAi() {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: '{"reply":"Bonjour de test, voici nos prix.","action":null}' }] })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

// ---------- Fausse bibliothèque Baileys ----------
function fakeLib() {
  const sockets = [];
  const lib = {
    sockets,
    initAuthCreds: () => ({ noiseKey: { public: Buffer.from('pub'), private: Buffer.from('SECRET-PRIV') }, registered: false, advSecretKey: 'adv-secret-xyz' }),
    DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionReplaced: 440 },
    default(cfg) {
      const ev = new EventEmitter();
      const sock = { cfg, ev, user: null, log: [], sent: [], loggedOut: false, ended: false,
        presenceSubscribe: async () => {},
        sendPresenceUpdate: async (t, jid) => { sock.log.push('presence:' + t); sock.last = jid; },
        readMessages: async () => { sock.log.push('read'); },
        sendMessage: async (jid, content) => { sock.log.push('msg'); sock.sent.push({ jid, content }); return { key: { id: 'X' + sock.sent.length } }; },
        requestPairingCode: async () => 'ABCD-1234',
        logout: async () => { sock.loggedOut = true; },
        end: () => { sock.ended = true; },
      };
      sockets.push(sock);
      return sock;
    },
  };
  return lib;
}
const upsert = (sock, m) => sock.ev.emit('messages.upsert', { type: 'notify', messages: [m] });
const nowS = () => Math.floor(Date.now() / 1000);

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t };
  };
}

async function main() {
  const ai = await fakeAi();
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'META_EMBEDDED_CONFIG_ID', 'META_WEBHOOK_VERIFY_TOKEN', 'META_VERIFY_TOKEN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'BREVO_API_KEY', 'MAIL_API_KEY', 'STT_API_KEY']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`, WA_QR_ENABLED: '1' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const waWeb = require('../src/services/waWeb');
  const vault = require('../src/services/vault');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();

  // faux temps : chaque attente avance l'horloge sans attendre pour de vrai
  let t = Date.now(); const sleeps = [];
  const clock = { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; await Promise.resolve(); } };
  const fresh = (o = {}) => waWeb.resetForTest({ clock, ...o });

  try {
    const owner = client(base); const owner2 = client(base); const mgr = client(base); const outsider = client(base);
    await owner('POST', '/api/register', { name: 'Awa', contact: `awa${stamp}@exemple.com`, pass: 'secret123' });
    await owner2('POST', '/api/register', { name: 'Zoe', contact: `zoe${stamp}@exemple.com`, pass: 'secret123' });
    await mgr('POST', '/api/register', { name: 'Paul', contact: `paul${stamp}@exemple.com`, pass: 'secret123' });
    await outsider('POST', '/api/register', { name: 'Ed', contact: `ed${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa' }); const org = r.json.id;
    r = await owner2('POST', '/api/ws/orgs', { name: 'Atelier Zoe' }); const orgB = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/invites`, { role: 'manager' });
    await mgr('POST', '/api/ws/orgs/join', { code: r.json.code });
    const W = `/api/ws/orgs/${org}/sales/wa-qr`; const WB = `/api/ws/orgs/${orgB}/sales/wa-qr`;

    // ---------- 1. Désactivé sans bibliothèque ----------
    console.log('Désactivé sans bibliothèque');
    fresh({ loadLib: async () => { throw new Error('module introuvable'); } });
    r = await owner('GET', `${W}/status`);
    check('status : enabled=false avec un message clair, serveur vivant', r.status === 200 && r.json.enabled === false && r.json.status === 'disconnected' && /disponible|désactivée/.test(r.json.message || ''), r.json);
    r = await owner('POST', `${W}/start`, { accept: true });
    check('start : 503 clair sans bibliothèque', r.status === 503 && /disponible/.test(r.json.error), r.json);
    r = await owner('GET', `/api/ws/orgs/${org}`);
    check('features exposées : metaChannels=false, waQr=true', r.json.features && r.json.features.metaChannels === false && r.json.features.waQr === true, r.json.features);

    // ---------- 2. Démarrage, accord, rôles ----------
    console.log('Démarrage');
    const lib = fakeLib();
    fresh({ loadLib: async () => lib, limits: { perMinute: 3 } });
    r = await mgr('GET', `${W}/status`);
    check('non-administrateur : status -> 403', r.status === 403, r.json);
    r = await mgr('POST', `${W}/start`, { accept: true });
    check('non-administrateur : start -> 403', r.status === 403, r.json);
    r = await outsider('GET', `${W}/status`);
    check('personne extérieure -> 404', r.status === 404, r.json);
    r = await owner('POST', `${W}/start`, {});
    check('start sans accord -> 400', r.status === 400 && /comprends/.test(r.json.error), r.json);
    r = await owner('POST', `${W}/start`, { accept: 'true' });
    check('start avec accord non booléen -> 400', r.status === 400, r.json);
    r = await owner('GET', `${W}/status`);
    check('status : enabled, mode meta, déconnecté, non accepté', r.json.enabled === true && r.json.mode === 'meta' && r.json.status === 'disconnected' && r.json.acknowledged === false && !r.json.qrSvg, r.json);
    r = await owner('POST', `${W}/start`, { accept: true });
    check('start avec accord -> 200, connexion en cours', r.status === 200 && ['connecting', 'qr'].includes(r.json.status) && r.json.acknowledged === true && r.json.mode === 'qr', r.json);
    const row = await db.prepare('SELECT * FROM wa_qr_sessions WHERE org_id = ?').get(org);
    check('date d\'acceptation enregistrée', row && /^\d{4}-\d{2}-\d{2}T/.test(row.accepted_at));
    const sock = lib.sockets[lib.sockets.length - 1];
    check('une seule socket ouverte', lib.sockets.length === 1);

    // ---------- 3. QR puis connexion ----------
    console.log('QR et connexion');
    sock.ev.emit('connection.update', { connection: 'connecting', qr: QR });
    r = await owner('GET', `${W}/status`);
    check('état qr : image SVG du QR fournie', r.json.status === 'qr' && typeof r.json.qrSvg === 'string' && r.json.qrSvg.includes('<svg'), Object.keys(r.json));
    check('la chaîne brute du QR n\'est pas dans la réponse', !r.text.includes('FAKEQRPAYLOAD'));
    sock.ev.emit('connection.update', { qr: QR + '-2' });
    r = await owner('GET', `${W}/status`);
    check('QR renouvelé -> nouvelle image', r.json.status === 'qr' && r.json.qrSvg.includes('<svg'));
    r = await owner('POST', `${W}/pairing`, { phone: '237677112233' });
    check('jumelage : code à 8 caractères', r.status === 200 && /^[A-Z0-9]{8}$/.test(r.json.code) && r.json.code === PAIR, r.json);
    r = await owner('POST', `${W}/pairing`, { phone: 'abc' });
    check('jumelage : numéro invalide -> 400', r.status === 400, r.json);
    r = await owner('POST', `${W}/pairing`, {});
    check('jumelage : numéro absent -> 400', r.status === 400);
    r = await mgr('POST', `${W}/pairing`, { phone: '237677112233' });
    check('jumelage : non-administrateur -> 403', r.status === 403);
    // la bibliothèque enregistre ses clés puis annonce la connexion
    await sock.cfg.auth.keys.set({ session: { 'a.0': Buffer.from(SECRET_KEY) } });
    sock.ev.emit('creds.update', { me: { id: '237677112233:12@s.whatsapp.net' }, registered: true });
    sock.user = { id: '237677112233:12@s.whatsapp.net' };
    sock.ev.emit('connection.update', { connection: 'open' });
    await until(async () => (await owner('GET', `${W}/status`)).json.status === 'open');
    r = await owner('GET', `${W}/status`);
    check('connexion ouverte : numéro et date', r.json.status === 'open' && r.json.number === '237677112233' && Boolean(r.json.since) && !r.json.qrSvg, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/sales`);
    check('réglages de ventes : waNumber vient du mode QR, waConnected vrai', r.json.settings.waNumber === '237677112233' && r.json.settings.waConnected === true && r.json.settings.waMode === 'qr', r.json.settings);

    // ---------- 4. Identifiants chiffrés ----------
    console.log('Identifiants chiffrés en base');
    await sleep(100);
    const auth = await db.prepare('SELECT item_key, item_value FROM wa_qr_auth WHERE org_id = ?').all(org);
    check('identifiants et clés enregistrés', auth.some((x) => x.item_key === 'creds') && auth.some((x) => x.item_key === 'session:a.0'), auth.map((x) => x.item_key));
    check('toutes les valeurs sont chiffrées (v1:)', auth.length > 0 && auth.every((x) => x.item_value.startsWith('v1:')));
    const blob = JSON.stringify(auth);
    check('rien de lisible : ni clé, ni secret, ni numéro', !blob.includes('SUPERSECRET') && !blob.includes('SECRET-PRIV') && !blob.includes('adv-secret-xyz') && !blob.includes('237677112233'));
    check('le déchiffrement redonne les octets d\'origine', Buffer.from((await sock.cfg.auth.keys.get('session', ['a.0']))['a.0']).toString() === SECRET_KEY);

    // ---------- 5. Message entrant -> IA -> réponse ----------
    console.log('Message entrant');
    const client1 = '237655000111';
    sleeps.length = 0;
    upsert(sock, { key: { remoteJid: `${client1}@s.whatsapp.net`, id: 'M1', fromMe: false }, message: { conversation: MSG_TEXT }, messageTimestamp: nowS() });
    const got = await until(() => sock.sent.length >= 1);
    check('la réponse de l\'IA part par le faux socket', got && /Bonjour de test/.test(sock.sent[0].content.text) && sock.sent[0].jid === `${client1}@s.whatsapp.net`, sock.sent);
    check('présence « composing » avant l\'envoi, puis « paused »', sock.log.indexOf('presence:composing') !== -1 && sock.log.indexOf('presence:composing') < sock.log.indexOf('presence:paused') && sock.log.indexOf('presence:paused') < sock.log.indexOf('msg'), sock.log);
    check('délai de 1 à 4 secondes avant l\'envoi', sleeps.some((ms) => ms >= 1000 && ms <= 4000), sleeps);
    const chat = await db.prepare("SELECT * FROM chats WHERE org_id = ? AND channel = 'whatsapp'").get(org);
    check('conversation WhatsApp créée pour la bonne organisation', chat && chat.contact === client1);
    const msgs = await db.prepare('SELECT role FROM chat_messages WHERE chat_id = ?').all(chat.id);
    check('messages du client et de l\'IA enregistrés', msgs.some((m) => m.role === 'user') && msgs.some((m) => m.role === 'assistant'));

    // ---------- 6. Messages ignorés ----------
    console.log('Messages ignorés');
    const before = sock.sent.length; const chatsBefore = (await db.prepare('SELECT COUNT(*) c FROM chats WHERE org_id = ?').get(org)).c;
    upsert(sock, { key: { remoteJid: '120363000000@g.us', participant: `${client1}@s.whatsapp.net`, id: 'G1', fromMe: false }, message: { conversation: 'salut le groupe' }, messageTimestamp: nowS() });
    upsert(sock, { key: { remoteJid: 'status@broadcast', participant: `${client1}@s.whatsapp.net`, id: 'S1', fromMe: false }, message: { conversation: 'mon statut' }, messageTimestamp: nowS() });
    upsert(sock, { key: { remoteJid: `${client1}@s.whatsapp.net`, id: 'F1', fromMe: true }, message: { conversation: 'je me parle' }, messageTimestamp: nowS() });
    upsert(sock, { key: { remoteJid: '237655000222@s.whatsapp.net', id: 'OLD1', fromMe: false }, message: { conversation: 'ancien message' }, messageTimestamp: Math.floor(t / 1000) - 20 * 60 });
    upsert(sock, { key: { remoteJid: `${client1}@s.whatsapp.net`, id: 'M1', fromMe: false }, message: { conversation: MSG_TEXT }, messageTimestamp: nowS() });
    upsert(sock, { key: { remoteJid: '237655000333@s.whatsapp.net', id: 'R1', fromMe: false }, message: { reactionMessage: { text: '👍' } }, messageTimestamp: nowS() });
    sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: '237655000444@s.whatsapp.net', id: 'H1', fromMe: false }, message: { conversation: 'historique' }, messageTimestamp: nowS() }] });
    await sleep(700);
    check('groupe, statut, message de soi, ancien message, doublon, réaction, historique : aucune réponse', sock.sent.length === before, sock.sent.length);
    check('aucune conversation créée par ces messages', (await db.prepare('SELECT COUNT(*) c FROM chats WHERE org_id = ?').get(org)).c === chatsBefore);
    upsert(sock, { key: { remoteJid: '237655000555@s.whatsapp.net', id: 'ST1', fromMe: false }, message: { stickerMessage: {} }, messageTimestamp: nowS() });
    check('type non lisible (autocollant) : message habituel « Je peux lire… »', await until(() => sock.sent.length === before + 1) && /Je peux lire les messages écrits/.test(sock.sent[before].content.text), sock.sent.slice(before));

    // ---------- 7. Plafonds, inconnus, file d'attente ----------
    console.log('Plafonds d\'envoi');
    await db.prepare("UPDATE wa_qr_sessions SET day_key = '', day_count = 0 WHERE org_id = ?").run(org);
    const o = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(org);
    const waOrg = require('../src/services/waOrg');
    check('waOrg : connecté en mode qr', waOrg.modeOf(o) === 'qr' && waOrg.isConnected(o));
    let err = ''; try { await waOrg.sendText(o, '237699999999', 'Bonjour'); } catch (e) { err = e.message; }
    check('jamais écrire en premier à un inconnu', /inconnue/.test(err), err);
    sleeps.length = 0; const n0 = sock.sent.length;
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => waOrg.sendText(o, client1, `Message ${i}`)));
    check('5 messages envoyés dans l\'ordre malgré le plafond de 3 par minute', results.length === 5 && sock.sent.slice(n0).map((x) => x.content.text).join('|') === 'Message 1|Message 2|Message 3|Message 4|Message 5');
    check('le plafond par minute impose une longue attente (pas de rafale)', sleeps.some((ms) => ms >= 30000), sleeps);
    await db.prepare('UPDATE wa_qr_sessions SET day_key = ?, day_count = 1000 WHERE org_id = ?').run(new Date(t).toISOString().slice(0, 10), org);
    fresh({ loadLib: async () => lib, limits: { perMinute: 100, perDay: 1000 } }); // (nouvelle instance : la session en cours est abandonnée plus bas)
    await waWeb.shutdown();

    // ---------- 8. Reprise après redémarrage ----------
    console.log('Reprise après redémarrage');
    const before2 = lib.sockets.length;
    fresh({ loadLib: async () => lib, limits: { perMinute: 100, perDay: 1000 } });
    check('après redémarrage : aucune session en mémoire', waWeb.status(org).status === 'disconnected');
    const n = await waWeb.resumeAll({ staggerMs: 0 });
    const sock2 = lib.sockets[lib.sockets.length - 1];
    check('reprise : session rouverte avec les identifiants de la base', n === 1 && lib.sockets.length === before2 + 1 && sock2.cfg.auth.creds.me && sock2.cfg.auth.creds.me.id === '237677112233:12@s.whatsapp.net' && Buffer.isBuffer(sock2.cfg.auth.creds.noiseKey.private) && sock2.cfg.auth.creds.noiseKey.private.toString() === 'SECRET-PRIV');
    sock2.user = { id: '237677112233:12@s.whatsapp.net' }; sock2.ev.emit('connection.update', { connection: 'open' });
    await until(async () => waWeb.status(org).status === 'open');
    check('reprise : connexion de nouveau ouverte', waWeb.status(org).status === 'open');
    // plafond quotidien
    err = ''; try { await waOrg.sendText(o, client1, 'Encore un'); } catch (e) { err = e.message; }
    check('plafond quotidien atteint : envoi refusé avec message clair', /Plafond de 1000/.test(err), err);
    await db.prepare("UPDATE wa_qr_sessions SET day_count = 0 WHERE org_id = ?").run(org);
    check('après remise à zéro : l\'envoi repasse', Boolean(await waOrg.sendText(o, client1, 'Bonjour de nouveau')));
    // reconnexion automatique après une coupure
    const before3 = lib.sockets.length;
    sock2.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await until(() => lib.sockets.length === before3 + 1);
    check('redémarrage demandé par WhatsApp (515) : reconnexion immédiate', lib.sockets.length === before3 + 1 && waWeb.status(org).status === 'connecting');
    const sock3 = lib.sockets[lib.sockets.length - 1];
    sock3.user = { id: '237677112233:12@s.whatsapp.net' }; sock3.ev.emit('connection.update', { connection: 'open' });
    await until(async () => waWeb.status(org).status === 'open');

    // ---------- 9. Verrou entre processus ----------
    console.log('Verrou consultatif');
    const db2 = await pgt.open();
    const libB = fakeLib();
    const mB = waWeb.createManager({ db: db2, clock, loadLib: async () => libB });
    err = ''; let code = ''; try { await mB.start(org); } catch (e) { err = e.message; code = e.code; }
    check('un second processus ne peut pas ouvrir la même session', code === 'locked' && /autre serveur/.test(err) && libB.sockets.length === 0, { code, err });
    check('l\'autre organisation reste libre pour ce second processus', await db2.locks.tryAcquire(orgB) === true);
    await db2.locks.release(orgB);
    await waWeb.shutdown();
    await mB.start(org);
    check('une fois le verrou libéré, l\'autre processus peut ouvrir la session', libB.sockets.length === 1);
    await mB.shutdown();

    // ---------- 10. Isolation entre organisations ----------
    console.log('Isolation entre organisations');
    const lib2 = fakeLib();
    fresh({ loadLib: async () => lib2, limits: { perMinute: 100 } });
    await waWeb.start(org); const sA = lib2.sockets[0];
    r = await owner2('POST', `${WB}/start`, { accept: true });
    check('organisation B : démarrage indépendant', r.status === 200 && lib2.sockets.length === 2);
    const sB = lib2.sockets[1];
    for (const [s, num] of [[sA, '237600000001'], [sB, '237600000002']]) { s.user = { id: num + ':1@s.whatsapp.net' }; s.ev.emit('creds.update', { me: s.user }); s.ev.emit('connection.update', { connection: 'open' }); }
    await until(async () => waWeb.status(org).status === 'open' && waWeb.status(orgB).status === 'open');
    r = await owner2('GET', `${WB}/status`);
    check('B voit son numéro, pas celui de A', r.json.number === '237600000002');
    r = await owner('GET', `${W}/status`);
    check('A voit son numéro, pas celui de B', r.json.number === '237600000001');
    r = await owner2('GET', `${W}/status`);
    check('B ne peut pas lire l\'état de A -> 404', r.status === 404, r.json);
    r = await owner2('POST', `${W}/stop`);
    check('B ne peut pas déconnecter A -> 404', r.status === 404 && waWeb.status(org).status === 'open');
    upsert(sB, { key: { remoteJid: '237655999888@s.whatsapp.net', id: 'B1', fromMe: false }, message: { conversation: 'Bonjour atelier' }, messageTimestamp: nowS() });
    await until(() => sB.sent.length >= 1);
    check('le message reçu par B est traité et répondu par la socket de B seulement', sB.sent.length === 1 && sA.sent.length === 0);
    const chB = await db.prepare("SELECT org_id FROM chats WHERE contact = '237655999888'").all();
    check('la conversation appartient à B', chB.length === 1 && chB[0].org_id === orgB);

    // ---------- 11. Déconnexion ----------
    console.log('Déconnexion');
    r = await mgr('POST', `${W}/stop`);
    check('stop : non-administrateur -> 403', r.status === 403);
    r = await owner('POST', `${W}/stop`);
    check('stop : appareil retiré côté WhatsApp, état déconnecté, mode meta', r.status === 200 && sA.loggedOut === true && r.json.status === 'disconnected' && r.json.mode === 'meta', r.json);
    check('stop : identifiants effacés de la base', (await db.prepare('SELECT COUNT(*) c FROM wa_qr_auth WHERE org_id = ?').get(org)).c === 0);
    check('stop : l\'autre organisation reste connectée', waWeb.status(orgB).status === 'open' && (await db.prepare('SELECT COUNT(*) c FROM wa_qr_auth WHERE org_id = ?').get(orgB)).c > 0);
    // loggedOut déclenché par WhatsApp
    r = await owner('POST', `${W}/start`, { accept: true });
    const sC = lib2.sockets[lib2.sockets.length - 1];
    await sC.cfg.auth.keys.set({ session: { 'b.1': Buffer.from('x') } });
    sC.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await until(async () => (await db.prepare('SELECT COUNT(*) c FROM wa_qr_auth WHERE org_id = ?').get(org)).c === 0 && waWeb.status(org).status === 'disconnected');
    r = await owner('GET', `${W}/status`);
    check('déconnexion par WhatsApp (loggedOut) : identifiants effacés, état « déconnecté », mode meta', r.json.status === 'disconnected' && r.json.mode === 'meta' && (await db.prepare('SELECT COUNT(*) c FROM wa_qr_auth WHERE org_id = ?').get(org)).c === 0, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/sales`);
    check('après déconnexion : waConnected faux', r.json.settings.waConnected === false && r.json.settings.waMode === 'meta');

    // ---------- 12. Plafond de sessions et suppression d'organisation ----------
    console.log('Plafond de sessions, suppression');
    const lib3 = fakeLib();
    fresh({ loadLib: async () => lib3, limits: { maxSessions: 1 } });
    await waWeb.start(orgB);
    err = ''; code = ''; try { await waWeb.start(org); } catch (e) { err = e.message; code = e.code; }
    check('plafond de sessions simultanées respecté', code === 'full' && /maximal/.test(err), { code, err });
    await waWeb.shutdown();
    fresh({ loadLib: async () => lib3 });
    await waWeb.start(orgB);
    check('session de B en mémoire avant suppression', waWeb.hasSession(orgB));
    r = await owner2('DELETE', `/api/ws/orgs/${orgB}`, { confirm: 'Atelier Zoe' });
    check('suppression de l\'organisation -> session fermée et données effacées', r.status === 200 && !waWeb.hasSession(orgB) && lib3.sockets[lib3.sockets.length - 1].ended === true && (await db.prepare('SELECT COUNT(*) c FROM wa_qr_auth WHERE org_id = ?').get(orgB)).c === 0 && !(await db.prepare('SELECT 1 FROM wa_qr_sessions WHERE org_id = ?').get(orgB)));

    // ---------- 13. Bibliothèque réelle (sans réseau) ----------
    console.log('Bibliothèque réelle');
    const real = waWeb.createManager({ db });
    const av = await real.availability();
    check('la vraie bibliothèque se charge (import dynamique)', av.ok === true, av);
    const mod = await import('@whiskeysockets/baileys');
    check('elle expose la socket, les identifiants, les codes de fermeture', typeof mod.default === 'function' && typeof mod.initAuthCreds === 'function' && mod.DisconnectReason && mod.DisconnectReason.loggedOut === 401 && typeof mod.makeCacheableSignalKeyStore === 'function' && typeof mod.downloadMediaMessage === 'function');
    check('elle crée des identifiants neufs avec des clés binaires', Boolean(mod.initAuthCreds().noiseKey && mod.initAuthCreds().noiseKey.private));

    // ---------- 14. Journaux ----------
    console.log('Journaux');
    check('journal d\'audit : start et stop enregistrés', (await db.prepare("SELECT COUNT(*) c FROM audit_trail WHERE action IN ('channel.wa_qr_start','channel.wa_qr_stop')").get()).c >= 2);
    const audit = JSON.stringify(await db.prepare('SELECT * FROM audit_trail').all().catch(() => []));
    check('le QR et le code de jumelage ne sont dans aucun journal ni audit', !captured.includes('FAKEQRPAYLOAD') && !captured.includes(PAIR) && !audit.includes('FAKEQR') && !audit.includes(PAIR) && !audit.includes('237677112233'));
    check('aucun contenu de message ni clé dans les journaux', !captured.includes('chaussures') && !captured.includes('SUPERSECRET') && !captured.includes('Bonjour atelier'));
    const act = JSON.stringify(await db.prepare('SELECT text FROM activity').all());
    check('journal d\'activité : démarrage et arrêt notés, sans secret', /QR code/.test(act) && !act.includes('FAKEQR'));
    void vault;
  } finally {
    try { await waWeb.shutdown(); } catch { /* ignoré */ }
    srv.close(); ai.srv.close();
    try { await db.close(); } catch { /* ignoré */ }
    await pgt.stop();
  }
  say(`\n${passed} cas réussis, ${failed} échec(s)`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { say('ERREUR : ' + (e && e.stack || e)); process.exit(1); });
