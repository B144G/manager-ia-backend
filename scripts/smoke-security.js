'use strict';
// Test de la sécurité des comptes : mots de passe, verrouillage, changement de mot de passe, journal, en-têtes. Lancez : npm run smoke:security
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

let passed = 0; let failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  OK   ' + n); } else { failed++; console.log('  ECHEC ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    let json = null; const t = await res.text(); try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, headers: res.headers, text: t };
  };
}

async function main() {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const dbFile = path.join(os.tmpdir(), `manager-ia-sec-${process.pid}.db`);
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DB_PATH: dbFile, TRUST_PROXY: '0', SIGNUP_VERIFY: 'off', TEST_AUTH_BYPASS: '1', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }
  try {
    const a = client(base); const other = client(base); const anon = client(base); const adm = client(base);
    const mail = `sec${Date.now()}@exemple.com`;
    let r;
    console.log('Mots de passe');
    for (const [pw, label] of [['1234567', 'trop court (7)'], ['12345678', 'que des chiffres'], ['password', 'mot de passe courant'], ['aaaaaaaa', 'même caractère'], [mail.split('@')[0] + 'X1', "contient l'e-mail"]]) {
      r = await anon('POST', '/api/register', { name: 'Test Sec', contact: mail, pass: pw });
      check(`refusé : ${label}`, r.status === 400, r.json);
    }
    r = await a('POST', '/api/register', { name: 'Test Sec', contact: mail, pass: 'Cacao-Mangue-42' });
    check('mot de passe solide accepté', r.status === 201, r.json);
    await other('POST', '/api/login', { contact: mail, pass: 'Cacao-Mangue-42' });

    console.log('Changement de mot de passe');
    r = await a('POST', '/api/me/password', { current: 'faux', pass: 'Nouveau-Mot-77' });
    check('ancien mot de passe faux -> 403', r.status === 403, r.json);
    r = await a('POST', '/api/me/password', { current: 'Cacao-Mangue-42', pass: '12345678' });
    check('nouveau mot de passe faible -> 400', r.status === 400, r.json);
    r = await a('POST', '/api/me/password', { current: 'Cacao-Mangue-42', pass: 'Cacao-Mangue-42' });
    check("identique à l'ancien -> 400", r.status === 400, r.json);
    r = await a('POST', '/api/me/password', { current: 'Cacao-Mangue-42', pass: 'Nouveau-Mot-77' });
    check('changement -> 200', r.status === 200, r.json);
    r = await a('GET', '/api/me');
    check('cet appareil reste connecté', r.status === 200, r.json);
    r = await other('GET', '/api/me');
    check('les autres appareils sont déconnectés', r.status === 401, r.json);
    r = await anon('POST', '/api/login', { contact: mail, pass: 'Cacao-Mangue-42' });
    check('ancien mot de passe refusé', r.status === 401, r.json);

    console.log('Verrouillage après échecs');
    const lk = `verrou${Date.now()}@exemple.com`;
    await anon('POST', '/api/register', { name: 'Verrou Test', contact: lk, pass: 'Cacao-Mangue-42' });
    const v = client(base);
    let last;
    for (let i = 0; i < 8; i++) last = await v('POST', '/api/login', { contact: lk, pass: 'mauvais-' + i });
    check('8 échecs -> toujours 401', last.status === 401, last.json);
    r = await v('POST', '/api/login', { contact: lk, pass: 'Cacao-Mangue-42' });
    check('compte bloqué : même le bon mot de passe -> 429', r.status === 429 && /bloquée/.test(r.json.error), r.json);
    r = await v('POST', '/api/login', { contact: `inconnu${Date.now()}@exemple.com`, pass: 'x' });
    check('un compte inexistant répond comme avant (401)', r.status === 401, r.json);

    console.log('Administration');
    for (let i = 0; i < 8; i++) last = await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'faux' + i });
    check('échecs admin -> 401', last.status === 401, last.json);
    r = await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    check('admin bloqué après 8 échecs -> 429', r.status === 429, r.json);
    check('en-têtes : Permissions-Policy et nosniff', !!r.headers.get('permissions-policy') && r.headers.get('x-content-type-options') === 'nosniff', [...r.headers.keys()]);
    r = await anon('GET', '/');
    const csp = r.headers.get('content-security-policy') || '';
    check('CSP sur les pages du site (scripts du site seulement)', /script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);
    r = await anon('GET', '/api/admin/security-log');
    check('journal de sécurité sans connexion admin -> 401', r.status === 401, r.json);
  } finally {
    child.kill();
    for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.unlinkSync(f); } catch { /* absent */ } }
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
