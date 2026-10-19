'use strict';
// Démarre un vrai serveur PostgreSQL jetable (paquet « embedded-postgres », aucune installation requise) pour les tests de bout en bout.
// Plusieurs processus peuvent s'y connecter : le serveur de test et le script qui le pilote.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

async function startTestPg() {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-pg-'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('mia');
  const url = `postgres://postgres:test@127.0.0.1:${port}/mia`;
  const opened = [];
  return {
    url,
    /** Connexion directe (même API que src/db.js) pour préparer ou inspecter des données pendant un test. */
    async open() {
      const { createDb } = require('../../src/db-driver');
      const d = createDb({ driver: 'pg', url, poolMax: 2, ssl: false });
      await d.refreshIdTables();
      opened.push(d);
      return d;
    },
    async stop() {
      for (const d of opened) { try { await d.close(); } catch { /* déjà fermée */ } }
      try { await pg.stop(); } catch { /* arrêté */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* absent */ }
    },
  };
}

module.exports = { startTestPg, freePort };
