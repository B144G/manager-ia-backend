'use strict';
// Client Campay (agrégateur MTN Mobile Money / Orange Money) — UN SEUL fichier, aucune logique d'abonnement ici.
// Champs et chemins : documentation officielle Campay (collection Postman « CamPay API », lue le 2026-11-18) :
//   POST /token/            {username, password} -> {token, expires_in}      (ou jeton permanent de l'application)
//   POST /collect/          {amount, currency, from, description, external_reference, external_user} -> {reference, ussd_code, operator}
//   GET  /transaction/{reference}/ -> {reference, status PENDING|SUCCESSFUL|FAILED, amount, currency, operator, code, operator_reference, external_reference, reason, ...}
//   En-tête d'autorisation : « Authorization: Token <jeton> » (jeton temporaire OU permanent).
//   Webhook : GET (paramètres d'adresse) ou POST (JSON) ; champ « signature » = JWT signé HS256 avec la clé de webhook de l'application ; envoyé UNE seule fois.
// Points NON vérifiables sans compte réel (voir docs/paiement-campay.md) : adresse de production, contenu (claims) du JWT, durée de vie d'une demande en attente.
const crypto = require('crypto');
const config = require('../config');

const cfg = () => config.campay;
let cache = { token: null, exp: 0 };

class CampayError extends Error {
  constructor(message, { status = 0, code = '', network = false } = {}) { super(message); this.name = 'CampayError'; this.status = status; this.code = code; this.network = network; }
}

async function call(path, { method = 'GET', body, auth = true, timeout = 15000, retryAuth = true } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) headers.authorization = `Token ${await getToken()}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res; let text;
  try {
    res = await fetch(`${cfg().baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    text = await res.text();
  } catch (e) {
    throw new CampayError(`Campay injoignable (${e.name === 'AbortError' ? 'délai dépassé' : 'réseau'})`, { network: true });
  } finally { clearTimeout(timer); }
  let data = null; try { data = JSON.parse(text); } catch { /* corps non JSON */ }
  if (res.status === 401 && auth && retryAuth && !cfg().token) { cache = { token: null, exp: 0 }; return call(path, { method, body, auth, timeout, retryAuth: false }); } // jeton temporaire refusé : un seul renouvellement
  if (!res.ok) {
    const raw = data ? JSON.stringify(data) : String(text || '');
    const code = (/ER\d{3}/.exec(raw) || [''])[0]; // codes documentés : ER101 numéro, ER102 opérateur, ER201 montant, ER301 solde
    const msg = data && (data.message || data.detail || data.error) ? String(data.message || data.detail || (data.error && data.error.message) || data.error) : '';
    throw new CampayError(`Campay HTTP ${res.status}${code ? ' ' + code : ''}${msg ? ' : ' + msg.replace(/\s+/g, ' ').slice(0, 120) : ''}`, { status: res.status, code });
  }
  return data || {};
}

/** Jeton d'accès : jeton permanent de l'application si fourni, sinon jeton temporaire (renouvelé avant son expiration). */
async function getToken() {
  if (cfg().token) return cfg().token;
  if (cache.token && Date.now() < cache.exp) return cache.token;
  const r = await call('/token/', { method: 'POST', auth: false, body: { username: cfg().username, password: cfg().password } });
  if (!r.token) throw new CampayError('Campay : jeton absent de la réponse');
  cache = { token: r.token, exp: Date.now() + Math.max(30, (Number(r.expires_in) || 180) - 30) * 1000 };
  return cache.token;
}

/** Numéro camerounais -> « 237XXXXXXXXX » (MTN et Orange : 6XXXXXXXX). Renvoie '' si le format est invalide. */
function normalizePhone(v) {
  let d = String(v == null ? '' : v).replace(/[\s.\-()]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(d)) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (/^6\d{8}$/.test(d)) d = '237' + d;
  return /^2376\d{8}$/.test(d) ? d : '';
}
/** Demande de paiement : le client reçoit une invite sur son téléphone. externalReference : UUID4 unique (Campay le rend idempotent). */
async function collect({ amount, from, description, externalReference, externalUser = '' }) {
  const r = await call('/collect/', { method: 'POST', body: { amount: String(Math.round(amount)), currency: 'XAF', from, description: String(description || '').slice(0, 120), external_reference: externalReference, external_user: String(externalUser || '').slice(0, 60) } });
  if (!r.reference) throw new CampayError('Campay : référence absente de la réponse');
  return { reference: String(r.reference), ussdCode: r.ussd_code || '', operator: String(r.operator || '').toLowerCase() };
}

/** Relit l'état réel d'une transaction chez Campay. status : 'paid' | 'failed' | 'pending'. Tout le reste est renvoyé tel quel pour contrôle. */
async function getTransaction(reference) {
  const r = await call(`/transaction/${encodeURIComponent(reference)}/`);
  const s = String(r.status || '').toUpperCase();
  return {
    status: s === 'SUCCESSFUL' ? 'paid' : s === 'FAILED' ? 'failed' : 'pending', rawStatus: s,
    reference: String(r.reference || ''), externalReference: String(r.external_reference || ''), amount: Number(r.amount), currency: String(r.currency || ''),
    operator: String(r.operator || '').toLowerCase(), code: String(r.code || ''), operatorReference: String(r.operator_reference || ''), reason: String(r.reason || ''), endpoint: String(r.endpoint || ''),
  };
}

// ---- Webhook : le champ « signature » est un JWT signé HS256 avec la clé de webhook de l'application ----
const b64u = (b) => Buffer.from(b).toString('base64url');
/** Vérifie un JWT HS256 (comparaison à temps constant). Renvoie la charge utile (objet) si valide, sinon null. */
function verifyJwtHS256(token, key) {
  if (typeof token !== 'string' || !key || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header; let payload;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!header || header.alg !== 'HS256') return null; // jamais « none » ni un autre algorithme
  const want = crypto.createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
  let got; try { got = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  if (payload && typeof payload === 'object' && payload.exp && Number(payload.exp) * 1000 < Date.now()) return null;
  return payload && typeof payload === 'object' ? payload : {};
}
/** Fabrique un JWT HS256 (utilisé par le FAUX serveur Campay et les tests). */
function signJwtHS256(payload, key) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url')}`;
}
const resetTokenCache = () => { cache = { token: null, exp: 0 }; };

module.exports = { CampayError, collect, getTransaction, getToken, normalizePhone, verifyJwtHS256, signJwtHS256, resetTokenCache };
