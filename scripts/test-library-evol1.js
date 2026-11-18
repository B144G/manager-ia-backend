'use strict';
// Bibliothèque, évolution (étape 1) : classification, catalogue, vocabulaire, import/export CSV, étiquettes, prêts, réservations, retards, versions documentaires.
// Lancez-le avec : node scripts/test-library-evol1.js
const { run } = require('./lib/wave1');

const PW = 'secret123';
const pdf = (txt) => Buffer.from(`%PDF-1.4\n% ${txt}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
const day = 86400000;

run('Bibliothèque (évolution, étape 1) : classement, catalogue, prêts, versions', async ({ check, owner, mgr, mem, other, org, O, dbx }) => {
  const L = `${O}/library`;
  let r;
  const memId = Number((await dbx.prepare("SELECT id FROM users WHERE name = 'Paul'").get()).id);
  const mgrId = Number((await dbx.prepare("SELECT id FROM users WHERE name = 'Marc'").get()).id);
  const ownId = Number((await dbx.prepare("SELECT id FROM users WHERE name = 'Awa'").get()).id);

  // ---------- 1. Classification documentaire ----------
  r = await owner('GET', `${L}/classes`);
  check('classes : plan vide au départ, quatre modèles proposés', r.status === 200 && r.json.classes.length === 0 && r.json.templates.length === 4, r.json);
  r = await mgr('POST', `${L}/classes/template`, { key: 'pme' });
  check('classes : un responsable ne règle pas le plan (administrateur seulement)', r.status === 403, r.status);
  r = await owner('POST', `${L}/classes/template`, { key: 'inconnu' });
  check('classes : modèle inconnu refusé', r.status === 400, r.json);
  r = await owner('POST', `${L}/classes/template`, { key: 'pme' });
  const nPme = r.json.added;
  check('classes : modèle PME appliqué (28 classes)', r.status === 200 && nPme === 28, r.json);
  r = await owner('POST', `${L}/classes/template`, { key: 'pme' });
  check('classes : réappliquer le modèle n\'ajoute rien (idempotent)', r.json.added === 0 && r.json.skipped === 28, r.json);
  r = await owner('GET', `${L}/classes`);
  const C = Object.fromEntries(r.json.classes.map((c) => [c.code, c]));
  check('classes : arborescence — FIN.1 est sous FIN, conservation 120 mois', C['FIN.1'].parentId === C.FIN.id && C.FIN.retentionMonths === 120 && C['FIN.1'].path === 'FIN › FIN.1', C['FIN.1']);
  r = await owner('POST', `${L}/classes`, { code: 'fin', name: 'Doublon' });
  check('classes : code déjà pris refusé (casse ignorée)', r.status === 400, r.json);
  r = await owner('POST', `${L}/classes`, { code: 'a b!', name: 'X' });
  check('classes : code invalide refusé', r.status === 400, r.json);
  r = await owner('POST', `${L}/classes`, { code: 'DIR', name: 'Direction', parentId: C.ADM.id, retentionMonths: 84, confidentiality: 'restricted' });
  check('classes : ajout d\'une classe avec conservation et confidentialité par défaut', r.status === 201, r.json);
  const DIR = r.json.id;
  r = await owner('PUT', `${L}/classes/${C.ADM.id}`, { parentId: DIR });
  check('classes : une classe ne se range pas sous sa propre descendance', r.status === 400, r.json);
  r = await owner('PUT', `${L}/classes/${DIR}`, { name: 'Direction générale' });
  check('classes : modification du nom', r.status === 200, r.json);
  r = await owner('DELETE', `${L}/classes/${C.ADM.id}`);
  check('classes : suppression refusée tant qu\'il reste des sous-classes', r.status === 400, r.json);

  // ---------- Vocabulaire contrôlé ----------
  r = await mem('POST', `${L}/thesaurus`, { term: 'Contrat' });
  check('vocabulaire : un membre ne l\'enrichit pas', r.status === 403, r.status);
  r = await mgr('POST', `${L}/thesaurus`, { term: 'Contrat', synonyms: ['accord', 'convention'] });
  check('vocabulaire : terme avec synonymes ajouté par un responsable', r.status === 201, r.json);
  const T1 = r.json.id;
  r = await mgr('POST', `${L}/thesaurus`, { term: 'contrat' });
  check('vocabulaire : doublon refusé (casse ignorée)', r.status === 400, r.json);
  r = await mgr('POST', `${L}/thesaurus`, { term: 'Facture', synonyms: ['note de frais'] });
  r = await mgr('GET', `${L}/thesaurus/suggest?q=conv`);
  check('vocabulaire : suggestion par synonyme', r.json.terms.length === 1 && r.json.terms[0].term === 'Contrat' && r.json.terms[0].via === 'convention', r.json);

  // ---------- 2. Notices et catalogue ----------
  r = await mem('POST', `${L}/records`, { title: 'Test' });
  check('catalogue : un membre ne crée pas de notice', r.status === 403, r.status);
  r = await mgr('POST', `${L}/records`, { title: '' });
  check('catalogue : titre obligatoire', r.status === 400, r.json);
  r = await mgr('POST', `${L}/records`, { title: 'X', type: 'cassette' });
  check('catalogue : type de ressource inconnu refusé', r.status === 400, r.json);
  r = await mgr('POST', `${L}/records`, { title: 'Guide de la comptabilité OHADA', type: 'book', author: 'Marie Dupont', publisher: 'Éditions du Sahel', pubDate: '2019-05-01', language: 'fr', summary: 'Référentiel comptable.', keywords: ['accord', 'Facture'], callNumber: 'FIN.2 DUP', location: 'Étagère A2', classId: C['FIN.1'].id, loanable: true });
  const bookA = r.json.id;
  check('catalogue : livre créé, numéro d\'inventaire attribué', r.status === 201 && bookA > 0, r.json);
  r = await mgr('GET', `${L}/records/${bookA}`);
  check('catalogue : numéro d\'inventaire automatique INV-000001, synonymes ramenés au terme préféré', r.json.record.inventoryNo === `INV-${String(bookA).padStart(6, '0')}` && JSON.stringify(r.json.record.keywords) === JSON.stringify(['Contrat', 'Facture']), r.json.record);
  check('catalogue : classe, année et chemin enregistrés', r.json.record.classCode === 'FIN.1' && r.json.record.year === 2019 && r.json.record.classPath === 'FIN › FIN.1', r.json.record);
  r = await mgr('POST', `${L}/records`, { title: 'Contrat de maintenance photocopieur', type: 'contract', author: 'Société Copitec', pubDate: '2023-02-10', language: 'fr', keywords: ['contrat'], classId: C['JUR.1'].id, inventoryNo: 'CTR-0001', loanable: false });
  const ctr = r.json.id;
  r = await mgr('POST', `${L}/records`, { title: 'Contract template', type: 'document', pubDate: '2022-01-01', language: 'en', classId: C['JUR.1'].id, inventoryNo: 'CTR-0001' });
  check('catalogue : numéro d\'inventaire déjà pris refusé', r.status === 400, r.json);
  r = await mgr('POST', `${L}/records`, { title: 'Perceuse à colonne', type: 'equipment', location: 'Atelier', condition: 'good', classId: C['TEC.3'].id, inventoryNo: 'MAT-0007', acquiredAt: '2021-03-01', acquiredPrice: 180000 });
  const drill = r.json.id;
  r = await mgr('POST', `${L}/records`, { title: 'Norme ISO 9001:2015', type: 'standard', pubDate: '2015-09-01', language: 'en', classId: C['QUA.3'].id, confidentiality: 'public' });
  const iso = r.json.id;
  r = await mgr('POST', `${L}/records`, { title: 'Rapport d\'audit interne 2024', type: 'report', pubDate: '2024-11-20', language: 'fr', classId: C['QUA.2'].id, confidentiality: 'restricted' });
  const audit1 = r.json.id;
  r = await owner('POST', `${L}/records`, { title: 'Plan stratégique confidentiel', type: 'document', pubDate: '2024-06-01', language: 'fr', classId: DIR, confidentiality: 'secret' });
  const secretRec = r.json.id;
  r = await owner('POST', `${L}/records`, { title: 'Livret d\'accueil des nouveaux', type: 'document', pubDate: '2024-01-15', language: 'fr', classId: C['RH.1'].id });
  const accueil = r.json.id;

  // Confidentialité : qui voit quoi
  r = await mem('GET', `${L}/catalog?size=100`);
  const memTitles = r.json.records.map((x) => x.title);
  check('confidentialité : un membre ne voit ni le « restreint » ni le « secret »', !memTitles.includes('Rapport d\'audit interne 2024') && !memTitles.includes('Plan stratégique confidentiel') && memTitles.includes('Norme ISO 9001:2015'), memTitles);
  r = await mgr('GET', `${L}/catalog?size=100`);
  const mgrTitles = r.json.records.map((x) => x.title);
  check('confidentialité : un responsable voit le « restreint » mais pas le « secret »', mgrTitles.includes('Rapport d\'audit interne 2024') && !mgrTitles.includes('Plan stratégique confidentiel'), mgrTitles);
  r = await owner('GET', `${L}/catalog?size=100`);
  check('confidentialité : le propriétaire voit tout (7 notices)', r.json.total === 7, r.json.total);
  r = await mem('GET', `${L}/records/${audit1}`);
  check('confidentialité : fiche directe d\'une notice restreinte → introuvable pour un membre', r.status === 404, r.status);
  r = await other('GET', `${L}/records/${bookA}`);
  check('cloisonnement : une autre organisation ne voit pas la notice', r.status === 404, r.status);

  // Recherche, facettes
  r = await owner('GET', `${L}/catalog?q=${encodeURIComponent('éditions sahel')}`);
  check('catalogue : recherche insensible aux accents et aux majuscules', r.json.total === 1 && r.json.records[0].id === bookA, r.json.total);
  r = await owner('GET', `${L}/catalog?q=convention`);
  check('catalogue : recherche par synonyme du vocabulaire (convention → Contrat)', r.json.records.some((x) => x.id === bookA) && r.json.records.some((x) => x.id === ctr), r.json.records.map((x) => x.title));
  r = await owner('GET', `${L}/catalog?type=report`);
  check('catalogue : filtre par type', r.json.total === 1 && r.json.records[0].id === audit1, r.json.total);
  r = await owner('GET', `${L}/catalog?class=${C.JUR.id}`);
  check('catalogue : filtre par classe inclut les sous-classes', r.json.total === 1 && r.json.records[0].id === ctr, r.json.records.map((x) => x.title));
  r = await owner('GET', `${L}/catalog?year=2024`);
  check('catalogue : filtre par année', r.json.total === 3, r.json.total);
  r = await owner('GET', `${L}/catalog?language=en`);
  check('catalogue : filtre par langue', r.json.total === 1 && r.json.records[0].id === iso, r.json.total);
  r = await owner('GET', `${L}/catalog`);
  const f = r.json.facets;
  check('facettes : types comptés (7 notices au total)', f.type.reduce((a, x) => a + x.count, 0) === 7 && f.type.find((x) => x.value === 'book').label === 'Livre', f.type);
  check('facettes : années triées de la plus récente, langues comptées', f.year[0].value === '2024' && f.language.find((x) => x.value === 'fr').count === 5, [f.year, f.language]);
  r = await owner('GET', `${L}/catalog?type=book`);
  check('facettes : la facette « type » ignore son propre filtre (les autres types restent comptés)', r.json.facets.type.length >= 5, r.json.facets.type);
  r = await owner('GET', `${L}/catalog?size=5&page=2&sort=title`);
  check('catalogue : pagination et tri', r.json.records.length === 2 && r.json.total === 7 && r.json.page === 2, r.json);

  // Mode strict du vocabulaire
  r = await mgr('PUT', `${L}/catalog/settings`, { strictVocab: true });
  check('réglages : seul un administrateur règle le catalogue', r.status === 403, r.status);
  r = await owner('PUT', `${L}/catalog/settings`, { strictVocab: true, loanDays: 14, maxRenewals: 1, maxLoans: 2, finePerDay: 500, blockAfterDays: 7, blockDays: 30, holdDays: 3, remindBeforeDays: 2, remindEveryDays: 3 });
  check('réglages : catalogue et prêts enregistrés', r.status === 200 && r.json.settings.strictVocab && r.json.settings.finePerDay === 500, r.json);
  r = await mgr('POST', `${L}/records`, { title: 'Avec mot hors vocabulaire', keywords: ['licorne'] });
  check('vocabulaire strict : un mot-clé hors vocabulaire est refusé', r.status === 400, r.json);
  await owner('PUT', `${L}/catalog/settings`, { strictVocab: false });
  r = await mgr('PUT', `${L}/thesaurus/${T1}`, { term: 'Contrats', synonyms: ['accord', 'convention'] });
  r = await mgr('GET', `${L}/records/${ctr}`);
  check('vocabulaire : renommer un terme met à jour les notices', r.json.record.keywords.includes('Contrats'), r.json.record.keywords);

  // Classement en masse
  r = await mgr('POST', `${L}/records/bulk`, { ids: [accueil, iso], classId: C['ADM.1'].id, location: 'Armoire 3' });
  check('classement en masse : 2 notices déplacées', r.status === 200 && r.json.updated === 2, r.json);
  r = await mgr('GET', `${L}/records/${iso}`);
  check('classement en masse : classe et emplacement appliqués', r.json.record.classCode === 'ADM.1' && r.json.record.location === 'Armoire 3', r.json.record);
  r = await mgr('POST', `${L}/records/bulk`, { ids: [], classId: 1 });
  check('classement en masse : sélection vide refusée', r.status === 400, r.json);
  r = await owner('DELETE', `${L}/classes/${C['ADM.1'].id}`);
  check('classes : suppression refusée tant que la classe contient des notices', r.status === 400, r.json);
  r = await owner('DELETE', `${L}/classes/${C['ADM.1'].id}?moveTo=${C['ADM.2'].id}`);
  r = await owner('GET', `${L}/classes`);
  check('classes : suppression avec déplacement des notices vers une autre classe', r.json.classes.find((c) => c.code === 'ADM.2').own === 2 && !r.json.classes.some((c) => c.code === 'ADM.1'), r.json.classes.find((c) => c.code === 'ADM.2'));

  // Notice liée à un document d'un bloc protégé
  r = await owner('GET', `${L}/overview`);
  const COM = r.json.blocks.find((b) => b.name === 'Commercial').id;
  await owner('POST', `${L}/blocks/${COM}/unlock`, { password: PW });
  await mgr('POST', `${L}/blocks/${COM}/unlock`, { password: PW });
  r = await owner('POST', `${L}/blocks/${COM}/docs?name=offre.pdf`, pdf('offre'));
  const docOffre = r.json.id;
  r = await owner('POST', `${L}/records/from-docs`, { docIds: [docOffre], classId: C['COM.1'].id });
  check('catalogue : notice créée à partir d\'un document de la bibliothèque', r.status === 200 && r.json.created === 1, r.json);
  r = await owner('POST', `${L}/records/from-docs`, { docIds: [docOffre] });
  check('catalogue : pas de seconde notice pour le même document', r.json.created === 0 && r.json.existing === 1, r.json);
  r = await owner('GET', `${L}/catalog?q=offre`);
  check('catalogue : la notice du document apparaît (bloc ouvert)', r.json.total === 1 && r.json.records[0].docId === docOffre, r.json);
  await owner('POST', `${L}/lock-all`, {});
  r = await owner('GET', `${L}/catalog?q=offre`);
  check('catalogue : bloc refermé → la notice du document disparaît (rien de plus que le bloc)', r.json.total === 0, r.json.total);
  await owner('POST', `${L}/blocks/${COM}/unlock`, { password: PW });

  // ---------- Import / export CSV ----------
  r = await owner('GET', `${L}/catalog/export.csv`);
  check('export CSV : entête et lignes (BOM, séparateur point-virgule)', r.status === 200 && r.text.startsWith('﻿type;titre;auteur') && r.text.includes('Guide de la comptabilité OHADA'), r.text.slice(0, 120));
  r = await mgr('POST', `${L}/records`, { title: '=HYPERLINK("http://x")', type: 'document' });
  const evil = r.json.id;
  r = await mgr('GET', `${L}/catalog/export.csv`);
  check('export CSV : aucune formule exécutable dans un tableur (apostrophe devant =)', r.text.includes("'=HYPERLINK") && !/;=HYPERLINK/.test(r.text), r.text.slice(-300));
  await mgr('DELETE', `${L}/records/${evil}`);
  const csv = ['type;titre;auteur;date;langue;mots_cles;inventaire;classe;pretable', 'Livre;Manuel du magasinier;Paul Martin;2020;fr;Facture|Stock;LIV-100;QUA.1;oui', 'Rapport;Rapport annuel 2023;;2024-03-01;fr;;RAP-23;FIN;non', 'Bateau;Ligne fausse;;;;;;;', 'Livre;Autre livre;;;;;;ZZZ;'].join('\n');
  r = await mgr('POST', `${L}/catalog/import`, { csv, dryRun: true });
  check('import CSV : simulation — 2 créées, 2 lignes en erreur avec leur numéro', r.json.dryRun && r.json.created === 2 && r.json.errors.length === 2 && r.json.errors[0].line === 4, r.json);
  r = await owner('GET', `${L}/catalog?q=magasinier`);
  check('import CSV : la simulation n\'a rien enregistré', r.json.total === 0, r.json.total);
  r = await mgr('POST', `${L}/catalog/import`, { csv });
  check('import CSV : 2 notices importées', r.json.created === 2 && r.json.errors.length === 2, r.json);
  r = await mgr('POST', `${L}/catalog/import`, { csv: 'type;titre;inventaire\nLivre;Manuel du magasinier (2e éd.);LIV-100' });
  check('import CSV : le numéro d\'inventaire existant met la notice à jour', r.json.updated === 1 && r.json.created === 0, r.json);
  r = await owner('GET', `${L}/catalog?q=magasinier`);
  check('import CSV : titre mis à jour, classe conservée (colonne absente)', r.json.records[0].title.includes('2e éd.') && r.json.records[0].classCode === 'QUA.1', r.json.records[0]);
  r = await mgr('POST', `${L}/catalog/import`, { csv: 'auteur\nQuelqu\'un' });
  check('import CSV : colonne « titre » obligatoire', r.status === 400, r.json);
  r = await mem('POST', `${L}/catalog/import`, { csv });
  check('import CSV : réservé aux responsables', r.status === 403, r.status);

  // ---------- Étiquettes et scan ----------
  r = await mgr('GET', `${L}/labels?ids=${bookA},${drill}`);
  check('étiquettes : code-barres Code 128 et QR en SVG pour chaque ressource', r.status === 200 && r.json.labels.length === 2 && r.json.labels.every((l) => l.barcodeSvg.includes('<rect') && l.qrSvg.includes('<svg')), r.json.labels && r.json.labels.map((l) => l.inventoryNo));
  r = await mem('GET', `${L}/labels?ids=${bookA}`);
  check('étiquettes : réservées aux responsables', r.status === 403, r.status);
  r = await mem('GET', `${L}/scan?code=MAT-0007`);
  check('scan : le numéro d\'inventaire retrouve la ressource', r.status === 200 && r.json.record.id === drill, r.json);
  r = await mem('GET', `${L}/scan?code=${encodeURIComponent('FIN.2 DUP')}`);
  check('scan : la cote retrouve aussi la ressource', r.status === 200 && r.json.record.id === bookA, r.json);
  r = await mem('GET', `${L}/scan?code=RIEN`);
  check('scan : code inconnu → 404', r.status === 404, r.status);

  // ---------- 3. Prêts, retours, renouvellements ----------
  r = await mem('POST', `${L}/records/${ctr}/loan`, {});
  check('prêt : une ressource non prêtable est refusée', r.status === 400, r.json);
  r = await mem('POST', `${L}/records/${drill}/loan`, { userId: mgrId });
  check('prêt : un membre ne prête pas au nom d\'un autre', r.status === 403, r.status);
  r = await mem('POST', `${L}/records/${drill}/loan`, {});
  const loan1 = r.json.id;
  check('prêt : emprunt par un membre pour lui-même (échéance à 14 jours)', r.status === 201 && Math.round((Date.parse(r.json.dueAt) - Date.now()) / day) === 14, r.json);
  r = await mem('GET', `${L}/records/${drill}`);
  check('prêt : la ressource est « empruntée »', r.json.record.status === 'loaned' && r.json.record.loan.mine, r.json.record);
  r = await mgr('POST', `${L}/records/${drill}/loan`, {});
  check('prêt : déjà empruntée → refusé', r.status === 400, r.json);
  r = await mgr('POST', `${L}/records/${drill}/reserve`, {});
  check('réservation : file d\'attente, position 1', r.status === 201 && r.json.position === 1, r.json);
  const resaMgr = r.json.id;
  r = await mgr('POST', `${L}/records/${drill}/reserve`, {});
  check('réservation : pas deux fois la même', r.status === 400, r.json);
  r = await owner('POST', `${L}/records/${drill}/reserve`, {});
  check('réservation : deuxième personne en position 2', r.json.position === 2, r.json);
  r = await mem('POST', `${L}/loans/${loan1}/renew`);
  check('renouvellement refusé : quelqu\'un attend la ressource', r.status === 400, r.json);
  r = await mem('POST', `${L}/loans/${loan1}/return`, {});
  check('retour : enregistré sans retard, sans pénalité', r.status === 200 && r.json.lateDays === 0 && r.json.fine === 0, r.json);
  r = await mgr('GET', `${L}/records/${drill}`);
  check('retour : la ressource est mise de côté pour le premier réservant', r.json.record.status === 'reserved' && r.json.reservations[0].state === 'ready' && r.json.reservations[1].state === 'waiting', r.json);
  r = await owner('POST', `${L}/records/${drill}/loan`, {});
  check('prêt : mise de côté pour une autre personne → refusé', r.status === 400, r.json);
  r = await mgr('POST', `${L}/records/${drill}/loan`, {});
  const loan2 = r.json.id;
  check('prêt : le réservant emprunte la ressource mise de côté', r.status === 201, r.json);
  r = await mgr('POST', `${L}/loans/${loan2}/renew`);
  check('renouvellement refusé tant que la deuxième personne attend', r.status === 400, r.json);
  r = await owner('DELETE', `${L}/reservations/${(await dbx.prepare("SELECT id FROM lib_reservations WHERE user_id = ? AND state = 'waiting'").get(ownId)).id}`);
  r = await mgr('POST', `${L}/loans/${loan2}/renew`);
  check('renouvellement : accepté une fois la file vidée, échéance prolongée de 14 jours', r.status === 200 && r.json.renewals === 1, r.json);
  r = await mgr('POST', `${L}/loans/${loan2}/renew`);
  check('renouvellement : limité à 1 (réglage)', r.status === 400, r.json);

  // Limite de prêts simultanés (2)
  await mgr('POST', `${L}/records/${bookA}/loan`, {});
  r = await mgr('POST', `${L}/records/${iso}/loan`, {});
  check('prêt : nombre maximal de prêts en cours (2) atteint', r.status === 400, r.json);

  // Retard, pénalité, blocage automatique, rappels
  const past = new Date(Date.now() - 10 * day + 3600000).toISOString();
  await dbx.prepare('UPDATE lib_loans SET due_at = ? WHERE id = ?').run(past, loan2);
  r = await mgr('GET', `${L}/loans?scope=overdue`);
  check('retards : liste des prêts en retard (responsable)', r.json.loans.length === 1 && r.json.loans[0].lateDays === 10 && r.json.loans[0].fine === 5000, r.json.loans);
  r = await mem('GET', `${L}/loans?scope=all`);
  check('retards : liste complète réservée aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${L}/loans/${loan2}/renew`);
  check('retards : renouvellement refusé quand le prêt est en retard', r.status === 400, r.json);
  r = await owner('POST', `${L}/loans/remind`, {});
  check('rappels : un rappel de retard envoyé à l\'emprunteur', r.status === 200 && r.json.late === 1, r.json);
  const notices = await dbx.prepare("SELECT COUNT(*) AS c FROM notices WHERE org_id = ? AND user_id = ? AND kind = 'library'").get(org, mgrId);
  check('rappels : la notification apparaît dans l\'application', Number(notices.c) >= 1, notices);
  r = await owner('POST', `${L}/loans/remind`, {});
  check('rappels : pas de second rappel tout de suite (intervalle de 3 jours)', r.json.late === 0, r.json);
  r = await mgr('POST', `${L}/loans/${loan2}/return`, { condition: 'fair' });
  check('retour tardif : 10 jours × 500 = 5 000 de pénalité, blocage automatique (7 jours de retard ou plus)', r.json.lateDays === 10 && r.json.fine === 5000 && r.json.blocked === true, r.json);
  r = await mgr('POST', `${L}/records/${iso}/loan`, {});
  check('blocage : la personne bloquée ne peut plus emprunter', r.status === 403, r.json);
  r = await owner('GET', `${L}/borrowers/blocks`);
  check('blocage : visible dans la liste des blocages (automatique, avec motif)', r.json.blocks.length === 1 && r.json.blocks[0].auto && /Retard/.test(r.json.blocks[0].reason), r.json);
  const bid = r.json.blocks[0].id;
  r = await owner('GET', `${L}/loans?scope=history`);
  check('historique : le prêt rendu en retard avec sa pénalité', r.json.loans.some((l) => l.id === loan2 && l.fine === 5000 && l.returnedAt), r.json.loans);
  r = await owner('POST', `${L}/loans/${loan2}/pay`, {});
  check('pénalité : réglée', r.status === 200, r.json);
  r = await owner('POST', `${L}/loans/${loan2}/pay`, {});
  check('pénalité : pas de second règlement', r.status === 400, r.json);
  r = await mem('DELETE', `${L}/borrowers/blocks/${bid}`);
  check('blocage : seul un responsable le lève', r.status === 403, r.status);
  r = await owner('DELETE', `${L}/borrowers/blocks/${bid}`);
  r = await mgr('POST', `${L}/records/${iso}/loan`, {});
  const loan3 = r.json.id;
  check('blocage levé : la personne peut de nouveau emprunter', r.status === 201, r.json);
  r = await owner('POST', `${L}/borrowers/${memId}/block`, { days: 5, reason: 'Matériel non rendu' });
  r = await mem('POST', `${L}/records/${accueil}/loan`, {});
  check('blocage manuel : appliqué', r.status === 403, r.json);
  await owner('DELETE', `${L}/borrowers/blocks/${(await dbx.prepare('SELECT id FROM lib_borrower_blocks WHERE user_id = ? AND lifted_at IS NULL').get(memId)).id}`);

  // Rappel avant échéance, réservation non retirée
  await dbx.prepare('UPDATE lib_loans SET due_at = ? WHERE id = ?').run(new Date(Date.now() + 1 * day).toISOString(), loan3);
  r = await owner('POST', `${L}/loans/remind`, {});
  check('rappels : rappel avant échéance (à rendre demain)', r.json.before === 1, r.json);
  r = await mem('POST', `${L}/records/${iso}/reserve`, {});
  check('réservation : une ressource empruntée par un autre se réserve', r.status === 201, r.json);
  await mgr('POST', `${L}/loans/${loan3}/return`, {});
  await dbx.prepare("UPDATE lib_reservations SET ready_until = ? WHERE state = 'ready'").run(new Date(Date.now() - day).toISOString());
  r = await owner('POST', `${L}/loans/remind`, {});
  check('réservation : mise de côté non retirée → expire, la ressource redevient disponible', r.json.expired === 1, r.json);
  r = await mem('GET', `${L}/records/${iso}`);
  check('réservation expirée : ressource disponible', r.json.record.status === 'available', r.json.record);

  // Perte
  r = await mem('POST', `${L}/records/${accueil}/loan`, {});
  const loan4 = r.json.id;
  r = await mem('POST', `${L}/loans/${loan4}/return`, { lost: true });
  check('perte : seul un responsable déclare une ressource perdue', r.status === 403, r.status);
  r = await mgr('POST', `${L}/loans/${loan4}/return`, { lost: true });
  r = await mgr('GET', `${L}/records/${accueil}`);
  check('perte : ressource « perdue », état « perdu »', r.json.record.status === 'lost' && r.json.record.condition === 'lost', r.json.record);

  // Historiques
  r = await mgr('GET', `${L}/records/${drill}`);
  check('historique par ressource : 2 prêts avec les noms (responsable)', r.json.loans.length === 2 && r.json.loans.every((l) => l.user), r.json.loans);
  r = await mem('GET', `${L}/records/${drill}`);
  check('historique par ressource : un membre ne voit que ses propres prêts', r.json.loans.length === 1 && r.json.loans[0].userId === memId, r.json.loans);
  r = await mgr('GET', `${L}/people/${memId}/loans`);
  check('historique par personne : visible d\'un responsable', r.status === 200 && r.json.loans.length >= 2, r.json);
  r = await mem('GET', `${L}/people/${mgrId}/loans`);
  check('historique par personne : un membre ne voit pas celui d\'un collègue', r.status === 403, r.status);
  r = await mem('GET', `${L}/loans?scope=mine`);
  check('mes prêts : liste personnelle', r.status === 200 && Array.isArray(r.json.loans), r.json);

  // ---------- 4. Versions documentaires ----------
  const txt = (s) => Buffer.from(s, 'utf8');
  r = await owner('POST', `${L}/blocks/${COM}/docs?name=cgv.txt`, txt('Article 1\nArticle 2\nArticle 3\n'));
  const cgv = r.json.id;
  r = await owner('GET', `${L}/docs/${cgv}`);
  check('versions : le premier dépôt est la version 1.0, statut « publié »', r.json.versions[0].label === '1.0' && r.json.status === 'published', r.json.versions);
  r = await owner('POST', `${L}/docs/${cgv}/versions?name=cgv.txt&note=${encodeURIComponent('Ajout article 4')}`, txt('Article 1\nArticle 2\nArticle 3\nArticle 4\n'));
  r = await owner('POST', `${L}/docs/${cgv}/versions?name=cgv.txt&bump=major&note=${encodeURIComponent('Refonte')}`, txt('Article 1 (révisé)\nArticle 2\nArticle 4\n'));
  r = await owner('GET', `${L}/docs/${cgv}`);
  check('versions : numérotation mineure puis majeure (1.0 → 1.1 → 2.0), avec commentaire', r.json.versions.map((v) => v.label).join() === '2.0,1.1,1.0' && r.json.versions[0].note === 'Refonte' && r.json.versions[0].bump === 'major', r.json.versions);
  r = await owner('GET', `${L}/docs/${cgv}/compare?a=1&b=3`);
  check('comparaison : différences ligne à ligne (1 retirée, 1 modifiée, 1 ajoutée)', r.status === 200 && !r.json.identical && r.json.text && r.json.text.added >= 1 && r.json.text.removed >= 1 && r.json.text.lines.some((l) => l.op === '+' && l.text.includes('révisé')), r.json.text);
  r = await owner('GET', `${L}/docs/${cgv}/compare?a=2&b=2`);
  check('comparaison : deux fois la même version → identiques (empreinte SHA-256)', r.json.identical && r.json.a.sha256 === r.json.b.sha256, r.json);
  r = await owner('POST', `${L}/docs/${cgv}/versions/1/restore`);
  r = await owner('GET', `${L}/docs/${cgv}`);
  check('restauration : la version 1.0 devient une nouvelle version 2.1', r.json.versions[0].label === '2.1' && /rétablie/.test(r.json.versions[0].note), r.json.versions[0]);
  r = await owner('POST', `${L}/docs/${cgv}/lock`);
  check('verrou : le document est verrouillé pour modification', r.status === 200, r.json);
  r = await owner('GET', `${L}/docs/${cgv}`);
  check('verrou : la fiche indique le verrou (à moi)', r.json.lock && r.json.lock.mine, r.json.lock);
  r = await mgr('POST', `${L}/docs/${cgv}/versions?name=cgv.txt`, txt('Autre modification\n'));
  check('verrou : une autre personne ne peut pas déposer de version (423)', r.status === 423 && r.json.code === 'doc_locked', r.json);
  r = await mgr('POST', `${L}/docs/${cgv}/lock`);
  check('verrou : pas de second verrou par un autre', r.status === 423, r.status);
  r = await mgr('POST', `${L}/docs/${cgv}/unlock`);
  check('verrou : un responsable non administrateur ne force pas le déverrouillage', r.status === 403, r.status);
  r = await owner('POST', `${L}/docs/${cgv}/versions?name=cgv.txt&note=ok`, txt('Version par le verrouilleur\n'));
  check('verrou : la personne qui a verrouillé peut déposer sa version', r.status === 201, r.json);
  r = await owner('POST', `${L}/docs/${cgv}/unlock`);
  r = await mgr('POST', `${L}/docs/${cgv}/versions?name=cgv.txt`, txt('Après déverrouillage\n'));
  check('verrou : après déverrouillage, tout le monde peut déposer', r.status === 201, r.json);
  r = await owner('PUT', `${L}/docs/${cgv}/status`, { status: 'obsolete' });
  r = await owner('GET', `${L}/docs/${cgv}`);
  check('statut : le document passe à « obsolète »', r.json.status === 'obsolete', r.json.status);
  r = await owner('PUT', `${L}/docs/${cgv}/status`, { status: 'archive' });
  check('statut : valeur inconnue refusée', r.status === 400, r.json);
  r = await owner('POST', `${L}/docs/${docOffre}/lock`);
  await dbx.prepare('UPDATE lib_docs SET locked_by = ? WHERE id = ?').run(mgrId, docOffre);
  r = await owner('POST', `${L}/docs/${docOffre}/unlock`);
  r = await owner('GET', `${L}/docs/${docOffre}`);
  check('verrou : un administrateur lève le verrou d\'une personne absente', r.json.lock === null, r.json.lock);
  r = await mem('GET', `${L}/docs/${cgv}/compare?a=1&b=2`);
  check('comparaison : bloc fermé pour un autre → verrou de bibliothèque respecté', r.status === 403 || r.status === 404, r.status);
});
