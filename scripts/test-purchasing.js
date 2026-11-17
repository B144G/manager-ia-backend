'use strict';
// Achats : demande → approbation → commande → réception (stock) → facture rapprochée → validation (écriture) → paiement ; appels d'offres, budgets, fournisseurs.
// Lancez-le avec : node scripts/test-purchasing.js
const { run } = require('./lib/wave1');

const pdf = Buffer.from('%PDF-1.4\n% devis\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

run('Achats : de la demande au paiement', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx }) => {
  const PU = `${O}/purchasing`;
  const Y = new Date().getUTCFullYear();
  const today = new Date().toISOString().slice(0, 10);
  let r;

  r = await mem('GET', O);
  check('module : les Achats sont dans le menu d\'un membre', r.json.modules.some((m) => m.id === 'purchasing'), r.json.modules.map((m) => m.id));
  r = await other('GET', `${PU}/summary`);
  check('cloisonnement : une autre organisation n\'accède pas aux achats', r.status === 404, r.status);

  // ---------- Préparation : articles, fournisseurs, budget ----------
  r = await owner('POST', `${O}/stock/items`, { name: 'Ciment 50 kg', unit: 'sac', minQuantity: 20, unitCost: 4500 });
  const ciment = r.json.id;
  r = await owner('POST', `${O}/stock/items`, { name: 'Vaccin', unit: 'dose', unitCost: 1000, tracking: 'lot' });
  const vaccin = r.json.id;
  check('préparation : articles créés', ciment && vaccin, r.json);
  r = await mem('POST', `${PU}/suppliers`, { name: 'Pirate' });
  check('fournisseurs : un membre ne crée pas de fournisseur', r.status === 403, r.status);
  r = await owner('POST', `${PU}/suppliers`, { name: 'Cimencam', email: 'ventes@cimencam.test', phone: '699000000', city: 'Douala', paymentDays: 30, category: 'Matériaux', status: 'active' });
  const s1 = r.json.id;
  r = await owner('POST', `${PU}/suppliers`, { name: 'Dangote', paymentDays: 45, status: 'active' });
  const s2 = r.json.id;
  r = await owner('POST', `${PU}/suppliers`, { name: 'cimencam' });
  check('fournisseurs : nom en double refusé', r.status === 409 && r.json.error === 'Un fournisseur de ce nom existe déjà.', r.json);
  r = await owner('POST', `${PU}/suppliers`, { name: 'Bloqué SA', status: 'blocked' });
  const sBlocked = r.json.id;
  r = await owner('GET', `${O}/stock/suppliers`);
  check('fournisseurs : partagés avec le module Stock', r.json.suppliers.some((s) => s.name === 'Cimencam'), r.json);
  await dbx.prepare("INSERT INTO budget_annual (org_id, year, kind, category, amounts) VALUES (?, ?, 'expense', 'Matériaux', ?)").run(org, String(Y), JSON.stringify(Array(12).fill(100000)));

  // ---------- Demande d'achat ----------
  r = await mem('POST', `${PU}/requests`, { title: 'Ciment chantier', lines: [], submit: true });
  check('demande : sans ligne refusée', r.status === 400 && r.json.error === 'Ajoutez au moins une ligne.', r.json);
  r = await mem('POST', `${PU}/requests`, { title: 'Ciment chantier', lines: [{ quantity: 2 }], submit: true });
  check('demande : ligne sans article ni désignation refusée', r.status === 400 && /désignation/.test(r.json.error), r.json);
  r = await mem('POST', `${PU}/requests`, { title: 'Ciment chantier', category: 'Matériaux', justification: 'Dalle du bâtiment B', lines: [{ itemId: ciment, quantity: 100, unit: 'sac', estPrice: 5000 }, { description: 'Transport', quantity: 1, unit: 'forfait' }], submit: true });
  check('demande : envoyée avec numéro DA-', r.status === 201 && /^DA-\d{4}-0001$/.test(r.json.number), r.json);
  const rq = r.json.id;
  r = await mem('GET', `${PU}/requests?mine=1`);
  check('demande : le membre la voit, au statut « à approuver », total estimé', r.json.requests.length === 1 && r.json.requests[0].status === 'submitted' && r.json.requests[0].total === 500000 && r.json.counts.submitted === 1, r.json);
  r = await mem('POST', `${PU}/requests`, { title: 'Brouillon', lines: [{ description: 'Stylos', quantity: 10 }] });
  const draft = r.json.id;
  r = await owner('GET', `${PU}/requests?status=submitted&`);
  check('demande : liste filtrée (paramètres tolérés)', r.status === 200 && r.json.requests.length === 1, r.json);
  r = await mgr('GET', `${PU}/requests/${draft}`);
  check('demande : un responsable voit les demandes des autres', r.status === 200 && r.json.request.canApprove === false, r.json);
  r = await other('GET', `${ws(org2)}/purchasing/requests/${rq}`);
  check('cloisonnement : demande introuvable depuis une autre organisation', r.status === 404, r.status);
  r = await mem('GET', `${PU}/requests/${rq}`);
  check('demande : détail (budget, rôle requis, pas d\'approbation par le demandeur)', r.json.request.budget && r.json.request.budget.planned === 1200000 && r.json.request.requiredRoleLabel === 'Responsable' && !r.json.request.canApprove && r.json.request.mine, r.json.request);
  r = await mem('POST', `${PU}/requests/${rq}/approve`, {});
  check('demande : un membre n\'approuve pas', r.status === 403, r.status);

  // Seuil : au-delà de 400 000, un administrateur doit approuver
  r = await mgr('PUT', `${PU}/settings`, { thresholds: { request: [{ minAmount: 400000, role: 'admin' }], order: [] } });
  check('réglages : un responsable ne les modifie pas', r.status === 403, r.status);
  r = await owner('PUT', `${PU}/settings`, { tolQtyPct: 5, tolPricePct: 2, tolAmount: 500, budgetBlock: false, defaultTermsDays: 30, thresholds: { request: [{ minAmount: 400000, role: 'admin' }], order: [{ minAmount: '', role: 'admin' }] } });
  check('réglages : enregistrés', r.status === 200, r.json);
  r = await mgr('GET', `${PU}/settings`);
  check('réglages : relus (règle vide ignorée, rôles proposés)', r.json.thresholds.request.length === 1 && r.json.thresholds.order.length === 0 && r.json.roles.some((x) => x.role === 'admin' && x.label === 'Administrateur'), r.json);
  r = await mgr('GET', `${PU}/requests/${rq}`);
  check('seuil : le responsable ne peut plus approuver 500 000', r.json.request.canApprove === false && r.json.request.requiredRoleLabel === 'Administrateur', r.json.request);
  r = await mgr('POST', `${PU}/requests/${rq}/approve`, {});
  check('seuil : approbation refusée au responsable', r.status === 403, r.json);
  r = await mgr('POST', `${PU}/requests/${rq}/reject`, {});
  check('refus : motif obligatoire', r.status === 400 && r.json.error === 'Indiquez le motif du refus.', r.json);
  r = await owner('POST', `${PU}/requests/${rq}/approve`, {});
  check('demande : approuvée par le propriétaire', r.status === 200, r.json);
  r = await mem('POST', `${PU}/requests/${draft}/to-order`, { supplierId: s1 });
  check('demande → commande : interdit à un membre', r.status === 403, r.status);
  r = await owner('POST', `${PU}/requests/${draft}/to-order`, { supplierId: s1 });
  check('demande → commande : un brouillon ne devient pas une commande', r.status === 400 && r.json.error === 'Seule une demande approuvée peut devenir un bon de commande.', r.json);
  r = await owner('POST', `${PU}/requests/${rq}/to-order`, { supplierId: sBlocked });
  check('demande → commande : fournisseur bloqué refusé', r.status === 400, r.json);
  const reqLines = (await mem('GET', `${PU}/requests/${rq}`)).json.request.lines;
  r = await owner('POST', `${PU}/requests/${rq}/to-order`, { supplierId: s1, prices: { [reqLines[1].id]: 25000 } });
  check('demande → commande : bon de commande en brouillon créé', r.status === 201 && r.json.orderId, r.json);
  const po = r.json.orderId;
  r = await mem('GET', `${PU}/requests/${rq}`);
  check('demande : passée à « commandée »', r.json.request.status === 'ordered', r.json.request.status);
  r = await mem('POST', `${PU}/requests/${draft}/duplicate`, {});
  check('demande : copie en brouillon', r.status === 201, r.json);
  r = await mem('DELETE', `${PU}/requests/${draft}`);
  check('demande : brouillon supprimé par son auteur', r.status === 200, r.json);

  // ---------- Bon de commande ----------
  r = await mem('GET', `${PU}/orders`);
  check('commandes : invisibles pour un membre', r.status === 403, r.status);
  r = await owner('GET', `${PU}/orders/${po}`);
  const o1 = r.json.order;
  check('commande : lignes, prix repris, TVA de l\'organisation, total TTC', o1.status === 'draft' && o1.lines.length === 2 && o1.lines[1].unitPrice === 25000 && o1.vatRate === 19.25 && o1.totalHt === 525000 && o1.totalTtc === 525000 + Math.round(525000 * 0.1925), o1);
  check('commande : budget « Matériaux » présent, brouillon non compté dans l\'engagé', o1.budget && o1.budget.engaged === 0 && o1.budget.planned === 1200000, o1.budget);
  r = await owner('POST', `${PU}/orders/${po}/receipts`, { lines: [{ orderLineId: o1.lines[0].id, receivedQty: 10 }] });
  check('réception : refusée avant approbation', r.status === 400 && r.json.error === "Approuvez le bon de commande avant d'enregistrer une réception.", r.json);
  r = await owner('POST', `${PU}/orders/${po}/approve`, {});
  check('commande : approuvée', r.status === 200, r.json);
  r = await owner('POST', `${PU}/orders/${po}/send`, { via: 'email', to: 'ventes@cimencam.test' });
  check('envoi par e-mail : message clair si l\'e-mail n\'est pas configuré', r.status === 400 && /Marquer comme envoyé/.test(r.json.error), r.json);
  r = await owner('POST', `${PU}/orders/${po}/send`, { via: 'manual', to: '' });
  check('envoi : marqué comme envoyé', r.status === 200, r.json);
  r = await owner('GET', `${PU}/orders/${po}/pdf`);
  check('commande : PDF téléchargeable', r.status === 200 && r.buf.subarray(0, 5).toString() === '%PDF-' && /application\/pdf/.test(r.headers.get('content-type')), r.status);
  r = await owner('GET', `${PU}/orders/${po}`);
  check('commande : statut « envoyé », budget engagé', r.json.order.status === 'sent' && r.json.order.sentAt && r.json.order.budget.engaged === o1.totalTtc, r.json.order);

  // ---------- Réception ----------
  r = await owner('POST', `${PU}/orders/${po}/receipts`, { lines: [{ orderLineId: o1.lines[0].id, receivedQty: 0, rejectedQty: 0 }] });
  check('réception : rien à enregistrer', r.status === 400 && r.json.error === 'Aucune quantité reçue ou refusée : rien à enregistrer.', r.json);
  r = await owner('POST', `${PU}/orders/${po}/receipts`, { lines: [{ orderLineId: o1.lines[0].id, receivedQty: 500 }] });
  check('réception : plus que commandé refusé', r.status === 400, r.json);
  r = await owner('POST', `${PU}/orders/${po}/receipts`, { deliveryNote: 'BL-77', lines: [{ orderLineId: o1.lines[0].id, receivedQty: 60, rejectedQty: 5, reason: 'Sacs déchirés' }, { orderLineId: o1.lines[1].id, receivedQty: 0 }] });
  check('réception partielle enregistrée (BR-)', r.status === 201 && /^BR-/.test(r.json.number) && r.json.status === 'partial', r.json);
  r = await owner('GET', `${O}/stock`);
  const it = r.json.items.find((x) => x.id === ciment);
  check('stock : seules les quantités acceptées sont entrées', it && Number(it.quantity) === 60, it);
  r = await owner('POST', `${PU}/orders/${po}/receipts`, { lines: [{ orderLineId: o1.lines[0].id, receivedQty: 40 }, { orderLineId: o1.lines[1].id, receivedQty: 1 }] });
  check('réception : le reste arrive, commande « reçue »', r.status === 201 && r.json.status === 'received', r.json);
  r = await owner('GET', `${PU}/orders/${po}`);
  const o2 = r.json.order;
  check('commande : reçu, refusé et reste par ligne', o2.lines[0].receivedQty === 100 && o2.lines[0].rejectedQty === 5 && o2.lines[0].remainingQty === 0 && o2.receipts.length === 2, o2.lines);
  r = await owner('GET', `${PU}/receipts`);
  check('réceptions : liste avec lignes et motif', r.json.receipts.length === 2 && r.json.receipts.some((x) => x.lines.some((l) => l.reason === 'Sacs déchirés')), r.json);
  r = await owner('GET', `${PU}/receipts/${r.json.receipts[0].id}/pdf`);
  check('réception : PDF', r.status === 200 && r.buf.subarray(0, 5).toString() === '%PDF-', r.status);

  // ---------- Facture : rapprochement à trois ----------
  r = await owner('GET', `${PU}/orders/${po}/invoice-draft`);
  check('facture : préparation depuis la commande (reçu non facturé)', r.json.lines.length === 2 && r.json.lines[0].quantity === 100 && r.json.supplierId === s1, r.json);
  const draftInv = r.json;
  r = await owner('POST', `${PU}/invoices`, { orderId: po, supplierRef: '', invoiceDate: today, vatRate: 19.25, lines: draftInv.lines });
  check('facture : numéro du fournisseur obligatoire', r.status === 400 && r.json.error === 'Indiquez le numéro de la facture du fournisseur.', r.json);
  r = await owner('POST', `${PU}/invoices`, { orderId: po, supplierRef: 'F-1', invoiceDate: '2999-01-01', vatRate: 19.25, lines: draftInv.lines });
  check('facture : date future refusée', r.status === 400 && r.json.error === 'La date de la facture ne peut pas être dans le futur.', r.json);
  // Prix gonflé sur la 1re ligne : anomalie
  r = await owner('POST', `${PU}/invoices`, { orderId: po, supplierRef: 'CIM-2026-118', invoiceDate: today, vatRate: 19.25, declaredTotal: 1, lines: [{ ...draftInv.lines[0], unitPrice: 5600 }, draftInv.lines[1]] });
  check('facture : saisie (FF-), bloquée par le rapprochement', r.status === 201 && /^FF-/.test(r.json.number) && r.json.status === 'blocked', r.json);
  const inv1 = r.json.id;
  r = await owner('GET', `${PU}/invoices/${inv1}`);
  const codes = r.json.invoice.issues.map((x) => x.code);
  check('rapprochement : écart de prix et total annoncé faux détectés', codes.includes('price_gap') && codes.includes('total_mismatch') && !codes.includes('not_received'), r.json.invoice.issues);
  check('rapprochement : détail par ligne (commandé, reçu, prix commande)', r.json.invoice.matching[0].ordered === 100 && r.json.invoice.matching[0].received === 100 && r.json.invoice.matching[0].orderPrice === 5000, r.json.invoice.matching);
  r = await mgr('POST', `${PU}/invoices/${inv1}/approve`, {});
  check('validation : réservée à un administrateur', r.status === 403, r.status);
  r = await owner('POST', `${PU}/invoices/${inv1}/approve`, {});
  check('validation : facture bloquée → motif exigé', r.status === 400 && /anomalies/.test(r.json.error), r.json);
  r = await owner('PUT', `${PU}/invoices/${inv1}`, { supplierRef: 'CIM-2026-118', invoiceDate: today, vatRate: 19.25, declaredTotal: null, lines: draftInv.lines });
  check('facture corrigée : rapprochée', r.status === 200 && r.json.status === 'matched', r.json);
  r = await owner('POST', `${PU}/invoices`, { orderId: po, supplierRef: 'cim-2026-118', invoiceDate: today, vatRate: 19.25, lines: [{ ...draftInv.lines[0], quantity: 10 }] });
  const dupInv = r.json.id;
  r = await owner('GET', `${PU}/invoices/${dupInv}`);
  const c2 = r.json.invoice.issues.map((x) => x.code);
  check('rapprochement : doublon et quantité non reçue détectés', c2.includes('duplicate') && c2.includes('not_received'), r.json.invoice.issues);
  r = await owner('DELETE', `${PU}/invoices/${dupInv}`);
  check('facture : annulée', r.status === 200, r.json);
  r = await owner('POST', `${PU}/invoices/${inv1}/approve`, {});
  check('validation : écriture comptable passée', r.status === 200 && r.json.entry, r.json);
  const e1 = await dbx.prepare("SELECT e.id FROM acc_entries e WHERE e.org_id = ? AND e.source = 'pur_invoice' AND e.source_id = ?").get(org, inv1 * 100 + 1); // fusion : identifiant d'origine = facture × 100 + n° de tentative (idempotence, comme la ligne B)
  const lines = await dbx.prepare('SELECT account, debit, credit FROM acc_lines WHERE entry_id = ? ORDER BY id').all(e1.id);
  const ht = 525000; const tva = Math.round(ht * 0.1925);
  check('écriture : 601 au débit (HT), 4452 TVA, 401 au crédit (TTC)', lines.find((l) => l.account === '601').debit === ht && lines.find((l) => l.account === '4452').debit === tva && lines.find((l) => l.account === '401').credit === ht + tva, lines);
  r = await owner('POST', `${PU}/invoices/${inv1}/approve`, {});
  check('validation : pas deux fois (409, conflit)', r.status === 409 && r.json.error === 'Cette facture est déjà validée pour paiement.', r.json);
  r = await owner('POST', `${PU}/invoices/${inv1}/unapprove`, { reason: 'Erreur de compte' });
  check('validation annulée (pas encore payée)', r.status === 200, r.json);
  r = await owner('POST', `${PU}/invoices/${inv1}/approve`, {});
  check('nouvelle validation après annulation (nouvelle écriture)', r.status === 200 && r.json.entry, r.json);
  r = await owner('POST', `${PU}/invoices/${inv1}/pay`, { amount: 9e9, method: 'bank', date: today });
  check('paiement : pas plus que le reste dû', r.status === 400, r.json);
  r = await owner('POST', `${PU}/invoices/${inv1}/pay`, { amount: 200000, method: 'mobile', date: today, reference: 'OM-123' });
  check('paiement partiel (mobile money)', r.status === 200 && r.json.entry, r.json);
  r = await owner('POST', `${PU}/invoices/${inv1}/unapprove`, { reason: 'test' });
  check('validation : ne s\'annule plus après un règlement', r.status === 400 && /règlement/.test(r.json.error), r.json);
  r = await owner('GET', `${PU}/invoices/${inv1}`);
  check('facture : payée en partie, reste dû correct', r.json.invoice.paymentStatus === 'partial' && r.json.invoice.balance === ht + tva - 200000 && r.json.invoice.payments[0].method === 'Mobile money', r.json.invoice);
  r = await owner('POST', `${PU}/invoices/${inv1}/pay`, { method: 'bank', date: today });
  r = await owner('GET', `${PU}/invoices`);
  check('factures : soldée, plus rien à payer', r.json.invoices.find((x) => x.id === inv1).paymentStatus === 'paid' && r.json.toPay === 0, r.json);
  const pay = await dbx.prepare("SELECT l.account, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.org_id = ? AND e.source = 'supplier_payment' ORDER BY l.id").all(org);
  check('règlements : 401 au débit, 589 (mobile) et 521 (banque) au crédit', pay.some((l) => l.account === '589' && l.credit === 200000) && pay.some((l) => l.account === '521') && pay.filter((l) => l.account === '401').reduce((s, l) => s + l.debit, 0) === ht + tva, pay);
  r = await owner('POST', `${PU}/orders/${po}/close`, {});
  check('commande close', r.status === 200, r.json);

  // ---------- Facture sans commande ----------
  r = await owner('POST', `${PU}/invoices`, { supplierId: s2, supplierRef: 'DG-8', invoiceDate: today, expenseAccount: '6299', lines: [{ description: 'Frais', quantity: 1, unitPrice: 1000 }] });
  check('facture : compte de charge absent du plan refusé dès la saisie', r.status === 400 && /inconnu du plan comptable/.test(r.json.error), r.json);
  r = await owner('POST', `${PU}/invoices`, { supplierId: s2, supplierRef: 'DG-9', invoiceDate: today, vatRate: 0, expenseAccount: '622', lines: [{ description: 'Honoraires', quantity: 1, unitPrice: 50000 }] });
  check('facture sans commande : bloquée « sans bon de commande »', r.status === 201 && r.json.status === 'blocked', r.json);
  r = await owner('GET', `${PU}/invoices/${r.json.id}`);
  check('facture sans commande : lignes sans données de commande (champs absents)', r.json.invoice.issues[0].code === 'no_order' && !('ordered' in r.json.invoice.matching[0]) && !('orderPrice' in r.json.invoice.matching[0]), r.json.invoice.matching);

  // ---------- Article suivi par lot, contrôle qualité ----------
  r = await owner('POST', `${PU}/orders`, { supplierId: s2, orderDate: today, expectedDate: today, paymentDays: 45, vatRate: 0, category: 'Santé', lines: [{ itemId: vaccin, description: 'Vaccin', unit: 'dose', quantity: 50, unitPrice: 900 }] });
  check('commande directe créée', r.status === 201 && /^BC-/.test(r.json.number), r.json);
  const po2 = r.json.id;
  r = await owner('POST', `${PU}/orders`, { supplierId: s2, lines: [{ description: 'Sans prix', quantity: 1 }] });
  check('commande : prix unitaire exigé', r.status === 400, r.json);
  r = await owner('POST', `${PU}/orders`, { supplierId: sBlocked, lines: [{ description: 'X', quantity: 1, unitPrice: 1 }] });
  check('commande : fournisseur bloqué refusé', r.status === 400 && /bloqué/.test(r.json.error), r.json);
  await owner('POST', `${PU}/orders/${po2}/approve`, {});
  const ol2 = (await owner('GET', `${PU}/orders/${po2}`)).json.order.lines[0];
  check('commande : suivi par lot signalé sur la ligne', ol2.tracking === 'lot', ol2);
  r = await owner('POST', `${PU}/orders/${po2}/receipts`, { lines: [{ orderLineId: ol2.id, receivedQty: 50 }] });
  check('réception : numéro de lot exigé', r.status === 400 && /lot/.test(r.json.error), r.json);
  r = await owner('POST', `${PU}/orders/${po2}/receipts`, { lines: [{ orderLineId: ol2.id, receivedQty: 50, lotNo: 'L-42', expiry: '2030-01-31', inspection: true }] });
  check('réception en quarantaine', r.status === 201, r.json);
  r = await owner('GET', `${O}/stock`);
  const vq = r.json.items.find((x) => x.id === vaccin);
  check('quarantaine : en stock mais pas disponible avant le contrôle', Number(vq.quantity) === 50 && Number(vq.available) === 0, vq);
  r = await owner('GET', `${PU}/inspections`);
  check('contrôle : 50 doses en attente', r.json.inspections.length === 1 && r.json.inspections[0].pending === 50 && r.json.inspections[0].lotNo === 'L-42', r.json);
  const rl = r.json.inspections[0].receiptLineId;
  r = await owner('POST', `${PU}/inspections`, { lines: [{ receiptLineId: rl, acceptedQty: 45, rejectedQty: 10, reason: 'x' }] });
  check('contrôle : pas plus que la quantité en attente', r.status === 400, r.json);
  r = await owner('POST', `${PU}/inspections`, { lines: [{ receiptLineId: rl, acceptedQty: 45, rejectedQty: 5, reason: 'Chaîne du froid rompue' }] });
  check('contrôle enregistré', r.status === 200, r.json);
  r = await owner('GET', `${O}/stock`);
  check('contrôle : 45 doses libérées en stock', Number(r.json.items.find((x) => x.id === vaccin).quantity) === 45, r.json.items);
  const lot = await dbx.prepare('SELECT * FROM stock_lots WHERE item_id = ?').get(vaccin);
  check('contrôle : lot et péremption repris dans le stock', lot && lot.lot_no === 'L-42' && lot.expiry === '2030-01-31', lot);
  r = await owner('GET', `${PU}/orders/${po2}`);
  check('commande : 5 refusées, 5 restent attendues (partiel)', r.json.order.lines[0].rejectedQty === 5 && r.json.order.lines[0].remainingQty === 5 && r.json.order.status === 'partial', r.json.order);
  // Refus au contrôle : la quantité refusée sort du lot reçu, pas d'un autre lot (même périmé, premier en FEFO).
  await owner('POST', `${O}/stock/items/${vaccin}/move`, { kind: 'in', quantity: 3, lotNo: 'L-OLD', expiry: '2020-01-31' });
  r = await owner('POST', `${PU}/orders/${po2}/receipts`, { lines: [{ orderLineId: ol2.id, receivedQty: 5, lotNo: 'L-43', expiry: '2031-01-31', inspection: true }] });
  const rl2 = (await owner('GET', `${PU}/inspections`)).json.inspections.find((x) => x.lotNo === 'L-43').receiptLineId;
  r = await owner('POST', `${PU}/inspections`, { lines: [{ receiptLineId: rl2, acceptedQty: 3, rejectedQty: 2, reason: 'Flacons fêlés' }] });
  const lots2 = Object.fromEntries((await dbx.prepare('SELECT lot_no, quantity FROM stock_lots WHERE item_id = ?').all(vaccin)).map((l) => [l.lot_no, Number(l.quantity)]));
  check('contrôle : le refus sort du lot reçu (L-43 : 3), pas du lot périmé (L-OLD : 3)', r.status === 200 && lots2['L-43'] === 3 && lots2['L-OLD'] === 3 && lots2['L-42'] === 45, lots2);

  // ---------- Appel d'offres ----------
  r = await owner('POST', `${PU}/rfqs`, { title: 'Ciment 2e trimestre', supplierIds: [], lines: [{ itemId: ciment, quantity: 10, refPrice: 5000 }] });
  check('AO : au moins un fournisseur', r.status === 400, r.json);
  r = await owner('POST', `${PU}/rfqs`, { title: 'Ciment 2e trimestre', category: 'Matériaux', supplierIds: [s1, s2], lines: [{ itemId: ciment, description: 'Ciment 50 kg', unit: 'sac', quantity: 200, refPrice: 5000 }] });
  check('AO lancé (AO-)', r.status === 201 && /^AO-/.test(r.json.number), r.json);
  const ao = r.json.id;
  r = await owner('GET', `${PU}/rfqs/${ao}`);
  const lineId = r.json.rfq.comparison.lines[0].id;
  r = await owner('PUT', `${PU}/rfqs/${ao}/quotes/${s1}`, { deliveryDays: 10, paymentDays: 30, lines: [{ rfqLineId: lineId, unitPrice: 4800 }] });
  r = await owner('PUT', `${PU}/rfqs/${ao}/quotes/${s2}`, { deliveryDays: 3, paymentDays: 30, lines: [{ rfqLineId: lineId, unitPrice: 4900 }] });
  r = await owner('GET', `${PU}/rfqs/${ao}`);
  const cmp = r.json.rfq.comparison;
  check('AO : comparaison (moins cher, plus rapide, meilleur prix par ligne, référence)', cmp.recommended === s1 && cmp.fastest === s2 && cmp.lines[0].bestSuppliers[0] === s1 && cmp.baseline === 1000000, cmp);
  r = await owner('POST', `${PU}/rfqs/${ao}/award`, { supplierId: s2, reason: '' });
  check('AO : motif exigé si l\'offre la moins chère n\'est pas retenue', r.status === 400, r.json);
  r = await owner('POST', `${PU}/rfqs/${ao}/award`, { supplierId: s1, reason: '' });
  check('AO attribué : économie calculée, commande créée', r.status === 200 && r.json.savings === 40000 && r.json.orderId, r.json);
  r = await owner('GET', `${PU}/orders/${r.json.orderId}`);
  check('AO : la commande reprend le prix du devis', r.json.order.lines[0].unitPrice === 4800 && r.json.order.status === 'draft', r.json.order.lines);
  r = await owner('GET', `${PU}/rfqs`);
  check('AO : économies totales', r.json.savings === 40000 && r.json.rfqs[0].status === 'awarded', r.json);

  // ---------- Fournisseurs : fiche, évaluation, documents ----------
  r = await owner('POST', `${PU}/suppliers/${s1}/evaluations`, { deliveryScore: 5, qualityScore: 4, priceScore: 9 });
  check('évaluation : notes de 1 à 5', r.status === 400, r.json);
  r = await owner('POST', `${PU}/suppliers/${s1}/evaluations`, { deliveryScore: 5, qualityScore: 4, priceScore: 4, comment: 'Fiable' });
  check('évaluation enregistrée', r.status === 201, r.json);
  r = await owner('POST', `${PU}/suppliers/${s1}/documents?name=attestation.pdf`, pdf);
  check('document fournisseur ajouté', r.status === 201, r.json);
  const docId = r.json.id;
  r = await owner('POST', `${PU}/suppliers/${s1}/documents?name=x.exe`, Buffer.from('MZ' + 'a'.repeat(100)));
  check('document : programme refusé', r.status === 400, r.json);
  r = await owner('GET', `${PU}/documents/${docId}/file`);
  check('document : téléchargé à l\'identique (stocké chiffré)', r.status === 200 && r.buf.equals(pdf), r.status);
  r = await owner('GET', `${PU}/suppliers/${s1}`);
  const st = r.json.supplier.stats;
  check('fiche : commandes, factures, note, qualité (95 %), dépenses', r.json.supplier.orders.length >= 1 && r.json.supplier.invoices.length === 1 && st.score !== null && st.qualityRate === 95 && st.spent === ht + tva && st.evaluations === 1, st);
  r = await owner('GET', `${PU}/suppliers`);
  check('liste des fournisseurs avec statistiques', r.json.suppliers.find((x) => x.id === s1).stats.orders >= 1 && r.json.suppliers.find((x) => x.id === sBlocked).blocked === true, r.json.suppliers);
  r = await owner('DELETE', `${O}/stock/suppliers/${s1}`);
  check('stock : un fournisseur avec historique d\'achats ne se supprime pas', r.status === 409, r.json);

  // ---------- Tableau de bord, budget, exports, aperçu ----------
  r = await owner('GET', `${PU}/dashboard?year=${Y}`);
  check('tableau de bord : dépenses facturées, économies, mois', r.status === 200 && r.json.spend.totalTtc === ht + tva && r.json.savings.total === 40000 && r.json.byMonth.length === 12 && r.json.bySupplier[0].name === 'Cimencam', r.json);
  r = await owner('GET', `${PU}/budget?year=${Y}`);
  const mat = r.json.categories.find((c) => c.category === 'Matériaux');
  check('budget : prévu, facturé et disponible pour « Matériaux »', mat && mat.planned === 1200000 && mat.invoiced === ht + tva && mat.available === 1200000 - (ht + tva) - mat.engaged, mat);
  r = await owner('GET', `${PU}/export?kind=orders&year=${Y}`);
  check('export CSV des commandes', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.includes('BC-'), r.text.slice(0, 200));
  await dbx.prepare("UPDATE suppliers SET name = '=CMD()' WHERE id = ?").run(s2);
  r = await owner('GET', `${PU}/export?kind=orders&year=${Y}`);
  check('export : une formule dans un nom est neutralisée', !/;=CMD/.test(r.text) && r.text.includes("'=CMD()"), r.text);
  r = await owner('GET', `${PU}/export?kind=pirate`);
  check('export inconnu refusé', r.status === 400, r.status);
  r = await mem('GET', `${PU}/summary`);
  check('aperçu membre : ses demandes, sans le bloc responsable', r.json.myRequests && r.json.pending === undefined, r.json);
  r = await owner('GET', `${PU}/summary`);
  check('aperçu responsable : éléments en attente', r.json.pending && typeof r.json.pending.orders === 'number', r.json);
  r = await owner('GET', `${PU}/reorder`);
  check('réapprovisionnement : réponse valide', r.status === 200 && Array.isArray(r.json.items), r.json);
  r = await mem('GET', `${PU}/categories`);
  check('catégories : budget et catégories utilisées', r.json.categories.includes('Matériaux') && r.json.categories.includes('Santé'), r.json);
});
