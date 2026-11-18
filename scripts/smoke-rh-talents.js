'use strict';
// Test de fumée RH Talents sur le serveur de démonstration (scripts/demo-local.js) : node scripts/smoke-rh-talents.js <port>
// Se connecte en propriétaire et en simple membre, parcourt les écrans du module et vérifie les droits. Ne modifie rien d'important.
const port = process.argv[2] || process.env.PORT;
if (!port) { console.error('Usage : node scripts/smoke-rh-talents.js <port>'); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
const client = () => {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
    return { status: res.status, json };
  };
};
let ok = 0; let ko = 0;
const check = (n, c, e) => { if (c) { ok++; console.log('  OK   ' + n); } else { ko++; console.log('  ECHEC ' + n + (e === undefined ? '' : ' -> ' + JSON.stringify(e).slice(0, 300))); } };
(async () => {
  const PASS = 'Essai-2026-brij';
  const owner = client(); const member = client();
  let r = await owner('POST', '/api/login', { contact: 'proprietaire@exemple.com', pass: PASS });
  check('connexion propriétaire', r.status === 200, r);
  await member('POST', '/api/login', { contact: 'eric@exemple.com', pass: PASS });
  r = await owner('GET', '/api/ws/orgs'); const org = (r.json.orgs || r.json)[0].id; const T = `/api/ws/orgs/${org}/talents`;
  r = await owner('GET', `/api/ws/orgs/${org}`);
  check('le module « talents » figure au menu', r.json.modules.some((m) => m.id === 'talents'), r.json.modules.map((m) => m.id));
  const get = async (name, path, who = owner, test = (j) => true) => { const x = await who('GET', T + path); check(name, x.status === 200 && test(x.json), x.status === 200 ? x.json : x); return x.json; };
  await get('/me propriétaire : tous les rôles RH', '/me', owner, (j) => j.isOwner && j.roles.length === 4);
  await get('compétences', '/competencies', owner, (j) => j.items.length >= 6);
  await get('emplois avec exigences', '/job-profiles', owner, (j) => j.items.some((x) => x.competencies.length >= 3));
  await get('matrice des compétences', '/gpec/matrix', owner, (j) => j.rows.length >= 3 && j.competencies.length >= 6);
  await get('écarts de compétences', '/gpec/gaps', owner, (j) => j.items.length >= 2 && j.summary.avgCoverage !== null);
  await get('besoins futurs', '/gpec/needs', owner, (j) => j.items.some((i) => i.needed === 4));
  await get('offres', '/recruitment/jobs', owner, (j) => j.items.length >= 1);
  const jobs = await owner('GET', `${T}/recruitment/jobs`);
  await get('pipeline de recrutement', `/recruitment/pipeline?jobId=${jobs.json.items[0].id}`, owner, (j) => j.columns.length === 6 && j.columns.flatMap((c) => c.items).length === 3);
  await get('candidats classés par correspondance', '/recruitment/candidates', owner, (j) => j.items[0].match >= j.items[1].match);
  await get('objectifs en cascade', `/goals/tree?period=${new Date().getFullYear()}`, owner, (j) => j.items.length >= 1 && j.items[0].children.length >= 1);
  await get('scores de réalisation', '/goals-scores', owner, (j) => j.items.length >= 2);
  await get('campagnes 360°', '/360/campaigns', owner, (j) => j.items.length === 1 && j.items[0].status === 'open');
  await get('tableau de bord RH', '/kpi/dashboard', owner, (j) => j.headcount.active >= 3 && j.payroll && j.alerts);
  await get('formation : bilan', '/training/summary', owner, (j) => j.budget.amount === 500000);
  await get('formation : écarts et suggestions', '/training/suggestions', owner, (j) => j.items.length >= 1);
  await get('9-box', '/talent/ninebox', owner, (j) => j.counts.rated >= 3);
  await get('viviers', '/talent/pools', owner, (j) => j.items.length === 1);
  await get('PDI', '/talent/idp', owner, (j) => j.items.length === 1);
  await get('positionnement salarial', '/comp/positioning', owner, (j) => j.items.length >= 3);
  await get('simulations salariales', '/comp/simulations', owner, (j) => j.items.length === 1);
  await get('masse salariale prévisionnelle', '/comp/forecast', owner, (j) => j.months.length === 12);
  await get('effectifs vs budget', '/workforce/overview', owner, (j) => j.items.length === 3);
  await get('succession', '/career/succession', owner, (j) => j.items.length === 1);
  await get('rétention', '/career/retention', owner, (j) => j.items.length === 1);
  const sv = await owner('GET', `${T}/engagement/surveys`);
  await get('engagement : résultats publiables (4 réponses ≥ seuil 3)', `/engagement/surveys/${sv.json.items[0].id}/results`, owner, (j) => j.hidden === false && j.enps && j.enps.n >= 3);
  await get('journal de traçabilité', '/audit', owner, (j) => j.items.length > 10);
  await get('rôles RH', '/roles', owner, (j) => j.members.length >= 5);
  // simple membre : accès à son espace seulement
  await get('membre : /me', '/me', member, (j) => !j.isOwner && j.roles.length === 0);
  for (const p of ['/kpi/dashboard', '/comp/positioning', '/gpec/matrix', '/talent/ninebox', '/recruitment/jobs', '/audit', '/roles', '/career/succession', '/workforce/overview']) {
    const x = await member('GET', T + p); check(`membre : ${p} refusé`, x.status === 403, x.status);
  }
  const mine = await member('GET', `${T}/goals`); check('membre : voit les objectifs d’entreprise/équipe', mine.status === 200 && mine.json.items.some((g) => g.level === 'company'), mine.status);
  const mt = await member('GET', `${T}/360/todo`); check('membre : 360° à remplir', mt.status === 200 && Array.isArray(mt.json.items));
  const ms = await member('GET', `${T}/engagement/surveys`); check('membre : enquête ouverte visible sans compteur de réponses', ms.status === 200 && ms.json.items[0].responses === undefined);
  console.log(`\n${ok} réussis, ${ko} échoués`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
