'use strict';
// Démonstration — Stock : fiches articles, codes-barres, prix fournisseurs, entrées / sorties (lots FEFO, numéros de série, CUMP),
// seuils et alertes (rupture, péremption, surstock), commandes simples avec date promise (retard fournisseur), inventaires physiques.
module.exports = async function core(ctx) {
  const I = ctx.ids.items; const S = ctx.ids.suppliers; const st = ctx.ids.stock;
  // Les refus de droits (403) ne se montrent que si la personne a son propre compte (démo locale) ; sinon l'appel partirait au nom du dirigeant.
  const D = (f, m, u, b, o = {}) => (o.as && !ctx.users[o.as] && [].concat(o.expect || []).includes(403) ? Promise.resolve({}) : ctx.do(f, m, u, b, o));
  const get = (f, u, as) => D(f, 'GET', u, undefined, { as });

  // ---------- Écrans principaux ----------
  let r = await get('Stock : tableau des articles (responsable, valorisé au CUMP)', '/stock', 'manager');
  ctx.check('Stock : 12 articles du catalogue, valeur du stock calculée', (r.items || []).length >= 12 && r.summary && r.summary.value > 0, r.summary);
  r = await get('Stock : liste des articles vue par le magasinier (sans coûts)', '/stock', 'storekeeper');
  if (ctx.users.storekeeper) ctx.check('Stock : le magasinier ne voit ni valeur ni coût moyen', r.summary && r.summary.value === undefined && (r.items || []).every((i) => i.avgCost === undefined), r.summary);
  const items = Object.fromEntries(((await get('Stock : liste des articles (dirigeant)', '/stock')).items || []).map((i) => [i.id, i]));

  // ---------- Fiches articles ----------
  await D('Stock : fixer le stock maximum du ciment (alerte de surstock)', 'PUT', `/stock/items/${I.ciment}`, { maxQuantity: 3000, minQuantity: 250 }, { as: 'manager' });
  await D('Stock : règle de sortie FEFO et maximum pour la peinture', 'PUT', `/stock/items/${I.peinture}`, { pickRule: 'fefo', maxQuantity: 400 }, { as: 'manager' });
  await D('Stock : stock maximum inférieur au seuil refusé', 'PUT', `/stock/items/${I.tole}`, { maxQuantity: 10, minQuantity: 80 }, { as: 'manager', expect: 400 });
  const brouette = (await D('Stock : créer l\'article « Brouette de chantier 90 L »', 'POST', '/stock/items', { name: 'Brouette de chantier 90 L', unit: 'pièce', unitCost: 18500, minQuantity: 10, maxQuantity: 80, sku: 'BTM-013', barcode: '6110000000130', quantity: 24 }, { as: 'manager' })).id;
  const fer8 = (await D('Stock : créer l\'article « Fer à béton HA 8 mm »', 'POST', '/stock/items', { name: 'Fer à béton HA 8 mm — barre 12 m', unit: 'barre', unitCost: 2600, minQuantity: 100, sku: 'BTM-014', barcode: '6110000000147', quantity: 300 }, { as: 'manager' })).id;
  const kit = (await D('Stock : créer l\'article « Pack maçon » (assemblé en kit)', 'POST', '/stock/items', { name: 'Pack maçon : 10 sacs de ciment + 5 barres HA 10', unit: 'pack', unitCost: 0, sku: 'BTM-K01', barcode: '6110000000901' }, { as: 'manager' })).id;
  I.brouette = brouette; I.fer8 = fer8; I.packMacon = kit;
  ctx.ids.prices.brouette = 23500; ctx.ids.prices.fer8 = 3300; ctx.ids.prices.packMacon = 74000;
  await D('Stock : SKU déjà utilisé refusé', 'POST', '/stock/items', { name: 'Doublon', sku: 'BTM-013' }, { as: 'manager', expect: 409 });
  const tmp = (await D('Stock : créer un article saisi par erreur', 'POST', '/stock/items', { name: 'Pelle ronde (saisie en double)', unit: 'pièce' }, { as: 'manager' })).id;
  await D('Stock : supprimer un article jamais utilisé', 'DELETE', `/stock/items/${tmp}`, undefined, { as: 'manager' });
  await D('Stock : suppression refusée pour un article qui a du stock', 'DELETE', `/stock/items/${I.ciment}`, undefined, { as: 'manager', expect: 409 });
  const cim = items[I.ciment] || {};
  r = await get('Stock : recherche par code-barres (douchette)', `/stock/lookup?code=${encodeURIComponent(cim.barcode || 'BTM-001')}`, 'storekeeper');
  ctx.check('Stock : le code-barres retrouve le ciment', r.item && r.item.id === I.ciment, r);
  await get('Stock : recherche par SKU', '/stock/lookup?code=BTM-013', 'storekeeper');
  await D('Stock : code inconnu', 'GET', '/stock/lookup?code=INCONNU-999', undefined, { as: 'storekeeper', expect: 404 });

  // ---------- Prix fournisseurs (comparaison) ----------
  await D('Stock : prix fournisseurs du ciment (Cimencam, Dangote)', 'PUT', `/stock/items/${I.ciment}/prices`, { prices: [{ supplierId: S.cimencam, unitPrice: 4250, leadDays: 3 }, { supplierId: S.dangote, unitPrice: 4180, leadDays: 7 }] }, { as: 'manager' });
  await D('Stock : prix fournisseur de la tôle (Alucam)', 'PUT', `/stock/items/${I.tole}/prices`, { prices: [{ supplierId: S.alucam, unitPrice: 7100, leadDays: 10 }] }, { as: 'manager' });
  await D('Stock : prix fournisseur du câble (Électro Douala)', 'PUT', `/stock/items/${I.cable}/prices`, { prices: [{ supplierId: S.electro, unitPrice: 31500, leadDays: 2 }] }, { as: 'manager' });
  r = await get('Stock : comparer les prix fournisseurs du ciment', `/stock/items/${I.ciment}/prices`, 'manager');
  ctx.check('Stock : meilleur prix en premier (Dangote 4 180)', r.prices && r.prices[0] && r.prices[0].unitPrice === 4180, r.prices);

  // ---------- Entrées et sorties ----------
  const mv = (f, id, b, as = 'storekeeper', expect) => D(f, 'POST', `/stock/items/${id}/move`, b, { as, expect });
  await mv('Stock : sortie de 120 sacs de ciment (vente chantier Bonamoussadi)', I.ciment, { kind: 'out', quantity: 120, reason: 'Vente comptoir — chantier Bonamoussadi' });
  await mv('Stock : sortie de 60 barres HA 10', I.fer10, { kind: 'out', quantity: 60, reason: 'Livraison Bâti Plus, Akwa' });
  await mv('Stock : sortie de 75 rouleaux de câble (passe sous le seuil)', I.cable, { kind: 'out', quantity: 75, reason: 'Chantier Hôtel La Falaise' });
  await mv('Stock : sortie de 17 bennes de gravier (passe sous le seuil)', I.gravier, { kind: 'out', quantity: 17, reason: 'Dalle — Commune de Douala 5e' });
  await mv('Stock : sortie de 1 200 parpaings', I.parpaing, { kind: 'out', quantity: 1200, reason: 'Livraison Immobilière des Collines' });
  await mv('Stock : entrée valorisée de 2 000 parpaings (le CUMP bouge)', I.parpaing, { kind: 'in', quantity: 2000, unitCost: 345, reason: 'Production briqueterie Japoma' }, 'manager');
  await mv('Stock : un magasinier ne valorise pas une entrée', I.parpaing, { kind: 'in', quantity: 1, unitCost: 1 }, 'storekeeper', 403);
  await mv('Stock : sortie refusée au-delà du stock', I.sable, { kind: 'out', quantity: 500 }, 'storekeeper', 400);
  // Lots et péremption (peinture) : un lot proche de la péremption et un lot périmé.
  await mv('Stock : entrée d\'un lot de peinture proche de la péremption', I.peinture, { kind: 'in', quantity: 40, lotNo: 'PV-2608-K', expiry: ctx.day(21), unitCost: 27500, reason: 'Arrivage Pacific Peintures' }, 'manager');
  await mv('Stock : entrée d\'un lot de peinture déjà périmé (retour client)', I.peinture, { kind: 'in', quantity: 6, lotNo: 'PV-2604-C', expiry: ctx.day(-12), reason: 'Retour de chantier' }, 'manager');
  await mv('Stock : entrée sans numéro de lot refusée', I.peinture, { kind: 'in', quantity: 2 }, 'manager', 400);
  r = await mv('Stock : sortie de 30 seaux (FEFO : le lot qui périme en premier part d\'abord)', I.peinture, { kind: 'out', quantity: 30, reason: 'Vente Hôtel La Falaise (rénovation)' });
  ctx.check('Stock : FEFO — le lot PV-2608-K sort avant le lot de départ, le périmé est ignoré', r.lots && r.lots[0] && r.lots[0].lotNo === 'PV-2608-K', r);
  r = await get('Stock : lots et péremptions de la peinture', `/stock/items/${I.peinture}/lots`, 'storekeeper');
  ctx.check('Stock : lot périmé signalé', (r.lots || []).some((l) => l.expired), r.lots);
  // Numéros de série (groupes électrogènes)
  await mv('Stock : vente d\'un groupe électrogène par numéro de série', I.groupe, { kind: 'out', serials: 'GE75-20260001', reason: 'Vente Hôtel La Falaise' }, 'manager');
  await mv('Stock : entrée de 2 groupes électrogènes (numéros de série)', I.groupe, { kind: 'in', serials: 'GE75-20260101\nGE75-20260102', unitCost: 1420000, reason: 'Arrivage SDMO' }, 'manager');
  await mv('Stock : numéro de série déjà en stock refusé', I.groupe, { kind: 'in', serials: 'GE75-20260002' }, 'manager', 409);
  r = await get('Stock : numéros de série du groupe électrogène', `/stock/items/${I.groupe}/lots`, 'manager');
  ctx.check('Stock : série vendue « out », 7 en stock', (r.serials || []).filter((s) => s.status === 'in_stock').length === 7, (r.serials || []).length);
  await get('Stock : historique des mouvements du ciment', `/stock/items/${I.ciment}/moves`, 'manager');
  r = await get('Stock : lots qui périment dans les 60 jours', '/stock/expiring?days=60', 'storekeeper');
  ctx.check('Stock : alerte de péremption (lot proche et lot périmé)', (r.lots || []).length >= 2, r.lots);
  r = await get('Stock : suggestions de réapprovisionnement (sous le seuil)', '/stock/reorder', 'manager');
  ctx.check('Stock : câble et gravier à recommander', (r.suggestions || []).some((x) => x.itemId === I.cable) && (r.suggestions || []).some((x) => x.itemId === I.gravier), r.suggestions);
  r = await get('Tableau de bord : alertes (rupture, péremption)', '/dashboard/alerts', 'manager');
  ctx.check('Alertes : rupture et péremption signalées', (r.alerts || []).filter((a) => a.module === 'stock').length >= 2, (r.alerts || []).filter((a) => a.module === 'stock'));

  // ---------- Fournisseurs (vue Stock) ----------
  await get('Stock : liste des fournisseurs', '/stock/suppliers', 'manager');
  await D('Stock : note sur un fournisseur', 'PUT', `/stock/suppliers/${S.carrière}`, { contact: 'M. Ondoa, chef de carrière — +237 677 55 44 33', notes: 'Livraison par benne le matin uniquement (route de Nkometou).' }, { as: 'manager' });
  const tmpS = (await D('Stock : créer un fournisseur saisi en double', 'POST', '/stock/suppliers', { name: 'Quincaillerie Mboppi (doublon)' }, { as: 'manager' })).id;
  await D('Stock : supprimer le fournisseur en double', 'DELETE', `/stock/suppliers/${tmpS}`, undefined, { as: 'manager' });

  // ---------- Commandes simples (date promise, retard fournisseur) ----------
  await D('Stock : demande de commande du magasinier (câble et gravier)', 'POST', '/stock/orders', { orders: [
    { itemId: I.cable, supplierId: S.electro, quantity: 60, unitPrice: 31500, promisedDate: ctx.day(-6) },
    { itemId: I.gravier, supplierId: S.carrière, quantity: 10, unitPrice: 88000, promisedDate: ctx.day(-2) },
    { itemId: I.tuyau, supplierId: S.electro, quantity: 100, promisedDate: ctx.day(5) },
  ] }, { as: 'storekeeper' });
  let orders = (await get('Stock : commandes à valider', '/stock/orders', 'manager')).orders || [];
  const oCable = orders.find((o) => o.itemId === I.cable && o.status === 'pending');
  const oGrav = orders.find((o) => o.itemId === I.gravier && o.status === 'pending');
  const oTuyau = orders.find((o) => o.itemId === I.tuyau && o.status === 'pending');
  if (ctx.check('Stock : trois commandes en attente de validation', oCable && oGrav && oTuyau, orders)) {
    await D('Stock : le magasinier ne valide pas sa propre commande', 'PUT', `/stock/orders/${oCable.id}/status`, { status: 'ordered' }, { as: 'storekeeper', expect: 403 });
    await D('Stock : valider la commande de câble', 'PUT', `/stock/orders/${oCable.id}/status`, { status: 'ordered' }, { as: 'manager' });
    await D('Stock : valider la commande de gravier', 'PUT', `/stock/orders/${oGrav.id}/status`, { status: 'ordered' }, { as: 'manager' });
    await D('Stock : corriger la date promise du gravier', 'PUT', `/stock/orders/${oGrav.id}`, { promisedDate: ctx.day(-3) }, { as: 'manager' });
    await D('Stock : annuler la commande de tubes', 'PUT', `/stock/orders/${oTuyau.id}/status`, { status: 'cancelled' }, { as: 'manager' });
    r = await D('Stock : réception partielle du câble (30 sur 60, en retard)', 'POST', `/stock/orders/${oCable.id}/receive`, { quantity: 30, note: 'BL Électro 2611-44' }, { as: 'manager' });
    ctx.check('Stock : commande partielle', r.status === 'partial', r);
    await D('Stock : réception refusée au-delà du reste', 'POST', `/stock/orders/${oCable.id}/receive`, { quantity: 100 }, { as: 'manager', expect: 400 });
    await D('Stock : gravier reçu en totalité', 'PUT', `/stock/orders/${oGrav.id}/status`, { status: 'received' }, { as: 'manager' });
  }
  orders = (await get('Stock : suivi des commandes (retards)', '/stock/orders', 'manager')).orders || [];
  ctx.check('Stock : commande de câble en retard sur la date promise', orders.some((o) => o.itemId === I.cable && o.late), orders.map((o) => [o.item, o.status, o.late]));
  r = await get('Stock : fiabilité des fournisseurs (retards, taux de livraison)', '/stock/supplier-stats', 'manager');
  ctx.check('Stock : Électro Douala en retard', (r.suppliers || []).some((s) => s.supplierId === S.electro && s.late >= 1), r.suppliers);
  await D('Stock : fiabilité des fournisseurs réservée aux responsables', 'GET', '/stock/supplier-stats', undefined, { as: 'storekeeper', expect: 403 });

  // ---------- Inventaire tournant (classe A : les articles qui tournent le plus) ----------
  await get('Entrepôt : plan d\'inventaire tournant (tout est à compter)', '/stock/wms/cycle-counts/plan', 'manager');
  r = await D('Entrepôt : ouvrir l\'inventaire tournant des articles de classe A', 'POST', '/stock/wms/cycle-counts', { classes: ['A'] }, { as: 'manager' });
  if (r.id) {
    const cc = r.id;
    const its = ((await get('Stock : feuille de l\'inventaire tournant', `/stock/counts/${cc}`, 'storekeeper')).count || {}).items || [];
    await D('Stock : comptage tournant saisi au rayon', 'PUT', `/stock/counts/${cc}/lines`, { lines: its.map((l) => ({ itemId: l.itemId, counted: l.itemId === I.fer10 ? l.expected - 3 : l.expected })) }, { as: 'storekeeper' });
    await D('Stock : soumettre l\'inventaire tournant', 'POST', `/stock/counts/${cc}/submit`, {}, { as: 'storekeeper' });
    await D('Stock : valider l\'inventaire tournant', 'POST', `/stock/counts/${cc}/validate`, { note: '3 barres manquantes : vol suspecté, vidéo à vérifier.' }, { as: 'owner' });
  }

  // ---------- Inventaire physique ----------
  r = await D('Stock : ouvrir l\'inventaire mensuel du dépôt', 'POST', '/stock/counts', { note: 'Inventaire mensuel — dépôt de Bonabéri, novembre' }, { as: 'manager' });
  const cnt = r.id;
  await D('Stock : un seul inventaire à la fois', 'POST', '/stock/counts', {}, { as: 'manager', expect: 409 });
  r = await get('Stock : feuille de comptage (magasinier, sans valeurs)', `/stock/counts/${cnt}`, 'storekeeper');
  const lines = ((r.count || {}).items || []).map((l) => {
    let counted = l.expected;
    if (l.itemId === I.ciment) counted = l.expected - 4; // sacs éventés
    if (l.itemId === I.carreau) counted = l.expected - 2; // cartons cassés
    if (l.itemId === I.parpaing) counted = l.expected + 15; // palette non saisie
    return { itemId: l.itemId, counted };
  });
  await D('Stock : saisie du comptage par le magasinier', 'PUT', `/stock/counts/${cnt}/lines`, { lines }, { as: 'storekeeper' });
  await D('Stock : validation impossible avant soumission', 'POST', `/stock/counts/${cnt}/validate`, {}, { as: 'owner', expect: 400 });
  await D('Stock : soumettre le comptage', 'POST', `/stock/counts/${cnt}/submit`, {}, { as: 'storekeeper' });
  r = await get('Stock : écarts d\'inventaire valorisés', `/stock/counts/${cnt}`, 'manager');
  ctx.check('Stock : écart valorisé négatif (casse)', r.count && r.count.gapValue < 0 && r.count.withGap === 3, r.count && { gap: r.count.gapValue, n: r.count.withGap });
  await D('Stock : le responsable qui a ouvert l\'inventaire ne le valide pas seul', 'POST', `/stock/counts/${cnt}/validate`, {}, { as: 'manager', expect: 403 });
  r = await D('Stock : la dirigeante valide l\'inventaire (ajustements tracés)', 'POST', `/stock/counts/${cnt}/validate`, { note: 'Sacs éventés et cartons cassés : sensibiliser les caristes.' }, { as: 'owner' });
  ctx.check('Stock : 3 ajustements', r.adjusted === 3, r);
  r = await D('Stock : inventaire de contrôle des cartons', 'POST', '/stock/counts', { note: 'Recomptage des carreaux' }, { as: 'manager' });
  await D('Stock : comptage partiel des carreaux', 'PUT', `/stock/counts/${r.id}/lines`, { lines: [{ itemId: I.carreau, counted: 10 }] }, { as: 'storekeeper' });
  await D('Stock : soumettre le recomptage', 'POST', `/stock/counts/${r.id}/submit`, {}, { as: 'storekeeper' });
  await D('Stock : rejeter un comptage manifestement faux', 'POST', `/stock/counts/${r.id}/reject`, { note: 'Une seule allée comptée : à refaire.' }, { as: 'owner' });
  r = await D('Stock : ouvrir un inventaire par erreur', 'POST', '/stock/counts', { note: 'Ouvert par erreur' }, { as: 'manager' });
  await D('Stock : abandonner l\'inventaire ouvert', 'DELETE', `/stock/counts/${r.id}`, undefined, { as: 'manager' });
  await get('Stock : historique des inventaires', '/stock/counts', 'storekeeper');
  st.countId = cnt;
};
