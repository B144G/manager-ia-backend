'use strict';
// Vague 4 · Critères de passation selon le type d'entreprise (commande / rendez-vous / service / prospect) ; reprend le décor du test du relais.
// (décor d'origine : passage de relais à un humain par WhatsApp : FAUX socket WhatsApp (mode QR, comme test-waqr), faux serveur d'IA et faux SMTP, aucun appel externe.
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
  const HK = require('../src/workspace/handoff-kind');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  let t = Date.now(); const clock = { now: () => t, sleep: async (ms) => { t += ms; await Promise.resolve(); } };
  const lib = fakeLib();
  waWeb.resetForTest({ clock, loadLib: async () => lib });
  try {
    const owner = client(base); const owner2 = client(base);
    await owner('POST', '/api/register', { name: 'Awa', contact: `awa${stamp}@exemple.com`, pass: 'secret123' });
    await owner2('POST', '/api/register', { name: 'Recteur', contact: `rec${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', sector: 'Commerce de vêtements', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`;
    const token = (await db.prepare('SELECT intake_token FROM orgs WHERE id = ?').get(org)).intake_token;
    await owner('POST', `${O}/sales/catalog`, { name: 'Robe wax', price: 10000 });
    await owner('PUT', `${O}/sales/settings`, { chatEnabled: true });
    const anon = async (tk, body) => { const rr = await fetch(`${base}/api/ws/public/chat/${tk}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return await rr.json(); };
    await owner('POST', `${O}/sales/wa-qr/start`, { accept: true });
    const sock = lib.sockets[lib.sockets.length - 1];
    sock.user = { id: '237677112233:12@s.whatsapp.net' };
    sock.ev.emit('creds.update', { me: { id: '237677112233:12@s.whatsapp.net' }, registered: true });
    sock.ev.emit('connection.update', { connection: 'open' });
    await until(async () => (await owner('GET', `${O}/sales/wa-qr/status`)).json.status === 'open');
    const statusOf = async (id) => (await db.prepare('SELECT status FROM chats WHERE id = ?').get(id)).status;

    // ---------- Magasin : bon de commande ----------
    console.log('Magasin : la main passe seulement quand la commande est complète');
    check('type déduit : marchandises (catalogue)', (await HK.kindOf(await db.prepare('SELECT * FROM orgs WHERE id = ?').get(org))) === 'order');
    ai.next = { reply: 'Je vous enregistre.', action: { type: 'register', name: 'Zoé Client', phone: '655 33 44 55' }, lead: {} };
    let j = await anon(token, { message: 'Bonjour, je voudrais une robe' });
    const sid = j.sessionId; const chatId = j.chatId;
    check('inscrit : l\'IA demande la ville, pas de passation', j.handoff !== true && /ville/i.test(j.reply) && await statusOf(chatId) !== 'handoff', j);
    ai.next = { reply: 'Je note votre commande.', action: { type: 'order', items: [{ name: 'Robe wax', quantity: 2 }], note: '' }, lead: { city: 'Douala' } };
    j = await anon(token, { message: 'Douala, 2 robes wax, oui', sessionId: sid });
    check('commande enregistrée mais pas de passation : la date de livraison manque', j.order && !j.handoff && /date/i.test(j.reply) && await statusOf(chatId) !== 'handoff', j);
    ai.next = { reply: 'Très bien.', action: null, lead: { deadline: 'samedi 31 octobre' } };
    j = await anon(token, { message: 'Pour samedi 31 octobre', sessionId: sid });
    check('la date est donnée : on demande le lieu de livraison', !j.handoff && /adresse|quartier/i.test(j.reply) && await statusOf(chatId) !== 'handoff', j);
    ai.next = { reply: 'Parfait.', action: null, lead: { place: 'Bonanjo, rue de la Joie' } };
    j = await anon(token, { message: 'Bonanjo, rue de la Joie', sessionId: sid });
    check('fiche complète : passation faite', j.handoff === true && j.toHuman === true && await statusOf(chatId) === 'handoff', j);
    await until(async () => sock.sent.length > 0);
    const m = sock.sent[sock.sent.length - 1].text;
    check('message WhatsApp à l\'humain : BON DE COMMANDE', /BON DE COMMANDE/.test(m), m);
    check('… avec nom, téléphone, ville, commande, prix, date et lieu de livraison', /Zoé Client/.test(m) && /655 33 44 55/.test(m) && /Douala/.test(m) && /Robe wax × 2/.test(m) && /20 000 FCFA/.test(m.replace(/[\u00a0\u202f]/g, ' ')) && /31 octobre/.test(m) && /Bonanjo/.test(m), m);
    check('… et aucune information manquante signalée', !/non reçues/.test(m), m);

    // ---------- Rendez-vous ----------
    console.log('Rendez-vous : le message dit RENDEZ-VOUS');
    ai.next = { reply: 'Je vous enregistre.', action: { type: 'register', name: 'Paul Rdv', phone: '655 77 88 99' }, lead: { city: 'Yaoundé', place: 'Bastos', deadline: 'jeudi' } };
    j = await anon(token, { message: 'Bonjour' });
    const sid2 = j.sessionId; const chat2 = j.chatId;
    const d = new Date(Date.now() + 3 * 86400000); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    const day = d.toISOString().slice(0, 10);
    ai.next = { reply: 'Rendez-vous noté.', action: { type: 'appointment', date: day, time: '10:00', purpose: 'Essayage' }, lead: {} };
    j = await anon(token, { message: 'Oui, ce créneau', sessionId: sid2 });
    check('rendez-vous créé et passation faite', Boolean(j.appointment) && j.handoff === true, j);
    await until(async () => sock.sent.length > 1);
    const m2 = sock.sent[sock.sent.length - 1].text;
    check('message à l\'humain : RENDEZ-VOUS avec le jour et l\'heure', /RENDEZ-VOUS/.test(m2) && m2.includes(day) && /10:00/.test(m2) && /Paul Rdv/.test(m2), m2);

    // ---------- Cas urgent : passe tout de suite ----------
    console.log('Cas urgent : réclamation, aucune condition');
    ai.next = { reply: 'Je comprends.', action: { type: 'register', name: 'Ami Colère', phone: '655 12 12 12' }, lead: {} };
    j = await anon(token, { message: 'Bonjour' });
    ai.next = { reply: 'Je passe la main.', action: { type: 'handoff', reason: 'Réclamation : article défectueux' } };
    const before = sock.sent.length;
    j = await anon(token, { message: 'Ma robe est déchirée, je veux un remboursement', sessionId: j.sessionId });
    check('passation immédiate malgré la fiche incomplète', j.handoff === true && await statusOf(j.chatId) === 'handoff', j);
    await until(async () => sock.sent.length > before);
    check('… et le message indique ce qui manque', /non reçues/.test(sock.sent[sock.sent.length - 1].text) && /Réclamation/.test(sock.sent[sock.sent.length - 1].text), sock.sent[sock.sent.length - 1].text);

    // ---------- Limite de relances ----------
    console.log('Client qui ne répond pas : après 4 relances on passe la main quand même');
    ai.next = { reply: 'Bonjour.', action: { type: 'register', name: 'Silence Total', phone: '655 20 20 20' }, lead: {} };
    j = await anon(token, { message: 'Bonjour' });
    ai.next = { reply: 'D\'accord.', action: null, lead: {} };
    let last = j;
    for (let i = 0; i < 5 && await statusOf(j.chatId) !== 'handoff'; i++) last = await anon(token, { message: 'hmm', sessionId: j.sessionId });
    check('passation après les relances, sans bloquer le client', await statusOf(j.chatId) === 'handoff', last);

    // ---------- Université : fiche prospect ----------
    console.log('Université : on enregistre le prospect');
    r = await owner2('POST', '/api/ws/orgs', { name: 'Université Horizon', sector: 'Enseignement supérieur', currency: 'FCFA' });
    const org2 = r.json.id; const O2 = `/api/ws/orgs/${org2}`;
    const token2 = (await db.prepare('SELECT intake_token FROM orgs WHERE id = ?').get(org2)).intake_token;
    await owner2('POST', `${O2}/sales/catalog`, { name: 'Licence en gestion', price: 300000 });
    await owner2('PUT', `${O2}/sales/settings`, { chatEnabled: true });
    check('type déduit : prospect (université)', (await HK.kindOf(await db.prepare('SELECT * FROM orgs WHERE id = ?').get(org2))) === 'prospect');
    ai.next = { reply: 'Je vous enregistre.', action: { type: 'register', name: 'Sandra Étudiante', phone: '655 40 40 40' }, lead: {} };
    j = await anon(token2, { message: 'Je veux m\'inscrire' });
    check('programme et ville manquent : on les demande, pas de passation', !j.handoff && /ville|programme|service/i.test(j.reply), j);
    ai.next = { reply: 'Merci.', action: null, lead: { city: 'Douala', need: 'Licence en gestion' } };
    j = await anon(token2, { message: 'Douala, licence en gestion', sessionId: j.sessionId });
    check('ville + programme : passation sans exiger de livraison', j.handoff === true && await statusOf(j.chatId) === 'handoff', j);
    const st = await HK.status(await db.prepare('SELECT * FROM orgs WHERE id = ?').get(org2), await db.prepare('SELECT * FROM chats WHERE id = ?').get(j.chatId));
    check('titre : NOUVEAU PROSPECT', HK.titleOf(st) === 'NOUVEAU PROSPECT', st);

    // ---------- Réglage manuel du type ----------
    await db.prepare("UPDATE orgs SET handoff_kind = 'service' WHERE id = ?").run(org2);
    r = await owner2('PUT', `${O2}/sales/settings`, { handoffKind: 'inconnu' });
    check('type inconnu refusé', r.status === 400, r.json);
    r = await owner2('PUT', `${O2}/sales/settings`, { handoffKind: 'service' });
    const g = await owner2('GET', `${O2}/sales/settings`).catch(() => null);
    check('réglage du type accepté', r.status === 200, r.json);
    check('type forcé par l\'organisation : service', (await HK.kindOf(await db.prepare('SELECT * FROM orgs WHERE id = ?').get(org2))) === 'service');
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close(); smtp.srv && smtp.srv.close && smtp.srv.close(); a.srv.close();
  process.exit(failed ? 1 : 0);
}
main();
