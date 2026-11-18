'use strict';
// Production avancée : MPS, MRP, capacités, ordonnancement (étape 1) ; lean, kanban, 5S, TOC, JIT (étape 2) ; Six Sigma, TPM, qualité, analyse intégrée (étape 3).
// Calculs purs vérifiés sans base, puis le vrai serveur (PostgreSQL jetable). Aucun appel externe. Lancez-le : node scripts/test-production-avancee.js
const http = require('http');
const { startTestPg } = require('./lib/testdb');
const Plan = require('../src/workspace/prod-plan-lib');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const near = (a, b, e = 0.02) => Math.abs(a - b) <= e;
const throws = (f) => { try { f(); return false; } catch { return true; } };

function fakeAi() {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: '{}' }] })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
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

function stage1() {
  console.log('MPS : plan directeur');
  const mps = Plan.computeMps(Plan.cleanMps({ periods: 6, products: [{ id: 'a', name: 'Table', onHand: 10, safety: 5, lotSize: 20, forecast: [8, 8, 10, 30, 12, 12], firm: [10, 0, 0, 35, 0, 0] }] })).products[0];
  check('la demande retenue est le plus élevé entre prévision et commandes fermes', mps.demand.join() === '10,8,10,35,12,12', mps.demand);
  check('on produit par lots de 20 pour ne jamais passer sous le stock de sécurité', mps.plan.every((q) => q % 20 === 0) && mps.projected.every((v) => v >= 5), mps);
  check('stock projeté = stock précédent + production − demande', mps.projected[0] === 10 + mps.plan[0] - 10 && mps.projected[1] === mps.projected[0] + mps.plan[1] - 8);
  check('disponible à promettre : négatif quand les commandes fermes dépassent la production', mps.atp[3] < 0 && mps.atp[0] === 10 + mps.plan[0] - 10, mps.atp);
  const lv = Plan.computeMps(Plan.cleanMps({ periods: 4, level: true, products: [{ id: 'a', name: 'T', onHand: 0, safety: 0, maxPerPeriod: 20, forecast: [0, 0, 0, 60] }] })).products[0];
  check('lissage : la production de 60 est étalée sur 3 périodes de 20', lv.plan.join() === '20,20,20,0' || lv.plan.join() === '0,20,20,20', lv.plan);
  check('lissage impossible signalé', Plan.computeMps(Plan.cleanMps({ periods: 2, level: true, products: [{ id: 'a', name: 'T', onHand: 0, safety: 0, maxPerPeriod: 10, forecast: [0, 60] }] })).issues.length > 0);
  check('valeur négative refusée', throws(() => Plan.cleanMps({ products: [{ name: 'x', onHand: -1 }] })));

  console.log('MRP : besoins en matières');
  const doc = Plan.cleanMrp({ periods: 6, items: [
    { code: 'T', name: 'Table', type: 'make', leadTime: 1, onHand: 0, demand: [0, 0, 0, 10, 0, 10], bom: [{ child: 'P', qty: 1 }, { child: 'V', qty: 4 }] },
    { code: 'P', name: 'Plateau', type: 'buy', leadTime: 2, onHand: 5, lotRule: 'fixed', lotSize: 10 },
    { code: 'V', name: 'Vis', type: 'buy', leadTime: 1, onHand: 100, receipts: [0, 0, 0, 0, 0, 0] }] });
  const r = Plan.computeMrp(doc);
  const T = r.items.find((i) => i.code === 'T'); const P = r.items.find((i) => i.code === 'P'); const V = r.items.find((i) => i.code === 'V');
  check('ordre de fabrication de la table lancé un délai avant le besoin (période 3 → 2)', T.plannedReleases[2] === 10 && T.plannedReleases[4] === 10, T);
  check('besoin brut du plateau = ordres de fabrication de la table', P.gross[2] === 10 && P.gross[4] === 10, P.gross);
  check('besoin net du plateau tient compte du stock (5 en stock)', P.net[2] === 5, P.net);
  check('lot fixe de 10 : réception arrondie au lot', P.plannedReceipts[2] === 10, P.plannedReceipts);
  check('ordre d\'achat suggéré, 2 périodes avant', r.orders.some((o) => o.item === 'P' && o.kind === 'purchase' && o.receipt === 2 && o.release === 0), r.orders);
  check('vis : multiplication par la nomenclature (4 par table)', V.gross[2] === 40 && V.gross[4] === 40);
  check('stock des vis couvre le besoin : pas d\'achat', !r.orders.some((o) => o.item === 'V'), V);
  const late = Plan.computeMrp(Plan.cleanMrp({ periods: 3, items: [{ code: 'A', type: 'buy', leadTime: 3, demand: [5, 0, 0] }] }));
  check('ordre déjà en retard détecté (délai plus long que le temps disponible)', late.issues.some((i) => i.code === 'mrpLate'), late.issues);
  const loop = Plan.computeMrp(Plan.cleanMrp({ periods: 3, items: [{ code: 'A', demand: [1, 0, 0], bom: [{ child: 'B', qty: 1 }] }, { code: 'B', bom: [{ child: 'A', qty: 1 }] }] }));
  check('nomenclature circulaire détectée', loop.issues.some((i) => i.code === 'mrpLoop'), loop.issues);
  check('composant inconnu signalé', Plan.computeMrp(Plan.cleanMrp({ periods: 2, items: [{ code: 'A', bom: [{ child: 'Z', qty: 1 }] }] })).issues.some((i) => i.code === 'mrpMissing'));
  const fromMps = Plan.computeMrp(Plan.cleanMrp({ periods: 4, useMps: true, items: [{ code: 'a', type: 'make' }] }), { a: [0, 5, 0, 5] });
  check('le plan directeur alimente la demande du MRP', fromMps.items[0].gross.join() === '0,5,0,5');

  console.log('Capacités');
  const cap = Plan.computeCapacity(Plan.cleanCapacity({ periods: 4, centers: [{ name: 'Menuiserie', hours: 40 }, { name: 'Peinture', hours: 100 }], routings: [{ product: 'Table', ops: [{ center: 'Menuiserie', hoursPerUnit: 1.5, setup: 2 }, { center: 'Peinture', hoursPerUnit: 0.5, setup: 0 }] }], useMps: false, manual: [{ product: 'Table', qty: [20, 10, 30, 0] }] }));
  const M = cap.centers[0];
  check('charge = quantité × heures + réglage (20 tables : 32 h)', M.load[0] === 32 && M.load[2] === 47 && M.load[3] === 0, M.load);
  check('surcharge détectée en période 3 (47 h pour 40 h)', M.overloads.length === 1 && M.overloads[0].period === 2 && M.overloads[0].excess === 7, M.overloads);
  check('solutions : heures supplémentaires (jusqu\'à 20 %), décalage', M.overloads[0].solutions.some((s) => s.id === 'overtime' && s.hours === 7) && M.overloads[0].solutions.some((s) => s.id === 'shift'), M.overloads[0]);
  check('lissage : la surcharge est avancée sur la période précédente', M.leveled[2] <= 40 && M.leveledStuck === 0, M.leveled);
  check('le poste le plus chargé est identifié', cap.bottleneck === 'Menuiserie');
  const big = Plan.computeCapacity(Plan.cleanCapacity({ periods: 2, centers: [{ name: 'M', hours: 10 }], routings: [{ product: 'T', ops: [{ center: 'M', hoursPerUnit: 1 }] }], useMps: false, manual: [{ product: 'T', qty: [0, 30] }], overtimeMaxPct: 20 })).centers[0].overloads[0];
  check('grosse surcharge : heures supplémentaires plafonnées, le reste en sous-traitance', big.solutions.find((s) => s.id === 'overtime').hours === 2 && big.solutions.find((s) => s.id === 'subcontract').hours === 18, big);
  check('poste inconnu dans une gamme signalé', Plan.computeCapacity(Plan.cleanCapacity({ periods: 2, centers: [], routings: [{ product: 'T', ops: [{ center: 'Z', hoursPerUnit: 1 }] }] })).issues.length === 1);

  console.log('Ordonnancement');
  const job = (id, due, ops) => ({ id, due, ops: ops.map(([center, hours]) => ({ center, hours })) });
  const sch = Plan.computeSchedule(Plan.cleanSchedule({ hoursPerDay: 8, rule: 'edd', jobs: [job('A', 3, [['M1', 8], ['M2', 8]]), job('B', 2, [['M1', 4], ['M2', 4]]), job('C', 6, [['M1', 2], ['M2', 12]])] }));
  check('4 règles comparées (FIFO, plus courte durée, échéance, ratio critique)', sch.compare.length === 4);
  const byRule = Object.fromEntries(sch.compare.map((c) => [c.rule, c.metrics]));
  check('échéance au plus tôt : aucun retard sur cet exemple', byRule.edd.lateJobs === 0, byRule);
  check('plus courte durée : meilleur temps de passage moyen', sch.best.flow === 'spt', sch.best);
  const seg = sch.chosen.segments;
  check('aucun poste ne fait deux choses à la fois', ['M1', 'M2'].every((c) => seg.filter((s) => s.center === c).sort((a, b) => a.start - b.start).every((s, i, a) => i === 0 || s.start >= a[i - 1].end - 1e-9)), seg);
  check('une opération ne démarre pas avant la fin de la précédente', seg.filter((s) => s.op === 2).every((s2) => seg.find((s1) => s1.job === s2.job && s1.op === 1).end <= s2.start + 1e-9));
  check('retard calculé en jours', sch.chosen.jobs.every((j) => j.tardiness >= 0) && typeof sch.chosen.metrics.avgWip === 'number');
  check('aucun ordre : résultat vide, pas d\'erreur', Plan.computeSchedule(Plan.cleanSchedule({ jobs: [] })).compare.length === 0);
}

async function httpStage1(O, owner, mem) {
  console.log('Production avancée (HTTP) : étape 1');
  let r = await owner('GET', `${O}/production/adv/mps`);
  check('document vide par défaut', r.status === 200 && r.json.saved === false && r.json.doc.products.length === 0);
  r = await owner('PUT', `${O}/production/adv/mps`, { periods: 6, products: [{ id: 'T', name: 'Table', onHand: 10, safety: 5, lotSize: 20, forecast: [8, 8, 10, 30, 12, 12], firm: [10, 0, 0, 35, 0, 0] }] });
  check('plan directeur enregistré et calculé', r.status === 200 && r.json.result.products[0].plan.length === 6);
  r = await owner('PUT', `${O}/production/adv/mrp`, { periods: 6, useMps: true, items: [{ code: 'T', type: 'make', leadTime: 1, bom: [{ child: 'P', qty: 1 }] }, { code: 'P', type: 'buy', leadTime: 1, lotRule: 'fixed', lotSize: 10 }] });
  check('le MRP reprend le plan directeur', r.status === 200 && r.json.result.items.find((i) => i.code === 'T').gross.some((g) => g > 0) && r.json.result.orders.some((o) => o.item === 'P'), r.json.result.orders);
  r = await owner('PUT', `${O}/production/adv/capacity`, { periods: 6, centers: [{ name: 'Atelier', hours: 30 }], routings: [{ product: 'Table', ops: [{ center: 'Atelier', hoursPerUnit: 1 }] }] });
  check('la capacité reprend le plan directeur (par nom de produit)', r.status === 200 && r.json.result.centers[0].load.some((l) => l > 0), r.json.result.centers[0]);
  r = await owner('PUT', `${O}/production/adv/schedule`, { hoursPerDay: 8, rule: 'cr', jobs: [{ id: 'A', due: 2, ops: [{ center: 'M1', hours: 6 }] }, { id: 'B', due: 1, ops: [{ center: 'M1', hours: 6 }] }] });
  check('ordonnancement calculé avec la règle choisie', r.status === 200 && r.json.result.chosen.rule === 'cr' && r.json.result.compare.length === 4);
  check('technique inconnue refusée', (await owner('GET', `${O}/production/adv/zzz`)).status === 404);
  check('données invalides refusées', (await owner('PUT', `${O}/production/adv/mps`, { periods: 6, products: [{ name: 'x', onHand: 'abc' }] })).status === 400);
  check('un simple membre consulte mais ne modifie pas', (await mem('GET', `${O}/production/adv/mps`)).status === 200 && (await mem('PUT', `${O}/production/adv/mps`, { periods: 6, products: [] })).status === 403);
  r = await owner('GET', `${O}/production/adv/import/stock`);
  check('suggestions du stock, des recettes et des achats en cours (lecture seule)', r.status === 200 && Array.isArray(r.json.stock) && Array.isArray(r.json.boms) && Array.isArray(r.json.openPurchases));
}

async function main() {
  stage1();
  const a = await fakeAi();
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', WS_AI_FREE: '500', AI_PER_MINUTE: '500' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    const owner = client(base); const mem = client(base); const other = client(base);
    await owner('POST', '/api/register', { name: 'Nkoulou', contact: `nk${stamp}@exemple.com`, pass: 'secret123' });
    await mem('POST', '/api/register', { name: 'Paul', contact: `paul${stamp}@exemple.com`, pass: 'secret123' });
    await other('POST', '/api/register', { name: 'Autre', contact: `autre${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`;
    r = await owner('POST', `${O}/invites`, { role: 'member' }); await mem('POST', '/api/ws/orgs/join', { code: r.json.code });
    const org2 = (await other('POST', '/api/ws/orgs', { name: 'Autre entreprise', currency: 'FCFA' })).json.id;
    const members = (await owner('GET', `${O}/members`)).json.members;
    const ctx = { O, owner, mem, other, org2, members, paulId: members.find((m) => m.name === 'Paul').userId };
    await httpStage1(O, owner, mem);
    console.log('Cloisonnement');
    r = await other('GET', `/api/ws/orgs/${org2}/production/adv/mps`);
    check('une autre organisation ne voit pas le plan directeur', r.status === 200 && r.json.saved === false && r.json.doc.products.length === 0);
    for (const f of (module.exports.later || [])) await f(ctx);
  } finally {
    srv.close(); a.srv.close(); await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
