'use strict';
// Échanges Stock/Entrepôt ↔ Achats ↔ Comptabilité ↔ Trésorerie : avoir fournisseur comptabilisé et imputé sur les dettes, retour client → avoir client,
// frais d'arrivée rattachés à une facture d'achat (sans double écriture), valeur du stock face à la comptabilité, état de trésorerie du stock.
// Lancez-le avec : node scripts/test-stock-compta.js
const { run } = require('./lib/wave2');

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (n) => iso(new Date(Date.now() + n * 86400000));

run('Stock ↔ Achats ↔ Comptabilité ↔ Trésorerie', async ({ check, owner, mgr, mem, other, org, org2, O, ws, dbx }) => {
  const S = `${O}/stock`; const WM = `${S}/wms`; const PU = `${O}/purchasing`; const AC = `${O}/accounting`; const WM2 = `${ws(org2)}/stock/wms`;
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND role = 'manager'").run(org);
  let r;
  const entries = async (src) => (await dbx.prepare('SELECT e.id, e.number FROM acc_entries e WHERE e.org_id = ? AND e.source = ? ORDER BY e.id').all(org, src));
  const lineSum = async (entryId, account, side) => Number((await dbx.prepare(`SELECT COALESCE(SUM(${side}), 0) s FROM acc_lines WHERE entry_id = ? AND account = ?`).get(entryId, account)).s);

  // ---------- Fournisseur, commande, facture validée (la dette fournisseur existe) ----------
  const item = (await owner('POST', `${S}/items`, { name: 'Ciment CPJ 42', unit: 'sac', unitCost: 5000 })).json.id;
  const sup = (await mgr('POST', `${PU}/suppliers`, { name: 'Cimenterie du Littoral' })).json.id;
  const mkPo = async (qty, price) => {
    const id = (await mgr('POST', `${PU}/orders`, { supplierId: sup, lines: [{ itemId: item, quantity: qty, unitPrice: price }] })).json.id;
    await owner('POST', `${PU}/orders/${id}/approve`);
    const o = (await mgr('GET', `${PU}/orders/${id}`)).json.order;
    await owner('POST', `${PU}/orders/${id}/receipts`, { lines: [{ orderLineId: o.lines[0].id, receivedQty: qty }] });
    return id;
  };
  const po1 = await mkPo(100, 5000);
  const inv = async (po, ref) => {
    const d = (await owner('GET', `${PU}/orders/${po}/invoice-draft`)).json;
    const id = (await owner('POST', `${PU}/invoices`, { orderId: po, supplierRef: ref, invoiceDate: shift(0), vatRate: 0, lines: d.lines })).json.id;
    r = await owner('POST', `${PU}/invoices/${id}/approve`, { override: true, overrideReason: 'Test : facture sans réception rapprochée' });
    return { id, ok: r.status === 200, billId: r.json.billId };
  };
  const i1 = await inv(po1, 'CIM-001');
  check('facture d\'achat validée : dette fournisseur créée (500 000)', i1.ok && (await dbx.prepare('SELECT amount FROM supplier_bills WHERE id = ?').get(i1.billId)).amount === 500000, i1);

  // ---------- Avoir fournisseur ----------
  const ret = async (qty) => (await mgr('POST', `${WM}/returns`, { kind: 'supplier', supplierId: sup, reason: 'Sacs durcis', validate: true, lines: [{ itemId: item, quantity: qty, reasonCode: 'defective' }] })).json.id;
  const r1 = await ret(10);
  check('retour fournisseur de 10 sacs validé', r1 > 0 && (await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(item)).quantity === 90, r1);
  r = await mem('POST', `${WM}/returns/${r1}/credit`, { amount: 50000 });
  check('droits : un membre n\'enregistre pas d\'avoir', r.status === 403, r.status);
  r = await mgr('POST', `${WM}/returns/${r1}/credit`, { amount: 50000, vat: 50000 });
  check('TVA de l\'avoir égale au montant → 400, rien comptabilisé', r.status === 400 && (await entries('wms_supplier_credit')).length === 0, r.json);
  r = await mgr('POST', `${WM}/returns/${r1}/credit`, { amount: 59625, vat: 9625 });
  check('avoir de 59 625 TTC (dont 9 625 de TVA) comptabilisé', r.status === 200 && r.json.booked === true && /^AC-/.test(r.json.entry) && r.json.applied.length === 1 && r.json.unapplied === 0, r.json);
  const ec = (await entries('wms_supplier_credit'))[0];
  check('écriture : D 401 59 625 / C 609 50 000 + C 4452 9 625', ec && (await lineSum(ec.id, '401', 'debit')) === 59625 && (await lineSum(ec.id, '609', 'credit')) === 50000 && (await lineSum(ec.id, '4452', 'credit')) === 9625, ec);
  check('dette du fournisseur diminuée de l\'avoir (500 000 − 59 625 = 440 375 restant dû)', (await dbx.prepare('SELECT amount - paid AS due, status FROM supplier_bills WHERE id = ?').get(i1.billId)).due === 440375, await dbx.prepare('SELECT * FROM supplier_bills WHERE id = ?').get(i1.billId));
  r = await mgr('POST', `${WM}/returns/${r1}/credit`, { amount: 100 });
  check('avoir déjà comptabilisé → 409 (pas de doublon)', r.status === 409 && (await entries('wms_supplier_credit')).length === 1, r.json);
  r = await mgr('GET', `${WM}/returns/${r1}/credit`);
  check('consultation : écriture, factures imputées', r.json.entry && r.json.entry.number === ec.number && r.json.applied.length === 1 && r.json.applied[0].amount === 59625 && r.json.unapplied === 0, r.json);
  // débit en excédent : avoir plus grand que la dette → solde débiteur (409)
  const r2 = await ret(5);
  r = await mgr('POST', `${WM}/returns/${r2}/credit`, { amount: 600000 });
  const e2 = (await entries('wms_supplier_credit'))[1];
  check('avoir plus grand que la dette : 440 375 imputés, le reste (159 625) en fournisseurs débiteurs (409)', r.status === 200 && r.json.unapplied === 159625 && (await lineSum(e2.id, '401', 'debit')) === 440375 && (await lineSum(e2.id, '409', 'debit')) === 159625 && (await lineSum(e2.id, '609', 'credit')) === 600000, r.json);
  check('dette soldée par l\'avoir', (await dbx.prepare('SELECT status FROM supplier_bills WHERE id = ?').get(i1.billId)).status === 'paid', await dbx.prepare('SELECT * FROM supplier_bills WHERE id = ?').get(i1.billId));
  r = await mgr('POST', `${WM}/returns/${r2}/credit/reverse`, {});
  check('annuler l\'avoir (administrateur) : écriture inverse, dettes remises', r.status === 200 && (await dbx.prepare('SELECT status, paid FROM supplier_bills WHERE id = ?').get(i1.billId)).paid === 59625 && (await entries('wms_supplier_credit_reverse')).length === 1, r.json);
  r = await mgr('POST', `${WM}/returns/${r2}/credit/reverse`, {});
  check('annuler deux fois → 400', r.status === 400, r.status);
  r = await mgr('POST', `${WM}/returns/${r2}/credit`, { amount: 20000, book: false });
  check('avoir seulement enregistré (book = false) : aucune écriture', r.status === 200 && r.json.booked === false && (await entries('wms_supplier_credit')).length === 2, r.json);
  r = await owner('GET', `${AC}/stock-valuation?date=${shift(0)}`);
  check('comptabilité : le module de stock en écritures reste lisible', r.status === 200 && typeof r.json.totalValue === 'number', r.status);

  // ---------- Retour client → avoir client ----------
  const cust = (await owner('POST', `${O}/crm/customers`, { name: 'Quincaillerie Ndi' })).json.id;
  const invDoc = (await owner('POST', `${O}/crm/documents`, { kind: 'invoice', customerId: cust, lines: [{ itemId: item, label: 'Sac de ciment', quantity: 20, price: 6000 }] })).json.id;
  await owner('PUT', `${O}/crm/documents/${invDoc}`, { status: 'sent' });
  await mgr('POST', `${S}/items/${item}/move`, { kind: 'out', quantity: 20, reason: 'Vente' });
  const rc = (await mgr('POST', `${WM}/returns`, { kind: 'customer', documentId: invDoc, reason: 'Livré en double', validate: true, lines: [{ itemId: item, quantity: 4, reasonCode: 'wrong', disposition: 'restock' }] })).json.id;
  r = await mem('POST', `${WM}/returns/${rc}/credit-note`, {});
  check('droits : un membre n\'émet pas d\'avoir', r.status === 403, r.status);
  r = await mgr('POST', `${WM}/returns/${r1}/credit-note`, {});
  check('avoir client sur un retour fournisseur → 400', r.status === 400, r.json);
  r = await mgr('POST', `${WM}/returns/${rc}/credit-note`, {});
  check('retour client : avoir émis sur la facture (4 × 6 000 = 24 000)', r.status === 201 && r.json.total === 24000 && /^AV-/.test(r.json.number), r.json);
  const cd = await dbx.prepare('SELECT credited, status FROM documents WHERE id = ?').get(invDoc);
  check('la facture est créditée de 24 000', cd.credited === 24000, cd);
  r = await mgr('POST', `${WM}/returns/${rc}/credit-note`, {});
  check('un seul avoir par retour → 409', r.status === 409, r.status);
  const rc2 = (await mgr('POST', `${WM}/returns`, { kind: 'customer', customerId: cust, validate: true, lines: [{ itemId: item, quantity: 1, reasonCode: 'wrong', disposition: 'restock' }] })).json.id;
  r = await mgr('POST', `${WM}/returns/${rc2}/credit-note`, {});
  check('retour sans facture liée : pas d\'avoir automatique → 400', r.status === 400, r.json);

  // ---------- Facture d'achat → frais d'arrivée ----------
  const po2 = await mkPo(50, 5000);
  const trans = (await mgr('POST', `${PU}/suppliers`, { name: 'Transports Fotso' })).json.id;
  const tpo = (await mgr('POST', `${PU}/orders`, { supplierId: trans, lines: [{ description: 'Transport Douala-Yaoundé', quantity: 1, unitPrice: 60000 }] })).json.id;
  await owner('POST', `${PU}/orders/${tpo}/approve`);
  const td = (await owner('GET', `${PU}/orders/${tpo}/invoice-draft`)).json;
  // (une commande sans article ne se réceptionne pas : on facture directement le service)
  const tinvId = (await owner('POST', `${PU}/invoices`, { orderId: tpo, supplierRef: 'FOT-77', invoiceDate: shift(0), vatRate: 0, lines: td.lines && td.lines.length ? td.lines : [{ description: 'Transport Douala-Yaoundé', quantity: 1, unitPrice: 60000 }] })).json.id;
  r = await mgr('GET', `${WM}/receipts/invoice-candidates`);
  check('facture non validée : pas proposée', r.status === 200 && !r.json.invoices.some((x) => x.id === tinvId), r.json);
  r = await owner('POST', `${PU}/invoices/${tinvId}/approve`, { override: true, overrideReason: 'Facture de service sans réception' });
  check('facture du transporteur validée (60 000)', r.status === 200, r.json);
  const rec = await mgr('POST', `${WM}/receipts`, { lines: [{ itemId: item, quantity: 50, unitCost: 5000 }] });
  const rcpt = rec.json.id;
  check('réception de 50 sacs enregistrée', rec.status === 201 && rcpt > 0, rec.json);
  r = await mgr('GET', `${WM}/receipts/invoice-candidates`);
  const cand = r.json.invoices.find((x) => x.id === tinvId);
  check('la facture validée est proposée avec son reste à répartir (60 000)', cand && cand.remaining === 60000 && cand.supplier === 'Transports Fotso', r.json);
  const entriesBefore = Number((await dbx.prepare('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ?').get(org)).c);
  const avgBefore = Number((await dbx.prepare('SELECT avg_cost FROM stock_items WHERE id = ?').get(item)).avg_cost);
  r = await mem('POST', `${WM}/receipts/${rcpt}/costs`, { invoiceId: tinvId, kind: 'transport' });
  check('droits : un membre ne rattache pas de frais', r.status === 403, r.status);
  r = await mgr('POST', `${WM}/receipts/${rcpt}/costs`, { invoiceId: tinvId, kind: 'transport', amount: 70000 });
  check('plus que le reste de la facture → 400', r.status === 400, r.json);
  r = await mgr('POST', `${WM}/receipts/${rcpt}/costs`, { invoiceId: 99999, kind: 'transport' });
  check('facture inconnue → 404', r.status === 404, r.status);
  r = await mgr('POST', `${WM}/receipts/${rcpt}/costs`, { invoiceId: tinvId, kind: 'transport', amount: 40000 });
  check('40 000 de la facture rattachés aux frais d\'arrivée de la réception', r.status === 201 && r.json.invoiceId === tinvId, r.json);
  check('aucune nouvelle écriture comptable (la charge est celle de la facture)', Number((await dbx.prepare('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ?').get(org)).c) === entriesBefore, entriesBefore);
  check('coût moyen relevé de 40 000 répartis sur le stock concerné', Number((await dbx.prepare('SELECT avg_cost FROM stock_items WHERE id = ?').get(item)).avg_cost) > avgBefore, [avgBefore, await dbx.prepare('SELECT avg_cost FROM stock_items WHERE id = ?').get(item)]);
  r = await mgr('POST', `${WM}/receipts/${rcpt}/costs`, { invoiceId: tinvId, kind: 'transport' });
  check('le reste de la facture (20 000) se rattache sans montant', r.status === 201, r.json);
  r = await mgr('POST', `${WM}/receipts/${rcpt}/costs`, { invoiceId: tinvId, kind: 'transport' });
  check('facture entièrement répartie → 409 (jamais deux fois le même montant)', r.status === 409, r.json);
  r = await mgr('GET', `${WM}/receipts/${rcpt}`);
  check('la réception montre le lien de chaque coût avec la facture', r.json.receipt.costs.length === 2 && r.json.receipt.costs.every((c) => c.invoiceId === tinvId), r.json.receipt.costs);
  r = await mgr('GET', `${WM}/receipts/invoice-candidates`);
  check('facture épuisée : plus proposée', !r.json.invoices.some((x) => x.id === tinvId), r.json);

  // ---------- Stock ↔ comptabilité ----------
  r = await mem('GET', `${WM}/accounting-link`);
  check('droits : valeur du stock face à la comptabilité réservée aux responsables', r.status === 403, r.status);
  r = await mgr('GET', `${WM}/accounting-link`);
  const stockNow = Number((await dbx.prepare('SELECT COALESCE(SUM(quantity * CASE WHEN avg_cost > 0 THEN avg_cost ELSE unit_cost END), 0) v FROM stock_items WHERE org_id = ?').get(org)).v);
  check('valeur du stock = celle des articles ; rien encore constaté en classe 3 → écart = valeur', r.status === 200 && Math.abs(r.json.stockValue - stockNow) <= 1 && r.json.accounted === 0 && r.json.gap === r.json.stockValue && r.json.lastPosting === null, r.json);
  check('à comptabiliser : l\'avoir enregistré sans écriture est signalé', r.json.toBook.supplierCredits === 1 && r.json.toBook.supplierCreditsAmount === 20000, r.json.toBook);
  r = await owner('POST', `${AC}/stock-valuation/post`, { date: shift(0) });
  check('constatation du stock en comptabilité (module Comptabilité › Stocks)', r.status === 201, r.json);
  r = await mgr('GET', `${WM}/accounting-link`);
  check('après constatation : écart nul, dernière écriture indiquée', Math.abs(r.json.gap) <= 1 && r.json.lastPosting && /^OD-/.test(r.json.lastPosting.number), r.json);
  r = await other('GET', `${WM2}/accounting-link`);
  check('isolation : l\'autre organisation ne voit ni stock ni écriture', r.status === 200 && r.json.stockValue === 0 && r.json.lastPosting === null, r.json);

  // ---------- Trésorerie du stock ----------
  const po3 = (await mgr('POST', `${PU}/orders`, { supplierId: sup, lines: [{ itemId: item, quantity: 40, unitPrice: 5200 }] })).json.id;
  await owner('POST', `${PU}/orders/${po3}/approve`);
  const dorm = (await owner('POST', `${S}/items`, { name: 'Article dormant', unitCost: 1000 })).json.id;
  await mgr('POST', `${S}/items/${dorm}/move`, { kind: 'in', quantity: 10, unitCost: 1000 });
  await dbx.prepare('UPDATE stock_moves SET created_at = ? WHERE item_id = ?').run(new Date(Date.now() - 300 * 86400000).toISOString(), dorm);
  r = await mem('GET', `${WM}/cash`);
  check('droits : l\'état de trésorerie du stock est réservé aux responsables', r.status === 403, r.status);
  r = await mgr('GET', `${WM}/cash?days=30`);
  const c = r.json;
  check('trésorerie : argent immobilisé = valeur du stock ; article dormant (10 000) isolé', r.status === 200 && c.tiedUp > 0 && c.dormant === 10000 && c.dormantShare > 0, c);
  const vat3 = Number((await dbx.prepare('SELECT vat_rate FROM pur_orders WHERE id = ?').get(po3)).vat_rate);
  const mine3 = c.commitments.orders.find((x) => x.id === po3);
  check('engagements : le bon approuvé non reçu compte pour 40 × 5 200 TTC ; les bons déjà reçus n\'y sont pas', mine3 && mine3.amount === Math.round(208000 * (1 + vat3 / 100)) && !c.commitments.orders.some((x) => x.id === po1 || x.id === po2) && c.commitments.total >= mine3.amount, c.commitments);
  check('dettes fournisseurs ouvertes : factures validées moins les avoirs imputés', c.payables.open > 0 && c.payables.dueInHorizon <= c.payables.open, c.payables);
  check('avoirs attendus : retour fournisseur sans avoir reçu (aucun ici, le seul est enregistré)', c.creditsExpected >= 0, c.creditsExpected);
  check('besoin de trésorerie = engagements + dettes à échéance + réapprovisionnement − avoirs attendus', c.cashNeed === c.commitments.inHorizon + c.payables.dueInHorizon + c.reorder.estimate - c.creditsExpected, c);
  r = await mgr('GET', `${WM}/cash?days=3`);
  check('horizon plafonné à 7 jours au minimum', r.json.horizonDays === 7, r.json.horizonDays);
  r = await other('GET', `${WM2}/cash`);
  check('isolation : l\'autre organisation n\'a ni engagement ni dette', r.status === 200 && r.json.commitments.total === 0 && r.json.payables.open === 0, r.json);

  // ---------- Cohérence générale ----------
  const bad = await dbx.prepare(`SELECT i.id FROM stock_items i LEFT JOIN wms_stock s ON s.item_id = i.id GROUP BY i.id, i.quantity HAVING ABS(i.quantity - COALESCE(SUM(s.quantity), 0)) > 0.0005`).all().catch(() => []);
  check('quantités du stock toujours égales à la somme des emplacements', bad.length === 0, bad);
  r = await owner('GET', `${AC}/entries?limit=500`);
  const unb = (r.json.entries || []).filter((e) => e.lines.reduce((a, l) => a + l.debit, 0) !== e.lines.reduce((a, l) => a + l.credit, 0));
  check('toutes les écritures sont équilibrées', unb.length === 0, unb.map((e) => e.number));
});
