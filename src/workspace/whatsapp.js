'use strict';
// Webhook WhatsApp d'UNE organisation : /api/ws/public/whatsapp/<jeton de l'organisation>.
// Meta y envoie les messages reçus sur le numéro de l'organisation ; l'assistant commercial répond (texte, messages vocaux transcrits).
// Sécurité : la signature X-Hub-Signature-256 est vérifiée avec le « secret de l'application » de l'organisation (corps brut).
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const vault = require('../services/vault');
const waOrg = require('../services/waOrg');
const stt = require('../services/stt');
const inbound = require('./inbound');
const waOut = require('./wa-out');
const { safeEqual, log, makeSeen, oneLine, cleanText } = require('../util');

const router = express.Router();
const seen = makeSeen();
const hits = new Map();
const UNSUPPORTED = "Je peux lire les messages écrits et les messages vocaux, ainsi que les photos et les PDF. Pouvez-vous m'écrire ou m'enregistrer votre demande ?";

const orgOf = (token) => db.prepare('SELECT * FROM orgs WHERE intake_token = ?').get(String(token || '').slice(0, 80));

/** Limite anti-abus : 25 messages par 10 minutes pour un même numéro. */
function tooMany(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 600000);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 25;
}

function validSignature(req, secret) {
  const header = req.get('x-hub-signature-256') || '';
  if (!secret || !req.rawBody || !header.startsWith('sha256=')) return false;
  const a = Buffer.from(crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex'), 'utf8');
  const b = Buffer.from(header.slice(7), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Étape de vérification faite une fois dans le tableau de bord Meta.
router.get('/:token', (req, res) => {
  const org = orgOf(req.params.token);
  if (!org || !org.wa_verify || req.query['hub.mode'] !== 'subscribe' || !safeEqual(String(req.query['hub.verify_token'] || ''), org.wa_verify)) return res.status(403).type('text/plain').send('Vérification refusée');
  return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
});

router.post('/:token', express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }), (req, res) => {
  const org = orgOf(req.params.token);
  if (!org || !waOrg.isConnected(org)) return res.status(404).json({ error: 'Introuvable.' });
  if (!validSignature(req, vault.decrypt(org.wa_secret))) { log.warn(`WhatsApp (organisation ${org.id}) : signature invalide, message rejeté.`); return res.status(403).json({ error: 'Signature invalide.' }); }
  res.status(200).send('EVENT_RECEIVED'); // on répond vite à Meta, puis on traite
  const body = req.body;
  setImmediate(() => {
    processBody(org, body).catch((e) => log.warn(`WhatsApp (organisation ${org.id}) : erreur de traitement :`, oneLine(e.message, 200)));
  });
});

async function processBody(org, body) {
  if (!body || body.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (!v.metadata || String(v.metadata.phone_number_id) !== String(org.wa_phone_id)) continue; // pas notre numéro
      for (const m of v.messages || []) {
        try { await handleMessage(org, m); } catch (e) { log.warn('WhatsApp : message non traité :', oneLine(e.message, 200)); }
      }
    }
  }
}

async function handleMessage(org, m) {
  if (!m || seen(`${org.id}:${m.id}`)) return;
  const from = String(m.from || '').replace(/\D/g, '');
  if (!from || from.length > 15) return;
  if (tooMany(`${org.id}:${from}`)) return;

  let text = ''; let viaVoice = false; let attachment = null;
  if (m.type === 'text' && m.text && typeof m.text.body === 'string') text = cleanText(m.text.body, 1000);
  else if (m.type === 'audio' && m.audio && m.audio.id && stt.isConfigured()) {
    try { text = cleanText(await stt.transcribe(await waOrg.downloadMedia(org, m.audio.id)), 1000); viaVoice = true; } catch (e) { log.warn('WhatsApp : message vocal illisible :', oneLine(e.message, 160)); }
    if (!text) return void (await waOrg.sendText(org, from, "Je n'ai pas pu comprendre votre message vocal. Pouvez-vous le réécrire ou le renvoyer ?"));
  } else if ((m.type === 'image' && m.image && m.image.id) || (m.type === 'document' && m.document && m.document.id)) {
    // Photo ou document (PDF) : lu par l'IA (modèle capable de lire les images), conservé pour l'équipe.
    const doc = m.type === 'document' ? m.document : m.image;
    try { attachment = await waOrg.downloadMedia(org, doc.id); } catch (e) { log.warn('WhatsApp : pièce jointe illisible :', oneLine(e.message, 160)); return void (await waOrg.sendText(org, from, "Je n'ai pas pu ouvrir votre fichier. Pouvez-vous le renvoyer ou m'écrire votre demande ?")); }
    text = cleanText(doc.caption || '', 1000);
  } else {
    return void (await waOrg.sendText(org, from, UNSUPPORTED));
  }
  if (!text && !attachment) return;

  // Désabonnement : « STOP » arrête toute relance sortante ; « REPRENDRE » la réactive.
  const word = text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, '').trim();
  if (['stop', 'arret', 'arreter', 'desabonner', 'unsubscribe', 'stop relances'].includes(word)) {
    waOut.optOut(org.id, from);
    return void (await waOrg.sendText(org, from, "C'est noté : vous ne recevrez plus de messages de relance. Vous pouvez toujours nous écrire. Pour les réactiver, répondez REPRENDRE."));
  }
  if (['reprendre', 'start'].includes(word) && waOut.isOptedOut(org.id, from)) {
    waOut.optIn(org.id, from);
    return void (await waOrg.sendText(org, from, 'Merci, les messages de relance sont réactivés.'));
  }

  // Campagne : le lien WhatsApp d'une publicité préremplit « #nom-de-campagne » dans le premier message.
  let campaign = '';
  const tag = /#([A-Za-z0-9_-]{2,40})/.exec(text);
  if (tag) { campaign = tag[1]; text = cleanText(text.replace(tag[0], ''), 1000) || 'Bonjour'; }

  await inbound.receive(org, 'whatsapp', from, { campaign, text, viaVoice, attachment });
}

module.exports = router;
module.exports.processBody = processBody;
