'use strict';
// RH Talents · MBO et méthode SMART : objectifs en cascade (entreprise → équipe → individu), assistant SMART, avancement, pondération, score de réalisation.
const express = require('express');
const C = require('./rh-core');
const L = require('./rh-lib');
const { db, nowISO, A, HttpError, has, audit } = C;

const router = express.Router({ mergeParams: true });
const LEVELS = ['company', 'team', 'individual'];
const STATUS = ['draft', 'active', 'done', 'cancelled'];
const numOrNull = (v, msg) => { if (v === undefined || v === null || v === '') return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n)) throw new HttpError(400, msg || 'Nombre invalide.'); return n; };

const view = (g, nm) => {
  const progress = L.goalProgress({ start: g.start_value, target: g.target_value, current: g.current_value, status: g.status });
  return { id: Number(g.id), level: g.level, parentId: g.parent_id == null ? null : Number(g.parent_id), employeeId: g.employee_id == null ? null : Number(g.employee_id), employee: g.employee_id == null ? '' : nm.get(Number(g.employee_id)) || '',
    departmentId: g.department_id == null ? null : Number(g.department_id), period: g.period, title: g.title, description: g.description, unit: g.unit, start: Number(g.start_value), target: g.target_value == null ? null : Number(g.target_value),
    current: Number(g.current_value), due: g.due_date, weight: Number(g.weight), status: g.status, smartScore: Number(g.smart_score), progress };
};
const smartOf = (g, today) => L.smartCheck({ title: g.title, description: g.description, unit: g.unit, start: g.start_value, target: g.target_value, due: g.due_date, weight: g.weight, parentId: g.parent_id, ownerId: g.employee_id, level: g.level, today });

/** Peut-on voir / gérer cet objectif ? Entreprise et équipe : visibles de tous les membres ; individuel : RH, l'intéressé, son responsable. */
async function access(req, g) {
  const priv = await has(req, 'talent');
  if (g.level !== 'individual') return { read: true, manage: priv, progress: priv };
  const self = g.employee_id != null && (await C.isSelf(req, g.employee_id));
  const mgr = g.employee_id != null && (await C.isManagerOf(req, g.employee_id));
  return { read: priv || self || mgr, manage: priv || mgr, progress: priv || self || mgr };
}
async function load(req, id) { return C.fromOrg(req, 'rh_goals', id, 'Objectif introuvable.'); }

router.post('/goals/smart-check', async (req, res) => {
  const b = req.body || {};
  res.json(L.smartCheck({ title: b.title, description: b.description, unit: b.unit, start: b.start, target: b.target, due: b.due, weight: b.weight, parentId: b.parentId, ownerId: b.employeeId, level: b.level || 'individual', today: C.today() }));
});

router.get('/goals', async (req, res) => {
  const period = req.query.period ? String(req.query.period).slice(0, 40) : null;
  const rows = await db.prepare(`SELECT * FROM rh_goals WHERE org_id = ?${period ? ' AND period = ?' : ''} ORDER BY CASE level WHEN 'company' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, id`).all(...(period ? [req.org.id, period] : [req.org.id]));
  const nm = await C.names(req); const out = [];
  for (const g of rows) if ((await access(req, g)).read) out.push(view(g, nm));
  res.json({ items: out });
});

/** Cascade : arbre des objectifs ; l'avancement d'un objectif qui a des enfants est la moyenne pondérée de leurs avancements. Les objectifs individuels invisibles sont omis. */
router.get('/goals/tree', async (req, res) => {
  const period = req.query.period ? String(req.query.period).slice(0, 40) : null;
  const rows = await db.prepare(`SELECT * FROM rh_goals WHERE org_id = ? AND status != 'cancelled'${period ? ' AND period = ?' : ''} ORDER BY id`).all(...(period ? [req.org.id, period] : [req.org.id]));
  const nm = await C.names(req); const ok = new Set();
  for (const g of rows) if ((await access(req, g)).read) ok.add(Number(g.id));
  const kids = new Map(); for (const g of rows) if (g.parent_id != null) { const a = kids.get(Number(g.parent_id)) || []; a.push(g); kids.set(Number(g.parent_id), a); }
  const build = (g) => {
    const sub = (kids.get(Number(g.id)) || []).map(build);
    const v = view(g, nm);
    // l'avancement agrégé s'appuie sur tous les enfants (même ceux que la personne ne voit pas), mais seuls les visibles sont listés
    const all = (kids.get(Number(g.id)) || []).filter((k) => k.status !== 'draft');
    const prog = all.length ? L.goalScore(all.map((k) => ({ weight: Number(k.weight), progress: aggProgress(k) }))) : v.progress;
    return { ...v, progress: prog, rolled: all.length > 0, children: sub.filter(Boolean) };
  };
  const aggProgress = (g) => { const ch = (kids.get(Number(g.id)) || []).filter((k) => k.status !== 'draft'); return ch.length ? L.goalScore(ch.map((k) => ({ weight: Number(k.weight), progress: aggProgress(k) }))) : L.goalProgress({ start: g.start_value, target: g.target_value, current: g.current_value, status: g.status }); };
  const strip = (n) => (ok.has(n.id) ? { ...n, children: n.children.map(strip).filter(Boolean) } : null);
  const roots = rows.filter((g) => g.parent_id == null || !rows.find((x) => Number(x.id) === Number(g.parent_id))).map(build).map(strip).filter(Boolean);
  res.json({ items: roots });
});

async function parse(req, b, cur) {
  const g = cur ? { ...cur } : { level: 'individual', status: 'draft', weight: 10, start_value: 0, current_value: 0, unit: '', description: '', period: '' };
  if (b.level !== undefined) g.level = A.oneOf(b.level, LEVELS, undefined, 'Niveau d\'objectif inconnu.');
  if (b.title !== undefined || !cur) g.title = A.text(b.title, 200, { required: true, msg: "Indiquez l'intitulé de l'objectif." });
  if (b.description !== undefined) g.description = A.text(b.description, 1500);
  if (b.unit !== undefined) g.unit = A.text(b.unit, 30);
  if (b.period !== undefined) g.period = A.text(b.period, 40);
  if (b.start !== undefined) g.start_value = numOrNull(b.start, 'Valeur de départ invalide.') ?? 0;
  if (b.target !== undefined) g.target_value = numOrNull(b.target, 'Cible invalide.');
  if (b.due !== undefined) g.due_date = A.date(b.due);
  if (b.weight !== undefined) { const w = Number(b.weight); if (!Number.isInteger(w) || w < 0 || w > 100) throw new HttpError(400, 'Pondération : entier de 0 à 100.'); g.weight = w; }
  if (b.parentId !== undefined) g.parent_id = b.parentId === null || b.parentId === '' ? null : Number((await C.fromOrg(req, 'rh_goals', b.parentId, 'Objectif parent inconnu.')).id);
  if (b.employeeId !== undefined) g.employee_id = b.employeeId === null || b.employeeId === '' ? null : Number((await C.emp(req, b.employeeId)).id);
  if (b.departmentId !== undefined) g.department_id = await C.optRef(req, 'rh_departments', b.departmentId, 'Service inconnu.');
  if (g.level === 'individual' && !g.employee_id) throw new HttpError(400, 'Un objectif individuel doit avoir un titulaire.');
  if (g.level !== 'individual') g.employee_id = null;
  if (g.parent_id != null) {
    const p = await C.fromOrg(req, 'rh_goals', g.parent_id, 'Objectif parent inconnu.');
    const rank = { company: 0, team: 1, individual: 2 };
    if (rank[p.level] >= rank[g.level]) throw new HttpError(400, "L'objectif parent doit être d'un niveau supérieur (entreprise → équipe → individu).");
    if (cur && Number(p.id) === Number(cur.id)) throw new HttpError(400, 'Un objectif ne peut pas être son propre parent.');
  }
  if (g.level === 'company') g.parent_id = null;
  return g;
}
const cols = ['level', 'parent_id', 'employee_id', 'department_id', 'period', 'title', 'description', 'unit', 'start_value', 'target_value', 'due_date', 'weight'];

router.post('/goals', async (req, res) => {
  const b = req.body || {};
  const g = await parse(req, b, null);
  // droits de création
  const priv = await has(req, 'talent');
  if (g.level !== 'individual' && !priv) throw new HttpError(403, "Les objectifs d'entreprise et d'équipe sont définis par les responsables RH.");
  if (g.level === 'individual' && !priv && !(await C.isManagerOf(req, g.employee_id)) && !(await C.isSelf(req, g.employee_id))) throw new HttpError(403, 'Accès non autorisé.');
  const smart = smartOf(g, C.today());
  const status = priv || (await C.isManagerOf(req, g.employee_id)) ? A.oneOf(b.status, ['draft', 'active'], 'draft', 'Statut inconnu.') : 'draft'; // une personne qui se propose un objectif le crée en brouillon
  if (status === 'active' && !smart.isSmart && !b.acceptNonSmart) throw Object.assign(new HttpError(400, "Cet objectif n'est pas SMART : corrigez-le ou confirmez qu'il est accepté en l'état."), { smart });
  const id = Number((await db.prepare(`INSERT INTO rh_goals (org_id, ${cols.join(', ')}, current_value, status, smart_score, created_by, created_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)`).run(req.org.id, ...cols.map((c) => g[c] ?? null), g.start_value, status, smart.score, req.user.id, nowISO())).lastInsertRowid);
  await audit(req, 'goal', id, 'create', null, { title: g.title, level: g.level, smart: smart.score });
  res.status(201).json({ id, smart });
});
router.put('/goals/:id', async (req, res) => {
  const cur = await load(req, req.params.id); const ac = await access(req, cur); const b = req.body || {};
  if (!ac.manage) throw new HttpError(403, 'Accès non autorisé.');
  const g = await parse(req, b, cur);
  const smart = smartOf(g, C.today());
  const status = b.status === undefined ? cur.status : A.oneOf(b.status, STATUS, undefined, 'Statut inconnu.');
  if (status === 'active' && cur.status !== 'active' && !smart.isSmart && !b.acceptNonSmart) throw Object.assign(new HttpError(400, "Cet objectif n'est pas SMART : corrigez-le ou confirmez qu'il est accepté en l'état."), { smart });
  await db.prepare(`UPDATE rh_goals SET ${cols.map((c) => `${c} = ?`).join(', ')}, status = ?, smart_score = ? WHERE id = ?`).run(...cols.map((c) => g[c] ?? null), status, smart.score, cur.id);
  await audit(req, 'goal', cur.id, 'update', { title: cur.title, status: cur.status, target: cur.target_value }, { title: g.title, status, target: g.target_value });
  res.json({ ok: true, smart });
});
router.put('/goals/:id/progress', async (req, res) => {
  const g = await load(req, req.params.id); const ac = await access(req, g);
  if (!ac.progress) throw new HttpError(403, 'Accès non autorisé.');
  if (g.status === 'draft' || g.status === 'cancelled') throw new HttpError(400, "L'avancement se saisit sur un objectif actif.");
  const v = numOrNull((req.body || {}).value, 'Valeur invalide.');
  if (v === null) throw new HttpError(400, 'Indiquez la valeur atteinte.');
  const done = g.target_value != null && ((Number(g.target_value) >= Number(g.start_value) && v >= Number(g.target_value)) || (Number(g.target_value) < Number(g.start_value) && v <= Number(g.target_value)));
  await db.transaction(async () => {
    await db.prepare('UPDATE rh_goals SET current_value = ?, status = ? WHERE id = ?').run(v, done ? 'done' : 'active', g.id);
    await db.prepare('INSERT INTO rh_goal_updates (org_id, goal_id, value, note, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, g.id, v, A.text((req.body || {}).note, 300), req.user.id, nowISO());
  })();
  await audit(req, 'goal', g.id, 'progress', { value: g.current_value }, { value: v });
  res.json({ ok: true, progress: L.goalProgress({ start: g.start_value, target: g.target_value, current: v, status: done ? 'done' : 'active' }), status: done ? 'done' : 'active' });
});
router.get('/goals/:id/history', async (req, res) => {
  const g = await load(req, req.params.id);
  if (!(await access(req, g)).read) throw new HttpError(403, 'Accès non autorisé.');
  const rows = await db.prepare('SELECT * FROM rh_goal_updates WHERE goal_id = ? ORDER BY id').all(g.id);
  res.json({ items: rows.map((u) => ({ value: Number(u.value), note: u.note, at: u.created_at })) });
});
router.delete('/goals/:id', async (req, res) => {
  const g = await load(req, req.params.id);
  if (!(await access(req, g)).manage) throw new HttpError(403, 'Accès non autorisé.');
  await db.prepare('UPDATE rh_goals SET parent_id = NULL WHERE parent_id = ?').run(g.id);
  await db.prepare('DELETE FROM rh_goals WHERE id = ?').run(g.id);
  await audit(req, 'goal', g.id, 'delete', { title: g.title }, null);
  res.json({ ok: true });
});

/** Score de réalisation par personne : Σ pondération × avancement / Σ pondération, sur les objectifs individuels actifs ou atteints de la période. */
async function scoresOf(req, period) {
  const rows = await db.prepare(`SELECT * FROM rh_goals WHERE org_id = ? AND level = 'individual' AND status IN ('active','done')${period ? ' AND period = ?' : ''}`).all(...(period ? [req.org.id, period] : [req.org.id]));
  const nm = await C.names(req); const by = new Map();
  for (const g of rows) { const a = by.get(Number(g.employee_id)) || []; a.push(g); by.set(Number(g.employee_id), a); }
  return [...by.entries()].map(([eid, list]) => {
    const items = list.map((g) => ({ weight: Number(g.weight), progress: L.goalProgress({ start: g.start_value, target: g.target_value, current: g.current_value, status: g.status }) }));
    return { employeeId: eid, employee: nm.get(eid) || '', goals: list.length, weightTotal: items.reduce((s, x) => s + x.weight, 0), score: L.goalScore(items), done: list.filter((g) => g.status === 'done').length };
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
router.get('/goals-scores', async (req, res) => {
  const period = req.query.period ? String(req.query.period).slice(0, 40) : null;
  let items = await scoresOf(req, period);
  if (!(await has(req, 'talent'))) { const rep = new Set(await C.reports(req)); const me = await C.meEmp(req); items = items.filter((i) => rep.has(i.employeeId) || (me && i.employeeId === Number(me.id))); }
  const sc = items.filter((i) => i.score !== null).map((i) => i.score);
  res.json({ items, average: sc.length ? L.r1(L.avg(sc)) : null });
});

module.exports = router;
module.exports.scoresOf = scoresOf;
