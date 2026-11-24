'use strict';
// Paiement automatique Campay (MTN / Orange) de bout en bout, contre le FAUX serveur Campay local (scripts/mock-campay.js) : aucun argent, aucune vraie clé.
// Couvre : configuration (refus du mode réel sans variables), parcours complet, prolongation sans perte de jours, idempotence, webhook (signature, rejeu, falsification),
// montant / référence modifiés, double clic, échec, expiration + confirmation tardive, webhook perdu (réconciliation), administration (liste, filtres, revérification,
// activation manuelle avec motif), alertes e-mail, masquage des numéros, limitation de débit. Lancez : npm run test:campay
const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');
const { startTestPg, freePort } = require('./lib/testdb');
const mockCampay = require('./mock-campay');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(120); } }
function client(base) {
  const jar = {};
  return async (method, url, body, extraHeaders) => {
    const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(extraHeaders || {}) };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t };
  };
}

// Journaux du serveur capturés : aucun numéro complet ne doit y apparaître.
const logs = [];
for (const k of ['log', 'info', 'warn', 'error']) { const o = console[k].bind(console); console[k] = (...a) => { logs.push(a.map(String).join(' ')); o(...a); }; }

async function main() {
  // ---------- 0. Configuration : le mode réel est refusé sans variables ----------
  console.log('0. Configuration (CAMPAY_MODE)');
  const cfgRun = (env) => spawnSync(process.execPath, ['-e', "const c=require('./src/config').campay;console.log(JSON.stringify({mode:c.mode,base:c.baseUrl,en:c.enabled}))"], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL: 'pglite://memory', ...env } });
  let r0 = cfgRun({ CAMPAY_MODE: 'reel' });
  check('mode réel sans variables : le serveur refuse de démarrer', r0.status === 1 && /CAMPAY_MODE=reel refusé/.test(r0.stderr), r0.stderr.slice(0, 200));
  r0 = cfgRun({ CAMPAY_MODE: 'reel', CAMPAY_APP_USERNAME: 'u-factice', CAMPAY_APP_PASSWORD: 'p-factice' });
  check('mode réel sans clé de webhook : refusé aussi', r0.status === 1 && /CAMPAY_WEBHOOK_KEY/.test(r0.stderr));
  check('le message de refus ne contient aucune valeur de variable', !/u-factice|p-factice/.test(r0.stderr));
  r0 = cfgRun({ CAMPAY_MODE: 'reel', CAMPAY_APP_TOKEN: 't-factice', CAMPAY_WEBHOOK_KEY: 'k-factice' });
  check('mode réel complet : accepté, adresse de production', r0.status === 0 && JSON.parse(r0.stdout.trim().split('\n').pop()).base === 'https://www.campay.net/api', r0.stdout + r0.stderr);
  r0 = cfgRun({});
  check('par défaut : mode test, adresse de démonstration, paiement automatique inactif sans clés', r0.status === 0 && JSON.stringify(JSON.parse(r0.stdout.trim().split('\n').pop())) === JSON.stringify({ mode: 'test', base: 'https://demo.campay.net/api', en: false }), r0.stdout);
  r0 = cfgRun({ CAMPAY_MODE: 'prod' });
  check('mode inconnu : refusé', r0.status === 1);

  // ---------- Mise en place ----------
  const pgt = await startTestPg();
  const mails = [];
  const mport = await freePort();
  const fakeMail = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { mails.push(JSON.parse(b || '{}')); res.statusCode = 201; res.end('{"messageId":"x"}'); }); });
  await new Promise((ok) => fakeMail.listen(mport, '127.0.0.1', ok));
  const mock = await mockCampay.start({ confirmMs: 300 });
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0',
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', ADMIN_EMAIL: 'fondateur@exemple.com', BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: `http://127.0.0.1:${mport}/v3`, SMTP_FROM: 'MABAH <contact@exemple.com>',
    CAMPAY_MODE: 'test', CAMPAY_BASE_URL: mock.url, CAMPAY_APP_USERNAME: mock.creds.username, CAMPAY_APP_PASSWORD: mock.creds.password, CAMPAY_WEBHOOK_KEY: mock.creds.webhookKey,
    CAMPAY_RECONCILE_AFTER_MIN: '0', CAMPAY_FAIL_ALERT_COUNT: '3', CAMPAY_WEBHOOK_RATE: '40', PAYMENTS_INIT_RATE: '500' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const config = require('../src/config');
  const cpay = require('../src/services/campay-pay');
  const cclient = require('../src/services/campay-client');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const HOOK = `${base}/api/payments/webhook/campay`;
  mock.setWebhookUrl(HOOK);
  const KEY = mock.creds.webhookKey;
  const PASS = 'Cacao-Mangue-42';
  let seq = 0;
  const reg = async (name) => { const c = client(base); const contact = `campay${++seq}.${Date.now()}@exemple.com`; const r = await c('POST', '/api/register', { name, contact, pass: PASS, interests: [] }); return { c, id: r.json && r.json.user && r.json.user.id, contact, status: r.status }; };
  const rowOf = (ref) => db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);
  const userOf = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const pay = (U, body) => U.c('POST', '/api/payments/initiate', Object.assign({ plan: 'unl_month', operator: 'mtn', phone: '677777777' }, body));
  const hook = (body, sig) => fetch(HOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, signature: sig }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const signed = (extra) => cclient.signJwtHS256({ source: 'CamPay', iat: Math.floor(Date.now() / 1000), n: Math.random(), ...(extra || {}) }, KEY);
  const days = (iso) => (Date.parse(iso) - Date.now()) / 86400000;
  const auditHas = async (action, target) => Number((await db.prepare('SELECT COUNT(*) AS n FROM audit_trail WHERE action = ? AND target = ?').get(action, target)).n) > 0;
  const mailsTo = (addr) => mails.filter((m) => m.to && m.to[0] && m.to[0].email === addr);
  const price = config.plans.unl_month.priceXAF;

  try {
    const adm = client(base);
    await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    const anon = client(base);

    console.log('1. Mode et catalogue');
    let r = await anon('GET', '/api/plans');
    check('/api/plans : paiement automatique actif et mode test annoncé', r.json.automatic === true && r.json.testMode === true, r.json);
    check('prix du catalogue inchangé (Illimité 1 mois = 80 000 FCFA par défaut)', price === 80000, price);

    console.log('2. Demande de paiement : validations');
    const U = await reg('Awa Client');
    check('inscription', U.status === 201 && U.id, U.status);
    r = await pay(U, { phone: '12345' });
    check('numéro invalide refusé', r.status === 400 && /Numéro invalide/.test(r.json.error), r.json);
    r = await pay(U, { phone: '+237 2 33 42 55 66' });
    check('numéro fixe (non Mobile Money) refusé', r.status === 400);
    r = await pay(U, { operator: 'wave' });
    check('opérateur inconnu refusé', r.status === 400);
    r = await pay(U, { plan: 'offre-inventee' });
    check('offre inconnue refusée', r.status === 400);
    check('aucun appel à Campay pour les demandes invalides', !mock.state.calls.some((c) => c.includes('/collect/')), mock.state.calls);

    console.log('3. Parcours complet : MTN, succès confirmé par webhook signé');
    r = await pay(U, { amount: 1, priceXAF: 1, price: 1, amountXAF: 1 }); // le client essaie d'imposer un prix
    check('demande acceptée, en attente, montant du catalogue (le prix du client est ignoré)', r.status === 200 && r.json.mode === 'push' && r.json.status === 'pending' && r.json.amountXAF === price && r.json.testMode === true, r.json);
    check('la réponse ne contient aucun numéro complet ni clé', !/677777777/.test(r.text) && !r.text.includes(KEY));
    const ref1 = r.json.reference;
    let p1 = await rowOf(ref1);
    check('transaction enregistrée : référence Campay, UUID externe, XAF, expiration, mode test, numéro masqué', p1.provider_ref && /^[0-9a-f-]{36}$/.test(p1.ext_ref) && p1.currency === 'XAF' && p1.expires_at && Number(p1.test_mode) === 1 && !/677777777/.test(p1.phone) && /777$/.test(p1.phone), p1);
    const sent = [...mock.state.txs.values()].find((t) => t.reference === p1.provider_ref);
    check('Campay a reçu le montant du catalogue, en XAF, avec la référence externe', sent && sent.amount === price && sent.currency === 'XAF' && sent.external_reference === p1.ext_ref && sent.phone_number === '237677777777', sent);
    r = await U.c('GET', `/api/payments/${ref1}`);
    check('suivi : en attente', r.status === 200 && ['pending', 'paid'].includes(r.json.status), r.json);
    const done1 = await until(async () => (await rowOf(ref1)).status === 'paid');
    check('à la confirmation (webhook), le paiement passe à « payé » tout seul', done1, (await rowOf(ref1)).status);
    p1 = await rowOf(ref1);
    let u = await userOf(U.id);
    check('abonnement activé automatiquement (Illimité, 30 jours)', u.plan === 'Illimité' && Math.abs(days(u.plan_expires) - 30) < 0.01, [u.plan, u.plan_expires]);
    check('paiement confirmé via le webhook, vérifié par relecture chez Campay', p1.paid_via === 'webhook' && mock.state.calls.some((c) => c.startsWith('GET /api/transaction/')), p1.paid_via);
    r = await U.c('GET', `/api/payments/${ref1}/receipt`);
    check('reçu numéroté, marqué TEST', r.status === 200 && /^R-\d{4}-\d{5}$/.test(r.json.receipt.number) && r.json.receipt.test === true && r.json.receipt.amountXAF === price, r.json);
    await sleep(500);
    const ms = mailsTo(U.contact).filter((m) => /active/.test(m.subject));
    check('e-mail de confirmation envoyé, avec le reçu en pièce jointe, objet [TEST]', ms.length === 1 && /^\[TEST\]/.test(ms[0].subject) && ms[0].attachment && ms[0].attachment.length === 1, ms.map((m) => m.subject));
    r = await U.c('GET', '/api/billing');
    check('historique : paiement « payé » visible', r.json.history.some((h) => h.reference === ref1 && h.status === 'paid') && r.json.testMode === true);
    check('audit : paiement initié et confirmé journalisés', (await auditHas('payment.initiated', ref1)) && (await auditHas('payment.paid', ref1)));

    console.log('4. Idempotence, rejeu et falsification du webhook');
    const exp1 = u.plan_expires;
    r = await hook({ status: 'SUCCESSFUL', reference: p1.provider_ref, external_reference: p1.ext_ref }, signed());
    check('même paiement reçu une 2e fois (nouveau webhook valide) : aucune activation en plus', r.status === 200 && (await userOf(U.id)).plan_expires === exp1);
    await cpay.recheck(p1, { via: 'poll' });
    check('revérifier un paiement déjà payé : rien ne change', (await userOf(U.id)).plan_expires === exp1);
    const sigReplay = signed(); const body = { status: 'SUCCESSFUL', reference: p1.provider_ref };
    r = await hook(body, sigReplay); const second = await hook(body, sigReplay);
    check('rejeu exact de la même signature : ignoré (duplicate)', r.status === 200 && second.status === 200 && second.json.duplicate === true, second);
    r = await hook(body, 'abc.def.ghi');
    check('signature forgée : 401', r.status === 401, r);
    r = await hook(body, cclient.signJwtHS256({ source: 'CamPay' }, 'autre-cle'));
    check('JWT signé avec une autre clé : 401', r.status === 401);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
    r = await hook(body, none);
    check('JWT « alg: none » : 401', r.status === 401);
    r = await hook(body, undefined);
    check('signature absente : 401', r.status === 401);
    r = await fetch(HOOK + `?status=SUCCESSFUL&reference=${p1.provider_ref}`).then((x) => x.status);
    check('webhook en GET sans signature : 401', r === 401);
    check('audit : webhooks refusés journalisés', Number((await db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'payment.webhook_rejected'").get()).n) >= 4);

    console.log('5. Prolongation : aucun jour perdu');
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 10 * 86400000).toISOString(), U.id);
    r = await pay(U, { phone: '699999999', operator: 'orange' });
    check('renouvellement de la même offre accepté', r.status === 200, r.json);
    const ref2 = r.json.reference;
    check('l\'Orange de test réussit', await until(async () => (await rowOf(ref2)).status === 'paid'));
    u = await userOf(U.id);
    check('10 jours restants + 30 jours = 40 jours', Math.abs(days(u.plan_expires) - 40) < 0.01, days(u.plan_expires));
    check('opérateur relevé chez Campay (Orange)', (await rowOf(ref2)).operator === 'orange');

    console.log('6. Un webhook ne suffit jamais : le statut est relu chez Campay');
    const U6 = await reg('Binta Pending');
    r = await pay(U6, { phone: '677777701' }); // numéro non listé : reste en attente
    const ref6 = r.json.reference; const p6 = await rowOf(ref6);
    r = await hook({ status: 'SUCCESSFUL', reference: p6.provider_ref, external_reference: p6.ext_ref, amount: String(price) }, signed());
    check('webhook signé annonçant un succès, mais Campay dit « en attente » : rien n\'est activé', r.status === 200 && (await rowOf(ref6)).status === 'pending' && (await userOf(U6.id)).plan === 'Gratuit');
    r = await U6.c('GET', `/api/payments/${ref6}`);
    check('suivi : toujours en attente', r.json.status === 'pending');

    console.log('7. Montant ou référence modifiés');
    await fetch(mock.origin + '/__mock/set', { method: 'POST', body: JSON.stringify({ amountOverride: 100 }) });
    await fetch(mock.origin + '/__mock/resolve', { method: 'POST', body: JSON.stringify({ reference: p6.provider_ref, status: 'SUCCESSFUL' }) });
    const blocked = await until(async () => (await rowOf(ref6)).status === 'needs_review');
    check('montant annoncé différent de la commande : paiement bloqué « à vérifier », offre NON activée', blocked && (await userOf(U6.id)).plan === 'Gratuit', (await rowOf(ref6)).status);
    check('écart noté, audit critique', /montant/.test((await rowOf(ref6)).last_error) && (await db.prepare("SELECT severity FROM audit_trail WHERE action = 'payment.mismatch' AND target = ?").get(ref6) || {}).severity === 'critical');
    await sleep(400);
    check('l\'administrateur est alerté par e-mail', mailsTo('fondateur@exemple.com').some((m) => /payment\.mismatch/.test(m.subject)), mailsTo('fondateur@exemple.com').map((m) => m.subject).slice(-4));
    await fetch(mock.origin + '/__mock/set', { method: 'POST', body: JSON.stringify({ amountOverride: null }) });
    const U7 = await reg('Cheikh Ext');
    r = await pay(U7, { phone: '677777702' }); const ref7 = r.json.reference; const p7 = await rowOf(ref7);
    await fetch(mock.origin + '/__mock/set', { method: 'POST', body: JSON.stringify({ extOverride: 'autre-commande' }) });
    await fetch(mock.origin + '/__mock/resolve', { method: 'POST', body: JSON.stringify({ reference: p7.provider_ref, status: 'SUCCESSFUL' }) });
    check('référence externe qui ne correspond pas : bloqué, offre non activée', await until(async () => (await rowOf(ref7)).status === 'needs_review') && (await userOf(U7.id)).plan === 'Gratuit');
    await fetch(mock.origin + '/__mock/set', { method: 'POST', body: JSON.stringify({ extOverride: null }) });
    r = await adm('GET', '/api/admin/payments?status=needs_review');
    check('administration : les paiements bloqués sont listés en premier', r.json.payments.length >= 2 && r.json.stats.reviewCount >= 2, r.json.stats);

    console.log('8. Double clic et paiements simultanés');
    const U8 = await reg('Dieudonne Double');
    const [a, b] = await Promise.all([pay(U8, { phone: '677777703' }), pay(U8, { phone: '677777703' })]);
    check('deux envois simultanés : une seule demande, même référence', a.status === 200 && b.status === 200 && a.json.reference === b.json.reference, [a.json, b.json]);
    check('une seule ligne en attente et un seul appel à Campay pour ce client', Number((await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ?").get(U8.id)).n) === 1);
    r = await pay(U8, { plan: 'unl_week', phone: '677777703' });
    check('autre offre pendant un paiement en cours : 409', r.status === 409, r.json);

    console.log('9. Échec, nouvelle tentative, échecs répétés');
    const U9 = await reg('Esther Echec');
    const failRefs = [];
    for (let i = 0; i < 3; i++) {
      r = await pay(U9, { phone: '677777770' });
      failRefs.push(r.json.reference);
      const ok = await until(async () => (await rowOf(r.json.reference)).status === 'failed');
      check(`tentative ${i + 1} : refus sur le téléphone -> « échoué »`, ok);
    }
    const f1 = await rowOf(failRefs[0]);
    check('motif et notice utilisateur enregistrés, aucune activation', f1.last_error && (await userOf(U9.id)).plan === 'Gratuit');
    r = await U9.c('GET', `/api/payments/${failRefs[0]}`);
    check('suivi : échoué', r.json.status === 'failed');
    await sleep(600);
    check('3 échecs en 24 h : alerte e-mail à l\'administrateur', mailsTo('fondateur@exemple.com').some((m) => /Échecs de paiement répétés/.test(m.subject)), mailsTo('fondateur@exemple.com').map((m) => m.subject).slice(-5));
    r = await pay(U9, { phone: '699999999', operator: 'orange' });
    check('nouvelle tentative après un échec : acceptée et réussie', r.status === 200 && await until(async () => (await rowOf(r.json.reference)).status === 'paid'));

    console.log('10. Expiration, confirmation tardive, webhook perdu (réconciliation)');
    const U10 = await reg('Fatou Expire');
    r = await pay(U10, { phone: '677777704' }); const ref10 = r.json.reference;
    await db.prepare("UPDATE payments SET expires_at = ? WHERE reference = ?").run(new Date(Date.now() - 1000).toISOString(), ref10);
    r = await U10.c('GET', `/api/payments/${ref10}`);
    check('délai dépassé sans confirmation : « expiré »', r.json.status === 'expired', r.json);
    r = await pay(U10, { phone: '677777704' });
    check('après expiration, une nouvelle tentative est possible', r.status === 200 && r.json.reference !== ref10);
    const refNew = r.json.reference;
    await db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ?").run(refNew); // libère le client pour la suite
    await fetch(mock.origin + '/__mock/resolve', { method: 'POST', body: JSON.stringify({ reference: (await rowOf(ref10)).provider_ref, status: 'SUCCESSFUL', webhook: false }) });
    await db.prepare('UPDATE payments SET last_checked_at = NULL WHERE reference = ?').run(ref10);
    const rec = await cpay.reconcile();
    check('webhook perdu + confirmation tardive : la réconciliation retrouve et active le paiement expiré', (await rowOf(ref10)).status === 'paid' && (await rowOf(ref10)).paid_via === 'reconciliation' && rec.checked >= 1, rec);
    const U11 = await reg('Gaston Perdu');
    mock.setWebhookUrl('http://127.0.0.1:9/perdu'); // le webhook de cette confirmation part dans le vide
    r = await pay(U11, { phone: '677777777' }); const ref11 = r.json.reference;
    await until(async () => mock.state.webhooks.some((w) => w.error), 5000);
    mock.setWebhookUrl(HOOK);
    check('webhook perdu : le paiement est confirmé chez Campay mais pas encore chez nous', (await rowOf(ref11)).status === 'pending');
    await cpay.reconcile();
    check('webhook perdu : la réconciliation active quand même', (await rowOf(ref11)).status === 'paid' && (await rowOf(ref11)).paid_via === 'reconciliation');

    console.log('11. Administration');
    const U12 = await reg('Hawa Admin');
    r = await pay(U12, { phone: '677777705' }); const ref12 = r.json.reference; const p12 = await rowOf(ref12);
    r = await adm('GET', '/api/admin/campay');
    check('administration : mode test annoncé, URL du webhook, présence (jamais la valeur) de la clé', r.json.test === true && r.json.mode === 'test' && /\/api\/payments\/webhook\/campay$/.test(r.json.webhookUrl) && r.json.hasWebhookKey === true && !r.text.includes(KEY) && !r.text.includes(mock.creds.password), r.json);
    r = await adm('GET', '/api/admin/payments?operator=orange');
    check('filtre opérateur', r.status === 200 && r.json.payments.length >= 1 && r.json.payments.every((x) => x.operator === 'orange'));
    r = await adm('GET', '/api/admin/payments?status=failed&from=2020-01-01&to=2099-12-31');
    check('filtres statut + dates', r.status === 200 && r.json.payments.length >= 3 && r.json.payments.every((x) => x.status === 'failed'));
    r = await adm('GET', '/api/admin/payments?from=2099-01-01');
    check('filtre de date : aucun résultat dans le futur', r.json.payments.length === 0);
    r = await adm('GET', '/api/admin/payments');
    check('totaux : encaissé (hors test), encaissé test, échecs, en attente, à vérifier', r.json.stats && r.json.stats.paidXAF === 0 && r.json.stats.paidTestXAF >= price * 3 && r.json.stats.failedCount >= 3 && r.json.stats.pendingCount >= 1 && r.json.stats.reviewCount >= 2, r.json.stats);
    check('la liste ne montre aucun numéro complet', !/237677777\d{3}\b/.test(r.text) && r.json.payments.filter((x) => x.mode === 'push').every((x) => /\*\*/.test(x.phone)));
    r = await adm('POST', `/api/admin/payments/${p12.id}/validate`, {});
    check('« Valider » (paiement manuel) refusé pour un paiement automatique', r.status === 409);
    r = await adm('POST', `/api/admin/payments/${p12.id}/recheck`, {});
    check('revérifier chez Campay : toujours en attente', r.status === 200 && r.json.status === 'pending' && r.json.payment.checks >= 1, r.json);
    r = await adm('POST', `/api/admin/payments/${p12.id}/activate`, {});
    check('activation manuelle sans motif : refusée', r.status === 400);
    r = await adm('POST', `/api/admin/payments/${p12.id}/activate`, { reason: 'Webhook perdu, SMS opérateur vérifié par téléphone' });
    check('activation manuelle avec motif : offre activée', r.status === 200 && (await userOf(U12.id)).plan === 'Illimité' && (await rowOf(ref12)).paid_via === 'admin' && /Webhook perdu/.test((await rowOf(ref12)).admin_note), r.json);
    check('audit : activation manuelle journalisée (gravité haute, motif)', Number((await db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'payment.admin_activated' AND target = ? AND severity = 'high' AND detail LIKE '%Webhook perdu%'").get(ref12)).n) === 1);
    r = await adm('POST', `/api/admin/payments/${p12.id}/activate`, { reason: 'deuxième clic accidentel' });
    check('activation manuelle répétée : refusée, durée non doublée', r.status === 409 && Math.abs(days((await userOf(U12.id)).plan_expires) - 30) < 0.01);
    const p6b = await rowOf(ref6);
    r = await adm('POST', `/api/admin/payments/${p6b.id}/reject`, { reason: 'Écart de montant, remboursement fait' });
    check('paiement bloqué : refus avec motif possible', r.status === 200 && (await rowOf(ref6)).status === 'failed');

    console.log('12. Pannes de Campay et jeton permanent');
    await fetch(mock.origin + '/__mock/set', { method: 'POST', body: JSON.stringify({ down: true }) });
    const U13 = await reg('Ibrahim Panne');
    r = await pay(U13, { phone: '677777706' });
    check('Campay indisponible : 502 clair, rien d\'activé', r.status === 502 && !/503|Service/.test(r.json.error), r.json);
    const pf = await db.prepare("SELECT * FROM payments WHERE user_id = ?").get(U13.id);
    check('la tentative est tracée (échoué + code d\'erreur) et le client peut réessayer', pf && pf.status === 'failed' && pf.last_error);
    await fetch(mock.origin + '/__mock/set', { method: 'POST', body: JSON.stringify({ down: false }) });
    r = await pay(U13, { phone: '237 12' });
    check('ER101 -> message clair (le numéro est contrôlé avant l\'appel)', r.status === 400);
    config.campay.token = mock.creds.token; cclient.resetTokenCache();
    let err = null; try { await cclient.getTransaction('00000000-0000-4000-8000-000000000000'); } catch (e) { err = e; }
    check('jeton permanent (CAMPAY_APP_TOKEN) accepté par Campay (introuvable = 404, pas 401)', err && err.status === 404, err && err.message);
    config.campay.token = ''; cclient.resetTokenCache();
    check('jeton temporaire demandé et réutilisé (une seule demande de jeton pour de nombreux appels)', mock.state.tokenCount >= 1 && mock.state.tokenCount <= 3, mock.state.tokenCount);

    console.log('13. Confidentialité et limitation de débit');
    const all = logs.join('\n');
    check('aucun numéro complet dans les journaux du serveur', !/237677777\d{3}\b/.test(all) && !/\b677777\d{3}\b/.test(all));
    const aud = (await db.prepare('SELECT detail FROM audit_trail').all()).map((x) => x.detail).join('\n');
    check('aucun numéro complet dans le journal d\'audit', !/237677777\d{3}\b/.test(aud) && !/\b677777\d{3}\b/.test(aud));
    check('aucune clé ni mot de passe dans les journaux ni l\'audit', !all.includes(KEY) && !all.includes(mock.creds.password) && !aud.includes(KEY));
    const res429 = [];
    for (let i = 0; i < 60; i++) res429.push((await fetch(HOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    check('limitation de débit du webhook : 429 au-delà du seuil', res429.includes(429), res429.slice(-5));
  } finally {
    srv.close(); await mock.close(); fakeMail.close(); await pgt.stop().catch(() => {});
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
