'use strict';
// Module Commercial (étape 1) : rôles commerciaux, CRM 360°, prospection (scores, attribution, cadences, BANT), pipeline, segmentation (RFM / ABC).
// Les contrôles chiffrés sont calculés à la main (voir les commentaires). Lancez-le avec : node scripts/test-commercial.js
const { run, client } = require('./lib/wave1');
const L = require('../src/workspace/commercial/lib');

const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

run('Commercial : rôles, CRM, prospection, pipeline, segmentation', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx, base }) => {
  const C = `${O}/commercial`;
  const C2 = `${ws(org2)}/commercial`;
  let r;

  // ---------- Calculs purs (valeurs vérifiées à la main) ----------
  check('BANT : 4-4-2-2 validés = 75', L.bantScore({ budget: { rating: 4, validated: true }, authority: { rating: 4, validated: true }, need: { rating: 2, validated: true }, timing: { rating: 2, validated: true } }) === 75);
  check('BANT : un critère non validé (suggestion IA) vaut 0 → 63', L.bantScore({ budget: { rating: 4, validated: true }, authority: { rating: 4, validated: true }, need: { rating: 2, validated: true }, timing: { rating: 4, validated: false } }) === 63);
  let s = L.scoreLead({ phone: '1', email: 'a', company: 'b', city: 'c', product: 'd', source: 'referral', temperature: 'chaud', budget_est: 100, bant_score: 80 }, { messages: 6, lastContactDays: 2 });
  check('score prospect complet = 27+18+20+5+6+10+12 = 98 (A)', s.score === 98 && s.grade === 'A', s);
  s = L.scoreLead({ source: 'ad', temperature: 'froid' }, { messages: 0, lastContactDays: null });
  check('score prospect minimal = 7+2 = 9 (D)', s.score === 9 && s.grade === 'D', s);
  check('attribution : le moins chargé', L.pickAssignee([{ userId: 1, load: 2 }, { userId: 2, load: 0 }, { userId: 3, load: 1 }]) === 2);
  check('attribution : égalité → plus petit identifiant', L.pickAssignee([{ userId: 5, load: 1 }, { userId: 4, load: 1 }]) === 4);
  check('attribution : tour de rôle', L.pickAssignee([{ userId: 1, load: 9 }, { userId: 2, load: 0 }, { userId: 3, load: 0 }], 'round_robin', 2) === 3 && L.pickAssignee([{ userId: 1, load: 9 }, { userId: 3, load: 0 }], 'round_robin', 3) === 1);
  check('notes RFM : récence [10..50] → 5,4,3,2,1', eq([10, 20, 30, 40, 50].map((v, _i, a) => L.quintile(v, a, false)), [5, 4, 3, 2, 1]));
  check('notes RFM : fréquence [1,1,2,3,10] → 1,1,3,4,5', eq([1, 1, 2, 3, 10].map((v, _i, a) => L.quintile(v, a)), [1, 1, 3, 4, 5]));
  check('segments RFM', eq([[5, 5], [3, 3], [4, 1], [4, 2], [3, 1], [2, 4], [2, 1], [1, 1]].map(([a, b]) => L.rfmSegment(a, b)), ['champions', 'loyal', 'new', 'promising', 'need_attention', 'at_risk', 'hibernating', 'lost']));
  check('ABC (Pareto 80/95) : 500,300,100,60,40 → A,A,B,B,C', eq(L.abc([500, 300, 100, 60, 40].map((m, i) => ({ id: i + 1, monetary: m }))).map((x) => x.abc), ['A', 'A', 'B', 'B', 'C']));
  check('valeur pondérée : 1 000 000 × 25 % = 250 000', L.weighted(1000000, 25) === 250000);
  check('doublons : même téléphone (+237) et nom proche regroupés', (() => { const g = L.duplicateGroups([{ id: 1, name: 'Alpha SARL', phone: '699 11 22 33' }, { id: 2, name: 'Alpha Ets', phone: '+237699112233' }, { id: 3, name: 'Beta', phone: '' }]); return g.length === 1 && eq(g[0].rows.map((x) => x.id).sort(), [1, 2]); })());
  check('règles de segment : ET de plusieurs conditions', L.matchRules({ revenue: 300, city: 'Douala' }, [{ field: 'revenue', op: 'gte', value: 250 }, { field: 'city', op: 'in', value: 'douala, yaoundé' }]) && !L.matchRules({ revenue: 100, city: 'Douala' }, [{ field: 'revenue', op: 'gte', value: 250 }]));

  // ---------- Rôles commerciaux ----------
  const uid = async (c) => (await c('GET', '/api/me')).json.user.id;
  const mkUser = async (name) => {
    const c = client(base);
    await c('POST', '/api/register', { name, contact: `${name.toLowerCase()}${Date.now()}@exemple.com`, pass: 'secret123' });
    r = await owner('POST', `${O}/invites`, { role: 'member' });
    await c('POST', '/api/ws/orgs/join', { code: r.json.code });
    return c;
  };
  await dbx.prepare("UPDATE users SET plan = 'Pro', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 30 * 86400000).toISOString(), await uid(owner)); // l'offre gratuite limite à 3 personnes
  const field1 = await mkUser('Fanta'); const field2 = await mkUser('Fred');
  const U = { mgr: await uid(mgr), mem: await uid(mem), f1: await uid(field1), f2: await uid(field2), owner: await uid(owner) };

  r = await mem('GET', `${C}/accounts`);
  check('rôles : un membre sans rôle commercial est refusé', r.status === 403 && /rôle commercial/.test(r.json.error), r.json);
  r = await mgr('GET', `${C}/accounts`);
  check('rôles : un responsable de l\'organisation non désigné lit seulement', r.status === 200, r.status);
  r = await mgr('POST', `${C}/accounts`, { name: 'Test' });
  check('rôles : lecture seule → création refusée', r.status === 403, r.status);
  r = await mem('GET', `${C}/me`);
  check('rôles : /me d\'un membre = aucun droit', r.json.role === 'none' && r.json.perms.length === 0, r.json);
  r = await owner('GET', `${C}/me`);
  check('rôles : le propriétaire a tous les droits (dont désigner)', r.json.boss && r.json.perms.includes('roles') && r.json.perms.includes('approve'), r.json);

  r = await mem('PUT', `${C}/roles/${U.mem}`, { role: 'sales_manager' });
  check('rôles : un membre ne se désigne pas lui-même', r.status === 403, r.status);
  r = await owner('PUT', `${C}/roles/${U.mgr}`, { role: 'sales_manager' });
  check('rôles : le propriétaire désigne le responsable commercial', r.status === 200, r.json);
  r = await owner('PUT', `${C}/roles/${U.owner}`, { role: 'sales_field' });
  check('rôles : inutile de désigner le propriétaire', r.status === 400, r.json);
  r = await mgr('PUT', `${C}/roles/${U.mem}`, { role: 'sales_assistant' });
  check('rôles : le responsable commercial désigne un assistant', r.status === 200, r.json);
  r = await mgr('PUT', `${C}/roles/${U.f1}`, { role: 'sales_field' });
  const rOk1 = r.status === 200;
  r = await mgr('PUT', `${C}/roles/${U.f2}`, { role: 'sales_field' });
  check('rôles : le responsable désigne des commerciaux terrain', rOk1 && r.status === 200, r.json);
  r = await mgr('PUT', `${C}/roles/${U.f1}`, { role: 'sales_manager' });
  check('rôles : seul le responsable du compte désigne un responsable commercial', r.status === 403, r.json);
  r = await mem('PUT', `${C}/roles/${U.f2}`, { role: 'none' });
  check('rôles : l\'assistant ne désigne personne', r.status === 403, r.status);
  r = await mgr('GET', `${C}/roles`);
  check('rôles : liste des membres avec leur rôle', r.json.members.find((m) => m.userId === U.mem).crole === 'sales_assistant' && r.json.members.find((m) => m.userId === U.owner).implicit === true, r.json.members);
  r = await mem('GET', `${C}/me`);
  check('rôles : l\'assistant prépare mais ne valide rien', r.json.perms.includes('write') && r.json.perms.includes('quote') && !r.json.perms.includes('approve') && !r.json.perms.includes('targets') && !r.json.perms.includes('merge'), r.json.perms);
  r = await mgr('GET', `${C}/audit`);
  check('traçabilité : les désignations sont journalisées avec le rôle de l\'auteur', r.json.events.filter((e) => e.entity === 'role' && e.action === 'set').length >= 4 && r.json.events.some((e) => e.crole === 'sales_manager'), r.json.events.slice(0, 3));

  // ---------- Zones ----------
  r = await mem('POST', `${C}/zones`, { name: 'Pirate' });
  check('zones : l\'assistant ne crée pas de zone', r.status === 403, r.status);
  r = await mgr('POST', `${C}/zones`, { name: 'Douala', cities: 'Douala, Bonabéri' });
  const zDla = r.json.id;
  r = await mgr('POST', `${C}/zones`, { name: 'Yaoundé', cities: 'Yaoundé' });
  const zYde = r.json.id;
  r = await mgr('PUT', `${C}/roles/${U.f1}`, { role: 'sales_field', zoneIds: [zDla] });
  r = await mgr('PUT', `${C}/roles/${U.f2}`, { role: 'sales_field', zoneIds: [zYde] });
  check('zones : territoires des commerciaux terrain', r.status === 200, r.json);

  // ---------- Comptes, contacts, doublons ----------
  r = await mem('POST', `${C}/accounts`, { name: 'Société Alpha', phone: '699112233', email: 'alpha@exemple.cm', city: 'Douala', sector: 'Commerce', kind: 'company' });
  const alpha = r.json.id;
  check('comptes : l\'assistant crée un compte', r.status === 201 && alpha, r.json);
  r = await mem('POST', `${C}/accounts`, { name: 'Alpha SARL', phone: '+237 699 11 22 33' });
  check('doublons : création refusée avec la fiche semblable proposée', r.status === 409 && r.json.duplicates.some((d) => d.id === alpha), r.json);
  r = await mem('POST', `${C}/accounts`, { name: 'Alpha SARL', phone: '+237 699 11 22 33', force: true });
  const alpha2 = r.json.id;
  check('doublons : création forcée possible', r.status === 201, r.json);
  r = await mem('GET', `${C}/duplicates`);
  check('doublons : détection réservée au responsable', r.status === 403, r.status);
  r = await mgr('GET', `${C}/duplicates`);
  check('doublons : groupe détecté (téléphone + nom)', r.json.groups.some((g) => eq(g.accounts.map((a) => a.id).sort(), [alpha, alpha2].sort()) && g.reasons.includes('phone')), r.json);
  // Une facture sur le doublon : elle doit suivre la fusion.
  r = await owner('POST', `${O}/crm/documents`, { customerId: alpha2, kind: 'invoice', lines: [{ label: 'Ciment', quantity: 2, price: 5000 }] });
  const invDup = r.json.id;
  await owner('PUT', `${O}/crm/documents/${invDup}`, { status: 'sent' });
  r = await mem('POST', `${C}/accounts/merge`, { keepId: alpha, mergeIds: [alpha2] });
  check('doublons : l\'assistant ne fusionne pas', r.status === 403, r.status);
  r = await mgr('POST', `${C}/accounts/merge`, { keepId: alpha, mergeIds: [alpha2] });
  check('doublons : fusion → la facture est rattachée à la fiche conservée', r.status === 200 && r.json.moved.documents === 1, r.json);
  r = await owner('GET', `${O}/crm/customers/${alpha}`);
  check('doublons : la fiche conservée porte la facture, l\'autre a disparu', r.json.documents.some((d) => d.id === invDup), r.json);
  r = await mgr('GET', `${C}/accounts/${alpha2}`);
  check('doublons : fiche fusionnée supprimée', r.status === 404, r.status);

  r = await mem('POST', `${C}/accounts/${alpha}/contacts`, { name: 'M. Kamga', jobTitle: 'Gérant', phone: '699000111', isPrimary: true, isDecider: true });
  check('contacts : ajout', r.status === 201, r.json);
  r = await mem('POST', `${C}/activities`, { kind: 'call', customerId: alpha, outcome: 'Intéressé', durationMin: 12, note: 'Veut un devis ciment' });
  check('activités : appel enregistré', r.status === 201, r.json);
  r = await mem('POST', `${C}/activities`, { kind: 'telepathie', customerId: alpha });
  check('activités : type inconnu refusé', r.status === 400, r.json);
  r = await mem('POST', `${C}/notes`, { customerId: alpha, body: 'Préfère être appelé le matin.' });
  r = await mem('POST', `${C}/tasks`, { customerId: alpha, title: 'Envoyer le devis', dueAt: new Date(Date.now() - 3600000).toISOString() });
  const task1 = r.json.id;
  check('tâches : création avec échéance', r.status === 201 && task1, r.json);
  r = await mem('POST', `${C}/attachments`, { customerId: alpha, name: 'cahier.txt', mime: 'text/plain', data: Buffer.from('Cahier des charges').toString('base64') });
  const att = r.json.id;
  check('pièces jointes : dépôt', r.status === 201 && att, r.json);
  r = await mem('POST', `${C}/attachments`, { customerId: alpha, name: 'virus.exe', mime: 'application/x-msdownload', data: 'AAAA' });
  check('pièces jointes : type refusé', r.status === 400, r.json);
  r = await mem('GET', `${C}/attachments/${att}/file`);
  check('pièces jointes : téléchargement fidèle et sécurisé', r.text === 'Cahier des charges' && r.headers.get('x-content-type-options') === 'nosniff', r.text);
  const chat = (await dbx.prepare("INSERT INTO chats (org_id, session, customer_id, channel, contact, created_at, updated_at) VALUES (?, 's-alpha', ?, 'whatsapp', '237699112233', ?, ?)").run(org, alpha, new Date().toISOString(), new Date().toISOString())).lastInsertRowid;
  await dbx.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'user', 'Bonjour, je veux 200 sacs de ciment', ?)").run(chat, new Date().toISOString());
  r = await owner('POST', `${O}/crm/documents`, { customerId: alpha, kind: 'quote', lines: [{ label: 'Ciment', quantity: 200, price: 5500 }] });
  r = await mgr('GET', `${C}/accounts/${alpha}/timeline`);
  const cnt = r.json.counts;
  check('360° : messages, appel, note, tâche, pièce jointe, facture et devis dans l\'historique', cnt.message === 1 && cnt.call === 1 && cnt.note === 1 && cnt.task === 1 && cnt.attachment === 1 && cnt.invoice === 1 && cnt.quote === 1, cnt);
  r = await mem('GET', `${C}/tasks?mine=1&status=open`);
  check('tâches : la tâche échue est signalée en retard', r.json.overdue >= 1 && r.json.tasks[0].overdue === true, r.json);
  r = await mem('PUT', `${C}/tasks/${task1}`, { status: 'done' });
  r = await mem('GET', `${C}/tasks?status=done`);
  check('tâches : terminée', r.json.tasks.some((t) => t.id === task1 && t.doneAt), r.json);

  // Commercial terrain : périmètre limité à ses fiches
  r = await field1('POST', `${C}/accounts`, { name: 'Boutique Fanta', city: 'Douala' });
  const fa = r.json.id;
  check('terrain : crée un compte et en devient responsable', r.status === 201, r.json);
  r = await field1('GET', `${C}/accounts`);
  check('terrain : ne voit que ses propres comptes', r.json.accounts.length === 1 && r.json.accounts[0].id === fa, r.json.accounts.map((a) => a.name));
  r = await field1('GET', `${C}/accounts/${alpha}`);
  check('terrain : fiche d\'un autre commercial refusée', r.status === 403, r.status);
  r = await field1('PUT', `${C}/accounts/${alpha}`, { notes: 'x' });
  check('terrain : modification d\'une fiche d\'autrui refusée', r.status === 403, r.status);
  r = await field1('POST', `${C}/accounts/merge`, { keepId: fa, mergeIds: [alpha] });
  check('terrain : pas de fusion', r.status === 403, r.status);

  // ---------- Isolation entre organisations ----------
  r = await other('GET', `${C}/accounts`);
  check('isolation : un étranger n\'accède pas au module d\'une autre organisation', r.status === 404, r.status);
  r = await other('GET', `${C2}/accounts/${alpha}`);
  check('isolation : un compte d\'une autre organisation est introuvable', r.status === 404, r.status);
  r = await owner('GET', `${C2}/accounts`);
  check('isolation : le propriétaire de l\'organisation 1 ne lit pas l\'organisation 2', r.status === 404, r.status);
  r = await owner('POST', `${C}/activities`, { kind: 'call', customerId: 999999 });
  check('isolation : rattacher une saisie à une fiche inexistante refusé', r.status === 404, r.status);

  // ---------- Prospection : scores ----------
  r = await mem('POST', `${C}/leads`, { name: 'Ngono Paul', company: 'Ngono BTP', phone: '677001122', email: 'ngono@btp.cm', city: 'Douala', product: 'Ciment', source: 'referral', temperature: 'chaud', budgetEst: 500000, autoAssign: false });
  const leadA = r.json.id;
  check('prospect : créé', r.status === 201 && leadA, r.json);
  r = await mem('GET', `${C}/leads/${leadA}`);
  check('score : profil 27 + recommandation 18 + chaud 20 + budget 5 = 70 (A)', r.json.lead.score === 70 && r.json.lead.grade === 'A' && r.json.lead.scoreParts.profile === 27, r.json.lead);
  check('zone : Douala détectée à partir de la ville (accents ignorés)', r.json.lead.zoneId === zDla, r.json.lead);
  r = await mem('POST', `${C}/leads`, { name: 'Passant', source: 'ad', temperature: 'froid', autoAssign: false });
  const leadB = r.json.id;
  r = await mem('GET', `${C}/leads/${leadB}`);
  check('score : publicité + froid = 7 + 2 = 9 (D)', r.json.lead.score === 9 && r.json.lead.grade === 'D', r.json.lead);
  r = await mem('POST', `${C}/leads`, { name: 'Ngono Paul', phone: '+237 677 00 11 22' });
  check('prospect : doublon actif refusé', r.status === 409, r.json);
  r = await mem('PUT', `${C}/leads/${leadB}`, { status: 'qualified' });
  check('qualification : score 9 < 25 → refusée avec explication', r.status === 422 && /minimum 25/.test(r.json.error), r.json);

  // BANT saisi par un humain
  r = await mem('PUT', `${C}/bant/lead/${leadA}`, { budget: { rating: 4 }, authority: { rating: 4 }, need: { rating: 2 }, timing: { rating: 2 } });
  check('BANT : 4-4-2-2 → 75/100', r.status === 200 && r.json.score === 75, r.json);
  r = await mem('PUT', `${C}/bant/lead/${leadA}`, { budget: { rating: 9 } });
  check('BANT : note hors 0-4 refusée', r.status === 400, r.json);
  r = await mem('GET', `${C}/leads/${leadA}`);
  check('lien BANT → score : 70 + 15 % × 75 (11) = 81', r.json.lead.score === 81 && r.json.lead.bantScore === 75, r.json.lead);
  r = await mem('PUT', `${C}/leads/${leadA}`, { status: 'qualified' });
  check('qualification : score 81 → qualifié', r.status === 200, r.json);

  // Attribution automatique
  r = await mgr('POST', `${C}/assign-rules`, { name: 'Douala', priority: 1, zoneId: zDla, strategy: 'load' });
  r = await mgr('POST', `${C}/assign-rules`, { name: 'Ciment à Yaoundé', priority: 2, zoneId: zYde, product: 'ciment', assignees: [U.f2, U.mgr], strategy: 'load' });
  check('attribution : règles créées par le responsable', r.status === 201, r.json);
  r = await mem('POST', `${C}/assign-rules`, { name: 'x' });
  check('attribution : l\'assistant ne crée pas de règle', r.status === 403, r.status);
  r = await mem('POST', `${C}/leads`, { name: 'Client Douala', city: 'Douala', phone: '671000001', source: 'whatsapp' });
  check('attribution : zone Douala → commercial de la zone', r.json.ownerId === U.f1 && r.json.rule === 'Douala', r.json);
  r = await mem('POST', `${C}/leads`, { name: 'Client Yaoundé', city: 'Yaoundé', phone: '671000002', product: 'Ciment 50kg', source: 'field' });
  check('attribution : règle produit + zone, le moins chargé parmi les désignés', [U.f2, U.mgr].includes(r.json.ownerId) && r.json.rule === 'Ciment à Yaoundé', r.json);
  r = await mem('POST', `${C}/leads`, { name: 'Client Kribi', city: 'Kribi', phone: '671000003', source: 'web' });
  const ownerK = r.json.ownerId;
  r = await mgr('GET', `${C}/assign-rules`);
  const loads = Object.fromEntries(r.json.load.map((l) => [l.userId, l.open]));
  check('attribution : sans règle, le moins chargé de l\'équipe', ownerK && [U.mgr, U.f1, U.f2].includes(ownerK), { ownerK, loads });
  r = await field1('GET', `${C}/leads`);
  check('terrain : ne voit que ses prospects', r.json.leads.length >= 1 && r.json.leads.every((l) => l.ownerId === U.f1), r.json.leads.map((l) => [l.name, l.ownerId]));

  // Prospect WhatsApp + suggestion BANT
  const chat2 = (await dbx.prepare("INSERT INTO chats (org_id, session, channel, contact, lead, created_at, updated_at) VALUES (?, 's-wa2', 'whatsapp', '237655443322', ?, ?, ?)").run(org, JSON.stringify({ need: 'Ciment', quantity: '200 sacs', deadline: 'urgent cette semaine', budget: '800000 FCFA', temperature: 'chaud' }), new Date().toISOString(), new Date().toISOString())).lastInsertRowid;
  await dbx.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'user', 'Bonjour, je suis le gérant, il me faut du ciment', ?)").run(chat2, new Date().toISOString());
  r = await mem('POST', `${C}/leads-sync-whatsapp`, {});
  check('WhatsApp : la conversation devient un prospect (une seule fois)', r.json.created === 1, r.json);
  r = await mem('POST', `${C}/leads-sync-whatsapp`, {});
  check('WhatsApp : pas de doublon à la deuxième synchronisation', r.json.created === 0, r.json);
  r = await mem('GET', `${C}/leads?source=whatsapp&q=655443322`);
  const leadW = r.json.leads[0];
  check('WhatsApp : source, température et téléphone repris', leadW && leadW.temperature === 'chaud' && leadW.chatId === Number(chat2), leadW);
  r = await mem('POST', `${C}/bant/lead/${leadW.id}/suggest`, {});
  check('BANT depuis WhatsApp : suggestion budget 2, autorité 3, besoin 4, délai 4', r.status === 200 && r.json.suggestion.budget.rating === 2 && r.json.suggestion.authority.rating === 3 && r.json.suggestion.need.rating === 4 && r.json.suggestion.timing.rating === 4, r.json.suggestion);
  check('BANT depuis WhatsApp : la suggestion ne compte pas (score 0, à valider)', r.json.score === 0 && r.json.needsValidation === true, r.json);
  r = await mem('POST', `${C}/bant/lead/${leadW.id}/validate`, { criteria: ['budget', 'need'] });
  check('BANT : validation humaine de 2 critères → 25×2/4 + 25×4/4 = 38', r.status === 200 && r.json.score === 38 && r.json.bant.budget.validated && !r.json.bant.authority.validated, r.json);
  r = await mem('POST', `${C}/bant/lead/${leadB}/suggest`, {});
  check('BANT : sans conversation WhatsApp, pas de suggestion', r.status === 404, r.json);

  // Cadences
  r = await mgr('POST', `${C}/cadences`, { name: 'Prospection 9 jours', target: 'lead' });
  const cad = r.json.id;
  check('cadence : créée avec les étapes par défaut', r.status === 201 && cad, r.json);
  r = await mem('POST', `${C}/cadences`, { name: 'x' });
  check('cadence : l\'assistant ne définit pas de cadence', r.status === 403, r.status);
  r = await mgr('POST', `${C}/cadences`, { name: 'Mauvaise', steps: [{ day: 5, channel: 'whatsapp', text: 'a' }, { day: 1, channel: 'whatsapp', text: 'b' }] });
  check('cadence : jours non croissants refusés', r.status === 400, r.json);
  r = await mem('POST', `${C}/cadences/${cad}/start`, { leadIds: [leadW.id, leadA] });
  check('cadence : démarrée sur deux prospects', r.status === 201 && r.json.started.length === 2, r.json);
  r = await mem('POST', `${C}/cadences/${cad}/start`, { leadId: leadA });
  check('cadence : pas de double démarrage', r.json.started.length === 0 && r.json.skipped[0].why === 'running', r.json);
  r = await mem('GET', `${C}/cadences-queue`);
  const qi = r.json.queue.find((q) => q.leadId === leadW.id);
  check('cadence : première étape à traiter, message personnalisé', qi && qi.step.channel === 'whatsapp' && /^Bonjour /.test(qi.step.text) && qi.step.text.includes('Ciment') && qi.waLink, qi);
  r = await mem('POST', `${C}/cadences-runs/${qi.id}/send`, {});
  check('cadence : WhatsApp non connecté → pas d\'envoi, lien de repli fourni', r.status === 422 && /WhatsApp/.test(r.json.error) && r.json.waLink, r.json);
  r = await mem('POST', `${C}/cadences-runs/${qi.id}/manual`, {});
  r = await mem('GET', `${C}/cadences-runs/${qi.id}/log`);
  check('cadence : envoi manuel journalisé', r.json.log.length === 1 && r.json.log[0].result === 'manual', r.json);
  r = await mem('GET', `${C}/cadences-runs`);
  check('cadence : passe à l\'étape suivante (J+2)', r.json.runs.find((x) => x.id === qi.id).stepIdx === 1, r.json.runs[0]);
  // Le client répond → la cadence s'arrête
  await dbx.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'user', 'Oui je suis intéressé', ?)").run(chat2, new Date(Date.now() + 5000).toISOString());
  await dbx.prepare('UPDATE cp_cadence_runs SET next_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), qi.id);
  r = await mem('GET', `${C}/cadences-queue`);
  check('cadence : le client a répondu → relance arrêtée', !r.json.queue.some((q) => q.id === qi.id), r.json.queue);
  r = await mem('GET', `${C}/cadences-runs`);
  check('cadence : motif d\'arrêt = réponse du client', r.json.runs.find((x) => x.id === qi.id).stopReason === 'replied', r.json.runs);
  await dbx.prepare("UPDATE cp_cadence_runs SET next_at = ? WHERE lead_id = ?").run(new Date(Date.now() - 1000).toISOString(), leadA);
  r = await mem('POST', `${C}/cadences-runs/${(await mem('GET', `${C}/cadences-queue`)).json.queue.find((q) => q.leadId === leadA).id}/skip`, {});
  check('cadence : étape sautée', r.status === 200, r.json);

  // Conversion et tableau de bord
  r = await mem('POST', `${C}/leads/${leadA}/convert`, { amount: 600000 });
  check('conversion : compte + contact + opportunité créés', r.status === 201 && r.json.customerId && r.json.oppId, r.json);
  const convOpp = r.json.oppId; const convCust = r.json.customerId;
  r = await mem('GET', `${C}/cadences-runs`);
  check('conversion : les relances du prospect sont arrêtées', r.json.runs.filter((x) => x.leadId === leadA).every((x) => x.state === 'stopped' && x.stopReason === 'converted'), r.json.runs);
  r = await mem('POST', `${C}/leads/${leadA}/convert`, {});
  check('conversion : pas deux fois', r.status === 409, r.status);
  r = await mem('PUT', `${C}/leads/${leadB}`, { status: 'lost' });
  check('prospect perdu : le motif est obligatoire', r.status === 400, r.json);
  r = await mem('PUT', `${C}/leads/${leadB}`, { status: 'lost', lostReason: 'Pas intéressé' });
  r = await mgr('GET', `${C}/prospection/dashboard?from=${iso(30)}&to=${iso(-1)}`);
  const d = r.json;
  const refSrc = d.bySource.find((x) => x.source === 'referral');
  check('tableau de bord : recommandation = 1 prospect converti (100 %)', refSrc && refSrc.leads === 1 && refSrc.converted === 1 && refSrc.conversionRate === 100, d.bySource);
  const adSrc = d.bySource.find((x) => x.source === 'ad');
  check('tableau de bord : publicité = 1 prospect perdu (0 %)', adSrc && adSrc.leads === 1 && adSrc.converted === 0 && adSrc.lost === 1, d.bySource);
  check('tableau de bord : total et conversion globale cohérents', d.total === d.bySource.reduce((a, x) => a + x.leads, 0) && d.converted === 1 && d.funnel[0].count === d.total && d.funnel[3].count === 1, { total: d.total, funnel: d.funnel });
  check('tableau de bord : meilleure source = recommandation', d.bestSource && d.bestSource.source === 'referral', d.bestSource);

  // ---------- Pipeline ----------
  r = await mem('GET', `${C}/pipeline/stages`);
  const st = Object.fromEntries(r.json.stages.map((x) => [x.name, x]));
  check('pipeline : 6 étapes par défaut, probabilités 10-25-50-75-100-0', eq(r.json.stages.map((x) => x.probability), [10, 25, 50, 75, 100, 0]) && st['Proposition'].minBant === 40, r.json.stages);
  r = await mem('POST', `${C}/pipeline/stages`, { name: 'Pirate', probability: 5 });
  check('pipeline : l\'assistant ne configure pas les étapes', r.status === 403, r.status);
  r = await mgr('POST', `${C}/pipeline/stages`, { name: 'Démonstration', probability: 40, minBant: 20, stagnantDays: 5 });
  const stDemo = r.json.id;
  r = await mgr('GET', `${C}/pipeline/stages`);
  check('pipeline : étape ajoutée avant « Gagné »', r.json.stages.findIndex((x) => x.id === stDemo) === 4 && r.json.stages[r.json.stages.length - 2].name === 'Gagné', r.json.stages.map((x) => x.name));
  r = await mgr('DELETE', `${C}/pipeline/stages/${stDemo}`);
  check('pipeline : étape vide supprimable', r.status === 200, r.json);

  r = await mem('POST', `${C}/opps`, { name: 'Chantier Alpha', customerId: alpha, amount: 1000000, product: 'Ciment', ownerId: U.f1 });
  const o1 = r.json.id;
  r = await mem('POST', `${C}/opps`, { name: 'Dépôt Beta', customerId: alpha, amount: 500000 });
  const o2 = r.json.id;
  r = await mem('POST', `${C}/opps`, { name: 'Magasin Gamma', customerId: alpha, amount: 300000 });
  const o3 = r.json.id;
  r = await mem('POST', `${C}/opps`, { name: 'Petit Delta', customerId: alpha, amount: 200000 });
  const o4 = r.json.id;
  r = await mem('GET', `${C}/opps/${o1}`);
  check('opportunité : née dans « Nouveau » à 10 % → valeur pondérée 100 000', r.json.opportunity.stage === 'Nouveau' && r.json.opportunity.probability === 10 && r.json.opportunity.weighted === 100000, r.json.opportunity);
  r = await mem('POST', `${C}/opps/${o1}/move`, { stageId: st['Proposition'].id });
  check('règle de passage : BANT 0 < 40 → refusé (code bant_required)', r.status === 422 && r.json.code === 'bant_required' && /40/.test(r.json.error), r.json);
  r = await mem('POST', `${C}/opps/${o1}/move`, { stageId: st['Proposition'].id, overrideReason: 'Je force' });
  check('règle de passage : l\'assistant ne peut pas passer outre', r.status === 422, r.json);
  r = await mgr('POST', `${C}/opps/${o1}/move`, { stageId: st['Proposition'].id, overrideReason: 'Client connu, besoin évident' });
  check('règle de passage : le responsable passe outre avec un motif (tracé)', r.status === 200, r.json);
  r = await mgr('GET', `${C}/audit`);
  check('règle de passage : dérogation journalisée', r.json.events.some((e) => e.action === 'bant_override' && /Client connu/.test(e.detail)), r.json.events.slice(0, 4));
  for (const id of [o1, o2]) await mem('PUT', `${C}/bant/opp/${id}`, { budget: { rating: 4 }, authority: { rating: 4 }, need: { rating: 2 }, timing: { rating: 2 } });
  r = await mem('POST', `${C}/opps/${o1}/move`, { stageId: st['Négociation'].id });
  check('règle de passage : BANT 75 ≥ 60 → Négociation autorisée', r.status === 200, r.json);
  r = await mem('GET', `${C}/opps/${o1}`);
  check('valeur pondérée en Négociation : 1 000 000 × 75 % = 750 000', r.json.opportunity.weighted === 750000 && r.json.history.length === 3, r.json.opportunity);
  r = await mem('PUT', `${C}/opps/${o1}`, { probability: 10 });
  check('probabilité : l\'assistant ne s\'écarte pas de plus de 20 points', r.status === 403, r.json);
  r = await mem('POST', `${C}/opps/${o1}/move`, { stageId: st['Gagné'].id, reasonId: (await mem('GET', `${C}/pipeline/reasons`)).json.reasons.find((x) => x.kind === 'win' && /prix/.test(x.label)).id });
  check('gain : clôturé avec motif', r.status === 200, r.json);
  r = await mem('POST', `${C}/opps/${o2}/move`, { stageId: st['Proposition'].id });
  r = await mem('POST', `${C}/opps/${o2}/move`, { stageId: st['Perdu'].id });
  check('perte : le motif est obligatoire', r.status === 400, r.json);
  const lossR = (await mem('GET', `${C}/pipeline/reasons`)).json.reasons.find((x) => x.kind === 'loss' && /Prix/.test(x.label));
  r = await mem('POST', `${C}/opps/${o2}/move`, { stageId: st['Perdu'].id, reasonId: lossR.id });
  check('perte : enregistrée avec le motif « Prix trop élevé »', r.status === 200, r.json);
  r = await mem('POST', `${C}/opps/${o2}/move`, { stageId: st['Qualification'].id });
  check('clôturée : plus de déplacement sans réouverture', r.status === 409, r.json);
  r = await mem('POST', `${C}/opps/${o3}/move`, { stageId: st['Qualification'].id });
  await dbx.prepare('UPDATE cp_opps SET stage_entered_at = ? WHERE id = ?').run(new Date(Date.now() - 20 * 86400000).toISOString(), o3);
  r = await mem('GET', `${C}/pipeline/stagnant`);
  check('stagnation : 20 jours en Qualification (seuil 10) signalée', r.json.count === 1 && r.json.opportunities[0].id === o3 && r.json.opportunities[0].daysInStage === 20, r.json);
  r = await mem('GET', `${C}/pipeline/board`);
  check('kanban : 3 affaires ouvertes, 1 100 000, pondéré 25 % × 300 000 + 10 % × 200 000 + 10 % × 600 000 = 155 000', r.json.totals.count === 3 && r.json.totals.amount === 1100000 && r.json.totals.weighted === 155000 && r.json.totals.stagnant === 1, r.json.totals);
  r = await mem('GET', `${C}/pipeline/funnel`);
  const fu = r.json;
  const stepsC = fu.steps.map((x) => x.count);
  const baseCount = fu.created;
  check('entonnoir : affaires atteignant chaque étape (hors affaire issue de la conversion)', stepsC[0] === baseCount && stepsC[1] >= 3 && stepsC[3] >= 1, fu.steps);
  check('entonnoir : taux de gain = 1 gagnée / (1 gagnée + 1 perdue) = 50 %', fu.won === 1 && fu.lost === 1 && fu.winRate === 50 && fu.wonAmount === 1000000 && fu.lostAmount === 500000, fu);
  check('entonnoir : motifs de perte comptés', fu.lossReasons[0].reason === 'Prix trop élevé' && fu.lossReasons[0].count === 1, fu.lossReasons);
  r = await field1('GET', `${C}/opps`);
  check('terrain : ne voit que ses opportunités', r.json.opportunities.length === 1 && r.json.opportunities[0].id === o1, r.json.opportunities.map((o) => o.name));
  r = await field1('POST', `${C}/opps/${o4}/move`, { stageId: st['Qualification'].id });
  check('terrain : ne déplace pas l\'opportunité d\'un autre', r.status === 403, r.status);
  r = await mem('GET', `${C}/opps/${convOpp}`);
  check('conversion : l\'opportunité reprend le montant (600 000) et le score BANT (75)', r.json.opportunity.amount === 600000 && r.json.opportunity.bantScore === 75 && r.json.opportunity.customerId === convCust, r.json.opportunity);

  // ---------- Segmentation (organisation 2, jeu de données propre) ----------
  const mk = async (name, sector, city, invs) => {
    r = await other('POST', `${C2}/accounts`, { name, sector, city, kind: 'company', potential: invs.length > 2 ? 'high' : 'low' });
    const id = r.json.id;
    for (const [days, amount] of invs) {
      r = await other('POST', `${ws(org2)}/crm/documents`, { customerId: id, kind: 'invoice', issued: iso(days), lines: [{ label: 'Vente', quantity: 1, price: amount }] });
      await other('PUT', `${ws(org2)}/crm/documents/${r.json.id}`, { status: 'sent' });
    }
    return id;
  };
  const c1 = await mk('Client Un', 'Commerce', 'Douala', [[40, 400000], [30, 400000], [20, 400000], [10, 400000], [5, 400000]]);
  const c2 = await mk('Client Deux', 'Commerce', 'Douala', [[50, 200000], [35, 200000], [20, 200000]]);
  const c3 = await mk('Client Trois', 'BTP', 'Yaoundé', [[90, 125000], [60, 125000]]);
  await mk('Client Quatre', 'BTP', 'Yaoundé', [[120, 100000]]);
  await mk('Client Cinq', 'Commerce', 'Kribi', [[300, 50000]]);
  await other('POST', `${C2}/accounts`, { name: 'Jamais acheté' });
  r = await other('GET', `${C2}/segments/overview`);
  const sv = r.json;
  const seg = Object.fromEntries(sv.rfm.map((x) => [x.key, x]));
  check('segmentation : 6 comptes dont 5 acheteurs, CA = 3 000 000', sv.customers === 6 && sv.buyers === 5 && sv.nonBuyers === 1 && sv.revenue === 3000000, sv);
  check('RFM : 2 champions (2 600 000 = 86,7 %), 1 fidèle, 1 en sommeil, 1 perdu', seg.champions.count === 2 && seg.champions.revenue === 2600000 && seg.champions.share === 86.7 && seg.loyal.count === 1 && seg.hibernating.count === 1 && seg.lost.count === 1, sv.rfm.map((x) => [x.key, x.count]));
  check('ABC : A = 2 clients (86,7 %), B = 1 (8,3 %), C = 2 (5 %)', sv.abc[0].count === 2 && sv.abc[0].share === 86.7 && sv.abc[1].count === 1 && sv.abc[1].share === 8.3 && sv.abc[2].count === 2 && sv.abc[2].share === 5, sv.abc);
  check('ABC : la courbe de Pareto finit à 100 %', sv.curve[sv.curve.length - 1].cumShare === 100 && sv.curve[0].cumShare === 66.7, sv.curve);
  const secC = sv.sector.find((x) => x.key === 'Commerce');
  check('secteur : Commerce = 3 clients, 2 650 000 (88,3 %)', secC.count === 3 && secC.revenue === 2650000 && secC.share === 88.3, sv.sector);
  check('ville : Douala = 2 clients, 2 600 000', sv.city.find((x) => x.key === 'Douala').revenue === 2600000, sv.city);
  check('matrice R×F : le client 5-5 est en haut à droite', sv.matrix[0][4].count === 1 && sv.matrix[0][4].r === 5 && sv.matrix[0][4].f === 5, sv.matrix[0]);
  check('actions suggérées par segment', eq(seg.at_risk.actions, ['call_now', 'win_back_offer', 'check_satisfaction']) && seg.champions.actions.includes('ask_referral'), seg.at_risk);
  r = await other('GET', `${C2}/segments/members?type=rfm&key=champions`);
  check('membres d\'un segment : triés par CA', r.json.count === 2 && r.json.members[0].id === c1 && r.json.members[0].revenue === 2000000 && r.json.members[0].rfm === '555', r.json.members);
  r = await other('GET', `${C2}/segments/members?type=nonbuyers`);
  check('membres : comptes sans achat', r.json.count === 1, r.json);
  r = await other('POST', `${C2}/segments/custom`, { name: 'Bons clients récents', rules: [{ field: 'revenue', op: 'gte', value: 250000 }, { field: 'recencyDays', op: 'lte', value: 90 }] });
  const cs = r.json.id;
  r = await other('GET', `${C2}/segments/custom`);
  const mine2 = r.json.segments.find((x) => x.id === cs);
  check('segment personnalisé : 3 membres, 2 850 000', mine2.count === 3 && mine2.revenue === 2850000, mine2);
  r = await other('POST', `${C2}/segments/custom`, { name: 'Mauvais', rules: [{ field: 'secret', op: 'eq', value: 1 }] });
  check('segment personnalisé : champ inconnu refusé', r.status === 400, r.json);
  r = await other('GET', `${C2}/segments/custom/${cs}/members`);
  check('segment personnalisé : membres', r.json.members.map((x) => x.id).sort().join() === [c1, c2, c3].sort().join(), r.json.members.map((x) => x.id));
  r = await other('POST', `${C2}/segments/tasks`, { rfm: 'champions', title: 'Demander une recommandation' });
  check('action de segment : une tâche par champion', r.status === 201 && r.json.created === 2, r.json);
  r = await owner('GET', `${C}/segments/overview`);
  check('isolation : la segmentation de l\'organisation 1 ne contient pas les clients de l\'organisation 2', !JSON.stringify(r.json).includes('Client Un'), r.status);
});
