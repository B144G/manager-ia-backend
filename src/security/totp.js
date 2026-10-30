'use strict';
// Double authentification : codes à 6 chiffres qui changent toutes les 30 secondes (RFC 6238 : Google Authenticator, Microsoft Authenticator, Authy, 2FAS…),
// plus des codes de secours à usage unique. Le secret est chiffré en base (AES-256-GCM, services/vault). Un code déjà utilisé est refusé (anti-rejeu).
const crypto = require('crypto');
const vault = require('../services/vault');

const PERIOD = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const b32encode = (buf) => { let bits = 0; let val = 0; let out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; };
const b32decode = (s) => { let bits = 0; let val = 0; const out = []; for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };

const newSecret = () => b32encode(crypto.randomBytes(20));
function codeAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const stepNow = (t = Date.now()) => Math.floor(t / 1000 / PERIOD);

/** Vérifie un code (tolère ±1 période pour les horloges un peu décalées). Renvoie le numéro de période utilisé, ou 0 si faux / déjà utilisé. */
function verify(secret, token, lastStep = 0, t = Date.now()) {
  const tok = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(tok) || !secret) return 0;
  const now = stepNow(t);
  for (let d = -1; d <= 1; d++) {
    const s = now + d;
    if (s <= Number(lastStep)) continue;
    const a = Buffer.from(codeAt(secret, s)); const b = Buffer.from(tok);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return s;
  }
  return 0;
}
const uri = (label, secret, issuer = 'Brij-IA') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD}`;

const seal = (secret) => vault.encrypt(secret);
const unseal = (blob) => vault.decrypt(blob);

/** 10 codes de secours (affichés une seule fois) et leurs empreintes à stocker. */
function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => { const r = crypto.randomBytes(5).toString('hex'); return `${r.slice(0, 5)}-${r.slice(5)}`; });
  return { codes, hashes: codes.map(hashRecovery) };
}
const hashRecovery = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-f0-9]/g, '')).digest('hex');
/** Si « code » est un code de secours valable, renvoie la nouvelle liste d'empreintes (sans celui-là) ; sinon null. */
function useRecovery(hashesJson, code) {
  let list; try { list = JSON.parse(hashesJson || '[]'); } catch { list = []; }
  if (!/^[a-f0-9]{5}-?[a-f0-9]{5}$/i.test(String(code || '').trim())) return null;
  const h = hashRecovery(code);
  const i = list.indexOf(h);
  if (i < 0) return null;
  list.splice(i, 1);
  return JSON.stringify(list);
}
const recoveryLeft = (json) => { try { return JSON.parse(json || '[]').length; } catch { return 0; } };

module.exports = { newSecret, verify, uri, seal, unseal, newRecoveryCodes, useRecovery, recoveryLeft, codeAt, stepNow, b32encode, b32decode };
