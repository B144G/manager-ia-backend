'use strict';
// Projets et tâches : projets, jalons, tâches assignées, dépendances, temps passé, budget et coûts, planning (Gantt), replanification,
// plan de référence, risques, pilotage (valeur acquise, portefeuille), charge, pièces jointes, tâches récurrentes, partage des rapports PDF.
const { pdf, helpers } = require('./work-lib');

module.exports = async function projects(ctx) {
  const { has, U, q, file } = helpers(ctx);
  const W = ctx.ids.work;
  const B = ctx.ids.branches;
  const P = (W.projects = {});
  const T = (W.tasks = {});

  // ---------- Réglages du module (coût horaire, alerte budget) ----------
  await ctx.do('Projets : réglages (coût horaire 3 500 FCFA, alerte à 80 % du budget)', 'PUT', '/projects/settings', { project_hourly_cost: 3500, project_budget_alert_pct: 80, project_auto_shift: 0 });
  const st = await ctx.do('Projets : lire les réglages (membre)', 'GET', '/projects/settings', undefined, { as: 'storekeeper' });
  ctx.check('Projets : le coût horaire est bien enregistré', st.settings && st.settings.project_hourly_cost === 3500, st);

  // ---------- Projets ----------
  const mk = async (key, body, as = 'manager') => { P[key] = (await ctx.do(`Projets : créer « ${body.name} »`, 'POST', '/projects', body, { as })).id; return P[key]; };
  await mk('showroom', { name: 'Ouverture du showroom de Bonamoussadi', description: "Nouveau point de vente de 400 m² au carrefour de Bonamoussadi (Douala) : carrelage, sanitaires, peinture et quincaillerie fine exposés, conseil aux particuliers et aux architectes.", due: ctx.day(40), branchId: B.douala });
  await mk('ecole', { name: 'Marché CUD 5e — école publique de Kotto', description: "Fourniture des matériaux de construction de 6 salles de classe pour la Commune de Douala 5e (bon de commande n° 2026/CUD5/114) : livraisons échelonnées sur chantier, réception provisoire puis facturation.", due: ctx.day(55), branchId: B.douala });
  await mk('mabah', { name: 'Déploiement de MABAH et inventaire tournant', description: 'Former les équipes, paramétrer les seuils de réapprovisionnement et faire un inventaire tournant complet des deux dépôts.', due: ctx.day(-4) });
  await mk('foire', { name: 'Stand à la Foire des matériaux de Douala 2026', description: 'Stand de 36 m² à la foire annuelle : démonstrations de pose de carreaux, prix salon, collecte de contacts.', due: ctx.day(-30), branchId: B.douala });
  // Créé par une proposition de l'IA validée par le responsable (aucun appel à l'IA : la proposition est appliquée telle quelle).
  P.yaounde = (await ctx.do("Assistant IA : appliquer un plan de projet proposé (« Extension du dépôt de Yaoundé »)", 'POST', '/ai/apply', { kind: 'project-plan', proposal: {
    name: 'Extension du dépôt de Yaoundé (Mvan)', description: "Hangar supplémentaire de 600 m² pour le stockage du fer et des tôles, quai de déchargement et clôture.", due: ctx.day(120), branchId: B.yaounde,
    tasks: [{ title: 'Étude de sol et permis de bâtir (Communauté urbaine de Yaoundé)', dueInDays: 25, priority: 'high' }, { title: 'Appel d\'offres charpente métallique', dueInDays: 45 }, { title: 'Dalle et quai de déchargement', dueInDays: 80 }, { title: 'Montage du hangar et couverture', dueInDays: 105 }, { title: 'Réception et déménagement du stock de fer', dueInDays: 118 }],
  } }, { as: 'manager' })).id;
  const tmp = (await ctx.do('Projets : créer un projet en double (à supprimer)', 'POST', '/projects', { name: 'Showroom Bonamoussadi (doublon)', tasks: [{ title: 'Tâche en double', dueInDays: 3 }] }, { as: 'manager' })).id;
  if (has('driver')) await ctx.do('Droits : un membre ne peut pas créer de projet (refusé)', 'POST', '/projects', { name: 'Projet non autorisé' }, { as: 'driver', expect: 403 });

  // ---------- Tâches assignées ----------
  const task = async (key, project, body, as = 'manager') => {
    T[key] = (await ctx.do(`Tâches : créer « ${body.title} »`, 'POST', '/projects/tasks', { projectId: project, ...body }, { as })).id;
    return T[key];
  };
  const plan = (key, body, as = 'manager') => ctx.do(`Tâches : planifier « ${key} » (estimation, début, dépendance)`, 'PUT', `/projects/tasks/${T[key]}/plan`, body, { as });
  // Showroom
  await task('bail', P.showroom, { title: 'Signature du bail du local (carrefour Bonamoussadi)', assigneeId: U('accountant'), due: ctx.day(-75), priority: 'high', status: 'done' });
  await task('plans', P.showroom, { title: "Plans d'aménagement et devis du menuisier", assigneeId: U('manager'), due: ctx.day(-50), status: 'done' });
  await task('travaux', P.showroom, { title: "Travaux d'aménagement : carrelage, faux plafond, peinture", description: 'Entreprise Ndokoti Bâtiment, 3 ouvriers. Carreaux 60×60 pris dans notre stock.', assigneeId: U('storekeeper'), due: ctx.day(-10), priority: 'high', status: 'doing' });
  await task('elec', P.showroom, { title: 'Installation électrique et climatisation', assigneeId: U('manager'), due: ctx.day(6) });
  await task('rayons', P.showroom, { title: 'Mise en rayon : carreaux, sanitaires, peinture', assigneeId: U('storekeeper'), due: ctx.day(20) });
  await task('recrut', P.showroom, { title: 'Recrutement de deux vendeurs showroom', assigneeId: U('accountant'), due: ctx.day(15), status: 'doing' });
  await task('inaug', P.showroom, { title: 'Inauguration et journée portes ouvertes', assigneeId: U('seller'), due: ctx.day(36), priority: 'high' });
  await task('flyers', P.showroom, { title: "Campagne d'affichage et flyers dans le quartier", assigneeId: U('seller'), due: ctx.day(-3) });
  await plan('bail', { estimateHours: 6, startDate: ctx.day(-80) });
  await plan('plans', { estimateHours: 24, startDate: ctx.day(-70), dependsOn: T.bail });
  await plan('travaux', { estimateHours: 120, startDate: ctx.day(-45), dependsOn: T.plans });
  await plan('elec', { estimateHours: 40, startDate: ctx.day(-2), dependsOn: T.travaux });
  await plan('rayons', { estimateHours: 32, startDate: ctx.day(8), dependsOn: T.elec });
  await plan('recrut', { estimateHours: 16, startDate: ctx.day(-5) });
  await plan('inaug', { estimateHours: 20, startDate: ctx.day(30), dependsOn: T.rayons });
  await ctx.do('Tâches : une dépendance en boucle est refusée', 'PUT', `/projects/tasks/${T.bail}/plan`, { dependsOn: T.inaug }, { as: 'manager', expect: 400 });
  // École de Kotto (chantier client)
  await task('lot1', P.ecole, { title: 'Livraison lot 1 : 600 sacs de ciment CPJ 42,5', assigneeId: U('driver'), due: ctx.day(-20), status: 'done' });
  await task('lot2', P.ecole, { title: 'Livraison lot 2 : 350 barres de fer HA 10 et HA 12', assigneeId: U('driver'), due: ctx.day(4), status: 'doing' });
  await task('lot3', P.ecole, { title: 'Livraison lot 3 : tôles bac alu et parpaings', assigneeId: U('driver'), due: ctx.day(25) });
  await task('reception', P.ecole, { title: 'Réception provisoire avec le service technique de la commune', assigneeId: U('manager'), due: ctx.day(50), priority: 'high' });
  await task('facture', P.ecole, { title: 'Facturation et attestation de bonne exécution', assigneeId: U('accountant'), due: ctx.day(54) });
  await plan('lot1', { estimateHours: 12, startDate: ctx.day(-24) });
  await plan('lot2', { estimateHours: 14, startDate: ctx.day(1), dependsOn: T.lot1 });
  await plan('lot3', { estimateHours: 16, startDate: ctx.day(20), dependsOn: T.lot2 });
  await plan('reception', { estimateHours: 6, dependsOn: T.lot3 });
  await plan('facture', { estimateHours: 4, dependsOn: T.reception });
  // MABAH : projet en retard et au-delà de son budget
  await task('formation', P.mabah, { title: "Formation de l'équipe (ventes, stock, caisse)", assigneeId: U('manager'), due: ctx.day(-40), status: 'done' });
  await task('seuils', P.mabah, { title: 'Paramétrage des seuils de réapprovisionnement', assigneeId: U('storekeeper'), due: ctx.day(-30), status: 'done' });
  await task('invA', P.mabah, { title: 'Inventaire tournant — dépôt de Douala (allées A à F)', assigneeId: U('storekeeper'), due: ctx.day(-18), status: 'done' });
  await task('invB', P.mabah, { title: 'Inventaire tournant — dépôt de Yaoundé', assigneeId: U('storekeeper'), due: ctx.day(-6), status: 'doing', priority: 'high' });
  await task('hebdo', P.mabah, { title: 'Comptage hebdomadaire des sacs de ciment', assigneeId: U('storekeeper'), due: ctx.day(-1) });
  await plan('formation', { estimateHours: 16, startDate: ctx.day(-45) });
  await plan('seuils', { estimateHours: 8, startDate: ctx.day(-33) });
  await plan('invA', { estimateHours: 30, startDate: ctx.day(-28) });
  await plan('invB', { estimateHours: 24, startDate: ctx.day(-14), dependsOn: T.invA });
  await plan('hebdo', { estimateHours: 2, recurrence: 'weekly', recurNext: ctx.day(-15) }); // la tâche planifiée n'a pas tourné depuis 2 semaines
  // Foire (projet terminé)
  await task('stand', P.foire, { title: 'Réservation et montage du stand', assigneeId: U('seller'), due: ctx.day(-45), status: 'done' });
  await task('prix', P.foire, { title: 'Grille de prix salon et bons de réduction', assigneeId: U('seller'), due: ctx.day(-40), status: 'done' });
  await task('contacts', P.foire, { title: 'Saisie des 140 contacts collectés', assigneeId: U('seller'), due: ctx.day(-28), status: 'done' });
  await plan('stand', { estimateHours: 20 }); await plan('prix', { estimateHours: 6 }); await plan('contacts', { estimateHours: 10 });
  // Tâche sans projet, créée par la commerciale elle-même
  T.relance = (await ctx.do('Tâches : un membre crée sa propre tâche (sans projet)', 'POST', '/projects/tasks', { title: 'Relancer Bâti Plus pour le chèque de 2 400 000 FCFA', priority: 'high', assigneeId: U('seller'), due: ctx.day(2) }, { as: 'seller' })).id;
  await ctx.do('Tâches : le membre modifie sa tâche', 'PUT', `/projects/tasks/${T.relance}`, { description: 'Chèque promis pour vendredi, appeler M. Nkotto (comptable).', due: ctx.day(3) }, { as: 'seller' });
  const own = (await ctx.do('Tâches : le membre crée une tâche en trop', 'POST', '/projects/tasks', { title: 'Note en double', assigneeId: U('seller') }, { as: 'seller' })).id;
  await ctx.do('Tâches : le membre supprime sa tâche', 'DELETE', `/projects/tasks/${own}`, undefined, { as: 'seller' });
  if (has('seller')) {
    await ctx.do("Droits : un membre ne peut pas modifier la tâche d'un autre (refusé)", 'PUT', `/projects/tasks/${T.travaux}`, { status: 'done' }, { as: 'seller', expect: 403 });
    await ctx.do("Droits : un membre ne peut pas supprimer la tâche d'un autre (refusé)", 'DELETE', `/projects/tasks/${T.travaux}`, undefined, { as: 'seller', expect: 403 });
  }
  await ctx.do('Tâches : démarrer une tâche dont la précédente n\'est pas finie (refusé)', 'PUT', `/projects/tasks/${T.elec}`, { status: 'doing' }, { as: 'manager', expect: 409 });
  await ctx.do('Tâches : le chauffeur fait avancer sa tâche (livraison en cours)', 'PUT', `/projects/tasks/${T.lot2}`, { status: 'doing' }, { as: 'driver' });
  await ctx.do('Tâches : le responsable modifie une tâche (priorité, échéance)', 'PUT', `/projects/tasks/${T.recrut}`, { priority: 'high', due: ctx.day(18) }, { as: 'manager' });

  // ---------- Temps passé (saisi par chaque personne, sur plusieurs mois) ----------
  const time = (key, as, day, hours, note) => ctx.do(`Temps passé : ${hours} h sur « ${key} »`, 'POST', `/projects/tasks/${T[key]}/time`, { day: ctx.day(day), hours, note }, { as });
  await time('bail', 'accountant', -79, 3, 'Visite du local et négociation du loyer'); await time('bail', 'accountant', -76, 4, 'Relecture du bail avec le bailleur');
  await time('plans', 'manager', -66, 8, 'Relevé des côtes'); await time('plans', 'manager', -59, 10, 'Plans et implantation des rayons'); await time('plans', 'manager', -52, 9, 'Devis menuisier comparés');
  for (const [d, h] of [[-44, 8], [-41, 9], [-38, 8], [-35, 10], [-31, 8], [-28, 9], [-24, 8], [-21, 10], [-17, 8], [-14, 9], [-10, 8], [-6, 7], [-3, 6]]) await time('travaux', 'storekeeper', d, h, 'Suivi du chantier et réception des matériaux');
  await time('recrut', 'accountant', -4, 3, 'Annonce et tri des CV'); await time('recrut', 'accountant', -1, 4, 'Entretiens (6 candidats)');
  await time('lot1', 'driver', -21, 6, 'Deux rotations camion 10 t'); await time('lot1', 'driver', -20, 7, 'Trois rotations, déchargement manuel');
  await time('lot2', 'driver', 0, 5, 'Premier voyage de fer');
  await time('formation', 'manager', -42, 8); await time('formation', 'manager', -41, 10);
  await time('seuils', 'storekeeper', -31, 9);
  await time('invA', 'storekeeper', -27, 8); await time('invA', 'storekeeper', -24, 9); await time('invA', 'storekeeper', -21, 10); await time('invA', 'storekeeper', -19, 8);
  await time('invB', 'storekeeper', -12, 8); await time('invB', 'storekeeper', -9, 7);
  await time('stand', 'seller', -47, 10); await time('stand', 'seller', -46, 12); await time('prix', 'seller', -41, 5); await time('contacts', 'seller', -29, 11);
  const wrong = (await ctx.do('Temps passé : saisie erronée', 'POST', `/projects/tasks/${T.travaux}/time`, { day: ctx.day(-1), hours: 2, note: 'erreur de tâche' }, { as: 'storekeeper' })).id;
  await ctx.do('Temps passé : supprimer sa saisie erronée', 'DELETE', `/projects/time/${wrong}`, undefined, { as: 'storekeeper' });
  await ctx.do('Temps passé : plus de 24 h dans une journée (refusé)', 'POST', `/projects/tasks/${T.travaux}/time`, { hours: 30 }, { as: 'storekeeper', expect: 400 });
  const tl = await ctx.do('Temps passé : liste d\'une tâche', 'GET', `/projects/tasks/${T.travaux}/time`);
  ctx.check('Temps passé : 13 saisies (108 h) sur les travaux du showroom', tl.items && tl.items.length === 13 && tl.total === 108, { n: tl.items && tl.items.length, total: tl.total });

  // ---------- Commentaires ----------
  await ctx.do('Tâches : commenter (responsable)', 'POST', `/projects/tasks/${T.travaux}/comments`, { content: 'Paul, le faux plafond doit être fini avant lundi : le climatiseur arrive mardi.' }, { as: 'manager' });
  await ctx.do('Tâches : répondre au commentaire (membre)', 'POST', `/projects/tasks/${T.travaux}/comments`, { content: "Le carreleur a pris 4 jours de retard (pluies). Je relance l'équipe, fin prévue jeudi." }, { as: 'storekeeper' });
  const cm = await ctx.do('Tâches : lire les commentaires', 'GET', `/projects/tasks/${T.travaux}/comments`, undefined, { as: 'storekeeper' });
  ctx.check('Tâches : 2 commentaires sur la tâche', (cm.items || []).length === 2, cm);

  // ---------- Jalons ----------
  const ms = async (pid, title, due, done) => { const id = (await ctx.do(`Jalons : « ${title} »`, 'POST', `/projects/${pid}/milestones`, { title, due }, { as: 'manager' })).id; if (done) await ctx.do(`Jalons : marquer « ${title} » atteint`, 'PUT', `/projects/milestones/${id}`, { done: true }, { as: 'manager' }); return id; };
  await ms(P.showroom, 'Bail signé', ctx.day(-75), true);
  await ms(P.showroom, 'Fin des travaux d\'aménagement', ctx.day(-5));
  await ms(P.showroom, 'Ouverture au public', ctx.day(36));
  await ms(P.ecole, 'Lot 1 livré', ctx.day(-20), true);
  await ms(P.ecole, 'Réception provisoire', ctx.day(50));
  await ms(P.mabah, 'Inventaire des deux dépôts terminé', ctx.day(-6));
  const mx = await ms(P.foire, 'Bilan du salon', ctx.day(-25), true);
  await ctx.do('Jalons : décaler un jalon', 'PUT', `/projects/milestones/${mx}`, { due: ctx.day(-24), title: 'Bilan du salon présenté' }, { as: 'manager' });
  const md = await ms(P.foire, 'Jalon en trop', ctx.day(-20));
  await ctx.do('Jalons : supprimer un jalon', 'DELETE', `/projects/milestones/${md}`, undefined, { as: 'manager' });

  // ---------- Budget et dépenses ----------
  const budget = (pid, budget, name) => ctx.do(`Budget projet : ${budget.toLocaleString('fr-FR')} FCFA pour « ${name} »`, 'PUT', `/projects/${pid}/budget`, { budget }, { as: 'manager' });
  await budget(P.showroom, 15000000, 'showroom'); await budget(P.ecole, 3500000, 'école de Kotto'); await budget(P.mabah, 1200000, 'MABAH'); await budget(P.foire, 2200000, 'foire'); await budget(P.yaounde, 85000000, 'dépôt de Yaoundé');
  const cost = (pid, label, amount, day) => ctx.do(`Dépenses projet : ${label}`, 'POST', `/projects/${pid}/costs`, { label, amount, date: ctx.day(day) }, { as: 'manager' });
  await cost(P.showroom, "Caution et 3 mois de loyer d'avance", 4500000, -78);
  await cost(P.showroom, 'Carrelage, faux plafond et menuiserie (Ndokoti Bâtiment)', 3800000, -40);
  await cost(P.showroom, 'Peinture et main-d\'œuvre', 1650000, -20);
  await cost(P.showroom, 'Climatiseurs split 2 CV × 4', 2400000, -5);
  await cost(P.showroom, 'Enseigne lumineuse et vitrophanie', 850000, -2);
  await cost(P.ecole, 'Location de camion-grue (lot 1)', 450000, -21);
  await cost(P.ecole, 'Carburant et péages Douala–Kotto', 185000, -20);
  await cost(P.ecole, 'Manutentionnaires journaliers', 120000, -20);
  await cost(P.mabah, 'Formation sur site (2 jours)', 450000, -42);
  await cost(P.mabah, 'Deux tablettes et lecteurs de codes-barres', 760000, -35);
  await cost(P.foire, 'Location du stand 36 m²', 1100000, -50);
  await cost(P.foire, 'Kakémonos, flyers et goodies', 640000, -48);
  const bad = (await cost(P.foire, 'Saisie en double', 640000, -48)).id;
  await ctx.do('Dépenses projet : supprimer une dépense en double', 'DELETE', `/projects/costs/${bad}`, undefined, { as: 'manager' });
  const cl = await ctx.do('Dépenses projet : liste', 'GET', `/projects/${P.showroom}/costs`, undefined, { as: 'manager' });
  ctx.check('Dépenses projet : 5 dépenses sur le showroom', (cl.items || []).length === 5, cl);
  if (has('seller')) await ctx.do('Droits : un membre ne voit pas les dépenses (refusé)', 'GET', `/projects/${P.showroom}/costs`, undefined, { as: 'seller', expect: 403 });

  // ---------- Pièces jointes chiffrées ----------
  const up = async (pid, name, title, lines) => ctx.do(`Projets : joindre « ${name} »`, 'POST', `/projects/${pid}/files${q({ name })}`, pdf(title, lines), { as: 'storekeeper' });
  const f1 = await up(P.showroom, "Plan d'aménagement showroom.pdf", "Plan d'amenagement - Showroom Bonamoussadi", ['Surface 400 m2', 'Zone carrelage 120 m2', 'Zone sanitaires 80 m2']);
  await up(P.ecole, 'Bon de commande CUD5 2026-114.pdf', 'Bon de commande CUD5 2026/114', ['Ciment 1 800 sacs', 'Fer HA10 / HA12 350 barres']);
  const f3 = await up(P.showroom, 'Brouillon.pdf', 'Brouillon', []);
  const fl = await ctx.do('Projets : liste des pièces jointes', 'GET', `/projects/${P.showroom}/files`);
  ctx.check('Projets : 2 pièces jointes sur le showroom', (fl.files || []).length === 2, fl);
  if (f1.id) await file('Projets : télécharger une pièce jointe', `/projects/files/${f1.id}/file`, 'application/pdf');
  if (f3.id) await ctx.do('Projets : supprimer une pièce jointe', 'DELETE', `/projects/files/${f3.id}`, undefined, { as: 'storekeeper' });
  await ctx.do('Projets : un fichier qui n\'est ni PDF ni image est refusé', 'POST', `/projects/${P.showroom}/files?name=virus.exe`, Buffer.from('MZ\x90\x00 pas un document'), { as: 'storekeeper', expect: 400 });

  // ---------- Risques et problèmes ----------
  const r1 = await ctx.do('Risques : un membre signale un risque élevé', 'POST', `/projects/${P.showroom}/risks`, { title: 'Retard des carreaux importés (dédouanement au port de Douala)', description: '2 conteneurs de grès 60×60 bloqués en douane.', probability: 4, impact: 4, mitigation: '' }, { as: 'storekeeper' });
  ctx.check('Risques : score 16 = niveau élevé', r1.score === 16, r1);
  await ctx.do('Risques : ajouter un risque', 'POST', `/projects/${P.showroom}/risks`, { title: 'Coupures de courant pendant les travaux', probability: 3, impact: 2, ownerId: U('manager'), mitigation: 'Louer un groupe électrogène 7,5 kVA de notre stock.' }, { as: 'manager' });
  await ctx.do('Risques : signaler un problème', 'POST', `/projects/${P.showroom}/risks`, { kind: 'issue', title: "Infiltration d'eau au plafond après la pluie", probability: 3, impact: 3, ownerId: U('storekeeper'), due: ctx.day(3) }, { as: 'manager' });
  await ctx.do('Risques : risque sur le marché de la commune', 'POST', `/projects/${P.ecole}/risks`, { title: 'Paiement de la commune à plus de 90 jours', probability: 4, impact: 3, ownerId: U('accountant'), mitigation: 'Facturer chaque lot et suivre le mandatement au Trésor.' }, { as: 'manager' });
  const r5 = await ctx.do('Risques : ajouter un risque en double', 'POST', `/projects/${P.showroom}/risks`, { title: 'Doublon', probability: 1, impact: 1 }, { as: 'manager' });
  if (r1.id) await ctx.do('Risques : passer un risque « en traitement » avec sa parade', 'PUT', `/projects/risks/${r1.id}`, { status: 'mitigating', ownerId: U('manager'), mitigation: 'Commande de secours de 200 cartons chez un importateur local.', probability: 3 }, { as: 'manager' });
  if (r5.id) await ctx.do('Risques : supprimer un risque', 'DELETE', `/projects/risks/${r5.id}`, undefined, { as: 'manager' });
  const rl = await ctx.do('Risques : registre du projet', 'GET', `/projects/${P.showroom}/risks`, undefined, { as: 'seller' });
  ctx.check('Risques : 3 risques et problèmes sur le showroom', (rl.items || []).length === 3, rl);

  // ---------- Plan de référence, planning, replanification ----------
  await ctx.do('Projets : figer le plan de référence (showroom)', 'POST', `/projects/${P.showroom}/baseline`, undefined, { as: 'manager' });
  await ctx.do('Projets : figer le plan de référence (école)', 'POST', `/projects/${P.ecole}/baseline`, undefined, { as: 'manager' });
  await ctx.do('Projets : figer le plan de référence (foire)', 'POST', `/projects/${P.foire}/baseline`, undefined, { as: 'manager' });
  await ctx.do('Projets : retirer un plan de référence', 'DELETE', `/projects/${P.foire}/baseline`, undefined, { as: 'manager' });
  const sch = await ctx.do('Projets : planning (Gantt) du showroom', 'GET', `/projects/${P.showroom}/schedule`, undefined, { as: 'seller' });
  ctx.check('Planning : les travaux en retard bousculent les tâches suivantes', (sch.tasks || []).some((t) => t.needsShift) && sch.forecast && sch.forecast.conflicts > 0, sch.forecast);
  const rp = await ctx.do('Projets : aperçu de la replanification', 'GET', `/projects/${P.showroom}/replan`, undefined, { as: 'manager' });
  ctx.check('Replanification : des tâches à décaler', (rp.changes || []).length >= 2, rp);
  const ap = await ctx.do('Projets : appliquer la replanification', 'POST', `/projects/${P.showroom}/replan`, undefined, { as: 'manager' });
  ctx.check('Replanification : tâches décalées', ap.applied >= 2, ap);
  const sh = await ctx.do('Tâches : aperçu du décalage de 3 jours (lot 2)', 'POST', `/projects/tasks/${T.lot2}/shift`, { days: 3 }, { as: 'manager' });
  ctx.check('Décalage : aperçu sans rien écrire', sh.preview === true && (sh.changes || []).length >= 1, sh);
  await ctx.do('Tâches : décaler de 3 jours (camion en panne)', 'POST', `/projects/tasks/${T.lot2}/shift`, { days: 3, apply: true }, { as: 'manager' });

  // ---------- Avancement : terminer, rouvrir, tâches récurrentes ----------
  await ctx.do('Tâches : le membre termine sa tâche (inventaire de Yaoundé)', 'PUT', `/projects/tasks/${T.invB}`, { status: 'done' }, { as: 'storekeeper' });
  await ctx.do('Tâches : rouvrir une tâche (écart de comptage à recompter)', 'PUT', `/projects/tasks/${T.invB}`, { status: 'doing' }, { as: 'manager' });
  const rec = await ctx.do('Tâches récurrentes : créer les occurrences dues', 'POST', '/projects/recurring/run', undefined, { as: 'manager' });
  ctx.check('Tâches récurrentes : le comptage hebdomadaire est recréé', rec.created >= 1, rec);
  const occ = ((await ctx.do('Tâches : tâches du projet MABAH', 'GET', `/projects/tasks?project=${P.mabah}`, undefined, { as: 'manager' })).tasks || []).filter((t) => t.title === 'Comptage hebdomadaire des sacs de ciment' && t.id !== T.hebdo);
  ctx.check('Tâches récurrentes : une seule occurrence, à la dernière échéance passée (pas de rattrapage)', occ.length === 1 && occ[0].due === ctx.day(-1), occ);
  await ctx.do('Tâches : supprimer une tâche (responsable)', 'DELETE', `/projects/tasks/${T.hebdo}`, undefined, { as: 'manager' });

  // ---------- Projets : modifier, terminer, mettre en pause, supprimer ----------
  await ctx.do('Projets : modifier la fiche (échéance, description)', 'PUT', `/projects/${P.showroom}`, { due: ctx.day(45), description: 'Nouveau point de vente de 400 m² au carrefour de Bonamoussadi (Douala). Ouverture décalée de 5 jours après le retard des travaux.' }, { as: 'manager' });
  await ctx.do('Projets : marquer un projet terminé', 'PUT', `/projects/${P.foire}`, { status: 'done' }, { as: 'manager' });
  await ctx.do('Projets : mettre un projet en pause', 'PUT', `/projects/${P.yaounde}`, { status: 'paused' }, { as: 'manager' });
  await ctx.do('Projets : remettre le projet en cours', 'PUT', `/projects/${P.yaounde}`, { status: 'active' }, { as: 'manager' });
  await ctx.do('Projets : supprimer le doublon', 'DELETE', `/projects/${tmp}`, undefined, { as: 'manager' });

  // ---------- Écrans et indicateurs ----------
  const list = await ctx.do('Projets : liste', 'GET', '/projects', undefined, { as: 'seller' });
  ctx.check('Projets : 5 projets visibles', (list.projects || []).filter((p) => Object.values(P).includes(p.id)).length === 5, (list.projects || []).map((p) => p.name));
  await ctx.do('Projets : fiche et tâches', 'GET', `/projects/${P.showroom}`, undefined, { as: 'seller' });
  const mine = await ctx.do('Tâches : mes tâches (magasinier)', 'GET', '/projects/tasks?mine=1', undefined, { as: 'storekeeper' });
  if (has('storekeeper')) ctx.check('Tâches : le magasinier voit ses tâches', (mine.tasks || []).length >= 5, (mine.tasks || []).length);
  await ctx.do('Tâches : filtrer par projet et statut', 'GET', `/projects/tasks?project=${P.ecole}&status=todo`, undefined, { as: 'manager' });
  const sum = await ctx.do('Projets : résumé budget, temps et jalons', 'GET', `/projects/${P.showroom}/summary`, undefined, { as: 'manager' });
  ctx.check('Budget : le showroom dépasse 80 % de son budget', sum.cost && sum.cost.usedPct >= 80, sum.cost);
  const sb = await ctx.do('Projets : résumé du projet MABAH', 'GET', `/projects/${P.mabah}/summary`, undefined, { as: 'manager' });
  ctx.check('Budget : le projet MABAH est au-delà de son budget', sb.cost && sb.cost.overBudget === true, sb.cost);
  const ins = await ctx.do('Projets : fiabilité des données et prévision', 'GET', `/projects/${P.showroom}/insight`, undefined, { as: 'manager' });
  ctx.check('Prévision : score de fiabilité et date de fin calculés', ins.quality && typeof ins.quality.score === 'number' && ins.forecast && ins.forecast.endDate, ins);
  const pro = await ctx.do('Projets pro : tableau de bord complet (valeur acquise, chemin critique)', 'GET', `/projects/${P.showroom}/pro`, undefined, { as: 'manager' });
  ctx.check('Projets pro : coûts visibles du responsable', pro.canSeeCosts === true, Object.keys(pro));
  const prom = await ctx.do('Projets pro : tableau de bord vu par un membre', 'GET', `/projects/${P.showroom}/pro`, undefined, { as: 'seller' });
  if (has('seller')) ctx.check('Droits : les montants sont masqués aux membres', prom.canSeeCosts === false, prom.canSeeCosts);
  const pf = await ctx.do('Projets pro : portefeuille (feu tricolore)', 'GET', '/projects/portfolio', undefined, { as: 'manager' });
  ctx.check('Portefeuille : au moins un projet en retard', pf.totals && pf.totals.late >= 1, pf.totals);
  const yd = (pf.items || []).find((x) => x.id === P.yaounde);
  ctx.check('Portefeuille : un projet pas encore commencé est « dans les temps » (SPI(t) 1, pas d\'avance fictive)', yd && (yd.spiT === 1 || yd.spiT === null) && yd.rag === 'green', yd);
  await ctx.do('Projets pro : portefeuille avec les projets terminés', 'GET', '/projects/portfolio?all=1', undefined, { as: 'owner' });
  await file('Projets pro : export CSV du portefeuille', '/projects/portfolio/export.csv', 'text/csv', { as: 'manager' });
  await ctx.do('Projets : charge par personne', 'GET', '/projects/workload', undefined, { as: 'manager' });
  const wl = await ctx.do('Projets pro : charge prévue par semaine', 'GET', '/projects/workload/plan?weeks=8&capacity=40', undefined, { as: 'manager' });
  ctx.check('Charge : planning sur 8 semaines', Array.isArray(wl.rows), Object.keys(wl));

  // ---------- Partage de rapports PDF dans l'équipe ----------
  await ctx.do('Partage : destinataires possibles', 'GET', '/share/audience', undefined, { as: 'manager' });
  const pv = await ctx.do('Partage : aperçu des destinataires (antenne de Douala)', 'POST', '/share/preview', { branchIds: [B.douala] }, { as: 'manager' });
  if (has('storekeeper')) ctx.check('Partage : le magasinier et le chauffeur sont dans l\'antenne de Douala', pv.count >= 2, pv);
  await file('Partage : PDF du rapport de projet', `/share/pdf/project/${P.showroom}?includeCosts=1`, 'application/pdf', { as: 'manager' });
  // Les partages vont à d'autres personnes de l'équipe : en ligne (sans comptes pour l'équipe), seuls les PDF sont produits.
  const team = has('manager') && has('accountant');
  const s1 = team ? await ctx.do('Partage : envoyer le rapport du showroom (avec coûts) à la direction', 'POST', '/share/send', { kind: 'project', sourceId: P.showroom, includeCosts: true, userIds: [ctx.ids.ownerId, U('accountant')], message: 'Point avant le comité de lundi : budget à 90 %.' }, { as: 'manager' }) : {};
  if (team) await ctx.do('Partage : envoyer le planning du chantier de Kotto à l\'antenne de Douala', 'POST', '/share/send', { kind: 'project', sourceId: P.ecole, branchIds: [B.douala], roles: ['admin'] }, { as: 'manager' });
  const s3 = !team ? {} : await ctx.do('Partage : envoi par erreur', 'POST', '/share/send', { kind: 'project', sourceId: P.mabah, roles: ['admin'] }, { as: 'manager' });
  if (s3.id) await ctx.do('Partage : retirer un partage', 'DELETE', `/share/${s3.id}`, undefined, { as: 'manager' });
  const inv = (await ctx.do('Ventes : factures (pour le PDF)', 'GET', '/crm/documents?kind=invoice', undefined, { as: 'manager' })).documents || [];
  if (inv.length) {
    await file('Partage : PDF d\'une facture', `/share/pdf/invoice/${inv[0].id}`, 'application/pdf', { as: 'manager' });
    if (team) await ctx.do('Partage : envoyer une facture à la comptable', 'POST', '/share/send', { kind: 'invoice', sourceId: inv[0].id, userIds: [U('accountant')] }, { as: 'manager' });
  }
  await ctx.do('Partage : envoyer les bulletins de paie du mois', 'POST', '/share/payslips', { month: ctx.month(-1) }, { as: 'accountant' });
  await ctx.do('Partage : un bulletin de paie ne se partage pas à un groupe (refusé)', 'POST', '/share/send', { kind: 'payslip', sourceId: 1, roles: ['member'] }, { as: 'manager', expect: 400 });
  const ib = await ctx.do('Partage : documents reçus (dirigeant)', 'GET', '/share/inbox');
  if (team) ctx.check('Partage : le dirigeant a reçu le rapport, non lu', (ib.items || []).some((i) => i.id === s1.id && !i.opened), ib);
  if (s1.id) await file('Partage : ouvrir le document reçu', `/share/${s1.id}/file?inline=1`, 'application/pdf');
  await ctx.do('Partage : documents reçus (chauffeur)', 'GET', '/share/inbox', undefined, { as: 'driver' });
  const sent = await ctx.do('Partage : documents envoyés et lectures', 'GET', '/share/sent', undefined, { as: 'manager' });
  if (team) ctx.check('Partage : la lecture du dirigeant est visible de l\'expéditeur', (sent.items || []).some((i) => i.id === s1.id && i.recipients.some((r) => r.opened)), sent.items && sent.items[0]);
};
