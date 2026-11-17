'use strict';
// Administration « en direct » : nouveaux comptes, inscriptions en attente de vérification, recherche globale.
// Monté dans routes/admin.js APRÈS requireAdmin : rien n'est lisible sans la session administrateur.
//   GET /live/accounts   instantané (repli par interrogation courte quand le flux est coupé)
//   GET /live/stream     flux d'événements serveur (SSE) : battement de cœur toutes les 20 s (le proxy de Render coupe les connexions muettes)
//   GET /search?q=       recherche globale : utilisateurs, organisations, paiements (peu de champs, jamais de secret)
// Aucune donnée sensible : ni mot de passe, ni hachage, ni code de vérification. Les adresses des inscriptions en attente sont masquées.
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const limits = require('../middleware/limits');
const central = require('../security');
const alertsSvc = require('../services/alerts');
const { mailEnabled } = require('../services/notify');
const custom = require('../services/custom-plan');
const { planOf } = require('../services/payments');
const crypto = require('crypto');
const { cleanText, parseJSON } = require('../util');

const router = express.Router();
const readLimit = limits.make(60 * 1000, 120, 'Trop de requêtes sur le direct. Patientez une minute.');
const streamLimit = limits.make(5 * 60 * 1000, 30, 'Trop de connexions au flux. Réessayez dans quelques minutes.');
const searchLimit = limits.make(60 * 1000, 90, 'Trop de recherches. Patientez une minute.');

const TICK_MS = 2000;       // le serveur regarde la base toutes les 2 s tant qu'au moins une page est connectée
const BEAT_MS = 20000;      // battement de cœur
const SUMMARY_EVERY = 5;    // pastilles recalculées toutes les 5 passes (10 s)
const MAX_STREAMS_PER_SESSION = 4;
const LIST = 20;

const verifyOn = () => config.signupVerify === 'on' || (config.signupVerify !== 'off' && mailEnabled());
const maskContact = (c) => {
  const s = String(c || '');
  if (s.includes('@')) return s.replace(/^(.{1,2}).*(@.*)$/, '$1***$2');
  const d = s.replace(/\D/g, '');
  return d.length > 4 ? '••• ' + d.slice(-3) : '•••';
};

function mapAccount(r) {
  const email = String(r.contact || '').includes('@');
  return {
    id: Number(r.id),
    name: r.name,
    contact: r.contact,
    plan: custom.label(r.plan),
    interests: parseJSON(r.interests, []),
    createdAt: r.created_at,
    // Le compte n'existe qu'après saisie du code quand la vérification est active : e-mail vérifié. Sinon création directe.
    verification: email && verifyOn() ? 'email' : 'none',
  };
}

/** Inscriptions dont le formulaire est rempli mais dont le code n'a pas encore été saisi. Jamais de mot de passe, de hachage ni de code. */
async function pendingList() {
  const now = Date.now();
  const rows = await db.prepare('SELECT contact, name, interests, expires_at, attempts, sent_at, sends FROM signup_codes ORDER BY sent_at DESC LIMIT 50').all();
  return rows.map((r) => ({
    key: crypto.createHash('sha256').update(String(r.contact)).digest('hex').slice(0, 10), // repère d'affichage : empreinte courte, l'adresse n'en ressort pas
    name: r.name,
    contact: maskContact(r.contact),
    interests: parseJSON(r.interests, []),
    sentAt: r.sent_at,
    ageSec: Math.max(0, Math.round((now - Date.parse(r.sent_at)) / 1000)),
    expired: Date.parse(r.expires_at) < now,
    attempts: Number(r.attempts) || 0,
    sends: Number(r.sends) || 1,
  }));
}

async function summary() {
  const one = async (sql) => Number((await db.prepare(sql).get()).n);
  const a = await alertsSvc.openCounts();
  return {
    payments: await one("SELECT COUNT(*) AS n FROM payments WHERE status = 'awaiting_validation'"),
    leads: await one('SELECT COUNT(*) AS n FROM leads WHERE handled = 0'),
    alerts: a.open, alertsHigh: a.high,
    suspended: await one('SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NOT NULL'),
  };
}

async function snapshot() {
  const rows = await db.prepare('SELECT id, name, contact, plan, interests, created_at FROM users ORDER BY id DESC LIMIT ?').all(LIST);
  const total = Number((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n);
  const pending = await pendingList();
  return { now: new Date().toISOString(), accounts: rows.map(mapAccount), pending, totals: { users: total, pending: pending.length }, lastId: rows.length ? Number(rows[0].id) : 0, summary: await summary(), verifyOn: verifyOn() };
}

// ---------- Observateur partagé : une seule interrogation de la base, quel que soit le nombre de pages connectées ----------
const streams = new Map(); // res -> { sid }
let timer = null; let lastId = null; let lastPending = ''; let lastSummary = ''; let tick = 0; let busy = false;

async function watch() {
  if (busy) return;
  busy = true;
  try {
    tick++;
    if (lastId === null) lastId = Number((await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM users').get()).m);
    const fresh = await db.prepare('SELECT id, name, contact, plan, interests, created_at FROM users WHERE id > ? ORDER BY id LIMIT 50').all(lastId);
    for (const r of fresh) { lastId = Math.max(lastId, Number(r.id)); broadcast('account', mapAccount(r)); }
    const pend = await pendingList();
    const sig = JSON.stringify(pend.map((p) => [p.key, p.attempts, p.sends, p.expired]));
    if (sig !== lastPending || fresh.length) { lastPending = sig; broadcast('pending', { pending: pend, totals: { pending: pend.length } }); }
    if (fresh.length || tick % SUMMARY_EVERY === 0) {
      const s = await summary(); const k = JSON.stringify(s);
      if (k !== lastSummary || fresh.length) { lastSummary = k; broadcast('summary', s); }
    }
  } catch (e) { /* base momentanément indisponible : on réessaiera à la prochaine passe */ } finally { busy = false; }
}
function startWatch() { if (!timer) { lastId = null; lastPending = ''; lastSummary = ''; tick = 0; timer = setInterval(watch, TICK_MS); if (timer.unref) timer.unref(); } }
function stopWatch() { if (timer && !streams.size) { clearInterval(timer); timer = null; } }
function send(res, event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { drop(res); } }
function broadcast(event, data) { for (const res of [...streams.keys()]) send(res, event, data); }
function drop(res) { streams.delete(res); try { res.end(); } catch (e) { /* déjà fermé */ } stopWatch(); }

router.get('/live/accounts', readLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await snapshot());
});

router.get('/live/stream', streamLimit, async (req, res) => {
  const sid = req.adminSession;
  // Au plus quelques flux par session : on ferme les plus anciens (onglets oubliés).
  const mine = [...streams.entries()].filter(([, v]) => v.sid === sid).map(([r]) => r);
  while (mine.length >= MAX_STREAMS_PER_SESSION) { const old = mine.shift(); send(old, 'bye', { reason: 'trop de flux ouverts' }); drop(old); }
  req.socket.setTimeout(0); req.socket.setNoDelay(true);
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  streams.set(res, { sid });
  startWatch();
  const beat = setInterval(async () => {
    try {
      const ok = await central.sessions.check(sid, 'admin'); // session révoquée ou expirée : on coupe
      if (!ok) { send(res, 'bye', { reason: 'session terminée' }); clearInterval(beat); drop(res); return; }
      send(res, 'ping', { t: Date.now() });
    } catch (e) { send(res, 'ping', { t: Date.now() }); }
  }, BEAT_MS);
  req.on('close', () => { clearInterval(beat); streams.delete(res); stopWatch(); });
  send(res, 'hello', await snapshot());
});

// ---------- Recherche globale (Ctrl K) ----------
router.get('/search', searchLimit, async (req, res) => {
  const q = cleanText(String(req.query.q || ''), 60);
  if (q.length < 2) return res.json({ users: [], orgs: [], payments: [] });
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const E = " ESCAPE '\\'";
  const users = await db.prepare(`SELECT id, name, contact, plan FROM users WHERE name ILIKE ?${E} OR contact ILIKE ?${E} ORDER BY id DESC LIMIT 6`).all(like, like);
  const orgs = await db.prepare(`SELECT o.id, o.name, o.sector, u.id AS owner_id, u.name AS owner FROM orgs o JOIN users u ON u.id = o.owner_id WHERE o.name ILIKE ?${E} OR u.name ILIKE ?${E} ORDER BY o.id DESC LIMIT 6`).all(like, like);
  const pays = await db.prepare(`SELECT p.id, p.reference, p.plan, p.amount_xaf, p.status, u.id AS user_id, u.name AS user_name FROM payments p JOIN users u ON u.id = p.user_id
    WHERE p.reference ILIKE ?${E} OR p.transaction_id ILIKE ?${E} OR u.name ILIKE ?${E} OR p.phone ILIKE ?${E} ORDER BY p.id DESC LIMIT 6`).all(like, like, like, like);
  res.json({
    users: users.map((u) => ({ id: Number(u.id), name: u.name, contact: u.contact, plan: custom.label(u.plan) })),
    orgs: orgs.map((o) => ({ id: Number(o.id), name: o.name, sector: o.sector || '', ownerId: Number(o.owner_id), owner: o.owner })),
    payments: pays.map((p) => ({ id: Number(p.id), reference: p.reference, planName: custom.label((planOf(p.plan) || {}).name || p.plan), amountXAF: Number(p.amount_xaf), status: p.status, userId: Number(p.user_id), user: p.user_name })),
  });
});

module.exports = router;
module.exports._test = { snapshot, pendingList, maskContact };
