'use strict';
// Vague 2 : budget annuel (prévu / réalisé / écarts), engagements, trésorerie à 3 mois, validation par seuil, source unique avec la compta.
// Lancez-le avec : node scripts/test-wave2-budget.js
const { run } = require('./lib/wave2');
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const thisYear = new Date().toISOString().slice(0, 4);
const month = (n) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };

run('Budget annuel, trésorerie et source unique', async ({ check, owner, mgr, mem, other, org, O, dbx }) => {
  const B = `${O}/budget`; const AC = `${O}/accounting`; const C = `${O}/crm`; const S = `${O}/stock`;
  let r = await mgr('GET', `${B}/annual`);
  check('budget annuel : réservé aux administrateurs (données de la compta)', r.status === 403, r.status);
  r = await mem('GET', B);
  check('le budget mensuel reste fermé aux membres', r.status === 403);

  // Données existantes : le budget mensuel continue de fonctionner comme avant
  r = await mgr('POST', `${B}/entries`, { kind: 'expense', category: 'Loyer', amount: 60000, date: `${thisYear}-01-05`, label: 'Loyer mars' });
  check('ligne de budget existante inchangée (201)', r.status === 201 && r.json.id, r.json);
  const loyerManual = r.json.id;
  r = await mgr('GET', `${B}?month=${thisYear}-01`);
  check('vue mensuelle inchangée', r.json.expense === 60000, r.json);

  // Budget annuel
  r = await owner('PUT', `${B}/annual`, { year: thisYear, lines: [{ kind: 'expense', category: 'Loyer', monthly: 60000 }, { kind: 'expense', category: 'Achats', amounts: [100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000] }, { kind: 'income', category: 'Ventes', monthly: 500000 }] });
  check('budget annuel enregistré (3 lignes)', r.status === 200 && r.json.lines === 3, r.json);
  r = await owner('PUT', `${B}/annual`, { year: thisYear, lines: [{ kind: 'expense', category: 'X', amounts: [1, 2] }] });
  check('12 montants obligatoires', r.status === 400, r.json);
  r = await owner('GET', `${B}/annual?year=${thisYear}`);
  let loyer = r.json.lines.find((l) => l.category === 'Loyer');
  check('prévu 12 x 60 000 ; la ligne manuelle est comptée « hors compta » (pas encore en compta)', loyer.plannedTotal === 720000 && loyer.manualTotal === 60000 && loyer.realizedTotal === 60000 && loyer.ledger.every((x) => x === 0), loyer);

  // Une SEULE saisie pour budget + compta : ledger:true
  r = await mgr('POST', `${B}/entries`, { kind: 'expense', category: 'Loyer', amount: 60000, date: `${thisYear}-02-05`, ledger: true, account: '622' });
  check('un responsable ne peut pas inscrire en compta', r.status === 403, r.json);
  r = await owner('POST', `${B}/entries`, { kind: 'expense', category: 'Loyer', amount: 60000, date: `${thisYear}-02-05`, label: 'Loyer avril', ledger: true, account: '622', payment: 'bank' });
  check('saisie unique : ligne de budget + écriture comptable', r.status === 201 && /^BQ-/.test(r.json.entry), r.json);
  r = await owner('POST', `${B}/entries`, { kind: 'expense', category: 'Loyer', amount: 10, ledger: true, account: '701' });
  check('compte de produits refusé pour une sortie', r.status === 400, r.json);
  r = await owner('GET', `${B}/annual?year=${thisYear}`);
  loyer = r.json.lines.find((l) => l.category === 'Loyer');
  check('février lu dans la compta (60 000) sans double compte ; janvier hors compta', loyer.ledger[1] === 60000 && loyer.manual[1] === 0 && loyer.manual[0] === 60000 && loyer.realizedTotal === 120000, loyer);
  check('écart = réalisé - prévu', loyer.gap === 120000 - 720000 && loyer.favorable === true, loyer);

  // Détection de doublons : le même loyer de mars saisi en compta à la main
  r = await owner('POST', `${AC}/entries`, { journal: 'CA', date: `${thisYear}-01-06`, label: 'Loyer mars', piece: '', lines: [{ account: '622', debit: 60000 }, { account: '571', credit: 60000 }] });
  r = await owner('GET', `${B}/annual?year=${thisYear}`);
  loyer = r.json.lines.find((l) => l.category === 'Loyer');
  check('avant liaison : janvier compté deux fois (compta + hors compta) - signalé comme doublon probable', loyer.ledger[0] === 60000 && loyer.manual[0] === 60000);
  r = await owner('GET', `${B}/duplicates?year=${thisYear}`);
  check('doublon proposé (montant identique, dates proches)', r.json.duplicates.length === 1 && r.json.duplicates[0].budgetEntryId === loyerManual, r.json);
  const dup = r.json.duplicates[0];
  r = await owner('POST', `${B}/duplicates/link`, { pairs: [{ budgetEntryId: dup.budgetEntryId, accEntryId: dup.accEntryId }] });
  check('liaison appliquée', r.json.linked === 1, r.json);
  r = await owner('GET', `${B}/annual?year=${thisYear}`);
  loyer = r.json.lines.find((l) => l.category === 'Loyer');
  check('après liaison : janvier compté une seule fois', loyer.realized[0] === 60000 && loyer.manual[0] === 0 && loyer.realizedTotal === 120000, loyer);
  r = await mgr('GET', `${B}?month=${thisYear}-01`);
  check('la vue mensuelle du responsable n\'a pas changé (données non cassées)', r.json.expense === 60000 && r.json.entries.length === 1, r.json);

  // Lignes miroir : paiement de facture -> budget « Ventes » ; la facture en compta fait foi
  r = await mgr('POST', `${C}/customers`, { name: 'Client Miroir' });
  const cust = r.json.id;
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, issued: `${thisYear}-01-02`, due: day(10), lines: [{ label: 'Vente', quantity: 1, price: 119250 }] });
  const inv = r.json.id;
  await mgr('PUT', `${C}/documents/${inv}`, { status: 'sent' });
  r = await mgr('POST', `${C}/documents/${inv}/payments`, { amount: 119250, method: 'cash' });
  check('paiement reçu (ligne de budget miroir créée comme avant)', r.status === 200, r.json);
  r = await mgr('GET', `${B}?month=${month(0)}`);
  check('budget mensuel : l\'entrée « Ventes » existe toujours', r.json.income === 119250, r.json);
  r = await owner('GET', `${B}/annual?year=${thisYear}`);
  let ventes = r.json.lines.find((l) => l.kind === 'income' && l.category === 'Ventes');
  check('avant comptabilisation : la vente est comptée une fois (miroir hors compta)', ventes.realizedTotal === 119250 && ventes.manualTotal === 119250, ventes);
  r = await owner('POST', `${AC}/generate`, {});
  r = await owner('GET', `${B}/annual?year=${thisYear}`);
  ventes = r.json.lines.find((l) => l.kind === 'income' && l.category === 'Ventes');
  check('après comptabilisation : lue dans la compta (HT 100 000), le miroir est ignoré', ventes.manualTotal === 0 && ventes.realizedTotal === 100000, ventes);
  check('une seule source : plus rien « hors compta » (tout est couvert par la compta)', r.json.totals.manual === 0, r.json.totals);

  // Correspondance compte -> catégorie
  r = await owner('GET', `${B}/map`);
  check('table de correspondance compte -> catégorie', r.json.map.some((m) => m.prefix === '622' && m.category === 'Loyer'));
  r = await owner('PUT', `${B}/map`, { map: [{ prefix: '622', category: 'Locaux' }] });
  check('correspondance personnalisée', r.status === 200);
  r = await owner('GET', `${B}/annual?year=${thisYear}`);
  check('catégorie « Locaux » issue de la correspondance', r.json.lines.some((l) => l.category === 'Locaux' && l.ledger[1] === 60000), r.json.lines.map((l) => l.category));
  await owner('PUT', `${B}/map`, { map: [] });
  r = await owner('PUT', `${B}/map`, { map: [{ prefix: '401', category: 'x' }] });
  check('préfixe hors classes 6/7 refusé', r.status === 400);

  // Engagements : commande validée + dette fournisseur
  r = await mgr('POST', `${S}/suppliers`, { name: 'Fournisseur Engagé' });
  const sup = r.json.id;
  r = await mgr('POST', `${S}/items`, { name: 'Riz', unit: 'sac', quantity: 0 });
  const item = r.json.id;
  await mem('POST', `${S}/orders`, { itemId: item, supplierId: sup, quantity: 10, unitPrice: 5000, promisedDate: day(12) });
  r = await mgr('GET', `${S}/orders`);
  const po = r.json.orders[0].id;
  r = await owner('GET', `${B}/commitments`);
  check('commande en attente de validation : comptée à part', r.json.pendingOrdersAmount === 50000 && r.json.ordersAmount === 0, r.json);
  await mgr('PUT', `${S}/orders/${po}/status`, { status: 'ordered' });
  r = await owner('POST', `${AC}/payables`, { supplierName: 'Imprimerie', number: 'FF-1', amount: 30000, billDate: day(-40), dueDate: day(-10), expenseAccount: '605' });
  check('dette échue créée', r.status === 201, r.json);
  r = await owner('GET', `${B}/commitments`);
  check('engagements : commande validée 50 000 + dette 30 000 = 80 000', r.json.ordersAmount === 50000 && r.json.billsAmount === 30000 && r.json.total === 80000, r.json);

  // Trésorerie à 3 mois
  await owner('POST', `${AC}/entries`, { journal: 'BQ', date: day(-1), label: 'Fonds de départ', piece: '', lines: [{ account: '521', debit: 100000 }, { account: '101', credit: 100000 }] });
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, issued: day(-3), due: day(0), lines: [{ label: 'Futur', quantity: 1, price: 40000 }] });
  await mgr('PUT', `${C}/documents/${r.json.id}`, { status: 'sent' });
  await owner('POST', `${O}/fiscal/obligations`, { title: 'Acompte test', kind: 'acompte', dueDate: day(20), amount: 25000 });
  await owner('POST', `${O}/fiscal/obligations`, { title: 'Déclaration sociale test', kind: 'social', dueDate: day(20), amount: 99999 });
  r = await owner('GET', `${B}/cashflow`);
  const cf = r.json;
  check('trésorerie : 3 mois, départ = solde comptable de trésorerie', cf.months.length === 3 && cf.openingKnown && cf.opening === 99250, [cf.opening, cf.months.length]);
  const inflows = cf.months.flatMap((m) => m.inflowItems); const outflows = cf.months.flatMap((m) => m.outflowItems);
  check('encaissements attendus : facture à 40 000', inflows.some((i) => /Futur/.test(i.label) || i.amount === 40000), inflows);
  check('décaissements : dette fournisseur échue (mois courant), commande, échéance fiscale', outflows.some((o) => o.kind === 'bill' && o.amount === 30000 && o.overdue) && outflows.some((o) => o.kind === 'order' && o.amount === 50000) && outflows.some((o) => o.kind === 'tax' && o.amount === 25000), outflows.map((o) => [o.kind, o.amount]));
  check('déclaration sociale exclue (déjà dans la paie)', !outflows.some((o) => o.amount === 99999));
  check('chaque mois : solde de clôture = ouverture + net', cf.months.every((m) => m.closing === m.opening + m.net));
  check('hypothèses et avertissement fournis', cf.assumptions.length >= 3 && /conseil financier/.test(cf.notice));
  r = await owner('GET', `${B}/cashflow?months=1&collectRate=50`);
  check('taux d\'encaissement 50 % appliqué', r.json.months.length === 1 && r.json.months[0].inflowItems.some((i) => i.amount === 20000), r.json.months[0].inflowItems);
  // Paie estimée
  r = await owner('POST', `${O}/hr/employees`, { name: 'Salarié Prévision', salary: 200000 });
  r = await owner('GET', `${B}/cashflow`);
  check('paie estimée d\'après les salaires', r.json.months[0].outflowItems.some((o) => o.kind === 'payroll' && o.estimated && o.amount === 200000), r.json.months[0].outflowItems);
  check('alerte si la trésorerie devient négative', r.json.alert === null || typeof r.json.alert.month === 'string');

  // Validation par seuil
  r = await mgr('PUT', `${B}/settings`, { approvalThreshold: 100000 });
  check('seuil : réservé aux administrateurs', r.status === 403);
  r = await owner('PUT', `${B}/settings`, { approvalThreshold: 100000 });
  check('seuil de 100 000 fixé', r.status === 200 && r.json.approvalThreshold === 100000);
  r = await mgr('POST', `${B}/entries`, { kind: 'expense', category: 'Équipement', amount: 99999, label: 'Sous le seuil' });
  check('dépense sous le seuil : inscrite directement', r.status === 201, r.json);
  r = await mgr('POST', `${B}/entries`, { kind: 'expense', category: 'Équipement', amount: 250000, label: 'Groupe électrogène' });
  check('dépense au-dessus du seuil : soumise à validation (202)', r.status === 202 && r.json.pending === true, r.json);
  const rid = r.json.requestId;
  r = await mgr('GET', `${B}?month=${month(0)}`);
  check('rien n\'est inscrit tant que non validée', !r.json.entries.some((e) => e.amount === 250000));
  r = await mgr('POST', `${B}/requests/${rid}/decide`, { decision: 'approved' });
  check('le demandeur ne valide pas', r.status === 403);
  r = await owner('GET', `${B}/requests?status=pending`);
  check('l\'administrateur voit la demande en attente', r.json.requests.length === 1 && r.json.requests[0].requester === 'Marc', r.json);
  r = await mgr('GET', `${B}/requests`);
  check('le responsable voit sa propre demande', r.json.requests.length === 1);
  r = await owner('POST', `${B}/requests/${rid}/decide`, { decision: 'rejected' });
  check('refus : motif obligatoire', r.status === 400);
  r = await owner('POST', `${B}/requests/${rid}/decide`, { decision: 'approved', note: 'OK' });
  check('acceptée : la ligne est inscrite', r.status === 200 && r.json.budgetEntryId, r.json);
  r = await owner('POST', `${B}/requests/${rid}/decide`, { decision: 'approved' });
  check('une demande ne se traite qu\'une fois', r.status === 400);
  r = await mgr('GET', `${B}?month=${month(0)}`);
  check('après validation : 250 000 au budget', r.json.entries.some((e) => e.amount === 250000));
  const ent = r.json.entries.find((e) => e.amount === 99999);
  r = await mgr('PUT', `${B}/entries/${ent.id}`, { amount: 300000 });
  check('on ne contourne pas le seuil en modifiant la ligne', r.status === 403, r.json);
  r = await owner('POST', `${B}/entries`, { kind: 'expense', category: 'Équipement', amount: 500000 });
  check('un administrateur n\'est pas bloqué', r.status === 201);
  r = await owner('PUT', `${B}/settings`, { approvalThreshold: 0 });
  r = await mgr('POST', `${B}/entries`, { kind: 'expense', category: 'Équipement', amount: 900000 });
  check('seuil à 0 : validation désactivée (comportement d\'origine)', r.status === 201);
  r = await other('GET', `/api/ws/orgs/${org}/budget/annual`);
  check('autre organisation : aucun accès', r.status === 404);
  // Budget initialisé depuis les limites mensuelles
  await owner('PUT', `${B}/plans`, { plans: [{ category: 'Transport', monthlyLimit: 20000 }] });
  r = await owner('POST', `${B}/annual/init`, { year: String(Number(thisYear) + 1) });
  check('initialisation depuis les limites mensuelles', r.status === 201 && r.json.lines === 1, r.json);
  r = await owner('POST', `${B}/annual/init`, { year: String(Number(thisYear) + 1) });
  check('pas d\'écrasement d\'un budget existant', r.status === 409);
  void dbx;
});
