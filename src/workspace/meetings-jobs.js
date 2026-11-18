'use strict';
// Réunions : rappels automatiques (réunion qui approche ; action bientôt à échéance ou en retard). Notices dans l'application (+ e-mail si configuré).
// Chaque rappel n'est envoyé qu'une fois (marqueurs reminded_at / reminded_stage posés avant l'envoi : aucun doublon, même avec plusieurs serveurs).
const { db, nowISO } = require('../db');
const M = require('./meetings-lib');
const { oneLine, log, isEmail } = require('../util');

const EVERY = 10 * 60 * 1000;

async function mailTo(userIds, subject, text, orgName) {
  if (!userIds.length) return;
  const { sendMail, mailEnabled } = require('../services/notify');
  if (!mailEnabled()) return;
  const rows = await db.prepare(`SELECT contact FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`).all(...userIds);
  for (const r of rows) if (isEmail(r.contact)) await sendMail({ to: r.contact, subject, text: `${text}\n\n— ${orgName}`, fromName: orgName }).catch((e) => log.warn('Réunions : rappel non envoyé :', oneLine(e.message, 100)));
}

/** Rappels de réunions : tous ceux dont l'heure de rappel est passée et dont la réunion n'a pas encore eu lieu. */
async function remindMeetings(orgId) {
  const rows = await db.prepare(`SELECT m.*, o.name AS org_name FROM mtg_meetings m JOIN orgs o ON o.id = m.org_id
    WHERE m.status = 'planned' AND m.reminder_min > 0 AND m.reminded_at IS NULL AND m.date >= ? AND m.date <= ?${orgId ? ' AND m.org_id = ?' : ''}`)
    .all(M.addDays(M.today(), -1), M.addDays(M.today(), 4), ...(orgId ? [orgId] : []));
  let sent = 0;
  const tzCache = new Map();
  for (const m of rows) {
    if (!tzCache.has(m.org_id)) tzCache.set(m.org_id, (await M.getConfig(m.org_id)).tz);
    const start = M.startMs(m, tzCache.get(m.org_id));
    const now = Date.now();
    if (now < start - Number(m.reminder_min) * 60000 || now > start) continue;
    const claimed = await db.prepare('UPDATE mtg_meetings SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL').run(nowISO(), m.id);
    if (!claimed.changes) continue;
    const parts = await M.participantsOf(m.id);
    const ids = parts.filter((p) => p.user_id && p.response !== 'absent' && p.response !== 'excused').map((p) => Number(p.user_id));
    const text = `Rappel : réunion « ${Number(m.confidential) ? 'confidentielle' : m.title} » ${M.whenLine(m)}. ${M.whereLine(m)}`;
    for (const uid of ids) await M.notice(m.org_id, uid, 'meeting_reminder', text, `meeting:${m.id}`);
    await mailTo(ids, `Rappel de réunion : ${Number(m.confidential) ? 'réunion confidentielle' : m.title}`, text, m.org_name);
    await db.prepare("INSERT INTO mtg_log (org_id, meeting_id, user_id, action, detail, n, created_at) VALUES (?, ?, NULL, 'reminder', ?, 0, ?)").run(m.org_id, m.id, `Rappel envoyé à ${ids.length} personne(s)`, nowISO());
    sent++;
  }
  return sent;
}

/** Rappels d'actions : 1 jour avant l'échéance (étape 1) puis au premier jour de retard (étape 2). Rien si la tâche est déjà faite. */
async function remindActions(orgId) {
  const today = M.today(); const tomorrow = M.addDays(today, 1);
  const rows = await db.prepare(`SELECT a.*, m.title AS mtitle, m.confidential, o.name AS org_name FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id JOIN orgs o ON o.id = a.org_id
    LEFT JOIN tasks t ON t.id = a.task_id WHERE a.task_id IS NOT NULL AND a.status = 'open' AND (t.id IS NULL OR t.status <> 'done') AND a.assignee_id IS NOT NULL AND a.due IS NOT NULL AND a.due <= ?${orgId ? ' AND a.org_id = ?' : ''}`)
    .all(tomorrow, ...(orgId ? [orgId] : []));
  let sent = 0;
  for (const a of rows) {
    const stage = a.due < today ? 2 : 1;
    if (Number(a.reminded_stage) >= stage) continue;
    const claimed = await db.prepare('UPDATE mtg_actions SET reminded_stage = ? WHERE id = ? AND reminded_stage < ?').run(stage, a.id, stage);
    if (!claimed.changes) continue;
    const text = stage === 2 ? `Action en retard (échéance ${a.due}) : ${oneLine(a.text, 160)}` : `Action à rendre demain (${a.due}) : ${oneLine(a.text, 160)}`;
    await M.notice(a.org_id, a.assignee_id, 'meeting_action', text, `task:${a.task_id}`);
    await mailTo([Number(a.assignee_id)], stage === 2 ? 'Action en retard' : 'Action à rendre demain', text, a.org_name);
    sent++;
  }
  return sent;
}

async function runForOrg(orgId) { return { meetings: await remindMeetings(orgId), actions: await remindActions(orgId) }; }
async function runAll() {
  try { return { meetings: await remindMeetings(null), actions: await remindActions(null) }; } catch (e) { log.warn('Réunions : rappels :', oneLine(e.message, 160)); return null; }
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  setTimeout(() => { runAll(); }, 60 * 1000).unref();
  timer = setInterval(runAll, EVERY); timer.unref();
}
start();

module.exports = { runForOrg, runAll, remindMeetings, remindActions };
