'use strict';
// PostgreSQL jetable pour l'environnement de démonstration. Écrit l'adresse dans pgurl.txt (dossier DEMO_DIR) et reste en vie.
const fs = require('fs');
const path = require('path');
const { startTestPg } = require('../lib/testdb');
const dir = process.env.DEMO_DIR || '/private/tmp/claude-501/demo';
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const pg = await startTestPg();
  fs.writeFileSync(path.join(dir, 'pgurl.txt'), pg.url);
  console.log('PostgreSQL prêt :', pg.url);
  const stop = async () => { await pg.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error(e); process.exit(1); });
