'use strict';
// Compte d'entreprise, étapes 2 à 6 · démonstration (après entreprise-seed.js) : livreur avec profil mobile, secret employé, appareil de confiance, lien d'association, filiale liée,
// partenaire (invitation, confirmation), espace partagé avec un message.   Usage : node scripts/demo/entreprise-seed2.js [http://127.0.0.1:3410]
const BASE = (process.argv[2] || process.env.DEMO_API || 'http://127.0.0.1:3410').replace(/\/$/, '');
function client() {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* */ }
    return { status: res.status, json };
  };
}
const must = (r, w) => { if (r.status >= 400) throw new Error(`${w} : ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
(async () => {
  const owner = client();
  must(await owner('POST', '/api/login', { contact: 'demo@exemple.com', pass: 'secret123' }), 'connexion');
  const org = (await owner('GET', '/api/ws/orgs')).json.orgs[0].id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
  const chart = must(await owner('GET', `${E}/chart`), 'chart');
  const posts = [...chart.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...chart.departments.flatMap((x) => x.posts)];
  // Un livreur qui arrive avec le code d'entreprise (étape 2) : profil mobile (étape 3)
  if (!process.env.SKIP_PAUL) {
  const code = must(await owner('GET', E), 'aperçu').companyCode;
  const p = must(await owner('POST', `${E}/people`, { fullName: 'Paul Livreur', email: 'paul@exemple.com', postIds: [posts.find((x) => x.title === 'Livreur').id] }), 'personne');
  const paul = client();
  must(await paul('POST', '/api/entreprise-auth/activate', { companyCode: code, inviteCode: p.code, email: 'paul@exemple.com', method: 'pin', secret: '493817', trustDays: 30 }), 'activation');
  console.log('Code d\'entreprise :', code, '— Paul Livreur : PIN 493817');
  }
  // Étape 4 : lien d'association et filiale
  const lk = must(await owner('POST', `${E}/links`, { label: 'Filiale de Yaoundé' }), 'lien');
  const dir = client(); must(await dir('POST', '/api/register', { name: 'Directrice Yaoundé', contact: 'yaounde@exemple.com', pass: 'secret123' }), 'inscription');
  must(await dir('POST', '/api/ws/orgs', { name: 'Boutique Awa Yaoundé', associationCode: lk.code }), 'filiale');
  must(await owner('POST', `${E}/links`, { label: 'Site de Bafoussam' }), 'lien 2');
  // Étape 5 : partenaire
  const pa = client(); must(await pa('POST', '/api/register', { name: 'Directeur Fournisseur', contact: 'fournisseur@exemple.com', pass: 'secret123' }), 'inscription');
  const porg = must(await pa('POST', '/api/ws/orgs', { name: 'Textiles du Littoral SA' }), 'org partenaire').id;
  const inv = must(await owner('POST', `${O}/partners/invite`, { type: 'fournisseur', label: 'Textiles du Littoral', durationDays: 365, contact: { name: 'Awa Kamga', email: 'awa@exemple.com' } }), 'invitation');
  must(await pa('POST', `/api/ws/orgs/${porg}/partners/join`, { code: inv.code, type: 'client', contact: { name: 'Directeur Fournisseur' } }), 'join');
  must(await owner('POST', `${O}/partners/${inv.id}/confirm`), 'confirm');
  const sp = (await owner('GET', `${O}/shared/spaces`)).json.spaces[0];
  const meId = (await owner('GET', '/api/me')).json.user.id;
  const pid = (await pa('GET', '/api/me')).json.user.id;
  must(await owner('PUT', `${O}/shared/spaces/${sp.id}/members`, { members: [{ userId: meId, rights: 'validate' }] }), 'membres');
  must(await pa('PUT', `/api/ws/orgs/${porg}/shared/spaces/${sp.id}/members`, { members: [{ userId: pid, rights: 'write' }] }), 'membres partenaire');
  must(await pa('POST', `/api/ws/orgs/${porg}/shared/spaces/${sp.id}/messages`, { body: 'Bonjour ! Voici le catalogue des pagnes de la saison.' }), 'message');
  must(await owner('POST', `${O}/shared/spaces/${sp.id}/messages`, { body: 'Merci, nous le consultons cette semaine.' }), 'message');
  must(await owner('POST', `${O}/partners/invite`, { type: 'transporteur', label: 'Transports Express' }), 'invitation 2');
  console.log('Démonstration étapes 2 à 6 prête.');
})().catch((e) => { console.error(e.message); process.exit(1); });
