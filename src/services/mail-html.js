'use strict';
// E-mails de la plateforme (compte, mot de passe, paiement, alertes) : une version HTML simple avec le logo MABAH au-dessus du texte (créé par scripts/apply-logo.mjs).
// Le texte brut reste envoyé tel quel (c'est lui que lisent les clients de messagerie sans HTML). Le logo est lu sur l'adresse publique du site.
const PRODUCT = require('./product');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = () => String(process.env.SITE_URL || PRODUCT.publicUrl).replace(/\/+$/, '');

/** Transforme un texte brut en HTML : paragraphes, retours à la ligne, liens cliquables. */
function body(text) {
  return String(text == null ? '' : text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0b5fd6">$1</a>').replace(/\n/g, '<br>')}</p>`).join('');
}

/** HTML d'un e-mail de la plateforme (sujet, texte brut). */
function platform(subject, text) {
  return '<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.55">'
    + '<div style="max-width:600px;margin:0 auto;padding:20px 16px"><div style="background:#ffffff;border:1px solid #dfe3ec;border-radius:14px;padding:22px">'
    + `<div style="margin:0 0 16px"><img src="${esc(base())}/assets/icons/icon-192.png" width="40" height="40" alt="${esc(PRODUCT.name)}" style="vertical-align:middle;border:1px solid #dfe3ec;border-radius:9px"> <span style="font-size:20px;font-weight:700;letter-spacing:-.02em;vertical-align:middle;margin-left:8px">${esc(PRODUCT.name)}</span></div>`
    + body(text) + '</div></div></body></html>';
}

module.exports = { platform, body };
