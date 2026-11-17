'use strict';
// Stock entrepôt (WMS) — productivité des magasiniers (4E).
// Chaque opération notée dans wms_labor (qui, quand, type, lignes, unités) reçoit une durée :
//   durée = temps écoulé depuis l'opération précédente de la même personne le même jour, si cet écart ne dépasse pas le seuil d'inactivité
//           (réglage « laborIdleMinutes », 10 min par défaut) ; sinon (première opération de la journée, reprise après une pause),
//           on compte le temps standard de la tâche × le nombre de lignes.
// Indicateurs : lignes / heure = lignes ÷ heures ; unités / heure = unités ÷ heures ; temps par ligne = secondes ÷ lignes ;
//               performance % = temps standard gagné (Σ lignes × standard de la tâche) ÷ temps réel × 100.
// Confidentialité : les chiffres par personne et le classement sont réservés aux responsables ; chacun voit les siens (« /labor/me »).
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const P = require('./wms-pilot');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r1 = P.round1;

/** Durée (secondes) de chaque opération, selon la règle ci-dessus. rows triées par personne puis par heure. */
function timed(rows, pilot) {
  const cap = Number(pilot.laborIdleMinutes) * 60;
  let prev = null;
  return rows.map((r) => {
    const at = Date.parse(r.at);
    const std = Number(pilot.standards[r.task] || 0) * Number(r.lines);
    const same = prev && Number(prev.user_id) === Number(r.user_id) && prev.at.slice(0, 10) === r.at.slice(0, 10);
    const gap = same ? (at - Date.parse(prev.at)) / 1000 : null;
    prev = r;
    return { ...r, lines: Number(r.lines), units: Number(r.units), seconds: gap !== null && gap <= cap ? Math.max(0, gap) : std, earned: std };
  });
}
function agg(list) {
  const lines = list.reduce((s, x) => s + x.lines, 0); const units = list.reduce((s, x) => s + x.units, 0);
  const seconds = list.reduce((s, x) => s + x.seconds, 0); const earned = list.reduce((s, x) => s + x.earned, 0);
  const h = seconds / 3600;
  return {
    operations: list.length, lines, units: Math.round(units * 1000) / 1000, seconds: Math.round(seconds), hours: P.round2(h),
    linesPerHour: h > 0 ? r1(lines / h) : null, unitsPerHour: h > 0 ? r1(units / h) : null,
    secondsPerLine: lines > 0 ? r1(seconds / lines) : null, performance: seconds > 0 ? r1((100 * earned) / seconds) : null,
  };
}
const groupBy = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };

async function eventsOf(orgId, per, userId) {
  return db.prepare(`SELECT l.*, u.name FROM wms_labor l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? AND l.at >= ? AND l.at < ?${userId ? ' AND l.user_id = ?' : ''} ORDER BY l.user_id, l.at, l.id`)
    .all(orgId, per.start, per.end, ...(userId ? [userId] : []));
}
function byTask(list, pilot) {
  const g = groupBy(list, (x) => x.task);
  return Object.keys(P.TASKS).filter((k) => g.has(k)).map((k) => ({ task: k, label: P.TASKS[k], standard: Number(pilot.standards[k]), ...agg(g.get(k)) }));
}
function byDay(list) {
  const g = groupBy(list, (x) => x.at.slice(0, 10));
  return [...g.keys()].sort().map((d) => ({ day: d, ...agg(g.get(d)) }));
}
function byPerson(list) {
  const g = groupBy(list, (x) => Number(x.user_id));
  return [...g.entries()].map(([uid, l]) => ({ userId: uid, name: l[0].name || '—', days: new Set(l.map((x) => x.at.slice(0, 10))).size, ...agg(l) })).sort((a, b) => b.lines - a.lines || a.userId - b.userId);
}
/** Lignes par heure de la journée (0 à 23, heure UTC). */
function byHour(list) {
  const h = Array.from({ length: 24 }, (_, i) => ({ hour: i, lines: 0, units: 0 }));
  for (const x of list) { const k = Number(x.at.slice(11, 13)); h[k].lines += x.lines; h[k].units = Math.round((h[k].units + x.units) * 1000) / 1000; }
  return h;
}
async function summary(orgId, per, userId) {
  const pilot = await P.pilotOf(orgId);
  const list = timed(await eventsOf(orgId, per, userId), pilot);
  return { list, pilot, out: { from: per.from, to: per.to, totals: { ...agg(list), people: new Set(list.map((x) => Number(x.user_id))).size }, byTask: byTask(list, pilot), byDay: byDay(list), byHour: per.days === 1 ? byHour(list) : undefined } };
}

router.get('/labor/tasks', (req, res) => res.json({ tasks: P.TASKS }));
router.get('/labor/summary', mgr, async (req, res) => {
  const per = P.period(req.query, 7);
  const userId = req.query.userId ? A.id(req.query.userId) : null;
  const { list, out } = await summary(req.org.id, per, userId);
  const people = byPerson(list);
  // Détail par personne et par jour (responsables seulement).
  for (const p of people) p.byDay = byDay(list.filter((x) => Number(x.user_id) === p.userId));
  res.json({ ...out, byPerson: people });
});
/** Mes propres chiffres : tout le monde (jamais ceux des autres). */
router.get('/labor/me', async (req, res) => {
  const per = P.period(req.query, 7);
  const { out } = await summary(req.org.id, per, req.user.id);
  res.json(out);
});
/** Classement : responsables seulement. Les personnes sous le minimum de lignes n'y figurent pas (pas de jugement sur trop peu de données) ;
 *  ?anonymous=1 remplace les noms par des numéros (affichage en salle de pause, par exemple). */
router.get('/labor/leaderboard', mgr, async (req, res) => {
  const per = P.period(req.query, 7);
  const { list, pilot } = await summary(req.org.id, per);
  const minLines = req.query.minLines === undefined || req.query.minLines === '' ? Number(pilot.laborMinLines) : A.qty(req.query.minLines, { allowZero: true });
  const anon = String(req.query.anonymous || '') === '1';
  const all = byPerson(list);
  const ranked = all.filter((p) => p.lines >= minLines && p.performance !== null).sort((a, b) => b.performance - a.performance || b.linesPerHour - a.linesPerHour || a.userId - b.userId);
  res.json({
    from: per.from, to: per.to, minLines, hidden: all.length - ranked.length,
    ranking: ranked.map((p, i) => ({ rank: i + 1, userId: anon ? undefined : p.userId, name: anon ? `#${i + 1}` : p.name, lines: p.lines, units: p.units, hours: p.hours, linesPerHour: p.linesPerHour, unitsPerHour: p.unitsPerHour, performance: p.performance })),
  });
});
router.get('/labor/standards', async (req, res) => {
  const pilot = await P.pilotOf(req.org.id);
  res.json({ tasks: P.TASKS, standards: pilot.standards, defaults: P.STANDARDS, idleMinutes: pilot.laborIdleMinutes, minLines: pilot.laborMinLines });
});
router.put('/labor/standards', mgr, async (req, res) => {
  const b = req.body || {};
  const cur = await P.pilotOf(req.org.id);
  const standards = { ...cur.standards };
  for (const [k, v] of Object.entries(b.standards || {})) {
    if (!P.TASKS[k]) throw new HttpError(400, 'Type de tâche inconnu.');
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < 1 || n > 3600) throw new HttpError(400, 'Temps standard : un nombre de secondes par ligne, de 1 à 3600.');
    standards[k] = Math.round(n * 10) / 10;
  }
  const patch = { standards };
  if (b.idleMinutes !== undefined && b.idleMinutes !== '') {
    const n = Number(b.idleMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new HttpError(400, "Seuil d'inactivité : un nombre entier de minutes, de 1 à 120.");
    patch.laborIdleMinutes = n;
  }
  if (b.minLines !== undefined && b.minLines !== '') {
    const n = Number(b.minLines);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new HttpError(400, 'Minimum de lignes pour le classement : un nombre entier positif.');
    patch.laborMinLines = n;
  }
  const p = await P.savePilot(req.org.id, patch);
  res.json({ ok: true, standards: p.standards, idleMinutes: p.laborIdleMinutes, minLines: p.laborMinLines });
});

module.exports = router;
module.exports.summary = summary;
module.exports.timed = timed;
module.exports.agg = agg;
