'use strict';
// Droits des personnes et conservation des données : export (portabilité / accès), demande de suppression avec anonymisation après un délai de réflexion,
// consentements datés et versionnés, durées de conservation configurables par organisation, export complet d'une organisation.
// MABAH est responsable de traitement pour les comptes (users) et sous-traitant pour les données saisies par les organisations (clients, employés…) :
// la personne concernée par une donnée d'organisation s'adresse à cette organisation (voir docs/securite/).
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const audit = require('./audit');
const vault = require('../services/vault');
const sessions = require('./sessions');
const { HttpError, log } = require('../util');

// Versions en vigueur des textes (la date du texte publié sur le site). Un changement ici demande un nouveau consentement.
const VERSIONS = { terms: '2026-11-16', privacy: '2026-11-16', cookies: '2026-11-16', marketing: '2026-11-16', ai_processing: '2026-11-16' };
const CONSENT_KINDS = Object.keys(VERSIONS);
const ERASE_GRACE_DAYS = () => Math.min(Math.max(parseInt(process.env.PRIVACY_ERASE_GRACE_DAYS, 10) || 14, 0), 60);
const REQUEST_DEADLINE_DAYS = 30; // délai de réponse visé pour toute demande (accès, export, suppression)

const SECRET_COL = /(hash|secret|token|password|recovery|pass_|api_key|key_prefix)/i;
// Avis adressés à la plateforme (module Avis) : ils n'appartiennent pas à l'organisation, donc hors de son export (l'auteur les retrouve dans l'export de SES données).
const ORG_EXPORT_SKIP = new Set(['fb_feedback', 'fb_notes', 'fb_state']);
const ID_COLS = ['user_id', 'created_by', 'decided_by', 'requested_by', 'assignee_id', 'author_id', 'updated_by'];

// ---------- Consentements ----------
async function recordConsent(userId, kind, accepted, req, version) {
  if (!CONSENT_KINDS.includes(kind)) throw new HttpError(400, 'Type de consentement inconnu.');
  const v = version || VERSIONS[kind];
  if (v !== VERSIONS[kind]) throw new HttpError(400, `Version du texte inconnue (version en vigueur : ${VERSIONS[kind]}).`);
  await db.prepare('INSERT INTO consents (user_id, kind, version, accepted, ip, at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, kind, v, accepted ? 1 : 0, String((req && req.ip) || '').slice(0, 64), nowISO());
  await audit.record(req, accepted ? 'privacy.consent_given' : 'privacy.consent_withdrawn', { userId, target: kind, detail: v });
}
/** État actuel de chaque consentement : le plus récent de chaque type, et s'il porte sur la version en vigueur. */
async function consentState(userId) {
  const rows = await db.prepare('SELECT * FROM consents WHERE user_id = ? ORDER BY id').all(userId);
  const last = {};
  for (const r of rows) last[r.kind] = r;
  return CONSENT_KINDS.map((kind) => ({ kind, current: VERSIONS[kind], accepted: last[kind] ? Boolean(Number(last[kind].accepted)) : false, version: last[kind] ? last[kind].version : null, at: last[kind] ? last[kind].at : null, upToDate: Boolean(last[kind]) && last[kind].version === VERSIONS[kind] }));
}
const consentHistory = async (userId) => (await db.prepare('SELECT kind, version, accepted, at FROM consents WHERE user_id = ? ORDER BY id').all(userId)).map((r) => ({ ...r, accepted: Boolean(Number(r.accepted)) }));

// ---------- Export ----------
let schemaCache = null;
async function schema() {
  if (schemaCache) return schemaCache;
  const rows = await db.prepare("SELECT table_name t, column_name c, data_type d FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position").all();
  const by = {};
  for (const r of rows) (by[r.t] = by[r.t] || []).push({ c: r.c, bytea: r.d === 'bytea' });
  schemaCache = by;
  return by;
}
const safeCols = (cols) => cols.filter((x) => !x.bytea && !SECRET_COL.test(x.c)).map((x) => x.c);
const ident = (s) => `"${String(s).replace(/"/g, '')}"`; // noms issus du schéma lui-même, jamais d'une entrée utilisateur

/** Déchiffre les champs protégés (le droit d'accès donne les données lisibles, pas du texte chiffré). */
function readable(table, rows) {
  const enc = require('./encryption').COLUMNS.filter((c) => c[0] === table);
  if (!enc.length) return rows;
  return rows.map((r) => { const o = { ...r }; for (const [, col, type] of enc) if (col in o) o[col] = type === 'field' ? vault.decryptField(o[col]) : '(secret non exporté)'; return o; });
}

/** Toutes les données rattachées à une personne (compte), en JSON : profil, appartenances, paiements, consentements, messages, appareils… */
async function exportUser(userId) {
  const by = await schema();
  const u = await db.prepare('SELECT id, name, contact, plan, plan_expires, interests, progress, project, created_at, last_login_at, suspended_at FROM users WHERE id = ?').get(userId);
  if (!u) throw new HttpError(404, 'Compte introuvable.');
  const out = { format: 'mabah-export', version: 1, exportedAt: nowISO(), person: u, tables: {}, notes: [
    "Les données saisies par les organisations dont vous êtes membre (clients, factures, employés…) appartiennent à ces organisations : demandez-leur directement.",
    'Les mots de passe, secrets et clés ne sont jamais exportés.'] };
  for (const [table, cols] of Object.entries(by)) {
    if (table === 'users') continue;
    const keys = ID_COLS.filter((k) => cols.some((x) => x.c === k && !x.bytea));
    if (!keys.length) continue;
    const sel = safeCols(cols); if (!sel.length) continue;
    const rows = await db.prepare(`SELECT ${sel.map(ident).join(', ')} FROM ${ident(table)} WHERE ${keys.map((k) => `${ident(k)} = ?`).join(' OR ')} ORDER BY 1 LIMIT 5000`).all(...keys.map(() => userId));
    if (rows.length) out.tables[table] = readable(table, rows);
  }
  const anon = await require('../services/feedback').exportAnonymousFor(userId); // avis envoyés « en anonyme » : retrouvables par leur seul auteur
  if (anon.length) out.tables.fb_feedback_anonymes = anon;
  return out;
}

/** Export complet d'une organisation (propriétaire) : toutes les tables ayant org_id, sans fichiers binaires ni secrets. */
async function exportOrg(orgId) {
  const by = await schema();
  const org = await db.prepare('SELECT id, name, sector, description, currency, created_at FROM orgs WHERE id = ?').get(orgId);
  const out = { format: 'mabah-org-export', version: 1, exportedAt: nowISO(), org, tables: {}, notes: ['Fichiers binaires (photos du catalogue, médias) et secrets non inclus.', 'Limite de 50 000 lignes par table.'] };
  for (const [table, cols] of Object.entries(by)) {
    if (table === 'orgs' || ORG_EXPORT_SKIP.has(table) || !cols.some((x) => x.c === 'org_id')) continue;
    const sel = safeCols(cols); if (!sel.length) continue;
    const rows = await db.prepare(`SELECT ${sel.map(ident).join(', ')} FROM ${ident(table)} WHERE org_id = ? ORDER BY 1 LIMIT 50000`).all(orgId);
    if (rows.length) out.tables[table] = readable(table, rows);
  }
  return out;
}

/** Avant la suppression d'une organisation : efface les lignes des tables qui portent org_id SANS liaison en cascade (rien ne doit rester). Renvoie le nombre de lignes. */
async function purgeOrgOrphans(orgId) {
  const by = await schema();
  const linked = new Set((await db.prepare("SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND confrelid = 'orgs'::regclass").all()).map((r) => r.t.replace(/"/g, '')));
  let n = 0;
  for (const [table, cols] of Object.entries(by)) {
    if (table === 'audit_trail' || table === 'orgs' || linked.has(table) || !cols.some((x) => x.c === 'org_id')) continue;
    n += (await db.prepare(`DELETE FROM ${ident(table)} WHERE org_id = ?`).run(orgId)).changes || 0;
  }
  return n;
}

// ---------- Suppression avec anonymisation ----------
const gone = (id) => ({ name: 'Utilisateur supprimé', contact: `supprime-${id}@anonyme.invalid` });

async function requestErasure(user, req) {
  const owned = await db.prepare('SELECT o.id, o.name, (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS n FROM orgs o WHERE o.owner_id = ?').all(user.id);
  if (owned.length) throw new HttpError(409, `Vous êtes propriétaire de ${owned.length} organisation(s) : supprimez-les ou transférez-les avant de supprimer votre compte (« ${String(owned[0].name).slice(0, 60)} »…).`);
  const days = ERASE_GRACE_DAYS();
  const after = new Date(Date.now() + days * 86400000).toISOString();
  await db.prepare('UPDATE users SET erase_after = ? WHERE id = ?').run(after, user.id);
  const open = await db.prepare("SELECT id FROM data_requests WHERE user_id = ? AND kind = 'erasure' AND status = 'pending'").get(user.id);
  if (!open) await db.prepare("INSERT INTO data_requests (user_id, kind, status, detail, requested_at, due_at) VALUES (?, 'erasure', 'pending', ?, ?, ?)").run(user.id, `délai de réflexion ${days} j`, nowISO(), after);
  await audit.record(req, 'privacy.erasure_requested', { userId: user.id, severity: 'warn', detail: `exécution après ${after.slice(0, 10)}` });
  return { eraseAfter: after, graceDays: days };
}
async function cancelErasure(user, req) {
  await db.prepare('UPDATE users SET erase_after = NULL WHERE id = ? AND anonymized_at IS NULL').run(user.id);
  await db.prepare("UPDATE data_requests SET status = 'cancelled', done_at = ? WHERE user_id = ? AND kind = 'erasure' AND status = 'pending'").run(nowISO(), user.id);
  await audit.record(req, 'privacy.erasure_cancelled', { userId: user.id });
}

/** Anonymise un compte : identité effacée, accès coupé, liens avec les organisations retirés ; les pièces comptables (paiements) sont conservées sans identité (obligation légale). */
async function anonymizeUser(userId) {
  const g = gone(userId);
  const by = await schema();
  await db.transaction(async () => {
    await db.prepare("UPDATE users SET name = ?, contact = ?, pass_hash = ?, interests = '[]', progress = '{}', project = '{}', totp_enabled = 0, totp_secret = '', totp_step = 0, recovery_codes = '[]', suspended_at = NULL, suspended_reason = '', erase_after = NULL, anonymized_at = ?, pass_changed_at = ? WHERE id = ?")
      .run(g.name, g.contact, crypto.randomBytes(32).toString('hex'), nowISO(), nowISO(), userId);
    for (const t of ['org_members', 'login_devices', 'user_notices', 'password_resets', 'ai_messages']) {
      if (by[t] && by[t].some((x) => x.c === 'user_id')) await db.prepare(`DELETE FROM ${ident(t)} WHERE user_id = ?`).run(userId);
    }
    await db.prepare("UPDATE data_requests SET status = 'done', done_at = ? WHERE user_id = ? AND kind = 'erasure' AND status = 'pending'").run(nowISO(), userId);
  })();
  await require('../services/feedback').eraseUser(userId); // avis : texte, capture et nom effacés, témoignage public retiré
  await sessions.revokeAllForUser(userId, '', 'compte supprimé');
  await audit.record(null, 'privacy.erasure_done', { userId, severity: 'warn', target: `user:${userId}` });
}
/** Tâche quotidienne : exécute les suppressions dont le délai de réflexion est écoulé. */
async function runErasures() {
  const due = await db.prepare('SELECT id FROM users WHERE erase_after IS NOT NULL AND anonymized_at IS NULL AND erase_after <= ?').all(nowISO());
  let n = 0;
  for (const u of due) { try { await anonymizeUser(u.id); n++; } catch (e) { log.warn(`Suppression du compte ${u.id} impossible : ${String(e.message).slice(0, 100)}`); } }
  return n;
}

// ---------- Durées de conservation ----------
// Données purgeables automatiquement : [table, colonne de date, défaut en jours, minimum en jours, libellé]. Le journal d'audit de sécurité n'est jamais purgé (chaîne d'intégrité).
const RETENTION = {
  ai_messages: ['ai_messages', 'created_at', 365, 30, "Historique des discussions avec l'assistant IA"],
  webhook_deliveries: ['webhook_deliveries', 'created_at', 90, 7, 'Journal des envois de webhooks sortants'],
  activity: ['activity', 'created_at', 730, 90, "Fil d'activité de l'organisation"],
  agents_log: ['agents_log', 'created_at', 365, 30, 'Journal des agents IA'],
};
async function retentionRules(orgId) {
  const set = await db.prepare('SELECT kind, days FROM retention_rules WHERE org_id = ?').all(orgId);
  const map = Object.fromEntries(set.map((r) => [r.kind, Number(r.days)]));
  return Object.entries(RETENTION).map(([kind, [, , def, min, label]]) => ({ kind, label, days: map[kind] || def, default: def, min, custom: Boolean(map[kind]) }));
}
async function setRetention(orgId, kind, days) {
  const r = RETENTION[kind];
  if (!r) throw new HttpError(400, 'Type de données inconnu.');
  const n = Number(days);
  if (!Number.isInteger(n) || n < r[3] || n > 3650) throw new HttpError(400, `Durée invalide : entre ${r[3]} jours et 10 ans (3650 jours).`);
  await db.prepare('INSERT INTO retention_rules (org_id, kind, days) VALUES (?, ?, ?) ON CONFLICT (org_id, kind) DO UPDATE SET days = excluded.days').run(orgId, kind, n);
}
/** Tâche quotidienne : supprime ce qui dépasse la durée de conservation. Renvoie le nombre de lignes supprimées. */
async function purgeRetention() {
  const by = await schema();
  let total = 0;
  const orgs = await db.prepare('SELECT id FROM orgs').all();
  const custom = await db.prepare('SELECT org_id, kind, days FROM retention_rules').all();
  const cmap = new Map(custom.map((r) => [`${r.org_id}|${r.kind}`, Number(r.days)]));
  for (const [kind, [table, col, def]] of Object.entries(RETENTION)) {
    if (!by[table]) continue;
    for (const o of orgs) {
      const days = cmap.get(`${o.id}|${kind}`) || def;
      const r = await db.prepare(`DELETE FROM ${ident(table)} WHERE org_id = ? AND ${ident(col)} < ?`).run(o.id, new Date(Date.now() - days * 86400000).toISOString());
      total += r.changes || 0;
    }
  }
  total += await purgePlatformData();
  return total;
}

/** Données de la plateforme (hors organisations) : messages du formulaire de contact / demandes d'essai (3 ans), compteur de visites agrégé (13 mois). */
async function purgePlatformData() {
  const a = await db.prepare('DELETE FROM leads WHERE created_at < ?').run(new Date(Date.now() - 3 * 365 * 86400000).toISOString());
  const b = await db.prepare('DELETE FROM site_visits WHERE day < ?').run(new Date(Date.now() - 395 * 86400000).toISOString().slice(0, 10));
  return (a.changes || 0) + (b.changes || 0);
}

module.exports = { purgePlatformData, purgeOrgOrphans, VERSIONS, CONSENT_KINDS, REQUEST_DEADLINE_DAYS, RETENTION, recordConsent, consentState, consentHistory, exportUser, exportOrg, requestErasure, cancelErasure, anonymizeUser, runErasures, retentionRules, setRetention, purgeRetention };
