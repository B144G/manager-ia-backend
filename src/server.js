'use strict';
// Point d'entrée : assemble le serveur Express.
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { db } = require('./db');
const limits = require('./middleware/limits');
const { HttpError, log } = require('./util');
const { mailEnabled } = require('./services/notify');

const app = express();
app.disable('x-powered-by');

const tp = config.trustProxy;
if (tp && tp !== '0' && tp.toLowerCase() !== 'false') app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp.toLowerCase() === 'true' ? 1 : tp);

// CSP désactivée ici : elle est appliquée seulement à /admin (le frontend public a ses propres scripts).
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// En-têtes de sécurité supplémentaires (sur tout) et politique de contenu stricte pour les pages du site servies ici.
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=(self)');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
const siteCsp = () => [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:", "media-src 'self' blob:", `connect-src 'self' ${config.allowedOrigins.join(' ')}`.trim(),
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const sameOrigin = (o) => config.allowedOrigins.includes(String(o).replace(/\/+$/, ''));
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || sameOrigin(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600,
}));
app.use(cookieParser());

// Petit journal des requêtes (chemin seulement : jamais de corps, de cookies ni de paramètres).
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path !== '/api/health') log.info(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - t} ms)`);
  });
  next();
});

// Webhooks Meta (corps brut conservé pour la signature) : avant le lecteur JSON général.
app.use('/webhooks', require('./routes/webhooks'));

const jsonSmall = express.json({ limit: '100kb' });
// Les fichiers joints (images, PDF) arrivent en base64 : cette seule route a une limite plus large (elle la règle elle-même, après connexion).
app.use((req, res, next) => ((/^\/api\/ws\/orgs\/\d+\/mail\/files$/.test(req.path) || /^\/api\/ws\/public\/chat\/[A-Za-z0-9]+\/voice$/.test(req.path) || /^\/api\/ws\/public\/(whatsapp|meta)\/[A-Za-z0-9]+$/.test(req.path)) && req.method === 'POST' ? next() : jsonSmall(req, res, next)));

// Protection contre les requêtes venant d'un autre site (CSRF) : l'en-tête Origin doit être connu.
function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.get('origin');
  if (!o) return next();
  let host;
  try {
    host = new URL(o).host;
  } catch {
    throw new HttpError(403, 'Origine non autorisée.');
  }
  if (host === req.get('host') || sameOrigin(o)) return next();
  throw new HttpError(403, 'Origine non autorisée.');
}

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', limits.global, originCheck);
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/contact'));
app.use('/api', require('./routes/assistant'));
app.use('/api', require('./routes/payments'));
app.use('/api/v1', require('./workspace/public-api'));
app.use('/api/admin', require('./routes/admin'));
const workspace = require('./workspace');
app.use('/api/ws/public', workspace.pub);
app.use('/api/ws', workspace.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Route introuvable.' }));

// Interface d'administration (fichiers statiques + politique de sécurité stricte)
const adminCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.use('/admin', (req, res, next) => {
  res.set('Content-Security-Policy', adminCsp);
  res.set('Cache-Control', 'no-store');
  next();
});
app.get('/admin', (req, res) => res.sendFile('index.html', { root: config.adminDir }));
app.use('/admin', express.static(config.adminDir, { index: false, dotfiles: 'ignore' }));

// Frontend (si le dossier public contient des fichiers)
app.use((req, res, next) => { if (req.method === 'GET' && !req.path.startsWith('/api')) res.set('Content-Security-Policy', siteCsp()); next(); });
app.use(express.static(config.publicDir, { index: 'index.html', dotfiles: 'ignore' }));
app.use((req, res) => {
  const home = path.join(config.publicDir, 'index.html');
  if (req.method === 'GET' && fs.existsSync(home) && req.accepts('html')) return res.sendFile('index.html', { root: config.publicDir });
  res.status(404).json({ error: 'Page introuvable.' });
});

// Gestion des erreurs : toujours {"error":"message en français"}
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.' });
  if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(400).json({ error: 'Requête invalide (JSON incorrect).' });
  }
  log.error(`Erreur interne sur ${req.method} ${req.path} :`, err && err.message ? err.message : err);
  res.status(500).json({ error: 'Erreur interne du serveur. Réessayez dans un instant.' });
});

function start() {
  process.on('unhandledRejection', (e) => log.error('Promesse non gérée :', e && e.message ? e.message : e));
  const server = app.listen(config.port, () => {
    log.info(`MANAGER-IA démarré sur le port ${config.port} (${config.isProd ? 'production' : 'développement'})`);
    log.info(`Base de données : ${config.dbPath}`);
    const on = (v) => (v ? 'activé' : 'non configuré');
    log.info(`Assistant IA : ${on(config.ai.key)} | Paiement automatique Campay : ${on(config.campay.enabled)} | WhatsApp admin : ${on(config.whatsapp.phoneId && config.whatsapp.token)} | E-mail : ${on(mailEnabled())} | Admin : ${on(config.admin.username && config.admin.password)} | Webhooks Meta : ${on(config.meta.appSecret)}`);
  });
  require('./jobs').start();
  require('./workspace/inbound').start(); // réponses différées (délai choisi par l'organisation)
  require('./workspace/sales-appt').startReminders(); // rappels de rendez-vous la veille
  const stop = () => server.close(() => { try { db.close(); } catch { /* rien */ } process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (require.main === module) start();

module.exports = { app, start };
