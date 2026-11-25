'use strict';
// Compte d'entreprise, étape 6 : limites de l'abonnement appliquées partout (structure, personnes, profils, partenaires, espaces, fichiers, organisations, IA partagée
// entre organisations liées) et écran d'usage. Lancez-le avec : npm run test:entreprise-limites
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
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ENTREPRISE_WRITE_RATE: '2000' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const Lim = require('../src/workspace/ent-limits');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now(); const now = new Date().toISOString();
  try {
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'Secret-Pass-123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const plan = (id, p) => db.prepare('UPDATE users SET plan = ?, plan_expires = ? WHERE id = ?').run(p, p === 'Gratuit' ? null : new Date(Date.now() + 86400000 * 30).toISOString(), id);
    const owner = client(base); const mem = client(base); const oB = client(base);
    const ownerId = await reg(owner, 'Dirigeant Gratuit', 'g1'); await reg(mem, 'Membre', 'g2'); const bId = await reg(oB, 'Filiale', 'g3');
    const org = (await owner('POST', '/api/ws/orgs', { name: 'Petite Entreprise', currency: 'FCFA' })).json.id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
    const r0 = await owner('POST', `${O}/invites`, { role: 'member' }); await mem('POST', '/api/ws/orgs/join', { code: r0.json.code });

    console.log('Paliers de l\'abonnement');
    check('trois paliers déduits des limites d\'organisations existantes (jamais plus bas que l\'existant)', Lim.tierOf('Gratuit') === 'free' && Lim.tierOf('Pro') === 'pro' && Lim.tierOf('Illimité') === 'unlimited');
    check('les paliers sont croissants pour chaque limite', ['partners', 'sharedSpaces', 'departments', 'posts', 'people', 'directions', 'profiles', 'fileMb'].every((k) => Lim.TIERS.free[k] <= Lim.TIERS.pro[k] && Lim.TIERS.pro[k] <= Lim.TIERS.unlimited[k]));
    let r = await mem('GET', `${E}/usage`);
    check('l\'écran d\'usage est réservé aux administrateurs (403)', r.status === 403);
    r = await owner('GET', `${E}/usage`);
    const get = (k) => r.json.items.find((x) => x.key === k);
    check('usage de l\'offre Gratuite : organisations, personnes, antennes, IA, structure, partenaires, espaces', r.status === 200 && r.json.tier === 'free' && ['orgs', 'members', 'branches', 'ai', 'directions', 'departments', 'posts', 'people', 'partners', 'sharedSpaces'].every((k) => get(k)) && get('orgs').max === 1 && get('orgs').used === 1 && get('members').used === 2, r.json.items);

    console.log('Structure : limites par abonnement');
    r = await owner('POST', `${E}/template`, { sector: 'btp' });
    check('le modèle BTP tient dans l\'offre Gratuite', r.status === 200, r.json);
    r = await owner('GET', `${E}/usage`);
    const nd = get('directions').used; const np = get('posts').used;
    check('l\'usage reflète la structure créée', nd >= 8 && np >= 30 && get('departments').max === 12, r.json.items);
    let last; for (let i = 0; i < 12 && !last; i++) { const x = await owner('POST', `${E}/directions`, { name: 'Direction ' + i }); if (x.status === 403) last = x; }
    check('au-delà de la limite de directions : refus clair avec invitation à changer d\'offre', last && /abonnement permet 12 directions/.test(last.json.error), last && last.json);
    last = null; for (let i = 0; i < 20 && !last; i++) { const x = await owner('POST', `${E}/departments`, { name: 'Dép ' + i }); if (x.status === 403) last = x; }
    check('limite de départements : refus clair', last && /départements/.test(last.json.error), last && last.json);
    last = null; for (let i = 0; i < 80 && !last; i++) { const x = await owner('POST', `${E}/posts`, { title: 'Poste ' + i }); if (x.status === 403) last = x; }
    check('limite de postes : refus clair', last && /postes/.test(last.json.error), last && last.json);
    r = await owner('POST', `${E}/template`, { sector: 'commerce' });
    check('un modèle qui ajouterait plus que la limite est refusé en entier (rien d\'ajouté à moitié)', r.status === 403 && /dépasse les limites/.test(r.json.error), r.json);
    const cntAfter = Number((await db.prepare('SELECT COUNT(*) c FROM ent_posts WHERE org_id = ?').get(org)).c);
    check('… et la structure n\'a pas bougé', cntAfter === (await owner('GET', `${E}/usage`)).json.items.find((x) => x.key === 'posts').used);
    // profils personnalisés
    const cfg = (await owner('GET', `${E}/profiles`)).json.profiles[0].config;
    const keys = (await owner('GET', `${E}/profiles`)).json.profiles.map((p) => p.key);
    let refused = null; for (let i = 0; i < 7 && !refused; i++) { const x = await owner('PUT', `${E}/profiles/${keys[i]}`, { config: cfg }); if (x.status === 403) refused = x; }
    check('limite de profils personnalisés (Gratuit : 5)', refused && /profils personnalisés/.test(refused.json.error), refused && refused.json);
    check('… modifier un profil déjà personnalisé reste possible', (await owner('PUT', `${E}/profiles/${keys[0]}`, { config: cfg })).status === 200);
    // personnes
    r = await owner('GET', `${E}/usage`);
    // Passage à l'offre Pro : les limites montent immédiatement
    await plan(ownerId, 'Pro');
    r = await owner('GET', `${E}/usage`);
    check('l\'offre Pro relève les limites tout de suite', r.json.tier === 'pro' && get('departments').max === 40 && get('posts').max === 200 && get('orgs').max === 3, r.json.items);
    r = await owner('POST', `${E}/template`, { sector: 'commerce' });
    check('le modèle commerce tient alors dans l\'offre Pro', r.status === 200, r.json);
    r = await owner('POST', `${E}/posts`, { title: 'Poste Pro' });
    check('création de poste de nouveau possible', r.status === 201);

    console.log('Organisations liées : abonnement et quota IA de l\'entreprise principale');
    const lk = (await owner('POST', `${E}/links`, { label: 'Filiale' })).json;
    const orgB = (await oB('POST', '/api/ws/orgs', { name: 'Filiale', associationCode: lk.code })).json.id; const OB = `/api/ws/orgs/${orgB}`;
    await plan(bId, 'Gratuit');
    r = await oB('GET', `${OB}/entreprise/usage`);
    check('la filiale voit l\'abonnement de l\'entreprise principale (Pro) et l\'indique', r.status === 200 && r.json.tier === 'pro' && r.json.linked === true, r.json.tier);
    const a1 = (await owner('GET', O)).json.limits;
    for (let i = 0; i < 3; i++) await db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, ?, ?)').run(org, ownerId, new Date().toISOString());
    for (let i = 0; i < 4; i++) await db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, ?, ?)').run(orgB, bId, new Date().toISOString());
    const la = (await owner('GET', O)).json.limits; const lb = (await oB('GET', OB)).json.limits;
    check('le quota IA est PARTAGÉ entre les organisations liées (3 + 4 messages = 7 vus des deux côtés)', la.aiUsed === a1.aiUsed + 7 && lb.aiUsed === la.aiUsed && lb.aiMonth === 1000, [la, lb]);
    check('… la filiale a les limites de personnes de l\'offre Pro', lb.members === 15);
    // une entreprise sans organisation liée garde son quota propre
    const solo = client(base); const sid = await reg(solo, 'Solo', 'g4'); const orgS = (await solo('POST', '/api/ws/orgs', { name: 'Solo' })).json.id;
    await db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, ?, ?)').run(orgS, sid, now);
    check('une organisation seule garde son quota propre (inchangé)', (await solo('GET', `/api/ws/orgs/${orgS}`)).json.limits.aiUsed === 1);

    console.log('Partenaires, espaces, fichiers');
    const solo2 = client(base); await reg(solo2, 'Partenaire', 'g5'); const orgP = (await solo2('POST', '/api/ws/orgs', { name: 'Partenaire SA' })).json.id; const OP = `/api/ws/orgs/${orgP}`;
    r = await owner('GET', `${E}/usage`);
    check('l\'usage compte les partenaires et espaces', get('partners').max === 10 && get('sharedSpaces').max === 30 && r.json.extra.fileMb === 10, r.json.extra);
    const i1 = (await solo('POST', `/api/ws/orgs/${orgS}/partners/invite`, { type: 'client' })).json;
    r = await solo('POST', `/api/ws/orgs/${orgS}/partners/invite`, { type: 'client' });
    check('offre Gratuite : un partenaire par type, message clair', r.status === 403 && /ce type/.test(r.json.error), r.json);
    r = await solo('POST', `/api/ws/orgs/${orgS}/partners/invite`, { type: 'fournisseur' });
    r = await solo('POST', `/api/ws/orgs/${orgS}/partners/invite`, { type: 'transporteur' });
    check('… et 2 partenaires au total', r.status === 403 && /permet 2 partenaire/.test(r.json.error), r.json);
    check('l\'écran d\'usage de l\'offre Gratuite montre 2 partenaires sur 2', (await solo('GET', `/api/ws/orgs/${orgS}/entreprise/usage`)).json.items.find((x) => x.key === 'partners').used === 2);
    void i1; void OP;

    console.log('Rien ne change sans abonnement particulier');
    r = await owner('GET', O);
    check('l\'ouverture d\'une organisation répond toujours avec ses limites habituelles', r.status === 200 && r.json.limits.members === 15 && r.json.limits.branches === 5);
    check('sans connexion : 401', (await client(base)('GET', `${E}/usage`)).status === 401);
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
