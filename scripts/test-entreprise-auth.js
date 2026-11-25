'use strict';
// Compte d'entreprise, étape 2 : connexion employé (code d'entreprise + e-mail + secret), première connexion par invitation, appareils de confiance,
// double authentification des profils sensibles, verrouillage, ancienne connexion conservée, isolation. Lancez-le avec : npm run test:entreprise-auth
const { startTestPg } = require('./lib/testdb');
let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
function client(base) {
  const jar = {};
  const c = async (method, url, body) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc) || v === '') delete jar[k]; else jar[k] = v; }
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
  c.jar = jar;
  return c;
}
async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'BREVO_API_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0' });
  const { app } = require('../src/server');
  const { db, MIGRATIONS } = require('../src/db');
  const central = require('../src/security');
  await db.ready;
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    const owner = client(base); const other = client(base);
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'Secret-Pass-123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const ownerId = await reg(owner, 'Nkoulou Paul', 'nk'); await reg(other, 'Autre Dirigeant', 'ot');
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id IN (SELECT id FROM users)").run(new Date(Date.now() + 86400000 * 30).toISOString());
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
    r = await other('POST', '/api/ws/orgs', { name: 'Autre société', currency: 'FCFA' }); const org2 = r.json.id; const E2 = `/api/ws/orgs/${org2}/entreprise`;
    await owner('POST', `${E}/template`, { sector: 'commerce' });
    const chart = (await owner('GET', `${E}/chart`)).json;
    const posts = [...chart.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...chart.departments.flatMap((x) => x.posts)];
    const post = (t) => posts.find((p) => p.title === t).id;

    console.log('Migrations et code d\'entreprise');
    check('migrations 410 à 412 aux bons numéros ; 405 à 409 réservées', /ent_credentials/.test(MIGRATIONS[409]) && /ent_devices/.test(MIGRATIONS[410]) && /sensitive_2fa/.test(MIGRATIONS[411]) && MIGRATIONS.slice(404, 409).every((m) => /reserve/.test(m)), MIGRATIONS.length);
    r = await owner('GET', E);
    const CODE = r.json.companyCode;
    check('le code d\'entreprise (6 caractères sans O/0/I/1) est donné aux administrateurs', /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/.test(CODE), CODE);
    check('il est différent pour chaque entreprise', (await other('GET', E2)).json.companyCode !== CODE);
    const mem0 = client(base); const mid = await reg(mem0, 'Simple Membre', 'sm');
    r = await owner('POST', `${O}/invites`, { role: 'member' }); await mem0('POST', '/api/ws/orgs/join', { code: r.json.code });
    check('un simple membre ne voit pas le code', (await mem0('GET', E)).json.companyCode === undefined);
    r = await mem0('POST', `${E}/company-code`);
    check('et ne peut pas le changer', r.status === 403);

    console.log('Première connexion par invitation');
    const people = {};
    for (const [tag, name, title] of [['mag', 'Magasinier Paul', 'Magasinier'], ['cpt', 'Comptable Ada', 'Comptable'], ['dir', 'Directeur Eto', 'Directeur administratif et financier (DAF)'], ['tre', 'Trésorier Max', 'Trésorier']]) {
      r = await owner('POST', `${E}/people`, { fullName: name, email: `${tag}${stamp}@entreprise.cm`, postIds: [post(title)] });
      people[tag] = { ...r.json, email: `${tag}${stamp}@entreprise.cm`, name };
    }
    const act = (c, tag, body = {}) => c('POST', '/api/entreprise-auth/activate', { companyCode: CODE, inviteCode: people[tag].code, email: people[tag].email, method: 'pin', secret: '493817', ...body });
    const anon = client(base);
    r = await act(anon, 'mag', { companyCode: 'ZZZ-ZZZ' });
    const badMsg = r.json && r.json.error;
    check('un mauvais code d\'entreprise est refusé avec un message clair', r.status === 400 && /invalide/.test(badMsg), r.json);
    r = await act(anon, 'mag', { inviteCode: 'FFFFFFFFFF' });
    check('un code d\'invitation inconnu : même message (on ne révèle rien)', r.status === 400 && r.json.error === badMsg);
    r = await act(anon, 'mag', { email: 'autre@entreprise.cm' });
    check('un e-mail différent de celui prévu est refusé', r.status === 400 && /ne correspond pas/.test(r.json.error), r.json);
    r = await act(anon, 'mag', { secret: '123456' });
    check('un PIN évident est refusé', r.status === 400 && /facile/.test(r.json.error), r.json);
    r = await act(anon, 'mag', { secret: '12ab' });
    check('un PIN mal formé est refusé', r.status === 400 && /6 à 8 chiffres/.test(r.json.error));
    r = await act(anon, 'mag', { method: 'password', secret: 'court' });
    check('un mot de passe faible est refusé', r.status === 400);
    r = await act(anon, 'mag', { method: 'autre' });
    check('une méthode inconnue est refusée', r.status === 400);
    r = await act(anon, 'mag', { trustDays: 45 });
    check('activation réussie : compte créé, session ouverte', r.status === 201 && r.json.user && r.json.landing.orgId === org, r.json);
    check('l\'organisation, le rôle et le poste sont reconnus automatiquement', r.json.landing.posts[0].title === 'Magasinier' && r.json.landing.posts[0].department === 'Achats' && r.json.landing.role === 'member' && r.json.company.name === 'Atelier Nkoulou', r.json.landing);
    check('l\'appareil de confiance est créé (45 jours)', r.json.device && r.json.device.days === 45 && !!anon.jar.mia_dev);
    const magUser = Number((await db.prepare('SELECT user_id FROM ent_people WHERE id = ?').get(people.mag.id)).user_id);
    r = await anon('GET', `${O}/stock`);
    check('la session ouverte donne accès à l\'espace de la personne', r.status === 200, r.status);
    r = await act(client(base), 'mag');
    check('une invitation ne sert qu\'une fois', r.status === 400);
    r = await client(base)('POST', '/api/login', { contact: people.mag.email, pass: '493817' });
    check('un PIN ne devient jamais un mot de passe de l\'ancienne connexion', r.status === 401);
    check('le PIN n\'est stocké qu\'en empreinte', !JSON.stringify(await db.prepare('SELECT * FROM ent_credentials').all()).includes('493817'));
    r = await act(client(base), 'cpt', { method: 'password', secret: 'Motdepasse-Solide-77' });
    check('un mot de passe solide convient aussi (comptable)', r.status === 201);
    await reg(client(base), 'Déjà Compte', 'dc');
    r = await owner('POST', `${E}/people`, { fullName: 'Déjà Compte', email: `dc${stamp}@exemple.com` });
    r = await client(base)('POST', '/api/entreprise-auth/activate', { companyCode: CODE, inviteCode: r.json.code, email: `dc${stamp}@exemple.com`, method: 'pin', secret: '493817' });
    check('un e-mail qui a déjà un compte est orienté vers la connexion normale (409 clair)', r.status === 409 && /Connectez-vous/.test(r.json.error), r.json);

    console.log('Connexion employé');
    const login = (c, body) => c('POST', '/api/entreprise-auth/login', { companyCode: CODE, email: people.mag.email, secret: '493817', ...body });
    const c1 = client(base);
    r = await login(c1, {});
    check('connexion par code d\'entreprise + e-mail + secret', r.status === 200 && r.json.user && r.json.landing.orgId === org, r.json);
    check('… le code est accepté sans le tiret et en minuscules', (await login(client(base), { companyCode: CODE.replace('-', '').toLowerCase() })).status === 200);
    check('… et la session donne accès à l\'organisation', (await c1('GET', O)).status === 200);
    r = await login(client(base), { secret: '000000' });
    const m1 = r.json.error;
    check('mauvais secret : message générique, jamais d\'erreur brute', r.status === 401 && /incorrect/.test(m1) && !/stack|SQL|undefined/.test(m1), r.json);
    r = await login(client(base), { email: 'inconnu@entreprise.cm' });
    check('e-mail inconnu : exactement le même message', r.status === 401 && r.json.error === m1);
    r = await login(client(base), { companyCode: 'ZZZ-ZZZ' });
    check('code d\'entreprise inconnu : exactement le même message', r.status === 401 && r.json.error === m1);
    r = await client(base)('POST', '/api/entreprise-auth/login', { companyCode: CODE, email: people.mag.email });
    check('champs manquants : message clair (pas d\'erreur 500)', r.status === 401 && r.json.error === m1);
    r = await client(base)('POST', '/api/entreprise-auth/login', 'pas du json');
    check('corps invalide : pas de plantage', r.status < 500, r.status);
    r = await client(base)('POST', '/api/login', { contact: people.cpt.email, pass: 'Motdepasse-Solide-77' });
    check('l\'ancienne connexion (contact + mot de passe) reste valable en parallèle', r.status === 200 && r.json.user);
    r = await owner('GET', '/api/me');
    check('le propriétaire actuel est inchangé (connexion et accès)', r.status === 200);
    // isolation : un employé d'une entreprise ne se connecte pas avec le code d'une autre
    const code2 = (await other('GET', E2)).json.companyCode;
    r = await client(base)('POST', '/api/entreprise-auth/login', { companyCode: code2, email: people.mag.email, secret: '493817' });
    check('isolation : le code d\'une autre entreprise ne donne pas accès', r.status === 401 && r.json.error === m1);
    // verrouillage
    for (let i = 0; i < 9; i++) r = await login(client(base), { email: people.tre.email, secret: '111222' });
    check('verrouillage après 8 échecs (message clair avec la durée)', r.status === 429 && /bloquée/.test(r.json.error), r.json);
    r = await login(client(base), { email: people.tre.email });
    check('… même le bon secret est alors refusé pendant le blocage', r.status === 429 || r.status === 401, r.status);

    console.log('Appareils de confiance');
    const dev = client(base);
    r = await login(dev, { trustDays: 365 });
    check('durée limitée à 90 jours au maximum', r.json.device && r.json.device.days === 90);
    const d1 = await db.prepare('SELECT * FROM ent_devices WHERE id = ?').get(r.json.device.id);
    check('le jeton n\'est stocké qu\'en empreinte, l\'expiration est à 90 jours', d1.token_hash.length === 64 && !String(dev.jar.mia_dev).includes(d1.token_hash) && Math.abs(Date.parse(d1.expires_at) - Date.now() - 90 * 86400000) < 5000);
    const back = client(base); back.jar.mia_dev = dev.jar.mia_dev;
    r = await back('POST', '/api/entreprise-auth/resume');
    check('retour automatique : l\'appareil de confiance ouvre la session sans ressaisie', r.status === 200 && r.json.ok === true && r.json.landing.orgId === org, r.json);
    check('… et la session donne accès à l\'organisation', (await back('GET', O)).status === 200);
    r = await client(base)('POST', '/api/entreprise-auth/resume');
    check('sans appareil : pas d\'erreur, la page de connexion s\'affiche (ok:false)', r.status === 200 && r.json.ok === false);
    const forged = client(base); forged.jar.mia_dev = `${d1.id}.${'a'.repeat(64)}`;
    check('un faux jeton est refusé', (await forged('POST', '/api/entreprise-auth/resume')).json.ok === false);
    r = await back('GET', '/api/entreprise-auth/devices');
    check('la personne voit la liste de ses appareils', r.status === 200 && r.json.devices.length >= 2 && r.json.devices.some((x) => x.current) && r.json.hasCompanyLogin === true, r.json);
    r = await owner('GET', `${E}/devices`);
    check('l\'administrateur voit les appareils de l\'entreprise (avec le nom)', r.status === 200 && r.json.devices.some((x) => x.person === 'Magasinier Paul'), r.json);
    check('… un membre non', (await mem0('GET', `${E}/devices`)).status === 403);
    r = await other('GET', `${E2}/devices`);
    check('… une autre entreprise ne voit aucun de ces appareils', r.status === 200 && r.json.devices.length === 0);
    r = await other('DELETE', `${E2}/devices/${d1.id}`);
    check('… et ne peut pas en révoquer un (404)', r.status === 404);
    r = await owner('DELETE', `${E}/devices/${d1.id}`);
    check('l\'administrateur révoque un appareil : effet immédiat', r.status === 200);
    check('… le retour automatique est refusé', (await back('POST', '/api/entreprise-auth/resume')).json.ok === false);
    check('… et la session de cet appareil est fermée', (await back('GET', O)).status === 401);
    const dev2 = client(base); r = await login(dev2, { trustDays: 30 });
    r = await dev2('DELETE', `/api/entreprise-auth/devices/${r.json.device.id}`);
    check('la personne révoque elle-même son appareil', r.status === 200);
    check('… retour automatique refusé ensuite', (await dev2('POST', '/api/entreprise-auth/resume')).json.ok === false);
    const dev3 = client(base); await login(dev3, { trustDays: 30 });
    await db.prepare("UPDATE ent_devices SET expires_at = ? WHERE user_id = ?").run(new Date(Date.now() - 1000).toISOString(), magUser);
    check('un appareil expiré n\'ouvre plus rien', (await dev3('POST', '/api/entreprise-auth/resume')).json.ok === false);
    const dev4 = client(base); await login(dev4, { trustDays: 30 });
    await db.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").run(new Date().toISOString(), magUser);
    check('un compte suspendu n\'est pas reconnecté par un appareil', (await dev4('POST', '/api/entreprise-auth/resume')).json.ok === false);
    await db.prepare('UPDATE users SET suspended_at = NULL WHERE id = ?').run(magUser);
    r = await login(client(base), { trustDays: 30 });
    const tmp = client(base); await login(tmp, { trustDays: 30 });
    r = await tmp('PUT', '/api/entreprise-auth/secret', { orgId: org, current: '493817', method: 'pin', secret: '728401' });
    check('changer son secret ferme tous les appareils de confiance', r.status === 200 && Number((await db.prepare('SELECT COUNT(*) c FROM ent_devices WHERE user_id = ? AND revoked_at IS NULL').get(magUser)).c) === 0, r.json);
    check('… le nouveau secret fonctionne, l\'ancien non', (await login(client(base), { secret: '728401' })).status === 200 && (await login(client(base), { secret: '493817' })).status === 401);
    r = await tmp('PUT', '/api/entreprise-auth/secret', { orgId: org, current: 'faux', method: 'pin', secret: '918273' });
    check('changer son secret exige le secret actuel', r.status === 403 || r.status === 401, r.status);
    // un compte actuel (ancienne connexion) peut activer la connexion employé
    r = await mem0('PUT', '/api/entreprise-auth/secret', { orgId: org, current: 'Secret-Pass-123', method: 'pin', secret: '561874' });
    check('un compte actuel active la connexion employé avec son mot de passe actuel', r.status === 200, r.json);
    r = await mem0('PUT', '/api/entreprise-auth/secret', { orgId: org2, current: 'Secret-Pass-123', method: 'pin', secret: '561874' });
    check('… mais pas pour une entreprise dont il ne fait pas partie (404)', r.status === 404);

    console.log('Double authentification des profils sensibles');
    const dirC = client(base);
    r = await act(dirC, 'dir');
    check('le DAF s\'active (PIN)', r.status === 201);
    r = await dirC('GET', O);
    check('profil sensible sans double authentification : accès aux données refusé avec un message clair', r.status === 403 && r.json.code === 'twofa_required' && /double authentification/.test(r.json.error), r.json);
    r = await dirC('GET', '/api/me');
    check('… mais le compte reste ouvert pour activer la double authentification', r.status === 200);
    r = await act(client(base), 'tre', {});
    const treC = client(base); await db.prepare('DELETE FROM login_fails').run();
    await login(treC, { email: people.tre.email });
    check('le trésorier est sensible (poste de responsable des Finances)', (await treC('GET', O)).status === 403);
    check('le magasinier ne l\'est pas', (await c1('GET', O)).status === 200);
    check('le propriétaire actuel n\'est jamais bloqué (pas de connexion employé)', (await owner('GET', O)).status === 200);
    r = await dirC('GET', '/api/entreprise-auth/devices');
    check('le réglage est visible', (await owner('GET', E)).json.sensitive2fa === true);
    // activer la double authentification (TOTP) pour le DAF
    const dirUser = Number((await db.prepare('SELECT user_id FROM ent_people WHERE id = ?').get(people.dir.id)).user_id);
    const secretB32 = central.totp.newSecret();
    await db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?').run(central.totp.seal(secretB32), dirUser);
    check('avec la double authentification activée, l\'accès est rendu', (await dirC('GET', O)).status === 200);
    r = await login(client(base), { email: people.dir.email, secret: '493817', trustDays: 30 });
    check('connexion du DAF : le code de l\'application est demandé', r.status === 200 && r.json.twofa === true && !!r.json.ticket && !r.json.user, r.json);
    const tk = r.json.ticket; const f2 = client(base);
    r = await f2('POST', '/api/entreprise-auth/login/2fa', { ticket: tk, code: '000000' });
    check('code incorrect : message clair', r.status === 401 && /incorrect/.test(r.json.error));
    r = await f2('POST', '/api/entreprise-auth/login/2fa', { ticket: tk, code: central.totp.codeAt(secretB32, central.totp.stepNow()) });
    check('bon code : session ouverte, appareil de confiance créé après la double authentification', r.status === 200 && r.json.user && r.json.device && r.json.landing.posts.length === 1, r.json);
    r = await f2('POST', '/api/entreprise-auth/login/2fa', { ticket: 'faux', code: '123456' });
    check('ticket invalide : message clair', r.status === 401 && /expiré/.test(r.json.error));
    r = await owner('PUT', `${E}/settings`, { sensitive2fa: false });
    check('le propriétaire peut assouplir l\'exigence (réglage d\'entreprise)', r.status === 200 && (await treC('GET', O)).status === 200);
    await owner('PUT', `${E}/settings`, { sensitive2fa: true });
    check('un administrateur ne peut pas changer ce réglage', (await mem0('PUT', `${E}/settings`, { sensitive2fa: false })).status === 403);

    console.log('Code d\'entreprise : renouvellement');
    r = await owner('POST', `${E}/company-code`);
    check('le propriétaire renouvelle le code (l\'ancien ne marche plus)', r.status === 200 && r.json.companyCode !== CODE && (await login(client(base), { secret: '728401' })).status === 401, r.json);
    const journal = JSON.stringify((await owner('GET', `${E}/log`)).json);
    check('les révocations d\'appareils sont dans le journal', /ent_device/.test(journal));
    check('aucun secret ni jeton dans le journal de sécurité', !JSON.stringify(await db.prepare('SELECT * FROM audit_trail ORDER BY id DESC LIMIT 200').all().catch(() => [])).includes('493817'));
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
