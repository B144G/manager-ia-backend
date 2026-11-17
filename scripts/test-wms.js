'use strict';
// Stock entrepôt (WMS) : emplacements, cohérence stock total / stock par emplacement, rangement, transferts, réservations, préparation, retours,
// coûts d'arrivée, ABC, inventaire tournant, prévisions, rapports, scan. Lancez-le avec : node scripts/test-wms.js
const { run } = require('./lib/wave1');

run('Stock entrepôt (WMS)', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx }) => {
  const WM = `${O}/stock/wms`;
  let r;
  /** Invariant : pour chaque article, somme par emplacement = quantité totale. */
  const coherent = async () => {
    const bad = await dbx.prepare('SELECT i.id, i.name, i.quantity, COALESCE((SELECT SUM(s.quantity) FROM wms_stock s WHERE s.item_id = i.id), 0) AS loc FROM stock_items i WHERE i.org_id = ?').all(org);
    return bad.filter((x) => Math.abs(Number(x.quantity) - Number(x.loc)) > 1e-6);
  };

  // ---------- Stock existant avant le WMS ----------
  r = await owner('POST', `${O}/stock/items`, { name: 'Riz 25 kg', unit: 'sac', quantity: 100, unitCost: 15000, minQuantity: 20, barcode: 'RIZ00025', sku: 'RIZ-25' });
  const riz = r.json.id;
  r = await owner('POST', `${O}/stock/items`, { name: 'Huile 5 L', unit: 'bidon', quantity: 40, unitCost: 6000 });
  const huile = r.json.id;
  r = await owner('POST', `${O}/stock/items`, { name: 'Téléphone X', unit: 'pièce', tracking: 'serial', unitCost: 50000 });
  const tel = r.json.id;
  check('préparation : articles créés', riz && huile && tel, r.json);

  // ---------- Structure ----------
  r = await mem('GET', `${WM}/overview`);
  check('vue : entrepôt principal créé automatiquement, libellés des types', r.status === 200 && r.json.warehouses.length === 1 && r.json.warehouses[0].isDefault && r.json.kinds.transit === 'En transit' && r.json.warehouses[0].value === undefined, r.json);
  r = await owner('GET', `${WM}/locations`);
  const locs = r.json.locations;
  const PRINC = locs.find((l) => l.code === 'PRINCIPAL');
  check('emplacements de départ : Principal, En transit, Retours, Quarantaine', ['PRINCIPAL', 'TRANSIT', 'RETOURS', 'QUARANTAINE'].every((c) => locs.some((l) => l.code === c)) && PRINC.isDefault && PRINC.usable && PRINC.capacity === null, locs);
  check('stock existant rangé dans « Principal »', PRINC.quantity === 140 && PRINC.value === 100 * 15000 + 40 * 6000, PRINC);
  check('cohérence : total = somme des emplacements', (await coherent()).length === 0, await coherent());
  r = await other('GET', `${ws(org2)}/stock/wms/locations/${PRINC.id}`);
  check('cloisonnement : emplacement d\'une autre organisation introuvable', r.status === 404, r.status);

  r = await mem('POST', `${WM}/warehouses`, { name: 'Pirate' });
  check('entrepôt : un membre ne crée pas d\'entrepôt', r.status === 403, r.status);
  r = await owner('POST', `${WM}/warehouses`, { name: 'Dépôt Yaoundé', code: 'YDE', address: 'Mvan' });
  const yde = r.json.id;
  check('entrepôt créé avec son emplacement principal', r.status === 201, r.json);
  r = await owner('POST', `${WM}/warehouses`, { name: 'Autre', code: 'yde' });
  check('entrepôt : code en double refusé', r.status === 409 && r.json.error === "Ce code d'entrepôt existe déjà.", r.json);
  const mainWh = (await owner('GET', `${WM}/overview`)).json.warehouses.find((w) => w.isDefault).id;
  r = await owner('PUT', `${WM}/warehouses/${mainWh}`, { active: false });
  check('entrepôt principal : ne se désactive pas', r.status === 400, r.json);
  r = await owner('POST', `${WM}/zones`, { warehouseId: mainWh, name: 'Froid', kind: 'storage' });
  const zone = r.json.id;
  r = await owner('POST', `${WM}/zones`, { warehouseId: mainWh, name: 'froid' });
  check('zone : code en double refusé', r.status === 409, r.json);
  r = await owner('POST', `${WM}/locations/bulk`, { warehouseId: mainWh, aisles: 'A, B', racks: '2', bins: '2', zoneId: String(zone), capacity: '50' });
  check('création en série : 8 emplacements', r.status === 201 && r.json.created === 8 && r.json.skipped === 0, r.json);
  r = await owner('POST', `${WM}/locations/bulk`, { warehouseId: mainWh, aisles: 'A', racks: '2', bins: '3' });
  check('création en série : les codes existants sont ignorés', r.json.created === 2 && r.json.skipped === 4, r.json);
  r = await owner('POST', `${WM}/locations/bulk`, { warehouseId: mainWh, aisles: 'A,B,C,D', racks: '10', bins: '10' });
  check('création en série : 300 au plus', r.status === 400, r.json);
  r = await owner('POST', `${WM}/locations`, { warehouseId: mainWh, code: 'quai-1', kind: 'reception' });
  check('emplacement de réception créé (code en majuscules)', r.status === 201 && r.json.code === 'QUAI-1', r.json);
  r = await owner('POST', `${WM}/locations`, { warehouseId: mainWh, code: 'QUAI-1' });
  check('emplacement : code unique dans l\'organisation', r.status === 409, r.json);
  const L = Object.fromEntries((await owner('GET', `${WM}/locations`)).json.locations.map((l) => [l.code, l]));
  r = await owner('PUT', `${WM}/locations/${PRINC.id}`, { active: false });
  check('emplacement par défaut : ne se désactive pas', r.status === 400 && r.json.error === "L'emplacement par défaut ne peut pas être désactivé.", r.json);
  r = await owner('DELETE', `${WM}/locations/${L.TRANSIT.id}`);
  check('« En transit » : indispensable', r.status === 400, r.json);

  // ---------- Déplacements et rangement ----------
  r = await mem('POST', `${WM}/move`, { itemId: riz, fromLocationId: PRINC.id, toLocationId: L['A-01-01'].id, quantity: '30' });
  check('déplacement entre emplacements', r.status === 200, r.json);
  r = await owner('POST', `${WM}/move`, { itemId: riz, fromLocationId: L['A-01-01'].id, toLocationId: L['A-01-02'].id, quantity: '31' });
  check('déplacement : pas plus que le stock de l\'emplacement', r.status === 400 && r.json.error === 'Pas assez de stock dans cet emplacement.', r.json);
  r = await owner('POST', `${WM}/move`, { itemId: riz, fromLocationId: PRINC.id, toLocationId: L.TRANSIT.id, quantity: '1' });
  check('déplacement : « En transit » réservé aux transferts', r.status === 400, r.json);
  r = await owner('POST', `${WM}/move`, { itemId: riz, fromLocationId: PRINC.id, toLocationId: PRINC.id, quantity: '1' });
  check('déplacement : même emplacement refusé', r.status === 400, r.json);
  r = await owner('GET', `${WM}/items/${riz}/levels`);
  check('niveaux : 70 au principal, 30 en A-01-01', r.json.quantity === 100 && r.json.levels.find((l) => l.code === 'A-01-01').quantity === 30 && r.json.usable === 100, r.json);

  r = await owner('POST', `${WM}/putaway-rules`, { locationId: L['B-01-01'].id });
  check('règle : article ou type de suivi exigé', r.status === 400 && /article ou un type de suivi/.test(r.json.error), r.json);
  r = await owner('POST', `${WM}/putaway-rules`, { itemId: String(huile), locationId: L['B-01-01'].id, priority: '1' });
  r = await owner('POST', `${WM}/putaway-rules`, { itemId: String(huile), locationId: L['B-01-02'].id, priority: '2' });
  r = await owner('GET', `${WM}/putaway-rules`);
  check('règles de rangement listées', r.json.rules.length === 2 && r.json.rules[0].item === 'Huile 5 L', r.json);
  // Entrée au quai de réception, puis rangement proposé (capacité 50 → répartition sur deux emplacements)
  r = await owner('POST', `${O}/stock/items/${huile}/move`, { kind: 'in', quantity: 70, locationId: L['QUAI-1'].id, reason: 'Arrivage' });
  check('entrée au quai de réception', r.status === 200 && r.json.quantity === 110, r.json);
  r = await mem('GET', `${WM}/putaway/pending`);
  const task = r.json.tasks.find((t) => t.itemId === huile);
  check('rangement : tâche proposée, répartie selon la capacité (50 + 20)', task && task.quantity === 70 && task.suggestion.length === 2 && task.suggestion[0].code === 'B-01-01' && task.suggestion[0].quantity === 50 && task.suggestion[1].quantity === 20, task);
  r = await mem('POST', `${WM}/putaway`, { itemId: huile, fromLocationId: L['QUAI-1'].id });
  check('rangement effectué', r.status === 200, r.json);
  r = await owner('GET', `${WM}/locations/${L['B-01-01'].id}`);
  check('rangement : B-01-01 contient 50 bidons', r.json.content.find((c) => c.itemId === huile).quantity === 50, r.json);
  // Entrée sans emplacement : les règles décident
  r = await owner('POST', `${O}/stock/items/${huile}/move`, { kind: 'in', quantity: 10 });
  r = await owner('GET', `${WM}/items/${huile}/levels`);
  check('entrée sans emplacement : règle de rangement appliquée', r.json.levels.find((l) => l.code === 'B-01-02').quantity === 30, r.json.levels);
  check('cohérence après entrées et rangements', (await coherent()).length === 0, await coherent());

  // ---------- Réservations ----------
  r = await mem('POST', `${WM}/reservations`, { itemId: riz, quantity: '10', label: 'Cantine', kind: 'manual' });
  check('réservation libre : réservée aux responsables', r.status === 403, r.json);
  r = await mem('POST', `${WM}/reservations`, { itemId: riz, quantity: '10', label: 'Cantine du personnel', kind: 'internal' });
  check('demande interne : réservation créée par un membre', r.status === 201, r.json);
  const res1 = r.json.id;
  r = await owner('POST', `${WM}/reservations`, { itemId: riz, quantity: '500', label: 'Trop', kind: 'manual' });
  check('réservation : pas plus que le disponible', r.status === 400, r.json);
  r = await owner('GET', `${O}/stock`);
  const rz = r.json.items.find((i) => i.id === riz);
  check('stock : réservé et disponible affichés', rz.reserved === 10 && rz.available === 90, rz);
  r = await owner('POST', `${O}/stock/items/${riz}/move`, { kind: 'out', quantity: 95, reason: 'Vente' });
  check('sortie libre : ne prend pas le stock réservé', r.status === 400 && /réservé/.test(r.json.error), r.json);
  r = await owner('POST', `${WM}/reservations/${res1}/fulfill`, { quantity: '4' });
  check('réservation : livraison partielle', r.status === 200, r.json);
  r = await owner('GET', `${WM}/reservations?status=active`);
  const rv = r.json.reservations.find((x) => x.id === res1);
  check('réservation : reste 6, source « Demande interne »', rv.remaining === 6 && rv.sourceLabel === 'Demande interne', rv);
  r = await mem('POST', `${WM}/reservations/${res1}/release`, { reason: 'Annulé' });
  check('réservation : libérée par son auteur (demande interne)', r.status === 200, r.json);
  r = await owner('GET', `${WM}/availability?onlyReserved=1`);
  check('disponibilité : plus rien de réservé', r.json.reservedItems === 0, r.json);

  // Réservation depuis une commande client
  r = await owner('POST', `${O}/crm/customers`, { name: 'Boutique Ali' });
  const cust = r.json.id;
  const now = new Date().toISOString();
  const doc = Number((await dbx.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, issued, created_by, created_at, updated_at) VALUES (?, ?, 'order', 'CMD-001', 'pending', ?, 0, ?, 1, ?, ?) RETURNING id").get(org, cust, JSON.stringify([{ itemId: riz, label: 'Riz', quantity: 20, price: 16000 }, { itemId: huile, label: 'Huile', quantity: 5, price: 7000 }, { label: 'Livraison', quantity: 1, price: 2000 }]), now.slice(0, 10), now, now)).id);
  r = await owner('POST', `${WM}/reservations/from-document`, { documentId: doc, partial: false });
  check('réservation depuis une commande : 2 articles réservés', r.status === 200 && r.json.reserved.length === 2 && r.json.short.length === 0, r.json);
  r = await owner('POST', `${WM}/reservations/from-document`, { documentId: doc, partial: false });
  check('réservation depuis une commande : pas de doublon', r.json.reserved.length === 2 && (await owner('GET', `${WM}/items/${riz}/availability`)).json.reserved === 20, r.json);

  // ---------- Préparation (picking) ----------
  r = await owner('POST', `${WM}/picks`, { documentId: doc, priority: 1 });
  check('liste de préparation créée depuis la commande (PR-)', r.status === 201 && /^PR-/.test(r.json.code), r.json);
  const pick = r.json.id;
  r = await owner('GET', `${WM}/reservations?status=active`);
  check('préparation : la réservation de la commande est reprise par la liste', r.json.reservations.filter((x) => x.sourceKind === 'pick').length === 2 && !r.json.reservations.some((x) => x.sourceKind === 'document'), r.json.reservations);
  r = await mem('GET', `${WM}/picks/${pick}`);
  const pl = r.json.pick.lines;
  check('préparation : lignes avec emplacement (tournée)', pl.length >= 2 && pl.every((l) => l.location) && r.json.pick.toPick === 25, r.json.pick);
  const rizLine = pl.find((l) => l.itemId === riz);
  r = await mem('POST', `${WM}/picks/${pick}/lines/${rizLine.id}/confirm`, { itemCode: 'MAUVAIS' });
  check('scan : mauvais article refusé', r.status === 400, r.json);
  r = await mem('POST', `${WM}/picks/${pick}/lines/${rizLine.id}/confirm`, { itemCode: 'RIZ00025', locationCode: rizLine.location });
  check('prélèvement confirmé au scan', r.status === 200 && r.json.done, r.json);
  r = await mem('POST', `${WM}/picks/${pick}/complete`, { allowShort: false });
  check('terminer avec des lignes ouvertes : confirmation demandée (409)', r.status === 409, r.json);
  r = await mem('POST', `${WM}/picks/${pick}/complete`, { allowShort: true });
  check('terminer quand même', r.status === 200, r.json);
  const before = Number((await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(riz)).quantity);
  r = await mem('POST', `${WM}/picks/${pick}/issue`, {});
  check('sortie de la liste : réservée aux responsables', r.status === 403, r.status);
  r = await owner('POST', `${WM}/picks/${pick}/issue`, {});
  check('sortie de stock de la liste', r.status === 200, r.json);
  const after = Number((await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(riz)).quantity);
  check('sortie : 20 sacs de riz sortis, rien de plus', before - after === 20, [before, after]);
  r = await owner('GET', `${WM}/items/${huile}/availability`);
  check('ligne non prélevée : la réservation est libérée', r.json.reserved === 0, r.json);
  check('cohérence après préparation', (await coherent()).length === 0, await coherent());

  // ---------- Transferts ----------
  r = await mem('POST', `${WM}/transfers`, { fromWarehouseId: mainWh, toWarehouseId: mainWh, lines: [{ itemId: riz, quantity: '5' }] });
  check('transfert : même entrepôt refusé', r.status === 400, r.json);
  r = await mem('POST', `${WM}/transfers`, { fromWarehouseId: mainWh, toWarehouseId: yde, note: 'Approvisionnement', lines: [{ itemId: riz, quantity: '10' }, { itemId: huile, quantity: '6' }] });
  check('transfert demandé par un membre (TR-)', r.status === 201 && /^TR-/.test(r.json.code), r.json);
  const tr = r.json.id;
  r = await mem('POST', `${WM}/transfers/${tr}/ship`, {});
  check('expédition : réservée aux responsables', r.status === 403, r.status);
  r = await owner('POST', `${WM}/transfers/${tr}/ship`, {});
  check('transfert expédié', r.status === 200, r.json);
  r = await owner('GET', `${WM}/locations/${L.TRANSIT.id}`);
  check('en transit : 10 riz et 6 huile', r.json.content.find((c) => c.itemId === riz).quantity === 10 && r.json.content.find((c) => c.itemId === huile).quantity === 6, r.json.content);
  r = await owner('GET', `${WM}/items/${riz}/availability`);
  check('en transit : ne compte pas comme disponible', r.json.usable === r.json.quantity - 10, r.json);
  const lines = (await owner('GET', `${WM}/transfers/${tr}`)).json.transfer.lines;
  r = await owner('POST', `${WM}/transfers/${tr}/receive`, { lines: [] });
  check('réception : pas par la personne qui a expédié', r.status === 403, r.json);
  await dbx.prepare("UPDATE org_members SET role = 'manager' WHERE org_id = ? AND user_id = (SELECT id FROM users WHERE name = 'Marc')").run(org);
  r = await mgr('POST', `${WM}/transfers/${tr}/receive`, { lines: [{ lineId: lines.find((l) => l.itemId === riz).id, receivedQty: '9', reason: 'Sac percé' }, { lineId: lines.find((l) => l.itemId === huile).id, receivedQty: '6' }] });
  check('transfert reçu avec un écart de 1', r.status === 200 && r.json.gapQty === 1, r.json);
  r = await owner('GET', `${WM}/transfers/${tr}`);
  const t2 = r.json.transfer;
  check('transfert : statut reçu, écart valorisé, journal complet', t2.status === 'received' && t2.lines.find((l) => l.itemId === riz).gapValue === 15000 && t2.journal.map((j) => j.action).join(',') === 'requested,shipped,received', t2);
  r = await owner('GET', `${WM}/locations?warehouseId=${yde}`);
  check('arrivée : stock dans l\'entrepôt de Yaoundé', r.json.locations[0].quantity === 15, r.json.locations);
  check('cohérence après transfert', (await coherent()).length === 0, await coherent());
  r = await owner('DELETE', `${WM}/warehouses/${yde}`);
  check('entrepôt avec historique de transferts : ne se supprime pas', r.status === 400, r.json);

  // ---------- Retours ----------
  r = await owner('GET', `${WM}/returns/reasons`);
  check('motifs de retour : « Autre » partout', ['customer', 'supplier', 'scrap'].every((k) => r.json.reasons[k].other), r.json);
  r = await mem('POST', `${WM}/returns`, { kind: 'customer', customerId: cust, lines: [{ itemId: riz, quantity: '2', reasonCode: 'defective', disposition: 'quarantine' }], validate: true });
  check('retour : un membre ne valide pas', r.status === 403, r.json);
  r = await mem('POST', `${WM}/returns`, { kind: 'customer', customerId: cust, documentId: doc, lines: [{ itemId: riz, quantity: '2', reasonCode: 'defective', disposition: 'quarantine' }, { itemId: huile, quantity: '1', reasonCode: 'unsuitable', disposition: 'restock' }], validate: false });
  check('retour client en brouillon', r.status === 201 && /^RT-/.test(r.json.code), r.json);
  const ret = r.json.id;
  r = await owner('POST', `${WM}/returns/${ret}/validate`, {});
  check('retour validé', r.status === 200, r.json);
  r = await owner('GET', `${WM}/returns`);
  check('retour : 1 ligne à décider (à contrôler)', r.json.toDecide === 1 && r.json.returns[0].pending, r.json);
  r = await owner('GET', `${WM}/items/${riz}/levels`);
  check('retour à contrôler : en emplacement Retours, non disponible', r.json.levels.some((l) => l.code === 'RETOURS' && l.quantity === 2 && !l.usable), r.json.levels);
  const rl = (await owner('GET', `${WM}/returns/${ret}`)).json.return.lines.find((l) => l.disposition === 'quarantine');
  r = await owner('POST', `${WM}/returns/${ret}/lines/${rl.id}/dispose`, { disposition: 'scrap' });
  check('décision : mise au rebut', r.status === 200, r.json);
  r = await owner('POST', `${WM}/returns/${ret}/lines/${rl.id}/dispose`, { disposition: 'scrap' });
  check('décision : pas deux fois', r.status === 400, r.json);
  r = await owner('POST', `${WM}/returns`, { kind: 'scrap', lines: [{ itemId: huile, quantity: '1', reasonCode: 'other' }], validate: true });
  check('rebut : motif exigé pour « Autre »', r.status === 400 && r.json.error === 'Précisez le motif de la mise au rebut.', r.json);
  r = await owner('POST', `${WM}/returns`, { kind: 'scrap', lines: [{ itemId: huile, quantity: '1', reasonCode: 'breakage' }], validate: true });
  check('mise au rebut validée', r.status === 201, r.json);
  r = await owner('POST', `${WM}/returns`, { kind: 'supplier', lines: [{ itemId: riz, quantity: '1', reasonCode: 'damaged' }], validate: true });
  const sret = r.json.id;
  r = await owner('POST', `${WM}/returns/${sret}/credit`, { amount: '15000' });
  check('retour fournisseur : avoir enregistré', r.status === 200 && (await owner('GET', `${WM}/returns/${sret}`)).json.return.creditAmount === 15000, r.json);
  // Retour d'un lot : il garde sa péremption, et le rebut sort de ce lot (pas du lot périmé, premier en FEFO).
  const dd = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  r = await owner('POST', `${O}/stock/items`, { name: 'Lait UHT 1 L', unit: 'brique', tracking: 'lot', unitCost: 700 });
  const lait = r.json.id;
  await owner('POST', `${O}/stock/items/${lait}/move`, { kind: 'in', quantity: 10, lotNo: 'L-1', expiry: dd(200) });
  await owner('POST', `${O}/stock/items/${lait}/move`, { kind: 'in', quantity: 2, lotNo: 'L-0', expiry: dd(-5) });
  await owner('POST', `${O}/stock/items/${lait}/move`, { kind: 'out', quantity: 4 });
  r = await owner('POST', `${WM}/returns`, { kind: 'customer', customerId: cust, lines: [{ itemId: lait, quantity: '2', reasonCode: 'defective', disposition: 'quarantine', lotNo: 'L-1' }], validate: true });
  let lotsL = await dbx.prepare('SELECT lot_no, expiry, quantity FROM stock_lots WHERE item_id = ? AND quantity > 0 ORDER BY id').all(lait);
  check('retour d\'un lot : remis dans le même lot, péremption gardée', lotsL.length === 2 && lotsL.find((l) => l.lot_no === 'L-1').expiry === dd(200) && Number(lotsL.find((l) => l.lot_no === 'L-1').quantity) === 8, lotsL);
  const ll = (await owner('GET', `${WM}/returns/${r.json.id}`)).json.return.lines[0];
  await owner('POST', `${WM}/returns/${r.json.id}/lines/${ll.id}/dispose`, { disposition: 'scrap' });
  lotsL = Object.fromEntries((await dbx.prepare('SELECT lot_no, quantity FROM stock_lots WHERE item_id = ?').all(lait)).map((l) => [l.lot_no, Number(l.quantity)]));
  check('rebut d\'un retour : sort du lot retourné (L-1 : 6), pas du lot périmé (L-0 : 2)', lotsL['L-1'] === 6 && lotsL['L-0'] === 2, lotsL);
  check('cohérence après retours', (await coherent()).length === 0, await coherent());

  // ---------- Réception avec coûts d'arrivée ----------
  r = await owner('POST', `${WM}/receipts/preview`, { lines: [{ itemId: riz, quantity: '10', unitCost: '15000' }, { itemId: huile, quantity: '10', unitCost: '5000' }], costs: [{ kind: 'transport', amount: '40000', basis: 'value' }] });
  check('aperçu : frais répartis selon la valeur (30 000 / 10 000)', r.json.lines[0].landedTotal === 30000 && r.json.lines[1].landedTotal === 10000 && r.json.lines[0].landedUnit === 18000 && r.json.landedCost === 40000, r.json);
  r = await owner('POST', `${WM}/receipts/preview`, { lines: [{ itemId: riz, quantity: '10', unitCost: '15000' }], costs: [{ kind: 'transport', amount: '1000', basis: 'weight' }] });
  check('répartition au poids : poids exigé', r.status === 400 && /poids/.test(r.json.error), r.json);
  const avgBefore = Number((await dbx.prepare('SELECT avg_cost, quantity FROM stock_items WHERE id = ?').get(huile)).avg_cost);
  r = await owner('POST', `${WM}/receipts`, { reference: 'BL-99', locationId: L['QUAI-1'].id, lines: [{ itemId: huile, quantity: '10', unitCost: '6000' }], costs: [{ kind: 'customs', amount: '10000', basis: 'quantity' }] });
  check('réception avec frais (RC-)', r.status === 201 && /^RC-/.test(r.json.code), r.json);
  const rc = r.json.id;
  const hu = await dbx.prepare('SELECT avg_cost, quantity FROM stock_items WHERE id = ?').get(huile);
  check('CUMP : les frais d\'arrivée sont intégrés au coût moyen', Number(hu.avg_cost) > avgBefore, [avgBefore, hu.avg_cost]);
  r = await owner('POST', `${WM}/receipts/${rc}/costs`, { kind: 'transport', amount: '5000', basis: 'value', label: 'Camion' });
  check('frais ajouté après coup', r.status === 201, r.json);
  r = await owner('GET', `${WM}/receipts/${rc}`);
  check('réception : coûts, intégré + à passer en charge = total', r.json.receipt.landedCost === 15000 && r.json.receipt.incorporated + r.json.receipt.expensed === 15000 && r.json.receipt.costs.length === 2, r.json.receipt);
  r = await owner('GET', `${WM}/receipts`);
  check('réceptions listées', r.json.receipts.length === 1 && r.json.receipts[0].landedCost === 15000, r.json);
  r = await mem('GET', `${WM}/receipts`);
  check('réceptions : réservées aux responsables', r.status === 403, r.status);

  // ---------- Analyses ----------
  r = await owner('GET', `${WM}/abc`);
  check('ABC : classes A/B/C et parts cumulées', r.status === 200 && r.json.classes.length === 3 && r.json.items.length >= 3 && r.json.items[0].class === 'A', r.json);
  r = await owner('PUT', `${WM}/settings`, { abcA: 95, abcB: 80 });
  check('réglages : seuil A < seuil B', r.status === 400 && r.json.error === 'Le seuil A doit être plus petit que le seuil B.', r.json);
  r = await mgr('PUT', `${WM}/settings`, { abcA: 70 });
  check('réglages : réservés aux administrateurs', r.status === 403, r.status);
  r = await owner('GET', `${WM}/cycle-counts/plan`);
  check('inventaire tournant : tout est à compter au départ', r.json.dueItems.length >= 2, r.json);
  r = await owner('POST', `${WM}/cycle-counts`, { classes: ['A'] });
  check('inventaire tournant ouvert (classe A)', r.status === 201 && r.json.items >= 1, r.json);
  r = await owner('POST', `${WM}/cycle-counts`, { classes: ['B'] });
  check('inventaire tournant : un seul en cours', r.status === 409, r.json);
  r = await owner('GET', `${WM}/cycle-counts/variance`);
  check('écarts d\'inventaire : réponse valide', r.status === 200 && r.json.classes.length === 3, r.json);
  r = await owner('PUT', `${WM}/items/${riz}/params`, { leadDays: 400 });
  check('paramètres : délai fournisseur borné', r.status === 400 && /Délai fournisseur/.test(r.json.error), r.json);
  r = await owner('PUT', `${WM}/items/${riz}/params`, { leadDays: 10, safetyStock: 20, reorderPoint: null, orderMultiple: 10 });
  r = await owner('GET', `${WM}/items/${riz}/params`);
  check('paramètres de réapprovisionnement enregistrés', r.json.params.leadDays === 10 && r.json.params.reorderPoint === null, r.json);
  r = await owner('GET', `${WM}/forecast`);
  check('prévisions : séries hebdomadaires', r.status === 200 && r.json.items.some((i) => i.itemId === riz && i.series.length === r.json.weeksWindow && i.avgWeekly > 0), r.json);
  await dbx.prepare('UPDATE stock_items SET min_quantity = 200 WHERE id = ?').run(riz);
  r = await owner('GET', `${WM}/reorder`);
  const sg = r.json.suggestions.find((x) => x.itemId === riz);
  check('réapprovisionnement : suggestion avec point de commande et multiple de 10', sg && sg.toOrder > 0 && sg.toOrder % 10 === 0 && ['critical', 'soon'].includes(sg.urgency), r.json);

  // ---------- Rapports ----------
  r = await owner('GET', `${WM}/reports/valuation`);
  const total = Number((await dbx.prepare('SELECT SUM(quantity * CASE WHEN avg_cost > 0 THEN avg_cost ELSE unit_cost END) AS v FROM stock_items WHERE org_id = ?').get(org)).v);
  check('valorisation par emplacement = valeur du stock', Math.abs(r.json.totalValue - total) <= r.json.lines.length, [r.json.totalValue, total]);
  r = await owner('GET', `${WM}/reports/valuation?format=csv`);
  check('valorisation : export CSV', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.includes('Riz 25 kg'), r.text.slice(0, 120));
  r = await mem('GET', `${WM}/reports/valuation`);
  check('valorisation : réservée aux responsables', r.status === 403, r.status);
  r = await mem('GET', `${WM}/reports/stockouts`);
  check('ruptures : riz sous le seuil, sans valeur pour un membre', r.json.items.some((i) => i.itemId === riz && i.kind === 'low' && i.value === undefined), r.json);
  r = await owner('GET', `${WM}/reports/rotation`);
  check('rotation : réponse valide', r.status === 200 && Array.isArray(r.json.items), r.json);
  r = await owner('GET', `${WM}/reports/aging`);
  check('vieillissement : 5 tranches', r.json.buckets.length === 5 && r.json.buckets[0].label === '0-30 jours', r.json);
  r = await mem('GET', `${WM}/reports/moves?limit=50`);
  const mv = r.json.moves;
  check('journal : entrées, sorties et déplacements internes, sans valeur pour un membre', mv.some((m) => m.type === 'in') && mv.some((m) => m.type === 'out') && mv.some((m) => m.type === 'internal' && m.from && m.to) && mv.every((m) => m.value === undefined), mv.slice(0, 5));
  r = await owner('GET', `${WM}/reports/moves?kind=internal&limit=10`);
  check('journal : filtre « déplacements »', r.json.moves.every((m) => m.type === 'internal'), r.json.moves);

  // ---------- Scan ----------
  r = await mem('GET', `${WM}/scan?code=RIZ-25`);
  check('scan : article par SKU', r.json.type === 'item' && r.json.id === riz, r.json);
  r = await mem('GET', `${WM}/scan?code=a-01-01`);
  check('scan : emplacement', r.json.type === 'location' && r.json.label === 'A-01-01', r.json);
  r = await mem('GET', `${WM}/scan?code=${encodeURIComponent((await owner('GET', `${WM}/picks/${pick}`)).json.pick.code)}`);
  check('scan : liste de préparation', r.json.type === 'pick', r.json);
  r = await mem('GET', `${WM}/scan?code=INCONNU`);
  check('scan : code inconnu', r.status === 404 && r.json.error === 'Code inconnu : ni article, ni emplacement, ni document.', r.json);
  r = await mem('GET', `${WM}/locations/lookup?code=quai-1`);
  check('recherche d\'emplacement par code', r.json.location.code === 'QUAI-1', r.json);

  check('cohérence finale : total = somme des emplacements pour chaque article', (await coherent()).length === 0, await coherent());
});
