#!/usr/bin/env node
/* Remplace le logo et les icônes par ceux de MABAH, partout. REJOUABLE et IDEMPOTENT (mêmes octets à chaque passage), à lancer après rename-brand.mjs.
   Usage : node scripts/apply-logo.mjs [--from ~/Downloads/Logo-MABAH] [--dry-run]
   Le même fichier sert au serveur et au site (mode détecté). Source : le dossier du fondateur (icon-512/192/180/64/32.png, logo-mabah-transparent-1024.png).

   SITE : public/favicon.svg et public/logo.svg (enveloppes SVG qui intègrent le PNG : le logo est un dessin d'image, pas un vrai vectoriel),
          public/assets/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon,favicon-32,favicon-64}.png, public/assets/og-mabah.png (aperçu de partage 1200x630),
          liens d'icônes de index.html, redirections apple-touch de vercel.json, version du cache du service worker.
   SERVEUR : admin/img/*, favicon et logo de l'administration, logo en pied de page des PDF (src/assets), e-mails de la plateforme en HTML avec le logo (src/services/mail-html.js).
   Les rendus qui demandent un navigateur (icône « maskable », image de partage) utilisent puppeteer-core + Google Chrome (variables PUPPETEER_CORE et CHROME_PATH).
   Si une ancre de code est introuvable (code modifié par une autre branche), le script l'écrit en « ATTENTION » au lieu d'échouer : voir docs/renommage-mabah.md. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const dry = argv.includes('--dry-run');
const root = process.cwd();
const kind = fs.existsSync(path.join(root, 'vite.config.js')) ? 'site' : 'serveur';
const from = (val('--from') || path.join(os.homedir(), 'Downloads/Logo-MABAH')).replace(/^~/, os.homedir());
const warn = [];
const done = [];

const need = ['icon-512.png', 'icon-192.png', 'icon-180.png', 'icon-64.png', 'icon-32.png', 'logo-mabah-transparent-1024.png'];
for (const f of need) if (!fs.existsSync(path.join(from, f))) { console.error(`Fichier manquant dans ${from} : ${f}`); process.exit(2); }
const src = (f) => fs.readFileSync(path.join(from, f));

function put(rel, buf) {
  const abs = path.join(root, rel);
  const same = fs.existsSync(abs) && Buffer.compare(fs.readFileSync(abs), Buffer.isBuffer(buf) ? buf : Buffer.from(buf)) === 0;
  if (same) return;
  done.push(rel);
  if (!dry) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); }
}
function edit(rel, fn, anchorName) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { warn.push(`${rel} : fichier absent (${anchorName})`); return; }
  const a = fs.readFileSync(abs, 'utf8'); const b = fn(a);
  if (b === null) { warn.push(`${rel} : ancre introuvable (${anchorName}) : à reporter à la main`); return; }
  if (b !== a) { done.push(rel); if (!dry) fs.writeFileSync(abs, b); }
}

/* Rendu par navigateur (icône maskable, image de partage). */
async function render(html, w, h, out) {
  const pp = process.env.PUPPETEER_CORE || '/Users/macboockpro/Downloads/MANAGER-IA/video-brij-ia-problemes/node_modules/puppeteer-core';
  const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const puppeteer = createRequire(import.meta.url)(pp);
  const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    const p = await b.newPage(); await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await p.setContent(html, { waitUntil: 'load' });
    return await p.screenshot({ type: 'png', omitBackground: false, clip: { x: 0, y: 0, width: w, height: h } });
  } finally { await b.close(); }
  void out;
}
const dataUri = (buf) => 'data:image/png;base64,' + buf.toString('base64');
const svgWrap = (buf, label) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512" role="img" aria-label="${label}"><image width="512" height="512" href="${dataUri(buf)}" xlink:href="${dataUri(buf)}"/></svg>\n`;

async function site() {
  put('public/assets/icons/icon-192.png', src('icon-192.png'));
  put('public/assets/icons/icon-512.png', src('icon-512.png'));
  put('public/assets/icons/apple-touch-icon.png', src('icon-180.png'));
  put('public/assets/icons/favicon-64.png', src('icon-64.png'));
  put('public/assets/icons/favicon-32.png', src('icon-32.png'));
  // Enveloppes SVG : tuile claire arrondie (lisible en thème clair comme en thème sombre : c'est la « pastille claire »)
  put('public/favicon.svg', svgWrap(src('icon-192.png'), 'MABAH'));
  put('public/logo.svg', svgWrap(src('icon-192.png'), 'MABAH'));
  if (!dry || fs.existsSync(path.join(root, 'public/assets/icons/icon-maskable-512.png'))) {
    const t = dataUri(src('logo-mabah-transparent-1024.png'));
    const mask = await render(`<body style="margin:0;background:#fff;width:512px;height:512px;display:grid;place-items:center"><img src="${t}" style="width:352px;height:352px;object-fit:contain"></body>`, 512, 512);
    put('public/assets/icons/icon-maskable-512.png', mask);
    const og = await render(`<body style="margin:0;width:1200px;height:630px;background:linear-gradient(135deg,#080b26,#10154a 60%,#0a2a7a);font-family:'Inter',system-ui,-apple-system,'Segoe UI',Arial,sans-serif;color:#fff;display:flex;align-items:center;padding:0 90px;box-sizing:border-box;gap:56px">
      <img src="${dataUri(src('icon-512.png'))}" style="width:280px;height:280px;flex:none;border-radius:56px;box-shadow:0 30px 80px rgba(0,0,0,.45)">
      <div><div style="font-size:112px;font-weight:800;letter-spacing:-.03em;line-height:1">MABAH</div>
      <div style="font-size:44px;font-weight:600;line-height:1.2;margin-top:22px;max-width:640px">Pilotez votre entreprise avec le meilleur outil.</div>
      <div style="font-size:28px;color:#aeb6dc;margin-top:22px">ERP de gestion d'entreprise, avec MABAH IA en renfort</div></div></body>`, 1200, 630);
    put('public/assets/og-mabah.png', og);
  }
  edit('index.html', (a) => {
    if (!/<link rel="icon"/.test(a)) return null;
    let b = a;
    if (!/favicon-32\.png/.test(b)) b = b.replace(/(<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">)/, '$1\n<link rel="icon" href="/assets/icons/favicon-32.png" type="image/png" sizes="32x32">');
    b = b.replace(/<link rel="apple-touch-icon" sizes="192x192" href="\/assets\/icons\/icon-192\.png">\n<link rel="apple-touch-icon" sizes="512x512" href="\/assets\/icons\/icon-512\.png">/, '<link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/apple-touch-icon.png">');
    return b;
  }, 'liens d\'icônes');
  edit('public/offline.html', (a) => {
    if (/<img[^>]+favicon\.svg/.test(a)) return a;
    return /<main>\n  <h1>/.test(a) ? a.replace('<main>\n  <h1>', '<main>\n  <img src="/favicon.svg" alt="MABAH" width="56" height="56" style="border-radius:14px;margin-bottom:12px">\n  <h1>') : null;
  }, 'page hors-ligne');
  edit('public/sw.js', (a) => {
    const m = /var CACHE_VERSION = (\d+);/.exec(a); if (!m) return null;
    let b = Number(m[1]) < 6 ? a.replace(m[0], 'var CACHE_VERSION = 6;') : a; // nouvelle version : les anciens favicons/logos en cache sont supprimés
    if (!/favicon-32\.png/.test(b)) b = b.replace('"/assets/icons/icon-192.png"]', '"/assets/icons/icon-192.png", "/assets/icons/favicon-32.png"]');
    return b;
  }, 'version du cache');
  edit('vercel.json', (a) => a.replace(/("source": "\/apple-touch-icon(?:-precomposed)?\.png", "destination": ")\/assets\/icons\/icon-192\.png"/g, '$1/assets/icons/apple-touch-icon.png"'), 'redirections apple-touch');
}

const LOGO_CSS_MARK = '/* logo MABAH (administration) */';
const MAIL_HTML = `'use strict';
// E-mails de la plateforme (compte, mot de passe, paiement, alertes) : une version HTML simple avec le logo MABAH au-dessus du texte (créé par scripts/apply-logo.mjs).
// Le texte brut reste envoyé tel quel (c'est lui que lisent les clients de messagerie sans HTML). Le logo est lu sur l'adresse publique du site.
const PRODUCT = require('./product');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = () => String(process.env.SITE_URL || PRODUCT.publicUrl).replace(/\\/+$/, '');

/** Transforme un texte brut en HTML : paragraphes, retours à la ligne, liens cliquables. */
function body(text) {
  return String(text == null ? '' : text).split(/\\n{2,}/).map((p) => \`<p style="margin:0 0 14px">\${esc(p).replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" style="color:#0b5fd6">$1</a>').replace(/\\n/g, '<br>')}</p>\`).join('');
}

/** HTML d'un e-mail de la plateforme (sujet, texte brut). */
function platform(subject, text) {
  return '<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.55">'
    + '<div style="max-width:600px;margin:0 auto;padding:20px 16px"><div style="background:#ffffff;border:1px solid #dfe3ec;border-radius:14px;padding:22px">'
    + \`<div style="margin:0 0 16px"><img src="\${esc(base())}/assets/icons/icon-192.png" width="40" height="40" alt="\${esc(PRODUCT.name)}" style="vertical-align:middle;border:1px solid #dfe3ec;border-radius:9px"> <span style="font-size:20px;font-weight:700;letter-spacing:-.02em;vertical-align:middle;margin-left:8px">\${esc(PRODUCT.name)}</span></div>\`
    + body(text) + '</div></div></body></html>';
}

module.exports = { platform, body };
`;

function serveur() {
  put('admin/img/logo-mabah-192.png', src('icon-192.png'));
  put('admin/img/favicon-32.png', src('icon-32.png'));
  put('src/assets/mabah-logo-128.png', src('icon-192.png'));
  put('src/services/mail-html.js', MAIL_HTML);
  edit('admin/index.html', (a) => {
    let b = a.replace('<link rel="icon" href="data:,">', '<link rel="icon" type="image/png" href="/admin/img/favicon-32.png">');
    b = b.replace(/<div class="(logo|logo-m)">MABAH<\/div>/g, (m, c) => `<div class="${c}"><img src="/admin/img/logo-mabah-192.png" alt="" width="${c === 'logo' ? 30 : 26}" height="${c === 'logo' ? 30 : 26}"><span>MABAH</span></div>`);
    return b;
  }, 'logo de la page de connexion');
  edit('admin/admin.js', (a) => {
    if (/logo-mabah-192/.test(a)) return a;
    const re = /h\('a', \{ href: '#\/overview', 'aria-label': '([^']*)' \}, 'MABAH'\)/;
    if (!re.test(a)) return null;
    return a.replace(re, "h('a', { href: '#/overview', 'aria-label': '$1', class: 'brand-a' }, h('img', { src: '/admin/img/logo-mabah-192.png', alt: '', width: 26, height: 26 }), 'MABAH')");
  }, 'logo du menu de l\'administration');
  edit('admin/admin.css', (a) => (a.includes(LOGO_CSS_MARK) ? a : a + `\n${LOGO_CSS_MARK}\n.logo,.logo-m,.brand-a{display:inline-flex;align-items:center;gap:10px}.logo img,.logo-m img,.brand-a img{border-radius:7px;flex:none;display:block}\n`), 'feuille de style');
  edit('src/services/pdf.js', (a) => {
    if (/mabah-logo-128/.test(a)) return a;
    const foot2 = /doc\.text\(clean\(footerLeft\(spec, brand\)\), L, y, \{ width: W \/ 2, lineBreak: false \}\);/; // branche « marque d'entreprise » : le logo n'apparaît que si le pied cite MABAH
    if (foot2.test(a)) {
      let c = a.replace(foot2, "const fl = clean(footerLeft(spec, brand)); const withLogo = fl.includes(PRODUCT.name);\n    if (withLogo) { try { doc.image(LOGO_FILE, L, y - 2, { width: 11 }); } catch { /* logo absent : pied sans image */ } }\n    doc.text(fl, withLogo ? L + 15 : L, y, { width: W / 2 - (withLogo ? 15 : 0), lineBreak: false });");
      return c.replace("const PDFDocument = require('pdfkit');", "const PDFDocument = require('pdfkit');\nconst LOGO_FILE = require('path').join(__dirname, '..', 'assets', 'mabah-logo-128.png'); // logo MABAH (pied de page)");
    }
    const foot = /doc\.text\(clean\(`\$\{spec\.org \|\| ''\} · ([^`]*)`\), L, y, \{ width: W \/ 2, lineBreak: false \}\);/;
    if (!foot.test(a)) return null;
    let b = a.replace(foot, (m, rest) => "try { doc.image(LOGO_FILE, L, y - 2, { width: 11 }); } catch { /* logo absent : pied sans image */ }\n    doc.text(clean(`${spec.org || ''} · " + rest + "`), L + 15, y, { width: W / 2 - 15, lineBreak: false });");
    b = b.replace("const PDFDocument = require('pdfkit');", "const PDFDocument = require('pdfkit');\nconst LOGO_FILE = require('path').join(__dirname, '..', 'assets', 'mabah-logo-128.png'); // logo MABAH (pied de page)");
    return b;
  }, 'pied de page des PDF');
  edit('src/services/notify.js', (a) => {
    if (/mail-html/.test(a)) return a;
    const re = /(async function sendMail\(\{ to, subject, text, html, headers, replyTo, fromName, attachments \}\) \{\n)/;
    if (!re.test(a)) return null;
    return a.replace(re, "$1  if (!html && !fromName && text) html = require('./mail-html').platform(subject, text); // e-mail de la plateforme : version HTML avec le logo\n");
  }, 'envoi des e-mails');
}

(async () => {
  if (kind === 'site') await site(); else serveur();
  console.log(`${dry ? 'SIMULATION : ' : ''}Logo MABAH (${kind}) : ${done.length} fichier(s) ${dry ? 'à écrire' : 'écrits ou modifiés'}.`);
  for (const f of done) console.log('  ' + f);
  for (const w of warn) console.log('ATTENTION ' + w);
  if (!done.length && !warn.length) console.log('Aucun changement : le logo est déjà en place.');
})().catch((e) => { console.error(e); process.exit(1); });
void pathToFileURL;
