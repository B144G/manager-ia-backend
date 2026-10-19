'use strict';
// API d'administration (cookie séparé "mia_admin").
const express = require('express');
const config = require('../config');
const { db, nowISO, publicUser } = require('../db');
const limits = require('../middleware/limits');
const { setAdminCookie, clearAdminCookie, requireAdmin } = require('../middleware/auth');
const { markPaid, planConflict } = require('../services/payments');
const sec = require('../services/security');
const { notify } = require('../services/notify');
const { HttpError, safeEqual, cleanText, addDays, parseJSON } = require('../util');

const fs = require('fs');
const router = express.Router();
const PAID = Object.values(config.plans).map((p) => p.name); // Pro, Pro Max, Méga Pro, Illimité
const PLAN_NAMES = ['Gratuit', ...PAID];
const STATUSES = ['pending', 'awaiting_validation', 'paid', 'failed'];

router.post('/login', limits.adminLogin, async (req, res) => {
  if (!config.admin.username || !config.admin.password) {
    throw new HttpError(503, "L'administration n'est pas configurée : définissez ADMIN_USERNAME et ADMIN_PASSWORD.");
  }
  const b = req.body || {};
  await sec.assertNotLocked('admin');
  const okUser = safeEqual(typeof b.username === 'string' ? b.username : '', config.admin.username);
  const okPass = safeEqual(typeof b.password === 'string' ? b.password : '', config.admin.password);
  if (!(okUser && okPass)) {
    const locked = await sec.recordFail('admin');
    await sec.audit(locked ? 'admin_locked' : 'admin_login_fail', req, null, '');
    if (locked) notify('securite', "Alerte : trop d'échecs de connexion administrateur, accès bloqué 15 minutes.");
    throw new HttpError(401, 'Identifiant ou mot de passe incorrect.');
  }
  await sec.clearFails('admin');
  await sec.audit('admin_login', req, null, '');
  setAdminCookie(res);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

router.use(requireAdmin);

router.get('/security-log', async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  res.json({ events: await db.prepare('SELECT id, at, type, user_id AS userId, ip, detail FROM security_log ORDER BY id DESC LIMIT ?').all(n) });
});

router.get('/stats', async (req, res) => {
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
  const byPlan = Object.fromEntries(PLAN_NAMES.map((n) => [n, 0]));
  for (const r of await db.prepare('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan').all()) byPlan[r.plan] = r.n;

  const byInterest = {};
  for (const r of await db.prepare('SELECT interests FROM users').all()) {
    for (const i of parseJSON(r.interests, [])) byInterest[i] = (byInterest[i] || 0) + 1;
  }

  const d = new Date();
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const count = async (st) => (await db.prepare('SELECT COUNT(*) AS n FROM payments WHERE status = ?').get(st)).n;
  res.json({
    users: total,
    byPlan,
    byInterest,
    awaitingValidation: await count('awaiting_validation'),
    pendingPayments: await count('awaiting_validation') + await count('pending'),
    revenueMonthXAF: (await db.prepare("SELECT COALESCE(SUM(amount_xaf), 0) AS s FROM payments WHERE status = 'paid' AND paid_at >= ?").get(monthStart)).s,
    leads: (await db.prepare('SELECT COUNT(*) AS n FROM leads').get()).n,
  });
});

router.get('/users', async (req, res) => {
  const q = cleanText(String(req.query.q || ''), 80);
  const plan = String(req.query.plan || '');
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    sql += " AND (name ILIKE ? ESCAPE '\\' OR contact ILIKE ? ESCAPE '\\')";
    params.push(like, like);
  }
  if (plan) {
    if (!PLAN_NAMES.includes(plan)) throw new HttpError(400, 'Offre inconnue.');
    sql += ' AND plan = ?';
    params.push(plan);
  }
  sql += ' ORDER BY id DESC LIMIT 500';
  res.json({ users: (await db.prepare(sql).all(...params)).map(publicUser) });
});

const mapPayment = (r) => ({
  id: r.id,
  reference: r.reference,
  user: { id: r.user_id, name: r.user_name, contact: r.user_contact },
  plan: r.plan,
  planName: (config.plans[r.plan] || {}).name || r.plan,
  operator: r.operator,
  phone: r.phone,
  amountXAF: r.amount_xaf,
  mode: r.mode,
  status: r.status,
  transactionId: r.transaction_id,
  created: r.created_at,
  paidAt: r.paid_at,
});

router.get('/payments', async (req, res) => {
  const status = String(req.query.status || '');
  let sql = `SELECT p.*, u.name AS user_name, u.contact AS user_contact FROM payments p
             JOIN users u ON u.id = p.user_id`;
  const params = [];
  if (status) {
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Statut inconnu.');
    sql += ' WHERE p.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY p.id DESC LIMIT 500';
  res.json({ payments: (await db.prepare(sql).all(...params)).map(mapPayment) });
});

async function findPayment(req) {
  const id = parseInt(req.params.id, 10);
  const p = Number.isInteger(id) ? await db.prepare('SELECT * FROM payments WHERE id = ?').get(id) : null;
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  return p;
}

router.post('/payments/:id/validate', async (req, res) => {
  const p = await findPayment(req);
  if (p.status === 'paid') throw new HttpError(409, 'Ce paiement est déjà validé.');
  const owner = await db.prepare('SELECT * FROM users WHERE id = ?').get(p.user_id);
  const plan = config.plans[p.plan];
  const conflict = owner && plan ? planConflict(owner, plan.name) : null;
  if (conflict) throw new HttpError(409, `${conflict} Refusez ce paiement (remboursement) ou changez l'offre à la main depuis la fiche de l'abonné.`);
  const r = await markPaid(p.id);
  if (!r) throw new HttpError(409, 'Ce paiement ne peut pas être validé.');
  res.json({ ok: true, status: 'paid', plan: r.planName, planExpires: r.expires });
});

router.post('/payments/:id/reject', async (req, res) => {
  const p = await findPayment(req);
  if (p.status === 'paid') throw new HttpError(409, 'Ce paiement est déjà validé : impossible de le refuser.');
  await db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(p.id);
  res.json({ ok: true, status: 'failed' });
});

router.post('/users/:id/plan', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = Number.isInteger(id) ? await db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
  if (!u) throw new HttpError(404, 'Inscrit introuvable.');
  const b = req.body || {};
  const alias = { gratuit: 'Gratuit', ...Object.fromEntries(Object.values(config.plans).flatMap((p) => [[p.id, p.name], [p.name.toLowerCase(), p.name]])) };
  const plan = alias[String(b.plan || '').toLowerCase()] || (PLAN_NAMES.includes(b.plan) ? b.plan : null);
  if (!plan) throw new HttpError(400, `Offre inconnue (${PLAN_NAMES.join(', ')}).`);

  let expires = null;
  if (plan !== 'Gratuit') {
    const days = b.days === undefined ? config.durationDays : Number(b.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, 'Le nombre de jours doit être entre 1 et 3650.');
    expires = addDays(new Date(), days).toISOString();
  }
  await db.prepare('UPDATE users SET plan = ?, plan_expires = ?, reminded_for = NULL WHERE id = ?').run(plan, expires, u.id);
  res.json({ user: publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

router.post('/users/:id/reset-link', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = Number.isInteger(id) ? await db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
  if (!u) throw new HttpError(404, 'Inscrit introuvable.');
  res.json(await require('./auth').makeResetLink(req, u.id, 'admin'));
});

router.get('/leads', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM leads ORDER BY handled, id DESC LIMIT 500').all();
  res.json({ leads: rows.map((r) => ({ id: r.id, name: r.name, what: r.what, message: r.message, contact: r.contact, created: r.created_at, handled: !!r.handled })) });
});

router.post('/leads/:id/handled', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = Number.isInteger(id) ? await db.prepare('UPDATE leads SET handled = ? WHERE id = ?').run((req.body || {}).handled === false ? 0 : 1, id) : { changes: 0 };
  if (!r.changes) throw new HttpError(404, 'Demande introuvable.');
  res.json({ ok: true });
});

// ---------- Tableau de bord de la plateforme ----------
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const monthKey = (d) => d.toISOString().slice(0, 7);

function lastMonths(n) {
  const d = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))));
  return out;
}

/** État de la configuration (jamais de secrets : seulement « configuré » ou non). */
async function systemStatus() {
  let dbSize = 0;
  try { dbSize = Number((await db.prepare('SELECT pg_database_size(current_database()) AS s').get()).s) || 0; } catch { /* taille indisponible */ }
  const wa = Boolean(config.whatsapp.phoneId && config.whatsapp.token);
  const mail = Boolean(config.smtp.host);
  return [
    { key: 'server', label: 'Serveur et site', status: 'ok', text: 'En ligne' },
    { key: 'db', label: 'Base de données', status: 'ok', text: `${(dbSize / 1048576).toFixed(1).replace('.', ',')} Mo` },
    { key: 'ai', label: 'IA', status: config.ai.key ? 'ok' : 'warn', text: config.ai.key ? 'Connectée' : 'Non configurée' },
    { key: 'pay', label: 'Paiement automatique (Campay)', status: config.campay.enabled ? 'ok' : 'warn', text: config.campay.enabled ? 'Configuré' : 'Non configuré' },
    { key: 'msg', label: 'E-mail et WhatsApp', status: mail && wa ? 'ok' : 'warn', text: mail && wa ? 'Actifs' : mail ? 'E-mail seulement' : wa ? 'WhatsApp seulement' : 'Non configurés' },
  ];
}

router.get('/overview', async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const now = Date.now();
  const since = iso(now - days * DAY);
  const one = async (sql, ...a) => await db.prepare(sql).get(...a);
  const notExpired = "plan != 'Gratuit' AND (plan_expires IS NULL OR plan_expires > ?)";

  const users = (await one('SELECT COUNT(*) n FROM users')).n;
  const newUsers = (await one('SELECT COUNT(*) n FROM users WHERE created_at >= ?', since)).n;
  const orgs = (await one('SELECT COUNT(*) n FROM orgs')).n;
  const activeOrgs = (await one('SELECT COUNT(DISTINCT org_id) n FROM activity WHERE created_at >= ?', since)).n;

  const months = lastMonths(6);
  const revRows = await db.prepare("SELECT substr(paid_at, 1, 7) m, SUM(amount_xaf) s FROM payments WHERE status = 'paid' AND paid_at >= ? GROUP BY m").all(months[0] + '-01');
  const sigRows = await db.prepare('SELECT substr(created_at, 1, 7) m, COUNT(*) n FROM users WHERE created_at >= ? GROUP BY m').all(months[0] + '-01');
  const series = months.map((m) => ({ month: m, revenue: (revRows.find((r) => r.m === m) || {}).s || 0, signups: (sigRows.find((r) => r.m === m) || {}).n || 0 }));

  const nowIso = iso(now);
  const payers = {};
  for (const r of await db.prepare(`SELECT plan, COUNT(*) n FROM users WHERE ${notExpired} GROUP BY plan`).all(nowIso)) payers[r.plan] = r.n;
  const free = users - Object.values(payers).reduce((a, b) => a + b, 0);

  const dayStart = (t) => iso(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()));
  const aiToday = (await one("SELECT COUNT(*) n FROM ai_usage WHERE created_at >= ?", dayStart(now))).n;
  const aiYesterday = (await one("SELECT COUNT(*) n FROM ai_usage WHERE created_at >= ? AND created_at < ?", dayStart(now - DAY), dayStart(now))).n;

  const pendingPays = await db.prepare(`SELECT p.id, p.reference, p.plan, p.operator, p.amount_xaf, p.created_at, u.name AS user_name FROM payments p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'awaiting_validation' ORDER BY p.id DESC LIMIT 5`).all();
  const pendingCount = (await one("SELECT COUNT(*) n FROM payments WHERE status = 'awaiting_validation'")).n;
  const leadsOpen = (await one('SELECT COUNT(*) n FROM leads WHERE handled = 0')).n;
  const expiring = (await one(`SELECT COUNT(*) n FROM users WHERE plan != 'Gratuit' AND plan_expires IS NOT NULL AND plan_expires > ? AND plan_expires <= ?`, nowIso, iso(now + 7 * DAY))).n;
  const system = await systemStatus();

  res.json({
    days,
    kpi: {
      users, newUsers, orgs, activeOrgs, payers: Object.values(payers).reduce((a, b) => a + b, 0), payersByPlan: Object.fromEntries(PAID.map((n) => [n, payers[n] || 0])),
      aiToday, aiYesterday,
    },
    plans: { Gratuit: free, ...Object.fromEntries(PAID.map((n) => [n, payers[n] || 0])), prices: Object.fromEntries(Object.values(config.plans).map((p) => [p.name, p.priceXAF])) },
    series,
    todo: { payments: pendingCount, leads: leadsOpen, expiring },
    payments: pendingPays.map((p) => ({ id: p.id, reference: p.reference, user: p.user_name, planName: (config.plans[p.plan] || {}).name || p.plan, operator: p.operator, amountXAF: p.amount_xaf, created: p.created_at })),
    leads: (await db.prepare('SELECT id, name, what, message, created_at FROM leads WHERE handled = 0 ORDER BY id DESC LIMIT 3').all()).map((l) => ({ id: l.id, name: l.name, text: l.message || l.what || '', created: l.created_at })),
    latestUsers: (await db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 4').all()).map(publicUser),
    activity: (await db.prepare('SELECT type, text, created_at FROM notifications ORDER BY id DESC LIMIT 4').all()).map((n) => ({ type: n.type, text: n.text, created: n.created_at })),
    system,
    revenueMonth: series[5].revenue, revenuePrev: series[4].revenue,
    admin: config.admin.username,
  });
});

router.get('/orgs', async (req, res) => {
  const rows = await db.prepare(`SELECT o.id, o.name, o.sector, o.created_at, u.name AS owner, u.contact AS owner_contact, u.plan,
      (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS members,
      (SELECT COUNT(*) FROM branches b WHERE b.org_id = o.id) AS branches,
      (SELECT MAX(created_at) FROM activity a WHERE a.org_id = o.id) AS last_activity
    FROM orgs o JOIN users u ON u.id = o.owner_id ORDER BY o.id DESC LIMIT 500`).all();
  res.json({ orgs: rows.map((r) => ({ id: r.id, name: r.name, sector: r.sector, owner: r.owner, ownerContact: r.owner_contact, plan: r.plan, members: r.members, branches: r.branches, created: r.created_at, lastActivity: r.last_activity })) });
});

router.get('/ai-usage', async (req, res) => {
  const since = iso(Date.now() - 13 * DAY);
  const rows = await db.prepare("SELECT substr(created_at, 1, 10) d, COUNT(*) n FROM ai_usage WHERE created_at >= ? GROUP BY d").all(since.slice(0, 10) + 'T00:00:00.000Z');
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10); days.push({ day: d, count: (rows.find((r) => r.d === d) || {}).n || 0 }); }
  const top = (await db.prepare(`SELECT o.id, o.name, COUNT(*) n FROM ai_usage m JOIN orgs o ON o.id = m.org_id WHERE m.created_at >= ? GROUP BY o.id ORDER BY n DESC LIMIT 8`).all(since)).map((r) => ({ id: r.id, name: r.name, count: r.n }));
  res.json({ days, top, total: days.reduce((a, d) => a + d.count, 0), enabled: Boolean(config.ai.key), model: config.ai.model });
});

router.get('/settings', async (req, res) => {
  res.json({ system: await systemStatus(), plans: { ...Object.fromEntries(Object.values(config.plans).map((p) => [p.name, p.priceXAF])), durationDays: config.durationDays }, workspaceLimits: config.workspaceLimits, adminEmail: config.admin.email });
});

router.get('/notifications', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 200').all();
  res.json({ notifications: rows.map((r) => ({ id: r.id, type: r.type, text: r.text, channels: r.channels ? r.channels.split(',') : [], created: r.created_at })) });
});

// CSV : UTF-8 avec BOM, séparateur point-virgule (s'ouvre directement dans Excel).
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // évite l'exécution de formules dans Excel
  return '"' + s.replace(/"/g, '""') + '"';
};
router.get('/export/users.csv', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM users ORDER BY id').all();
  const lines = [['id', 'nom', 'contact', 'offre', 'expiration', 'centres_interet', 'inscrit_le'].join(';')];
  for (const r of rows) {
    lines.push([r.id, r.name, r.contact, r.plan, r.plan_expires || '', parseJSON(r.interests, []).join(' '), r.created_at].map(csvCell).join(';'));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="inscrits-${nowISO().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

module.exports = router;
