'use strict';
// Compte d'entreprise (étape 1) : rattachement des organisations, assistant (informations, direction générale, structure, personnes), modèles par secteur,
// lien avec les droits (espaces par rôle), retour arrière, isolation entre entreprises et organisations, droits par route, journal d'audit, limitation de débit.
// Lancez-le avec : npm run test:entreprise
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
    return { status: res.status, json, text };
  };
}

async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ENTREPRISE_WRITE_RATE: '300' });
  delete process.env.ENTREPRISE_RIGHTS; delete process.env.SPACES_BY_ROLE;
  const { app } = require('../src/server');
  const { db, MIGRATIONS } = require('../src/db');
  await db.ready;
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    const owner = client(base); const adm = client(base); const mgr = client(base); const mem = client(base); const cpt = client(base); const other = client(base); const camp = client(base);
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'secret123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const ownerId = await reg(owner, 'Nkoulou Paul', 'nk'); const admId = await reg(adm, 'Admin Bella', 'ad'); const mgrId = await reg(mgr, 'Manager Eto', 'mg'); const memId = await reg(mem, 'Membre Sans Poste', 'me'); const cptId = await reg(cpt, 'Comptable Ada', 'cp'); await reg(other, 'Autre Dirigeant', 'ot'); await reg(camp, 'Campagne Zoé', 'ca');
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id IN (?, ?)").run(new Date(Date.now() + 86400000 * 30).toISOString(), ownerId, (await db.prepare('SELECT id FROM users WHERE contact = ?').get(`ot${stamp}@exemple.com`)).id);
    for (const [c, role] of [[adm, 'admin'], [mgr, 'manager'], [mem, 'member'], [cpt, 'member']]) { r = await owner('POST', `${O}/invites`, { role }); await c('POST', '/api/ws/orgs/join', { code: r.json.code }); }
    r = await other('POST', '/api/ws/orgs', { name: 'Autre société', currency: 'FCFA' }); const org2 = r.json.id; const O2 = `/api/ws/orgs/${org2}`; const E2 = `${O2}/entreprise`;

    console.log('Migrations');
    check('migrations 400 à 404 aux bons numéros (entreprises, personnes, structure, affectations, rattachement) ; 310 à 399 réservées', /entreprises/.test(MIGRATIONS[399]) && /ent_people/.test(MIGRATIONS[400]) && /ent_directions/.test(MIGRATIONS[401]) && /ent_assignments/.test(MIGRATIONS[402]) && /legacy_org_id/.test(MIGRATIONS[403]) && MIGRATIONS.slice(309, 399).every((m) => /reserve/.test(m)), MIGRATIONS.length);

    console.log('Rattachement des organisations (sans perte)');
    check('chaque organisation a une entreprise', Number((await db.prepare('SELECT COUNT(*) c FROM orgs WHERE entreprise_id IS NULL').get()).c) === 0);
    check('le créateur est directeur général de son entreprise', Number((await db.prepare('SELECT COUNT(*) c FROM ent_dg g JOIN ent_people p ON p.id = g.person_id WHERE p.user_id = ? AND g.entreprise_id = (SELECT entreprise_id FROM orgs WHERE id = ?)').get(ownerId, org)).c) === 1);
    // Organisations « existantes » : on les remet dans l'état d'avant la migration puis on rejoue la migration de données (deux fois : idempotente).
    const legacy = Number((await db.prepare("INSERT INTO orgs (name, sector, currency, owner_id, intake_token, created_at) VALUES ('Ancienne SARL', 'commerce', 'EUR', ?, 'tok-legacy-1', ?)").run(cptId, '2025-01-01T00:00:00.000Z')).lastInsertRowid);
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, 'owner', 'Gérante', '2025-01-01T00:00:00.000Z')").run(legacy, cptId);
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, 'member', 'Vendeur', '2025-01-02T00:00:00.000Z')").run(legacy, memId);
    const before = { orgs: Number((await db.prepare('SELECT COUNT(*) c FROM orgs').get()).c), members: Number((await db.prepare('SELECT COUNT(*) c FROM org_members').get()).c) };
    for (let i = 0; i < 2; i++) await db.exec(MIGRATIONS[403]);
    const le = await db.prepare('SELECT e.* FROM entreprises e JOIN orgs o ON o.entreprise_id = e.id WHERE o.id = ?').get(legacy);
    check('une organisation existante reçoit son entreprise (nom, monnaie conservés)', le && le.name === 'Ancienne SARL' && le.currency === 'EUR', le);
    check('son propriétaire est directeur général, ses membres ont une fiche', Number((await db.prepare('SELECT COUNT(*) c FROM ent_dg g JOIN ent_people p ON p.id = g.person_id WHERE g.entreprise_id = ? AND p.user_id = ?').get(le.id, cptId)).c) === 1 && Number((await db.prepare('SELECT COUNT(*) c FROM ent_people WHERE entreprise_id = ?').get(le.id)).c) === 2);
    check('rejouer la migration ne crée aucun doublon (1 entreprise, 2 personnes, 1 DG) et ne perd rien', Number((await db.prepare('SELECT COUNT(*) c FROM entreprises WHERE legacy_org_id = ?').get(legacy)).c) === 1 && Number((await db.prepare('SELECT COUNT(*) c FROM ent_dg WHERE entreprise_id = ?').get(le.id)).c) === 1 && Number((await db.prepare('SELECT COUNT(*) c FROM orgs').get()).c) === before.orgs && Number((await db.prepare('SELECT COUNT(*) c FROM org_members').get()).c) === before.members);
    // Création paresseuse : une organisation créée par un autre chemin (sans entreprise) est rattachée à la première visite.
    const lazy = Number((await db.prepare("INSERT INTO orgs (name, owner_id, intake_token, created_at) VALUES ('Paresseuse', ?, 'tok-lazy-1', ?)").run(cptId, new Date().toISOString())).lastInsertRowid);
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, 'owner', 'Dirigeant', ?)").run(lazy, cptId, new Date().toISOString());
    r = await cpt('GET', `/api/ws/orgs/${lazy}/entreprise`);
    check('création paresseuse : la première visite crée l\'entreprise', r.status === 200 && r.json.entreprise.name === 'Paresseuse' && Number((await db.prepare('SELECT entreprise_id FROM orgs WHERE id = ?').get(lazy)).entreprise_id) > 0, r.json);

    console.log('Rien ne change pour les comptes actuels');
    const snap = async (c) => { const x = await c('GET', O); return JSON.stringify({ role: x.json.me.role, mods: x.json.modules.map((m) => m.id).filter((m) => m !== 'entreprise'), spaces: x.json.spaces.spaces.filter((s) => !s.id.startsWith('dir_')).map((s) => `${s.id}:${s.level}:${s.via}`), fallback: x.json.spaces.fallback }); };
    const snapMem = await snap(mem); const snapMgr = await snap(mgr); const snapOwner = await snap(owner);
    r = await mem('GET', O);
    check('une personne sans affectation garde son repli sûr (niveau membre, aucun relèvement)', r.json.spaces.fallback === true && r.json.spaces.spaces.every((s) => s.level === 'write'), r.json.spaces);
    r = await mem('GET', `${O}/accounting/accounts`);
    check('… et reste sans accès à la comptabilité (403)', r.status === 403);
    r = await mem('GET', O);
    check('le menu propose « Entreprise et organigramme » dans l\'espace Compte', r.json.modules.some((m) => m.id === 'entreprise') && r.json.spaces.spaces.find((s) => s.id === 'compte').modules.some((m) => m.id === 'entreprise'));

    console.log('Droits des routes');
    r = await mem('GET', E);
    check('un membre lit la vue d\'ensemble', r.status === 200 && r.json.can.edit === false && r.json.entreprise.name === 'Atelier Nkoulou', r.json);
    check('… sans les coordonnées ni identifiants légaux', r.json.entreprise.phone === undefined && r.json.entreprise.rccm === undefined && r.json.entreprise.email === undefined);
    for (const [who, c] of [['membre', mem], ['responsable', mgr]]) {
      for (const [m, p, b] of [['PUT', '/info', { name: 'X' }], ['POST', '/template', { sector: 'btp' }], ['POST', '/directions', { name: 'X' }], ['POST', '/departments', { name: 'X' }], ['POST', '/posts', { title: 'X' }], ['POST', '/people', { fullName: 'X' }], ['PUT', '/dg', { personIds: [1] }], ['PUT', '/settings', { rightsLink: false }], ['PUT', '/setup', { step: 'info', status: 'done' }], ['POST', '/assignments', { postId: 1, personId: 1 }]]) {
        r = await c(m, E + p, b);
        if (r.status !== 403) check(`${who} : ${m} ${p} refusé`, false, r.status);
      }
      check(`un ${who} ne peut rien modifier (10 routes d'écriture refusées en 403)`, true);
    }
    r = await mem('GET', `${E}/log`);
    check('le journal est réservé aux administrateurs', r.status === 403);
    r = await adm('PUT', `${E}/dg`, { personIds: [1] });
    check('la direction générale ne se change que par le propriétaire (un administrateur : 403)', r.status === 403);
    r = await adm('PUT', `${E}/settings`, { rightsLink: false });
    check('le lien avec les droits ne se coupe que par le propriétaire', r.status === 403);
    r = await adm('GET', E);
    check('un administrateur voit les coordonnées et peut éditer', r.json.can.edit === true && r.json.entreprise.phone !== undefined);

    console.log('Informations de l\'entreprise (assistant, étape 1)');
    r = await owner('GET', E);
    check('les identifiants légaux sont vides : rien n\'est inventé', r.json.entreprise.rccm === '' && r.json.entreprise.niu === '' && r.json.entreprise.vatNumber === '' && r.json.entreprise.country === 'Cameroun', r.json.entreprise);
    r = await owner('PUT', `${E}/info`, { name: 'Atelier Nkoulou SARL', sector: 'btp', country: 'Cameroun', currency: 'FCFA', city: 'Douala', address: 'Bonanjo', size: '6-20', phone: '+237600000000', email: 'contact@atelier.example' });
    check('enregistrement des informations (sans identifiants légaux)', r.status === 200, r.json);
    r = await owner('PUT', `${E}/info`, { size: '9999' });
    check('taille inconnue refusée', r.status === 400);
    r = await owner('PUT', `${E}/info`, { sector: 'peche' });
    check('secteur inconnu refusé', r.status === 400);
    r = await owner('PUT', `${E}/info`, { email: 'pas-un-email' });
    check('e-mail invalide refusé', r.status === 400);
    r = await owner('PUT', `${E}/info`, { rccm: 'RC/DLA/2020/B/1234', niu: '' });
    check('un identifiant légal saisi par l\'entreprise est conservé, facultatif', r.status === 200);
    r = await owner('GET', E);
    check('relu tel quel', r.json.entreprise.name === 'Atelier Nkoulou SARL' && r.json.entreprise.rccm === 'RC/DLA/2020/B/1234' && r.json.entreprise.niu === '' && r.json.entreprise.city === 'Douala', r.json.entreprise);
    check('le nom de l\'organisation (affiché partout) ne change pas', (await owner('GET', O)).json.org.name === 'Atelier Nkoulou');
    r = await owner('PUT', `${E}/info`, { currency: 'EUR' });
    check('la monnaie de l\'entreprise est celle des modules', (await owner('GET', O)).json.org.currency === 'EUR');
    await owner('PUT', `${E}/info`, { currency: 'FCFA' });

    console.log('Modèles par secteur');
    r = await owner('GET', `${E}/templates`);
    const sec = Object.fromEntries(r.json.sectors.map((s) => [s.id, s]));
    check('quatre secteurs (commerce, BTP, transport et logistique, services) + autre', ['commerce', 'btp', 'transport', 'services', 'autre'].every((k) => sec[k]), Object.keys(sec));
    const posts = (s) => s.departments.flatMap((d) => d.posts).concat([]);
    check('le métreur n\'existe qu\'en BTP', posts(sec.btp).includes('Métreur') && !['commerce', 'transport', 'services', 'autre'].some((k) => posts(sec[k]).includes('Métreur')));
    check('le chauffeur et le dispatcheur n\'existent qu\'en transport', ['Chauffeur', 'Dispatcheur'].every((p) => posts(sec.transport).includes(p)) && !['commerce', 'btp', 'services', 'autre'].some((k) => posts(sec[k]).some((p) => p === 'Chauffeur' || p === 'Dispatcheur')));
    check('les départements par défaut de base existent', ['Finance', 'Pilotage', 'Ressources humaines', 'Commercial', 'Marketing', 'Production', 'Achats', 'Logistique'].every((n) => [...sec.autre.departments.map((d) => d.name), ...sec.autre.optional].includes(n)));
    r = await owner('POST', `${E}/template`, { sector: 'btp' });
    check('appliquer le modèle BTP crée directions, départements et postes', r.status === 200 && r.json.added.directions >= 8 && r.json.added.departments >= 8 && r.json.added.posts >= 30, r.json);
    r = await owner('POST', `${E}/template`, { sector: 'btp' });
    check('le réappliquer n\'ajoute rien (idempotent)', r.json.added.directions === 0 && r.json.added.departments === 0 && r.json.added.posts === 0, r.json);
    r = await owner('GET', `${E}/chart`);
    const allDeps = [...r.json.directions.flatMap((d) => d.departments), ...r.json.departments];
    const allPosts = allDeps.flatMap((d) => d.posts);
    check('BTP : métreur et conducteur de travaux présents, pas de chauffeur', allPosts.some((p) => p.title === 'Métreur') && allPosts.some((p) => p.title === 'Conducteur de travaux') && !allPosts.some((p) => p.title === 'Chauffeur'));
    check('les directions du pilotage ont chacune leur directeur (DAF, directeur technique…)', r.json.directions.find((d) => d.name === 'Direction administrative et financière').directors[0].title.includes('DAF') && r.json.directions.some((d) => d.name === 'Direction technique' && d.active));
    check('le secteur de l\'entreprise est enregistré', (await owner('GET', E)).json.entreprise.sector === 'btp');
    const fin = allDeps.find((d) => d.name === 'Finance'); const prod = allDeps.find((d) => d.name === 'Production');
    const comptable = fin.posts.find((p) => p.title === 'Comptable');
    check('chaque poste a ses accès (comptable : responsable de Finances, directeur : responsable de son espace)', comptable.spaces.finances === 'manage' && r.json.directions.find((d) => d.name === 'Direction administrative et financière').directors[0].spaces.dir_finances === 'manage'); // espaces de direction : le DAF est responsable de SA direction, l'espace Finances lui est en consultation
    // tout est modifiable
    r = await owner('PUT', `${E}/departments/${prod.id}`, { name: 'Réalisation et travaux' });
    check('un département se renomme', r.status === 200);
    r = await owner('POST', `${E}/template`, { sector: 'btp' });
    check('… et le modèle réappliqué ne recrée pas l\'ancien nom', r.json.added.departments === 0);
    r = await owner('POST', `${E}/departments`, { name: 'Qualité', directionId: r.json && null });
    check('on ajoute un département personnalisé', r.status === 201);
    const myDept = r.json.id;
    r = await owner('POST', `${E}/posts`, { title: 'Responsable qualité', kind: 'head', departmentId: myDept, spaces: { operations: 'write' }, headcount: 2 });
    check('et un poste personnalisé', r.status === 201);
    const myPost = r.json.id;
    r = await owner('PUT', `${E}/posts/${myPost}`, { active: false });
    check('et on le désactive', r.status === 200);
    r = await owner('POST', `${E}/posts`, { title: 'Pirate', spaces: { finances: 'super' } });
    check('niveau d\'accès inconnu refusé', r.status === 400);
    r = await owner('POST', `${E}/posts`, { title: 'Pirate', spaces: { cave: 'write' } });
    check('espace inconnu refusé', r.status === 400);
    r = await adm('POST', `${E}/posts`, { title: 'Chef du compte', spaces: { compte: 'manage' } });
    check('un administrateur ne peut pas créer un poste responsable de l\'espace compte (réservé au propriétaire)', r.status === 403);

    console.log('Personnes, invitations personnelles et affectations');
    const res0 = await owner('GET', `${E}/chart`);
    const finPosts = [...res0.json.directions.flatMap((d) => d.departments), ...res0.json.departments].find((d) => d.name === 'Finance').posts;
    const postControleur = finPosts.find((p) => p.title === 'Contrôleur de gestion').id; const postCompta = finPosts.find((p) => p.title === 'Comptable').id; const postCaissier = finPosts.find((p) => p.title === 'Caissier').id;
    r = await owner('POST', `${E}/people`, { fullName: 'Fotso Marie', email: 'marie@exemple.cm', postIds: [postCompta], role: 'member' });
    check('création d\'une personne avec un code d\'invitation personnel', r.status === 201 && /^[A-F0-9]{10}$/.test(r.json.code), r.json);
    const marie = r.json; const codeMarie = r.json.code;
    r = await owner('POST', `${E}/people`, { fullName: 'Doublon', email: 'MARIE@exemple.cm' });
    check('la même adresse e-mail dans l\'entreprise est refusée', r.status === 409);
    r = await owner('POST', `${E}/people`, { fullName: 'Nom Seul' });
    check('une personne sans e-mail ni téléphone est possible (facultatifs)', r.status === 201);
    const sansMail = r.json.id;
    r = await mem('GET', `${E}/people`);
    check('un membre voit les noms mais ni e-mail ni code d\'invitation', r.status === 200 && r.json.people.every((p) => p.email === undefined && p.inviteCode === undefined), r.json.people.slice(0, 2));
    r = await adm('GET', `${E}/people`);
    check('un administrateur voit le code d\'invitation des personnes en attente', r.json.people.find((p) => p.id === marie.id).inviteCode === codeMarie);
    r = await owner('GET', `${E}/chart`);
    check('le poste comptable affiche la personne invitée et reste « occupé »', JSON.stringify(r.json).includes('Fotso Marie'));
    // la personne rejoint avec son code : rien d'autre à faire, son compte est relié à sa fiche et sa place
    const marieC = client(base); const marieId = await reg(marieC, 'Marie Fotso', 'mf');
    r = await marieC('POST', '/api/ws/orgs/join', { code: codeMarie });
    check('elle rejoint avec son code personnel', r.status === 200 && r.json.id === org, r.json);
    const fiche = await db.prepare('SELECT * FROM ent_people WHERE id = ?').get(marie.id);
    check('son compte est relié à sa fiche, le code est consommé', Number(fiche.user_id) === marieId && fiche.status === 'active' && !fiche.invite_code, fiche);
    r = await marieC('GET', O);
    check('elle arrive dans l\'espace Comptabilité et finances en responsable de l\'espace (poste comptable)', (r.json.spaces.spaces.find((s) => s.id === 'finances') || r.json.spaces.spaces.find((s) => s.id === 'r_finance_comptable')).level === 'manage' && (r.json.spaces.spaces.find((s) => s.id === 'finances') || r.json.spaces.spaces.find((s) => s.id === 'r_finance_comptable')).via === 'assigned' && r.json.spaces.fallback === false, r.json.spaces.spaces.map((s) => `${s.id}:${s.level}`));
    check('son intitulé reprend son poste', r.json.me.title === 'Comptable', r.json.me);
    r = await marieC('GET', `${O}/accounting/accounts`);
    check('elle accède à la comptabilité (relèvement limité à son espace)', r.status === 200, r.status);
    r = await marieC('GET', `${O}/hr/employees`);
    check('mais pas aux ressources humaines (hors de ses espaces)', r.status === 403 && r.json.code === 'space_denied', [r.status, r.json]);
    r = await marieC('GET', `${O}/payroll`);
    check('… ni à la paie', r.status === 403);
    r = await marieC('POST', `${O}/invites`, { role: 'member' });
    check('… ni aux invitations de l\'équipe (jamais administratrice de l\'organisation)', r.status === 403);
    r = await marieC('PUT', `${E}/info`, { name: 'Pirate' });
    check('… ni à la modification de l\'entreprise', r.status === 403);
    r = await marieC('GET', `${E}/chart`);
    check('elle voit l\'organigramme', r.status === 200);
    // personne sans affectation : strictement comme avant
    check('une personne sans affectation voit EXACTEMENT les mêmes accès qu\'avant (membre)', (await snap(mem)) === snapMem);
    check('… un responsable aussi', (await snap(mgr)) === snapMgr);
    { const now = await snap(owner); check('… et le propriétaire', now === snapOwner, [snapOwner, now]); }
    r = await mem('GET', `${O}/stock`);
    check('le membre sans poste accède toujours au stock comme avant', r.status === 200);

    console.log('Un seul code, une seule personne ; affectations par organisation');
    r = await camp('POST', '/api/ws/orgs/join', { code: codeMarie });
    check('un code personnel déjà utilisé ne sert plus', r.status === 400);
    r = await owner('POST', `${E}/assignments`, { postId: postCaissier, personId: marie.id });
    check('on affecte la même personne à un second poste', r.status === 201);
    r = await owner('POST', `${E}/assignments`, { postId: postCaissier, personId: marie.id });
    check('affecter deux fois est sans effet', r.status === 201 && r.json.id === null);
    r = await owner('POST', `${E}/assignments`, { postId: postControleur, personId: sansMail });
    check('une personne invitée (pas encore arrivée) est affectable à un poste', r.status === 201);
    r = await owner('POST', `${E}/assignments`, { postId: postCaissier, personId: 999999 });
    check('une personne inconnue : 404', r.status === 404);
    // capacité
    r = await owner('POST', `${E}/assignments`, { postId: postCompta, personId: sansMail });
    check('un poste à une place ne prend pas deux personnes (409)', r.status === 409);
    r = await owner('DELETE', `${E}/posts/${postCompta}`);
    check('un poste occupé ne se supprime pas (409), il se désactive', r.status === 409);
    // plusieurs organisations : comptable ici, rien là
    const ca = await owner('GET', `${E}/chart`);
    check('les affectations sont PAR organisation : la structure de la seconde organisation est vide', (await other('GET', `${E2}/chart`)).json.directions.length === 0);
    r = await other('POST', `${O2}/invites`, { role: 'member' });
    await marieC('POST', '/api/ws/orgs/join', { code: r.json.code });
    r = await marieC('GET', O2);
    check('dans l\'autre organisation, la comptable n\'a aucun poste : repli sûr, pas de comptabilité', r.json.spaces.fallback === true && r.json.spaces.spaces.every((s) => s.level === 'write'), r.json.spaces && r.json.spaces.spaces.map((s) => s.id + ':' + s.level));
    r = await marieC('GET', `${O2}/accounting/accounts`);
    check('… accès comptabilité refusé dans l\'autre organisation', r.status === 403);
    r = await marieC('GET', `${E2}/chart`);
    check('sa fiche est propre à chaque entreprise (personne différente dans l\'autre entreprise)', r.status === 200 && r.json.people.some((p) => p.userId === marieId));
    const e1 = Number((await db.prepare('SELECT entreprise_id FROM orgs WHERE id = ?').get(org)).entreprise_id); const e2 = Number((await db.prepare('SELECT entreprise_id FROM orgs WHERE id = ?').get(org2)).entreprise_id);
    check('deux entreprises distinctes, deux fiches distinctes pour le même compte', e1 !== e2 && Number((await db.prepare('SELECT COUNT(DISTINCT id) c FROM ent_people WHERE user_id = ?').get(marieId)).c) === 2);

    console.log('Isolation entre entreprises');
    r = await other('GET', E);
    check('un dirigeant d\'une autre entreprise ne lit pas la structure (404)', r.status === 404);
    r = await other('GET', `${E}/chart`);
    check('… ni l\'organigramme', r.status === 404);
    r = await other('POST', `${E}/posts`, { title: 'Intrus' });
    check('… ni n\'écrit', r.status === 404);
    r = await other('POST', `${E2}/assignments`, { postId: postCompta, personId: marie.id });
    check('un poste d\'une autre entreprise est introuvable (404)', r.status === 404);
    r = await other('POST', `${E2}/template`, { sector: 'commerce' });
    const chart2 = await other('GET', `${E2}/chart`);
    const post2 = chart2.json.directions.flatMap((d) => d.departments).flatMap((d) => d.posts)[0].id;
    r = await other('POST', `${E2}/assignments`, { postId: post2, personId: marie.id });
    check('une personne d\'une autre entreprise est introuvable (404)', r.status === 404);
    r = await other('PUT', `${E2}/posts/${postCompta}`, { title: 'Pirate' });
    check('modifier le poste d\'une autre entreprise : 404', r.status === 404);
    r = await other('DELETE', `${E2}/departments/${prod.id}`);
    check('supprimer son département : 404', r.status === 404);
    r = await other('PUT', `${E2}/dg`, { personIds: [marie.id] });
    check('désigner comme directeur général une personne d\'une autre entreprise : 404', r.status === 404);
    r = await other('DELETE', `${E2}/assignments/${ca.json.people.find((p) => p.id === marie.id).posts[0].assignmentId}`);
    check('retirer une affectation d\'une autre entreprise : 404', r.status === 404);
    r = await other('DELETE', `${E2}/people/${sansMail}`);
    check('retirer une personne d\'une autre entreprise : 404', r.status === 404);
    r = await other('POST', `${E2}/people`, { fullName: 'Autre', postIds: [postCompta] });
    check('inviter sur un poste d\'une autre entreprise : 404', r.status === 404);
    check('rien n\'a bougé dans la première entreprise', (await owner('GET', `${E}/chart`)).json.people.find((p) => p.id === marie.id).posts.length === 2);
    r = await (client(base))('GET', E);
    check('sans connexion : 401', r.status === 401);

    console.log('Direction générale');
    r = await owner('GET', `${E}/chart`);
    check('le propriétaire est directeur général', r.json.dg.length === 1 && r.json.dg[0].userId === ownerId, r.json.dg);
    const memFiche = r.json.people.find((p) => p.userId === memId).id;
    r = await owner('PUT', `${E}/dg`, { personIds: [] });
    check('la direction générale compte au moins une personne', r.status === 400);
    r = await owner('PUT', `${E}/dg`, { personIds: [r.json && 0] });
    check('identifiant invalide refusé', r.status === 400);
    const ownerFiche = (await owner('GET', `${E}/chart`)).json.dg[0].id;
    r = await owner('PUT', `${E}/dg`, { personIds: [ownerFiche, memFiche] });
    check('plusieurs directeurs généraux possibles', r.status === 200 && (await owner('GET', `${E}/chart`)).json.dg.length === 2);
    r = await mem('GET', O);
    check('un DG non propriétaire : Direction en responsable, autres espaces en consultation', r.json.spaces.spaces.find((s) => s.id === 'direction').level === 'manage' && r.json.spaces.spaces.find((s) => s.id === 'finances').level === 'view' && !r.json.spaces.spaces.some((s) => s.id === 'compte'), r.json.spaces.spaces.map((s) => `${s.id}:${s.level}`));
    r = await mem('POST', `${O}/crm/customers`, { name: 'X' });
    check('… sans pouvoir écrire dans les espaces qu\'il ne fait que consulter (visiteur)', r.status === 403 && r.json.code === 'space_readonly', [r.status, r.json]);
    r = await owner('PUT', `${E}/dg`, { personIds: [ownerFiche] });
    check('retour à un seul DG ; la personne retrouve son repli sûr', r.status === 200 && (await snap(mem)) === snapMem);

    console.log('Retour arrière');
    r = await owner('PUT', `${E}/settings`, { rightsLink: false });
    check('le propriétaire coupe le lien structure → droits', r.status === 200 && r.json.rightsLink === false);
    r = await marieC('GET', O);
    check('la comptable retrouve ses accès d\'avant (repli sûr, plus de comptabilité)', r.json.spaces.fallback === true && r.json.spaces.spaces.find((s) => s.id === 'finances') === undefined || r.json.spaces.spaces.find((s) => s.id === 'finances').level === 'write', r.json.spaces.spaces.map((s) => `${s.id}:${s.level}`));
    r = await marieC('GET', `${O}/accounting/accounts`);
    check('… accès comptabilité refusé de nouveau', r.status === 403);
    check('la structure est conservée', (await owner('GET', `${E}/chart`)).json.people.find((p) => p.id === marie.id).posts.length === 2);
    await owner('PUT', `${E}/settings`, { rightsLink: true });
    r = await marieC('GET', `${O}/accounting/accounts`);
    check('réactivé : elle retrouve la comptabilité sans rien ressaisir', r.status === 200);
    process.env.ENTREPRISE_RIGHTS = 'off';
    r = await marieC('GET', `${O}/accounting/accounts`);
    check('variable ENTREPRISE_RIGHTS=off : le lien est coupé pour toutes les entreprises', r.status === 403);
    r = await owner('GET', E);
    check('… et le propriétaire en est informé', r.json.setup.globalOff === true);
    delete process.env.ENTREPRISE_RIGHTS;
    r = await marieC('GET', `${O}/accounting/accounts`);
    check('variable retirée : tout revient', r.status === 200);
    // poste désactivé / département désactivé / affectation explicite
    r = await owner('PUT', `${E}/posts/${postCompta}`, { active: false });
    r = await marieC('GET', `${O}/accounting/accounts`);
    check('un poste désactivé ne donne plus aucun droit', r.status === 403);
    await owner('PUT', `${E}/posts/${postCompta}`, { active: true });
    r = await owner('PUT', `${E}/departments/${fin.id}`, { active: false });
    r = await marieC('GET', `${O}/accounting/accounts`);
    check('un département désactivé non plus', r.status === 403);
    await owner('PUT', `${E}/departments/${fin.id}`, { active: true });
    r = await owner('PUT', `${O}/spaces/assignments/${marieId}`, { spaces: { finances: 'none' } });
    r = await marieC('GET', `${O}/accounting/accounts`);
    check('l\'affectation explicite du propriétaire (espaces par rôle) l\'emporte sur le poste', r.status === 403);
    await owner('PUT', `${O}/spaces/assignments/${marieId}`, { spaces: { projets: 'write' } });
    r = await owner('POST', `${E}/assignments`, { postId: postCaissier, personId: marie.id });
    r = await owner('DELETE', `${E}/assignments/${(await owner('GET', `${E}/chart`)).json.people.find((p) => p.id === marie.id).posts.find((p) => p.title === 'Caissier').assignmentId}`);
    check('retirer une affectation', r.status === 200);

    console.log('Personne retirée, personne en attente');
    r = await owner('DELETE', `${O}/members/${marieId}`);
    check('retirer la personne de l\'équipe supprime ses affectations dans cette organisation', Number((await db.prepare('SELECT COUNT(*) c FROM ent_assignments a JOIN ent_people p ON p.id = a.person_id WHERE p.user_id = ? AND a.org_id = ?').get(marieId, org)).c) === 0);
    r = await owner('DELETE', `${E}/people/${marie.id}`);
    check('une personne arrivée ne se retire pas d\'ici (409 : « Équipe et antennes »)', r.status === 409);
    r = await owner('POST', `${E}/people/${sansMail}/invite`);
    check('un nouveau code peut être généré pour une personne en attente', r.status === 200 && /^[A-F0-9]{10}$/.test(r.json.code));
    const nc = r.json.code;
    r = await owner('DELETE', `${E}/people/${sansMail}`);
    check('une personne en attente se retire, son code est supprimé', r.status === 200 && Number((await db.prepare('SELECT COUNT(*) c FROM invites WHERE code = ?').get(nc)).c) === 0);

    console.log('Avancement (étapes sautables et reprenables)');
    r = await owner('PUT', `${E}/setup`, { step: 'info', status: 'done' });
    check('une étape se marque terminée', r.status === 200 && r.json.steps.info === 'done');
    r = await owner('PUT', `${E}/setup`, { step: 'dg', status: 'skipped' });
    check('ou sautée', r.json.steps.dg === 'skipped');
    r = await owner('PUT', `${E}/setup`, { step: 'bidon', status: 'done' });
    check('étape inconnue refusée', r.status === 400);
    for (const s of ['directions', 'departments', 'people']) r = await owner('PUT', `${E}/setup`, { step: s, status: 'done' });
    check('toutes les étapes faites ou sautées : configuration complète', r.json.completed === true);
    r = await owner('PUT', `${E}/setup`, { step: 'people', status: 'todo' });
    check('et reprenable', r.json.completed === false);
    r = await owner('GET', E);
    check('l\'état est relu', r.json.setup.steps.dg === 'skipped' && r.json.setup.template === 'btp' && r.json.setup.rightsLink === true);

    console.log('Journal d\'audit');
    r = await owner('GET', `${E}/log`);
    const txt = JSON.stringify(r.json);
    check('les changements de structure et d\'affectation sont journalisés (qui, quoi, quand)', r.status === 200 && ['ent_template', 'ent_post', 'ent_assignment', 'ent_person', 'ent_dg', 'ent_info', 'ent_settings'].every((k) => r.json.log.some((l) => l.entity === k)) && r.json.log.every((l) => l.at && l.name), r.json.log.map((l) => l.entity + ':' + l.action).slice(0, 12));
    check('un code d\'invitation n\'est jamais écrit dans le journal', !txt.includes(codeMarie) && !txt.includes(nc));
    r = await adm('GET', `${E}/log`);
    check('un administrateur lit le journal', r.status === 200);
    r = await other('GET', `${E2}/log`);
    check('le journal d\'une entreprise ne montre rien d\'une autre', !JSON.stringify(r.json).includes('Fotso') && !JSON.stringify(r.json).includes('Atelier Nkoulou'));

    console.log('Suppression d\'organisation');
    const org3 = (await camp('POST', '/api/ws/orgs', { name: 'À supprimer', currency: 'FCFA' })).json.id;
    await camp('POST', `/api/ws/orgs/${org3}/entreprise/template`, { sector: 'commerce' });
    const ent3 = Number((await db.prepare('SELECT entreprise_id FROM orgs WHERE id = ?').get(org3)).entreprise_id);
    r = await camp('DELETE', `/api/ws/orgs/${org3}`, { confirm: 'À supprimer' });
    check('supprimer l\'organisation supprime son entreprise et sa structure (rien ne reste)', r.status === 200 && Number((await db.prepare('SELECT COUNT(*) c FROM entreprises WHERE id = ?').get(ent3)).c) === 0 && Number((await db.prepare('SELECT COUNT(*) c FROM ent_posts WHERE org_id = ?').get(org3)).c) === 0 && Number((await db.prepare('SELECT COUNT(*) c FROM ent_people WHERE entreprise_id = ?').get(ent3)).c) === 0);

    console.log('Limitation de débit');
    let limited = 0;
    for (let i = 0; i < 400 && !limited; i++) { r = await owner('PUT', `${E}/setup`, { step: 'info', status: 'done' }); if (r.status === 429) limited = i + 1; }
    check('trop d\'écritures à la suite : 429 avec message clair', limited > 0 && /Trop de modifications/.test(r.json.error), [limited, r.status]);
    r = await owner('GET', E);
    check('la lecture n\'est pas limitée', r.status === 200);
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
