'use strict';
// Administration : gestion des clients (liste enrichie, fiche, suspension, notes, connexions) et alertes d'activité suspecte.
// Monté dans routes/admin.js APRÈS requireAdmin. La fiche ne renvoie jamais de contenu de message ni de donnée métier (voir services/clients.js).
const express = require('express');
const { db } = require('../db');
const central = require('../security');
const accounts = require('../services/accounts');
const clients = require('../services/clients');
const alerts = require('../services/alerts');
const { HttpError } = require('../util');

const router = express.Router();
const uid = (req) => { const id = parseInt(req.params.id, 10); if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Identifiant invalide.'); return id; };

// Pastilles du menu : paiements à valider, alertes ouvertes, demandes de contact. Léger : appelé toutes les minutes par la page.
router.get('/summary', async (req, res) => {
  const one = async (sql) => Number((await db.prepare(sql).get()).n);
  const a = await alerts.openCounts();
  res.json({
    payments: await one("SELECT COUNT(*) AS n FROM payments WHERE status = 'awaiting_validation'"),
    leads: await one('SELECT COUNT(*) AS n FROM leads WHERE handled = 0'),
    alerts: a.open, alertsHigh: a.high,
    suspended: await one('SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NOT NULL'),
  });
});

router.get('/clients', async (req, res) => res.json(await clients.listClients(req.query)));
router.get('/clients/:id', async (req, res) => res.json(await clients.clientDetail(uid(req))));

router.post('/clients/:id/suspend', async (req, res) => res.json(await accounts.suspend(uid(req), (req.body || {}).reason, req)));
router.post('/clients/:id/reactivate', async (req, res) => res.json(await accounts.reactivate(uid(req), req)));
router.post('/clients/:id/notes', async (req, res) => res.status(201).json(await accounts.addNote(uid(req), (req.body || {}).text)));
router.delete('/clients/:id/notes/:noteId', async (req, res) => {
  const r = await db.prepare('DELETE FROM admin_notes WHERE id = ? AND user_id = ?').run(parseInt(req.params.noteId, 10) || 0, uid(req));
  if (!r.changes) throw new HttpError(404, 'Note introuvable.');
  res.json({ ok: true });
});

// Fermer UNE connexion précise (identifiant opaque) ou toutes les connexions d'un client.
router.post('/clients/:id/sessions/:handle/revoke', async (req, res) => {
  const id = uid(req);
  await clients.revokeSession(id, req.params.handle);
  await accounts.recordEvent(id, 'connexions_fermees', '1 appareil');
  await central.audit.record(req, 'admin.user_session_revoke', { target: `user:${id}`, severity: 'warn', detail: '1 session' });
  res.json({ ok: true });
});
router.post('/clients/:id/sessions/revoke-all', async (req, res) => {
  const id = uid(req);
  const n = await central.sessions.revokeAllForUser(id, '', "fermée par l'administrateur");
  await accounts.recordEvent(id, 'connexions_fermees', `${n} appareil(s)`);
  await central.audit.record(req, 'admin.user_sessions_revoke', { target: `user:${id}`, severity: 'warn', detail: `${n} session(s)` });
  res.json({ ok: true, closed: n });
});

// Alertes d'activité suspecte
router.get('/alerts', async (req, res) => {
  const status = ['open', 'handled', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'open';
  res.json({ alerts: await alerts.list({ status, limit: req.query.limit }), counts: await alerts.openCounts(), thresholds: alerts.thresholds() });
});
router.post('/alerts/:id/handle', async (req, res) => {
  if (!(await alerts.handle(uid(req)))) throw new HttpError(404, 'Alerte introuvable ou déjà traitée.');
  res.json({ ok: true });
});

module.exports = router;
