'use strict';
// Réunions avancées (migrations 146+) : types personnalisés, quorum en direct, urgence, conflits d'agenda, multi-sites / inter-services, séries avec exceptions,
// résolutions et vote électronique (main levée, nominatif, secret ; majorités ; pondération), réunion sans quorum, procès-verbal et signatures,
// archivage, statistiques, performances, historique des responsabilités, IA (fournisseur factice), droits d'accès et confidentialité.
// Lancez-le avec : node scripts/test-meetings-avance.js
const http = require('http');
const { run } = require('./lib/wave2');

const ai = { seen: [] };
function fakeAiServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const j = JSON.parse(b || '{}');
        const sys = Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n\n') : (j.system || '');
        ai.seen.push(sys);
        res.setHeader('content-type', 'application/json');
        let text;
        if (/RÉSOLUTIONS/.test(sys)) text = JSON.stringify({ resolutions: [{ title: 'Budget 2027', text: 'Il est décidé d’adopter le budget 2027.', carrier: 'Paul', due: '2099-02-01' }, { title: 'Sans texte', text: '' }] });
        else if (/EXPOSÉ/.test(sys)) text = 'Exposé de test : la séance est ouverte, le quorum est atteint.';
        else if (/RELANCE/.test(sys)) text = JSON.stringify({ reminders: [{ assignee: 'Paul', message: 'Bonjour Paul, pouvez-vous faire le point sur votre engagement ?' }] });
        else text = 'Résumé de test.';
        res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const iso = (d) => d.toISOString().slice(0, 10);
const addD = (n) => iso(new Date(Date.now() + n * 86400000));

run('Réunions avancées : quorum, urgence, conflits, votes, procès-verbaux, statistiques', async (ctx) => {
  const { check, owner, mgr, mem, other, org, org2, ws, O, dbx, extra } = ctx;
  const MT = `${O}/meetings`; const MT2 = `${ws(org2)}/meetings`;
  let r;
  const users = (await owner('GET', `${O}/members`)).json.members;
  const uid = (n) => users.find((u) => u.name === n).userId;
  const ownerId = uid('Awa'); const mgrId = uid('Marc'); const memId = uid('Paul');
  const q = async (sql, ...a) => await dbx.prepare(sql).all(...a);

  // ---------- Migrations 146+ rejouables ----------
  let ok = true;
  try { for (const sql of require('../src/migrations/reunions-avance')) await dbx.exec(sql); } catch (e) { ok = e.message; }
  check('migrations 146 à 149 rejouables sans erreur', ok === true, ok);

  // ---------- Réglages : droits de la règle centrale (inchangés) + quorum, préavis, signatures ----------
  const QUORUM = { team: { minCount: 2, minPercent: 50, roles: { manager: 1 }, reduced: { allowed: true, minCount: 1, minPercent: 0, delayDays: 3 } }, committee: { minPercent: 60 } };
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] } }, quorum: QUORUM });
  check('le propriétaire règle le quorum par type (nombre, pourcentage, présences minimales par rôle, quorum réduit)', r.status === 200 && r.json.config.quorum.team.minCount === 2 && r.json.config.quorum.team.roles.manager === 1 && r.json.config.quorum.team.reduced.allowed, r.json);
  r = await mem('GET', `${MT}/settings`);
  check('un membre lit la règle de quorum mais pas la configuration complète', r.status === 200 && r.json.quorum.team.minPercent === 50 && r.json.config === undefined, r.json);
  r = await mgr('PUT', `${MT}/settings`, { quorum: QUORUM });
  check('seul le propriétaire modifie le quorum (403)', r.status === 403, r.status);
  r = await owner('PUT', `${MT}/settings`, { quorum: { fantaisie: { minCount: 2 } } });
  check('quorum : type inconnu refusé (400)', r.status === 400, r.status);
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] } }, quorum: { team: { minPercent: 500, minCount: -3 } } });
  check('quorum : valeurs hors limites ignorées (pas de règle absurde enregistrée)', r.status === 200 && !r.json.config.quorum.team, r.json.config.quorum);
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] } }, quorum: QUORUM });
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] } } });
  check('modifier les droits sans renvoyer le quorum conserve la règle de quorum', r.status === 200 && r.json.config.quorum.team.minCount === 2, r.json.config.quorum);

  // ---------- Types de réunions personnalisés ----------
  r = await mem('POST', `${MT}/types`, { name: 'Interdit', base: 'team' });
  check('types : un membre ne crée pas de type (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/types`, { name: 'Comité de pilotage', base: 'committee', color: '#336699', durationMin: 90, confidential: true, reminderMin: 60, quorum: { minCount: 2 } });
  check('types : le propriétaire crée un type (catégorie de droits, durée, confidentialité, rappel, quorum)', r.status === 201, r.json);
  const typeId = r.json.id;
  r = await owner('POST', `${MT}/types`, { name: 'comité de pilotage', base: 'team' });
  check('types : nom en double refusé (409)', r.status === 409, r.status);
  r = await owner('POST', `${MT}/types`, { name: 'X', base: 'inconnu' });
  check('types : catégorie inconnue refusée (400)', r.status === 400, r.status);
  r = await owner('GET', `${MT}/types`);
  check('types : liste des catégories (avec règle de quorum) et des types personnalisés', r.json.builtin.length === 6 && r.json.builtin.find((t) => t.id === 'team').quorum.minCount === 2 && r.json.custom[0].name === 'Comité de pilotage' && r.json.custom[0].durationMin === 90, r.json);
  r = await owner('POST', MT, { title: 'Pilotage T4', typeId, date: addD(20) });
  check('réunion créée depuis un type : catégorie, durée, confidentialité et rappel par défaut du type', r.status === 201, r.json);
  const pilot = r.json.id;
  r = await owner('GET', `${MT}/${pilot}`);
  check('… valeurs héritées du type (comité, 90 min, confidentielle, rappel 60 min) et nom du type', r.json.meeting.type === 'committee' && r.json.meeting.durationMin === 90 && r.json.meeting.confidential && r.json.meeting.reminderMin === 60 && r.json.typeName === 'Comité de pilotage', r.json.meeting);
  r = await owner('POST', MT, { title: 'x', typeId: 99999, date: addD(5) });
  check('types : type inconnu refusé à la convocation (400)', r.status === 400, r.status);
  r = await mgr('POST', MT, { title: 'Hors droits', typeId, date: addD(5) });
  check('le type personnalisé suit la règle centrale : le responsable désigné pour convoquer (par défaut) peut l’utiliser', r.status === 201, r.status);
  r = await owner('DELETE', `${MT}/types/${typeId}`);
  check('type utilisé : désactivé plutôt que supprimé', r.status === 200 && r.json.deactivated === true, r.json);
  r = await owner('POST', MT, { title: 'x', typeId, date: addD(5) });
  check('type désactivé : refusé à la convocation (400)', r.status === 400, r.status);

  // ---------- Réunion urgente : préavis réduit, notification prioritaire ----------
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] } }, quorum: QUORUM, noticeH: { normal: 48, urgent: 1, critical: 0 } });
  check('préavis par niveau d’urgence configurable', r.status === 200 && r.json.config.noticeH.normal === 48 && r.json.config.noticeH.urgent === 1, r.json.config.noticeH);
  const soon = new Date(Date.now() + 3 * 3600000); const soonDate = iso(soon); const soonTime = `${String(soon.getUTCHours() + 1).padStart(2, '0')}:00`.replace(/^24/, '23');
  r = await owner('POST', MT, { title: 'Normale à court préavis', type: 'team', date: soonDate, time: soonTime, participants: [{ userId: memId }] });
  check('réunion normale à court préavis : créée avec un avertissement « préavis trop court »', r.status === 201 && r.json.notice.short === true && r.json.notice.requiredHours === 48, r.json.notice);
  r = await owner('POST', MT, { title: 'Urgente : incident client', type: 'team', date: soonDate, time: soonTime, urgency: 'urgent', participants: [{ userId: memId }, { userId: mgrId }] });
  check('réunion urgente : préavis réduit respecté, invitations envoyées d’office, rappel 15 min par défaut', r.status === 201 && r.json.notice.short === false && r.json.invite && r.json.invite.notices >= 2, r.json);
  const urgentId = r.json.id;
  const nt = await q("SELECT kind, text FROM notices WHERE user_id = ? AND ref = ? ORDER BY id DESC", memId, `meeting:${urgentId}`);
  check('notification prioritaire : type « meeting_urgent » et texte URGENT', nt.length && nt[0].kind === 'meeting_urgent' && /URGENT/.test(nt[0].text), nt);
  r = await mem('GET', `${MT}/${urgentId}/ics`);
  check('agenda .ics : priorité 1 et titre [URGENT]', /PRIORITY:1/.test(r.text) && /\[URGENT\]/.test(r.text), r.text.slice(0, 300));
  r = await owner('GET', `${MT}/${urgentId}`);
  check('détail : niveau d’urgence et rappel par défaut 15 min', r.json.meeting.urgency === 'urgent' && r.json.meeting.reminderMin === 15, r.json.meeting);
  r = await owner('POST', MT, { title: 'x', date: addD(3), urgency: 'extreme' });
  check('niveau d’urgence inconnu refusé (400)', r.status === 400, r.status);
  r = await owner('GET', `${MT}?urgent=1`);
  check('filtre « urgentes » de la liste', r.json.meetings.length === 1 && r.json.meetings[0].id === urgentId, r.json.meetings.map((x) => x.title));
  r = await owner('GET', `${MT}/dashboard`);
  check('le tableau de bord existant fonctionne toujours', r.status === 200 && r.json.meetings, r.status);

  // ---------- Conflits d'agenda ----------
  const D = addD(30);
  r = await owner('POST', MT, { title: 'Réunion A', type: 'team', date: D, time: '10:00', durationMin: 60, place: 'Salle Bonanjo', participants: [{ userId: mgrId }, { userId: memId }] });
  check('convocation de base sans conflit : aucun avertissement', r.status === 201 && r.json.conflicts === null, r.json.conflicts);
  const mA = r.json.id;
  r = await owner('POST', `${MT}/conflicts`, { date: D, time: '10:30', durationMin: 60, place: 'salle  bonanjo', participants: [{ userId: memId }] });
  check('conflit détecté : participant déjà pris ET lieu déjà occupé (casse et espaces ignorés)', r.status === 200 && r.json.participants.length === 1 && r.json.participants[0].userId === memId && r.json.place.length === 1 && r.json.count === 2, r.json);
  check('créneaux alternatifs proposés (sans conflit, hors du créneau demandé)', r.json.alternatives.length >= 3 && r.json.alternatives.every((a) => !(a.date === D && a.time >= '09:30' && a.time < '11:00')), r.json.alternatives);
  r = await owner('POST', `${MT}/conflicts`, { date: D, time: '11:00', durationMin: 60, participants: [{ userId: memId }] });
  check('réunions qui se touchent (fin 11:00 / début 11:00) : pas de conflit', r.json.count === 0 && r.json.alternatives.length === 0, r.json);
  r = await mem('POST', `${MT}/conflicts`, { date: D, time: '10:00', durationMin: 60 });
  check('la vérification d’agenda est réservée à ceux qui convoquent (403)', r.status === 403, r.status);
  r = await owner('POST', MT, { title: 'Réunion B (chevauche A)', type: 'team', date: D, time: '10:30', durationMin: 30, participants: [{ userId: memId }] });
  check('à la convocation : avertissement renvoyé avec les conflits (non bloquant par défaut)', r.status === 201 && r.json.conflicts && r.json.conflicts.participants.some((p) => p.userId === memId && p.meetingId === mA) && r.json.conflicts.alternatives.length > 0, r.json);
  const mB = r.json.id;
  r = await owner('GET', `${MT}/${mB}/conflicts`);
  check('conflits d’une réunion existante : A est vue comme conflit (et pas elle-même)', r.json.participants.length >= 1 && r.json.participants.every((p) => p.meetingId === mA), r.json);
  // congés approuvés (module RH) et jour férié
  const empId = Number((await dbx.prepare("INSERT INTO employees (org_id, name, job, status, user_id, created_at) VALUES (?, 'Paul', 'Vendeur', 'active', ?, ?) RETURNING id").get(org, memId, new Date().toISOString())).id);
  const D2 = addD(40);
  await dbx.prepare("INSERT INTO leaves (org_id, employee_id, kind, start, \"end\", status, requested_by, created_at) VALUES (?, ?, 'annual', ?, ?, 'approved', ?, ?)").run(org, empId, D2, addD(42), ownerId, new Date().toISOString());
  r = await owner('POST', `${MT}/conflicts`, { date: D2, time: '09:00', durationMin: 60, participants: [{ userId: memId }] });
  check('congé approuvé (RH) : signalé avec les dates', r.json.leaves.length === 1 && r.json.leaves[0].userId === memId && r.json.leaves[0].from === D2 && r.json.count === 1, r.json);
  check('… les créneaux proposés évitent les jours de congé', r.json.alternatives.length > 0 && r.json.alternatives.every((a) => a.date > addD(42) || a.date < D2), r.json.alternatives);
  await dbx.prepare('INSERT INTO hr_holidays (org_id, date, name) VALUES (?, ?, ?)').run(org, addD(45), 'Fête test');
  r = await owner('POST', `${MT}/conflicts`, { date: addD(45), time: '09:00', durationMin: 60, participants: [] });
  check('jour férié (RH) signalé', r.json.holiday === 'Fête test' && r.json.count === 1, r.json);
  // confidentialité : on ne voit pas le titre d'une réunion confidentielle à laquelle on ne participe pas
  r = await owner('POST', MT, { title: 'Réunion secrète RH', type: 'direction', date: D2, time: '14:00', durationMin: 60, confidential: true, participants: [{ userId: memId }] });
  check('réunion confidentielle créée', r.status === 201, r.json);
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] }, types: { direction: { users: [] } } } });
  r = await mgr('POST', `${MT}/conflicts`, { date: D2, time: '14:00', durationMin: 30, participants: [{ userId: memId }] });
  check('confidentialité : le conflit est signalé « occupé » SANS le titre de la réunion confidentielle', r.status === 200 && r.json.participants.length >= 1 && r.json.participants.every((p) => p.busy === true && p.title === null && p.meetingId === null) && !/secrète/.test(r.text), r.json.participants);
  // conflits bloquants (réglage du propriétaire)
  r = await owner('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] } }, blockConflicts: true });
  check('réglage « conflits bloquants »', r.status === 200 && r.json.config.blockConflicts === true && r.json.config.quorum.team, r.json.config);
  r = await owner('POST', MT, { title: 'Réunion C', type: 'team', date: D, time: '10:15', durationMin: 30, participants: [{ userId: memId }] });
  check('conflits bloquants : 409 « conflict » avec les conflits et des créneaux', r.status === 409 && r.json.code === 'conflict' && r.json.conflicts.alternatives.length > 0, r.json);
  r = await owner('POST', MT, { title: 'Réunion C', type: 'team', date: D, time: '10:15', durationMin: 30, participants: [{ userId: memId }], force: true });
  check('… sauf confirmation explicite (force)', r.status === 201, r.json);
  r = await owner('PUT', `${MT}/${mB}`, { time: '10:00' });
  check('modification en conflit : 409 aussi (réglage bloquant)', r.status === 409 && r.json.code === 'conflict', r.json);
  r = await owner('PUT', `${MT}/${mB}`, { time: '15:00' });
  check('modification vers un créneau libre : acceptée, sans conflit', r.status === 200 && r.json.conflicts === null, r.json);
  await owner('PUT', `${MT}/settings`, { convene: { default: { users: [mgrId] } }, validate: { default: { users: [mgrId] } }, blockConflicts: false });

  // ---------- Réunion périodique avec exceptions ----------
  const S0 = addD(60);
  const second = new Date(`${S0}T00:00:00Z`); second.setUTCDate(second.getUTCDate() + 7);
  r = await owner('POST', MT, { title: 'Point hebdo', type: 'team', date: S0, time: '08:00', recurrence: { freq: 'weekly', count: 3, exceptions: [iso(second)] }, participants: [{ userId: mgrId }] });
  check('série hebdomadaire de 3 réunions avec une date d’exception : la date est sautée', r.status === 201 && r.json.ids.length === 3 && r.json.skipped[0] === iso(second), r.json);
  const sdates = (await q('SELECT date FROM mtg_meetings WHERE id IN (?, ?, ?) ORDER BY date', ...r.json.ids)).map((x) => x.date);
  check('… les 3 réunions tombent aux semaines 0, 2 et 3', sdates[0] === S0 && sdates[1] !== iso(second) && sdates.length === 3, sdates);
  r = await owner('POST', MT, { title: 'Comité trimestriel', type: 'direction', date: addD(100), time: '08:00', recurrence: { freq: 'quarterly', count: 3 }, participants: [] });
  const qd = (await q('SELECT date FROM mtg_meetings WHERE id IN (?, ?, ?) ORDER BY date', ...r.json.ids)).map((x) => x.date);
  const monthsApart = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
  check('série trimestrielle : 3 mois d’écart', monthsApart(qd[0], qd[1]) === 3 && monthsApart(qd[1], qd[2]) === 3, qd);
  await dbx.prepare('INSERT INTO hr_holidays (org_id, date, name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(org, addD(120), 'Férié série');
  r = await owner('POST', MT, { title: 'Série hors fériés', type: 'team', date: addD(120), time: '08:00', recurrence: { freq: 'weekly', count: 2, skipHolidays: true }, participants: [] });
  check('série : les jours fériés sont sautés sur demande', r.status === 201 && r.json.skipped.includes(addD(120)), r.json);
  r = await owner('POST', MT, { title: 'Tout exclu', type: 'team', date: addD(70), recurrence: { freq: 'weekly', count: 2, exceptions: [addD(70), addD(77), addD(84), addD(91), addD(98), addD(105), addD(112), addD(119), addD(126), addD(133), addD(140), addD(147), addD(154), addD(161), addD(168), addD(175), addD(182), addD(189), addD(196), addD(203), addD(210), addD(217), addD(224), addD(231), addD(238), addD(245), addD(252), addD(259), addD(266), addD(273), addD(280), addD(287), addD(294), addD(301), addD(308), addD(315), addD(322), addD(329), addD(336), addD(343), addD(350), addD(357), addD(364), addD(371), addD(378), addD(385), addD(392), addD(399), addD(406), addD(413), addD(420), addD(427)] } });
  check('série dont toutes les dates sont des exceptions : refusée (400)', r.status === 400, [r.status, r.json]);

  // ---------- Multi-sites et inter-services ----------
  const b1 = Number((await dbx.prepare("INSERT INTO branches (org_id, name, location, created_at) VALUES (?, 'Douala', 'Bonanjo', ?) RETURNING id").get(org, new Date().toISOString())).id);
  const b2 = Number((await dbx.prepare("INSERT INTO branches (org_id, name, location, created_at) VALUES (?, 'Yaoundé', 'Centre', ?) RETURNING id").get(org, new Date().toISOString())).id);
  const d1 = Number((await dbx.prepare("INSERT INTO rh_departments (org_id, name, created_at) VALUES (?, 'Commercial', ?) RETURNING id").get(org, new Date().toISOString())).id);
  const d2 = Number((await dbx.prepare("INSERT INTO rh_departments (org_id, name, created_at) VALUES (?, 'Logistique', ?) RETURNING id").get(org, new Date().toISOString())).id);
  r = await owner('POST', MT, { title: 'Revue multi-sites', type: 'team', date: addD(15), branchId: b1, sites: [b2], departmentId: d1, departments: [d2], participants: [{ userId: mgrId }] });
  check('réunion multi-sites et inter-services créée (site d’accueil, sites et services concernés)', r.status === 201, r.json);
  const multi = r.json.id;
  r = await owner('GET', `${MT}/${multi}`);
  check('détail : périmètre = 2 sites et 2 services, marqués multi-sites / inter-services', r.json.perimeter.multiSite && r.json.perimeter.interService && r.json.perimeter.sites.length === 2 && r.json.perimeter.depts.length === 2 && r.json.meeting.branchId === b1 && r.json.meeting.departmentId === d1, r.json.perimeter);
  r = await owner('GET', `${MT}?multiSite=1`);
  check('filtre multi-sites', r.json.meetings.length === 1 && r.json.meetings[0].id === multi, r.json.meetings.map((x) => x.title));
  r = await owner('GET', `${MT}?interService=1`);
  check('filtre inter-services', r.json.meetings.length === 1 && r.json.meetings[0].id === multi, r.json.meetings.length);
  r = await owner('GET', `${MT}?branchId=${b2}`);
  check('filtre par site concerné (pas seulement le site d’accueil)', r.json.meetings.length === 1, r.json.meetings.length);
  r = await owner('GET', `${MT}?departmentId=${d2}`);
  check('filtre par service concerné', r.json.meetings.length === 1, r.json.meetings.length);
  r = await owner('POST', MT, { title: 'x', date: addD(15), branchId: 99999 });
  check('site inconnu refusé (400)', r.status === 400, r.status);
  r = await owner('POST', MT, { title: 'x', date: addD(15), departmentId: 99999 });
  check('service inconnu refusé (400)', r.status === 400, r.status);
  r = await owner('POST', MT, { title: 'x', date: addD(15), sites: [b1, 77777] });
  check('liste de sites avec un site inconnu : refusée (400)', r.status === 400, r.status);
  r = await owner('PUT', `${MT}/${multi}`, { sites: [] });
  r = await owner('GET', `${MT}/${multi}`);
  check('modification du périmètre (sites retirés)', r.json.scope.sites.length === 0 && r.json.perimeter.sites.length === 1, r.json.scope);

  // ---------- Quorum en direct ----------
  r = await owner('POST', MT, { title: 'Conseil avec quorum', type: 'team', date: addD(0), time: '09:00', participants: [{ userId: mgrId }, { userId: memId }, { name: 'Invité Ext', email: 'ext@exemple.com' }] });
  const qm = r.json.id;
  r = await owner('GET', `${MT}/${qm}`);
  const pidOf = (det, userId) => det.participants.find((p) => p.userId === userId).id;
  const pOwner = pidOf(r.json, ownerId); const pMgr = pidOf(r.json, mgrId); const pMem = pidOf(r.json, memId); const pGuest = r.json.participants.find((p) => p.kind === 'guest').id;
  check('quorum : l’invité externe n’a pas voix par défaut (poids 0) ; membres : poids 1', r.json.participants.find((p) => p.id === pGuest).voteWeight === 0 && r.json.participants.find((p) => p.id === pMem).voteWeight === 1, r.json.participants.map((p) => p.voteWeight));
  check('quorum affiché dans la fiche : règle, base 3, 0 présent', r.json.quorum.required && r.json.quorum.base === 3 && r.json.quorum.present === 0 && !r.json.quorum.ok && r.json.quorum.need === 2, r.json.quorum);
  r = await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pMem, attended: 'yes' }, { id: pOwner, attended: 'yes' }] });
  check('2 présents sur 3 mais aucun « responsable » : quorum NON atteint (présence minimale par rôle)', r.status === 200 && r.json.quorum.present === 2 && !r.json.quorum.ok && r.json.quorum.roles[0].role === 'manager' && r.json.quorum.roles[0].present === 0, r.json.quorum);
  r = await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pMgr, attended: 'yes', lateMin: 12 }] });
  check('le responsable arrive (retard 12 min) : quorum atteint en direct', r.json.quorum.ok && r.json.quorum.present === 3 && r.json.quorum.status === 'ok', r.json.quorum);
  r = await mem('PUT', `${MT}/${qm}/presence`, { items: [{ id: pMem, attended: 'no' }] });
  check('présences : réservées à l’équipe qui tient la réunion (403 pour un simple participant)', r.status === 403, r.status);
  r = await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: 99999, attended: 'yes' }] });
  check('présence d’un participant inconnu : 404', r.status === 404, r.status);
  r = await owner('PUT', `${MT}/${qm}/presence`, { items: [{ id: pMem, attended: 'yes', lateMin: 9999 }] });
  check('retard hors limites refusé (400)', r.status === 400, r.status);
  r = await mem('GET', `${MT}/${qm}/quorum`);
  check('un participant lit le quorum en direct', r.status === 200 && r.json.quorum.ok, r.json);
  r = await other('GET', `${MT2}/${qm}/quorum`);
  check('isolation : le quorum d’une autre organisation est invisible (404)', r.status === 404, r.status);

  // ---------- Propositions de points ----------
  r = await mem('POST', `${MT}/${qm}/agenda/propose`, { title: 'Point proposé par Paul', kind: 'decide' });
  check('un participant propose un point (en attente d’acceptation)', r.status === 201 && r.json.accepted === false, r.json);
  const prop = r.json.id;
  r = await owner('GET', `${MT}/${qm}`);
  check('l’organisateur voit la proposition en attente', r.json.proposals.length === 1 && r.json.proposals[0].title === 'Point proposé par Paul', r.json.proposals);
  r = await mem('POST', `${MT}/${qm}/agenda/${prop}/decide`, { accept: true });
  check('accepter une proposition : réservé à l’organisation de la réunion (403)', r.status === 403, r.status);
  r = await owner('POST', `${MT}/${qm}/agenda/${prop}/decide`, { accept: true });
  check('proposition acceptée', r.status === 200, r.status);
  r = await owner('PUT', `${MT}/${qm}/agenda/${prop}`, { kind: 'info', spentMin: 7 });
  check('nature du point et durée réelle modifiables', r.status === 200, r.status);
  r = await owner('PUT', `${MT}/${qm}/agenda/${prop}`, { kind: 'bidon' });
  check('nature de point inconnue refusée', r.status === 400, r.status);

  await require('./lib/meetings-avance-part2')({ ...ctx, MT, MT2, ownerId, mgrId, memId, q, addD, iso, qm, pOwner, pMgr, pMem, pGuest, ai, pidOf, b1, d1, QUORUM, typeId });
}, {
  async setup() {
    const a = await fakeAiServer();
    return { a, env: { ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, WS_AI_FREE: '500', AI_PER_MINUTE: '500' } };
  },
  async teardown(x) { x.a.srv.close(); },
});
