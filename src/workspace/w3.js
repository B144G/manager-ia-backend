'use strict';
// Socle de la vague 3 : réglages par organisation, notifications internes, journal d'audit (valeurs avant / après), générateur de routes
// simples (liste, création, modification, suppression avec contrôle des champs) et outils CSV.
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError, log, oneLine } = require('../util');

// ---------- Réglages par organisation ----------
const DEFAULTS = {
  leave_accrual: 1.5,          // jours ouvrables acquis par mois (Cameroun : 1,5 j par mois de service, réglable)
  leave_carry_max: 10,         // jours de congé reportables d'une année sur l'autre (0 = aucun report)
  sla_first_high: 1, sla_first_normal: 4, sla_first_low: 8,           // heures avant la première réponse
  sla_resolve_high: 8, sla_resolve_normal: 24, sla_resolve_low: 72,   // heures avant la résolution
  alert_overdue_days: 30,      // facture impayée : alerte « urgente » au-delà de ce retard
  alert_ticket_hours: 48,      // demande sans réponse depuis N heures
  alert_cash_min: 0,           // trésorerie sous ce montant (0 = désactivé)
  alert_receivable_max: 0,     // créances clients au-dessus de ce montant (0 = désactivé)
  alert_contract_days: 30,     // contrats, visites médicales, habilitations : préavis en jours
  goal_revenue_month: 0, goal_new_customers_month: 0, goal_csat: 0,   // objectifs (0 = aucun)
  project_hourly_cost: 0,      // coût horaire moyen d'une heure de travail sur un projet
  mkt_day_quota: 100,          // envois groupés par jour (e-mail + WhatsApp)
};
async function settings(orgId) {
  const out = { ...DEFAULTS };
  for (const r of await db.prepare('SELECT key, value FROM org_settings WHERE org_id = ?').all(orgId)) if (r.key in DEFAULTS && Number.isFinite(Number(r.value))) out[r.key] = Number(r.value);
  return out;
}
async function saveSettings(orgId, body, keys) {
  const b = body || {};
  for (const k of keys) {
    if (b[k] === undefined) continue;
    const n = typeof b[k] === 'string' ? Number(b[k].replace(',', '.')) : b[k];
    if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new HttpError(400, 'Réglage invalide : indiquez un nombre positif ou zéro.');
    await db.prepare('INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, ?) ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value').run(orgId, k, String(n));
  }
  return settings(orgId);
}
/** Ajoute GET et PUT /settings pour un sous-ensemble de réglages. */
function settingsRoutes(router, keys, writeRole = 'admin', readRole = 'manager') {
  router.get('/settings', A.need(readRole), async (req, res) => { const s = await settings(req.org.id); res.json({ settings: Object.fromEntries(keys.map((k) => [k, s[k]])), defaults: Object.fromEntries(keys.map((k) => [k, DEFAULTS[k]])) }); });
  router.put('/settings', A.need(writeRole), async (req, res) => {
    const before = await settings(req.org.id);
    const s = await saveSettings(req.org.id, req.body, keys);
    await audit(req, 'settings', null, 'update', Object.fromEntries(keys.map((k) => [k, before[k]])), Object.fromEntries(keys.map((k) => [k, s[k]])));
    res.json({ settings: Object.fromEntries(keys.map((k) => [k, s[k]])) });
  });
}

// ---------- Notifications internes ----------
/** Prévient une personne dans l'application (et par e-mail si son contact en est un). Ne plante jamais l'action d'origine. */
async function push(orgId, userId, kind, text, ref = '') {
  try {
    if (!userId) return;
    await db.prepare('INSERT INTO notices (org_id, user_id, kind, text, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(orgId, userId, kind, oneLine(text, 300), String(ref).slice(0, 60), nowISO());
    const u = await db.prepare('SELECT contact FROM users WHERE id = ?').get(userId);
    if (u) require('../services/notify').mailUser(u.contact, 'Brij-IA : ' + oneLine(text, 80), text);
  } catch (e) { log.warn('Notification interne :', oneLine(e.message, 120)); }
}
/** Prévient tous les membres dont le rôle est au moins `min`. */
async function pushRole(orgId, min, kind, text, ref = '') {
  const rows = await db.prepare('SELECT user_id, role FROM org_members WHERE org_id = ?').all(orgId);
  for (const m of rows) if (A.RANK[m.role] >= A.RANK[min]) await push(orgId, m.user_id, kind, text, ref);
}

// ---------- Journal d'audit ----------
const MASK = /cni|salary|account|iban|secret|token|pass|data|csat_token|key/i;
function clean(o) {
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) { if (k === 'org_id') continue; out[k] = MASK.test(k) && v ? '***' : v; }
  return out;
}
async function audit(req, entity, id, action, before, after) {
  try {
    await db.prepare('INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, req.user ? req.user.id : null, entity, id == null ? null : Number(id), action, before ? JSON.stringify(clean(before)).slice(0, 4000) : '', after ? JSON.stringify(clean(after)).slice(0, 4000) : '', nowISO());
  } catch (e) { log.warn('Journal d\'audit :', oneLine(e.message, 120)); }
}

// ---------- Champs et routes simples ----------
const snake = (s) => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const camel = (s) => s.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
const camelRow = (r, hide = []) => { const o = {}; for (const [k, v] of Object.entries(r)) if (k !== 'org_id' && !hide.includes(k)) o[camel(k)] = typeof v === 'bigint' ? Number(v) : v; return o; };
const num = (v, msg) => { const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : v; if (!Number.isFinite(n)) throw new HttpError(400, msg || 'Nombre invalide.'); return n; };

/** Valide un champ selon sa définition { k, t, max, req, opts, def, ref, label }. Renvoie la valeur prête pour la base. */
async function parseField(req, f, v) {
  const empty = v === undefined || v === null || v === '';
  if (empty && f.req) throw new HttpError(400, f.msg || `Champ obligatoire : ${f.label || f.k}.`);
  switch (f.t) {
    case 'text': return A.text(v, f.max || 300, { required: f.req, msg: f.msg });
    case 'date': return A.date(v);
    case 'int': if (empty) return f.def === undefined ? 0 : f.def; { const n = Math.round(num(v)); if (n < (f.min ?? -1e12) || n > (f.max ?? 1e12)) throw new HttpError(400, `Valeur hors limites : ${f.label || f.k}.`); return n; }
    case 'num': if (empty) return f.def === undefined ? 0 : f.def; { const n = num(v); if (n < (f.min ?? 0) || n > (f.max ?? 1e9)) throw new HttpError(400, `Valeur hors limites : ${f.label || f.k}.`); return Math.round(n * 1000) / 1000; }
    case 'money': if (empty || Number(v) === 0) return 0; return A.amount(v);
    case 'enum': return A.oneOf(empty ? undefined : v, f.opts, f.def, `Valeur inconnue : ${f.label || f.k}.`);
    case 'bool': if (empty && f.def !== undefined) return f.def; return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    case 'ref': {
      if (empty) { if (f.req) throw new HttpError(400, `Champ obligatoire : ${f.label || f.k}.`); return null; }
      const id = A.id(v);
      const row = await db.prepare(`SELECT * FROM ${f.ref} WHERE id = ? AND org_id = ?`).get(id, req.org.id);
      if (!row || (f.ref === 'employees' && !A.visible(req, row))) throw new HttpError(400, `${f.label || f.k} : élément inconnu.`);
      return id;
    }
    default: throw new Error('type de champ inconnu ' + f.t);
  }
}

/**
 * Routes de base pour une table de l'organisation : GET /path, POST /path, PUT /path/:id, DELETE /path/:id.
 * o = { path, table, entity, read, write, fields, order, filters, decorate(req, rows), onCreate, onUpdate, onDelete, hide, scopeEmployee }
 */
function crud(router, o) {
  const readRole = o.read || 'manager'; const writeRole = o.write || 'manager';
  const cols = o.fields.map((f) => ({ ...f, c: f.c || snake(f.k) }));
  const getRow = async (req, id) => {
    const r = await db.prepare(`SELECT * FROM ${o.table} WHERE id = ? AND org_id = ?`).get(A.id(id), req.org.id);
    if (!r) throw new HttpError(404, o.notFound || 'Élément introuvable.');
    return r;
  };
  router.get(o.path, A.need(readRole), async (req, res) => {
    const where = ['org_id = ?']; const args = [req.org.id];
    for (const f of o.filters || []) {
      const v = req.query[f];
      if (v === undefined || v === '') continue;
      const def = cols.find((c) => c.k === f);
      if (!def) continue;
      where.push(`${def.c} = ?`); args.push(def.t === 'ref' || def.t === 'int' ? A.id(v) : String(v).slice(0, 80));
    }
    let rows = await db.prepare(`SELECT * FROM ${o.table} WHERE ${where.join(' AND ')} ORDER BY ${o.order || 'id DESC'} LIMIT 500`).all(...args);
    if (o.employeeScoped) { const ids = new Set((await require('./hr').employees(req)).map((e) => Number(e.id))); rows = rows.filter((r) => ids.has(Number(r.employee_id))); }
    if (o.decorate) rows = await o.decorate(req, rows);
    res.json({ items: rows.map((r) => (r._view ? r._view : camelRow(r, o.hide))) });
  });
  router.post(o.path, A.need(writeRole), async (req, res) => {
    const b = req.body || {};
    const vals = {};
    for (const f of cols) vals[f.c] = await parseField(req, f, b[f.k]);
    if (o.validate) await o.validate(req, vals, null);
    const extra = o.insertExtra ? o.insertExtra(req) : {};
    const names = ['org_id', ...Object.keys(vals), ...Object.keys(extra), ...(o.noCreated ? [] : ['created_at'])];
    const id = Number((await db.prepare(`INSERT INTO ${o.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(req.org.id, ...Object.values(vals), ...Object.values(extra), ...(o.noCreated ? [] : [nowISO()]))).lastInsertRowid);
    await audit(req, o.entity || o.table, id, 'create', null, vals);
    if (o.onCreate) await o.onCreate(req, id, vals);
    res.status(201).json({ id });
  });
  router.put(`${o.path}/:id`, A.need(writeRole), async (req, res) => {
    const cur = await getRow(req, req.params.id);
    const b = req.body || {};
    const vals = {};
    for (const f of cols) if (b[f.k] !== undefined) vals[f.c] = await parseField(req, f, b[f.k]);
    if (!Object.keys(vals).length) return res.json({ ok: true });
    if (o.validate) await o.validate(req, vals, cur);
    await db.prepare(`UPDATE ${o.table} SET ${Object.keys(vals).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(vals), cur.id);
    const before = Object.fromEntries(Object.keys(vals).map((c) => [c, cur[c]]));
    await audit(req, o.entity || o.table, cur.id, 'update', before, vals);
    if (o.onUpdate) await o.onUpdate(req, cur, vals);
    res.json({ ok: true });
  });
  router.delete(`${o.path}/:id`, A.need(o.del || writeRole), async (req, res) => {
    const cur = await getRow(req, req.params.id);
    if (o.onDelete) await o.onDelete(req, cur);
    await db.prepare(`DELETE FROM ${o.table} WHERE id = ?`).run(cur.id);
    await audit(req, o.entity || o.table, cur.id, 'delete', cur, null);
    res.json({ ok: true });
  });
}

// ---------- CSV ----------
/** Une cellule CSV : guillemets si besoin, et apostrophe devant =, +, -, @ (aucune formule exécutée à l'ouverture dans un tableur). */
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = (header, rows) => '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
function parseCsv(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] || '';
  const delim = [';', ',', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}
const sendCsv = (res, name, header, rows) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' }); res.send(toCsv(header, rows)); };

const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

module.exports = { DEFAULTS, settings, saveSettings, settingsRoutes, push, pushRole, audit, crud, camelRow, camel, snake, parseField, toCsv, parseCsv, sendCsv, today, addDays };
