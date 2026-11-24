'use strict';
// Chat interne : position en direct, ACTIVÉE LIBREMENT par chaque employé (jamais imposée, ni par un responsable ni par l'administrateur).
//  - consentement explicite à l'activation ; désactivation à tout moment = les coordonnées sont effacées immédiatement ;
//  - la position n'est envoyée que par l'appareil de la personne, tant qu'elle est connectée au chat avec la carte ouverte ;
//  - visible seulement des membres de la même entreprise, et seulement si la personne est EN LIGNE (position de moins de 5 minutes) ;
//  - les positions plus anciennes de 24 h sont effacées automatiquement. Activations et désactivations sont inscrites au journal d'audit.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const hub = require('./chat-hub');
const L = require('./chat-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const FRESH_MS = 5 * 60 * 1000;
const posLimit = L.userLimit('geopos', 60 * 1000, 20, 'Positions envoyées trop souvent.');

router.get('/me', async (req, res) => {
  const r = await db.prepare('SELECT enabled, consent_at FROM ci_geo WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  res.json({ enabled: Boolean(r && Number(r.enabled) === 1), consentAt: r ? r.consent_at : null });
});
router.put('/me', L.userLimit('geotoggle', 60 * 1000, 10), async (req, res) => {
  const b = req.body || {};
  const on = Boolean(b.enabled);
  if (on && b.consent !== true) throw new HttpError(400, "Confirmez que vous acceptez que vos collègues de l'entreprise voient votre position tant que vous êtes connecté(e) au chat.");
  if (on) await db.prepare('INSERT INTO ci_geo (org_id, user_id, enabled, consent_at) VALUES (?, ?, 1, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET enabled = 1, consent_at = EXCLUDED.consent_at').run(req.org.id, req.user.id, nowISO());
  else await db.prepare('UPDATE ci_geo SET enabled = 0, lat = NULL, lng = NULL, accuracy = 0, updated_at = NULL WHERE org_id = ? AND user_id = ?').run(req.org.id, req.user.id);
  await W.audit(req, 'chat_geo', req.user.id, on ? 'enable' : 'disable', null, { enabled: on });
  hub.publishOrg(req.org.id, 'geo', { userId: req.user.id, enabled: on });
  res.json({ enabled: on });
});
router.post('/position', posLimit, async (req, res) => {
  const b = req.body || {};
  const lat = Number(b.lat); const lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Position invalide.');
  const r = await db.prepare('UPDATE ci_geo SET lat = ?, lng = ?, accuracy = ?, updated_at = ? WHERE org_id = ? AND user_id = ? AND enabled = 1').run(Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, Math.min(Math.max(Math.round(Number(b.accuracy) || 0), 0), 100000), nowISO(), req.org.id, req.user.id);
  if (!r.changes) throw new HttpError(403, "Le partage de votre position n'est pas activé.");
  hub.publishOrg(req.org.id, 'geo', { userId: req.user.id, moved: true }, req.user.id);
  res.json({ ok: true });
});
/** Personnes qui partagent leur position ET sont connectées. */
router.get('/people', async (req, res) => {
  const since = new Date(Date.now() - FRESH_MS).toISOString();
  const rows = await db.prepare(`SELECT g.user_id, g.lat, g.lng, g.accuracy, g.updated_at, u.name, om.title FROM ci_geo g JOIN users u ON u.id = g.user_id JOIN org_members om ON om.user_id = g.user_id AND om.org_id = g.org_id
    WHERE g.org_id = ? AND g.enabled = 1 AND g.lat IS NOT NULL AND g.updated_at >= ? ORDER BY u.name`).all(req.org.id, since);
  const direct = new Map((await db.prepare("SELECT c.direct_key, c.id FROM ci_conversations c JOIN ci_members m ON m.conv_id = c.id AND m.user_id = ? AND m.left_at IS NULL WHERE c.org_id = ? AND c.kind = 'direct'").all(req.user.id, req.org.id)).map((r) => [r.direct_key, Number(r.id)]));
  res.json({ people: rows.filter((r) => Number(r.user_id) === req.user.id || hub.isOnline(req.org.id, Number(r.user_id))).map((r) => ({ userId: Number(r.user_id), name: r.name, title: r.title, lat: r.lat, lng: r.lng, accuracy: Number(r.accuracy), updatedAt: r.updated_at, me: Number(r.user_id) === req.user.id, directId: direct.get(L.directKey(req.user.id, Number(r.user_id))) || null })) });
});
async function purge() { await db.prepare("UPDATE ci_geo SET lat = NULL, lng = NULL, accuracy = 0 WHERE updated_at < ?").run(new Date(Date.now() - 24 * 3600 * 1000).toISOString()); }
module.exports = { router, purge };
void A;
