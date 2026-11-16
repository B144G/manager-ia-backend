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
  // La sauvegarde contient TOUTES les données : elle est chiffrée (AES-256-GCM) avec BACKUP_KEY, sinon DATA_KEY. Sans clé, on refuse d'écrire en clair (BACKUP_ALLOW_PLAIN=1 pour forcer).
  const secret = process.env.BACKUP_KEY || config.dataKey;
  let payload = zlib.gzipSync(JSON.stringify(out)); let finalFile = file;
  if (secret) { const crypto = require('crypto'); const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(secret, salt, 32), iv); const ct = Buffer.concat([c.update(payload), c.final()]); payload = Buffer.concat([Buffer.from('MIABK1'), salt, iv, c.getAuthTag(), ct]); finalFile = file + '.enc'; }
  else if (process.env.BACKUP_ALLOW_PLAIN !== '1') { console.error('Sauvegarde refusée : définissez BACKUP_KEY (ou DATA_KEY) pour la chiffrer, ou BACKUP_ALLOW_PLAIN=1 pour l\'écrire en clair.'); await db.close(); process.exit(1); }
  fs.writeFileSync(finalFile, payload, { mode: 0o600 });
  const all = fs.readdirSync(dir).filter((f) => /^manager-ia-.*\.json\.gz(\.enc)?$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, old));
  const total = Object.values(out.tables).reduce((a, r) => a + r.length, 0);
  console.log(`Sauvegarde OK : ${finalFile} (${Math.round(fs.statSync(finalFile).size / 1024)} Ko, ${tables.length} tables, ${total} lignes, ${Math.min(all.length, keep)} copie(s) conservée(s))`);
  await db.close();
})().catch((e) => { console.error('Échec de la sauvegarde :', e.message); process.exit(1); });
