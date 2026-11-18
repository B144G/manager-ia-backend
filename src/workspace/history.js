'use strict';
// Histoire de l'entreprise : organigramme dans le temps (personnes), frise d'événements (moments forts / moments durs), rencontres, médias.
// - Lecture : tout membre de l'organisation. Saisie : le rôle minimum désigné par le propriétaire/administrateur (réglage) + des personnes désignées une à une.
// - Vie privée : un événement ou un média « direction seulement » n'est visible que des administrateurs (et de son auteur) ; un média qui montre des personnes
//   n'est visible des autres membres que si le consentement a été recueilli. Rien n'est publié hors du compte : tout passe par des routes authentifiées.
// - Traçabilité : chaque création / modification / suppression est inscrite au journal d'audit (entités « history_* »), lisible par la direction.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const C = require('./library-core');
const X = require('./legal-extra');
const PDF = require('../services/pdf');
const limits = require('../middleware/limits');
const { HttpError, parseJSON } = require('../util');

const router = express.Router({ mergeParams: true });

const CATEGORIES = ['creation', 'recruitment', 'contract', 'award', 'launch', 'meeting', 'move', 'training', 'crisis', 'loss', 'dispute', 'incident', 'financial', 'departure', 'other'];
const CATEGORY_LABEL = { creation: 'Création', recruitment: 'Recrutement', contract: 'Contrat', award: 'Récompense', launch: 'Lancement', meeting: 'Rencontre / partenariat', move: 'Déménagement', training: 'Formation', crisis: 'Crise', loss: 'Perte', dispute: 'Litige', incident: 'Incident', financial: 'Difficulté financière', departure: 'Départ', other: 'Autre' };
const NATURES = ['good', 'bad'];
const NATURE_LABEL = { good: 'Moment fort', bad: 'Moment dur' };
const VISIBILITIES = ['internal', 'direction'];
const VIS_LABEL = { internal: 'Toute l’entreprise', direction: 'Direction seulement' };
const EDIT_ROLES = ['member', 'manager', 'admin', 'owner'];
const MAX_EVENTS = 3000;
const MAX_PEOPLE = 1000;
const MAX_MEDIA = 2000;
const MB = 1024 * 1024;
const IMAGE_MAX = 8 * MB;
const VIDEO_MAX = 20 * MB;
const QUOTA = (Number(process.env.HISTORY_QUOTA_MB) > 0 ? Number(process.env.HISTORY_QUOTA_MB) : 200) * MB;
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm']);
const upLimit = limits.make(10 * 60 * 1000, 60, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");
const dlLimit = limits.make(10 * 60 * 1000, 600, 'Trop de téléchargements. Réessayez dans quelques minutes.');

// ---------- Droits ----------
async function cfg(orgId) {
  const r = await db.prepare('SELECT * FROM history_settings WHERE org_id = ?').get(orgId);
  const ids = r ? parseJSON(r.editor_ids, []) : [];
  return { editMin: r && EDIT_ROLES.includes(r.edit_min_role) ? r.edit_min_role : 'manager', editors: (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger) };
}
const isDirection = (req) => A.can(req, 'admin');
async function canEdit(req) {
  if (A.can(req, 'owner')) return true;
  const c = await cfg(req.org.id);
  return A.RANK[req.member.role] >= A.RANK[c.editMin] || c.editors.includes(Number(req.user.id));
}
const needEdit = async (req, res, next) => {
  if (!await canEdit(req)) throw new HttpError(403, "Votre rôle ne permet pas de modifier l'histoire de l'entreprise. Demandez au responsable du compte de vous y autoriser.");
  next();
};
const needDirection = A.need('admin');
const yearOf = (d) => Number(String(d || '').slice(0, 4));
const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';

function dateIn(v, label, { required = false } = {}) {
  const d = A.date(v);
  if (!d) { if (required) throw new HttpError(400, `${label} : indiquez une date (AAAA-MM-JJ).`); return null; }
  const y = yearOf(d);
  if (y < 1800 || y > new Date().getUTCFullYear() + 1) throw new HttpError(400, `${label} : l'année doit être comprise entre 1800 et l'an prochain.`);
  return d;
}

// ---------- Réglages ----------
router.get('/settings', async (req, res) => {
  const c = await cfg(req.org.id);
  const out = { canEdit: await canEdit(req), direction: isDirection(req), roles: EDIT_ROLES.filter((r) => r !== 'owner'), categories: CATEGORIES.map((id) => ({ id, label: CATEGORY_LABEL[id] })) };
  if (isDirection(req)) {
    const members = await db.prepare('SELECT m.user_id, m.role, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name').all(req.org.id);
    Object.assign(out, { editMinRole: c.editMin, editorIds: c.editors, members: members.map((m) => ({ userId: Number(m.user_id), name: m.name, role: m.role })) });
  }
  res.json(out);
});
router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const before = await cfg(req.org.id);
  const min = b.editMinRole === undefined ? before.editMin : A.oneOf(b.editMinRole, ['member', 'manager', 'admin'], undefined, 'Rôle inconnu (member, manager ou admin).');
  let ids = before.editors;
  if (b.editorIds !== undefined) {
    if (!Array.isArray(b.editorIds) || b.editorIds.length > 50) throw new HttpError(400, 'Liste de personnes invalide (50 au plus).');
    ids = [...new Set(b.editorIds.map((x) => A.id(x, 'Personne invalide.')))];
    for (const id of ids) if (!await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, id)) throw new HttpError(400, "Une personne désignée ne fait pas partie de l'organisation.");
  }
  await db.prepare('INSERT INTO history_settings (org_id, edit_min_role, editor_ids, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET edit_min_role = EXCLUDED.edit_min_role, editor_ids = EXCLUDED.editor_ids, updated_at = EXCLUDED.updated_at')
    .run(req.org.id, min, JSON.stringify(ids), nowISO());
  await W.audit(req, 'history_settings', null, 'update', { editMinRole: before.editMin, editorIds: before.editors }, { editMinRole: min, editorIds: ids });
  res.json({ ok: true, editMinRole: min, editorIds: ids });
});

// ---------- Personnes ----------
const personView = (p, canSee) => ({
  id: Number(p.id), name: p.name, title: p.title, level: Number(p.level), parentId: p.parent_id == null ? null : Number(p.parent_id), employeeId: p.employee_id == null ? null : Number(p.employee_id),
  startDate: p.start_date, endDate: p.end_date, departureReason: p.departure_reason, bio: p.bio, photoId: p.photo_media_id && canSee(Number(p.photo_media_id)) ? Number(p.photo_media_id) : null,
});
/** Fonction « ce média est-il visible par cette personne ? » (précalculée pour la liste des photos de profil). */
async function mediaVisibility(req) {
  const dir = isDirection(req);
  const rows = await db.prepare('SELECT m.id, m.visibility, m.has_people, m.consent, m.created_by, e.visibility AS ev_vis, e.created_by AS ev_by FROM history_media m LEFT JOIN history_events e ON e.id = m.event_id WHERE m.org_id = ?').all(req.org.id);
  const ok = new Set();
  for (const m of rows) {
    if (dir) { ok.add(Number(m.id)); continue; }
    const mine = Number(m.created_by) === Number(req.user.id);
    if (m.visibility === 'direction' && !mine) continue;
    if (m.ev_vis === 'direction' && Number(m.ev_by) !== Number(req.user.id)) continue;
    if (Number(m.has_people) && !Number(m.consent) && !mine) continue;
    ok.add(Number(m.id));
  }
  return (id) => ok.has(id);
}

router.get('/people', async (req, res) => {
  const vis = await mediaVisibility(req);
  const rows = await db.prepare('SELECT * FROM history_people WHERE org_id = ? ORDER BY level, id').all(req.org.id);
  const years = rows.flatMap((p) => [yearOf(p.start_date), yearOf(p.end_date)]).filter((y) => y > 0);
  res.json({ people: rows.map((p) => personView(p, vis)), minYear: years.length ? Math.min(...years) : null, maxYear: new Date().getUTCFullYear() });
});

/** Organigramme tel qu'il était une année donnée : présents (actifs), partis cette année-là, et anciens (partis avant) grisés si demandé. */
router.get('/tree', async (req, res) => {
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  if (year < 1800 || year > 2200) throw new HttpError(400, 'Année invalide.');
  const former = req.query.former !== '0';
  const vis = await mediaVisibility(req);
  const rows = await db.prepare('SELECT * FROM history_people WHERE org_id = ? ORDER BY level, id').all(req.org.id);
  const out = [];
  for (const p of rows) {
    const s = yearOf(p.start_date); const e = yearOf(p.end_date);
    if (s && s > year) continue; // pas encore arrivé
    let state = 'active';
    if (e && e < year) state = 'former';
    else if (e && e === year) state = 'leaving';
    if (state === 'former' && !former) continue;
    out.push({ ...personView(p, vis), state });
  }
  res.json({ year, people: out, total: rows.length });
});

async function checkParent(req, parentId, selfId) {
  const pid = A.idOrNull(parentId, 'Supérieur invalide.');
  if (pid === null) return null;
  if (!await db.prepare('SELECT 1 FROM history_people WHERE id = ? AND org_id = ?').get(pid, req.org.id)) throw new HttpError(400, 'Supérieur inconnu.');
  for (let cur = pid, n = 0; cur && n < 100; n++) {
    if (selfId && cur === selfId) throw new HttpError(400, 'Une personne ne peut pas dépendre d’elle-même (ni de l’un de ses subordonnés).');
    cur = (await db.prepare('SELECT parent_id FROM history_people WHERE id = ?').get(cur) || {}).parent_id;
    if (cur != null) cur = Number(cur);
  }
  return pid;
}
async function employeeIn(req, v) {
  const id = A.idOrNull(v, 'Employé invalide.');
  if (id === null) return null;
  const e = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(id, req.org.id);
  if (!e || !A.visible(req, e)) throw new HttpError(400, 'Employé inconnu.');
  return id;
}
function periodCheck(start, end) {
  if (start && end && end < start) throw new HttpError(400, 'La date de départ ne peut pas précéder la date d’arrivée.');
}
const peopleFields = (b, p) => ({
  name: b.name === undefined ? p.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom de la personne.' }),
  title: b.title === undefined ? p.title : A.text(b.title, 100),
  level: b.level === undefined ? Number(p.level) : (() => { const n = Number(b.level); if (!Number.isInteger(n) || n < 0 || n > 9) throw new HttpError(400, 'Niveau invalide (0 à 9).'); return n; })(),
  bio: b.bio === undefined ? p.bio : A.text(b.bio, 2000),
  departure_reason: b.departureReason === undefined ? p.departure_reason : A.text(b.departureReason, 300),
});

router.post('/people', needEdit, async (req, res) => {
  const b = req.body || {};
  if (Number((await db.prepare('SELECT COUNT(*) c FROM history_people WHERE org_id = ?').get(req.org.id)).c) >= MAX_PEOPLE) throw new HttpError(403, `Limite de ${MAX_PEOPLE} personnes atteinte.`);
  const f = peopleFields(b, { name: '', title: '', level: 5, bio: '', departure_reason: '' });
  const start = dateIn(b.startDate, 'Arrivée'); const end = dateIn(b.endDate, 'Départ'); periodCheck(start, end);
  const parent = await checkParent(req, b.parentId, null); const emp = await employeeIn(req, b.employeeId);
  const id = Number((await db.prepare('INSERT INTO history_people (org_id, name, title, level, parent_id, employee_id, start_date, end_date, departure_reason, bio, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, f.name, f.title, f.level, parent, emp, start, end, f.departure_reason, f.bio, req.user.id, nowISO(), nowISO())).lastInsertRowid);
  await W.audit(req, 'history_person', id, 'create', null, { name: f.name, title: f.title, parent, startDate: start, endDate: end });
  res.status(201).json({ id });
});

router.put('/people/:id', needEdit, async (req, res) => {
  const p = await db.prepare('SELECT * FROM history_people WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Personne introuvable.');
  const b = req.body || {};
  const f = peopleFields(b, p);
  const start = b.startDate === undefined ? p.start_date : dateIn(b.startDate, 'Arrivée'); const end = b.endDate === undefined ? p.end_date : dateIn(b.endDate, 'Départ'); periodCheck(start, end);
  const parent = b.parentId === undefined ? p.parent_id : await checkParent(req, b.parentId, Number(p.id));
  const emp = b.employeeId === undefined ? p.employee_id : await employeeIn(req, b.employeeId);
  let photo = p.photo_media_id;
  if (b.photoId !== undefined) {
    photo = A.idOrNull(b.photoId, 'Photo invalide.');
    if (photo !== null && !await db.prepare("SELECT 1 FROM history_media WHERE id = ? AND org_id = ? AND kind = 'image'").get(photo, req.org.id)) throw new HttpError(400, 'Photo inconnue.');
  }
  await db.prepare('UPDATE history_people SET name = ?, title = ?, level = ?, parent_id = ?, employee_id = ?, start_date = ?, end_date = ?, departure_reason = ?, bio = ?, photo_media_id = ?, updated_at = ? WHERE id = ?')
    .run(f.name, f.title, f.level, parent, emp, start, end, f.departure_reason, f.bio, photo, nowISO(), p.id);
  await W.audit(req, 'history_person', p.id, 'update', { name: p.name, title: p.title, level: p.level, parent: p.parent_id, startDate: p.start_date, endDate: p.end_date }, { name: f.name, title: f.title, level: f.level, parent, startDate: start, endDate: end });
  res.json({ ok: true });
});

router.delete('/people/:id', needEdit, async (req, res) => {
  const p = await db.prepare('SELECT * FROM history_people WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Personne introuvable.');
  await db.transaction(async () => { // les subordonnés remontent d'un cran
    await db.prepare('UPDATE history_people SET parent_id = ? WHERE parent_id = ? AND org_id = ?').run(p.parent_id, p.id, req.org.id);
    await db.prepare('DELETE FROM history_people WHERE id = ?').run(p.id);
  })();
  await W.audit(req, 'history_person', p.id, 'delete', { name: p.name, title: p.title, startDate: p.start_date, endDate: p.end_date }, null);
  res.json({ ok: true });
});

/** Employés du module RH pas encore reliés à l'organigramme (pour les importer d'un coup). */
router.get('/employees', needEdit, async (req, res) => {
  const sc = A.scope(req);
  const rows = await db.prepare(`SELECT id, name, job, hired_at, status FROM employees WHERE org_id = ?${sc.sql} AND id NOT IN (SELECT employee_id FROM history_people WHERE org_id = ? AND employee_id IS NOT NULL) ORDER BY name`).all(req.org.id, ...sc.args, req.org.id);
  res.json({ employees: rows.map((e) => ({ id: Number(e.id), name: e.name, job: e.job, hiredAt: e.hired_at, status: e.status })) });
});
router.post('/people/import-employees', needEdit, A.need('manager'), async (req, res) => {
  const sc = A.scope(req);
  const rows = await db.prepare(`SELECT * FROM employees WHERE org_id = ?${sc.sql} AND id NOT IN (SELECT employee_id FROM history_people WHERE org_id = ? AND employee_id IS NOT NULL) ORDER BY id`).all(req.org.id, ...sc.args, req.org.id);
  const have = Number((await db.prepare('SELECT COUNT(*) c FROM history_people WHERE org_id = ?').get(req.org.id)).c);
  if (have + rows.length > MAX_PEOPLE) throw new HttpError(403, `Limite de ${MAX_PEOPLE} personnes atteinte.`);
  const ids = [];
  await db.transaction(async () => {
    for (const e of rows) {
      const hired = /^\d{4}-\d{2}-\d{2}/.test(e.hired_at || '') ? String(e.hired_at).slice(0, 10) : null;
      ids.push(Number((await db.prepare('INSERT INTO history_people (org_id, name, title, level, employee_id, start_date, created_by, created_at, updated_at) VALUES (?, ?, ?, 5, ?, ?, ?, ?, ?)')
        .run(req.org.id, e.name, e.job || '', e.id, hired, req.user.id, nowISO(), nowISO())).lastInsertRowid));
    }
  })();
  await W.audit(req, 'history_person', null, 'import', null, { count: ids.length });
  res.status(201).json({ imported: ids.length });
});

// ---------- Événements ----------
async function visibleEventsSql(req) {
  const dir = isDirection(req);
  return { where: dir ? '' : " AND (e.visibility = 'internal' OR e.created_by = ?)", args: dir ? [] : [req.user.id] };
}
function guestsIn(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 30) throw new HttpError(400, 'Liste d’invités invalide (30 au plus).');
  return v.map((g) => ({ name: A.text(g && g.name, 100, { required: true, msg: 'Chaque invité doit avoir un nom.' }), org: A.text(g && g.org, 100), role: A.text(g && g.role, 100) }));
}
async function eventsOf(req, { year, nature, category, q, ids } = {}) {
  const v = await visibleEventsSql(req);
  const where = ['e.org_id = ?']; const args = [req.org.id];
  if (year) { where.push('e.event_date >= ? AND e.event_date <= ?'); args.push(`${year}-01-01`, `${year}-12-31`); }
  if (nature) { where.push('e.nature = ?'); args.push(nature); }
  if (category) { where.push('e.category = ?'); args.push(category); }
  if (q) { where.push("(LOWER(e.title) LIKE ? ESCAPE '\\' OR LOWER(e.description) LIKE ? ESCAPE '\\' OR LOWER(e.place) LIKE ? ESCAPE '\\')"); const l = C.likeEsc(q.toLowerCase()); args.push(l, l, l); }
  if (ids) { where.push(`e.id IN (${ids.map(() => '?').join(',') || 'NULL'})`); args.push(...ids); }
  const rows = await db.prepare(`SELECT e.* FROM history_events e WHERE ${where.join(' AND ')}${v.where} ORDER BY e.event_date, e.id LIMIT 3000`).all(...args, ...v.args);
  if (!rows.length) return [];
  const eids = rows.map((r) => Number(r.id));
  const ph = eids.map(() => '?').join(',');
  const links = await db.prepare(`SELECT l.event_id, p.id, p.name FROM history_event_people l JOIN history_people p ON p.id = l.person_id WHERE l.event_id IN (${ph}) ORDER BY p.name`).all(...eids);
  const byEv = new Map();
  for (const l of links) { if (!byEv.has(Number(l.event_id))) byEv.set(Number(l.event_id), []); byEv.get(Number(l.event_id)).push({ id: Number(l.id), name: l.name }); }
  const vis = await mediaVisibility(req);
  const media = (await db.prepare(`SELECT id, event_id, kind, name, caption FROM history_media WHERE event_id IN (${ph}) ORDER BY id`).all(...eids)).filter((m) => vis(Number(m.id)));
  const mByEv = new Map();
  for (const m of media) { if (!mByEv.has(Number(m.event_id))) mByEv.set(Number(m.event_id), []); mByEv.get(Number(m.event_id)).push({ id: Number(m.id), kind: m.kind, name: m.name, caption: m.caption }); }
  return rows.map((e) => ({
    id: Number(e.id), title: e.title, date: e.event_date, endDate: e.end_date, year: yearOf(e.event_date), place: e.place, description: e.description,
    category: e.category, categoryLabel: CATEGORY_LABEL[e.category] || e.category, nature: e.nature, natureLabel: NATURE_LABEL[e.nature],
    lesson: e.lesson, successFactors: e.success_factors, minutes: e.minutes, guests: parseJSON(e.guests, []), visibility: e.visibility,
    people: byEv.get(Number(e.id)) || [], media: mByEv.get(Number(e.id)) || [], createdAt: e.created_at,
  }));
}

router.get('/events', async (req, res) => {
  const year = req.query.year ? Number(req.query.year) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1800 || year > 2200)) throw new HttpError(400, 'Année invalide.');
  const nature = req.query.nature ? A.oneOf(req.query.nature, NATURES, undefined, 'Nature inconnue (good ou bad).') : null;
  const category = req.query.category ? A.oneOf(req.query.category, CATEGORIES, undefined, 'Catégorie inconnue.') : null;
  const q = String(req.query.q || '').trim().slice(0, 80);
  res.json({ events: await eventsOf(req, { year, nature, category, q }) });
});
router.get('/events/:id', async (req, res) => {
  const [e] = await eventsOf(req, { ids: [A.id(req.params.id)] });
  if (!e) throw new HttpError(404, 'Événement introuvable.');
  res.json({ event: e });
});

async function eventBody(req, b, cur) {
  const f = {
    title: b.title === undefined ? cur.title : A.text(b.title, 160, { required: true, msg: 'Indiquez le titre de l’événement.' }),
    event_date: b.date === undefined ? cur.event_date : dateIn(b.date, 'Date', { required: true }),
    end_date: b.endDate === undefined ? cur.end_date : dateIn(b.endDate, 'Date de fin'),
    place: b.place === undefined ? cur.place : A.text(b.place, 160),
    description: b.description === undefined ? cur.description : A.text(b.description, 4000),
    category: b.category === undefined ? cur.category : A.oneOf(b.category, CATEGORIES, undefined, 'Catégorie inconnue.'),
    nature: b.nature === undefined ? cur.nature : A.oneOf(b.nature, NATURES, undefined, 'Indiquez si c’est un moment fort (good) ou un moment dur (bad).'),
    lesson: b.lesson === undefined ? cur.lesson : A.text(b.lesson, 3000),
    success_factors: b.successFactors === undefined ? cur.success_factors : A.text(b.successFactors, 3000),
    minutes: b.minutes === undefined ? cur.minutes : A.text(b.minutes, 6000),
    visibility: b.visibility === undefined ? cur.visibility : A.oneOf(b.visibility, VISIBILITIES, undefined, 'Visibilité inconnue (internal ou direction).'),
  };
  const g = guestsIn(b.guests);
  f.guests = JSON.stringify(g === undefined ? parseJSON(cur.guests, []) : g);
  if (f.end_date && f.end_date < f.event_date) throw new HttpError(400, 'La date de fin ne peut pas précéder la date de début.');
  if (!f.event_date) throw new HttpError(400, 'Indiquez la date de l’événement.');
  return f;
}
async function peopleIn(req, v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 100) throw new HttpError(400, 'Liste de personnes invalide (100 au plus).');
  const ids = [...new Set(v.map((x) => A.id(x, 'Personne invalide.')))];
  for (const id of ids) if (!await db.prepare('SELECT 1 FROM history_people WHERE id = ? AND org_id = ?').get(id, req.org.id)) throw new HttpError(400, 'Une personne concernée est inconnue.');
  return ids;
}
async function setPeople(eventId, ids) {
  await db.prepare('DELETE FROM history_event_people WHERE event_id = ?').run(eventId);
  for (const pid of ids) await db.prepare('INSERT INTO history_event_people (event_id, person_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(eventId, pid);
}
const auditEvent = (e) => ({ title: e.title, date: e.event_date, nature: e.nature, category: e.category, visibility: e.visibility, place: e.place });

router.post('/events', needEdit, async (req, res) => {
  const b = req.body || {};
  if (Number((await db.prepare('SELECT COUNT(*) c FROM history_events WHERE org_id = ?').get(req.org.id)).c) >= MAX_EVENTS) throw new HttpError(403, `Limite de ${MAX_EVENTS} événements atteinte.`);
  const f = await eventBody(req, b, { title: '', event_date: null, end_date: null, place: '', description: '', category: 'other', nature: null, lesson: '', success_factors: '', minutes: '', guests: '[]', visibility: 'internal' });
  if (!f.nature) throw new HttpError(400, 'Indiquez si c’est un moment fort (good) ou un moment dur (bad).');
  const ids = await peopleIn(req, b.peopleIds);
  const id = await db.transaction(async () => {
    const eid = Number((await db.prepare('INSERT INTO history_events (org_id, title, event_date, end_date, place, description, category, nature, lesson, success_factors, minutes, guests, visibility, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, f.title, f.event_date, f.end_date, f.place, f.description, f.category, f.nature, f.lesson, f.success_factors, f.minutes, f.guests, f.visibility, req.user.id, nowISO(), nowISO())).lastInsertRowid);
    if (ids) await setPeople(eid, ids);
    return eid;
  })();
  await W.audit(req, 'history_event', id, 'create', null, auditEvent(f));
  await A.logActivity(req.org.id, req.user.id, 'history', `Histoire : ${f.title}`);
  res.status(201).json({ id });
});

router.put('/events/:id', needEdit, async (req, res) => {
  const cur = await db.prepare('SELECT * FROM history_events WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!cur || (!isDirection(req) && cur.visibility === 'direction' && Number(cur.created_by) !== Number(req.user.id))) throw new HttpError(404, 'Événement introuvable.');
  const b = req.body || {};
  const f = await eventBody(req, b, cur);
  const ids = await peopleIn(req, b.peopleIds);
  await db.transaction(async () => {
    await db.prepare('UPDATE history_events SET title = ?, event_date = ?, end_date = ?, place = ?, description = ?, category = ?, nature = ?, lesson = ?, success_factors = ?, minutes = ?, guests = ?, visibility = ?, updated_at = ? WHERE id = ?')
      .run(f.title, f.event_date, f.end_date, f.place, f.description, f.category, f.nature, f.lesson, f.success_factors, f.minutes, f.guests, f.visibility, nowISO(), cur.id);
    if (ids) await setPeople(cur.id, ids);
  })();
  await W.audit(req, 'history_event', cur.id, 'update', auditEvent(cur), auditEvent(f));
  res.json({ ok: true });
});

router.delete('/events/:id', needEdit, async (req, res) => {
  const cur = await db.prepare('SELECT * FROM history_events WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!cur || (!isDirection(req) && cur.visibility === 'direction' && Number(cur.created_by) !== Number(req.user.id))) throw new HttpError(404, 'Événement introuvable.');
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM history_media WHERE event_id = ?').get(cur.id)).c);
  await db.prepare('DELETE FROM history_events WHERE id = ?').run(cur.id);
  await W.audit(req, 'history_event', cur.id, 'delete', { ...auditEvent(cur), mediaDeleted: n }, null);
  res.json({ ok: true });
});

// ---------- Statistiques ----------
router.get('/stats', async (req, res) => {
  const events = await eventsOf(req);
  const byYear = new Map(); const byCat = new Map();
  for (const e of events) {
    const y = byYear.get(e.year) || { year: e.year, good: 0, bad: 0 }; y[e.nature]++; byYear.set(e.year, y);
    const c = byCat.get(e.category) || { category: e.category, label: e.categoryLabel, good: 0, bad: 0 }; c[e.nature]++; byCat.set(e.category, c);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const series = []; let acc = 0;
  if (years.length) for (let y = years[0]; y <= Math.max(years[years.length - 1], new Date().getUTCFullYear()); y++) {
    const r = byYear.get(y) || { year: y, good: 0, bad: 0 };
    acc += r.good - r.bad;
    series.push({ year: y, good: r.good, bad: r.bad, net: r.good - r.bad, trajectory: acc });
  }
  const people = await db.prepare('SELECT start_date, end_date FROM history_people WHERE org_id = ?').all(req.org.id);
  const headcount = series.map((s) => ({ year: s.year, count: people.filter((p) => (!yearOf(p.start_date) || yearOf(p.start_date) <= s.year) && (!yearOf(p.end_date) || yearOf(p.end_date) >= s.year)).length }));
  const good = events.filter((e) => e.nature === 'good').length;
  res.json({ total: events.length, good, bad: events.length - good, firstYear: years[0] || null, series, headcount, byCategory: [...byCat.values()].sort((a, b) => b.good + b.bad - a.good - a.bad) });
});

// ---------- Médias ----------
const rawBody = express.raw({ type: () => true, limit: `${Math.ceil(VIDEO_MAX / MB) + 1}mb` });
const earlySize = (req, res, next) => {
  if (Number(req.get('content-length') || 0) > VIDEO_MAX + 1024) throw new HttpError(413, 'Fichier trop lourd (20 Mo au plus pour une vidéo, 8 Mo pour une image).');
  next();
};
const mediaView = (m) => ({ id: Number(m.id), eventId: m.event_id == null ? null : Number(m.event_id), personId: m.person_id == null ? null : Number(m.person_id), name: m.name, mime: m.mime, kind: m.kind, size: Number(m.size), caption: m.caption,
  takenOn: m.taken_on, year: yearOf(m.taken_on || m.event_date || m.created_at), visibility: m.visibility, hasPeople: Number(m.has_people) === 1, consent: Number(m.consent) === 1, createdAt: m.created_at });

router.post('/media', upLimit, needEdit, earlySize, rawBody, async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const f = C.checkUpload(buf, req.query.name);
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const kind = f.mime.startsWith('image/') ? 'image' : (f.mime.startsWith('video/') && VIDEO_EXT.has(ext) ? 'video' : null);
  if (!kind) throw new HttpError(400, 'Seules les images (JPEG, PNG, WebP, GIF) et les vidéos (MP4, WebM, MOV) sont acceptées ici.');
  if (kind === 'image' && buf.length > IMAGE_MAX) throw new HttpError(413, 'Image trop lourde (8 Mo au plus).');
  if (kind === 'video' && buf.length > VIDEO_MAX) throw new HttpError(413, 'Vidéo trop lourde (20 Mo au plus).');
  const q = req.query;
  const eventId = A.idOrNull(q.eventId, 'Événement invalide.'); const personId = A.idOrNull(q.personId, 'Personne invalide.');
  if (eventId) { const e = await db.prepare('SELECT * FROM history_events WHERE id = ? AND org_id = ?').get(eventId, req.org.id); if (!e || (!isDirection(req) && e.visibility === 'direction' && Number(e.created_by) !== Number(req.user.id))) throw new HttpError(404, 'Événement introuvable.'); }
  if (personId && !await db.prepare('SELECT 1 FROM history_people WHERE id = ? AND org_id = ?').get(personId, req.org.id)) throw new HttpError(404, 'Personne introuvable.');
  const vis = q.visibility ? A.oneOf(String(q.visibility), VISIBILITIES, undefined, 'Visibilité inconnue.') : 'internal';
  const hasPeople = toBool(q.hasPeople) || !!personId; const consent = toBool(q.consent);
  const caption = A.text(q.caption, 300); const taken = dateIn(q.takenOn, 'Date de prise de vue');
  let id;
  await db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(?)').get(7270300000 + Number(req.org.id));
    const used = await db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM history_media WHERE org_id = ?').get(req.org.id);
    if (Number(used.c) >= MAX_MEDIA) throw new HttpError(403, `Limite de ${MAX_MEDIA} médias atteinte.`);
    if (Number(used.s) + buf.length > QUOTA) throw new HttpError(403, `Espace des médias plein (${Math.round(QUOTA / MB)} Mo) : supprimez des médias pour en ajouter.`);
    id = Number((await db.prepare('INSERT INTO history_media (org_id, event_id, person_id, name, mime, kind, size, caption, taken_on, visibility, has_people, consent, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, eventId, personId, f.name, f.mime, kind, buf.length, caption, taken, vis, hasPeople ? 1 : 0, consent ? 1 : 0, X.seal(buf), req.user.id, nowISO())).lastInsertRowid);
    if (personId && toBool(q.avatar) && kind === 'image') await db.prepare('UPDATE history_people SET photo_media_id = ? WHERE id = ?').run(id, personId);
  })();
  await W.audit(req, 'history_media', id, 'create', null, { name: f.name, kind, size: buf.length, eventId, personId, visibility: vis, hasPeople, consent });
  res.status(201).json({ id, kind, name: f.name, size: buf.length });
});

router.get('/media', async (req, res) => {
  const vis = await mediaVisibility(req);
  const where = ['m.org_id = ?']; const args = [req.org.id];
  if (req.query.eventId) { where.push('m.event_id = ?'); args.push(A.id(req.query.eventId)); }
  if (req.query.personId) { where.push('m.person_id = ?'); args.push(A.id(req.query.personId)); }
  const rows = await db.prepare(`SELECT m.id, m.event_id, m.person_id, m.name, m.mime, m.kind, m.size, m.caption, m.taken_on, m.visibility, m.has_people, m.consent, m.created_at, e.event_date FROM history_media m LEFT JOIN history_events e ON e.id = m.event_id WHERE ${where.join(' AND ')} ORDER BY COALESCE(m.taken_on, e.event_date, m.created_at) DESC, m.id DESC LIMIT 1000`).all(...args);
  let list = rows.filter((m) => vis(Number(m.id))).map(mediaView);
  if (req.query.year) list = list.filter((m) => m.year === Number(req.query.year));
  res.json({ media: list });
});

async function loadMedia(req, id, { full = false } = {}) {
  const m = await db.prepare(`SELECT ${full ? 'm.*' : 'm.id, m.event_id, m.person_id, m.name, m.mime, m.kind, m.size, m.caption, m.taken_on, m.visibility, m.has_people, m.consent, m.created_by, m.created_at'} FROM history_media m WHERE m.id = ? AND m.org_id = ?`).get(A.id(id), req.org.id);
  if (!m || !(await mediaVisibility(req))(Number(m.id))) throw new HttpError(404, 'Média introuvable.');
  return m;
}
router.get('/media/:id/file', dlLimit, async (req, res) => {
  const m = await loadMedia(req, req.params.id, { full: true });
  const data = X.unseal(m.data);
  if (!data) throw new HttpError(500, 'Ce fichier ne peut pas être relu (clé de chiffrement modifiée).');
  const SEC = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-site' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') || '');
  if (range && (range[1] || range[2])) { // lecture vidéo : avance rapide
    let start = range[1] ? Number(range[1]) : Math.max(data.length - Number(range[2]), 0);
    let end = range[1] && range[2] ? Number(range[2]) : data.length - 1;
    end = Math.min(end, data.length - 1);
    if (start > end || start >= data.length) { res.status(416).set({ ...SEC, 'Content-Range': `bytes */${data.length}` }).end(); return; }
    res.status(206).set({ ...SEC, 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
    res.end(data.subarray(start, end + 1)); return;
  }
  res.set({ ...SEC, 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Content-Length': data.length, 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${m.name.replace(/[^\w.\- ]/g, '_')}"` });
  res.end(data);
});

router.put('/media/:id', needEdit, async (req, res) => {
  const m = await loadMedia(req, req.params.id);
  const b = req.body || {};
  const f = {
    caption: b.caption === undefined ? m.caption : A.text(b.caption, 300),
    visibility: b.visibility === undefined ? m.visibility : A.oneOf(b.visibility, VISIBILITIES, undefined, 'Visibilité inconnue.'),
    has_people: b.hasPeople === undefined ? Number(m.has_people) : (toBool(b.hasPeople) ? 1 : 0),
    consent: b.consent === undefined ? Number(m.consent) : (toBool(b.consent) ? 1 : 0),
    taken_on: b.takenOn === undefined ? m.taken_on : dateIn(b.takenOn, 'Date de prise de vue'),
  };
  let eventId = m.event_id;
  if (b.eventId !== undefined) {
    eventId = A.idOrNull(b.eventId, 'Événement invalide.');
    if (eventId && !await db.prepare('SELECT 1 FROM history_events WHERE id = ? AND org_id = ?').get(eventId, req.org.id)) throw new HttpError(404, 'Événement introuvable.');
  }
  await db.prepare('UPDATE history_media SET caption = ?, visibility = ?, has_people = ?, consent = ?, taken_on = ?, event_id = ? WHERE id = ?').run(f.caption, f.visibility, f.has_people, f.consent, f.taken_on, eventId, m.id);
  await W.audit(req, 'history_media', m.id, 'update', { visibility: m.visibility, hasPeople: m.has_people, consent: m.consent, eventId: m.event_id }, { visibility: f.visibility, hasPeople: f.has_people, consent: f.consent, eventId });
  res.json({ ok: true });
});
router.delete('/media/:id', needEdit, async (req, res) => {
  const m = await loadMedia(req, req.params.id);
  await db.transaction(async () => {
    await db.prepare('UPDATE history_people SET photo_media_id = NULL WHERE photo_media_id = ? AND org_id = ?').run(m.id, req.org.id);
    await db.prepare('DELETE FROM history_media WHERE id = ?').run(m.id);
  })();
  await W.audit(req, 'history_media', m.id, 'delete', { name: m.name, kind: m.kind, size: m.size }, null);
  res.json({ ok: true });
});

// ---------- Traçabilité ----------
const ENTITY_LABEL = { history_event: 'Événement', history_person: 'Personne', history_media: 'Média', history_settings: 'Droits de saisie', history_export: 'Export' };
router.get('/journal', needDirection, async (req, res) => {
  const rows = await db.prepare("SELECT a.id, a.entity, a.entity_id, a.action, a.before_json, a.after_json, a.created_at, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = ? AND a.entity LIKE 'history\\_%' ESCAPE '\\' ORDER BY a.id DESC LIMIT 300").all(req.org.id);
  res.json({ entries: rows.map((r) => ({ id: Number(r.id), entity: r.entity, entityLabel: ENTITY_LABEL[r.entity] || r.entity, entityId: r.entity_id == null ? null : Number(r.entity_id), action: r.action, before: parseJSON(r.before_json, null), after: parseJSON(r.after_json, null), at: r.created_at, by: r.name || '' })) });
});

// ---------- Exports ----------
const frDate = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
router.get('/export.csv', async (req, res) => {
  const what = req.query.what === 'people' ? 'people' : 'events';
  await W.audit(req, 'history_export', null, 'csv', null, { what });
  if (what === 'people') {
    const rows = await db.prepare('SELECT * FROM history_people WHERE org_id = ? ORDER BY level, id').all(req.org.id);
    const names = new Map(rows.map((p) => [Number(p.id), p.name]));
    return W.sendCsv(res, 'histoire-personnes.csv', ['Nom', 'Poste', 'Niveau', 'Supérieur', 'Arrivée', 'Départ', 'Motif du départ'], rows.map((p) => [p.name, p.title, p.level, names.get(Number(p.parent_id)) || '', frDate(p.start_date), frDate(p.end_date), p.departure_reason]));
  }
  const events = await eventsOf(req);
  W.sendCsv(res, 'histoire-evenements.csv', ['Date', 'Fin', 'Titre', 'Nature', 'Catégorie', 'Lieu', 'Personnes concernées', 'Description', 'Ce qu’on en a retenu', 'Ce qui a fait le succès', 'Compte rendu', 'Invités', 'Visibilité'],
    events.map((e) => [frDate(e.date), frDate(e.endDate), e.title, e.natureLabel, e.categoryLabel, e.place, e.people.map((p) => p.name).join(', '), e.description, e.lesson, e.successFactors, e.minutes, e.guests.map((g) => g.name + (g.org ? ` (${g.org})` : '')).join(', '), VIS_LABEL[e.visibility]]));
});
router.get('/export.pdf', async (req, res) => {
  const events = await eventsOf(req, { nature: req.query.nature === 'good' || req.query.nature === 'bad' ? req.query.nature : null });
  await W.audit(req, 'history_export', null, 'pdf', null, { events: events.length });
  const blocks = [];
  const byYear = new Map();
  for (const e of events) { if (!byYear.has(e.year)) byYear.set(e.year, []); byYear.get(e.year).push(e); }
  if (!events.length) blocks.push({ type: 'text', text: 'Aucun événement enregistré pour le moment.' });
  for (const [year, list] of byYear) {
    blocks.push({ type: 'heading', text: String(year) });
    blocks.push({ type: 'table', cols: [{ key: 'd', label: 'Date', width: 1.1 }, { key: 't', label: 'Événement', width: 3.2 }, { key: 'n', label: 'Nature', width: 1.3 }, { key: 'c', label: 'Catégorie', width: 1.6 }, { key: 'p', label: 'Lieu', width: 1.4 }],
      rows: list.map((e) => ({ d: frDate(e.date), t: e.title, n: e.natureLabel, c: e.categoryLabel, p: e.place })) });
    for (const e of list) {
      const parts = [e.description && `${e.title} — ${e.description}`, e.nature === 'bad' && e.lesson && `Ce qu'on en a retenu : ${e.lesson}`, e.nature === 'good' && e.successFactors && `Ce qui a fait le succès : ${e.successFactors}`,
        e.people.length && `Personnes : ${e.people.map((p) => p.name).join(', ')}`, e.minutes && `Compte rendu : ${e.minutes}`, e.guests.length && `Invités : ${e.guests.map((g) => g.name + (g.org ? ` (${g.org})` : '')).join(', ')}`].filter(Boolean);
      if (parts.length > 1 || (parts.length === 1 && e.description)) blocks.push({ type: 'note', text: parts.join('\n') });
    }
  }
  const buf = await PDF.render({ org: req.org.name, title: "Histoire de l'entreprise", subtitle: req.org.name, blocks, meta: [['Événements', String(events.length)], ['Édité le', frDate(nowISO())]] });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="histoire-entreprise.pdf"', 'Cache-Control': 'private, no-store' });
  res.send(buf);
});

module.exports = router;
