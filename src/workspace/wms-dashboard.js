'use strict';
// Stock entrepôt (WMS) — tableau de bord en temps réel (4E). Une seule lecture, rafraîchie par l'écran toutes les 30 secondes.
// Indicateurs : lignes à prélever, vagues en cours, expéditions en retard (date prévue dépassée, pas encore parties), réceptions à ranger
// (stock posé en emplacement de réception), tâches de réapprovisionnement et d'optimisation ouvertes, remplissage par zone
// (quantité ÷ capacité des emplacements qui ont une capacité ; part des emplacements occupés), quais (occupation du jour, camions
// au portail et à quai), productivité du jour (responsables seulement) et alertes.
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const P = require('./wms-pilot');
const Y = require('./wms-yard');
const LB = require('./wms-labor');

const router = express.Router({ mergeParams: true });
const r3 = W.round3;
const n = (x) => Number(x || 0);

async function zonesOccupancy(orgId, warehouseId) {
  const rows = await db.prepare(`SELECT l.id, l.zone_id, l.capacity, z.name AS zone, z.code AS zcode, w.name AS warehouse, w.id AS wid,
      (SELECT COALESCE(SUM(s.quantity), 0) FROM wms_stock s WHERE s.location_id = l.id) AS q
    FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id LEFT JOIN wms_zones z ON z.id = l.zone_id
    WHERE l.org_id = ? AND l.active = 1 AND l.kind IN ('storage','picking','reception')${warehouseId ? ' AND l.warehouse_id = ?' : ''}`).all(orgId, ...(warehouseId ? [warehouseId] : []));
  const by = new Map();
  for (const l of rows) {
    const k = l.zone_id ? `z${l.zone_id}` : `w${l.wid}`;
    if (!by.has(k)) by.set(k, { zoneId: l.zone_id ? Number(l.zone_id) : null, zone: l.zone_id ? l.zone : null, warehouse: l.warehouse, locations: 0, occupied: 0, capacity: 0, filled: 0, withCapacity: 0 });
    const z = by.get(k);
    z.locations++; if (n(l.q) > W.EPS) z.occupied++;
    if (l.capacity !== null && l.capacity !== undefined) { z.withCapacity++; z.capacity += n(l.capacity); z.filled += n(l.q); }
  }
  return [...by.values()].map((z) => ({ ...z, capacity: r3(z.capacity), filled: r3(z.filled), used: z.locations ? P.round1((100 * z.occupied) / z.locations) : 0, fill: z.capacity > 0 ? P.round1((100 * z.filled) / z.capacity) : null }))
    .sort((a, b) => (b.fill === null ? -1 : b.fill) - (a.fill === null ? -1 : a.fill) || b.used - a.used);
}

router.get('/dashboard/live', async (req, res) => {
  const orgId = req.org.id;
  const today = W.today();
  const pilot = await P.pilotOf(orgId);
  const wid = req.query.warehouseId ? A.id(req.query.warehouseId) : null;
  const pick = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(pl.quantity - pl.picked_qty), 0) AS q, COUNT(DISTINCT p.id) AS picks FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id
    WHERE p.org_id = ? AND p.status IN ('open','in_progress') AND pl.done = 0`).get(orgId);
  const toPack = await db.prepare("SELECT COUNT(*) AS n FROM wms_picks WHERE org_id = ? AND status = 'picked' AND packed_at IS NULL AND shipped_at IS NULL").get(orgId);
  const waves = await db.prepare("SELECT COALESCE(SUM(CASE WHEN status IN ('released','in_progress') THEN 1 ELSE 0 END), 0) AS run, COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) AS draft FROM wms_waves WHERE org_id = ?").get(orgId);
  const late = await db.prepare("SELECT id, code, planned_date, customer_name FROM wms_shipments WHERE org_id = ? AND status IN ('open','loading') AND planned_date IS NOT NULL AND planned_date < ? ORDER BY planned_date, id").all(orgId, today);
  const due = await db.prepare("SELECT COUNT(*) AS n FROM wms_shipments WHERE org_id = ? AND status IN ('open','loading') AND planned_date = ?").get(orgId, today);
  const shippedToday = await db.prepare("SELECT COUNT(*) AS n FROM wms_shipments WHERE org_id = ? AND status = 'shipped' AND shipped_at >= ?").get(orgId, today + 'T00:00:00.000Z');
  const putaway = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(s.quantity), 0) AS q FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.org_id = ? AND l.kind = 'reception' AND s.quantity > 0").get(orgId);
  const replen = await db.prepare("SELECT COUNT(*) AS n FROM wms_replen_tasks WHERE org_id = ? AND status = 'open'").get(orgId);
  const slot = await db.prepare("SELECT COUNT(*) AS n FROM wms_slot_tasks WHERE org_id = ? AND status = 'open'").get(orgId);
  const below = await db.prepare(`SELECT r.id, l.code, i.name FROM wms_replen_rules r JOIN wms_locations l ON l.id = r.location_id JOIN stock_items i ON i.id = r.item_id
    WHERE r.org_id = ? AND r.active = 1 AND COALESCE((SELECT s.quantity FROM wms_stock s WHERE s.location_id = r.location_id AND s.item_id = r.item_id), 0) < r.min_qty
    AND NOT EXISTS (SELECT 1 FROM wms_replen_tasks t WHERE t.to_location_id = r.location_id AND t.item_id = r.item_id AND t.status = 'open')`).all(orgId);
  const zones = await zonesOccupancy(orgId, wid);
  const per = P.period({ from: today, to: today });
  const yard = await Y.kpis(orgId, per);
  const waiting = await db.prepare("SELECT code, plate, arrived_at FROM wms_appointments WHERE org_id = ? AND status = 'arrived' ORDER BY arrived_at").all(orgId);
  const lateTrucks = await db.prepare("SELECT code, slot_start FROM wms_appointments WHERE org_id = ? AND status = 'planned' AND slot_start < ? AND slot_start >= ?").all(orgId, new Date(Date.now() - Number(pilot.yardTolerance) * 60000).toISOString(), per.start);
  const shortToday = await db.prepare("SELECT COUNT(*) AS n FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id WHERE p.org_id = ? AND pl.short = 1 AND COALESCE(pl.picked_at, p.created_at) >= ?").get(orgId, per.start);

  let productivity = null;
  if (A.can(req, 'manager')) {
    const s = await LB.summary(orgId, per);
    productivity = { ...s.out.totals, byTask: s.out.byTask, byHour: s.out.byHour };
  }

  const alerts = [];
  if (late.length) alerts.push({ kind: 'late_shipments', level: 'bad', n: late.length, list: late.slice(0, 5).map((s) => s.code) });
  const longWait = waiting.filter((a) => Date.now() - Date.parse(a.arrived_at) > Number(pilot.yardWaitAlert) * 60000);
  if (longWait.length) alerts.push({ kind: 'truck_waiting', level: 'bad', n: longWait.length, minutes: Number(pilot.yardWaitAlert), list: longWait.slice(0, 5).map((a) => a.plate || a.code) });
  if (lateTrucks.length) alerts.push({ kind: 'truck_late', level: 'mid', n: lateTrucks.length, list: lateTrucks.slice(0, 5).map((a) => a.code) });
  if (below.length) alerts.push({ kind: 'pick_face_low', level: 'mid', n: below.length, list: below.slice(0, 5).map((r) => `${r.code} · ${r.name}`) });
  const full = zones.filter((z) => z.fill !== null && z.fill >= 90);
  if (full.length) alerts.push({ kind: 'zone_full', level: 'mid', n: full.length, list: full.slice(0, 5).map((z) => z.zone || z.warehouse) });
  if (n(shortToday.n)) alerts.push({ kind: 'short_picks', level: 'mid', n: n(shortToday.n) });
  if (n(putaway.n) && n(putaway.n) >= 10) alerts.push({ kind: 'putaway_backlog', level: 'mid', n: n(putaway.n) });

  res.json({
    at: new Date().toISOString(), today,
    picking: { lines: n(pick.n), units: r3(n(pick.q)), picks: n(pick.picks), toPack: n(toPack.n) },
    waves: { inProgress: n(waves.run), draft: n(waves.draft) },
    shipments: { late: late.length, dueToday: n(due.n), shippedToday: n(shippedToday.n) },
    putaway: { lines: n(putaway.n), units: r3(n(putaway.q)) },
    tasks: { replenishment: n(replen.n), slotting: n(slot.n), pickFacesLow: below.length },
    zones,
    yard: { appointments: yard.appointments, arrived: yard.arrived, waitingNow: yard.waitingNow, atDockNow: yard.atDockNow, utilisation: yard.utilisation, perDock: yard.perDock, onTimeRate: yard.onTimeRate, avgWaitMinutes: yard.avgWaitMinutes },
    productivity,
    alerts,
  });
});

module.exports = router;
module.exports.zonesOccupancy = zonesOccupancy;
