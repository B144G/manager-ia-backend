'use strict';
// API WhatsApp Business Cloud (Meta) pour UNE organisation : les identifiants sont ceux de l'organisation (chiffrés dans la base).
const config = require('../config');
const vault = require('./vault');
const { fetchJson, oneLine } = require('../util');

const creds = (org) => ({ phoneId: org.wa_phone_id, token: vault.decrypt(org.wa_token) });
const isConnected = (org) => Boolean(org.wa_phone_id && vault.decrypt(org.wa_token) && vault.decrypt(org.wa_secret));
const fail = (r, what) => new Error(`${what} HTTP ${r.status} : ${oneLine(String((r.data && r.data.error && (r.data.error.message || r.data.error)) || 'réponse inattendue'), 160)}`);

async function sendText(org, to, body) {
  const c = creds(org);
  if (!c.phoneId || !c.token) throw new Error('WhatsApp non connecté');
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(c.phoneId)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${c.token}` },
    body: { messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: 'text', text: { body: String(body).slice(0, 4000), preview_url: false } },
  });
  if (!r.ok) throw fail(r, 'WhatsApp');
  return r.data;
}

/** Numéro affiché et nom vérifié du compte : sert à tester la connexion. */
async function profile(org) {
  const c = creds(org);
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(c.phoneId)}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${c.token}` } });
  if (!r.ok) throw fail(r, 'WhatsApp');
  return { number: String((r.data && r.data.display_phone_number) || ''), name: String((r.data && r.data.verified_name) || '') };
}

/** Télécharge un média (message vocal) reçu : 5 Mo au plus. */
async function downloadMedia(org, mediaId) {
  const c = creds(org);
  const meta = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(mediaId)}`, { headers: { Authorization: `Bearer ${c.token}` } });
  if (!meta.ok || !meta.data || !meta.data.url) throw fail(meta, 'Média WhatsApp');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(meta.data.url, { headers: { Authorization: `Bearer ${c.token}` }, signal: ctl.signal });
    if (!res.ok) throw new Error(`Média WhatsApp HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('Média trop volumineux');
    return buf;
  } finally { clearTimeout(timer); }
}

module.exports = { isConnected, sendText, profile, downloadMedia };
