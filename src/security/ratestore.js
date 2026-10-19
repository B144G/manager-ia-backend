'use strict';
// Compteurs de limites de débit stockés dans PostgreSQL : partagés par tous les serveurs (Render peut en lancer plusieurs) et conservés au redémarrage.
// Utilisés par les limites sensibles (connexion, inscription, paiements, administrateur). Compatible avec express-rate-limit v7.
const { db } = require('../db');

class PgStore {
  constructor(prefix) { this.prefix = prefix; this.localKeys = false; }
  init(options) { this.windowMs = options.windowMs; }
  key(k) { return `${this.prefix}:${k}`.slice(0, 200); }
  async increment(key) {
    const now = Date.now();
    const r = await db.prepare('INSERT INTO rate_hits (k, hits, reset_at) VALUES (?, 1, ?) ON CONFLICT (k) DO UPDATE SET hits = CASE WHEN rate_hits.reset_at <= ? THEN 1 ELSE rate_hits.hits + 1 END, reset_at = CASE WHEN rate_hits.reset_at <= ? THEN excluded.reset_at ELSE rate_hits.reset_at END RETURNING hits, reset_at')
      .get(this.key(key), now + this.windowMs, now, now);
    return { totalHits: Number(r.hits), resetTime: new Date(Number(r.reset_at)) };
  }
  async decrement(key) { await db.prepare('UPDATE rate_hits SET hits = GREATEST(hits - 1, 0) WHERE k = ?').run(this.key(key)); }
  async resetKey(key) { await db.prepare('DELETE FROM rate_hits WHERE k = ?').run(this.key(key)); }
}
module.exports = { PgStore };
