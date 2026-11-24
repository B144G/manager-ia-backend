'use strict';
// Sécurité : entrées hostiles sur TOUTES les routes de lecture de l'application (identifiants et paramètres piégés : injection SQL, chemins, valeurs géantes).
// Aucune ne doit répondre par une erreur serveur (5xx), et aucune ne doit être ralentie par une injection (pg_sleep). Lancez-le avec : node scripts/test-security-fuzz.js
const path = require('path');
const { run } = require('./lib/wave2');
process.env.DATABASE_URL = 'pglite://memory'; process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'x'.repeat(40);
process.env.RATE_LIMIT_GLOBAL = process.env.RATE_LIMIT_GLOBAL || '20000'; // le balayage (lectures + écritures) approche la limite globale de production (3 000 requêtes / 15 min / adresse)
const { listRoutes } = require('./lib/routes');
const { app } = require(path.join(__dirname, '..', 'src', 'server.js'));

const SQLI = "1' OR '1'='1'; SELECT pg_sleep(4);--";
const QUERY = ['q', 'search', 'sort', 'order', 'orderBy', 'dir', 'status', 'kind', 'module', 'from', 'to', 'month', 'year', 'limit', 'offset', 'branchId', 'customerId', 'format', 'type', 'tag', 'name', 'date']
  .map((k) => `${k}=${encodeURIComponent(SQLI)}`).join('&');

run('Sécurité : entrées hostiles sur toutes les routes de lecture', async ({ check, owner, org, org2, base }) => {
  const routes = listRoutes(app).filter((r) => r.method === 'GET' && r.path.startsWith('/api/ws/orgs/:orgId') && !/\/(export|download|file|pdf|print)/.test(r.path) && !/\/chat\/stream$/.test(r.path)); // /chat/stream : flux temps réel qui ne se termine jamais (testé dans test:chat)
  check(`routes de lecture de l'espace de travail : ${routes.length} (plus de 250 attendues)`, routes.length > 250, routes.length);
  const slow = []; const fail = []; let n = 0;
  for (const r of routes) {
    for (const variant of ['sqli', 'path', 'huge']) {
      const val = variant === 'sqli' ? encodeURIComponent(SQLI) : variant === 'path' ? '..%2F..%2Fetc%2Fpasswd' : '99999999999999999999999';
      const url = r.path.replace(/:orgId/g, org).replace(/:action\([^)]*\)/g, 'confirm').replace(/:[A-Za-z]+/g, val) + (variant === 'sqli' ? '?' + QUERY : '?limit=999999999&year=99999&month=13');
      const t = Date.now();
      const res = await owner('GET', url);
      n++;
      if (res.status >= 500) fail.push(`${res.status} ${url.slice(0, 90)}`);
      if (Date.now() - t > 3000) slow.push(`${Date.now() - t} ms ${url.slice(0, 90)}`);
    }
  }
  check(`${n} requêtes hostiles : aucune erreur serveur (5xx)`, fail.length === 0, fail.slice(0, 12));
  check('aucune requête ralentie par une injection (pg_sleep)', slow.length === 0, slow.slice(0, 5));

  // Écritures : corps hostile (injection SQL, balises, valeurs géantes, types faux). Sont exclues les routes qui contactent des services externes (WhatsApp, e-mail, IA, diffusion).
  const EXCLUDED = /(wa-qr|\/mail\/|broadcast|\/ai\/|\/send|embedded|pairing|\/whatsapp|\/meta|webhooks\/\d+\/test|\/reset|\/relay|\/followups\/run|\/digest\/send|\/orgs\/:orgId$)/;
  const writes = listRoutes(app).filter((r) => ['POST', 'PUT', 'DELETE'].includes(r.method) && r.path.startsWith('/api/ws/orgs/:orgId/') && !EXCLUDED.test(r.path));
  const body = { name: "'; DROP TABLE users;--", title: '<script>alert(1)</script>', label: "x' OR 1=1--", notes: 'a'.repeat(5000), amount: 1e30, quantity: -1, price: '9'.repeat(40), date: '2026-13-45', email: 'pas-un-email', phone: '\u0000\u0001', id: "1' OR '1'='1", status: { $ne: 1 }, items: 'pas-une-liste', lines: [{ account: "'; --", debit: 'NaN' }], customerId: '99999999999999999999999', itemId: -5 };
  const bad = []; let w = 0;
  for (const r of writes) {
    const url = r.path.replace(/:orgId/g, org).replace(/:action\([^)]*\)/g, 'confirm').replace(/:[A-Za-z]+/g, '99999999999999999999999');
    const res = await owner(r.method, url, r.method === 'DELETE' ? undefined : body);
    w++;
    if (res.status >= 500 && res.status !== 503) bad.push(`${res.status} ${r.method} ${r.path.replace('/api/ws/orgs/:orgId', '')}`);
  }
  check(`${w} routes d'écriture avec un corps hostile : aucune erreur serveur (5xx)`, bad.length === 0, bad.slice(0, 25));
  const intact = await owner('GET', `/api/ws/orgs/${org}`);
  check('le serveur reste sain après les entrées hostiles', intact.status === 200, intact.status);
});
