'use strict';
// Prospection avec consentement : formulaire, relances par e-mail (J+1, J+3, J+7), désinscription, suivi par l'administrateur, visites anonymes. Faux service d'e-mail local : aucun appel externe.
// Lancez-le avec : node scripts/test-prospects.js
const http = require('http');
const { startTestPg, freePort } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

function client(base) {
  const jar = {};
  return async (method, url, body, headers0) => {
    const headers = Object.assign(body !== undefined ? { 'content-type': 'application/json' } : {}, headers0 || {});
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t };
  };
}

async function main() {
  const pgt = await startTestPg();
  const mailPort = await freePort(); const sent = [];
  const mailSrv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { sent.push(JSON.parse(b || '{}')); res.statusCode = 201; res.end('{"messageId":"x"}'); }); });
  await new Promise((ok) => mailSrv.listen(mailPort, '127.0.0.1', ok));
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: `http://127.0.0.1:${mailPort}/v3`, SMTP_FROM: 'Brij-IA <contact@exemple.com>', SITE_URL: 'https://brij-ia.exemple.com' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const P = require('../src/services/prospects');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const web = client(base);
  const fu = () => sent.filter((m) => /Pour ne plus recevoir/.test(m.textContent || '')); // relances aux prospects (les e-mails à l'administrateur passent par le même faux service)
  try {
    console.log('Formulaire avec consentement');
    check('découpage du contact : e-mail', JSON.stringify(P.splitContact('Awa@Exemple.com')) === '{"email":"awa@exemple.com","phone":""}');
    check('découpage du contact : téléphone', P.splitContact('+237 653 62 13 88').phone === '+237653621388' && P.splitContact('+237 653 62 13 88').email === '');
    let r = await web('POST', '/api/contact', { name: 'Awa Tchamba', what: 'Essai gratuit', message: 'Je veux essayer.', contact: 'awa@exemple.com', consent: true, source: 'Facebook' });
    check('demande enregistrée', r.status === 200 && r.json.ok);
    let l = await db.prepare("SELECT * FROM leads WHERE name = 'Awa Tchamba'").get();
    check('e-mail, source et consentement enregistrés', l && l.email === 'awa@exemple.com' && l.source === 'facebook' && Number(l.consent) === 1);
    check('première relance programmée à J+1 avec un lien de désinscription', l && l.next_follow_at && Math.abs(new Date(l.next_follow_at) - Date.now() - 86400000) < 60000 && /^[a-f0-9]{32}$/.test(l.unsub_token), l && l.next_follow_at);
    r = await web('POST', '/api/contact', { name: 'Paul Sans Case', message: 'Rappelez-moi.', contact: 'paul@exemple.com' });
    const noC = await db.prepare("SELECT * FROM leads WHERE name = 'Paul Sans Case'").get();
    check('sans case cochée : demande gardée mais aucune relance programmée', noC && Number(noC.consent) === 0 && noC.next_follow_at === null);
    r = await web('POST', '/api/contact', { name: 'Zoé Téléphone', message: 'Appelez-moi.', contact: '653621388', consent: true });
    const ph = await db.prepare("SELECT * FROM leads WHERE name = 'Zoé Téléphone'").get();
    check('un numéro de téléphone est gardé, sans relance par e-mail', ph && ph.phone === '653621388' && ph.next_follow_at === null);
    r = await web('POST', '/api/contact', { name: 'Robot', message: 'spam', contact: 'r@exemple.com', consent: true, website: 'http://spam' });
    check('champ piège rempli : ignoré', r.status === 200 && !(await db.prepare("SELECT 1 FROM leads WHERE name = 'Robot'").get()));
    r = await web('POST', '/api/contact', { name: 'A', message: 'x' });
    check('nom trop court refusé', r.status === 400);

    console.log('Relances par e-mail');
    check('rien n\'est envoyé avant l\'échéance', (await P.sendDueFollowups()) === 0 && fu().length === 0);
    await db.prepare("UPDATE leads SET next_follow_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), l.id);
    check('relance 1 envoyée à l\'échéance', (await P.sendDueFollowups()) === 1 && fu().length === 1);
    const m1 = fu()[0];
    check('destinataire, sujet et prénom', m1.to[0].email === 'awa@exemple.com' && /démarrer/.test(m1.subject) && /^Bonjour Awa,/.test(m1.textContent), m1.subject);
    check('lien de désinscription dans le texte et dans l\'en-tête', /\/api\/unsubscribe\?t=[a-f0-9]{32}/.test(m1.textContent) && m1.headers && /List-Unsubscribe/.test(Object.keys(m1.headers).join()));
    check('pas de promesse inventée (pas de chiffre de clients ni de témoignage)', !/\d+ (clients|entreprises) /.test(m1.textContent) && !/témoign/i.test(m1.textContent));
    l = await db.prepare('SELECT * FROM leads WHERE id = ?').get(l.id);
    check('étape 1 enregistrée, suivante dans 2 jours', Number(l.follow_stage) === 1 && Math.abs(new Date(l.next_follow_at) - Date.now() - 2 * 86400000) < 60000);
    await db.prepare('UPDATE leads SET next_follow_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), l.id);
    await P.sendDueFollowups();
    await db.prepare('UPDATE leads SET next_follow_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), l.id);
    await P.sendDueFollowups();
    check('3 messages au total, puis plus rien', fu().length === 3 && /dernier message automatique/.test(fu()[2].textContent), fu().length);
    await db.prepare('UPDATE leads SET next_follow_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), l.id);
    check('jamais plus de 3 relances', (await P.sendDueFollowups()) === 0 && fu().length === 3);

    console.log('Désinscription et statut');
    const stop = await db.prepare("INSERT INTO leads (name, message, contact, created_at, email, consent, next_follow_at, unsub_token) VALUES ('Éric Stop', 'x', 'eric@exemple.com', ?, 'eric@exemple.com', 1, ?, ?) RETURNING id").get(new Date().toISOString(), new Date(Date.now() - 1000).toISOString(), 'a'.repeat(32)).catch(() => null);
    const eid = stop ? stop.id : (await db.prepare("SELECT id FROM leads WHERE name = 'Éric Stop'").get()).id;
    r = await web('GET', '/api/unsubscribe?t=' + 'a'.repeat(32));
    check('lien de désinscription : page de confirmation', r.status === 200 && /ne recevrez plus/.test(r.text));
    const before = fu().length;
    check('désinscrit : aucune relance', (await P.sendDueFollowups()) === 0 && fu().length === before);
    r = await web('GET', '/api/unsubscribe?t=pas-un-jeton');
    check('lien invalide : message neutre, pas d\'erreur serveur', r.status === 200 && /plus valable/.test(r.text));
    const zz = await db.prepare("SELECT id FROM leads WHERE name = 'Paul Sans Case'").get();
    void eid; void zz;

    console.log('Suivi par l\'administrateur');
    const adm = client(base);
    r = await adm('GET', '/api/admin/leads');
    check('liste réservée à l\'administrateur', r.status === 401 || r.status === 403, r.status);
    r = await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    check('connexion administrateur', r.status === 200, r.json);
    r = await adm('GET', '/api/admin/leads');
    const awa = r.json.leads.find((x) => x.name === 'Awa Tchamba');
    check('la liste montre source, consentement, étape et relances', awa && awa.source === 'facebook' && awa.consent === true && awa.followStage === 3 && awa.status === 'new', awa);
    r = await adm('POST', '/api/admin/leads/' + awa.id + '/status', { status: 'trial', notes: 'Essai commencé le lundi.' });
    check('statut « en essai » et notes enregistrés', r.status === 200);
    r = await adm('POST', '/api/admin/leads/' + awa.id + '/status', { status: 'n-importe-quoi' });
    check('statut inconnu refusé', r.status === 400);
    r = await adm('GET', '/api/admin/leads');
    check('statut et notes relus', r.json.leads.find((x) => x.id === awa.id).status === 'trial' && /lundi/.test(r.json.leads.find((x) => x.id === awa.id).notes));
    await db.prepare('UPDATE leads SET follow_stage = 1, next_follow_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), awa.id);
    const n0 = fu().length; await P.sendDueFollowups();
    check('prospect en essai : plus de relance automatique', fu().length === n0);

    console.log('Visites anonymes');
    const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
    r = await web('POST', '/api/visit', { path: '/tarifs', ref: 'https://www.facebook.com/post/123?x=1', utm: '' }, { 'user-agent': UA });
    check('visite enregistrée (204)', r.status === 204);
    await web('POST', '/api/visit', { path: '/tarifs', ref: 'https://facebook.com/', utm: '' }, { 'user-agent': UA });
    await web('POST', '/api/visit', { path: '/', ref: '', utm: 'TikTok!' }, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' });
    await web('POST', '/api/visit', { path: '/app/1/crm' }, { 'user-agent': UA });
    await web('POST', '/api/visit', { path: '/../../etc/passwd' }, { 'user-agent': UA });
    await web('POST', '/api/visit', { path: '/' }, { 'user-agent': 'Googlebot/2.1' });
    const st = await P.visitStats(30);
    check('3 visites comptées (espace de travail, chemin piégé et robot exclus)', st.total === 3, st.total);
    check('origine : facebook.com regroupé, utm nettoyé', st.sources.some((x) => x.source === 'facebook.com' && x.n === 2) && st.sources.some((x) => x.source === 'tiktok' && x.n === 1), st.sources);
    check('appareils : mobile et ordinateur', st.devices.some((x) => x.device === 'mobile' && x.n === 2) && st.devices.some((x) => x.device === 'ordinateur' && x.n === 1), st.devices);
    const cols = (await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'site_visits'").all()).map((c) => c.column_name).join(',');
    check('aucune donnée personnelle dans la table (ni IP, ni identifiant)', !/ip|user|cookie|agent|visitor/.test(cols), cols);
    r = await adm('GET', '/api/admin/visits?days=7');
    check('statistiques lisibles par l\'administrateur', r.status === 200 && r.json.total === 3);
    r = await web('GET', '/api/admin/visits');
    check('statistiques refusées sans connexion', r.status === 401 || r.status === 403, r.status);
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close(); mailSrv.close();
  process.exit(failed ? 1 : 0);
}
main();
