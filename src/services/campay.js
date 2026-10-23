'use strict';
// Paiement mobile automatique (MTN / Orange) via Campay.
const config = require('../config');
const { fetchJson, oneLine } = require('../util');

let cache = { token: null, exp: 0 };
const base = () => config.campay.baseUrl;

async function getToken() {
  if (cache.token && Date.now() < cache.exp) return cache.token;
  const r = await fetchJson(`${base()}/token/`, {
    method: 'POST',
    body: { username: config.campay.username, password: config.campay.password },
  });
  if (!r.ok || !r.data || !r.data.token) throw new Error(`Campay token HTTP ${r.status}`);
  cache = { token: r.data.token, exp: Date.now() + Math.max(30, (Number(r.data.expires_in) || 180) - 20) * 1000 };
  return cache.token;
}

async function authed(path, opts = {}) {
  const token = await getToken();
  return await fetchJson(`${base()}${path}`, { ...opts, headers: { Authorization: `Token ${token}` } });
}

/** Lance la demande de paiement sur le téléphone du client. Renvoie { reference, ussd_code, operator }. */
async function collect({ amount, from, description, externalReference }) {
  const r = await authed('/collect/', {
    method: 'POST',
    body: { amount: String(amount), from, description, external_reference: externalReference },
  });
  if (!r.ok || !r.data || !r.data.reference) {
    const m = r.data && (r.data.message || r.data.detail || (r.data.error && r.data.error.message));
    throw new Error(`Campay collect HTTP ${r.status} : ${oneLine(m || 'réponse inattendue', 200)}`);
  }
  return r.data;
}

/** Relit l'état réel d'une transaction. Renvoie 'paid' | 'failed' | 'pending'. */
async function getStatus(campayReference) {
  const r = await authed(`/transaction/${encodeURIComponent(campayReference)}/`);
  if (!r.ok || !r.data) throw new Error(`Campay statut HTTP ${r.status}`);
  const s = String(r.data.status || '').toUpperCase();
  if (s === 'SUCCESSFUL') return 'paid';
  if (s === 'FAILED') return 'failed';
  return 'pending';
}

module.exports = { collect, getStatus };
