'use strict';
// Transport (TMS) : réglages et réseau, planification (charge des véhicules, ordre de passage plus proche voisin + 2-opt sur distances
// haversine ou matrice de zones, créneaux), permis et assurance, répartition, fiche de tournée PDF, exécution par le chauffeur
// (arrivée, livraison partielle, refus, échec et report, encaissement), preuves de livraison chiffrées, suivi client par lien secret,
// grilles tarifaires (valeurs recalculées à la main), frais réels et répartition, factures de transporteurs rapprochées, écritures
// comptables, indicateurs et exports CSV, rôles, cloisonnement entre organisations. Le stock reste juste à chaque étape.
// Lancez-le avec : node scripts/test-tms.js
const { run } = require('./lib/wave1');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
// Recalcul indépendant (formules de la documentation) pour vérifier les valeurs du serveur.
const hav = (a, b) => { const rad = (d) => (d * Math.PI) / 180; const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };
const leg = (a, b) => Math.round(hav(a, b) * 1.3 * 10) / 10;
const hm = (m) => `${String(Math.floor(Math.round(m) / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
const PNG = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000IHDR' + tag + 'x'.repeat(40))]);

run('Transport (TMS) : planification, exécution chauffeur, suivi client, coûts, indicateurs', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx, base }) => {
  const L = `${O}/logistics`; const TM = `${L}/tms`;
  const T0 = day(0);
  let r;
  const qty = async (id) => Number((await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(id)).quantity);
  const coherent = async () => (await dbx.prepare('SELECT i.id, i.quantity, COALESCE((SELECT SUM(s.quantity) FROM wms_stock s WHERE s.item_id = i.id), 0) AS loc FROM stock_items i WHERE i.org_id = ?').all(org)).filter((x) => Math.abs(Number(x.quantity) - Number(x.loc)) > 1e-6);
  const ok = async (label) => { const c = await coherent(); check(`stock cohérent (total = emplacements) ${label}`, c.length === 0, c); };

  // ---------- Réglages, réseau ----------
  r = await mem('PUT', `${TM}/settings`, { depotLat: 4, depotLng: 9.7 });
  check('réglages : un membre ne modifie pas', r.status === 403, r.status);
  r = await mgr('PUT', `${TM}/settings`, { depotLabel: 'Dépôt Bassa', depotLat: 4, depotLng: 9.7, speedKmh: 30, serviceMin: 10, roadFactor: 1.3, tzOffset: 0, tolerancePct: 2, toleranceMin: 500, etaMargin: 30 });
  check('réglages du dépôt enregistrés', r.status === 200 && r.json.settings.depotLat === 4 && r.json.settings.roadFactor === 1.3, r.json);
  r = await mgr('PUT', `${TM}/settings`, { depotLat: 4, depotLng: null });
  check('réglages : latitude sans longitude refusée', r.status === 400, r.json);
  const zone = async (b) => (await mgr('POST', `${L}/zones`, b)).json.id;
  const Z1 = await zone({ name: 'Akwa', fee: 1000 }); const Z2 = await zone({ name: 'Bonabéri', fee: 2000 }); const Z3 = await zone({ name: 'Inconnue' });
  r = await mgr('PUT', `${TM}/zones/${Z1}`, { depotKm: 5, intraKm: 2, sortOrder: 1 });
  check('zone : distance depuis le dépôt', r.status === 200, r.json);
  await mgr('PUT', `${TM}/zones/${Z2}`, { depotKm: 12, intraKm: 3, sortOrder: 2 });
  r = await mgr('PUT', `${TM}/zone-km`, { zoneA: Z2, zoneB: Z1, km: 9 });
  check('matrice : distance Bonabéri ↔ Akwa', r.status === 200, r.json);
  r = await mgr('PUT', `${TM}/zone-km`, { zoneA: Z1, zoneB: Z1, km: 3 });
  check('matrice : même zone refusée', r.status === 400, r.json);
  r = await mem('GET', `${TM}/network`);
  check('réseau lisible : zones et matrice (rangée dans l\'ordre)', r.status === 200 && r.json.distances.length === 1 && r.json.distances[0].km === 9 && r.json.zones.find((z) => z.id === Z2).depotKm === 12, r.json);

  // ---------- Parc : capacités, chauffeur relié à un compte ----------
  const members = (await owner('GET', `${O}/members`)).json.members;
  const memId = members.find((m) => m.name === 'Paul').userId;
  const veh = async (b) => (await mgr('POST', `${L}/vehicles`, b)).json.id;
  const V1 = await veh({ plate: 'LT-500', kind: 'truck', capacityKg: 500, capacityM3: 6, capacityPallets: 2, kmRate: 150, co2: 200, odometer: 1000 });
  const V2 = await veh({ plate: 'LT-100', kind: 'van', capacityKg: 100, kmRate: 80, odometer: 500 });
  const V3 = await veh({ plate: 'LT-OLD', kind: 'van', capacityKg: 1000 });
  r = await mgr('GET', `${L}/fleet`);
  check('véhicule : capacités et coût au km', r.json.vehicles.find((v) => v.id === V1).capacityKg === 500 && r.json.vehicles.find((v) => v.id === V1).kmRate === 150, r.json.vehicles.find((v) => v.id === V1));
  r = await mgr('POST', `${L}/drivers`, { name: 'Paul Chauffeur', userId: memId, dailyAllowance: 2000 });
  const D1 = r.json.id;
  check('chauffeur relié au compte de Paul', r.status === 201, r.json);
  r = await mgr('POST', `${L}/drivers`, { name: 'Doublon', userId: memId });
  check('un compte = un seul chauffeur', r.status === 409, r.json);
  r = await mgr('POST', `${L}/drivers`, { name: 'Ali Sans Compte' }); const D2 = r.json.id;
  r = await mgr('POST', `${L}/drivers`, { name: 'Bob Permis Périmé' }); const D3 = r.json.id;
  r = await mgr('POST', `${L}/drivers`, { name: 'Karl' }); const D4 = r.json.id;
  await mgr('POST', `${L}/compliance`, { subject: 'driver', driverId: D3, kind: 'license', expiresAt: day(-3) });
  await mgr('POST', `${L}/compliance`, { subject: 'driver', driverId: D1, kind: 'license', expiresAt: day(300) });
  await mgr('POST', `${L}/compliance`, { subject: 'vehicle', vehicleId: V3, kind: 'insurance', expiresAt: day(-1) });

  // ---------- Livraisons ----------
  const S = `${O}/stock`;
  const riz = (await mgr('POST', `${S}/items`, { name: 'Riz 25 kg', unit: 'sac', quantity: 20, unitCost: 15000 })).json.id;
  const huile = (await mgr('POST', `${S}/items`, { name: 'Huile', unit: 'bidon', quantity: 10, unitCost: 6000 })).json.id;
  await ok('au départ');
  const mk = async (b) => { const x = await mem('POST', `${L}/deliveries`, { plannedDate: T0, ...b }); if (x.status !== 201) console.log(x.json); return x.json.id; };
  r = await mem('POST', `${L}/deliveries`, { customerName: 'X', windowStart: '12:00', windowEnd: '10:00' });
  check('créneau à l\'envers refusé', r.status === 400, r.json);
  r = await mem('POST', `${L}/deliveries`, { customerName: 'X', lat: 4.1 });
  check('latitude sans longitude refusée', r.status === 400, r.json);
  r = await mem('POST', `${L}/deliveries`, { customerName: 'X', windowEnd: '25:00' });
  check('heure invalide refusée', r.status === 400, r.json);

  // ---------- Ordre de passage (GPS, haversine × 1,3) ----------
  const DEP = { lat: 4, lng: 9.7 };
  const P = { A: { lat: 4, lng: 9.73 }, B: { lat: 4, lng: 9.71 }, C: { lat: 4, lng: 9.72 } };
  const gA = await mk({ customerName: 'Gps A', ...P.A, weight: 10 });
  const gB = await mk({ customerName: 'Gps B', ...P.B, weight: 10 });
  const gC = await mk({ customerName: 'Gps C', ...P.C, weight: 10 });
  r = await mem('POST', `${TM}/plan/suggest`, { date: T0, deliveryIds: [gA, gB, gC], vehicleIds: [V1] });
  const t1 = r.json.trips && r.json.trips[0];
  const kmGps = Math.round((leg(DEP, P.B) + leg(P.B, P.C) + leg(P.C, P.A) + leg(P.A, DEP)) * 10) / 10;
  check('proposition : une tournée, méthode « route » (GPS)', r.status === 200 && r.json.trips.length === 1 && t1.method === 'route', r.json);
  check('ordre de passage : plus proche voisin depuis le dépôt (B, C, A)', JSON.stringify(t1.stops.map((s) => s.deliveryId)) === JSON.stringify([gB, gC, gA]), t1 && t1.stops);
  check(`kilomètres (haversine × 1,3, retour au dépôt) = ${kmGps}`, t1.km === kmGps, t1.km);
  let tm = 480 + leg(DEP, P.B) * 2; const eB = hm(tm); tm += 10 + leg(P.B, P.C) * 2; const eC = hm(tm);
  check(`heures estimées : départ 08:00, 30 km/h, 10 min d'arrêt (B ${eB}, C ${eC})`, t1.stops[0].eta === eB && t1.stops[1].eta === eC, t1.stops.map((s) => s.eta));
  check('proposition : coût estimé (km × 150 + indemnité 2000) pour un responsable seulement', t1.estCost === undefined, t1.estCost);
  r = await mgr('POST', `${TM}/plan/suggest`, { date: T0, deliveryIds: [gA, gB, gC], vehicleIds: [V1] });
  check('proposition (responsable) : premier chauffeur libre au permis valable (Ali), coût = arrondi(km × 150) + son indemnité (0)', r.json.trips[0].estCost === Math.round(kmGps * 150) && r.json.trips[0].driverId === D2, r.json.trips[0]);
  // Créneau : A doit être livré avant 08:12 → le 2-opt le met en tête (même kilométrage, aucun retard).
  await mem('PUT', `${L}/deliveries/${gA}`, { windowEnd: '08:12' });
  r = await mem('POST', `${TM}/plan/suggest`, { date: T0, deliveryIds: [gA, gB, gC], vehicleIds: [V1] });
  check('créneau serré : A passe en premier (2-opt avec pénalité de retard), sans retard', r.json.trips[0].stops[0].deliveryId === gA && r.json.trips[0].late === 0 && r.json.trips[0].km === kmGps, r.json.trips[0]);

  // ---------- Matrice de zones (sans GPS) ----------
  const z1a = await mk({ customerName: 'Akwa 1', zoneId: Z1, weight: 20 });
  const z2a = await mk({ customerName: 'Bonabéri 1', zoneId: Z2, weight: 20 });
  const z1b = await mk({ customerName: 'Akwa 2', zoneId: Z1, weight: 20 });
  r = await mem('POST', `${TM}/plan/suggest`, { date: T0, deliveryIds: [z2a, z1a, z1b], vehicleIds: [V1] });
  check('matrice : Akwa d\'abord (5 km), puis Akwa (2 km), puis Bonabéri (9 km), retour 12 km = 28 km', r.json.trips[0].method === 'route' && r.json.trips[0].km === 28 && r.json.trips[0].stops[2].deliveryId === z2a, r.json.trips[0]);
  const zx = await mk({ customerName: 'Sans repère', zoneId: Z3, weight: 5 });
  r = await mem('POST', `${TM}/plan/suggest`, { date: T0, deliveryIds: [z2a, zx, z1a], vehicleIds: [V1] });
  check('distance inconnue : ordre des zones (rang), km non estimés', r.json.trips[0].method === 'zones' && r.json.trips[0].km === null && r.json.trips[0].stops[0].deliveryId === z1a, r.json.trips[0]);

  // ---------- Capacité ----------
  const c300 = await mk({ customerName: 'Lourd 300', weight: 300, zoneId: Z1 });
  const c150 = await mk({ customerName: 'Moyen 150', weight: 150, zoneId: Z1 });
  const c80 = await mk({ customerName: 'Léger 80', weight: 80, zoneId: Z1 });
  const c600 = await mk({ customerName: 'Trop lourd 600', weight: 600, zoneId: Z1 });
  r = await mgr('POST', `${TM}/plan/suggest`, { date: T0, deliveryIds: [c300, c150, c80, c600] });
  const byVeh = Object.fromEntries((r.json.trips || []).map((t) => [t.vehicleId, t.stops.map((s) => s.deliveryId).sort()]));
  check('chargement : LT-OLD (assurance périmée) écarté des véhicules libres', !(r.json.trips || []).some((t) => t.vehicleId === V3), r.json.trips);
  check('chargement : 300 + 150 kg dans LT-500, 80 kg dans LT-100', JSON.stringify(byVeh[V1]) === JSON.stringify([c300, c150].sort()) && JSON.stringify(byVeh[V2]) === JSON.stringify([c80]), byVeh);
  check('chargement : 600 kg ne tient dans aucun véhicule', r.json.unassigned.length === 1 && r.json.unassigned[0].deliveryId === c600 && r.json.unassigned[0].reason === 'capacity', r.json.unassigned);
  const tV1 = r.json.trips.find((t) => t.vehicleId === V1);
  check('chargement : taux 90 % du poids de LT-500', tV1.load.pctKg === 90 && tV1.load.weight === 450, tV1.load);
  r = await mem('POST', `${TM}/plan/commit`, { date: T0, trips: [{ vehicleId: V1, driverId: D1, deliveryIds: [c300] }] });
  check('validation : un membre ne crée pas les tournées', r.status === 403, r.status);
  r = await mgr('POST', `${TM}/plan/commit`, { date: T0, trips: [{ vehicleId: V2, driverId: D2, deliveryIds: [c150] }] });
  check('validation : surcharge refusée (150 kg pour 100 kg)', r.status === 409 && /trop chargé/.test(r.json.error), r.json);
  r = await mgr('POST', `${TM}/plan/commit`, { date: T0, trips: [{ vehicleId: V2, driverId: D3, deliveryIds: [c80] }] });
  check('validation : permis périmé refusé', r.status === 400 && /permis/.test(r.json.error), r.json);
  r = await mgr('POST', `${TM}/plan/commit`, { date: T0, trips: [{ vehicleId: V3, driverId: D2, deliveryIds: [c80] }] });
  check('validation : assurance du véhicule périmée refusée', r.status === 400 && /assurance/i.test(r.json.error), r.json);
  // Même règle pour une tournée simple de la Logistique (sinon on la démarrerait sans passer par la répartition).
  r = await mgr('POST', `${L}/rounds`, { name: 'Tournée manuelle LT-OLD', date: T0, vehicleId: V3 });
  check('tournée simple : véhicule à l\'assurance périmée refusé', r.status === 400 && /assurance du véhicule LT-OLD est périmée/.test(r.json.error), r.json);
  r = await mgr('POST', `${TM}/plan/commit`, { date: T0, trips: [{ vehicleId: V1, driverId: D1, deliveryIds: [c300] }, { vehicleId: V2, driverId: D2, deliveryIds: [c300] }] });
  check('validation : une livraison dans deux tournées refusée', r.status === 400, r.json);

  // ---------- Tournée GPS + stock : création, répartition, fiche ----------
  const stockA = await mk({ customerName: 'Boutique Ali', phone: '237690000001', address: 'Rue 1, Akwa', ...P.B, weight: 50, codAmount: 25000, items: [{ itemId: riz, quantity: 5 }, { itemId: huile, quantity: 2 }] });
  const stockB = await mk({ customerName: 'Chez Fanta', ...P.C, weight: 20, items: [{ itemId: riz, quantity: 2 }] });
  const absent = await mk({ customerName: 'Client Absent', ...P.A, weight: 10 });
  // Expédition de l'entrepôt (pas d'articles : le stock est déjà sorti) avec une palette de 250 kg.
  const now = new Date().toISOString();
  const wmsDel = Number((await dbx.prepare("INSERT INTO logistics_deliveries (org_id, customer_name, fee, planned_date, status, note, created_by, created_at, updated_at, lat, lng) VALUES (?, 'Grossiste Wms', 0, ?, 'shipped', 'Expédition EXP-1', 1, ?, ?, 4, 9.725) RETURNING id").get(org, T0, now, now)).id);
  const hu = Number((await dbx.prepare("INSERT INTO wms_hus (org_id, code, type, status, weight, created_at, updated_at) VALUES (?, 'PAL-T1', 'pallet', 'shipped', 200, ?, ?) RETURNING id").get(org, now, now)).id);
  await dbx.prepare("INSERT INTO wms_hus (org_id, code, type, status, weight, parent_id, created_at, updated_at) VALUES (?, 'COL-T1', 'box', 'shipped', 50, ?, ?, ?)").run(org, hu, now, now);
  const shp = Number((await dbx.prepare("INSERT INTO wms_shipments (org_id, code, status, delivery_id, created_at) VALUES (?, 'EXP-T1', 'shipped', ?, ?) RETURNING id").get(org, wmsDel, now)).id);
  await dbx.prepare('INSERT INTO wms_shipment_units (shipment_id, hu_id, loaded) VALUES (?, ?, 1)').run(shp, hu);
  r = await mem('GET', `${TM}/candidates?date=${T0}`);
  const cw = r.json.deliveries.find((d) => d.id === wmsDel);
  check('expédition de l\'entrepôt : poids (palette + colis = 250 kg) et 1 palette repris', cw && cw.weight === 250 && cw.pallets === 1, cw);
  r = await mgr('POST', `${TM}/plan/commit`, { date: T0, trips: [{ name: 'Matin Akwa', vehicleId: V1, driverId: D1, deliveryIds: [absent, stockA, wmsDel, stockB], startTime: '08:00' }] });
  check('tournée créée', r.status === 201 && r.json.trips.length === 1 && r.json.trips[0].stops === 4, r.json);
  const trip = r.json.trips[0].id;
  r = await mem('GET', `${TM}/trips/${trip}`);
  const tv = r.json.trip;
  check('tournée : ordre B (Ali), C (Fanta), Wms, A (absent)', JSON.stringify(tv.stops.map((s) => s.id)) === JSON.stringify([stockA, stockB, wmsDel, absent]), tv.stops.map((s) => [s.id, s.customerName]));
  check('tournée : charge 330 kg / 500 (66 %), 1 palette', tv.load.weight === 330 && tv.load.pctKg === 66 && tv.load.pallets === 1, tv.load);
  check('tournée : à encaisser 25 000', tv.cod.due === 25000, tv.cod);
  check('tournée : montants cachés au membre', tv.estCost === undefined && tv.costs === undefined, tv);
  r = await mgr('GET', `${TM}/trips/${trip}`);
  check('tournée : coût estimé pour le responsable', typeof r.json.trip.estCost === 'number' && r.json.trip.estCost > 2000, r.json.trip.estCost);
  check('stock inchangé tant que la tournée n\'est pas partie', await qty(riz) === 20 && await qty(huile) === 10, [await qty(riz), await qty(huile)]);
  r = await mgr('POST', `${TM}/plan/commit`, { date: T0, trips: [{ vehicleId: V1, driverId: D2, deliveryIds: [c80] }] });
  check('véhicule déjà pris ce jour-là : refusé', r.status === 409, r.json);
  r = await mgr('POST', `${TM}/trips/${trip}/optimize`, {});
  check('réordonner une tournée planifiée', r.status === 200 && r.json.order.length === 4, r.json);
  r = await mem('GET', `${TM}/trips/${trip}/sheet`);
  check('fiche de tournée PDF', r.status === 200 && r.headers.get('content-type') === 'application/pdf' && r.buf.slice(0, 5).toString() === '%PDF-', r.status);
  r = await mem('GET', `${TM}/dispatch?from=${T0}&days=7`);
  check('tableau de répartition : semaine, la tournée le jour J, véhicules libres', r.status === 200 && r.json.days.length === 7 && r.json.days[0].trips.some((t) => t.id === trip) && r.json.days[0].freeVehicles.includes('LT-100') && !r.json.days[0].freeVehicles.includes('LT-500'), r.json.days[0]);
  r = await mem('GET', `${TM}/trips?from=${day(-1)}&to=${day(1)}`);
  check('liste des tournées de la période', r.status === 200 && r.json.trips.some((x) => x.id === trip && x.stopsCount === 4 && x.stops === undefined), r.json.trips);
  r = await mem('POST', `${TM}/trips/${trip}/dispatch`, {});
  check('répartir : réservé aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${TM}/trips/${trip}/dispatch`, {});
  check('tournée répartie', r.status === 200, r.json);
  r = await mgr('GET', `${L}/rounds`);
  check('ancienne liste des tournées toujours servie (état, arrêts)', r.json.rounds.find((x) => x.id === trip).status === 'dispatched' && r.json.rounds.find((x) => x.id === trip).deliveries.length === 4, r.json.rounds.find((x) => x.id === trip));

  // ---------- Chauffeur ----------
  r = await mem('GET', `${TM}/driver?date=${T0}`);
  check('chauffeur : « ma tournée » du jour', r.status === 200 && r.json.driver.id === D1 && r.json.trips.length === 1 && r.json.trips[0].isMine === true, r.json);
  r = await mgr('GET', `${TM}/driver?date=${T0}`);
  check('compte non relié : message explicite', r.status === 200 && r.json.driver === null && /relié/.test(r.json.message), r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/arrive`, {});
  check('arrivée refusée avant le départ', r.status === 400, r.json);
  r = await mem('POST', `${TM}/trips/${trip}/start`, { odometer: 900 });
  check('départ : kilométrage sous le compteur refusé', r.status === 400, r.json);
  r = await mem('POST', `${TM}/trips/${trip}/start`, { odometer: 1000 });
  check('départ de la tournée par son chauffeur', r.status === 200, r.json);
  check('départ : le stock des livraisons sort une fois (riz 20 - 7, huile 10 - 2)', await qty(riz) === 13 && await qty(huile) === 8, [await qty(riz), await qty(huile)]);
  await ok('après le départ');
  r = await mgr('GET', `${L}/deliveries/${wmsDel}`);
  check('expédition de l\'entrepôt : en route, sans mouvement de stock', r.json.delivery.status === 'on_route' && r.json.delivery.stockOut === false, r.json.delivery);
  r = await mem('POST', `${TM}/trips/${trip}/start`, {});
  check('départ en double refusé', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/arrive`, { lat: 4, lng: 9.71 });
  check('arrivée chez le client (GPS)', r.status === 200, r.json);
  // Preuves de livraison
  r = await mem('POST', `${TM}/stops/${stockA}/pod?kind=signature`, PNG('SECRETMARK-SIG'));
  check('signature (PNG) enregistrée', r.status === 201 && r.json.mime === 'image/png', r.json);
  const sig = r.json.id;
  r = await mem('POST', `${TM}/stops/${stockA}/pod?kind=photo`, Buffer.from('<html><script>alert(1)</script></html>'));
  check('preuve : HTML refusé (type lu dans le contenu)', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/pod?kind=photo`, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100)]));
  check('preuve : PDF refusé (images seulement)', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/pod?kind=photo`, Buffer.concat([PNG('BIG'), Buffer.alloc(2 * 1024 * 1024)]));
  check('preuve : image de plus de 2 Mo refusée', r.status === 413, r.status);
  r = await mem('POST', `${TM}/stops/${stockA}/pod?kind=video`, PNG('x'));
  check('preuve : type inconnu refusé', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/pod?kind=photo`, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-photo-SECRETMARK-PHOTO' + 'y'.repeat(50))]));
  check('photo (JPEG) enregistrée', r.status === 201 && r.json.mime === 'image/jpeg', r.json);
  const raw = await dbx.prepare('SELECT data, sha256 FROM logistics_pod WHERE id = ?').get(sig);
  check('preuve chiffrée dans la base (texte en clair absent, empreinte SHA-256)', !Buffer.from(raw.data).includes(Buffer.from('SECRETMARK')) && /^[a-f0-9]{64}$/.test(raw.sha256), null);
  r = await mem('GET', `${TM}/pod/${sig}/file`);
  check('preuve relue par le chauffeur, identique, en-têtes de sécurité', r.status === 200 && r.buf.equals(PNG('SECRETMARK-SIG')) && r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy')), r.status);
  r = await other('GET', `${ws(org2)}/logistics/tms/pod/${sig}/file`);
  check('preuve : introuvable depuis une autre organisation', r.status === 404, r.status);
  r = await other('POST', `${ws(org2)}/logistics/tms/stops/${stockA}/pod?kind=photo`, PNG('x'));
  check('preuve : envoi impossible depuis une autre organisation', r.status === 404, r.status);
  // Issue de l'arrêt : livraison partielle avec encaissement
  r = await mem('GET', `${TM}/trips/${trip}`);
  const lines = r.json.trip.stops.find((s) => s.id === stockA).items;
  const lr = lines.find((x) => x.name === 'Riz 25 kg'); const lh = lines.find((x) => x.name === 'Huile');
  check('arrêt : preuves comptées (1 signature, 1 photo)', r.json.trip.stops.find((s) => s.id === stockA).pod.signature === 1 && r.json.trip.stops.find((s) => s.id === stockA).pod.photo === 1, r.json.trip.stops[0].pod);
  r = await mem('POST', `${TM}/stops/${stockA}/complete`, { outcome: 'partial', lines: [{ id: lr.id, delivered: 3 }, { id: lh.id, delivered: 2 }], codCollected: 15000 });
  check('livraison : nom du destinataire obligatoire', r.status === 400 && /nom/.test(r.json.error), r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/complete`, { outcome: 'partial', recipient: 'Ali', lines: [{ id: lr.id, delivered: 3 }, { id: lh.id, delivered: 2 }] });
  check('paiement à la livraison : montant encaissé obligatoire', r.status === 400 && /encaissé/.test(r.json.error), r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/complete`, { outcome: 'partial', recipient: 'Ali', lines: [{ id: lr.id, delivered: 3 }, { id: lh.id, delivered: 2 }], codCollected: 30000 });
  check('encaissement supérieur au dû refusé', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/complete`, { outcome: 'partial', recipient: 'Ali', lines: [{ id: lr.id, delivered: 6 }, { id: lh.id, delivered: 2 }], codCollected: 15000 });
  check('partielle : plus que chargé refusé', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/complete`, { outcome: 'partial', recipient: 'Ali', lines: [{ id: lr.id, delivered: 5 }, { id: lh.id, delivered: 2 }], codCollected: 15000 });
  check('partielle : tout livré → choisir « Livrée »', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${stockA}/complete`, { outcome: 'partial', recipient: 'Ali', lines: [{ id: lr.id, delivered: 3 }, { id: lh.id, delivered: 2 }], codCollected: 15000, lat: 4, lng: 9.71 });
  check('livraison partielle : 2 sacs non livrés remis en stock', r.status === 200 && r.json.returnedToStock.length === 1 && r.json.returnedToStock[0].quantity === 2, r.json);
  check('stock : riz 13 + 2 = 15', await qty(riz) === 15, await qty(riz));
  await ok('après la livraison partielle');
  r = await mem('POST', `${TM}/stops/${stockA}/complete`, { outcome: 'delivered', recipient: 'Ali' });
  check('arrêt déjà terminé : refusé', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${stockB}/complete`, { outcome: 'refused' });
  check('refus : motif « refus du client » par défaut', r.status === 200 && r.json.outcome === 'refused', r.json);
  r = await mem('POST', `${TM}/stops/${absent}/complete`, { outcome: 'failed', reason: 'other' });
  check('échec « autre motif » sans précision refusé', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${absent}/complete`, { outcome: 'failed', reason: 'absent', rescheduleDate: day(1) });
  check('échec, client absent : nouvelle tentative demain', r.status === 200 && r.json.rescheduled === day(1), r.json);
  r = await mgr('GET', `${L}/deliveries/${absent}`);
  check('reportée : sortie de la tournée, à replanifier demain', r.json.delivery.roundId === null && r.json.delivery.status === 'shipped' && r.json.delivery.plannedDate === day(1) && r.json.delivery.attempts === 1 && r.json.delivery.failureReason === 'absent', r.json.delivery);
  r = await mem('POST', `${TM}/trips/${trip}/finish`, { odometer: 1042 });
  check('fin de tournée refusée : il reste un arrêt', r.status === 409 && /Grossiste/.test(r.json.error), r.json);
  // Saisie après coup de l'heure réelle (bon papier) : responsable seulement, avec justificatif, jamais dans le futur ni avant le jour de la tournée
  const loc0 = day(0); // fuseau réglé plus haut : UTC+0
  r = await mem('POST', `${TM}/stops/${wmsDel}/complete`, { outcome: 'delivered', recipient: 'Magasinier', deliveredAt: `${loc0}T00:00`, note: 'BL papier 0412' });
  check('heure saisie après coup : refusée à un membre', r.status === 403, r.json);
  r = await mgr('POST', `${TM}/stops/${wmsDel}/complete`, { outcome: 'delivered', recipient: 'Magasinier', deliveredAt: `${loc0}T00:00` });
  check('heure saisie après coup : justificatif obligatoire', r.status === 400 && /justifie/.test(r.json.error), r.json);
  r = await mgr('POST', `${TM}/stops/${wmsDel}/complete`, { outcome: 'delivered', recipient: 'Magasinier', deliveredAt: `${day(2)}T10:00`, note: 'BL papier 0412' });
  check('heure saisie après coup : pas dans le futur', r.status === 400, r.json);
  r = await mgr('POST', `${TM}/stops/${wmsDel}/complete`, { outcome: 'delivered', recipient: 'Magasinier', deliveredAt: `${day(-3)}T10:00`, note: 'BL papier 0412' });
  check('heure saisie après coup : pas avant le jour de la tournée', r.status === 400, r.json);
  r = await mgr('POST', `${TM}/stops/${wmsDel}/complete`, { outcome: 'delivered', recipient: 'Magasinier', deliveredAt: '2026-13-01T10:00', note: 'BL papier 0412' });
  check('heure saisie après coup : format vérifié', r.status === 400, r.json);
  r = await mgr('POST', `${TM}/stops/${wmsDel}/complete`, { outcome: 'delivered', recipient: 'Magasinier', deliveredAt: `${loc0}T00:00`, note: 'BL papier 0412' });
  const wd = await dbx.prepare('SELECT delivered_at, time_declared FROM logistics_deliveries WHERE id = ?').get(wmsDel);
  check('heure saisie après coup : enregistrée à l\'heure locale (00:00, fuseau du transport) et marquée « déclarée »', r.status === 200 && Number(wd.time_declared) === 1 && wd.delivered_at === `${loc0}T00:00:00.000Z`, wd);
  r = await mgr('GET', `${L}/deliveries/${wmsDel}`);
  check('historique : « heure réelle saisie après coup » visible', JSON.stringify(r.json).includes('saisie après coup'), r.json.delivery && r.json.delivery.events);
  check('expédition livrée (aucun article à sortir)', r.status === 200, r.json);
  check('stock inchangé par la livraison de l\'expédition', await qty(riz) === 15 && await qty(huile) === 8, [await qty(riz), await qty(huile)]);
  r = await mem('POST', `${TM}/trips/${trip}/finish`, { odometer: 1042, codRemitted: 10000 });
  check('fin de tournée : 42 km, écart de caisse 5 000, marchandise refusée rapportée', r.status === 200 && r.json.km === 42 && r.json.cod.gap === 5000 && r.json.returned === 1, r.json);
  check('stock : riz 15 + 2 (refus) = 17', await qty(riz) === 17, await qty(riz));
  r = await mgr('GET', `${L}/fleet`);
  check('compteur du véhicule mis à jour (1042 km)', r.json.vehicles.find((v) => v.id === V1).odometer === 1042, r.json.vehicles.find((v) => v.id === V1).odometer);
  // Retour ultérieur de la livraison partielle : seuls les 3 sacs livrés reviennent, jamais les 2 déjà réintégrés.
  r = await mgr('PUT', `${L}/deliveries/${stockA}/status`, { status: 'returned', note: 'Client a tout renvoyé' });
  check('retour après partielle : riz 17 + 3 = 20, huile 8 + 2 = 10', await qty(riz) === 20 && await qty(huile) === 10, [await qty(riz), await qty(huile)]);
  await mgr('PUT', `${L}/deliveries/${stockA}/status`, { status: 'returned', note: 'Encore' });
  check('second retour sans effet', await qty(riz) === 20, await qty(riz));
  await ok('en fin de tournée');

  // ---------- Suivi client ----------
  r = await mem('GET', `${L}/deliveries/${absent}/notify`);
  check('ancien message « prévenir le client » toujours servi', r.status === 200 && typeof r.json.message === 'string', r.json);
  r = await mem('GET', `${TM}/deliveries/${stockA}/share`);
  const token = r.json.token;
  check('lien de suivi : jeton de 24 caractères, page /suivi/…, message WhatsApp', r.status === 200 && /^[A-Za-z0-9_-]{24}$/.test(token) && r.json.url.endsWith('/suivi/' + token) && /wa\.me\/237690000001/.test(r.json.whatsapp), r.json);
  r = await mem('GET', `${TM}/deliveries/${stockA}/share`);
  check('lien de suivi stable', r.json.token === token, r.json.token);
  const pubGet = async (t) => { const x = await fetch(`${base}/api/ws/public/track/${t}`); return { status: x.status, text: await x.text() }; };
  let p = await pubGet(token);
  const pj = JSON.parse(p.text);
  check('page publique : sans connexion, organisation, état, étapes horodatées', p.status === 200 && pj.organisation === 'Boutique Awa' && pj.status === 'returned' && pj.steps.some((s) => s.status === 'delivered') && pj.steps.every((s) => s.at), pj);
  check('page publique : ni téléphone, ni adresse, ni montant, ni destinataire', !p.text.includes('237690000001') && !p.text.includes('Rue 1') && !p.text.includes('25000') && !p.text.includes('Ali'), p.text);
  p = await pubGet('A'.repeat(24));
  check('jeton inconnu : introuvable', p.status === 404, p.status);
  p = await pubGet('court');
  check('jeton malformé : introuvable', p.status === 404, p.status);
  r = await mem('GET', `${TM}/deliveries/${absent}/share`);
  const tokAbs = r.json.token;
  check('message : livraison prévue demain', /prévue le/.test(r.json.message), r.json.message);
  r = await mem('POST', `${TM}/deliveries/${absent}/share/revoke`, {});
  check('révoquer un lien : réservé aux responsables', r.status === 403, r.status);
  await mgr('POST', `${TM}/deliveries/${absent}/share/revoke`, {});
  p = await pubGet(tokAbs);
  check('lien révoqué : introuvable', p.status === 404, p.status);
  r = await other('GET', `${ws(org2)}/logistics/tms/deliveries/${stockA}/share`);
  check('cloisonnement : lien introuvable depuis une autre organisation', r.status === 404, r.status);
  r = await mem('POST', `${TM}/deliveries/${stockA}/share/email`, { to: 'client@exemple.com' });
  check('e-mail : refusé clairement si l\'envoi n\'est pas activé', r.status === 400 && /e-mails/.test(r.json.error), r.json);

  // ---------- Tournée non attribuée au membre : il ne la conduit pas ----------
  r = await mgr('POST', `${TM}/plan/commit`, { date: T0, trips: [{ name: 'Après-midi', vehicleId: V2, driverId: D2, deliveryIds: [c80], startTime: '14:00' }] });
  const trip2 = r.json.trips[0].id;
  r = await mem('POST', `${TM}/trips/${trip2}/start`, {});
  check('un membre qui n\'est pas le chauffeur ne démarre pas la tournée', r.status === 403, r.status);
  r = await mgr('POST', `${TM}/trips/${trip2}/start`, {});
  r = await mem('POST', `${TM}/stops/${c80}/complete`, { outcome: 'delivered', recipient: 'x' });
  check('… ni ne termine ses arrêts', r.status === 403, r.status);
  r = await mem('GET', `${TM}/stops/${c80}/pod`);
  check('… ni ne voit ses preuves', r.status === 403, r.status);
  r = await other('GET', `${ws(org2)}/logistics/tms/trips/${trip2}`);
  check('cloisonnement : tournée introuvable depuis une autre organisation', r.status === 404, r.status);
  r = await other('POST', `${ws(org2)}/logistics/tms/trips/${trip2}/finish`, {});
  check('cloisonnement : fin de tournée impossible depuis une autre organisation', r.status === 404, r.status);
  await mgr('POST', `${TM}/stops/${c80}/complete`, { outcome: 'delivered', recipient: 'Réception' });
  await mgr('POST', `${TM}/trips/${trip2}/finish`, {});

  // ---------- Grilles tarifaires (valeurs calculées à la main) ----------
  const car = (await mgr('POST', `${L}/carriers`, { name: 'TransExpress', rate: 3000 })).json.id;
  const car2 = (await mgr('POST', `${L}/carriers`, { name: 'Autre Transport' })).json.id;
  r = await mem('POST', `${TM}/rates`, { name: 'X', base: 1 });
  check('grilles : réservées aux responsables', r.status === 403, r.status);
  r = await mem('GET', `${TM}/rates`);
  check('grilles : lecture réservée aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${TM}/rates`, { name: 'Vide', carrierId: car });
  check('grille sans aucun prix refusée', r.status === 400, r.json);
  r = await mgr('POST', `${TM}/rates`, { name: 'Bad', carrierId: car, base: 100, minKg: 100, maxKg: 50 });
  check('tranche de poids à l\'envers refusée', r.status === 400, r.json);
  r = await mgr('POST', `${TM}/rates`, { name: 'Bonabéri 0-200 kg', carrierId: car, zoneId: Z2, minKg: 0, maxKg: 200, base: 2000, perKg: 50, perKm: 100, perPallet: 1500, minCharge: 5000, fuelPct: 10 });
  check('grille créée', r.status === 201, r.json);
  await mgr('POST', `${TM}/rates`, { name: 'Toutes zones 0-200 kg', carrierId: car, minKg: 0, maxKg: 200, base: 1000, perKg: 10 });
  await mgr('POST', `${TM}/rates`, { name: 'Lourd 200 kg et plus', carrierId: car, minKg: 200, base: 20000 });
  r = await mgr('POST', `${TM}/rates/quote`, { carrierId: car, zoneId: Z2, weight: 120, pallets: 1 });
  const q1 = r.json.quote;
  check('devis 120 kg, 1 palette, Bonabéri (12 km) : 2000 + 6000 + 1200 + 1500 = 10 700 ; +10 % = 11 770', q1 && q1.km === 12 && q1.freight === 10700 && q1.fuel === 1070 && q1.total === 11770 && q1.card === 'Bonabéri 0-200 kg', q1);
  r = await mgr('POST', `${TM}/rates/quote`, { carrierId: car, zoneId: Z2, weight: 10 });
  check('minimum de perception : 3 700 → 5 000 ; +10 % = 5 500', r.json.quote.freight === 3700 && r.json.quote.minimumApplied === true && r.json.quote.total === 5500, r.json.quote);
  r = await mgr('POST', `${TM}/rates/quote`, { carrierId: car, zoneId: Z1, weight: 50 });
  check('zone sans grille propre : grille « toutes zones » (1000 + 50 × 10 = 1 500)', r.json.quote.card === 'Toutes zones 0-200 kg' && r.json.quote.total === 1500, r.json.quote);
  r = await mgr('POST', `${TM}/rates/quote`, { carrierId: car, zoneId: Z2, weight: 200 });
  check('tranche : 200 kg passe dans la grille « 200 kg et plus » (bornes [min, max[)', r.json.quote.card === 'Lourd 200 kg et plus' && r.json.quote.total === 20000, r.json.quote);
  r = await mgr('POST', `${TM}/rates/quote`, { carrierId: car2, zoneId: Z2, weight: 10 });
  check('transporteur sans grille : introuvable', r.status === 404, r.json);
  r = await mgr('POST', `${TM}/rates/quote`, { carrierId: car, zoneId: Z2, weight: 120, pallets: 1, km: 20 });
  check('devis avec distance donnée (20 km) : 2000 + 6000 + 2000 + 1500 = 11 500 ; +10 % = 12 650', r.json.quote.total === 12650, r.json.quote);

  // ---------- Factures de transporteur : rapprochement ----------
  const dc1 = await mk({ customerName: 'Client Transporté 1', zoneId: Z2, weight: 120, pallets: 1, carrierId: car });
  const dc2 = await mk({ customerName: 'Client Transporté 2', zoneId: Z2, weight: 10, carrierId: car });
  const dc3 = await mk({ customerName: 'Pas encore livré', zoneId: Z2, weight: 10, carrierId: car });
  const dc4 = await mk({ customerName: 'Autre transporteur', zoneId: Z2, weight: 10, carrierId: car2 });
  for (const d of [dc1, dc2, dc4]) await mgr('PUT', `${L}/deliveries/${d}/status`, { status: 'delivered', receivedBy: 'Réception' });
  r = await mgr('GET', `${TM}/deliveries/${dc1}/cost`);
  check('coût estimé de la livraison (grille de son transporteur) : 11 770', r.json.quote.total === 11770, r.json);
  r = await mgr('GET', `${TM}/carriers/${car}/unbilled`);
  check('livraisons du transporteur à facturer (livrées seulement)', r.json.deliveries.map((d) => d.id).sort().join() === [dc1, dc2].sort().join() && r.json.deliveries.find((d) => d.id === dc2).expected === 5500, r.json);
  r = await mgr('POST', `${TM}/carrier-invoices`, { carrierId: car, ref: 'TE-2026-118', vat: 3378, lines: [{ deliveryId: dc1, amount: 11770 }, { deliveryId: dc2, amount: 7000 }, { deliveryId: dc3, amount: 5500 }, { deliveryId: dc4, amount: 5500 }, { label: 'Frais de dossier', amount: 1000 }] });
  const inv = r.json.invoice;
  const fl = (id) => inv.lines.find((l) => l.deliveryId === id);
  check('facture saisie (FT-…), HT = 30 770', r.status === 201 && /^FT-\d{4}-\d{4}$/.test(inv.number) && inv.amountHt === 30770 && inv.total === 34148, inv);
  check('rapprochement : conforme (11 770 attendu)', fl(dc1).flag === 'ok' && fl(dc1).expected === 11770, fl(dc1));
  check('rapprochement : 7 000 pour 5 500 attendus → au-delà de la tolérance (500)', fl(dc2).flag === 'over' && fl(dc2).gap === 1500, fl(dc2));
  check('rapprochement : non livrée, autre transporteur, ligne libre signalées', fl(dc3).flag === 'not_delivered' && fl(dc4).flag === 'other_carrier' && inv.lines.find((l) => !l.deliveryId).flag === 'no_delivery' && inv.issues === 4, inv.lines.map((l) => l.flag));
  r = await mgr('POST', `${TM}/carrier-invoices`, { carrierId: car, ref: 'TE-2026-118', lines: [{ deliveryId: dc1, amount: 1 }] });
  check('facture en double (même numéro) refusée', r.status === 409, r.json);
  r = await mgr('POST', `${TM}/carrier-invoices`, { carrierId: car, ref: 'TE-2026-119', lines: [{ deliveryId: dc1, amount: 11770 }] });
  check('livraison déjà facturée ailleurs : doublon signalé', r.json.invoice.lines[0].flag === 'duplicate', r.json.invoice.lines);
  const invDup = r.json.invoice.id;
  r = await mgr('POST', `${TM}/carrier-invoices/${invDup}/cancel`, {});
  check('facture en double annulée', r.status === 200, r.json);
  r = await mgr('POST', `${TM}/carrier-invoices/${inv.id}/approve`, {});
  check('validation refusée tant qu\'il y a des écarts', r.status === 409 && /4 ligne/.test(r.json.error), r.json);
  r = await mgr('POST', `${TM}/carrier-invoices/${inv.id}/approve`, { force: true });
  check('validation forcée : explication obligatoire', r.status === 400, r.json);
  r = await mem('POST', `${TM}/carrier-invoices/${inv.id}/approve`, { force: true, note: 'x' });
  check('validation : réservée aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${TM}/carrier-invoices/${inv.id}/approve`, { force: true, note: 'Accord téléphonique pour le supplément' });
  check('facture validée : écriture comptable', r.status === 200 && r.json.entry && r.json.entry.number, r.json);
  let el = await dbx.prepare('SELECT account, debit, credit FROM acc_lines WHERE entry_id = ? ORDER BY id').all(r.json.entry.id);
  const lineOf = (a) => el.find((l) => l.account === a) || {};
  check('écriture : 612 au débit 30 770, 4454 au débit 3 378, 401 au crédit 34 148', Number(lineOf('612').debit) === 30770 && Number(lineOf('4454').debit) === 3378 && Number(lineOf('401').credit) === 34148, el);
  r = await mgr('GET', `${TM}/deliveries/${dc2}/cost`);
  check('coût réel affecté à la livraison (7 000)', r.json.allocated === 7000, r.json);
  r = await other('GET', `${ws(org2)}/logistics/tms/carrier-invoices/${inv.id}`);
  check('cloisonnement : facture introuvable depuis une autre organisation', r.status === 404, r.status);
  r = await other('POST', `${ws(org2)}/logistics/carriers`, { name: 'Leur transporteur' });
  r = await other('POST', `${ws(org2)}/logistics/tms/carrier-invoices`, { carrierId: r.json.id, ref: 'Z1', lines: [{ deliveryId: dc1, amount: 100 }] });
  check('cloisonnement : nos livraisons ne se facturent pas ailleurs', r.status === 404, r.json);

  // ---------- Frais réels de la tournée et répartition ----------
  r = await mem('POST', `${TM}/trips/${trip}/costs`, { kind: 'fuel', amount: 10000, label: 'Plein' });
  check('le chauffeur saisit ses frais de route', r.status === 201, r.json);
  await mgr('POST', `${TM}/trips/${trip}/costs`, { kind: 'toll', amount: 2000 });
  await mgr('POST', `${TM}/trips/${trip}/costs`, { kind: 'allowance', amount: 3000 });
  r = await mem('POST', `${TM}/trips/${trip2}/costs`, { kind: 'fuel', amount: 1 });
  check('frais d\'une tournée dont il n\'est pas le chauffeur : refusé', r.status === 403, r.status);
  r = await mem('POST', `${TM}/trips/${trip}/costs/approve`, {});
  check('validation des frais : réservée aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${TM}/trips/${trip}/costs/approve`, { account: '571' });
  // Arrêts restés sur la tournée : Ali (50 kg), Fanta (20 kg), Wms (250 kg) ; 15 000 au prorata : 2 343,75 / 937,5 / 11 718,75 → 2 344 / 937 / 11 719 (plus fort reste).
  const al = r.json.allocation ? Object.fromEntries(r.json.allocation.map((a) => [a.deliveryId, a.amount])) : {};
  check('répartition au poids (plus fort reste) : 2 344 + 937 + 11 719 = 15 000', r.status === 200 && r.json.total === 15000 && al[stockA] === 2344 && al[stockB] === 937 && al[wmsDel] === 11719, r.json);
  el = await dbx.prepare('SELECT account, debit, credit FROM acc_lines WHERE entry_id = ? ORDER BY id').all(r.json.entry.id);
  check('écriture : 6042 carburant 10 000, 618 péage 2 000, 663 indemnité 3 000, 571 caisse au crédit 15 000', Number(lineOf('6042').debit) === 10000 && Number(lineOf('618').debit) === 2000 && Number(lineOf('663').debit) === 3000 && Number(lineOf('571').credit) === 15000, el);
  r = await mgr('POST', `${TM}/trips/${trip}/costs/approve`, {});
  check('frais validés une seule fois', r.status === 400, r.json);
  r = await mgr('POST', `${TM}/trips/${trip}/costs`, { kind: 'toll', amount: 500 });
  check('plus de frais après validation', r.status === 400, r.json);

  // ---------- Indicateurs ----------
  r = await mgr('GET', `${TM}/kpi?from=${day(-1)}&to=${day(1)}`);
  const k = r.json;
  const rows = await dbx.prepare("SELECT * FROM logistics_deliveries WHERE org_id = ? AND COALESCE(planned_date, SUBSTR(created_at, 1, 10)) BETWEEN ? AND ?").all(org, day(-1), day(1));
  const delivered = rows.filter((d) => d.status === 'delivered');
  const fin = rows.filter((d) => ['delivered', 'failed', 'returned'].includes(d.status) && Number(d.attempts) > 0);
  const first = delivered.filter((d) => Number(d.attempts) === 1).length;
  check('indicateurs : heures saisies après coup comptées à part', k.summary.declaredTimes === 1 && 'onTimeLivePct' in k.summary, k.summary);
  check('indicateurs : livrées et réussite au premier passage (recalcul)', k.summary.delivered === delivered.length && k.summary.firstAttemptPct === Math.round((1000 * first) / fin.length) / 10, [k.summary, delivered.length, first, fin.length]);
  check('indicateurs : à l\'heure 100 % (toutes livrées le jour prévu, sans créneau dépassé)', k.summary.onTimePct === 100, k.summary);
  check('indicateurs : échecs par motif (absent, refus)', k.failures.some((f) => f.reason === 'absent' && f.count === 1) && k.failures.some((f) => f.reason === 'refused' && f.count === 1), k.failures);
  const kmTrips = 42 + Number((await dbx.prepare('SELECT planned_km FROM logistics_rounds WHERE id = ?').get(trip2)).planned_km);
  check('indicateurs : 2 tournées, km (compteur, sinon prévus), km par tournée', k.summary.trips === 2 && Math.abs(k.summary.km - kmTrips) < 0.11 && Math.abs(k.summary.kmPerTrip - kmTrips / 2) < 0.11, [k.summary, kmTrips]);
  check('indicateurs : coûts = frais 15 000 + factures validées 30 770 ; coût par livraison', k.summary.tripCosts === 15000 && k.summary.carrierCosts === 30770 && k.summary.totalCost === 45770 && k.summary.costPerDelivery === Math.round(45770 / delivered.length), k.summary);
  check('indicateurs : coût au km = 15 000 ÷ km de la flotte', k.summary.costPerKm === Math.round(15000 / kmTrips), k.summary.costPerKm);
  const v1 = k.vehicles.find((v) => v.id === V1);
  check('indicateurs : utilisation de LT-500 (1 jour) et chargement 64 % (320 kg restés sur la tournée)', v1.trips === 1 && v1.daysUsed === 1 && v1.avgLoad === 64 && v1.utilisation === Math.round(1000 / k.workDays) / 10, v1);
  check('indicateurs : CO2 = 42 km × 200 g + km de LT-100 × 250 g', Math.abs(k.summary.co2Kg - Math.round((42 * 200 + (kmTrips - 42) * 250) / 100) / 10) < 0.11, k.summary.co2Kg);
  check('indicateurs : série par jour pour les graphiques', k.days.length === 3 && k.days[1].date === T0, k.days.map((x) => x.date));
  r = await mem('GET', `${TM}/kpi?from=${day(-1)}&to=${day(1)}`);
  check('indicateurs : le membre voit les taux, pas les coûts', r.status === 200 && r.json.summary.totalCost === undefined && r.json.summary.onTimePct === 100, r.json.summary);
  r = await mgr('GET', `${TM}/kpi/export?kind=deliveries&from=${day(-1)}&to=${day(1)}`);
  check('export CSV des livraisons (UTF-8 avec BOM, « ; »)', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.charCodeAt(0) === 0xfeff && r.text.includes('Client;Zone') && r.text.includes('Boutique Ali'), r.text.slice(0, 200));
  r = await mem('GET', `${TM}/kpi/export?kind=deliveries&from=${day(-1)}&to=${day(1)}`);
  check('export du membre : sans colonnes de coûts', !r.text.includes('Coût estimé'), r.text.slice(0, 300));
  r = await mgr('GET', `${TM}/kpi/export?kind=trips&from=${day(-1)}&to=${day(1)}`);
  check('export CSV des tournées', r.status === 200 && r.text.includes('Matin Akwa'), r.text.slice(0, 200));
  r = await mgr('GET', `${TM}/kpi?from=${day(2)}&to=${day(1)}`);
  check('période à l\'envers refusée', r.status === 400, r.json);
  r = await other('GET', `${ws(org2)}/logistics/tms/kpi`);
  check('cloisonnement : indicateurs de l\'autre organisation vides', r.status === 200 && r.json.summary.deliveries === 0 && r.json.summary.trips === 0, r.json.summary);

  // ---------- Replanifier, annuler une tournée, anciennes routes ----------
  r = await mgr('POST', `${TM}/plan/commit`, { date: day(1), trips: [{ vehicleId: V1, driverId: D4, deliveryIds: [absent] }] });
  check('nouvelle tentative planifiée le lendemain', r.status === 201, r.json);
  const trip3 = r.json.trips[0].id;
  r = await mgr('POST', `${TM}/trips/${trip3}/cancel`, {});
  check('tournée annulée : la livraison redevient à planifier', r.status === 200 && (await mgr('GET', `${L}/deliveries/${absent}`)).json.delivery.roundId === null, r.json);
  r = await mgr('POST', `${TM}/plan/commit`, { date: day(1), trips: [{ vehicleId: V1, driverId: D4, deliveryIds: [absent] }] });
  check('une tournée annulée ne bloque pas le véhicule', r.status === 201, r.json);
  r = await mgr('POST', `${TM}/deliveries/${c600}/reschedule`, { date: day(3) });
  check('replanifier une livraison', r.status === 200 && (await mgr('GET', `${L}/deliveries/${c600}`)).json.delivery.plannedDate === day(3), r.json);
  r = await mgr('POST', `${L}/rounds`, { name: 'Ancienne méthode', date: day(2) });
  check('ancienne création de tournée toujours servie', r.status === 201, r.json);
  r = await mgr('PUT', `${L}/rounds/${r.json.id}/order`, { deliveryIds: [c150, c300] });
  check('ancien ordre de passage toujours servi', r.status === 200, r.json);
  r = await mem('GET', L);
  check('tableau de bord Logistique : champs transport présents', r.status === 200 && r.json.deliveries.find((d) => d.id === stockA).codCollected === 15000 && r.json.deliveries.find((d) => d.id === stockA).outcome === 'partial' && r.json.deliveries.find((d) => d.id === stockA).estCost === undefined, r.json.deliveries.find((d) => d.id === stockA));

  // ---------- Livraison partielle d'articles suivis par lot et par numéro de série ----------
  const lait = (await mgr('POST', `${S}/items`, { name: 'Lait', unit: 'carton', tracking: 'lot', quantity: 10 })).json.id;
  const moto = (await mgr('POST', `${S}/items`, { name: 'Moto', unit: 'moto', tracking: 'serial', quantity: 2, serials: 'VIN-A, VIN-B' })).json.id;
  const lotDel = await mk({ customerName: 'Laiterie', plannedDate: day(2), zoneId: Z1, weight: 30, items: [{ itemId: lait, quantity: 4 }, { itemId: moto, serials: 'VIN-A, VIN-B' }] });
  r = await mgr('POST', `${TM}/plan/commit`, { date: day(2), trips: [{ vehicleId: V2, driverId: D1, deliveryIds: [lotDel] }] });
  const trip5 = r.json.trips[0].id;
  r = await mem('POST', `${TM}/trips/${trip5}/start`, {});
  check('départ : lait 10 - 4, motos 2 - 2', r.status === 200 && await qty(lait) === 6 && await qty(moto) === 0, r.json);
  r = await mem('GET', `${TM}/trips/${trip5}`);
  const it5 = r.json.trip.stops[0].items;
  r = await mem('POST', `${TM}/stops/${lotDel}/complete`, { outcome: 'partial', recipient: 'Gérant', lines: [{ id: it5.find((x) => x.name === 'Lait').id, delivered: 3 }, { id: it5.find((x) => x.name === 'Moto').id, delivered: 1.5 }] });
  check('partielle : quantité entière exigée pour un article suivi par série', r.status === 400, r.json);
  r = await mem('POST', `${TM}/stops/${lotDel}/complete`, { outcome: 'partial', recipient: 'Gérant', lines: [{ id: it5.find((x) => x.name === 'Lait').id, delivered: 3 }, { id: it5.find((x) => x.name === 'Moto').id, delivered: 1 }] });
  check('partielle lot + série : 1 carton et 1 moto remis en stock', r.status === 200 && await qty(lait) === 7 && await qty(moto) === 1, [r.json, await qty(lait), await qty(moto)]);
  const lots = await dbx.prepare('SELECT SUM(quantity) AS q FROM stock_lots WHERE item_id = ?').get(lait);
  const sers = await dbx.prepare("SELECT serial, status FROM stock_serials WHERE item_id = ? ORDER BY serial").all(moto);
  check('lot recrédité (7) ; la moto non livrée (dernier numéro, VIN-B) revient en stock', Number(lots.q) === 7 && sers.find((x) => x.serial === 'VIN-B').status === 'in_stock' && sers.find((x) => x.serial === 'VIN-A').status === 'out', [lots, sers]);
  await mem('POST', `${TM}/trips/${trip5}/finish`, {});
  r = await mgr('PUT', `${L}/deliveries/${lotDel}/status`, { status: 'returned', note: 'Retour complet' });
  const sers2 = await dbx.prepare("SELECT serial, status FROM stock_serials WHERE item_id = ? ORDER BY serial").all(moto);
  check('retour ensuite : lait 10, motos 2 (VIN-A revient, VIN-B pas deux fois)', r.status === 200 && await qty(lait) === 10 && await qty(moto) === 2 && sers2.every((x) => x.status === 'in_stock'), [r.json, await qty(lait), sers2]);
  await ok('à la fin');
});
