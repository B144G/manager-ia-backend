'use strict';
// Transport · géolocalisation : carte des transporteurs et du client, statut vert / rouge (absent, en mission, hors service, chargement plein,
// statut manuel), ancienneté des positions, recommandation de DEUX transporteurs (valeurs recalculées à la main), affectation (création de la
// tournée existante), consentement, heures de service, conservation, journal d'audit, lien de localisation du client, isolation par entreprise.
// Lancez-le avec : node scripts/test-tms-geo.js
const { run } = require('./lib/wave1');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
// Recalcul indépendant des formules de docs/transport-geo.md
const hav = (a, b) => { const rad = (d) => (d * Math.PI) / 180; const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };
const km = (a, b) => Math.round(hav(a, b) * 1.3 * 10) / 10;
const mins = (k) => Math.max(1, Math.round((k / 30) * 60));

run('Transport · géolocalisation : carte, statuts, recommandations, consentement, audit', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx, base }) => {
  const L = `${O}/logistics`; const TM = `${L}/tms`; const G = `${TM}/geo`;
  const T0 = day(0);
  let r;
  const DEP = { lat: 4, lng: 9.7 }; const CL = { lat: 4, lng: 9.72 };
  await mgr('PUT', `${TM}/settings`, { depotLabel: 'Dépôt Bassa', depotLat: DEP.lat, depotLng: DEP.lng, speedKmh: 30, roadFactor: 1.3, tzOffset: 0 });
  const members = (await owner('GET', `${O}/members`)).json.members;
  const memId = members.find((m) => m.name === 'Paul').userId;
  const veh = async (b) => (await mgr('POST', `${L}/vehicles`, b)).json.id;
  const V1 = await veh({ plate: 'GEO-500', kind: 'truck', capacityKg: 500, kmRate: 150 });
  const V2 = await veh({ plate: 'GEO-100', kind: 'van', capacityKg: 100, kmRate: 80 });
  const V3 = await veh({ plate: 'GEO-300', kind: 'van', capacityKg: 300, kmRate: 100 });
  const V6 = await veh({ plate: 'GEO-020', kind: 'van', capacityKg: 20, kmRate: 50 });
  const V7 = await veh({ plate: 'GEO-700', kind: 'van', capacityKg: 700, kmRate: 120 });
  const drv = async (b) => (await mgr('POST', `${L}/drivers`, b)).json.id;
  const D1 = await drv({ name: 'Paul Chauffeur', userId: memId, dailyAllowance: 2000 });
  const D2 = await drv({ name: 'Ali' }); const D3 = await drv({ name: 'Bob Permis Périmé' }); const D4 = await drv({ name: 'Karl Absent' });
  const D5 = await drv({ name: 'Eve Sans Position' }); const D6 = await drv({ name: 'Max Petit Véhicule' }); const D7 = await drv({ name: 'Zed En Mission' });
  await mgr('POST', `${L}/compliance`, { subject: 'driver', driverId: D3, kind: 'license', expiresAt: day(-3) });
  const setup = async (id, vehicleId) => mgr('PUT', `${G}/drivers/${id}`, { vehicleId });
  for (const [d, v] of [[D1, V1], [D2, V2], [D3, V3], [D4, V3], [D5, V1], [D6, V6], [D7, V7]]) await setup(d, v);
  const pos = async (id, p) => mgr('POST', `${G}/drivers/${id}/position`, p);
  r = await pos(D1, { lat: 4, lng: 9.71 }); check('position saisie à la main par un responsable', r.status === 200, r.json);
  r = await mem('POST', `${G}/drivers/${D2}/position`, { lat: 4, lng: 9.74 });
  check('un simple membre ne saisit pas la position d\'un autre', r.status === 403, r.status);
  r = await pos(D2, { lat: 91, lng: 9 }); check('latitude invalide refusée', r.status === 400, r.json);
  await pos(D2, { lat: 4, lng: 9.74 }); await pos(D3, { lat: 4, lng: 9.7205 }); await pos(D4, { lat: 4, lng: 9.7201 }); await pos(D6, { lat: 4, lng: 9.7202 }); await pos(D7, { lat: 4, lng: 9.7203 });
  r = await mgr('PUT', `${G}/drivers/${D4}`, { manualState: 'absent', manualReason: 'Congé' });
  check('statut manuel « absent »', r.status === 200, r.json);
  r = await mgr('PUT', `${G}/drivers/${D4}`, { manualState: 'nimporte' }); check('statut manuel inconnu refusé', r.status === 400, r.json);
  // D7 : tournée en cours aujourd'hui
  const rd = await mgr('POST', `${L}/rounds`, { name: 'Mission en cours', date: T0, vehicleId: V7, driverId: D7 });
  await dbx.prepare("UPDATE logistics_rounds SET status = 'in_progress' WHERE id = ?").run(rd.json.id);

  // ---------- Livraison du client et sa position ----------
  const mkDel = async (b) => { const x = await mem('POST', `${L}/deliveries`, { plannedDate: T0, customerName: 'Mme Client', address: 'Bonanjo, Douala', phone: '+237 690 00 00 01', weight: 30, ...b }); return x.json.id; };
  const del = await mkDel({});
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  check('sans position du client : carte sans client, aucune recommandation', r.status === 200 && r.json.client === null && r.json.recommendations.length === 0, r.json.client);
  r = await mem('PUT', `${G}/deliveries/${del}/location`, { lat: CL.lat, lng: CL.lng, source: 'pin', address: 'Bonanjo, Douala' });
  check('position du client posée sur la carte', r.status === 200 && r.json.client.source === 'pin', r.json);
  r = await mem('PUT', `${G}/deliveries/${del}/location`, { lat: 200, lng: 1, source: 'pin' }); check('position du client invalide refusée', r.status === 400, r.json);
  r = await mem('PUT', `${G}/deliveries/${del}/location`, { lat: 1, lng: 1, source: 'gps' }); check('« gps » ne se saisit pas au bureau (il vient du téléphone du client)', r.status === 400, r.json);

  // ---------- Carte : statuts, distances ----------
  r = await mem('GET', `${G}/map?deliveryId=${del}`); check('la carte est réservée aux responsables', r.status === 403, r.status);
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  const M = r.json; const dv = (id) => M.drivers.find((x) => x.id === id);
  check('carte : tous les transporteurs de l\'entreprise (7)', r.status === 200 && M.drivers.length === 7, M.drivers.length);
  check('carte : le client est localisé', M.client && M.client.lat === CL.lat && M.client.lng === CL.lng, M.client);
  const kmOf = (p) => km(p, CL);
  check(`Paul : vert, ${kmOf({ lat: 4, lng: 9.71 })} km, ${mins(kmOf({ lat: 4, lng: 9.71 }))} min`, dv(D1).available === true && dv(D1).distanceKm === kmOf({ lat: 4, lng: 9.71 }) && dv(D1).etaMin === mins(kmOf({ lat: 4, lng: 9.71 })), dv(D1));
  check('Ali : vert', dv(D2).available === true && dv(D2).distanceKm === kmOf({ lat: 4, lng: 9.74 }), dv(D2));
  check('Bob (permis périmé) : rouge, hors service', dv(D3).available === false && dv(D3).reason === 'out_of_service' && dv(D3).blocked === 'license', dv(D3));
  check('Karl (statut manuel absent) : rouge, absent', dv(D4).available === false && dv(D4).reason === 'absent' && dv(D4).manual === true && dv(D4).manualReason === 'Congé', dv(D4));
  check('Eve (aucune position) : listée sans point', dv(D5).position === null && dv(D5).distanceKm === null && dv(D5).available === true, dv(D5));
  check('Max (véhicule de 20 kg) : vert mais la charge de 30 kg ne tient pas', dv(D6).available === true && dv(D6).fits === false, dv(D6));
  check('Zed (tournée en cours) : rouge, en mission', dv(D7).available === false && dv(D7).reason === 'on_mission', dv(D7));
  check('le statut manuel « disponible » ne contourne pas un blocage réel (permis périmé)', (await mgr('PUT', `${G}/drivers/${D3}`, { manualState: 'available' })).status === 200 && (await mgr('GET', `${G}/map?deliveryId=${del}`)).json.drivers.find((x) => x.id === D3).available === false);
  await mgr('PUT', `${G}/drivers/${D3}`, { manualState: '' });
  // Chargement plein : Ali (100 kg) avec 100 kg déjà affectés aujourd'hui
  const heavy = await mkDel({ customerName: 'Gros colis', weight: 100, lat: 4.001, lng: 9.7 });
  const rd2 = await mgr('POST', `${L}/rounds`, { name: 'Ali plein', date: T0, vehicleId: V2, driverId: D2 });
  await dbx.prepare('UPDATE logistics_deliveries SET round_id = ? WHERE id = ?').run(rd2.json.id, heavy);
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  check('Ali : rouge, chargement plein (100 kg sur 100 kg)', r.json.drivers.find((x) => x.id === D2).available === false && r.json.drivers.find((x) => x.id === D2).reason === 'full', r.json.drivers.find((x) => x.id === D2));
  await dbx.prepare('UPDATE logistics_deliveries SET round_id = NULL WHERE id = ?').run(heavy);
  await dbx.prepare('DELETE FROM logistics_rounds WHERE id = ?').run(rd2.json.id);
  await mgr('PUT', `${G}/drivers/${D2}`, { manualState: 'full', manualReason: 'Camion chargé' });
  check('statut manuel « chargement plein » : rouge', (await mgr('GET', `${G}/map?deliveryId=${del}`)).json.drivers.find((x) => x.id === D2).reason === 'full');
  await mgr('PUT', `${G}/drivers/${D2}`, { manualState: '' });

  // Véhicule déjà pris par la tournée d'un autre chauffeur : libre mais pas recommandé
  const rdx = await mgr('POST', `${L}/rounds`, { name: 'Prend le camion de Max', date: T0, vehicleId: V6, driverId: D5 });
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  check('véhicule pris par un autre chauffeur ce jour-là : signalé', r.json.drivers.find((x) => x.id === D6).vehicleTaken === true && r.json.drivers.find((x) => x.id === D1).vehicleTaken === false, r.json.drivers.find((x) => x.id === D6));
  await dbx.prepare('DELETE FROM logistics_rounds WHERE id = ?').run(rdx.json.id);

  // ---------- Recommandations : deux transporteurs, justificatif chiffré ----------
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  const rec = r.json.recommendations;
  check('deux recommandations (Paul et Ali ; ni Max, ni les rouges, ni Eve)', rec.length === 2 && rec.map((x) => x.driverId).sort().join() === [D1, D2].sort().join(), rec.map((x) => x.driverId));
  const c = (p, cost, alw, rel = 0.75) => ({ k: kmOf(p), t: mins(kmOf(p)), cost: Math.round((kmOf(p) + km(CL, DEP)) * cost) + alw, rel });
  const a = c({ lat: 4, lng: 9.71 }, 150, 2000); const b = c({ lat: 4, lng: 9.74 }, 80, 0);
  const sc = (x, set) => { const mk = Math.min(...set.map((y) => y.k)); const mt = Math.min(...set.map((y) => y.t)); const mc = Math.min(...set.map((y) => y.cost)); const ratio = (best, v) => (v <= 0 ? 1 : Math.min(1, best / v)); return Math.round((0.30 * ratio(mk, x.k) + 0.15 * ratio(mt, x.t) + 0.20 * ratio(mc, x.cost) + 0.20 * x.rel + 0.15 * (0.7 + 0.3 * (1 - (30 / x.cap)))) * 1000) / 10; };
  a.cap = 500; b.cap = 100;
  const sA = sc(a, [a, b]); const sB = sc(b, [a, b]);
  const top = sA >= sB ? 'A' : 'B';
  check(`score de Paul = ${sA}, d'Ali = ${sB} (distance 30 %, délai 15 %, coût 20 %, fiabilité 20 %, charge 15 %)`, rec.find((x) => x.driverId === D1).score === sA && rec.find((x) => x.driverId === D2).score === sB, rec.map((x) => [x.driverId, x.score]));
  check('la première recommandation a le meilleur score', rec[0].rank === 1 && rec[1].rank === 2 && rec[0].score >= rec[1].score && rec[0].driverId === (top === 'A' ? D1 : D2), rec.map((x) => [x.rank, x.driverId]));
  const jp = rec.find((x) => x.driverId === D1).justification;
  check('justificatif de Paul : distance, délai, disponibilité, coût estimé, fiabilité, capacité', jp.distanceKm === a.k && jp.etaMin === a.t && jp.available === true && jp.estCost === a.cost && jp.reliabilityPct === 75 && jp.reliabilityLow === true && jp.capacity.fits === true && jp.capacity.capacityKg === 500 && jp.vehicle === 'GEO-500', jp);
  check(`coût estimé d'Ali = (aller ${kmOf({ lat: 4, lng: 9.74 })} + retour au dépôt ${km(CL, DEP)}) km × 80 = ${b.cost}`, rec.find((x) => x.driverId === D2).justification.estCost === b.cost, rec.find((x) => x.driverId === D2).justification);
  // Fiabilité historique : Ali a 4 livraisons réussies et 1 échec récents → 80 %
  const hist = await mgr('POST', `${L}/rounds`, { name: 'Historique Ali', date: day(-2), vehicleId: V2, driverId: D2 });
  for (let i = 0; i < 5; i++) { const id = await mkDel({ customerName: `Hist ${i}`, weight: 1 }); await dbx.prepare('UPDATE logistics_deliveries SET round_id = ?, status = ? WHERE id = ?').run(hist.json.id, i < 4 ? 'delivered' : 'failed', id); }
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  const ja = r.json.recommendations.find((x) => x.driverId === D2).justification;
  check('fiabilité d\'Ali : 4 réussies sur 5 = 80 % (échantillon 5)', ja.reliabilityPct === 80 && ja.reliabilitySample === 5 && ja.reliabilityLow === false, ja);

  // ---------- Ancienneté des positions ----------
  await dbx.prepare('UPDATE tg_driver SET last_at = ? WHERE driver_id = ?').run(iso(60), D1);
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  check('position de 60 min : signalée « ancienne » (seuil 30 min) avec son âge', r.json.drivers.find((x) => x.id === D1).position.state === 'stale' && r.json.drivers.find((x) => x.id === D1).position.ageMin >= 60, r.json.drivers.find((x) => x.id === D1).position);
  const sStale = r.json.recommendations.find((x) => x.driverId === D1);
  check('pénalité de 15 points pour une position ancienne', sStale && sStale.score === Math.round((sA - 15) * 10) / 10, sStale && sStale.score);
  await dbx.prepare('UPDATE tg_driver SET last_at = ? WHERE driver_id = ?').run(iso(300), D1);
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  check('position de 5 h : masquée (perdue) et plus recommandée', r.json.drivers.find((x) => x.id === D1).position === null && r.json.drivers.find((x) => x.id === D1).positionHidden === 'lost' && !r.json.recommendations.some((x) => x.driverId === D1));
  await pos(D1, { lat: 4, lng: 9.71 });

  // ---------- Réglages ----------
  r = await mgr('PUT', `${G}/settings`, { staleMin: 10 }); check('réglages : réservés aux administrateurs', r.status === 403, r.status);
  r = await owner('PUT', `${G}/settings`, { staleMin: 100, lostMin: 50 }); check('réglages : « perdue » doit dépasser « ancienne »', r.status === 400, r.json);
  r = await owner('PUT', `${G}/settings`, { staleMin: 45, lostMin: 300, retentionDays: 7 });
  check('réglages enregistrés', r.status === 200 && r.json.settings.staleMin === 45 && r.json.settings.retentionDays === 7, r.json);

  // ---------- Téléphone du transporteur : consentement, heures de service ----------
  r = await mgr('GET', `${G}/me`); check('un compte non relié à un chauffeur n\'a pas de page « ma position »', r.status === 404, r.status);
  r = await mem('POST', `${G}/me/shift`, { on: true }); check('service refusé sans consentement', r.status === 403, r.json);
  r = await mem('POST', `${G}/me/position`, { lat: 4, lng: 9.7 }); check('position refusée sans consentement', r.status === 403, r.json);
  r = await mem('POST', `${G}/me/consent`, { granted: true });
  check('consentement explicite enregistré', r.status === 200 && r.json.driver.consent === true && r.json.notice.retentionDays === 7, r.json);
  r = await mem('POST', `${G}/me/position`, { lat: 4, lng: 9.7 }); check('position refusée hors service (ni service ni mission)', r.status === 403, r.json);
  await mem('POST', `${G}/me/shift`, { on: true });
  r = await mem('POST', `${G}/me/position`, { lat: 4, lng: 9.7105, accuracy: 12 });
  check('position envoyée pendant le service', r.status === 200, r.json);
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  const p1 = r.json.drivers.find((x) => x.id === D1);
  check('la carte affiche la position du téléphone, avec précision et âge', p1.position.source === 'phone' && p1.position.lat === 4 && p1.position.lng === 9.7105 && p1.position.accuracy === 12 && p1.position.ageMin <= 1 && p1.shiftOn === true, p1.position);
  r = await mem('POST', `${G}/me/position`, { lat: 'abc', lng: 9 }); check('coordonnées invalides refusées', r.status === 400, r.json);
  await mem('POST', `${G}/me/shift`, { on: false });
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  check('hors service : la position du téléphone n\'est plus affichée (suivi limité aux heures de service)', r.json.drivers.find((x) => x.id === D1).position === null && r.json.drivers.find((x) => x.id === D1).positionHidden === 'off_duty');
  await mem('POST', `${G}/me/shift`, { on: true });
  await dbx.prepare("UPDATE tg_driver SET shift_started_at = ? WHERE driver_id = ?").run(iso(13 * 60), D1);
  r = await mem('POST', `${G}/me/position`, { lat: 4, lng: 9.71 });
  check('le service s\'arrête tout seul après 12 h', r.status === 403, r.json);
  await mem('POST', `${G}/me/shift`, { on: true });
  await mem('POST', `${G}/me/position`, { lat: 4, lng: 9.7105 });
  const nPos = Number((await dbx.prepare('SELECT COUNT(*) AS n FROM tg_positions WHERE driver_id = ?').get(D1)).n);
  check('historique des positions conservé (téléphone + saisie manuelle)', nPos >= 3, nPos);
  // Conservation limitée
  await dbx.prepare("UPDATE tg_positions SET recorded_at = ? WHERE driver_id = ? AND source = 'manual'").run(iso(60 * 24 * 10), D1);
  r = await owner('POST', `${G}/purge`, {});
  check('conservation : les positions de plus de 7 jours sont supprimées', r.status === 200 && r.json.deleted >= 1 && Number((await dbx.prepare("SELECT COUNT(*) AS n FROM tg_positions WHERE driver_id = ? AND source = 'manual'").get(D1)).n) === 0, r.json);
  check('conservation : les positions récentes restent', Number((await dbx.prepare("SELECT COUNT(*) AS n FROM tg_positions WHERE driver_id = ? AND source = 'phone'").get(D1)).n) >= 1);
  // Révocation du consentement : historique effacé, service arrêté
  r = await mem('POST', `${G}/me/consent`, { granted: false });
  check('révocation du consentement : service arrêté, historique effacé', r.status === 200 && r.json.driver.consent === false && r.json.driver.shiftOn === false && Number((await dbx.prepare('SELECT COUNT(*) AS n FROM tg_positions WHERE driver_id = ?').get(D1)).n) === 0 && (await dbx.prepare('SELECT last_lat FROM tg_driver WHERE driver_id = ?').get(D1)).last_lat === null, r.json);
  r = await mem('POST', `${G}/me/position`, { lat: 4, lng: 9.7 }); check('après révocation : plus aucune position acceptée', r.status === 403, r.status);
  await mem('POST', `${G}/me/consent`, { granted: true }); await mem('POST', `${G}/me/shift`, { on: true }); await mem('POST', `${G}/me/position`, { lat: 4, lng: 9.71 });
  r = await mgr('DELETE', `${G}/drivers/${D1}/history`); check('un responsable peut effacer l\'historique d\'un transporteur', r.status === 200, r.json);
  await pos(D1, { lat: 4, lng: 9.71 });

  // ---------- Isolation entre entreprises ----------
  r = await other('GET', `${ws(org2)}/logistics/tms/geo/map?deliveryId=${del}`);
  check('une autre entreprise ne voit pas cette livraison (404)', r.status === 404 || r.status === 403, r.status);
  r = await other('GET', `${L}/tms/geo/fleet`); check('aucun accès à la flotte d\'une autre entreprise', r.status === 404 || r.status === 403, r.status);
  r = await other('POST', `${ws(org2)}/logistics/tms/geo/assign`, { deliveryId: del, driverId: D1 }); check('affectation inter-entreprises impossible', [403, 404].includes(r.status), r.status);

  // ---------- Localisation du client par lien secret ----------
  r = await mem('POST', `${G}/requests`, { deliveryId: del });
  const tok = r.json.token;
  check('lien de localisation créé (jeton secret de 48 caractères, WhatsApp prêt)', r.status === 201 && /^[a-f0-9]{48}$/.test(tok) && r.json.url.includes(`/localiser/${tok}`) && r.json.whatsapp.startsWith('https://wa.me/237690000001'), r.json);
  const pubGet = (t) => fetch(`${base}/api/ws/public/geo/${t}`).then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }));
  const pubPost = (t, b) => fetch(`${base}/api/ws/public/geo/${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }));
  r = await pubGet(tok); check('page du client : sans compte, sans donnée sensible (prénom, boutique)', r.status === 200 && r.json.org === 'Boutique Awa' && r.json.status === 'pending' && r.json.name === 'Mme' && !('phone' in r.json), r.json);
  r = await pubGet('0'.repeat(48)); check('jeton inconnu : 404', r.status === 404, r.status);
  r = await pubPost(tok, { source: 'gps', lat: 4.0003, lng: 9.7203 }); check('GPS partagé sans consentement : refusé', r.status === 400, r.json);
  r = await pubPost(tok, { source: 'gps', lat: 4.0003, lng: 9.7203, accuracy: 25, consent: true });
  check('GPS partagé avec consentement : position enregistrée', r.status === 200, r.json);
  const dd = await dbx.prepare('SELECT lat, lng, geo_source, geo_accuracy FROM logistics_deliveries WHERE id = ?').get(del);
  check('la livraison porte la position GPS du client et son origine', Number(dd.lat) === 4.0003 && Number(dd.lng) === 9.7203 && dd.geo_source === 'gps' && Number(dd.geo_accuracy) === 25, dd);
  r = await pubPost(tok, { source: 'pin', lat: 4.0005, lng: 9.7205 }); check('le client peut corriger son point sur la carte', r.status === 200 && (await dbx.prepare('SELECT geo_source FROM logistics_deliveries WHERE id = ?').get(del)).geo_source === 'pin', r.json);
  r = await pubPost(tok, { source: 'pin', lat: 100, lng: 1 }); check('position invalide refusée côté public', r.status === 400, r.json);
  await dbx.prepare('UPDATE tg_requests SET expires_at = ? WHERE token = ?').run(iso(1), tok);
  r = await pubPost(tok, { source: 'pin', lat: 4, lng: 9.7 }); check('lien expiré : 410', r.status === 410, r.json);
  r = await mem('POST', `${G}/requests`, { deliveryId: del }); const tok2 = r.json.token;
  r = await mem('GET', `${G}/requests?deliveryId=${del}`);
  check('liste des demandes : la précédente est « expirée », l\'ancienne annulée à la création de la nouvelle', r.json.requests[0].status === 'pending' && r.json.requests.find((x) => x.expiresAt < new Date().toISOString()).status !== 'pending', r.json.requests.map((x) => x.status));

  // ---------- Affectation : crée la mission existante ----------
  r = await mem('POST', `${G}/assign`, { deliveryId: del, driverId: D1 }); check('l\'affectation est réservée aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${G}/assign`, { deliveryId: del, driverId: D4 }); check('transporteur absent : affectation refusée', r.status === 409, r.json);
  r = await mgr('POST', `${G}/assign`, { deliveryId: del, driverId: D5, vehicleId: undefined });
  check('transporteur sans position mais disponible : affectation permise (choix du responsable)', r.status === 201, r.json);
  if (r.status === 201) { await dbx.prepare('UPDATE logistics_deliveries SET round_id = NULL, round_pos = 0 WHERE id = ?').run(del); await dbx.prepare('DELETE FROM logistics_rounds WHERE id = ?').run(r.json.roundId); }
  r = await mgr('GET', `${G}/map?deliveryId=${del}`);
  const second = r.json.recommendations[1];
  r = await mgr('POST', `${G}/assign`, { deliveryId: del, driverId: second.driverId, startTime: '09:00' });
  check('choix de la 2e recommandation : tournée créée', r.status === 201 && r.json.created === true && r.json.recommendationRank === 2, r.json);
  const round = await dbx.prepare('SELECT * FROM logistics_rounds WHERE id = ?').get(r.json.roundId);
  const dl = await dbx.prepare('SELECT * FROM logistics_deliveries WHERE id = ?').get(del);
  check('la tournée existante porte le chauffeur, le véhicule, l\'heure et la livraison', Number(round.driver_id) === second.driverId && Number(round.vehicle_id) > 0 && round.start_time === '09:00' && Number(dl.round_id) === Number(round.id) && round.date === T0 && Number(round.est_cost) > 0, [round, dl.round_id]);
  r = await mgr('GET', `${TM}/trips/${round.id}`); check('la mission apparaît dans le Transport (tournées)', r.status === 200 && r.json.trip.stops.length === 1, r.status);
  r = await mgr('POST', `${G}/assign`, { deliveryId: del, driverId: D1 }); check('livraison déjà en tournée : 409', r.status === 409, r.json);
  // Seconde livraison pour le même transporteur : ajoutée à sa tournée prévue (pas de doublon)
  const del2 = await mkDel({ customerName: 'Deuxième client', lat: 4.002, lng: 9.725, weight: 10 });
  r = await mgr('POST', `${G}/assign`, { deliveryId: del2, driverId: second.driverId });
  check('même transporteur, même jour : la livraison s\'ajoute à sa tournée prévue', r.status === 201 && r.json.created === false && r.json.roundId === Number(round.id), r.json);
  check('la tournée compte 2 arrêts', Number((await dbx.prepare('SELECT COUNT(*) AS n FROM logistics_deliveries WHERE round_id = ?').get(round.id)).n) === 2);
  r = await mgr('POST', `${G}/assign`, { deliveryId: await mkDel({ lat: 4, lng: 9.72 }), driverId: D7 });
  check('transporteur en mission : affectation refusée', r.status === 409, r.json);

  // ---------- Journal d'audit ----------
  r = await mgr('GET', `${G}/audit`); check('journal d\'audit : réservé aux administrateurs', r.status === 403, r.status);
  r = await owner('GET', `${G}/audit?limit=500`);
  const kinds = new Set(r.json.audit.map((x) => x.kind));
  check('journal : consentement, service, positions, carte, demande et résultat client, affectation, purge', ['consent_granted', 'consent_revoked', 'shift_on', 'shift_off', 'position_manual', 'map_view', 'request_created', 'client_located', 'assign', 'purge', 'manual_state', 'history_erased', 'settings', 'client_position_set'].every((k) => kinds.has(k)), [...kinds]);
  const asg = r.json.audit.find((x) => x.kind === 'assign');
  const snap = JSON.parse(asg.detail);
  check('journal d\'affectation : justificatif conservé (choix, rang, scores)', snap.chosen === second.driverId && snap.recommendation.rank === 2 && snap.recommended.length === 2 && snap.recommendation.justification.estCost > 0, snap);
  check('journal : jamais de coordonnées exactes des téléphones (seulement le nombre de positions affichées)', !r.json.audit.some((x) => x.kind === 'map_view' && /\d\.\d{4}/.test(x.detail)));
  r = await other('GET', `${ws(org2)}/logistics/tms/geo/audit`); check('journal : cloisonné par entreprise', r.status === 200 && r.json.audit.length === 0, r.json);
  r = await mgr('GET', `${G}/fleet`);
  check('flotte : carte sans livraison (7 transporteurs, dépôt)', r.status === 200 && r.json.drivers.length === 7 && r.json.depot.lat === 4, r.json.depot);
}, {});
