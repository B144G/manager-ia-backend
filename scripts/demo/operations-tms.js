'use strict';
// Logistique et Transport (TMS) : réseau de Douala, parc avec capacités et échéances, chauffeurs (dont Samuel, relié à son compte),
// transporteurs et grilles tarifaires, six semaines de tournées passées, la journée d'aujourd'hui jouée en direct par le chauffeur,
// une livraison en échec reprogrammée, un camion bloqué par son assurance périmée, factures de transporteurs rapprochées, indicateurs.
const L = '/logistics';
const TM = '/logistics/tms';
// Petite image PNG (1 × 1) : signature dessinée et photo de livraison.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

module.exports = async function tms(ctx) {
  const O = ctx.ids.operations;
  const D = (n) => ctx.day(n);
  const C = ctx.ids.customers;
  const I = ctx.ids.items;
  const driverUid = ctx.ids.members.driver && ctx.ids.members.driver.userId;
  const hasDriver = !!ctx.users.driver; // en ligne, le chauffeur n'a pas encore de compte : le responsable joue son rôle
  const asDriver = hasDriver ? 'driver' : 'manager';

  // ---------- Réglages ----------
  await ctx.do('Transport : lire les réglages', 'GET', `${TM}/settings`);
  if (ctx.users.seller) await ctx.do('Transport : un membre ne modifie pas les réglages (droits)', 'PUT', `${TM}/settings`, { speedKmh: 90 }, { as: 'seller', expect: 403 });
  const st = await ctx.do('Transport : réglages (dépôt GPS, vitesse, arrêts, tolérances)', 'PUT', `${TM}/settings`, { depotLabel: 'Dépôt de Bonabéri — Zone industrielle', depotLat: 4.0716, depotLng: 9.663, tzOffset: 60, speedKmh: 22, serviceMin: 20, roadFactor: 1.35, co2: 270, tolerancePct: 3, toleranceMin: 1000, etaMargin: 45 }, { as: 'manager' });
  ctx.check('Transport : dépôt de Bonabéri géolocalisé', st.settings && st.settings.depotLat === 4.0716, st);

  // ---------- Zones et réseau ----------
  const ZONES = [
    ['akwa', 'Akwa / Bonanjo', 5000, 1, 4.0485, 9.7015, 7, 3, 2],
    ['bonapriso', 'Bonapriso / Bali', 5000, 1, 4.031, 9.695, 8, 3, 1],
    ['bonaberi', 'Bonabéri / Bojongo', 2000, 0, 4.075, 9.672, 2, 4, 0],
    ['bonamoussadi', 'Bonamoussadi / Makepe', 7000, 1, 4.0939, 9.7378, 13, 4, 4],
    ['logpom', 'Logpom / Kotto / Bangue', 7000, 1, 4.079, 9.765, 15, 4, 5],
    ['pk', 'PK 14 / Japoma', 9000, 2, 4.02, 9.8, 20, 5, 6],
    ['yaounde', 'Yaoundé (Odza, Bastos, Mvan)', 45000, 2, 3.848, 11.5021, 250, 10, 9],
  ];
  const zones = {};
  const haveZ = (await ctx.do('Logistique : liste des zones', 'GET', `${L}/zones`)).zones || [];
  for (const [k, name, fee, delayDays, lat, lng, depotKm, intraKm, sortOrder] of ZONES) {
    const ex = haveZ.find((z) => z.name === name);
    zones[k] = ex ? ex.id : (await ctx.do(`Logistique : créer la zone « ${name} »`, 'POST', `${L}/zones`, { name, fee, delayDays, note: k === 'yaounde' ? 'Par Garanti Express Fret ou camion complet.' : '' }, { as: 'manager' })).id;
    await ctx.do(`Transport : géolocaliser la zone « ${name} »`, 'PUT', `${TM}/zones/${zones[k]}`, { lat, lng, depotKm, intraKm, sortOrder }, { as: 'manager' });
  }
  await ctx.do('Logistique : modifier une zone (frais, délai)', 'PUT', `${L}/zones/${zones.pk}`, { fee: 10000, delayDays: 2, note: 'Route de Yaoundé souvent embouteillée après 16 h.' }, { as: 'manager' });
  const tmpZ = (await ctx.do('Logistique : créer une zone (essai)', 'POST', `${L}/zones`, { name: 'Zone à supprimer', fee: 1000 }, { as: 'manager' })).id;
  await ctx.do('Logistique : supprimer une zone', 'DELETE', `${L}/zones/${tmpZ}`, undefined, { as: 'manager' });
  for (const [a, b, km] of [['akwa', 'bonapriso', 4.5], ['akwa', 'bonamoussadi', 9], ['bonamoussadi', 'logpom', 6.5], ['logpom', 'pk', 8], ['akwa', 'logpom', 11], ['bonaberi', 'akwa', 6]]) {
    await ctx.do(`Transport : distance ${a} ↔ ${b}`, 'PUT', `${TM}/zone-km`, { zoneA: zones[a], zoneB: zones[b], km }, { as: 'manager' });
  }
  await ctx.do('Transport : effacer une distance de la matrice', 'PUT', `${TM}/zone-km`, { zoneA: zones.bonaberi, zoneB: zones.akwa, km: null }, { as: 'manager' });
  const net = await ctx.do('Transport : réseau (zones et distances)', 'GET', `${TM}/network`);
  ctx.check('Transport : matrice de distances enregistrée (5 liaisons)', (net.distances || []).length >= 5, net.distances);

  // ---------- Transporteurs ----------
  const carriers = {};
  const haveC = (await ctx.do('Logistique : liste des transporteurs', 'GET', `${L}/carriers`)).carriers || [];
  for (const [k, body] of [
    ['wouri', { name: 'Transports Express du Wouri', contact: 'M. Ndoumbé · +237 699 55 44 33', zones: 'Douala et environs', rate: 15000, note: 'Camions plateaux 5 à 10 t, facture à la quinzaine.' }],
    ['garanti', { name: 'Garanti Express Fret', contact: 'Agence Bonabéri · +237 233 39 12 12', zones: 'Douala ↔ Yaoundé', rate: 60000, note: 'Messagerie et lots complets vers le Centre.' }],
    ['tmp', { name: 'Moto-taxi Bepanda (essai)', contact: '+237 650 00 00 00', rate: 1500 }],
  ]) { const ex = haveC.find((c) => c.name === body.name); carriers[k] = ex ? ex.id : (await ctx.do(`Logistique : créer le transporteur « ${body.name} »`, 'POST', `${L}/carriers`, body, { as: 'manager' })).id; }
  await ctx.do('Logistique : modifier un transporteur', 'PUT', `${L}/carriers/${carriers.wouri}`, { contact: 'M. Ndoumbé (exploitation) · +237 699 55 44 33', rate: 16000 }, { as: 'manager' });
  await ctx.do('Logistique : supprimer un transporteur', 'DELETE', `${L}/carriers/${carriers.tmp}`, undefined, { as: 'manager' });
  delete carriers.tmp;

  // ---------- Grilles tarifaires ----------
  const rates = {};
  for (const [k, body] of [
    ['wouriS', { name: 'Wouri — Douala jusqu\'à 2 t', carrierId: carriers.wouri, minKg: 0, maxKg: 2000, base: 8000, perKg: 6, minCharge: 12000, fuelPct: 5, validFrom: D(-120) }],
    ['wouriL', { name: 'Wouri — Douala 2 t et plus', carrierId: carriers.wouri, minKg: 2000, base: 15000, perKg: 4, fuelPct: 5, validFrom: D(-120) }],
    ['garanti', { name: 'Garanti — Douala → Yaoundé', carrierId: carriers.garanti, zoneId: zones.yaounde, base: 35000, perKg: 15, minCharge: 60000, fuelPct: 8, validFrom: D(-120) }],
    ['own', { name: 'Flotte propre — coût interne', base: 3000, perKm: 650, perPallet: 1500 }],
    ['tmp', { name: 'Grille à supprimer', base: 1000 }],
  ]) rates[k] = (await ctx.do(`Transport : grille tarifaire « ${body.name} »`, 'POST', `${TM}/rates`, body, { as: 'manager' })).id;
  await ctx.do('Transport : modifier une grille (surcharge carburant)', 'PUT', `${TM}/rates/${rates.wouriS}`, { fuelPct: 6 }, { as: 'manager' });
  await ctx.do('Transport : supprimer une grille', 'DELETE', `${TM}/rates/${rates.tmp}`, undefined, { as: 'manager' });
  await ctx.do('Transport : grilles tarifaires', 'GET', `${TM}/rates`, undefined, { as: 'manager' });
  if (ctx.users.seller) await ctx.do('Transport : les grilles sont réservées aux responsables (droits)', 'GET', `${TM}/rates`, undefined, { as: 'seller', expect: 403 });
  const q = await ctx.do('Transport : devis d\'une course (Garanti, 4,5 t vers Yaoundé)', 'POST', `${TM}/rates/quote`, { carrierId: carriers.garanti, zoneId: zones.yaounde, weight: 4500 }, { as: 'manager' });
  // 35 000 + 15 × 4 500 = 102 500 ; surcharge 8 % = 8 200 → 110 700
  ctx.check('Transport : devis Garanti = 110 700 FCFA (base + poids + 8 % carburant)', q.quote && q.quote.total === 110700, q);
  await ctx.do('Transport : devis flotte propre (12 km, 2 palettes)', 'POST', `${TM}/rates/quote`, { zoneId: zones.akwa, weight: 900, pallets: 2, km: 12 }, { as: 'manager' });

  // ---------- Parc ----------
  const veh = {}; const odo = {};
  const haveF = await ctx.do('Logistique : parc (véhicules, chauffeurs, échéances)', 'GET', `${L}/fleet`);
  const VEH = [
    ['axor', { plate: 'LT 2318 A', label: 'Mercedes Axor 1835 plateau grue', kind: 'truck', vin: 'WDB9540321L987654', capacity: '12 t / 10 palettes', odometer: 185800, capacityKg: 12000, capacityM3: 40, capacityPallets: 10, kmRate: 650, co2: 900, equipmentId: O.equipment && O.equipment.truck, branchId: ctx.ids.branches.douala }],
    ['isuzu', { plate: 'LT 7742 C', label: 'Isuzu NPR 3,5 t bâché', kind: 'truck', capacity: '3,5 t / 4 palettes', odometer: 96200, capacityKg: 3500, capacityM3: 18, capacityPallets: 4, kmRate: 320, co2: 380, branchId: ctx.ids.branches.douala }],
    ['hiace', { plate: 'CE 5521 D', label: 'Toyota Hiace fourgon', kind: 'van', capacity: '1,2 t', odometer: 145700, capacityKg: 1200, capacityM3: 8, capacityPallets: 2, kmRate: 180, co2: 230, branchId: ctx.ids.branches.douala }],
    ['kerax', { plate: 'LT 4471 B', label: 'Renault Kerax 6×4 benne (sable, gravier)', kind: 'truck', capacity: '20 t', odometer: 312400, capacityKg: 20000, capacityM3: 14, kmRate: 900, co2: 1100, branchId: ctx.ids.branches.douala }],
    ['tmp', { plate: 'CE 0000 X', label: 'Saisie en double', kind: 'car' }],
  ];
  for (const [k, body] of VEH) {
    const ex = (haveF.vehicles || []).find((v) => v.plate === body.plate);
    veh[k] = ex ? ex.id : (await ctx.do(`Parc : ajouter le véhicule ${body.plate} (${body.label})`, 'POST', `${L}/vehicles`, body, { as: 'manager' })).id;
    odo[k] = ex ? Number(ex.odometer) : body.odometer;
  }
  await ctx.do('Parc : modifier un véhicule (note, capacité)', 'PUT', `${L}/vehicles/${veh.hiace}`, { note: 'Réservé aux petites livraisons urgentes en ville.', capacityM3: 8.5 }, { as: 'manager' });
  await ctx.do('Parc : supprimer un véhicule saisi en double', 'DELETE', `${L}/vehicles/${veh.tmp}`, undefined, { as: 'manager' });
  delete veh.tmp;

  const drv = {};
  for (const [k, body] of [
    ['samuel', { name: 'Samuel Fotso', phone: '+237 677 45 12 90', licenseNo: 'CM-LT-2015-004512', licenseCategory: 'C', userId: driverUid, dailyAllowance: 5000, note: 'Chauffeur-livreur, a l\'application sur son téléphone.' }],
    ['ibrahim', { name: 'Ibrahim Bello', phone: '+237 695 30 77 14', licenseNo: 'CM-AD-2011-000873', licenseCategory: 'C+E', dailyAllowance: 6000 }],
    ['joseph', { name: 'Joseph Mbarga', phone: '+237 654 18 22 09', licenseNo: 'CM-CE-2019-007781', licenseCategory: 'B', dailyAllowance: 4000 }],
    ['tmp', { name: 'Chauffeur temporaire (essai)' }],
  ]) { const ex = (haveF.drivers || []).find((x) => x.name === body.name); drv[k] = ex ? ex.id : (await ctx.do(`Parc : ajouter le chauffeur ${body.name}`, 'POST', `${L}/drivers`, body, { as: 'manager' })).id; }
  await ctx.do('Parc : modifier un chauffeur', 'PUT', `${L}/drivers/${drv.joseph}`, { phone: '+237 654 18 22 10', note: 'Permis B : fourgon uniquement.' }, { as: 'manager' });
  await ctx.do('Parc : un compte ne peut être relié qu\'à un seul chauffeur', 'PUT', `${L}/drivers/${drv.tmp}`, { userId: driverUid }, { as: 'manager', expect: driverUid ? 409 : 200 });
  await ctx.do('Parc : supprimer un chauffeur', 'DELETE', `${L}/drivers/${drv.tmp}`, undefined, { as: 'manager' });
  delete drv.tmp;

  // Échéances réglementaires : le Kerax a une assurance PÉRIMÉE, la visite du Hiace et le permis d'Ibrahim arrivent à échéance.
  const comp = {};
  for (const [k, body] of [
    ['axorIns', { subject: 'vehicle', vehicleId: veh.axor, kind: 'insurance', reference: 'AXA Cameroun — police 2026-FL-33871', expiresAt: D(210) }],
    ['axorVt', { subject: 'vehicle', vehicleId: veh.axor, kind: 'inspection', reference: 'Visite technique n° VT-DLA-55120', expiresAt: D(95) }],
    ['axorTax', { subject: 'vehicle', vehicleId: veh.axor, kind: 'tax', reference: 'Carte grise / taxe à l\'essieu 2026', expiresAt: D(44) }],
    ['isuzuIns', { subject: 'vehicle', vehicleId: veh.isuzu, kind: 'insurance', reference: 'Activa — police FL-77412', expiresAt: D(150) }],
    ['isuzuVt', { subject: 'vehicle', vehicleId: veh.isuzu, kind: 'inspection', reference: 'VT-DLA-60231', expiresAt: D(120) }],
    ['hiaceIns', { subject: 'vehicle', vehicleId: veh.hiace, kind: 'insurance', reference: 'Chanas Assurances — 2026-0912', expiresAt: D(75) }],
    ['hiaceVt', { subject: 'vehicle', vehicleId: veh.hiace, kind: 'inspection', reference: 'VT-DLA-58017', expiresAt: D(18), note: 'Rendez-vous à prendre au centre de Bonabéri.' }],
    ['keraxIns', { subject: 'vehicle', vehicleId: veh.kerax, kind: 'insurance', reference: 'Saar Assurances — FL-12088', expiresAt: D(-12), note: 'Renouvellement en attente du devis.' }],
    ['keraxVt', { subject: 'vehicle', vehicleId: veh.kerax, kind: 'inspection', reference: 'VT-DLA-49766', expiresAt: D(60) }],
    ['samLic', { subject: 'driver', driverId: drv.samuel, kind: 'license', reference: 'Permis C n° CM-LT-2015-004512', expiresAt: D(900) }],
    ['samMed', { subject: 'driver', driverId: drv.samuel, kind: 'medical', reference: 'Visite médicale annuelle', expiresAt: D(130) }],
    ['ibrLic', { subject: 'driver', driverId: drv.ibrahim, kind: 'license', reference: 'Permis C+E n° CM-AD-2011-000873', expiresAt: D(21) }],
    ['josLic', { subject: 'driver', driverId: drv.joseph, kind: 'license', reference: 'Permis B n° CM-CE-2019-007781', expiresAt: D(1400) }],
    ['wrong', { subject: 'vehicle', vehicleId: veh.isuzu, kind: 'other', reference: 'Saisie erronée', expiresAt: D(5) }],
  ]) comp[k] = (await ctx.do(`Parc : échéance ${body.kind} (${body.reference})`, 'POST', `${L}/compliance`, body, { as: 'manager' })).id;
  await ctx.do('Parc : prolonger une échéance (taxe payée)', 'PUT', `${L}/compliance/${comp.axorTax}`, { expiresAt: D(409), reference: 'Taxe à l\'essieu 2026-2027 payée' }, { as: 'manager' });
  await ctx.do('Parc : supprimer une échéance erronée', 'DELETE', `${L}/compliance/${comp.wrong}`, undefined, { as: 'manager' });
  const cl = await ctx.do('Parc : échéances réglementaires', 'GET', `${L}/compliance`);
  ctx.check('Parc : l\'assurance du Kerax est signalée PÉRIMÉE', (cl.items || []).some((c) => c.id === comp.keraxIns && c.state === 'expired'), (cl.items || []).find((c) => c.id === comp.keraxIns));

  // ---------- Livraisons ----------
  const dl = {};
  const mk = async (key, body, as = 'seller') => { dl[key] = (await ctx.do(`Logistique : livraison pour ${body.customerName}`, 'POST', `${L}/deliveries`, body, { as })).id; return dl[key]; };
  const Z = Object.fromEntries(ZONES.map((z) => [z[0], { lat: z[4], lng: z[5] }]));
  const near = (z, i) => ({ lat: Math.round((Z[z].lat + ((i * 37) % 11 - 5) * 0.0011) * 1e5) / 1e5, lng: Math.round((Z[z].lng + ((i * 53) % 13 - 6) * 0.0012) * 1e5) / 1e5 });
  const CUST = {
    sogea: ['Sogea Satom Cameroun', '+237 699 10 20 30', 'Chantier rue Njo-Njo, Bonapriso', 'bonapriso'],
    bati: ['Bâti Plus SARL', '+237 677 21 43 65', 'Chantier immeuble, carrefour Ndokoti, Makepe', 'bonamoussadi'],
    quinc: ['Quincaillerie du Wouri', '+237 655 44 11 22', 'Marché Central, porte 4, Akwa', 'akwa'],
    mairie: ['Commune de Douala 5e', '+237 233 40 50 60', 'Services techniques, Kotto', 'logpom'],
    particulier: ['M. Jean-Paul Etoundi', '+237 671 00 99 88', 'Logpom, derrière l\'école publique', 'logpom'],
    hotel: ['Hôtel La Falaise', '+237 233 42 00 00', 'Boulevard de la Liberté, Bonanjo', 'akwa'],
    immo: ['Immobilière des Collines', '+237 222 20 30 40', 'Résidence Les Collines, Odza, Yaoundé', 'yaounde'],
    ngono: ['Entreprise Ngono & Fils', '+237 690 33 22 11', 'Dépôt PK 14, route de Yaoundé', 'pk'],
  };
  const base = (k, i, extra = {}) => { const [customerName, phone, address, z] = CUST[k]; return { customerName, phone, address, zoneId: zones[z], ...near(z, i), ...extra }; };

  // Une livraison rattachée à une commande ou une facture du site, si le groupe « commerce » en a créé.
  const docs = (await ctx.do('Logistique : commandes et factures à livrer', 'GET', `${L}/documents`)).documents || [];
  if (docs.length) await mk('doc', { docId: docs[0].id, address: 'Adresse de la commande', zoneId: zones.akwa, plannedDate: D(1), weight: 650, note: `Livraison de ${docs[0].number}` });

  // ---------- Six semaines d'historique : tournées planifiées, réparties, roulées et clôturées ----------
  // Heure réelle d'une livraison de l'historique : départ 8 h, ~50 min par arrêt ; deux arrivées après la fin du créneau (12 h) pour un taux réaliste.
  const histTime = (date, i, s) => {
    const late = (i === 2 || i === 9) && s === 0;
    const min = late ? 12 * 60 + 25 : 8 * 60 + 35 + s * 50 + (i % 4) * 5;
    return { deliveredAt: `${date}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`, note: `Bon de livraison papier BL-${date.replace(/-/g, '').slice(2)}-${s + 1}` };
  };
  const days = [];
  for (let n = -41; n <= -2; n++) { const d = new Date(Date.now() + n * 86400000); if (d.getUTCDay() !== 0) days.push(n); }
  const hist = days.filter((_, i) => i % 3 === 0); // ~12 jours de tournées
  const ROT = [['isuzu', 'samuel', asDriver], ['axor', 'ibrahim', 'manager'], ['hiace', 'joseph', 'manager']];
  const CODS = { quinc: 186000, particulier: 98500, hotel: 0 };
  const PLACES = Object.keys(CUST).filter((k) => k !== 'immo');
  let tripsDone = 0; let histFail = null; const tripIds = [];
  for (const [i, n] of hist.entries()) {
    const date = D(n);
    const [vk, dk, runner] = ROT[i % 3];
    const cap = { isuzu: 3400, axor: 11000, hiace: 1150 }[vk];
    const stops = [];
    for (let s = 0; s < (vk === 'hiace' ? 3 : 4); s++) {
      const k = PLACES[(i * 3 + s) % PLACES.length];
      const w = Math.round(Math.min(cap / (vk === 'hiace' ? 3 : 4), [2400, 380, 720, 1850, 600, 950, 2200, 500][(i + s) % 8]) / 10) * 10;
      stops.push(await mk(`h${i}_${s}`, base(k, i * 7 + s, { plannedDate: date, weight: w, pallets: w > 900 ? 2 : 0, codAmount: CODS[k] || 0, windowStart: s === 0 ? '08:00' : '', windowEnd: s === 0 ? '12:00' : '', priority: s === 0 ? 1 : 0 })));
    }
    const plan = await ctx.do(`Transport : valider la tournée du ${date}`, 'POST', `${TM}/plan/commit`, { date, trips: [{ name: `${{ isuzu: 'Isuzu', axor: 'Axor', hiace: 'Hiace' }[vk]} — ${date.split('-').reverse().join('/')}`, vehicleId: veh[vk], driverId: drv[dk], deliveryIds: stops, startTime: '07:30' }] }, { as: 'manager' });
    const t = (plan.trips || [])[0];
    if (!t) continue;
    tripIds.push(t.id);
    await ctx.do('Transport : répartir la tournée', 'POST', `${TM}/trips/${t.id}/dispatch`, {}, { as: 'manager' });
    await ctx.do('Transport : démarrer la tournée (compteur)', 'POST', `${TM}/trips/${t.id}/start`, { odometer: odo[vk] }, { as: runner });
    const trip = (await ctx.do('Transport : détail de la tournée', 'GET', `${TM}/trips/${t.id}`, undefined, { as: runner })).trip || { stops: [] };
    for (const [s, sp] of trip.stops.entries()) {
      await ctx.do('Ma tournée : arrivée chez le client', 'POST', `${TM}/stops/${sp.id}/arrive`, near(Object.keys(zones).find((z) => zones[z] === sp.zoneId) || 'akwa', s), { as: runner });
      if (i === 4 && s === 1) { // un client absent dans l'historique : nouvelle tentative le lendemain
        histFail = sp.id;
        await ctx.do('Ma tournée : échec (client absent) et nouvelle date', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'failed', reason: 'absent', note: 'Gardien sans consigne, téléphone du client éteint.', rescheduleDate: D(n + 1) }, { as: runner });
        continue;
      }
      if (i === 7 && s === 2) {
        await ctx.do('Ma tournée : refus du client (marchandise abîmée)', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'refused', reason: 'damaged', note: 'Sacs de ciment mouillés par la pluie, refusés par le chef de chantier.' }, { as: runner });
        continue;
      }
      // Historique ressaisi au bureau depuis les bons de livraison papier : l'heure réelle est « saisie après coup » (comptée à part).
      await ctx.do('Transport : livraison passée ressaisie (heure réelle du bon papier)', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'delivered', recipient: ['M. Ekwalla (magasinier)', 'Mme Ngo Nlend', 'Le chef de chantier', 'M. Tchoupo'][s % 4], codCollected: sp.codAmount || undefined, ...near('akwa', s), ...histTime(date, i, s) }, { as: 'manager' });
    }
    const km = Math.max(Math.round((Number(t.km) || 25) * 1.08), 14);
    odo[vk] += km;
    await ctx.do('Transport : clôturer la tournée (compteur, espèces remises)', 'POST', `${TM}/trips/${t.id}/finish`, { odometer: odo[vk] }, { as: runner });
    const per100 = { isuzu: 17, axor: 34, hiace: 12 }[vk];
    const liters = Math.round(km * per100) / 100;
    await ctx.do('Parc : relevé de carburant', 'POST', `${L}/fuel`, { vehicleId: veh[vk], driverId: drv[dk], date, liters, amount: Math.round(liters * 828), odometer: odo[vk], station: ['Tradex Bonabéri', 'Total Énergies Akwa', 'MRS Ndokoti'][i % 3], toBudget: i % 4 === 0 }, { as: runner === 'driver' ? 'driver' : 'manager' });
    await ctx.do('Transport : frais de route (indemnité)', 'POST', `${TM}/trips/${t.id}/costs`, { kind: 'allowance', label: 'Ration du chauffeur', amount: { samuel: 5000, ibrahim: 6000, joseph: 4000 }[dk] }, { as: runner });
    await ctx.do('Transport : frais de route (manutention)', 'POST', `${TM}/trips/${t.id}/costs`, { kind: 'handling', label: 'Dockers au déchargement', amount: 3000 + (i % 3) * 1500 }, { as: runner });
    if (i % 2 === 0) await ctx.do('Transport : frais de route (carburant)', 'POST', `${TM}/trips/${t.id}/costs`, { kind: 'fuel', label: 'Gasoil', amount: Math.round(liters * 828) }, { as: runner });
    if (i !== hist.length - 1) await ctx.do('Transport : valider les frais réels (répartition, écriture comptable)', 'POST', `${TM}/trips/${t.id}/costs/approve`, { account: i % 3 === 0 ? '571' : '589' }, { as: 'manager' });
    tripsDone++;
  }
  ctx.check('Transport : historique de tournées roulées et clôturées', tripsDone >= 10, { tripsDone });
  // La livraison en échec de l'historique repart dans le stock « à planifier » (elle sera reprise dans la proposition de demain).
  if (histFail) {
    const d = (await ctx.do('Logistique : détail d\'une livraison reprogrammée', 'GET', `${L}/deliveries/${histFail}`)).delivery || {};
    ctx.check('Logistique : la livraison en échec est remise à planifier à sa nouvelle date', d.status === 'shipped' && d.attempts === 1 && !d.roundId, d);
  }

  // Sous-traitance : livraisons confiées aux Transports Express du Wouri (historique) et à Garanti (Yaoundé).
  const sub = [];
  for (const [j, n] of [-30, -23, -16, -9].entries()) {
    const date = D(n);
    const ids = [];
    for (let s = 0; s < 3; s++) {
      const k = ['bati', 'sogea', 'ngono', 'mairie'][(j + s) % 4];
      ids.push(await mk(`w${j}_${s}`, base(k, 40 + j * 3 + s, { carrierId: carriers.wouri, plannedDate: date, weight: [1600, 2800, 900, 2300][(j + s) % 4], pallets: 2, tracking: `TEW-${String(51200 + j * 10 + s)}` })));
    }
    const p = await ctx.do(`Transport : tournée confiée au transporteur (${date})`, 'POST', `${TM}/plan/commit`, { date, trips: [{ name: `Wouri — lot du ${date.split('-').reverse().join('/')}`, carrierId: carriers.wouri, deliveryIds: ids }] }, { as: 'manager' });
    const t = (p.trips || [])[0]; if (!t) continue;
    await ctx.do('Transport : répartir (transporteur)', 'POST', `${TM}/trips/${t.id}/dispatch`, {}, { as: 'manager' });
    await ctx.do('Transport : départ (transporteur)', 'POST', `${TM}/trips/${t.id}/start`, {}, { as: 'manager' });
    for (const id of ids) await ctx.do('Transport : livraison confirmée par le transporteur', 'POST', `${TM}/stops/${id}/complete`, { outcome: 'delivered', recipient: 'Bon de livraison signé (transporteur)' }, { as: 'manager' });
    await ctx.do('Transport : fin de tournée (transporteur)', 'POST', `${TM}/trips/${t.id}/finish`, {}, { as: 'manager' });
    sub.push(...ids);
  }
  O.historyTrips = tripIds.length;

  // ---------- Aujourd'hui : trois tournées, dont celle de Samuel jouée sur son téléphone ----------
  const T0 = D(0);
  const tA = [
    await mk('sogea', base('sogea', 1, { plannedDate: T0, weight: 2320, pallets: 2, priority: 1, windowStart: '08:00', windowEnd: '11:00', note: 'Grue sur place, appeler le conducteur de travaux M. Abena 30 min avant.', items: [{ itemId: I.ciment, quantity: 40 }, { itemId: I.fer12, quantity: 30 }] }), 'manager'),
    await mk('hotel', base('hotel', 2, { plannedDate: T0, weight: 900, pallets: 1, windowStart: '09:00', windowEnd: '15:00', note: 'Entrée de service rue Joss.', items: [{ itemId: I.carreau, quantity: 25 }, { itemId: I.peinture, quantity: 4 }] })),
    await mk('quinc', base('quinc', 3, { plannedDate: T0, weight: 105, codAmount: 253406, note: 'Paiement à la livraison (facture TTC).', items: [{ itemId: I.tuyau, quantity: 20 }, { itemId: I.cable, quantity: 3 }] })),
  ];
  const tB = [
    await mk('etoundi', base('particulier', 4, { plannedDate: T0, weight: 500, codAmount: 98500, windowStart: '14:00', windowEnd: '17:00', items: [{ itemId: I.ciment, quantity: 10 }] })),
    await mk('bati', base('bati', 5, { plannedDate: T0, weight: 240, items: [{ itemId: I.tole, quantity: 30 }] })),
    await mk('mairie', base('mairie', 6, { plannedDate: T0, weight: 300, note: 'Kits de plomberie pour les bornes-fontaines.' })),
  ];
  const tC = [await mk('immo', base('immo', 7, { plannedDate: T0, carrierId: carriers.garanti, weight: 4500, pallets: 6, tracking: 'GEF-YDE-88412', note: 'Livraison au chantier R+4 (voir Chantiers).' }), 'manager')];
  await ctx.do('Logistique : modifier une livraison (adresse, téléphone)', 'PUT', `${L}/deliveries/${dl.hotel}`, { address: 'Boulevard de la Liberté, Bonanjo (entrée de service rue Joss)', phone: '+237 233 42 00 01', priority: 1 }, { as: 'seller' });
  await ctx.do('Logistique : modifier les articles d\'une livraison', 'PUT', `${L}/deliveries/${dl.bati}/items`, { items: [{ itemId: I.tole, quantity: 30 }, { itemId: I.peinture, quantity: 2 }] }, { as: 'seller' });
  const cand = await ctx.do('Transport : livraisons à planifier aujourd\'hui', 'GET', `${TM}/candidates?date=${T0}`, undefined, { as: 'manager' });
  ctx.check('Transport : les 7 livraisons du jour sont à planifier', [...tA, ...tB, ...tC].every((id) => (cand.deliveries || []).some((d) => d.id === id)), (cand.deliveries || []).map((d) => d.id));

  // Proposition automatique : le Kerax (assurance périmée) n'est pas proposé.
  const sug = await ctx.do('Transport : proposition automatique de tournées', 'POST', `${TM}/plan/suggest`, { date: T0, deliveryIds: [...tA, ...tB], startTime: '07:30' }, { as: 'manager' });
  ctx.check('Transport : la proposition n\'utilise pas le Kerax à l\'assurance périmée', (sug.trips || []).length > 0 && (sug.trips || []).every((t) => t.vehicleId !== veh.kerax) && sug.vehiclesFree === 3, { vehiclesFree: sug.vehiclesFree, trips: (sug.trips || []).map((t) => t.vehicle) });
  // Le responsable force le Kerax : refus net.
  const blocked = await ctx.do('Transport : le camion à l\'assurance périmée est refusé', 'POST', `${TM}/plan/commit`, { date: T0, trips: [{ vehicleId: veh.kerax, driverId: drv.ibrahim, deliveryIds: tA }] }, { as: 'manager', expect: 400 });
  ctx.check('Transport : motif du blocage « assurance périmée »', /assurance du véhicule LT 4471 B est périmée/.test(blocked.error || ''), blocked);
  const blockedRound = await ctx.do('Logistique : le camion à l\'assurance périmée est refusé aussi sur une tournée simple', 'POST', `${L}/rounds`, { name: 'Benne sable — chantier Kotto', date: T0, vehicleId: veh.kerax, driverId: drv.ibrahim }, { as: 'manager', expect: 400 });
  ctx.check('Logistique : motif du blocage sur la tournée simple', /assurance/.test(blockedRound.error || ''), blockedRound);
  // Trop chargé : 7,5 t dans l'Isuzu de 3,5 t.
  await ctx.do('Transport : véhicule trop chargé refusé', 'POST', `${TM}/plan/commit`, { date: T0, trips: [{ vehicleId: veh.isuzu, driverId: drv.samuel, deliveryIds: [...tA, ...tC] }] }, { as: 'manager', expect: 409 });

  const plan = await ctx.do('Transport : valider les tournées du jour', 'POST', `${TM}/plan/commit`, { date: T0, trips: [
    { name: 'Tournée Bonapriso – Akwa (Samuel)', vehicleId: veh.isuzu, driverId: drv.samuel, deliveryIds: tA, startTime: '07:30', note: 'Commencer par Sogea (grue réservée de 8 h à 11 h).' },
    { name: 'Tournée Makepe – Logpom – Kotto (Joseph)', vehicleId: veh.hiace, driverId: drv.joseph, deliveryIds: tB, startTime: '08:00' },
    { name: 'Lot Yaoundé — Garanti Express', carrierId: carriers.garanti, deliveryIds: tC, startTime: '06:00' },
  ] }, { as: 'manager' });
  const [A1, B1, C1] = (plan.trips || []).map((t) => t.id);
  O.trips = { today: [A1, B1, C1] };
  ctx.check('Transport : 3 tournées créées avec km et coût estimé', (plan.trips || []).length === 3 && plan.trips[0].km > 0 && plan.trips[0].estCost > 0, plan.trips);
  await ctx.do('Transport : réordonner une tournée (ordre imposé)', 'POST', `${TM}/trips/${A1}/optimize`, { keepOrder: true, startTime: '07:30' }, { as: 'manager' });
  await ctx.do('Transport : réoptimiser l\'ordre de passage', 'POST', `${TM}/trips/${B1}/optimize`, {}, { as: 'manager' });
  const sheet = await ctx.do('Transport : fiche de tournée (PDF)', 'GET', `${TM}/trips/${A1}/sheet`, undefined, { as: 'manager', raw: true });
  ctx.check('Transport : la fiche de tournée est un PDF', sheet.buf && sheet.buf.toString('latin1', 0, 5) === '%PDF-', sheet.status);
  if (ctx.users.seller) await ctx.do('Transport : seul un responsable répartit (droits)', 'POST', `${TM}/trips/${A1}/dispatch`, {}, { as: 'seller', expect: 403 });
  for (const id of [A1, B1, C1]) await ctx.do('Transport : répartir la tournée', 'POST', `${TM}/trips/${id}/dispatch`, {}, { as: 'manager' });
  await ctx.do('Transport : tableau de répartition (semaine)', 'GET', `${TM}/dispatch?from=${T0}&days=7`, undefined, { as: 'manager' });

  // Suivi client : lien secret envoyé à Sogea avant le départ.
  const share = await ctx.do('Suivi client : lien secret et message prêt à envoyer', 'GET', `${TM}/deliveries/${dl.sogea}/share`, undefined, { as: 'seller' });
  ctx.check('Suivi client : lien /suivi/… et message WhatsApp préparé', /\/suivi\/[A-Za-z0-9_-]{24}$/.test(share.url || '') && /wa\.me/.test(share.whatsapp || ''), share);
  await ctx.do('Suivi client : envoi du lien par e-mail (si l\'e-mail est activé)', 'POST', `${TM}/deliveries/${dl.sogea}/share/email`, { to: 'achats@sogea-demo.example' }, { as: 'seller', expect: [200, 400] });
  let pub = await ctx.do('Suivi client : page publique (avant le départ)', 'GET', `/api/ws/public/track/${share.token}`);
  ctx.check('Suivi client : aucune donnée personnelle sur la page publique', pub.status && !JSON.stringify(pub).includes('+237') && !JSON.stringify(pub).includes('Njo-Njo'), pub);

  // ----- Ma tournée (Samuel) : départ, arrivées, preuves, encaissement -----
  const mine = await ctx.do('Ma tournée : écran du chauffeur', 'GET', `${TM}/driver`, undefined, { as: asDriver });
  if (hasDriver) ctx.check('Ma tournée : Samuel voit sa tournée du jour', (mine.trips || []).some((t) => t.id === A1 && t.isMine), (mine.trips || []).map((t) => t.id));
  if (hasDriver) await ctx.do('Ma tournée : un chauffeur ne démarre pas la tournée d\'un autre (droits)', 'POST', `${TM}/trips/${B1}/start`, { odometer: odo.hiace }, { as: 'driver', expect: 403 });
  const before = Object.fromEntries(((await ctx.do('Stock : quantités avant le départ', 'GET', '/stock')).items || []).map((i) => [i.id, Number(i.quantity)]));
  await ctx.do('Ma tournée : démarrer (kilométrage au compteur)', 'POST', `${TM}/trips/${A1}/start`, { odometer: odo.isuzu }, { as: asDriver });
  const after = Object.fromEntries(((await ctx.do('Stock : quantités après le départ', 'GET', '/stock')).items || []).map((i) => [i.id, Number(i.quantity)]));
  ctx.check('Stock : le départ sort 40 sacs de ciment et 30 barres de HA 12', before[I.ciment] - after[I.ciment] === 40 && before[I.fer12] - after[I.fer12] === 30, { ciment: [before[I.ciment], after[I.ciment]], fer12: [before[I.fer12], after[I.fer12]] });
  pub = await ctx.do('Suivi client : page publique (en route, créneau estimé)', 'GET', `/api/ws/public/track/${share.token}`);
  ctx.check('Suivi client : « En route » avec un créneau d\'arrivée', pub.status === 'on_route' && pub.window && pub.window.from, pub);
  // En ligne (sans compte chauffeur), le responsable joue la tournée depuis la fiche de la tournée.
  const runA = hasDriver ? (((await ctx.do('Ma tournée : arrêts dans l\'ordre', 'GET', `${TM}/driver`, undefined, { as: asDriver })).trips || []).find((t) => t.id === A1) || { stops: [] })
    : ((await ctx.do('Transport : fiche de la tournée (arrêts dans l\'ordre)', 'GET', `${TM}/trips/${A1}`, undefined, { as: 'manager' })).trip || { stops: [] });
  const who = { [dl.sogea]: 'M. Abena (conducteur de travaux)', [dl.hotel]: 'Mme Eyoum (économe de l\'hôtel)', [dl.quinc]: 'M. Kamdem (gérant)' };
  for (const [s, sp] of runA.stops.entries()) {
    const g = near(Object.keys(zones).find((z) => zones[z] === sp.zoneId) || 'akwa', s);
    await ctx.do('Ma tournée : « Je suis arrivé » (position GPS)', 'POST', `${TM}/stops/${sp.id}/arrive`, g, { as: asDriver });
    if (sp.id === dl.sogea) { pub = await ctx.do('Suivi client : « Le livreur est arrivé »', 'GET', `/api/ws/public/track/${share.token}`); ctx.check('Suivi client : étape « arrivé » visible', (pub.steps || []).some((x) => x.status === 'arrived'), pub.steps); }
    await ctx.do('Ma tournée : signature du client', 'POST', `${TM}/stops/${sp.id}/pod?kind=signature`, PNG, { as: asDriver });
    await ctx.do('Ma tournée : photo de la marchandise livrée', 'POST', `${TM}/stops/${sp.id}/pod?kind=photo`, PNG, { as: asDriver });
    if (sp.codAmount) await ctx.do('Ma tournée : encaissement supérieur au dû refusé', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'delivered', recipient: who[sp.id], codCollected: sp.codAmount + 10000 }, { as: asDriver, expect: 400 });
    await ctx.do('Ma tournée : livrée (nom, position, encaissement)', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'delivered', recipient: who[sp.id] || 'Le réceptionnaire', codCollected: sp.codAmount || undefined, note: sp.codAmount ? 'Espèces comptées devant le client, reçu remis.' : '', ...g }, { as: asDriver });
  }
  const pods = await ctx.do('Preuves : liste pour une livraison', 'GET', `${TM}/stops/${dl.sogea}/pod`, undefined, { as: 'manager' });
  ctx.check('Preuves : signature et photo enregistrées', (pods.files || []).length === 2, pods);
  if ((pods.files || [])[0]) {
    const f = await ctx.do('Preuves : ouvrir la signature (chiffrée dans la base)', 'GET', `${TM}/pod/${pods.files[0].id}/file`, undefined, { as: 'manager', raw: true });
    ctx.check('Preuves : l\'image relue est identique', f.buf && f.buf.equals(PNG), f.status);
    if (ctx.users.seller) await ctx.do('Preuves : une commerciale ne voit pas les preuves (droits)', 'GET', `${TM}/pod/${pods.files[0].id}/file`, undefined, { as: 'seller', expect: 403 });
  }
  await ctx.do('Ma tournée : frais de stationnement', 'POST', `${TM}/trips/${A1}/costs`, { kind: 'parking', label: 'Parking Marché Central', amount: 1000 }, { as: asDriver });
  await ctx.do('Ma tournée : ration du chauffeur', 'POST', `${TM}/trips/${A1}/costs`, { kind: 'allowance', label: 'Ration', amount: 5000 }, { as: asDriver });
  const wrongCost = (await ctx.do('Ma tournée : frais saisi en double', 'POST', `${TM}/trips/${A1}/costs`, { kind: 'parking', label: 'Parking (doublon)', amount: 1000 }, { as: asDriver })).id;
  await ctx.do('Transport : supprimer un frais en double', 'DELETE', `${TM}/trip-costs/${wrongCost}`, undefined, { as: 'manager' });
  await ctx.do('Ma tournée : frais de la tournée', 'GET', `${TM}/trips/${A1}/costs`, undefined, { as: asDriver });
  odo.isuzu += 31;
  const fin = await ctx.do('Ma tournée : terminer (compteur, espèces remises)', 'POST', `${TM}/trips/${A1}/finish`, { odometer: odo.isuzu, codRemitted: 253406 }, { as: asDriver });
  ctx.check('Ma tournée : tournée réussie, 253 406 FCFA encaissés et remis, 31 km', fin.km === 31 && fin.cod && fin.cod.collected === 253406 && fin.cod.gap === 0, fin);
  await ctx.do('Parc : le chauffeur saisit son plein', 'POST', `${L}/fuel`, { vehicleId: veh.isuzu, driverId: drv.samuel, liters: 38.5, amount: 31878, odometer: odo.isuzu, station: 'Tradex Bonabéri' }, { as: asDriver });
  const appr = await ctx.do('Transport : valider les frais de la tournée (écriture comptable)', 'POST', `${TM}/trips/${A1}/costs/approve`, { account: '571' }, { as: 'manager' });
  ctx.check('Transport : frais répartis sur les 3 livraisons au prorata du poids', appr.total === 6000 && (appr.allocation || []).length === 3, appr);
  pub = await ctx.do('Suivi client : page publique (livrée)', 'GET', `/api/ws/public/track/${share.token}`);
  ctx.check('Suivi client : « Livrée » avec l\'heure', pub.status === 'delivered' && pub.deliveredAt, pub);

  // ----- Tournée de Joseph (jouée par le responsable) : partielle, échec reprogrammé par le chauffeur, échec reprogrammé au bureau -----
  // Les ventes ont pu mettre la tôle en rupture (c'est voulu dans la démo) : réassort Alucam avant le chargement du camion.
  const toleNow = ((await ctx.do('Stock : niveau de la tôle avant chargement', 'GET', '/stock')).items || []).find((x) => x.id === I.tole);
  if (toleNow && Number(toleNow.quantity) < 30) await ctx.do('Stock : réassort de tôles reçu d\'Alucam avant la tournée', 'POST', `/stock/items/${I.tole}/move`, { kind: 'in', quantity: 30 - Number(toleNow.quantity) + 60, unitCost: 7200, note: 'Réassort Alucam (livraison express)' }, { as: 'manager' });
  await ctx.do('Transport : démarrer la tournée de Joseph', 'POST', `${TM}/trips/${B1}/start`, { odometer: odo.hiace }, { as: 'manager' });
  const runB = (await ctx.do('Transport : détail de la tournée (articles)', 'GET', `${TM}/trips/${B1}`, undefined, { as: 'manager' })).trip || { stops: [] };
  for (const sp of runB.stops) {
    await ctx.do('Ma tournée : arrivée', 'POST', `${TM}/stops/${sp.id}/arrive`, near('logpom', sp.pos), { as: 'manager' });
    if (sp.id === dl.bati) {
      const lines = (sp.items || []).map((x) => ({ id: x.id, delivered: x.name.startsWith('Tôle') ? 24 : x.quantity }));
      const r = await ctx.do('Ma tournée : livraison partielle (6 tôles pliées remises en stock)', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'partial', recipient: 'M. Fouda (chef de chantier)', lines, note: '6 tôles pliées pendant le transport, rapportées au dépôt.', ...near('bonamoussadi', 2) }, { as: 'manager' });
      ctx.check('Stock : la part non livrée revient en stock (6 tôles)', (r.returnedToStock || []).some((x) => x.itemId === I.tole && x.quantity === 6), r);
    } else if (sp.id === dl.etoundi) {
      await ctx.do('Ma tournée : encaisser sans livrer est refusé', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'failed', reason: 'absent', codCollected: 98500 }, { as: 'manager', expect: 400 });
      await ctx.do('Ma tournée : échec — client absent, nouvelle date dans 2 jours', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'failed', reason: 'absent', note: 'Client injoignable, voisin sans procuration.', rescheduleDate: D(2), ...near('logpom', 1) }, { as: 'manager' });
    } else {
      await ctx.do('Ma tournée : échec — accès impossible (motif)', 'POST', `${TM}/stops/${sp.id}/complete`, { outcome: 'failed', reason: 'access', note: 'Portail des services techniques fermé, gardien absent.', ...near('logpom', 3) }, { as: 'manager' });
    }
  }
  odo.hiace += 27;
  await ctx.do('Transport : terminer en gardant la marchandise pour un nouvel essai', 'POST', `${TM}/trips/${B1}/finish`, { odometer: odo.hiace, returnFailed: false, codRemitted: 0 }, { as: 'manager' });
  await ctx.do('Transport : replanifier au bureau la livraison en échec', 'POST', `${TM}/deliveries/${dl.mairie}/reschedule`, { date: D(1), note: 'Rendez-vous pris avec l\'ingénieur municipal à 9 h.' }, { as: 'manager' });
  const et = (await ctx.do('Logistique : historique de la livraison en échec', 'GET', `${L}/deliveries/${dl.etoundi}`)).delivery || {};
  ctx.check('Échec reprogrammé : M. Etoundi à nouveau à planifier dans 2 jours (1 tentative, client absent)', et.status === 'shipped' && et.plannedDate === D(2) && et.attempts === 1 && et.failureReason === 'absent', et);
  await ctx.do('Logistique : prévenir le client (lien WhatsApp prérempli)', 'GET', `${L}/deliveries/${dl.etoundi}/notify`, undefined, { as: 'seller' });
  const sEt = await ctx.do('Suivi client : lien pour M. Etoundi', 'GET', `${TM}/deliveries/${dl.etoundi}/share`, undefined, { as: 'seller' });

  // ----- Garanti (Yaoundé) : en route, livré par le transporteur -----
  await ctx.do('Transport : départ du lot Yaoundé (transporteur)', 'POST', `${TM}/trips/${C1}/start`, {}, { as: 'manager' });
  await ctx.do('Transport : livraison confirmée à Odza', 'POST', `${TM}/stops/${dl.immo}/complete`, { outcome: 'delivered', recipient: 'Magasinier du chantier R+4 (bordereau GEF-YDE-88412)' }, { as: 'manager' });
  await ctx.do('Transport : fin du lot Yaoundé', 'POST', `${TM}/trips/${C1}/finish`, {}, { as: 'manager' });
  await ctx.do('Transport : coût attendu d\'une livraison (grille du transporteur)', 'GET', `${TM}/deliveries/${dl.immo}/cost`, undefined, { as: 'manager' });

  // ---------- Demain et après-demain : planification ----------
  const T1 = D(1); const T2 = D(2);
  await mk('t1a', base('sogea', 11, { plannedDate: T1, weight: 3100, pallets: 3, priority: 2, note: 'Urgent : coulage de dalle demain matin.' }), 'manager');
  await mk('t1b', base('hotel', 12, { plannedDate: T1, weight: 400, windowStart: '10:00', windowEnd: '12:00' }));
  await mk('t1c', base('ngono', 13, { plannedDate: T1, weight: 2600, pallets: 4 }));
  await mk('t1d', base('quinc', 14, { plannedDate: T1, weight: 650, codAmount: 145000 }));
  await mk('t2a', base('bati', 15, { plannedDate: T2, weight: 600 }));
  await mk('tmp', base('quinc', 16, { plannedDate: T2, weight: 10, note: 'Saisie en double' }));
  await ctx.do('Logistique : supprimer une livraison saisie en double', 'DELETE', `${L}/deliveries/${dl.tmp}`, undefined, { as: 'manager' });
  const s1 = await ctx.do('Transport : proposition automatique pour demain', 'POST', `${TM}/plan/suggest`, { date: T1, startTime: '07:00' }, { as: 'manager' });
  ctx.check('Transport : la proposition de demain reprend la livraison reprogrammée de la mairie', (s1.trips || []).some((t) => t.stops.some((x) => x.deliveryId === dl.mairie)), (s1.trips || []).map((t) => t.stops.map((x) => x.customerName)));
  if ((s1.trips || []).length) {
    const c1 = await ctx.do('Transport : valider la proposition de demain', 'POST', `${TM}/plan/commit`, { date: T1, trips: s1.trips.map((t) => ({ name: t.name, vehicleId: t.vehicleId, driverId: t.driverId, deliveryIds: t.stops.map((x) => x.deliveryId), startTime: t.startTime })) }, { as: 'manager' });
    const first = (c1.trips || [])[0];
    if (first) await ctx.do('Transport : répartir la tournée de demain', 'POST', `${TM}/trips/${first.id}/dispatch`, {}, { as: 'manager' });
  }
  const c2 = await ctx.do('Transport : planifier après-demain (retour chez M. Etoundi)', 'POST', `${TM}/plan/commit`, { date: T2, trips: [{ name: 'Tournée Logpom (essai)', vehicleId: veh.hiace, driverId: drv.joseph, deliveryIds: [dl.etoundi, dl.t2a] }] }, { as: 'manager' });
  const tc = (c2.trips || [])[0];
  if (tc) {
    await ctx.do('Transport : annuler une tournée pas encore partie', 'POST', `${TM}/trips/${tc.id}/cancel`, {}, { as: 'manager' });
    await ctx.do('Transport : replanifier avec Samuel et l\'Isuzu', 'POST', `${TM}/plan/commit`, { date: T2, trips: [{ name: 'Tournée Logpom – Makepe (2e passage Etoundi)', vehicleId: veh.isuzu, driverId: drv.samuel, deliveryIds: [dl.etoundi, dl.t2a], startTime: '13:30' }] }, { as: 'manager' });
  }
  pub = await ctx.do('Suivi client : M. Etoundi voit sa nouvelle date', 'GET', `/api/ws/public/track/${sEt.token}`);
  ctx.check('Suivi client : nouvelle date et tentative sans succès affichées', pub.plannedDate === T2 && (pub.steps || []).some((x) => x.status === 'failed'), pub);
  await ctx.do('Suivi client : révoquer un lien', 'POST', `${TM}/deliveries/${dl.hotel}/share/revoke`, {}, { as: 'manager' });

  // ---------- Logistique simple (sans planification) : expédition par transporteur, retour, tournées manuelles ----------
  await mk('exp', base('ngono', 20, { carrierId: carriers.wouri, plannedDate: D(-6), weight: 1200, tracking: 'TEW-51990', items: [{ itemId: I.fer10, quantity: 40 }] }));
  await ctx.do('Logistique : expédiée (le stock sort)', 'PUT', `${L}/deliveries/${dl.exp}/status`, { status: 'shipped', note: 'Remis au camion Wouri n° LT 9031 F' }, { as: 'storekeeper' });
  await ctx.do('Logistique : en route', 'PUT', `${L}/deliveries/${dl.exp}/status`, { status: 'on_route' }, { as: 'storekeeper' });
  await ctx.do('Logistique : « Livrée » exige le nom du réceptionnaire', 'PUT', `${L}/deliveries/${dl.exp}/status`, { status: 'delivered' }, { as: 'storekeeper', expect: 400 });
  await ctx.do('Logistique : livrée (réceptionnaire)', 'PUT', `${L}/deliveries/${dl.exp}/status`, { status: 'delivered', receivedBy: 'M. Ngono Junior', proof: 'BL signé n° 51990' }, { as: 'storekeeper' });
  await mk('ret', base('bati', 21, { carrierId: carriers.wouri, plannedDate: D(-5), weight: 800, tracking: 'TEW-52011', items: [{ itemId: I.parpaing, quantity: 40 }] }));
  await ctx.do('Logistique : expédiée', 'PUT', `${L}/deliveries/${dl.ret}/status`, { status: 'shipped' }, { as: 'storekeeper' });
  await ctx.do('Logistique : échec (motif obligatoire)', 'PUT', `${L}/deliveries/${dl.ret}/status`, { status: 'failed', note: 'Adresse introuvable, client injoignable' }, { as: 'storekeeper' });
  await ctx.do('Logistique : retournée (le stock revient)', 'PUT', `${L}/deliveries/${dl.ret}/status`, { status: 'returned', note: 'Rapportée au dépôt par le transporteur' }, { as: 'storekeeper' });
  await ctx.do('Logistique : détail d\'une livraison (historique, articles)', 'GET', `${L}/deliveries/${dl.exp}`);
  const r1 = (await ctx.do('Logistique : tournée manuelle (navette Bonabéri ↔ Mvan)', 'POST', `${L}/rounds`, { name: 'Navette Bonabéri → dépôt de Mvan', date: D(3), vehicleId: veh.axor, driverId: drv.ibrahim, note: 'Réassort du dépôt de Yaoundé.' }, { as: 'manager' })).id;
  await mk('nav1', { customerName: 'Dépôt de Yaoundé (transfert interne)', address: 'Mvan, Yaoundé', zoneId: zones.yaounde, plannedDate: D(3), weight: 9000, pallets: 8 }, 'manager');
  await mk('nav2', base('immo', 22, { plannedDate: D(3), weight: 1800 }), 'manager');
  await ctx.do('Logistique : ordre de passage de la tournée manuelle', 'PUT', `${L}/rounds/${r1}/order`, { deliveryIds: [dl.nav1, dl.nav2] }, { as: 'manager' });
  await ctx.do('Logistique : modifier la tournée manuelle', 'PUT', `${L}/rounds/${r1}`, { note: 'Réassort du dépôt de Yaoundé + livraison Immobilière des Collines.' }, { as: 'manager' });
  const r2 = (await ctx.do('Logistique : tournée manuelle (essai)', 'POST', `${L}/rounds`, { name: 'Tournée à supprimer', date: D(4) }, { as: 'manager' })).id;
  await ctx.do('Logistique : supprimer une tournée', 'DELETE', `${L}/rounds/${r2}`, undefined, { as: 'manager' });
  await ctx.do('Logistique : liste des tournées', 'GET', `${L}/rounds`);

  // ---------- Factures des transporteurs et rapprochement ----------
  const ub = (await ctx.do('Factures transporteurs : livraisons Wouri non facturées', 'GET', `${TM}/carriers/${carriers.wouri}/unbilled`, undefined, { as: 'manager' })).deliveries || [];
  ctx.check('Factures transporteurs : livraisons Wouri à rapprocher avec leur coût attendu', ub.length >= 10 && ub.every((d) => d.expected > 0), ub.slice(0, 3));
  const half = Math.ceil(ub.length / 2);
  const f1 = await ctx.do('Factures transporteurs : saisir la facture conforme (1re quinzaine)', 'POST', `${TM}/carrier-invoices`, { carrierId: carriers.wouri, ref: 'TEW-F-2026-0871', date: D(-15), vat: Math.round(ub.slice(0, half).reduce((a, d) => a + d.expected, 0) * 0.1925), lines: ub.slice(0, half).map((d) => ({ deliveryId: d.id, amount: d.expected, label: `${d.customerName} ${d.date}` })) }, { as: 'manager' });
  ctx.check('Factures transporteurs : facture conforme, aucun écart', f1.invoice && f1.invoice.issues === 0, f1.invoice && f1.invoice.lines.map((l) => l.flag));
  if (f1.invoice) await ctx.do('Factures transporteurs : valider (écriture 612 / 4454 / 401)', 'POST', `${TM}/carrier-invoices/${f1.invoice.id}/approve`, {}, { as: 'manager' });
  await ctx.do('Factures transporteurs : la même référence ne se saisit pas deux fois', 'POST', `${TM}/carrier-invoices`, { carrierId: carriers.wouri, ref: 'TEW-F-2026-0871', lines: [{ amount: 1000 }] }, { as: 'manager', expect: 409 });
  const rest = ub.slice(half);
  const f2 = await ctx.do('Factures transporteurs : facture avec un écart et une ligne déjà facturée', 'POST', `${TM}/carrier-invoices`, { carrierId: carriers.wouri, ref: 'TEW-F-2026-0912', date: D(-1), vat: 0, note: 'Facture de fin de mois', lines: [
    ...rest.map((d, k) => ({ deliveryId: d.id, amount: k === 0 ? Math.round(d.expected * 1.25) : d.expected, label: k === 0 ? `${d.customerName} (attente 3 h facturée)` : d.customerName })),
    { deliveryId: ub[0].id, amount: ub[0].expected, label: `${ub[0].customerName} (déjà facturée)` },
  ] }, { as: 'manager' });
  const inv2 = f2.invoice || {};
  ctx.check('Factures transporteurs : écarts détectés (surfacturation, doublon)', (inv2.lines || []).some((l) => l.flag === 'over') && (inv2.lines || []).some((l) => l.flag === 'duplicate'), (inv2.lines || []).map((l) => l.flag));
  if (inv2.id) {
    await ctx.do('Factures transporteurs : validation refusée tant qu\'il y a des écarts', 'POST', `${TM}/carrier-invoices/${inv2.id}/approve`, {}, { as: 'manager', expect: 409 });
    await ctx.do('Factures transporteurs : annuler la facture contestée', 'POST', `${TM}/carrier-invoices/${inv2.id}/cancel`, {}, { as: 'manager' });
    const f3 = await ctx.do('Factures transporteurs : facture corrigée (sans le doublon)', 'POST', `${TM}/carrier-invoices`, { carrierId: carriers.wouri, ref: 'TEW-F-2026-0912-A', date: D(-1), lines: rest.map((d, k) => ({ deliveryId: d.id, amount: k === 0 ? Math.round(d.expected * 1.25) : d.expected, label: d.customerName })) }, { as: 'manager' });
    if (f3.invoice) {
      await ctx.do('Factures transporteurs : rapprocher à nouveau', 'POST', `${TM}/carrier-invoices/${f3.invoice.id}/rematch`, {}, { as: 'manager' });
      await ctx.do('Factures transporteurs : valider malgré l\'écart, avec justification', 'POST', `${TM}/carrier-invoices/${f3.invoice.id}/approve`, { force: true, note: 'Attente de 3 h au chantier Sogea acceptée (grue en panne).' }, { as: 'manager' });
    }
  }
  const g1 = await ctx.do('Factures transporteurs : facture Garanti (Yaoundé)', 'POST', `${TM}/carrier-invoices`, { carrierId: carriers.garanti, ref: 'GEF-2026-11-0458', date: T0, vat: 21310, lines: [{ deliveryId: dl.immo, amount: 110700, label: 'Lot Odza 4,5 t' }] }, { as: 'manager' });
  if (g1.invoice) {
    ctx.check('Factures transporteurs : Garanti conforme à la grille (110 700 FCFA)', g1.invoice.issues === 0 && g1.invoice.expected === 110700, g1.invoice);
    await ctx.do('Factures transporteurs : valider la facture Garanti', 'POST', `${TM}/carrier-invoices/${g1.invoice.id}/approve`, {}, { as: 'manager' });
    await ctx.do('Factures transporteurs : détail', 'GET', `${TM}/carrier-invoices/${g1.invoice.id}`, undefined, { as: 'manager' });
  }
  await ctx.do('Factures transporteurs : liste', 'GET', `${TM}/carrier-invoices`, undefined, { as: 'manager' });

  // ---------- Parc : carburant, consommation ----------
  const fuel = await ctx.do('Parc : relevés de carburant (consommation aux 100 km)', 'GET', `${L}/fuel?vehicleId=${veh.isuzu}`, undefined, { as: 'manager' });
  ctx.check('Parc : consommation calculée entre deux pleins', (fuel.fuel || []).some((f) => f.consumption > 0), (fuel.fuel || []).slice(0, 3));
  await ctx.do('Parc : kilométrage inférieur au dernier relevé refusé', 'POST', `${L}/fuel`, { vehicleId: veh.isuzu, liters: 20, odometer: 1000 }, { as: asDriver, expect: 400 });
  const fx = (await ctx.do('Parc : plein saisi par erreur', 'POST', `${L}/fuel`, { vehicleId: veh.axor, liters: 10, odometer: odo.axor + 1 }, { as: 'manager' })).id;
  await ctx.do('Parc : supprimer un relevé de carburant', 'DELETE', `${L}/fuel/${fx}`, undefined, { as: 'manager' });
  await ctx.do('Parc : un véhicule avec des relevés ne se supprime pas', 'DELETE', `${L}/vehicles/${veh.isuzu}`, undefined, { as: 'manager', expect: 409 });
  const fl = await ctx.do('Parc : vue d\'ensemble (consommation, coût au km, échéances, entretien)', 'GET', `${L}/fleet`, undefined, { as: 'manager' });
  const ax = (fl.vehicles || []).find((v) => v.id === veh.axor) || {};
  ctx.check('Parc : le camion Axor relié à la maintenance affiche son plan de vidange', (ax.maintenance || []).length > 0 && ax.avgConsumption > 0, ax);
  ctx.check('Parc : alertes (1 échéance périmée, plusieurs bientôt)', fl.summary && fl.summary.expired === 1 && fl.summary.soon >= 2, fl.summary);
  const mp = (await ctx.do('Maintenance : plans (le compteur du camion a avancé)', 'GET', '/maintenance/plans')).plans || [];
  ctx.check('Maintenance : la vidange du camion Axor est due (compteur alimenté par les tournées)', mp.some((p) => p.equipmentId === (O.equipment || {}).truck && p.state !== 'ok'), mp.filter((p) => p.equipmentId === (O.equipment || {}).truck));

  // ---------- Tableaux de bord, indicateurs, exports ----------
  const dash = await ctx.do('Logistique : tableau de bord', 'GET', L, undefined, { as: 'manager' });
  ctx.check('Logistique : tableau de bord rempli (taux de réussite, coût du mois)', dash.summary && dash.summary.successRate > 50 && dash.summary.monthCost > 0, dash.summary);
  await ctx.do('Logistique : tableau de bord (membre, antenne de Douala)', 'GET', L, undefined, { as: 'storekeeper' });
  await ctx.do('Transport : liste des tournées (6 semaines)', 'GET', `${TM}/trips?from=${D(-45)}&to=${D(7)}`, undefined, { as: 'manager' });
  await ctx.do('Transport : tournées terminées', 'GET', `${TM}/trips?from=${D(-45)}&to=${D(0)}&status=done`, undefined, { as: 'manager' });
  await ctx.do('Transport : tableau de répartition du jour', 'GET', `${TM}/dispatch`, undefined, { as: 'manager' });
  const k = await ctx.do('Transport : indicateurs (à l\'heure, premier passage, coûts, CO2)', 'GET', `${TM}/kpi?from=${D(-45)}&to=${D(0)}`, undefined, { as: 'manager' });
  ctx.check('Transport : indicateurs remplis', k.summary && k.summary.delivered >= 30 && k.summary.trips >= 15 && k.summary.firstAttemptPct > 80 && k.summary.firstAttemptPct < 100 && k.summary.totalCost > 0 && k.summary.co2Kg > 0 && (k.failures || []).length >= 2, k.summary);
  ctx.check('Transport : taux « à l\'heure » réaliste, heures ressaisies comptées à part', k.summary && k.summary.onTimePct >= 70 && k.summary.onTimePct < 100 && k.summary.declaredTimes >= 20, k.summary && [k.summary.onTimePct, k.summary.declaredTimes, k.summary.onTimeLivePct]);
  await ctx.do('Transport : indicateurs (vue membre, sans montants)', 'GET', `${TM}/kpi`, undefined, { as: 'seller' });
  for (const kind of ['deliveries', 'trips', 'failures', 'vehicles']) {
    const csv = await ctx.do(`Transport : export CSV (${kind})`, 'GET', `${TM}/kpi/export?kind=${kind}&from=${D(-45)}&to=${D(0)}`, undefined, { as: 'manager', raw: true });
    ctx.check(`Transport : export ${kind} au format CSV (Excel)`, /text\/csv/.test(csv.headers && csv.headers.get('content-type') || '') && (csv.text || '').split('\r\n').length > 2, csv.status);
  }
  O.vehicles = veh; O.drivers = drv; O.zones = zones; O.carriers = carriers; O.deliveries = dl;
};
