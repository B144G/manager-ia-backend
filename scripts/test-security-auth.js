'use strict';
// Sécurité : mots de passe, verrouillage progressif, appareils inconnus, sessions, double authentification exigée, en-têtes, cookies, CORS.
// Lancez-le avec : node scripts/test-security-auth.js
process.env.DATABASE_URL = 'pglite://memory'; process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'x'.repeat(40);
const { run, client } = require('./lib/wave2');
const sec = require('../src/services/security');
const totp = require('../src/security/totp');

run('Sécurité : comptes, sessions, double authentification, en-têtes', async ({ check, owner, mgr, mem, other, org, org2, O, base, dbx }) => {
  // 1) Politique de mots de passe
  const base1 = (p, ...x) => sec.passwordProblemWith(false, p, ...x);
  const strict = (p, ...x) => sec.passwordProblemWith(true, p, ...x);
  check('mdp : 7 caractères refusés', Boolean(base1('abc1234')));
  check('mdp : « password123 » refusé', Boolean(base1('password123')));
  check('mdp : contenant le nom refusé', Boolean(base1('Awa-Mballa-2024', 'Awa Mballa')) === false && Boolean(base1('mballa-secret-9', 'mballa@x.com')));
  check('mdp strict : « Cameroun2024 » refusé (mot courant + chiffres)', Boolean(strict('Cameroun2024')));
  check('mdp strict : « Qwerty!Zz9x » refusé (suite de clavier)', Boolean(strict('Qwerty!Zz9x')));
  check('mdp strict : 9 caractères refusés', Boolean(strict('Abc-123-x')));
  check('mdp strict : « Cacao-Mangue-42 » accepté', strict('Cacao-Mangue-42') === '');
  check('mdp strict : phrase longue en minuscules acceptée', strict('une phrase tres longue pour moi') === '');
  const r0 = await mem('POST', '/api/register', { name: 'Test Faible', contact: `faible${Date.now()}@exemple.com`, pass: 'password123' });
  check('inscription avec « password123 » : 400', r0.status === 400, r0.status);

  // 2) Verrouillage progressif : 15 min, puis 30 min à la récidive
  const stamp = Date.now(); const contact = `verrou${stamp}@exemple.com`;
  const victim = client(base);
  await victim('POST', '/api/register', { name: 'Victime Verrou', contact, pass: 'Cacao-Mangue-42' });
  const attacker = client(base);
  const lockMin = async () => { const r = await dbx.prepare('SELECT locked_until, lock_level FROM login_fails WHERE k = ?').get(`u:${contact}`); return r && r.locked_until ? { min: Math.round((Date.parse(r.locked_until) - Date.now()) / 60000), level: Number(r.lock_level) } : null; };
  for (let i = 0; i < 8; i++) await attacker('POST', '/api/login', { contact, pass: 'faux' + i });
  const l1 = await lockMin();
  check('verrouillage : 1re fois ≈ 15 min', l1 && l1.min >= 13 && l1.min <= 16 && l1.level === 1, l1);
  const blocked = await attacker('POST', '/api/login', { contact, pass: 'Cacao-Mangue-42' });
  check('verrouillage : même le bon mot de passe est refusé (429)', blocked.status === 429, blocked.status);
  await dbx.prepare("UPDATE login_fails SET locked_until = ? WHERE k = ?").run(new Date(Date.now() - 1000).toISOString(), `u:${contact}`);
  for (let i = 0; i < 8; i++) await attacker('POST', '/api/login', { contact, pass: 'faux' + i });
  const l2 = await lockMin();
  check('verrouillage : récidive ≈ 30 min (progressif)', l2 && l2.min >= 28 && l2.min <= 31 && l2.level === 2, l2);
  await dbx.prepare('DELETE FROM login_fails WHERE k = ?').run(`u:${contact}`);
  await dbx.prepare('DELETE FROM rate_hits').run(); // remet à zéro la limite de débit par adresse (20 connexions / 15 min) : elle est testée ailleurs

  // 3) Pas d'énumération de comptes
  const unknown = await attacker('POST', '/api/login', { contact: `inconnu${stamp}@exemple.com`, pass: 'nimportequoi1' });
  const wrong = await attacker('POST', '/api/login', { contact, pass: 'mauvais-mdp-1' });
  check('connexion : compte inconnu et mauvais mot de passe → même réponse', unknown.status === 401 && wrong.status === 401 && unknown.json.error === wrong.json.error, [unknown.json, wrong.json]);
  const f1 = await attacker('POST', '/api/password/forgot', { contact });
  const f2 = await attacker('POST', '/api/password/forgot', { contact: `inconnu${stamp}@exemple.com` });
  check('mot de passe oublié : même réponse que le compte existe ou non', f1.status === 200 && f2.status === 200 && f1.text === f2.text);
  const badReset = await attacker('POST', '/api/password/reset', { token: 'a'.repeat(64), pass: 'Cacao-Mangue-43' });
  check('réinitialisation : jeton inconnu refusé', badReset.status === 400, badReset.status);

  // 4) Cookies et en-têtes
  const raw = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' }, body: JSON.stringify({ contact, pass: 'Cacao-Mangue-42' }) });
  const sc = raw.headers.getSetCookie().find((c) => c.startsWith('mia_token='));
  check('cookie de session : HttpOnly + SameSite + Path=/', sc && /HttpOnly/i.test(sc) && /SameSite=(Lax|Strict)/i.test(sc) && /Path=\//.test(sc), sc && sc.replace(/mia_token=[^;]+/, 'mia_token=…'));
  const h = (await fetch(base + '/api/health')).headers;
  check('en-têtes : nosniff, no-store, HSTS, Referrer-Policy, Permissions-Policy, X-Request-Id',
    h.get('x-content-type-options') === 'nosniff' && /no-store/.test(h.get('cache-control') || '') && /max-age=\d+/.test(h.get('strict-transport-security') || '') && h.get('referrer-policy') === 'no-referrer' && /camera=\(self\).*payment=\(\)/.test(h.get('permissions-policy') || '') && Boolean(h.get('x-request-id')),
    Object.fromEntries(['x-content-type-options', 'cache-control', 'strict-transport-security', 'referrer-policy', 'permissions-policy'].map((k) => [k, h.get(k)])));
  check("en-têtes : l'API porte une politique de contenu restrictive et ne se laisse pas encadrer", /default-src 'none'/.test(h.get('content-security-policy') || '') && /frame-ancestors 'none'/.test(h.get('content-security-policy') || ''), h.get('content-security-policy'));
  check('en-têtes : X-Powered-By absent', !h.get('x-powered-by'));
  const cors = await fetch(base + '/api/me', { headers: { origin: 'https://site-pirate.example' } });
  check("CORS : un site étranger ne reçoit aucun Access-Control-Allow-Origin", !cors.headers.get('access-control-allow-origin'));
  const csrf = await fetch(base + '/api/logout', { method: 'POST', headers: { origin: 'https://site-pirate.example', 'content-type': 'application/json' }, body: '{}' });
  check('CSRF : requête POST venant d\'un autre site refusée (403)', csrf.status === 403, csrf.status);
  const proto = await fetch(base + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"admin":1}},"name":"Proto Test","contact":"proto' + stamp + '@exemple.com","pass":"Cacao-Mangue-42"}' });
  const afterProto = await fetch(base + '/api/admin/summary');
  check('pollution de prototype : inscription sans erreur serveur, administration toujours fermée', proto.status < 500 && afterProto.status === 401, [proto.status, afterProto.status]);

  // Gros corps : jamais analysés avant la connexion (un anonyme ne fait pas lire 9 Mo de JSON)
  const big = await fetch(base + `/api/ws/orgs/${org}/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"' + 'a'.repeat(3 * 1024 * 1024) });
  check('gros corps : un anonyme reçoit 401 (corps jamais analysé), pas une erreur de lecture', big.status === 401, big.status);

  // 5) Appareil inconnu : alerte + journal
  const dev = await dbx.prepare("SELECT COUNT(*) c FROM audit_trail WHERE action = 'login.new_device'").get();
  const nt = await dbx.prepare("SELECT COUNT(*) c FROM user_notices WHERE kind = 'connexion_inhabituelle'").get();
  check('appareil inconnu : ligne au journal d\'audit et message dans l\'application', Number(dev.c) >= 1 && Number(nt.c) >= 1, [dev.c, nt.c]);

  // 6) Sessions : liste, fermeture des autres appareils
  const second = client(base);
  await second('POST', '/api/login', { contact, pass: 'Cacao-Mangue-42' });
  let ov = await second('GET', '/api/security/overview');
  check('sessions : liste des appareils connectés (au moins 2 avec la session courante marquée)', ov.status === 200 && ov.json.sessions.length >= 2 && ov.json.sessions.filter((s) => s.current).length === 1, ov.json && ov.json.sessions && ov.json.sessions.length);
  const closed = await second('POST', '/api/security/sessions/revoke-others', {});
  check('sessions : fermer les autres appareils', closed.status === 200 && closed.json.closed >= 1, closed.json);
  const stale = await victim('GET', '/api/me');
  check('sessions : un appareil fermé perd l\'accès aussitôt (401)', stale.status === 401, stale.status);
  const still = await second('GET', '/api/me');
  check('sessions : l\'appareil courant reste connecté', still.status === 200, still.status);

  // 7) Double authentification : proposée aux propriétaires/administrateurs, exigeable par l'organisation
  ov = await owner('GET', '/api/security/overview');
  check('2FA : recommandée au propriétaire d\'une organisation', ov.json.twofa.recommended === true && ov.json.twofa.enabled === false, ov.json.twofa);
  ov = await mem('GET', '/api/security/overview');
  check('2FA : pas de recommandation insistante pour un simple membre', ov.json.twofa.recommended === false, ov.json.twofa);
  let r = await owner('PUT', `/api/privacy/orgs/${org}/require-2fa`, { enabled: true });
  check('2FA exigée : refusée tant que le propriétaire ne l\'a pas lui-même', r.status === 400, r.status);
  const setup = await owner('POST', '/api/security/2fa/setup', { password: 'secret123' });
  const en = await owner('POST', '/api/security/2fa/enable', { code: totp.codeAt(setup.json.secret, totp.stepNow()) });
  check('2FA : activation avec un code valide et 10 codes de secours', en.status === 200 && en.json.recoveryCodes.length === 10, en.status);
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND user_id = (SELECT id FROM users WHERE contact LIKE 'marc%' ORDER BY id DESC LIMIT 1)").run(org);
  r = await mgr('GET', O);
  check('2FA non exigée : l\'administrateur accède à l\'organisation', r.status === 200, r.status);
  r = await owner('PUT', `/api/privacy/orgs/${org}/require-2fa`, { enabled: true });
  check('2FA exigée : le propriétaire (qui l\'a) peut l\'imposer', r.status === 200 && r.json.require2fa === true, r.json);
  r = await mgr('GET', O);
  check('2FA exigée : l\'administrateur sans 2FA est bloqué avec un code explicite (403)', r.status === 403 && r.json.code === 'twofa_required', r.json);
  r = await mem('GET', O);
  check('2FA exigée : un simple membre n\'est pas concerné', r.status === 200, r.status);
  r = await mgr('GET', '/api/security/overview');
  check('2FA exigée : l\'administrateur peut quand même aller activer sa 2FA', r.status === 200, r.status);
  const wrongCode = await owner('POST', '/api/security/2fa/disable', { password: 'secret123', code: '000000' });
  check('2FA : désactivation refusée avec un mauvais code', wrongCode.status === 403, wrongCode.status);
});
