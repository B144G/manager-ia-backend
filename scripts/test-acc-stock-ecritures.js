'use strict';
// Stock en comptabilité : valorisation, constatation de la variation de stock, annulation, périodes clôturées, droits. Lancez-le avec : node scripts/test-acc-stock.js
const { run } = require('./lib/wave2');

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (n) => iso(new Date(Date.now() + n * 86400000));

run('Stock en comptabilité : valorisation et variation de stock', async ({ check, owner, mem, other, org2, O, ws, dbx, org }) => {
  const AC = `${O}/accounting`; const AC2 = `${ws(org2)}/accounting`; const ST = `${O}/stock`;
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND role = 'manager'").run(org);
  const today = shift(0);
  let r;

  for (const [m, u] of [['GET', `/stock-valuation?date=${today}`], ['POST', '/stock-valuation/post']]) {
    r = await mem(m, `${AC}${u}`, m === 'POST' ? { date: today } : undefined);
    check(`droits : ${m} ${u.split('?')[0]} refusé à un simple membre`, r.status === 403, r.status);
  }

  r = await owner('GET', `${AC}/stock-valuation?date=${today}`);
  check('stock vide : valeur 0, comptabilité 0, écart 0', r.status === 200 && r.json.totalValue === 0 && r.json.accounting === 0 && r.json.gap === 0 && r.json.account === '311' && r.json.variationAccount === '6031', r.json);
  r = await owner('POST', `${AC}/stock-valuation/post`, { date: today });
  check('stock vide : rien à passer (400)', r.status === 400, r.status);

  const a = await owner('POST', `${ST}/items`, { name: 'Planche de chêne', unit: 'pièce', quantity: 10, unitCost: 5000 });
  const b = await owner('POST', `${ST}/items`, { name: 'Vis à bois', unit: 'boîte', quantity: 100, unitCost: 100 });
  check('articles créés', a.status === 201 && b.status === 201, [a.status, b.status]);
  // les mouvements de départ datent d'il y a 5 jours (pour tester une date passée)
  await dbx.prepare('UPDATE stock_items SET created_at = ? WHERE org_id = ?').run(`${shift(-5)}T08:00:00.000Z`, org);
  await dbx.prepare('UPDATE stock_moves SET created_at = ? WHERE org_id = ?').run(`${shift(-5)}T08:00:00.000Z`, org);

  r = await owner('GET', `${AC}/stock-valuation?date=${today}`);
  check('valorisation : 10 × 5 000 + 100 × 100 = 60 000, écart 60 000', r.json.totalValue === 60000 && r.json.items.length === 2 && r.json.gap === 60000, r.json);
  r = await owner('POST', `${AC}/stock-valuation/post`, { date: today });
  check('constatation : écriture OD créée (hausse de 60 000)', r.status === 201 && r.json.amount === 60000 && r.json.increase === true && /^OD-/.test(r.json.entry), r.json);
  const found = async (q) => ((await owner('GET', `${AC}/entries?q=${encodeURIComponent(q)}`)).json.entries || []);
  let es = await found('Variation de stock');
  const e1 = es[0];
  check('écriture : débit 311, crédit 6031, équilibrée, pièce INV', e1 && e1.lines.some((l) => l.account === '311' && l.debit === 60000) && e1.lines.some((l) => l.account === '6031' && l.credit === 60000) && /^INV-goods-/.test(e1.piece), e1);
  r = await owner('GET', `${AC}/stock-valuation?date=${today}`);
  check('après constatation : comptabilité = 60 000, écart 0, historique de 1 ligne', r.json.accounting === 60000 && r.json.gap === 0 && r.json.history.length === 1 && r.json.history[0].increase === true, r.json);
  r = await owner('POST', `${AC}/stock-valuation/post`, { date: today });
  check('rejouer le même jour : refusé (rien à passer), aucun doublon', r.status === 400, r.status);

  // Sortie de 4 planches : la valeur baisse de 20 000 → variation en sens inverse
  const mv = await owner('POST', `${ST}/items/${a.json.id}/move`, { kind: 'out', quantity: 4, reason: 'Fabrication' });
  check('sortie de stock enregistrée', mv.status === 200, mv.status);
  r = await owner('GET', `${AC}/stock-valuation?date=${today}`);
  check('après la sortie : valeur 40 000, écart −20 000', r.json.totalValue === 40000 && r.json.gap === -20000, [r.json.totalValue, r.json.gap]);
  r = await owner('POST', `${AC}/stock-valuation/post`, { date: today });
  check('baisse constatée : débit 6031, crédit 311', r.status === 201 && r.json.increase === false && r.json.amount === 20000, r.json);
  es = await found('Variation de stock');
  const e2 = es.find((e) => e.lines.some((l) => l.account === '6031' && l.debit === 20000));
  check('écriture de baisse : débit 6031 20 000, crédit 311 20 000', e2 && e2.lines.some((l) => l.account === '311' && l.credit === 20000), es.map((e) => e.lines));
  r = await owner('GET', `${AC}/statements?year=${today.slice(0, 4)}`);
  check('bilan : le poste « stocks » vaut 40 000', r.json.bilan.stocks === 40000 || JSON.stringify(r.json.bilan).includes('40000'), r.json.bilan);

  // Date passée : les mouvements d'aujourd'hui sont retirés, l'article a 10 planches
  r = await owner('GET', `${AC}/stock-valuation?date=${shift(-2)}`);
  const pl = r.json.items.find((x) => x.name === 'Planche de chêne');
  check('date passée : quantité reconstituée (10 planches, 60 000), comptabilité à cette date = 0', pl && pl.quantity === 10 && r.json.totalValue === 60000 && r.json.accounting === 0, r.json);
  r = await owner('GET', `${AC}/stock-valuation?date=${shift(-10)}`);
  check('date avant la création des articles : stock nul', r.json.totalValue === 0 && r.json.items.length === 0, r.json);

  // Annulation puis nouvelle constatation (pas de blocage par l'unicité source)
  const rev = await owner('POST', `${AC}/entries/${e2.id}/reverse`, {});
  check('annulation de l\'écriture de baisse', rev.status === 200 || rev.status === 201, rev.status);
  r = await owner('POST', `${AC}/stock-valuation/post`, { date: today });
  check('après annulation : la baisse peut être constatée à nouveau', r.status === 201 && r.json.amount === 20000 && r.json.increase === false, r.json);

  // Contrôles de saisie
  for (const [lab, body] of [['date invalide', { date: '2026-13-45' }], ['nature inconnue', { date: today, nature: 'x' }], ['date future', { date: shift(3) }]]) {
    r = await owner('POST', `${AC}/stock-valuation/post`, body);
    check(`refus : ${lab}`, r.status === 400, r.status);
  }
  // Période clôturée
  await dbx.prepare("UPDATE acc_settings SET locked_until = ? WHERE org_id = ?").run(shift(-1), org);
  await owner('PUT', `${AC}/settings`, { lockedUntil: shift(-1) });
  await owner('PUT', `${ST}/items/${b.json.id}`, {});
  const old = await owner('POST', `${AC}/stock-valuation/post`, { date: shift(-2) });
  check('période clôturée : la constatation à une date verrouillée est refusée', old.status === 400, [old.status, old.json]);

  r = await other('GET', `${AC2}/stock-valuation?date=${today}`);
  check('cloisonnement : l\'autre organisation ne voit pas ces articles', r.status === 200 && r.json.items.length === 0 && r.json.totalValue === 0, r.json);
  r = await owner('GET', `${AC2}/stock-valuation?date=${today}`);
  check('cloisonnement : accès à l\'autre organisation refusé', r.status === 404, r.status);
});
