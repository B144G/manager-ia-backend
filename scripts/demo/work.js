'use strict';
// Groupe « work » de la démonstration Batimat Afrique : projets et tâches, juridique, bibliothèque, organisation, procédures, mémoire,
// décisions, équipe, intégrations, données, agents, profil, résumé et alertes, abonnement, assistant IA.
// Tourne en DERNIER : il finit par les tableaux de bord et le résumé du matin pour vérifier qu'ils agrègent tout ce que les groupes ont créé.
const { AI_OK } = require('./work-misc');
const { helpers } = require('./work-lib');

module.exports = async function work(ctx) {
  ctx.ids.work = ctx.ids.work || {};
  await require('./work-projects')(ctx);
  await require('./work-legal')(ctx);
  await require('./work-library')(ctx);
  await require('./work-org')(ctx);
  await require('./work-misc')(ctx);
  await dashboards(ctx);
};

/** Tableaux de bord et résumé : ils doivent refléter les projets, décisions, contrats, stock, ventes… de toute la démonstration. */
async function dashboards(ctx) {
  const { has } = helpers(ctx);
  const W = ctx.ids.work;
  await ctx.do('Tableau de bord : liste des sous-applications', 'GET', '/api/ws/modules');
  const d = await ctx.do('Tableau de bord : vue de la gérante', 'GET', '/dashboard');
  const st = d.stats || {};
  ctx.check('Tableau de bord : projets actifs, tâches en retard et organigramme comptés', st.projects && st.projects.active >= 4 && st.tasks.overdue >= 2 && st.structure.positions >= 10 && st.structure.processes >= 4, st);
  ctx.check('Tableau de bord : décisions en attente de validation', (d.decisions || []).length >= 2 && d.canDecide === true, (d.decisions || []).map((x) => x.title));
  ctx.check('Tableau de bord : projets en cours avec avancement', (d.projects || []).some((p) => p.id === W.projects.showroom && p.percent > 0), d.projects);
  ctx.check('Tableau de bord : courbes du budget (responsables)', d.series !== null && d.series !== undefined, Object.keys(d));
  const mods = new Set((d.alerts || []).map((a) => a.module));
  ctx.check('Tableau de bord : alertes projets, juridique et stock réunies', mods.has('projects') && mods.has('legal'), [...mods]);
  ctx.check('Tableau de bord : score de santé calculé', d.health !== undefined && d.health !== null, d.health);
  const dm = await ctx.do('Tableau de bord : vue du magasinier (ses tâches)', 'GET', '/dashboard', undefined, { as: 'storekeeper' });
  if (has('storekeeper')) {
    ctx.check('Tableau de bord : le magasinier voit ses tâches, sans le budget', (dm.myTasks || []).length >= 2 && dm.series === null && !(dm.stats || {}).budget, { tasks: (dm.myTasks || []).length, series: dm.series });
  }
  await ctx.do('Tableau de bord : vue de la commerciale', 'GET', '/dashboard', undefined, { as: 'seller' });
  const al = await ctx.do('Alertes : liste complète (responsable)', 'GET', '/dashboard/alerts', undefined, { as: 'manager' });
  const lev = (al.alerts || []).reduce((o, a) => { o[a.level] = (o[a.level] || 0) + 1; return o; }, {});
  ctx.check('Alertes : des alertes urgentes et à surveiller', (lev.high || 0) >= 1 && (lev.medium || 0) >= 1, lev);
  ctx.check('Alertes : le préavis dépassé du contrat Cimencam remonte', (al.alerts || []).some((a) => a.module === 'legal' && a.level === 'high' && /Cimencam/.test(a.text) && /préavis/.test(a.text)), (al.alerts || []).filter((a) => a.module === 'legal'));
  const k = await ctx.do('Tableau de bord : indicateurs du mois (CA, marge, créances, trésorerie, objectifs)', 'GET', '/dashboard/kpis', undefined, { as: 'manager' });
  ctx.check('Tableau de bord : six mois de chiffre d\'affaires et objectif de CA', (k.series || []).length === 6 && k.goals && k.goals.revenue && k.goals.revenue.target === 85000000, { series: k.series, goals: k.goals });
  await ctx.do('Tableau de bord : indicateurs du mois précédent', 'GET', `/dashboard/kpis?month=${ctx.month(-1)}`, undefined, { as: 'accountant' });
  const csv = await ctx.do('Tableau de bord : export CSV des indicateurs', 'GET', '/dashboard/kpis.csv', undefined, { as: 'manager', raw: true });
  ctx.check('Tableau de bord : export CSV lisible', csv.status === 200 && /Chiffre d'affaires HT/.test(csv.text), csv.status);
  if (has('seller')) await ctx.do('Droits : un membre ne voit pas les indicateurs financiers (refusé)', 'GET', '/dashboard/kpis', undefined, { as: 'seller', expect: 403 });
  // Résumé du matin : composé à partir de toutes les données (test d'envoi vers une adresse *.example ; sans serveur d'e-mail : « non envoyé »)
  const t = await ctx.do('Résumé du matin : composer et tester l\'envoi', 'POST', '/mail/digest/test', undefined, { as: 'manager' });
  ctx.check('Résumé du matin : composé sans erreur', typeof t.status === 'string' && t.statusText, t);
  const dg = await ctx.do('Résumé du matin : réglages et journal des envois', 'GET', '/mail/digest', undefined, { as: 'manager' });
  ctx.check('Résumé du matin : abonnement et dernier envoi visibles', dg.me && dg.me.morning === true && (dg.log || []).length >= 1, { me: dg.me, log: (dg.log || []).length });
  // Appel IA n° 2 : point de situation (écran Alertes)
  await ctx.do("Assistant IA : point de situation du jour (appel IA)", 'POST', '/ai/briefing', undefined, { expect: AI_OK });
}
