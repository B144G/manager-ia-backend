'use strict';
// Projets · finances : CBS (structure des coûts), ABC (coûts par activités), ROI / VAN / TRI, budget prévisionnel mensuel, analyse des écarts.
// La valeur acquise (EVM : PV, EV, AC, CPI, SPI, EAC) est calculée par projects-pro.js ; on la reprend ici pour tout voir au même endroit.
// Droits : réservé aux responsables (montants). Calculs dans proj-fin-lib.js.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const Pro = require('./projects-pro');
const F = require('./proj-fin-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const KINDS = Object.keys(F.CLEAN);
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

async function projectOf(req, id) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(404, 'Projet introuvable.');
  return p;
}
const EMPTY = { cbs: { lines: [] }, abc: { activities: [], objects: [] }, roi: { investment: 0, residual: 0, discountRate: 10, flows: [], unit: 'an' }, forecast: { periods: [] } };

async function actualsByMonth(req, p) {
  const out = {};
  const rows = await db.prepare('SELECT date, amount FROM project_costs WHERE project_id = ? AND org_id = ?').all(p.id, req.org.id);
  for (const r of rows) { const m = String(r.date || '').slice(0, 7); if (m.length === 7) out[m] = (out[m] || 0) + Number(r.amount); }
  const rate = Number((await W.settings(req.org.id)).project_hourly_cost) || 0;
  if (rate > 0) for (const h of await db.prepare('SELECT day, hours FROM time_entries WHERE org_id = ? AND project_id = ?').all(req.org.id, p.id)) { const m = String(h.day || '').slice(0, 7); if (m.length === 7) out[m] = (out[m] || 0) + Number(h.hours) * rate; }
  return out;
}

router.get('/:id/fin', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const rows = await db.prepare('SELECT kind, data, updated_at FROM project_fin_docs WHERE project_id = ? AND org_id = ?').all(p.id, req.org.id);
  const docs = JSON.parse(JSON.stringify(EMPTY)); const updated = {};
  for (const r of rows) if (KINDS.includes(r.kind)) { docs[r.kind] = json(r.data, EMPTY[r.kind]); updated[r.kind] = r.updated_at; }
  const a = await Pro.analyze(req.org.id, p);
  const month = W.today().slice(0, 7);
  const actual = await actualsByMonth(req, p);
  const cbs = F.cbsAnalyze(F.CLEAN.cbs(docs.cbs));
  const m = a.metrics;
  res.json({
    project: { id: p.id, name: p.name, budget: Number(p.budget) || 0, start: a.project.start, end: a.project.end, due: p.due || null, kind: p.kind || 'general' },
    docs, updated,
    cbs, abc: F.abcAnalyze(F.CLEAN.abc(docs.abc)), roi: F.roiAnalyze(F.CLEAN.roi(docs.roi)), forecast: F.forecastAnalyze(F.CLEAN.forecast(docs.forecast), actual, month),
    evm: { mode: m.mode, bac: m.bac, pv: m.pv, ev: m.ev, ac: m.ac, sv: m.sv, cv: m.cv, spi: m.spi, cpi: m.cpi, eac: m.eac, etc: m.etc, vac: m.vac, tcpi: m.tcpi, percentComplete: m.percentComplete, percentPlanned: m.percentPlanned },
    // Dépenses réelles du projet qui ne figurent dans aucune ligne de la structure des coûts.
    unallocated: m.mode === 'money' ? Math.round(Number(m.ac) - cbs.totals.actual) : null,
    month,
  });
});

router.put('/:id/fin/:kind', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const kind = A.oneOf(req.params.kind, KINDS, undefined, 'Type de document inconnu.');
  let doc; try { doc = F.CLEAN[kind](req.body || {}); } catch (e) { throw new HttpError(400, e.message); }
  await db.prepare('INSERT INTO project_fin_docs (project_id, org_id, kind, data, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at')
    .run(p.id, req.org.id, kind, JSON.stringify(doc), req.user.id, nowISO());
  await W.audit(req, 'project_fin', p.id, kind, null, { size: JSON.stringify(doc).length });
  res.json({ ok: true });
});

module.exports = router;
