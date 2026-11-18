'use strict';
// Réunions (2/4) : déroulé (présence réelle, notes point par point), décisions, actions, compte rendu (brouillon → soumis → validé ou renvoyé,
// nouvelle version après validation), actions → tâches de Projets, export PDF.
// Le compte rendu VALIDÉ est un instantané verrouillé (mtg_minutes) : il ne change que par une nouvelle version, avec historique.
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const A = require('./access');
const M = require('./meetings-lib');
const { HttpError, oneLine, isEmail, log } = require('../util');

const router = express.Router({ mergeParams: true });
const pdfLimit = limits.make(10 * 60 * 1000, 60, 'Trop de téléchargements. Réessayez dans quelques minutes.');
const decideLimit = limits.make(10 * 60 * 1000, 60, 'Trop de demandes. Réessayez dans quelques minutes.');

// ---------- Contenu ----------
async function agendaRows(meetingId) {
  return (await db.prepare('SELECT g.*, u.name AS uname FROM mtg_agenda g LEFT JOIN users u ON u.id = g.owner_id WHERE g.meeting_id = ? ORDER BY g.position, g.id').all(meetingId))
    .map((g) => ({ id: Number(g.id), title: g.title, ownerId: g.owner_id == null ? null : Number(g.owner_id), owner: g.uname || g.owner_name || '', durationMin: Number(g.duration_min), notes: g.notes, done: Boolean(Number(g.done)) }));
}
async function decisionRows(meetingId) {
  return (await db.prepare('SELECT * FROM mtg_decisions WHERE meeting_id = ? ORDER BY position, id').all(meetingId)).map((d) => ({ id: Number(d.id), text: d.text, agendaId: d.agenda_id == null ? null : Number(d.agenda_id) }));
}
async function liveContent(m) {
  return { summary: m.summary, nextMeeting: m.next_meeting, agenda: await agendaRows(m.id), decisions: await decisionRows(m.id), actions: await M.actionsOf(m.id), source: 'live' };
}
async function officialRow(meetingId) {
  return await db.prepare("SELECT * FROM mtg_minutes WHERE meeting_id = ? AND status = 'validated' ORDER BY version DESC LIMIT 1").get(meetingId);
}
/** Ce que la personne a le droit de lire : l'équipe qui rédige / valide voit le brouillon en cours ; les autres, seulement la dernière version VALIDÉE. */
async function contentFor(req, m, parts, ctx) {
  if (ctx.draftVisible) return await liveContent(m);
  const off = await officialRow(m.id);
  if (!off) return { summary: '', nextMeeting: '', agenda: (await agendaRows(m.id)).map((a) => ({ ...a, notes: '', done: false })), decisions: [], actions: [], source: 'none' };
  const c = JSON.parse(off.content);
  const live = new Map((await M.actionsOf(m.id)).map((a) => [a.id, a]));
  return {
    summary: c.summary, nextMeeting: c.nextMeeting, agenda: c.agenda, decisions: c.decisions, source: 'official', officialVersion: Number(off.version),
    actions: c.actions.map((a) => live.get(a.id) || { ...a, status: 'open', overdue: false }),
  };
}
/** Instantané du compte rendu (ce qui est figé à la soumission puis à la validation). */
async function snapshot(req, m, parts) {
  const c = await liveContent(m);
  const names = await db.prepare('SELECT id, name FROM users WHERE id IN (?, ?)').all(m.organizer_id || 0, m.secretary_id || 0);
  const nm = (id) => (names.find((n) => Number(n.id) === Number(id)) || {}).name || '';
  return {
    summary: c.summary, nextMeeting: c.nextMeeting, agenda: c.agenda, decisions: c.decisions,
    actions: c.actions.filter((a) => a.status !== 'cancelled').map((a) => ({ id: a.id, text: a.text, assigneeId: a.assigneeId, assignee: a.assignee, due: a.due, agendaId: a.agendaId })),
    attendance: parts.map((p) => ({ name: p.uname || p.name, kind: p.user_id == null ? 'guest' : 'member', required: Boolean(Number(p.required)), response: p.response, reason: p.reason, attended: p.attended })),
    meta: { title: m.title, type: m.type, date: m.date, time: m.start_time, endTime: M.endTime(m), durationMin: Number(m.duration_min), place: m.place, link: m.link, objective: m.objective, organizer: nm(m.organizer_id), secretary: nm(m.secretary_id), org: req.org.name },
  };
}
const emptyContent = (c) => !c.summary && !c.agenda.some((a) => a.notes) && !c.decisions.length && !c.actions.length;

// ---------- Déroulé : notes, présence réelle ----------
router.put('/:id/notes', async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  const b = req.body || {};
  const summary = b.summary === undefined ? m.summary : A.text(b.summary, 8000);
  const next = b.nextMeeting === undefined ? m.next_meeting : A.text(b.nextMeeting, 500);
  const items = b.agenda === undefined ? null : b.agenda;
  if (items !== null && !Array.isArray(items)) throw new HttpError(400, 'Notes invalides.');
  const att = b.attendance === undefined ? null : b.attendance;
  if (att !== null && !Array.isArray(att)) throw new HttpError(400, 'Présences invalides.');
  const agenda = await db.prepare('SELECT id FROM mtg_agenda WHERE meeting_id = ?').all(m.id);
  const ag = new Set(agenda.map((a) => Number(a.id)));
  await db.transaction(async () => {
    await db.prepare('UPDATE mtg_meetings SET summary = ?, next_meeting = ?, updated_at = ? WHERE id = ?').run(summary, next, nowISO(), m.id);
    for (const it of items || []) {
      const id = A.id(it && it.id);
      if (!ag.has(id)) throw new HttpError(404, 'Point introuvable.');
      if (it.notes !== undefined) await db.prepare('UPDATE mtg_agenda SET notes = ? WHERE id = ?').run(A.text(it.notes, 8000), id);
      if (it.done !== undefined) await db.prepare('UPDATE mtg_agenda SET done = ? WHERE id = ?').run(it.done ? 1 : 0, id);
    }
    for (const a of att || []) {
      const pid = A.id(a && a.id);
      if (!parts.some((p) => Number(p.id) === pid)) throw new HttpError(404, 'Participant introuvable.');
      await db.prepare('UPDATE mtg_participants SET attended = ? WHERE id = ?').run(A.oneOf(a.attended, M.ATTENDED, undefined, 'Présence invalide.'), pid);
    }
    await M.mlog(req, m.id, 'notes', 'Notes du déroulé enregistrées');
  })();
  res.json({ ok: true });
});

// ---------- Décisions ----------
async function agendaOf(m, v) {
  const id = A.idOrNull(v, 'Point invalide.');
  if (id === null) return null;
  if (!await db.prepare('SELECT 1 FROM mtg_agenda WHERE id = ? AND meeting_id = ?').get(id, m.id)) throw new HttpError(400, "Ce point n'est pas à l'ordre du jour de la réunion.");
  return id;
}
router.post('/:id/decisions', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  const b = req.body || {};
  const list = Array.isArray(b.items) ? b.items : [b];
  if (!list.length || list.length > 40) throw new HttpError(400, 'Indiquez de 1 à 40 décisions.');
  const clean = [];
  for (const d of list) clean.push({ text: A.text(d && d.text, 1000, { required: true, msg: 'Écrivez la décision.' }), agendaId: await agendaOf(m, d && d.agendaId) });
  const pos = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) p FROM mtg_decisions WHERE meeting_id = ?').get(m.id)).p);
  const ids = [];
  await db.transaction(async () => {
    let p = pos;
    for (const d of clean) ids.push(Number((await db.prepare('INSERT INTO mtg_decisions (org_id, meeting_id, agenda_id, position, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, m.id, d.agendaId, ++p, d.text, req.user.id, nowISO())).lastInsertRowid));
    await M.mlog(req, m.id, 'decision', `${clean.length} décision(s) ajoutée(s)`);
  })();
  res.status(201).json({ ids });
});
router.put('/:id/decisions/:did', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needOpen(m);
  const d = await db.prepare('SELECT * FROM mtg_decisions WHERE id = ? AND meeting_id = ?').get(A.id(req.params.did), m.id);
  if (!d) throw new HttpError(404, 'Décision introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE mtg_decisions SET text = ?, agenda_id = ? WHERE id = ?').run(b.text === undefined ? d.text : A.text(b.text, 1000, { required: true, msg: 'Écrivez la décision.' }), b.agendaId === undefined ? d.agenda_id : await agendaOf(m, b.agendaId), d.id);
  await M.mlog(req, m.id, 'decision', 'Décision modifiée');
  res.json({ ok: true });
});
router.delete('/:id/decisions/:did', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needOpen(m);
  const r = await db.prepare('DELETE FROM mtg_decisions WHERE id = ? AND meeting_id = ?').run(A.id(req.params.did), m.id);
  if (!r.changes) throw new HttpError(404, 'Décision introuvable.');
  await M.mlog(req, m.id, 'decision', 'Décision supprimée');
  res.json({ ok: true });
});

// ---------- Actions ----------
async function cleanAction(req, m, a, cur) {
  if (!a || typeof a !== 'object') throw new HttpError(400, 'Action invalide.');
  const text = a.text === undefined && cur ? cur.text : A.text(a.text, 500, { required: true, msg: "Décrivez l'action." });
  const assigneeId = a.assigneeId === undefined && cur ? cur.assignee_id : await A.memberOf(req, a.assigneeId);
  const due = a.due === undefined && cur ? cur.due : A.date(a.due);
  if (due && due < m.date) throw new HttpError(400, "L'échéance ne peut pas précéder la date de la réunion.");
  const assigneeName = assigneeId ? '' : (a.assigneeName === undefined && cur ? cur.assignee_name : A.text(a.assigneeName, 100));
  const agendaId = a.agendaId === undefined && cur ? cur.agenda_id : await agendaOf(m, a.agendaId);
  return { text, assigneeId: assigneeId || null, assigneeName, due: due || null, agendaId };
}
router.post('/:id/actions', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  const b = req.body || {};
  const list = Array.isArray(b.items) ? b.items : [b];
  if (!list.length || list.length > 40) throw new HttpError(400, 'Indiquez de 1 à 40 actions.');
  const clean = [];
  for (const a of list) clean.push(await cleanAction(req, m, a, null));
  let pos = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) p FROM mtg_actions WHERE meeting_id = ?').get(m.id)).p);
  const ids = [];
  await db.transaction(async () => {
    for (const a of clean) ids.push(Number((await db.prepare('INSERT INTO mtg_actions (org_id, meeting_id, agenda_id, position, text, assignee_id, assignee_name, due, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, m.id, a.agendaId, ++pos, a.text, a.assigneeId, a.assigneeName, a.due, req.user.id, nowISO())).lastInsertRowid));
    await M.mlog(req, m.id, 'action', `${clean.length} action(s) ajoutée(s)`);
  })();
  res.status(201).json({ ids });
});
router.put('/:id/actions/:aid', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needOpen(m);
  const cur = await db.prepare('SELECT * FROM mtg_actions WHERE id = ? AND meeting_id = ?').get(A.id(req.params.aid), m.id);
  if (!cur) throw new HttpError(404, 'Action introuvable.');
  const n = await cleanAction(req, m, req.body || {}, cur);
  await db.transaction(async () => {
    await db.prepare('UPDATE mtg_actions SET text = ?, assignee_id = ?, assignee_name = ?, due = ?, agenda_id = ?, reminded_stage = CASE WHEN due IS DISTINCT FROM ? THEN 0 ELSE reminded_stage END WHERE id = ?').run(n.text, n.assigneeId, n.assigneeName, n.due, n.agendaId, n.due, cur.id);
    await M.mlog(req, m.id, 'action', 'Action modifiée');
  })();
  res.json({ ok: true });
});
router.delete('/:id/actions/:aid', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needOpen(m);
  const cur = await db.prepare('SELECT * FROM mtg_actions WHERE id = ? AND meeting_id = ?').get(A.id(req.params.aid), m.id);
  if (!cur) throw new HttpError(404, 'Action introuvable.');
  if (cur.task_id) throw new HttpError(409, 'Cette action a déjà une tâche dans Projets : marquez-la « annulée » plutôt que de la supprimer.');
  await db.prepare('DELETE FROM mtg_actions WHERE id = ?').run(cur.id);
  await M.mlog(req, m.id, 'action', 'Action supprimée');
  res.json({ ok: true });
});

/** Suivi : la personne responsable, l'équipe qui gère la réunion ou un validateur peut changer le statut, MÊME après validation (c'est du suivi, pas une modification du compte rendu). */
router.put('/:id/actions/:aid/status', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  const a = await db.prepare('SELECT * FROM mtg_actions WHERE id = ? AND meeting_id = ?').get(A.id(req.params.aid), m.id);
  if (!a) throw new HttpError(404, 'Action introuvable.');
  if (!ctx.draftVisible && m.minutes_status !== 'validated' && !(ctx.mine && Number(a.assignee_id) === req.user.id)) throw new HttpError(404, 'Action introuvable.');
  if (!(ctx.write || ctx.validate || Number(a.assignee_id) === req.user.id)) throw new HttpError(403, "Seule la personne responsable ou l'équipe de la réunion change le statut d'une action.");
  if (!a.task_id && m.minutes_status !== 'validated') throw new HttpError(409, "L'action pourra être suivie une fois le compte rendu validé.");
  const status = A.oneOf((req.body || {}).status, ['open', 'done', 'cancelled'], undefined, 'Statut invalide.');
  await db.transaction(async () => {
    await db.prepare('UPDATE mtg_actions SET status = ? WHERE id = ?').run(status, a.id);
    if (a.task_id && status !== 'cancelled') {
      const t = await db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(a.task_id, req.org.id);
      if (t) {
        const ts = status === 'done' ? 'done' : t.status === 'done' ? 'todo' : t.status;
        await db.prepare('UPDATE tasks SET status = ?, done_at = ? WHERE id = ?').run(ts, ts === 'done' ? (t.done_at || nowISO().slice(0, 10)) : null, t.id);
        if (t.project_id && ts !== t.status) await require('./projects-w6').autoReplan(req.org.id, t.project_id).catch((e) => log.warn('Réunions : replanification :', oneLine(e.message, 100)));
      }
    }
    await M.mlog(req, m.id, 'action_status', `Action marquée « ${status === 'done' ? 'faite' : status === 'open' ? 'à faire' : 'annulée'} »`);
  })();
  res.json({ ok: true });
});

// ---------- Tâches de Projets : chaque action décidée devient une tâche assignée ----------
/** Crée (ou met à jour) la tâche de chaque action du compte rendu validé. Idempotent : une action n'a jamais deux tâches. */
async function syncTasks(req, m) {
  const proj = m.project_id ? await db.prepare('SELECT id, branch_id FROM projects WHERE id = ? AND org_id = ?').get(m.project_id, req.org.id) : null;
  const rows = await db.prepare("SELECT * FROM mtg_actions WHERE meeting_id = ? AND status <> 'cancelled' ORDER BY position, id").all(m.id);
  const created = []; let updated = 0;
  for (const a of rows) {
    const title = oneLine(a.text, 160);
    const desc = A.text(`Action décidée en réunion « ${m.title} » du ${M.dateFr(m.date)}.${a.assignee_name ? `\nResponsable : ${a.assignee_name}` : ''}${a.text.length > 160 ? `\n\n${a.text}` : ''}`, 1000);
    if (a.task_id) {
      const t = await db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(a.task_id, req.org.id);
      if (t && t.status !== 'done') {
        await db.prepare('UPDATE tasks SET title = ?, description = ?, assignee_id = ?, due = ? WHERE id = ?').run(title, desc, a.assignee_id, a.due, t.id);
        updated++;
      }
      continue;
    }
    const tid = Number((await db.prepare('INSERT INTO tasks (org_id, project_id, branch_id, title, description, status, priority, assignee_id, due, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, proj ? proj.id : null, proj ? proj.branch_id : null, title, desc, 'todo', 'normal', a.assignee_id, a.due, req.user.id, nowISO())).lastInsertRowid);
    await db.prepare('UPDATE mtg_actions SET task_id = ?, status = ? WHERE id = ?').run(tid, 'open', a.id);
    created.push({ actionId: Number(a.id), taskId: tid, assigneeId: a.assignee_id, text: title });
  }
  return { created, updated };
}

// ---------- Compte rendu : soumettre, valider, renvoyer, nouvelle version ----------
async function validatorsOf(req, cfg, type) {
  const members = await db.prepare('SELECT user_id, role FROM org_members WHERE org_id = ?').all(req.org.id);
  const r = M.ruleFor(cfg, 'validate', type);
  return members.filter((x) => x.role === 'owner' || r.users.includes(Number(x.user_id)) || r.roles.includes(x.role)).map((x) => Number(x.user_id));
}

router.post('/:id/minutes/submit', async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m); M.needOpen(m);
  const snap = await snapshot(req, m, parts);
  if (emptyContent(snap)) throw new HttpError(400, 'Le compte rendu est vide : ajoutez un résumé, des notes, des décisions ou des actions.');
  const version = Number((await db.prepare('SELECT COALESCE(MAX(version), 0) v FROM mtg_minutes WHERE meeting_id = ?').get(m.id)).v) + 1;
  await db.transaction(async () => {
    await db.prepare("INSERT INTO mtg_minutes (org_id, meeting_id, version, status, content, submitted_by, submitted_at) VALUES (?, ?, ?, 'submitted', ?, ?, ?)").run(req.org.id, m.id, version, JSON.stringify(snap), req.user.id, nowISO());
    await db.prepare("UPDATE mtg_meetings SET minutes_status = 'submitted', minutes_version = ?, status = 'held', return_reason = '', updated_at = ? WHERE id = ?").run(version, nowISO(), m.id);
    await M.mlog(req, m.id, 'submitted', `Compte rendu soumis à validation (version ${version})`);
  })();
  const label = Number(m.confidential) ? 'une réunion confidentielle' : `« ${m.title} »`;
  for (const uid of await validatorsOf(req, cfg, m.type)) if (uid !== req.user.id) await M.notice(req.org.id, uid, 'meeting_validate', `Compte rendu à valider : ${label} du ${M.dateFr(m.date)}.`, `meeting:${m.id}`);
  await M.activity(req, m, `Compte rendu de « ${m.title} » soumis à validation`);
  res.json({ ok: true, version });
});

router.post('/:id/minutes/validate', decideLimit, async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  if (!ctx.validate) throw new HttpError(403, "Vous n'avez pas le droit de valider les comptes rendus de ce type de réunion. Le responsable du compte peut vous l'accorder.");
  if (m.minutes_status !== 'submitted') throw new HttpError(409, "Aucun compte rendu n'est en attente de validation.");
  const sub = await db.prepare("SELECT * FROM mtg_minutes WHERE meeting_id = ? AND status = 'submitted' ORDER BY version DESC LIMIT 1").get(m.id);
  if (cfg.distinct && Number(sub.submitted_by) === req.user.id) throw new HttpError(403, "Le compte rendu doit être validé par une autre personne que celle qui l'a soumis (réglage du responsable du compte).");
  const b = req.body || {};
  const result = await db.transaction(async () => {
    await db.prepare("UPDATE mtg_minutes SET status = 'superseded' WHERE meeting_id = ? AND status = 'validated'").run(m.id);
    await db.prepare("UPDATE mtg_minutes SET status = 'validated', decided_by = ?, decided_at = ?, reason = ? WHERE id = ?").run(req.user.id, nowISO(), A.text(b.comment, 300), sub.id);
    await db.prepare("UPDATE mtg_meetings SET minutes_status = 'validated', updated_at = ? WHERE id = ?").run(nowISO(), m.id);
    const tasks = await syncTasks(req, m);
    await M.mlog(req, m.id, 'validated', `Compte rendu validé (version ${sub.version}) ; ${tasks.created.length} tâche(s) créée(s)`);
    return tasks;
  })();
  for (const t of result.created) if (t.assigneeId && Number(t.assigneeId) !== req.user.id) await M.notice(req.org.id, t.assigneeId, 'meeting_action', `Une action vous est confiée : ${t.text}`, `task:${t.taskId}`);
  await M.activity(req, m, `Compte rendu de « ${m.title} » validé`);
  const diffusion = b.notify === false ? null : await diffuse(req, { ...m, minutes_status: 'validated' }, cfg, parts, Number(sub.version));
  res.json({ ok: true, version: Number(sub.version), tasks: result.created.length, tasksUpdated: result.updated, diffusion });
});

router.post('/:id/minutes/return', decideLimit, async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!ctx.validate) throw new HttpError(403, "Vous n'avez pas le droit de renvoyer les comptes rendus de ce type de réunion.");
  if (m.minutes_status !== 'submitted') throw new HttpError(409, "Aucun compte rendu n'est en attente de validation.");
  const reason = A.text((req.body || {}).reason, 500, { required: true, msg: 'Indiquez le motif du renvoi.' });
  const sub = await db.prepare("SELECT * FROM mtg_minutes WHERE meeting_id = ? AND status = 'submitted' ORDER BY version DESC LIMIT 1").get(m.id);
  await db.transaction(async () => {
    await db.prepare("UPDATE mtg_minutes SET status = 'returned', decided_by = ?, decided_at = ?, reason = ? WHERE id = ?").run(req.user.id, nowISO(), reason, sub.id);
    await db.prepare("UPDATE mtg_meetings SET minutes_status = 'draft', return_reason = ?, updated_at = ? WHERE id = ?").run(reason, nowISO(), m.id);
    await M.mlog(req, m.id, 'returned', `Compte rendu renvoyé (version ${sub.version})`);
  })();
  if (sub.submitted_by) await M.notice(req.org.id, sub.submitted_by, 'meeting', `Compte rendu renvoyé pour correction : ${Number(m.confidential) ? 'réunion confidentielle' : `« ${m.title} »`}. Motif : ${oneLine(reason, 140)}`, `meeting:${m.id}`);
  await M.activity(req, m, `Compte rendu de « ${m.title} » renvoyé pour correction`);
  res.json({ ok: true });
});

router.post('/:id/minutes/new-version', decideLimit, async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  if (!(ctx.validate || ctx.owner)) throw new HttpError(403, "Seule une personne autorisée à valider peut rouvrir un compte rendu validé.");
  if (m.minutes_status !== 'validated') throw new HttpError(409, "Le compte rendu n'est pas validé : il se modifie directement.");
  const reason = A.text((req.body || {}).reason, 500, { required: true, msg: 'Indiquez pourquoi vous rouvrez le compte rendu.' });
  await db.transaction(async () => {
    await db.prepare("UPDATE mtg_meetings SET minutes_status = 'draft', return_reason = '', updated_at = ? WHERE id = ?").run(nowISO(), m.id);
    await M.mlog(req, m.id, 'reopened', `Compte rendu rouvert (nouvelle version) : ${oneLine(reason, 200)}`);
  })();
  await M.activity(req, m, `Compte rendu de « ${m.title} » rouvert pour une nouvelle version`);
  res.json({ ok: true });
});

router.get('/:id/minutes/versions/:v', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  const row = await db.prepare('SELECT * FROM mtg_minutes WHERE meeting_id = ? AND version = ?').get(m.id, A.id(req.params.v));
  if (!row || (!ctx.draftVisible && !['validated', 'superseded'].includes(row.status))) throw new HttpError(404, 'Version introuvable.');
  res.json({ version: Number(row.version), status: row.status, reason: row.reason, submittedAt: row.submitted_at, decidedAt: row.decided_at, content: JSON.parse(row.content) });
});

// ---------- Diffusion du compte rendu validé ----------
function minutesText(c, version, org) {
  const L = [`Compte rendu validé (version ${version}) — ${c.meta.title}`, `${M.dateFr(c.meta.date)} à ${c.meta.time.replace(':', 'h')}${c.meta.place ? ` · ${c.meta.place}` : ''}`, ''];
  if (c.summary) L.push('Résumé', c.summary, '');
  if (c.decisions.length) L.push('Décisions', ...c.decisions.map((d, i) => `${i + 1}. ${d.text}`), '');
  if (c.actions.length) L.push('Actions', ...c.actions.map((a) => `- ${a.text}${a.assignee ? ` — ${a.assignee}` : ''}${a.due ? ` — pour le ${a.due}` : ''}`), '');
  if (c.nextMeeting) L.push(`Prochaine réunion : ${c.nextMeeting}`, '');
  L.push(`— ${org}`);
  return L.join('\n');
}
async function renderPdf(req, content, { version, status, decidedBy, decidedAt }) {
  const pdf = require('../services/pdf');
  const c = content;
  const blocks = [];
  blocks.push({ type: 'kv', rows: [['Type', M.TYPE_FR[c.meta.type] || ''], ['Date', `${pdf.dfr(c.meta.date)} · ${c.meta.time}–${c.meta.endTime}`], ['Lieu / lien', c.meta.place || c.meta.link || '—'], ['Organisateur', c.meta.organizer || '—'], ['Secrétaire de séance', c.meta.secretary || '—']] });
  if (c.meta.objective) blocks.push({ type: 'text', text: `Objet : ${c.meta.objective}` });
  const RESP = { pending: 'Sans réponse', present: 'Présent', absent: 'Absent', excused: 'Excusé' };
  blocks.push({ type: 'heading', text: 'Présences' });
  blocks.push({ type: 'table', cols: [{ key: 'n', label: 'Nom', width: 200 }, { key: 'r', label: 'Réponse', width: 90 }, { key: 'a', label: 'Présence réelle', width: 100 }, { key: 'm', label: 'Motif', width: 100 }],
    rows: c.attendance.map((p) => ({ n: p.name || '—', r: RESP[p.response] || '', a: p.attended === 'yes' ? 'Présent' : p.attended === 'no' ? 'Absent' : '—', m: p.reason || '' })) });
  if (c.summary) { blocks.push({ type: 'heading', text: 'Résumé' }); blocks.push({ type: 'text', text: c.summary }); }
  if (c.agenda.length) {
    blocks.push({ type: 'heading', text: 'Déroulé point par point' });
    c.agenda.forEach((a, i) => { blocks.push({ type: 'text', text: `${i + 1}. ${a.title}${a.owner ? ` (${a.owner})` : ''}` }); if (a.notes) blocks.push({ type: 'note', text: a.notes }); });
  }
  if (c.decisions.length) { blocks.push({ type: 'heading', text: 'Décisions' }); blocks.push({ type: 'table', cols: [{ key: 'n', label: '#', width: 30 }, { key: 't', label: 'Décision', width: 460 }], rows: c.decisions.map((d, i) => ({ n: String(i + 1), t: d.text })) }); }
  if (c.actions.length) { blocks.push({ type: 'heading', text: 'Actions' }); blocks.push({ type: 'table', cols: [{ key: 't', label: 'Action', width: 280 }, { key: 'r', label: 'Responsable', width: 110 }, { key: 'd', label: 'Échéance', width: 80 }], rows: c.actions.map((a) => ({ t: a.text, r: a.assignee || '—', d: a.due ? pdf.dfr(a.due) : '—' })) }); }
  if (c.nextMeeting) blocks.push({ type: 'text', text: `Prochaine réunion : ${c.nextMeeting}` });
  return await pdf.render({
    title: 'Compte rendu de réunion', subtitle: c.meta.title, org: req.org.name,
    meta: [['Version', String(version)], ['Statut', status === 'validated' ? `Validé le ${pdf.dfr(String(decidedAt).slice(0, 10))}${decidedBy ? ` par ${decidedBy}` : ''}` : 'BROUILLON — non validé']],
    blocks, footer: status === 'validated' ? 'Document validé' : 'Brouillon non validé',
  });
}
async function diffuse(req, m, cfg, parts, version) {
  const row = await db.prepare("SELECT * FROM mtg_minutes WHERE meeting_id = ? AND version = ?").get(m.id, version);
  const content = JSON.parse(row.content);
  const dec = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
  const pdfBuf = await renderPdf(req, content, { version, status: 'validated', decidedBy: dec && dec.name, decidedAt: row.decided_at });
  const ids = parts.filter((p) => p.user_id).map((p) => Number(p.user_id));
  const users = ids.length ? await db.prepare(`SELECT id, contact FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const uc = new Map(users.map((u) => [Number(u.id), u.contact]));
  const recipients = []; let notices = 0;
  for (const p of parts) {
    let email = p.user_id ? uc.get(Number(p.user_id)) : p.email;
    if (p.user_id && Number(p.user_id) !== req.user.id) { await M.notice(req.org.id, p.user_id, 'meeting_minutes', `Compte rendu validé : ${Number(m.confidential) ? 'réunion confidentielle' : `« ${m.title} »`} du ${M.dateFr(m.date)}.`, `meeting:${m.id}`); notices++; }
    if (isEmail(email) && !(Number(p.user_id) === req.user.id)) recipients.push({ email, name: p.uname || p.name });
  }
  const text = minutesText(content, version, req.org.name);
  const mailRes = await M.sendMany(req, m.id, recipients, () => ({ subject: `Compte rendu : ${m.title} — ${M.dateFr(m.date)}`, text, attachments: [{ filename: `compte-rendu-${m.id}-v${version}.pdf`, content: pdfBuf, contentType: 'application/pdf' }] }), 'minutes');
  await M.mlog(req, m.id, 'diffused', `Compte rendu diffusé : ${notices} notice(s), ${mailRes.sent} e-mail(s)`);
  return { notices, email: mailRes };
}

// ---------- Export PDF ----------
router.get('/:id/minutes.pdf', pdfLimit, async (req, res) => {
  const { m, ctx, parts } = await M.load(req, req.params.id);
  let content; let version; let status; let decidedBy = ''; let decidedAt = '';
  const wantDraft = req.query.draft === '1' && ctx.draftVisible;
  const ver = req.query.version ? A.id(req.query.version) : null;
  if (ver) {
    const row = await db.prepare('SELECT v.*, u.name AS dname FROM mtg_minutes v LEFT JOIN users u ON u.id = v.decided_by WHERE v.meeting_id = ? AND v.version = ?').get(m.id, ver);
    if (!row || (!ctx.draftVisible && !['validated', 'superseded'].includes(row.status))) throw new HttpError(404, 'Version introuvable.');
    content = JSON.parse(row.content); version = ver; status = ['validated', 'superseded'].includes(row.status) ? 'validated' : 'draft'; decidedBy = row.dname || ''; decidedAt = row.decided_at || '';
  } else if (!wantDraft && await officialRow(m.id)) {
    const row = await db.prepare('SELECT v.*, u.name AS dname FROM mtg_minutes v LEFT JOIN users u ON u.id = v.decided_by WHERE v.meeting_id = ? AND v.status = \'validated\' ORDER BY v.version DESC LIMIT 1').get(m.id);
    content = JSON.parse(row.content); version = Number(row.version); status = 'validated'; decidedBy = row.dname || ''; decidedAt = row.decided_at;
  } else {
    if (!ctx.draftVisible) throw new HttpError(409, "Le compte rendu n'est pas encore validé.");
    content = await snapshot(req, m, parts); version = Number(m.minutes_version) + (m.minutes_status === 'validated' ? 0 : 1) || 1; status = 'draft';
  }
  const buf = await renderPdf(req, content, { version, status, decidedBy, decidedAt });
  await M.mlog(req, m.id, 'pdf', status === 'validated' ? 'Compte rendu exporté en PDF' : 'Brouillon exporté en PDF');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="compte-rendu-${m.id}${status === 'validated' ? `-v${version}` : '-brouillon'}.pdf"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(buf);
});

module.exports = { router, contentFor, snapshot, liveContent, syncTasks, renderPdf, emptyContent, validatorsOf };
