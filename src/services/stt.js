'use strict';
// Transcription des messages vocaux en texte (API compatible OpenAI : /audio/transcriptions, ex. Whisper).
const config = require('../config');
const { HttpError, oneLine } = require('../util');

const isConfigured = () => Boolean(config.stt.key);

/** Reconnaît le format audio d'après les premiers octets (on ne se fie pas au type annoncé). */
function sniffAudio(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'audio/webm', ext: 'webm' };
  if (b.toString('latin1', 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (b.toString('latin1', 4, 8) === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3' };
  return null;
}

async function transcribe(buf) {
  if (!isConfigured()) throw new HttpError(503, "La transcription vocale n'est pas activée. Écrivez votre message.");
  const fmt = sniffAudio(buf);
  if (!fmt) throw new HttpError(400, 'Format audio non reconnu.');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: fmt.mime }), `voix.${fmt.ext}`);
  fd.append('model', config.stt.model);
  if (config.stt.language) fd.append('language', config.stt.language);
  fd.append('response_format', 'json');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${config.stt.key}` }, body: fd, signal: ctl.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`STT HTTP ${res.status} : ${oneLine(String((data && data.error && (data.error.message || data.error)) || 'réponse inattendue'), 150)}`);
    return String((data && data.text) || '').trim();
  } finally { clearTimeout(timer); }
}

module.exports = { transcribe, isConfigured, sniffAudio };
