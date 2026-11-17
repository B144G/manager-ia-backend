'use strict';
// Achats × Stock WMS : réception dans un emplacement choisi, contrôle qualité à l'entrée (quarantaine → rayonnage ou retour fournisseur).
// Ne s'exécute que si le module Stock WMS est présent (sinon : ignoré, sans échec). Lancez-le avec : node scripts/test-purchasing-wms.js
const fs = require('fs');
const path = require('path');
if (!fs.existsSync(path.join(__dirname, '..', 'src', 'workspace', 'wms-lib.js'))) { console.log('Module Stock WMS absent : test Achats x WMS ignoré.'); process.exit(0); }
const { run } = require('./lib/wave2');

run('Achats × Stock WMS', async ({ check, owner, mgr, mem, other, org2, O, ws }) => {
  const P = `${O}/purchasing`; const WM = `${O}/stock/wms`; let r;
  const item = (await owner('POST', `${O}/stock/items`, { name: 'Carrelage 60x60', unit: 'carton', unitCost: 8000 })).json.id;
  const lotItem = (await owner('POST', `${O}/stock/items`, { name: 'Peinture 5 L', unit: 'pot', unitCost: 9000, tracking: 'lot' })).json.id;
  const serialItem = (await owner('POST', `${O}/stock/items`, { name: 'Imprimante', unit: 'pièce', unitCost: 90000, tracking: 'serial' })).json.id;
  const sup = (await mgr('POST', `${P}/suppliers`, { name: 'Céramiques du Wouri' })).json.id;
  // Entrepôt principal de la ligne A : il faut désigner l'entrepôt à la création d'un emplacement (la ligne B le choisissait d'office).
  const mainWh = (await owner('GET', `${WM}/overview`)).json.warehouses.find((w) => w.isDefault).id;
  const loc = async (code, kind) => (await mgr('POST', `${WM}/locations`, { warehouseId: mainWh, code, name: code, kind })).json.id;
  const rayon = await loc('A-01-01', 'storage'); const rayon2 = await loc('A-01-02', 'storage'); const quar = await loc('Q-01', 'quarantine');
  check('emplacements créés (2 rayonnages, 1 quarantaine)', rayon && rayon2 && quar, [rayon, rayon2, quar]);
  const levels = async (id) => (await owner('GET', `${WM}/items/${id}/levels`)).json.levels.filter((l) => l.quantity > 0).map((l) => `${l.code}:${l.quantity}`).sort().join();
  const order = async (lines) => { const id = (await mgr('POST', `${P}/orders`, { supplierId: sup, lines })).json.id; await owner('POST', `${P}/orders/${id}/approve`); return (await mgr('GET', `${P}/orders/${id}`)).json.order; };

  // Réception dans un emplacement choisi
  let o = await order([{ itemId: item, quantity: 50, unitPrice: 8000 }]);
  r = await mgr('POST', `${P}/orders/${o.id}/receipts`, { lines: [{ orderLineId: o.lines[0].id, receivedQty: 30, locationId: rayon2 }] });
  check('réception d\'achat dans l\'emplacement A-01-02', r.status === 201 && await levels(item) === 'A-01-02:30', [r.status, await levels(item)]);
  r = await mgr('POST', `${P}/orders/${o.id}/receipts`, { lines: [{ orderLineId: o.lines[0].id, receivedQty: 5, locationId: 999999 }] });
  check('emplacement inconnu refusé', r.status === 400, r.json);
  r = await other('POST', `${ws(org2)}/purchasing/orders/${o.id}/receipts`, { lines: [] });
  check("isolation : l'autre organisation ne réceptionne pas ce bon", r.status === 404, r.status);
  r = await mgr('GET', `${P}/receipts`); check('le bon de réception garde l\'emplacement', r.json.receipts[0].lines[0].locationId === rayon2, r.json.receipts[0].lines);
  r = await mgr('POST', `${P}/orders/${o.id}/receipts`, { lines: [{ orderLineId: o.lines[0].id, receivedQty: 20 }] });
  check('sans emplacement : rangement automatique du WMS (le stock reste égal à la somme des emplacements)', r.status === 201 && (await owner('GET', `${WM}/integrity`)).json && true, r.status);
  const total = (await owner('GET', `${WM}/items/${item}/levels`)).json;
  check('somme des emplacements = quantité de l\'article (50)', total.quantity === 50 && total.levels.reduce((s, l) => s + l.quantity, 0) === 50, total);

  // Contrôle qualité à l'entrée
  o = await order([{ itemId: lotItem, quantity: 40, unitPrice: 9000 }]);
  r = await mgr('POST', `${P}/orders/${o.id}/receipts`, { lines: [{ orderLineId: o.lines[0].id, receivedQty: 40, lotNo: 'P-77', inspection: true }] });
  check('réception avec contrôle : la marchandise entre en quarantaine', r.status === 201 && await levels(lotItem) === 'QUARANTAINE:40', [r.status, await levels(lotItem)]);
  const usable = (await owner('GET', `${WM}/items/${lotItem}/levels`)).json;
  check('stock disponible = 0 tant que le contrôle n\'est pas fait', usable.usable === 0 && usable.quantity === 40, usable);
  r = await mgr('GET', `${P}/inspections`); const ins = r.json.inspections[0];
  check('liste des contrôles en attente', r.json.inspections.length === 1 && ins.pending === 40 && ins.supplier === 'Céramiques du Wouri', r.json);
  r = await mem('GET', `${P}/inspections`); check('un membre ne voit pas les contrôles', r.status === 403, r.status);
  for (const [lab, lines] of [['rien à contrôler', []], ['ligne inconnue', [{ receiptLineId: 99999, acceptedQty: 1 }]], ['plus que le stock en attente', [{ receiptLineId: ins.receiptLineId, acceptedQty: 41 }]], ['refus sans motif', [{ receiptLineId: ins.receiptLineId, rejectedQty: 2 }]], ['même ligne deux fois', [{ receiptLineId: ins.receiptLineId, acceptedQty: 1 }, { receiptLineId: ins.receiptLineId, acceptedQty: 1 }]], ['emplacement inconnu', [{ receiptLineId: ins.receiptLineId, acceptedQty: 1, toLocationId: 99999 }]], ['libérer vers la quarantaine', [{ receiptLineId: ins.receiptLineId, acceptedQty: 1, toLocationId: quar }]]]) {
    r = await mgr('POST', `${P}/inspections`, { lines });
    check(`contrôle refusé : ${lab}`, r.status === 400 || r.status === 404, [r.status, r.json && r.json.error]);
  }
  check('aucun mouvement après ces refus', await levels(lotItem) === 'QUARANTAINE:40', await levels(lotItem));
  r = await mgr('POST', `${P}/inspections`, { lines: [{ receiptLineId: ins.receiptLineId, acceptedQty: 33, toLocationId: rayon, rejectedQty: 5, reason: 'Pots abîmés' }] });
  check('inspection : 33 libérés vers A-01-01, 5 refusés (retour fournisseur)', r.status === 200 && r.json.accepted === 33 && r.json.rejected === 5 && await levels(lotItem) === 'A-01-01:33,QUARANTAINE:2', [r.json, await levels(lotItem)]);
  const st = (await owner('GET', `${WM}/items/${lotItem}/levels`)).json;
  check('stock disponible = 33, quantité de l\'article = 35', st.usable === 33 && st.quantity === 35, st);
  o = (await mgr('GET', `${P}/orders/${o.id}`)).json.order;
  check('la commande n\'est plus « reçue » : 5 refusés à re-livrer', o.status === 'partial' && o.lines[0].receivedQty === 35 && o.lines[0].rejectedQty === 5, o.lines[0]);
  r = await mgr('POST', `${P}/inspections`, { lines: [{ receiptLineId: ins.receiptLineId, acceptedQty: 2, toLocationId: rayon }] });
  check('solde du contrôle (2 libérés) : plus rien en attente', r.status === 200 && (await mgr('GET', `${P}/inspections`)).json.inspections.length === 0 && await levels(lotItem) === 'A-01-01:35', await levels(lotItem));
  r = await mgr('POST', `${P}/inspections`, { lines: [{ receiptLineId: ins.receiptLineId, acceptedQty: 1, toLocationId: rayon }] });
  check('on ne contrôle pas deux fois la même quantité', r.status === 400, r.json);
  r = await other('POST', `${ws(org2)}/purchasing/inspections`, { lines: [{ receiptLineId: ins.receiptLineId, acceptedQty: 1 }] });
  check("isolation : contrôle d'une ligne d'une autre organisation impossible", r.status === 404 || r.status === 400, r.status);
  // Cas particuliers
  o = await order([{ itemId: serialItem, quantity: 1, unitPrice: 90000 }]);
  r = await mgr('POST', `${P}/orders/${o.id}/receipts`, { lines: [{ orderLineId: o.lines[0].id, receivedQty: 1, serials: 'IMP-1', inspection: true }] });
  check('contrôle à l\'entrée refusé pour un article suivi par numéro de série', r.status === 400 && /série/.test(r.json.error), r.json);
  o = await order([{ description: 'Service', quantity: 1, unitPrice: 5000 }]);
  r = await mgr('POST', `${P}/orders/${o.id}/receipts`, { lines: [{ orderLineId: o.lines[0].id, receivedQty: 1, inspection: true }] });
  check('ligne sans article du stock : le contrôle à l\'entrée est simplement sans effet de stock', r.status === 201, r.json);
}, {});
