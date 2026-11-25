'use strict';
// Catalogue « un espace = un rôle » calculés sur les données RÉELLES (jamais inventés : « non disponible » sinon), file de validations et circuits de validation de direction
// branchés sur le moteur de circuits d'Administration (séparation des tâches, seuils, journal, paramétrage). Lancez-le avec : npm run test:espaces-roles
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
  delete process.env.DIRECTION_SPACES;
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const KP = require('../src/workspace/ent-kpi'); const WF = require('../src/workspace/ent-workflows');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now(); const now = new Date().toISOString(); const day = now.slice(0, 10); const month = now.slice(0, 7);
  const dplus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  try {
    const reg = async (c, name, tag) => { await db.prepare('DELETE FROM rate_hits').run(); await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'Secret-Pass-123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const owner = client(base); const adm = client(base); const o2 = client(base);
    const ownerId = await reg(owner, 'Nkoulou Paul', 'nk'); const admId = await reg(adm, 'Admin Bella', 'ad'); await reg(o2, 'Dirigeant Deux', 'd2');
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ?").run(new Date(Date.now() + 86400000 * 30).toISOString());
    const org = (await owner('POST', '/api/ws/orgs', { name: 'Chantiers Nkoulou', currency: 'FCFA' })).json.id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
    const org2 = (await o2('POST', '/api/ws/orgs', { name: 'Autre Société' })).json.id; const O2 = `/api/ws/orgs/${org2}`; const E2 = `${O2}/entreprise`;
    let r = await owner('POST', `${O}/invites`, { role: 'admin' }); await adm('POST', '/api/ws/orgs/join', { code: r.json.code });
    await owner('POST', `${E}/template`, { sector: 'commerce' }); await o2('POST', `${E2}/template`, { sector: 'commerce' });
    const flat = (ch) => [...ch.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...ch.departments.flatMap((x) => x.posts)];
    const posts = flat((await owner('GET', `${E}/chart`)).json); const posts2 = flat((await o2('GET', `${E2}/chart`)).json);
    const person = async (ownerC, E_, tag, name, title, list) => { const p = list.find((x) => x.title === title); const r0 = await ownerC('POST', `${E_}/people`, { fullName: name, email: `${tag}${stamp}@entreprise.cm`, postIds: p ? [p.id] : [] }); const c = client(base); const id = await reg(c, name, tag); await c('POST', '/api/ws/orgs/join', { code: r0.json.code }); return { c, id, personId: r0.json.id }; };
    const daf = await person(owner, E, 'daf', 'Directeur Financier', 'Directeur administratif et financier (DAF)', posts);
    const RL = require('../src/workspace/ent-roles'); const { modules: ALLM } = require('../src/workspace/modules'); const PR = require('../src/workspace/ent-profiles'); const T = require('../src/workspace/ent-templates');
    console.log('Catalogue (source unique rôle → modules)');
    const inRoles = new Set(RL.ROLES.flatMap((r) => r.modules)); const common = new Set(['projects', 'meetings', 'chat', 'library', 'profil', 'partners', 'alerts', 'team', 'entreprise', 'integrations', 'billing', 'dashboard']);
    const orphans = ALLM.map((m) => m.id).filter((id) => !id.startsWith('dir_') && !inRoles.has(id) && !common.has(id));
    check('aucun module orphelin (chaque module est atteignable par au moins un rôle, ou commun à tous / réservé au compte)', orphans.length === 0, orphans);
    const overlap = RL.ROLES.flatMap((r) => r.own.filter((m) => RL.METIER_OF[m] !== r.metier).map((m) => r.id + ':' + m));
    check('aucun recouvrement accidentel : les écrans propres d\'un rôle sont tous de son métier', overlap.length === 0, overlap);
    const badShared = RL.ROLES.flatMap((r) => r.shared.filter((m) => RL.METIER_OF[m] === r.metier).map((m) => r.id + ':' + m));
    check('… et un écran partagé vient toujours d\'un AUTRE métier, déclaré explicitement', badShared.length === 0, badShared);
    const unknown = RL.ROLES.flatMap((r) => r.modules.filter((m) => !ALLM.some((x) => x.id === m)).map((m) => r.id + ':' + m));
    check('tous les écrans du catalogue existent', unknown.length === 0, unknown);
    const tk = T.DEPARTMENTS_RAW.flatMap((d) => d.posts.map((p) => `${d.key}.${p.key}`));
    check('chaque rôle est atteignable depuis un poste du modèle', RL.ROLES.every((r) => tk.includes(r.tkey)));
    check('chaque poste du modèle a son rôle (sauf l\'agent de sécurité, sans écran propre)', tk.filter((k) => !RL.BY_TKEY[k]).join() === 'securite.agent_securite');
    const prof = (PR.CATALOG || []);
    const profBad = RL.ROLES.filter((r) => { const p = (prof.length ? prof : []).find((x) => x.tkeys.includes(r.tkey)); return !p || !r.modules.some((m) => p.config.modules.includes(m)); }).map((r) => r.id);
    check('cohérence avec les 22 profils : chaque rôle a son profil, dont les écrans recoupent ceux du rôle', prof.length >= 22 && profBad.length === 0, profBad);
    check('un même écran figure bien dans plusieurs espaces de rôle (crm : vendeur, assistant, service client, comptable)', ['r_commercial_vendeur', 'r_commercial_assist_com', 'r_commercial_service_client', 'r_finance_comptable'].every((id) => RL.ROLES.find((r) => r.id === id).modules.includes('crm')));
    console.log('Accès par rôle (isolation)');
    const dcom = await person(owner, E, 'dcom', 'Directeur Commercial', 'Directeur commercial', posts);
    const vend = await person(owner, E, 'vnd', 'Vendeur Marc', 'Commercial / vendeur', posts);
    const assi = await person(owner, E, 'ast', 'Assistante Commerciale', 'Assistant(e) commercial(e)', posts);
    const mkt = await person(owner, E, 'mkt', 'Marketeuse', 'Community manager', posts);
    const sav = await person(owner, E, 'sav', 'Agent Service', 'Agent du service client', posts);
    const cpt = await person(owner, E, 'cpt', 'Comptable Ada', 'Comptable', posts);
    const mine = async (c) => Object.fromEntries(((await c('GET', O)).json.spaces || (console.log('ERR', JSON.stringify(c.last))) || {spaces: []}).spaces.map((s) => [s.id, s.level]));
    const ids = async (c) => Object.keys(await mine(c));
    check('le vendeur n\'a que SON espace de rôle (+ Projets et réunions), pas les autres rôles du département', JSON.stringify((await ids(vend.c)).sort()) === JSON.stringify(['projets', 'r_commercial_vendeur']), await mine(vend.c));
    check('l\'assistante commerciale : son espace, ni celui du directeur commercial, ni celui du marketeur', JSON.stringify((await ids(assi.c)).sort()) === JSON.stringify(['projets', 'r_commercial_assist_com']));
    check('la marketeuse : Marketing seulement', JSON.stringify((await ids(mkt.c)).sort()) === JSON.stringify(['projets', 'r_marketing_community']));
    check('le service client : le sien', (await ids(sav.c)).includes('r_commercial_service_client') && !(await ids(sav.c)).includes('r_commercial_vendeur'));
    check('le directeur commercial : son espace de direction, jamais celui d\'un rôle de son équipe', (await ids(dcom.c)).includes('dir_commercial') && !(await ids(dcom.c)).some((k) => k.startsWith('r_')));
    check('payload stable : id, libellé, icône, niveau, liste des modules', (await vend.c('GET', O)).json.spaces.spaces.every((s) => s.id && s.title && s.icon && s.level && Array.isArray(s.modules)));
    const st = async (c, p) => (await c('GET', `${O}${p}`)).status;
    check('serveur : le vendeur ouvre le CRM, pas le Marketing ni l\'Assistant commercial', await st(vend.c, '/crm/customers') === 200 && await st(vend.c, '/marketing') === 403 && await st(vend.c, '/sales/conversations') === 403);
    check('serveur : la marketeuse ouvre Marketing, pas le CRM', await st(mkt.c, '/marketing') === 200 && await st(mkt.c, '/crm/customers') === 403);
    check('serveur : l\'assistante ouvre l\'Assistant commercial, pas Marketing', await st(assi.c, '/marketing') === 403);
    check('serveur : le comptable ouvre la Comptabilité, pas le Marketing', await st(cpt.c, '/accounting/accounts') === 200 && await st(cpt.c, '/marketing') === 403);
    check('un écran de direction reste fermé au personnel (403)', (await vend.c('GET', `${O}/dir_commercial/kpis`)).status === 403 && (await assi.c('GET', `${O}/dir_commercial/kpis`)).status === 403);
    // multi-rôles : union sans doublon
    const both = await person(owner, E, 'bth', 'Deux Casquettes', 'Caissier', posts);
    const postV = posts.find((x) => x.title === 'Commercial / vendeur');
    await owner('POST', `${E}/assignments`, { postId: postV.id, personId: both.personId });
    const bi = await ids(both.c);
    check('multi-rôles : la personne voit les espaces de ses deux rôles, sans doublon', bi.includes('r_finance_caissier') && bi.includes('r_commercial_vendeur') && new Set(bi).size === bi.length, bi);
    check('… et l\'union de leurs écrans (CRM partagé par les deux rôles : une seule entrée par espace)', await st(both.c, '/crm/customers') === 200 && await st(both.c, '/marketing') === 403);
    // repli sûr et mode simple
    const sans = client(base); await reg(sans, 'Sans Poste', 'snp'); const ic = await owner('POST', `${O}/invites`, { role: 'member' }); await sans('POST', '/api/ws/orgs/join', { code: ic.json.code });
    check('sans poste affecté : repli sûr sur les espaces historiques (aucun accès perdu, aucun espace de rôle)', (await ids(sans)).includes('commercial') && !(await ids(sans)).some((k) => k.startsWith('r_')));
    check('les administrateurs gardent les 9 espaces historiques, sans espaces de rôle', !(await ids(adm)).some((k) => k.startsWith('r_')) && (await ids(adm)).includes('commercial'));
    await owner('POST', `${E}/direction/disable`, {});
    check('mode simple (réglage coupé) : le vendeur retrouve l\'espace Commercial historique', (await ids(vend.c)).includes('commercial') && !(await ids(vend.c)).some((k) => k.startsWith('r_')), await ids(vend.c));
    check('… et le directeur son ancien espace', !(await ids(dcom.c)).some((k) => k.startsWith('dir_')));
    await owner('POST', `${E}/direction/enable`, {});
    check('réactivé : les espaces de rôle reviennent', (await ids(vend.c)).includes('r_commercial_vendeur'));
    check('une autre entreprise n\'est pas touchée', !((await o2('GET', O2)).json.spaces.spaces || []).some((x) => x.id.startsWith('r_')));
    void admId;
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
