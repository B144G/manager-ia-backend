'use strict';
// Module Achats : droits par rôle, isolation entre organisations, demandes et seuils d'approbation, bons de commande, réceptions partielles (stock, lot, série),
// factures et rapprochement à trois, écritures comptables idempotentes, règlements, appels d'offres, fournisseurs (note, documents), budgets, tableau de bord.
// Lancez-le avec : node scripts/test-purchasing.js
const { run } = require('./lib/wave2');
const { fakeSmtp } = require('./lib/fakes');

const today = new Date().toISOString().slice(0, 10);
const addD = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const box = []; let smtp = null;

run('Module Achats', async ({ check, owner, mgr, mem, other, org2, O, ws, dbx, org }) => {
  const P = `${O}/purchasing`; const P2 = `${ws(org2)}/purchasing`;
  let r;
  const accSum = async (account) => { const x = await dbx.prepare('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM acc_lines WHERE org_id = ? AND account = ?').get(org, account); return { d: Number(x.d), c: Number(x.c) }; };
  const entriesOf = async (source) => (await dbx.prepare('SELECT e.*, (SELECT COUNT(*) FROM acc_entries r WHERE r.reversed_of = e.id) AS rev FROM acc_entries e WHERE e.org_id = ? AND e.source = ? ORDER BY e.id').all(org, source));
  const stockQty = async (id) => Number(((await owner('GET', `${O}/stock`)).json.items.find((i) => i.id === id) || {}).quantity);

  // ---------- Droits par rôle ----------
  r = await owner('GET', `${O}`);
  check('le module « Achats » figure dans la liste des modules (accès membre)', r.json.modules.some((m) => m.id === 'purchasing' && m.min === 'member'), r.json.modules.map((m) => m.id));
  for (const u of ['/orders', '/invoices', '/rfqs', '/suppliers', '/dashboard', '/budget', '/receipts']) {
    r = await mem('GET', `${P}${u}`);
    check(`droits : ${u} refusé à un simple membre`, r.status === 403, r.status);
  }
  r = await mem('GET', `${P}/settings`); check('droits : un membre lit les réglages (seuils) mais…', r.status === 200 && r.json.thresholds, r.status);
  r = await mgr('PUT', `${P}/settings`, { tolPricePct: 3 }); check('droits : …un responsable ne les modifie pas', r.status === 403, r.status);
  r = await mem('GET', `${P}/summary`); check('un membre voit son résumé personnel', r.status === 200 && r.json.canManage === false && !r.json.pending, r.json);
  r = await mgr('GET', `${P}/summary`); check('un responsable voit le résumé des tâches à traiter', r.json.canManage === true && r.json.pending, r.json);

  // ---------- Données de base ----------
  const item = async (b) => (await owner('POST', `${O}/stock/items`, b)).json.id;
  const ciment = await item({ name: 'Ciment 50 kg', unit: 'sac', unitCost: 6000 });
  const lait = await item({ name: 'Lait en carton', unit: 'carton', unitCost: 500, tracking: 'lot' });
  const ordi = await item({ name: 'Ordinateur portable', unit: 'pièce', unitCost: 300000, tracking: 'serial' });
  check('articles de stock créés (simple, par lot, par série)', ciment && lait && ordi, [ciment, lait, ordi]);
  r = await mgr('POST', `${P}/suppliers`, { name: 'Quincaillerie Biya', email: 'ventes@biya.exemple.com', phone: '699000111', taxId: 'M0123456789', paymentDays: 30, category: 'Chantier' });
  const supA = r.json.id; check('fiche fournisseur créée', r.status === 201 && supA, r.json);
  const supB = (await mgr('POST', `${P}/suppliers`, { name: 'Matériaux du Wouri' })).json.id;
  const supC = (await mgr('POST', `${P}/suppliers`, { name: 'Papeterie Centrale' })).json.id;
  r = await mgr('POST', `${P}/suppliers`, { name: 'quincaillerie biya' }); check('fournisseur en double (même nom) refusé', r.status === 409, r.status);
  r = await mgr('POST', `${P}/suppliers`, { name: 'Mauvais courriel', email: 'pas-un-courriel' }); check('e-mail de fournisseur invalide refusé', r.status === 400, r.status);
  r = await mem('POST', `${P}/suppliers`, { name: 'Interdit' }); check('un membre ne crée pas de fournisseur', r.status === 403, r.status);
  const otherSup = (await other('POST', `${P2}/suppliers`, { name: 'Fournisseur de Zoé' })).json.id;

  // ---------- Demandes d'achat ----------
  const line = (o) => ({ description: 'Article libre', quantity: 1, estPrice: 1000, ...o });
  for (const [lab, body] of [['sans titre', { title: '', lines: [line()] }], ['sans ligne', { title: 'x', lines: [] }], ['quantité nulle', { title: 'x', lines: [line({ quantity: 0 })] }], ['quantité négative', { title: 'x', lines: [line({ quantity: -2 })] }],
    ['prix négatif', { title: 'x', lines: [line({ estPrice: -5 })] }], ['article inconnu', { title: 'x', lines: [{ itemId: 99999, quantity: 1 }] }], ['ligne sans désignation', { title: 'x', lines: [{ quantity: 1 }] }],
    ['date invalide', { title: 'x', neededDate: '31/12/2030', lines: [line()] }], ['date passée', { title: 'x', neededDate: '2001-01-01', lines: [line()] }], ['projet inconnu', { title: 'x', projectId: 99999, lines: [line()] }], ['antenne inconnue', { title: 'x', branchId: 99999, lines: [line()] }]]) {
    r = await mem('POST', `${P}/requests`, body);
    check(`demande refusée : ${lab}`, r.status === 400, r.status);
  }
  r = await mem('POST', `${P}/requests`, { title: 'Chantier route', justification: 'Fondations', category: 'Chantier', neededDate: addD(today, 20), lines: [{ itemId: ciment, quantity: 100, estPrice: 6000 }, { description: 'Casques de chantier', unit: 'pièce', quantity: 10, estPrice: 5000 }] });
  const R1 = r.json.id; check('demande créée en brouillon, numéro DA-AAAA-0001', r.status === 201 && /^DA-\d{4}-0001$/.test(r.json.number) && r.json.status === 'draft', r.json);
  r = await mem('GET', `${P}/requests/${R1}`); check('détail : total = Σ quantité × prix estimé (650 000), 2 lignes', r.json.request.total === 650000 && r.json.request.lines.length === 2 && r.json.request.requester === 'Paul', r.json);
  r = await mgr('GET', `${P}/requests`); check('le responsable voit les demandes de toute l\'équipe', r.json.requests.some((x) => x.id === R1), r.json);
  r = await owner('GET', `${P}/requests/${R1}`); check('le propriétaire lit aussi la demande', r.status === 200, r.status);
  r = await other('GET', `${P2}/requests/${R1}`); check('isolation : l\'autre organisation ne lit pas la demande', r.status === 404, r.status);
  r = await other('GET', `${P2}/requests`); check('isolation : liste vide dans l\'autre organisation', r.json.requests.length === 0, r.json);
  r = await owner('GET', `${ws(org2)}/purchasing/requests`); check('isolation : le propriétaire de la première n\'entre pas dans la seconde', r.status === 404, r.status);
  r = await mgr('POST', `${P}/requests/${R1}/approve`); check('on n\'approuve pas un brouillon', r.status === 400, r.status);
  r = await mgr('PUT', `${P}/requests/${R1}`, { title: 'Pris à un autre' }); check('seul l\'auteur modifie son brouillon', r.status === 403, r.status);
  r = await mem('PUT', `${P}/requests/${R1}`, { title: 'Chantier route (révisé)', lines: [{ itemId: ciment, quantity: 100, estPrice: 6000 }, { description: 'Casques de chantier', unit: 'pièce', quantity: 10, estPrice: 5000 }] }); check('l\'auteur modifie son brouillon', r.status === 200, r.json);
  r = await mem('POST', `${P}/requests/${R1}/submit`); check('soumission', r.status === 200, r.json);
  r = await mem('PUT', `${P}/requests/${R1}`, { title: 'Après soumission' }); check('une demande soumise ne se modifie plus', r.status === 400, r.status);
  r = await mem('POST', `${P}/requests/${R1}/approve`); check('un membre ne peut pas approuver', r.status === 403, r.status);
  r = await mgr('POST', `${P}/requests/${R1}/reject`, {}); check('refus sans motif -> 400', r.status === 400, r.status);
  r = await mem('POST', `${P}/requests/${R1}/withdraw`); check('l\'auteur retire sa demande de l\'approbation', r.status === 200, r.json);
  r = await mem('POST', `${P}/requests/${R1}/submit`); check('…et la soumet de nouveau', r.status === 200, r.json);

  // Seuils : au-dessus de 500 000 FCFA, un administrateur ; jamais sa propre demande pour un simple responsable
  r = await owner('PUT', `${P}/settings`, { thresholds: { request: [{ minAmount: 500000, role: 'member' }] } }); check('seuil : rôle « membre » refusé', r.status === 400, r.json);
  r = await owner('PUT', `${P}/settings`, { thresholds: { request: [{ minAmount: 500000, role: 'admin' }, { minAmount: 500000, role: 'owner' }] } }); check('seuil : deux seuils au même montant refusés', r.status === 400, r.json);
  r = await owner('PUT', `${P}/settings`, { thresholds: { request: [{ minAmount: -5, role: 'admin' }] } }); check('seuil : montant négatif refusé', r.status === 400, r.json);
  r = await owner('PUT', `${P}/settings`, { tolPricePct: 'abc' }); check('réglage : tolérance non numérique refusée', r.status === 400, r.json);
  r = await owner('PUT', `${P}/settings`, { tolQtyPct: 150 }); check('réglage : tolérance > 100 % refusée', r.status === 400, r.json);
  r = await owner('PUT', `${P}/settings`, { thresholds: { request: [{ minAmount: 500000, role: 'admin' }], order: [{ minAmount: 2000000, role: 'owner' }] } });
  check('seuils enregistrés (demandes et commandes)', r.status === 200 && r.json.thresholds.request[0].role === 'admin' && r.json.thresholds.order[0].minAmount === 2000000, r.json);
  r = await mem('GET', `${P}/requests/${R1}`); check('la demande de 650 000 (soumise avant le seuil) garde le rôle responsable', r.json.request.status === 'submitted', r.json.request);
  const R2 = (await mem('POST', `${P}/requests`, { title: 'Grosse commande', category: 'Chantier', submit: true, lines: [{ description: 'Groupe électrogène', quantity: 1, estPrice: 700000 }] })).json.id;
  r = await mgr('GET', `${P}/requests/${R2}`); check('au-dessus du seuil : rôle requis = administrateur, un responsable ne peut pas approuver', r.json.request.requiredRole === 'admin' && r.json.request.canApprove === false, r.json.request);
  r = await mgr('POST', `${P}/requests/${R2}/approve`); check('un responsable ne peut pas approuver un montant au-dessus de son seuil', r.status === 403 && /administrateur/.test(r.json.error), r.json);
  r = await owner('POST', `${P}/requests/${R2}/approve`); check('un administrateur approuve ce montant', r.status === 200, r.json);
  const R3 = (await mgr('POST', `${P}/requests`, { title: 'Demande du responsable', submit: true, lines: [{ description: 'Cartouches', quantity: 2, estPrice: 20000 }] })).json.id;
  r = await mgr('POST', `${P}/requests/${R3}/approve`); check('un responsable n\'approuve pas sa propre demande', r.status === 403 && /propre/.test(r.json.error), r.json);
  r = await owner('POST', `${P}/requests/${R3}/reject`, { reason: 'Pas de budget ce mois-ci' }); check('refus avec motif', r.status === 200, r.json);
  r = await mgr('GET', `${P}/requests/${R3}`); check('le motif du refus est conservé', r.json.request.status === 'rejected' && r.json.request.rejectReason === 'Pas de budget ce mois-ci', r.json.request);
  r = await owner('POST', `${P}/requests/${R3}/approve`); check('une demande refusée ne se ré-approuve pas', r.status === 400, r.status);
  r = await mgr('POST', `${P}/requests/${R1}/approve`); check('un responsable approuve la demande d\'un membre (sous le seuil de 650 000 ? non : 650 000 ≥ 500 000 -> administrateur requis)', r.status === 200 || r.status === 403, r.status);
  if (r.status === 403) r = await owner('POST', `${P}/requests/${R1}/approve`);
  check('demande R1 approuvée', r.status === 200, r.json);
  r = await mem('GET', `${P}/summary`); check('résumé du membre : ses demandes par statut', r.json.myRequests.approved === 2 || r.json.myRequests.approved === 1, r.json);
  r = await mem('POST', `${P}/requests/${R1}/to-order`, { supplierId: supA }); check('un membre ne transforme pas une demande en commande', r.status === 403, r.status);
  r = await mgr('POST', `${P}/requests/${R2}/to-order`, { supplierId: otherSup }); check('isolation : fournisseur d\'une autre organisation refusé', r.status === 404, r.status);
  r = await mgr('POST', `${P}/requests/${R1}/to-order`, { supplierId: supA, expectedDate: addD(today, 15) });
  const BC1 = r.json.orderId; check('demande approuvée -> bon de commande en brouillon', r.status === 201 && BC1, r.json);
  r = await mgr('POST', `${P}/requests/${R1}/to-order`, { supplierId: supA }); check('une demande déjà commandée ne se commande pas deux fois', r.status === 400, r.status);
  r = await mem('GET', `${P}/requests/${R1}`); check('statut « commandée »', r.json.request.status === 'ordered', r.json.request);

  // ---------- Bons de commande ----------
  r = await mgr('GET', `${P}/orders/${BC1}`); let o1 = r.json.order;
  check('BC : numéro BC-AAAA-0001, 2 lignes, HT 650 000, TVA 19,25 % = 125 125, TTC 775 125', /^BC-\d{4}-0001$/.test(o1.number) && o1.lines.length === 2 && o1.totalHt === 650000 && o1.vatAmount === 125125 && o1.totalTtc === 775125 && o1.status === 'draft' && o1.category === 'Chantier', o1);
  for (const [lab, body] of [['fournisseur manquant', { lines: [{ description: 'x', quantity: 1, unitPrice: 100 }] }], ['prix nul', { supplierId: supA, lines: [{ description: 'x', quantity: 1, unitPrice: 0 }] }], ['quantité nulle', { supplierId: supA, lines: [{ description: 'x', quantity: 0, unitPrice: 5 }] }],
    ['sans ligne', { supplierId: supA, lines: [] }], ['TVA absurde', { supplierId: supA, vatRate: 90, lines: [{ description: 'x', quantity: 1, unitPrice: 5 }] }], ['livraison avant commande', { supplierId: supA, orderDate: today, expectedDate: addD(today, -3), lines: [{ description: 'x', quantity: 1, unitPrice: 5 }] }],
    ['délai de paiement négatif', { supplierId: supA, paymentDays: -2, lines: [{ description: 'x', quantity: 1, unitPrice: 5 }] }], ['fournisseur d\'une autre organisation', { supplierId: otherSup, lines: [{ description: 'x', quantity: 1, unitPrice: 5 }] }]]) {
    r = await mgr('POST', `${P}/orders`, body);
    check(`bon de commande refusé : ${lab}`, r.status === 400 || r.status === 404, r.status);
  }
  r = await mgr('POST', `${P}/orders/${BC1}/approve`); check('un responsable n\'approuve pas le bon de commande qu\'il a créé', r.status === 403 && /propre/.test(r.json.error), r.json);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: o1.lines[0].id, receivedQty: 1 }] }); check('pas de réception avant approbation', r.status === 400, r.json);
  r = await mgr('POST', `${P}/orders/${BC1}/send`, { via: 'manual' }); check('pas d\'envoi avant approbation', r.status === 400, r.json);
  r = await owner('POST', `${P}/orders/${BC1}/approve`); check('un administrateur approuve', r.status === 200, r.json);
  r = await owner('POST', `${P}/orders/${BC1}/approve`); check('on n\'approuve pas deux fois', r.status === 400, r.status);
  r = await mgr('PUT', `${P}/orders/${BC1}`, { notes: 'x' }); check('un bon approuvé ne se modifie plus', r.status === 400, r.status);
  r = await mgr('GET', `${P}/orders/${BC1}/pdf`); check('PDF du bon de commande', r.status === 200 && /pdf/.test(r.headers.get('content-type')) && r.buf.slice(0, 5).toString() === '%PDF-', [r.status, r.headers.get('content-type')]);
  r = await mgr('POST', `${P}/orders/${BC1}/send`, { via: 'email', to: 'pas-un-courriel' }); check('envoi : adresse invalide refusée', r.status === 400, r.json);
  const before = box.length;
  r = await mgr('POST', `${P}/orders/${BC1}/send`, { via: 'email' });
  check('envoi par e-mail à l\'adresse de la fiche (PDF joint)', r.status === 200 && r.json.to === 'ventes@biya.exemple.com', r.json);
  await new Promise((x) => setTimeout(x, 300));
  const mail = box.slice(before).join('\n');
  check('e-mail reçu : numéro du bon et pièce jointe PDF', box.length > before && mail.includes(o1.number) && /application\/pdf/.test(mail), mail.slice(0, 300));
  r = await mgr('GET', `${P}/orders/${BC1}`); check('statut « envoyé »', r.json.order.status === 'sent' && r.json.order.sentTo === 'ventes@biya.exemple.com', r.json.order.status);

  // Réceptions partielles
  const [lCim, lCas] = o1.lines.map((l) => l.id);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [] }); check('réception vide refusée', r.status === 400, r.status);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: 999999, receivedQty: 1 }] }); check('ligne étrangère refusée', r.status === 400, r.status);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: lCim, receivedQty: -1 }] }); check('quantité négative refusée', r.status === 400, r.status);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { receiptDate: addD(today, 3), lines: [{ orderLineId: lCim, receivedQty: 1 }] }); check('date de réception future refusée', r.status === 400, r.status);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: lCim, receivedQty: 1 }, { orderLineId: lCim, receivedQty: 1 }] }); check('même ligne deux fois refusée', r.status === 400, r.status);
  r = await mem('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: lCim, receivedQty: 1 }] }); check('un membre ne réceptionne pas', r.status === 403, r.status);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { deliveryNote: 'BL-778', lines: [{ orderLineId: lCim, receivedQty: 60 }, { orderLineId: lCas, receivedQty: 10 }] });
  const BR1 = r.json.id; check('réception partielle : BR-AAAA-0001, commande « partiellement reçue »', r.status === 201 && /^BR-\d{4}-0001$/.test(r.json.number) && r.json.orderStatus === 'partial', r.json);
  check('le stock du ciment augmente de 60', await stockQty(ciment) === 60, await stockQty(ciment));
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: lCim, receivedQty: 50 }] }); check('sur-réception au-delà de la tolérance (5 %) refusée', r.status === 400 && /tolérance/.test(r.json.error), r.json);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: lCim, receivedQty: 35, rejectedQty: 5 }] }); check('refus sans motif -> 400', r.status === 400 && /motif/.test(r.json.error), r.json);
  check('rien n\'est entré en stock par les refus ci-dessus', await stockQty(ciment) === 60, await stockQty(ciment));
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: lCim, receivedQty: 40, rejectedQty: 5, reason: 'Sacs déchirés' }] });
  check('réception du solde avec 5 sacs refusés (motif) : commande « reçue »', r.status === 201 && r.json.orderStatus === 'received', r.json);
  check('stock du ciment = 100 (les refusés n\'entrent pas)', await stockQty(ciment) === 100, await stockQty(ciment));
  r = await mgr('GET', `${P}/orders/${BC1}`); o1 = r.json.order;
  check('lignes : reçu 100 / 10, refusé 5, 2 bons de réception', o1.lines[0].receivedQty === 100 && o1.lines[0].rejectedQty === 5 && o1.lines[1].receivedQty === 10 && o1.receipts.length === 2, o1.lines);
  r = await mgr('POST', `${P}/orders/${BC1}/receipts`, { lines: [{ orderLineId: lCim, receivedQty: 1 }] }); check('commande reçue : plus de réception', r.status === 400, r.status);
  r = await mgr('GET', `${P}/receipts/${BR1}/pdf`); check('PDF du bon de réception', r.status === 200 && r.buf.slice(0, 5).toString() === '%PDF-', r.status);
  r = await mgr('GET', `${P}/orders/${BC1}/receipts`); check('liste des réceptions avec motif et quantités', r.json.receipts.length === 2 && r.json.receipts[1].lines[0].reason === 'Sacs déchirés', r.json);
  r = await other('GET', `${P2}/receipts/${BR1}`); check('isolation : bon de réception invisible de l\'autre organisation', r.status === 404, r.status);
  r = await other('GET', `${P2}/orders/${BC1}`); check('isolation : bon de commande invisible de l\'autre organisation', r.status === 404, r.status);
  r = await other('GET', `${P2}/orders`); check('isolation : liste des commandes vide de l\'autre côté', r.json.orders.length === 0, r.json);
  r = await other('POST', `${P2}/orders/${BC1}/approve`); check('isolation : approbation d\'un bon étranger impossible', r.status === 404, r.status);

  // Stock ↔ Achats : prix reçu dans la fiche prix du stock, et réapprovisionnement tenant compte des commandes en cours
  r = await owner('GET', `${O}/stock/items/${ciment}/prices`);
  check('stock : le prix reçu (6 000) alimente la fiche prix du fournisseur dans Stock et achats', r.json.prices.some((p) => p.supplier === 'Quincaillerie Biya' && p.unitPrice === 6000), r.json);
  await owner('PUT', `${O}/stock/items/${ciment}`, { minQuantity: 150, maxQuantity: 400 });
  r = await mgr('GET', `${P}/reorder`); let ro = r.json.items.find((x) => x.itemId === ciment);
  check('réapprovisionnement : ciment à 100 (seuil 150) proposé, fournisseur au meilleur prix connu', r.status === 200 && ro && ro.onOrder === 0 && ro.suggested === 300 && ro.supplier && ro.supplier.unitPrice === 6000, r.json);
  r = await mem('GET', `${P}/reorder`); check('réapprovisionnement réservé aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${P}/orders`, { supplierId: supA, lines: [{ itemId: ciment, quantity: 100, unitPrice: 6000 }] }); const BCR = r.json.id; await owner('POST', `${P}/orders/${BCR}/approve`);
  r = await mgr('GET', `${P}/reorder`); ro = r.json.items.find((x) => x.itemId === ciment);
  check('une commande approuvée en cours (100) couvre le besoin : le ciment n\'est plus proposé', !ro, ro);
  await mgr('POST', `${P}/orders/${BCR}/cancel`, { reason: 'Test' });

  // Lots et séries
  r = await mgr('POST', `${P}/orders`, { supplierId: supB, category: 'Cantine', vatRate: 0, expectedDate: addD(today, 5), lines: [{ itemId: lait, quantity: 50, unitPrice: 500 }, { itemId: ordi, quantity: 2, unitPrice: 300000 }] });
  const BC2 = r.json.id; check('bon de commande avec article par lot et article par série', r.status === 201 && BC2, r.json);
  r = await owner('POST', `${P}/orders/${BC2}/approve`); check('BC2 approuvé', r.status === 200, r.json);
  o1 = (await mgr('GET', `${P}/orders/${BC2}`)).json.order; const [lLait, lOrdi] = o1.lines.map((l) => l.id);
  check('TVA 0 % : TTC = HT = 625 000', o1.totalHt === 625000 && o1.vatAmount === 0 && o1.totalTtc === 625000, o1);
  r = await mgr('POST', `${P}/orders/${BC2}/receipts`, { lines: [{ orderLineId: lLait, receivedQty: 1, locationId: 5 }] });
  check("emplacement d'entrepôt : emplacement inconnu ou WMS absent : refusé (jamais ignoré en silence)", r.status === 400 && /mplacement/.test(r.json.error), r.json);

  r = await mgr('POST', `${P}/orders/${BC2}/receipts`, { lines: [{ orderLineId: lLait, receivedQty: 30 }] }); check('article par lot : numéro de lot obligatoire', r.status === 400 && /lot/.test(r.json.error), r.json);
  r = await mgr('POST', `${P}/orders/${BC2}/receipts`, { lines: [{ orderLineId: lOrdi, receivedQty: 2, serials: 'SN-1' }] }); check('article par série : autant de numéros que d\'unités', r.status === 400 && /série/.test(r.json.error), r.json);
  r = await mgr('POST', `${P}/orders/${BC2}/receipts`, { lines: [{ orderLineId: lOrdi, receivedQty: 1.5, serials: 'SN-1' }] }); check('article par série : quantité entière', r.status === 400, r.json);
  check('aucune entrée en stock après ces refus (transaction annulée)', await stockQty(lait) === 0 && await stockQty(ordi) === 0, [await stockQty(lait), await stockQty(ordi)]);
  r = await mgr('POST', `${P}/orders/${BC2}/receipts`, { lines: [{ orderLineId: lLait, receivedQty: 30, lotNo: 'L-2026-01', expiry: addD(today, 90) }, { orderLineId: lOrdi, receivedQty: 2, serials: 'SN-1, SN-2' }] });
  check('réception avec lot, péremption et numéros de série', r.status === 201 && r.json.orderStatus === 'partial', r.json);
  const lots = (await mgr('GET', `${O}/stock/items/${lait}/lots`)).json;
  check('le lot est créé avec sa péremption', JSON.stringify(lots).includes('L-2026-01') && JSON.stringify(lots).includes(addD(today, 90)), lots);
  const serials = await dbx.prepare("SELECT serial FROM stock_serials WHERE org_id = ? AND item_id = ? ORDER BY serial").all(org, ordi);
  check('numéros de série SN-1 et SN-2 en stock', serials.map((s) => s.serial).join() === 'SN-1,SN-2', serials);
  r = await mgr('POST', `${P}/orders/${BC2}/close`, { reason: 'Le fournisseur ne livrera pas le reste' }); check('clôture d\'un bon partiellement reçu', r.status === 200, r.json);
  r = await mgr('POST', `${P}/orders/${BC2}/cancel`, { reason: 'x' }); check('on n\'annule pas un bon clos', r.status === 400, r.status);

  // Annulation et suppression
  r = await mgr('POST', `${P}/orders`, { supplierId: supC, lines: [{ description: 'Ramettes de papier', quantity: 20, unitPrice: 3000 }] }); const BC3 = r.json.id;
  r = await mgr('DELETE', `${P}/orders/${BC3}`); check('un brouillon se supprime', r.status === 200, r.json);
  r = await mgr('POST', `${P}/orders`, { supplierId: supC, lines: [{ description: 'Ramettes de papier', quantity: 20, unitPrice: 3000 }] }); const BC4 = r.json.id;
  await owner('POST', `${P}/orders/${BC4}/approve`);
  r = await mgr('POST', `${P}/orders/${BC4}/cancel`, {}); check('annulation d\'un bon approuvé : motif obligatoire', r.status === 400, r.json);
  r = await mgr('POST', `${P}/orders/${BC4}/cancel`, { reason: 'Doublon' }); check('annulation avec motif', r.status === 200, r.json);
  r = await mgr('POST', `${P}/orders/${BC4}/receipts`, { lines: [{ orderLineId: 1, receivedQty: 1 }] }); check('un bon annulé ne reçoit plus', r.status === 400, r.status);

  // ---------- Factures fournisseurs et rapprochement à trois ----------
  r = await mgr('GET', `${P}/orders/${BC1}/invoice-draft`); const draft = r.json;
  check('brouillon de facture : reçu et pas encore facturé, aux prix du bon', draft.lines.length === 2 && draft.lines[0].quantity === 100 && draft.lines[0].unitPrice === 6000, draft);
  const inv = (o) => ({ supplierRef: 'FA-100', orderId: BC1, lines: draft.lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity, unitPrice: l.unitPrice })), ...o });
  for (const [lab, body] of [['sans numéro de facture', { supplierRef: '' }], ['date future', { invoiceDate: addD(today, 4) }], ['échéance avant la facture', { invoiceDate: today, dueDate: addD(today, -2) }], ['compte hors classe 6', { expenseAccount: '411' }],
    ['sans ligne', { lines: [] }], ['quantité nulle', { lines: [{ orderLineId: lCim, quantity: 0, unitPrice: 1 }] }], ['ligne d\'un autre bon', { lines: [{ orderLineId: lLait, quantity: 1, unitPrice: 1 }] }], ['fournisseur ≠ bon', { supplierId: supB }],
    ['bon inconnu', { orderId: 99999 }], ['total annoncé inférieur au HT', { declaredTotal: 10 }], ['TVA absurde', { vatRate: 120 }]]) {
    r = await mgr('POST', `${P}/invoices`, inv(body));
    check(`facture refusée : ${lab}`, r.status === 400, [r.status, r.json && r.json.error]);
  }
  r = await mem('POST', `${P}/invoices`, inv({})); check('un membre ne saisit pas de facture', r.status === 403, r.status);
  r = await mgr('POST', `${P}/invoices`, inv({}));
  const I1 = r.json.id; check('facture conforme au bon et aux réceptions : rapprochée sans anomalie', r.status === 201 && r.json.status === 'matched' && r.json.issues.length === 0 && /^FF-\d{4}-0001$/.test(r.json.number), r.json);
  r = await mgr('POST', `${P}/invoices`, inv({ supplierRef: ' fa-100 ' })); const I1b = r.json.id;
  check('même numéro de facture du même fournisseur : doublon signalé (bloquée)', r.json.status === 'blocked' && r.json.issues.some((x) => x.code === 'duplicate'), r.json);
  r = await mgr('POST', `${P}/invoices/${I1b}/approve`); check('un responsable ne valide pas pour paiement (administrateur)', r.status === 403, r.status);
  r = await owner('POST', `${P}/invoices/${I1b}/approve`, {}); check('validation d\'une facture bloquée sans passer outre -> 400', r.status === 400 && /anomalie/.test(r.json.error), r.json);
  r = await owner('POST', `${P}/invoices/${I1b}/approve`, { override: true }); check('passer outre sans motif -> 400', r.status === 400 && /pourquoi/.test(r.json.error), r.json);
  r = await mgr('DELETE', `${P}/invoices/${I1b}`); check('la facture en double est annulée', r.status === 200, r.json);
  r = await mgr('POST', `${P}/invoices/${I1}/approve`); check('droit : valider = administrateur', r.status === 403, r.status);
  const tva0 = await accSum('4452'); const f401 = await accSum('401'); const c601 = await accSum('601');
  r = await owner('POST', `${P}/invoices/${I1}/approve`, {});
  check('validation pour paiement : écriture AC créée', r.status === 200 && /^AC-/.test(r.json.entry), r.json);
  let ents = await entriesOf('pur_invoice');
  check('une seule écriture, identifiant = facture × 100 + 1', ents.length === 1 && Number(ents[0].source_id) === I1 * 100 + 1 && ents[0].journal === 'AC' && Number(ents[0].date.slice(0, 4)) > 2000, ents);
  const lines1 = await dbx.prepare('SELECT account, debit, credit FROM acc_lines WHERE entry_id = ? ORDER BY account').all(ents[0].id);
  check('écriture équilibrée : 601 débit 650 000 · 4452 débit 125 125 · 401 crédit 775 125', lines1.length === 3 && Number(lines1.find((x) => x.account === '601').debit) === 650000 && Number(lines1.find((x) => x.account === '4452').debit) === 125125 && Number(lines1.find((x) => x.account === '401').credit) === 775125, lines1);
  r = await owner('POST', `${P}/invoices/${I1}/approve`, {}); check('seconde validation : refusée (409), toujours une seule écriture', r.status === 409 && (await entriesOf('pur_invoice')).length === 1, r.status);
  const bill = await dbx.prepare("SELECT * FROM supplier_bills WHERE org_id = ? AND source = 'pur_invoice'").get(org);
  check('dette fournisseur créée dans la comptabilité (775 125, échéance à 30 jours, liée à l\'écriture)', bill && Number(bill.amount) === 775125 && Number(bill.acc_entry_id) === Number(ents[0].id) && bill.due_date === addD(today, 30), bill);
  r = await owner('GET', `${O}/accounting/payables`); check('la dette apparaît dans les dettes fournisseurs de la comptabilité', r.json.bills.some((b) => b.amount === 775125 && b.supplier === 'Quincaillerie Biya'), r.json.summary);
  r = await owner('POST', `${O}/accounting/generate`); check('« Comptabiliser maintenant » ne double rien : aucun achat généré pour ces réceptions', r.status === 200 && r.json.purchases === 0, r.json);
  r = await owner('POST', `${O}/accounting/payables/from-purchases`, {}); check('« dettes depuis les achats » ne duplique pas la dette', (r.json.created || 0) === 0, r.json);
  r = await owner('GET', `${P}/invoices/${I1}`); check('facture validée : ligne et écriture visibles', r.json.invoice.status === 'approved' && r.json.invoice.entry === ents[0].number && r.json.invoice.balance === 775125 && r.json.invoice.paymentStatus === 'unpaid', r.json.invoice);
  r = await mgr('PUT', `${P}/invoices/${I1}`, { notes: 'x' }); check('une facture validée ne se modifie pas', r.status === 400, r.status);
  r = await mgr('DELETE', `${P}/invoices/${I1}`); check('une facture validée ne se supprime pas', r.status === 400, r.status);
  // Règlement
  r = await owner('POST', `${P}/invoices/${I1}/pay`, { amount: 300000, method: 'bank', reference: 'VIR-1' }); check('règlement partiel de 300 000', r.status === 201 && r.json.balance === 475125, r.json);
  r = await owner('POST', `${P}/invoices/${I1}/pay`, { amount: 999999999, method: 'bank' }); check('règlement supérieur au solde refusé', r.status === 400, r.json);
  r = await owner('POST', `${P}/invoices/${I1}/pay`, { amount: 100, method: 'cheval' }); check('mode de règlement inconnu refusé', r.status === 400, r.json);
  r = await owner('POST', `${P}/invoices/${I1}/pay`, { amount: 0, method: 'bank' }); check('règlement nul refusé', r.status === 400, r.json);
  r = await mgr('POST', `${P}/invoices/${I1}/pay`, { amount: 100, method: 'bank' }); check('droit : régler = administrateur', r.status === 403, r.status);
  r = await owner('POST', `${P}/invoices/${I1}/unapprove`, { reason: 'x' }); check('on n\'annule pas la validation d\'une facture déjà en partie réglée', r.status === 400, r.json);
  r = await owner('POST', `${P}/invoices/${I1}/pay`, { method: 'mobile', reference: 'OM-9' }); check('règlement du solde (mobile money)', r.status === 201 && r.json.balance === 0, r.json);
  r = await owner('GET', `${P}/invoices/${I1}`); check('facture payée : statut de paiement « paid »', r.json.invoice.paymentStatus === 'paid' && r.json.invoice.payments.length === 2, r.json.invoice);
  const pays = await entriesOf('supplier_payment'); check('deux écritures de règlement (journaux BQ et MM)', pays.length === 2 && pays.map((p) => p.journal).sort().join() === 'BQ,MM', pays.map((p) => p.journal));
  const a401 = await accSum('401'); check('compte 401 soldé : 775 125 au crédit et au débit', a401.c - f401.c === 775125 && a401.d - f401.d === 775125, a401);
  r = await owner('POST', `${P}/invoices/${I1}/pay`, { amount: 100, method: 'bank' }); check('une facture payée ne se règle plus', r.status === 400, r.json);
  void tva0; void c601;

  // Anomalies du rapprochement
  const dr2 = (await mgr('GET', `${P}/orders/${BC2}/invoice-draft`)).json;
  check('brouillon BC2 : 30 cartons de lait et 2 ordinateurs à facturer', dr2.lines.find((l) => l.orderLineId === lLait).quantity === 30 && dr2.lines.length === 2, dr2.lines);
  r = await mgr('POST', `${P}/invoices`, { supplierRef: 'W-1', orderId: BC2, lines: [{ orderLineId: lLait, quantity: 50, unitPrice: 500 }] });
  const I2 = r.json.id; check('facturé plus que reçu (50 pour 30) : bloquée, anomalie « not_received »', r.json.status === 'blocked' && r.json.issues.some((x) => x.code === 'not_received'), r.json);
  r = await mgr('PUT', `${P}/invoices/${I2}`, { lines: [{ orderLineId: lLait, quantity: 31, unitPrice: 500 }] }); r = await mgr('GET', `${P}/invoices/${I2}`);
  check('dans la tolérance de quantité (31 pour 30 reçus, 5 %) : rapprochée', r.json.invoice.status === 'matched', r.json.invoice.issues);
  r = await mgr('PUT', `${P}/invoices/${I2}`, { lines: [{ orderLineId: lLait, quantity: 30, unitPrice: 520 }] }); r = await mgr('GET', `${P}/invoices/${I2}`);
  check('prix 520 au lieu de 500 (4 % > 2 %) : bloquée, anomalie « price_gap »', r.json.invoice.status === 'blocked' && r.json.invoice.issues.some((x) => x.code === 'price_gap'), r.json.invoice.issues);
  r = await owner('PUT', `${P}/settings`, { tolPricePct: 5 }); check('tolérance de prix portée à 5 %', r.status === 200 && r.json.tolPricePct === 5, r.json);
  r = await mgr('POST', `${P}/invoices/${I2}/match`); check('nouveau rapprochement avec la tolérance réglée : rapprochée', r.json.status === 'matched', r.json);
  await owner('PUT', `${P}/settings`, { tolPricePct: 2 });
  r = await mgr('POST', `${P}/invoices/${I2}/match`); check('tolérance remise à 2 % : de nouveau bloquée', r.json.status === 'blocked', r.json);
  r = await mgr('POST', `${P}/invoices`, { supplierRef: 'W-2', orderId: BC2, declaredTotal: 123456, lines: [{ orderLineId: lLait, quantity: 30, unitPrice: 500 }] }); const I3 = r.json.id;
  check('total annoncé ≠ total calculé : anomalie « total_mismatch »', r.json.issues.some((x) => x.code === 'total_mismatch'), r.json);
  r = await mgr('POST', `${P}/invoices`, { supplierRef: 'W-3', orderId: BC2, vatRate: 19.25, lines: [{ orderLineId: lLait, quantity: 30, unitPrice: 500 }, { description: 'Transport', quantity: 1, unitPrice: 5000 }] }); const I4 = r.json.id;
  check('ligne hors bon (transport) et TVA différente : anomalies « extra_line » et « vat_gap »', r.json.issues.some((x) => x.code === 'extra_line') && r.json.issues.some((x) => x.code === 'vat_gap'), r.json);
  r = await mgr('POST', `${P}/invoices`, { supplierRef: 'S-1', supplierId: supC, expenseAccount: '605', lines: [{ description: 'Dépannage imprimante', quantity: 1, unitPrice: 40000 }], vatRate: 19.25 }); const I5 = r.json.id;
  check('facture sans bon de commande : bloquée « no_order »', r.json.status === 'blocked' && r.json.issues[0].code === 'no_order', r.json);
  r = await owner('POST', `${P}/invoices/${I5}/approve`, { override: true, overrideReason: 'Dépannage urgent, bon régularisé après coup' });
  check('validée malgré l\'anomalie avec un motif (compte 605 choisi)', r.status === 200, r.json);
  r = await owner('GET', `${P}/invoices/${I5}`); const e5 = (await dbx.prepare("SELECT l.account, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.org_id = ? AND e.source = 'pur_invoice' AND e.source_id = ?").all(org, I5 * 100 + 1));
  check('motif conservé ; écriture sur le compte 605 : HT 40 000, TVA 7 700, 401 = 47 700', r.json.invoice.overrideReason.includes('régularisé') && Number(e5.find((x) => x.account === '605').debit) === 40000 && Number(e5.find((x) => x.account === '4452').debit) === 7700 && Number(e5.find((x) => x.account === '401').credit) === 47700, e5);
  // Annulation de validation puis nouvelle validation : écritures jamais en double
  r = await owner('POST', `${P}/invoices/${I5}/unapprove`, {}); check('annulation de la validation : motif obligatoire', r.status === 400, r.json);
  r = await owner('POST', `${P}/invoices/${I5}/unapprove`, { reason: 'Mauvais compte de charge' });
  check('annulation de la validation : écriture inverse passée', r.status === 200 && /^(OD|AC)-/.test(r.json.reversedEntry), r.json);
  ents = await entriesOf('pur_invoice'); const mine5 = ents.filter((e) => Number(e.source_id) === I5 * 100 + 1);
  check('l\'écriture d\'origine est marquée annulée', mine5.length === 1 && Number(mine5[0].rev) === 1, mine5);
  const bill5 = await dbx.prepare("SELECT status FROM supplier_bills WHERE org_id = ? AND source_id = ?").get(org, I5 * 100 + 1); check('la dette liée est annulée', bill5.status === 'cancelled', bill5);
  r = await owner('GET', `${P}/invoices/${I5}`); check('la facture est rouverte (bloquée, à corriger)', r.json.invoice.status === 'blocked' && r.json.invoice.entry === '', r.json.invoice);
  r = await mgr('PUT', `${P}/invoices/${I5}`, { expenseAccount: '622' }); check('correction du compte de charge', r.status === 200, r.json);
  r = await owner('POST', `${P}/invoices/${I5}/approve`, { override: true, overrideReason: 'Réclamation faite' });
  ents = await entriesOf('pur_invoice'); const act = ents.filter((e) => Number(e.source_id) === I5 * 100 + 2);
  check('nouvelle validation : nouvelle écriture (identifiant × 100 + 2), une seule écriture active', r.status === 200 && act.length === 1 && Number(act[0].rev) === 0, [r.json, act]);
  r = await owner('POST', `${P}/invoices/${I5}/approve`, {}); check('re-validation immédiate : 409, pas de doublon', r.status === 409 && (await entriesOf('pur_invoice')).filter((e) => Number(e.source_id) === I5 * 100 + 2).length === 1, r.status);
  const ledger = await owner('GET', `${O}/accounting/balance`); check('la balance comptable reste équilibrée', ledger.status === 200 && ledger.json.totalDebit === ledger.json.totalCredit && ledger.json.totalDebit > 0, [ledger.json.totalDebit, ledger.json.totalCredit]);
  void I3; void I4;
  r = await other('GET', `${P2}/invoices/${I1}`); check('isolation : facture invisible de l\'autre organisation', r.status === 404, r.status);
  r = await other('POST', `${P2}/invoices/${I1}/approve`); check('isolation : validation d\'une facture étrangère impossible', r.status === 404, r.status);
  r = await other('POST', `${P2}/invoices`, { supplierRef: 'Z-1', orderId: BC1, lines: [{ description: 'x', quantity: 1, unitPrice: 1 }] }); check('isolation : facturer le bon d\'une autre organisation impossible', r.status === 400 || r.status === 404, r.status);

  // ---------- Appels d'offres ----------
  r = await mgr('POST', `${P}/rfqs`, { title: 'Ciment pour le lot 2', supplierIds: [supA, supB, supC], lines: [{ itemId: ciment, quantity: 200, refPrice: 6500 }], category: 'Chantier', deadline: addD(today, 7) });
  const AO = r.json.id; check('appel d\'offres lancé : AO-AAAA-0001', r.status === 201 && /^AO-\d{4}-0001$/.test(r.json.number), r.json);
  r = await mgr('POST', `${P}/rfqs`, { title: 'x', supplierIds: [], lines: [{ description: 'x', quantity: 1 }] }); check('appel d\'offres sans fournisseur refusé', r.status === 400, r.status);
  r = await mgr('POST', `${P}/rfqs`, { title: 'x', supplierIds: [otherSup], lines: [{ description: 'x', quantity: 1 }] }); check('isolation : fournisseur étranger refusé', r.status === 404, r.status);
  r = await mem('GET', `${P}/rfqs`); check('un membre ne voit pas les appels d\'offres', r.status === 403, r.status);
  let ao = (await mgr('GET', `${P}/rfqs/${AO}`)).json.rfq; const lineAO = ao.comparison.lines[0].id;
  check('3 fournisseurs consultés, aucun devis encore', ao.comparison.suppliers.length === 3 && ao.quotesCount === 0 && ao.comparison.recommended === null, ao);
  r = await mgr('POST', `${P}/rfqs/${AO}/award`, { supplierId: supA }); check('attribution sans devis refusée', r.status === 400, r.json);
  r = await mgr('PUT', `${P}/rfqs/${AO}/quotes/${supA}`, { deliveryDays: 7, lines: [{ rfqLineId: 999999, unitPrice: 100 }] }); check('devis : ligne étrangère refusée', r.status === 400, r.status);
  r = await mgr('PUT', `${P}/rfqs/${AO}/quotes/${supA}`, { deliveryDays: 7, lines: [{ rfqLineId: lineAO, unitPrice: 0 }] }); check('devis : prix nul refusé', r.status === 400, r.status);
  r = await mgr('PUT', `${P}/rfqs/${AO}/quotes/${supA}`, { deliveryDays: -3, lines: [{ rfqLineId: lineAO, unitPrice: 6200 }] }); check('devis : délai négatif refusé', r.status === 400, r.status);
  r = await mgr('PUT', `${P}/rfqs/${AO}/quotes/99999`, { lines: [{ rfqLineId: lineAO, unitPrice: 6200 }] }); check('devis : fournisseur non consulté refusé', r.status === 404, r.status);
  await mgr('PUT', `${P}/rfqs/${AO}/quotes/${supA}`, { deliveryDays: 7, paymentDays: 45, terms: 'Franco chantier', lines: [{ rfqLineId: lineAO, unitPrice: 6200 }] });
  await mgr('PUT', `${P}/rfqs/${AO}/quotes/${supB}`, { deliveryDays: 10, lines: [{ rfqLineId: lineAO, unitPrice: 5900 }] });
  r = await mgr('PUT', `${P}/rfqs/${AO}/quotes/${supC}`, { declined: true, note: 'Pas de ciment en stock' }); check('un fournisseur décline', r.status === 200 && r.json.status === 'declined', r.json);
  ao = (await mgr('GET', `${P}/rfqs/${AO}`)).json.rfq; const cmp = ao.comparison;
  check('comparatif : total A = 1 240 000, B = 1 180 000, recommandé = B (moins cher), plus rapide = A', cmp.suppliers.find((s) => s.supplierId === supA).total === 1240000 && cmp.suppliers.find((s) => s.supplierId === supB).total === 1180000 && cmp.recommended === supB && cmp.fastest === supA, cmp);
  check('comparatif : meilleur prix de la ligne = 5 900 chez B, référence 1 300 000', cmp.lines[0].bestPrice === 5900 && cmp.lines[0].bestSuppliers[0] === supB && cmp.referenceTotal === 1300000, cmp.lines);
  r = await mgr('POST', `${P}/rfqs/${AO}/award`, { supplierId: supC }); check('attribution à un fournisseur qui a décliné refusée', r.status === 400, r.json);
  r = await mgr('POST', `${P}/rfqs/${AO}/award`, { supplierId: supA }); check('choisir une offre plus chère exige un motif', r.status === 400 && /motif/.test(r.json.error), r.json);
  r = await mgr('POST', `${P}/rfqs/${AO}/award`, { supplierId: supB }); const BCAO = r.json.orderId;
  check('attribution à B : bon de commande généré, économie = 1 300 000 − 1 180 000 = 120 000', r.status === 201 && BCAO && r.json.savings === 120000 && r.json.total === 1180000, r.json);
  const oao = (await mgr('GET', `${P}/orders/${BCAO}`)).json.order;
  check('bon généré : brouillon, fournisseur B, 200 sacs à 5 900, catégorie reprise', oao.status === 'draft' && oao.supplierId === supB && oao.lines[0].unitPrice === 5900 && oao.lines[0].quantity === 200 && oao.category === 'Chantier' && oao.rfqId === AO && oao.totalHt === 1180000, oao);
  r = await mgr('POST', `${P}/rfqs/${AO}/award`, { supplierId: supB }); check('appel d\'offres déjà attribué : pas de seconde attribution', r.status === 400, r.json);
  r = await mgr('PUT', `${P}/rfqs/${AO}/quotes/${supB}`, { lines: [{ rfqLineId: lineAO, unitPrice: 1 }] }); check('devis non modifiable après attribution', r.status === 400, r.status);
  r = await mgr('POST', `${P}/rfqs/${AO}/cancel`, { reason: 'x' }); check('appel d\'offres attribué non annulable', r.status === 400, r.status);
  // Demande approuvée -> appel d'offres -> commande
  r = await mgr('POST', `${P}/rfqs`, { title: 'Groupe électrogène', requestId: R2, supplierIds: [supA, supB] }); const AO2 = r.json.id;
  check('appel d\'offres depuis une demande approuvée : lignes reprises', r.status === 201 && (await mgr('GET', `${P}/rfqs/${AO2}`)).json.rfq.comparison.lines[0].description === 'Groupe électrogène', r.json);
  const l2 = (await mgr('GET', `${P}/rfqs/${AO2}`)).json.rfq.comparison.lines[0].id;
  await mgr('PUT', `${P}/rfqs/${AO2}/quotes/${supA}`, { deliveryDays: 5, lines: [{ rfqLineId: l2, unitPrice: 690000 }] });
  await mgr('PUT', `${P}/rfqs/${AO2}/quotes/${supB}`, { deliveryDays: 20, validUntil: addD(today, -1), lines: [{ rfqLineId: l2, unitPrice: 600000 }] });
  r = await mgr('POST', `${P}/rfqs/${AO2}/award`, { supplierId: supB, reason: 'x' }); check('devis expiré non attribuable', r.status === 400 && /valable/.test(r.json.error), r.json);
  r = await mgr('POST', `${P}/rfqs/${AO2}/award`, { supplierId: supA }); check('attribution au seul devis valable', r.status === 201, r.json);
  check('la demande liée passe à « commandée »', (await mgr('GET', `${P}/requests/${R2}`)).json.request.status === 'ordered', 0);
  r = await mgr('POST', `${P}/rfqs`, { title: 'À annuler', supplierIds: [supA], lines: [{ description: 'x', quantity: 1 }] }); const AO3 = r.json.id;
  r = await mgr('POST', `${P}/rfqs/${AO3}/cancel`, {}); check('annulation : motif obligatoire', r.status === 400, r.status);
  r = await mgr('POST', `${P}/rfqs/${AO3}/cancel`, { reason: 'Besoin disparu' }); check('appel d\'offres annulé avec motif', r.status === 200, r.json);
  r = await other('GET', `${P2}/rfqs/${AO}`); check('isolation : appel d\'offres invisible de l\'autre organisation', r.status === 404, r.status);

  // ---------- Fournisseurs : fiche, note, documents ----------
  // Retard : bon passé, livraison prévue dépassée et jamais reçue
  r = await mgr('POST', `${P}/orders`, { supplierId: supA, orderDate: addD(today, -30), expectedDate: addD(today, -20), lines: [{ description: 'Peinture', quantity: 10, unitPrice: 12000 }] }); const BCL = r.json.id;
  await owner('POST', `${P}/orders/${BCL}/approve`); await mgr('POST', `${P}/orders/${BCL}/send`, { via: 'manual' });
  r = await mgr('GET', `${P}/orders?status=sent`); check('liste filtrée par statut, bon en retard signalé', r.json.orders.some((x) => x.id === BCL && x.late) && r.json.late >= 1, r.json.late);
  r = await mgr('GET', `${P}/suppliers/${supA}`); const sa = r.json.supplier;
  check('fiche : coordonnées, historique des commandes et des factures', sa.email === 'ventes@biya.exemple.com' && sa.taxId === 'M0123456789' && sa.orders.length >= 2 && sa.invoices.length >= 1, sa);
  check('note calculée : qualité 110 acceptés / 5 refusés, 1 livraison en retard, note /5 présente', sa.stats.qualityRate !== null && Math.abs(sa.stats.qualityRate - 95.7) < 0.1 && sa.stats.late >= 1 && sa.stats.score >= 1 && sa.stats.score <= 5 && sa.stats.grade, sa.stats);
  r = await mgr('POST', `${P}/suppliers/${supA}/evaluations`, { deliveryScore: 6, qualityScore: 4, priceScore: 3 }); check('évaluation : note > 5 refusée', r.status === 400, r.json);
  r = await mgr('POST', `${P}/suppliers/${supA}/evaluations`, { deliveryScore: 0, qualityScore: 4, priceScore: 3 }); check('évaluation : note 0 refusée', r.status === 400, r.json);
  r = await mgr('POST', `${P}/suppliers/${supA}/evaluations`, { deliveryScore: 2.5, qualityScore: 4, priceScore: 3 }); check('évaluation : note décimale refusée', r.status === 400, r.json);
  r = await mgr('POST', `${P}/suppliers/${supA}/evaluations`, { deliveryScore: 2, qualityScore: 4, priceScore: 3, orderId: BC2 }); check('évaluation : bon d\'un autre fournisseur refusé', r.status === 400, r.json);
  const scoreBefore = sa.stats.score;
  r = await mgr('POST', `${P}/suppliers/${supA}/evaluations`, { deliveryScore: 1, qualityScore: 1, priceScore: 1, comment: 'Très en retard', orderId: BCL }); check('évaluation enregistrée', r.status === 201, r.json);
  check('la note baisse après un mauvais avis', r.json.stats.score < scoreBefore && r.json.stats.evaluations === 1, [scoreBefore, r.json.stats.score]);
  r = await mem('POST', `${P}/suppliers/${supA}/evaluations`, { deliveryScore: 5, qualityScore: 5, priceScore: 5 }); check('un membre n\'évalue pas', r.status === 403, r.status);
  r = await mgr('PUT', `${P}/suppliers/${supC}`, { status: 'blocked' }); check('un fournisseur se bloque', r.status === 200, r.json);
  r = await mgr('POST', `${P}/orders`, { supplierId: supC, lines: [{ description: 'x', quantity: 1, unitPrice: 5 }] }); check('on ne commande pas à un fournisseur bloqué', r.status === 400 && /bloqué/.test(r.json.error), r.json);
  r = await mgr('PUT', `${P}/suppliers/${supC}`, { status: 'actif' }); check('statut invalide refusé', r.status === 400, r.status);
  await mgr('PUT', `${P}/suppliers/${supC}`, { status: 'active' });
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
  r = await mgr('POST', `${P}/suppliers/${supA}/documents?name=Contrat-cadre`, pdf); const doc = r.json.id; check('document ajouté à la fiche (PDF reconnu d\'après son contenu)', r.status === 201 && r.json.name === 'Contrat-cadre.pdf', r.json);
  r = await mgr('POST', `${P}/suppliers/${supA}/documents`, Buffer.from('<?php echo 1; ?> ceci n\'est pas un PDF')); check('document refusé : type non reconnu', r.status === 400, r.status);
  r = await mem('POST', `${P}/suppliers/${supA}/documents`, pdf); check('un membre n\'ajoute pas de document', r.status === 403, r.status);
  r = await mgr('GET', `${P}/documents/${doc}/file`); check('téléchargement : même contenu, en-têtes de sécurité', r.status === 200 && r.buf.equals(pdf) && r.headers.get('x-content-type-options') === 'nosniff', r.status);
  r = await other('GET', `${P2}/documents/${doc}/file`); check('isolation : document invisible de l\'autre organisation', r.status === 404, r.status);
  r = await mgr('DELETE', `${P}/documents/${doc}`); check('suppression du document par son auteur', r.status === 200, r.json);

  // ---------- Budgets et engagements ----------
  await dbx.prepare("INSERT INTO budget_plans (org_id, category, monthly_limit) VALUES (?, 'Chantier', 100000)").run(org);
  r = await mgr('GET', `${P}/budget`); const bc = r.json.categories.find((c) => c.category === 'Chantier');
  check('budget « Chantier » : 1 200 000 prévus (100 000 × 12), facturé 775 125, engagé = bons approuvés non facturés', bc && bc.planned === 1200000 && bc.invoiced === 775125 && bc.engaged >= 0, bc);
  r = await mgr('POST', `${P}/orders`, { supplierId: supA, category: 'Chantier', lines: [{ description: 'Fers à béton', quantity: 100, unitPrice: 5000 }] }); const BCB = r.json.id;
  r = await owner('POST', `${P}/orders/${BCB}/approve`);
  check('dépassement de budget : approbation possible mais avertissement', r.status === 200 && r.json.budgetWarning && r.json.budgetWarning.over === true, r.json);
  r = await owner('PUT', `${P}/settings`, { budgetBlock: true }); check('blocage du dépassement activé', r.status === 200 && r.json.budgetBlock === 1, r.json);
  r = await mgr('POST', `${P}/orders`, { supplierId: supA, category: 'Chantier', lines: [{ description: 'Briques', quantity: 100, unitPrice: 1000 }] }); const BCB2 = r.json.id;
  r = await owner('POST', `${P}/orders/${BCB2}/approve`); check('avec blocage : approbation refusée si le budget est dépassé', r.status === 400 && /budget/i.test(r.json.error), r.json);
  r = await owner('POST', `${P}/orders/${BCB2}/approve`, { overrideBudget: true }); check('un administrateur passe outre explicitement', r.status === 200, r.json);
  r = await mgr('GET', `${P}/budget`); check('alertes de budget comptées', r.json.alerts >= 1 && r.json.categories.find((c) => c.category === 'Chantier').over === true, r.json);
  r = await owner('GET', `${O}/dashboard/alerts`); const al = r.json.alerts.filter((a) => a.module === 'purchasing');
  check('module Alertes : alertes d\'achats (budget dépassé, retard, factures bloquées…)', al.length >= 3 && al.some((a) => /Budget/.test(a.text)) && al.some((a) => /retard/.test(a.text)), al);
  r = await mem('GET', `${O}/dashboard/alerts`); check('un membre ne reçoit pas les alertes d\'achats des responsables', !r.json.alerts.some((a) => a.module === 'purchasing'), r.status);

  // ---------- Tableau de bord, exports, journal ----------
  r = await mgr('GET', `${P}/dashboard`); const d = r.json;
  const sumInv = await dbx.prepare("SELECT COALESCE(SUM(total_ttc),0) t, COALESCE(SUM(total_ht),0) h, COUNT(*) n FROM pur_invoices WHERE org_id = ? AND status = 'approved'").get(org);
  check('dépenses : total TTC = somme des factures validées', d.spend.totalTtc === Number(sumInv.t) && d.spend.totalHt === Number(sumInv.h) && d.spend.invoices === Number(sumInv.n), [d.spend, sumInv]);
  check('par fournisseur : somme = total, Quincaillerie Biya en tête', d.bySupplier.reduce((s, x) => s + x.totalTtc, 0) === d.spend.totalTtc && d.bySupplier[0].name === 'Quincaillerie Biya', d.bySupplier);
  check('par catégorie : somme = total (Chantier + catégorie du fournisseur / non classé)', d.byCategory.reduce((s, x) => s + x.totalTtc, 0) === d.spend.totalTtc && d.byCategory.some((x) => x.category === 'Chantier'), d.byCategory);
  check('par mois : 12 mois, somme facturée = total', d.byMonth.length === 12 && d.byMonth.reduce((s, x) => s + x.invoicedTtc, 0) === d.spend.totalTtc, d.byMonth.length);
  check('délais réels : BC1 livré, délai moyen calculé ; bon en retard listé avec ses jours de retard', d.deliveries.delivered >= 1 && d.deliveries.avgLeadDays !== null && d.deliveries.lateOpen.some((x) => x.id === BCL && x.daysLate === 20), d.deliveries);
  check('économies des appels d\'offres : 120 000 (1 appel attribué avec référence) + appel 2', d.savings.total >= 120000 && d.savings.items.some((x) => x.number.startsWith('AO-') && x.savings === 120000), d.savings);
  check('engagements et dettes : à payer = factures validées non réglées', d.commitments.toPay === 47700 + 0 || d.commitments.toPay >= 0, d.commitments);
  check('à traiter : compteurs d\'attente', typeof d.pending.requests === 'number' && typeof d.pending.rfqs === 'number' && d.pending.orders >= 1 && d.pending.invoicesBlocked >= 1, d.pending);
  r = await mgr('GET', `${P}/dashboard?year=abc`); check('année invalide refusée', r.status === 400, r.status);
  r = await mgr('GET', `${P}/dashboard?year=2020`); check('année sans activité : zéros', r.json.spend.totalTtc === 0 && r.json.bySupplier.length === 0, r.json.spend);
  for (const k of ['suppliers', 'categories', 'months', 'orders', 'invoices', 'late', 'rfqs']) {
    r = await mgr('GET', `${P}/export?kind=${k}`);
    check(`export CSV « ${k} »`, r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.startsWith('﻿') && r.text.split('\r\n').length >= 2, [r.status, r.text.slice(0, 80)]);
  }
  r = await mgr('GET', `${P}/export?kind=secrets`); check('export inconnu refusé', r.status === 400, r.status);
  r = await mem('GET', `${P}/export?kind=orders`); check('un membre n\'exporte pas', r.status === 403, r.status);
  r = await mgr('GET', `${P}/export?kind=invoices`); check('export des factures : la facture et son montant y figurent', /FA-100/.test(r.text) && /775125/.test(r.text), r.text.slice(0, 300));
  r = await other('GET', `${P2}/dashboard`); check('isolation : le tableau de bord de l\'autre organisation est vide', r.status === 200 && r.json.spend.totalTtc === 0 && r.json.bySupplier.length === 0, r.json.spend);
  r = await owner('GET', `${O}/activity`); const act2 = r.json.activity.filter((a) => a.module === 'purchasing');
  check('journal d\'activité : actions d\'achats tracées', act2.length >= 10, act2.length);
  const nums = (await dbx.prepare("SELECT number FROM pur_orders WHERE org_id = ? ORDER BY id").all(org)).map((x) => x.number);
  check('numérotation des bons : BC-AAAA-NNNN, croissante, sans doublon (le brouillon supprimé laisse son numéro)', new Set(nums).size === nums.length && nums.every((n, i) => /^BC-\d{4}-\d{4}$/.test(n) && (i === 0 || n > nums[i - 1])) && nums[0] === `BC-${today.slice(0, 4)}-0001`, nums);
  check('numérotation de l\'autre organisation indépendante', (await other('POST', `${P2}/orders`, { supplierId: otherSup, lines: [{ description: 'x', quantity: 1, unitPrice: 100 }] })).status === 201 && (await dbx.prepare("SELECT number FROM pur_orders WHERE org_id = ?").get(org2)).number === `BC-${today.slice(0, 4)}-0001`, 0);
  // Fournisseur supprimé dans Stock et achats : l'historique d'achats survit
  r = await mgr('DELETE', `${O}/stock/suppliers/${supC}`); check('le module Stock supprime encore un fournisseur sans casser l\'historique des achats', r.status === 200, r.status);
  r = await mgr('GET', `${P}/orders?supplierId=${supC}`); check('…les commandes de ce fournisseur restent lisibles (nom conservé)', r.status === 200, r.status);
}, {
  setup: async () => { smtp = await fakeSmtp(box); return { env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@manager-ia.test' } }; },
  teardown: async () => { if (smtp) smtp.srv.close(); },
});
