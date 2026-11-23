'use strict';
// Réunions avancées : socle commun (quorum, conflits d'agenda, empreintes, numérotation, historique des responsabilités, périmètre sites / services).
// Aucune règle de droits n'est changée ici : qui convoque et qui valide reste décidé par le propriétaire (meetings-lib.js).
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const config = require('../config');
const A = require('./access');
const M = require('./meetings-lib');
const { HttpError, oneLine } = require('../util');

const URGENCY = ['normal', 'urgent', 'critical'];
const AGENDA_KINDS = ['info', 'discuss', 'decide'];
const RES_STATUS = ['pending', 'adopted', 'rejected', 'postponed', 'no_quorum'];
const MAJORITY = ['simple', 'qualified', 'unanimity'];
const VOTE_MODES = ['hand', 'named', 'secret'];
const CHOICES = ['for', 'against', 'abstain'];
const MEETING_STATUS = ['planned', 'held', 'cancelled', 'no_quorum'];
const DEFAULT_NOTICE_H = { normal: 24, urgent: 2, critical: 0 };

// ---------- Empreintes ----------
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v === undefined ? null : v));
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : canon(v)).digest('hex');
/** Clé de scrutin : un seul vote par participant sans jamais écrire le nom du votant à côté de son choix (vote secret). */
const voterKey = (resolutionId, participantId) => crypto.createHmac('sha256', config.dataKey || config.jwtSecret).update(`res:${resolutionId}:p:${participantId}`).digest('hex');

// ---------- Réglages avancés : normalisés dans meetings-lib (même configuration que les droits) ----------
const { int, normQuorum, normAdv } = M;

// ---------- Poids de vote, rôles ----------
const weightOf = (p) => (p.vote_weight === null || p.vote_weight === undefined ? (p.user_id ? 1 : 0) : Number(p.vote_weight));
async function rolesOf(orgId) {
  const rows = await db.prepare('SELECT user_id, role FROM org_members WHERE org_id = ?').all(orgId);
  return new Map(rows.map((r) => [Number(r.user_id), r.role]));
}
async function typeRow(orgId, id) { return id ? await db.prepare('SELECT * FROM mtg_types WHERE id = ? AND org_id = ?').get(id, orgId) : null; }

/** Règle de quorum applicable : celle du type personnalisé s'il en a une, sinon celle de la catégorie du type dans les réglages. */
async function quorumRule(orgId, m, cfg) {
  const t = await typeRow(orgId, m.type_id);
  if (t && t.quorum) { try { const q = normQuorum(JSON.parse(t.quorum)); if (q) return q; } catch { /* règle illisible : repli sur la catégorie */ } }
  return (cfg.quorum && cfg.quorum[m.type]) || null;
}
/** Quorum EN DIRECT : présences réelles (cochées pendant le déroulé) des personnes qui ont droit de vote. Sans règle : pas de quorum exigé. */
async function quorumState(req, m, parts, cfg) {
  const rule = await quorumRule(req.org.id, m, cfg);
  const elig = parts.filter((p) => weightOf(p) > 0);
  const base = elig.some((p) => Number(p.required)) ? elig.filter((p) => Number(p.required)) : elig;
  const present = base.filter((p) => p.attended === 'yes');
  const reduced = m.quorum_mode === 'reduced';
  const base0 = { required: Boolean(rule), mode: reduced ? 'reduced' : 'normal', base: base.length, present: present.length, expected: base.filter((p) => p.response === 'present').length };
  if (!rule) return { ...base0, ok: true, need: 0, needCount: 0, needPercent: 0, roles: [], reducedAllowed: false, status: 'none' };
  const eff = reduced && rule.reduced.allowed ? { minCount: rule.reduced.minCount, minPercent: rule.reduced.minPercent, roles: {} } : { minCount: rule.minCount, minPercent: rule.minPercent, roles: rule.roles };
  const byPct = Math.ceil(base.length * eff.minPercent / 100);
  const need = Math.max(eff.minCount, byPct);
  const roleOf = await rolesOf(req.org.id);
  const roles = Object.entries(eff.roles).map(([role, min]) => ({ role, need: min, present: present.filter((p) => roleOf.get(Number(p.user_id)) === role).length }));
  const ok = present.length >= need && roles.every((r) => r.present >= r.need);
  return { ...base0, ok, need, needCount: eff.minCount, needPercent: eff.minPercent, roles, reducedAllowed: rule.reduced.allowed, reduced: rule.reduced, status: ok ? 'ok' : 'missing' };
}

// ---------- Numérotation (unique par organisation et par année) ----------
async function numbered(table, prefix, req, year, insert) {
  for (let i = 0; i < 5; i++) {
    const seq = Number((await db.prepare(`SELECT COALESCE(MAX(seq), 0) s FROM ${table} WHERE org_id = ? AND year = ?`).get(req.org.id, year)).s) + 1;
    const number = `${prefix}-${year}-${String(seq).padStart(3, '0')}`;
    try { return await insert(seq, number); } catch (e) { if (!/duplicate|unique|23505/i.test(`${e.code || ''} ${e.message}`) || i === 4) throw e; }
  }
  return null;
}

// ---------- Historique des responsabilités ----------
async function resp(req, m, { kind, refId, userId, userName = '', role, subject, event = 'assigned' }) {
  await db.prepare('INSERT INTO mtg_resp (org_id, meeting_id, kind, ref_id, user_id, user_name, role, subject, event, at, by_user, confidential) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, m ? m.id : null, kind, refId || 0, userId || null, oneLine(userName, 100), role, oneLine(subject, 300), event, nowISO(), req.user ? req.user.id : null, m && Number(m.confidential) ? 1 : 0);
}
/** Trace un changement de personne responsable (rôle de séance, action, résolution) : l'ancienne personne est « déchargée », la nouvelle « désignée ». */
async function respChange(req, m, { kind, refId, role, subject, before, after, beforeName = '', afterName = '' }) {
  const same = Number(before || 0) === Number(after || 0) && String(beforeName) === String(afterName);
  if (same) return;
  if (before || beforeName) await resp(req, m, { kind, refId, userId: before, userName: beforeName, role, subject, event: 'unassigned' });
  if (after || afterName) await resp(req, m, { kind, refId, userId: after, userName: afterName, role, subject, event: 'assigned' });
}

// ---------- Périmètre : sites (antennes) et services ----------
async function scopeOf(meetingId) {
  const rows = await db.prepare('SELECT kind, ref_id FROM mtg_scope WHERE meeting_id = ?').all(meetingId);
  return { sites: rows.filter((r) => r.kind === 'site').map((r) => Number(r.ref_id)), depts: rows.filter((r) => r.kind === 'dept').map((r) => Number(r.ref_id)) };
}
async function setScope(req, meetingId, { sites, depts }) {
  const put = async (kind, list, table) => {
    if (list === undefined) return;
    if (!Array.isArray(list) || list.length > 30) throw new HttpError(400, kind === 'site' ? 'Liste de sites invalide.' : 'Liste de services invalide.');
    const ids = [...new Set(list.map((x) => A.id(x, kind === 'site' ? 'Site invalide.' : 'Service invalide.')))];
    for (const id of ids) if (!await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND org_id = ?`).get(id, req.org.id)) throw new HttpError(400, kind === 'site' ? 'Site inconnu.' : 'Service inconnu.');
    await db.prepare('DELETE FROM mtg_scope WHERE meeting_id = ? AND kind = ?').run(meetingId, kind);
    for (const id of ids) await db.prepare('INSERT INTO mtg_scope (org_id, meeting_id, kind, ref_id) VALUES (?, ?, ?, ?)').run(req.org.id, meetingId, kind, id);
  };
  await put('site', sites, 'branches');
  await put('dept', depts, 'rh_departments');
}
async function checkBranch(req, v) { return await A.branchOf(req, v); }
async function checkDept(req, v) {
  const id = A.idOrNull(v, 'Service invalide.');
  if (id === null) return null;
  if (!await db.prepare('SELECT 1 FROM rh_departments WHERE id = ? AND org_id = ?').get(id, req.org.id)) throw new HttpError(400, 'Service inconnu.');
  return id;
}
/** Service de chaque membre (module RH : fiche employé reliée à un compte → profil → service). */
async function deptOfUsers(orgId, userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const rows = await db.prepare(`SELECT e.user_id, p.department_id FROM employees e JOIN rh_emp_profile p ON p.employee_id = e.id WHERE e.org_id = ? AND e.user_id IN (${userIds.map(() => '?').join(',')}) AND p.department_id IS NOT NULL`).all(orgId, ...userIds);
  for (const r of rows) map.set(Number(r.user_id), Number(r.department_id));
  return map;
}
async function branchOfUsers(orgId, userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const rows = await db.prepare(`SELECT user_id, branch_id FROM org_members WHERE org_id = ? AND branch_id IS NOT NULL AND user_id IN (${userIds.map(() => '?').join(',')})`).all(orgId, ...userIds);
  for (const r of rows) map.set(Number(r.user_id), Number(r.branch_id));
  return map;
}
/** Sites et services réellement concernés : ceux choisis + ceux des participants (« multi-sites » / « inter-services » se déduisent). */
async function perimeter(m, parts) {
  const sc = await scopeOf(m.id);
  const ids = parts.filter((p) => p.user_id).map((p) => Number(p.user_id));
  const sites = new Set(sc.sites); if (m.branch_id) sites.add(Number(m.branch_id));
  const depts = new Set(sc.depts); if (m.department_id) depts.add(Number(m.department_id));
  for (const b of (await branchOfUsers(m.org_id, ids)).values()) sites.add(b);
  for (const d of (await deptOfUsers(m.org_id, ids)).values()) depts.add(d);
  return { sites: [...sites], depts: [...depts], multiSite: sites.size > 1, interService: depts.size > 1 };
}

// ---------- Conflits d'agenda ----------
const mins = (hhmm) => { const [h, mi] = hhmm.split(':').map(Number); return h * 60 + mi; };
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const overlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
const normPlace = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Participants déjà pris, salle ou lieu déjà occupé, congés approuvés (module RH), jours fériés. Les réunions confidentielles qu'on ne peut pas voir
 * sont signalées « occupé(e) » sans titre. Renvoie aussi des créneaux alternatifs (même jour puis jours suivants).
 */
async function conflictsFor(req, cfg, { date, time, durationMin, place, userIds, excludeId, days = 5 }) {
  const start = mins(time); const end = Math.min(start + durationMin, 1440);
  const placeKey = normPlace(place);
  const dayList = [date];
  for (let i = 1; i <= days; i++) dayList.push(M.addDays(date, i));
  const vis = M.visibleSql(req, cfg);
  const visibleIds = new Set((await db.prepare(`SELECT m.id FROM mtg_meetings m WHERE m.org_id = ? AND m.date >= ? AND m.date <= ?${vis.sql}`).all(req.org.id, dayList[0], dayList[dayList.length - 1], ...vis.args)).map((r) => Number(r.id)));
  const rows = await db.prepare(`SELECT m.id, m.title, m.date, m.start_time, m.duration_min, m.place, m.confidential FROM mtg_meetings m
    WHERE m.org_id = ? AND m.date >= ? AND m.date <= ? AND m.status <> 'cancelled'${excludeId ? ' AND m.id <> ?' : ''}`).all(req.org.id, dayList[0], dayList[dayList.length - 1], ...(excludeId ? [excludeId] : []));
  const partRows = rows.length ? await db.prepare(`SELECT meeting_id, user_id FROM mtg_participants WHERE user_id IS NOT NULL AND meeting_id IN (${rows.map(() => '?').join(',')})`).all(...rows.map((r) => r.id)) : [];
  const usersOf = new Map();
  for (const p of partRows) { const k = Number(p.meeting_id); if (!usersOf.has(k)) usersOf.set(k, new Set()); usersOf.get(k).add(Number(p.user_id)); }
  const names = new Map();
  if (userIds.length) for (const r of await db.prepare(`SELECT id, name FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`).all(...userIds)) names.set(Number(r.id), r.name);
  const leaves = userIds.length ? await db.prepare(`SELECT e.user_id, l.start, l."end", l.kind FROM leaves l JOIN employees e ON e.id = l.employee_id WHERE l.org_id = ? AND l.status = 'approved' AND e.user_id IN (${userIds.map(() => '?').join(',')}) AND l.start <= ? AND l."end" >= ?`).all(req.org.id, ...userIds, dayList[dayList.length - 1], dayList[0]) : [];
  const hol = new Map((await db.prepare('SELECT date, name FROM hr_holidays WHERE org_id = ? AND date >= ? AND date <= ?').all(req.org.id, dayList[0], dayList[dayList.length - 1])).map((h) => [h.date, h.name]));

  const check = (d, s, e) => {
    const out = { participants: [], place: [], leaves: [], holiday: hol.get(d) || null };
    for (const r of rows) {
      if (r.date !== d) continue;
      const rs = mins(r.start_time); const re = Math.min(rs + Number(r.duration_min), 1440);
      if (!overlap(s, e, rs, re)) continue;
      const known = visibleIds.has(Number(r.id));
      const ref = { meetingId: known ? Number(r.id) : null, title: known ? r.title : null, time: r.start_time, endTime: hhmm(re), busy: !known };
      const set = usersOf.get(Number(r.id)) || new Set();
      for (const u of userIds) if (set.has(u)) out.participants.push({ userId: u, name: names.get(u) || '', ...ref });
      if (placeKey && normPlace(r.place) === placeKey) out.place.push({ ...ref, place: known ? r.place : null });
    }
    for (const l of leaves) if (l.start <= d && l.end >= d) out.leaves.push({ userId: Number(l.user_id), name: names.get(Number(l.user_id)) || '', from: l.start, to: l.end, kind: l.kind });
    return out;
  };
  const main = check(date, start, end);
  const total = main.participants.length + main.place.length + main.leaves.length + (main.holiday ? 1 : 0);
  const free = (c) => !c.participants.length && !c.place.length && !c.leaves.length && !c.holiday;
  const alternatives = [];
  if (total) {
    const step = 30; const from = 7 * 60 + 30; const to = 18 * 60;
    for (const d of dayList) {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (wd === 0) continue;
      const slots = [];
      for (let s = from; s + durationMin <= to + 30; s += step) {
        if (d === date && s === start) continue;
        if (free(check(d, s, s + durationMin))) slots.push(s);
      }
      slots.sort((a, b) => Math.abs(a - start) - Math.abs(b - start));
      for (const s of slots.slice(0, d === date ? 3 : 2)) alternatives.push({ date: d, time: hhmm(s), endTime: hhmm(s + durationMin) });
      if (alternatives.length >= 6) break;
    }
  }
  return { count: total, ...main, alternatives: alternatives.slice(0, 6), blocked: Boolean(total) };
}

/** Préavis : délai restant avant la réunion, comparé au minimum du niveau d'urgence (réduit pour une réunion urgente). */
function noticeCheck(adv, urgency, date, time, tz) {
  const need = adv.noticeH[urgency] === undefined ? 0 : adv.noticeH[urgency];
  const hours = (M.startMs({ date, start_time: time }, tz) - Date.now()) / 3600000;
  return { urgency, requiredHours: need, hours: Math.round(hours * 10) / 10, short: hours < need };
}

module.exports = {
  URGENCY, AGENDA_KINDS, RES_STATUS, MAJORITY, VOTE_MODES, CHOICES, MEETING_STATUS, DEFAULT_NOTICE_H,
  canon, sha, voterKey, weightOf, rolesOf, typeRow, quorumRule, quorumState, numbered,
  resp, respChange, scopeOf, setScope, checkBranch, checkDept, deptOfUsers, branchOfUsers, perimeter, conflictsFor, noticeCheck, int, mins, hhmm,
};
