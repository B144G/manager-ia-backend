'use strict';
// Chat interne : contrôle des fichiers téléversés. On ne se fie JAMAIS au type annoncé par le navigateur ni à l'extension seule :
//  1. le type RÉEL est lu dans les premiers octets (signatures) ;
//  2. l'extension doit correspondre au contenu ;
//  3. refus des exécutables, scripts, pages web, macros (Office, PDF avec JavaScript), archives piégées ;
//  4. signature de test EICAR détectée ; analyse optionnelle par un antivirus ClamAV (clamd) si CHAT_CLAMAV_HOST est défini.
// Limite assumée : sans ClamAV, ce n'est PAS un antivirus complet (voir docs/chat-interne.md).
const net = require('net');
const { HttpError } = require('../util');

const CATEGORIES = ['image', 'pdf', 'word', 'excel', 'presentation', 'video', 'audio', 'text'];
const CAT_LABEL = { image: 'images', pdf: 'PDF', word: 'documents Word', excel: 'tableurs Excel', presentation: 'présentations', video: 'vidéos', audio: 'audio', text: 'textes (txt, csv)' };
const EXT_OK = {
  image: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' },
  pdf: { pdf: 'application/pdf' },
  word: { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword' },
  excel: { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel' },
  presentation: { pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint' },
  video: { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4' },
  audio: { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm', mp4: 'audio/mp4' },
  text: { txt: 'text/plain', csv: 'text/csv', md: 'text/plain', log: 'text/plain' },
};
const PREVIEWABLE = ['image', 'video', 'audio', 'pdf']; // aperçu possible dans l'application (les autres : téléchargement)
const BAD_NAMES = /(^|\/)(vbaProject\.bin|.*\.(exe|dll|js|vbs|bat|cmd|scr|com|jar|ps1|sh|msi|lnk))$/i;
const EICAR = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';
const refuse = (msg) => { throw new HttpError(400, msg); };

const ascii = (b, from, to) => b.toString('latin1', from, to);

/** Signature réelle → { cat, exts: [extensions plausibles], mime } ou null. */
function signature(b) {
  if (b.length < 8) return null;
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return { cat: 'image', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { cat: 'image', mime: 'image/jpeg' };
  if (ascii(b, 0, 4) === 'GIF8') return { cat: 'image', mime: 'image/gif' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { cat: 'image', mime: 'image/webp' };
  if (ascii(b, 0, 5) === '%PDF-') return { cat: 'pdf', mime: 'application/pdf' };
  if (ascii(b, 0, 4) === 'PK\x03\x04') return { cat: 'zip' };
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return { cat: 'ole' };
  if (ascii(b, 4, 8) === 'ftyp') { const brand = ascii(b, 8, 12); return brand.startsWith('M4A') ? { cat: 'audio', mime: 'audio/mp4' } : brand === 'qt  ' ? { cat: 'video', mime: 'video/quicktime' } : { cat: 'video', mime: 'video/mp4', maybeAudio: true }; }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { cat: 'video', mime: 'video/webm', maybeAudio: true };
  if (ascii(b, 0, 4) === 'OggS') return { cat: 'audio', mime: 'audio/ogg' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { cat: 'audio', mime: 'audio/wav' };
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { cat: 'audio', mime: 'audio/mpeg' };
  return null;
}
function looksExecutable(b) {
  const h2 = ascii(b, 0, 2); const h4 = ascii(b, 0, 4);
  if (h2 === 'MZ' || h4 === '\x7fELF' || h2 === '#!' || ['\xfe\xed\xfa\xce', '\xfe\xed\xfa\xcf', '\xca\xfe\xba\xbe', '\xcf\xfa\xed\xfe', '\xce\xfa\xed\xfe'].includes(h4)) return true;
  const head = b.toString('latin1', 0, 600).toLowerCase();
  return /<\s*(!doctype|html|script|svg|iframe|\?php|body)\b/.test(head) || head.startsWith('<?xml');
}
function zipNames(b) {
  const { unzipSync } = require('fflate');
  const names = [];
  try { unzipSync(new Uint8Array(b.buffer, b.byteOffset, b.length), { filter: (f) => { names.push(f.name); return false; } }); } catch { refuse('Ce document est endommagé ou illisible.'); }
  return names;
}

/** Analyse un fichier : renvoie { category, mime, ext, name }. Lève une erreur claire (400) s'il doit être refusé. */
function inspect(buf, rawName, { voice = false } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) refuse('Fichier vide.');
  const name = String(rawName || 'fichier').replace(/[\\/\u0000-\u001f\u007f"<>|:*?]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'fichier';
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  if (buf.includes(Buffer.from(EICAR))) refuse('Fichier refusé : il est détecté comme un virus de test.');
  if (looksExecutable(buf)) refuse('Fichier refusé : programmes, scripts et pages web ne peuvent pas être partagés.');
  let sig = signature(buf);
  let category; let mime;
  if (sig && sig.cat === 'zip') {
    const names = zipNames(buf);
    if (names.length > 4000) refuse('Archive refusée (trop de fichiers à l’intérieur).');
    if (names.some((n) => BAD_NAMES.test(n))) refuse('Document refusé : il contient des macros ou des programmes.');
    if (names.some((n) => n === 'word/document.xml')) category = 'word';
    else if (names.some((n) => n === 'xl/workbook.xml')) category = 'excel';
    else if (names.some((n) => n === 'ppt/presentation.xml')) category = 'presentation';
    else refuse('Les archives ZIP ne sont pas acceptées (seulement les documents Word, Excel et PowerPoint).');
    mime = EXT_OK[category][{ word: 'docx', excel: 'xlsx', presentation: 'pptx' }[category]];
    if (!['docx', 'xlsx', 'pptx'].includes(ext) || EXT_OK[category][ext] !== mime) refuse("L'extension du fichier ne correspond pas à son contenu.");
  } else if (sig && sig.cat === 'ole') {
    if (/_VBA_PROJECT|V\x00B\x00A\x00_\x00P|Macros/.test(buf.toString('latin1', 0, Math.min(buf.length, 4 * 1024 * 1024))) || /V\x00B\x00A\x00/.test(buf.toString('latin1', 0, Math.min(buf.length, 4 * 1024 * 1024)))) refuse('Document refusé : il contient des macros.');
    category = { doc: 'word', xls: 'excel', ppt: 'presentation' }[ext];
    if (!category) refuse("Ancien format Office non reconnu : enregistrez le document en .docx, .xlsx ou .pptx.");
    mime = EXT_OK[category][ext];
  } else if (sig) {
    category = sig.cat; mime = sig.mime;
    if (category === 'pdf') {
      const txt = buf.toString('latin1');
      if (/\/(JavaScript|JS|Launch|RichMedia)\b/.test(txt)) refuse('PDF refusé : il contient du code actif (JavaScript).');
    }
    if (sig.maybeAudio && (voice || EXT_OK.audio[ext] && !EXT_OK.video[ext] || (ext === 'webm' && voice))) { category = 'audio'; mime = ext === 'webm' || sig.mime === 'video/webm' ? 'audio/webm' : 'audio/mp4'; }
    if (voice && category === 'video' && ['webm', 'mp4', 'm4a'].includes(ext)) { category = 'audio'; mime = sig.mime === 'video/webm' ? 'audio/webm' : 'audio/mp4'; }
    const allowed = EXT_OK[category] || {};
    const okExt = allowed[ext] !== undefined || (voice && category === 'audio' && ['webm', 'ogg', 'mp4', 'm4a', 'wav', 'mp3'].includes(ext));
    if (!okExt) refuse("L'extension du fichier ne correspond pas à son contenu.");
  } else {
    // Texte : pas d'octet nul, UTF-8 valide, extension texte.
    if (!EXT_OK.text[ext]) refuse('Format non reconnu. Formats acceptés : images, PDF, Word, Excel, PowerPoint, vidéos, audio, texte.');
    if (buf.includes(0)) refuse("Le contenu ne correspond pas à un fichier texte.");
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 1 << 20))); } catch { refuse('Le fichier texte doit être enregistré en UTF-8.'); }
    category = 'text'; mime = EXT_OK.text[ext];
  }
  if (voice && category !== 'audio') refuse("Ce n'est pas un enregistrement audio.");
  return { category, mime, ext, name };
}

/** Analyse par un antivirus ClamAV (démon clamd) si CHAT_CLAMAV_HOST est défini. Panne de l'antivirus : refus par prudence si CHAT_CLAMAV_REQUIRED=1, sinon passage journalisé. */
async function antivirus(buf) {
  const host = process.env.CHAT_CLAMAV_HOST;
  if (!host) return 'unscanned';
  const port = parseInt(process.env.CHAT_CLAMAV_PORT, 10) || 3310;
  try {
    const out = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port, timeout: 15000 });
      let res = '';
      s.on('connect', () => {
        s.write('zINSTREAM\0');
        for (let i = 0; i < buf.length; i += 65536) { const c = buf.subarray(i, i + 65536); const l = Buffer.alloc(4); l.writeUInt32BE(c.length); s.write(l); s.write(c); }
        s.write(Buffer.alloc(4));
      });
      s.on('data', (d) => { res += d; });
      s.on('end', () => resolve(res));
      s.on('timeout', () => { s.destroy(); reject(new Error('délai dépassé')); });
      s.on('error', reject);
    });
    if (/FOUND/.test(out)) refuse('Fichier refusé : un virus a été détecté.');
    return /OK/.test(out) ? 'clean' : 'unscanned';
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (process.env.CHAT_CLAMAV_REQUIRED === '1') throw new HttpError(503, "L'analyse antivirus est indisponible : réessayez dans un instant.");
    return 'unscanned';
  }
}

module.exports = { CATEGORIES, CAT_LABEL, EXT_OK, PREVIEWABLE, inspect, antivirus };
