'use strict';
// Serveur de démonstration pour la portée des réponses automatiques WhatsApp : une entreprise avec des conversations déjà classées
// (publicité, organique, client existant, exceptions) et un historique de changements. Base temporaire, aucun appel réseau.
// Usage : PORT=3000 node scripts/demo-wa-portee.js   (puis, dans le dossier du site : npm run dev)
const { startTestPg } = require('./lib/testdb');
const PASS = 'Essai-2026-brij';

async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'META_EMBEDDED_CONFIG_ID', 'ADMIN_PASSWORD', 'ADMIN_USERNAME']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-demo-assez-long-123456', DATABASE_URL: pgt.url, SIGNUP_VERIFY: 'off', TRUST_PROXY: '0' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const port = Number(process.env.PORT) || 3000;
  await new Promise((resolve, reject) => { const s = app.listen(port, '127.0.0.1', resolve); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  const jar = {};
  const call = async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* */ }
    return { status: res.status, json };
  };
  await call('POST', '/api/register', { name: 'M. Nkoulou (propriétaire)', contact: 'proprietaire@exemple.com', pass: PASS });
  const u = await db.prepare("SELECT id FROM users WHERE contact = 'proprietaire@exemple.com'").get();
  await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 86400000 * 365).toISOString(), u.id);
  const org = (await call('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou (TEST)' })).json.id;
  const O = `/api/ws/orgs/${org}`;
  await call('POST', `${O}/sales/catalog`, { name: 'Robe wax', price: 10000, floorPrice: 6000 });
  await call('PUT', `${O}/sales/settings`, { chatEnabled: true });
  const now = new Date(); const iso = (min) => new Date(now.getTime() - min * 60000).toISOString();
  const chat = async (num, name, msgs, minAgo, extra = {}) => {
    const id = Number((await db.prepare("INSERT INTO chats (org_id, session, channel, contact, campaign, created_at, updated_at) VALUES (?, ?, 'whatsapp', ?, ?, ?, ?)").run(org, `wa-${org}-${num}`, num, extra.campaign || '', iso(minAgo + 5), iso(minAgo))).lastInsertRowid);
    if (name) { const cid = Number((await db.prepare('INSERT INTO customers (org_id, name, phone, stage, created_at) VALUES (?, ?, ?, ?, ?)').run(org, name, num, extra.stage || 'prospect', iso(900))).lastInsertRowid); await db.prepare('UPDATE chats SET customer_id = ? WHERE id = ?').run(cid, id); }
    let k = 0; for (const [role, text] of msgs) await db.prepare('INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(id, role, text, iso(minAgo + 5 - (k++)));
    return id;
  };
  await chat('237677100001', 'Marie Fotso', [['user', 'Bonjour, je vois votre pub pour les robes wax'], ['assistant', 'Bonjour Marie ! Oui, la robe wax est à 10 000 FCFA.']], 30);
  await chat('237677100002', null, [['user', 'Bonsoir, vous livrez à Douala ?']], 12);
  await chat('237677100003', 'Cédric Ewane', [['user', 'Je voudrais repasser commande']], 6, { stage: 'client' });
  await chat('237677100004', null, [['user', 'PROMO-RENTREE : quel est le prix ?'], ['assistant', 'Bonjour ! La robe wax coûte 10 000 FCFA.']], 3, { campaign: 'rentree25' });
  await db.prepare('UPDATE chats SET lead = ? WHERE org_id = ?').run('{}', org);
  // origines + journal, via les routes (le journal se remplit comme en vrai)
  await call('PUT', `${O}/wa-scope`, { mode: 'all', keywords: ['PROMO-RENTREE', 'Soldes été'] });
  const scope = require('../src/workspace/wa-scope');
  const orgRow = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(org);
  for (const c of await db.prepare("SELECT * FROM chats WHERE org_id = ? ORDER BY id").all(org)) await scope.observe(orgRow, c, { text: (await db.prepare("SELECT content FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY id LIMIT 1").get(c.id)).content, campaign: c.campaign, ad: c.contact.endsWith('1') ? { via: 'referral', adId: 'AD-120938', detail: 'Robes wax -20 %' } : null });
  await call('POST', `${O}/wa-scope/exceptions`, { phone: '237677100003', kind: 'always', label: 'Cédric (client fidèle)' });
  await call('POST', `${O}/wa-scope/exceptions`, { phone: '237699555000', kind: 'never', label: 'Fournisseur de tissus' });
  await call('PUT', `${O}/wa-scope`, { mode: 'ads' });
  console.log(`DEMO PRÊTE : ${base} — proprietaire@exemple.com / ${PASS} — entreprise n° ${org}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
