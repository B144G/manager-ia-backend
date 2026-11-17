'use strict';
// Entrepôt (fusion) : socle des modules de la ligne B (stock-wms-forecast, stock-wms-reports…) porté sur la couche de A.
// B lisait wms-lib.js (tables wms_levels…) ; ici les mêmes fonctions sont servies par wms-core.js de A (wms_stock). Aucune route ici.
const { db } = require('../db');
const Core = require('./wms-core');

const DEFAULTS_B = { forecastWeeks: 8, reviewDays: 14 }; // valeurs par défaut de B (A : 12 semaines / 7 jours) quand l'organisation n'a rien réglé
/** Réglages : ceux de A, avec les valeurs par défaut de B pour la fenêtre de prévision et le délai de revue tant qu'ils ne sont pas réglés. */
async function settings(orgId) {
  const a = await Core.settingsOf(orgId);
  const row = await db.prepare('SELECT data FROM wms_settings WHERE org_id = ?').get(orgId);
  let saved = {}; try { saved = JSON.parse((row && row.data) || '{}'); } catch { saved = {}; }
  return { ...a, forecastWeeks: saved.forecastWeeks !== undefined ? a.forecastWeeks : DEFAULTS_B.forecastWeeks, reviewDays: saved.reviewDays !== undefined ? a.reviewDays : DEFAULTS_B.reviewDays };
}
/** { itemId → { quantity, usable, reserved, available (≥ 0), short } } pour toute l'organisation. */
async function availabilityMap(orgId) {
  await Core.ensure(orgId);
  await Core.expireReservations(orgId);
  const rows = await db.prepare(`SELECT i.id, i.quantity,
      COALESCE((SELECT SUM(s.quantity) FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = i.id AND l.active = 1 AND l.kind IN ('storage','picking','reception')), 0) AS usable,
      COALESCE((SELECT SUM(r.quantity - r.fulfilled_qty) FROM wms_reservations r WHERE r.item_id = i.id AND r.status = 'active'), 0) AS reserved
    FROM stock_items i WHERE i.org_id = ?`).all(orgId);
  const m = new Map();
  for (const r of rows) {
    const usable = Core.round3(Number(r.usable)); const reserved = Core.round3(Number(r.reserved));
    m.set(Number(r.id), { quantity: Number(r.quantity), usable, reserved, available: Math.max(Core.round3(usable - reserved), 0), short: Core.round3(reserved - usable) > Core.EPS ? Core.round3(reserved - usable) : 0 });
  }
  return m;
}
module.exports = { settings, availabilityMap, round: Core.round3, round3: Core.round3, EPS: Core.EPS, ensureDefault: (orgId) => Core.ensure(orgId), LOCATION_KINDS: Core.KINDS, ZONE_KINDS: Core.ZONE_KINDS };
