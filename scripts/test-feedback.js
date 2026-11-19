'use strict';
// Avis et recommandations : saisie validée, anonymat, consentement et témoignages publics, capture d'écran (type vérifié), limitation de fréquence,
// isolation par organisation, administration (liste filtrable, statuts, notes internes, indicateurs, CSV, résumé), notification par e-mail (dégradée sans erreur),
// droits des personnes (export, suppression). Aucun appel externe.
// Lancez-le avec : node scripts/test-feedback.js
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = {};
    if (body !== undefined && !Buffer.isBuffer(body)) headers['content-type'] = 'application/json';
    if (Buffer.isBuffer(body)) headers['content-type'] = 'application/octet-stream';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binaire */ }
    return { status: res.status, json, buf, headers: res.headers, text: buf.toString('utf8') };
  };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 1, 0, 0, 0, 1, 0]), Buffer.alloc(64, 7)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' + ' '.repeat(40));
const HTML = Buffer.from('<html><script>alert(1)</script></html>' + ' '.repeat(40));

async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', WS_AI_FREE: '500', AI_PER_MINUTE: '500', FEEDBACK_MIN_GAP_S: '0', FEEDBACK_PER_DAY: '50' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const notify = require('../src/services/notify');
  const F = require('../src/services/feedback');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const awa = client(base); const paul = client(base); const zoe = client(base); const admin = client(base); const anon = client(base);
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'secret123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const awaId = await reg(awa, 'Awa Bello Ntamack', 'aw'); await reg(paul, 'Paul Etoga', 'pa'); const zoeId = await reg(zoe, 'Zoé Mbarga', 'zo');
    let r = await awa('POST', '/api/ws/orgs', { name: 'Boutique Awa', currency: 'FCFA' }); const org1 = r.json.id; const F1 = `/api/ws/orgs/${org1}/feedback`;
    r = await paul('POST', '/api/ws/orgs', { name: 'Garage Paul', currency: 'FCFA' }); const org2 = r.json.id; const F2 = `/api/ws/orgs/${org2}/feedback`;
    r = await zoe('POST', '/api/ws/orgs', { name: 'Zoé Conseil', currency: 'FCFA' }); const F3 = `/api/ws/orgs/${r.json.id}/feedback`;
    const lg = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin-test', password: 'mot-de-passe-admin-test' }) });
    const adminCookie = lg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const adm = async (method, url, body) => { const x = await fetch(base + '/api/admin/feedback' + url, { method, headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const buf = Buffer.from(await x.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* */ } return { status: x.status, json, buf, text: buf.toString('utf8'), headers: x.headers }; };
    void admin; void anon;

    console.log('Accès et validation');
    r = await fetch(`${base}/api/ws/orgs/${org1}/feedback/meta`);
    check('sans connexion : refusé (401)', r.status === 401);
    r = await paul('GET', `/api/ws/orgs/${org1}/feedback/meta`);
    check('hors de l’organisation : introuvable (404)', r.status === 404);
    r = await awa('GET', `${F1}/meta`);
    check('méta : types, modules, limites ; le module avis n’est pas un module du menu', r.status === 200 && r.json.kinds.length === 4 && r.json.modules[0].id === 'general' && r.json.modules.some((m) => m.id === 'stock') && !r.json.modules.some((m) => m.id === 'feedback') && r.json.limits.screenshotBytes === 2 * 1048576, r.json);
    for (const [name, body] of [['sans note', { kind: 'review' }], ['note 0', { stars: 0 }], ['note 6', { stars: 6 }], ['note décimale', { stars: 3.5 }], ['note texte', { stars: 'abc' }], ['score 11', { stars: 4, nps: 11 }], ['score -1', { stars: 4, nps: -1 }], ['type inconnu', { stars: 4, kind: 'insulte' }], ['module inconnu', { stars: 4, module: '../etc' }], ['suggestion vide', { stars: 4, kind: 'suggestion', body: 'ok' }], ['public sur un problème', { stars: 4, kind: 'problem', body: 'Le bouton ne marche pas', publicConsent: true }], ['public sans texte', { stars: 5, publicConsent: true }], ['message énorme', { stars: 4, body: 'x'.repeat(5000) }]]) {
      r = await awa('POST', F1, body);
      check(`refus : ${name} (400)`, r.status === 400, [r.status, r.json]);
    }
    check('rien n’a été enregistré par les refus', Number((await db.prepare('SELECT COUNT(*) AS n FROM fb_feedback').get()).n) === 0);

    console.log('Envoi d’un avis et notification du fondateur');
    const sent = [];
    notify.mailEnabled = () => false; // e-mail non configuré : dégradation propre
    r = await awa('POST', F1, { kind: 'review', module: 'stock', stars: 5, nps: 10, body: 'Très pratique pour ma boutique, le stock est clair. <script>alert(1)</script>', publicConsent: true, page: '/app/5/stock?x=1' });
    const id1 = r.json && r.json.id;
    check('avis créé (201)', r.status === 201 && id1 > 0, r.json);
    await sleep(300);
    let row = await db.prepare('SELECT * FROM fb_feedback WHERE id = ?').get(id1);
    check('e-mail non configuré : pas d’erreur, avis enregistré, notification marquée', row && row.notified_at && Number(row.stars) === 5 && Number(row.nps) === 10 && row.module === 'stock' && row.page === '/app/·/stock', row);
    check('nom public réduit : prénom + initiale du dernier nom', row.display_name === 'Awa N.', row.display_name);
    check('le texte est gardé tel quel (échappé à l’affichage), jamais interprété', row.body.includes('<script>'));
    notify.mailEnabled = () => true; notify.sendMail = async (m) => { sent.push(m); return true; };
    r = await paul('POST', F2, { kind: 'problem', module: 'crm', stars: 2, nps: 3, body: 'Le tableau des clients est lent.\nSubject: injection\nBcc: x@y.z', anonymous: true });
    const id2 = r.json.id; await sleep(300);
    check('e-mail configuré : un message au fondateur par avis', sent.length === 1 && sent[0].to && /Nouvel avis 2\/5/.test(sent[0].subject) && !/[\r\n]/.test(sent[0].subject), sent);
    check('avis anonyme : ni nom ni organisation dans l’e-mail', /anonyme/.test(sent[0].text) && !/Paul|Garage/.test(sent[0].text), sent[0].text);
    check('e-mail en texte brut (pas de HTML)', sent[0].html === undefined);
    row = await db.prepare('SELECT * FROM fb_feedback WHERE id = ?').get(id2);
    check('anonyme : aucun user_id ni nom enregistré dans l’avis', row.user_id === null && row.display_name === '' && Number(row.anonymous) === 1, row);
    check('WhatsApp : point d’extension désactivé par défaut', F.channelOn('whatsapp') === false);
    process.env.FEEDBACK_WHATSAPP = 'on';
    check('même avec le drapeau, sans canal branché il reste éteint', F.channelOn('whatsapp') === false);
    delete process.env.FEEDBACK_WHATSAPP;
    notify.sendMail = async () => { throw new Error('SMTP en panne'); };
    r = await zoe('POST', F3, { kind: 'comment', stars: 4, nps: 8, body: 'Interface claire dans l’ensemble.' });
    await sleep(300);
    check('e-mail en panne : l’avis est tout de même accepté, sans erreur', r.status === 201);
    notify.sendMail = async (m) => { sent.push(m); return true; };
    r = await zoe('POST', F3, { kind: 'suggestion', module: 'accounting', stars: 3, body: 'Ajouter un export Excel de la balance.' });
    const id4 = r.json.id;
    r = await paul('POST', F2, { kind: 'review', module: 'stock', stars: 1, nps: 0, body: 'Pas satisfait des rapports de stock.' });
    const id5 = r.json.id;

    console.log('Isolation et droits de l’auteur');
    r = await awa('GET', `${F1}/mine`);
    check('« mes avis » : seulement les miens', r.status === 200 && r.json.items.length === 1 && r.json.items[0].id === id1 && r.json.items[0].publicConsent === true && r.json.items[0].published === false, r.json);
    check('l’auteur ne voit jamais de note interne', !JSON.stringify(r.json).includes('note'));
    r = await paul('GET', `${F2}/mine`);
    check('l’auteur anonyme retrouve ses avis (même anonymes)', r.json.items.length === 2 && r.json.items.some((x) => x.anonymous), r.json);
    r = await paul('PUT', `/api/ws/orgs/${org2}/feedback/mine/${id1}/consent`, { publicConsent: false });
    check('l’avis d’une autre personne et d’une autre organisation est introuvable (404)', r.status === 404);
    r = await paul('DELETE', `${F2}/mine/${id1}`);
    check('suppression de l’avis d’autrui impossible (404)', r.status === 404 && !!(await db.prepare('SELECT 1 FROM fb_feedback WHERE id = ?').get(id1)));
    r = await awa('GET', `${F1}/mine/${id2}/screenshot`);
    check('capture d’autrui introuvable (404)', r.status === 404);

    console.log('Capture d’écran');
    r = await awa('POST', `${F1}/${id1}/screenshot`, SVG);
    check('SVG refusé (script possible)', r.status === 400);
    r = await awa('POST', `${F1}/${id1}/screenshot`, HTML);
    check('page web refusée même annoncée comme image', r.status === 400);
    r = await awa('POST', `${F1}/${id1}/screenshot`, Buffer.concat([PNG, Buffer.alloc(2.5 * 1048576)]));
    check('image trop lourde refusée (413)', r.status === 413, r.status);
    r = await paul('POST', `${F2}/${id1}/screenshot`, PNG);
    check('on ne joint pas une capture à l’avis d’un autre (404)', r.status === 404);
    r = await awa('POST', `${F1}/${id1}/screenshot`, PNG);
    check('PNG valide accepté (201)', r.status === 201 && r.json.size === PNG.length, r.json);
    r = await awa('POST', `${F1}/${id1}/screenshot`, PNG);
    check('une seule capture par avis (409)', r.status === 409);
    r = await awa('GET', `${F1}/mine/${id1}/screenshot`);
    check('l’auteur relit sa capture : type fixé par le serveur, nosniff, sandbox, pas de cache', r.status === 200 && r.headers.get('content-type') === 'image/png' && r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy')) && /no-store/.test(r.headers.get('cache-control')) && r.buf.equals(PNG));
    check('la capture est chiffrée au repos', !(await db.prepare('SELECT shot FROM fb_feedback WHERE id = ?').get(id1)).shot.includes(Buffer.from('IHDR')));

    console.log('Limitation de fréquence');
    process.env.FEEDBACK_PER_DAY = '3'; // zoé a déjà 2 avis
    r = await zoe('POST', F3, { stars: 4, body: 'Troisième avis du jour.' });
    check('troisième avis accepté', r.status === 201);
    r = await zoe('POST', F3, { stars: 4, body: 'Quatrième avis du jour.' });
    check('au-delà du plafond quotidien : 429', r.status === 429 && /demain/.test(r.json.error), r.json);
    process.env.FEEDBACK_PER_DAY = '50'; process.env.FEEDBACK_MIN_GAP_S = '60';
    r = await awa('POST', F1, { stars: 4, body: 'Un deuxième tout de suite.' });
    check('deux envois à moins d’une minute : 429', r.status === 429, r.json);
    process.env.FEEDBACK_MIN_GAP_S = '0';

    console.log('Témoignages publics');
    r = await fetch(base + '/api/ws/public/testimonials');
    let pj = await r.json();
    check('avant approbation : aucun témoignage public (sans connexion)', r.status === 200 && pj.items.length === 0, pj);
    r = await adm('GET', '');
    check('administration : liste (au moins 5 avis)', r.status === 200 && r.json.total >= 5, r.status);
    r = await adm('PUT', `/${id5}`, { approved: true });
    check('approuver sans consentement de l’auteur : refusé (409)', r.status === 409, r.json);
    r = await adm('PUT', `/${id1}`, { approved: true });
    check('approuver un avis consenti : ok', r.status === 200 && r.json.item.approved === true, r.json);
    pj = await (await fetch(base + '/api/ws/public/testimonials')).json();
    check('le témoignage approuvé + consenti est public, avec prénom et initiale', pj.items.length === 1 && pj.items[0].name === 'Awa N.' && pj.items[0].stars === 5 && pj.items[0].moduleTitle === 'Stock et achats', pj);
    check('aucune donnée privée dans la réponse publique : seulement id, note, texte, prénom, module, date', pj.items.every((x) => Object.keys(x).sort().join() === 'at,id,moduleTitle,name,stars,text') && !JSON.stringify(pj).includes('@'), pj);
    check('le texte est livré brut : l’échappement est fait à l’affichage (React)', pj.items[0].text.includes('<script>'));
    // avis anonyme + consentement : jamais de nom
    r = await paul('PUT', `/api/ws/orgs/${org2}/feedback/mine/${id5}/consent`, { publicConsent: true });
    check('l’auteur peut donner son consentement après coup', r.status === 200 && r.json.item.publicConsent === true);
    await db.prepare('UPDATE fb_feedback SET anonymous = 1, user_id = NULL, display_name = ? WHERE id = ?').run('Paul E.', id5); // donnée incohérente forcée : le nom ne doit JAMAIS sortir
    r = await adm('PUT', `/${id5}`, { approved: true });
    pj = await (await fetch(base + '/api/ws/public/testimonials')).json();
    check('avis anonyme approuvé : affiché SANS nom, même si un nom traînait en base', pj.items.some((x) => x.id === id5 && x.name === '') && !JSON.stringify(pj).includes('Paul'), pj);
    r = await adm('PUT', `/${id5}`, { approved: false });
    check('retrait de l’approbation par l’administrateur', r.status === 200 && r.json.item.approved === false);
    r = await awa('PUT', `${F1}/mine/${id1}/consent`, { publicConsent: false });
    check('l’auteur retire son consentement', r.status === 200 && r.json.item.publicConsent === false && r.json.item.published === false);
    pj = await (await fetch(base + '/api/ws/public/testimonials')).json();
    check('le témoignage disparaît aussitôt de l’affichage public', pj.items.length === 0, pj);
    row = await db.prepare('SELECT approved_at FROM fb_feedback WHERE id = ?').get(id1);
    check('et l’approbation est annulée (un nouveau consentement demandera une nouvelle approbation)', row.approved_at === null);
    r = await adm('PUT', `/${id1}`, { approved: true });
    check('on ne peut plus approuver sans consentement (409)', r.status === 409);

    console.log('Administration');
    r = await fetch(base + '/api/admin/feedback');
    check('sans session administrateur : refusé (401)', r.status === 401);
    r = await awa('GET', '/api/admin/feedback');
    check('un utilisateur ordinaire n’est pas administrateur (401)', r.status === 401);
    r = await adm('GET', '?stars=1');
    check('filtre par note', r.json.items.length === 1 && r.json.items[0].id === id5, r.json);
    r = await adm('GET', '?kind=suggestion');
    check('filtre par type', r.json.items.length === 1 && r.json.items[0].id === id4 && r.json.items[0].kindLabel === 'Suggestion');
    r = await adm('GET', '?module=crm');
    check('filtre par module', r.json.items.length === 1 && r.json.items[0].id === id2);
    r = await adm('GET', '?status=new');
    check('filtre par statut', r.json.total >= 5 && r.json.items.every((x) => x.status === 'new'));
    r = await adm('GET', '?q=lent');
    check('recherche dans le texte', r.json.items.length === 1 && r.json.items[0].id === id2);
    r = await adm('GET', '?q=%25');
    check('le « % » de la recherche est littéral', r.status === 200 && r.json.items.length === 0);
    r = await adm('GET', '?kind=nimporte');
    check('filtre invalide : 400', r.status === 400);
    r = await adm('GET', '');
    const a2 = r.json.items.find((x) => x.id === id2); const a1 = r.json.items.find((x) => x.id === id1);
    check('avis anonyme : ni nom ni organisation côté administrateur', a2.anonymous === true && a2.author === null && !JSON.stringify(a2).includes('Paul') && !JSON.stringify(a2).includes('Garage'), a2);
    check('avis nominatif : nom et organisation visibles', a1.author && a1.author.org === 'Boutique Awa' && /Awa/.test(a1.author.name), a1);
    r = await adm('GET', `/${id1}`);
    check('détail : passe « nouveau » à « lu »', r.status === 200 && r.json.item.status === 'read' && r.json.item.hasScreenshot === true);
    r = await adm('GET', `/${id1}/screenshot`);
    check('l’administrateur voit la capture (type fixé, nosniff)', r.status === 200 && r.headers.get('content-type') === 'image/png' && r.headers.get('x-content-type-options') === 'nosniff');
    r = await adm('PUT', `/${id1}`, { status: 'in_progress', note: 'Appeler Awa pour comprendre l’usage du stock.' });
    check('statut + réponse interne', r.status === 200 && r.json.item.status === 'in_progress' && r.json.notes.length === 1 && r.json.item.notes === 1, r.json);
    r = await adm('PUT', `/${id1}`, { status: 'inconnu' });
    check('statut inconnu : 400', r.status === 400);
    r = await adm('PUT', `/${id1}`, {});
    check('requête vide : 400', r.status === 400);
    r = await adm('PUT', `/${id1}`, { status: 'done' }); r = await adm('PUT', `/${id1}`, { status: 'archived' });
    check('cycle complet des statuts (nouveau, lu, en cours, traité, archivé)', r.json.item.status === 'archived');
    r = await awa('GET', `${F1}/mine`);
    check('la note interne n’est visible ni dans « mes avis » ni dans l’export de l’auteur', !JSON.stringify(r.json).includes('Appeler Awa'));
    r = await adm('GET', '/stats?days=30');
    const s = r.json;
    check('indicateurs : total, note moyenne, NPS, répartition', s.total === 6 && s.average > 0 && s.nps.n === 4 && typeof s.nps.score === 'number' && s.distribution.reduce((a, b) => a + b, 0) === 6, s);
    check('NPS = % promoteurs - % détracteurs (scores 10, 8, 3, 0 → 1 promoteur, 1 passif, 2 détracteurs → -25)', s.nps.promoters === 1 && s.nps.detractors === 2 && s.nps.score === -25, s.nps);
    check('évolution par jour et modules les plus cités', s.series.length === 30 && s.topModules[0].count >= 1 && s.topModules.some((m) => m.module === 'stock' && m.count === 2), s.topModules);
    r = await adm('GET', '/export.csv');
    check('export CSV : BOM, en-têtes français, point-virgule', r.status === 200 && r.text.startsWith('﻿id;date;type;module;note') && /text\/csv/.test(r.headers.get('content-type')));
    check('CSV : pas d’identité pour l’avis anonyme', !r.text.includes('Garage Paul') && r.text.includes('Boutique Awa'));
    await awa('POST', F1, { stars: 3, body: '=HYPERLINK("http://x.test","clic")' });
    r = await adm('GET', '/export.csv');
    check('CSV : cellule commençant par = neutralisée', r.text.includes('"\'=HYPERLINK'), r.text.slice(-200));
    r = await adm('GET', '/digest');
    check('résumé quotidien : texte lisible, canaux', r.status === 200 && /Avis reçus le/.test(r.json.text) && typeof r.json.channels.email === 'boolean' && r.json.channels.whatsapp === false, r.json);
    // résumé quotidien automatique
    sent.length = 0;
    await db.prepare("UPDATE fb_feedback SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 86400000).toISOString(), id2);
    await db.prepare("DELETE FROM fb_state WHERE k = 'last_digest'").run();
    const origHour = Date.prototype.getUTCHours; Date.prototype.getUTCHours = function () { return 8; };
    const did = await F.runDigest(); const again = await F.runDigest();
    Date.prototype.getUTCHours = origHour;
    check('le résumé de la veille part une seule fois par jour, par e-mail', did === true && again === false && sent.length === 1 && /Résumé des avis/.test(sent[0].subject), [did, again, sent.length]);
    notify.mailEnabled = () => false; await db.prepare("DELETE FROM fb_state WHERE k = 'last_digest'").run();
    Date.prototype.getUTCHours = function () { return 8; };
    let err = null; let res2 = null; try { res2 = await F.runDigest(); } catch (e) { err = e; }
    Date.prototype.getUTCHours = origHour;
    check('sans e-mail configuré : le résumé ne plante pas', err === null && res2 === false, String(err));
    const nrows = await db.prepare("SELECT * FROM notifications WHERE type = 'avis'").all();
    check('chaque avis laisse une trace dans les notifications du fondateur', nrows.length >= 4, nrows.length);
    const audited = await db.prepare("SELECT action FROM audit_trail WHERE action LIKE 'feedback.%'").all();
    check('journal d’audit : création, capture, consentement, mises à jour par l’administrateur', ['feedback.create', 'feedback.screenshot', 'feedback.consent_withdrawn', 'feedback.admin_update'].every((a) => audited.some((x) => x.action === a)), [...new Set(audited.map((x) => x.action))]);

    console.log('Droits des personnes');
    r = await awa('GET', '/api/privacy/export');
    check('export de mes données : mes avis nominatifs inclus', r.status === 200 && r.json.tables.fb_feedback && r.json.tables.fb_feedback.some((x) => x.body.includes('Très pratique')) && !JSON.stringify(r.json).includes('Appeler Awa'), Object.keys(r.json.tables));
    r = await paul('GET', '/api/privacy/export');
    const ex = r.json;
    check('export : mes avis anonymes inclus aussi, sans empreinte ni capture', (ex.tables.fb_feedback_anonymes || []).length >= 1 && !JSON.stringify(ex).includes('author_hash') && !JSON.stringify(ex).match(/[0-9a-f]{64}/));
    r = await awa('GET', `/api/privacy/orgs/${org1}/export`);
    check('l’export d’organisation ne contient pas les avis envoyés à la plateforme', r.status === 200 && !r.json.tables.fb_feedback && !JSON.stringify(r.json).includes('Très pratique'));
    r = await awa('DELETE', `${F1}/mine/${id1}`);
    check('l’auteur supprime son avis (et sa capture)', r.status === 200 && !(await db.prepare('SELECT 1 FROM fb_feedback WHERE id = ?').get(id1)));
    r = await adm('GET', `/${id1}`);
    check('supprimé : introuvable côté administrateur aussi (404)', r.status === 404);
    const priv = require('../src/security/privacy');
    await priv.anonymizeUser(zoeId);
    const zrows = await db.prepare('SELECT * FROM fb_feedback WHERE org_id = (SELECT org_id FROM fb_feedback WHERE id = ?)').all(id4);
    check('suppression du compte : texte, nom et capture effacés, témoignage retiré, notes chiffrées gardées', zrows.length >= 2 && zrows.every((x) => x.body === '' && x.display_name === '' && x.user_id === null && x.author_hash === '' && Number(x.public_consent) === 0 && x.approved_at === null && Number(x.stars) >= 1), zrows[0]);
    void awaId;
    r = await awa('DELETE', `/api/ws/orgs/${org1}`); void r;
    console.log('Suppression d’une organisation');
    const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM fb_feedback WHERE org_id = ?').get(org2)).n);
    await db.prepare('DELETE FROM orgs WHERE id = ?').run(org2);
    check('les avis d’une organisation supprimée disparaissent avec elle', before > 0 && Number((await db.prepare('SELECT COUNT(*) AS n FROM fb_feedback WHERE org_id = ?').get(org2)).n) === 0);
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close();
  process.exit(failed ? 1 : 0);
}
main();
