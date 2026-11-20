'use strict';
// Intégrité des migrations après la fusion des modules : ordre figé (append-only), aucun doublon, rejouabilité des migrations des modules.
// Usage : node scripts/test-migrations.js   (base PGlite en mémoire, aucun réseau)
process.env.DATABASE_URL = 'pglite://memory';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secret-de-test-assez-long-123456';
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, MIGRATIONS } = require('../src/db');

// Empreinte du tableau de la base de la fusion (fusion-stock-serveur, 78 migrations) : si elle change, une migration existante a été modifiée ou réordonnée.
const BASE_COUNT = 78;
const BASE_HASH = '61febeb02b572e5413690406d79f86d96384d6a8';

let ok = 0; let ko = 0;
const check = (name, cond, detail) => { if (cond) { ok++; console.log('  OK  ', name); } else { ko++; console.log('  ECHEC', name, detail !== undefined ? '-> ' + JSON.stringify(detail) : ''); } };

(async () => {
  console.log('Migrations : ordre figé, doublons, rejouabilité');
  check(`les ${BASE_COUNT} premières migrations sont inchangées (empreinte de la base)`, crypto.createHash('sha1').update(MIGRATIONS.slice(0, BASE_COUNT).join('\u0000')).digest('hex') === BASE_HASH);
  check('aucune migration en double dans le tableau', new Set(MIGRATIONS).size === MIGRATIONS.length, MIGRATIONS.length - new Set(MIGRATIONS).size);
  await db.ready;
  const n = Number((await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n);
  check('toutes les migrations sont appliquées sur une base neuve', n === MIGRATIONS.length, [n, MIGRATIONS.length]);
  // Tables / index / colonnes déclarés par plusieurs fichiers de modules.
  const dir = path.join(__dirname, '..', 'src', 'migrations');
  const seen = { table: {}, index: {}, column: {} };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of s.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?!IF\b)(\w+)/gi)) (seen.table[m[1].toLowerCase()] ||= new Set()).add(f);
    for (const m of s.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(?!IF\b)(\w+)/gi)) (seen.index[m[1].toLowerCase()] ||= new Set()).add(f);
    for (const m of s.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)) (seen.column[`${m[1]}.${m[2]}`.toLowerCase()] ||= new Set()).add(f);
  }
  for (const k of Object.keys(seen)) {
    const dup = Object.entries(seen[k]).filter(([, v]) => v.size > 1).map(([name, v]) => `${name}: ${[...v].join(', ')}`);
    check(`aucun(e) ${k} créé(e) par deux fichiers de modules`, dup.length === 0, dup);
  }
  check('Transport · géolocalisation : migrations 140 (tables tg_) et 141 (clients / fournisseurs typés) ; 116 à 139 réservées (Avis = 116)', /tg_settings/.test(MIGRATIONS[139] || '') && /pty_terms/.test(MIGRATIONS[140] || '') && MIGRATIONS.slice(115, 139).every((m) => /^SELECT \d+ AS reserve$/.test(m) || /fb_|reserve/.test(m)));
  // Rejouabilité : les migrations ajoutées par la fusion (indice >= BASE_COUNT) doivent pouvoir être rejouées sans erreur (IF NOT EXISTS partout).
  let failed = null;
  for (let i = BASE_COUNT; i < MIGRATIONS.length && !failed; i++) { try { await db.exec(MIGRATIONS[i]); } catch (e) { failed = `migration ${i + 1} : ${e.message}`; } }
  check(`les ${MIGRATIONS.length - BASE_COUNT} migrations ajoutées se rejouent sans erreur (rejouables)`, !failed, failed);
  // Aucune instruction destructive dans les migrations ajoutées.
  const bad = MIGRATIONS.slice(BASE_COUNT).map((m, i) => [i + BASE_COUNT + 1, m]).filter(([, m]) => /\bDROP\s+(TABLE|COLUMN|INDEX|SCHEMA)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|RENAME\s+(TO|COLUMN)/i.test(m.replace(/--[^\n]*/g, ''))).map(([i]) => i);
  check('aucune migration destructive ajoutée (DROP / TRUNCATE / DELETE / RENAME)', bad.length === 0, bad);
  console.log(`\n${ok} réussis, ${ko} échoués`);
  try { await db.close(); } catch { /* */ }
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
