'use strict';
// Reprend les données d'une ancienne base SQLite (data/manager-ia.db) dans PostgreSQL (Neon). À lancer UNE fois, sur une base PostgreSQL vide :
//   npm i --no-save better-sqlite3
//   npm run db:import-sqlite -- chemin/vers/manager-ia.db
// L'ancien fichier n'est jamais modifié (lecture seule). Les identifiants sont conservés, les compteurs automatiques sont recalés.
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const { db } = require('../src/db');

const file = path.resolve(process.argv[2] || 'data/manager-ia.db');
if (!fs.existsSync(file)) { console.error(`Fichier introuvable : ${file}\nUsage : npm run db:import-sqlite -- chemin/vers/manager-ia.db`); process.exit(1); }
let Sqlite;
try { Sqlite = require('better-sqlite3'); } catch { console.error('Installez d\'abord le lecteur SQLite (temporaire) :  npm i --no-save better-sqlite3'); process.exit(1); }

(async () => {
  await db.ready;
  const src = new Sqlite(file, { readonly: true, fileMustExist: true });
  const names = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const pgTables = new Set((await db.prepare("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()").all()).map((r) => r.t));
  const tables = names.filter((n) => pgTables.has(n) && n !== 'schema_migrations');
  // ordre : les tables dont dépendent les autres (clés étrangères) d'abord
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const r of await db.prepare("SELECT tc.table_name AS t, ccu.table_name AS ref FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()").all()) if (deps.has(r.t) && r.ref !== r.t) deps.get(r.t).add(r.ref);
  const order = []; const seen = new Set();
  const visit = (t) => { if (seen.has(t)) return; seen.add(t); for (const d of deps.get(t) || []) if (deps.has(d)) visit(d); order.push(t); };
  tables.forEach(visit);
  let total = 0;
  await db.transaction(async () => {
    for (const t of order) {
      const rows = src.prepare(`SELECT * FROM "${t}"`).all();
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const sql = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      const st = db.prepare(sql);
      for (const r of rows) await st.run(...cols.map((c) => r[c]));
      total += rows.length;
      const hasId = cols.includes('id');
      if (hasId) await db.prepare(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), COALESCE((SELECT MAX(id) FROM "${t}"), 1))`).get();
      console.log(`  ${t} : ${rows.length} ligne(s)`);
    }
  })();
  console.log(`\nImport terminé : ${total} ligne(s) dans ${order.length} table(s).`);
  src.close();
  await db.close();
})().catch((e) => { console.error('Import impossible (rien n\'a été écrit) :', e.message); process.exit(1); });
