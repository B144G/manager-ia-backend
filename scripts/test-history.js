'use strict';
// Histoire de l'entreprise : organigramme dans le temps, frise (moments forts / durs), rencontres, médias (vie privée, consentement), droits de saisie,
// journal de traçabilité, statistiques, exports CSV / PDF. Aucun appel externe.
// Lancez-le avec : node scripts/test-history.js
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

function client(base) {
  const jar = {};
  return async (method, url, body, opts = {}) => {
    const headers = {};
    if (body !== undefined && !Buffer.isBuffer(body)) headers['content-type'] = 'application/json';
    if (Buffer.isBuffer(body)) headers['content-type'] = 'application/octet-stream';
    if (opts.range) headers.range = opts.range;
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binaire */ }
    return { status: res.status, json, buf, headers: res.headers, text: buf.toString('utf8') };
  };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(300, 9)]);

async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', WS_AI_FREE: '500', AI_PER_MINUTE: '500' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    const owner = client(base); const admin = client(base); const manager = client(base); const member = client(base); const other = client(base);
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'secret123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const ownerId = await reg(owner, 'Nkoulou', 'nk'); await reg(admin, 'Adèle', 'ad'); await reg(manager, 'Marc', 'mg'); const memberId = await reg(member, 'Mireille', 'mb'); await reg(other, 'Autre', 'ot');
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`; const H = `${O}/history`;
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 86400000 * 30).toISOString(), ownerId);
    for (const [c, role] of [[admin, 'admin'], [manager, 'manager'], [member, 'member']]) { r = await owner('POST', `${O}/invites`, { role }); await c('POST', '/api/ws/orgs/join', { code: r.json.code }); }
    r = await other('POST', '/api/ws/orgs', { name: 'Autre société', currency: 'FCFA' }); const org2 = r.json.id;

    console.log('Registre et droits');
    r = await owner('GET', `${O}`);
    check('le module « history » est dans le registre de l’organisation', (r.json.modules || []).some((m) => m.id === 'history'), r.status);
    r = await member('GET', `${O}`);
    check('et visible d’un simple membre (lecture ouverte)', (r.json.modules || []).some((m) => m.id === 'history'));
    r = await member('GET', `${H}/settings`);
    check('un membre voit qu’il ne peut pas saisir par défaut', r.status === 200 && r.json.canEdit === false && r.json.editMinRole === undefined, r.json);
    r = await manager('GET', `${H}/settings`);
    check('un responsable peut saisir par défaut', r.json.canEdit === true);
    r = await member('POST', `${H}/people`, { name: 'Interdit' });
    check('un membre ne peut pas ajouter une personne (403)', r.status === 403);
    r = await manager('PUT', `${H}/settings`, { editMinRole: 'member' });
    check('un responsable ne règle pas les droits (403)', r.status === 403);
    r = await owner('GET', `${H}/settings`);
    check('le propriétaire voit le réglage et la liste des membres', r.json.editMinRole === 'manager' && r.json.members.length === 4, r.json);

    console.log('Personnes et organigramme');
    const mk = async (c, body) => { const x = await c('POST', `${H}/people`, body); return x.json && x.json.id; };
    const fond = await mk(owner, { name: 'Jean Nkoulou', title: 'Fondateur', level: 0, startDate: '2008-03-01' });
    const dg = await mk(owner, { name: 'Sylvie Mbarga', title: 'Directrice générale', level: 1, parentId: fond, startDate: '2010-01-15' });
    const dir = await mk(manager, { name: 'Paul Etoga', title: 'Directeur technique', level: 2, parentId: dg, startDate: '2012-06-01', endDate: '2018-12-31', departureReason: 'Retraite' });
    const resp = await mk(manager, { name: 'Awa Bello', title: 'Responsable atelier', level: 3, parentId: dir, startDate: '2014-02-01' });
    const emp = await mk(manager, { name: 'Éric Fouda', title: 'Menuisier', level: 5, parentId: resp, startDate: '2020-09-01' });
    check('cinq personnes créées', [fond, dg, dir, resp, emp].every(Boolean));
    r = await owner('PUT', `${H}/people/${fond}`, { parentId: emp });
    check('une boucle hiérarchique est refusée', r.status === 400, r.json);
    r = await owner('POST', `${H}/people`, { name: 'X', startDate: '2020-05-01', endDate: '2019-01-01' });
    check('un départ avant l’arrivée est refusé', r.status === 400);
    r = await owner('POST', `${H}/people`, { name: 'Y', parentId: 999999 });
    check('un supérieur inconnu est refusé', r.status === 400);
    r = await other('GET', `${H}/people`);
    check('une personne d’une autre organisation n’a aucun accès (404)', r.status === 404);
    r = await member('GET', `${H}/tree?year=2011`);
    check('2011 : fondateur et DG seulement', r.status === 200 && r.json.people.map((p) => p.name).join('|') === 'Jean Nkoulou|Sylvie Mbarga', r.json.people.map((p) => p.name));
    r = await member('GET', `${H}/tree?year=2016`);
    check('2016 : Paul Etoga en poste, Éric pas encore arrivé', r.json.people.some((p) => p.name === 'Paul Etoga' && p.state === 'active') && !r.json.people.some((p) => p.name === 'Éric Fouda'));
    r = await member('GET', `${H}/tree?year=2018`);
    check('2018 : Paul Etoga part cette année-là', r.json.people.find((p) => p.name === 'Paul Etoga').state === 'leaving');
    r = await member('GET', `${H}/tree?year=2022`);
    check('2022 : Paul Etoga est un ancien (grisé)', r.json.people.find((p) => p.name === 'Paul Etoga').state === 'former');
    r = await member('GET', `${H}/tree?year=2022&former=0`);
    check('sans les anciens, Paul Etoga disparaît', !r.json.people.some((p) => p.name === 'Paul Etoga'));
    // Lien avec les employés RH
    r = await owner('POST', `${O}/hr/employees`, { name: 'Rose Tchoua', job: 'Comptable', hiredAt: '2019-04-01' });
    r = await manager('GET', `${H}/employees`);
    check('les employés RH non reliés sont proposés', r.status === 200 && r.json.employees.some((e) => e.name === 'Rose Tchoua'), r.json);
    r = await manager('POST', `${H}/people/import-employees`, {});
    check('import des employés RH', r.status === 201 && r.json.imported >= 1, r.json);
    r = await manager('POST', `${H}/people/import-employees`, {});
    check('un second import n’ajoute rien (pas de doublon)', r.json.imported === 0, r.json);
    r = await member('GET', `${H}/people`);
    const rose = r.json.people.find((p) => p.name === 'Rose Tchoua');
    check('Rose est reliée à sa fiche RH, avec poste et date d’arrivée', rose && rose.employeeId && rose.title === 'Comptable' && rose.startDate === '2019-04-01', rose);
    r = await owner('DELETE', `${H}/people/${dir}`);
    r = await member('GET', `${H}/people`);
    check('supprimer une personne fait remonter ses subordonnés', r.json.people.find((p) => p.id === resp).parentId === dg);
    // On rétablit Paul pour la suite
    const dir2 = await mk(manager, { name: 'Paul Etoga', title: 'Directeur technique', level: 2, parentId: dg, startDate: '2012-06-01', endDate: '2018-12-31' });

    console.log('Événements : moments forts et durs');
    const ev = async (c, body) => c('POST', `${H}/events`, body);
    r = await ev(manager, { title: 'Création de l’atelier', date: '2008-03-01', category: 'creation', nature: 'good', place: 'Douala', peopleIds: [fond], successFactors: 'Une clientèle fidèle dès le début.' });
    const e1 = r.json.id; check('événement créé', r.status === 201 && e1, r.json);
    r = await ev(manager, { title: 'Incendie du dépôt', date: '2015-11-20', category: 'incident', nature: 'bad', lesson: 'Assurer les stocks et former au risque incendie.', peopleIds: [dg, resp] });
    const e2 = r.json.id; check('moment dur avec leçon', r.status === 201);
    r = await ev(manager, { title: 'Grand contrat avec la mairie', date: '2016-05-10', category: 'contract', nature: 'good', successFactors: 'Devis très précis.' });
    const e3 = r.json.id;
    r = await ev(manager, { title: 'Rencontre avec le fournisseur de bois', date: '2016-09-02', category: 'meeting', nature: 'good', place: 'Yaoundé', minutes: 'Accord sur un tarif annuel.', guests: [{ name: 'M. Ondoa', org: 'Scierie du Centre', role: 'Directeur' }], peopleIds: [dg] });
    const e4 = r.json.id; check('rencontre avec invités externes et compte rendu', r.status === 201);
    r = await ev(manager, { title: 'Crise de trésorerie', date: '2019-03-15', category: 'financial', nature: 'bad', lesson: 'Garder trois mois de réserve.' });
    const e5 = r.json.id;
    r = await ev(manager, { title: 'Litige avec un client', date: '2019-08-01', category: 'dispute', nature: 'bad', visibility: 'direction', lesson: 'Toujours un contrat écrit.' });
    const e6 = r.json.id; check('événement réservé à la direction', r.status === 201);
    r = await ev(manager, { title: 'Sans nature', date: '2020-01-01' });
    check('la nature est obligatoire', r.status === 400, r.json);
    r = await ev(manager, { title: 'Mauvaise nature', date: '2020-01-01', nature: 'neutre' });
    check('une nature inconnue est refusée', r.status === 400);
    r = await ev(manager, { title: 'Date absente', nature: 'good' });
    check('la date est obligatoire', r.status === 400);
    r = await ev(manager, { title: 'Date fausse', date: '2020-13-45', nature: 'good' });
    check('une date impossible est refusée', r.status === 400);
    r = await ev(manager, { title: 'Catégorie fausse', date: '2020-01-01', nature: 'good', category: 'xyz' });
    check('une catégorie inconnue est refusée', r.status === 400);
    r = await ev(manager, { title: 'Personne étrangère', date: '2020-01-01', nature: 'good', peopleIds: [999999] });
    check('une personne inconnue est refusée', r.status === 400);
    r = await ev(member, { title: 'Pirate', date: '2020-01-01', nature: 'good' });
    check('un membre ne peut pas créer d’événement (403)', r.status === 403);

    r = await member('GET', `${H}/events`);
    check('le membre voit 5 événements (pas celui de la direction), triés par date', r.json.events.length === 5 && !r.json.events.some((e) => e.id === e6) && r.json.events[0].id === e1, r.json.events.map((e) => e.title));
    r = await owner('GET', `${H}/events`);
    check('le propriétaire voit les 6', r.json.events.length === 6);
    r = await admin('GET', `${H}/events/${e6}`);
    check('l’administrateur lit l’événement direction', r.status === 200);
    r = await member('GET', `${H}/events/${e6}`);
    check('le membre reçoit 404 sur l’événement direction', r.status === 404);
    r = await member('GET', `${H}/events?nature=bad`);
    check('vue « moments durs » : 2 événements pour un membre', r.json.events.length === 2 && r.json.events.every((e) => e.nature === 'bad' && e.lesson), r.json.events.length);
    r = await member('GET', `${H}/events?nature=good`);
    check('vue « moments forts » : 3 événements', r.json.events.length === 3 && r.json.events.every((e) => e.nature === 'good'));
    r = await member('GET', `${H}/events?year=2016`);
    check('filtre par année', r.json.events.length === 2);
    r = await member('GET', `${H}/events?q=bois`);
    check('recherche par mot', r.json.events.length === 1 && r.json.events[0].id === e4);
    r = await member('GET', `${H}/events?q=${encodeURIComponent('100%')}`);
    check('un « % » dans la recherche n’est pas un joker', r.status === 200 && r.json.events.length === 0);
    r = await member('GET', `${H}/events?category=meeting`);
    check('rencontre : invités et compte rendu', r.json.events[0].guests[0].name === 'M. Ondoa' && r.json.events[0].minutes.includes('tarif') && r.json.events[0].people[0].name === 'Sylvie Mbarga', r.json.events[0]);
    r = await manager('PUT', `${H}/events/${e6}`, { title: 'Hack' });
    check('l’auteur peut encore modifier son événement direction', r.status === 200);
    r = await admin('PUT', `${H}/events/${e5}`, { lesson: 'Garder quatre mois de réserve.', peopleIds: [fond] });
    check('un administrateur modifie la leçon et les personnes', r.status === 200);
    r = await member('GET', `${H}/events/${e5}`);
    check('modification visible', r.json.event.lesson.includes('quatre') && r.json.event.people[0].name === 'Jean Nkoulou');
    r = await owner('PUT', `${H}/events/${e5}`, { date: '2019-03-15', endDate: '2019-01-01' });
    check('fin avant début refusée', r.status === 400);

    console.log('Droits de saisie désignés');
    r = await owner('PUT', `${H}/settings`, { editMinRole: 'admin', editorIds: [memberId] });
    check('le propriétaire désigne le rôle minimum et une personne', r.status === 200);
    r = await manager('POST', `${H}/people`, { name: 'Refusé' });
    check('le responsable n’a plus le droit de saisir', r.status === 403);
    r = await member('POST', `${H}/events`, { title: 'Prix régional', date: '2021-10-10', category: 'award', nature: 'good', successFactors: 'Qualité.' });
    check('la personne désignée peut saisir', r.status === 201, r.json);
    const e7 = r.json.id;
    r = await owner('PUT', `${H}/settings`, { editorIds: [999999] });
    check('une personne désignée hors organisation est refusée', r.status === 400);
    await owner('PUT', `${H}/settings`, { editMinRole: 'manager', editorIds: [] });
    r = await member('POST', `${H}/events`, { title: 'Encore', date: '2021-10-10', nature: 'good' });
    check('retrait de la désignation : plus de saisie', r.status === 403);

    console.log('Médias');
    r = await manager('POST', `${H}/media?name=chantier.png&eventId=${e3}&caption=Chantier`, PNG);
    const m1 = r.json && r.json.id; check('image envoyée', r.status === 201 && m1, r.json);
    r = await manager('POST', `${H}/media?name=equipe.png&eventId=${e3}&hasPeople=1`, PNG);
    const m2 = r.json.id; check('photo avec personnes, sans consentement', r.status === 201);
    r = await manager('POST', `${H}/media?name=equipe2.png&eventId=${e3}&hasPeople=1&consent=1`, PNG);
    const m3 = r.json.id;
    r = await manager('POST', `${H}/media?name=secret.png&eventId=${e3}&visibility=direction`, PNG);
    const m4 = r.json.id;
    r = await manager('POST', `${H}/media?name=visite.mp4&eventId=${e3}`, MP4);
    const m5 = r.json && r.json.id; check('vidéo envoyée', r.status === 201 && r.json.kind === 'video', r.json);
    r = await manager('POST', `${H}/media?name=virus.exe&eventId=${e3}`, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]));
    check('un programme est refusé', r.status === 400);
    r = await manager('POST', `${H}/media?name=faux.png`, Buffer.from('ceci est du texte et non une image, assez long'));
    check('un faux fichier est refusé (contenu contrôlé)', r.status === 400);
    r = await manager('POST', `${H}/media?name=doc.pdf`, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100)]));
    check('un PDF n’est pas un média accepté ici', r.status === 400);
    r = await manager('POST', `${H}/media?name=gros.png`, Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]));
    check('une image de plus de 8 Mo est refusée', r.status === 413, r.status);
    r = await member('POST', `${H}/media?name=x.png`, PNG);
    check('un membre non autorisé ne peut pas envoyer (403)', r.status === 403);
    r = await member('GET', `${H}/media?eventId=${e3}`);
    const ids = r.json.media.map((m) => m.id);
    check('le membre voit l’image libre, la photo avec consentement et la vidéo — pas les autres', ids.includes(m1) && ids.includes(m3) && ids.includes(m5) && !ids.includes(m2) && !ids.includes(m4), ids);
    r = await admin('GET', `${H}/media?eventId=${e3}`);
    check('la direction voit les 5', r.json.media.length === 5);
    r = await member('GET', `${H}/media/${m2}/file`);
    check('sans consentement : fichier introuvable pour le membre (404)', r.status === 404);
    r = await member('GET', `${H}/media/${m4}/file`);
    check('média direction : 404 pour le membre', r.status === 404);
    r = await member('GET', `${H}/media/${m1}/file`);
    check('le membre télécharge l’image libre, octets identiques', r.status === 200 && r.buf.equals(PNG) && r.headers.get('content-type') === 'image/png' && r.headers.get('cache-control').includes('no-store'));
    r = await member('GET', `${H}/media/${m5}/file`, undefined, { range: 'bytes=0-9' });
    check('lecture vidéo par morceaux (Range 206)', r.status === 206 && r.buf.length === 10 && /bytes 0-9\//.test(r.headers.get('content-range')), r.status);
    r = await other('GET', `${O.replace(String(org), String(org2))}/history/media/${m1}/file`);
    check('une autre organisation ne voit pas ce média', r.status === 404);
    r = await other('GET', `${H}/media/${m1}/file`);
    check('et ne peut pas atteindre notre organisation', r.status === 404);
    const raw = await db.prepare('SELECT data FROM history_media WHERE id = ?').get(m1);
    check('le fichier est chiffré en base', !Buffer.from(raw.data).includes(PNG.subarray(0, 8)));
    r = await manager('PUT', `${H}/media/${m2}`, { consent: true });
    r = await member('GET', `${H}/media/${m2}/file`);
    check('le consentement recueilli rend la photo visible', r.status === 200);
    r = await member('GET', `${H}/events/${e3}`);
    check('l’événement ne liste que les médias visibles', r.json.event.media.length === 4 && !r.json.event.media.some((m) => m.id === m4), r.json.event.media.length);
    // Photo de profil
    r = await manager('POST', `${H}/media?name=awa.png&personId=${resp}&avatar=1`, PNG);
    const av = r.json.id;
    r = await member('GET', `${H}/people`);
    check('la photo de profil sans consentement n’est pas montrée au membre', r.json.people.find((p) => p.id === resp).photoId === null);
    r = await admin('GET', `${H}/people`);
    check('mais la direction la voit', r.json.people.find((p) => p.id === resp).photoId === av);
    await manager('PUT', `${H}/media/${av}`, { consent: true });
    r = await member('GET', `${H}/people`);
    check('avec consentement, la photo de profil est visible', r.json.people.find((p) => p.id === resp).photoId === av);
    r = await member('GET', `${H}/media?year=2016`);
    check('galerie par année', r.json.media.length >= 3 && r.json.media.every((m) => m.year === 2016));
    r = await manager('DELETE', `${H}/media/${av}`);
    r = await member('GET', `${H}/people`);
    check('supprimer la photo retire la photo de profil', r.json.people.find((p) => p.id === resp).photoId === null);
    r = await manager('DELETE', `${H}/events/${e3}`);
    r = await admin('GET', `${H}/media`);
    check('supprimer l’événement supprime ses médias', !r.json.media.some((m) => m.eventId === e3));

    console.log('Statistiques');
    r = await member('GET', `${H}/stats`);
    const s = r.json;
    check('totaux (événement direction exclu pour un membre)', s.total === 5 && s.good === 3 && s.bad === 2 && s.firstYear === 2008, s);
    const y2015 = s.series.find((x) => x.year === 2015);
    check('série par année avec trajectoire cumulée', y2015 && y2015.bad === 1 && y2015.trajectory === 0 && s.series[0].year === 2008 && s.series[s.series.length - 1].year >= 2021, s.series);
    check('répartition par catégorie', s.byCategory.some((c) => c.category === 'incident' && c.bad === 1));
    r = await owner('GET', `${H}/stats`);
    check('la direction compte 6 événements', r.json.total === 6, r.json.total);

    console.log('Traçabilité');
    r = await member('GET', `${H}/journal`);
    check('le journal est réservé à la direction (403)', r.status === 403);
    r = await owner('GET', `${H}/journal`);
    const j = r.json.entries;
    check('le journal contient créations, modifications, suppressions et droits', ['create', 'update', 'delete'].every((a) => j.some((x) => x.action === a)) && j.some((x) => x.entity === 'history_settings') && j.every((x) => x.by !== undefined), j.length);
    check('chaque entrée dit qui, quand, quoi', j.every((x) => x.at && x.entityLabel && x.by));
    check('le journal garde l’avant / après d’une modification', j.some((x) => x.entity === 'history_event' && x.action === 'update' && x.before && x.after));
    check('aucune donnée binaire dans le journal', !JSON.stringify(j).includes('PNG'));

    console.log('Exports');
    r = await member('GET', `${H}/export.csv`);
    check('CSV des événements (en-têtes français, BOM, pas l’événement direction)', r.status === 200 && r.text.startsWith('﻿Date;') && r.text.includes('Incendie') && !r.text.includes('Litige'), r.text.slice(0, 80));
    r = await owner('GET', `${H}/export.csv`);
    check('la direction exporte aussi l’événement réservé', r.text.includes('Litige'));
    r = await member('GET', `${H}/export.csv?what=people`);
    check('CSV des personnes', r.text.includes('Awa Bello') && r.text.includes('Supérieur'));
    await owner('POST', `${H}/events`, { title: '=cmd|calc', date: '2022-02-02', nature: 'good' });
    r = await owner('GET', `${H}/export.csv`);
    check('une cellule commençant par = est neutralisée', r.text.includes("'=cmd"));
    r = await member('GET', `${H}/export.pdf`);
    check('PDF valide', r.status === 200 && r.buf.toString('latin1', 0, 5) === '%PDF-' && r.headers.get('content-type') === 'application/pdf', r.status);
    r = await owner('GET', `${H}/journal`);
    check('les exports sont tracés', r.json.entries.some((x) => x.entity === 'history_export'));
    void e7; void e2; void e4; void dir2;
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close();
  process.exit(failed ? 1 : 0);
}
main();
