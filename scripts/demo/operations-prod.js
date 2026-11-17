'use strict';
// Production : l'aire de fabrication de Bonabéri moule des pavés autobloquants, des hourdis et des parpaings avec le ciment, le sable
// et le gravier du stock. Nomenclatures (coût de revient), ordres de fabrication (brouillon, lancé, clôturé avec rebut, annulé),
// manque de matières, capacité de fabrication, besoins d'un plan. La clôture sort les matières et entre le produit fini dans le stock.
const { ensureItem } = require('./operations-maint');
const P = '/production';

module.exports = async function production(ctx) {
  const O = ctx.ids.operations;
  const I = ctx.ids.items;
  const D = (n) => ctx.day(n);
  const stock = async (label) => Object.fromEntries(((await ctx.do(label, 'GET', '/stock')).items || []).map((i) => [i.id, Number(i.quantity)]));
  const items = (await ctx.do('Stock : articles (produits finis)', 'GET', '/stock')).items || [];
  const pave = await ensureItem(ctx, items, { name: 'Pavé autobloquant 6 cm gris — m²', unit: 'm²', quantity: 120, unitCost: 5200, minQuantity: 200, sku: 'PRD-001', tracking: 'none' });
  const hourdis = await ensureItem(ctx, items, { name: 'Hourdis 16 × 20 × 50', unit: 'pièce', quantity: 800, unitCost: 410, minQuantity: 1000, sku: 'PRD-002', tracking: 'none' });
  O.products = { pave, hourdis };

  // Réception des matières pour la campagne de fabrication (le chef magasinier saisit l'entrée).
  for (const [id, quantity, reason] of [[I.ciment, 400, 'Réception Cimencam BL 26-11-4471 (campagne pavés)'], [I.sable, 10, 'Carrière de Nkometou — 10 bennes'], [I.gravier, 8, 'Carrière de Nkometou — 8 bennes 15/25']]) {
    await ctx.do('Stock : entrée de matières premières', 'POST', `/stock/items/${id}/move`, { kind: 'in', quantity, reason }, { as: 'storekeeper' });
  }

  // ---------- Nomenclatures ----------
  const have = (await ctx.do('Production : nomenclatures', 'GET', `${P}/boms`)).boms || [];
  const boms = {};
  for (const [k, productId, body] of [
    ['pave', pave, { laborCost: 600, otherCost: 250, notes: 'Dosage 350 kg/m³, presse QT4-25, séchage 7 jours sous bâche. Rendement : 1 sac pour 3,3 m².', lines: [{ itemId: I.ciment, quantity: 0.3 }, { itemId: I.sable, quantity: 0.006 }, { itemId: I.gravier, quantity: 0.008 }] }],
    ['hourdis', hourdis, { laborCost: 60, otherCost: 25, notes: 'Moule hourdis 16, 28 pièces par sac de ciment.', lines: [{ itemId: I.ciment, quantity: 0.035 }, { itemId: I.sable, quantity: 0.0009 }, { itemId: I.gravier, quantity: 0.0012 }] }],
    ['parpaing', I.parpaing, { laborCost: 45, otherCost: 20, notes: 'Parpaing creux 15, 13 pièces par sac.', lines: [{ itemId: I.ciment, quantity: 0.077 }, { itemId: I.sable, quantity: 0.0012 }] }],
  ]) {
    const ex = have.find((b) => b.productId === productId);
    boms[k] = ex ? ex.id : (await ctx.do(`Production : nomenclature « ${k} »`, 'POST', `${P}/boms`, { productId, ...body }, { as: 'manager' })).id;
  }
  await ctx.do('Production : un produit n\'a qu\'une nomenclature', 'POST', `${P}/boms`, { productId: pave, lines: [{ itemId: I.ciment, quantity: 1 }] }, { as: 'manager', expect: 400 });
  if (ctx.users.storekeeper) await ctx.do('Production : un membre ne crée pas de nomenclature (droits)', 'POST', `${P}/boms`, { productId: I.tuyau, lines: [{ itemId: I.ciment, quantity: 1 }] }, { as: 'storekeeper', expect: 403 });
  await ctx.do('Production : modifier une nomenclature (main-d\'œuvre, dosage)', 'PUT', `${P}/boms/${boms.pave}`, { laborCost: 650, lines: [{ itemId: I.ciment, quantity: 0.3 }, { itemId: I.sable, quantity: 0.006 }, { itemId: I.gravier, quantity: 0.008 }] }, { as: 'manager' });
  const tmp = (await ctx.do('Production : nomenclature d\'essai', 'POST', `${P}/boms`, { productId: I.tuyau, laborCost: 100, lines: [{ itemId: I.cable, quantity: 0.01 }] }, { as: 'manager' })).id;
  await ctx.do('Production : supprimer une nomenclature', 'DELETE', `${P}/boms/${tmp}`, undefined, { as: 'manager' });
  const bl = (await ctx.do('Production : nomenclatures (coût de revient, capacité)', 'GET', `${P}/boms`, undefined, { as: 'manager' })).boms || [];
  const bp = bl.find((b) => b.id === boms.pave) || {};
  // Matières : 0,3 × 4 300 + 0,006 × 65 000 + 0,008 × 90 000 = 1 290 + 390 + 720 = 2 400 ; + 650 + 250 = 3 300 FCFA le m² (au coût d'achat des fiches)
  ctx.check('Production : coût de revient du pavé calculé (matières + main-d\'œuvre + frais)', bp.unitCost > 0 && bp.unitCost === bp.materialCost + 650 + 250, bp);
  const memberView = (await ctx.do('Production : nomenclatures (vue membre, sans les coûts)', 'GET', `${P}/boms`, undefined, { as: 'storekeeper' })).boms || [];
  if (ctx.users.storekeeper) ctx.check('Production : les coûts sont cachés aux membres', memberView.every((b) => b.unitCost === undefined), memberView[0]);

  // ---------- Ordres de fabrication ----------
  const of = {};
  for (const [k, body] of [
    ['p1', { bomId: boms.pave, quantity: 400, dueDate: D(-10), notes: 'Commande Commune de Douala 5e — trottoirs de Kotto.' }],
    ['b1', { bomId: boms.parpaing, quantity: 3000, dueDate: D(-3), notes: 'Réassort parpaings (stock bas en saison sèche).' }],
    ['h1', { bomId: boms.hourdis, quantity: 30000, dueDate: D(12), notes: 'Plancher du chantier R+4 d\'Odza (Immobilière des Collines).' }],
    ['p2', { bomId: boms.pave, quantity: 300, dueDate: D(-2), notes: 'Cour de l\'Hôtel La Falaise.' }],
    ['b2', { bomId: boms.parpaing, quantity: 1500, dueDate: D(20) }],
    ['x', { bomId: boms.hourdis, quantity: 50 }],
  ]) of[k] = (await ctx.do(`Production : ordre de fabrication (${k})`, 'POST', `${P}/orders`, body, { as: 'manager' })).id;
  await ctx.do('Production : modifier un brouillon (quantité)', 'PUT', `${P}/orders/${of.b2}`, { quantity: 2000, notes: 'Quantité revue après le point commercial du lundi.' }, { as: 'manager' });
  await ctx.do('Production : supprimer un brouillon', 'DELETE', `${P}/orders/${of.x}`, undefined, { as: 'manager' });
  await ctx.do('Production : annuler un ordre', 'POST', `${P}/orders/${of.b2}/cancel`, {}, { as: 'manager' });

  const chk = await ctx.do('Production : vérifier les matières (hourdis du R+4)', 'GET', `${P}/orders/${of.h1}/check`);
  ctx.check('Production : manque de matières détecté pour 30 000 hourdis', chk.ok === false && (chk.shortages || []).length > 0, chk.shortages);
  await ctx.do('Production : lancement refusé (matières manquantes)', 'POST', `${P}/orders/${of.h1}/launch`, {}, { as: 'manager', expect: 409 });
  await ctx.do('Production : lancer quand même (achat de gravier en cours)', 'POST', `${P}/orders/${of.h1}/launch`, { force: true }, { as: 'manager' });
  await ctx.do('Production : vérifier les matières (pavés)', 'GET', `${P}/orders/${of.p1}/check`);
  for (const k of ['p1', 'b1', 'p2']) await ctx.do(`Production : lancer l'ordre (${k})`, 'POST', `${P}/orders/${of[k]}/launch`, {}, { as: 'manager' });

  const s0 = await stock('Stock : quantités avant la clôture');
  const c1 = await ctx.do('Production : clôturer les pavés (392 m² bons, 8 m² de rebut)', 'POST', `${P}/orders/${of.p1}/close`, { producedQty: 392, scrapQty: 8, notes: 'Deux palettes cassées au démoulage.' }, { as: 'manager' });
  const s1 = await stock('Stock : quantités après la clôture');
  ctx.check('Stock : la clôture consomme 120 sacs de ciment (400 m² × 0,3) et entre 392 m² de pavés', Math.abs((s0[I.ciment] - s1[I.ciment]) - 120) < 1e-6 && Math.abs((s1[pave] - s0[pave]) - 392) < 1e-6, { ciment: [s0[I.ciment], s1[I.ciment]], pave: [s0[pave], s1[pave]] });
  ctx.check('Production : coût réel du m² calculé à la clôture', c1.unitCost > 0, c1);
  await ctx.do('Production : clôturer les parpaings (2 950 bons, 50 cassés)', 'POST', `${P}/orders/${of.b1}/close`, { producedQty: 2950, scrapQty: 50 }, { as: 'manager' });
  if (ctx.users.storekeeper) await ctx.do('Production : un membre ne clôture pas (droits)', 'POST', `${P}/orders/${of.p2}/close`, {}, { as: 'storekeeper', expect: 403 });

  // ---------- Planification ----------
  await ctx.do('Production : capacité de fabrication avec le stock actuel', 'GET', `${P}/plan/capacity`, undefined, { as: 'manager' });
  const needs = await ctx.do('Production : besoins en matières d\'un plan (mois prochain)', 'POST', `${P}/plan/needs`, { lines: [{ bomId: boms.pave, quantity: 1500 }, { bomId: boms.hourdis, quantity: 12000 }, { bomId: boms.parpaing, quantity: 5000 }] }, { as: 'manager' });
  ctx.check('Production : le plan chiffre le manque de matières', needs.missingCount > 0 && needs.missingCost > 0, needs);
  const dash = await ctx.do('Production : tableau de bord', 'GET', P, undefined, { as: 'manager' });
  ctx.check('Production : production du mois, rendement et ordres en retard', dash.summary && dash.summary.monthProduced >= 3342 && dash.summary.yieldPct > 95 && dash.summary.late >= 1 && dash.summary.inProgress === 2, dash.summary);
  O.boms = boms; O.productionOrders = of;
};
