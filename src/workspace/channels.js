'use strict';
// Une seule façon d'écrire à un client, quel que soit le canal (WhatsApp, Messenger, Instagram) : texte, fichier du catalogue, message vocal.
const waOrg = require('../services/waOrg');
const metaChat = require('../services/metaChat');
const signed = require('../services/signedUrl');
const tts = require('../services/tts');

const isConnected = (org, channel) => (channel === 'whatsapp' ? waOrg.isConnected(org) : metaChat.isConnected(org));
const sendText = async (org, chat, text) => (chat.channel === 'whatsapp' ? await waOrg.sendText(org, chat.contact, text) : await metaChat.sendText(org, chat.contact, text));

/** Message vocal : la réponse écrite est lue à voix haute (Ogg/Opus pour WhatsApp, AAC pour Messenger et Instagram). */
async function sendVoice(org, chat, text) {
  if (chat.channel === 'whatsapp') {
    const buf = await tts.speak(text, 'opus');
    if (waOrg.modeOf(org) === 'qr') return await waOrg.sendFile(org, chat.contact, 'audio', buf, 'audio/ogg');
    const id = await waOrg.uploadMedia(org, buf, 'audio/ogg', 'voix.ogg');
    return await waOrg.sendMedia(org, chat.contact, 'audio', id);
  }
  const buf = await tts.speak(text, 'aac');
  const url = signed.make('tmp', await signed.stash(org.id, 'audio/aac', buf));
  return await metaChat.sendAttachment(org, chat.contact, 'audio', url);
}
/** Fichier du catalogue sur Messenger / Instagram : Meta télécharge le fichier via un lien signé temporaire. */
const sendCatalogLink = async (org, chat, m) => await metaChat.sendAttachment(org, chat.contact, m.kind, signed.make('cm', m.id));

module.exports = { isConnected, sendText, sendVoice, sendCatalogLink, voiceReady: () => tts.isConfigured() };
