'use strict';
// Vague 3 · RH : soldes de congés, jours fériés, notifications, dossier du personnel chiffré, contrats et échéances, pointage, recrutement, évaluations, formations.
// Lancez-le avec : node scripts/test-wave3-hr.js
const { run } = require('./lib/wave1');
const year = new Date().getUTCFullYear();
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => iso(new Date(Date.now() + n * 86400000));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('SECRET-CNI-SCAN-0123456789')]);

run('Vague 3 · RH', async ({ check, owner, mgr, mem, other, org, org2, O, ws, dbx }) => {
  const H = `${O}/hr`;
  let r = await mem('GET', `${H}/holidays`);
  check('jours fériés : fermé aux simples membres', r.status === 403, r.status);
  r = await mgr('GET', `${H}/holidays?year=${year}`);
  check('jours fériés du Cameroun pré-remplis (exemple, modifiables)', r.status === 200 && r.json.items.length >= 7 && r.json.items.every((h) => h.source === 'exemple') && r.json.items.some((h) => h.date === `${year}-05-20`), r.json);
  check('1er janvier et Noël présents', r.json.items.some((h) => h.date === `${year}-01-01`) && r.json.items.some((h) => h.date === `${year}-12-25`));
  r = await mgr('POST', `${H}/holidays`, { date: `${year}-09-01`, name: 'Fête locale' });
  check('un responsable ne modifie pas la liste', r.status === 403);
  r = await owner('POST', `${H}/holidays`, { date: `${year}-09-01`, name: 'Fête locale' });
  check('un administrateur ajoute un jour férié', r.status === 201, r.json);
  r = await owner('POST', `${H}/holidays`, { date: `${year}-09-01`, name: 'Doublon' });
  check('doublon de date refusé', r.status === 409);
  const hid = (await mgr('GET', `${H}/holidays?year=${year}`)).json.items.find((h) => h.date === `${year}-05-01`).id;
  r = await owner('PUT', `${H}/holidays/${hid}`, { name: 'Fête du Travail (modifiée)' });
  check('jour férié modifiable', r.status === 200);
  r = await mgr('GET', `${H}/holidays?year=${year}`);
  check('modification conservée (source manuelle)', r.json.items.find((h) => h.id === hid).source === 'manual' && r.json.items.find((h) => h.id === hid).name.includes('modifiée'));

  // Employés
  const members = (await owner('GET', `${O}/members`)).json.members;
  const paulId = members.find((m) => m.name === 'Paul').userId;
  r = await owner('POST', `${O}/hr/employees`, { name: 'Jean Test', job: 'Vendeur', hiredAt: `${year}-01-01`, salary: 150000, userId: paulId });
  const jean = r.json.id;
  r = await owner('POST', `${O}/hr/employees`, { name: 'Ancienne Test', job: 'Caissière', hiredAt: `${year - 1}-01-01` });
  const anc = r.json.id;

  // Soldes
  const today = new Date(); const cap = today < new Date(Date.UTC(year, 11, 31)) ? today : new Date(Date.UTC(year, 11, 31));
  const t1 = new Date(cap.getTime() + 86400000);
  const monthsDone = (t1.getUTCFullYear() - year) * 12 + t1.getUTCMonth() - (t1.getUTCDate() < 1 ? 1 : 0);
  r = await mgr('GET', `${H}/balances?year=${year}`);
  let bj = r.json.items.find((x) => x.employeeId === jean);
  check('acquisition 1,5 j ouvrable par mois par défaut', r.json.accrualPerMonth === 1.5 && bj.accrued === monthsDone * 1.5, { got: bj, expected: monthsDone * 1.5 });
  let ba = r.json.items.find((x) => x.employeeId === anc);
  check('report de l\'an dernier plafonné (18 j acquis, report max 10)', ba.carried === 10, ba);
  r = await mgr('PUT', `${H}/settings`, { leave_carry_max: 5 });
  check('réglages RH : réservés aux administrateurs', r.status === 403);
  r = await owner('PUT', `${H}/settings`, { leave_carry_max: 5 });
  check('report max réglable', r.status === 200 && r.json.settings.leave_carry_max === 5);
  r = await mgr('GET', `${H}/balances?year=${year}`);
  check('le nouveau plafond de report s\'applique', r.json.items.find((x) => x.employeeId === anc).carried === 5);
  r = await owner('PUT', `${H}/settings`, { leave_accrual: 2, leave_carry_max: 10 });
  r = await mgr('GET', `${H}/balances?year=${year}`);
  check('taux d\'acquisition réglable (2 j / mois)', r.json.items.find((x) => x.employeeId === jean).accrued === monthsDone * 2, r.json.items.find((x) => x.employeeId === jean));
  await owner('PUT', `${H}/settings`, { leave_accrual: 1.5 });
  r = await owner('POST', `${H}/leave-adjustments`, { employeeId: jean, year: String(year), days: 20, note: 'Régularisation' });
  check('ajustement manuel du solde (administrateur)', r.status === 201, r.json);
  r = await mgr('POST', `${H}/leave-adjustments`, { employeeId: jean, year: String(year), days: 1 });
  check('ajustement refusé à un responsable', r.status === 403);

  // Demande de congé : contrôle du solde, notifications
  r = await mgr('POST', `${O}/hr/leaves`, { employeeId: jean, kind: 'annual', start: `${year}-11-02`, end: `${year}-12-20` });
  check('solde insuffisant : demande refusée avec explication', r.status === 400 && /Solde insuffisant/.test(r.json.error), r.json);
  const hol = new Set((await mgr('GET', `${H}/holidays?year=${year}`)).json.items.map((h) => h.date));
  const wd = (a, b) => { let n = 0; for (let d = new Date(a + 'T00:00:00Z'); iso(d) <= b; d = new Date(d.getTime() + 86400000)) if (d.getUTCDay() !== 0 && !hol.has(iso(d))) n++; return n; };
  const ls = `${year}-12-01`; const le = `${year}-12-04`;
  r = await mgr('POST', `${O}/hr/leaves`, { employeeId: jean, kind: 'annual', start: ls, end: le });
  const leaveId = r.json.id;
  check('demande dans la limite du solde acceptée', r.status === 201 && leaveId, r.json);
  r = await owner('GET', `${O}/notices`);
  check('les responsables sont prévenus d\'une demande de congé', r.json.items.some((n) => /Nouvelle demande de congé/.test(n.text)), r.json);
  r = await mgr('GET', `${H}/balances?year=${year}`);
  bj = r.json.items.find((x) => x.employeeId === jean);
  check('jours en attente comptés (jours ouvrables hors fériés)', bj.pending === wd(ls, le) && bj.available === bj.balance - bj.pending, { bj, wd: wd(ls, le) });
  r = await owner('PUT', `${O}/hr/leaves/${leaveId}/decision`, { decision: 'approved' });
  check('congé accepté', r.status === 200);
  r = await mem('GET', `${O}/notices`);
  check('l\'employé est notifié de la décision', r.json.unread >= 1 && r.json.items.some((n) => /acceptée/.test(n.text)), r.json);
  r = await mem('POST', `${O}/notices/read`, {});
  r = await mem('GET', `${O}/notices`);
  check('notifications marquées comme lues', r.json.unread === 0);
  r = await mem('GET', `${H}/my-balance`);
  check('l\'employé lit son propre solde', r.status === 200 && r.json.linked === true && r.json.taken === wd(ls, le), r.json);

  // Dossier du personnel
  r = await mgr('GET', `${H}/employees/${jean}/file`);
  check('dossier du personnel : réservé aux administrateurs', r.status === 403);
  r = await owner('PUT', `${H}/employees/${jean}/file`, { cniNo: '123456789', birthDate: '1990-05-05', emergencyName: 'Marie T.', emergencyPhone: '699000000', diplomas: 'BTS Commerce', cnpsNo: 'CNPS-001' });
  check('dossier enregistré (CNI, contact d\'urgence, diplômes, matricule CNPS)', r.status === 200, r.json);
  r = await owner('GET', `${H}/employees/${jean}/file`);
  check('dossier relu', r.json.file.cniNo === '123456789' && r.json.file.emergencyName === 'Marie T.' && r.json.file.cnpsNo === 'CNPS-001', r.json);
  r = await owner('POST', `${H}/employees/${jean}/files?name=cni`, PNG);
  check('pièce chiffrée téléversée', r.status === 201 && r.json.name === 'cni.png', r.json);
  const fid = r.json.id;
  const row = await dbx.prepare('SELECT data FROM legal_files WHERE id = ?').get(fid);
  check('la pièce est chiffrée dans la base (contenu en clair absent)', !Buffer.from(row.data).includes(Buffer.from('SECRET-CNI-SCAN')));
  r = await owner('GET', `${H}/employees/files/${fid}/file`);
  check('administrateur : téléchargement et contenu identique', r.status === 200 && Buffer.compare(r.buf, PNG) === 0 && r.headers.get('x-content-type-options') === 'nosniff');
  r = await mgr('GET', `${H}/employees/files/${fid}/file`);
  check('responsable : téléchargement refusé', r.status === 403);
  r = await mgr('GET', `${O}/legal/files/${fid}/file`);
  check('la pièce RH n\'est pas lisible via le module Juridique', r.status === 404, r.status);
  r = await owner('POST', `${H}/employees/${jean}/files?name=x`, Buffer.from('ceci n\'est pas un PDF ni une image'));
  check('format non reconnu refusé (type lu dans le contenu)', r.status === 400);
  r = await owner('GET', `${O}/audit?entity=employee_file`);
  const upd = r.json.items.find((i) => i.action === 'update');
  check('audit : valeurs avant / après, CNI masquée', upd && upd.after.cni_no === '***' && upd.after.address === undefined && r.json.items.some((i) => i.action === 'read'), upd);
  r = await mgr('GET', `${O}/audit`);
  check('journal d\'audit réservé aux administrateurs', r.status === 403);

  // Contrats et échéances
  r = await mem('GET', `${H}/contracts`);
  check('contrats : fermé aux membres', r.status === 403);
  r = await mgr('POST', `${H}/contracts`, { employeeId: jean, kind: 'cdd', startDate: addDays(-300), endDate: addDays(10), trialEnd: addDays(5), medicalDue: addDays(-3) });
  check('contrat CDD avec fin d\'essai et visite médicale', r.status === 201, r.json);
  r = await mgr('POST', `${H}/contracts`, { employeeId: jean, kind: 'cdi', startDate: addDays(10), endDate: addDays(1) });
  check('fin avant début refusée', r.status === 400);
  r = await mgr('POST', `${H}/trainings`, { employeeId: anc, title: 'Habilitation électrique', kind: 'certification', doneAt: addDays(-700), expiresAt: addDays(7) });
  check('habilitation enregistrée', r.status === 201, r.json);
  r = await mgr('GET', `${H}/due`);
  const kinds = r.json.items.map((i) => i.kind);
  check('échéances : fin de CDD, essai, visite médicale (dépassée), habilitation', ['contract_end', 'trial_end', 'medical', 'certification'].every((k) => kinds.includes(k)) && r.json.items.find((i) => i.kind === 'medical').expired === true, r.json);
  r = await mgr('GET', `${O}/dashboard/alerts`);
  check('alertes (insights) : échéances RH visibles', r.json.alerts.some((a) => a.module === 'hr' && /visite médicale/.test(a.text)) && r.json.alerts.some((a) => /habilitation/.test(a.text)), r.json.alerts.filter((a) => a.module === 'hr'));

  // Pointage
  r = await mgr('POST', `${H}/attendance`, { employeeId: jean, day: addDays(-1), status: 'late', minutesLate: 25 });
  check('retard pointé', r.status === 201, r.json);
  r = await mgr('POST', `${H}/attendance`, { employeeId: jean, day: addDays(-1), status: 'present' });
  check('même jour pointé deux fois : refusé', r.status === 409);
  await mgr('POST', `${H}/attendance`, { employeeId: anc, day: addDays(-1), status: 'absent' });
  r = await mgr('GET', `${H}/attendance-summary?month=${addDays(-1).slice(0, 7)}`);
  check('synthèse du mois : retards et absences', r.json.items.find((x) => x.employeeId === jean).late === 1 && r.json.items.find((x) => x.employeeId === jean).minutesLate === 25 && r.json.items.find((x) => x.employeeId === anc).absent === 1, r.json);

  // Recrutement
  r = await mgr('POST', `${H}/jobs`, { title: 'Comptable', description: 'Poste à pourvoir' });
  const job = r.json.id;
  r = await mgr('POST', `${H}/candidates`, { jobId: job, name: 'Candidate Un', email: 'c1@exemple.com', stage: 'new' });
  const cand = r.json.id;
  r = await mgr('PUT', `${H}/candidates/${cand}`, { stage: 'interview' });
  check('étape du candidat changée', r.status === 200);
  r = await mgr('POST', `${H}/candidates`, { jobId: 999999, name: 'X' });
  check('offre inconnue refusée', r.status === 400);
  r = await mgr('POST', `${H}/candidates/${cand}/hire`, {});
  check('embauche réservée aux administrateurs', r.status === 403);
  r = await owner('POST', `${H}/candidates/${cand}/hire`, {});
  check('embauche : employé créé', r.status === 201 && r.json.employeeId, r.json);
  r = await mgr('GET', `${H}/jobs`);
  check('liste des offres avec nombre de candidats', r.json.items.find((j) => j.id === job).candidates === 1);

  // Évaluations
  r = await mgr('POST', `${H}/reviews`, { employeeId: jean, period: `${year} S1`, score: 4, strengths: 'Ponctuel', goals: 'Vente additionnelle' });
  check('évaluation enregistrée', r.status === 201, r.json);
  r = await mgr('POST', `${H}/reviews`, { employeeId: jean, period: 'X', score: 9 });
  check('note hors limites refusée', r.status === 400);
  r = await mgr('GET', `${H}/reviews?employeeId=${jean}`);
  check('évaluations listées avec le nom', r.json.items.length === 1 && r.json.items[0].employee === 'Jean Test');

  // Poste vacant -> offre
  r = await owner('POST', `${O}/structure/positions`, { title: 'Responsable logistique' });
  const pos = r.json.id;
  r = await mem('GET', `${O}/structure/vacancies`);
  check('postes vacants listés', r.json.items.some((v) => v.id === pos));
  r = await mgr('POST', `${H}/jobs/from-position/${pos}`, {});
  check('offre créée depuis un poste vacant', r.status === 201 && r.json.created === true, r.json);
  r = await mem('GET', `${O}/structure/vacancies`);
  check('le poste vacant porte son offre', r.json.items.find((v) => v.id === pos).jobId);

  // Étanchéité
  r = await other('GET', `${ws(org)}/hr/jobs`);
  check('autre organisation : aucun accès', r.status === 404);
  r = await other('GET', `${ws(org2)}/hr/holidays`);
  check('chaque organisation a ses propres jours fériés', r.status === 200 && r.json.items.length >= 7);
  r = await owner('DELETE', `${O}/hr/employees/${jean}`);
  const left = await dbx.prepare("SELECT COUNT(*) c FROM legal_files WHERE parent_type = 'employee' AND parent_id = ?").get(jean);
  check('suppression de l\'employé : pièces supprimées', r.status === 200 && Number(left.c) === 0);
});
