'use strict';
// Contrôle de la configuration de sécurité : liste claire de ce qui est solide (ok), à améliorer (warn) ou dangereux (bad).
// Aucun secret n'est jamais affiché, seulement leur présence et leur force. Lancé par « npm run security:check » et affiché dans l'administration.
const config = require('../config');
const { db } = require('../db');
const { passwordProblem } = require('../services/security');

async function run() {
  const out = [];
  const add = (id, level, title, text) => out.push({ id, level, title, text });
  const prod = config.isProd;

  const jwtLen = String(config.jwtSecret || '').length;
  add('jwt', jwtLen >= 48 ? 'ok' : jwtLen >= 32 ? 'warn' : 'bad', 'Secret des connexions (JWT_SECRET)',
    jwtLen >= 48 ? 'Long et solide.' : `Trop court (${jwtLen} caractères) : générez-en un de 48+ caractères.`);
  const dk = String(config.dataKey || '');
  add('datakey', dk.length >= 32 ? 'ok' : 'warn', 'Clé de chiffrement des jetons (DATA_KEY)',
    dk.length >= 32 ? 'Définie, distincte du secret des connexions.' : 'Absente ou courte : les jetons WhatsApp/Meta et les secrets 2FA sont chiffrés avec une clé dérivée de JWT_SECRET. Définissez DATA_KEY (32+ caractères) et ne la changez plus.');
  add('env', prod ? 'ok' : 'warn', 'Mode production', prod ? 'NODE_ENV=production.' : 'NODE_ENV n\'est pas « production » : normal en développement, jamais en ligne.');
  add('cookie', config.cookie.secure ? 'ok' : (prod ? 'bad' : 'warn'), 'Cookies de connexion', config.cookie.secure ? `Marqués Secure, SameSite=${config.cookie.sameSite}.` : 'Non marqués Secure : en ligne, ils pourraient circuler en clair.');
  add('proxy', !prod || (config.trustProxy && config.trustProxy !== '0') ? 'ok' : 'warn', 'Adresse IP réelle des visiteurs (TRUST_PROXY)', !prod || (config.trustProxy && config.trustProxy !== '0') ? 'Réglé : les blocages et limites utilisent la vraie adresse.' : 'Non réglé derrière Render/Vercel : toutes les requêtes auraient la même adresse.');
  const origins = config.allowedOrigins || [];
  add('origins', origins.some((o) => o === '*') ? 'bad' : (prod && !origins.length ? 'warn' : 'ok'), 'Sites autorisés (ALLOWED_ORIGINS)',
    origins.some((o) => o === '*') ? 'Joker « * » : tout site pourrait appeler l\'API.' : origins.length ? `${origins.length} adresse(s) autorisée(s).` : 'Aucune : seules les requêtes du même domaine sont acceptées (correct avec la redirection /api de Vercel).');
  if (prod && origins.some((o) => /^http:\/\//.test(o) && !/localhost|127\.0\.0\.1/.test(o))) add('origins-https', 'bad', 'Adresses des sites autorisés', 'Une adresse en http:// (non chiffrée) est autorisée.');

  const ap = String(config.admin.password || '');
  if (!config.admin.username || !ap) add('admin', 'warn', 'Accès administrateur', 'Non configuré (ADMIN_USERNAME / ADMIN_PASSWORD) : l\'administration est désactivée.');
  else {
    const weak = ap.length < 12 || passwordProblem(ap);
    add('admin-pass', weak ? 'bad' : 'ok', 'Mot de passe administrateur', weak ? 'Trop court ou trop facile : 12+ caractères, mélangés.' : 'Solide.');
    add('admin-user', /^(admin|administrator|root|administrateur)$/i.test(config.admin.username) ? 'warn' : 'ok', 'Identifiant administrateur', /^(admin|administrator|root|administrateur)$/i.test(config.admin.username) ? 'Identifiant trop prévisible : choisissez-en un moins courant.' : 'Non prévisible.');
    try {
      const t = await db.prepare('SELECT enabled FROM admin_2fa WHERE id = 1').get();
      add('admin-2fa', t && Number(t.enabled) ? 'ok' : (prod ? 'bad' : 'warn'), 'Double authentification de l\'administrateur', t && Number(t.enabled) ? 'Active (application d\'authentification).' : 'Non activée : un mot de passe volé suffirait. Activez-la dans Sécurité.');
    } catch { /* base indisponible */ }
  }
  add('smtp', config.smtp.host ? 'ok' : 'warn', 'Vérification des inscriptions par e-mail', config.smtp.host ? 'Active (code à 6 chiffres).' : 'E-mail non configuré : les comptes se créent sans vérifier l\'adresse.');
  const url = String(config.database.url || '');
  if (config.database.driver === 'pg') {
    const ssl = /sslmode=(require|verify)/i.test(url) || config.database.ssl === undefined && /neon\.tech|render\.com|supabase/.test(url);
    add('db-ssl', ssl || !prod ? 'ok' : 'warn', 'Connexion à la base', ssl ? 'Chiffrée (SSL).' : (prod ? 'Vérifiez que l\'adresse contient sslmode=require.' : 'Base locale (développement).'));
  }
  add('api-url', !config.apiPublicUrl || /^https:/.test(config.apiPublicUrl) || !prod ? 'ok' : 'warn', 'Adresse publique du serveur (API_PUBLIC_URL)', /^https:/.test(config.apiPublicUrl || '') ? 'En https.' : prod ? 'Pas en https : les liens de médias WhatsApp seraient refusés par Meta.' : 'Non définie (développement).');
  if (config.meta && (config.meta.appSecret === undefined || config.meta.appSecret === '') && (config.whatsapp.token || config.meta.verifyToken)) add('meta', 'bad', 'Signature des webhooks Meta', 'META_APP_SECRET manquant : les messages entrants ne peuvent pas être authentifiés.');
  return { items: out, summary: { ok: out.filter((x) => x.level === 'ok').length, warn: out.filter((x) => x.level === 'warn').length, bad: out.filter((x) => x.level === 'bad').length } };
}

module.exports = { run };
