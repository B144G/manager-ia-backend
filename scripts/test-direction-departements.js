'use strict';
// Espaces de direction de département : chaque directeur a son PROPRE espace (pilotage, validations, tâches, notes, objectifs), séparé de l'espace opérationnel du personnel.
// Droits côté serveur, isolation entre départements et entre organisations, repli sûr, retour arrière. Lancez-le avec : npm run test:direction-departements
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
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ENTREPRISE_WRITE_RATE: '3000' });
  delete process.env.DIRECTION_SPACES; delete process.env.SPACES_BY_ROLE;
  const { app } = require('../src/server');
  const { db, MIGRATIONS } = require('../src/db');
  await db.ready;
  const T = require('../src/workspace/ent-templates');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now(); const now = new Date().toISOString();
  try {
    const reg = async (c, name, tag) => { await db.prepare('DELETE FROM rate_hits').run(); await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'Secret-Pass-123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const owner = client(base); const adm = client(base); const o2 = client(base); const o3 = client(base);
    const ownerId = await reg(owner, 'Nkoulou Paul', 'nk'); await reg(adm, 'Admin Bella', 'ad'); await reg(o2, 'Dirigeant Deux', 'd2'); await reg(o3, 'Dirigeant Trois', 'd3');
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ?").run(new Date(Date.now() + 86400000 * 30).toISOString());
    const org = (await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' })).json.id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
    const org2 = (await o2('POST', '/api/ws/orgs', { name: 'Autre Société', currency: 'FCFA' })).json.id; const O2 = `/api/ws/orgs/${org2}`; const E2 = `${O2}/entreprise`;
    let r = await owner('POST', `${O}/invites`, { role: 'admin' }); await adm('POST', '/api/ws/orgs/join', { code: r.json.code });
    await owner('POST', `${E}/template`, { sector: 'commerce' }); await o2('POST', `${E2}/template`, { sector: 'commerce' });
    const flat = (ch) => [...ch.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...ch.departments.flatMap((x) => x.posts)];
    const posts = flat((await owner('GET', `${E}/chart`)).json); const post = (t) => posts.find((p) => p.title === t);
    const posts2 = flat((await o2('GET', `${E2}/chart`)).json);
    const person = async (ownerC, E_, tag, name, postTitle, list) => {
      const p = list.find((x) => x.title === postTitle);
      const r0 = await ownerC('POST', `${E_}/people`, { fullName: name, email: `${tag}${stamp}@entreprise.cm`, postIds: p ? [p.id] : [] });
      const c = client(base); const id = await reg(c, name, tag); await c('POST', '/api/ws/orgs/join', { code: r0.json.code }); return { c, id, personId: r0.json.id };
    };
    const dc = await person(owner, E, 'dc', 'Directeur Commercial', 'Directeur commercial', posts);
    const s1 = await person(owner, E, 's1', 'Vendeur Un', 'Commercial / vendeur', posts);
    const s2 = await person(owner, E, 's2', 'Comptable Ada', 'Comptable', posts);
    const daf = await person(owner, E, 'daf', 'Directeur Financier', 'Directeur administratif et financier (DAF)', posts);
    const drh = await person(owner, E, 'drh', 'Directeur RH', 'Directeur des ressources humaines (DRH)', posts);
    const nop = await person(owner, E, 'nop', 'Sans Poste', 'inexistant', posts);
    const mine = (c, O_) => c('GET', O_).then((x) => Object.fromEntries(x.json.spaces.spaces.map((s) => [s.id, s.level])));

    console.log('Migrations et modèle');
    check('migrations 450 (réglage) et 451 (tâches, notes, objectifs de direction) ; 444 à 449 réservées', /dir_spaces/.test(MIGRATIONS[449]) && /dir_tasks/.test(MIGRATIONS[450]) && MIGRATIONS.slice(443, 449).every((m) => /reserve/.test(m)), MIGRATIONS.length);
    r = await owner('GET', E);
    check('organisation neuve : les espaces de direction sont actifs d\'emblée (le modèle les crée)', r.json.direction.enabled === true && r.json.direction.spaces.length === 11, r.json.direction);
    check('les postes de directeur ont leur espace de direction en responsable et l\'espace opérationnel en consultation', JSON.stringify(post('Directeur commercial').spaces) === JSON.stringify({ dir_commercial: 'manage', commercial: 'view', stock: 'view', direction: 'view' }), post('Directeur commercial').spaces);
    check('les postes du personnel n\'ont aucun espace de direction', posts.filter((p) => p.kind !== 'director').every((p) => !Object.keys(p.spaces).some((k) => k.startsWith('dir_'))));
    check('chacune des 10 directions du modèle mène à un espace de direction', T.DIRECTIONS.every((d) => ['dir_general', 'dir_technique', 'dir_commercial', 'dir_finances', 'dir_rh', 'dir_production', 'dir_logistique', 'dir_stock', 'dir_marketing', 'dir_it', 'dir_securite'].some((s) => d.director.spaces[s] === 'manage')));

    console.log('Le directeur a son propre espace');
    let sp = await mine(dc.c, O);
    check('le directeur commercial : Direction commerciale en responsable, Commercial en visiteur', sp.dir_commercial === 'manage' && sp.commercial === 'view', sp);
    check('… aucun accès aux autres départements (ni finances, ni RH, ni leur direction)', !sp.finances && !sp.rh && !sp.dir_finances && !sp.dir_rh && !sp.dir_stock, sp);
    r = await dc.c('GET', O);
    check('à l\'ouverture il arrive sur son espace de direction (arrivée par espace, pas « Mon espace de travail »)', r.json.spaces.landing === 'dir_commercial' && r.json.spaces.choose === false && r.json.profile.landing === false && r.json.profile.directionSpace === 'dir_commercial', [r.json.spaces.landing, r.json.profile]);
    check('les écrans de direction n\'apparaissent que dans les espaces, jamais dans le menu général', !r.json.modules.some((m) => m.id.startsWith('dir_')) && r.json.spaces.spaces.find((s) => s.id === 'dir_commercial').modules.some((m) => m.id === 'dir_commercial'));
    sp = await mine(s1.c, O);
    check('le vendeur : Commercial en membre, JAMAIS un espace de direction', sp.commercial === 'write' && !Object.keys(sp).some((k) => k.startsWith('dir_')), sp);
    sp = await mine(s2.c, O);
    check('le comptable : Comptabilité et finances, pas de direction', !!sp.finances && !Object.keys(sp).some((k) => k.startsWith('dir_')), sp);
    sp = await mine(nop.c, O);
    check('une personne sans poste (repli sûr) n\'a aucun espace de direction', !Object.keys(sp).some((k) => k.startsWith('dir_')) && sp.commercial === 'write', sp);

    console.log('Espace de direction : routes protégées côté serveur');
    const D = `${O}/dir_commercial`;
    for (const [m, p, b] of [['GET', '/summary'], ['GET', '/validations'], ['GET', '/reports'], ['GET', '/tasks'], ['GET', '/notes'], ['POST', '/tasks', { title: 'x' }], ['POST', '/notes', { title: 'x' }], ['POST', '/objectives', { title: 'x', target: 1 }], ['PUT', '/tasks/1', { status: 'done' }], ['DELETE', '/objectives/1']]) {
      r = await s1.c(m, D + p, b);
      if (!(r.status === 403 && r.json.code === 'space_denied')) check(`le personnel refusé : ${m} ${p}`, false, [r.status, r.json]);
    }
    check('le personnel du département est refusé sur TOUTES les routes de l\'espace de direction (403 space_denied)', true);
    r = await nop.c('GET', `${D}/tasks`);
    check('une personne sans poste aussi', r.status === 403);
    r = await dc.c('GET', `${D}/summary`);
    check('le directeur lit son pilotage (indicateurs du département, équipe, objectifs)', r.status === 200 && r.json.tiles.length >= 3 && r.json.team.seats > 0 && r.json.space.opSpace === 'commercial' && Array.isArray(r.json.objectives), r.json);
    check('… l\'équipe : effectifs, places vacantes, membres', r.json.team.members >= 1 && r.json.team.filled >= 1 && typeof r.json.team.vacancies === 'number', r.json.team);
    r = await dc.c('POST', `${D}/tasks`, { title: 'Préparer le plan de vente Q1', due: '2026-12-31', priority: 'high', notes: 'Confidentiel' });
    const tid = r.json.id;
    check('le directeur crée SES tâches', r.status === 201);
    check('… invisibles du personnel : le vendeur ne les voit ni dans l\'espace de direction ni dans les tâches générales', (await s1.c('GET', `${D}/tasks`)).status === 403 && !JSON.stringify((await s1.c('GET', `${O}/projects/tasks`)).json || {}).includes('plan de vente'));
    check('… ni le propriétaire dans le projet général : table séparée', Number((await db.prepare("SELECT COUNT(*) c FROM tasks WHERE title LIKE '%plan de vente%'").get()).c) === 0);
    r = await dc.c('GET', `${D}/tasks`);
    check('le directeur les relit', r.json.tasks.length === 1 && r.json.tasks[0].title === 'Préparer le plan de vente Q1' && r.json.tasks[0].priority === 'high');
    r = await dc.c('PUT', `${D}/tasks/${tid}`, { status: 'done' });
    check('il la termine', r.status === 200 && (await dc.c('GET', `${D}/tasks`)).json.tasks[0].status === 'done');
    check('titre vide refusé', (await dc.c('POST', `${D}/tasks`, { title: '  ' })).status === 400);
    check('priorité inconnue refusée', (await dc.c('POST', `${D}/tasks`, { title: 'x', priority: 'urgentissime' })).status === 400);
    r = await dc.c('POST', `${D}/notes`, { title: 'Négociation fournisseur', body: 'Plafond de remise : 12 %' });
    check('il tient ses dossiers (notes)', r.status === 201 && (await dc.c('GET', `${D}/notes`)).json.notes[0].body.includes('12 %'));
    check('… invisibles du personnel', (await s1.c('GET', `${D}/notes`)).status === 403);
    r = await dc.c('POST', `${D}/objectives`, { title: 'Chiffre d\'affaires du trimestre', unit: 'FCFA', target: '10 000 000', current: 2500000, due: '2026-12-31' });
    const oid = r.json.id;
    check('il fixe des objectifs', r.status === 201);
    r = await dc.c('PUT', `${D}/objectives/${oid}`, { current: 5000000 });
    r = await dc.c('GET', `${D}/summary`);
    check('… avec leur avancement en pourcentage', r.json.objectives[0].pct === 50 && r.json.objectives[0].target === 10000000, r.json.objectives);
    check('cible invalide refusée', (await dc.c('POST', `${D}/objectives`, { title: 'x', target: 'beaucoup' })).status === 400);
    r = await dc.c('GET', `${D}/validations`);
    check('file de validations du département (demandes clients ouvertes pour le commercial)', r.status === 200 && r.json.queues.some((q) => q.kind === 'ticket'), r.json.queues.map((q) => q.kind));
    r = await dc.c('GET', `${D}/reports`);
    check('rapports : écrans du département', r.json.links.some((l) => l.module === 'crm'));
    r = await dc.c('POST', `${D}/tasks`, { title: 'à supprimer' });
    check('il supprime une tâche', (await dc.c('DELETE', `${D}/tasks/${r.json.id}`)).status === 200 && (await dc.c('DELETE', `${D}/tasks/${r.json.id}`)).status === 404);

    console.log('Espace opérationnel : le directeur n\'y est que visiteur');
    r = await dc.c('GET', `${O}/crm/customers`);
    check('lecture de l\'espace de son équipe', r.status === 200);
    r = await dc.c('POST', `${O}/crm/customers`, { name: 'Client du directeur' });
    check('mais aucune écriture (403 consultation seule)', r.status === 403 && r.json.code === 'space_readonly', [r.status, r.json]);
    r = await dc.c('GET', `${O}/accounting/accounts`);
    check('pas de comptabilité (autre département : 403)', r.status === 403 && r.json.code === 'space_denied');
    r = await s1.c('POST', `${O}/crm/customers`, { name: 'Client du vendeur' });
    check('le vendeur, lui, travaille normalement dans l\'espace opérationnel', r.status < 400);

    console.log('Isolation entre départements');
    sp = await mine(daf.c, O);
    check('le DAF : sa direction en responsable, Finances en visiteur, rien du commercial', sp.dir_finances === 'manage' && sp.finances === 'view' && !sp.dir_commercial && !sp.commercial_write, sp);
    r = await daf.c('GET', `${D}/summary`);
    check('le DAF n\'ouvre pas la direction commerciale (403)', r.status === 403 && r.json.code === 'space_denied');
    r = await daf.c('POST', `${O}/dir_finances/tasks`, { title: 'Clôture annuelle' });
    check('le DAF crée SES tâches dans SON espace', r.status === 201);
    check('le directeur commercial ne voit pas les tâches du DAF (403)', (await dc.c('GET', `${O}/dir_finances/tasks`)).status === 403);
    check('… et le DAF ne voit pas celles du directeur commercial', (await daf.c('GET', `${D}/tasks`)).status === 403);
    r = await drh.c('GET', `${O}/dir_rh/summary`);
    check('le DRH a son espace de direction', r.status === 200 && r.json.space.opSpace === 'rh');
    // congés : décision par le DRH
    const emp = Number((await db.prepare("INSERT INTO employees (org_id, name, job, status, created_at) VALUES (?, 'Employé Congé', 'Vendeur', 'active', ?)").run(org, now)).lastInsertRowid);
    const lv = Number((await db.prepare("INSERT INTO leaves (org_id, employee_id, kind, start, \"end\", status, requested_by, created_at) VALUES (?, ?, 'annual', '2026-12-10', '2026-12-15', 'pending', ?, ?)").run(org, emp, ownerId, now)).lastInsertRowid);
    r = await drh.c('GET', `${O}/dir_rh/validations`);
    check('le DRH voit les congés à traiter', r.json.queues[0].kind === 'leave' && r.json.queues[0].items.length === 1 && r.json.queues[0].decide === true);
    check('le directeur commercial ne décide pas des congés (403)', (await dc.c('PUT', `${O}/dir_rh/validations/leave/${lv}`, { decision: 'approved' })).status === 403);
    check('décision inconnue refusée', (await drh.c('PUT', `${O}/dir_rh/validations/leave/${lv}`, { decision: 'peut-être' })).status === 400);
    r = await drh.c('PUT', `${O}/dir_rh/validations/leave/${lv}`, { decision: 'approved' });
    check('le DRH approuve le congé depuis son espace de direction', r.status === 200 && (await db.prepare('SELECT status FROM leaves WHERE id = ?').get(lv)).status === 'approved');
    check('… une demande déjà traitée est refusée (400)', (await drh.c('PUT', `${O}/dir_rh/validations/leave/${lv}`, { decision: 'refused' })).status === 400);

    console.log('Direction générale, propriétaire et administrateurs voient tout');
    sp = await mine(owner, O);
    check('le propriétaire : tous les espaces de direction en responsable', ['dir_general', 'dir_technique', 'dir_commercial', 'dir_finances', 'dir_rh', 'dir_production', 'dir_logistique', 'dir_stock', 'dir_marketing', 'dir_it', 'dir_securite'].every((k) => sp[k] === 'manage'), sp);
    check('l\'administrateur aussi', Object.keys(await mine(adm, O)).filter((k) => k.startsWith('dir_')).length === 11);
    check('le propriétaire lit le pilotage de chaque direction', (await owner('GET', `${D}/summary`)).status === 200 && (await owner('GET', `${O}/dir_finances/summary`)).status === 200);
    // un DG non propriétaire : consultation de tous les espaces, y compris les directions
    const dgp = await person(owner, E, 'dg2', 'Directeur Général Deux', 'inexistant', posts);
    await owner('PUT', `${E}/dg`, { personIds: [(await owner('GET', `${E}/chart`)).json.dg[0].id, dgp.personId] });
    sp = await mine(dgp.c, O);
    check('un DG non propriétaire : Direction et cockpit de la direction générale en responsable, directions de département en consultation', sp.direction === 'manage' && sp.dir_general === 'manage' && sp.dir_commercial === 'view' && sp.dir_finances === 'view', sp);
    check('… il lit les tâches d\'un directeur mais n\'écrit pas (403 consultation seule)', (await dgp.c('GET', `${D}/tasks`)).status === 200 && (await dgp.c('POST', `${D}/tasks`, { title: 'x' })).status === 403);

    console.log('Règles sur les postes (côté serveur)');
    r = await owner('PUT', `${E}/posts/${post('Commercial / vendeur').id}`, { spaces: { commercial: 'write', dir_commercial: 'view' } });
    check('un poste du personnel ne peut recevoir aucun espace de direction (400)', r.status === 400 && /réservés aux postes de directeur/.test(r.json.error), r.json);
    r = await owner('PUT', `${E}/posts/${post('Responsable commercial').id}`, { spaces: { commercial: 'manage', dir_commercial: 'view' } });
    check('… ni un responsable de département (chef) : seul le directeur (400)', r.status === 400);
    r = await owner('PUT', `${E}/posts/${post('Directeur commercial').id}`, { spaces: { dir_commercial: 'manage', dir_finances: 'manage' } });
    check('un directeur ne peut pas être responsable de la direction d\'un AUTRE département (400)', r.status === 400 && /SA direction/.test(r.json.error), r.json);
    r = await owner('PUT', `${E}/posts/${post('Directeur commercial').id}`, { spaces: { dir_commercial: 'manage', commercial: 'view', dir_marketing: 'view' } });
    check('… mais peut être visiteur de la direction d\'un autre département (affectation explicite)', r.status === 200);
    sp = await mine(dc.c, O);
    check('le directeur voit alors la direction marketing en consultation', sp.dir_marketing === 'view' && sp.dir_commercial === 'manage', sp);
    check('… sans écrire dans ses tâches', (await dc.c('POST', `${O}/dir_marketing/tasks`, { title: 'x' })).status === 403 && (await dc.c('GET', `${O}/dir_marketing/tasks`)).status === 200);
    await owner('PUT', `${E}/posts/${post('Directeur commercial').id}`, { spaces: { dir_commercial: 'manage', commercial: 'view', stock: 'view', direction: 'view' } });
    r = await owner('PUT', `${E}/posts/${post('Directeur commercial').id}`, { spaces: { dir_commercial: 'manage', commercial: 'manage' } });
    check('le propriétaire peut RELEVER l\'espace opérationnel du directeur (responsable de son espace)', r.status === 200 && (await mine(dc.c, O)).commercial === 'manage');
    await owner('PUT', `${E}/posts/${post('Directeur commercial').id}`, { spaces: { dir_commercial: 'manage', commercial: 'view', stock: 'view', direction: 'view' } });
    r = await owner('PUT', `${O}/spaces/assignments/${s1.id}`, { spaces: { dir_commercial: 'view', commercial: 'write', projets: 'write' } });
    check('(affectation explicite du propriétaire) un membre peut recevoir la direction en visiteur', r.status === 200 && (await s1.c('GET', `${D}/summary`)).status === 200 && (await s1.c('POST', `${D}/tasks`, { title: 'x' })).status === 403);
    await owner('PUT', `${O}/spaces/assignments/${s1.id}`, { spaces: { commercial: 'write', projets: 'write' } });
    check('… retiré : il est de nouveau refusé', (await s1.c('GET', `${D}/summary`)).status === 403);

    console.log('Isolation entre organisations');
    check('l\'autre organisation ne lit pas l\'espace de direction de la première (404)', (await o2('GET', `${D}/summary`)).status === 404);
    const dc2 = await person(o2, E2, 'dc2', 'Directeur Com B', 'Directeur commercial', posts2);
    check('le directeur commercial de B a son espace dans B', (await dc2.c('GET', `${O2}/dir_commercial/summary`)).status === 200);
    check('… et n\'a rien dans A (404) : le directeur commercial de A n\'est pas celui de B', (await dc2.c('GET', `${D}/summary`)).status === 404 && (await dc.c('GET', `${O2}/dir_commercial/summary`)).status === 404);
    await dc2.c('POST', `${O2}/dir_commercial/tasks`, { title: 'Tâche de B' });
    check('les tâches de B ne sont pas dans A', !JSON.stringify((await dc.c('GET', `${D}/tasks`)).json).includes('Tâche de B'));
    check('sans connexion : 401', (await client(base)('GET', `${D}/summary`)).status === 401);

    console.log('Profils de rôle');
    r = await dc.c('GET', `${E}/my-profile`);
    check('le profil du directeur commercial affiche le pilotage de SA direction', r.json.profile.key === 'dir_commercial' && r.json.blocks.some((b) => b.type === 'tiles' && b.space === 'dir_commercial'), r.json.blocks.map((b) => b.type + ':' + (b.space || '')));
    r = await s1.c('GET', `${E}/my-profile`);
    check('le profil du vendeur reste opérationnel (arrive sur « Mon espace de travail »)', r.json.profile.key === 'vendeur' && !r.json.blocks.some((b) => b.space && b.space.startsWith('dir_')) && (await s1.c('GET', O)).json.profile.landing === true);
    r = await owner('GET', `${E}/profiles`);
    check('tous les profils existants sont conservés (24)', r.json.profiles.length === 24);
    check('les profils de directeur pointent vers leur espace de direction (DG, DT et 9 directions)', r.json.profiles.filter((p) => p.config.directionSpace).length === 11);

    console.log('Non-régression : organisation existante, activation, retour arrière');
    const org3 = (await o3('POST', '/api/ws/orgs', { name: 'Ancienne Entreprise' })).json.id; const O3 = `/api/ws/orgs/${org3}`; const E3 = `${O3}/entreprise`;
    await o3('POST', `${E3}/template`, { sector: 'commerce' });
    const posts3 = flat((await o3('GET', `${E3}/chart`)).json);
    // on remet l'organisation dans l'état d'avant (postes tels que le modèle les faisait, réglage coupé)
    for (const d of T.DIRECTIONS) await db.prepare('UPDATE ent_posts SET spaces = ? WHERE org_id = ? AND tkey = ?').run(JSON.stringify(T.LEGACY_DIRECTOR_SPACES['dir_' + d.key]), org3, 'dir_' + d.key);
    await db.prepare('UPDATE ent_setup SET dir_spaces = 0 WHERE org_id = ?').run(org3);
    const dcl = await person(o3, E3, 'dcl', 'Directeur Com Ancien', 'Directeur commercial', posts3);
    const stf = await person(o3, E3, 'stf', 'Vendeur Ancien', 'Commercial / vendeur', posts3);
    sp = await mine(dcl.c, O3);
    check('espaces de direction coupés : le directeur garde EXACTEMENT son régime d\'avant (Commercial en responsable, aucun espace de direction)', sp.commercial === 'manage' && !Object.keys(sp).some((k) => k.startsWith('dir_')), sp);
    check('… et les routes de direction répondent 403', (await dcl.c('GET', `${O3}/dir_commercial/summary`)).status === 403);
    check('le propriétaire ne voit aucun nouvel espace', !Object.keys(await mine(o3, O3)).some((k) => k.startsWith('dir_')));
    r = await dcl.c('POST', `${O3}/crm/customers`, { name: 'Client ancien' });
    check('le directeur écrit comme avant dans son espace opérationnel', r.status < 400);
    check('le personnel inchangé', (await mine(stf.c, O3)).commercial === 'write');
    check('seul le propriétaire active', (await adm('POST', `${E}/direction/enable`)).status === 403 && (await dcl.c('POST', `${E3}/direction/enable`)).status === 403);
    r = await o3('POST', `${E3}/direction/enable`);
    check('le propriétaire active : les postes de directeur du modèle sont convertis', r.status === 200 && r.json.converted >= 8, r.json);
    sp = await mine(dcl.c, O3);
    check('le directeur a maintenant son espace de direction et l\'espace opérationnel en visiteur', sp.dir_commercial === 'manage' && sp.commercial === 'view', sp);
    r = await dcl.c('POST', `${O3}/crm/customers`, { name: 'Client refusé' });
    check('… il ne peut plus écrire dans l\'espace opérationnel (403)', r.status === 403);
    check('le personnel reste opérationnel et sans direction', (await mine(stf.c, O3)).commercial === 'write' && !Object.keys(await mine(stf.c, O3)).some((k) => k.startsWith('dir_')));
    r = await o3('POST', `${E3}/direction/disable`);
    sp = await mine(dcl.c, O3);
    check('retour arrière par réglage : l\'espace de direction disparaît (le directeur retrouve l\'espace opérationnel visiteur issu de son poste converti)', r.status === 200 && !Object.keys(sp).some((k) => k.startsWith('dir_')) && (await dcl.c('GET', `${O3}/dir_commercial/summary`)).status === 403, sp);
    await o3('POST', `${E3}/direction/enable`);
    process.env.DIRECTION_SPACES = 'off';
    check('retour arrière général (DIRECTION_SPACES=off) : plus d\'espace de direction, routes refusées', !Object.keys(await mine(dcl.c, O3)).some((k) => k.startsWith('dir_')) && (await dcl.c('GET', `${O3}/dir_commercial/summary`)).status === 403 && !Object.keys(await mine(owner, O)).some((k) => k.startsWith('dir_')));
    r = await o3('POST', `${E3}/direction/enable`);
    check('… et le propriétaire en est informé (409)', r.status === 409);
    check('… le tableau d\'ensemble signale l\'interrupteur', (await o3('GET', E3)).json.direction.globalOff === true);
    delete process.env.DIRECTION_SPACES;
    check('variable retirée : tout revient, rien de perdu', (await dcl.c('GET', `${O3}/dir_commercial/tasks`)).status === 200 || (await mine(dcl.c, O3)).dir_commercial === 'manage');
    // organisation liée : le réglage suit la copie de structure
    const lk = (await owner('POST', `${E}/links`, { label: 'Filiale' })).json; const ob = client(base); await reg(ob, 'Filiale Directrice', 'fb');
    const orgB = (await ob('POST', '/api/ws/orgs', { name: 'Filiale', associationCode: lk.code })).json.id;
    check('une organisation liée copie la structure ET le réglage des espaces de direction', (await ob('GET', `/api/ws/orgs/${orgB}/entreprise`)).json.direction.enabled === true);
    const log = JSON.stringify((await owner('GET', `${E}/log`)).json) + JSON.stringify((await o3('GET', `${E3}/log`)).json);
    check('le journal d\'audit contient l\'activation et la désactivation', /ent_direction/.test(log));
    const au = JSON.stringify(await db.prepare("SELECT entity, action FROM audit_log WHERE entity LIKE 'dir\\_%' ESCAPE '\\'").all());
    check('les actions du directeur (tâches, notes, objectifs, validations) sont journalisées sans leur contenu', /dir_task/.test(au) && /dir_note/.test(au) && /dir_objective/.test(au) && /dir_validation/.test(au) && !au.includes('Confidentiel') && !au.includes('Plafond'));
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
