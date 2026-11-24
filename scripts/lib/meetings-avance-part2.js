'use strict';
// Réunions avancées, 2ᵉ partie : résolutions et votes, sans quorum, procès-verbal et signatures, archives, statistiques, performances, responsabilités, IA.
module.exports = async function part2(c) {
  const { check, owner, mgr, mem, other, org, MT, MT2, ownerId, mgrId, memId, q, addD, qm, pOwner, pMgr, pMem, pGuest, ai, pidOf, QUORUM } = c;
  let r;
  const year = Number(addD(0).slice(0, 4));
  const R = `${MT}/${qm}/resolutions`;

  // ---------- Résolutions : création, numérotation, droits ----------
  r = await mem('POST', R, { text: 'Interdit' });
  check('résolution : un simple participant ne peut pas en créer (403)', r.status === 403, r.status);
  r = await owner('POST', R, { text: '' });
  check('résolution : texte obligatoire (400)', r.status === 400, r.status);
  r = await owner('POST', R, { text: 'x', majority: 'moitié' });
  check('résolution : majorité inconnue refusée (400)', r.status === 400, r.status);
  r = await owner('POST', R, { text: 'x', majority: 'qualified', threshold: 30 });
  check('résolution : seuil de majorité qualifiée hors limites (400)', r.status === 400, r.status);
  r = await owner('POST', R, { text: 'x', voteMode: 'telepathie' });
  check('résolution : mode de vote inconnu refusé (400)', r.status === 400, r.status);
  r = await owner('POST', R, { text: 'x', due: '2000-01-01' });
  check('résolution : échéance antérieure à la réunion refusée (400)', r.status === 400, r.status);
  r = await owner('POST', R, { text: 'x', carrierId: 99999 });
  check('résolution : porteur hors organisation refusé (400)', r.status === 400, r.status);
  r = await owner('POST', R, { items: [
    { title: 'Budget', text: 'Adopter le budget 2027', carrierId: memId, due: addD(30), voteMode: 'named', majority: 'simple' },
    { title: 'Statuts', text: 'Modifier les statuts', voteMode: 'secret', majority: 'qualified', threshold: 67 },
    { title: 'Recrutement', text: 'Recruter un comptable', voteMode: 'hand', majority: 'unanimity', carrierName: 'Cabinet externe' },
    { title: 'Pondéré', text: 'Investir dans un véhicule', voteMode: 'named', majority: 'simple', weighted: true },
  ] });
  check('4 résolutions créées d’un coup', r.status === 201 && r.json.ids.length === 4, r.json);
  const [R1, R2, R3, R4] = r.json.ids;
  r = await owner('GET', R);
  check('numérotation unique RES-AAAA-NNN dans l’ordre', r.json.resolutions.map((x) => x.number).join() === [1, 2, 3, 4].map((n) => `RES-${year}-00${n}`).join(), r.json.resolutions.map((x) => x.number));
  check('résolution : porteur, échéance, statut « en attente », majorité et mode consignés', r.json.resolutions[0].carrierId === memId && r.json.resolutions[0].due === addD(30) && r.json.resolutions[0].status === 'pending' && r.json.resolutions[1].threshold === 67 && r.json.resolutions[2].voteMode === 'hand', r.json.resolutions[0]);

  // ---------- Ouverture du vote : droits, quorum ----------
  r = await mem('POST', `${R}/${R1}/open-vote`);
  check('ouvrir un vote : réservé à l’organisateur (403 pour un participant)', r.status === 403, r.status);
  r = await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pMgr, attended: 'no' }] });
  r = await owner('POST', `${R}/${R1}/open-vote`);
  check('sans quorum (aucun responsable présent) : l’ouverture du vote est refusée (409, code no_quorum)', r.status === 409 && r.json.code === 'no_quorum', r.json);
  r = await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pMgr, attended: 'yes', lateMin: 12 }] });
  r = await owner('POST', `${R}/${R1}/vote`, { choice: 'for' });
  check('voter avant l’ouverture : refusé (409)', r.status === 409, r.status);
  r = await owner('POST', `${R}/${R1}/open-vote`);
  check('quorum atteint : l’organisateur ouvre le vote', r.status === 200, r.json);
  r = await owner('POST', `${R}/${R2}/open-vote`);
  check('un seul vote ouvert à la fois (409)', r.status === 409, r.status);

  // ---------- Vote nominatif ----------
  r = await mem('POST', `${R}/${R1}/vote`, { choice: 'peut-etre' });
  check('vote : choix invalide refusé (400)', r.status === 400, r.status);
  r = await mem('POST', `${R}/${R1}/vote`, { choice: 'abstain' });
  check('vote nominatif : un participant présent vote', r.status === 200 && r.json.changed === 0, r.json);
  r = await mem('POST', `${R}/${R1}/vote`, { choice: 'for' });
  check('un vote par participant : le vote est MODIFIÉ avant la clôture (pas de doublon)', r.status === 200 && r.json.changed === 1, r.json);
  check('… une seule ligne de vote pour ce participant', Number((await dbx(c).prepare('SELECT COUNT(*) c FROM mtg_votes WHERE resolution_id = ?').get(R1)).c) === 1);
  r = await mem('POST', `${R}/${R1}/vote`, { choice: 'for', participantId: pOwner });
  check('en vote électronique, on ne vote pas pour un autre (403)', r.status === 403, r.status);
  r = await mgr('POST', `${R}/${R1}/vote`, { choice: 'against' });
  check('le responsable vote contre', r.status === 200, r.json);
  r = await owner('POST', `${R}/${R1}/vote`, { choice: 'for' });
  check('l’organisateur vote pour', r.status === 200, r.json);
  r = await mem('GET', R);
  const mR1 = r.json.resolutions.find((x) => x.id === R1);
  check('pendant le vote : un participant ne voit ni le décompte ni le détail, mais son propre vote et la participation', mR1.live === undefined && mR1.details === undefined && mR1.result === undefined && mR1.myVote === 'for' && mR1.voted === 3 && mR1.rights.vote === true && mR1.roll === undefined, mR1);
  r = await owner('GET', R);
  const oR1 = r.json.resolutions.find((x) => x.id === R1);
  check('l’organisateur suit le décompte en direct et qui a voté (pas encore le détail définitif)', oR1.live.for === 2 && oR1.live.against === 1 && oR1.roll.length === 3 && oR1.roll.every((x) => x.voted), oR1);
  r = await mem('POST', `${R}/${R1}/close-vote`);
  check('clôturer un vote : réservé à l’organisateur (403)', r.status === 403, r.status);
  r = await owner('POST', `${R}/${R1}/close-vote`);
  check('clôture : majorité simple 2 pour / 1 contre → adoptée, résultat consigné avec empreinte', r.status === 200 && r.json.status === 'adopted' && r.json.result.for === 2 && r.json.result.against === 1 && /^[0-9a-f]{64}$/.test(r.json.hash), r.json);
  r = await mem('POST', `${R}/${R1}/vote`, { choice: 'against' });
  check('après la clôture : le résultat est verrouillé (409)', r.status === 409, r.status);
  r = await owner('POST', `${R}/${R1}/open-vote`);
  check('un vote clos ne se rouvre pas (409)', r.status === 409, r.status);
  r = await owner('PUT', `${R}/${R1}`, { text: 'Texte modifié après vote' });
  check('le texte d’une résolution votée ne change plus (409)', r.status === 409, r.status);
  r = await owner('DELETE', `${R}/${R1}`);
  check('une résolution votée ne se supprime pas (409)', r.status === 409, r.status);
  r = await mem('GET', R);
  const done1 = r.json.resolutions.find((x) => x.id === R1);
  check('vote nominatif clos : le détail par personne est visible, avec le résultat', done1.status === 'adopted' && done1.details.length === 3 && done1.details.find((d) => d.name === 'Marc').choice === 'against' && done1.result.for === 2, done1);
  r = await owner('GET', `${MT}/${qm}`);
  check('résolution adoptée → décision consignée avec son numéro', r.json.decisions.some((d) => d.text.startsWith(`RES-${year}-001`)), r.json.decisions);
  const act = r.json.actions.find((a) => /RES-/.test(a.text));
  check('résolution adoptée avec porteur et échéance → action créée pour le porteur', act && act.assigneeId === memId && act.due === addD(30), r.json.actions);
  check('journal d’audit : ouverture, votes, clôture — sans jamais écrire le choix', (await q("SELECT detail FROM mtg_log WHERE meeting_id = ? AND action IN ('vote_open', 'vote_cast', 'vote_close')", qm)).length >= 5 && !(await q("SELECT detail FROM mtg_log WHERE meeting_id = ? AND action = 'vote_cast'", qm)).some((x) => /pour|contre|against|for\b/i.test(x.detail)));

  // ---------- Vote secret, majorité qualifiée ----------
  r = await owner('POST', `${R}/${R2}/open-vote`);
  for (const [cl, ch] of [[owner, 'for'], [mem, 'for'], [mgr, 'against']]) r = await cl('POST', `${R}/${R2}/vote`, { choice: ch });
  check('vote secret : chacun a voté', r.status === 200, r.json);
  const sv = await q('SELECT participant_id, cast_at FROM mtg_votes WHERE resolution_id = ?', R2);
  check('vote secret : en base, aucun lien entre le bulletin et la personne (participant et heure absents)', sv.length === 3 && sv.every((v) => v.participant_id === null && v.cast_at === null), sv);
  check('vote secret : le tableau d’émargement dit QUI a voté, jamais CE qu’il a voté', Number((await dbx(c).prepare('SELECT COUNT(*) c FROM mtg_vote_roll WHERE resolution_id = ?').get(R2)).c) === 3 && !Object.keys((await q('SELECT * FROM mtg_vote_roll WHERE resolution_id = ?', R2))[0]).includes('choice'));
  r = await owner('GET', R);
  const sR2 = r.json.resolutions.find((x) => x.id === R2);
  check('vote secret ouvert : l’organisateur voit le décompte agrégé mais aucun détail par personne', sR2.live.for === 2 && sR2.details === undefined && !JSON.stringify(sR2).includes('"name":"Marc","choice"'), sR2);
  r = await owner('POST', `${R}/${R2}/close-vote`);
  check('qualifiée à 67 % : 2 pour sur 3 exprimés (66,7 %) → REJETÉE', r.status === 200 && r.json.status === 'rejected' && r.json.result.for === 2 && r.json.result.against === 1, r.json);
  r = await mem('GET', R);
  const sR2c = r.json.resolutions.find((x) => x.id === R2);
  check('vote secret clos : résultat agrégé visible de tous, détail par personne JAMAIS visible, son propre vote seulement', sR2c.result.for === 2 && sR2c.details === undefined && sR2c.myVote === 'for' && sR2c.status === 'rejected', sR2c);
  r = await owner('GET', R);
  check('… même pour l’organisateur (pas de détail en vote secret)', r.json.resolutions.find((x) => x.id === R2).details === undefined, 1);
  r = await owner('POST', R, { text: 'Même vote, seuil 60 %', voteMode: 'secret', majority: 'qualified', threshold: 60 });
  const R5 = r.json.ids[0];
  await owner('POST', `${R}/${R5}/open-vote`);
  for (const [cl, ch] of [[owner, 'for'], [mem, 'for'], [mgr, 'against']]) await cl('POST', `${R}/${R5}/vote`, { choice: ch });
  r = await owner('POST', `${R}/${R5}/close-vote`);
  check('qualifiée à 60 % : mêmes votes → ADOPTÉE (seuil configurable)', r.json.status === 'adopted' && r.json.result.threshold === 60, r.json);

  // ---------- Vote à main levée saisi par le secrétaire, unanimité ----------
  await owner('POST', `${R}/${R3}/open-vote`);
  r = await mem('POST', `${R}/${R3}/vote`, { choice: 'for' });
  check('main levée : un participant ne vote pas lui-même (403) — le secrétaire saisit', r.status === 403, r.status);
  r = await owner('POST', `${R}/${R3}/vote`, { items: [{ participantId: pGuest, choice: 'for' }] });
  check('main levée : l’invité externe sans droit de vote est refusé (403)', r.status === 403, r.status);
  r = await owner('POST', `${R}/${R3}/vote`, { items: [{ participantId: pOwner, choice: 'for' }, { participantId: pMem, choice: 'for' }, { participantId: pMgr, choice: 'abstain' }] });
  check('main levée : saisie groupée des votes par le secrétaire', r.status === 200 && r.json.count === 3, r.json);
  r = await owner('POST', `${R}/${R3}/close-vote`);
  check('unanimité : aucun contre (une abstention) → adoptée', r.json.status === 'adopted' && r.json.result.abstain === 1 && r.json.result.mode === 'hand', r.json);
  r = await owner('POST', R, { text: 'Unanimité refusée', voteMode: 'hand', majority: 'unanimity' });
  const R6 = r.json.ids[0];
  await owner('POST', `${R}/${R6}/open-vote`);
  await owner('POST', `${R}/${R6}/vote`, { items: [{ participantId: pOwner, choice: 'for' }, { participantId: pMem, choice: 'for' }, { participantId: pMgr, choice: 'against' }] });
  r = await owner('POST', `${R}/${R6}/close-vote`);
  check('unanimité : un seul contre → rejetée', r.json.status === 'rejected', r.json);

  // ---------- Pondération ----------
  r = await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pOwner, voteWeight: 3 }] });
  check('pondération : poids de vote d’un participant', r.status === 200, r.json);
  await owner('POST', `${R}/${R4}/open-vote`);
  for (const [cl, ch] of [[owner, 'against'], [mem, 'for'], [mgr, 'for']]) await cl('POST', `${R}/${R4}/vote`, { choice: ch });
  r = await owner('POST', `${R}/${R4}/close-vote`);
  check('vote pondéré : 3 voix contre 2 → rejeté (sans pondération il aurait été adopté)', r.json.status === 'rejected' && r.json.result.against === 3 && r.json.result.for === 2 && r.json.result.weighted === true, r.json);
  await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pOwner, voteWeight: null }] });

  // ---------- Quorum perdu avant la clôture ----------
  r = await owner('POST', R, { text: 'Vote interrompu', voteMode: 'named' });
  const R7 = r.json.ids[0];
  await owner('POST', `${R}/${R7}/open-vote`);
  await mem('POST', `${R}/${R7}/vote`, { choice: 'for' });
  await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pMgr, attended: 'no' }] });
  r = await owner('POST', `${R}/${R7}/close-vote`);
  check('quorum perdu avant la clôture : la résolution devient « sans quorum » (résultat nul)', r.json.status === 'no_quorum' && r.json.result.void === true, r.json);
  await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pMgr, attended: 'yes', lateMin: 12 }] });

  // ---------- Report d'une résolution ----------
  r = await owner('POST', R, { text: 'À reporter', voteMode: 'named' });
  const R8 = r.json.ids[0];
  r = await owner('POST', `${R}/${R8}/postpone`, {});
  check('report : motif obligatoire (400)', r.status === 400, r.status);
  const other1 = (await owner('POST', MT, { title: 'Réunion cible du report', type: 'team', date: addD(50), participants: [{ userId: memId }] })).json.id;
  r = await owner('POST', `${R}/${R8}/postpone`, { reason: 'Documents manquants', toMeetingId: other1 });
  check('report à une autre réunion : statut « reportée », copie dans la réunion cible avec un nouveau numéro', r.status === 200 && r.json.carriedTo, r.json);
  r = await owner('GET', `${MT}/${other1}/resolutions`);
  check('… la réunion cible reçoit la résolution en attente', r.json.resolutions.length === 1 && r.json.resolutions[0].status === 'pending' && r.json.resolutions[0].text === 'À reporter', r.json);
  r = await owner('POST', `${R}/${R1}/postpone`, { reason: 'Trop tard' });
  check('une résolution dont le résultat est consigné ne peut plus être reportée (409)', r.status === 409, r.status);
  r = await owner('POST', R, { text: 'À supprimer' });
  const R9 = r.json.ids[0];
  r = await owner('DELETE', `${R}/${R9}`);
  check('une résolution sans vote se supprime', r.status === 200, r.status);

  // ---------- Registre des résolutions ----------
  r = await owner('GET', `${MT}/resolutions`);
  const st = Object.fromEntries((await q('SELECT status, COUNT(*) c FROM mtg_resolutions GROUP BY status')).map((x) => [x.status, Number(x.c)]));
  check('registre : toutes les résolutions de l’organisation (propriétaire)', r.status === 200 && r.json.resolutions.length >= 8, r.json.resolutions.length);
  r = await owner('GET', `${MT}/resolutions?status=adopted`);
  check('registre : filtre par statut', r.json.resolutions.length === st.adopted && r.json.resolutions.every((x) => x.status === 'adopted'), [r.json.resolutions.length, st]);
  r = await owner('GET', `${MT}/resolutions.csv`);
  check('registre : export CSV', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && /RES-/.test(r.text), r.status);
  r = await other('GET', `${MT2}/resolutions`);
  check('isolation : le registre d’une autre organisation est vide', r.status === 200 && r.json.resolutions.length === 0, r.json);

  // ---------- Confidentialité des résolutions ----------
  r = await owner('POST', MT, { title: 'Comité confidentiel', type: 'direction', date: addD(0), confidential: true, participants: [{ userId: mgrId }] });
  const conf = r.json.id;
  const confRes = (await owner('POST', `${MT}/${conf}/resolutions`, { text: 'Résolution secrète' })).json.ids[0];
  r = await mem('GET', `${MT}/${conf}/resolutions`);
  check('confidentialité : un non-participant ne voit pas la réunion confidentielle ni ses résolutions (404)', r.status === 404, r.status);
  r = await mem('POST', `${MT}/${conf}/resolutions/${confRes}/vote`, { choice: 'for' });
  check('confidentialité : un non-participant ne peut pas voter (404)', r.status === 404, r.status);
  r = await mem('GET', `${MT}/resolutions`);
  check('confidentialité : le registre n’affiche pas les résolutions d’une réunion confidentielle étrangère', r.status === 200 && !r.json.resolutions.some((x) => x.text === 'Résolution secrète'), r.json.resolutions.length);
  r = await mem('GET', `${MT}/${conf}/pv`);
  check('confidentialité : procès-verbal inaccessible (404)', r.status === 404, r.status);

  // ---------- Réunion sans quorum : statut explicite, report automatique ----------
  r = await owner('POST', MT, { title: 'Assemblée sans quorum', type: 'team', date: addD(0), time: '15:00', place: 'Salle Akwa', participants: [{ userId: mgrId }, { userId: memId }] });
  const nq = r.json.id;
  r = await owner('GET', `${MT}/${nq}`);
  const nqMem = pidOf(r.json, memId);
  await owner('PUT', `${MT}/${nq}/presence`, { items: [{ id: nqMem, attended: 'yes' }] });
  r = await owner('POST', `${MT}/${nq}/resolutions`, { text: 'Décision qui ne sera pas valable', carrierId: memId, due: addD(10) });
  const nqRes = r.json.ids[0];
  r = await owner('POST', `${MT}/${nq}/resolutions/${nqRes}/open-vote`);
  check('sans quorum : le vote ne peut pas être ouvert', r.status === 409 && r.json.code === 'no_quorum', r.json);
  r = await mem('POST', `${MT}/${nq}/no-quorum`, {});
  check('déclarer l’absence de quorum : réservé à l’équipe de la réunion (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${qm}/no-quorum`, {});
  check('quorum atteint : on ne peut pas déclarer l’absence de quorum (409)', r.status === 409, r.status);
  r = await owner('POST', `${MT}/${nq}/no-quorum`, { reason: 'Un seul présent sur trois' });
  check('absence de quorum déclarée : statut explicite, report automatique à quorum réduit (+3 jours)', r.status === 200 && r.json.status === 'no_quorum' && r.json.reconvened && r.json.reconvened.date === addD(3), r.json);
  const child = r.json.reconvened.id;
  r = await owner('GET', `${MT}/${nq}`);
  check('fiche : statut « sans quorum », motif, réunion de report liée', r.json.meeting.status === 'no_quorum' && r.json.meeting.noQuorumReason === 'Un seul présent sur trois' && r.json.child.id === child, r.json.meeting);
  r = await owner('GET', `${MT}/${nq}/resolutions`);
  check('sans quorum : la résolution en attente devient « sans quorum » (décision non valide)', r.json.resolutions[0].status === 'no_quorum' && r.json.resolutions[0].voteState === 'closed', r.json.resolutions[0]);
  r = await owner('GET', `${MT}/${child}`);
  check('nouvelle convocation à quorum réduit : même ordre du jour et participants, mode réduit, liée à la première', r.json.meeting.quorumMode === 'reduced' && r.json.meeting.parentId === nq && r.json.participants.length === 3 && r.json.meeting.date === addD(3), r.json.meeting);
  check('… et les participants sont prévenus', (await q("SELECT 1 FROM notices WHERE user_id = ? AND text LIKE '%quorum réduit%'", memId)).length === 1);
  r = await owner('POST', `${MT}/${nq}/no-quorum`, {});
  check('déjà sans quorum : 409', r.status === 409, r.status);
  r = await owner('POST', `${MT}/${nq}/start`);
  check('une réunion sans quorum ne s’ouvre pas (409)', r.status === 409, r.status);
  r = await owner('GET', `${MT}/${child}/quorum`);
  check('quorum réduit : règle de 1 présent (au lieu de 2 + un responsable)', r.json.quorum.mode === 'reduced' && r.json.quorum.needCount === 1 && r.json.quorum.roles.length === 0, r.json.quorum);
  const cpid = pidOf((await owner('GET', `${MT}/${child}`)).json, memId);
  r = await owner('PUT', `${MT}/${child}/presence`, { items: [{ id: cpid, attended: 'yes' }] });
  check('2ᵉ convocation : 1 présent suffit', r.json.quorum.ok === true, r.json.quorum);
  r = await owner('POST', `${MT}/${child}/no-quorum`, {});
  check('la 2ᵉ convocation ne se reporte pas indéfiniment (quorum atteint → 409)', r.status === 409, r.status);
  // le compte rendu d'une réunion sans quorum ne crée pas de tâches
  await owner('PUT', `${MT}/${nq}/notes`, { summary: 'Séance levée faute de quorum.' });
  await owner('POST', `${MT}/${nq}/actions`, { text: 'Action sans valeur', assigneeId: memId, due: addD(5) });
  r = await owner('POST', `${MT}/${nq}/minutes/submit`);
  check('compte rendu d’une réunion sans quorum : soumis, le statut « sans quorum » est conservé', r.status === 200 && (await q('SELECT status FROM mtg_meetings WHERE id = ?', nq))[0].status === 'no_quorum', r.json);
  r = await mgr('POST', `${MT}/${nq}/minutes/validate`, { notify: false });
  check('… validé SANS créer de tâches (décisions non valides)', r.status === 200 && r.json.tasks === 0, r.json);
  r = await owner('POST', `${MT}/${nq}/pv`);
  check('procès-verbal d’une réunion sans quorum : créé, avec la trace du report', r.status === 201, r.json);
  r = await owner('GET', `${MT}/${nq}/pv`);
  check('PV : trace « sans quorum » et nouvelle convocation consignées', r.json.pv.content.quorum.noQuorum === true && r.json.pv.content.quorum.reconvened.id === child && r.json.pv.content.quorum.reason === 'Un seul présent sur trois', r.json.pv.content.quorum);
  r = await owner('GET', `${MT}/${child}`);
  check('la 2ᵉ convocation connaît la réunion précédente (PV : « fait suite à »)', r.json.meeting.parentId === nq, 1);

  // ---------- Compte rendu : déroulé, signature de validation ----------
  r = await owner('POST', `${MT}/${qm}/start`);
  check('ouverture de la séance (horodatée)', r.status === 200 && r.json.quorum.ok, r.json);
  r = await owner('POST', `${MT}/${qm}/start`);
  check('séance déjà ouverte (409)', r.status === 409, r.status);
  r = await owner('POST', `${R}/${R7}/open-vote`);
  check('un vote déjà clos ne bloque pas la fin de séance', r.status === 409, r.status);
  await owner('PUT', `${MT}/${qm}/notes`, { summary: 'Séance ordinaire : budget adopté, statuts rejetés.' });
  // réaffectation d'une action : historique des responsabilités
  r = await owner('GET', `${MT}/${qm}`);
  const actR1 = r.json.actions.find((a) => /RES-/.test(a.text));
  r = await owner('PUT', `${MT}/${qm}/actions/${actR1.id}`, { assigneeId: mgrId });
  check('action réaffectée du porteur au responsable', r.status === 200, r.json);
  r = await owner('POST', `${MT}/${qm}/end`);
  check('fin de séance (horodatée)', r.status === 200, r.json);
  r = await owner('POST', `${MT}/${qm}/end`);
  check('séance déjà levée (409)', r.status === 409, r.status);

  // ---------- Procès-verbal ----------
  r = await mem('POST', `${MT}/${qm}/pv`);
  check('procès-verbal : réservé à l’équipe de la réunion (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${qm}/pv`, {});
  check('procès-verbal numéroté PV-AAAA-NNN (distinct du compte rendu)', r.status === 201, r.json);
  r = await owner('POST', `${MT}/${qm}/pv`, {});
  check('un seul procès-verbal actif par réunion (409)', r.status === 409, r.status);
  r = await owner('GET', `${MT}/${qm}/pv`);
  const pvc = r.json.pv.content;
  check('PV : présences (retard), quorum constaté, résolutions et votes (nominatif détaillé, secret agrégé seul)', /^PV-\d{4}-\d{3}$/.test(r.json.pv.number) && pvc.attendance.length === 4 && pvc.attendance.find((p) => p.name === 'Marc').lateMin === 12 && pvc.quorum.ok && pvc.quorum.present === 3
    && pvc.resolutions.length >= 7 && pvc.resolutions.find((x) => x.number === `RES-${year}-001`).details.length === 3 && pvc.resolutions.find((x) => x.number === `RES-${year}-002`).details === null && pvc.resolutions.find((x) => x.number === `RES-${year}-002`).result.for === 2, r.json.pv.number);
  r = await mem('GET', `${MT}/${qm}/pv`);
  check('PV en projet : invisible d’un simple participant', r.json.pv === null, r.json);
  r = await owner('PUT', `${MT}/${qm}/pv`, { narrative: 'La séance est ouverte à 9 h.' });
  check('PV : exposé modifiable tant qu’il est en projet', r.status === 200, r.json);
  r = await owner('POST', `${MT}/${qm}/ai/pv`, {});
  check('IA : exposé du PV proposé à partir des faits (présences, quorum, résolutions)', r.status === 200 && /Exposé de test/.test(r.json.narrative) && r.json.ai === true, r.json);
  check('IA : les faits (résolutions, quorum) sont transmis dans un bloc <donnees>', ai.seen.some((s) => /<donnees>/.test(s) && /Résolution RES-/.test(s) && /Quorum/.test(s)));
  r = await owner('POST', `${MT}/${qm}/pv/request-signatures`, { signers: [{ userId: 99999 }] });
  check('signatures : signataire hors organisation refusé (400)', r.status === 400, r.status);
  r = await owner('POST', `${MT}/${qm}/pv/request-signatures`, { signers: [{ userId: mgrId, role: 'Secrétaire' }, { userId: memId, role: 'Membre' }], ordered: true });
  check('signatures demandées (dans l’ordre) : PV verrouillé, empreinte calculée', r.status === 200 && /^[0-9a-f]{64}$/.test(r.json.hash) && r.json.signers === 2, r.json);
  r = await owner('PUT', `${MT}/${qm}/pv`, { narrative: 'Tentative de modification' });
  check('PV verrouillé : plus de modification (409)', r.status === 409, r.status);
  r = await owner('POST', `${MT}/${qm}/pv/sign`, {});
  check('signature : seule une personne désignée peut signer (403)', r.status === 403, r.status);
  r = await mem('POST', `${MT}/${qm}/pv/sign`, {});
  check('signature dans l’ordre : le 2ᵉ ne peut pas signer avant le 1ᵉʳ (409)', r.status === 409 && /ordre/.test(r.json.error), r.json);
  r = await mgr('POST', `${MT}/${qm}/pv/sign`, { comment: 'Lu et approuvé' });
  check('1ʳᵉ signature : horodatage et empreinte', r.status === 200 && r.json.complete === false && /^[0-9a-f]{64}$/.test(r.json.hash), r.json);
  r = await mgr('POST', `${MT}/${qm}/pv/sign`, {});
  check('double signature refusée (409)', r.status === 409, r.status);
  check('signataire suivant prévenu (mode « dans l’ordre »)', (await q("SELECT 1 FROM notices WHERE user_id = ? AND kind = 'meeting_sign' AND text LIKE '%votre tour%'", memId)).length === 1);
  r = await mem('POST', `${MT}/${qm}/pv/sign`, {});
  check('2ᵉ signature : le PV est signé par tous', r.status === 200 && r.json.complete === true, r.json);
  r = await mem('GET', `${MT}/${qm}/pv`);
  check('PV signé : visible des participants, intact (empreinte recalculée identique), 2 signatures', r.json.pv.status === 'signed' && r.json.pv.intact === true && r.json.signatures.length === 2 && r.json.signatures.every((s) => s.signed && s.signedAt), r.json.pv);
  r = await mem('GET', `${MT}/${qm}/pv.pdf`);
  check('PV : export PDF', r.status === 200 && /application\/pdf/.test(r.headers.get('content-type')) && r.buf.slice(0, 5).toString() === '%PDF-' && /proces-verbal-PV-/.test(r.headers.get('content-disposition')), r.status);
  r = await owner('PUT', `${MT}/${qm}/pv`, { narrative: 'x' });
  check('PV signé : verrouillé définitivement (409)', r.status === 409, r.status);
  r = await owner('POST', `${MT}/${qm}/pv/new-version`, { reason: 'Correction d’un nom' });
  check('nouvelle version d’un PV signé : réservée à ceux qui valident (le propriétaire le peut)', r.status === 200 && r.json.version === 2 && /-R2$/.test(r.json.number), r.json);
  r = await owner('GET', `${MT}/${qm}/pv`);
  check('l’ancienne version est conservée (remplacée), la nouvelle est un projet', r.json.pv.version === 2 && r.json.pv.status === 'draft' && r.json.versions.length === 2 && r.json.versions[1].status === 'superseded', r.json.versions);
  r = await mem('POST', `${MT}/${qm}/pv/new-version`, { reason: 'x' });
  check('nouvelle version : refusée à un simple participant (403)', r.status === 403, r.status);
  // altération du contenu : signature refusée
  await owner('POST', `${MT}/${qm}/pv/request-signatures`, { signers: [{ userId: mgrId }] });
  await dbx(c).prepare("UPDATE mtg_pv SET narrative = 'texte altéré en base' WHERE meeting_id = ? AND status = 'signing'").run(qm);
  r = await mgr('POST', `${MT}/${qm}/pv/sign`, {});
  check('contenu altéré en base : la signature est refusée (l’empreinte ne correspond plus)', r.status === 409 && /empreinte/.test(r.json.error), r.json);
  r = await mgr('GET', `${MT}/${qm}/pv`);
  check('… et l’intégrité est signalée fausse', r.json.pv.intact === false, r.json.pv.intact);

  // ---------- Signature du compte rendu ----------
  r = await owner('POST', `${MT}/${qm}/minutes/submit`);
  check('compte rendu soumis (contient les résolutions et le quorum)', r.status === 200, r.json);
  const snap = JSON.parse((await q("SELECT content FROM mtg_minutes WHERE meeting_id = ? AND status = 'submitted'", qm))[0].content);
  check('instantané : résolutions numérotées, résultats agrégés, présences avec retard', snap.resolutions.length >= 7 && snap.resolutions[0].result.for === 2 && snap.attendance.some((a) => a.lateMin === 12), snap.resolutions.length);
  r = await mgr('POST', `${MT}/${qm}/minutes/validate`, { notify: false });
  check('validation : tâches créées (action issue de la résolution adoptée)', r.status === 200 && r.json.tasks >= 1, r.json);
  const tk = await q("SELECT t.title, t.assignee_id FROM tasks t JOIN mtg_actions a ON a.task_id = t.id WHERE a.meeting_id = ? AND t.title LIKE '%RES-%'", qm);
  check('… la tâche issue de la résolution est assignée à la personne désignée (après réaffectation)', tk.filter((t) => /RES-\d+-001/.test(t.title)).length === 1 && Number(tk.find((t) => /RES-\d+-001/.test(t.title)).assignee_id) === mgrId, tk);
  r = await mem('GET', `${MT}/${qm}/signatures`);
  check('signature électronique de la validation : validateur, horodatage, empreinte, intégrité vérifiée', r.status === 200 && r.json.signatures.some((s) => s.kind === 'minutes' && s.name === 'Marc' && /^[0-9a-f]{64}$/.test(s.hash) && s.intact === true), r.json);
  r = await owner('POST', `${MT}/${qm}/resolutions`, { text: 'Trop tard' });
  check('compte rendu validé : plus de nouvelle résolution (409, verrouillé)', r.status === 409, r.status);
  r = await owner('POST', `${R}/${R8}/postpone`, { reason: 'x' });
  check('compte rendu validé : plus de report (409)', r.status === 409, r.status);

  // ---------- Archivage ----------
  r = await mem('POST', `${MT}/${qm}/archive`);
  check('archivage : réservé à ceux qui valident (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${qm}/archive`);
  check('archivage refusé tant que le PV (nouvelle version) n’est pas signé (409)', r.status === 409, r.json);
  r = await owner('POST', `${MT}/${other1}/archive`);
  check('archivage refusé sans compte rendu validé (409)', r.status === 409, r.status);
  await dbx(c).prepare("UPDATE mtg_pv SET status = 'superseded' WHERE meeting_id = ? AND status = 'signing'").run(qm);
  r = await owner('POST', `${MT}/${qm}/archive`);
  check('archivage d’une réunion validée sans PV en cours', r.status === 200, r.json);
  r = await owner('POST', `${MT}/${qm}/archive`);
  check('déjà archivée (409)', r.status === 409, r.status);
  r = await mem('GET', `${MT}/archives`);
  check('archives : consultables par les participants (compte rendu validé, nombre de résolutions)', r.status === 200 && r.json.meetings.length === 1 && r.json.meetings[0].id === qm && r.json.meetings[0].resolutions >= 7, r.json);
  r = await owner('GET', `${MT}/archives?q=ordinaire&year=${year}`);
  check('archives : recherche par titre et année', r.json.meetings.length === 0, r.json.meetings.length);
  r = await owner('GET', `${MT}?archived=1`);
  check('liste : filtre « archivées »', r.json.meetings.length === 1, r.json.meetings.length);
  r = await mem('POST', `${MT}/${qm}/unarchive`);
  check('sortir des archives : réservé à ceux qui valident (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${qm}/unarchive`);
  check('sortie des archives', r.status === 200, r.status);

  // ---------- Statistiques ----------
  const S = `${MT}/stats?from=${year}-01-01&to=${year + 1}-12-31`;
  r = await owner('GET', S);
  const dbSt = Object.fromEntries((await q('SELECT status, COUNT(*) c FROM mtg_resolutions GROUP BY status')).map((x) => [x.status, Number(x.c)]));
  const decided = (dbSt.adopted || 0) + (dbSt.rejected || 0) + (dbSt.postponed || 0) + (dbSt.no_quorum || 0);
  check('statistiques : taux de décision = adoptées / (adoptées + rejetées + reportées + sans quorum)', r.status === 200 && r.json.resolutions.adopted === (dbSt.adopted || 0) && r.json.resolutions.decisionRate === Math.round(((dbSt.adopted || 0) / decided) * 100), r.json.resolutions);
  check('statistiques : taux d’adoption parmi les votes (adoptées / adoptées + rejetées)', r.json.resolutions.adoptionRate === Math.round((dbSt.adopted / (dbSt.adopted + dbSt.rejected)) * 100), r.json.resolutions);
  check('statistiques : réunions par statut dont « sans quorum », par type, par site, par service, urgentes, multi-sites, inter-services', r.json.meetings.no_quorum === 1 && r.json.byType.length >= 2 && r.json.bySite.some((x) => x.name === 'Douala') && r.json.byService.some((x) => x.name === 'Commercial') && r.json.byUrgency.some((x) => x.urgency === 'urgent') && r.json.meetings.multiSite === 0 && r.json.meetings.interService === 1, [r.json.meetings, r.json.byUrgency]);
  check('statistiques : présence, ponctualité (retard de 12 min), durée réelle mesurée', r.json.attendance.lateCount >= 1 && r.json.attendance.avgLateMin === 12 && r.json.attendance.rate !== null && r.json.duration.measured >= 1 && r.json.duration.avgPlannedMin > 0, [r.json.attendance, r.json.duration]);
  check('statistiques : tâches issues des réunions réalisées / en retard / ouvertes', r.json.tasks.total >= 1 && r.json.tasks.open >= 1 && r.json.tasks.late === 0, r.json.tasks);
  check('statistiques : courbe mensuelle (réunions, présence, taux de décision)', r.json.trend.length >= 1 && r.json.trend.every((t) => t.month && t.meetings >= 0) && r.json.trend.some((t) => t.decisionRate !== null), r.json.trend);
  r = await owner('GET', `${S}&type=committee`);
  check('statistiques : filtre par type', r.status === 200 && r.json.resolutions.total === 0, r.json.resolutions);
  r = await owner('GET', `${S}&branchId=${c.b1}`);
  check('statistiques : filtre par site', r.json.meetings.total === 1, r.json.meetings);
  r = await owner('GET', `${S}&departmentId=${c.d1}`);
  check('statistiques : filtre par service', r.json.meetings.total === 1, r.json.meetings);
  r = await owner('GET', `${S}&urgency=urgent`);
  check('statistiques : filtre par urgence', r.json.meetings.total === 1, r.json.meetings);
  r = await owner('GET', `${MT}/stats?from=2030-01-01&to=2029-01-01`);
  check('statistiques : période inversée refusée (400)', r.status === 400, r.status);
  r = await owner('GET', `${MT}/stats?urgency=folle`);
  check('statistiques : filtre inconnu refusé (400)', r.status === 400, r.status);
  const all = (await owner('GET', S)).json.meetings.total;
  r = await mem('GET', S);
  check('statistiques : un participant ne compte que les réunions qu’il peut voir (la réunion confidentielle étrangère est exclue)', r.status === 200 && r.json.meetings.total < all, [r.json.meetings.total, all]);
  r = await other('GET', `${MT2}/stats`);
  check('isolation : statistiques d’une autre organisation à zéro', r.status === 200 && r.json.meetings.total === 0 && r.json.resolutions.total === 0, r.json.meetings);

  // ---------- Performances et responsabilités ----------
  r = await owner('GET', `${MT}/performance?from=${year}-01-01&to=${year + 1}-12-31`);
  const perfMgr = r.json.people.find((p) => p.userId === mgrId);
  check('performances : équipe entière pour le propriétaire — engagements, présence, ponctualité, rôles', r.status === 200 && r.json.scope === 'team' && perfMgr.commitments.total >= 1 && perfMgr.attendance.late >= 1 && perfMgr.attendance.avgLateMin === 12 && perfMgr.attendance.punctualityRate < 100 && r.json.people.find((p) => p.userId === ownerId).roles.organizer >= 5, r.json.people);
  r = await mem('GET', `${MT}/performance`);
  check('performances : un simple membre ne voit que lui-même', r.status === 200 && r.json.scope === 'person' && r.json.people.every((p) => p.userId === memId), r.json);
  r = await mem('GET', `${MT}/performance?userId=${mgrId}`);
  check('performances : un simple membre ne consulte pas celles d’un collègue (403)', r.status === 403, r.status);
  r = await mgr('GET', `${MT}/performance`);
  check('performances : une personne qui valide voit l’équipe', r.json.scope === 'team' && r.json.people.length >= 2, r.json.scope);
  r = await owner('GET', `${MT}/performance?userId=99999`);
  check('performances : personne inconnue (400)', r.status === 400, r.status);
  r = await owner('GET', `${MT}/responsibilities?userId=${mgrId}&q=résolution`);
  check('historique des responsabilités : porteur d’action « désigné » le responsable, avec la réunion et l’auteur', r.status === 200 && r.json.events.some((e) => e.kind === 'action' && e.event === 'assigned' && e.person === 'Marc' && /RES-/.test(e.subject) && e.meetingTitle === 'Conseil avec quorum' && e.by === 'Awa'), r.json.events.slice(0, 3));
  r = await owner('GET', `${MT}/responsibilities?userId=${memId}`);
  check('… la personne initialement porteuse apparaît « déchargée » (réaffectation tracée, chronologique)', r.json.events.some((e) => e.kind === 'action' && e.event === 'unassigned') && r.json.events.some((e) => e.kind === 'resolution' && e.role === 'carrier' && e.event === 'assigned' && e.number === `RES-${year}-001`) && r.json.events.every((e, i, a) => !i || a[i - 1].at >= e.at), r.json.events);
  r = await owner('GET', `${MT}/responsibilities?kind=role&userId=${ownerId}`);
  check('historique : rôles de séance (organisateur) par réunion', r.json.events.length >= 5 && r.json.events.every((e) => e.kind === 'role' && e.role), r.json.events.length);
  r = await owner('GET', `${MT}/responsibilities?q=budget`);
  check('historique par sujet : recherche libre', r.json.events.length >= 1 && r.json.events.every((e) => /budget/i.test(e.subject) || /budget/i.test(e.meetingTitle)), r.json.events.length);
  r = await owner('GET', `${MT}/responsibilities?meetingId=${qm}`);
  check('historique par réunion', r.json.events.length >= 3 && r.json.events.every((e) => e.meetingId === qm), r.json.events.length);
  check('responsables actuels : le dernier désigné par sujet (la personne déchargée n’y est plus)', r.json.current.some((e) => e.person === 'Marc' && e.kind === 'action') && !r.json.current.some((e) => e.kind === 'action' && e.person === 'Paul' && /RES-/.test(e.subject)), r.json.current.length);
  r = await mem('GET', `${MT}/responsibilities?userId=${mgrId}`);
  check('historique : un simple membre ne consulte pas celui d’un collègue (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}`, { title: 'Réunion à huis clos', type: 'direction', date: addD(0), confidential: true, participants: [{ userId: mgrId }] });
  await owner('POST', `${MT}/${r.json.id}/actions`, { text: 'Engagement confidentiel', assigneeId: memId, due: addD(5) });
  r = await mem('GET', `${MT}/responsibilities`);
  check('confidentialité : les engagements d’une réunion confidentielle étrangère n’apparaissent pas dans l’historique du membre', r.status === 200 && !r.json.events.some((e) => /Engagement confidentiel/.test(e.subject)), r.json.events.map((e) => e.subject));

  // ---------- Engagements non tenus ----------
  await dbx(c).prepare("UPDATE mtg_actions SET due = ? WHERE meeting_id = ? AND task_id IS NOT NULL").run(addD(-10), qm);
  r = await owner('GET', `${MT}/commitments/late`);
  check('engagements non tenus : liste avec jours de retard', r.status === 200 && r.json.commitments.length >= 1 && r.json.commitments[0].daysLate >= 10, r.json);
  r = await mem('GET', `${MT}/commitments/late`);
  check('engagements non tenus : un membre ne voit que les siens', r.status === 200 && r.json.commitments.every((x) => x.assigneeId === memId), r.json);
  r = await mem('POST', `${MT}/commitments/remind`);
  check('relance de l’équipe : réservée à ceux qui convoquent ou valident (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/commitments/remind`);
  check('relance : notices envoyées aux responsables en retard', r.status === 200 && r.json.people >= 1 && (await q("SELECT 1 FROM notices WHERE user_id = ? AND text LIKE 'Engagements en retard%'", mgrId)).length === 1, r.json);
  r = await owner('POST', `${MT}/reminders/run`, {});
  check('rappels automatiques : au-delà d’une semaine de retard, l’organisateur est aussi prévenu', r.status === 200 && r.json.actions >= 1 && (await q("SELECT 1 FROM notices WHERE user_id = ? AND text LIKE 'Engagement non tenu%'", ownerId)).length >= 1, r.json);
  check('rappels : les nouveaux compteurs (quorum, signatures) sont renvoyés', r.json.quorum !== undefined && r.json.signatures !== undefined, r.json);

  // ---------- Rappels : quorum menacé, signature en attente ----------
  const at = new Date(Date.now() + 3 * 3600000);
  const tm = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  r = await owner('POST', MT, { title: 'Quorum menacé', type: 'team', date: at.toISOString().slice(0, 10), time: tm, participants: [{ userId: mgrId }, { userId: memId }] });
  const risk = r.json.id;
  r = await owner('POST', `${MT}/reminders/run`, {});
  check('quorum menacé (moins de 24 h, présences confirmées insuffisantes) : l’organisateur est prévenu', r.json.quorum === 1 && (await q("SELECT 1 FROM notices WHERE user_id = ? AND kind = 'meeting_quorum' AND ref = ?", ownerId, `meeting:${risk}`)).length === 1, r.json);
  r = await owner('POST', `${MT}/reminders/run`, {});
  check('… une seule fois (pas de doublon)', r.json.quorum === 0, r.json);
  await owner('POST', `${MT}/${qm}/pv`, {});
  await owner('POST', `${MT}/${qm}/pv/request-signatures`, { signers: [{ userId: memId }] });
  await dbx(c).prepare("UPDATE mtg_pv SET locked_at = ? WHERE meeting_id = ? AND status = 'signing'").run(new Date(Date.now() - 72 * 3600000).toISOString(), qm);
  r = await owner('POST', `${MT}/reminders/run`, {});
  check('signature en attente depuis plus de 48 h : un rappel au signataire', r.json.signatures >= 1, r.json);
  r = await owner('POST', `${MT}/reminders/run`, {});
  check('… sans doublon', r.json.signatures === 0, r.json);

  // ---------- IA : résolutions, relances ----------
  r = await mem('POST', `${MT}/${qm}/ai/resolutions`, {});
  check('IA : réservée à ceux qui rédigent (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${other1}/ai/resolutions`, { text: 'Il faut valider le budget 2027 avant fin janvier ; Paul prépare le dossier.' });
  check('IA : propose des résolutions (porteur reconnu, échéance valide, entrées sans texte écartées) — rien n’est enregistré', r.status === 200 && r.json.resolutions.length === 1 && r.json.resolutions[0].carrierId === memId && r.json.resolutions[0].due === '2099-02-01' && (await q('SELECT COUNT(*) c FROM mtg_resolutions WHERE meeting_id = ?', other1))[0].c == 1, r.json);
  r = await owner('POST', `${MT}/${other1}/ai/resolutions`, { text: 'court' });
  check('IA : notes insuffisantes → 400', r.status === 400, r.status);
  r = await owner('POST', `${MT}/ai/commitments`, {});
  check('IA : relances rédigées pour les engagements non tenus (propositions seulement)', r.status === 200 && r.json.reminders.length === 1 && r.json.reminders[0].assignee === 'Paul' && r.json.commitments >= 1, r.json);
  r = await mem('POST', `${MT}/ai/commitments`, {});
  check('IA : relances réservées à ceux qui convoquent ou valident (403)', r.status === 403, r.status);
  r = await other('POST', `${MT2}/${qm}/ai/pv`, {});
  check('isolation : IA sur une réunion d’une autre organisation (404)', r.status === 404, r.status);

  // ---------- Limites réglables et salle de visioconférence (partage d'écran) ----------
  const guests = (n) => Array.from({ length: n }, (_, i) => ({ name: `Invité ${i}`, email: `invite${i}@exemple.com` }));
  const base = { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] } } };
  r = await owner('GET', `${MT}/settings`);
  check('limite de participants : 60 par défaut, visible de tous', r.json.maxParticipants === 60, r.json.maxParticipants);
  r = await owner('POST', MT, { title: 'Grande réunion', type: 'team', date: addD(8), participants: guests(70) });
  check('au-delà de la limite par défaut (60) : refusé avec un message clair', r.status === 400 && /60 participants/.test(r.json.error) && /réglable/.test(r.json.error), r.json);
  r = await mgr('PUT', `${MT}/settings`, { ...base, maxParticipants: 300 });
  check('seul le propriétaire règle la limite (403)', r.status === 403, r.status);
  r = await owner('PUT', `${MT}/settings`, { ...base, maxParticipants: 501 });
  check('limite hors bornes refusée (400)', r.status === 400, r.status);
  r = await owner('PUT', `${MT}/settings`, { ...base, maxParticipants: 5 });
  check('limite trop basse refusée (400)', r.status === 400, r.status);
  r = await owner('PUT', `${MT}/settings`, { ...base, maxParticipants: 300 });
  check('le propriétaire relève la limite à 300', r.status === 200 && r.json.config.maxParticipants === 300 && r.json.config.quorum.team, r.json.config);
  r = await owner('POST', MT, { title: 'Grande réunion', type: 'team', date: addD(8), participants: guests(70), autoRoom: true });
  check('70 participants acceptés avec la limite relevée ; salle de visioconférence créée automatiquement', r.status === 201, r.json);
  const big = r.json.id;
  r = await owner('GET', `${MT}/${big}`);
  check('la salle est un lien Jitsi Meet non devinable (partage d’écran dans la salle)', r.json.meeting.linkKind === 'jitsi' && /^https:\/\/meet\.jit\.si\/BrijIA-\d+-[0-9a-f]{18}$/.test(r.json.meeting.link) && r.json.participants.length === 71, r.json.meeting);
  r = await owner('POST', `${MT}/${big}/room`, {});
  check('une réunion qui a déjà un lien ne reçoit pas une 2ᵉ salle sans remplacement explicite (409)', r.status === 409, r.status);
  r = await owner('POST', `${MT}/${big}/room`, { replace: true });
  check('remplacement explicite de la salle', r.status === 200 && r.json.kind === 'jitsi', r.json);
  const noRoom = (await owner('POST', MT, { title: 'Sans salle', type: 'team', date: addD(9), participants: [{ userId: memId }] })).json.id;
  r = await mem('POST', `${MT}/${noRoom}/room`, {});
  check('créer la salle : réservé à l’équipe de la réunion (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${noRoom}/room`, {});
  check('salle créée à la demande ; les participants sont prévenus', r.status === 200 && (await q("SELECT 1 FROM notices WHERE user_id = ? AND ref = ? AND text LIKE 'Salle de visioconférence%'", memId, `meeting:${noRoom}`)).length === 1, r.json);
  r = await other('POST', `${MT2}/${noRoom}/room`, {});
  check('isolation : salle d’une autre organisation (404)', r.status === 404, r.status);
  r = await owner('POST', `${MT}/${noRoom}/participants`, { participants: guests(310) });
  check('ajout de participants au-delà de la limite relevée (300) : refusé', r.status === 400 && /300/.test(r.json.error), r.json);
  r = await owner('POST', `${MT}/${noRoom}/participants`, { participants: guests(50) });
  check('ajout de 50 invités sous la limite : accepté', r.status === 201 && r.json.added === 50, r.json);

  // ---------- Isolation générale des nouvelles routes ----------
  for (const [m, p, b] of [['GET', `/${qm}/quorum`], ['PUT', `/${qm}/presence`, { items: [{ id: 1 }] }], ['POST', `/${qm}/start`, {}], ['POST', `/${qm}/no-quorum`, {}], ['GET', `/${qm}/resolutions`], ['POST', `/${qm}/resolutions`, { text: 'x' }],
    ['POST', `/${qm}/resolutions/${R1}/vote`, { choice: 'for' }], ['GET', `/${qm}/pv`], ['POST', `/${qm}/pv`, {}], ['POST', `/${qm}/pv/sign`, {}], ['GET', `/${qm}/pv.pdf`], ['GET', `/${qm}/signatures`], ['POST', `/${qm}/archive`, {}], ['GET', `/${qm}/conflicts`], ['POST', `/${qm}/agenda/propose`, { title: 'x' }]]) {
    r = await other(m, `${MT2}${p}`, b);
    check(`isolation : ${m} ${p.replace(/\/\d+/g, '/:id')} depuis une autre organisation → 404`, r.status === 404, r.status);
  }
};

// Petit adaptateur : accès direct à la base de test (même objet que dbx du harnais).
function dbx(c) { return c.dbx; }
