'use strict';
// Démarrage en production : seuils A (bloquants), seuils B (avertissement, bloquants seulement avec STRICT_PROD_CONFIG=1).
// Lancez-le avec : node scripts/test-config-prod.js
const { spawnSync } = require('child_process');
const path = require('path');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const boot = (env) => {
  const clean = { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ...env };
  const r = spawnSync(process.execPath, ['-e', "require('./src/config'); console.log('BOOT-OK')"], { cwd: path.join(__dirname, '..'), env: clean, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const good = { JWT_SECRET: 'j'.repeat(48), ADMIN_PASSWORD: 'MotDePasseSolide-2026', DATA_KEY: 'd'.repeat(48), ALLOWED_ORIGINS: 'https://brij-ia.example.com' };

console.log('Configuration de production : seuils et STRICT_PROD_CONFIG');
let r = boot(good);
check('configuration saine : démarre sans avertissement de sécurité', r.code === 0 && r.out.includes('BOOT-OK') && !/AVERTISSEMENT SÉCURITÉ/.test(r.out), r.out.slice(0, 200));
r = boot({ ...good, JWT_SECRET: 'court-mais-seize-ok' });
check('JWT_SECRET de 19 caractères : démarre (le site déjà déployé ne tombe pas) avec un avertissement très visible', r.code === 0 && /AVERTISSEMENT SÉCURITÉ.*JWT_SECRET fait 19/s.test(r.out), r.out.slice(0, 300));
r = boot({ ...good, JWT_SECRET: 'court-mais-seize-ok', STRICT_PROD_CONFIG: '1' });
check('…mais STRICT_PROD_CONFIG=1 : refusé', r.code === 1 && /STRICT_PROD_CONFIG/.test(r.out), [r.code]);
r = boot({ ...good, JWT_SECRET: 'trop-court' });
check('JWT_SECRET de 10 caractères : refusé (seuil de la ligne A, inchangé)', r.code === 1, [r.code]);
r = boot({ ...good, ADMIN_PASSWORD: 'onze-chars-' });
check('ADMIN_PASSWORD de 11 caractères : avertissement, démarre', r.code === 0 && /ADMIN_PASSWORD fait 11/.test(r.out), r.out.slice(0, 200));
r = boot({ ...good, ADMIN_PASSWORD: 'onze-chars-', STRICT_PROD_CONFIG: '1' });
check('…STRICT_PROD_CONFIG=1 : refusé', r.code === 1, [r.code]);
r = boot({ ...good, ADMIN_PASSWORD: 'court' });
check('ADMIN_PASSWORD de 5 caractères : refusé (seuil de la ligne A)', r.code === 1, [r.code]);
r = boot({ ...good, ALLOWED_ORIGINS: '*' });
check('ALLOWED_ORIGINS en joker : avertissement, démarre', r.code === 0 && /ALLOWED_ORIGINS/.test(r.out), r.out.slice(0, 200));
r = boot({ ...good, ALLOWED_ORIGINS: 'http://site.example.com', STRICT_PROD_CONFIG: '1' });
check('…adresse http:// avec STRICT_PROD_CONFIG=1 : refusé', r.code === 1, [r.code]);
r = boot({ ...good, ALLOWED_ORIGINS: 'http://localhost:5173,https://brij-ia.example.com', STRICT_PROD_CONFIG: '1' });
check('http://localhost reste permis même en mode strict', r.code === 0, r.out.slice(0, 200));
r = boot({ ...good, DATA_KEY: '' });
check('DATA_KEY absent : avertissement, dérivation de JWT_SECRET comme avant', r.code === 0 && /DATA_KEY absent/.test(r.out), r.out.slice(0, 200));

console.log(`\n${passed} réussis, ${failed} échoués`);
process.exit(failed ? 1 : 0);
