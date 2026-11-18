'use strict';
// Aides communes du module Commercial : réglages de l'organisation, étapes par défaut du pipeline, noms des personnes.
const { db, nowISO } = require('../../db');
const L = require('./lib');
const A = require('../access');
const { HttpError } = require('../../util');

const today = () => nowISO().slice(0, 10);
const N = (v) => Number(v) || 0;

async function settings(orgId) {
  const r = await db.prepare('SELECT data FROM cp_settings WHERE org_id = ?').get(orgId);
  let d = {}; try { d = r ? JSON.parse(r.data) : {}; } catch { d = {}; }
  return L.mergeSettings(d);
}
async function saveSettings(orgId, patch) {
  const cur = await settings(orgId);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in L.DEFAULTS)) continue;
    next[k] = typeof L.DEFAULTS[k] === 'object' ? { ...cur[k], ...Object.fromEntries(Object.entries(v || {}).map(([a, b]) => [a, N(b)])) } : N(v);
  }
  await db.prepare('INSERT INTO cp_settings (org_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(orgId, JSON.stringify(next), nowISO());
  return next;
}

const DEFAULT_STAGES = [
  { name: 'Nouveau', probability: 10, kind: 'open', min_bant: 0, stagnant_days: 7 },
  { name: 'Qualification', probability: 25, kind: 'open', min_bant: 0, stagnant_days: 10 },
  { name: 'Proposition', probability: 50, kind: 'open', min_bant: 40, stagnant_days: 14 },
  { name: 'Négociation', probability: 75, kind: 'open', min_bant: 60, stagnant_days: 14 },
  { name: 'Gagné', probability: 100, kind: 'won', min_bant: 0, stagnant_days: 0 },
  { name: 'Perdu', probability: 0, kind: 'lost', min_bant: 0, stagnant_days: 0 },
];
const DEFAULT_REASONS = [['win', 'Meilleur prix'], ['win', 'Qualité du produit'], ['win', 'Relation de confiance'], ['win', 'Rapidité de livraison'],
  ['loss', 'Prix trop élevé'], ['loss', 'Concurrent choisi'], ['loss', 'Budget gelé'], ['loss', 'Pas de réponse'], ['loss', 'Besoin disparu'], ['loss', 'Délai trop long']];
/** Crée les étapes et motifs par défaut la première fois (et seulement si l'organisation n'en a aucun). */
async function ensureDefaults(orgId) {
  const n = N((await db.prepare('SELECT COUNT(*) c FROM cp_stages WHERE org_id = ?').get(orgId)).c);
  if (n) return;
  const now = nowISO();
  await db.transaction(async () => {
    const again = N((await db.prepare('SELECT COUNT(*) c FROM cp_stages WHERE org_id = ?').get(orgId)).c);
    if (again) return;
    let i = 0;
    for (const s of DEFAULT_STAGES) await db.prepare('INSERT INTO cp_stages (org_id, name, position, probability, kind, min_bant, stagnant_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(orgId, s.name, i++, s.probability, s.kind, s.min_bant, s.stagnant_days, now);
    for (const [k, l] of DEFAULT_REASONS) await db.prepare('INSERT INTO cp_reasons (org_id, kind, label, created_at) VALUES (?, ?, ?, ?)').run(orgId, k, l, now);
  })();
}

async function names(orgId) {
  const rows = await db.prepare('SELECT m.user_id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?').all(orgId);
  return new Map(rows.map((r) => [Number(r.user_id), r.name]));
}
/** Les lignes sortent de la base avec des BIGINT parfois en texte : conversion des colonnes numériques d'une ligne. */
const nums = (row, cols) => { const o = { ...row }; for (const c of cols) if (o[c] !== null && o[c] !== undefined) o[c] = Number(o[c]); return o; };
const pageLimit = (v, def = 200, max = 500) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);
const chk = (cond, msg, status = 400) => { if (!cond) throw new HttpError(status, msg); };
const ymd = (v, msg) => A.date(v) || (msg ? (() => { throw new HttpError(400, msg); })() : null);
const range = (q) => {
  const to = A.date(q.to) || today();
  const from = A.date(q.from) || L.addDays(to, -90);
  if (from > to) throw new HttpError(400, 'La date de début est après la date de fin.');
  return { from, to };
};
module.exports = { today, N, settings, saveSettings, ensureDefaults, DEFAULT_STAGES, names, nums, pageLimit, chk, ymd, range };
