'use strict';
// Espaces par rôle : redirection selon le rôle, choix multi-rôles, mode visiteur (lecture seule), écritures refusées, propriétaire / direction, isolation entre entreprises.
// Lancez-le avec : npm run test:espaces
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

function client(base) {
  const jar = {};
  return async (method, url, body, opts = {}) => {
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


async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0' });
  const { app } = require('../src/server');
  const { db, MIGRATIONS } = require('../src/db');
  await db.ready;
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    const owner = client(base); const cpt = client(base); const com = client(base); const mgr = client(base); const nobody = client(base); const other = client(base);
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'secret123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const ownerId = await reg(owner, 'Nkoulou', 'nk'); const cptId = await reg(cpt, 'Comptable Ada', 'cp'); const comId = await reg(com, 'Commerciale Bih', 'co'); const mgrId = await reg(mgr, 'Directeur Eto', 'mg'); const nobodyId = await reg(nobody, 'Sans espace', 'nb'); await reg(other, 'Autre', 'ot');
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`; const S = `${O}/spaces`;
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 86400000 * 30).toISOString(), ownerId);
    for (const [c, role] of [[cpt, 'member'], [com, 'member'], [mgr, 'manager'], [nobody, 'member']]) { r = await owner('POST', `${O}/invites`, { role }); await c('POST', '/api/ws/orgs/join', { code: r.json.code }); }
    r = await other('POST', '/api/ws/orgs', { name: 'Autre société', currency: 'FCFA' }); const org2 = r.json.id; const O2 = `/api/ws/orgs/${org2}`;

    console.log('Migrations');
    check('migrations 170 à 173 aux bons numéros, 150 à 169 vides ou réservées', /space_settings/.test(MIGRATIONS[169]) && /member_spaces/.test(MIGRATIONS[170]) && /member_space_prefs/.test(MIGRATIONS[171]) && /member_photos/.test(MIGRATIONS[172]) && MIGRATIONS.slice(149, 169).every((m) => /reserve|space/.test(m)), MIGRATIONS.length);

    console.log('Activés par défaut pour tout le monde (décision du fondateur)');
    r = await owner('GET', O);
    check('le réglage est ACTIVÉ par défaut (entreprise sans réglage enregistré)', r.json.spaces && r.json.spaces.enabled === true, r.json.spaces);
    check('aucun réglage n\'a été écrit en base : c\'est le défaut qui s\'applique (entreprises existantes comprises)', Number((await db.prepare('SELECT COUNT(*) c FROM space_settings WHERE org_id = ?').get(org)).c) === 0);
    r = await nobody('GET', O);
    check('une personne sans espace affecté garde ses accès : espaces dérivés de ses droits (repli sûr)', r.json.spaces.enabled && r.json.spaces.fallback === true && ['commercial', 'stock', 'projets'].every((id) => r.json.spaces.spaces.some((s) => s.id === id)), r.json.spaces && r.json.spaces.spaces.map((s) => s.id));
    check('… sans aucun relèvement de droits (niveau « membre »)', r.json.spaces.spaces.every((s) => s.level === 'write') && !r.json.spaces.spaces.some((s) => s.modules.some((m) => ['accounting', 'payroll', 'fiscal', 'integrations'].includes(m.id))), r.json.spaces.spaces.map((s) => `${s.id}:${s.level}`));
    r = await nobody('GET', `${O}/stock`);
    check('un membre accède à Stock comme avant', r.status === 200, r.status);
    r = await nobody('POST', `${O}/crm/customers`, { name: 'Client Avant' });
    check('et peut écrire comme avant (ancien comportement)', r.status < 400, [r.status, r.json]);
    r = await nobody('GET', `${O}/accounting/accounts`);
    check('mais pas à la comptabilité, réservée aux administrateurs comme avant (403)', r.status === 403, r.status);
    r = await nobody('GET', `${S}/assignments`);
    check('les réglages sont réservés aux administrateurs', r.status === 403);
    r = await nobody('PUT', `${S}/settings`, { enabled: true });
    check('un membre ne peut pas modifier le réglage', r.status === 403);
    r = await mgr('PUT', `${S}/settings`, { enabled: false });
    check('un responsable non plus', r.status === 403);
    r = await mgr('GET', O);
    check('un responsable sans affectation voit ses espaces dérivés (direction, commercial…) sans accès supplémentaire', r.json.spaces.fallback === true && r.json.spaces.spaces.some((s) => s.id === 'direction') && !r.json.spaces.spaces.some((s) => s.id === 'compte' && s.level === 'manage'), r.json.spaces.spaces.map((s) => `${s.id}:${s.level}`));

    console.log('Affectation (propriétaire)');
    r = await owner('GET', `${S}/settings`);
    check('catalogue d’espaces et de rôles fonctionnels', r.json.catalogue.length === 9 && r.json.funcRoles.some((f) => f.id === 'comptable'), r.json && Object.keys(r.json));
    r = await owner('PUT', `${S}/assignments/${cptId}`, { funcRoles: ['bidon'] });
    check('rôle fonctionnel inconnu refusé', r.status === 400);
    r = await owner('PUT', `${S}/assignments/${cptId}`, { spaces: { finances: 'super' } });
    check('niveau inconnu refusé', r.status === 400);
    r = await owner('PUT', `${S}/assignments/${cptId}`, { funcRoles: ['comptable'], applyPreset: true });
    check('rôle fonctionnel « comptable » appliqué', r.status === 200, r.json);
    r = await owner('PUT', `${S}/assignments/${comId}`, { funcRoles: ['commercial'], applyPreset: true });
    r = await owner('PUT', `${S}/assignments/${mgrId}`, { funcRoles: ['pilotage'], applyPreset: true });
    r = await owner('PUT', `${S}/assignments/${ownerId}`, { spaces: { finances: 'view' } });
    check('rien à affecter au propriétaire (400)', r.status === 400);
    r = await owner('GET', `${S}/assignments`);
    const A_ = (id) => r.json.members.find((m) => m.userId === id);
    check('l’affectation est relue', A_(cptId).explicit.finances === 'manage' && A_(cptId).funcRoles[0] === 'comptable' && A_(comId).explicit.commercial === 'write', A_(cptId));

    console.log('Réglage du propriétaire');
    r = await owner('PUT', `${S}/settings`, { enabled: true });
    check('le propriétaire confirme l\'activation', r.status === 200 && r.json.enabled === true);

    console.log('Redirection selon le rôle');
    r = await cpt('GET', O);
    check('le comptable arrive directement dans Comptabilité', r.json.spaces.enabled && r.json.spaces.landing === 'finances' && r.json.spaces.choose === false, r.json.spaces);
    check('ses espaces : finances (responsable), commercial (visiteur), projets', r.json.spaces.spaces.find((s) => s.id === 'finances').level === 'manage' && r.json.spaces.spaces.find((s) => s.id === 'commercial').level === 'view' && r.json.spaces.spaces.find((s) => s.id === 'projets').level === 'write');
    check('il n’a ni RH ni compte', !r.json.spaces.spaces.some((s) => ['rh', 'compte', 'stock'].includes(s.id)));
    r = await com('GET', O);
    check('la commerciale arrive dans Commercial', r.json.spaces.landing === 'commercial', r.json.spaces.landing);
    r = await owner('GET', O);
    check('le propriétaire arrive dans Direction et voit les 9 espaces', r.json.spaces.landing === 'direction' && r.json.spaces.spaces.length === 9);
    r = await mgr('GET', O);
    check('le pilotage voit tout (visiteur) et arrive dans Direction ou choisit', r.json.spaces.spaces.length >= 7 && r.json.spaces.spaces.find((s) => s.id === 'finances').level === 'view');

    console.log('Choix multi-rôles');
    await owner('PUT', `${S}/assignments/${comId}`, { spaces: { commercial: 'write', stock: 'write' } });
    r = await com('GET', O);
    check('deux espaces de travail : l’écran de choix est demandé', r.json.spaces.choose === true && r.json.spaces.landing === null, r.json.spaces);
    r = await com('PUT', `${S}/last`, { space: 'stock' });
    check('le choix est mémorisé', r.status === 200);
    r = await com('GET', O);
    check('au retour, le dernier espace est ouvert sans redemander', r.json.spaces.landing === 'stock' && r.json.spaces.choose === false && r.json.spaces.last === 'stock');
    r = await com('PUT', `${S}/last`, { space: 'rh' });
    check('on ne peut pas mémoriser un espace non accordé', r.status === 400);

    console.log('Droits côté serveur');
    r = await cpt('GET', `${O}/accounting/accounts`);
    check('le comptable (rôle membre) accède à la Comptabilité grâce à son espace', r.status === 200, [r.status, r.json]);
    r = await cpt('GET', `${O}/hr/employees`);
    check('mais pas aux RH (403 space_denied)', r.status === 403 && r.json.code === 'space_denied', [r.status, r.json]);
    r = await cpt('GET', `${O}/stock`);
    check('ni au stock', r.status === 403);
    r = await cpt('POST', `${O}/invites`, { role: 'member' });
    check('son relèvement ne le rend pas administrateur de l’équipe (403)', r.status === 403);
    r = await cpt('PUT', `${S}/settings`, { enabled: false });
    check('il ne peut pas se donner d’autres espaces ni désactiver (403)', r.status === 403);
    r = await cpt('PUT', `${S}/assignments/${cptId}`, { spaces: { rh: 'manage' } });
    check('ni modifier ses propres affectations (403)', r.status === 403);
    r = await cpt('GET', `${O}/team-nope`);
    check('chemin inconnu : réponse normale du serveur (404)', r.status === 404);
    r = await nobody('GET', `${O}/stock`);
    check('une personne sans affectation garde l’accès au Stock même quand d’autres sont restreintes (repli sûr)', r.status === 200, [r.status, r.json]);
    r = await nobody('GET', `${O}/projects`);
    check('mais garde Projets et réunions (espace de base)', r.status === 200, r.status);

    console.log('Mode visiteur : lecture seule');
    r = await cpt('GET', `${O}/crm/customers`);
    check('le comptable visite le Commercial en lecture', r.status === 200, [r.status, r.json]);
    for (const [m, p, b] of [['POST', '/crm/customers', { name: 'Intrus' }], ['PUT', '/crm/customers/1', { name: 'X' }], ['DELETE', '/crm/customers/1']]) {
      r = await cpt(m, `${O}${p}`, b);
      check(`visiteur : ${m} ${p} refusé (403 space_readonly)`, r.status === 403 && r.json.code === 'space_readonly', [r.status, r.json]);
    }
    const n0 = Number((await db.prepare('SELECT COUNT(*) c FROM customers WHERE org_id = ?').get(org)).c);
    check('aucun client créé par le visiteur', n0 === 0 || n0 === 1, n0);
    r = await mgr('GET', `${O}/accounting/accounts`);
    check('le pilotage (rôle responsable) consulte la Comptabilité en visiteur', r.status === 200, [r.status, r.json]);
    r = await mgr('POST', `${O}/accounting/accounts`, { code: '999999', name: 'Intrus' });
    check('et ne peut rien y écrire', r.status === 403 && r.json.code === 'space_readonly', [r.status, r.json]);
    r = await mgr('POST', `${O}/projects`, { name: 'Projet Direction' });
    check('le pilotage écrit dans l’espace de base Projets', r.status < 400, [r.status, r.json]);
    r = await com('POST', `${O}/crm/customers`, { name: 'Client Bih' });
    check('la commerciale (membre de l’espace) écrit dans le Commercial', r.status < 400, [r.status, r.json]);
    r = await com('GET', `${O}/accounting/accounts`);
    check('elle n’a pas la Comptabilité (403)', r.status === 403);
    r = await com('GET', `${O}/crm/customers`);
    check('la fiche créée est lisible', r.status === 200 && JSON.stringify(r.json).includes('Client Bih'));

    console.log('Consultation ouverte (réglage)');
    r = await owner('PUT', `${S}/settings`, { openRead: true });
    r = await com('GET', `${O}/hr/employees`);
    check('avec « lecture ouverte », la lecture passe selon les droits habituels de rôle (HR = responsable : 403 du rôle, pas de l’espace)', r.status === 403 && r.json.code !== 'space_denied', [r.status, r.json]);
    r = await com('POST', `${O}/hr/employees`, { name: 'X' });
    check('mais jamais l’écriture hors espace', r.status === 403 && r.json.code === 'space_denied');
    await owner('PUT', `${S}/settings`, { openRead: false });

    console.log('Propriétaire et direction : accès transversal');
    r = await owner('GET', `${O}/accounting/accounts`);
    check('le propriétaire entre dans la Comptabilité', r.status === 200);
    r = await owner('POST', `${O}/crm/customers`, { name: 'Client Propriétaire' });
    check('et écrit partout', r.status < 400);
    r = await owner('GET', `${S}/overview`);
    check('vue d’ensemble : une carte par espace (8)', r.status === 200 && r.json.spaces.length === 8, r.json);
    r = await mgr('GET', `${S}/overview`);
    check('le pilotage voit la vue d’ensemble (espaces consultables seulement)', r.status === 200 && r.json.spaces.length >= 7);
    r = await cpt('GET', `${S}/overview`);
    check('le comptable ne voit pas la vue d’ensemble de direction (403)', r.status === 403);

    console.log('Tableaux de bord d’espace');
    r = await cpt('GET', `${S}/dashboard/finances`);
    check('tableau de bord Comptabilité avec nom de la personne', r.status === 200 && r.json.person.name === 'Comptable Ada' && r.json.tiles.length >= 2, r.json);
    r = await cpt('GET', `${S}/dashboard/rh`);
    check('tableau de bord d’un espace non accordé refusé (403)', r.status === 403);

    console.log('Photo');
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const put = (c, buf) => fetch(base + `${S}/photo`, { method: 'PUT', headers: { 'content-type': 'image/png', cookie: c.cookie() }, body: buf });
    r = await cpt('PUT', `${S}/photo`, Buffer.from('<script>alert(1)</script>-----------------------------'));
    check('un fichier qui n’est pas une image est refusé', r.status === 400, r.status);
    r = await cpt('PUT', `${S}/photo`, PNG);
    check('photo PNG enregistrée', r.status === 200, [r.status, r.json]);
    r = await cpt('GET', `${S}/dashboard/finances`);
    check('le tableau de bord signale la photo', r.json.person.hasPhoto === true);
    r = await owner('GET', `${S}/photo/${cptId}`);
    check('un collègue de la même organisation la voit', r.status === 200 && /image\/png/.test(r.headers.get('content-type')));
    r = await other('GET', `${O}/spaces/photo/${cptId}`);
    check('une autre entreprise ne la voit pas (404)', r.status === 404);

    console.log('Isolation entre entreprises');
    r = await other('GET', `${S}/assignments`);
    check('l’autre entreprise ne voit pas les affectations (404)', r.status === 404);
    r = await owner('GET', `${O2}/spaces/me`);
    check('le propriétaire d’une entreprise n’accède pas à l’autre (404)', r.status === 404);
    r = await other('GET', `${O2}`);
    check('l’autre entreprise a aussi les espaces par défaut, sans rien hériter de la première', r.json.spaces.enabled === true && r.json.spaces.spaces.length === 9 && r.json.spaces.last === null);
    r = await other('PUT', `${O2}/spaces/assignments/${cptId}`, { spaces: { finances: 'manage' } });
    check('on ne peut pas affecter une personne d’une autre entreprise (404)', r.status === 404);
    r = await db.prepare('SELECT COUNT(*) c FROM member_spaces WHERE org_id = ?').get(org2);
    check('aucune affectation créée dans l’autre entreprise', Number(r.c) === 0);

    console.log('Retour arrière (propriétaire, puis interrupteur général)');
    r = await owner('PUT', `${S}/settings`, { enabled: false });
    r = await nobody('GET', `${O}/stock`);
    check('désactivés par le propriétaire, les espaces rendent l’ancien comportement', r.status === 200);
    r = await cpt('GET', `${O}/hr/employees`);
    check('le comptable retrouve l’ancien menu général (plus de blocage d’espace)', r.status !== 403 || r.json.code !== 'space_denied', [r.status, r.json]);
    r = await cpt('GET', O);
    check('l’entreprise désactivée n’a plus d’espaces', r.json.spaces.enabled === false);
    r = await other('GET', O2);
    check('l’autre entreprise n’est pas touchée par ce retour arrière', r.json.spaces.enabled === true);
    r = await owner('PUT', `${S}/settings`, { enabled: true });
    r = await cpt('GET', `${O}/hr/employees`);
    check('réactivés, le blocage d’espace revient', r.status === 403 && r.json.code === 'space_denied');
    process.env.SPACES_BY_ROLE = 'off';
    r = await cpt('GET', O);
    check('interrupteur général SPACES_BY_ROLE=off : plus d’espaces pour personne', r.json.spaces.enabled === false);
    r = await other('GET', O2);
    check('… y compris pour une entreprise sans réglage', r.json.spaces.enabled === false);
    r = await cpt('GET', `${O}/hr/employees`);
    check('… et le serveur ne bloque plus par espace', !(r.status === 403 && r.json.code === 'space_denied'), [r.status, r.json]);
    r = await owner('GET', `${S}/settings`);
    check('le propriétaire est informé que l’interrupteur général est coupé', r.json.globalOff === true && r.json.enabled === false, r.json);
    delete process.env.SPACES_BY_ROLE;
    r = await cpt('GET', O);
    check('interrupteur remis : les espaces reviennent (les affectations n’ont rien perdu)', r.json.spaces.enabled === true && r.json.spaces.spaces.find((s) => s.id === 'finances').level === 'manage');
    r = await owner('POST', '/api/ws/orgs', { name: 'Nouvelle entreprise', currency: 'FCFA' });
    r = await owner('GET', `/api/ws/orgs/${r.json.id}`);
    check('une entreprise créée après la fusion a les espaces dès le premier jour', r.json.spaces.enabled === true && r.json.spaces.landing === 'direction');
    r = await owner('GET', `${S}/log`);
    check('journal des changements', r.status === 200 && r.json.log.length >= 3, r.json);
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
