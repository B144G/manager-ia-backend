'use strict';
// Sous-application « Intégrations » (administrateurs) : clés d'API et webhooks sortants pour relier MANAGER-IA à Zapier, Make, n8n, un site web, etc.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const wh = require('../services/webhooks');
const { HttpError, asyncHandler } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('admin'));
const MAX_KEYS = 10; const MAX_HOOKS = 5;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

router.get('/', async (req, res) => {
  res.json({
    keys: await db.prepare('SELECT id, name, prefix, scope, last_used AS lastUsed, created_at AS createdAt FROM api_keys WHERE org_id = ? ORDER BY id').all(req.org.id),
    webhooks: (await db.prepare('SELECT id, url, events, active, fails, last_status AS lastStatus, last_at AS lastAt FROM webhooks_out WHERE org_id = ? ORDER BY id').all(req.org.id)).map((h) => ({ ...h, events: JSON.parse(h.events), active: Boolean(h.active) })),
    events: wh.EVENTS,
  });
});

router.post('/keys', async (req, res) => {
  const name = A.text((req.body || {}).name, 60, { required: true, msg: 'Donnez un nom à cette clé (ex. Zapier).' });
  const scope = A.oneOf((req.body || {}).scope, ['read', 'write'], 'read', 'Droits inconnus.');
  if ((await db.prepare('SELECT COUNT(*) c FROM api_keys WHERE org_id = ?').get(req.org.id)).c >= MAX_KEYS) throw new HttpError(403, `Vous pouvez avoir ${MAX_KEYS} clés au plus. Supprimez-en une.`);
  const key = 'mia_' + crypto.randomBytes(20).toString('hex');
  await db.prepare('INSERT INTO api_keys (org_id, name, prefix, key_hash, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, name, key.slice(0, 8), sha(key), scope, req.user.id, nowISO());
  await A.logActivity(req.org.id, req.user.id, 'integrations', `Clé d'API « ${name} » créée`);
  res.status(201).json({ key, note: "Copiez cette clé maintenant : elle ne sera plus jamais affichée." }); // seule fois où la clé en clair existe
});
router.delete('/keys/:id', async (req, res) => {
  await db.prepare('DELETE FROM api_keys WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  await A.logActivity(req.org.id, req.user.id, 'integrations', "Clé d'API supprimée");
  res.json({ ok: true });
});

router.post('/webhooks', async (req, res) => {
  const b = req.body || {};
  const bad = wh.urlProblem(b.url); if (bad) throw new HttpError(400, bad);
  const events = [...new Set(Array.isArray(b.events) ? b.events.map(String) : [])].filter((e) => e !== 'test' && wh.EVENTS[e]);
  if (!events.length) throw new HttpError(400, 'Choisissez au moins un événement.');
  if ((await db.prepare('SELECT COUNT(*) c FROM webhooks_out WHERE org_id = ?').get(req.org.id)).c >= MAX_HOOKS) throw new HttpError(403, `Vous pouvez avoir ${MAX_HOOKS} webhooks au plus.`);
  const secret = crypto.randomBytes(24).toString('hex');
  const id = (await db.prepare('INSERT INTO webhooks_out (org_id, url, events, secret, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, String(b.url).trim(), JSON.stringify(events), secret, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'integrations', 'Webhook ajouté');
  res.status(201).json({ id: Number(id), secret, note: "Conservez ce secret : il sert à vérifier que les messages viennent bien de MANAGER-IA (en-tête X-MIA-Signature). Il ne sera plus affiché." });
});
router.put('/webhooks/:id', async (req, res) => {
  const h = await db.prepare('SELECT * FROM webhooks_out WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!h) throw new HttpError(404, 'Webhook introuvable.');
  await db.prepare('UPDATE webhooks_out SET active = ?, fails = CASE WHEN ? = 1 THEN 0 ELSE fails END WHERE id = ?').run((req.body || {}).active ? 1 : 0, (req.body || {}).active ? 1 : 0, h.id);
  res.json({ ok: true });
});
router.delete('/webhooks/:id', async (req, res) => {
  await db.prepare('DELETE FROM webhooks_out WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  res.json({ ok: true });
});
router.post('/webhooks/:id/test', asyncHandler(async (req, res) => {
  const h = await db.prepare('SELECT * FROM webhooks_out WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!h) throw new HttpError(404, 'Webhook introuvable.');
  const r = await wh.deliver(h, 'test', { message: 'Test depuis MANAGER-IA', organisation: req.org.name });
  res.json({ ok: r.ok, status: r.status });
}));

module.exports = router;
