'use strict';
// Vague 1 : stock (lots FEFO/FIFO, séries/VIN, CUMP, inventaire, réception partielle, retards fournisseurs, surstock, SKU/code-barres, suppression refusée).
// Lancez-le avec : node scripts/test-wave1-stock.js
const { run } = require('./lib/wave1');
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

run('Stock : lots, séries, CUMP, inventaire, achats', async ({ check, owner, mgr, mem, other, org, O, dbx }) => {
  const S = `${O}/stock`;
  let r = await mgr('POST', `${S}/items`, { name: 'Yaourt', unit: 'pot', tracking: 'lot', pickRule: 'fefo', sku: 'YAO-01', barcode: '6001234567890', minQuantity: 5, maxQuantity: 100, unitCost: 200 });
  const yao = r.json.id;
  check('article suivi par lot créé', r.status === 201, r.json);
  r = await mgr('POST', `${S}/items`, { name: 'Autre', sku: 'YAO-01' });
  check('SKU en double -> 409', r.status === 409, r.json);
  r = await mgr('POST', `${S}/items`, { name: 'Autre', barcode: '6001234567890' });
  check('code-barres en double -> 409', r.status === 409, r.json);
  r = await mem('GET', `${S}/lookup?code=6001234567890`);
  check('recherche par code-barres', r.status === 200 && r.json.item.id === yao, r.json);
  r = await mem('GET', `${S}/lookup?code=YAO-01`);
  check('recherche par SKU', r.status === 200 && r.json.item.name === 'Yaourt', r.json);
  r = await mem('GET', `${S}/lookup?code=inconnu`);
  check('code inconnu -> 404', r.status === 404, r.status);

  // Lots
  r = await mgr('POST', `${S}/items/${yao}/move`, { kind: 'in', quantity: 10, lotNo: 'L-B', expiry: day(40), unitCost: 200 });
  check('entrée sans numéro de lot refusée', (await mgr('POST', `${S}/items/${yao}/move`, { kind: 'in', quantity: 1 })).status === 400);
  r = await mgr('POST', `${S}/items/${yao}/move`, { kind: 'in', quantity: 10, lotNo: 'L-A', expiry: day(10), unitCost: 300 });
  r = await mgr('POST', `${S}/items/${yao}/move`, { kind: 'in', quantity: 5, lotNo: 'L-OLD', expiry: day(-3) });
  r = await mgr('GET', `${S}/items/${yao}/lots`);
  check('3 lots, périmé signalé', r.json.lots.length === 3 && r.json.lots.find((l) => l.lotNo === 'L-OLD').expired === true, r.json.lots);
  r = await mem('POST', `${S}/items/${yao}/move`, { kind: 'out', quantity: 12, reason: 'Vente' });
  check('sortie FEFO : le lot le plus proche de la péremption part d\'abord (sans toucher au périmé)', r.status === 200 && r.json.lots[0].lotNo === 'L-A' && r.json.lots[0].quantity === 10 && r.json.lots[1].lotNo === 'L-B' && r.json.lots[1].quantity === 2, r.json);
  r = await mem('POST', `${S}/items/${yao}/move`, { kind: 'out', quantity: 9 });
  check('stock utilisable insuffisant (8 hors périmé, 5 périmés) -> 400', r.status === 400 && /périmés/.test(r.json.error), r.json);
  r = await mgr('GET', S);
  const yv = r.json.items.find((i) => i.id === yao);
  check('quantité cohérente avec les lots (13) et alerte de péremption', yv.quantity === 13 && r.json.summary.expired === 1, [yv.quantity, r.json.summary]);
  check('CUMP : (10×200 + 10×300) / 20 = 250 (une entrée non valorisée ne change pas le coût moyen)', Math.abs(yv.avgCost - 250) < 0.01, yv.avgCost);
  r = await mem('GET', S);
  check('un membre ne voit ni valeur ni coût moyen', r.json.summary.value === undefined && r.json.items[0].avgCost === undefined, r.json.summary);
  // FIFO
  r = await mgr('POST', `${S}/items`, { name: 'Riz', unit: 'kg', tracking: 'lot', pickRule: 'fifo' });
  const riz = r.json.id;
  await mgr('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 5, lotNo: 'R1', expiry: day(90) });
  await new Promise((x) => setTimeout(x, 20));
  await mgr('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 5, lotNo: 'R2', expiry: day(10) });
  r = await mgr('POST', `${S}/items/${riz}/move`, { kind: 'out', quantity: 6 });
  check('FIFO : le lot reçu en premier part d\'abord malgré une péremption plus lointaine', r.json.lots[0].lotNo === 'R1' && r.json.lots[0].quantity === 5 && r.json.lots[1].lotNo === 'R2', r.json);
  // Surstock
  r = await mgr('POST', `${S}/items/${yao}/move`, { kind: 'in', quantity: 100, lotNo: 'L-C', expiry: day(200) });
  r = await mgr('GET', `${O}/dashboard/alerts`);
  check('alertes : surstock, lot périmé et lot proche de la péremption', r.json.alerts.some((a) => /surstock/.test(a.text)) && r.json.alerts.some((a) => /lot périmé/.test(a.text)), r.json.alerts.filter((a) => a.module === 'stock'));
  r = await mgr('PUT', `${S}/items/${yao}`, { maxQuantity: 2, minQuantity: 5 });
  check('maximum inférieur au seuil -> 400', r.status === 400, r.json);

  // Séries / VIN
  r = await mgr('POST', `${S}/items`, { name: 'Toyota Hilux', unit: 'véhicule', tracking: 'serial' });
  const car = r.json.id;
  r = await mgr('POST', `${S}/items/${car}/move`, { kind: 'in', serials: 'VIN-AAA111\nVIN-BBB222' });
  check('entrée de 2 véhicules par VIN (quantité déduite)', r.status === 200 && r.json.quantity === 2, r.json);
  r = await mgr('POST', `${S}/items/${car}/move`, { kind: 'in', serials: 'vin-aaa111' });
  check('VIN déjà en stock -> 409', r.status === 409, r.json);
  r = await mgr('POST', `${S}/items/${car}/move`, { kind: 'out', quantity: 1 });
  check('sortie sans numéro refusée', r.status === 400, r.json);
  r = await mgr('POST', `${S}/items/${car}/move`, { kind: 'out', serials: 'VIN-ZZZ' });
  check('sortie d\'un VIN inconnu refusée', r.status === 400, r.json);
  r = await mgr('POST', `${S}/items/${car}/move`, { kind: 'out', serials: 'VIN-AAA111', reason: 'Vente client' });
  r = await mgr('GET', `${S}/items/${car}/lots`);
  check('VIN vendu marqué « out », l\'autre en stock', r.json.serials.find((s) => s.serial === 'VIN-AAA111').status === 'out' && r.json.serials.find((s) => s.serial === 'VIN-BBB222').status === 'in_stock', r.json.serials);
  r = await mgr('PUT', `${S}/items/${car}`, { tracking: 'none' });
  check('changer le suivi avec du stock -> 400', r.status === 400, r.json);

  // Inventaire
  r = await mgr('POST', `${S}/items`, { name: 'Savon', unit: 'pièce', quantity: 20, unitCost: 500 });
  const sav = r.json.id;
  r = await mgr('POST', `${S}/counts`, { note: 'Inventaire de test' });
  check('inventaire ouvert', r.status === 201, r.json);
  const cnt = r.json.id;
  r = await mgr('POST', `${S}/counts`, {});
  check('un seul inventaire en cours -> 409', r.status === 409, r.json);
  r = await mem('GET', `${S}/counts/${cnt}`);
  check('le membre voit les lignes sans valeurs', r.status === 200 && r.json.count.gapValue === undefined && r.json.count.items.every((i) => i.unitValue === undefined) && !r.json.count.items.some((i) => i.itemId === car), r.json.count.lines);
  r = await mem('PUT', `${S}/counts/${cnt}/lines`, { lines: [{ itemId: sav, counted: 17 }, { itemId: riz, counted: 4 }] });
  check('un membre peut saisir le comptage', r.status === 200, r.json);
  r = await mgr('POST', `${S}/counts/${cnt}/validate`);
  check('validation d\'un comptage non soumis -> 400', r.status === 400, r.json);
  await mem('POST', `${S}/counts/${cnt}/submit`);
  r = await mgr('GET', `${S}/counts/${cnt}`);
  check('écart valorisé : savon −3 × 500 = −1 500 ; riz 4 comptés vs 4 attendus', r.json.count.gapValue === -1500 && r.json.count.items.find((i) => i.itemId === sav).gapValue === -1500, r.json.count);
  r = await mem('POST', `${S}/counts/${cnt}/validate`);
  check('un membre ne valide pas -> 403', r.status === 403, r.status);
  r = await mgr('POST', `${S}/counts/${cnt}/validate`);
  check('le responsable qui a ouvert l\'inventaire ne valide pas seul -> 403', r.status === 403, r.json);
  r = await owner('POST', `${S}/counts/${cnt}/validate`, { note: 'Casse constatée' });
  check('l\'administrateur valide : 1 ajustement', r.status === 200 && r.json.adjusted === 1 && r.json.gapValue === -1500, r.json);
  r = await mgr('GET', `${S}/items/${sav}/moves`);
  check('ajustement tracé dans l\'historique', r.json.moves[0].delta === -3 && /Inventaire #1/.test(r.json.moves[0].reason), r.json.moves[0]);
  r = await mgr('GET', S);
  check('quantité du savon corrigée (17)', r.json.items.find((i) => i.id === sav).quantity === 17);

  // Achats : réception partielle, date promise, retard
  r = await mgr('POST', `${S}/suppliers`, { name: 'Grossiste Nord' });
  const sup = r.json.id;
  r = await mem('POST', `${S}/orders`, { itemId: sav, supplierId: sup, quantity: 100, unitPrice: 400, promisedDate: day(-5) });
  r = await mgr('GET', `${S}/orders`);
  const po = r.json.orders[0].id;
  r = await mgr('POST', `${S}/orders/${po}/receive`, { quantity: 10 });
  check('réception avant validation refusée', r.status === 400, r.json);
  r = await mgr('PUT', `${S}/orders/${po}/status`, { status: 'ordered' });
  check('commande validée', r.status === 200, r.json);
  r = await mgr('POST', `${S}/orders/${po}/receive`, { quantity: 150 });
  check('sur-réception refusée', r.status === 400, r.json);
  r = await mgr('POST', `${S}/orders/${po}/receive`, { quantity: 40 });
  check('réception partielle : statut « partial », reçu 40', r.status === 200 && r.json.status === 'partial' && r.json.receivedQty === 40, r.json);
  r = await mgr('GET', `${S}/orders`);
  let o = r.json.orders.find((x) => x.id === po);
  check('commande : reste 60, en retard sur la date promise', o.remaining === 60 && o.late === true && o.status === 'partial', o);
  r = await mgr('GET', `${S}/items/${sav}/moves`);
  r = await mgr('GET', S);
  const sv = r.json.items.find((i) => i.id === sav);
  check('stock 57 et CUMP = (17×500 + 40×400) / 57 ≈ 429,82', sv.quantity === 57 && Math.abs(sv.avgCost - 429.82) < 0.01 && sv.unitCost === 400, sv);
  r = await mgr('POST', `${S}/orders/${po}/receive`, { quantity: 60 });
  check('solde reçu : commande « received »', r.json.status === 'received', r.json);
  r = await mgr('GET', `${O}/budget`);
  check('dépenses « Achats » : 40×400 puis 60×400 inscrites', r.json.entries.filter((e) => e.category === 'Achats').map((e) => e.amount).sort().join() === '16000,24000', r.json.entries.filter((e) => e.category === 'Achats'));
  // 2e commande livrée à l'heure
  await mem('POST', `${S}/orders`, { itemId: sav, supplierId: sup, quantity: 10, unitPrice: 400, promisedDate: day(3) });
  r = await mgr('GET', `${S}/orders`);
  const po2 = r.json.orders.find((x) => x.status === 'pending').id;
  await mgr('PUT', `${S}/orders/${po2}/status`, { status: 'ordered' });
  await mgr('PUT', `${S}/orders/${po2}/status`, { status: 'received' });
  r = await mgr('GET', `${S}/supplier-stats`);
  const st = r.json.suppliers.find((x) => x.supplierId === sup);
  check('taux de retard fournisseur 50 % (1 sur 2), retard moyen 5 jours, taux de livraison 100 %', st.promised === 2 && st.late === 1 && st.lateRate === 50 && st.avgDelayDays === 5 && st.fillRate === 100, st);
  r = await mem('GET', `${S}/supplier-stats`);
  check('statistiques fournisseurs : responsables seulement', r.status === 403, r.status);
  // comptabilité des réceptions
  r = await owner('POST', `${O}/accounting/generate`);
  const ac = await dbx.prepare("SELECT COUNT(*) c FROM acc_entries WHERE org_id = ? AND source = 'receipt'").get(org);
  check('comptabilité : une écriture d\'achat par réception (3)', r.status === 200 && ac.c === 3, ac);

  // Suppression d'un article utilisé
  r = await mgr('DELETE', `${S}/items/${sav}`);
  check('article utilisé (commandes, mouvements) : suppression refusée', r.status === 409 && /utilisé/.test(r.json.error), r.json);
  r = await mgr('POST', `${S}/items`, { name: 'Neuf' });
  r = await mgr('DELETE', `${S}/items/${r.json.id}`);
  check('article jamais utilisé : supprimé', r.status === 200, r.json);
  r = await owner('GET', `${O}/stock`);
  r = await other('GET', `/api/ws/orgs/${org}/stock`);
  check('isolation : autre organisation -> 404', r.status === 404, r.status);
});
