'use strict';
// Module Commercial (étape 2) : SPIN Selling, prévision des ventes (pipeline, tendance, scénarios, objectifs), devis versionnés avec circuit de remise et acceptation par lien.
// Lancez-le avec : node scripts/test-commercial-2.js
const { run, client } = require('./lib/wave1');
const L = require('../src/workspace/commercial/lib');

run('Commercial 2 : SPIN, prévision, devis', async ({ check, owner, mgr, mem, other, org, O, dbx, base }) => {
  const C = `${O}/commercial`;
  let r;
  const uid = async (c) => (await c('GET', '/api/me')).json.user.id;
  const U = { mgr: await uid(mgr), mem: await uid(mem) };
  await owner('PUT', `${C}/roles/${U.mgr}`, { role: 'sales_manager' });
  await owner('PUT', `${C}/roles/${U.mem}`, { role: 'sales_assistant' });
  const m0 = new Date().toISOString().slice(0, 7); const today = new Date().toISOString().slice(0, 10);
  const next = L.addMonths(m0, 1);

  // ---------- Calculs purs ----------
  check('lissage exponentiel (α 0,5) [100,200,300] = 225', L.ses([100, 200, 300], 0.5) === 225);
  check('moyenne mobile (3) [100,200,300,400] = 300', L.movingAverage([100, 200, 300, 400], 3) === 300);
  check('rétro-test : prévision 100 pour un réalisé de 200 → erreur 50 %', L.backtest([100, 100, 100, 200], 0.5).mape === 50);
  check('atterrissage : réalisé 1000, pondéré 400, plafond 500 → 1280 / 1400 / 1500', JSON.stringify(L.landing(1000, 400, 500)) === JSON.stringify({ pessimistic: 1280, central: 1400, optimistic: 1500 }));
  check('remise : 2 × 900 sur 1000 + 1 × 500 sans liste = 8 %', L.discountPct([{ quantity: 2, price: 900, listPrice: 1000 }, { quantity: 1, price: 500 }]) === 8);
  const syn0 = L.spinSynthesis([{ situation: [{ a: 'x' }, { a: 'y' }], problem: [{ a: 'perte' }], implication: [{ a: 'coût' }], payoff: [] }]);
  check('SPIN : complétude 15 + 25 + 15 + 0 = 55, manque implication et bénéfice', syn0.completeness === 55 && syn0.maturity === 'implicit' && syn0.missing.join() === 'implication,payoff', syn0);

  // ---------- SPIN ----------
  r = await owner('POST', `${C}/accounts`, { name: 'Société Alpha', phone: '699112233' });
  const alpha = r.json.id;
  r = await mgr('POST', `${C}/opps`, { name: 'Chantier', customerId: alpha, amount: 1000000, probability: 50, closeDate: `${m0}-28` });
  const opp1 = r.json.id;
  r = await mgr('POST', `${C}/opps`, { name: 'Dépôt', customerId: alpha, amount: 400000, probability: 25, closeDate: `${next}-15` });
  r = await mem('POST', `${C}/spin`, { oppId: opp1, kind: 'meeting', situation: [{ q: 'Quel est votre volume ?', a: '200 sacs/mois' }, { q: 'Fournisseur actuel ?', a: 'Cimencam' }], problem: [{ q: 'Que ne vous convient pas ?', a: 'Livraisons en retard', key: true }], implication: [{ q: 'Conséquence ?', a: 'Chantier à l’arrêt 3 jours' }] });
  check('SPIN : l’assistant saisit la fiche', r.status === 201, r.json);
  r = await mem('GET', `${C}/spin-synthesis?oppId=${opp1}`);
  check('SPIN : synthèse partielle 55/100', r.json.completeness === 55 && r.json.counts.problem === 1 && r.json.need.problem === 'Livraisons en retard', r.json);
  r = await mem('POST', `${C}/spin`, { oppId: opp1, implication: [{ q: 'Coût ?', a: '2 M FCFA de pénalités' }], payoff: [{ q: 'Que gagneriez-vous ?', a: 'Livraison garantie en 48 h' }] });
  r = await mem('GET', `${C}/spin-synthesis?oppId=${opp1}`);
  check('SPIN : après 2 fiches, 100/100 et besoin explicite', r.json.completeness === 100 && r.json.maturity === 'explicit' && /Bénéfice attendu : Livraison/.test(r.json.text), r.json);
  r = await mem('POST', `${C}/spin-synthesis/note`, { oppId: opp1 });
  check('SPIN : note structurée rattachée à l’opportunité', r.status === 201 && /Synthèse SPIN \(100\/100\)/.test(r.json.body), r.json);
  r = await mem('GET', `${C}/notes?oppId=${opp1}`);
  check('SPIN : la note est dans l’opportunité', r.json.notes.length === 1, r.json);
  r = await other('GET', `${C}/spin-synthesis?oppId=${opp1}`);
  check('isolation : SPIN d’une autre organisation inaccessible', r.status === 404, r.status);

  // ---------- Objectifs et prévision ----------
  r = await mem('PUT', `${C}/targets`, { period: m0, value: 2000000 });
  check('objectifs : l’assistant ne fixe pas d’objectif', r.status === 403, r.status);
  r = await mgr('PUT', `${C}/targets`, { period: m0, value: 2000000 });
  check('objectifs : le responsable commercial fixe 2 000 000', r.status === 200, r.json);
  const inv = async (month, day, amount) => { r = await owner('POST', `${O}/crm/documents`, { customerId: alpha, kind: 'invoice', issued: `${month}-${day}`, lines: [{ label: 'Vente', quantity: 1, price: amount }] }); await owner('PUT', `${O}/crm/documents/${r.json.id}`, { status: 'sent' }); };
  await inv(L.addMonths(m0, -3), '10', 100000); await inv(L.addMonths(m0, -2), '10', 200000); await inv(L.addMonths(m0, -1), '10', 300000);
  r = await owner('POST', `${O}/crm/documents`, { customerId: alpha, kind: 'invoice', issued: today, lines: [{ label: 'Vente', quantity: 1, price: 150000 }] });
  await owner('PUT', `${O}/crm/documents/${r.json.id}`, { status: 'sent' });
  r = await mgr('GET', `${C}/forecast?months=2`);
  const f = r.json; const a = f.months[0]; const b = f.months[1];
  check('tendance : moyenne mobile 200 000, lissage 204 000', f.trend.movingAverage === 200000 && f.trend.ses === 204000, f.trend);
  check('mois en cours : réalisé 150 000 + pondéré 500 000 (50 % × 1 M)', a.month === m0 && a.realized === 150000 && a.weighted === 500000 && a.pipelineAmount === 1000000, a);
  check('scénarios : 500 000 / 650 000 / 775 000', a.scenarios.pessimistic === 500000 && a.scenarios.central === 650000 && a.scenarios.optimistic === 775000, a.scenarios);
  check('atterrissage vs objectif : 32,5 % (écart −1 350 000)', a.target === 2000000 && a.attainmentCentral === 32.5 && a.gapCentral === -1350000, a);
  check('prévision consolidée : 60 % × 650 000 + 40 % × 204 000 = 471 600', a.blended === 471600, a.blended);
  check('mois suivant : pondéré 100 000 (25 % × 400 000), scénarios 70 000 / 100 000 / 125 000', b.month === next && b.weighted === 100000 && b.scenarios.pessimistic === 70000 && b.scenarios.optimistic === 125000, b);
  r = await mgr('GET', `${C}/forecast/breakdown?by=owner`);
  check('par commercial : pondéré total 600 000', r.json.total.weighted === 600000 && r.json.rows[0].label === 'Marc' && r.json.rows[0].weighted === 600000, r.json);
  r = await mgr('GET', `${C}/forecast/breakdown?by=month`);
  check('par mois : deux mois de clôture', r.json.rows.length === 2 && r.json.rows[0].weighted === 500000, r.json.rows);
  r = await mgr('GET', `${C}/forecast/variance?months=3`);
  check('écart objectif/réalisé : mois en cours 150 000 − 2 000 000', r.json.rows[r.json.rows.length - 1].gap === -1850000 && r.json.rows[r.json.rows.length - 1].inProgress, r.json.rows);

  // ---------- Devis ----------
  r = await owner('POST', `${O}/sales/catalog`, { name: 'Ciment 50kg', price: 5000, unit: 'sac' });
  const lines = (price) => [{ label: 'Ciment 50kg', quantity: 10, price }];
  r = await mem('POST', `${C}/quotes`, { customerId: alpha, lines: lines(4900), oppId: opp1 });
  const q0 = r.json.id;
  check('devis : remise 2 % ≤ plafond de l’assistant (5 %) → pas de validation', r.status === 201 && r.json.discountPct === 2 && r.json.approvalRequired === false, r.json);
  r = await mem('POST', `${C}/quotes`, { customerId: alpha, lines: lines(4500), oppId: opp1, conditions: 'Paiement à 30 jours', validityDays: 15 });
  const q1 = r.json.id;
  check('devis : remise 10 % > 5 % → validation requise', r.json.discountPct === 10 && r.json.approvalRequired === true && r.json.cap === 5, r.json);
  r = await owner('PUT', `${O}/crm/documents/${q1}`, { status: 'sent' });
  check('circuit : envoi bloqué tant que la remise n’est pas validée', r.status === 409 && /validation/.test(r.json.error), r.json);
  r = await mem('POST', `${C}/quotes/${q1}/request-approval`, { reason: 'Gros client' });
  check('circuit : l’assistant demande la validation', r.status === 200, r.json);
  r = await mem('POST', `${C}/quotes/${q1}/decide`, { decision: 'approve' });
  check('circuit : l’assistant ne valide pas', r.status === 403, r.status);
  r = await mgr('GET', `${C}/quotes-approvals`);
  check('circuit : le responsable voit la demande', r.json.quotes.length === 1 && r.json.quotes[0].id === q1, r.json);
  r = await mgr('POST', `${C}/quotes/${q1}/decide`, { decision: 'approve', comment: 'OK client fidèle' });
  check('circuit : remise de 10 % validée par le responsable commercial (plafond 30 %)', r.status === 200, r.json);
  r = await owner('PUT', `${O}/crm/documents/${q1}`, { status: 'sent' });
  check('circuit : le devis peut partir', r.status === 200, r.json);
  r = await mem('POST', `${C}/quotes`, { customerId: alpha, lines: lines(3000) });
  const q2 = r.json.id;
  check('devis : remise 40 %', r.json.discountPct === 40 && r.json.approvalRequired, r.json);
  await mem('POST', `${C}/quotes/${q2}/request-approval`, {});
  r = await mgr('POST', `${C}/quotes/${q2}/decide`, { decision: 'approve' });
  check('circuit : 40 % dépasse les pouvoirs du responsable commercial (30 %)', r.status === 403 && /au-delà/.test(r.json.error), r.json);
  r = await owner('POST', `${C}/quotes/${q2}/decide`, { decision: 'approve' });
  check('circuit : le responsable du compte valide 40 %', r.status === 200, r.json);
  r = await mem('PUT', `${C}/quotes/${q1}`, { lines: lines(4500) });
  check('devis : un devis envoyé ne change pas de lignes (nouvelle version)', r.status === 400, r.json);
  r = await mem('POST', `${C}/quotes/${q1}/version`, {});
  const q1v2 = r.json.id;
  r = await mem('GET', `${C}/quotes/${q1v2}`);
  check('version : v2 dans le même groupe, v1 remplacée', r.json.quote.version === 2 && r.json.versions.length === 2 && r.json.versions.find((v) => v.id === q1).superseded, r.json.versions);
  r = await mem('GET', `${C}/quotes`);
  check('liste : les versions remplacées sont masquées', !r.json.quotes.some((q) => q.id === q1) && r.json.quotes.some((q) => q.id === q1v2), r.json.quotes.map((q) => q.id));
  r = await mem('POST', `${C}/quotes/${q1v2}/variant`, { variant: 'Option économique' });
  check('variante créée', r.status === 201, r.json);
  r = await owner('PUT', `${O}/crm/documents/${q1v2}`, { status: 'sent' });
  check('v2 (même remise) : validation à redemander avant envoi', r.status === 409, r.json);

  // Acceptation par lien
  r = await mem('POST', `${C}/quotes/${q0}/link`, {});
  const tok = r.json.token;
  check('lien : jeton secret de 48 caractères', /^[a-f0-9]{48}$/.test(tok) && r.json.path === `/devis/${tok}`, r.json);
  const pubBase = `/api/ws/public/quote/${tok}`;
  r = await other('GET', pubBase);
  check('lien public : le devis brouillon se consulte mais ne se répond pas', r.status === 200 && r.json.number && r.json.canAnswer === false && r.json.total === 49000, r.json);
  r = await other('POST', `${pubBase}/accept`, { name: 'Kamga' });
  check('lien public : un brouillon ne s’accepte pas', r.status === 409, r.json);
  await owner('PUT', `${O}/crm/documents/${q0}`, { status: 'sent' });
  r = await other('POST', `${pubBase}/accept`, { name: '' });
  check('lien public : le nom est obligatoire', r.status === 400, r.json);
  r = await other('POST', `${pubBase}/accept`, { name: 'M. Kamga' });
  check('lien public : acceptation enregistrée', r.status === 200 && r.json.status === 'accepted', r.json);
  r = await other('POST', `${pubBase}/accept`, { name: 'M. Kamga' });
  check('lien public : pas de seconde réponse', r.status === 409, r.json);
  r = await other('GET', '/api/ws/public/quote/' + 'a'.repeat(48));
  check('lien public : jeton inconnu → 404', r.status === 404, r.status);
  r = await mem('GET', `${C}/quotes/${q0}`);
  check('suivi : acceptation tracée (nom, date) et devis ouvert par le client', r.json.quote.status === 'accepted' && r.json.quote.acceptedName === 'M. Kamga' && r.json.quote.viewedAt, r.json.quote);
  r = await owner('POST', `${O}/crm/documents/${q0}/order`, {});
  check('conversion : devis accepté → commande', r.status === 201, r.json);
  r = await mem('GET', `${C}/quotes/${q0}`);
  check('suivi : la commande apparaît dans la chaîne devis → commande', r.json.chain.orders.length === 1, r.json.chain);
  r = await mgr('GET', `${C}/quotes/stats`);
  check('statistiques : 1 accepté, 0 refusé → taux 100 %', r.json.accepted === 1 && r.json.refused === 0 && r.json.acceptanceRate === 100, r.json);
  // Validité dépassée
  r = await mem('POST', `${C}/quotes`, { customerId: alpha, lines: lines(5000) });
  const q3 = r.json.id;
  r = await mem('POST', `${C}/quotes/${q3}/link`, {});
  await owner('PUT', `${O}/crm/documents/${q3}`, { status: 'sent' });
  await dbx.prepare('UPDATE cp_quote_meta SET valid_until = ? WHERE doc_id = ?').run('2020-01-01', q3);
  r = await other('POST', `/api/ws/public/quote/${(await dbx.prepare('SELECT accept_token t FROM cp_quote_meta WHERE doc_id = ?').get(q3)).t}/accept`, { name: 'Tardif' });
  check('validité : un devis expiré ne s’accepte plus', r.status === 410, r.json);
  r = await mem('POST', `${C}/quotes/${q3}/followup`, {});
  check('relance : cadence « Relance de devis » créée et démarrée', r.status === 201, r.json);
  r = await mem('POST', `${C}/quotes/${q3}/followup`, {});
  check('relance : pas de doublon', r.status === 409, r.json);
  r = await mem('GET', `${C}/quotes/pending`);
  check('suivi : devis envoyés sans réponse listés', r.json.quotes.some((q) => q.id === q3 && q.expired), r.json.quotes.map((q) => q.id));
  r = await other('GET', `${C}/quotes`);
  check('isolation : devis d’une autre organisation inaccessibles', r.status === 404, r.status);
});
