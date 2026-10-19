'use strict';
// Centre de sécurité de l'administration : état, double authentification de l'administrateur, journal d'audit, adresses bloquées, sessions.
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const limits = require('../middleware/limits');
const central = require('../security');
const { HttpError, safeEqual } = require('../util');

const router = express.Router();
const guard = limits.make(15 * 60 * 1000, 20, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'adminsec' });

async function needAdminPassword(req) {
  const pass = typeof (req.body || {}).password === 'string' ? req.body.password : '';
  if (!safeEqual(pass, config.admin.password)) { await central.audit.record(req, 'admin.password_check_fail', { severity: 'high' }); await central.abuse.strike(req, 'admin_login_fail'); throw new HttpError(403, 'Mot de passe administrateur incorrect.'); }
}

router.get('/overview', async (req, res) => {
  const t = await db.prepare('SELECT enabled, recovery_codes FROM admin_2fa WHERE id = 1').get();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sev = await db.prepare('SELECT severity, COUNT(*) AS n FROM audit_trail WHERE at >= ? GROUP BY severity').all(since);
  const bySev = Object.fromEntries(['info', 'warn', 'high', 'critical'].map((k) => [k, 0]));
  for (const r of sev) bySev[r.severity] = r.n;
  res.json({
    twofa: { enabled: Boolean(Number(t.enabled)), recoveryLeft: central.totp.recoveryLeft(t.recovery_codes) },
    config: await central.configcheck.run(),
    blocks: await central.abuse.list(),
    sessions: await central.sessions.listAdmin(req.adminSession),
    last24h: bySev,
    activeUserSessions: (await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'user' AND revoked_at IS NULL AND expires_at > ?").get(new Date().toISOString())).n,
    auditRows: (await db.prepare('SELECT COUNT(*) AS n FROM audit_trail').get()).n,
  });
});

// ---- Double authentification de l'administrateur ----
router.post('/2fa/setup', guard, async (req, res) => {
  await needAdminPassword(req);
  const t = await db.prepare('SELECT enabled FROM admin_2fa WHERE id = 1').get();
  if (Number(t.enabled)) throw new HttpError(400, 'La double authentification est déjà active.');
  const secret = central.totp.newSecret();
  await db.prepare('UPDATE admin_2fa SET totp_secret = ?, totp_step = 0 WHERE id = 1').run(central.totp.seal(secret));
  res.json({ secret, uri: central.totp.uri(config.admin.username || 'admin', secret, 'MANAGER-IA Admin') });
});
router.post('/2fa/enable', guard, async (req, res) => {
  const t = await db.prepare('SELECT * FROM admin_2fa WHERE id = 1').get();
  if (Number(t.enabled)) throw new HttpError(400, 'La double authentification est déjà active.');
  const secret = central.totp.unseal(t.totp_secret);
  if (!secret) throw new HttpError(400, "Commencez par « Activer » pour obtenir un secret.");
  const step = central.totp.verify(secret, (req.body || {}).code, 0);
  if (!step) { await central.abuse.strike(req, 'twofa_fail'); throw new HttpError(400, "Code incorrect. Vérifiez l'heure de votre téléphone."); }
  const rc = central.totp.newRecoveryCodes();
  await db.prepare('UPDATE admin_2fa SET enabled = 1, totp_step = ?, recovery_codes = ? WHERE id = 1').run(step, JSON.stringify(rc.hashes));
  await central.audit.record(req, 'admin.twofa_enable', { severity: 'high' });
  res.json({ ok: true, recoveryCodes: rc.codes });
});
router.post('/2fa/disable', guard, async (req, res) => {
  await needAdminPassword(req);
  const t = await db.prepare('SELECT * FROM admin_2fa WHERE id = 1').get();
  if (!Number(t.enabled)) throw new HttpError(400, "La double authentification n'est pas active.");
  const code = String((req.body || {}).code || '').trim();
  const step = central.totp.verify(central.totp.unseal(t.totp_secret), code, t.totp_step);
  if (!step && central.totp.useRecovery(t.recovery_codes, code) === null) { await central.abuse.strike(req, 'twofa_fail'); throw new HttpError(403, 'Code incorrect.'); }
  await db.prepare("UPDATE admin_2fa SET enabled = 0, totp_secret = '', totp_step = 0, recovery_codes = '[]' WHERE id = 1").run();
  await central.audit.record(req, 'admin.twofa_disable', { severity: 'critical' });
  res.json({ ok: true });
});

// ---- Journal d'audit ----
router.get('/audit', async (req, res) => {
  res.json({ events: await central.audit.list({ limit: req.query.limit, severity: req.query.severity, action: req.query.action, q: req.query.q, orgId: req.query.orgId, beforeId: req.query.before }) });
});
router.post('/audit/verify', async (req, res) => {
  const r = await central.audit.verify();
  await central.audit.record(req, r.ok ? 'audit.verify_ok' : 'audit.verify_broken', { severity: r.ok ? 'info' : 'critical', detail: r.ok ? `${r.checked} ligne(s)` : `rupture à la ligne ${r.brokenAt}` });
  res.json(r);
});

// ---- Adresses IP bloquées ----
router.post('/blocks', async (req, res) => {
  const b = req.body || {};
  const ip = String(b.ip || '').trim().replace(/^::ffff:/, '');
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw new HttpError(400, 'Adresse IP invalide.');
  const hours = Math.min(Math.max(Number(b.hours) || 24, 1), 24 * 365);
  await central.abuse.block(ip, { reason: String(b.reason || 'Blocage manuel').slice(0, 160), ms: hours * 3600 * 1000, permanent: Boolean(b.permanent), by: 'admin', req });
  res.status(201).json({ ok: true });
});
router.delete('/blocks/:ip', async (req, res) => {
  if (!(await central.abuse.unblock(req.params.ip, req))) throw new HttpError(404, 'Adresse non bloquée.');
  res.json({ ok: true });
});

// ---- Sessions ----
router.delete('/sessions/:id', async (req, res) => {
  if (!(await central.sessions.revoke(String(req.params.id).slice(0, 64), "fermée par l'administrateur"))) throw new HttpError(404, 'Session introuvable.');
  await central.audit.record(req, 'admin.session_revoke', { severity: 'warn' });
  res.json({ ok: true });
});
router.post('/sessions/revoke-others', async (req, res) => {
  const n = await central.sessions.revokeAllAdmin(req.adminSession, 'fermée par l\'administrateur');
  await central.audit.record(req, 'admin.session_revoke_others', { severity: 'warn', detail: `${n} session(s)` });
  res.json({ ok: true, closed: n });
});
/** Compte suspect : déconnecte immédiatement tous les appareils d'un utilisateur. */
router.post('/users/:id/revoke-sessions', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Identifiant invalide.');
  const n = await central.sessions.revokeAllForUser(id, '', "fermée par l'administrateur");
  await central.audit.record(req, 'admin.user_sessions_revoke', { target: `user:${id}`, severity: 'high', detail: `${n} session(s)` });
  res.json({ ok: true, closed: n });
});

module.exports = router;
