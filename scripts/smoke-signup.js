'use strict';
// Test de l'inscription avec code par e-mail (faux SMTP local, rien ne part vraiment). Lancez : npm run smoke:signup
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

let passed = 0; let failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  OK   ' + n); } else { failed++; console.log('  ECHEC ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); } };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeSmtp(port, box) {
  const srv = net.createServer((sock) => {
    let data = ''; let inData = false; let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1'); let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; box.push(data); data = ''; sock.write('250 OK\r\n'); } else data += line + '\n'; }
        else if (/^EHLO|^HELO/i.test(line)) sock.write('250-fake\r\n250 8BITMIME\r\n');
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}
const lastCode = (box) => { const m = box.length ? /rification : (\d{6})\n/.exec(box[box.length - 1]) : null; return m && m[1]; };

async function main() {
  const smtpPort = await freePort(); const box = []; const smtp = await fakeSmtp(smtpPort, box);
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const dbFile = path.join(os.tmpdir(), `manager-ia-su-${process.pid}.db`);
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'SIGNUP_VERIFY'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DB_PATH: dbFile, TRUST_PROXY: '0',
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_FROM: 'noreply@manager-ia.test' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch { /* vide */ } return { status: r.status, json: j, cookie: r.headers.getSetCookie().join(';') }; };
  try {
    const mail = `nouveau${Date.now()}@exemple.com`;
    let r = await call('GET', '/api/register/info');
    check('vérification active (SMTP configuré)', r.json && r.json.verify === true, r.json);
    r = await call('POST', '/api/register', { name: 'Tel', contact: '690000001', pass: 'secret123' });
    check('téléphone refusé : il faut un e-mail', r.status === 400 && /e-mail/.test(r.json.error), r.json);
    r = await call('POST', '/api/register', { name: 'Awa', contact: mail, pass: 'secret123' });
    check("inscription -> 202, pas de compte, pas de cookie", r.status === 202 && r.json.verify && r.json.expiresIn === 30 && !/mia_token/.test(r.cookie), r);
    check("l'adresse est masquée dans la réponse", r.json.contact && !r.json.contact.includes('nouveau'), r.json);
    check('un e-mail avec le code est parti', box.length === 1 && /30 secondes/.test(box[0]) && lastCode(box), box[0]);
    const code = lastCode(box);
    r = await call('POST', '/api/login', { contact: mail, pass: 'secret123' });
    check('connexion impossible avant vérification', r.status === 401, r);
    const wrong = code === '000000' ? '111111' : '000000';
    r = await call('POST', '/api/register/verify', { contact: mail, code: wrong });
    check('mauvais code -> 400', r.status === 400 && /incorrect/.test(r.json.error), r.json);
    r = await call('POST', '/api/register/verify', { contact: mail, code: '12ab' });
    check('format invalide -> 400', r.status === 400, r.json);
    r = await call('POST', '/api/register/resend', { contact: mail });
    check('renvoi trop tôt -> 429', r.status === 429, r.json);
    r = await call('POST', '/api/register/verify', { contact: mail, code });
    check('bon code -> 201 + cookie + utilisateur', r.status === 201 && /mia_token/.test(r.cookie) && r.json.user && r.json.user.name === 'Awa', r);
    const issuedToken = /mia_token=([^;]+)/.exec(r.cookie)[1];
    const claims = jwt.decode(issuedToken);
    const staleToken = jwt.sign({ sub: claims.sub, typ: 'user', pc: claims.pc, bioAt: Date.now() - 360000, actAt: Date.now() - 360000 }, 'secret-de-test-assez-long-123456', { algorithm: 'HS256', expiresIn: '1h' });
    const staleResponse = await fetch(base + '/api/me', { headers: { cookie: `mia_token=${staleToken}` } });
    check('session inactive depuis 5 minutes -> biométrie exigée', staleResponse.status === 428 && /vérifiez votre identité/i.test((await staleResponse.json()).error));
    const idlePing = await fetch(base + '/api/session/activity', { method: 'POST', headers: { cookie: `mia_token=${staleToken}`, 'content-type': 'application/json' }, body: '{}' });
    check('un ping d’activité ne déverrouille pas une ancienne session', idlePing.status === 428);
    r = await call('POST', '/api/register/verify', { contact: mail, code });
    check('le code ne sert qu\'une fois', r.status === 400, r.json);
    r = await call('POST', '/api/login', { contact: mail, pass: 'secret123' });
    check('connexion sans clé biométrique : code e-mail exigé', r.status === 200 && r.json.verify && r.json.loginVerify, r);
    check('code de connexion envoyé', box.some((message) => message.includes(`To: ${mail}`)) && lastCode(box), box[box.length - 1]);
    const loginCode = lastCode(box);
    const badLoginCode = loginCode === '999999' ? '000000' : '999999';
    r = await call('POST', '/api/login/verify-email', { contact: mail, code: badLoginCode });
    check('mauvais code de migration biométrique refusé', r.status === 400 && /incorrect/.test(r.json.error), r.json);
    r = await call('POST', '/api/login/verify-email', { contact: mail, code: loginCode });
    const passkeyChallenge = r.json && r.json.challengeId;
    check('bon code autorise uniquement l’enregistrement de la clé', r.status === 200 && r.json.webauthn === 'register' && r.json.options.challenge && r.json.options.authenticatorSelection.userVerification === 'required', r.json);
    r = await call('POST', '/api/webauthn/login/verify', { challengeId: passkeyChallenge, enroll: true, response: { id: 'cle-fausse' } });
    check('assertion WebAuthn inventée refusée', r.status === 400 && /vérification biométrique a échoué/i.test(r.json.error), r.json);
    r = await call('POST', '/api/register', { name: 'Awa', contact: mail, pass: 'secret123' });
    check('adresse déjà inscrite -> 409', r.status === 409, r.json);

    // Épuisement des essais
    const m2 = `essais${Date.now()}@exemple.com`;
    await call('POST', '/api/register', { name: 'Eve', contact: m2, pass: 'secret123' });
    const c2 = lastCode(box); const bad = c2 === '123456' ? '654321' : '123456';
    let last;
    for (let i = 0; i < 5; i++) last = await call('POST', '/api/register/verify', { contact: m2, code: bad });
    r = await call('POST', '/api/register/verify', { contact: m2, code: c2 });
    check('après 5 essais ratés, même le bon code est refusé -> 429', last.status === 400 && r.status === 429, r.json);

    // Expiration (30 secondes) + renvoi
    const m3 = `expire${Date.now()}@exemple.com`;
    await call('POST', '/api/register', { name: 'Max', contact: m3, pass: 'secret123' });
    const c3 = lastCode(box);
    await sleep(21000);
    r = await call('POST', '/api/register/resend', { contact: m3 });
    check('renvoi possible après 20 s', r.status === 200, r.json);
    const c3b = lastCode(box);
    check('le nouveau code est envoyé', box.length >= 4 && c3b, c3b);
    if (c3b !== c3) { r = await call('POST', '/api/register/verify', { contact: m3, code: c3 }); check('ancien code invalidé', r.status === 400, r.json); }
    await sleep(31000);
    r = await call('POST', '/api/register/verify', { contact: m3, code: c3b });
    check('code expiré après 30 secondes -> 400', r.status === 400 && /30 secondes/.test(r.json.error), r.json);
    r = await call('POST', '/api/login', { contact: m3, pass: 'secret123' });
    check("aucun compte créé avec un code expiré", r.status === 401, r);
  } finally {
    child.kill(); smtp.close();
    for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.unlinkSync(f); } catch { /* absent */ } }
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
