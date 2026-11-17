'use strict';
// Démonstration — Entrepôt (WMS), 1/3 : entrepôts de Douala et Yaoundé, zones, emplacements (création en masse), règles de rangement,
// déplacements, réception au quai puis rangement, palettes et colis (étiquettes PDF), réceptions avec frais d'approche,
// transferts Douala → Yaoundé (écart à l'arrivée), réservations, retours (client, fournisseur avec RMA, rebut), quarantaine.
module.exports = async function wms(ctx) {
  const I = ctx.ids.items; const S = ctx.ids.suppliers; const C = ctx.ids.customers; const st = ctx.ids.stock;
  // Les refus de droits (403) ne se montrent que si la personne a son propre compte (démo locale) ; sinon l'appel partirait au nom du dirigeant.
  const D = (f, m, u, b, o = {}) => (o.as && !ctx.users[o.as] && [].concat(o.expect || []).includes(403) ? Promise.resolve({}) : ctx.do(f, m, u, b, o));
  const get = (f, u, as = 'manager') => D(f, 'GET', u, undefined, { as });
  const W = '/stock/wms';
  let r;

  // ---------- Entrepôts ----------
  r = await get('Entrepôt : vue d\'ensemble (vue du magasinier)', `${W}/overview`, 'storekeeper');
  const main = ((r.warehouses || []).find((w) => w.isDefault) || {}).id;
  await D('Entrepôt : renommer l\'entrepôt principal (Douala, Bonabéri)', 'PUT', `${W}/warehouses/${main}`, { name: 'Dépôt de Douala — Bonabéri', address: 'Zone industrielle de Bonabéri, route de Limbé, Douala' }, { as: 'manager' });
  await D('Entrepôt : un magasinier ne crée pas d\'entrepôt', 'POST', `${W}/warehouses`, { name: 'Dépôt pirate' }, { as: 'storekeeper', expect: 403 });
  r = await D('Entrepôt : créer le dépôt de Yaoundé (Mvan)', 'POST', `${W}/warehouses`, { name: 'Dépôt de Yaoundé — Mvan', code: 'YDE', branchId: ctx.ids.branches.yaounde, address: 'Carrefour Mvan, route de l\'aéroport, Yaoundé' }, { as: 'manager' });
  const yde = r.id;
  r = await D('Entrepôt : dépôt temporaire (foire de Douala)', 'POST', `${W}/warehouses`, { name: 'Stand Foire internationale', code: 'FOIRE' }, { as: 'manager' });
  await D('Entrepôt : supprimer le dépôt temporaire vide', 'DELETE', `${W}/warehouses/${r.id}`, undefined, { as: 'manager' });
  await D('Entrepôt : l\'entrepôt principal ne se désactive pas', 'PUT', `${W}/warehouses/${main}`, { active: false }, { as: 'manager', expect: 400 });
  st.warehouses = { douala: main, yaounde: yde };

  // ---------- Zones et emplacements ----------
  const zone = async (warehouseId, name, code, kind) => (await D(`Entrepôt : zone « ${name} »`, 'POST', `${W}/zones`, { warehouseId, name, code, kind }, { as: 'manager' })).id;
  const zLourd = await zone(main, 'Matériaux lourds (ciment, fer, tôles)', 'ZML', 'storage');
  const zQuinc = await zone(main, 'Quincaillerie et finitions', 'ZQ', 'storage');
  const zPrep = await zone(main, 'Préparation comptoir', 'ZP', 'picking');
  const zYde = await zone(yde, 'Magasin Yaoundé', 'YMG', 'storage');
  st.zones = { lourd: zLourd, quinc: zQuinc, prep: zPrep, yaounde: zYde };
  await get('Entrepôt : liste des zones', `${W}/zones`);
  r = await D('Entrepôt : création en masse des allées A et B (4 rayons × 2 niveaux)', 'POST', `${W}/locations/bulk`, { warehouseId: main, aisles: 'A, B', racks: 4, bins: 2, zoneId: zLourd, capacity: 600 }, { as: 'manager' });
  ctx.check('Entrepôt : 16 emplacements créés', r.created === 16, r);
  r = await D('Entrepôt : création en masse de l\'allée C (quincaillerie)', 'POST', `${W}/locations/bulk`, { warehouseId: main, aisles: 'C', racks: 3, bins: 3, zoneId: zQuinc, capacity: 200 }, { as: 'manager' });
  r = await D('Entrepôt : relancer la création — les codes existants sont ignorés', 'POST', `${W}/locations/bulk`, { warehouseId: main, aisles: 'C', racks: 3, bins: 4, zoneId: zQuinc, capacity: 200 }, { as: 'manager' });
  ctx.check('Entrepôt : 3 créés, 9 ignorés', r.created === 3 && r.skipped === 9, r);
  await D('Entrepôt : création en masse limitée à 300', 'POST', `${W}/locations/bulk`, { warehouseId: main, aisles: 'D E F G', racks: 10, bins: 10 }, { as: 'manager', expect: 400 });
  await D('Entrepôt : création en masse du magasin de Yaoundé', 'POST', `${W}/locations/bulk`, { warehouseId: yde, aisles: 'Y', racks: 3, bins: 2, zoneId: zYde, capacity: 500 }, { as: 'manager' });
  const loc = async (b, label) => (await D(`Entrepôt : emplacement ${label}`, 'POST', `${W}/locations`, b, { as: 'manager' })).id;
  await loc({ warehouseId: main, code: 'QUAI-REC', name: 'Quai de réception', kind: 'reception' }, 'quai de réception');
  await loc({ warehouseId: main, code: 'QUAI-EXP', name: 'Quai d\'expédition', kind: 'shipping' }, 'quai d\'expédition');
  await loc({ warehouseId: main, code: 'P-01', name: 'Comptoir ciment', kind: 'picking', aisle: 'P', rack: '01', bin: '01', zoneId: zPrep, capacity: 150 }, 'de préparation P-01');
  await loc({ warehouseId: main, code: 'P-02', name: 'Comptoir quincaillerie', kind: 'picking', aisle: 'P', rack: '02', bin: '01', zoneId: zPrep, capacity: 150 }, 'de préparation P-02');
  await loc({ warehouseId: yde, code: 'YDE-QUAI', name: 'Quai Yaoundé', kind: 'reception' }, 'quai de Yaoundé');
  await D('Entrepôt : code d\'emplacement unique', 'POST', `${W}/locations`, { warehouseId: main, code: 'quai-rec' }, { as: 'manager', expect: 409 });
  const tmpLoc = await loc({ warehouseId: main, code: 'TMP-01', name: 'Allée provisoire' }, 'provisoire');
  await D('Entrepôt : supprimer l\'emplacement provisoire', 'DELETE', `${W}/locations/${tmpLoc}`, undefined, { as: 'manager' });
  const L = {};
  const reload = async () => { for (const l of (await get('Entrepôt : liste des emplacements', `${W}/locations`)).locations || []) L[l.code] = l; };
  await reload();
  await D('Entrepôt : « En transit » ne se supprime pas', 'DELETE', `${W}/locations/${L.TRANSIT.id}`, undefined, { as: 'manager', expect: 400 });
  await D('Entrepôt : renommer un emplacement et fixer sa capacité', 'PUT', `${W}/locations/${L['C-03-04'].id}`, { name: 'Bac peinture', capacity: 120 }, { as: 'manager' });
  await D('Entrepôt : désactiver un emplacement endommagé', 'PUT', `${W}/locations/${L['C-02-04'].id}`, { active: false, name: 'Rayon endommagé (à réparer)' }, { as: 'manager' });
  await get('Entrepôt : emplacements du dépôt de Yaoundé', `${W}/locations?warehouseId=${yde}`);
  await get('Entrepôt : retrouver un emplacement par son code', `${W}/locations/lookup?code=quai-rec`, 'storekeeper');
  st.locations = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.id]));

  // ---------- Règles de rangement et réglages ----------
  const rule = (f, b) => D(`Entrepôt : règle de rangement — ${f}`, 'POST', `${W}/putaway-rules`, b, { as: 'manager' });
  await rule('ciment en A-01-01', { itemId: I.ciment, locationId: L['A-01-01'].id, priority: 1 });
  await rule('ciment en A-01-02', { itemId: I.ciment, locationId: L['A-01-02'].id, priority: 2 });
  await rule('fer HA 10 en B-01-01', { itemId: I.fer10, locationId: L['B-01-01'].id, priority: 1 });
  await rule('fer HA 12 en B-02-01', { itemId: I.fer12, locationId: L['B-02-01'].id, priority: 1 });
  await rule('tôles en A-03-01', { itemId: I.tole, locationId: L['A-03-01'].id, priority: 1 });
  await rule('carreaux en C-01-01', { itemId: I.carreau, locationId: L['C-01-01'].id, priority: 1 });
  await rule('articles suivis par lot en C-03-04', { tracking: 'lot', locationId: L['C-03-04'].id, priority: 5 });
  r = await rule('tubes PVC (à revoir)', { itemId: I.tuyau, locationId: L['C-02-01'].id, priority: 9 });
  await D('Entrepôt : supprimer une règle de rangement', 'DELETE', `${W}/putaway-rules/${r.id}`, undefined, { as: 'manager' });
  await get('Entrepôt : règles de rangement', `${W}/putaway-rules`, 'storekeeper');
  await get('Entrepôt : réglages (ABC, inventaires tournants, transbordement)', `${W}/settings`);
  await D('Entrepôt : réglages réservés aux administrateurs', 'PUT', `${W}/settings`, { abcA: 70 }, { as: 'manager', expect: 403 });
  await D('Entrepôt : régler ABC 80/95 %, inventaire A tous les 30 jours, prévision sur 12 semaines', 'PUT', `${W}/settings`, { abcA: 80, abcB: 95, cycleA: 30, cycleB: 60, cycleC: 120, forecastWeeks: 12, serviceLevel: 95, defaultLeadDays: 7, crossDock: 'propose' }, { as: 'accountant' });

  // ---------- Déplacements : on range le stock de départ ----------
  const move = (f, itemId, from, to, quantity, as = 'storekeeper', expect) => D(`Entrepôt : déplacement — ${f}`, 'POST', `${W}/move`, { itemId, fromLocationId: L[from].id, toLocationId: L[to].id, quantity, reason: 'Mise en place des allées' }, { as, expect });
  const lv = async (id) => (await get('Entrepôt : stock par emplacement d\'un article', `${W}/items/${id}/levels`)).levels || [];
  const at = async (id, code) => { const x = (await lv(id)).find((l) => l.code === code); return x ? x.quantity : 0; };
  await move('ciment PRINCIPAL → A-01-01', I.ciment, 'PRINCIPAL', 'A-01-01', 400);
  await move('ciment PRINCIPAL → P-01 (comptoir)', I.ciment, 'PRINCIPAL', 'P-01', 100);
  await move('ciment PRINCIPAL → A-02-01', I.ciment, 'PRINCIPAL', 'A-02-01', Math.max(1, (await at(I.ciment, 'PRINCIPAL')) - 50));
  await move('fer HA 10 → B-01-01', I.fer10, 'PRINCIPAL', 'B-01-01', 300);
  await move('fer HA 10 → B-03-01', I.fer10, 'PRINCIPAL', 'B-03-01', Math.max(1, await at(I.fer10, 'PRINCIPAL')));
  await move('fer HA 12 → B-02-01', I.fer12, 'PRINCIPAL', 'B-02-01', Math.max(1, await at(I.fer12, 'PRINCIPAL')));
  await move('tôles → A-03-01', I.tole, 'PRINCIPAL', 'A-03-01', Math.max(1, await at(I.tole, 'PRINCIPAL')));
  await move('carreaux → C-01-01', I.carreau, 'PRINCIPAL', 'C-01-01', 150);
  await move('carreaux → C-01-02', I.carreau, 'PRINCIPAL', 'C-01-02', Math.max(1, await at(I.carreau, 'PRINCIPAL')));
  await move('parpaings → A-04-01', I.parpaing, 'PRINCIPAL', 'A-04-01', 600);
  await move('parpaings → B-04-01', I.parpaing, 'PRINCIPAL', 'B-04-01', Math.max(1, (await at(I.parpaing, 'PRINCIPAL')) - 1000));
  await move('tubes PVC → C-02-01', I.tuyau, 'PRINCIPAL', 'C-02-01', Math.max(1, await at(I.tuyau, 'PRINCIPAL')));
  await move('câble → P-02', I.cable, 'PRINCIPAL', 'P-02', Math.max(1, await at(I.cable, 'PRINCIPAL')));
  await move('brouettes → C-03-01', I.brouette, 'PRINCIPAL', 'C-03-01', 24);
  await move('pas plus que le stock de l\'emplacement', I.brouette, 'C-03-01', 'C-03-02', 500, 'storekeeper', 400);
  await move('« En transit » réservé aux transferts', I.ciment, 'A-01-01', 'TRANSIT', 1, 'storekeeper', 400);
  r = await get('Entrepôt : détail de l\'emplacement A-01-01', `${W}/locations/${L['A-01-01'].id}`);
  ctx.check('Entrepôt : A-01-01 contient du ciment', (r.content || []).some((c) => c.itemId === I.ciment), r.content);

  // Entrée au quai de réception puis rangement guidé.
  await D('Stock : arrivage de 150 sacs de ciment au quai de réception', 'POST', `/stock/items/${I.ciment}/move`, { kind: 'in', quantity: 150, unitCost: 4250, locationId: L['QUAI-REC'].id, reason: 'Arrivage camion Cimencam' }, { as: 'manager' });
  await D('Stock : arrivage de 40 cartons de carreaux au quai', 'POST', `/stock/items/${I.carreau}/move`, { kind: 'in', quantity: 40, locationId: L['QUAI-REC'].id, reason: 'Arrivage conteneur Espagne' }, { as: 'storekeeper' });
  r = await get('Entrepôt : marchandises à ranger (proposition selon les règles et la capacité)', `${W}/putaway/pending`, 'storekeeper');
  const task = (r.tasks || []).find((t) => t.itemId === I.ciment);
  ctx.check('Entrepôt : rangement proposé pour le ciment', task && task.suggestion && task.suggestion.length >= 1, r.tasks);
  await D('Entrepôt : ranger le ciment (proposition suivie)', 'POST', `${W}/putaway`, { itemId: I.ciment, fromLocationId: L['QUAI-REC'].id }, { as: 'storekeeper' });
  await D('Entrepôt : ranger les carreaux dans l\'emplacement choisi', 'POST', `${W}/putaway`, { itemId: I.carreau, fromLocationId: L['QUAI-REC'].id, toLocationId: L['C-01-01'].id }, { as: 'storekeeper' });
  await D('Stock : entrée sans emplacement (la règle de rangement décide)', 'POST', `/stock/items/${I.fer10}/move`, { kind: 'in', quantity: 50, unitCost: 3850, reason: 'Complément ADC' }, { as: 'manager' });
  await get('Entrepôt : niveaux du fer HA 10 par emplacement', `${W}/items/${I.fer10}/levels`, 'storekeeper');
  await get('Entrepôt : disponibilité du ciment (réservé, disponible)', `${W}/items/${I.ciment}/availability`, 'storekeeper');
  await D('Entrepôt : paramètres de réapprovisionnement du ciment', 'PUT', `${W}/items/${I.ciment}/params`, { leadDays: 5, safetyStock: 150, reorderPoint: 400, orderMultiple: 50 }, { as: 'manager' });
  await D('Entrepôt : paramètres du câble', 'PUT', `${W}/items/${I.cable}/params`, { leadDays: 3, safetyStock: 10, orderMultiple: 10 }, { as: 'manager' });
  await D('Entrepôt : délai fournisseur hors bornes refusé', 'PUT', `${W}/items/${I.tole}/params`, { leadDays: 900 }, { as: 'manager', expect: 400 });
  await get('Entrepôt : paramètres de réapprovisionnement', `${W}/items/${I.ciment}/params`);

  // ---------- Palettes et colis ----------
  r = await D('Entrepôt : réception sur palette au quai (tôles et tubes)', 'POST', `${W}/hus/receive`, { type: 'pallet', locationCode: 'QUAI-REC', reference: 'BL-ALU-55190', lines: [{ itemId: I.tole, quantity: 60 }, { itemId: I.tuyau, quantity: 50 }] }, { as: 'storekeeper' });
  const pal = r.id; const palCode = r.code;
  ctx.check('Entrepôt : palette PAL… créée', /^PAL\d{8}$/.test(palCode || ''), r);
  r = await D('Entrepôt : palette de peinture (lot et péremption)', 'POST', `${W}/hus/receive`, { type: 'pallet', locationCode: 'QUAI-REC', reference: 'BL-PAC-1201', lines: [{ itemId: I.peinture, quantity: 24, lotNo: 'PV-2611-R', expiry: ctx.day(480) }] }, { as: 'storekeeper' });
  const palPv = r.id;
  await get('Entrepôt : contenu de la palette (scan)', `${W}/hus/${pal}`, 'storekeeper');
  await get('Entrepôt : retrouver la palette par son code', `${W}/hus/lookup?code=${palCode}`, 'storekeeper');
  r = await D('Entrepôt : déplacer la palette en un scan (QUAI-REC → A-03-02)', 'POST', `${W}/hus/${pal}/move`, { toLocationCode: 'A-03-02' }, { as: 'storekeeper' });
  ctx.check('Entrepôt : palette en A-03-02', r.to === 'A-03-02', r);
  await D('Entrepôt : ranger la palette de peinture en C-03-04', 'POST', `${W}/hus/${palPv}/move`, { toLocationId: L['C-03-04'].id }, { as: 'storekeeper' });
  await D('Entrepôt : retirer 10 tôles de la palette (restent en vrac)', 'POST', `${W}/hus/${pal}/remove`, { itemId: I.tole, quantity: 10 }, { as: 'storekeeper' });
  await D('Entrepôt : remettre 5 tôles sur la palette', 'POST', `${W}/hus/${pal}/add`, { itemId: I.tole, quantity: 5 }, { as: 'storekeeper' });
  r = await D('Entrepôt : colis de 5 tôles posé sur la palette', 'POST', `${W}/hus`, { type: 'box', locationId: L['A-03-02'].id, parentId: pal, lines: [{ itemId: I.tole, quantity: 5 }], note: 'Tôles faîtières' }, { as: 'storekeeper' });
  const box = r.id;
  await D('Entrepôt : sortir le colis de la palette', 'POST', `${W}/hus/${box}/unnest`, {}, { as: 'storekeeper' });
  await D('Entrepôt : reposer le colis sur la palette (par code)', 'POST', `${W}/hus/${box}/nest`, { parentCode: palCode }, { as: 'storekeeper' });
  await D('Entrepôt : une palette ne va pas dans un colis', 'POST', `${W}/hus/${pal}/nest`, { parentId: box }, { as: 'storekeeper', expect: 400 });
  await D('Entrepôt : défaire le colis (contenu en vrac)', 'POST', `${W}/hus/${box}/unpack`, {}, { as: 'storekeeper' });
  await D('Entrepôt : supprimer une unité : réservé aux responsables', 'DELETE', `${W}/hus/${box}`, undefined, { as: 'storekeeper', expect: 403 });
  await D('Entrepôt : supprimer le colis vide', 'DELETE', `${W}/hus/${box}`, undefined, { as: 'manager' });
  r = await D('Entrepôt : étiquette de palette (PDF 100 × 150 mm, code 128)', 'GET', `${W}/hus/${pal}/label`, undefined, { as: 'storekeeper', raw: true });
  ctx.check('Entrepôt : étiquette PDF', r.buf && r.buf.subarray(0, 5).toString() === '%PDF-', r.status);
  await get('Entrepôt : palettes et colis en cours', `${W}/hus`, 'storekeeper');
  await get('Entrepôt : palettes contenant des tôles', `${W}/hus?itemId=${I.tole}`, 'storekeeper');
  st.hus = { tolePallet: pal, paintPallet: palPv };

  // ---------- Réception avec frais d'approche ----------
  await get('Entrepôt : types de frais et bases de répartition', `${W}/receipts/kinds`);
  const impLines = [{ itemId: I.groupe, quantity: 2, unitCost: 1380000, weight: 180, serials: 'GE75-20261101\nGE75-20261102' }, { itemId: I.carreau, quantity: 300, unitCost: 8200, weight: 32 }];
  const impCosts = [{ kind: 'transport', label: 'Fret maritime Valence → Douala', amount: 950000, basis: 'weight' }, { kind: 'customs', label: 'Droits de douane (DD + TVA import)', amount: 1150000, basis: 'value' }, { kind: 'handling', label: 'Manutention port autonome', amount: 120000, basis: 'quantity' }];
  r = await D('Entrepôt : aperçu de la répartition des frais d\'approche', 'POST', `${W}/receipts/preview`, { lines: impLines.map(({ serials, ...x }) => x), costs: impCosts }, { as: 'manager' });
  ctx.check('Entrepôt : 2 220 000 FCFA de frais répartis', r.landedCost === 2220000, r);
  r = await D('Entrepôt : réception d\'un conteneur avec frais d\'approche (coût de revient)', 'POST', `${W}/receipts`, { supplierId: S.transit, reference: 'Conteneur MSKU 778120-4', locationId: L['QUAI-REC'].id, lines: impLines, costs: impCosts }, { as: 'manager' });
  const rc = r.id;
  ctx.check('Entrepôt : réception RC-…', /^RC-/.test(r.code || ''), r);
  await D('Entrepôt : frais ajouté après coup (assurance)', 'POST', `${W}/receipts/${rc}/costs`, { kind: 'insurance', label: 'Assurance AXA facultés', amount: 85000, basis: 'value' }, { as: 'manager' });
  r = await get('Entrepôt : détail de la réception (coût unitaire de revient)', `${W}/receipts/${rc}`);
  ctx.check('Entrepôt : 2 305 000 FCFA de frais', r.receipt && r.receipt.landedCost === 2305000, r.receipt && r.receipt.landedCost);
  await D('Entrepôt : ranger les carreaux importés', 'POST', `${W}/putaway`, { itemId: I.carreau, fromLocationId: L['QUAI-REC'].id }, { as: 'storekeeper' });
  await D('Entrepôt : ranger les groupes électrogènes', 'POST', `${W}/putaway`, { itemId: I.groupe, fromLocationId: L['QUAI-REC'].id, toLocationId: L['C-03-03'].id }, { as: 'storekeeper' });
  r = await get('Entrepôt : réceptions d\'achat sans dossier de frais', `${W}/receipts/purchase-candidates`);
  const cand = (r.receipts || []).map((x) => x.id);
  if (ctx.check('Entrepôt : réceptions de commandes simples disponibles', cand.length >= 1, r)) {
    await D('Entrepôt : dossier de frais sur les réceptions de commandes (transport)', 'POST', `${W}/receipts/from-purchase`, { purchaseReceiptIds: cand, costs: [{ kind: 'transport', label: 'Camion Électro / Carrière', amount: 60000, basis: 'value' }] }, { as: 'manager' });
  }
  await get('Entrepôt : réceptions et frais d\'approche', `${W}/receipts`);
  await D('Entrepôt : réceptions réservées aux responsables', 'GET', `${W}/receipts`, undefined, { as: 'storekeeper', expect: 403 });

  // ---------- Transferts Douala → Yaoundé ----------
  r = await D('Entrepôt : transfert vers le même entrepôt refusé', 'POST', `${W}/transfers`, { fromWarehouseId: main, toWarehouseId: main, lines: [{ itemId: I.ciment, quantity: 1 }] }, { as: 'storekeeper', expect: 400 });
  r = await D('Entrepôt : demande de transfert Douala → Yaoundé (magasinier)', 'POST', `${W}/transfers`, { fromWarehouseId: main, toWarehouseId: yde, note: 'Réassort du dépôt de Mvan — chantiers Odza et Bastos', lines: [{ itemId: I.ciment, quantity: 200 }, { itemId: I.fer10, quantity: 80 }, { itemId: I.tole, quantity: 30 }] }, { as: 'storekeeper' });
  const tr = r.id;
  await D('Entrepôt : l\'expédition du transfert est réservée aux responsables', 'POST', `${W}/transfers/${tr}/ship`, {}, { as: 'storekeeper', expect: 403 });
  await D('Entrepôt : expédier le transfert (camion Douala → Yaoundé)', 'POST', `${W}/transfers/${tr}/ship`, {}, { as: 'owner' });
  r = await get('Entrepôt : stock « en transit »', `${W}/locations/${L.TRANSIT.id}`);
  ctx.check('Entrepôt : 200 sacs en transit', (r.content || []).some((c) => c.itemId === I.ciment && c.quantity === 200), r.content);
  const tl = ((await get('Entrepôt : détail du transfert', `${W}/transfers/${tr}`)).transfer || {}).lines || [];
  await D('Entrepôt : la personne qui a expédié ne réceptionne pas', 'POST', `${W}/transfers/${tr}/receive`, { lines: [] }, { as: 'owner', expect: 403 });
  // La réception doit être faite par une autre personne que l'expéditeur : en ligne, sans compte magasinier, le transfert reste « en route ».
  if (ctx.users.storekeeper) {
    r = await D('Entrepôt : réception à Yaoundé avec un écart (2 sacs percés)', 'POST', `${W}/transfers/${tr}/receive`, { lines: tl.map((l) => ({ lineId: l.id, receivedQty: l.itemId === I.ciment ? l.quantity - 2 : l.quantity, reason: l.itemId === I.ciment ? '2 sacs percés pendant le transport' : '' })) }, { as: 'manager' });
    ctx.check('Entrepôt : écart de 2 à l\'arrivée', r.gapQty === 2, r);
  }
  r = await D('Entrepôt : second transfert (tubes PVC)', 'POST', `${W}/transfers`, { fromWarehouseId: main, toWarehouseId: yde, lines: [{ itemId: I.tuyau, quantity: 40 }] }, { as: 'storekeeper' });
  await D('Entrepôt : le demandeur annule son transfert', 'POST', `${W}/transfers/${r.id}/cancel`, {}, { as: 'storekeeper' });
  r = await D('Entrepôt : transfert de carreaux', 'POST', `${W}/transfers`, { fromWarehouseId: main, toWarehouseId: yde, lines: [{ itemId: I.carreau, quantity: 60 }] }, { as: 'manager' });
  await D('Entrepôt : expédier le transfert de carreaux', 'POST', `${W}/transfers/${r.id}/ship`, {}, { as: 'manager' });
  await D('Entrepôt : annuler un transfert en transit (camion en panne)', 'POST', `${W}/transfers/${r.id}/cancel`, { reason: 'Camion en panne à Édéa : marchandise revenue au dépôt' }, { as: 'owner' });
  r = await D('Entrepôt : transfert de fer HA 12 (en route)', 'POST', `${W}/transfers`, { fromWarehouseId: main, toWarehouseId: yde, note: 'Chantier Immobilière des Collines', lines: [{ itemId: I.fer12, quantity: 60 }] }, { as: 'storekeeper' });
  await D('Entrepôt : expédier le fer HA 12', 'POST', `${W}/transfers/${r.id}/ship`, {}, { as: 'owner' });
  st.transferInTransit = r.id;
  await get('Entrepôt : liste des transferts', `${W}/transfers`, 'storekeeper');
  await D('Entrepôt : entrepôt avec historique de transferts : suppression refusée', 'DELETE', `${W}/warehouses/${yde}`, undefined, { as: 'manager', expect: 400 });

  // ---------- Commandes clients (devis acceptés) qui réservent le stock ----------
  const NAMES = { ...Object.fromEntries(require('./base').ITEMS.map((x) => [x[0], x[1]])), brouette: 'Brouette de chantier 90 L', fer8: 'Fer à béton HA 8 mm — barre 12 m' };
  const doc = async (key, lines, note) => {
    const x = await D(`Commerce : devis pour ${key} (lignes rattachées au stock)`, 'POST', '/crm/documents', { kind: 'quote', customerId: C[key], note, lines: lines.map(([k, q]) => ({ itemId: I[k], label: NAMES[k] || k, quantity: q, price: ctx.ids.prices[k] })) }, { as: 'manager' });
    if (x.id) await D('Commerce : devis accepté par le client', 'PUT', `/crm/documents/${x.id}`, { status: 'accepted' }, { as: 'manager' });
    return x.id;
  };
  const docs = st.documents = {};
  docs.sogea = await doc('sogea', [['fer12', 100], ['ciment', 80], ['fer10', 60]], 'Chantier immeuble R+5, Bonapriso');
  docs.bati = await doc('bati', [['tole', 30], ['carreau', 24], ['ciment', 40]], 'Villa Akwa Nord');
  docs.quinc = await doc('quinc', [['tuyau', 40], ['cable', 4], ['brouette', 4]], 'Réassort boutique');
  docs.hotel = await doc('hotel', [['peinture', 12], ['carreau', 30]], 'Rénovation des chambres');
  docs.mairie = await doc('mairie', [['parpaing', 800], ['ciment', 60]], 'Caniveaux de Kotto');
  docs.particulier = await doc('particulier', [['ciment', 25], ['fer8', 30]], 'Clôture Logpom');
  docs.immo = await doc('immo', [['fer8', 650]], 'Résidence Odza — dalles du R+2');

  // ---------- Réservations ----------
  r = await D('Entrepôt : demande interne de réservation (magasinier)', 'POST', `${W}/reservations`, { itemId: I.ciment, quantity: 20, label: 'Réfection du showroom d\'Akwa', kind: 'internal' }, { as: 'storekeeper' });
  const resInt = r.id;
  await D('Entrepôt : réservation libre réservée aux responsables', 'POST', `${W}/reservations`, { itemId: I.fer12, quantity: 10, label: 'Client', kind: 'manual' }, { as: 'storekeeper', expect: 403 });
  r = await D('Entrepôt : réservation libre pour un enlèvement samedi', 'POST', `${W}/reservations`, { itemId: I.brouette, quantity: 6, label: 'M. Etoundi — enlèvement samedi', kind: 'manual', expiresAt: ctx.day(4) }, { as: 'manager' });
  const resMan = r.id;
  await D('Entrepôt : réservation au-delà du disponible refusée', 'POST', `${W}/reservations`, { itemId: I.groupe, quantity: 500, label: 'Trop', kind: 'manual' }, { as: 'manager', expect: 400 });
  r = await D('Entrepôt : réserver le stock du devis de la Commune', 'POST', `${W}/reservations/from-document`, { documentId: docs.mairie, partial: true }, { as: 'manager' });
  ctx.check('Entrepôt : parpaings et ciment réservés pour la Commune', (r.reserved || []).length === 2, r);
  await D('Entrepôt : livraison partielle de la réservation interne', 'POST', `${W}/reservations/${resInt}/fulfill`, { quantity: 12 }, { as: 'manager' });
  await D('Entrepôt : le magasinier libère le reste de sa demande', 'POST', `${W}/reservations/${resInt}/release`, { reason: 'Travaux terminés' }, { as: 'storekeeper' });
  await D('Entrepôt : livraison de la réservation (M. Etoundi)', 'POST', `${W}/reservations/${resMan}/fulfill`, {}, { as: 'manager' });
  await get('Entrepôt : réservations actives', `${W}/reservations?status=active`, 'storekeeper');
  await get('Entrepôt : articles réservés et disponibles', `${W}/availability?onlyReserved=1`);
  r = await D('Stock : sortie libre qui empiéterait sur le stock réservé refusée', 'POST', `/stock/items/${I.parpaing}/move`, { kind: 'out', quantity: 5500, reason: 'Vente en gros' }, { as: 'storekeeper', expect: 400 });

  // ---------- Retours ----------
  await get('Entrepôt : motifs de retour', `${W}/returns/reasons`, 'storekeeper');
  await D('Entrepôt : un magasinier ne valide pas un retour', 'POST', `${W}/returns`, { kind: 'customer', customerId: C.bati, lines: [{ itemId: I.ciment, quantity: 2, reasonCode: 'defective' }], validate: true }, { as: 'storekeeper', expect: 403 });
  r = await D('Entrepôt : retour client Bâti Plus en brouillon (magasinier)', 'POST', `${W}/returns`, { kind: 'customer', customerId: C.bati, documentId: docs.bati, reason: 'Livraison du 12/11 contestée', lines: [{ itemId: I.ciment, quantity: 5, reasonCode: 'transport', disposition: 'quarantine' }, { itemId: I.tole, quantity: 2, reasonCode: 'wrong_order', disposition: 'restock' }, { itemId: I.carreau, quantity: 1, reasonCode: 'defective', disposition: 'scrap' }] }, { as: 'storekeeper' });
  const ret = r.id;
  await D('Entrepôt : valider le retour client', 'POST', `${W}/returns/${ret}/validate`, {}, { as: 'manager' });
  const qline = (((await get('Entrepôt : détail du retour', `${W}/returns/${ret}`)).return || {}).lines || []).find((l) => l.disposition === 'quarantine');
  await D('Entrepôt : décision — remettre en stock les sacs contrôlés', 'POST', `${W}/returns/${ret}/lines/${qline && qline.id}/dispose`, { disposition: 'restock' }, { as: 'manager' });
  r = await D('Entrepôt : retour client Hôtel La Falaise (à contrôler)', 'POST', `${W}/returns`, { kind: 'customer', customerId: C.hotel, lines: [{ itemId: I.peinture, quantity: 2, reasonCode: 'unsuitable', disposition: 'quarantine', lotNo: 'PV-2608-K' }], validate: true }, { as: 'manager' });
  const retH = r.id;
  const hl = (((await get('Entrepôt : retour à contrôler', `${W}/returns/${retH}`)).return || {}).lines || [])[0];
  await D('Entrepôt : décision — mise au rebut (peinture contaminée)', 'POST', `${W}/returns/${retH}/lines/${hl && hl.id}/dispose`, { disposition: 'scrap' }, { as: 'manager' });
  r = await D('Entrepôt : retour fournisseur ADC avec numéro RMA', 'POST', `${W}/returns`, { kind: 'supplier', supplierId: S.adc, purchaseOrderId: st.poFer, rmaNo: 'rma-adc-2611-07', reason: 'Barres fissurées détectées au stockage', lines: [{ itemId: I.fer12, quantity: 6, reasonCode: 'defective' }], validate: true }, { as: 'manager' });
  const retS = r.id;
  await D('Entrepôt : compléter le RMA (numéro corrigé)', 'PUT', `${W}/returns/${retS}/rma`, { rmaNo: 'RMA-ADC-2611-007' }, { as: 'manager' });
  await D('Entrepôt : avoir fournisseur reçu (6 barres)', 'POST', `${W}/returns/${retS}/credit`, { amount: 33600 }, { as: 'manager' });
  await D('Entrepôt : mise au rebut sans motif précis refusée', 'POST', `${W}/returns`, { kind: 'scrap', lines: [{ itemId: I.carreau, quantity: 1, reasonCode: 'other' }], validate: true }, { as: 'manager', expect: 400 });
  await D('Entrepôt : mise au rebut (casse au chariot élévateur)', 'POST', `${W}/returns`, { kind: 'scrap', reason: 'Palette renversée allée C', lines: [{ itemId: I.carreau, quantity: 3, reasonCode: 'breakage' }], validate: true }, { as: 'manager' });
  r = await D('Entrepôt : retour saisi par erreur', 'POST', `${W}/returns`, { kind: 'customer', customerId: C.quinc, lines: [{ itemId: I.tuyau, quantity: 1 }] }, { as: 'storekeeper' });
  await D('Entrepôt : annuler le brouillon de retour', 'POST', `${W}/returns/${r.id}/cancel`, {}, { as: 'storekeeper' });
  r = await get('Entrepôt : retours et avoirs fournisseurs', `${W}/returns`);
  ctx.check('Entrepôt : avoir fournisseur suivi', (r.returns || []).some((x) => x.id === retS && x.creditStatus === 'received'), r.returns);
  r = await get('Entrepôt : contenu de la quarantaine (peinture en contrôle)', `${W}/locations/${L.QUARANTAINE.id}`);
};
