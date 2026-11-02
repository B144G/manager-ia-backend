'use strict';
// Fabrication de PDF côté serveur (pdfkit, polices standard : aucune police à embarquer, aucun appel externe).
// Un document = { title, subtitle?, org, meta?: [[libellé, valeur]], blocks: [...], footer? }.
// Blocs : { type: 'heading', text } · { type: 'kv', rows: [[libellé, valeur]] } · { type: 'table', cols: [{ key, label, width, align }], rows: [{...}], totals?: [[libellé, valeur]] }
//         · { type: 'text', text } · { type: 'note', text } · { type: 'space' }
const PDFDocument = require('pdfkit');

const INK = '#111827'; const MUTED = '#6b7280'; const LINE = '#d1d5db'; const ACCENT = '#4338ca';

// Les polices standard ne contiennent que le jeu « Windows-1252 » : on remplace les espaces fines et les signes absents, pour ne jamais afficher de caractère cassé.
const CP1252_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[    ]/g, ' ').replace(/[→➔]/g, '->').replace(/≤/g, '<=').replace(/≥/g, '>=')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .split('').map((ch) => { const c = ch.codePointAt(0); return c <= 0xff || CP1252_EXTRA.has(c) ? ch : '?'; }).join('');
}

/** Rend le document et renvoie un Buffer. options.compress = false pour les tests (texte lisible dans le flux). */
function render(spec, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, compress: options.compress !== false, info: { Title: clean(spec.title).slice(0, 120), Author: clean(spec.org || 'Brij-IA').slice(0, 80), Creator: 'Brij-IA' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    try { build(doc, spec); doc.end(); } catch (e) { reject(e); }
  });
}

function build(doc, spec) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right; const bottom = () => doc.page.height - doc.page.margins.bottom - 20;
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  // En-tête
  doc.font('Helvetica-Bold').fontSize(10).fillColor(ACCENT).text(clean(spec.org || ''), L, doc.y, { width: W });
  doc.moveDown(0.2).font('Helvetica-Bold').fontSize(20).fillColor(INK).text(clean(spec.title), { width: W });
  if (spec.subtitle) doc.moveDown(0.1).font('Helvetica').fontSize(11).fillColor(MUTED).text(clean(spec.subtitle), { width: W });
  doc.moveDown(0.4);
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(1.5).strokeColor(ACCENT).stroke();
  doc.moveDown(0.7);
  if (spec.meta && spec.meta.length) { kv(doc, spec.meta, L, W); doc.moveDown(0.6); }

  for (const b of spec.blocks || []) {
    if (b.type === 'heading') { ensure(40); doc.moveDown(0.4).font('Helvetica-Bold').fontSize(13).fillColor(INK).text(clean(b.text), L, doc.y, { width: W }); doc.moveDown(0.3); }
    else if (b.type === 'kv') { ensure(30); kv(doc, b.rows, L, W); doc.moveDown(0.4); }
    else if (b.type === 'text') { ensure(24); doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(clean(b.text), L, doc.y, { width: W }); doc.moveDown(0.4); }
    else if (b.type === 'note') { ensure(30); doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(clean(b.text), L, doc.y, { width: W }); doc.moveDown(0.4); }
    else if (b.type === 'space') doc.moveDown(0.8);
    else if (b.type === 'table') table(doc, b, L, W, ensure);
  }
  if (spec.footer) { ensure(40); doc.moveDown(0.6).font('Helvetica').fontSize(9).fillColor(MUTED).text(clean(spec.footer), L, doc.y, { width: W }); }

  // Pied de page sur chaque page : numéro et mention
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 34;
    // Le pied de page est sous la marge basse : sans ce réglage, pdfkit ajouterait une page vide à chaque ligne écrite ici.
    const mb = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(clean(`${spec.org || ''} · Brij-IA`), L, y, { width: W / 2, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} / ${range.count}`, L + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = mb;
  }
}

function kv(doc, rows, L, W) {
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(clean(k), L, y, { width: W * 0.34 });
    const h1 = doc.y - y;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(clean(v), L + W * 0.36, y, { width: W * 0.64 });
    doc.y = y + Math.max(h1, doc.y - y) + 3;
  }
}

function table(doc, b, L, W, ensure) {
  const cols = b.cols; const total = cols.reduce((a, c) => a + (c.width || 1), 0);
  const widths = cols.map((c) => W * (c.width || 1) / total);
  const head = () => {
    ensure(40);
    const y = doc.y;
    doc.rect(L, y, W, 20).fillColor('#eef2ff').fill();
    let x = L;
    cols.forEach((c, i) => { doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(clean(c.label), x + 4, y + 6, { width: widths[i] - 8, align: c.align || 'left', lineBreak: false }); x += widths[i]; });
    doc.y = y + 22;
  };
  head();
  for (const r of b.rows) {
    doc.font('Helvetica').fontSize(9.5);
    const cells = cols.map((c, i) => clean(r[c.key]));
    const h = Math.max(...cells.map((s, i) => doc.heightOfString(s, { width: widths[i] - 8 }))) + 8;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 20) { doc.addPage(); head(); }
    const y = doc.y; let x = L;
    cells.forEach((s, i) => { doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(s, x + 4, y + 4, { width: widths[i] - 8, align: cols[i].align || 'left' }); x += widths[i]; });
    doc.y = y + h;
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
  }
  doc.moveDown(0.5);
  if (b.totals && b.totals.length) {
    ensure(b.totals.length * 18 + 10);
    for (const [k, v, strong] of b.totals) {
      const y = doc.y;
      doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 11.5 : 10).fillColor(INK);
      doc.text(clean(k), L + W * 0.5, y, { width: W * 0.28, align: 'right', lineBreak: false });
      doc.text(clean(v), L + W * 0.78, y, { width: W * 0.22, align: 'right', lineBreak: false });
      doc.y = y + (strong ? 19 : 16);
    }
  }
  doc.moveDown(0.3);
}

const money = (n, cur) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} ${cur || ''}`.trim();
const dfr = (s) => (s ? String(s).split('-').reverse().join('/') : '');

module.exports = { render, clean, money, dfr };
