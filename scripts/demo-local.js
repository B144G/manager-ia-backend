'use strict';
// Entreprise de test complète, en local : démarre le serveur avec une base temporaire, crée les comptes d'essai et remplit toutes les sous-applications.
// Lancez-le avec : node scripts/demo-local.js   (puis, dans le dossier du site : npm run dev, et ouvrez http://localhost:5173)
// Ne touche à aucun serveur distant. La base disparaît à l'arrêt (Ctrl+C). L'IA ne répond que si ANTHROPIC_API_KEY est défini avant de lancer.
const { startTestPg } = require('./lib/testdb');
const { seed } = require('./lib/demo-seed');

const PASS = 'Essai-2026-brij';
const PEOPLE = [
  { name: 'M. Nkoulou (propriétaire)', contact: 'proprietaire@exemple.com', role: 'owner' },
  { name: 'Awa Tchamba', contact: 'awa@exemple.com', role: 'manager', job: 'Comptable' },
  { name: 'Zoé Manga', contact: 'zoe@exemple.com', role: 'admin', job: 'Commerciale' },
  { name: 'Paul Essomba', contact: 'paul@exemple.com', role: 'member', job: "Chef d'atelier" },
  { name: 'Éric Ndongo', contact: 'eric@exemple.com', role: 'member', job: 'Menuisier' },
];

async function main() {
  const pgt = await startTestPg();
  // DEMO_CAMPAY=1 : démarre aussi le FAUX serveur Campay (scripts/mock-campay.js) et branche le paiement automatique dessus (mode test, aucun argent réel).
  let mock = null;
  if (process.env.DEMO_CAMPAY) {
    mock = await require('./mock-campay').start({ confirmMs: Number(process.env.MOCK_CONFIRM_MS) || 8000 });
    Object.assign(process.env, { CAMPAY_MODE: 'test', CAMPAY_BASE_URL: mock.url, CAMPAY_APP_USERNAME: mock.creds.username, CAMPAY_APP_PASSWORD: mock.creds.password, CAMPAY_WEBHOOK_KEY: mock.creds.webhookKey, PAYMENTS_INIT_RATE: '500' });
  }
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY', 'SMTP_HOST']) process.env[k] = process.env[k] || '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-demo-assez-long-123456', DATABASE_URL: pgt.url, SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin-demo', ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'mot-de-passe-admin-demo', WS_AI_FREE: '500', AI_PER_MINUTE: '500' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const port = Number(process.env.PORT) || 3000;
  await new Promise((resolve, reject) => { const s = app.listen(port, '127.0.0.1', resolve); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  if (mock) mock.setWebhookUrl(`${base}/api/payments/webhook/campay`);
  const client = () => {
    const jar = {};
    const call = async (method, url, body) => {
      const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
      return { status: res.status, json, text };
    };
    call.cookie = async () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    return call;
  };
  const clients = {};
  for (const p of PEOPLE) {
    const c = client(); clients[p.contact] = c;
    const r = await c('POST', '/api/register', { name: p.name, contact: p.contact, pass: PASS });
    if (r.status >= 300) throw new Error(`Inscription de ${p.name} : ${r.status} ${r.text}`);
    p.userId = Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(p.contact)).id);
  }
  const owner = PEOPLE[0];
  await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 86400000 * 365).toISOString(), owner.userId);
  console.log("Remplissage de l'entreprise de test…");
  const ownerCall = (method, path, body) => clients[owner.contact](method, '/api/ws' + path, body);
  const team = PEOPLE.slice(1).map((p) => ({ name: p.name.split(' ')[0], role: p.role, job: p.job, userId: p.userId, call: (method, path, body) => clients[p.contact](method, '/api/ws' + path, body) }));
  const report = await seed(ownerCall, { team });
  try { // histoire de l'entreprise : données d'essai (module scripts/lib/demo-history.js)
    const cookie = await clients[owner.contact].cookie();
    await require('./lib/demo-history').seedHistory({ base, cookie, orgId: report.org });
  } catch (e) { report.failed.push('Histoire de l\'entreprise : ' + e.message); }
  if (report.org) { const { seedTalents } = require('./lib/demo-seed-talents'); const rt = await seedTalents(ownerCall, report.org, team); report.failed.push(...rt.failed); }
  console.log('\n==============================================================');
  console.log('ENTREPRISE DE TEST PRÊTE : « Atelier Nkoulou (TEST) »');
  console.log('Serveur local : ' + base + '   (ouvrez le site avec « npm run dev » : http://localhost:5173)');
  console.log('Mot de passe de tous les comptes d\'essai : ' + PASS);
  for (const p of PEOPLE) console.log(`  ${p.role.padEnd(8)} ${p.contact.padEnd(28)} ${p.name}`);
  console.log(`Administration de la plateforme : ${base}/admin  (${process.env.ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD})`);
  if (mock) {
    const c = client(); const email = 'client.paiement@exemple.com';
    await c('POST', '/api/register', { name: 'Client Paiement (sans abonnement)', contact: email, pass: PASS });
    console.log(`PAIEMENT CAMPAY (FAUX serveur, MODE TEST) : connectez-vous avec ${email} puis « Abonnement ». Numéros : 677777777 (MTN réussit) · 677777770 (MTN échoue) · 699999999 (Orange réussit) · 699999990 (Orange échoue) · tout autre 6XXXXXXXX reste en attente (expire).`);
    console.log(`Confirmation simulée après ${Number(process.env.MOCK_CONFIRM_MS) || 8000} ms. Forcer un résultat : curl -X POST ${mock.origin}/__mock/resolve -d '{"reference":"<réf. Campay>","status":"SUCCESSFUL"}'`);
  }
  if (report.failed.length) { console.log('\nSections en échec :'); for (const f of report.failed) console.log('  - ' + f); }
  console.log('Laissez cette fenêtre ouverte. Ctrl+C pour arrêter (les données disparaissent).');
  console.log('==============================================================');
}
main().catch((e) => { console.error(e); process.exit(1); });
