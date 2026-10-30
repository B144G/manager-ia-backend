'use strict';
// Sauvegarde logique de la base PostgreSQL : un fichier .json.gz par sauvegarde (toutes les tables). Lancez : npm run backup
// Les copies vont dans BACKUP_DIR (par défaut data/backups) ; on garde les BACKUP_KEEP plus récentes (14 par défaut).
// Sur Neon, la restauration à un instant précis (« Restore ») et les branches sont la première protection ; ceci est une copie de plus, chez vous.
// Pour une restauration complète en SQL, vous pouvez aussi utiliser pg_dump :  pg_dump "$DATABASE_URL_UNPOOLED" -Fc -f sauvegarde.dump
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../src/config');
const { db } = require('../src/db');

(async () => {
  await db.ready;
  const dir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(config.ROOT, 'data', 'backups');
  const keep = Math.max(parseInt(process.env.BACKUP_KEEP, 10) || 14, 1);
  fs.mkdirSync(dir, { recursive: true });
  const tables = (await db.prepare("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name").all()).map((r) => r.t);
  const out = { format: 'manager-ia-backup', version: 1, at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    const rows = await db.prepare(`SELECT * FROM "${t}"`).all();
    out.tables[t] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) || v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : v])));
  }
  const file = path.join(dir, `manager-ia-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out)), { mode: 0o600 });
  const all = fs.readdirSync(dir).filter((f) => /^manager-ia-.*\.json\.gz$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, old));
  const total = Object.values(out.tables).reduce((a, r) => a + r.length, 0);
  console.log(`Sauvegarde OK : ${file} (${Math.round(fs.statSync(file).size / 1024)} Ko, ${tables.length} tables, ${total} lignes, ${Math.min(all.length, keep)} copie(s) conservée(s))`);
  await db.close();
})().catch((e) => { console.error('Échec de la sauvegarde :', e.message); process.exit(1); });
