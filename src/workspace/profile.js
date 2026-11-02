'use strict';
// Profil de l'entreprise : l'ERP apprend l'entreprise de chaque client par petites questions à boutons (une à la fois, « Passer » toujours possible).
// Les réponses alimentent l'IA de chaque module, règlent le type de passation à un humain et indiquent ce que chaque offre débloque.
// Rien n'est inventé : une question sans réponse reste « inconnue ». Lecture : tout membre ; réponse : responsable ou plus.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const F = require('./features');
const { Q, byId, labelOf } = require('./profile-questions');
const { HttpError, asyncHandler, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const KIND_TO_HANDOFF = { goods: 'order', service: 'service', school: 'prospect', industry: 'order', btp: 'service' };

async function load(orgId) {
  const r = await db.prepare('SELECT * FROM org_profile WHERE org_id = ?').get(orgId);
  const parse = (t, d) => { try { return JSON.parse(t); } catch { return d; } };
  return { answers: r ? parse(r.answers, {}) : {}, skipped: r ? parse(r.skipped, []) : [] };
}
const save = async (orgId, p) => await db.prepare(`INSERT INTO org_profile (org_id, answers, skipped, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (org_id) DO UPDATE SET answers = EXCLUDED.answers, skipped = EXCLUDED.skipped, updated_at = EXCLUDED.updated_at`).run(orgId, JSON.stringify(p.answers), JSON.stringify(p.skipped), nowISO());

const applies = (q, answers) => !q.kinds || (answers.kind && q.kinds.includes(answers.kind));
const hasAnswer = (answers, id) => answers[id] !== undefined && !(Array.isArray(answers[id]) && !answers[id].length);

/** Prochaine question : d'abord celles de l'inscription, puis les autres ; jamais une question passée ou déjà répondue. */
function nextQuestion(p) {
  const open = Q.filter((q) => applies(q, p.answers) && !hasAnswer(p.answers, q.id) && !p.skipped.includes(q.id));
  return open.find((q) => q.tier === 'start') || open[0] || null;
}
const view = (q) => q && { id: q.id, ask: q.ask, hint: q.hint || '', multi: q.type === 'many', options: q.options.map(([value, label]) => ({ value, label })) };

async function summary(org) {
  const p = await load(org.id);
  const app = Q.filter((q) => applies(q, p.answers));
  const done = app.filter((q) => hasAnswer(p.answers, q.id));
  const plan = await A.ownerPlan(org);
  const features = Object.entries(F.FEATURES).map(([key, [minPlan, label, needs]]) => ({
    key, label, plan: minPlan, included: F.allowed(plan, key),
    missing: needs.filter((id) => byId[id] && applies(byId[id], p.answers) !== false && !hasAnswer(p.answers, id)).map((id) => byId[id].ask),
  }));
  return {
    score: app.length ? Math.round((done.length / app.length) * 100) : 0, answered: done.length, total: app.length,
    onboarding: Q.filter((q) => q.tier === 'start').every((q) => hasAnswer(p.answers, q.id) || p.skipped.includes(q.id)) ? 'done' : 'todo',
    next: view(nextQuestion(p)),
    answers: done.map((q) => ({ id: q.id, ask: q.ask, value: p.answers[q.id], label: labelOf(q, p.answers[q.id]) })),
    skipped: p.skipped.filter((id) => byId[id] && applies(byId[id], p.answers) && !hasAnswer(p.answers, id)).map((id) => view(byId[id])),
    plan, gating: F.gatingOn(), features,
  };
}

router.get('/', asyncHandler(async (req, res) => res.json(await summary(req.org))));

router.post('/answer', A.need('manager'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const q = byId[b.id];
  if (!q) throw new HttpError(400, 'Question inconnue.');
  const p = await load(req.org.id);
  if (!applies(q, p.answers)) throw new HttpError(400, "Cette question ne concerne pas votre type d'entreprise.");
  const raw = q.type === 'many' ? (Array.isArray(b.value) ? b.value : [b.value]) : [b.value];
  const valid = [...new Set(raw.map(String))].filter((v) => q.options.some((o) => o[0] === v));
  if (!valid.length || valid.length !== raw.length) throw new HttpError(400, 'Choisissez une des réponses proposées.');
  const prev = p.answers[q.id];
  p.answers[q.id] = q.type === 'many' ? valid : valid[0];
  p.skipped = p.skipped.filter((x) => x !== q.id);
  // Changer d'activité rend caduques les réponses qui ne concernent plus ce type d'entreprise
  if (q.id === 'kind' && prev !== p.answers.kind) for (const o of Q) if (o.kinds && !o.kinds.includes(p.answers.kind)) delete p.answers[o.id];
  await save(req.org.id, p);
  if (q.id === 'kind') {
    await db.prepare('UPDATE orgs SET handoff_kind = ?, sector = CASE WHEN sector = \'\' THEN ? ELSE sector END WHERE id = ?').run(KIND_TO_HANDOFF[p.answers.kind] || 'auto', oneLine(labelOf(q, p.answers.kind), 100), req.org.id);
  }
  await A.logActivity(req.org.id, req.user.id, 'structure', 'Profil de l\'entreprise mis à jour');
  res.json(await summary({ ...req.org }));
}));

router.post('/skip', A.need('manager'), asyncHandler(async (req, res) => {
  const q = byId[(req.body || {}).id];
  if (!q) throw new HttpError(400, 'Question inconnue.');
  const p = await load(req.org.id);
  if (!p.skipped.includes(q.id)) p.skipped.push(q.id);
  await save(req.org.id, p);
  res.json(await summary(req.org));
}));

/** Texte donné à l'IA (jamais d'invention : seulement ce qui a été répondu). pub = seulement ce qui peut être dit à un client. */
async function contextText(orgId, pub = false) {
  const p = await load(orgId);
  const lines = Q.filter((q) => hasAnswer(p.answers, q.id) && (!pub || q.pub)).map((q) => `${pub ? q.pub : q.ctx} : ${labelOf(q, p.answers[q.id])}`);
  if (!lines.length) return '';
  return pub ? `Informations confirmées par l'entreprise : ${lines.join(' ; ')}.` : `Profil de l'entreprise (réponses du dirigeant, le reste est inconnu : ne le devine pas) : ${lines.join(' ; ')}.`;
}

module.exports = { router, contextText, load, summary };
