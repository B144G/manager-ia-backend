'use strict';
// Jeu de données de DÉMONSTRATION des réunions avancées (exemples fictifs), à lancer APRÈS scripts/demo/seed.js :
// quorum, types, réunion urgente, conflits d'agenda, multi-sites, inter-services, séries, résolutions (nominatif, secret, main levée), sans quorum,
// procès-verbal signé, archives, engagements en retard. Usage : node scripts/demo/reunions-avance.js [http://127.0.0.1:3200]
const fs = require('fs');
const path = require('path');
const BASE = (process.argv[2] || process.env.DEMO_API || 'http://127.0.0.1:3200').replace(/\/$/, '');
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo-reunions';
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (n) => iso(new Date(Date.now() + n * 86400000));
function client() {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* */ }
    return { status: res.status, json, text: t };
  };
}
(async () => {
  const awa = client(); const brice = client(); const fatou = client();
  for (const [c, contact] of [[awa, 'demo@exemple.com'], [brice, 'brice.nkomo@exemple.com'], [fatou, 'fatou.diallo@exemple.com']]) { const r = await c('POST', '/api/login', { contact, pass: 'secret123' }); if (r.status !== 200) throw new Error('connexion ' + contact + ' ' + r.status); }
  const orgId = (await awa('GET', '/api/ws/orgs')).json.orgs[0].id;
  const W = `/api/ws/orgs/${orgId}`; const MT = `${W}/meetings`;
  const ok = (r, what) => { if (r.status >= 400) throw new Error(what + ' : ' + r.status + ' ' + r.text.slice(0, 200)); return r.json; };
  const mem = (await awa('GET', `${W}/members`)).json.members;
  const id = (n) => mem.find((m) => m.name === n).userId;
  const AWA = id('Awa Kamga'); const BRICE = id('Brice Nkomo'); const FATOU = id('Fatou Diallo');
  // sites et services
  let pg; try { pg = new (require('pg').Client)({ connectionString: fs.readFileSync(path.join(DEMO_DIR, 'pgurl.txt'), 'utf8').trim() }); await pg.connect(); } catch (e) { console.log('SQL indisponible :', e.message); }
  let b1; let b2; let d1; let d2;
  if (pg) {
    const now = new Date().toISOString();
    b1 = (await pg.query("INSERT INTO branches (org_id, name, location, created_at) VALUES ($1, 'Douala — Akwa', 'Boutique principale', $2) RETURNING id", [orgId, now])).rows[0].id;
    b2 = (await pg.query("INSERT INTO branches (org_id, name, location, created_at) VALUES ($1, 'Yaoundé — Bastos', 'Antenne', $2) RETURNING id", [orgId, now])).rows[0].id;
    d1 = (await pg.query("INSERT INTO rh_departments (org_id, name, created_at) VALUES ($1, 'Ventes', $2) RETURNING id", [orgId, now])).rows[0].id;
    d2 = (await pg.query("INSERT INTO rh_departments (org_id, name, created_at) VALUES ($1, 'Atelier de couture', $2) RETURNING id", [orgId, now])).rows[0].id;
  }
  // réglages
  ok(await awa('PUT', `${MT}/settings`, { convene: { default: { users: [BRICE] } }, validate: { default: { users: [BRICE] } }, noticeH: { normal: 24, urgent: 2, critical: 0 },
    quorum: { team: { minCount: 2, minPercent: 50, roles: { manager: 1 }, reduced: { allowed: true, minCount: 1, minPercent: 0, delayDays: 3 } }, committee: { minPercent: 60 } } }), 'réglages');
  const typeId = ok(await awa('POST', `${MT}/types`, { name: 'Revue des ventes', base: 'team', color: '#1f9d6b', durationMin: 45, reminderMin: 60 }), 'type').id;
  ok(await awa('POST', `${MT}/types`, { name: 'Comité de pilotage', base: 'committee', color: '#6f42c1', durationMin: 90, confidential: false }), 'type');
  const P = (...u) => u.map((userId) => ({ userId }));
  const past = async (n, over) => { const r = ok(await awa('POST', MT, { type: 'team', time: '09:00', durationMin: 60, place: 'Boutique Akwa', send: false, participants: P(BRICE, FATOU), ...over, date: plus(n) }), 'réunion'); return r.id; };

  // 1. Conseil tenu il y a 6 jours : votes, PV signé, archivé
  const m1 = await past(-6, { title: 'Conseil de gestion de novembre', typeId, branchId: b1, departmentId: d1, objective: 'Budget, horaires et nouvel atelier.', agenda: [{ title: 'Budget 2027', durationMin: 20, kind: 'decide' }, { title: 'Horaires de la boutique', durationMin: 15, kind: 'decide' }, { title: 'Questions diverses', durationMin: 10, kind: 'info' }] });
  let d = ok(await awa('GET', `${MT}/${m1}`), 'détail');
  const pid = (u) => d.participants.find((p) => p.userId === u).id;
  ok(await awa('POST', `${MT}/${m1}/start`, {}), 'start');
  ok(await awa('PUT', `${MT}/${m1}/presence`, { items: [{ id: pid(AWA), attended: 'yes' }, { id: pid(BRICE), attended: 'yes', lateMin: 10 }, { id: pid(FATOU), attended: 'yes' }] }), 'présences');
  const rs = ok(await awa('POST', `${MT}/${m1}/resolutions`, { items: [
    { title: 'Budget 2027', text: 'Il est décidé d’adopter le budget 2027 présenté par le gérant.', carrierId: BRICE, due: plus(20), voteMode: 'named', majority: 'simple', agendaId: d.agenda[0].id },
    { title: 'Horaires', text: 'Il est décidé d’ouvrir la boutique le dimanche matin.', voteMode: 'secret', majority: 'qualified', threshold: 67, agendaId: d.agenda[1].id },
    { title: 'Atelier', text: 'Il est décidé de recruter une couturière.', carrierId: FATOU, due: plus(-1), voteMode: 'hand', majority: 'unanimity' },
  ] }), 'résolutions').ids;
  const vote = async (rid, votes) => { ok(await awa('POST', `${MT}/${m1}/resolutions/${rid}/open-vote`), 'open'); for (const [c, ch] of votes) ok(await c('POST', `${MT}/${m1}/resolutions/${rid}/vote`, { choice: ch }), 'vote'); ok(await awa('POST', `${MT}/${m1}/resolutions/${rid}/close-vote`), 'close'); };
  await vote(rs[0], [[awa, 'for'], [brice, 'for'], [fatou, 'against']]);
  await vote(rs[1], [[awa, 'for'], [brice, 'for'], [fatou, 'against']]);
  ok(await awa('POST', `${MT}/${m1}/resolutions/${rs[2]}/open-vote`), 'open');
  ok(await awa('POST', `${MT}/${m1}/resolutions/${rs[2]}/vote`, { items: [{ participantId: pid(AWA), choice: 'for' }, { participantId: pid(BRICE), choice: 'for' }, { participantId: pid(FATOU), choice: 'for' }] }), 'main levée');
  ok(await awa('POST', `${MT}/${m1}/resolutions/${rs[2]}/close-vote`), 'close');
  ok(await awa('PUT', `${MT}/${m1}/notes`, { summary: 'Budget 2027 adopté. L’ouverture du dimanche n’a pas atteint la majorité des deux tiers. Recrutement d’une couturière approuvé à l’unanimité.' }), 'notes');
  ok(await awa('POST', `${MT}/${m1}/end`, {}), 'end');
  ok(await awa('POST', `${MT}/${m1}/pv`, { narrative: 'La séance est ouverte à 9 h 10, le quorum étant atteint. Trois résolutions sont soumises au vote.' }), 'pv');
  ok(await awa('POST', `${MT}/${m1}/pv/request-signatures`, { signers: [{ userId: AWA, role: 'Présidente' }, { userId: BRICE, role: 'Secrétaire' }], ordered: true }), 'signatures');
  ok(await awa('POST', `${MT}/${m1}/pv/sign`, {}), 'signe 1'); ok(await brice('POST', `${MT}/${m1}/pv/sign`, {}), 'signe 2');
  ok(await awa('POST', `${MT}/${m1}/minutes/submit`), 'submit'); ok(await brice('POST', `${MT}/${m1}/minutes/validate`, { notify: false }), 'validate');
  ok(await awa('POST', `${MT}/${m1}/archive`, {}), 'archive');
  if (pg) await pg.query('UPDATE mtg_actions SET due = $1 WHERE meeting_id = $2 AND due IS NOT NULL', [plus(-9), m1]);

  // 2. Réunion sans quorum + 2ᵉ convocation
  const m2 = await past(-2, { title: 'Assemblée des vendeurs', participants: P(BRICE, FATOU) });
  d = ok(await awa('GET', `${MT}/${m2}`), 'détail');
  ok(await awa('PUT', `${MT}/${m2}/presence`, { items: [{ id: d.participants.find((p) => p.userId === FATOU).id, attended: 'yes' }] }), 'présences');
  ok(await awa('POST', `${MT}/${m2}/resolutions`, { text: 'Il est décidé de changer le règlement intérieur.' }), 'résolution');
  ok(await awa('POST', `${MT}/${m2}/no-quorum`, { reason: 'Un seul présent sur trois : quorum non atteint.' }), 'sans quorum');

  // 3. Réunion en cours aujourd'hui avec vote ouvert
  const m3 = await past(0, { title: 'Point hebdomadaire d’équipe', time: '08:30', typeId });
  d = ok(await awa('GET', `${MT}/${m3}`), 'détail');
  ok(await awa('POST', `${MT}/${m3}/start`, {}), 'start');
  ok(await awa('PUT', `${MT}/${m3}/presence`, { items: d.participants.map((p) => ({ id: p.id, attended: 'yes' })) }), 'présences');
  const r3 = ok(await awa('POST', `${MT}/${m3}/resolutions`, { items: [{ title: 'Promotion de fin d’année', text: 'Il est décidé de lancer une promotion de 10 % du 10 au 24 décembre.', carrierId: FATOU, due: plus(15), voteMode: 'named' }] }), 'résolution').ids[0];
  ok(await awa('POST', `${MT}/${m3}/resolutions/${r3}/open-vote`), 'open'); ok(await brice('POST', `${MT}/${m3}/resolutions/${r3}/vote`, { choice: 'for' }), 'vote');

  // 4. Urgente, multi-sites / inter-services, série trimestrielle, confidentielle
  const soon = new Date(Date.now() + 4 * 3600000);
  ok(await awa('POST', MT, { title: 'Rupture de stock wax : décision urgente', type: 'team', urgency: 'urgent', date: iso(soon), time: `${String(soon.getUTCHours()).padStart(2, '0')}:00`, durationMin: 30, link: 'https://meet.google.com/abc-defg-hij', participants: P(BRICE, FATOU), send: true }), 'urgente');
  ok(await awa('POST', MT, { title: 'Revue commerciale des deux sites', type: 'team', date: plus(5), time: '10:00', branchId: b1, sites: [b2], departmentId: d1, departments: [d2], participants: P(BRICE, FATOU), place: 'Visioconférence' }), 'multi-sites');
  ok(await awa('POST', MT, { title: 'Chevauchement : inventaire', type: 'team', date: plus(5), time: '10:30', durationMin: 60, place: 'Visioconférence', participants: P(FATOU) }), 'conflit');
  ok(await awa('POST', MT, { title: 'Comité de pilotage trimestriel', type: 'committee', date: plus(30), time: '09:00', recurrence: { freq: 'quarterly', count: 3 }, participants: P(BRICE) }), 'série');
  ok(await awa('POST', MT, { title: 'Entretien confidentiel de la direction', type: 'direction', date: plus(3), time: '14:00', confidential: true, participants: P(BRICE) }), 'confidentielle');
  ok(await awa('POST', `${MT}/reminders/run`, {}), 'rappels');
  if (pg) await pg.end();
  console.log('Réunions avancées de démonstration créées (organisation', orgId + ').');
})().catch((e) => { console.error(e); process.exit(1); });
