'use strict';
// Démonstration · organisations : après seed.js, ajoute deux organisations liées (dont une dirigée par une autre personne) et une organisation où la personne n'est que membre.
//   Usage : DEMO_DIR=... node scripts/demo/organisations-seed.js [http://127.0.0.1:3611]
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://127.0.0.1:3611';
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo';
function client() {
  const jar = {};
  return async (method, url, body) => {
    const headers = {}; if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* */ }
    return { status: res.status, json };
  };
}
(async () => {
  const { Client } = require('pg');
  const pg = new Client({ connectionString: fs.readFileSync(path.join(DEMO_DIR, 'pgurl.txt'), 'utf8').trim() }); await pg.connect();
  const demo = client(); const kofi = client(); const lea = client();
  await demo('POST', '/api/login', { contact: 'demo@exemple.com', pass: 'secret123' });
  await kofi('POST', '/api/register', { name: 'Kofi Mbarga', contact: 'kofi@exemple.com', pass: 'secret123' });
  await lea('POST', '/api/register', { name: 'Léa Tchouaffé', contact: 'lea@exemple.com', pass: 'secret123' });
  const exp = new Date(Date.now() + 86400000 * 60).toISOString();
  await pg.query("UPDATE users SET plan = 'Illimité', plan_expires = $1 WHERE contact IN ('demo@exemple.com', 'kofi@exemple.com')", [exp]);
  const orgs = (await demo('GET', '/api/ws/orgs')).json.orgs; const main = orgs[0].id;
  let r = await demo('POST', `/api/ws/orgs/${main}/entreprise/links`, { label: 'Site de Douala' });
  r = await kofi('POST', '/api/ws/orgs', { name: 'Boutique Awa · Douala', sector: 'Commerce de détail', associationCode: r.json.code });
  const douala = r.json.id;
  r = await demo('POST', `/api/ws/orgs/${main}/entreprise/links`, { label: 'Atelier' });
  r = await demo('POST', '/api/ws/orgs', { name: 'Atelier Awa', sector: 'Couture et confection', associationCode: r.json.code });
  const inv = await kofi('POST', `/api/ws/orgs/${douala}/invites`, { role: 'member' });
  await lea('POST', '/api/ws/orgs/join', { code: inv.json.code });
  const inv2 = await demo('POST', `/api/ws/orgs/${main}/invites`, { role: 'member' });
  const inv3 = await demo('POST', `/api/ws/orgs/${main}/invites`, { role: 'manager' });
  void inv2; void inv3;
  // Une organisation d'ailleurs, dont la personne n'est que membre
  r = await lea('POST', '/api/ws/orgs', { name: 'Librairie du Centre', sector: 'Commerce de détail' });
  const lib = r.json.id; const code = (await lea('POST', `/api/ws/orgs/${lib}/invites`, { role: 'member' })).json.code;
  await demo('POST', '/api/ws/orgs/join', { code });
  console.log('Organisations de démonstration prêtes.', (await demo('GET', '/api/ws/organisations')).status);
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
