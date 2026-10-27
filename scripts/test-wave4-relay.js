'use strict';
// Vague 4 · Passage de relais à un humain par WhatsApp : FAUX socket WhatsApp (mode QR, comme test-waqr), faux serveur d'IA et faux SMTP, aucun appel externe.
// Vérifie : relais déclenché, bon destinataire et ordre de priorité, message à soi-même, anti-doublon, repli e-mail (échec WhatsApp, WhatsApp non connecté,
// mode Meta avec le numéro connecté), anti-rafale (message groupé), heures calmes, numéro de client refusé, bouton de test, droits.
// Lancez-le avec : node scripts/test-wave4-relay.js
const http = require('http');
const { EventEmitter } = require('events');
const { startTestPg } = require('./lib/testdb');
const { fakeSmtp } = require('./lib/fakes');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };
const qp = (x) => Buffer.from(String(x).replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8').replace(/[  ]/g, ' ');

const ai = { next: null };
function fakeAi() {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(ai.next) }] })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}
function fakeLib() {
  const sockets = [];
  return {
    sockets,
    initAuthCreds: () => ({ noiseKey: { public: Buffer.from('pub'), private: Buffer.from('priv') }, registered: false, advSecretKey: 'adv' }),
    DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionReplaced: 440 },
    default(cfg) {
      const ev = new EventEmitter();
      const sock = { cfg, ev, user: null, sent: [], failFor: null, ended: false,
        presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {}, readMessages: async () => {},
        sendMessage: async (jid, content) => { if (sock.failFor && sock.failFor(jid)) throw new Error('connexion fermée par WhatsApp'); sock.sent.push({ jid, text: content.text }); return { key: { id: 'X' } }; },
        requestPairingCode: async () => 'ABCD-1234', logout: async () => {}, end: () => { sock.ended = true; } };
      sockets.push(sock);
      return sock;
    },
  };
}
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
  const a = await fakeAi(); const mails = []; const smtp = await fakeSmtp(mails);
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, WA_QR_ENABLED: '1', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', WS_AI_FREE: '500', AI_PER_MINUTE: '500',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@exemple.test', MAIL_DAY_FREE: '500', SITE_URL: 'https://app.exemple.test' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const waWeb = require('../src/services/waWeb');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  let t = Date.now(); const clock = { now: () => t, sleep: async (ms) => { t += ms; await Promise.resolve(); } };
  const lib = fakeLib();
  waWeb.resetForTest({ clock, loadLib: async () => lib });
  try {
    const owner = client(base); const mgr = client(base); const mem = client(base);
    for (const [c, n] of [[owner, 'Awa'], [mgr, 'Marc'], [mem, 'Paul']]) await c('POST', '/api/register', { name: n, contact: `${n.toLowerCase()}${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`; const R = `${O}/sales/relay`;
    const uid = {};
    for (const [c, role, n] of [[mgr, 'manager', 'marc'], [mem, 'member', 'paul']]) { r = await owner('POST', `${O}/invites`, { role }); await c('POST', '/api/ws/orgs/join', { code: r.json.code }); uid[n] = (await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${n}${stamp}@exemple.com`)).id; }
    const orgRow = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(org);
    uid.awa = orgRow.owner_id;
    const token = orgRow.intake_token;
    await owner('POST', `${O}/sales/catalog`, { name: 'Robe wax', price: 10000 });
    await owner('PUT', `${O}/sales/settings`, { chatEnabled: true });
    const anon = async (body) => { const rr = await fetch(`${base}/api/ws/public/chat/${token}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return await rr.json(); };
    const handoff = async (name, phone, last = 'Je veux parler à un humain, la robe est trop chère') => {
      ai.next = { reply: 'Je vous enregistre.', action: { type: 'register', name, phone } };
      const j = await anon({ message: 'Bonjour' });
      ai.next = { reply: 'Je passe la main.', action: { type: 'handoff', reason: 'Le client demande un humain' } };
      await anon({ message: last, sessionId: j.sessionId });
      return j.chatId;
    };
    const logOf = async (chatId) => { await until(async () => { const x = await db.prepare("SELECT status FROM relay_log WHERE org_id = ? AND chat_id = ?").get(org, chatId); return x && x.status !== 'pending'; }); return await db.prepare('SELECT * FROM relay_log WHERE org_id = ? AND chat_id = ?').get(org, chatId); };
    const connect = async () => {
      await owner('POST', `${O}/sales/wa-qr/start`, { accept: true });
      const sock = lib.sockets[lib.sockets.length - 1];
      sock.user = { id: '237677112233:12@s.whatsapp.net' };
      sock.ev.emit('creds.update', { me: { id: '237677112233:12@s.whatsapp.net' }, registered: true });
      sock.ev.emit('connection.update', { connection: 'open' });
      await until(async () => (await owner('GET', `${O}/sales/wa-qr/status`)).json.status === 'open');
      return sock;
    };

    // ---------- Droits ----------
    console.log('Droits');
    r = await mem('GET', R);
    check('réglages du relais fermés aux membres', r.status === 403);
    r = await mgr('PUT', `${R}/settings`, { enabled: false });
    check('réglages réservés aux administrateurs', r.status === 403);
    r = await mgr('POST', `${R}/test`, {});
    check('bouton de test réservé aux administrateurs', r.status === 403);

    // ---------- Relais par défaut : le propriétaire, sur le numéro connecté (message à soi-même) ----------
    console.log('Relais par défaut (message à soi-même)');
    const sock = await connect();
    r = await owner('GET', R);
    check('par défaut : propriétaire sur le numéro connecté (QR)', r.json.connected && r.json.mode === 'qr' && r.json.connectedNumber === '237677112233' && r.json.contacts.length === 1 && r.json.contacts[0].isDefault && r.json.contacts[0].name === 'Awa', r.json);
    const chatA = await handoff('Zoé Cliente', '655 33 44 55');
    let lg = await logOf(chatA);
    check('relais déclenché : message envoyé, journal « sent » (message à soi-même)', lg.status === 'sent' && lg.channel === 'whatsapp' && /soi-même/.test(lg.detail), lg);
    const m1 = sock.sent[sock.sent.length - 1];
    check('destinataire = le numéro connecté lui-même', m1 && m1.jid === '237677112233@s.whatsapp.net', sock.sent);
    check('message : client, numéro, motif, dernier message, lien de la conversation', /Zoé Cliente/.test(m1.text) && /655 33 44 55/.test(m1.text) && /Le client demande un humain/.test(m1.text) && /trop chère/.test(m1.text) && new RegExp(`https://app.exemple.test/app/${org}/sales`).test(m1.text) && new RegExp(`n° ${chatA}`).test(m1.text), m1.text);
    const nb = Number((await db.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND user_id = ? AND kind = 'handoff'").get(org, uid.awa)).c);
    check('une notice dans l\'application', nb === 1, nb);
    const mailsBefore = mails.length;
    const relay = require('../src/workspace/relay');
    const again = await relay.notifyHandoff(orgRow, await db.prepare('SELECT * FROM chats WHERE id = ?').get(chatA), 'encore');
    await sleep(200);
    check('anti-doublon : un seul message par relais', again.skipped === 'duplicate' && sock.sent.length === 1 && mails.length === mailsBefore, [again, sock.sent.length]);

    // ---------- Responsables prioritaires ----------
    console.log('Responsables prioritaires');
    await db.prepare("INSERT INTO customers (org_id, name, phone, created_at) VALUES (?, 'Client Existant', '655 11 22 33', ?)").run(org, new Date().toISOString());
    r = await owner('PUT', `${R}/contacts`, { contacts: [{ userId: uid.marc, phone: '655 11 22 33' }] });
    check('jamais le numéro d\'un client', r.status === 400 && /client/.test(r.json.error), r.json);
    r = await owner('PUT', `${R}/contacts`, { contacts: [{ userId: uid.paul, phone: '655 99 88 77' }] });
    check('le responsable doit être responsable ou plus (un membre est refusé)', r.status === 400, r.json);
    r = await owner('PUT', `${R}/contacts`, { contacts: [{ userId: 1, phone: 'abc' }] });
    check('numéro invalide refusé', r.status === 400);
    r = await owner('PUT', `${R}/contacts`, { contacts: [1, 2, 3, 4] });
    check('3 responsables au plus', r.status === 400);
    r = await owner('PUT', `${R}/contacts`, { contacts: [{ userId: uid.marc, phone: '655 99 88 77' }, { userId: uid.awa, phone: '237 677 11 22 33' }] });
    check('deux responsables : Marc (priorité 1), Awa (priorité 2, numéro connecté)', r.status === 200);
    const chatB = await handoff('Ben Client', '655 44 55 66');
    lg = await logOf(chatB);
    const mB = sock.sent[sock.sent.length - 1];
    check('priorité 1 : le message part chez Marc', lg.status === 'sent' && mB.jid === '237655998877@s.whatsapp.net' && Number(lg.contact_user) === Number(uid.marc), [lg, sock.sent.map((x) => x.jid)]);
    sock.failFor = (jid) => jid.startsWith('237655998877');
    const chatC = await handoff('Cléo Client', '655 55 66 77');
    lg = await logOf(chatC);
    const mC = sock.sent[sock.sent.length - 1];
    check('priorité 1 injoignable : on passe au responsable suivant (Awa, message à soi-même)', lg.status === 'sent' && mC.jid === '237677112233@s.whatsapp.net' && Number(lg.contact_user) === Number(uid.awa), [lg, mC]);

    // ---------- Échec WhatsApp -> notice + e-mail ----------
    console.log('Repli e-mail');
    sock.failFor = () => true;
    const mails1 = mails.length;
    const chatD = await handoff('Dan Client', '655 66 77 88');
    lg = await logOf(chatD);
    await until(async () => mails.length > mails1);
    check('échec WhatsApp pour tous les responsables : journal « repli e-mail », notice et e-mail de secours', lg.status === 'fallback_email' && /WhatsApp/.test(lg.detail) && mails.length > mails1 && /conversation attend un conseiller/.test(qp(mails[mails.length - 1])), [lg, mails.length - mails1]);
    sock.failFor = null;
    await owner('POST', `${O}/sales/wa-qr/stop`, {});
    await until(async () => (await owner('GET', R)).json.connected === false);
    const mails2 = mails.length;
    const chatE = await handoff('Eli Client', '655 77 88 99');
    lg = await logOf(chatE);
    await until(async () => mails.length > mails2);
    check('WhatsApp non connecté : repli e-mail', lg.status === 'fallback_email' && /connecté/.test(lg.detail) && mails.length > mails2, lg);

    // ---------- Mode Meta : le numéro connecté ne peut pas s'écrire à lui-même ----------
    console.log('Mode Meta');
    const vault = require('../src/services/vault');
    await db.prepare("UPDATE orgs SET wa_mode = 'meta', wa_phone_id = '123456', wa_token = ?, wa_secret = ?, wa_number = '237677112233' WHERE id = ?").run(vault.encrypt('tok-test-0123456789012345'), vault.encrypt('secret-test'), org);
    await owner('PUT', `${R}/contacts`, { contacts: [{ userId: uid.awa, phone: '237 677 11 22 33' }] });
    const mails3 = mails.length;
    const chatF = await handoff('Fay Client', '655 88 99 00');
    lg = await logOf(chatF);
    check('Meta + numéro du responsable = numéro connecté : pas d\'envoi à soi-même, repli e-mail', lg.status === 'fallback_email' && /Meta/.test(lg.detail), lg);
    await db.prepare("UPDATE orgs SET wa_mode = 'qr', wa_phone_id = '', wa_token = '', wa_secret = '', wa_number = '' WHERE id = ?").run(org);
    const sock2 = await connect();

    // ---------- Anti-rafale ----------
    console.log('Anti-rafale');
    await owner('PUT', `${R}/contacts`, { contacts: [] });
    r = await owner('PUT', `${R}/settings`, { maxPerHour: 2 });
    check('plafond d\'alertes par heure réglable', r.status === 200);
    await db.prepare("DELETE FROM relay_log WHERE org_id = ?").run(org);
    const n0 = sock2.sent.length;
    const ids = [];
    for (let i = 0; i < 4; i++) { ids.push(await handoff(`Rafale ${i}`, `65500000${i}`)); await logOf(ids[i]); }
    await sleep(300);
    const sent = sock2.sent.slice(n0);
    const rate = await db.prepare("SELECT COUNT(*) c FROM relay_log WHERE org_id = ? AND status = 'rate'").get(org);
    check('au-delà du plafond : 2 alertes détaillées puis UN seul message groupé, jamais de rafale', sent.length === 3 && /plusieurs conversations/.test(sent[2].text) && Number(rate.c) === 2, [sent.length, rate]);

    // ---------- Heures calmes ----------
    console.log('Heures calmes');
    const h = new Date(Date.now() + 60 * 60000).getUTCHours();
    await owner('PUT', `${R}/settings`, { maxPerHour: 50, quietFrom: h, quietTo: (h + 1) % 24 });
    const n1 = sock2.sent.length; const mails4 = mails.length;
    const chatQ = await handoff('Quiet Client', '655000111');
    lg = await logOf(chatQ);
    await until(async () => mails.length > mails4);
    check('heures calmes : pas de WhatsApp, notice et e-mail', lg.status === 'quiet' && sock2.sent.length === n1 && mails.length > mails4, lg);
    await owner('PUT', `${R}/settings`, { quietFrom: -1, quietTo: -1 });

    // ---------- Désactivation et test ----------
    console.log('Test et désactivation');
    r = await owner('POST', `${R}/test`, {});
    const mT = sock2.sent[sock2.sent.length - 1];
    check('« Envoyer un test » : message de test envoyé', r.status === 200 && r.json.ok && r.json.self && /TEST/.test(mT.text), r.json);
    await owner('PUT', `${R}/settings`, { enabled: false });
    const n2 = sock2.sent.length;
    const chatX = await handoff('Off Client', '655000222');
    await sleep(500);
    check('relais désactivé : aucun message', sock2.sent.length === n2 && !(await db.prepare('SELECT 1 FROM relay_log WHERE org_id = ? AND chat_id = ?').get(org, chatX)));
    r = await owner('GET', R);
    check('journal des alertes (envoyée, regroupée, plafonnée, calme, test)', ['sent', 'grouped', 'rate', 'quiet', 'test_sent'].every((s) => r.json.log.some((l) => l.status === s)), r.json.log.map((l) => l.status));
    check('aucun secret dans les réponses', !/tok-test|secret-test|v1:/.test(JSON.stringify(r.json)));
  } finally {
    try { await waWeb.shutdown(); } catch { /* arrêté */ }
    srv.close(); a.srv.close(); smtp.srv.close();
    await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoué(s).`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
