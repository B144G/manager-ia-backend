'use strict';
// Outils de texte de la Bibliothèque : normalisation (sans accents ni majuscules), mots, distance d'édition, Code 128 (étiquettes).

/** Minuscules sans accents ni ponctuation superflue. */
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'et', 'ou', 'en', 'au', 'aux', 'a', 'sur', 'dans', 'pour', 'par', 'the', 'of', 'and', 'to', 'in', 'on', 'for', 'der', 'die', 'das', 'und', 'el', 'los', 'las', 'y']);
const words = (s, { stop = true } = {}) => norm(s).split(' ').filter((w) => w && (!stop || !STOP.has(w)));

/** Distance de Levenshtein bornée (renvoie max+1 dès qu'elle dépasse max). */
function lev(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let min = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < min) min = cur[j];
    }
    if (min > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** Tolérance aux fautes selon la longueur du mot : 0 faute sous 4 lettres, 1 de 4 à 6, 2 au-delà. */
const tolerance = (w) => (w.length < 4 ? 0 : w.length < 7 ? 1 : 2);

// ---------- Code 128 (jeu B) ----------
const C128 = ('212222,222122,222221,121223,121322,131222,122213,122312,132212,221213,221312,231212,112232,122132,122231,113222,123122,123221,223211,221132,'
  + '221231,213212,223112,312131,311222,321122,321221,312212,322112,322211,212123,212321,232121,111323,131123,131321,112313,132113,132311,211313,'
  + '231113,231311,112133,112331,132131,113123,113321,133121,313121,211331,231131,213113,213311,213131,311123,311321,331121,312113,312311,332111,'
  + '314111,221411,431111,111224,111422,121124,121421,141122,141221,112214,112412,122114,122411,142112,142211,241211,221114,413111,241112,134111,'
  + '111242,121142,121241,114212,124112,124211,411212,421112,421211,212141,214121,412121,111143,111341,131141,114113,114311,411113,411311,113141,'
  + '114131,311141,411131,211412,211214,211232,2331112').split(',');
/** Valeurs des symboles d'un texte (ASCII 32 à 126) : démarrage B, données, somme de contrôle, arrêt. */
function code128Values(text) {
  const s = String(text);
  if (!s || s.length > 40 || /[^\x20-\x7e]/.test(s)) throw new Error('Texte non codable en Code 128.');
  const vals = [104]; let sum = 104;
  for (let i = 0; i < s.length; i++) { const v = s.charCodeAt(i) - 32; vals.push(v); sum += v * (i + 1); }
  vals.push(sum % 103, 106);
  return vals;
}
/** Code 128 en SVG (barres noires sur fond blanc), prêt à imprimer. */
function code128Svg(text, { height = 54, module: m = 2 } = {}) {
  const vals = code128Values(text);
  let x = 10 * m; const rects = [];
  for (const v of vals) {
    const p = C128[v]; let bar = true;
    for (const ch of p) { const w = Number(ch) * m; if (bar) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`); x += w; bar = !bar; }
  }
  const width = x + 10 * m;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${String(text).replace(/[<>&"]/g, '')}"><rect width="${width}" height="${height}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
}
// Contrôle du tableau au chargement : chaque symbole fait 11 modules (13 pour l'arrêt).
for (let i = 0; i < C128.length; i++) {
  const total = [...C128[i]].reduce((a, c) => a + Number(c), 0);
  if (total !== (i === 106 ? 13 : 11)) throw new Error(`Tableau Code 128 invalide au symbole ${i}`);
}

module.exports = { norm, words, lev, tolerance, STOP, code128Values, code128Svg, C128 };
