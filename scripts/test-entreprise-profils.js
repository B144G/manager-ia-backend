'use strict';
// Compte d'entreprise, étape 3 : moteur de profils de rôle (blocs, modules, actions rapides, mode mobile), profils de base, modification par l'entreprise,
// absence de droits donnés par le profil, isolation. Lancez-le avec : npm run test:entreprise-profils
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
  const PR = require('../src/workspace/ent-profiles');
  const { HttpError } = require('../src/util');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'Secret-Pass-123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const owner = client(base); const other = client(base);
    await reg(owner, 'Nkoulou Paul', 'nk'); await reg(other, 'Autre Dirigeant', 'ot');
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ?").run(new Date(Date.now() + 86400000 * 30).toISOString());
    const org = (await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' })).json.id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
    const org2 = (await other('POST', '/api/ws/orgs', { name: 'Transports Eto', currency: 'FCFA' })).json.id; const O2 = `/api/ws/orgs/${org2}`; const E2 = `${O2}/entreprise`;
    await owner('POST', `${E}/template`, { sector: 'commerce' }); await other('POST', `${E2}/template`, { sector: 'transport' });
    const flat = (ch) => [...ch.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...ch.departments.flatMap((x) => x.posts)];
    const posts = flat((await owner('GET', `${E}/chart`)).json); const post = (t) => posts.find((p) => p.title === t).id;
    const posts2 = flat((await other('GET', `${E2}/chart`)).json); const post2 = (t) => posts2.find((p) => p.title === t).id;
    const join = async (ownerC, E_, tag, name, postTitle, postsList) => {
      const id = (postsList.find((p) => p.title === postTitle) || {}).id;
      const r = await ownerC('POST', `${E_}/people`, { fullName: name, email: `${tag}${stamp}@entreprise.cm`, postIds: id ? [id] : [] });
      const c = client(base); await reg(c, name, tag); await c('POST', '/api/ws/orgs/join', { code: r.json.code }); return c;
    };

    console.log('Migrations et profils de base');
    check('migrations 420 (profils) et 421 (profil du poste) ; 413 à 419 réservées', /ent_profiles/.test(MIGRATIONS[419]) && /profile_key/.test(MIGRATIONS[420]) && MIGRATIONS.slice(412, 419).every((m) => /reserve/.test(m)), MIGRATIONS.length);
    check('au moins une quinzaine de profils de base', PR.CATALOG.length >= 15, PR.CATALOG.length);
    const need = ['dg', 'daf', 'comptable', 'tresorier', 'dir_commercial', 'vendeur', 'dir_production', 'chef_production', 'metreur', 'dir_logistique', 'dispatcheur', 'chauffeur', 'acheteur', 'magasinier', 'drh', 'dir_it', 'dir_securite'];
    check('les profils demandés existent (DG, DAF, comptable, trésorier, directeur commercial, vendeur, directeur de production, chef de production, métreur, directeur logistique, dispatcheur, chauffeur, acheteur, magasinier, DRH, directeur IT, directeur sécurité)', need.every((k) => PR.BASE[k]), need.filter((k) => !PR.BASE[k]));
    const ids = require('../src/workspace/modules').modules.map((m) => m.id);
    let allOk = true; for (const p of PR.CATALOG) { try { PR.cleanConfig(p.config, ids, HttpError); } catch (e) { allOk = false; console.log('   invalide :', p.key, e.message); } }
    check('chaque profil de base est valide (blocs, listes, modules, mode mobile connus)', allOk);
    check('aucun profil ne repose sur un module inexistant', PR.CATALOG.every((p) => p.config.modules.every((m) => ids.includes(m)) && p.config.quick.every((x) => ids.includes(x.module))));
    const ch = PR.BASE.chauffeur.config;
    check('le chauffeur a l\'écran mobile : missions du jour, carburant, incidents', ch.mobile.layout === 'driver' && ['driver', 'fuel', 'incident'].every((n) => ch.blocks.some((b) => b.type === 'component' && b.name === n)));
    r0: {
      const r = await owner('GET', `${E}/profiles`);
      check('la liste des profils est lisible par l\'entreprise (avec les postes concernés)', r.status === 200 && r.json.profiles.length >= 15 && r.json.profiles.find((p) => p.key === 'comptable').posts.includes('Comptable'), r.json && r.json.profiles && r.json.profiles.length);
      check('le catalogue des blocs est fourni (listes, composants, modules)', r.json.catalogue.lists.length >= 10 && r.json.catalogue.components.length === 3);
    }

    console.log('Profil d\'une personne affectée');
    const cpt = await join(owner, E, 'cpt', 'Comptable Ada', 'Comptable', posts);
    let r = await cpt('GET', `${E}/my-profile`);
    check('le comptable reçoit le profil « Comptable »', r.status === 200 && r.json.profile.key === 'comptable' && r.json.posts.includes('Comptable'), r.json);
    check('ses blocs : indicateurs de Comptabilité et finances, factures à encaisser', r.json.blocks.some((b) => b.type === 'tiles' && b.space === 'finances' && b.tiles.length) && r.json.blocks.some((b) => b.type === 'list' && b.source === 'unpaid_invoices'), r.json.blocks.map((b) => b.type + ':' + (b.space || b.source || b.name || '')));
    check('ses modules : comptabilité, trésorerie ; pas la paie ni les RH', r.json.modules.includes('accounting') && r.json.modules.includes('treasury') && !r.json.modules.includes('payroll') && !r.json.modules.includes('hr'), r.json.modules);
    check('ses actions rapides pointent vers des modules accessibles', r.json.quick.length >= 2 && r.json.quick.every((x) => r.json.modules.includes(x.module) || x.module === 'crm'));
    r = await cpt('GET', O);
    check('à l\'ouverture de l\'organisation, la personne affectée arrive sur son profil (profile.landing)', r.json.profile && r.json.profile.key === 'comptable' && r.json.profile.landing === true, r.json.profile);
    r = await owner('GET', O);
    check('le propriétaire (DG sans poste) garde son arrivée habituelle', r.json.profile && r.json.profile.landing === false);
    const mem = await join(owner, E, 'sp', 'Sans Poste', 'inexistant', posts);
    r = await mem('GET', `${E}/my-profile`);
    check('une personne sans poste n\'a pas de profil (son écran habituel est inchangé)', r.status === 200 && r.json.profile === null, r.json);
    r = await owner('GET', `${E}/my-profile`);
    check('le propriétaire (directeur général) a le profil « Directeur général »', r.json.profile && r.json.profile.key === 'dg' && r.json.blocks.length > 0, r.json.profile);
    const dirC = await join(owner, E, 'dirco', 'Directeur Com', 'Directeur commercial', posts);
    r = await dirC('GET', `${E}/my-profile`);
    check('le directeur commercial reçoit son profil', r.json.profile.key === 'dir_commercial');
    const mag = await join(owner, E, 'mag', 'Magasinier Paul', 'Magasinier', posts);
    r = await mag('GET', `${E}/my-profile`);
    check('le magasinier : profil compact, stock', r.json.profile.key === 'magasinier' && r.json.profile.layout === 'compact' && r.json.modules.includes('stock'), r.json.profile);

    console.log('Le profil ne donne aucun droit');
    // on force le profil « DG » sur le poste du magasinier : ses droits (espaces) ne changent pas
    r = await owner('PUT', `${E}/posts/${post('Magasinier')}/profile`, { key: 'dg' });
    check('le profil d\'un poste se choisit', r.status === 200);
    const before = (await mag('GET', O)).json.spaces.spaces.map((s) => `${s.id}:${s.level}`).join(',');
    r = await mag('GET', `${E}/my-profile`);
    check('le profil « DG » sur un magasinier affiche seulement ce qu\'il a déjà le droit de voir', r.json.profile.key === 'dg' && !r.json.blocks.some((b) => b.type === 'tiles' && ['finances', 'rh', 'direction'].includes(b.space)) && !r.json.modules.includes('accounting') && !r.json.modules.includes('aifollow'), r.json.blocks.map((b) => b.type + ':' + (b.space || b.source || '')));
    check('… et ses droits n\'ont pas bougé', (await mag('GET', O)).json.spaces.spaces.map((s) => `${s.id}:${s.level}`).join(',') === before);
    r = await mag('GET', `${O}/accounting/accounts`);
    check('… la comptabilité reste interdite', r.status === 403);
    r = await owner('PUT', `${E}/posts/${post('Magasinier')}/profile`, { key: 'inconnu' });
    check('profil inconnu refusé', r.status === 400);
    r = await owner('PUT', `${E}/posts/${post('Magasinier')}/profile`, { key: null });
    check('retour au profil du modèle', r.status === 200 && (await mag('GET', `${E}/my-profile`)).json.profile.key === 'magasinier');
    r = await owner('PUT', `${E}/posts/${post('Caissier')}/profile`, { key: 'daf', applyRights: true });
    check('reprendre les accès par défaut d\'un profil (applyRights) met à jour le poste', r.status === 200 && JSON.stringify((await owner('GET', `${E}/chart`)).json).includes('"finances":"manage"'));

    console.log('Chauffeur (écran mobile) dans une entreprise de transport');
    const chf = await join(other, E2, 'chf', 'Chauffeur Mbia', 'Chauffeur', posts2);
    r = await chf('GET', `${E2}/my-profile`);
    check('le chauffeur reçoit le profil mobile avec missions, carburant et incidents', r.json.profile.key === 'chauffeur' && r.json.profile.layout === 'driver' && ['driver', 'fuel', 'incident'].filter((n) => r.json.blocks.some((b) => b.name === n)).length >= 2, r.json);
    check('… et l\'écran des missions du chauffeur répond (route existante)', (await chf('GET', `${O2}/logistics/tms/driver`)).status === 200);
    const dsp = await join(other, E2, 'dsp', 'Dispatcheur Ngo', 'Dispatcheur', posts2);
    check('le dispatcheur a le sien', (await dsp('GET', `${E2}/my-profile`)).json.profile.key === 'dispatcheur');

    console.log('Modification par l\'entreprise');
    const cfg = JSON.parse(JSON.stringify((await owner('GET', `${E}/profiles`)).json.profiles.find((p) => p.key === 'magasinier').config));
    cfg.blocks.push({ type: 'list', source: 'pending_orders' }); cfg.quick.push({ label: 'Mes réceptions', module: 'purchasing' });
    r = await mem('PUT', `${E}/profiles/magasinier`, { config: cfg });
    check('un membre ne peut pas modifier un profil (403)', r.status === 403);
    r = await owner('PUT', `${E}/profiles/magasinier`, { config: cfg });
    check('l\'entreprise modifie un profil (blocs et actions rapides)', r.status === 200);
    r = await mag('GET', `${E}/my-profile`);
    check('le profil modifié est servi (liste ajoutée, action rapide renommée) et marqué « modifié »', r.json.profile.custom === true && r.json.blocks.some((b) => b.source === 'pending_orders') && r.json.quick.some((x) => x.label === 'Mes réceptions'), r.json.profile);
    check('une autre organisation garde le profil de base', (await other('GET', `${E2}/profiles`)).json.profiles.find((p) => p.key === 'magasinier').custom === false);
    for (const [what, patch] of [['module inconnu', { modules: ['inexistant'] }], ['type de bloc inconnu', { blocks: [{ type: 'script', code: 'alert(1)' }] }], ['liste inconnue', { blocks: [{ type: 'list', source: 'DROP TABLE' }] }], ['composant inconnu', { blocks: [{ type: 'component', name: 'x' }] }], ['mode mobile inconnu', { mobile: { layout: 'hologramme' } }], ['espace inconnu', { blocks: [{ type: 'tiles', space: 'cave' }] }], ['action rapide vers un module inconnu', { quick: [{ label: 'x', module: 'zzz' }] }], ['trop de blocs', { blocks: Array(13).fill({ type: 'tasks' }) }], ['accès non valides', { spaces: { finances: 'super' } }]]) {
      r = await owner('PUT', `${E}/profiles/magasinier`, { config: { ...cfg, ...patch } });
      check(`configuration refusée : ${what}`, r.status === 400, r.status);
    }
    r = await owner('PUT', `${E}/profiles/inexistant`, { config: cfg });
    check('profil inexistant : 404', r.status === 404);
    r = await owner('DELETE', `${E}/profiles/magasinier`);
    check('réinitialisation au profil de base', r.status === 200 && (await mag('GET', `${E}/my-profile`)).json.profile.custom === false);

    console.log('Isolation et droits');
    check('une autre entreprise ne lit pas les profils de la première (404)', (await other('GET', `${E}/profiles`)).status === 404);
    check('… ne modifie pas (404)', (await other('PUT', `${E}/profiles/magasinier`, { config: cfg })).status === 404);
    check('… ne voit pas le profil d\'une personne (404)', (await other('GET', `${E}/my-profile`)).status === 404);
    check('un membre lit son profil mais pas la configuration complète n\'est pas secrète (lecture ouverte)', (await mem('GET', `${E}/profiles`)).status === 200);
    check('sans connexion : 401', (await client(base)('GET', `${E}/my-profile`)).status === 401);
    const log = JSON.stringify((await owner('GET', `${E}/log`)).json);
    check('les changements de profil sont journalisés', /ent_profile/.test(log));
    r = await owner('PUT', `${E}/posts/${post('Magasinier')}/profile`, { key: 'dg', applyRights: true });
    check('un administrateur ne peut pas donner plus de droits qu\'il n\'en a via un profil (aucun profil de base ne donne « responsable du compte »)', PR.CATALOG.every((p) => p.config.spaces.compte !== 'manage'));
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
