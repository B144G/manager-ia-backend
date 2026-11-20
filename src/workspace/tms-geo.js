'use strict';
// Transport · géolocalisation : carte des transporteurs et du client, recommandation de deux transporteurs, affectation (création de la
// tournée existante), position envoyée depuis le téléphone du transporteur (avec consentement) ou saisie à la main, localisation du client
// par lien secret (adresse, point posé sur la carte ou GPS partagé avec consentement).
// Monté par logistics.js (mêmes droits d'accès que la Logistique) ; les pages publiques (client) sont montées par index.js.
//
// Vie privée : suivi limité aux transporteurs de l'entreprise (fiches chauffeur), seulement pendant leurs heures de service ou de mission,
// consentement explicite et révocable (la révocation efface l'historique), conservation limitée (purge), journal d'audit, isolation par entreprise.
// Aucun service de cartes payant : calcul à vol d'oiseau (haversine × coefficient routier) ; fonds de carte OpenStreetMap côté navigateur.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const T = require('./tms-lib');
const G = require('./tms-geo-lib');
const limits = require('../middleware/limits');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const pub = express.Router();
const LG = () => require('./logistics');
const FL = () => require('./logistics-fleet');
const TM = () => require('./tms');
const mgr = A.need('manager');
const today = () => nowISO().slice(0, 10);
const addMin = (iso, m) => new Date(Date.parse(iso) + m * 60000).toISOString();
const ID = (v) => (v === null || v === undefined ? null : Number(v));
const REQ_HOURS = 48; // durée de validité d'un lien de localisation envoyé à un client

// ---------- Réglages ----------
const SDEF = { stale_min: 30, lost_min: 240, retention_days: 14, shift_max_h: 12, ping_min: 5 };
async function settings(orgId) { return { ...SDEF, ...((await db.prepare('SELECT * FROM tg_settings WHERE org_id = ?').get(orgId)) || {}) }; }
const settingsView = (s) => ({ staleMin: Number(s.stale_min), lostMin: Number(s.lost_min), retentionDays: Number(s.retention_days), shiftMaxH: Number(s.shift_max_h), pingMin: Number(s.ping_min) });
const int = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, msg); return n; };
const lat = (v) => { const n = Number(v); if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < -90 || n > 90) throw new HttpError(400, 'Latitude invalide (entre -90 et 90).'); return n; };
const lng = (v) => { const n = Number(v); if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < -180 || n > 180) throw new HttpError(400, 'Longitude invalide (entre -180 et 180).'); return n; };
const acc = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e6 ? Math.round(n) : null; };

async function audit(req, kind, { driverId = null, deliveryId = null, detail = '', orgId, userId } = {}) {
  await db.prepare('INSERT INTO tg_audit (org_id, user_id, driver_id, delivery_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orgId || req.org.id, userId === undefined ? (req && req.user ? req.user.id : null) : userId, driverId, deliveryId, kind, String(detail).slice(0, 1500), nowISO());
}

router.get('/tms/geo/settings', async (req, res) => res.json({ settings: settingsView(await settings(req.org.id)) }));
router.put('/tms/geo/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {}; const s = await settings(req.org.id);
  const v = {
    stale_min: b.staleMin === undefined ? s.stale_min : int(b.staleMin, 1, 1440, 'Ancienneté invalide (1 à 1440 minutes).'),
    lost_min: b.lostMin === undefined ? s.lost_min : int(b.lostMin, 1, 10080, 'Délai de position perdue invalide (1 à 10080 minutes).'),
    retention_days: b.retentionDays === undefined ? s.retention_days : int(b.retentionDays, 1, 90, 'Conservation invalide (1 à 90 jours).'),
    shift_max_h: b.shiftMaxH === undefined ? s.shift_max_h : int(b.shiftMaxH, 1, 24, 'Durée de service invalide (1 à 24 heures).'),
    ping_min: b.pingMin === undefined ? s.ping_min : int(b.pingMin, 1, 60, "Fréquence d'envoi invalide (1 à 60 minutes)."),
  };
  if (Number(v.lost_min) <= Number(v.stale_min)) throw new HttpError(400, 'Le délai de position perdue doit dépasser celui de position ancienne.');
  await db.prepare(`INSERT INTO tg_settings (org_id, stale_min, lost_min, retention_days, shift_max_h, ping_min, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET stale_min = EXCLUDED.stale_min, lost_min = EXCLUDED.lost_min, retention_days = EXCLUDED.retention_days, shift_max_h = EXCLUDED.shift_max_h, ping_min = EXCLUDED.ping_min, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, v.stale_min, v.lost_min, v.retention_days, v.shift_max_h, v.ping_min, req.user.id, nowISO());
  await audit(req, 'settings', { detail: JSON.stringify(v) });
  res.json({ ok: true, settings: settingsView(await settings(req.org.id)) });
});

// ---------- État des transporteurs ----------
const tgOf = async (driverId) => (await db.prepare('SELECT * FROM tg_driver WHERE driver_id = ?').get(driverId)) || { driver_id: driverId, vehicle_id: null, consent_at: null, consent_revoked_at: null, shift_on: 0, shift_started_at: null, manual_state: '', manual_reason: '', manual_until: null, last_lat: null, last_lng: null, last_at: null, last_source: '' };
async function ensureTg(driver) {
  await db.prepare('INSERT INTO tg_driver (driver_id, org_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (driver_id) DO NOTHING').run(driver.id, driver.org_id, nowISO());
}
const consentOn = (t) => Boolean(t.consent_at) && (!t.consent_revoked_at || t.consent_revoked_at < t.consent_at);
/** Service en cours : activé par le transporteur et pas plus vieux que la durée maximale (fin automatique). */
const shiftOn = (t, s, now = Date.now()) => Boolean(Number(t.shift_on)) && Boolean(t.shift_started_at) && now - Date.parse(t.shift_started_at) < Number(s.shift_max_h) * 3600000;
const manualState = (t, now = Date.now()) => (t.manual_state && (!t.manual_until || Date.parse(t.manual_until) > now) ? t.manual_state : '');

/** Tout ce qu'il faut savoir d'un transporteur aujourd'hui : tournées, charge, papiers, fiabilité, véhicule. */
async function driverFacts(req, d, tg, date) {
  const rounds = await db.prepare("SELECT * FROM logistics_rounds WHERE org_id = ? AND driver_id = ? AND date = ? AND status <> 'cancelled' ORDER BY id").all(req.org.id, d.id, date);
  const inProgress = rounds.find((r) => r.status === 'in_progress') || null;
  const roundIds = rounds.map((r) => Number(r.id));
  let loaded = { weight: 0, volume: 0, pallets: 0 };
  if (roundIds.length) {
    const l = await db.prepare(`SELECT COALESCE(SUM(weight_kg), 0) AS w, COALESCE(SUM(volume_m3), 0) AS v, COALESCE(SUM(pallets), 0) AS p FROM logistics_deliveries WHERE round_id IN (${roundIds.map(() => '?').join(',')}) AND status NOT IN ('failed','returned')`).get(...roundIds);
    loaded = { weight: Number(l.w), volume: Number(l.v), pallets: Number(l.p) };
  }
  const vid = (tg.vehicle_id && Number(tg.vehicle_id)) || (rounds.find((r) => r.vehicle_id) || {}).vehicle_id || null;
  const veh = vid ? await db.prepare('SELECT * FROM logistics_vehicles WHERE id = ? AND org_id = ?').get(vid, req.org.id) : null;
  let hard = false; let hardWhy = '';
  if (veh && veh.status !== 'active') { hard = true; hardWhy = 'vehicle'; }
  if (veh) for (const k of ['insurance', 'inspection']) { const r = await db.prepare('SELECT MAX(expires_at) AS m FROM logistics_compliance WHERE vehicle_id = ? AND kind = ?').get(veh.id, k); if (r && r.m && r.m < date) { hard = true; hardWhy = 'papers'; } }
  const lic = await db.prepare("SELECT MAX(expires_at) AS m FROM logistics_compliance WHERE driver_id = ? AND kind = 'license'").get(d.id);
  if (lic && lic.m && lic.m < date) { hard = true; hardWhy = 'license'; }
  const vehicle = veh ? TM().vehOf(veh) : null;
  // Véhicule déjà pris ce jour-là par la tournée d'un AUTRE chauffeur : le transporteur est libre mais ne pourrait pas partir avec.
  const taken = veh && !rounds.some((r) => Number(r.vehicle_id) === Number(veh.id)) ? await db.prepare("SELECT 1 FROM logistics_rounds WHERE org_id = ? AND date = ? AND vehicle_id = ? AND status <> 'cancelled' AND (driver_id IS NULL OR driver_id <> ?)").get(req.org.id, date, veh.id, d.id) : null;
  const cap = vehicle ? G.capacityFit(vehicle, loaded, { weight: 0, volume: 0, pallets: 0 }) : null;
  const full = Boolean(vehicle && cap && cap.known && ['kg', 'm3', 'pallets'].some((k) => cap.remaining[k] !== null && cap.remaining[k] <= 0));
  // Fiabilité sur 90 jours : livraisons réussies (livrée ou partielle) face aux échecs et retours.
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const h = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END), 0) AS ok, COALESCE(SUM(CASE WHEN d.status IN ('failed','returned') THEN 1 ELSE 0 END), 0) AS ko
    FROM logistics_deliveries d JOIN logistics_rounds r ON r.id = d.round_id WHERE r.org_id = ? AND r.driver_id = ? AND r.date >= ?`).get(req.org.id, d.id, since);
  return { rounds, inProgress, loaded, vehicle, vehicleTaken: Boolean(taken), hard, hardWhy, full, hasRound: rounds.length > 0, reliability: G.reliability({ done: Number(h.ok), failed: Number(h.ko) }) };
}

/** Vue d'un transporteur : état (vert / rouge), position affichable, ancienneté. Pas de position affichée hors heures de service. */
function driverView(d, tg, f, s, now = Date.now()) {
  const man = manualState(tg, now);
  const st = G.driverState({ active: Boolean(Number(d.active)), hardBlock: f.hard, manualState: man, onMission: Boolean(f.inProgress), full: f.full });
  const sh = shiftOn(tg, s, now); const consent = consentOn(tg);
  const age = G.ageMin(tg.last_at, now);
  const pstate = G.positionState(age, { staleMin: Number(s.stale_min), lostMin: Number(s.lost_min) });
  // Position visible : manuelle (saisie par un responsable) ou envoyée depuis le téléphone avec consentement pendant le service ou une mission.
  const phoneOk = tg.last_source === 'phone' && consent && (sh || Boolean(f.inProgress));
  const shown = tg.last_lat !== null && tg.last_lat !== undefined && pstate !== 'lost' && pstate !== 'none' && (tg.last_source === 'manual' || phoneOk);
  return {
    id: Number(d.id), name: d.name, phone: d.phone || '', userId: d.user_id ? Number(d.user_id) : null, active: Boolean(Number(d.active)),
    vehicle: f.vehicle ? { id: f.vehicle.id, plate: f.vehicle.plate, capacityKg: f.vehicle.capacityKg, capacityM3: f.vehicle.capacityM3, capacityPallets: f.vehicle.capacityPallets, costPerKm: f.vehicle.costPerKm } : null,
    available: st.available, reason: st.reason, manual: st.manual, manualState: man, manualReason: man ? tg.manual_reason : '', manualUntil: man ? tg.manual_until : null, blocked: f.hard ? f.hardWhy : null, vehicleTaken: f.vehicleTaken,
    consent, shiftOn: sh, onMission: Boolean(f.inProgress), roundsToday: f.rounds.length,
    load: { kg: f.loaded.weight, m3: f.loaded.volume, pallets: f.loaded.pallets }, reliability: { rate: f.reliability.rate, sample: f.reliability.sample, low: f.reliability.low },
    position: shown ? { lat: Number(tg.last_lat), lng: Number(tg.last_lng), accuracy: tg.last_accuracy === null || tg.last_accuracy === undefined ? null : Number(tg.last_accuracy), at: tg.last_at, source: tg.last_source, ageMin: age, state: pstate } : null,
    positionHidden: tg.last_lat !== null && tg.last_lat !== undefined && !shown ? (pstate === 'lost' ? 'lost' : 'off_duty') : null,
  };
}

async function allDrivers(req, date, now = Date.now()) {
  const s = await settings(req.org.id);
  const rows = await db.prepare('SELECT * FROM logistics_drivers WHERE org_id = ? ORDER BY active DESC, name').all(req.org.id);
  const out = [];
  for (const d of rows) { const tg = await tgOf(d.id); const f = await driverFacts(req, d, tg, date); out.push({ d, tg, f, v: driverView(d, tg, f, s, now) }); }
  return { s, list: out };
}

// ---------- Position du client (livraison) ----------
const clientOf = (d) => (T.hasGps({ lat: d.lat, lng: d.lng }) ? { lat: Number(d.lat), lng: Number(d.lng), source: d.geo_source || '', at: d.geo_at || null, accuracy: d.geo_accuracy === null || d.geo_accuracy === undefined ? null : Number(d.geo_accuracy) } : null);
const deliveryOut = (d) => ({ id: Number(d.id), customerName: d.customer_name, phone: d.phone, address: d.address, status: d.status, plannedDate: d.planned_date, roundId: d.round_id ? Number(d.round_id) : null, weight: Number(d.weight_kg || 0), volume: Number(d.volume_m3 || 0), pallets: Number(d.pallets || 0), fee: Number(d.fee || 0), zoneId: d.zone_id ? Number(d.zone_id) : null });

router.put('/tms/geo/deliveries/:id/location', async (req, res) => {
  const d = await LG().delOf(req, req.params.id); const b = req.body || {};
  if (d.round_id && !A.can(req, 'manager')) throw new HttpError(403, 'Cette livraison est déjà en tournée.');
  const source = A.oneOf(b.source, ['address', 'pin', 'manual'], 'pin', 'Origine inconnue (adresse, point sur la carte ou saisie).');
  const la = lat(b.lat); const ln = lng(b.lng);
  const addr = b.address === undefined ? d.address : A.text(b.address, 300);
  await db.prepare('UPDATE logistics_deliveries SET lat = ?, lng = ?, address = ?, geo_source = ?, geo_at = ?, geo_accuracy = NULL, updated_at = ? WHERE id = ?').run(la, ln, addr, source, nowISO(), nowISO(), d.id);
  await audit(req, 'client_position_set', { deliveryId: d.id, detail: `${source} ${la.toFixed(5)},${ln.toFixed(5)}` });
  res.json({ ok: true, client: clientOf({ ...d, lat: la, lng: ln, geo_source: source, geo_at: nowISO() }) });
});

// ---------- Carte, recommandations ----------
async function build(req, delivery, date) {
  const tz = await TM().settings(req.org.id);
  const now = Date.now();
  const { s, list } = await allDrivers(req, date, now);
  const client = clientOf(delivery);
  const depot = T.hasGps({ lat: tz.depot_lat, lng: tz.depot_lng }) ? { lat: Number(tz.depot_lat), lng: Number(tz.depot_lng) } : null;
  const opt = { roadFactor: Number(tz.road_factor), speedKmh: Number(tz.speed_kmh) };
  const load = { weight: Number(delivery.weight_kg || 0), volume: Number(delivery.volume_m3 || 0), pallets: Number(delivery.pallets || 0) };
  const drivers = []; const cands = [];
  for (const { d, f, v } of list) {
    let trip = null; let cost = null; let capacity = null;
    if (client && v.position) trip = G.leg(v.position, client, opt);
    if (v.vehicle) capacity = G.capacityFit(v.vehicle, f.loaded, load);
    if (trip) {
      const back = depot ? G.leg(client, depot, opt) : null;
      cost = v.vehicle ? G.estimateCost({ approachKm: trip.km, backKm: back ? back.km : null, costPerKm: v.vehicle.costPerKm, allowance: Number(d.daily_allowance || 0), hasRound: f.hasRound }) : null;
    }
    const out = { ...v, distanceKm: trip ? trip.km : null, straightKm: trip ? trip.straightKm : null, etaMin: trip ? trip.minutes : null, estCost: cost ? cost.cost : null, estKm: cost ? cost.km : null, fits: capacity ? capacity.fits : null, capacityKnown: capacity ? capacity.known : false, remaining: capacity ? capacity.remaining : null };
    drivers.push(out);
    if (trip && v.position && !f.vehicleTaken) cands.push({ id: v.id, name: v.name, available: v.available, lat: v.position.lat, lng: v.position.lng, km: trip.km, minutes: trip.minutes, cost: cost ? cost.cost : null, reliability: f.reliability, capacity: capacity || { fits: true, known: false, remaining: {}, over: [], ratio: null }, stale: v.position.state === 'stale', hasVehicle: Boolean(v.vehicle) && !f.vehicleTaken });
  }
  const recs = G.recommend(cands).map((c) => {
    const dv = drivers.find((x) => x.id === c.id);
    return { rank: c.rank, driverId: c.id, name: c.name, score: c.score, strengths: c.strengths, parts: c.parts, hasVehicle: c.hasVehicle,
      justification: { distanceKm: c.km, straightKm: dv.straightKm, etaMin: c.minutes, available: true, positionAgeMin: dv.position.ageMin, positionStale: c.stale, vehicle: dv.vehicle ? dv.vehicle.plate : null,
        capacity: { known: c.capacity.known, fits: c.capacity.fits, remaining: c.capacity.remaining, loadKg: dv.load.kg, capacityKg: dv.vehicle ? dv.vehicle.capacityKg : null },
        estCost: c.cost, estKm: dv.estKm, reliabilityPct: Math.round(c.reliability.rate * 100), reliabilitySample: c.reliability.sample, reliabilityLow: c.reliability.low } };
  });
  return { client, delivery: deliveryOut(delivery), depot, drivers, recommendations: recs, settings: settingsView(s), params: { roadFactor: opt.roadFactor, speedKmh: opt.speedKmh }, weights: G.WEIGHTS, now: new Date(now).toISOString(), date };
}

router.get('/tms/geo/map', mgr, async (req, res) => {
  const d = await LG().delOf(req, req.query.deliveryId);
  const date = A.date(req.query.date) || d.planned_date || today();
  const out = await build(req, d, date);
  await audit(req, 'map_view', { deliveryId: d.id, detail: `${out.drivers.filter((x) => x.position).length} position(s) affichée(s)` });
  res.json(out);
});

// Carte seule des transporteurs (sans livraison) : tableau de bord
router.get('/tms/geo/fleet', mgr, async (req, res) => {
  const date = A.date(req.query.date) || today();
  const tz = await TM().settings(req.org.id);
  const { s, list } = await allDrivers(req, date);
  await audit(req, 'map_view', { detail: 'flotte' });
  res.json({ drivers: list.map((x) => x.v), depot: T.hasGps({ lat: tz.depot_lat, lng: tz.depot_lng }) ? { lat: Number(tz.depot_lat), lng: Number(tz.depot_lng), label: tz.depot_label } : null, settings: settingsView(s), date });
});

// ---------- Affectation : crée (ou complète) la tournée existante ----------
router.post('/tms/geo/assign', mgr, async (req, res) => {
  const b = req.body || {};
  const d = await LG().delOf(req, b.deliveryId);
  const date = A.date(b.date) || d.planned_date || today();
  if (d.round_id) throw new HttpError(409, 'Cette livraison est déjà dans une tournée.');
  if (!['to_prepare', 'shipped'].includes(d.status)) throw new HttpError(400, `Cette livraison n'est plus à planifier (${LG().STATUS_LABEL[d.status]}).`);
  const drv = await FL().driverOf(req, b.driverId);
  const tg = await tgOf(drv.id); const s = await settings(req.org.id);
  const facts = await driverFacts(req, drv, tg, date);
  const view = driverView(drv, tg, facts, s);
  if (date === today() && !view.available && !b.force) throw new HttpError(409, `${drv.name} n'est pas disponible (${({ absent: 'absent', on_mission: 'en mission', out_of_service: 'hors service', full: 'chargement plein' })[view.reason] || 'indisponible'}).`);
  const vehicleId = b.vehicleId ? A.id(b.vehicleId) : (facts.vehicle ? facts.vehicle.id : null);
  if (!vehicleId) throw new HttpError(400, "Ce transporteur n'a pas de véhicule habituel : indiquez le véhicule (fiche du transporteur ou champ « véhicule »).");
  const tz = await TM().settings(req.org.id); const ctx = await TM().ctxOf(req.org.id, tz);
  const row = await TM().shipmentLoad(d);
  const startTime = (typeof b.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.startTime)) ? b.startTime : '08:00';
  // Justificatif chiffré conservé dans le journal d'audit : ce que le système affichait au moment du choix.
  const snapshot = await build(req, d, date);
  const rec = snapshot.recommendations.find((r) => r.driverId === Number(drv.id)) || null;
  let roundId; let created = false;
  const existing = facts.rounds.find((r) => ['planned', 'dispatched'].includes(r.status));
  if (facts.inProgress && !existing) throw new HttpError(409, `${drv.name} est en tournée : attendez la fin de sa mission ou choisissez un autre transporteur.`);
  await db.transaction(async () => {
    if (existing) {
      roundId = Number(existing.id);
      const rows = await db.prepare(`${LG().BASE} WHERE d.round_id = ? AND d.org_id = ? ORDER BY d.round_pos, d.id`).all(roundId, req.org.id);
      const all = [...rows, row];
      const r = await TM().routeOf(req, all, existing.start_time || startTime, tz, ctx);
      await TM().applyRoute(req, { id: roundId }, all, r);
    } else {
      const asg = await LG().assignment(req, { vehicleId, driverId: drv.id }, null, date);
      const name = `Tournée du ${date.split('-').reverse().join('/')} · ${drv.name}`;
      roundId = Number((await db.prepare("INSERT INTO logistics_rounds (org_id, name, date, carrier_id, note, created_by, created_at, vehicle_id, driver_id, status, start_time) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'planned', ?)")
        .run(req.org.id, name, date, A.text(b.note, 300), req.user.id, nowISO(), asg.vehicleId, asg.driverId, startTime)).lastInsertRowid);
      const r = await TM().routeOf(req, [row], startTime, tz, ctx);
      await TM().applyRoute(req, { id: roundId }, [row], r);
      created = true;
    }
    if (!d.planned_date || d.planned_date !== date) await db.prepare('UPDATE logistics_deliveries SET planned_date = ? WHERE id = ?').run(date, d.id);
    const veh = await db.prepare('SELECT * FROM logistics_vehicles WHERE id = ?').get(vehicleId);
    const rs = await db.prepare('SELECT * FROM logistics_rounds WHERE id = ?').get(roundId);
    const km = Number(rs.planned_km || 0);
    const stops = await db.prepare(`${LG().BASE} WHERE d.round_id = ? AND d.org_id = ?`).all(roundId, req.org.id);
    const est = await TM().tripEstimate(req, { vehicle: veh ? TM().vehOf(veh) : null, driver: drv, carrierId: null, km, list: stops });
    await db.prepare('UPDATE logistics_rounds SET est_cost = ? WHERE id = ?').run(est, roundId);
    await LG().addEvent(req, d.id, d.status, `Transporteur choisi sur la carte : ${drv.name}${rec ? ` (recommandation n° ${rec.rank}, score ${rec.score})` : ' (choix manuel)'}`);
  })();
  await audit(req, 'assign', { driverId: drv.id, deliveryId: d.id, detail: JSON.stringify({ roundId, created, date, chosen: Number(drv.id), recommendation: rec, recommended: snapshot.recommendations.map((r) => ({ rank: r.rank, driverId: r.driverId, score: r.score })) }) });
  await A.logActivity(req.org.id, req.user.id, 'logistics', `Transporteur ${drv.name} affecté à la livraison de ${d.customer_name} (carte)`);
  res.status(201).json({ ok: true, roundId, created, recommendationRank: rec ? rec.rank : null });
});

// ---------- Transporteurs (fiche géolocalisation) ----------
router.get('/tms/geo/drivers', mgr, async (req, res) => {
  const { s, list } = await allDrivers(req, A.date(req.query.date) || today());
  res.json({ drivers: list.map((x) => x.v), settings: settingsView(s) });
});
router.put('/tms/geo/drivers/:id', mgr, async (req, res) => {
  const d = await FL().driverOf(req, req.params.id); await ensureTg(d); const b = req.body || {};
  const cur = await tgOf(d.id);
  const vehicle = b.vehicleId === undefined ? cur.vehicle_id : (b.vehicleId === null || b.vehicleId === '' ? null : (await FL().vehicleOf(req, b.vehicleId)).id);
  const st = b.manualState === undefined ? cur.manual_state : A.oneOf(b.manualState, G.MANUAL_STATES, '', 'Statut inconnu (disponible, absent, hors service, chargement plein, en mission ou automatique).');
  const until = b.manualUntil === undefined ? cur.manual_until : (b.manualUntil ? (Number.isFinite(Date.parse(b.manualUntil)) ? new Date(b.manualUntil).toISOString() : (() => { throw new HttpError(400, 'Date de fin invalide.'); })()) : null);
  await db.prepare('UPDATE tg_driver SET vehicle_id = ?, manual_state = ?, manual_reason = ?, manual_until = ?, updated_at = ? WHERE driver_id = ?').run(vehicle, st, st ? (b.manualReason === undefined ? cur.manual_reason : A.text(b.manualReason, 200)) : '', st ? until : null, nowISO(), d.id);
  if (st !== cur.manual_state) await audit(req, 'manual_state', { driverId: d.id, detail: `${cur.manual_state || 'auto'} → ${st || 'auto'}` });
  res.json({ ok: true });
});
// Position saisie à la main par un responsable (le transporteur a donné sa position au téléphone, par exemple).
router.post('/tms/geo/drivers/:id/position', mgr, async (req, res) => {
  const d = await FL().driverOf(req, req.params.id); await ensureTg(d); const b = req.body || {};
  const la = lat(b.lat); const ln = lng(b.lng);
  await recordPosition(req.org.id, d.id, { lat: la, lng: ln, accuracy: null, source: 'manual' });
  await audit(req, 'position_manual', { driverId: d.id, detail: `${la.toFixed(5)},${ln.toFixed(5)}` });
  res.json({ ok: true });
});
router.delete('/tms/geo/drivers/:id/history', mgr, async (req, res) => {
  const d = await FL().driverOf(req, req.params.id);
  await wipeDriver(req.org.id, d.id);
  await audit(req, 'history_erased', { driverId: d.id, detail: 'par un responsable' });
  res.json({ ok: true });
});

async function recordPosition(orgId, driverId, { lat: la, lng: ln, accuracy, source, roundId = null }) {
  const at = nowISO();
  await db.prepare('INSERT INTO tg_positions (org_id, driver_id, lat, lng, accuracy, source, round_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(orgId, driverId, la, ln, accuracy, source, roundId, at);
  await db.prepare('UPDATE tg_driver SET last_lat = ?, last_lng = ?, last_accuracy = ?, last_at = ?, last_source = ?, updated_at = ? WHERE driver_id = ?').run(la, ln, accuracy, at, source, at, driverId);
}
async function wipeDriver(orgId, driverId) {
  await db.prepare('DELETE FROM tg_positions WHERE org_id = ? AND driver_id = ?').run(orgId, driverId);
  await db.prepare('UPDATE tg_driver SET last_lat = NULL, last_lng = NULL, last_accuracy = NULL, last_at = NULL, last_source = \'\' WHERE driver_id = ? AND org_id = ?').run(driverId, orgId);
}

// ---------- Transporteur : « ma position » (téléphone) ----------
async function myDriver(req) {
  const d = await db.prepare('SELECT * FROM logistics_drivers WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  if (!d) throw new HttpError(404, "Votre compte n'est relié à aucune fiche transporteur : demandez à un responsable de le relier (Logistique › Parc).");
  await ensureTg(d);
  return d;
}
async function myView(req, d) {
  const s = await settings(req.org.id); const tg = await tgOf(d.id); const f = await driverFacts(req, d, tg, today());
  return { driver: driverView(d, tg, f, s), settings: settingsView(s), consentAt: tg.consent_at, consentRevokedAt: tg.consent_revoked_at,
    notice: { purpose: 'dispatch', retentionDays: Number(s.retention_days), pingMin: Number(s.ping_min), shiftMaxH: Number(s.shift_max_h) } };
}
router.get('/tms/geo/me', async (req, res) => { res.json(await myView(req, await myDriver(req))); });
router.post('/tms/geo/me/consent', async (req, res) => {
  const d = await myDriver(req); const grant = (req.body || {}).granted === true;
  const tg = await tgOf(d.id);
  if (grant) {
    await db.prepare('UPDATE tg_driver SET consent_at = ?, consent_revoked_at = NULL, updated_at = ? WHERE driver_id = ?').run(nowISO(), nowISO(), d.id);
    await audit(req, 'consent_granted', { driverId: d.id, detail: 'Partage de la position pendant les heures de service' });
  } else {
    // Révocation : le service s'arrête et l'historique est effacé.
    await db.prepare('UPDATE tg_driver SET consent_revoked_at = ?, shift_on = 0, shift_started_at = NULL, updated_at = ? WHERE driver_id = ?').run(nowISO(), nowISO(), d.id);
    await wipeDriver(req.org.id, d.id);
    if (consentOn(tg)) await audit(req, 'consent_revoked', { driverId: d.id, detail: 'Historique effacé' });
  }
  res.json(await myView(req, d));
});
router.post('/tms/geo/me/shift', async (req, res) => {
  const d = await myDriver(req); const tg = await tgOf(d.id); const on = (req.body || {}).on === true;
  if (on && !consentOn(tg)) throw new HttpError(403, "Acceptez d'abord le partage de votre position (consentement).");
  await db.prepare('UPDATE tg_driver SET shift_on = ?, shift_started_at = ?, updated_at = ? WHERE driver_id = ?').run(on ? 1 : 0, on ? nowISO() : null, nowISO(), d.id);
  await audit(req, on ? 'shift_on' : 'shift_off', { driverId: d.id });
  res.json(await myView(req, d));
});
const posLimit = limits.make(60 * 1000, 20, 'Trop de positions envoyées. Patientez un instant.');
router.post('/tms/geo/me/position', posLimit, async (req, res) => {
  const d = await myDriver(req); const tg = await tgOf(d.id); const s = await settings(req.org.id); const b = req.body || {};
  if (!consentOn(tg)) throw new HttpError(403, 'Position refusée : vous n\'avez pas donné votre consentement.');
  const f = await driverFacts(req, d, tg, today());
  if (!shiftOn(tg, s) && !f.inProgress) throw new HttpError(403, 'Position refusée : le suivi ne fonctionne que pendant votre service ou une mission en cours.');
  const la = lat(b.lat); const ln = lng(b.lng);
  await recordPosition(req.org.id, d.id, { lat: la, lng: ln, accuracy: acc(b.accuracy), source: 'phone', roundId: f.inProgress ? Number(f.inProgress.id) : null });
  await maybePurge(req.org.id);
  res.json({ ok: true, at: nowISO() });
});
router.delete('/tms/geo/me/history', async (req, res) => {
  const d = await myDriver(req); await wipeDriver(req.org.id, d.id);
  await audit(req, 'history_erased', { driverId: d.id, detail: 'par le transporteur' });
  res.json({ ok: true });
});

// ---------- Demande de localisation envoyée à un client ----------
const reqUrl = (t) => `${require('../config').siteUrl || ''}/localiser/${t}`;
router.post('/tms/geo/requests', async (req, res) => {
  const d = await LG().delOf(req, (req.body || {}).deliveryId);
  if (d.round_id) throw new HttpError(409, 'Cette livraison est déjà en tournée.');
  await db.prepare("UPDATE tg_requests SET status = 'cancelled' WHERE delivery_id = ? AND status = 'pending'").run(d.id);
  const token = crypto.randomBytes(24).toString('hex'); const now = nowISO();
  const id = Number((await db.prepare("INSERT INTO tg_requests (org_id, delivery_id, token, status, created_by, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)").run(req.org.id, d.id, token, req.user.id, now, addMin(now, REQ_HOURS * 60))).lastInsertRowid);
  await audit(req, 'request_created', { deliveryId: d.id, detail: `valable ${REQ_HOURS} h` });
  const url = reqUrl(token); const org = req.org.name;
  const message = `Bonjour ${d.customer_name}, pour organiser votre livraison ${org}, indiquez où vous êtes (adresse, point sur la carte ou position GPS de votre téléphone, avec votre accord) : ${url}`;
  const digits = String(d.phone || '').replace(/\D/g, '').replace(/^00/, '');
  res.status(201).json({ id, token, url, expiresAt: addMin(now, REQ_HOURS * 60), message, whatsapp: digits.length >= 8 ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null });
});
router.get('/tms/geo/requests', async (req, res) => {
  const d = await LG().delOf(req, req.query.deliveryId);
  const rows = await db.prepare('SELECT * FROM tg_requests WHERE delivery_id = ? AND org_id = ? ORDER BY id DESC LIMIT 10').all(d.id, req.org.id);
  res.json({ requests: rows.map((r) => ({ id: Number(r.id), status: r.status !== 'pending' ? r.status : (Date.parse(r.expires_at) < Date.now() ? 'expired' : 'pending'), createdAt: r.created_at, expiresAt: r.expires_at, locatedAt: r.located_at, source: r.source, url: r.status === 'pending' ? reqUrl(r.token) : null })) });
});
router.post('/tms/geo/requests/:id/cancel', async (req, res) => {
  const r = await db.prepare('SELECT * FROM tg_requests WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Demande introuvable.');
  await db.prepare("UPDATE tg_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
  await audit(req, 'request_cancelled', { deliveryId: r.delivery_id });
  res.json({ ok: true });
});

// Page publique du client : /api/ws/public/geo/:token (sans compte ; jeton secret, durée limitée, débit limité)
const pubLimit = limits.make(60 * 1000, 30, 'Trop de requêtes. Réessayez dans une minute.');
async function reqByToken(token) {
  const r = /^[a-f0-9]{48}$/.test(String(token)) ? await db.prepare('SELECT * FROM tg_requests WHERE token = ?').get(String(token)) : null;
  if (!r) throw new HttpError(404, 'Lien introuvable ou expiré.');
  return r;
}
pub.get('/geo/:token', pubLimit, async (req, res) => {
  const r = await reqByToken(req.params.token);
  const expired = Date.parse(r.expires_at) < Date.now();
  const org = await db.prepare('SELECT name FROM orgs WHERE id = ?').get(r.org_id);
  const d = await db.prepare('SELECT lat, lng, address, round_id, customer_name FROM logistics_deliveries WHERE id = ?').get(r.delivery_id);
  const status = r.status === 'pending' && expired ? 'expired' : r.status;
  res.set('Cache-Control', 'no-store');
  res.json({ org: org ? org.name : '', status, expiresAt: r.expires_at, name: d ? String(d.customer_name || '').split(/\s+/)[0] : '', address: d ? d.address : '', located: Boolean(d && T.hasGps(d)), assigned: Boolean(d && d.round_id),
    location: d && T.hasGps(d) && status !== 'expired' ? { lat: Number(d.lat), lng: Number(d.lng) } : null,
    notice: { purpose: 'delivery', retentionDays: 14 } });
});
pub.post('/geo/:token', pubLimit, async (req, res) => {
  const r = await reqByToken(req.params.token); const b = req.body || {};
  if (r.status === 'cancelled') throw new HttpError(410, "Ce lien n'est plus valable.");
  if (Date.parse(r.expires_at) < Date.now()) throw new HttpError(410, 'Ce lien a expiré : demandez-en un nouveau.');
  const d = await db.prepare('SELECT * FROM logistics_deliveries WHERE id = ? AND org_id = ?').get(r.delivery_id, r.org_id);
  if (!d) throw new HttpError(404, 'Livraison introuvable.');
  if (d.round_id) throw new HttpError(409, 'Votre livraison est déjà organisée : contactez la boutique pour la modifier.');
  const source = A.oneOf(b.source, ['gps', 'pin', 'address'], undefined, 'Origine de la position inconnue.');
  if (source === 'gps' && b.consent !== true) throw new HttpError(400, 'Cochez la case pour accepter de partager votre position.');
  const la = lat(b.lat); const ln = lng(b.lng);
  const addr = b.address === undefined ? d.address : A.text(b.address, 300);
  const now = nowISO();
  await db.prepare('UPDATE logistics_deliveries SET lat = ?, lng = ?, address = ?, geo_source = ?, geo_at = ?, geo_accuracy = ?, updated_at = ? WHERE id = ?').run(la, ln, addr, source, now, source === 'gps' ? acc(b.accuracy) : null, now, d.id);
  await db.prepare("UPDATE tg_requests SET status = 'located', located_at = ?, source = ?, consent_at = ? WHERE id = ?").run(now, source, source === 'gps' ? now : null, r.id);
  await audit(null, 'client_located', { orgId: r.org_id, userId: null, deliveryId: d.id, detail: `${source}${source === 'gps' ? ' (consentement donné)' : ''}` });
  await db.prepare('INSERT INTO logistics_events (org_id, delivery_id, status, note, user_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(r.org_id, d.id, d.status, `Le client a indiqué sa position (${({ gps: 'GPS du téléphone', pin: 'point sur la carte', address: 'adresse' })[source]})`, now);
  res.json({ ok: true });
});

// ---------- Journal d'audit, conservation ----------
router.get('/tms/geo/audit', A.need('admin'), async (req, res) => {
  const lim = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = await db.prepare('SELECT a.*, u.name AS user_name, d.name AS driver_name FROM tg_audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN logistics_drivers d ON d.id = a.driver_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT ?').all(req.org.id, lim);
  res.json({ audit: rows.map((a) => ({ id: Number(a.id), kind: a.kind, user: a.user_name || null, driver: a.driver_name || null, driverId: ID(a.driver_id), deliveryId: ID(a.delivery_id), detail: a.detail, at: a.created_at })) });
});

/** Supprime les positions plus anciennes que la durée de conservation, les demandes expirées depuis longtemps et les anciens journaux (1 an). */
async function purge(orgId = null) {
  const orgs = orgId ? [{ org_id: orgId }] : await db.prepare('SELECT DISTINCT org_id FROM tg_positions').all();
  let n = 0;
  for (const o of orgs) {
    const s = await settings(o.org_id);
    const cut = new Date(Date.now() - Number(s.retention_days) * 86400000).toISOString();
    n += Number((await db.prepare('DELETE FROM tg_positions WHERE org_id = ? AND recorded_at < ?').run(o.org_id, cut)).changes || 0);
    await db.prepare("UPDATE tg_driver SET last_lat = NULL, last_lng = NULL, last_accuracy = NULL, last_at = NULL, last_source = '' WHERE org_id = ? AND last_at < ?").run(o.org_id, cut);
  }
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  await db.prepare('DELETE FROM tg_requests WHERE expires_at < ?').run(old);
  await db.prepare('DELETE FROM tg_audit WHERE created_at < ?').run(new Date(Date.now() - 365 * 86400000).toISOString());
  return n;
}
let lastPurge = 0;
async function maybePurge(orgId) { if (Date.now() - lastPurge < 10 * 60 * 1000) return; lastPurge = Date.now(); await purge(orgId); }
router.post('/tms/geo/purge', A.need('admin'), async (req, res) => { const n = await purge(req.org.id); await audit(req, 'purge', { detail: `${n} position(s) supprimée(s)` }); res.json({ ok: true, deleted: n }); });

module.exports = router;
Object.assign(module.exports, { pub, purge, settings, driverView, driverFacts, build });
