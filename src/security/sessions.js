'use strict';
// Sessions côté serveur : chaque connexion a un identifiant (dans le cookie signé) et une ligne en base.
// On peut donc voir les appareils connectés, déconnecter un appareil, ou tout couper d'un coup (mot de passe changé, compte suspect).
const crypto = require('crypto');
const { db, nowISO } = require('../db');

const MAX_ACTIVE_USER = 10;     // au-delà, la plus ancienne session est fermée
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const clip = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, n);

/** Crée une session et renvoie son identifiant. kind = 'user' ou 'admin'. */
async function create(req, { kind = 'user', userId = null, maxAgeMs }) {
  const id = crypto.randomBytes(24).toString('hex');
  const now = nowISO();
  await db.prepare('INSERT INTO sessions (id, kind, user_id, created_at, last_seen, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, userId, now, now, new Date(Date.now() + maxAgeMs).toISOString(), clip(req && req.ip, 64), clip(req && req.get && req.get('user-agent'), 200));
  if (kind === 'user' && userId) {
    const extra = await db.prepare('SELECT id FROM sessions WHERE kind = \'user\' AND user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC OFFSET ?').all(userId, now, MAX_ACTIVE_USER);
    for (const e of extra) await revoke(e.id, 'limite');
  }
  return id;
}

/** Session valide (non révoquée, non expirée) ou undefined. Met à jour « dernière activité » au plus toutes les 5 minutes. */
async function check(id, kind) {
  if (!id || typeof id !== 'string' || id.length > 64) return undefined;
  const s = await db.prepare('SELECT * FROM sessions WHERE id = ? AND kind = ?').get(id, kind);
  if (!s || s.revoked_at || Date.parse(s.expires_at) <= Date.now()) return undefined;
  if (Date.now() - Date.parse(s.last_seen) > TOUCH_EVERY_MS) await db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(nowISO(), id);
  return s;
}

const revoke = async (id, reason = 'déconnexion') => (await db.prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL').run(nowISO(), clip(reason, 40), id)).changes > 0;

/** Ferme toutes les sessions d'un utilisateur (sauf éventuellement une). Renvoie le nombre de sessions fermées. */
async function revokeAllForUser(userId, exceptId, reason = 'sécurité') {
  return (await db.prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE kind = \'user\' AND user_id = ? AND revoked_at IS NULL AND id != ?').run(nowISO(), clip(reason, 40), userId, exceptId || '')).changes;
}
async function revokeAllAdmin(exceptId, reason = 'sécurité') {
  return (await db.prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE kind = \'admin\' AND revoked_at IS NULL AND id != ?').run(nowISO(), clip(reason, 40), exceptId || '')).changes;
}

const view = (s, currentId) => ({ id: s.id, current: s.id === currentId, createdAt: s.created_at, lastSeen: s.last_seen, expiresAt: s.expires_at, ip: s.ip, device: deviceName(s.ua) });

/** Description lisible de l'appareil (jamais l'identifiant complet de session ailleurs que dans sa propre liste). */
function deviceName(ua) {
  const u = String(ua || '');
  const os = /iPhone|iPad/.test(u) ? 'iPhone/iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Appareil inconnu';
  const br = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : '';
  return br ? `${br} sur ${os}` : os;
}

async function listForUser(userId, currentId) {
  const rows = await db.prepare('SELECT * FROM sessions WHERE kind = \'user\' AND user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen DESC').all(userId, nowISO());
  return rows.map((s) => view(s, currentId));
}
async function listAdmin(currentId) {
  const rows = await db.prepare('SELECT * FROM sessions WHERE kind = \'admin\' AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen DESC').all(nowISO());
  return rows.map((s) => view(s, currentId));
}
/** Une session précise d'un utilisateur (pour la lui fermer). */
const ofUser = async (id, userId) => await db.prepare('SELECT * FROM sessions WHERE id = ? AND kind = \'user\' AND user_id = ? AND revoked_at IS NULL').get(id, userId);

async function sweep() {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(new Date(Date.now() - 7 * 86400000).toISOString(), new Date(Date.now() - 30 * 86400000).toISOString());
}

module.exports = { create, check, revoke, revokeAllForUser, revokeAllAdmin, listForUser, listAdmin, ofUser, sweep, deviceName };
