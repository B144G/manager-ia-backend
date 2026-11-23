'use strict';
// Réunions avancées (1/2) : types personnalisés, quorum en direct, déroulé (début, fin, présences, retards), réunion sans quorum (report automatique),
// conflits d'agenda, propositions de points, archivage, résolutions et vote électronique.
// RÈGLE CENTRALE INCHANGÉE : qui convoque et qui valide reste décidé par le propriétaire (meetings-lib.js) ; le compte rendu validé reste verrouillé.
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const A = require('./access');
const M = require('./meetings-lib');
const X = require('./meetings-adv-lib');
const W = require('./w3');
const { HttpError, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const voteLimit = limits.make(10 * 60 * 1000, 120, 'Trop de votes enregistrés. Réessayez dans quelques minutes.');
const writeLimit = limits.make(10 * 60 * 1000, 200, 'Trop de demandes. Réessayez dans quelques minutes.');
const label = (m) => (Number(m.confidential) ? 'réunion confidentielle' : `« ${m.title} »`);

// ---------- Types de réunions personnalisés (catégorie de droits + modèle de réglages) ----------
const typeView = (t) => ({ id: Number(t.id), name: t.name, base: t.base, color: t.color, durationMin: Number(t.duration_min), confidential: Boolean(Number(t.confidential)), reminderMin: Number(t.reminder_min),
  quorum: t.quorum ? (() => { try { return JSON.parse(t.quorum); } catch { return null; } })() : null, templateId: t.template_id == null ? null : Number(t.template_id), active: Boolean(Number(t.active)) });
router.get('/types', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const rows = await db.prepare('SELECT * FROM mtg_types WHERE org_id = ? ORDER BY name').all(req.org.id);
  const used = new Map((await db.prepare('SELECT type_id, COUNT(*) c FROM mtg_meetings WHERE org_id = ? AND type_id IS NOT NULL GROUP BY type_id').all(req.org.id)).map((r) => [Number(r.type_id), Number(r.c)]));
  res.json({ builtin: M.TYPES.map((id) => ({ id, quorum: cfg.quorum[id] || null })), custom: rows.map((t) => ({ ...typeView(t), meetings: used.get(Number(t.id)) || 0 })), urgency: X.URGENCY, noticeH: cfg.noticeH });
});
async function cleanType(req, b, cur) {
  const name = b.name === undefined && cur ? cur.name : A.text(b.name, 80, { required: true, msg: 'Indiquez le nom du type de réunion.' });
  const base = b.base === undefined && cur ? cur.base : M.type(b.base);
  const color = b.color === undefined && cur ? cur.color : (/^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '');
  const durationMin = b.durationMin === undefined && cur ? Number(cur.duration_min) : M.duration(b.durationMin);
  const reminderMin = b.reminderMin === undefined && cur ? Number(cur.reminder_min) : Number(b.reminderMin || 0);
  if (!M.REMINDERS.includes(reminderMin)) throw new HttpError(400, 'Rappel invalide.');
  const q = b.quorum === undefined && cur ? (cur.quorum || '') : (b.quorum ? JSON.stringify(M.normQuorum(b.quorum) || '') : '');
  const templateId = b.templateId === undefined && cur ? cur.template_id : A.idOrNull(b.templateId, 'Modèle invalide.');
  if (templateId && !await db.prepare('SELECT 1 FROM mtg_templates WHERE id = ? AND org_id = ?').get(templateId, req.org.id)) throw new HttpError(400, 'Modèle introuvable.');
  return { name, base, color, durationMin, confidential: b.confidential === undefined && cur ? Number(cur.confidential) : (b.confidential ? 1 : 0), reminderMin, quorum: q === '""' ? '' : q, templateId: templateId || null,
    active: b.active === undefined && cur ? Number(cur.active) : (b.active === false ? 0 : 1) };
}
router.post('/types', A.need('admin'), async (req, res) => {
  const n = await cleanType(req, req.body || {}, null);
  if (Number((await db.prepare('SELECT COUNT(*) c FROM mtg_types WHERE org_id = ?').get(req.org.id)).c) >= 40) throw new HttpError(400, '40 types personnalisés au maximum.');
  if (await db.prepare('SELECT 1 FROM mtg_types WHERE org_id = ? AND lower(name) = lower(?)').get(req.org.id, n.name)) throw new HttpError(409, 'Un type porte déjà ce nom.');
  const id = Number((await db.prepare('INSERT INTO mtg_types (org_id, name, base, color, duration_min, confidential, reminder_min, quorum, template_id, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, n.name, n.base, n.color, n.durationMin, n.confidential, n.reminderMin, n.quorum, n.templateId, n.active, req.user.id, nowISO())).lastInsertRowid);
  await M.mlog(req, null, 'type', 'Type de réunion créé');
  res.status(201).json({ id });
});
router.put('/types/:id', A.need('admin'), async (req, res) => {
  const t = await db.prepare('SELECT * FROM mtg_types WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t) throw new HttpError(404, 'Type introuvable.');
  const n = await cleanType(req, req.body || {}, t);
  if (n.name.toLowerCase() !== String(t.name).toLowerCase() && await db.prepare('SELECT 1 FROM mtg_types WHERE org_id = ? AND lower(name) = lower(?) AND id <> ?').get(req.org.id, n.name, t.id)) throw new HttpError(409, 'Un type porte déjà ce nom.');
  await db.prepare('UPDATE mtg_types SET name = ?, base = ?, color = ?, duration_min = ?, confidential = ?, reminder_min = ?, quorum = ?, template_id = ?, active = ? WHERE id = ?').run(n.name, n.base, n.color, n.durationMin, n.confidential, n.reminderMin, n.quorum, n.templateId, n.active, t.id);
  await M.mlog(req, null, 'type', 'Type de réunion modifié');
  res.json({ ok: true });
});
router.delete('/types/:id', A.need('admin'), async (req, res) => {
  const t = await db.prepare('SELECT * FROM mtg_types WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t) throw new HttpError(404, 'Type introuvable.');
  const used = Number((await db.prepare('SELECT COUNT(*) c FROM mtg_meetings WHERE type_id = ?').get(t.id)).c);
  if (used) { await db.prepare('UPDATE mtg_types SET active = 0 WHERE id = ?').run(t.id); await M.mlog(req, null, 'type', 'Type de réunion désactivé'); return res.json({ ok: true, deactivated: true }); }
  await db.prepare('DELETE FROM mtg_types WHERE id = ?').run(t.id);
  await M.mlog(req, null, 'type', 'Type de réunion supprimé');
  res.json({ ok: true, deactivated: false });
});

// ---------- Sites (antennes) et services de l'organisation, pour les listes de choix ----------
router.get('/scope-options', async (req, res) => {
  const branches = await db.prepare('SELECT id, name FROM branches WHERE org_id = ? ORDER BY name').all(req.org.id);
  const departments = await db.prepare('SELECT id, name FROM rh_departments WHERE org_id = ? ORDER BY name').all(req.org.id);
  res.json({ branches: branches.map((b) => ({ id: Number(b.id), name: b.name })), departments: departments.map((d) => ({ id: Number(d.id), name: d.name })) });
});

// ---------- Conflits d'agenda ----------
async function userIdsFrom(req, list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) { if (p && p.userId) out.push(await A.memberOf(req, p.userId)); }
  return [...new Set(out)];
}
router.post('/conflicts', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  if (!M.allowedTypes(req, cfg, 'convene').length) throw new HttpError(403, "Vous n'avez pas le droit de convoquer des réunions.");
  const b = req.body || {};
  const date = A.date(b.date);
  if (!date) throw new HttpError(400, 'Indiquez la date de la réunion.');
  const ids = await userIdsFrom(req, b.participants);
  for (const k of ['organizerId', 'secretaryId']) { const u = await A.memberOf(req, b[k]); if (u && !ids.includes(u)) ids.push(u); }
  const c = await X.conflictsFor(req, cfg, { date, time: M.time(b.time), durationMin: M.duration(b.durationMin), place: A.text(b.place, 200), userIds: ids, excludeId: b.excludeId ? A.id(b.excludeId) : null });
  const urgency = A.oneOf(b.urgency, X.URGENCY, 'normal', "Niveau d'urgence inconnu.");
  res.json({ ...c, notice: X.noticeCheck(cfg, urgency, date, M.time(b.time), cfg.tz) });
});
router.get('/:id/conflicts', async (req, res) => {
  const { m, cfg, parts, ctx } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit de vérifier l'agenda de cette réunion.");
  const ids = parts.filter((p) => p.user_id).map((p) => Number(p.user_id));
  res.json(await X.conflictsFor(req, cfg, { date: m.date, time: m.start_time, durationMin: Number(m.duration_min), place: m.place, userIds: ids, excludeId: m.id }));
});

// ---------- Quorum en direct et déroulé ----------
router.get('/:id/quorum', async (req, res) => {
  const { m, cfg, parts } = await M.load(req, req.params.id);
  res.json({ quorum: await X.quorumState(req, m, parts, cfg), status: m.status, reason: m.no_quorum_reason, parentId: m.parent_id == null ? null : Number(m.parent_id) });
});
router.put('/:id/presence', writeLimit, async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  const items = (req.body || {}).items;
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new HttpError(400, 'Indiquez les présences à enregistrer.');
  await db.transaction(async () => {
    for (const it of items) {
      const p = parts.find((x) => Number(x.id) === A.id(it && it.id));
      if (!p) throw new HttpError(404, 'Participant introuvable.');
      const attended = it.attended === undefined ? p.attended : A.oneOf(it.attended, M.ATTENDED, undefined, 'Présence invalide.');
      const late = it.lateMin === undefined ? Number(p.late_min) : M.wholeNumber(it.lateMin, 0, 600, 'Retard invalide (0 à 600 minutes).');
      const w = it.voteWeight === undefined ? p.vote_weight : (it.voteWeight === null ? null : Number(it.voteWeight));
      if (w !== null && w !== undefined && (!Number.isFinite(w) || w < 0 || w > 100)) throw new HttpError(400, 'Poids de vote invalide (0 à 100).');
      await db.prepare('UPDATE mtg_participants SET attended = ?, late_min = ?, vote_weight = ? WHERE id = ?').run(attended, attended === 'yes' ? late : 0, w === undefined ? null : w, p.id);
    }
    await M.mlog(req, m.id, 'presence', 'Présences enregistrées');
  })();
  const fresh = await M.participantsOf(m.id);
  res.json({ ok: true, quorum: await X.quorumState(req, m, fresh, cfg) });
});
router.post('/:id/start', async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m);
  if (m.status === 'no_quorum') throw new HttpError(409, 'Cette réunion est déclarée sans quorum.');
  if (m.started_at) throw new HttpError(409, 'La réunion est déjà ouverte.');
  await db.prepare("UPDATE mtg_meetings SET started_at = ?, status = 'held', updated_at = ? WHERE id = ?").run(nowISO(), nowISO(), m.id);
  await M.mlog(req, m.id, 'started', 'Séance ouverte');
  res.json({ ok: true, quorum: await X.quorumState(req, m, parts, cfg) });
});
router.post('/:id/end', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m);
  if (!m.started_at) throw new HttpError(409, "La séance n'a pas été ouverte.");
  if (m.ended_at) throw new HttpError(409, 'La séance est déjà close.');
  const open = Number((await db.prepare("SELECT COUNT(*) c FROM mtg_resolutions WHERE meeting_id = ? AND vote_state = 'open'").get(m.id)).c);
  if (open) throw new HttpError(409, 'Un vote est encore ouvert : clôturez-le avant de lever la séance.');
  await db.prepare('UPDATE mtg_meetings SET ended_at = ?, updated_at = ? WHERE id = ?').run(nowISO(), nowISO(), m.id);
  await M.mlog(req, m.id, 'ended', 'Séance levée');
  res.json({ ok: true });
});
router.put('/:id/agenda/:aid', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  const g = await db.prepare('SELECT * FROM mtg_agenda WHERE id = ? AND meeting_id = ?').get(A.id(req.params.aid), m.id);
  if (!g) throw new HttpError(404, 'Point introuvable.');
  const b = req.body || {};
  const kind = b.kind === undefined ? g.kind : A.oneOf(b.kind, X.AGENDA_KINDS, undefined, 'Nature du point inconnue.');
  const spent = b.spentMin === undefined ? Number(g.spent_min) : M.wholeNumber(b.spentMin, 0, 1440, 'Durée réelle invalide.');
  await db.prepare('UPDATE mtg_agenda SET kind = ?, spent_min = ? WHERE id = ?').run(kind, spent, g.id);
  res.json({ ok: true });
});

/** Réunion sans quorum : statut explicite, résolutions en attente « sans quorum » (aucune décision valable), report automatique si la règle l'autorise. */
router.post('/:id/no-quorum', async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  if (m.status === 'no_quorum') throw new HttpError(409, 'Cette réunion est déjà déclarée sans quorum.');
  const q = await X.quorumState(req, m, parts, cfg);
  if (!q.required) throw new HttpError(409, "Aucune règle de quorum n'est définie pour ce type de réunion.");
  if (q.ok) throw new HttpError(409, 'Le quorum est atteint : la réunion peut valablement délibérer.');
  const b = req.body || {};
  const reason = A.text(b.reason, 300) || `Quorum non atteint : ${q.present} présent(s) sur ${q.need} requis.`;
  let child = null;
  await db.transaction(async () => {
    await db.prepare("UPDATE mtg_meetings SET status = 'no_quorum', no_quorum_reason = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?").run(reason, nowISO(), nowISO(), m.id);
    await db.prepare("UPDATE mtg_resolutions SET status = 'no_quorum', vote_state = 'closed', closed_by = ?, closed_at = ?, result = ? WHERE meeting_id = ? AND status = 'pending'")
      .run(req.user.id, nowISO(), JSON.stringify({ void: true, reason: 'quorum', outcome: 'no_quorum' }), m.id);
    await M.mlog(req, m.id, 'no_quorum', oneLine(`Séance déclarée sans quorum : ${reason}`, 280));
    if (q.reducedAllowed && b.reconvene !== false && !m.parent_id) child = await reconvene(req, m, parts, q, b);
  })();
  if (child) for (const p of await M.participantsOf(child.id)) if (p.user_id && Number(p.user_id) !== req.user.id) await M.notice(req.org.id, p.user_id, 'meeting', `Nouvelle convocation à quorum réduit : ${label(m)} le ${M.dateFr(child.date)} à ${child.time.replace(':', 'h')} (la précédente réunion n'a pas atteint le quorum).`, `meeting:${child.id}`);
  await M.activity(req, m, `Réunion « ${m.title} » sans quorum`);
  res.json({ ok: true, status: 'no_quorum', quorum: q, reconvened: child });
});
async function reconvene(req, m, parts, q, b) {
  const delay = q.reduced && q.reduced.delayDays ? q.reduced.delayDays : 7;
  const date = b.date ? A.date(b.date) : M.addDays(m.date, delay);
  const time = b.time ? M.time(b.time) : m.start_time;
  const now = nowISO();
  const id = Number((await db.prepare(`INSERT INTO mtg_meetings (org_id, series_idx, series_freq, title, type, date, start_time, duration_min, place, link, link_kind, objective, confidential, organizer_id, secretary_id, chair_id, project_id, reminder_min, branch_id, department_id, type_id, urgency, quorum_mode, parent_id, created_by, created_at, updated_at)
    VALUES (?, 0, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reduced', ?, ?, ?, ?)`)
    .run(req.org.id, `${m.title} (2ᵉ convocation)`, m.type, date, time, m.duration_min, m.place, m.link, m.link_kind, m.objective, m.confidential, m.organizer_id, m.secretary_id, m.chair_id, m.project_id, m.reminder_min, m.branch_id, m.department_id, m.type_id, m.urgency, m.id, req.user.id, now, now)).lastInsertRowid);
  for (const p of parts) await db.prepare('INSERT INTO mtg_participants (org_id, meeting_id, user_id, name, email, phone, required, vote_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, p.user_id, p.name, p.email, p.phone, p.required, p.vote_weight, now);
  const ag = await db.prepare('SELECT * FROM mtg_agenda WHERE meeting_id = ? AND accepted = 1 ORDER BY position, id').all(m.id);
  let pos = 0;
  for (const g of ag) await db.prepare('INSERT INTO mtg_agenda (org_id, meeting_id, position, title, owner_id, owner_name, duration_min, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, pos++, g.title, g.owner_id, g.owner_name, g.duration_min, g.kind);
  await db.prepare("UPDATE mtg_participants SET response = 'present', responded_at = ? WHERE meeting_id = ? AND user_id = ?").run(now, id, m.organizer_id || 0);
  for (const s of await db.prepare('SELECT kind, ref_id FROM mtg_scope WHERE meeting_id = ?').all(m.id)) await db.prepare('INSERT INTO mtg_scope (org_id, meeting_id, kind, ref_id) VALUES (?, ?, ?, ?)').run(req.org.id, id, s.kind, s.ref_id);
  for (const [uid, role] of [[m.organizer_id, 'organizer'], [m.secretary_id, 'secretary'], [m.chair_id, 'chair']]) if (uid) await X.resp(req, { id, confidential: m.confidential }, { kind: 'role', refId: id, userId: uid, role, subject: `${m.title} (2ᵉ convocation)` });
  await M.mlog(req, id, 'convened', `Nouvelle convocation à quorum réduit (suite à la réunion n° ${m.id})`);
  return { id, date, time };
}

// ---------- Propositions de points à l'ordre du jour par les participants ----------
router.post('/:id/agenda/propose', writeLimit, async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needNotCancelled(m); M.needOpen(m);
  if (!ctx.mine && !ctx.manage) throw new HttpError(403, 'Seuls les participants peuvent proposer un point.');
  if (m.status !== 'planned') throw new HttpError(409, "L'ordre du jour n'accepte plus de propositions : la réunion a commencé.");
  const b = req.body || {};
  const title = A.text(b.title, 200, { required: true, msg: 'Indiquez le point à proposer.' });
  const kind = A.oneOf(b.kind, X.AGENDA_KINDS, 'discuss', 'Nature du point inconnue.');
  if (Number((await db.prepare('SELECT COUNT(*) c FROM mtg_agenda WHERE meeting_id = ?').get(m.id)).c) >= 40) throw new HttpError(400, "Pas plus de 40 points à l'ordre du jour.");
  const pos = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) p FROM mtg_agenda WHERE meeting_id = ?').get(m.id)).p) + 1;
  const auto = ctx.manage ? 1 : 0;
  const id = Number((await db.prepare('INSERT INTO mtg_agenda (org_id, meeting_id, position, title, owner_id, duration_min, kind, proposed_by, accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, m.id, pos, title, req.user.id, b.durationMin ? M.wholeNumber(b.durationMin, 0, 600, 'Durée invalide.') : 0, kind, req.user.id, auto)).lastInsertRowid);
  await M.mlog(req, m.id, 'agenda', auto ? "Point ajouté à l'ordre du jour" : "Point proposé pour l'ordre du jour");
  if (!auto && m.organizer_id && Number(m.organizer_id) !== req.user.id) await M.notice(req.org.id, m.organizer_id, 'meeting', `${req.user.name} propose un point pour ${label(m)} : ${oneLine(title, 120)}`, `meeting:${m.id}`);
  res.status(201).json({ id, accepted: Boolean(auto) });
});
router.post('/:id/agenda/:aid/decide', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!ctx.manage) throw new HttpError(403, "Vous n'avez pas le droit d'accepter les propositions.");
  M.needOpen(m);
  const g = await db.prepare('SELECT * FROM mtg_agenda WHERE id = ? AND meeting_id = ? AND accepted = 0').get(A.id(req.params.aid), m.id);
  if (!g) throw new HttpError(404, 'Proposition introuvable.');
  const accept = (req.body || {}).accept !== false;
  if (accept) await db.prepare('UPDATE mtg_agenda SET accepted = 1 WHERE id = ?').run(g.id); else await db.prepare('DELETE FROM mtg_agenda WHERE id = ?').run(g.id);
  await M.mlog(req, m.id, 'agenda', accept ? 'Proposition acceptée' : 'Proposition refusée');
  if (g.proposed_by && Number(g.proposed_by) !== req.user.id) await M.notice(req.org.id, g.proposed_by, 'meeting', `Votre point « ${oneLine(g.title, 100)} » a été ${accept ? 'accepté' : 'refusé'} pour ${label(m)}.`, `meeting:${m.id}`);
  res.json({ ok: true });
});

// ---------- Archivage ----------
router.post('/:id/archive', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!(ctx.validate || ctx.owner)) throw new HttpError(403, "Seule une personne autorisée à valider ou le propriétaire peut archiver.");
  if (m.archived_at) throw new HttpError(409, 'Cette réunion est déjà archivée.');
  if (m.minutes_status !== 'validated' && m.status !== 'cancelled') throw new HttpError(409, "Le compte rendu doit être validé avant l'archivage.");
  const pv = await db.prepare("SELECT status FROM mtg_pv WHERE meeting_id = ? AND status <> 'superseded' ORDER BY version DESC LIMIT 1").get(m.id);
  if (pv && pv.status !== 'signed') throw new HttpError(409, "Le procès-verbal n'est pas encore signé par tous.");
  await db.prepare('UPDATE mtg_meetings SET archived_at = ?, updated_at = ? WHERE id = ?').run(nowISO(), nowISO(), m.id);
  await M.mlog(req, m.id, 'archived', 'Réunion archivée');
  res.json({ ok: true });
});
router.post('/:id/unarchive', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!(ctx.validate || ctx.owner)) throw new HttpError(403, 'Seule une personne autorisée à valider ou le propriétaire peut sortir une réunion des archives.');
  if (!m.archived_at) throw new HttpError(409, "Cette réunion n'est pas archivée.");
  await db.prepare('UPDATE mtg_meetings SET archived_at = NULL, updated_at = ? WHERE id = ?').run(nowISO(), m.id);
  await M.mlog(req, m.id, 'unarchived', 'Réunion sortie des archives');
  res.json({ ok: true });
});
router.get('/archives', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const vis = M.visibleSql(req, cfg);
  const q = A.text(req.query.q, 100);
  const where = ['m.org_id = ?', 'm.archived_at IS NOT NULL']; const args = [req.org.id];
  if (req.query.year) { where.push('m.date >= ? AND m.date <= ?'); const y = A.id(req.query.year); args.push(`${y}-01-01`, `${y}-12-31`); }
  if (req.query.type) { where.push('m.type = ?'); args.push(M.type(req.query.type)); }
  if (q) { where.push("(m.title ILIKE ? ESCAPE '\\' OR m.objective ILIKE ? ESCAPE '\\')"); const l = `%${q.replace(/[\\%_]/g, '\\$&')}%`; args.push(l, l); }
  const rows = await db.prepare(`SELECT m.id, m.title, m.type, m.date, m.status, m.minutes_version, m.archived_at, m.confidential,
      (SELECT number FROM mtg_pv v WHERE v.meeting_id = m.id AND v.status = 'signed' ORDER BY v.version DESC LIMIT 1) AS pv_number,
      (SELECT COUNT(*) FROM mtg_attachments a WHERE a.meeting_id = m.id) AS n_docs,
      (SELECT COUNT(*) FROM mtg_resolutions r WHERE r.meeting_id = m.id) AS n_res
    FROM mtg_meetings m WHERE ${where.join(' AND ')}${vis.sql} ORDER BY m.date DESC, m.id DESC LIMIT 300`).all(...args, ...vis.args);
  res.json({ meetings: rows.map((r) => ({ id: Number(r.id), title: r.title, type: r.type, date: r.date, status: r.status, minutesVersion: Number(r.minutes_version), archivedAt: r.archived_at, confidential: Boolean(Number(r.confidential)), pvNumber: r.pv_number || null, documents: Number(r.n_docs), resolutions: Number(r.n_res) })) });
});

// ---------- Résolutions ----------
const voteMgr = (ctx, m, uid) => ctx.manage || Number(m.chair_id) === uid;
const eligible = (p) => X.weightOf(p) > 0 && p.attended === 'yes';
function canSeeRes(ctx, m) { return ctx.draftVisible || Boolean(ctx.mine) || m.minutes_status === 'validated'; }

function tally(r, votes) {
  const t = { for: 0, against: 0, abstain: 0 };
  let n = 0;
  for (const v of votes) { t[v.choice] += Number(v.weight); n++; }
  const expressed = t.for + t.against;
  let outcome;
  if (expressed <= 0) outcome = 'rejected';
  else if (r.majority === 'unanimity') outcome = t.against === 0 && t.for > 0 ? 'adopted' : 'rejected';
  else if (r.majority === 'qualified') outcome = (t.for / expressed) * 100 >= Number(r.threshold) - 1e-9 ? 'adopted' : 'rejected';
  else outcome = t.for > t.against ? 'adopted' : 'rejected';
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { for: r3(t.for), against: r3(t.against), abstain: r3(t.abstain), expressed: r3(expressed), voters: n, outcome };
}
async function votesOf(resId) { return await db.prepare('SELECT * FROM mtg_votes WHERE resolution_id = ?').all(resId); }

async function resView(req, m, ctx, parts, r) {
  const uid = req.user.id;
  const roll = await db.prepare('SELECT participant_id FROM mtg_vote_roll WHERE resolution_id = ?').all(r.id);
  const rolled = new Set(roll.map((x) => Number(x.participant_id)));
  const mgr = voteMgr(ctx, m, uid);
  const closed = r.vote_state === 'closed';
  const result = r.result ? JSON.parse(r.result) : null;
  const mine = ctx.mine;
  let myVote = null;
  if (mine && rolled.has(Number(mine.id))) {
    const v = await db.prepare('SELECT choice FROM mtg_votes WHERE resolution_id = ? AND voter_key = ?').get(r.id, X.voterKey(r.id, mine.id));
    myVote = v ? v.choice : null;
  }
  const eligibles = parts.filter(eligible);
  const out = {
    id: Number(r.id), meetingId: Number(r.meeting_id), number: r.number, title: r.title, text: r.text, agendaId: r.agenda_id == null ? null : Number(r.agenda_id),
    carrierId: r.carrier_id == null ? null : Number(r.carrier_id), carrier: r.carrier_name || '', due: r.due || null, status: r.status,
    majority: r.majority, threshold: Number(r.threshold), weighted: Boolean(Number(r.weighted)), voteMode: r.vote_mode, voteState: r.vote_state,
    openedAt: r.opened_at, closedAt: r.closed_at, postponedReason: r.postponed_reason, postponedTo: r.postponed_to == null ? null : Number(r.postponed_to),
    voted: rolled.size, eligible: eligibles.length, myVote, resultHash: r.result_hash || '',
    rights: { edit: ctx.write && r.vote_state === 'none' && ['none', 'draft'].includes(m.minutes_status), manage: mgr && ['none', 'draft'].includes(m.minutes_status),
      vote: r.vote_state === 'open' && r.vote_mode !== 'hand' && Boolean(mine) && eligible(mine), hand: r.vote_state === 'open' && r.vote_mode === 'hand' && ctx.write },
  };
  // Résultat : visible de tous une fois la clôture faite ; pendant le vote, seul celui qui conduit le vote voit le décompte (pas d'influence sur les autres).
  if (closed) out.result = result;
  else if (mgr && r.vote_state === 'open') { const v = await votesOf(r.id); out.live = tally(r, v); }
  // Détail par personne : jamais en vote secret ; en nominatif / à main levée, visible une fois clos (ou de celui qui conduit le vote).
  if (r.vote_mode !== 'secret' && (closed || mgr) && (closed || r.vote_state === 'open')) {
    const v = await votesOf(r.id);
    const byP = new Map(v.map((x) => [Number(x.participant_id), x]));
    out.details = parts.filter((p) => byP.has(Number(p.id))).map((p) => ({ participantId: Number(p.id), name: p.uname || p.name, choice: byP.get(Number(p.id)).choice, weight: Number(byP.get(Number(p.id)).weight) }));
  }
  if (mgr) out.roll = parts.filter(eligible).map((p) => ({ participantId: Number(p.id), name: p.uname || p.name, voted: rolled.has(Number(p.id)) }));
  return out;
}
const RES_FIELDS_MSG = 'Résolution invalide.';
async function cleanRes(req, m, b, cur) {
  if (!b || typeof b !== 'object') throw new HttpError(400, RES_FIELDS_MSG);
  const text = b.text === undefined && cur ? cur.text : A.text(b.text, 2000, { required: true, msg: 'Écrivez le texte de la résolution.' });
  const title = b.title === undefined && cur ? cur.title : A.text(b.title, 200);
  const carrierId = b.carrierId === undefined && cur ? cur.carrier_id : await A.memberOf(req, b.carrierId);
  const carrierName = carrierId ? '' : (b.carrierName === undefined && cur ? cur.carrier_name : A.text(b.carrierName, 100));
  const due = b.due === undefined && cur ? cur.due : A.date(b.due);
  if (due && due < m.date) throw new HttpError(400, "L'échéance ne peut pas précéder la date de la réunion.");
  const majority = b.majority === undefined && cur ? cur.majority : A.oneOf(b.majority, X.MAJORITY, 'simple', 'Majorité inconnue (simple, qualifiée ou unanimité).');
  const thr = b.threshold === undefined && cur ? Number(cur.threshold) : (b.threshold === undefined || b.threshold === '' ? 67 : Number(b.threshold));
  if (!Number.isInteger(thr) || thr < 51 || thr > 100) throw new HttpError(400, 'Seuil de majorité qualifiée invalide (51 à 100 %).');
  const mode = b.voteMode === undefined && cur ? cur.vote_mode : A.oneOf(b.voteMode, X.VOTE_MODES, 'named', 'Mode de vote inconnu (main levée, nominatif ou secret).');
  const weighted = b.weighted === undefined && cur ? Number(cur.weighted) : (b.weighted === true || b.weighted === 1 ? 1 : 0);
  let agendaId = cur ? cur.agenda_id : null;
  if (b.agendaId !== undefined) { agendaId = A.idOrNull(b.agendaId, 'Point invalide.'); if (agendaId && !await db.prepare('SELECT 1 FROM mtg_agenda WHERE id = ? AND meeting_id = ?').get(agendaId, m.id)) throw new HttpError(400, "Ce point n'est pas à l'ordre du jour de la réunion."); }
  return { text, title, carrierId: carrierId || null, carrierName, due: due || null, majority, threshold: thr, mode, weighted, agendaId };
}
async function loadRes(req, m, rid) {
  const r = await db.prepare('SELECT * FROM mtg_resolutions WHERE id = ? AND meeting_id = ?').get(A.id(rid, 'Résolution introuvable.'), m.id);
  if (!r) throw new HttpError(404, 'Résolution introuvable.');
  return r;
}
function needVotable(m) {
  M.needNotCancelled(m); M.needOpen(m);
  if (m.status === 'no_quorum') throw new HttpError(409, 'La réunion est déclarée sans quorum : aucune décision ne peut être prise.');
}

router.get('/:id/resolutions', async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  if (!canSeeRes(ctx, m)) return res.json({ resolutions: [] });
  const rows = await db.prepare('SELECT * FROM mtg_resolutions WHERE meeting_id = ? ORDER BY position, id').all(m.id);
  const out = []; for (const r of rows) out.push(await resView(req, m, ctx, parts, r));
  res.json({ resolutions: out });
});
router.post('/:id/resolutions', writeLimit, async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  const b = req.body || {};
  const list = Array.isArray(b.items) ? b.items : [b];
  if (!list.length || list.length > 20) throw new HttpError(400, 'Indiquez de 1 à 20 résolutions.');
  const clean = []; for (const it of list) clean.push(await cleanRes(req, m, it, null));
  if (Number((await db.prepare('SELECT COUNT(*) c FROM mtg_resolutions WHERE meeting_id = ?').get(m.id)).c) + clean.length > 60) throw new HttpError(400, '60 résolutions au maximum par réunion.');
  const year = Number(m.date.slice(0, 4));
  const ids = [];
  await db.transaction(async () => {
    let pos = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) p FROM mtg_resolutions WHERE meeting_id = ?').get(m.id)).p);
    for (const c of clean) {
      const id = await X.numbered('mtg_resolutions', 'RES', req, year, async (seq, number) => Number((await db.prepare(`INSERT INTO mtg_resolutions (org_id, meeting_id, agenda_id, year, seq, number, position, title, text, carrier_id, carrier_name, due, majority, threshold, weighted, vote_mode, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, m.id, c.agendaId, year, seq, number, ++pos, c.title, c.text, c.carrierId, c.carrierName, c.due, c.majority, c.threshold, c.weighted, c.mode, req.user.id, nowISO())).lastInsertRowid));
      ids.push(id);
      if (c.carrierId || c.carrierName) await X.resp(req, m, { kind: 'resolution', refId: id, userId: c.carrierId, userName: c.carrierName, role: 'carrier', subject: c.title || c.text });
    }
    await M.mlog(req, m.id, 'resolution', `${clean.length} résolution(s) ajoutée(s)`);
  })();
  void parts;
  res.status(201).json({ ids });
});
router.put('/:id/resolutions/:rid', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  const r = await loadRes(req, m, req.params.rid);
  const b = req.body || {};
  if (r.vote_state !== 'none') {
    // Une fois le vote ouvert, le texte, la majorité et le mode sont figés ; seuls le porteur et l'échéance se précisent (suivi).
    const frozen = ['text', 'title', 'majority', 'threshold', 'voteMode', 'weighted', 'agendaId'].filter((k) => b[k] !== undefined);
    if (frozen.length) throw new HttpError(409, 'Le vote est ouvert ou clos : le texte et les règles de la résolution ne peuvent plus changer.');
  }
  const n = await cleanRes(req, m, b, r);
  await db.transaction(async () => {
    await db.prepare('UPDATE mtg_resolutions SET agenda_id = ?, title = ?, text = ?, carrier_id = ?, carrier_name = ?, due = ?, majority = ?, threshold = ?, weighted = ?, vote_mode = ? WHERE id = ?')
      .run(n.agendaId, n.title, n.text, n.carrierId, n.carrierName, n.due, n.majority, n.threshold, n.weighted, n.mode, r.id);
    await X.respChange(req, m, { kind: 'resolution', refId: r.id, role: 'carrier', subject: n.title || n.text, before: r.carrier_id, after: n.carrierId, beforeName: r.carrier_name, afterName: n.carrierName });
    await M.mlog(req, m.id, 'resolution', 'Résolution modifiée');
  })();
  res.json({ ok: true });
});
router.delete('/:id/resolutions/:rid', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needOpen(m);
  const r = await loadRes(req, m, req.params.rid);
  if (r.vote_state !== 'none') throw new HttpError(409, 'Une résolution dont le vote a été ouvert ne se supprime pas : elle reste consignée.');
  await db.prepare('DELETE FROM mtg_resolutions WHERE id = ?').run(r.id);
  await M.mlog(req, m.id, 'resolution', 'Résolution supprimée');
  res.json({ ok: true });
});

router.post('/:id/resolutions/:rid/open-vote', async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  if (!voteMgr(ctx, m, req.user.id)) throw new HttpError(403, "Seul l'organisateur (ou le président de séance) ouvre un vote.");
  needVotable(m);
  const r = await loadRes(req, m, req.params.rid);
  if (r.vote_state !== 'none') throw new HttpError(409, r.vote_state === 'open' ? 'Le vote est déjà ouvert.' : 'Le vote de cette résolution est clos.');
  if (await db.prepare("SELECT 1 FROM mtg_resolutions WHERE meeting_id = ? AND vote_state = 'open'").get(m.id)) throw new HttpError(409, 'Un autre vote est déjà ouvert : clôturez-le d’abord.');
  const q = await X.quorumState(req, m, parts, cfg);
  if (!q.ok) { const e = new HttpError(409, `Quorum non atteint (${q.present} présent(s), ${q.need} requis) : le vote ne peut pas être ouvert.`); e.errorCode = 'no_quorum'; throw e; }
  if (!parts.some(eligible)) throw new HttpError(409, "Aucun participant présent n'a le droit de vote : cochez les présences d'abord.");
  await db.prepare("UPDATE mtg_resolutions SET vote_state = 'open', opened_by = ?, opened_at = ? WHERE id = ?").run(req.user.id, nowISO(), r.id);
  await M.mlog(req, m.id, 'vote_open', `Vote ouvert : ${r.number} (${r.vote_mode === 'secret' ? 'secret' : r.vote_mode === 'hand' ? 'main levée' : 'nominatif'})`);
  if (r.vote_mode !== 'hand') for (const p of parts.filter(eligible)) if (Number(p.user_id) !== req.user.id) await M.notice(req.org.id, p.user_id, 'meeting_vote', `Vote ouvert : ${r.number} — ${oneLine(r.title || r.text, 120)}`, `meeting:${m.id}`);
  res.json({ ok: true });
});

router.post('/:id/resolutions/:rid/vote', voteLimit, async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  needVotable(m);
  const r = await loadRes(req, m, req.params.rid);
  if (r.vote_state !== 'open') throw new HttpError(409, r.vote_state === 'closed' ? 'Le vote est clos : le résultat est consigné.' : "Le vote n'est pas ouvert.");
  const b = req.body || {};
  let entries;
  if (r.vote_mode === 'hand') {
    if (!ctx.write) throw new HttpError(403, 'Le vote à main levée est saisi par le secrétaire de séance (ou la personne qui conduit la réunion).');
    const items = Array.isArray(b.items) ? b.items : [b];
    if (!items.length || items.length > 100) throw new HttpError(400, 'Indiquez les votes à saisir.');
    entries = items.map((it) => ({ p: parts.find((x) => Number(x.id) === A.id(it && it.participantId, 'Participant invalide.')), choice: A.oneOf(it.choice, X.CHOICES, undefined, 'Choix invalide : pour, contre ou abstention.') }));
    for (const e of entries) if (!e.p) throw new HttpError(404, 'Participant introuvable.');
  } else {
    if (b.participantId !== undefined && b.participantId !== null && b.participantId !== '' && Number(b.participantId) !== Number(ctx.mine && ctx.mine.id)) throw new HttpError(403, 'En vote électronique, chacun vote pour soi-même.');
    if (!ctx.mine) throw new HttpError(403, "Vous n'êtes pas convoqué(e) à cette réunion : vous ne pouvez pas voter.");
    entries = [{ p: ctx.mine, choice: A.oneOf(b.choice, X.CHOICES, undefined, 'Choix invalide : pour, contre ou abstention.') }];
  }
  for (const e of entries) {
    if (X.weightOf(e.p) <= 0) throw new HttpError(403, `${e.p.uname || e.p.name || 'Cette personne'} n'a pas le droit de vote.`);
    if (e.p.attended !== 'yes') throw new HttpError(409, `${e.p.uname || e.p.name || 'Cette personne'} n'est pas marquée présente : le vote n'est ouvert qu'aux présents.`);
  }
  const secret = r.vote_mode === 'secret';
  let changed = 0;
  await db.transaction(async () => {
    for (const e of entries) {
      const key = X.voterKey(r.id, e.p.id);
      const w = Number(r.weighted) ? X.weightOf(e.p) : 1;
      const had = await db.prepare('SELECT 1 FROM mtg_vote_roll WHERE resolution_id = ? AND participant_id = ?').get(r.id, e.p.id);
      if (had) changed++;
      await db.prepare(`INSERT INTO mtg_votes (org_id, resolution_id, voter_key, participant_id, choice, weight, cast_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (resolution_id, voter_key) DO UPDATE SET choice = EXCLUDED.choice, weight = EXCLUDED.weight, cast_at = EXCLUDED.cast_at`).run(req.org.id, r.id, key, secret ? null : e.p.id, e.choice, w, secret ? null : nowISO());
      await db.prepare(`INSERT INTO mtg_vote_roll (org_id, resolution_id, participant_id, voted_at, entered_by) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (resolution_id, participant_id) DO UPDATE SET voted_at = EXCLUDED.voted_at, entered_by = EXCLUDED.entered_by`).run(req.org.id, r.id, e.p.id, nowISO(), req.user.id);
    }
    // Le journal ne contient jamais le choix : seulement qu'un vote a été enregistré ou modifié.
    await M.mlog(req, m.id, 'vote_cast', `${r.number} : ${entries.length} vote(s) ${changed ? 'modifié(s)' : 'enregistré(s)'}${r.vote_mode === 'hand' ? ' (main levée)' : ''}`, entries.length);
  })();
  res.json({ ok: true, count: entries.length, changed });
});

router.post('/:id/resolutions/:rid/close-vote', async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  if (!voteMgr(ctx, m, req.user.id)) throw new HttpError(403, "Seul l'organisateur (ou le président de séance) clôture un vote.");
  needVotable(m);
  const r = await loadRes(req, m, req.params.rid);
  if (r.vote_state !== 'open') throw new HttpError(409, r.vote_state === 'closed' ? 'Le vote est déjà clos.' : "Le vote n'est pas ouvert.");
  const votes = await votesOf(r.id);
  const q = await X.quorumState(req, m, parts, cfg);
  const t = tally(r, votes);
  const eligibles = parts.filter(eligible).length;
  const quorumOk = q.ok;
  const status = quorumOk ? t.outcome : 'no_quorum';
  const result = { ...t, outcome: status, eligible: eligibles,
    majority: r.majority, threshold: r.majority === 'qualified' ? Number(r.threshold) : null, weighted: Boolean(Number(r.weighted)), mode: r.vote_mode, quorumOk, quorum: { present: q.present, need: q.need }, closedAt: nowISO(), void: !quorumOk };
  // Empreinte du résultat : en vote secret, seuls les bulletins anonymes (choix + poids, triés) y entrent ; en nominatif, le nom du votant aussi.
  const ballots = votes.map((v) => (r.vote_mode === 'secret' ? { c: v.choice, w: Number(v.weight) } : { p: Number(v.participant_id), c: v.choice, w: Number(v.weight) }))
    .sort((a, b) => X.canon(a).localeCompare(X.canon(b)));
  const hash = X.sha({ number: r.number, text: r.text, majority: r.majority, threshold: Number(r.threshold), mode: r.vote_mode, result: { for: result.for, against: result.against, abstain: result.abstain, outcome: status }, ballots });
  let taskActionId = null;
  await db.transaction(async () => {
    await db.prepare("UPDATE mtg_resolutions SET vote_state = 'closed', status = ?, closed_by = ?, closed_at = ?, result = ?, result_hash = ? WHERE id = ?").run(status, req.user.id, nowISO(), JSON.stringify(result), hash, r.id);
    if (status === 'adopted') {
      const pos = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) p FROM mtg_decisions WHERE meeting_id = ?').get(m.id)).p) + 1;
      await db.prepare('INSERT INTO mtg_decisions (org_id, meeting_id, agenda_id, position, text, created_by, created_at, resolution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.org.id, m.id, r.agenda_id, pos, `${r.number} — ${r.title ? r.title + ' : ' : ''}${r.text}`.slice(0, 1000), req.user.id, nowISO(), r.id);
      if (r.carrier_id || r.carrier_name || r.due) {
        const apos = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) p FROM mtg_actions WHERE meeting_id = ?').get(m.id)).p) + 1;
        const atext = oneLine(`Mettre en œuvre la résolution ${r.number} : ${r.title || r.text}`, 500);
        taskActionId = Number((await db.prepare('INSERT INTO mtg_actions (org_id, meeting_id, agenda_id, position, text, assignee_id, assignee_name, due, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(req.org.id, m.id, r.agenda_id, apos, atext, r.carrier_id, r.carrier_id ? '' : r.carrier_name, r.due, req.user.id, nowISO())).lastInsertRowid);
        await X.resp(req, m, { kind: 'action', refId: taskActionId, userId: r.carrier_id, userName: r.carrier_name, role: 'assignee', subject: atext });
      }
    }
    await M.mlog(req, m.id, 'vote_close', `Vote clos : ${r.number} — ${status === 'adopted' ? 'adoptée' : status === 'rejected' ? 'rejetée' : 'sans quorum'} (${t.for} pour, ${t.against} contre, ${t.abstain} abstention)`);
  })();
  res.json({ ok: true, status, result, hash });
});

router.post('/:id/resolutions/:rid/postpone', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!(voteMgr(ctx, m, req.user.id) || ctx.write)) throw new HttpError(403, "Vous n'avez pas le droit de reporter une résolution.");
  M.needNotCancelled(m); M.needOpen(m);
  const r = await loadRes(req, m, req.params.rid);
  if (r.vote_state === 'closed') throw new HttpError(409, 'Le résultat de cette résolution est consigné : elle ne peut plus être reportée.');
  const reason = A.text((req.body || {}).reason, 300, { required: true, msg: 'Indiquez le motif du report.' });
  let target = null;
  if ((req.body || {}).toMeetingId) {
    const t = await M.load(req, req.body.toMeetingId);
    M.needWrite(t.ctx);
    if (t.m.status === 'cancelled' || t.m.minutes_status === 'validated') throw new HttpError(409, 'La réunion choisie ne peut plus recevoir de résolution.');
    target = t.m;
  }
  let newId = null;
  await db.transaction(async () => {
    await db.prepare('DELETE FROM mtg_votes WHERE resolution_id = ?').run(r.id);
    await db.prepare('DELETE FROM mtg_vote_roll WHERE resolution_id = ?').run(r.id);
    await db.prepare("UPDATE mtg_resolutions SET status = 'postponed', vote_state = 'closed', postponed_reason = ?, closed_by = ?, closed_at = ?, result = ?, postponed_to = ? WHERE id = ?")
      .run(reason, req.user.id, nowISO(), JSON.stringify({ outcome: 'postponed', reason }), target ? target.id : null, r.id);
    if (target) {
      const year = Number(target.date.slice(0, 4));
      const pos = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) p FROM mtg_resolutions WHERE meeting_id = ?').get(target.id)).p) + 1;
      newId = await X.numbered('mtg_resolutions', 'RES', req, year, async (seq, number) => Number((await db.prepare(`INSERT INTO mtg_resolutions (org_id, meeting_id, year, seq, number, position, title, text, carrier_id, carrier_name, due, majority, threshold, weighted, vote_mode, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, target.id, year, seq, number, pos, r.title, r.text, r.carrier_id, r.carrier_name, r.due, r.majority, r.threshold, r.weighted, r.vote_mode, req.user.id, nowISO())).lastInsertRowid));
    }
    await M.mlog(req, m.id, 'resolution', `${r.number} reportée${target ? ' à une autre réunion' : ''}`);
  })();
  res.json({ ok: true, carriedTo: newId });
});

// ---------- Registre des résolutions (toutes réunions) ----------
async function listResolutions(req) {
  const cfg = await M.getConfig(req.org.id);
  const vis = M.visibleSql(req, cfg);
  const q = req.query;
  const where = ['m.org_id = ?', "(m.minutes_status = 'validated' OR r.vote_state <> 'none')"]; const args = [req.org.id];
  if (q.status) { where.push('r.status = ?'); args.push(A.oneOf(q.status, X.RES_STATUS, undefined, 'Statut inconnu.')); }
  if (q.year) { where.push('r.year = ?'); args.push(A.id(q.year)); }
  if (q.mine) { where.push('r.carrier_id = ?'); args.push(req.user.id); }
  if (q.q) { const l = `%${A.text(q.q, 100).replace(/[\\%_]/g, '\\$&')}%`; where.push("(r.text ILIKE ? ESCAPE '\\' OR r.title ILIKE ? ESCAPE '\\' OR r.number ILIKE ? ESCAPE '\\')"); args.push(l, l, l); }
  // Une personne qui ne lit pas le brouillon ne voit que les résolutions des comptes rendus validés ou des réunions où elle siège.
  const owner = req.member.role === 'owner';
  const peek = owner ? '1 = 1' : `(m.minutes_status = 'validated' OR m.organizer_id = ? OR m.created_by = ? OR m.secretary_id = ? OR EXISTS (SELECT 1 FROM mtg_participants pp WHERE pp.meeting_id = m.id AND pp.user_id = ?))`;
  const pArgs = owner ? [] : [req.user.id, req.user.id, req.user.id, req.user.id];
  const rows = await db.prepare(`SELECT r.*, m.title AS mtitle, m.date AS mdate, m.confidential AS mconf, u.name AS cname FROM mtg_resolutions r JOIN mtg_meetings m ON m.id = r.meeting_id LEFT JOIN users u ON u.id = r.carrier_id
    WHERE ${where.join(' AND ')} AND ${peek}${vis.sql} ORDER BY m.date DESC, r.id DESC LIMIT 500`).all(...args, ...pArgs, ...vis.args);
  return rows.map((r) => ({ id: Number(r.id), meetingId: Number(r.meeting_id), meetingTitle: r.mtitle, meetingDate: r.mdate, number: r.number, title: r.title, text: r.text, carrier: r.cname || r.carrier_name || '', carrierId: r.carrier_id == null ? null : Number(r.carrier_id), due: r.due || null,
    status: r.status, majority: r.majority, voteMode: r.vote_mode, result: r.vote_state === 'closed' && r.result ? (({ for: f, against, abstain, outcome }) => ({ for: f, against, abstain, outcome }))(JSON.parse(r.result)) : null }));
}
router.get('/resolutions', async (req, res) => res.json({ resolutions: await listResolutions(req) }));
router.get('/resolutions.csv', async (req, res) => {
  const ST = { pending: 'En attente', adopted: 'Adoptée', rejected: 'Rejetée', postponed: 'Reportée', no_quorum: 'Sans quorum' };
  W.sendCsv(res, 'resolutions.csv', ['Numéro', 'Réunion', 'Date', 'Titre', 'Texte', 'Porteur', 'Échéance', 'Statut', 'Pour', 'Contre', 'Abstention'],
    (await listResolutions(req)).map((r) => [r.number, r.meetingTitle, r.meetingDate, r.title, r.text, r.carrier, r.due || '', ST[r.status] || r.status, r.result ? r.result.for : '', r.result ? r.result.against : '', r.result ? r.result.abstain : '']));
});

router.use('/', require('./meetings-adv2').router);

module.exports = { router, tally, eligible, canSeeRes, resView, voteMgr };
