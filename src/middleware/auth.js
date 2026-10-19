'use strict';
// Cookies de session : "mia_token" (utilisateur, 30 jours) et "mia_admin" (administrateur, 12 h).
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db, getUserFresh } = require('../db');
const { HttpError } = require('../util');

const USER_COOKIE = 'mia_token';
const ADMIN_COOKIE = 'mia_admin';
const USER_MAX_AGE = 30 * 24 * 3600 * 1000;
const ADMIN_MAX_AGE = 12 * 3600 * 1000;

const cookieOpts = (maxAge) => ({
  httpOnly: true,
  secure: config.cookie.secure,
  sameSite: config.cookie.sameSite,
  path: '/',
  maxAge,
});

async function setUserCookie(res, userId) {
  // « pc » = date du dernier changement de mot de passe : un changement invalide toutes les sessions ouvertes avant lui (sans dépendre de l'horloge).
  const row = await db.prepare('SELECT pass_changed_at FROM users WHERE id = ?').get(userId);
  const token = jwt.sign({ sub: userId, typ: 'user', pc: (row && row.pass_changed_at) || '' }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '30d' });
  res.cookie(USER_COOKIE, token, cookieOpts(USER_MAX_AGE));
}
const clearUserCookie = (res) => res.clearCookie(USER_COOKIE, { ...cookieOpts(0), maxAge: undefined });

function setAdminCookie(res) {
  const token = jwt.sign({ typ: 'admin' }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '12h' });
  res.cookie(ADMIN_COOKIE, token, cookieOpts(ADMIN_MAX_AGE));
}
const clearAdminCookie = (res) => res.clearCookie(ADMIN_COOKIE, { ...cookieOpts(0), maxAge: undefined });

function verify(token, typ) {
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    return p && p.typ === typ ? p : null;
  } catch {
    return null;
  }
}

async function requireUser(req, res, next) {
  const token = req.cookies && req.cookies[USER_COOKIE];
  if (!token) throw new HttpError(401, 'Vous devez être connecté.');
  const p = verify(token, 'user');
  if (!p) throw new HttpError(401, 'Session expirée. Veuillez vous reconnecter.');
  const row = await getUserFresh(p.sub);
  if (!row) throw new HttpError(401, 'Compte introuvable. Veuillez vous reconnecter.');
  if ((p.pc || '') !== (row.pass_changed_at || '')) throw new HttpError(401, 'Votre mot de passe a été modifié : reconnectez-vous.');
  req.user = row;
  next();
}

function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies[ADMIN_COOKIE];
  if (!token || !verify(token, 'admin')) throw new HttpError(401, 'Connexion administrateur requise.');
  next();
}

module.exports = { setUserCookie, clearUserCookie, setAdminCookie, clearAdminCookie, requireUser, requireAdmin };
