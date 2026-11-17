'use strict';
// Transport (TMS) — planification et exécution. Monté par logistics.js (mêmes droits d'accès que la Logistique).
//  - Réglages : dépôt (GPS), fuseau, vitesse moyenne, temps d'arrêt, coefficient routier, CO2, tolérance des factures, marge de l'heure annoncée.
//  - Réseau : coordonnées et distances des zones (matrice zone ↔ zone) quand les adresses n'ont pas de GPS.
//  - Planification : livraisons et expéditions à planifier, proposition de tournées (capacité poids / volume / palettes, zones, créneaux,
//    priorité, ordre de passage plus proche voisin + 2-opt), validation (véhicule et chauffeur disponibles, permis et assurance à jour).
//  - Tableau de répartition (jour / semaine), fiche de tournée PDF, départ, arrivée, fin de tournée.
//  - Exécution chauffeur : arrivée, livraison complète ou partielle, refus, échec et report, paiement à la livraison, preuves (signature,
//    photo : type reconnu d'après le contenu, 2 Mo au plus, chiffrées dans la base).
//  - Suivi client : lien secret (aucun compte), étapes horodatées, créneau d'arrivée estimé ; texte WhatsApp / e-mail prêt à envoyer.
// Le stock suit la règle de la Logistique : une livraison qui porte des articles les sort au départ (une fois), une livraison partielle
// réintègre la part non livrée, un retour réintègre le reste. Une expédition de l'entrepôt (sans articles) ne touche jamais au stock.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const T = require('./tms-lib');
const limits = require('../middleware/limits');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const pub = express.Router();
const LG = () => require('./logistics');
const FL = () => require('./logistics-fleet');
const CO = () => require('./tms-costs');
const mgr = A.need('manager');
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TRIP_STATUS = { planned: 'Planifiée', dispatched: 'Répartie', in_progress: 'En cours', done: 'Terminée', cancelled: 'Annulée' };
const OUTCOMES = ['delivered', 'partial', 'refused', 'failed'];
const REASONS = { absent: 'Client absent', address: 'Adresse introuvable', refused: 'Refus du client', damaged: 'Marchandise abîmée', no_cash: 'Paiement impossible', closed: 'Fermé', access: 'Accès impossible', other: 'Autre motif' };
const POD_KINDS = ['signature', 'photo'];
const MAX_POD = 2 * 1024 * 1024; const MAX_POD_PER = 6;
const FINISHED = ['delivered', 'failed', 'returned'];

// ---------- Réglages ----------
const DEFAULTS = { depot_label: '', depot_lat: null, depot_lng: null, tz_offset: 60, speed_kmh: 30, service_min: 10, road_factor: 1.3, co2_g_km: 250, tolerance_pct: 2, tolerance_min: 500, eta_margin: 30 };
async function settings(orgId) { return { ...DEFAULTS, ...((await db.prepare('SELECT * FROM logistics_settings WHERE org_id = ?').get(orgId)) || {}) }; }
const settingsView = (s) => ({ depotLabel: s.depot_label, depotLat: s.depot_lat === null ? null : Number(s.depot_lat), depotLng: s.depot_lng === null ? null : Number(s.depot_lng), tzOffset: Number(s.tz_offset), speedKmh: Number(s.speed_kmh), serviceMin: Number(s.service_min),
  roadFactor: Number(s.road_factor), co2: Number(s.co2_g_km), tolerancePct: Number(s.tolerance_pct), toleranceMin: Number(s.tolerance_min), etaMargin: Number(s.eta_margin) });
const num = (v, { min = 0, max = 1e9, msg = 'Nombre invalide.' } = {}) => { const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, msg); return n; };
const optNum = (v, o) => (v === undefined || v === null || v === '' ? null : num(v, o));
const lat = (v) => optNum(v, { min: -90, max: 90, msg: 'Latitude invalide (entre -90 et 90).' });
const lng = (v) => optNum(v, { min: -180, max: 180, msg: 'Longitude invalide (entre -180 et 180).' });
const hhmm = (v, label) => { if (v === undefined || v === null || v === '') return ''; const s = String(v).trim(); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpError(400, `${label} invalide (format HH:MM).`); return s; };
/** Heure et date locales (fuseau de l'organisation, en minutes) d'un horodatage UTC. */
const local = (iso, tz) => { const d = new Date(Date.parse(iso) + Number(tz) * 60000); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), hhmm: d.toISOString().slice(11, 16) }; };

router.get('/tms/settings', async (req, res) => res.json({ settings: settingsView(await settings(req.org.id)) }));
router.put('/tms/settings', mgr, async (req, res) => {
  const b = req.body || {}; const s = await settings(req.org.id);
  const v = {
    depot_label: b.depotLabel === undefined ? s.depot_label : A.text(b.depotLabel, 120), depot_lat: b.depotLat === undefined ? s.depot_lat : lat(b.depotLat), depot_lng: b.depotLng === undefined ? s.depot_lng : lng(b.depotLng),
    tz_offset: b.tzOffset === undefined ? s.tz_offset : Math.round(num(b.tzOffset, { min: -720, max: 840, msg: 'Fuseau invalide (minutes par rapport à UTC).' })),
    speed_kmh: b.speedKmh === undefined ? s.speed_kmh : num(b.speedKmh, { min: 5, max: 130, msg: 'Vitesse moyenne invalide (5 à 130 km/h).' }),
    service_min: b.serviceMin === undefined ? s.service_min : Math.round(num(b.serviceMin, { min: 0, max: 240, msg: "Temps d'arrêt invalide (0 à 240 minutes)." })),
    road_factor: b.roadFactor === undefined ? s.road_factor : num(b.roadFactor, { min: 1, max: 3, msg: 'Coefficient routier invalide (entre 1 et 3).' }),
    co2_g_km: b.co2 === undefined ? s.co2_g_km : num(b.co2, { min: 0, max: 5000, msg: 'Émission de CO2 invalide (g/km).' }),
    tolerance_pct: b.tolerancePct === undefined ? s.tolerance_pct : num(b.tolerancePct, { min: 0, max: 50, msg: 'Tolérance invalide (0 à 50 %).' }),
    tolerance_min: b.toleranceMin === undefined ? s.tolerance_min : Math.round(num(b.toleranceMin, { min: 0, max: 1e7, msg: 'Tolérance invalide.' })),
    eta_margin: b.etaMargin === undefined ? s.eta_margin : Math.round(num(b.etaMargin, { min: 0, max: 240, msg: 'Marge invalide (0 à 240 minutes).' })),
  };
  if ((v.depot_lat === null) !== (v.depot_lng === null)) throw new HttpError(400, 'Indiquez la latitude ET la longitude du dépôt (ou aucune des deux).');
  await db.prepare(`INSERT INTO logistics_settings (org_id, depot_label, depot_lat, depot_lng, tz_offset, speed_kmh, service_min, road_factor, co2_g_km, tolerance_pct, tolerance_min, eta_margin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET depot_label = EXCLUDED.depot_label, depot_lat = EXCLUDED.depot_lat, depot_lng = EXCLUDED.depot_lng, tz_offset = EXCLUDED.tz_offset, speed_kmh = EXCLUDED.speed_kmh, service_min = EXCLUDED.service_min,
    road_factor = EXCLUDED.road_factor, co2_g_km = EXCLUDED.co2_g_km, tolerance_pct = EXCLUDED.tolerance_pct, tolerance_min = EXCLUDED.tolerance_min, eta_margin = EXCLUDED.eta_margin, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, v.depot_label, v.depot_lat, v.depot_lng, v.tz_offset, v.speed_kmh, v.service_min, v.road_factor, v.co2_g_km, v.tolerance_pct, v.tolerance_min, v.eta_margin, nowISO());
  res.json({ ok: true, settings: settingsView(await settings(req.org.id)) });
});

// ---------- Réseau : zones géolocalisées et distances entre zones ----------
async function ctxOf(orgId, s) {
  const zs = await db.prepare('SELECT * FROM logistics_zones WHERE org_id = ?').all(orgId);
  const mx = await db.prepare('SELECT * FROM logistics_zone_km WHERE org_id = ?').all(orgId);
  return { roadFactor: s.road_factor, zones: new Map(zs.map((z) => [Number(z.id), { depotKm: z.depot_km === null ? null : Number(z.depot_km), intraKm: Number(z.intra_km || 0), sortOrder: Number(z.sort_order || 0), lat: z.lat, lng: z.lng, name: z.name }])),
    matrix: new Map(mx.map((m) => [`${m.zone_a}-${m.zone_b}`, Number(m.km)])) };
}
const depotOf = (s) => ({ depot: true, lat: s.depot_lat === null ? null : Number(s.depot_lat), lng: s.depot_lng === null ? null : Number(s.depot_lng) });
/** Point d'un arrêt : ses coordonnées, sinon celles de sa zone. */
function pointOf(d, ctx) {
  const z = d.zone_id ? ctx.zones.get(Number(d.zone_id)) : null;
  const gps = T.hasGps({ lat: d.lat, lng: d.lng }) ? { lat: Number(d.lat), lng: Number(d.lng) } : z && T.hasGps(z) ? { lat: Number(z.lat), lng: Number(z.lng) } : { lat: null, lng: null };
  return { id: Number(d.id), ...gps, zoneId: d.zone_id ? Number(d.zone_id) : null, zoneOrder: z && (z.sortOrder || z.depotKm !== null) ? z.sortOrder * 1e4 + (z.depotKm ?? 0) : null, priority: Number(d.priority || 0), windowStart: d.window_start || '', windowEnd: d.window_end || '',
    weight: Number(d.weight_kg || 0), volume: Number(d.volume_m3 || 0), pallets: Number(d.pallets || 0) };
}

router.get('/tms/network', async (req, res) => {
  const zs = await db.prepare('SELECT * FROM logistics_zones WHERE org_id = ? ORDER BY sort_order, name').all(req.org.id);
  const mx = await db.prepare('SELECT m.*, a.name AS an, b.name AS bn FROM logistics_zone_km m JOIN logistics_zones a ON a.id = m.zone_a JOIN logistics_zones b ON b.id = m.zone_b WHERE m.org_id = ? ORDER BY a.name, b.name').all(req.org.id);
  res.json({ zones: zs.map((z) => ({ id: z.id, name: z.name, lat: z.lat === null ? null : Number(z.lat), lng: z.lng === null ? null : Number(z.lng), depotKm: z.depot_km === null ? null : Number(z.depot_km), intraKm: Number(z.intra_km || 0), sortOrder: Number(z.sort_order || 0) })),
    distances: mx.map((m) => ({ id: m.id, zoneA: m.zone_a, zoneB: m.zone_b, zoneAName: m.an, zoneBName: m.bn, km: Number(m.km) })) });
});
router.put('/tms/zones/:id', mgr, async (req, res) => {
  const z = await LG().one(req, 'logistics_zones', req.params.id, 'Zone'); const b = req.body || {};
  const la = b.lat === undefined ? z.lat : lat(b.lat); const ln = b.lng === undefined ? z.lng : lng(b.lng);
  if ((la === null) !== (ln === null)) throw new HttpError(400, 'Indiquez la latitude ET la longitude (ou aucune des deux).');
  await db.prepare('UPDATE logistics_zones SET lat = ?, lng = ?, depot_km = ?, intra_km = ?, sort_order = ? WHERE id = ?').run(la, ln,
    b.depotKm === undefined ? z.depot_km : optNum(b.depotKm, { max: 5000, msg: 'Distance invalide (km).' }), b.intraKm === undefined ? z.intra_km : num(b.intraKm || 0, { max: 1000, msg: 'Distance invalide (km).' }),
    b.sortOrder === undefined ? z.sort_order : Math.round(num(b.sortOrder || 0, { max: 9999, msg: 'Rang invalide.' })), z.id);
  res.json({ ok: true });
});
router.put('/tms/zone-km', mgr, async (req, res) => {
  const b = req.body || {};
  const a = await LG().one(req, 'logistics_zones', b.zoneA, 'Zone'); const c = await LG().one(req, 'logistics_zones', b.zoneB, 'Zone');
  if (a.id === c.id) throw new HttpError(400, 'Choisissez deux zones différentes (la distance interne se règle sur la zone).');
  const [x, y] = Number(a.id) < Number(c.id) ? [a.id, c.id] : [c.id, a.id];
  if (b.km === null || b.km === '') { await db.prepare('DELETE FROM logistics_zone_km WHERE zone_a = ? AND zone_b = ?').run(x, y); return res.json({ ok: true }); }
  const km = num(b.km, { max: 5000, msg: 'Distance invalide (km).' });
  await db.prepare('INSERT INTO logistics_zone_km (org_id, zone_a, zone_b, km) VALUES (?, ?, ?, ?) ON CONFLICT (zone_a, zone_b) DO UPDATE SET km = EXCLUDED.km').run(req.org.id, x, y, km);
  res.json({ ok: true });
});

// ---------- Champs transport d'une livraison (appelé par logistics.js à la création et à la modification) ----------
async function saveTmsFields(req, id, b, cur) {
  const has = (k) => b[k] !== undefined;
  if (!['weight', 'volume', 'pallets', 'lat', 'lng', 'windowStart', 'windowEnd', 'priority', 'codAmount'].some(has)) return;
  const c = cur || {};
  const v = {
    w: has('weight') ? num(b.weight || 0, { max: 1e6, msg: 'Poids invalide (kg).' }) : Number(c.weight_kg || 0), vol: has('volume') ? num(b.volume || 0, { max: 1e4, msg: 'Volume invalide (m³).' }) : Number(c.volume_m3 || 0),
    pal: has('pallets') ? num(b.pallets || 0, { max: 1000, msg: 'Nombre de palettes invalide.' }) : Number(c.pallets || 0), la: has('lat') ? lat(b.lat) : c.lat ?? null, ln: has('lng') ? lng(b.lng) : c.lng ?? null,
    ws: has('windowStart') ? hhmm(b.windowStart, 'Début du créneau') : c.window_start || '', we: has('windowEnd') ? hhmm(b.windowEnd, 'Fin du créneau') : c.window_end || '',
    pr: has('priority') ? A.oneOf(Number(b.priority || 0), [0, 1, 2], 0, 'Priorité invalide (0 normale, 1 haute, 2 urgente).') : Number(c.priority || 0),
    cod: has('codAmount') ? (b.codAmount === '' || b.codAmount === null || Number(b.codAmount) === 0 ? 0 : A.amount(b.codAmount)) : Number(c.cod_amount || 0),
  };
  if ((v.la === null) !== (v.ln === null)) throw new HttpError(400, 'Indiquez la latitude ET la longitude (ou aucune des deux).');
  if (v.ws && v.we && v.ws >= v.we) throw new HttpError(400, 'Le créneau de livraison doit finir après son début.');
  await db.prepare('UPDATE logistics_deliveries SET weight_kg = ?, volume_m3 = ?, pallets = ?, lat = ?, lng = ?, window_start = ?, window_end = ?, priority = ?, cod_amount = ? WHERE id = ?').run(v.w, v.vol, v.pal, v.la, v.ln, v.ws, v.we, v.pr, v.cod, id);
}

/** Part d'une ligne d'articles à réintégrer : `qty` unités prises en fin de liste (tail : part non livrée) ou en début (retour du reste). */
function returnPart(x, qty, tail = false) {
  const serials = JSON.parse(x.serials || '[]'); const allocs = JSON.parse(x.allocations || '[]');
  const done = Number(x.returned_qty || 0);
  if (serials.length) {
    const keep = serials.slice(0, serials.length - Math.round(done));
    return { serials: tail ? keep.slice(keep.length - Math.round(qty)) : keep.slice(0, Math.round(qty)), allocations: [] };
  }
  if (!allocs.length) return { serials: [], allocations: [] };
  // Lots : on retire d'abord la part déjà réintégrée (en fin de liste), puis on prend `qty` au bout voulu.
  const list = allocs.map((a) => ({ ...a })); let skip = done;
  for (let i = list.length - 1; i >= 0 && skip > 1e-9; i--) { const t = Math.min(list[i].quantity, skip); list[i].quantity = L.round3(list[i].quantity - t); skip = L.round3(skip - t); }
  const src = (tail ? list.slice().reverse() : list).filter((a) => a.quantity > 1e-9); const out = []; let left = qty;
  for (const a of src) { if (left <= 1e-9) break; const t = L.round3(Math.min(a.quantity, left)); out.push({ ...a, quantity: t }); left = L.round3(left - t); }
  return { serials: [], allocations: out };
}

/** Expédition de l'entrepôt : poids (colis et palettes) et nombre de palettes repris une fois, si la livraison n'en a pas. */
async function shipmentLoad(d) {
  if (Number(d.weight_kg) > 0 || Number(d.pallets) > 0) return d;
  const s = await db.prepare('SELECT id FROM wms_shipments WHERE delivery_id = ? ORDER BY id DESC LIMIT 1').get(d.id);
  if (!s) return d;
  const units = await db.prepare('SELECT h.id, h.type, h.weight FROM wms_shipment_units u JOIN wms_hus h ON h.id = u.hu_id WHERE u.shipment_id = ?').all(s.id);
  if (!units.length) return d;
  let kg = 0;
  for (const u of units) {
    const kids = await db.prepare('SELECT COALESCE(SUM(weight), 0) AS w FROM wms_hus WHERE parent_id = ?').get(u.id);
    kg += Number(u.weight || 0) + Number(kids.w || 0);
  }
  const pal = units.filter((u) => u.type === 'pallet').length;
  kg = L.round3(kg);
  if (kg > 0 || pal > 0) await db.prepare('UPDATE logistics_deliveries SET weight_kg = ?, pallets = ? WHERE id = ? AND weight_kg = 0 AND pallets = 0').run(kg, pal, d.id);
  return { ...d, weight_kg: kg, pallets: pal };
}

// ---------- Véhicules et chauffeurs : aptitude à une date ----------
const vehOf = (v) => (v ? { id: Number(v.id), plate: v.plate, capacityKg: Number(v.capacity_kg || 0), capacityM3: Number(v.capacity_m3 || 0), capacityPallets: Number(v.capacity_pallets || 0), costPerKm: Number(v.cost_per_km || 0), co2: Number(v.co2_g_km || 0) } : null);
/** Disponibilité (véhicule actif, chauffeur actif, pas pris ailleurs ce jour, permis valable, assurance et visite technique à jour) : contrôles de logistics.js. */
const fitness = (req, b, cur, date) => LG().assignment(req, b, cur, date);

// ---------- Livraisons à planifier ----------
async function candidates(req, date, opt = {}) {
  const sc = A.scope(req, 'd.branch_id');
  const w = ["d.org_id = ?", "d.round_id IS NULL", "d.status IN ('to_prepare','shipped')", '(d.planned_date IS NULL OR d.planned_date <= ?)'];
  const a = [req.org.id, date];
  const rows = await db.prepare(`${LG().BASE} WHERE ${w.join(' AND ')}${sc.sql} ORDER BY d.priority DESC, d.planned_date, d.id LIMIT 300`).all(...a, ...sc.args);
  const out = [];
  for (const r of rows) {
    if (opt.ids && !opt.ids.has(Number(r.id))) continue;
    if (opt.zones && !opt.zones.has(Number(r.zone_id || 0))) continue;
    out.push(await shipmentLoad(r));
  }
  return out;
}
router.get('/tms/candidates', async (req, res) => {
  const date = A.date(req.query.date) || today();
  const list = await candidates(req, date);
  res.json({ date, deliveries: list.map((d) => ({ ...LG().view(d, LG().names(d), req), overdue: Boolean(d.planned_date && d.planned_date < date) })) });
});

/** Ordre de passage et heures estimées d'une liste de livraisons (lignes de la base). */
async function routeOf(req, list, startTime, s, ctx) {
  s = s || await settings(req.org.id); ctx = ctx || await ctxOf(req.org.id, s);
  const pts = list.map((d) => pointOf(d, ctx));
  const r = T.sequence(depotOf(s), pts, T.distanceFn(ctx), { startMin: T.toMin(startTime || '08:00') ?? 480, speed: Number(s.speed_kmh), serviceMin: Number(s.service_min) });
  return r;
}
/** Coût estimé d'une tournée : flotte propre = km × coût au km du véhicule + indemnité du chauffeur ; transporteur = somme de ses tarifs. */
async function tripEstimate(req, { vehicle, driver, carrierId, km, list }) {
  if (carrierId) {
    let total = 0;
    for (const d of list) { const q = await CO().quoteDelivery(req, d, { carrierId }); total += q ? q.total : 0; }
    return total;
  }
  return Math.round((vehicle ? vehicle.costPerKm : 0) * Number(km || 0)) + Number(driver ? driver.daily_allowance || 0 : 0);
}

// ---------- Proposition de tournées ----------
router.post('/tms/plan/suggest', async (req, res) => {
  const b = req.body || {};
  const date = A.date(b.date) || today();
  const ids = Array.isArray(b.deliveryIds) && b.deliveryIds.length ? new Set(b.deliveryIds.map((x) => A.id(x))) : null;
  const zones = Array.isArray(b.zoneIds) && b.zoneIds.length ? new Set(b.zoneIds.map((x) => A.id(x))) : null;
  const list = await candidates(req, date, { ids, zones });
  if (!list.length) throw new HttpError(400, 'Aucune livraison à planifier pour ce jour (déjà en tournée, terminée ou prévue plus tard).');
  // Véhicules libres ce jour-là (actifs, papiers à jour), les plus grands d'abord.
  const sc = A.scope(req, 'v.branch_id');
  let vs = await db.prepare(`SELECT v.* FROM logistics_vehicles v WHERE v.org_id = ? AND v.status = 'active'${sc.sql} AND NOT EXISTS (SELECT 1 FROM logistics_rounds r WHERE r.vehicle_id = v.id AND r.date = ? AND r.status <> 'cancelled') ORDER BY v.capacity_kg DESC, v.id`).all(req.org.id, ...sc.args, date);
  if (Array.isArray(b.vehicleIds) && b.vehicleIds.length) { const want = new Set(b.vehicleIds.map((x) => A.id(x))); vs = vs.filter((v) => want.has(Number(v.id))); }
  const fit = [];
  for (const v of vs) { try { await fitness(req, { vehicleId: v.id }, null, date); fit.push(v); } catch (e) { if (!(e instanceof HttpError)) throw e; } }
  const s = await settings(req.org.id); const ctx = await ctxOf(req.org.id, s);
  const byId = new Map(list.map((d) => [Number(d.id), d]));
  const packed = T.pack(list.map((d) => pointOf(d, ctx)), fit.map(vehOf));
  // Chauffeurs libres ce jour-là et avec un permis valable, proposés dans l'ordre.
  const drivers = [];
  for (const d of await db.prepare("SELECT * FROM logistics_drivers WHERE org_id = ? AND active = 1 AND NOT EXISTS (SELECT 1 FROM logistics_rounds r WHERE r.driver_id = logistics_drivers.id AND r.date = ? AND r.status <> 'cancelled') ORDER BY name").all(req.org.id, date)) {
    try { await fitness(req, { driverId: d.id }, null, date); drivers.push(d); } catch (e) { if (!(e instanceof HttpError)) throw e; }
  }
  const startTime = hhmm(b.startTime, 'Heure de départ') || '08:00';
  const trips = [];
  for (const [i, bin] of packed.bins.entries()) {
    const rows = bin.deliveries.map((p) => byId.get(p.id));
    const r = await routeOf(req, rows, startTime, s, ctx);
    const drv = drivers[i] || null;
    const veh = fit.find((v) => Number(v.id) === bin.vehicle.id);
    const ld = T.load(bin.deliveries, bin.vehicle);
    trips.push({ name: `Tournée ${i + 1} · ${veh.plate}`, vehicleId: bin.vehicle.id, vehicle: veh.plate, driverId: drv ? drv.id : null, driver: drv ? drv.name : null, startTime, method: r.method, km: r.km, late: r.late, endTime: r.endTime,
      load: ld, estCost: A.can(req, 'manager') ? await tripEstimate(req, { vehicle: bin.vehicle, driver: drv, km: r.km || 0, list: rows }) : undefined,
      stops: r.order.map((p, k) => ({ pos: k + 1, deliveryId: p.id, customerName: byId.get(p.id).customer_name, zone: byId.get(p.id).zone_name || null, eta: r.etas[k].arrive, late: r.etas[k].late, windowStart: p.windowStart, windowEnd: p.windowEnd, weight: p.weight, priority: p.priority })) });
  }
  res.json({ date, trips, unassigned: packed.unassigned.map((u) => ({ deliveryId: u.delivery.id, customerName: byId.get(u.delivery.id).customer_name, weight: u.delivery.weight, reason: u.reason, reasonLabel: u.reason === 'capacity' ? 'Ne tient dans aucun véhicule libre (poids, volume ou palettes).' : 'Aucun véhicule libre ce jour-là.' })),
    vehiclesFree: fit.length, driversFree: drivers.length });
});

/** Enregistre l'ordre de passage, les heures estimées et les kilomètres d'une tournée. */
async function applyRoute(req, round, rows, r) {
  for (const [k, p] of r.order.entries()) await db.prepare('UPDATE logistics_deliveries SET round_id = ?, round_pos = ?, eta = ?, updated_at = ? WHERE id = ?').run(round.id, k + 1, r.etas[k].arrive, nowISO(), p.id);
  await db.prepare('UPDATE logistics_rounds SET planned_km = ?, route_method = ? WHERE id = ?').run(r.km || 0, r.method, round.id);
  void rows;
}

router.post('/tms/plan/commit', mgr, async (req, res) => {
  const b = req.body || {};
  const date = A.date(b.date); if (!date) throw new HttpError(400, 'Indiquez le jour des tournées.');
  if (!Array.isArray(b.trips) || !b.trips.length || b.trips.length > 30) throw new HttpError(400, 'Indiquez les tournées à créer (30 au plus).');
  const s = await settings(req.org.id); const ctx = await ctxOf(req.org.id, s);
  const seen = new Set(); const plan = [];
  const usedV = new Set(); const usedD = new Set();
  for (const t of b.trips) {
    const ids = Array.isArray(t.deliveryIds) ? t.deliveryIds.map((x) => A.id(x)) : [];
    if (!ids.length || ids.length > 80) throw new HttpError(400, 'Chaque tournée compte de 1 à 80 livraisons.');
    const rows = [];
    for (const id of ids) {
      if (seen.has(id)) throw new HttpError(400, `La livraison #${id} apparaît dans deux tournées.`);
      seen.add(id);
      const d = await LG().delOf(req, id);
      if (d.round_id) throw new HttpError(409, `La livraison pour ${d.customer_name} est déjà dans une tournée.`);
      if (!['to_prepare', 'shipped'].includes(d.status)) throw new HttpError(400, `La livraison pour ${d.customer_name} n'est plus à planifier (${LG().STATUS_LABEL[d.status]}).`);
      rows.push(await shipmentLoad(d));
    }
    const carrierId = t.carrierId ? (await LG().one(req, 'logistics_carriers', t.carrierId, 'Transporteur')).id : null;
    const asg = await fitness(req, { vehicleId: t.vehicleId, driverId: t.driverId }, null, date);
    if (!carrierId && !asg.vehicleId) throw new HttpError(400, 'Choisissez un véhicule (ou un transporteur) pour chaque tournée.');
    if (asg.vehicleId && usedV.has(asg.vehicleId)) throw new HttpError(409, 'Un même véhicule est choisi pour deux tournées.');
    if (asg.driverId && usedD.has(asg.driverId)) throw new HttpError(409, 'Un même chauffeur est choisi pour deux tournées.');
    if (asg.vehicleId) usedV.add(asg.vehicleId);
    if (asg.driverId) usedD.add(asg.driverId);
    const veh = asg.vehicleId ? vehOf(await FL().vehicleOf(req, asg.vehicleId)) : null;
    const ld = T.load(rows.map((d) => pointOf(d, ctx)), veh);
    if (ld.over.length) throw new HttpError(409, `Le véhicule ${veh.plate} est trop chargé (${ld.over.map((k) => ({ kg: `${ld.weight} kg pour ${veh.capacityKg} kg`, m3: `${ld.volume} m³ pour ${veh.capacityM3} m³`, pallets: `${ld.pallets} palettes pour ${veh.capacityPallets}` }[k])).join(', ')}).`);
    plan.push({ t, rows, asg, veh, carrierId });
  }
  const created = [];
  await db.transaction(async () => {
    for (const [i, p] of plan.entries()) {
      const startTime = hhmm(p.t.startTime, 'Heure de départ') || '08:00';
      const name = A.text(p.t.name, 100) || `Tournée du ${date.split('-').reverse().join('/')}${plan.length > 1 ? ` n° ${i + 1}` : ''}`;
      const id = Number((await db.prepare("INSERT INTO logistics_rounds (org_id, name, date, carrier_id, note, created_by, created_at, vehicle_id, driver_id, status, start_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)")
        .run(req.org.id, name, date, p.carrierId, A.text(p.t.note, 300), req.user.id, nowISO(), p.asg.vehicleId, p.asg.driverId, startTime)).lastInsertRowid);
      const r = await routeOf(req, p.rows, startTime, s, ctx);
      // Ordre imposé par la personne (respectKeep) : on garde l'ordre donné, on recalcule seulement les heures.
      const ordered = p.t.keepOrder ? fixedRoute(p.rows, startTime, s, ctx) : r;
      await applyRoute(req, { id }, p.rows, ordered);
      for (const d of p.rows) if (!d.planned_date || d.planned_date !== date) await db.prepare('UPDATE logistics_deliveries SET planned_date = ? WHERE id = ?').run(date, d.id);
      const drv = p.asg.driverId ? await db.prepare('SELECT * FROM logistics_drivers WHERE id = ?').get(p.asg.driverId) : null;
      const est = await tripEstimate(req, { vehicle: p.veh, driver: drv, carrierId: p.carrierId, km: ordered.km || 0, list: p.rows });
      await db.prepare('UPDATE logistics_rounds SET est_cost = ? WHERE id = ?').run(est, id);
      for (const d of p.rows) await LG().addEvent(req, d.id, d.status, `Planifiée dans « ${name} » (arrêt ${ordered.order.findIndex((x) => x.id === Number(d.id)) + 1}, vers ${ordered.etas[ordered.order.findIndex((x) => x.id === Number(d.id))].arrive})`);
      created.push({ id, name, km: ordered.km, method: ordered.method, stops: p.rows.length, estCost: est });
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'logistics', `${created.length} tournée(s) planifiée(s) pour le ${date}`);
  res.status(201).json({ trips: created });
});
/** Heures estimées dans l'ordre donné (sans réordonner). */
function fixedRoute(rows, startTime, s, ctx) {
  const pts = rows.map((d) => pointOf(d, ctx));
  const { m, complete } = T.matrixOf(depotOf(s), pts, T.distanceFn(ctx));
  const sc = T.schedule(pts.map((_, i) => i + 1), m, pts, { startMin: T.toMin(startTime) ?? 480, speed: Number(s.speed_kmh), serviceMin: Number(s.service_min) });
  return { method: 'manual', order: pts, km: complete ? sc.km : null, etas: sc.stops.map((x) => ({ id: pts[x.idx - 1].id, arrive: T.toHHMM(x.arrive), leave: T.toHHMM(x.leave), late: x.late })), late: sc.late, endTime: T.toHHMM(sc.endMin) };
}

// ---------- Tournées (vue transport) ----------
const tripOf = async (req, id) => {
  const r = await db.prepare('SELECT * FROM logistics_rounds WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!r) throw new HttpError(404, 'Tournée introuvable.');
  return r;
};
const isDriverOf = async (req, r) => Boolean(r.driver_id && await db.prepare('SELECT 1 FROM logistics_drivers WHERE id = ? AND user_id = ?').get(r.driver_id, req.user.id));
async function canRun(req, r) { if (A.can(req, 'manager') || await isDriverOf(req, r)) return; throw new HttpError(403, "Seuls le chauffeur de la tournée et les responsables peuvent faire cette action."); }
const stopsOf = async (req, r) => { const sc = A.scope(req, 'd.branch_id'); return db.prepare(`${LG().BASE} WHERE d.round_id = ? AND d.org_id = ?${sc.sql} ORDER BY d.round_pos, d.id`).all(r.id, req.org.id, ...sc.args); };

/** Heures d'arrivée à jour : tournée en cours → à partir de maintenant (et du dernier arrêt fait) pour les arrêts restants ; sinon les heures planifiées. */
async function liveEtas(req, r, stops, s) {
  s = s || await settings(req.org.id);
  const out = new Map(stops.map((d) => [Number(d.id), d.eta || '']));
  if (r.status !== 'in_progress') return out;
  const ctx = await ctxOf(req.org.id, s);
  const left = stops.filter((d) => !FINISHED.includes(d.status));
  if (!left.length) return out;
  const done = stops.filter((d) => FINISHED.includes(d.status) && d.delivered_at).sort((a, b) => String(a.delivered_at).localeCompare(String(b.delivered_at)));
  const last = done[done.length - 1];
  const from = last ? pointOf(last, ctx) : depotOf(s);
  const pts = left.map((d) => pointOf(d, ctx));
  const dist = T.distanceFn(ctx);
  const nowMin = local(nowISO(), s.tz_offset).min;
  let t = nowMin; let prev = from;
  for (const p of pts) {
    const km = dist(prev, p); t += ((km || 0) / Math.max(Number(s.speed_kmh), 1)) * 60;
    const ws = T.toMin(p.windowStart); if (ws !== null && t < ws) t = ws;
    out.set(p.id, T.toHHMM(t)); t += Number(s.service_min); prev = p;
  }
  return out;
}

async function tripView(req, r, { full = false } = {}) {
  const s = await settings(req.org.id);
  const stops = await stopsOf(req, r);
  const v = r.vehicle_id ? await db.prepare('SELECT * FROM logistics_vehicles WHERE id = ?').get(r.vehicle_id) : null;
  const drv = r.driver_id ? await db.prepare('SELECT * FROM logistics_drivers WHERE id = ?').get(r.driver_id) : null;
  const car = r.carrier_id ? await db.prepare('SELECT name FROM logistics_carriers WHERE id = ?').get(r.carrier_id) : null;
  const ctx = await ctxOf(req.org.id, s);
  const ld = T.load(stops.map((d) => pointOf(d, ctx)), vehOf(v));
  const etas = await liveEtas(req, r, stops, s);
  const m = A.can(req, 'manager');
  const pods = stops.length ? await db.prepare(`SELECT delivery_id, kind, COUNT(*) AS n FROM logistics_pod WHERE delivery_id IN (${stops.map(() => '?').join(',')}) GROUP BY delivery_id, kind`).all(...stops.map((d) => d.id)) : [];
  const items = full && stops.length ? await db.prepare(`SELECT x.delivery_id, x.id, x.quantity, x.returned_qty, i.name, i.unit, i.tracking FROM logistics_delivery_items x JOIN stock_items i ON i.id = x.item_id WHERE x.delivery_id IN (${stops.map(() => '?').join(',')}) ORDER BY x.id`).all(...stops.map((d) => d.id)) : [];
  const costs = m ? await db.prepare('SELECT * FROM logistics_trip_costs WHERE round_id = ? ORDER BY id').all(r.id) : [];
  const codDue = stops.reduce((a, d) => a + Number(d.cod_amount || 0), 0); const codIn = stops.reduce((a, d) => a + Number(d.cod_collected || 0), 0);
  return {
    id: r.id, name: r.name, date: r.date, status: r.status || 'planned', statusLabel: TRIP_STATUS[r.status || 'planned'], startTime: r.start_time || '08:00', note: r.note,
    vehicleId: r.vehicle_id, vehicle: v ? v.plate : null, vehicleLabel: v ? v.label : null, driverId: r.driver_id, driver: drv ? drv.name : null, driverPhone: drv ? drv.phone : null, carrierId: r.carrier_id, carrier: car ? car.name : null,
    plannedKm: Number(r.planned_km || 0), actualKm: r.actual_km === null || r.actual_km === undefined ? null : Number(r.actual_km), odoStart: r.odo_start === null ? null : Number(r.odo_start), odoEnd: r.odo_end === null ? null : Number(r.odo_end),
    routeMethod: r.route_method || '', startedAt: r.started_at || null, endedAt: r.ended_at || null, load: ld,
    capacity: v ? { kg: Number(v.capacity_kg || 0), m3: Number(v.capacity_m3 || 0), pallets: Number(v.capacity_pallets || 0) } : null,
    stopsCount: stops.length, done: stops.filter((d) => FINISHED.includes(d.status)).length,
    cod: { due: codDue, collected: codIn, remitted: Number(r.cod_remitted || 0), remittedAt: r.remitted_at || null, gap: codIn - Number(r.cod_remitted || 0) },
    estCost: m ? Number(r.est_cost || 0) : undefined, actualCost: m ? costs.reduce((a, c) => a + Number(c.amount), 0) : undefined, costsApproved: m ? Boolean(r.costs_approved_at) : undefined,
    costs: m ? costs.map((c) => ({ id: c.id, kind: c.kind, label: c.label, amount: Number(c.amount), createdAt: c.created_at })) : undefined,
    isMine: await isDriverOf(req, r),
    stops: stops.map((d) => ({ ...LG().view(d, LG().names(d), req), pos: Number(d.round_pos), etaLive: etas.get(Number(d.id)) || '', window: etaWindow(etas.get(Number(d.id)), s),
      pod: { signature: pods.filter((p) => Number(p.delivery_id) === Number(d.id) && p.kind === 'signature').reduce((a, p) => a + Number(p.n), 0), photo: pods.filter((p) => Number(p.delivery_id) === Number(d.id) && p.kind === 'photo').reduce((a, p) => a + Number(p.n), 0) },
      items: full ? items.filter((x) => Number(x.delivery_id) === Number(d.id)).map((x) => ({ id: x.id, name: x.name, unit: x.unit, tracking: x.tracking, quantity: Number(x.quantity), returned: Number(x.returned_qty || 0) })) : undefined })),
  };
}
const etaWindow = (eta, s) => { const m = T.toMin(eta); if (m === null) return null; return { from: T.toHHMM(Math.max(0, m - Number(s.eta_margin))), to: T.toHHMM(Math.min(1439, m + Number(s.eta_margin))) }; };

// Liste des tournées d'une période (sans le détail des arrêts) : suivi, frais à valider.
router.get('/tms/trips', async (req, res) => {
  const to = A.date(req.query.to) || addDays(today(), 7); const from = A.date(req.query.from) || addDays(to, -37);
  const st = req.query.status && TRIP_STATUS[req.query.status] ? String(req.query.status) : null;
  const rows = await db.prepare(`SELECT * FROM logistics_rounds WHERE org_id = ? AND date >= ? AND date <= ?${st ? ' AND status = ?' : ''} ORDER BY date DESC, start_time, id DESC LIMIT 200`).all(req.org.id, from, to, ...(st ? [st] : []));
  const trips = []; for (const r of rows) { const v = await tripView(req, r); delete v.stops; trips.push(v); }
  res.json({ from, to, trips, statuses: TRIP_STATUS });
});
router.get('/tms/trips/:id', async (req, res) => res.json({ trip: await tripView(req, await tripOf(req, req.params.id), { full: true }), reasons: REASONS }));

router.post('/tms/trips/:id/optimize', mgr, async (req, res) => {
  const r = await tripOf(req, req.params.id);
  if (!['planned', 'dispatched'].includes(r.status || 'planned')) throw new HttpError(400, 'Seule une tournée qui n\'a pas encore démarré se réordonne.');
  const stops = await stopsOf(req, r);
  if (!stops.length) throw new HttpError(400, 'Cette tournée n\'a aucun arrêt.');
  const b = req.body || {};
  const startTime = hhmm(b.startTime, 'Heure de départ') || r.start_time || '08:00';
  const s = await settings(req.org.id); const ctx = await ctxOf(req.org.id, s);
  const out = b.keepOrder ? fixedRoute(stops, startTime, s, ctx) : await routeOf(req, stops, startTime, s, ctx);
  await db.transaction(async () => {
    await applyRoute(req, r, stops, out);
    await db.prepare('UPDATE logistics_rounds SET start_time = ? WHERE id = ?').run(startTime, r.id);
    const v = r.vehicle_id ? vehOf(await db.prepare('SELECT * FROM logistics_vehicles WHERE id = ?').get(r.vehicle_id)) : null;
    const drv = r.driver_id ? await db.prepare('SELECT * FROM logistics_drivers WHERE id = ?').get(r.driver_id) : null;
    await db.prepare('UPDATE logistics_rounds SET est_cost = ? WHERE id = ?').run(await tripEstimate(req, { vehicle: v, driver: drv, carrierId: r.carrier_id, km: out.km || 0, list: stops }), r.id);
  })();
  res.json({ method: out.method, km: out.km, late: out.late, endTime: out.endTime, order: out.order.map((p, k) => ({ deliveryId: p.id, eta: out.etas[k].arrive, late: out.etas[k].late })) });
});

router.post('/tms/trips/:id/dispatch', mgr, async (req, res) => {
  const r = await tripOf(req, req.params.id);
  if ((r.status || 'planned') !== 'planned') throw new HttpError(400, 'Seule une tournée planifiée se répartit.');
  if (!r.carrier_id && (!r.vehicle_id || !r.driver_id)) throw new HttpError(400, 'Affectez un véhicule et un chauffeur (ou un transporteur) avant de répartir la tournée.');
  await fitness(req, {}, r, r.date);
  const stops = await stopsOf(req, r);
  if (!stops.length) throw new HttpError(400, "Cette tournée n'a aucun arrêt.");
  const v = r.vehicle_id ? vehOf(await db.prepare('SELECT * FROM logistics_vehicles WHERE id = ?').get(r.vehicle_id)) : null;
  const ctx = await ctxOf(req.org.id, await settings(req.org.id));
  const ld = T.load(stops.map((d) => pointOf(d, ctx)), v);
  if (ld.over.length) throw new HttpError(409, `Le véhicule ${v.plate} est trop chargé : retirez des livraisons avant de répartir la tournée.`);
  await db.prepare("UPDATE logistics_rounds SET status = 'dispatched' WHERE id = ?").run(r.id);
  res.json({ ok: true });
});

router.post('/tms/trips/:id/start', async (req, res) => {
  const r = await tripOf(req, req.params.id);
  await canRun(req, r);
  if (!['planned', 'dispatched'].includes(r.status || 'planned')) throw new HttpError(400, r.status === 'in_progress' ? 'Cette tournée est déjà en cours.' : 'Cette tournée est terminée ou annulée.');
  const b = req.body || {};
  const v = r.vehicle_id ? await db.prepare('SELECT * FROM logistics_vehicles WHERE id = ?').get(r.vehicle_id) : null;
  const odo = b.odometer === undefined || b.odometer === '' || b.odometer === null ? (v ? Number(v.odometer) : null) : num(b.odometer, { max: 1e8, msg: 'Kilométrage invalide.' });
  if (v && odo !== null && odo < Number(v.odometer) - 1e-9) throw new HttpError(400, `Kilométrage inférieur au compteur du véhicule (${Number(v.odometer)} km) : vérifiez le compteur.`);
  const stops = await stopsOf(req, r);
  if (!stops.length) throw new HttpError(400, "Cette tournée n'a aucun arrêt.");
  await db.transaction(async () => {
    await db.prepare("UPDATE logistics_rounds SET status = 'in_progress', started_at = ?, odo_start = ? WHERE id = ?").run(nowISO(), odo, r.id);
    for (const d of stops) {
      if (!['to_prepare', 'shipped'].includes(d.status)) continue;
      const fresh = await db.prepare('SELECT * FROM logistics_deliveries WHERE id = ?').get(d.id);
      const stock = await LG().stockBridge(req, fresh, 'on_route');
      await db.prepare("UPDATE logistics_deliveries SET status = 'on_route', updated_at = ? WHERE id = ?").run(nowISO(), d.id);
      await LG().addEvent(req, d.id, 'on_route', [`Départ de la tournée « ${r.name} »`, stock].filter(Boolean).join(' · '));
    }
  })();
  res.json({ ok: true });
});

router.post('/tms/trips/:id/finish', async (req, res) => {
  const r = await tripOf(req, req.params.id);
  await canRun(req, r);
  if (r.status !== 'in_progress') throw new HttpError(400, "Cette tournée n'est pas en cours.");
  const b = req.body || {};
  const stops = await stopsOf(req, r);
  const open = stops.filter((d) => !FINISHED.includes(d.status));
  if (open.length) throw new HttpError(409, `Il reste ${open.length} arrêt(s) sans issue (livrée, échec ou report) : ${open.slice(0, 5).map((d) => d.customer_name).join(', ')}.`);
  const v = r.vehicle_id ? await db.prepare('SELECT * FROM logistics_vehicles WHERE id = ?').get(r.vehicle_id) : null;
  const odo = b.odometer === undefined || b.odometer === '' || b.odometer === null ? null : num(b.odometer, { max: 1e8, msg: 'Kilométrage invalide.' });
  if (odo !== null && r.odo_start !== null && odo < Number(r.odo_start)) throw new HttpError(400, `Kilométrage inférieur à celui du départ (${Number(r.odo_start)} km).`);
  const km = odo !== null && r.odo_start !== null ? T.round1(odo - Number(r.odo_start)) : null;
  const collected = stops.reduce((a, d) => a + Number(d.cod_collected || 0), 0);
  const remitted = b.codRemitted === undefined || b.codRemitted === '' ? collected : (Number(b.codRemitted) === 0 ? 0 : A.amount(b.codRemitted));
  const back = [];
  await db.transaction(async () => {
    // Marchandise des arrêts en échec : rapportée au dépôt (le stock est réintégré), sauf si on la garde pour un nouvel essai.
    if (b.returnFailed !== false) {
      for (const d of stops.filter((x) => x.status === 'failed')) {
        const fresh = await db.prepare('SELECT * FROM logistics_deliveries WHERE id = ?').get(d.id);
        const stock = await LG().stockBridge(req, fresh, 'returned');
        await db.prepare("UPDATE logistics_deliveries SET status = 'returned', updated_at = ? WHERE id = ?").run(nowISO(), d.id);
        await LG().addEvent(req, d.id, 'returned', ['Rapportée au dépôt en fin de tournée', stock].filter(Boolean).join(' · '));
        back.push(d.id);
      }
    }
    await db.prepare("UPDATE logistics_rounds SET status = 'done', ended_at = ?, odo_end = ?, actual_km = ?, cod_remitted = ?, remitted_at = ? WHERE id = ?").run(nowISO(), odo, km, remitted, collected || remitted ? nowISO() : null, r.id);
    if (v && odo !== null && odo > Number(v.odometer)) {
      await db.prepare('UPDATE logistics_vehicles SET odometer = ? WHERE id = ?').run(odo, v.id);
      if (v.equipment_id) await db.prepare('UPDATE maintenance_equipment SET meter = ? WHERE id = ? AND meter < ?').run(odo, v.equipment_id, odo);
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'logistics', `Tournée « ${r.name} » terminée`);
  res.json({ ok: true, km, cod: { collected, remitted, gap: collected - remitted }, returned: back.length });
});

router.post('/tms/trips/:id/cancel', mgr, async (req, res) => {
  const r = await tripOf(req, req.params.id);
  if (!['planned', 'dispatched'].includes(r.status || 'planned')) throw new HttpError(400, 'Seule une tournée qui n\'a pas démarré peut être annulée.');
  await db.transaction(async () => {
    await db.prepare("UPDATE logistics_deliveries SET round_id = NULL, round_pos = 0, eta = '' WHERE round_id = ? AND org_id = ?").run(r.id, req.org.id);
    await db.prepare("UPDATE logistics_rounds SET status = 'cancelled' WHERE id = ?").run(r.id);
  })();
  res.json({ ok: true });
});

// ---------- Tableau de répartition (jour ou semaine) ----------
router.get('/tms/dispatch', async (req, res) => {
  const from = A.date(req.query.from) || today();
  const days = Math.min(Math.max(Number(req.query.days) || 1, 1), 14);
  const to = addDays(from, days - 1);
  const rounds = await db.prepare("SELECT * FROM logistics_rounds WHERE org_id = ? AND date >= ? AND date <= ? AND status <> 'cancelled' ORDER BY date, start_time, id").all(req.org.id, from, to);
  const trips = [];
  for (const r of rounds) { const v = await tripView(req, r); delete v.stops; trips.push(v); }
  const sc = A.scope(req, 'd.branch_id');
  const un = await db.prepare(`SELECT d.planned_date, COUNT(*) AS n FROM logistics_deliveries d WHERE d.org_id = ? AND d.round_id IS NULL AND d.status IN ('to_prepare','shipped')${sc.sql} GROUP BY d.planned_date`).all(req.org.id, ...sc.args);
  const unplanned = (date) => un.filter((u) => (u.planned_date || '') <= date && (date === from || u.planned_date === date)).reduce((a, u) => a + Number(u.n), 0);
  const vs = await db.prepare(`SELECT * FROM logistics_vehicles v WHERE v.org_id = ? AND v.status <> 'retired'${A.scope(req, 'v.branch_id').sql} ORDER BY plate`).all(req.org.id, ...A.scope(req, 'v.branch_id').args);
  const ds = await db.prepare('SELECT * FROM logistics_drivers WHERE org_id = ? AND active = 1 ORDER BY name').all(req.org.id);
  const list = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const dayTrips = trips.filter((t) => t.date === date);
    list.push({ date, trips: dayTrips, unplanned: unplanned(date), freeVehicles: vs.filter((v) => v.status === 'active' && !dayTrips.some((t) => Number(t.vehicleId) === Number(v.id))).map((v) => v.plate), freeDrivers: ds.filter((d) => !dayTrips.some((t) => Number(t.driverId) === Number(d.id))).map((d) => d.name) });
  }
  res.json({ from, to, days: list, statuses: TRIP_STATUS });
});

// ---------- Fiche de tournée (PDF) ----------
router.get('/tms/trips/:id/sheet', async (req, res) => {
  const r = await tripOf(req, req.params.id);
  const v = await tripView(req, r, { full: true });
  const P = require('../services/pdf');
  const kg = (n) => (n ? `${n} kg` : '');
  const buf = await P.render({
    title: 'Fiche de tournée', subtitle: `${v.name} · ${P.dfr(v.date)}`, org: req.org.name,
    meta: [['Véhicule', [v.vehicle, v.vehicleLabel].filter(Boolean).join(' · ') || v.carrier || '—'], ['Chauffeur', [v.driver, v.driverPhone].filter(Boolean).join(' · ') || '—'], ['Départ', v.startTime],
      ['Arrêts', String(v.stopsCount)], ['Distance prévue', v.plannedKm ? `${v.plannedKm} km` : '—'], ['Chargement', `${v.load.weight} kg${v.load.pctKg !== null ? ` (${v.load.pctKg} %)` : ''} · ${v.load.pallets} palette(s)`],
      ['À encaisser', v.cod.due ? P.money(v.cod.due, req.org.currency) : '—']],
    blocks: [
      { type: 'heading', text: 'Arrêts dans l\'ordre de passage' },
      { type: 'table', cols: [{ key: 'pos', label: '#', width: 0.6 }, { key: 'eta', label: 'Heure', width: 1 }, { key: 'who', label: 'Client', width: 3 }, { key: 'addr', label: 'Adresse, téléphone', width: 4 }, { key: 'win', label: 'Créneau', width: 1.6 }, { key: 'load', label: 'Charge', width: 1.4, align: 'right' }, { key: 'cod', label: 'À encaisser', width: 1.8, align: 'right' }, { key: 'sig', label: 'Signature', width: 2 }],
        rows: v.stops.map((d) => ({ pos: String(d.pos), eta: d.eta || '', who: `${d.customerName}${d.docNumber ? ` (${d.docNumber})` : ''}${d.priority ? ' !' : ''}`, addr: [d.address, d.zone, d.phone].filter(Boolean).join(' · '), win: d.windowStart || d.windowEnd ? `${d.windowStart || '…'}-${d.windowEnd || '…'}` : '',
          load: [kg(d.weight), d.pallets ? `${d.pallets} pal.` : ''].filter(Boolean).join(' '), cod: d.codAmount ? P.money(d.codAmount, req.org.currency) : '', sig: '' })) },
      { type: 'space' },
      { type: 'kv', rows: [['Kilométrage au départ', '______________'], ['Kilométrage au retour', '______________'], ['Espèces remises au retour', '______________'], ['Signature du chauffeur', '______________']] },
    ],
    footer: 'Pour chaque arrêt : nom de la personne qui reçoit, signature, et le motif en cas d\'échec. « ! » = livraison prioritaire.',
  });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="tournee-${r.id}.pdf"` });
  res.end(buf);
});

// ---------- Chauffeur : ma tournée ----------
router.get('/tms/driver', async (req, res) => {
  const date = A.date(req.query.date) || local(nowISO(), (await settings(req.org.id)).tz_offset).date;
  let drv = await db.prepare('SELECT * FROM logistics_drivers WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  if (req.query.driverId && A.can(req, 'manager')) drv = await FL().driverOf(req, req.query.driverId);
  if (!drv) return res.json({ driver: null, date, trips: [], message: "Votre compte n'est relié à aucune fiche chauffeur : demandez à un responsable de le relier (Logistique › Parc)." });
  const rs = await db.prepare("SELECT * FROM logistics_rounds WHERE org_id = ? AND driver_id = ? AND (date = ? OR status = 'in_progress') AND status <> 'cancelled' ORDER BY date, start_time, id").all(req.org.id, drv.id, date);
  const trips = []; for (const r of rs) trips.push(await tripView(req, r, { full: true }));
  res.json({ driver: { id: drv.id, name: drv.name }, date, trips, reasons: REASONS });
});

async function stopOf(req, id) {
  const d = await LG().delOf(req, id);
  if (!d.round_id) throw new HttpError(400, "Cette livraison ne fait partie d'aucune tournée.");
  const r = await tripOf(req, d.round_id);
  await canRun(req, r);
  return { d, r };
}
const gps = (b) => { const la = lat(b.lat); const ln = lng(b.lng); return la !== null && ln !== null ? { la, ln } : { la: null, ln: null }; };
async function event(req, deliveryId, status, note, g) {
  await db.prepare('INSERT INTO logistics_events (org_id, delivery_id, status, note, user_id, created_at, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, deliveryId, status, A.text(note, 300), req.user.id, nowISO(), g.la, g.ln);
}

router.post('/tms/stops/:id/arrive', async (req, res) => {
  const { d, r } = await stopOf(req, req.params.id);
  if (r.status !== 'in_progress') throw new HttpError(400, "Démarrez d'abord la tournée.");
  if (FINISHED.includes(d.status)) throw new HttpError(400, 'Cet arrêt est déjà terminé.');
  const at = nowISO();
  await db.prepare('UPDATE logistics_deliveries SET arrived_at = ?, updated_at = ? WHERE id = ?').run(at, at, d.id);
  await event(req, d.id, 'arrived', 'Arrivé chez le client', gps(req.body || {}));
  res.json({ ok: true, arrivedAt: at });
});

router.post('/tms/stops/:id/complete', async (req, res) => {
  const { d, r } = await stopOf(req, req.params.id);
  if (r.status !== 'in_progress') throw new HttpError(400, "Démarrez d'abord la tournée.");
  if (FINISHED.includes(d.status)) throw new HttpError(400, 'Cet arrêt est déjà terminé.');
  const b = req.body || {};
  const outcome = A.oneOf(b.outcome, OUTCOMES, undefined, 'Issue inconnue (livrée, partielle, refusée ou échec).');
  const ok = ['delivered', 'partial'].includes(outcome);
  const recipient = A.text(b.recipient, 100);
  if (ok && !recipient) throw new HttpError(400, 'Indiquez le nom de la personne qui a reçu la marchandise.');
  const reason = ok ? '' : A.oneOf(b.reason || (outcome === 'refused' ? 'refused' : ''), Object.keys(REASONS), undefined, "Choisissez le motif de l'échec.");
  const note = A.text(b.note, 300);
  if (!ok && reason === 'other' && !note) throw new HttpError(400, 'Précisez le motif en quelques mots.');
  const rows = await db.prepare('SELECT x.*, i.name, i.unit, i.tracking FROM logistics_delivery_items x JOIN stock_items i ON i.id = x.item_id WHERE x.delivery_id = ? ORDER BY x.id').all(d.id);
  const back = [];
  if (outcome === 'partial') {
    if (rows.length) {
      const given = new Map((Array.isArray(b.lines) ? b.lines : []).map((l) => [Number(l && l.id), l && l.delivered]));
      for (const x of rows) {
        if (!given.has(Number(x.id))) throw new HttpError(400, `Indiquez la quantité livrée de « ${x.name} ».`);
        const q = A.qty(given.get(Number(x.id)), { allowZero: true });
        if (q > Number(x.quantity) + 1e-9) throw new HttpError(400, `Quantité livrée de « ${x.name} » supérieure à la quantité chargée (${Number(x.quantity)} ${x.unit}).`);
        if (x.tracking === 'serial' && !Number.isInteger(q)) throw new HttpError(400, `« ${x.name} » est suivi par numéro de série : quantité entière.`);
        const rest = L.round3(Number(x.quantity) - q);
        if (rest > 1e-9) back.push({ x, rest, delivered: q });
      }
      if (!back.length) throw new HttpError(400, 'Tout a été livré : choisissez « Livrée ».');
      if (back.every((y) => y.delivered <= 1e-9)) throw new HttpError(400, 'Rien n\'a été livré : choisissez « Refusée » ou « Échec ».');
    } else if (!note) throw new HttpError(400, 'Livraison partielle : notez ce qui n\'a pas été livré.');
  }
  // Paiement à la livraison : le montant encaissé, jamais plus que le montant dû.
  const due = Number(d.cod_amount || 0);
  let cod = 0;
  if (ok && due > 0) {
    if (b.codCollected === undefined || b.codCollected === null || b.codCollected === '') throw new HttpError(400, `Indiquez le montant encaissé (${due.toLocaleString('fr-FR')} ${req.org.currency} à encaisser).`);
    cod = Number(b.codCollected) === 0 ? 0 : A.amount(b.codCollected);
    if (cod > due) throw new HttpError(400, `Montant encaissé supérieur au montant à encaisser (${due.toLocaleString('fr-FR')} ${req.org.currency}).`);
  } else if (!ok && b.codCollected) throw new HttpError(400, "Aucun encaissement sans livraison.");
  const resched = !ok && b.rescheduleDate ? A.date(b.rescheduleDate) : null;
  if (resched && resched < r.date) throw new HttpError(400, 'La nouvelle date doit suivre celle de la tournée.');
  const g = gps(b);
  const now = nowISO();
  // Saisie après coup (bon de livraison papier, chauffeur sans téléphone) : un responsable indique l'heure réelle, avec la pièce qui la justifie.
  // L'heure est marquée « déclarée » : les indicateurs la comptent à part de l'heure enregistrée en direct.
  let at = now; let declared = 0;
  if (b.deliveredAt !== undefined && b.deliveredAt !== null && b.deliveredAt !== '') {
    if (!A.can(req, 'manager')) throw new HttpError(403, "Seul un responsable peut saisir après coup l'heure réelle d'une livraison.");
    const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(String(b.deliveredAt));
    if (!m || !A.date(m[1])) throw new HttpError(400, 'Heure réelle invalide (date et heure attendues).');
    if (note.length < 5) throw new HttpError(400, 'Saisie après coup : notez la pièce qui justifie cette heure (ex. bon de livraison signé n° …).');
    if (m[1] < r.date) throw new HttpError(400, "L'heure réelle ne peut pas précéder le jour de la tournée.");
    const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) - Number((await settings(req.org.id)).tz_offset) * 60000;
    if (ms > Date.now()) throw new HttpError(400, "L'heure réelle ne peut pas être dans le futur.");
    at = new Date(ms).toISOString(); declared = 1;
  }
  const atNote = declared ? `Heure réelle saisie après coup : ${String(b.deliveredAt).slice(11, 16)} le ${String(b.deliveredAt).slice(0, 10).split('-').reverse().join('/')}` : '';
  await db.transaction(async () => {
    const fresh = await db.prepare('SELECT * FROM logistics_deliveries WHERE id = ? FOR UPDATE').get(d.id);
    if (FINISHED.includes(fresh.status)) throw new HttpError(409, 'Cet arrêt vient d\'être terminé par quelqu\'un d\'autre.');
    if (ok) {
      const stock = await LG().stockBridge(req, fresh, 'delivered'); // déjà sorti au départ : sans effet, sauf si la livraison a rejoint la tournée après le départ
      for (const y of back) {
        const part = returnPart(y.x, y.rest, true);
        await L.adjust(req, y.x.item_id, y.rest, `Non livré (partiel) livraison #${d.id}`, { serials: part.serials, allocations: part.allocations, refKind: 'delivery', refId: d.id });
        await db.prepare('UPDATE logistics_delivery_items SET returned_qty = ? WHERE id = ?').run(y.rest, y.x.id);
      }
      await db.prepare("UPDATE logistics_deliveries SET status = 'delivered', outcome = ?, received_by = ?, cod_collected = ?, delivered_at = ?, time_declared = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?").run(outcome, recipient, cod, at, declared, now, d.id);
      const gap = due > 0 && cod < due ? `Encaissé ${cod.toLocaleString('fr-FR')} sur ${due.toLocaleString('fr-FR')} ${req.org.currency}` : due > 0 ? `Encaissé ${cod.toLocaleString('fr-FR')} ${req.org.currency}` : '';
      await event(req, d.id, 'delivered', [outcome === 'partial' ? 'Livraison partielle' : 'Livrée', `reçu par ${recipient}`, atNote, back.map((y) => `${y.rest} ${y.x.unit} de « ${y.x.name} » non livré(s), remis en stock`).join(', '), gap, note, stock].filter(Boolean).join(' · '), g);
    } else if (resched) {
      await db.prepare("UPDATE logistics_deliveries SET status = 'shipped', outcome = ?, failure_reason = ?, attempts = attempts + 1, planned_date = ?, round_id = NULL, round_pos = 0, eta = '', arrived_at = NULL, updated_at = ? WHERE id = ?").run(outcome, reason, resched, now, d.id);
      await event(req, d.id, 'failed', [REASONS[reason], note, `Nouvelle tentative le ${resched.split('-').reverse().join('/')}`].filter(Boolean).join(' · '), g);
    } else {
      await db.prepare("UPDATE logistics_deliveries SET status = 'failed', outcome = ?, failure_reason = ?, attempts = attempts + 1, delivered_at = ?, time_declared = ?, updated_at = ? WHERE id = ?").run(outcome, reason, at, declared, now, d.id);
      await event(req, d.id, 'failed', [REASONS[reason], atNote, note].filter(Boolean).join(' · '), g);
    }
  })();
  res.json({ ok: true, outcome, codCollected: cod, returnedToStock: back.map((y) => ({ itemId: y.x.item_id, quantity: y.rest })), rescheduled: resched });
});

// Nouvelle tentative décidée au bureau (livraison en échec ou retournée) : remise à planifier à une date.
router.post('/tms/deliveries/:id/reschedule', mgr, async (req, res) => {
  const d = await LG().delOf(req, req.params.id);
  if (!['failed', 'to_prepare', 'shipped'].includes(d.status)) throw new HttpError(400, 'Seule une livraison en échec ou pas encore partie se replanifie.');
  const date = A.date((req.body || {}).date); if (!date) throw new HttpError(400, 'Indiquez la nouvelle date.');
  const st = d.status === 'failed' ? (d.stock_out && !d.stock_back ? 'shipped' : (await db.prepare('SELECT 1 FROM logistics_delivery_items WHERE delivery_id = ?').get(d.id) ? 'to_prepare' : 'shipped')) : d.status;
  await db.prepare("UPDATE logistics_deliveries SET status = ?, planned_date = ?, round_id = NULL, round_pos = 0, eta = '', updated_at = ? WHERE id = ?").run(st, date, nowISO(), d.id);
  await LG().addEvent(req, d.id, st, `Replanifiée au ${date.split('-').reverse().join('/')}${A.text((req.body || {}).note, 200) ? ' · ' + A.text(req.body.note, 200) : ''}`);
  res.json({ ok: true, status: st });
});

// ---------- Preuves de livraison (signature dessinée, photo) ----------
const X = () => require('./legal-extra'); // chiffrement AES-256-GCM et reconnaissance du type d'après le contenu, communs aux pièces jointes
const upLimit = limits.make(10 * 60 * 1000, 60, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");
router.post('/tms/stops/:id/pod', upLimit, express.raw({ type: () => true, limit: MAX_POD + 1024 }), async (req, res) => {
  const { d } = await stopOf(req, req.params.id);
  const kind = A.oneOf(String(req.query.kind || ''), POD_KINDS, undefined, 'Type de preuve inconnu (signature ou photo).');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const t = X().sniff(buf);
  if (!t || !t.mime.startsWith('image/')) throw new HttpError(400, 'Image non reconnue : envoyez une photo ou une signature (JPEG, PNG ou WebP).');
  if (buf.length > MAX_POD) throw new HttpError(413, 'Image trop lourde (2 Mo au plus).');
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM logistics_pod WHERE delivery_id = ?').get(d.id)).c);
  if (n >= MAX_POD_PER) throw new HttpError(403, `Il y a déjà ${MAX_POD_PER} preuves pour cette livraison.`);
  const id = Number((await db.prepare('INSERT INTO logistics_pod (org_id, delivery_id, kind, mime, size, sha256, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, d.id, kind, t.mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), X().seal(buf), req.user.id, nowISO())).lastInsertRowid);
  await LG().addEvent(req, d.id, d.status, kind === 'signature' ? 'Signature du client enregistrée' : 'Photo de livraison enregistrée');
  res.status(201).json({ id, kind, mime: t.mime, size: buf.length });
});
router.get('/tms/stops/:id/pod', async (req, res) => {
  const d = await LG().delOf(req, req.params.id);
  if (!A.can(req, 'manager')) { if (!d.round_id || !await isDriverOf(req, await tripOf(req, d.round_id))) throw new HttpError(403, 'Seuls le chauffeur de la tournée et les responsables voient les preuves.'); }
  const rows = await db.prepare('SELECT id, kind, mime, size, created_at FROM logistics_pod WHERE delivery_id = ? ORDER BY id').all(d.id);
  res.json({ files: rows.map((x) => ({ id: x.id, kind: x.kind, mime: x.mime, size: Number(x.size), createdAt: x.created_at })) });
});
router.get('/tms/pod/:id/file', async (req, res) => {
  const x = await db.prepare('SELECT * FROM logistics_pod WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Preuve introuvable.');
  const d = await LG().delOf(req, x.delivery_id);
  if (!A.can(req, 'manager') && !(d.round_id && await isDriverOf(req, await tripOf(req, d.round_id)))) throw new HttpError(403, 'Seuls le chauffeur de la tournée et les responsables voient les preuves.');
  const data = X().unseal(x.data);
  if (!data) throw new HttpError(500, 'Cette preuve ne peut pas être relue (clé de chiffrement modifiée).');
  res.set({ 'Content-Type': x.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename="preuve-${x.id}.${x.mime.split('/')[1].replace('jpeg', 'jpg')}"` });
  res.end(data);
});

// ---------- Suivi client : lien secret et message prêt à envoyer ----------
const newToken = () => crypto.randomBytes(18).toString('base64url'); // 24 caractères, 144 bits : impossible à deviner
async function tokenOf(d) {
  if (d.track_token) return d.track_token;
  const t = newToken();
  await db.prepare('UPDATE logistics_deliveries SET track_token = ? WHERE id = ? AND track_token IS NULL').run(t, d.id);
  return (await db.prepare('SELECT track_token FROM logistics_deliveries WHERE id = ?').get(d.id)).track_token;
}
const trackUrl = (t) => `${require('../config').siteUrl || ''}/suivi/${t}`;
router.get('/tms/deliveries/:id/share', async (req, res) => {
  const d = await LG().delOf(req, req.params.id);
  const t = await tokenOf(d);
  const url = trackUrl(t);
  const s = await settings(req.org.id);
  const win = etaWindow(d.eta, s);
  const when = d.planned_date ? ` le ${d.planned_date.split('-').reverse().join('/')}${win && ['shipped', 'on_route', 'to_prepare'].includes(d.status) ? ` entre ${win.from} et ${win.to}` : ''}` : '';
  const org = req.org.name;
  const message = d.status === 'delivered' ? `Bonjour ${d.customer_name}, votre commande chez ${org} a été livrée. Détail : ${url}`
    : d.status === 'failed' ? `Bonjour ${d.customer_name}, nous n'avons pas pu vous livrer. Suivez votre livraison et contactez-nous : ${url}`
      : `Bonjour ${d.customer_name}, votre livraison ${org} est prévue${when}. Suivez-la ici : ${url}`;
  const digits = String(d.phone || '').replace(/\D/g, '').replace(/^00/, '');
  res.json({ token: t, url, message, whatsapp: digits.length >= 8 ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null, email: { subject: `Votre livraison ${org}`, text: `${message}\n\n${org}` }, mailEnabled: require('../services/notify').mailEnabled() });
});
router.post('/tms/deliveries/:id/share/email', async (req, res) => {
  const d = await LG().delOf(req, req.params.id);
  const to = cleanText(String((req.body || {}).to || ''), 150);
  const notify = require('../services/notify');
  if (!notify.mailEnabled()) throw new HttpError(400, "L'envoi d'e-mails n'est pas activé sur ce serveur : copiez le message et envoyez-le vous-même.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new HttpError(400, 'Adresse e-mail invalide.');
  const url = trackUrl(await tokenOf(d));
  await notify.sendMail({ to, subject: `Votre livraison ${req.org.name}`, text: `Bonjour ${d.customer_name},\n\nSuivez votre livraison ici : ${url}\n\n${req.org.name}`, fromName: req.org.name });
  await LG().addEvent(req, d.id, d.status, `Lien de suivi envoyé par e-mail`);
  res.json({ ok: true });
});
router.post('/tms/deliveries/:id/share/revoke', mgr, async (req, res) => {
  const d = await LG().delOf(req, req.params.id);
  await db.prepare('UPDATE logistics_deliveries SET track_token = NULL WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

// Page publique de suivi : aucune donnée personnelle (ni adresse, ni téléphone, ni montant), seulement l'état, les étapes et le créneau.
const PUBLIC_STEPS = { to_prepare: 'Commande en préparation', shipped: 'Expédiée', on_route: 'En route', arrived: 'Le livreur est arrivé', delivered: 'Livrée', failed: 'Tentative de livraison sans succès', returned: 'Retournée à l\'expéditeur' };
pub.get('/track/:token', limits.make(60 * 1000, 30, 'Trop de requêtes. Réessayez dans une minute.'), async (req, res) => {
  const t = String(req.params.token || '');
  const d = /^[A-Za-z0-9_-]{24}$/.test(t) ? await db.prepare('SELECT * FROM logistics_deliveries WHERE track_token = ?').get(t) : null;
  if (!d) return res.status(404).json({ error: 'Suivi introuvable : le lien est incomplet ou n\'est plus valable.' });
  const org = await db.prepare('SELECT name, currency FROM orgs WHERE id = ?').get(d.org_id);
  const s = await settings(d.org_id);
  const ev = await db.prepare('SELECT status, created_at FROM logistics_events WHERE delivery_id = ? ORDER BY id').all(d.id);
  const steps = []; for (const e of ev) { if (!PUBLIC_STEPS[e.status]) continue; if (steps.length && steps[steps.length - 1].status === e.status) continue; steps.push({ status: e.status, label: PUBLIC_STEPS[e.status], at: e.created_at }); }
  let eta = d.eta || ''; let before = null;
  if (d.round_id && ['to_prepare', 'shipped', 'on_route'].includes(d.status)) {
    const r = await db.prepare('SELECT * FROM logistics_rounds WHERE id = ?').get(d.round_id);
    const stops = await db.prepare('SELECT * FROM logistics_deliveries WHERE round_id = ? ORDER BY round_pos, id').all(d.round_id);
    if (r) eta = (await liveEtas({ org: { id: d.org_id } }, r, stops, s)).get(Number(d.id)) || eta;
    before = stops.filter((x) => Number(x.round_pos) < Number(d.round_pos) && !FINISHED.includes(x.status)).length;
  }
  const open = ['to_prepare', 'shipped', 'on_route'].includes(d.status);
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.json({ organisation: org ? org.name : '', reference: d.tracking || `#${d.id}`, status: d.status, statusLabel: PUBLIC_STEPS[d.status], outcome: d.outcome || '', plannedDate: d.planned_date || null,
    window: open && eta ? etaWindow(eta, s) : null, stopsBefore: open ? before : null, deliveredAt: d.status === 'delivered' ? d.delivered_at : null, partial: d.outcome === 'partial', steps });
});

module.exports = router;
Object.assign(module.exports, { pub, saveTmsFields, returnPart, settings, ctxOf, pointOf, depotOf, local, REASONS, TRIP_STATUS, tripOf, FINISHED });
