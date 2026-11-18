'use strict';
// Administration : socle commun (droits désignés par le propriétaire, dates, JSON sûr, alertes uniques, accès aux autres modules).
// RÈGLE CENTRALE : le propriétaire de l'organisation désigne, par personne ou par rôle, qui peut CRÉER les circuits de validation et qui
// peut les VALIDER (les mettre en service), ainsi que les autres droits d'administration (procédures, GED, contrôle interne, moyens, contrats).
// Tant que rien n'est désigné : circuits = propriétaire seul ; les autres droits suivent un rôle minimal par défaut. Toujours appliqué côté serveur.
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, log, oneLine } = require('../util');

const PERM_KEYS = ['flow_design', 'flow_validate', 'sop_write', 'sop_approve', 'docs_manage', 'docs_destroy', 'control_manage', 'assets_manage', 'contracts_manage', 'org_manage'];
// Rôle minimal quand aucune règle n'est posée ; null = propriétaire seulement.
const DEFAULT_MIN = { flow_design: null, flow_validate: null, sop_write: 'manager', sop_approve: 'admin', docs_manage: 'manager', docs_destroy: 'admin', control_manage: 'admin', assets_manage: 'manager', contracts_manage: 'manager', org_manage: 'admin' };
const ASSIGNABLE_ROLES = ['member', 'manager', 'admin'];

const normRule = (r) => ({
  users: [...new Set((Array.isArray(r && r.users) ? r.users : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100),
  roles: [...new Set((Array.isArray(r && r.roles) ? r.roles : []).filter((x) => ASSIGNABLE_ROLES.includes(x)))],
});
function normCfg(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const perms = {};
  for (const k of PERM_KEYS) perms[k] = normRule(c.perms && c.perms[k]);
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  return {
    perms,
    distinct: Boolean(c.distinct), // circuit créé par une personne : validé par une autre
    contractAlertDays: num(c.contractAlertDays, 60, 1, 365),
    complianceAlertDays: num(c.complianceAlertDays, 30, 1, 365),
    sopReminderDays: num(c.sopReminderDays, 30, 1, 365),
    docAlertDays: num(c.docAlertDays, 60, 1, 365),
    assetAlertDays: num(c.assetAlertDays, 30, 1, 365),
  };
}
async function getConfig(orgId) {
  const r = await db.prepare('SELECT config FROM adm_settings WHERE org_id = ?').get(orgId);
  let raw = {};
  try { raw = r ? JSON.parse(r.config) : {}; } catch { raw = {}; }
  return normCfg(raw);
}
async function saveConfig(req, body) {
  const cfg = normCfg(body);
  for (const k of PERM_KEYS) { // chaque personne désignée doit faire partie de l'organisation
    for (const u of cfg.perms[k].users) if (!await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, u)) throw new HttpError(400, "Une personne désignée ne fait pas partie de l'organisation.");
  }
  const now = nowISO();
  await db.prepare('INSERT INTO adm_settings (org_id, config, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at')
    .run(req.org.id, JSON.stringify(cfg), req.user.id, now);
  return cfg;
}
/** Le membre a-t-il ce droit ? Le propriétaire l'a toujours. */
function allowed(req, cfg, key) {
  if (req.member.role === 'owner') return true;
  const r = cfg.perms[key];
  if (r.users.includes(req.user.id) || r.roles.includes(req.member.role)) return true;
  if (r.users.length || r.roles.length) return false; // une règle posée remplace le rôle par défaut
  const min = DEFAULT_MIN[key];
  return Boolean(min) && A.can(req, min);
}
/** Middleware : exige un droit d'administration désigné. La config est mise en cache sur la requête. */
const needPerm = (key) => async (req, res, next) => {
  req.admCfg = req.admCfg || await getConfig(req.org.id);
  if (!allowed(req, req.admCfg, key)) throw new HttpError(403, "Vous n'avez pas ce droit : le responsable du compte désigne qui peut le faire (Administration > Réglages).");
  next();
};
const permsOf = (req, cfg) => Object.fromEntries(PERM_KEYS.map((k) => [k, allowed(req, cfg, k)]));

// ---------- Dates ----------
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d.length === 10 ? d + 'T00:00:00Z' : d); x.setUTCDate(x.getUTCDate() + Math.round(n)); return x.toISOString().slice(0, 10); };
const addMonths = (d, n) => { const x = new Date(d + 'T00:00:00Z'); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + Math.round(n)); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
/** Ajoute des années (décimales permises : 0,5 = 6 mois). */
const addYears = (d, y) => addMonths(d, Math.round(Number(y) * 12));
const daysBetween = (a, b) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);
const FREQ_MONTHS = { daily: 0, weekly: 0, monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
const FREQ_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 91, semiannual: 182, yearly: 365 };
const nextByFreq = (from, f) => (FREQ_MONTHS[f] ? addMonths(from, FREQ_MONTHS[f]) : addDays(from, FREQ_DAYS[f] || 30));

// ---------- JSON sûr ----------
const jparse = (s, def) => { try { const v = JSON.parse(s); return v === null || v === undefined ? def : v; } catch { return def; } };
const strList = (v, maxItems = 60, maxLen = 400) => (Array.isArray(v) ? v : []).map((x) => A.text(x, maxLen)).filter(Boolean).slice(0, maxItems);
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const out = (r, extra = {}) => { const o = {}; for (const [k, v] of Object.entries(r)) if (k !== 'org_id') o[W.camel(k)] = num(v); return { ...o, ...extra }; };

// ---------- Alerte unique (une seule fois par clé) + notification interne ----------
async function once(orgId, key) {
  const r = await db.prepare('INSERT INTO adm_alerts (org_id, key, created_at) VALUES (?, ?, ?) ON CONFLICT (org_id, key) DO NOTHING').run(orgId, String(key).slice(0, 160), nowISO());
  return r.changes > 0;
}
async function notifyOnce(orgId, key, userIds, text, ref = '') {
  if (!await once(orgId, key)) return false;
  for (const u of [...new Set(userIds.filter(Boolean))]) await W.push(orgId, u, 'administration', text, ref);
  return true;
}
const ownerIds = async (orgId) => (await db.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role IN ('owner','admin')").all(orgId)).map((r) => r.user_id);

// ---------- Personnes ----------
async function members(orgId) {
  const rows = await db.prepare('SELECT m.user_id, m.role, m.title, m.branch_id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.id').all(orgId);
  return rows.map((m) => ({ userId: Number(m.user_id), role: m.role, title: m.title, branchId: m.branch_id, name: m.name }));
}
async function nameMap(orgId) { return new Map((await members(orgId)).map((m) => [m.userId, m.name])); }

/** Une table d'un autre module existe-t-elle ? (modules facultatifs : Réunions, RH talents, immobilisations…) */
async function hasTable(name) {
  try { const r = await db.prepare('SELECT to_regclass(?) AS t').get('public.' + name); return Boolean(r && r.t); } catch { return false; }
}
async function safe(fn, def) { try { return await fn(); } catch (e) { log.warn('Administration :', oneLine(e.message, 120)); return def; } }

const dateOrNull = A.date;
const money = (v) => (v === undefined || v === null || v === '' ? 0 : Math.round(Math.max(0, Math.min(1e12, Number(typeof v === 'string' ? v.replace(/\s/g, '').replace(',', '.') : v) || 0))));
const intIn = (v, lo, hi, def) => { if (v === undefined || v === null || v === '') return def; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `Nombre invalide (entre ${lo} et ${hi}).`); return n; };
const flag = (v, def = 0) => (v === undefined ? def : v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

module.exports = {
  PERM_KEYS, DEFAULT_MIN, getConfig, saveConfig, allowed, needPerm, permsOf, today, addDays, addMonths, addYears, daysBetween, FREQ_MONTHS, FREQ_DAYS, nextByFreq,
  jparse, strList, num, out, once, notifyOnce, ownerIds, members, nameMap, hasTable, safe, dateOrNull, money, intIn, flag,
};
