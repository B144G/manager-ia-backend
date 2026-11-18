'use strict';
// Projets & Production : PERT et chemin critique, probabilité de tenir une date, dépendances (4 types, boucles, incohérences), conseils d'outils,
// recherche opérationnelle (simplexe, prix duaux, élasticité-prix, scénarios enregistrés et comparés), circuit de production (modèles, analyse, solutions).
// Les calculs purs sont vérifiés sans base ; le reste passe par le vrai serveur (PostgreSQL jetable). Aucun appel externe.
// Lancez-le avec : node scripts/test-projets-ro.js
const http = require('http');
const { startTestPg } = require('./lib/testdb');
const L = require('../src/workspace/pert-lib');
const RO = require('../src/workspace/ro-lib');
const F = require('../src/workspace/prod-flow-lib');
const FIN = require('../src/workspace/proj-fin-lib');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const near = (a, b, e = 0.02) => Math.abs(a - b) <= e;

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
const add = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function pureTests() {
  console.log('PERT : durées, marges, chemin critique');
  const T = (id, o, m, p) => ({ id, title: 'T' + id, o, m, p });
  let r = L.analyze({ tasks: [T(1, 2, 4, 6), T(2, 3, 5, 13), T(3, 1, 2, 3), T(4, 2, 3, 4)], edges: [{ from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 }], startDate: '2026-01-05', targetDate: '2026-01-25' });
  check('durée du projet = 4 + 6 + 3 = 13 jours', r.duration === 13, r.duration);
  check('chemin critique 1 → 2 → 4', JSON.stringify(r.path) === '[1,2,4]', r.path);
  check('marge de la tâche 3 = 4 jours', r.nodes.find((n) => n.id === 3).float === 4);
  check('écart-type du projet = racine des variances du chemin critique', near(r.sd, Math.sqrt(((6 - 2) / 6) ** 2 + ((13 - 3) / 6) ** 2 + ((4 - 2) / 6) ** 2)), r.sd);
  check('probabilité de tenir une date lointaine ≈ 100 %', r.target.probability > 0.99, r.target);
  const tight = L.analyze({ tasks: [T(1, 2, 4, 6), T(2, 3, 5, 13), T(3, 1, 2, 3), T(4, 2, 3, 4)], edges: [{ from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 }], startDate: '2026-01-05', targetDate: '2026-01-17' });
  check('tenir exactement la durée attendue = environ 50 %', near(tight.target.probability, 0.5, 0.1), tight.target);
  check('la simulation Monte-Carlo donne un percentile 80 supérieur à la moyenne', tight.simulation.p80 > tight.simulation.mean && tight.simulation.histogram.length === 12);
  check('la simulation est reproductible (même graine)', L.analyze({ tasks: [T(1, 2, 4, 6), T(2, 3, 5, 13), T(3, 1, 2, 3), T(4, 2, 3, 4)], edges: [{ from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 }], startDate: '2026-01-05' }).simulation.p80 === tight.simulation.p80);
  r = L.analyze({ tasks: [T(1, 2, 2, 2), T(2, 3, 3, 3)], edges: [{ from: 1, to: 2, type: 'SS', lag: 1 }], startDate: '2026-01-05' });
  check('début-début avec décalage : B commence 1 jour après A, fin = 4', r.nodes.find((n) => n.id === 2).es === 1 && r.duration === 4, r.nodes);
  r = L.analyze({ tasks: [T(1, 5, 5, 5), T(2, 2, 2, 2)], edges: [{ from: 1, to: 2, type: 'FF' }], startDate: '2026-01-05' });
  check('fin-fin : B finit avec A (B commence à 3)', r.nodes.find((n) => n.id === 2).es === 3 && r.duration === 5, r.nodes);
  r = L.analyze({ tasks: [T(1, 2, 2, 2), T(2, 2, 2, 2)], edges: [{ from: 1, to: 2 }, { from: 2, to: 1 }], startDate: '2026-01-05' });
  check('une boucle est détectée (pas de calcul)', r.ok === false && r.cycle.length === 2, r);

  console.log('Dépendances : incohérences');
  const dt = [{ id: 1, title: 'A', start: '2026-01-10', end: '2026-01-14', status: 'doing' }, { id: 2, title: 'B', start: '2026-01-12', end: '2026-01-20', status: 'todo' }, { id: 3, title: 'C', start: '2026-01-01', end: '2026-01-02', status: 'done' }];
  const issues = L.checkDeps({ tasks: dt, edges: [{ from: 1, to: 2, type: 'FS', lag: 0 }, { from: 1, to: 3 }, { from: 2, to: 2 }, { from: 1, to: 2, type: 'FS' }], externals: [{ id: 9, title: 'Ciment', kind: 'supplier', status: 'pending', expectedDate: '2026-01-15', taskId: 2 }, { id: 10, title: 'Permis', kind: 'authorization', status: 'blocked', expectedDate: null, taskId: null }], today: '2026-01-11' });
  const codes = issues.map((i) => i.code);
  check('B commence avant la fin de A : dates incohérentes', codes.includes('dates'), codes);
  check('C terminée alors que A ne l\'est pas', codes.includes('doneBefore'));
  check('auto-dépendance et doublon repérés', codes.includes('self') && codes.includes('duplicate'));
  check('livraison attendue après le début de la tâche', codes.includes('extAfterStart'));
  check('autorisation bloquée', codes.includes('extBlocked'));
  const cyc = L.checkDeps({ tasks: dt, edges: [{ from: 1, to: 2 }, { from: 2, to: 1 }], externals: [], today: '2026-01-11' });
  check('boucle A → B → A repérée avec son enchaînement', cyc.some((i) => i.code === 'cycle' && /→/.test(i.params.chain)), cyc);

  console.log('Simplexe');
  check('classique : max 3x + 5y → (2 ; 6), valeur 36', (() => { const s = RO.solveLP({ sense: 'max', c: [3, 5], rows: [{ a: [1, 0], op: '<=', b: 4 }, { a: [0, 2], op: '<=', b: 12 }, { a: [3, 2], op: '<=', b: 18 }] }); return s.status === 'optimal' && near(s.x[0], 2) && near(s.x[1], 6) && near(s.value, 36); })());
  check('minimisation avec ≥ : min 2x + 3y, x + y ≥ 10, x ≤ 6 → 24', (() => { const s = RO.solveLP({ sense: 'min', c: [2, 3], ub: [6, null], rows: [{ a: [1, 1], op: '>=', b: 10 }] }); return s.status === 'optimal' && near(s.value, 24) && near(s.x[0], 6); })());
  check('égalité : x + y = 5, max x → 5', RO.solveLP({ sense: 'max', c: [1, 0], rows: [{ a: [1, 1], op: '=', b: 5 }] }).value === 5);
  check('problème impossible détecté', RO.solveLP({ sense: 'max', c: [1], rows: [{ a: [1], op: '<=', b: 1 }, { a: [1], op: '>=', b: 2 }] }).status === 'infeasible');
  check('problème non borné détecté', RO.solveLP({ sense: 'max', c: [1], rows: [{ a: [1], op: '>=', b: 1 }] }).status === 'unbounded');
  check('quantité minimale respectée', RO.solveLP({ sense: 'max', c: [1, 10], lb: [3, 0], rows: [{ a: [1, 1], op: '<=', b: 10 }] }).x[0] >= 3 - 1e-9);

  console.log('Scénario de vente');
  const sale = RO.solveScenario('sale', { products: [{ name: 'Table', price: 50000, unitCost: 30000, maxQty: 40 }, { name: 'Chaise', price: 15000, unitCost: 8000 }], resources: [{ name: 'Bois', unit: 'm3', capacity: 20, uses: [0.5, 0.1] }, { name: 'Heures', unit: 'h', capacity: 230, uses: [4, 1] }], fixedCosts: 100000, priceAnalysis: { basePrice: 50000, baseQty: 30, unitCost: 30000, elasticity: 2 } }).result;
  check('le mix qui rapporte le plus par m³ de bois est retenu (chaises)', sale.lines[1].qty === 200 && sale.lines[0].qty === 0, sale.lines);
  check('bénéfice = marge − charges fixes', sale.totals.profit === 1400000 - 100000, sale.totals);
  check('le bois est saturé et son prix dual vaut 70 000 F par m³', sale.constraints[0].saturated && near(sale.constraints[0].shadowPrice, 70000, 1), sale.constraints[0]);
  check('les heures ne sont pas saturées', !sale.constraints[1].saturated && sale.constraints[1].shadowPrice === 0);
  check('prix optimal à élasticité 2 = coût × e / (e − 1) = 60 000', near(sale.price.optimal.price, 60000, 20) && sale.price.optimal.formulaPrice === 60000, sale.price.optimal);
  check('la courbe de marge a 41 points et un maximum à l\'optimum', sale.price.points.length === 41 && Math.max(...sale.price.points.map((p) => p.margin)) <= sale.price.optimal.margin + 1);
  check('la conclusion cite la contrainte qui limite', sale.conclusion.code === 'saleLimitPrice' && sale.conclusion.params.limit === 'Bois', sale.conclusion);
  let threw = false; try { RO.solveScenario('sale', { products: [] }); } catch { threw = true; }
  check('hypothèses vides refusées', threw);

  console.log('Scénario de production (coût minimal)');
  const prod = RO.solveScenario('production', { demand: { qty: 1000, unit: 'pièces' }, sources: [{ name: 'Atelier', unitCost: 1000, capacity: 600 }, { name: 'Sous-traitant', unitCost: 1400 }], resources: [], fixedCosts: 50000, targetMarginPct: 20 }).result;
  check('l\'atelier produit jusqu\'à sa capacité, le sous-traitant le reste', prod.lines[0].qty === 600 && prod.lines[1].qty === 400, prod.lines);
  check('coût total = 600×1000 + 400×1400 + 50 000', prod.totals.totalCost === 1210000, prod.totals);
  check('la capacité de l\'atelier est saturée : 400 F économisés par pièce en plus', prod.constraints[0].saturated && near(prod.constraints[0].shadowPrice, 400, 1), prod.constraints);
  check('prix de vente conseillé pour 20 % de marge', prod.totals.suggestedPrice === Math.round(1210 / 0.8), prod.totals);
  check('demande impossible à satisfaire signalée', RO.solveScenario('production', { demand: { qty: 1000 }, sources: [{ name: 'A', unitCost: 1, capacity: 10 }] }).result.status === 'infeasible');

  console.log('Finances du projet : CBS, ABC, ROI, budget prévisionnel, écarts');
  const cbs = FIN.cbsAnalyze(FIN.CLEAN.cbs({ lines: [{ id: 'a', name: 'Gros œuvre' }, { id: 'b', parentId: 'a', name: 'Ciment', category: 'material', budget: 1000000, actual: 600000, qtyB: 100, priceB: 10000, qtyA: 55, priceA: 11000 }, { id: 'c', parentId: 'a', name: 'Maçons', category: 'labor', budget: 500000, actual: 550000, etc: 100000 }] }));
  check('CBS : le parent cumule ses lignes (budget 1 500 000, réel 1 150 000)', cbs.rows[0].budget === 1500000 && cbs.rows[0].actual === 1150000, cbs.rows[0]);
  check('CBS : prévision à terminer = réel + reste à faire (par défaut budget − réel)', cbs.rows[1].eac === 1000000 && cbs.rows[2].eac === 650000, cbs.rows);
  check('CBS : écart = budget − prévision (−150 000 : dépassement)', cbs.totals.variance === -150000 && cbs.worst[0].id === 'c', cbs.totals);
  check('écart sur coût = écart quantité (+450 000) + écart prix (−55 000)', cbs.rows[1].qtyVariance === 450000 && cbs.rows[1].priceVariance === -55000);
  check('CBS : un parent placé après son enfant devient une racine (aucune boucle possible)', FIN.cbsAnalyze(FIN.CLEAN.cbs({ lines: [{ id: 'a', parentId: 'b', name: 'A', budget: 1 }, { id: 'b', parentId: 'a', name: 'B', budget: 2 }] })).totals.budget === 2);
  let thr = false; try { FIN.CLEAN.cbs({ lines: [{ id: 'a', name: 'A', budget: -5 }] }); } catch { thr = true; }
  check('CBS : montant négatif refusé', thr);
  const abc = FIN.abcAnalyze(FIN.CLEAN.abc({ activities: [{ name: 'Réglages', cost: 100000, driver: 'série', driverQty: 10 }, { name: 'Contrôle', cost: 60000, driver: 'lot', driverQty: 30 }], objects: [{ name: 'A', units: 100, directCost: 200000, usage: [2, 10] }, { name: 'B', units: 50, directCost: 100000, usage: [8, 20] }] }));
  check('ABC : taux par générateur (10 000 F la série, 2 000 F le lot)', abc.rates[0].rate === 10000 && abc.rates[1].rate === 2000, abc.rates);
  check('ABC : coût complet A = 200 000 + 20 000 + 20 000 = 240 000 (2 400 F l\'unité)', abc.objects[0].total === 240000 && abc.objects[0].unitCost === 2400, abc.objects[0]);
  check('ABC : tout le coût des activités est réparti', abc.unallocated === 0 && abc.allocated === 160000);
  check('ABC : la méthode classique sous-estime le produit B (qui consomme plus)', abc.objects[1].unitCost > abc.objects[1].classicUnitCost, abc.objects[1]);
  const roi = FIN.roiAnalyze(FIN.CLEAN.roi({ investment: 1000000, flows: [400000, 400000, 400000], discountRate: 10 }));
  check('ROI = (1 200 000 − 1 000 000) / 1 000 000 = 20 %', roi.roiPct === 20);
  check('délai de récupération = 2,5 ans', roi.payback === 2.5);
  check('VAN à 10 % ≈ −5 259 et TRI ≈ 9,7 %', Math.abs(roi.van + 5259) <= 2 && near(roi.irrPct, 9.7, 0.05), roi);
  check('verdict « rentabilité faible » quand VAN < 0 mais gain positif', roi.verdict === 'weak');
  check('un bon projet a une VAN positive', FIN.roiAnalyze(FIN.CLEAN.roi({ investment: 100, flows: [80, 80, 80], discountRate: 10 })).verdict === 'good');
  const fc = FIN.forecastAnalyze(FIN.CLEAN.forecast({ periods: [{ month: '2026-02', planned: 100 }, { month: '2026-01', planned: 100, revenue: 50 }, { month: '2026-03', planned: 200 }] }), { '2026-01': 120, '2026-02': 130 }, '2026-02');
  check('budget prévisionnel : mois triés, cumul prévu, écart du mois', fc.rows[0].month === '2026-01' && fc.rows[2].cumPlanned === 400 && fc.rows[0].variance === -20, fc.rows);
  check('prévision de fin = réel + reste × rythme de consommation (250/200 × 200 + 250)', fc.burnRate === 1.25 && fc.projectedTotal === 500, fc);

  console.log('Circuit de production');
  for (const s of F.SECTORS) check(`modèle « ${s} » : 7 étapes en chaîne`, F.template(s).length === 7 && F.template(s).every((x, i) => (i === 0 ? x.after.length === 0 : x.after[0] === `s${i}`)));
  const M = [{ userId: 1, name: 'Ana' }, { userId: 2, name: 'Bob' }];
  let a = F.analyze(F.template('food'), { targetPerDay: 2, hoursPerDay: 8 }, { members: M });
  check('un modèle brut est signalé : étapes sans responsable et lots au-dessus de la capacité', a.findings.some((f) => f.code === 'noOwner') && a.findings.some((f) => f.code === 'overload'), a.findings.map((f) => f.key));
  const bad = [{ id: 'a', name: 'A', kind: 'make', after: ['b'], hours: 2, slots: 1 }, { id: 'b', name: 'B', kind: 'prep', after: ['a'], hours: 2, slots: 1 }, { id: 'c', name: 'C', kind: 'ship', after: ['zz'], hours: 0, slots: 1 }, { id: 'd', name: 'D', kind: 'other', after: [], hours: 1, slots: 1 }].map((s) => ({ ownerId: null, backupId: null, validation: false, ...s }));
  const codesBad = F.analyze(bad, { targetPerDay: 1, hoursPerDay: 8 }).findings.map((f) => f.code);
  for (const c of ['loop', 'unresolved', 'noOwner', 'noQc', 'noShipCheck', 'isolated', 'noDuration']) check(`faille détectée : ${c}`, codesBad.includes(c), codesBad);
  const goulot = F.analyze([{ id: 'a', name: 'A', kind: 'supply', after: [], hours: 1, slots: 1 }, { id: 'b', name: 'B', kind: 'make', after: ['a'], hours: 8, slots: 1 }, { id: 'c', name: 'C', kind: 'qc', after: ['b'], hours: 1, slots: 1, validation: true }, { id: 'd', name: 'D', kind: 'ship', after: ['c'], hours: 1, slots: 1 }].map((s) => ({ ownerId: 1, backupId: 2, validation: false, ...s })), { targetPerDay: 0.9, hoursPerDay: 8 }, { members: M });
  check('goulot d\'étranglement repéré (étape la plus lente à 90 % de charge)', goulot.findings.some((f) => f.code === 'bottleneck' && f.stepIds[0] === 'b'), goulot.findings.map((f) => f.key));
  const ownerless = F.analyze([{ id: 'a', name: 'A', kind: 'make', after: [], hours: 1, slots: 1, ownerId: 1, backupId: null, validation: false }, { id: 'b', name: 'B', kind: 'qc', after: ['a'], hours: 1, slots: 1, ownerId: 1, backupId: null, validation: true }, { id: 'c', name: 'C', kind: 'pack', after: ['b'], hours: 1, slots: 1, ownerId: 1, backupId: null, validation: false }, { id: 'd', name: 'D', kind: 'ship', after: ['c'], hours: 1, slots: 1, ownerId: 1, backupId: null, validation: false }], { targetPerDay: 1, hoursPerDay: 8 }, { members: M });
  check('point unique de défaillance : une personne porte tout et l\'étape sans doublure', ownerless.findings.some((f) => f.code === 'spofPerson') && ownerless.findings.some((f) => f.code === 'spofStep'), ownerless.findings.map((f) => f.key));
  // Appliquer toutes les solutions proposées une à une doit finir par un circuit sain (et ne jamais boucler).
  let steps = F.template('food'); let settings = { targetPerDay: 2, hoursPerDay: 8 };
  for (let k = 0; k < 15; k++) {
    a = F.analyze(steps, settings, { members: M });
    const f = a.findings.find((x) => x.solutions.some((s) => s.apply));
    if (!f) break;
    const o = F.applySolution(steps, settings, f, f.solutions.find((s) => s.apply).id, { members: M });
    steps = o.steps; settings = o.settings;
  }
  a = F.analyze(steps, settings, { members: M });
  check('après application des solutions, plus aucun avis majeur et score ≥ 85', a.metrics.high === 0 && a.score >= 85, { score: a.score, f: a.findings.map((f) => f.key) });
  let fixed = F.analyze(bad, { targetPerDay: 1, hoursPerDay: 8 }, { members: M }); let st = bad;
  for (let k = 0; k < 20; k++) { const f = fixed.findings.find((x) => x.solutions.some((s) => s.apply)); if (!f) break; st = F.applySolution(st, { targetPerDay: 1, hoursPerDay: 8 }, f, f.solutions.find((s) => s.apply).id, { members: M }).steps; fixed = F.analyze(st, { targetPerDay: 1, hoursPerDay: 8 }, { members: M }); }
  check('le circuit défectueux (boucle, référence cassée, étape isolée…) est réparé par les solutions', !fixed.findings.some((f) => ['loop', 'unresolved', 'isolated', 'noQc', 'noShipCheck'].includes(f.code)), fixed.findings.map((f) => f.key));
  check('un avis écarté ne compte plus dans le score', F.analyze(F.template('food'), { targetPerDay: 2, hoursPerDay: 8 }, { members: M }, ['noOwner:s1,s2,s3,s4,s5,s6,s7']).score > F.analyze(F.template('food'), { targetPerDay: 2, hoursPerDay: 8 }, { members: M }).score);
}

async function main() {
  pureTests();
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
  const today = new Date().toISOString().slice(0, 10);
  try {
    const owner = client(base); const mem = client(base);
    await owner('POST', '/api/register', { name: 'Nkoulou', contact: `nk${stamp}@exemple.com`, pass: 'secret123' });
    await mem('POST', '/api/register', { name: 'Paul', contact: `paul${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`;
    r = await owner('POST', `${O}/invites`, { role: 'member' }); await mem('POST', '/api/ws/orgs/join', { code: r.json.code });
    const members = (await owner('GET', `${O}/members`)).json.members;
    const paulId = members.find((m) => m.name === 'Paul').userId;

    console.log('Projet : type, PERT, dépendances');
    r = await owner('POST', `${O}/projects`, { name: 'Boutique Mvogo', due: add(today, 30), kind: 'production' });
    const pid = r.json.id;
    check('un projet de production garde son type', (await owner('GET', `${O}/projects/${pid}`)).json.project.kind === 'production');
    r = await owner('PUT', `${O}/projects/${pid}/kind`, { kind: 'sale' });
    check('le type se change (vente)', r.status === 200 && (await owner('GET', `${O}/projects/${pid}`)).json.project.kind === 'sale');
    check('type inconnu refusé', (await owner('PUT', `${O}/projects/${pid}/kind`, { kind: 'x' })).status === 400);
    const tk = async (title, due) => (await owner('POST', `${O}/projects/tasks`, { projectId: pid, title, due })).json.id;
    const t1 = await tk('Plan', add(today, 3)); const t2 = await tk('Découpe', add(today, 8)); const t3 = await tk('Peinture', add(today, 12)); const t4 = await tk('Livraison', add(today, 15));
    r = await owner('GET', `${O}/projects/${pid}/pert`);
    check('PERT sans lien : les tâches sont en parallèle', r.status === 200 && r.json.ok && r.json.nodes.length === 4, r.json);
    for (const [t, o, m, p] of [[t1, 2, 3, 5], [t2, 3, 5, 9], [t3, 2, 4, 6], [t4, 1, 1, 3]]) r = await owner('PUT', `${O}/projects/tasks/${t}/pert`, { optimistic: o, likely: m, pessimistic: p });
    check('estimation PERT enregistrée', r.status === 200);
    check('estimation incohérente refusée (optimiste > probable)', (await owner('PUT', `${O}/projects/tasks/${t1}/pert`, { optimistic: 5, likely: 3, pessimistic: 4 })).status === 400);
    check('un simple membre ne modifie pas les estimations', (await mem('PUT', `${O}/projects/tasks/${t1}/pert`, { optimistic: 1, likely: 2, pessimistic: 3 })).status === 403);
    r = await owner('POST', `${O}/projects/${pid}/deps`, { kind: 'task', predId: t1, succId: t2, type: 'FS' });
    check('dépendance fin-début créée', r.status === 201, r.json);
    r = await owner('POST', `${O}/projects/${pid}/deps`, { kind: 'task', predId: t2, succId: t3, type: 'SS', lag: 2 });
    check('dépendance début-début avec décalage créée', r.status === 201);
    const dsd = r.json.id;
    await owner('PUT', `${O}/projects/tasks/${t4}/plan`, { dependsOn: t3 });
    r = await owner('GET', `${O}/projects/${pid}/pert?target=${add(today, 60)}`);
    check('PERT : chemin critique, durée et probabilité', r.json.ok && r.json.path.length >= 3 && r.json.duration > 0 && r.json.target.probability > 0.9 && r.json.simulation.runs === 2000, { d: r.json.duration, p: r.json.path, t: r.json.target });
    r = await owner('GET', `${O}/projects/${pid}/pert?target=${add(today, 2)}`);
    check('date irréaliste : probabilité faible', r.json.target.probability < 0.05, r.json.target);
    r = await owner('POST', `${O}/projects/${pid}/deps`, { kind: 'task', predId: t1, succId: t2, type: 'FS' });
    check('lien en double refusé', r.status === 400);
    r = await owner('POST', `${O}/projects/${pid}/deps`, { kind: 'task', predId: t1, succId: t1 });
    check('auto-dépendance refusée', r.status === 400);
    r = await owner('POST', `${O}/projects/${pid}/deps`, { kind: 'task', predId: t3, succId: t1, type: 'FS' });
    check('une boucle est acceptée mais signalée immédiatement', r.status === 201 && r.json.issues.some((i) => i.code === 'cycle'), r.json);
    const loopId = r.json.id;
    r = await owner('GET', `${O}/projects/${pid}/pert`);
    check('le PERT refuse de calculer sur une boucle et la nomme', r.json.ok === false && r.json.cycle.length >= 2, r.json);
    r = await owner('GET', `${O}/projects/${pid}/advice`);
    check('conseil : réparer la boucle en premier', r.json.items[0].code === 'depsCycle' && r.json.items[0].tool === 'deps', r.json.items);
    await owner('DELETE', `${O}/projects/deps/${loopId}`);
    check('après suppression du lien fautif, plus de boucle', (await owner('GET', `${O}/projects/${pid}/deps`)).json.issues.every((i) => i.code !== 'cycle'));
    r = await owner('POST', `${O}/projects/${pid}/deps`, { kind: 'external', extKind: 'supplier', title: 'Livraison du ciment', expectedDate: add(today, 20), succId: t3, status: 'pending' });
    check('dépendance externe (fournisseur) créée', r.status === 201);
    r = await owner('POST', `${O}/projects/${pid}/deps`, { kind: 'external', extKind: 'authorization', title: 'Permis de construire', status: 'blocked' });
    check('dépendance externe (autorisation) créée', r.status === 201);
    r = await owner('GET', `${O}/projects/${pid}/deps`);
    check('les dépendances externes sont contrôlées (arrivée après le début, autorisation bloquée)', r.json.issues.some((i) => i.code === 'extBlocked') && r.json.externals.length === 2, r.json.issues.map((i) => i.code));
    check('les 4 types de liens sont acceptés', ['FS', 'SS', 'FF', 'SF'].every((t) => t) && (await owner('PUT', `${O}/projects/deps/${dsd}`, { type: 'FF', lag: 1 })).status === 200);
    check('type de lien inconnu refusé', (await owner('PUT', `${O}/projects/deps/${dsd}`, { type: 'XX' })).status === 400);

    console.log('Risques : catégories et outils proposés');
    r = await owner('POST', `${O}/projects/${pid}/risks`, { title: 'Retard du fournisseur de bois', category: 'supplier', probability: 4, impact: 4 });
    check('risque classé par catégorie', r.status === 201);
    await owner('POST', `${O}/projects/${pid}/risks`, { title: 'Dépassement de budget', category: 'cost', probability: 3, impact: 4 });
    await owner('POST', `${O}/projects/${pid}/risks`, { title: 'Équipe indisponible', category: 'resource', probability: 3, impact: 3 });
    await owner('POST', `${O}/projects/${pid}/risks`, { title: 'Retard de livraison', category: 'delay', probability: 2, impact: 4 });
    check('catégorie inconnue refusée', (await owner('POST', `${O}/projects/${pid}/risks`, { title: 'x', category: 'zzz' })).status === 400);
    r = await owner('GET', `${O}/projects/${pid}/risks`);
    check('la catégorie est renvoyée', r.json.items.some((x) => x.category === 'supplier'));
    r = await owner('GET', `${O}/projects/${pid}/advice`);
    const tools = Object.fromEntries(r.json.items.map((x) => [x.code, x.tool]));
    check('plusieurs dépendances → PERT / chemin critique', tools.depsMany === 'pert', tools);
    check('risque de délai → PERT (marges et simulation)', tools.riskDelay === 'pert');
    check('risque de coût → pilotage (courbe en S, valeur acquise)', tools.riskCost === 'pilot');
    check('risque de ressource → charge', tools.riskResource === 'workload');
    check('risque et dépendance fournisseur → achats', tools.riskSupplier === 'purchasing' && tools.depSupplier === 'purchasing');
    check('projet de vente sans scénario → recherche opérationnelle', tools.optimSale === 'optim');
    check('un simple membre voit les conseils mais pas l\'optimisation', (await mem('GET', `${O}/projects/${pid}/advice`)).json.items.every((x) => x.tool !== 'optim'));

    console.log('Recherche opérationnelle : scénarios');
    const inputs = { products: [{ name: 'Table', price: 50000, unitCost: 30000, maxQty: 40 }, { name: 'Chaise', price: 15000, unitCost: 8000 }], resources: [{ name: 'Bois', unit: 'm3', capacity: 20, uses: [0.5, 0.1] }, { name: 'Heures', unit: 'h', capacity: 230, uses: [4, 1] }], fixedCosts: 100000, priceAnalysis: { basePrice: 50000, baseQty: 30, unitCost: 30000, elasticity: 2 } };
    r = await owner('POST', `${O}/projects/${pid}/ro/solve`, { kind: 'sale', inputs });
    check('résolution sans enregistrement', r.status === 200 && r.json.result.status === 'optimal' && r.json.result.totals.profit === 1300000, r.json);
    check('hypothèses invalides refusées proprement', (await owner('POST', `${O}/projects/${pid}/ro/solve`, { kind: 'sale', inputs: { products: [{ name: 'X', price: 'abc' }] } })).status === 400);
    check('un simple membre ne voit pas les prix et coûts', (await mem('POST', `${O}/projects/${pid}/ro/solve`, { kind: 'sale', inputs })).status === 403);
    r = await owner('POST', `${O}/projects/${pid}/ro/scenarios`, { name: 'Base', kind: 'sale', inputs });
    check('scénario enregistré', r.status === 201); const s1 = r.json.id;
    const inputs2 = { ...inputs, resources: [{ name: 'Bois', unit: 'm3', capacity: 40, uses: [0.5, 0.1] }, { name: 'Heures', unit: 'h', capacity: 230, uses: [4, 1] }] };
    r = await owner('POST', `${O}/projects/${pid}/ro/scenarios`, { name: 'Plus de bois', kind: 'sale', inputs: inputs2 });
    const s2 = r.json.id;
    r = await owner('GET', `${O}/projects/${pid}/ro/compare?ids=${s1},${s2}`);
    check('comparaison : le scénario avec plus de bois rapporte plus', r.status === 200 && r.json.best === s2 && r.json.items.length === 2, r.json.best);
    const sp = await owner('POST', `${O}/projects/${pid}/ro/scenarios`, { name: 'Prod', kind: 'production', inputs: { demand: { qty: 100 }, sources: [{ name: 'A', unitCost: 10 }] } });
    check('on ne compare pas vente et production', (await owner('GET', `${O}/projects/${pid}/ro/compare?ids=${s1},${sp.json.id}`)).status === 400);
    r = await owner('GET', `${O}/projects/${pid}/ro/scenarios`);
    check('liste des scénarios avec indicateurs', r.json.items.length === 3 && r.json.items[0].metrics !== null);
    r = await owner('GET', `${O}/projects/ro/scenarios/${s1}`);
    check('un scénario se rouvre avec ses hypothèses et son résultat', r.json.inputs.products.length === 2 && r.json.result.status === 'optimal');
    check('un scénario se renomme et se recalcule', (await owner('PUT', `${O}/projects/ro/scenarios/${s1}`, { name: 'Base v2', inputs: inputs2 })).json.result.totals.profit > 1300000);
    check('un scénario se supprime', (await owner('DELETE', `${O}/projects/ro/scenarios/${s2}`)).status === 200);
    r = await owner('GET', `${O}/projects/${pid}/advice`);
    check('avec un scénario, la recommandation « optimiser » disparaît', !r.json.items.some((x) => x.code === 'optimSale'));
    r = await owner('GET', `${O}/projects/${pid}/ro/starter`);
    check('hypothèses de départ proposées', r.status === 200 && Array.isArray(r.json.boms));

    console.log('Finances du projet (HTTP)');
    r = await owner('PUT', `${O}/projects/${pid}/fin/cbs`, { lines: [{ id: 'a', name: 'Matériaux', category: 'material', budget: 500000, actual: 200000 }, { id: 'b', name: 'Main-d\'œuvre', category: 'labor', budget: 300000, actual: 350000, etc: 80000 }] });
    check('structure des coûts enregistrée', r.status === 200);
    await owner('PUT', `${O}/projects/${pid}/fin/roi`, { investment: 800000, flows: [300000, 300000, 300000], discountRate: 10 });
    await owner('PUT', `${O}/projects/${pid}/fin/abc`, { activities: [{ name: 'Réglages', cost: 1000, driver: 'série', driverQty: 10 }], objects: [{ name: 'A', units: 10, directCost: 100, usage: [5] }] });
    await owner('PUT', `${O}/projects/${pid}/fin/forecast`, { periods: [{ month: today.slice(0, 7), planned: 100000 }] });
    r = await owner('GET', `${O}/projects/${pid}/fin`);
    check('vue financière : le budget de la structure des coûts est cumulé (800 000)', r.status === 200 && r.json.cbs.totals.budget === 800000, r.json.cbs);
    check('prévision à terminer = 500 000 + 430 000, écart −130 000 (main-d\'œuvre en dépassement)', r.json.cbs.totals.eac === 930000 && r.json.cbs.totals.variance === -130000, r.json.cbs.totals);
    check('ROI et ABC calculés par le serveur', r.json.roi.roiPct === 12.5 && r.json.abc.objects[0].total === 600, { roi: r.json.roi.roiPct, abc: r.json.abc.objects[0] });
    check('la valeur acquise (EVM) est reprise', r.json.evm && 'cpi' in r.json.evm && 'spi' in r.json.evm);
    check('document invalide refusé', (await owner('PUT', `${O}/projects/${pid}/fin/roi`, { investment: 'abc' })).status === 400 && (await owner('PUT', `${O}/projects/${pid}/fin/zzz`, {})).status === 400);
    check('un simple membre ne voit pas les finances du projet', (await mem('GET', `${O}/projects/${pid}/fin`)).status === 403 && (await mem('PUT', `${O}/projects/${pid}/fin/cbs`, { lines: [] })).status === 403);

    console.log('Circuit de production');
    r = await owner('GET', `${O}/production/flows/templates`);
    check('5 modèles par secteur', r.json.sectors.length === 5);
    r = await owner('POST', `${O}/production/flows`, { name: 'Jus de gingembre', sector: 'food', targetPerDay: 2 });
    check('circuit créé depuis le modèle alimentaire', r.status === 201 && r.json.steps.length === 7 && r.json.analysis.score < 100, r.json.analysis);
    const fid = r.json.id;
    check('le circuit signale des failles avec des solutions', r.json.analysis.findings.every((f) => f.solutions.length > 0));
    const noOwner = r.json.analysis.findings.find((f) => f.code === 'noOwner');
    r = await owner('POST', `${O}/production/flows/${fid}/apply`, { key: noOwner.key, solution: 'spreadOwners' });
    check('« répartir les responsables » affecte les étapes', r.status === 200 && r.json.steps.every((s) => s.ownerId !== null) && !r.json.analysis.findings.some((f) => f.code === 'noOwner'), r.json.analysis.findings.map((f) => f.key));
    const over = r.json.analysis.findings.find((f) => f.code === 'overload');
    const before = r.json.analysis.score;
    r = await owner('POST', `${O}/production/flows/${fid}/apply`, { key: over.key, solution: 'addSlot' });
    check('ajouter un poste lève la surcharge et améliore le score', !r.json.analysis.findings.some((f) => f.code === 'overload') && r.json.analysis.score > before);
    check('solution inexistante refusée', (await owner('POST', `${O}/production/flows/${fid}/apply`, { key: over.key, solution: 'addSlot' })).status === 404);
    const some = r.json.analysis.findings[0];
    if (some) {
      r = await owner('POST', `${O}/production/flows/${fid}/dismiss`, { key: some.key });
      check('un avis peut être écarté (il reste visible mais ne compte plus)', r.json.analysis.findings.find((f) => f.key === some.key).state === 'dismissed');
      r = await owner('POST', `${O}/production/flows/${fid}/dismiss`, { key: some.key, restore: true });
      check('un avis écarté peut être rétabli', r.json.analysis.findings.find((f) => f.key === some.key).state === 'open');
    }
    // Circuit personnalisé : étapes, ordre, responsables, durées, validations.
    r = await owner('POST', `${O}/production/flows`, { name: 'Mon circuit', sector: 'trade', steps: [{ id: 'a', name: 'Réception', kind: 'supply', after: [], ownerId: paulId, hours: 1, slots: 1 }, { id: 'b', name: 'Emballage', kind: 'pack', after: ['a'], ownerId: paulId, hours: 2, slots: 1 }, { id: 'c', name: 'Envoi', kind: 'ship', after: ['b'], hours: 1, slots: 1 }], targetPerDay: 1 });
    check('circuit personnalisé créé', r.status === 201 && r.json.source === 'custom' && r.json.steps[0].owner === 'Paul');
    check('absence de contrôle qualité et de validation avant expédition détectées', ['noQc', 'noShipCheck'].every((c) => r.json.analysis.findings.some((f) => f.code === c)));
    const cid = r.json.id;
    r = await owner('PUT', `${O}/production/flows/${cid}`, { steps: [{ id: 'a', name: 'Réception', kind: 'supply', after: ['b'], hours: 1, slots: 1 }, { id: 'b', name: 'Emballage', kind: 'pack', after: ['a'], hours: 2, slots: 1 }] });
    check('une boucle infinie est détectée après modification', r.json.analysis.findings.some((f) => f.code === 'loop'));
    check('étapes invalides refusées (durée négative)', (await owner('PUT', `${O}/production/flows/${cid}`, { steps: [{ id: 'a', name: 'x', hours: -1 }] })).status === 400);
    check('responsable inconnu refusé', (await owner('PUT', `${O}/production/flows/${cid}`, { steps: [{ id: 'a', name: 'x', hours: 1, ownerId: 999999 }] })).status === 400);
    check('un simple membre consulte mais ne modifie pas', (await mem('GET', `${O}/production/flows/${cid}`)).status === 200 && (await mem('PUT', `${O}/production/flows/${cid}`, { name: 'x' })).status === 403 && (await mem('POST', `${O}/production/flows/${cid}/apply`, { key: 'x', solution: 'y' })).status === 403);
    r = await owner('GET', `${O}/production/flows`);
    check('liste des circuits avec score', r.json.items.length === 2 && r.json.items.every((x) => typeof x.score === 'number'));
    check('un circuit se supprime', (await owner('DELETE', `${O}/production/flows/${cid}`)).status === 200);

    console.log('Cloisonnement');
    const other = client(base);
    await other('POST', '/api/register', { name: 'Autre', contact: `autre${stamp}@exemple.com`, pass: 'secret123' });
    const o2 = (await other('POST', '/api/ws/orgs', { name: 'Autre entreprise', currency: 'FCFA' })).json.id;
    check('une autre organisation ne voit ni le PERT, ni les scénarios, ni les circuits', (await other('GET', `/api/ws/orgs/${o2}/projects/${pid}/pert`)).status === 404 && (await other('GET', `/api/ws/orgs/${o2}/projects/ro/scenarios/${s1}`)).status === 404 && (await other('GET', `/api/ws/orgs/${o2}/production/flows/${fid}`)).status === 404);
  } finally {
    srv.close(); a.srv.close(); await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
