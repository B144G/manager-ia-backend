'use strict';
// Sécurité : énumère TOUTES les routes de l'application et vérifie (1) qu'aucune n'est accessible sans connexion en dehors d'une liste blanche
// explicite, (2) que l'isolation entre organisations tient (une autre organisation = 404 sur chaque route /api/ws/orgs/:orgId/...).
// Lancez-le avec : node scripts/test-security-routes.js
const path = require('path');
const { run, client } = require('./lib/wave2');
process.env.DATABASE_URL = 'pglite://memory'; process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'x'.repeat(40);
process.env.RATE_LIMIT_GLOBAL = process.env.RATE_LIMIT_GLOBAL || '20000'; // le balayage de ~1 900 routes dépasse la limite globale de production (3 000 requêtes / 15 min / adresse)
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
  'GET /api/ws/public/quote/:token', 'POST /api/ws/public/quote/:token/accept', 'POST /api/ws/public/quote/:token/refuse', // COMMERCIAL : devis consulté / accepté / refusé par le client final via un jeton secret non devinable dans l'adresse
  'GET /api/ws/public/track/:token', // FUSION (ligne A) : suivi de livraison pour le client final, protégé par un jeton secret non devinable dans l'adresse
  'GET /api/ws/public/brand/:token/manifest.webmanifest', 'GET /api/ws/public/brand-of/:kind/:token', // MARQUE : manifeste de l'application d'une entreprise et marque de ses pages publiques, par jeton secret (aucune donnée interne ; voir docs/marque-entreprise.md)
  'POST /api/entreprise-auth/login', 'POST /api/entreprise-auth/login/2fa', 'POST /api/entreprise-auth/activate', 'POST /api/entreprise-auth/resume', // COMPTE D'ENTREPRISE (étape 2) : connexion employé (code d'entreprise + e-mail + secret), première connexion par invitation, retour par appareil de confiance : publics par nature, messages génériques, verrouillage, débit limité (voir docs/compte-entreprise.md)
  'GET /api/ws/public/testimonials', // AVIS : témoignages approuvés par l'administrateur ET consentis par leur auteur (aucune donnée privée ; voir docs/avis.md)
  'GET /api/ws/public/geo/:token', 'POST /api/ws/public/geo/:token', // TRANSPORT GÉO : le client indique sa position (adresse, point, GPS avec consentement) via un jeton secret de 48 caractères, valable 48 h, débit limité
]);
// Routes protégées par une clé d'API (en-tête), pas par un cookie : sans clé, 401 aussi.
const fill = (p, orgId) => p.replace(/:orgId/g, String(orgId)).replace(/:action\([^)]*\)/g, 'confirm').replace(/:token\.ics/, 'abc.ics').replace(/:[A-Za-z]+/g, '1');

run('Sécurité : routes publiques (liste blanche) et isolation entre organisations', async ({ check, owner, other, org, org2, base }) => {
  const routes = listRoutes(app).filter((r) => r.path.startsWith('/api') || r.path.startsWith('/webhooks'));
  const key = (r) => `${r.method} ${r.path}`;
  check(`énumération : ${routes.length} routes trouvées (plus de 500 attendues)`, routes.length > 500, routes.length);

  // FUSION : l'énumération couvre aussi tout ce que la ligne A a ajouté (Transport, Budget et Projets pro, entrepôt, achats, bibliothèque, comptabilité…).
  for (const [label, re] of [['Transport (TMS et flotte)', /\/orgs\/:orgId\/(logistics|tms)\//], ['Budget pro', /\/orgs\/:orgId\/budget\/(pro|annual)|\/orgs\/:orgId\/budget-pro/], ['Projets pro', /\/orgs\/:orgId\/projects\//],
    ['Entrepôt (WMS)', /\/orgs\/:orgId\/stock\/wms\//], ['Achats', /\/orgs\/:orgId\/purchasing\//], ['Bibliothèque', /\/orgs\/:orgId\/library\//], ['Comptabilité (stock, banque)', /\/orgs\/:orgId\/accounting\//]]) {
    const n = routes.filter((r) => re.test(r.path)).length;
    check(`couverture : ${label} — ${n} routes énumérées (donc testées sans connexion et en isolation)`, n > 0, n);
  }
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
