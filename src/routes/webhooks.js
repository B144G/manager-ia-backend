'use strict';
// Webhooks Meta : WhatsApp (/webhooks/whatsapp) et Messenger + Instagram (/webhooks/meta).
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { safeEqual, log } = require('../util');
const whatsappChannel = require('../services/channels/whatsapp');
const metaChannel = require('../services/channels/meta');

const router = express.Router();

// Ici on garde le corps BRUT (nécessaire pour vérifier la signature de Meta).
router.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

/** Vérifie l'en-tête X-Hub-Signature-256 avec le secret de l'app Meta, sur le corps brut. */
function validSignature(req) {
  const secret = config.meta.appSecret;
  const header = req.get('x-hub-signature-256') || '';
  if (!secret || !req.rawBody || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const given = header.slice(7);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Vérification de l'adresse du webhook (étape faite une fois dans le tableau de bord Meta).
function verifyHandler(req, res) {
  const token = String(req.query['hub.verify_token'] || '');
  if (req.query['hub.mode'] === 'subscribe' && config.meta.verifyToken && safeEqual(token, config.meta.verifyToken)) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  return res.status(403).type('text/plain').send('Vérification refusée');
}

function receiver(processBody, label) {
  return (req, res) => {
    if (!config.meta.appSecret) {
      log.warn(`Webhook ${label} reçu mais META_APP_SECRET n'est pas défini : message ignoré.`);
      return res.status(503).json({ error: 'Webhook non configuré.' });
    }
    if (!validSignature(req)) {
      log.warn(`Webhook ${label} : signature invalide, message rejeté.`);
      return res.status(403).json({ error: 'Signature invalide.' });
    }
    res.status(200).send('EVENT_RECEIVED'); // on répond vite à Meta...
    const body = req.body;
    setImmediate(() => {
      // ... puis on traite en arrière-plan.
      processBody(body).catch((e) => log.warn(`Webhook ${label} : erreur de traitement :`, String(e.message).slice(0, 200)));
    });
  };
}

router.get('/whatsapp', verifyHandler);
router.post('/whatsapp', receiver(whatsappChannel.processBody, 'WhatsApp'));
router.get('/meta', verifyHandler);
router.post('/meta', receiver(metaChannel.processBody, 'Messenger/Instagram'));

module.exports = router;
