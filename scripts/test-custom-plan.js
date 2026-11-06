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
    const P5 = ['week', 'month', 'quarter', 'semester', 'year'];
    const cap = (a, p) => C.quote(a, p).limits;
    // La règle voulue : pour la MÊME somme, plus la durée est courte, plus le forfait est élevé, sur chaque capacité.
    for (const amount of [10000, 20000, 35000]) {
      const rows = P5.map((p) => ({ p, c: cap(amount, p), d: C.quote(amount, p).aiPerDay, rank: C.quote(amount, p).rank }));
      for (const k of ['members', 'orgs', 'branches', 'emailDay']) check(`${amount} FCFA : « ${k} » ne monte jamais quand la durée s'allonge`, rows.every((r, i) => i === 0 || r.c[k] <= rows[i - 1].c[k]), rows.map((r) => r.c[k]));
      check(`${amount} FCFA : messages IA par jour décroissants (semaine > mois > trimestre > semestre > an)`, rows.every((r, i) => i === 0 || r.d <= rows[i - 1].d) && rows[0].d > rows[1].d, rows.map((r) => r.d));
      check(`${amount} FCFA : le niveau de fonctions ne monte jamais avec la durée`, rows.every((r, i) => i === 0 || r.rank <= rows[i - 1].rank), rows.map((r) => r.rank));
    }
    let q = C.quote(10000, 'week');
    check('10 000 FCFA pour 7 jours : nettement plus que pour 1 mois (plus de personnes, d\'antennes, d\'e-mails)', q.limits.members > cap(10000, 'month').members && q.limits.branches > cap(10000, 'month').branches && q.limits.emailDay > cap(10000, 'month').emailDay, [q.limits, cap(10000, 'month')]);
    q = C.quote(10000, 'month');
    check('10 000 FCFA / mois : 300 messages IA, 5 personnes, 1 organisation', q.limits.aiMonth === 300 && q.limits.members === 5 && q.limits.orgs === 1 && q.level === 10000, q);
    check('10 000 FCFA / an : ne descend jamais sous le niveau de l\'offre Gratuite', cap(10000, 'year').members >= 3 && cap(10000, 'year').aiMonth >= 40 && cap(10000, 'year').emailDay >= 5, cap(10000, 'year'));
    check('l\'offre Illimité de chaque durée donne tout (au prix de la durée)', P5.every((p) => { const m = C.info().periods.find((x) => x.id === p).max; const l = cap(m, p); return l.members === 9999 && l.orgs === 999 && C.quote(m, p).rank === 4; }));
    check('prix Illimité : semaine 40 000, mois 150 000, trimestre 420 000, semestre 800 000, an 1 500 000', JSON.stringify(C.info().periods.map((x) => x.unlimited)) === JSON.stringify([40000, 150000, 420000, 800000, 1500000]), C.info().periods.map((x) => x.unlimited));
    check('le prix par mois baisse avec la durée (150 000, 140 000, 133 333, 125 000)', (150000 > 420000 / 3) && (420000 / 3 > 800000 / 6) && (800000 / 6 > 1500000 / 12));
    check('50 000 FCFA / mois : capacités de Pro avec 50 % de messages IA en plus', C.quote(50000, 'month').limits.aiMonth === 1500 && C.quote(50000, 'month').limits.members === 15 && C.quote(50000, 'month').limits.orgs === 3);
    const ai = [10000, 15000, 20000, 30000, 40000, 50000, 75000, 100000, 150000].map((a) => cap(a, 'month').aiMonth);
    check('plus la somme est haute, plus le quota IA est grand (jamais à la baisse)', ai.every((v, i) => i === 0 || v >= ai[i - 1]), ai);
    const wk = C.quote(10000, 'week');
    check('une semaine : le quota IA est celui de la semaine (proportionnel au mois)', wk.limits.aiMonth < C.capacityAt(wk.level).aiMonth && wk.limits.aiMonth >= 20, [wk.limits.aiMonth, C.capacityAt(wk.level).aiMonth]);
    for (const [a, p, why] of [[9500, 'month', 'sous le minimum (10 000, toutes durées)'], [9500, 'year', 'sous le minimum, un an'], [10250, 'month', 'pas un multiple de 500'], [200000, 'month', 'au-delà du prix Illimité du mois'], [50000, 'week', 'au-delà du prix Illimité de la semaine (40 000)'], [10000, 'jour', 'durée inconnue'], ['abc', 'month', 'pas un nombre'], [-5000, 'month', 'négative']]) {
      let err = null; try { C.quote(a, p); } catch (e) { err = e; }
      check('refusé : ' + why, err && err.status === 400 && err.message.length > 10, err && err.message);
    }
    check('10 000 FCFA est accepté pour toutes les durées', P5.every((p) => { try { C.quote(10000, p); return true; } catch { return false; } }));
    check('accès : le forfait minimum ouvre les fonctions Pro, pas Pro Max ; Illimité ouvre tout', (() => { const f = (a, p) => Object.fromEntries(C.quote(a, p).features.map((x) => [x.key, x.included])); return f(10000, 'month').assistant === true && f(10000, 'month').followups === true && f(10000, 'month').handoff === false && f(75000, 'month').handoff === true && f(75000, 'month').multisite === false && Object.values(f(150000, 'month')).every(Boolean) && f(10000, 'year').assistant === true && f(10000, 'year').followups === false; })());
    check('nom lisible', C.label('Sur mesure|15000|7') === 'Sur mesure (15 000 FCFA / semaine)' && C.label('Sur mesure|60000|183') === 'Sur mesure (60 000 FCFA / semestre)' && C.label('Pro') === 'Pro');
    check('un nom falsifié n\'est pas reconnu', C.parse('Sur mesure|999999999999|7') === null && C.parse('Sur mesure|15000|9') === null && C.parse('Pro') === null);

    console.log('API publique');
    let r = await web('GET', '/api/plans/custom/quote?amount=15000&period=month');
    check('aperçu public', r.status === 200 && r.json.quote.limits.aiMonth === C.quote(15000, 'month').limits.aiMonth, r.json);
    r = await web('GET', '/api/plans/custom/quote?amount=5000&period=month');
    check('aperçu refusé sous le minimum, avec un message clair', r.status === 400 && /minimum/.test(r.json.error), r.json);
    r = await web('GET', '/api/plans');
    check('/plans publie les 5 durées, le minimum et le prix Illimité de chaque durée', r.json.custom && r.json.custom.periods.length === 5 && r.json.custom.periods.every((x) => x.min === 10000) && r.json.custom.periods.find((x) => x.id === 'quarter').unlimited === 420000 && r.json.plans.length === 5, r.json.custom);

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
    r = await web('POST', '/api/payments/initiate', { plan: 'unl_month', operator: 'mtn', phone: '670000010' });
    check('l\'offre Illimité aussi (un forfait sur mesure est une autre offre)', r.status === 409, r.status);
    r = await web('POST', '/api/payments/initiate', { plan: 'pro', operator: 'mtn', phone: '670000010' });
    check('les anciennes offres ne se vendent plus', r.status === 400, r.status);
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

    console.log('Offres Illimité par durée');
    for (const [id, days, price] of [['unl_week', 7, 40000], ['unl_quarter', 91, 420000], ['unl_year', 365, 1500000]]) {
      r = await web('POST', '/api/payments/initiate', { plan: id, operator: 'mtn', phone: '670000010' });
      check(`Illimité (${id}) : montant fixé à ${price} FCFA`, r.status === 200 && r.json.amountXAF === price, r.json);
      const pr = await db.prepare('SELECT id FROM payments WHERE reference = ?').get(r.json.reference);
      await adm('POST', '/api/admin/payments/' + pr.id + '/validate', {});
      const uu = await db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
      const d = (Date.parse(uu.plan_expires) - Date.now()) / 86400000;
      check(`Illimité (${id}) : activé pour ${days} jours, limites Illimité, quota IA propre à la durée`, uu.plan === C.illimiteName(id) && C.label(uu.plan).startsWith('Illimité') && Math.abs(d - days) < 0.1 && A.limitsFor(uu.plan).members === 9999 && A.limitsFor(uu.plan).aiMonth === C.quote(price, id.replace('unl_', '')).limits.aiMonth, [uu.plan, d, A.limitsFor(uu.plan).aiMonth]);
      await db.prepare("UPDATE users SET plan = 'Gratuit', plan_expires = NULL WHERE id = ?").run(u.id);
    }
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close();
  process.exit(failed ? 1 : 0);
}
main();
