'use strict';
// Démonstration — Entrepôt (WMS), 2/3 : services à valeur ajoutée, préparations (picking au scan), vague de préparation, poste d'emballage,
// expéditions (quai, chargement au scan, bon de livraison), réapprovisionnement interne des emplacements de préparation,
// transbordement (planifié sur un bon de commande et opportuniste à la réception), kits (assemblage, désassemblage).
module.exports = async function outbound(ctx) {
  const I = ctx.ids.items; const S = ctx.ids.suppliers; const st = ctx.ids.stock;
  // Les refus de droits (403) ne se montrent que si la personne a son propre compte (démo locale) ; sinon l'appel partirait au nom du dirigeant.
  const D = (f, m, u, b, o = {}) => (o.as && !ctx.users[o.as] && [].concat(o.expect || []).includes(403) ? Promise.resolve({}) : ctx.do(f, m, u, b, o));
  const get = (f, u, as = 'manager') => D(f, 'GET', u, undefined, { as });
  const W = '/stock/wms';
  const docs = st.documents || {};
  const SKU = { ciment: 'BTM-001', fer10: 'BTM-002', fer12: 'BTM-003', tole: 'BTM-004', peinture: 'BTM-005', carreau: 'BTM-006', parpaing: 'BTM-007', tuyau: 'BTM-010', cable: 'BTM-011', groupe: 'BTM-012', brouette: 'BTM-013', fer8: 'BTM-014' };
  const keyOf = Object.fromEntries(Object.entries(I).map(([k, v]) => [v, k]));
  const storekeeper = ctx.ids.members.storekeeper && ctx.ids.members.storekeeper.userId;
  let r;

  // ---------- Services à valeur ajoutée (types et règles) ----------
  const vt = async (b) => (await D(`Entrepôt : type de service « ${b.name} »`, 'POST', `${W}/vas/types`, b, { as: 'manager' })).id;
  const tLabel = await vt({ name: 'Étiquetage prix magasin', category: 'labeling', unitCost: 50, costBasis: 'unit', minutes: 1, mandatory: true, instructions: 'Étiquette prix et code-barres sur chaque brouette.' });
  const tCtrl = await vt({ name: 'Contrôle final avant départ', category: 'control', unitCost: 1500, costBasis: 'task', minutes: 10, mandatory: true, instructions: 'Vérifier quantités, état des colis et bon de livraison.' });
  const tFilm = await vt({ name: 'Filmage et cerclage palette', category: 'repack', unitCost: 2500, costBasis: 'task', minutes: 15 });
  const tOld = await vt({ name: 'Emballage cadeau (obsolète)', category: 'giftwrap', unitCost: 500 });
  await D('Entrepôt : un magasinier ne crée pas de type de service', 'POST', `${W}/vas/types`, { name: 'Pirate' }, { as: 'storekeeper', expect: 403 });
  await D('Entrepôt : modifier un type de service (coût)', 'PUT', `${W}/vas/types/${tFilm}`, { unitCost: 3000, instructions: 'Film étirable 23 µ + 2 feuillards.' }, { as: 'manager' });
  await D('Entrepôt : supprimer un type de service inutilisé', 'DELETE', `${W}/vas/types/${tOld}`, undefined, { as: 'manager' });
  await D('Entrepôt : règle — étiqueter toute brouette préparée', 'POST', `${W}/vas/rules`, { typeId: tLabel, applies: 'pick', itemId: I.brouette }, { as: 'manager' });
  await D('Entrepôt : règle — contrôle final de toute expédition', 'POST', `${W}/vas/rules`, { typeId: tCtrl, applies: 'shipment' }, { as: 'manager' });
  r = await D('Entrepôt : règle — filmage des réceptions (à retirer)', 'POST', `${W}/vas/rules`, { typeId: tFilm, applies: 'receipt' }, { as: 'manager' });
  await D('Entrepôt : supprimer la règle de filmage', 'DELETE', `${W}/vas/rules/${r.id}`, undefined, { as: 'manager' });
  await get('Entrepôt : règles des services', `${W}/vas/rules`);
  await get('Entrepôt : types de service (sans coût pour le magasinier)', `${W}/vas/types`, 'storekeeper');

  // ---------- Préparation d'une commande au scan ----------
  r = await D('Entrepôt : liste de préparation de la commande Sogea (prioritaire)', 'POST', `${W}/picks`, { documentId: docs.sogea, priority: 1, assignedTo: storekeeper }, { as: 'manager' });
  const pSogea = r.id;
  await D('Entrepôt : un magasinier ne crée pas de liste', 'POST', `${W}/picks`, { lines: [{ itemId: I.ciment, quantity: 1 }] }, { as: 'storekeeper', expect: 403 });
  const pickLines = async (id) => (((await get('Entrepôt : liste de préparation (tournée par emplacement)', `${W}/picks/${id}`, 'storekeeper')).pick) || {}).lines || [];
  let pl = await pickLines(pSogea);
  ctx.check('Entrepôt : lignes avec emplacement', pl.length >= 3 && pl.every((l) => l.location), pl);
  if (pl[0]) await D('Entrepôt : scan du mauvais article refusé', 'POST', `${W}/picks/${pSogea}/lines/${pl[0].id}/confirm`, { itemCode: 'BTM-013' }, { as: 'storekeeper', expect: 400 });
  for (const l of pl) await D(`Entrepôt : prélèvement scanné (${keyOf[l.itemId]} en ${l.location})`, 'POST', `${W}/picks/${pSogea}/lines/${l.id}/confirm`, { itemCode: SKU[keyOf[l.itemId]], locationCode: l.location }, { as: 'storekeeper' });
  await D('Entrepôt : terminer la préparation Sogea', 'POST', `${W}/picks/${pSogea}/complete`, {}, { as: 'storekeeper' });
  await D('Entrepôt : la sortie de stock est réservée aux responsables', 'POST', `${W}/picks/${pSogea}/issue`, {}, { as: 'storekeeper', expect: 403 });
  await D('Entrepôt : sortie de stock de la liste Sogea', 'POST', `${W}/picks/${pSogea}/issue`, {}, { as: 'manager' });
  r = await D('Entrepôt : vente comptoir (liste sans commande)', 'POST', `${W}/picks`, { label: 'Vente comptoir — M. Fouda, Bépanda', lines: [{ itemId: I.ciment, quantity: 15 }, { itemId: I.cable, quantity: 2 }] }, { as: 'manager' });
  const pCpt = r.id;
  pl = await pickLines(pCpt);
  await D('Entrepôt : prélèvement partiel (un seul article)', 'POST', `${W}/picks/${pCpt}/lines/${pl[0] && pl[0].id}/confirm`, { quantity: pl[0] && pl[0].quantity }, { as: 'storekeeper' });
  await D('Entrepôt : terminer avec une ligne ouverte demande confirmation', 'POST', `${W}/picks/${pCpt}/complete`, { allowShort: false }, { as: 'storekeeper', expect: 409 });
  await D('Entrepôt : terminer quand même (client parti avec le ciment)', 'POST', `${W}/picks/${pCpt}/complete`, { allowShort: true }, { as: 'storekeeper' });
  await D('Entrepôt : sortie de la vente comptoir', 'POST', `${W}/picks/${pCpt}/issue`, {}, { as: 'manager' });
  r = await D('Entrepôt : liste pour M. Etoundi (annulée ensuite)', 'POST', `${W}/picks`, { documentId: docs.particulier }, { as: 'manager' });
  await D('Entrepôt : annuler la liste (client a reporté)', 'POST', `${W}/picks/${r.id}/cancel`, {}, { as: 'manager' });

  // ---------- Vague de préparation : Akwa / Bonanjo ----------
  const pBati = (await D('Entrepôt : liste de préparation Bâti Plus', 'POST', `${W}/picks`, { documentId: docs.bati }, { as: 'manager' })).id;
  const pQuinc = (await D('Entrepôt : liste de préparation Quincaillerie du Wouri', 'POST', `${W}/picks`, { documentId: docs.quinc }, { as: 'manager' })).id;
  const pHotel = (await D('Entrepôt : liste de préparation Hôtel La Falaise', 'POST', `${W}/picks`, { documentId: docs.hotel, priority: 3 }, { as: 'manager' })).id;
  r = await get('Entrepôt : listes regroupables en vague', `${W}/waves/candidates`);
  ctx.check('Entrepôt : 3 listes candidates', [pBati, pQuinc, pHotel].every((id) => (r.picks || []).some((p) => p.id === id)), r.picks);
  await D('Entrepôt : un magasinier ne crée pas de vague', 'POST', `${W}/waves`, { pickIds: [pBati] }, { as: 'storekeeper', expect: 403 });
  r = await D('Entrepôt : créer la vague « Tournée Akwa – Bonanjo »', 'POST', `${W}/waves`, { pickIds: [pBati, pQuinc, pHotel], label: 'Tournée Akwa – Bonanjo', assignedTo: storekeeper }, { as: 'manager' });
  const wave = r.id; st.waveCode = r.code;
  await D('Entrepôt : retirer l\'hôtel de la vague (livraison décalée)', 'DELETE', `${W}/waves/${wave}/picks/${pHotel}`, undefined, { as: 'manager' });
  await D('Entrepôt : remettre l\'hôtel dans la vague', 'POST', `${W}/waves/${wave}/picks`, { pickIds: [pHotel] }, { as: 'manager' });
  await D('Entrepôt : renommer la vague', 'PUT', `${W}/waves/${wave}`, { label: 'Tournée Akwa – Bonanjo (camion 1)', assignedTo: storekeeper }, { as: 'manager' });
  await D('Entrepôt : prélèvement refusé avant le lancement', 'POST', `${W}/waves/${wave}/confirm`, { itemId: I.tole, locationId: st.locations['A-03-01'] }, { as: 'storekeeper', expect: [400, 404] });
  await D('Entrepôt : lancer la vague', 'POST', `${W}/waves/${wave}/release`, {}, { as: 'manager' });
  r = await get('Entrepôt : parcours consolidé de la vague', `${W}/waves/${wave}`, 'storekeeper');
  const route = (r.wave || {}).route || [];
  ctx.check('Entrepôt : parcours en serpentin', route.length >= 5, route.map((s) => s.location));
  for (const s of route) {
    await D(`Entrepôt : vague — prélever ${s.quantity} ${keyOf[s.itemId]} en ${s.location}`, 'POST', `${W}/waves/${wave}/confirm`, { locationId: s.locationId, itemId: s.itemId, locationCode: s.location, itemCode: SKU[keyOf[s.itemId]] }, { as: 'storekeeper' });
  }
  r = await get('Entrepôt : consigne de tri des carreaux par commande', `${W}/waves/${wave}/sort?code=BTM-006`, 'storekeeper');
  ctx.check('Entrepôt : carreaux répartis entre Bâti Plus et l\'hôtel', (r.orders || []).length === 2, r);
  await D('Entrepôt : terminer la vague', 'POST', `${W}/waves/${wave}/complete`, {}, { as: 'storekeeper' });
  await get('Entrepôt : vagues', `${W}/waves`, 'storekeeper');
  r = await D('Entrepôt : vague de l\'après-midi (annulée)', 'POST', `${W}/waves`, { pickIds: [(await D('Entrepôt : liste Commune de Douala 5e', 'POST', `${W}/picks`, { documentId: docs.mairie }, { as: 'manager' })).id], label: 'Kotto — après-midi' }, { as: 'manager' });
  await D('Entrepôt : annuler la vague avant prélèvement', 'POST', `${W}/waves/${r.id}/cancel`, {}, { as: 'manager' });

  // ---------- Poste d'emballage ----------
  await get('Entrepôt : poste d\'emballage (listes à emballer)', `${W}/packing`, 'storekeeper');
  const packAll = async (pickId, who, boxDims) => {
    const p = ((await get('Entrepôt : liste à emballer', `${W}/packing/${pickId}`, 'storekeeper')).pick) || {};
    const b = await D(`Entrepôt : nouveau colis pour ${who}`, 'POST', `${W}/packing/${pickId}/boxes`, { note: who, ...boxDims }, { as: 'storekeeper' });
    for (const l of p.items || []) {
      const left = l.toPack;
      if (left > 0) await D(`Entrepôt : emballer ${left} ${keyOf[l.itemId] || ''}`, 'POST', `${W}/packing/${pickId}/pack`, { boxId: b.id, itemId: l.itemId, quantity: left }, { as: 'storekeeper' });
    }
    return b;
  };
  const bBati = await packAll(pBati, 'Bâti Plus', { weight: '1450', length: 120, width: 100, height: 90 });
  r = await D('Entrepôt : contrôle du colis par scan (écart signalé)', 'POST', `${W}/packing/${pBati}/verify`, { boxId: bBati.id, codes: ['BTM-004', 'BTM-006', 'INCONNU-1'] }, { as: 'storekeeper' });
  ctx.check('Entrepôt : écart détecté au contrôle', r.ok === false, r);
  await D('Entrepôt : corriger poids et dimensions du colis', 'PUT', `${W}/packing/boxes/${bBati.id}`, { weight: '1480', length: 120, width: 100, height: 95 }, { as: 'storekeeper' });
  await D('Entrepôt : fermer le colis', 'POST', `${W}/packing/boxes/${bBati.id}/close`, { weight: '1480', length: 120, width: 100, height: 95 }, { as: 'storekeeper' });
  await D('Entrepôt : rouvrir le colis (oubli du BL)', 'POST', `${W}/packing/boxes/${bBati.id}/reopen`, {}, { as: 'storekeeper' });
  await D('Entrepôt : terminer l\'emballage Bâti Plus', 'POST', `${W}/packing/${pBati}/finish`, {}, { as: 'storekeeper' });
  r = await D('Entrepôt : liste de colisage (PDF)', 'GET', `${W}/packing/boxes/${bBati.id}/packing-list`, undefined, { as: 'storekeeper', raw: true });
  ctx.check('Entrepôt : liste de colisage PDF', r.buf && r.buf.subarray(0, 5).toString() === '%PDF-', r.status);
  const bQuinc = await packAll(pQuinc, 'Quincaillerie du Wouri', { weight: '210' });
  await D('Entrepôt : retirer un rouleau du colis', 'POST', `${W}/packing/${pQuinc}/unpack`, { boxId: bQuinc.id, itemId: I.cable, quantity: 1 }, { as: 'storekeeper' });
  await D('Entrepôt : le remettre', 'POST', `${W}/packing/${pQuinc}/pack`, { boxId: bQuinc.id, itemCode: 'BTM-011' }, { as: 'storekeeper' });
  await D('Entrepôt : terminer l\'emballage Quincaillerie', 'POST', `${W}/packing/${pQuinc}/finish`, {}, { as: 'storekeeper' });
  const bHotel = await packAll(pHotel, 'Hôtel La Falaise', { weight: '520' });
  await D('Entrepôt : terminer l\'emballage Hôtel', 'POST', `${W}/packing/${pHotel}/finish`, {}, { as: 'storekeeper' });

  // Étiquetage obligatoire des brouettes (règle) : la tâche bloque la sortie tant qu'elle n'est pas faite.
  r = await get('Entrepôt : services à faire sur la liste Quincaillerie', `${W}/vas/tasks?refKind=pick&refId=${pQuinc}`, 'storekeeper');
  const vLabel = (r.tasks || [])[0];
  ctx.check('Entrepôt : tâche d\'étiquetage créée par la règle', vLabel && vLabel.mandatory, r.tasks);
  r = await D('Entrepôt : service manuel — filmage de la palette Hôtel', 'POST', `${W}/vas/tasks`, { typeId: tFilm, refKind: 'pick', refId: pHotel, note: 'Film noir (discrétion clientèle)' }, { as: 'manager' });
  const vFilm = r.id;
  await D('Entrepôt : confier le filmage au magasinier', 'PUT', `${W}/vas/tasks/${vFilm}`, { assignedTo: storekeeper, note: 'Film noir, 2 feuillards' }, { as: 'manager' });
  await D('Entrepôt : commencer le filmage', 'POST', `${W}/vas/tasks/${vFilm}/start`, {}, { as: 'storekeeper' });
  await D('Entrepôt : filmage terminé (durée saisie)', 'POST', `${W}/vas/tasks/${vFilm}/complete`, { minutes: 12, result: 'Palette filmée' }, { as: 'storekeeper' });
  r = await D('Entrepôt : service saisi par erreur', 'POST', `${W}/vas/tasks`, { typeId: tFilm, refKind: 'pick', refId: pBati }, { as: 'manager' });
  await D('Entrepôt : annuler le service inutile', 'POST', `${W}/vas/tasks/${r.id}/cancel`, { reason: 'Colis déjà cerclé' }, { as: 'manager' });

  // ---------- Expéditions ----------
  await get('Entrepôt : colis prêts à expédier', `${W}/shipments/ready`);
  await D('Entrepôt : un magasinier ne crée pas d\'expédition', 'POST', `${W}/shipments`, { huIds: [bBati.id] }, { as: 'storekeeper', expect: 403 });
  r = await D('Entrepôt : expédition Bâti Plus (quai, transporteur, suivi)', 'POST', `${W}/shipments`, { huIds: [bBati.id], dockCode: 'QUAI-EXP', carrierName: 'Transports Ngando & Fils', tracking: 'TNF-26-1187', plannedDate: ctx.day(0), address: 'Villa Akwa Nord, rue des Palmiers, Douala', note: 'Appeler M. Kamdem 30 min avant' }, { as: 'manager' });
  const ship = r.id; st.shipmentCode = r.code;
  await D('Entrepôt : ajouter le colis Quincaillerie au même camion', 'POST', `${W}/shipments/${ship}/units`, { huId: bQuinc.id }, { as: 'storekeeper' });
  await D('Entrepôt : retirer le colis Quincaillerie (autre tournée)', 'DELETE', `${W}/shipments/${ship}/units/${bQuinc.id}`, undefined, { as: 'storekeeper' });
  await D('Entrepôt : mettre les unités à quai', 'POST', `${W}/shipments/${ship}/stage`, {}, { as: 'storekeeper' });
  await D('Entrepôt : chargement scanné', 'POST', `${W}/shipments/${ship}/load`, { code: bBati.code }, { as: 'storekeeper' });
  await D('Entrepôt : décharger (mauvais camion)', 'POST', `${W}/shipments/${ship}/unload`, { code: bBati.code }, { as: 'storekeeper' });
  await D('Entrepôt : recharger dans le bon camion', 'POST', `${W}/shipments/${ship}/load`, { code: bBati.code }, { as: 'storekeeper' });
  r = await get('Entrepôt : contrôle final à faire avant le départ', `${W}/vas/tasks?refKind=shipment&refId=${ship}`, 'storekeeper');
  const vCtrl = (r.tasks || [])[0];
  await D('Entrepôt : départ bloqué tant que le contrôle final n\'est pas fait', 'POST', `${W}/shipments/${ship}/ship`, {}, { as: 'manager', expect: 409 });
  await D('Entrepôt : contrôle final validé au scan', 'POST', `${W}/vas/scan`, { code: vCtrl && vCtrl.code, minutes: 8 }, { as: 'storekeeper' });
  r = await D('Entrepôt : valider l\'expédition (sortie de stock, livraison créée)', 'POST', `${W}/shipments/${ship}/ship`, {}, { as: 'manager' });
  ctx.check('Entrepôt : livraison Logistique créée', r.deliveryId > 0, r);
  st.deliveryId = r.deliveryId;
  await D('Entrepôt : corriger le numéro de suivi', 'PUT', `${W}/shipments/${ship}`, { tracking: 'TNF-26-1188' }, { as: 'manager' });
  r = await D('Entrepôt : bon de livraison (PDF)', 'GET', `${W}/shipments/${ship}/delivery-note`, undefined, { as: 'storekeeper', raw: true });
  ctx.check('Entrepôt : bon de livraison PDF', r.buf && r.buf.subarray(0, 5).toString() === '%PDF-', r.status);
  // Quincaillerie : étiquetage obligatoire avant le départ.
  r = await D('Entrepôt : expédition Quincaillerie du Wouri (camionnette)', 'POST', `${W}/shipments`, { huCodes: [bQuinc.code], dock: 'Porte 2', carrierName: 'Camionnette Batimat', plannedDate: ctx.day(0) }, { as: 'manager' });
  const ship2 = r.id;
  await D('Entrepôt : chargement de la camionnette', 'POST', `${W}/shipments/${ship2}/load`, { code: bQuinc.code }, { as: 'storekeeper' });
  await D('Entrepôt : commencer l\'étiquetage', 'POST', `${W}/vas/tasks/${vLabel && vLabel.id}/start`, {}, { as: 'storekeeper' });
  await D('Entrepôt : étiquetage terminé au scan', 'POST', `${W}/vas/scan`, { code: vLabel && vLabel.code }, { as: 'storekeeper' });
  r = await get('Entrepôt : tâches de contrôle de la camionnette', `${W}/vas/tasks?refKind=shipment&refId=${ship2}`, 'storekeeper');
  for (const t of r.tasks || []) await D('Entrepôt : contrôle final (coût réel saisi)', 'POST', `${W}/vas/tasks/${t.id}/complete`, { cost: 1500, result: 'Conforme' }, { as: 'manager' });
  await D('Entrepôt : expédier sans créer de livraison', 'POST', `${W}/shipments/${ship2}/ship`, { createDelivery: false }, { as: 'manager' });
  r = await D('Entrepôt : expédition Hôtel La Falaise (reportée)', 'POST', `${W}/shipments`, { huIds: [bHotel.id], dockCode: 'QUAI-EXP', carrierName: 'Transports Ngando & Fils', plannedDate: ctx.day(-1) }, { as: 'manager' });
  st.lateShipment = r.id;
  r = await D('Entrepôt : expédition créée par erreur', 'POST', `${W}/shipments`, { customerName: 'Client à confirmer', plannedDate: ctx.day(2) }, { as: 'manager' });
  await D('Entrepôt : annuler l\'expédition', 'POST', `${W}/shipments/${r.id}/cancel`, {}, { as: 'manager' });
  await get('Entrepôt : expéditions', `${W}/shipments`, 'storekeeper');
  await get('Entrepôt : détail de l\'expédition', `${W}/shipments/${ship}`, 'storekeeper');
  await get('Entrepôt : mes services à faire', `${W}/vas/tasks?mine=1`, 'storekeeper');
  r = await get('Entrepôt : coûts des services à valeur ajoutée', `${W}/vas/costs`);
  ctx.check('Entrepôt : coûts des services calculés', r.total > 0, r);

  // ---------- Réapprovisionnement interne (emplacements de préparation) ----------
  const L = st.locations;
  r = await D('Entrepôt : règle — P-01 entre 120 et 150 sacs de ciment', 'POST', `${W}/replenishment/rules`, { itemId: I.ciment, locationId: L['P-01'], min: 120, max: 150 }, { as: 'manager' });
  const rCim = r.id;
  r = await D('Entrepôt : règle — P-02 câble entre 5 et 20', 'POST', `${W}/replenishment/rules`, { itemId: I.cable, locationId: L['P-02'], min: 5, max: 20 }, { as: 'manager' });
  const rCab = r.id;
  await D('Entrepôt : règle sur un emplacement de stockage refusée', 'POST', `${W}/replenishment/rules`, { itemId: I.fer10, locationId: L['B-01-01'], min: 5, max: 10 }, { as: 'manager', expect: 400 });
  await D('Entrepôt : ajuster la règle de P-01', 'PUT', `${W}/replenishment/rules/${rCim}`, { min: 130, max: 160 }, { as: 'manager' });
  await D('Entrepôt : désactiver la règle du câble', 'PUT', `${W}/replenishment/rules/${rCab}`, { active: false }, { as: 'manager' });
  await D('Entrepôt : supprimer la règle du câble', 'DELETE', `${W}/replenishment/rules/${rCab}`, undefined, { as: 'manager' });
  await get('Entrepôt : règles de réapprovisionnement', `${W}/replenishment/rules`, 'storekeeper');
  r = await get('Entrepôt : besoins de réapprovisionnement de P-01', `${W}/replenishment/suggestions`, 'storekeeper');
  r = await D('Entrepôt : générer les tâches de réapprovisionnement', 'POST', `${W}/replenishment/generate`, {}, { as: 'storekeeper' });
  ctx.check('Entrepôt : tâches RA-… créées', (r.created || []).length >= 1, r);
  const tasks = (await get('Entrepôt : tâches de réapprovisionnement', `${W}/replenishment/tasks`, 'storekeeper')).tasks || [];
  for (const [i, t] of tasks.entries()) {
    if (i === tasks.length - 1 && tasks.length > 1) { await D('Entrepôt : annuler une tâche de réapprovisionnement', 'POST', `${W}/replenishment/tasks/${t.id}/cancel`, {}, { as: 'storekeeper' }); continue; }
    await D(`Entrepôt : réapprovisionnement scanné ${t.from} → P-01`, 'POST', `${W}/replenishment/tasks/${t.id}/confirm`, t.huCode ? { huCode: t.huCode, toLocationCode: 'P-01' } : { fromLocationCode: t.from, toLocationCode: 'P-01' }, { as: 'storekeeper' });
  }

  // ---------- Transbordement ----------
  r = await D('Entrepôt : liste de préparation Immobilière des Collines (stock insuffisant)', 'POST', `${W}/picks`, { documentId: docs.immo, priority: 1 }, { as: 'manager' });
  const pImmo = r.id;
  ctx.check('Entrepôt : liste en manque', r.short === true, r);
  r = await get('Entrepôt : demandes en attente de marchandise', `${W}/crossdock/demand`, 'storekeeper');
  const dem = (r.items || []).find((x) => x.itemId === I.fer8);
  ctx.check('Entrepôt : 150 barres HA 8 attendues', dem && dem.missing === 150, r.items);
  await get('Entrepôt : aperçu avant réception (transbordement possible)', `${W}/crossdock/check?itemId=${I.fer8}&quantity=150`, 'storekeeper');
  r = await D('Achats : commande ADC de fer HA 8 (pour le transbordement)', 'POST', '/purchasing/orders', { supplierId: S.adc, expectedDate: ctx.day(1), category: 'Métallurgie', lines: [{ itemId: I.fer8, quantity: 100, unitPrice: 2580 }] }, { as: 'manager' });
  const po8 = r.id;
  await D('Achats : approuver la commande de fer HA 8', 'POST', `/purchasing/orders/${po8}/approve`, {}, { as: 'manager' });
  r = await D('Entrepôt : planifier le transbordement sur le bon de commande', 'POST', `${W}/crossdock/plan`, { itemId: I.fer8, quantity: 100, pickId: pImmo, purchaseOrderId: po8, note: 'Camion ADC direct vers le quai' }, { as: 'manager' });
  const xdPlan = r.id;
  r = await D('Entrepôt : second transbordement planifié (annulé ensuite)', 'POST', `${W}/crossdock/plan`, { itemId: I.fer8, quantity: 20, pickId: pImmo }, { as: 'manager' });
  await D('Entrepôt : annuler le transbordement', 'POST', `${W}/crossdock/${r.id}/cancel`, { reason: 'Couvert par la réception ADC' }, { as: 'manager' });
  await D('Entrepôt : exécution refusée avant l\'arrivée', 'POST', `${W}/crossdock/${xdPlan}/execute`, {}, { as: 'storekeeper', expect: 400 });
  const ol8 = (((await get('Achats : détail du bon de commande fer HA 8', `/purchasing/orders/${po8}`)).order || {}).lines || [])[0] || {};
  r = await D('Achats : réception ADC — le transbordement passe « prêt »', 'POST', `/purchasing/orders/${po8}/receipts`, { deliveryNote: 'BL-ADC-77950', lines: [{ orderLineId: ol8.id, receivedQty: 100, locationId: L['QUAI-REC'] }] }, { as: 'manager' });
  ctx.check('Entrepôt : transbordement prêt', (r.crossDock || []).some((x) => x.status === 'ready'), r.crossDock);
  await D('Entrepôt : exécuter le transbordement (quai → emballage)', 'POST', `${W}/crossdock/${xdPlan}/execute`, {}, { as: 'storekeeper' });
  r = await D('Entrepôt : réception de fer HA 8 au quai (transbordement proposé)', 'POST', `${W}/receipts`, { supplierId: S.adc, reference: 'BL-ADC-77961', locationId: L['QUAI-REC'], lines: [{ itemId: I.fer8, quantity: 80, unitCost: 2580 }] }, { as: 'manager' });
  ctx.check('Entrepôt : 50 barres proposées en transbordement', (r.crossDock || []).some((x) => x.quantity === 50), r.crossDock);
  await D('Entrepôt : scan de l\'article : transbordement exécuté', 'POST', `${W}/crossdock/scan`, { code: 'BTM-014' }, { as: 'storekeeper' });
  await D('Entrepôt : entrée au scanner — recherche des commandes en attente', 'POST', `${W}/crossdock/from-stock`, { itemId: I.fer8, quantity: 30, locationId: L['QUAI-REC'] }, { as: 'storekeeper' });
  r = await get('Entrepôt : historique des transbordements', `${W}/crossdock?status=history`, 'storekeeper');
  ctx.check('Entrepôt : deux transbordements faits', (r.crossdocks || []).filter((x) => x.status === 'done').length >= 2, r.crossdocks);
  await get('Entrepôt : transbordements en cours', `${W}/crossdock`, 'storekeeper');
  await get('Entrepôt : détail d\'un transbordement', `${W}/crossdock/${xdPlan}`, 'storekeeper');
  await D('Entrepôt : ranger le reste de la réception', 'POST', `${W}/putaway`, { itemId: I.fer8, fromLocationId: L['QUAI-REC'], toLocationId: L['B-03-02'] }, { as: 'storekeeper' });
  pl = await pickLines(pImmo);
  for (const l of pl.filter((x) => !x.done)) await D('Entrepôt : prélever le fer HA 8 en rayon', 'POST', `${W}/picks/${pImmo}/lines/${l.id}/confirm`, {}, { as: 'storekeeper' });
  await D('Entrepôt : terminer la liste Immobilière des Collines', 'POST', `${W}/picks/${pImmo}/complete`, { allowShort: true }, { as: 'storekeeper' });
  await D('Entrepôt : sortie de stock (dont 150 barres transbordées)', 'POST', `${W}/picks/${pImmo}/issue`, {}, { as: 'manager' });

  // ---------- Kits : « Pack maçon » ----------
  await D('Entrepôt : un magasinier ne crée pas de kit', 'POST', `${W}/kits`, { productId: I.packMacon, lines: [{ itemId: I.ciment, quantity: 10 }] }, { as: 'storekeeper', expect: 403 });
  r = await D('Entrepôt : kit « Pack maçon » (10 sacs + 5 barres, main-d\'œuvre 1 500)', 'POST', `${W}/kits`, { productId: I.packMacon, lines: [{ itemId: I.ciment, quantity: 10 }, { itemId: I.fer10, quantity: 4 }], laborCost: 1500, notes: 'Offre promotionnelle saison sèche' }, { as: 'manager' });
  const kit = r.id;
  await D('Entrepôt : corriger la nomenclature du kit (5 barres)', 'PUT', `${W}/kits/${kit}`, { lines: [{ itemId: I.ciment, quantity: 10 }, { itemId: I.fer10, quantity: 5 }], laborCost: 1500, notes: 'Offre promotionnelle saison sèche' }, { as: 'manager' });
  r = await get('Entrepôt : kits réalisables et coût estimé', `${W}/kits`);
  ctx.check('Entrepôt : kit réalisable', (r.kits || []).some((k) => k.id === kit && k.buildable > 0), r.kits);
  await get('Entrepôt : détail du kit', `${W}/kits/${kit}`, 'storekeeper');
  r = await D('Entrepôt : ordre d\'assemblage de 12 packs', 'POST', `${W}/kit-orders`, { bomId: kit, quantity: 12, warehouseId: st.warehouses.douala, note: 'Pour la foire de Douala' }, { as: 'manager' });
  const as1 = r.id;
  await get('Entrepôt : plan d\'assemblage (composants mis de côté)', `${W}/kit-orders/${as1}`, 'storekeeper');
  await D('Entrepôt : assemblage partiel (8 packs, main-d\'œuvre réelle)', 'POST', `${W}/kit-orders/${as1}/complete`, { quantity: 8, laborCost: 12000 }, { as: 'manager' });
  await D('Entrepôt : assemblage du reste par le magasinier', 'POST', `${W}/kit-orders/${as1}/complete`, {}, { as: 'storekeeper' });
  r = await D('Entrepôt : désassembler un pack (sac abîmé)', 'POST', `${W}/kit-orders`, { bomId: kit, quantity: 1, kind: 'disassembly' }, { as: 'manager' });
  await D('Entrepôt : exécuter le désassemblage', 'POST', `${W}/kit-orders/${r.id}/complete`, {}, { as: 'manager' });
  r = await D('Entrepôt : ordre d\'assemblage trop ambitieux', 'POST', `${W}/kit-orders`, { bomId: kit, quantity: 5000 }, { as: 'manager' });
  ctx.check('Entrepôt : manques signalés', (r.short || []).length >= 1, r);
  await D('Entrepôt : annuler l\'ordre d\'assemblage', 'POST', `${W}/kit-orders/${r.id}/cancel`, {}, { as: 'manager' });
  await get('Entrepôt : ordres d\'assemblage', `${W}/kit-orders`, 'storekeeper');
  st.kitId = kit;
};
