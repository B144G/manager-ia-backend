'use strict';
// Démonstration des espaces de direction : entreprise BTP de test avec un directeur commercial, son équipe, et des données (affaires, fiches QHSE).
// Lancez-le avec : PORT=3420 node scripts/demo-direction.js  (puis, côté site : DEV_API_TARGET=http://localhost:3420 npx vite --port 5420)
// Base temporaire, aucun serveur distant. Mot de passe de tous les comptes : voir PASS ci-dessous.
const { startTestPg } = require('./lib/testdb');
const { seed } = require('./lib/demo-seed');
const PASS = 'Essai-2026-brij';
const PEOPLE = [
  ['proprietaire@exemple.com', 'M. Nkoulou (propriétaire)', null],
  ['dcom@exemple.com', 'Sylvie Directrice Commerciale', 'Directeur commercial'],
  ['vendeur@exemple.com', 'Marc Vendeur', 'Commercial / vendeur'],
  ['respco@exemple.com', 'Rose Responsable Commerciale', 'Responsable commercial'],
  ['assist@exemple.com', 'Alice Assistante Commerciale', 'Assistant(e) commercial(e)'],
  ['mkt@exemple.com', 'Maëlle Marketeuse', 'Community manager'],
  ['cpt@exemple.com', 'Ada Comptable', 'Comptable'],
];
async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'BREVO_API_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-demo-assez-long-123456', DATABASE_URL: pgt.url, SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-demo', ADMIN_PASSWORD: 'mot-de-passe-admin-demo', WS_AI_FREE: '500', AI_PER_MINUTE: '500' });
  const { app } = require('../src/server'); const { db } = require('../src/db'); await db.ready;
  const port = Number(process.env.PORT) || 3420;
  await new Promise((resolve, reject) => { const s = app.listen(port, '127.0.0.1', resolve); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  const client = () => { const jar = {}; return async (method, url, body) => { const headers = body !== undefined ? { 'content-type': 'application/json' } : {}; const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); if (cookie) headers.cookie = cookie; const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); } const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* texte */ } return { status: res.status, json, text }; }; };
  const cl = {};
  for (const [c, n] of PEOPLE) { cl[c] = client(); await db.prepare('DELETE FROM rate_hits').run(); await cl[c]('POST', '/api/register', { name: n, contact: c, pass: PASS }); }
  await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ?").run(new Date(Date.now() + 86400000 * 365).toISOString());
  const O = cl[PEOPLE[0][0]];
  const rep = await seed((m, p, b) => O(m, '/api/ws' + p, b), { team: [] });
  const org = rep.org; const E = `/api/ws/orgs/${org}/entreprise`; const W = `/api/ws/orgs/${org}`;
  await O('POST', `${E}/template`, { sector: 'commerce' });
  const ch = (await O('GET', `${E}/chart`)).json;
  const posts = [...ch.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...ch.departments.flatMap((x) => x.posts)];
  for (const [c, n, title] of PEOPLE.slice(1)) {
    const p = posts.find((x) => x.title === title);
    const r0 = await O('POST', `${E}/people`, { fullName: n, email: c, postIds: p ? [p.id] : [] });
    await cl[c]('POST', '/api/ws/orgs/join', { code: r0.json.code });
  }
  await O('POST', `${E}/direction/enable`, {}); // entreprise déjà utilisée : le propriétaire active les espaces de direction
  await O('POST', `${E}/workflows/install`, {});
  await O('POST', `${E}/extras/enable`, {});
  const rc = cl['respco@exemple.com']; const vd = cl['vendeur@exemple.com'];
  for (const [n, cli, amt, bud] of [['École de Bafoussam', 'Mairie de Bafoussam', 45000000, 36000000], ['Entrepôt de Douala', 'Société Logipôle', 120000000, 99000000], ['Villa Bonanjo', 'M. Etoundi', 28000000, 24000000]]) { const r = await vd('POST', `${W}/affaires`, { name: n, client: cli, amount: amt, budget: bud }); if (r.json && r.json.id && n !== 'Villa Bonanjo') await rc('POST', `${W}/affaires/${r.json.id}/stage`, { stage: 'negociation' }); }
  console.log(`\nDEMO DIRECTION PRÊTE : ${base}   org=${org}\nMot de passe : ${PASS}`);
  for (const [c, n, t] of PEOPLE) console.log(`  ${c.padEnd(26)} ${n}${t ? ' — ' + t : ''}`);
  console.log('Ctrl+C pour arrêter.');
}
main().catch((e) => { console.error(e); process.exit(1); });
