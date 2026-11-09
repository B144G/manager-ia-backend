'use strict';
// « Suivi de l'IA » : exclusion totale ou partielle de l'IA par contact (prix, commande, rendez-vous, relances, brouillons à valider), levée manuelle et
// automatique (à la lecture), règle qui suit le contact sur plusieurs fils, création d'une fiche client depuis un contact inconnu, flux « depuis l'identifiant X »,
// tableau (recherche, filtres, tri, pagination sans limite silencieuse), isolation entre organisations, droits par rôle, et confidentialité vis-à-vis de
// l'administration de la plateforme. FAUX socket WhatsApp (mode QR) et faux serveur d'IA : aucun appel externe.
// Lancez-le avec : node scripts/test-ai-follow.js
const http = require('http');
const { EventEmitter } = require('events');
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };

const ai = { next: null, calls: 0 };
function fakeAi() {
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let sys = '';
      try { const j = JSON.parse(b); sys = Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n') : String(j.system || ''); } catch { /* corps illisible */ }
      if (/assistant commercial public/.test(sys)) ai.calls++;           // on ne compte que les réponses faites aux clients (pas les dossiers internes)
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(ai.next || { reply: 'Bonjour, comment puis-je vous aider ?', action: null }) }] }));
    });
  });
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
      const sock = { cfg, ev, user: null, sent: [], ended: false,
        presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {}, readMessages: async () => {},
        sendMessage: async (jid, content) => { sock.sent.push({ jid, text: content.text }); return { key: { id: 'X' } }; },
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
  const a = await fakeAi();
  const pgt = await startTestPg();
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, WA_QR_ENABLED: '1', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0',
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', WS_AI_FREE: '500', AI_PER_MINUTE: '500', REMINDER_HOUR: '0', SITE_URL: 'https://app.exemple.test' });
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'BREVO_API_KEY', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'BUSINESS_FILE', 'KNOWLEDGE_DIR']) process.env[k] = '';
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const waWeb = require('../src/services/waWeb');
  const whatsapp = require('../src/workspace/whatsapp');
  const R = require('../src/workspace/ai-rules');
  const waOut = require('../src/workspace/wa-out');
  const apptMod = require('../src/workspace/sales-appt');
  const followups = require('../src/workspace/followups');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  let t = Date.now(); const clock = { now: () => t, sleep: async (ms) => { t += ms; await Promise.resolve(); } };
  const lib = fakeLib();
  waWeb.resetForTest({ clock, loadLib: async () => lib });
  try {
    const owner = client(base); const mgr = client(base); const mem = client(base); const zoe = client(base); const adm = client(base);
    for (const [c, n] of [[owner, 'Awa'], [mgr, 'Marc'], [mem, 'Paul'], [zoe, 'Zoe']]) await c('POST', '/api/register', { name: n, contact: `${n.toLowerCase()}${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`; const F = `${O}/aifollow`;
    r = await zoe('POST', '/api/ws/orgs', { name: 'Autre Société', currency: 'FCFA' });
    const org2 = r.json.id; const O2 = `/api/ws/orgs/${org2}`;
    const uid = {};
    for (const [c, role, n] of [[mgr, 'manager', 'marc'], [mem, 'member', 'paul']]) { r = await owner('POST', `${O}/invites`, { role }); await c('POST', '/api/ws/orgs/join', { code: r.json.code }); uid[n] = (await db.prepare('SELECT id FROM users WHERE name = ?').get(n[0].toUpperCase() + n.slice(1))).id; }
    const orgRow = async (id = org) => await db.prepare('SELECT * FROM orgs WHERE id = ?').get(id);
    uid.awa = (await orgRow()).owner_id;
    const token = (await orgRow()).intake_token;
    await owner('POST', `${O}/sales/catalog`, { name: 'Robe wax', price: 10000, floorPrice: 6000 });
    await owner('PUT', `${O}/sales/settings`, { chatEnabled: true });
    await owner('PUT', `${O}/sales/negotiation/settings`, { enabled: true });
    await zoe('POST', `${O2}/sales/catalog`, { name: 'Pagne', price: 5000 });
    await zoe('PUT', `${O2}/sales/settings`, { chatEnabled: true });

    // WhatsApp (mode QR, faux socket)
    await owner('POST', `${O}/sales/wa-qr/start`, { accept: true });
    const sock = lib.sockets[lib.sockets.length - 1];
    sock.user = { id: '237677112233:12@s.whatsapp.net' };
    sock.ev.emit('creds.update', { me: { id: '237677112233:12@s.whatsapp.net' }, registered: true });
    sock.ev.emit('connection.update', { connection: 'open' });
    await until(async () => (await owner('GET', `${O}/sales/wa-qr/status`)).json.status === 'open');

    const incoming = async (from, text) => { await whatsapp.processIncoming(await orgRow(), from, { text }); };
    const sentTo = (from) => sock.sent.filter((x) => x.jid === `${from}@s.whatsapp.net`);
    const chatOf = async (from) => await db.prepare("SELECT * FROM chats WHERE org_id = ? AND channel = 'whatsapp' AND contact = ?").get(org, from);
    const msgs = async (chatId) => await db.prepare('SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id').all(chatId);
    const reopen = async (chatId) => owner('PUT', `${O}/sales/chats/${chatId}/status`, { status: 'open' });
    const anon = async (body, tk = token) => { const rr = await fetch(`${base}/api/ws/public/chat/${tk}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return await rr.json(); };
    const ordersCount = async () => Number((await db.prepare("SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'order'").get(org)).c);
    const apptCount = async () => Number((await db.prepare('SELECT COUNT(*) c FROM appointments WHERE org_id = ?').get(org)).c);
    const negCount = async () => Number((await db.prepare('SELECT COUNT(*) c FROM neg_log WHERE org_id = ?').get(org)).c);
    const contactOf = async (q) => (await owner('GET', `${F}/contacts?q=${encodeURIComponent(q)}`)).json.contacts[0];

    const A1 = '237655112233';

    // ---------- 1. Message entrant : l'IA répond normalement ----------
    console.log('1. Sans règle : l\'IA répond');
    ai.next = { reply: 'Bonjour, comment puis-je vous aider ?', action: null };
    const c0 = ai.calls;
    await incoming(A1, 'Bonjour');
    const chatA = await chatOf(A1);
    check('message entrant enregistré', (await msgs(chatA.id)).some((m) => m.role === 'user' && m.content === 'Bonjour'));
    check('l\'IA a répondu au client (appel à l\'IA et message envoyé)', ai.calls === c0 + 1 && sentTo(A1).length === 1 && /Bonjour, comment/.test(sentTo(A1)[0].text), [ai.calls - c0, sentTo(A1).length]);
    check('réponse enregistrée comme message de l\'IA', (await msgs(chatA.id)).some((m) => m.role === 'assistant'));
    r = await owner('GET', `${F}/contacts`);
    let cA = r.json.contacts.find((c) => c.chatId === Number(chatA.id));
    check('tableau : le contact WhatsApp sans fiche apparaît, « IA active »', cA && !cA.hasCustomer && cA.stage === 'contact' && cA.state === 'active' && cA.channel === 'whatsapp' && cA.messages === 2 && /Bonjour/.test(cA.lastText), cA);

    // ---------- 2. Exclusion totale ----------
    console.log('2. Exclusion totale');
    r = await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'full', duration: '24h', reason: 'Litige-confidentiel' });
    check('exclusion enregistrée (24 h, avec motif)', r.status === 201 && r.json.expiresAt, r.json);
    const delta = Date.parse(r.json.expiresAt) - Date.now();
    check('échéance à 24 h', Math.abs(delta - 86400000) < 60000, delta);
    const c1 = ai.calls; const s1 = sentTo(A1).length; const m1 = (await msgs(chatA.id)).length;
    await incoming(A1, 'Je veux savoir où est ma commande');
    check('exclu : aucun appel à l\'IA et aucune réponse envoyée', ai.calls === c1 && sentTo(A1).length === s1, [ai.calls - c1, sentTo(A1).length - s1]);
    const after = await msgs(chatA.id);
    check('exclu : le message du client est quand même enregistré, sans réponse de l\'IA', after.length === m1 + 1 && after[after.length - 1].role === 'user' && /commande/.test(after[after.length - 1].content));
    check('exclu : l\'équipe est prévenue (notice pour les responsables)', Number((await db.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND kind = 'aifollow' AND ref = ?").get(org, `aichat:${chatA.id}`)).c) >= 1);
    await incoming(A1, 'Allô ?');
    const nb = Number((await db.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND user_id = ? AND kind = 'aifollow' AND ref = ?").get(org, uid.awa, `aichat:${chatA.id}`)).c);
    check('une seule notice non lue par conversation (pas de rafale)', nb === 1, nb);
    cA = (await owner('GET', `${F}/contacts?state=excluded`)).json.contacts.find((c) => c.chatId === Number(chatA.id));
    check('tableau : état « Exclu » avec durée et motif', cA && cA.state === 'excluded' && cA.rule.mode === 'full' && cA.rule.expiresAt && cA.rule.reason === 'Litige-confidentiel', cA && cA.rule);
    r = await owner('GET', `${O}/sales/chats/${chatA.id}`);
    check('vue conversation : l\'état d\'exclusion est visible', r.json.rule && r.json.rule.excluded && r.json.person.label.includes('655112233'), r.json.rule);
    // WhatsApp inclut aussi les messages automatiques « je n'ai pas compris » : aucun pour un contact exclu
    const sBefore = sentTo(A1).length;
    await whatsapp.processBody(await orgRow(), { object: 'whatsapp_business_account', entry: [] });
    check('aucun message automatique après exclusion', sentTo(A1).length === sBefore);
    // Site : un visiteur exclu (même fiche) ne reçoit qu'un texte fixe, non enregistré
    // Levée manuelle
    r = await owner('POST', `${F}/rules/lift`, { chatId: chatA.id });
    check('levée manuelle', r.status === 200 && r.json.lifted === 1, r.json);
    ai.next = { reply: 'Votre commande est en préparation.', action: null };
    const c2 = ai.calls;
    await incoming(A1, 'Alors ?');
    check('après la levée : l\'IA répond de nouveau', ai.calls === c2 + 1 && /préparation/.test(sentTo(A1).slice(-1)[0].text));

    // ---------- 3. Expiration automatique (à la lecture ET à l'envoi) ----------
    console.log('3. Expiration automatique');
    await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'full', duration: '24h' });
    await db.prepare("UPDATE ai_rules SET expires_at = ? WHERE org_id = ?").run(new Date(Date.now() - 1000).toISOString(), org);
    r = await owner('GET', `${F}/contacts?state=excluded`);
    check('lecture : une exclusion échue n\'est plus affichée', !r.json.contacts.some((c) => c.chatId === Number(chatA.id)));
    check('lecture : la règle échue est levée et inscrite au journal', !(await db.prepare('SELECT 1 FROM ai_rules WHERE org_id = ?').get(org)) && (await db.prepare("SELECT 1 FROM ai_rule_log WHERE org_id = ? AND action = 'auto_lift'").get(org)));
    await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'full', duration: '7d' });
    r = await owner('GET', `${F}/rules/current?chatId=${chatA.id}`);
    check('durée 7 jours', r.json.rule && Math.abs(Date.parse(r.json.rule.expiresAt) - Date.now() - 7 * 86400000) < 60000);
    await db.prepare("UPDATE ai_rules SET expires_at = ? WHERE org_id = ?").run(new Date(Date.now() - 1000).toISOString(), org);
    const c3 = ai.calls;
    await incoming(A1, 'Bonsoir');
    check('envoi : exclusion échue sans tâche périodique → l\'IA répond à l\'arrivée du message', ai.calls === c3 + 1);
    check('envoi : la règle échue a été levée (journal « auto_lift » ×2)', Number((await db.prepare("SELECT COUNT(*) c FROM ai_rule_log WHERE org_id = ? AND action = 'auto_lift'").get(org)).c) === 2);
    await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'full', duration: 'none' });
    r = await owner('GET', `${F}/rules/current?chatId=${chatA.id}`);
    check('sans limite : pas d\'échéance', r.json.rule && r.json.rule.expiresAt === null);
    await db.prepare("UPDATE ai_rules SET created_at = ? WHERE org_id = ?").run(new Date(Date.now() - 400 * 86400000).toISOString(), org);
    check('tâche périodique : ne touche pas une règle sans limite', (await R.liftAllExpired()) === 0 && Boolean(await db.prepare('SELECT 1 FROM ai_rules WHERE org_id = ?').get(org)));
    await owner('POST', `${F}/rules/lift`, { chatId: chatA.id });

    // ---------- 4. Validation des demandes ----------
    console.log('4. Validation des demandes');
    r = await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'partial', duration: '24h' });
    check('exclusion partielle sans case cochée refusée', r.status === 400, r.json);
    r = await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'partial', flags: { noPrice: true }, duration: '3 mois' });
    check('durée inconnue refusée', r.status === 400, r.json);
    r = await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'tout' });
    check('mode inconnu refusé', r.status === 400, r.json);
    r = await owner('POST', `${F}/rules`, { mode: 'full' });
    check('cible manquante refusée', r.status === 400, r.json);
    r = await owner('POST', `${F}/rules`, { chatId: 999999, mode: 'full' });
    check('conversation inconnue : 404', r.status === 404, r.json);

    // ---------- 5. Exclusion partielle : prix ----------
    console.log('5. Exclusion partielle : prix');
    await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'partial', flags: { noPrice: true }, duration: 'none', reason: 'Prix fixés à la main' });
    await reopen(chatA.id);
    ai.next = { reply: 'La robe wax coûte 10 000 FCFA.', action: null };
    const s5 = sentTo(A1).length;
    await incoming(A1, 'Combien coûte la robe ?');
    let last = sentTo(A1).slice(s5).map((x) => x.text).join(' | ');
    check('pas de prix : un montant cité par l\'IA n\'est jamais envoyé', sentTo(A1).length > s5 && !/10\s?000/.test(last) && /conseiller/.test(last), last);
    check('pas de prix : un conseiller reprend la main (« à reprendre »)', (await chatOf(A1)).status === 'handoff');
    await reopen(chatA.id);
    const n5 = await negCount();
    ai.next = { reply: 'Je peux vous le faire à 8 000.', action: { type: 'negotiate', item: 'Robe wax', quantity: 1, customer_offer: 8000, price: 8000 } };
    const s5b = sentTo(A1).length;
    await incoming(A1, 'Faites-moi 8000');
    last = sentTo(A1).slice(s5b).map((x) => x.text).join(' | ');
    check('pas de négociation : action refusée, aucune ligne dans le journal de négociation, aucun prix envoyé', (await negCount()) === n5 && !/8\s?000/.test(last), [await negCount(), n5, last]);
    r = await owner('GET', `${O}/aifollow/contacts?state=partial`);
    check('tableau : « Exclusion partielle » ou « En attente d\'un conseiller » selon la priorité', r.json.counts.partial + r.json.counts.waiting >= 1, r.json.counts);
    await reopen(chatA.id);
    r = await owner('GET', `${F}/contacts`);
    cA = r.json.contacts.find((c) => c.chatId === Number(chatA.id));
    check('tableau : exclusion partielle (prix) visible sur la ligne', cA.state === 'partial' && cA.rule.noPrice && !cA.rule.noOrder, cA);
    await owner('POST', `${F}/rules/lift`, { chatId: chatA.id });
    // sans la règle, la négociation passe par le serveur
    await reopen(chatA.id);
    const n5b = await negCount();
    await incoming(A1, 'Faites-moi 8000 alors');
    check('sans la règle : la négociation fonctionne (journal alimenté)', (await negCount()) > n5b);

    // ---------- 6. Exclusion partielle : commande ----------
    console.log('6. Exclusion partielle : commande');
    await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'partial', flags: { noOrder: true } });
    await reopen(chatA.id);
    const o6 = await ordersCount();
    ai.next = { reply: 'Je note votre commande.', action: { type: 'order', items: [{ name: 'Robe wax', quantity: 1 }], note: 'Douala', name: 'Awa Cliente', phone: '655112233' } };
    const s6 = sentTo(A1).length;
    await incoming(A1, 'Oui je confirme la commande');
    last = sentTo(A1).slice(s6).map((x) => x.text).join(' | ');
    check('pas de commande : aucune commande créée, message neutre envoyé', (await ordersCount()) === o6 && /conseiller/.test(last) && !/enregistrée/.test(last), [await ordersCount(), last]);
    await owner('POST', `${F}/rules/lift`, { chatId: chatA.id });
    await reopen(chatA.id);
    await incoming(A1, 'Oui je confirme la commande');
    check('sans la règle : la commande est enregistrée', (await ordersCount()) === o6 + 1);

    // ---------- 7. Exclusion partielle : rendez-vous ----------
    console.log('7. Exclusion partielle : rendez-vous');
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'partial', flags: { noAppt: true } });
    await reopen(chatA.id);
    const p7 = await apptCount();
    ai.next = { reply: 'Rendez-vous noté.', action: { type: 'appointment', date: tomorrow, time: '10:00', purpose: 'Essayage', name: 'Awa Cliente', phone: '655112233' } };
    const s7 = sentTo(A1).length;
    await incoming(A1, 'Demain 10h c\'est bon');
    last = sentTo(A1).slice(s7).map((x) => x.text).join(' | ');
    check('pas de rendez-vous : aucun rendez-vous créé, message neutre', (await apptCount()) === p7 && /conseiller/.test(last) && !/noté/.test(last), [await apptCount(), last]);
    await owner('POST', `${F}/rules/lift`, { chatId: chatA.id });
    await reopen(chatA.id);
    await incoming(A1, 'Demain 10h c\'est bon');
    check('sans la règle : le rendez-vous est enregistré', (await apptCount()) === p7 + 1);

    // ---------- 8. Exclusion partielle : relances automatiques ----------
    console.log('8. Exclusion partielle : relances automatiques');
    const B1 = '237655223344';
    ai.next = { reply: 'Bonjour !', action: null };
    await incoming(B1, 'Bonjour, je me renseigne');
    const chatB = await chatOf(B1);
    const old = new Date(Date.now() - 2 * 86400000).toISOString();
    await db.prepare('UPDATE chat_messages SET created_at = ? WHERE chat_id = ?').run(old, chatB.id);
    await db.prepare("UPDATE chats SET status = 'open', assignee_id = NULL WHERE id = ?").run(chatB.id);
    let leads = await waOut.silentLeads(await orgRow());
    check('relance WhatsApp : le prospect silencieux est candidat', leads.some((l) => Number(l.id) === Number(chatB.id)), leads.map((l) => l.id));
    await owner('POST', `${F}/rules`, { chatId: chatB.id, mode: 'partial', flags: { noFollowup: true } });
    leads = await waOut.silentLeads(await orgRow());
    check('sans relances automatiques : le prospect n\'est plus relancé', !leads.some((l) => Number(l.id) === Number(chatB.id)));
    check('centre de relances : l\'envoi automatique est refusé', (await followups.deliver(await orgRow(), {}, { id: 0, kind: 'prospect', ref_id: chatB.id, attempts: 0 }, { userId: null })).blockedByAi === true);
    await owner('POST', `${F}/rules/lift`, { chatId: chatB.id });
    leads = await waOut.silentLeads(await orgRow());
    check('règle levée : le prospect redevient candidat', leads.some((l) => Number(l.id) === Number(chatB.id)));
    // rappel de rendez-vous
    const cu8 = Number((await db.prepare("INSERT INTO customers (org_id, name, phone, created_at) VALUES (?, 'Rita Relance', '655223344', ?)").run(org, nowIso())).lastInsertRowid);
    await db.prepare('UPDATE chats SET customer_id = ? WHERE id = ?').run(cu8, chatB.id);
    await db.prepare('UPDATE chat_messages SET created_at = ? WHERE chat_id = ? AND role = ?').run(new Date().toISOString(), chatB.id, 'user'); // dans les 24 h : texte libre possible
    await db.prepare('UPDATE orgs SET appt_reminder = 1 WHERE id = ?').run(org);
    await db.prepare("INSERT INTO appointments (org_id, customer_id, chat_id, date, time, status, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, '10:00', 'confirmed', 'Essayage', ?, ?)").run(org, cu8, chatB.id, tomorrowLocal(), nowIso(), nowIso());
    await owner('POST', `${F}/rules`, { customerId: cu8, mode: 'partial', flags: { noFollowup: true } });
    const sR = sentTo(B1).length;
    await apptMod.runReminders();
    check('rappel de rendez-vous : refusé pour un contact sans relances automatiques', sentTo(B1).length === sR && !(await db.prepare('SELECT reminded_at FROM appointments WHERE chat_id = ?').get(chatB.id)).reminded_at);
    await owner('POST', `${F}/rules/lift`, { customerId: cu8 });
    await apptMod.runReminders();
    check('règle levée : le rappel part', sentTo(B1).length === sR + 1 && /Rappel/.test(sentTo(B1).slice(-1)[0].text), sentTo(B1).slice(sR));
    // exclusion totale : même effet sur les rappels et les factures impayées
    await db.prepare('UPDATE appointments SET reminded_at = NULL WHERE chat_id = ?').run(chatB.id);
    await owner('POST', `${F}/rules`, { customerId: cu8, mode: 'full', duration: 'none' });
    await apptMod.runReminders();
    check('exclusion totale : aucun rappel non plus', sentTo(B1).length === sR + 1);
    await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-9001', 'sent', '[]', 50000, 0, '2020-01-01', '2020-02-01', ?, ?, ?)").run(org, cu8, uid.awa, nowIso(), nowIso());
    check('exclusion totale : la facture impayée n\'est plus relancée automatiquement', !(await waOut.overdueInvoices(await orgRow())).some((x) => Number(x.customer_id) === cu8));
    await owner('POST', `${F}/rules/lift`, { customerId: cu8 });
    check('règle levée : la facture impayée est de nouveau candidate', (await waOut.overdueInvoices(await orgRow())).some((x) => Number(x.customer_id) === cu8));

    // ---------- 9. « Répondre seule » désactivé : brouillons à valider ----------
    console.log('9. Brouillons à valider');
    const C1 = '237655334455';
    await incoming(C1, 'Bonjour');
    const chatC = await chatOf(C1);
    await owner('POST', `${F}/rules`, { chatId: chatC.id, mode: 'partial', flags: { draft: true }, duration: 'none' });
    ai.next = { reply: 'Bien sûr, voici les informations.', action: null };
    const c9 = ai.calls; const s9 = sentTo(C1).length;
    await incoming(C1, 'Pouvez-vous me renseigner ?');
    check('brouillon : l\'IA prépare une réponse mais ne l\'envoie pas', ai.calls === c9 + 1 && sentTo(C1).length === s9, [ai.calls - c9, sentTo(C1).length - s9]);
    r = await owner('GET', `${F}/drafts`);
    const d1 = r.json.drafts.find((d) => d.chatId === Number(chatC.id));
    check('brouillon en attente listé (avec le dernier message du client)', d1 && d1.status === 'pending' && /informations/.test(d1.body) && /renseigner/.test(d1.lastText), r.json.drafts);
    check('brouillon : aucun message de l\'IA enregistré dans la conversation', !(await msgs(chatC.id)).some((m) => m.role === 'assistant' && /informations/.test(m.content)));
    check('brouillon : l\'équipe est prévenue', Boolean(await db.prepare("SELECT 1 FROM notices WHERE org_id = ? AND kind = 'aifollow' AND text LIKE ?").get(org, '%Réponse à valider%')));
    r = await owner('GET', `${F}/contacts`);
    check('tableau : « Réponse à valider »', r.json.contacts.find((c) => c.chatId === Number(chatC.id)).state === 'draft');
    r = await owner('GET', `${O}/sales/chats/${chatC.id}`);
    check('vue conversation : le brouillon apparaît à valider', r.json.drafts.length === 1 && r.json.drafts[0].id === d1.id);
    r = await mem('POST', `${F}/drafts/${d1.id}/approve`, {});
    check('un simple membre ne peut pas valider', r.status === 403);
    const s9a = sentTo(C1).length;
    r = await mgr('POST', `${F}/drafts/${d1.id}/approve`, {});
    check('approuver : le message part tel quel', r.status === 200 && !r.json.edited && sentTo(C1).length === s9a + 1 && /voici les informations/.test(sentTo(C1).slice(-1)[0].text), r.json);
    const apv = (await msgs(chatC.id)).filter((m) => m.role === 'assistant').pop();
    check('approuvé : message enregistré avec le nom de la personne qui a validé', apv && Number(apv.staff_id) === Number(uid.marc));
    r = await mgr('POST', `${F}/drafts/${d1.id}/approve`, {});
    check('un brouillon traité ne peut plus l\'être (409)', r.status === 409);
    ai.next = { reply: 'Brouillon à corriger.', action: null };
    await incoming(C1, 'Et la livraison ?');
    const d2 = (await owner('GET', `${F}/drafts`)).json.drafts.find((d) => /corriger/.test(d.body));
    r = await owner('POST', `${F}/drafts/${d2.id}/approve`, { text: 'La livraison est gratuite à Douala.' });
    check('modifier puis envoyer : le texte modifié part', r.status === 200 && r.json.edited && /gratuite à Douala/.test(sentTo(C1).slice(-1)[0].text) && !/corriger/.test(sentTo(C1).slice(-1)[0].text), r.json);
    ai.next = { reply: 'Brouillon à refuser.', action: null };
    await incoming(C1, 'Un autre doute');
    const d3 = (await owner('GET', `${F}/drafts`)).json.drafts.find((d) => /refuser/.test(d.body));
    const s9c = sentTo(C1).length;
    r = await owner('POST', `${F}/drafts/${d3.id}/reject`, { note: 'hors sujet' });
    check('refuser : rien n\'est envoyé', r.status === 200 && sentTo(C1).length === s9c);
    r = await owner('GET', `${F}/drafts`);
    check('plus aucun brouillon en attente', !r.json.drafts.some((d) => d.chatId === Number(chatC.id)));
    r = await owner('GET', `${F}/journal`);
    const acts = r.json.entries.map((e) => e.action);
    check('journal : brouillon approuvé, modifié, refusé, avec le nom de la personne', ['draft_approved', 'draft_edited', 'draft_rejected', 'draft_created'].every((x) => acts.includes(x)) && r.json.entries.some((e) => e.action === 'draft_approved' && e.user === 'Marc') && r.json.entries.some((e) => e.action === 'draft_rejected' && /hors sujet/.test(e.detail)), r.json.entries.slice(0, 6));
    await owner('POST', `${F}/rules/lift`, { chatId: chatC.id });
    // site : le brouillon d'un visiteur ne peut pas être envoyé après coup
    // ---------- 10. La règle suit le contact sur plusieurs fils ; création de fiche depuis un contact inconnu ----------
    console.log('10. Un contact, plusieurs fils ; fiche client');
    const D1 = '237655445566';
    ai.next = { reply: 'Bonjour !', action: null };
    await incoming(D1, 'Bonjour');
    const chatD = await chatOf(D1);
    await owner('POST', `${F}/rules`, { chatId: chatD.id, mode: 'full', duration: 'none', reason: 'avant fiche' });
    check('règle posée sur un contact sans fiche : clé = numéro normalisé', Boolean(await db.prepare("SELECT 1 FROM ai_rules WHERE org_id = ? AND rkey = 'p:655445566'").get(org)));
    r = await mem('POST', `${F}/customers`, { chatId: chatD.id });
    check('créer une fiche : refusé à un simple membre', r.status === 403);
    r = await owner('POST', `${F}/customers`, { chatId: chatD.id, name: 'Dora Cliente' });
    check('fiche client créée depuis le contact', r.status === 201 && r.json.id, r.json);
    const cuD = r.json.id;
    const row = await db.prepare('SELECT * FROM customers WHERE id = ?').get(cuD);
    check('fiche : nom, numéro, étape « prospect », source WhatsApp', row.name === 'Dora Cliente' && row.phone === D1 && row.stage === 'prospect' && row.source === 'whatsapp', row);
    check('la conversation est rattachée à la fiche', Number((await chatOf(D1)).customer_id) === Number(cuD));
    check('la règle suit la fiche (clé c:<id>) sans doublon', (await db.prepare('SELECT rkey FROM ai_rules WHERE org_id = ?').all(org)).map((x) => x.rkey).join() === `c:${cuD}`);
    r = await owner('POST', `${F}/customers`, { chatId: chatD.id });
    check('une deuxième fiche pour le même contact est refusée (409)', r.status === 409);
    r = await owner('GET', `${O}/crm/customers`);
    check('la fiche apparaît dans Clients et ventes', r.json.customers.some((c) => c.id === cuD && c.name === 'Dora Cliente'));
    r = await owner('GET', `${F}/contacts?q=dora`);
    check('tableau : le contact est maintenant un client avec fiche, exclu', r.json.contacts.length === 1 && r.json.contacts[0].hasCustomer && r.json.contacts[0].customerId === cuD && r.json.contacts[0].state === 'excluded');
    // 2e fil : la même personne écrit depuis le site (fiche liée par son numéro)
    await owner('POST', `${F}/rules/lift`, { customerId: cuD });
    ai.next = { reply: 'Enregistrée.', action: { type: 'register', name: 'Dora Cliente', phone: '655445566' } };
    const w1 = await anon({ message: 'Bonjour depuis le site' });
    await sleep(100);
    const webChat = await db.prepare("SELECT * FROM chats WHERE org_id = ? AND channel = 'web' ORDER BY id DESC LIMIT 1").get(org);
    check('2e fil (site) rattaché à la même fiche', Number(webChat.customer_id) === Number(cuD), webChat);
    await owner('POST', `${F}/rules`, { customerId: cuD, mode: 'full', duration: 'none' });
    const c10 = ai.calls; const wm = (await msgs(webChat.id)).length;
    const w2 = await anon({ message: 'Je vous écris encore', sessionId: w1.sessionId });
    check('la règle suit le contact : le fil du site est lui aussi sans réponse de l\'IA', ai.calls === c10 && w2.excluded === true && w2.silent === true, w2);
    check('site : le visiteur reçoit un texte fixe non enregistré, son message est bien conservé', /bien reçu/.test(w2.reply) && (await msgs(webChat.id)).length === wm + 1 && !(await msgs(webChat.id)).slice(wm).some((m) => m.role === 'assistant'));
    const c10b = ai.calls;
    await incoming(D1, 'Et sur WhatsApp aussi');
    check('la règle suit le contact : le fil WhatsApp aussi', ai.calls === c10b && sentTo(D1).length === (sentTo(D1).length));
    r = await owner('GET', `${F}/contacts?q=dora`);
    check('une seule ligne pour la personne, avec ses 2 fils (WhatsApp + site)', r.json.contacts.length === 1 && r.json.contacts[0].threads.length === 2 && r.json.contacts[0].channels.includes('whatsapp') && r.json.contacts[0].channels.includes('web'), r.json.contacts.map((c) => c.threads));
    // numéro avec indicatif différent : même contact
    check('numéro avec et sans indicatif = même contact (9 derniers chiffres)', R.phone9('+237 655 44 55 66') === R.phone9('655445566') && R.phone9('abc') === '');
    await owner('POST', `${F}/rules/lift`, { customerId: cuD });

    // ---------- 11. Flux « depuis l'identifiant X » ----------
    console.log('11. Mise à jour en direct');
    r = await owner('GET', `${O}/sales/chats/${chatA.id}`);
    const last0 = r.json.lastId;
    check('chargement initial : id du dernier message', last0 > 0 && r.json.messages.length > 0 && r.json.messages.every((m) => m.id > 0 && ['user', 'assistant', 'staff'].includes(m.role)), r.json.lastId);
    r = await owner('GET', `${O}/sales/chats/${chatA.id}/live?since=${last0}`);
    check('rien de nouveau : liste vide', r.status === 200 && r.json.messages.length === 0 && r.json.lastId === last0);
    ai.next = { reply: 'Réponse en direct.', action: null };
    await reopen(chatA.id);
    await incoming(A1, 'Nouveau message en direct');
    await incoming(B1, 'Message sur un autre fil');
    r = await owner('GET', `${O}/sales/chats/${chatA.id}/live?since=${last0}`);
    check('flux : seulement les nouveaux messages de CETTE conversation', r.json.messages.length >= 2 && r.json.messages.every((m) => m.id > last0) && r.json.messages.some((m) => /en direct/.test(m.content) && m.role === 'user') && !r.json.messages.some((m) => /autre fil/.test(m.content)), r.json.messages);
    const last1 = r.json.lastId;
    check('flux : l\'id du dernier message avance', last1 > last0);
    r = await owner('GET', `${O}/sales/chats/${chatA.id}/live?since=${last1}`);
    check('flux : plus rien après le dernier id', r.json.messages.length === 0);
    await owner('POST', `${O}/sales/chats/${chatA.id}/reply`, { text: 'Je vous réponds moi-même.' });
    r = await owner('GET', `${O}/sales/chats/${chatA.id}/live?since=${last1}`);
    check('réponse d\'un membre de l\'équipe : le nom de la personne est indiqué', r.json.messages.length === 1 && r.json.messages[0].role === 'staff' && r.json.messages[0].staff === 'Awa' && Number(r.json.messages[0].staffId) === Number(uid.awa), r.json.messages);
    check('reprise en main visible dans le flux (statut)', r.json.status === 'handoff');
    // beaucoup de messages : les 200 derniers d'abord, puis « plus anciens »
    const bulkChat = Number((await db.prepare("INSERT INTO chats (org_id, session, channel, contact, created_at, updated_at) VALUES (?, 'wa-bulk-test', 'whatsapp', '237699000111', ?, ?)").run(org, nowIso(), nowIso())).lastInsertRowid);
    for (let i = 1; i <= 230; i++) await db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(bulkChat, `msg ${i}`, nowIso());
    r = await owner('GET', `${O}/sales/chats/${bulkChat}`);
    check('conversation longue : 200 derniers messages + « voir plus haut »', r.json.messages.length === 200 && r.json.hasMore && r.json.messages[199].content === 'msg 230');
    const firstId = r.json.messages[0].id;
    const older = await owner('GET', `${O}/sales/chats/${bulkChat}?before=${firstId}`);
    check('messages plus anciens', older.json.messages.length === 30 && older.json.messages[0].content === 'msg 1' && !older.json.hasMore);
    r = await mem('GET', `${O}/sales-mine/chats/${chatA.id}/live?since=0`);
    check('un membre ne lit pas une conversation qui ne lui est pas attribuée', r.status === 404);
    r = await mem('GET', `${O}/sales/chats/${chatA.id}/live?since=0`);
    check('un membre n\'a pas accès aux conversations de l\'équipe', r.status === 403);
    r = await owner('GET', `${F}/pulse`);
    check('impulsion légère pour le tableau', r.status === 200 && r.json.maxId > 0 && typeof r.json.stamp === 'string');

    // ---------- 12. Tableau : totaux, recherche, filtres, tri, pagination ----------
    console.log('12. Tableau des clients');
    const cuT = Number((await db.prepare("INSERT INTO customers (org_id, name, phone, stage, created_at) VALUES (?, 'Zeta Totaux', '699111222', 'client', ?)").run(org, nowIso())).lastInsertRowid);
    await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, credited, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'order', 'C-1', 'confirmed', '[]', 30000, 0, 0, '2026-01-01', NULL, ?, ?, ?)").run(org, cuT, uid.awa, nowIso(), nowIso());
    await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, credited, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-1', 'sent', '[]', 45000, 10000, 5000, '2026-01-01', '2026-02-01', ?, ?, ?)").run(org, cuT, uid.awa, nowIso(), nowIso());
    let z = await contactOf('zeta');
    check('totaux : commandé, facturé et reste à payer calculés des données présentes', z && z.ordered === 30000 && z.invoiced === 45000 && z.owed === 30000 && z.stage === 'client' && z.messages === 0 && !z.chatId, z);
    check('un contact sans fiche n\'a pas de montants inventés', (await contactOf('+237655334455')).ordered === null);
    for (let i = 1; i <= 130; i++) await db.prepare("INSERT INTO customers (org_id, name, phone, stage, created_at) VALUES (?, ?, ?, ?, ?)").run(org, `Bulk ${String(i).padStart(3, '0')}`, `6900${String(i).padStart(5, '0')}`, i % 2 ? 'prospect' : 'client', nowIso());
    r = await owner('GET', `${F}/contacts?pageSize=25&sort=name&dir=asc`);
    check('pagination : plus de 100 clients, total exact', r.json.total >= 130 && r.json.pages >= 6 && r.json.contacts.length === 25, [r.json.total, r.json.pages]);
    const seen = new Set();
    for (let p = 1; p <= r.json.pages; p++) { const x = await owner('GET', `${F}/contacts?pageSize=25&sort=name&dir=asc&page=${p}`); x.json.contacts.forEach((c) => seen.add(c.key)); }
    check('pagination : toutes les pages atteignables, aucun client perdu ni répété', seen.size === r.json.total, [seen.size, r.json.total]);
    r = await owner('GET', `${F}/contacts?pageSize=500`);
    check('taille de page plafonnée à 100 (jamais de coupure silencieuse du total)', r.json.pageSize === 100 && r.json.total >= 130 && r.json.contacts.length === 100);
    r = await owner('GET', `${F}/contacts?q=bulk 07`);
    check('recherche par nom', r.json.total === 10 && r.json.contacts.every((c) => /Bulk 07/.test(c.name)), r.json.total);
    r = await owner('GET', `${F}/contacts?q=69000012`);
    check('recherche par numéro', r.json.total >= 1 && r.json.contacts.every((c) => /69000012/.test(c.phone)), r.json.total);
    r = await owner('GET', `${F}/contacts?q=DORA`);
    check('recherche insensible à la casse', r.json.total === 1);
    r = await owner('GET', `${F}/contacts?stage=prospect&q=bulk`);
    check('filtre par étape', r.json.total === 65 && r.json.contacts.every((c) => c.stage === 'prospect'), r.json.total);
    r = await owner('GET', `${F}/contacts?stage=contact`);
    check('filtre « sans fiche »', r.json.total >= 2 && r.json.contacts.every((c) => !c.hasCustomer));
    r = await owner('GET', `${F}/contacts?channel=whatsapp`);
    check('filtre par canal WhatsApp', r.json.total >= 3 && r.json.contacts.every((c) => c.channels.includes('whatsapp')));
    r = await owner('GET', `${F}/contacts?channel=web`);
    check('filtre par canal site', r.json.total >= 1 && r.json.contacts.every((c) => c.channels.includes('web')));
    r = await owner('GET', `${F}/contacts?sort=owed&dir=desc`);
    check('tri par reste à payer', r.json.contacts[0].name === 'Zeta Totaux' || r.json.contacts[0].owed >= r.json.contacts[1].owed);
    r = await owner('GET', `${F}/contacts?state=inconnu`);
    check('état inconnu refusé', r.status === 400);
    await owner('POST', `${F}/rules`, { customerId: cuT, mode: 'full', duration: 'none' });
    r = await owner('GET', `${F}/contacts?state=excluded`);
    check('filtre par état de l\'IA (exclu) + compteurs', r.json.contacts.length === 1 && r.json.contacts[0].customerId === cuT && r.json.counts.excluded === 1, r.json.counts);
    await owner('POST', `${F}/rules/lift`, { customerId: cuT });
    r = await owner('GET', `${F}/contacts?state=waiting`);
    check('filtre « en attente d\'un conseiller »', r.json.contacts.every((c) => c.state === 'waiting' && c.waiting));

    // ---------- 13. Isolation entre organisations ----------
    console.log('13. Isolation entre organisations');
    r = await zoe('GET', `${O2}/aifollow/contacts`);
    check('l\'autre organisation voit un tableau vide de nos clients', r.status === 200 && r.json.total === 0, r.json.total);
    r = await zoe('GET', `${F}/contacts`);
    check('l\'autre organisation ne peut pas lire notre Suivi de l\'IA (404)', r.status === 404);
    r = await zoe('POST', `${O2}/aifollow/rules`, { chatId: chatA.id, mode: 'full' });
    check('une conversation d\'une autre organisation ne peut pas être ciblée (404)', r.status === 404);
    r = await zoe('POST', `${O2}/aifollow/rules`, { customerId: cuD, mode: 'full' });
    check('une fiche client d\'une autre organisation ne peut pas être ciblée (404)', r.status === 404);
    r = await zoe('GET', `${O2}/sales/chats/${chatA.id}`);
    check('une conversation d\'une autre organisation ne se lit pas (404)', r.status === 404);
    r = await zoe('GET', `${O2}/sales/chats/${chatA.id}/live?since=0`);
    check('le flux en direct est isolé aussi (404)', r.status === 404);
    r = await owner('GET', `${O2}/aifollow/contacts`);
    check('notre propriétaire n\'entre pas chez l\'autre organisation (404)', r.status === 404);
    // même numéro dans l'autre organisation : la règle de la première ne s'applique pas
    await owner('POST', `${F}/rules`, { chatId: chatA.id, mode: 'full', duration: 'none' });
    const chat2 = await require('../src/workspace/sales-public').ensureChat(await orgRow(org2), 'whatsapp', A1, '');
    check('même numéro dans une autre organisation : aucune règle (isolation des clés)', (await R.rulesOfChat(org2, chat2)).excluded === false && (await R.rulesOfChat(org, chatA)).excluded === true);
    await owner('POST', `${F}/rules/lift`, { chatId: chatA.id });
    await zoe('POST', `${O2}/sales/catalog`, { name: 'Boubou', price: 8000 });
    ai.next = { reply: 'ZOE-SECRET réponse', action: null };
    await anon({ message: 'ZOE-MESSAGE-SECRET' }, (await orgRow(org2)).intake_token);
    r = await zoe('GET', `${O2}/aifollow/contacts`);
    check('l\'autre organisation voit seulement ses propres conversations', r.json.total === 2 && !/Awa|Dora|Rita|Bulk/.test(JSON.stringify(r.json)), r.json.total);
    r = await owner('GET', `${F}/contacts?pageSize=100`);
    check('notre tableau ne contient rien de l\'autre organisation', !/ZOE-/.test(JSON.stringify(r.json)));

    // ---------- 14. Droits par rôle ----------
    console.log('14. Droits par rôle');
    for (const [m, u, b] of [['GET', '/contacts'], ['GET', '/journal'], ['GET', '/drafts'], ['GET', '/pulse'], ['POST', '/rules', { chatId: chatA.id, mode: 'full' }], ['POST', '/rules/lift', { chatId: chatA.id }], ['POST', '/customers', { chatId: chatA.id }]]) {
      r = await mem(m, F + u, b);
      check(`membre : ${m} ${u} refusé (403)`, r.status === 403, r.status);
    }
    r = await mgr('GET', `${F}/contacts`);
    check('responsable : accès au tableau', r.status === 200);
    r = await mgr('POST', `${F}/rules`, { chatId: chatA.id, mode: 'full', duration: '24h', reason: 'Demande du client' });
    check('responsable : peut exclure', r.status === 201);
    r = await mgr('POST', `${F}/rules/lift`, { chatId: chatA.id });
    check('responsable : peut lever', r.status === 200);
    r = await owner('GET', O);
    check('le module « Suivi de l\'IA » est dans le menu du propriétaire', r.json.modules.some((m) => m.id === 'aifollow' && m.title === "Suivi de l'IA"));
    r = await mem('GET', O);
    check('le module n\'est pas dans le menu d\'un simple membre', !r.json.modules.some((m) => m.id === 'aifollow'));
    r = await mgr('GET', O);
    check('le module est dans le menu d\'un responsable', r.json.modules.some((m) => m.id === 'aifollow'));
    r = await owner('GET', `${F}/journal?pageSize=100`);
    check('journal : qui, quoi, quand, durée', r.json.entries.some((e) => e.action === 'exclude' && e.user === 'Awa' && e.at && e.expiresAt && /Litige-confidentiel/.test(e.detail)) && r.json.entries.some((e) => e.action === 'lift' && e.user === 'Marc') && r.json.total >= 10, r.json.entries.slice(0, 3));
    check('audit de l\'organisation : activité inscrite', Number((await db.prepare("SELECT COUNT(*) c FROM activity WHERE org_id = ? AND module = 'aifollow'").get(org)).c) >= 4);
    check('audit : le contenu des messages n\'est jamais copié dans l\'activité', !(await db.prepare("SELECT text FROM activity WHERE org_id = ?").all(org)).some((x) => /commande ?\?|Combien coûte|ZOE-/.test(x.text)));

    // ---------- 15. L'administrateur de la plateforme ne voit aucun contenu ----------
    console.log('15. Confidentialité vis-à-vis de l\'administration de la plateforme');
    r = await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    check('connexion administrateur de la plateforme', r.status === 200, r.json);
    const probes = ['/stats', '/users', '/payments', '/leads', '/visits', '/overview', '/orgs', '/ai-usage', '/settings', '/notifications', '/security-log', '/clients?limit=500', `/clients/${uid.awa}`, '/summary', '/alerts', '/export/users.csv'];
    let blob = '';
    for (const p of probes) { const x = await adm('GET', '/api/admin' + p); blob += '\n' + x.text; if (x.status >= 500) check(`admin ${p} sans erreur serveur`, false, x.status); }
    const secrets = ['Combien coûte', 'Je veux savoir où est ma commande', 'Nouveau message en direct', 'Je vous réponds moi-même', 'Dora Cliente', 'Rita Relance', 'Litige-confidentiel', 'Bonjour depuis le site', 'ZOE-MESSAGE-SECRET', '655445566', '655112233', 'Bulk 001', 'Zeta Totaux'];
    check('aucune route d\'administration ne renvoie un message, un nom de client, un numéro ou un motif', secrets.every((s) => !blob.includes(s)), secrets.filter((s) => blob.includes(s)));
    for (const p of ['/chats', `/orgs/${org}/chats`, `/orgs/${org}/aifollow/contacts`, `/orgs/${org}/customers`, `/aifollow`, `/conversations`, `/orgs/${org}`, `/clients/${uid.awa}/chats`]) {
      const x = await adm('GET', '/api/admin' + p);
      check(`admin : GET /api/admin${p} ne donne aucune conversation`, !secrets.some((s) => x.text.includes(s)) && (x.status === 404 || x.status === 401 || x.status === 403 || x.status === 200), x.status);
    }
    r = await adm('GET', `/api/admin/clients/${uid.awa}`);
    check('fiche client de l\'administration : aucune donnée de conversation ni de client final', r.status === 200 && !/messages|chat_messages|"customers"|ai_rules|drafts/i.test(Object.keys(r.json).join(',')) && secrets.every((s) => !r.text.includes(s)), Object.keys(r.json));
    r = await adm('GET', '/api/ws/orgs/' + org + '/aifollow/contacts');
    check('l\'administrateur de la plateforme n\'est pas un membre : l\'espace de l\'organisation lui est fermé', r.status === 401 || r.status === 403 || r.status === 404, r.status);
    r = await adm('GET', `${O}/sales/chats/${chatA.id}`);
    check('...et la lecture d\'une conversation aussi', r.status === 401 || r.status === 403 || r.status === 404, r.status);
  } finally {
    try { await waWeb.shutdown(); } catch { /* arrêté */ }
    srv.close(); a.srv.close();
    await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoué(s).`);
  process.exit(failed ? 1 : 0);
}
const nowIso = () => new Date().toISOString();
const tomorrowLocal = () => new Date(Date.now() + 3600000 + 86400000).toISOString().slice(0, 10);
main().catch((e) => { console.error(e); process.exit(1); });
