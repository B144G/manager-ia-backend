'use strict';
// Production avancée : MPS, MRP, capacités, ordonnancement (étape 1) ; lean, kanban, 5S, TOC, JIT (étape 2) ; Six Sigma, TPM, qualité, analyse intégrée (étape 3).
// Calculs purs vérifiés sans base, puis le vrai serveur (PostgreSQL jetable). Aucun appel externe. Lancez-le : node scripts/test-production-avancee.js
const http = require('http');
const { startTestPg } = require('./lib/testdb');
const Plan = require('../src/workspace/prod-plan-lib');
const Lean = require('../src/workspace/prod-lean-lib');
const Shop = require('../src/workspace/prod-shop-lib');
const Flow = require('../src/workspace/prod-flow-lib');
const Q = require('../src/workspace/prod-quality-lib');

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

function stage2() {
  console.log('Lean : cartographie de flux, takt time, 8 gaspillages');
  const mk = (extra) => Flow.cleanSteps(Flow.template('food').map((s, i) => ({ ...s, ...(extra[i] || {}) })));
  const set = { targetPerDay: 1, hoursPerDay: 8, extra: { unitPrice: 1000, materialCost: 400, opexPerDay: 200, inventoryValue: 5000 } };
  const steps = mk({ 2: { waitHours: 6, batch: 9 }, 3: { stockBefore: 10, defectPct: 5 }, 0: { suppliers: 1 }, 5: { moveHours: 0.5, motionHours: 0.5 }, 4: { talentUnused: true } });
  const L = Lean.lean(steps, set);
  check('takt time = heures par jour / lots demandés (8 h)', L.takt === 8, L.takt);
  check('délai de traversée = durées + attentes + transports', near(L.leadTime, steps.reduce((a, s) => a + s.hours + s.waitHours + s.moveHours + s.motionHours, 0)), L.leadTime);
  check('taux de valeur ajoutée = temps de valeur ajoutée / délai total', near(L.vaRatio, L.valueAddedTime / L.leadTime * 100, 0.1), L);
  const an = Flow.analyze(steps, set, { members: [] });
  const codes = an.findings.map((f) => f.code);
  for (const c of ['mudaTransport', 'mudaInventory', 'mudaMotion', 'mudaWaiting', 'mudaOverproduction', 'mudaDefects', 'mudaTalent']) check(`gaspillage repéré : ${c}`, codes.includes(c), codes);
  check('un circuit sans données Lean ne déclenche aucun avis Lean', !Flow.analyze(Flow.template('food').map((s) => ({ ...s, ownerId: 1 })), set, { members: [] }).findings.some((f) => f.code.startsWith('muda') || f.code.startsWith('jit')));
  const slow = Flow.analyze(Flow.cleanSteps([{ id: 'a', name: 'A', kind: 'make', hours: 12, slots: 1 }]), { targetPerDay: 1, hoursPerDay: 8 }, { members: [] });
  check('étape plus lente que le takt time signalée', slow.findings.some((f) => f.code === 'overTakt'), slow.findings.map((f) => f.code));

  console.log('TOC : contrainte et comptabilité de débit');
  const T = Lean.toc(steps, set, set.extra);
  check('la contrainte est l\'étape de plus faible capacité (fabrication)', T.constraint.id === 's3' && near(T.constraint.capacityPerDay, 1.33), T.constraint);
  check('tampon devant la contrainte = moitié des durées et attentes en amont', T.bufferHours === (3 + 4 + 0) * 0.5, T.bufferHours);
  check('débit par jour = lots vendus × (prix − coût matière) = 600', T.throughput.perDay === 600 && T.throughput.netProfitPerDay === 400, T.throughput);
  check('élever la contrainte : la prochaine contrainte est nommée', Boolean(T.elevate.newConstraint) && T.elevate.gainLotsPerDay >= 0, T.elevate);
  check('avis : pas de tampon devant la contrainte (charge ≥ 80 %)', Flow.analyze(mk({}), { targetPerDay: 1.2, hoursPerDay: 8 }, { members: [] }).findings.some((f) => f.code === 'tocNoBuffer'));

  console.log('JIT');
  const J = Lean.jit(steps, set);
  check('en-cours total et en jours de demande', J.wipLots === 10 && J.wipDays === 10, J);
  check('fournisseur unique signalé', codes.includes('jitSingleSupplier'));
  const flowFindings = an.findings;
  // Appliquer les solutions Lean une à une : la solution doit changer les données (et jamais boucler).
  let cur = steps; let s2 = { ...set };
  for (let k = 0; k < 20; k++) {
    const a = Flow.analyze(cur, s2, { members: [] });
    const f = a.findings.find((x) => /^(muda|jit|toc|overTakt)/.test(x.code) && x.solutions.some((y) => y.apply));
    if (!f) break;
    const o = Flow.applySolution(cur, s2, f, f.solutions.find((y) => y.apply).id, { members: [] });
    cur = o.steps; s2 = o.settings;
  }
  check('les solutions Lean / JIT appliquées font disparaître ces avis', !Flow.analyze(cur, s2, { members: [] }).findings.some((f) => /^(muda|jit|tocNo|overTakt)/.test(f.code) && f.solutions.some((y) => y.apply)), Flow.analyze(cur, s2, { members: [] }).findings.map((f) => f.code));
  check('les champs Lean sont conservés par le nettoyage des étapes', Flow.cleanSteps(steps)[2].waitHours === 6 && Flow.cleanSteps(steps)[0].suppliers === 1 && flowFindings.length > 0);

  console.log('Kanban');
  const kb = Shop.computeKanban(Shop.cleanKanban({ items: [{ id: 'k1', name: 'Sachets', demandPerDay: 100, leadTimeDays: 2, waitDays: 1, containerQty: 50, safetyPct: 10, onHand: 100, inProd: 1 }, { id: 'k2', name: 'Boîtes', demandPerDay: 10, leadTimeDays: 1, containerQty: 10, onHand: 100 }] }));
  const k1 = kb.items[0];
  check('nombre de cartes = 100 × 3 × 1,1 / 50 = 6,6 → 7', k1.cardsComputed === 7 && k1.cards === 7, k1);
  check('cartes pleines / en production / vides (stock 100 = 2 bacs)', k1.full === 2 && k1.inProd === 1 && k1.empty === 4, k1);
  check('signal de réapprovisionnement avec la quantité à produire (4 bacs de 50)', k1.signal === 'refill' && k1.refillQty === 200 && kb.refill.length === 1, k1);
  check('point de commande = demande × délai', k1.reorderPoint === 200);
  check('article bien approvisionné : signal vert', kb.items[1].signal === 'ok', kb.items[1]);
  check('nombre de cartes imposé par l\'utilisateur respecté', Shop.computeKanban(Shop.cleanKanban({ items: [{ name: 'x', demandPerDay: 10, leadTimeDays: 1, containerQty: 5, cards: 9 }] })).items[0].cards === 9);

  console.log('5S');
  const sc = (a, b, c, d, e) => ({ sort: a, set: b, shine: c, standardize: d, sustain: e });
  const f5 = Shop.computeFives(Shop.cleanFives({ zones: [{ name: 'Atelier', audits: [{ date: '2026-01-10', scores: sc(2, 2, 2, 1, 1) }, { date: '2026-03-10', scores: sc(3, 3, 3, 2, 2) }], actions: [{ text: 'Étiqueter les outils', s: 'set', due: '2026-02-01', status: 'todo' }, { text: 'Fait', status: 'done' }] }, { name: 'Magasin' }] }), '2026-03-15');
  const z = f5.zones[0];
  check('score 5S = total / 20 (13 sur 20 = 65 %)', z.last.pct === 65 && z.previous.pct === 40, z.last);
  check('progression entre deux audits (+25 points)', z.delta === 25);
  check('S la plus faible identifiée (standardiser)', z.weakest === 'standardize' || z.weakest === 'sustain', z.weakest);
  check('actions en retard comptées, zone non auditée signalée', z.lateActions === 1 && f5.unaudited[0] === 'Magasin' && f5.lateActions === 1);
  check('note hors échelle refusée', throws(() => Shop.cleanFives({ zones: [{ name: 'x', audits: [{ date: '2026-01-01', scores: { sort: 9 } }] }] })));
  check('photo non image refusée (ignorée)', Shop.cleanFives({ zones: [{ name: 'x', audits: [{ date: '2026-01-01', scores: sc(1, 1, 1, 1, 1), photos: ['<script>', 'data:image/png;base64,AAAA'] }] }] }).zones[0].audits[0].photos.length === 1);
}

async function httpStage2(ctx) {
  const { O, owner, mem } = ctx;
  console.log('Production avancée (HTTP) : étape 2');
  let r = await owner('PUT', `${O}/production/adv/kanban`, { items: [{ name: 'Sachets', demandPerDay: 100, leadTimeDays: 2, containerQty: 50, onHand: 50 }] });
  check('kanban enregistré et calculé', r.status === 200 && r.json.result.items[0].cards >= 1 && r.json.result.items[0].signal === 'refill', r.json.result);
  r = await owner('PUT', `${O}/production/adv/fives`, { zones: [{ name: 'Atelier', audits: [{ date: '2026-01-10', scores: { sort: 3, set: 3, shine: 3, standardize: 3, sustain: 3 } }] }] });
  check('audit 5S enregistré (75 %)', r.status === 200 && r.json.result.zones[0].last.pct === 75, r.json.result);
  check('un simple membre ne modifie pas le 5S', (await mem('PUT', `${O}/production/adv/fives`, { zones: [] })).status === 403);
  r = await owner('POST', `${O}/production/flows`, { name: 'Lean test', sector: 'food', targetPerDay: 1, extra: { unitPrice: 1000, materialCost: 400, opexPerDay: 200 } });
  check('circuit créé avec ses réglages TOC', r.status === 201 && r.json.extra.unitPrice === 1000, r.json.extra);
  const fid = r.json.id;
  const steps = r.json.steps.map((s, i) => ({ ...s, waitHours: i === 2 ? 6 : 0, stockBefore: i === 3 ? 10 : 0 }));
  r = await owner('PUT', `${O}/production/flows/${fid}`, { steps });
  check('les champs Lean des étapes sont enregistrés', r.status === 200 && r.json.steps[2].waitHours === 6 && r.json.steps[3].stockBefore === 10, r.json.steps[2]);
  r = await owner('GET', `${O}/production/flows/${fid}/lean`);
  check('cartographie de flux (VSM) : délai, valeur ajoutée, takt', r.status === 200 && r.json.takt === 8 && r.json.vaRatio > 0 && r.json.steps.length === 7, r.json);
  r = await owner('GET', `${O}/production/flows/${fid}/toc`);
  check('TOC : contrainte, tampon, comptabilité de débit', r.status === 200 && r.json.constraint.id === 's3' && r.json.throughput.perDay > 0, r.json.constraint);
  r = await owner('GET', `${O}/production/flows/${fid}/jit`);
  check('JIT : en-cours', r.status === 200 && r.json.wipLots === 10);
  r = await owner('GET', `${O}/production/flows/${fid}`);
  const inv = r.json.analysis.findings.find((f) => f.code === 'mudaInventory');
  check('l\'analyse du circuit contient les avis Lean (stock excessif)', Boolean(inv), r.json.analysis.findings.map((f) => f.code));
  r = await owner('POST', `${O}/production/flows/${fid}/apply`, { key: inv.key, solution: 'halveStock' });
  check('solution Lean appliquée en un clic (stock divisé par 2)', r.status === 200 && r.json.steps[3].stockBefore === 5, r.json.steps[3]);
  check('autre organisation : circuit invisible', (await ctx.other('GET', `/api/ws/orgs/${ctx.org2}/production/flows/${fid}/lean`)).status === 404);
}

function stage3() {
  console.log('Six Sigma : cartes de contrôle, capabilité, DPMO, Pareto, Ishikawa, DMAIC');
  const g = [[10.1, 10.0, 9.9, 10.2], [10.0, 10.1, 10.0, 9.8], [10.3, 10.2, 10.1, 10.0], [9.9, 10.0, 10.1, 10.0], [10.0, 10.1, 9.9, 10.1]];
  const six = Q.computeSix(Q.cleanSix({ spec: { lsl: 9.5, usl: 10.5 }, xr: { subgroups: g }, dpmo: { units: 1000, opportunities: 5, defects: 15 }, defects: [{ cause: 'a', count: 20 }, { cause: 'b', count: 50 }, { cause: 'c', count: 30 }], ishikawa: { problem: 'Rayures', causes: { machine: ['usure', 'réglage'], man: ['formation'] } }, projects: [{ title: 'Réduire les rayures', phase: 'analyze', tasks: [{ text: 'Mesurer', phase: 'measure', done: true }, { text: 'Pareto', phase: 'analyze' }] }], p: { samples: [{ n: 100, d: 2 }, { n: 100, d: 3 }, { n: 100, d: 2 }, { n: 100, d: 25 }] } }));
  check('carte X-barre : moyenne des moyennes et limites ± A2 × R-barre', six.xr.x.center === 10.04 && near(six.xr.x.ucl, 10.04 + 0.729 * 0.26, 0.01), six.xr.x);
  check('carte R : limites avec D3 = 0 et D4 = 2,282', six.xr.r.lcl === 0 && near(six.xr.r.ucl, 2.282 * six.xr.r.center, 0.01));
  check('processus stable sur cet exemple', six.xr.stable === true);
  const bad = Q.computeSix(Q.cleanSix({ xr: { subgroups: [[10, 10.1], [10, 10.1], [10.05, 10.1], [10.4, 10.5], [10, 10.1], [10.05, 10.05], [10, 10.1]] } }));
  check('un point hors limites est détecté', bad.xr.x.signals.some((s) => s.rule === 'limit' && s.index === 3), bad.xr.x.signals);
  check('Cp, Cpk et niveau sigma calculés', six.capability.cp > six.capability.cpk && six.capability.cpk > 0 && six.capability.sigmaLevel > 3, six.capability);
  check('verdict de capabilité (Cpk entre 1 et 1,33 : limite)', six.capability.verdict === 'marginal', six.capability);
  check('DPMO = 15 / (1000 × 5) × 1 000 000 = 3 000, niveau sigma ≈ 4,25', six.dpmo.dpmo === 3000 && near(six.dpmo.sigmaLevel, 4.25, 0.02), six.dpmo);
  check('Pareto trié, cumul et « quelques causes vitales » (50 + 30 = 80 %)', six.pareto[0].cause === 'b' && six.pareto[1].cumPct === 80 && six.vitalFew.length === 2, six.pareto);
  check('carte p : un échantillon à 25 % est hors contrôle', six.p.signals.join() === '3' && !six.p.stable, six.p);
  check('Ishikawa : la catégorie la plus chargée est la machine', six.ishikawa.main === 'machine');
  check('DMAIC : avancement et prochaine étape guidée', six.projects[0].progress === 50 && six.projects[0].nextStep === 'rootcause', six.projects[0]);
  check('sous-groupes de tailles différentes refusés', throws(() => Q.cleanSix({ xr: { subgroups: [[1, 2], [1, 2, 3]] } })));
  check('niveau sigma 6 ↔ 3,4 DPMO (convention 1,5 sigma)', near(Q.sigmaFromDpmo(3.4), 6, 0.05));

  console.log('TPM : TRS, 6 pertes, MTBF / MTTR, calendrier');
  const tp = Q.computeTpm(Q.cleanTpm({ machines: [{ name: 'Presse', plannedHours: 160, breakdownHours: 8, setupHours: 12, minorStopHours: 5, idealCycleMin: 1, totalCount: 8000, goodCount: 7600, failures: [{ date: '2026-01-02', hours: 3 }, { date: '2026-02-01', hours: 5 }], pm: [{ task: 'Graissage', everyDays: 30, lastDone: '2026-01-01' }, { task: 'Nettoyage', kind: 'autonomous', everyDays: 7, lastDone: '2026-02-27' }] }, { name: 'Emballeuse', plannedHours: 100 }] }), '2026-03-01');
  const m = tp.machines[0];
  check('disponibilité = (planifié − pannes − réglages) / planifié = 87,5 %', m.availability === 87.5, m);
  check('qualité = bonnes / produites = 95 %', m.quality === 95);
  check('TRS = disponibilité × performance × qualité', near(m.oee, m.availability * m.performance * m.quality / 10000, 0.15), m.oee);
  check('6 grandes pertes chiffrées, la plus lourde identifiée (réglages)', m.losses.length === 6 && m.biggestLoss === 'setup', m.losses);
  check('MTBF et MTTR depuis la liste des pannes', m.mtbf > 0 && m.mttr === 4, { mtbf: m.mtbf, mttr: m.mttr });
  check('calendrier : graissage en retard, nettoyage bientôt dû', m.calendar.find((c) => c.task === 'Graissage').status === 'overdue' && m.calendar.find((c) => c.task === 'Nettoyage').status === 'soon', m.calendar);
  check('machine sans plan de maintenance signalée', tp.noPlan.join() === 'Emballeuse' && tp.overdue >= 1);

  console.log('Qualité : AQL, non-conformités, CAPA, traçabilité');
  check('échantillonnage : lot 500 → échantillon 50 (code H), acceptation 3 à AQL 2,5', Q.sampling(500, 2.5).sample === 50 && Q.sampling(500, 2.5).accept === 3);
  check('échantillonnage : lot 1 200, AQL 1,0 → 80 pièces, 2 défauts acceptés', Q.sampling(1200, 1).sample === 80 && Q.sampling(1200, 1).accept === 2);
  const oc = Q.sampling(500, 2.5).oc;
  check('courbe d\'efficacité décroissante (plus de défauts, moins de lots acceptés)', oc.every((p, i) => i === 0 || p.accept <= oc[i - 1].accept) && oc[0].accept > 90);
  const ql = Q.computeQuality(Q.cleanQuality({ produced: 1000, plans: [{ stage: 'final', characteristic: 'Poids', aql: 2.5, lotSize: 500 }], ncs: [{ id: 'n1', date: '2026-02-01', lot: 'L1', qty: 20, disposition: 'scrap', cause: 'Réglage', category: 'machine', capa: { action: 'Refaire le réglage', due: '2026-02-10' } }, { id: 'n2', date: '2026-02-02', lot: 'L2', qty: 30, disposition: 'rework', cause: 'Formation', category: 'man', status: 'closed', capa: { action: 'Former', done: true, effective: true } }], lots: [{ code: 'L1', product: 'Savon', qty: 500, materialLots: ['M-7'] }, { code: 'L2', qty: 500, materialLots: ['M-7', 'M-8'] }] }), '2026-03-01');
  check('taux de rebut 2 % et de retouche 3 %', ql.rates.scrapPct === 2 && ql.rates.reworkPct === 3, ql.rates);
  check('Pareto des causes de non-conformité', ql.pareto[0].cause === 'Formation' && ql.pareto[0].cumPct === 60);
  check('CAPA en retard comptée, étapes sans plan de contrôle signalées', ql.capa.late === 1 && ql.missingStages.join() === 'incoming,inprocess', ql.capa);
  check('traçabilité : un lot de matière retrouve les lots finis qui l\'ont utilisé', ql.materialUse.find((x) => x.material === 'M-7').lots.join() === 'L1,L2' && ql.lots[0].ncQty === 20, ql.materialUse);
}

async function httpStage3(ctx) {
  const { O, owner, mem } = ctx;
  console.log('Production avancée (HTTP) : étape 3');
  let r = await owner('PUT', `${O}/production/adv/sixsigma`, { spec: { lsl: 9.5, usl: 10.5 }, xr: { subgroups: [[10, 10.1, 9.9], [10, 10.2, 10], [10.1, 9.9, 10], [10, 10, 10.1]] }, defects: [{ cause: 'rayure', count: 5 }] });
  check('Six Sigma enregistré et calculé', r.status === 200 && r.json.result.xr.x.center > 9 && r.json.result.pareto.length === 1, r.json.result.xr);
  r = await owner('PUT', `${O}/production/adv/tpm`, { machines: [{ name: 'Mélangeur', plannedHours: 160, breakdownHours: 40, setupHours: 20, idealCycleMin: 1, totalCount: 4000, goodCount: 3200 }] });
  check('TPM : TRS bas calculé', r.status === 200 && r.json.result.machines[0].oee < 40 && r.json.result.noPlan.length === 1, r.json.result.machines[0]);
  r = await owner('PUT', `${O}/production/adv/quality`, { produced: 1000, plans: [], ncs: [{ date: '2026-02-01', qty: 10, lot: 'L1', cause: 'x' }] });
  check('qualité enregistrée', r.status === 200 && r.json.result.rates.scrapPct === 1, r.json.result.rates);
  check('lecture du module Maintenance (lecture seule)', (await owner('GET', `${O}/production/adv/import/maintenance`)).status === 200);
  check('un simple membre ne modifie ni TPM ni qualité', (await mem('PUT', `${O}/production/adv/tpm`, { machines: [] })).status === 403 && (await mem('GET', `${O}/production/adv/tpm`)).status === 200);
  check('document invalide refusé (sous-groupes inégaux)', (await owner('PUT', `${O}/production/adv/sixsigma`, { xr: { subgroups: [[1, 2], [1, 2, 3]] } })).status === 400);
  // Intégration à l'analyse du circuit
  r = await owner('POST', `${O}/production/flows`, { name: 'Savons', sector: 'cosmetics', targetPerDay: 1 });
  const fid = r.json.id;
  const steps = r.json.steps.map((s, i) => ({ ...s, machine: i === 2 ? 'Mélangeur' : (i === 3 ? 'Banc de test' : '') }));
  r = await owner('PUT', `${O}/production/flows/${fid}`, { steps });
  const codes = r.json.analysis.findings.map((f) => f.code);
  check('machine au TRS très bas signalée dans l\'analyse du circuit', codes.includes('tpmLowOee'), codes);
  check('machine sans plan de maintenance signalée dans l\'analyse du circuit', codes.includes('tpmNoPlan'), codes);
  check('contrôle qualité sans plan de contrôle signalé', codes.includes('qcNoPlan'), codes);
  r = await owner('PUT', `${O}/production/adv/quality`, { produced: 1000, plans: [{ stage: 'final', characteristic: 'Poids', aql: 2.5, lotSize: 500 }] });
  r = await owner('PUT', `${O}/production/adv/tpm`, { machines: [{ name: 'Mélangeur', plannedHours: 160, idealCycleMin: 1, totalCount: 100, goodCount: 100, pm: [{ task: 'Graissage', everyDays: 30, lastDone: '2026-01-01' }] }, { name: 'Banc de test', pm: [{ task: 'Étalonnage', everyDays: 90 }] }] });
  r = await owner('GET', `${O}/production/flows/${fid}`);
  const c2 = r.json.analysis.findings.map((f) => f.code);
  check('une fois le plan de contrôle et la maintenance créés, ces avis disparaissent', !c2.includes('qcNoPlan') && !c2.includes('tpmNoPlan'), c2);
}

async function main() {
  stage1();
  stage2();
  stage3();
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
    await httpStage2(ctx);
    await httpStage3(ctx);
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
