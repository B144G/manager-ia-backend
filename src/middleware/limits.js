'use strict';
// Limites de débit (anti-abus). Les messages sont en français.
// Les limites « sensibles » (connexion, inscription, paiements, administrateur, mot de passe) sont comptées dans PostgreSQL : partagées par tous les serveurs
// et conservées au redémarrage. Chaque dépassement ajoute aussi des points d'abus à l'adresse (blocage automatique en cas de répétition, voir src/security/abuse.js).
const rateLimit = require('express-rate-limit');
const { PgStore } = require('../security/ratestore');
const AI_PER_MINUTE = Math.max(parseInt(process.env.AI_PER_MINUTE, 10) || 20, 1);

/** make(fenêtre en ms, nombre maximal, message, { shared, prefix }) : avec shared, les compteurs sont dans la base (prefix obligatoire et unique). */
function make(windowMs, limit, message, opts = {}) {
  const o = {
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      if (opts.shared) require('../security/abuse').strike(req, 'rate_limited');
      res.status(429).json({ error: message || 'Trop de requêtes. Réessayez dans un moment.' });
    },
  };
  if (opts.shared) { if (!opts.prefix) throw new Error('limits.make : un limiteur partagé a besoin d\'un « prefix » unique.'); o.store = new PgStore(opts.prefix); }
  return rateLimit(o);
}

const MIN = 60 * 1000;
module.exports = {
  make,
  // Large : plusieurs personnes d'un même bureau partagent souvent une seule adresse IP, et l'espace de travail fait plusieurs appels par écran.
  global: make(15 * MIN, Math.max(parseInt(process.env.RATE_LIMIT_GLOBAL, 10) || 3000, 100)), // RATE_LIMIT_GLOBAL : réglable (ex. démo locale)
  register: make(60 * MIN, 10, 'Trop de créations de compte depuis cette connexion. Réessayez plus tard.', { shared: true, prefix: 'register' }),
  login: make(15 * MIN, 20, 'Trop de tentatives de connexion. Réessayez dans 15 minutes.', { shared: true, prefix: 'login' }),
  twofa: make(15 * MIN, 15, 'Trop de tentatives de code. Réessayez dans 15 minutes.', { shared: true, prefix: 'twofa' }),
  contact: make(10 * MIN, 5, 'Vous avez envoyé trop de messages. Réessayez dans quelques minutes.', { shared: true, prefix: 'contact' }),
  visit: make(MIN, 40, 'Trop de requêtes.'),
  unsubscribe: make(10 * MIN, 30, 'Trop de requêtes. Réessayez dans quelques minutes.'),
  assistantMinute: make(MIN, AI_PER_MINUTE, 'Vous écrivez trop vite. Patientez une minute puis réessayez.'),
  paymentsInit: make(10 * MIN, Math.max(parseInt(process.env.PAYMENTS_INIT_RATE, 10) || 10, 1), 'Trop de demandes de paiement. Réessayez dans quelques minutes.', { shared: true, prefix: 'payinit' }),
  paymentsConfirm: make(10 * MIN, Math.max(parseInt(process.env.PAYMENTS_CONFIRM_RATE, 10) || 20, 1), 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'payconfirm' }),
  campayWebhook: make(MIN, Math.max(parseInt(process.env.CAMPAY_WEBHOOK_RATE, 10) || 120, 5), 'Trop de requêtes.', { shared: true, prefix: 'campayhook' }),
  adminLogin: make(15 * MIN, 10, 'Trop de tentatives. Réessayez dans 15 minutes.', { shared: true, prefix: 'adminlogin' }),
};
