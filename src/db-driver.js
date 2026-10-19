'use strict';
// Pilote de base de données : PostgreSQL (pg, compatible Neon) en production, PGlite (vrai PostgreSQL embarqué) pour les tests.
// Expose une API proche de better-sqlite3, mais asynchrone :
//   await db.prepare('SELECT ... WHERE id = ?').get(id)  /  .all(...)  /  .run(...)  -> { changes, lastInsertRowid }
//   await db.transaction(async () => { ... })()          -> les requêtes faites dans la fonction partagent la même transaction
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const MIGRATION_LOCK = 727274; // verrou consultatif : un seul serveur applique les migrations à la fois

// ---------- Traduction SQL (placeholders ? -> $n, alias en casse mixte) ----------
function translate(sql) {
  let out = '', n = 0, i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') { // chaîne ou identifiant entre guillemets : recopié tel quel
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; } j++; }
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '?') { out += '$' + (++n); i++; continue; }
    out += ch; i++;
  }
  // PostgreSQL met les alias non guillemetés en minuscules : on garde la casse des alias « camelCase » (AS supplierId).
  out = out.replace(/(\bAS\s+)([A-Za-z_][A-Za-z0-9_]*)\b/gi, (m, as, id) => (/[a-z]/.test(id) && /[A-Z]/.test(id) ? `${as}"${id}"` : m));
  // « end » est un mot réservé PostgreSQL : colonne leaves.end (congés)
  out = out.replace(/\b(\w+)\.end\b/g, '$1."end"').replace(/\bstart,\s*end\b/g, 'start, "end"').replace(/\b(AND|OR)\s+end\s*(>=|<=|=|<|>)/gi, '$1 "end" $2');
  // INSERT OR IGNORE (SQLite) -> ON CONFLICT DO NOTHING
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(out)) out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  return out;
}
const norm = (v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v instanceof Date ? v.toISOString() : v);
const normAll = (params) => params.map(norm);

function createDb(cfg) {
  const isLite = cfg.driver === 'pglite';
  let backend; // { query(sql, params) -> { rows, rowCount }, exec(sql), tx(fn), end() }
  const idTables = new Set(); // tables possédant une colonne id (pour lastInsertRowid)

  if (isLite) {
    const { PGlite } = require('@electric-sql/pglite');
    const lite = new PGlite(cfg.pgliteDir || undefined, { parsers: { 20: (v) => Number(v), 1700: (v) => parseFloat(v) } });
    const wrap = (c) => ({
      query: async (sql, params) => { const r = await c.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length }; },
      exec: (sql) => c.exec(sql),
    });
    backend = { ...wrap(lite), tx: (fn) => lite.transaction((t) => fn(wrap(t))), end: () => lite.close() };
  } else {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => Number(v));     // bigint -> nombre (identifiants, compteurs, SUM)
    pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric -> nombre
    const mk = (url) => new pg.Pool({
      connectionString: url, max: cfg.poolMax, idleTimeoutMillis: 10000, connectionTimeoutMillis: 20000, keepAlive: true,
      ssl: cfg.ssl === false ? false : undefined, // « sslmode=require » dans l'URL (Neon) suffit ; DATABASE_SSL=false pour un PostgreSQL local
    });
    const pool = mk(cfg.url);
    pool.on('error', (e) => console.error('[db] erreur de connexion inactive :', e.message));
    const transient = (e) => e && (/Connection terminated|ECONNRESET|ETIMEDOUT|ECONNREFUSED|timeout exceeded when trying to connect/i.test(e.message) || ['57P01', '08006', '08001', '08003'].includes(e.code));
    const wrapClient = (c, retry) => ({
      query: async (sql, params) => {
        try { const r = await c.query(sql, params); return { rows: r.rows, rowCount: r.rowCount }; } catch (e) {
          if (retry && transient(e)) { await new Promise((r) => setTimeout(r, 800)); const r = await c.query(sql, params); return { rows: r.rows, rowCount: r.rowCount }; } // Neon qui se réveille
          throw e;
        }
      },
      exec: (sql) => c.query(sql),
    });
    backend = {
      ...wrapClient(pool, true),
      tx: async (fn) => {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn(wrapClient(c, false)); await c.query('COMMIT'); return r; } catch (e) { try { await c.query('ROLLBACK'); } catch (x) { /* connexion perdue */ } throw e; } finally { c.release(); }
      },
      end: () => pool.end(),
      direct: cfg.directUrl && cfg.directUrl !== cfg.url ? mk(cfg.directUrl) : null,
    };
  }

  const cur = () => als.getStore() || backend;
  const q = (sql, params) => cur().query(sql, params);

  const db = {
    driver: isLite ? 'pglite' : 'postgres',
    ready: null,
    /** Exécute une ou plusieurs instructions SQL sans paramètres. */
    exec: (sql) => cur().exec(sql),
    prepare(sql) {
      const text = translate(sql);
      const insert = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i.exec(sql);
      return {
        get: async (...p) => (await q(text, normAll(p))).rows[0],
        all: async (...p) => (await q(text, normAll(p))).rows,
        run: async (...p) => {
          let t = text;
          const withId = insert && idTables.has(insert[1].toLowerCase()) && !/\bRETURNING\b/i.test(t);
          if (withId) t += ' RETURNING id';
          const r = await q(t, normAll(p));
          return { changes: r.rowCount || 0, lastInsertRowid: withId && r.rows[0] ? r.rows[0].id : undefined };
        },
      };
    },
    /** db.transaction(fn) renvoie une fonction asynchrone ; la transaction est annulée si fn lève une erreur. */
    transaction(fn) {
      return async (...args) => {
        if (als.getStore()) return fn(...args); // déjà dans une transaction
        return backend.tx((client) => als.run(client, () => fn(...args)));
      };
    },
    async refreshIdTables() {
      const r = await backend.query("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'", []);
      idTables.clear(); r.rows.forEach((x) => idTables.add(String(x.table_name).toLowerCase()));
    },
    /** Applique les migrations manquantes (verrou consultatif pour les déploiements à plusieurs instances). */
    async migrate(migrations) {
      const run = async (c) => {
        await c.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
        const done = new Set((await c.query('SELECT version FROM schema_migrations', [])).rows.map((r) => Number(r.version)));
        for (let v = 0; v < migrations.length; v++) {
          if (done.has(v + 1)) continue;
          await c.exec(migrations[v]);
          await c.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [v + 1, new Date().toISOString()]);
        }
      };
      const tx = (b) => b.tx(async (c) => { await c.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]); await run(c); });
      await tx(backend.direct ? { tx: async (fn) => { const c = await backend.direct.connect(); try { await c.query('BEGIN'); const r = await fn({ query: async (s, p) => { const x = await c.query(s, p); return { rows: x.rows, rowCount: x.rowCount }; }, exec: (s) => c.query(s) }); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } } } : backend);
      await db.refreshIdTables();
    },
    async close() { if (backend.direct) await backend.direct.end(); await backend.end(); },
  };
  return db;
}

module.exports = { createDb, translate };
