'use strict';
// Réunions (1/4) : réglages de droits, convocation, modification, annulation, réponses des participants, invitations, WhatsApp, agenda .ics, pièces jointes, journal.
// Les autres parties : meetings-minutes (déroulé, compte rendu, actions), meetings-ai (IA), meetings-reports (tableau de bord, recherche, exports, modèles), meetings-jobs (rappels).
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const A = require('./access');
const M = require('./meetings-lib');
const W = require('./w3');
const { HttpError, isEmail, digitsOf } = require('../util');

const router = express.Router({ mergeParams: true });
require('./meetings-jobs'); // démarre les rappels automatiques
const inviteLimit = limits.make(10 * 60 * 1000, 40, "Trop d'envois d'invitations. Réessayez dans quelques minutes.");

// Les routes fixes (réglages, tableau de bord, recherche, exports, modèles, IA) passent avant « /:id ».
router.use('/', require('./meetings-reports').router);
router.use('/', require('./meetings-ai').router);

// ---------- Réglages des réunions : qui convoque, qui valide (le propriétaire décide) ----------
router.get('/settings', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const owner = req.member.role === 'owner';
  res.json({
    types: M.TYPES, roles: M.ASSIGNABLE_ROLES,
    me: { isOwner: owner, convene: M.allowedTypes(req, cfg, 'convene'), validate: M.allowedTypes(req, cfg, 'validate') },
    config: owner ? cfg : undefined,
    distinct: cfg.distinct,
  });
});

router.put('/settings', A.need('owner'), async (req, res) => {
  const b = req.body || {};
  if (typeof b !== 'object') throw new HttpError(400, 'Réglages invalides.');
  for (const side of ['convene', 'validate']) {
    const v = b[side];
    if (v === undefined) continue;
    if (!v || typeof v !== 'object') throw new HttpError(400, 'Réglages invalides.');
    for (const t of Object.keys(v.types || {})) if (!M.TYPES.includes(t)) throw new HttpError(400, 'Type de réunion inconnu dans les réglages.');
    for (const r of [v.default, ...Object.values(v.types || {})]) {
      if (r === undefined || r === null) continue;
      if (typeof r !== 'object' || (r.roles !== undefined && (!Array.isArray(r.roles) || r.roles.some((x) => !M.ASSIGNABLE_ROLES.includes(x)))) || (r.users !== undefined && !Array.isArray(r.users))) throw new HttpError(400, 'Rôle ou personne invalide dans les réglages.');
    }
  }
  const cfg = M.normCfg({ convene: b.convene, validate: b.validate, distinct: b.distinct, tz: b.tz });
  if (b.tz !== undefined && cfg.tz !== Number(b.tz)) throw new HttpError(400, 'Décalage horaire invalide.');
  for (const side of ['convene', 'validate']) {
    for (const r of [cfg[side].default, ...Object.values(cfg[side].types)]) r.users = r.users.filter((u) => u !== req.user.id);
  }
  const ids = [...new Set(['convene', 'validate'].flatMap((s) => [cfg[s].default, ...Object.values(cfg[s].types)].flatMap((r) => r.users)))];
  if (ids.length) {
    const ok = new Set((await db.prepare(`SELECT user_id FROM org_members WHERE org_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)).map((r) => Number(r.user_id)));
    if (ids.some((u) => !ok.has(u))) throw new HttpError(400, "Une personne désignée ne fait pas partie de l'organisation.");
  }
  const before = await M.getConfig(req.org.id);
  await db.prepare('INSERT INTO mtg_settings (org_id, config, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at')
    .run(req.org.id, JSON.stringify(cfg), req.user.id, nowISO());
  await M.mlog(req, null, 'settings', 'Droits de convocation et de validation modifiés');
  await W.audit(req, 'meetings_settings', null, 'update', before, cfg);
  await A.logActivity(req.org.id, req.user.id, 'meetings', 'Réglages des réunions modifiés');
  const warnings = [];
  if (cfg.distinct) {
    const members = await db.prepare('SELECT user_id, role FROM org_members WHERE org_id = ?').all(req.org.id);
    const weak = M.TYPES.filter((t) => {
      const r = M.ruleFor(cfg, 'validate', t);
      return members.filter((m) => m.role === 'owner' || r.users.includes(Number(m.user_id)) || r.roles.includes(m.role)).length < 2;
    });
    if (weak.length) warnings.push({ code: 'distinct_single_validator', types: weak });
  }
  res.json({ config: cfg, warnings });
});

// ---------- Liste ----------
router.get('/', async (req, res) => {
  const q = req.query;
  const cfg = await M.getConfig(req.org.id);
  const vis = M.visibleSql(req, cfg);
  const where = ['m.org_id = ?']; const args = [req.org.id];
  if (q.from) { where.push('m.date >= ?'); args.push(A.date(q.from)); }
  if (q.to) { where.push('m.date <= ?'); args.push(A.date(q.to)); }
  if (q.type) { where.push('m.type = ?'); args.push(M.type(q.type)); }
  if (q.status) { where.push('m.status = ?'); args.push(A.oneOf(q.status, ['planned', 'held', 'cancelled'], undefined, 'Statut inconnu.')); }
  if (q.minutes) { where.push('m.minutes_status = ?'); args.push(A.oneOf(q.minutes, ['none', 'draft', 'submitted', 'validated'], undefined, 'Statut inconnu.')); }
  if (q.mine) { where.push('EXISTS (SELECT 1 FROM mtg_participants mp WHERE mp.meeting_id = m.id AND mp.user_id = ?)'); args.push(req.user.id); }
  const rows = await db.prepare(`SELECT m.*,
      (SELECT response FROM mtg_participants p WHERE p.meeting_id = m.id AND p.user_id = ?) AS my_response,
      (SELECT COUNT(*) FROM mtg_participants p WHERE p.meeting_id = m.id) AS n_parts,
      (SELECT COUNT(*) FROM mtg_actions a LEFT JOIN tasks t ON t.id = a.task_id WHERE a.meeting_id = m.id AND a.status = 'open' AND (t.id IS NULL OR t.status <> 'done')) AS n_open
    FROM mtg_meetings m WHERE ${where.join(' AND ')}${vis.sql} ORDER BY ${q.from || q.to ? 'm.date, m.start_time' : 'm.date DESC, m.start_time DESC'}, m.id LIMIT 500`).all(req.user.id, ...args, ...vis.args);
  const owner = req.member.role === 'owner';
  res.json({
    meetings: rows.map((m) => {
      const peek = owner || Number(m.organizer_id) === req.user.id || Number(m.created_by) === req.user.id || Number(m.secretary_id) === req.user.id || M.allowed(req, cfg, 'convene', m.type) || M.allowed(req, cfg, 'validate', m.type);
      return M.meetingRow(m, { myResponse: m.my_response || null, participants: Number(m.n_parts), openActions: peek || m.minutes_status === 'validated' ? Number(m.n_open) : 0 });
    }),
  });
});

// ---------- Création (convocation) ----------
async function checkProject(req, v) {
  const id = A.idOrNull(v, 'Projet invalide.');
  if (id === null) return null;
  const p = await db.prepare('SELECT id, branch_id FROM projects WHERE id = ? AND org_id = ?').get(id, req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(400, 'Projet inconnu.');
  return id;
}
async function checkDocs(req, ids) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 20) throw new HttpError(400, 'Pièces jointes invalides (20 au maximum).');
  const C = require('./library-core');
  const out = [];
  for (const raw of ids) {
    const id = A.id(raw, 'Document invalide.');
    const d = await db.prepare('SELECT id, name, block_id FROM lib_docs WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(id, req.org.id);
    if (!d) throw new HttpError(400, 'Document introuvable dans la Bibliothèque.');
    try { await C.blockFor(req, d.block_id); } catch { throw new HttpError(400, 'Document introuvable dans la Bibliothèque.'); } // pas de droit sur le bloc : le document « n'existe pas »
    out.push({ id, name: d.name });
  }
  return out;
}

async function insertMeeting(req, f, orgCfgTz) {
  void orgCfgTz;
  const now = nowISO();
  const id = Number((await db.prepare(`INSERT INTO mtg_meetings (org_id, series_id, series_idx, series_freq, title, type, date, start_time, duration_min, place, link, link_kind, objective, confidential, organizer_id, secretary_id, project_id, reminder_min, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, f.seriesId || null, f.idx || 0, f.freq || '', f.title, f.type, f.date, f.time, f.durationMin, f.place, f.link, f.linkKind, f.objective,
    f.confidential ? 1 : 0, f.organizerId, f.secretaryId, f.projectId, f.reminderMin, req.user.id, now, now)).lastInsertRowid);
  return id;
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const cfg = await M.getConfig(req.org.id);
  const type = M.type(b.type);
  if (!M.allowed(req, cfg, 'convene', type)) throw new HttpError(403, "Vous n'avez pas le droit de convoquer une réunion de ce type. Le responsable du compte peut vous l'accorder dans les réglages des réunions.");
  const title = A.text(b.title, 160, { required: true, msg: 'Indiquez le titre de la réunion.' });
  const date = A.date(b.date);
  if (!date) throw new HttpError(400, 'Indiquez la date de la réunion.');
  const lk = M.link(b.link);
  const organizerId = b.organizerId === undefined || b.organizerId === null || b.organizerId === '' ? req.user.id : await A.memberOf(req, b.organizerId);
  const secretaryId = await A.memberOf(req, b.secretaryId);
  const reminderMin = b.reminderMin === undefined || b.reminderMin === null || b.reminderMin === '' ? 0 : Number(b.reminderMin);
  if (!M.REMINDERS.includes(reminderMin)) throw new HttpError(400, 'Rappel invalide.');
  const f = { title, type, date, time: M.time(b.time), durationMin: M.duration(b.durationMin), place: A.text(b.place, 200), link: lk.link, linkKind: lk.kind, objective: A.text(b.objective, 2000),
    confidential: b.confidential === true || b.confidential === 1 || b.confidential === '1', organizerId, secretaryId, projectId: await checkProject(req, b.projectId), reminderMin };
  let rec = null;
  if (b.recurrence && typeof b.recurrence === 'object' && b.recurrence.freq) {
    rec = { freq: A.oneOf(b.recurrence.freq, M.FREQS, undefined, 'Récurrence inconnue.'), count: M.wholeNumber(b.recurrence.count || 2, 2, M.MAX_SERIES, `Une série compte entre 2 et ${M.MAX_SERIES} réunions.`) };
  }
  const parts = (await M.cleanParticipants(req, b.participants)) || [];
  for (const uid of [organizerId, secretaryId]) if (uid && !parts.some((p) => p.userId === uid)) parts.push({ userId: uid, name: '', email: '', phone: '', required: 1 });
  if (parts.length > 60) throw new HttpError(400, 'Pas plus de 60 participants par réunion.');
  const agenda = (await M.cleanAgenda(req, b.agenda)) || [];
  const docs = await checkDocs(req, b.attachments);

  const ids = await db.transaction(async () => {
    const out = [];
    const n = rec ? rec.count : 1;
    let seriesId = null;
    for (let i = 0; i < n; i++) {
      const id = await insertMeeting(req, { ...f, date: rec ? M.occurrence(date, rec.freq, i) : date, seriesId, idx: i, freq: rec ? rec.freq : '' });
      if (rec && i === 0) { seriesId = id; await db.prepare('UPDATE mtg_meetings SET series_id = ? WHERE id = ?').run(id, id); }
      await M.addParticipants(req.org.id, id, parts);
      await db.prepare("UPDATE mtg_participants SET response = 'present', responded_at = ? WHERE meeting_id = ? AND user_id = ?").run(nowISO(), id, organizerId);
      let pos = 0;
      for (const it of agenda) await db.prepare('INSERT INTO mtg_agenda (org_id, meeting_id, position, title, owner_id, owner_name, duration_min) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, pos++, it.title, it.ownerId, it.ownerName, it.durationMin);
      for (const d of docs) await db.prepare('INSERT INTO mtg_attachments (org_id, meeting_id, doc_id, name, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, id, d.id, d.name, req.user.id, nowISO());
      await M.mlog(req, id, 'convened', rec ? `Convoquée (série ${i + 1}/${n})` : 'Réunion convoquée');
      out.push(id);
    }
    return out;
  })();
  const first = await db.prepare('SELECT * FROM mtg_meetings WHERE id = ?').get(ids[0]);
  require('./chat-objects').ensureMeetingThread(req, ids[0], { title, date, time: f.time, place: f.place, agenda: agenda.map((a) => a.title) }); // fil de discussion de la réunion (chat interne)
  await M.activity(req, first, rec ? `Série de ${ids.length} réunions « ${title} » convoquée` : `Réunion « ${title} » convoquée`);
  let invite = null;
  if (b.send === true) invite = await sendInvitations(req, first, cfg, { all: true });
  res.status(201).json({ id: ids[0], ids, invite });
});

// ---------- Une réunion ----------
router.get('/:id', async (req, res) => {
  const { m, cfg, parts, ctx } = await M.load(req, req.params.id);
  const MM = require('./meetings-minutes');
  const content = await MM.contentFor(req, m, parts, ctx);
  const atts = await db.prepare('SELECT id, doc_id, name FROM mtg_attachments WHERE meeting_id = ? ORDER BY id').all(m.id);
  const versions = await db.prepare(`SELECT v.version, v.status, v.reason, v.submitted_at, v.decided_at, us.name AS submitted_by, ud.name AS decided_by, v.submitted_by AS submitted_by_id
    FROM mtg_minutes v LEFT JOIN users us ON us.id = v.submitted_by LEFT JOIN users ud ON ud.id = v.decided_by WHERE v.meeting_id = ? ORDER BY v.version DESC`).all(m.id);
  const lastSub = versions.find((v) => v.status === 'submitted');
  const canSeeContact = ctx.write;
  const open = M.EDITABLE_MINUTES.includes(m.minutes_status) && m.status !== 'cancelled';
  const blockedByDistinct = Boolean(m.minutes_status === 'submitted' && ctx.validate && cfg.distinct && lastSub && Number(lastSub.submitted_by_id) === req.user.id);
  const rights = {
    manage: ctx.manage && open, write: ctx.write && open, submit: ctx.write && open, convene: ctx.convene, validate: ctx.validate, owner: ctx.owner,
    decide: m.minutes_status === 'submitted' && ctx.validate && !blockedByDistinct,
    newVersion: m.minutes_status === 'validated' && (ctx.validate || ctx.owner),
    respond: Boolean(ctx.mine) && m.status !== 'cancelled' && m.minutes_status !== 'validated',
    remove: (ctx.owner || ctx.organizer) && ['planned', 'cancelled'].includes(m.status) && m.minutes_status === 'none',
    cancel: ctx.manage && m.status !== 'cancelled' && m.minutes_status === 'none',
  };
  res.json({
    meeting: M.meetingRow(m, { returnReason: m.return_reason }),
    participants: parts.map((p) => M.partView(p, canSeeContact)),
    mine: ctx.mine ? Number(ctx.mine.id) : null,
    ...content,
    attachments: atts.map((a) => ({ id: Number(a.id), docId: a.doc_id == null ? null : Number(a.doc_id), name: a.name })),
    minutes: { status: m.minutes_status, version: Number(m.minutes_version), returnReason: m.return_reason,
      versions: versions.map((v) => ({ version: Number(v.version), status: v.status, reason: v.reason, submittedAt: v.submitted_at, submittedBy: v.submitted_by, decidedAt: v.decided_at, decidedBy: v.decided_by })) },
    rights, distinctRequired: cfg.distinct, blockedByDistinct,
  });
});

const KEY_FIELDS = ['date', 'start_time', 'place', 'link'];
router.put('/:id', async (req, res) => {
  const { m, cfg, parts, ctx } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit de modifier cette convocation.");
  M.needNotCancelled(m); M.needOpen(m);
  const b = req.body || {};
  const type = b.type === undefined ? m.type : M.type(b.type);
  if (type !== m.type && !M.allowed(req, cfg, 'convene', type)) throw new HttpError(403, "Vous n'avez pas le droit de convoquer une réunion de ce type.");
  const lk = b.link === undefined ? { link: m.link, kind: m.link_kind } : M.link(b.link);
  const n = {
    title: b.title === undefined ? m.title : A.text(b.title, 160, { required: true, msg: 'Le titre ne peut pas être vide.' }),
    type, date: b.date === undefined ? m.date : (A.date(b.date) || (() => { throw new HttpError(400, 'Indiquez la date de la réunion.'); })()),
    start_time: b.time === undefined ? m.start_time : M.time(b.time), duration_min: b.durationMin === undefined ? Number(m.duration_min) : M.duration(b.durationMin),
    place: b.place === undefined ? m.place : A.text(b.place, 200), link: lk.link, link_kind: lk.kind, objective: b.objective === undefined ? m.objective : A.text(b.objective, 2000),
    confidential: b.confidential === undefined ? Number(m.confidential) : (b.confidential === true || b.confidential === 1 ? 1 : 0),
    organizer_id: b.organizerId === undefined ? m.organizer_id : (b.organizerId === null || b.organizerId === '' ? m.organizer_id : await A.memberOf(req, b.organizerId)),
    secretary_id: b.secretaryId === undefined ? m.secretary_id : await A.memberOf(req, b.secretaryId),
    project_id: b.projectId === undefined ? m.project_id : await checkProject(req, b.projectId),
    reminder_min: b.reminderMin === undefined ? Number(m.reminder_min) : Number(b.reminderMin),
  };
  if (!M.REMINDERS.includes(n.reminder_min)) throw new HttpError(400, 'Rappel invalide.');
  if (n.confidential !== Number(m.confidential) && !(ctx.owner || ctx.organizer)) throw new HttpError(403, "Seul l'organisateur ou le propriétaire change la confidentialité.");
  const newParts = await M.cleanParticipants(req, b.participants);
  const agenda = await M.cleanAgenda(req, b.agenda);
  const timeChanged = n.date !== m.date || n.start_time !== m.start_time;
  const keyChanged = KEY_FIELDS.some((k) => String(n[k]) !== String(m[k]));
  await db.transaction(async () => {
    await db.prepare(`UPDATE mtg_meetings SET title = ?, type = ?, date = ?, start_time = ?, duration_min = ?, place = ?, link = ?, link_kind = ?, objective = ?, confidential = ?, organizer_id = ?, secretary_id = ?, project_id = ?, reminder_min = ?, reminded_at = ?, updated_at = ? WHERE id = ?`)
      .run(n.title, n.type, n.date, n.start_time, n.duration_min, n.place, n.link, n.link_kind, n.objective, n.confidential, n.organizer_id, n.secretary_id, n.project_id, n.reminder_min, timeChanged ? null : m.reminded_at, nowISO(), m.id);
    if (newParts) await syncParticipants(req, m, parts, newParts, n);
    if (agenda) await syncAgenda(req, m.id, agenda);
    if (timeChanged) await db.prepare("UPDATE mtg_participants SET response = 'pending', reason = '', responded_at = NULL WHERE meeting_id = ? AND (user_id IS NULL OR user_id <> ?)").run(m.id, n.organizer_id || 0);
    await M.mlog(req, m.id, 'updated', keyChanged ? 'Convocation modifiée (date, lieu ou lien)' : 'Convocation modifiée');
  })();
  if (keyChanged) {
    const when = `${M.dateFr(n.date)} à ${n.start_time.replace(':', 'h')}`;
    for (const p of await M.participantsOf(m.id)) if (p.user_id && Number(p.user_id) !== req.user.id) await M.notice(req.org.id, p.user_id, 'meeting', `Réunion « ${n.title} » modifiée : ${when}. Merci de confirmer votre présence.`, `meeting:${m.id}`);
  }
  await M.activity(req, { ...m, confidential: n.confidential }, `Réunion « ${n.title} » modifiée`);
  let invite = null;
  if (keyChanged && b.notify === true) invite = await sendInvitations(req, { ...m, ...n }, cfg, { all: true, update: true });
  res.json({ ok: true, invite });
});

async function syncParticipants(req, m, current, wanted, n) {
  const keyOf = (p) => (p.user_id != null ? `u${p.user_id}` : `g${p.email || digitsOf(p.phone)}`);
  const wantedKeys = new Map(wanted.map((p) => [p.userId != null ? `u${p.userId}` : `g${p.email || digitsOf(p.phone)}`, p]));
  for (const c of current) {
    const w = wantedKeys.get(keyOf(c));
    if (!w) {
      if (c.user_id != null && (Number(c.user_id) === Number(n.organizer_id) || Number(c.user_id) === Number(n.secretary_id))) continue; // l'organisateur reste convoqué
      await db.prepare('DELETE FROM mtg_participants WHERE id = ?').run(c.id);
    } else await db.prepare('UPDATE mtg_participants SET required = ? WHERE id = ?').run(w.required, c.id);
  }
  const have = new Set(current.map(keyOf));
  const add = [...wantedKeys.entries()].filter(([k]) => !have.has(k)).map(([, p]) => p);
  await M.addParticipants(req.org.id, m.id, add);
}
/** Remplace l'ordre du jour en conservant les points existants (identifiants) pour ne pas perdre leurs notes. */
async function syncAgenda(req, meetingId, items) {
  const cur = await db.prepare('SELECT id FROM mtg_agenda WHERE meeting_id = ?').all(meetingId);
  const curIds = new Set(cur.map((r) => Number(r.id)));
  const keep = new Set(items.filter((i) => i.id && curIds.has(i.id)).map((i) => i.id));
  for (const id of curIds) if (!keep.has(id)) await db.prepare('DELETE FROM mtg_agenda WHERE id = ?').run(id);
  let pos = 0;
  for (const it of items) {
    if (it.id && curIds.has(it.id)) await db.prepare('UPDATE mtg_agenda SET position = ?, title = ?, owner_id = ?, owner_name = ?, duration_min = ? WHERE id = ? AND meeting_id = ?').run(pos++, it.title, it.ownerId, it.ownerName, it.durationMin, it.id, meetingId);
    else await db.prepare('INSERT INTO mtg_agenda (org_id, meeting_id, position, title, owner_id, owner_name, duration_min) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, meetingId, pos++, it.title, it.ownerId, it.ownerName, it.durationMin);
  }
}

router.put('/:id/agenda', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit de modifier l'ordre du jour.");
  M.needNotCancelled(m); M.needOpen(m);
  const agenda = await M.cleanAgenda(req, (req.body || {}).items);
  if (!agenda) throw new HttpError(400, "Indiquez les points de l'ordre du jour.");
  await db.transaction(async () => { await syncAgenda(req, m.id, agenda); await M.mlog(req, m.id, 'agenda', `Ordre du jour modifié (${agenda.length} points)`); })();
  res.json({ ok: true });
});

router.post('/:id/cancel', async (req, res) => {
  const { m, cfg, ctx } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit d'annuler cette réunion.");
  if (m.status === 'cancelled') throw new HttpError(409, 'Cette réunion est déjà annulée.');
  if (m.minutes_status !== 'none') throw new HttpError(409, "Cette réunion a déjà un compte rendu : elle ne peut plus être annulée.");
  const b = req.body || {};
  const reason = A.text(b.reason, 300, { required: true, msg: "Indiquez le motif de l'annulation." });
  let targets = [m];
  if (b.series === true && m.series_id) targets = await db.prepare("SELECT * FROM mtg_meetings WHERE series_id = ? AND org_id = ? AND date >= ? AND status = 'planned' AND minutes_status = 'none'").all(m.series_id, req.org.id, m.date);
  await db.transaction(async () => {
    for (const t of targets) {
      await db.prepare("UPDATE mtg_meetings SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(reason, nowISO(), t.id);
      await M.mlog(req, t.id, 'cancelled', 'Réunion annulée');
    }
  })();
  for (const t of targets) for (const p of await M.participantsOf(t.id)) if (p.user_id && Number(p.user_id) !== req.user.id) await M.notice(req.org.id, p.user_id, 'meeting', `Réunion « ${t.title} » du ${M.dateFr(t.date)} annulée.`, `meeting:${t.id}`);
  await M.activity(req, m, targets.length > 1 ? `${targets.length} réunions « ${m.title} » annulées` : `Réunion « ${m.title} » annulée`);
  let invite = null;
  if (b.notify === true) invite = await sendInvitations(req, { ...m, status: 'cancelled', cancel_reason: reason }, cfg, { all: true, cancelled: true });
  res.json({ ok: true, cancelled: targets.length, invite });
});

router.post('/:id/hold', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m);
  if (m.status !== 'held') {
    await db.prepare("UPDATE mtg_meetings SET status = 'held', updated_at = ? WHERE id = ?").run(nowISO(), m.id);
    await M.mlog(req, m.id, 'held', 'Réunion tenue');
  }
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!(ctx.owner || ctx.organizer)) throw new HttpError(403, "Seul l'organisateur ou le propriétaire peut supprimer une réunion.");
  if (!['planned', 'cancelled'].includes(m.status) || m.minutes_status !== 'none') throw new HttpError(409, 'Une réunion tenue ou avec un compte rendu ne se supprime pas : elle reste dans l\'historique.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM mtg_meetings WHERE id = ?').run(m.id);
    await M.mlog(req, m.id, 'deleted', 'Réunion supprimée');
  })();
  await M.activity(req, m, `Réunion « ${m.title} » supprimée`);
  res.json({ ok: true });
});

// ---------- Réponses des participants ----------
router.post('/:id/respond', async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  M.needNotCancelled(m);
  if (m.minutes_status === 'validated') throw new HttpError(409, 'Le compte rendu est validé : les réponses sont closes.');
  const b = req.body || {};
  const response = A.oneOf(b.response, ['present', 'absent', 'excused'], undefined, 'Réponse invalide : présent, absent ou excusé.');
  const reason = A.text(b.reason, 300);
  if (response !== 'present' && !reason) throw new HttpError(400, 'Indiquez le motif de votre absence.');
  let target = ctx.mine;
  if (b.participantId !== undefined && b.participantId !== null && b.participantId !== '') {
    const p = parts.find((x) => Number(x.id) === A.id(b.participantId));
    if (!p) throw new HttpError(404, 'Participant introuvable.');
    if (Number(p.user_id) !== req.user.id) M.needWrite(ctx); // répondre à la place d'un invité : réservé à l'équipe qui gère la réunion
    target = p;
  }
  if (!target) throw new HttpError(409, "Vous n'êtes pas convoqué(e) à cette réunion.");
  await db.prepare('UPDATE mtg_participants SET response = ?, reason = ?, responded_at = ? WHERE id = ?').run(response, response === 'present' ? '' : reason, nowISO(), target.id);
  await M.mlog(req, m.id, 'response', `Réponse enregistrée : ${response}`);
  if (response !== 'present' && Number(target.user_id) === req.user.id && m.organizer_id && Number(m.organizer_id) !== req.user.id) {
    await M.notice(req.org.id, m.organizer_id, 'meeting', `${req.user.name} ne pourra pas assister à « ${m.title} » (${response === 'excused' ? 'excusé(e)' : 'absent(e)'}).`, `meeting:${m.id}`);
  }
  res.json({ ok: true });
});

router.post('/:id/participants', async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit de modifier les participants.");
  M.needNotCancelled(m); M.needOpen(m);
  const list = await M.cleanParticipants(req, (req.body || {}).participants);
  if (!list || !list.length) throw new HttpError(400, 'Indiquez au moins un participant.');
  const have = new Set(parts.map((p) => (p.user_id != null ? `u${p.user_id}` : `g${p.email || digitsOf(p.phone)}`)));
  const add = list.filter((p) => !have.has(p.userId != null ? `u${p.userId}` : `g${p.email || digitsOf(p.phone)}`));
  if (parts.length + add.length > 60) throw new HttpError(400, 'Pas plus de 60 participants par réunion.');
  await M.addParticipants(req.org.id, m.id, add);
  await M.mlog(req, m.id, 'participants', `${add.length} participant(s) ajouté(s)`);
  res.status(201).json({ added: add.length });
});

router.put('/:id/participants/:pid', async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m);
  const p = parts.find((x) => Number(x.id) === A.id(req.params.pid));
  if (!p) throw new HttpError(404, 'Participant introuvable.');
  const b = req.body || {};
  if (b.attended !== undefined || b.required !== undefined) M.needOpen(m);
  const attended = b.attended === undefined ? p.attended : A.oneOf(b.attended, M.ATTENDED, undefined, 'Présence invalide.');
  const required = b.required === undefined ? p.required : (b.required ? 1 : 0);
  await db.prepare('UPDATE mtg_participants SET attended = ?, required = ? WHERE id = ?').run(attended, required, p.id);
  res.json({ ok: true });
});

router.delete('/:id/participants/:pid', async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit de modifier les participants.");
  M.needOpen(m);
  const p = parts.find((x) => Number(x.id) === A.id(req.params.pid));
  if (!p) throw new HttpError(404, 'Participant introuvable.');
  if (p.user_id != null && Number(p.user_id) === Number(m.organizer_id)) throw new HttpError(409, "L'organisateur reste convoqué.");
  await db.prepare('DELETE FROM mtg_participants WHERE id = ?').run(p.id);
  await M.mlog(req, m.id, 'participants', 'Participant retiré');
  res.json({ ok: true });
});

// ---------- Invitations : notices dans l'application + e-mail (avec agenda .ics) ----------
async function memberContacts(ids) {
  if (!ids.length) return new Map();
  const rows = await db.prepare(`SELECT id, name, contact FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Map(rows.map((r) => [Number(r.id), r]));
}
function inviteText(req, m, agenda, who, { update = false, cancelled = false } = {}) {
  const lines = [`Bonjour ${who || ''},`.replace(' ,', ','), ''];
  if (cancelled) lines.push(`La réunion « ${m.title} » du ${M.dateFr(m.date)} est annulée.`, m.cancel_reason ? `Motif : ${m.cancel_reason}` : '');
  else {
    lines.push(`${req.user.name} ${update ? 'vous informe d’un changement pour' : 'vous convoque à'} la réunion « ${m.title} » (${M.TYPE_FR[m.type] || ''}).`, '',
      `Quand : ${M.whenLine(m)}`, `Où : ${M.whereLine(m)}`);
    if (m.objective) lines.push('', `Objet : ${m.objective}`);
    if (agenda.length) lines.push('', 'Ordre du jour :', ...agenda.map((a, i) => `${i + 1}. ${a.title}${a.duration_min ? ` (${a.duration_min} min)` : ''}`));
    lines.push('', 'Merci de confirmer votre présence en répondant à ce message (ou dans Brij-IA, rubrique Réunions).');
  }
  lines.push('', `— ${req.org.name}`);
  return lines.join('\n');
}

async function sendInvitations(req, m, cfg, { all = false, update = false, cancelled = false } = {}) {
  const parts = await M.participantsOf(m.id);
  const agenda = await db.prepare('SELECT title, duration_min FROM mtg_agenda WHERE meeting_id = ? ORDER BY position').all(m.id);
  const targets = parts.filter((p) => (all || !p.invited_at) && !(Number(p.user_id) === req.user.id));
  const contacts = await memberContacts(targets.filter((p) => p.user_id).map((p) => Number(p.user_id)));
  let series = [m];
  if (m.series_id && !cancelled) series = await db.prepare("SELECT * FROM mtg_meetings WHERE series_id = ? AND org_id = ? AND status <> 'cancelled' AND date >= ? ORDER BY date").all(m.series_id, req.org.id, m.date);
  const ics = M.buildIcs(req.org, series, cfg.tz, { cancelled });
  const recipients = []; let notices = 0; let whatsappOnly = 0; let noContact = 0;
  for (const p of targets) {
    let email = ''; let name = p.name;
    if (p.user_id) {
      const u = contacts.get(Number(p.user_id));
      name = u ? u.name : '';
      if (!cancelled) { await M.notice(req.org.id, p.user_id, 'meeting', `${update ? 'Réunion modifiée' : 'Convocation'} : « ${m.title} », ${M.dateFr(m.date)} à ${m.start_time.replace(':', 'h')}. Merci de répondre.`, `meeting:${m.id}`); notices++; }
      if (u && isEmail(u.contact)) email = u.contact;
    } else email = p.email;
    if (email) recipients.push({ email, name, id: p.id });
    else if (!p.user_id) { if (p.phone) whatsappOnly++; else noContact++; }
  }
  const subject = cancelled ? `Réunion annulée : ${m.title}` : `${update ? 'Réunion modifiée' : 'Convocation'} : ${m.title} — ${M.dateFr(m.date)}`;
  const mailRes = await M.sendMany(req, m.id, recipients, (r) => ({
    subject, text: inviteText(req, m, agenda, r.name, { update, cancelled }),
    attachments: [{ filename: 'reunion.ics', content: ics, contentType: `text/calendar; charset=utf-8; method=${cancelled ? 'CANCEL' : 'PUBLISH'}` }],
  }), cancelled ? 'cancel' : update ? 'update' : 'invite');
  if (!cancelled) {
    const ok = targets.filter((t) => t.user_id || mailRes.sent > 0).map((t) => t.id); // un invité n'est « invité » que si un e-mail est vraiment parti
    if (ok.length) await db.prepare(`UPDATE mtg_participants SET invited_at = ? WHERE meeting_id = ? AND id IN (${ok.map(() => '?').join(',')})`).run(nowISO(), m.id, ...ok);
  }
  await M.mlog(req, m.id, cancelled ? 'cancel_sent' : update ? 'update_sent' : 'invited', `Invitations : ${notices} notice(s), ${mailRes.sent} e-mail(s)`);
  return { notices, email: mailRes, whatsappOnly, noContact, recipients: targets.length };
}

router.post('/:id/invite', inviteLimit, async (req, res) => {
  const { m, cfg, ctx } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit d'envoyer les invitations.");
  M.needNotCancelled(m);
  const recent = Number((await db.prepare("SELECT COUNT(*) c FROM mtg_log WHERE meeting_id = ? AND action = 'invited' AND created_at >= ?").get(m.id, new Date(Date.now() - 86400000).toISOString())).c);
  if (recent >= 6) throw new HttpError(429, "Trop d'envois pour cette réunion aujourd'hui. Réessayez demain.");
  const all = (req.body || {}).all === true;
  const out = await sendInvitations(req, m, cfg, { all });
  if (!out.recipients) throw new HttpError(409, all ? 'Aucun participant à inviter.' : 'Tout le monde a déjà été invité. Utilisez « renvoyer à tous » pour relancer.');
  res.json(out);
});

// ---------- WhatsApp : message prêt à copier + liens wa.me (aucun envoi automatique : le canal est par code QR) ----------
function waNumber(s) {
  const d = digitsOf(s);
  if (d.length === 9 && d[0] === '6') return `237${d}`; // numéro camerounais sans indicatif
  return d.length >= 8 && d.length <= 15 ? d : '';
}
router.get('/:id/whatsapp', async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit de préparer les messages.");
  const agenda = await db.prepare('SELECT title, duration_min FROM mtg_agenda WHERE meeting_id = ? ORDER BY position').all(m.id);
  const text = [`*Convocation : ${m.title}*`, `📅 ${M.whenLine(m)}`, `📍 ${M.whereLine(m)}`, m.objective ? `Objet : ${m.objective}` : '',
    agenda.length ? `Ordre du jour :\n${agenda.map((a, i) => `${i + 1}. ${a.title}`).join('\n')}` : '', 'Merci de confirmer votre présence.', `— ${req.org.name}`].filter(Boolean).join('\n');
  const contacts = await memberContacts(parts.filter((p) => p.user_id).map((p) => Number(p.user_id)));
  const targets = [];
  for (const p of parts) {
    const raw = p.user_id ? (contacts.get(Number(p.user_id)) || {}).contact : p.phone;
    const num = raw && !isEmail(raw) ? waNumber(raw) : '';
    if (num) targets.push({ participantId: Number(p.id), name: p.uname || p.name, url: `https://wa.me/${num}?text=${encodeURIComponent(text)}` });
  }
  await M.mlog(req, m.id, 'whatsapp', `Message WhatsApp préparé (${targets.length} lien(s))`);
  res.json({ text, targets });
});

router.get('/:id/ics', async (req, res) => {
  const { m, cfg } = await M.load(req, req.params.id);
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="reunion.ics"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(M.buildIcs(req.org, [m], cfg.tz));
});

// ---------- Pièces jointes (depuis la Bibliothèque) ----------
router.post('/:id/attachments', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit d'ajouter une pièce jointe.");
  if (m.minutes_status === 'validated') throw new HttpError(409, M.lockedMsg(m));
  const [d] = await checkDocs(req, [(req.body || {}).docId]);
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM mtg_attachments WHERE meeting_id = ?').get(m.id)).c);
  if (n >= 20) throw new HttpError(400, '20 pièces jointes au maximum.');
  const id = (await db.prepare('INSERT INTO mtg_attachments (org_id, meeting_id, doc_id, name, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, m.id, d.id, d.name, req.user.id, nowISO())).lastInsertRowid;
  await M.mlog(req, m.id, 'attachment', 'Pièce jointe ajoutée');
  res.status(201).json({ id: Number(id) });
});
router.delete('/:id/attachments/:aid', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit de retirer une pièce jointe.");
  if (m.minutes_status === 'validated') throw new HttpError(409, M.lockedMsg(m));
  const r = await db.prepare('DELETE FROM mtg_attachments WHERE id = ? AND meeting_id = ?').run(A.id(req.params.aid), m.id);
  if (!r.changes) throw new HttpError(404, 'Pièce jointe introuvable.');
  await M.mlog(req, m.id, 'attachment', 'Pièce jointe retirée');
  res.json({ ok: true });
});

// ---------- Journal de la réunion ----------
router.get('/:id/log', async (req, res) => {
  const { m } = await M.load(req, req.params.id);
  const rows = await db.prepare('SELECT l.id, l.action, l.detail, l.created_at AS at, u.name AS who FROM mtg_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? AND l.meeting_id = ? AND l.action <> \'mail\' ORDER BY l.id DESC LIMIT 200').all(req.org.id, m.id);
  res.json({ log: rows.map((r) => ({ id: Number(r.id), action: r.action, detail: r.detail, at: r.at, who: r.who || '' })) });
});

router.use('/', require('./meetings-minutes').router);

module.exports = { router, sendInvitations };
