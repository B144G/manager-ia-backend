'use strict';
// Démonstration — groupe « operations » : Logistique et Transport (TMS), Production, Maintenance, Chantiers (BTP).
// Batimat Afrique livre ses clients avec sa propre flotte (dépôt de Bonabéri) et des transporteurs, fabrique des pavés et des hourdis,
// entretient son parc (chariots, groupe électrogène, camions) et réalise quelques chantiers de second œuvre.
module.exports = async function operations(ctx) {
  ctx.ids.operations = ctx.ids.operations || {};
  // La maintenance d'abord : un camion du parc est relié à son équipement « véhicule » (compteur kilométrique partagé).
  await require('./operations-maint')(ctx);
  await require('./operations-tms')(ctx);
  await require('./operations-geo')(ctx); // géolocalisation des transporteurs, clients et fournisseurs typés
  await require('./operations-prod')(ctx);
  await require('./operations-site')(ctx);
};
