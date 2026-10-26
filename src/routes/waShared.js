'use strict';
// Webhook WhatsApp COMMUN à toutes les organisations (connexion en un clic) : /api/webhooks/whatsapp.
// Meta y envoie les messages de tous les numéros connectés ; chaque message est rangé dans l'organisation propriétaire du numéro
// (value.metadata.phone_number_id = orgs.wa_phone_id), puis traité exactement comme par le webhook de l'organisation.
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const limits = require('../middleware/limits');
const wa = require('../workspace/whatsapp');
const { safeEqual, log, oneLine } = require('../util');

const router = express.Router();
const limit = limits.make(60 * 1000, 600, 'Trop de requêtes.');

function validSignature(req) {
  const header = req.get('x-hub-signature-256') || '';
  if (!config.meta.appSecret || !req.rawBody || !header.startsWith('sha256=')) return false;
  const a = Buffer.from(crypto.createHmac('sha256', config.meta.appSecret).update(req.rawBody).digest('hex'), 'utf8');
  const b = Buffer.from(header.slice(7), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/', limit, (req, res) => {
  const t = String(req.query['hub.verify_token'] || '');
  if (req.query['hub.mode'] === 'subscribe' && config.meta.webhookVerifyToken && safeEqual(t, config.meta.webhookVerifyToken)) return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
  return res.status(403).type('text/plain').send('Vérification refusée');
});

router.post('/', limit, express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }), (req, res) => {
  if (!config.meta.appSecret) return res.status(503).json({ error: 'Webhook non configuré.' });
  if (!validSignature(req)) { log.warn('Webhook WhatsApp commun : signature invalide, message rejeté.'); require('../security').abuse.strike(req, 'bad_signature'); return res.status(403).json({ error: 'Signature invalide.' }); }
  res.status(200).send('EVENT_RECEIVED');
  const body = req.body;
  setImmediate(() => { handleBody(body).catch((e) => log.warn('Webhook WhatsApp commun : erreur de traitement :', oneLine(e.message, 200))); });
});

async function handleBody(body) {
  if (!body || body.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const pid = v.metadata && String(v.metadata.phone_number_id || '');
      if (!pid || !/^\d{1,30}$/.test(pid)) continue;
      const org = await db.prepare("SELECT * FROM orgs WHERE wa_phone_id = ? ORDER BY id LIMIT 1").get(pid);
      if (!org) { if ((v.messages || []).length) log.info('Webhook WhatsApp commun : message reçu pour un numéro inconnu, ignoré.'); continue; }
      try { await wa.handleChange(org, v); } catch (e) { log.warn(`Webhook WhatsApp commun (organisation ${org.id}) : erreur :`, oneLine(e.message, 200)); }
    }
  }
}

module.exports = router;
