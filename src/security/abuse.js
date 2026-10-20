'use strict';
// Détection d'abus : des « points » s'accumulent par adresse IP (mots de passe faux, origine interdite, signature invalide, limites dépassées…).
// Au-delà du seuil, l'adresse est bloquée automatiquement (1 h, puis 24 h en cas de récidive). L'administrateur peut aussi bloquer / débloquer à la main.
// Les adresses locales et privées ne sont jamais bloquées automatiquement (développement, réseau interne), sauf SECURITY_BAN_PRIVATE=1.
const { db, nowISO } = require('../db');
const { log } = require('../util');
const config = require('../config');
const audit = require('./audit');

const WINDOW_MS = 15 * 60 * 1000;
const THRESHOLD = Math.max(parseInt(process.env.SECURITY_BAN_SCORE, 10) || 40, 5);
const WEIGHTS = { login_fail: 2, login_locked: 6, twofa_fail: 4, admin_login_fail: 6, admin_locked: 20, origin_denied: 5, bad_signature: 8, rate_limited: 3, forbidden_probe: 2 };
const BAN_FIRST_MS = 60 * 60 * 1000;
const BAN_REPEAT_MS = 24 * 60 * 60 * 1000;

const isPrivate = (ip) => {
  const v = String(ip || '').replace(/^::ffff:/, '');
  return !v || v === '::1' || /^127\./.test(v) || /^10\./.test(v) || /^192\.168\./.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^f[cd]/i.test(v) || /^fe80/i.test(v);
};
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '').slice(0, 64);

// Si le serveur est derrière plus de relais que TRUST_PROXY ne le dit (ex. Vercel puis Render : il faut 2), « req.ip » serait l'adresse du relais
// et TOUS les visiteurs auraient la même : on ne bloque alors rien automatiquement (un seul abus bloquerait tout le monde) et on prévient.
let proxyDoubt = false;
function checkProxy(req) {
  const hops = Number(config.trustProxy);
  if (!Number.isFinite(hops) || hops < 1) return;
  const n = String(req.headers['x-forwarded-for'] || '').split(',').filter((x) => x.trim()).length;
  if (n > hops && !proxyDoubt) { proxyDoubt = true; log.warn(`Sécurité : ${n} relais devant le serveur mais TRUST_PROXY=${hops} : les adresses IP ne sont pas fiables, le blocage automatique est suspendu. Réglez TRUST_PROXY=${n} (Vercel + Render : 2).`); }
}
const proxyUncertain = () => proxyDoubt;

let blocked = new Map(); // ip -> { until: ms | Infinity, reason }
let loadedAt = 0;
async function refresh() {
  const rows = await db.prepare('SELECT * FROM ip_blocks WHERE permanent = 1 OR blocked_until > ?').all(nowISO());
  blocked = new Map(rows.map((r) => [r.ip, { until: r.permanent ? Infinity : Date.parse(r.blocked_until), reason: r.reason }]));
  loadedAt = Date.now();
}

/** Premier rempart : toute requête d'une adresse bloquée est refusée avant tout le reste (sauf /api/health). */
async function guard(req, res, next) {
  if (req.path === '/api/health') return next();
  checkProxy(req);
  if (Date.now() - loadedAt > 10000) { try { await refresh(); } catch (e) { log.warn('Blocage IP : liste illisible'); loadedAt = Date.now(); } }
  const b = blocked.get(cleanIp(req.ip));
  if (b && b.until > Date.now()) {
    if (b.until !== Infinity) res.set('Retry-After', String(Math.ceil((b.until - Date.now()) / 1000)));
    return res.status(403).json({ error: 'Accès temporairement bloqué depuis cette adresse (activité suspecte). Réessayez plus tard.' });
  }
  return next();
}

async function block(ip, { reason = '', ms = BAN_FIRST_MS, permanent = false, by = 'auto', req } = {}) {
  const addr = cleanIp(ip);
  if (!addr) return false;
  await db.prepare('INSERT INTO ip_blocks (ip, reason, blocked_until, permanent, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (ip) DO UPDATE SET reason = excluded.reason, blocked_until = excluded.blocked_until, permanent = excluded.permanent, created_at = excluded.created_at, created_by = excluded.created_by')
    .run(addr, String(reason).slice(0, 160), permanent ? null : new Date(Date.now() + ms).toISOString(), permanent ? 1 : 0, nowISO(), by);
  await refresh();
  await audit.record(req || null, 'ip.block', { target: addr, severity: by === 'auto' ? 'high' : 'warn', detail: `${reason}${permanent ? ' (permanent)' : ''}`.slice(0, 200) });
  return true;
}
async function unblock(ip, req) {
  const r = await db.prepare('DELETE FROM ip_blocks WHERE ip = ?').run(cleanIp(ip));
  await db.prepare('DELETE FROM ip_strikes WHERE ip = ?').run(cleanIp(ip));
  await refresh();
  if (r.changes) await audit.record(req || null, 'ip.unblock', { target: cleanIp(ip), severity: 'warn' });
  return r.changes > 0;
}
async function list() {
  return (await db.prepare('SELECT ip, reason, blocked_until AS "blockedUntil", permanent, created_at AS "createdAt", created_by AS "createdBy" FROM ip_blocks WHERE permanent = 1 OR blocked_until > ? ORDER BY created_at DESC').all(nowISO()));
}

/** Ajoute des points d'abus à l'adresse de la requête ; bloque automatiquement au-delà du seuil. Ne lève jamais d'erreur. */
async function strike(req, kind, weight) {
  try {
    const ip = cleanIp(req && req.ip);
    const w = weight || WEIGHTS[kind] || 1;
    if (!ip || proxyDoubt || (isPrivate(ip) && process.env.SECURITY_BAN_PRIVATE !== '1')) return;
    const cut = new Date(Date.now() - WINDOW_MS).toISOString();
    const r = await db.prepare('INSERT INTO ip_strikes (ip, score, window_start) VALUES (?, ?, ?) ON CONFLICT (ip) DO UPDATE SET score = CASE WHEN ip_strikes.window_start < ? THEN excluded.score ELSE ip_strikes.score + excluded.score END, window_start = CASE WHEN ip_strikes.window_start < ? THEN excluded.window_start ELSE ip_strikes.window_start END RETURNING score')
      .get(ip, w, nowISO(), cut, cut);
    const score = r ? Number(r.score) : w;
    if (score >= THRESHOLD) {
      const prev = await db.prepare('SELECT created_at FROM ip_blocks WHERE ip = ?').get(ip);
      const repeat = prev && Date.parse(prev.created_at) > Date.now() - 24 * 3600 * 1000 * 2;
      await db.prepare('DELETE FROM ip_strikes WHERE ip = ?').run(ip);
      await block(ip, { reason: `Activité suspecte (${kind}, ${score} points)`, ms: repeat ? BAN_REPEAT_MS : BAN_FIRST_MS, by: 'auto', req });
    }
  } catch (e) { log.warn('Détection d\'abus : ' + String(e.message).slice(0, 100)); }
}

async function sweep() {
  await db.prepare('DELETE FROM ip_blocks WHERE permanent = 0 AND blocked_until < ?').run(new Date(Date.now() - 86400000).toISOString());
  await db.prepare('DELETE FROM ip_strikes WHERE window_start < ?').run(new Date(Date.now() - WINDOW_MS).toISOString());
  await db.prepare('DELETE FROM rate_hits WHERE reset_at < ?').run(Date.now() - 60000);
}

module.exports = { proxyUncertain, guard, strike, block, unblock, list, refresh, sweep, isPrivate, WEIGHTS, THRESHOLD };
