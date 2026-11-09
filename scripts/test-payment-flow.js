'use strict';
// Parcours de paiement de bout en bout : inscription -> choix d'une offre -> paiement avec ID de transaction -> l'administrateur voit la notification (page admin + e-mail)
// -> validation (ou refus avec motif) -> l'utilisateur reçoit sa notice dans l'application (et un e-mail s'il en a un) -> l'offre est activée avec ses quotas.
// Les e-mails partent vers un FAUX serveur local (aucun envoi réel). Lancez : npm run test:payflow
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
  // Faux service d'e-mail (Brevo) : on garde tout ce qui "part".
  const mails = [];
  const mport = await freePort();
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { mails.push(JSON.parse(b || '{}')); res.statusCode = 201; res.end('{"messageId":"x"}'); }); });
  await new Promise((ok) => fake.listen(mport, '127.0.0.1', ok));
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0',
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', MTN_NUMBER: '670000000', ADMIN_EMAIL: 'fondateur@exemple.com',
    BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: `http://127.0.0.1:${mport}/v3`, SMTP_FROM: 'Brij-IA <contact@exemple.com>' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const C = require('../src/services/custom-plan');
  const A = require('../src/workspace/access');
  const config = require('../src/config');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const PASS = 'Cacao-Mangue-42';
  const mailsTo = (addr) => mails.filter((m) => m.to && m.to[0] && m.to[0].email === addr);
  const reg = async (name, contact) => { const c = client(base); const r = await c('POST', '/api/register', { name, contact, pass: PASS, interests: [] }); return { c, id: r.json && r.json.user && r.json.user.id, status: r.status }; };
  try {
    const adm = client(base);
    const anon = client(base);
    await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });

    console.log('1. Inscription et choix d\'une offre (forfait sur mesure, utilisateur avec e-mail)');
    const A1 = await reg('Awa Client', 'awa.client@exemple.com');
    check('inscription réussie', A1.status === 201 && A1.id, A1.status);
    let r = await A1.c('POST', '/api/payments/initiate', { custom: { amount: 20000, period: 'month' }, operator: 'mtn', phone: '670000010' });
    check('paiement lancé en mode manuel avec une référence', r.status === 200 && r.json.mode === 'manual' && /^[A-Z0-9-]{6,}$/i.test(r.json.reference) && r.json.amountXAF === 20000, r.json);
    const ref = r.json.reference;
    r = await A1.c('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'ab' });
    check('ID de transaction trop court refusé', r.status === 400, r.status);
    r = await A1.c('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'MP240101.1234.A56789' });
    check('confirmation avec l\'ID : en attente de validation', r.status === 200 && r.json.status === 'awaiting_validation', r.json);
    r = await A1.c('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'MP240101.1234.A56789' });
    check('double clic : accepté sans refaire de notification', r.status === 200 && r.json.already === true, r.json);
    await sleep(500);

    console.log('2. L\'administrateur est prévenu (page admin + e-mail)');
    const notifs = await db.prepare("SELECT * FROM notifications WHERE type = 'paiement_a_valider'").all();
    check('une seule notification « paiement à valider » malgré le double clic', notifs.length === 1, notifs.length);
    check('la notification contient le client, l\'offre, la durée, le montant, l\'opérateur, l\'ID et la référence', notifs[0] && ['Awa Client', 'awa.client@exemple.com', 'Sur mesure (20 000 FCFA / mois)', '30 jours', '20000', 'mtn', 'MP240101.1234.A56789', ref].every((x) => notifs[0].text.includes(x)), notifs[0] && notifs[0].text);
    check('canal e-mail utilisé pour la notification', notifs[0] && notifs[0].channels.split(',').includes('email'), notifs[0] && notifs[0].channels);
    const toAdmin = mailsTo('fondateur@exemple.com').filter((m) => /Paiement à valider/.test(m.subject));
    check('un e-mail part vers l\'adresse de l\'administrateur (ADMIN_EMAIL)', toAdmin.length === 1 && toAdmin[0].textContent.includes(ref), toAdmin.map((m) => m.subject));
    r = await anon('GET', '/api/admin/summary');
    check('le résumé de l\'administration est protégé', r.status === 401, r.status);
    r = await adm('GET', '/api/admin/summary');
    check('compteur « paiements à valider » = 1 (pastille du menu)', r.status === 200 && r.json.payments === 1, r.json);
    r = await adm('GET', '/api/admin/overview');
    check('la vue d\'ensemble affiche le paiement à valider', r.json.todo.payments === 1 && r.json.payments.length === 1 && r.json.payments[0].reference === ref, r.json && r.json.todo);
    r = await adm('GET', '/api/admin/notifications');
    check('la notification est visible dans la page admin', r.json.notifications.some((n) => n.type === 'paiement_a_valider' && n.text.includes(ref)));

    console.log('3. Vue Paiements : filtres et détails');
    r = await adm('GET', '/api/admin/payments?status=awaiting_validation');
    const pay = r.json.payments.find((p) => p.reference === ref);
    check('filtre « à valider » : détails complets', pay && pay.operator === 'mtn' && pay.phone === '237670000010' && pay.transactionId === 'MP240101.1234.A56789' && pay.amountXAF === 20000 && pay.durationDays === 30 && pay.created && /Sur mesure/.test(pay.planName), pay);
    check('compteurs par statut', r.json.counts.awaiting_validation === 1 && r.json.counts.paid === 0, r.json.counts);
    r = await adm('GET', '/api/admin/payments?status=paid');
    check('filtre « validés » vide pour l\'instant', r.json.payments.length === 0);
    r = await adm('GET', '/api/admin/payments?q=' + encodeURIComponent('MP240101'));
    check('recherche par ID de transaction', r.json.payments.length === 1);
    r = await adm('GET', '/api/admin/payments?status=bidon');
    check('statut inconnu refusé', r.status === 400);

    console.log('4. Validation par l\'administrateur (double clic protégé)');
    const row = await db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);
    const both = await Promise.all([adm('POST', `/api/admin/payments/${row.id}/validate`, {}), adm('POST', `/api/admin/payments/${row.id}/validate`, {})]);
    const codes = both.map((x) => x.status).sort();
    check('deux validations simultanées : une réussit, l\'autre est refusée', codes[0] === 200 && codes[1] === 409, codes);
    await sleep(500);
    const u1 = await db.prepare('SELECT * FROM users WHERE id = ?').get(A1.id);
    const days = (Date.parse(u1.plan_expires) - Date.now()) / 86400000;
    check('offre activée UNE seule fois (≈ 30 jours, pas 60)', u1.plan === C.nameOf(20000, 30) && days > 29 && days < 31, [u1.plan, days]);
    r = await adm('GET', '/api/admin/summary');
    check('la pastille retombe à 0', r.json.payments === 0, r.json);

    console.log('5. Message à l\'utilisateur (application + e-mail avec reçu)');
    r = await A1.c('GET', '/api/me/notices');
    const n1 = r.json.notices.find((n) => n.kind === 'payment_paid');
    check('notice « paiement validé » non lue dans l\'application', n1 && !n1.read && r.json.unread >= 1 && n1.text.includes(ref) && n1.data.reference === ref && n1.data.until, r.json);
    const m1 = mailsTo('awa.client@exemple.com').find((m) => /est active/.test(m.subject));
    check('e-mail de validation avec le reçu en pièce jointe', m1 && m1.attachment && m1.attachment[0].name.startsWith('recu-R-') && m1.textContent.includes(ref), m1 && m1.subject);
    r = await anon('GET', '/api/me/notices');
    check('les notices exigent d\'être connecté', r.status === 401);
    await A1.c('POST', '/api/me/notices/read', {});
    r = await A1.c('GET', '/api/me/notices');
    check('marquer comme lu : plus aucune notice non lue', r.json.unread === 0 && r.json.notices.every((n) => n.read), r.json.unread);

    console.log('6. Quotas réellement appliqués (forfait sur mesure)');
    r = await A1.c('GET', '/api/billing');
    const want = C.quote(20000, 'month').limits;
    check('« Abonnement » montre l\'offre et ses limites', /Sur mesure \(20 000 FCFA/.test(r.json.planLabel) && r.json.currentLimits.aiMonth === want.aiMonth && r.json.currentLimits.members === want.members && r.json.currentLimits.orgs === want.orgs, [r.json.planLabel, r.json.currentLimits, want]);
    check('le moteur de quotas (access.limitsFor) donne les mêmes limites', JSON.stringify(A.limitsFor(u1.plan)) === JSON.stringify(C.limitsFor(u1.plan)) && A.limitsFor(u1.plan).aiMonth === want.aiMonth);
    check('le quota est supérieur à l\'offre Gratuite', want.aiMonth > A.limitsFor('Gratuit').aiMonth || want.members > A.limitsFor('Gratuit').members, want);
    r = await A1.c('POST', '/api/ws/orgs', { name: 'Boutique Awa' });
    check('l\'utilisateur peut créer son organisation avec l\'offre active', r.status === 201, r.json);

    console.log('7. Utilisateur avec téléphone seulement : offre Illimité (une semaine)');
    const B = await reg('Paul Telephone', '670000021');
    check('inscription par téléphone', B.status === 201 && B.id, B.status);
    r = await B.c('POST', '/api/payments/initiate', { plan: 'unl_week', operator: 'orange', phone: '670000021' });
    const refB = r.json.reference;
    await B.c('POST', '/api/payments/confirm-manual', { reference: refB, transactionId: 'OM-998877' });
    await sleep(300);
    const rowB = await db.prepare('SELECT * FROM payments WHERE reference = ?').get(refB);
    const mailsBefore = mails.length;
    r = await adm('POST', `/api/admin/payments/${rowB.id}/validate`, {});
    await sleep(400);
    check('validation réussie', r.status === 200 && r.json.ok, r.json);
    r = await B.c('GET', '/api/me/notices');
    check('le téléphone seul : notice dans l\'application', r.json.notices.some((n) => n.kind === 'payment_paid' && !n.read), r.json);
    check('aucun e-mail envoyé à un utilisateur sans e-mail', mails.length === mailsBefore || mails.slice(mailsBefore).every((m) => !m.to[0].email.includes('670000021')));
    r = await B.c('GET', '/api/billing');
    check('Illimité : tout est ouvert (membres 9999, organisations 999)', r.json.currentLimits.members === 9999 && r.json.currentLimits.orgs === 999 && r.json.daysLeft >= 6 && r.json.daysLeft <= 7, [r.json.currentLimits, r.json.daysLeft]);

    console.log('8. Refus avec motif (téléphone seulement)');
    const Cc = await reg('Chantal Telephone', '670000031');
    r = await Cc.c('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn', phone: '670000031' });
    const refC = r.json.reference;
    await Cc.c('POST', '/api/payments/confirm-manual', { reference: refC, transactionId: 'FAUX-000111' });
    await sleep(300);
    const rowC = await db.prepare('SELECT * FROM payments WHERE reference = ?').get(refC);
    r = await adm('POST', `/api/admin/payments/${rowC.id}/reject`, {});
    check('refus sans motif impossible', r.status === 400, r.json);
    r = await adm('POST', `/api/admin/payments/${rowC.id}/reject`, { reason: 'ID de transaction introuvable chez MTN' });
    check('refus avec motif', r.status === 200 && r.json.status === 'failed', r.json);
    await sleep(300);
    r = await adm('POST', `/api/admin/payments/${rowC.id}/reject`, { reason: 'encore' });
    check('refuser deux fois : 409', r.status === 409, r.status);
    r = await Cc.c('GET', '/api/me/notices');
    const nr = r.json.notices.find((n) => n.kind === 'payment_rejected');
    check('notice de refus avec le motif dans l\'application', nr && nr.text.includes('ID de transaction introuvable chez MTN') && nr.data.reason.includes('introuvable') && !nr.read, r.json);
    const uC = await db.prepare('SELECT plan FROM users WHERE id = ?').get(Cc.id);
    check('aucune offre activée après un refus', uC.plan === 'Gratuit');
    r = await Cc.c('GET', '/api/billing');
    const hist = r.json.history.find((h) => h.reference === refC);
    check('« Abonnement » affiche le refus et son motif', hist && hist.status === 'failed' && hist.rejectReason.includes('introuvable'), hist);
    r = await Cc.c('POST', '/api/payments/confirm-manual', { reference: refC, transactionId: 'AUTRE-ID-123' });
    check('un paiement refusé ne peut pas être « reconfirmé »', r.status === 409, r.status);
    r = await adm('GET', '/api/admin/payments?status=failed');
    const pf = r.json.payments.find((p) => p.reference === refC);
    check('l\'admin voit le motif et la date de décision', pf && pf.rejectReason.includes('MTN') && pf.decidedAt, pf);

    console.log('9. Refus avec motif (utilisateur avec e-mail)');
    const D = await reg('Denis Email', 'denis.email@exemple.com');
    r = await D.c('POST', '/api/payments/initiate', { plan: 'unl_week', operator: 'orange', phone: '670000041' });
    const refD = r.json.reference;
    await D.c('POST', '/api/payments/confirm-manual', { reference: refD, transactionId: 'OM-445566' });
    await sleep(300);
    const rowD = await db.prepare('SELECT * FROM payments WHERE reference = ?').get(refD);
    await adm('POST', `/api/admin/payments/${rowD.id}/reject`, { reason: 'Montant reçu insuffisant' });
    await sleep(500);
    const md = mailsTo('denis.email@exemple.com').find((m) => /n'a pas pu être validé/.test(m.subject));
    check('e-mail de refus avec le motif', md && md.textContent.includes('Montant reçu insuffisant') && md.textContent.includes(refD), md && md.subject);
    r = await D.c('GET', '/api/me/notices');
    check('et notice dans l\'application', r.json.notices.some((n) => n.kind === 'payment_rejected' && n.text.includes('Montant reçu insuffisant')));

    console.log('10. Chronologie du client (types d\'événements seulement)');
    r = await adm('GET', `/api/admin/clients/${A1.id}`);
    const kinds = r.json.timeline.map((e) => e.kind);
    check('inscription, paiement lancé, envoyé, validé, offre changée, organisation créée', ['inscription', 'paiement_initie', 'paiement_soumis', 'paiement_valide', 'offre_changee', 'organisation_creee'].every((k) => kinds.includes(k)), kinds);
    r = await adm('GET', `/api/admin/clients/${Cc.id}`);
    check('le refus apparaît dans la chronologie', r.json.timeline.some((e) => e.kind === 'paiement_refuse'));
  } finally {
    srv.close(); fake.close(); await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
