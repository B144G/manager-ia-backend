'use strict';
// Chiffrement des secrets enregistrés (jetons WhatsApp) : AES-256-GCM. La clé vient de DATA_KEY, sinon de JWT_SECRET.
// Les secrets ne sont JAMAIS renvoyés au navigateur ni écrits dans les journaux.
const crypto = require('crypto');
const config = require('../config');

let key = null;
const getKey = () => key || (key = crypto.scryptSync(config.dataKey || config.jwtSecret, 'manager-ia-vault-v1', 32));

function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

/** Renvoie le texte clair, ou '' si le secret est absent ou illisible (clé changée). */
function decrypt(blob) {
  if (!blob || !String(blob).startsWith('v1:')) return '';
  try {
    const raw = Buffer.from(String(blob).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}

module.exports = { encrypt, decrypt };
