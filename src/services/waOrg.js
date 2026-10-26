'use strict';
// API WhatsApp Business Cloud (Meta) pour UNE organisation : les identifiants sont ceux de l'organisation (chiffrés dans la base).
const config = require('../config');
const vault = require('./vault');
const { fetchJson, oneLine } = require('../util');

const creds = (org) => ({ phoneId: org.wa_phone_id, token: vault.decrypt(org.wa_token) });
const waWeb = () => require('./waWeb');
/** Canal de l'organisation : 'meta' (API officielle, par défaut) ou 'qr' (appareil connecté par QR code). */
const modeOf = (org) => (org && org.wa_mode === 'qr' ? 'qr' : 'meta');
const metaConnected = (org) => Boolean(org.wa_phone_id && vault.decrypt(org.wa_token) && vault.decrypt(org.wa_secret));
const isConnected = (org) => (modeOf(org) === 'qr' ? waWeb().isOpen(org.id) : metaConnected(org));
const NO_TPL = new Error('Les modèles de message de Meta ne sont pas disponibles avec la connexion par QR code.');
const fail = (r, what) => {
  const err = new Error(`${what} HTTP ${r.status} : ${oneLine(String((r.data && r.data.error && (r.data.error.message || r.data.error)) || 'réponse inattendue'), 160)}`);
  // Code d'erreur de Meta (ex. 131047 = fenêtre de 24 h fermée) : permet de distinguer les refus, sans jamais exposer de secret.
  if (r.data && r.data.error && typeof r.data.error === 'object') { err.metaCode = Number(r.data.error.code) || 0; err.metaSubcode = Number(r.data.error.error_subcode) || 0; }
  err.httpStatus = r.status;
  return err;
};

async function sendText(org, to, body) {
  if (modeOf(org) === 'qr') return await waWeb().sendText(org.id, to, body);
  const c = creds(org);
  if (!c.phoneId || !c.token) throw new Error('WhatsApp non connecté');
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(c.phoneId)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${c.token}` },
    body: { messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: 'text', text: { body: String(body).slice(0, 4000), preview_url: false } },
  });
  if (!r.ok) throw fail(r, 'WhatsApp');
  return r.data;
}

/** Message « modèle » (template) approuvé par Meta : seul moyen d'écrire à un client plus de 24 h après son dernier message. */
async function sendTemplate(org, to, name, language, params) {
  if (modeOf(org) === 'qr') throw NO_TPL;
  const c = creds(org);
  if (!c.phoneId || !c.token) throw new Error('WhatsApp non connecté');
  const template = { name, language: { code: language || 'fr' } };
  if (params && params.length) template.components = [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t).replace(/[\n\t]+/g, ' ').slice(0, 300) })) }];
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(c.phoneId)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${c.token}` },
    body: { messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: 'template', template },
  });
  if (!r.ok) throw fail(r, 'WhatsApp');
  return r.data;
}

/** Envoie un fichier à Meta (images 5 Mo, vidéos 16 Mo au plus) et renvoie son identifiant, utilisable 30 jours pour tous les destinataires. */
async function uploadMedia(org, buf, mime, filename) {
  const c = creds(org);
  if (!c.phoneId || !c.token) throw new Error('WhatsApp non connecté');
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mime);
  fd.append('file', new Blob([buf], { type: mime }), filename || 'fichier');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const res = await fetch(`${config.meta.graphUrl}/${encodeURIComponent(c.phoneId)}/media`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}` }, body: fd, signal: ctl.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.id) throw fail({ status: res.status, data }, 'WhatsApp (envoi de fichier)');
    return String(data.id);
  } finally { clearTimeout(timer); }
}
/** Envoie une image ou une vidéo déjà envoyée à Meta (kind = 'image' ou 'video'), avec une légende facultative. */
async function sendMedia(org, to, kind, mediaId, caption) {
  if (modeOf(org) === 'qr') throw new Error('Envoi par identifiant Meta impossible en mode QR code.');
  const c = creds(org);
  if (!c.phoneId || !c.token) throw new Error('WhatsApp non connecté');
  const body = { messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: kind, [kind]: { id: mediaId } };
  if (caption) body[kind].caption = String(caption).slice(0, 1000);
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(c.phoneId)}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}` }, body });
  if (!r.ok) throw fail(r, 'WhatsApp');
  return r.data;
}


/** Abonne l'application de Meta au compte WhatsApp Business (WABA) : sans cela, Meta n'envoie pas les messages reçus au webhook. */
async function subscribeApp(org) {
  const waba = String(org.wa_waba || '').replace(/\D/g, '');
  const token = vault.decrypt(org.wa_token);
  if (!waba || !token) throw new Error("Identifiant du compte WhatsApp Business ou jeton manquant");
  const r = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(waba)}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: {} });
  if (!r.ok) throw fail(r, 'Abonnement');
  const l = await fetchJson(`${config.meta.graphUrl}/${encodeURIComponent(waba)}/subscribed_apps`, { headers: { Authorization: `Bearer ${token}` } });
  const apps = l.ok && l.data && Array.isArray(l.data.data) ? l.data.data.map((a) => oneLine(String((a.whatsapp_business_api_data && a.whatsapp_business_api_data.name) || a.name || a.id || 'application'), 60)) : [];
  return { subscribed: Boolean(r.data && r.data.success !== false), apps };
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

/** Envoie un fichier dont on a le contenu (mode QR code). kind : image, video, audio (message vocal). */
const sendFile = async (org, to, kind, buf, mime, caption) => await waWeb().sendFile(org.id, to, kind, buf, mime, caption);

module.exports = { modeOf, sendFile, subscribeApp, isConnected, sendText, sendTemplate, uploadMedia, sendMedia, profile, downloadMedia };
