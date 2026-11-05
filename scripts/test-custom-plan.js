'use strict';
// Forfait sur mesure : une somme + une durée (semaine, mois, an) -> des capacités ; paiement, activation, limites réellement appliquées, règles de changement d'offre.
// Lancez-le avec : node scripts/test-custom-plan.js
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
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
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', MTN_NUMBER: '670000000' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const C = require('../src/services/custom-plan');
  const A = require('../src/workspace/access');
  const F = require('../src/workspace/features');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const web = client(base);
  try {
    console.log('Calcul du forfait');
    let q = C.quote(10000, 'month');
    check('10 000 FCFA / mois = le forfait minimum', q.limits.aiMonth === 200 && q.limits.members === 5 && q.limits.orgs === 1 && q.equivalentMonth === 10000, q);
    q = C.quote(15000, 'month');
    check('15 000 FCFA / mois : plus que le minimum, moins que Pro', q.limits.aiMonth > 200 && q.limits.aiMonth < 1000 && q.limits.members > 5 && q.limits.members < 15, q.limits);
    check('50 000 FCFA / mois = les capacités de Pro', JSON.stringify(C.quote(50000, 'month').limits) === JSON.stringify({ orgs: 3, members: 15, branches: 5, aiMonth: 1000, emailDay: 50 }), C.quote(50000, 'month').limits);
    check('150 000 FCFA / mois = Illimité', C.quote(150000, 'month').limits.aiMonth === 6000 && C.quote(150000, 'month').limits.members === 9999);
    const ai = [10000, 15000, 20000, 30000, 40000, 50000, 75000, 100000, 150000].map((a) => C.quote(a, 'month').limits.aiMonth);
    check('plus la somme est haute, plus le quota IA est grand (jamais à la baisse)', ai.every((v, i) => i === 0 || v >= ai[i - 1]), ai);
    check('une semaine : minimum 2 500 FCFA (10 000 / mois ramené à 7 jours)', C.quote(2500, 'week').days === 7 && C.quote(2500, 'week').limits.aiMonth <= 100);
    const wk = C.quote(10000, 'week');
    check('une semaine : le quota IA est celui de la semaine (7/30 du quota mensuel du palier)', wk.limits.aiMonth < C.capacityAt(wk.equivalentMonth).aiMonth && wk.limits.aiMonth >= 20, [wk.limits.aiMonth, C.capacityAt(wk.equivalentMonth).aiMonth]);
    check('un an : minimum 120 000 FCFA, 365 jours, quota mensuel du forfait minimum', C.quote(120000, 'year').days === 365 && C.quote(120000, 'year').limits.aiMonth === 200 && C.quote(120000, 'year').equivalentMonth === 10000);
    for (const [a, p, why] of [[9500, 'month', 'sous le minimum'], [10250, 'month', 'pas un multiple de 500'], [200000, 'month', 'au-delà du forfait illimité'], [1500, 'week', 'sous le minimum (semaine)'], [100000, 'year', 'sous le minimum (an)'], [10000, 'jour', 'durée inconnue'], ['abc', 'month', 'pas un nombre'], [-5000, 'month', 'négative']]) {
      let err = null; try { C.quote(a, p); } catch (e) { err = e; }
      check('refusé : ' + why, err && err.status === 400 && err.message.length > 10, err && err.message);
    }
    check('niveau de fonctions : au moins « Pro » (même à 10 000), Pro Max à 75 000, Illimité à 150 000', C.quote(10000, 'month').rank === 1 && C.quote(75000, 'month').rank === 2 && C.quote(150000, 'month').rank === 4);
    check('nom lisible', C.label('Sur mesure|15000|7') === 'Sur mesure (15 000 FCFA / semaine)' && C.label('Pro') === 'Pro');
    check('un nom falsifié n\'est pas reconnu', C.parse('Sur mesure|999999999999|7') === null && C.parse('Sur mesure|15000|9') === null && C.parse('Pro') === null);

    console.log('API publique');
    let r = await web('GET', '/api/plans/custom/quote?amount=15000&period=month');
    check('aperçu public', r.status === 200 && r.json.quote.limits.aiMonth === C.quote(15000, 'month').limits.aiMonth, r.json);
    r = await web('GET', '/api/plans/custom/quote?amount=5000&period=month');
    check('aperçu refusé sous le minimum, avec un message clair', r.status === 400 && /minimum/.test(r.json.error), r.json);
    r = await web('GET', '/api/plans');
    check('/plans publie les durées et les minimums', r.json.custom && r.json.custom.periods.length === 3 && r.json.custom.periods.find((x) => x.id === 'month').min === 10000, r.json.custom);

    console.log('Paiement et activation');
    const mail = 'client-' + Date.now() + '@exemple.com';
    r = await web('POST', '/api/register', { name: 'Awa Sur Mesure', contact: mail, pass: 'Essai-2026-brij-x' });
    check('inscription', r.status === 201 || r.status === 200, r.status);
    r = await web('POST', '/api/payments/initiate', { custom: { amount: 5000, period: 'month' }, operator: 'mtn', phone: '670000010' });
    check('paiement refusé sous le minimum', r.status === 400, r.json);
    r = await web('POST', '/api/payments/initiate', { custom: { amount: 15000, period: 'week' }, operator: 'mtn', phone: '670000010' });
    check('paiement d\'un forfait sur mesure (15 000 FCFA, une semaine) démarré, montant fixé par le serveur', r.status === 200 && r.json.amountXAF === 15000 && /15 000 FCFA|15000 FCFA/.test(r.json.instructions) && /semaine/.test(r.json.instructions), r.json);
    const ref = r.json.reference;
    const row = await db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);
    check('le paiement enregistre la somme et la durée', row && Number(row.amount_xaf) === 15000 && row.plan === 'Sur mesure|15000|7', row);
    r = await web('POST', '/api/payments/initiate', { custom: { amount: 1000, period: 'week' }, plan: 'inconnu', operator: 'mtn', phone: '670000010' });
    check('une somme falsifiée est refusée par le serveur', r.status === 400, r.json);
    await web('POST', '/api/payments/confirm-manual', { reference: ref, transactionId: 'MP240101.1234.A56789' });
    const adm = client(base);
    await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    r = await adm('GET', '/api/admin/payments?status=awaiting_validation');
    const pay = (r.json.payments || r.json.items || []).find((p) => p.reference === ref);
    check('l\'administrateur voit « Sur mesure (15 000 FCFA / semaine) »', pay && /Sur mesure \(15 000 FCFA \/ semaine\)/.test(JSON.stringify(pay)), pay);
    r = await adm('POST', '/api/admin/payments/' + row.id + '/validate', {});
    check('validation du paiement', r.status === 200 && r.json.status === 'paid', r.json);
    const u = await db.prepare('SELECT * FROM users WHERE contact = ?').get(mail);
    const days = (Date.parse(u.plan_expires) - Date.now()) / 86400000;
    check('l\'offre est activée pour 7 jours', u.plan === 'Sur mesure|15000|7' && days > 6.9 && days < 7.1, [u.plan, days]);
    const lim = A.limitsFor(u.plan);
    check('les limites réellement appliquées sont celles du forfait', JSON.stringify(lim) === JSON.stringify(C.quote(15000, 'week').limits), lim);
    check('niveau de fonctions Pro ou plus', F.rank(u.plan) >= 1 && F.allowed(u.plan, 'assistant'), F.rank(u.plan));
    r = await web('GET', '/api/billing');
    check('la page Abonnement affiche le forfait et ses limites', r.status === 200 && r.json.planLabel === 'Sur mesure (15 000 FCFA / semaine)' && r.json.currentLimits.aiMonth === lim.aiMonth, [r.json.planLabel, r.json.currentLimits]);
    check('l\'historique parle en clair', r.json.history.some((h) => h.plan === 'Sur mesure (15 000 FCFA / semaine)' && h.status === 'paid'), r.json.history);
    const org = await web('POST', '/api/ws/orgs', { name: 'Atelier Sur Mesure', sector: 'Menuiserie' });
    check('une organisation peut être créée avec ce forfait', org.status === 201 || org.status === 200, org.json);

    console.log('Règles de changement');
    r = await web('POST', '/api/payments/initiate', { custom: { amount: 30000, period: 'month' }, operator: 'mtn', phone: '670000010' });
    check('un autre forfait est refusé tant que celui-ci est actif (message clair)', r.status === 409 && /Sur mesure \(15 000 FCFA \/ semaine\)/.test(r.json.error), r.json);
    r = await web('POST', '/api/payments/initiate', { plan: 'pro', operator: 'mtn', phone: '670000010' });
    check('une offre habituelle aussi', r.status === 409, r.status);
    r = await web('POST', '/api/payments/initiate', { custom: { amount: 15000, period: 'week' }, operator: 'mtn', phone: '670000010' });
    check('le même forfait peut être renouvelé à tout moment', r.status === 200, r.json);
    const r2 = await db.prepare('SELECT id FROM payments WHERE reference = ?').get(r.json.reference);
    const before = Date.parse((await db.prepare('SELECT plan_expires FROM users WHERE id = ?').get(u.id)).plan_expires);
    await adm('POST', '/api/admin/payments/' + r2.id + '/validate', {});
    const after = Date.parse((await db.prepare('SELECT plan_expires FROM users WHERE id = ?').get(u.id)).plan_expires);
    check('le renouvellement prolonge de 7 jours à partir de l\'échéance', Math.abs((after - before) / 86400000 - 7) < 0.1, (after - before) / 86400000);

    console.log('Quota IA d\'une semaine');
    const W = await db.prepare('SELECT * FROM orgs WHERE owner_id = ? LIMIT 1').get(u.id);
    const win = await A.quotaWindow(W);
    const span = (Date.parse(win.end) - Date.parse(win.start)) / 86400000;
    check('la période du quota est de 7 jours (pas 30)', Math.abs(span - 7) < 0.01, span);
    await db.prepare("UPDATE users SET plan_expires = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), u.id);
    const fresh = await require('../src/db').getUserFresh(u.id);
    check('à l\'échéance, retour à Gratuit', fresh.plan === 'Gratuit', fresh.plan);
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close();
  process.exit(failed ? 1 : 0);
}
main();
