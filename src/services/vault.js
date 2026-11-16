'use strict';
// Chiffrement des secrets et des champs sensibles enregistrés : AES-256-GCM. La clé vient de DATA_KEY, sinon de JWT_SECRET.
// Les secrets ne sont JAMAIS renvoyés au navigateur ni écrits dans les journaux.
//   encrypt / decrypt           secrets techniques (jetons WhatsApp, secrets 2FA, secrets de webhooks)  -> préfixe « v1: »
//   encryptField / decryptField champs de données personnelles (CNPS, NIU, CNI, compte de paie…)       -> préfixe « v2: » (clé dérivée à part)
// Rotation de la clé : mettez l'ancienne valeur dans DATA_KEY_PREVIOUS (liste séparée par des virgules) puis lancez « npm run security:rotate-keys » ;
// le déchiffrement essaie la clé actuelle puis les anciennes. Une valeur qui n'est pas chiffrée (donnée d'avant la mise en place) est rendue telle quelle.
const crypto = require('crypto');
const config = require('../config');

const SALT = { v1: 'manager-ia-vault-v1', v2: 'brij-ia-fields-v2' };
const cache = new Map();
const keyFrom = (material, tag) => {
  const id = `${tag}|${material}`;
  if (!cache.has(id)) cache.set(id, crypto.scryptSync(material, SALT[tag], 32));
  return cache.get(id);
};
const current = () => config.dataKey || config.jwtSecret;
const previous = () => String(process.env.DATA_KEY_PREVIOUS || '').split(',').map((s) => s.trim()).filter(Boolean);

function seal(tag, plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(current(), tag), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${tag}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}
function open(tag, blob) {
  const raw = Buffer.from(String(blob).slice(tag.length + 1), 'base64');
  for (const material of [current(), ...previous()]) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(material, tag), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch { /* essaie la clé suivante */ }
  }
  return null;
}

const isEncrypted = (v) => typeof v === 'string' && (v.startsWith('v1:') || v.startsWith('v2:'));
const encrypt = (plain) => seal('v1', plain);
/** Renvoie le texte clair, ou '' si le secret est absent ou illisible (clé changée). */
const decrypt = (blob) => (blob && String(blob).startsWith('v1:') ? open('v1', blob) || '' : '');

const encryptField = (plain) => (isEncrypted(plain) ? plain : seal('v2', plain));
/** Champ de donnée personnelle : clair si l'ancienne valeur n'était pas chiffrée, '' si illisible. */
const decryptField = (blob) => (blob && String(blob).startsWith('v2:') ? open('v2', blob) || '' : blob === undefined || blob === null ? '' : String(blob));
/** Rechiffre avec la clé actuelle (après changement de DATA_KEY). Renvoie null si illisible. */
const rewrap = (blob) => {
  if (!isEncrypted(blob)) return blob;
  const tag = String(blob).slice(0, 2);
  const plain = open(tag, blob);
  return plain === null ? null : seal(tag, plain);
};

module.exports = { encrypt, decrypt, encryptField, decryptField, isEncrypted, rewrap };
