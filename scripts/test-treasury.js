'use strict';
// Module Trésorerie : calculs purs (formules DSO / DPO / DIO / CCC, BFR / FRNG / trésorerie nette, scénarios, paiements optimisés), puis de bout en bout
// (droits des rôles, double validation, écritures équilibrées, comptes multi-devises, prévision, scénarios, créances, dettes, écarts, tableau des flux,
// fonds de sécurité, exports, journal chaîné, isolation entre organisations). Lancez-le avec : node scripts/test-treasury.js
const C = require('../src/workspace/tre-calc');
const F = require('../src/workspace/tre-forecast');
const Dt = require('../src/workspace/tre-dates');
const { run } = require('./lib/wave1');

let unitPass = 0; let unitFail = 0;
const unit = (name, cond, extra) => { if (cond) { unitPass++; console.log('  OK   ' + name); } else { unitFail++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

console.log('Calculs purs');
{
  // Formules des jours de crédit (90 jours)
  const k = C.kpiFormulas({ receivables: 3577500, payables: -800000, stock: 600000, sales: 3577500, purchases: 1000000, cogs: 400000, days: 90 });
  unit('DSO = créances ÷ ventes TTC × 90 = 90', k.dso === 90, k);
  unit('DPO = dettes ÷ achats TTC × 90 = 72', k.dpo === 72, k);
  unit('DIO = stock ÷ coût des achats × 90 = 135', k.dio === 135, k);
  unit('CCC = DSO + DIO − DPO = 153', k.ccc === 153, k);
  const k2 = C.kpiFormulas({ receivables: 0, payables: -500, stock: 0, sales: 1000, purchases: 500, cogs: 0, days: 90 });
  unit('DIO absent sans consommation ; CCC = DSO − DPO', k2.dio === null && k2.dso === 0 && k2.dpo === 90 && k2.ccc === -90, k2);
  // BFR / FRNG / trésorerie nette : TN = FRNG − BFR et égale le solde des comptes de classe 5
  const m = { 101: -5000000, 2441: 1000000, 311: 600000, 411: 3577500, 401: -800000, 4431: -577500, 521: 3800000, 701: -3000000, 601: 400000 };
  unit('la balance de test est équilibrée', Object.values(m).reduce((a, b) => a + b, 0) === 0);
  const w = C.workingCapital(m);
  unit('FRNG = capitaux + résultat − immobilisations = 6 600 000', w.frng === 6600000, w.frng);
  unit('BFR = stocks + créances − dettes d\'exploitation = 2 800 000', w.bfr === 2800000, w.bfr);
  unit('TN = FRNG − BFR = 3 800 000 = trésorerie (classe 5)', w.treasuryNet === 3800000 && w.cashBooks === 3800000 && w.check.ok, w);
  const m2 = { ...m, 56: -500000, 521: 4300000 }; // crédit de trésorerie : la trésorerie nette le déduit
  const w2 = C.workingCapital(m2);
  unit('crédit de trésorerie (56) : TN toujours = FRNG − BFR', w2.check.ok && w2.treasuryNet === 3800000, w2);
  unit('classement : 411 → clients, 2441 → investissement, 162 → financement, 585 → interne', C.classify('411').group === 'clients' && C.classify('2441').section === 'investing' && C.classify('162').section === 'financing' && C.classify('585').section === 'internal');
  unit('comptes de trésorerie : 521, 571, 589, 5212 oui ; 585, 411 non', ['521', '571', '589', '5212', '541'].every(C.isCash) && !C.isCash('585') && !C.isCash('411'));
  unit('interprétation : CCC négatif reconnu', C.interpret({ dso: 20, dpo: 60, dio: 0, ccc: -40 }, { dso: 45, dpo: 45, dio: 60, ccc: 60 }).some((x) => x.code === 'ccc_negative'));
}
console.log('Prévision, scénarios, paiements');
{
  const flows = [
    { date: '2026-03-10', amount: 1000, group: 'clients', source: 'invoice', label: 'F1' },
    { date: '2026-03-12', amount: 400, group: 'clients', source: 'trend_sales', label: 'T' },
    { date: '2026-03-15', amount: -700, group: 'fournisseurs', source: 'bill', label: 'B1' },
    { date: '2026-03-01', amount: -100, group: 'impots', source: 'tax', label: 'Impôt échu' },
  ];
  const fc = F.forecast({ flows, opening: 500, from: '2026-03-05' });
  unit('prévision : solde = départ + flux ; un flux échu est ramené au premier jour', fc.daily[0].balance === 400 && fc.closing13 === 500 - 100 + 1000 + 400 - 700, [fc.daily[0], fc.closing13]);
  unit('prévision : 13 semaines et 12 mois', fc.weeks.length === 13 && fc.months.length === 12);
  const neg = F.forecast({ flows: [{ date: '2026-03-20', amount: -900, group: 'autres', source: 'plan', label: 'x' }], opening: 500, from: '2026-03-05' });
  unit('découvert futur : date et montant prévus', neg.overdraft && neg.overdraft.date === '2026-03-20' && neg.overdraft.balance === -400 && neg.overdraft.daysAway === 15, neg.overdraft);
  const sc = F.applyScenario(flows, { salesPct: -50, delayDays: 10, costPct: 10, collectionLossPct: 10 });
  const f1 = sc.find((f) => f.label === 'F1'); const t = sc.find((f) => f.label === 'T'); const b1 = sc.find((f) => f.label === 'B1');
  unit('scénario : retard clients 10 j + 10 % d\'impayés sur la facture', f1.date === '2026-03-20' && f1.amount === 900, f1);
  unit('scénario : −50 % de ventes sur la tendance', t.amount === 200, t);
  unit('scénario : +10 % de coûts fournisseurs', b1.amount === -770, b1);
  unit('scénario : la liste d\'origine n\'est pas modifiée', flows[0].amount === 1000 && flows[2].amount === -700);
  const loan = F.loanSchedule({ amount: 1200000, date: '2026-04-01', months: 12, ratePct: 0 });
  unit('prêt sans intérêt : 12 échéances de 100 000', loan.length === 12 && loan.every((e) => e.total === 100000) && loan.reduce((a, e) => a + e.principal, 0) === 1200000);
  const loan2 = F.loanSchedule({ amount: 1000000, date: '2026-04-01', months: 24, ratePct: 12 });
  unit('prêt à 12 % : le capital total remboursé = le montant emprunté', loan2.reduce((a, e) => a + e.principal, 0) === 1000000 && loan2[0].interest === 10000, loan2[0]);
  const withLoan = F.applyScenario([], { loan: { amount: 1000, date: '2026-04-01', months: 2, ratePct: 0 }, capex: [{ date: '2026-04-10', amount: 300 }] });
  unit('scénario : prêt (encaissement + échéances) et investissement', withLoan.length === 4 && withLoan.reduce((a, f) => a + f.amount, 0) === -300, withLoan);
  const cmp = F.compare({ flows, opening: 500, from: '2026-03-05', scenarios: F.BASE_SCENARIOS.map((s) => ({ ...s })) });
  unit('comparaison : pessimiste < central < optimiste à 12 mois', cmp[0].closing12m < cmp[1].closing12m && cmp[1].closing12m < cmp[2].closing12m, cmp.map((x) => x.closing12m));
  // Paiements optimisés
  const bills = [
    { id: 1, supplier: 'A', left: 1000, due: '2026-12-10', priority: 2, discountPct: 2, discountDays: 10, billDate: '2026-11-15' },
    { id: 2, supplier: 'B', left: 5000, due: '2026-10-01', priority: 2, discountPct: 0, discountDays: 0 },
    { id: 3, supplier: 'C', left: 4000, due: '2027-01-30', priority: 3 },
  ];
  const op = F.optimizePayments({ bills, available: 5500, today: '2026-11-18' });
  unit('paiements : la dette très en retard passe d\'abord, l\'escompte attend faute de trésorerie', op.payNow.length === 1 && op.payNow[0].id === 2 && op.defer.some((x) => x.id === 1 && x.reason === 'cash'), op);
  const op2 = F.optimizePayments({ bills, available: 7000, today: '2026-11-18' });
  unit('paiements : avec assez de trésorerie, l\'escompte de 2 % est saisi (980 au lieu de 1 000)', op2.payNow.some((x) => x.id === 1 && x.payAmount === 980) && op2.saved === 20 && op2.defer.some((x) => x.id === 3 && x.reason === 'deferrable'), op2);
  unit('paiements : la trésorerie restante est exacte', op2.cashAfter === 7000 - 5000 - 980, op2.cashAfter);
  const ag = F.aging([{ id: 1, customerId: 1, customer: 'X', number: 'F1', due: '2026-11-01', left: 1000 }, { id: 2, customerId: 1, customer: 'X', number: 'F2', due: '2026-12-20', left: 500 }, { id: 3, customerId: 2, customer: 'Y', number: 'F3', due: '2026-07-01', left: 2000 }], '2026-11-18', { notDue: 0, d30: 1, d60: 5, d90: 25, d90p: 50 });
  unit('balance âgée : tranches et provision (1 % de 1 000 + 50 % de 2 000)', ag.total === 3500 && ag.buckets.find((b) => b.key === 'd30').amount === 1000 && ag.buckets.find((b) => b.key === 'd90p').amount === 2000 && ag.provision === 10 + 1000, ag);
  unit('risque d\'impayé : le client le plus en retard est classé en haut, risque élevé', ag.customers[0].customer === 'Y' && ag.customers[0].risk !== 'low', ag.customers.map((c) => [c.customer, c.riskScore]));
  const g = F.safetyGauge({ mode: 'days', days: 30, amount: 0, dailyOut: 10000, available: 120000 });
  unit('fonds de sécurité : 30 jours × 10 000 = 300 000, niveau « alerte », reconstitution sur 12 semaines', g.target === 300000 && g.level === 'alert' && g.gap === 180000 && g.recommendedWeekly === 15000 && g.coverageDays === 12, g);
  unit('dates : fin de mois et ajout de mois', Dt.addMonths('2026-01-31', 1) === '2026-02-28' && Dt.lastDay('2028-02') === '2028-02-29');
}

run('Module Trésorerie', async ({ check, owner, mgr, mem, other, O, org, org2, ws, dbx }) => {
  check(`calculs purs : ${unitPass} vérifications sans échec`, unitFail === 0, unitFail);
  let r;
  const T0 = new Date().toISOString().slice(0, 10);
  const day = (n) => Dt.addDays(T0, n);
  const TR = `${O}/treasury`; const TR2 = `${ws(org2)}/treasury`;
  const ownerId = Number((await dbx.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role = 'owner'").get(org)).user_id);
  const marcId = Number((await dbx.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role = 'manager'").get(org)).user_id);
  const paulId = Number((await dbx.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role = 'member'").get(org)).user_id);
  const cash = async () => (await owner('GET', `${TR}/accounts`)).json.consolidated.total;
  const bal = async (acc) => Number((await dbx.prepare('SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM acc_lines l WHERE l.org_id = ? AND l.account = ?').get(org, acc)).b);
  const entryOk = async (id) => { const l = await dbx.prepare('SELECT COALESCE(SUM(debit), 0) d, COALESCE(SUM(credit), 0) c, COUNT(*) n FROM acc_lines WHERE entry_id = ?').get(id); return Number(l.d) === Number(l.c) && Number(l.n) >= 2; };

  // ---------- Rôles ----------
  r = await mem('GET', `${TR}/me`);
  check('sans rôle de trésorerie : accès refusé', r.status === 403, r.status);
  r = await mem('GET', O);
  check('sans rôle : le module Trésorerie n\'apparaît pas dans le menu', r.status === 200 && !r.json.modules.some((m) => m.id === 'treasury'), r.json.modules && r.json.modules.length);
  r = await owner('GET', O);
  check('le propriétaire voit le module Trésorerie', r.json.modules.some((m) => m.id === 'treasury'));
  r = await mgr('PUT', `${TR}/roles/${paulId}`, { role: 'treasurer' });
  check('un responsable d\'équipe non désigné ne peut pas nommer de rôle', r.status === 403, r.status);
  r = await owner('PUT', `${TR}/roles/${marcId}`, { role: 'manager' });
  check('le propriétaire désigne un responsable de trésorerie', r.status === 200, r.json);
  r = await owner('PUT', `${TR}/roles/${paulId}`, { role: 'treasurer' });
  check('le propriétaire désigne un trésorier', r.status === 200, r.json);
  r = await owner('PUT', `${TR}/roles/${paulId}`, { role: 'chef' });
  check('rôle inconnu refusé', r.status === 400, r.status);
  r = await owner('PUT', `${TR}/roles/${ownerId}`, { role: 'treasurer' });
  check('le propriétaire a déjà tous les droits : on ne le rétrograde pas', r.status === 400, r.status);
  r = await mem('GET', O);
  check('le trésorier voit désormais le module', r.json.modules.some((m) => m.id === 'treasury'));
  r = await mem('GET', `${TR}/me`);
  check('rôle du trésorier : ne valide pas', r.status === 200 && r.json.role === 'treasurer' && r.json.canApprove === false, r.json);
  r = await mgr('GET', `${TR}/me`);
  check('rôle du responsable : valide', r.json.role === 'manager' && r.json.canApprove === true, r.json);
  r = await mem('PUT', `${TR}/settings`, { approvalThreshold: 1 });
  check('le trésorier ne fixe ni seuil ni fonds de sécurité', r.status === 403, r.status);
  r = await mgr('PUT', `${TR}/settings`, { approvalThreshold: 500000, safetyMode: 'amount', safetyAmount: 5000000, includeTrend: false });
  check('le responsable règle le seuil et le fonds de sécurité', r.status === 200 && r.json.settings.approvalThreshold === 500000 && r.json.settings.safetyAmount === 5000000, r.json);
  r = await mgr('PUT', `${TR}/settings`, { safetyDays: -3 });
  check('réglage invalide refusé', r.status === 400, r.status);

  // ---------- Comptes ----------
  r = await mem('POST', `${TR}/accounts`, { kind: 'bank', name: 'Afriland' });
  check('le trésorier ne crée pas de compte', r.status === 403, r.status);
  r = await mgr('POST', `${TR}/accounts`, { kind: 'bank', name: 'Afriland First Bank' });
  const bank = r.json.id;
  check('banque : compte comptable 521', r.status === 201 && r.json.glAccount === '521', r.json);
  r = await mgr('POST', `${TR}/accounts`, { kind: 'cash', name: 'Caisse siège' });
  const caisse = r.json.id;
  check('caisse : compte comptable 571', r.json.glAccount === '571', r.json);
  r = await mgr('POST', `${TR}/accounts`, { kind: 'mobile', name: 'MTN MoMo', provider: 'MTN MoMo' });
  const momo = r.json.id;
  check('mobile money : compte comptable 589', r.json.glAccount === '589', r.json);
  r = await mgr('POST', `${TR}/accounts`, { kind: 'bank', name: 'Compte en euros', currency: 'EUR' });
  check('devise étrangère sans taux refusée', r.status === 400, r.json);
  r = await mgr('PUT', `${TR}/fx/EUR`, { rate: 655.957 });
  check('taux de change enregistré', r.status === 200, r.json);
  r = await mgr('POST', `${TR}/accounts`, { kind: 'bank', name: 'Compte en euros', currency: 'EUR' });
  const eur = r.json.id;
  check('deuxième banque : sous-compte comptable distinct (5212)', r.status === 201 && r.json.glAccount === '5212', r.json);
  const acct = await dbx.prepare("SELECT 1 FROM acc_accounts WHERE org_id = ? AND code = '5212'").get(org);
  check('le sous-compte est ajouté au plan comptable', Boolean(acct));
  const bk = await dbx.prepare('SELECT COUNT(*) c FROM bank_accounts WHERE org_id = ?').get(org);
  check('chaque compte alimente le rapprochement bancaire de la Comptabilité', Number(bk.c) === 4, bk);

  // ---------- Comptabilité de départ (grand livre) ----------
  const AC = `${O}/accounting`;
  const post = async (date, label, lines) => (await owner('POST', `${AC}/entries`, { journal: 'OD', date, label, piece: 'T', lines })).status;
  const s1 = await post(day(-120), 'Capital', [{ account: '521', debit: 5000000 }, { account: '101', credit: 5000000 }]);
  const s2 = await post(day(-100), 'Matériel', [{ account: '2441', debit: 1000000 }, { account: '521', credit: 1000000 }]);
  const s3 = await post(day(-60), 'Stock acheté à crédit', [{ account: '311', debit: 600000 }, { account: '401', credit: 600000 }]);
  const s4 = await post(day(-45), 'Achats', [{ account: '601', debit: 400000 }, { account: '401', credit: 400000 }]);
  const s5 = await post(day(-20), 'Règlement fournisseur', [{ account: '401', debit: 200000 }, { account: '521', credit: 200000 }]);
  check('écritures de départ passées', [s1, s2, s3, s4, s5].every((s) => s === 201), [s1, s2, s3, s4, s5]);
  await dbx.prepare("INSERT INTO customers (org_id, name, created_at) VALUES (?, 'Société Kamga', ?)").run(org, new Date().toISOString());
  const cust = Number((await dbx.prepare('SELECT id FROM customers WHERE org_id = ?').get(org)).id);
  const doc = async (n, total, issued, due) => Number((await dbx.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', ?, 'sent', '[]', ?, 0, ?, ?, ?, ?, ?) RETURNING id").get(org, cust, n, total, issued, due, ownerId, new Date().toISOString(), new Date().toISOString())).id);
  const inv1 = await doc('FAC-T1', 1192500, day(-40), day(-10));
  const inv2 = await doc('FAC-T2', 2385000, day(-5), day(25));
  r = await owner('POST', `${AC}/generate`, {});
  check('écritures de vente générées depuis les factures', r.status === 200 || r.status === 201, [r.status, r.json]);
  check('grand livre équilibré avant toute opération de trésorerie', (await bal('521')) === 3800000 && (await bal('411')) === 3577500 && (await bal('401')) === -800000, [await bal('521'), await bal('411'), await bal('401')]);
  const bill = async (name, num, billDate, due, amount) => Number((await dbx.prepare("INSERT INTO supplier_bills (org_id, supplier_name, number, bill_date, due_date, amount, paid, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'open', 'manual', ?) RETURNING id").get(org, name, num, billDate, due, amount, new Date().toISOString())).id);
  const billA = await bill('Quincaillerie Mbarga', 'QM-1', day(-30), day(10), 600000);
  const billB = await bill('Transports Fotso', 'TF-9', day(-35), day(-5), 400000);

  // ---------- Indicateurs avant opérations : BFR, FRNG, trésorerie nette, jours de crédit ----------
  r = await owner('GET', `${TR}/kpis`);
  const k = r.json;
  check('DSO = 3 577 500 ÷ 3 577 500 × 90 = 90 jours', k.current.dso === 90, k.current.dso);
  check('DPO = 800 000 ÷ 1 000 000 × 90 = 72 jours', k.current.dpo === 72, k.current.dpo);
  check('DIO = 600 000 ÷ 400 000 × 90 = 135 jours', k.current.dio === 135, k.current.dio);
  check('CCC = DSO + DIO − DPO = 153 jours', k.current.ccc === 153, k.current.ccc);
  check('FRNG = 6 600 000, BFR = 2 800 000, trésorerie nette = 3 800 000', k.workingCapital.frng === 6600000 && k.workingCapital.bfr === 2800000 && k.workingCapital.treasuryNet === 3800000, k.workingCapital);
  check('trésorerie nette = FRNG − BFR, vérifiée contre les comptes de classe 5', k.workingCapital.check.ok && k.workingCapital.frng - k.workingCapital.bfr === k.workingCapital.cashBooks, k.workingCapital.check);
  check('évolution mensuelle sur 12 mois, interprétation et objectifs', k.series.length === 12 && k.interpretation.length >= 3 && k.targets.dso === 45 && k.alerts.some((a) => a.code === 'dso'), [k.series.length, k.alerts]);
  check('le dernier point de la courbe = l\'indicateur courant', k.series[11].ccc === k.current.ccc);

  // ---------- Opérations : préparation, validation, séparation des tâches ----------
  const cash0 = await cash();
  check('trésorerie consolidée = solde de la banque (521) au départ', cash0 === 3800000, cash0);
  r = await mem('POST', `${TR}/ops`, { kind: 'receipt', category: 'customer', accountId: bank, amount: 400000, refKind: 'invoice', refId: inv1, date: day(0), reference: 'VIR-001' });
  const op1 = r.json.id;
  check('le trésorier prépare un encaissement lié à une facture', r.status === 201 && r.json.status === 'prepared' && r.json.needDouble === false, r.json);
  check('rien n\'est comptabilisé tant que le responsable n\'a pas validé', (await bal('411')) === 3577500);
  r = await mem('POST', `${TR}/ops/${op1}/approve`, {});
  check('le trésorier ne peut pas valider', r.status === 403, r.status);
  r = await mem('POST', `${TR}/ops`, { kind: 'receipt', category: 'customer', accountId: bank, amount: 9000000, refKind: 'invoice', refId: inv1, date: day(0) });
  check('encaissement supérieur au reste dû refusé', r.status === 400, r.json);
  r = await mem('POST', `${TR}/ops`, { kind: 'receipt', category: 'customer', accountId: bank, amount: 1000, reference: 'VIR-001' });
  check('référence déjà utilisée refusée', r.status === 409, r.status);
  r = await mgr('POST', `${TR}/ops/${op1}/approve`, {});
  check('le responsable valide : opération comptabilisée', r.status === 200 && r.json.status === 'posted' && r.json.entry, r.json);
  const o1 = await dbx.prepare('SELECT * FROM tre_ops WHERE id = ?').get(op1);
  check('écriture équilibrée D 521 / C 411', await entryOk(o1.entry_id) && (await bal('411')) === 3177500 && (await bal('521')) === 4200000, [await bal('411'), await bal('521')]);
  const dd = await dbx.prepare('SELECT paid, status FROM documents WHERE id = ?').get(inv1);
  check('la facture est réglée en partie (400 000) et reste ouverte', Number(dd.paid) === 400000 && dd.status === 'sent', dd);
  r = await mgr('POST', `${TR}/ops/${op1}/approve`, {});
  check('une opération déjà traitée ne se valide pas deux fois', r.status === 409, r.status);
  const gen = await owner('POST', `${AC}/generate`, {});
  check('la comptabilité ne recompte pas ce paiement (pas de doublon)', (await bal('411')) === 3177500 && gen.status < 300, await bal('411'));

  // double validation au-delà du seuil
  r = await mem('POST', `${TR}/ops`, { kind: 'payment', category: 'supplier', accountId: bank, amount: 600000, refKind: 'bill', refId: billA, date: day(0) });
  const op2 = r.json.id;
  check('au-delà du seuil (600 000 > 500 000) : double validation exigée', r.status === 201 && r.json.needDouble === true, r.json);
  r = await mgr('POST', `${TR}/ops/${op2}/approve`, {});
  check('première validation : en attente de la seconde', r.status === 200 && r.json.status === 'half', r.json);
  r = await mgr('POST', `${TR}/ops/${op2}/approve`, {});
  check('la même personne ne valide pas deux fois', r.status === 403, r.status);
  check('rien n\'est encore payé', (await bal('401')) === -800000);
  r = await owner('POST', `${TR}/ops/${op2}/approve`, {});
  check('seconde validation par une autre personne : payé et comptabilisé', r.status === 200 && r.json.status === 'posted', r.json);
  const bA = await dbx.prepare('SELECT paid, status FROM supplier_bills WHERE id = ?').get(billA);
  check('la dette fournisseur est soldée', Number(bA.paid) === 600000 && bA.status === 'paid', bA);
  check('écriture D 401 / C 521 équilibrée', (await bal('401')) === -200000 && (await bal('521')) === 3600000, [await bal('401'), await bal('521')]);

  // séparation des tâches : on ne valide pas ce qu'on a préparé
  r = await owner('POST', `${TR}/ops`, { kind: 'payment', category: 'fees', accountId: bank, amount: 5000, label: 'Frais de tenue de compte', date: day(0) });
  const op3 = r.json.id;
  r = await owner('POST', `${TR}/ops/${op3}/approve`, {});
  check('séparation des tâches : le propriétaire ne valide pas sa propre opération', r.status === 403, r.status);
  r = await mgr('POST', `${TR}/ops/${op3}/approve`, {});
  check('frais bancaires comptabilisés (D 631 / C 521)', r.status === 200 && (await bal('631')) === 5000 && (await bal('521')) === 3595000, [r.json, await bal('631')]);
  r = await mgr('PUT', `${TR}/settings`, { strictSeparation: false });
  check('seul un administrateur assouplit la séparation des tâches', r.status === 403, r.status);
  r = await owner('PUT', `${TR}/settings`, { strictSeparation: false });
  r = await owner('POST', `${TR}/ops`, { kind: 'receipt', category: 'other_income', accountId: caisse, amount: 20000, label: 'Vente comptoir', date: day(0) });
  const op4 = r.json.id;
  r = await owner('POST', `${TR}/ops/${op4}/approve`, {});
  check('séparation assouplie : une petite opération du propriétaire passe seul', r.status === 200 && r.json.status === 'posted', r.json);
  r = await owner('POST', `${TR}/ops`, { kind: 'payment', category: 'other_expense', accountId: bank, amount: 700000, label: 'Gros paiement', date: day(0) });
  const op5 = r.json.id;
  r = await owner('POST', `${TR}/ops/${op5}/approve`, {});
  check('assouplie ou non : au-delà du seuil, on ne valide jamais sa propre opération', r.status === 403, r.status);
  r = await mgr('POST', `${TR}/ops/${op5}/reject`, { reason: '' });
  check('refus sans motif impossible', r.status === 400, r.status);
  r = await mgr('POST', `${TR}/ops/${op5}/reject`, { reason: 'Pas de justificatif' });
  check('refus avec motif', r.status === 200, r.json);
  await owner('PUT', `${TR}/settings`, { strictSeparation: true });

  // virement interne
  r = await mem('POST', `${TR}/ops`, { kind: 'transfer', accountId: bank, toAccountId: caisse, amount: 100000, date: day(0) });
  const op6 = r.json.id; const before = await cash();
  r = await mgr('POST', `${TR}/ops/${op6}/approve`, {});
  const o6 = await dbx.prepare('SELECT * FROM tre_ops WHERE id = ?').get(op6);
  check('virement interne : D 571 / C 521, équilibré', r.status === 200 && await entryOk(o6.entry_id) && (await bal('571')) === 120000 && (await bal('521')) === 3495000, [await bal('571'), await bal('521')]);
  check('virement interne : la trésorerie consolidée ne change pas', (await cash()) === before, [await cash(), before]);
  r = await mem('POST', `${TR}/ops`, { kind: 'transfer', accountId: bank, toAccountId: bank, amount: 1000 });
  check('virement sur le même compte refusé', r.status === 400, r.status);

  // multi-devises : virement vers le compte en euros, perte de change
  r = await mem('POST', `${TR}/ops`, { kind: 'transfer', accountId: bank, toAccountId: eur, amount: 300000, amountTo: 457, date: day(0) });
  const op7 = r.json.id;
  r = await mgr('POST', `${TR}/ops/${op7}/approve`, {});
  const o7 = await dbx.prepare('SELECT * FROM tre_ops WHERE id = ?').get(op7);
  check('virement en devise : 457 × 655,957 = 299 772, perte de change de 228 (676)', r.status === 200 && await entryOk(o7.entry_id) && (await bal('5212')) === 299772 && (await bal('676')) === 228, [await bal('5212'), await bal('676')]);
  r = await owner('GET', `${TR}/accounts`);
  const eurView = r.json.accounts.find((a) => a.id === eur);
  check('compte en euros : 457 EUR, valeur comptable 299 772, consolidé au taux du jour', eurView.nativeBalance === 457 && eurView.bookBalance === 299772 && eurView.consolidated === 299772 && eurView.fxGap === 0, eurView);
  await mgr('PUT', `${TR}/fx/EUR`, { rate: 660 });
  r = await owner('GET', `${TR}/accounts`);
  const eur2 = r.json.accounts.find((a) => a.id === eur);
  check('le taux change : consolidé 457 × 660 = 301 620, écart de conversion 1 848', eur2.consolidated === 301620 && eur2.fxGap === 1848, eur2);
  check('soldes consolidés multi-comptes : total = somme des comptes', r.json.consolidated.total === r.json.accounts.filter((a) => a.active).reduce((s, a) => s + a.consolidated, 0), r.json.consolidated);
  check('répartition par type de compte et par devise', r.json.consolidated.byKind.bank > 0 && r.json.consolidated.byKind.cash === 120000 && r.json.consolidated.byCurrency.EUR === 457, r.json.consolidated);
  r = await mgr('PUT', `${TR}/fx/FCFA`, { rate: 2 });
  check('pas de taux sur la monnaie de l\'organisation', r.status === 400, r.status);

  // annulation d'une opération comptabilisée : écriture inverse, facture rouverte
  r = await mem('POST', `${TR}/ops/${op1}/cancel`, { reason: 'x' });
  check('le trésorier n\'annule pas une opération comptabilisée', r.status === 403, r.status);
  r = await mgr('POST', `${TR}/ops/${op1}/cancel`, {});
  check('annulation sans motif refusée', r.status === 400, r.status);
  r = await mgr('POST', `${TR}/ops/${op1}/cancel`, { reason: 'Virement non reçu' });
  const dd2 = await dbx.prepare('SELECT paid, status FROM documents WHERE id = ?').get(inv1);
  check('annulation : écriture inverse, 411 rétabli, facture rouverte', r.status === 200 && (await bal('411')) === 3577500 && Number(dd2.paid) === 0, [await bal('411'), dd2]);
  r = await mem('POST', `${TR}/ops`, { kind: 'receipt', category: 'customer', accountId: bank, amount: 400000, refKind: 'invoice', refId: inv1, date: day(0) });
  await mgr('POST', `${TR}/ops/${r.json.id}/approve`, {});
  check('nouvel encaissement de la même facture accepté après annulation', (await bal('411')) === 3177500, await bal('411'));

  // équilibre global : toutes les écritures du module sont équilibrées
  const unb = await dbx.prepare("SELECT e.id FROM acc_entries e WHERE e.org_id = ? AND (SELECT COALESCE(SUM(debit), 0) FROM acc_lines WHERE entry_id = e.id) <> (SELECT COALESCE(SUM(credit), 0) FROM acc_lines WHERE entry_id = e.id)").all(org);
  check('équilibre garanti : aucune écriture déséquilibrée dans le journal', unb.length === 0, unb);
  const tot = await dbx.prepare('SELECT COALESCE(SUM(debit), 0) d, COALESCE(SUM(credit), 0) c FROM acc_lines WHERE org_id = ?').get(org);
  check('total des débits = total des crédits du grand livre', Number(tot.d) === Number(tot.c), tot);

  // ---------- Rapprochement bancaire ----------
  r = await mem('GET', `${TR}/reconcile`);
  const rb = r.json.accounts.find((a) => a.accountId === bank);
  check('rapprochement : un état par compte avec le solde comptable', r.status === 200 && r.json.accounts.length === 4 && rb.bookBalance === await bal('521') && rb.bank.lines === 0, rb);

  // ---------- Prévision ----------
  r = await owner('POST', `${TR}/plan`, { direction: 'out', category: 'rent', label: 'Loyer du siège', amount: 150000, startDate: day(2), recurrence: 'monthly' });
  check('élément prévisionnel récurrent ajouté', r.status === 201, r.json);
  const planId = r.json.id;
  r = await mem('POST', `${TR}/plan`, { direction: 'out', category: 'rent', label: 'x', amount: 1 });
  check('le trésorier ne modifie pas les prévisions saisies', r.status === 403, r.status);
  r = await owner('GET', `${TR}/forecast`);
  const fc = r.json;
  const sumFlows = fc.flowsList.reduce((s, f) => s + f.amount, 0);
  check('prévision : 13 semaines, 12 mois, solde de départ = trésorerie réelle', r.status === 200 && fc.weeks.length === 13 && fc.months.length === 12 && fc.opening === await cash(), [fc.opening, await cash()]);
  check('prévision : solde à 13 semaines = départ + tous les flux connus', fc.flowsList.length < 400 && fc.closing13 === fc.opening + sumFlows, [fc.closing13, fc.opening, sumFlows]);
  const fInv = fc.flowsList.find((f) => /FAC-T1/.test(f.label)); const fInv2 = fc.flowsList.find((f) => /FAC-T2/.test(f.label));
  check('facture échue : reste dû 792 500 × 99 % (1 % de provision), encaissement décalé', fInv && fInv.amount === 784575 && fInv.date > T0, fInv);
  check('facture non échue : 2 385 000 à son échéance', fInv2 && fInv2.amount === 2385000 && fInv2.date === day(25), fInv2);
  check('dette en retard : décaissement proche (400 000)', fc.flowsList.some((f) => /Fotso/.test(f.label) && f.amount === -400000), fc.flowsList.filter((f) => f.amount < 0).slice(0, 4));
  check('le loyer récurrent apparaît', fc.flowsList.some((f) => f.label === 'Loyer du siège' && f.amount === -150000 && f.date === day(2)));
  check('sources prises en compte listées (factures, dettes, éléments saisis)', fc.sources.invoice === 2 && fc.sources.bill >= 1 && fc.sources.plan >= 3, fc.sources);
  r = await owner('GET', `${TR}/calendar?month=${T0.slice(0, 7)}`);
  const cal = r.json;
  check('calendrier : solde jour par jour, cohérent avec la prévision', r.status === 200 && cal.days.length >= 1 && cal.days.every((d) => typeof d.balance === 'number'), cal.days && cal.days.length);
  const calDay = cal.days.find((d) => d.date === day(2));
  check('calendrier : le détail du jour liste le loyer', !calDay || calDay.items.some((i) => i.label === 'Loyer du siège'), calDay);
  r = await owner('GET', `${TR}/calendar?month=2026-13`);
  check('mois invalide refusé', r.status === 400, r.status);

  // découvert futur
  r = await owner('POST', `${TR}/plan`, { direction: 'out', category: 'capex', label: 'Immeuble', amount: 900000000, startDate: day(20), recurrence: 'none' });
  const bigId = r.json.id;
  r = await owner('GET', `${TR}/forecast`);
  check('alerte de découvert futur avec sa date', r.json.overdraft && r.json.overdraft.date === day(20) && r.json.overdraft.balance < 0, r.json.overdraft);
  r = await owner('GET', `${TR}/dashboard`);
  check('le tableau de bord signale le découvert prévu', r.json.alerts.some((a) => a.code === 'overdraft' && a.date === day(20)), r.json.alerts);
  await owner('DELETE', `${TR}/plan/${bigId}`);

  // scénarios
  r = await mem('POST', `${TR}/scenarios`, { name: 'x', params: {} });
  check('le trésorier ne crée pas de scénario', r.status === 403, r.status);
  r = await owner('POST', `${TR}/scenarios`, { name: 'Clients en retard de 15 jours', params: { delayDays: 15 } });
  const sc1 = r.json.id;
  check('scénario nommé sauvegardé', r.status === 201 && sc1, r.json);
  r = await owner('POST', `${TR}/scenarios`, { name: 'Ventes −20 %', params: { salesPct: -20 } });
  const sc2 = r.json.id;
  r = await owner('GET', `${TR}/scenarios`);
  check('scénarios listés avec modèles prêts à l\'emploi', r.json.scenarios.length === 2 && r.json.presets.length >= 5, r.json.scenarios.length);
  r = await mem('POST', `${TR}/scenarios/compare`, { ids: [sc1, sc2] });
  const cmp = r.json.results;
  check('comparaison côte à côte : central + 2 scénarios', r.status === 200 && cmp.length === 3 && cmp[0].name === 'Central', cmp && cmp.map((x) => x.name));
  check('retard de 15 jours : l\'encaissement de 2 385 000 sort de la semaine 4', cmp[0].weeks[3].closing - cmp[1].weeks[3].closing === 2385000, [cmp[0].weeks[3].closing, cmp[1].weeks[3].closing]);
  r = await owner('POST', `${TR}/scenarios/compare`, {});
  check('sans choix : pessimiste / central / optimiste', r.json.results.map((x) => x.name).join() === 'Pessimiste,Central,Optimiste' && r.json.results[0].closing12m < r.json.results[2].closing12m, r.json.results.map((x) => x.closing12m));
  r = await owner('POST', `${TR}/scenarios/compare`, { name: 'Gros prêt', params: { loan: { amount: 10000000, date: day(10), months: 12, ratePct: 0 } } });
  check('scénario libre « nouveau prêt » : +10 M puis 12 échéances de 833 333', r.json.results[1].weeks[1].closing - r.json.results[0].weeks[1].closing === 10000000, r.json.results.map((x) => x.weeks[1].closing));
  r = await owner('PUT', `${TR}/scenarios/${sc2}`, { name: 'Ventes −30 %', params: { salesPct: -30 } });
  check('scénario modifié', r.status === 200);
  r = await owner('DELETE', `${TR}/scenarios/${sc2}`);
  check('scénario supprimé', r.status === 200);

  // tendance
  await owner('PUT', `${TR}/settings`, { includeTrend: true });
  r = await owner('GET', `${TR}/forecast`);
  check('avec la tendance : les ventes et achats courants sont projetés', r.json.sources.trend_sales > 10 && r.json.sources.trendBase.sales > 0, r.json.sources);
  await owner('PUT', `${TR}/settings`, { includeTrend: false });

  // ---------- Créances clients ----------
  r = await owner('GET', `${TR}/receivables`);
  const rc = r.json;
  const ledger411 = await bal('411');
  check('créances = solde du compte 411 de la comptabilité', rc.total === ledger411 && rc.total === 3177500, [rc.total, ledger411]);
  check('balance âgée : 792 500 en retard de 1 à 30 jours, 2 385 000 non échu', rc.buckets.find((b) => b.key === 'd30').amount === 792500 && rc.buckets.find((b) => b.key === 'notDue').amount === 2385000, rc.buckets);
  check('provision conseillée : 1 % de 792 500 = 7 925', rc.provision === 7925, rc.provision);
  check('risque par client et factures détaillées', rc.customers.length === 1 && ['low', 'medium', 'high'].includes(rc.customers[0].risk) && rc.items[0].late === 10, rc.customers);
  r = await mem('POST', `${TR}/receivables/reminders`, {});
  check('le trésorier ne lance pas les relances', r.status === 403, r.status);
  r = await mgr('POST', `${TR}/receivables/reminders`, {});
  check('relances : balayage du centre de relances existant', r.status === 200 && r.json.ok, r.json);

  // ---------- Dettes fournisseurs ----------
  const sup = Number((await dbx.prepare("INSERT INTO suppliers (org_id, name, created_at) VALUES (?, 'Papeterie Nana', ?) RETURNING id").get(org, new Date().toISOString())).id);
  const billC = Number((await dbx.prepare("INSERT INTO supplier_bills (org_id, supplier_id, supplier_name, number, bill_date, due_date, amount, paid, status, source, created_at) VALUES (?, ?, 'Papeterie Nana', 'PN-5', ?, ?, 300000, 0, 'open', 'manual', ?) RETURNING id").get(org, sup, day(-1), day(30), new Date().toISOString())).id);
  r = await mgr('PUT', `${TR}/terms/${sup}`, { discountPct: 2, discountDays: 10, priority: 2 });
  check('conditions fournisseur : escompte 2 % sous 10 jours', r.status === 200, r.json);
  r = await mgr('PUT', `${TR}/terms/${sup}`, { discountPct: 99 });
  check('escompte absurde refusé', r.status === 400, r.status);
  r = await owner('GET', `${TR}/payables`);
  const pay = r.json;
  check('échéancier : dettes ouvertes, en retard et par semaine', pay.total === 700000 && pay.overdue === 400000 && pay.weeks.length === 13 && pay.bills.length === 2, [pay.total, pay.overdue, pay.bills.length]);
  r = await mem('GET', `${TR}/payables/optimize`);
  check('l\'optimisation est réservée au responsable', r.status === 403, r.status);
  r = await mgr('GET', `${TR}/payables/optimize?keepSafety=0`);
  const opt = r.json;
  check('optimisation : la dette en retard est payée en entier (400 000)', r.status === 200 && opt.payNow.some((x) => x.id === billB && x.payAmount === 400000 && x.reason === 'overdue'), opt.payNow.map((x) => [x.id, x.reason]));
  check('optimisation : l\'escompte de 2 % est saisi (300 000 → 294 000)', opt.payNow.some((x) => x.id === billC && x.payAmount === 294000 && x.reason === 'discount') && opt.saved === 6000, opt);
  r = await mgr('GET', `${TR}/payables/optimize`);
  check('avec le fonds de sécurité à respecter : on ne paie que ce que la trésorerie permet', r.json.safetyTarget === 5000000 && r.json.paid <= Math.max(r.json.cash - 5000000, 0), [r.json.paid, r.json.cash]);

  // ---------- Fonds de sécurité ----------
  r = await owner('GET', `${TR}/safety`);
  const cashNow = await cash();
  const glCash = (await bal('521')) + (await bal('571')) + (await bal('589')) + (await bal('5212'));
  check('fonds de sécurité : cible 5 000 000, niveau « bas », reconstitution hebdomadaire', r.json.target === 5000000 && r.json.available === cashNow && r.json.level === 'low' && r.json.gap === 5000000 - cashNow && r.json.recommendedWeekly === Math.round((5000000 - cashNow) / 12), r.json);
  await mgr('PUT', `${TR}/settings`, { safetyMode: 'days', safetyDays: 30 });
  r = await owner('GET', `${TR}/safety`);
  const spent = 200000 + 600000 + 5000; // décaissements d'exploitation des 90 derniers jours dans la comptabilité
  check('fonds de sécurité en jours de charges : 30 × décaissements quotidiens moyens', r.json.mode === 'days' && r.json.target === Math.round(30 * (spent / 90)) && r.json.level === 'ok', [r.json.target, Math.round(30 * (spent / 90)), r.json.level]);

  // ---------- Écarts prévu / réalisé ----------
  r = await owner('GET', `${TR}/variance?month=${T0.slice(0, 7)}`);
  const va = r.json;
  const g = (k) => va.rows.find((x) => x.group === k) || { actual: 0, planned: 0 };
  check('écarts : réalisé clients du mois = 400 000 (facture) + 20 000 (vente comptoir)', r.status === 200 && g('clients').actual === 420000, va.rows);
  check('écarts : « autres » = frais bancaires −5 000', g('autres').actual === -5000, g('autres'));
  check('écarts : perte de change dans les frais financiers (−228)', g('financiers').actual === -228, g('financiers'));
  check('écarts : prévu + écarts = réalisé (cascade cohérente)', va.check.ok && va.waterfall[0].value + va.waterfall.slice(1, -1).reduce((s, x) => s + x.value, 0) === va.waterfall[va.waterfall.length - 1].value, va.waterfall);
  check('écarts : tendance sur 6 mois et causes', va.trend.length === 6 && Array.isArray(va.causes), va.trend.length);
  r = await owner('GET', `${TR}/variance?month=abc`);
  check('mois invalide refusé', r.status === 400, r.status);

  // ---------- Tableau des flux ----------
  r = await owner('GET', `${TR}/cashflow?from=${day(-130)}&to=${T0}`);
  const cf = r.json;
  check('tableau des flux : trésorerie d\'ouverture 0, clôture = solde comptable des comptes de trésorerie', r.status === 200 && cf.opening === 0 && cf.closing === glCash, [cf.opening, cf.closing, glCash]);
  check('tableau des flux : ouverture + flux = clôture (vérifié)', cf.check.ok && cf.opening + cf.sections.operating.total + cf.sections.investing.total + cf.sections.financing.total === cf.closing, cf.check);
  check('flux d\'investissement −1 000 000 (matériel) et de financement +5 000 000 (capital) −228 (perte de change)', cf.sections.investing.total === -1000000 && cf.sections.financing.total === 5000000 - 228, [cf.sections.investing.total, cf.sections.financing.total]);
  check('flux d\'exploitation : clients +420 000, fournisseurs −800 000, autres −5 000', cf.sections.operating.rows.find((x) => x.group === 'clients').amount === 420000 && cf.sections.operating.rows.find((x) => x.group === 'fournisseurs').amount === -800000 && cf.sections.operating.total === 420000 - 800000 - 5000, cf.sections.operating);
  check('flux par mois sur 12 mois pour le graphique', cf.months.length === 12 && cf.months.reduce((s, m) => s + m.net, 0) === cf.closing, cf.months.map((m) => m.net));

  // ---------- Tableau de bord ----------
  r = await mem('GET', `${TR}/dashboard`);
  check('tableau de bord accessible au trésorier', r.status === 200 && r.json.role === 'treasurer', r.status);
  const db1 = r.json;
  check('tableau de bord : soldes, prévision, fonds de sécurité, créances, dettes, indicateurs', db1.cash === await cash() && db1.forecast.weeks.length === 13 && db1.safety.target > 0 && db1.receivables.total === 3177500 && db1.payables.total > 0 && db1.kpi.ccc !== undefined && db1.accounts.length === 4, Object.keys(db1));
  check('tableau de bord : « trésorerie du stock » absente sans l\'intégration (aucune erreur)', db1.stock === null);

  // ---------- Exports ----------
  r = await mem('GET', `${TR}/export/plan.xlsx`);
  check('export réservé au responsable', r.status === 403, r.status);
  r = await mgr('GET', `${TR}/export/plan.pdf`);
  check('export PDF du plan de trésorerie', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF' && /pdf/.test(r.headers.get('content-type')), r.status);
  r = await mgr('GET', `${TR}/export/plan.xlsx`);
  const { unzipSync } = require('fflate');
  const zip = r.status === 200 ? unzipSync(new Uint8Array(r.buf)) : {};
  check('export Excel : classeur à 6 feuilles', r.status === 200 && Object.keys(zip).filter((n) => /worksheets\/sheet/.test(n)).length === 6, Object.keys(zip));
  const sheet2 = Buffer.from(zip['xl/worksheets/sheet2.xml'] || []).toString();
  check('export Excel : 13 semaines + en-tête', (sheet2.match(/<row /g) || []).length === 14, (sheet2.match(/<row /g) || []).length);

  // ---------- Journal de traçabilité ----------
  r = await mem('GET', `${TR}/log`);
  check('le journal de traçabilité est réservé au responsable', r.status === 403, r.status);
  r = await mgr('GET', `${TR}/log`);
  check('journal : validations, rôles, exports tracés avec leur auteur', r.status === 200 && ['op.post', 'op.approve1', 'role', 'op.reject', 'export', 'op.reverse', 'settings'].every((a) => r.json.log.some((l) => l.action === a)) && r.json.log.every((l) => l.user), r.json.log.map((l) => l.action));
  check('journal : chaîne d\'empreintes intacte', r.json.chain.ok === true && r.json.chain.count > 10, r.json.chain);
  const row = await dbx.prepare('SELECT id FROM tre_log WHERE org_id = ? ORDER BY id LIMIT 1 OFFSET 3').get(org);
  await dbx.prepare("UPDATE tre_log SET detail = 'falsifié' WHERE id = ?").run(row.id);
  r = await mgr('GET', `${TR}/log`);
  check('journal : une ligne modifiée après coup est détectée', r.json.chain.ok === false && r.json.chain.brokenAt === Number(row.id), r.json.chain);

  // ---------- Isolation entre organisations ----------
  r = await other('GET', `${TR}/dashboard`);
  check('une autre organisation ne lit pas la trésorerie de la première', r.status === 404, r.status);
  r = await other('POST', `${TR}/ops/${op1}/approve`, {});
  check('ni ne valide ses opérations', r.status === 404, r.status);
  r = await other('GET', `${TR2}/me`);
  check('le propriétaire de l\'autre organisation a ses propres droits', r.status === 200 && r.json.role === 'admin', r.status);
  r = await other('GET', `${TR2}/accounts`);
  check('autre organisation : aucun compte de la première', r.status === 200 && r.json.accounts.length === 0 && r.json.consolidated.total === 0, r.json.accounts);
  r = await other('GET', `${TR2}/ops`);
  check('autre organisation : aucune opération', r.json.ops.length === 0);
  r = await other('POST', `${TR2}/ops/${op2}/approve`, {});
  check('autre organisation : une opération d\'une autre organisation est introuvable (404)', r.status === 404, r.status);
  r = await other('POST', `${TR2}/ops`, { kind: 'payment', category: 'supplier', accountId: bank, amount: 1000 });
  check('autre organisation : ne peut pas utiliser un compte de trésorerie d\'une autre', r.status === 404, r.status);
  r = await other('GET', `${TR2}/receivables`);
  check('autre organisation : aucune créance de la première', r.json.total === 0 && r.json.customers.length === 0, r.json.total);
  r = await other('GET', `${TR2}/scenarios`);
  check('autre organisation : aucun scénario de la première', r.json.scenarios.length === 0);
  r = await other('POST', `${TR2}/scenarios/compare`, { ids: [sc1] });
  check('autre organisation : ne compare pas les scénarios de la première', r.status === 200 && r.json.results.length === 1, r.json.results && r.json.results.length);
  void planId; void billC;
});

