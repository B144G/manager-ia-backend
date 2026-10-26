'use strict';
// Connexion WhatsApp en un clic (Embedded Signup) + webhook commun, avec un FAUX serveur Graph local (aucun appel réel à Meta).
// Lancez : npm run test:embedded
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_ID = '1234567890', APP_SECRET = 'secret-appli-de-test-xyz', CONFIG_ID = '998877665544', VERIFY = 'verif-commun-test';

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

// Faux serveur Graph (et faux Claude : réponse générique)
function fakeGraph() {
  const seen = { exchange: [], register: [], subs: [], sent: [] };
  const mode = { registerAlready: false, badCode: false };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const auth = req.headers.authorization || '';
      const u = new URL(req.url, 'http://x');
      if (!u.pathname.startsWith('/graph/')) return res.end(JSON.stringify({ content: [{ type: 'text', text: '{"reply":"Bonjour de test","action":null}' }] }));
      const p = u.pathname.slice(6);
      if (p === '/oauth/access_token') {
        seen.exchange.push({ method: req.method, id: u.searchParams.get('client_id'), secret: u.searchParams.get('client_secret'), code: u.searchParams.get('code') });
        if (mode.badCode || u.searchParams.get('code') === 'CODE-INVALIDE-0000') { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Code expiré', code: 100 } })); }
        return res.end(JSON.stringify({ access_token: 'EAAB-jeton-entreprise-' + u.searchParams.get('code'), token_type: 'bearer' }));
      }
      let m;
      if ((m = /^\/(\d+)\/register$/.exec(p)) && req.method === 'POST') {
        const j = JSON.parse(b || '{}'); seen.register.push({ phone: m[1], auth, pin: j.pin, product: j.messaging_product });
        if (mode.registerAlready) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Phone number is already registered', code: 100 } })); }
        return res.end(JSON.stringify({ success: true }));
      }
      if ((m = /^\/(\d+)\/subscribed_apps$/.exec(p))) { seen.subs.push({ method: req.method, waba: m[1], auth }); return res.end(req.method === 'POST' ? JSON.stringify({ success: true }) : JSON.stringify({ data: [{ whatsapp_business_api_data: { name: 'Manager-ia' } }] })); }
      if ((m = /^\/(\d+)\/messages$/.exec(p)) && req.method === 'POST') { const j = JSON.parse(b || '{}'); seen.sent.push({ phone: m[1], to: j.to, body: (j.text || {}).body }); return res.end(JSON.stringify({ messages: [{ id: 'wamid.out' }] })); }
      if ((m = /^\/(\d+)$/.exec(p))) return res.end(JSON.stringify({ display_phone_number: '+237 6' + m[1].slice(-8), verified_name: 'Test' }));
      res.statusCode = 404; return res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, mode, port: srv.address().port })));
}

async function boot(pgt, fake, extra) {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'META_EMBEDDED_CONFIG_ID', 'META_WEBHOOK_VERIFY_TOKEN', 'META_VERIFY_TOKEN'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url,
    ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`, META_GRAPH_URL: `http://127.0.0.1:${fake.port}/graph`, ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', TRUST_PROXY: '0', WS_AI_FREE: '100', SIGNUP_VERIFY: 'off', WEBHOOK_ALLOW_PRIVATE: '1', REPLY_DELAY_SCALE: '20', REPLY_TICK_MS: '50', ...extra };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log('Le serveur n\'a pas démarré.\n' + out); process.exit(1); }
  return { base, child, log: () => out };
}

async function main() {
  const fake = await fakeGraph();
  const pgt = await startTestPg();
  const stamp = Date.now();
  let s1; let s2;
  try {
    // ---------- 1. Fonction désactivée (variables absentes) ----------
    console.log('Désactivée sans variables');
    s1 = await boot(pgt, fake, {});
    const owner0 = client(s1.base);
    await owner0('POST', '/api/register', { name: 'Awa', contact: `awa${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner0('POST', '/api/ws/orgs', { name: 'Boutique Awa' });
    const org0 = r.json.id;
    r = await owner0('GET', `/api/ws/orgs/${org0}/sales/whatsapp/embedded/config`);
    check('config : enabled=false, sans identifiants', r.status === 200 && r.json.enabled === false && !JSON.stringify(r.json).includes(APP_ID), r.json);
    r = await owner0('POST', `/api/ws/orgs/${org0}/sales/whatsapp/embedded/complete`, { code: 'CODE-VALIDE-12345', phoneNumberId: '100200300', wabaId: '555666777' });
    check('complete -> 404 clair', r.status === 404 && /pas disponible/.test(r.json.error), r.json);
    let w = await fetch(`${s1.base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=X`);
    check('webhook commun : vérification refusée sans variable -> 403', w.status === 403);
    w = await fetch(`${s1.base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('webhook commun : message sans secret configuré -> 503', w.status === 503);
    s1.child.kill(); await sleep(500);

    // ---------- 2. Fonction activée ----------
    console.log('Activée (faux serveur Graph)');
    s2 = await boot(pgt, fake, { META_APP_ID: APP_ID, META_APP_SECRET: APP_SECRET, META_EMBEDDED_CONFIG_ID: CONFIG_ID, META_WEBHOOK_VERIFY_TOKEN: VERIFY });
    const base = s2.base;
    const owner = client(base); const owner2 = client(base); const staff = client(base);
    await owner('POST', '/api/login', { contact: `awa${stamp}@exemple.com`, pass: 'secret123' });
    let who;
    await owner2('POST', '/api/register', { name: 'Zoe', contact: `zoe${stamp}@exemple.com`, pass: 'secret123' });
    await staff('POST', '/api/register', { name: 'Paul', contact: `paul${stamp}@exemple.com`, pass: 'secret123' });
    who = await owner('GET', '/api/ws/orgs');
    const org = who.json.orgs[0].id;
    check('connexion du propriétaire créé avant le redémarrage', Boolean(org), who.json);
    r = await owner2('POST', '/api/ws/orgs', { name: 'Atelier Zoe' });
    const orgB = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/invites`, { role: 'member' });
    await staff('POST', '/api/ws/orgs/join', { code: r.json.code });
    const SL = `/api/ws/orgs/${org}/sales`; const SLB = `/api/ws/orgs/${orgB}/sales`;

    r = await owner('GET', `${SL}/whatsapp/embedded/config`);
    check('config : enabled, appId, configId, version ; aucun secret', r.status === 200 && r.json.enabled === true && r.json.appId === APP_ID && r.json.configId === CONFIG_ID && /^v\d+\.\d+$/.test(r.json.graphVersion) && !JSON.stringify(r.json).includes(APP_SECRET), r.json);
    r = await staff('GET', `${SL}/whatsapp/embedded/config`);
    check('config : rôle insuffisant -> 403', r.status === 403, r.json);
    r = await staff('POST', `${SL}/whatsapp/embedded/complete`, { code: 'CODE-VALIDE-12345', phoneNumberId: '100200300', wabaId: '555666777' });
    check('complete : rôle insuffisant -> 403', r.status === 403, r.json);
    r = await owner2('POST', `${SL}/whatsapp/embedded/complete`, { code: 'CODE-VALIDE-12345', phoneNumberId: '100200300', wabaId: '555666777' });
    check('complete : personne extérieure à l\'organisation -> 404', r.status === 404, r.json);

    const body = (o) => ({ code: 'CODE-VALIDE-12345', phoneNumberId: '100200300', wabaId: '555666777', ...o });
    for (const [label, o] of [['numéro avec lettres', { phoneNumberId: 'abc123' }], ['numéro trop court', { phoneNumberId: '1234' }], ['compte invalide', { wabaId: '12 34' }], ['code trop court', { code: 'court' }], ['code avec espace', { code: 'CODE AVEC ESPACE 123' }], ['code trop long', { code: 'a'.repeat(601) }], ['code absent', { code: undefined }]]) {
      r = await owner('POST', `${SL}/whatsapp/embedded/complete`, body(o));
      check(`complete : ${label} -> 400`, r.status === 400 && typeof r.json.error === 'string', r.json);
    }
    check('formats invalides : aucun appel à Meta', fake.seen.exchange.length === 0, fake.seen.exchange);

    r = await owner('POST', `${SL}/whatsapp/embedded/complete`, body({ code: 'CODE-INVALIDE-0000' }));
    check('code refusé par Meta -> 502 en français, sans détail sensible', r.status === 502 && /code de connexion/.test(r.json.error) && !r.json.error.includes(APP_SECRET), r.json);
    r = await owner('GET', `${SL}/whatsapp`);
    check('après un échec : rien d\'enregistré', r.json.connected === false && r.json.phoneId === '', r.json);

    fake.mode.registerAlready = true;
    r = await owner('POST', `${SL}/whatsapp/embedded/complete`, body());
    const resp = JSON.stringify(r.json);
    check('complete : réussi (erreur « déjà enregistré » tolérée)', r.status === 200 && r.json.ok === true && r.json.connected === true && r.json.phoneId === '100200300' && r.json.wabaId === '555666777' && /^2376\d+/.test(r.json.number), r.json);
    check('réponse : ni jeton, ni secret, ni PIN', !resp.includes('EAAB') && !resp.includes(APP_SECRET) && !resp.includes(fake.seen.register[0].pin), resp.slice(0, 200));
    const ex = fake.seen.exchange[fake.seen.exchange.length - 1];
    check('échange du code : GET avec client_id, client_secret, code', ex.method === 'GET' && ex.id === APP_ID && ex.secret === APP_SECRET && ex.code === 'CODE-VALIDE-12345', ex);
    const rg = fake.seen.register[0];
    check('enregistrement du numéro : jeton envoyé, produit whatsapp, PIN à 6 chiffres', rg.phone === '100200300' && /^Bearer EAAB-jeton-entreprise-/.test(rg.auth) && rg.product === 'whatsapp' && /^\d{6}$/.test(rg.pin), rg);
    const sb = fake.seen.subs.find((x) => x.method === 'POST');
    check('abonnement de l\'application au compte', sb && sb.waba === '555666777' && /^Bearer EAAB/.test(sb.auth), fake.seen.subs);
    const rawDb = await pgt.open();
    const row = await rawDb.prepare('SELECT wa_phone_id, wa_waba, wa_number, wa_token, wa_secret, wa_verify FROM orgs WHERE id = ?').get(org);
    const { decrypt } = (() => { process.env.JWT_SECRET = 'secret-de-test-assez-long-123456'; process.env.DATABASE_URL = pgt.url; process.env.NODE_ENV = 'test'; return require('../src/services/vault'); })();
    check('base : jeton et secret chiffrés, lisibles avec la clé', /^v1:/.test(row.wa_token) && !row.wa_token.includes('EAAB') && /^v1:/.test(row.wa_secret) && !row.wa_secret.includes(APP_SECRET) && decrypt(row.wa_token).startsWith('EAAB-jeton-entreprise-') && decrypt(row.wa_secret) === APP_SECRET, row.wa_token.slice(0, 6));
    check('base : numéro, compte et jeton de vérification enregistrés', row.wa_phone_id === '100200300' && row.wa_waba === '555666777' && /^\d{8,15}$/.test(row.wa_number) && /^[a-f0-9]{24}$/.test(row.wa_verify), row);
    const aud = await rawDb.prepare("SELECT action, severity, detail FROM audit_trail WHERE action = 'channel.whatsapp_embedded'").all().catch(() => null);
    check('journal d\'audit : action sensible enregistrée, sans secret', Array.isArray(aud) && aud.length >= 1 && !JSON.stringify(aud).includes('EAAB') && !JSON.stringify(aud).includes(APP_SECRET), aud);
    const outLog = s2.log();
    check('journaux du serveur : ni jeton, ni secret, ni PIN', !outLog.includes('EAAB') && !outLog.includes(APP_SECRET) && !outLog.includes(rg.pin + '"'), outLog.slice(-200));
    r = await owner('POST', `${SL}/whatsapp/test`);
    check('la connexion enregistrée est utilisable (test du numéro)', r.status === 200 && /^\+237/.test(r.json.number), r.json);

    // Isolation et numéro déjà pris
    r = await owner2('POST', `${SLB}/whatsapp/embedded/complete`, body({ code: 'AUTRE-CODE-VALIDE-1' }));
    check('numéro déjà connecté à une autre organisation -> 409', r.status === 409 && /autre organisation/.test(r.json.error), r.json);
    r = await owner2('PUT', `${SLB}/whatsapp`, { phoneId: '100200300' });
    check('saisie manuelle : même numéro déjà pris -> 409', r.status === 409, r.json);
    r = await owner2('GET', `${SLB}/whatsapp`);
    check('isolation : l\'autre organisation n\'a rien reçu', r.json.connected === false && r.json.phoneId === '', r.json);
    r = await owner('POST', `${SL}/whatsapp/embedded/complete`, body({ code: 'CODE-VALIDE-REPRISE' }));
    check('reconnecter son propre numéro est permis', r.status === 200, r.json);
    fake.mode.registerAlready = false;
    r = await owner2('POST', `${SLB}/whatsapp/embedded/complete`, body({ code: 'CODE-VALIDE-ZOE-1', phoneNumberId: '200300400', wabaId: '888999000' }));
    check('deuxième organisation, autre numéro -> 200', r.status === 200 && r.json.phoneId === '200300400', r.json);

    // ---------- 3. Webhook commun ----------
    console.log('Webhook commun');
    const WH = `${base}/api/webhooks/whatsapp`;
    let v = await fetch(`${WH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=DEFI42`);
    check('vérification Meta : renvoie le défi', v.status === 200 && (await v.text()) === 'DEFI42');
    v = await fetch(`${WH}?hub.mode=subscribe&hub.verify_token=mauvais&hub.challenge=DEFI42`);
    check('vérification : mauvais jeton -> 403', v.status === 403);
    const payload = (from, id, text, pid) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: pid }, contacts: [{ profile: { name: 'Client' }, wa_id: from }], messages: [{ from, id, timestamp: '1', type: 'text', text: { body: text } }] } }] }] });
    const post = (obj, secret = APP_SECRET, sig) => { const raw = JSON.stringify(obj); return fetch(WH, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-hub-signature-256': sig || 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }) }, body: raw }); };
    v = await post(payload('237655000001', 'wamid.x1', 'Bonjour', '100200300'), 'mauvais-secret');
    check('signature invalide -> 403', v.status === 403);
    v = await post(payload('237655000001', 'wamid.x1', 'Bonjour', '100200300'), APP_SECRET, null);
    check('signature absente -> 403', v.status === 403);
    const chatsOf = async (c, sl) => ((await c('GET', `${sl}/chats`)).json || {}).chats || [];
    const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(60); } return false; };
    check('aucun message traité après les rejets', (await chatsOf(owner, SL)).length === 0 && (await chatsOf(owner2, SLB)).length === 0);
    v = await post(payload('237655000001', 'wamid.a1', 'Bonjour, je veux des infos', '100200300'));
    check('message signé pour le numéro de l\'organisation A -> 200', v.status === 200);
    await waitFor(async () => (await chatsOf(owner, SL)).length >= 1);
    v = await post(payload('237655000002', 'wamid.b1', 'Salut, vos horaires ?', '200300400'));
    await waitFor(async () => (await chatsOf(owner2, SLB)).length >= 1);
    const cA = await chatsOf(owner, SL); const cB = await chatsOf(owner2, SLB);
    check('organisation A : seulement sa conversation', cA.length === 1 && cA[0].contact === '237655000001' && cA[0].channel === 'whatsapp', cA);
    check('organisation B : seulement sa conversation', cB.length === 1 && cB[0].contact === '237655000002' && cB[0].channel === 'whatsapp', cB);
    v = await post(payload('237655000003', 'wamid.z1', 'Message perdu', '999111222'));
    check('numéro inconnu : ignoré avec 200', v.status === 200);
    await sleep(600);
    check('numéro inconnu : aucune conversation créée, rien envoyé', (await chatsOf(owner, SL)).length === 1 && (await chatsOf(owner2, SLB)).length === 1 && !fake.seen.sent.some((x) => x.to === '237655000003'), fake.seen.sent);
    check('journal du numéro inconnu sans contenu', /numéro inconnu/.test(s2.log()) && !s2.log().includes('Message perdu'));
    v = await post(payload('237655000001', 'wamid.a1', 'Bonjour, je veux des infos', '100200300'));
    await sleep(400);
    check('message déjà vu (doublon) : pas de seconde conversation', (await chatsOf(owner, SL)).length === 1);
    v = await post({ object: 'page', entry: [] });
    check('autre type d\'objet : accepté et ignoré', v.status === 200);
    // Le webhook par organisation continue de fonctionner (même fonction de traitement)
    const tok = (await owner('GET', `/api/ws/orgs/${org}`)).json.intakeToken;
    const raw = JSON.stringify(payload('237655000009', 'wamid.o1', 'Via le webhook de l\'organisation', '100200300'));
    v = await fetch(`${base}/api/ws/public/whatsapp/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex') }, body: raw });
    check('webhook par organisation : toujours fonctionnel avec le secret partagé', v.status === 200 && await waitFor(async () => (await chatsOf(owner, SL)).length >= 2));
    await rawDb.close();
  } finally {
    if (process.env.SMOKE_LOG && s2) console.log(s2.log().split('\n').slice(-25).join('\n'));
    if (s1) s1.child.kill(); if (s2) s2.child.kill();
    fake.srv.close(); await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
