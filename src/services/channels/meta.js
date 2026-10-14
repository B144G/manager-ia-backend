'use strict';
// Agent de service client sur Messenger et Instagram (API "Send" de Meta).
const config = require('../../config');
const agent = require('../agent');
const { log, makeSeen, oneLine, fetchJson } = require('../../util');

const seen = makeSeen();

async function send(psid, message) {
  if (!config.meta.pageToken) throw new Error('PAGE_ACCESS_TOKEN absent');
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(config.meta.pageToken)}`;
  const r = await fetchJson(url, { method: 'POST', body: { recipient: { id: psid }, message } });
  if (!r.ok) {
    const msg = (r.data && r.data.error && r.data.error.message) || 'réponse inattendue';
    throw new Error(`Meta HTTP ${r.status} : ${oneLine(msg, 200)}`); // l'URL (et le jeton) n'est jamais journalisée
  }
}

const sendText = (psid, text) => send(psid, { text: String(text).slice(0, 1900) });
const sendMedia = (psid, type, url) =>
  send(psid, { attachment: { type: type === 'video' ? 'video' : 'image', payload: { url, is_reusable: true } } });

async function handleEvent(channel, ev) {
  const msg = ev && ev.message;
  const psid = ev && ev.sender && ev.sender.id;
  if (!msg || !psid || msg.is_echo || seen(msg.mid)) return;

  let result;
  if (typeof msg.text === 'string' && msg.text.trim()) {
    result = await agent.reply({ channel, contactId: psid, text: msg.text });
  } else if (Array.isArray(msg.attachments) && msg.attachments.length) {
    result = { text: 'Merci pour votre message ! Pour le moment je ne peux lire que les messages écrits. Pouvez-vous me l\'écrire en texte ?', media: [] };
  }
  if (!result) return;

  await sendText(psid, result.text);
  for (const m of result.media) {
    try {
      await sendMedia(psid, m.type, m.url);
    } catch (e) {
      log.warn('Envoi du média Messenger/Instagram échoué :', oneLine(e.message, 200));
    }
  }
}

async function processBody(body) {
  if (!body || !['page', 'instagram'].includes(body.object)) return;
  const channel = body.object === 'instagram' ? 'instagram' : 'messenger';
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      try {
        await handleEvent(channel, ev);
      } catch (e) {
        log.warn(`Traitement message ${channel} échoué :`, oneLine(e.message, 200));
      }
    }
  }
}

module.exports = { processBody };
