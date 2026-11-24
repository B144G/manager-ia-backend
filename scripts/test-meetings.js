'use strict';
// Réunions : droits désignés par le propriétaire (par personne, par rôle, par type), convocation, invitations, réponses, déroulé, compte rendu
// (soumission, validation, renvoi, verrouillage, nouvelle version), actions → tâches de Projets, confidentialité, IA (fournisseur factice),
// tableau de bord, recherche, exports, rappels, isolation entre organisations. Lancez-le avec : node scripts/test-meetings.js
const http = require('http');
const { run } = require('./lib/wave2');
const { fakeSmtp } = require('./lib/fakes');

const ai = { seen: [], reply: null };
function fakeAiServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const j = JSON.parse(b || '{}');
        const sys = Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n\n') : (j.system || '');
        const last = ((j.messages || []).slice(-1)[0] || {}).content || '';
        ai.seen.push({ sys, last });
        res.setHeader('content-type', 'application/json');
        let text = typeof ai.reply === 'function' ? ai.reply(sys) : ai.reply;
        if (text == null) {
          if (/RÉSUMÉ|résumé d'un compte rendu/.test(sys)) text = 'Résumé de test : la réunion a validé le budget et confié le suivi à Paul.';
          else if (/DÉCISIONS prises/.test(sys)) text = JSON.stringify({ decisions: [{ text: 'Valider le budget 2027' }], actions: [{ text: 'Envoyer le devis', assignee: 'Paul', due: '2099-01-10' }, { text: 'Appeler le client', assignee: 'Inconnu', due: '2000-01-01' }] });
          else text = JSON.stringify({ items: [{ title: 'Suivi des actions en retard', durationMin: 15 }, { title: 'Budget', durationMin: 30 }] });
        }
        res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const iso = (d) => d.toISOString().slice(0, 10);
const addD = (n) => iso(new Date(Date.now() + n * 86400000));
const box = [];
const smtpTo = (addr) => box.filter((m) => new RegExp(`^To:.*${addr.replace(/[.+]/g, '\\$&')}`, 'mi').test(m));

run('Réunions : droits, convocation, compte rendu, actions → tâches, IA', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx, extra }) => {
  const MT = `${O}/meetings`; const MT2 = `${ws(org2)}/meetings`; const PR = `${O}/projects`;
  let r;
  const users = (await owner('GET', `${O}/members`)).json.members;
  const uid = (n) => users.find((u) => u.name === n).userId;
  const zoeId = Number((await dbx.prepare("SELECT id FROM users WHERE name = 'Zoe' ORDER BY id DESC LIMIT 1").get()).id);
  const ownerId = uid('Awa'); const mgrId = uid('Marc'); const memId = uid('Paul');
  const mk = (over = {}) => ({ title: 'Point hebdomadaire', type: 'team', date: addD(3), time: '10:00', durationMin: 60, place: 'Salle 1', participants: [{ userId: mgrId }, { userId: memId }], ...over });
  const D0 = addD(-2); // réunion passée (déroulé)

  // ---------- Migration rejouable ----------
  let ok = true;
  try { for (const sql of require('../src/migrations/reunions')) await dbx.exec(sql); } catch (e) { ok = e.message; }
  check('migration rejouable (CREATE … IF NOT EXISTS) sans erreur', ok === true, ok);

  // ---------- Droits par défaut : seul le propriétaire convoque et valide ----------
  r = await mgr('POST', MT, mk());
  check('par défaut, un responsable ne peut pas convoquer (403)', r.status === 403, r.status);
  r = await mem('POST', MT, mk());
  check('par défaut, un membre ne peut pas convoquer (403)', r.status === 403, r.status);
  r = await mem('GET', `${MT}/settings`);
  check('le membre voit ses propres droits (aucun) mais pas la configuration complète', r.status === 200 && r.json.me.convene.length === 0 && r.json.me.validate.length === 0 && r.json.config === undefined, r.json);
  r = await owner('GET', `${MT}/settings`);
  check('le propriétaire voit tout (types, configuration) et peut tout faire', r.json.me.convene.length === 6 && r.json.me.validate.length === 6 && r.json.config && r.json.config.distinct === false, r.json.me);
  r = await mgr('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } } });
  check('seul le propriétaire modifie les réglages (403 pour un responsable)', r.status === 403, r.status);
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { users: [zoeId] } } });
  check('réglages : une personne hors organisation est refusée', r.status === 400, r.status);
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { roles: ['owner'] } } });
  check('réglages : rôle inconnu / non délégable refusé', r.status === 400, r.status);
  r = await owner('PUT', `${MT}/settings`, { validate: { types: { fantaisie: { users: [] } } } });
  check('réglages : type de réunion inconnu refusé', r.status === 400, r.status);
  r = await owner('PUT', `${MT}/settings`, { convene: 'oui' });
  check('réglages : forme invalide refusée', r.status === 400, r.status);

  // ---------- Délégation par personne, par rôle, par type ----------
  r = await owner('PUT', `${MT}/settings`, {
    convene: { default: { users: [memId] }, types: { site: { roles: ['manager'] }, client: { users: [] } } },
    validate: { default: { users: [] }, types: { team: { users: [mgrId] }, direction: { roles: ['admin'] } } },
  });
  check('le propriétaire désigne qui convoque et qui valide', r.status === 200, r.json);
  r = await mem('GET', `${MT}/settings`);
  check('le membre désigné voit ses droits : tous types sauf chantier et client', JSON.stringify(r.json.me.convene) === JSON.stringify(['direction', 'team', 'committee', 'other']), r.json.me);
  r = await mem('POST', MT, mk({ type: 'team', title: 'Équipe par délégation' }));
  check('convocation par personne : le membre désigné convoque (type équipe)', r.status === 201, r.json);
  const byMem = r.json.id;
  r = await mem('POST', MT, mk({ type: 'site' }));
  check('un type avec règle propre REMPLACE la règle générale : le membre ne convoque pas un chantier', r.status === 403, r.status);
  r = await mgr('POST', MT, mk({ type: 'site', title: 'Chantier lundi' }));
  check('convocation par rôle et par type : un responsable convoque un chantier', r.status === 201, r.json);
  const siteId = r.json.id;
  r = await mgr('POST', MT, mk({ type: 'team' }));
  check('… mais pas une réunion d\'équipe (non désigné)', r.status === 403, r.status);
  r = await mem('POST', MT, mk({ type: 'client' }));
  check('type « client » : règle vide = propriétaire seul', r.status === 403, r.status);
  r = await owner('GET', `${MT}/settings`);
  check('configuration lisible par le propriétaire (types avec règles propres)', r.json.config.convene.types.site.roles[0] === 'manager' && r.json.config.validate.types.team.users[0] === mgrId, r.json.config);

  // ---------- Validation des entrées de convocation ----------
  const bad = async (name, over) => { const x = await owner('POST', MT, mk(over)); check(`convocation refusée : ${name}`, x.status === 400, [x.status, x.json]); };
  await bad('titre vide', { title: '' });
  await bad('date absente', { date: undefined });
  await bad('date impossible', { date: '2026-13-40' });
  await bad('date au mauvais format', { date: '12/05/2026' });
  await bad('heure invalide', { time: '25:61' });
  await bad('durée trop courte', { durationMin: 2 });
  await bad('durée trop longue', { durationMin: 5000 });
  await bad('type inconnu', { type: 'fete' });
  await bad('lien dangereux (javascript:)', { link: 'javascript:alert(1)' });
  await bad('lien illisible', { link: 'pas un lien' });
  await bad('invité sans e-mail ni numéro', { participants: [{ name: 'Sans contact' }] });
  await bad('invité avec e-mail invalide', { participants: [{ name: 'Jean', email: 'jean@' }] });
  await bad('invité avec numéro invalide', { participants: [{ name: 'Jean', phone: '12' }] });
  await bad('participant hors organisation', { participants: [{ userId: 999999 }] });
  await bad('rappel non prévu', { reminderMin: 7 });
  await bad('récurrence inconnue', { recurrence: { freq: 'quotidienne', count: 3 } });
  await bad('série de 100 réunions', { recurrence: { freq: 'weekly', count: 100 } });
  await bad('point d\'ordre du jour sans titre', { agenda: [{ title: '' }] });
  await bad('responsable de point hors organisation', { agenda: [{ title: 'Point', ownerId: 999999 }] });
  await bad('projet inconnu', { projectId: 999999 });
  await bad('pièce jointe inconnue', { attachments: [999999] });
  r = await owner('POST', MT, mk({ organizerId: 999999 }));
  check('convocation refusée : organisateur hors organisation', r.status === 400, r.status);
  r = await owner('POST', MT, mk({ title: 'x'.repeat(500) }));
  check('titre trop long : tronqué à 160 caractères, pas d\'erreur', r.status === 201, r.status);
  r = await owner('GET', `${MT}/${r.json.id}`);
  check('… et le titre enregistré fait 160 caractères', r.json.meeting.title.length === 160, r.json.meeting.title.length);

  // ---------- Pièce jointe depuis la Bibliothèque ----------
  r = await owner('GET', `${O}/library/overview`);
  const blk = (r.json.blocks || []).find((b) => b.personal) || (r.json.blocks || [])[0];
  await owner('POST', `${O}/library/blocks/${blk.id}/unlock`, { password: 'secret123' });
  const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
  r = await owner('POST', `${O}/library/blocks/${blk.id}/docs?name=${encodeURIComponent('ordre.pdf')}`, pdfBuf);
  const docId = r.json && (r.json.id || (r.json.doc && r.json.doc.id));
  check('(préparation) un document est déposé dans la Bibliothèque', r.status === 201 && docId, [r.status, r.json]);

  // ---------- Convocation complète avec invitations ----------
  const proj = await owner('POST', PR, { name: 'Chantier Bonanjo', tasks: [] });
  r = await owner('POST', MT, mk({
    title: 'Comité de pilotage', type: 'client', link: 'https://meet.google.com/abc-defg-hij', place: '', objective: 'Valider le planning', reminderMin: 60, projectId: proj.json.id, attachments: [docId],
    participants: [{ userId: mgrId }, { userId: memId }, { name: 'Client Externe', email: 'externe@client.test' }, { name: 'Jean Mobile', phone: '699123456' }],
    agenda: [{ title: 'Avancement', ownerId: mgrId, durationMin: 20 }, { title: 'Budget', ownerName: 'Le comptable', durationMin: 30 }, { title: 'Divers' }],
    send: true,
  }));
  check('convocation avec ordre du jour, invités et pièce jointe', r.status === 201 && r.json.id, r.json);
  const M1 = r.json.id;
  check('invitations envoyées à la création : notices pour 2 membres, 3 e-mails, 1 invité WhatsApp seul', r.json.invite && r.json.invite.notices === 2 && r.json.invite.email.sent === 3 && r.json.invite.whatsappOnly === 1, r.json.invite);
  const mails = smtpTo('externe@client.test');
  check('l\'invité externe a reçu l\'invitation avec l\'agenda .ics en pièce jointe', mails.length === 1 && /text\/calendar/.test(mails[0]) && /reunion\.ics/.test(mails[0]), mails.length);
  check('les membres aussi reçoivent un e-mail (leur contact est une adresse)', box.filter((m) => /^To:.*(paul|marc)\d+@exemple\.com/mi.test(m)).length >= 2, box.length);
  const nt = await dbx.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND kind = 'meeting'").get(org);
  check('notices dans l\'application pour les membres convoqués', Number(nt.c) >= 2, nt.c);
  r = await owner('GET', `${MT}/${M1}`);
  const d1 = r.json;
  check('fiche : type, lien Meet reconnu, projet, organisateur, rappel', d1.meeting.linkKind === 'meet' && d1.meeting.projectId === proj.json.id && d1.meeting.organizerId === ownerId && d1.meeting.reminderMin === 60, d1.meeting);
  check('fiche : 5 participants (organisateur ajouté), invités avec coordonnées pour le propriétaire', d1.participants.length === 5 && d1.participants.some((p) => p.email === 'externe@client.test') && d1.participants.every((p) => p.invited || !p.userId || p.userId === ownerId), d1.participants.map((p) => [p.name, p.invited]));
  check('fiche : 3 points d\'ordre du jour (responsable membre ou nom libre), 1 pièce jointe', d1.agenda.length === 3 && d1.agenda[0].owner === 'Marc' && d1.agenda[1].owner === 'Le comptable' && d1.attachments.length === 1 && d1.attachments[0].docId === docId, [d1.agenda, d1.attachments]);
  r = await mem('GET', `${MT}/${M1}`);
  check('un participant membre voit la fiche mais pas les coordonnées des invités', r.status === 200 && r.json.participants.every((p) => p.email === undefined), r.json.participants);
  r = await owner('POST', `${MT}/${M1}/invite`, {});
  check('renvoyer sans « tous » : tout le monde est déjà invité (409)', r.status === 409, r.status);
  r = await mem('POST', `${MT}/${M1}/invite`, { all: true });
  check('un simple participant ne peut pas envoyer d\'invitations (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${M1}/invite`, { all: true });
  check('renvoyer à tous : fonctionne', r.status === 200 && r.json.email.sent === 3, r.json);

  // ---------- WhatsApp : message prêt à copier ----------
  r = await owner('GET', `${MT}/${M1}/whatsapp`);
  const wa = r.json.targets.find((t) => t.name === 'Jean Mobile');
  check('WhatsApp : texte prêt à copier + lien wa.me avec indicatif 237 ajouté', r.status === 200 && /Comité de pilotage/.test(r.json.text) && wa && wa.url.startsWith('https://wa.me/237699123456?text='), r.json);
  r = await mem('GET', `${MT}/${M1}/whatsapp`);
  check('WhatsApp : réservé à ceux qui gèrent la réunion (403)', r.status === 403, r.status);

  // ---------- Agenda .ics ----------
  r = await mem('GET', `${MT}/${M1}/ics`);
  check('agenda .ics téléchargeable par un participant, heure convertie en UTC (10h au Cameroun = 09h UTC)', r.status === 200 && /BEGIN:VEVENT/.test(r.text) && /DTSTART:\d{8}T090000Z/.test(r.text) && /SUMMARY:Comité de pilotage/.test(r.text) && /text\/calendar/.test(r.headers.get('content-type')), r.text.slice(0, 200));

  // ---------- Réponses des participants ----------
  r = await mem('POST', `${MT}/${M1}/respond`, { response: 'excused' });
  check('réponse « excusé » sans motif refusée', r.status === 400, r.status);
  r = await mem('POST', `${MT}/${M1}/respond`, { response: 'peut-être' });
  check('réponse inconnue refusée', r.status === 400, r.status);
  r = await mem('POST', `${MT}/${M1}/respond`, { response: 'excused', reason: 'Voyage à Douala' });
  check('réponse « excusé » avec motif enregistrée', r.status === 200, r.json);
  r = await owner('GET', `${MT}/${M1}`);
  check('le motif figure dans la fiche, l\'organisateur est déjà « présent »', r.json.participants.find((p) => p.userId === memId).response === 'excused' && r.json.participants.find((p) => p.userId === memId).reason === 'Voyage à Douala' && r.json.participants.find((p) => p.userId === ownerId).response === 'present', r.json.participants);
  const ntn = await dbx.prepare("SELECT COUNT(*) c FROM notices WHERE user_id = ? AND text LIKE '%ne pourra pas%'").get(ownerId);
  check('l\'organisateur est prévenu d\'une absence', Number(ntn.c) === 1, ntn.c);
  r = await mgr('POST', `${MT}/${M1}/respond`, { response: 'present' });
  check('réponse « présent » du responsable', r.status === 200, r.status);
  const guest = d1.participants.find((p) => p.kind === 'guest' && p.email);
  r = await mem('POST', `${MT}/${M1}/respond`, { response: 'present', participantId: guest.id });
  check('répondre à la place d\'un invité : réservé à l\'équipe de la réunion (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${M1}/respond`, { response: 'present', participantId: guest.id });
  check('l\'organisateur enregistre la réponse d\'un invité externe', r.status === 200, r.status);
  r = await owner('POST', `${MT}/${byMem}/respond`, { response: 'present' });
  check('répondre à une réunion où l\'on n\'est pas convoqué (409)', r.status === 409, r.status);

  // ---------- Modification, annulation, suppression ----------
  r = await mem('PUT', `${MT}/${M1}`, { title: 'Piraté' });
  check('modifier une convocation sans y être autorisé (403)', r.status === 403, r.status);
  r = await owner('PUT', `${MT}/${M1}`, { time: '14:30', notify: true });
  check('modification de l\'heure + prévenir les participants', r.status === 200 && r.json.invite && r.json.invite.email.sent >= 3, r.json);
  r = await owner('GET', `${MT}/${M1}`);
  check('… les réponses sont remises à zéro (hors organisateur) car l\'heure a changé', r.json.participants.find((p) => p.userId === memId).response === 'pending' && r.json.participants.find((p) => p.userId === ownerId).response === 'present', r.json.participants.map((p) => p.response));
  r = await owner('PUT', `${MT}/${M1}`, { date: 'demain' });
  check('modification avec date invalide refusée', r.status === 400, r.status);
  r = await owner('PUT', `${MT}/${M1}`, { type: 'site' });
  check('changer de type reste soumis au droit de convoquer ce type (le propriétaire peut)', r.status === 200, r.status);
  await owner('PUT', `${MT}/${M1}`, { type: 'client' });
  r = await owner('PUT', `${MT}/${M1}/agenda`, { items: [{ id: d1.agenda[0].id, title: 'Avancement des travaux', durationMin: 25 }, { title: 'Nouveau point', durationMin: 10 }] });
  r = await owner('GET', `${MT}/${M1}`);
  check('ordre du jour remplacé en conservant les points existants', r.json.agenda.length === 2 && r.json.agenda[0].id === d1.agenda[0].id && r.json.agenda[0].title === 'Avancement des travaux', r.json.agenda);
  await owner('PUT', `${MT}/${M1}/agenda`, { items: d1.agenda.map((a) => ({ id: a.id, title: a.title, ownerId: a.ownerId, ownerName: a.owner && !a.ownerId ? a.owner : '', durationMin: a.durationMin })) });

  r = await owner('POST', MT, mk({ title: 'À annuler', type: 'other', recurrence: { freq: 'weekly', count: 3 }, send: false }));
  check('série hebdomadaire de 3 réunions', r.status === 201 && r.json.ids.length === 3, r.json);
  const ser = r.json.ids;
  r = await owner('GET', `${MT}?from=${addD(0)}&to=${addD(40)}&type=other`);
  const dates = r.json.meetings.map((m) => m.date);
  check('dates de la série espacées de 7 jours', dates.length === 3 && (Date.parse(dates[1]) - Date.parse(dates[0])) === 7 * 86400000 && (Date.parse(dates[2]) - Date.parse(dates[1])) === 7 * 86400000, dates);
  r = await owner('POST', MT, mk({ title: 'Mensuelle', type: 'other', date: '2027-01-31', recurrence: { freq: 'monthly', count: 3 } }));
  r = await owner('GET', `${MT}?from=2027-01-01&to=2027-04-30&type=other`);
  check('série mensuelle : le 31 janvier donne fin février puis le 31 mars', r.json.meetings.map((m) => m.date).join() === '2027-01-31,2027-02-28,2027-03-31', r.json.meetings.map((m) => m.date));
  r = await owner('POST', `${MT}/${ser[0]}/cancel`, { reason: '' });
  check('annulation sans motif refusée', r.status === 400, r.status);
  r = await owner('POST', `${MT}/${ser[1]}/cancel`, { reason: 'Jour férié', series: true });
  check('annulation de cette réunion et des suivantes de la série', r.status === 200 && r.json.cancelled === 2, r.json);
  r = await owner('POST', `${MT}/${ser[1]}/cancel`, { reason: 'encore' });
  check('annuler deux fois (409)', r.status === 409, r.status);
  r = await mem('POST', `${MT}/${ser[1]}/respond`, { response: 'present' });
  check('répondre à une réunion annulée (409)', r.status === 409, r.status);
  r = await owner('DELETE', `${MT}/${ser[2]}`);
  check('supprimer une réunion annulée sans compte rendu', r.status === 200, r.status);
  r = await mem('DELETE', `${MT}/${ser[0]}`);
  check('supprimer sans être organisateur (403)', r.status === 403, r.status);

  // ---------- Isolation entre organisations ----------
  r = await other('GET', `${MT2}/${M1}`);
  check('isolation : une autre organisation ne voit pas la réunion (404)', r.status === 404, r.status);
  for (const [m, p, b] of [['PUT', `/${M1}`, { title: 'x' }], ['DELETE', `/${M1}`], ['POST', `/${M1}/respond`, { response: 'present' }], ['POST', `/${M1}/invite`, {}], ['PUT', `/${M1}/notes`, { summary: 'x' }], ['POST', `/${M1}/decisions`, { text: 'x' }], ['POST', `/${M1}/minutes/submit`, {}], ['POST', `/${M1}/minutes/validate`, {}], ['GET', `/${M1}/minutes.pdf`], ['GET', `/${M1}/log`], ['GET', `/${M1}/ics`], ['POST', `/${M1}/ai/summary`, {}]]) {
    r = await other(m, `${MT2}${p}`, b);
    check(`isolation : ${m} ${p.replace(/\/\d+/, '/:id')} depuis une autre organisation → 404`, r.status === 404, r.status);
  }
  r = await owner('POST', MT, mk({ participants: [{ userId: zoeId }] }));
  check('isolation : on ne peut pas convoquer une personne d\'une autre organisation (400)', r.status === 400, r.status);
  r = await other('GET', MT2);
  check('isolation : la liste de l\'autre organisation est vide', r.status === 200 && r.json.meetings.length === 0, r.json);
  r = await other('GET', `${MT2}/dashboard`);
  check('isolation : son tableau de bord ne compte rien', r.status === 200 && r.json.meetings.total === 0, r.json.meetings);
  r = await other('GET', `${O}/meetings`);
  check('isolation : accès à l\'espace d\'une autre organisation refusé (404)', r.status === 404, r.status);

  // Les lots suivants (déroulé, compte rendu, actions, IA…) sont dans scripts/test-meetings-b.js appelé ci-dessous.
  await require('./lib/meetings-part2')({ check, owner, mgr, mem, other, org, org2, ws, O, dbx, extra, MT, MT2, PR, ownerId, mgrId, memId, uid, mk, addD, iso, D0, M1, siteId, byMem, proj, ai, box, smtpTo });
}, {
  async setup() {
    const a = await fakeAiServer(); const s = await fakeSmtp(box);
    return { a, s, env: { ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_FROM: 'MABAH <noreply@manager-ia.test>', WS_AI_FREE: '500', AI_PER_MINUTE: '500', MAIL_DAY_FREE: '500', SITE_URL: 'https://app.exemple.test' } };
  },
  async teardown(x) { x.a.srv.close(); x.s.srv.close(); },
});
