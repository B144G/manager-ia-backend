'use strict';
// Validation d'une image envoyée (logo, favicon) : type réel lu dans les octets (jamais la parole du navigateur), taille, dimensions, absence de code caché.
// Formats acceptés : PNG, JPEG, WebP. Refusés : SVG (peut contenir des scripts), GIF, ICO, HTML déguisé en image, images animées.
const crypto = require('crypto');
const { HttpError } = require('../util');

function sniff(b) {
  if (b.length >= 24 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.slice(12, 16).toString('latin1') === 'IHDR') {
    return { mime: 'image/png', w: b.readUInt32BE(16), h: b.readUInt32BE(20), animated: b.includes(Buffer.from('acTL')) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { // JPEG : premier marqueur SOFn
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: 'image/jpeg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), animated: false };
      i += 2 + len;
    }
    return { mime: 'image/jpeg', w: 0, h: 0, animated: false };
  }
  if (b.length >= 30 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') {
    const f = b.slice(12, 16).toString('latin1');
    let w = 0; let h = 0;
    if (f === 'VP8 ') { w = b.readUInt16LE(26) & 0x3fff; h = b.readUInt16LE(28) & 0x3fff; }
    else if (f === 'VP8L') { const v = b.readUInt32LE(21); w = (v & 0x3fff) + 1; h = ((v >> 14) & 0x3fff) + 1; }
    else if (f === 'VP8X') { w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)); }
    return { mime: 'image/webp', w, h, animated: f === 'VP8X' && Boolean(b[20] & 0x02) };
  }
  return null;
}

/** Contrôle une image reçue en base64. Renvoie { buf, mime, hash, w, h } ou lève une erreur 400 en français. */
function check(dataB64, kind, { maxBytes, maxSide = 2048 } = {}) {
  const raw = String(dataB64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!raw || raw.length > Math.ceil(maxBytes * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new HttpError(400, `Image invalide ou trop lourde (${Math.round(maxBytes / 1024)} Ko au plus).`);
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length || buf.length > maxBytes) throw new HttpError(400, `Image trop lourde : ${Math.round(maxBytes / 1024)} Ko au plus.`);
  const info = sniff(buf);
  if (!info) throw new HttpError(400, 'Format non accepté : envoyez une image PNG, JPEG ou WebP (le SVG et le GIF sont refusés pour votre sécurité).');
  if (info.animated) throw new HttpError(400, 'Les images animées ne sont pas acceptées.');
  if (!info.w || !info.h || info.w < 16 || info.h < 16) throw new HttpError(400, 'Image trop petite (16 pixels au moins de chaque côté) ou illisible.');
  if (info.w > maxSide || info.h > maxSide) throw new HttpError(400, `Image trop grande : ${maxSide} pixels au plus de chaque côté.`);
  const head = buf.toString('latin1').toLowerCase();
  if (/<\s*(script|svg|html|iframe|object|embed|\?php)|javascript:/.test(head)) throw new HttpError(400, 'Cette image contient du code : elle est refusée.');
  if (kind === 'favicon' && Math.abs(info.w - info.h) > Math.max(info.w, info.h) * 0.2) throw new HttpError(400, 'Le favicon doit être à peu près carré.');
  return { buf, mime: info.mime, w: info.w, h: info.h, hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
}

module.exports = { check, sniff };
