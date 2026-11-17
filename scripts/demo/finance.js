'use strict';
// Démonstration · groupe « finance » : comptabilité SYSCOHADA, fiscalité, ressources humaines, paie Cameroun et budget de Batimat Afrique SARL.
// L'historique couvre le dernier trimestre de l'an passé (clôturé avec à-nouveaux) et l'exercice en cours jusqu'à aujourd'hui, pour que les
// états financiers, le budget annuel et les graphiques soient parlants. Le travail comptable est fait par la RAF (rôle administrateur).
const L = require('./finance-lib');
const HR = require('./finance-hr');
const ACC = require('./finance-acc');
const BU = require('./finance-budget');

module.exports = async function finance(root) {
  // En ligne, l'équipe n'a pas de compte (codes d'invitation seulement) : les appels « au nom de » se font alors en tant que dirigeant, et les
  // démonstrations de refus liées à un rôle (403, demande soumise à validation 202) n'ont pas de sens ; elles sont sautées.
  const ctx = Object.create(root);
  ctx.do = (feature, method, url, body, opts = {}) => {
    const role = opts.as || 'owner';
    if (role !== 'owner' && !root.users[role] && [].concat(opts.expect || []).some((s) => s === 403 || s === 202)) return Promise.resolve({});
    return root.do(feature, method, url, body, opts);
  };
  const h = L.make(ctx);
  const F = ctx.ids.finance = { invoices: [], bills: [], vat: {}, cash: 0, momo: 0 };
  // 1. Équipe : fiches du personnel, contrats, congés, pointage, recrutement
  await HR.hr(ctx, h);
  // 2. Comptabilité : réglages, plan, analytique, banques, écritures récurrentes
  await ACC.setup(ctx, h);
  // 3. Exercice précédent (dernier trimestre) puis clôture annuelle
  await ACC.prevYear(ctx, h, (ym, o) => ACC.month(ctx, h, ym, o));
  // 4. Paie Cameroun : modèle, barème vérifié
  await HR.payrollSetup(ctx, h);
  // 5. Exercice en cours, mois par mois (les cinq derniers mois complets passent par la paie, le mois en cours reste en brouillon)
  await ACC.yearStart(ctx, h);
  const payMonths = h.months.filter((m) => m < h.M0).slice(-5);
  for (const ym of h.months) {
    const pay = payMonths.includes(ym);
    await ACC.month(ctx, h, ym, { salary: ym === h.M0 ? 'none' : pay ? 'payroll' : 'template' });
    if (pay) await HR.payrollMonth(ctx, h, ym, 'full', payMonths.indexOf(ym));
  }
  await HR.payrollMonth(ctx, h, h.M0, 'draft', payMonths.length);
  // 6. Fin de période : emprunts, amortissements, rapprochement, lettrage, caisse, clôtures mensuelles
  await ACC.yearEnd(ctx, h);
  await HR.payrollAfter(ctx, h);
  // 7. Budget, fiscalité, états et contrôles
  await BU.budget(ctx, h);
  await BU.fiscal(ctx, h);
  await ACC.reports(ctx, h);
  F.summary = { invoices: F.invoices.length, bills: F.bills.length, closedMonths: F.closed || [] };
};
