'use strict';
// Liste enrichie des comptes et fiche client pour l'administration.
// CONFIDENTIALITÉ : ce module ne lit JAMAIS le contenu des messages, conversations, fichiers ni les données métier des entreprises
// (factures, clients de l'entreprise, salaires, stocks…). Il ne compte que des organisations, des membres et des messages IA (un nombre).
const crypto = require('crypto');
const config = require('../config');
const { db, nowISO } = require('../db');
const { HttpError, cleanText } = require('../util');
const custom = require('./custom-plan');
const accounts = require('./accounts');
const { planOf } = require('./payments');
const A = require('../workspace/access');

const DAY = 86400000;
const PAID = [...new Set([...Object.values(config.plans), ...Object.values(config.legacyPlans)].map((p) => p.name))];
const PLAN_NAMES = ['Gratuit', ...PAID, 'Sur mesure'];
const STATES = ['active', 'expiring', 'expired', 'free'];
const STATE_LABEL = { active: 'Active', expiring: 'Expire bientôt', expired: 'Expirée', free: 'Gratuite' };
const SORTS = {
  created: 't.created_at DESC',
  login: 't.last_login_at DESC NULLS LAST',
  name: 'lower(t.name) ASC',
  expires: "(CASE WHEN t.plan_state IN ('active', 'expiring') THEN 0 ELSE 1 END), t.plan_expires ASC",
  paid: 't.paid_total DESC',
  orgs: 't.orgs_n DESC',
};

/** État de l'offre (indépendant de la suspension) à partir d'une ligne users : active, expire bientôt (7 jours), expirée, gratuite. */
function planStateOf(u, hasPaid, now = Date.now()) {
  const exp = u.plan_expires ? Date.parse(u.plan_expires) : 0;
  if (u.plan && u.plan !== 'Gratuit' && exp > now) return exp <= now + 7 * DAY ? 'expiring' : 'active';
  if ((u.plan && u.plan !== 'Gratuit') || hasPaid) return 'expired';
  return 'free';
}

const effectivePlan = (u) => (u.plan && u.plan !== 'Gratuit' && u.plan_expires && Date.parse(u.plan_expires) > Date.now() ? u.plan : 'Gratuit');

/** Messages IA utilisés sur la période en cours, par propriétaire (une requête globale, puis un calcul exact seulement pour ceux qui ont de l'activité). */
async function aiUsedBy(users) {
  const out = new Map();
  if (!users.length) return out;
  const active = new Set((await db.prepare('SELECT DISTINCT o.owner_id AS uid FROM ai_usage a JOIN orgs o ON o.id = a.org_id WHERE a.created_at >= ?').all(new Date(Date.now() - 45 * DAY).toISOString())).map((r) => Number(r.uid)));
  for (const u of users) {
    if (!active.has(Number(u.id))) { out.set(Number(u.id), 0); continue; }
    const w = A.windowOfUser(u);
    out.set(Number(u.id), Number((await db.prepare('SELECT COUNT(*) AS n FROM ai_usage a JOIN orgs o ON o.id = a.org_id WHERE o.owner_id = ? AND a.created_at >= ? AND a.created_at < ?').get(u.id, w.start, w.end)).n));
  }
  return out;
}

function baseSql(now, soon) {
  return `SELECT u.id, u.name, u.contact, u.plan, u.plan_expires, u.created_at, u.last_login_at, u.suspended_at, u.suspended_reason,
    (SELECT COUNT(*) FROM orgs o WHERE o.owner_id = u.id) AS orgs_n,
    (SELECT COUNT(DISTINCT m.user_id) FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE o.owner_id = u.id) AS members_n,
    (SELECT COALESCE(SUM(p.amount_xaf), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS paid_total,
    (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id AND p.status = 'awaiting_validation') AS awaiting_n,
    (SELECT COUNT(*) FROM admin_alerts a WHERE a.user_id = u.id AND a.handled_at IS NULL) AS alerts_n,
    CASE WHEN u.plan <> 'Gratuit' AND u.plan_expires > '${now}' THEN (CASE WHEN u.plan_expires <= '${soon}' THEN 'expiring' ELSE 'active' END)
         WHEN u.plan <> 'Gratuit' OR EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') THEN 'expired'
         ELSE 'free' END AS plan_state
    FROM users u`;
}

/** Liste des comptes : recherche, filtres (offre, état, suspendus, inscrits récents, alertes ouvertes), tri. */
async function listClients(q = {}) {
  const now = new Date().toISOString();
  const soon = new Date(Date.now() + 7 * DAY).toISOString();
  const where = []; const params = [];
  const text = cleanText(String(q.q || ''), 80);
  if (text) { const like = '%' + text.replace(/[\\%_]/g, '\\$&') + '%'; where.push("(t.name ILIKE ? ESCAPE '\\' OR t.contact ILIKE ? ESCAPE '\\')"); params.push(like, like); }
  const plan = String(q.plan || '');
  if (plan) {
    if (!PLAN_NAMES.includes(plan)) throw new HttpError(400, 'Offre inconnue.');
    if (plan === 'Sur mesure') where.push("t.plan LIKE 'Sur mesure|%'"); else { where.push('t.plan = ?'); params.push(plan); }
  }
  const state = String(q.state || '');
  if (state) { if (!STATES.includes(state)) throw new HttpError(400, 'État inconnu.'); where.push('t.plan_state = ?'); params.push(state); }
  if (String(q.suspended || '') === '1') where.push('t.suspended_at IS NOT NULL');
  if (String(q.alerts || '') === '1') where.push('t.alerts_n > 0');
  const recent = parseInt(q.recent, 10);
  if (recent > 0) { where.push('t.created_at >= ?'); params.push(new Date(Date.now() - Math.min(recent, 3650) * DAY).toISOString()); }
  const order = SORTS[String(q.sort || '')] || SORTS.created;
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 200, 1), 5000);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const inner = `(${baseSql(now, soon)}) t`;
  const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${inner}${w}`).get(...params)).n);
  const rows = await db.prepare(`SELECT t.* FROM ${inner}${w} ORDER BY ${order}, t.id DESC LIMIT ${limit} OFFSET ${offset}`).all(...params);
  const ai = await aiUsedBy(rows);
  return {
    total,
    clients: rows.map((r) => {
      const eff = effectivePlan(r);
      return {
        id: Number(r.id), name: r.name, contact: r.contact, createdAt: r.created_at, lastLoginAt: r.last_login_at || null,
        plan: eff, planLabel: r.plan_state === 'expired' ? custom.label(r.plan) : custom.label(eff), planExpires: r.plan_expires || null,
        planState: r.plan_state, planStateLabel: STATE_LABEL[r.plan_state],
        suspended: Boolean(r.suspended_at), suspendedAt: r.suspended_at || null, suspendedReason: r.suspended_reason || '',
        orgs: Number(r.orgs_n), members: Number(r.members_n), aiUsed: ai.get(Number(r.id)) || 0, aiMax: A.limitsFor(eff).aiMonth * Math.max(1, Number(r.orgs_n)),
        paidTotalXAF: Number(r.paid_total), awaitingPayments: Number(r.awaiting_n), openAlerts: Number(r.alerts_n),
      };
    }),
  };
}

const handleOf = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 16);

/** Connexions ouvertes d'un compte, avec un identifiant opaque (jamais l'identifiant réel de session) et une adresse tronquée. */
async function sessionsOf(userId) {
  const rows = await db.prepare("SELECT * FROM sessions WHERE kind = 'user' AND user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen DESC").all(userId, nowISO());
  const central = require('../security');
  return rows.map((s) => ({ handle: handleOf(s.id), device: central.sessions.deviceName(s.ua), ip: accounts.maskIp(s.ip), createdAt: s.created_at, lastSeen: s.last_seen }));
}
async function revokeSession(userId, handle) {
  const rows = await db.prepare("SELECT id FROM sessions WHERE kind = 'user' AND user_id = ? AND revoked_at IS NULL AND expires_at > ?").all(userId, nowISO());
  const hit = rows.find((s) => handleOf(s.id) === String(handle));
  if (!hit) throw new HttpError(404, 'Connexion introuvable (déjà fermée ?).');
  return await require('../security').sessions.revoke(hit.id, "fermée par l'administrateur");
}

/** Fiche d'un client. Rien d'autre que ce qui est listé dans SCOPE.visible. */
async function clientDetail(id) {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Compte introuvable.');
  const waWeb = require('./waWeb');
  const eff = effectivePlan(u);
  const hasPaid = Boolean(await db.prepare("SELECT 1 FROM payments WHERE user_id = ? AND status = 'paid' LIMIT 1").get(u.id));
  const state = planStateOf(u, hasPaid);
  const orgRows = await db.prepare('SELECT o.id, o.name, o.created_at, (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS members FROM orgs o WHERE o.owner_id = ? ORDER BY o.id').all(u.id);
  const w = A.windowOfUser(u);
  const limits = A.limitsFor(eff);
  const orgs = [];
  for (const o of orgRows) {
    let wa = 'disconnected'; try { wa = waWeb.status(o.id).status; } catch { /* état inconnu */ }
    const used = Number((await db.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE org_id = ? AND created_at >= ? AND created_at < ?').get(o.id, w.start, w.end)).n);
    orgs.push({ id: Number(o.id), name: o.name, members: Number(o.members), createdAt: o.created_at, whatsapp: wa, aiUsed: used });
  }
  const payments = (await db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id)).map((p) => ({
    id: Number(p.id), reference: p.reference, planName: custom.label((planOf(p.plan) || {}).name || p.plan), amountXAF: Number(p.amount_xaf), operator: p.operator || '', phone: p.phone || '',
    mode: p.mode, status: p.status, transactionId: p.transaction_id || '', createdAt: p.created_at, paidAt: p.paid_at || null, decidedAt: p.decided_at || null, rejectReason: p.reject_reason || '',
  }));
  const timeline = (await db.prepare('SELECT id, kind, detail, at FROM account_events WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id))
    .filter((e) => Object.prototype.hasOwnProperty.call(accounts.EVENT_LABELS, e.kind))
    .map((e) => ({ id: Number(e.id), kind: e.kind, label: accounts.EVENT_LABELS[e.kind], detail: e.detail || '', at: e.at }));
  const notes = (await db.prepare('SELECT id, text, created_at FROM admin_notes WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id)).map((n) => ({ id: Number(n.id), text: n.text, createdAt: n.created_at }));
  const alerts = (await db.prepare('SELECT id, kind, severity, title, detail, created_at, handled_at FROM admin_alerts WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id))
    .map((a) => ({ id: Number(a.id), kind: a.kind, severity: a.severity, title: a.title, detail: a.detail, createdAt: a.created_at, handledAt: a.handled_at || null }));
  const paidTotal = payments.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amountXAF, 0);
  return {
    profile: {
      id: Number(u.id), name: u.name, contact: u.contact, createdAt: u.created_at, lastLoginAt: u.last_login_at || null, twofa: Boolean(Number(u.totp_enabled)),
      plan: eff, planLabel: state === 'expired' ? custom.label(u.plan) : custom.label(eff), planExpires: u.plan_expires || null, planState: state, planStateLabel: STATE_LABEL[state],
      suspended: Boolean(u.suspended_at), suspendedAt: u.suspended_at || null, suspendedReason: u.suspended_reason || '',
    },
    usage: { aiUsed: orgs.reduce((s, o) => s + o.aiUsed, 0), aiMax: limits.aiMonth * Math.max(1, orgs.length), aiMaxPerOrg: limits.aiMonth, periodEnd: w.end, orgsMax: limits.orgs, membersMax: limits.members, paidTotalXAF: paidTotal },
    orgs, payments, sessions: await sessionsOf(u.id), timeline, notes, alerts, scope: accounts.SCOPE,
  };
}

module.exports = { PLAN_NAMES, STATES, STATE_LABEL, planStateOf, listClients, clientDetail, sessionsOf, revokeSession, handleOf };
