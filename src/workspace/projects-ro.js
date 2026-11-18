'use strict';
// Projets · PERT, dépendances, conseils d'outils, recherche opérationnelle (maximiser la marge, minimiser le coût).
// Déclaré AVANT projects-pro.js / projects-w6.js / projects-w3.js / projects.js (voir index.js). Calculs dans pert-lib.js et ro-lib.js.
// Droits : tout membre voit le PERT, les dépendances et les conseils des projets qu'il voit ; modifier = responsables ; les scénarios de
// recherche opérationnelle contiennent des prix et des coûts : réservés aux responsables.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const P6 = require('./projects-w6');
const L = require('./pert-lib');
const RO = require('./ro-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const DEP_TYPES = L.TYPES;
const EXT_KINDS = ['supplier', 'client', 'authorization', 'other'];
const EXT_STATUS = ['pending', 'received', 'blocked'];
const CATEGORIES = ['delay', 'cost', 'resource', 'supplier', 'quality', 'other'];
const KINDS = ['general', 'sale', 'production'];

async function projectOf(req, id) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(404, 'Projet introuvable.');
  return p;
}
const num = (v, label, { min = 0, max = 100000 } = {}) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} : nombre invalide.`);
  return n;
};

// ---------- Type de projet ----------
router.put('/:id/kind', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const kind = A.oneOf((req.body || {}).kind, KINDS, undefined, 'Type de projet : général, vente ou production.');
  await db.prepare('UPDATE projects SET kind = ? WHERE id = ?').run(kind, p.id);
  await W.audit(req, 'project', p.id, 'kind', { kind: p.kind }, { kind });
  res.json({ ok: true, kind });
});

// ---------- Réseau du projet : tâches, estimations, liens ----------
async function network(req, p) {
  const tasks = await db.prepare('SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id = ? AND t.org_id = ? ORDER BY t.id').all(p.id, req.org.id);
  const pert = new Map((await db.prepare('SELECT * FROM project_pert WHERE project_id = ? AND org_id = ?').all(p.id, req.org.id)).map((r) => [Number(r.task_id), r]));
  const deps = await db.prepare('SELECT * FROM project_deps WHERE project_id = ? AND org_id = ? ORDER BY id').all(p.id, req.org.id);
  const today = W.today();
  const spans = tasks.map((t) => P6.span(t));
  const starts = spans.filter(Boolean).map((s) => s.start);
  const startDate = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : today;
  const items = tasks.map((t, i) => {
    const e = pert.get(Number(t.id)); const s = spans[i];
    let o; let m; let pe; let estimated = false;
    if (e) { o = Number(e.optimistic); m = Number(e.likely); pe = Number(e.pessimistic); } else {
      const span = s ? Math.round((Date.parse(s.end) - Date.parse(s.start)) / 86400000) + 1 : 0;
      m = Number(t.estimate_hours) > 0 ? Math.max(1, Math.ceil(Number(t.estimate_hours) / 8)) : (span || 1);
      o = Math.max(0.5, Math.round(m * 0.75 * 2) / 2); pe = Math.round(m * 1.5 * 2) / 2 || 1; estimated = true;
    }
    return { id: Number(t.id), title: t.title, status: t.status, assignee: t.assignee || null, o, m, p: pe, estimated, start: s ? s.start : null, end: s ? s.end : null };
  });
  const edges = [];
  for (const t of tasks) if (t.depends_on) edges.push({ from: Number(t.depends_on), to: Number(t.id), type: 'FS', lag: 0, source: 'task' });
  const dep = deps.filter((d) => d.kind === 'task').map((d) => ({ id: Number(d.id), from: Number(d.pred_task_id), to: Number(d.succ_task_id), type: d.dep_type, lag: Number(d.lag_days) || 0, source: 'dep' }));
  const externals = deps.filter((d) => d.kind === 'external').map((d) => ({ id: Number(d.id), title: d.title, kind: d.ext_kind, status: d.status, expectedDate: d.expected_date, taskId: d.succ_task_id == null ? null : Number(d.succ_task_id), ownerId: d.owner_id, note: d.note }));
  return { tasks, items, edges: edges.concat(dep), externals, startDate, today };
}

router.get('/:id/pert', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const net = await network(req, p);
  const target = req.query.target ? A.date(req.query.target) : (p.due || null);
  if (!net.items.length) return res.json({ ok: true, empty: true, nodes: [], edges: [], startDate: net.startDate, target: null });
  const r = L.analyze({ tasks: net.items, edges: net.edges, startDate: net.startDate, targetDate: target, runs: 2000, seed: Number(p.id) * 7919 });
  if (!r.ok) return res.json({ ok: false, cycle: r.cycle.map((i) => ({ id: i, title: (net.items.find((x) => x.id === i) || {}).title })) });
  res.json({ ...r, projectDue: p.due || null, estimatedCount: net.items.filter((x) => x.estimated).length });
});

router.put('/tasks/:tid/pert', mgr, async (req, res) => {
  const t = await db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(A.id(req.params.tid), req.org.id);
  if (!t || !t.project_id) throw new HttpError(404, 'Tâche introuvable.');
  const p = await projectOf(req, t.project_id);
  const b = req.body || {};
  if (b.clear) { await db.prepare('DELETE FROM project_pert WHERE task_id = ?').run(t.id); return res.json({ ok: true }); }
  const o = num(b.optimistic, 'Durée optimiste', { min: 0, max: 3650 }); const m = num(b.likely, 'Durée probable', { min: 0, max: 3650 }); const pe = num(b.pessimistic, 'Durée pessimiste', { min: 0, max: 3650 });
  if (!(o <= m && m <= pe) || pe <= 0) throw new HttpError(400, 'Il faut : optimiste ≤ probable ≤ pessimiste (en jours).');
  await db.prepare('INSERT INTO project_pert (task_id, org_id, project_id, optimistic, likely, pessimistic, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (task_id) DO UPDATE SET optimistic = EXCLUDED.optimistic, likely = EXCLUDED.likely, pessimistic = EXCLUDED.pessimistic, updated_at = EXCLUDED.updated_at')
    .run(t.id, req.org.id, p.id, o, m, pe, nowISO());
  await W.audit(req, 'task', t.id, 'pert', null, { o, m, p: pe });
  res.json({ ok: true });
});

// ---------- Dépendances ----------
const depRow = (d, tasks) => {
  const name = (id) => { const t = tasks.find((x) => Number(x.id) === Number(id)); return t ? t.title : null; };
  return { id: Number(d.id), kind: d.kind, type: d.dep_type, predId: d.pred_task_id == null ? null : Number(d.pred_task_id), pred: name(d.pred_task_id), succId: d.succ_task_id == null ? null : Number(d.succ_task_id), succ: name(d.succ_task_id), lag: Number(d.lag_days) || 0, extKind: d.ext_kind, title: d.title, expectedDate: d.expected_date, status: d.status, ownerId: d.owner_id == null ? null : Number(d.owner_id), note: d.note };
};
async function depsReport(req, p) {
  const net = await network(req, p);
  const rows = await db.prepare('SELECT * FROM project_deps WHERE project_id = ? AND org_id = ? ORDER BY id').all(p.id, req.org.id);
  const owners = new Map((await db.prepare('SELECT u.id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?').all(req.org.id)).map((u) => [Number(u.id), u.name]));
  const issues = L.checkDeps({ tasks: net.items, edges: net.edges.map((e) => ({ ...e, id: e.source === 'dep' ? e.id : undefined })), externals: net.externals, today: net.today });
  const links = net.edges.map((e) => ({ id: e.source === 'dep' ? e.id : null, source: e.source, predId: e.from, pred: (net.items.find((x) => x.id === e.from) || {}).title, succId: e.to, succ: (net.items.find((x) => x.id === e.to) || {}).title, type: e.type, lag: e.lag }));
  return { links, externals: net.externals.map((x) => ({ ...x, owner: x.ownerId ? owners.get(x.ownerId) || null : null, task: x.taskId ? (net.items.find((t) => t.id === x.taskId) || {}).title || null : null })), issues, items: rows.map((d) => depRow(d, net.tasks)), tasks: net.items.map((t) => ({ id: t.id, title: t.title })) };
}
router.get('/:id/deps', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  res.json(await depsReport(req, p));
});
async function readDep(req, p, b, old) {
  const o = old || {};
  const kind = old ? o.kind : A.oneOf(b.kind, ['task', 'external'], 'task');
  const task = async (v) => { if (v === null || v === undefined || v === '') return null; const t = await db.prepare('SELECT id FROM tasks WHERE id = ? AND project_id = ? AND org_id = ?').get(A.id(v), p.id, req.org.id); if (!t) throw new HttpError(400, 'Tâche inconnue dans ce projet.'); return Number(t.id); };
  if (kind === 'task') {
    const pred = b.predId === undefined ? Number(o.pred_task_id) : await task(b.predId); const succ = b.succId === undefined ? Number(o.succ_task_id) : await task(b.succId);
    if (!pred || !succ) throw new HttpError(400, 'Choisissez la tâche précédente et la tâche suivante.');
    if (pred === succ) throw new HttpError(400, 'Une tâche ne peut pas dépendre d\'elle-même.');
    const lag = b.lag === undefined ? Number(o.lag_days) || 0 : num(b.lag, 'Décalage', { min: -365, max: 365 });
    return { kind, type: b.type === undefined ? (o.dep_type || 'FS') : A.oneOf(b.type, DEP_TYPES, undefined, 'Type : FS, SS, FF ou SF.'), pred, succ, lag, ext: '', title: '', expected: null, status: 'pending', owner: null, note: b.note === undefined ? (o.note || '') : A.text(b.note, 500) };
  }
  const title = b.title === undefined ? o.title : A.text(b.title, 160, { required: true, msg: 'Décrivez ce que vous attendez (ex. livraison du ciment).' });
  return { kind, type: 'FS', pred: null, succ: b.succId === undefined ? (o.succ_task_id == null ? null : Number(o.succ_task_id)) : await task(b.succId), lag: 0,
    ext: b.extKind === undefined ? (o.ext_kind || 'other') : A.oneOf(b.extKind, EXT_KINDS, undefined, 'Type : fournisseur, client, autorisation ou autre.'), title,
    expected: b.expectedDate === undefined ? (o.expected_date || null) : A.date(b.expectedDate), status: b.status === undefined ? (o.status || 'pending') : A.oneOf(b.status, EXT_STATUS, undefined, 'Statut : en attente, reçu ou bloqué.'),
    owner: b.ownerId === undefined ? (o.owner_id == null ? null : Number(o.owner_id)) : await A.memberOf(req, b.ownerId), note: b.note === undefined ? (o.note || '') : A.text(b.note, 500) };
}
router.post('/:id/deps', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const v = await readDep(req, p, req.body || {}, null);
  if (v.kind === 'task') {
    const dup = await db.prepare("SELECT 1 FROM project_deps WHERE project_id = ? AND kind = 'task' AND pred_task_id = ? AND succ_task_id = ?").get(p.id, v.pred, v.succ);
    if (dup) throw new HttpError(400, 'Ce lien existe déjà.');
  }
  const id = Number((await db.prepare('INSERT INTO project_deps (org_id, project_id, kind, dep_type, pred_task_id, succ_task_id, lag_days, ext_kind, title, expected_date, status, owner_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, p.id, v.kind, v.type, v.pred, v.succ, v.lag, v.ext, v.title, v.expected, v.status, v.owner, v.note, req.user.id, nowISO())).lastInsertRowid);
  await W.audit(req, 'project_dep', id, 'create', null, { project: p.id, kind: v.kind, type: v.type });
  // Une boucle n'est pas refusée (la saisie reste libre) mais elle est signalée tout de suite.
  const rep = await depsReport(req, p);
  res.status(201).json({ id, issues: rep.issues.filter((i) => ['cycle', 'self'].includes(i.code)) });
});
async function depOf(req, did) {
  const d = await db.prepare('SELECT * FROM project_deps WHERE id = ? AND org_id = ?').get(A.id(did), req.org.id);
  if (!d) throw new HttpError(404, 'Dépendance introuvable.');
  return { d, p: await projectOf(req, d.project_id) };
}
router.put('/deps/:did', mgr, async (req, res) => {
  const { d, p } = await depOf(req, req.params.did);
  const v = await readDep(req, p, req.body || {}, d);
  await db.prepare('UPDATE project_deps SET dep_type = ?, pred_task_id = ?, succ_task_id = ?, lag_days = ?, ext_kind = ?, title = ?, expected_date = ?, status = ?, owner_id = ?, note = ? WHERE id = ?')
    .run(v.type, v.pred, v.succ, v.lag, v.ext, v.title, v.expected, v.status, v.owner, v.note, d.id);
  await W.audit(req, 'project_dep', d.id, 'update', null, { type: v.type, status: v.status });
  res.json({ ok: true });
});
router.delete('/deps/:did', mgr, async (req, res) => {
  const { d } = await depOf(req, req.params.did);
  await db.prepare('DELETE FROM project_deps WHERE id = ?').run(d.id);
  await W.audit(req, 'project_dep', d.id, 'delete', null, null);
  res.json({ ok: true });
});
// Supprimer le lien « simple » (champ depends_on d'une tâche) qui fait partie d'une boucle.
router.delete('/:id/links/:succ', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const r = await db.prepare('UPDATE tasks SET depends_on = NULL WHERE id = ? AND project_id = ? AND org_id = ?').run(A.id(req.params.succ), p.id, req.org.id);
  if (!r.changes) throw new HttpError(404, 'Lien introuvable.');
  res.json({ ok: true });
});

// ---------- Outils conseillés ----------
/** Choisit les outils adaptés aux risques et aux dépendances du projet. Renvoie des codes ; le site les traduit et ouvre l'outil. */
async function advise(req, p) {
  const net = await network(req, p);
  const risks = await db.prepare("SELECT * FROM project_risks WHERE project_id = ? AND org_id = ? AND status != 'closed'").all(p.id, req.org.id);
  const rep = await depsReport(req, p);
  const out = [];
  const add = (code, tool, priority, params = {}) => { if (!out.some((x) => x.code === code)) out.push({ code, tool, priority, params }); };
  const nTasks = net.items.length; const nLinks = net.edges.length;
  const byCat = (c) => risks.filter((r) => r.category === c);
  const high = (list) => list.filter((r) => Number(r.probability) * Number(r.impact) >= 15).length;
  if (rep.issues.some((i) => ['cycle', 'self'].includes(i.code))) add('depsCycle', 'deps', 1, { n: rep.issues.filter((i) => ['cycle', 'self'].includes(i.code)).length });
  if (rep.issues.some((i) => ['dates', 'doneBefore', 'extLate', 'extBlocked', 'extAfterStart'].includes(i.code))) add('depsInconsistent', 'deps', 1, { n: rep.issues.filter((i) => ['dates', 'doneBefore', 'extLate', 'extBlocked', 'extAfterStart'].includes(i.code)).length });
  if (nTasks >= 4 && nLinks >= 3) add('depsMany', 'pert', nLinks >= 6 ? 1 : 2, { links: nLinks, tasks: nTasks });
  const ext = (k) => rep.externals.filter((x) => x.kind === k && x.status !== 'received');
  if (ext('supplier').length) add('depSupplier', 'purchasing', 1, { n: ext('supplier').length });
  if (ext('client').length) add('depClient', 'planning', 2, { n: ext('client').length });
  if (ext('authorization').length) add('depAuthorization', 'planning', 2, { n: ext('authorization').length });
  if (byCat('delay').length) add('riskDelay', 'pert', high(byCat('delay')) ? 1 : 2, { n: byCat('delay').length });
  if (byCat('cost').length) add('riskCost', 'pilot', high(byCat('cost')) ? 1 : 2, { n: byCat('cost').length });
  if (byCat('resource').length) add('riskResource', 'workload', high(byCat('resource')) ? 1 : 2, { n: byCat('resource').length });
  if (byCat('supplier').length) add('riskSupplier', 'purchasing', high(byCat('supplier')) ? 1 : 2, { n: byCat('supplier').length });
  if (byCat('quality').length) add('riskQuality', p.kind === 'production' ? 'flow' : 'pilot', 2, { n: byCat('quality').length });
  if ((p.kind === 'sale' || p.kind === 'production') && A.can(req, 'manager')) {
    const n = Number((await db.prepare('SELECT COUNT(*) c FROM ro_scenarios WHERE project_id = ? AND org_id = ?').get(p.id, req.org.id)).c);
    if (!n) add(p.kind === 'sale' ? 'optimSale' : 'optimProduction', 'optim', 1, {});
    else if (byCat('cost').length) add('riskCostOptim', 'optim', 3, {});
  }
  if (p.kind === 'production') add('productionFlow', 'flow', 3, {});
  out.sort((a, b) => a.priority - b.priority);
  return out;
}
router.get('/:id/advice', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  res.json({ items: await advise(req, p), kind: p.kind || 'general' });
});

// ---------- Recherche opérationnelle ----------
const roOnly = A.need('manager');
function parseRo(row) {
  let inputs = {}; let result = {};
  try { inputs = JSON.parse(row.inputs); result = JSON.parse(row.result); } catch { /* ligne abîmée : on renvoie du vide */ }
  return { id: Number(row.id), projectId: Number(row.project_id), kind: row.kind, name: row.name, inputs, result, createdAt: row.created_at, updatedAt: row.updated_at };
}
function solveOr400(kind, raw) {
  try { return RO.solveScenario(kind, raw); } catch (e) { throw new HttpError(400, e.message); }
}
const roKind = (v) => A.oneOf(v, ['sale', 'production'], undefined, 'Type de scénario : vente ou production.');

/** Hypothèses de départ : recettes (nomenclatures) du module Production si elles existent, sinon un exemple à adapter. */
router.get('/:id/ro/starter', roOnly, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const kind = p.kind === 'production' ? 'production' : 'sale';
  const boms = await db.prepare(`SELECT b.id, i.name, b.labor_cost, b.other_cost, COALESCE((SELECT SUM(l.quantity * s.unit_cost) FROM production_bom_lines l JOIN stock_items s ON s.id = l.item_id WHERE l.bom_id = b.id), 0) AS material
    FROM production_boms b JOIN stock_items i ON i.id = b.product_id WHERE b.org_id = ? ORDER BY b.id LIMIT 4`).all(req.org.id);
  res.json({ kind, boms: boms.map((b) => ({ name: b.name, unitCost: Math.round(Number(b.material) + Number(b.labor_cost) + Number(b.other_cost)) })) });
});
router.post('/:id/ro/solve', roOnly, async (req, res) => {
  await projectOf(req, req.params.id);
  const b = req.body || {};
  res.json(solveOr400(roKind(b.kind), b.inputs));
});
router.get('/:id/ro/scenarios', roOnly, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const rows = await db.prepare('SELECT * FROM ro_scenarios WHERE project_id = ? AND org_id = ? ORDER BY id DESC').all(p.id, req.org.id);
  res.json({ items: rows.map((r) => { const s = parseRo(r); return { id: s.id, kind: s.kind, name: s.name, createdAt: s.createdAt, status: s.result.status, metrics: RO.keyMetrics(s.result), conclusion: s.result.conclusion }; }) });
});
router.post('/:id/ro/scenarios', roOnly, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const b = req.body || {}; const kind = roKind(b.kind);
  const name = A.text(b.name, 120, { required: true, msg: 'Donnez un nom au scénario.' });
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM ro_scenarios WHERE project_id = ? AND org_id = ?').get(p.id, req.org.id)).c);
  if (n >= 30) throw new HttpError(400, '30 scénarios au plus par projet : supprimez-en avant d\'en ajouter.');
  const s = solveOr400(kind, b.inputs); const now = nowISO();
  const id = Number((await db.prepare('INSERT INTO ro_scenarios (org_id, project_id, kind, name, inputs, result, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, p.id, kind, name, JSON.stringify(s.inputs), JSON.stringify(s.result), req.user.id, now, now)).lastInsertRowid);
  await W.audit(req, 'ro_scenario', id, 'create', null, { project: p.id, kind });
  res.status(201).json({ id, ...s });
});
router.get('/:id/ro/compare', roOnly, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const ids = String(req.query.ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 4);
  if (ids.length < 2) throw new HttpError(400, 'Choisissez au moins deux scénarios à comparer.');
  const rows = [];
  for (const id of ids) { const r = await db.prepare('SELECT * FROM ro_scenarios WHERE id = ? AND project_id = ? AND org_id = ?').get(id, p.id, req.org.id); if (r) rows.push(parseRo(r)); }
  if (rows.length < 2) throw new HttpError(404, 'Scénarios introuvables.');
  if (new Set(rows.map((r) => r.kind)).size > 1) throw new HttpError(400, 'On ne compare que des scénarios du même type (vente avec vente, production avec production).');
  const items = rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, metrics: RO.keyMetrics(r.result), result: r.result, conclusion: r.result.conclusion }));
  const kind = rows[0].kind; const key = kind === 'sale' ? 'profit' : 'cost';
  const ok = items.filter((i) => i.metrics);
  const best = ok.length ? ok.reduce((a, b) => ((kind === 'sale' ? b.metrics[key] > a.metrics[key] : b.metrics[key] < a.metrics[key]) ? b : a)).id : null;
  res.json({ kind, key, best, items });
});
async function scenarioOf(req, sid) {
  const r = await db.prepare('SELECT * FROM ro_scenarios WHERE id = ? AND org_id = ?').get(A.id(sid), req.org.id);
  if (!r) throw new HttpError(404, 'Scénario introuvable.');
  await projectOf(req, r.project_id);
  return r;
}
router.get('/ro/scenarios/:sid', roOnly, async (req, res) => res.json(parseRo(await scenarioOf(req, req.params.sid))));
router.put('/ro/scenarios/:sid', roOnly, async (req, res) => {
  const r = await scenarioOf(req, req.params.sid); const b = req.body || {};
  const name = b.name === undefined ? r.name : A.text(b.name, 120, { required: true, msg: 'Donnez un nom au scénario.' });
  let inputs = r.inputs; let result = r.result; let out = {};
  if (b.inputs !== undefined) { const s = solveOr400(r.kind, b.inputs); inputs = JSON.stringify(s.inputs); result = JSON.stringify(s.result); out = s; }
  await db.prepare('UPDATE ro_scenarios SET name = ?, inputs = ?, result = ?, updated_at = ? WHERE id = ?').run(name, inputs, result, nowISO(), r.id);
  res.json({ ok: true, ...out });
});
router.delete('/ro/scenarios/:sid', roOnly, async (req, res) => {
  const r = await scenarioOf(req, req.params.sid);
  await db.prepare('DELETE FROM ro_scenarios WHERE id = ?').run(r.id);
  await W.audit(req, 'ro_scenario', r.id, 'delete', { name: r.name }, null);
  res.json({ ok: true });
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
