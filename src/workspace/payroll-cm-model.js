'use strict';
// Modèle de paie CAMEROUN : paramètres chiffrés, VERSIONNÉS, avec pour chacun un niveau de confiance et la source supposée.
//
// HONNÊTETÉ : ces valeurs viennent de la connaissance de l'auteur du code (barèmes usuels CNPS / DGI), PAS d'une publication officielle
// relue le jour de l'encodage. Elles ne doivent JAMAIS être présentées comme officielles. Chaque valeur est modifiable par l'organisation
// (table payroll_cm_overrides). Quand le doute est fort, la valeur par défaut est VIDE (null) plutôt qu'inventée : le calcul traite alors la
// rubrique comme « à compléter » (montant 0) et l'écran le signale.
//   confiance : 'high'   = valeur très couramment publiée et stable ;
//               'medium' = valeur probablement exacte mais à confirmer (plafonds, taux patronaux, méthode) ;
//               'low'    = convention d'entreprise ou valeur dépendant du cas : à décider/confirmer par l'organisation.
// « sources » : sources SUPPOSÉES (textes ou organismes où retrouver la valeur), non vérifiées automatiquement.

const WARNING = 'Barème à faire valider par un expert-comptable ou le CNPS/DGI avant usage officiel. '
  + "Ces taux sont un point de départ chiffré d'après la connaissance de l'auteur du logiciel : ils ne sont pas présentés comme officiels et peuvent être dépassés.";

const p = (key, group, label, unit, value, confidence, source, note) => ({ key, group, label, unit, value, confidence, source, note: note || '' });

// Version courante. Pour une évolution du barème : AJOUTER une entrée (jamais modifier une ancienne) avec une nouvelle validFrom.
const VERSIONS = [
  {
    version: '2026.1',
    validFrom: '2026-01',
    // Date d'encodage du modèle (pas une date de vérification officielle). La vérification est datée par l'organisation (« à jour au »).
    asOf: '2026-10-27',
    params: [
      // ---- CNPS (Caisse nationale de prévoyance sociale) ----
      p('cnps.pension.employee', 'cnps', 'CNPS · Assurance vieillesse (PVID), part salariale', '%', 2.8, 'high', 'CNPS, taux de cotisation PVID (supposé : 2,8 % salarié)'),
      p('cnps.pension.employer', 'cnps', 'CNPS · Assurance vieillesse (PVID), part patronale', '%', 4.2, 'medium', 'CNPS, taux de cotisation PVID (supposé : 4,2 % employeur)'),
      p('cnps.family.employer', 'cnps', 'CNPS · Prestations familiales (employeur)', '%', 7, 'high', 'CNPS, prestations familiales (supposé : 7 % employeur)'),
      p('cnps.accident.employer', 'cnps', 'CNPS · Accidents du travail et maladies professionnelles (employeur)', '%', null, 'low', 'CNPS : le taux dépend de la classe de risque de l\'entreprise',
        "VIDE volontairement : le taux dépend de la classe de risque (des valeurs de l'ordre de 1,75 % à 5 % existent, à confirmer auprès du CNPS)."),
      p('cnps.ceiling', 'cnps', 'CNPS · Plafond mensuel de l\'assiette', 'FCFA', 750000, 'medium', 'CNPS, plafond de rémunération soumis à cotisation (supposé : 750 000 FCFA par mois)'),
      // ---- IRPP (impôt sur le revenu des personnes physiques, salaires) ----
      p('irpp.expenses.rate', 'irpp', 'IRPP · Abattement forfaitaire pour frais professionnels', '%', 30, 'high', 'Code général des impôts (DGI) : 30 % du revenu brut imposable (supposé)'),
      p('irpp.allowance.annual', 'irpp', 'IRPP · Abattement annuel forfaitaire', 'FCFA', 500000, 'high', 'Code général des impôts (DGI) : abattement de 500 000 FCFA par an (supposé)'),
      p('irpp.cnps.deductible', 'irpp', 'IRPP · Cotisation vieillesse salariale déduite de la base (1 = oui, 0 = non)', '', 1, 'medium', 'Code général des impôts (DGI) : retenues pour pension déductibles (supposé)'),
      p('irpp.quotite', 'irpp', 'IRPP · Quotité imposable du brut mensuel', '%', null, 'low', 'À préciser avec le centre des impôts',
        "VIDE volontairement (traité comme 100 %). La notion de « quotité » (part du brut retenue dans la base) dépend du cas : à confirmer avec la DGI ou un expert."),
      p('irpp.t1.limit', 'irpp', 'IRPP · Tranche 1 : jusqu\'à (revenu net annuel)', 'FCFA', 2000000, 'high', 'Code général des impôts (DGI), barème progressif (supposé)'),
      p('irpp.t1.rate', 'irpp', 'IRPP · Taux de la tranche 1', '%', 10, 'high', 'Code général des impôts (DGI), barème progressif (supposé)'),
      p('irpp.t2.limit', 'irpp', 'IRPP · Tranche 2 : jusqu\'à', 'FCFA', 3000000, 'high', 'Code général des impôts (DGI), barème progressif (supposé)'),
      p('irpp.t2.rate', 'irpp', 'IRPP · Taux de la tranche 2', '%', 15, 'high', 'Code général des impôts (DGI), barème progressif (supposé)'),
      p('irpp.t3.limit', 'irpp', 'IRPP · Tranche 3 : jusqu\'à', 'FCFA', 5000000, 'high', 'Code général des impôts (DGI), barème progressif (supposé)'),
      p('irpp.t3.rate', 'irpp', 'IRPP · Taux de la tranche 3', '%', 25, 'high', 'Code général des impôts (DGI), barème progressif (supposé)'),
      p('irpp.t4.rate', 'irpp', 'IRPP · Taux au-delà de la tranche 3', '%', 35, 'high', 'Code général des impôts (DGI), barème progressif (supposé)'),
      // ---- Taxes additionnelles ----
      p('cac.rate', 'taxes', 'CAC · Centimes additionnels communaux (en % de l\'IRPP)', '%', 10, 'high', 'Code général des impôts (DGI) : 10 % de l\'IRPP (supposé)'),
      p('cfc.employee', 'taxes', 'CFC · Contribution au Crédit foncier, part salariale (sur le brut)', '%', 1, 'high', 'Crédit foncier du Cameroun / DGI (supposé : 1 % salarié)'),
      p('cfc.employer', 'taxes', 'CFC · Contribution au Crédit foncier, part patronale (sur le brut)', '%', 1.5, 'medium', 'Crédit foncier du Cameroun / DGI (supposé : 1,5 % employeur)'),
      p('fne.employer', 'taxes', 'FNE · Fonds national de l\'emploi (employeur, sur le brut)', '%', 1, 'high', 'Fonds national de l\'emploi (supposé : 1 % employeur)'),
      // ---- Conventions de calcul (décidées par l'organisation) ----
      p('absence.divisor', 'rules', 'Absences non payées : diviseur du salaire mensuel (jours)', 'jours', 30, 'low', 'Convention de calcul courante (mois de 30 jours) ; certaines entreprises utilisent 26', 'À confirmer avec votre convention collective ou votre règlement intérieur.'),
      p('leave.daysPerMonth', 'rules', 'Congé payé acquis par mois de travail', 'jours', 1.5, 'medium', 'Code du travail du Cameroun : 1,5 jour ouvrable par mois (supposé)', 'Peut être plus favorable selon la convention collective.'),
    ],
  },
];

// Ce que ce modèle ne calcule PAS (affiché à l'écran pour ne pas donner une fausse impression d'exhaustivité).
const NOT_MODELED = [
  'Redevance audiovisuelle (RAV) et taxe de développement local / taxe communale',
  'Avantages en nature, indemnités exonérées (transport, logement) et plafonds d\'exonération',
  'Charges de famille éventuelles et régimes particuliers (expatriés, conventions de non double imposition)',
  'Préavis et indemnité de licenciement du solde de tout compte (barème de la convention collective : à saisir, non calculé)',
  'Régularisation annuelle de l\'IRPP (le calcul est mensuel et suppose un salaire stable)',
];

const versionFor = (month) => {
  const sorted = VERSIONS.slice().sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  let v = sorted[0];
  for (const x of sorted) if (!month || x.validFrom <= month) v = x;
  return v;
};

const KEYS = (version) => new Set(version.params.map((x) => x.key));

/** Fusionne le modèle d'une version avec les surcharges de l'organisation (Map clé -> nombre). */
function resolve(version, overrides) {
  const ov = overrides || new Map();
  const list = version.params.map((x) => {
    const has = ov.has(x.key);
    const value = has ? ov.get(x.key) : x.value;
    return { ...x, default: x.value, override: has ? ov.get(x.key) : null, overridden: has, value };
  });
  return { version: version.version, validFrom: version.validFrom, asOf: version.asOf, list, values: Object.fromEntries(list.map((x) => [x.key, x.value])) };
}

const r0 = (n) => Math.round(n);

/** Impôt annuel progressif sur une base nette annuelle (entier). */
function irppAnnual(v, base) {
  if (!(base > 0)) return 0;
  const tiers = [[v['irpp.t1.limit'], v['irpp.t1.rate']], [v['irpp.t2.limit'], v['irpp.t2.rate']], [v['irpp.t3.limit'], v['irpp.t3.rate']], [Infinity, v['irpp.t4.rate']]];
  let prev = 0; let tax = 0;
  for (const [limit, rate] of tiers) {
    if (base > prev) tax += (Math.min(base, limit) - prev) * ((rate || 0) / 100);
    prev = limit;
    if (base <= limit) break;
  }
  return tax;
}

/**
 * Calcul d'un bulletin avec le modèle résolu. f = { base, bonuses, overtime, annualBonus, advances, otherDeductions, absenceDeduction }.
 * Renvoie la même forme que computeSlip (gross, employeeDeductions, employerCharges, net, employerCost, lines) + detail (déroulé de l'IRPP).
 * Les rubriques dont le taux est vide sont renvoyées avec todo: true et un montant 0.
 */
function compute(model, f) {
  const v = model.values;
  const gross = Math.max((f.base || 0) + (f.bonuses || 0) + (f.overtime || 0) + (f.annualBonus || 0) - (f.absenceDeduction || 0), 0);
  const ceiling = v['cnps.ceiling'] > 0 ? v['cnps.ceiling'] : 0;
  const capped = ceiling ? Math.min(gross, ceiling) : gross;
  const line = (kind, target, code, label, rate, basis, extra) => ({ kind, target, code, label, rate: rate === null || rate === undefined ? 0 : rate, ceiling: (extra && extra.ceiling) || 0, basis, amount: rate ? r0(basis * rate / 100) : 0, ...(rate === null || rate === undefined ? { todo: true } : {}) });
  const pensionEmp = line('employee', 'social', 'cnps_pension_emp', 'CNPS · Assurance vieillesse (PVID) salarié', v['cnps.pension.employee'], capped, { ceiling });

  // IRPP : revenu annuel brut imposable (x12) - frais professionnels - cotisation vieillesse - abattement annuel, puis barème progressif, ramené au mois.
  const quot = v['irpp.quotite'] > 0 ? v['irpp.quotite'] / 100 : 1;
  const annualGross = r0(gross * quot * 12);
  const expenses = r0(annualGross * (v['irpp.expenses.rate'] || 0) / 100);
  const cnpsDeduction = v['irpp.cnps.deductible'] ? pensionEmp.amount * 12 : 0;
  const allowance = v['irpp.allowance.annual'] || 0;
  const taxableAnnual = Math.max(annualGross - expenses - cnpsDeduction - allowance, 0);
  const irppYear = irppAnnual(v, taxableAnnual);
  const irppMonth = r0(irppYear / 12);
  const effective = gross > 0 ? Math.round(irppMonth / gross * 10000) / 100 : 0;
  const irpp = { kind: 'employee', target: 'tax', code: 'irpp', label: 'IRPP (retenue à la source, barème progressif)', rate: effective, ceiling: 0, basis: r0(taxableAnnual / 12), amount: irppMonth };
  const cac = line('employee', 'tax', 'cac', 'CAC · Centimes additionnels communaux', v['cac.rate'], irppMonth);
  const cfcEmp = line('employee', 'tax', 'cfc_emp', 'CFC · Crédit foncier salarié', v['cfc.employee'], gross);
  const lines = [
    pensionEmp, irpp, cac, cfcEmp,
    line('employer', 'social', 'cnps_pension_er', 'CNPS · Assurance vieillesse (PVID) employeur', v['cnps.pension.employer'], capped, { ceiling }),
    line('employer', 'social', 'cnps_family_er', 'CNPS · Prestations familiales employeur', v['cnps.family.employer'], capped, { ceiling }),
    line('employer', 'social', 'cnps_accident_er', 'CNPS · Accidents du travail employeur', v['cnps.accident.employer'], capped, { ceiling }),
    line('employer', 'tax', 'cfc_er', 'CFC · Crédit foncier employeur', v['cfc.employer'], gross),
    line('employer', 'tax', 'fne_er', 'FNE · Fonds national de l\'emploi employeur', v['fne.employer'], gross),
  ];
  const employeeDeductions = lines.filter((l) => l.kind === 'employee').reduce((a, l) => a + l.amount, 0);
  const employerCharges = lines.filter((l) => l.kind === 'employer').reduce((a, l) => a + l.amount, 0);
  const net = gross - employeeDeductions - (f.otherDeductions || 0) - (f.advances || 0);
  return {
    gross, employeeDeductions, employerCharges, net, employerCost: gross + employerCharges, lines,
    detail: { version: model.version, annualGross, expenses, cnpsDeduction, allowance, taxableAnnual, irppYear: r0(irppYear), irppMonth, quotite: Math.round(quot * 10000) / 100 },
  };
}

module.exports = { WARNING, VERSIONS, NOT_MODELED, versionFor, KEYS, resolve, compute, irppAnnual };
