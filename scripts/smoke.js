'use strict';
// Test de fumée : démarre le serveur avec une configuration de test (sans aucune clé externe)
// et vérifie les routes principales. Lancez-le avec : npm run smoke
// Pour tester un serveur déjà démarré : SMOKE_URL=http://localhost:3000 (alors ADMIN_USERNAME / ADMIN_PASSWORD requis).
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const APP_SECRET = 'secret-de-test-meta';
const VERIFY = 'verif-test';
const ADMIN = { username: 'admin-test', password: 'mot-de-passe-admin-test' };

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  OK   ' + name); }
  else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mini "client" avec mémoire des cookies (un par session simulée)
function client(base) {
  const jar = {};
  return async function call(method, url, body, extraHeaders, raw) {
    const headers = { ...(extraHeaders || {}) };
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || /expires=thu, 01 jan 1970/i.test(sc)) delete jar[k]; else jar[k] = v;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* pas du JSON */ }
    return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.getSetCookie() };
  };
}

async function main() {
  let child = null;
  let dbFile = null;
  let base = process.env.SMOKE_URL;
  let admin = ADMIN;

  if (!base) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    dbFile = path.join(os.tmpdir(), `manager-ia-smoke-${process.pid}.db`);
    const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
      'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'PAGE_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'SITE_URL'];
    const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456',
      DB_PATH: dbFile, ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password, META_APP_SECRET: APP_SECRET, META_VERIFY_TOKEN: VERIFY,
      MTN_NUMBER: '670000001', ORANGE_NUMBER: '690000002', PAYMENT_HOLDER_NAME: 'Titulaire Test', TRUST_PROXY: '0' };
    child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { if (code) console.log('Le serveur s\'est arrêté (code ' + code + ') :\n' + out); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(250);
      try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas encore prêt */ }
    }
    if (!up) { console.log('Le serveur n\'a pas démarré.\n' + out); process.exit(1); }
  } else {
    admin = { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD };
  }

  const stamp = Date.now();
  const email = `test${stamp}@exemple.com`;
  const phone = '6' + String(stamp).slice(-8);
  try {
    const user = client(base);
    const anon = client(base);
    const adm = client(base);

    console.log('Santé');
    let r = await anon('GET', '/api/health');
    check('GET /api/health', r.status === 200 && r.json.ok === true);

    console.log('Inscription / connexion');
    r = await user('POST', '/api/register', { name: 'Awa Test', contact: email.toUpperCase(), pass: 'secret123', interests: ['ia', 'app'] });
    check('register -> 201', r.status === 201, r.json);
    const u = r.json && r.json.user;
    check('user : forme correcte', u && u.plan === 'Gratuit' && u.planExpires === null && u.contact === email && Array.isArray(u.interests) && typeof u.progress === 'object' && typeof u.project === 'object' && u.created && !('pass_hash' in u) && !('pass' in u), u);
    check('cookie mia_token httpOnly', r.setCookie.some((c) => c.startsWith('mia_token=') && /httponly/i.test(c)), r.setCookie);

    r = await anon('POST', '/api/register', { name: 'Autre', contact: email, pass: 'secret123' });
    check('doublon -> 409 + message', r.status === 409 && r.json.error === 'Un compte existe déjà avec ce contact. Utilisez « Me connecter ».', r.json);
    r = await anon('POST', '/api/register', { name: 'A', contact: 'pas-un-contact', pass: 'secret123' });
    check('contact invalide -> 400', r.status === 400 && typeof r.json.error === 'string', r.json);
    r = await anon('POST', '/api/register', { name: 'Court', contact: '690000099', pass: '123' });
    check('mot de passe trop court -> 400', r.status === 400, r.json);

    r = await anon('POST', '/api/login', { contact: email, pass: 'mauvais' });
    check('login faux -> 401 + message', r.status === 401 && r.json.error === 'Contact ou mot de passe incorrect.', r.json);
    r = await anon('GET', '/api/me');
    check('me sans cookie -> 401', r.status === 401 && r.json.error);
    r = await anon('POST', '/api/login', { contact: email, pass: 'secret123' });
    check('login -> user', r.status === 200 && r.json.user && r.json.user.contact === email, r.json);
    r = await anon('GET', '/api/me');
    check('me avec cookie', r.status === 200 && r.json.user.contact === email);

    console.log('Numéro de téléphone (normalisation)');
    const ph = client(base);
    r = await ph('POST', '/api/register', { name: 'Tel Test', contact: `+237 ${phone.slice(0, 1)} ${phone.slice(1, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`, pass: 'secret123' });
    check('inscription par numéro', r.status === 201 && r.json.user.contact === '237' + phone, r.json);
    r = await anon('POST', '/api/login', { contact: phone, pass: 'secret123' });
    check('login avec numéro écrit autrement', r.status === 200, r.json);

    console.log('État utilisateur');
    r = await user('PUT', '/api/me/state', { interests: ['ia', 'web', 'app'], progress: { 'ia:0': true, 'web:1': true }, project: { '2026-10': { domain: 'ia', done: false } } });
    check('PUT state (2 domaines) OK', r.status === 200 && r.json.user.interests.length === 3 && r.json.user.progress['ia:0'] === true && r.json.user.project['2026-10'].domain === 'ia', r.json);
    r = await user('PUT', '/api/me/state', { interests: ['ia', 'web', 'trading'], progress: {}, project: {} });
    check('3e domaine en Gratuit -> 403', r.status === 403 && r.json.error === "L'offre Gratuite donne accès à 2 domaines. Passez à l'offre Pro.", r.json);
    r = await user('PUT', '/api/me/state', { interests: ['ia'], progress: { 'inconnu:1': true }, project: {} });
    check('clé de progression inconnue -> 400', r.status === 400, r.json);
    r = await user('PUT', '/api/me/state', { interests: ['ia'], progress: {}, project: {}, plan: 'Pro Max', planExpires: '2099-01-01T00:00:00Z' });
    check('plan non modifiable par le client', r.status === 200 && r.json.user.plan === 'Gratuit' && r.json.user.planExpires === null, r.json);

    console.log('Contact, offres, assistant');
    r = await anon('POST', '/api/contact', { name: 'Visiteur', what: 'Application sur mesure', message: 'Bonjour, je voudrais un devis.', contact: '699000111' });
    check('contact -> ok', r.status === 200 && r.json.ok === true, r.json);
    r = await anon('POST', '/api/contact', { name: '', message: '' });
    check('contact invalide -> 400', r.status === 400);
    r = await anon('GET', '/api/plans');
    check('plans', r.status === 200 && r.json.plans.length === 4 && r.json.plans[0].id === 'pro' && r.json.plans[0].priceXAF === 50000 && r.json.plans[1].priceXAF === 75000 && r.json.durationDays === 30 && r.json.automatic === false && r.json.manual.mtn === '670000001' && r.json.manual.holder === 'Titulaire Test', r.json);
    r = await anon('POST', '/api/assistant', { messages: [{ role: 'user', content: 'Bonjour' }] });
    check('assistant sans clé -> 503', r.status === 503 && r.json.error === 'Assistant indisponible', r.json);

    console.log('Paiement manuel');
    r = await client(base)('POST', '/api/payments/initiate', { plan: 'pro', operator: 'mtn', phone: '670000010' });
    check('initiate sans connexion -> 401', r.status === 401, r.status);
    r = await user('POST', '/api/payments/initiate', { plan: 'gold', operator: 'mtn', phone: '670000010' });
    check('offre inconnue -> 400', r.status === 400);
    r = await user('POST', '/api/payments/initiate', { plan: 'pro', operator: 'mtn', phone: '670000010' });
    const pay = r.json;
    check('initiate manuel', r.status === 200 && pay.mode === 'manual' && pay.status === 'pending' && pay.amountXAF === 50000 && /^MI-[A-Z0-9]{6}$/.test(pay.reference) && pay.instructions.includes(pay.reference) && pay.instructions.includes('670000001') && pay.instructions.includes('Titulaire Test'), r.json);
    r = await user('GET', '/api/payments/' + pay.reference);
    check('statut pending', r.status === 200 && r.json.status === 'pending' && r.json.plan === 'pro', r.json);
    r = await client(base)('POST', '/api/payments/confirm-manual', { reference: pay.reference, transactionId: 'XXXX' });
    check('confirm-manual sans connexion -> 401', r.status === 401, r.json);
    r = await user('POST', '/api/payments/confirm-manual', { reference: pay.reference, transactionId: 'MP240101.1234.A56789' });
    check('confirm-manual', r.status === 200 && r.json.status === 'awaiting_validation', r.json);
    r = await user('GET', '/api/payments/' + pay.reference);
    check('statut awaiting_validation', r.json.status === 'awaiting_validation', r.json);

    console.log('Administration');
    r = await adm('GET', '/api/admin/stats');
    check('admin sans connexion -> 401', r.status === 401);
    r = await adm('POST', '/api/admin/login', { username: admin.username, password: 'faux' });
    check('admin mauvais mot de passe -> 401', r.status === 401);
    r = await adm('POST', '/api/admin/login', { username: admin.username, password: admin.password });
    check('admin login', r.status === 200 && r.setCookie.some((c) => c.startsWith('mia_admin=')), r.json);
    r = await user('GET', '/api/admin/stats');
    check('un utilisateur simple n\'est pas admin', r.status === 401);

    r = await adm('GET', '/api/admin/payments?status=awaiting_validation');
    const row = r.json.payments.find((p) => p.reference === pay.reference);
    check('paiement visible dans l\'admin', r.status === 200 && row && row.transactionId === 'MP240101.1234.A56789' && row.user.contact === email, r.json);
    r = await adm('POST', `/api/admin/payments/${row.id}/validate`);
    check('validation du paiement', r.status === 200 && r.json.status === 'paid', r.json);
    r = await adm('POST', `/api/admin/payments/${row.id}/validate`);
    check('double validation refusée (jamais deux fois)', r.status === 409, r.json);

    r = await user('GET', '/api/me');
    const days = r.json.user.planExpires ? (new Date(r.json.user.planExpires) - Date.now()) / 86400000 : -1;
    check('utilisateur passé Pro, expiration ~30 jours', r.json.user.plan === 'Pro' && days > 29.9 && days < 30.1, { plan: r.json.user.plan, days });
    r = await user('GET', '/api/payments/' + pay.reference);
    check('statut paid', r.json.status === 'paid');
    r = await user('PUT', '/api/me/state', { interests: ['ia', 'web', 'trading', 'stat'], progress: {}, project: {} });
    check('Pro : plus de limite de domaines', r.status === 200 && r.json.user.interests.length === 4, r.json);

    r = await adm('GET', '/api/admin/stats');
    const s = r.json;
    check('stats', r.status === 200 && s.users >= 2 && s.byPlan.Pro === 1 && s.revenueMonthXAF === 50000 && s.leads === 1 && s.byInterest.ia >= 1 && s.pendingPayments >= 0, s);
    r = await adm('GET', '/api/admin/users?q=' + encodeURIComponent('awa'));
    check('recherche inscrits', r.status === 200 && r.json.users.length === 1 && r.json.users[0].name === 'Awa Test' && !('pass_hash' in r.json.users[0]), r.json);
    r = await adm('GET', '/api/admin/users?plan=Pro');
    check('filtre par offre', r.json.users.length === 1);
    r = await adm('POST', `/api/admin/users/${u.id}/plan`, { plan: 'Pro Max', days: 10 });
    const d2 = (new Date(r.json.user.planExpires) - Date.now()) / 86400000;
    check('changer l\'offre manuellement', r.status === 200 && r.json.user.plan === 'Pro Max' && d2 > 9.9 && d2 < 10.1, r.json);
    r = await adm('POST', `/api/admin/users/${u.id}/plan`, { plan: 'Gratuit' });
    check('retour à Gratuit', r.json.user.plan === 'Gratuit' && r.json.user.planExpires === null);
    r = await adm('GET', '/api/admin/leads');
    check('leads', r.status === 200 && r.json.leads.length === 1 && r.json.leads[0].name === 'Visiteur');
    r = await adm('GET', '/api/admin/export/users.csv');
    check('export CSV (BOM + point-virgule)', r.status === 200 && r.text.includes(';') && r.text.includes(email.toLowerCase()) && /text\/csv/.test(r.headers.get('content-type')), r.text.slice(0, 120));
    r = await adm('GET', '/api/admin/notifications');
    const types = (r.json.notifications || []).map((n) => n.type);
    check('notifications enregistrées', ['inscription', 'contact', 'paiement_a_valider', 'paiement_confirme'].every((t) => types.includes(t)), types);
    r = await anon('GET', '/admin');
    check('page /admin servie', r.status === 200 && r.text.includes('Administration MANAGER-IA') && /content-security-policy/i.test([...r.headers.keys()].join(',')));
    r = await anon('GET', '/admin/admin.js');
    check('/admin/admin.js servi', r.status === 200 && r.text.includes('MANAGER-IA'));

    console.log('Sécurité');
    r = await anon('POST', '/api/contact', { name: 'X Y', message: 'test' }, { Origin: 'https://site-pirate.example' });
    check('origine inconnue refusée (POST)', r.status === 403 && r.json.error);
    r = await anon('POST', '/api/login', '{pas du json', { 'content-type': 'application/json' }, true);
    check('JSON invalide -> 400 en français', r.status === 400 && /invalide/i.test(r.json.error), r.json);
    r = await anon('GET', '/api/inexistant');
    check('route inconnue -> JSON 404', r.status === 404 && r.json.error);

    console.log('Webhooks Meta');
    r = await anon('GET', `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    check('GET vérification OK -> challenge', r.status === 200 && r.text === '12345', r.text);
    r = await anon('GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=mauvais&hub.challenge=12345');
    check('GET vérification mauvais jeton -> 403', r.status === 403);
    r = await anon('GET', `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=999`);
    check('GET /webhooks/meta vérification', r.status === 200 && r.text === '999');

    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '237670000555', id: 'wamid.TEST' + stamp, type: 'text', text: { body: 'Je veux parler à un conseiller' } }] } }] }] });
    const sign = (body, secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    r = await anon('POST', '/webhooks/whatsapp', payload, { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload, 'mauvais-secret') }, true);
    check('POST signature invalide -> 403', r.status === 403, r.text);
    r = await anon('POST', '/webhooks/whatsapp', payload, { 'content-type': 'application/json' }, true);
    check('POST sans signature -> 403', r.status === 403);
    r = await anon('POST', '/webhooks/whatsapp', payload, { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload, APP_SECRET) }, true);
    check('POST signature valide -> 200', r.status === 200, r.text);
    await sleep(700);
    r = await adm('GET', '/api/admin/notifications');
    check('demande de conseiller -> notification admin', (r.json.notifications || []).some((n) => n.type === 'conseiller'), (r.json.notifications || []).map((n) => n.type));
    const mpayload = JSON.stringify({ object: 'page', entry: [{ messaging: [{ sender: { id: 'psid1' }, message: { mid: 'm' + stamp, text: 'bonjour' } }] }] });
    r = await anon('POST', '/webhooks/meta', mpayload, { 'content-type': 'application/json', 'x-hub-signature-256': sign(mpayload, APP_SECRET) }, true);
    check('POST /webhooks/meta signature valide -> 200', r.status === 200);
    r = await anon('GET', '/api/payments/webhook/campay?reference=inconnu&external_reference=MI-AAAAAA');
    check('webhook Campay (GET) répond 200 sans rien activer', r.status === 200 && r.json.ok === true);
    r = await anon('POST', '/api/payments/webhook/campay', { reference: 'inconnu', status: 'SUCCESSFUL', external_reference: pay.reference });
    check('webhook Campay (POST) ne fait pas confiance au contenu', r.status === 200);

    console.log('Déconnexion');
    r = await user('POST', '/api/logout');
    check('logout', r.status === 200 && r.json.ok === true);
    r = await user('GET', '/api/me');
    check('me après logout -> 401', r.status === 401);
    r = await adm('POST', '/api/admin/logout');
    r = await adm('GET', '/api/admin/stats');
    check('admin logout', r.status === 401);
  } catch (e) {
    failed++;
    console.log('ERREUR INATTENDUE :', e);
  } finally {
    if (child) child.kill('SIGTERM');
    await sleep(300);
    if (dbFile) for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + suf); } catch { /* absent */ } }
  }

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  process.exit(failed ? 1 : 0);
}

main();
