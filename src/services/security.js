'use strict';
// Sécurité des comptes : règle des mots de passe, verrouillage après échecs répétés, journal de sécurité.
const { db, nowISO } = require('../db');
const { HttpError, log } = require('../util');

const BCRYPT_COST = 12;
const MAX_FAILS = 8;                       // échecs avant verrouillage
const FAIL_WINDOW_MS = 15 * 60 * 1000;     // fenêtre de comptage des échecs
const LOCK_MS = 15 * 60 * 1000;            // durée du verrouillage

const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'password123', 'motdepasse', 'motdepasse1', 'azertyui', 'azerty123', 'azerty1234', 'qwertyui', 'qwerty123', 'abcd1234', '11111111', '00000000', 'iloveyou', 'admin123', 'admin1234', 'manager-ia', 'manageria', 'manager123', 'bienvenue', 'cameroun', 'cameroun237']);

/** Vérifie un nouveau mot de passe. Renvoie un message d'erreur, ou '' s'il est correct. */
function passwordProblem(pass, ...personal) {
  if (typeof pass !== 'string' || pass.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.';
  if (pass.length > 200) return 'Le mot de passe est trop long.';
  const low = pass.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pass) || /^\d+$/.test(pass)) return 'Ce mot de passe est trop facile à deviner. Mélangez lettres et chiffres.';
  for (const p of personal) { const x = String(p || '').toLowerCase().split('@')[0]; if (x.length >= 4 && low.includes(x)) return 'Ne mettez pas votre nom ou votre e-mail dans le mot de passe.'; }
  return '';
}

/** Lance une erreur 429 si ce compte (ou "admin") est verrouillé. */
async function assertNotLocked(key) {
  const r = await db.prepare('SELECT * FROM login_fails WHERE k = ?').get(key);
  if (r && r.locked_until && Date.parse(r.locked_until) > Date.now()) {
    const min = Math.max(1, Math.ceil((Date.parse(r.locked_until) - Date.now()) / 60000));
    throw new HttpError(429, `Trop d'échecs : connexion bloquée pendant encore ${min} min. Vous pouvez aussi réinitialiser votre mot de passe.`);
  }
}
/** Compte un échec ; renvoie true si le verrouillage vient d'être déclenché. */
async function recordFail(key) {
  const now = Date.now();
  const r = await db.prepare('SELECT * FROM login_fails WHERE k = ?').get(key);
  let fails = 1; let first = new Date(now).toISOString();
  if (r && now - Date.parse(r.first_at) < FAIL_WINDOW_MS) { fails = r.fails + 1; first = r.first_at; }
  const lock = fails >= MAX_FAILS ? new Date(now + LOCK_MS).toISOString() : null;
  await db.prepare('INSERT INTO login_fails (k, fails, first_at, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET fails = excluded.fails, first_at = excluded.first_at, locked_until = excluded.locked_until')
    .run(key, lock ? 0 : fails, first, lock);
  return Boolean(lock);
}
const clearFails = async (key) => await db.prepare('DELETE FROM login_fails WHERE k = ?').run(key);

// Anciens types d'événements -> journal d'audit central (src/security/audit.js) : [action, gravité, points d'abus]
const LEGACY = {
  register: ['account.register', 'info'], login_ok: ['login.ok', 'info'], login_fail: ['login.fail', 'warn', 'login_fail'], login_locked: ['login.locked', 'high', 'login_locked'],
  password_reset: ['password.reset', 'warn'], password_change: ['password.change', 'warn'], password_change_fail: ['password.change_fail', 'warn'],
  admin_login: ['admin.login', 'warn'], admin_login_fail: ['admin.login_fail', 'high', 'admin_login_fail'], admin_locked: ['admin.locked', 'critical', 'admin_locked'],
};

/** Journal de sécurité (jamais de mot de passe ni de code) : écrit dans le journal d'audit central, et compte les points d'abus. */
async function audit(type, req, userId, detail) {
  const m = LEGACY[type] || [String(type).replace(/_/g, '.'), 'info'];
  const central = require('../security');
  await central.audit.record(req, m[0], { userId, detail, severity: m[1], actor: type === 'admin_login' ? { type: 'admin', id: null } : undefined });
  if (m[2]) await central.abuse.strike(req, m[2]);
}

async function sweep() {
  await db.prepare('DELETE FROM security_log WHERE at < ?').run(new Date(Date.now() - 180 * 86400000).toISOString());
  await db.prepare('DELETE FROM login_fails WHERE (locked_until IS NULL OR locked_until < ?) AND first_at < ?').run(nowISO(), new Date(Date.now() - FAIL_WINDOW_MS).toISOString());
  await require('../security').sweep();
}

module.exports = { BCRYPT_COST, passwordProblem, assertNotLocked, recordFail, clearFails, audit, sweep };
