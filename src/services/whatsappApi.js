'use strict';
// Envoi de messages via l'API WhatsApp Business Cloud (Meta). Aucun secret n'est journalisé.
const config = require('../config');
const { fetchJson, oneLine } = require('../util');

const GRAPH = 'https://graph.facebook.com/v20.0';

const isConfigured = () => Boolean(config.whatsapp.phoneId && config.whatsapp.token);

async function post(payload) {
  if (!isConfigured()) throw new Error('WhatsApp non configuré');
  const r = await fetchJson(`${GRAPH}/${encodeURIComponent(config.whatsapp.phoneId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    body: { messaging_product: 'whatsapp', ...payload },
  });
  if (!r.ok) {
    const msg = (r.data && r.data.error && r.data.error.message) || 'réponse inattendue';
    throw new Error(`WhatsApp HTTP ${r.status} : ${oneLine(msg, 200)}`);
  }
  return r.data;
}

/** Message "modèle" (obligatoire hors fenêtre de 24 h). Variable {{1}} = text. */
async function sendTemplate(to, text) {
  // Meta refuse les retours à la ligne / tabulations dans une variable de modèle.
  const clean = oneLine(text, 600);
  return await post({
    to,
    type: 'template',
    template: {
      name: config.whatsapp.template,
      language: { code: 'fr' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: clean }] }],
    },
  });
}

/** Message texte libre (réponses aux clients, dans la fenêtre de 24 h). */
const sendText = async (to, body) => await post({ to, type: 'text', text: { body: String(body).slice(0, 4000), preview_url: false } });

/** Image ou vidéo par lien public https. */
async function sendMedia(to, type, link, caption) {
  const t = type === 'video' ? 'video' : 'image';
  const media = { link };
  if (caption) media.caption = String(caption).slice(0, 1000);
  return await post({ to, type: t, [t]: media });
}

module.exports = { isConfigured, sendTemplate, sendText, sendMedia };
