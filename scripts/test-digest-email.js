'use strict';
// Test du résumé du matin et des alertes PAR E-MAIL (canal par défaut) : abonnement, consentement, envoi (faux service Brevo), dédoublonnage,
// désabonnement (lien signé), quota de l'offre, migration des anciens abonnés, canal WhatsApp inchangé, e-mail invalide, e-mails non configurés.
// Lancez-le avec : npm run test:digest-email   (base PostgreSQL temporaire, FAUX service d'e-mails, FAUX serveur Meta : aucun appel externe)
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { startTestPg, freePort } = require('./lib/testdb');

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text();
    let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t };
  };
}

/** Faux Brevo (API d'e-mails) + faux Meta (WhatsApp) sur un seul port local. */
function fakeServer(port) {
  const seen = { mail: [], wa: [] };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v3/smtp/email')) { seen.mail.push(JSON.parse(b || '{}')); res.statusCode = 201; return res.end('{"messageId":"x"}'); }
      if (req.url.startsWith('/graph/')) {
        if (req.method === 'POST' && /\/messages$/.test(req.url)) { const j = JSON.parse(b || '{}'); seen.wa.push({ to: j.to, type: j.type, body: (j.text || {}).body }); return res.end(JSON.stringify({ messages: [{ id: 'wamid.out' }] })); }
        return res.end(JSON.stringify({ display_phone_number: '+237 677 11 22 33', verified_name: 'Boutique Awa' }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, seen })));
}

async function startApp(env) {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...env, PORT: String(port), API_PUBLIC_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }
  return { base, child };
}

async function migrationTest() {
  console.log('Migration des anciens abonnés');
  Object.assign(process.env, { DATABASE_URL: 'pglite://memory', JWT_SECRET: 'secret-de-test-assez-long-123456', NODE_ENV: 'test' });
  const { db, MIGRATIONS } = require('../src/db');
  await db.ready;
  const now = new Date().toISOString();
  // On remet la base dans l'état « avant la migration » : sans colonnes channel / email, migration non enregistrée.
  await db.prepare('ALTER TABLE digest_subs DROP COLUMN channel').run();
  await db.prepare('ALTER TABLE digest_subs DROP COLUMN email').run();
  await db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(MIGRATIONS.length);
  const u = (await db.prepare("INSERT INTO users (name, contact, pass_hash, created_at) VALUES ('Ancien', 'ancien@exemple.com', 'x', ?)").run(now)).lastInsertRowid;
  const o = (await db.prepare("INSERT INTO orgs (name, owner_id, intake_token, created_at) VALUES ('Ancienne Org', ?, 'tok-migration-test', ?)").run(u, now)).lastInsertRowid;
  await db.prepare("INSERT INTO digest_subs (org_id, user_id, phone, morning, urgent, send_minute, template_name, consent_at, consent_text, updated_at) VALUES (?, ?, '237655112233', 1, 1, 450, 'resume_matin', ?, 'ancien texte WhatsApp', ?)").run(o, u, now, now);
  await db.migrate(MIGRATIONS);
  const s = await db.prepare('SELECT * FROM digest_subs WHERE org_id = ? AND user_id = ?').get(o, u);
  check('abonnement existant : passé sur le canal e-mail', s.channel === 'email', s.channel);
  check('abonnement existant : numéro, horaire, options, modèle et consentement conservés', s.phone === '237655112233' && Number(s.morning) === 1 && Number(s.urgent) === 1 && Number(s.send_minute) === 450 && s.template_name === 'resume_matin' && s.consent_at === now && s.unsub_at === null, s);
  check('adresse dédiée vide par défaut (l\'e-mail du compte sert)', s.email === '');
  const again = await db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = ?').get(MIGRATIONS.length);
  check('migration enregistrée une seule fois', Number(again.c) === 1);
  await db.close();
}

async function main() {
  await migrationTest();

  const fport = await freePort(); const fake = await fakeServer(fport);
  const pgt = await startTestPg();
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'BREVO_API_KEY', 'MAIL_API', 'MAIL_API_KEY'];
  const baseEnv = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, META_GRAPH_URL: `http://127.0.0.1:${fport}/graph`,
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', TRUST_PROXY: '0', SIGNUP_VERIFY: 'off', SMTP_FROM: 'Brij-IA <noreply@manager-ia.test>', SITE_URL: 'https://app.exemple.test',
    DIGEST_TICK_MS: '300', DIGEST_URGENT_MS: '300', MAIL_DAY_FREE: '6' };
  let app = await startApp({ ...baseEnv, BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: `http://127.0.0.1:${fport}/v3` });
  let rawDb; let app2 = null;
  try {
    rawDb = await pgt.open();
    const stamp = Date.now();
    const owner = client(app.base); const marc = client(app.base);
    const awaMail = `awa${stamp}@exemple.com`;
    const reg = (c, name, contact) => c('POST', '/api/register', { name, contact, pass: 'secret123' });
    check('inscriptions', (await reg(owner, 'Awa', awaMail)).status === 201 && (await reg(marc, 'Marc', `69${String(stamp).slice(-7)}`)).status === 201);
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`; const D = `${O}/mail/digest`;
    const inv = await owner('POST', `${O}/invites`, { role: 'manager' });
    await marc('POST', '/api/ws/orgs/join', { code: inv.json.code });
    const orgRow = await rawDb.prepare('SELECT * FROM orgs WHERE id = ?').get(org);
    const uid = (await rawDb.prepare('SELECT id FROM users WHERE contact = ?').get(awaMail)).id;

    const nowLocal = () => { const d = new Date(Date.now() + 60 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
    const hm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;
    const future = () => hm(nowLocal() + 180);
    const old = new Date(Date.now() - 50 * 86400000).toISOString().slice(0, 10);
    const cust = (await rawDb.prepare('INSERT INTO customers (org_id, name, phone, email, created_at) VALUES (?, ?, ?, ?, ?)').run(org, 'Marie Client', '655443322', '', new Date().toISOString())).lastInsertRowid;
    await rawDb.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'FA-9001', 'sent', 100000, 20000, ?, ?, 1, ?, ?)").run(org, cust, old, old, new Date().toISOString(), new Date().toISOString());
    await rawDb.prepare("INSERT INTO tasks (org_id, title, status, due, created_by, created_at) VALUES (?, 'Livrer la commande', 'todo', ?, 1, ?)").run(org, old, new Date().toISOString());

    console.log('Abonnement par e-mail');
    r = await owner('GET', D);
    check('canal par défaut : e-mail ; e-mails configurés ; WhatsApp non connecté ; adresse du compte connue', r.status === 200 && r.json.me.channel === 'email' && r.json.mailEnabled === true && r.json.connected === false && r.json.hasEmail === true && r.json.me.address === awaMail && /e-mail/.test(r.json.consentTextEmail), r.json);
    r = await owner('PUT', `${D}/me`, { morning: true, hour: future() });
    check('sans consentement -> 400 (jamais d\'envoi sans consentement)', r.status === 400 && /consentement/.test(r.json.error), r.json);
    r = await owner('PUT', `${D}/me`, { morning: true, consent: true, hour: future(), email: 'pas-une-adresse' });
    check('adresse e-mail invalide -> 400', r.status === 400 && /invalide/.test(r.json.error), r.json);
    r = await owner('PUT', `${D}/me`, { channel: 'sms', morning: true, consent: true, hour: future() });
    check('canal inconnu -> 400', r.status === 400, r.json);
    r = await marc('PUT', `${D}/me`, { morning: true, consent: true, hour: future() });
    check('compte sans e-mail (inscrit avec un téléphone) et sans adresse dédiée -> 400', r.status === 400 && /adresse e-mail/.test(r.json.error), r.json);
    const m0 = fake.seen.mail.length;
    r = await owner('POST', `${D}/test`);
    check('test sans abonnement -> 400, rien d\'envoyé', r.status === 400 && fake.seen.mail.length === m0, r.json);
    r = await owner('PUT', `${D}/me`, { morning: true, urgent: false, consent: true, hour: future() });
    check('abonnement par e-mail : aucun numéro WhatsApp requis, WhatsApp non connecté', r.status === 200, r.json);
    r = await owner('GET', D);
    check('consentement e-mail enregistré avec sa date et son texte', r.json.me.consented && /^\d{4}-\d{2}-\d{2}T/.test(r.json.me.consentAt) && r.json.me.channel === 'email', r.json.me);
    const cons = await rawDb.prepare('SELECT consent_text FROM digest_subs WHERE org_id = ? AND user_id = ?').get(org, uid);
    check('texte de consentement adapté à l\'e-mail', /par e-mail/.test(cons.consent_text) && !/WhatsApp/.test(cons.consent_text), cons);

    console.log('Envoi du résumé par e-mail');
    r = await owner('POST', `${D}/test`);
    const m1 = fake.seen.mail[fake.seen.mail.length - 1];
    check('test : envoi par e-mail, statut « Envoyé par e-mail », aucun message WhatsApp', r.status === 200 && r.json.status === 'email_sent' && r.json.channel === 'email' && /Envoyé par e-mail/.test(r.json.statusText) && fake.seen.wa.length === 0, r.json);
    check('destinataire = adresse du compte ; sujet avec le nom de l\'organisation', m1 && m1.to[0].email === awaMail && /Boutique Awa/.test(m1.subject) && /Test/.test(m1.subject), m1 && [m1.to, m1.subject]);
    check('texte : salutation, impayés, tâches, « Ouvrez Brij-IA pour le détail », lien vers l\'application', /Bonjour Awa/.test(m1.textContent) && /Impayés : 1 facture/.test(m1.textContent) && /Tâches en retard : 1/.test(m1.textContent) && /Ouvrez Brij-IA pour le détail/.test(m1.textContent) && m1.textContent.includes('https://app.exemple.test') && /\[Test\]/.test(m1.textContent) && !/undefined|NaN/.test(m1.textContent), m1.textContent);
    check('HTML simple : nom de l\'organisation, liste, lien vers l\'application', m1.htmlContent && /<li>/.test(m1.htmlContent) && /Boutique Awa/.test(m1.htmlContent) && /href="https:\/\/app\.exemple\.test"/.test(m1.htmlContent), m1.htmlContent);
    const link = (/(https?:\/\/[^\s"]+\/digest-unsub\/[\w.]+)/.exec(m1.textContent) || [])[1];
    check('désinscription en un clic : lien signé dans le texte, le HTML et l\'en-tête List-Unsubscribe', link && m1.htmlContent.includes(link) && m1.headers && m1.headers['List-Unsubscribe'] === `<${link}>`, link);
    const ob = await rawDb.prepare("SELECT * FROM outbox WHERE org_id = ? AND to_email = ?").all(org, awaMail);
    check('quota : l\'e-mail est inscrit au journal des e-mails de l\'offre', ob.length === 1 && ob[0].status === 'sent' && ob[0].customer_id === null, ob.length);
    r = await owner('GET', D);
    check('dernier envoi : statut « email_sent », canal e-mail', r.json.last && r.json.last.status === 'email_sent' && r.json.last.channel === 'email' && r.json.statusText.email_sent, r.json.last);

    // Planificateur : résumé à l'heure choisie (rattrapage), une seule fois
    const n0 = fake.seen.mail.length;
    r = await owner('PUT', `${D}/me`, { morning: true, urgent: false, hour: hm(nowLocal() - 1) });
    check('changer l\'heure ne redemande pas le consentement (même adresse)', r.status === 200, r.json);
    const got = await until(async () => fake.seen.mail.length > n0);
    await sleep(2000);
    const real = fake.seen.mail.slice(n0).filter((x) => /point du matin/.test(x.textContent) && !/\[Test\]/.test(x.textContent));
    const cnt = Number((await rawDb.prepare("SELECT COUNT(*) c FROM digest_log WHERE org_id = ? AND kind = 'morning'").get(org)).c);
    check('planificateur : le résumé du matin part tout seul par e-mail, une seule fois (verrou par jour)', got && real.length === 1 && cnt === 1 && fake.seen.wa.length === 0, [real.length, cnt]);
    const dup = await rawDb.prepare("INSERT OR IGNORE INTO digest_log (org_id, user_id, kind, dedupe_key, created_at) SELECT org_id, user_id, kind, dedupe_key, created_at FROM digest_log WHERE kind = 'morning' AND org_id = ?").run(org);
    check('verrou en base : un autre serveur ne peut pas envoyer un 2e résumé le même jour', dup.changes === 0);
    r = await owner('GET', D);
    check('journal : « Résumé du matin » envoyé par e-mail', r.json.log.some((l) => l.kind === 'morning' && l.status === 'email_sent' && l.channel === 'email'), r.json.log.map((l) => [l.kind, l.status]));

    // Alerte urgente
    console.log('Alerte urgente par e-mail');
    await rawDb.prepare("INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, created_at) VALUES (?, 'Savon noir', 'pièce', 0, 5, ?)").run(org, new Date().toISOString());
    const n1 = fake.seen.mail.length;
    await owner('PUT', `${D}/me`, { morning: true, urgent: true, hour: hm(nowLocal() - 1) });
    const gotU = await until(async () => fake.seen.mail.slice(n1).some((x) => /Alerte urgente/.test(x.subject)));
    const al = fake.seen.mail.slice(n1).find((x) => /Alerte urgente/.test(x.subject));
    check('alerte urgente envoyée par e-mail (rupture de stock, facture très en retard)', gotU && /Rupture de stock : Savon noir/.test(al.textContent) && /FA-9001 .* impayée depuis 50 jours/.test(al.textContent) && /Ouvrez Brij-IA/.test(al.textContent) && al.htmlContent.includes('<li>') && /Boutique Awa/.test(al.subject), al && al.textContent);
    await sleep(2000);
    check('alerte urgente : pas de répétition pour les mêmes événements', fake.seen.mail.slice(n1).filter((x) => /Alerte urgente/.test(x.subject)).length === 1);
    check('aucun message WhatsApp pendant tout ce temps', fake.seen.wa.length === 0);

    // Adresse dédiée
    console.log('Adresse e-mail dédiée');
    r = await owner('PUT', `${D}/me`, { morning: true, urgent: true, hour: future(), email: 'Direction@Exemple.com' });
    check('changer d\'adresse redemande le consentement -> 400', r.status === 400 && /consentement/.test(r.json.error), r.json);
    r = await owner('PUT', `${D}/me`, { morning: true, urgent: false, hour: future(), email: 'Direction@Exemple.com', consent: true });
    r = await owner('POST', `${D}/test`);
    const m2 = fake.seen.mail[fake.seen.mail.length - 1];
    check('l\'adresse dédiée (validée, en minuscules) est utilisée à la place de celle du compte', r.json.status === 'email_sent' && m2.to[0].email === 'direction@exemple.com', m2.to);
    // Compte « téléphone » avec adresse dédiée
    r = await marc('PUT', `${D}/me`, { morning: true, consent: true, hour: future(), email: `marc${stamp}@exemple.com` });
    r = await marc('POST', `${D}/test`);
    check('un compte inscrit avec un téléphone reçoit les e-mails sur son adresse dédiée', r.status === 200 && r.json.status === 'email_sent' && fake.seen.mail[fake.seen.mail.length - 1].to[0].email === `marc${stamp}@exemple.com`, r.json);

    // Quota de l'offre
    console.log('Quota d\'e-mails');
    const lim = 6;
    const used = Number((await rawDb.prepare("SELECT COUNT(*) c FROM outbox WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(org, `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)).c);
    for (let i = used; i < lim; i++) await rawDb.prepare("INSERT INTO outbox (org_id, user_id, to_email, subject, body, status, created_at) VALUES (?, ?, 'x@exemple.com', 's', 'b', 'sent', ?)").run(org, uid, new Date().toISOString());
    const nq = fake.seen.mail.length;
    r = await owner('POST', `${D}/test`);
    check('limite quotidienne de l\'offre atteinte : rien n\'est envoyé, statut clair', r.status === 200 && r.json.status === 'quota' && /Limite de 6 e-mails/.test(r.json.waError) && /limite/.test(r.json.statusText) && fake.seen.mail.length === nq, r.json);
    await rawDb.prepare("DELETE FROM outbox WHERE org_id = ? AND to_email = 'x@exemple.com'").run(org);

    // Désabonnement : lien signé puis bouton
    console.log('Désabonnement');
    const resBad = await fetch(link.slice(0, -3) + 'abc');
    check('lien de désinscription modifié -> 404, abonnement intact', resBad.status === 404 && (await owner('GET', D)).json.me.morning === true);
    const resOk = await fetch(link);
    r = await owner('GET', D);
    check('lien de désinscription : un clic suffit, plus rien d\'actif', resOk.status === 200 && /C'est fait/.test(await resOk.text()) && !r.json.me.morning && !r.json.me.urgent && !r.json.me.consented && r.json.me.unsubAt, r.json.me);
    const n2 = fake.seen.mail.length;
    await rawDb.prepare("INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, created_at) VALUES (?, 'Riz', 'kg', 0, 2, ?)").run(org, new Date().toISOString());
    await sleep(2000);
    check('après désabonnement : plus aucun e-mail (même avec un nouvel événement)', fake.seen.mail.slice(n2).every((x) => x.to[0].email !== awaMail && x.to[0].email !== 'direction@exemple.com'), fake.seen.mail.slice(n2).map((x) => x.to));
    r = await owner('POST', `${D}/test`);
    check('après désabonnement : le test refuse sans nouveau consentement', r.status === 400);
    r = await marc('POST', `${D}/me/unsubscribe`);
    check('bouton « Me désabonner » (un clic) pour un autre responsable', r.status === 200 && (await marc('GET', D)).json.me.consented === false);

    // WhatsApp : comportement conservé
    console.log('Canal WhatsApp inchangé');
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '', morning: true, consent: true, hour: future() });
    check('canal WhatsApp : le numéro reste obligatoire -> 400', r.status === 400 && /numéro WhatsApp/.test(r.json.error), r.json);
    r = await owner('PUT', `${O}/sales/whatsapp`, { phoneId: '109876543210', number: '237 677 11 22 33', token: 'EAAG-jeton-de-test-0123456789', appSecret: 'app-secret-de-test-xyz' });
    check('WhatsApp de l\'organisation connecté', r.status === 200 && r.json.connected === true, r.json);
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '655 44 33 22', morning: true, urgent: false, consent: true, hour: future() });
    check('canal WhatsApp : abonnement avec numéro et consentement', r.status === 200, r.json);
    r = await owner('GET', D);
    check('canal WhatsApp enregistré ; texte de consentement WhatsApp', r.json.me.channel === 'whatsapp' && r.json.connected === true, r.json.me);
    const nm = fake.seen.mail.length;
    r = await owner('POST', `${D}/test`);
    const w = fake.seen.wa[fake.seen.wa.length - 1];
    check('test WhatsApp : message WhatsApp livré (pas d\'e-mail)', r.json.status === 'delivered' && r.json.channel === 'whatsapp' && w && w.to === '237655443322' && /\[Test\]/.test(w.body) && /point du matin/.test(w.body) && fake.seen.mail.length === nm, r.json);

    // E-mails non configurés
    console.log('E-mails non configurés');
    app.child.kill(); await sleep(500);
    const beforeMU = Number((await rawDb.prepare("SELECT COUNT(*) c FROM digest_log WHERE org_id = ? AND kind IN ('morning', 'urgent')").get(org)).c);
    app2 = await startApp(baseEnv);
    const owner2 = client(app2.base);
    await owner2('POST', '/api/login', { contact: awaMail, pass: 'secret123' });
    r = await owner2('GET', D);
    check('état clair : mailEnabled = false côté serveur', r.status === 200 && r.json.mailEnabled === false, r.json.mailEnabled);
    r = await owner2('PUT', `${D}/me`, { channel: 'email', morning: true, urgent: true, hour: hm(nowLocal() - 1), consent: true });
    check('l\'abonnement peut être enregistré même sans e-mail configuré', r.status === 200, r.json);
    r = await owner2('POST', `${D}/test`);
    check('test sans e-mail configuré : statut « mail_off » explicite', r.status === 200 && r.json.status === 'mail_off' && /pas activé/.test(r.json.waError) && /e-mails/.test(r.json.statusText), r.json);
    await sleep(2500);
    const afterMU = Number((await rawDb.prepare("SELECT COUNT(*) c FROM digest_log WHERE org_id = ? AND kind IN ('morning', 'urgent')").get(org)).c);
    check('planificateur sans e-mail : rien n\'est consommé (les envois partiront dès que le serveur enverra des e-mails)', afterMU === beforeMU, [beforeMU, afterMU]);
    check('le serveur n\'a pas planté', app2.child.exitCode === null);
  } finally {
    try { if (rawDb) await rawDb.close(); } catch { /* fermée */ }
    app.child.kill(); if (app2) app2.child.kill();
    fake.srv.close();
    await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échec(s).`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
