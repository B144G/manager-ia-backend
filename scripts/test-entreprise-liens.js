'use strict';
// Compte d'entreprise, étape 4 : organisations liées par lien d'association (lien à usage unique, copie de la structure, DG commun, abonnement de l'entreprise principale,
// affectations propres à chaque organisation, isolation). Lancez-le avec : npm run test:entreprise-liens
const { startTestPg } = require('./lib/testdb');
let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = {}; if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
}
async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'BREVO_API_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0' });
  const { app } = require('../src/server');
  const { db, MIGRATIONS } = require('../src/db');
  await db.ready;
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'Secret-Pass-123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const owner = client(base); const adm = client(base); const mem = client(base); const bOwner = client(base); const cOwner = client(base); const dOwner = client(base); const stranger = client(base);
    const ownerId = await reg(owner, 'Nkoulou Paul', 'nk'); const admId = await reg(adm, 'Admin Bella', 'ad'); await reg(mem, 'Membre Zoé', 'me'); const bId = await reg(bOwner, 'Directrice Filiale B', 'bo'); await reg(cOwner, 'Directeur C', 'co'); await reg(dOwner, 'Directeur D', 'do'); await reg(stranger, 'Étranger', 'st');
    const plan = (id, p) => db.prepare('UPDATE users SET plan = ?, plan_expires = ? WHERE id = ?').run(p, new Date(Date.now() + 86400000 * 30).toISOString(), id);
    await plan(ownerId, 'Pro');
    const org = (await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' })).json.id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
    let r = await owner('POST', `${O}/invites`, { role: 'admin' }); await adm('POST', '/api/ws/orgs/join', { code: r.json.code });
    r = await owner('POST', `${O}/invites`, { role: 'member' }); await mem('POST', '/api/ws/orgs/join', { code: r.json.code });
    await owner('POST', `${E}/template`, { sector: 'commerce' });
    const chart = (await owner('GET', `${E}/chart`)).json;
    const flat = (ch) => [...ch.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...ch.departments.flatMap((x) => x.posts)];
    const nPosts = flat(chart).length;
    const entId = Number((await db.prepare('SELECT entreprise_id FROM orgs WHERE id = ?').get(org)).entreprise_id);

    console.log('Migrations');
    check('migrations 430 à 432 (liens, origine, journal) ; 422 à 429 réservées', /ent_links/.test(MIGRATIONS[429]) && /linked_via/.test(MIGRATIONS[430]) && /ent_link_log/.test(MIGRATIONS[431]) && MIGRATIONS.slice(421, 429).every((m) => /reserve/.test(m)), MIGRATIONS.length);

    console.log('Création du lien (direction générale)');
    r = await mem('POST', `${E}/links`, { label: 'Filiale B' });
    check('un membre ne crée pas de lien (403)', r.status === 403);
    r = await adm('POST', `${E}/links`, { label: 'Filiale B' });
    check('un administrateur qui n\'est pas de la direction générale non plus (403)', r.status === 403 && /direction générale/.test(r.json.error), r.json);
    r = await owner('POST', `${E}/links`, { label: 'Filiale B', days: 7 });
    const L1 = r.json;
    check('le propriétaire (DG) crée un lien à copier', r.status === 201 && /^ASSO-[0-9A-F]{6}(-[0-9A-F]{6}){4}$/.test(L1.code), r.json);
    const row = await db.prepare('SELECT * FROM ent_links WHERE id = ?').get(L1.id);
    check('seule l\'empreinte du code est conservée (jamais le code)', row.token_hash.length === 64 && !JSON.stringify(await db.prepare('SELECT * FROM ent_links').all()).includes(L1.code.slice(5, 15)));
    r = await owner('GET', `${E}/links`);
    check('la liste montre le lien sans son code (4 derniers caractères seulement)', r.json.links[0].hint === L1.code.slice(-4) && !JSON.stringify(r.json).includes(L1.code) && r.json.links[0].status === 'pending', r.json.links[0]);
    check('… et les organisations de l\'entreprise avec leurs limites d\'abonnement', r.json.orgs.length === 1 && r.json.orgs[0].main && r.json.limits.orgs === 3, r.json.limits);
    check('un membre ne voit pas la liste (seulement sa place)', (await mem('GET', `${E}/links`)).json.links === undefined);
    check('sans connexion : 401', (await client(base)('GET', `${E}/links`)).status === 401);

    console.log('Utilisation du lien : création de l\'organisation liée');
    r = await bOwner('POST', '/api/ws/orgs/link/preview', { code: 'ASSO-FAUX-FAUX-FAUX' });
    const badMsg = r.json && r.json.error;
    check('un faux lien est refusé avec un message clair', r.status === 400 && /invalide, expiré ou déjà utilisé/.test(badMsg), r.json);
    r = await bOwner('POST', '/api/ws/orgs/link/preview', { code: L1.code.toLowerCase() });
    check('l\'aperçu donne le nom de l\'entreprise et la copie de la structure (code insensible à la casse)', r.status === 200 && r.json.company === 'Atelier Nkoulou' && r.json.copyStructure === true, r.json);
    check('sans connexion, pas d\'aperçu', (await client(base)('POST', '/api/ws/orgs/link/preview', { code: L1.code })).status === 401);
    r = await bOwner('POST', '/api/ws/orgs', { name: 'Filiale B', currency: 'FCFA', associationCode: L1.code });
    const orgB = r.json.id; const OB = `/api/ws/orgs/${orgB}`; const EB = `${OB}/entreprise`;
    check('la personne crée son organisation avec le code collé (même si son offre est Gratuite)', r.status === 201 && orgB > org, r.json);
    const ob = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgB);
    check('l\'organisation est rattachée à la MÊME entreprise (pas une nouvelle)', Number(ob.entreprise_id) === entId && Number(ob.linked_via) === L1.id && Number((await db.prepare('SELECT COUNT(*) c FROM entreprises').get()).c) === 1);
    check('son créateur en est le propriétaire', (await bOwner('GET', OB)).json.me.role === 'owner');
    r = await owner('GET', OB);
    check('direction générale commune : le DG de l\'entreprise est administrateur de l\'organisation liée', r.status === 200 && r.json.me.role === 'admin', r.json.me);
    check('… et voit la même entreprise', (await owner('GET', EB)).json.entreprise.name === 'Atelier Nkoulou');
    const chartB = (await bOwner('GET', `${EB}/chart`)).json;
    check('la structure de l\'entreprise est copiée (directions, départements, postes, secteur)', flat(chartB).length === nPosts && chartB.directions.length === chart.directions.length && (await bOwner('GET', EB)).json.setup.template === 'commerce', [flat(chartB).length, nPosts]);
    check('… sans aucune personne ni affectation', flat(chartB).every((p) => p.holders.length === 0) && Number((await db.prepare('SELECT COUNT(*) c FROM ent_assignments WHERE org_id = ?').get(orgB)).c) === 0);
    check('… et les postes de l\'organisation principale ne sont pas partagés (copies indépendantes)', flat(chartB).every((p) => !flat(chart).some((q) => q.id === p.id)));
    r = await bOwner('POST', '/api/ws/orgs', { name: 'Autre', associationCode: L1.code });
    check('le lien ne sert qu\'une fois', r.status === 400 && r.json.error === badMsg);
    r = await owner('GET', `${E}/links`);
    check('le lien apparaît « utilisé » avec l\'organisation créée ; le journal des rattachements est tenu', r.json.links[0].status === 'used' && r.json.links[0].usedOrgId === orgB && r.json.orgs.length === 2 && r.json.log.some((l) => l.action === 'org_linked'), r.json.links[0]);
    r = await owner('POST', '/api/ws/orgs/link/preview', { code: L1.code });
    check('un lien utilisé n\'a plus d\'aperçu', r.status === 400);

    console.log('Affectations propres à chaque organisation, personnes de l\'entreprise');
    const postsA = flat((await owner('GET', `${E}/chart`)).json); const postsB = flat((await bOwner('GET', `${EB}/chart`)).json);
    const pa = postsA.find((p) => p.title === 'Comptable').id; const pb = postsB.find((p) => p.title === 'Comptable').id;
    check('le comptable de l\'organisation B n\'est pas celui de A (postes distincts)', pa !== pb);
    r = await owner('POST', `${E}/people`, { fullName: 'Comptable Ada', email: `ada${stamp}@entreprise.cm`, postIds: [pa] });
    const ada = client(base); const adaId = await reg(ada, 'Comptable Ada', 'ada'); await ada('POST', '/api/ws/orgs/join', { code: r.json.code });
    r = await bOwner('POST', `${EB}/people`, { fullName: 'Comptable Bako', email: `bako${stamp}@entreprise.cm`, postIds: [pb] });
    const bako = client(base); await reg(bako, 'Comptable Bako', 'bako'); await bako('POST', '/api/ws/orgs/join', { code: r.json.code });
    r = await ada('GET', `${O}/accounting/accounts`);
    check('Ada est comptable de A : accès à la comptabilité de A', r.status === 200);
    r = await bako('GET', `${OB}/accounting/accounts`);
    check('Bako est comptable de B : accès à la comptabilité de B', r.status === 200);
    check('Ada n\'a aucun accès à l\'organisation B (404)', (await ada('GET', OB)).status === 404 && (await ada('GET', `${EB}/chart`)).status === 404);
    check('Bako n\'a aucun accès à l\'organisation A (404)', (await bako('GET', O)).status === 404);
    r = await bOwner('POST', `${EB}/assignments`, { postId: pa, personId: 1 });
    check('B ne peut pas affecter sur un poste de A (404)', r.status === 404);
    check('B ne voit pas les personnes de A', !JSON.stringify((await bOwner('GET', `${EB}/chart`)).json.people).includes('Ada'));
    check('l\'organisation A ne voit pas les personnes de B', !JSON.stringify((await owner('GET', `${E}/chart`)).json.people).includes('Bako'));
    // le DG fait entrer une personne de A dans B
    const adaPerson = (await owner('GET', `${E}/chart`)).json.people.find((p) => p.name === 'Comptable Ada').id;
    r = await owner('GET', `${EB}/people-elsewhere`);
    check('la direction générale voit les personnes de l\'entreprise qui ne sont pas encore dans cette organisation', r.status === 200 && r.json.people.some((x) => x.id === adaPerson), r.json);
    r = await bOwner('GET', `${EB}/people-elsewhere`);
    check('… le propriétaire de B non (403)', r.status === 403);
    r = await bOwner('POST', `${EB}/people/${adaPerson}/enroll`, {});
    check('le propriétaire de B (hors direction générale) ne peut pas faire entrer une personne de A (403)', r.status === 403, r.json);
    r = await owner('POST', `${EB}/people/${adaPerson}/enroll`, { role: 'member', title: 'Comptable (prêt)' });
    check('la direction générale fait entrer une personne de l\'entreprise dans l\'organisation liée', r.status === 201, r.json);
    check('… qui devient membre de B, sans affectation (repli sûr : pas de comptabilité)', (await ada('GET', OB)).status === 200 && (await ada('GET', `${OB}/accounting/accounts`)).status === 403);
    check('… elle ne peut être inscrite deux fois (409)', (await owner('POST', `${EB}/people/${adaPerson}/enroll`, {})).status === 409);
    r = await owner('POST', `${EB}/assignments`, { postId: postsB.find((p) => p.title === 'Trésorier').id, personId: adaPerson });
    check('… puis affectée à un poste de B (trésorière de B) en plus de comptable de A, indépendamment de A', r.status === 201 && (await ada('GET', `${OB}/accounting/accounts`)).status === 200);
    r = await stranger('POST', `${EB}/people/${adaPerson}/enroll`, {});
    check('un étranger à l\'entreprise : 404', r.status === 404);

    console.log('Réglages de l\'entreprise : seulement la direction générale / l\'organisation principale');
    for (const [m, p, b] of [['PUT', '/info', { name: 'Pirate' }], ['PUT', '/dg', { personIds: [adaPerson] }], ['POST', '/company-code'], ['PUT', '/settings', { sensitive2fa: false }], ['POST', '/links', { label: 'x' }]]) {
      r = await bOwner(m, EB + p, b);
      check(`le propriétaire d'une organisation liée ne peut pas : ${m} ${p} (403)`, r.status === 403, [r.status, r.json]);
    }
    check('… les informations de l\'entreprise sont lisibles', (await bOwner('GET', EB)).json.entreprise.name === 'Atelier Nkoulou');
    check('un membre de l\'organisation liée ne voit pas la liste des liens', (await bako('GET', `${EB}/links`)).json.links === undefined);
    r = await bOwner('GET', `${EB}/links`);
    check('… le propriétaire de B voit seulement sa place (organisation liée)', r.json.main === false && r.json.orgs === undefined && r.json.canManage === false, r.json);
    r = await owner('PUT', `${E}/info`, { size: '21-50' });
    check('la direction générale modifie l\'entreprise', r.status === 200 && (await bOwner('GET', EB)).json.entreprise.size === '21-50');

    console.log('Abonnement de l\'entreprise principale');
    await plan(bId, 'Gratuit');
    r = await bOwner('GET', OB);
    check('l\'organisation liée a l\'offre de l\'entreprise principale (Pro : 15 personnes, 5 antennes), pas celle de son créateur', r.json.limits.members === 15 && r.json.org.plan === 'Pro', [r.json.limits, r.json.org.plan]);
    r = await bOwner('POST', `${OB}/branches`, { name: 'Antenne 1' });
    check('les antennes suivent l\'offre de l\'entreprise principale', r.status === 201);
    r = await owner('POST', `${E}/links`, { label: 'Site C' });
    const L2 = r.json;
    r = await cOwner('POST', '/api/ws/orgs', { name: 'Site C', associationCode: L2.code });
    check('deuxième organisation liée créée', r.status === 201);
    r = await owner('POST', `${E}/links`, { label: 'Site D' });
    check('limite d\'organisations de l\'abonnement (Pro : 3) : plus de lien possible (403 avec message clair)', r.status === 403 && /limite d'organisations|permet 3 organisation/.test(r.json.error || ''), r.json);
    await plan(ownerId, 'Illimité');
    r = await owner('POST', `${E}/links`, { label: 'Site D', copyStructure: false });
    const L3 = r.json;
    check('l\'offre supérieure rétablit la possibilité de lier', r.status === 201);
    r = await dOwner('POST', '/api/ws/orgs', { name: 'Site D', associationCode: L3.code });
    const orgD = r.json.id;
    check('lien sans copie de structure : organisation liée vide', r.status === 201 && flat((await dOwner('GET', `/api/ws/orgs/${orgD}/entreprise/chart`)).json).length === 0);
    // révocation et expiration
    r = await owner('POST', `${E}/links`, { label: 'À révoquer' });
    const L4 = r.json;
    r = await owner('DELETE', `${E}/links/${L4.id}`);
    check('révocation immédiate d\'un lien', r.status === 200 && (await bOwner('POST', '/api/ws/orgs/link/preview', { code: L4.code })).status === 400);
    check('un lien déjà révoqué ne se révoque pas deux fois (404)', (await owner('DELETE', `${E}/links/${L4.id}`)).status === 404);
    r = await owner('POST', `${E}/links`, { label: 'Expire' });
    await db.prepare('UPDATE ent_links SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), r.json.id);
    check('un lien expiré est refusé', (await stranger('POST', '/api/ws/orgs', { name: 'X', associationCode: r.json.code })).status === 400);
    r = await stranger('POST', '/api/ws/orgs', { name: 'Sans lien', currency: 'FCFA' });
    check('créer une organisation sans lien reste inchangé (nouvelle entreprise)', r.status === 201 && Number((await db.prepare('SELECT COUNT(*) c FROM entreprises').get()).c) === 2);
    check('le lien d\'une autre entreprise ne rattache rien à la sienne', Number((await db.prepare('SELECT entreprise_id FROM orgs WHERE id = ?').get(r.json.id)).entreprise_id) !== entId);
    r = await stranger('POST', `${E}/links`, { label: 'x' });
    check('un étranger ne peut pas créer de lien pour l\'entreprise (404)', r.status === 404);
    const j = JSON.stringify((await owner('GET', `${E}/log`)).json);
    check('les liens sont journalisés dans le journal d\'audit, sans le code', /ent_link/.test(j) && !j.includes(L1.code));
    r = await owner('POST', '/api/ws/orgs/link/preview', { code: L1.code });
    check('(rappel) aucun secret dans les réponses de liste', !JSON.stringify((await owner('GET', `${E}/links`)).json).includes(L2.code));
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
