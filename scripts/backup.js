'use strict';
// Sauvegarde de la base (copie cohérente, même pendant que le serveur tourne). Lancez : npm run backup
// Les copies vont dans BACKUP_DIR (par défaut data/backups) ; on garde les BACKUP_KEEP plus récentes (14 par défaut).
// Astuce : planifiez-la chaque nuit (cron) et copiez le dossier ailleurs (autre disque, stockage en ligne).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

(async () => {
  const dir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(path.dirname(config.dbPath), 'backups');
  const keep = Math.max(parseInt(process.env.BACKUP_KEEP, 10) || 14, 1);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `manager-ia-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  const src = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  await src.backup(file);
  src.close();
  const chk = new Database(file, { readonly: true });
  const ok = chk.pragma('integrity_check', { simple: true });
  chk.close();
  if (ok !== 'ok') { console.error('Sauvegarde corrompue :', ok); process.exit(1); }
  const all = fs.readdirSync(dir).filter((f) => /^manager-ia-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, old));
  console.log(`Sauvegarde OK : ${file} (${Math.round(fs.statSync(file).size / 1024)} Ko, ${Math.min(all.length, keep)} copie(s) conservée(s))`);
})().catch((e) => { console.error('Échec de la sauvegarde :', e.message); process.exit(1); });
