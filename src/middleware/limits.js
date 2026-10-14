'use strict';
// Limites de débit (anti-abus). Les messages sont en français.
const rateLimit = require('express-rate-limit');
const AI_PER_MINUTE = Math.max(parseInt(process.env.AI_PER_MINUTE, 10) || 20, 1);

function make(windowMs, limit, message) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message || 'Trop de requêtes. Réessayez dans un moment.' }),
  });
}

const MIN = 60 * 1000;
module.exports = {
  make,
  global: make(15 * MIN, 600),
  register: make(60 * MIN, 10, 'Trop de créations de compte depuis cette connexion. Réessayez plus tard.'),
  login: make(15 * MIN, 20, 'Trop de tentatives de connexion. Réessayez dans 15 minutes.'),
  contact: make(10 * MIN, 5, 'Vous avez envoyé trop de messages. Réessayez dans quelques minutes.'),
  assistantMinute: make(MIN, AI_PER_MINUTE, 'Vous écrivez trop vite. Patientez une minute puis réessayez.'),
  paymentsInit: make(10 * MIN, 10, 'Trop de demandes de paiement. Réessayez dans quelques minutes.'),
  adminLogin: make(15 * MIN, 10, 'Trop de tentatives. Réessayez dans 15 minutes.'),
};
