'use strict';
// Bibliothèque : blocs protégés par le mot de passe de chacun, dossiers, documents chiffrés (PDF, texte, CSV), versions, corbeille,
// favoris et récents, recherche, droits par rôle et par personne, blocs masqués, journal d'audit propre au module, réglages.
const { password, pdf, txt, helpers } = require('./work-lib');

module.exports = async function library(ctx) {
  const { has, U, q, file } = helpers(ctx);
  const pass = password();
  const Lb = (ctx.ids.work.library = {});
  const W = ctx.ids.work;

  const ov = await ctx.do('Bibliothèque : accueil (blocs, espace utilisé)', 'GET', '/library/overview');
  const byName = Object.fromEntries((ov.blocks || []).map((b) => [b.name, b.id]));
  const blk = { mine: byName['Mes documents'], admin: byName.Administratif, com: byName.Commercial, proj: byName.Projets, rh: byName['Ressources humaines'], fin: byName['Comptabilité et finances'], jur: byName.Juridique };
  Lb.blocks = blk;
  ctx.check('Bibliothèque : les 7 blocs de départ existent', Object.values(blk).every(Boolean), byName);
  const unlock = (id, label, as = 'owner') => ctx.do(`Bibliothèque : entrer dans le bloc « ${label} » (mot de passe)`, 'POST', `/library/blocks/${id}/unlock`, { password: pass }, { as });

  // ---------- Entrée protégée ----------
  await ctx.do('Bibliothèque : un bloc fermé ne s\'ouvre pas sans mot de passe (refusé)', 'GET', `/library/blocks/${blk.proj}`, undefined, { expect: 403 });
  await ctx.do('Bibliothèque : mauvais mot de passe (refusé et journalisé)', 'POST', `/library/blocks/${blk.proj}/unlock`, { password: 'pas-le-bon' }, { expect: 403 });
  for (const [k, label] of [['proj', 'Projets'], ['admin', 'Administratif'], ['jur', 'Juridique'], ['mine', 'Mes documents'], ['fin', 'Comptabilité et finances']]) await unlock(blk[k], label);
  await ctx.do('Bibliothèque : ouvrir le bloc Projets', 'GET', `/library/blocks/${blk.proj}`);

  // ---------- Dossiers ----------
  const folder = async (block, name, parentId) => (await ctx.do(`Bibliothèque : créer le dossier « ${name} »`, 'POST', `/library/blocks/${block}/folders`, { name, parentId })).id;
  const fShow = await folder(blk.proj, 'Showroom Bonamoussadi');
  const fPlans = await folder(blk.proj, 'Plans et devis', fShow);
  const fKotto = await folder(blk.proj, 'Chantier école de Kotto');
  const fTmp = await folder(blk.proj, 'Nouveau dossier');
  await ctx.do('Bibliothèque : renommer un dossier', 'PUT', `/library/folders/${fTmp}`, { name: 'Archives foire 2026' });
  const fGone = await folder(blk.proj, 'Dossier vide à supprimer');
  await ctx.do('Bibliothèque : supprimer un dossier vide', 'DELETE', `/library/folders/${fGone}`);
  await ctx.do('Bibliothèque : ouvrir un sous-dossier (fil d\'Ariane)', 'GET', `/library/blocks/${blk.proj}${q({ folderId: fPlans })}`);

  // ---------- Documents ----------
  const up = async (block, name, buf, folderId, as = 'owner') => ctx.do(`Bibliothèque : déposer « ${name} »`, 'POST', `/library/blocks/${block}/docs${q({ name, folderId })}`, buf, { as });
  const devis = await up(blk.proj, 'Devis menuiserie Ndokoti Bâtiment.pdf', pdf('Devis n 2026-311 - Ndokoti Batiment', ['Faux plafond BA13 : 1 450 000 FCFA', 'Comptoirs et rayonnages : 2 350 000 FCFA', 'Total HT : 3 800 000 FCFA']), fPlans);
  const cr = await up(blk.proj, 'Compte rendu réunion de chantier.txt', txt("Réunion de chantier — showroom de Bonamoussadi\nPrésents : M. Ebongué, P. Tchinda, Ndokoti Bâtiment\n1. Carrelage zone sanitaires terminé à 80 %.\n2. Faux plafond : livraison des plaques jeudi.\n3. Prochaine réunion : lundi 8 h.\n"), fShow);
  const metre = await up(blk.proj, 'Métré carrelage.csv', txt('Zone;Surface m²;Cartons 1,44 m²\nExposition;120;84\nSanitaires;80;56\nRéserve;45;32\n'), fShow);
  const dbl = await up(blk.proj, 'Copie du devis.pdf', pdf('Copie'), fPlans);
  await up(blk.admin, 'Attestation de conformité fiscale 2026.pdf', pdf('Attestation de conformite fiscale 2026', ['Batimat Afrique SARL', 'Valable jusqu au 31/12/2026']));
  await up(blk.admin, 'Plan de localisation du dépôt de Bonabéri.pdf', pdf('Plan de localisation - Depot de Bonaberi'));
  const bail = await up(blk.jur, 'Bail commercial showroom (copie).pdf', pdf('Bail commercial - copie'));
  await up(blk.fin, 'Relevé bancaire octobre.pdf', pdf('Releve bancaire - octobre', ['Solde fin de mois : 18 450 000 FCFA']));
  await up(blk.mine, 'Notes personnelles de la gérante.txt', txt('Idées : ouvrir une 3e antenne à Kribi en 2027 ; négocier la remise Dangote.'));
  await ctx.do('Bibliothèque : un fichier exécutable est refusé (contenu vérifié)', 'POST', `/library/blocks/${blk.proj}/docs?name=outil.txt`, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff]), { expect: 400 });
  Lb.docs = { devis: devis.id, cr: cr.id, metre: metre.id };

  if (devis.id) {
    await ctx.do('Bibliothèque : classer un document (étiquettes, lien vers le projet)', 'PUT', `/library/docs/${devis.id}`, { tags: ['devis', 'showroom', 'menuiserie'], linkType: 'project', linkId: W.projects.showroom });
    await ctx.do('Bibliothèque : fiche du document (versions)', 'GET', `/library/docs/${devis.id}`);
    await file('Bibliothèque : télécharger le document', `/library/docs/${devis.id}/download`, 'application/pdf');
    await file('Bibliothèque : aperçu du PDF', `/library/docs/${devis.id}/preview`, 'application/pdf');
    await ctx.do('Bibliothèque : marquer en favori', 'POST', `/library/docs/${devis.id}/favorite`, { on: true });
    // Versions : le menuisier renvoie un devis révisé, puis on revient à l'original
    const v2 = await ctx.do('Bibliothèque : nouvelle version du devis (révisé)', 'POST', `/library/docs/${devis.id}/versions${q({ name: 'Devis menuiserie Ndokoti Bâtiment.pdf', note: 'Remise de 5 % négociée' })}`, pdf('Devis revise - remise 5 %', ['Total HT : 3 610 000 FCFA']));
    ctx.check('Bibliothèque : version 2 enregistrée', v2.version === 2, v2);
    await file('Bibliothèque : télécharger une ancienne version', `/library/docs/${devis.id}/download?version=1`, 'application/pdf');
    const v3 = await ctx.do('Bibliothèque : rétablir la version 1', 'POST', `/library/docs/${devis.id}/versions/1/restore`);
    ctx.check('Bibliothèque : la version 1 rétablie devient la version 3', v3.version === 3, v3);
    await ctx.do('Bibliothèque : supprimer une ancienne version', 'DELETE', `/library/docs/${devis.id}/versions/2`);
    await ctx.do('Bibliothèque : la version actuelle ne se supprime pas (refusé)', 'DELETE', `/library/docs/${devis.id}/versions/3`, undefined, { expect: 400 });
  }
  if (cr.id) {
    await ctx.do('Bibliothèque : renommer un document', 'PUT', `/library/docs/${cr.id}`, { name: 'CR réunion de chantier n° 4', tags: ['chantier', 'showroom'] });
    await ctx.do('Bibliothèque : pas d\'aperçu pour un fichier texte (téléchargement seulement)', 'GET', `/library/docs/${cr.id}/preview`, undefined, { expect: 400 });
    await file('Bibliothèque : télécharger le compte rendu', `/library/docs/${cr.id}/download`, 'text/plain');
    await ctx.do('Bibliothèque : mettre à la corbeille', 'DELETE', `/library/docs/${cr.id}`);
    await ctx.do('Bibliothèque : restaurer depuis la corbeille', 'POST', `/library/docs/${cr.id}/restore`);
  }
  if (bail.id && W.legal && W.legal.bail) await ctx.do('Bibliothèque : relier un document à un contrat', 'PUT', `/library/docs/${bail.id}`, { linkType: 'contract', linkId: W.legal.bail, tags: ['bail'] });
  if (dbl.id) {
    await ctx.do('Bibliothèque : mettre la copie à la corbeille', 'DELETE', `/library/docs/${dbl.id}`);
    const tr = await ctx.do('Bibliothèque : corbeille (30 jours)', 'GET', '/library/trash');
    ctx.check('Bibliothèque : la copie est dans la corbeille', (tr.docs || []).some((d) => d.id === dbl.id && d.daysLeft === 30), tr);
    await ctx.do('Bibliothèque : supprimer définitivement', 'DELETE', `/library/docs/${dbl.id}/purge`);
  }
  await ctx.do('Bibliothèque : favoris', 'GET', '/library/favorites');
  await ctx.do('Bibliothèque : documents récents', 'GET', '/library/recent');
  const se = await ctx.do('Bibliothèque : rechercher « devis »', 'GET', '/library/search?q=devis');
  ctx.check('Bibliothèque : la recherche trouve le devis', (se.docs || []).some((d) => d.id === devis.id), se);
  await ctx.do('Bibliothèque : rechercher par étiquette', 'GET', '/library/search?tag=showroom');
  await ctx.do('Bibliothèque : rechercher dans un bloc', 'GET', `/library/blocks/${blk.proj}?q=devis`);
  await ctx.do('Bibliothèque : filtrer un bloc par étiquette et trier par date', 'GET', `/library/blocks/${blk.proj}?tag=showroom&sort=date`);
  const stb = await ctx.do('Bibliothèque : statistiques du bloc Projets', 'GET', `/library/blocks/${blk.proj}/stats`);
  ctx.check('Bibliothèque : 3 documents et 4 dossiers dans le bloc Projets', stb.documents === 3 && stb.folders === 4, stb);

  // ---------- Blocs et droits (administrateurs) ----------
  const dg = (await ctx.do('Bibliothèque : créer un bloc masqué « Direction générale »', 'POST', '/library/blocks', { name: 'Direction générale', color: '#7f1d1d', icon: 'star', hidden: true })).id;
  Lb.blocks.dg = dg;
  if (dg) {
    await ctx.do('Bibliothèque : modifier le bloc', 'PUT', `/library/blocks/${dg}`, { name: 'Direction générale — confidentiel', hidden: false });
    await ctx.do('Bibliothèque : droits du bloc', 'GET', `/library/blocks/${dg}/perms`);
    await ctx.do('Bibliothèque : droits par rôle et exception pour une personne', 'PUT', `/library/blocks/${dg}/perms`, { roles: { manager: { view: true, read: true }, member: {} }, users: [{ userId: U('accountant'), view: true, read: true, add: true, edit: true, delete: false }] });
    await unlock(dg, 'Direction générale');
    await up(dg, 'Plan stratégique 2027-2029.pdf', pdf('Plan strategique 2027-2029', ['Objectif CA 2027 : 1,2 milliard FCFA', '3e antenne : Kribi']));
  }
  const tmpB = (await ctx.do('Bibliothèque : créer un bloc temporaire', 'POST', '/library/blocks', { name: 'Archives 2019', icon: 'box' })).id;
  if (tmpB) await ctx.do('Bibliothèque : supprimer un bloc vide', 'DELETE', `/library/blocks/${tmpB}`);
  await ctx.do('Bibliothèque : un bloc de départ ne se supprime pas (refusé)', 'DELETE', `/library/blocks/${blk.admin}`, undefined, { expect: 400 });
  await ctx.do('Bibliothèque : réglages (durée d\'ouverture)', 'GET', '/library/settings');
  await ctx.do('Bibliothèque : régler l\'ouverture à 20 min (3 h au plus)', 'PUT', '/library/settings', { grantMinutes: 20, grantMaxMinutes: 180, maxFileMb: 0 });

  // ---------- L'équipe dans la bibliothèque (droits) ----------
  if (has('seller')) {
    const so = await ctx.do('Bibliothèque : accueil vu par la commerciale', 'GET', '/library/overview', undefined, { as: 'seller' });
    ctx.check('Droits : la commerciale ne voit ni les RH ni la Direction générale', !(so.blocks || []).some((b) => b.id === blk.rh || b.id === dg), (so.blocks || []).map((b) => b.name));
    await ctx.do('Droits : bloc RH invisible pour un membre (introuvable)', 'POST', `/library/blocks/${blk.rh}/unlock`, { password: pass }, { as: 'seller', expect: 404 });
    await unlock(blk.com, 'Commercial', 'seller');
    const tar = await up(blk.com, 'Tarifs chantier novembre 2026.csv', txt('Article;Prix public;Prix chantier\nCiment CPJ 42,5;5 200;4 950\nFer HA 10;4 800;4 600\nTôle bac alu 6/10;8 900;8 500\n'), undefined, 'seller');
    if (tar.id) await ctx.do('Droits : un membre ne peut pas supprimer dans le bloc Commercial (refusé)', 'DELETE', `/library/docs/${tar.id}`, undefined, { as: 'seller', expect: 403 });
    await unlock(blk.mine, 'Mes documents', 'seller');
    await up(blk.mine, 'Mes prospects à relancer.txt', txt('Quincaillerie de Logbaba ; Chantier Bonapriso (M. Din) ; Hôtel de Kribi.'), undefined, 'seller');
    const sm = await ctx.do('Bibliothèque : le bloc personnel de la commerciale', 'GET', `/library/blocks/${blk.mine}`, undefined, { as: 'seller' });
    ctx.check('Droits : chacun ne voit que ses propres documents personnels', (sm.docs || []).length === 1, (sm.docs || []).map((d) => d.name));
    await ctx.do('Bibliothèque : refermer un bloc', 'POST', `/library/blocks/${blk.com}/lock`, undefined, { as: 'seller' });
    await ctx.do('Bibliothèque : un bloc refermé redemande le mot de passe', 'GET', `/library/blocks/${blk.com}`, undefined, { as: 'seller', expect: 403 });
  }
  if (has('storekeeper')) {
    await unlock(blk.proj, 'Projets', 'storekeeper');
    await up(blk.proj, 'Bon de livraison lot 1 école de Kotto.pdf', pdf('Bon de livraison BL-2611 - Ecole de Kotto', ['600 sacs CPJ 42,5', 'Recu par : service technique CUD5']), fKotto, 'storekeeper');
  }
  if (has('manager') && dg) {
    await unlock(dg, 'Direction générale', 'manager');
    await ctx.do('Droits : un responsable lit la Direction générale sans pouvoir y déposer (refusé)', 'POST', `/library/blocks/${dg}/docs?name=note.txt`, txt('note'), { as: 'manager', expect: 403 });
  }
  const au = await ctx.do('Bibliothèque : journal d\'audit du module', 'GET', '/library/audit');
  ctx.check('Bibliothèque : le mot de passe raté est journalisé', (au.entries || []).some((e) => e.action === 'unlock_fail'), (au.entries || []).slice(0, 3));
  await ctx.do('Bibliothèque : journal filtré (refus d\'accès)', 'GET', '/library/audit?action=denied');
  await ctx.do('Bibliothèque : tout refermer en partant', 'POST', '/library/lock-all', undefined, { as: 'manager' });
};
