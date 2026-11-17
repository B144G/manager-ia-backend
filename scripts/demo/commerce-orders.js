'use strict';
// Démonstration · commandes clients : devis → commande confirmée → livraison → facture (chantier de l'Immobilière des Collines).
module.exports = async function orders(ctx, C) {
  const I = ctx.ids.items; const P = ctx.ids.prices; const cu = ctx.ids.customers;
  const lines = [
    { itemId: I.ciment, label: 'Ciment CPJ 42,5 — sac 50 kg', quantity: 60, price: P.ciment },
    { itemId: I.fer12, label: 'Fer à béton HA 12 mm — barre 12 m', quantity: 40, price: P.fer12 },
    { label: 'Livraison sur chantier (Odza)', quantity: 1, price: 25000 },
  ];
  const q = await ctx.do('Ventes : devis pour l\'immeuble d\'Odza (Immobilière des Collines)', 'POST', '/crm/documents', { kind: 'quote', customerId: cu.immo, lines, note: 'Gros œuvre R+4 — lot 2' }, { as: 'manager' });
  await ctx.do('Ventes : devis envoyé au client', 'PUT', `/crm/documents/${q.id}`, { status: 'sent' }, { as: 'manager' });
  const o = await ctx.do('Ventes : le client signe → « Créer la commande »', 'POST', `/crm/documents/${q.id}/order`, {}, { as: 'manager' });
  await ctx.do('Ventes : une seule commande par devis (2e essai refusé)', 'POST', `/crm/documents/${q.id}/order`, {}, { as: 'manager', expect: 409 });
  await ctx.do('Ventes : la commerciale n\'a pas accès aux commandes', 'POST', `/crm/documents/${q.id}/order`, {}, { as: 'seller', expect: ctx.users.seller ? 403 : 409 });
  const list = (await ctx.do('Ventes : onglet Commandes', 'GET', '/crm/documents?kind=order', undefined, { as: 'manager' })).documents || [];
  ctx.check('Ventes : la commande confirmée est dans l\'onglet Commandes', list.some((d) => d.id === o.id && d.status === 'confirmed'), list.map((d) => [d.number, d.status]));
  const docs = (await ctx.do('Logistique : documents à livrer', 'GET', '/logistics/documents', undefined, { as: 'manager' })).documents || [];
  ctx.check('Logistique : la commande peut être livrée', docs.some((d) => d.id === o.id && d.kind === 'order'), docs.slice(0, 5));
  // Deuxième commande, facturée tout de suite (acompte à la commande)
  const q2 = await ctx.do('Ventes : devis carrelage pour l\'Hôtel La Falaise', 'POST', '/crm/documents', { kind: 'quote', customerId: cu.hotel, lines: [{ itemId: I.carreau, label: 'Carreau grès 60×60 — carton 1,44 m²', quantity: 45, price: P.carreau }] }, { as: 'manager' });
  await ctx.do('Ventes : devis carrelage envoyé', 'PUT', `/crm/documents/${q2.id}`, { status: 'sent' }, { as: 'manager' });
  const o2 = await ctx.do('Ventes : commande carrelage', 'POST', `/crm/documents/${q2.id}/order`, {}, { as: 'manager' });
  const inv = await ctx.do('Ventes : commande → facture (acompte à la commande)', 'POST', `/sales/orders/${o2.id}/invoice`, { due: ctx.day(15) }, { as: 'manager' });
  await ctx.do('Ventes : devis déjà en commande → la facture se fait depuis la commande', 'POST', `/crm/documents/${q2.id}/convert`, {}, { as: 'manager', expect: [400, 409] });
  C.orders = { odza: o.id, falaise: o2.id, falaiseInvoice: inv.id };
};
