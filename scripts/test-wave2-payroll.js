'use strict';
// Vague 2 : paie Cameroun (modèle versionné, IRPP progressif, surcharges, absences non payées, solde de tout compte, états CSV, virements).
// Lancez-le avec : node scripts/test-wave2-payroll.js
const { run } = require('./lib/wave2');

run('Paie Cameroun', async ({ check, owner, mgr, mem, other, org, O }) => {
  const P = `${O}/payroll`; const H = `${O}/hr`;
  // Accès
  let r = await mgr('GET', `${P}/cm/model`);
  check('le modèle de paie est réservé aux administrateurs', r.status === 403, r.status);
  r = await owner('GET', `${P}/cm/model`);
  check('modèle : version, date, avertissement visible', r.status === 200 && r.json.version && r.json.asOf && /valider par un expert-comptable ou le CNPS\/DGI/.test(r.json.warning), r.json && [r.json.version, r.json.warning]);
  const byKey = Object.fromEntries(r.json.params.map((x) => [x.key, x]));
  check('chaque paramètre a confiance et source supposée', r.json.params.every((x) => ['high', 'medium', 'low'].includes(x.confidence) && x.source), r.json.params.filter((x) => !x.source));
  check('taux accidents du travail VIDE (pas inventé) et signalé', byKey['cnps.accident.employer'].value === null && byKey['cnps.accident.employer'].needsInput === true && r.json.missing.includes('cnps.accident.employer'));
  check('le barème indique ce qui n\'est pas modélisé', r.json.notModeled.length >= 3);
  check('barème IRPP chiffré', byKey['irpp.t1.rate'].value === 10 && byKey['irpp.t4.rate'].value === 35 && byKey['cac.rate'].value === 10);

  // Simulation 1 : 300 000 (calcul à la main dans le commentaire)
  // PVID salarié 2,8 % = 8 400 ; base annuelle 3 600 000 - 30 % (1 080 000) - 100 800 - 500 000 = 1 919 200 ; IRPP 10 % = 191 920 / 12 = 15 993 ; CAC = 1 599 ; CFC 1 % = 3 000
  r = await owner('POST', `${P}/cm/simulate`, { base: 300000 });
  const L = (code) => (r.json.lines || []).find((l) => l.code === code) || {};
  check('simulation 300 000 : PVID salarié 8 400', L('cnps_pension_emp').amount === 8400, r.json.lines);
  check('simulation 300 000 : IRPP mensuel 15 993', L('irpp').amount === 15993 && r.json.detail.taxableAnnual === 1919200, r.json.detail);
  check('simulation 300 000 : CAC 1 599, CFC 3 000', L('cac').amount === 1599 && L('cfc_emp').amount === 3000);
  check('simulation 300 000 : net 271 008', r.json.net === 300000 - 8400 - 15993 - 1599 - 3000, r.json.net);
  check('charges patronales : PVID 12 600, prestations familiales 21 000, CFC 4 500, FNE 3 000', L('cnps_pension_er').amount === 12600 && L('cnps_family_er').amount === 21000 && L('cfc_er').amount === 4500 && L('fne_er').amount === 3000);
  check('accidents du travail : montant 0 et « à compléter »', L('cnps_accident_er').amount === 0 && L('cnps_accident_er').todo === true);
  check('la simulation signale les taux manquants', r.json.missing.includes('cnps.accident.employer'));
  // Simulation 2 : 2 000 000 (plafond CNPS et toutes les tranches)
  // PVID = 750 000 x 2,8 % = 21 000 ; base = 24 000 000 - 7 200 000 - 252 000 - 500 000 = 16 048 000 ; IRPP annuel = 200 000 + 150 000 + 500 000 + 11 048 000 x 35 % = 4 716 800 ; /12 = 393 067
  r = await owner('POST', `${P}/cm/simulate`, { base: 2000000 });
  check('plafond CNPS appliqué (assiette 750 000, PVID 21 000)', L('cnps_pension_emp').amount === 21000 && L('cnps_pension_emp').basis === 750000, L('cnps_pension_emp'));
  check('IRPP progressif sur 4 tranches : 393 067 par mois', L('irpp').amount === 393067 && r.json.detail.irppYear === 4716800, r.json.detail);
  r = await owner('POST', `${P}/cm/simulate`, { base: 60000 });
  check('petit salaire : base imposable nulle, IRPP 0', L('irpp').amount === 0, L('irpp'));
  r = await owner('POST', `${P}/cm/simulate`, { base: 0 });
  check('simulation sans salaire refusée', r.status === 400, r.json);

  // Surcharges par l'organisation
  r = await mgr('PUT', `${P}/cm/overrides`, { overrides: { 'cnps.pension.employee': 3 } });
  check('surcharge : réservée aux administrateurs', r.status === 403, r.status);
  r = await owner('PUT', `${P}/cm/overrides`, { overrides: { 'inconnu.xx': 3 } });
  check('paramètre inconnu refusé', r.status === 400, r.json);
  r = await owner('PUT', `${P}/cm/overrides`, { overrides: { 'cnps.pension.employee': 150 } });
  check('pourcentage > 100 refusé', r.status === 400, r.json);
  r = await owner('PUT', `${P}/cm/overrides`, { overrides: { 'irpp.t2.limit': 1000000 } });
  check('tranches non croissantes refusées', r.status === 400, r.json);
  r = await owner('PUT', `${P}/cm/overrides`, { overrides: { 'cnps.pension.employee': 3, 'cnps.accident.employer': 1.75 } });
  check('surcharges enregistrées', r.status === 200, r.json);
  r = await owner('POST', `${P}/cm/simulate`, { base: 300000 });
  check('le calcul utilise la surcharge (PVID 3 % = 9 000, accidents 1,75 % = 5 250)', L('cnps_pension_emp').amount === 9000 && L('cnps_accident_er').amount === 5250 && !r.json.missing.includes('cnps.accident.employer'), r.json.lines);
  r = await owner('GET', `${P}/cm/model`);
  check('le modèle affiche surcharge et valeur par défaut', r.json.params.find((x) => x.key === 'cnps.pension.employee').override === 3 && r.json.params.find((x) => x.key === 'cnps.pension.employee').default === 2.8);
  r = await owner('PUT', `${P}/cm/overrides`, { overrides: { 'cnps.pension.employee': null } });
  r = await owner('POST', `${P}/cm/simulate`, { base: 300000 });
  check('retirer la surcharge rétablit le défaut', L('cnps_pension_emp').amount === 8400);

  // Employés et absences
  const mk = async (b) => (await owner('POST', `${H}/employees`, b)).json.id;
  const awa = await mk({ name: 'Awa Nkomo', salary: 300000, hiredAt: '2025-03-01', cnpsNo: 'CNPS-0001', niu: 'P111', payChannel: 'bank', payAccount: '10005-00001-12345678901-23' });
  const paul = await mk({ name: 'Paul Eto', salary: 150000, payChannel: 'mobile', payAccount: '677001122' });
  const zoe = await mk({ name: 'Zoé Sans Compte', salary: 120000 });
  r = await mgr('GET', H);
  check('un responsable ne voit pas matricule ni compte de virement', r.json.employees.every((e) => e.payAccount === undefined && e.cnpsNo === undefined), r.json.employees[0]);
  r = await owner('PUT', `${H}/employees/${paul}`, { payAccount: '<script>' });
  check('compte de virement invalide refusé', r.status === 400, r.json);
  const month = '2026-09';
  // Absence non payée : 3 jours en septembre pour Awa
  r = await mgr('POST', `${H}/leaves`, { employeeId: awa, kind: 'unpaid', start: '2026-09-10', end: '2026-09-12', note: 'Absence' });
  check('congé « sans solde » accepté', r.status === 201, r.json);
  const lid = r.json.id;
  // Avant activation : pas de retenue
  r = await owner('POST', `${P}/slips`, { employeeId: zoe, month });
  const zslip = r.json.id;
  r = await owner('POST', `${P}/cm/activate`, {});
  check('activation du modèle Cameroun', r.status === 200 && /expert-comptable/.test(r.json.warning), r.json);
  r = await owner('GET', `${P}?month=${month}`);
  check('avertissement : barème non validé signalé tant que la date « à jour au » est vide', r.json.settings.incomplete.some((x) => /non valid/.test(x)), r.json.settings.incomplete);
  r = await owner('POST', `${P}/run`, { month });
  check('lancement de la paie (Awa, Paul ; Zoé a déjà un bulletin)', r.status === 201 && r.json.created === 2, r.json);
  r = await owner('GET', `${P}/slips?month=${month}`);
  let sa = r.json.slips.find((s) => s.employee === 'Awa Nkomo');
  check('absence non payée en attente (non approuvée) : pas de retenue', sa.absenceDeduction === 0, sa);
  // Approuver puis recalculer le brouillon
  r = await owner('PUT', `${H}/leaves/${lid}/decision`, { decision: 'approved' });
  r = await owner('PUT', `${P}/slips/${sa.id}`, {});
  r = await owner('GET', `${P}/slips/${sa.id}`);
  sa = r.json.slip;
  check('retenue automatique : 3 j / 30 x 300 000 = 30 000', sa.absenceDays === 3 && sa.absenceDeduction === 30000 && sa.gross === 270000, [sa.absenceDays, sa.absenceDeduction, sa.gross]);
  check('bulletin calculé par le modèle Cameroun (version et détail IRPP conservés)', sa.engine === 'cm' && sa.modelVersion && sa.calcDetail && sa.calcDetail.irppMonth > 0 && sa.lines.some((l) => l.code === 'irpp'), [sa.engine, sa.modelVersion]);
  check('net = brut - retenues', sa.net === sa.gross - sa.employeeDeductions, sa);
  r = await owner('PUT', `${P}/slips/${sa.id}`, { absenceDeduction: 0 });
  r = await owner('GET', `${P}/slips/${sa.id}`);
  check('montant d\'absence saisi : prioritaire sur le calcul automatique', r.json.slip.absenceDeduction === 0 && r.json.slip.gross === 300000, r.json.slip);
  r = await owner('PUT', `${P}/slips/${sa.id}`, { absenceDeduction: '' });
  r = await owner('GET', `${P}/slips/${sa.id}`);
  check('champ vidé : retour au calcul automatique', r.json.slip.absenceDeduction === 30000);
  r = await owner('GET', `${P}/slips/${zslip}`);
  check('bulletin ancien (avant activation) inchangé : ni moteur ni retenue', r.json.slip.engine === '' && r.json.slip.absenceDeduction === 0);
  // Valider les bulletins, payer
  r = await owner('GET', `${P}/slips?month=${month}`);
  for (const s of r.json.slips) { const v = await owner('POST', `${P}/slips/${s.id}/validate`, {}); if (s.employee === 'Awa Nkomo') check('validation : avertissements de barème renvoyés', v.status === 200 && v.json.warnings.length >= 1, v.json); }
  r = await owner('PUT', `${P}/cm/validation`, { by: '', date: '2026-10-01' });
  check('validation du barème : qui obligatoire', r.status === 400, r.json);
  r = await owner('PUT', `${P}/cm/validation`, { by: 'Cabinet Test (exemple)', date: '2999-01-01' });
  check('validation du barème : date future refusée', r.status === 400, r.json);
  r = await owner('PUT', `${P}/cm/validation`, { by: 'Cabinet Test (exemple)', date: '2026-10-01', note: 'Vérifié au test' });
  r = await owner('GET', `${P}/cm/model`);
  check('date « à jour au » enregistrée', r.json.validation.ratesAsOf === '2026-10-01' && r.json.validation.by === 'Cabinet Test (exemple)', r.json.validation);
  r = await owner('GET', `${P}?month=${month}`);
  check('plus d\'alerte « non validé » une fois vérifié', !r.json.settings.incomplete.some((x) => /non valid/.test(x)), r.json.settings.incomplete);

  // États CSV
  r = await owner('GET', `${P}/cm/export/cnps.csv?month=${month}`);
  check('récapitulatif CNPS CSV', r.status === 200 && /Awa Nkomo/.test(r.text) && /CNPS-0001/.test(r.text) && /TOTAL/.test(r.text) && /DOCUMENT DE TRAVAIL/.test(r.text), r.text.slice(0, 300));
  check('CSV CNPS : PVID de 270 000 = 7 560', /"7560"/.test(r.text), r.text);
  r = await owner('GET', `${P}/cm/export/irpp.csv?month=${month}`);
  check('état de retenue IRPP CSV', r.status === 200 && /P111/.test(r.text) && /irpp/.test(r.text) && /TOTAL/.test(r.text), r.text.slice(0, 300));
  r = await mgr('GET', `${P}/cm/export/cnps.csv?month=${month}`);
  check('exports réservés aux administrateurs', r.status === 403, r.status);
  r = await owner('GET', `${P}/cm/transfers?month=${month}&channel=bank`);
  check('virements banque : Awa seulement, Zoé signalée sans compte', r.json.rows.length === 1 && r.json.rows[0].employee === 'Awa Nkomo', r.json);
  r = await owner('GET', `${P}/cm/transfers?month=${month}`);
  check('virements : Zoé (sans canal) listée comme manquante', r.json.missing.some((m) => m.employee === 'Zoé Sans Compte'), r.json.missing);
  r = await owner('GET', `${P}/cm/export/transfers.csv?month=${month}&channel=mobile`);
  check('fichier Mobile Money CSV', r.status === 200 && /Paul Eto/.test(r.text) && /677001122/.test(r.text) && !/Awa Nkomo/.test(r.text), r.text);
  r = await owner('GET', `${P}/cm/export/transfers.csv?month=${month}`);
  check('canal obligatoire pour le fichier de virement', r.status === 400, r.status);

  // Solde de tout compte
  r = await owner('POST', `${P}/cm/settlements`, { employeeId: awa, exitDate: '2026-10-15', reason: 'Démission', noticeIndemnity: 300000 });
  const st1 = r.json;
  check('solde de tout compte créé (document de travail)', r.status === 201 && /DOCUMENT DE TRAVAIL/.test(st1.notice) && st1.warnings.some((w) => /expert-comptable/.test(w)), st1);
  check('prorata du mois de sortie : 15/30 x 300 000 = 150 000', st1.lines.find((l) => l.code === 'salary').amount === 150000, st1.lines);
  const leave = st1.lines.find((l) => l.code === 'leave');
  check('congés non pris calculés (acquis - pris)', leave.amount > 0 && /acquis/.test(leave.label), leave);
  check('préavis saisi pris en compte, total = somme', st1.lines.some((l) => l.code === 'notice' && l.amount === 300000) && st1.total === st1.lines.reduce((a, l) => a + l.amount, 0), st1);
  r = await owner('POST', `${P}/cm/settlements`, { employeeId: awa, exitDate: '2026-10-15', unusedLeaveDays: 10, deductions: 50000 });
  check('jours de congé saisis : 10 j x 300 000 / 30 = 100 000 ; avance déduite', r.json.lines.find((l) => l.code === 'leave').amount === 100000 && r.json.total === 150000 + 100000 - 50000, r.json);
  check('préavis non saisi : avertissement « non calculé »', r.json.warnings.some((w) => /non calculés/.test(w)));
  r = await owner('POST', `${P}/cm/settlements`, { employeeId: awa });
  check('date de sortie obligatoire', r.status === 400, r.json);
  r = await owner('GET', `${P}/cm/settlements`);
  check('liste des soldes', r.json.settlements.length === 2, r.json);
  r = await mgr('GET', `${P}/cm/settlements`);
  check('soldes : réservés aux administrateurs', r.status === 403);
  r = await other('GET', `/api/ws/orgs/${org}/payroll/cm/settlements`);
  check('autre organisation : aucun accès', r.status === 404, r.status);
  r = await owner('DELETE', `${P}/cm/settlements/${st1.id}`);
  check('suppression d\'un brouillon de solde', r.status === 200);

  // Désactivation
  r = await owner('POST', `${P}/cm/deactivate`, {});
  r = await owner('POST', `${P}/slips`, { employeeId: paul, month: '2026-08' });
  r = await owner('GET', `${P}/slips/${r.json.id}`);
  check('modèle désactivé : retour au calcul par rubriques', r.json.slip.engine === '');
});
