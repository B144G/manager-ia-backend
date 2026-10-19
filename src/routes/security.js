'use strict';
// Sécurité du compte (connecté) : appareils connectés et double authentification.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const limits = require('../middleware/limits');
const { requireUser } = require('../middleware/auth');
const central = require('../security');
const { asyncHandler, HttpError } = require('../util');

const router = express.Router();
router.use(requireUser);

const guard = limits.make(15 * 60 * 1000, 20, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'secacct' });

/** Mot de passe exigé pour toute modification de sécurité. */
async function needPassword(req) {
  const pass = typeof (req.body || {}).password === 'string' ? req.body.password.slice(0, 200) : '';
  if (!pass || !(await bcrypt.compare(pass, req.user.pass_hash))) {
    await central.audit.record(req, 'security.password_check_fail', { severity: 'warn' });
    await central.abuse.strike(req, 'login_fail');
    throw new HttpError(403, 'Mot de passe incorrect.');
  }
}

router.get('/overview', asyncHandler(async (req, res) => {
  const u = await db.prepare('SELECT totp_enabled, recovery_codes FROM users WHERE id = ?').get(req.user.id);
  res.json({
    twofa: { enabled: Boolean(Number(u.totp_enabled)), recoveryLeft: central.totp.recoveryLeft(u.recovery_codes) },
    sessions: await central.sessions.listForUser(req.user.id, req.sessionId),
  });
}));

// ---- Appareils connectés ----
router.delete('/sessions/:id', asyncHandler(async (req, res) => {
  const s = await central.sessions.ofUser(String(req.params.id).slice(0, 64), req.user.id);
  if (!s) throw new HttpError(404, 'Appareil introuvable.');
  await central.sessions.revoke(s.id, 'fermée par le titulaire');
  await central.audit.record(req, 'session.revoke', { severity: 'info', detail: central.sessions.deviceName(s.ua) });
  res.json({ ok: true, current: s.id === req.sessionId });
}));
router.post('/sessions/revoke-others', asyncHandler(async (req, res) => {
  const n = await central.sessions.revokeAllForUser(req.user.id, req.sessionId, 'fermée par le titulaire');
  await central.audit.record(req, 'session.revoke_others', { severity: 'warn', detail: `${n} appareil(s)` });
  res.json({ ok: true, closed: n });
}));

// ---- Double authentification ----
// 1) setup : génère un secret (pas encore actif) ; 2) enable : l'utilisateur prouve qu'il a bien configuré son application avec un premier code.
router.post('/2fa/setup', guard, asyncHandler(async (req, res) => {
  await needPassword(req);
  const cur = await db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (Number(cur.totp_enabled)) throw new HttpError(400, 'La double authentification est déjà active.');
  const secret = central.totp.newSecret();
  await db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_step = 0 WHERE id = ?').run(central.totp.seal(secret), req.user.id);
  res.json({ secret, uri: central.totp.uri(req.user.contact, secret) });
}));
router.post('/2fa/enable', guard, asyncHandler(async (req, res) => {
  const u = await db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (Number(u.totp_enabled)) throw new HttpError(400, 'La double authentification est déjà active.');
  const secret = central.totp.unseal(u.totp_secret);
  if (!secret) throw new HttpError(400, "Commencez par « Activer » pour obtenir un secret.");
  const step = central.totp.verify(secret, (req.body || {}).code, 0);
  if (!step) { await central.abuse.strike(req, 'twofa_fail'); throw new HttpError(400, 'Code incorrect. Vérifiez l\'heure de votre téléphone et réessayez.'); }
  const rc = central.totp.newRecoveryCodes();
  await db.prepare('UPDATE users SET totp_enabled = 1, totp_step = ?, recovery_codes = ? WHERE id = ?').run(step, JSON.stringify(rc.hashes), req.user.id);
  await central.audit.record(req, 'twofa.enable', { severity: 'warn' });
  res.json({ ok: true, recoveryCodes: rc.codes }); // affichés une seule fois
}));
router.post('/2fa/disable', guard, asyncHandler(async (req, res) => {
  await needPassword(req);
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!Number(u.totp_enabled)) throw new HttpError(400, "La double authentification n'est pas active.");
  const code = String((req.body || {}).code || '').trim();
  const step = central.totp.verify(central.totp.unseal(u.totp_secret), code, u.totp_step);
  if (!step && central.totp.useRecovery(u.recovery_codes, code) === null) { await central.abuse.strike(req, 'twofa_fail'); throw new HttpError(403, 'Code incorrect.'); }
  await db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = '', totp_step = 0, recovery_codes = '[]' WHERE id = ?").run(req.user.id);
  await central.audit.record(req, 'twofa.disable', { severity: 'high' });
  res.json({ ok: true });
}));
router.post('/2fa/recovery', guard, asyncHandler(async (req, res) => {
  await needPassword(req);
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!Number(u.totp_enabled)) throw new HttpError(400, "La double authentification n'est pas active.");
  const step = central.totp.verify(central.totp.unseal(u.totp_secret), (req.body || {}).code, u.totp_step);
  if (!step) { await central.abuse.strike(req, 'twofa_fail'); throw new HttpError(403, 'Code incorrect.'); }
  const rc = central.totp.newRecoveryCodes();
  await db.prepare('UPDATE users SET totp_step = ?, recovery_codes = ? WHERE id = ?').run(step, JSON.stringify(rc.hashes), req.user.id);
  await central.audit.record(req, 'twofa.recovery_regenerate', { severity: 'warn' });
  res.json({ ok: true, recoveryCodes: rc.codes });
}));

module.exports = router;
