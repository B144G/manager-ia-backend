'use strict';
// Transport · géolocalisation et clients / fournisseurs typés : transporteurs positionnés autour de Douala (disponibles, absent, en mission),
// deux commandes à distance à organiser (l'une localisée, l'autre pas), types de clients et de fournisseurs avec leurs conditions.
const L = '/logistics';
const G = '/logistics/tms/geo';
const P = '/parties';

module.exports = async function geo(ctx) {
  const D = (n) => ctx.day(n);
  const fleet = await ctx.do('Géolocalisation : parc', 'GET', `${L}/fleet`);
  const vehicle = (plate) => (fleet.vehicles || []).find((v) => v.plate === plate);
  const driver = (name) => (fleet.drivers || []).find((d) => d.name === name);

  // ---------- Deux transporteurs de plus (une pick-up et une moto) ----------
  const addVeh = async (body) => (vehicle(body.plate) || { id: (await ctx.do(`Géolocalisation : véhicule ${body.plate}`, 'POST', `${L}/vehicles`, body, { as: 'manager' })).id }).id;
  const hilux = await addVeh({ plate: 'LT 3310 F', label: 'Toyota Hilux double cabine', kind: 'car', capacity: '800 kg', odometer: 52100, capacityKg: 800, capacityM3: 3, kmRate: 220, co2: 210, branchId: ctx.ids.branches.douala });
  const moto = await addVeh({ plate: 'LT 0880 M', label: 'Moto-cargo Bajaj', kind: 'car', capacity: '60 kg', odometer: 8800, capacityKg: 60, kmRate: 60, co2: 70, branchId: ctx.ids.branches.douala });
  const addDrv = async (name, phone, extra = {}) => (driver(name) || { id: (await ctx.do(`Géolocalisation : chauffeur ${name}`, 'POST', `${L}/drivers`, { name, phone, licenseNo: 'CM-' + name.length + '-2020', licenseCategory: 'B', dailyAllowance: 3000, ...extra }, { as: 'manager' })).id }).id;
  const moussa = await addDrv('Moussa Tagne', '+237 699 12 34 56');
  const paulin = await addDrv('Paulin Ewane', '+237 677 98 76 54', { dailyAllowance: 2000 });
  await ctx.do('Géolocalisation : réglages (position ancienne après 30 min)', 'PUT', `${G}/settings`, { staleMin: 30, lostMin: 240, retentionDays: 14 }, { as: 'owner', expect: [200, 403] });

  // ---------- Véhicules habituels, statut manuel, positions ----------
  const samuel = driver('Samuel Fotso'); const ibrahim = driver('Ibrahim Bello'); const joseph = driver('Joseph Mbarga');
  const plan = [
    [samuel, 'LT 7742 C', 4.0716, 9.663], [ibrahim, 'LT 2318 A', 4.0745, 9.6705], [joseph, 'CE 5521 D', 4.0322, 9.6968],
    [{ id: moussa }, null, 4.0521, 9.7051, hilux], [{ id: paulin }, null, 4.0935, 9.7380, moto],
  ];
  for (const [d, plate, la, ln, vid] of plan) {
    if (!d) continue;
    const v = vid || (plate && vehicle(plate) && vehicle(plate).id);
    if (v) await ctx.do('Géolocalisation : véhicule habituel', 'PUT', `${G}/drivers/${d.id}`, { vehicleId: v }, { as: 'manager' });
    await ctx.do('Géolocalisation : position saisie à la main', 'POST', `${G}/drivers/${d.id}/position`, { lat: la, lng: ln }, { as: 'manager' });
  }
  if (ibrahim) await ctx.do('Géolocalisation : Ibrahim marqué absent (congé)', 'PUT', `${G}/drivers/${ibrahim.id}`, { manualState: 'absent', manualReason: 'Congé jusqu\'à lundi' }, { as: 'manager' });
  // Samuel : accord, service et position envoyée depuis son téléphone
  if (ctx.users.driver) {
    await ctx.do('Géolocalisation : Samuel donne son accord', 'POST', `${G}/me/consent`, { granted: true }, { as: 'driver' });
    await ctx.do('Géolocalisation : Samuel commence son service', 'POST', `${G}/me/shift`, { on: true }, { as: 'driver' });
    await ctx.do('Géolocalisation : Samuel envoie sa position', 'POST', `${G}/me/position`, { lat: 4.0716, lng: 9.663, accuracy: 18 }, { as: 'driver', expect: [200, 403] });
  }

  // ---------- Deux commandes à distance à organiser ----------
  const mk = async (body) => (await ctx.do(`Géolocalisation : livraison « ${body.customerName} »`, 'POST', `${L}/deliveries`, { plannedDate: D(0), ...body }, { as: 'manager' })).id;
  const d1 = await mk({ customerName: 'Mme Ngo Bayiha (commande WhatsApp)', phone: '+237 690 11 22 33', address: 'Bonapriso, rue des Palmiers, Douala', weight: 120, volume: 0.6 });
  await ctx.do('Géolocalisation : position du client posée sur la carte', 'PUT', `${G}/deliveries/${d1}/location`, { lat: 4.0345, lng: 9.7032, source: 'pin', address: 'Bonapriso, rue des Palmiers, Douala' }, { as: 'manager' });
  await mk({ customerName: 'M. Eyenga (achat à distance)', phone: '+237 677 55 66 77', address: 'Makepe, près du carrefour Shell', weight: 45 });

  // ---------- Clients et fournisseurs typés ----------
  const cs = ((await ctx.do('Clients typés : liste', 'GET', `${P}/customers?limit=50`, undefined, { as: 'manager' })).items || []);
  const types = ['vip', 'permanent', 'temporary', 'vip', 'permanent'];
  const spots = [[4.0485, 9.7015], [4.031, 9.695], [4.0939, 9.7378], [4.079, 9.765], [4.075, 9.672]];
  await ctx.do('Clients typés : conditions du type haut de gamme', 'PUT', `${P}/terms/customers/vip`, { discountPct: 10, paymentDays: 45, deliveryDays: 1, creditLimit: 5000000, note: 'Livraison prioritaire, interlocuteur dédié.' }, { as: 'manager' });
  await ctx.do('Clients typés : conditions du type permanent', 'PUT', `${P}/terms/customers/permanent`, { discountPct: 5, paymentDays: 30 }, { as: 'manager' });
  await ctx.do('Clients typés : conditions du type temporaire', 'PUT', `${P}/terms/customers/temporary`, { paymentDays: 0, deliveryDays: 3 }, { as: 'manager' });
  for (const [i, c] of cs.slice(0, 5).entries()) {
    await ctx.do(`Clients typés : « ${c.name} » → ${types[i]}`, 'POST', `${P}/customers/${c.id}/type`, { type: types[i], validUntil: types[i] === 'temporary' ? D(45) : undefined, reason: types[i] === 'vip' ? 'Gros volume annuel' : types[i] === 'permanent' ? 'Contrat de fourniture signé' : 'Chantier de six semaines' }, { as: 'manager', expect: [200, 400] });
    await ctx.do('Clients typés : adresse géolocalisée', 'POST', `${P}/customers/${c.id}/location`, { lat: spots[i][0], lng: spots[i][1], source: 'pin' }, { as: 'manager' });
    await ctx.do('Clients typés : étiquettes', 'PUT', `${P}/customers/${c.id}`, { tags: i % 2 ? 'chantier, douala' : 'grossiste, douala' }, { as: 'manager' });
  }
  const ss = ((await ctx.do('Fournisseurs typés : liste', 'GET', `${P}/suppliers?limit=50`, undefined, { as: 'manager' })).items || []);
  await ctx.do('Fournisseurs typés : conditions du type haut de gamme', 'PUT', `${P}/terms/suppliers/vip`, { paymentDays: 60, discountPct: 3, note: 'Fournisseur stratégique.' }, { as: 'manager' });
  for (const [i, s] of ss.slice(0, 4).entries()) {
    const t = ['vip', 'permanent', 'temporary', 'permanent'][i];
    await ctx.do(`Fournisseurs typés : « ${s.name} » → ${t}`, 'POST', `${P}/suppliers/${s.id}/type`, { type: t, validUntil: t === 'temporary' ? D(30) : undefined, reason: 'Classement initial' }, { as: 'manager', expect: [200, 400] });
  }
  const chk = await ctx.do('Clients typés : compteurs par type', 'GET', `${P}/types`, undefined, { as: 'manager' });
  ctx.check('Clients typés : au moins un client haut de gamme', chk.counts && chk.counts.customers && chk.counts.customers.vip >= 1, chk.counts);
};
