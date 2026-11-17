'use strict';
// Transport (TMS) — indicateurs et exports. Monté par logistics.js. Les montants ne sont donnés qu'aux responsables.
//  Livraisons de la période = date prévue (à défaut, date de création) entre « du » et « au ».
//  - À l'heure (%) = livrées à la date prévue (ou avant) ET avant la fin du créneau s'il y en a un ÷ livrées horodatées.
//  - Au premier passage (%) = livrées en une seule tentative ÷ livraisons terminées (livrées, en échec ou retournées) avec au moins une tentative.
//  - Coût par livraison = (frais réels des tournées + factures transporteurs validées, HT) ÷ livraisons livrées ;
//    coût au km = frais réels des tournées ÷ km parcourus (compteur, sinon prévus) ; coût au kg = coût total ÷ kg livrés.
//  - Utilisation d'un véhicule = jours avec une tournée ÷ jours ouvrés (lundi à samedi) ; chargement moyen = kg chargés ÷ capacité.
//  - CO2 estimé (kg) = km × émission du véhicule (g/km, sinon celle des réglages) ÷ 1000.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const TM = () => require('./tms');
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
const r1 = (n) => Math.round(n * 10) / 10;

function period(q) {
  const to = A.date(q.to) || today();
  const from = A.date(q.from) || addDays(to, -29);
  if (from > to) throw new HttpError(400, 'La date de début suit la date de fin.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new HttpError(400, 'Période trop longue (un an au plus).');
  return { from, to };
}

async function compute(req, { from, to }) {
  const s = await TM().settings(req.org.id);
  const sc = A.scope(req, 'd.branch_id');
  const ds = await db.prepare(`SELECT d.*, z.name AS zone_name, c.name AS carrier_name FROM logistics_deliveries d LEFT JOIN logistics_zones z ON z.id = d.zone_id LEFT JOIN logistics_carriers c ON c.id = d.carrier_id
    WHERE d.org_id = ? AND COALESCE(d.planned_date, SUBSTR(d.created_at, 1, 10)) >= ? AND COALESCE(d.planned_date, SUBSTR(d.created_at, 1, 10)) <= ?${sc.sql} ORDER BY d.id`).all(req.org.id, from, to, ...sc.args);
  const delivered = ds.filter((d) => d.status === 'delivered');
  const stamped = delivered.filter((d) => d.delivered_at);
  const onTime = (d) => { const l = TM().local(d.delivered_at, s.tz_offset); return (!d.planned_date || l.date <= d.planned_date) && (!d.window_end || l.date < (d.planned_date || l.date) || l.hhmm <= d.window_end); };
  const finished = ds.filter((d) => ['delivered', 'failed', 'returned'].includes(d.status) && Number(d.attempts) > 0);
  const first = delivered.filter((d) => Number(d.attempts) === 1);
  const reasons = {};
  for (const d of ds) if (d.failure_reason) reasons[d.failure_reason] = (reasons[d.failure_reason] || 0) + 1;
  const kg = delivered.reduce((a, d) => a + Number(d.weight_kg || 0), 0);

  const rounds = await db.prepare("SELECT r.*, v.plate, v.capacity_kg, v.co2_g_km FROM logistics_rounds r LEFT JOIN logistics_vehicles v ON v.id = r.vehicle_id WHERE r.org_id = ? AND r.date >= ? AND r.date <= ? AND r.status <> 'cancelled'").all(req.org.id, from, to);
  const kmOf = (r) => (r.actual_km !== null && r.actual_km !== undefined ? Number(r.actual_km) : Number(r.planned_km || 0));
  const km = rounds.reduce((a, r) => a + kmOf(r), 0);
  const co2 = rounds.reduce((a, r) => a + (kmOf(r) * (Number(r.co2_g_km) > 0 ? Number(r.co2_g_km) : Number(s.co2_g_km))) / 1000, 0);
  const loads = new Map();
  if (rounds.length) for (const x of await db.prepare(`SELECT round_id, SUM(weight_kg) AS kg, COUNT(*) AS n FROM logistics_deliveries WHERE round_id IN (${rounds.map(() => '?').join(',')}) GROUP BY round_id`).all(...rounds.map((r) => r.id))) loads.set(Number(x.round_id), { kg: Number(x.kg || 0), n: Number(x.n) });
  const tripCosts = rounds.length ? Number((await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM logistics_trip_costs WHERE round_id IN (${rounds.map(() => '?').join(',')})`).get(...rounds.map((r) => r.id))).s) : 0;
  const carrierCosts = Number((await db.prepare("SELECT COALESCE(SUM(amount_ht), 0) AS s FROM logistics_carrier_invoices WHERE org_id = ? AND status = 'approved' AND date >= ? AND date <= ?").get(req.org.id, from, to)).s);
  const ownKm = rounds.filter((r) => r.vehicle_id).reduce((a, r) => a + kmOf(r), 0);
  const total = tripCosts + carrierCosts;

  // Véhicules : jours utilisés ÷ jours ouvrés, chargement moyen.
  let work = 0; for (let d = from; d <= to; d = addDays(d, 1)) if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) work++;
  const vs = await db.prepare("SELECT * FROM logistics_vehicles WHERE org_id = ? AND status <> 'retired' ORDER BY plate").all(req.org.id);
  const vehicles = vs.map((v) => {
    const mine = rounds.filter((r) => Number(r.vehicle_id) === Number(v.id));
    const daysUsed = new Set(mine.map((r) => r.date)).size;
    const fill = Number(v.capacity_kg) > 0 && mine.length ? r1(mine.reduce((a, r) => a + (100 * ((loads.get(Number(r.id)) || { kg: 0 }).kg)) / Number(v.capacity_kg), 0) / mine.length) : null;
    return { id: v.id, plate: v.plate, trips: mine.length, daysUsed, utilisation: pct(daysUsed, work), avgLoad: fill, km: r1(mine.reduce((a, r) => a + kmOf(r), 0)) };
  });
  // Transporteurs : livrées, à l'heure, échecs.
  const byCarrier = {};
  for (const d of ds.filter((x) => x.carrier_id)) {
    const k = byCarrier[d.carrier_id] || (byCarrier[d.carrier_id] = { carrierId: d.carrier_id, carrier: d.carrier_name, deliveries: 0, delivered: 0, onTime: 0, stamped: 0, failed: 0 });
    k.deliveries++; if (d.status === 'delivered') { k.delivered++; if (d.delivered_at) { k.stamped++; if (onTime(d)) k.onTime++; } }
    if (['failed', 'returned'].includes(d.status)) k.failed++;
  }
  // Série par jour (graphiques).
  const days = [];
  for (let d = from; d <= to && days.length < 370; d = addDays(d, 1)) {
    const mine = ds.filter((x) => (x.planned_date || x.created_at.slice(0, 10)) === d);
    const del = mine.filter((x) => x.status === 'delivered'); const st = del.filter((x) => x.delivered_at);
    days.push({ date: d, planned: mine.length, delivered: del.length, failed: mine.filter((x) => ['failed', 'returned'].includes(x.status)).length, onTime: pct(st.filter(onTime).length, st.length) });
  }
  const m = A.can(req, 'manager');
  return {
    from, to,
    summary: {
      deliveries: ds.length, delivered: delivered.length, failed: ds.filter((d) => ['failed', 'returned'].includes(d.status)).length, open: ds.filter((d) => ['to_prepare', 'shipped', 'on_route'].includes(d.status)).length,
      onTimePct: pct(stamped.filter(onTime).length, stamped.length), firstAttemptPct: pct(first.length, finished.length), trips: rounds.length, km: r1(km), kmPerTrip: rounds.length ? r1(km / rounds.length) : null,
      kgDelivered: r1(kg), co2Kg: r1(co2), codDue: m ? delivered.reduce((a, d) => a + Number(d.cod_amount || 0), 0) : undefined, codCollected: m ? delivered.reduce((a, d) => a + Number(d.cod_collected || 0), 0) : undefined,
      tripCosts: m ? tripCosts : undefined, carrierCosts: m ? carrierCosts : undefined, totalCost: m ? total : undefined,
      costPerDelivery: m && delivered.length ? Math.round(total / delivered.length) : undefined, costPerKm: m && ownKm > 0 ? Math.round(tripCosts / ownKm) : undefined, costPerKg: m && kg > 0 ? r1(total / kg) : undefined,
    },
    failures: Object.entries(reasons).map(([k, n]) => ({ reason: k, label: TM().REASONS[k] || k, count: n })).sort((a, b) => b.count - a.count),
    vehicles, carriers: Object.values(byCarrier).map((k) => ({ ...k, onTimePct: pct(k.onTime, k.stamped), successPct: pct(k.delivered, k.deliveries) })), days,
    workDays: work, _rows: { ds, rounds, onTime, kmOf, loads },
  };
}

router.get('/tms/kpi', async (req, res) => { const k = await compute(req, period(req.query)); delete k._rows; res.json(k); });

// ---------- Exports CSV (séparateur « ; », UTF-8 avec BOM : s'ouvre directement dans Excel) ----------
const cell = (v) => { let s = String(v == null ? '' : v); if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
router.get('/tms/kpi/export', async (req, res) => {
  const kind = A.oneOf(String(req.query.kind || 'deliveries'), ['deliveries', 'trips', 'failures', 'vehicles'], 'deliveries', 'Export inconnu.');
  const k = await compute(req, period(req.query));
  const m = A.can(req, 'manager');
  const L = require('./logistics');
  let cols; let rows;
  if (kind === 'deliveries') {
    cols = [['N°', (d) => d.id], ['Client', (d) => d.customer_name], ['Zone', (d) => d.zone_name || ''], ['Transporteur', (d) => d.carrier_name || ''], ['Date prévue', (d) => d.planned_date || ''], ['État', (d) => L.STATUS_LABEL[d.status] || d.status],
      ['Issue', (d) => d.outcome || ''], ['Tentatives', (d) => Number(d.attempts || 0)], ['Motif d\'échec', (d) => TM().REASONS[d.failure_reason] || ''], ['Livrée le', (d) => (d.delivered_at && d.status === 'delivered' ? d.delivered_at.slice(0, 16).replace('T', ' ') : '')],
      ['À l\'heure', (d) => (d.status === 'delivered' && d.delivered_at ? (k._rows.onTime(d) ? 'oui' : 'non') : '')], ['Poids (kg)', (d) => Number(d.weight_kg || 0)], ['Palettes', (d) => Number(d.pallets || 0)],
      ...(m ? [['Frais facturés au client', (d) => Number(d.fee || 0)], ['Coût estimé', (d) => Number(d.est_cost || 0)], ['Coût réparti', (d) => Number(d.alloc_cost || 0)], ['À encaisser', (d) => Number(d.cod_amount || 0)], ['Encaissé', (d) => Number(d.cod_collected || 0)]] : [])];
    rows = k._rows.ds;
  } else if (kind === 'trips') {
    cols = [['N°', (r) => r.id], ['Tournée', (r) => r.name], ['Date', (r) => r.date], ['État', (r) => TM().TRIP_STATUS[r.status] || r.status], ['Véhicule', (r) => r.plate || ''], ['Arrêts', (r) => (k._rows.loads.get(Number(r.id)) || { n: 0 }).n],
      ['Km prévus', (r) => Number(r.planned_km || 0)], ['Km parcourus', (r) => (r.actual_km === null ? '' : Number(r.actual_km))], ['Charge (kg)', (r) => (k._rows.loads.get(Number(r.id)) || { kg: 0 }).kg], ...(m ? [['Coût estimé', (r) => Number(r.est_cost || 0)]] : [])];
    rows = k._rows.rounds;
  } else if (kind === 'failures') {
    cols = [['Motif', (f) => f.label], ['Nombre', (f) => f.count]]; rows = k.failures;
  } else {
    cols = [['Véhicule', (v) => v.plate], ['Tournées', (v) => v.trips], ['Jours utilisés', (v) => v.daysUsed], ['Utilisation (%)', (v) => (v.utilisation === null ? '' : v.utilisation)], ['Chargement moyen (%)', (v) => (v.avgLoad === null ? '' : v.avgLoad)], ['Km', (v) => v.km]]; rows = k.vehicles;
  }
  const body = '﻿' + [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => c[1](r)))].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="transport-${kind}-${k.from}-${k.to}.csv"` });
  res.send(body);
});

module.exports = router;
