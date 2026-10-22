'use strict';
// Test du groupe « commerce » : Marketing, Logistique, Juridique et conformité (base temporaire, faux serveur d'IA, aucun appel externe).
// Lancez-le avec : node scripts/test-commerce.js
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const { startTestPg } = require('./lib/testdb');

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const raw = Buffer.isBuffer(body);
    const headers = body !== undefined ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text();
    let json = null;
    try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t, headers: res.headers };
  };
}

function fakeClaude(port) {
  const seen = { last: null };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b || '{}');
      seen.last = { system: Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n\n') : (j.system || ''), messages: j.messages };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'Réponse de test.' }] }));
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, seen })));
}

async function main() {
  const fport = await freePort();
  const fake = await fakeClaude(fport);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const pgt = await startTestPg();
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url,
    ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fport}`, ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', TRUST_PROXY: '0', WS_AI_FREE: '100', AI_PER_MINUTE: '500', SIGNUP_VERIFY: 'off', API_PUBLIC_URL: base };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }

  try {
    const stamp = Date.now();
    const owner = client(base); const mgr = client(base); const mem = client(base); const other = client(base);
    const reg = (c, name) => c('POST', '/api/register', { name, contact: `${name.toLowerCase()}${stamp}@exemple.com`, pass: 'secret123' });
    for (const [c, n] of [[owner, 'Awa'], [mgr, 'Marc'], [mem, 'Paul'], [other, 'Zoe']]) await reg(c, n);
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', currency: 'FCFA' });
    const org = r.json.id;
    r = await other('POST', '/api/ws/orgs', { name: 'Autre Société' });
    const org2 = r.json.id;
    const ws = (id) => `/api/ws/orgs/${id}`;
    for (const [c, role] of [[mgr, 'manager'], [mem, 'member']]) {
      r = await owner('POST', `${ws(org)}/invites`, { role });
      r = await c('POST', '/api/ws/orgs/join', { code: r.json.code });
      check(`rejoindre (${role})`, r.status === 200, r.json);
    }
    r = await mgr('GET', ws(org));
    const mgrId = r.json.me.userId;
    check('modules marketing, logistics présents ; legal pour le responsable', ['marketing', 'logistics', 'legal'].every((id) => r.json.modules.some((m) => m.id === id)), r.json.modules.map((m) => m.id));
    r = await mem('GET', ws(org));
    check('le simple membre ne voit pas « legal »', r.json.modules.some((m) => m.id === 'marketing') && !r.json.modules.some((m) => m.id === 'legal'));

    // Données de l'assistant commercial, posées directement en base
    const dbx = await pgt.open();
    const now = new Date().toISOString();
    const mkCust = async (o, name, stage, source) => Number((await dbx.prepare('INSERT INTO customers (org_id, name, phone, stage, source, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(o, name, '677112233', stage, source, now)).lastInsertRowid);
    const mkChat = async (o, s, campaign, cust) => Number((await dbx.prepare('INSERT INTO chats (org_id, session, customer_id, campaign, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(o, s, cust, campaign, now, now)).lastInsertRowid);
    const mkOrder = async (o, cust, chat, status, total, n) => Number((await dbx.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, issued, created_by, created_at, updated_at, chat_id) VALUES (?, ?, 'order', ?, ?, '[]', ?, ?, 1, ?, ?, ?)").run(o, cust, n, status, total, day(0), now, now, chat)).lastInsertRowid);
    const c1 = await mkCust(org, 'Client Un', 'client', 'FB-RENTREE');
    const c2 = await mkCust(org, 'Prospect Deux', 'prospect', 'fb-rentree');
    const c3 = await mkCust(org, 'Client Trois', 'client', 'AUTRE');
    const x1 = await mkCust(org2, 'Étranger', 'client', 'FB-RENTREE');
    const ch1 = await mkChat(org, 's1', 'FB-RENTREE', c1);
    await mkChat(org, 's2', 'fb-rentree', c2);
    await mkChat(org, 's3', 'FB-RENTREE', null);
    const ch4 = await mkChat(org, 's4', 'AUTRE', c3);
    const chx = await mkChat(org2, 's5', 'FB-RENTREE', x1);
    await mkOrder(org, c1, ch1, 'confirmed', 40000, 'C-T-1');
    await mkOrder(org, c1, ch1, 'pending', 10000, 'C-T-2');
    await mkOrder(org, c1, ch1, 'cancelled', 99999, 'C-T-3');
    const ord4 = await mkOrder(org, c3, ch4, 'invoiced', 5000, 'C-T-4');
    await mkOrder(org2, x1, chx, 'confirmed', 777000, 'C-T-5');

    console.log('Marketing');
    const M = `${ws(org)}/marketing`;
    r = await mem('POST', `${M}/campaigns`, { name: 'X' });
    check('membre ne crée pas de campagne -> 403', r.status === 403, r.json);
    r = await mgr('POST', `${M}/campaigns`, { name: '' });
    check('nom obligatoire -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${M}/campaigns`, { name: 'Rentrée', code: 'avec espace' });
    check('code invalide -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${M}/campaigns`, { name: 'Rentrée', channel: 'telepathie' });
    check('canal inconnu -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${M}/campaigns`, { name: 'Rentrée', startDate: '2026-05-10', endDate: '2026-05-01' });
    check('fin avant début -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${M}/campaigns`, { name: 'Rentrée Facebook', channel: 'facebook', objective: 'Vendre des pagnes', budget: '20 000', status: 'active', code: 'FB-RENTREE' });
    check('campagne créée', r.status === 201, r.json);
    const camp = r.json.id;
    r = await mgr('POST', `${M}/campaigns`, { name: 'Doublon', code: 'fb-rentree' });
    check('code déjà utilisé (sans tenir compte des majuscules) -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${M}/campaigns`, { name: 'Radio locale', channel: 'radio', code: 'AUTRE', budget: 0, status: 'draft' });
    const camp2 = r.json.id;
    r = await mem('GET', M);
    const mine = r.json.campaigns.find((c) => c.id === camp);
    check('lecture par un membre', r.status === 200 && r.json.campaigns.length === 2, r.json);
    check('conversations = 3 (codes comparés sans majuscules, autre organisation exclue)', mine.chats === 3, mine);
    check('prospects = 2 (client Un + prospect Deux)', mine.prospects === 2, mine);
    check('clients convertis = 1', mine.converted === 1, mine);
    check('commandes = 2 (annulée exclue)', mine.orders === 2, mine);
    check('chiffre d\'affaires = 40000 (seule la commande confirmée)', mine.revenue === 40000, mine);
    check('coût par prospect = 10000 ; retour = 100 %', mine.costPerProspect === 10000 && mine.roi === 100, mine);
    const other2 = r.json.campaigns.find((c) => c.id === camp2);
    check('sans budget ni dépense : pas de coût ni de retour affichés ; CA 5000 (facturée)', other2.costPerProspect === null && other2.roi === null && other2.revenue === 5000, other2);
    check('tableau de bord : 1 active, meilleure campagne = Rentrée Facebook', r.json.summary.active === 1 && r.json.summary.best.name === 'Rentrée Facebook', r.json.summary);
    check('prospects générés ce mois comptés', r.json.summary.prospectsMonth === 3, r.json.summary);
    r = await other('GET', `${ws(org2)}/marketing`);
    check('autre organisation : aucune campagne, aucun CA', r.status === 200 && r.json.campaigns.length === 0, r.json);

    r = await mem('PUT', `${M}/campaigns/${camp}`, { budget: 999999, status: 'ended' });
    check('un membre peut changer le statut', r.status === 200, r.json);
    r = await mgr('GET', M);
    check('…mais pas le budget', r.json.campaigns.find((c) => c.id === camp).budget === 20000 && r.json.campaigns.find((c) => c.id === camp).status === 'ended', r.json.campaigns);
    await mgr('PUT', `${M}/campaigns/${camp}`, { status: 'active', budget: 30000 });
    r = await other('PUT', `${ws(org2)}/marketing/campaigns/${camp}`, { name: 'Pirate' });
    check('modifier la campagne d\'une autre organisation -> 404', r.status === 404, r.json);

    r = await mem('POST', `${M}/campaigns/${camp}/expenses`, { amount: 100 });
    check('dépense : membre -> 403', r.status === 403, r.json);
    r = await mgr('POST', `${M}/campaigns/${camp}/expenses`, { amount: -5 });
    check('dépense négative -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${M}/campaigns/${camp}/expenses`, { amount: '5 000', label: 'Publicité Facebook' });
    check('dépense sans budget (pas de confirmation)', r.status === 201 && r.json.inBudget === false, r.json);
    r = await owner('GET', `${ws(org)}/budget`);
    check('rien dans le budget', r.json.expense === 0, r.json);
    r = await mgr('POST', `${M}/campaigns/${camp}/expenses`, { amount: 5000, label: 'Boost', toBudget: true });
    const exp2 = r.json.id;
    check('dépense confirmée vers le budget', r.status === 201 && r.json.inBudget === true, r.json);
    r = await owner('GET', `${ws(org)}/budget`);
    check('sortie « Marketing » de 5000 au budget', r.json.expense === 5000 && r.json.categories[0].category === 'Marketing', r.json);
    r = await mgr('GET', M);
    const m2 = r.json.campaigns.find((c) => c.id === camp);
    check('coût calculé sur les dépenses (10000) : 5000 par prospect, retour 300 %', m2.spent === 10000 && m2.costPerProspect === 5000 && m2.roi === 300, m2);
    check('dépense du mois = 10000', r.json.summary.monthSpend === 10000, r.json.summary);
    r = await mgr('DELETE', `/api/ws/orgs/${org}/marketing/expenses/${exp2}`);
    r = await owner('GET', `${ws(org)}/budget`);
    check('supprimer la dépense retire sa ligne de budget', r.json.expense === 0, r.json);

    r = await mem('POST', `${M}/posts`, { date: day(2), channel: 'whatsapp', text: 'Nouvelle collection ce samedi !', campaignId: camp });
    check('publication créée par un membre', r.status === 201, r.json);
    const post = r.json.id;
    r = await mem('POST', `${M}/posts`, { date: 'demain', text: 'x' });
    check('date invalide -> 400', r.status === 400, r.json);
    r = await mem('POST', `${M}/posts`, { date: day(1), text: 'x', campaignId: 999999 });
    check('campagne inconnue -> 404', r.status === 404, r.json);
    r = await mem('PUT', `${M}/posts/${post}`, { status: 'ready' });
    r = await mem('GET', M);
    check('publication prête, liée à la campagne', r.json.posts.length === 1 && r.json.posts[0].status === 'ready' && r.json.posts[0].campaign === 'Rentrée Facebook', r.json.posts);
    r = await mem('DELETE', `${M}/posts/${post}`);
    check('publication supprimée', r.status === 200);

    r = await mem('POST', `${M}/offers`, { name: 'Promo', kind: 'percent', value: 10 });
    check('offre : membre -> 403', r.status === 403, r.json);
    r = await mgr('POST', `${M}/offers`, { name: 'Promo', kind: 'percent', value: 150 });
    check('remise > 100 % -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${M}/offers`, { name: 'Soldes de fin de mois', kind: 'percent', value: 15, startDate: day(-5), endDate: day(-1) });
    const offer = r.json.id;
    check('offre créée', r.status === 201, r.json);
    r = await mem('GET', M);
    check('offre expirée signalée', r.json.offers[0].expired === true, r.json.offers);
    r = await mgr('DELETE', `${M}/offers/${offer}`);
    check('offre supprimée', r.status === 200);

    r = await mem('POST', `${ws(org)}/ai/chat`, { module: 'marketing', message: 'Rédige une publicité' });
    const sysM = fake.seen.last.system;
    check('IA marketing : campagnes et résultats dans le contexte, consignes du module', r.status === 200 && sysM.includes('Rentrée Facebook') && sysM.includes('3 conversation') && sysM.includes('Tu aides à préparer et suivre les campagnes'), sysM.slice(0, 300));
    check('IA marketing pour un membre : pas de chiffre d\'affaires ni de budget', !/CA \d/.test(sysM) && !sysM.includes('budget 30'), sysM.slice(-500));
    check('le contexte ne contient pas les données de l\'autre organisation', !sysM.includes('777'));
    r = await mgr('DELETE', `${M}/campaigns/${camp2}`);
    check('suppression de campagne par un responsable', r.status === 200);
    r = await mem('DELETE', `${M}/campaigns/${camp}`);
    check('suppression de campagne : membre -> 403', r.status === 403);

    console.log('Logistique');
    const L = `${ws(org)}/logistics`;
    r = await mgr('POST', `${L}/zones`, { name: 'Douala centre', fee: 1500, delayDays: 1 });
    const zone = r.json.id;
    check('zone créée', r.status === 201, r.json);
    r = await mem('POST', `${L}/zones`, { name: 'Z' });
    check('zone : membre -> 403', r.status === 403, r.json);
    r = await mgr('POST', `${L}/zones`, { name: 'Z2', delayDays: 400 });
    check('délai invalide -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${L}/carriers`, { name: 'Moto Express', contact: '699 00 11 22', zones: 'Douala', rate: 1000 });
    const car = r.json.id;
    check('transporteur créé', r.status === 201, r.json);
    r = await mem('GET', `${L}/carriers`);
    check('transporteurs lisibles par un membre', r.status === 200 && r.json.carriers.length === 1 && r.json.carriers[0].rate === 1000, r.json);
    r = await mem('GET', `${L}/documents`);
    check('commandes à lier listées sans montants', r.status === 200 && r.json.documents.length === 3 && r.json.documents.every((d) => d.total === undefined), r.json);
    const docId = r.json.documents.find((d) => d.number === 'C-T-4').id;
    r = await mem('POST', `${L}/deliveries`, { docId, address: 'Akwa, rue 12', zoneId: zone, carrierId: car });
    check('livraison liée à une commande : client, téléphone, frais et date repris', r.status === 201, r.json);
    const del = r.json.id;
    r = await mem('GET', `${L}/deliveries/${del}`);
    check('détail : client de la commande, frais de la zone, date J+1, historique initial', r.json.delivery.customerName === 'Client Trois' && r.json.delivery.phone === '677112233' && r.json.delivery.fee === 1500 && r.json.delivery.plannedDate === day(1) && r.json.events.length === 1 && r.json.delivery.docNumber === 'C-T-4', r.json);
    r = await mem('POST', `${L}/deliveries`, { docId: 999999 });
    check('commande inconnue -> 404', r.status === 404, r.json);
    r = await mem('POST', `${L}/deliveries`, { customerName: '' });
    check('client obligatoire -> 400', r.status === 400, r.json);
    r = await mem('POST', `${L}/deliveries`, { customerName: 'X', fee: -3 });
    check('frais négatifs -> 400', r.status === 400, r.json);
    r = await mem('POST', `${L}/deliveries`, { customerName: 'Y', zoneId: 999999 });
    check('zone inconnue -> 404', r.status === 404, r.json);
    r = await mem('POST', `${L}/deliveries`, { customerName: 'Mariam', phone: '237 677 00 11 22', address: 'Bonanjo', plannedDate: day(-2), fee: 2000 });
    const late = r.json.id;
    r = await mem('POST', `${L}/deliveries`, { customerName: 'Hervé', plannedDate: day(0), fee: 500 });
    const todayDel = r.json.id;
    r = await mem('GET', L);
    check('tableau de bord : 3 en cours, 1 aujourd\'hui, 1 en retard', r.json.summary.open === 3 && r.json.summary.today === 1 && r.json.summary.late === 1 && r.json.deliveries.find((d) => d.id === late).late === true, r.json.summary);
    check('frais du mois = 4000', r.json.summary.monthCost === 4000, r.json.summary);
    r = await mem('PUT', `${L}/deliveries/${late}/status`, { status: 'delivered' });
    check('livrée sans preuve -> 400', r.status === 400, r.json);
    r = await mem('PUT', `${L}/deliveries/${late}/status`, { status: 'volée' });
    check('statut inconnu -> 400', r.status === 400, r.json);
    r = await mem('PUT', `${L}/deliveries/${late}/status`, { status: 'on_route' });
    r = await mem('PUT', `${L}/deliveries/${late}/status`, { status: 'delivered', receivedBy: 'Sa sœur Aïcha', proof: 'Signature sur le carnet' });
    check('livrée avec preuve', r.status === 200, r.json);
    r = await mem('PUT', `${L}/deliveries/${todayDel}/status`, { status: 'failed' });
    check('échec sans motif -> 400', r.status === 400, r.json);
    r = await mem('PUT', `${L}/deliveries/${todayDel}/status`, { status: 'failed', note: 'Client absent' });
    r = await mem('GET', `${L}/deliveries/${late}`);
    check('historique horodaté (3 étapes) et preuve conservée', r.json.events.length === 3 && r.json.events[2].status === 'delivered' && /Aïcha/.test(r.json.events[2].note) && r.json.delivery.receivedBy === 'Sa sœur Aïcha' && r.json.events.every((e) => /^\d{4}-/.test(e.at)), r.json);
    r = await mem('GET', L);
    check('taux de réussite 50 % (1 livrée, 1 échec) ; plus de retard', r.json.summary.successRate === 50 && r.json.summary.late === 0, r.json.summary);

    r = await mem('GET', `${L}/deliveries/${late}/notify`);
    check('lien WhatsApp wa.me avec message prérempli', r.status === 200 && r.json.url.startsWith('https://wa.me/237677001122?text=') && decodeURIComponent(r.json.url).includes('Mariam') && /livrée/.test(r.json.message), r.json);
    r = await mem('POST', `${L}/deliveries`, { customerName: 'Sans numéro', plannedDate: day(-1) });
    const nn = r.json.id;
    r = await mem('GET', `${L}/deliveries/${nn}/notify`);
    check('sans numéro : pas de lien, avertissement ; message de retard', r.json.url === null && r.json.warning && /retard/.test(r.json.message), r.json);

    r = await mem('POST', `${L}/rounds`, { name: 'Tournée du matin', date: day(0), carrierId: car });
    const round = r.json.id;
    check('tournée créée', r.status === 201, r.json);
    r = await mem('POST', `${L}/rounds`, { name: 'Sans jour' });
    check('tournée sans jour -> 400', r.status === 400, r.json);
    r = await mem('PUT', `${L}/rounds/${round}/order`, { deliveryIds: [todayDel, del, todayDel] });
    check('livraison en double -> 400', r.status === 400, r.json);
    r = await mem('PUT', `${L}/rounds/${round}/order`, { deliveryIds: [del, todayDel, 999999] });
    check('livraison inconnue -> 404', r.status === 404, r.json);
    r = await mem('PUT', `${L}/rounds/${round}/order`, { deliveryIds: [todayDel, del] });
    r = await mem('GET', `${L}/rounds`);
    check('ordre de passage respecté', r.json.rounds[0].deliveries.map((d) => d.id).join() === [todayDel, del].join() && r.json.rounds[0].carrier === 'Moto Express', r.json);
    r = await mem('DELETE', `${L}/rounds/${round}`);
    check('supprimer une tournée : membre -> 403', r.status === 403);

    r = await other('GET', `${ws(org2)}/logistics`);
    check('isolation : l\'autre organisation ne voit aucune livraison', r.json.deliveries.length === 0 && r.json.summary.open === 0, r.json);
    r = await other('GET', `${ws(org2)}/logistics/deliveries/${del}`);
    check('livraison d\'une autre organisation -> 404', r.status === 404, r.json);
    r = await other('POST', `${ws(org2)}/logistics/deliveries`, { docId });
    check('lier une commande d\'une autre organisation -> 404', r.status === 404, r.json);
    r = await other('PUT', `${ws(org2)}/logistics/deliveries/${del}/status`, { status: 'shipped' });
    check('changer le statut d\'une livraison étrangère -> 404', r.status === 404, r.json);

    r = await mem('POST', `${ws(org)}/ai/chat`, { module: 'logistics', message: 'Où en sont les livraisons ?' });
    check('IA logistique : contexte livraisons', r.status === 200 && fake.seen.last.system.includes('LOGISTIQUE') && fake.seen.last.system.includes('Sans numéro') && fake.seen.last.system.includes('EN RETARD'), fake.seen.last.system.slice(0, 200));
    r = await mem('DELETE', `${L}/deliveries/${nn}`);
    check('supprimer une livraison : membre -> 403', r.status === 403);
    r = await mgr('DELETE', `${L}/deliveries/${nn}`);
    check('supprimer une livraison : responsable', r.status === 200);
    r = await mgr('DELETE', `${L}/zones/${zone}`);
    r = await mem('GET', `${L}/deliveries/${del}`);
    check('supprimer une zone garde la livraison', r.status === 200 && r.json.delivery.zoneId === null, r.json);

    console.log('Juridique et conformité');
    const J = `${ws(org)}/legal`;
    for (const p of ['', '/contracts', '/obligations', '/disputes', '/privacy']) { r = await mem('GET', J + p); check(`membre -> 403 sur /legal${p}`, r.status === 403, r.json); }
    r = await mem('POST', `${ws(org)}/ai/chat`, { module: 'legal', message: 'Que dois-je renouveler ?' });
    check('IA juridique refusée à un membre -> 403', r.status === 403, r.json);
    r = await mgr('POST', `${J}/contracts`, { title: '' });
    check('titre de contrat obligatoire -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/contracts`, { title: 'X', type: 'magique' });
    check('type inconnu -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/contracts`, { title: 'X', startDate: day(10), endDate: day(1) });
    check('fin avant début -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/contracts`, { title: 'X', noticeDays: -4 });
    check('préavis négatif -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/contracts`, { title: 'Bail du magasin', type: 'lease', parties: 'Awa et M. Njoya', amount: 150000, startDate: day(-300), endDate: day(20), tacit: true, noticeDays: 15, status: 'active', docRef: 'Classeur A, p. 3' });
    const k1 = r.json.id;
    check('contrat créé', r.status === 201, r.json);
    r = await mgr('POST', `${J}/contracts`, { title: 'Assurance incendie', type: 'insurance', endDate: day(5), noticeDays: 30 });
    const k2 = r.json.id;
    r = await mgr('POST', `${J}/contracts`, { title: 'Fournisseur de tissu', type: 'supplier', endDate: day(-10) });
    const k3 = r.json.id;
    r = await mgr('POST', `${J}/contracts`, { title: 'Contrat lointain', type: 'client', endDate: day(200) });
    r = await mgr('GET', `${J}/contracts`);
    const byId = Object.fromEntries(r.json.contracts.map((c) => [c.id, c]));
    check('bail : fin dans 20 jours (alerte 30 j) et préavis à J+5 (alerte 7 j)', byId[k1].alerts.some((a) => a.code === 'end30') && byId[k1].alerts.some((a) => a.code === 'notice7') && byId[k1].noticeDate === day(5), byId[k1]);
    check('assurance : fin dans 5 jours (alerte 7 j) et préavis dépassé', byId[k2].alerts.some((a) => a.code === 'end7') && byId[k2].alerts.some((a) => a.code === 'notice_passed'), byId[k2]);
    check('fournisseur : expiré', byId[k3].expired === true, byId[k3]);
    r = await mgr('GET', J);
    check('tableau de bord : 2 à renouveler, 1 expiré, échéances à venir', r.json.summary.toRenew === 2 && r.json.summary.expired === 1 && r.json.summary.upcoming >= 3, r.json.summary);
    r = await mgr('PUT', `${J}/contracts/${k3}`, { status: 'terminated' });
    r = await mgr('GET', J);
    check('contrat résilié : n\'alerte plus', r.json.summary.expired === 0, r.json.summary);
    r = await other('PUT', `${ws(org2)}/legal/contracts/${k1}`, { title: 'Pirate' });
    check('contrat d\'une autre organisation -> 404', r.status === 404, r.json);
    r = await other('GET', `${ws(org2)}/legal/contracts`);
    check('isolation des contrats', r.json.contracts.length === 0, r.json);

    r = await mgr('POST', `${J}/obligations`, { title: 'Renouveler la licence commerciale', kind: 'license', dueDate: day(-3), recurrenceMonths: 12, responsibleId: mgrId });
    const o1 = r.json.id;
    check('obligation créée', r.status === 201, r.json);
    r = await mgr('POST', `${J}/obligations`, { title: 'Déclaration annuelle', kind: 'declaration', dueDate: day(10), responsibleId: 99999 });
    check('responsable hors organisation -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/obligations`, { title: 'Affichage des prix', kind: 'display', dueDate: day(10) });
    const o2 = r.json.id;
    r = await mgr('GET', `${J}/obligations`);
    check('obligation en retard + responsable nommé + membres', r.json.obligations.find((o) => o.id === o1).overdue === true && r.json.obligations.find((o) => o.id === o1).responsible === 'Marc' && r.json.members.length === 3, r.json);
    r = await mgr('GET', J);
    check('tableau de bord : 1 obligation en retard', r.json.summary.overdue === 1 && r.json.overdueObligations[0].title.includes('licence'), r.json);
    r = await mgr('POST', `${J}/obligations/${o1}/done`, { proof: 'Reçu n° 123' });
    check('« fait » sur une obligation récurrente : échéance reportée d\'un an', r.status === 200 && r.json.repeats === true, r.json);
    r = await mgr('GET', `${J}/obligations`);
    const ob1 = r.json.obligations.find((o) => o.id === o1);
    check('prochaine échéance dans le futur, toujours à faire, preuve et date notées', ob1.status === 'pending' && ob1.dueDate > day(300) && ob1.overdue === false && ob1.proof === 'Reçu n° 123' && ob1.lastDone === day(0), ob1);
    r = await mgr('POST', `${J}/obligations/${o2}/done`, {});
    r = await mgr('POST', `${J}/obligations/${o2}/done`, {});
    check('obligation ponctuelle terminée : on ne peut pas la refaire -> 400', r.status === 400, r.json);

    r = await mgr('POST', `${J}/disputes`, { title: 'Impayé du client X', kind: 'dispute', counterparty: 'Client X', amount: 80000, nextStep: 'Envoyer la mise en demeure', nextDate: day(3) });
    const dp = r.json.id;
    check('litige créé', r.status === 201, r.json);
    r = await mgr('POST', `${J}/disputes`, { title: 'Y', status: 'perdu' });
    check('statut inconnu -> 400', r.status === 400, r.json);
    r = await mgr('PUT', `${J}/disputes/${dp}`, { status: 'closed', outcome: 'Payé en deux fois' });
    r = await mgr('GET', `${J}/disputes`);
    check('litige clos', r.json.disputes[0].status === 'closed' && r.json.disputes[0].outcome === 'Payé en deux fois', r.json);

    r = await mgr('POST', `${J}/privacy`, { dataKind: '' });
    check('ligne du registre : donnée obligatoire -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/privacy`, { dataKind: 'Nom et téléphone des clients', storedWhere: 'MANAGER-IA, carnet papier', purpose: 'Livrer et facturer', retention: '3 ans après le dernier achat' });
    const pv = r.json.id;
    check('ligne du registre créée', r.status === 201, r.json);
    r = await mgr('GET', `${J}/privacy`);
    check('registre lisible', r.json.items.length === 1 && r.json.items[0].retention.includes('3 ans'), r.json);
    r = await other('GET', `${ws(org2)}/legal/privacy`);
    check('isolation du registre', r.json.items.length === 0, r.json);
    r = await other('DELETE', `${ws(org2)}/legal/privacy/${pv}`);
    check('supprimer la ligne d\'une autre organisation -> 404', r.status === 404, r.json);

    r = await mgr('POST', `${ws(org)}/ai/chat`, { module: 'legal', message: 'Quelles échéances ?' });
    const sysL = fake.seen.last.system;
    check('IA juridique : échéances dans le contexte et consigne « pas un avis juridique »', r.status === 200 && sysL.includes('Bail du magasin') && sysL.includes("ne remplaces pas un avocat"), sysL.slice(0, 300));
    r = await mem('POST', `${ws(org)}/ai/chat`, { module: 'general', message: 'Où en suis-je ?' });
    check('IA générale pour un membre : aucune donnée juridique', r.status === 200 && fake.seen.last.system.includes('JURIDIQUE ET CONFORMITÉ : non accessible') && !fake.seen.last.system.includes('Bail du magasin'), fake.seen.last.system.slice(0, 200));
    r = await mgr('DELETE', `${J}/contracts/${k1}`);
    check('suppression de contrat', r.status === 200);
    r = await mgr('GET', `${J}/contracts/${k1}`);
    check('route inexistante -> 404', r.status === 404);

    // ---- Juridique : modèles, pièces jointes, historique, signature, rappels ----
    console.log('Juridique : modèles, pièces jointes, historique, signature, rappels');
    for (const [m, p] of [['GET', '/templates'], ['GET', '/files?parentType=contract&parentId=1'], ['POST', '/templates']]) { r = await mem(m, J + p, m === 'GET' ? undefined : {}); check(`membre -> 403 sur ${m} /legal${p.split('?')[0]}`, r.status === 403, r.json); }
    r = await mgr('GET', `${J}/templates`);
    const ids = r.json.templates.map((t) => t.id);
    const docs = r.json.templates.filter((t) => t.kind === 'document');
    check('11 modèles de documents fournis, marqués « fournis »', docs.length === 11 && docs.every((t) => t.builtin === true), docs.length);
    check('chaque modèle fourni porte la mention de relecture et des champs', docs.every((t) => t.body.includes('Modèle informatif à faire relire par un professionnel du droit') && t.fields.length >= 3));
    check('aucun modèle fourni ne prétend être conforme', docs.every((t) => !/\bconforme?s?\b|officiel/i.test(t.body)));
    check('exemples d\'obligations et de registre fournis, identifiants uniques', r.json.templates.some((t) => t.kind === 'obligation') && r.json.templates.some((t) => t.kind === 'privacy') && new Set(ids).size === ids.length);
    for (const t of ['demande', 'termination', 'lease', 'amendment', 'settlement', 'proxy', 'rules', 'privacy-policy']) if (t !== 'demande') check(`modèle b:${t} présent`, ids.includes('b:' + t));
    r = await mgr('PUT', `${J}/templates/b:demand`, { title: 'Pirate', body: 'x' });
    check('modifier un modèle fourni -> 403', r.status === 403, r.json);
    r = await mgr('DELETE', `${J}/templates/b:demand`);
    check('supprimer un modèle fourni -> 403', r.status === 403, r.json);
    r = await mgr('POST', `${J}/templates`, { title: '', body: 'x' });
    check('modèle sans nom -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/templates`, { title: 'Vide', body: '   ' });
    check('modèle sans texte -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/templates`, { title: 'Long', body: 'a'.repeat(12001) });
    check('texte de modèle trop long -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/templates`, { title: 'X', kind: 'magique', body: 'a' });
    check('type de modèle inconnu -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/templates`, { kind: 'obligation', title: 'Y', data: { title: 'Z', recurrenceMonths: 999 } });
    check('récurrence hors limites dans un modèle d\'obligation -> 400', r.status === 400, r.json);
    r = await mgr('POST', `${J}/templates`, { title: 'Lettre de rappel', body: 'Bonjour {{client_nom}},\nMerci de régler {{montant}} avant le {{date_limite}}. {{montant}}' });
    const tpl = r.json.id;
    check('modèle de l\'organisation créé', r.status === 201 && tpl, r.json);
    r = await mgr('GET', `${J}/templates`);
    const myT = r.json.templates.find((t) => t.id === tpl);
    check('champs {{nom}} détectés une seule fois, dans l\'ordre', myT && !myT.builtin && myT.fields.map((x) => x.key).join(',') === 'client_nom,montant,date_limite', myT);
    r = await mgr('PUT', `${J}/templates/${tpl}`, { title: 'Lettre de rappel v2', body: 'Bonjour {{nom}}' });
    r = await mgr('GET', `${J}/templates`);
    check('modèle modifié', r.json.templates.find((t) => t.id === tpl).title === 'Lettre de rappel v2' && r.json.templates.find((t) => t.id === tpl).fields.length === 1);
    r = await other('GET', `${ws(org2)}/legal/templates`);
    check('isolation : l\'autre organisation ne voit que les modèles fournis', r.status === 403 || !r.json.templates.some((t) => t.id === tpl), r.status);
    r = await mgr('POST', `${J}/templates/b:lease/duplicate`);
    const dup = r.json.id;
    check('dupliquer un modèle fourni', r.status === 201 && dup, r.json);
    r = await mgr('GET', `${J}/templates`);
    const dupT = r.json.templates.find((t) => t.id === dup);
    check('la copie est modifiable et garde le texte', dupT && dupT.builtin === false && dupT.title.includes('(copie)') && dupT.body.includes('{{landlord}}') && dupT.body.includes('relire par un professionnel'), dupT && dupT.title);
    r = await mgr('POST', `${J}/templates/${tpl}/duplicate`);
    check('dupliquer un modèle de l\'organisation', r.status === 201, r.json);
    r = await mgr('POST', `${J}/templates/b:inconnu/duplicate`);
    check('dupliquer un modèle inexistant -> 404', r.status === 404, r.json);
    r = await mgr('DELETE', `${J}/templates/${dup}`);
    check('supprimer un modèle de l\'organisation', r.status === 200, r.json);
    r = await mgr('POST', `${J}/templates`, { kind: 'privacy', title: 'Lignes RH', data: { dataKind: 'Photos du personnel', people: 'Employés' } });
    check('modèle de ligne du registre créé', r.status === 201, r.json);

    // Pièces jointes
    const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n'), Buffer.alloc(300, 65)]);
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
    const upl = (c, base, type, id, name, buf) => c('POST', `${base}/files?parentType=${type}&parentId=${id}&name=${encodeURIComponent(name)}`, buf);
    r = await mgr('POST', `${J}/contracts`, { title: 'Bail pour pièces jointes', type: 'lease', endDate: day(100), assigneeId: mgrId });
    const kf = r.json.id;
    r = await upl(mgr, J, 'contract', kf, 'bail signé.pdf', PDF);
    const f1 = r.json && r.json.id;
    check('PDF ajouté au contrat', r.status === 201 && r.json.mime === 'application/pdf' && r.json.name === 'bail signé.pdf', r.json);
    r = await upl(mgr, J, 'contract', kf, 'scan.png', PNG);
    check('image PNG ajoutée', r.status === 201 && r.json.mime === 'image/png', r.json);
    r = await upl(mgr, J, 'contract', kf, 'virus.pdf', Buffer.from('MZ\x90\x00 programme dangereux, pas un pdf du tout'));
    check('fichier d\'un autre type (même nommé .pdf) refusé -> 400', r.status === 400, r.json);
    r = await upl(mgr, J, 'contract', kf, 'page.pdf', Buffer.from('<html><script>alert(1)</script></html>'));
    check('HTML refusé -> 400', r.status === 400, r.json);
    r = await upl(mgr, J, 'contract', kf, 'gros.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024 + 10, 66)]));
    check('fichier de plus de 2 Mo -> 413', r.status === 413, r.json);
    r = await upl(mgr, J, 'contract', 999999, 'x.pdf', PDF);
    check('pièce jointe sur un contrat inexistant -> 404', r.status === 404, r.json);
    r = await upl(mgr, J, 'chose', kf, 'x.pdf', PDF);
    check('type de dossier inconnu -> 400', r.status === 400, r.json);
    r = await upl(other, `${ws(org2)}/legal`, 'contract', kf, 'x.pdf', PDF);
    check('ajouter un fichier au contrat d\'une autre organisation -> 404', r.status === 404, r.json);
    r = await upl(mem, J, 'contract', kf, 'x.pdf', PDF);
    check('membre : envoi refusé -> 403', r.status === 403, r.json);
    r = await mgr('GET', `${J}/files?parentType=contract&parentId=${kf}`);
    check('liste des fichiers du contrat (2)', r.json.files.length === 2 && r.json.limits.maxBytes === 2097152, r.json);
    r = await mgr('GET', `${J}/contracts`);
    check('le contrat affiche 2 pièces jointes', r.json.contracts.find((c) => c.id === kf).filesCount === 2);
    r = await mgr('GET', `${J}/files/${f1}/file`);
    check('téléchargement : contenu identique, type vérifié, en-têtes de sécurité', r.status === 200 && r.text.startsWith('%PDF-') && r.headers.get('content-type') === 'application/pdf' && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('content-security-policy').includes('sandbox') && r.headers.get('cache-control').includes('no-store') && r.headers.get('content-disposition').startsWith('attachment'), [...r.headers.entries()]);
    r = await mem('GET', `${J}/files/${f1}/file`);
    check('membre : téléchargement refusé -> 403', r.status === 403, r.json);
    r = await other('GET', `${ws(org2)}/legal/files/${f1}/file`);
    check('téléchargement d\'un fichier d\'une autre organisation -> 404', r.status === 404, r.json);
    r = await other('DELETE', `${ws(org2)}/legal/files/${f1}`);
    check('suppression d\'un fichier d\'une autre organisation -> 404', r.status === 404, r.json);
    r = await owner('POST', `${ws(org)}/legal/obligations`, { title: 'Obligation avec fichier', dueDate: day(40) });
    const of1 = r.json.id;
    r = await upl(mgr, J, 'obligation', of1, 'recu', PDF);
    check('fichier sur une obligation (extension ajoutée au nom)', r.status === 201 && r.json.name === 'recu.pdf', r.json);
    r = await mgr('POST', `${J}/disputes`, { title: 'Dossier avec fichier', assigneeId: mgrId, docRef: 'Classeur B' });
    const df1 = r.json.id;
    r = await upl(mgr, J, 'dispute', df1, 'courrier.png', PNG);
    check('fichier sur un litige', r.status === 201, r.json);
    r = await mgr('GET', `${J}/disputes`);
    check('litige : pièce jointe, référence et personne attribuée', r.json.disputes.find((d) => d.id === df1).filesCount === 1 && r.json.disputes.find((d) => d.id === df1).docRef === 'Classeur B' && r.json.disputes.find((d) => d.id === df1).assignee === 'Marc');
    r = await mgr('POST', `${J}/disputes`, { title: 'Z', assigneeId: 99999 });
    check('litige attribué à quelqu\'un d\'une autre organisation -> 400', r.status === 400, r.json);
    r = await mgr('DELETE', `${J}/disputes/${df1}`);
    r = await mgr('GET', `${J}/files?parentType=dispute&parentId=${df1}`);
    check('supprimer un litige supprime ses fichiers (liste -> 404)', r.status === 404, r.json);

    // Historique et signature
    r = await mgr('PUT', `${J}/contracts/${kf}`, { title: 'Bail renouvelé', amount: 200000, signStatus: 'to_sign', signers: 'Awa, M. Njoya' });
    check('contrat modifié', r.status === 200, r.json);
    r = await mgr('PUT', `${J}/contracts/${kf}`, { signStatus: 'signed' });
    r = await mgr('GET', `${J}/contracts`);
    const kc = r.json.contracts.find((c) => c.id === kf);
    check('signature : signé, date du jour par défaut, signataires, pas de valeur légale affichée', kc.signStatus === 'signed' && kc.signedAt === day(0) && kc.signers === 'Awa, M. Njoya' && kc.assignee === 'Marc', kc);
    r = await mgr('PUT', `${J}/contracts/${kf}`, { signStatus: 'signed', signedAt: day(3) });
    check('date de signature dans le futur -> 400', r.status === 400, r.json);
    r = await mgr('PUT', `${J}/contracts/${kf}`, { signStatus: 'peut-etre' });
    check('statut de signature inconnu -> 400', r.status === 400, r.json);
    r = await mgr('PUT', `${J}/contracts/${kf}`, { assigneeId: 99999 });
    check('rappel attribué hors organisation -> 400', r.status === 400, r.json);
    r = await mgr('PUT', `${J}/contracts/${kf}`, { signStatus: 'none' });
    r = await mgr('GET', `${J}/contracts`);
    check('retour « sans suivi » : date effacée', r.json.contracts.find((c) => c.id === kf).signedAt === null);
    r = await mgr('PUT', `${J}/contracts/${kf}`, { title: 'Bail renouvelé' });
    r = await mgr('GET', `${J}/contracts/${kf}/history`);
    const h = r.json.history;
    check('historique : création + 4 modifications, plus récent en premier, sans modification vide', r.status === 200 && h.length === 4 && h[h.length - 1].action === 'Contrat créé', h.map((x) => x.action));
    const hc = h.flatMap((x) => x.changes);
    check('historique : qui, quoi (ancienne et nouvelle valeur) et quand', h.every((x) => x.userName === 'Marc' && x.at) && hc.some((c) => c.field === 'title' && c.from === 'Bail pour pièces jointes' && c.to === 'Bail renouvelé') && hc.some((c) => c.field === 'sign_status' && c.to === 'Signé') && hc.some((c) => c.field === 'amount' && c.to === '200000'), hc);
    r = await other('GET', `${ws(org2)}/legal/contracts/${kf}/history`);
    check('historique d\'une autre organisation -> 404', r.status === 404, r.json);
    r = await mem('GET', `${J}/contracts/${kf}/history`);
    check('historique : membre -> 403', r.status === 403, r.json);

    // Rappels : une seule alerte par élément, attribuée, visible dans « Alertes » et dans le contexte de l'IA
    r = await mgr('POST', `${J}/contracts`, { title: 'Contrat à rappeler', endDate: day(6), noticeDays: 3, assigneeId: mgrId, signStatus: 'to_sign' });
    const kr = r.json.id;
    r = await mgr('POST', `${J}/disputes`, { title: 'Dossier à suivre', nextStep: 'Appeler le client', nextDate: day(5), assigneeId: mgrId });
    r = await mgr('GET', `${ws(org)}/dashboard/alerts`);
    const al = (r.json.alerts || []).filter((a) => a.module === 'legal');
    check('« Alertes » : rappels juridiques présents, attribués à la personne', al.length >= 2 && al.some((a) => a.text.includes('Contrat à rappeler') && a.text.includes('attribué à')) && al.some((a) => a.text.includes('Dossier à suivre')), r.status + ' ' + JSON.stringify(al));
    check('pas de doublon : un seul rappel pour le contrat (fin et préavis fusionnés)', al.filter((a) => a.title.includes('à renouveler') && a.text.includes('Contrat à rappeler')).length === 1, al);
    check('rappel à moins de 7 jours : urgent', al.find((a) => a.title.includes('à renouveler') && a.text.includes('Contrat à rappeler')).level === 'high');
    r = await mgr('GET', `${ws(org)}/dashboard/alerts`);
    check('relire les alertes ne crée pas de doublon', r.json.alerts.filter((a) => a.module === 'legal' && a.title.includes('à renouveler') && a.text.includes('Contrat à rappeler')).length === 1);
    r = await mem('GET', `${ws(org)}/dashboard/alerts`);
    check('le simple membre ne voit aucun rappel juridique', r.status === 200 && !(r.json.alerts || []).some((a) => a.module === 'legal'), r.status);
    r = await mgr('POST', `${ws(org)}/ai/chat`, { module: 'legal', message: 'Mes rappels ?' });
    const sysR = fake.seen.last.system;
    check('IA : rappels attribués et contrats à signer dans le contexte, sans valeur légale', r.status === 200 && sysR.includes('Contrat à rappeler') && sysR.includes('attribué à Marc') && sysR.includes('à signer') && sysR.includes("n'est pas une signature électronique"), sysR.slice(0, 600));
    r = await mgr('DELETE', `${J}/contracts/${kr}`);
    r = await mgr('DELETE', `${J}/contracts/${kf}`);
    r = await mgr('GET', `${J}/files?parentType=contract&parentId=${kf}`);
    check('supprimer un contrat supprime ses fichiers', r.status === 404, r.json);
    r = await mgr('GET', `${J}/contracts/${kf}/history`);
    check('historique d\'un contrat supprimé -> 404', r.status === 404, r.json);
  } finally {
    if (process.env.SMOKE_LOG) console.log('--- journal du serveur ---\n' + out.split('\n').filter((l) => !/ -> 2\d\d /.test(l)).slice(-25).join('\n'));
    child.kill();
    fake.srv.close();
    await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
