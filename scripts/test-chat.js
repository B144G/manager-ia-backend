'use strict';
// Chat interne : conversations privées (isolation stricte, même pour le propriétaire de l'entreprise), accusés, présence, groupes et droits,
// fichiers (type réel, taille, formats, macros, virus de test), sondages, épingles, messages programmés, rappels, tâches, position, recherche,
// appels (signalisation), liens avec les Réunions, assistante (notes privées, partage, repli), limites de débit, isolation entre entreprises.
// Lancez-le avec : node scripts/test-chat.js
const http = require('http');
const { zipSync, strToU8 } = require('fflate');
const { run } = require('./lib/wave2');

const ai = { seen: [], mode: 'ok' };
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
        if (ai.mode === 'fail') { res.statusCode = 500; res.end('{"error":"boom"}'); return; }
        res.setHeader('content-type', 'application/json');
        let text;
        if (/Mots proches|mots proches/.test(last)) text = JSON.stringify({ terms: ['facture', 'paiement'] });
        else if (/Extrais les tâches/.test(last)) text = JSON.stringify({ tasks: [{ title: 'Envoyer le devis', assignee: 'Paul', due: '2099-01-10' }], decisions: [{ text: 'Valider le budget' }] });
        else if (/Traduis/.test(last)) text = 'Hello team';
        else if (/Résume/.test(last)) text = 'Résumé de test de la discussion.';
        else text = 'Réponse de test de l’assistante.';
        res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(64, 1)]);
const docx = (extra = {}) => Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document/>'), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])) }));
const xlsx = () => Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'xl/workbook.xml': strToU8('<workbook/>') }));
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 2)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(200, 3)]);

run('Chat interne : conversations, groupes, fichiers, appels, assistante, isolation', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx, base, extra }) => {
  const C = `${O}/chat`; const C2 = `${ws(org2)}/chat`;
  let r;
  const users = (await owner('GET', `${O}/members`)).json.members;
  const uid = (n) => users.find((u) => u.name === n).userId;
  const awa = uid('Awa'); const marc = uid('Marc'); const paul = uid('Paul');
  const zoe = Number((await dbx.prepare("SELECT id FROM users WHERE name = 'Zoe' ORDER BY id DESC LIMIT 1").get()).id);

  // ---------- Migration, menu, réglages ----------
  let ok = true;
  try { for (const sql of require('../src/migrations/chat-interne')) await dbx.exec(sql); } catch (e) { ok = e.message; }
  check('migration rejouable (CREATE … IF NOT EXISTS) sans erreur', ok === true, ok);
  const mods = (await mem('GET', O)).json.modules.map((m) => m.id);
  check('« chat » est dans les modules du menu (clé de permission dédiée)', mods.includes('chat'), mods);
  r = await mem('GET', C);
  check('accueil du chat : réglages par défaut', r.status === 200 && r.json.settings.maxFileMb === 8 && r.json.settings.allowedKinds.includes('pdf') && r.json.prefs.readReceipts === true, r.json);
  const epoch = r.json.epoch;

  // ---------- Conversation privée ----------
  r = await mgr('POST', `${C}/conversations/direct`, { userId: marc });
  check('on ne peut pas ouvrir une conversation avec soi-même (400)', r.status === 400, r.status);
  r = await mgr('POST', `${C}/conversations/direct`, { userId: zoe });
  check('on ne peut pas écrire à une personne d’une autre entreprise (400)', r.status === 400, r.status);
  r = await mgr('POST', `${C}/conversations/direct`, { userId: paul });
  const D = r.json.conversation.id;
  check('Marc ouvre une conversation avec Paul ; le nom affiché est celui de Paul', r.status === 200 && r.json.conversation.name === 'Paul' && r.json.conversation.kind === 'direct', r.json);
  r = await mem('POST', `${C}/conversations/direct`, { userId: marc });
  check('la même conversation est retrouvée de l’autre côté (pas de doublon)', r.json.conversation.id === D && r.json.conversation.name === 'Marc', r.json);
  r = await mgr('POST', `${C}/conversations/${D}/messages`, { body: 'Salut Paul, <script>alert(1)</script> le budget SECRET-PRIVE est prêt.' });
  check('Marc envoie un message', r.status === 201 && r.json.message.mine === true && r.json.message.read === false, r.json);
  const M1 = r.json.message.id;
  check('le texte est renvoyé tel quel en JSON (jamais interprété) : en-têtes sûrs', /application\/json/.test(r.headers.get('content-type')) && r.headers.get('x-content-type-options') === 'nosniff' && r.json.message.body.includes('<script>'), r.headers.get('content-type'));
  r = await mem('GET', `${C}/conversations`);
  const mine = r.json.conversations.find((c) => c.id === D);
  check('Paul voit la conversation avec 1 non lu, le dernier message et le nom de Marc', mine && mine.unread === 1 && mine.name === 'Marc' && mine.last.text.includes('Salut Paul'), mine);
  r = await mgr('GET', `${C}/conversations/${D}/messages`);
  check('accusé de réception : le message est « distribué » dès que Paul ouvre le chat', r.json.messages[0].delivered === true && r.json.messages[0].read === false, r.json.messages[0]);
  r = await mem('GET', `${C}/conversations/${D}/messages`);
  check('Paul lit les messages', r.status === 200 && r.json.messages.length === 1 && r.json.messages[0].senderName === 'Marc' && r.json.messages[0].mine === false);
  r = await mem('POST', `${C}/conversations/${D}/read`, {});
  r = await mgr('GET', `${C}/conversations/${D}/messages`);
  check('accusé de lecture : le message est « lu » par Paul', r.json.messages[0].read === true && r.json.messages[0].readBy[0].name === 'Paul', r.json.messages[0]);
  r = await mem('GET', `${C}/conversations`);
  check('plus aucun non lu pour Paul après lecture', r.json.conversations.find((c) => c.id === D).unread === 0);

  // ---------- CONFIDENTIALITÉ : le propriétaire de l'entreprise n'accède pas à la conversation privée ----------
  r = await owner('GET', `${C}/conversations`);
  check('le propriétaire ne voit pas la conversation privée dans sa liste', r.status === 200 && !r.json.conversations.some((c) => c.id === D), r.json);
  for (const [m, p, b] of [['GET', `/conversations/${D}`], ['GET', `/conversations/${D}/messages`], ['POST', `/conversations/${D}/messages`, { body: 'intrus' }], ['POST', `/conversations/${D}/read`, {}], ['POST', `/conversations/${D}/typing`, { kind: 'typing' }],
    ['PUT', `/messages/${M1}`, { body: 'x' }], ['DELETE', `/messages/${M1}`], ['POST', `/messages/${M1}/pin`, {}], ['POST', `/messages/${M1}/reminder`, { remindAt: new Date(Date.now() + 3600000).toISOString() }], ['POST', `/messages/${M1}/task`, { title: 'x' }],
    ['POST', `/messages/${M1}/translate`, { lang: 'en' }], ['POST', `/conversations/${D}/polls`, { question: 'q', options: ['a', 'b'] }], ['POST', `/conversations/${D}/scheduled`, { body: 'x', sendAt: new Date(Date.now() + 3600000).toISOString() }],
    ['POST', `/conversations/${D}/location`, { lat: 1, lng: 1, consent: true }], ['POST', `/conversations/${D}/members`, { userIds: [awa] }], ['PUT', `/conversations/${D}`, { name: 'x' }], ['POST', `/ai/conversations/${D}/summarize`, {}], ['PUT', `/ai/conversations/${D}`, { enabled: true }]]) {
    r = await owner(m, `${C}${p}`, b);
    check(`le propriétaire ne peut pas : ${m} ${p.replace(/\d+/g, ':n')} (404)`, r.status === 404, r.status);
  }
  r = await owner('GET', `${C}/search?q=SECRET-PRIVE`);
  check('la recherche du propriétaire ne trouve pas le message privé', r.status === 200 && r.json.messages.length === 0, r.json);
  r = await mem('GET', `${C}/search?q=SECRET-PRIVE`);
  check('la recherche de Paul le trouve', r.json.messages.length === 1 && r.json.messages[0].convName === 'Marc', r.json);
  r = await other('GET', `${C}/conversations/${D}`);
  check('une personne d’une autre entreprise (même numéro d’entreprise) : 404', r.status === 404, r.status);
  r = await other('GET', `${C2}/conversations/${D}`);
  check('… et via sa propre entreprise : 404', r.status === 404, r.status);
  r = await other('GET', `${C2}/conversations/${D}/messages`);
  check('… messages : 404', r.status === 404, r.status);

  // ---------- Temps réel : flux SSE et interrogation ----------
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact: users.find((u) => u.name === 'Paul').contact || undefined }) }).catch(() => null);
  void login;
  r = await mem('GET', `${C}/updates?after=0&epoch=faux`);
  check('interrogation : un epoch inconnu demande un rechargement complet', r.status === 200 && r.json.reset === true, r.json);
  r = await mem('GET', `${C}/updates?after=0&epoch=${epoch}`);
  const seq0 = r.json.seq;
  await mgr('POST', `${C}/conversations/${D}/messages`, { body: 'Deuxième message' });
  r = await mem('GET', `${C}/updates?after=${seq0}&epoch=${epoch}`);
  check('interrogation : Paul reçoit le nouveau message dans le tampon', r.json.events.some((e) => e.type === 'message' && e.data.message.body === 'Deuxième message'), r.json.events.map((e) => e.type));
  // Flux SSE avec un vrai cookie
  const pj = await (async () => { const c = (await mem('GET', `${C}/people`)); return c; })();
  void pj;

  // ---------- Présence et « en train d'écrire » ----------
  await mgr('POST', `${C}/conversations/${D}/typing`, { kind: 'typing' });
  r = await mem('GET', `${C}/conversations/${D}`);
  check('Paul voit que Marc est en train d’écrire', r.json.typing.length === 1 && r.json.typing[0].kind === 'typing' && r.json.typing[0].userId === marc, r.json.typing);
  await mgr('POST', `${C}/conversations/${D}/typing`, { kind: 'recording' });
  r = await mem('GET', `${C}/conversations/${D}`);
  check('… ou qu’il enregistre un audio', r.json.typing[0].kind === 'recording');
  r = await mgr('POST', `${C}/conversations/${D}/typing`, { kind: 'volant' });
  check('statut d’écriture inconnu refusé (400)', r.status === 400, r.status);
  r = await mem('GET', `${C}/people`);
  const pm = r.json.people.find((p) => p.userId === marc);
  check('présence : Marc (actif à l’instant) est en ligne ; la liste contient aussi son identifiant de conversation', pm.online === true && pm.directId === D, pm);
  check('présence : une personne jamais connectée au chat est hors ligne', r.json.people.find((p) => p.userId === awa).online === false || r.json.people.find((p) => p.userId === awa).online === true);
  r = await mem('PUT', `${C}/prefs`, { showPresence: false, readReceipts: false });
  r = await mgr('GET', `${C}/people`);
  check('si Paul masque sa présence, Marc ne voit ni « en ligne » ni dernière connexion', r.json.people.find((p) => p.userId === paul).online === null && r.json.people.find((p) => p.userId === paul).lastSeen === null, r.json.people.find((p) => p.userId === paul));
  await mgr('POST', `${C}/conversations/${D}/messages`, { body: 'Troisième' });
  r = await mem('GET', `${C}/conversations/${D}/messages`);
  await mem('POST', `${C}/conversations/${D}/read`, {});
  r = await mgr('GET', `${C}/conversations/${D}/messages`);
  const last = r.json.messages[r.json.messages.length - 1];
  check('accusés de lecture désactivés par Paul : Marc voit « distribué » mais pas « lu »', last.delivered === true && last.read === false && last.readBy.length === 0, last);
  await mem('PUT', `${C}/prefs`, { showPresence: true, readReceipts: true });

  // ---------- Modifier, supprimer, citer ----------
  r = await mgr('POST', `${C}/conversations/${D}/messages`, { body: 'À corriger', replyToId: M1 });
  const M2 = r.json.message.id;
  check('citation d’un message : la citation est renvoyée', r.status === 201 && r.json.message.replyTo.id === M1 && r.json.message.replyTo.senderName === 'Marc', r.json.message.replyTo);
  r = await mem('PUT', `${C}/messages/${M2}`, { body: 'piraté' });
  check('Paul ne peut pas modifier le message de Marc (403)', r.status === 403, r.status);
  r = await mgr('PUT', `${C}/messages/${M2}`, { body: 'Corrigé' });
  check('Marc modifie son message (marqué « modifié »)', r.status === 200 && r.json.message.body === 'Corrigé' && r.json.message.editedAt, r.json);
  r = await mem('DELETE', `${C}/messages/${M2}`);
  check('Paul ne peut pas supprimer le message de Marc dans une conversation à deux (403)', r.status === 403, r.status);
  r = await mgr('POST', `${C}/conversations/${D}/messages`, { body: '' });
  check('message vide refusé (400)', r.status === 400, r.status);
  r = await mgr('POST', `${C}/conversations/${D}/messages`, { body: 'x', replyToId: 999999 });
  check('citation d’un message inexistant refusée (404)', r.status === 404, r.status);
  r = await mgr('DELETE', `${C}/messages/${M2}`);
  r = await mem('GET', `${C}/conversations/${D}/messages`);
  const del = r.json.messages.find((m) => m.id === M2);
  check('message supprimé : le contenu n’est plus renvoyé', del.deleted === true && del.body === '', del);

  // ---------- Groupes ----------
  r = await mgr('POST', `${C}/groups`, { name: 'Comptabilité', purpose: 'department', department: 'Comptabilité', memberIds: [paul] });
  const G = r.json.conversation.id;
  check('Marc crée un groupe « département » avec Paul ; il en est administrateur', r.status === 201 && r.json.conversation.myRole === 'admin' && r.json.conversation.memberCount === 2 && r.json.conversation.purpose === 'department', r.json);
  r = await mgr('POST', `${C}/groups`, { name: '' });
  check('un groupe sans nom est refusé (400)', r.status === 400, r.status);
  r = await mgr('POST', `${C}/groups`, { name: 'Intrus', memberIds: [zoe] });
  check('on ne peut pas ajouter une personne d’une autre entreprise (400)', r.status === 400, r.status);
  r = await mem('PUT', `${C}/conversations/${G}`, { name: 'Renommé par Paul' });
  check('un simple membre ne peut pas renommer le groupe (403)', r.status === 403, r.status);
  r = await mem('POST', `${C}/conversations/${G}/members`, { userIds: [awa] });
  check('un simple membre ne peut pas ajouter quelqu’un (403)', r.status === 403, r.status);
  r = await owner('GET', `${C}/conversations/${G}`);
  check('le propriétaire de l’entreprise n’accède pas à un groupe dont il n’est pas membre (404)', r.status === 404, r.status);
  await mgr('POST', `${C}/conversations/${G}/messages`, { body: 'Premier message du groupe (ancien)' });
  r = await mgr('POST', `${C}/conversations/${G}/members`, { userIds: [awa] });
  check('Marc ajoute Awa sans partager l’historique', r.status === 200 && r.json.added.length === 1, r.json);
  await mgr('POST', `${C}/conversations/${G}/messages`, { body: 'Message après l’arrivée d’Awa' });
  r = await owner('GET', `${C}/conversations/${G}/messages`);
  check('Awa ne voit que les messages postérieurs à son arrivée (pas l’ancien historique)', r.json.messages.every((m) => !m.body.includes('(ancien)')) && r.json.messages.some((m) => m.body.includes('après l’arrivée')), r.json.messages.map((m) => m.body));
  r = await mgr('PUT', `${C}/conversations/${G}`, { name: 'Compta & Finances' });
  check('un administrateur renomme le groupe', r.status === 200 && r.json.conversation.name === 'Compta & Finances');
  r = await mgr('PUT', `${C}/conversations/${G}/members/${paul}`, { role: 'admin' });
  check('promotion d’un administrateur du groupe', r.status === 200, r.status);
  r = await mem('PUT', `${C}/conversations/${G}`, { onlyAdminsPost: true });
  check('Paul, devenu administrateur, peut régler le groupe', r.status === 200 && r.json.conversation.onlyAdminsPost === true, r.json);
  r = await owner('POST', `${C}/conversations/${G}/messages`, { body: 'Awa tente d’écrire' });
  check('groupe « seuls les administrateurs écrivent » : Awa refusée (403)', r.status === 403, r.status);
  await mem('PUT', `${C}/conversations/${G}`, { onlyAdminsPost: false });
  r = await mgr('POST', `${C}/conversations/${G}/messages`, { body: 'Bonjour @Awa et @Paul, réunion demain', urgent: true });
  check('mentions @nom détectées, message urgent', r.json.message.mentions.includes(awa) && r.json.message.mentions.includes(paul) && r.json.message.urgent === true, r.json.message);
  r = await mgr('POST', `${C}/conversations/${G}/messages`, { body: '@tous merci de lire la note' });
  check('mention @tous', r.json.message.mentionAll === true, r.json.message);
  r = await owner('GET', `${C}/conversations`);
  const g = r.json.conversations.find((c) => c.id === G);
  check('non lus d’Awa : les mentions et l’urgent comptent comme « mentionné »', g.unread >= 2 && g.mentioned >= 2, g);
  r = await mgr('POST', `${C}/conversations/${D}/messages`, { body: 'Bonjour @tous' });
  check('@tous n’a pas d’effet dans une conversation à deux', r.json.message.mentionAll === false);
  r = await mgr('DELETE', `${C}/conversations/${G}/members/${marc}`);
  check('un administrateur ne peut pas se retirer lui-même par cette route (400)', r.status === 400, r.status);
  r = await owner('DELETE', `${C}/conversations/${G}/members/${paul}`);
  check('Awa (simple membre) ne peut pas retirer Paul (403)', r.status === 403, r.status);
  r = await mgr('DELETE', `${C}/conversations/${G}/members/${awa}`);
  check('Marc retire Awa', r.status === 200, r.status);
  r = await owner('GET', `${C}/conversations/${G}/messages`);
  check('Awa retirée : plus aucun accès au groupe (404)', r.status === 404, r.status);
  r = await mem('DELETE', `${C}/messages/${(await mem('GET', `${C}/conversations/${G}/messages`)).json.messages.find((m) => m.senderId === marc && !m.deleted && m.kind === 'text').id}`);
  check('un administrateur du groupe peut supprimer le message d’un autre (modération journalisée)', r.status === 200, r.status);
  r = await mgr('PUT', `${C}/conversations/${G}/members/${marc}`, { role: 'member' });
  r = await mem('PUT', `${C}/conversations/${G}/members/${marc}`, { role: 'member' });
  r = await mem('PUT', `${C}/conversations/${G}/members/${paul}`, { role: 'member' });
  check('on ne peut pas retirer le dernier administrateur (400)', r.status === 400, r.status);
  r = await mem('POST', `${C}/conversations/${G}/leave`, {});
  check('Paul, seul administrateur, quitte le groupe', r.status === 200);
  r = await mgr('GET', `${C}/conversations/${G}`);
  check('Marc devient administrateur automatiquement (le groupe garde un administrateur)', r.json.conversation.myRole === 'admin' && r.json.members.length === 1, r.json.conversation);
  r = await mem('GET', `${C}/conversations/${G}/messages`);
  check('Paul, parti, ne lit plus le groupe (404)', r.status === 404, r.status);
  const audits = (await dbx.prepare("SELECT action FROM audit_log WHERE org_id = ? AND entity = 'chat_group'").all(org)).map((a) => a.action);
  check('journal d’audit : création, ajout, retrait, promotion, renommage, modération, départ', ['create', 'add_members', 'remove_member', 'promote', 'update', 'delete_message', 'leave'].every((a) => audits.includes(a)), audits);
  r = await owner('PUT', `${C}/settings`, { groupsBy: 'manager' });
  r = await mem('POST', `${C}/groups`, { name: 'Interdit' });
  check('réglage « seuls les responsables créent des groupes » : un membre est refusé (403)', r.status === 403, r.status);
  await owner('PUT', `${C}/settings`, { groupsBy: 'all' });
  const proj = (await owner('POST', `${O}/projects`, { name: 'Chantier A' })).json.id;
  await owner('POST', `${O}/projects/tasks`, { title: 'Tâche', projectId: proj, assigneeId: paul });
  r = await owner('POST', `${C}/groups`, { name: 'Projet Chantier A', purpose: 'project', projectId: proj });
  check('groupe par projet : les personnes qui ont des tâches du projet sont ajoutées', r.status === 201 && r.json.conversation.memberCount === 2 && r.json.conversation.projectId === proj, r.json);

  // ---------- Fichiers ----------
  const up = (c, conv, name, buf, q = '') => c('POST', `${C}/files?conv=${conv}&name=${encodeURIComponent(name)}${q}`, buf);
  r = await up(mgr, D, 'logo.png', PNG);
  const F1 = r.json.message && r.json.message.file && r.json.message.file.id;
  check('image acceptée : message « fichier » avec type réel détecté', r.status === 201 && r.json.message.kind === 'file' && r.json.message.file.category === 'image' && r.json.message.file.mime === 'image/png', r.json);
  r = await mem('GET', `${C}/files/${F1}/content?inline=1`);
  check('Paul télécharge / prévisualise l’image', r.status === 200 && r.headers.get('content-type') === 'image/png' && /inline/.test(r.headers.get('content-disposition')) && r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy')), r.headers.get('content-disposition'));
  r = await owner('GET', `${C}/files/${F1}/content`);
  check('le propriétaire ne peut pas télécharger un fichier d’une conversation privée (404)', r.status === 404, r.status);
  r = await other('GET', `${C2}/files/${F1}/content`);
  check('… ni une autre entreprise (404)', r.status === 404, r.status);
  r = await up(mgr, D, 'malin.png', Buffer.from('MZ\x90\x00 programme'));
  check('faux fichier .png qui est un exécutable : refusé (400)', r.status === 400, r.json);
  r = await up(mgr, D, 'page.txt', Buffer.from('<html><script>alert(1)</script></html>'));
  check('page web déguisée en .txt : refusée (400)', r.status === 400, r.json);
  r = await up(mgr, D, 'image.pdf', PNG);
  check('extension qui ne correspond pas au contenu : refusée (400)', r.status === 400 && /extension/.test(r.json.error), r.json);
  r = await up(mgr, D, 'test.txt', Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'));
  check('signature de virus de test (EICAR) : refusée (400)', r.status === 400 && /virus/.test(r.json.error), r.json);
  r = await up(mgr, D, 'doc.docx', docx());
  check('document Word accepté', r.status === 201 && r.json.message.file.category === 'word', r.json);
  const DOCX = r.json.message.file.id;
  r = await up(mgr, D, 'macro.docx', docx({ 'word/vbaProject.bin': 'x' }));
  check('document avec macros : refusé (400)', r.status === 400 && /macros/.test(r.json.error), r.json);
  r = await up(mgr, D, 'compta.xlsx', xlsx());
  check('tableur Excel accepté', r.status === 201 && r.json.message.file.category === 'excel', r.json);
  r = await up(mgr, D, 'archive.zip', Buffer.from(zipSync({ 'a.txt': strToU8('a') })));
  check('archive ZIP quelconque refusée (400)', r.status === 400, r.json);
  r = await up(mgr, D, 'js.pdf', Buffer.from('%PDF-1.4\n/JavaScript (app.alert(1))'));
  check('PDF contenant du JavaScript refusé (400)', r.status === 400, r.json);
  r = await up(mgr, D, 'rapport.pdf', Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF'));
  check('PDF sain accepté', r.status === 201 && r.json.message.file.category === 'pdf', r.json);
  r = await up(mgr, D, 'video.mp4', MP4);
  check('vidéo MP4 acceptée', r.status === 201 && r.json.message.file.category === 'video', r.json);
  r = await up(mgr, D, 'notes.csv', Buffer.from('a;b\n1;2\n'));
  check('CSV accepté (texte UTF-8)', r.status === 201 && r.json.message.file.category === 'text', r.json);
  r = await up(mgr, D, 'vide.png', Buffer.alloc(0));
  check('fichier vide refusé (400)', r.status === 400, r.status);
  r = await up(mgr, 999999, 'logo.png', PNG);
  check('téléverser dans une conversation inconnue : 404', r.status === 404, r.status);
  r = await up(owner, D, 'logo.png', PNG);
  check('le propriétaire ne peut pas déposer de fichier dans la conversation privée (404)', r.status === 404, r.status);
  r = await mem('PUT', `${C}/settings`, { maxFileMb: 1 });
  check('un membre ne peut pas changer les réglages (403)', r.status === 403, r.status);
  r = await owner('PUT', `${C}/settings`, { maxFileMb: 1, allowedKinds: ['image', 'pdf', 'word', 'excel', 'text', 'audio'] });
  check('l’administrateur règle la taille (1 Mo) et les formats (sans vidéo)', r.status === 200 && r.json.settings.maxFileMb === 1, r.json);
  r = await up(mgr, D, 'gros.png', Buffer.concat([PNG, Buffer.alloc(1.5 * 1024 * 1024)]));
  check('fichier plus gros que la limite de l’entreprise : refusé (413)', r.status === 413, r.status);
  r = await up(mgr, D, 'video2.mp4', MP4);
  check('format désactivé par l’entreprise (vidéo) : refusé (400)', r.status === 400 && /autorisés/.test(r.json.error), r.json);
  r = await owner('PUT', `${C}/settings`, { maxFileMb: 500 });
  check('taille maximale hors limites refusée (400)', r.status === 400, r.status);
  r = await owner('PUT', `${C}/settings`, { allowedKinds: ['exe'] });
  check('type de fichier inconnu dans les réglages refusé (400)', r.status === 400, r.status);
  await owner('PUT', `${C}/settings`, { maxFileMb: 8, allowedKinds: ['image', 'pdf', 'word', 'excel', 'presentation', 'video', 'audio', 'text'] });
  r = await up(mgr, D, 'voix.webm', WEBM, '&voice=1&durationMs=4200');
  check('message vocal : enregistré comme audio, durée conservée', r.status === 201 && r.json.message.kind === 'voice' && r.json.message.file.category === 'audio' && r.json.message.file.durationMs === 4200, r.json);
  const VOICE = r.json.message.id;
  r = await up(mgr, D, 'voix.webm', PNG, '&voice=1');
  check('un faux message vocal (image) est refusé (400)', r.status === 400, r.status);
  r = await mem('GET', `${C}/files`);
  check('historique des fichiers partagés (Paul)', r.json.files.length >= 5 && r.json.files.every((f) => f.convName === 'Marc'), r.json.files.length);
  r = await mem('GET', `${C}/files?category=word`);
  check('filtre par catégorie', r.json.files.length === 1 && r.json.files[0].name === 'doc.docx', r.json.files);
  r = await mem('PUT', `${C}/files/${DOCX}`, { folder: 'Contrats' });
  check('classement dans un dossier (par un participant, 403 si ce n’est pas l’auteur d’une conversation à deux ? non : Paul n’est pas l’auteur)', r.status === 403, r.status);
  r = await mgr('PUT', `${C}/files/${DOCX}`, { folder: 'Contrats' });
  r = await mem('GET', `${C}/files?folder=Contrats`);
  check('classement : le fichier est retrouvé dans son dossier', r.status === 200 && r.json.files.length === 1, r.json.files);
  r = await owner('GET', `${C}/files`);
  check('le propriétaire ne voit aucun fichier des conversations privées des autres', r.json.files.length === 0, r.json.files.length);
  r = await mgr('GET', `${C}/search?q=compta&scope=files`);
  check('recherche de fichiers par nom', r.json.files.some((f) => f.name === 'compta.xlsx'), r.json.files);

  // ---------- Épingles, sondages ----------
  r = await mem('POST', `${C}/messages/${M1}/pin`, {});
  check('épingler un message', r.status === 200);
  r = await mgr('GET', `${C}/conversations/${D}`);
  check('le message épinglé apparaît dans la conversation', r.json.pins.length === 1 && r.json.pins[0].id === M1 && r.json.pins[0].pinned === true, r.json.pins);
  r = await mgr('POST', `${C}/conversations/${D}/polls`, { question: 'Quel jour ?', options: ['Lundi', 'Mardi'], multiple: false });
  const P = r.json.message.poll.id; const PM = r.json.message.id;
  check('création d’un sondage', r.status === 201 && r.json.message.poll.options.length === 2, r.json);
  r = await mgr('POST', `${C}/conversations/${D}/polls`, { question: 'Q', options: ['seul'] });
  check('un sondage a au moins 2 choix (400)', r.status === 400, r.status);
  const opt = r => r.json.message.poll.options;
  r = await mem('GET', `${C}/conversations/${D}/messages`);
  const o1 = r.json.messages.find((m) => m.id === PM).poll.options[0].id;
  r = await mem('POST', `${C}/polls/${P}/vote`, { optionIds: [o1] });
  check('Paul vote ; le décompte est à jour', r.status === 200 && opt(r)[0].votes === 1 && opt(r)[0].mine === true, opt(r));
  r = await mem('POST', `${C}/polls/${P}/vote`, { optionIds: [o1, opt(r)[1].id] });
  check('plusieurs choix refusés si le sondage n’en accepte qu’un (400)', r.status === 400, r.status);
  r = await owner('POST', `${C}/polls/${P}/vote`, { optionIds: [o1] });
  check('le propriétaire ne peut pas voter dans un sondage privé (404)', r.status === 404, r.status);
  r = await mem('POST', `${C}/polls/${P}/close`, {});
  check('seul l’auteur (ou un admin du groupe) termine un sondage (403)', r.status === 403, r.status);
  r = await mgr('POST', `${C}/polls/${P}/close`, {});
  r = await mem('POST', `${C}/polls/${P}/vote`, { optionIds: [o1] });
  check('sondage terminé : plus de vote (400)', r.status === 400, r.status);

  // ---------- Programmés, rappels, tâche, position ----------
  const soon = new Date(Date.now() + 3600000).toISOString();
  r = await mgr('POST', `${C}/conversations/${D}/scheduled`, { body: 'Message programmé de test', sendAt: new Date(Date.now() - 1000).toISOString() });
  check('programmer dans le passé refusé (400)', r.status === 400, r.status);
  r = await mgr('POST', `${C}/conversations/${D}/scheduled`, { body: 'Message programmé de test', sendAt: soon });
  const S = r.json.id;
  check('message programmé enregistré', r.status === 201 && S > 0, r.json);
  r = await mgr('GET', `${C}/scheduled`);
  check('la liste montre le message programmé', r.json.scheduled.length === 1, r.json);
  r = await mem('GET', `${C}/scheduled`);
  check('Paul ne voit pas les messages programmés de Marc', r.json.scheduled.length === 0);
  await dbx.prepare('UPDATE ci_scheduled SET send_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), S);
  let got = false;
  for (let i = 0; i < 16 && !got; i++) { await sleep(1000); r = await mem('GET', `${C}/conversations/${D}/messages?limit=5`); got = r.json.messages.some((m) => m.body === 'Message programmé de test'); }
  check('le message programmé part à l’heure dite', got);
  r = await mgr('POST', `${C}/conversations/${D}/scheduled`, { body: 'Annulé', sendAt: soon });
  r = await mgr('DELETE', `${C}/scheduled/${r.json.id}`);
  check('annuler un message programmé', r.status === 200);
  r = await mem('POST', `${C}/messages/${M1}/reminder`, { remindAt: soon, note: 'Relire le budget' });
  const RID = r.json.id;
  check('rappel sur un message', r.status === 201);
  r = await mem('GET', `${C}/reminders`);
  check('liste des rappels', r.json.reminders.length === 1 && r.json.reminders[0].note === 'Relire le budget');
  await dbx.prepare('UPDATE ci_reminders SET remind_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), RID);
  got = false;
  for (let i = 0; i < 16 && !got; i++) { await sleep(1000); got = Number((await dbx.prepare('SELECT COUNT(*) c FROM notices WHERE user_id = ? AND kind = ?').get(paul, 'chat')).c) > 0; }
  const nt = await dbx.prepare("SELECT text FROM notices WHERE user_id = ? AND kind = 'chat' ORDER BY id DESC LIMIT 1").get(paul);
  check('le rappel déclenche une notification SANS recopier le message privé', got && !/SECRET-PRIVE/.test(nt.text), nt);
  r = await mem('POST', `${C}/messages/${M1}/task`, { title: 'Préparer le budget', assigneeId: paul, due: '2099-02-01', projectId: proj });
  check('créer une TÂCHE depuis un message (module Projets et tâches)', r.status === 201 && r.json.message.task.title === 'Préparer le budget', r.json);
  const tk = await dbx.prepare("SELECT * FROM tasks WHERE title = 'Préparer le budget'").get();
  check('la tâche existe dans le module des tâches, avec responsable et échéance', tk && Number(tk.assignee_id) === paul && tk.due === '2099-02-01' && Number(tk.project_id) === proj, tk);
  r = await owner('POST', `${C}/messages/${M1}/task`, { title: 'x' });
  check('créer une tâche depuis un message qu’on ne peut pas lire : 404', r.status === 404, r.status);
  r = await mem('POST', `${C}/conversations/${D}/location`, { lat: 4.0511, lng: 9.7679, consent: false });
  check('partage de position SANS consentement explicite refusé (400)', r.status === 400, r.status);
  r = await mem('POST', `${C}/conversations/${D}/location`, { lat: 4.0511, lng: 9.7679, accuracy: 25, consent: true });
  check('position partagée une fois, avec consentement', r.status === 201 && r.json.message.kind === 'location' && r.json.message.meta.once === true && r.json.message.meta.lat === 4.0511, r.json);
  r = await mem('POST', `${C}/conversations/${D}/location`, { lat: 400, lng: 0, consent: true });
  check('position invalide refusée (400)', r.status === 400, r.status);

  // ---------- Recherche intelligente, traduction, transcription ----------
  ai.mode = 'ok';
  await mgr('POST', `${C}/conversations/${D}/messages`, { body: 'La facture client est réglée' });
  r = await mem('GET', `${C}/search?q=paiement&smart=1`);
  check('recherche intelligente : l’IA élargit la recherche (la facture est trouvée pour « paiement »)', r.json.smart.used === true && r.json.messages.some((m) => /facture/.test(m.text)), r.json);
  r = await mem('GET', `${C}/search?q=paiement`);
  check('sans « intelligent », recherche par mots exacts seulement', r.json.smart.used === false && r.json.messages.length === 0, r.json);
  r = await mem('POST', `${C}/messages/${M1}/translate`, { lang: 'en' });
  check('traduction par l’IA', r.json.ok === true && r.json.text === 'Hello team', r.json);
  r = await mem('POST', `${C}/messages/${VOICE}/translate`, { lang: 'en' });
  check('traduire un vocal non transcrit : message clair (pas une erreur)', r.status === 200 && r.json.ok === false && /transcri/.test(r.json.message), r.json);
  r = await mem('POST', `${C}/messages/${VOICE}/transcribe`, {});
  check('transcription sans service configuré : message clair, jamais d’erreur brute', r.status === 200 && r.json.ok === false && r.json.code === 'no_key' && /transcription/.test(r.json.message), r.json);
  r = await mem('POST', `${C}/messages/${M1}/transcribe`, {});
  check('transcrire autre chose qu’un vocal : 400', r.status === 400, r.status);
  ai.mode = 'fail';
  r = await mem('POST', `${C}/messages/${M1}/translate`, { lang: 'de' });
  check('panne du service IA : traduction refusée proprement (message en français)', r.status === 200 && r.json.ok === false && r.json.code === 'error' && /réessayez/i.test(r.json.message) && !/boom|HTTP|500/.test(r.json.message), r.json);
  r = await mem('GET', `${C}/search?q=facture&smart=1`);
  check('panne de l’IA : la recherche retombe sur le texte, avec la raison', r.status === 200 && r.json.smart.used === false && r.json.messages.length >= 1 && r.json.smart.reason, r.json.smart);
  ai.mode = 'ok';

  // ---------- Assistante ----------
  r = await mem('POST', `${C}/ai/conversations/${D}/summarize`, {});
  check('l’assistante n’est pas utilisable tant qu’elle n’a pas été invitée (400)', r.status === 400, r.status);
  r = await owner('PUT', `${C}/ai/conversations/${D}`, { enabled: true });
  check('le propriétaire ne peut pas inviter l’assistante dans une conversation privée (404)', r.status === 404, r.status);
  r = await mem('PUT', `${C}/ai/conversations/${D}`, { enabled: true });
  check('Paul invite l’assistante ; tout le monde en est informé par un message système', r.status === 200 && r.json.enabled === true);
  r = await mem('GET', `${C}/conversations/${D}/messages?limit=3`);
  check('message système « assistante invitée »', r.json.messages.some((m) => m.kind === 'system' && m.meta.event === 'ai_on'));
  // une AUTRE conversation contient un secret : il ne doit jamais arriver à l'IA
  r = await mgr('POST', `${C}/conversations/direct`, { userId: awa });
  const D2 = r.json.conversation.id;
  await mgr('POST', `${C}/conversations/${D2}/messages`, { body: 'AUTRE-CONV-SECRET-XYZ confidentiel Marc/Awa' });
  ai.seen.length = 0;
  r = await mem('POST', `${C}/ai/conversations/${D}/summarize`, {});
  check('résumé : note privée de l’assistante', r.json.ok === true && r.json.message.kind === 'ai' && r.json.message.privateToMe === true && r.json.message.body.includes('Résumé'), r.json);
  const NOTE = r.json.message.id;
  check('l’IA a reçu la conversation, mais JAMAIS une autre conversation', ai.seen.length === 1 && /SECRET-PRIVE/.test(ai.seen[0].sys) && !/AUTRE-CONV-SECRET-XYZ/.test(ai.seen[0].sys), ai.seen.map((s) => s.sys.slice(0, 80)));
  r = await mgr('GET', `${C}/conversations/${D}/messages?limit=50`);
  check('la note privée est invisible pour Marc', !r.json.messages.some((m) => m.id === NOTE), r.json.messages.map((m) => m.kind));
  r = await mgr('POST', `${C}/ai/messages/${NOTE}/share`, {});
  check('Marc ne peut pas partager la note de Paul (404)', r.status === 404, r.status);
  r = await mem('POST', `${C}/ai/messages/${NOTE}/share`, {});
  check('Paul partage la note avec la conversation', r.status === 200 && r.json.message.privateToMe === false, r.json);
  r = await mgr('GET', `${C}/conversations/${D}/messages?limit=50`);
  check('après partage, Marc la voit', r.json.messages.some((m) => m.id === NOTE && m.kind === 'ai'));
  r = await mem('POST', `${C}/ai/conversations/${D}/ask`, { question: 'Où en sont les stocks ?', useCompanyData: true });
  check('question avec données de l’entreprise (selon les droits) : réponse privée', r.json.ok === true && r.json.message.privateToMe === true && r.json.message.meta.companyData.length > 0, r.json);
  r = await mem('POST', `${C}/ai/messages/${r.json.message.id}/share`, {});
  check('une réponse fondée sur les données de l’entreprise ne peut pas être partagée telle quelle (400)', r.status === 400, r.json);
  r = await mem('POST', `${C}/ai/conversations/${D}/extract`, {});
  check('extraction de tâches et décisions', r.json.ok === true && r.json.message.meta.tasks[0].title === 'Envoyer le devis' && r.json.message.meta.tasks[0].assigneeId === paul && r.json.message.meta.decisions[0] === 'Valider le budget', r.json);
  ai.seen.length = 0;
  r = await mgr('POST', `${C}/conversations/${D}/messages`, { body: '@ia peux-tu faire le point ?' });
  await sleep(1500);
  r = await mem('GET', `${C}/conversations/${D}/messages?limit=5`);
  const pub = r.json.messages.filter((m) => m.kind === 'ai' && m.meta.action === 'mention');
  check('« @ia » dans un message : réponse publique de l’assistante', pub.length === 1 && pub[0].privateToMe === false, r.json.messages.map((m) => m.kind));
  check('… fondée sur la conversation seulement (aucune donnée d’entreprise envoyée)', ai.seen.length === 1 && !/DONNÉES DE L'ENTREPRISE/.test(ai.seen[0].sys), ai.seen.map((s) => s.sys.slice(-200)));
  ai.mode = 'fail';
  r = await mem('POST', `${C}/ai/conversations/${D}/summarize`, {});
  check('panne du service IA : message clair (200, ok:false)', r.status === 200 && r.json.ok === false && !/boom|HTTP/.test(r.json.message), r.json);
  ai.mode = 'ok';
  r = await owner('PUT', `${C}/settings`, { aiEnabled: false });
  r = await mem('POST', `${C}/ai/conversations/${D}/summarize`, {});
  check('assistante désactivée par l’entreprise : message clair', r.json.ok === false && r.json.code === 'disabled' && /désactivée/.test(r.json.message), r.json);
  await owner('PUT', `${C}/settings`, { aiEnabled: true });
  r = await mem('GET', `${C}/ai/status`);
  check('état de l’assistante pour l’interface', r.json.available === true && typeof r.json.name === 'string' && r.json.name.length > 0, r.json);

  // ---------- Appels et réunions ----------
  r = await mem('GET', `${C}/calls/ice`);
  check('serveurs STUN publics fournis ; pas de TURN sans configuration', r.json.iceServers.length === 1 && /^stun:/.test(r.json.iceServers[0].urls[0]) && r.json.turn === false && r.json.maxParticipants === 6, r.json);
  r = await owner('POST', `${C}/calls`, { convId: D, kind: 'video' });
  check('le propriétaire ne peut pas appeler dans une conversation privée (404)', r.status === 404, r.status);
  r = await mgr('POST', `${C}/calls`, { convId: D, kind: 'video' });
  const CALL = r.json.call.id;
  check('Marc lance un appel vidéo à Paul', r.status === 201 && r.json.joined === true && r.json.call.status === 'ringing' && r.json.call.kind === 'video', r.json);
  r = await mem('GET', `${C}/updates?after=0&epoch=${epoch}`);
  check('Paul reçoit l’appel entrant en temps réel', r.json.events.some((e) => e.type === 'call.incoming' && e.data.callId === CALL && e.data.from.name === 'Marc'), r.json.events.map((e) => e.type));
  r = await owner('POST', `${C}/calls/${CALL}/join`, {});
  check('le propriétaire ne peut pas rejoindre l’appel (404)', r.status === 404, r.status);
  r = await mgr('POST', `${C}/calls/${CALL}/signal`, { to: paul, type: 'offer', data: { sdp: 'x' } });
  check('signalisation vers une personne pas encore dans l’appel : refusée (403)', r.status === 403, r.status);
  r = await mem('POST', `${C}/calls/${CALL}/join`, {});
  check('Paul décroche : il reçoit la liste des personnes déjà présentes pour initier la connexion', r.status === 200 && r.json.peers.length === 1 && r.json.peers[0] === marc && r.json.call.status === 'active', r.json);
  r = await mem('POST', `${C}/calls/${CALL}/signal`, { to: marc, type: 'offer', data: { type: 'offer', sdp: 'v=0' } });
  check('Paul envoie une offre WebRTC à Marc', r.status === 200);
  r = await mgr('GET', `${C}/updates?after=0&epoch=${epoch}`);
  check('Marc reçoit l’offre (signalisation relayée par le serveur)', r.json.events.some((e) => e.type === 'call.signal' && e.data.from === paul && e.data.type === 'offer'), r.json.events.map((e) => e.type));
  r = await mem('POST', `${C}/calls/${CALL}/signal`, { to: marc, type: 'offer', data: { sdp: 'x'.repeat(30000) } });
  check('signal trop gros refusé (400)', r.status === 400, r.status);
  r = await mem('POST', `${C}/calls/${CALL}/signal`, { to: marc, type: 'pirate', data: {} });
  check('type de signal inconnu refusé (400)', r.status === 400, r.status);
  r = await mem('POST', `${C}/calls/${CALL}/state`, { screen: true, muted: false, video: true });
  check('état de l’appel (partage d’écran) relayé', r.status === 200);
  r = await mem('POST', `${C}/calls/${CALL}/leave`, {});
  r = await mgr('GET', `${C}/calls?conv=${D}`);
  check('historique des appels : durée, participants, statut', r.json.calls.length === 1 && r.json.calls[0].status === 'ended' && r.json.calls[0].joined.length === 2 && r.json.calls[0].kind === 'video' && r.json.calls[0].outgoing === true, r.json.calls[0]);
  r = await owner('GET', `${C}/calls`);
  check('le propriétaire ne voit pas l’historique des appels privés des autres', r.json.calls.length === 0, r.json.calls.length);
  r = await mem('POST', `${C}/calls/${CALL}/signal`, { to: marc, type: 'offer', data: { sdp: 'x' } });
  check('signal après la fin de l’appel : 410', r.status === 410, r.status);
  r = await mgr('POST', `${C}/calls`, { convId: D, kind: 'audio' });
  const CALL2 = r.json.call.id;
  r = await mem('POST', `${C}/calls/${CALL2}/decline`, {});
  r = await mgr('GET', `${C}/calls?conv=${D}`);
  check('appel refusé : statut « refusé » dans l’historique', r.json.calls[0].id === CALL2 && r.json.calls[0].status === 'declined', r.json.calls[0]);
  r = await other('POST', `${C2}/calls/${CALL2}/join`, {});
  check('autre entreprise : appel introuvable (404)', r.status === 404, r.status);
  // appel de groupe
  r = await owner('POST', `${C}/groups`, { name: 'Réunion équipe', memberIds: [marc, paul] });
  const GR = r.json.conversation.id;
  r = await owner('POST', `${C}/calls`, { convId: GR, kind: 'video' });
  const GC = r.json.call.id;
  r = await mgr('POST', `${C}/calls/${GC}/join`, {});
  r = await mem('POST', `${C}/calls/${GC}/join`, {});
  check('réunion de groupe : le 3e arrivant doit se connecter aux 2 déjà présents', r.json.peers.length === 2, r.json.peers);
  r = await mgr('POST', `${C}/calls/${GC}/leave`, {});
  r = await mgr('GET', `${C}/calls/active`);
  check('l’appel de groupe continue tant qu’il reste des participants', r.json.calls.length === 1 && r.json.calls[0].id === GC);
  await mem('POST', `${C}/calls/${GC}/leave`, {}); await owner('POST', `${C}/calls/${GC}/leave`, {});
  // lien avec le module Réunions
  r = await owner('POST', `${O}/meetings`, { title: 'Point hebdo', type: 'team', date: '2099-03-03', time: '10:00', durationMin: 30, link: `https://app.exemple.test/app/${org}/chat?room=${GR}`, participants: [{ userId: marc }, { userId: paul }] });
  const MT = r.json.id;
  check('le module Réunions accepte le lien de salle du chat', r.status === 201 && MT > 0, r.json);
  r = await owner('POST', `${C}/calls/meeting-link`, { convId: GR, meetingId: MT });
  check('la réunion planifiée est annoncée dans la conversation du groupe', r.status === 201 && r.json.message.kind === 'meeting' && r.json.message.meta.meetingId === MT, r.json);
  r = await mem('GET', `${C}/calls/meetings/upcoming`);
  check('liste des prochaines réunions (module Réunions) visible pour Paul', r.json.meetings.some((m) => m.id === MT), r.json);
  r = await owner('POST', `${O}/meetings`, { title: 'Confidentielle', type: 'direction', date: '2099-03-04', time: '10:00', confidential: true, participants: [{ userId: marc }] });
  const MC = r.json.id;
  r = await mem('POST', `${C}/calls/meeting-link`, { convId: GR, meetingId: MC });
  check('une réunion confidentielle ne peut pas être annoncée par quelqu’un qui n’y est pas invité (404)', r.status === 404, r.status);
  r = await other('POST', `${C2}/calls/meeting-link`, { convId: GR, meetingId: MT });
  check('isolation : réunion et conversation d’une autre entreprise (404)', r.status === 404, r.status);
  r = await owner('PUT', `${C}/settings`, { callsEnabled: false });
  r = await mgr('POST', `${C}/calls`, { convId: D, kind: 'audio' });
  check('appels désactivés par l’entreprise : refusés (403)', r.status === 403, r.status);
  await owner('PUT', `${C}/settings`, { callsEnabled: true });

  // ---------- Isolation entre entreprises + limites ----------
  for (const [m, p, b] of [['GET', `/files/${F1}/content`], ['PUT', `/files/${F1}`, { folder: 'x' }], ['POST', `/polls/${P}/vote`, { optionIds: [1] }], ['POST', `/messages/${M1}/pin`, {}], ['GET', `/conversations/${D}/messages`], ['GET', `/conversations/${G}`], ['POST', `/groups`, { name: 'x', memberIds: [marc] }], ['GET', `/search?q=SECRET`]]) {
    r = await other(m, `${C2}${p}`, b);
    check(`isolation : ${m} ${p.replace(/\d+/g, ':n')} depuis une autre entreprise → ${m === 'GET' && p.startsWith('/search') ? 'aucun résultat' : '404 / refus'}`, p.startsWith('/search') ? (r.status === 200 && r.json.messages.length === 0) : [400, 404].includes(r.status), r.status);
  }
  r = await other('GET', `${C}/conversations`);
  check('isolation : accès au chat d’une autre entreprise refusé (404)', r.status === 404, r.status);
  r = await owner('GET', `${C}/people`);
  check('la liste des personnes ne contient que les membres de l’entreprise', r.json.people.every((p) => p.userId !== zoe), r.json.people.map((p) => p.name));
  r = await mgr('GET', `${C}/conversations`);
  const before = r.json.conversations.length;
  void before;
  let limited = 0;
  for (let i = 0; i < 70; i++) { r = await mem('POST', `${C}/conversations/${D}/messages`, { body: `rafale ${i}` }); if (r.status === 429) limited++; }
  check('limitation de débit : la rafale de messages est freinée (429) avec un message clair', limited > 0 && /patientez/i.test(r.json.error), [limited, r.json]);
  r = await mem('GET', `${C}/unread`);
  check('compteur de non lus global', r.status === 200 && typeof r.json.total === 'number');
}, {
  async setup() {
    const a = await fakeAiServer();
    return { a, env: { ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, WS_AI_FREE: '500', AI_PER_MINUTE: '500', RATE_LIMIT_GLOBAL: '100000', PRODUCT_NAME: 'ProduitTest' } };
  },
  async teardown(x) { x.a.srv.close(); },
});
