'use strict';
// Outils communs du groupe « work » (projets, bibliothèque, mémoire, juridique, organisation, équipe, intégrations, tableaux de bord).

/** Mot de passe du compte connecté (sert à déverrouiller les blocs de la Bibliothèque) : --pass, sinon celui de la démo locale. */
function password() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--pass');
  return i >= 0 && a[i + 1] ? a[i + 1] : 'Demo-Batimat-2026';
}

/** Petit PDF valide (une page, un titre) : assez pour les pièces jointes, l'aperçu et les versions. */
function pdf(title, lines = []) {
  const ascii = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, ' ').replace(/[()\\]/g, ' ');
  const body = [`BT /F1 16 Tf 50 790 Td (${ascii(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 11 Tf 50 ${760 - i * 18} Td (${ascii(l)}) Tj ET`)].join('\n');
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(body)}>>\nstream\n${body}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const txt = (s) => Buffer.from(s, 'utf8');

function helpers(ctx) {
  const M = ctx.ids.members || {};
  const has = (k) => Boolean(ctx.users[k]);
  /** userId d'un membre de l'équipe ; sur le site en ligne (pas de comptes créés) : le dirigeant. */
  const U = (k) => (M[k] && M[k].userId) || ctx.ids.ownerId;
  const q = (o) => '?' + Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  /** Appel brut (fichiers, CSV, PDF) : renvoie la réponse complète et vérifie le type renvoyé. */
  const file = async (feature, url, type, opts = {}) => {
    const r = await ctx.do(feature, 'GET', url, undefined, { ...opts, raw: true });
    if (r.status === 200 && type) ctx.check(`${feature} (contenu ${type})`, String(r.headers.get('content-type') || '').includes(type) && r.buf.length > 0, { type: r.headers.get('content-type'), size: r.buf.length });
    return r;
  };
  return { has, U, q, file };
}

module.exports = { password, pdf, txt, helpers };
