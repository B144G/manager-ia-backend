'use strict';
// Bibliothèque : blocs protégés par mot de passe, droits, versions chiffrées, corbeille, journal. Lancez-le avec : node scripts/test-library.js
const { run, client } = require('./lib/wave1');

const PW = 'secret123';
const pdf = (txt) => Buffer.from(`%PDF-1.4\n% ${txt}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b50000000049454e44ae426082', 'hex');

run('Bibliothèque : blocs protégés, droits, versions, corbeille, journal', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx, base }) => {
  const L = `${O}/library`;
  let r;

  // ---------- Module et blocs de départ ----------
  r = await mem('GET', O);
  check('module : la Bibliothèque est dans le menu d\'un simple membre', r.status === 200 && r.json.modules.some((m) => m.id === 'library'), r.json && r.json.modules && r.json.modules.map((m) => m.id));
  r = await owner('GET', `${L}/overview`);
  const MODS = require('../src/workspace/modules').modules.filter((m) => m.id !== 'library');
  check('accueil : 7 blocs de départ + un bloc par module pour le propriétaire', r.status === 200 && r.json.blocks.length === 7 + MODS.length, r.json.blocks.length);
  check('accueil : chaque module (Réunions comprises dès qu\'elle existe) a son bloc', MODS.every((m) => r.json.blocks.some((b) => b.slug === `mod-${m.id}` && b.name === m.title && b.builtin)), MODS.filter((m) => !r.json.blocks.some((b) => b.slug === `mod-${m.id}`)).map((m) => m.id));
  check('accueil : aucun bloc en double', new Set(r.json.blocks.map((b) => b.slug)).size === r.json.blocks.length, r.json.blocks.map((b) => b.slug));
  const B = Object.fromEntries(r.json.blocks.map((b) => [b.name, b]));
  check('accueil : tous fermés au départ', r.json.blocks.every((b) => !b.unlocked), r.json.blocks);
  check('accueil : le bloc personnel est marqué personnel et de départ', B['Mes documents'].personal && B['Mes documents'].builtin, B['Mes documents']);
  check('accueil : espace et statistiques présents', r.json.storage.quota > 0 && r.json.stats.documents === 0, r.json.storage);
  r = await mem('GET', `${L}/overview`);
  const memNames = r.json.blocks.map((b) => b.name).sort();
  check('droits : un membre ne voit ni RH, ni Comptabilité, ni Juridique', !['Ressources humaines', 'Comptabilité et finances', 'Juridique'].some((n) => memNames.includes(n)) && ['Administratif', 'Commercial', 'Mes documents', 'Projets'].every((n) => memNames.includes(n)), memNames);
  check('droits : un membre ne voit pas les blocs des modules réservés (Paie, Fiscalité, Comptabilité, Abonnement, Intégrations, RH, Juridique, Budget)', ['Paie', 'Fiscalité et liasse', 'Comptabilité', 'Abonnement', 'Intégrations', 'Ressources humaines', 'Juridique et conformité', 'Budget'].every((n) => !memNames.includes(n)) && memNames.includes('Stock et achats') && memNames.includes('Projets et tâches'), memNames);
  r = await mgr('GET', `${L}/overview`);
  check('droits : un responsable voit les 7 blocs de départ et les blocs des modules de son niveau', r.json.blocks.length >= 7 && ['Ressources humaines', 'Budget', 'Juridique et conformité'].every((n) => r.json.blocks.some((b) => b.name === n)) && !r.json.blocks.some((b) => b.name === 'Paie'), r.json.blocks.map((b) => b.name));
  r = await owner('GET', `${L}/overview`);
  r = await other('GET', `${L}/overview`);
  check('cloisonnement : une autre organisation n\'accède pas à la bibliothèque', r.status === 404, r.status);

  const ADM = B.Administratif.id; const RH = B['Ressources humaines'].id; const PERSO = B['Mes documents'].id; const COM = B.Commercial.id;

  // ---------- Verrou et déverrouillage ----------
  r = await owner('GET', `${L}/blocks/${ADM}`);
  check('verrou : contenu refusé sans mot de passe (code library_locked)', r.status === 403 && r.json.code === 'library_locked', r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=a.pdf`, pdf('x'));
  check('verrou : envoi refusé sans mot de passe', r.status === 403 && r.json.code === 'library_locked', r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/unlock`, { password: 'mauvais' });
  check('déverrouillage : mauvais mot de passe refusé', r.status === 403 && /incorrect/.test(r.json.error), r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/unlock`, {});
  check('déverrouillage : mot de passe vide refusé', r.status === 403, r.status);
  r = await owner('POST', `${L}/blocks/${ADM}/unlock`, { password: PW });
  check('déverrouillage : bon mot de passe accepté, avec une échéance', r.status === 200 && r.json.expiresAt > new Date().toISOString(), r.json);
  r = await owner('GET', `${L}/overview`);
  check('accueil : le bloc apparaît ouvert', r.json.blocks.find((b) => b.id === ADM).unlocked === true, r.json.blocks);
  r = await owner('GET', `${L}/blocks/${ADM}`);
  check('contenu : bloc ouvert lisible, droits complets pour le propriétaire', r.status === 200 && r.json.perms.delete && r.json.docs.length === 0, r.json);
  r = await mem('GET', `${L}/blocks/${ADM}`);
  check('verrou : l\'ouverture d\'une personne n\'ouvre rien pour une autre', r.status === 403 && r.json.code === 'library_locked', r.json);

  // ---------- Fichiers : envoi, type reconnu, chiffrement ----------
  const secret = 'CONTENU-CONFIDENTIEL-123';
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=${encodeURIComponent('Statuts société.pdf')}`, pdf(secret));
  check('envoi : PDF accepté', r.status === 201 && r.json.mime === 'application/pdf' && r.json.name === 'Statuts société.pdf', r.json);
  const doc1 = r.json.id;
  const raw = await dbx.prepare('SELECT data FROM lib_versions WHERE doc_id = ?').get(doc1);
  check('chiffrement : le contenu n\'est pas lisible dans la base', raw && !Buffer.from(raw.data).toString('latin1').includes(secret), null);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=photo.txt`, png);
  check('envoi : le type suit le contenu (PNG nommé .txt devient .png)', r.status === 201 && r.json.mime === 'image/png' && r.json.name === 'photo.png', r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=outil.exe`, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1)]));
  check('envoi : programme refusé', r.status === 400 && /programme/.test(r.json.error), r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=page.html`, Buffer.from('<html><script>alert(1)</script></html>'));
  check('envoi : page web refusée', r.status === 400, r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=note.txt`, Buffer.from('<script>alert(1)</script> bonjour'));
  check('envoi : texte contenant un script refusé', r.status === 400, r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=faux.docx`, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 65)]));
  check('envoi : un .docx qui n\'en est pas un est refusé', r.status === 400 && /ne correspond pas/.test(r.json.error), r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=compte-rendu.txt`, Buffer.from('Réunion du lundi : budget validé.\n'));
  check('envoi : texte simple accepté', r.status === 201 && r.json.mime === 'text/plain', r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=vide.pdf`, Buffer.alloc(0));
  check('envoi : fichier vide refusé', r.status === 400, r.status);

  r = await owner('GET', `${L}/docs/${doc1}/download`);
  check('téléchargement : contenu identique à l\'envoi', r.status === 200 && r.buf.equals(pdf(secret)), r.status);
  check('téléchargement : en-têtes protecteurs (pas de cache, pas d\'exécution)', /no-store/.test(r.headers.get('cache-control')) && /sandbox/.test(r.headers.get('content-security-policy')) && /attachment/.test(r.headers.get('content-disposition')), [...r.headers.entries()]);
  r = await owner('GET', `${L}/docs/${doc1}/preview`);
  check('aperçu : PDF affichable dans le site seulement', r.status === 200 && /frame-ancestors 'self'/.test(r.headers.get('content-security-policy')) && /inline/.test(r.headers.get('content-disposition')), r.status);

  // ---------- Droits du membre dans « Administratif » (voir + lire) ----------
  r = await mem('POST', `${L}/blocks/${ADM}/unlock`, { password: PW });
  check('membre : peut ouvrir Administratif', r.status === 200, r.json);
  r = await mem('GET', `${L}/blocks/${ADM}`);
  check('membre : voit les documents, sans droit d\'ajout', r.status === 200 && r.json.docs.length === 3 && r.json.perms.read && !r.json.perms.add && !r.json.perms.delete, r.json.perms);
  r = await mem('GET', `${L}/docs/${doc1}/download`);
  check('membre : peut télécharger (droit de lire)', r.status === 200, r.status);
  r = await mem('POST', `${L}/blocks/${ADM}/docs?name=x.pdf`, pdf('m'));
  check('membre : envoi refusé (pas le droit d\'ajouter)', r.status === 403, r.json);
  r = await mem('DELETE', `${L}/docs/${doc1}`);
  check('membre : suppression refusée', r.status === 403, r.json);
  r = await mem('PUT', `${L}/docs/${doc1}`, { name: 'piraté' });
  check('membre : modification refusée', r.status === 403, r.json);

  // ---------- Blocs interdits et masqués ----------
  r = await mem('POST', `${L}/blocks/${RH}/unlock`, { password: PW });
  check('membre : le bloc RH n\'existe pas pour lui, même avec son mot de passe', r.status === 404, r.status);
  r = await other('POST', `${ws(org2)}/library/blocks/${ADM}/unlock`, { password: PW });
  check('cloisonnement : un bloc d\'une autre organisation est introuvable', r.status === 404, r.status);

  // ---------- Exceptions par personne ----------
  const memId = Number((await dbx.prepare("SELECT id FROM users WHERE name = 'Paul'").get()).id);
  const mgrId = Number((await dbx.prepare("SELECT id FROM users WHERE name = 'Marc'").get()).id);
  r = await owner('GET', `${L}/blocks/${RH}/perms`);
  check('droits : lecture de l\'écran des droits', r.status === 200 && r.json.roles.member.view === false && r.json.roles.admin.delete === true && r.json.members.length === 3, r.json);
  r = await owner('PUT', `${L}/blocks/${RH}/perms`, { roles: r.json.roles, users: [{ userId: memId, view: true, read: true }] });
  check('droits : exception enregistrée pour le membre', r.status === 200, r.json);
  r = await mem('POST', `${L}/blocks/${RH}/unlock`, { password: PW });
  check('exception : le membre peut maintenant ouvrir RH', r.status === 200, r.json);
  r = await mem('GET', `${L}/blocks/${RH}`);
  check('exception : il lit, mais n\'ajoute pas', r.status === 200 && r.json.perms.read && !r.json.perms.add, r.json.perms);
  r = await owner('GET', `${L}/blocks/${RH}/perms`);
  r = await owner('PUT', `${L}/blocks/${RH}/perms`, { roles: r.json.roles, users: [] });
  r = await mem('GET', `${L}/blocks/${RH}`);
  check('exception retirée : l\'accès ouvert est fermé tout de suite', r.status === 404 || (r.status === 403 && r.json.code === 'library_locked'), r.json);
  r = await mem('GET', `${L}/blocks/${RH}/perms`);
  check('droits : un membre ne lit pas les droits', r.status === 403, r.status);
  r = await mgr('PUT', `${L}/blocks/${RH}/perms`, { roles: { member: { view: true } }, users: [] });
  check('droits : un responsable ne change pas les droits', r.status === 403, r.status);
  // Administrateur (pas propriétaire) : ne touche pas aux droits des administrateurs
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND user_id = ?").run(org, mgrId);
  r = await mgr('GET', `${L}/blocks/${RH}/perms`);
  r = await mgr('PUT', `${L}/blocks/${RH}/perms`, { roles: { ...r.json.roles, admin: { view: false, read: false, add: false, edit: false, delete: false } }, users: [] });
  r = await owner('GET', `${L}/blocks/${RH}/perms`);
  check('droits : un administrateur ne peut pas retirer les droits des administrateurs', r.json.roles.admin.delete === true, r.json.roles.admin);
  r = await owner('PUT', `${L}/blocks/${PERSO}/perms`, { roles: {}, users: [] });
  check('droits : le bloc personnel n\'a pas de droits à régler', r.status === 400, r.json);

  // ---------- Bloc personnel ----------
  r = await owner('POST', `${L}/blocks/${PERSO}/unlock`, { password: PW });
  r = await owner('POST', `${L}/blocks/${PERSO}/docs?name=Mon contrat.pdf`, pdf('perso'));
  const persoDoc = r.json.id;
  check('personnel : le propriétaire y range un document', r.status === 201, r.json);
  r = await mem('POST', `${L}/blocks/${PERSO}/unlock`, { password: PW });
  r = await mem('GET', `${L}/blocks/${PERSO}`);
  check('personnel : un autre ne voit pas ce document', r.status === 200 && r.json.docs.length === 0 && r.json.perms.add, r.json);
  r = await mem('GET', `${L}/docs/${persoDoc}/download`);
  check('personnel : téléchargement direct refusé à un autre', r.status === 404, r.status);
  r = await mem('POST', `${L}/blocks/${PERSO}/docs?name=Mes notes.txt`, Buffer.from('notes du membre'));
  check('personnel : chacun y range ses propres documents', r.status === 201, r.json);
  r = await owner('GET', `${L}/blocks/${PERSO}`);
  check('personnel : le propriétaire de l\'organisation ne voit pas ceux du membre', r.json.docs.length === 1 && r.json.docs[0].id === persoDoc, r.json.docs);

  // ---------- Versions ----------
  r = await owner('POST', `${L}/docs/${doc1}/versions?note=${encodeURIComponent('Article 3 corrigé')}&name=${encodeURIComponent('Statuts société.pdf')}`, pdf('v2'));
  check('versions : nouvelle version', r.status === 201 && r.json.version === 2, r.json);
  r = await owner('GET', `${L}/docs/${doc1}`);
  check('versions : document en v2, historique de 2 versions avec la note', r.json.doc.version === 2 && r.json.versions.length === 2 && r.json.versions[0].note === 'Article 3 corrigé', r.json);
  r = await owner('GET', `${L}/docs/${doc1}/download?version=1`);
  check('versions : l\'ancienne version reste téléchargeable telle quelle', r.buf.equals(pdf(secret)), r.status);
  r = await owner('GET', `${L}/docs/${doc1}/download?version=9`);
  check('versions : version inexistante → 404', r.status === 404, r.status);
  r = await owner('POST', `${L}/docs/${doc1}/versions/1/restore`, {});
  check('versions : rétablir la v1 crée une v3', r.status === 200 && r.json.version === 3, r.json);
  r = await owner('GET', `${L}/docs/${doc1}/download`);
  check('versions : la version actuelle est le contenu de la v1', r.buf.equals(pdf(secret)), r.status);
  r = await owner('DELETE', `${L}/docs/${doc1}/versions/3`);
  check('versions : la version actuelle ne se supprime pas', r.status === 400, r.json);
  r = await owner('DELETE', `${L}/docs/${doc1}/versions/2`);
  check('versions : une ancienne version se supprime', r.status === 200, r.json);

  // ---------- Modification, étiquettes, recherche, favoris, récents ----------
  r = await owner('PUT', `${L}/docs/${doc1}`, { name: 'Statuts 2026', tags: 'juridique, 2026, Juridique' });
  check('modification : renommé (extension gardée), étiquettes sans doublon', r.status === 200 && r.json.name === 'Statuts 2026.pdf', r.json);
  r = await owner('GET', `${L}/blocks/${ADM}?tag=2026`);
  check('filtre par étiquette', r.json.docs.length === 1 && r.json.docs[0].tags.length === 2 && r.json.tags.includes('juridique'), r.json.docs);
  r = await owner('GET', `${L}/search?q=statuts`);
  check('recherche : trouve dans les blocs ouverts', r.status === 200 && r.json.docs.some((d) => d.id === doc1) && r.json.docs[0].block.name, r.json);
  r = await owner('GET', `${L}/search?q=100%25`);
  check('recherche : caractères spéciaux sans erreur', r.status === 200, r.status);
  r = await owner('GET', `${L}/search`);
  check('recherche : vide → message', r.status === 400, r.status);
  r = await owner('POST', `${L}/docs/${doc1}/favorite`, { on: true });
  r = await owner('GET', `${L}/favorites`);
  check('favoris : le document y est', r.json.docs.length === 1 && r.json.docs[0].favorite, r.json);
  r = await owner('GET', `${L}/recent`);
  check('récents : le document consulté y est', r.json.docs.some((d) => d.id === doc1), r.json);
  r = await owner('PUT', `${L}/docs/${doc1}`, { linkType: 'project', linkId: 999999 });
  check('lien : projet inconnu refusé', r.status === 400, r.json);

  // ---------- Dossiers ----------
  r = await owner('POST', `${L}/blocks/${ADM}/folders`, { name: 'Contrats' });
  const f1 = r.json.id;
  check('dossier créé', r.status === 201, r.json);
  let parent = f1; let depthErr = null;
  for (let i = 0; i < 7; i++) { r = await owner('POST', `${L}/blocks/${ADM}/folders`, { name: `N${i}`, parentId: parent }); if (r.status !== 201) { depthErr = r; break; } parent = r.json.id; }
  check('dossiers : pas au-delà de 6 niveaux', depthErr && depthErr.status === 400 && /6 niveaux/.test(depthErr.json.error), depthErr && depthErr.json);
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=bail.pdf&folderId=${f1}`, pdf('bail'));
  r = await owner('GET', `${L}/blocks/${ADM}?folderId=${f1}`);
  check('dossier : le document y est, fil d\'Ariane présent', r.json.docs.length === 1 && r.json.breadcrumbs[0].name === 'Contrats' && r.json.folders.length === 1, r.json);
  r = await owner('DELETE', `${L}/folders/${f1}`);
  check('dossier : non vide → refus', r.status === 400, r.json);
  r = await owner('GET', `${L}/blocks/${COM}?folderId=${f1}`);
  check('dossier : celui d\'un autre bloc est refusé', r.status === 403 || r.status === 404, r.status);

  // ---------- Corbeille ----------
  r = await owner('DELETE', `${L}/docs/${doc1}`);
  check('corbeille : document mis à la corbeille', r.status === 200, r.json);
  r = await owner('GET', `${L}/blocks/${ADM}`);
  check('corbeille : il n\'est plus dans la liste', !r.json.docs.some((d) => d.id === doc1), r.json.docs);
  r = await owner('GET', `${L}/trash`);
  check('corbeille : listé avec 30 jours restants', r.json.docs.some((d) => d.id === doc1 && d.daysLeft === 30), r.json);
  r = await mem('GET', `${L}/trash`);
  check('corbeille : invisible pour qui n\'a pas le droit de supprimer', r.json.docs.length === 0, r.json);
  r = await owner('GET', `${L}/docs/${doc1}/download`);
  check('corbeille : plus téléchargeable', r.status === 404, r.status);
  r = await owner('POST', `${L}/docs/${doc1}/restore`, {});
  check('corbeille : restauré', r.status === 200, r.json);
  r = await owner('DELETE', `${L}/docs/${doc1}`);
  r = await owner('DELETE', `${L}/docs/${doc1}/purge`);
  check('corbeille : supprimé pour toujours', r.status === 200, r.json);
  const left = await dbx.prepare('SELECT COUNT(*) AS c FROM lib_versions WHERE doc_id = ?').get(doc1);
  check('corbeille : les fichiers chiffrés sont effacés aussi', Number(left.c) === 0, left);

  // ---------- Blocs (administration) ----------
  r = await owner('DELETE', `${L}/blocks/${COM}`);
  check('blocs : un bloc de départ ne se supprime pas', r.status === 400, r.json);
  r = await owner('POST', `${L}/blocks`, { name: 'Direction', color: '#112233', icon: 'lock', hidden: true });
  const dir = r.json.id;
  check('blocs : nouveau bloc masqué créé', r.status === 201, r.json);
  r = await owner('POST', `${L}/blocks`, { name: 'X', color: 'red' });
  check('blocs : couleur invalide refusée', r.status === 400, r.json);
  r = await mem('GET', `${L}/overview`);
  check('blocs : un bloc masqué est invisible pour un membre', !r.json.blocks.some((b) => b.id === dir), r.json.blocks.map((b) => b.name));
  r = await mem('POST', `${L}/blocks`, { name: 'Pirate' });
  check('blocs : un membre ne crée pas de bloc', r.status === 403, r.status);
  r = await owner('DELETE', `${L}/blocks/${dir}`);
  check('blocs : un bloc vide se supprime', r.status === 200, r.json);

  // ---------- Verrou : refermer, expiration, autre session ----------
  r = await owner('POST', `${L}/blocks/${ADM}/lock`, {});
  r = await owner('GET', `${L}/blocks/${ADM}`);
  check('refermer : le bloc est de nouveau verrouillé', r.status === 403 && r.json.code === 'library_locked', r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/unlock`, { password: PW });
  await dbx.prepare("UPDATE lib_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE block_id = ?").run(ADM);
  r = await owner('GET', `${L}/blocks/${ADM}`);
  check('expiration : une autorisation échue referme le bloc', r.status === 403 && r.json.code === 'library_locked', r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/unlock`, { password: PW });
  await dbx.prepare("UPDATE lib_grants SET hard_expires_at = '2000-01-01T00:00:00.000Z' WHERE block_id = ?").run(ADM);
  r = await owner('GET', `${L}/blocks/${ADM}`);
  check('durée maximale : le bloc se referme même en travaillant', r.status === 403 && r.json.code === 'library_locked', r.json);
  const memContact = (await dbx.prepare('SELECT contact FROM users WHERE id = ?').get(memId)).contact;
  const mem2 = client(base);
  r = await mem2('POST', '/api/login', { contact: memContact, pass: PW });
  r = await mem2('GET', `${L}/blocks/${PERSO}`);
  check('session : un autre appareil du même compte doit ressaisir le mot de passe', r.status === 403 && r.json.code === 'library_locked', r.json);
  r = await mem('POST', `${L}/lock-all`, {});
  r = await mem('GET', `${L}/blocks/${ADM}`);
  check('tout refermer : plus aucun bloc ouvert', r.status === 403 && r.json.code === 'library_locked', r.json);

  // ---------- Trop d'essais ----------
  for (let i = 0; i < 5; i++) await mem2('POST', `${L}/blocks/${ADM}/unlock`, { password: 'faux' + i });
  r = await mem2('POST', `${L}/blocks/${ADM}/unlock`, { password: PW });
  check('essais : après 5 erreurs, même le bon mot de passe est refusé 15 minutes', r.status === 429 && /15 minutes/.test(r.json.error), r.json);

  // ---------- Réglages et journal ----------
  r = await owner('PUT', `${L}/settings`, { grantMinutes: 2, grantMaxMinutes: 60, maxFileMb: 0 });
  check('réglages : durée trop courte refusée', r.status === 400, r.json);
  r = await owner('PUT', `${L}/settings`, { grantMinutes: 30, grantMaxMinutes: 20, maxFileMb: 0 });
  check('réglages : maximum inférieur à la durée refusé', r.status === 400, r.json);
  r = await owner('PUT', `${L}/settings`, { grantMinutes: 10, grantMaxMinutes: 60, maxFileMb: 1 });
  check('réglages : enregistrés', r.status === 200, r.json);
  r = await owner('GET', `${L}/settings`);
  check('réglages : relus, taille maximale 1 Mo, espace utilisé > 0', r.json.settings.grantMinutes === 10 && r.json.storage.maxFile === 1024 * 1024 && r.json.storage.used > 0, r.json);
  r = await owner('POST', `${L}/blocks/${ADM}/unlock`, { password: PW });
  r = await owner('POST', `${L}/blocks/${ADM}/docs?name=gros.pdf`, Buffer.concat([pdf('g'), Buffer.alloc(1024 * 1024 + 10, 32)]));
  check('réglages : fichier plus gros que la limite refusé', r.status === 413, r.json);
  r = await mem('PUT', `${L}/settings`, { grantMinutes: 60 });
  check('réglages : interdits à un membre', r.status === 403, r.status);

  r = await owner('GET', `${L}/audit?limit=200`);
  const acts = new Set(r.json.entries.map((e) => e.action));
  check('journal : entrées, échecs, téléchargements, droits et suppressions enregistrés', ['unlock', 'unlock_fail', 'unlock_locked', 'download', 'upload', 'perms', 'purge', 'trash', 'version', 'denied'].every((a) => acts.has(a)), [...acts]);
  check('journal : aucun mot de passe enregistré', !JSON.stringify(r.json).includes(PW) && !JSON.stringify(r.json).includes('faux0'), null);
  check('journal : libellés lisibles et liste des actions', r.json.entries[0].label && r.json.actions.length > 10, r.json.entries[0]);
  r = await owner('GET', `${L}/audit?limit=5`);
  const nxt = r.json.next;
  r = await owner('GET', `${L}/audit?limit=5&before=${nxt}`);
  check('journal : pages suivantes', r.status === 200 && r.json.entries.length === 5 && r.json.entries[0].id < nxt, r.json.entries.map((e) => e.id));
  r = await owner('GET', `${L}/audit?action=pirate`);
  check('journal : action inconnue refusée', r.status === 400, r.status);
  r = await mem('GET', `${L}/audit`);
  check('journal : interdit à un membre', r.status === 403, r.status);
  const other2 = await dbx.prepare('SELECT COUNT(*) AS c FROM lib_audit WHERE org_id = ?').get(org2);
  check('cloisonnement : rien dans le journal de l\'autre organisation', Number(other2.c) === 0, other2);
});
