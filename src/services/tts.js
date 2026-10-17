'use strict';
// Synthèse vocale : transforme une réponse écrite en message vocal (API compatible OpenAI : /audio/speech).
const config = require('../config');
const { oneLine } = require('../util');

const isConfigured = () => Boolean(config.tts.key);
/** format : 'opus' (WhatsApp : message vocal Ogg/Opus) ou 'aac' (Messenger, Instagram). Renvoie un Buffer. */
async function speak(text, format) {
  if (!isConfigured()) throw new Error('Synthèse vocale non configurée');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(`${config.tts.baseUrl}/audio/speech`, {
      method: 'POST', headers: { authorization: `Bearer ${config.tts.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.tts.model, voice: config.tts.voice, input: String(text).slice(0, 1500), response_format: format }), signal: ctl.signal,
    });
    if (!res.ok) { const j = await res.json().catch(() => null); throw new Error(`TTS HTTP ${res.status} : ${oneLine(String((j && j.error && (j.error.message || j.error)) || 'réponse inattendue'), 150)}`); }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 6 * 1024 * 1024) throw new Error('TTS : audio vide ou trop long');
    return buf;
  } finally { clearTimeout(timer); }
}
module.exports = { speak, isConfigured };
