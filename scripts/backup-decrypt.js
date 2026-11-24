'use strict';
// Déchiffre une sauvegarde « .json.gz.enc » : BACKUP_KEY=… node scripts/backup-decrypt.js sauvegarde.json.gz.enc > sauvegarde.json   (clé : BACKUP_KEY ou DATA_KEY)
require('dotenv').config({ quiet: true });
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const file = process.argv[2];
const secret = process.env.BACKUP_KEY || process.env.DATA_KEY;
if (!file || !secret) { console.error('Usage : BACKUP_KEY=… node scripts/backup-decrypt.js fichier.json.gz.enc > sortie.json'); process.exit(1); }
const raw = fs.readFileSync(file);
if (raw.subarray(0, 6).toString() !== 'MIABK1') { console.error("Ce fichier n'est pas une sauvegarde chiffrée MABAH."); process.exit(1); }
const salt = raw.subarray(6, 22); const iv = raw.subarray(22, 34); const tag = raw.subarray(34, 50);
try {
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(secret, salt, 32), iv); d.setAuthTag(tag);
  process.stdout.write(zlib.gunzipSync(Buffer.concat([d.update(raw.subarray(50)), d.final()])));
} catch { console.error('Déchiffrement impossible : clé incorrecte ou fichier altéré.'); process.exit(1); }
