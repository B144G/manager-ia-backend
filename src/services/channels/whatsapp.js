'use strict';
// Agent de service client sur WhatsApp : traite les messages reçus par le webhook.
const agent = require('../agent');
const wa = require('../whatsappApi');
const { log, makeSeen, oneLine } = require('../../util');

const seen = makeSeen();
const NON_TEXT = ['audio', 'image', 'video', 'document', 'sticker', 'voice'];
const NON_TEXT_REPLY = 'Merci pour votre message ! Pour le moment je ne peux lire que les messages écrits. Pouvez-vous me l\'écrire en texte ?';

async function handleMessage(m) {
  if (!m || seen(m.id)) return;
  const from = String(m.from || '').replace(/\D/g, '');
  if (!from) return;

  let result;
  if (m.type === 'text' && m.text && typeof m.text.body === 'string') {
    result = await agent.reply({ channel: 'whatsapp', contactId: from, text: m.text.body });
  } else if (NON_TEXT.includes(m.type)) {
    result = { text: NON_TEXT_REPLY, media: [] };
  }
  if (!result) return;

  await wa.sendText(from, result.text);
  for (const media of result.media) {
    try {
      await wa.sendMedia(from, media.type, media.url, media.caption);
    } catch (e) {
      log.warn('Envoi du média WhatsApp échoué :', oneLine(e.message, 200));
    }
  }
}

/** Parcourt le corps du webhook et traite chaque message (un par un). */
async function processBody(body) {
  if (!body || body.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const m of value.messages || []) {
        try {
          await handleMessage(m);
        } catch (e) {
          log.warn('Traitement message WhatsApp échoué :', oneLine(e.message, 200));
        }
      }
    }
  }
}

module.exports = { processBody };
