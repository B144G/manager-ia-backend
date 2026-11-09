'use strict';
// Gestion des clients dans l'administration : liste enrichie (filtres, tri, export), fiche client SANS données confidentielles, suspension / réactivation,
// notes, connexions, alertes d'activité suspecte (seuils, dédoublonnage, e-mail pour la gravité haute). Lancez : npm run test:clients
const http = require('http');
const { startTestPg, freePort } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const pgt = await startTestPg();
  const mails = [];
  const mport = await freePort();
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { mails.push(JSON.parse(b || '{}')); res.statusCode = 201; res.end('{"messageId":"x"}'); }); });
  await new Promise((ok) => fake.listen(mport, '127.0.0.1', ok));
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0',
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', ADMIN_EMAIL: 'fondateur@exemple.com',
    BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: `http://127.0.0.1:${mport}/v3`, SMTP_FROM: 'Brij-IA <contact@exemple.com>',
    ALERT_LOGIN_FAILS: '3', ALERT_SESSION_IPS: '5', ALERT_SIGNUPS_PER_IP: '5', ALERT_AI_PER_HOUR: '120', ALERT_AI_PER_DAY: '800', ALERT_PAY_REJECTS: '3' });
  const { app } = require('../src/server');
  const { db, nowISO } = require('../src/db');
  await db.ready;
  const central = require('../src/security');
  const alerts = require('../src/services/alerts');
  const accounts = require('../src/services/accounts');
  const waWeb = require('../src/services/waWeb');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const PASS = 'Cacao-Mangue-42';
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const mailsTo = (addr) => mails.filter((m) => m.to && m.to[0] && m.to[0].email === addr);
  const reg = async (name, contact) => { const c = client(base); const r = await c('POST', '/api/register', { name, contact, pass: PASS, interests: [] }); return { c, id: r.json && r.json.user && r.json.user.id, status: r.status }; };
  const seedUser = async (name, contact, plan, exp, created) => Number((await db.prepare('INSERT INTO users (name, contact, pass_hash, plan, plan_expires, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(name, contact, 'x', plan, exp, created || nowISO())).lastInsertRowid);
  const seedOrg = async (ownerId, name) => {
    const oid = Number((await db.prepare('INSERT INTO orgs (name, sector, owner_id, intake_token, created_at) VALUES (?, ?, ?, ?, ?)').run(name, '', ownerId, 'tok' + Math.random().toString(36).slice(2) + Date.now(), nowISO())).lastInsertRowid);
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(oid, ownerId, nowISO());
    return oid;
  };
  const seedPay = async (userId, status, amount, ref) => db.prepare("INSERT INTO payments (reference, user_id, plan, operator, phone, amount_xaf, mode, status, created_at, paid_at) VALUES (?, ?, 'unl_month', 'mtn', '237670000000', ?, 'manual', ?, ?, ?)").run(ref, userId, amount, status, nowISO(), status === 'paid' ? nowISO() : null);
  try {
    const adm = client(base);
    const anon = client(base);
    await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });

    console.log('1. Accès réservé à l\'administrateur');
    for (const [m, u] of [['GET', '/api/admin/clients'], ['GET', '/api/admin/clients/1'], ['POST', '/api/admin/clients/1/suspend'], ['POST', '/api/admin/clients/1/reactivate'], ['POST', '/api/admin/clients/1/notes'], ['GET', '/api/admin/alerts'], ['POST', '/api/admin/alerts/1/handle'], ['GET', '/api/admin/summary']]) {
      const r = await anon(m, u, m === 'POST' ? {} : undefined);
      check(`${m} ${u} sans connexion admin : refusé`, r.status === 401, r.status);
    }

    console.log('2. Liste enrichie : offre, échéance, état, organisations, membres, messages IA, total payé');
    const uActive = await seedUser('Alice Active', 'alice@exemple.com', 'Pro', iso(20 * DAY), iso(-40 * DAY));
    const uSoon = await seedUser('Bruno Bientot', 'bruno@exemple.com', 'Pro', iso(3 * DAY), iso(-100 * DAY));
    const uExpired = await seedUser('Carine Expiree', 'carine@exemple.com', 'Pro', iso(-2 * DAY), iso(-200 * DAY));
    const uLapsed = await seedUser('Didier Revenu', 'didier@exemple.com', 'Gratuit', null, iso(-150 * DAY)); // a déjà payé, offre repassée à Gratuit
    const uFree = await seedUser('Estelle Gratuite', '670111222', 'Gratuit', null, nowISO());
    const orgA = await seedOrg(uActive, 'Boutique Alice');
    const orgA2 = await seedOrg(uActive, 'Atelier Alice');
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(orgA, uSoon, nowISO());
    await db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) SELECT ?, ?, ? FROM generate_series(1, 7)').run(orgA, uActive, nowISO());
    await seedPay(uActive, 'paid', 50000, 'REF-A1'); await seedPay(uActive, 'paid', 30000, 'REF-A2'); await seedPay(uActive, 'failed', 99999, 'REF-A3');
    await seedPay(uLapsed, 'paid', 150000, 'REF-D1');
    await seedPay(uSoon, 'awaiting_validation', 50000, 'REF-B1');
    let r = await adm('GET', '/api/admin/clients?limit=500&sort=name');
    const by = Object.fromEntries(r.json.clients.map((c) => [c.name, c]));
    check('tous les comptes sont listés avec un total', r.status === 200 && r.json.total === 5 && r.json.clients.length === 5, r.json.total);
    const a = by['Alice Active'];
    check('Alice : offre Pro, active, échéance, 2 organisations, 2 membres, 7 messages IA, 80 000 FCFA payés (le refusé ne compte pas)', a.plan === 'Pro' && a.planState === 'active' && a.planExpires && a.orgs === 2 && a.members === 2 && a.aiUsed === 7 && a.paidTotalXAF === 80000, a);
    check('quota IA total = quota par organisation × organisations', a.aiMax === 2 * require('../src/workspace/access').limitsFor('Pro').aiMonth, a.aiMax);
    check('états : expire bientôt / expirée / expirée (repassée à Gratuit après paiement) / gratuite', by['Bruno Bientot'].planState === 'expiring' && by['Carine Expiree'].planState === 'expired' && by['Didier Revenu'].planState === 'expired' && by['Estelle Gratuite'].planState === 'free', Object.values(by).map((c) => c.planState));
    check('paiement en attente de validation signalé', by['Bruno Bientot'].awaitingPayments === 1);
    check('jamais de mot de passe ni de secret dans la liste', !/pass_hash|totp|secret|"x"/.test(r.text));
    r = await adm('GET', '/api/admin/clients?state=expiring');
    check('filtre « expire bientôt »', r.json.clients.length === 1 && r.json.clients[0].name === 'Bruno Bientot');
    r = await adm('GET', '/api/admin/clients?state=expired');
    check('filtre « expirée »', r.json.clients.map((c) => c.name).sort().join() === 'Carine Expiree,Didier Revenu', r.json.clients.map((c) => c.name));
    r = await adm('GET', '/api/admin/clients?state=free');
    check('filtre « gratuite »', r.json.clients.length === 1 && r.json.clients[0].name === 'Estelle Gratuite');
    r = await adm('GET', '/api/admin/clients?plan=Pro');
    check('filtre par offre', r.json.total === 3, r.json.total);
    r = await adm('GET', '/api/admin/clients?q=' + encodeURIComponent('670111'));
    check('recherche par numéro', r.json.clients.length === 1 && r.json.clients[0].name === 'Estelle Gratuite');
    r = await adm('GET', '/api/admin/clients?q=ALICE');
    check('recherche par nom (sans tenir compte des majuscules)', r.json.clients.length === 1);
    r = await adm('GET', '/api/admin/clients?recent=7');
    check('filtre « inscrits récents »', r.json.clients.length === 1 && r.json.clients[0].name === 'Estelle Gratuite');
    r = await adm('GET', '/api/admin/clients?sort=paid');
    check('tri par total payé décroissant', r.json.clients[0].name === 'Didier Revenu' && r.json.clients[1].name === 'Alice Active', r.json.clients.map((c) => c.name));
    r = await adm('GET', '/api/admin/clients?sort=orgs');
    check('tri par nombre d\'organisations', r.json.clients[0].name === 'Alice Active');
    r = await adm('GET', '/api/admin/clients?plan=Inconnue');
    check('offre inconnue refusée', r.status === 400);
    r = await adm('GET', '/api/admin/clients?q=' + encodeURIComponent("x' OR '1'='1"));
    check('recherche : pas d\'injection SQL', r.status === 200 && r.json.clients.length === 0);
    const csv = await adm('GET', '/api/admin/export/users.csv');
    check('export CSV enrichi (dernière connexion, état, organisations, membres, messages IA, total payé)', csv.status === 200 && /derniere_connexion/.test(csv.text) && /total_paye_fcfa/.test(csv.text) && /"Alice Active";.*"Pro";.*"Active";"non";"2";"2";"7";"80000"/.test(csv.text), csv.text.split('\n').slice(0, 3));

    console.log('3. Fiche client : visible / invisible');
    const P = await reg('Patrick Prive', 'patrick.prive@exemple.com');
    let rr = await P.c('POST', '/api/ws/orgs', { name: 'Societe Patrick' });
    const orgP = rr.json.id;
    // Données confidentielles de l'entreprise et du client : rien de tout cela ne doit sortir dans la fiche
    const S1 = 'SECRET-MESSAGE-XYZ'; const S2 = 'CLIENT-SECRET-ABC'; const S3 = 'SALARIE-SECRET'; const S4 = 'FAC-SECRET-777'; const S5 = 'ACTIVITE-SECRET'; const S6 = 'CONVERSATION-SECRET';
    await db.prepare("INSERT INTO ai_messages (org_id, user_id, module, role, content, created_at) VALUES (?, ?, 'general', 'user', ?, ?)").run(orgP, P.id, S1 + ' contenu du message', nowISO());
    await db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, ?, ?)').run(orgP, P.id, nowISO());
    const cid = Number((await db.prepare("INSERT INTO customers (org_id, name, phone, email, notes, created_at) VALUES (?, ?, '699887766', 'cli@secret.com', 'note privee', ?)").run(orgP, S2, nowISO())).lastInsertRowid);
    await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, total, issued, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', ?, 'sent', 987654321, ?, ?, ?, ?)").run(orgP, cid, S4, nowISO().slice(0, 10), P.id, nowISO(), nowISO());
    await db.prepare('INSERT INTO employees (org_id, name, salary, created_at) VALUES (?, ?, 456789123, ?)').run(orgP, S3, nowISO());
    await db.prepare('INSERT INTO activity (org_id, user_id, module, text, created_at) VALUES (?, ?, ?, ?, ?)').run(orgP, P.id, 'crm', S5, nowISO());
    await db.prepare("INSERT INTO conversations (channel, contact_id, role, content, created_at) VALUES ('whatsapp', ?, 'user', ?, ?)").run('org' + orgP, S6, nowISO());
    await P.c('POST', '/api/logout', {});
    await P.c('POST', '/api/login', { contact: 'patrick.prive@exemple.com', pass: PASS });
    r = await adm('GET', `/api/admin/clients/${P.id}`);
    check('la fiche répond avec profil, usage, organisations, paiements, connexions, chronologie, notes, alertes', r.status === 200 && ['profile', 'usage', 'orgs', 'payments', 'sessions', 'timeline', 'notes', 'alerts', 'scope'].every((k) => k in r.json) && Object.keys(r.json).length === 9, Object.keys(r.json));
    const all = JSON.stringify(r.json);
    check('AUCUN contenu de message, de conversation, de client, de facture, de salaire ni d\'activité dans la fiche', [S1, S2, S3, S4, S5, S6, '987654321', '456789123', 'cli@secret.com', 'note privee', '699887766'].every((x) => !all.includes(x)), all.slice(0, 300));
    const lst = await adm('GET', '/api/admin/clients?limit=500');
    check('la liste ne contient pas non plus ces données', [S1, S2, S3, S4, S5, S6, '987654321', '456789123'].every((x) => !lst.text.includes(x)));
    check('organisations : seulement nom, nombre de membres, date, état WhatsApp, messages IA (un nombre)', r.json.orgs.length === 1 && JSON.stringify(Object.keys(r.json.orgs[0]).sort()) === JSON.stringify(['aiUsed', 'createdAt', 'id', 'members', 'name', 'whatsapp']), Object.keys(r.json.orgs[0]));
    check('chronologie : seulement type, libellé, détail technique, date', r.json.timeline.length >= 3 && r.json.timeline.every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(['at', 'detail', 'id', 'kind', 'label'])), r.json.timeline[0]);
    const kinds = r.json.timeline.map((e) => e.kind);
    check('chronologie : inscription, connexion, déconnexion, organisation créée', ['inscription', 'connexion', 'deconnexion', 'organisation_creee'].every((k) => kinds.includes(k)), kinds);
    check('connexions : appareil, adresse tronquée, jamais l\'identifiant de session ni l\'adresse entière', r.json.sessions.length === 1 && r.json.sessions[0].ip.endsWith('.x') && !all.includes('127.0.0.1') && /^[0-9a-f]{16}$/.test(r.json.sessions[0].handle));
    const realSids = (await db.prepare('SELECT id FROM sessions').all()).map((s) => s.id);
    check('l\'identifiant réel des sessions n\'apparaît nulle part', realSids.every((s) => !all.includes(s)));
    check('pas de mot de passe, secret 2FA ni jeton', !/pass_hash|totp_secret|recovery|intake_token/.test(all));
    check('le texte « ce que vous voyez / ne voyez pas » est fourni', r.json.scope.visible.length >= 5 && r.json.scope.hidden.length >= 4 && r.json.scope.hidden.some((x) => /messages/i.test(x)));
    check('dernière connexion renseignée', r.json.profile.lastLoginAt && Date.now() - Date.parse(r.json.profile.lastLoginAt) < 60000);
    r = await adm('GET', '/api/admin/clients/99999');
    check('client inconnu : 404', r.status === 404);

    console.log('4. Notes internes');
    r = await adm('POST', `/api/admin/clients/${P.id}/notes`, { text: 'x' });
    check('note trop courte refusée', r.status === 400);
    r = await adm('POST', `/api/admin/clients/${P.id}/notes`, { text: 'Appelé le lundi : veut une démo.' });
    const noteId = r.json.id;
    check('note ajoutée', r.status === 201 && noteId);
    r = await adm('GET', `/api/admin/clients/${P.id}`);
    check('la note est dans la fiche et dans la chronologie (sans son texte)', r.json.notes[0].text.includes('veut une démo') && r.json.timeline.some((e) => e.kind === 'note_admin' && !e.detail));
    r = await adm('DELETE', `/api/admin/clients/${P.id}/notes/${noteId}`);
    check('note supprimée', r.status === 200);

    console.log('5. Connexions : fermer une connexion précise, puis toutes');
    const d1 = client(base); const d2 = client(base); const d3 = client(base);
    for (const d of [d1, d2, d3]) await d('POST', '/api/login', { contact: 'patrick.prive@exemple.com', pass: PASS });
    r = await adm('GET', `/api/admin/clients/${P.id}`);
    check('4 appareils ouverts (1 + 3)', r.json.sessions.length === 4, r.json.sessions.length);
    r = await adm('POST', `/api/admin/clients/${P.id}/sessions/0000000000000000/revoke`, {});
    check('connexion inconnue : 404', r.status === 404);
    r = await adm('GET', `/api/admin/clients/${P.id}`);
    const target = r.json.sessions.find((s) => s.lastSeen) && r.json.sessions[0];
    r = await adm('POST', `/api/admin/clients/${P.id}/sessions/${target.handle}/revoke`, {});
    check('fermeture d\'une connexion précise', r.status === 200);
    r = await adm('GET', `/api/admin/clients/${P.id}`);
    check('il reste 3 connexions', r.json.sessions.length === 3, r.json.sessions.length);
    const alive = [];
    for (const d of [d1, d2, d3]) alive.push((await d('GET', '/api/me')).status);
    check('un seul des 3 appareils a été déconnecté', alive.filter((s) => s === 401).length === 1 || alive.filter((s) => s === 200).length === 2, alive);
    r = await adm('POST', `/api/admin/clients/${P.id}/sessions/revoke-all`, {});
    check('fermeture de toutes les connexions', r.status === 200 && r.json.closed >= 2, r.json);
    const after = [];
    for (const d of [d1, d2, d3]) after.push((await d('GET', '/api/me')).status);
    check('plus aucun appareil connecté', after.every((s) => s === 401), after);

    console.log('6. Suspension et réactivation');
    const S = await reg('Sylvie Suspendue', 'sylvie.susp@exemple.com');
    await S.c('POST', '/api/ws/orgs', { name: 'Salon Sylvie' });
    const calls = [];
    const realStatus = waWeb.status; const realStop = waWeb.stop;
    waWeb.status = () => ({ status: 'open' }); waWeb.stop = async (id) => { calls.push(id); };
    r = await adm('POST', `/api/admin/clients/${S.id}/suspend`, {});
    check('motif obligatoire', r.status === 400, r.json);
    r = await adm('POST', `/api/admin/clients/${S.id}/suspend`, { reason: 'Usage abusif signalé par un client' });
    waWeb.status = realStatus; waWeb.stop = realStop;
    check('suspension réussie : connexions fermées, WhatsApp coupé', r.status === 200 && r.json.sessionsClosed >= 1 && r.json.whatsappStopped === 1 && calls.length === 1, r.json);
    r = await S.c('GET', '/api/me');
    check('l\'ancienne connexion ne marche plus', r.status === 401, r.status);
    r = await client(base)('POST', '/api/login', { contact: 'sylvie.susp@exemple.com', pass: PASS });
    check('connexion refusée avec le message clair', r.status === 403 && r.json.error === 'Compte suspendu, contactez le support.' && r.json.code === 'suspended', r.json);
    r = await client(base)('POST', '/api/login', { contact: 'sylvie.susp@exemple.com', pass: 'Mauvais-mot-2-passe' });
    check('mauvais mot de passe : toujours le message habituel (rien n\'est révélé)', r.status === 401, r.status);
    r = await adm('POST', `/api/admin/clients/${S.id}/suspend`, { reason: 'encore une fois' });
    check('suspendre deux fois : 409', r.status === 409);
    await sleep(400);
    const ms = mailsTo('sylvie.susp@exemple.com').find((m) => /suspendu/.test(m.subject));
    check('e-mail de suspension avec le motif', ms && ms.textContent.includes('Usage abusif'), ms && ms.subject);
    r = await adm('GET', `/api/admin/clients/${S.id}`);
    check('fiche : suspendue + motif + chronologie', r.json.profile.suspended && r.json.profile.suspendedReason.includes('abusif') && r.json.timeline.some((e) => e.kind === 'compte_suspendu'));
    r = await adm('GET', '/api/admin/clients?suspended=1');
    check('filtre « suspendus »', r.json.clients.length === 1 && r.json.clients[0].id === S.id);
    r = await adm('GET', '/api/admin/summary');
    check('résumé : 1 compte suspendu', r.json.suspended === 1);
    const aud = await db.prepare("SELECT * FROM audit_trail WHERE action = 'admin.user_suspend'").all();
    check('journal d\'audit : suspension enregistrée avec le motif', aud.length === 1 && aud[0].target === `user:${S.id}` && aud[0].detail.includes('abusif'), aud);
    r = await adm('POST', `/api/admin/clients/${S.id}/reactivate`, {});
    check('réactivation', r.status === 200);
    r = await adm('POST', `/api/admin/clients/${S.id}/reactivate`, {});
    check('réactiver un compte actif : 409', r.status === 409);
    const S2c = client(base);
    r = await S2c('POST', '/api/login', { contact: 'sylvie.susp@exemple.com', pass: PASS });
    check('la personne peut se reconnecter', r.status === 200 && r.json.user, r.status);
    r = await S2c('GET', '/api/me/notices');
    check('notices dans l\'application : suspension puis réactivation', r.json.notices.some((n) => n.kind === 'account_suspended' && n.text.includes('abusif')) && r.json.notices.some((n) => n.kind === 'account_reactivated'), r.json.notices.map((n) => n.kind));
    await sleep(300);
    check('e-mail de réactivation', mailsTo('sylvie.susp@exemple.com').some((m) => /de nouveau actif/.test(m.subject)));
    check('2 entrées d\'audit (suspension et réactivation)', (await db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action IN ('admin.user_suspend', 'admin.user_reactivate')").get()).n == 2);

    console.log('7. Alertes d\'activité suspecte');
    const fakeReq = (ip) => ({ ip, get: () => 'test', id: 'r' });
    // a) échecs de connexion répétés (vrais essais sur l'API)
    const T = await reg('Thierry Cible', 'thierry.cible@exemple.com');
    for (let i = 0; i < 4; i++) await client(base)('POST', '/api/login', { contact: 'thierry.cible@exemple.com', pass: 'Mauvais-mot-' + i + '-passe' });
    // b) beaucoup d'adresses en peu de temps
    const uDev = await seedUser('Dora Devices', 'dora@exemple.com', 'Gratuit', null);
    for (let i = 1; i <= 6; i++) await db.prepare("INSERT INTO sessions (id, kind, user_id, created_at, last_seen, expires_at, ip, ua) VALUES (?, 'user', ?, ?, ?, ?, ?, 'Mozilla')").run('dev' + i + Date.now(), uDev, nowISO(), nowISO(), iso(DAY), `41.202.1.${i}`);
    // c) inscriptions en série depuis une même adresse
    for (let i = 0; i < 5; i++) await central.audit.record(fakeReq('203.0.113.77'), 'account.register', { userId: null, severity: 'info' });
    // d) pic de messages IA
    const uAi = await seedUser('Ines IA', 'ines@exemple.com', 'Gratuit', null);
    const orgAi = await seedOrg(uAi, 'Ines SARL');
    await db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) SELECT ?, ?, ? FROM generate_series(1, 130)').run(orgAi, uAi, nowISO());
    // e) refus de paiement répétés
    const uPay = await seedUser('Paul Refuse', 'paulr@exemple.com', 'Gratuit', null);
    for (let i = 0; i < 3; i++) await seedPay(uPay, 'failed', 20000, 'REF-F' + i);
    // f) adresse bloquée automatiquement (limites de débit / abus) : gravité haute
    await central.abuse.block('198.51.100.9', { reason: 'Activité suspecte (rate_limited, 45 points)', by: 'auto', req: fakeReq('198.51.100.9') });
    const mailsBefore = mails.length;
    const created = await alerts.scan();
    await sleep(600);
    r = await adm('GET', '/api/admin/alerts');
    const kindsA = r.json.alerts.map((x) => x.kind).sort();
    check('6 types d\'alertes créés par la tâche périodique', created === 6 && JSON.stringify(kindsA) === JSON.stringify(['abuse_block', 'ai_spike', 'login_fails', 'many_devices', 'payment_rejects', 'signups_same_ip']), [created, kindsA]);
    const al = Object.fromEntries(r.json.alerts.map((x) => [x.kind, x]));
    check('chaque alerte a une gravité, un titre lisible et un lien vers le client', al.login_fails.severity === 'medium' && al.login_fails.user.id === T.id && al.many_devices.user.id === uDev && al.ai_spike.user.id === uAi && al.payment_rejects.user.id === uPay && /échecs de connexion/.test(al.login_fails.title) && al.login_fails.severityLabel === 'Moyenne', al.login_fails);
    check('les adresses sont tronquées dans les alertes', /203\.0\.113\.x/.test(al.signups_same_ip.title) && /198\.51\.100\.x/.test(al.abuse_block.title) && !JSON.stringify(r.json.alerts).includes('203.0.113.77'));
    check('la gravité haute est triée en premier', r.json.alerts[0].severity === 'high', r.json.alerts.map((x) => x.severity));
    const toAdmin = mails.slice(mailsBefore).filter((m) => m.to[0].email === 'fondateur@exemple.com' && /gravité haute/.test(m.subject + m.textContent));
    check('e-mail à l\'administrateur pour la gravité haute seulement (1 : adresse bloquée)', toAdmin.length === 1 && /198\.51\.100\.x/.test(toAdmin[0].textContent), toAdmin.map((m) => m.subject));
    check('l\'alerte haute est marquée « prévenu par e-mail »', al.abuse_block.mailed === true && al.login_fails.mailed === false);
    const again = await alerts.scan();
    await sleep(300);
    check('dédoublonnage : un deuxième calcul ne crée rien et n\'envoie aucun e-mail de plus', again === 0 && mails.slice(mailsBefore).filter((m) => /gravité haute/.test(m.subject + m.textContent)).length === 1, again);
    r = await adm('GET', '/api/admin/summary');
    check('pastille « Alertes » = 6 (dont 1 haute)', r.json.alerts === 6 && r.json.alertsHigh === 1, r.json);
    r = await adm('GET', `/api/admin/clients?alerts=1`);
    check('filtre « avec alertes » et compteur dans la liste', r.json.clients.length >= 4 && r.json.clients.every((c) => c.openAlerts > 0), r.json.clients.map((c) => [c.name, c.openAlerts]));
    r = await adm('GET', `/api/admin/clients/${T.id}`);
    check('la fiche du client montre ses alertes', r.json.alerts.length === 1 && r.json.alerts[0].kind === 'login_fails');
    r = await adm('POST', `/api/admin/alerts/${al.login_fails.id}/handle`, {});
    check('bouton « traité »', r.status === 200);
    r = await adm('POST', `/api/admin/alerts/${al.login_fails.id}/handle`, {});
    check('traiter deux fois : 404', r.status === 404);
    r = await adm('GET', '/api/admin/alerts?status=handled');
    check('vue « traitées »', r.json.alerts.length === 1 && r.json.alerts[0].handledAt);
    r = await adm('GET', '/api/admin/alerts');
    check('plus que 5 alertes ouvertes', r.json.alerts.length === 5 && r.json.counts.open === 5);
    check('une alerte traitée ne revient pas aussitôt (délai de grâce)', await alerts.scan() === 0);
    // Seuils configurables : en relevant le seuil, plus d'alerte pour un nouveau compte
    process.env.ALERT_PAY_REJECTS = '50';
    const uPay2 = await seedUser('Quentin Refuse', 'quentin@exemple.com', 'Gratuit', null);
    for (let i = 0; i < 4; i++) await seedPay(uPay2, 'failed', 20000, 'REF-G' + i);
    check('seuils réglables par variables d\'environnement', await alerts.scan() === 0 && alerts.thresholds().payRejects === 50);
    process.env.ALERT_PAY_REJECTS = '3';
    check('et l\'alerte apparaît dès que le seuil le permet', await alerts.scan() === 1);

    console.log('8. Tâche périodique');
    await db.prepare("UPDATE users SET plan_expires = ? WHERE id = ?").run(iso(-DAY), uExpired);
    const jobs = require('../src/jobs');
    await jobs.runOnce();
    const ex = await db.prepare('SELECT plan FROM users WHERE id = ?').get(uExpired);
    const ev = await db.prepare("SELECT * FROM account_events WHERE user_id = ? AND kind = 'offre_expiree'").all(uExpired);
    check('l\'expiration repasse l\'offre à Gratuit et s\'inscrit dans la chronologie', ex.plan === 'Gratuit' && ev.length === 1);
    check('la tâche périodique des alertes existe', typeof jobs.startAlerts === 'function');
    r = await adm('GET', '/api/admin/overview');
    check('la vue d\'ensemble compte les alertes à traiter', r.json.todo.alerts >= 5, r.json.todo);
    const sec = await adm('GET', '/api/admin/security/audit?limit=200&action=admin.user');
    check('les actions sur les connexions sont dans le journal d\'audit', sec.json.events.filter((e) => /session/.test(e.action)).length >= 2, sec.json.events.map((e) => e.action));
  } finally {
    srv.close(); fake.close(); await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
