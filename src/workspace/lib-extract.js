'use strict';
// Extraction du texte des documents pour la recherche plein texte, sans dépendance externe.
// Pris en charge : texte et CSV ; Word (.docx), Excel (.xlsx), PowerPoint (.pptx) et OpenDocument (.odt/.ods/.odp) — des archives ZIP de fichiers XML ;
// PDF « de meilleur effort » : texte des PDF simples (polices standard). Un PDF numérisé (image) ou à polices intégrées ne donne pas de texte : le document reste trouvable par son titre et sa notice.
const zlib = require('zlib');

const MAX_TEXT = 200000;

/** Lit les entrées d'une archive ZIP (répertoire central) : { nom: contenu décompressé }, limitées aux noms acceptés par `want`. */
function unzip(buf, want) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32); const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!want(name) || usize > 20 * 1024 * 1024 || off + 30 > buf.length) continue;
    const dstart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(dstart, dstart + csize);
    try { out[name] = method === 0 ? raw.toString('utf8') : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 20 * 1024 * 1024 }).toString('utf8') : ''; } catch { /* entrée illisible : ignorée */ }
  }
  return out;
}
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
/** XML → texte : les fins de paragraphe, de ligne et de cellule deviennent des espaces. */
const xmlText = (x) => decode(String(x).replace(/<\/(w:p|text:p|text:h|a:p|row|si)>/g, ' ').replace(/<(w:tab|w:br|text:tab)\s*\/>/g, ' ').replace(/<[^>]+>/g, ''));

function pdfText(buf) {
  const parts = []; const s = buf.toString('latin1');
  const collect = (txt) => { for (const m of txt.matchAll(/\((?:\\.|[^\\()])*\)\s*T[jJ]|\[((?:\\.|[^\]])*)\]\s*TJ/g)) for (const q of m[0].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) parts.push(q[1].replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: ' ', r: ' ', t: ' ', b: '', f: '' }[c] ?? c)).replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))); };
  collect(s);
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) { try { collect(zlib.inflateSync(Buffer.from(m[1], 'latin1'), { maxOutputLength: 10 * 1024 * 1024 }).toString('latin1')); } catch { /* flux non compressé ou autre filtre */ } }
  return parts.join(' ');
}

/** Texte brut d'un fichier (peut être vide). Ne lève jamais d'erreur. */
function extractText(buf, mime) {
  try {
    let t = '';
    if (/^text\/(plain|csv)/.test(mime)) t = buf.toString('utf8');
    else if (mime === 'application/pdf') t = pdfText(buf);
    else if (/wordprocessingml/.test(mime)) t = xmlText(Object.values(unzip(buf, (n) => n === 'word/document.xml')).join(' '));
    else if (/spreadsheetml/.test(mime)) t = xmlText(Object.values(unzip(buf, (n) => n === 'xl/sharedStrings.xml')).join(' '));
    else if (/presentationml/.test(mime)) t = xmlText(Object.entries(unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).sort().map((e) => e[1]).join(' '));
    else if (/opendocument/.test(mime)) t = xmlText(Object.values(unzip(buf, (n) => n === 'content.xml')).join(' '));
    return t.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  } catch { return ''; }
}
module.exports = { extractText, unzip, MAX_TEXT };
