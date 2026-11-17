'use strict';
// Bibliothèque : déverrouillage par mot de passe, autorisations, droits par bloc, documents, versions, corbeille, journal d'audit.
// Ligne B portée sur la couche de A (blocs de départ de A : 7 ; voir docs/fusion/matrice/bibliotheque.md pour chaque adaptation).
// Lancez-le avec : node scripts/test-library-b.js
const { run, client } = require('./lib/wave2');

const PW = 'secret123';
const pdf = (extra = '') => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n' + extra + '\n%%EOF\n');
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000000000000000')]);
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF000000000000')]);
const docx = () => Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('....[Content_Types].xml....word/document.xml....')]);
const zip = () => Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('....notes.txt....')]);

run('Bibliothèque : blocs protégés, droits, documents, corbeille, journal', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx, base }) => {
  const L = `${O}/library`; const L2 = `${ws(org2)}/library`;
  const unlock = (c, bid, pw = PW, root = L) => c('POST', `${root}/blocks/${bid}/unlock`, { password: pw });
  const up = (c, bid, name, buf, extra = '', root = L) => c('POST', `${root}/blocks/${bid}/docs?name=${encodeURIComponent(name)}${extra}`, buf);
  const past = new Date(Date.now() - 3600000).toISOString();
  let r;

  // ---------- Blocs par défaut et visibilité ----------
  r = await owner('GET', `${L}/overview`);
  // ADAPTATION : A crée 7 blocs de départ (B en créait 16). « Achats » et « Formation » (blocs de B) sont ajoutés ici comme blocs personnalisés ; slug = identifiant court ajouté à A.
  r = await owner('POST', `${L}/blocks`, { name: 'Achats' }); const achatsId = r.json.id;
  r = await owner('POST', `${L}/blocks`, { name: 'Formation', icon: 'book' }); const formationId = r.json.id;
  await owner('PUT', `${L}/blocks/${achatsId}/perms`, { roles: { member: { view: true, read: true }, manager: { view: true, read: true, add: true, edit: true } } });
  await owner('PUT', `${L}/blocks/${formationId}/perms`, { roles: { member: { view: true, read: true }, manager: { view: true, read: true, add: true, edit: true } } });
  r = await owner('GET', `${L}/overview`);
  const ids = Object.fromEntries((r.json.blocks || []).map((b) => [b.slug, b.id]));
  check('blocs de départ de A (7) + 2 blocs ajoutés, tous avec un slug', r.status === 200 && r.json.blocks.length === 9 && ids.comptabilite && ids.personnel && ids.achats && ids.formation && r.json.blocks.every((b) => b.slug), r.json.blocks && r.json.blocks.map((b) => b.slug));
  check('bandeau de statistiques présent', ['documents', 'modulesUsed', 'activeProjects', 'volume'].every((k) => typeof r.json.stats[k] === 'number'), r.json.stats);
  check('toutes les cartes démarrent verrouillées', r.json.blocks.every((b) => b.unlocked === false));
  r = await mem('GET', `${L}/overview`);
  const slugsMem = r.json.blocks.map((b) => b.slug);
  check('membre : les blocs sensibles n\'apparaissent pas', !slugsMem.includes('comptabilite') && !slugsMem.includes('rh') && !slugsMem.includes('juridique') && slugsMem.includes('commercial') && slugsMem.includes('personnel'), slugsMem);
  r = await mgr('GET', `${L}/overview`);
  check('responsable : voit aussi les blocs sensibles', r.json.blocks.length === 9);

  // ADAPTATION : « Commercial » de A laisse les membres ajouter (vra) ; B : lire seulement. On aligne le réglage de départ sur B avant les contrôles.
  r = await owner('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: { member: { view: true, read: true, add: false }, manager: { view: true, read: true, add: true, edit: true } } });

  // ---------- Verrouillage : rien sans autorisation ----------
  r = await owner('GET', `${L}/blocks/${ids.commercial}`);
  check('bloc verrouillé : contenu refusé', r.status === 403 && r.json.code === 'library_locked', [r.status, r.json]);
  r = await up(owner, ids.commercial, 'a.pdf', pdf());
  check('bloc verrouillé : envoi refusé', r.status === 403, r.status);
  r = await owner('GET', `${L}/search?q=a`);
  check('recherche sans bloc déverrouillé : aucun résultat', r.status === 200 && r.json.docs.length === 0);

  // ---------- Mot de passe : faux, blocage, neutralité ----------
  const WRONG = 'Mauvais-Mdp-XYZ-987';
  r = await unlock(mem, ids.achats, WRONG);
  check('mauvais mot de passe : refusé avec message neutre', r.status === 403 && r.json.error === 'Mot de passe incorrect.', r.json);
  check('le mot de passe saisi n\'est jamais renvoyé', !r.text.includes(WRONG));
  for (let i = 0; i < 3; i++) r = await unlock(mem, ids.achats, WRONG);
  check('4 échecs : toujours 403', r.status === 403, r.status);
  r = await unlock(mem, ids.achats, WRONG);
  check('5e échec : blocage 15 minutes (429)', r.status === 429 && /15 minutes/.test(r.json.error), r.json);
  r = await unlock(mem, ids.achats, PW);
  check('pendant le blocage, même le bon mot de passe est refusé', r.status === 429, r.status);
  r = await unlock(mem, ids.commercial, PW);
  // ADAPTATION (tranchage « le plus protecteur ») : A compte aussi les échecs de la personne tous blocs et toutes organisations confondus ; B isolait chaque bloc.
  check('blocage : suit la personne, il vaut aussi pour un autre bloc (plus protecteur que B)', r.status === 429, r.status);
  const perBlock = await dbx.prepare('SELECT COUNT(*) AS n FROM lib_attempts WHERE user_id = (SELECT id FROM users WHERE name = ?) AND block_id IN (?, 0) AND locked_until IS NOT NULL').get('Paul', ids.achats);
  check('blocage persistant : lignes lib_attempts par bloc et « tous blocs » en base', Number(perBlock.n) === 2, perBlock);
  await dbx.prepare('UPDATE lib_attempts SET locked_until = ? WHERE user_id = (SELECT id FROM users WHERE name = ?)').run(past, 'Paul');
  r = await unlock(mem, ids.achats, PW);
  check('blocage levé après le délai : le bon mot de passe passe', r.status === 200 && r.json.expiresAt, r.status);
  await mem('POST', `${L}/blocks/${ids.achats}/lock`);
  r = await unlock(mem, ids.achats, '');
  check('mot de passe vide : refusé (403 chez A : compté comme un échec)', r.status === 403, r.status); // ADAPTATION : B répondait 400
  const fails = await dbx.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action IN ('library.unlock_fail', 'library.unlock_locked')").get();
  check('échecs enregistrés au journal central (base des alertes)', Number(fails.n) >= 5, fails);
  const leak = await dbx.prepare('SELECT COUNT(*) AS n FROM lib_audit WHERE detail LIKE ? OR detail LIKE ?').get(`%${WRONG}%`, `%${PW}%`);
  const leak2 = await dbx.prepare('SELECT COUNT(*) AS n FROM audit_trail WHERE detail LIKE ? OR target LIKE ?').get(`%${WRONG}%`, `%${WRONG}%`);
  check('aucun mot de passe dans les journaux', Number(leak.n) === 0 && Number(leak2.n) === 0);
  r = await unlock(mem, ids.achats + 9999);
  check('bloc inconnu : 404', r.status === 404, r.status);
  r = await unlock(other, ids.commercial, PW, L2);
  check('isolation : un bloc d\'une autre organisation est introuvable via la sienne', r.status === 404, r.status);

  // ---------- Déverrouillage et documents ----------
  r = await unlock(owner, ids.commercial);
  check('déverrouillage réussi', r.status === 200 && r.json.ok, r.status);
  const gr = await dbx.prepare('SELECT * FROM lib_grants WHERE block_id = ? ORDER BY created_at DESC LIMIT 1').get(ids.commercial);
  const cols = Object.keys(gr).join(',');
  check('autorisation en base : liée à la personne, au bloc et à la session, sans mot de passe', gr.session_id && gr.user_id && !/pass_hash|password/.test(cols) && Date.parse(gr.expires_at) > Date.now(), cols);
  check('durée courte par défaut (15 min)', Date.parse(gr.expires_at) - Date.parse(gr.last_used_at) <= 15 * 60000 + 2000);
  r = await up(owner, ids.commercial, 'Devis client.pdf', pdf('devis'), '&tags=devis,2026');
  check('envoi d\'un PDF', r.status === 201 && r.json.name === 'Devis client.pdf', r.json);
  const d1 = r.json.id;
  r = await owner('GET', `${L}/blocks/${ids.commercial}`);
  check('liste du bloc : le document, ses étiquettes et son auteur', r.status === 200 && r.json.docs.length === 1 && r.json.docs[0].tags.includes('devis') && r.json.docs[0].author === 'Awa', r.json.docs);
  r = await owner('GET', `${L}/docs/${d1}/download`);
  check('téléchargement : mêmes octets, en pièce jointe, sans interprétation', r.status === 200 && r.buf.equals(pdf('devis')) && /attachment/.test(r.headers.get('content-disposition')) && r.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(r.headers.get('cache-control')));
  r = await owner('GET', `${L}/docs/${d1}/preview`);
  check('aperçu PDF en ligne', r.status === 200 && /inline/.test(r.headers.get('content-disposition')) && r.headers.get('content-type') === 'application/pdf', r.status);
  const dx = (await up(owner, ids.commercial, 'Contrat.docx', docx())).json.id;
  r = await owner('GET', `${L}/docs/${dx}/preview`);
  check('pas d\'aperçu pour un document Office (téléchargement seulement)', r.status === 400 || r.status === 415, r.status); // ADAPTATION : A répond 400, B 415
  const di = (await up(owner, ids.commercial, 'logo.png', png())).json.id;
  r = await owner('GET', `${L}/docs/${di}/preview`);
  check('aperçu image', r.status === 200 && r.headers.get('content-type') === 'image/png');

  // ---------- Autorisation liée à la session, expiration, renouvellement, fermeture ----------
  const owner2 = client(base);
  const contact = (await dbx.prepare('SELECT contact FROM users WHERE name = ?').get('Awa')).contact;
  r = await owner2('POST', '/api/login', { contact, pass: PW });
  check('seconde session du même compte ouverte', r.status === 200, r.status);
  r = await owner2('GET', `${L}/docs/${d1}/download`);
  check('autre session du même compte : téléchargement direct par identifiant refusé', r.status === 403 && r.json.code === 'library_locked', [r.status, r.json]);
  r = await owner2('GET', `${L}/docs/${d1}/preview`);
  check('autre session : aperçu refusé', r.status === 403);
  r = await owner2('GET', `${L}/search?q=devis`);
  check('autre session : recherche sans résultat', r.status === 200 && r.json.docs.length === 0);
  r = await owner2('GET', `${L}/docs/${d1}`);
  check('autre session : fiche refusée', r.status === 403);

  await dbx.prepare('UPDATE lib_grants SET expires_at = ? WHERE block_id = ?').run(new Date(Date.now() + 60000).toISOString(), ids.commercial);
  r = await owner('GET', `${L}/docs/${d1}`);
  const g2 = await dbx.prepare('SELECT * FROM lib_grants WHERE block_id = ? ORDER BY created_at DESC LIMIT 1').get(ids.commercial);
  check('l\'activité renouvelle l\'autorisation', r.status === 200 && Date.parse(g2.expires_at) > Date.now() + 10 * 60000, g2.expires_at);
  await dbx.prepare('UPDATE lib_grants SET hard_expires_at = ?, expires_at = ? WHERE session_id = ? AND block_id = ?').run(new Date(Date.now() + 120000).toISOString(), new Date(Date.now() + 60000).toISOString(), g2.session_id, g2.block_id);
  await owner('GET', `${L}/docs/${d1}`);
  const g3 = await dbx.prepare('SELECT * FROM lib_grants WHERE session_id = ? AND block_id = ?').get(g2.session_id, g2.block_id);
  check('le renouvellement ne dépasse jamais le plafond', Date.parse(g3.expires_at) <= Date.parse(g3.hard_expires_at), [g3.expires_at, g3.hard_expires_at]);
  await dbx.prepare('UPDATE lib_grants SET expires_at = ? WHERE session_id = ? AND block_id = ?').run(past, g2.session_id, g2.block_id);
  for (const [n, u] of [['téléchargement', `/docs/${d1}/download`], ['aperçu', `/docs/${d1}/preview`], ['fiche', `/docs/${d1}`], ['contenu du bloc', `/blocks/${ids.commercial}`], ['statistiques du bloc', `/blocks/${ids.commercial}/stats`]]) {
    r = await owner('GET', L + u);
    check(`autorisation expirée : ${n} refusé`, r.status === 403, r.status);
  }
  r = await owner('GET', `${L}/overview`);
  check('autorisation expirée : la carte redevient verrouillée', r.json.blocks.find((b) => b.id === ids.commercial).unlocked === false);
  await unlock(owner, ids.commercial);
  await dbx.prepare('UPDATE lib_grants SET hard_expires_at = ? WHERE block_id = ?').run(past, ids.commercial);
  r = await owner('GET', `${L}/docs/${d1}`);
  check('plafond dépassé : refusé même si l\'activité est récente', r.status === 403);
  await unlock(owner, ids.commercial);
  r = await owner('POST', `${L}/blocks/${ids.commercial}/lock`);
  r = await owner('GET', `${L}/docs/${d1}/download`);
  check('fermer le bloc révoque l\'autorisation', r.status === 403);
  await unlock(owner, ids.commercial);

  // déconnexion : l'autorisation tombe, une nouvelle connexion repart verrouillée
  r = await mgr('GET', `${L}/overview`);
  const mc = (await dbx.prepare('SELECT contact FROM users WHERE name = ?').get('Marc')).contact;
  const mgr2 = client(base);
  await mgr2('POST', '/api/login', { contact: mc, pass: PW });
  r = await unlock(mgr2, ids.commercial);
  check('responsable : déverrouille depuis sa session', r.status === 200);
  await mgr2('POST', '/api/logout');
  const live = await dbx.prepare('SELECT COUNT(*) AS n FROM lib_grants g JOIN users u ON u.id = g.user_id WHERE u.name = ?').get('Marc');
  check('déconnexion : autorisations révoquées en base', Number(live.n) === 0, live);
  const mgr3 = client(base);
  await mgr3('POST', '/api/login', { contact: mc, pass: PW });
  r = await mgr3('GET', `${L}/blocks/${ids.commercial}`);
  check('nouvelle connexion : le bloc est de nouveau verrouillé', r.status === 403);

  // ---------- Droits par bloc : rôle et personne ----------
  r = await up(owner, ids.comptabilite, 'bilan.pdf', pdf('bilan'));
  check('propriétaire : sans déverrouillage, même un bloc sensible reste fermé', r.status === 403, r.status); // pas encore déverrouillé
  await unlock(owner, ids.comptabilite);
  r = await up(owner, ids.comptabilite, 'bilan.pdf', pdf('bilan'));
  const dc = r.json.id;
  check('propriétaire : dépôt dans Comptabilité', r.status === 201, r.status);
  r = await unlock(mem, ids.comptabilite);
  check('membre : bloc sensible introuvable (même réponse qu\'un bloc inexistant)', r.status === 404 && r.json.error === 'Bloc introuvable.', r.json);
  r = await mem('GET', `${L}/docs/${dc}`);
  check('membre : document d\'un bloc non autorisé introuvable, sans indice', r.status === 404 && r.json.error === 'Document introuvable.', r.json);
  r = await mem('GET', `${L}/docs/${dc}/download`);
  check('membre : téléchargement direct par identifiant refusé', r.status === 404);
  r = await mem('GET', `${L}/docs/987654`);
  check('identifiant inexistant : même message', r.status === 404 && r.json.error === 'Document introuvable.');
  r = await mem('GET', `${L}/audit`);
  check('droits : le journal est réservé aux administrateurs', r.status === 403);
  r = await mem('PUT', `${L}/blocks/${ids.comptabilite}/perms`, { roles: { member: { view: true, read: true } } });
  check('droits : un membre ne règle pas les droits', r.status === 403);

  await unlock(mgr, ids.comptabilite);
  r = await mgr('GET', `${L}/docs/${dc}/download`);
  check('responsable : lit un bloc sensible', r.status === 200);
  r = await up(mgr, ids.comptabilite, 'x.pdf', pdf('x'));
  check('responsable : n\'ajoute pas dans Comptabilité par défaut', r.status === 403 && /ne permet pas/.test(r.json.error), r.json);
  r = await mgr('DELETE', `${L}/docs/${dc}`);
  check('responsable : ne supprime pas', r.status === 403);

  // règle par rôle : le membre peut lire, pas ajouter
  await unlock(mem, ids.commercial);
  r = await up(mem, ids.commercial, 'm.pdf', pdf('m'));
  check('membre : lit mais n\'ajoute pas dans Commercial', r.status === 403, r.status);
  r = await owner('GET', `${L}/blocks/${ids.commercial}/perms`);
  check('propriétaire : lit les droits du bloc', r.status === 200 && r.json.roles.member.read === true && r.json.roles.member.add === false && r.json.members.length === 3, r.json);
  // exception personnelle : Paul peut ajouter ; Marc n'a plus aucun accès
  const pid = r.json.members.find((m) => m.name === 'Paul').userId; const mid = r.json.members.find((m) => m.name === 'Marc').userId;
  r = await owner('PUT', `${L}/blocks/${ids.commercial}/perms`, { users: [{ userId: pid, view: true, read: true, add: true }, { userId: mid }] });
  check('exceptions personnelles enregistrées', r.status === 200, r.json);
  r = await up(mem, ids.commercial, 'm.pdf', pdf('m'), '&tags=membre');
  check('personne : ajout autorisé par exception', r.status === 201, r.json);
  const dm = r.json.id;
  r = await mgr('GET', `${L}/blocks/${ids.commercial}`);
  check('personne : retrait total pour Marc → bloc introuvable', r.status === 404, r.status);
  r = await mgr('GET', `${L}/docs/${d1}/download`);
  check('personne : retrait total → document introuvable aussi', r.status === 404);
  r = await mgr('GET', `${L}/overview`);
  check('personne : le bloc a disparu de ses cartes', !r.json.blocks.some((b) => b.id === ids.commercial));
  r = await owner('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: { member: { view: true, read: true, add: false } }, users: [] });
  r = await mem('DELETE', `${L}/docs/${dm}`);
  check('membre : ne supprime pas', r.status === 403);
  r = await up(mem, ids.commercial, 'm2.pdf', pdf('m2'));
  check('exception retirée : le membre n\'ajoute plus', r.status === 403);
  // valeurs invalides
  r = await owner('PUT', `${L}/blocks/${ids.commercial}/perms`, { users: [{ userId: 999999, view: true }] });
  check('exception pour une personne inconnue refusée', r.status === 400, r.status);
  r = await other('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: {} });
  check('isolation : autre organisation sans accès aux droits', r.status === 404);
  // changement de droits effectif aussitôt, même avec autorisation ouverte
  await owner('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: { member: { view: false, read: false } } });
  r = await mem('GET', `${L}/docs/${d1}/download`);
  check('retrait du droit : effet immédiat malgré l\'autorisation ouverte', r.status === 404, r.status);
  await owner('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: { member: { view: true, read: true } } });

  // ---------- Dossiers personnels : privés ----------
  await unlock(owner, ids.personnel); await unlock(mgr, ids.personnel);
  r = await up(owner, ids.personnel, 'contrat perso.pdf', pdf('perso'));
  const dp = r.json.id;
  check('dossier personnel : dépôt', r.status === 201);
  r = await mgr('GET', `${L}/blocks/${ids.personnel}`);
  check('dossier personnel : un collègue ne voit pas ces documents', r.status === 200 && r.json.docs.length === 0, r.json.docs);
  r = await mgr('GET', `${L}/docs/${dp}/download`);
  check('dossier personnel : téléchargement direct par un collègue refusé', r.status === 404);
  r = await mgr('GET', `${L}/search?q=perso`);
  check('dossier personnel : absent de la recherche d\'un collègue', r.json.docs.length === 0);
  r = await owner('GET', `${L}/search?q=perso`);
  check('dossier personnel : présent dans la recherche du titulaire', r.json.docs.length === 1);
  r = await owner('PUT', `${L}/blocks/${ids.personnel}/perms`, { roles: { member: { view: true } } });
  check('dossier personnel : droits non modifiables', r.status === 400);
  r = await owner('GET', `${L}/overview`);
  check('dossier personnel : compteur limité à ses propres documents', r.json.blocks.find((b) => b.id === ids.personnel).docCount === 1);
  r = await mgr('GET', `${L}/overview`);
  check('dossier personnel : compteur du collègue = 0', r.json.blocks.find((b) => b.id === ids.personnel).docCount === 0);

  // ---------- Isolation entre organisations ----------
  await other('GET', `${L2}/overview`);
  r = await other('GET', `${L2}/docs/${d1}`);
  check('isolation : document d\'une autre organisation introuvable', r.status === 404, r.status);
  r = await other('GET', `${L2}/docs/${d1}/download`);
  check('isolation : téléchargement d\'un document d\'une autre organisation refusé', r.status === 404);
  r = await other('GET', `${L}/overview`);
  check('isolation : l\'autre organisation n\'accède pas à celle-ci', r.status === 404);
  const o2 = (await other('GET', `${L2}/overview`)).json.blocks.find((b) => b.slug === 'commercial').id;
  await unlock(other, o2, PW, L2);
  r = await other('GET', `${L2}/search?q=devis`);
  check('isolation : la recherche ne voit pas les documents d\'une autre organisation', r.json.docs.length === 0);
  r = await other('GET', `${L2}/blocks/${ids.commercial}`);
  check('isolation : un bloc d\'une autre organisation est introuvable', r.status === 404);

  // ---------- Fichiers falsifiés, noms, tailles ----------
  const bad = async (name, buf, msg) => { const x = await up(owner, ids.commercial, name, buf); check(msg, x.status === 400, [x.status, x.json]); };
  await bad('faux.pdf', Buffer.from('<html><script>alert(1)</script></html>'), 'page web renommée .pdf refusée');
  await bad('faux.pdf', Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000\u0004\u0000\u0000\u0000', 'latin1'), 'exécutable renommé .pdf refusé');
  await bad('virus.exe', pdf(), 'extension dangereuse refusée même avec un contenu PDF');
  await bad('page.html', Buffer.from('<html><body>x</body></html>'), 'fichier HTML refusé');
  // ADAPTATION : B refusait une extension qui ne correspond pas au contenu ; A (testé par test-library.js) accepte et corrige : le type et l'extension suivent TOUJOURS le contenu réel.
  r = await up(owner, ids.commercial, 'image.png', pdf('renomme'));
  check('PDF renommé .png : type et extension suivent le contenu (application/pdf, image.pdf)', r.status === 201 && r.json.mime === 'application/pdf' && r.json.name === 'image.pdf', r.json);
  await bad('texte.pdf', Buffer.from('juste du texte qui se fait passer pour un pdf'), 'texte renommé .pdf refusé');
  // ADAPTATION : B refusait tout ZIP non Office ; A accepte les archives (type application/zip, servies seulement en pièce jointe, jamais interprétées).
  r = await up(owner, ids.commercial, 'archive.zip', zip());
  check('ZIP quelconque : accepté comme archive, téléchargement forcé', r.status === 201 && r.json.mime === 'application/zip', r.json);
  r = await owner('GET', `${L}/docs/${r.json.id}/preview`);
  check('ZIP : aucun aperçu en ligne', r.status === 400 || r.status === 415, r.status);
  await bad('dessin.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), 'SVG refusé');
  await bad('vide.pdf', Buffer.alloc(0), 'fichier vide refusé');
  r = await up(owner, ids.commercial, '../../etc/passwd.pdf', pdf('t'));
  check('traversée de chemin : le nom est réduit au nom de fichier', r.status === 201 && r.json.name === 'passwd.pdf', r.json);
  r = await up(owner, ids.commercial, 'a\\b\\c:rapport"x.pdf', pdf('t2'));
  check('nom avec séparateurs et guillemets assaini', r.status === 201 && !/[\\/":]/.test(r.json.name), r.json);
  const tid = r.json.id;
  r = await owner('GET', `${L}/docs/${tid}/download`);
  check('en-tête Content-Disposition sans injection', !/[\r\n]/.test(r.headers.get('content-disposition')) && /filename\*=UTF-8''/.test(r.headers.get('content-disposition')), r.headers.get('content-disposition'));
  r = await up(owner, ids.commercial, 'note', Buffer.from('compte rendu de réunion en texte'));
  check('texte sans extension : extension .txt d\'après le contenu', r.status === 201 && r.json.name === 'note.txt', r.json);
  r = await up(owner, ids.commercial, 'photo', jpg());
  check('JPEG sans extension : .jpg d\'après le contenu', r.status === 201 && r.json.name === 'photo.jpg', r.json);
  const big = Buffer.concat([pdf(), Buffer.alloc(6 * 1024 * 1024, 65)]);
  r = await up(owner, ids.commercial, 'gros.pdf', big);
  check('fichier trop gros pour l\'offre (5 Mo) : 413', r.status === 413, r.status);
  r = await owner('POST', `${L}/blocks/${ids.commercial}/docs?name=x.pdf&folderId=99999`, pdf());
  check('dossier inconnu refusé', r.status === 404, r.status);
  r = await owner('POST', `${L}/blocks/${ids.commercial}/docs?name=x.pdf&linkType=project&linkId=99999`, pdf());
  check('lien vers un projet inexistant refusé', r.status === 400, r.status);

  // ---------- Quota de l'offre ----------
  await dbx.prepare('INSERT INTO lib_versions (org_id, doc_id, n, name, mime, size, data, created_by, created_at) VALUES (?, ?, 99, ?, ?, ?, ?, 1, ?)').run(org, d1, 'fantome.pdf', 'application/pdf', 50 * 1024 * 1024 - 1000, Buffer.from('x'), new Date().toISOString());
  r = await up(owner, ids.commercial, 'quota.pdf', pdf('un peu plus que le reste de la place disponible'.repeat(40)));
  check('quota de l\'offre atteint : envoi refusé avec message clair', r.status === 403 && /Espace de la bibliothèque plein/.test(r.json.error), r.json);
  await dbx.prepare('DELETE FROM lib_versions WHERE doc_id = ? AND n = 99').run(d1);
  r = await up(owner, ids.commercial, 'quota.pdf', pdf('ok'));
  check('quota libéré : envoi accepté', r.status === 201);

  // ---------- Versions ----------
  r = await owner('POST', `${L}/docs/${d1}/versions?note=${encodeURIComponent('Remise de 5 %')}`, pdf('devis v2'));
  check('nouvelle version', r.status === 201 && r.json.version === 2, r.json);
  r = await owner('GET', `${L}/docs/${d1}`);
  check('fiche : 2 versions, notes et auteur', r.json.versions.length === 2 && r.json.versions[0].note === 'Remise de 5 %' && r.json.doc.version === 2 && r.json.versions[0].author === 'Awa', r.json.versions);
  r = await owner('GET', `${L}/docs/${d1}/download`);
  check('téléchargement : la version actuelle', r.buf.equals(pdf('devis v2')));
  r = await owner('GET', `${L}/docs/${d1}/download?version=1`);
  check('téléchargement : l\'ancienne version', r.buf.equals(pdf('devis')));
  r = await owner('POST', `${L}/docs/${d1}/versions`, png());
  check('nouvelle version : le contenu doit correspondre au nom du document', r.status === 400, r.status);
  r = await owner('POST', `${L}/docs/${d1}/versions/1/restore`, {});
  check('rétablir une version crée la version suivante', r.status === 200 && r.json.version === 3, r.json);
  r = await owner('GET', `${L}/docs/${d1}/download`);
  check('version rétablie : contenu de la version 1', r.buf.equals(pdf('devis')));
  r = await owner('DELETE', `${L}/docs/${d1}/versions/3`);
  check('la version actuelle ne se supprime pas', r.status === 400);
  r = await owner('DELETE', `${L}/docs/${d1}/versions/2`);
  check('suppression d\'une ancienne version', r.status === 200);
  r = await owner('GET', `${L}/docs/${d1}/download?version=2`);
  check('version supprimée : introuvable', r.status === 404);
  r = await mem('POST', `${L}/docs/${d1}/versions`, pdf('par membre'));
  check('droits : un membre n\'ajoute pas de version', r.status === 403);
  r = await owner('POST', `${L}/blocks/${ids.achats}/docs?name=v.pdf`, pdf('v'));
  await unlock(owner, ids.achats);
  const dv = (await up(owner, ids.achats, 'v.pdf', pdf('v0'))).json.id;
  let last;
  for (let i = 1; i < 20; i++) last = await owner('POST', `${L}/docs/${dv}/versions`, pdf('v' + i));
  check('20 versions possibles', last.status === 201 && last.json.version === 20, last.json);
  r = await owner('POST', `${L}/docs/${dv}/versions`, pdf('v21'));
  check('21e version refusée', r.status === 403, r.json);

  // ---------- Métadonnées, étiquettes, favoris, récents, recherche ----------
  r = await owner('PUT', `${L}/docs/${d1}`, { name: 'Devis Alpha', tags: ['Devis', 'alpha', 'DEVIS'] });
  check('renommer et étiqueter (l\'extension suit le contenu)', r.status === 200 && r.json.name === 'Devis Alpha.pdf', r.json);
  r = await owner('GET', `${L}/search?q=alpha`);
  check('recherche par nom', r.json.docs.length === 1 && r.json.docs[0].block.name === 'Commercial', r.json);
  r = await owner('GET', `${L}/search?tag=devis`);
  check('recherche par étiquette (sans doublon de casse)', r.json.docs.length === 1 && r.json.docs[0].tags.filter((t) => t.toLowerCase() === 'devis').length === 1, r.json.docs[0] && r.json.docs[0].tags); // ADAPTATION : A garde la casse saisie (B passait en minuscules)
  r = await owner('GET', `${L}/search?q=${encodeURIComponent('%')}`);
  check('recherche : le caractère % est littéral', r.json.docs.length === 0, r.json.docs.length);
  r = await owner('GET', `${L}/search?q=quota`);
  check('recherche : trouve plusieurs blocs déverrouillés', r.json.docs.length >= 1);
  await owner('POST', `${L}/blocks/${ids.achats}/lock`);
  r = await owner('GET', `${L}/search?q=v`);
  check('recherche : exclut les blocs refermés', r.json.docs.every((x) => x.block.id !== ids.achats), r.json.docs.map((x) => x.block.name));
  r = await owner('POST', `${L}/docs/${d1}/favorite`, { on: true });
  check('favori ajouté', r.status === 200);
  r = await owner('GET', `${L}/favorites`);
  check('liste des favoris', r.json.docs.length === 1 && r.json.docs[0].favorite === true);
  r = await owner('GET', `${L}/recent`);
  check('récents : au moins un document, le plus récent d\'abord', r.json.docs.length >= 1);
  await owner('POST', `${L}/blocks/${ids.commercial}/lock`);
  r = await owner('GET', `${L}/favorites`);
  check('favoris : masqués quand le bloc est refermé', r.json.docs.length === 0);
  await unlock(owner, ids.commercial);
  r = await owner('POST', `${L}/docs/${d1}/favorite`, { on: false });
  r = await owner('GET', `${L}/favorites`);
  check('favori retiré', r.json.docs.length === 0);

  // ---------- Dossiers ----------
  r = await owner('POST', `${L}/blocks/${ids.commercial}/folders`, { name: 'Clients 2026' });
  const f1 = r.json.id;
  check('création d\'un dossier', r.status === 201);
  r = await owner('POST', `${L}/blocks/${ids.commercial}/folders`, { name: 'Alpha', parentId: f1 });
  const f2 = r.json.id;
  check('sous-dossier', r.status === 201);
  r = await up(owner, ids.commercial, 'dans-alpha.pdf', pdf('alpha'), `&folderId=${f2}`);
  const dfa = r.json.id;
  r = await owner('GET', `${L}/blocks/${ids.commercial}?folderId=${f2}`);
  check('contenu d\'un sous-dossier et fil d\'Ariane', r.json.docs.length === 1 && r.json.breadcrumbs.length === 2 && r.json.breadcrumbs[1].name === 'Alpha', r.json.breadcrumbs);
  r = await owner('GET', `${L}/blocks/${ids.commercial}`);
  check('racine : dossier avec compteur, document du sous-dossier absent', r.json.folders.some((f) => f.name === 'Clients 2026' && f.subfolders === 1) && !r.json.docs.some((d) => d.name === 'dans-alpha.pdf'));
  r = await owner('DELETE', `${L}/folders/${f2}`);
  check('dossier non vide : suppression refusée', r.status === 400);
  r = await mem('POST', `${L}/blocks/${ids.commercial}/folders`, { name: 'Intrus' });
  check('droits : un membre ne crée pas de dossier', r.status === 403);
  r = await owner('PUT', `${L}/docs/${dfa}`, { folderId: null });
  check('déplacer un document à la racine', r.status === 200);
  r = await owner('DELETE', `${L}/folders/${f2}`); check('sous-dossier vide supprimé', r.status === 200);
  r = await owner('DELETE', `${L}/folders/${f1}`); check('dossier vide supprimé', r.status === 200);

  // ---------- Corbeille ----------
  r = await owner('DELETE', `${L}/docs/${dfa}`);
  check('mise à la corbeille', r.status === 200);
  r = await owner('GET', `${L}/blocks/${ids.commercial}`);
  check('document supprimé : absent de la liste', !r.json.docs.some((d) => d.id === dfa));
  r = await owner('GET', `${L}/docs/${dfa}/download`);
  check('document en corbeille : pas de téléchargement', r.status === 404);
  r = await owner('GET', `${L}/trash`);
  check('corbeille : document listé avec le délai restant', r.json.docs.some((d) => d.id === dfa && d.daysLeft >= 29));
  r = await owner('POST', `${L}/docs/${dfa}/restore`, {});
  check('restauration', r.status === 200);
  r = await owner('GET', `${L}/blocks/${ids.commercial}`);
  check('document restauré : de retour dans la liste', r.json.docs.some((d) => d.id === dfa));
  await owner('DELETE', `${L}/docs/${dfa}`);
  await dbx.prepare('UPDATE lib_docs SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86400000).toISOString(), dfa);
  r = await owner('GET', `${L}/trash`);
  check('plus de 30 jours : supprimé définitivement', !r.json.docs.some((d) => d.id === dfa));
  const gone = await dbx.prepare('SELECT COUNT(*) AS n FROM lib_docs d WHERE d.id = ?').get(dfa);
  const goneV = await dbx.prepare('SELECT COUNT(*) AS n FROM lib_versions WHERE doc_id = ?').get(dfa);
  check('suppression définitive : document et versions effacés', Number(gone.n) === 0 && Number(goneV.n) === 0);
  r = await mem('POST', `${L}/docs/${d1}/restore`, {});
  check('droits : un membre ne restaure pas', r.status === 403 || r.status === 404);
  await owner('DELETE', `${L}/docs/${tid}`);
  r = await owner('DELETE', `${L}/docs/${tid}/purge`);
  check('suppression définitive volontaire', r.status === 200);
  r = await owner('DELETE', `${L}/docs/${d1}/purge`);
  check('suppression définitive impossible hors corbeille', r.status === 404);

  // ---------- Liens avec un projet ----------
  r = await owner('POST', `${O}/projects`, { name: 'Projet Alpha' });
  const pj = r.json.id || (r.json.project && r.json.project.id);
  r = await up(owner, ids.commercial, 'cahier.pdf', pdf('cahier'), `&linkType=project&linkId=${pj}`);
  check('document lié à un projet', r.status === 201, r.json);
  r = await owner('GET', `${L}/search?linkType=project&linkId=${pj}`);
  check('documents d\'un projet (blocs déverrouillés)', r.json.docs.length === 1 && r.json.docs[0].linkType === 'project', r.json);
  const pj2 = (await other('POST', `${ws(org2)}/projects`, { name: 'Projet étranger' })).json.id;
  r = await up(owner, ids.commercial, 'cahier2.pdf', pdf('cahier2'), `&linkType=project&linkId=${pj2}`);
  check('isolation : lien vers le projet d\'une autre organisation refusé', r.status === 400, r.status);

  // ---------- Statistiques ----------
  r = await owner('GET', `${L}/blocks/${ids.commercial}/stats`);
  check('statistiques détaillées d\'un bloc déverrouillé', r.status === 200 && r.json.documents >= 5 && r.json.volume > 0 && r.json.byType.length >= 2 && r.json.byAuthor[0].author, r.json);
  r = await mem('GET', `${L}/blocks/${ids.achats}/stats`);
  check('statistiques détaillées : refusées sans déverrouillage', r.status === 403);
  r = await owner('GET', `${L}/overview`);
  check('bandeau : documents, modules utilisés, projet actif, volume', r.json.stats.documents >= 6 && r.json.stats.modulesUsed >= 3 && r.json.stats.activeProjects === 1 && r.json.stats.volume > 0, r.json.stats);

  // ---------- Gestion des blocs ----------
  r = await owner('POST', `${L}/blocks`, { name: 'Brevets', color: '#112233', icon: 'star' });
  const cb = r.json.id;
  check('ajout d\'un bloc personnalisé', r.status === 201);
  r = await owner('POST', `${L}/blocks`, { name: 'Mauvais', color: 'rouge' });
  check('couleur invalide refusée', r.status === 400);
  r = await owner('POST', `${L}/blocks`, { name: 'Mauvais', icon: 'pirate' });
  check('icône inconnue refusée', r.status === 400);
  r = await mem('POST', `${L}/blocks`, { name: 'Intrus' });
  check('un membre n\'ajoute pas de bloc', r.status === 403);
  r = await owner('PUT', `${L}/blocks/${ids.formation}`, { name: 'Formation interne', hidden: true });
  check('renommer et masquer', r.status === 200);
  r = await mem('GET', `${L}/overview`);
  check('bloc masqué : absent pour un membre', !r.json.blocks.some((b) => b.slug === 'formation') && r.json.blocks.some((b) => b.slug === 'commercial'));
  r = await owner('GET', `${L}/overview`);
  check('bloc masqué : visible de l\'administrateur, avec son nouveau nom', r.json.blocks.some((b) => b.slug === 'formation' && b.hidden && b.name === 'Formation interne'));
  r = await mem('GET', `${L}/blocks/${ids.formation}`);
  check('bloc masqué : introuvable pour un membre', r.status === 404);
  r = await owner('DELETE', `${L}/blocks/${ids.commercial}`);
  check('un bloc de départ ne se supprime pas', r.status === 400);
  await unlock(owner, cb);
  const dcb = (await up(owner, cb, 'brevet.pdf', pdf('brevet'))).json.id;
  r = await owner('DELETE', `${L}/blocks/${cb}`);
  check('bloc non vide : suppression refusée', r.status === 400);
  await owner('DELETE', `${L}/docs/${dcb}`); await owner('DELETE', `${L}/docs/${dcb}/purge`);
  r = await owner('DELETE', `${L}/blocks/${cb}`);
  check('bloc personnalisé vide supprimé', r.status === 200);

  // ---------- Réglages de sécurité ----------
  r = await owner('PUT', `${L}/settings`, { grantMinutes: 2 });
  check('durée d\'autorisation : minimum 5 minutes', r.status === 400);
  r = await owner('PUT', `${L}/settings`, { grantMinutes: 30, grantMaxMinutes: 20 });
  check('plafond inférieur à la durée refusé', r.status === 400);
  r = await mem('PUT', `${L}/settings`, { grantMinutes: 10 });
  check('un membre ne règle pas la sécurité', r.status === 403);
  r = await owner('PUT', `${L}/settings`, { grantMinutes: 5, grantMaxMinutes: 30 });
  check('réglages enregistrés', r.status === 200 && r.json.settings.grantMinutes === 5);
  await owner('POST', `${L}/blocks/${ids.commercial}/lock`);
  r = await unlock(owner, ids.commercial);
  check('durée réglée : l\'autorisation dure 5 minutes', Math.abs(Date.parse(r.json.expiresAt) - Date.now() - 5 * 60000) < 15000, r.json.expiresAt);
  r = await owner('PUT', `${L}/settings`, { grantMinutes: 15, grantMaxMinutes: 120 });

  // ---------- Administrateur : droits des administrateurs réservés au propriétaire ----------
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND role = 'manager'").run(org);
  r = await mgr('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: { member: { view: true, read: true, add: true } } });
  check('administrateur : règle les droits des membres', r.status === 200, r.json);
  r = await mgr('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: { admin: { view: false } } });
  check('administrateur : ne touche pas aux droits des administrateurs', r.status === 403);
  // exception d'un autre administrateur posée par le propriétaire : conservée quand un administrateur enregistre
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND user_id = ?").run(org, pid);
  await owner('PUT', `${L}/blocks/${ids.commercial}/perms`, { users: [{ userId: pid, view: true, read: true }] });
  r = await mgr('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: { member: { view: true, read: true } }, users: [{ userId: pid, view: true, read: true, add: true, edit: true, delete: true }] });
  const keep = await dbx.prepare("SELECT p_add FROM lib_user_perms WHERE block_id = ? AND user_id = ?").get(ids.commercial, pid);
  check('administrateur : l\'exception d\'un autre administrateur n\'est pas modifiée', r.status === 200 && Number(keep.p_add) === 0, keep);
  await dbx.prepare("UPDATE org_members SET role = 'member' WHERE org_id = ? AND user_id = ?").run(org, pid);
  await owner('PUT', `${L}/blocks/${ids.commercial}/perms`, { roles: { member: { view: true, read: true } }, users: [] });

  // ---------- Journal d'audit ----------
  r = await owner('GET', `${L}/audit?limit=300`);
  const acts = new Set(r.json.entries.map((e) => e.action));
  check('audit : consultable par le propriétaire', r.status === 200 && r.json.entries.length > 20);
  // ADAPTATION : noms d'actions de A (B : unlock_ok, add, delete, block_add, block_edit, trash_auto) ; le filtre accepte aussi les noms de B.
  await dbx.prepare("INSERT INTO lib_audit (org_id, block_id, block_name, user_id, action, detail, ip, at) VALUES (?, NULL, '', NULL, 'auto_purge', 'x', '', ?)").run(org, new Date().toISOString());
  r = await owner('GET', `${L}/audit?limit=300`);
  const acts2 = new Set(r.json.entries.map((e) => e.action));
  for (const a of ['unlock', 'unlock_fail', 'unlock_locked', 'lock', 'open', 'upload', 'download', 'preview', 'view_doc', 'trash', 'restore', 'purge', 'version', 'perms', 'block_create', 'block_update', 'settings', 'denied', 'auto_purge']) check(`audit : action « ${a} » journalisée`, acts2.has(a), [...acts2]);
  r = await owner('GET', `${L}/audit?action=unlock_ok`);
  check('audit : le filtre accepte aussi les noms d\'actions de B (unlock_ok = unlock)', r.status === 200 && r.json.entries.length >= 1 && r.json.entries.every((e) => e.action === 'unlock'), r.status);
  r = await mgr('GET', `${L}/audit?action=unlock_fail`);
  check('audit : administrateur filtre par action', r.status === 200 && r.json.entries.length >= 4 && r.json.entries.every((e) => e.action === 'unlock_fail' && e.user === 'Paul'), r.json.entries.length);
  r = await owner('GET', `${L}/audit?blockId=${ids.personnel}&limit=50`);
  check('audit : les dossiers personnels n\'exposent aucun nom de document', r.json.entries.length > 0 && r.json.entries.filter((e) => ['upload', 'download', 'view_doc'].includes(e.action)).every((e) => e.detail === ''), r.json.entries.map((e) => e.detail));
  const all = JSON.stringify((await owner('GET', `${L}/audit?limit=300`)).json);
  check('audit : jamais de mot de passe', !all.includes(WRONG) && !all.includes(PW));
  r = await owner('GET', `${L}/audit?action=piratage`);
  check('audit : action inconnue refusée', r.status === 400);
  r = await other('GET', `${L2}/audit`);
  check('audit : l\'autre organisation ne voit que son propre journal', r.status === 200 && r.json.entries.every((e) => e.block !== 'Commercial' || e.userId !== null) && !JSON.stringify(r.json).includes('Devis'), r.json.entries.length);

  // ---------- Changement de mot de passe : révoque les autorisations ----------
  await unlock(mem, ids.commercial);
  r = await mem('GET', `${L}/blocks/${ids.commercial}`);
  check('avant changement de mot de passe : bloc ouvert', r.status === 200);
  r = await mem('POST', '/api/me/password', { current: PW, pass: 'Nouveau-Mdp-2026!x' });
  check('mot de passe changé', r.status === 200, r.json);
  r = await mem('GET', `${L}/blocks/${ids.commercial}`);
  check('changement de mot de passe : les blocs ouverts sont refermés', r.status === 403, r.status);
  r = await unlock(mem, ids.commercial, PW);
  check('ancien mot de passe refusé', r.status === 403);
  r = await unlock(mem, ids.commercial, 'Nouveau-Mdp-2026!x');
  check('nouveau mot de passe accepté', r.status === 200, r.json);
  const stale = await dbx.prepare('SELECT COUNT(*) AS n FROM lib_grants g JOIN users u ON u.id = g.user_id WHERE u.name = ? AND g.pass_stamp IS NOT NULL AND g.pass_stamp <> COALESCE(u.pass_changed_at, \'\')').get('Paul');
  check('changement de mot de passe : aucune autorisation d\'avant le changement ne subsiste (sessions fermées)', Number(stale.n) === 0, stale);

  // ---------- AJOUTS DE LA FUSION : aucune route de documents ne sert un bloc verrouillé (autre session du propriétaire) ----------
  await owner('POST', `${L}/docs/${d1}/favorite`, { on: true });
  await owner('GET', `${L}/docs/${d1}`); // alimente « récents »
  await owner('DELETE', `${L}/docs/${dm}`).catch(() => null);
  const dTrash = (await up(owner, ids.commercial, 'a-jeter.pdf', pdf('jeter'))).json.id;
  await owner('DELETE', `${L}/docs/${dTrash}`);
  const locked = [
    ['GET', `/docs/${d1}`], ['GET', `/docs/${d1}/download`], ['GET', `/docs/${d1}/download?version=1`], ['GET', `/docs/${d1}/preview`], ['GET', `/docs/${d1}/preview?version=1`],
    ['PUT', `/docs/${d1}`, { name: 'pirate' }], ['DELETE', `/docs/${d1}`], ['POST', `/docs/${d1}/favorite`, { on: true }], ['POST', `/docs/${d1}/versions`, pdf('x')],
    ['POST', `/docs/${d1}/versions/1/restore`, {}], ['DELETE', `/docs/${d1}/versions/1`], ['POST', `/docs/${dTrash}/restore`, {}], ['DELETE', `/docs/${dTrash}/purge`],
    ['GET', `/blocks/${ids.commercial}`], ['GET', `/blocks/${ids.commercial}/stats`], ['POST', `/blocks/${ids.commercial}/folders`, { name: 'x' }], ['POST', `/blocks/${ids.commercial}/docs?name=z.pdf`, pdf('z')],
  ];
  for (const [m, u, body] of locked) {
    const x = await owner2(m, L + u, body);
    check(`autre session, bloc verrouillé : ${m} ${u.replace(/\/\d+/g, '/:id').split('?')[0]}${u.includes('version=') ? '?version' : ''} refusé (403, library_locked)`, x.status === 403 && x.json && x.json.code === 'library_locked' && !x.buf.includes(Buffer.from('%PDF-')), [x.status, x.json]);
  }
  for (const u of ['/favorites', '/recent', '/trash', '/search?q=Devis', '/search?tag=devis', `/search?linkType=project&linkId=${pj}`]) {
    const x = await owner2('GET', L + u);
    check(`autre session, bloc verrouillé : GET ${u.split('?')[0]} sans aucun document`, x.status === 200 && x.json.docs.length === 0, x.json);
  }
  check('même requêtes depuis la session qui a ouvert le bloc : le contenu est bien servi', (await owner('GET', `${L}/favorites`)).json.docs.length >= 1 && (await owner('GET', `${L}/trash`)).json.docs.some((x) => x.id === dTrash));

  // ---------- Limitation persistante des essais et alerte du journal central ----------
  const persisted = await dbx.prepare('SELECT COUNT(*) AS n FROM lib_attempts').get();
  check('lib_attempts : les compteurs d\'essais sont conservés en base', Number(persisted.n) >= 1, persisted);
  const port = (await dbx.prepare('SHOW port').get()).port;
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `postgres://postgres:test@127.0.0.1:${port}/mia`, JWT_SECRET: 'secret-de-test-assez-long-123456', ALERT_LIBRARY_FAILS: '5' });
  const mainDb = require('../src/db').db; await mainDb.ready;
  const alerts = require('../src/services/alerts');
  const made = await alerts.scan();
  const al = await dbx.prepare("SELECT title, severity FROM admin_alerts WHERE kind = 'library_fails'").all();
  // `made` n'est pas exigé : le balayage automatique des alertes (tâche de fond du serveur) peut avoir créé l'alerte juste avant ce balayage, surtout sous charge ;
  // ce qui compte est qu'une seule alerte existe, de gravité haute, au nom de la personne.
  check('alerte « library_fails » : créée à partir des échecs écrits dans le journal central par la Bibliothèque de A', al.length === 1 && al[0].severity === 'high' && /Paul/.test(al[0].title), { made, al });
  check('alerte : le titre ne contient aucun mot de passe', !al.some((x) => x.title.includes(WRONG)));

  // ---------- Export et suppression complète d'une organisation ----------
  const o2docs = (await up(other, o2, 'secret-org2.pdf', pdf('CONTENU-ORG2-UNIQUE'), '', L2)).json.id;
  r = await unlock(other, o2, 'faux-org2', L2);
  check('organisation 2 : un document et un échec d\'essai créés', Number(o2docs) > 0 && r.status === 403, r.status);
  r = await other('GET', `/api/privacy/orgs/${org2}/export`);
  const ex = r.json && r.json.tables ? r.json.tables : {};
  check('export d\'organisation : blocs, documents, versions, droits et journal de la bibliothèque inclus, sans le contenu des fichiers', r.status === 200 && ex.lib_blocks && ex.lib_docs && ex.lib_versions && ex.lib_audit && ex.lib_role_perms && !r.text.includes('CONTENU-ORG2-UNIQUE') && !/"data":/.test(JSON.stringify(ex.lib_versions)), Object.keys(ex).filter((k) => k.startsWith('lib_')));
  r = await other('DELETE', ws(org2), { confirm: 'Autre Société' });
  check('suppression de l\'organisation 2', r.status === 200, r.json);
  const left = {};
  for (const t of ['lib_blocks', 'lib_docs', 'lib_versions', 'lib_folders', 'lib_audit', 'lib_grants', 'lib_settings', 'lib_attempts']) left[t] = Number((await dbx.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE org_id = ?`).get(org2)).n);
  const leftPerms = Number((await dbx.prepare('SELECT COUNT(*) AS n FROM lib_role_perms WHERE block_id NOT IN (SELECT id FROM lib_blocks)').get()).n);
  check('suppression d\'organisation : plus aucune ligne lib_* de cette organisation', Object.values(left).every((n) => n === 0) && leftPerms === 0, left);
  const still = Number((await dbx.prepare('SELECT COUNT(*) AS n FROM lib_docs WHERE org_id = ?').get(org)).n);
  check('suppression d\'organisation : les documents de l\'autre organisation sont intacts', still > 0, still);
}, {});
