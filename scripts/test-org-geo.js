'use strict';
// Position des entreprises : saisie par l'entreprise (administrateur, consentement), partage facultatif et retirable, carte et statistiques de
// l'administration de la plateforme (nom, ville, pays, position arrondie, jamais de donnée métier), cloisonnement.
// Lancez-le avec : node scripts/test-org-geo.js
const { run, client } = require('./lib/wave1');

run('Position des entreprises : saisie, consentement, carte de l\'administration', async ({ check, owner, mgr, mem, other, org, org2, ws, O, base }) => {
  let r;
  const G = `${O}/geo`;
  r = await mem('GET', G); check('lecture ouverte aux membres : aucune position au départ', r.status === 200 && r.json.geo.shared === false && r.json.notice.visibleTo === 'platform_admin', r.json);
  r = await mgr('PUT', G, { lat: 4.05, lng: 9.7, country: 'Cameroun', consent: true }); check('un responsable ne modifie pas la position', r.status === 403, r.status);
  r = await owner('PUT', G, { lat: 4.0511, lng: 9.7679, city: 'Douala', country: 'Cameroun' }); check('sans consentement : refusé', r.status === 400, r.json);
  r = await owner('PUT', G, { lat: 95, lng: 9.7, country: 'Cameroun', consent: true }); check('latitude invalide refusée', r.status === 400, r.json);
  r = await owner('PUT', G, { lat: 4.05, lng: 9.7, country: '', consent: true }); check('pays obligatoire', r.status === 400, r.json);
  r = await owner('PUT', G, { lat: 4.05119, lng: 9.76789, city: 'Douala', country: 'Cameroun', consent: true });
  check('position partagée, arrondie à 3 décimales (≈ 100 m)', r.status === 200 && r.json.geo.shared === true && r.json.geo.lat === 4.051 && r.json.geo.lng === 9.768 && r.json.geo.city === 'Douala', r.json);
  r = await other('GET', `${ws(org2)}/geo`); check('l\'autre entreprise ne voit pas notre position', r.status === 200 && r.json.geo.shared === false, r.json);
  r = await other('GET', G); check('aucun accès à la position d\'une autre entreprise (404)', r.status === 404, r.status);
  r = await other('PUT', G, { lat: 1, lng: 1, country: 'X', consent: true }); check('modification inter-entreprises impossible', r.status === 404, r.status);

  // Administration de la plateforme
  const anon = client(base);
  r = await anon('GET', '/api/admin/geo/orgs'); check('carte de l\'administration : refusée sans connexion administrateur', r.status === 401, r.status);
  r = await owner('GET', '/api/admin/geo/orgs'); check('… et refusée à un propriétaire d\'entreprise', [401, 403].includes(r.status), r.status);
  const adm = client(base);
  r = await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' }); check('connexion administrateur', r.status === 200, r.status);
  r = await adm('GET', '/api/admin/geo/orgs');
  const j = r.json;
  check('carte : une entreprise localisée sur deux, taux 50 %', r.status === 200 && j.total === 2 && j.located === 1 && j.notLocated === 1 && j.rate === 0.5, j);
  const o = j.orgs[0];
  check('carte : nom, ville, pays, position, offre, membres — et rien d\'autre', o.name === 'Boutique Awa' && o.city === 'Douala' && o.country === 'Cameroun' && o.lat === 4.051 && o.lng === 9.768 && o.members === 3 && Object.keys(o).sort().join() === 'city,country,createdAt,id,lat,lng,members,name,plan,sharedAt', Object.keys(o));
  check('statistiques par pays et par ville', j.byCountry[0].name === 'Cameroun' && j.byCountry[0].n === 1 && j.byCity[0].name === 'Douala', [j.byCountry, j.byCity]);
  await other('PUT', `${ws(org2)}/geo`, { lat: 3.848, lng: 11.502, city: 'Yaoundé', country: 'Cameroun', consent: true });
  r = await adm('GET', '/api/admin/geo/orgs');
  check('deux entreprises au Cameroun : 2 pour le pays, 1 par ville', r.json.located === 2 && r.json.byCountry[0].n === 2 && r.json.byCity.length === 2, r.json);

  // Retrait
  r = await owner('DELETE', G); check('retrait de la position', r.status === 200, r.json);
  r = await adm('GET', '/api/admin/geo/orgs'); check('l\'entreprise disparaît de la carte', r.json.located === 1 && r.json.orgs.every((x) => x.id !== org), r.json);
  r = await mem('GET', G); check('lecture après retrait : plus de position', r.json.geo.shared === false && r.json.geo.lat === null, r.json);
}, {});
