'use strict';
// Maintenance : équipements du dépôt (chariot élévateur, groupe électrogène, pont-bascule, presse à pavés, camion), plans préventifs
// (jours, heures, km), interventions correctives signalées par le terrain et préventives issues des plans, pièces prélevées du stock.
const M = '/maintenance';

async function ensureItem(ctx, list, body) {
  const ex = list.find((i) => i.name === body.name);
  if (ex) return ex.id;
  return (await ctx.do(`Stock : créer l'article « ${body.name} »`, 'POST', '/stock/items', body, { as: 'manager' })).id;
}

module.exports = async function maintenance(ctx) {
  const O = ctx.ids.operations;
  const D = (n) => ctx.day(n);
  const keeper = ctx.ids.members.storekeeper && ctx.ids.members.storekeeper.userId;
  const items = (await ctx.do('Stock : liste des articles (pièces de rechange)', 'GET', '/stock')).items || [];
  O.items = {
    oil: await ensureItem(ctx, items, { name: 'Huile moteur 15W40 — bidon 20 L', unit: 'bidon', quantity: 14, unitCost: 38500, minQuantity: 4, sku: 'MNT-001', tracking: 'none' }),
    filter: await ensureItem(ctx, items, { name: 'Filtre à huile poids lourd', unit: 'pièce', quantity: 3, unitCost: 17500, minQuantity: 4, sku: 'MNT-002', tracking: 'none' }), // déjà sous le seuil : alerte de réapprovisionnement
    hose: await ensureItem(ctx, items, { name: 'Flexible hydraulique 1/2" — 1 m', unit: 'pièce', quantity: 6, unitCost: 12000, minQuantity: 2, sku: 'MNT-003', tracking: 'none' }),
  };

  // ---------- Équipements ----------
  const eq = {};
  const EQ = [
    ['forklift', { name: 'Chariot élévateur Toyota 8FD25 (2,5 t)', kind: 'machine', reference: 'TYT-8FD25-60311', location: 'Dépôt de Bonabéri — quai 1', purchasedAt: '2021-03-15', value: 18500000, meter: 6240, notes: 'Compteur en heures moteur.', branchId: ctx.ids.branches.douala }],
    ['genset', { name: 'Groupe électrogène SDMO 60 kVA du dépôt', kind: 'machine', reference: 'SDMO-J66K-1187', location: 'Dépôt de Bonabéri — local technique', purchasedAt: '2019-11-02', value: 14200000, meter: 11830, notes: 'Secours en cas de délestage ENEO.', branchId: ctx.ids.branches.douala }],
    ['scale', { name: 'Pont-bascule 60 t', kind: 'machine', reference: 'PB-60T-2018', location: 'Entrée du dépôt de Bonabéri', purchasedAt: '2018-06-20', value: 21000000, branchId: ctx.ids.branches.douala }],
    ['press', { name: 'Presse à pavés et hourdis QT4-25', kind: 'machine', reference: 'QT425-2023-044', location: 'Aire de fabrication — Bonabéri', purchasedAt: '2023-02-10', value: 27500000, meter: 2100, notes: 'Compteur en heures de production.', branchId: ctx.ids.branches.douala }],
    ['truck', { name: 'Camion Mercedes Axor LT 2318 A', kind: 'vehicle', reference: 'WDB9540321L987654', location: 'Parc camions Bonabéri', purchasedAt: '2020-09-01', value: 48000000, meter: 185800, branchId: ctx.ids.branches.douala }],
    ['warehouse', { name: 'Entrepôt couvert de Mvan', kind: 'building', location: 'Mvan, Yaoundé', purchasedAt: '2017-01-01', value: 95000000, branchId: ctx.ids.branches.yaounde }],
    ['pos', { name: 'Poste caisse et imprimante du comptoir', kind: 'it', reference: 'HP-PRODESK-400', location: 'Comptoir de vente Douala', purchasedAt: '2024-05-12', value: 650000 }],
    ['typo', { name: 'Bétonnière 350 L (doublon à supprimer)', kind: 'tool', location: 'Bonabéri' }],
  ];
  const have = (await ctx.do('Maintenance : tableau de bord', 'GET', M)).equipment || [];
  for (const [k, body] of EQ) {
    const ex = have.find((e) => e.name === body.name);
    eq[k] = ex ? ex.id : (await ctx.do(`Maintenance : ajouter l'équipement « ${body.name} »`, 'POST', `${M}/equipment`, body, { as: 'manager' })).id;
  }
  await ctx.do('Maintenance : modifier un équipement (valeur, emplacement)', 'PUT', `${M}/equipment/${eq.scale}`, { location: 'Entrée poids lourds du dépôt de Bonabéri', value: 19800000, notes: 'Étalonnage annuel obligatoire (métrologie).' }, { as: 'manager' });
  await ctx.do('Maintenance : supprimer un équipement saisi en double', 'DELETE', `${M}/equipment/${eq.typo}`, undefined, { as: 'manager' });
  delete eq.typo;
  if (ctx.users.storekeeper) await ctx.do('Maintenance : un membre ne peut pas ajouter d\'équipement (droits)', 'POST', `${M}/equipment`, { name: 'Essai', kind: 'tool' }, { as: 'storekeeper', expect: 403 });

  // ---------- Plans préventifs ----------
  const plans = {};
  const PL = [
    ['fkOil', { equipmentId: eq.forklift, task: 'Vidange moteur et filtres du chariot', periodKind: 'hours', periodValue: 250, lastMeter: 5980 }], // 6240 h : en retard
    ['fkCheck', { equipmentId: eq.forklift, task: 'Contrôle des fourches, chaînes et freins', periodKind: 'days', periodValue: 90, lastDoneAt: D(-84) }], // bientôt
    ['gsOil', { equipmentId: eq.genset, task: 'Vidange et filtres du groupe électrogène', periodKind: 'hours', periodValue: 500, lastMeter: 11500 }],
    ['scaleCal', { equipmentId: eq.scale, task: 'Étalonnage du pont-bascule (métrologie légale)', periodKind: 'days', periodValue: 365, lastDoneAt: D(-372) }], // en retard
    ['pressGrease', { equipmentId: eq.press, task: 'Graissage des moules et contrôle hydraulique', periodKind: 'hours', periodValue: 200, lastMeter: 2000 }],
    ['truckOil', { equipmentId: eq.truck, task: 'Vidange camion (10 000 km)', periodKind: 'km', periodValue: 10000, lastMeter: 175900 }], // les relevés de carburant feront avancer le compteur
    ['whFire', { equipmentId: eq.warehouse, task: 'Vérification des extincteurs', periodKind: 'days', periodValue: 180, lastDoneAt: D(-60) }],
    ['tmp', { equipmentId: eq.pos, task: 'Nettoyage imprimante (essai)', periodKind: 'days', periodValue: 30 }],
  ];
  const havePlans = (await ctx.do('Maintenance : liste des plans préventifs', 'GET', `${M}/plans`)).plans || [];
  for (const [k, body] of PL) {
    const ex = havePlans.find((p) => p.task === body.task && p.equipmentId === body.equipmentId);
    plans[k] = ex ? ex.id : (await ctx.do(`Maintenance : plan « ${body.task} »`, 'POST', `${M}/plans`, body, { as: 'manager' })).id;
  }
  await ctx.do('Maintenance : modifier la périodicité d\'un plan', 'PUT', `${M}/plans/${plans.gsOil}`, { periodValue: 400, task: 'Vidange et filtres du groupe électrogène (400 h, saison des pluies)' }, { as: 'manager' });
  await ctx.do('Maintenance : supprimer un plan', 'DELETE', `${M}/plans/${plans.tmp}`, undefined, { as: 'manager' });

  // ---------- Interventions ----------
  // Une panne signalée par le chef magasinier (membre) : corrective, l'équipement passe « en panne ».
  const fk = (await ctx.do('Maintenance : signaler une panne (membre)', 'POST', `${M}/orders`, { equipmentId: eq.forklift, title: 'Fuite d\'huile hydraulique sur le vérin de levée', description: 'Flaque sous le chariot ce matin, les fourches descendent seules en charge.', priority: 'urgent', openedAt: D(-3) }, { as: 'storekeeper' })).id;
  let dash = await ctx.do('Maintenance : tableau de bord (équipement en panne)', 'GET', M);
  ctx.check('Maintenance : le chariot signalé passe « en panne »', (dash.equipment || []).find((e) => e.id === eq.forklift)?.status === 'broken', (dash.equipment || []).find((e) => e.id === eq.forklift));
  await ctx.do('Maintenance : assigner l\'intervention au chef magasinier', 'PUT', `${M}/orders/${fk}`, { assigneeId: keeper, priority: 'urgent', contractor: '', notes: 'Chariot consigné, déchargements à la main en attendant.' }, { as: 'manager' });
  await ctx.do('Maintenance : démarrer l\'intervention (personne assignée)', 'POST', `${M}/orders/${fk}/start`, {}, { as: 'storekeeper' });
  const part = (await ctx.do('Maintenance : pièce prélevée du stock', 'POST', `${M}/orders/${fk}/parts`, { itemId: O.items.hose, quantity: 2 }, { as: 'storekeeper' })).id;
  await ctx.do('Maintenance : pièce achetée hors stock', 'POST', `${M}/orders/${fk}/parts`, { name: 'Kit joints de vérin Toyota', quantity: 1, unitCost: 45000 }, { as: 'storekeeper' });
  await ctx.do('Maintenance : pièce prise par erreur, remise en stock', 'DELETE', `${M}/orders/${fk}/parts/${part}`, undefined, { as: 'storekeeper' });
  await ctx.do('Maintenance : pièce prélevée du stock (bonne quantité)', 'POST', `${M}/orders/${fk}/parts`, { itemId: O.items.hose, quantity: 1 }, { as: 'storekeeper' });
  await ctx.do('Maintenance : détail de l\'intervention', 'GET', `${M}/orders/${fk}`, undefined, { as: 'storekeeper' });
  await ctx.do('Maintenance : clôturer (arrêt, main-d\'œuvre, compteur)', 'POST', `${M}/orders/${fk}/close`, { downtimeHours: 30, laborCost: 35000, meter: 6248, notes: 'Joints changés, flexible remplacé, essai en charge 2,5 t concluant.' }, { as: 'storekeeper' });

  // Panne du groupe électrogène en cours (sous-traitant), panne du poste caisse ouverte.
  const gs = (await ctx.do('Maintenance : panne du groupe électrogène', 'POST', `${M}/orders`, { equipmentId: eq.genset, kind: 'corrective', title: 'Le groupe ne démarre plus lors des délestages', description: 'Batterie à plat, démarreur qui claque.', priority: 'high', contractor: 'Électro Douala (dépannage)', openedAt: D(-1) }, { as: 'manager' })).id;
  await ctx.do('Maintenance : démarrer l\'intervention (sous-traitant)', 'POST', `${M}/orders/${gs}/start`, {}, { as: 'manager' });
  await ctx.do('Maintenance : pièce hors stock (batterie)', 'POST', `${M}/orders/${gs}/parts`, { name: 'Batterie 12 V 200 Ah', quantity: 1, unitCost: 165000 }, { as: 'manager' });
  await ctx.do('Maintenance : panne signalée au comptoir', 'POST', `${M}/orders`, { equipmentId: eq.pos, title: 'L\'imprimante de tickets bourre', priority: 'low' }, { as: 'seller' });
  const dup = (await ctx.do('Maintenance : intervention saisie en double', 'POST', `${M}/orders`, { equipmentId: eq.pos, title: 'Imprimante (doublon)', priority: 'low' }, { as: 'manager' })).id;
  await ctx.do('Maintenance : supprimer une intervention', 'DELETE', `${M}/orders/${dup}`, undefined, { as: 'manager' });

  // Préventives depuis les plans : la vidange du chariot (en retard) est faite, l'étalonnage du pont-bascule est planifié chez un prestataire.
  const pv = (await ctx.do('Maintenance : planifier l\'intervention d\'un plan', 'POST', `${M}/plans/${plans.fkOil}/order`, { priority: 'high', assigneeId: keeper }, { as: 'manager' })).id;
  await ctx.do('Maintenance : démarrer la vidange', 'POST', `${M}/orders/${pv}/start`, {}, { as: 'storekeeper' });
  await ctx.do('Maintenance : huile prélevée du stock', 'POST', `${M}/orders/${pv}/parts`, { itemId: O.items.oil, quantity: 1 }, { as: 'storekeeper' });
  await ctx.do('Maintenance : filtre prélevé du stock', 'POST', `${M}/orders/${pv}/parts`, { itemId: O.items.filter, quantity: 1 }, { as: 'storekeeper' });
  await ctx.do('Maintenance : clôturer la préventive (le plan est replanifié)', 'POST', `${M}/orders/${pv}/close`, { downtimeHours: 2, laborCost: 10000, meter: 6250 }, { as: 'storekeeper' });
  const pl = (await ctx.do('Maintenance : plans après la vidange', 'GET', `${M}/plans`)).plans || [];
  const fkp = pl.find((p) => p.id === plans.fkOil);
  ctx.check('Maintenance : vidange faite → prochaine échéance à 6 500 h', fkp && fkp.nextMeter === 6500 && fkp.state === 'ok', fkp);
  ctx.check('Maintenance : l\'étalonnage du pont-bascule est en retard (alerte)', pl.find((p) => p.id === plans.scaleCal)?.state === 'late', pl.find((p) => p.id === plans.scaleCal));
  await ctx.do('Maintenance : planifier l\'étalonnage chez un prestataire', 'POST', `${M}/plans/${plans.scaleCal}/order`, { priority: 'normal', contractor: 'Bureau de métrologie (prestataire agréé)' }, { as: 'manager' });

  await ctx.do('Maintenance : liste des interventions', 'GET', `${M}/orders`);
  await ctx.do('Maintenance : historique d\'un équipement', 'GET', `${M}/equipment/${eq.forklift}`, undefined, { as: 'manager' });
  dash = await ctx.do('Maintenance : tableau de bord (disponibilité, coûts, alertes)', 'GET', M, undefined, { as: 'manager' });
  ctx.check('Maintenance : indicateurs remplis (alertes, coût du mois, pannes)', dash.summary && dash.summary.monthCost > 0 && (dash.alerts || []).length > 0 && dash.summary.topBreakdowns.length > 0, dash.summary);
  O.equipment = eq; O.plans = plans;
};
module.exports.ensureItem = ensureItem;
