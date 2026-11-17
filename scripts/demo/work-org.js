'use strict';
// Organisation (postes, organigramme), Fonctionnement (procédures versionnées, accusés de lecture, révisions), Mémoire de l'entreprise,
// Décisions (circuit de validation par montant, délégation, rappels), Équipe et antennes (membres, invitations, avis, journal d'audit).
const { helpers } = require('./work-lib');

module.exports = async function org(ctx) {
  const { has, U } = helpers(ctx);
  const O = (ctx.ids.work.org = {});
  const B = ctx.ids.branches; const W = ctx.ids.work;

  // ---------- Équipe et antennes ----------
  await ctx.do('Équipe : fiche de l\'organisation (modules, limites)', 'GET', '');
  await ctx.do('Équipe : membres', 'GET', '/members', undefined, { as: 'manager' });
  const mem = await ctx.do('Équipe : membres vus par un membre (sans coordonnées)', 'GET', '/members', undefined, { as: 'driver' });
  if (has('driver')) ctx.check('Droits : les coordonnées sont masquées aux membres', (mem.members || []).every((m) => m.contact === undefined), (mem.members || [])[0]);
  if (has('driver')) await ctx.do('Équipe : changer la fonction d\'un membre', 'PUT', `/members/${U('driver')}`, { title: 'Chauffeur-livreur poids lourd (permis C)' });
  if (has('seller')) await ctx.do('Équipe : rattacher la commerciale à l\'antenne de Douala', 'PUT', `/members/${U('seller')}`, { branchId: B.douala }, { as: 'accountant' });
  if (has('manager')) await ctx.do('Droits : seul le propriétaire nomme un administrateur (refusé)', 'PUT', `/members/${U('manager')}`, { role: 'admin' }, { as: 'accountant', expect: 403 });
  await ctx.do('Équipe : modifier une antenne', 'PUT', `/branches/${B.yaounde}`, { location: 'Zone industrielle de Mvan, route de Nsimalen, Yaoundé' });
  const br = (await ctx.do('Équipe : ajouter une antenne (point de vente de Kribi, en projet)', 'POST', '/branches', { name: 'Point de vente de Kribi (projet)', location: 'Kribi, route du port' })).id;
  if (br) await ctx.do('Équipe : supprimer une antenne', 'DELETE', `/branches/${br}`);
  const inv = await ctx.do('Équipe : inviter un vendeur pour le showroom', 'POST', '/invites', { role: 'member', title: 'Vendeur showroom', branchId: B.douala, days: 14 });
  const inv2 = await ctx.do('Équipe : inviter une seconde personne', 'POST', '/invites', { role: 'manager', title: 'Chef d\'agence de Yaoundé', branchId: B.yaounde });
  await ctx.do('Équipe : invitations en cours', 'GET', '/invites');
  if (inv2.code) await ctx.do('Équipe : annuler une invitation', 'DELETE', `/invites/${inv2.code}`);
  if (has('seller')) await ctx.do('Droits : un membre ne peut pas inviter (refusé)', 'POST', '/invites', { role: 'member' }, { as: 'seller', expect: 403 });
  // Une personne rejoint puis quitte l'équipe (seulement en local : on ne crée pas de vrais comptes en ligne)
  if (has('seller') && inv.code) {
    const { client } = require('./lib');
    const c = client(ctx.base);
    const reg = await c('POST', '/api/register', { name: 'Rodrigue Mbappé', contact: `vendeur.${Date.now().toString(36)}@batimat-demo.example`, pass: 'Demo-Batimat-2026' });
    const j = reg.status < 300 ? await c('POST', '/api/ws/orgs/join', { code: inv.code }) : reg;
    ctx.check('Équipe : le vendeur rejoint avec son code d\'invitation', j.status < 300, j.json);
    const me = await c('GET', '/api/me');
    const nid = me.json && (me.json.user ? me.json.user.id : me.json.id);
    if (nid) await ctx.do('Équipe : retirer une personne de l\'équipe', 'DELETE', `/members/${nid}`, undefined, { as: 'accountant' });
  }
  await ctx.do('Équipe : transfert de propriété sans confirmation exacte (refusé)', 'POST', '/ownership-transfer', { userId: U('manager'), confirm: 'batimat' }, { expect: 400 });

  // ---------- Organisation : postes et organigramme ----------
  const pos = async (key, body) => { O[key] = (await ctx.do(`Organisation : poste « ${body.title} »`, 'POST', '/structure/positions', body)).id; return O[key]; };
  await pos('dg', { title: 'Gérante — Direction générale', holderId: ctx.ids.ownerId, description: 'Stratégie, banques, grands comptes.' });
  await pos('dop', { title: 'Directeur des opérations', parentId: O.dg, holderId: U('manager'), description: 'Dépôts, livraisons, achats, projets.' });
  await pos('raf', { title: 'Responsable administrative et financière', parentId: O.dg, holderId: U('accountant'), description: 'Comptabilité, paie, fiscalité, juridique.' });
  await pos('mag', { title: 'Chef magasinier — Douala', parentId: O.dop, holderId: U('storekeeper'), branchId: B.douala });
  await pos('com', { title: 'Commerciale grands comptes', parentId: O.dop, holderId: U('seller') });
  await pos('chauf', { title: 'Chauffeur-livreur', parentId: O.mag, holderId: U('driver'), branchId: B.douala });
  await pos('agence', { title: 'Chef d\'agence — Yaoundé', parentId: O.dop, branchId: B.yaounde, description: 'Poste à pourvoir : gestion du dépôt de Mvan.' });
  await pos('vend', { title: 'Vendeur showroom', parentId: O.com, branchId: B.douala, description: 'Deux postes à pourvoir pour l\'ouverture.' });
  await pos('tmp', { title: 'Poste en double' });
  await ctx.do('Organisation : modifier un poste', 'PUT', `/structure/positions/${O.vend}`, { description: 'Deux vendeurs (CDI) pour le showroom de Bonamoussadi, ouverture dans 6 semaines.' });
  await ctx.do('Organisation : une boucle dans la hiérarchie est refusée', 'PUT', `/structure/positions/${O.dg}`, { parentId: O.chauf }, { expect: 400 });
  await ctx.do('Organisation : supprimer un poste', 'DELETE', `/structure/positions/${O.tmp}`);
  const ap = await ctx.do("Assistant IA : appliquer l'organigramme proposé (postes ajoutés)", 'POST', '/ai/apply', { kind: 'org-structure', proposal: { positions: [{ title: 'Responsable des achats', reportsTo: 'Directeur des opérations', description: 'Négociation fournisseurs, importations.' }, { title: 'Caissière — Douala', reportsTo: 'Responsable administrative et financière' }, { title: 'Directeur des opérations' }] } });
  ctx.check('Organisation : l\'IA n\'ajoute pas de doublon (2 postes créés sur 3 proposés)', ap.created === 2, ap);
  const pl = await ctx.do('Organisation : organigramme', 'GET', '/structure/positions', undefined, { as: 'seller' });
  ctx.check('Organisation : 10 postes dans l\'organigramme', (pl.positions || []).length >= 10, (pl.positions || []).length);
  const vac = await ctx.do('Organisation : postes vacants', 'GET', '/structure/vacancies', undefined, { as: 'seller' });
  ctx.check('Organisation : postes à pourvoir repérés (chef d\'agence, vendeurs…)', (vac.items || []).length >= 3, vac.items);
  if (has('seller')) await ctx.do('Droits : un membre ne modifie pas l\'organigramme (refusé)', 'POST', '/structure/positions', { title: 'x' }, { as: 'seller', expect: 403 });

  // ---------- Fonctionnement : procédures ----------
  const proc = async (key, body) => { O[key] = (await ctx.do(`Procédures : « ${body.title} »`, 'POST', '/structure/processes', body)).id; return O[key]; };
  await proc('reception', { title: "Réception d'une livraison fournisseur", category: 'Stock', ownerId: U('storekeeper'), reviewMonths: 12, steps: ['Vérifier le bon de commande et le bon de livraison', 'Compter les sacs / barres et contrôler la casse', 'Saisir la réception dans Brij-IA (scanner)', 'Signer le bon de livraison avec réserves éventuelles', 'Ranger selon le plan du dépôt (premier entré, premier sorti)'] });
  await proc('livraison', { title: 'Livraison sur chantier', category: 'Logistique', ownerId: U('manager'), reviewMonths: 6, steps: ['Préparer la commande et le bon de livraison', 'Charger le camion (poids maximum 10 t)', 'Appeler le client 30 minutes avant', 'Faire signer le bon et photographier le déchargement'] });
  await proc('caisse', { title: 'Clôture de caisse du soir', category: 'Finance', ownerId: U('accountant'), reviewMonths: 3, steps: ['Compter les espèces', 'Rapprocher les paiements Mobile Money', 'Déposer le surplus au coffre', 'Signer la feuille de caisse'] });
  await proc('tmp', { title: 'Procédure en double', steps: ['Étape'] });
  const up = await ctx.do('Procédures : mettre à jour (nouvelle version, l\'équipe est prévenue)', 'PUT', `/structure/processes/${O.livraison}`, { steps: ['Préparer la commande et le bon de livraison', 'Charger le camion (poids maximum 10 t, sangles obligatoires)', 'Appeler le client 30 minutes avant', 'Faire signer le bon et photographier le déchargement', 'Encaisser le solde si paiement à la livraison'] });
  ctx.check('Procédures : version 2 créée', up.version === 2, up);
  await ctx.do('Procédures : changer le responsable et la révision (sans nouvelle version)', 'PUT', `/structure/processes/${O.caisse}`, { reviewMonths: 6 });
  await ctx.do('Procédures : supprimer une procédure', 'DELETE', `/structure/processes/${O.tmp}`);
  const apd = await ctx.do("Assistant IA : appliquer une procédure proposée (retour de marchandise)", 'POST', '/ai/apply', { kind: 'process-draft', proposal: { title: "Retour de marchandise d'un client", category: 'Ventes', steps: ['Vérifier la facture d\'origine', 'Contrôler l\'état de la marchandise', 'Faire valider l\'avoir par le responsable', 'Remettre en stock ou déclarer la casse'] } });
  ctx.check('Procédures : procédure créée depuis la proposition', Boolean(apd.id), apd);
  await ctx.do('Procédures : accusé de lecture (chauffeur)', 'POST', `/structure/processes/${O.livraison}/read`, undefined, { as: 'driver' });
  await ctx.do('Procédures : accusé de lecture (magasinier)', 'POST', `/structure/processes/${O.livraison}/read`, undefined, { as: 'storekeeper' });
  await ctx.do('Procédures : accusé de lecture (magasinier, réception)', 'POST', `/structure/processes/${O.reception}/read`, undefined, { as: 'storekeeper' });
  const rd = await ctx.do('Procédures : qui a lu la version en cours', 'GET', `/structure/processes/${O.livraison}/reads`, undefined, { as: 'manager' });
  if (has('driver')) ctx.check('Procédures : 2 lectures de la version 2', (rd.items || []).filter((r) => r.readAt).length === 2, rd);
  await ctx.do('Procédures : historique des versions', 'GET', `/structure/processes/${O.livraison}/versions`, undefined, { as: 'driver' });
  await ctx.do('Procédures : révision faite par son responsable', 'POST', `/structure/processes/${O.reception}/reviewed`, undefined, { as: 'storekeeper' });
  if (has('seller')) await ctx.do('Droits : seul le responsable de la procédure valide sa révision (refusé)', 'POST', `/structure/processes/${O.caisse}/reviewed`, undefined, { as: 'seller', expect: 403 });
  await ctx.do('Procédures : révisions à faire', 'GET', '/structure/processes-due', undefined, { as: 'manager' });
  const prl = await ctx.do('Procédures : liste (lu / non lu)', 'GET', '/structure/processes', undefined, { as: 'driver' });
  if (has('driver')) ctx.check('Procédures : le chauffeur voit ce qu\'il a déjà lu', (prl.processes || []).some((p) => p.id === O.livraison && p.readByMe), null);

  // ---------- Mémoire de l'entreprise ----------
  const C = ctx.ids.customers; const S = ctx.ids.suppliers;
  const mem1 = async (body, as = 'manager') => (await ctx.do(`Mémoire : ${body.kind} « ${body.title} »`, 'POST', '/memory', body, { as })).id;
  const memIds = [];
  memIds.push(await mem1({ kind: 'decision', title: 'Ouverture d\'un showroom à Bonamoussadi', date: ctx.day(-95), tags: 'showroom, stratégie, douala', linkKind: 'project', linkId: W.projects.showroom, content: "Comité de direction : les particuliers et architectes représentent 22 % du chiffre d'affaires mais n'ont pas d'espace d'exposition. Décision d'ouvrir un showroom de 400 m² à Bonamoussadi, budget plafonné à 15 millions FCFA, ouverture visée avant les fêtes." }));
  memIds.push(await mem1({ kind: 'incident', title: 'Rupture de ciment CPJ 42,5 pendant 4 jours', date: ctx.day(-150), tags: 'stock, ciment, rupture', linkKind: 'supplier', linkId: S.cimencam, content: "L'usine de Bonabéri a arrêté une ligne pour maintenance sans prévenir. 4 jours sans ciment, environ 3 200 sacs de ventes perdues. Leçon : garder 5 jours de stock de sécurité et un second fournisseur (Dangote)." }));
  memIds.push(await mem1({ kind: 'lesson', title: 'Toujours faire signer le bon de livraison sur chantier', date: ctx.day(-120), tags: 'livraison, litige', linkKind: 'customer', linkId: C.bati, content: "Litige avec Bâti Plus sur 40 barres de fer prétendument non livrées : sans bon signé, nous avons dû faire un avoir de 192 000 FCFA. Depuis, photo du déchargement et signature obligatoires." }, 'storekeeper'));
  memIds.push(await mem1({ kind: 'contract', title: 'Remise de 4 % négociée avec Cimencam', date: ctx.day(-340), tags: 'achats, ciment, remise', linkKind: 'supplier', linkId: S.cimencam, content: 'Contrat annuel : 4 % de remise à partir de 24 000 sacs par an, paiement à 30 jours fin de mois. Renouvellement à négocier avant la date de préavis.' }));
  memIds.push(await mem1({ kind: 'meeting', title: 'Réunion commerciale mensuelle d\'octobre', date: ctx.day(-28), tags: 'ventes, réunion', content: "CA d'octobre en hausse de 9 %. Sogea Satom demande des livraisons de nuit sur la Nationale 3. Objectif novembre : 3 nouveaux comptes BTP à Yaoundé." }, 'seller'));
  memIds.push(await mem1({ kind: 'history', title: 'Historique Commune de Douala 5e', date: ctx.day(-60), tags: 'marché public, paiement', linkKind: 'customer', linkId: C.mairie, content: 'Marchés publics réglés en moyenne à 95 jours. Toujours déposer les factures au service financier avec copie du bon de commande et de l\'attestation de service fait.' }));
  memIds.push(await mem1({ kind: 'procedure', title: 'Prix plancher sur le fer à béton', date: ctx.day(-45), tags: 'prix, fer, remise', restricted: true, content: 'Ne jamais descendre sous 4 450 FCFA la barre de HA 10 et 6 300 FCFA la barre de HA 12, même pour les grands comptes. Réservé aux responsables.' }));
  const tmpM = await mem1({ kind: 'other', title: 'Note en double', content: 'à supprimer' });
  if (has('seller')) await ctx.do('Droits : un membre ne peut pas réserver une note aux responsables (refusé)', 'POST', '/memory', { title: 'Secret', content: 'x', restricted: true }, { as: 'seller', expect: 403 });
  const up1 = await ctx.do('Mémoire : compléter une entrée (nouvelle version)', 'PUT', `/memory/${memIds[1]}`, { content: "L'usine de Bonabéri a arrêté une ligne pour maintenance sans prévenir. 4 jours sans ciment, environ 3 200 sacs de ventes perdues. Leçon : garder 5 jours de stock de sécurité et un second fournisseur (Dangote). Seuil minimum du ciment relevé à 200 sacs dans Brij-IA." });
  ctx.check('Mémoire : version 2', up1.version === 2, up1);
  await ctx.do('Mémoire : détail et versions', 'GET', `/memory/${memIds[1]}`, undefined, { as: 'seller' });
  if (has('seller')) {
    await ctx.do('Droits : un membre ne voit pas une note réservée (introuvable)', 'GET', `/memory/${memIds[6]}`, undefined, { as: 'seller', expect: 404 });
    await ctx.do('Droits : un membre ne modifie pas la note d\'un autre (refusé)', 'PUT', `/memory/${memIds[0]}`, { title: 'x' }, { as: 'seller', expect: 403 });
  }
  await ctx.do('Mémoire : supprimer une entrée', 'DELETE', `/memory/${tmpM}`);
  const ms = await ctx.do('Mémoire : rechercher « livraison » (pluriels et accents ignorés)', 'GET', '/memory?q=livraisons', undefined, { as: 'seller' });
  ctx.check('Mémoire : la recherche trouve la leçon sur les bons de livraison', (ms.entries || []).some((e) => e.id === memIds[2]), (ms.entries || []).map((e) => e.title));
  await ctx.do('Mémoire : filtrer par type et étiquette', 'GET', '/memory?kind=incident&tag=ciment');
  await ctx.do('Mémoire : filtrer par période', 'GET', `/memory?from=${ctx.day(-130)}&to=${ctx.day(0)}`);
  const ml = await ctx.do('Mémoire : accueil (indicateurs, étiquettes)', 'GET', '/memory');
  ctx.check('Mémoire : 7 entrées et des étiquettes', ml.kpis && ml.kpis.total >= 7 && (ml.tags || []).length > 3, ml.kpis);
  await ctx.do('Mémoire : éléments à relier (clients, fournisseurs, projets)', 'GET', '/memory/links');
  await ctx.do('Mémoire : export JSON', 'GET', '/memory/export');
  const mc = await ctx.do('Mémoire : export CSV', 'GET', '/memory/export?format=csv', undefined, { raw: true });
  ctx.check('Mémoire : export CSV avec les entrées', mc.status === 200 && /Ouverture d'un showroom/.test(mc.text), mc.status);

  // ---------- Décisions : circuit de validation ----------
  await ctx.do('Décisions : seuils du circuit (0 → responsable, 1 M → administrateur, 5 M → propriétaire)', 'PUT', '/decisions/rules', { rules: [{ minAmount: 0, role: 'manager' }, { minAmount: 1000000, role: 'admin' }, { minAmount: 5000000, role: 'owner' }] }, { as: 'accountant' });
  await ctx.do('Décisions : lire les seuils', 'GET', '/decisions/rules', undefined, { as: 'manager' });
  const D = (O.decisions = {});
  const dec = async (key, body, as) => { D[key] = (await ctx.do(`Décisions : soumettre « ${body.title} »`, 'POST', '/decisions', body, { as })).id; return D[key]; };
  await dec('remise', { title: 'Remise exceptionnelle de 8 % — Sogea Satom (lot routes N3)', detail: 'Commande de 2 400 sacs de ciment, concurrence Dangote à 4 900 FCFA.', amount: 998400 }, 'seller');
  await dec('chariot', { title: "Achat d'un chariot élévateur d'occasion (3 t)", detail: 'Toyota 2018, 4 200 h, révisé. Gain : déchargement des camions en 40 min au lieu de 2 h.', amount: 6500000, linkKind: 'project', linkId: W.projects.yaounde }, 'storekeeper');
  await dec('clim', { title: 'Climatiseurs supplémentaires pour le showroom', detail: '2 splits de plus pour la zone carrelage.', amount: 1150000, linkKind: 'project', linkId: W.projects.showroom }, 'manager');
  await dec('carbu', { title: 'Avance carburant pour la tournée de Yaoundé', amount: 180000 }, 'driver');
  await dec('pneus', { title: 'Remplacement de 6 pneus du camion LT 482 AB', amount: 1680000 }, 'driver');
  if (has('manager')) await ctx.do('Droits : on ne valide pas sa propre demande (refusé)', 'PUT', `/decisions/${D.clim}`, { status: 'approved' }, { as: 'manager', expect: 403 });
  await ctx.do('Décisions : le responsable valide la remise', 'PUT', `/decisions/${D.remise}`, { status: 'approved', note: 'Accordé pour ce lot uniquement.' }, { as: 'manager' });
  const c1 = await ctx.do('Décisions : chariot — niveau 1 validé (responsable)', 'PUT', `/decisions/${D.chariot}`, { status: 'approved' }, { as: 'manager' });
  ctx.check('Décisions : le chariot passe au niveau suivant', c1.status === 'pending', c1);
  if (has('manager')) await ctx.do('Droits : niveau « Administrateur » requis (refusé au responsable)', 'PUT', `/decisions/${D.chariot}`, { status: 'approved' }, { as: 'manager', expect: 403 });
  await ctx.do('Décisions : chariot — niveau 2 validé (administratrice)', 'PUT', `/decisions/${D.chariot}`, { status: 'approved', note: 'Budget disponible sur le projet de Yaoundé.' }, { as: 'accountant' });
  const c3 = await ctx.do('Décisions : chariot — refusé par la gérante', 'PUT', `/decisions/${D.chariot}`, { status: 'rejected', note: 'Attendre la fin des travaux du hangar ; louer en attendant.' });
  ctx.check('Décisions : refus d\'approbation au dernier niveau', c3.status === 'rejected', c3);
  await ctx.do('Décisions : refuser l\'avance carburant (déjà couverte)', 'PUT', `/decisions/${D.carbu}`, { status: 'rejected', note: 'Utiliser la carte carburant.' }, { as: 'manager' });
  await ctx.do('Décisions : une décision traitée ne se revalide pas', 'PUT', `/decisions/${D.remise}`, { status: 'approved' }, { as: 'accountant', expect: 409 });
  if (has('accountant')) await ctx.do('Décisions : délégation de la gérante à l\'administratrice (congés)', 'POST', '/decisions/delegations', { toUserId: U('accountant'), until: ctx.day(14) });
  const dl = await ctx.do('Décisions : délégations en cours', 'GET', '/decisions/delegations', undefined, { as: 'manager' });
  const tmpDl = has('manager') ? (await ctx.do('Décisions : délégation du responsable (à retirer)', 'POST', '/decisions/delegations', { toUserId: U('storekeeper'), until: ctx.day(3) }, { as: 'manager' })).id : null;
  if (tmpDl) await ctx.do('Décisions : retirer une délégation', 'DELETE', `/decisions/delegations/${tmpDl}`, undefined, { as: 'manager' });
  if (has('accountant')) ctx.check('Décisions : la délégation est listée', (dl.delegations || []).length >= 1, dl);
  await ctx.do('Décisions : rappel aux validateurs', 'POST', `/decisions/${D.pneus}/remind`, undefined, { as: 'manager' });
  await ctx.do('Décisions : en attente', 'GET', '/decisions', undefined, { as: 'manager' });
  const da = await ctx.do('Décisions : historique complet', 'GET', '/decisions?status=all', undefined, { as: 'manager' });
  ctx.check('Décisions : 5 demandes (validées, refusées, en attente)', (da.decisions || []).filter((d) => Object.values(D).includes(d.id)).length === 5, (da.decisions || []).length);
  const mine = await ctx.do('Décisions : mes demandes (chauffeur)', 'GET', '/decisions?status=all', undefined, { as: 'driver' });
  if (has('driver')) ctx.check('Droits : un membre ne voit que ses demandes', (mine.decisions || []).every((d) => [D.carbu, D.pneus].includes(d.id)), (mine.decisions || []).map((d) => d.title));

  // ---------- Avis internes et journal d'audit ----------
  const nt = await ctx.do('Avis : notifications du magasinier', 'GET', '/notices', undefined, { as: 'storekeeper' });
  if (has('storekeeper')) ctx.check('Avis : le magasinier a été prévenu (commentaire, procédure, décision…)', nt.unread >= 2, nt.unread);
  if ((nt.items || []).length) await ctx.do('Avis : marquer une notification lue', 'POST', '/notices/read', { ids: [nt.items[0].id] }, { as: 'storekeeper' });
  await ctx.do('Avis : tout marquer lu', 'POST', '/notices/read', {}, { as: 'driver' });
  await ctx.do('Avis : notifications de la gérante', 'GET', '/notices');
  const au = await ctx.do("Journal d'audit : toutes les actions (avant / après)", 'GET', '/audit?limit=200', undefined, { as: 'accountant' });
  ctx.check("Journal d'audit : des entités variées sont tracées", (au.entities || []).length >= 6, au.entities);
  await ctx.do("Journal d'audit : filtrer par entité et période", 'GET', `/audit?entity=decision&from=${ctx.day(-1)}&to=${ctx.day(0)}`, undefined, { as: 'accountant' });
  if (has('storekeeper')) await ctx.do("Journal d'audit : filtrer par personne", 'GET', `/audit?userId=${U('storekeeper')}`);
  if (has('manager')) await ctx.do("Droits : le journal d'audit est réservé aux administrateurs (refusé)", 'GET', '/audit', undefined, { as: 'manager', expect: 403 });
  await ctx.do("Équipe : journal d'activité", 'GET', '/activity', undefined, { as: 'seller' });
};
