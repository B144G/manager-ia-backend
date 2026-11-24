'use strict';
// Réunions : socle commun (droits désignés par le propriétaire, validations, visibilité, journal, agenda .ics, envois d'e-mails).
// RÈGLE CENTRALE : qui peut CONVOQUER et qui peut VALIDER un compte rendu est décidé par le propriétaire de l'organisation (réglages),
// par personne ou par rôle, éventuellement par type de réunion. Par défaut, seul le propriétaire fait les deux. Toutes les routes
// appliquent ces droits côté serveur : l'interface ne fait que les refléter.
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError, isEmail, oneLine, log, digitsOf } = require('../util');

const TYPES = ['direction', 'team', 'site', 'client', 'committee', 'other'];
const ASSIGNABLE_ROLES = ['member', 'manager', 'admin'];
const RESPONSES = ['pending', 'present', 'absent', 'excused'];
const ATTENDED = ['unknown', 'yes', 'no'];
const FREQS = ['weekly', 'biweekly', 'monthly'];
const REMINDERS = [0, 15, 30, 60, 120, 1440, 2880];
const MAX_PARTICIPANTS = 60;
const MAX_AGENDA = 40;
const MAX_SERIES = 26;
const EDITABLE_MINUTES = ['none', 'draft'];

// ---------- Réglages de droits ----------
const emptyRule = () => ({ users: [], roles: [] });
const emptyCfg = () => ({ convene: { default: emptyRule(), types: {} }, validate: { default: emptyRule(), types: {} }, distinct: false, tz: 60 });

function normRule(r) {
  const users = [...new Set((Array.isArray(r && r.users) ? r.users : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100);
  const roles = [...new Set((Array.isArray(r && r.roles) ? r.roles : []).filter((x) => ASSIGNABLE_ROLES.includes(x)))];
  return { users, roles };
}
function normSide(s) {
  const out = { default: normRule(s && s.default), types: {} };
  for (const t of TYPES) if (s && s.types && s.types[t] && typeof s.types[t] === 'object') out.types[t] = normRule(s.types[t]);
  return out;
}
function normCfg(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const tz = Number.isInteger(Number(c.tz)) && Math.abs(Number(c.tz)) <= 14 * 60 ? Number(c.tz) : 60;
  return { convene: normSide(c.convene), validate: normSide(c.validate), distinct: Boolean(c.distinct), tz };
}
async function getConfig(orgId) {
  const r = await db.prepare('SELECT config FROM mtg_settings WHERE org_id = ?').get(orgId);
  let raw = {};
  try { raw = r ? JSON.parse(r.config) : {}; } catch { raw = {}; }
  return normCfg(raw);
}
const ruleFor = (cfg, kind, type) => cfg[kind].types[type] || cfg[kind].default;
/** Le membre peut-il convoquer / valider pour ce type ? Le propriétaire le peut toujours. */
function allowed(req, cfg, kind, type) {
  if (req.member.role === 'owner') return true;
  const r = ruleFor(cfg, kind, type);
  return r.users.includes(req.user.id) || r.roles.includes(req.member.role);
}
const allowedTypes = (req, cfg, kind) => TYPES.filter((t) => allowed(req, cfg, kind, t));

// ---------- Validations d'entrée ----------
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function time(v, def = '09:00') {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v !== 'string' || !TIME.test(v)) throw new HttpError(400, 'Heure invalide (format HH:MM).');
  return v;
}
function duration(v, def = 60) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 5 || n > 1440) throw new HttpError(400, 'Durée invalide : entre 5 minutes et 24 heures.');
  return n;
}
function type(v, def = 'team') { return A.oneOf(v, TYPES, def, 'Type de réunion inconnu.'); }
function mail(v) {
  const e = A.text(v, 160).toLowerCase();
  if (!e) return '';
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/.test(e)) throw new HttpError(400, 'Adresse e-mail invalide.');
  return e;
}
function phone(v) {
  const p = A.text(v, 30);
  if (!p) return '';
  const d = digitsOf(p);
  if (!/^[+\d][\d\s().-]*$/.test(p) || d.length < 8 || d.length > 15) throw new HttpError(400, 'Numéro de téléphone invalide.');
  return p;
}
/** Lien de visioconférence : http(s) seulement ; le type (Meet, Zoom, Teams, WhatsApp) est déduit de l'adresse. Aucune visio intégrée. */
function link(v) {
  const l = A.text(v, 500);
  if (!l) return { link: '', kind: '' };
  let u;
  try { u = new URL(l); } catch { throw new HttpError(400, 'Lien invalide : collez l’adresse complète (https://…).'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new HttpError(400, 'Lien invalide : seules les adresses http(s) sont acceptées.');
  const h = u.hostname.toLowerCase();
  const kind = /(^|\.)meet\.google\.com$/.test(h) ? 'meet' : /(^|\.)zoom\.us$/.test(h) || /(^|\.)zoom\.com$/.test(h) ? 'zoom' : /(^|\.)teams\.(microsoft|live)\.com$/.test(h) ? 'teams'
    : /(^|\.)(wa\.me|whatsapp\.com)$/.test(h) ? 'whatsapp' : 'other';
  return { link: u.toString().slice(0, 500), kind };
}
const wholeNumber = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, msg); return n; };

// ---------- Dates ----------
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** Occurrence n d'une série (date de départ AAAA-MM-JJ). Mensuel : même jour du mois, ramené à la fin du mois si besoin. */
function occurrence(start, freq, n) {
  if (freq === 'weekly') return addDays(start, 7 * n);
  if (freq === 'biweekly') return addDays(start, 14 * n);
  const [y, m, d] = start.split('-').map(Number);
  const idx = (m - 1) + n;
  const yy = y + Math.floor(idx / 12); const mm = idx % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
/** Début de la réunion en instant UTC (ms), selon le décalage horaire de l'organisation (60 min = Cameroun). */
function startMs(m, tz) {
  const [y, mo, d] = m.date.split('-').map(Number); const [h, mi] = (m.start_time || '09:00').split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - tz * 60000;
}
const endTime = (m) => { const [h, mi] = m.start_time.split(':').map(Number); const t = h * 60 + mi + Number(m.duration_min); return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

// ---------- Journal propre au module ----------
/** Journal de traçabilité. Pas de donnée personnelle superflue : jamais d'e-mail ni de numéro, seulement l'essentiel (qui, quoi, quand). */
async function mlog(req, meetingId, action, detail = '', n = 0) {
  await db.prepare('INSERT INTO mtg_log (org_id, meeting_id, user_id, action, detail, n, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, meetingId || null, req.user ? req.user.id : null, action, oneLine(detail, 300), n, nowISO());
  // Chat interne : l'ordre du jour, les décisions, les actions et le compte rendu sont aussi publiés dans le fil de discussion de la réunion (s'il existe).
  if (meetingId && ['agenda', 'decision', 'action', 'submitted', 'validated', 'returned'].includes(action)) {
    const t = setTimeout(() => require('./chat-objects').meetingEvent(req.org, meetingId, action, detail, req.user).catch(() => {}), 400); // après la validation de la transaction en cours
    if (t.unref) t.unref();
  }
}
/** Journal général de l'organisation : le titre d'une réunion confidentielle n'y figure jamais (le fil d'activité est lu par toute l'équipe). */
async function activity(req, m, text) {
  await A.logActivity(req.org.id, req.user.id, 'meetings', Number(m.confidential) ? text.replace(/« [^»]*»/, 'confidentielle') : text);
}

// ---------- Chargement et visibilité ----------
async function participantsOf(meetingId) {
  return await db.prepare(`SELECT p.*, u.name AS uname FROM mtg_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.meeting_id = ? ORDER BY p.id`).all(meetingId);
}

/** Contexte de droits de la personne pour une réunion (sans lever d'erreur). */
async function contextFor(req, m, cfg, parts) {
  const owner = req.member.role === 'owner';
  const uid = req.user.id;
  const mine = (parts || await participantsOf(m.id)).find((p) => Number(p.user_id) === uid) || null;
  const convene = allowed(req, cfg, 'convene', m.type);
  const validate = allowed(req, cfg, 'validate', m.type);
  const organizer = Number(m.organizer_id) === uid || Number(m.created_by) === uid;
  const secretary = Number(m.secretary_id) === uid;
  const see = !Number(m.confidential) || owner || organizer || secretary || validate || Boolean(mine);
  const write = owner || organizer || secretary || convene;
  return { owner, mine, convene, validate, organizer, secretary, see, write, manage: owner || organizer || convene, draftVisible: write || validate };
}

/** Réunion de l'organisation visible par la personne, sinon 404 (jamais de fuite d'existence). */
async function load(req, id, cfg) {
  const m = await db.prepare('SELECT * FROM mtg_meetings WHERE id = ? AND org_id = ?').get(A.id(id, 'Réunion introuvable.'), req.org.id);
  if (!m) throw new HttpError(404, 'Réunion introuvable.');
  const config = cfg || await getConfig(req.org.id);
  const parts = await participantsOf(m.id);
  const ctx = await contextFor(req, m, config, parts);
  if (!ctx.see) throw new HttpError(404, 'Réunion introuvable.');
  return { m, cfg: config, parts, ctx };
}
/** Filtre SQL de visibilité (listes, calendrier, recherche, tableau de bord) : même règle que load(). */
function visibleSql(req, cfg, alias = 'm') {
  if (req.member.role === 'owner') return { sql: '', args: [] };
  const uid = req.user.id;
  const vTypes = allowedTypes(req, cfg, 'validate');
  const inTypes = vTypes.length ? ` OR ${alias}.type IN (${vTypes.map(() => '?').join(',')})` : '';
  return {
    sql: ` AND (${alias}.confidential = 0 OR ${alias}.organizer_id = ? OR ${alias}.created_by = ? OR ${alias}.secretary_id = ?${inTypes} OR EXISTS (SELECT 1 FROM mtg_participants vp WHERE vp.meeting_id = ${alias}.id AND vp.user_id = ?))`,
    args: [uid, uid, uid, ...vTypes, uid],
  };
}
const lockedMsg = (m) => (m.minutes_status === 'validated'
  ? 'Le compte rendu est validé et verrouillé. Créez une nouvelle version pour le modifier.'
  : 'Le compte rendu est soumis à validation : il ne peut plus être modifié (il peut être renvoyé par le validateur).');
function needOpen(m) { if (!EDITABLE_MINUTES.includes(m.minutes_status)) throw new HttpError(409, lockedMsg(m)); }
function needNotCancelled(m) { if (m.status === 'cancelled') throw new HttpError(409, 'Cette réunion est annulée.'); }
function needWrite(ctx) { if (!ctx.write) throw new HttpError(403, "Vous n'avez pas le droit de modifier cette réunion."); }

// ---------- Participants ----------
/** Normalise la liste fournie : membres de l'organisation et invités externes (nom + e-mail ou numéro). */
async function cleanParticipants(req, list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new HttpError(400, 'Liste de participants invalide.');
  if (list.length > MAX_PARTICIPANTS) throw new HttpError(400, `Pas plus de ${MAX_PARTICIPANTS} participants par réunion.`);
  const seenU = new Set(); const seenG = new Set(); const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') throw new HttpError(400, 'Participant invalide.');
    const required = p.required === false || p.required === 0 ? 0 : 1;
    if (p.userId !== undefined && p.userId !== null && p.userId !== '') {
      const uid = await A.memberOf(req, p.userId);
      if (seenU.has(uid)) continue;
      seenU.add(uid);
      out.push({ userId: uid, name: '', email: '', phone: '', required });
    } else {
      const name = A.text(p.name, 100, { required: true, msg: "Indiquez le nom de l'invité." });
      const email = mail(p.email); const ph = phone(p.phone);
      if (!email && !ph) throw new HttpError(400, `Pour inviter « ${oneLine(name, 40)} », indiquez une adresse e-mail ou un numéro de téléphone.`);
      const key = email || digitsOf(ph);
      if (seenG.has(key)) continue;
      seenG.add(key);
      out.push({ userId: null, name, email, phone: ph, required });
    }
  }
  return out;
}
async function addParticipants(orgId, meetingId, list) {
  const now = nowISO();
  for (const p of list) {
    await db.prepare('INSERT INTO mtg_participants (org_id, meeting_id, user_id, name, email, phone, required, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(orgId, meetingId, p.userId, p.name, p.email, p.phone, p.required, now);
  }
}

/** Ordre du jour : points avec titre, responsable (membre ou nom libre) et durée prévue. */
async function cleanAgenda(req, list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new HttpError(400, "Ordre du jour invalide.");
  if (list.length > MAX_AGENDA) throw new HttpError(400, `Pas plus de ${MAX_AGENDA} points à l'ordre du jour.`);
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') throw new HttpError(400, 'Point invalide.');
    const title = A.text(it.title, 200, { required: true, msg: 'Chaque point de l’ordre du jour doit avoir un titre.' });
    const ownerId = await A.memberOf(req, it.ownerId);
    const d = it.durationMin === undefined || it.durationMin === null || it.durationMin === '' ? 0 : wholeNumber(it.durationMin, 0, 600, 'Durée d’un point invalide (0 à 600 minutes).');
    out.push({ id: it.id ? A.id(it.id) : null, title, ownerId, ownerName: ownerId ? '' : A.text(it.ownerName, 100), durationMin: d });
  }
  return out;
}

// ---------- Vues ----------
const partView = (p, seeContact) => ({
  id: Number(p.id), userId: p.user_id == null ? null : Number(p.user_id), name: p.uname || p.name || '', kind: p.user_id == null ? 'guest' : 'member',
  email: seeContact ? p.email : undefined, phone: seeContact ? p.phone : undefined,
  required: Boolean(Number(p.required)), response: p.response, reason: p.reason, attended: p.attended, invited: Boolean(p.invited_at), respondedAt: p.responded_at || null,
});
const meetingRow = (m, extra = {}) => ({
  id: Number(m.id), title: m.title, type: m.type, date: m.date, time: m.start_time, endTime: endTime(m), durationMin: Number(m.duration_min),
  place: m.place, link: m.link, linkKind: m.link_kind, objective: m.objective, confidential: Boolean(Number(m.confidential)),
  status: m.status, cancelReason: m.cancel_reason, minutesStatus: m.minutes_status, minutesVersion: Number(m.minutes_version),
  organizerId: m.organizer_id == null ? null : Number(m.organizer_id), secretaryId: m.secretary_id == null ? null : Number(m.secretary_id),
  projectId: m.project_id == null ? null : Number(m.project_id), seriesId: m.series_id == null ? null : Number(m.series_id), seriesFreq: m.series_freq || '',
  reminderMin: Number(m.reminder_min), ...extra,
});

/** Statut d'une action : celui de la tâche de Projets quand elle existe (le statut « remonte » dans la réunion), sinon celui de l'action. */
const taskToAction = (s) => (s === 'done' ? 'done' : 'open');
async function actionsOf(meetingId) {
  const rows = await db.prepare(`SELECT a.*, t.status AS task_status, t.due AS task_due, t.assignee_id AS task_assignee, u.name AS uname
    FROM mtg_actions a LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN users u ON u.id = a.assignee_id WHERE a.meeting_id = ? ORDER BY a.position, a.id`).all(meetingId);
  return rows.map(actionView);
}
function actionView(a) {
  const status = a.status === 'cancelled' ? 'cancelled' : a.task_id && a.task_status ? taskToAction(a.task_status) : a.status;
  const due = a.task_id && a.task_due !== undefined && a.task_due !== null ? a.task_due : a.due;
  return {
    id: Number(a.id), meetingId: Number(a.meeting_id), agendaId: a.agenda_id == null ? null : Number(a.agenda_id), text: a.text,
    assigneeId: a.assignee_id == null ? null : Number(a.assignee_id), assignee: a.uname || a.assignee_name || '', due: due || null,
    status, taskId: a.task_id == null ? null : Number(a.task_id), taskStatus: a.task_status || null,
    overdue: status === 'open' && Boolean(due) && due < today(),
    meetingTitle: a.meeting_title, meetingDate: a.meeting_date,
  };
}

// ---------- Agenda .ics ----------
const icsEsc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) { const out = []; let s = line; while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); } out.push(s); return out.join('\r\n'); }
const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Fichier .ics (invitation) : une entrée par réunion. Importable dans Google Agenda, Outlook, Apple. */
function buildIcs(org, meetings, tz, { cancelled = false } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brij-IA//Reunions//FR', 'CALSCALE:GREGORIAN', `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`];
  for (const m of meetings) {
    const s = startMs(m, tz);
    const desc = [m.objective, m.link ? `Lien : ${m.link}` : ''].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:mtg-${m.id}-${org.id}@brij-ia`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(s)}`, `DTEND:${icsDate(s + Number(m.duration_min) * 60000)}`,
      `SUMMARY:${icsEsc(m.title)}`, m.place || m.link ? `LOCATION:${icsEsc(m.place || m.link)}` : null, desc ? `DESCRIPTION:${icsEsc(desc)}` : null,
      m.link ? `URL:${icsEsc(m.link)}` : null, `STATUS:${m.status === 'cancelled' || cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

// ---------- E-mails ----------
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function dateFr(d) { const [y, m, dd] = d.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); return `${DAYS[w]} ${dd} ${MONTHS[m - 1]} ${y}`; }
const TYPE_FR = { direction: 'Direction', team: 'Équipe', site: 'Chantier', client: 'Client', committee: 'Comité', other: 'Autre' };

function whenLine(m) { return `${dateFr(m.date)} à ${m.start_time.replace(':', 'h')} (durée ${m.duration_min} min)`; }
function whereLine(m) { return [m.place, m.link].filter(Boolean).join(' · ') || 'Lieu à préciser'; }

/** Quota quotidien d'e-mails de l'organisation (celui de l'offre), partagé avec les e-mails aux clients (outbox) et les envois du module. */
async function mailBudget(req) {
  const lim = A.limitsFor(await A.ownerPlan(req.org)).emailDay;
  const since = `${nowISO().slice(0, 10)}T00:00:00.000Z`;
  const a = Number((await db.prepare("SELECT COUNT(*) c FROM outbox WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(req.org.id, since)).c);
  const b = Number((await db.prepare("SELECT COALESCE(SUM(n), 0) s FROM mtg_log WHERE org_id = ? AND action = 'mail' AND created_at >= ?").get(req.org.id, since)).s);
  return { limit: lim, used: a + b, left: Math.max(lim - a - b, 0) };
}
/** Envoie à chaque destinataire (un par un, sans jamais planter l'action d'origine). Renvoie { sent, failed, skipped, enabled }. */
async function sendMany(req, meetingId, recipients, build, label) {
  const { sendMail, mailEnabled } = require('../services/notify');
  const out = { sent: 0, failed: 0, skipped: 0, enabled: mailEnabled(), capped: false };
  if (!out.enabled) { out.skipped = recipients.length; return out; }
  let budget = await mailBudget(req);
  const owner = await db.prepare('SELECT contact FROM users WHERE id = ?').get(req.org.owner_id);
  const replyTo = [req.user.contact, owner && owner.contact].find((c) => isEmail(c));
  for (const r of recipients) {
    if (budget.left <= 0) { out.capped = true; out.skipped++; continue; }
    try {
      const msg = build(r);
      const ok = await sendMail({ to: r.email, subject: msg.subject, text: msg.text, replyTo, fromName: req.org.name, attachments: msg.attachments });
      if (ok) { out.sent++; budget.left--; } else out.skipped++;
    } catch (e) { out.failed++; log.warn('Réunions : e-mail non envoyé :', oneLine(e.message, 120)); }
  }
  if (out.sent) await db.prepare("INSERT INTO mtg_log (org_id, meeting_id, user_id, action, detail, n, created_at) VALUES (?, ?, ?, 'mail', ?, ?, ?)").run(req.org.id, meetingId || null, req.user.id, label, out.sent, nowISO());
  return out;
}
/** Notice dans l'application. N'envoie pas d'e-mail (voir sendMany pour les e-mails avec agenda .ics). */
async function notice(orgId, userId, kind, text, ref = '') {
  try {
    if (!userId) return;
    await db.prepare('INSERT INTO notices (org_id, user_id, kind, text, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(orgId, userId, kind, oneLine(text, 300), String(ref).slice(0, 60), nowISO());
  } catch (e) { log.warn('Réunions : notice non créée :', oneLine(e.message, 120)); }
}

module.exports = {
  TYPES, RESPONSES, ATTENDED, FREQS, REMINDERS, ASSIGNABLE_ROLES, MAX_SERIES, TYPE_FR, EDITABLE_MINUTES,
  emptyCfg, normCfg, normRule, getConfig, ruleFor, allowed, allowedTypes,
  time, duration, type, mail, phone, link, wholeNumber, today, addDays, occurrence, startMs, endTime, dateFr, whenLine, whereLine,
  mlog, activity, participantsOf, contextFor, load, visibleSql, needOpen, needNotCancelled, needWrite, lockedMsg,
  cleanParticipants, addParticipants, cleanAgenda, partView, meetingRow, actionsOf, actionView, taskToAction,
  buildIcs, mailBudget, sendMany, notice,
};
