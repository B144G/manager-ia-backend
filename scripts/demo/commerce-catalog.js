'use strict';
// Catalogue de l'assistant commercial (prix de liste HT, prix plancher, remise maximale, paliers de quantité) et prix propres à certains clients.
// Les noms reprennent exactement ceux du stock : une ligne de devis/facture est ainsi reconnue par le contrôle des prix.
const { ITEMS } = require('./base');

// clé -> [description, plancher, remise max %, paliers]
const RULES = {
  ciment: ['Ciment Portland composé, idéal béton armé et maçonnerie. Livraison sur chantier dès 50 sacs.', 4800, 0, [{ min: 100, price: 5000 }, { min: 300, price: 4900 }]],
  fer10: ['Barre HA 10 mm, longueur 12 m, norme NF A 35-080.', 0, 8, [{ min: 100, price: 4650 }]],
  fer12: ['Barre HA 12 mm, longueur 12 m, pour poteaux et chaînages.', 6300, 0, [{ min: 100, price: 6600 }]],
  tole: ['Tôle bac aluminium 6/10e, 3 m, coloris naturel ou rouge brique.', 8300, 0, []],
  peinture: ['Peinture vinylique mate, intérieur/extérieur, 20 L (≈ 120 m²).', 0, 10, []],
  carreau: ['Carreau grès cérame 60×60, 1er choix, carton de 1,44 m².', 0, 0, [{ min: 50, price: 12000 }]],
  parpaing: ['Parpaing creux vibré 15×20×40, sortie presse.', 0, 0, [{ min: 1000, price: 420 }]],
  sable: ['Sable de rivière lavé, benne de 6 m³ livrée à Douala.', 0, 0, []],
  gravier: ['Gravier concassé 15/25, benne de 6 m³ livrée à Douala.', 0, 0, []],
  tuyau: ['Tube PVC pression Ø 50, longueur 6 m.', 0, 0, []],
  cable: ['Câble rigide 2,5 mm², rouleau de 100 m, norme NF C 32-321.', 0, 5, []],
  groupe: ['Groupe électrogène diesel 7,5 kVA, démarrage électrique, garantie 12 mois.', 1690000, 0, []],
};

module.exports = async function catalog(ctx, C) {
  const P = ctx.ids.prices; const cu = ctx.ids.customers;
  C.catalog = {};
  const have = ((await ctx.do("Assistant commercial : catalogue (liste)", 'GET', '/sales/catalog', undefined, { as: 'manager' })).items) || [];
  for (const [key, name, unit] of ITEMS) {
    const [description, floorPrice, maxDiscount, tiers] = RULES[key];
    const ex = have.find((i) => i.name === name);
    if (ex) { C.catalog[key] = ex.id; continue; }
    C.catalog[key] = (await ctx.do(`Catalogue : ajouter « ${name} »`, 'POST', '/sales/catalog', { name, description, price: P[key], unit, floorPrice: floorPrice || undefined, maxDiscount: maxDiscount || undefined, tiers }, { as: 'manager' })).id;
  }
  // Une erreur de saisie corrigée : un plancher au-dessus du prix de liste est refusé
  await ctx.do('Catalogue : plancher supérieur au prix de liste refusé', 'PUT', `/sales/catalog/${C.catalog.tole}`, { floorPrice: 9500 }, { as: 'manager', expect: 400 });
  await ctx.do('Catalogue : modifier la description et les paliers (tôle)', 'PUT', `/sales/catalog/${C.catalog.tole}`, { description: 'Tôle bac aluminium 6/10e, 3 m. Disponible en naturel et rouge brique. Pose possible par notre partenaire.', tiers: [{ min: 50, price: 8600 }] }, { as: 'manager' });
  const tmp = (await ctx.do('Catalogue : ajouter un article saisonnier', 'POST', '/sales/catalog', { name: 'Bâche de chantier 4×6 m', description: 'Protection saison des pluies', price: 9500, unit: 'pièce' }, { as: 'manager' })).id;
  if (tmp) {
    await ctx.do('Catalogue : désactiver un article (fin de saison)', 'PUT', `/sales/catalog/${tmp}`, { active: false }, { as: 'manager' });
    await ctx.do('Catalogue : supprimer un article', 'DELETE', `/sales/catalog/${tmp}`, undefined, { as: 'manager' });
  }

  // Prix et remises par client (grands comptes)
  await ctx.do('Clients : remise permanente de 3 % (Sogea Satom)', 'PUT', `/crm/customers/${cu.sogea}/discount`, { discount: 3 }, { as: 'manager' });
  await ctx.do('Clients : remise hors limites refusée', 'PUT', `/crm/customers/${cu.sogea}/discount`, { discount: 95 }, { as: 'manager', expect: 400 });
  await ctx.do('Clients : prix négocié ciment pour Sogea (contrat annuel)', 'PUT', `/crm/customers/${cu.sogea}/prices/${C.catalog.ciment}`, { price: 4950, validUntil: ctx.day(120), note: 'Contrat cadre 2026 — chantier Bonapriso' }, { as: 'manager' });
  await ctx.do('Clients : prix négocié fer HA 12 pour Sogea', 'PUT', `/crm/customers/${cu.sogea}/prices/${C.catalog.fer12}`, { price: 6500, validUntil: ctx.day(120), note: 'Contrat cadre 2026' }, { as: 'manager' });
  await ctx.do('Clients : prix client sous le plancher refusé à un responsable', 'PUT', `/crm/customers/${cu.bati}/prices/${C.catalog.ciment}`, { price: 4600 }, { as: 'manager', expect: ctx.users.manager ? 403 : 422 });
  await ctx.do('Clients : prix client sous le plancher accepté par la direction, avec motif', 'PUT', `/crm/customers/${cu.immo}/prices/${C.catalog.groupe}`, { price: 1650000, validUntil: ctx.day(60), reason: 'Lot de 3 groupes pour la résidence Odza : marge validée par la direction', note: 'Offre projet Odza' });
  await ctx.do('Clients : prix provisoire (tôles Bâti Plus)', 'PUT', `/crm/customers/${cu.bati}/prices/${C.catalog.tole}`, { price: 8700, validUntil: ctx.day(30), note: 'Offre de lancement' }, { as: 'manager' });
  await ctx.do('Clients : retirer un prix client', 'DELETE', `/crm/customers/${cu.bati}/prices/${C.catalog.tole}`, undefined, { as: 'manager' });
  const pr = await ctx.do('Clients : prix et remise du client (Sogea)', 'GET', `/crm/customers/${cu.sogea}/prices`, undefined, { as: 'manager' });
  ctx.check('Prix client : 2 prix négociés et remise de 3 %', (pr.prices || []).length === 2 && pr.defaultDiscount === 3, pr);
  const sg = await ctx.do('Ventes : suggestion de prix à la saisie (350 sacs pour Sogea)', 'GET', `/crm/price-suggest?itemId=${C.catalog.ciment}&customerId=${cu.sogea}&quantity=350`, undefined, { as: 'manager' });
  ctx.check('Suggestion de prix : palier 300 sacs (4 900) retenu, plancher 4 800', sg.found && sg.reference === 4900 && sg.floor === 4800, sg);
  await ctx.do('Ventes : suggestion de prix par libellé', 'GET', `/crm/price-suggest?label=${encodeURIComponent('Parpaing creux 15×20×40')}&quantity=1500`, undefined, { as: 'manager' });
};
