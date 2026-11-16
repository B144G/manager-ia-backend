'use strict';
// Sécurité : énumère TOUTES les routes de l'application et vérifie (1) qu'aucune n'est accessible sans connexion en dehors d'une liste blanche
// explicite, (2) que l'isolation entre organisations tient (une autre organisation = 404 sur chaque route /api/ws/orgs/:orgId/...).
// Lancez-le avec : node scripts/test-security-routes.js
const path = require('path');
const { run, client } = require('./lib/wave2');
process.env.DATABASE_URL = 'pglite://memory'; process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'x'.repeat(40);
const { listRoutes } = require('./lib/routes');
const { app } = require(path.join(__dirname, '..', 'src', 'server.js'));

// Routes volontairement publiques : chacune est protégée autrement (jeton secret dans l'adresse, signature, code, limite de débit).
const PUBLIC = new Set([
  'GET /api/health',
  'GET /webhooks/whatsapp', 'POST /webhooks/whatsapp', 'GET /webhooks/meta', 'POST /webhooks/meta', // signature Meta (HMAC) + jeton de vérification
  'GET /api/webhooks/whatsapp', 'POST /api/webhooks/whatsapp',
  'GET /api/register/info', 'POST /api/register', 'POST /api/register/resend', 'POST /api/register/verify',
  'POST /api/login', 'POST /api/login/2fa', 'POST /api/password/forgot', 'POST /api/password/reset', 'POST /api/logout',
  'POST /api/contact', 'POST /api/visit', 'GET /api/unsubscribe', 'POST /api/assistant', 'GET /api/plans', 'GET /api/plans/custom/quote',
  'POST /api/payments/webhook/campay', 'GET /api/payments/webhook/campay', // le contenu n'est jamais cru : l'état est relu chez Campay
  'POST /api/admin/login', 'POST /api/admin/logout',
  'POST /api/ws/public/intake/:token', 'GET /api/ws/public/chat/:token/info', 'POST /api/ws/public/chat/:token/message', 'POST /api/ws/public/chat/:token/voice',
  'GET /api/ws/public/file/:token', 'GET /api/ws/public/calendar/:token.ics', 'GET /api/ws/public/csat/:token', 'POST /api/ws/public/csat/:token',
  'GET /api/ws/public/intake/:token/info', 'GET /api/ws/public/unsubscribe/:token', 'GET /api/ws/public/digest-unsub/:token', 'GET /api/ws/public/followup-stop/:token',
  'GET /api/ws/public/whatsapp/:token', 'POST /api/ws/public/whatsapp/:token', 'GET /api/ws/public/meta/:token', 'POST /api/ws/public/meta/:token',
]);
// Routes protégées par une clé d'API (en-tête), pas par un cookie : sans clé, 401 aussi.
const fill = (p, orgId) => p.replace(/:orgId/g, String(orgId)).replace(/:action\([^)]*\)/g, 'confirm').replace(/:token\.ics/, 'abc.ics').replace(/:[A-Za-z]+/g, '1');

run('Sécurité : routes publiques (liste blanche) et isolation entre organisations', async ({ check, owner, other, org, org2, base }) => {
  const routes = listRoutes(app).filter((r) => r.path.startsWith('/api') || r.path.startsWith('/webhooks'));
  const key = (r) => `${r.method} ${r.path}`;
  check(`énumération : ${routes.length} routes trouvées (plus de 500 attendues)`, routes.length > 500, routes.length);

  const unknownPublic = [...PUBLIC].filter((k) => !routes.some((r) => key(r) === k));
  check('liste blanche : aucune entrée périmée (chaque route publique existe encore)', unknownPublic.length === 0, unknownPublic);

  // 1) Sans connexion : 401 partout sauf liste blanche
  const anon = client(base);
  const open = [];
  for (const r of routes) {
    if (PUBLIC.has(key(r))) continue;
    const res = await anon(r.method, fill(r.path, org), r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    if (res.status !== 401) open.push(`${key(r)} -> ${res.status}`);
  }
  check('sans connexion : toute route non publique répond 401', open.length === 0, open.slice(0, 15));

  // 2) Une autre organisation (membre de org2 seulement) : 404 sur chaque route de l'organisation org
  const wsRoutes = routes.filter((r) => r.path.includes('/orgs/:orgId') && !r.path.startsWith('/api/admin'));
  const leaks = [];
  for (const r of wsRoutes) {
    const res = await other(r.method, fill(r.path, org), r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    if (res.status !== 404) leaks.push(`${key(r)} -> ${res.status}`);
  }
  check(`isolation : ${wsRoutes.length} routes d'organisation (espace de travail et confidentialité) répondent 404 à un étranger`, leaks.length === 0, leaks.slice(0, 15));

  // 3) Le propriétaire, lui, atteint bien son organisation (le test ne se contente pas de tout refuser)
  const mine = await owner('GET', `/api/ws/orgs/${org}`);
  check('le propriétaire accède à son organisation', mine.status === 200, mine.status);
  const foreign = await owner('GET', `/api/ws/orgs/${org2}`);
  check('le propriétaire de A ne voit pas l\'organisation B', foreign.status === 404, foreign.status);
});
