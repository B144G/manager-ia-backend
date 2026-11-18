'use strict';
// Production · circuits (workflows) : modèle proposé par secteur, circuit personnalisé, analyse des failles et risques, solutions applicables.
// Déclaré AVANT production.js (voir index.js). Calculs dans prod-flow-lib.js. Tout membre consulte ; les responsables créent, modifient et appliquent.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const F = require('./prod-flow-lib');
const Lean = require('./prod-lean-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const Q = require('./prod-quality-lib');
/** Liens avec les autres techniques (lecture seule) : machines couvertes par un plan de maintenance, TRS des machines, plans de contrôle qualité. */
async function linkCtx(req) {
  const docs = {};
  for (const r of await db.prepare("SELECT kind, data FROM production_docs WHERE org_id = ? AND kind IN ('tpm', 'quality')").all(req.org.id)) docs[r.kind] = JSON.parse(r.data || '{}');
  const covered = new Set(); const oee = {};
  if (docs.tpm) { try { for (const m of Q.computeTpm(Q.cleanTpm(docs.tpm)).machines) { if (m.hasPlan) covered.add(m.name.toLowerCase()); oee[m.name.toLowerCase()] = m.oee; } } catch { /* document abîmé */ } }
  for (const e of await db.prepare('SELECT DISTINCT e.name FROM maintenance_equipment e JOIN maintenance_plans p ON p.equipment_id = e.id WHERE e.org_id = ?').all(req.org.id)) covered.add(String(e.name).toLowerCase());
  let plans = null; if (docs.quality) { try { plans = Q.cleanQuality(docs.quality).plans.length; } catch { plans = null; } }
  return { maintenance: [...covered], oee, qualityPlans: plans };
}
const json = (s, def) => { try { return JSON.parse(s); } catch { return def; } };

async function members(req) {
  return (await db.prepare('SELECT u.id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name').all(req.org.id)).map((u) => ({ userId: Number(u.id), name: u.name }));
}
async function flowOf(req, id) {
  const f = await db.prepare('SELECT * FROM production_flows WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!f) throw new HttpError(404, 'Circuit introuvable.');
  return f;
}
const settingsOf = (f) => ({ targetPerDay: Number(f.target_per_day), hoursPerDay: Number(f.hours_per_day), extra: Lean.cleanExtra(json(f.extra, {})) });
async function view(req, f, mem) {
  const m = mem || await members(req);
  const steps = json(f.steps, []); const dismissed = json(f.dismissed, []);
  const a = F.analyze(steps, settingsOf(f), { members: m, ...(await linkCtx(req)) }, dismissed);
  const name = new Map(m.map((x) => [x.userId, x.name]));
  const calc = new Map(a.steps.map((r) => [r.id, r]));
  return {
    id: Number(f.id), name: f.name, sector: f.sector, source: f.source, targetPerDay: Number(f.target_per_day), hoursPerDay: Number(f.hours_per_day), extra: Lean.cleanExtra(json(f.extra, {})), updatedAt: f.updated_at,
    steps: steps.map((s) => ({ ...s, owner: s.ownerId == null ? null : name.get(s.ownerId) || null, backup: s.backupId == null ? null : name.get(s.backupId) || null, ...(calc.get(s.id) || {}) })),
    analysis: { score: a.score, level: a.level, findings: a.findings, metrics: a.metrics },
  };
}
function readSettings(b, old) {
  const o = old || { targetPerDay: 1, hoursPerDay: 8, extra: Lean.cleanExtra({}) };
  const t = b.targetPerDay === undefined ? o.targetPerDay : Number(String(b.targetPerDay).replace(',', '.'));
  const h = b.hoursPerDay === undefined ? o.hoursPerDay : Number(String(b.hoursPerDay).replace(',', '.'));
  if (!Number.isFinite(t) || t <= 0 || t > 100000) throw new HttpError(400, 'Objectif par jour : un nombre de lots supérieur à 0.');
  if (!Number.isFinite(h) || h < 0.5 || h > 24) throw new HttpError(400, 'Heures de travail par jour : entre 0,5 et 24.');
  return { targetPerDay: t, hoursPerDay: h, extra: b.extra === undefined ? o.extra : Lean.cleanExtra(b.extra) };
}
async function checkOwners(req, steps) {
  const ids = new Set(); for (const s of steps) { if (s.ownerId !== null) ids.add(s.ownerId); if (s.backupId !== null) ids.add(s.backupId); }
  for (const id of ids) await A.memberOf(req, id);
}
function cleaned(raw) { try { return F.cleanSteps(raw); } catch (e) { throw new HttpError(400, e.message); } }

router.get('/templates', (req, res) => res.json({ sectors: F.SECTORS.map((s) => ({ id: s, steps: F.template(s) })) }));

router.get('/', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM production_flows WHERE org_id = ? ORDER BY id DESC').all(req.org.id);
  const mem = await members(req);
  const items = [];
  for (const f of rows) { const v = await view(req, f, mem); items.push({ id: v.id, name: v.name, sector: v.sector, source: v.source, steps: v.steps.length, score: v.analysis.score, level: v.analysis.level, open: v.analysis.metrics.openFindings, high: v.analysis.metrics.high }); }
  res.json({ items });
});

router.post('/', mgr, async (req, res) => {
  const b = req.body || {};
  const sector = A.oneOf(b.sector, F.SECTORS, 'general', 'Secteur inconnu.');
  const name = A.text(b.name, 120, { required: true, msg: 'Donnez un nom au circuit.' });
  const fromTemplate = b.template !== false && !Array.isArray(b.steps);
  const steps = fromTemplate ? F.template(sector) : cleaned(b.steps);
  await checkOwners(req, steps);
  const s = readSettings(b);
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM production_flows WHERE org_id = ?').get(req.org.id)).c);
  if (n >= 20) throw new HttpError(400, '20 circuits au plus : supprimez-en un avant d\'en ajouter.');
  const now = nowISO();
  const id = Number((await db.prepare('INSERT INTO production_flows (org_id, name, sector, source, target_per_day, hours_per_day, extra, steps, dismissed, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, name, sector, fromTemplate ? 'template' : 'custom', s.targetPerDay, s.hoursPerDay, JSON.stringify(s.extra), JSON.stringify(steps), '[]', req.user.id, now, now)).lastInsertRowid);
  await W.audit(req, 'production_flow', id, 'create', null, { sector, source: fromTemplate ? 'template' : 'custom' });
  res.status(201).json(await view(req, await flowOf(req, id)));
});

/** Lean (cartographie de flux), TOC et JIT d'un circuit : calculés à partir des étapes et de leurs champs facultatifs. */
router.get('/:id/:tech(lean|toc|jit)', async (req, res) => {
  const f = await flowOf(req, req.params.id); const steps = json(f.steps, []); const st = settingsOf(f);
  const out = req.params.tech === 'lean' ? Lean.lean(steps, st) : req.params.tech === 'toc' ? Lean.toc(steps, st, st.extra) : Lean.jit(steps, st);
  const mem = await members(req);
  res.json({ ...out, flow: { id: Number(f.id), name: f.name, targetPerDay: st.targetPerDay, hoursPerDay: st.hoursPerDay, extra: st.extra }, score: F.analyze(steps, st, { members: mem, ...(await linkCtx(req)) }, json(f.dismissed, [])).score });
});

router.get('/:id', async (req, res) => res.json(await view(req, await flowOf(req, req.params.id))));

router.put('/:id', mgr, async (req, res) => {
  const f = await flowOf(req, req.params.id); const b = req.body || {};
  const name = b.name === undefined ? f.name : A.text(b.name, 120, { required: true, msg: 'Donnez un nom au circuit.' });
  const steps = b.steps === undefined ? json(f.steps, []) : cleaned(b.steps);
  await checkOwners(req, steps);
  const s = readSettings(b, settingsOf(f));
  // Les avis écartés qui n'existent plus sont oubliés (la clé change si les étapes changent).
  await db.prepare('UPDATE production_flows SET name = ?, target_per_day = ?, hours_per_day = ?, extra = ?, steps = ?, source = ?, updated_at = ? WHERE id = ?')
    .run(name, s.targetPerDay, s.hoursPerDay, JSON.stringify(s.extra), JSON.stringify(steps), f.source === 'template' && b.steps !== undefined ? 'custom' : f.source, nowISO(), f.id);
  await W.audit(req, 'production_flow', f.id, 'update', null, { steps: steps.length });
  res.json(await view(req, await flowOf(req, f.id)));
});

router.delete('/:id', mgr, async (req, res) => {
  const f = await flowOf(req, req.params.id);
  await db.prepare('DELETE FROM production_flows WHERE id = ?').run(f.id);
  await W.audit(req, 'production_flow', f.id, 'delete', { name: f.name }, null);
  res.json({ ok: true });
});

/** Applique une solution proposée pour un avis (clé stable). */
router.post('/:id/apply', mgr, async (req, res) => {
  const f = await flowOf(req, req.params.id); const b = req.body || {};
  const mem = await members(req);
  const steps = json(f.steps, []);
  const a = F.analyze(steps, settingsOf(f), { members: mem, ...(await linkCtx(req)) }, json(f.dismissed, []));
  const finding = a.findings.find((x) => x.key === String(b.key || ''));
  if (!finding) throw new HttpError(404, 'Cet avis n\'existe plus : le circuit a changé.');
  let out;
  try { out = F.applySolution(steps, settingsOf(f), finding, String(b.solution || ''), { members: mem, sector: f.sector }); } catch (e) { throw new HttpError(400, e.message); }
  await db.prepare('UPDATE production_flows SET target_per_day = ?, steps = ?, source = ?, updated_at = ? WHERE id = ?')
    .run(out.settings.targetPerDay, JSON.stringify(out.steps), 'custom', nowISO(), f.id);
  await W.audit(req, 'production_flow', f.id, 'apply', null, { key: finding.key, solution: b.solution });
  res.json(await view(req, await flowOf(req, f.id), mem));
});
router.post('/:id/dismiss', mgr, async (req, res) => {
  const f = await flowOf(req, req.params.id); const key = A.text((req.body || {}).key, 200, { required: true });
  const list = json(f.dismissed, []);
  if ((req.body || {}).restore) { await db.prepare('UPDATE production_flows SET dismissed = ? WHERE id = ?').run(JSON.stringify(list.filter((k) => k !== key)), f.id); }
  else if (!list.includes(key)) { list.push(key); await db.prepare('UPDATE production_flows SET dismissed = ? WHERE id = ?').run(JSON.stringify(list.slice(-200)), f.id); }
  await W.audit(req, 'production_flow', f.id, (req.body || {}).restore ? 'restore' : 'dismiss', null, { key });
  res.json(await view(req, await flowOf(req, f.id)));
});

module.exports = router;
