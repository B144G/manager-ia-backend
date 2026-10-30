'use strict';
// Vague 1 : logistique et parc (pont stock-livraison, véhicules, chauffeurs, tournées, carburant, échéances, lien maintenance).
// Lancez-le avec : node scripts/test-wave1-fleet.js
const { run } = require('./lib/wave1');
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

run('Logistique : stock, parc, carburant, échéances', async ({ check, owner, mgr, mem, other, org, O }) => {
  const L = `${O}/logistics`; const S = `${O}/stock`;
  // Pont stock <-> livraison
  let r = await mgr('POST', `${S}/items`, { name: 'Lait', unit: 'carton', tracking: 'lot', quantity: 10 });
  const lait = r.json.id;
  r = await mgr('POST', `${S}/items`, { name: 'Moto 125', unit: 'moto', tracking: 'serial', quantity: 2, serials: 'VINM1, VINM2' });
  const moto = r.json.id;
  check('articles créés (lot et VIN)', r.status === 201, r.json);
  r = await mem('POST', `${L}/deliveries`, { customerName: 'Client A', items: [{ itemId: lait, quantity: 4 }, { itemId: moto, serials: 'VINM2' }] });
  const del = r.json.id;
  check('livraison avec articles du stock', r.status === 201, r.json);
  r = await mem('POST', `${L}/deliveries`, { customerName: 'X', items: [{ itemId: moto }] });
  check('moto sans VIN refusée', r.status === 400, r.json);
  r = await mem('POST', `${L}/deliveries`, { customerName: 'X', items: [{ itemId: lait, quantity: 1 }, { itemId: lait, quantity: 1 }] });
  check('article en double refusé', r.status === 400, r.json);
  r = await mem('PUT', `${L}/deliveries/${del}/status`, { status: 'shipped' });
  check('expédier sort du stock', r.status === 200, r.json);
  r = await mgr('GET', S);
  check('lait 10 -> 6, motos 2 -> 1', r.json.items.find((i) => i.id === lait).quantity === 6 && r.json.items.find((i) => i.id === moto).quantity === 1, r.json.items.map((i) => [i.name, i.quantity]));
  await mem('PUT', `${L}/deliveries/${del}/status`, { status: 'on_route' });
  r = await mgr('GET', S);
  check('passer « en route » ne ressort pas le stock une 2e fois', r.json.items.find((i) => i.id === lait).quantity === 6);
  r = await mem('PUT', `${L}/deliveries/${del}/items`, { items: [] });
  check('articles verrouillés une fois le stock sorti', r.status === 400, r.json);
  r = await mem('PUT', `${L}/deliveries/${del}/status`, { status: 'returned', note: 'Client absent' });
  r = await mgr('GET', S);
  check('retour : stock réintégré (lait 10, motos 2)', r.json.items.find((i) => i.id === lait).quantity === 10 && r.json.items.find((i) => i.id === moto).quantity === 2, r.json.items.map((i) => [i.name, i.quantity]));
  await mem('PUT', `${L}/deliveries/${del}/status`, { status: 'returned', note: 'Encore' });
  r = await mgr('GET', S);
  check('un 2e « retourné » ne réintègre pas deux fois', r.json.items.find((i) => i.id === lait).quantity === 10);
  r = await mem('GET', `${L}/deliveries/${del}`);
  check('détail : articles, stock sorti et réintégré', r.json.delivery.items.length === 2 && r.json.delivery.stockOut === true && r.json.delivery.stockBack === true, r.json.delivery);
  r = await mgr('POST', `${L}/deliveries`, { customerName: 'Gros client', items: [{ itemId: lait, quantity: 50 }] });
  r = await mgr('PUT', `${L}/deliveries/${r.json.id}/status`, { status: 'shipped' });
  check('stock insuffisant : expédition refusée', r.status === 400, r.json);
  r = await mgr('GET', `${L}`);
  check('et l\'état de la livraison n\'a pas changé', r.json.deliveries.find((d) => d.customerName === 'Gros client').status === 'to_prepare');

  // Véhicules et chauffeurs
  r = await mem('POST', `${L}/vehicles`, { plate: 'LT-123-AB' });
  check('un membre n\'ajoute pas de véhicule -> 403', r.status === 403, r.status);
  r = await mgr('POST', `${O}/maintenance/equipment`, { name: 'Camion 1', kind: 'vehicle', meter: 1000 });
  const eq = r.json.id;
  r = await mgr('POST', `${O}/maintenance/equipment`, { name: 'Four', kind: 'machine' });
  const eqM = r.json.id;
  r = await mgr('POST', `${L}/vehicles`, { plate: 'lt-123-ab', label: 'Camion Isuzu', kind: 'truck', vin: 'JAABC123', odometer: 1000, equipmentId: eqM });
  check('équipement de type machine refusé', r.status === 400, r.json);
  r = await mgr('POST', `${L}/vehicles`, { plate: 'lt-123-ab', label: 'Camion Isuzu', kind: 'truck', vin: 'jaabc123', odometer: 1000, equipmentId: eq });
  const veh = r.json.id;
  check('véhicule relié à un équipement de maintenance', r.status === 201, r.json);
  r = await mgr('POST', `${L}/vehicles`, { plate: 'LT-123-AB' });
  check('immatriculation en double -> 409', r.status === 409, r.json);
  r = await mgr('POST', `${L}/drivers`, { name: 'Jean Chauffeur', phone: '237677000111', licenseNo: 'P123', licenseCategory: 'C' });
  const drv = r.json.id;
  r = await mgr('POST', `${L}/drivers`, { name: 'Paul Permis périmé' });
  const drv2 = r.json.id;
  r = await mgr('POST', `${L}/compliance`, { subject: 'driver', driverId: drv2, kind: 'license', expiresAt: day(-10), reference: 'P999' });
  r = await mgr('POST', `${L}/compliance`, { subject: 'driver', driverId: drv, kind: 'license', expiresAt: day(400) });
  r = await mgr('POST', `${L}/compliance`, { subject: 'vehicle', vehicleId: veh, kind: 'insurance', expiresAt: day(5), reference: 'ASS-1' });
  r = await mgr('POST', `${L}/compliance`, { subject: 'vehicle', vehicleId: veh, kind: 'inspection', expiresAt: day(20) });
  r = await mgr('POST', `${L}/compliance`, { subject: 'vehicle', vehicleId: veh, kind: 'license', expiresAt: day(20) });
  check('type d\'échéance incohérent avec le sujet refusé', r.status === 400, r.json);
  r = await mgr('POST', `${L}/compliance`, { subject: 'vehicle', vehicleId: veh, kind: 'tax', expiresAt: day(300) });
  r = await mem('GET', `${L}/compliance`);
  check('échéances lisibles par l\'équipe, avec état', r.status === 200 && r.json.items.find((c) => c.kind === 'insurance').state === 'critical' && r.json.items.find((c) => c.kind === 'inspection').state === 'soon' && r.json.items.find((c) => c.reference === 'P999').state === 'expired', r.json.items.map((c) => [c.kind, c.state]));
  r = await mgr('GET', `${O}/dashboard/alerts`);
  const al = r.json.alerts.filter((a) => a.module === 'logistics');
  check('alertes (insights) : assurance, visite technique, permis périmé', al.length === 3 && al.some((a) => /assurance/.test(a.text) && a.level === 'high') && al.some((a) => /visite technique/.test(a.text) && a.level === 'medium') && al.some((a) => /permis.*périmée/.test(a.text)), al);

  // Tournées : affectation
  r = await mgr('POST', `${L}/rounds`, { name: 'Tournée Nord', date: day(1), vehicleId: veh, driverId: drv2 });
  check('chauffeur au permis périmé refusé', r.status === 400 && /permis/.test(r.json.error), r.json);
  r = await mgr('POST', `${L}/rounds`, { name: 'Tournée Nord', date: day(1), vehicleId: veh, driverId: drv });
  const rd = r.json.id;
  check('tournée avec véhicule et chauffeur', r.status === 201, r.json);
  r = await mgr('POST', `${L}/rounds`, { name: 'Tournée Sud', date: day(1), vehicleId: veh });
  check('même véhicule le même jour -> 409', r.status === 409, r.json);
  r = await mgr('POST', `${L}/rounds`, { name: 'Tournée Sud', date: day(2), vehicleId: veh, driverId: drv });
  check('autre jour : possible', r.status === 201, r.json);
  r = await mgr('PUT', `${L}/vehicles/${veh}`, { status: 'maintenance' });
  r = await mgr('POST', `${L}/rounds`, { name: 'Tournée Est', date: day(3), vehicleId: veh });
  check('véhicule en maintenance non affectable', r.status === 400, r.json);
  await mgr('PUT', `${L}/vehicles/${veh}`, { status: 'active' });
  r = await mgr('GET', `${L}/rounds`);
  check('tournées avec véhicule et chauffeur', r.json.rounds.find((x) => x.id === rd).vehicle === 'LT-123-AB' && r.json.rounds.find((x) => x.id === rd).driver === 'Jean Chauffeur', r.json.rounds[0]);

  // Carburant
  r = await mem('POST', `${L}/fuel`, { vehicleId: veh, liters: 50, odometer: 1000, amount: 40000, date: day(-10) });
  check('un membre saisit un plein', r.status === 201, r.json);
  r = await mgr('POST', `${L}/fuel`, { vehicleId: veh, liters: 60, odometer: 1500, amount: 48000, date: day(-5), driverId: drv });
  check('consommation : 60 L / 500 km = 12 L/100', r.status === 201 && r.json.consumption === 12, r.json);
  r = await mgr('POST', `${L}/fuel`, { vehicleId: veh, liters: 10, odometer: 1400 });
  check('kilométrage décroissant refusé', r.status === 400, r.json);
  r = await mgr('POST', `${L}/fuel`, { vehicleId: veh, liters: 0, odometer: 1600 });
  check('litres nuls refusés', r.status === 400, r.json);
  r = await mgr('POST', `${L}/fuel`, { vehicleId: veh, liters: 40, odometer: 1900, amount: 32000, toBudget: true });
  r = await mgr('GET', `${L}/fleet`);
  const v = r.json.vehicles.find((x) => x.id === veh);
  check('parc : kilométrage 1 900, consommation moyenne = 100 L / 900 km ≈ 11,1', v.odometer === 1900 && Math.abs(v.avgConsumption - 11.1) < 0.05 && v.fuelLiters === 150, v);
  check('coût par km visible du responsable', v.costPerKm > 0, v.costPerKm);
  r = await mem('GET', `${L}/fleet`);
  check('un membre ne voit pas les coûts', r.json.vehicles[0].fuelSpent === undefined, r.json.vehicles[0]);
  r = await mgr('GET', `${O}/maintenance`);
  check('le compteur de l\'équipement lié suit le kilométrage', r.json.equipment.find((e) => e.id === eq).meter === 1900, r.json.equipment.find((e) => e.id === eq));
  r = await mgr('GET', `${O}/budget`);
  check('plein inscrit au budget sur demande', r.json.entries.some((e) => e.category === 'Carburant' && e.amount === 32000), r.json.entries.length);
  r = await mgr('DELETE', `${L}/vehicles/${veh}`);
  check('véhicule avec relevés : suppression refusée', r.status === 409, r.json);
  r = await other('GET', `/api/ws/orgs/${org}/logistics/fleet`);
  check('isolation : autre organisation -> 404', r.status === 404, r.status);
  r = await mgr('POST', `${O}/ai/chat`, { module: 'logistics', message: 'Parc ?' });
  check('IA logistique : route disponible', [200, 503].includes(r.status), r.status);
});
