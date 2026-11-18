'use strict';
// Réunions (3/4) : tableau de bord, suivi des actions, recherche dans l'historique, exports CSV, modèles d'ordre du jour.
// Toutes les requêtes appliquent la même visibilité que les fiches (réunions confidentielles réservées à leurs participants).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const M = require('./meetings-lib');
const W = require('./w3');
const { HttpError, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });

const likeEsc = (s) => s.replace(/[\\%_]/g, '\\$&');
/** Les actions « officielles » (celles qui ont une tâche) : jamais les actions d'un brouillon. */
const OPEN = "a.task_id IS NOT NULL AND a.status = 'open' AND (t.id IS NULL OR t.status <> 'done')";

router.get('/dashboard', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const vis = M.visibleSql(req, cfg);
  const { month, from, to } = A.monthRange(req.query.month);
  const today = M.today();
  const base = [req.org.id];
  const byStatus = await db.prepare(`SELECT m.status, COUNT(*) c FROM mtg_meetings m WHERE m.org_id = ? AND m.date >= ? AND m.date < ?${vis.sql} GROUP BY m.status`).all(...base, from, to, ...vis.args);
  const byType = await db.prepare(`SELECT m.type, COUNT(*) c FROM mtg_meetings m WHERE m.org_id = ? AND m.date >= ? AND m.date < ? AND m.status <> 'cancelled'${vis.sql} GROUP BY m.type`).all(...base, from, to, ...vis.args);
  const st = { planned: 0, held: 0, cancelled: 0 };
  for (const r of byStatus) st[r.status] = Number(r.c);

  const att = async (f, t) => {
    const r = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.attended = 'yes' THEN 1 ELSE 0 END), 0) y, COALESCE(SUM(CASE WHEN p.attended = 'no' THEN 1 ELSE 0 END), 0) n
      FROM mtg_participants p JOIN mtg_meetings m ON m.id = p.meeting_id WHERE m.org_id = ? AND m.status = 'held' AND m.date >= ? AND m.date < ? AND p.required = 1${vis.sql}`).get(...base, f, t, ...vis.args);
    const y = Number(r.y); const n = Number(r.n);
    return y + n ? Math.round((y / (y + n)) * 100) : null;
  };
  const trend = [];
  const [yy, mm] = month.split('-').map(Number);
  for (let i = 5; i >= 0; i--) {
    const idx = (mm - 1) - i; const y = yy + Math.floor(idx / 12); const mo = ((idx % 12) + 12) % 12;
    const f = `${y}-${String(mo + 1).padStart(2, '0')}-01`; const nxt = mo === 11 ? `${y + 1}-01-01` : `${y}-${String(mo + 2).padStart(2, '0')}-01`;
    const c = await db.prepare(`SELECT COUNT(*) c FROM mtg_meetings m WHERE m.org_id = ? AND m.date >= ? AND m.date < ? AND m.status <> 'cancelled'${vis.sql}`).get(...base, f, nxt, ...vis.args);
    trend.push({ month: f.slice(0, 7), meetings: Number(c.c), attendance: await att(f, nxt) });
  }

  const act = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN a.due IS NOT NULL AND a.due < ? THEN 1 ELSE 0 END), 0) AS late
    FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id LEFT JOIN tasks t ON t.id = a.task_id WHERE m.org_id = ? AND ${OPEN}${vis.sql}`).get(today, ...base, ...vis.args);
  const doneAct = await db.prepare(`SELECT COUNT(*) c FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id LEFT JOIN tasks t ON t.id = a.task_id WHERE m.org_id = ? AND a.task_id IS NOT NULL AND (a.status = 'done' OR t.status = 'done')${vis.sql}`).get(...base, ...vis.args);

  const vTypes = M.allowedTypes(req, cfg, 'validate');
  let pending = []; 
  if (vTypes.length) {
    pending = await db.prepare(`SELECT m.id, m.title, m.date, m.type, v.submitted_at, u.name AS submitted_by FROM mtg_meetings m
      JOIN mtg_minutes v ON v.meeting_id = m.id AND v.status = 'submitted' LEFT JOIN users u ON u.id = v.submitted_by
      WHERE m.org_id = ? AND m.minutes_status = 'submitted' AND m.type IN (${vTypes.map(() => '?').join(',')})${vis.sql} ORDER BY v.submitted_at LIMIT 20`).all(...base, ...vTypes, ...vis.args);
  }
  const upcoming = await db.prepare(`SELECT m.id, m.title, m.date, m.start_time, m.type, p.response FROM mtg_meetings m JOIN mtg_participants p ON p.meeting_id = m.id AND p.user_id = ?
    WHERE m.org_id = ? AND m.status = 'planned' AND m.date >= ?${vis.sql} ORDER BY m.date, m.start_time LIMIT 6`).all(req.user.id, ...base, today, ...vis.args);
  const mine = await db.prepare(`SELECT a.id, a.text, a.due, a.meeting_id, m.title AS meeting_title FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id LEFT JOIN tasks t ON t.id = a.task_id
    WHERE m.org_id = ? AND a.assignee_id = ? AND ${OPEN} ORDER BY a.due IS NULL, a.due LIMIT 10`).all(...base, req.user.id);
  const toAnswer = Number((await db.prepare("SELECT COUNT(*) c FROM mtg_participants p JOIN mtg_meetings m ON m.id = p.meeting_id WHERE m.org_id = ? AND p.user_id = ? AND p.response = 'pending' AND m.status = 'planned' AND m.date >= ?").get(...base, req.user.id, today)).c);
  res.json({
    month, meetings: { total: st.planned + st.held + st.cancelled, ...st }, byType: byType.map((r) => ({ type: r.type, count: Number(r.c) })),
    attendanceRate: await att(from, to), trend,
    actions: { open: Number(act.total), late: Number(act.late), done: Number(doneAct.c) },
    pending: pending.map((p) => ({ id: Number(p.id), title: p.title, date: p.date, type: p.type, submittedAt: p.submitted_at, submittedBy: p.submitted_by || '' })),
    upcoming: upcoming.map((u) => ({ id: Number(u.id), title: u.title, date: u.date, time: u.start_time, type: u.type, response: u.response })),
    myActions: mine.map((a) => ({ id: Number(a.id), text: a.text, due: a.due, overdue: Boolean(a.due) && a.due < today, meetingId: Number(a.meeting_id), meetingTitle: a.meeting_title })),
    toAnswer, canValidate: vTypes.length > 0, canConvene: M.allowedTypes(req, cfg, 'convene').length > 0,
  });
});

// ---------- Suivi des actions (toutes réunions) ----------
async function listActions(req) {
  const cfg = await M.getConfig(req.org.id);
  const vis = M.visibleSql(req, cfg);
  const q = req.query; const today = M.today();
  const where = ['m.org_id = ?', 'a.task_id IS NOT NULL']; const args = [req.org.id];
  if (q.mine) { where.push('a.assignee_id = ?'); args.push(req.user.id); }
  if (q.meeting) { where.push('a.meeting_id = ?'); args.push(A.id(q.meeting)); }
  const status = q.status ? A.oneOf(q.status, ['open', 'overdue', 'done', 'cancelled'], undefined, 'Statut inconnu.') : null;
  if (status === 'open') where.push("a.status = 'open' AND (t.id IS NULL OR t.status <> 'done')");
  if (status === 'overdue') { where.push("a.status = 'open' AND (t.id IS NULL OR t.status <> 'done') AND a.due IS NOT NULL AND a.due < ?"); args.push(today); }
  if (status === 'done') where.push("a.status <> 'cancelled' AND (a.status = 'done' OR t.status = 'done')");
  if (status === 'cancelled') where.push("a.status = 'cancelled'");
  const rows = await db.prepare(`SELECT a.*, t.status AS task_status, t.due AS task_due, u.name AS uname, m.title AS meeting_title, m.date AS meeting_date
    FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN users u ON u.id = a.assignee_id
    WHERE ${where.join(' AND ')}${vis.sql} ORDER BY a.due IS NULL, a.due, a.id LIMIT 500`).all(...args, ...vis.args);
  return rows.map(M.actionView);
}
router.get('/actions', async (req, res) => res.json({ actions: await listActions(req) }));
router.get('/actions.csv', async (req, res) => {
  const L = { open: 'À faire', done: 'Faite', cancelled: 'Annulée' };
  W.sendCsv(res, 'actions-reunions.csv', ['Réunion', 'Date de la réunion', 'Action', 'Responsable', 'Échéance', 'Statut', 'En retard'],
    (await listActions(req)).map((a) => [a.meetingTitle, a.meetingDate, a.text, a.assignee, a.due || '', L[a.status] || a.status, a.overdue ? 'oui' : 'non']));
});

// ---------- Recherche dans l'historique ----------
router.get('/search', async (req, res) => {
  const q = A.text(req.query.q, 100);
  if (q.length < 2) throw new HttpError(400, 'Tapez au moins 2 caractères.');
  const cfg = await M.getConfig(req.org.id);
  const vis = M.visibleSql(req, cfg);
  const like = `%${likeEsc(q)}%`;
  const owner = req.member.role === 'owner';
  const uid = req.user.id;
  const wTypes = M.TYPES.filter((t) => M.allowed(req, cfg, 'convene', t) || M.allowed(req, cfg, 'validate', t));
  const peek = owner ? '1 = 1' : `(m.organizer_id = ? OR m.created_by = ? OR m.secretary_id = ?${wTypes.length ? ` OR m.type IN (${wTypes.map(() => '?').join(',')})` : ''})`;
  const peekArgs = owner ? [] : [uid, uid, uid, ...wTypes];
  const E = "ESCAPE '\\'";
  const rows = await db.prepare(`SELECT m.id, m.title, m.date, m.type, m.status, m.minutes_status FROM mtg_meetings m WHERE m.org_id = ?${vis.sql} AND (
      m.title ILIKE ? ${E} OR m.objective ILIKE ? ${E} OR m.place ILIKE ? ${E}
      OR ((m.minutes_status = 'validated' OR ${peek}) AND (m.summary ILIKE ? ${E}
        OR EXISTS (SELECT 1 FROM mtg_agenda g WHERE g.meeting_id = m.id AND (g.title ILIKE ? ${E} OR g.notes ILIKE ? ${E}))
        OR EXISTS (SELECT 1 FROM mtg_decisions d WHERE d.meeting_id = m.id AND d.text ILIKE ? ${E})
        OR EXISTS (SELECT 1 FROM mtg_actions a WHERE a.meeting_id = m.id AND a.text ILIKE ? ${E}))))
    ORDER BY m.date DESC, m.id DESC LIMIT 50`).all(req.org.id, ...vis.args, like, like, like, ...peekArgs, like, like, like, like, like);
  const low = q.toLowerCase();
  const out = [];
  for (const m of rows) {
    const canText = m.minutes_status === 'validated' || owner || (await db.prepare(`SELECT 1 FROM mtg_meetings m WHERE m.id = ? AND ${peek}`).get(m.id, ...peekArgs));
    let snippet = '';
    if (canText) {
      const texts = [
        ...(await db.prepare('SELECT text FROM mtg_decisions WHERE meeting_id = ?').all(m.id)).map((r) => ['decision', r.text]),
        ...(await db.prepare('SELECT text FROM mtg_actions WHERE meeting_id = ?').all(m.id)).map((r) => ['action', r.text]),
        ...(await db.prepare('SELECT notes FROM mtg_agenda WHERE meeting_id = ?').all(m.id)).map((r) => ['notes', r.notes]),
        ['summary', (await db.prepare('SELECT summary FROM mtg_meetings WHERE id = ?').get(m.id)).summary],
      ];
      const hit = texts.find(([, t]) => t && String(t).toLowerCase().includes(low));
      if (hit) { const i = String(hit[1]).toLowerCase().indexOf(low); snippet = oneLine(String(hit[1]).slice(Math.max(0, i - 40), i + 100), 150); }
    }
    out.push({ id: Number(m.id), title: m.title, date: m.date, type: m.type, status: m.status, minutesStatus: m.minutes_status, snippet });
  }
  res.json({ results: out });
});

// ---------- Export CSV des réunions ----------
router.get('/export.csv', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const vis = M.visibleSql(req, cfg);
  const where = ['m.org_id = ?']; const args = [req.org.id];
  if (req.query.from) { where.push('m.date >= ?'); args.push(A.date(req.query.from)); }
  if (req.query.to) { where.push('m.date <= ?'); args.push(A.date(req.query.to)); }
  if (req.query.type) { where.push('m.type = ?'); args.push(M.type(req.query.type)); }
  const rows = await db.prepare(`SELECT m.*, u.name AS organizer,
      (SELECT COUNT(*) FROM mtg_participants p WHERE p.meeting_id = m.id) AS n_parts,
      (SELECT COUNT(*) FROM mtg_participants p WHERE p.meeting_id = m.id AND p.attended = 'yes') AS n_yes
    FROM mtg_meetings m LEFT JOIN users u ON u.id = m.organizer_id WHERE ${where.join(' AND ')}${vis.sql} ORDER BY m.date, m.start_time LIMIT 5000`).all(...args, ...vis.args);
  const ST = { planned: 'Prévue', held: 'Tenue', cancelled: 'Annulée' };
  const MS = { none: 'Aucun', draft: 'Brouillon', submitted: 'À valider', validated: 'Validé' };
  W.sendCsv(res, 'reunions.csv', ['Date', 'Heure', 'Durée (min)', 'Titre', 'Type', 'Lieu ou lien', 'Organisateur', 'Statut', 'Compte rendu', 'Convoqués', 'Présents', 'Confidentielle'],
    rows.map((m) => [m.date, m.start_time, m.duration_min, m.title, M.TYPE_FR[m.type] || m.type, m.place || m.link, m.organizer || '', ST[m.status] || m.status, MS[m.minutes_status] || m.minutes_status, m.n_parts, m.n_yes, Number(m.confidential) ? 'oui' : 'non']));
});

// ---------- Modèles d'ordre du jour (les modèles intégrés sont dans l'application ; ici, ceux de l'organisation) ----------
function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Ajoutez au moins un point au modèle.');
  if (items.length > 40) throw new HttpError(400, "Pas plus de 40 points par modèle.");
  return items.map((i) => ({ title: A.text(i && i.title, 200, { required: true, msg: 'Chaque point doit avoir un titre.' }), durationMin: i.durationMin === undefined || i.durationMin === '' || i.durationMin === null ? 0 : M.wholeNumber(i.durationMin, 0, 600, 'Durée d’un point invalide (0 à 600 minutes).') }));
}
const tplRow = (t) => ({ id: Number(t.id), name: t.name, type: t.type, durationMin: Number(t.duration_min), items: JSON.parse(t.items) });
router.get('/templates', async (req, res) => res.json({ templates: (await db.prepare('SELECT * FROM mtg_templates WHERE org_id = ? ORDER BY name').all(req.org.id)).map(tplRow) }));
async function needTplRight(req) {
  const cfg = await M.getConfig(req.org.id);
  if (!M.allowedTypes(req, cfg, 'convene').length) throw new HttpError(403, "Vous n'avez pas le droit de convoquer des réunions, donc de gérer les modèles.");
}
router.post('/templates', async (req, res) => {
  await needTplRight(req);
  const b = req.body || {};
  if (Number((await db.prepare('SELECT COUNT(*) c FROM mtg_templates WHERE org_id = ?').get(req.org.id)).c) >= 50) throw new HttpError(400, '50 modèles au maximum.');
  const id = (await db.prepare('INSERT INTO mtg_templates (org_id, name, type, duration_min, items, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du modèle.' }), M.type(b.type), M.duration(b.durationMin), JSON.stringify(cleanItems(b.items)), req.user.id, nowISO())).lastInsertRowid;
  await M.mlog(req, null, 'template', 'Modèle créé');
  res.status(201).json({ id: Number(id) });
});
router.put('/templates/:id', async (req, res) => {
  await needTplRight(req);
  const t = await db.prepare('SELECT * FROM mtg_templates WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t) throw new HttpError(404, 'Modèle introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE mtg_templates SET name = ?, type = ?, duration_min = ?, items = ? WHERE id = ?').run(b.name === undefined ? t.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du modèle.' }),
    b.type === undefined ? t.type : M.type(b.type), b.durationMin === undefined ? Number(t.duration_min) : M.duration(b.durationMin), b.items === undefined ? t.items : JSON.stringify(cleanItems(b.items)), t.id);
  res.json({ ok: true });
});
router.delete('/templates/:id', async (req, res) => {
  await needTplRight(req);
  const r = await db.prepare('DELETE FROM mtg_templates WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Modèle introuvable.');
  res.json({ ok: true });
});

// Rappels : lancés automatiquement ; le propriétaire peut les déclencher à la main pour son organisation.
router.post('/reminders/run', A.need('owner'), async (req, res) => res.json(await require('./meetings-jobs').runForOrg(req.org.id)));

module.exports = { router };
