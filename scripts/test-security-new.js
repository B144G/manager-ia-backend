'use strict';
// Sécurité des modules récents (Bibliothèque, Achats, Stock entrepôt) : doubles envois et accès concurrents (stock, paiements, approbations),
// quarantaine contournée par un simple membre, verrouillage des mots de passe de la Bibliothèque. Lancez-le avec : node scripts/test-security-new.js
const { run } = require('./lib/wave1');

const both = (a, b) => Promise.all([a, b]);
const many = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

run('Sécurité : Bibliothèque, Achats, Stock entrepôt', async ({ check, owner, mgr, mem, org, O, dbx }) => {
  const WM = `${O}/stock/wms`;
  const PU = `${O}/purchasing`;
  const today = new Date().toISOString().slice(0, 10);
  let r;
  const coherent = async () => {
    const a = await dbx.prepare('SELECT i.id, i.quantity, COALESCE((SELECT SUM(s.quantity) FROM wms_stock s WHERE s.item_id = i.id), 0) AS loc FROM stock_items i WHERE i.org_id = ?').all(org);
    return a.filter((x) => Math.abs(Number(x.quantity) - Number(x.loc)) > 1e-6);
  };
  const qtyOf = async (id) => Number((await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(id)).quantity);
  const atLoc = async (loc, id) => Number(((await dbx.prepare('SELECT quantity FROM wms_stock WHERE location_id = ? AND item_id = ?').get(loc, id)) || {}).quantity || 0);
  const newItem = async (name, quantity) => {
    const x = await owner('POST', `${O}/stock/items`, { name, unit: 'u', unitCost: 1000 });
    if (quantity) await owner('POST', `${O}/stock/items/${x.json.id}/move`, { kind: 'in', quantity, reason: 'Stock initial' });
    return x.json.id;
  };

  const wh = (await owner('GET', `${WM}/overview`)).json.warehouses[0].id;
  await owner('POST', `${WM}/locations/bulk`, { warehouseId: wh, aisles: 'S', racks: '1', bins: '6' });
  const LOC = Object.fromEntries((await owner('GET', `${WM}/locations`)).json.locations.map((l) => [l.code, l]));

  // ---------- Déplacements concurrents : la somme par emplacement reste égale au stock ----------
  const vis = await newItem('Vis', 10);
  const res = await many(6, (i) => mem('POST', `${WM}/move`, { itemId: vis, fromLocationId: LOC.PRINCIPAL.id, toLocationId: LOC[`S-01-0${i + 1}`].id, quantity: '5' }));
  const okMoves = res.filter((x) => x.status === 200).length;
  check('déplacements concurrents : pas plus que le stock de départ (2 × 5 sur 10)', okMoves === 2, res.map((x) => x.status));
  check('déplacements concurrents : stock par emplacement = stock total', (await coherent()).length === 0 && await qtyOf(vis) === 10, await coherent());
  check('déplacements concurrents : rien ne reste « en double » à Principal', await atLoc(LOC.PRINCIPAL.id, vis) === 0, await atLoc(LOC.PRINCIPAL.id, vis));

  // ---------- Liste de préparation sortie deux fois ----------
  const riz = await newItem('Riz', 10);
  r = await owner('POST', `${WM}/picks`, { lines: [{ itemId: riz, quantity: '4' }] });
  const pick = r.json.id;
  const pl = (await owner('GET', `${WM}/picks/${pick}`)).json.pick.lines[0];
  await mem('POST', `${WM}/picks/${pick}/lines/${pl.id}/confirm`, {});
  await mem('POST', `${WM}/picks/${pick}/complete`, {});
  const [i1, i2] = await both(owner('POST', `${WM}/picks/${pick}/issue`, {}), mgr('POST', `${WM}/picks/${pick}/issue`, {}));
  check('préparation : une seule sortie de stock en cas de double envoi', [i1.status, i2.status].sort().join(',') === '200,400' && await qtyOf(riz) === 6, [i1.status, i2.status, await qtyOf(riz)]);

  // ---------- Retour client validé deux fois ----------
  r = await mem('POST', `${WM}/returns`, { kind: 'customer', lines: [{ itemId: riz, quantity: '3', reasonCode: 'unsuitable', disposition: 'restock' }] });
  const ret = r.json.id;
  const [v1, v2] = await both(owner('POST', `${WM}/returns/${ret}/validate`, {}), mgr('POST', `${WM}/returns/${ret}/validate`, {}));
  check('retour : une seule remise en stock en cas de double validation', [v1.status, v2.status].sort().join(',') === '200,400' && await qtyOf(riz) === 9, [v1.status, v2.status, await qtyOf(riz)]);

  // ---------- Réservation livrée deux fois ----------
  r = await owner('POST', `${WM}/reservations`, { itemId: riz, quantity: '2', label: 'Client X', kind: 'manual' });
  const rsv = r.json.id;
  const [f1, f2] = await both(owner('POST', `${WM}/reservations/${rsv}/fulfill`, {}), mgr('POST', `${WM}/reservations/${rsv}/fulfill`, {}));
  check('réservation : livrée une seule fois en cas de double envoi', [f1.status, f2.status].sort().join(',') === '200,400' && await qtyOf(riz) === 7, [f1.status, f2.status, await qtyOf(riz)]);

  // ---------- Transfert reçu deux fois ----------
  r = await mgr('POST', `${WM}/warehouses`, { name: 'Dépôt Yaoundé' });
  const yde = r.json.id;
  r = await mem('POST', `${WM}/transfers`, { fromWarehouseId: wh, toWarehouseId: yde, lines: [{ itemId: riz, quantity: '2' }] });
  const tr = r.json.id;
  const [s1, s2] = await both(owner('POST', `${WM}/transfers/${tr}/ship`, {}), owner('POST', `${WM}/transfers/${tr}/ship`, {}));
  const transit = LOC.TRANSIT.id;
  check('transfert : expédié une seule fois en cas de double envoi', [s1.status, s2.status].sort().join(',') === '200,400' && await atLoc(transit, riz) === 2, [s1.status, s2.status, await atLoc(transit, riz)]);
  const [t1, t2] = await both(mgr('POST', `${WM}/transfers/${tr}/receive`, {}), mgr('POST', `${WM}/transfers/${tr}/receive`, {}));
  check('transfert : reçu une seule fois en cas de double envoi', [t1.status, t2.status].sort().join(',') === '200,400' && await atLoc(transit, riz) === 0 && await qtyOf(riz) === 7, [t1.status, t2.status, await atLoc(transit, riz), await qtyOf(riz)]);
  check('cohérence après les doubles envois', (await coherent()).length === 0, await coherent());

  // ---------- Quarantaine : un simple membre ne libère pas la marchandise sans contrôle ----------
  r = await owner('POST', `${PU}/suppliers`, { name: 'Fournisseur Test', paymentDays: 30, status: 'active' });
  const sup = r.json.id;
  const lait = await newItem('Lait', 0);
  r = await owner('POST', `${PU}/orders`, { supplierId: sup, lines: [{ itemId: lait, quantity: 20, unitPrice: 1000 }] });
  const po = r.json.id;
  await owner('POST', `${PU}/orders/${po}/approve`, {});
  const ol = (await owner('GET', `${PU}/orders/${po}`)).json.order.lines[0];
  r = await owner('POST', `${PU}/orders/${po}/receipts`, { lines: [{ orderLineId: ol.id, receivedQty: 20, inspection: true }] });
  const Q = LOC.QUARANTAINE.id;
  check('quarantaine : la réception sous contrôle est en quarantaine', r.status === 201 && await atLoc(Q, lait) === 20, r.json);
  r = await mem('POST', `${WM}/move`, { itemId: lait, fromLocationId: Q, toLocationId: LOC['S-01-01'].id, quantity: '20' });
  check('quarantaine : un membre ne la vide pas par un déplacement', r.status === 403 && await atLoc(Q, lait) === 20, r.json);
  r = await mem('POST', `${WM}/putaway`, { itemId: lait, fromLocationId: Q, toLocationId: LOC['S-01-01'].id });
  check('quarantaine : ni par un rangement', r.status === 403 && await atLoc(Q, lait) === 20, r.json);
  r = await mem('POST', `${WM}/hus`, { type: 'pallet', locationId: Q, lines: [{ itemId: lait, quantity: '20' }] });
  const hq = r.json && r.json.id;
  r = await mem('POST', `${WM}/hus/${hq}/move`, { toLocationId: LOC['S-01-02'].id });
  check('quarantaine : ni en déplaçant une palette', r.status === 403 && await atLoc(Q, lait) === 20, r.json);
  if (hq) await owner('POST', `${WM}/hus/${hq}/unpack`, {});
  r = await mem('POST', `${O}/stock/items/${lait}/move`, { kind: 'out', quantity: 5, reason: 'Vente' });
  check('quarantaine : une sortie libre ne prend pas la marchandise non contrôlée', r.status === 400 && /disponible/.test(r.json.error) && await qtyOf(lait) === 20, r.json);
  r = await mem('POST', `${O}/stock/items/${lait}/move`, { kind: 'out', quantity: 5, locationId: Q, reason: 'Vente' });
  check('quarantaine : ni en désignant l\'emplacement de quarantaine', r.status === 403 && await qtyOf(lait) === 20, r.json);
  r = await mem('POST', `${O}/stock/items/${lait}/move`, { kind: 'out', quantity: 500, reason: 'Vente' });
  check('sortie au-delà du stock : message inchangé', r.status === 400 && /Stock insuffisant/.test(r.json.error), r.json);
  const insp = (await owner('GET', `${PU}/inspections`)).json.inspections.find((x) => x.pending === 20);
  const [q1, q2] = await both(owner('POST', `${PU}/inspections`, { lines: [{ receiptLineId: insp.receiptLineId, acceptedQty: 20 }] }), mgr('POST', `${PU}/inspections`, { lines: [{ receiptLineId: insp.receiptLineId, acceptedQty: 20 }] }));
  check('contrôle qualité : libéré une seule fois en cas de double envoi', [q1.status, q2.status].sort().join(',') === '200,400' && await atLoc(Q, lait) === 0 && await qtyOf(lait) === 20, [q1.status, q2.status, q1.json, q2.json]);
  r = await mem('POST', `${O}/stock/items/${lait}/move`, { kind: 'out', quantity: 5, reason: 'Vente' });
  check('après contrôle : la sortie libre fonctionne', r.status === 200 && await qtyOf(lait) === 15, r.json);
  check('cohérence après la quarantaine', (await coherent()).length === 0, await coherent());

  // ---------- Facture payée deux fois ----------
  const ttc = (await owner('GET', `${PU}/orders/${po}`)).json.order.totalTtc;
  r = await owner('GET', `${PU}/orders/${po}/invoice-draft`);
  r = await owner('POST', `${PU}/invoices`, { orderId: po, supplierRef: 'F-77', invoiceDate: today, lines: r.json.lines });
  const inv = r.json.id;
  r = await owner('POST', `${PU}/invoices/${inv}/approve`, {});
  check('facture : validée pour paiement', r.status === 200, r.json);
  const [p1, p2] = await both(owner('POST', `${PU}/invoices/${inv}/pay`, { method: 'bank', date: today }), owner('POST', `${PU}/invoices/${inv}/pay`, { method: 'cash', date: today }));
  const paid = Number((await dbx.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM pur_payments WHERE invoice_id = ?').get(inv)).s);
  check('facture : jamais payée au-delà de son montant (double envoi)', [p1.status, p2.status].sort().join(',') === '200,400' && paid === ttc, [p1.status, p2.status, paid, ttc]);

  // ---------- Seuil d'approbation contourné par une modification simultanée ----------
  await owner('PUT', `${PU}/settings`, { thresholds: { request: [], order: [{ minAmount: 1000000, role: 'admin' }] } });
  let bypass = 0;
  for (let k = 0; k < 6; k++) {
    r = await mgr('POST', `${PU}/orders`, { supplierId: sup, lines: [{ description: 'Petit achat', quantity: 1, unitPrice: 1000 }] });
    const oid = r.json.id;
    await both(mgr('POST', `${PU}/orders/${oid}/approve`, {}), mgr('PUT', `${PU}/orders/${oid}`, { supplierId: sup, lines: [{ description: 'Gros achat', quantity: 1, unitPrice: 50000000 }] }));
    const o = (await owner('GET', `${PU}/orders/${oid}`)).json.order;
    if (o.status !== 'draft' && o.totalTtc >= 1000000) bypass++;
  }
  check('seuil : un responsable ne fait jamais approuver une grosse commande en la modifiant pendant l\'approbation', bypass === 0, bypass);
  r = await mgr('POST', `${PU}/orders`, { supplierId: sup, lines: [{ description: 'Gros achat', quantity: 1, unitPrice: 50000000 }] });
  r = await mgr('POST', `${PU}/orders/${r.json.id}/approve`, {});
  check('seuil : toujours appliqué à l\'approbation normale', r.status === 403, r.json);

  // ---------- Bibliothèque : verrouillage du mot de passe ----------
  const LB = `${O}/library`;
  const blockOf = async (c, path) => (await c('GET', `${path}/library/overview`)).json.blocks.find((b) => b.personal).id;
  const memBlock = await blockOf(mem, O);
  const wrong = await many(8, () => mem('POST', `${LB}/blocks/${memBlock}/unlock`, { password: 'pas-le-bon' }));
  const refused = wrong.filter((x) => x.status === 403).length;
  check('bibliothèque : des essais simultanés ne dépassent pas les 5 essais autorisés', refused <= 5 && wrong.filter((x) => x.status === 429).length >= 3, wrong.map((x) => x.status));
  r = await mem('POST', `${LB}/blocks/${memBlock}/unlock`, { password: 'secret123' });
  check('bibliothèque : bloqué ensuite, même avec le bon mot de passe', r.status === 429, r.json);
  // Le compteur d'essais suit la personne, pas l'organisation : une autre organisation ne remet pas le compteur à zéro.
  r = await mgr('POST', '/api/ws/orgs', { name: 'Société de Marc' });
  const org3 = r.json.id;
  const mgrBlock = await blockOf(mgr, O);
  for (let k = 0; k < 5; k++) await mgr('POST', `${LB}/blocks/${mgrBlock}/unlock`, { password: 'faux' });
  const b3 = await blockOf(mgr, `/api/ws/orgs/${org3}`);
  r = await mgr('POST', `/api/ws/orgs/${org3}/library/blocks/${b3}/unlock`, { password: 'secret123' });
  check('bibliothèque : 5 essais ratés dans une organisation bloquent aussi les autres', r.status === 429, r.json);
  const audit = await dbx.prepare("SELECT detail FROM lib_audit WHERE action LIKE 'unlock%'").all();
  check('bibliothèque : le journal ne contient aucun mot de passe', audit.every((a) => !/pas-le-bon|faux|secret123/.test(a.detail || '')), audit);
  // Une autre personne n'est pas gênée.
  r = await owner('POST', `${LB}/blocks/${await blockOf(owner, O)}/unlock`, { password: 'secret123' });
  check('bibliothèque : les autres personnes entrent normalement', r.status === 200, r.json);
}, { setup: async () => ({ env: { SECURITY_BAN_SCORE: '100000' } }) });
