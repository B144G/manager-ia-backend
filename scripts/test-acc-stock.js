'use strict';
// Comptabilité : valorisation du stock et variation de stock (inventaire intermittent). Lancez-le avec : node scripts/test-acc-stock.js
const { run } = require('./lib/wave1');

run('Valorisation du stock en comptabilité', async ({ check, owner, mgr, other, O, org, dbx }) => {
  let r;
  r = await owner('POST', `${O}/stock/items`, { name: 'Ciment 50 kg', unit: 'sac', quantity: 100, unitCost: 4500 });
  const ciment = r.json.id;
  r = await owner('POST', `${O}/stock/items`, { name: 'Tôle bac', unit: 'feuille', quantity: 20, unitCost: 7000 });
  const tole = r.json.id;
  await owner('POST', `${O}/stock/items`, { name: 'Article épuisé', unit: 'pièce', unitCost: 1000 });
  r = await owner('GET', `${O}/accounting/stock-valuation`);
  check('valorisation : 100 × 4 500 + 20 × 7 000 = 590 000, rien en comptabilité', r.status === 200 && r.json.totalValue === 590000 && r.json.accounting === 0 && r.json.gap === 590000 && r.json.items.length === 2 && r.json.account === '311' && r.json.variationAccount === '6031', r.json);
  r = await mgr('GET', `${O}/accounting/stock-valuation`);
  check('réservé aux administrateurs', r.status === 403, r.status);
  r = await other('GET', `${O}/accounting/stock-valuation`);
  check('cloisonnement : une autre organisation n\'y a pas accès', r.status === 403 || r.status === 404, r.status);
  r = await owner('GET', `${O}/accounting/stock-valuation?date=2999-01-01`);
  check('date future refusée', r.status === 400, r.json);
  r = await owner('GET', `${O}/accounting/stock-valuation?nature=autre`);
  check('nature inconnue refusée', r.status === 400, r.json);

  r = await owner('POST', `${O}/accounting/stock-valuation/post`, {});
  check('constater le stock : écriture passée (débit 311, crédit 6031)', r.status === 201 && r.json.amount === 590000 && r.json.increase === true && r.json.entry, r.json);
  const lines = await dbx.prepare("SELECT l.account, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.org_id = ? AND e.source = 'stock_valuation' ORDER BY l.id").all(org);
  check('écriture équilibrée sur 311 / 6031', lines.length === 2 && lines[0].account === '311' && Number(lines[0].debit) === 590000 && lines[1].account === '6031' && Number(lines[1].credit) === 590000, lines);
  r = await owner('GET', `${O}/accounting/stock-valuation`);
  check('après constatation : aucun écart, historique visible', r.json.gap === 0 && r.json.accounting === 590000 && r.json.history.length === 1 && r.json.history[0].increase === true && r.json.history[0].amount === 590000, r.json);
  r = await owner('POST', `${O}/accounting/stock-valuation/post`, {});
  check('pas de seconde écriture sans écart', r.status === 400, r.json);

  // Sortie de 40 sacs : le stock baisse, l'écart est une diminution
  await owner('POST', `${O}/stock/items/${ciment}/move`, { kind: 'out', quantity: 40 });
  r = await owner('GET', `${O}/accounting/stock-valuation`);
  check('après une sortie : écart négatif de 180 000 (stock à retirer)', r.json.gap === -180000, r.json.gap);
  r = await owner('POST', `${O}/accounting/stock-valuation/post`, { nature: 'goods' });
  check('diminution : débit 6031, crédit 311', r.status === 201 && r.json.increase === false && r.json.amount === 180000, r.json);

  // Date passée : quantités reconstituées depuis les mouvements (les mouvements d'aujourd'hui sont annulés pour hier)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  r = await owner('GET', `${O}/accounting/stock-valuation?date=${yesterday}`);
  check('date passée : quantités reconstituées (aucun stock hier)', r.status === 200 && r.json.totalValue === 0 && r.json.items.length === 0, r.json);
  r = await owner('GET', `${O}/accounting/stock-valuation?nature=raw`);
  check('matières premières : compte 321 / 6032', r.status === 200 && r.json.account === '321' && r.json.variationAccount === '6032' && r.json.accounting === 0, r.json);
  void tole;
});
