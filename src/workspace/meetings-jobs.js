'use strict';
// Réunions : rappels automatiques (réunion qui approche ; action bientôt à échéance ou en retard). Notices dans l'application (+ e-mail si configuré).
// Chaque rappel n'est envoyé qu'une fois (marqueurs reminded_at / reminded_stage posés avant l'envoi : aucun doublon, même avec plusieurs serveurs).
const { db, nowISO } = require('../db');
const M = require('./meetings-lib');
const X = require('./meetings-adv-lib');
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
    const text = `${m.urgency && m.urgency !== 'normal' ? 'URGENT — ' : ''}Rappel : réunion « ${Number(m.confidential) ? 'confidentielle' : m.title} » ${M.whenLine(m)}. ${M.whereLine(m)}`;
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
  const rows = await db.prepare(`SELECT a.*, m.title AS mtitle, m.confidential, m.organizer_id AS organizer_id, o.name AS org_name FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id JOIN orgs o ON o.id = a.org_id
    LEFT JOIN tasks t ON t.id = a.task_id WHERE a.task_id IS NOT NULL AND a.status = 'open' AND (t.id IS NULL OR t.status <> 'done') AND a.assignee_id IS NOT NULL AND a.due IS NOT NULL AND a.due <= ?${orgId ? ' AND a.org_id = ?' : ''}`)
    .all(tomorrow, ...(orgId ? [orgId] : []));
  let sent = 0;
  for (const a of rows) {
    const stage = a.due < M.addDays(today, -7) ? 3 : a.due < today ? 2 : 1;
    if (Number(a.reminded_stage) >= stage) continue;
    const claimed = await db.prepare('UPDATE mtg_actions SET reminded_stage = ? WHERE id = ? AND reminded_stage < ?').run(stage, a.id, stage);
    if (!claimed.changes) continue;
    const text = stage >= 2 ? `Action en retard${stage === 3 ? ' depuis plus d’une semaine' : ''} (échéance ${a.due}) : ${oneLine(a.text, 160)}` : `Action à rendre demain (${a.due}) : ${oneLine(a.text, 160)}`;
    await M.notice(a.org_id, a.assignee_id, 'meeting_action', text, `task:${a.task_id}`);
    if (stage === 3 && a.organizer_id && Number(a.organizer_id) !== Number(a.assignee_id)) await M.notice(a.org_id, a.organizer_id, 'meeting_action', `Engagement non tenu : ${oneLine(a.text, 140)} (échéance ${a.due}).`, `task:${a.task_id}`);
    await mailTo([Number(a.assignee_id)], stage >= 2 ? 'Action en retard' : 'Action à rendre demain', text, a.org_name);
    sent++;
  }
  return sent;
}

/** Quorum menacé : à moins de 24 h de la réunion, si les présences confirmées sont sous le quorum, l'organisateur et le secrétaire sont prévenus (une seule fois). */
async function remindQuorum(orgId) {
  const rows = await db.prepare(`SELECT m.* FROM mtg_meetings m WHERE m.status = 'planned' AND m.quorum_alerted_at IS NULL AND m.date >= ? AND m.date <= ?${orgId ? ' AND m.org_id = ?' : ''}`)
    .all(M.today(), M.addDays(M.today(), 2), ...(orgId ? [orgId] : []));
  let sent = 0;
  const cfgs = new Map();
  for (const m of rows) {
    if (!cfgs.has(m.org_id)) cfgs.set(m.org_id, await M.getConfig(m.org_id));
    const cfg = cfgs.get(m.org_id);
    const start = M.startMs(m, cfg.tz); const now = Date.now();
    if (start - now > 24 * 3600000 || now > start) continue;
    const q = await X.quorumState({ org: { id: m.org_id } }, m, await M.participantsOf(m.id), cfg);
    if (!q.required || q.expected >= q.need) continue;
    const claimed = await db.prepare('UPDATE mtg_meetings SET quorum_alerted_at = ? WHERE id = ? AND quorum_alerted_at IS NULL').run(nowISO(), m.id);
    if (!claimed.changes) continue;
    const text = `Quorum menacé pour ${Number(m.confidential) ? 'une réunion confidentielle' : `« ${m.title} »`} (${M.whenLine(m)}) : ${q.expected} présence(s) confirmée(s), ${q.need} requise(s).`;
    for (const uid of [...new Set([m.organizer_id, m.secretary_id].filter(Boolean).map(Number))]) await M.notice(m.org_id, uid, 'meeting_quorum', text, `meeting:${m.id}`);
    await db.prepare("INSERT INTO mtg_log (org_id, meeting_id, user_id, action, detail, n, created_at) VALUES (?, ?, NULL, 'quorum_alert', ?, 0, ?)").run(m.org_id, m.id, `Quorum menacé : ${q.expected}/${q.need}`, nowISO());
    sent++;
  }
  return sent;
}
/** Signatures en attente depuis plus de 48 h (procès-verbal) : un rappel, une seule fois ; en mode « dans l'ordre », seulement à la personne dont c'est le tour. */
async function remindSignatures(orgId) {
  const cut = new Date(Date.now() - 48 * 3600000).toISOString();
  const rows = await db.prepare(`SELECT s.*, v.number, v.ordered, m.title, m.confidential FROM mtg_signatures s JOIN mtg_pv v ON v.id = s.doc_id AND s.doc_kind = 'pv' JOIN mtg_meetings m ON m.id = s.meeting_id
    WHERE v.status = 'signing' AND s.signed_at IS NULL AND s.reminded_at IS NULL AND v.locked_at <= ?${orgId ? ' AND s.org_id = ?' : ''}`).all(cut, ...(orgId ? [orgId] : []));
  let sent = 0;
  for (const s of rows) {
    if (Number(s.ordered) && await db.prepare('SELECT 1 FROM mtg_signatures WHERE doc_kind = ? AND doc_id = ? AND position < ? AND signed_at IS NULL').get('pv', s.doc_id, s.position)) continue;
    const claimed = await db.prepare('UPDATE mtg_signatures SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL').run(nowISO(), s.id);
    if (!claimed.changes) continue;
    await M.notice(s.org_id, s.user_id, 'meeting_sign', `Rappel : le procès-verbal ${s.number} attend votre signature (${Number(s.confidential) ? 'réunion confidentielle' : `« ${s.title} »`}).`, `meeting:${s.meeting_id}`);
    sent++;
  }
  return sent;
}

async function runForOrg(orgId) { return { meetings: await remindMeetings(orgId), actions: await remindActions(orgId), quorum: await remindQuorum(orgId), signatures: await remindSignatures(orgId) }; }
async function runAll() {
  try { return { meetings: await remindMeetings(null), actions: await remindActions(null), quorum: await remindQuorum(null), signatures: await remindSignatures(null) }; } catch (e) { log.warn('Réunions : rappels :', oneLine(e.message, 160)); return null; }
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  setTimeout(() => { runAll(); }, 60 * 1000).unref();
  timer = setInterval(runAll, EVERY); timer.unref();
}
start();

module.exports = { runForOrg, runAll, remindMeetings, remindActions, remindQuorum, remindSignatures };
