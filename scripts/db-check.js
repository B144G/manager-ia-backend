'use strict';
// Vérifie la connexion à la base PostgreSQL (Neon) et affiche l'état : npm run db:check
require('dotenv').config({ quiet: true });
const { db } = require('../src/db');

(async () => {
  const t0 = Date.now();
  await db.ready;
  const v = (await db.prepare('SELECT version() AS v').get()).v;
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema()").get()).n;
  const m = (await db.prepare('SELECT COUNT(*) AS n, MAX(version) AS last FROM schema_migrations').get());
  console.log(`Connexion OK (${Date.now() - t0} ms)\n  ${v}\n  ${n} tables, ${m.n} migrations appliquées (dernière : ${m.last})`);
  await db.close();
})().catch((e) => { console.error('Connexion impossible :', e.message); process.exit(1); });
