'use strict';
// Démonstration · groupe « commerce » : Clients et ventes (fiches, devis, factures, paiements, avoirs, impression), Assistant commercial
// (catalogue et prix, conversations, rendez-vous, attribution, négociation, relances, page publique), Marketing et Service client.
// Les ventes des six derniers mois font sortir le stock (ctx.ids.items) ; les factures récentes restent « à livrer » pour la logistique.
// Ids rangés dans ctx.ids.commerce : catalog (articles de l'assistant par clé), invoices (toutes les factures), toDeliver (factures envoyées
// dont les lignes portent itemId et qui ne sont PAS encore sorties du stock : à livrer par la logistique), numbers (id -> numéro), overdue
// (factures en retard), quotes, credits (avoirs), campaigns, tickets, appointments, chats. orders : commandes clients créées depuis des devis.
module.exports = async function commerce(ctx) {
  const C = ctx.ids.commerce = ctx.ids.commerce || {};
  C.local = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(ctx.base + '/');
  await require('./commerce-catalog')(ctx, C);   // catalogue de l'assistant, prix plancher, paliers, prix et remises par client
  await require('./commerce-ventes')(ctx, C);    // réglages de facturation, clients, 6 mois de ventes, devis, paiements, avoirs, impression
  await require('./commerce-assistant')(ctx, C); // page publique, conversations, attribution, rendez-vous, négociation, relances, relais
  await require('./commerce-marketing')(ctx, C); // campagnes, dépenses, calendrier, offres, segments, consentement, codes promo
  await require('./commerce-support')(ctx, C);   // tickets, priorités, réponses, base de réponses, satisfaction, rapport
  await require('./commerce-orders')(ctx, C);    // devis → commande client → livraison → facture
  // Tableau de bord et alertes nourris par les ventes, le stock et le service client
  const al = (await ctx.do('Tableau de bord : alertes (factures en retard, ruptures, demandes urgentes)', 'GET', '/dashboard/alerts', undefined, { as: 'manager' })).alerts || [];
  ctx.check('Alertes : factures en retard et stock bas signalés', al.some((a) => a.module === 'crm' || /retard|échue|impay/i.test(a.text + a.title)) && al.some((a) => a.module === 'stock'), al.map((a) => a.title + ' : ' + a.text).slice(0, 8));
  await ctx.do("Tableau de bord : vue d'ensemble (santé, séries)", 'GET', '/dashboard', undefined, { as: 'manager' });
  const k = await ctx.do("Tableau de bord : chiffre d'affaires, créances par âge", 'GET', '/dashboard/kpis', undefined, { as: 'manager' });
  ctx.check("Tableau de bord : chiffre d'affaires sur 6 mois rempli", (k.series || []).filter((s) => s.revenue > 0).length >= 5 && k.receivables && k.receivables.total > 0, k.series);
};
