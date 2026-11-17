'use strict';
// Démonstration — Entrepôt (WMS), 3/3 : analyses (ABC, inventaire tournant, écarts, prévisions, réapprovisionnement), états et exports CSV
// (valorisation, rotation, ruptures, vieillissement, journal des mouvements), optimisation des emplacements, productivité des magasiniers,
// cour et quais (rendez-vous transporteurs), tableau de bord en temps réel, scan universel.
module.exports = async function pilot(ctx) {
  const I = ctx.ids.items; const st = ctx.ids.stock; const L = st.locations;
  // Les refus de droits (403) ne se montrent que si la personne a son propre compte (démo locale) ; sinon l'appel partirait au nom du dirigeant.
  const D = (f, m, u, b, o = {}) => (o.as && !ctx.users[o.as] && [].concat(o.expect || []).includes(403) ? Promise.resolve({}) : ctx.do(f, m, u, b, o));
  const get = (f, u, as = 'manager') => D(f, 'GET', u, undefined, { as });
  const W = '/stock/wms';
  const iso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();
  let r;

  // ---------- Classement ABC, inventaire tournant ----------
  r = await get('Entrepôt : classement ABC (part de la consommation)', `${W}/abc`);
  ctx.check('Entrepôt : classes A, B, C', (r.classes || []).length === 3 && (r.items || []).some((i) => i.class === 'A'), r.classes);
  r = await get('Entrepôt : plan d\'inventaire tournant (prochains comptages)', `${W}/cycle-counts/plan`);
  ctx.check('Entrepôt : tout est compté, prochains comptages planifiés', (r.classes || []).length === 3, r.classes);
  await D('Entrepôt : inventaire tournant inutile (tout est à jour)', 'POST', `${W}/cycle-counts`, { classes: ['A'] }, { as: 'manager', expect: 400 });
  r = await get('Entrepôt : précision d\'inventaire et écarts par classe', `${W}/cycle-counts/variance`);
  ctx.check('Entrepôt : écarts valorisés', r.netValue < 0, r.netValue);

  // ---------- Une rupture : tout le sable part sur le chantier Sogea ----------
  const sable = ((await get('Stock : niveau du sable', `${W}/items/${I.sable}/availability`, 'storekeeper')).available) || 0;
  if (sable > 0) await D('Stock : sortie de tout le sable (rupture)', 'POST', `/stock/items/${I.sable}/move`, { kind: 'out', quantity: sable, reason: 'Chantier Sogea — fondations' }, { as: 'storekeeper' });

  // ---------- Prévisions et réapprovisionnement ----------
  r = await get('Entrepôt : prévisions de consommation (12 semaines)', `${W}/forecast`);
  ctx.check('Entrepôt : prévisions calculées', (r.items || []).some((i) => i.avgWeekly > 0), (r.items || []).length);
  r = await get('Entrepôt : suggestions de commande (point de commande, stock de sécurité)', `${W}/reorder`);
  ctx.check('Entrepôt : au moins une suggestion de commande', (r.suggestions || []).length >= 1, r.suggestions);

  // ---------- États et exports ----------
  r = await get('Entrepôt : valorisation du stock par emplacement', `${W}/reports/valuation`);
  ctx.check('Entrepôt : valeur totale du stock', r.totalValue > 10000000, r.totalValue);
  for (const [path, name] of [['valuation', 'valorisation'], ['rotation', 'rotation'], ['stockouts', 'ruptures'], ['aging', 'vieillissement'], ['moves', 'journal des mouvements']]) {
    r = await D(`Entrepôt : export CSV — ${name}`, 'GET', `${W}/reports/${path}?format=csv`, undefined, { as: 'manager', raw: true });
    ctx.check(`Entrepôt : fichier CSV ${name}`, r.status === 200 && /text\/csv/.test(r.headers.get('content-type') || ''), r.status);
  }
  await get('Entrepôt : rotation des articles', `${W}/reports/rotation`);
  r = await get('Entrepôt : ruptures et articles sous le seuil (magasinier)', `${W}/reports/stockouts`, 'storekeeper');
  ctx.check('Entrepôt : rupture du sable signalée', (r.items || []).some((i) => i.itemId === I.sable && i.kind === 'out'), r.items);
  await get('Entrepôt : vieillissement du stock', `${W}/reports/aging`);
  await get('Entrepôt : journal des mouvements', `${W}/reports/moves?limit=100`, 'storekeeper');
  await get('Entrepôt : journal — déplacements internes', `${W}/reports/moves?kind=internal&limit=50`);
  await D('Entrepôt : la valorisation est réservée aux responsables', 'GET', `${W}/reports/valuation`, undefined, { as: 'storekeeper', expect: 403 });

  // ---------- Optimisation des emplacements ----------
  await get('Entrepôt : réglages d\'optimisation', `${W}/slotting/config`, 'storekeeper');
  await D('Entrepôt : distances (5 m entre allées, 1,5 m entre rayons, lourd ≥ 25 kg au sol)', 'PUT', `${W}/slotting/config`, { slotDays: 90, aislePitch: 5, rackPitch: 1.5, heavyKg: 25, heavyMaxLevel: 0, aisleDistances: { P: 2 } }, { as: 'manager' });
  await D('Entrepôt : distance de la zone de préparation', 'PUT', `${W}/slotting/zones/${st.zones.prep}`, { distance: 3 }, { as: 'manager' });
  for (const [code, level] of [['A-01-01', 0], ['A-01-02', 1], ['A-02-01', 0], ['A-02-02', 2], ['B-01-01', 0], ['B-03-01', 2], ['C-01-01', 0], ['C-01-02', 1]]) await D(`Entrepôt : niveau de l'emplacement ${code}`, 'PUT', `${W}/slotting/locations/${L[code]}`, { level }, { as: 'manager' });
  await D('Entrepôt : distance saisie pour le quai', 'PUT', `${W}/slotting/locations/${L['QUAI-REC']}`, { distance: 1 }, { as: 'manager' });
  await D('Entrepôt : poids du sac de ciment (50 kg)', 'PUT', `${W}/slotting/items/${I.ciment}`, { weightKg: 50 }, { as: 'manager' });
  await D('Entrepôt : poids de la barre HA 10 (9 kg)', 'PUT', `${W}/slotting/items/${I.fer10}`, { weightKg: 9 }, { as: 'manager' });
  await D('Entrepôt : poids du groupe électrogène (180 kg)', 'PUT', `${W}/slotting/items/${I.groupe}`, { weightKg: 180 }, { as: 'manager' });
  await get('Entrepôt : distances des emplacements', `${W}/slotting/locations`, 'storekeeper');
  r = await get('Entrepôt : analyse — fréquence de prélèvement, articles lourds, gain de parcours', `${W}/slotting/analysis`);
  ctx.check('Entrepôt : analyse des emplacements', Array.isArray(r.items) && r.totals, r.totals);
  r = await D('Entrepôt : créer les tâches de déplacement proposées', 'POST', `${W}/slotting/tasks`, {}, { as: 'manager' });
  const sl = (await get('Entrepôt : tâches d\'optimisation à faire', `${W}/slotting/tasks`, 'storekeeper')).tasks || [];
  if (sl[0]) await D(`Entrepôt : déplacement d'optimisation ${sl[0].code} scanné`, 'POST', `${W}/slotting/tasks/${sl[0].id}/confirm`, { fromLocationCode: sl[0].from, toLocationCode: sl[0].to }, { as: 'storekeeper' });
  if (sl[1]) await D(`Entrepôt : annuler la tâche ${sl[1].code}`, 'POST', `${W}/slotting/tasks/${sl[1].id}/cancel`, {}, { as: 'manager' });
  ctx.check('Entrepôt : au moins deux propositions de déplacement', sl.length >= 2, r);
  st.slottingCode = sl[0] && sl[0].code;
  await get('Entrepôt : tâches d\'optimisation faites', `${W}/slotting/tasks?status=done`);

  // ---------- Cour et quais ----------
  r = await D('Entrepôt : quai Q1 (réception)', 'POST', `${W}/yard/docks`, { code: 'Q1', name: 'Porte 1 — réception', direction: 'inbound', locationId: L['QUAI-REC'] }, { as: 'manager' });
  const q1 = r.id;
  r = await D('Entrepôt : quai Q2 (expédition)', 'POST', `${W}/yard/docks`, { code: 'Q2', name: 'Porte 2 — expédition', direction: 'outbound', locationId: L['QUAI-EXP'] }, { as: 'manager' });
  const q2 = r.id;
  r = await D('Entrepôt : quai Q3 (mixte, Yaoundé)', 'POST', `${W}/yard/docks`, { code: 'Q3', name: 'Porte Mvan', direction: 'both', warehouseId: st.warehouses.yaounde }, { as: 'manager' });
  await D('Entrepôt : renommer le quai Q3', 'PUT', `${W}/yard/docks/${r.id}`, { name: 'Porte unique — Mvan' }, { as: 'manager' });
  const q4 = (await D('Entrepôt : quai provisoire', 'POST', `${W}/yard/docks`, { code: 'Q9', name: 'Portail arrière' }, { as: 'manager' })).id;
  await D('Entrepôt : supprimer le quai provisoire', 'DELETE', `${W}/yard/docks/${q4}`, undefined, { as: 'manager' });
  await D('Entrepôt : un magasinier ne crée pas de quai', 'POST', `${W}/yard/docks`, { code: 'QX' }, { as: 'storekeeper', expect: 403 });
  await get('Entrepôt : quais', `${W}/yard/docks`, 'storekeeper');
  await get('Entrepôt : réglages de la cour', `${W}/yard/config`, 'storekeeper');
  await D('Entrepôt : quais ouverts 11 h par jour, tolérance 15 min', 'PUT', `${W}/yard/config`, { hoursPerDay: 11, tolerance: 15, waitAlert: 30 }, { as: 'manager' });
  const appt = async (f, b) => (await D(`Entrepôt : rendez-vous — ${f}`, 'POST', `${W}/yard/appointments`, b, { as: 'manager' })).id;
  const a1 = await appt('camion Alucam (tôles en retard)', { direction: 'inbound', dockId: q1, slotStart: iso(-150), slotEnd: iso(-90), carrierName: 'Alucam Transport', plate: 'lt 4471 ac', driver: 'Ibrahim Moussa', driverPhone: '+237 690 11 22 33', poId: st.poLate, note: 'Livraison des 200 tôles attendues depuis 8 jours' });
  const a2 = await appt('camion Dangote (ciment)', { direction: 'inbound', dockId: q1, slotStart: iso(-60), slotEnd: iso(0), carrierName: 'Dangote Logistics', plate: 'CE 882 BK', poId: st.poCiment });
  const a3 = await appt('enlèvement Hôtel La Falaise', { direction: 'outbound', dockId: q2, slotStart: iso(-45), slotEnd: iso(15), carrierName: 'Transports Ngando & Fils', shipmentId: st.lateShipment });
  const a4 = await appt('camion Électro Douala', { direction: 'inbound', dockId: q1, slotStart: iso(60), slotEnd: iso(120), carrierName: 'Électro Douala' });
  const a5 = await appt('enlèvement Sogea (ne viendra pas)', { direction: 'outbound', dockId: q2, slotStart: iso(-240), slotEnd: iso(-180), carrierName: 'Sogea Satom' });
  const a6 = await appt('livraison carrière (reportée)', { direction: 'inbound', slotStart: iso(180), slotEnd: iso(240), carrierName: 'Carrière de Nkometou' });
  await D('Entrepôt : créneau qui chevauche sur le même quai refusé', 'POST', `${W}/yard/appointments`, { direction: 'inbound', dockId: q1, slotStart: iso(70), slotEnd: iso(110) }, { as: 'manager', expect: 409 });
  await D('Entrepôt : déplacer le créneau Électro Douala', 'PUT', `${W}/yard/appointments/${a4}`, { slotStart: iso(130), slotEnd: iso(190), driver: 'Serge Mbappé' }, { as: 'manager' });
  await D('Entrepôt : arrivée au portail du camion Alucam (en retard)', 'POST', `${W}/yard/appointments/${a1}/arrive`, { plate: 'LT 4471 AC', driver: 'Ibrahim Moussa' }, { as: 'storekeeper' });
  await D('Entrepôt : mise à quai du camion Alucam', 'POST', `${W}/yard/appointments/${a1}/dock`, {}, { as: 'storekeeper' });
  await D('Entrepôt : départ du camion Alucam', 'POST', `${W}/yard/appointments/${a1}/depart`, {}, { as: 'storekeeper' });
  await D('Entrepôt : arrivée du camion Dangote', 'POST', `${W}/yard/appointments/${a2}/arrive`, {}, { as: 'storekeeper' });
  await D('Entrepôt : arrivée du camion Ngando', 'POST', `${W}/yard/appointments/${a3}/arrive`, { driver: 'Joseph Ngando' }, { as: 'storekeeper' });
  await D('Entrepôt : mise à quai Q2 (l\'expédition prend le quai)', 'POST', `${W}/yard/appointments/${a3}/dock`, { dockId: q2 }, { as: 'storekeeper' });
  await D('Entrepôt : mise à quai avant l\'arrivée refusée', 'POST', `${W}/yard/appointments/${a4}/dock`, {}, { as: 'storekeeper', expect: 400 });
  await D('Entrepôt : rendez-vous Sogea noté « pas venu »', 'POST', `${W}/yard/appointments/${a5}/cancel`, { noShow: true }, { as: 'manager' });
  await D('Entrepôt : annuler la livraison de la carrière', 'POST', `${W}/yard/appointments/${a6}/cancel`, { reason: 'Pluies : piste impraticable' }, { as: 'manager' });
  r = await get('Entrepôt : à la cour maintenant', `${W}/yard/now`, 'storekeeper');
  ctx.check('Entrepôt : camions à la cour', (r.appointments || []).length >= 2, r.appointments);
  await get('Entrepôt : rendez-vous à venir', `${W}/yard/appointments`, 'storekeeper');
  r = await get('Entrepôt : détail du rendez-vous Alucam', `${W}/yard/appointments/${a1}`, 'storekeeper');
  st.appointmentCode = r.appointment && r.appointment.code;
  r = await get('Entrepôt : indicateurs de la cour (ponctualité, attente, occupation)', `${W}/yard/kpis?from=${ctx.day(-1)}&to=${ctx.day(0)}`);
  ctx.check('Entrepôt : rendez-vous comptés, un « pas venu »', r.appointments >= 4 && r.noShows === 1, r);
  await get('Entrepôt : calendrier des quais du jour', `${W}/yard/calendar?date=${ctx.day(0)}`, 'storekeeper');

  // ---------- Productivité ----------
  await get('Entrepôt : types de tâches mesurées', `${W}/labor/tasks`, 'storekeeper');
  await get('Entrepôt : standards de temps', `${W}/labor/standards`, 'storekeeper');
  await D('Entrepôt : standards — prélèvement 45 s, inactivité 15 min', 'PUT', `${W}/labor/standards`, { standards: { pick: 45, putaway: 80 }, idleMinutes: 15, minLines: 3 }, { as: 'manager' });
  await D('Entrepôt : standard nul refusé', 'PUT', `${W}/labor/standards`, { standards: { pick: 0 } }, { as: 'manager', expect: 400 });
  r = await get('Entrepôt : productivité de l\'équipe (lignes / heure, performance)', `${W}/labor/summary?from=${ctx.day(-7)}&to=${ctx.day(0)}`);
  ctx.check('Entrepôt : opérations du magasinier mesurées', r.totals && r.totals.lines > 10, r.totals);
  await get('Entrepôt : classement des magasiniers', `${W}/labor/leaderboard?from=${ctx.day(-7)}&to=${ctx.day(0)}&minLines=1`);
  await get('Entrepôt : classement anonyme', `${W}/labor/leaderboard?from=${ctx.day(-7)}&to=${ctx.day(0)}&minLines=1&anonymous=1`);
  await D('Entrepôt : le classement est réservé aux responsables', 'GET', `${W}/labor/leaderboard`, undefined, { as: 'storekeeper', expect: 403 });
  await get('Entrepôt : mes chiffres (magasinier)', `${W}/labor/me?from=${ctx.day(0)}&to=${ctx.day(0)}`, 'storekeeper');

  // ---------- Tableau de bord temps réel ----------
  r = await get('Entrepôt : tableau de bord en temps réel (responsable)', `${W}/dashboard/live`);
  ctx.check('Entrepôt : tableau de bord rempli (zones, quais, productivité)', (r.zones || []).length >= 3 && r.productivity && r.yard, { zones: (r.zones || []).length, alerts: r.alerts });
  ctx.check('Entrepôt : expédition en retard signalée', r.shipments && r.shipments.late >= 1, r.shipments);
  await get('Entrepôt : tableau de bord (magasinier)', `${W}/dashboard/live`, 'storekeeper');

  // ---------- Scan universel ----------
  const scan = async (f, code, type) => {
    const x = await D(`Entrepôt : scan — ${f}`, 'GET', `${W}/scan?code=${encodeURIComponent(code || '')}`, undefined, { as: 'storekeeper' });
    ctx.check(`Entrepôt : scan reconnu (${f})`, x.type === type, x);
  };
  await scan('article (SKU)', 'BTM-001', 'item');
  await scan('emplacement', 'a-01-01', 'location');
  const hu = (await get('Entrepôt : palette de tôles', `${W}/hus/${st.hus.tolePallet}`, 'storekeeper')).hu || {};
  await scan('palette', hu.code, 'hu');
  await scan('vague', st.waveCode, 'wave');
  await scan('expédition', st.shipmentCode, 'shipment');
  if (st.appointmentCode) await scan('rendez-vous', st.appointmentCode, 'appointment');
  if (st.slottingCode) await scan('tâche d\'optimisation', st.slottingCode, 'slotting');
  const picks = (await get('Entrepôt : listes de préparation', `${W}/picks`, 'storekeeper')).picks || [];
  if (picks[0]) await scan('liste de préparation', picks[0].code, 'pick');
  await D('Entrepôt : scan d\'un code inconnu', 'GET', `${W}/scan?code=XYZ-000`, undefined, { as: 'storekeeper', expect: 404 });

  // ---------- Bilan du stock ----------
  r = await get('Stock : bilan final (alertes, valeur, réservé)', '/stock');
  ctx.check('Stock : ruptures et péremptions visibles au tableau', r.summary && r.summary.out >= 1 && r.summary.low >= 1 && r.summary.expired >= 1, r.summary);
  r = await get('Entrepôt : vue d\'ensemble des deux dépôts', `${W}/overview`);
  if (ctx.users.storekeeper) ctx.check('Entrepôt : Douala et Yaoundé ont du stock', (r.warehouses || []).filter((w) => w.quantity > 0).length >= 2, (r.warehouses || []).map((w) => [w.name, w.quantity]));
};
