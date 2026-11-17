'use strict';
// Démonstration · groupe « finance » : ressources humaines (employés reliés aux comptes de l'équipe, contrats, congés, pointage,
// recrutement, évaluations, formations, dossier du personnel) et paie Cameroun (CNPS, IRPP, CAC, CFC) sur plusieurs mois.

// clé, nom, poste, salaire, antenne, embauche, membre lié, canal, compte, CNPS, NIU
const STAFF = [
  ['marc', 'Marc Ebongué', 'Directeur des opérations', 850000, 'douala', '2023-02-01', 'manager', 'bank', 'CM21 10005 00012 04587120001 34', '10-0458712-A', 'P047812365401Z'],
  ['clarisse', 'Clarisse Ngo Bassa', 'Responsable administrative et financière', 780000, 'douala', '2022-09-15', 'accountant', 'bank', 'CM21 10005 00012 04587120002 61', '10-0458713-B', 'P058812365402Y'],
  ['paul', 'Paul Tchinda', 'Chef magasinier', 320000, 'douala', '2021-03-08', 'storekeeper', 'bank', 'CM21 10005 00012 04587120003 88', '10-0458714-C', 'P069812365403X'],
  ['aicha', 'Aïcha Mohamadou', 'Commerciale', 280000, 'douala', '2023-06-12', 'seller', 'mobile', '+237 677 21 43 66', '10-0458715-D', 'P070812365404W'],
  ['samuel', 'Samuel Fotso', 'Chauffeur-livreur', 210000, 'douala', '2022-01-17', 'driver', 'mobile', '+237 690 45 12 78', '10-0458716-E', 'P081812365405V'],
  ['herve', 'Hervé Nkoulou', 'Magasinier (dépôt de Yaoundé)', 185000, 'yaounde', '2025-07-01', null, 'mobile', '+237 699 87 65 43', '10-0458717-F', ''],
  ['brigitte', 'Brigitte Mbarga', 'Caissière (dépôt de Yaoundé)', 175000, 'yaounde', '2024-02-05', null, 'bank', 'CM21 10033 05201 09876540001 12', '10-0458718-G', ''],
  ['jacques', 'Jacques Eyenga', 'Agent de sécurité', 120000, 'douala', '2020-11-02', null, 'mobile', '+237 655 32 10 98', '10-0458719-H', ''],
  ['rose', 'Rose Atangana', 'Assistante comptable (CDD)', 230000, 'douala', null, null, 'bank', 'CM21 10005 00012 04587120009 07', '10-0458720-J', ''],
  ['ibrahim', 'Ibrahim Bello', 'Manutentionnaire', 110000, 'douala', null, null, '', '', '', ''],
];

async function hr(ctx, h) {
  const F = ctx.ids.finance; const { Y, T, M0, addDays, addMonth } = h;
  const E = F.emp = {};
  const hrDo = (f, m, u, b, o = {}) => ctx.do(f, m, '/hr' + u, b, { as: 'manager', ...o });

  // ---------- Réglages, jours fériés ----------
  await hrDo('RH : réglages (acquisition des congés, report, préavis des alertes)', 'GET', '/settings');
  await hrDo('RH : modifier les réglages (1,5 j/mois, report 12 j, alerte 45 j)', 'PUT', '/settings', { leave_accrual: 1.5, leave_carry_max: 12, alert_contract_days: 45 }, { as: 'accountant' });
  await hrDo('RH : jours fériés du Cameroun (exemples)', 'GET', `/holidays?year=${Y}`);
  await hrDo(`RH : jours fériés ${Y - 1} (pour les soldes reportés)`, 'GET', `/holidays?year=${Y - 1}`);
  await hrDo('RH : ajouter la Fête de fin du Ramadan (Aïd el-Fitr)', 'POST', '/holidays', { date: `${Y}-03-20`, name: 'Fête de fin du Ramadan (Aïd el-Fitr)' }, { as: 'accountant', expect: [201, 409] });
  const tab = await hrDo('RH : ajouter la Fête du Mouton (date provisoire)', 'POST', '/holidays', { date: `${Y}-05-26`, name: 'Fête du Mouton (Aïd el-Kébir)' }, { as: 'accountant', expect: [201, 409] });
  if (tab.id) await hrDo('RH : corriger la date de la Fête du Mouton (annonce officielle)', 'PUT', `/holidays/${tab.id}`, { date: `${Y}-05-27` }, { as: 'accountant' });
  const wrong = await hrDo('RH : ajouter un jour férié par erreur', 'POST', '/holidays', { date: `${Y}-06-16`, name: 'Jour férié saisi par erreur' }, { as: 'accountant', expect: [201, 409] });
  if (wrong.id) await hrDo('RH : supprimer le jour férié erroné', 'DELETE', `/holidays/${wrong.id}`, undefined, { as: 'accountant' });
  await hrDo('RH : un responsable ne peut pas modifier les jours fériés (refus attendu)', 'POST', '/holidays', { date: `${Y}-06-17`, name: 'Essai' }, { expect: 403 });

  // ---------- Employés ----------
  const have = ((await hrDo('RH : liste du personnel', 'GET', '')).employees || []);
  const rosesHire = addDays(T, -200); const ibraHire = addDays(T, -75);
  for (const [k, name, job, salary, br, hired, member, ch, accNo, cnps, niu] of STAFF) {
    const ex = have.find((e) => e.name === name);
    const m = member && ctx.ids.members[member];
    const body = { name, job, phone: m ? undefined : '+237 6' + String(70000000 + name.length * 1234567).slice(0, 8), hiredAt: hired || (k === 'rose' ? rosesHire : ibraHire), salary, branchId: ctx.ids.branches[br], userId: m && m.userId ? m.userId : undefined, payChannel: ch, payAccount: accNo, cnpsNo: cnps, niu };
    E[k] = ex ? ex.id : (await hrDo(`RH : embaucher ${name} (${job})${m && m.userId ? ' — relié à son compte' : ' — sans compte Brij-IA'}`, 'POST', '/employees', body, { as: 'accountant' })).id;
  }
  if (ctx.users.manager) await hrDo('RH : un responsable ajoute un employé sans voir les salaires (stagiaire)', 'POST', '/employees', { name: 'Kevin Ndongo', job: 'Stagiaire logistique', hiredAt: addDays(T, -20), branchId: ctx.ids.branches.douala, salary: 999999 }).then(async (r) => {
    if (!r.id) return;
    const list = (await hrDo('RH : la fiche du stagiaire n\'a pas de salaire (saisi par un responsable : ignoré)', 'GET', '', undefined, { as: 'accountant' })).employees || [];
    const k = list.find((e) => e.id === r.id);
    ctx.check('RH : le salaire saisi par un responsable est ignoré', k && !k.salary, k);
    await hrDo('RH : supprimer la fiche du stagiaire (administrateur)', 'DELETE', `/employees/${r.id}`, undefined, { as: 'accountant' });
  });
  const mgrView = (await hrDo('RH : vue du responsable (sans salaires)', 'GET', '')).employees || [];
  if (ctx.users.manager) ctx.check('RH : un responsable ne voit pas les salaires', mgrView.length && mgrView.every((e) => e.salary === undefined), mgrView[0]);
  await hrDo('RH : mettre à jour le téléphone et le poste de Samuel Fotso', 'PUT', `/employees/${E.samuel}`, { phone: '+237 690 45 12 78', job: 'Chauffeur-livreur poids lourd' });
  await hrDo('RH : revaloriser le salaire de Paul Tchinda (administrateur)', 'PUT', `/employees/${E.paul}`, { salary: 335000 }, { as: 'accountant' });

  // ---------- Dossier du personnel ----------
  await hrDo('RH : compléter le dossier de Paul Tchinda (CNI, adresse, urgence, diplômes)', 'PUT', `/employees/${E.paul}/file`, { cniNo: '112233445', birthDate: '1988-04-12', address: 'Bonabéri, Douala', emergencyName: 'Odile Tchinda (épouse)', emergencyPhone: '+237 677 88 99 00', diplomas: 'CAP Logistique ; CACES cariste' }, { as: 'accountant' });
  await hrDo('RH : consulter le dossier personnel (accès journalisé)', 'GET', `/employees/${E.paul}/file`, undefined, { as: 'accountant' });
  await hrDo('RH : un responsable n\'accède pas au dossier personnel (refus attendu)', 'GET', `/employees/${E.paul}/file`, undefined, { expect: 403 });
  const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const up = await hrDo('RH : joindre le contrat signé au dossier (PDF)', 'POST', `/employees/${E.paul}/files?name=Contrat-CDI-Paul-Tchinda`, pdfBuf, { as: 'accountant' });
  await hrDo('RH : pièces jointes du dossier', 'GET', `/employees/${E.paul}/files`, undefined, { as: 'accountant' });
  if (up.id) await ctx.do('RH : ouvrir la pièce jointe', 'GET', `/hr/employees/files/${up.id}/file`, undefined, { as: 'accountant', raw: true });
  const up2 = await hrDo('RH : joindre un document par erreur', 'POST', `/employees/${E.paul}/files?name=Document-errone`, pdfBuf, { as: 'accountant' });
  if (up2.id) await hrDo('RH : retirer le document joint par erreur', 'DELETE', `/employees/files/${up2.id}`, undefined, { as: 'accountant' });

  // ---------- Contrats ----------
  const C = (k, kind, start, extra = {}) => hrDo(`RH : contrat ${kind.toUpperCase()} de ${STAFF.find((s) => s[0] === k)[1]}`, 'POST', '/contracts', { employeeId: E[k], kind, startDate: start, ...extra });
  for (const s of STAFF) if (!['rose', 'ibrahim', 'samuel'].includes(s[0])) await C(s[0], 'cdi', s[5]);
  await C('samuel', 'cdi', '2022-01-17', { medicalDue: addDays(T, -12), note: 'Visite médicale annuelle (permis poids lourd) à renouveler' });
  const rc = await C('rose', 'cdd', rosesHire, { endDate: addDays(T, 21), note: 'CDD de 7 mois : renouvellement ou CDI à décider' });
  await C('ibrahim', 'essai', ibraHire, { trialEnd: addDays(T, 15), note: 'Période d\'essai de 3 mois' });
  if (rc.id) await hrDo('RH : préciser la date de visite médicale du CDD', 'PUT', `/contracts/${rc.id}`, { medicalDue: addDays(T, 30) });
  const bad = await hrDo('RH : contrat saisi en double (erreur)', 'POST', '/contracts', { employeeId: E.herve, kind: 'stage', startDate: '2025-07-01' });
  if (bad.id) await hrDo('RH : supprimer le contrat en double', 'DELETE', `/contracts/${bad.id}`);
  await hrDo('RH : contrat dont la fin précède le début (refus attendu)', 'POST', '/contracts', { employeeId: E.herve, kind: 'cdd', startDate: `${Y}-06-01`, endDate: `${Y}-05-01` }, { expect: 400 });
  await hrDo('RH : contrats', 'GET', '/contracts');

  // ---------- Formations et habilitations ----------
  await hrDo('RH : habilitation permis C (poids lourd) de Samuel', 'POST', '/trainings', { employeeId: E.samuel, title: 'Permis C — poids lourd (validité)', kind: 'certification', doneAt: '2021-11-20', expiresAt: addDays(T, 25), provider: 'Ministère des Transports' });
  await hrDo('RH : habilitation cariste de Paul', 'POST', '/trainings', { employeeId: E.paul, title: 'Conduite de chariot élévateur (cariste)', kind: 'certification', doneAt: `${Y - 2}-03-10`, expiresAt: addDays(T, -5), provider: 'CFPA Douala' });
  await hrDo('RH : formation SYSCOHADA révisé de Clarisse', 'POST', '/trainings', { employeeId: E.clarisse, title: 'SYSCOHADA révisé : états financiers', kind: 'training', doneAt: `${Y}-04-18`, provider: 'ONECCA' });
  await hrDo('RH : formation sécurité incendie (gardien)', 'POST', '/trainings', { employeeId: E.jacques, title: 'Sécurité incendie et premiers secours', kind: 'training', doneAt: `${Y}-02-22`, provider: 'Sapeurs-pompiers de Douala' });
  await hrDo('RH : formations et habilitations', 'GET', '/trainings');
  const due = (await hrDo('RH : échéances à surveiller (fin de CDD, essai, visite médicale, habilitations)', 'GET', '/due')).items || [];
  ctx.check('RH : alertes d\'échéances (CDD, essai, habilitation expirée)', due.length >= 4 && due.some((d) => d.expired), due.map((d) => d.kind));

  // ---------- Évaluations ----------
  const sem = `${Y} S1`;
  for (const [k, score, s, g] of [['paul', 4, 'Inventaires fiables, zéro écart sur le ciment', 'Former un adjoint au dépôt'], ['aicha', 5, 'Objectif commercial dépassé de 18 %', 'Ouvrir 5 comptes d\'entreprises du BTP à Yaoundé'], ['samuel', 3, 'Ponctuel, véhicule bien entretenu', 'Réduire la consommation de gasoil'], ['herve', 2, 'Bon accueil des clients', 'Rigueur sur les bons de sortie (2 écarts en mars)']]) {
    const r = await hrDo(`RH : évaluation ${sem} de ${STAFF.find((x) => x[0] === k)[1]}`, 'POST', '/reviews', { employeeId: E[k], period: sem, score, strengths: s, goals: g });
    if (k === 'herve' && r.id) await hrDo('RH : compléter l\'évaluation après entretien', 'PUT', `/reviews/${r.id}`, { score: 3, goals: g + ' ; formation à la gestion de stock' });
  }
  await hrDo('RH : évaluations', 'GET', '/reviews');

  // ---------- Recrutement ----------
  const job = await hrDo('RH : ouvrir un poste « Commercial terrain Yaoundé »', 'POST', '/jobs', { title: 'Commercial terrain Yaoundé', description: 'Prospection des entreprises du BTP (Mvan, Odza, Nkolbisson), suivi des devis, objectif 25 M FCFA/mois.' });
  if (job.id) {
    const cands = [];
    for (const [name, phone, stage, note] of [['Ulrich Mvondo', '+237 691 11 22 33', 'interview', 'BTS action commerciale, 3 ans chez un distributeur'], ['Sandrine Ewane', '+237 677 44 55 66', 'offer', 'Très bon entretien, connaît les chantiers d\'Odza'], ['Thierry Abena', '+237 655 77 88 99', 'new', '']]) {
      cands.push((await hrDo(`RH : candidature de ${name}`, 'POST', '/candidates', { jobId: job.id, name, phone, email: `${name.split(' ')[0].toLowerCase()}@candidat-demo.example`, stage: 'new', note })).id);
      if (stage !== 'new') await hrDo(`RH : ${name} passe à l'étape « ${stage} »`, 'PUT', `/candidates/${cands[cands.length - 1]}`, { stage });
    }
    await hrDo('RH : refuser une candidature', 'PUT', `/candidates/${cands[2]}`, { stage: 'rejected', note: 'Profil trop junior pour le poste' });
    await hrDo('RH : candidatures du poste', 'GET', `/candidates?jobId=${job.id}`);
    const hired = await hrDo('RH : embaucher Sandrine Ewane (crée sa fiche employé)', 'POST', `/candidates/${cands[1]}/hire`, { hiredAt: T }, { as: 'accountant' });
    if (hired.employeeId) { E.sandrine = hired.employeeId; await hrDo('RH : fixer le salaire de la nouvelle commerciale', 'PUT', `/employees/${hired.employeeId}`, { salary: 260000 }, { as: 'accountant' }); }
    await hrDo('RH : clore le poste pourvu', 'PUT', `/jobs/${job.id}`, { status: 'closed' });
  }
  await hrDo('RH : postes ouverts', 'GET', '/jobs');

  // ---------- Congés ----------
  await hrDo('RH : ancienneté — 2 jours de congé en plus pour Paul', 'POST', '/leave-adjustments', { employeeId: E.paul, year: String(Y), days: 2, note: 'Ancienneté (5 ans)' }, { as: 'accountant' });
  await hrDo('RH : rattrapage d\'un congé pris en ' + (Y - 1) + ' non saisi (Brigitte)', 'POST', '/leave-adjustments', { employeeId: E.brigitte, year: String(Y), days: -1.5, note: 'Demi-journées de décembre' }, { as: 'accountant' });
  await hrDo('RH : ajustements de congés', 'GET', '/leave-adjustments');
  const leave = (label, k, kind, start, endD, as = 'manager', expect) => hrDo(label, 'POST', '/leaves', { employeeId: E[k], kind, start, end: endD, note: '' }, { as, expect });
  const decide = (label, id, decision, as = 'manager', expect) => (id ? hrDo(label, 'PUT', `/leaves/${id}/decision`, { decision }, { as, expect }) : null);
  const julY = `${Y}-07`;
  const lp = await leave('Congés : demande de Paul (congé annuel en août)', 'paul', 'annual', `${Y}-08-10`, `${Y}-08-22`);
  await decide('Congés : le directeur des opérations valide le congé de Paul', lp.id, 'approved');
  const lm = await leave('Congés : Marc Ebongué demande son propre congé', 'marc', 'annual', `${julY}-20`, `${julY}-31`);
  await decide('Congés : Marc ne peut pas valider son propre congé (refus attendu)', lm.id, 'approved', 'manager', 403);
  await decide('Congés : la RAF valide le congé du directeur', lm.id, 'approved', 'accountant');
  const M1 = addMonth(M0, -1); const M2 = addMonth(M0, -2);
  const ls = await leave('Absences : 3 jours sans solde de Samuel (affaire familiale à Bafoussam)', 'samuel', 'unpaid', `${M1}-12`, `${M1}-14`);
  await decide('Absences : validation de l\'absence sans solde (retenue automatique sur la paie)', ls.id, 'approved');
  const lsk = await leave('Absences : arrêt maladie d\'Aïcha (paludisme)', 'aicha', 'sick', `${M2}-06`, `${M2}-07`);
  await decide('Absences : validation de l\'arrêt maladie', lsk.id, 'approved');
  // Brigitte est en congé cette semaine (pour le planning)
  const mon = addDays(T, -((new Date(`${T}T00:00:00Z`).getUTCDay() + 6) % 7));
  const lb = await leave('Congés : Brigitte en congé cette semaine', 'brigitte', 'annual', addDays(mon, 1), addDays(mon, 3));
  await decide('Congés : validation du congé de Brigitte', lb.id, 'approved');
  await leave('Congés : Hervé demande tout le mois de décembre (solde insuffisant : refus attendu)', 'herve', 'annual', `${Y}-12-01`, `${Y}-12-31`, 'manager', 400);
  const forced = await hrDo('Congés : la RAF force la demande d\'Hervé (au-delà du solde)', 'POST', '/leaves', { employeeId: E.herve, kind: 'annual', start: `${Y}-12-01`, end: `${Y}-12-31`, force: true, note: 'Voyage au village (Ebolowa)' }, { as: 'accountant' });
  await decide('Congés : refus de la demande d\'Hervé (période de forte activité)', forced.id, 'refused', 'accountant');
  const lpend = await leave('Congés : demande de Rose pour fin décembre (en attente)', 'rose', 'annual', `${Y}-12-29`, `${Y}-12-31`);
  void lpend;
  const ldel = await leave('Congés : demande saisie par erreur', 'jacques', 'other', addDays(T, 40), addDays(T, 41));
  if (ldel.id) await hrDo('Congés : supprimer la demande erronée', 'DELETE', `/leaves/${ldel.id}`);
  await decide('Congés : décider deux fois la même demande (refus attendu)', lp.id, 'refused', 'manager', 400);
  await hrDo('Congés : liste des demandes', 'GET', '/leaves');
  const bal = await hrDo('Congés : soldes de congés par employé', 'GET', `/balances?year=${Y}`);
  ctx.check('Congés : soldes calculés (acquis, pris, en attente)', (bal.items || []).length >= 8, bal.items && bal.items[0]);
  if (ctx.ids.members.storekeeper) {
    const mine = await ctx.do('Congés : Paul consulte son propre solde (membre)', 'GET', '/hr/my-balance', undefined, { as: 'storekeeper' });
    ctx.check('Congés : le solde du membre est relié à sa fiche', mine.linked === true, mine);
    await ctx.do('RH : un membre n\'accède pas au module RH (refus attendu)', 'GET', '/hr', undefined, { as: 'storekeeper', expect: 403 });
    await ctx.do('Congés : un membre ne peut pas saisir de demande lui-même (réservé aux responsables, refus attendu)', 'POST', '/hr/leaves', { employeeId: E.paul, kind: 'annual', start: `${Y}-12-22`, end: `${Y}-12-23` }, { as: 'storekeeper', expect: 403 });
  }

  // ---------- Planning et pointage ----------
  const wk = await hrDo('Planning : semaine en cours', 'GET', '/planning');
  const days = [0, 1, 2, 3, 4, 5].map((i) => addDays(wk.start || mon, i));
  let sh = null;
  for (const [k, st, en] of [['paul', '07:30', '16:30'], ['samuel', '06:30', '15:30'], ['jacques', '18:00', '23:59'], ['aicha', '08:00', '17:00']]) {
    for (const d of days.slice(0, 5)) { const r = await hrDo(`Planning : horaire de ${STAFF.find((x) => x[0] === k)[1]} le ${d}`, 'POST', '/shifts', { employeeId: E[k], day: d, start: st, end: en }); sh = sh || r.id; }
  }
  await hrDo('Planning : horaire sur un jour de congé (refus attendu)', 'POST', '/shifts', { employeeId: E.brigitte, day: addDays(mon, 2), start: '08:00', end: '16:00' }, { expect: 400 });
  await hrDo('Planning : horaire qui chevauche (refus attendu)', 'POST', '/shifts', { employeeId: E.paul, day: days[0], start: '12:00', end: '18:00' }, { expect: 400 });
  if (sh) await hrDo('Planning : supprimer un horaire', 'DELETE', `/shifts/${sh}`);
  await hrDo('Planning : semaine suivante', 'GET', `/planning?week=${addDays(mon, 7)}`);
  const att = [];
  for (let i = 1; att.length < 10 && i < 20; i++) { const d = addDays(T, -i); if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) att.push(d); }
  for (const [n, d] of att.entries()) {
    for (const k of ['paul', 'samuel', 'herve']) {
      const status = k === 'herve' && n === 2 ? 'absent' : k === 'samuel' && (n === 1 || n === 6) ? 'late' : k === 'herve' && n === 5 ? 'justified' : 'present';
      await hrDo(`Pointage : ${STAFF.find((x) => x[0] === k)[1]} le ${d} (${status})`, 'POST', '/attendance', { employeeId: E[k], day: d, status, minutesLate: status === 'late' ? 25 + n * 5 : 0, note: status === 'justified' ? 'Rendez-vous médical (justificatif fourni)' : '' });
    }
  }
  await hrDo('Pointage : le même jour deux fois (refus attendu)', 'POST', '/attendance', { employeeId: E.paul, day: att[0], status: 'present' }, { expect: 409 });
  const pt = ((await hrDo('Pointage : liste', 'GET', `/attendance?employeeId=${E.herve}`)).items || [])[0];
  if (pt) await hrDo('Pointage : corriger un pointage (absence justifiée)', 'PUT', `/attendance/${pt.id}`, { status: 'justified', note: 'Certificat médical reçu' });
  await hrDo('Pointage : synthèse du mois (présences, retards, absences)', 'GET', `/attendance-summary?month=${M0}`);
  await hrDo('RH : tableau de bord (effectif, absents, congés en attente, masse salariale)', 'GET', '', undefined, { as: 'accountant' });
}

// ======================= Paie =======================
async function payrollSetup(ctx, h) {
  const { T } = h;
  const P = (f, m, u, b, o = {}) => ctx.do(f, m, '/payroll' + u, b, { as: 'accountant', ...o });
  await P('Paie : modèles de pays', 'GET', '/templates');
  await P('Paie : paramètres (exemple par défaut)', 'GET', '/settings');
  await P('Paie : heures de référence et majorations des heures supplémentaires', 'PUT', '/settings', { options: { monthlyHours: 173.33, tiers: [{ label: 'Heures 41 à 48 (+20 %)', rate: 20 }, { label: 'Heures au-delà de 48 (+30 %)', rate: 30 }, { label: 'Nuit / dimanche (+50 %)', rate: 50 }], autoAccount: false } });
  await P('Paie Cameroun : modèle chiffré (CNPS, IRPP, CAC, CFC, FNE)', 'GET', '/cm/model');
  await P('Paie Cameroun : activer le modèle', 'POST', '/cm/activate');
  await P('Paie Cameroun : désactiver le modèle (retour au barème simple)', 'POST', '/cm/deactivate');
  await P('Paie Cameroun : réactiver le modèle', 'POST', '/cm/activate');
  await P('Paie Cameroun : taux accidents du travail (classe de risque B : 2,5 %)', 'PUT', '/cm/overrides', { overrides: { 'cnps.accident.employer': 2.5 } });
  await P('Paie Cameroun : paramètre inconnu (refus attendu)', 'PUT', '/cm/overrides', { overrides: { 'cnps.inexistant': 3 } }, { expect: 400 });
  const model = await P('Paie Cameroun : modèle après surcharge', 'GET', '/cm/model');
  ctx.check('Paie Cameroun : plus aucun taux à compléter (hors quotité IRPP)', Array.isArray(model.missing) && model.missing.length === 0, model.missing);
  await P('Paie Cameroun : barème vérifié par l\'expert-comptable (date « à jour au »)', 'PUT', '/cm/validation', { by: 'Cabinet Fotso & Associés (expert-comptable agréé CEMAC)', date: h.addDays(T, -30), note: 'Taux CNPS 2026 et barème IRPP contrôlés' });
  const sim = await P('Paie Cameroun : simuler un bulletin (350 000 de base + 25 000 de prime)', 'POST', '/cm/simulate', { month: h.M0, base: 350000, bonuses: 25000 });
  ctx.check('Paie Cameroun : la simulation calcule un net inférieur au brut', sim.net > 0 && sim.net < sim.gross, sim);
}

/** Paie d'un mois : lancement, ajustements, validation, paiement et comptabilisation. `mode` : 'full' (payé) ou 'draft'. */
async function payrollMonth(ctx, h, month, mode, idx) {
  const F = ctx.ids.finance; const E = F.emp;
  const P = (f, m, u, b, o = {}) => ctx.do(f, m, '/payroll' + u, b, { as: 'accountant', ...o });
  const run = await P(`Paie ${month} : lancer la paie du mois`, 'POST', '/run', { month });
  void run;
  const slips = (await P(`Paie ${month} : bulletins du mois`, 'GET', `/slips?month=${month}`)).slips || [];
  const byEmp = (k) => slips.find((s) => s.employeeId === E[k]);
  const M1 = h.addMonth(h.M0, -1);
  const a = byEmp('aicha');
  if (a) await P(`Paie ${month} : commission de vente d'Aïcha`, 'PUT', `/slips/${a.id}`, { bonuses: 45000 + idx * 15000, note: 'Commission 1 % du chiffre d\'affaires encaissé' });
  const s = byEmp('samuel');
  if (s) await P(`Paie ${month} : heures supplémentaires de Samuel (livraisons du samedi)`, 'PUT', `/slips/${s.id}`, { overtimeHours: [{ rate: 20, hours: 6 + idx }, { rate: 50, hours: 4 }], advances: month === M1 ? 50000 : 0 });
  const p = byEmp('paul');
  if (p && month.endsWith('-06')) await P(`Paie ${month} : prime de bilan de Paul (inventaire semestriel)`, 'PUT', `/slips/${p.id}`, { annualBonus: 100000, annualBonusLabel: 'Prime d\'inventaire' });
  if (mode === 'draft') {
    const ib = byEmp('ibrahim');
    if (ib) {
      await P(`Paie ${month} : supprimer le brouillon d'Ibrahim (à refaire)`, 'DELETE', `/slips/${ib.id}`);
      await P(`Paie ${month} : bulletin d'Ibrahim saisi à la main (base et prime de rendement)`, 'POST', '/slips', { employeeId: E.ibrahim, month, base: 110000, bonuses: 10000, note: 'Prime de rendement (déchargement des camions)' });
      await P(`Paie ${month} : un second bulletin pour le même mois (refus attendu)`, 'POST', '/slips', { employeeId: E.ibrahim, month }, { expect: 409 });
    }
    return slips;
  }
  if (idx === 1) await P('Paie : activer la comptabilisation automatique des bulletins', 'PUT', '/settings', { options: { autoAccount: true } });
  for (const x of slips) await P(`Paie ${month} : valider le bulletin de ${x.employee}`, 'POST', `/slips/${x.id}/validate`);
  if (s) await P(`Paie ${month} : un bulletin validé ne se modifie plus (refus attendu)`, 'PUT', `/slips/${s.id}`, { bonuses: 1 }, { expect: 400 });
  const r = byEmp('rose');
  if (r && month === M1) {
    await P(`Paie ${month} : rouvrir le bulletin de Rose (prime oubliée)`, 'POST', `/slips/${r.id}/reopen`, { reason: 'Prime de clôture mensuelle oubliée' });
    await P(`Paie ${month} : ajouter la prime de Rose`, 'PUT', `/slips/${r.id}`, { bonuses: 30000, note: 'Prime de clôture mensuelle' });
    await P(`Paie ${month} : revalider le bulletin de Rose`, 'POST', `/slips/${r.id}/validate`);
  }
  const payDate = h.upTo(h.addMonth(month, 1), 3);
  const METHOD = { samuel: 'mobile', aicha: 'mobile', herve: 'mobile', jacques: 'mobile', ibrahim: 'cash' };
  for (const x of slips) {
    const k = Object.keys(E).find((kk) => E[kk] === x.employeeId);
    if (x.employeeId === E.brigitte && month === M1) continue; // salaire de Brigitte : virement en attente (cas « validé, à payer »)
    await P(`Paie ${month} : payer le salaire de ${x.employee}`, 'POST', `/slips/${x.id}/pay`, { method: METHOD[k] || 'bank', date: payDate });
    if (idx === 0) await P(`Paie ${month} : comptabiliser le bulletin de ${x.employee}`, 'POST', `/slips/${x.id}/accounting`);
  }
  if (idx === 0 && slips[0]) await P(`Paie ${month} : comptabiliser deux fois (aucun doublon)`, 'POST', `/slips/${slips[0].id}/accounting`, undefined, { expect: 200 });
  if (month === h.addMonth(h.M0, -2)) for (const x of slips) await P(`Paie ${month} : inscrire le coût de ${x.employee} au budget`, 'POST', `/slips/${x.id}/budget`);
  await P(`Paie ${month} : récapitulatif (brut, net, coût employeur)`, 'GET', `?month=${month}`);
  return slips;
}

async function payrollAfter(ctx, h) {
  const F = ctx.ids.finance; const E = F.emp; const { T, M0, addMonth } = h;
  const M1 = addMonth(M0, -1);
  const P = (f, m, u, b, o = {}) => ctx.do(f, m, '/payroll' + u, b, { as: 'accountant', ...o });
  const slips = (await P(`Paie ${M1} : bulletins`, 'GET', `/slips?month=${M1}`)).slips || [];
  const sam = slips.find((s) => s.employeeId === E.samuel);
  if (sam) {
    const one = await P(`Paie ${M1} : détail du bulletin de Samuel (absence sans solde, heures sup., avance)`, 'GET', `/slips/${sam.id}`);
    ctx.check('Paie : l\'absence sans solde est retenue automatiquement', one.slip && (one.slip.absenceDays === 3 || (one.slip.absenceDeduction || 0) > 0), one.slip && { absenceDays: one.slip.absenceDays, absenceDeduction: one.slip.absenceDeduction });
    await h.pdf(`Paie ${M1} : bulletin de Samuel en PDF`, `/share/pdf/payslip/${sam.id}`);
  }
  const paid = slips.find((x) => x.status === 'paid');
  if (paid) await P('Paie : rouvrir un bulletin payé (refus attendu)', 'POST', `/slips/${paid.id}/reopen`, { reason: 'Essai de réouverture' }, { expect: 400 });
  await P('Paie : virements à faire (banque)', 'GET', `/cm/transfers?month=${M1}&channel=bank`);
  await h.csv(`Paie ${M1} : récapitulatif CNPS (CSV)`, `/payroll/cm/export/cnps.csv?month=${M1}`, 'matricule_cnps');
  await h.csv(`Paie ${M1} : état des retenues IRPP, CAC, CFC (CSV)`, `/payroll/cm/export/irpp.csv?month=${M1}`, 'irpp');
  await h.csv(`Paie ${M1} : fichier de virements bancaires (CSV)`, `/payroll/cm/export/transfers.csv?month=${M1}&channel=bank`, 'compte_bancaire');
  await h.csv(`Paie ${M1} : fichier de paiements mobile money (CSV)`, `/payroll/cm/export/transfers.csv?month=${M1}&channel=mobile`, 'numero_mobile_money');
  // Envoi des bulletins dans l'application (aucun e-mail : chaque salarié qui a un compte les trouve dans « Documents reçus »)
  const sent = await ctx.do(`Paie ${M1} : envoyer les bulletins à chaque salarié (dans l'application)`, 'POST', '/share/payslips', { month: M1 }, { as: 'accountant' });
  ctx.check('Paie : bulletins envoyés aux salariés qui ont un compte, les autres listés', (sent.sent || 0) >= (ctx.ids.members.storekeeper ? 3 : 0) && (sent.skipped || []).length >= 4, sent);
  if (ctx.ids.members.storekeeper) {
    const inbox = await ctx.do('Paie : Paul trouve son bulletin dans « Documents reçus »', 'GET', '/share/inbox', undefined, { as: 'storekeeper' });
    ctx.check('Paie : le bulletin est arrivé chez le salarié', (inbox.items || []).some((i) => i.kind === 'payslip'), inbox);
    await ctx.do('Paie : un membre n\'accède pas à la paie (refus attendu)', 'GET', '/payroll', undefined, { as: 'storekeeper', expect: 403 });
  }
  await ctx.do('Paie : un responsable n\'accède pas à la paie (refus attendu)', 'GET', '/payroll', undefined, { as: 'manager', expect: 403 });
  // Solde de tout compte : départ du gardien
  const st = await P('Solde de tout compte : départ de Jacques Eyenga (démission)', 'POST', '/cm/settlements', { employeeId: E.jacques, exitDate: T, reason: 'Démission (préavis effectué)', otherDue: 60000, otherLabel: 'Prime d\'ancienneté au prorata', deductions: 15000 });
  if (st.id) await P('Solde de tout compte : détail', 'GET', `/cm/settlements/${st.id}`);
  const st2 = await P('Solde de tout compte : simulation avec indemnité (brouillon à jeter)', 'POST', '/cm/settlements', { employeeId: E.jacques, exitDate: T, reason: 'Simulation licenciement', noticeIndemnity: 120000, severance: 180000, unusedLeaveDays: 6 });
  if (st2.id) await P('Solde de tout compte : supprimer la simulation', 'DELETE', `/cm/settlements/${st2.id}`);
  await P('Solde de tout compte : liste', 'GET', '/cm/settlements');
  await ctx.do('RH : Jacques Eyenga quitte l\'entreprise', 'PUT', `/hr/employees/${E.jacques}`, { status: 'left' }, { as: 'manager' });
  await P(`Paie ${M0} : tableau de bord de la paie du mois`, 'GET', `?month=${M0}`);
  await P('Paie : paramètres actuels', 'GET', '/settings');
}

module.exports = { hr, payrollSetup, payrollMonth, payrollAfter, STAFF };
