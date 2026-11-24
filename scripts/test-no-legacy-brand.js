'use strict';
// Renommage MABAH : plus aucune occurrence de l'ancien nom hors liste blanche, nom de l'assistant « MABAH IA », prompts sans prétention d'être humain,
// logo en place, e-mail HTML de la plateforme, références de paiement (anciennes BRIJ- toujours lues, nouvelles MABAH-).
// Lancez-le avec : node scripts/test-no-legacy-brand.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

(async () => {
  const RB = await import(path.join(root, 'scripts/rename-brand.mjs'));
  console.log('Renommage MABAH (serveur)');
  // 1. liste blanche
  let bad = []; let changed = [];
  for (const f of RB.listFiles(root)) {
    if (RB.skipped(f)) continue;
    const abs = path.join(root, f); const b = fs.readFileSync(abs); if (b.includes(0)) continue;
    const t = b.toString('utf8');
    for (const l of RB.leftovers(t)) bad.push(`${f}:${l.line} ${l.text.slice(0, 80)}`);
    if (RB.transform(f, t).out !== t) changed.push(f);
  }
  check('aucune occurrence de « Brij » hors liste blanche (URL techniques, sel de chiffrement, UID .ics, mots de passe de démonstration, historique)', bad.length === 0, bad.slice(0, 5));
  check('le script de renommage est idempotent : le rejouer ne change plus aucun fichier', changed.length === 0, changed.slice(0, 5));
  check('l\'historique des migrations n\'a pas été touché', !fs.readdirSync(path.join(root, 'src/migrations')).some((f) => /mabah/i.test(fs.readFileSync(path.join(root, 'src/migrations', f), 'utf8'))));
  // 2. point central
  const P = require('../src/services/product');
  check('product.js : nom MABAH, assistant « MABAH IA », expéditeur MABAH', P.name === 'MABAH' && P.assistantName === 'MABAH IA' && P.mailFromName === 'MABAH', P);
  check('product.js : adresse publique = https://mabah.vercel.app (SITE_URL prioritaire) ; ancienne adresse gardée dans legacyUrls', (Boolean(process.env.SITE_URL) || P.publicUrl === 'https://mabah.vercel.app') && P.legacyUrls.includes('https://brij-ia.vercel.app'), [P.publicUrl, P.legacyUrls]);
  const { spawnSync } = require('child_process');
  const cfg = spawnSync(process.execPath, ['-e', "const c=require('./src/config'); console.log(JSON.stringify(c.allowedOrigins))"], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'development', DATABASE_URL: 'postgres://x', ALLOWED_ORIGINS: 'https://mabah.vercel.app,https://brij-ia.vercel.app' } });
  check('CORS : pendant la transition, le serveur accepte les deux origines listées dans ALLOWED_ORIGINS', /mabah\.vercel\.app/.test(cfg.stdout) && /brij-ia\.vercel\.app/.test(cfg.stdout), cfg.stdout + cfg.stderr);
  check('product.js : les noms réservés gardent l\'ancien et le nouveau nom', P.reservedTokens.includes('mabah') && P.reservedTokens.includes('brij'), P.reservedTokens);
  // 3. invites de l'IA
  const WP = fs.readFileSync(path.join(root, 'src/ai/workspace-prompts.js'), 'utf8');
  const CL = fs.readFileSync(path.join(root, 'src/services/claude.js'), 'utf8');
  const SA = fs.readFileSync(path.join(root, 'src/ai/sales-agent.js'), 'utf8');
  check('l\'IA de gestion s\'appelle MABAH IA et ne prétend jamais être humaine', /Tu es MABAH IA/.test(WP) && /ne prétends jamais être une personne ni un humain/.test(WP));
  check('l\'assistant du site s\'appelle MABAH IA et ne prétend jamais être humain', /Tu es MABAH IA/.test(CL) && /ne prétends jamais être une personne ni un humain/.test(CL));
  check('l\'assistant commercial public ne prétend jamais être humain', /ne prétends jamais être|jamais prétendre être/i.test(SA));
  // 4. PDF
  const pdf = require('../src/services/pdf');
  const buf = await pdf.render({ title: 'Essai', org: 'Entreprise Test', blocks: [{ type: 'text', text: 'Bonjour' }] }, { compress: false });
  const txt = buf.toString('latin1');
  check('PDF : créateur et pied de page MABAH (pas Brij), logo intégré', /MABAH/.test(txt) && !/Brij/i.test(txt) && /\/Subtype \/Image/.test(txt));
  // 5. e-mail HTML de la plateforme
  const mh = require('../src/services/mail-html');
  const h = mh.platform('Sujet', 'Bonjour Awa,\n\nVotre code : 123456\n\nhttps://exemple.com/x?a=1&b=2');
  check('e-mail de la plateforme : logo MABAH, texte échappé, lien cliquable', /icon-192\.png/.test(h) && />MABAH</.test(h) && /&amp;b=2/.test(h) && /<a href="https:\/\/exemple\.com/.test(h), h.slice(0, 200));
  const notify = fs.readFileSync(path.join(root, 'src/services/notify.js'), 'utf8');
  check('sendMail : ajoute la version HTML aux e-mails de la plateforme seulement (pas à ceux envoyés au nom d\'une entreprise)', /!html && !fromName && text/.test(notify));
  // 6. logo
  const must = ['admin/img/logo-mabah-192.png', 'admin/img/favicon-32.png', 'src/assets/mabah-logo-128.png'];
  check('logo et favicon de l\'administration présents', must.every((f) => fs.existsSync(path.join(root, f))));
  const adm = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
  check('administration : titre, logo et favicon MABAH', /<title>Administration MABAH<\/title>/.test(adm) && /logo-mabah-192\.png/.test(adm) && /favicon-32\.png/.test(adm));
  // 7. références de paiement
  const pay = fs.readFileSync(path.join(root, 'src/routes/payments.js'), 'utf8');
  check('paiements : les nouvelles références commencent par MABAH-', /'MABAH-' \+ String\(crypto/.test(pay));
  console.log(`\n${passed} OK, ${failed} échec(s)`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
