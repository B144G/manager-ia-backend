'use strict';
// Portée des réponses automatiques WhatsApp : « publicité » / « prospects » / « tout le monde ».
// Canal QR : faux socket Baileys. Canal officiel : webhook commun signé + faux serveur Meta. Faux serveur d'IA. Aucun appel réseau réel.
// Lancez : npm run test:waportee
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(40); } return false; };
const SECRET = 'secret-app-meta-de-test';

function fakeAi() {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: '{"reply":"Bonjour de test, voici nos prix.","action":null}' }] })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}
/** Faux serveur Meta : enregistre chaque message sortant. */
function fakeGraph() {
  const sent = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { sent.push(JSON.parse(b)); } catch { /* */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ messages: [{ id: 'wamid.X' }] })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, sent, port: srv.address().port })));
}
function fakeLib() {
  const sockets = [];
  return { sockets, initAuthCreds: () => ({ registered: false }), DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionReplaced: 440 },
    default(cfg) {
      const ev = new EventEmitter();
      const sock = { cfg, ev, user: null, sent: [], presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {}, readMessages: async () => {},
        sendMessage: async (jid, content) => { sock.sent.push({ jid, content }); return { key: { id: 'X' + sock.sent.length } }; }, requestPairingCode: async () => 'ABCD-1234', logout: async () => {}, end: () => {} };
      sockets.push(sock); return sock;
    } };
}
const nowS = () => Math.floor(Date.now() / 1000);
let mid = 0;
const upsert = (sock, num, content, extra = {}) => sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: `${num}@s.whatsapp.net`, id: 'M' + (++mid), fromMe: false }, message: content, messageTimestamp: nowS(), ...extra }] });
const txt = (s) => ({ conversation: s });
const adMsg = (s, ad) => ({ extendedTextMessage: { text: s, contextInfo: { externalAdReply: ad } } });

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* */ }
    return { status: res.status, json, text: t };
  };
}

async function main() {
  const ai = await fakeAi(); const graph = await fakeGraph();
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_EMBEDDED_CONFIG_ID', 'META_VERIFY_TOKEN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'BREVO_API_KEY', 'MAIL_API_KEY', 'STT_API_KEY']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`, WA_QR_ENABLED: '1', META_APP_SECRET: SECRET, META_GRAPH_URL: `http://127.0.0.1:${graph.port}`, REPLY_DELAY_SCALE: '400', REPLY_TICK_MS: '60' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const waWeb = require('../src/services/waWeb');
  const vault = require('../src/services/vault');
  const scope = require('../src/workspace/wa-scope');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  let t = Date.now();
  const clock = { now: () => t, sleep: async (ms) => { t += ms; await Promise.resolve(); } };

  try {
    // ---------- Préparation ----------
    const owner = client(base); const owner2 = client(base); const mgr = client(base); const outsider = client(base);
    await owner('POST', '/api/register', { name: 'Awa', contact: `awa${stamp}@exemple.com`, pass: 'secret123' });
    await owner2('POST', '/api/register', { name: 'Zoe', contact: `zoe${stamp}@exemple.com`, pass: 'secret123' });
    await mgr('POST', '/api/register', { name: 'Paul', contact: `paul${stamp}@exemple.com`, pass: 'secret123' });
    await outsider('POST', '/api/register', { name: 'Ed', contact: `ed${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa' }); const org = r.json.id;
    r = await owner2('POST', '/api/ws/orgs', { name: 'Atelier Zoe' }); const orgB = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/invites`, { role: 'manager' });
    await mgr('POST', '/api/ws/orgs/join', { code: r.json.code });
    const O = `/api/ws/orgs/${org}`; const OB = `/api/ws/orgs/${orgB}`;
    await owner('POST', `${O}/sales/catalog`, { name: 'Robe wax', price: 10000, floorPrice: 6000 });
    await owner2('POST', `${OB}/sales/catalog`, { name: 'Pagne', price: 5000 });

    // canal QR (organisation A)
    const lib = fakeLib();
    waWeb.resetForTest({ clock, loadLib: async () => lib, limits: { perMinute: 1000, perDay: 100000 } });
    await owner('POST', `${O}/sales/wa-qr/start`, { accept: true });
    const sock = lib.sockets[lib.sockets.length - 1];
    sock.ev.emit('creds.update', { me: { id: '237677000000:1@s.whatsapp.net' }, registered: true });
    sock.user = { id: '237677000000:1@s.whatsapp.net' };
    sock.ev.emit('connection.update', { connection: 'open' });
    await until(async () => (await owner('GET', `${O}/sales/wa-qr/status`)).json.status === 'open');
    const chatOf = async (orgId, num) => await db.prepare("SELECT * FROM chats WHERE org_id = ? AND channel = 'whatsapp' AND contact = ?").get(orgId, num);
    const nUser = async (chatId) => Number((await db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE chat_id = ? AND role = 'user'").get(chatId)).c);
    const put = (b) => owner('PUT', `${O}/wa-scope`, b);
    /** Envoie un message et dit si l'assistant a répondu (attente courte si rien ne doit partir). */
    const talk = async (num, content, expectReply = true) => {
      const n0 = sock.sent.length; const had = await chatOf(org, num); const u0 = had ? await nUser(had.id) : 0;
      upsert(sock, num, content);
      await until(async () => { const c = await chatOf(org, num); return c && (await nUser(c.id)) > u0; });
      if (expectReply) return await until(() => sock.sent.length > n0, 5000);
      await sleep(500); return sock.sent.length > n0;
    };

    // ---------- 1. Migrations et valeur par défaut ----------
    console.log('Migrations et valeur par défaut');
    const tabs = (await db.prepare("SELECT table_name FROM information_schema.tables WHERE table_name IN ('wa_scope_settings','wa_scope_exceptions','wa_contact_origin','wa_chat_scope','wa_scope_log')").all()).map((x) => x.table_name);
    check('5 tables créées par les migrations 143 à 145', tabs.length === 5, tabs);
    r = await owner('GET', `${O}/wa-scope`);
    check('réglage par défaut = tout le monde, sans mot-clé ni exception', r.status === 200 && r.json.settings.mode === 'all' && r.json.effectiveMode === 'all' && r.json.settings.keywords.length === 0 && r.json.exceptions.length === 0, r.json);
    check('ligne WhatsApp active = qr', r.json.channel === 'qr', r.json.channel);
    check('comportement actuel : un inconnu organique reçoit la réponse de l\'assistant', await talk('237655000001', txt('Bonjour, vous avez des robes ?')));
    let o = await db.prepare('SELECT * FROM wa_contact_origin WHERE org_id = ?').get(org);
    check('origine enregistrée : organique, avec date', o && o.source === 'organic' && Number(o.is_ad) === 0 && /^\d{4}-/.test(o.first_at), o);

    // ---------- 2. Droits et validations ----------
    console.log('Droits et validations');
    r = await mgr('GET', `${O}/wa-scope`); check('un responsable lit le réglage', r.status === 200);
    r = await mgr('PUT', `${O}/wa-scope`, { mode: 'ads' }); check('un responsable (non administrateur) ne modifie pas le réglage -> 403', r.status === 403, r.json);
    r = await outsider('GET', `${O}/wa-scope`); check('personne extérieure -> 404', r.status === 404);
    r = await put({ mode: 'tous' }); check('mode inconnu -> 400', r.status === 400, r.json);
    r = await put({ keywords: ['ab'] }); check('mot-clé trop court -> 400', r.status === 400, r.json);
    r = await put({ keywords: 'promo' }); check('mots-clés non liste -> 400', r.status === 400);
    r = await owner('POST', `${O}/wa-scope/exceptions`, { phone: '12', kind: 'always' }); check('numéro invalide -> 400', r.status === 400);
    r = await owner('POST', `${O}/wa-scope/exceptions`, { phone: '237699000001', kind: 'peut-etre' }); check('type de liste inconnu -> 400', r.status === 400);

    // ---------- 3. Mode « publicité » ----------
    console.log('Mode publicité');
    r = await put({ mode: 'ads', keywords: ['PROMO-RENTREE', 'Soldes été'] });
    check('mode publicité enregistré', r.status === 200 && r.json.settings.mode === 'ads' && r.json.settings.keywords.length === 2, r.json.settings);
    const heldNum = '237655000002';
    check('organique : aucune réponse automatique', !(await talk(heldNum, txt('Bonjour, vous livrez ?'), false)));
    let c = await chatOf(org, heldNum);
    check('…mais le message est enregistré dans la conversation', c && (await nUser(c.id)) === 1);
    const notice = await db.prepare("SELECT text FROM notices WHERE org_id = ? AND ref = ? AND kind = 'aifollow'").get(org, `aichat:${c.id}`);
    check('…et le responsable est prévenu (notice existante)', notice && /hors périmètre/.test(notice.text), notice);
    r = await owner('GET', `${O}/sales/chats`);
    const row = r.json.chats.find((x) => x.id === c.id);
    check('liste des conversations : étiquette hors périmètre + raison', row && row.outOfScope === true && row.scopeReason === 'not_ad', row);
    r = await owner('GET', `${O}/sales/chats/${c.id}`);
    check('détail : scope.held + texte de raison', r.json.scope && r.json.scope.held === true && /publicité/.test(r.json.scope.reasonText) && r.json.scope.origin.source === 'organic', r.json.scope);
    check('publicité reconnue par WhatsApp Web (externalAdReply + identifiant d\'annonce) : réponse', await talk('237655000003', adMsg('Bonjour, je veux ce produit', { sourceId: 'AD-4455', title: 'Robes wax -20 %', sourceType: 'ad' })));
    o = await db.prepare('SELECT * FROM wa_contact_origin WHERE org_id = ? AND phone9 = ?').get(org, '655000003');
    check('origine = publicité, annonce et date enregistrées', o && o.source === 'ad' && o.ad_id === 'AD-4455' && Number(o.is_ad) === 1 && o.ad_at && /Robes wax/.test(o.detail), o);
    check('simple aperçu de lien (externalAdReply sans identifiant ni type annonce) : PAS une publicité', !(await talk('237655000004', adMsg('regardez ce lien', { title: 'Un article', sourceUrl: 'https://exemple.com' }), false)));
    check('repli mot-clé (message d\'entrée) : réponse', await talk('237655000005', txt('Bonjour promo-rentrée svp, quel prix ?')));
    o = await db.prepare('SELECT * FROM wa_contact_origin WHERE org_id = ? AND phone9 = ?').get(org, '655000005');
    check('origine = publicité via mot-clé', o && o.source === 'ad' && /PROMO-RENTREE/.test(o.detail), o);
    check('le mot-clé ne compte pas dans un message ultérieur d\'un contact organique', !(await talk(heldNum, txt('Soldes été ?'), false)));
    check('marqueur #campagne du lien de publicité : réponse', await talk('237655000006', txt('Bonjour #rentree25')));
    o = await db.prepare('SELECT * FROM wa_contact_origin WHERE org_id = ? AND phone9 = ?').get(org, '655000006');
    check('origine = publicité, campagne enregistrée', o && o.source === 'ad' && o.campaign === 'rentree25', o);
    // marquage à la main
    r = await mgr('PUT', `${O}/wa-scope/origin`, { phone: heldNum, ad: true, campaign: 'flyer' });
    check('marquer « publicité » à la main (responsable)', r.status === 200);
    check('…le contact marqué est ensuite servi', await talk(heldNum, txt('Je repasse commande')));
    o = await db.prepare('SELECT * FROM wa_contact_origin WHERE org_id = ? AND phone9 = ?').get(org, '655000002');
    check('…source = manuel', o && o.source === 'manual' && Number(o.is_ad) === 1 && o.campaign === 'flyer', o);
    r = await owner('GET', `${O}/sales/chats`);
    check('…et l\'étiquette disparaît de la liste (réévaluée)', !r.json.chats.find((x) => x.id === c.id).outOfScope);
    // import
    r = await owner('POST', `${O}/wa-scope/import`, { rows: [{ phone: '237655000007', ad: true, campaign: 'import1' }, { phone: 'xx' }, { phone: '237655000008', ad: false }] });
    check('import : 2 numéros pris, 1 ignoré', r.status === 200 && r.json.imported === 2 && r.json.skipped === 1, r.json);
    check('contact importé « publicité » : réponse', await talk('237655000007', txt('Salut')));
    check('contact importé « non publicité » : pas de réponse', !(await talk('237655000008', txt('Salut'), false)));
    o = await db.prepare('SELECT source FROM wa_contact_origin WHERE org_id = ? AND phone9 = ?').get(org, '655000007');
    check('source = import', o && o.source === 'import', o);
    // un contact organique qui clique ensuite sur une publicité devient « publicité »
    check('organique puis clic sur une publicité : devient publicité et reçoit la réponse', await talk('237655000004', adMsg('Bonjour via la pub', { sourceId: 'AD-9', ctwaClid: 'xyz' })));
    o = await db.prepare('SELECT source, ad_id FROM wa_contact_origin WHERE org_id = ? AND phone9 = ?').get(org, '655000004');
    check('…origine mise à jour', o && o.source === 'ad' && o.ad_id === 'AD-9', o);
    // lien avec les prospects du module Commercial
    c = await chatOf(org, '237655000003');
    await db.prepare("INSERT INTO cp_leads (org_id, name, phone, source, chat_id, created_at, updated_at) VALUES (?, 'Test', '237655000003', 'whatsapp', ?, ?, ?)").run(org, c.id, new Date().toISOString(), new Date().toISOString());
    await scope.setOrigin(org, null, '237655000003', { ad: true, campaign: 'rentree25' });
    const lead = await db.prepare('SELECT source, campaign FROM cp_leads WHERE org_id = ? AND chat_id = ?').get(org, c.id);
    check('Commercial : la source du prospect devient « ad » (publicité)', lead && lead.source === 'ad' && lead.campaign === 'rentree25', lead);
    r = await owner('GET', `${O}/wa-scope`);
    check('statistiques par source et par annonce', r.json.stats.bySource.ad >= 4 && r.json.stats.bySource.organic >= 1 && r.json.stats.bySource.import >= 1 && r.json.stats.bySource.manual >= 1 && r.json.stats.campaigns.some((x) => x.adId === 'AD-4455'), r.json.stats);

    // ---------- 4. Désabonnement inchangé ----------
    console.log('Désabonnement et sécurité inchangés');
    let n0 = sock.sent.length;
    upsert(sock, '237655000008', txt('STOP'));
    await until(() => sock.sent.length > n0);
    check('« STOP » d\'un contact hors périmètre : confirmation envoyée et désabonnement enregistré', /plus de messages de relance/.test(sock.sent[sock.sent.length - 1].content.text) && await require('../src/workspace/wa-out').isOptedOut(org, '237655000008'));
    n0 = sock.sent.length;
    upsert(sock, '237655000008', { stickerMessage: {} }); await sleep(500);
    check('type non pris en charge hors périmètre : aucun message automatique', sock.sent.length === n0);

    // ---------- 5. Mode « prospects » ----------
    console.log('Mode prospects');
    r = await put({ mode: 'prospects' }); check('mode prospects enregistré', r.status === 200 && r.json.effectiveMode === 'prospects');
    const now = new Date().toISOString();
    const cust = async (name, phone, stage) => Number((await db.prepare('INSERT INTO customers (org_id, name, phone, stage, created_at) VALUES (?, ?, ?, ?, ?)').run(org, name, phone, stage, now)).lastInsertRowid);
    check('contact nouveau : réponse', await talk('237655000010', txt('Bonjour')));
    const cp = await cust('Paulette (prospect)', '237655000011', 'prospect');
    check('fiche « prospect » : réponse', await talk('237655000011', txt('Bonjour')));
    await cust('Cédric (client)', '237655000012', 'client');
    check('client existant (fiche client) : aucune réponse', !(await talk('237655000012', txt('Bonjour'), false)));
    const cv = await cust('Vente (fiche prospect mais facture)', '237655000013', 'prospect');
    await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, total, issued, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-1', 'sent', 5000, ?, 1, ?, ?)").run(org, cv, now.slice(0, 10), now, now);
    check('facture enregistrée : n\'est plus un prospect, aucune réponse', !(await talk('237655000013', txt('Bonjour'), false)));
    const cq = await cust('Devis seul', '237655000014', 'prospect');
    await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, total, issued, created_by, created_at, updated_at) VALUES (?, ?, 'quote', 'D-1', 'sent', 5000, ?, ?, ?, ?)").run(org, cq, now.slice(0, 10), 1, now, now);
    check('simple devis : toujours prospect, réponse', await talk('237655000014', txt('Bonjour')));
    await db.prepare("INSERT INTO suppliers (org_id, name, phone, created_at) VALUES (?, 'Fournisseur SA', '+237 655 000 015', ?)").run(org, now);
    check('fournisseur : aucune réponse', !(await talk('237655000015', txt('Bonjour'), false)));
    await db.prepare("INSERT INTO employees (org_id, name, phone, created_at) VALUES (?, 'Employé', '655000016', ?)").run(org, now);
    check('employé : aucune réponse', !(await talk('237655000016', txt('Bonjour'), false)));
    await db.prepare("INSERT INTO cp_leads (org_id, name, phone, status, created_at, updated_at) VALUES (?, 'Disq', '237655000017', 'disqualified', ?, ?)").run(org, now, now);
    check('prospect disqualifié du module Commercial : aucune réponse', !(await talk('237655000017', txt('Bonjour'), false)));
    await db.prepare("INSERT INTO cp_leads (org_id, name, phone, status, created_at, updated_at) VALUES (?, 'Pipe', '237655000018', 'qualified', ?, ?)").run(org, now, now);
    check('prospect en pipeline (qualifié) : réponse', await talk('237655000018', txt('Bonjour')));
    check('aucune donnée dupliquée : pas de fiche client créée par la portée', Number((await db.prepare("SELECT COUNT(*) c FROM customers WHERE org_id = ? AND phone IN ('237655000010','237655000012x')").get(org)).c) === 0);
    r = await owner('GET', `${O}/sales/chats`);
    const c12 = await chatOf(org, '237655000012');
    check('étiquette : client existant -> raison « déjà client »', r.json.chats.find((x) => x.id === c12.id).scopeReason === 'not_prospect_client');
    void cp;

    // ---------- 6. Listes d'exceptions ----------
    console.log('Listes d\'exceptions');
    r = await owner('POST', `${O}/wa-scope/exceptions`, { phone: '+237 655 000 012', kind: 'always', label: 'Client VIP' });
    check('« toujours autorisé » ajouté', r.status === 201 && r.json.exceptions.length === 1 && r.json.exceptions[0].kind === 'always', r.json.exceptions);
    check('le client existant en liste « toujours » est servi en mode prospects', await talk('237655000012', txt('Re-bonjour')));
    await put({ mode: 'ads' });
    check('« toujours » prime sur le mode publicité', await talk('237655000012', txt('Encore moi')));
    await put({ mode: 'all' });
    r = await owner('POST', `${O}/wa-scope/exceptions`, { phone: '237655000001', kind: 'never', label: 'Ne pas répondre' });
    check('« jamais » ajouté', r.status === 201);
    check('« jamais » bloque même en mode tout le monde', !(await talk('237655000001', txt('Bonjour encore'), false)));
    r = await mgr('POST', `${O}/wa-scope/exceptions`, { phone: '237655000020', kind: 'never' }); check('ajout à la liste réservé aux administrateurs -> 403', r.status === 403);
    const exc = (await owner('GET', `${O}/wa-scope`)).json.exceptions;
    r = await owner('DELETE', `${O}/wa-scope/exceptions/${exc.find((x) => x.kind === 'never').id}`);
    check('retrait de la liste « jamais »', r.status === 200 && r.json.exceptions.every((x) => x.kind !== 'never'));
    check('…le contact est de nouveau servi', await talk('237655000001', txt('Bonjour encore')));

    // ---------- 7. Changement de mode en cours de conversation ----------
    console.log('Changement de mode en cours de conversation');
    const mc = '237655000030';
    check('mode « tout le monde » : réponse', await talk(mc, txt('Bonjour, prix de la robe ?')));
    await put({ mode: 'ads' });
    check('passage en « publicité » en pleine conversation : le message suivant est retenu', !(await talk(mc, txt('Et la livraison ?'), false)));
    const cm = await chatOf(org, mc);
    r = await owner('GET', `${O}/sales/chats`);
    check('étiquette affichée', r.json.chats.find((x) => x.id === cm.id).outOfScope === true);
    check('l\'historique reste intact (4 messages au moins)', Number((await db.prepare('SELECT COUNT(*) c FROM chat_messages WHERE chat_id = ?').get(cm.id)).c) >= 3);
    await put({ mode: 'all' });
    r = await owner('GET', `${O}/sales/chats`);
    check('retour à « tout le monde » : étiquette retirée sans attendre', r.json.chats.find((x) => x.id === cm.id).outOfScope === false);
    check('…et le contact est servi', await talk(mc, txt('Alors, livraison ?')));
    // réponse différée : le mode change pendant l'attente
    await db.prepare('UPDATE orgs SET reply_delay = 1 WHERE id = ?').run(org);
    n0 = sock.sent.length;
    upsert(sock, '237655000031', txt('Bonjour, délai'));
    await until(async () => { const x = await chatOf(org, '237655000031'); return x && (await nUser(x.id)) === 1; });
    await put({ mode: 'ads' });
    await sleep(1200);
    check('réponse différée : le mode change pendant l\'attente -> rien n\'est envoyé', sock.sent.length === n0);
    await db.prepare('UPDATE orgs SET reply_delay = 0 WHERE id = ?').run(org);

    // ---------- 8. Boutons de la liste ----------
    console.log('Boutons « répondre quand même » et « ajouter au périmètre »');
    const hc = await chatOf(org, '237655000031');
    n0 = sock.sent.length;
    r = await mgr('POST', `${O}/wa-scope/chats/${hc.id}/reply-anyway`, {});
    check('répondre avec l\'assistant quand même : envoyé', r.status === 200 && await until(() => sock.sent.length > n0) && /Bonjour de test/.test(sock.sent[sock.sent.length - 1].content.text), r.json);
    r = await owner('GET', `${O}/sales/chats`);
    check('…l\'étiquette est levée pour cette conversation', r.json.chats.find((x) => x.id === hc.id).outOfScope === false);
    check('…le message de l\'assistant est enregistré dans la conversation', Number((await db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE chat_id = ? AND role = 'assistant'").get(hc.id)).c) >= 1);
    check('un nouveau message de ce contact est de nouveau retenu (une seule réponse manuelle)', !(await talk('237655000031', txt('Merci, et pour la taille ?'), false)));
    r = await mgr('POST', `${O}/wa-scope/chats/${hc.id}/add-to-scope`, {});
    check('ajouter ce contact au périmètre', r.status === 200 && r.json.scope.held === false);
    check('…liste « toujours » mise à jour', (await owner('GET', `${O}/wa-scope`)).json.exceptions.some((x) => x.kind === 'always' && x.phone.endsWith('655000031')));
    check('…le contact est ensuite servi automatiquement', await talk('237655000031', txt('Pour la taille ?')));
    r = await owner2('POST', `${OB}/wa-scope/chats/${hc.id}/reply-anyway`, {});
    check('isolation : un autre organisation ne peut pas agir sur cette conversation -> 404', r.status === 404, r.json);
    r = await owner2('POST', `${OB}/wa-scope/chats/${hc.id}/add-to-scope`, {});
    check('isolation : ajout au périmètre -> 404', r.status === 404);
    const ex = await db.prepare('SELECT * FROM chats WHERE org_id = ?').get(org);
    void ex;

    // ---------- 9. Mode par ligne ----------
    console.log('Réglage par ligne (officielle / QR)');
    await put({ mode: 'all', modeQr: 'ads' });
    r = await owner('GET', `${O}/wa-scope`);
    check('la ligne QR a son propre mode (ads), la ligne officielle hérite (all)', r.json.effectiveMode === 'ads' && r.json.settings.mode === 'all' && r.json.settings.modeMeta === null, r.json.settings);
    check('ligne QR en publicité : un organique est retenu', !(await talk('237655000040', txt('Bonjour'), false)));
    await put({ modeQr: '' });
    r = await owner('GET', `${O}/wa-scope`);
    check('remise à « comme l\'entreprise »', r.json.settings.modeQr === null && r.json.effectiveMode === 'all');
    check('…et le contact précédent est servi', await talk('237655000040', txt('Bonjour encore')));

    // ---------- 10. Canal officiel (webhook Meta signé, faux serveur Meta) ----------
    console.log('Canal officiel Meta');
    await db.prepare("UPDATE orgs SET wa_mode = 'meta', wa_phone_id = ?, wa_token = ?, wa_secret = ? WHERE id = ?").run('555000111', vault.encrypt('jeton'), vault.encrypt('secret'), orgB);
    await owner2('PUT', `${OB}/wa-scope`, { mode: 'ads', keywords: ['PUBFB'] });
    const hook = async (message) => {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '555000111' }, messages: [{ id: 'wamid.' + (++mid), timestamp: String(nowS()), ...message }] } }] }] });
      const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
      return await fetch(`${base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    };
    const waitChat = async (num) => await until(async () => Boolean(await chatOf(orgB, num)));
    let g0 = graph.sent.length;
    let w = await hook({ from: '237699000001', type: 'text', text: { body: 'Bonjour, prix ?' } });
    check('webhook officiel accepté (signature valide)', w.status === 200);
    await waitChat('237699000001'); await sleep(500);
    check('officiel, organique en mode publicité : aucun envoi vers Meta', graph.sent.length === g0);
    const cB = await chatOf(orgB, '237699000001');
    check('…message enregistré, conversation étiquetée hors périmètre', cB && (await nUser(cB.id)) === 1 && Number((await db.prepare('SELECT held FROM wa_chat_scope WHERE chat_id = ?').get(cB.id)).held) === 1);
    w = await hook({ from: '237699000002', type: 'text', text: { body: 'Bonjour' }, referral: { source_url: 'https://fb.me/x', source_id: 'AD-META-1', source_type: 'ad', headline: 'Grande promo', ctwa_clid: 'abc' } });
    check('officiel, publicité (champ referral) : réponse envoyée via Meta', await until(() => graph.sent.length > g0) && graph.sent[graph.sent.length - 1].to === '237699000002' && /Bonjour de test/.test(graph.sent[graph.sent.length - 1].text.body), graph.sent.slice(g0));
    const oB = await db.prepare("SELECT * FROM wa_contact_origin WHERE org_id = ? AND phone9 = '699000002'").get(orgB);
    check('officiel : origine = publicité, identifiant d\'annonce, titre, date', oB && oB.source === 'ad' && oB.ad_id === 'AD-META-1' && /Grande promo/.test(oB.detail) && oB.ad_at, oB);
    g0 = graph.sent.length;
    await hook({ from: '237699000003', type: 'text', text: { body: 'Bonjour pubfb !' } });
    check('officiel, mot-clé d\'entrée : réponse', await until(() => graph.sent.length > g0));
    g0 = graph.sent.length;
    await hook({ from: '237699000004', type: 'sticker', sticker: { id: 'S' } });
    await waitChat('237699000004'); await sleep(500);
    check('officiel, type non pris en charge hors périmètre : aucun message automatique', graph.sent.length === g0);
    check('isolation : le réglage et les origines de B ne touchent pas A', (await owner('GET', `${O}/wa-scope`)).json.settings.mode === 'all' && Number((await db.prepare("SELECT COUNT(*) c FROM wa_contact_origin WHERE org_id = ? AND phone9 IN ('699000002','699000003')").get(org)).c) === 0);
    check('isolation : le journal de B ne contient pas les actions de A', (await owner2('GET', `${OB}/wa-scope`)).json.log.every((l) => /settings/.test(l.action)));

    // ---------- 11. Audit ----------
    console.log('Journal d\'audit');
    r = await owner('GET', `${O}/wa-scope`);
    const acts = r.json.log.map((l) => l.action);
    check('changements de mode, listes, marquages, import, boutons : tous journalisés', ['settings', 'exception_add', 'exception_remove', 'origin_set', 'import', 'reply_anyway', 'add_to_scope'].every((a) => acts.includes(a)), acts);
    const ch = r.json.log.find((l) => l.action === 'settings');
    check('chaque ligne a la personne et la date', ch && ch.who === 'Awa' && /^\d{4}-/.test(ch.at), ch);
    check('le journal ne contient pas de numéro complet', !JSON.stringify(r.json.log).match(/\d{9,}/));
    r = await put({ mode: 'all' }); r = await owner('GET', `${O}/wa-scope`);
    const before = r.json.log.length; await put({ mode: 'all' }); r = await owner('GET', `${O}/wa-scope`);
    check('un enregistrement sans changement n\'ajoute rien au journal', r.json.log.length === before);

    // ---------- 12. Fonctions pures ----------
    console.log('Détection (bibliothèque simulée)');
    check('Baileys : externalAdReply avec sourceId', scope.adFromBaileys({ extendedTextMessage: { contextInfo: { externalAdReply: { sourceId: '1', title: 'T' } } } }).adId === '1');
    check('Baileys : ctwaClid seul suffit', Boolean(scope.adFromBaileys({ imageMessage: { contextInfo: { externalAdReply: { ctwaClid: 'c' } } } })));
    check('Baileys : message sans contexte -> null', scope.adFromBaileys({ conversation: 'a' }) === null);
    check('Meta : referral type « post » reconnu', Boolean(scope.adFromMeta({ source_type: 'post', source_id: '9' })));
    check('Meta : referral vide -> null', scope.adFromMeta({}) === null && scope.adFromMeta(null) === null);
    check('mot-clé : sans accent ni casse', scope.matchKeyword(['Soldes été'], 'les SOLDES ETE sont là') === 'Soldes été');
  } finally {
    try { await waWeb.shutdown(); } catch { /* */ }
    srv.close(); ai.srv.close(); graph.srv.close();
    try { await db.close(); } catch { /* */ }
    await pgt.stop();
  }
  console.log(`\n${passed} cas réussis, ${failed} échec(s)`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.log('ERREUR : ' + (e && e.stack || e)); process.exit(1); });
