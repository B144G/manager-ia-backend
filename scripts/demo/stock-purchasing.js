'use strict';
// Démonstration — Achats : réglages (seuils d'approbation, tolérances), fournisseurs (fiche, évaluation, documents), six mois d'historique
// (bons de commande, réceptions, factures rapprochées, paiements), demandes d'achat (approbation, refus, retrait), appel d'offres,
// réceptions partielles et refus, contrôle qualité en quarantaine, factures bloquées par le rapprochement, tableau de bord, exports.
const PDF = Buffer.from('%PDF-1.4\n% Attestation de non-redevance fiscale (démo)\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

module.exports = async function purchasing(ctx) {
  const I = ctx.ids.items; const S = ctx.ids.suppliers; const st = ctx.ids.stock;
  // Les refus de droits (403) ne se montrent que si la personne a son propre compte (démo locale) ; sinon l'appel partirait au nom du dirigeant.
  const D = (f, m, u, b, o = {}) => (o.as && !ctx.users[o.as] && [].concat(o.expect || []).includes(403) ? Promise.resolve({}) : ctx.do(f, m, u, b, o));
  const get = (f, u, as = 'manager') => D(f, 'GET', u, undefined, { as });
  const P = '/purchasing';
  const year = ctx.day(0).slice(0, 4);
  let r;

  // ---------- Réglages ----------
  await get('Achats : réglages (seuils, tolérances)', `${P}/settings`);
  await D('Achats : un responsable ne modifie pas les réglages', 'PUT', `${P}/settings`, { tolQtyPct: 10 }, { as: 'manager', expect: 403 });
  await D('Achats : réglages — demandes > 1,5 M FCFA et commandes > 6 M FCFA approuvées par un administrateur', 'PUT', `${P}/settings`, {
    tolQtyPct: 5, tolPricePct: 2, tolAmount: 1000, budgetBlock: false, defaultTermsDays: 30,
    thresholds: { request: [{ minAmount: 1500000, role: 'admin' }], order: [{ minAmount: 6000000, role: 'admin' }] },
  }, { as: 'accountant' });

  // ---------- Fournisseurs ----------
  const sup = async (name, b) => (await D(`Achats : créer le fournisseur « ${name} »`, 'POST', `${P}/suppliers`, { name, status: 'active', ...b })).id;
  S.adc = await sup('Aciéries du Cameroun (ADC)', { category: 'Métallurgie', city: 'Douala', address: 'Zone portuaire, Douala', paymentDays: 45, phone: '+237 233 39 12 00', email: 'ventes@adc-demo.example', contactPerson: 'Mme Ewane', taxId: 'M041200077665D', rccm: 'RC/DLA/2004/B/1188' });
  S.pacific = await sup('Pacific Peintures', { category: 'Peinture', city: 'Douala', address: 'Bassa, Douala', paymentDays: 30, email: 'commandes@pacific-demo.example' });
  S.cimaf = await sup('Ciments de l\'Afrique (CIMAF)', { category: 'Matériaux', city: 'Douala', address: 'Bonabéri, Douala', paymentDays: 30 });
  await D('Achats : nom de fournisseur en double refusé', 'POST', `${P}/suppliers`, { name: 'cimencam' }, { expect: 409 });
  await D('Achats : compléter la fiche Cimencam (contact, NIU, banque)', 'PUT', `${P}/suppliers/${S.cimencam}`, { contactPerson: 'M. Ngando, commercial grands comptes', taxId: 'M019600011223E', rccm: 'RC/DLA/1963/B/0042', bankInfo: 'Afriland First Bank — 10005 00001 0123456789 01', notes: 'Remise de 2 % au-delà de 1 000 sacs.' }, { as: 'manager' });
  ctx.ids.stock.suppliers = { adc: S.adc, pacific: S.pacific, cimaf: S.cimaf };

  // ---------- Six mois d'historique : commande → réception → facture → paiement ----------
  const lineOf = async (orderId) => ((await get('Achats : détail du bon de commande', `${P}/orders/${orderId}`)).order || {}).lines || [];
  const history = [
    // [jours avant aujourd'hui, fournisseur, lignes, retard de livraison (jours), catégorie, mode de paiement]
    [165, 'cimencam', [[I.ciment, 600, 4250]], 0, 'Matériaux', 'bank'],
    [150, 'alucam', [[I.tole, 150, 7100]], 6, 'Couverture', 'bank'],
    [138, 'dangote', [[I.ciment, 500, 4180]], 0, 'Matériaux', 'bank'],
    [120, 'electro', [[I.cable, 40, 31500], [I.tuyau, 150, 3550]], 0, 'Électricité', 'mobile'],
    [105, 'cimencam', [[I.ciment, 700, 4250]], 3, 'Matériaux', 'bank'],
    [92, 'carrière', [[I.sable, 12, 64000], [I.gravier, 10, 88000]], 0, 'Granulats', 'cash'],
    [75, 'adc', [[I.fer10, 400, 3850], [I.fer12, 300, 5550]], 9, 'Métallurgie', 'bank'],
    [60, 'dangote', [[I.ciment, 650, 4180]], 0, 'Matériaux', 'bank'],
    [46, 'alucam', [[I.tole, 120, 7150]], 0, 'Couverture', 'bank'],
    [33, 'cimencam', [[I.ciment, 800, 4300]], 2, 'Matériaux', 'mobile'],
    [20, 'electro', [[I.cable, 30, 31800]], 0, 'Électricité', null],
    [12, 'adc', [[I.fer12, 250, 5600], [I.fer8, 200, 2580]], 0, 'Métallurgie', null],
  ];
  const histOrders = [];
  for (const [ago, key, lines, late, category, pay] of history) {
    const orderDate = ctx.day(-ago); const expectedDate = ctx.day(-ago + 5);
    const o = await D(`Achats : bon de commande ${key} du ${orderDate}`, 'POST', `${P}/orders`, { supplierId: S[key], orderDate, expectedDate, category, vatRate: 19.25, deliveryAddress: 'Dépôt Batimat, zone industrielle de Bonabéri', lines: lines.map(([itemId, quantity, unitPrice]) => ({ itemId, quantity, unitPrice })) }, { as: 'manager' });
    if (!o.id) continue;
    histOrders.push(o.id);
    await D('Achats : approuver le bon de commande', 'POST', `${P}/orders/${o.id}/approve`, {}, { as: 'manager' });
    await D('Achats : marquer le bon comme envoyé (envoi manuel, sans e-mail)', 'POST', `${P}/orders/${o.id}/send`, { via: 'manual', to: 'Remis en main propre au commercial' }, { as: 'manager' });
    const ol = await lineOf(o.id);
    const receiptDate = ctx.day(-ago + 5 + late);
    await D('Achats : réception de la livraison (bon de réception)', 'POST', `${P}/orders/${o.id}/receipts`, { receiptDate, deliveryNote: `BL-${key.slice(0, 3).toUpperCase()}-${ago}`, lines: ol.map((l) => ({ orderLineId: l.id, receivedQty: l.quantity })) }, { as: 'manager' });
    const draft = await get('Achats : préparer la facture depuis le reçu', `${P}/orders/${o.id}/invoice-draft`);
    const invoiceDate = ctx.day(-ago + 7 + late);
    const inv = await D('Achats : saisir la facture fournisseur', 'POST', `${P}/invoices`, { orderId: o.id, supplierRef: `${key.slice(0, 3).toUpperCase()}-F${2600 + ago}`, invoiceDate, vatRate: 19.25, lines: draft.lines || [] }, { as: 'manager' });
    if (!inv.id) continue;
    await D('Achats : valider la facture rapprochée (écriture comptable)', 'POST', `${P}/invoices/${inv.id}/approve`, {}, { as: 'accountant' });
    if (pay) await D('Achats : régler la facture', 'POST', `${P}/invoices/${inv.id}/pay`, { method: pay, date: ctx.day(Math.min(0, -ago + 25 + late)), reference: pay === 'cash' ? '' : `${pay === 'mobile' ? 'OM' : 'VIR'}-${100000 + ago}` }, { as: 'accountant' });
    if (ago > 60) await D('Achats : clôturer le bon de commande soldé', 'POST', `${P}/orders/${o.id}/close`, {}, { as: 'manager' });
  }
  st.purchaseOrders = histOrders;

  // ---------- Demandes d'achat ----------
  r = await D('Achats : demande d\'achat du magasinier (fer à béton, chantier Sogea)', 'POST', `${P}/requests`, { title: 'Fer à béton — chantier Sogea, Bonapriso', category: 'Métallurgie', neededDate: ctx.day(10), justification: 'Commande Sogea de 300 barres HA 12 et 200 HA 10 : stock insuffisant.', submit: true,
    lines: [{ itemId: I.fer12, quantity: 300, estPrice: 5600 }, { itemId: I.fer10, quantity: 200, estPrice: 3900 }, { description: 'Transport camion plateau Douala', quantity: 1, unit: 'voyage', estPrice: 85000 }] }, { as: 'storekeeper' });
  const rqFer = r.id;
  await get('Achats : mes demandes (magasinier)', `${P}/requests?mine=1`, 'storekeeper');
  r = await get('Achats : demande à approuver (montant > seuil)', `${P}/requests/${rqFer}`, 'manager');
  if (ctx.users.manager) ctx.check('Achats : 2 545 000 FCFA, un administrateur doit approuver', r.request && r.request.canApprove === false && r.request.requiredRoleLabel === 'Administrateur', r.request && [r.request.total, r.request.requiredRoleLabel]);
  await D('Achats : le responsable ne peut pas approuver au-delà du seuil', 'POST', `${P}/requests/${rqFer}/approve`, {}, { as: 'manager', expect: 403 });
  await D('Achats : un membre n\'approuve pas', 'POST', `${P}/requests/${rqFer}/approve`, {}, { as: 'seller', expect: 403 });
  await D('Achats : l\'administratrice approuve la demande', 'POST', `${P}/requests/${rqFer}/approve`, {}, { as: 'accountant' });
  r = await D('Achats : demande de la commerciale (présentoir showroom)', 'POST', `${P}/requests`, { title: 'Présentoir carrelage pour le showroom d\'Akwa', category: 'Aménagement', justification: 'Mettre en valeur les carreaux 60×60.', submit: true, lines: [{ description: 'Présentoir métallique 8 panneaux', quantity: 2, unit: 'pièce', estPrice: 185000 }] }, { as: 'seller' });
  const rqShow = r.id;
  await D('Achats : refus sans motif impossible', 'POST', `${P}/requests/${rqShow}/reject`, {}, { as: 'manager', expect: 400 });
  await D('Achats : refus d\'approbation (motif)', 'POST', `${P}/requests/${rqShow}/reject`, { reason: 'Budget showroom épuisé pour 2026 : à reprendre en janvier.' }, { as: 'manager' });
  r = await D('Achats : la commerciale recopie sa demande refusée', 'POST', `${P}/requests/${rqShow}/duplicate`, {}, { as: 'seller' });
  await D('Achats : supprimer le brouillon recopié', 'DELETE', `${P}/requests/${r.id}`, undefined, { as: 'seller' });
  r = await D('Achats : brouillon de demande (EPI magasin)', 'POST', `${P}/requests`, { title: 'Équipements de protection — magasin', lines: [{ description: 'Gants de manutention', quantity: 20, unit: 'paire', estPrice: 2500 }] }, { as: 'storekeeper' });
  const rqEpi = r.id;
  await D('Achats : modifier le brouillon', 'PUT', `${P}/requests/${rqEpi}`, { title: 'Équipements de protection — magasin de Bonabéri', category: 'Sécurité', lines: [{ description: 'Gants de manutention', quantity: 20, unit: 'paire', estPrice: 2500 }, { description: 'Chaussures de sécurité', quantity: 6, unit: 'paire', estPrice: 22000 }] }, { as: 'storekeeper' });
  await D('Achats : envoyer le brouillon pour approbation', 'POST', `${P}/requests/${rqEpi}/submit`, {}, { as: 'storekeeper' });
  await D('Achats : retirer la demande de la validation', 'POST', `${P}/requests/${rqEpi}/withdraw`, {}, { as: 'storekeeper' });
  await D('Achats : renvoyer la demande corrigée', 'POST', `${P}/requests/${rqEpi}/submit`, {}, { as: 'storekeeper' });
  await D('Achats : approuver la demande d\'EPI', 'POST', `${P}/requests/${rqEpi}/approve`, {}, { as: 'manager' });
  r = await D('Achats : demande devenue inutile', 'POST', `${P}/requests`, { title: 'Bâches de protection', lines: [{ description: 'Bâche 6×8 m', quantity: 10, estPrice: 9000 }], submit: true }, { as: 'storekeeper' });
  await D('Achats : annuler la demande', 'POST', `${P}/requests/${r.id}/cancel`, {}, { as: 'storekeeper' });
  await get('Achats : demandes à approuver', `${P}/requests?status=submitted`);
  await get('Achats : toutes les demandes', `${P}/requests`);

  // Demande approuvée → bon de commande
  const rl = ((await get('Achats : lignes de la demande', `${P}/requests/${rqFer}`)).request || {}).lines || [];
  r = await D('Achats : transformer la demande en bon de commande (ADC)', 'POST', `${P}/requests/${rqFer}/to-order`, { supplierId: S.adc, prices: Object.fromEntries(rl.filter((l) => !l.itemId).map((l) => [l.id, 80000])) }, { as: 'manager' });
  const poFer = r.orderId;
  st.poFer = poFer;
  await D('Achats : modifier le brouillon (date de livraison)', 'PUT', `${P}/orders/${poFer}`, { supplierId: S.adc, orderDate: ctx.day(-4), expectedDate: ctx.day(-1), category: 'Métallurgie', lines: ((await lineOf(poFer))).map((l) => ({ itemId: l.itemId, description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice })) }, { as: 'manager' });
  await D('Achats : réception refusée avant approbation', 'POST', `${P}/orders/${poFer}/receipts`, { lines: [] }, { as: 'manager', expect: 400 });
  await D('Achats : approuver le bon de commande ADC', 'POST', `${P}/orders/${poFer}/approve`, {}, { as: 'manager' });
  await D('Achats : envoi manuel du bon de commande', 'POST', `${P}/orders/${poFer}/send`, { via: 'manual' }, { as: 'manager' });
  r = await D('Achats : télécharger le bon de commande (PDF)', 'GET', `${P}/orders/${poFer}/pdf`, undefined, { as: 'manager', raw: true });
  ctx.check('Achats : PDF du bon de commande', r.buf && r.buf.subarray(0, 5).toString() === '%PDF-', r.status);
  const fl = await lineOf(poFer);
  const lf12 = fl.find((l) => l.itemId === I.fer12); const lf10 = fl.find((l) => l.itemId === I.fer10); const lTr = fl.find((l) => !l.itemId);
  r = await D('Achats : réception partielle avec refus (barres tordues)', 'POST', `${P}/orders/${poFer}/receipts`, { deliveryNote: 'BL-ADC-77812', lines: [{ orderLineId: lf12.id, receivedQty: 180, rejectedQty: 10, reason: 'Barres tordues au déchargement' }, { orderLineId: lf10.id, receivedQty: 200 }, { orderLineId: lTr.id, receivedQty: 1 }] }, { as: 'manager' });
  ctx.check('Achats : réception partielle (BR-…)', r.status === 'partial' && /^BR-/.test(r.number || ''), r);
  await D('Achats : sur-réception refusée', 'POST', `${P}/orders/${poFer}/receipts`, { lines: [{ orderLineId: lf12.id, receivedQty: 500 }] }, { as: 'manager', expect: 400 });
  const receipts = (await get('Achats : bons de réception', `${P}/receipts`)).receipts || [];
  r = await D('Achats : bon de réception (PDF)', 'GET', `${P}/receipts/${receipts[0] && receipts[0].id}/pdf`, undefined, { as: 'manager', raw: true });
  ctx.check('Achats : PDF du bon de réception', r.buf && r.buf.subarray(0, 5).toString() === '%PDF-', r.status);
  // Facture avec prix gonflé : bloquée par le rapprochement, puis validée avec un motif.
  const fd = await get('Achats : préparer la facture ADC', `${P}/orders/${poFer}/invoice-draft`);
  r = await D('Achats : facture ADC avec un prix supérieur à la commande', 'POST', `${P}/invoices`, { orderId: poFer, supplierRef: 'ADC-2026-4471', invoiceDate: ctx.day(0), vatRate: 19.25, declaredTotal: 2200000, lines: (fd.lines || []).map((l) => (l.orderLineId === lf12.id ? { ...l, unitPrice: 5750 } : l)) }, { as: 'manager' });
  const invAdc = r.id;
  ctx.check('Achats : facture bloquée par le rapprochement', r.status === 'blocked', r);
  r = await get('Achats : anomalies de la facture (écart de prix, total annoncé)', `${P}/invoices/${invAdc}`);
  ctx.check('Achats : écart de prix détecté', ((r.invoice || {}).issues || []).some((x) => x.code === 'price_gap'), (r.invoice || {}).issues);
  await D('Achats : relancer le rapprochement', 'POST', `${P}/invoices/${invAdc}/match`, {}, { as: 'manager' });
  await D('Achats : validation d\'une facture bloquée sans motif refusée', 'POST', `${P}/invoices/${invAdc}/approve`, {}, { as: 'accountant', expect: 400 });
  await D('Achats : corriger la facture (total annoncé retiré)', 'PUT', `${P}/invoices/${invAdc}`, { supplierRef: 'ADC-2026-4471', invoiceDate: ctx.day(0), vatRate: 19.25, declaredTotal: null, lines: (fd.lines || []).map((l) => (l.orderLineId === lf12.id ? { ...l, unitPrice: 5750 } : l)), notes: 'Hausse du prix de l\'acier annoncée par ADC le 2 novembre.' }, { as: 'manager' });
  await D('Achats : un responsable ne valide pas une facture', 'POST', `${P}/invoices/${invAdc}/approve`, {}, { as: 'manager', expect: 403 });
  await D('Achats : valider malgré l\'écart, avec un motif', 'POST', `${P}/invoices/${invAdc}/approve`, { override: true, overrideReason: 'Hausse de l\'acier confirmée par écrit, acceptée par la direction.' }, { as: 'accountant' });
  await D('Achats : paiement partiel (mobile money)', 'POST', `${P}/invoices/${invAdc}/pay`, { amount: 1000000, method: 'mobile', date: ctx.day(0), reference: 'OM-77120045' }, { as: 'accountant' });
  await D('Achats : paiement supérieur au reste dû refusé', 'POST', `${P}/invoices/${invAdc}/pay`, { amount: 99000000, method: 'bank' }, { as: 'accountant', expect: 400 });

  // ---------- Appel d'offres ----------
  r = await D('Achats : appel d\'offres ciment de décembre (3 cimenteries)', 'POST', `${P}/rfqs`, { title: 'Ciment CPJ 42,5 — approvisionnement de décembre', category: 'Matériaux', deadline: ctx.day(5), supplierIds: [S.cimencam, S.dangote, S.cimaf], notes: 'Livraison franco dépôt de Bonabéri.', lines: [{ itemId: I.ciment, quantity: 1000, unit: 'sac', refPrice: 4300 }] }, { as: 'manager' });
  const ao = r.id;
  const aoLine = (((await get('Achats : comparatif de l\'appel d\'offres', `${P}/rfqs/${ao}`)).rfq || {}).comparison || { lines: [{}] }).lines[0].id;
  await D('Achats : devis Cimencam', 'PUT', `${P}/rfqs/${ao}/quotes/${S.cimencam}`, { deliveryDays: 3, paymentDays: 30, validUntil: ctx.day(20), terms: 'Franco dépôt', lines: [{ rfqLineId: aoLine, unitPrice: 4220 }] }, { as: 'manager' });
  await D('Achats : devis Dangote (le moins cher)', 'PUT', `${P}/rfqs/${ao}/quotes/${S.dangote}`, { deliveryDays: 7, paymentDays: 45, validUntil: ctx.day(20), lines: [{ rfqLineId: aoLine, unitPrice: 4150 }] }, { as: 'manager' });
  await D('Achats : CIMAF décline', 'PUT', `${P}/rfqs/${ao}/quotes/${S.cimaf}`, { declined: true, note: 'Rupture de clinker jusqu\'en janvier.' }, { as: 'manager' });
  r = await get('Achats : comparatif (moins cher, plus rapide, économie)', `${P}/rfqs/${ao}`);
  ctx.check('Achats : Dangote recommandé, Cimencam le plus rapide', r.rfq && r.rfq.comparison.recommended === S.dangote && r.rfq.comparison.fastest === S.cimencam, r.rfq && r.rfq.comparison);
  await D('Achats : retenir une offre plus chère exige un motif', 'POST', `${P}/rfqs/${ao}/award`, { supplierId: S.cimencam }, { as: 'manager', expect: 400 });
  r = await D('Achats : attribuer à Dangote (bon de commande créé)', 'POST', `${P}/rfqs/${ao}/award`, { supplierId: S.dangote }, { as: 'manager' });
  ctx.check('Achats : économie de 150 000 FCFA', r.savings === 150000, r);
  const poAo = r.orderId;
  st.poCiment = poAo;
  await D('Achats : approuver le bon de commande issu de l\'appel d\'offres', 'POST', `${P}/orders/${poAo}/approve`, {}, { as: 'manager' });
  await D('Achats : envoi manuel', 'POST', `${P}/orders/${poAo}/send`, { via: 'manual', to: 'Déposé chez Dangote Bonabéri' }, { as: 'manager' });
  r = await D('Achats : appel d\'offres tôles (abandonné)', 'POST', `${P}/rfqs`, { title: 'Tôles bac alu — chantier Mairie', supplierIds: [S.alucam], lines: [{ itemId: I.tole, quantity: 400, refPrice: 7200 }] }, { as: 'manager' });
  await D('Achats : annuler un appel d\'offres sans motif refusé', 'POST', `${P}/rfqs/${r.id}/cancel`, {}, { as: 'manager', expect: 400 });
  await D('Achats : annuler l\'appel d\'offres (motif)', 'POST', `${P}/rfqs/${r.id}/cancel`, { reason: 'Chantier reporté par la Commune.' }, { as: 'manager' });
  await get('Achats : liste des appels d\'offres et économies', `${P}/rfqs`);

  // ---------- Contrôle qualité : peinture reçue en quarantaine ----------
  r = await D('Achats : commande de peinture (Pacific Peintures)', 'POST', `${P}/orders`, { supplierId: S.pacific, orderDate: ctx.day(-3), expectedDate: ctx.day(-1), category: 'Peinture', lines: [{ itemId: I.peinture, quantity: 60, unitPrice: 27800 }] }, { as: 'manager' });
  const poPv = r.id;
  await D('Achats : approuver la commande de peinture', 'POST', `${P}/orders/${poPv}/approve`, {}, { as: 'manager' });
  const pvl = (await lineOf(poPv))[0] || {};
  await D('Achats : réception de peinture sans numéro de lot refusée', 'POST', `${P}/orders/${poPv}/receipts`, { lines: [{ orderLineId: pvl.id, receivedQty: 60 }] }, { as: 'manager', expect: 400 });
  await D('Achats : réception en quarantaine (contrôle qualité)', 'POST', `${P}/orders/${poPv}/receipts`, { deliveryNote: 'BL-PAC-1190', lines: [{ orderLineId: pvl.id, receivedQty: 60, lotNo: 'PV-2611-Q', expiry: ctx.day(500), inspection: true }] }, { as: 'manager' });
  r = await get('Achats : marchandises en attente de contrôle', `${P}/inspections`);
  const insp = (r.inspections || [])[0];
  if (ctx.check('Achats : 60 seaux en quarantaine', insp && insp.pending === 60, r.inspections)) {
    await D('Achats : contrôle qualité (55 acceptés, 5 seaux percés refusés)', 'POST', `${P}/inspections`, { lines: [{ receiptLineId: insp.receiptLineId, acceptedQty: 55, rejectedQty: 5, reason: 'Seaux percés, peinture sèche' }] }, { as: 'manager' });
  }
  const pdraft = await get('Achats : préparer la facture de peinture', `${P}/orders/${poPv}/invoice-draft`);
  r = await D('Achats : facture de peinture pour 60 seaux (5 refusés)', 'POST', `${P}/invoices`, { orderId: poPv, supplierRef: 'PAC-11-2026-031', invoiceDate: ctx.day(0), vatRate: 19.25, lines: (pdraft.lines || []).map((l) => ({ ...l, quantity: 60 })) }, { as: 'manager' });
  ctx.check('Achats : facture bloquée (quantité non reçue)', r.status === 'blocked', r);
  const invPv = r.id;
  await D('Achats : corriger la facture à 55 seaux', 'PUT', `${P}/invoices/${invPv}`, { supplierRef: 'PAC-11-2026-031', invoiceDate: ctx.day(0), vatRate: 19.25, lines: pdraft.lines || [] }, { as: 'manager' });
  await D('Achats : valider la facture de peinture', 'POST', `${P}/invoices/${invPv}/approve`, {}, { as: 'accountant' });
  await D('Achats : annuler la validation (erreur de compte)', 'POST', `${P}/invoices/${invPv}/unapprove`, { reason: 'Compte de charge à corriger' }, { as: 'accountant' });
  await D('Achats : valider de nouveau', 'POST', `${P}/invoices/${invPv}/approve`, {}, { as: 'accountant' });

  // ---------- Bon de commande en retard, annulations ----------
  r = await D('Achats : commande de tôles en retard (livraison promise il y a 8 jours)', 'POST', `${P}/orders`, { supplierId: S.alucam, orderDate: ctx.day(-15), expectedDate: ctx.day(-8), category: 'Couverture', lines: [{ itemId: I.tole, quantity: 200, unitPrice: 7150 }] }, { as: 'manager' });
  await D('Achats : approuver la commande de tôles', 'POST', `${P}/orders/${r.id}/approve`, {}, { as: 'manager' });
  await D('Achats : envoyer la commande de tôles', 'POST', `${P}/orders/${r.id}/send`, { via: 'manual' }, { as: 'manager' });
  st.poLate = r.id;
  r = await D('Achats : brouillon de commande à supprimer', 'POST', `${P}/orders`, { supplierId: S.electro, lines: [{ description: 'Disjoncteurs 20 A', quantity: 50, unitPrice: 4500 }] }, { as: 'manager' });
  await D('Achats : supprimer le brouillon', 'DELETE', `${P}/orders/${r.id}`, undefined, { as: 'manager' });
  r = await D('Achats : commande de câble en double', 'POST', `${P}/orders`, { supplierId: S.electro, category: 'Électricité', lines: [{ itemId: I.cable, quantity: 20, unitPrice: 31500 }] }, { as: 'manager' });
  await D('Achats : approuver la commande en double', 'POST', `${P}/orders/${r.id}/approve`, {}, { as: 'manager' });
  await D('Achats : annuler sans motif refusé', 'POST', `${P}/orders/${r.id}/cancel`, {}, { as: 'manager', expect: 400 });
  await D('Achats : annuler la commande en double (motif)', 'POST', `${P}/orders/${r.id}/cancel`, { reason: 'Doublon de la commande du 20 octobre.' }, { as: 'manager' });
  await D('Achats : fournisseur bloqué ne reçoit plus de commande', 'PUT', `${P}/suppliers/${S.cimaf}`, { status: 'blocked', notes: 'Bloqué : ruptures répétées.' }, { as: 'manager' });
  await D('Achats : commande à un fournisseur bloqué refusée', 'POST', `${P}/orders`, { supplierId: S.cimaf, lines: [{ itemId: I.ciment, quantity: 10, unitPrice: 4200 }] }, { as: 'manager', expect: 400 });

  // ---------- Facture sans bon de commande (transport) ----------
  r = await D('Achats : facture de transit sans bon de commande', 'POST', `${P}/invoices`, { supplierId: S.transit, supplierRef: 'BT-DLA-26-5521', invoiceDate: ctx.day(-2), vatRate: 19.25, expenseAccount: '611', lines: [{ description: 'Dédouanement et transport conteneur 40\' (groupes électrogènes)', quantity: 1, unitPrice: 685000 }] }, { as: 'manager' });
  await D('Achats : valider la facture sans commande (motif)', 'POST', `${P}/invoices/${r.id}/approve`, { override: true, overrideReason: 'Prestation de transit ponctuelle, devis signé par la direction.' }, { as: 'accountant' });
  await D('Achats : régler le transitaire par virement', 'POST', `${P}/invoices/${r.id}/pay`, { method: 'bank', date: ctx.day(0), reference: 'VIR-AFB-88120' }, { as: 'accountant' });
  r = await D('Achats : facture saisie en double', 'POST', `${P}/invoices`, { supplierId: S.transit, supplierRef: 'bt-dla-26-5521', invoiceDate: ctx.day(-2), vatRate: 19.25, lines: [{ description: 'Transport conteneur', quantity: 1, unitPrice: 685000 }] }, { as: 'manager' });
  r = await get('Achats : doublon détecté par le rapprochement', `${P}/invoices/${r.id}`);
  ctx.check('Achats : doublon signalé', ((r.invoice || {}).issues || []).some((x) => x.code === 'duplicate'), (r.invoice || {}).issues);
  await D('Achats : annuler la facture en double', 'DELETE', `${P}/invoices/${r.invoice && r.invoice.id}`, undefined, { as: 'manager' });
  r = await get('Achats : factures fournisseurs (reste à payer)', `${P}/invoices`);
  ctx.check('Achats : il reste des factures à payer', r.toPay > 0, r.toPay);

  // ---------- Évaluation et documents fournisseurs ----------
  await D('Achats : évaluer Cimencam', 'POST', `${P}/suppliers/${S.cimencam}/evaluations`, { deliveryScore: 4, qualityScore: 5, priceScore: 3, comment: 'Ciment régulier, quelques retards en saison des pluies.' }, { as: 'manager' });
  await D('Achats : évaluer ADC', 'POST', `${P}/suppliers/${S.adc}/evaluations`, { deliveryScore: 2, qualityScore: 3, priceScore: 3, comment: 'Livraison en retard de 9 jours, barres tordues.' }, { as: 'manager' });
  r = await D('Achats : évaluation saisie par erreur', 'POST', `${P}/suppliers/${S.dangote}/evaluations`, { deliveryScore: 1, qualityScore: 1, priceScore: 1 }, { as: 'manager' });
  await D('Achats : supprimer l\'évaluation erronée', 'DELETE', `${P}/evaluations/${r.id}`, undefined, { as: 'accountant' });
  await D('Achats : note hors échelle refusée', 'POST', `${P}/suppliers/${S.dangote}/evaluations`, { deliveryScore: 7, qualityScore: 4, priceScore: 4 }, { as: 'manager', expect: 400 });
  r = await D('Achats : joindre l\'attestation de non-redevance (PDF)', 'POST', `${P}/suppliers/${S.cimencam}/documents?name=attestation-non-redevance-2026.pdf`, PDF, { as: 'manager' });
  const docId = r.id;
  r = await D('Achats : télécharger le document fournisseur', 'GET', `${P}/documents/${docId}/file`, undefined, { as: 'manager', raw: true });
  ctx.check('Achats : document restitué à l\'identique', r.buf && r.buf.equals(PDF), r.status);
  r = await D('Achats : joindre un document périmé', 'POST', `${P}/suppliers/${S.cimencam}/documents?name=attestation-2025.pdf`, PDF, { as: 'manager' });
  await D('Achats : supprimer le document périmé', 'DELETE', `${P}/documents/${r.id}`, undefined, { as: 'manager' });
  r = await get('Achats : fiche Cimencam (ponctualité, qualité, dépenses)', `${P}/suppliers/${S.cimencam}`);
  ctx.check('Achats : statistiques du fournisseur', r.supplier && r.supplier.stats && r.supplier.stats.orders >= 3 && r.supplier.stats.spent > 0, r.supplier && r.supplier.stats);
  await get('Achats : fiche ADC', `${P}/suppliers/${S.adc}`);
  await get('Achats : fournisseurs avec statistiques', `${P}/suppliers`);

  // ---------- Pilotage ----------
  r = await get('Achats : tableau de bord (dépenses par mois, fournisseur, catégorie)', `${P}/dashboard?year=${year}`);
  ctx.check('Achats : dépenses sur plusieurs mois', (r.byMonth || []).filter((m) => m.invoicedTtc > 0).length >= 5 && r.savings && r.savings.total >= 150000, r.byMonth);
  ctx.check('Achats : livraisons en retard suivies', r.deliveries && (r.deliveries.lateOpen || []).length >= 1, r.deliveries);
  await get('Achats : suivi budgétaire par catégorie', `${P}/budget?year=${year}`);
  for (const kind of ['orders', 'invoices', 'suppliers', 'categories', 'months', 'late', 'rfqs']) {
    r = await D(`Achats : export CSV « ${kind} »`, 'GET', `${P}/export?kind=${kind}&year=${year}`, undefined, { as: 'manager', raw: true });
    ctx.check(`Achats : fichier CSV « ${kind} »`, r.status === 200 && /text\/csv/.test(r.headers.get('content-type') || ''), r.status);
  }
  await get('Achats : aperçu du magasinier (ses demandes)', `${P}/summary`, 'storekeeper');
  r = await get('Achats : aperçu du responsable (à approuver, à recevoir, à payer)', `${P}/summary`);
  await get('Achats : articles à réapprovisionner', `${P}/reorder`);
  await get('Achats : catégories d\'achat', `${P}/categories`, 'storekeeper');
  await get('Achats : bons de commande', `${P}/orders`);
  await D('Achats : les bons de commande sont réservés aux responsables', 'GET', `${P}/orders`, undefined, { as: 'storekeeper', expect: 403 });
};
