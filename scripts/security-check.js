'use strict';
// Contrôle de la configuration de sécurité : npm run security:check
// Code de sortie 1 s'il reste un point « dangereux » (utile avant une mise en ligne ou dans une vérification automatique).
require('dotenv').config({ quiet: true });
const { db } = require('../src/db');
const central = require('../src/security');

(async () => {
  await db.ready;
  const r = await central.configcheck.run();
  const mark = { ok: '  OK    ', warn: '  AMÉLIORER', bad: '  DANGER ' };
  console.log('\nContrôle de sécurité Brij-IA\n');
  for (const x of r.items) console.log(`${mark[x.level]} ${x.title}\n          ${x.text}`);
  const v = await central.audit.verify();
  console.log(`\n  ${v.ok ? 'OK    ' : 'DANGER '} Journal d'audit : ${v.ok ? `${v.checked} ligne(s), chaîne intacte` : `chaîne rompue à la ligne ${v.brokenAt}`}`);
  console.log(`\n${r.summary.ok} solide(s), ${r.summary.warn} à améliorer, ${r.summary.bad} dangereux.\n`);
  await db.close();
  process.exit(r.summary.bad || !v.ok ? 1 : 0);
})().catch((e) => { console.error('Contrôle impossible :', e.message); process.exit(1); });
