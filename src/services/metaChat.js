'use strict';
// Messenger et Instagram (messages privés) d'UNE organisation, via l'API Graph de Meta : le jeton de la Page est celui de l'organisation (chiffré).
const config = require('../config');
const vault = require('./vault');
const { fetchJson, oneLine } = require('../util');

const isConnected = (org) => Boolean(org.fb_page_id && vault.decrypt(org.fb_token) && vault.decrypt(org.fb_secret));
const fail = (r, what) => new Error(`${what} HTTP ${r.status} : ${oneLine(String((r.data && r.data.error && (r.data.error.message || r.data.error)) || 'réponse inattendue'), 160)}`);

/** Répond à une personne qui a écrit à la Page (Messenger) ou au compte Instagram professionnel lié (dans les 24 h de son message). */
async function sendText(org, recipientId, text) {
  const token = vault.decrypt(org.fb_token);
  if (!org.fb_page_id || !token) throw new Error('Messenger non connecté');
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(org.fb_page_id)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: { recipient: { id: String(recipientId) }, messaging_type: 'RESPONSE', message: { text: String(text).slice(0, 1900) } },
  });
  if (!r.ok) throw fail(r, 'Messenger');
  return r.data;
}
/** Envoie une image, une vidéo ou un audio (Messenger / Instagram) : Meta télécharge le fichier à l'adresse donnée (lien signé temporaire). */
async function sendAttachment(org, recipientId, type, url) {
  const token = vault.decrypt(org.fb_token);
  if (!org.fb_page_id || !token) throw new Error('Messenger non connecté');
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(org.fb_page_id)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: { recipient: { id: String(recipientId) }, messaging_type: 'RESPONSE', message: { attachment: { type, payload: { url, is_reusable: false } } } },
  });
  if (!r.ok) throw fail(r, 'Messenger');
  return r.data;
}
/** Télécharge une pièce jointe reçue (5 Mo au plus). Seules les adresses de Meta sont acceptées (protection contre les adresses piégées). */
async function downloadUrl(rawUrl) {
  let u; try { u = new URL(rawUrl); } catch { throw new Error('Adresse de pièce jointe invalide'); }
  const okHost = /(^|\.)(fbcdn\.net|cdninstagram\.com|fbsbx\.com|facebook\.com|instagram\.com)$/i.test(u.hostname);
  const test = process.env.NODE_ENV !== 'production' && process.env.META_MEDIA_ALLOW_ANY === '1';
  if (!(test || (u.protocol === 'https:' && okHost))) throw new Error('Pièce jointe refusée (adresse non reconnue)');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(u, { signal: ctl.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`Pièce jointe HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('Pièce jointe trop volumineuse');
    return buf;
  } finally { clearTimeout(timer); }
}

/** Nom de la Page : sert à tester la connexion. */
async function profile(org) {
  const token = vault.decrypt(org.fb_token);
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(org.fb_page_id)}?fields=name`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw fail(r, 'Messenger');
  return { name: String((r.data && r.data.name) || '') };
}
module.exports = { isConnected, sendText, sendAttachment, downloadUrl, profile };
