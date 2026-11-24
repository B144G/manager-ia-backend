'use strict';
// Serveur de démonstration du chat interne : une entreprise de 5 personnes avec conversations, groupe, fichiers, sondage, positions.
// Base temporaire, aucun appel réseau. Usage : PORT=3410 node scripts/demo-chat.js   (puis, dans le dossier du site : DEV_API_TARGET=http://127.0.0.1:3410 npx vite --port 5410)
const { startTestPg } = require('./lib/testdb');
const { client } = require('./lib/wave1');
const PASS = 'Essai-2026-chat';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'META_EMBEDDED_CONFIG_ID', 'ADMIN_PASSWORD', 'ADMIN_USERNAME', 'ANTHROPIC_API_KEY']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-demo-assez-long-123456', DATABASE_URL: pgt.url, SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', RATE_LIMIT_GLOBAL: '100000' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const port = Number(process.env.PORT) || 3410;
  await new Promise((resolve, reject) => { const s = app.listen(port, '127.0.0.1', resolve); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  const names = [['Awa Nkoulou', 'awa@exemple.com', 'owner'], ['Marc Tchoumi', 'marc@exemple.com', 'manager'], ['Paul Essomba', 'paul@exemple.com', 'member'], ['Esther Mbarga', 'esther@exemple.com', 'member'], ['Jean Fotso', 'jean@exemple.com', 'member']];
  const cs = {};
  for (const [n, c] of names) { cs[n] = client(base); await cs[n]('POST', '/api/register', { name: n, contact: c, pass: PASS }); }
  const owner = cs['Awa Nkoulou'];
  const u = await db.prepare("SELECT id FROM users WHERE contact = 'awa@exemple.com'").get();
  await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 86400000 * 365).toISOString(), u.id);
  const org = (await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou (démo)' })).json.id;
  const O = `/api/ws/orgs/${org}`; const C = `${O}/chat`;
  const ids = {};
  for (const [n, , role] of names) {
    if (role !== 'owner') { const inv = await owner('POST', `${O}/invites`, { role }); await cs[n]('POST', '/api/ws/orgs/join', { code: inv.json.code }); }
    ids[n] = (await db.prepare('SELECT id FROM users WHERE name = ? ORDER BY id DESC LIMIT 1').get(n)).id;
  }
  const [A, M, P, E, J] = names.map(([n]) => cs[n]); const id = (n) => Number(ids[n]);
  const direct = async (c, other) => (await c('POST', `${C}/conversations/direct`, { userId: id(other) })).json.conversation.id;
  const say = (c, conv, body, o = {}) => c('POST', `${C}/conversations/${conv}/messages`, { body, ...o });
  const D1 = await direct(M, 'Awa Nkoulou');
  await say(M, D1, 'Bonjour Awa, le devis du client Mbida est prêt. Tu peux le valider avant midi ?');
  await say(A, D1, 'Merci Marc. Je regarde ça tout de suite.');
  await say(M, D1, 'Il faut aussi relancer la facture de la boutique de Douala. @Awa Nkoulou', { urgent: true });
  const D2 = await direct(P, 'Awa Nkoulou');
  await say(P, D2, 'La livraison de tissus wax arrive demain matin.');
  await say(P, D2, 'Je prépare la place dans l’entrepôt 👍');
  const D3 = await direct(E, 'Awa Nkoulou');
  await say(E, D3, 'Réunion de 15 h : tu peux envoyer le compte rendu ?');
  const G = (await A('POST', `${C}/groups`, { name: 'Équipe Comptabilité', purpose: 'department', department: 'Comptabilité', memberIds: [id('Marc Tchoumi'), id('Paul Essomba'), id('Esther Mbarga')] })).json.conversation.id;
  await say(A, G, 'Bonjour à toutes et à tous. Clôture mensuelle vendredi : merci de tout saisir avant jeudi soir.');
  await say(M, G, 'Bien reçu. @tous n’oubliez pas les justificatifs de caisse.');
  await say(E, G, 'Je m’en occupe ce matin. Voici le relevé 📎');
  await A('POST', `${C}/files?conv=${G}&name=releve-caisse.png`, PNG);
  await A('POST', `${C}/conversations/${G}/polls`, { question: 'Quel jour pour la réunion de clôture ?', options: ['Jeudi 16 h', 'Vendredi 9 h', 'Vendredi 14 h'] });
  const G2 = (await A('POST', `${C}/groups`, { name: 'Projet Chantier A', purpose: 'general', memberIds: [id('Jean Fotso'), id('Paul Essomba')] })).json.conversation.id;
  await say(J, G2, 'Les photos du chantier sont sur le drive. On avance bien.');
  for (const [c, conv] of [[M, D1], [P, D2], [E, D3]]) void c, void conv;
  // positions en direct (activées par les personnes elles-mêmes)
  for (const [c, lat, lng, n] of [[A, 4.0511, 9.7679, 'Awa'], [M, 4.0611, 9.7279, 'Marc'], [P, 4.0311, 9.7079, 'Paul']]) { await c('PUT', `${C}/geo/me`, { enabled: true, consent: true }); await c('POST', `${C}/geo/position`, { lat, lng, accuracy: 25 }); void n; }
  await A('GET', `${C}/conversations`);
  console.log(`Démo du chat prête sur ${base} — connexion : awa@exemple.com / ${PASS}  (autres : marc@, paul@, esther@, jean@exemple.com, même mot de passe)`);
  // les personnes restent « en ligne » (elles ouvrent leur chat) tant que le serveur tourne
  setInterval(() => { for (const c of [M, P]) c('GET', `${C}/unread`).catch(() => {}); }, 20000);
}
main().catch((e) => { console.error(e); process.exit(1); });
