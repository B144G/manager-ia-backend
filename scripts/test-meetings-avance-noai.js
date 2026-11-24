'use strict';
// Réunions avancées SANS clé d'IA : les aides rédactionnelles répondent 503 clairement (comportement existant), tout le reste (quorum, vote, PV, signature) fonctionne.
// Aucune transcription audio n'est proposée. Lancez-le avec : node scripts/test-meetings-avance-noai.js
const { run } = require('./lib/wave2');
const iso = (d) => d.toISOString().slice(0, 10);
const addD = (n) => iso(new Date(Date.now() + n * 86400000));

run('Réunions avancées sans clé d’IA : 503 clair pour l’IA, le reste fonctionne', async ({ check, owner, mgr, mem, ws, O, dbx }) => {
  const MT = `${O}/meetings`;
  let r;
  const users = (await owner('GET', `${O}/members`)).json.members;
  const uid = (n) => users.find((u) => u.name === n).userId;
  const mgrId = uid('Marc'); const memId = uid('Paul');
  r = await owner('POST', MT, { title: 'Réunion sans IA', type: 'team', date: addD(0), participants: [{ userId: mgrId }, { userId: memId }] });
  const id = r.json.id;
  r = await owner('GET', `${MT}/${id}`);
  const pid = (u) => r.json.participants.find((p) => p.userId === u).id;
  await owner('PUT', `${MT}/${id}/presence`, { items: r.json.participants.map((p) => ({ id: p.id, attended: 'yes' })) });
  r = await owner('POST', `${MT}/${id}/resolutions`, { text: 'Adopter le règlement intérieur', voteMode: 'secret', carrierId: memId, due: addD(20) });
  const rid = r.json.ids[0];
  await owner('POST', `${MT}/${id}/resolutions/${rid}/open-vote`);
  for (const c of [owner, mgr, mem]) r = await c('POST', `${MT}/${id}/resolutions/${rid}/vote`, { choice: 'for' });
  r = await owner('POST', `${MT}/${id}/resolutions/${rid}/close-vote`);
  check('sans clé d’IA : vote secret, clôture et résultat fonctionnent', r.status === 200 && r.json.status === 'adopted', r.json);
  await owner('POST', `${MT}/${id}/start`);
  r = await owner('POST', `${MT}/${id}/pv`, {});
  check('sans clé d’IA : procès-verbal créé', r.status === 201, r.json);
  r = await owner('POST', `${MT}/${id}/pv/request-signatures`, { signers: [{ userId: mgrId }] });
  r = await mgr('POST', `${MT}/${id}/pv/sign`, {});
  check('sans clé d’IA : signature électronique', r.status === 200 && r.json.complete === true, r.json);

  r = await owner('POST', `${MT}/${id}/ai/resolutions`, { text: 'Il faut décider du règlement intérieur avant la fin du mois.' });
  check('IA : proposition de résolutions → 503 clair sans clé', r.status === 503 && /IA/.test(r.json.error), r.json);
  r = await owner('POST', `${MT}/${id}/ai/pv`, {});
  check('IA : exposé du PV → 503 clair sans clé', r.status === 503, r.json);
  r = await owner('POST', `${MT}/${id}/ai/summary`, {});
  check('IA : comportement existant du résumé inchangé (400 notes insuffisantes ou 503)', [400, 503].includes(r.status), r.status);
  r = await owner('POST', `${MT}/ai/commitments`, {});
  check('IA : relances sans engagement en retard → 400 (rien à relancer)', r.status === 400, r.json);
  await owner('PUT', `${MT}/${id}/notes`, { summary: 'Réunion tenue.' });
  r = await owner('POST', `${MT}/${id}/minutes/submit`);
  check('compte rendu soumis', r.status === 200, r.json);
  r = await owner('POST', `${MT}/${id}/minutes/validate`, { notify: false });
  check('compte rendu validé avec tâche issue de la résolution', r.status === 200 && r.json.tasks === 1, r.json);
  await dbx.prepare('UPDATE mtg_actions SET due = ? WHERE meeting_id = ? AND task_id IS NOT NULL').run(addD(-5), id);
  r = await owner('POST', `${MT}/ai/commitments`, {});
  check('IA : relances → 503 clair sans clé (les engagements en retard existent)', r.status === 503, r.json);
  r = await owner('GET', `${MT}/commitments/late`);
  check('… mais la liste des engagements non tenus fonctionne sans IA', r.status === 200 && r.json.commitments.length === 1, r.json);
  r = await owner('POST', `${MT}/ai/agenda`, { type: 'team' });
  check('ordre du jour proposé : repli sur une proposition de base sans IA (comportement existant)', r.status === 200 && r.json.ai === false && r.json.items.length >= 3, r.json);
  check('aucune route de transcription audio n’existe', (await owner('POST', `${MT}/${id}/transcribe`, {})).status === 404);
  void ws; void pid;
});
