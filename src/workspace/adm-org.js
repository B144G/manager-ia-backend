'use strict';
// Administration · 1. Organigramme fonctionnel, fiches de poste, matrice RACI, délégations et intérim.
// Les postes viennent de la sous-application « Organisation » (table positions, lue seulement) ; les services, fiches et RACI sont propres au module.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./adm-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const manage = L.needPerm('org_manage');
const LETTERS = ['R', 'A', 'S', 'C', 'I']; // R réalise · A dirige / valide (une seule) · S supervise · C consulté · I informé
const LETTER_LABEL = { R: 'Réalise', A: 'Dirige et valide', S: 'Supervise', C: 'Consulté', I: 'Informé' };

// ---------- Services et organigramme ----------
async function chart(orgId) {
  const units = (await db.prepare('SELECT * FROM adm_units WHERE org_id = ? ORDER BY id').all(orgId)).map((u) => L.out(u));
  const names = await L.nameMap(orgId);
  const pos = await db.prepare(`SELECT p.id, p.title, p.description, p.parent_id, p.holder_id, p.branch_id, a.unit_id, a.mission, a.responsibilities, a.skills, a.kpis, a.functions
    FROM positions p LEFT JOIN adm_posts a ON a.position_id = p.id AND a.org_id = p.org_id WHERE p.org_id = ? ORDER BY p.id`).all(orgId);
  const positions = pos.map((p) => ({
    id: Number(p.id), title: p.title, parentId: p.parent_id == null ? null : Number(p.parent_id), holderId: p.holder_id == null ? null : Number(p.holder_id),
    holder: p.holder_id == null ? null : names.get(Number(p.holder_id)) || null, unitId: p.unit_id == null ? null : Number(p.unit_id), branchId: p.branch_id,
    hasSheet: Boolean(p.mission || p.skills || p.kpis || L.jparse(p.responsibilities, []).length),
  }));
  for (const u of units) u.head = u.headUserId ? names.get(Number(u.headUserId)) || null : null;
  const vacant = positions.filter((p) => !p.holderId).length;
  return {
    units, positions,
    stats: { units: units.length, positions: positions.length, vacant, filled: positions.length - vacant, unassigned: positions.filter((p) => !p.unitId).length, withoutSheet: positions.filter((p) => !p.hasSheet).length },
  };
}
router.get('/chart', async (req, res) => res.json(await chart(req.org.id)));

async function unitParent(req, v, selfId) {
  const pid = A.idOrNull(v, 'Service parent invalide.');
  if (pid === null) return null;
  if (!await db.prepare('SELECT 1 FROM adm_units WHERE id = ? AND org_id = ?').get(pid, req.org.id)) throw new HttpError(400, 'Service parent inconnu.');
  for (let cur = pid, n = 0; cur && n < 50; n++) {
    if (cur === selfId) throw new HttpError(400, 'Un service ne peut pas dépendre de lui-même.');
    cur = Number((await db.prepare('SELECT parent_id FROM adm_units WHERE id = ?').get(cur) || {}).parent_id) || null;
  }
  return pid;
}
router.post('/units', manage, async (req, res) => {
  const b = req.body || {};
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_units WHERE org_id = ?').get(req.org.id)).c >= 150) throw new HttpError(403, 'Limite de 150 services atteinte.');
  const id = (await db.prepare('INSERT INTO adm_units (org_id, name, parent_id, head_user_id, mission, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    req.org.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du service.' }), await unitParent(req, b.parentId, null), await A.memberOf(req, b.headUserId), A.text(b.mission, 1000), nowISO())).lastInsertRowid;
  await W.audit(req, 'adm_unit', id, 'create', null, { name: b.name });
  res.status(201).json({ id: Number(id) });
});
router.put('/units/:id', manage, async (req, res) => {
  const u = await db.prepare('SELECT * FROM adm_units WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!u) throw new HttpError(404, 'Service introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE adm_units SET name = ?, parent_id = ?, head_user_id = ?, mission = ? WHERE id = ?').run(
    b.name === undefined ? u.name : A.text(b.name, 100, { required: true, msg: 'Le nom ne peut pas être vide.' }),
    b.parentId === undefined ? u.parent_id : await unitParent(req, b.parentId, u.id),
    b.headUserId === undefined ? u.head_user_id : await A.memberOf(req, b.headUserId),
    b.mission === undefined ? u.mission : A.text(b.mission, 1000), u.id);
  res.json({ ok: true });
});
router.delete('/units/:id', manage, async (req, res) => {
  const id = A.id(req.params.id);
  const r = await db.transaction(async () => {
    await db.prepare('UPDATE adm_units SET parent_id = NULL WHERE org_id = ? AND parent_id = ?').run(req.org.id, id);
    await db.prepare('UPDATE adm_posts SET unit_id = NULL WHERE org_id = ? AND unit_id = ?').run(req.org.id, id);
    return db.prepare('DELETE FROM adm_units WHERE id = ? AND org_id = ?').run(id, req.org.id);
  })();
  if (!r.changes) throw new HttpError(404, 'Service introuvable.');
  res.json({ ok: true });
});

// ---------- Fiches de poste ----------
router.get('/posts/:positionId', async (req, res) => {
  const pid = A.id(req.params.positionId);
  const p = await db.prepare('SELECT * FROM positions WHERE id = ? AND org_id = ?').get(pid, req.org.id);
  if (!p) throw new HttpError(404, 'Poste introuvable.');
  const a = await db.prepare('SELECT * FROM adm_posts WHERE position_id = ? AND org_id = ?').get(pid, req.org.id) || {};
  const names = await L.nameMap(req.org.id);
  const parent = p.parent_id ? await db.prepare('SELECT title FROM positions WHERE id = ?').get(p.parent_id) : null;
  const reports = (await db.prepare('SELECT id, title, holder_id FROM positions WHERE parent_id = ? AND org_id = ?').all(pid, req.org.id)).map((r) => ({ id: Number(r.id), title: r.title, holder: names.get(Number(r.holder_id)) || null }));
  const raci = await db.prepare(`SELECT r.letter, ac.name AS activity, pr.name AS process FROM adm_raci r JOIN adm_activities ac ON ac.id = r.activity_id JOIN adm_processes pr ON pr.id = ac.process_id
    WHERE r.org_id = ? AND r.actor_kind = 'position' AND r.actor_id = ? ORDER BY pr.name, ac.sort`).all(req.org.id, pid);
  res.json({
    sheet: {
      positionId: pid, title: p.title, description: p.description, holder: names.get(Number(p.holder_id)) || null, holderId: p.holder_id == null ? null : Number(p.holder_id), reportsTo: parent ? parent.title : null, directReports: reports,
      unitId: a.unit_id == null ? null : Number(a.unit_id), mission: a.mission || '', responsibilities: L.jparse(a.responsibilities, []), skills: a.skills || '', kpis: a.kpis || '', functions: L.jparse(a.functions, []),
      raci: raci.map((r) => ({ letter: r.letter, label: LETTER_LABEL[r.letter], activity: r.activity, process: r.process })),
    },
  });
});
router.put('/posts/:positionId', manage, async (req, res) => {
  const pid = A.id(req.params.positionId);
  if (!await db.prepare('SELECT 1 FROM positions WHERE id = ? AND org_id = ?').get(pid, req.org.id)) throw new HttpError(404, 'Poste introuvable.');
  const b = req.body || {};
  let unit = null;
  if (b.unitId !== undefined && b.unitId !== null && b.unitId !== '') {
    unit = A.id(b.unitId);
    if (!await db.prepare('SELECT 1 FROM adm_units WHERE id = ? AND org_id = ?').get(unit, req.org.id)) throw new HttpError(400, 'Service inconnu.');
  }
  const funcs = [...new Set((Array.isArray(b.functions) ? b.functions : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 60); // fonctions de séparation des tâches
  for (const f of funcs) if (!await db.prepare('SELECT 1 FROM adm_sod_funcs WHERE id = ? AND org_id = ?').get(f, req.org.id)) throw new HttpError(400, 'Fonction inconnue.');
  const prev = await db.prepare('SELECT * FROM adm_posts WHERE position_id = ? AND org_id = ?').get(pid, req.org.id);
  const keep = (k, v, d) => (b[k] === undefined ? (prev ? prev[v] : d) : null);
  const vals = {
    unit: b.unitId === undefined ? (prev ? prev.unit_id : null) : unit,
    mission: b.mission === undefined ? keep('mission', 'mission', '') : A.text(b.mission, 1500),
    resp: b.responsibilities === undefined ? keep('responsibilities', 'responsibilities', '[]') : JSON.stringify(L.strList(b.responsibilities, 40, 300)),
    skills: b.skills === undefined ? keep('skills', 'skills', '') : A.text(b.skills, 1000),
    kpis: b.kpis === undefined ? keep('kpis', 'kpis', '') : A.text(b.kpis, 1000),
    funcs: b.functions === undefined ? keep('functions', 'functions', '[]') : JSON.stringify(funcs),
  };
  await db.prepare(`INSERT INTO adm_posts (org_id, position_id, unit_id, mission, responsibilities, skills, kpis, functions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, position_id) DO UPDATE SET unit_id = EXCLUDED.unit_id, mission = EXCLUDED.mission, responsibilities = EXCLUDED.responsibilities, skills = EXCLUDED.skills, kpis = EXCLUDED.kpis, functions = EXCLUDED.functions, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, pid, vals.unit, vals.mission, vals.resp, vals.skills, vals.kpis, vals.funcs, nowISO());
  await W.audit(req, 'adm_post', pid, 'update', prev ? { mission: prev.mission } : null, { mission: vals.mission });
  res.json({ ok: true });
});

// ---------- Processus, activités et matrice RACI ----------
async function raciMatrix(orgId) {
  const procs = await db.prepare('SELECT * FROM adm_processes WHERE org_id = ? ORDER BY id').all(orgId);
  const acts = await db.prepare('SELECT * FROM adm_activities WHERE org_id = ? ORDER BY process_id, sort, id').all(orgId);
  const cells = await db.prepare('SELECT * FROM adm_raci WHERE org_id = ?').all(orgId);
  const names = await L.nameMap(orgId);
  const posRows = await db.prepare('SELECT id, title, holder_id FROM positions WHERE org_id = ? ORDER BY id').all(orgId);
  const pos = new Map(posRows.map((p) => [Number(p.id), p]));
  const actorName = (c) => (c.actor_kind === 'user' ? names.get(Number(c.actor_id)) : (pos.get(Number(c.actor_id)) || {}).title) || '(supprimé)';
  const used = new Map();
  const issues = [];
  const processes = procs.map((p) => {
    const activities = acts.filter((a) => Number(a.process_id) === Number(p.id)).map((a) => {
      const mine = cells.filter((c) => Number(c.activity_id) === Number(a.id));
      for (const c of mine) used.set(`${c.actor_kind}:${c.actor_id}`, { kind: c.actor_kind, id: Number(c.actor_id), name: actorName(c) });
      const count = (l) => mine.filter((c) => c.letter === l).length;
      const problems = [];
      if (!count('A')) problems.push('no_accountable'); else if (count('A') > 1) problems.push('many_accountable');
      if (!count('R')) problems.push('no_responsible');
      for (const pr of problems) issues.push({ processId: Number(p.id), process: p.name, activityId: Number(a.id), activity: a.name, problem: pr });
      return { id: Number(a.id), name: a.name, sort: Number(a.sort), assignments: mine.map((c) => ({ kind: c.actor_kind, id: Number(c.actor_id), name: actorName(c), letter: c.letter })), problems };
    });
    return { id: Number(p.id), name: p.name, domain: p.domain, description: p.description, activities };
  });
  // charge par acteur : combien d'activités il réalise / dirige…
  const load = [...used.values()].map((a) => {
    const mine = cells.filter((c) => c.actor_kind === a.kind && Number(c.actor_id) === a.id);
    const row = { ...a, R: 0, A: 0, S: 0, C: 0, I: 0 };
    for (const c of mine) row[c.letter]++;
    return row;
  }).sort((x, y) => (y.A + y.R) - (x.A + x.R));
  return { letters: LETTERS.map((l) => ({ letter: l, label: LETTER_LABEL[l] })), processes, actors: [...used.values()], load, issues, stats: { processes: procs.length, activities: acts.length, assignments: cells.length, issues: issues.length } };
}
router.get('/raci', async (req, res) => res.json(await raciMatrix(req.org.id)));

router.post('/processes', manage, async (req, res) => {
  const b = req.body || {};
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_processes WHERE org_id = ?').get(req.org.id)).c >= 100) throw new HttpError(403, 'Limite de 100 processus atteinte.');
  const id = (await db.prepare('INSERT INTO adm_processes (org_id, name, domain, description, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 120, { required: true, msg: 'Indiquez le nom du processus.' }), A.text(b.domain, 80), A.text(b.description, 1000), nowISO())).lastInsertRowid;
  for (const [i, n] of L.strList(b.activities, 30, 160).entries()) await db.prepare('INSERT INTO adm_activities (org_id, process_id, name, sort) VALUES (?, ?, ?, ?)').run(req.org.id, id, n, i);
  res.status(201).json({ id: Number(id) });
});
router.put('/processes/:id', manage, async (req, res) => {
  const p = await db.prepare('SELECT * FROM adm_processes WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Processus introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE adm_processes SET name = ?, domain = ?, description = ? WHERE id = ?').run(b.name === undefined ? p.name : A.text(b.name, 120, { required: true, msg: 'Le nom ne peut pas être vide.' }), b.domain === undefined ? p.domain : A.text(b.domain, 80), b.description === undefined ? p.description : A.text(b.description, 1000), p.id);
  res.json({ ok: true });
});
router.delete('/processes/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_processes WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Processus introuvable.');
  res.json({ ok: true });
});
router.post('/processes/:id/activities', manage, async (req, res) => {
  const p = await db.prepare('SELECT id FROM adm_processes WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Processus introuvable.');
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM adm_activities WHERE process_id = ?').get(p.id)).c);
  if (n >= 60) throw new HttpError(403, 'Limite de 60 activités par processus.');
  const id = (await db.prepare('INSERT INTO adm_activities (org_id, process_id, name, sort) VALUES (?, ?, ?, ?)').run(req.org.id, p.id, A.text((req.body || {}).name, 160, { required: true, msg: "Indiquez le nom de l'activité." }), n)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/activities/:id', manage, async (req, res) => {
  const a = await db.prepare('SELECT * FROM adm_activities WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Activité introuvable.');
  await db.prepare('UPDATE adm_activities SET name = ? WHERE id = ?').run(A.text((req.body || {}).name, 160, { required: true, msg: 'Le nom ne peut pas être vide.' }), a.id);
  res.json({ ok: true });
});
router.delete('/activities/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_activities WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Activité introuvable.');
  res.json({ ok: true });
});
/** Remplace toutes les lettres RACI d'une activité : { assignments: [{ kind: 'user'|'position', id, letter }] }. */
router.put('/activities/:id/raci', manage, async (req, res) => {
  const a = await db.prepare('SELECT * FROM adm_activities WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Activité introuvable.');
  const list = Array.isArray((req.body || {}).assignments) ? req.body.assignments : null;
  if (!list || list.length > 60) throw new HttpError(400, 'Liste de rôles invalide.');
  const seen = new Set(); const rows = [];
  for (const x of list) {
    const kind = A.oneOf(x && x.kind, ['user', 'position'], undefined, 'Type de personne inconnu (user ou position).');
    const id = A.id(x.id); const letter = A.oneOf(x.letter, LETTERS, undefined, 'Lettre inconnue (R, A, S, C ou I).');
    if (kind === 'user') await A.memberOf(req, id);
    else if (!await db.prepare('SELECT 1 FROM positions WHERE id = ? AND org_id = ?').get(id, req.org.id)) throw new HttpError(400, 'Poste inconnu.');
    const k = `${kind}:${id}`;
    if (seen.has(k)) throw new HttpError(400, 'Une même personne ou un même poste ne peut avoir qu’une lettre par activité.');
    seen.add(k); rows.push([kind, id, letter]);
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM adm_raci WHERE activity_id = ?').run(a.id);
    for (const [kind, id, letter] of rows) await db.prepare('INSERT INTO adm_raci (org_id, activity_id, actor_kind, actor_id, letter) VALUES (?, ?, ?, ?, ?)').run(req.org.id, a.id, kind, id, letter);
  })();
  await W.audit(req, 'adm_raci', a.id, 'update', null, { n: rows.length });
  res.json({ ok: true, count: rows.length });
});

// ---------- Délégations et intérim ----------
const KINDS = ['delegation', 'interim'];
const delegView = (d, names) => ({ ...L.out(d), delegator: names.get(Number(d.delegator_id)) || null, delegate: names.get(Number(d.delegate_id)) || null, ceiling: Number(d.ceiling), active: isActive(d) });
function isActive(d, on = L.today()) { return d.status === 'active' && d.start_date <= on && d.end_date >= on; }
/** Délégations / intérims en cours à une date (pour les circuits de validation). */
async function activeDelegations(orgId, on = L.today()) {
  return (await db.prepare("SELECT * FROM adm_delegations WHERE org_id = ? AND status = 'active' AND start_date <= ? AND end_date >= ?").all(orgId, on, on)).map((d) => ({ delegatorId: Number(d.delegator_id), delegateId: Number(d.delegate_id), scopeKey: d.scope_key, ceiling: Number(d.ceiling), kind: d.kind, id: Number(d.id) }));
}
router.get('/delegations', async (req, res) => {
  const names = await L.nameMap(req.org.id);
  const rows = await db.prepare('SELECT * FROM adm_delegations WHERE org_id = ? ORDER BY id DESC LIMIT 300').all(req.org.id);
  const list = rows.map((d) => delegView(d, names));
  res.json({ delegations: list, summary: { active: list.filter((d) => d.active).length, upcoming: list.filter((d) => d.status === 'active' && d.startDate > L.today()).length, expired: list.filter((d) => d.status === 'active' && d.endDate < L.today()).length, revoked: list.filter((d) => d.status === 'revoked').length } });
});
router.post('/delegations', async (req, res) => {
  const b = req.body || {};
  const delegator = b.delegatorId === undefined || b.delegatorId === null || b.delegatorId === '' ? req.user.id : await A.memberOf(req, b.delegatorId);
  req.admCfg = req.admCfg || await L.getConfig(req.org.id);
  if (delegator !== req.user.id && !L.allowed(req, req.admCfg, 'org_manage')) throw new HttpError(403, 'Vous ne pouvez déléguer que vos propres pouvoirs.');
  const delegate = await A.memberOf(req, b.delegateId);
  if (!delegate) throw new HttpError(400, 'Indiquez la personne qui reçoit la délégation.');
  if (delegate === delegator) throw new HttpError(400, 'On ne peut pas se déléguer à soi-même.');
  const start = A.date(b.startDate) || L.today(); const end = A.date(b.endDate);
  if (!end) throw new HttpError(400, 'Indiquez la date de fin.');
  if (end < start) throw new HttpError(400, 'La date de fin précède la date de début.');
  const kind = A.oneOf(b.kind, KINDS, 'delegation', 'Type inconnu (delegation ou interim).');
  const scopeKey = A.oneOf(b.scopeKey, ['all', 'purchase', 'leave', 'expense', 'document', 'contract', 'access', 'other'], 'all', 'Périmètre inconnu.');
  const id = (await db.prepare('INSERT INTO adm_delegations (org_id, kind, delegator_id, delegate_id, scope, scope_key, start_date, end_date, ceiling, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, kind, delegator, delegate, A.text(b.scope, 400), scopeKey, start, end, L.money(b.ceiling), A.text(b.reason, 400), req.user.id, nowISO())).lastInsertRowid;
  await W.push(req.org.id, delegate, 'administration', `${kind === 'interim' ? 'Intérim' : 'Délégation'} reçu du ${start} au ${end}.`, 'delegation:' + id);
  await W.audit(req, 'adm_delegation', id, 'create', null, { delegator, delegate, start, end, ceiling: L.money(b.ceiling) });
  res.status(201).json({ id: Number(id) });
});
router.post('/delegations/:id/revoke', async (req, res) => {
  const d = await db.prepare('SELECT * FROM adm_delegations WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Délégation introuvable.');
  req.admCfg = req.admCfg || await L.getConfig(req.org.id);
  if (Number(d.delegator_id) !== req.user.id && !L.allowed(req, req.admCfg, 'org_manage')) throw new HttpError(403, "Seul celui qui délègue (ou un administrateur désigné) peut la retirer.");
  await db.prepare("UPDATE adm_delegations SET status = 'revoked' WHERE id = ?").run(d.id);
  await W.audit(req, 'adm_delegation', d.id, 'revoke', { status: d.status }, { status: 'revoked' });
  res.json({ ok: true });
});

// ---------- Export PDF de l'organigramme + RACI ----------
router.get('/export.pdf', async (req, res) => {
  const c = await chart(req.org.id); const m = await raciMatrix(req.org.id);
  const byUnit = (id) => c.positions.filter((p) => p.unitId === id);
  const rows = [];
  for (const u of c.units) { rows.push({ a: u.name + (u.head ? ` (resp. ${u.head})` : ''), b: '', c: '' }); for (const p of byUnit(Number(u.id))) rows.push({ a: '   ' + p.title, b: p.holder || '(vacant)', c: '' }); }
  const free = c.positions.filter((p) => !p.unitId);
  if (free.length) { rows.push({ a: 'Sans service', b: '', c: '' }); for (const p of free) rows.push({ a: '   ' + p.title, b: p.holder || '(vacant)', c: '' }); }
  const blocks = [
    { type: 'heading', text: 'Organigramme fonctionnel' },
    { type: 'kv', rows: [['Services', c.stats.units], ['Postes', c.stats.positions], ['Postes pourvus', c.stats.filled], ['Postes vacants', c.stats.vacant]] },
    { type: 'table', cols: [{ key: 'a', label: 'Service / poste', width: 3 }, { key: 'b', label: 'Titulaire', width: 2 }], rows },
  ];
  for (const p of m.processes) {
    blocks.push({ type: 'heading', text: 'RACI : ' + p.name });
    blocks.push({ type: 'table', cols: [{ key: 'a', label: 'Activité', width: 3 }, { key: 'b', label: 'Qui fait quoi', width: 4 }], rows: p.activities.map((a) => ({ a: a.name, b: a.assignments.map((x) => `${x.letter} ${x.name}`).join(' · ') })) });
  }
  blocks.push({ type: 'note', text: 'R réalise · A dirige et valide · S supervise · C consulté · I informé.' });
  const buf = await require('../services/pdf').render({ title: 'Organigramme et responsabilités', subtitle: new Date().toISOString().slice(0, 10), org: req.org.name, blocks });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="organigramme.pdf"', 'Cache-Control': 'private, no-store' }).send(buf);
});

module.exports = { router, chart, raciMatrix, activeDelegations, isActive, LETTERS };
