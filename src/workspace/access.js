'use strict';
// Accès à une organisation : rôles, filtre par antenne, validation des champs, journal d'activité.
const { db, nowISO, getUserFresh } = require('../db');
const config = require('../config');
const { HttpError, cleanText } = require('../util');

const RANK = { member: 1, manager: 2, admin: 3, owner: 4 };
const ROLES = Object.keys(RANK);
const ROLE_LABEL = { member: 'Membre', manager: 'Responsable', admin: 'Administrateur', owner: 'Propriétaire' };

// ---------- Validation ----------
function text(v, max, { required = false, msg } = {}) {
  const t = cleanText(v, max);
  if (required && !t) throw new HttpError(400, msg || 'Un champ obligatoire est vide.');
  return t;
}
function oneOf(v, list, def, msg) {
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    throw new HttpError(400, msg || 'Valeur manquante.');
  }
  if (!list.includes(v)) throw new HttpError(400, msg || 'Valeur non valide.');
  return v;
}
function date(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, 'Date invalide (format AAAA-MM-JJ).');
  return v;
}
function amount(v) {
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : v;
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) throw new HttpError(400, 'Montant invalide : indiquez un nombre positif.');
  return Math.round(n);
}
/** Quantité (peut avoir des décimales, ex. 2,5 kg). allowZero pour les seuils ; jamais négative. */
function qty(v, { allowZero = false } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : v;
  if (!Number.isFinite(n) || n < 0 || n > 1e9 || (!allowZero && n === 0)) throw new HttpError(400, allowZero ? 'Quantité invalide : indiquez un nombre positif ou zéro.' : 'Quantité invalide : indiquez un nombre positif.');
  return Math.round(n * 1000) / 1000;
}
const money0 = (v) => (v === undefined || v === null || v === '' ? 0 : amount(v));
function id(v, msg = 'Identifiant invalide.') {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, msg);
  return n;
}
const idOrNull = (v, msg) => (v === undefined || v === null || v === '' ? null : id(v, msg));

// ---------- Contexte d'organisation (middleware pour /orgs/:orgId/...) ----------
async function loadOrg(req, res, next) {
  const orgId = Number(req.params.orgId);
  if (!Number.isInteger(orgId) || orgId < 1) throw new HttpError(404, 'Organisation introuvable.');
  const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
  const member = org && await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, req.user.id);
  if (!org || !member) throw new HttpError(404, 'Organisation introuvable.'); // même message : on ne révèle pas son existence
  req.org = org;
  req.member = member;
  next();
}

const need = (min) => (req, res, next) => {
  if (RANK[req.member.role] < RANK[min]) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  next();
};
const can = (req, min) => RANK[req.member.role] >= RANK[min];

/** Filtre par antenne : les administrateurs et les personnes sans antenne voient tout ; les autres, leur antenne + le commun. */
function scope(req, col = 'branch_id') {
  if (can(req, 'admin') || req.member.branch_id == null) return { sql: '', args: [] };
  return { sql: ` AND (${col} IS NULL OR ${col} = ?)`, args: [req.member.branch_id] };
}
/** Une fiche (avec branch_id) est-elle visible par ce membre ? */
const visible = (req, row) => !row.branch_id || can(req, 'admin') || req.member.branch_id == null || req.member.branch_id === row.branch_id;

/** Vérifie qu'une antenne appartient bien à l'organisation. */
async function branchOf(req, v) {
  const b = idOrNull(v, 'Antenne invalide.');
  if (b === null) return null;
  if (!await db.prepare('SELECT 1 FROM branches WHERE id = ? AND org_id = ?').get(b, req.org.id)) throw new HttpError(400, 'Antenne inconnue.');
  return b;
}
/** Vérifie qu'une personne fait partie de l'organisation. */
async function memberOf(req, v) {
  const u = idOrNull(v, 'Personne invalide.');
  if (u === null) return null;
  if (!await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, u)) throw new HttpError(400, "Cette personne ne fait pas partie de l'organisation.");
  return u;
}

// ---------- Offres ----------
const ownerPlan = async (org) => (await getUserFresh(org.owner_id) || {}).plan || 'Gratuit';
const limitsFor = (plan) => config.workspaceLimits[plan] || config.workspaceLimits.Gratuit;

/**
 * Période du quota de messages IA d'une organisation.
 * - Offre payante : des blocs de durée d'abonnement (30 jours) alignés sur la date d'échéance, donc le quota se renouvelle en même
 *   temps que l'abonnement (même après un renouvellement anticipé qui prolonge l'échéance).
 * - Offre Gratuite : le mois civil.
 */
async function quotaWindow(org) {
  const u = await getUserFresh(org.owner_id) || {};
  const now = Date.now();
  const exp = u.plan && u.plan !== 'Gratuit' && u.plan_expires ? Date.parse(u.plan_expires) : 0;
  if (exp > now) {
    const len = config.durationDays * 86400000;
    const end = exp - (Math.ceil((exp - now) / len) - 1) * len;
    return { start: new Date(end - len).toISOString(), end: new Date(end).toISOString() };
  }
  const d = new Date(now);
  return { start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(), end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString() };
}
/** Messages IA déjà utilisés par l'organisation sur la période en cours. */
const aiUsed = async (org) => { const w = await quotaWindow(org); return (await db.prepare('SELECT COUNT(*) c FROM ai_usage WHERE org_id = ? AND created_at >= ? AND created_at < ?').get(org.id, w.start, w.end)).c; };

async function logActivity(orgId, userId, module, t) {
  await db.prepare('INSERT INTO activity (org_id, user_id, module, text, created_at) VALUES (?, ?, ?, ?, ?)').run(orgId, userId, module, String(t).slice(0, 300), nowISO());
}

const monthRange = (m) => {
  if (m !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new HttpError(400, 'Mois invalide (format AAAA-MM).');
  const month = m || nowISO().slice(0, 7);
  const [y, mo] = month.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return { month, from: `${month}-01`, to: `${next}-01` };
};

module.exports = { RANK, ROLES, ROLE_LABEL, text, oneOf, date, amount, qty, money0, id, idOrNull, loadOrg, need, can, scope, visible, branchOf, memberOf, ownerPlan, limitsFor, quotaWindow, aiUsed, logActivity, monthRange };
