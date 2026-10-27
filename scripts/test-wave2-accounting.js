'use strict';
// Vague 2 : comptabilité (rapprochement bancaire, lettrage, balance âgée, dettes fournisseurs, immobilisations, clôture mensuelle, écarts de caisse).
// Lancez-le avec : node scripts/test-wave2-accounting.js
const { run } = require('./lib/wave2');
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

run('Comptabilité : rapprochement, lettrage, tiers, immobilisations, clôture', async ({ check, owner, mgr, mem, other, org, O }) => {
  const AC = `${O}/accounting`; const S = `${O}/stock`; const C = `${O}/crm`;
  const entry = async (journal, date, label, piece, lines) => (await owner('POST', `${AC}/entries`, { journal, date, label, piece, lines }));
  let r = await mgr('GET', `${AC}/bank`);
  check('rapprochement : réservé aux administrateurs', r.status === 403, r.status);

  // ---------- Rapprochement bancaire ----------
  r = await owner('POST', `${AC}/bank`, { name: 'Banque Exemple', glAccount: '521' });
  const bank = r.json.id;
  check('compte bancaire créé', r.status === 201, r.json);
  r = await owner('POST', `${AC}/bank`, { name: 'X', glAccount: '999' });
  check('compte comptable invalide refusé', r.status === 400, r.json);
  await entry('BQ', '2026-09-01', 'Apport en capital', 'DEP-1', [{ account: '521', debit: 1000000 }, { account: '101', credit: 1000000 }]);
  await entry('BQ', '2026-09-05', 'Encaissement client X', 'VIR-123', [{ account: '521', debit: 150000 }, { account: '411', credit: 150000, memo: 'Client X' }]);
  await entry('BQ', '2026-09-10', 'Loyer septembre', 'CHQ-77', [{ account: '622', debit: 60000 }, { account: '521', credit: 60000 }]);
  await entry('BQ', '2026-09-20', 'Vente comptoir', '', [{ account: '521', debit: 25000 }, { account: '706', credit: 25000 }]);
  const csv = [
    'Date;Libellé;Référence;Débit;Crédit;Solde',
    '01/09/2026;DEPOT CAPITAL;DEP-1;;1 000 000,00;1 000 000,00',
    '06/09/2026;VIR RECU CLIENT X;VIR-123;;150 000,00;1 150 000,00',
    '11/09/2026;CHEQUE 77 LOYER;CHQ-77;60 000,00;;1 090 000,00',
    '25/09/2026;FRAIS DE TENUE DE COMPTE;;2 500;;1 087 500,00',
  ].join('\r\n');
  r = await owner('POST', `${AC}/bank/${bank}/import`, { csv, dryRun: true });
  const d = r.json.detected;
  check('format détecté : séparateur ;, dates jj/mm/aaaa, virgule décimale, colonnes débit/crédit/solde', d.delimiter === ';' && d.dateFormat === 'dmy' && d.decimal === ',' && d.hasHeader && d.columns.debit === 3 && d.columns.credit === 4 && d.columns.balance === 5, d);
  check('aperçu : 4 lignes valides', r.json.valid === 4 && r.json.preview[2].amount === -60000, r.json);
  r = await owner('POST', `${AC}/bank/${bank}/import`, { csv });
  check('import : 4 lignes', r.status === 201 && r.json.imported === 4, r.json);
  r = await owner('POST', `${AC}/bank/${bank}/import`, { csv });
  check('ré-import du même relevé : aucun doublon', r.json.imported === 0 && r.json.duplicates === 4, r.json);
  r = await owner('POST', `${AC}/bank/${bank}/import`, { csv: '' });
  check('relevé vide refusé', r.status === 400, r.json);
  r = await owner('POST', `${AC}/bank/${bank}/import`, { csv: 'a;b\r\nfoo;bar' });
  check('fichier sans date ni montant refusé', r.status === 400, r.json);
  r = await owner('GET', `${AC}/bank/${bank}/suggestions`);
  const sug = r.json.suggestions;
  check('suggestions : 3 lignes avec candidat (les frais n\'en ont pas)', sug.length === 3, sug.length);
  check('suggestion par référence : confiance haute', sug.every((s) => s.confidence === 'high') && sug.some((s) => s.candidates[0].reasons.includes('référence trouvée')), sug.map((s) => [s.confidence, s.candidates[0].reasons]));
  r = await owner('POST', `${AC}/bank/${bank}/match-many`, { pairs: sug.map((s) => ({ bankLineId: s.bankLineId, accLineId: s.candidates[0].accLineId })) });
  check('3 pointages appliqués', r.json.matched === 3 && !r.json.failed.length, r.json);
  r = await owner('GET', `${AC}/bank/${bank}/lines?status=unmatched`);
  const fee = r.json.lines[0];
  check('reste les frais bancaires non pointés', r.json.lines.length === 1 && fee.amount === -2500, r.json);
  r = await owner('GET', `${AC}/bank/${bank}/summary?asOf=2026-09-30`);
  check('écarts : vente comptoir non encore au relevé, frais non comptabilisés, écart nul', r.json.unmatchedGlCount === 1 && r.json.unmatchedGlTotal === 25000 && r.json.unmatchedBankTotal === -2500 && r.json.statementBalance === 1087500 && r.json.gap === 0, r.json);
  // Montant différent refusé
  const glRow = r.json.unmatchedGl[0];
  r = await owner('POST', `${AC}/bank/lines/${fee.id}/match`, { accLineId: glRow.accLineId });
  check('pointage de montants différents refusé', r.status === 400, r.json);
  r = await owner('POST', `${AC}/bank/lines/${fee.id}/post`, { account: '631', label: 'Frais de tenue de compte' });
  check('écriture créée depuis la ligne du relevé et pointée', r.status === 201 && /^BQ-2026-/.test(r.json.entry), r.json);
  r = await owner('GET', `${AC}/bank/${bank}/summary?asOf=2026-09-30`);
  check('après écriture des frais : écart toujours nul', r.json.unmatchedBankCount === 0 && r.json.gap === 0 && r.json.glBalance === 1112500, r.json);
  r = await owner('POST', `${AC}/bank/lines/${fee.id}/unmatch`, {});
  check('dépointage', r.status === 200);
  r = await owner('POST', `${AC}/bank/lines/${fee.id}/ignore`, {});
  check('ligne ignorée', r.status === 200);
  // Autre format : virgules, ISO, montant signé, milliers entre guillemets
  r = await owner('POST', `${AC}/bank`, { name: 'MoMo Exemple', glAccount: '589' });
  const momo = r.json.id;
  r = await owner('POST', `${AC}/bank/${momo}/import`, { csv: 'Date,Description,Amount,Balance\n2026-09-03,"Payment ABC","2,500.00","2,500.00"\n2026-09-04,Withdrawal,-1000.50,1500\n' });
  check('format anglais détecté (virgules, ISO, point décimal, montant signé)', r.status === 201 && r.json.imported === 2 && r.json.detected.delimiter === ',' && r.json.detected.dateFormat === 'ymd' && r.json.detected.decimal === '.', r.json);
  r = await owner('GET', `${AC}/bank/${momo}/lines`);
  check('montants entiers : 2 500 et -1 001 (arrondi)', r.json.lines.some((l) => l.amount === 2500) && r.json.lines.some((l) => l.amount === -1001), r.json.lines.map((l) => l.amount));
  r = await owner('POST', `${AC}/bank/${momo}/import`, { csv: 'Date;Libellé;Montant\n03/13/2026;X;100\n13/09/2026;Y;200' });
  check('date mois/jour détectée (13 en 2e position)', r.status === 201, r.json);

  // ---------- Lettrage ----------
  await entry('VT', '2026-08-30', 'Facture A', 'F-A', [{ account: '411', debit: 100000, memo: 'Client A' }, { account: '706', credit: 100000 }]);
  await entry('BQ', '2026-09-02', 'Règlement Client A', 'REG-A', [{ account: '521', debit: 100000 }, { account: '411', credit: 100000, memo: 'Client A' }]);
  await entry('VT', '2026-09-03', 'Facture B', 'F-B', [{ account: '411', debit: 40000, memo: 'Client B' }, { account: '706', credit: 40000 }]);
  r = await owner('GET', `${AC}/lettering?account=411`);
  check('lettrage : proposition Client A (100 000)', r.json.proposals.some((p) => p.amount === 100000 && p.party === 'Client A'), r.json.proposals);
  const open = r.json.open;
  const fb = open.find((l) => l.party === 'Client B'); const fa = open.find((l) => l.party === 'Client A' && l.debit === 100000); const ra = open.find((l) => l.party === 'Client A' && l.credit === 100000);
  r = await owner('POST', `${AC}/lettering`, { account: '411', lineIds: [fb.id, ra.id] });
  check('lettrage déséquilibré / tiers différents refusé', r.status === 400, r.json);
  r = await owner('POST', `${AC}/lettering`, { account: '411', lineIds: [fa.id, ra.id] });
  check('lettrage manuel : code A', r.status === 201 && r.json.code === 'A', r.json);
  r = await owner('POST', `${AC}/lettering`, { account: '411', lineIds: [fa.id, ra.id] });
  check('lignes déjà lettrées refusées', r.status === 409, r.json);
  r = await owner('DELETE', `${AC}/lettering/411/A`);
  check('délettrage', r.status === 200 && r.json.unlettered === 2, r.json);
  r = await owner('POST', `${AC}/lettering/auto`, { account: '411' });
  check('lettrage automatique', r.json.lettered >= 1, r.json);
  r = await owner('GET', `${AC}/lettering?account=411`);
  check('Client B reste non lettré (facture impayée)', r.json.open.some((l) => l.party === 'Client B') && !r.json.open.some((l) => l.party === 'Client A'), r.json.open);

  // ---------- Balance âgée clients ----------
  r = await mgr('POST', `${C}/customers`, { name: 'Société Âgée' });
  const cust = r.json.id;
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, issued: day(-80), due: day(-45), lines: [{ label: 'Prestation', quantity: 1, price: 119250 }] });
  const inv = r.json.id;
  await mgr('PUT', `${C}/documents/${inv}`, { status: 'sent' });
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, issued: day(-5), due: day(20), lines: [{ label: 'Autre', quantity: 1, price: 50000 }] });
  await mgr('PUT', `${C}/documents/${r.json.id}`, { status: 'sent' });
  r = await owner('GET', `${AC}/aged?kind=customers`);
  const row = r.json.rows.find((x) => x.party === 'Société Âgée');
  check('balance âgée clients : 31-60 jours et non échu', row && row.d60 === 119250 && row.current === 50000 && row.total === 169250, row);
  check('totaux de la balance âgée', r.json.totals.total >= 169250 && r.json.buckets.length === 5);

  // ---------- Dettes fournisseurs alimentées par les achats ----------
  r = await mgr('POST', `${S}/suppliers`, { name: 'Grossiste Nord' });
  const sup = r.json.id;
  r = await mgr('POST', `${S}/items`, { name: 'Savon', unit: 'carton', quantity: 0 });
  const sav = r.json.id;
  await mem('POST', `${S}/orders`, { itemId: sav, supplierId: sup, quantity: 100, unitPrice: 400 });
  r = await mgr('GET', `${S}/orders`);
  const po = r.json.orders[0].id;
  await mgr('PUT', `${S}/orders/${po}/status`, { status: 'ordered' });
  r = await mgr('POST', `${S}/orders/${po}/receive`, { quantity: 40 });
  check('réception de 40 x 400 = 16 000', r.status === 200, r.json);
  r = await owner('POST', `${AC}/generate`, {});
  check('achat comptabilisé (401)', r.json.purchases === 1, r.json);
  r = await owner('POST', `${AC}/payables/from-purchases`, { termsDays: 30 });
  check('dette créée depuis la réception', r.status === 201 && r.json.created === 1, r.json);
  r = await owner('POST', `${AC}/payables/from-purchases`, {});
  check('pas de doublon au second appel', r.json.created === 0, r.json);
  r = await owner('GET', `${AC}/payables`);
  const bill = r.json.bills[0];
  check('dette : 16 000, échéance à 30 jours, fournisseur', bill.amount === 16000 && bill.supplier === 'Grossiste Nord' && bill.balance === 16000 && bill.accEntryId, bill);
  r = await owner('POST', `${AC}/payables/${bill.id}/pay`, { amount: 6000, method: 'bank', reference: 'VIR-FOURN-1' });
  check('règlement partiel de 6 000', r.status === 201, r.json);
  r = await owner('POST', `${AC}/payables/${bill.id}/pay`, { amount: 20000 });
  check('règlement au-delà du solde refusé', r.status === 400, r.json);
  r = await owner('GET', `${AC}/payables?status=partial`);
  check('statut « partiel », solde 10 000', r.json.bills[0].status === 'partial' && r.json.bills[0].balance === 10000 && r.json.summary.balance === 10000, r.json);
  r = await owner('GET', `${AC}/aged?kind=suppliers`);
  check('balance âgée fournisseurs : 10 000 non échu', r.json.rows[0].party === 'Grossiste Nord' && r.json.rows[0].current === 10000, r.json.rows);
  r = await owner('POST', `${AC}/payables`, { supplierName: 'Imprimerie Test', number: 'FF-77', amount: 59500, billDate: day(-70), dueDate: day(-40), expenseAccount: '605' });
  check('facture fournisseur manuelle comptabilisée', r.status === 201 && r.json.entry, r.json);
  const manual = r.json.id;
  r = await owner('GET', `${AC}/payables`);
  check('facture échue signalée', r.json.bills.find((b) => b.id === manual).overdue === true && r.json.summary.overdue === 1, r.json.summary);
  r = await owner('GET', `${AC}/balance?year=2026`);
  const b401 = r.json.rows.find((x) => x.account === '401');
  check('compte 401 : 16 000 + 59 500 - 6 000 réglés = 69 500', b401 && b401.credit - b401.debit === 69500, b401);
  r = await owner('DELETE', `${AC}/payables/${manual}`);
  check('annulation d\'une facture non réglée (écriture inverse)', r.status === 200 && r.json.reversedEntry, r.json);
  r = await owner('DELETE', `${AC}/payables/${bill.id}`);
  check('facture réglée en partie : annulation refusée', r.status === 400, r.json);

  // ---------- Immobilisations ----------
  r = await owner('POST', `${AC}/assets`, { label: 'Camion', category: 'transport', cost: 1200000, lifeMonths: 12, acquiredOn: '2026-08-15', startMonth: '2026-08' });
  const a1 = r.json.id;
  check('immobilisation enregistrée', r.status === 201, r.json);
  r = await owner('POST', `${AC}/assets`, { label: 'Sans durée', cost: 1000 });
  check('durée obligatoire (aucune durée imposée)', r.status === 400, r.json);
  r = await owner('POST', `${AC}/assets`, { label: 'Ordinateur', category: 'it', cost: 1000000, residual: 100000, lifeMonths: 3, startMonth: '2026-09' });
  const a2 = r.json.id;
  r = await owner('GET', `${AC}/assets/${a2}/plan`);
  check('plan linéaire : 900 000 sur 3 mois, dernier mois absorbe l\'arrondi', r.json.plan.map((x) => x.amount).join() === '300000,300000,300000' && r.json.plan[2].netBookValue === 100000, r.json.plan);
  r = await owner('POST', `${AC}/assets`, { label: 'Imprimante', category: 'it', cost: 100000, lifeMonths: 3, startMonth: '2026-09' });
  const a3 = r.json.id;
  r = await owner('GET', `${AC}/assets/${a3}/plan`);
  check('arrondi : 33 333 + 33 333 + 33 334', r.json.plan.map((x) => x.amount).join() === '33333,33333,33334', r.json.plan);
  r = await owner('POST', `${AC}/assets/depreciate`, { month: '2026-08' });
  check('dotation d\'août : 100 000 (camion)', r.status === 201 && r.json.entries[0].amount === 100000, r.json);
  r = await owner('POST', `${AC}/assets/depreciate`, { month: '2026-08' });
  check('seconde dotation du même mois : rien de nouveau', r.json.entries.length === 0, r.json);
  r = await owner('POST', `${AC}/assets/depreciate`, { month: '2026-09' });
  check('dotation de septembre : 100 000 + 300 000 + 33 333', r.status === 201 && r.json.entries[0].amount === 433333, r.json);
  r = await owner('GET', `${AC}/entries?q=Dotation`);
  const dot = r.json.entries.find((e) => /2026-09/.test(e.label));
  check('écriture : débit 681, crédits 2845, 28183', dot.lines.some((l) => l.account === '681' && l.debit === 433333) && dot.lines.some((l) => l.account === '2845' && l.credit === 100000) && dot.lines.some((l) => l.account === '28183' && l.credit === 333333), dot.lines);
  r = await owner('GET', `${AC}/assets`);
  const cam = r.json.assets.find((x) => x.id === a1);
  check('camion : cumul 200 000, valeur nette 1 000 000', cam.accumulated === 200000 && cam.netBookValue === 1000000 && cam.remainingMonths === 10, cam);
  r = await owner('POST', `${AC}/assets/depreciate`, { month: '2026-10', catchUp: true });
  check('rattrapage jusqu\'à octobre', r.json.entries.length === 1 && r.json.entries[0].period === '2026-10', r.json);
  r = await owner('DELETE', `${AC}/assets/${a1}`);
  check('bien déjà amorti : suppression refusée', r.status === 400, r.json);
  r = await owner('POST', `${AC}/assets/${a2}/dispose`, { date: '2026-11-15' });
  check('sortie du registre', r.status === 200);

  // ---------- Écarts de caisse ----------
  await entry('CA', '2026-09-12', 'Encaissement espèces', '', [{ account: '571', debit: 50000 }, { account: '706', credit: 50000 }]);
  r = await owner('POST', `${AC}/cash-counts`, { date: '2026-09-30', counted: 45000, note: '' });
  check('écart de caisse : attendu 50 000, compté 45 000, écart -5 000', r.status === 201 && r.json.expected === 50000 && r.json.diff === -5000 && !r.json.entry, r.json);
  r = await owner('POST', `${AC}/cash-counts`, { date: '2026-09-30', counted: 45000, post: true });
  check('comptabiliser un écart demande une explication', r.status === 400, r.json);
  r = await owner('POST', `${AC}/cash-counts`, { date: '2026-09-30', counted: 45000, post: true, note: 'Rendu de monnaie erroné' });
  check('manque comptabilisé (658 / 571)', r.status === 201 && r.json.entry, r.json);
  r = await owner('GET', `${AC}/balance?year=2026`);
  check('caisse ramenée à 45 000', r.json.rows.find((x) => x.account === '571').debit - r.json.rows.find((x) => x.account === '571').credit === 45000);
  r = await owner('POST', `${AC}/cash-counts`, { date: '2026-09-30', counted: 47000, post: true, note: 'Excédent' });
  check('excédent comptabilisé (571 / 758)', r.status === 201 && r.json.diff === 2000 && r.json.entry, r.json);

  // ---------- Clôture mensuelle ----------
  r = await mgr('GET', `${AC}/closing?month=2026-09`);
  check('clôture : réservée aux administrateurs', r.status === 403);
  r = await owner('GET', `${AC}/closing?month=2026-09`);
  const keys = r.json.items.map((i) => i.key);
  check('liste de contrôle guidée', ['auto', 'bank', 'assets', 'payroll', 'payables', 'receivables', 'cash', 'adjustments', 'vat', 'review'].every((k) => keys.includes(k)), keys);
  check('contrôles manuels à cocher (bloquants)', r.json.items.filter((i) => i.manual && i.status === 'todo').length === 3 && r.json.blockers >= 3, r.json.items);
  r = await owner('POST', `${AC}/closing/close`, { month: '2026-09' });
  check('clôture refusée tant qu\'il reste des points à faire', r.status === 400 && /reste à faire/.test(r.json.error), r.json);
  r = await owner('POST', `${AC}/closing/adjustments`, { month: '2026-09', kind: 'prepaid', label: 'Assurance payée d\'avance', amount: 120000, account: '625' });
  check('charge constatée d\'avance : écriture + contre-passation du mois suivant', r.status === 201 && r.json.entry && r.json.reversal, r.json);
  r = await owner('GET', `${AC}/entries?q=Assurance`);
  const prepaid = r.json.entries.find((e) => !e.reversedOf);
  const back = r.json.entries.find((e) => e.reversedOf);
  check('CCA : débit 476 / crédit 625 ; extourne datée du 1er octobre', prepaid.lines.some((l) => l.account === '476' && l.debit === 120000) && back.date === '2026-10-01', [prepaid.lines, back.date]);
  r = await owner('POST', `${AC}/closing/adjustments`, { month: '2026-09', kind: 'provision', label: 'Litige client', amount: 80000 });
  check('provision (691 / 191)', r.status === 201 && !r.json.reversal, r.json);
  r = await owner('POST', `${AC}/closing/adjustments`, { month: '2026-09', kind: 'prepaid', label: 'x', amount: 1, account: '701' });
  check('compte de charge obligatoire (classe 6)', r.status === 400, r.json);
  for (const k of ['adjustments', 'vat', 'review']) await owner('PUT', `${AC}/closing/check`, { month: '2026-09', key: k, checked: true });
  r = await owner('GET', `${AC}/closing?month=2026-09`);
  const todo = r.json.items.filter((i) => i.status === 'todo').map((i) => i.key);
  check('il ne reste que les points automatiques à traiter', !todo.includes('adjustments') && !todo.includes('vat'), todo);
  if (todo.length) {
    r = await owner('POST', `${AC}/closing/close`, { month: '2026-09', force: true });
    check('forcer la clôture exige un motif', r.status === 400, r.json);
    r = await owner('POST', `${AC}/closing/close`, { month: '2026-09', force: true, note: 'Test : points ouverts acceptés' });
  } else r = await owner('POST', `${AC}/closing/close`, { month: '2026-09' });
  check('mois clôturé', r.status === 200, r.json);
  r = await entry('OD', '2026-09-28', 'Après clôture', '', [{ account: '622', debit: 10 }, { account: '521', credit: 10 }]);
  check('écriture dans un mois clôturé refusée', r.status === 400 && /clôturé/.test(r.json.error), r.json);
  r = await owner('POST', `${AC}/closing/adjustments`, { month: '2026-09', kind: 'provision', label: 'Trop tard', amount: 5 });
  check('ajustement dans un mois clôturé refusé', r.status === 409, r.json);
  r = await owner('POST', `${AC}/closing/reopen`, { month: '2026-09', reason: 'ok' });
  check('réouverture : motif trop court refusé', r.status === 400, r.json);
  r = await owner('POST', `${AC}/closing/reopen`, { month: '2026-09', reason: 'Oubli d\'une facture' });
  check('réouverture avec motif', r.status === 200);
  r = await entry('OD', '2026-09-28', 'Après réouverture', '', [{ account: '622', debit: 10 }, { account: '521', credit: 10 }]);
  check('écriture à nouveau possible', r.status === 201, r.json);
  r = await other('GET', `/api/ws/orgs/${org}/accounting/closing`);
  check('autre organisation : aucun accès', r.status === 404);
});
