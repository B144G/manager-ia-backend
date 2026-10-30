'use strict';
// Vague 1 : facture conforme (TVA, NIU, numérotation, avoirs, impression), paiements par mode et référence (mobile money), e-mail et WhatsApp.
// Lancez-le avec : node scripts/test-wave1-billing.js
const { run } = require('./lib/wave1');

run('Facture conforme et encaissements', async ({ check, owner, mgr, mem, other, org, O, dbx }) => {
  const C = `${O}/crm`;
  let r = await mgr('PUT', `${C}/invoice-settings`, { niu: 'M012345678901X' });
  check('réglages de facturation : réservés aux administrateurs', r.status === 403, r.status);
  r = await owner('PUT', `${C}/invoice-settings`, { niu: 'M012345678901X', rccm: 'RC/DLA/2024/B/123', address: 'Akwa, Douala', payInfo: 'MTN MoMo : 670000000 (Boutique Awa)', footer: 'Pénalités de retard : à définir avec votre conseil.', vatRate: 19.25 });
  check('réglages enregistrés', r.status === 200, r.json);
  r = await mgr('GET', `${C}/invoice-settings`);
  check('NIU, TVA et coordonnées de paiement relus', r.json.niu === 'M012345678901X' && r.json.vatRate === 19.25 && /MTN/.test(r.json.payInfo), r.json);
  r = await owner('PUT', `${C}/invoice-settings`, { vatRate: 80 });
  check('taux de TVA absurde refusé', r.status === 400, r.json);

  r = await mgr('POST', `${C}/customers`, { name: 'Société Mbarga', phone: '237677112233', email: 'mbarga@exemple.com', niu: 'M987654321098Z', address: 'Bonanjo' });
  const cust = r.json.id;
  r = await mgr('GET', `${C}/customers`);
  check('NIU et adresse du client conservés', r.json.customers.find((c) => c.id === cust).niu === 'M987654321098Z', r.json);

  // Prix HT : TVA ajoutée
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, pricesIncl: false, lines: [{ label: 'Prestation', quantity: 2, price: 50000 }] });
  const inv = r.json.id;
  r = await mgr('GET', `${C}/documents?kind=invoice`);
  let d = r.json.documents.find((x) => x.id === inv);
  check('prix HT : HT 100 000, TVA 19 250, TTC 119 250', d.subtotalHt === 100000 && d.vatAmount === 19250 && d.total === 119250 && d.vatRate === 19.25, d);
  check('numéro F-AAAA-0001', /^F-\d{4}-0001$/.test(d.number), d.number);
  // Prix TTC (défaut) : TVA extraite
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, lines: [{ label: 'Pagne', quantity: 1, price: 11925 }] });
  const inv2 = r.json.id;
  r = await mgr('GET', `${C}/documents?kind=invoice`);
  d = r.json.documents.find((x) => x.id === inv2);
  check('prix TTC (défaut) : total inchangé 11 925, HT 10 000, TVA 1 925', d.total === 11925 && d.subtotalHt === 10000 && d.vatAmount === 1925 && /-0002$/.test(d.number), d);
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, vatRate: 0, pricesIncl: false, lines: [{ label: 'Export', quantity: 1, price: 5000 }] });
  const inv0 = r.json.id;
  r = await mgr('GET', `${C}/documents?kind=invoice`);
  d = r.json.documents.find((x) => x.id === inv0);
  check('TVA à 0 % (exonéré) : TTC = HT, pas de repli sur le taux par défaut', d.total === 5000 && d.vatAmount === 0 && d.vatRate === 0, d);

  // Numérotation : suppression du dernier brouillon seulement, pas de doublon
  r = await mgr('DELETE', `${C}/documents/${inv2}`);
  check('supprimer un brouillon qui n\'est pas le dernier numéro est refusé (trou)', r.status === 400, r.json);
  r = await mgr('DELETE', `${C}/documents/${inv0}`);
  check('supprimer le dernier brouillon : accepté', r.status === 200, r.json);
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, lines: [{ label: 'Remplacement', quantity: 1, price: 1000 }] });
  const inv3 = r.json.id;
  r = await mgr('GET', `${C}/documents?kind=invoice`);
  check('la séquence est reprise sans trou ni doublon (0003)', /-0003$/.test(r.json.documents.find((x) => x.id === inv3).number), r.json.documents.map((x) => x.number));
  const sim = await Promise.all([1, 2, 3, 4, 5].map((i) => mgr('POST', `${C}/documents`, { kind: 'quote', customerId: cust, lines: [{ label: 'Devis ' + i, quantity: 1, price: 100 }] })));
  r = await mgr('GET', `${C}/documents?kind=quote`);
  const nums = r.json.documents.map((x) => x.number);
  check('5 créations simultanées : 5 numéros distincts et consécutifs', sim.every((x) => x.status === 201) && new Set(nums).size === 5 && nums.sort().join() === ['D-0001', 'D-0002', 'D-0003', 'D-0004', 'D-0005'].map((n) => n.replace('D-', `D-${new Date().getUTCFullYear()}-`)).join(), nums);

  // Émission et paiements
  r = await mgr('PUT', `${C}/documents/${inv}`, { status: 'sent', due: '2099-01-01' });
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 20000, method: 'mtn_momo' });
  check('mobile money sans référence -> 400', r.status === 400, r.json);
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 20000, method: 'bitcoin', reference: 'x' });
  check('mode inconnu -> 400', r.status === 400, r.json);
  r = await mem('POST', `${C}/documents/${inv}/payments`, { amount: 20000, method: 'cash' });
  check('un membre ne saisit pas de paiement -> 403', r.status === 403, r.status);
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 20000, method: 'mtn_momo', reference: 'MP260101.1234.A56789', payerPhone: '670000001' });
  check('paiement MTN avec référence enregistré', r.status === 200 && r.json.paid === 20000, r.json);
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 1000, method: 'mtn_momo', reference: 'MP260101.1234.A56789' });
  check('même référence deux fois -> 409', r.status === 409, r.json);
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 30000, method: 'orange_money', reference: 'OM-998877', status: 'pending' });
  check('référence « à vérifier » : enregistrée sans toucher au solde', r.status === 201 && r.json.pending === true && r.json.paid === 20000, r.json);
  const pendId = r.json.id;
  r = await mgr('GET', `${C}/documents/${inv}/payments`);
  const p1 = r.json.payments.find((p) => p.reference === 'MP260101.1234.A56789');
  check('liste : mode, opérateur, référence, statut', p1.method === 'mtn_momo' && p1.operator === 'MTN' && p1.status === 'confirmed' && r.json.payments.find((p) => p.id === pendId).status === 'pending', r.json);
  r = await mgr('POST', `${C}/documents/${inv}/payments/${pendId}/confirm`);
  check('confirmation : solde mis à jour (50 000)', r.status === 200 && r.json.paid === 50000, r.json);
  r = await mgr('POST', `${C}/documents/${inv}/payments/${pendId}/confirm`);
  check('déjà traité -> 400', r.status === 400, r.json);
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 5000, method: 'transfer', reference: 'VIR-1', status: 'pending' });
  r = await mgr('POST', `${C}/documents/${inv}/payments/${r.json.id}/reject`);
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 5000, method: 'transfer', reference: 'VIR-1' });
  check('référence d\'un paiement rejeté réutilisable', r.status === 200, r.json);
  const cm = await dbx.prepare("SELECT COUNT(*) c FROM budget_entries WHERE org_id = ? AND label LIKE 'Paiement F-%'").get(org);
  check('seuls les paiements confirmés vont au budget (3)', cm.c === 3, cm);

  // Avoir
  r = await mgr('POST', `${C}/documents/${inv}/credit-note`, { lines: [{ label: 'Remise', quantity: 1, price: 10000 }] });
  check('avoir sans motif -> 400', r.status === 400, r.json);
  r = await mgr('POST', `${C}/documents/${inv2}/credit-note`, { reason: 'Erreur' });
  check('avoir sur un brouillon -> 400', r.status === 400, r.json);
  r = await mgr('POST', `${C}/documents/${inv}/credit-note`, { reason: 'Remise commerciale', lines: [{ label: 'Remise', quantity: 1, price: 200000 }] });
  check('avoir supérieur à la facture -> 400', r.status === 400, r.json);
  // comptabilité active : on y passe une première écriture
  await owner('POST', `${O}/accounting/generate`);
  r = await mgr('POST', `${C}/documents/${inv}/credit-note`, { reason: 'Remise commerciale', lines: [{ label: 'Remise', quantity: 1, price: 5000 }], pricesIncl: false });
  check('avoir partiel créé (AV-)', r.status === 201 && /^AV-\d{4}-0001$/.test(r.json.number) && r.json.total === 5963, r.json);
  const cn = r.json.id;
  check('écriture comptable inverse passée automatiquement', r.json.accountingPosted === true, r.json);
  const ent = await dbx.prepare("SELECT l.account, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.org_id = ? AND e.source = 'credit_note' ORDER BY l.id").all(org);
  check('écriture inverse : 701 et 4431 au débit, 411 au crédit, équilibrée', ent.length === 3 && ent[0].account === '701' && ent[0].debit === 5000 && ent[1].account === '4431' && ent[1].debit === 963 && ent[2].account === '411' && ent[2].credit === 5963, ent);
  r = await mgr('GET', `${C}/documents?kind=invoice`);
  d = r.json.documents.find((x) => x.id === inv);
  check('facture : avoir déduit du dû (119 250 - 55 000 payés - 5 963 = 58 287)', d.credited === 5963 && d.paid === 55000 && d.balance === 58287 && d.status === 'sent', d);
  r = await mgr('GET', `${C}/documents?kind=credit`);
  check('avoir listé, lié à la facture', r.json.documents.length === 1 && r.json.documents[0].creditOf === inv && r.json.documents[0].creditReason === 'Remise commerciale', r.json.documents);
  r = await mgr('PUT', `${C}/documents/${cn}`, { note: 'x' });
  check('un avoir émis ne se modifie pas', r.status === 400, r.json);
  r = await mgr('DELETE', `${C}/documents/${cn}`);
  check('un avoir ne se supprime pas', r.status === 400 || r.status === 403, r.json);
  r = await owner('POST', `${O}/accounting/generate`);
  const dup = await dbx.prepare("SELECT COUNT(*) c FROM acc_entries WHERE org_id = ? AND source = 'credit_note'").get(org);
  check('génération automatique : pas de doublon d\'écriture d\'avoir', r.status === 200 && dup.c === 1, dup);
  const pe = await dbx.prepare("SELECT e.journal, l.account FROM acc_entries e JOIN acc_lines l ON l.entry_id = e.id WHERE e.org_id = ? AND e.source = 'payment' AND e.piece = 'MP260101.1234.A56789'").all(org);
  check('paiement mobile money : journal MM et compte 589, référence en pièce', pe.length === 2 && pe[0].journal === 'MM' && pe.some((x) => x.account === '589'), pe);

  // Avoir total sur une facture non payée
  r = await mgr('PUT', `${C}/documents/${inv3}`, { status: 'sent' });
  r = await mgr('POST', `${C}/documents/${inv3}/credit-note`, { reason: 'Facture émise par erreur' });
  r = await mgr('GET', `${C}/documents?kind=invoice`);
  d = r.json.documents.find((x) => x.id === inv3);
  check('avoir total : facture soldée par avoir (statut « credited »), dû 0', d.status === 'credited' && d.balance === 0, d);
  r = await mgr('GET', `${C}/documents?kind=invoice`);
  check('impayés : une facture soldée par avoir n\'est plus à encaisser', r.json.summary.owed === 58287, r.json.summary);

  // Impression, WhatsApp, e-mail
  r = await mgr('GET', `${C}/documents/${inv}/print`);
  check('données d\'impression : NIU des deux parties, TVA, lignes, paiements, document de travail', r.status === 200 && r.json.org.niu === 'M012345678901X' && r.json.customer.niu === 'M987654321098Z' && r.json.totals.vat === 19250 && r.json.totals.ht === 100000 && r.json.payments.length >= 3 && r.json.workingDocument === true && r.json.missing.length === 0, r.json);
  r = await mem('GET', `${C}/documents/${inv}/print`);
  check('impression réservée aux responsables', r.status === 403, r.status);
  r = await other('GET', `/api/ws/orgs/${org}/crm/documents/${inv}/print`);
  check('autre organisation : 404', r.status === 404, r.status);
  r = await mgr('GET', `${C}/documents/${inv}/share`);
  check('lien WhatsApp : message avec numéro, montant et moyen de paiement, rien d\'envoyé', r.status === 200 && /wa\.me\/237677112233/.test(r.json.url) && /F-\d{4}-0001/.test(r.json.message) && /MTN MoMo/.test(r.json.message), r.json);
  r = await mgr('POST', `${C}/documents/${inv}/email`, {});
  check('e-mail : service non configuré -> 503 honnête (rien n\'est prétendu envoyé)', r.status === 503, r.json);
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 1 });
  r = await mgr('POST', `${C}/customers`, { name: 'Sans NIU' });
  const c2 = r.json.id;
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: c2, lines: [{ label: 'A', quantity: 1, price: 100 }] });
  r = await mgr('GET', `${C}/documents/${r.json.id}/print`);
  check('mentions manquantes signalées (NIU du client)', r.json.missing.includes('customer_niu'), r.json.missing);

  // Ancien document (sans taux) : total traité comme TTC
  const now = new Date().toISOString();
  const lid = Number((await dbx.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-ANCIEN-1', 'sent', '[]', 119250, 0, '2024-01-01', 1, ?, ?)").run(org, cust, now, now)).lastInsertRowid);
  r = await mgr('GET', `${C}/documents/${lid}/print`);
  check('ancienne facture : total TTC conservé, HT et TVA déduits au taux de l\'organisation', r.json.totals.total === 119250 && r.json.totals.ht === 100000 && r.json.totals.vat === 19250, r.json.totals);
  r = await mgr('DELETE', `${C}/customers/${cust}`);
  check('client avec factures émises : suppression refusée (pièces à conserver)', r.status === 409, r.json);
  r = await owner('POST', `${O}/ai/chat`, { module: 'crm', message: 'Point ?' });
  check('IA : le contexte « crm » est construit (route ajoutée aux contextes)', r.status === 200 || r.status === 503, r.status);
});
