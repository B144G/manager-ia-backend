'use strict';
// Lecture des relevés bancaires : OFX/QFX, MT940 (SWIFT), CAMT.053 (ISO 20022, XML) et Excel (.xlsx, converti en CSV puis lu comme un CSV).
// Fonctions pures, sans base de données. Aucun analyseur XML : des motifs simples sur le texte (aucune entité externe n'est jamais résolue).
// Chaque lecteur renvoie { lines:[{ date:'AAAA-MM-JJ', label, reference, amount (entier signé : crédit +, débit −), balance:null }], invalid:[{ row, reason }] }.
const { unzipSync, strFromU8 } = require('fflate');
const { HttpError } = require('../util');

const MAX_BYTES = 1.5e6;

const unesc = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const clean = (s, n) => unesc(s).replace(/\s+/g, ' ').trim().slice(0, n);
const iso = (y, m, d) => {
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(s + 'T00:00:00Z');
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== s ? null : s;
};
/** Montant décimal (« 1500.50 » ou « 1500,50 ») → entier de FCFA arrondi. */
const money = (s) => {
  const t = String(s || '').trim().replace(/\s/g, '');
  if (!/^[-+]?\d+([.,]\d+)?$/.test(t)) return NaN;
  return Math.round(Number(t.replace(',', '.')));
};

/** Reconnaît le format d'après le contenu (jamais d'après le nom du fichier, qui peut mentir). */
function sniff(text) {
  const head = String(text).slice(0, 6000);
  if (/<OFX[\s>]/i.test(head) || /OFXHEADER:/i.test(head)) return 'ofx';
  if (/<(?:\w+:)?Document[\s>]/.test(head) && /camt\.0(?:53|52|54)/i.test(head + String(text).slice(0, 200000))) return 'camt';
  if (/^\s*(?::20:|\{1:)/m.test(head) && /:6[01]:/.test(String(text).slice(0, 400000))) return 'mt940';
  return 'csv';
}

// ---------- OFX / QFX ----------
function parseOfx(text) {
  const lines = []; const invalid = [];
  const parts = text.split(/<STMTTRN>/i).slice(1);
  parts.forEach((blk, i) => {
    const b = blk.split(/<\/STMTTRN>/i)[0];
    const tag = (name) => { const m = new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i').exec(b); return m ? m[1].trim() : ''; };
    const d = /^(\d{4})(\d{2})(\d{2})/.exec(tag('DTPOSTED'));
    const date = d ? iso(d[1], d[2], d[3]) : null;
    const amount = money(tag('TRNAMT'));
    if (!date) return invalid.push({ row: i + 1, reason: 'date illisible' });
    if (!Number.isFinite(amount) || amount === 0) return invalid.push({ row: i + 1, reason: 'montant illisible ou nul' });
    const label = [tag('NAME'), tag('MEMO')].filter(Boolean).join(' ');
    lines.push({ date, label: clean(label, 200) || 'Opération', reference: clean(tag('FITID') || tag('CHECKNUM'), 80), amount, balance: null });
  });
  return { lines, invalid };
}

// ---------- MT940 ----------
function parseMt940(text) {
  const lines = []; const invalid = [];
  const rows = text.replace(/\r/g, '').split('\n');
  let cur = null; let n = 0;
  const flush = () => {
    if (!cur) return;
    const label = clean(cur.info.join(' ').replace(/\?\d{2}/g, ' '), 200);
    lines.push({ date: cur.date, label: label || 'Opération', reference: clean(cur.ref, 80), amount: cur.amount, balance: null });
    cur = null;
  };
  for (const raw of rows) {
    const r = raw.trimEnd();
    const m61 = /^:61:(\d{2})(\d{2})(\d{2})(?:\d{4})?(R?[CD])[A-Z]?([\d]+(?:,\d*)?)N[A-Z0-9]{3}([^/\n]*)(?:\/\/(.*))?/.exec(r);
    if (m61) {
      flush(); n++;
      const date = iso(2000 + Number(m61[1]), m61[2], m61[3]);
      const amt = money(m61[5].replace(/,$/, ''));
      const sign = { C: 1, D: -1, RC: -1, RD: 1 }[m61[4]];
      if (!date) { invalid.push({ row: n, reason: 'date illisible' }); continue; }
      if (!Number.isFinite(amt) || amt === 0) { invalid.push({ row: n, reason: 'montant illisible ou nul' }); continue; }
      cur = { date, amount: sign * amt, ref: (m61[7] || m61[6] || '').trim(), info: [] };
      continue;
    }
    if (!cur) continue;
    if (/^:86:/.test(r)) { cur.info.push(r.slice(4)); continue; }
    if (/^:\d{2}[A-Z]?:/.test(r) || /^-}/.test(r)) { flush(); continue; }
    if (cur.info.length) cur.info.push(r); // suite du libellé
  }
  flush();
  return { lines, invalid };
}

// ---------- CAMT.053 (ISO 20022) ----------
function parseCamt(text) {
  const lines = []; const invalid = [];
  const entries = text.match(/<(?:\w+:)?Ntry>[\s\S]*?<\/(?:\w+:)?Ntry>/g) || [];
  entries.forEach((e, i) => {
    const tag = (name) => { const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)<`).exec(e); return m ? m[1].trim() : ''; };
    const book = /<(?:\w+:)?BookgDt>[\s\S]*?<(?:\w+:)?(?:Dt|DtTm)>(\d{4})-(\d{2})-(\d{2})/.exec(e) || /<(?:\w+:)?ValDt>[\s\S]*?<(?:\w+:)?(?:Dt|DtTm)>(\d{4})-(\d{2})-(\d{2})/.exec(e);
    const date = book ? iso(book[1], book[2], book[3]) : null;
    let amount = money(tag('Amt'));
    const credit = /^CRDT$/i.test(tag('CdtDbtInd'));
    if (!date) return invalid.push({ row: i + 1, reason: 'date illisible' });
    if (!Number.isFinite(amount) || amount === 0) return invalid.push({ row: i + 1, reason: 'montant illisible ou nul' });
    amount = Math.abs(amount) * (credit ? 1 : -1);
    if (/^true$/i.test(tag('RvslInd'))) amount = -amount;
    const info = [tag('AddtlNtryInf'), ...[...e.matchAll(/<(?:\w+:)?Ustrd>([^<]*)</g)].map((m) => m[1])].filter(Boolean);
    lines.push({ date, label: clean(info.join(' '), 200) || 'Opération', reference: clean(tag('AcctSvcrRef') || tag('NtryRef') || tag('EndToEndId'), 80), amount, balance: null });
  });
  return { lines, invalid };
}

// ---------- Excel (.xlsx) → texte CSV ----------
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const serialToIso = (v) => { const d = new Date(Math.round((Number(v) - 25569) * 86400000)); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };

/** Convertit la première feuille d'un classeur .xlsx en texte CSV (séparateur « ; »). Les dates Excel deviennent des dates AAAA-MM-JJ. */
function xlsxToCsv(buf) {
  if (!buf || !buf.length) throw new HttpError(400, 'Fichier Excel vide.');
  if (buf.length > MAX_BYTES) throw new HttpError(400, 'Fichier trop volumineux (1,5 Mo au plus).');
  let files;
  try { files = unzipSync(buf, { filter: (f) => /^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|styles\.xml)$/.test(f.name) && f.originalSize <= 20e6 }); } catch { throw new HttpError(400, "Ce fichier n'est pas un classeur Excel (.xlsx) lisible."); }
  const sheetName = Object.keys(files).filter((k) => /worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml/.exec(a)[1]) - Number(/(\d+)\.xml/.exec(b)[1]))[0];
  if (!sheetName) throw new HttpError(400, 'Aucune feuille trouvée dans ce classeur.');
  const shared = files['xl/sharedStrings.xml'] ? (strFromU8(files['xl/sharedStrings.xml']).match(/<si>[\s\S]*?<\/si>/g) || []).map((si) => unesc((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]*>/g, '')).join(''))) : [];
  // styles : quels numéros de format désignent une date
  const dateXf = new Set();
  if (files['xl/styles.xml']) {
    const st = strFromU8(files['xl/styles.xml']);
    const custom = new Set(); for (const m of st.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) if (/[dmy]/i.test(m[2].replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/[#0]/.test(m[2].replace(/"[^"]*"|\[[^\]]*\]/g, ''))) custom.add(Number(m[1]));
    const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st);
    if (xfs) [...xfs[1].matchAll(/<xf\s[^>]*numFmtId="(\d+)"/g)].forEach((m, i) => { if (BUILTIN_DATE_FMT.has(Number(m[1])) || custom.has(Number(m[1]))) dateXf.add(i); });
  }
  const xml = strFromU8(files[sheetName]);
  const out = [];
  for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of rowM[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]; const body = c[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs); if (!ref) continue;
      const type = (/\bt="(\w+)"/.exec(attrs) || [])[1]; const style = Number((/\bs="(\d+)"/.exec(attrs) || [])[1] || 0);
      const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] || '';
      else if (type === 'inlineStr') val = unesc((body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]*>/g, '')).join(''));
      else if (v !== undefined) val = type === 'str' || type === 'b' || type === 'e' ? unesc(v) : (dateXf.has(style) ? serialToIso(v) : v);
      cells[colIndex(ref[1])] = val;
    }
    if (cells.some((x) => x !== undefined && String(x).trim() !== '')) out.push(Array.from(cells, (x) => (x === undefined ? '' : x)));
    if (out.length > 20000) throw new HttpError(400, 'Trop de lignes (20 000 au plus).');
  }
  if (!out.length) throw new HttpError(400, 'La première feuille du classeur est vide.');
  const q = (x) => { const t = String(x).replace(/[\r\n]+/g, ' '); return /[;"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return out.map((r) => r.map(q).join(';')).join('\n');
}

/** Lecture d'un relevé non CSV d'après son format. */
function parseByFormat(format, text) {
  if (text.length > MAX_BYTES) throw new HttpError(400, 'Fichier trop volumineux (1,5 Mo au plus).');
  const r = format === 'ofx' ? parseOfx(text) : format === 'mt940' ? parseMt940(text) : format === 'camt' ? parseCamt(text) : null;
  if (!r) throw new HttpError(400, 'Format de relevé inconnu.');
  return r;
}

module.exports = { sniff, parseOfx, parseMt940, parseCamt, xlsxToCsv, parseByFormat, MAX_BYTES };
