'use strict';
// Démonstration — groupe « stock » : module Stock (articles, mouvements, lots, séries, seuils, inventaires, valorisation),
// Achats (demandes, appels d'offres, bons de commande, réceptions, factures, paiements, fournisseurs) et entrepôt WMS (Douala et Yaoundé).
// Ordre métier : le stock et ses réglages, puis l'historique d'achats sur plusieurs mois, puis l'entrepôt au quotidien.
// Ids utiles aux autres groupes : ctx.ids.stock (entrepôts, emplacements, palettes, bons de commande…).
module.exports = async function stock(ctx) {
  ctx.ids.stock = ctx.ids.stock || {};
  await require('./stock-core')(ctx);
  await require('./stock-purchasing')(ctx);
  await require('./stock-wms')(ctx);
  await require('./stock-wms-out')(ctx);
  await require('./stock-wms-pilot')(ctx);
};
