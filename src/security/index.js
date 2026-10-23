'use strict';
// Centre de sécurité : un seul point d'entrée pour tout ce qui protège MANAGER-IA.
//   audit      journal d'audit chaîné (preuve d'intégrité)          sessions   connexions révocables (appareils)
//   abuse      points d'abus, blocage automatique d'adresses IP     totp       double authentification (TOTP + codes de secours)
//   sensitive  table des actions sensibles surveillées              configcheck contrôle de la configuration
const crypto = require('crypto');
const audit = require('./audit');
const sessions = require('./sessions');
const abuse = require('./abuse');
const totp = require('./totp');
const sensitive = require('./sensitive');
const configcheck = require('./configcheck');

/** Numéro unique par requête (en-tête X-Request-Id, journal d'audit, journal du serveur) : retrouve toute une action de bout en bout. */
function requestId(req, res, next) {
  const given = String(req.get('x-request-id') || '');
  req.id = /^[A-Za-z0-9-]{8,64}$/.test(given) ? given : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

async function sweep() { await Promise.all([sessions.sweep(), abuse.sweep()]); }

module.exports = { audit, sessions, abuse, totp, sensitive, configcheck, requestId, sweep };
