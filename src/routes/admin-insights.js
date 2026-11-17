'use strict';
// Administration, étape 2 : utilisation des modules, santé de la plateforme, posture de sécurité, abonnements à expirer.
// Monté dans routes/admin.js APRÈS requireAdmin. Lecture seule ; agrégats uniquement (aucun contenu client, aucun secret).
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const limits = require('../middleware/limits');
const central = require('../security');
const alertsSvc = require('../services/alerts');
const custom = require('../services/custom-plan');

const router = express.Router();
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const num = (v) => Number(v) || 0;
router.use('/insights', limits.make(60 * 1000, 60, 'Trop de requêtes. Patientez une minute.'));

/** Utilisation des modules : événements d'activité par module sur la période, organisations et personnes distinctes, tendance. */
router.get('/insights/modules', async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const now = Date.now(), since = iso(now - days * DAY), prev = iso(now - 2 * days * DAY);
  const rows = await db.prepare('SELECT module, COUNT(*) AS n, COUNT(DISTINCT org_id) AS orgs, COUNT(DISTINCT user_id) AS users FROM activity WHERE created_at >= ? GROUP BY module ORDER BY n DESC').all(since);
  const before = await db.prepare('SELECT module, COUNT(*) AS n FROM activity WHERE created_at >= ? AND created_at < ? GROUP BY module').all(prev, since);
  const totalOrgs = num((await db.prepare('SELECT COUNT(*) AS n FROM orgs').get()).n);
  const dayKeys = []; for (let i = days - 1; i >= 0; i--) dayKeys.push(iso(now - i * DAY).slice(0, 10));
  const trend = await db.prepare('SELECT substr(created_at, 1, 10) d, COUNT(*) n FROM activity WHERE created_at >= ? GROUP BY d').all(dayKeys[0] + 'T00:00:00.000Z');
  const total = rows.reduce((a, r) => a + num(r.n), 0);
  res.json({
    days, total, totalOrgs,
    activeOrgs: num((await db.prepare('SELECT COUNT(DISTINCT org_id) AS n FROM activity WHERE created_at >= ?').get(since)).n),
    modules: rows.map((r) => ({ module: r.module, events: num(r.n), orgs: num(r.orgs), users: num(r.users), share: total ? num(r.n) / total : 0, previous: num((before.find((b) => b.module === r.module) || {}).n), adoption: totalOrgs ? num(r.orgs) / totalOrgs : 0 })),
    daily: { days: dayKeys, events: dayKeys.map((k) => num((trend.find((t) => t.d === k) || {}).n)) },
  });
});

/** Santé : processus, base de données, boucle d'événements, volumes, signaux d'alerte. Aucune valeur de configuration secrète. */
router.get('/insights/health', async (req, res) => {
  const t0 = process.hrtime.bigint();
  await db.prepare('SELECT 1 AS ok').get();
  const dbMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const lagStart = Date.now(); await new Promise((r) => setImmediate(r)); const lag = Date.now() - lagStart;
  let dbSize = 0; try { dbSize = num((await db.prepare('SELECT pg_database_size(current_database()) AS s').get()).s); } catch { /* indisponible */ }
  const since24 = iso(Date.now() - DAY);
  const one = async (sql, ...a) => num((await db.prepare(sql).get(...a)).n);
  const mem = process.memoryUsage();
  const wa = Boolean(config.whatsapp.phoneId && config.whatsapp.token), mail = Boolean(config.smtp.host) || (config.mailApi.provider === 'brevo' && Boolean(config.mailApi.key));
  res.json({
    now: new Date().toISOString(),
    process: { uptimeSec: Math.round(process.uptime()), node: process.version, rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), env: process.env.NODE_ENV || 'development' },
    db: { latencyMs: Math.round(dbMs * 10) / 10, sizeMB: Math.round(dbSize / 104857.6) / 10 },
    loopLagMs: lag,
    volumes: { users: await one('SELECT COUNT(*) AS n FROM users'), orgs: await one('SELECT COUNT(*) AS n FROM orgs'), activity: await one('SELECT COUNT(*) AS n FROM activity'), audit: await one('SELECT COUNT(*) AS n FROM audit_trail') },
    last24h: {
      signups: await one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', since24),
      aiMessages: await one('SELECT COUNT(*) AS n FROM ai_usage WHERE created_at >= ?', since24),
      securityEvents: await one("SELECT COUNT(*) AS n FROM audit_trail WHERE at >= ? AND severity IN ('high','critical')", since24),
      pendingSignups: await one('SELECT COUNT(*) AS n FROM signup_codes'),
    },
    services: [
      { key: 'ai', label: 'IA', ok: Boolean(config.ai.key), text: config.ai.key ? 'Connectée' : 'Non configurée' },
      { key: 'pay', label: 'Paiement automatique (Campay)', ok: Boolean(config.campay.enabled), text: config.campay.enabled ? 'Configuré' : 'Non configuré' },
      { key: 'mail', label: 'E-mail', ok: mail, text: mail ? 'Actif' : 'Non configuré' },
      { key: 'wa', label: 'WhatsApp', ok: wa, text: wa ? 'Actif' : 'Non configuré' },
    ],
    verdict: dbMs > 500 || lag > 250 ? 'bad' : dbMs > 150 || lag > 80 || mem.rss > 900 * 1048576 ? 'warn' : 'ok',
  });
});

/** Posture de sécurité : adoption de la 2FA, comptes suspendus, échecs, adresses bloquées, alertes. */
router.get('/insights/security', async (req, res) => {
  const since24 = iso(Date.now() - DAY), since7 = iso(Date.now() - 7 * DAY);
  const one = async (sql, ...a) => num((await db.prepare(sql).get(...a)).n);
  const users = await one('SELECT COUNT(*) AS n FROM users');
  const tfa = await one('SELECT COUNT(*) AS n FROM users WHERE totp_enabled = 1');
  const admin2fa = await db.prepare('SELECT enabled FROM admin_2fa WHERE id = 1').get();
  const top = await db.prepare("SELECT action, COUNT(*) AS n FROM audit_trail WHERE at >= ? AND severity IN ('warn','high','critical') GROUP BY action ORDER BY n DESC LIMIT 6").all(since7);
  const days = []; for (let i = 6; i >= 0; i--) days.push(iso(Date.now() - i * DAY).slice(0, 10));
  const fails = await db.prepare("SELECT substr(at, 1, 10) d, COUNT(*) n FROM audit_trail WHERE at >= ? AND (action ILIKE '%fail%' OR action ILIKE '%locked%') GROUP BY d").all(days[0] + 'T00:00:00.000Z');
  const a = await alertsSvc.openCounts();
  res.json({
    twofa: { users: tfa, total: users, rate: users ? tfa / users : 0, admin: Boolean(admin2fa && Number(admin2fa.enabled)) },
    suspended: await one('SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NOT NULL'),
    failures24h: await one("SELECT COUNT(*) AS n FROM audit_trail WHERE at >= ? AND (action ILIKE '%fail%' OR action ILIKE '%locked%')", since24),
    severe24h: await one("SELECT COUNT(*) AS n FROM audit_trail WHERE at >= ? AND severity IN ('high','critical')", since24),
    blocks: (await central.abuse.list()).length,
    alertsOpen: a.open, alertsHigh: a.high,
    activeSessions: await one("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'user' AND revoked_at IS NULL AND expires_at > ?", iso(Date.now())),
    failuresDaily: { days, values: days.map((k) => num((fails.find((f) => f.d === k) || {}).n)) },
    topActions: top.map((t) => ({ action: t.action, count: num(t.n) })),
  });
});

/** Abonnements à expirer : échéances proches, montant en jeu (dernier paiement validé de la personne), abonnements expirés depuis peu. */
router.get('/insights/expiring', async (req, res) => {
  const days = [7, 14, 30, 60].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const now = Date.now();
  const rows = await db.prepare("SELECT id, name, contact, plan, plan_expires FROM users WHERE plan != 'Gratuit' AND plan_expires IS NOT NULL AND plan_expires > ? AND plan_expires <= ? ORDER BY plan_expires").all(iso(now), iso(now + days * DAY));
  const lapsed = await db.prepare("SELECT id, name, contact, plan, plan_expires FROM users WHERE plan != 'Gratuit' AND plan_expires IS NOT NULL AND plan_expires <= ? AND plan_expires > ? ORDER BY plan_expires DESC LIMIT 100").all(iso(now), iso(now - 14 * DAY));
  const ids = [...rows, ...lapsed].map((r) => Number(r.id));
  const last = ids.length ? await db.prepare(`SELECT user_id, amount_xaf, paid_at FROM payments WHERE status = 'paid' AND user_id IN (${ids.map(() => '?').join(',')}) ORDER BY paid_at DESC`).all(...ids) : [];
  const lastOf = (id) => last.find((p) => Number(p.user_id) === Number(id));
  const map = (r) => { const p = lastOf(r.id); return { id: Number(r.id), name: r.name, contact: r.contact, plan: custom.label(r.plan), planExpires: r.plan_expires, daysLeft: Math.ceil((new Date(r.plan_expires) - now) / DAY), lastPaidXAF: p ? num(p.amount_xaf) : 0 }; };
  const list = rows.map(map), gone = lapsed.map(map);
  const bucket = (a, b) => list.filter((x) => x.daysLeft > a && x.daysLeft <= b);
  res.json({
    days, list, lapsed: gone,
    buckets: [{ label: '0 à 7 jours', n: bucket(0, 7).length, xaf: bucket(0, 7).reduce((s, x) => s + x.lastPaidXAF, 0) }, { label: '8 à 14 jours', n: bucket(7, 14).length, xaf: bucket(7, 14).reduce((s, x) => s + x.lastPaidXAF, 0) }, { label: '15 à 30 jours', n: bucket(14, 30).length, xaf: bucket(14, 30).reduce((s, x) => s + x.lastPaidXAF, 0) }, { label: '31 à 60 jours', n: bucket(30, 60).length, xaf: bucket(30, 60).reduce((s, x) => s + x.lastPaidXAF, 0) }].filter((b, i) => i < (days <= 7 ? 1 : days <= 14 ? 2 : days <= 30 ? 3 : 4)),
    atRiskXAF: list.reduce((s, x) => s + x.lastPaidXAF, 0),
  });
});

module.exports = router;
