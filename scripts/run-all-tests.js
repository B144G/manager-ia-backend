'use strict';
// Lance TOUS les tests de la chaîne « test:chain » de package.json, l'un après l'autre, sans s'arrêter au premier échec.
// Un test qui échoue est relancé une fois (démarrages de serveur lents quand la machine est chargée) : l'échec persistant est signalé.
// Usage : node scripts/run-all-tests.js [filtre]   — le filtre ne garde que les étapes dont la commande contient ce texte.
const { spawnSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

const chain = pkg.scripts['test:chain'] || pkg.scripts.test;
const filter = process.argv[2];
const steps = chain.split('&&').map((s) => s.trim()).filter(Boolean).filter((s) => !filter || s.includes(filter));
const root = path.join(__dirname, '..');
const results = [];
const t0 = Date.now();
for (const cmd of steps) {
  let ok = false; let tries = 0; let last = '';
  while (!ok && tries < 2) {
    tries++;
    const t = Date.now();
    console.log(`\n===== ${cmd}${tries > 1 ? ' (2e essai)' : ''} =====`);
    const r = spawnSync('sh', ['-c', cmd], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    ok = r.status === 0;
    last = `${Math.round((Date.now() - t) / 1000)} s`;
    if (!ok) console.log(`>>> ÉCHEC (${cmd}) code ${r.status}`);
  }
  results.push({ cmd, ok, tries, last });
}
console.log('\n===== RÉSUMÉ =====');
for (const r of results) console.log(`${r.ok ? 'OK    ' : 'ÉCHEC '} ${r.cmd}  (${r.last}${r.tries > 1 ? `, ${r.tries} essais` : ''})`);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} étapes réussies en ${Math.round((Date.now() - t0) / 1000)} s${bad.length ? ` — ${bad.length} ÉCHEC(S)` : ''}`);
process.exit(bad.length ? 1 : 0);
