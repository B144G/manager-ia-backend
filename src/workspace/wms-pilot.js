'use strict';
// Stock entrepôt (WMS) — pilotage (4E) : aides communes. Aucune route ici.
// - Réglages du pilotage (gardés dans wms_settings.data.pilot) : distances pour l'optimisation des emplacements, temps standards
//   des tâches pour la productivité, heures d'ouverture des quais.
// - Journal de productivité (wms_labor) : chaque opération d'entrepôt (prélèvement, rangement, emballage, chargement, réapprovisionnement,
//   comptage, réception, déplacement) y note qui l'a faite, quand, et combien de lignes et d'unités.
const { db, nowISO } = require('../db');
const W = require('./wms-core');
const { HttpError } = require('../util');

/** Types de tâches suivies, avec leur temps standard par défaut (secondes par ligne). */
const TASKS = {
  pick: 'Prélèvement', putaway: 'Rangement', pack: 'Emballage', load: 'Chargement', replenish: 'Réapprovisionnement',
  count: 'Comptage', receive: 'Réception', slotting: "Optimisation d'emplacement", move: 'Déplacement',
};
const STANDARDS = { pick: 60, putaway: 90, pack: 30, load: 60, replenish: 120, count: 30, receive: 60, slotting: 120, move: 90 };
const PILOT_DEFAULTS = {
  slotDays: 90, aislePitch: 5, rackPitch: 1, heavyKg: 20, heavyMaxLevel: 0, aisleDistances: {},
  laborIdleMinutes: 10, laborMinLines: 10,
  yardHoursPerDay: 12, yardTolerance: 15, yardWaitAlert: 30,
};

async function rawSettings(orgId) {
  await W.ensure(orgId);
  const row = await db.prepare('SELECT data FROM wms_settings WHERE org_id = ?').get(orgId);
  try { return JSON.parse(row.data) || {}; } catch { return {}; }
}
async function pilotOf(orgId) {
  const d = (await rawSettings(orgId)).pilot || {};
  return { ...PILOT_DEFAULTS, ...d, aisleDistances: { ...(d.aisleDistances || {}) }, standards: { ...STANDARDS, ...(d.standards || {}) } };
}
/** Enregistre une partie des réglages du pilotage (lecture, fusion, écriture sous verrou de la ligne). */
async function savePilot(orgId, patch) {
  return db.transaction(async () => {
    const row = await db.prepare('SELECT data FROM wms_settings WHERE org_id = ? FOR UPDATE').get(orgId);
    let d = {}; try { d = JSON.parse(row.data) || {}; } catch { d = {}; }
    d.pilot = { ...(d.pilot || {}), ...patch };
    await db.prepare('UPDATE wms_settings SET data = ? WHERE org_id = ?').run(JSON.stringify(d), orgId);
    return pilotOf(orgId);
  })();
}

/** Note une opération dans le journal de productivité. Ne bloque jamais l'opération elle-même. */
async function record(req, task, { lines = 1, units = 0, refKind = '', refId = null, at } = {}) {
  if (!TASKS[task] || !req || !req.user || !req.org) return;
  await db.prepare('INSERT INTO wms_labor (org_id, user_id, task, lines, units, ref_kind, ref_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, req.user.id, task, Math.max(0, Math.round(Number(lines) || 0)), W.round3(Math.max(0, Number(units) || 0)), String(refKind || ''), refId === null || refId === undefined ? null : Number(refId), at || nowISO());
}

// ---------- Périodes ----------
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00.000Z') + n * 86400000).toISOString().slice(0, 10);
/** Période en jours UTC (bornes incluses) : ?from=AAAA-MM-JJ&to=AAAA-MM-JJ, sinon les `def` derniers jours. Renvoie { from, to, start, end, days }. */
function period(q, def = 1) {
  const today = W.today();
  const to = q.to === undefined || q.to === '' ? today : String(q.to);
  const from = q.from === undefined || q.from === '' ? addDays(to, -(def - 1)) : String(q.from);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new HttpError(400, 'Date invalide (format AAAA-MM-JJ).');
  if (from > to) throw new HttpError(400, 'La date de début doit précéder la date de fin.');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > 366) throw new HttpError(400, 'Choisissez une période d\'un an au plus.');
  return { from, to, start: from + 'T00:00:00.000Z', end: addDays(to, 1) + 'T00:00:00.000Z', days };
}
/** Date et heure ISO (avec fuseau, ou UTC si absent) → ISO UTC normalisé. */
function isoOf(v, msg = 'Date et heure invalides.') {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) throw new HttpError(400, msg);
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
  if (Number.isNaN(t)) throw new HttpError(400, msg);
  return new Date(t).toISOString();
}
const minutes = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 60000 : null);
const round1 = (n) => Math.round(Number(n) * 10) / 10;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

module.exports = { TASKS, STANDARDS, PILOT_DEFAULTS, pilotOf, savePilot, record, period, addDays, isoOf, minutes, round1, round2 };
