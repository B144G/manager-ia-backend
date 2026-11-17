'use strict';
// Démonstration Brij-IA — socle commun : connexion au serveur (local jetable ou en ligne), comptes de l'équipe, journal des fonctions utilisées.
// Chaque fichier de groupe exporte `async (ctx) => {}` et appelle ctx.do(...) pour chaque fonction du site qu'il utilise.
const { spawn } = require('child_process');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  const jar = {};
  const call = async (method, url, body) => {
    const raw = Buffer.isBuffer(body);
    const headers = body !== undefined ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    let res;
    for (let i = 0; ; i++) {
      try { res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) }); } catch (e) { if (i < 3) { await sleep(1500); continue; } throw e; }
      if (res.status === 429 && i < 4) { await sleep(Number(res.headers.get('retry-after') || 0) * 1000 || 15000); continue; }
      break;
    }
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* non JSON (PDF, CSV…) */ }
    return { status: res.status, json, text, buf, headers: res.headers };
  };
  return call;
}

/** Serveur local jetable (PostgreSQL embarqué), pour essayer la démonstration sans toucher à la production. */
async function startLocal(port) {
  const { startTestPg, freePort } = require('../lib/testdb');
  port = port || await freePort();
  const pg = await startTestPg();
  const base = `http://127.0.0.1:${port}`;
  const blank = ['SMTP_HOST', 'BREVO_API_KEY', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'ANTHROPIC_API_KEY'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-demo-assez-long-123456', DATABASE_URL: pg.url, ADMIN_USERNAME: 'admin-demo', ADMIN_PASSWORD: 'mot-de-passe-demo', TRUST_PROXY: '0', SIGNUP_VERIFY: 'off', RATE_LIMIT_GLOBAL: '100000', API_PUBLIC_URL: base, ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:5173' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) throw new Error("Le serveur local n'a pas démarré.\n" + out);
  return { base, pg, log: () => out, stop: async () => { child.kill(); await pg.stop(); } };
}

function makeCtx({ base, verbose }) {
  const results = [];
  const ids = {};
  const users = {};
  const ctx = {
    base, ids, users, results,
    org: null, O: null,
    /** Appelle l'API au nom d'une personne de l'équipe (owner, manager, member, driver, storekeeper…) ; repli sur le dirigeant si elle n'a pas de compte. */
    as(role) { return users[role] || users.owner; },
    /**
     * Utilise une fonction du site. `feature` = libellé lisible (« Stock : créer un article »).
     * opts.as : rôle ; opts.expect : statut(s) HTTP attendus (par défaut 2xx) ; opts.raw : renvoie la réponse complète.
     */
    async do(feature, method, url, body, opts = {}) {
      const call = ctx.as(opts.as || 'owner');
      const full = url.startsWith('/api/') ? url : `${ctx.O}${url}`;
      let r;
      try { r = await call(method, full, body); } catch (e) { r = { status: 0, json: { error: String(e.message || e) } }; }
      const exp = opts.expect ? [].concat(opts.expect) : null;
      const ok = exp ? exp.includes(r.status) : r.status >= 200 && r.status < 300;
      results.push({ group: ctx.group, feature, ok, status: r.status, method, url: full, error: ok ? undefined : (r.json && r.json.error) || r.text && r.text.slice(0, 200) });
      if (verbose || !ok) console.log(`  ${ok ? 'OK  ' : 'ECHEC'} ${feature}${ok ? '' : `  [${method} ${full} -> ${r.status}] ${JSON.stringify((r.json && r.json.error) || (r.text || '').slice(0, 160))}`}`);
      return opts.raw ? r : (r.json || {});
    },
    /** Vérification sans appel (cohérence d'un résultat). */
    check(feature, cond, detail) {
      results.push({ group: ctx.group, feature, ok: !!cond, error: cond ? undefined : JSON.stringify(detail) });
      if (verbose || !cond) console.log(`  ${cond ? 'OK  ' : 'ECHEC'} ${feature}${cond ? '' : '  ' + JSON.stringify(detail).slice(0, 300)}`);
      return !!cond;
    },
    /** Date ISO (AAAA-MM-JJ) décalée de n jours par rapport à aujourd'hui. */
    day(n = 0) { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); },
    month(n = 0) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); },
  };
  return ctx;
}

module.exports = { client, startLocal, makeCtx, sleep };
