'use strict';
// Petites fonctions utilitaires partagées.
const crypto = require('crypto');

// ---------- Journal (sans mots de passe ni jetons : ne jamais y passer de secrets) ----------
const stamp = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(stamp(), '[info]', ...a),
  warn: (...a) => console.warn(stamp(), '[attention]', ...a),
  error: (...a) => console.error(stamp(), '[erreur]', ...a),
};

// ---------- Erreurs HTTP ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Contacts ----------
// E-mail -> minuscules ; numéro -> chiffres seulement (un numéro camerounais à 9 chiffres reçoit le préfixe 237).
function normalizeContact(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 120) return null;
  if (s.includes('@')) {
    const e = s.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
    return { value: e, type: 'email' };
  }
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^6\d{8}$/.test(d)) d = '237' + d;
  if (d.length < 8 || d.length > 15) return null;
  return { value: d, type: 'phone' };
}

const isEmail = (c) => typeof c === 'string' && c.includes('@');
const digitsOf = (c) => String(c || '').replace(/\D/g, '');

// ---------- Comparaisons en temps constant ----------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- Texte ----------
const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const oneLine = (v, max = 500) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const stripAccents = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

function genReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = 'MI-';
  for (let i = 0; i < 6; i++) r += alphabet[crypto.randomInt(alphabet.length)];
  return r;
}

const addDays = (date, days) => new Date(new Date(date).getTime() + days * 86400000);
const parseJSON = (s, fallback) => {
  try {
    const v = JSON.parse(s);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
};

// ---------- Appels HTTP sortants (fetch natif) ----------
async function fetchJson(url, { method = 'GET', headers = {}, body, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const txt = await res.text();
    let data = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = { raw: txt.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Petit ensemble "vus récemment" (anti-doublons des webhooks) ----------
function makeSeen(max = 2000) {
  const set = new Set();
  return (id) => {
    if (!id) return false;
    if (set.has(id)) return true;
    set.add(id);
    if (set.size > max) set.delete(set.values().next().value);
    return false;
  };
}

/** Extrait le premier objet JSON d'un texte (l'IA l'entoure parfois de phrases). Renvoie null si illisible. */
function extractJSON(text) {
  const a = String(text || '');
  const i = a.indexOf('{');
  const j = a.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(a.slice(i, j + 1)); } catch { return null; }
}

module.exports = {
  log, HttpError, asyncHandler, normalizeContact, isEmail, digitsOf, safeEqual, cleanText, oneLine,
  extractJSON, stripAccents, genReference, addDays, parseJSON, fetchJson, makeSeen,
};
