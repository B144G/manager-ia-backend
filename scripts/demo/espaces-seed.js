'use strict';
// Espaces par rôle · démonstration : crée un membre par type de rôle dans « Boutique Awa » (après scripts/demo/seed.js), affecte les espaces et active le réglage.
//   Usage : node scripts/demo/espaces-seed.js [http://127.0.0.1:3300]       (comptes : <nom>@exemple.com / secret123)
const BASE = (process.argv[2] || process.env.DEMO_API || 'http://127.0.0.1:3300').replace(/\/$/, '');
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
const PEOPLE = [
  { tag: 'aicha', name: 'Aïcha Comptable', role: 'member', title: 'Comptable', funcs: ['comptable'] },
  { tag: 'boris', name: 'Boris Commercial', role: 'member', title: 'Responsable commercial', funcs: ['resp_commercial'] },
  { tag: 'carine', name: 'Carine Stock', role: 'member', title: 'Responsable stock', funcs: ['resp_stock'] },
  { tag: 'david', name: 'David RH', role: 'member', title: 'Responsable RH', funcs: ['rh'] },
  { tag: 'estelle', name: 'Estelle Production', role: 'member', title: 'Responsable production', funcs: ['resp_operations'] },
  { tag: 'felix', name: 'Félix Directeur', role: 'manager', title: 'Directeur', funcs: ['dirigeant'] },
  { tag: 'gisele', name: 'Gisèle Polyvalente', role: 'member', title: 'Vendeuse et magasinière', funcs: ['commercial', 'acheteur'] },
  { tag: 'hugo', name: 'Hugo Nouveau', role: 'member', title: 'Nouvel employé', funcs: [] },
];
/** Offre « Illimité » pour la démonstration (nombre de personnes), directement dans la base jetable. */
async function upgradePlan() {
  try {
    const url = require('fs').readFileSync((process.env.DEMO_DIR || '/private/tmp/claude-501/demo') + '/pgurl.txt', 'utf8').trim();
    const { Client } = require('pg'); const c = new Client({ connectionString: url }); await c.connect();
    await c.query("UPDATE users SET plan = 'Illimité', plan_expires = $1 WHERE contact = 'demo@exemple.com'", [new Date(Date.now() + 90 * 86400000).toISOString()]); await c.end();
  } catch (e) { console.log('(offre non modifiée : ' + e.message + ')'); }
}
(async () => {
  await upgradePlan();
  const owner = client();
  let r = await owner('POST', '/api/login', { contact: 'demo@exemple.com', pass: 'secret123' });
  if (r.status !== 200) throw new Error('connexion du dirigeant : ' + r.status);
  const org = (await owner('GET', '/api/ws/orgs')).json.orgs[0].id; const O = `/api/ws/orgs/${org}`;
  const members = (await owner('GET', `${O}/members`)).json.members;
  for (const p of PEOPLE) {
    const c = client();
    const contact = `${p.tag}@exemple.com`;
    r = await c('POST', '/api/register', { name: p.name, contact, pass: 'secret123' });
    if (r.status >= 400) await c('POST', '/api/login', { contact, pass: 'secret123' });
    const inv = (await owner('POST', `${O}/invites`, { role: p.role, title: p.title })).json;
    const jr = await c('POST', '/api/ws/orgs/join', { code: inv.code }); if (jr.status >= 400) throw new Error('adhésion de ' + p.name + ' : ' + JSON.stringify(jr.json));
    const list = (await owner('GET', `${O}/members`)).json.members;
    const m = list.find((x) => x.name === p.name);
    if (m && p.funcs.length) r = await owner('PUT', `${O}/spaces/assignments/${m.userId}`, { funcRoles: p.funcs, applyPreset: true });
    console.log(p.name.padEnd(22), contact.padEnd(22), p.funcs.join('+') || '(aucune affectation)');
  }
  r = await owner('PUT', `${O}/spaces/settings`, { enabled: true });
  console.log('Espaces par rôle activés :', r.json, '— membres au départ :', members.length);
})().catch((e) => { console.error(e.message); process.exit(1); });
