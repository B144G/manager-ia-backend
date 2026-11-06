'use strict';
// Vague 5 · Profil de l'entreprise : questions à boutons, score, types, droits, fonctions par offre. Aucun appel externe.
// (décor d'origine : passage de relais à un humain par WhatsApp : FAUX socket WhatsApp (mode QR, comme test-waqr), faux serveur d'IA et faux SMTP, aucun appel externe.
// Vérifie : relais déclenché, bon destinataire et ordre de priorité, message à soi-même, anti-doublon, repli e-mail (échec WhatsApp, WhatsApp non connecté,
// mode Meta avec le numéro connecté), anti-rafale (message groupé), heures calmes, numéro de client refusé, bouton de test, droits.
// Lancez-le avec : node scripts/test-wave4-relay.js
const http = require('http');
const { EventEmitter } = require('events');
const { startTestPg } = require('./lib/testdb');
const { fakeSmtp } = require('./lib/fakes');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };
const qp = (x) => Buffer.from(String(x).replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8').replace(/[  ]/g, ' ');

const ai = { next: null };
function fakeAi() {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(ai.next) }] })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}
function fakeLib() {
  const sockets = [];
  return {
    sockets,
    initAuthCreds: () => ({ noiseKey: { public: Buffer.from('pub'), private: Buffer.from('priv') }, registered: false, advSecretKey: 'adv' }),
    DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionReplaced: 440 },
    default(cfg) {
      const ev = new EventEmitter();
      const sock = { cfg, ev, user: null, sent: [], failFor: null, ended: false,
        presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {}, readMessages: async () => {},
        sendMessage: async (jid, content) => { if (sock.failFor && sock.failFor(jid)) throw new Error('connexion fermée par WhatsApp'); sock.sent.push({ jid, text: content.text }); return { key: { id: 'X' } }; },
        requestPairingCode: async () => 'ABCD-1234', logout: async () => {}, end: () => { sock.ended = true; } };
      sockets.push(sock);
      return sock;
    },
  };
}
function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t };
  };
}
async function main() {
  const a = await fakeAi(); const mails = []; const smtp = await fakeSmtp(mails);
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', WS_AI_FREE: '500', AI_PER_MINUTE: '500',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@exemple.test', MAIL_DAY_FREE: '500' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const P = require('../src/workspace/profile');
  const F = require('../src/workspace/features');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    const owner = client(base); const mem = client(base);
    await owner('POST', '/api/register', { name: 'Awa', contact: `awa${stamp}@exemple.com`, pass: 'secret123' });
    await mem('POST', '/api/register', { name: 'Paul', contact: `paul${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Awa', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`; const PR = `${O}/profile`;
    r = await owner('POST', `${O}/invites`, { role: 'member' }); await mem('POST', '/api/ws/orgs/join', { code: r.json.code });

    console.log('Départ');
    r = await owner('GET', PR);
    check('au départ : score 0, entretien à faire, première question = activité', r.json.score === 0 && r.json.onboarding === 'todo' && r.json.next.id === 'kind' && r.json.next.options.length === 5, r.json);
    r = await mem('GET', PR);
    check('un membre peut lire le profil', r.status === 200 && r.json.next.id === 'kind');
    r = await mem('POST', `${PR}/answer`, { id: 'kind', value: 'goods' });
    check('mais seul un responsable peut répondre (403)', r.status === 403);

    console.log('Réponses');
    r = await owner('POST', `${PR}/answer`, { id: 'kind', value: 'n-importe-quoi' });
    check('réponse hors des boutons refusée', r.status === 400);
    r = await owner('POST', `${PR}/answer`, { id: 'inconnue', value: 'x' });
    check('question inconnue refusée', r.status === 400);
    r = await owner('POST', `${PR}/answer`, { id: 'kind', value: 'school' });
    const o1 = await db.prepare('SELECT handoff_kind, sector FROM orgs WHERE id = ?').get(org);
    check('« école » : la passation devient « prospect » et le secteur est rempli', r.status === 200 && o1.handoff_kind === 'prospect' && /école|université/i.test(o1.sector), o1);
    check('la question suivante arrive automatiquement', r.json.next.id === 'sites', r.json.next);
    r = await owner('POST', `${PR}/answer`, { id: 'delivery', value: 'yes' });
    check('une question qui ne concerne pas le type est refusée (livraison pour une école)', r.status === 400, r.json);
    r = await owner('POST', `${PR}/answer`, { id: 'channels', value: ['whatsapp', 'inventé'] });
    check('réponse multiple : une valeur inconnue refuse tout', r.status === 400);
    await owner('POST', `${PR}/answer`, { id: 'sites', value: '2-5' });
    await owner('POST', `${PR}/answer`, { id: 'team', value: '11-50' });
    await owner('POST', `${PR}/answer`, { id: 'channels', value: ['whatsapp', 'shop'] });
    r = await owner('POST', `${PR}/answer`, { id: 'payment', value: ['momo', 'cash'] });
    check('les 5 questions de départ répondues : entretien terminé', r.json.onboarding === 'done' && r.json.answered === 5, r.json);
    check('puis on continue avec une question du « fil de l\'eau »', r.json.next && r.json.next.id === 'hours', r.json.next);

    console.log('Passer une question');
    r = await owner('POST', `${PR}/skip`, { id: 'hours' });
    check('question passée : elle ne revient pas', r.json.next && r.json.next.id !== 'hours' && r.json.skipped.some((x) => x.id === 'hours'), [r.json.next, r.json.skipped]);
    r = await owner('POST', `${PR}/answer`, { id: 'hours', value: 'mon-sat' });
    check('on peut y répondre plus tard', r.status === 200 && !r.json.skipped.some((x) => x.id === 'hours') && r.json.answers.some((x) => x.id === 'hours' && x.label === 'Du lundi au samedi'), r.json.skipped);

    console.log('Changer de type d\'entreprise');
    await owner('POST', `${PR}/answer`, { id: 'kind', value: 'goods' });
    r = await owner('POST', `${PR}/answer`, { id: 'delivery', value: 'both' });
    check('commerce : la question de livraison est maintenant permise', r.status === 200);
    r = await owner('POST', `${PR}/answer`, { id: 'kind', value: 'school' });
    check('retour à « école » : la réponse de livraison disparaît', !r.json.answers.some((x) => x.id === 'delivery'), r.json.answers);

    console.log('Ce que l\'IA voit');
    const full = await P.contextText(org);
    check('contexte IA : activité, canaux, paiement, jours', /Activité : Une école/.test(full) && /WhatsApp/.test(full) && /Mobile Money/.test(full) && /Du lundi au samedi/.test(full) && /ne le devine pas/.test(full), full);
    await owner('POST', `${PR}/answer`, { id: 'threshold', value: '200000' });
    const pub = await P.contextText(org, true);
    check('version pour un client : paiements et jours, jamais le seuil de validation', /Mobile Money/.test(pub) && /lundi au samedi/.test(pub) && !/200|seuil|Seuil/.test(pub), pub);
    r = await owner('GET', PR);
    check('score entre 0 et 100 et cohérent', r.json.score > 0 && r.json.score <= 100 && r.json.score === Math.round((r.json.answered / r.json.total) * 100), [r.json.score, r.json.answered, r.json.total]);

    console.log('Fonctions par offre');
    const gratuit = r.json.features;
    check('offre Gratuit : les relances automatiques ne sont pas incluses, mais rien n\'est bloqué (contrôle inactif)', gratuit.find((f) => f.key === 'followups').included === false && r.json.gating === false);
    check('chaque fonction indique ce qu\'il manque au profil', gratuit.find((f) => f.key === 'approvals').missing.length === 0 && gratuit.find((f) => f.key === 'reports').missing.length === 1, gratuit.map((f) => [f.key, f.missing.length]));
    const ownerId = (await db.prepare('SELECT owner_id FROM orgs WHERE id = ?').get(org)).owner_id;
    const fakeReq = { org: { id: org, owner_id: ownerId } };
    const run = (key) => new Promise((resolve) => F.need(key)(fakeReq, {}, (err) => resolve(err || null)));
    check('contrôle inactif : rien n\'est refusé', (await run('project_study')) === null);
    process.env.FEATURE_GATING = 'on';
    const err = await run('project_study');
    check('contrôle actif, offre Gratuit : étude de projet refusée (402)', err && err.status === 402 && /Méga Pro/.test(err.message), err && err.message);
    await db.prepare("UPDATE users SET plan = 'Méga Pro', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 86400000 * 20).toISOString(), ownerId);
    check('contrôle actif, offre Méga Pro : étude de projet permise, multisite refusé', (await run('project_study')) === null && (await run('multisite')) !== null);
    process.env.FEATURE_GATING = '';
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close(); a.srv.close();
  process.exit(failed ? 1 : 0);
}
main();
