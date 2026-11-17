'use strict';
// Confidentialité : vos données, vos droits. Tout exige une connexion.
//   GET  /api/privacy/overview            consentements, demandes, délai de suppression
//   POST /api/privacy/consents            enregistrer / retirer un consentement (date + version du texte)
//   GET  /api/privacy/export              export de TOUTES vos données (JSON, format ouvert)
//   POST /api/privacy/erasure             demander la suppression du compte (anonymisation après un délai de réflexion) ; DELETE pour annuler
//   /api/privacy/orgs/:orgId/...          export complet, durées de conservation, double authentification exigée, registre d'accès (administrateurs)
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const limits = require('../middleware/limits');
const { requireUser } = require('../middleware/auth');
const central = require('../security');
const privacy = require('../security/privacy');
const A = require('../workspace/access');
const { asyncHandler, HttpError } = require('../util');

const router = express.Router();
router.use(requireUser);

const guard = limits.make(60 * 60 * 1000, 10, 'Trop de demandes. Réessayez dans une heure.', { shared: true, prefix: 'privacy' });
const consentGuard = limits.make(60 * 60 * 1000, 60, 'Trop de modifications. Réessayez dans une heure.', { shared: true, prefix: 'privacyconsent' });

router.get('/overview', asyncHandler(async (req, res) => {
  const u = await db.prepare('SELECT erase_after FROM users WHERE id = ?').get(req.user.id);
  res.json({
    consents: await privacy.consentState(req.user.id),
    requests: await db.prepare('SELECT id, kind, status, requested_at AS "requestedAt", due_at AS "dueAt", done_at AS "doneAt" FROM data_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id),
    erasure: { pending: Boolean(u && u.erase_after), eraseAfter: (u && u.erase_after) || null, graceDays: parseInt(process.env.PRIVACY_ERASE_GRACE_DAYS, 10) || 14 },
    versions: privacy.VERSIONS,
    responseDays: privacy.REQUEST_DEADLINE_DAYS,
  });
}));

router.get('/consents', asyncHandler(async (req, res) => res.json({ consents: await privacy.consentState(req.user.id), history: await privacy.consentHistory(req.user.id) })));
router.post('/consents', consentGuard, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (typeof b.accepted !== 'boolean') throw new HttpError(400, 'Indiquez si vous acceptez ou retirez votre consentement.');
  await privacy.recordConsent(req.user.id, String(b.kind || ''), b.accepted, req, b.version === undefined ? undefined : String(b.version));
  res.status(201).json({ consents: await privacy.consentState(req.user.id) });
}));

router.get('/export', guard, asyncHandler(async (req, res) => {
  const data = await privacy.exportUser(req.user.id);
  await db.prepare("INSERT INTO data_requests (user_id, kind, status, detail, requested_at, due_at, done_at) VALUES (?, 'export', 'done', 'libre-service', ?, ?, ?)").run(req.user.id, data.exportedAt, data.exportedAt, data.exportedAt);
  await central.audit.record(req, 'privacy.export', { severity: 'warn', detail: `${Object.keys(data.tables).length} table(s)` });
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="mes-donnees-brij-ia-${data.exportedAt.slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
  res.send(JSON.stringify(data, null, 2));
}));

router.post('/erasure', guard, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const pass = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  if (!pass || !(await bcrypt.compare(pass, req.user.pass_hash))) { await central.audit.record(req, 'security.password_check_fail', { severity: 'warn' }); throw new HttpError(403, 'Mot de passe incorrect.'); }
  if (b.confirm !== 'SUPPRIMER') throw new HttpError(400, 'Pour confirmer, écrivez exactement SUPPRIMER.');
  res.status(202).json(await privacy.requestErasure(req.user, req));
}));
router.delete('/erasure', asyncHandler(async (req, res) => { await privacy.cancelErasure(req.user, req); res.json({ ok: true }); }));

// ---------- Organisations ----------
const orgRouter = express.Router({ mergeParams: true });
router.use('/orgs/:orgId', A.loadOrg, orgRouter);

orgRouter.get('/export', A.need('owner'), guard, asyncHandler(async (req, res) => {
  const data = await privacy.exportOrg(req.org.id);
  await central.audit.record(req, 'privacy.org_export', { orgId: req.org.id, severity: 'high', detail: `${Object.keys(data.tables).length} table(s)` });
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="organisation-${req.org.id}-${data.exportedAt.slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
  res.send(JSON.stringify(data, null, 2));
}));

orgRouter.get('/retention', A.need('admin'), asyncHandler(async (req, res) => res.json({ rules: await privacy.retentionRules(req.org.id), note: "Le journal d'audit de sécurité n'est jamais purgé (il garantit l'intégrité de la trace) ; les pièces comptables suivent les durées légales." })));
orgRouter.put('/retention', A.need('owner'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  await privacy.setRetention(req.org.id, String(b.kind || ''), b.days);
  await central.audit.record(req, 'privacy.retention_change', { orgId: req.org.id, target: String(b.kind).slice(0, 40), detail: `${Number(b.days)} jours` });
  res.json({ rules: await privacy.retentionRules(req.org.id) });
}));

orgRouter.get('/security', A.need('admin'), asyncHandler(async (req, res) => {
  const rows = await db.prepare("SELECT m.user_id AS \"userId\", m.role, u.name, u.totp_enabled AS twofa FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role IN ('owner', 'admin') ORDER BY m.id").all(req.org.id);
  res.json({ require2fa: Boolean(Number(req.org.require_2fa)), admins: rows.map((r) => ({ userId: r.userId, name: r.name, role: r.role, twofa: Boolean(Number(r.twofa)) })) });
}));
orgRouter.put('/require-2fa', A.need('owner'), asyncHandler(async (req, res) => {
  const on = Boolean((req.body || {}).enabled);
  const me = await db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (on && !Number(me.totp_enabled)) throw new HttpError(400, "Activez d'abord la double authentification sur votre propre compte (Sécurité du compte).");
  await db.prepare('UPDATE orgs SET require_2fa = ? WHERE id = ?').run(on ? 1 : 0, req.org.id);
  await central.audit.record(req, on ? 'org.require_2fa_on' : 'org.require_2fa_off', { orgId: req.org.id, severity: 'high' });
  res.json({ ok: true, require2fa: on });
}));

// Registre des accès aux données personnelles sensibles (paie, ressources humaines, exports) : qui, quoi, quand.
orgRouter.get('/access-log', A.need('admin'), asyncHandler(async (req, res) => {
  const rows = await central.audit.list({ orgId: req.org.id, action: 'pii.', limit: req.query.limit });
  const names = Object.fromEntries((await db.prepare('SELECT id, name FROM users WHERE id IN (SELECT user_id FROM org_members WHERE org_id = ?)').all(req.org.id)).map((u) => [u.id, u.name]));
  res.json({ entries: rows.map((r) => ({ id: r.id, at: r.at, who: r.actorType === 'user' ? names[r.actorId] || `Utilisateur ${r.actorId}` : r.actorType, action: r.action, target: r.target })) });
}));

module.exports = router;
