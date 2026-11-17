'use strict';
// Budget et Projets · pilotage : formules vérifiées avec des chiffres calculés à la main (prévisions, valeur acquise, planning acquis,
// chemin critique, charge), tableau de bord du budget, détail jusqu'à la source, scénarios, export CSV, portefeuille de projets,
// plan de référence, risques, droits (qui voit les coûts) et cloisonnement entre organisations.
// Lancez-le avec : node scripts/test-budget-projets.js
const { run } = require('./lib/wave1');
const C = require('../src/workspace/bp-calc');

const todayS = new Date().toISOString().slice(0, 10);
const day = (n) => C.addDays(todayS, n);
const thisYear = todayS.slice(0, 4);
const prevYear = String(Number(thisYear) - 1);
const curMonth = Number(todayS.slice(5, 7));
const closed = curMonth - 1;
const mm = (m) => String(m).padStart(2, '0');

run('Budget et Projets : pilotage avancé', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx }) => {
  // =================================================================================================
  // 1. Calculs purs (bp-calc.js), chiffres faits à la main
  // =================================================================================================
  {
    const T = '2026-01-11'; const d = (n) => C.addDays(T, n);
    const tasks = [
      { id: 1, status: 'done', estimate: 10, start: d(-10), end: d(-1), doneAt: d(-1), hours: [{ day: d(-2), hours: 8 }] },
      { id: 2, status: 'doing', estimate: 20, start: d(-4), end: d(5), hours: [{ day: d(-1), hours: 5 }] },
      { id: 3, status: 'todo', estimate: 10, start: d(10), end: d(19), hours: [] },
    ];
    const win = { start: d(-10), end: d(20) };
    const e = C.evm({ tasks, costs: [{ date: d(-3), amount: 35000 }], rate: 5000, budget: 400000, window: win, today: T });
    const m = e.metrics;
    // BAC 400 000 réparti 10/40, 20/40, 10/40 -> 100 000, 200 000, 100 000.
    // PV = 100 000 × 1 + 200 000 × 5/10 + 0 = 200 000 ; EV = 100 000 + 200 000 × 5/20 = 150 000 ; AC = 35 000 + 13 h × 5 000 = 100 000.
    check('EVM : PV 200 000, EV 150 000, AC 100 000', m.pv === 200000 && m.ev === 150000 && m.ac === 100000, m);
    check('EVM : SV -50 000, CV +50 000, SPI 0,75, CPI 1,5', m.sv === -50000 && m.cv === 50000 && m.spi === 0.75 && m.cpi === 1.5, m);
    check('EVM : EAC = 400 000 / 1,5 = 266 667, ETC 166 667, VAC 133 333', m.eac === 266667 && m.etc === 166667 && m.vac === 133333, m);
    check('EVM : TCPI = 250 000 / 300 000 = 0,83 ; EAC atypique 350 000 ; composite 322 222', m.tcpi === 0.83 && m.eacAtypical === 350000 && m.eacComposite === 322222, m);
    check('EVM : 37,5 % acquis, 50 % prévu, 25 % du budget consommé', m.percentComplete === 37.5 && m.percentPlanned === 50 && m.percentSpent === 25, m);
    const es = C.earnedSchedule(e, win, T);
    // PVt(9) = 90 000 + 3 × 20 000 = 150 000 = EV -> ES = 9 jours ; AT = 11 ; SPI(t) = 0,82 ; durée 31 × 11 / 9 = 37,9 -> 38 jours.
    check('planning acquis : ES 9 j, AT 11 j, SPI(t) 0,82, fin prévue début + 37 j', es.es === 9 && es.at === 11 && es.spiT === 0.82 && es.forecastDuration === 38 && es.end === d(27), es);
    // Palier de PV égal à l'EV (projet dans les temps avec un creux, ou pas encore commencé) : SPI(t) = 1, fin prévue = fin du plan.
    const winP = { start: d(-10), end: d(19) };
    const eP = C.evm({ tasks: [{ id: 1, status: 'done', estimate: 10, start: d(-10), end: d(-1), doneAt: d(-1), hours: [] }, { id: 2, status: 'todo', estimate: 10, start: d(10), end: d(19), hours: [] }], rate: 0, budget: 100000, window: winP, today: T });
    const esP = C.earnedSchedule(eP, winP, T);
    check('planning acquis : dans les temps malgré un creux du plan -> SPI(t) 1, fin prévue à la fin du plan', esP.es === 11 && esP.spiT === 1 && esP.end === d(19), esP);
    const winF = { start: T, end: d(30) };
    const eF = C.evm({ tasks: [{ id: 1, status: 'todo', estimate: 10, start: d(25), end: d(30), hours: [] }], rate: 0, budget: 100000, window: winF, today: T });
    const esF = C.earnedSchedule(eF, winF, T);
    check('planning acquis : projet qui ne commence que dans 25 jours -> SPI(t) 1 (et non 25), fin prévue à la fin du plan', esF.spiT === 1 && esF.end === d(30), esF);
    const cv = C.curve(e, win, T);
    const last = cv.find((x) => x.date === T);
    check('courbe en S : le point du jour reprend PV/EV/AC', last && last.pv === 200000 && last.ev === 150000 && last.ac === 100000, last);
    check('courbe en S : pas d\'EV ni d\'AC dans le futur', cv.filter((x) => x.date > T).every((x) => x.ev === null && x.ac === null));
    check('burn-down : reste 25 h sur 40 aujourd\'hui (10 faites + 5 sur 20)', last.remaining === 25 && cv[0].idealRemaining === 39, [last.remaining, cv[0].idealRemaining]);
    const eff = C.evm({ tasks: [{ id: 1, status: 'done', estimate: 0 }, { id: 2, status: 'todo', estimate: 0 }], window: win, today: T });
    check('mode effort (ni budget ni estimation) : 50 % acquis, en tâches, sans indicateur de coût', eff.metrics.mode === 'effort' && eff.metrics.unit === 'tasks' && eff.metrics.percentComplete === 50 && eff.metrics.cpi === null, eff.metrics);

    const cp = C.criticalPath([{ id: 'A', start: '2026-01-01', end: '2026-01-03' }, { id: 'B', start: '2026-01-04', end: '2026-01-08', dependsOn: 'A' }, { id: 'C', start: '2026-01-01', end: '2026-01-02' }]);
    const cpC = cp.tasks.find((x) => x.id === 'C');
    check('chemin critique : A -> B (marge 0), C a 6 jours de marge', cp.path.join(',') === 'A,B' && cpC.float === 6 && cpC.lateFinish === '2026-01-08', cp);

    const tr = C.forecastSeries({ actual: [100, 110, 120, 130, 0, 0, 0, 0, 0, 0, 0, 0], planned: Array(12).fill(100), prev: null, closed: 4, kind: 'expense' });
    // Droite 90 + 10 m : mois 5..12 = 140..210 (somme 1 400) ; atterrissage 460 + 1 400 = 1 860 ; rythme 120 × 8 + 460 = 1 420.
    check('prévision : tendance linéaire 1 860, rythme 1 420, plan 1 260', tr.method === 'trend' && tr.landing === 1860 && tr.methods.runRate === 1420 && tr.methods.plan === 1260 && tr.slope === 10, tr);
    const se = C.forecastSeries({ actual: [100, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], planned: Array(12).fill(100), prev: [50, 100, 50, 100, 50, 100, 50, 100, 50, 100, 50, 100], closed: 2, kind: 'expense' });
    check('prévision : saisonnalité de l\'an passé (croissance × 2) -> 1 800', se.method === 'seasonal' && se.growth === 2 && se.landing === 1800, se);
    // Activité démarrée en octobre de l'an passé : l'an passé ne couvre pas la période, pas de saisonnalité (g vaudrait 10 et l'atterrissage exploserait).
    const young = C.forecastSeries({ actual: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 0, 0], planned: Array(12).fill(100), prev: [0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 100, 100], closed: 10, kind: 'expense' });
    check('prévision : an passé partiel (activité démarrée en octobre) -> pas de saisonnalité, atterrissage 1 200', young.method === 'trend' && young.landing === 1200, young);
    const noisy = C.forecastSeries({ actual: [100, 140, 80, 120, 0, 0, 0, 0, 0, 0, 0, 0], planned: [], prev: null, closed: 4, kind: 'expense' });
    // Tendance : b = 0 (Σ(x-x̄)(y-ȳ) = -1,5×-10 + -0,5×30 + 0,5×-30 + 1,5×10 = 0), a = 110 ; résidus -10, 30, -30, 10 -> σ = √(2000/2) = 31,6
    // demi-largeur = 1,2816 × 31,62 × √8 = 114,6 ; atterrissage 440 + 8 × 110 = 1 320.
    check('prévision : fourchette à 80 % = ± 1,28 σ √h', noisy.landing === 1320 && noisy.sigma === 32 && noisy.high === 1435 && noisy.low === 1205, noisy);
    const floor = C.forecastSeries({ actual: [10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0], planned: [], prev: null, closed: 3, committed: 500, kind: 'expense' });
    check('prévision : une dépense n\'atterrit jamais sous réalisé + engagé', floor.landing === 530, floor);
    check('scénarios : reste à prévoir ± 10 %', C.scenario(1200, 400, 400, 'expense', 10, 'optimistic') === 1120 && C.scenario(1200, 400, 400, 'expense', 10, 'pessimistic') === 1280 && C.scenario(1200, 400, 400, 'income', 10, 'optimistic') === 1280, null);
    const wl = C.weeklyLoad([{ assigneeId: 7, assignee: 'X', estimate: 30, logged: 2, start: '2026-11-16', end: '2026-11-29', status: 'todo' }, { assigneeId: 7, estimate: 10, logged: 0, start: '2026-11-01', end: '2026-11-10', status: 'doing' }], '2026-11-16', 3, 40);
    // 28 h sur 14 jours = 2 h/j -> 14 h la semaine du 16 et 14 h celle du 23 ; la tâche en retard (10 h) tombe aujourd'hui.
    check('charge : reste à faire réparti par semaine, retard sur aujourd\'hui', wl.rows[0].hours[0] === 24 && wl.rows[0].hours[1] === 14 && wl.rows[0].load[0] === 60 && wl.rows[0].total === 38, wl.rows[0]);
    check('risques : 4 × 4 = 16 élevé, 3 × 3 = 9 moyen, 2 × 3 faible', C.riskLevel(16) === 'high' && C.riskLevel(9) === 'medium' && C.riskLevel(6) === 'low');
    const h1 = C.health({ status: 'active', tasks: 3, spi: 0.9, cpi: 1.2, ac: 10, bac: 100, eac: 90, lateDays: 0, overdueTasks: 0, highRisks: 0, due: null, today: T, money: true });
    const h2 = C.health({ status: 'active', tasks: 3, spi: 1, cpi: 1, ac: 120, bac: 100, eac: 120, lateDays: 0, overdueTasks: 0, highRisks: 0, due: null, today: T, money: true });
    check('santé : SPI 0,9 = orange ; coût au-dessus du budget = rouge ; terminé = gris', h1.rag === 'amber' && h1.reasons.includes('spi') && h2.rag === 'red' && h2.reasons.includes('overBudget') && C.health({ status: 'done', tasks: 2 }).rag === 'grey', [h1, h2]);
  }

  // =================================================================================================
  // 2. Budget : tableau de bord, prévisions, engagements, détail, scénarios, export
  // =================================================================================================
  const B = `${O}/budget`; const AC = `${O}/accounting`; const PU = `${O}/purchasing`;
  let r = await mgr('GET', `${B}/pro`);
  check('tableau de bord du budget : réservé aux administrateurs (données de la compta)', r.status === 403, r.status);
  r = await mem('GET', `${B}/pro`);
  check('fermé aux simples membres', r.status === 403, r.status);
  r = await other('GET', `${B}/pro`);
  check('une autre organisation ne le voit pas (404)', r.status === 404, r.status);

  r = await owner('PUT', `${B}/annual`, { year: thisYear, lines: [{ kind: 'expense', category: 'Loyer', monthly: 60000 }, { kind: 'expense', category: 'Achats', monthly: 100000 }, { kind: 'income', category: 'Ventes', monthly: 500000 }] });
  check('budget annuel enregistré', r.status === 200, r.json);
  // Loyer réel : 70 000 chaque mois clos ; ventes : 20 000 × n° du mois (mois clos) et l'an passé 10 000 × n° du mois (saisonnalité, croissance × 2).
  for (let m = 1; m <= closed; m++) {
    r = await owner('POST', `${AC}/entries`, { journal: 'BQ', date: `${thisYear}-${mm(m)}-10`, label: `Loyer ${m}`, piece: `L${m}`, lines: [{ account: '622', debit: 70000 }, { account: '521', credit: 70000 }] });
    if (r.status !== 201) check('écriture de loyer', false, r.json);
    await owner('POST', `${AC}/entries`, { journal: 'BQ', date: `${thisYear}-${mm(m)}-12`, label: `Ventes ${m}`, piece: `V${m}`, lines: [{ account: '521', debit: 20000 * m }, { account: '701', credit: 20000 * m }] });
  }
  for (let m = 1; m <= 12; m++) {
    r = await owner('POST', `${AC}/entries`, { journal: 'BQ', date: `${prevYear}-${mm(m)}-12`, label: `Ventes N-1 ${m}`, piece: `P${m}`, lines: [{ account: '521', debit: 10000 * m }, { account: '701', credit: 10000 * m }] });
    if (r.status !== 201) check('écriture de l\'an passé', false, r.json);
  }
  // Dépense hors compta sans budget (catégorie non prévue)
  r = await mgr('POST', `${B}/entries`, { kind: 'expense', category: 'Transport', amount: 15000, date: todayS, label: 'Taxi' });
  check('saisie hors compta (201)', r.status === 201, r.json);
  // Engagement : bon de commande des Achats approuvé, 10 × 5 000 HT (TVA 19,25 % non comptée)
  r = await owner('POST', `${PU}/suppliers`, { name: 'Fournisseur BP', status: 'active' });
  const sup = r.json.id;
  r = await owner('POST', `${PU}/orders`, { supplierId: sup, category: 'Achats', vatRate: 19.25, lines: [{ description: 'Ciment', quantity: 10, unitPrice: 5000 }] });
  check('bon de commande créé', r.status === 201, r.json);
  const bc = r.json.id;
  r = await owner('POST', `${PU}/orders/${bc}/approve`, {});
  check('bon de commande approuvé', r.status === 200, r.json);

  r = await owner('GET', `${B}/pro?year=${thisYear}`);
  check('tableau de bord du budget (200)', r.status === 200 && r.json.closedMonths === closed && r.json.currentMonth === curMonth, [r.status, r.json && r.json.closedMonths]);
  const d = r.json;
  const loyer = d.categories.find((l) => l.category === 'Loyer');
  const expLoyer = closed > 0 ? 840000 : 720000;
  check('Loyer : prévu 720 000, réalisé = 70 000 × mois clos', loyer.plannedTotal === 720000 && loyer.actualTotal === 70000 * closed, [loyer.plannedTotal, loyer.actualTotal]);
  check('Loyer : écart à date = réalisé à date - prévu à date', loyer.ytdPlanned === 60000 * curMonth && loyer.ytdVariance === 70000 * closed - 60000 * curMonth, [loyer.ytdPlanned, loyer.ytdVariance]);
  check('Loyer : atterrissage 70 000 × 12 = 840 000 (rythme constant, fourchette nulle)', loyer.landing === expLoyer && loyer.low === expLoyer && loyer.high === expLoyer, [loyer.landing, loyer.method, loyer.low, loyer.high]);
  check('Loyer : statut « risque » (atterrissage au-dessus du prévu) ou dépassé', closed === 0 || (closed >= 11 ? loyer.status === 'over' : loyer.status === 'risk'), loyer.status);
  const oExp = Math.round(70000 * closed + 70000 * (12 - closed) * 0.9);
  check('Loyer : scénario optimiste = réalisé des mois clos + reste × 0,9', closed === 0 || loyer.scenarios.optimistic === oExp, [loyer.scenarios, oExp]);
  const ventes = d.categories.find((l) => l.kind === 'income' && l.category === 'Ventes');
  check('Ventes : saisonnalité de l\'an passé (croissance × 2) -> 20 000 × 78 = 1 560 000', closed === 0 || (ventes.method === 'seasonal' && ventes.growth === 2 && ventes.landing === 1560000), ventes && [ventes.method, ventes.growth, ventes.landing]);
  check('Ventes : l\'an passé est renvoyé pour comparaison', d.hasPrevYear && ventes.prevYear && ventes.prevYear[11] === 120000, ventes && ventes.prevYear);
  const achats = d.categories.find((l) => l.category === 'Achats');
  check('Achats : engagé = HT du bon de commande approuvé (50 000), au mois courant', achats.committed === 50000 && achats.committedByMonth[curMonth - 1] === 50000 && achats.commitItems.some((i) => i.source === 'pur_order'), achats && [achats.committed, achats.committedByMonth]);
  check('Achats : reste = prévu - réalisé - engagé ; atterrissage ≥ engagé', achats.remaining === 1200000 - 50000 && achats.landing >= 50000, [achats.remaining, achats.landing]);
  const transport = d.categories.find((l) => l.category === 'Transport');
  check('Transport : dépense hors compta sans budget = « non prévue »', transport && transport.status === 'unplanned' && transport.actualTotal === 15000, transport && transport.status);
  const k = d.kpis;
  check('KPI : prévu des dépenses 1 920 000, réalisé, engagé 50 000', k.expensePlanned === 1920000 && k.expenseActual === 70000 * closed + 15000 && k.committed === 50000, k);
  check('KPI : taux de consommation = (réalisé + engagé) / prévu', k.expenseConsumedPct === Math.round((70000 * closed + 15000 + 50000) / 1920000 * 1000) / 10, k.expenseConsumedPct);
  check('KPI : rythme mensuel = moyenne des mois clos', closed === 0 ? k.burnRate === null : k.burnRate === 70000, k.burnRate);
  check('KPI : atterrissage total = somme des catégories ; résultat = recettes - dépenses', k.expenseLanding === C.sum(d.categories.filter((l) => l.kind === 'expense').map((l) => l.landing)) && k.resultLanding === k.incomeLanding - k.expenseLanding, k);
  check('graphique mensuel : 12 mois prévu / réalisé / engagé / prévision', d.monthly.expense.planned.length === 12 && d.monthly.expense.planned[0] === 160000 && d.monthly.expense.committed[curMonth - 1] === 50000 && d.monthly.expense.forecast.slice(0, closed).every((x) => x === null), d.monthly.expense);
  check('cumul : le cumul prévu finit au prévu annuel', d.monthly.expense.cumPlanned[11] === 1920000);
  check('alertes : non prévue avant risque, codes fournis', d.alerts.length >= 2 && d.alerts.some((a) => a.category === 'Transport' && a.code === 'unplanned'), d.alerts.map((a) => a.code + ':' + a.category));
  check('dépassements : Loyer en tête', closed === 0 || (d.topOverruns[0] && d.topOverruns[0].category === 'Loyer' && d.topOverruns[0].overrun === 120000), d.topOverruns);
  check('scénarios : optimiste ≤ central ≤ pessimiste (dépenses)', d.scenarios.optimistic.expense <= d.scenarios.central.expense && d.scenarios.central.expense <= d.scenarios.pessimistic.expense && d.scenarios.plan.expense === 1920000, d.scenarios);
  r = await owner('GET', `${B}/pro?year=${thisYear}&optimistic=20&pessimistic=30`);
  check('scénarios réglables (20 % / 30 %)', r.json.scenarios.optimisticPct === 20 && r.json.scenarios.pessimisticPct === 30 && (closed === 0 || r.json.categories.find((l) => l.category === 'Loyer').scenarios.pessimistic === Math.round(70000 * closed + 70000 * (12 - closed) * 1.3)), r.json.scenarios);
  r = await owner('GET', `${B}/pro?optimistic=95`);
  check('ajustement hors limites refusé (400)', r.status === 400, r.json);
  r = await owner('GET', `${B}/pro?year=20x6`);
  check('année invalide refusée (400)', r.status === 400);

  // Détail jusqu'à la source
  if (closed >= 1) {
    r = await owner('GET', `${B}/pro/drill?year=${thisYear}&kind=expense&category=Loyer&month=1`);
    check('détail Loyer de janvier : 1 écriture comptable de 70 000 (numéro, compte 622)', r.status === 200 && r.json.ledger.length === 1 && r.json.ledger[0].amount === 70000 && r.json.ledger[0].account === '622' && /^BQ-/.test(r.json.ledger[0].number), r.json);
  }
  r = await owner('GET', `${B}/pro/drill?year=${thisYear}&kind=expense&category=Loyer`);
  check('détail Loyer sur l\'année : total = réalisé', r.json.totals.ledger === 70000 * closed, r.json.totals);
  r = await owner('GET', `${B}/pro/drill?year=${thisYear}&kind=expense&category=Transport`);
  check('détail Transport : la saisie hors compta', r.json.manual.length === 1 && r.json.manual[0].amount === 15000, r.json);
  r = await owner('GET', `${B}/pro/drill?year=${thisYear}&kind=expense&category=achats`);
  check('détail Achats : le bon de commande engagé', r.json.commitments.length === 1 && r.json.commitments[0].amount === 50000 && r.json.commitments[0].source === 'pur_order', r.json);
  r = await owner('GET', `${B}/pro/drill?year=${thisYear}&category=Loyer&month=13`);
  check('mois invalide refusé (400)', r.status === 400);
  r = await mgr('GET', `${B}/pro/drill?year=${thisYear}&category=Loyer`);
  check('détail : réservé aux administrateurs', r.status === 403);

  r = await owner('GET', `${B}/pro/export.csv?year=${thisYear}`);
  check('export CSV du budget', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.includes('Atterrissage') && r.text.includes('Loyer;720000'), r.text.slice(0, 200));
  // Cloisonnement : l'autre organisation ne voit rien de nos chiffres
  r = await other('GET', `${ws(org2)}/budget/pro?year=${thisYear}`);
  check('cloisonnement : l\'autre organisation a un budget vide', r.status === 200 && r.json.categories.length === 0 && r.json.kpis.committed === 0, r.json && r.json.categories);

  // =================================================================================================
  // 3. Projets : valeur acquise, prévisions, chemin critique, plan de référence, risques, portefeuille, charge
  // =================================================================================================
  const P = `${O}/projects`;
  r = await owner('PUT', `${P}/settings`, { project_hourly_cost: 5000 });
  check('coût horaire réglé (5 000)', r.status === 200, r.json);
  r = await mgr('POST', P, { name: 'Boutique Douala', due: day(20) });
  const pid = r.json.id;
  r = await mgr('PUT', `${P}/${pid}/budget`, { budget: 400000 });
  check('budget du projet 400 000', r.status === 200);
  const members = (await owner('GET', `${O}/members`)).json.members;
  const memId = members.find((x) => x.role === 'member').userId;
  const mkTask = async (title, start, due, est) => {
    const x = await mgr('POST', `${P}/tasks`, { projectId: pid, title, due });
    await mgr('PUT', `${P}/tasks/${x.json.id}/plan`, { estimateHours: est, startDate: start });
    return x.json.id;
  };
  const T1 = await mkTask('Bail', day(-10), day(-1), 10);
  const T2 = await mkTask('Travaux', day(-4), day(5), 20);
  const T3 = await mkTask('Ouverture', day(10), day(19), 10);
  await mgr('PUT', `${P}/tasks/${T3}`, { assigneeId: memId });
  r = await mgr('PUT', `${P}/tasks/${T3}/plan`, { dependsOn: T2 });
  check('dépendance Ouverture -> Travaux', r.status === 200, r.json);
  await mgr('POST', `${P}/tasks/${T1}/time`, { hours: 8, day: day(-2) });
  await mgr('POST', `${P}/tasks/${T2}/time`, { hours: 5, day: day(-1) });
  r = await mgr('PUT', `${P}/tasks/${T1}`, { status: 'done' });
  check('tâche terminée', r.status === 200, r.json);
  let row = await dbx.prepare('SELECT done_at FROM tasks WHERE id = ?').get(T1);
  check('date de fin réelle enregistrée', row.done_at === todayS, row);
  await mgr('PUT', `${P}/tasks/${T1}`, { status: 'todo' });
  row = await dbx.prepare('SELECT done_at FROM tasks WHERE id = ?').get(T1);
  check('tâche rouverte : date de fin effacée', row.done_at === null, row);
  await mgr('PUT', `${P}/tasks/${T1}`, { status: 'done' });
  await mgr('PUT', `${P}/tasks/${T2}`, { status: 'doing' });
  r = await mgr('POST', `${P}/${pid}/costs`, { label: 'Peinture', amount: 35000, date: day(-3) });
  check('dépense du projet', r.status === 201, r.json);

  r = await mgr('GET', `${P}/${pid}/pro`);
  check('tableau de bord du projet (200)', r.status === 200 && r.json.canSeeCosts === true, r.status);
  let a = r.json;
  let m = a.metrics;
  check('projet : fenêtre du plan = début de la 1re tâche -> échéance (31 jours)', a.project.start === day(-10) && a.project.end === day(20), a.project);
  check('projet : PV 200 000, EV 150 000, AC 100 000 (35 000 + 13 h × 5 000)', m.pv === 200000 && m.ev === 150000 && m.ac === 100000, m);
  check('projet : SPI 0,75, CPI 1,5, EAC 266 667, ETC 166 667, VAC 133 333, TCPI 0,83', m.spi === 0.75 && m.cpi === 1.5 && m.eac === 266667 && m.etc === 166667 && m.vac === 133333 && m.tcpi === 0.83, m);
  const f = a.forecast;
  check('projet : fin prévue (planning acquis) J+27, 7 jours après l\'échéance', f.endByEarnedSchedule === day(27) && f.lateDaysEarnedSchedule === 7 && f.earnedSchedule.spiT === 0.82, f);
  check('projet : fin prévue (dépendances) = fin de la dernière tâche', f.endByPlan === day(19) && f.lateDaysPlan === 0, [f.endByPlan, f.lateDaysPlan]);
  // Vitesse : 10 h terminées sur 28 jours ; reste 15 + 10 = 25 h -> 70 jours.
  check('projet : fin à la vitesse des 28 derniers jours = J+70', f.endByVelocity === day(70) && f.remainingEffort === 25, [f.endByVelocity, f.remainingEffort]);
  check('projet : coût final par le bas = 100 000 + 25 h × 5 000 = 225 000', f.eacBottomUp === 225000 && f.remainingHours === 25, [f.eacBottomUp, f.remainingHours]);
  check('projet : santé rouge (SPI < 0,8)', a.health.rag === 'red' && a.health.reasons.includes('spi'), a.health);
  check('projet : alertes SPI et retard, pas de plan de référence', ['spi', 'late', 'noBaseline'].every((c) => a.alerts.some((x) => x.code === c)), a.alerts.map((x) => x.code));
  const gT3 = a.gantt.find((g) => g.id === T3); const gT2 = a.gantt.find((g) => g.id === T2);
  check('chemin critique : Ouverture critique, Travaux 4 jours de marge', a.criticalPath.length === 1 && a.criticalPath[0] === T3 && gT3.critical && gT2.float === 4 && !gT2.critical, a.gantt.map((g) => [g.title, g.float, g.critical]));
  check('Gantt : avancement par tâche (100 / 25 / 0 %)', a.gantt.find((g) => g.id === T1).progress === 100 && gT2.progress === 25 && gT3.progress === 0);
  check('courbe en S et burn-down fournis jusqu\'à la fin prévue', a.series.length > 10 && a.series[a.series.length - 1].date === day(27) && a.series.some((s) => s.date === todayS && s.ev === 150000), a.series.length);
  check('coûts par origine : saisie + temps', a.costs.bySource.manual === 35000 && a.costs.bySource.time === 65000, a.costs);

  // Membre : avancement et délais, sans aucun montant
  r = await mem('GET', `${P}/${pid}/pro`);
  m = r.json.metrics;
  check('membre : voit SPI et avancement', r.status === 200 && m.spi === 0.75 && m.percentComplete === 37.5 && r.json.canSeeCosts === false, m);
  check('membre : ne voit ni budget, ni PV/EV/AC, ni CPI/EAC', m.bac === undefined && m.pv === undefined && m.ac === undefined && m.cpi === undefined && m.eac === undefined && r.json.project.budget === undefined && r.json.costs === undefined && r.json.forecast.eacBottomUp === undefined && r.json.series.every((s) => s.pv === undefined && s.ac === undefined && s.pvPct !== undefined), m);
  r = await other('GET', `${P}/${pid}/pro`);
  check('autre organisation : projet introuvable (404)', r.status === 404, r.status);
  r = await other('GET', `${ws(org2)}/projects/${pid}/pro`);
  check('cloisonnement : notre projet n\'existe pas dans l\'autre organisation', r.status === 404, r.status);

  // Plan de référence : on fige, on décale, la valeur planifiée suit le plan figé
  r = await mem('POST', `${P}/${pid}/baseline`, {});
  check('plan de référence : réservé aux responsables', r.status === 403);
  r = await mgr('POST', `${P}/${pid}/baseline`, {});
  check('plan de référence enregistré (3 tâches)', r.status === 201 && r.json.tasks === 3, r.json);
  r = await mgr('POST', `${P}/tasks/${T2}/shift`, { days: 5, apply: true });
  check('Travaux décalés de 5 jours (Ouverture suit)', r.status === 200 && r.json.applied === 2, r.json);
  r = await mgr('GET', `${P}/${pid}/pro`);
  a = r.json;
  check('avec plan de référence : PV inchangée (200 000)', a.metrics.pv === 200000 && a.baseline && a.baseline.tasks === 3, [a.metrics.pv, a.baseline]);
  const g2 = a.gantt.find((g) => g.id === T2);
  check('Gantt : dates de référence et dates actuelles', g2.baselineStart === day(-4) && g2.start === day(1) && g2.end === day(10), g2);
  check('alerte « pas de plan de référence » disparue', !a.alerts.some((x) => x.code === 'noBaseline'));
  r = await mgr('DELETE', `${P}/${pid}/baseline`);
  check('plan de référence supprimé', r.status === 200);
  r = await mgr('GET', `${P}/${pid}/pro`);
  check('sans plan de référence : PV recalculée sur le plan actuel (Travaux pas commencés -> 100 000)', r.json.metrics.pv === 100000, r.json.metrics.pv);
  r = await mgr('DELETE', `${P}/${pid}/baseline`);
  check('suppression d\'un plan absent : 404', r.status === 404);

  // Risques et problèmes
  r = await mem('POST', `${P}/${pid}/risks`, { title: 'Retard de livraison du ciment', probability: 4, impact: 4, mitigation: 'Deuxième fournisseur' });
  check('un membre signale un risque élevé (16)', r.status === 201 && r.json.score === 16 && r.json.level === 'high', r.json);
  const rk1 = r.json.id;
  r = await mgr('POST', `${P}/${pid}/risks`, { kind: 'issue', title: 'Coupure d\'électricité', probability: 2, impact: 3 });
  const rk2 = r.json.id;
  r = await mgr('POST', `${P}/${pid}/risks`, { title: 'x', probability: 6 });
  check('probabilité hors 1..5 refusée', r.status === 400, r.json);
  r = await mem('PUT', `${P}/risks/${rk2}`, { status: 'closed' });
  check('un membre ne modifie pas le risque d\'un autre', r.status === 403, r.status);
  r = await mem('PUT', `${P}/risks/${rk1}`, { status: 'mitigating', probability: 3 });
  check('l\'auteur met à jour son risque (3 × 4 = 12, moyen)', r.status === 200 && r.json.score === 12 && r.json.level === 'medium', r.json);
  r = await mgr('PUT', `${P}/risks/${rk1}`, { probability: 5 });
  r = await mgr('GET', `${P}/${pid}/risks`);
  check('liste des risques triée par note', r.json.items.length === 2 && r.json.items[0].id === rk1 && r.json.items[0].score === 20, r.json.items.map((x) => x.score));
  r = await mgr('GET', `${P}/${pid}/pro`);
  check('synthèse des risques : 1 élevé, 1 problème, matrice 5 × 5', r.json.riskSummary.high === 1 && r.json.riskSummary.issues === 1 && r.json.riskSummary.matrix[0][3] === 1 && r.json.alerts.some((x) => x.code === 'highRisks'), r.json.riskSummary);
  r = await other('PUT', `${ws(org2)}/projects/risks/${rk1}`, { status: 'closed' });
  check('cloisonnement : un risque d\'une autre organisation est introuvable', r.status === 404, r.status);
  r = await mgr('DELETE', `${P}/risks/${rk2}`);
  check('risque supprimé', r.status === 200);

  // Projet « en effort » (ni budget ni estimation) : indicateurs de délai seulement
  r = await mgr('POST', P, { name: 'Formation', tasks: [{ title: 'Module 1' }, { title: 'Module 2' }] });
  const pid2 = r.json.id;
  const t2s = (await mgr('GET', `${P}/${pid2}`)).json.tasks;
  await mgr('PUT', `${P}/tasks/${t2s[0].id}`, { status: 'done' });
  r = await mgr('GET', `${P}/${pid2}/pro`);
  check('projet sans budget ni estimation : mode effort, 50 % acquis, pas de CPI', r.json.metrics.mode === 'effort' && r.json.metrics.unit === 'tasks' && r.json.metrics.percentComplete === 50 && r.json.metrics.cpi === null, r.json.metrics);

  // Portefeuille
  r = await mgr('GET', `${P}/portfolio`);
  const pf = r.json;
  const it = pf.items.find((x) => x.id === pid);
  check('portefeuille : les 2 projets, feu tricolore et indices', r.status === 200 && pf.items.length === 2 && it && ['red', 'amber'].includes(it.rag) && it.bac === 400000 && pf.canSeeCosts, pf.items.map((x) => [x.name, x.rag]));
  check('portefeuille : totaux (BAC, SPI = ΣEV/ΣPV, CPI = ΣEV/ΣAC)', pf.totals.bac === 400000 && pf.totals.spi === Math.round(it.ev / it.pv * 100) / 100 && pf.totals.cpi === Math.round(it.ev / it.ac * 100) / 100 && pf.totals.projects === 2, pf.totals);
  r = await mem('GET', `${P}/portfolio`);
  check('portefeuille d\'un membre : sans montants', r.status === 200 && r.json.items.every((x) => x.bac === undefined && x.ac === undefined) && r.json.totals.bac === undefined && !r.json.canSeeCosts, r.json.totals);
  r = await mgr('GET', `${P}/portfolio/export.csv`);
  check('export CSV du portefeuille (avec les montants pour un responsable)', r.status === 200 && r.text.includes('Budget (BAC)') && r.text.includes('Boutique Douala'), r.text.slice(0, 160));
  r = await mem('GET', `${P}/portfolio/export.csv`);
  check('export CSV d\'un membre : sans colonnes de coût', r.status === 200 && !r.text.includes('Budget (BAC)') && r.text.includes('Boutique Douala'));
  r = await other('GET', `${ws(org2)}/projects/portfolio`);
  check('cloisonnement : portefeuille de l\'autre organisation vide', r.status === 200 && r.json.items.length === 0, r.json.items);

  // Charge prévue par personne et par semaine : Ouverture (10 h, J+11 -> J+20) assignée à Paul
  r = await mem('GET', `${P}/workload/plan`);
  check('charge prévue : réservée aux responsables', r.status === 403);
  r = await mgr('GET', `${P}/workload/plan?weeks=4&capacity=40`);
  const paul = r.json.rows && r.json.rows.find((x) => x.userId === memId);
  check('charge prévue : 10 h pour Paul sur 4 semaines, rien au-delà', r.status === 200 && r.json.weeks.length === 4 && paul && paul.total === 10 && paul.beyond === 0, r.json);
  r = await mgr('GET', `${P}/workload/plan?capacity=0`);
  check('capacité invalide refusée', r.status === 400);
}, {});
