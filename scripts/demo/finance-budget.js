'use strict';
// Démonstration · groupe « finance » : budget annuel par poste (prévu / réalisé lu dans la comptabilité), écarts, engagements,
// trésorerie prévisionnelle, validation des dépenses au-delà d'un seuil, pilotage (atterrissage, scénarios), puis fiscalité.

const PLAN = [ // catégorie, montant mensuel prévu (FCFA), type
  ['Ventes', 33000000, 'income'], ['Autres produits', 150000, 'income'],
  ['Achats', 20500000, 'expense'], ['Salaires', 3700000, 'expense'], ['Loyer', 700000, 'expense'], ['Transport', 700000, 'expense'],
  ['Services extérieurs', 450000, 'expense'], ['Télécoms', 250000, 'expense'], ['Assurances', 125000, 'expense'], ['Maintenance', 200000, 'expense'],
  ['Marketing', 150000, 'expense'], ['Honoraires', 100000, 'expense'], ['Frais bancaires', 40000, 'expense'], ['Frais financiers', 250000, 'expense'],
  ['Amortissements', 900000, 'expense'], ['Impôts et taxes', 100000, 'expense'],
];
const SEAS = [0.9, 1, 1.15, 1.1, 1.05, 0.95, 0.75, 0.7, 0.8, 1, 1.1, 1.2];

async function budget(ctx, h) {
  const { Y, T, M0, addMonth } = h;
  const B = (f, m, u, b, o = {}) => ctx.do(f, m, '/budget' + u, b, { as: 'accountant', ...o });
  const M = (f, m, u, b, o = {}) => ctx.do(f, m, '/budget' + u, b, { as: 'manager', ...o });
  // Réglages
  await B('Budget : correspondance comptes → postes du budget', 'GET', '/map');
  await B('Budget : ranger le carburant (6058) dans « Transport »', 'PUT', '/map', { map: [{ prefix: '6058', category: 'Transport' }, { prefix: '6052', category: 'Services extérieurs' }, { prefix: '6051', category: 'Services extérieurs' }] });
  await B('Budget : seuil de validation des dépenses (1 000 000 FCFA)', 'PUT', '/settings', { approvalThreshold: 1000000 });
  await M('Budget : le responsable voit le seuil', 'GET', '/settings');
  await M('Budget : un responsable ne fixe pas le seuil (refus attendu)', 'PUT', '/settings', { approvalThreshold: 0 }, { expect: 403 });
  await B('Budget : limites mensuelles par poste', 'PUT', '/plans', { plans: [{ category: 'Transport', monthlyLimit: 750000 }, { category: 'Maintenance', monthlyLimit: 250000 }, { category: 'Marketing', monthlyLimit: 200000 }, { category: 'Fournitures', monthlyLimit: 120000 }, { category: 'Télécoms', monthlyLimit: 260000 }] });
  // Budget annuel de l'exercice (12 montants par poste, saisonnalité des ventes et des achats)
  const lines = PLAN.map(([category, m, kind]) => ({ kind, category, amounts: SEAS.map((s) => Math.round((['Ventes', 'Achats'].includes(category) ? m * s : m) / 1000) * 1000) }));
  await B(`Budget annuel ${Y} : saisir le prévu par poste et par mois`, 'PUT', '/annual', { year: Y, lines });
  await B('Budget annuel : il faut 12 montants (refus attendu)', 'PUT', '/annual', { year: Y, lines: [{ kind: 'expense', category: 'Loyer', amounts: [1, 2, 3] }] }, { expect: 400 });
  await B(`Budget annuel ${Y + 1} : point de départ depuis les limites mensuelles`, 'POST', '/annual/init', { year: Y + 1 }, { expect: [201, 409] });
  await B(`Budget annuel ${Y + 1} : déjà initialisé (refus attendu)`, 'POST', '/annual/init', { year: Y + 1 }, { expect: 409 });
  await B(`Budget annuel ${Y + 1}`, 'GET', `/annual?year=${Y + 1}`);
  // Saisies du responsable (hors compta) et demandes au-delà du seuil
  const br = ctx.ids.branches;
  const mine = [];
  for (const [i, [cat, label, amt, b]] of [['Transport', 'Gasoil groupe électrogène du dépôt', 85000, br.douala], ['Fournitures', 'Fournitures de bureau (rames, classeurs)', 62500, br.douala], ['Transport', 'Taxi-moto livraisons urgentes Mvan', 35000, br.yaounde], ['Maintenance', 'Réparation porte du magasin', 48000, br.yaounde]].entries()) {
    for (const k of [2, 1, 0]) { const d = h.on(addMonth(M0, -k), 6 + i * 5) || T; const r = await M(`Budget : ${label} (${d.slice(0, 7)})`, 'POST', '/entries', { kind: 'expense', category: cat, label, amount: amt + k * 2500, date: d, branchId: b }); if (r.id) mine.push(r.id); }
  }
  await M('Budget : recette hors compta (vente de sacs vides)', 'POST', '/entries', { kind: 'income', category: 'Autres produits', label: 'Vente de sacs de ciment vides au recycleur', amount: 45000, date: h.on(M0, 3) || T, branchId: br.douala });
  if (mine[0]) await M('Budget : corriger une saisie', 'PUT', `/entries/${mine[0]}`, { label: 'Gasoil groupe électrogène du dépôt (coupure ENEO)', amount: 92000 });
  if (mine[1]) await M('Budget : modifier au-delà du seuil (refus attendu)', 'PUT', `/entries/${mine[1]}`, { amount: 1500000 }, { expect: 403 });
  const oops = await M('Budget : saisie en double', 'POST', '/entries', { kind: 'expense', category: 'Fournitures', label: 'Doublon', amount: 62500, date: T });
  if (oops.id) await M('Budget : supprimer le doublon', 'DELETE', `/entries/${oops.id}`);
  await M('Budget : un responsable n\'inscrit pas en comptabilité (refus attendu)', 'POST', '/entries', { kind: 'expense', category: 'Maintenance', amount: 10000, ledger: true, account: '624' }, { expect: 403 });
  const r1 = await M('Budget : demande de dépense au-delà du seuil (révision du chariot élévateur)', 'POST', '/entries', { kind: 'expense', category: 'Maintenance', label: 'Révision complète du chariot élévateur Toyota', amount: 1750000, date: T, branchId: br.douala }, { expect: 202 });
  const r2 = await M('Budget : demande de dépense au-delà du seuil (campagne radio)', 'POST', '/entries', { kind: 'expense', category: 'Marketing', label: 'Campagne radio Équinoxe + affichage Akwa (décembre)', amount: 2400000, date: T }, { expect: 202 });
  await M('Budget : le responsable suit ses demandes', 'GET', '/requests');
  await B('Budget : demandes en attente de validation', 'GET', '/requests?status=pending');
  if (r1.requestId) await B('Budget : la RAF accepte la révision du chariot', 'POST', `/requests/${r1.requestId}/decide`, { decision: 'approved', note: 'Sécurité du dépôt : prioritaire' });
  if (r2.requestId) {
    await B('Budget : refus sans motif (refus attendu)', 'POST', `/requests/${r2.requestId}/decide`, { decision: 'rejected' }, { expect: 400 });
    await B('Budget : la RAF refuse la campagne radio (motif)', 'POST', `/requests/${r2.requestId}/decide`, { decision: 'rejected', note: 'Budget marketing déjà dépassé : reporter en janvier' });
    await M('Budget : un responsable ne valide pas (refus attendu)', 'POST', `/requests/${r2.requestId}/decide`, { decision: 'approved' }, { expect: 403 });
  }
  // Saisie unique budget + comptabilité (administrateur)
  await B('Budget : dépense inscrite aussi en comptabilité (réparation climatiseur, espèces)', 'POST', '/entries', { kind: 'expense', category: 'Maintenance', label: 'Réparation climatiseur du bureau', amount: 180000, date: T, ledger: true, account: '624', payment: 'cash' });
  await B('Budget : compte de produit pour une sortie (refus attendu)', 'POST', '/entries', { kind: 'expense', category: 'Maintenance', amount: 1000, ledger: true, account: '701' }, { expect: 400 });
  // Doublon probable avec la compta : forfaits MTN du mois dernier saisis aussi au budget
  const tel = h.on(addMonth(M0, -1), 9);
  if (tel) {
    const dupl = await M('Budget : forfaits MTN saisis aussi au budget (doublon de la compta)', 'POST', '/entries', { kind: 'expense', category: 'Télécoms', label: 'Forfaits MTN et Orange', amount: 185000, date: tel });
    const d = await B(`Budget : doublons probables budget / compta ${Y}`, 'GET', `/duplicates?year=${Y}`);
    const pair = (d.duplicates || []).find((x) => x.budgetEntryId === dupl.id);
    ctx.check('Budget : le doublon avec la comptabilité est détecté', !!pair, d.duplicates);
    if (pair) await B('Budget : lier le doublon à l\'écriture comptable', 'POST', '/duplicates/link', { pairs: [{ budgetEntryId: pair.budgetEntryId, accEntryId: pair.accEntryId }] });
  }
  if (mine[2]) await B('Budget : marquer une saisie « déjà en comptabilité »', 'PUT', `/entries/${mine[2]}/ledger`, { inLedger: true });
  // Lectures
  const mon = await M(`Budget : vue mensuelle du responsable (${M0})`, 'GET', `?month=${M0}`);
  ctx.check('Budget : la vue mensuelle montre les postes et leurs limites', (mon.categories || []).some((c) => c.limit), mon.categories);
  await M('Budget : mois précédent', 'GET', `?month=${addMonth(M0, -1)}`);
  await M('Budget : le responsable n\'accède pas au budget annuel (refus attendu)', 'GET', `/annual?year=${Y}`, undefined, { expect: 403 });
  const an = await B(`Budget annuel ${Y} : prévu, réalisé (comptabilité), écarts`, 'GET', `/annual?year=${Y}`);
  const sales = (an.lines || []).find((l) => l.category === 'Ventes');
  ctx.check('Budget annuel : le réalisé des ventes vient de la comptabilité', sales && sales.realizedTotal > 100000000, sales && { planned: sales.plannedTotal, realized: sales.realizedTotal });
  ctx.check('Budget annuel : au moins un poste en dépassement', (an.lines || []).some((l) => l.overBudget || (l.kind === 'expense' && !l.favorable)), (an.lines || []).map((l) => [l.category, l.gap]));
  await B('Budget : engagements (commandes validées, factures fournisseurs à payer)', 'GET', '/commitments');
  const cf = await B('Budget : trésorerie prévisionnelle sur 6 mois (encaissement à 85 %)', 'GET', '/cashflow?months=6&collectRate=85');
  ctx.check('Trésorerie prévisionnelle : 6 mois calculés', (cf.months || []).length === 6, cf.alert);
  await B('Budget : trésorerie prévisionnelle à 3 mois', 'GET', '/cashflow?months=3');
  const pro = await B(`Pilotage ${Y} : atterrissage, fourchette, scénarios (+10 % / −15 %)`, 'GET', `/pro?year=${Y}&optimistic=10&pessimistic=15`);
  const k = pro.kpis || {};
  ctx.check('Pilotage : atterrissage de fin d\'année vraisemblable (± 50 % du prévu)', k.expenseLanding > k.expenseActual && k.expenseLanding < k.expensePlanned * 1.5 && k.incomeLanding < k.incomePlanned * 1.5, { expense: [k.expensePlanned, k.expenseActual, k.expenseLanding], income: [k.incomePlanned, k.incomeActual, k.incomeLanding] });
  await B('Pilotage : détail des achats jusqu\'aux écritures', 'GET', `/pro/drill?year=${Y}&kind=expense&category=Achats`);
  await B(`Pilotage : détail du transport en ${addMonth(M0, -1)}`, 'GET', `/pro/drill?year=${Y}&kind=expense&category=Transport&month=${Number(addMonth(M0, -1).slice(5))}`);
  await h.csv(`Pilotage : export du budget ${Y} (CSV)`, `/budget/pro/export.csv?year=${Y}`, 'Catégorie');
}

async function fiscal(ctx, h) {
  const F = ctx.ids.finance; const { Y, T, M0, addMonth, addDays } = h;
  const X = (f, m, u, b, o = {}) => ctx.do(f, m, '/fiscal' + u, b, { as: 'accountant', ...o });
  const obl = await X('Fiscalité : calendrier fiscal (modèles d\'échéances)', 'GET', '/obligations');
  ctx.check('Fiscalité : modèles proposés (TVA, acompte, CNPS, IS, patente, DSF)', (obl.templates || []).length >= 6, (obl.templates || []).map((t) => t.key));
  const M1 = addMonth(M0, -1); const M2 = addMonth(M0, -2);
  const vat1 = F.vat[M1] || {}; const vat2 = F.vat[M2] || {};
  const d15 = (ym) => `${ym}-15`;
  const mk = (f, body) => X(f, 'POST', '/obligations', body);
  const tva2 = await mk(`Fiscalité : TVA de ${M2} (déposée et payée)`, { title: 'Déclaration et paiement de la TVA', kind: 'tva', period: M2, dueDate: d15(M1), amount: vat2.due || 0, recurrence: 'monthly', repeat: true, note: 'Télédéclaration sur le portail de la DGI' });
  if (tva2.id) await X('Fiscalité : marquer la TVA payée (la suivante est créée automatiquement)', 'PUT', `/obligations/${tva2.id}`, { status: 'paid', reference: `Quittance DGI n° Q${M2.replace('-', '')}-0457` });
  const acpt = await mk(`Fiscalité : acompte d'impôt de ${M1} (en retard)`, { title: 'Acompte mensuel de l\'impôt sur les sociétés (2,2 % du CA)', kind: 'acompte', period: M1, dueDate: T > d15(M0) ? d15(M0) : d15(M1), amount: 780000, recurrence: 'monthly', repeat: false });
  const cnps = await mk(`Fiscalité : cotisations CNPS de ${M1}`, { title: 'Déclaration et versement des cotisations CNPS', kind: 'social', period: M1, dueDate: d15(M0), amount: 0, recurrence: 'monthly' });
  if (cnps.id) await X('Fiscalité : créer à la main l\'échéance CNPS suivante', 'POST', `/obligations/${cnps.id}/next`);
  if (cnps.id) await X('Fiscalité : échéance suivante déjà créée (refus attendu)', 'POST', `/obligations/${cnps.id}/next`, undefined, { expect: 409 });
  await mk('Fiscalité : patente de l\'année prochaine', { title: 'Patente (contribution des patentes)', kind: 'patente', period: String(Y + 1), dueDate: `${Y + 1}-02-28`, amount: 1150000, recurrence: 'yearly', repeat: true });
  await mk(`Fiscalité : IS et DSF de l'exercice ${Y}`, { title: 'Déclaration statistique et fiscale (DSF) et solde de l\'IS', kind: 'etats', period: String(Y), dueDate: `${Y + 1}-03-15`, amount: 0, recurrence: 'yearly', repeat: true, note: 'Liasse SYSCOHADA à valider par l\'expert-comptable' });
  if (acpt.id) await X('Fiscalité : préciser le montant de l\'acompte', 'PUT', `/obligations/${acpt.id}`, { amount: 812000, note: 'CA HT du mois × 2,2 %' });
  const bad = await mk('Fiscalité : échéance créée par erreur', { title: 'Taxe à l\'essieu (ne concerne pas Batimat)', kind: 'other', dueDate: addDays(T, 20) });
  if (bad.id) await X('Fiscalité : supprimer l\'échéance erronée', 'DELETE', `/obligations/${bad.id}`);
  await X('Fiscalité : répétition sans périodicité (refus attendu)', 'POST', '/obligations', { title: 'Essai', dueDate: T, recurrence: 'none', repeat: true }, { expect: 400 });
  if (vat1.due) await mk(`Fiscalité : TVA de ${M1} à déclarer`, { title: `TVA ${M1}`, kind: 'tva', period: M1, dueDate: d15(M0), amount: vat1.due, recurrence: 'none' });
  const after = await X('Fiscalité : échéances en retard et à venir', 'GET', '/obligations');
  ctx.check('Fiscalité : une échéance en retard signalée', (after.late || []).length >= 1, (after.items || []).map((o) => [o.title, o.dueDate, o.status]));
  ctx.check('Fiscalité : l\'échéance TVA suivante a été créée automatiquement', (after.items || []).some((o) => o.parentId === tva2.id), null);
  await X(`Fiscalité : TVA du mois ${M1}`, 'GET', `/vat?month=${M1}`);
  const ls = await X(`Fiscalité : liasse de travail ${Y} (bilan, résultat, SIG)`, 'GET', `/liasse?year=${Y}`);
  ctx.check(`Fiscalité : liasse ${Y} équilibrée`, ls.bilan && ls.bilan.equilibre && ls.toFix === 0, { equilibre: ls.bilan && ls.bilan.equilibre, toFix: ls.toFix, issues: (ls.issues || []).map((i) => i.code) });
  ctx.check('Fiscalité : soldes intermédiaires de gestion (marge, valeur ajoutée, EBE)', ls.sig && ls.sig.chiffreAffaires > 0, ls.sig);
  await X('Fiscalité : tableau de correspondance des comptes (classes 1 à 8, SIG)', 'GET', '/classification');
  await X('Fiscalité : exercices et verrous', 'GET', '/exercises');
  await X(`Fiscalité : exercice ${Y} non terminé (refus attendu)`, 'POST', `/exercises/${Y}/close`, undefined, { expect: 400 });
  const dash = await X(`Fiscalité : tableau de bord ${Y}`, 'GET', `?year=${Y}`);
  ctx.check('Fiscalité : tableau de bord (résultat, CA, retards)', dash.kpi && dash.kpi.chiffreAffaires > 0, dash.kpi);
  await ctx.do('Fiscalité : un responsable n\'y accède pas (refus attendu)', 'GET', '/fiscal', undefined, { as: 'manager', expect: 403 });
}

module.exports = { budget, fiscal };
