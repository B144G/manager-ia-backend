'use strict';
// Test du centre de sécurité : sessions révocables, journal d'audit chaîné, double authentification (utilisateur et administrateur),
// blocage automatique d'adresses IP, actions sensibles, contrôle de configuration. Lancez : npm run smoke:central
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  OK   ' + n); } else { failed++; console.log('  ECHEC ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base, extraHeaders = {}) {
  const jar = {};
  const fn = async (method, url, body, hdrs = {}) => {
    const headers = { ...extraHeaders, ...hdrs, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    let json = null; const t = await res.text(); try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, headers: res.headers, text: t };
  };
  fn.jar = jar;
  return fn;
}

async function main() {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const pgt = await startTestPg();
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, TRUST_PROXY: '1', SIGNUP_VERIFY: 'off',
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', SECURITY_BAN_SCORE: '20' };
  // la même configuration pour calculer les codes à usage unique dans ce test
  process.env.DATABASE_URL = pgt.url; process.env.JWT_SECRET = env.JWT_SECRET;
  const totp = require('../src/security/totp');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }
  const raw = await pgt.open();
  try {
    const PASS = 'Cacao-Mangue-42';
    const mail = `central${Date.now()}@exemple.com`;
    const a = client(base); const b = client(base); const anon = client(base);
    let r;

    console.log('Numéro de requête');
    r = await anon('GET', '/api/health', undefined, { 'x-request-id': 'abc-12345678' });
    check('X-Request-Id renvoyé', r.headers.get('x-request-id') === 'abc-12345678', r.headers.get('x-request-id'));
    r = await anon('GET', '/api/health', undefined, { 'x-request-id': '<script>' });
    check('un numéro invalide est remplacé', /^[0-9a-f-]{36}$/.test(r.headers.get('x-request-id')), r.headers.get('x-request-id'));

    console.log('Sessions');
    r = await a('POST', '/api/register', { name: 'Central Test', contact: mail, pass: PASS });
    check('inscription', r.status === 201, r.json);
    r = await a('GET', '/api/security/overview');
    check('une session ouverte, marquée « cet appareil »', r.status === 200 && r.json.sessions.length === 1 && r.json.sessions[0].current === true, r.json);
    check('la liste ne montre pas de secret', !/mia_token|pass_hash|totp_secret/.test(r.text));
    await b('POST', '/api/login', { contact: mail, pass: PASS });
    r = await a('GET', '/api/security/overview');
    check('deux appareils', r.json.sessions.length === 2, r.json.sessions.length);
    const old = a.jar.mia_token;
    r = await a('POST', '/api/security/sessions/revoke-others', {});
    check('fermer les autres appareils', r.status === 200 && r.json.closed === 1, r.json);
    r = await b('GET', '/api/me');
    check("l'autre appareil est déconnecté tout de suite", r.status === 401, r.json);
    r = await a('GET', '/api/me');
    check('cet appareil reste connecté', r.status === 200, r.json);
    await a('POST', '/api/logout', {});
    r = await anon('GET', '/api/me', undefined, { cookie: 'mia_token=' + old });
    check('après la déconnexion, le même cookie rejoué est refusé', r.status === 401, r.json);
    await a('POST', '/api/login', { contact: mail, pass: PASS });
    const sid = (await a('GET', '/api/security/overview')).json.sessions[0].id;
    r = await a('DELETE', '/api/security/sessions/' + sid);
    check('fermer sa propre session', r.status === 200 && r.json.current === true, r.json);
    r = await a('GET', '/api/me');
    check('puis plus connecté', r.status === 401, r.json);

    console.log('Journal d\'audit');
    const adm = client(base);
    r = await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    check('connexion administrateur', r.status === 200, r.json);
    r = await adm('GET', '/api/admin/security/audit?limit=50');
    const acts = (r.json.events || []).map((e) => e.action);
    check('les connexions sont au journal', acts.includes('login.ok') && acts.includes('account.register') && acts.includes('admin.login'), acts);
    check('adresse, appareil et numéro de requête enregistrés', r.json.events.every((e) => e.ip !== undefined && e.requestId !== undefined), r.json.events[0]);
    r = await adm('POST', '/api/admin/security/audit/verify', {});
    check('chaîne intacte', r.status === 200 && r.json.ok === true && r.json.checked > 3, r.json);
    const row = await raw.prepare('SELECT id, detail FROM audit_trail WHERE id = 2').get();
    await raw.prepare("UPDATE audit_trail SET detail = 'falsifié' WHERE id = 2").run();
    r = await adm('POST', '/api/admin/security/audit/verify', {});
    check('une ligne modifiée est détectée', r.json.ok === false && r.json.brokenAt === 2, r.json);
    await raw.prepare('UPDATE audit_trail SET detail = ? WHERE id = 2').run(row.detail);
    const del = await raw.prepare('SELECT * FROM audit_trail WHERE id = 3').get();
    await raw.prepare('DELETE FROM audit_trail WHERE id = 3').run();
    r = await adm('POST', '/api/admin/security/audit/verify', {});
    check('une ligne supprimée est détectée', r.json.ok === false, r.json);
    await raw.prepare('INSERT INTO audit_trail (id, at, actor_type, actor_id, org_id, action, severity, target, ip, ua, request_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(del.id, del.at, del.actor_type, del.actor_id, del.org_id, del.action, del.severity, del.target, del.ip, del.ua, del.request_id, del.detail, del.prev_hash, del.hash);
    r = await adm('POST', '/api/admin/security/audit/verify', {});
    check('chaîne rétablie', r.json.ok === true, r.json);
    r = await anon('GET', '/api/admin/security/audit');
    check('journal sans connexion administrateur -> 401', r.status === 401, r.json);

    console.log('Double authentification (utilisateur)');
    const u = client(base);
    await u('POST', '/api/login', { contact: mail, pass: PASS });
    r = await u('POST', '/api/security/2fa/setup', { password: 'faux' });
    check('mot de passe exigé pour activer', r.status === 403, r.json);
    r = await u('POST', '/api/security/2fa/setup', { password: PASS });
    check('secret fourni', r.status === 200 && /^[A-Z2-7]{32}$/.test(r.json.secret) && /^otpauth:\/\/totp\//.test(r.json.uri), r.json);
    const secret = r.json.secret;
    r = await u('POST', '/api/security/2fa/enable', { code: '000000' });
    check('mauvais code refusé', r.status === 400, r.json);
    const s0 = totp.stepNow();
    r = await u('POST', '/api/security/2fa/enable', { code: totp.codeAt(secret, s0) });
    check('bon code : activée + 10 codes de secours', r.status === 200 && r.json.recoveryCodes.length === 10, r.json);
    const recovery = r.json.recoveryCodes;
    const dbRow = await raw.prepare('SELECT totp_secret, recovery_codes FROM users WHERE contact = ?').get(mail);
    check('secret chiffré et codes de secours hachés en base', dbRow.totp_secret.startsWith('v1:') && !dbRow.totp_secret.includes(secret) && !dbRow.recovery_codes.includes(recovery[0]), dbRow.totp_secret.slice(0, 8));
    const l = client(base);
    r = await l('POST', '/api/login', { contact: mail, pass: PASS });
    check('connexion : le mot de passe ne suffit plus', r.status === 200 && r.json.twofa === true && typeof r.json.ticket === 'string' && !l.jar.mia_token, r.json);
    const ticket = r.json.ticket;
    r = await l('GET', '/api/me');
    check('pas de session avant le code', r.status === 401, r.json);
    r = await l('POST', '/api/login/2fa', { ticket, code: '123456' });
    check('mauvais code -> 401', r.status === 401, r.json);
    r = await l('POST', '/api/login/2fa', { ticket: 'n-importe-quoi', code: totp.codeAt(secret, s0 + 1) });
    check('ticket invalide -> 401', r.status === 401, r.json);
    const good = totp.codeAt(secret, s0 + 1);
    r = await l('POST', '/api/login/2fa', { ticket, code: good });
    check('bon code -> connecté', r.status === 200 && r.json.user && !!l.jar.mia_token, r.json);
    const l2 = client(base);
    const t2 = (await l2('POST', '/api/login', { contact: mail, pass: PASS })).json.ticket;
    r = await l2('POST', '/api/login/2fa', { ticket: t2, code: good });
    check('un code déjà utilisé est refusé (anti-rejeu)', r.status === 401, r.json);
    r = await l2('POST', '/api/login/2fa', { ticket: t2, code: recovery[0] });
    check('code de secours accepté', r.status === 200, r.json);
    const l3 = client(base);
    const t3 = (await l3('POST', '/api/login', { contact: mail, pass: PASS })).json.ticket;
    r = await l3('POST', '/api/login/2fa', { ticket: t3, code: recovery[0] });
    check('un code de secours ne sert qu\'une fois', r.status === 401, r.json);
    r = await l('GET', '/api/security/overview');
    check('9 codes de secours restants', r.json.twofa.enabled === true && r.json.twofa.recoveryLeft === 9, r.json.twofa);
    r = await l('POST', '/api/security/2fa/disable', { password: PASS, code: recovery[1] });
    check('désactivation avec mot de passe + code', r.status === 200, r.json);
    r = await client(base)('POST', '/api/login', { contact: mail, pass: PASS });
    check('sans 2FA : connexion directe', r.status === 200 && r.json.user, r.json);

    console.log('Blocage automatique des adresses');
    const evil = client(base, { 'x-forwarded-for': '203.0.113.7' });
    let last;
    for (let i = 0; i < 12; i++) last = await evil('POST', '/api/login', { contact: `inconnu${i}${Date.now()}@exemple.com`, pass: 'mauvais' });
    r = await evil('GET', '/api/me');
    check('après des échecs répétés, l\'adresse est bloquée (403)', r.status === 403 && /bloqué/.test(r.json.error), { last: last.status, r: r.json });
    r = await evil('GET', '/api/health');
    check('/api/health reste joignable', r.status === 200, r.json);
    r = await anon('GET', '/api/health');
    check('une autre adresse n\'est pas touchée', r.status === 200, r.json);
    r = await adm('GET', '/api/admin/security/overview');
    check('l\'administration voit l\'adresse bloquée', r.json.blocks.some((x) => x.ip === '203.0.113.7' && x.createdBy === 'auto'), r.json.blocks);
    const ev = (await adm('GET', '/api/admin/security/audit?action=ip.block')).json.events;
    check('le blocage est au journal (gravité haute)', ev.length >= 1 && ev[0].severity === 'high', ev[0]);
    r = await adm('DELETE', '/api/admin/security/blocks/203.0.113.7');
    check('déblocage', r.status === 200, r.json);
    r = await evil('POST', '/api/login', { contact: 'x@exemple.com', pass: 'x' });
    check('adresse débloquée : réponse normale (401)', r.status === 401, r.json);
    r = await adm('POST', '/api/admin/security/blocks', { ip: '198.51.100.9', hours: 2, reason: 'test' });
    check('blocage manuel', r.status === 201, r.json);
    const man = client(base, { 'x-forwarded-for': '198.51.100.9' });
    r = await man('GET', '/api/me');
    check('adresse bloquée à la main -> 403', r.status === 403, r.json);
    await adm('DELETE', '/api/admin/security/blocks/198.51.100.9');
    const hits = await raw.prepare('SELECT COUNT(*) AS n FROM rate_hits').get();
    check('les limites de débit sensibles sont comptées dans la base', hits.n > 0, hits);

    console.log('Actions sensibles');
    const o = client(base);
    await o('POST', '/api/login', { contact: mail, pass: PASS });
    r = await o('POST', '/api/ws/orgs', { name: 'Boutique Audit', currency: 'FCFA' });
    check('organisation créée', r.status === 201 || r.status === 200, r.json);
    const org = r.json.id;
    r = await o('POST', `/api/ws/orgs/${org}/integrations/keys`, { name: 'test' });
    check('clé d\'API créée', r.status === 201 || r.status === 200, r.json);
    r = await o('PUT', `/api/ws/orgs/${org}`, { name: 'Boutique Audit 2' });
    r = await adm('GET', `/api/admin/security/audit?orgId=${org}&limit=20`);
    const oa = r.json.events.map((e) => e.action);
    check('création de clé d\'API au journal (gravité haute)', r.json.events.some((e) => e.action === 'apikey.create' && e.severity === 'high' && e.actorType === 'user'), oa);
    check('modification de l\'organisation au journal', oa.includes('org.update'), oa);
    r = await o('DELETE', `/api/ws/orgs/${org}`, { confirm: 'Boutique Audit 2' });
    r = await adm('GET', '/api/admin/security/audit?action=org.delete');
    check('suppression d\'organisation au journal (critique)', r.json.events.length === 1 && r.json.events[0].severity === 'critical', r.json.events);
    r = await adm('GET', '/api/admin/security/audit?action=admin.');
    check('les actions de l\'administrateur sont au journal', r.json.events.some((e) => e.action === 'admin.post' && /blocks/.test(e.target)), r.json.events.map((e) => e.action + ' ' + e.target));

    console.log('Administrateur : double authentification');
    r = await adm('POST', '/api/admin/security/2fa/setup', { password: 'faux' });
    check('mot de passe administrateur exigé', r.status === 403, r.json);
    r = await adm('POST', '/api/admin/security/2fa/setup', { password: 'mot-de-passe-admin-test' });
    const asecret = r.json.secret;
    check('secret administrateur fourni', /^[A-Z2-7]{32}$/.test(asecret), r.json);
    const a0 = totp.stepNow();
    r = await adm('POST', '/api/admin/security/2fa/enable', { code: totp.codeAt(asecret, a0) });
    check('2FA administrateur activée', r.status === 200 && r.json.recoveryCodes.length === 10, r.json);
    const arec = r.json.recoveryCodes;
    const adm2 = client(base);
    r = await adm2('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    check('sans code : refus avec demande de code', r.status === 401 && r.json.needCode === true, r.json);
    r = await adm2('GET', '/api/admin/stats');
    check('aucune session sans le code', r.status === 401, r.json);
    r = await adm2('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test', code: '111111' });
    check('mauvais code -> 401', r.status === 401 && !r.json.needCode, r.json);
    r = await adm2('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test', code: totp.codeAt(asecret, a0 + 1) });
    check('bon code -> connecté', r.status === 200, r.json);
    r = await adm2('GET', '/api/admin/security/overview');
    check('2 sessions administrateur, dont celle-ci', r.json.sessions.length >= 2 && r.json.sessions.some((s) => s.current), r.json.sessions);
    check('contrôle de configuration fourni', r.json.config.items.length > 5 && r.json.config.items.some((x) => x.id === 'jwt') && !/secret-de-test/.test(JSON.stringify(r.json.config)), r.json.config.summary);
    r = await adm2('POST', '/api/admin/security/sessions/revoke-others', {});
    check('fermer les autres sessions administrateur', r.status === 200 && r.json.closed >= 1, r.json);
    r = await adm('GET', '/api/admin/stats');
    check('l\'ancienne session administrateur est fermée', r.status === 401, r.json);
    const victim = client(base);
    await victim('POST', '/api/login', { contact: mail, pass: PASS });
    const uid = (await victim('GET', '/api/me')).json.user.id;
    r = await adm2('POST', `/api/admin/security/users/${uid}/revoke-sessions`, {});
    check('compte suspect : tous ses appareils sont déconnectés', r.status === 200 && r.json.closed >= 1, r.json);
    r = await victim('GET', '/api/me');
    check('… et plus rien ne passe pour lui', r.status === 401, r.json);
    r = await adm2('POST', '/api/admin/security/2fa/disable', { password: 'mot-de-passe-admin-test', code: arec[0] });
    check('désactivation (mot de passe + code de secours)', r.status === 200, r.json);
    r = await client(base)('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    check('puis connexion sans code', r.status === 200, r.json);
  } finally {
    child.kill();
    await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
