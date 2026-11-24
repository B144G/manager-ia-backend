'use strict';
// Paiement manuel de secours (« Mobile Money direct, confirmé par l'administrateur ») : même table de transactions, mêmes reçus, même activation que Campay.
// Création, code unique, anti-rejeu, tentatives limitées, expiration, confirmation / refus par l'administrateur seul, prolongation sans perte de jours,
// isolation entre clients, numéros masqués dans les journaux, activation par variable. Lancez : npm run test:paymanual
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
const logs = [];
for (const k of ['log', 'info', 'warn', 'error']) { const o = console[k].bind(console); console[k] = (...a) => { logs.push(a.map(String).join(' ')); o(...a); }; }

async function main() {
  const pgt = await startTestPg();
  const mails = [];
  const mport = await freePort();
  const fakeMail = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { mails.push(JSON.parse(b || '{}')); res.statusCode = 201; res.end('{"messageId":"x"}'); }); });
  await new Promise((ok) => fakeMail.listen(mport, '127.0.0.1', ok));
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'CAMPAY_APP_USERNAME', 'CAMPAY_APP_PASSWORD', 'CAMPAY_APP_TOKEN', 'CAMPAY_WEBHOOK_KEY', 'MTN_NUMBER', 'ORANGE_NUMBER', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0',
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', ADMIN_EMAIL: 'fondateur@exemple.com', BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: `http://127.0.0.1:${mport}/v3`, SMTP_FROM: 'MABAH <contact@exemple.com>',
    MANUAL_PAY_MTN_NUMBER: '670000001', MANUAL_PAY_ORANGE_NUMBER: '690000002', MANUAL_PAY_ACCOUNT_NAME: 'Société Test SARL', MANUAL_PAY_MAX_ATTEMPTS: '3', PAYMENTS_INIT_RATE: '500' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const config = require('../src/config');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const PASS = 'Cacao-Mangue-42';
  let seq = 0;
  const reg = async (name) => { const c = client(base); const contact = `manuel${++seq}.${Date.now()}@exemple.com`; const r = await c('POST', '/api/register', { name, contact, pass: PASS, interests: [] }); return { c, id: r.json && r.json.user && r.json.user.id, contact, status: r.status }; };
  const rowOf = (ref) => db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);
  const userOf = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const days = (iso) => (Date.parse(iso) - Date.now()) / 86400000;
  const price = config.plans.unl_month.priceXAF;
  try {
    const adm = client(base);
    await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });

    console.log('1. Disponibilité (variables)');
    let r = await client(base)('GET', '/api/plans');
    check('numéros configurés et Campay absent : paiement manuel proposé avec les numéros', r.json.manualAvailable === true && r.json.manual.mtn === '670000001' && r.json.manual.orange === '690000002' && r.json.manual.holder === 'Société Test SARL', r.json);
    const save = { ...config.payment }; const flag = config.manualPay.flag; const campayOn = config.campay.enabled;
    config.payment.mtn = ''; config.payment.orange = '';
    check('sans numéros configurés : jamais proposé', config.manualPay.available() === false && (await client(base)('GET', '/api/plans')).json.manual === null);
    Object.assign(config.payment, save);
    config.campay.enabled = true;
    check('Campay actif et MANUAL_PAY_ENABLED absent : manuel non proposé', config.manualPay.available() === false);
    config.manualPay.flag = '1';
    check('Campay actif et MANUAL_PAY_ENABLED=1 : manuel proposé en alternative', config.manualPay.available() === true);
    config.manualPay.flag = '0'; config.campay.enabled = false;
    check('MANUAL_PAY_ENABLED=0 : désactivé', config.manualPay.available() === false);
    r = await (await (async () => { const U0 = await reg('Zed Désactivé'); return U0.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn' }); })());
    check('désactivé : la création est refusée', r.status === 400, r.json);
    config.manualPay.flag = flag; config.campay.enabled = campayOn;

    console.log('2. Création de la commande');
    const U = await reg('Awa Manuel');
    r = await U.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn', amount: 5, priceXAF: 5 });
    check('commande « en attente » avec code MABAH-NNNNNN, montant du catalogue (le prix du client est ignoré)', r.status === 200 && /^MABAH-\d{6}$/.test(r.json.reference) && r.json.mode === 'manual' && r.json.status === 'pending' && r.json.amountXAF === price, r.json);
    check('l\'écran reçoit les numéros de réception, le nom du compte et le montant', r.json.payTo.mtn === '670000001' && r.json.payTo.orange === '690000002' && r.json.payTo.holder === 'Société Test SARL' && /670000001/.test(r.json.instructions));
    const ref = r.json.reference;
    const again = await U.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn' });
    check('double clic : même commande, pas de doublon', again.json.reference === ref && Number((await db.prepare('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?').get(U.id)).n) === 1);
    const codes = new Set();
    for (let i = 0; i < 12; i++) { const X = await U.c('POST', '/api/payments/initiate', { plan: 'unl_week', operator: 'orange' }); codes.add(X.json.reference); await db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ?").run(X.json.reference); }
    check('codes distincts (12 commandes, 12 codes)', codes.size === 12, [...codes].slice(0, 3));
    let p = await rowOf(ref);
    check('même table que Campay : XAF, expiration, mode manuel', p.currency === 'XAF' && p.mode === 'manual' && p.expires_at && days(p.expires_at) > 1.9);

    console.log('3. Soumission de l\'identifiant (« J\'ai payé »)');
    r = await U.c('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'MP261118.1234.A111' });
    check('nom du payeur obligatoire', r.status === 400);
    r = await U.c('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'ab', payerName: 'Awa M' });
    check('identifiant trop court refusé', r.status === 400);
    r = await U.c('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'MP261118.1234.A111', payerName: 'Awa Mballa' });
    check('commande passée « à vérifier »', r.status === 200 && r.json.status === 'awaiting_validation', r.json);
    p = await rowOf(ref);
    check('identifiant, nom du payeur et date enregistrés', p.transaction_id === 'MP261118.1234.A111' && p.payer_name === 'Awa Mballa' && p.submitted_at && p.attempts === 1);
    await sleep(400);
    check('alerte e-mail à l\'administrateur (notify)', mails.some((m) => m.to[0].email === 'fondateur@exemple.com' && /Paiement à valider/.test(m.subject)), mails.map((m) => m.subject));
    const n1 = mails.length;
    r = await U.c('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'MP261118.1234.A111', payerName: 'Awa Mballa' });
    await sleep(200);
    check('même soumission répétée (double clic) : pas de seconde alerte', r.json.already === true && mails.length === n1);

    console.log('4. Anti-rejeu, tentatives, isolation');
    const V = await reg('Binta Autre');
    const vr = await V.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'orange' });
    r = await V.c('POST', '/api/payments/confirm-manual', { reference: vr.json.reference, transactionId: 'mp261118.1234.a111', payerName: 'Binta' });
    check('même identifiant de transaction sur une autre commande (même en minuscules) : refusé', r.status === 409 && /déjà été utilisé/.test(r.json.error), r.json);
    check('rejeu journalisé', Number((await db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'payment.manual_replay'").get()).n) === 1);
    r = await V.c('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'XX-999999', payerName: 'Binta' });
    check('isolation : un autre client ne peut pas soumettre sur la commande d\'autrui (404)', r.status === 404);
    r = await V.c('GET', `/api/payments/${ref}`);
    check('isolation : ni la consulter (404)', r.status === 404);
    r = await V.c('GET', `/api/payments/${ref}/receipt`);
    check('isolation : ni son reçu', r.status === 404);
    const att = [];
    for (let i = 0; i < 4; i++) att.push((await V.c('POST', '/api/payments/confirm-manual', { reference: vr.json.reference, transactionId: 'ESSAI-00' + i, payerName: 'Binta' })).status);
    check('tentatives limitées par commande (3 puis 429)', att[0] === 200 && att[2] === 200 && att[3] === 429, att);

    console.log('5. Droits : seul l\'administrateur confirme');
    const pid = p.id;
    r = await U.c('POST', `/api/admin/payments/${pid}/validate`, {});
    check('un client ne peut pas confirmer (401)', r.status === 401);
    r = await client(base)('POST', `/api/admin/payments/${pid}/validate`, {});
    check('un visiteur non plus (401)', r.status === 401);
    r = await adm('GET', '/api/admin/payments?status=awaiting_validation');
    const row = r.json.payments.find((x) => x.reference === ref);
    check('file « à vérifier » : client, plan, montant, code, identifiant, payeur, date', row && row.user.name === 'Awa Manuel' && row.amountXAF === price && row.transactionId === 'MP261118.1234.A111' && row.payerName === 'Awa Mballa' && row.submittedAt, row);

    console.log('6. Confirmation : activation, prolongation, reçu');
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 10 * 86400000).toISOString(), U.id);
    r = await adm('POST', `/api/admin/payments/${pid}/validate`, {});
    check('confirmation par l\'administrateur', r.status === 200 && r.json.status === 'paid', r.json);
    const u = await userOf(U.id);
    check('10 jours restants + 30 jours = 40 jours (aucun jour perdu)', u.plan === 'Illimité' && Math.abs(days(u.plan_expires) - 40) < 0.01, days(u.plan_expires));
    p = await rowOf(ref);
    check('qui a confirmé est enregistré', p.decided_by === 'admin-test' && p.paid_via === 'admin');
    check('audit : confirmation journalisée avec l\'administrateur', Number((await db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'payment.manual_confirmed' AND target = ? AND actor_type = 'admin' AND detail LIKE '%admin-test%'").get(ref)).n) === 1);
    r = await U.c('GET', `/api/payments/${ref}/receipt`);
    check('reçu numéroté disponible', r.status === 200 && /^R-\d{4}-\d{5}$/.test(r.json.receipt.number) && r.json.receipt.amountXAF === price);
    await sleep(500);
    check('e-mail de confirmation avec reçu', mails.some((m) => m.to[0].email === U.contact && /active/.test(m.subject) && m.attachment));
    r = await adm('POST', `/api/admin/payments/${pid}/validate`, {});
    check('seconde confirmation refusée, durée non doublée', r.status === 409 && Math.abs(days((await userOf(U.id)).plan_expires) - 40) < 0.01);

    console.log('7. Refus avec motif, nouvelle tentative');
    const W = await reg('Cheikh Refus');
    const wr = await W.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn' });
    await W.c('POST', '/api/payments/confirm-manual', { reference: wr.json.reference, transactionId: 'FAUX-ID-0001', payerName: 'Cheikh' });
    const wp = await rowOf(wr.json.reference);
    r = await adm('POST', `/api/admin/payments/${wp.id}/reject`, {});
    check('refus sans motif impossible', r.status === 400);
    r = await adm('POST', `/api/admin/payments/${wp.id}/reject`, { reason: 'SMS introuvable chez l\'opérateur' });
    check('refus avec motif', r.status === 200 && (await rowOf(wr.json.reference)).status === 'failed' && (await rowOf(wr.json.reference)).decided_by === 'admin-test');
    check('le client est prévenu (notice avec le motif)', Number((await db.prepare("SELECT COUNT(*) AS n FROM user_notices WHERE user_id = ? AND kind = 'payment_rejected'").get(W.id)).n) === 1);
    check('audit : refus journalisé', Number((await db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'payment.manual_rejected' AND target = ?").get(wr.json.reference)).n) === 1);
    r = await W.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn' });
    check('nouvelle tentative possible après un refus (nouvelle commande, nouveau code)', r.status === 200 && r.json.reference !== wr.json.reference);
    r = await W.c('POST', '/api/payments/confirm-manual', { reference: r.json.reference, transactionId: 'FAUX-ID-0001', payerName: 'Cheikh' });
    check('l\'identifiant refusé ne peut pas être réutilisé', r.status === 409);
    r = await adm('POST', `/api/admin/payments/${wp.id}/reject`, { reason: 'encore' });
    check('on ne refuse pas deux fois', r.status === 409);

    console.log('8. Expiration des commandes non soumises');
    const X = await reg('Dieu Expire');
    const xr = await X.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn' });
    await db.prepare('UPDATE payments SET expires_at = ? WHERE reference = ?').run(new Date(Date.now() - 1000).toISOString(), xr.json.reference);
    r = await X.c('POST', '/api/payments/confirm-manual', { reference: xr.json.reference, transactionId: 'TARDIF-0001', payerName: 'Dieu' });
    check('soumission tardive refusée', r.status === 409 && /expiré/.test(r.json.error));
    await require('../src/jobs').runOnce();
    check('la tâche automatique passe la commande à « expiré »', (await rowOf(xr.json.reference)).status === 'expired');
    check('une commande déjà soumise n\'expire pas', (await rowOf(vr.json.reference)).status === 'awaiting_validation');

    console.log('9. Confidentialité');
    r = await X.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn', phone: '677123456' });
    const pr = await rowOf(r.json.reference);
    check('numéro du payeur (facultatif) masqué en base', !/677123456/.test(pr.phone) && /456$/.test(pr.phone), pr.phone);
    const all = logs.join('\n') + (await db.prepare('SELECT detail FROM audit_trail').all()).map((x) => x.detail).join('\n') + mails.map((m) => m.subject + (m.textContent || '')).join('\n');
    check('aucun numéro complet dans les journaux, l\'audit et les e-mails', !/677123456/.test(all));
    check('numéros de réception de l\'entreprise jamais dans les journaux', !logs.join('\n').includes('670000001'));
  } finally {
    srv.close(); fakeMail.close(); await pgt.stop().catch(() => {});
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
