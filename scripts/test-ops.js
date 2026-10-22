'use strict';
// Test des modules « Production », « Maintenance » et « Chantiers (BTP) » (base temporaire, faux serveur d'IA, aucun appel externe).
// Lancez-le avec : node scripts/test-ops.js
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (n = 0) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

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
  const fport = await freePort();
  const seen = { system: '' };
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { const j = JSON.parse(b || '{}'); seen.system = Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n') : (j.system || ''); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'Réponse de test.' }] })); });
  });
  await new Promise((r) => fake.listen(fport, '127.0.0.1', r));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const pgt = await startTestPg();
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fport}`,
    ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', TRUST_PROXY: '0', WS_AI_FREE: '100', AI_PER_MINUTE: '500', SIGNUP_VERIFY: 'off', API_PUBLIC_URL: base, REMINDER_HOUR: '0' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }

  try {
    const stamp = Date.now();
    const owner = client(base); const staff = client(base); const other = client(base);
    const reg = (c, name) => c('POST', '/api/register', { name, contact: `${name.toLowerCase()}${stamp}@exemple.com`, pass: 'secret123' });
    await reg(owner, 'Awa'); await reg(staff, 'Paul'); await reg(other, 'Zoe');
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Awa', sector: 'Industrie', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`;
    r = await other('POST', '/api/ws/orgs', { name: 'Autre Société' });
    const org2 = r.json.id; const O2 = `/api/ws/orgs/${org2}`;
    r = await owner('POST', `${O}/invites`, { role: 'member' });
    r = await staff('POST', '/api/ws/orgs/join', { code: r.json.code });
    r = await staff('GET', O); const staffId = r.json.me.userId;
    r = await owner('GET', O);
    check('modules déclarés', ['production', 'maintenance', 'construction'].every((id) => r.json.modules.some((m) => m.id === id)));
    const item = async (c, o, name, unit, quantity, unitCost) => (async () => { const x = await c('POST', `${o}/stock/items`, { name, unit, quantity, unitCost }); if (!x.json || !x.json.id) console.log('STOCK?', x.status, x.text); return x.json && x.json.id; })();

    // ===================== PRODUCTION =====================
    console.log('Production : nomenclatures et coût de revient');
    const farine = await item(owner, O, 'Farine', 'kg', 100, 500);
    const sucre = await item(owner, O, 'Sucre', 'kg', 20, 800);
    const pain = await item(owner, O, 'Gâteau', 'pièce', 0);
    const foreign = await item(other, O2, 'Article étranger', 'kg', 5, 100);
    const P = `${O}/production`;
    r = await staff('POST', `${P}/boms`, { productId: pain, lines: [{ itemId: farine, quantity: 1 }] });
    check('membre ne crée pas de nomenclature -> 403', r.status === 403, r.json);
    r = await owner('POST', `${P}/boms`, { productId: pain, lines: [] });
    check('nomenclature sans matière -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/boms`, { productId: pain, lines: [{ itemId: foreign, quantity: 1 }] });
    check("matière d'une autre organisation -> 404", r.status === 404, r.json);
    r = await owner('POST', `${P}/boms`, { productId: pain, lines: [{ itemId: farine, quantity: 0 }] });
    check('quantité nulle -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/boms`, { productId: pain, lines: [{ itemId: pain, quantity: 1 }] });
    check('produit dans ses propres matières -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/boms`, { productId: pain, laborCost: 200, otherCost: 100, lines: [{ itemId: farine, quantity: 0.5 }, { itemId: sucre, quantity: 0.25 }] });
    check('nomenclature créée', r.status === 201, r.json);
    const bom = r.json.id;
    r = await owner('POST', `${P}/boms`, { productId: pain, lines: [{ itemId: farine, quantity: 1 }] });
    check('2e nomenclature du même produit -> 400', r.status === 400, r.json);
    r = await owner('GET', `${P}/boms`);
    const b0 = r.json.boms[0];
    check('coût de revient = 0,5*500 + 0,25*800 + 200 + 100 = 750', b0.unitCost === 750 && b0.materialCost === 450, b0);
    check('capacité : 100/0,5=200 ; 20/0,25=80 -> 80 limité par le sucre', b0.maxQuantity === 80 && b0.limiting === 'Sucre', b0);
    r = await staff('GET', `${P}/boms`);
    check('membre voit la recette mais pas les coûts', r.status === 200 && r.json.boms[0].unitCost === undefined && r.json.boms[0].lines.length === 2, r.json);
    r = await other('GET', `${O2}/production/boms`);
    check("autre organisation : aucune nomenclature d'Atelier Awa", r.json.boms.length === 0, r.json);
    r = await other('GET', `${P}/boms`);
    check('autre organisation sur /production d\'Awa -> 404', r.status === 404, r.json);
    r = await owner('PUT', `${P}/boms/${bom}`, { laborCost: 300 });
    check('modification (main-d\'œuvre)', r.status === 200, r.json);
    r = await owner('GET', `${P}/boms`);
    check('nouveau coût 850', r.json.boms[0].unitCost === 850, r.json.boms[0]);

    console.log('Production : ordres de fabrication');
    r = await staff('POST', `${P}/orders`, { bomId: bom, quantity: 10 });
    check('membre ne crée pas d\'ordre -> 403', r.status === 403, r.json);
    r = await owner('POST', `${P}/orders`, { bomId: bom, quantity: -1 });
    check('quantité négative -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/orders`, { bomId: bom, quantity: 10, dueDate: '31/12/2026' });
    check('date invalide -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/orders`, { bomId: bom, quantity: 100, dueDate: ymd(5) });
    check('ordre créé OF-0001', r.status === 201, r.json);
    const big = r.json.id;
    r = await owner('GET', `${P}/orders/${big}/check`);
    check('manque : sucre 25 requis, 20 en stock -> manque 5', r.json.ok === false && r.json.shortages.length === 1 && r.json.shortages[0].name === 'Sucre' && r.json.shortages[0].missing === 5, r.json);
    r = await owner('POST', `${P}/orders/${big}/launch`, {});
    check('lancement refusé (409) avec la liste des manques', r.status === 409 && r.json.shortages.length === 1 && /Sucre/.test(r.json.error), r.json);
    r = await owner('PUT', `${P}/orders/${big}`, { quantity: 40 });
    check('brouillon modifié', r.status === 200, r.json);
    r = await owner('POST', `${P}/orders/${big}/close`, {});
    check('clôturer un brouillon -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/orders/${big}/launch`, {});
    check('lancé (stock suffisant)', r.status === 200 && r.json.shortages.length === 0, r.json);
    r = await owner('PUT', `${P}/orders/${big}`, { quantity: 5 });
    check('ordre lancé non modifiable -> 400', r.status === 400, r.json);
    r = await owner('DELETE', `${P}/orders/${big}`);
    check('ordre lancé non supprimable -> 400', r.status === 400, r.json);
    r = await owner('DELETE', `${P}/boms/${bom}`);
    check('nomenclature utilisée par un ordre en cours -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/orders/${big}/close`, { producedQty: 36, scrapQty: 4 });
    check('clôture : 36 produits, 4 rebuts', r.status === 200 && r.json.unitCost > 0, r.json);
    // matières consommées : (36+4)*0,5=20 kg farine ; (36+4)*0,25=10 kg sucre ; coût = 20*500+10*800 + 40*(300+100) = 18000+16000=34000 ; unitaire 34000/36=944
    r = await owner('GET', `${O}/stock`);
    const st = Object.fromEntries(r.json.items.map((i) => [i.name, i]));
    check('stock : farine 80, sucre 10, gâteau 36', st['Farine'].quantity === 80 && st['Sucre'].quantity === 10 && st['Gâteau'].quantity === 36, Object.values(st).map((i) => [i.name, i.quantity]));
    check('coût du produit fini mis à jour (944)', st['Gâteau'].unitCost === 944, st['Gâteau']);
    r = await owner('GET', `${O}/stock/items/${pain}/moves`);
    check('mouvement « Production OF-0001 » sur le produit fini', r.json.moves.some((m) => m.delta === 36 && m.reason === 'Production OF-0001'), r.json);
    r = await owner('GET', `${O}/stock/items/${sucre}/moves`);
    check('mouvement de sortie de sucre', r.json.moves.some((m) => m.delta === -10 && m.reason === 'Production OF-0001'), r.json);
    r = await owner('POST', `${P}/orders/${big}/close`, { producedQty: 1 });
    check('déjà terminé -> 400', r.status === 400, r.json);

    // clôture avec stock insuffisant : rien ne bouge (transaction)
    r = await owner('POST', `${P}/orders`, { bomId: bom, quantity: 100 });
    const o2 = r.json.id;
    r = await owner('POST', `${P}/orders/${o2}/launch`, { force: true });
    check('lancement forcé malgré les manques', r.status === 200 && r.json.shortages.length >= 1, r.json);
    r = await owner('POST', `${P}/orders/${o2}/close`, { producedQty: 100 });
    check('clôture sans assez de matières -> 400', r.status === 400 && /Sucre/.test(r.json.error), r.json);
    r = await owner('GET', `${O}/stock`);
    check('stock inchangé après échec (transaction)', r.json.items.find((i) => i.name === 'Farine').quantity === 80 && r.json.items.find((i) => i.name === 'Gâteau').quantity === 36, r.json.items.map((i) => [i.name, i.quantity]));
    r = await owner('POST', `${P}/orders/${o2}/cancel`);
    check('ordre annulé', r.status === 200, r.json);
    r = await owner('DELETE', `${P}/orders/${o2}`);
    check('ordre annulé supprimé', r.status === 200, r.json);

    r = await owner('GET', `${P}/`);
    check('tableau de bord : rendement 90 %, rebut 4, coût moyen 944', r.json.summary.yieldPct === 90 && r.json.summary.monthScrap === 4 && r.json.summary.avgUnitCost === 944 && r.json.summary.inProgress === 0, r.json.summary);
    r = await staff('GET', `${P}/`);
    check('membre : tableau de bord sans coût', r.status === 200 && r.json.summary.avgUnitCost === undefined && r.json.orders[0].totalCost === undefined, r.json);

    console.log('Production : planification');
    r = await owner('GET', `${P}/plan/capacity`);
    check('capacité actuelle : sucre 10 -> 40 gâteaux', r.json.capacity[0].maxQuantity === 40 && r.json.capacity[0].limiting === 'Sucre', r.json);
    r = await owner('POST', `${P}/plan/needs`, { lines: [{ bomId: bom, quantity: 100 }] });
    const need = Object.fromEntries(r.json.needs.map((n) => [n.name, n]));
    check('besoins : farine 50 (ok), sucre 25 (manque 15 = 12 000)', need['Farine'].missing === 0 && need['Sucre'].needed === 25 && need['Sucre'].missing === 15 && r.json.missingCost === 12000, r.json);
    r = await owner('POST', `${P}/plan/needs`, { lines: [] });
    check('plan vide -> 400', r.status === 400, r.json);

    // ===================== MAINTENANCE =====================
    console.log('Maintenance : parc et plans');
    const M = `${O}/maintenance`;
    r = await staff('POST', `${M}/equipment`, { name: 'Four' });
    check('membre ne crée pas d\'équipement -> 403', r.status === 403, r.json);
    r = await owner('POST', `${M}/equipment`, { name: '' });
    check('nom obligatoire -> 400', r.status === 400, r.json);
    r = await owner('POST', `${M}/equipment`, { name: 'Four', kind: 'avion' });
    check('type inconnu -> 400', r.status === 400, r.json);
    r = await owner('POST', `${M}/equipment`, { name: 'Four à pain', kind: 'machine', reference: 'F-01', location: 'Atelier', purchasedAt: '2024-01-15', value: 1500000, meter: 100 });
    check('équipement créé', r.status === 201, r.json);
    const eq = r.json.id;
    r = await owner('POST', `${M}/equipment`, { name: 'Camion', kind: 'vehicle', meter: 50000 });
    const eq2 = r.json.id;
    r = await other('POST', `${O2}/maintenance/equipment`, { name: 'Machine étrangère' });
    const eqForeign = r.json.id;
    r = await owner('POST', `${M}/plans`, { equipmentId: eqForeign, task: 'x', periodKind: 'days', periodValue: 30 });
    check("plan sur un équipement d'une autre organisation -> 404", r.status === 404, r.json);
    r = await owner('POST', `${M}/plans`, { equipmentId: eq, task: 'Graissage', periodKind: 'mois', periodValue: 30 });
    check('périodicité inconnue -> 400', r.status === 400, r.json);
    r = await owner('POST', `${M}/plans`, { equipmentId: eq, task: 'Graissage', periodKind: 'days', periodValue: 30, lastDoneAt: ymd(-40) });
    check('plan en jours créé', r.status === 201, r.json);
    const planLate = r.json.id;
    r = await owner('POST', `${M}/plans`, { equipmentId: eq2, task: 'Vidange', periodKind: 'km', periodValue: 10000, lastMeter: 42000 });
    check('plan en km créé', r.status === 201, r.json);
    const planKm = r.json.id;
    r = await owner('GET', `${M}/plans`);
    const pl = Object.fromEntries(r.json.plans.map((p) => [p.task, p]));
    check('graissage en retard de 10 jours (échéance calculée)', pl['Graissage'].state === 'late' && pl['Graissage'].nextDueAt === ymd(-10) && pl['Graissage'].left === -10, pl['Graissage']);
    check('vidange : échéance 52 000 km, en retard (50 000 < 52 000 ? non : reste 2 000)', pl['Vidange'].nextMeter === 52000 && pl['Vidange'].left === 2000 && pl['Vidange'].state === 'ok', pl['Vidange']);
    r = await owner('GET', `${M}/`);
    check('alertes : 1 plan en retard', r.json.summary.latePlans === 1 && r.json.alerts.length === 1, r.json.summary);

    console.log('Maintenance : interventions');
    r = await staff('POST', `${M}/orders`, { equipmentId: eq, title: 'Le four ne chauffe plus', priority: 'urgent', assigneeId: staffId });
    check('un membre signale une panne', r.status === 201, r.json);
    const oc = r.json.id;
    r = await owner('GET', `${M}/equipment/${eq}`);
    check("l'équipement passe en panne", r.json.equipment.status === 'broken', r.json.equipment);
    r = await staff('GET', `${M}/orders/${oc}`);
    check('le membre ne peut pas s\'assigner (ignoré)', r.json.order.assigneeId === null && r.json.order.cost === undefined, r.json);
    r = await staff('POST', `${M}/plans`, { equipmentId: eq, task: 'x', periodKind: 'days', periodValue: 1 });
    check('membre ne crée pas de plan -> 403', r.status === 403, r.json);
    r = await owner('PUT', `${M}/orders/${oc}`, { assigneeId: staffId, laborCost: 5000 });
    check('responsable assigne à un membre', r.status === 200, r.json);
    r = await owner('PUT', `${M}/orders/${oc}`, { assigneeId: 99999 });
    check('assigner à une personne extérieure -> 400', r.status === 400, r.json);
    r = await owner('POST', `${M}/orders/${oc}/parts`, { itemId: farine, quantity: 1000 });
    check('pièce du stock en quantité insuffisante -> 400', r.status === 400, r.json);
    r = await owner('POST', `${M}/orders/${oc}/parts`, { itemId: sucre, quantity: 2 });
    check('pièce prélevée du stock', r.status === 201, r.json);
    const part = r.json.id;
    r = await owner('GET', `${O}/stock`);
    check('stock : sucre 10 -> 8', r.json.items.find((i) => i.name === 'Sucre').quantity === 8, r.json.items.map((i) => [i.name, i.quantity]));
    r = await staff('POST', `${M}/orders/${oc}/parts`, { name: 'Résistance', quantity: 1, unitCost: 15000 });
    check("la personne assignée ajoute une pièce hors stock", r.status === 201, r.json);
    r = await owner('DELETE', `${M}/orders/${oc}/parts/${part}`);
    check('pièce retirée : le stock revient', r.status === 200, r.json);
    r = await owner('GET', `${O}/stock`);
    check('stock : sucre de nouveau 10', r.json.items.find((i) => i.name === 'Sucre').quantity === 10, r.json.items.map((i) => [i.name, i.quantity]));
    r = await owner('POST', `${M}/orders/${oc}/parts`, { itemId: sucre, quantity: 1 });
    r = await staff('POST', `${M}/orders/${oc}/start`);
    check('la personne assignée démarre', r.status === 200, r.json);
    r = await staff('POST', `${M}/orders/${oc}/close`, { downtimeHours: 6, laborCost: 5000 });
    check('la personne assignée clôture', r.status === 200, r.json);
    r = await owner('GET', `${M}/equipment/${eq}`);
    check("l'équipement est remis en service", r.json.equipment.status === 'running', r.json.equipment);
    check('historique : 1 panne, 6 h d\'arrêt, coût = 5000 + 15000 + 1*800 = 20800', r.json.totals.breakdowns === 1 && r.json.totals.downtimeHours === 6 && r.json.totals.cost === 20800, r.json.totals);
    r = await owner('PUT', `${M}/orders/${oc}`, { title: 'x' });
    check('intervention terminée non modifiable -> 400', r.status === 400, r.json);
    r = await staff('POST', `${M}/orders/${oc}/close`, {});
    check('déjà terminée -> 400', r.status === 400, r.json);
    r = await other('GET', `${M}/orders/${oc}`);
    check('autre organisation -> 404', r.status === 404, r.json);

    r = await owner('POST', `${M}/plans/${planLate}/order`, { priority: 'high' });
    check('intervention préventive créée depuis le plan', r.status === 201, r.json);
    const op = r.json.id;
    r = await owner('POST', `${M}/orders/${op}/start`);
    r = await owner('POST', `${M}/orders/${op}/close`, { downtimeHours: 1, laborCost: 2000 });
    check('préventive clôturée', r.status === 200, r.json);
    r = await owner('GET', `${M}/plans`);
    const g = r.json.plans.find((p) => p.id === planLate);
    check('prochaine échéance replanifiée à aujourd\'hui + 30 jours', g.lastDoneAt === ymd(0) && g.nextDueAt === ymd(30) && g.state === 'ok', g);
    r = await owner('POST', `${M}/orders`, { equipmentId: eq2, planId: planKm, kind: 'preventive', title: 'Vidange' });
    const opk = r.json.id;
    r = await owner('POST', `${M}/orders/${opk}/close`, { meter: 52500 });
    r = await owner('GET', `${M}/plans`);
    const gk = r.json.plans.find((p) => p.id === planKm);
    check('plan en km replanifié : 52 500 + 10 000', gk.nextMeter === 62500 && gk.lastMeter === 52500, gk);
    r = await owner('GET', `${M}/`);
    const s = r.json.summary;
    check('indicateurs : arrêt 7 h, coût du mois 22 800, 1 équipement le plus en panne', s.downtimeHours === 7 && s.monthCost === 22800 && s.topBreakdowns.length === 1 && s.topBreakdowns[0].name === 'Four à pain', s);
    check('disponibilité entre 0 et 100', s.availability >= 0 && s.availability <= 100, s.availability);
    r = await owner('PUT', `${M}/equipment/${eq2}`, { status: 'stopped' });
    r = await owner('PUT', `${M}/equipment/${eq2}`, { status: 'en vrac' });
    check('statut invalide -> 400', r.status === 400, r.json);
    r = await owner('DELETE', `${M}/equipment/${eq2}`);
    check('équipement supprimé', r.status === 200, r.json);

    // ===================== CHANTIERS =====================
    console.log('Chantiers : fiches et phases');
    const C = `${O}/construction`;
    r = await staff('POST', `${C}/sites`, { name: 'Villa' });
    check('membre ne crée pas de chantier -> 403', r.status === 403, r.json);
    r = await owner('POST', `${C}/sites`, { name: '' });
    check('nom obligatoire -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites`, { name: 'Villa', startDate: '2026-05-01', endDate: '2026-04-01' });
    check('fin avant début -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites`, { name: 'Villa Dupont', client: 'M. Dupont', location: 'Douala', foremanId: 99999 });
    check('chef de chantier extérieur -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites`, { name: 'Villa Dupont', client: 'M. Dupont', location: 'Douala', foremanId: staffId, startDate: ymd(-60), endDate: ymd(60), budget: 10000000, costBudget: 8000000, remainingEstimate: 3000000, status: 'active' });
    check('chantier créé', r.status === 201, r.json);
    const site = r.json.id;
    r = await other('POST', `${O2}/construction/sites`, { name: 'Chantier étranger', budget: 1000 });
    const siteForeign = r.json.id;
    r = await owner('GET', `${C}/sites/${siteForeign}`);
    check('chantier d\'une autre organisation -> 404', r.status === 404, r.json);
    r = await owner('POST', `${C}/sites/${siteForeign}/expenses`, { category: 'materials', amount: 100 });
    check('dépense sur un chantier étranger -> 404', r.status === 404, r.json);
    r = await owner('POST', `${C}/sites/${site}/phases`, { name: 'Fondations', weight: 2, progress: 100, plannedStart: ymd(-60), plannedEnd: ymd(-30) });
    const ph1 = r.json.id;
    r = await owner('POST', `${C}/sites/${site}/phases`, { name: 'Gros œuvre', weight: 6, progress: 25, plannedStart: ymd(-30), plannedEnd: ymd(-5) });
    const ph2 = r.json.id;
    r = await staff('POST', `${C}/sites/${site}/phases`, { name: 'Finitions', weight: 2, plannedStart: ymd(10), plannedEnd: ymd(50) });
    check('le chef de chantier (membre) ajoute une phase', r.status === 201, r.json);
    r = await owner('POST', `${C}/sites/${site}/phases`, { name: 'Mauvaise', weight: 0 });
    check('poids nul -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites/${site}/phases`, { name: 'Mauvaise', progress: 150 });
    check('avancement > 100 -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites/${site}/phases`, { name: 'Mauvaise', plannedStart: ymd(5), plannedEnd: ymd(1) });
    check('fin prévue avant début -> 400', r.status === 400, r.json);
    r = await owner('GET', `${C}/sites/${site}`);
    // avancement pondéré : (2*100 + 6*25 + 2*0)/10 = 35 %
    check('avancement pondéré = 35 %', r.json.site.progress === 35, r.json.site);
    check('phase « Gros œuvre » en retard', r.json.phases.find((p) => p.id === ph2).late === true && r.json.site.latePhases === 1 && r.json.site.late === true, r.json.phases);
    check('phase terminée : fin réelle posée', Boolean(r.json.phases.find((p) => p.id === ph1).actualEnd));
    r = await staff('PUT', `${C}/phases/${ph2}`, { progress: 50 });
    check('le chef de chantier met à jour l\'avancement', r.status === 200, r.json);

    console.log('Chantiers : dépenses, budget, situations');
    r = await staff('POST', `${C}/sites/${site}/expenses`, { category: 'materials', amount: 1000 });
    check('membre ne saisit pas de dépense -> 403', r.status === 403, r.json);
    r = await owner('POST', `${C}/sites/${site}/expenses`, { category: 'bonbons', amount: 1000 });
    check('catégorie inconnue -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites/${site}/expenses`, { category: 'materials', amount: -5 });
    check('montant négatif -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites/${site}/expenses`, { category: 'materials', label: 'Ciment', amount: '5 000 000', date: ymd(0) });
    const e1 = r.json.id;
    check('dépense créée (sans alerte)', r.status === 201 && r.json.alert === null, r.json);
    r = await owner('POST', `${C}/sites/${site}/expenses`, { category: 'labor', label: 'Maçons', amount: 3500000 });
    check('dépense qui dépasse le budget de dépenses -> alerte', r.status === 201 && /dépassent/.test(r.json.alert), r.json);
    r = await owner('GET', `${C}/sites/${site}`);
    check('dépenses par catégorie et dépassement', r.json.site.spent === 8500000 && r.json.site.overrun === 'over' && r.json.byCategory.find((c) => c.category === 'materials').total === 5000000, r.json.site);
    check('marge prévisionnelle = 10 000 000 − 8 500 000 − 3 000 000 = −1 500 000', r.json.site.forecastMargin === -1500000, r.json.site);
    r = await staff('GET', `${C}/sites/${site}`);
    check('membre : aucun montant', r.status === 200 && r.json.site.budget === undefined && r.json.site.spent === undefined && r.json.expenses.length === 0 && r.json.billings.length === 0, r.json.site);
    r = await owner('POST', `${C}/expenses/${e1}/to-budget`, {});
    check('inscription au budget sans confirmation -> 400', r.status === 400, r.json);
    r = await owner('GET', `${O}/budget`);
    const nb = (r.json.entries || []).length;
    r = await owner('POST', `${C}/expenses/${e1}/to-budget`, { confirm: true });
    check('inscription au budget après confirmation', r.status === 200, r.json);
    r = await owner('GET', `${O}/budget`);
    check("l'écriture est au budget de l'organisation (5 000 000)", (r.json.entries || []).length === nb + 1 && (r.json.entries || []).some((x) => x.amount === 5000000 && x.kind === 'expense'), r.json.entries);
    r = await owner('POST', `${C}/expenses/${e1}/to-budget`, { confirm: true });
    check('déjà inscrite -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${C}/expenses/${e1}`, { amount: 1 });
    check('dépense inscrite au budget non modifiable -> 400', r.status === 400, r.json);

    r = await owner('POST', `${C}/sites/${site}/billings`, { label: 'Acompte', amount: 3000000, billedAt: ymd(-20), dueDate: ymd(-5) });
    const bl = r.json.id;
    r = await owner('POST', `${C}/billings/${bl}/pay`, { amount: 5000000 });
    check('paiement supérieur au reste dû -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/billings/${bl}/pay`, { amount: 1000000 });
    check('paiement partiel enregistré', r.status === 200, r.json);
    r = await staff('POST', `${C}/billings/${bl}/pay`, { amount: 1000 });
    check('membre ne saisit pas de paiement -> 403', r.status === 403, r.json);
    r = await owner('GET', `${C}/sites/${site}`);
    check('facturé 3 000 000, payé 1 000 000, reste dû 2 000 000, en retard', r.json.site.billed === 3000000 && r.json.site.paid === 1000000 && r.json.site.toPay === 2000000 && r.json.billings[0].late === true, r.json.billings);
    r = await owner('PUT', `${C}/billings/${bl}`, { amount: 500000 });
    check('montant inférieur au payé -> 400', r.status === 400, r.json);

    console.log('Chantiers : pointage, rapports, incidents');
    r = await staff('POST', `${C}/sites/${site}/timesheets`, { date: ymd(), worker: 'Équipe maçons', headcount: 6, hours: 8 });
    check('pointage de l\'équipe (membre)', r.status === 201, r.json);
    const t1 = r.json.id;
    r = await staff('POST', `${C}/sites/${site}/timesheets`, { headcount: 1, hours: 30 });
    check('plus de 24 h -> 400', r.status === 400, r.json);
    r = await staff('POST', `${C}/sites/${site}/timesheets`, { headcount: 0, hours: 5 });
    check('zéro personne -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites/${site}/timesheets`, { worker: 'Moussa', headcount: 1, hours: 9 });
    r = await owner('GET', `${C}/sites/${site}`);
    check('total 57 heures-personnes', r.json.personHours === 57 && r.json.timesheets.length === 2, r.json.personHours);
    r = await staff('POST', `${C}/sites/${site}/reports`, { date: ymd(), weather: 'Pluie', work: '', headcount: 7 });
    check('rapport sans travaux -> 400', r.status === 400, r.json);
    r = await staff('POST', `${C}/sites/${site}/reports`, { date: ymd(), weather: 'Pluie', work: 'Coulage de la dalle', headcount: 7, incidents: 'Aucun' });
    check('rapport journalier créé', r.status === 201, r.json);
    const rp = r.json.id;
    r = await staff('POST', `${C}/sites/${site}/issues`, { kind: 'safety', title: 'Échafaudage instable' });
    check('point de sécurité signalé', r.status === 201, r.json);
    const is1 = r.json.id;
    r = await staff('POST', `${C}/sites/${site}/issues`, { kind: 'danger', title: 'x' });
    check('type de point inconnu -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/sites/${site}/issues`, { kind: 'snag', title: 'Peinture à reprendre' });
    const is2 = r.json.id;
    r = await staff('PUT', `${C}/issues/${is2}`, { status: 'resolved' });
    check("un membre ne modifie pas la saisie d'un autre (sauf chef de chantier)", r.status === 200, r.json); // le membre est chef de chantier
    r = await owner('GET', `${C}/sites/${site}`);
    check('réserve levée avec date', r.json.issues.find((i) => i.id === is2).status === 'resolved' && Boolean(r.json.issues.find((i) => i.id === is2).resolvedAt) && r.json.site.openIssues === 1, r.json.issues);
    // autre membre sans lien avec le chantier
    const third = client(base); await reg(third, 'Luc');
    r = await owner('POST', `${O}/invites`, { role: 'member' });
    r = await third('POST', '/api/ws/orgs/join', { code: r.json.code });
    check('3e personne a rejoint', r.status === 200, r.json);
    r = await third('DELETE', `${C}/reports/${rp}`);
    check("un membre ne supprime pas le rapport d'un autre -> 403", r.status === 403, r.json);
    r = await third('PUT', `${C}/phases/${ph1}`, { progress: 10 });
    check('un membre non chef ne modifie pas une phase -> 403', r.status === 403, r.json);
    r = await staff('DELETE', `${C}/reports/${rp}`);
    check('l\'auteur supprime son rapport', r.status === 200, r.json);
    r = await staff('DELETE', `${C}/timesheets/${t1}`);
    check("l'auteur supprime son pointage", r.status === 200, r.json);

    console.log('Chantiers : tableau de bord');
    r = await owner('GET', `${C}/`);
    const sm = r.json.summary;
    check('synthèse : 1 actif, avancement, 1 en retard, marge, dépassement, reste à encaisser', sm.active === 1 && sm.avgProgress > 0 && sm.late === 1 && sm.forecastMargin === -1500000 && sm.overBudget === 1 && sm.toCollect === 2000000, sm);
    r = await staff('GET', `${C}/`);
    check('membre : synthèse sans argent', r.status === 200 && r.json.summary.forecastMargin === undefined && r.json.sites[0].budget === undefined, r.json.summary);
    r = await other('GET', `${O2}/construction/`);
    check("isolation : l'autre organisation ne voit que son chantier", r.json.sites.length === 1 && r.json.sites[0].name === 'Chantier étranger', r.json.sites);
    r = await owner('PUT', `${C}/sites/${site}`, { status: 'inconnu' });
    check('statut inconnu -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${C}/sites/${site}`, { status: 'done' });
    check('chantier terminé', r.status === 200, r.json);
    r = await owner('DELETE', `${C}/phases/${ph1}`);
    check('phase supprimée', r.status === 200, r.json);

    // ===================== IA =====================
    console.log("Aide à l'IA");
    r = await owner('POST', `${O}/ai/chat`, { module: 'production', message: 'Que puis-je fabriquer ?' });
    check('IA production : réponse', r.status === 200, r.json);
    check('IA production : voit les nomenclatures', /PRODUCTION/.test(seen.system) && /Gâteau/.test(seen.system) && /coût de revient/.test(seen.system), seen.system.slice(-600));
    r = await staff('POST', `${O}/ai/chat`, { module: 'production', message: 'Coûts ?' });
    check('IA production (membre) : pas de coût de revient', r.status === 200 && /PRODUCTION/.test(seen.system) && !/coût de revient \d/.test(seen.system), seen.system.slice(-500));
    r = await owner('POST', `${O}/ai/chat`, { module: 'maintenance', message: 'Où en est la maintenance ?' });
    check('IA maintenance : voit le parc', r.status === 200 && /MAINTENANCE/.test(seen.system) && /Four à pain/.test(seen.system), seen.system.slice(-500));
    r = await owner('POST', `${O}/ai/chat`, { module: 'construction', message: 'Mes chantiers ?' });
    check('IA chantiers : voit les chantiers (aucun en cours car terminé)', r.status === 200 && /CHANTIERS/.test(seen.system), seen.system.slice(-300));
    r = await owner('POST', `${C}/sites`, { name: 'Immeuble R+2', status: 'active', budget: 50000000 });
    r = await staff('POST', `${O}/ai/chat`, { module: 'construction', message: 'Mes chantiers ?' });
    check('IA chantiers (membre) : pas de montants', r.status === 200 && /Immeuble/.test(seen.system) && !/marché/.test(seen.system.split('CHANTIERS')[1] || ''), seen.system.slice(-400));
    r = await owner('POST', `${O}/ai/chat`, { module: 'general', message: 'Résumé' });
    check('IA générale : fonctionne avec les nouveaux modules', r.status === 200, r.json);
    check('données IA limitées en taille', seen.system.slice(seen.system.lastIndexOf('<donnees>')).length < 16100, seen.system.length);

    // suppression en cascade
    r = await owner('DELETE', `${C}/sites/${site}`);
    check('chantier supprimé', r.status === 200, r.json);
    r = await owner('GET', `${C}/sites/${site}`);
    check('chantier supprimé -> 404', r.status === 404, r.json);
  } catch (e) {
    failed++; console.log('  ECHEC exception', e && e.stack || e);
  } finally {
    child.kill(); fake.close(); await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échec(s).`);
  if (failed) console.log(out.split('\n').filter((l) => /erreur|error/i.test(l)).slice(-10).join('\n'));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
