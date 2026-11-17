'use strict';
// Chantiers (BTP) : le département travaux de Batimat réalise un immeuble R+4 à Odza, la réhabilitation du marché de Kotto (en retard et
// au-dessus du budget), une villa réceptionnée à Logpom et un showroom suspendu. Phases pondérées (avancement), dépenses par nature
// (consommations de matériaux, main-d'œuvre, sous-traitance…), pointages, rapports journaliers, incidents et réserves, situations de travaux.
const S = '/construction';

module.exports = async function construction(ctx) {
  const O = ctx.ids.operations;
  const D = (n) => ctx.day(n);
  const keeper = ctx.ids.members.storekeeper && ctx.ids.members.storekeeper.userId; // chef de chantier à Kotto
  const lead = keeper && ctx.users.storekeeper ? 'storekeeper' : 'manager';
  const have = (await ctx.do('Chantiers : tableau de bord', 'GET', S)).sites || [];
  const site = {};
  for (const [k, body] of [
    ['odza', { name: 'Immeuble R+4 « Les Collines » — Odza', client: 'Immobilière des Collines', location: 'Odza, Yaoundé', startDate: D(-120), endDate: D(150), budget: 485000000, costBudget: 392000000, remainingEstimate: 255000000, status: 'active', branchId: ctx.ids.branches.yaounde, notes: '12 appartements, 2 commerces au rez-de-chaussée. Maître d\'œuvre : cabinet ACE Yaoundé.' }],
    ['kotto', { name: 'Réhabilitation du marché de Kotto', client: 'Commune de Douala 5e', location: 'Kotto, Douala', startDate: D(-75), endDate: D(-5), budget: 78500000, costBudget: 64000000, remainingEstimate: 9000000, status: 'active', foremanId: keeper, branchId: ctx.ids.branches.douala, notes: 'Marché public n° 014/CD5/2026 : charpente, couverture, dallage, réseaux.' }],
    ['villa', { name: 'Villa duplex M. Etoundi — Logpom', client: 'M. Jean-Paul Etoundi', location: 'Logpom, Douala', startDate: D(-210), endDate: D(-30), budget: 42000000, costBudget: 35000000, status: 'active', branchId: ctx.ids.branches.douala }],
    ['showroom', { name: 'Showroom de l\'Hôtel La Falaise', client: 'Hôtel La Falaise', location: 'Bonanjo, Douala', startDate: D(20), endDate: D(110), budget: 26000000, costBudget: 21000000, status: 'preparation', branchId: ctx.ids.branches.douala }],
    ['tmp', { name: 'Chantier saisi par erreur', status: 'preparation' }],
  ]) { const ex = have.find((s) => s.name === body.name); site[k] = ex ? ex.id : (await ctx.do(`Chantiers : créer « ${body.name} »`, 'POST', `${S}/sites`, body, { as: 'manager' })).id; }
  await ctx.do('Chantiers : supprimer un chantier', 'DELETE', `${S}/sites/${site.tmp}`, undefined, { as: 'manager' });
  delete site.tmp;
  if (ctx.users.seller) await ctx.do('Chantiers : un membre ne crée pas de chantier (droits)', 'POST', `${S}/sites`, { name: 'Essai' }, { as: 'seller', expect: 403 });

  // ---------- Phases (lots) et avancement ----------
  const ph = {};
  const PH = {
    odza: [['Installation de chantier', 5, 100, -120, -110], ['Terrassements et fondations', 15, 100, -110, -70], ['Gros œuvre RDC à R+2', 30, 70, -70, 10], ['Gros œuvre R+3 et R+4', 20, 10, 10, 60], ['Second œuvre (plomberie, électricité, menuiseries)', 20, 0, 50, 130], ['VRD et finitions', 10, 0, 120, 150]],
    kotto: [['Démolition et déblais', 10, 100, -75, -65], ['Dallage béton des allées', 25, 100, -65, -40], ['Charpente métallique et couverture bac alu', 35, 80, -45, -15], ['Électricité et plomberie des boutiques', 20, 40, -25, -5], ['Peinture et signalétique', 10, 0, -10, -5]],
    villa: [['Gros œuvre', 50, 100, -210, -120], ['Second œuvre', 35, 100, -120, -45], ['Finitions et nettoyage', 15, 100, -45, -30]],
  };
  for (const [k, list] of Object.entries(PH)) {
    for (const [name, weight, progress, a, b] of list) {
      ph[`${k}:${name}`] = (await ctx.do(`Chantiers : lot « ${name} »`, 'POST', `${S}/sites/${site[k]}/phases`, { name, weight, progress: k === 'kotto' && progress < 100 ? 0 : progress, plannedStart: D(a), plannedEnd: D(b), actualStart: progress > 0 ? D(a + 2) : undefined, actualEnd: progress >= 100 ? D(b + 3) : undefined }, { as: k === 'kotto' ? lead : 'manager' })).id;
    }
  }
  // Le chef de chantier met à jour l'avancement de ses lots.
  await ctx.do('Chantiers : avancement saisi par le chef de chantier (couverture 80 %)', 'PUT', `${S}/phases/${ph['kotto:Charpente métallique et couverture bac alu']}`, { progress: 80, notes: 'Reste les faîtières et la descente des eaux pluviales.' }, { as: lead });
  await ctx.do('Chantiers : avancement (réseaux 40 %)', 'PUT', `${S}/phases/${ph['kotto:Électricité et plomberie des boutiques']}`, { progress: 40 }, { as: lead });
  if (ctx.users.seller) await ctx.do('Chantiers : une commerciale ne modifie pas les lots (droits)', 'PUT', `${S}/phases/${ph['kotto:Électricité et plomberie des boutiques']}`, { progress: 100 }, { as: 'seller', expect: 403 });
  const tmpPh = (await ctx.do('Chantiers : lot en trop', 'POST', `${S}/sites/${site.kotto}/phases`, { name: 'Lot doublon', weight: 1 }, { as: lead })).id;
  await ctx.do('Chantiers : supprimer un lot', 'DELETE', `${S}/phases/${tmpPh}`, undefined, { as: lead });

  // ---------- Dépenses (consommations de matériaux, main-d'œuvre…) ----------
  const EXP = {
    odza: [['materials', 'Ciment CPJ 42,5 — 1 850 sacs (dépôt de Mvan)', 9620000, -105], ['materials', 'Fer HA 10 et HA 12 — 2 400 barres', 14880000, -95], ['materials', 'Hourdis et parpaings (fabrication Batimat)', 11250000, -60], ['materials', 'Béton prêt à l\'emploi B25 — 410 m³', 32800000, -40], ['labor', 'Équipes de maçonnerie (4 mois)', 38500000, -10], ['subcontract', 'Étanchéité des terrasses (acompte)', 6500000, -20], ['equipment', 'Location grue à tour Potain (3 mois)', 13500000, -15], ['transport', 'Garanti Express — lots Douala → Odza', 2150000, -1]],
    kotto: [['materials', 'Tôles bac alu 6/10 — 1 200 feuilles', 10680000, -50], ['materials', 'Ciment, sable et gravier du dallage', 9850000, -60], ['materials', 'Profilés IPE et pannes Z', 8300000, -40], ['labor', 'Main-d\'œuvre (charpentiers, maçons)', 18500000, -7], ['subcontract', 'Électricité des 86 boutiques (Électro Douala)', 12200000, -6], ['equipment', 'Nacelle et groupe de soudure', 4200000, -30], ['transport', 'Livraisons Batimat (camion Axor)', 1350000, -3]],
    villa: [['materials', 'Gros œuvre complet', 14800000, -150], ['labor', 'Main-d\'œuvre', 11200000, -60], ['subcontract', 'Menuiseries aluminium', 5900000, -50], ['other', 'Nettoyage de fin de chantier', 350000, -31]],
  };
  const exp = {};
  for (const [k, list] of Object.entries(EXP)) {
    for (const [category, label, amount, n] of list) {
      const r = await ctx.do(`Chantiers : dépense « ${label} »`, 'POST', `${S}/sites/${site[k]}/expenses`, { category, label, amount, date: D(n) }, { as: 'manager' });
      exp[`${k}:${label}`] = r.id;
      if (r.alert) ctx.check('Chantiers : alerte de dépassement du budget (Kotto)', k === 'kotto' && /dépassent le budget/.test(r.alert), r.alert);
    }
  }
  const wrong = (await ctx.do('Chantiers : dépense mal saisie', 'POST', `${S}/sites/${site.kotto}/expenses`, { category: 'other', label: 'Doublon facture carburant', amount: 85000 }, { as: 'manager' })).id;
  await ctx.do('Chantiers : supprimer une dépense', 'DELETE', `${S}/expenses/${wrong}`, undefined, { as: 'manager' });
  await ctx.do('Chantiers : corriger une dépense', 'PUT', `${S}/expenses/${exp['odza:Étanchéité des terrasses (acompte)']}`, { amount: 6800000, label: 'Étanchéité des terrasses (acompte 40 %)' }, { as: 'manager' });
  const eTb = exp['odza:Location grue à tour Potain (3 mois)'];
  await ctx.do('Chantiers : inscription au budget sans confirmation refusée', 'POST', `${S}/expenses/${eTb}/to-budget`, {}, { as: 'manager', expect: 400 });
  await ctx.do('Chantiers : inscrire une dépense au budget de l\'entreprise', 'POST', `${S}/expenses/${eTb}/to-budget`, { confirm: true }, { as: 'manager' });
  await ctx.do('Chantiers : une dépense inscrite au budget ne se modifie plus', 'PUT', `${S}/expenses/${eTb}`, { amount: 1 }, { as: 'manager', expect: 400 });

  // ---------- Pointages, rapports, incidents ----------
  for (let n = -12; n <= -1; n++) {
    if (new Date(Date.now() + n * 86400000).getUTCDay() === 0) continue;
    await ctx.do('Chantiers : pointage journalier', 'POST', `${S}/sites/${site.kotto}/timesheets`, { date: D(n), worker: n % 2 ? 'Équipe charpente (chef : M. Kouam)' : 'Équipe réseaux (chef : M. Essomba)', headcount: n % 2 ? 9 : 5, hours: 8.5, notes: n === -4 ? 'Arrêt 2 h pour orage.' : '' }, { as: lead });
    if (n % 3 === 0) await ctx.do('Chantiers : pointage (Odza)', 'POST', `${S}/sites/${site.odza}/timesheets`, { date: D(n), worker: 'Équipe gros œuvre R+2', headcount: 22, hours: 9 }, { as: 'manager' });
  }
  const tsx = (await ctx.do('Chantiers : pointage en double', 'POST', `${S}/sites/${site.kotto}/timesheets`, { worker: 'Doublon', headcount: 1, hours: 1 }, { as: lead })).id;
  await ctx.do('Chantiers : supprimer son pointage', 'DELETE', `${S}/timesheets/${tsx}`, undefined, { as: lead });
  const rep = [];
  for (const [n, weather, work, headcount, incidents] of [[-3, 'Ensoleillé, 31 °C', 'Pose des faîtières côté nord, reprise des chéneaux.', 14, ''], [-2, 'Pluie l\'après-midi', 'Tirage des câbles boutiques 1 à 24, arrêt à 15 h (pluie).', 11, 'Glissade d\'un manœuvre sur la dalle mouillée, sans gravité.'], [-1, 'Nuageux', 'Raccordement des tableaux divisionnaires rangée A.', 12, '']]) {
    rep.push((await ctx.do('Chantiers : rapport journalier', 'POST', `${S}/sites/${site.kotto}/reports`, { date: D(n), weather, work, headcount, incidents }, { as: lead })).id);
  }
  await ctx.do('Chantiers : corriger son rapport', 'PUT', `${S}/reports/${rep[2]}`, { work: 'Raccordement des tableaux divisionnaires rangées A et B.', headcount: 13 }, { as: lead });
  const rx = (await ctx.do('Chantiers : rapport en double', 'POST', `${S}/sites/${site.kotto}/reports`, { work: 'Doublon' }, { as: lead })).id;
  await ctx.do('Chantiers : supprimer un rapport', 'DELETE', `${S}/reports/${rx}`, undefined, { as: lead });
  await ctx.do('Chantiers : rapport (Odza)', 'POST', `${S}/sites/${site.odza}/reports`, { date: D(-1), weather: 'Ensoleillé', work: 'Coulage de la dalle haute du R+2 (62 m³), décoffrage des poteaux R+1.', headcount: 31 }, { as: 'manager' });
  const iss = {};
  for (const [k, s, body, as] of [
    ['fall', 'kotto', { kind: 'incident', title: 'Glissade d\'un manœuvre sur la dalle mouillée', description: 'Contusion légère, soins sur place. Balisage ajouté.', date: D(-2) }, lead],
    ['scaff', 'kotto', { kind: 'safety', title: 'Échafaudage de la rangée C sans garde-corps', description: 'Interdiction d\'accès jusqu\'à la pose des garde-corps.', date: D(-1) }, lead],
    ['crack', 'villa', { kind: 'snag', title: 'Fissure sur l\'enduit de la façade est', description: 'Réserve émise à la réception, reprise promise sous 30 jours.', date: D(-30) }, 'manager'],
    ['tile', 'villa', { kind: 'snag', title: 'Carreaux sonnent creux dans la cuisine', date: D(-30) }, 'manager'],
    ['dup', 'odza', { kind: 'incident', title: 'Doublon', date: D(0) }, 'manager'],
  ]) iss[k] = (await ctx.do(`Chantiers : signaler « ${body.title} »`, 'POST', `${S}/sites/${site[s]}/issues`, body, { as })).id;
  await ctx.do('Chantiers : point de sécurité levé', 'PUT', `${S}/issues/${iss.scaff}`, { status: 'resolved', description: 'Garde-corps posés et contrôlés le jour même.' }, { as: lead });
  await ctx.do('Chantiers : réserve levée', 'PUT', `${S}/issues/${iss.tile}`, { status: 'resolved' }, { as: 'manager' });
  await ctx.do('Chantiers : supprimer un point', 'DELETE', `${S}/issues/${iss.dup}`, undefined, { as: 'manager' });

  // ---------- Situations de travaux ----------
  const bil = {};
  for (const [k, s, body] of [
    ['o1', 'odza', { label: 'Situation n° 1 — installation et fondations', amount: 97000000, billedAt: D(-80), dueDate: D(-50) }],
    ['o2', 'odza', { label: 'Situation n° 2 — gros œuvre RDC et R+1', amount: 121250000, billedAt: D(-35), dueDate: D(-5) }],
    ['o3', 'odza', { label: 'Situation n° 3 — gros œuvre R+2', amount: 58200000, billedAt: D(-2), dueDate: D(28) }],
    ['k1', 'kotto', { label: 'Acompte au démarrage (20 %)', amount: 15700000, billedAt: D(-75), dueDate: D(-60) }],
    ['k2', 'kotto', { label: 'Situation n° 1 — démolition et dallage', amount: 23550000, billedAt: D(-40), dueDate: D(-10) }],
    ['v1', 'villa', { label: 'Situation finale (solde)', amount: 42000000, billedAt: D(-30), dueDate: D(-15) }],
    ['x', 'kotto', { label: 'Situation saisie en double', amount: 1000000 }],
  ]) bil[k] = (await ctx.do(`Chantiers : ${body.label}`, 'POST', `${S}/sites/${site[s]}/billings`, body, { as: 'manager' })).id;
  await ctx.do('Chantiers : corriger une situation (montant validé par le maître d\'œuvre)', 'PUT', `${S}/billings/${bil.o3}`, { amount: 56900000 }, { as: 'manager' });
  await ctx.do('Chantiers : supprimer une situation', 'DELETE', `${S}/billings/${bil.x}`, undefined, { as: 'manager' });
  for (const [k, amount, n] of [['o1', 97000000, -48], ['o2', 80000000, -3], ['k1', 15700000, -58], ['v1', 42000000, -12]]) await ctx.do('Chantiers : encaissement d\'une situation', 'POST', `${S}/billings/${bil[k]}/pay`, { amount, date: D(n) }, { as: 'manager' });
  await ctx.do('Chantiers : paiement supérieur au reste dû refusé', 'POST', `${S}/billings/${bil.o2}/pay`, { amount: 50000000 }, { as: 'manager', expect: 400 });

  // ---------- États ----------
  await ctx.do('Chantiers : villa terminée', 'PUT', `${S}/sites/${site.villa}`, { status: 'done' }, { as: 'manager' });
  await ctx.do('Chantiers : villa réceptionnée (avec réserves)', 'PUT', `${S}/sites/${site.villa}`, { status: 'received', notes: 'Réception le ' + D(-30) + ', une réserve en cours (enduit façade est).' }, { as: 'manager' });
  await ctx.do('Chantiers : showroom suspendu (permis en attente)', 'PUT', `${S}/sites/${site.showroom}`, { status: 'suspended', notes: 'En attente du permis de construire de la CUD.' }, { as: 'manager' });

  const k = await ctx.do('Chantiers : fiche du marché de Kotto (responsable)', 'GET', `${S}/sites/${site.kotto}`, undefined, { as: 'manager' });
  ctx.check('Chantiers : Kotto en retard et au-dessus du budget', k.site && k.site.late && k.site.overrun === 'over' && k.site.toPay === 23550000, k.site);
  const kv = await ctx.do('Chantiers : fiche du chantier (chef de chantier, sans montants)', 'GET', `${S}/sites/${site.kotto}`, undefined, { as: lead });
  if (lead !== 'manager') ctx.check('Chantiers : le chef de chantier ne voit pas l\'argent', kv.site && kv.site.budget === undefined && (kv.billings || []).length === 0 && kv.personHours > 0, kv.site);
  const o = await ctx.do('Chantiers : fiche de l\'immeuble d\'Odza', 'GET', `${S}/sites/${site.odza}`, undefined, { as: 'manager' });
  ctx.check('Chantiers : Odza — avancement pondéré et reste à encaisser', o.site && o.site.progress === 43 && o.site.toPay === 41250000 + 56900000, o.site);
  const dash = await ctx.do('Chantiers : tableau de bord (marge prévisionnelle, retards, à encaisser)', 'GET', S, undefined, { as: 'manager' });
  ctx.check('Chantiers : tableau de bord rempli', dash.summary && dash.summary.active === 2 && dash.summary.late >= 1 && dash.summary.overBudget === 1 && dash.summary.toCollect > 0, dash.summary);
  O.sites = site;
};
