'use strict';
// Rotation de la clé de chiffrement : 1) mettez l'ANCIENNE clé dans DATA_KEY_PREVIOUS, 2) la nouvelle dans DATA_KEY, 3) lancez ce script.
// Toutes les valeurs chiffrées sont rechiffrées avec la nouvelle clé ; ensuite seulement, retirez DATA_KEY_PREVIOUS.
process.env.SECURITY_REWRAP = '1';
const { db } = require('../src/db');
const enc = require('../src/security/encryption');
db.ready.then(async () => { const r = await enc.run(); console.log(`Rotation : ${r.rewrapped} rechiffrée(s), ${r.upgraded} mise(s) à niveau, ${r.unreadable} illisible(s).`); await db.close(); process.exit(r.unreadable ? 1 : 0); })
  .catch((e) => { console.error(e.message); process.exit(1); });
