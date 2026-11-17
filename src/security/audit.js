'use strict';
// Journal d'audit central : chaque ligne contient l'empreinte (SHA-256) de la ligne précédente. Modifier ou supprimer une ligne casse la chaîne,
// ce que « verify() » détecte. Écriture sérialisée (verrou consultatif PostgreSQL) pour que deux serveurs n'écrivent jamais en même temps.
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const { log } = require('../util');

const LOCK = 727275;
const GENESIS = '0'.repeat(64);
const SEVERITIES = ['info', 'warn', 'high', 'critical'];

const canon = (r) => JSON.stringify([r.at, r.actor_type, r.actor_id == null ? null : Number(r.actor_id), r.org_id == null ? null : Number(r.org_id), r.action, r.severity, r.target, r.ip, r.ua, r.request_id, r.detail, r.prev_hash]);
const hashOf = (r) => crypto.createHash('sha256').update(canon(r)).digest('hex');

const clip = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, n);

/** Qui agit ? Utilisateur connecté, administrateur, ou personne (visiteur, système). */
function actorOf(req, o) {
  if (o.actor) return o.actor;
  if (req && req.adminSession) return { type: 'admin', id: null };
  if (req && req.user) return { type: 'user', id: req.user.id };
  if (o.userId) return { type: 'user', id: o.userId };
  return { type: req ? 'visitor' : 'system', id: null };
}

/**
 * Enregistre un événement. Ne lève jamais d'erreur (une panne du journal ne doit pas casser la requête).
 * record(req, 'login.ok', { userId, orgId, target, detail, severity })
 */
async function record(req, action, o = {}) {
  const severity = SEVERITIES.includes(o.severity) ? o.severity : 'info';
  const a = actorOf(req, o);
  const row = {
    at: nowISO(), actor_type: a.type, actor_id: a.id == null ? null : a.id, org_id: o.orgId == null ? null : o.orgId, action: clip(action, 80), severity,
    target: clip(o.target, 160), ip: clip(req && req.ip, 64), ua: clip(req && req.get && req.get('user-agent'), 200), request_id: clip(req && req.id, 64), detail: clip(o.detail, 300),
  };
  try {
    await db.transaction(async () => {
      await db.prepare('SELECT pg_advisory_xact_lock(?)').get(LOCK);
      const last = await db.prepare('SELECT hash FROM audit_trail ORDER BY id DESC LIMIT 1').get();
      row.prev_hash = last ? last.hash : GENESIS;
      row.hash = hashOf(row);
      await db.prepare('INSERT INTO audit_trail (at, actor_type, actor_id, org_id, action, severity, target, ip, ua, request_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.at, row.actor_type, row.actor_id, row.org_id, row.action, row.severity, row.target, row.ip, row.ua, row.request_id, row.detail, row.prev_hash, row.hash);
    })();
  } catch (e) { log.warn("Journal d'audit : écriture impossible (" + clip(e.message, 120) + ')'); return; }
  if (severity === 'high' || severity === 'critical') alert(row);
}

/** Les événements graves préviennent l'administrateur (e-mail / WhatsApp), sans jamais bloquer. */
function alert(row) {
  try {
    const { notify } = require('../services/notify');
    notify('securite', `${row.severity === 'critical' ? 'ALERTE CRITIQUE' : 'Alerte'} sécurité : ${row.action}${row.target ? ' (' + row.target + ')' : ''}${row.ip ? ' depuis ' + row.ip : ''}.${row.detail ? ' ' + row.detail : ''}`);
  } catch { /* notification impossible */ }
}

// Points d'ancrage : toutes les heures (et à chaque vérification), l'empreinte de la dernière ligne est signée (HMAC avec une clé du serveur) dans une table à part.
// Une chaîne seule ne détecte pas la suppression des DERNIÈRES lignes ni une chaîne entièrement recalculée ; l'ancrage, si.
const macOf = (id, hash, at) => crypto.createHmac('sha256', require('../config').dataKey || require('../config').jwtSecret).update(`audit-checkpoint|${id}|${hash}|${at}`).digest('hex');
async function checkpoint() {
  const last = await db.prepare('SELECT id, hash FROM audit_trail ORDER BY id DESC LIMIT 1').get();
  if (!last) return null;
  const cp = await db.prepare('SELECT upto_id FROM audit_checkpoints ORDER BY id DESC LIMIT 1').get();
  if (cp && Number(cp.upto_id) >= Number(last.id)) return null;
  const at = nowISO();
  await db.prepare('INSERT INTO audit_checkpoints (upto_id, hash, at, mac) VALUES (?, ?, ?, ?)').run(last.id, last.hash, at, macOf(last.id, last.hash, at));
  return { uptoId: Number(last.id) };
}

/** Relit toute la chaîne, vérifie chaque lien, puis chaque point d'ancrage. Renvoie { ok, checked, checkpoints, brokenAt?, reason? }. */
async function verify() {
  let prev = GENESIS; let checked = 0; let after = 0;
  for (;;) {
    const rows = await db.prepare('SELECT * FROM audit_trail WHERE id > ? ORDER BY id LIMIT 1000').all(after);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.prev_hash !== prev || hashOf(r) !== r.hash) return { ok: false, checked, brokenAt: r.id, reason: 'chaîne rompue' };
      prev = r.hash; checked++; after = r.id;
    }
  }
  const cps = await db.prepare('SELECT * FROM audit_checkpoints ORDER BY id').all();
  for (const c of cps) {
    if (macOf(c.upto_id, c.hash, c.at) !== c.mac) return { ok: false, checked, checkpoints: cps.length, brokenAt: Number(c.upto_id), reason: "point d'ancrage falsifié" };
    const row = await db.prepare('SELECT hash FROM audit_trail WHERE id = ?').get(c.upto_id);
    if (!row || row.hash !== c.hash) return { ok: false, checked, checkpoints: cps.length, brokenAt: Number(c.upto_id), reason: 'lignes supprimées ou modifiées avant un point d\'ancrage' };
  }
  return { ok: true, checked, checkpoints: cps.length };
}

/** Liste filtrée pour l'écran d'administration. */
async function list({ limit = 100, severity, action, q, orgId, beforeId } = {}) {
  const w = []; const a = [];
  if (severity && SEVERITIES.includes(severity)) { w.push('severity = ?'); a.push(severity); }
  if (action) { w.push('action LIKE ?'); a.push(String(action).replace(/[%_]/g, '') + '%'); }
  if (q) { w.push('(target ILIKE ? OR detail ILIKE ? OR ip ILIKE ?)'); const p = `%${String(q).replace(/[%_]/g, '').slice(0, 60)}%`; a.push(p, p, p); }
  if (orgId) { w.push('org_id = ?'); a.push(Number(orgId)); }
  if (beforeId) { w.push('id < ?'); a.push(Number(beforeId)); }
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  return await db.prepare(`SELECT id, at, actor_type AS "actorType", actor_id AS "actorId", org_id AS "orgId", action, severity, target, ip, ua, request_id AS "requestId", detail FROM audit_trail${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ${n}`).all(...a);
}

module.exports = { record, verify, list, checkpoint, GENESIS, hashOf };
