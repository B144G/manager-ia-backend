'use strict';
// Liens signés et temporaires (15 min) vers un fichier précis : Messenger et Instagram reçoivent une ADRESSE (pas le fichier) et la téléchargent eux-mêmes.
// La signature empêche de deviner ou de modifier le lien ; le lien ne donne accès qu'à un seul fichier, pour peu de temps.
const crypto = require('crypto');
const config = require('../config');
const { db, nowISO } = require('../db');

const TTL = 15 * 60 * 1000;
const mac = (p) => crypto.createHmac('sha256', config.jwtSecret).update('file|' + p).digest('base64url');
function make(kind, id, ttl = TTL) {
  if (!config.apiPublicUrl) throw new Error("API_PUBLIC_URL manquant : indiquez l'adresse publique HTTPS du serveur pour envoyer des fichiers sur Messenger et Instagram.");
  const p = Buffer.from(JSON.stringify({ k: kind, i: id, e: Date.now() + ttl })).toString('base64url');
  return `${config.apiPublicUrl}/api/ws/public/file/${p}.${mac(p)}`;
}
function read(token) {
  const [p, sig] = String(token || '').split('.');
  if (!p || !sig) return null;
  const a = Buffer.from(mac(p)); const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!d || !(d.e > Date.now()) || !['cm', 'tmp'].includes(d.k) || !Number.isInteger(d.i)) return null;
  return d;
}
/** Garde un fichier généré (voix) 1 h pour qu'un lien signé puisse le servir. */
function stash(orgId, mime, buf) {
  return Number(db.prepare('INSERT INTO tmp_files (org_id, mime, data, expires_at) VALUES (?, ?, ?, ?)').run(orgId, mime, buf, new Date(Date.now() + 3600000).toISOString()).lastInsertRowid);
}
const purge = () => db.prepare('DELETE FROM tmp_files WHERE expires_at < ?').run(nowISO());
module.exports = { make, read, stash, purge };
