'use strict';
// Socle commun des tests de la vague 1 : serveur jetable (PostgreSQL embarqué, aucun appel externe), organisation de test avec propriétaire,
// responsable et simple membre. Usage : require('./lib/wave1').run('titre', async (t) => { ... }).
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { startTestPg } = require('./testdb');

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const raw = Buffer.isBuffer(body);
    const headers = body !== undefined ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const buf = Buffer.from(await res.arrayBuffer());
    const t = buf.toString('utf8');
    let json = null;
    try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t, buf, headers: res.headers };
  };
}

async function run(title, body, opts = {}) {
  let passed = 0; let failed = 0;
  const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const pgt = await startTestPg();
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'BREVO_API_KEY', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'ANTHROPIC_API_KEY'];
  const extra = opts.setup ? await opts.setup() : { env: {} };
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', TRUST_PROXY: '0', SIGNUP_VERIFY: 'off', API_PUBLIC_URL: base, ...(extra.env || {}) };
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }
  try {
    console.log(title);
    const stamp = Date.now();
    const owner = client(base); const mgr = client(base); const mem = client(base); const other = client(base);
    for (const [c, n] of [[owner, 'Awa'], [mgr, 'Marc'], [mem, 'Paul'], [other, 'Zoe']]) await c('POST', '/api/register', { name: n, contact: `${n.toLowerCase()}${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', currency: 'FCFA' });
    const org = r.json.id;
    r = await other('POST', '/api/ws/orgs', { name: 'Autre Société' });
    const org2 = r.json.id;
    const ws = (id) => `/api/ws/orgs/${id}`;
    for (const [c, role] of [[mgr, 'manager'], [mem, 'member']]) {
      r = await owner('POST', `${ws(org)}/invites`, { role });
      r = await c('POST', '/api/ws/orgs/join', { code: r.json.code });
    }
    const dbx = await pgt.open();
    await body({ check, owner, mgr, mem, other, org, org2, ws, O: ws(org), dbx, base, extra });
  } finally {
    if (process.env.SMOKE_LOG) console.log('--- journal du serveur ---\n' + out.split('\n').slice(-30).join('\n'));
    child.kill();
    if (opts.teardown) await opts.teardown(extra);
    await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
module.exports = { run, client };
