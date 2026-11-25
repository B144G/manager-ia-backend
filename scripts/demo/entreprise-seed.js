'use strict';
// Compte d'entreprise · démonstration : configure « Boutique Awa » (après scripts/demo/seed.js) comme le ferait l'assistant :
// informations, modèle « commerce », direction générale, directeurs, employés avec codes d'invitation personnels, deux personnes qui n'ont pas encore rejoint, des postes vacants.
//   Usage : node scripts/demo/entreprise-seed.js [http://127.0.0.1:3410]      (comptes des employés : <prénom>@exemple.com / secret123)
const BASE = (process.argv[2] || process.env.DEMO_API || 'http://127.0.0.1:3410').replace(/\/$/, '');
function client() {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* */ }
    return { status: res.status, json };
  };
}
const must = (r, what) => { if (r.status >= 400) throw new Error(`${what} : ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
// Employés de démonstration : prénom (compte), nom affiché, poste du modèle (clé de titre), rôle, arrive (se connecte) ou reste invité.
const PEOPLE = [
  { tag: 'aicha', name: 'Aïcha Mballa', post: 'Comptable', arrives: true },
  { tag: 'boris', name: 'Boris Ndzana', post: 'Responsable commercial', arrives: true },
  { tag: 'carine', name: 'Carine Essomba', post: 'Magasinier', arrives: true },
  { tag: 'david', name: 'David Tchoua', post: 'Responsable des ressources humaines', arrives: true },
  { tag: 'estelle', name: 'Estelle Fouda', post: 'Commercial / vendeur', arrives: true },
  { tag: 'felix', name: 'Félix Ayissi', post: 'Directeur administratif et financier (DAF)', arrives: true, role: 'manager' },
  { tag: 'hugo', name: 'Hugo Nouveau', post: null, arrives: true },
  { tag: 'ines', name: 'Inès Manga', post: 'Acheteur', arrives: false },
  { tag: 'jean', name: 'Jean-Paul Kamdem', post: 'Livreur', arrives: false },
];
(async () => {
  const owner = client();
  must(await owner('POST', '/api/login', { contact: 'demo@exemple.com', pass: 'secret123' }), 'connexion du dirigeant');
  const org = (await owner('GET', '/api/ws/orgs')).json.orgs[0].id; const O = `/api/ws/orgs/${org}/entreprise`;
  try {
    const url = require('fs').readFileSync((process.env.DEMO_DIR || '/private/tmp/claude-501/demo') + '/pgurl.txt', 'utf8').trim();
    const { Client } = require('pg'); const c = new Client({ connectionString: url }); await c.connect();
    await c.query("UPDATE users SET plan = 'Illimité', plan_expires = $1 WHERE contact = 'demo@exemple.com'", [new Date(Date.now() + 90 * 86400000).toISOString()]); await c.end();
  } catch (e) { console.log('(offre non modifiée : ' + e.message + ')'); }
  must(await owner('PUT', `${O}/info`, { name: 'Boutique Awa SARL', sector: 'commerce', country: 'Cameroun', currency: 'FCFA', city: 'Douala', address: 'Marché central, Akwa', size: '6-20', phone: '+237 6 00 00 00 00', email: 'contact@boutique-awa.example', website: 'boutique-awa.example', legalForm: 'SARL' }), 'informations');
  const tpl = must(await owner('POST', `${O}/template`, { sector: 'commerce' }), 'modèle');
  console.log('Modèle commerce appliqué :', JSON.stringify(tpl.added));
  for (const s of ['info', 'directions']) must(await owner('PUT', `${O}/setup`, { step: s, status: 'done' }), 'étape');
  const chart = must(await owner('GET', `${O}/chart`), 'organigramme');
  const posts = [...chart.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...chart.departments.flatMap((x) => x.posts)];
  const post = (title) => { const p = posts.find((x) => x.title === title && x.active); if (!p) throw new Error('poste introuvable : ' + title); return p.id; };
  const byUser = {};
  for (const p of PEOPLE) {
    const body = { fullName: p.name, email: `${p.tag}@exemple.com`, role: p.role || 'member', postIds: p.post ? [post(p.post)] : [] };
    const j = must(await owner('POST', `${O}/people`, body), 'personne ' + p.name);
    if (p.arrives) {
      const c = client();
      let r = await c('POST', '/api/register', { name: p.name, contact: `${p.tag}@exemple.com`, pass: 'secret123' });
      if (r.status >= 400) must(await c('POST', '/api/login', { contact: `${p.tag}@exemple.com`, pass: 'secret123' }), 'connexion ' + p.tag);
      must(await c('POST', '/api/ws/orgs/join', { code: j.code }), 'adhésion ' + p.name);
    }
    byUser[p.tag] = j;
    console.log(p.name.padEnd(22), (p.post || '(aucun poste)').padEnd(46), p.arrives ? 'arrivé(e)' : 'invitation en attente · code ' + j.code);
  }
  const after = must(await owner('GET', `${O}/chart`), 'organigramme');
  const felix = after.people.find((x) => x.name === 'Félix Ayissi'); const owner0 = after.dg[0];
  must(await owner('PUT', `${O}/dg`, { personIds: [owner0.id, felix.id] }), 'direction générale');
  for (const s of ['dg', 'departments']) must(await owner('PUT', `${O}/setup`, { step: s, status: 'done' }), 'étape');
  console.log('Direction générale :', [owner0.name, felix.name].join(' et '), '— configuration : étape « employés » laissée à faire (reprise possible)');
})().catch((e) => { console.error(e.message); process.exit(1); });
