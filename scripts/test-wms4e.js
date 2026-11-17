'use strict';
// Stock entrepôt (WMS) — pilotage (4E) : optimisation des emplacements (distances, rotation, articles lourds, échanges, gain simulé,
// tâches exécutées par scan), productivité des magasiniers (durées, lignes / heure, performance par rapport aux standards, classement
// réservé aux responsables), cour et quais (quais, rendez-vous, arrivée, mise à quai, départ, attente, ponctualité, occupation, calendrier),
// tableau de bord en temps réel. Les chiffres attendus sont calculés à la main dans les commentaires.
// Lancez-le avec : node scripts/test-wms4e.js
const { run } = require('./lib/wave1');

run('Stock entrepôt : pilotage (emplacements, productivité, cour et quais, tableau de bord)', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx }) => {
  const WM = `${O}/stock/wms`;
  let r;
  const coherent = async () => {
    const a = await dbx.prepare('SELECT i.id, i.quantity, COALESCE((SELECT SUM(s.quantity) FROM wms_stock s WHERE s.item_id = i.id), 0) AS loc FROM stock_items i WHERE i.org_id = ?').all(org);
    return a.filter((x) => Math.abs(Number(x.quantity) - Number(x.loc)) > 1e-6);
  };
  const ok = async (label) => { const c = await coherent(); check(`cohérence ${label}`, c.length === 0, c); };
  const at = async (code, id) => { const l = (await owner('GET', `${WM}/items/${id}/levels`)).json.levels.find((x) => x.code === code); return l ? l.quantity : 0; };
  const users = Object.fromEntries((await dbx.prepare('SELECT m.user_id, m.role FROM org_members m WHERE m.org_id = ?').all(org)).map((m) => [m.role, Number(m.user_id)]));

  // ---------- Mise en place ----------
  r = await owner('GET', `${WM}/overview`);
  const wh = r.json.warehouses[0].id;
  r = await owner('POST', `${WM}/zones`, { warehouseId: wh, name: 'Allée A', code: 'ZA' });
  const za = r.json.id;
  r = await owner('POST', `${WM}/locations/bulk`, { warehouseId: wh, aisles: 'A', racks: '2', bins: '1', zoneId: za, capacity: 100 });
  check('emplacements A-01-01, A-02-01 (zone A, capacité 100)', r.json.created === 2, r.json);
  r = await owner('POST', `${WM}/locations/bulk`, { warehouseId: wh, aisles: 'B C', racks: '2', bins: '1' });
  check('emplacements B-01-01 … C-02-01', r.json.created === 4, r.json);
  r = await owner('POST', `${WM}/locations`, { warehouseId: wh, code: 'RECEP', kind: 'reception' });
  const recep = r.json.id;
  r = await owner('POST', `${WM}/locations`, { warehouseId: wh, code: 'QUAI-EXP-1', kind: 'shipping' });
  const quai = r.json.id;
  const L = Object.fromEntries((await owner('GET', `${WM}/locations`)).json.locations.map((l) => [l.code, l]));
  const item = async (b) => (await owner('POST', `${O}/stock/items`, b)).json.id;
  const X = await item({ name: 'Riz 25 kg', unit: 'sac', unitCost: 15000, sku: 'RIZ-25', barcode: 'RIZ00025' });
  const Y = await item({ name: 'Huile 5 L', unit: 'bidon', unitCost: 6000, sku: 'HUI-5' });
  const Z = await item({ name: 'Savon', unit: 'carton', unitCost: 9000, sku: 'SAV-1' });
  const HV = await item({ name: 'Ciment 50 kg', unit: 'sac', unitCost: 5000, sku: 'CIM-50' });
  const put = (id, q, loc) => owner('POST', `${O}/stock/items/${id}/move`, { kind: 'in', quantity: q, locationId: L[loc].id, reason: 'Stock initial' });
  await put(X, 20, 'B-02-01'); await put(Y, 10, 'A-01-01'); await put(Z, 5, 'A-02-01'); await put(HV, 8, 'C-01-01');
  await ok('après les entrées');

  // ---------- Distances ----------
  // Allées A, B, C → 1 × 5, 2 × 5, 3 × 5 m ; rayon n → n × 1 m. A-01 = 6, A-02 = 7, B-01 = 11, B-02 = 12, C-01 = 16, C-02 = 17 ; PRINCIPAL (sans allée) : aucune.
  r = await mem('GET', `${WM}/slotting/locations`);
  const D = Object.fromEntries(r.json.locations.map((l) => [l.code, l]));
  check('distances déduites de l\'allée et du rayon', D['A-01-01'].distance === 6 && D['A-02-01'].distance === 7 && D['B-01-01'].distance === 11 && D['B-02-01'].distance === 12 && D['C-01-01'].distance === 16 && D['C-02-01'].distance === 17 && D['A-01-01'].source === 'derived', r.json.locations.map((l) => [l.code, l.distance]));
  check('emplacement sans allée : pas de distance', D.PRINCIPAL.distance === null, D.PRINCIPAL);
  r = await mem('PUT', `${WM}/slotting/config`, { aislePitch: 3 });
  check('réglages : réservés aux responsables', r.status === 403, r.status);
  r = await mgr('PUT', `${WM}/slotting/config`, { aisleDistances: { a: 2 } });
  check('distance de l\'allée A saisie (2 m)', r.status === 200 && r.json.config.aisleDistances.A === 2, r.json);
  r = await mgr('PUT', `${WM}/slotting/zones/${za}`, { distance: 10 });
  r = await mgr('PUT', `${WM}/slotting/locations/${L['C-02-01'].id}`, { distance: 4.5 });
  r = await mem('GET', `${WM}/slotting/locations`);
  const DL2 = Object.fromEntries(r.json.locations.map((l) => [l.code, l]));
  check('distance = zone (10) + allée (2) + rayon (1) ; distance saisie prioritaire', DL2['A-01-01'].distance === 13 && DL2['B-01-01'].distance === 11 && DL2['C-02-01'].distance === 4.5 && DL2['C-02-01'].source === 'manual', [DL2['A-01-01'], DL2['C-02-01']]);
  await mgr('PUT', `${WM}/slotting/config`, { aisleDistances: {} });
  await mgr('PUT', `${WM}/slotting/zones/${za}`, { distance: '' });
  await mgr('PUT', `${WM}/slotting/locations/${L['C-02-01'].id}`, { distance: '' });
  r = await mgr('PUT', `${WM}/slotting/locations/${L['C-01-01'].id}`, { level: 99 });
  check('niveau invalide refusé', r.status === 400, r.json);
  for (const [c, lv] of [['A-01-01', 0], ['A-02-01', 1], ['B-01-01', 0], ['B-02-01', 0], ['C-01-01', 3], ['C-02-01', 0]]) await mgr('PUT', `${WM}/slotting/locations/${L[c].id}`, { level: lv });
  r = await mgr('PUT', `${WM}/slotting/items/${HV}`, { weightKg: '30' });
  check('poids d\'un article enregistré', r.status === 200, r.json);

  // ---------- Fréquence de prélèvement (historique des listes) ----------
  const now = new Date().toISOString();
  const pk = Number((await dbx.prepare("INSERT INTO wms_picks (org_id, code, status, created_at) VALUES (?, 'HIST-1', 'issued', ?) RETURNING id").get(org, now)).id);
  const line = (it, q) => dbx.prepare('INSERT INTO wms_pick_lines (pick_id, item_id, quantity, picked_qty, done, picked_at) VALUES (?, ?, ?, ?, 1, ?)').run(pk, it, q, q, now);
  for (let i = 0; i < 10; i++) await line(X, 2);
  for (let i = 0; i < 2; i++) await line(Y, 1);
  await line(HV, 1);
  const old = Number((await dbx.prepare("INSERT INTO wms_picks (org_id, code, status, created_at) VALUES (?, 'HIST-0', 'issued', '2020-01-01T00:00:00.000Z') RETURNING id").get(org)).id);
  await dbx.prepare("INSERT INTO wms_pick_lines (pick_id, item_id, quantity, picked_qty, done, picked_at) VALUES (?, ?, 5, 5, 1, '2020-01-01T00:00:00.000Z')").run(old, Z);

  // ---------- Analyse ----------
  r = await mem('GET', `${WM}/slotting/analysis`);
  check('analyse : réservée aux responsables', r.status === 403, r.status);
  r = await mgr('GET', `${WM}/slotting/analysis`);
  const an = r.json;
  const I = Object.fromEntries(an.items.map((x) => [x.itemId, x]));
  // Visites : riz 10, huile 2, ciment 1 (13 en tout ; le savon n'a qu'un prélèvement hors période). Cumul : 10/13 = 76,9 % → A ; 12/13 = 92,3 % → B ; 100 % → C.
  check('visites sur 90 jours (l\'historique ancien ne compte pas)', an.totals.hits === 13 && I[X].hits === 10 && I[X].units === 20 && I[Y].hits === 2 && I[HV].hits === 1 && I[Z].hits === 0, an.items.map((x) => [x.name, x.hits]));
  check('classes de rotation A / B / C', I[X].velocity === 'A' && I[Y].velocity === 'B' && I[HV].velocity === 'C' && I[Z].velocity === '-', an.items.map((x) => [x.name, x.velocity]));
  check('article lourd repéré (30 kg ≥ 20 kg)', I[HV].heavy === true && I[X].heavy === false, I[HV]);
  const PR = Object.fromEntries(an.proposals.map((p) => [p.itemId, p]));
  // Riz (10) prend A-01 (6 m) en échange de l'huile ; l'huile prend A-02 (7 m) en échange du savon ; le savon part en B-02 ;
  // le ciment (lourd, niveau 3) descend en B-01 (niveau 0, 11 m) : A-01 et A-02 sont déjà pris (et A-02 est au niveau 1).
  check('propositions : riz B-02 → A-01, huile A-01 → A-02, savon A-02 → B-02, ciment C-01 → B-01', an.proposals.length === 4 && PR[X].from === 'B-02-01' && PR[X].to === 'A-01-01' && PR[Y].to === 'A-02-01' && PR[Z].from === 'A-02-01' && PR[Z].to === 'B-02-01' && PR[HV].to === 'B-01-01', an.proposals.map((p) => [p.name, p.from, p.to]));
  // Gains : riz 10 × 2 × (12 − 6) = 120 ; ciment 1 × 2 × (16 − 11) = 10 ; savon 0 ; huile 2 × 2 × (6 − 7) = −4.
  check('gain par déplacement et tri par gain', PR[X].gain === 120 && PR[HV].gain === 10 && PR[Z].gain === 0 && PR[Y].gain === -4 && an.proposals[0].itemId === X && an.proposals[3].itemId === Y, an.proposals.map((p) => [p.name, p.gain]));
  check('motif : article lourd trop haut', PR[HV].reason === 'heavy' && PR[X].reason === 'velocity', PR[HV]);
  // Parcours actuel 240 + 24 + 32 = 296 m ; proposé 120 + 28 + 22 = 170 m ; gain 126 m = 42,6 %.
  check('gain simulé : 296 m → 170 m (−126 m, −42,6 %)', an.totals.currentTravel === 296 && an.totals.proposedTravel === 170 && an.totals.gain === 126 && an.totals.gainPct === 42.6 && an.totals.moves === 4, an.totals);
  r = await mgr('GET', `${WM}/slotting/analysis?days=0`);
  check('période invalide refusée', r.status === 400, r.json);

  // ---------- Tâches ----------
  r = await mem('POST', `${WM}/slotting/tasks`, {});
  check('tâches : un membre ne les crée pas', r.status === 403, r.status);
  r = await mgr('POST', `${WM}/slotting/tasks`, {});
  check('4 tâches de déplacement créées (SL-…)', r.status === 201 && r.json.created.length === 4 && r.json.created.every((t) => /^SL-\d{4}$/.test(t.code)), r.json);
  r = await mgr('POST', `${WM}/slotting/tasks`, {});
  check('pas de double tâche pour un même article', r.status === 201 && r.json.created.length === 0, r.json);
  r = await mgr('GET', `${WM}/slotting/analysis`);
  check('analyse : articles en cours de déplacement signalés, plus de proposition', r.json.proposals.length === 0 && r.json.items.filter((x) => x.pending).length === 4, r.json.proposals);
  r = await mem('GET', `${WM}/slotting/tasks`);
  const T = Object.fromEntries(r.json.tasks.map((t) => [t.itemId, t]));
  check('liste des tâches (membre) : quantités en vrac', r.json.tasks.length === 4 && T[X].quantity === 20 && T[Z].quantity === 5 && T[X].from === 'B-02-01' && T[X].to === 'A-01-01', r.json.tasks);
  r = await mem('GET', `${WM}/scan?code=${T[X].code}`);
  check('scan : une tâche d\'optimisation se reconnaît', r.json.type === 'slotting' && r.json.id === T[X].id, r.json);
  r = await mem('POST', `${WM}/slotting/tasks/${T[X].id}/confirm`, { fromLocationCode: 'A-01-01' });
  check('scan : mauvais emplacement de départ refusé', r.status === 400 && /B-02-01/.test(r.json.error), r.json);
  r = await mem('POST', `${WM}/slotting/tasks/${T[X].id}/confirm`, { fromLocationCode: 'b-02-01', itemCode: 'HUI-5' });
  check('scan : mauvais article refusé', r.status === 400 && /Riz/.test(r.json.error), r.json);
  r = await mem('POST', `${WM}/slotting/tasks/${T[X].id}/confirm`, { fromLocationCode: 'b-02-01', itemCode: 'RIZ00025', toLocationCode: 'A-02-01' });
  check('scan : mauvais emplacement d\'arrivée refusé', r.status === 400 && /A-01-01/.test(r.json.error), r.json);
  const both = await Promise.all([1, 2].map(() => mem('POST', `${WM}/slotting/tasks/${T[X].id}/confirm`, { fromLocationCode: 'B-02-01', itemCode: 'RIZ00025', toLocationCode: 'A-01-01' })));
  check('double scan simultané : un seul déplacement', both.filter((x) => x.status === 200).length === 1 && both.filter((x) => x.status === 400).length === 1, both.map((x) => [x.status, x.json]));
  check('riz déplacé : 20 sacs en A-01-01', await at('A-01-01', X) === 20 && await at('B-02-01', X) === 0, null);
  await ok('après un déplacement d\'optimisation');
  r = await other('POST', `${ws(org2)}/stock/wms/slotting/tasks/${T[Y].id}/confirm`, {});
  check('cloisonnement : tâche introuvable depuis une autre organisation', r.status === 404, r.status);
  r = await mem('POST', `${WM}/slotting/tasks/${T[Y].id}/cancel`, {});
  check('annulation : réservée aux responsables', r.status === 403, r.status);
  for (const id of [Y, Z, HV]) { r = await mem('POST', `${WM}/slotting/tasks/${T[id].id}/confirm`, {}); check(`tâche ${T[id].code} faite`, r.status === 200 && r.json.quantity === T[id].quantity, r.json); }
  check('huile en A-02, savon en B-02, ciment en B-01', await at('A-02-01', Y) === 10 && await at('B-02-01', Z) === 5 && await at('B-01-01', HV) === 8 && await at('C-01-01', HV) === 0, null);
  await ok('après les déplacements d\'optimisation');
  r = await mgr('GET', `${WM}/slotting/analysis`);
  check('après optimisation : parcours 170 m, plus rien à proposer', r.json.totals.currentTravel === 170 && r.json.totals.gain === 0 && r.json.proposals.length === 0, r.json.totals);
  r = await mgr('GET', `${WM}/slotting/tasks?status=done`);
  check('tâches faites : par qui', r.json.tasks.length === 4 && r.json.tasks.every((t) => t.doneBy === 'Paul'), r.json.tasks.map((t) => t.doneBy));
  r = await dbx.prepare("SELECT COUNT(*) AS n, SUM(units) AS u FROM wms_labor WHERE org_id = ? AND task = 'slotting' AND user_id = ?").get(org, users.member);
  check('journal de productivité : 4 déplacements, 43 unités, au nom du magasinier', Number(r.n) === 4 && Number(r.u) === 43, r);
  r = await mgr('GET', `${WM}/slotting/analysis`);
  r = await dbx.prepare("SELECT COUNT(*) AS n FROM wms_moves WHERE org_id = ? AND kind = 'slotting'").get(org);
  check('mouvements notés « slotting » dans le journal', Number(r.n) === 4, r);

  // ---------- Opérations notées (qui, quand) ----------
  r = await mgr('POST', `${WM}/picks`, { lines: [{ itemId: X, quantity: 2 }] });
  const pickId = r.json.id;
  r = await mem('GET', `${WM}/picks/${pickId}`);
  r = await mem('POST', `${WM}/picks/${pickId}/lines/${r.json.pick.lines[0].id}/confirm`, {});
  check('prélèvement d\'une ligne', r.status === 200, r.json);
  r = await dbx.prepare('SELECT pl.picked_by, pl.picked_at, p.started_at FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id WHERE pl.pick_id = ?').get(pickId);
  check('ligne de préparation : qui et quand', Number(r.picked_by) === users.member && r.picked_at && r.started_at, r);
  await put(Z, 7, 'RECEP');
  r = await mem('GET', `${WM}/dashboard/live`);
  check('tableau de bord : réception à ranger (1 ligne, 7 unités)', r.status === 200 && r.json.putaway.lines === 1 && r.json.putaway.units === 7, r.json.putaway);
  r = await mem('POST', `${WM}/putaway`, { itemId: Z, fromLocationId: recep, toLocationId: L['B-02-01'].id });
  check('rangement', r.status === 200, r.json);
  r = await dbx.prepare("SELECT task, lines, units FROM wms_labor WHERE org_id = ? AND user_id = ? AND task IN ('pick','putaway') ORDER BY id").all(org, users.member);
  check('journal : prélèvement (1 ligne, 2 unités) et rangement (1 ligne, 7 unités)', r.length === 2 && r[0].task === 'pick' && Number(r[0].units) === 2 && r[1].task === 'putaway' && Number(r[1].units) === 7, r);
  r = await owner('POST', `${O}/stock/counts`, {});
  const countId = r.json.id;
  r = await mem('PUT', `${O}/stock/counts/${countId}/lines`, { lines: [{ itemId: X, counted: 20 }, { itemId: Y, counted: 10 }, { itemId: Z, counted: '' }] });
  r = await dbx.prepare("SELECT lines FROM wms_labor WHERE org_id = ? AND task = 'count'").get(org);
  const cl = await dbx.prepare('SELECT counted_by, counted_at FROM stock_count_lines WHERE count_id = ? AND item_id = ?').get(countId, X);
  check('comptage : 2 lignes comptées notées, avec qui et quand', r && Number(r.lines) === 2 && Number(cl.counted_by) === users.member && cl.counted_at, [r, cl]);
  await owner('POST', `${O}/stock/counts/${countId}/reject`, { note: 'test' });
  await ok('après les opérations');

  // ---------- Productivité (durées calculées à la main) ----------
  await dbx.prepare('DELETE FROM wms_labor WHERE org_id = ?').run(org);
  const ev = (u, task, lines, units, iso) => dbx.prepare('INSERT INTO wms_labor (org_id, user_id, task, lines, units, at) VALUES (?, ?, ?, ?, ?, ?)').run(org, u, task, lines, units, iso);
  const D1 = '2025-06-10'; const D2 = '2025-06-11';
  // Paul, jour 1 : prélèvements 08:00 (1re opération : standard 60 s), 08:01 (60 s), 08:03 (120 s) ; rangements 09:00 (57 min > 10 min : standard 90 s), 09:01:30 (90 s).
  await ev(users.member, 'pick', 1, 5, `${D1}T08:00:00.000Z`); await ev(users.member, 'pick', 1, 3, `${D1}T08:01:00.000Z`); await ev(users.member, 'pick', 1, 2, `${D1}T08:03:00.000Z`);
  await ev(users.member, 'putaway', 1, 10, `${D1}T09:00:00.000Z`); await ev(users.member, 'putaway', 1, 4, `${D1}T09:01:30.000Z`);
  // Marc, jour 1 : prélèvement de 2 lignes à 10:00 (standard 2 × 60 = 120 s), 1 ligne à 10:01 (60 s).
  await ev(users.manager, 'pick', 2, 4, `${D1}T10:00:00.000Z`); await ev(users.manager, 'pick', 1, 1, `${D1}T10:01:00.000Z`);
  // Paul, jour 2 : comptage de 4 lignes à 08:00 (nouveau jour : 4 × 30 = 120 s), 2 lignes à 08:02 (120 s).
  await ev(users.member, 'count', 4, 0, `${D2}T08:00:00.000Z`); await ev(users.member, 'count', 2, 0, `${D2}T08:02:00.000Z`);
  r = await mem('GET', `${WM}/labor/summary?from=${D1}&to=${D2}`);
  check('synthèse : réservée aux responsables', r.status === 403, r.status);
  r = await mem('GET', `${WM}/labor/leaderboard?from=${D1}&to=${D2}`);
  check('classement : réservé aux responsables', r.status === 403, r.status);
  r = await mgr('GET', `${WM}/labor/summary?from=${D1}&to=${D2}`);
  const S = r.json;
  // Total : 14 lignes en 840 s ; standard gagné 720 s → 85,7 % ; 14 ÷ (840 / 3600) = 60 lignes / heure.
  check('synthèse : 14 lignes, 840 s, 60 lignes/h, performance 85,7 %', S.totals.lines === 14 && S.totals.seconds === 840 && S.totals.linesPerHour === 60 && S.totals.performance === 85.7 && S.totals.people === 2, S.totals);
  const BT = Object.fromEntries(S.byTask.map((x) => [x.task, x]));
  // Prélèvement : 6 lignes, 240 + 180 = 420 s, 70 s / ligne, standard 360 s → 85,7 % ; rangement 2 lignes 180 s → 100 % ; comptage 6 lignes 240 s, standard 180 s → 75 %.
  check('par tâche : temps par ligne et performance', BT.pick.lines === 6 && BT.pick.seconds === 420 && BT.pick.secondsPerLine === 70 && BT.pick.performance === 85.7 && BT.putaway.seconds === 180 && BT.putaway.performance === 100 && BT.count.seconds === 240 && BT.count.performance === 75 && BT.pick.standard === 60, S.byTask);
  const BP = Object.fromEntries(S.byPerson.map((x) => [x.userId, x]));
  // Paul : 11 lignes, 660 s, 24 unités, standard 540 s → 81,8 % ; jour 1 : 5 lignes en 420 s → 42,9 lignes/h, 205,7 unités/h, 85,7 %.
  const pd1 = BP[users.member].byDay.find((d) => d.day === D1);
  check('par personne : Paul 11 lignes, 81,8 % ; Marc 3 lignes, 100 %', BP[users.member].lines === 11 && BP[users.member].seconds === 660 && BP[users.member].performance === 81.8 && BP[users.member].days === 2 && BP[users.manager].lines === 3 && BP[users.manager].performance === 100 && BP[users.manager].linesPerHour === 60, S.byPerson);
  check('par personne et par jour : Paul le 10/06 → 42,9 lignes/h, 205,7 unités/h, 85,7 %', pd1.lines === 5 && pd1.seconds === 420 && pd1.linesPerHour === 42.9 && pd1.unitsPerHour === 205.7 && pd1.performance === 85.7, pd1);
  check('par jour', S.byDay.length === 2 && S.byDay[0].day === D1 && S.byDay[0].lines === 8 && S.byDay[1].lines === 6, S.byDay);
  r = await mgr('GET', `${WM}/labor/leaderboard?from=${D1}&to=${D2}`);
  check('classement : sous le minimum de 10 lignes, Marc n\'est pas classé', r.json.ranking.length === 1 && r.json.ranking[0].name === 'Paul' && r.json.hidden === 1 && r.json.minLines === 10, r.json);
  r = await mgr('GET', `${WM}/labor/leaderboard?from=${D1}&to=${D2}&minLines=1`);
  check('classement : Marc (100 %) devant Paul (81,8 %)', r.json.ranking.length === 2 && r.json.ranking[0].name === 'Marc' && r.json.ranking[1].performance === 81.8 && r.json.ranking[1].rank === 2, r.json.ranking);
  r = await mgr('GET', `${WM}/labor/leaderboard?from=${D1}&to=${D2}&minLines=1&anonymous=1`);
  check('classement anonyme : ni nom ni identifiant', r.json.ranking[0].name === '#1' && r.json.ranking.every((x) => x.userId === undefined && !/Marc|Paul/.test(x.name)), r.json.ranking);
  r = await mem('GET', `${WM}/labor/me?from=${D1}&to=${D2}`);
  check('mes chiffres : Paul ne voit que les siens', r.status === 200 && r.json.totals.lines === 11 && r.json.totals.people === 1 && r.json.byPerson === undefined, r.json.totals);
  r = await mem('GET', `${WM}/labor/me?from=${D1}&to=${D1}`);
  check('une journée : lignes par heure de la journée', r.json.byHour.length === 24 && r.json.byHour[8].lines === 3 && r.json.byHour[9].lines === 2, r.json.byHour && r.json.byHour.slice(8, 10));
  r = await mem('PUT', `${WM}/labor/standards`, { standards: { pick: 30 } });
  check('standards : réservés aux responsables', r.status === 403, r.status);
  r = await mgr('PUT', `${WM}/labor/standards`, { standards: { pick: 0 } });
  check('standard invalide refusé', r.status === 400, r.json);
  r = await mgr('PUT', `${WM}/labor/standards`, { standards: { pick: 30 } });
  check('standard du prélèvement : 30 s', r.status === 200 && r.json.standards.pick === 30 && r.json.standards.putaway === 90, r.json);
  r = await mem('GET', `${WM}/labor/me?from=${D1}&to=${D1}`);
  // Prélèvement : 30 (1re opération au nouveau standard) + 60 + 120 = 210 s ; rangement 180 s ; total 390 s ; gagné 3 × 30 + 2 × 90 = 270 s → 69,2 %.
  check('nouveau standard : 390 s, performance 69,2 %', r.json.totals.seconds === 390 && r.json.totals.performance === 69.2, r.json.totals);
  await mgr('PUT', `${WM}/labor/standards`, { standards: { pick: 60 }, idleMinutes: 60 });
  r = await mem('GET', `${WM}/labor/me?from=${D1}&to=${D1}`);
  // Seuil d'inactivité 60 min : la pause de 57 min compte (3420 s) → 60 + 60 + 120 + 3420 + 90 = 3750 s.
  check('seuil d\'inactivité à 60 min : la pause de 57 min est comptée', r.json.totals.seconds === 3750, r.json.totals);
  await mgr('PUT', `${WM}/labor/standards`, { idleMinutes: 10 });
  r = await mgr('GET', `${WM}/labor/summary?from=${D2}&to=${D1}`);
  check('période à l\'envers refusée', r.status === 400, r.json);
  r = await other('GET', `${ws(org2)}/stock/wms/labor/summary?from=${D1}&to=${D2}`);
  check('cloisonnement : rien dans une autre organisation', r.status === 200 && r.json.totals.lines === 0, r.json.totals);

  // ---------- Cour et quais ----------
  r = await mem('POST', `${WM}/yard/docks`, { code: 'Q1' });
  check('quais : un membre ne les crée pas', r.status === 403, r.status);
  r = await mgr('POST', `${WM}/yard/docks`, { code: 'Q2', direction: 'outbound', locationId: recep });
  check('quai d\'expédition rattaché à une réception : refusé', r.status === 400, r.json);
  r = await mgr('POST', `${WM}/yard/docks`, { code: 'q1', name: 'Porte 1', direction: 'inbound', locationId: recep });
  const q1 = r.json.id;
  check('quai Q1 (réception) créé', r.status === 201 && r.json.code === 'Q1', r.json);
  r = await mgr('POST', `${WM}/yard/docks`, { code: 'Q1' });
  check('code de quai en double refusé', r.status === 409, r.json);
  r = await mgr('POST', `${WM}/yard/docks`, { code: 'Q2', name: 'Porte 2', direction: 'outbound', locationId: quai });
  const q2 = r.json.id;
  r = await mem('GET', `${WM}/yard/docks`);
  check('liste des quais', r.json.docks.length === 2 && r.json.docks[0].location === 'RECEP' && r.json.docks[1].location === 'QUAI-EXP-1', r.json.docks);
  r = await owner('POST', `${O}/logistics/carriers`, { name: 'TransCam' });
  const carrier = r.json.id;
  r = await owner('POST', `${O}/stock/suppliers`, { name: 'Grossiste Douala' });
  const po = Number((await dbx.prepare("INSERT INTO pur_orders (org_id, number, supplier_id, status, order_date, created_at, updated_at) VALUES (?, 'BC-0001', ?, 'sent', '2025-06-01', ?, ?) RETURNING id").get(org, r.json.id, now, now)).id);
  r = await mgr('POST', `${WM}/shipments`, { customerName: 'Boutique Ali', plannedDate: '2025-06-09' });
  const ship = r.json.id;
  const T0 = (h) => `${D1}T${h}:00.000Z`;
  r = await mem('POST', `${WM}/yard/appointments`, { direction: 'inbound', slotStart: T0('08:00'), slotEnd: T0('09:00') });
  check('rendez-vous : un membre ne les planifie pas', r.status === 403, r.status);
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'inbound', dockId: q1, slotStart: T0('08:00'), slotEnd: T0('09:00'), carrierId: carrier, plate: 'lt 123 ab', driver: 'Jean', poId: po });
  check('rendez-vous RDV-0001 (réception, Q1, 8 h – 9 h, bon de commande)', r.status === 201 && r.json.code === 'RDV-0001', r.json);
  const a1 = r.json.id;
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'inbound', dockId: q1, slotStart: T0('08:30'), slotEnd: T0('09:30') });
  check('créneau qui chevauche sur le même quai : refusé', r.status === 409 && /RDV-0001/.test(r.json.error), r.json);
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'outbound', dockId: q1, slotStart: T0('10:00'), slotEnd: T0('11:00') });
  check('expédition sur un quai de réception : refusée', r.status === 400, r.json);
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'outbound', dockId: q2, slotStart: T0('10:00'), slotEnd: T0('09:00') });
  check('créneau à l\'envers refusé', r.status === 400, r.json);
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'outbound', poId: po, slotStart: T0('10:00'), slotEnd: T0('11:00') });
  check('bon de commande sur une expédition : refusé', r.status === 400, r.json);
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'outbound', dockId: q2, slotStart: T0('10:00'), slotEnd: T0('11:00'), carrierName: 'Moto Express', shipmentId: ship });
  const a2 = r.json.id;
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'inbound', dockId: q1, slotStart: T0('14:00'), slotEnd: T0('15:30') });
  const a3 = r.json.id;
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'inbound', dockId: q1, slotStart: T0('12:00'), slotEnd: T0('13:00') });
  const a6 = r.json.id;
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'outbound', dockId: q2, slotStart: T0('16:00'), slotEnd: T0('17:00') });
  const a7 = r.json.id;
  r = await mem('POST', `${WM}/yard/appointments/${a1}/dock`, {});
  check('mise à quai avant l\'arrivée : refusée', r.status === 400, r.json);
  r = await mem('POST', `${WM}/yard/appointments/${a1}/arrive`, { driver: 'Jean K.' });
  check('arrivée au portail (membre)', r.status === 200, r.json);
  r = await mem('POST', `${WM}/yard/appointments/${a1}/arrive`, {});
  check('double arrivée refusée', r.status === 400, r.json);
  r = await mem('POST', `${WM}/yard/appointments/${a1}/dock`, {});
  check('mise à quai (Q1)', r.status === 200 && r.json.dock === 'Q1', r.json);
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'inbound', dockId: q1, slotStart: '2025-06-11T08:00:00Z', slotEnd: '2025-06-11T09:00:00Z' });
  const a8 = r.json.id;
  await mem('POST', `${WM}/yard/appointments/${a8}/arrive`, {});
  r = await mem('POST', `${WM}/yard/appointments/${a8}/dock`, { dockId: q1 });
  check('quai occupé par un autre camion : refusé', r.status === 409 && /RDV-0001/.test(r.json.error), r.json);
  r = await mem('GET', `${WM}/yard/now`);
  check('à la cour maintenant : un camion à quai, un au portail', r.json.appointments.length === 2 && r.json.appointments.some((a) => a.status === 'docked' && a.plate === 'LT 123 AB' && a.driver === 'Jean K.'), r.json.appointments);
  r = await mgr('POST', `${WM}/yard/appointments/${a8}/cancel`, {});
  check('annulation d\'un camion au portail', r.status === 200, r.json);
  r = await mem('POST', `${WM}/yard/appointments/${a1}/depart`, {});
  check('départ', r.status === 200, r.json);
  await mem('POST', `${WM}/yard/appointments/${a2}/arrive`, {});
  r = await mem('POST', `${WM}/yard/appointments/${a2}/dock`, {});
  r = await dbx.prepare('SELECT dock_location_id, dock FROM wms_shipments WHERE id = ?').get(ship);
  check('mise à quai : l\'expédition rattachée prend le quai Q2 (QUAI-EXP-1)', Number(r.dock_location_id) === quai && r.dock === 'Q2', r);
  await mem('POST', `${WM}/yard/appointments/${a2}/depart`, {});
  r = await mem('POST', `${WM}/yard/appointments/${a3}/depart`, {});
  check('départ d\'un camion pas arrivé : refusé', r.status === 400, r.json);
  r = await mem('POST', `${WM}/yard/appointments/${a6}/cancel`, {});
  check('annulation : réservée aux responsables', r.status === 403, r.status);
  await mgr('POST', `${WM}/yard/appointments/${a6}/cancel`, { reason: 'Fournisseur en retard' });
  r = await mgr('POST', `${WM}/yard/appointments/${a7}/cancel`, { noShow: true });
  check('rendez-vous noté « pas venu »', r.status === 200, r.json);
  // Heures réelles (UTC) : RDV-0001 arrivé 08:10, à quai 08:25, parti 09:25 ; RDV-0002 arrivé 10:30, à quai 10:40, parti 11:40.
  await dbx.prepare('UPDATE wms_appointments SET arrived_at = ?, docked_at = ?, departed_at = ? WHERE id = ?').run(T0('08:10'), T0('08:25'), T0('09:25'), a1);
  await dbx.prepare('UPDATE wms_appointments SET arrived_at = ?, docked_at = ?, departed_at = ? WHERE id = ?').run(T0('10:30'), T0('10:40'), T0('11:40'), a2);
  r = await mem('GET', `${WM}/yard/kpis?from=${D1}&to=${D1}`);
  const K = r.json;
  // 4 rendez-vous (l'annulé ne compte pas) ; ponctualité 1 / 2 (08:10 ≤ 08:15, 10:30 > 10:15) ; attente (15 + 10) / 2 = 12,5 min, max 15 ;
  // séjour (75 + 70) / 2 = 72,5 min ; à quai 60 min ; occupation (60 + 60 + 90 prévus) / (2 quais × 12 h × 60) = 210 / 1440 = 14,6 %.
  check('indicateurs : 4 rendez-vous, 2 arrivés, 1 pas venu, 1 annulé', K.appointments === 4 && K.inbound === 2 && K.outbound === 2 && K.arrived === 2 && K.departed === 2 && K.noShows === 1 && K.cancelled === 1, K);
  check('ponctualité 50 %, attente moyenne 12,5 min (max 15), séjour 72,5 min, à quai 60 min', K.onTimeRate === 50 && K.avgWaitMinutes === 12.5 && K.maxWaitMinutes === 15 && K.avgDwellMinutes === 72.5 && K.avgDockMinutes === 60, K);
  check('occupation des quais : 14,6 % (Q1 20,8 %, Q2 8,3 %)', K.utilisation === 14.6 && K.perDock.find((d) => d.code === 'Q1').utilisation === 20.8 && K.perDock.find((d) => d.code === 'Q2').utilisation === 8.3 && K.perDock.find((d) => d.code === 'Q1').minutes === 150, K.perDock);
  await mgr('PUT', `${WM}/yard/config`, { hoursPerDay: 10 });
  r = await mem('GET', `${WM}/yard/kpis?from=${D1}&to=${D1}`);
  check('ouverture 10 h : occupation 210 / 1200 = 17,5 %', r.json.utilisation === 17.5, r.json.utilisation);
  await mgr('PUT', `${WM}/yard/config`, { hoursPerDay: 12 });
  r = await mgr('POST', `${WM}/yard/appointments`, { direction: 'outbound', slotStart: `${D1}T17:00:00+01:00`, slotEnd: `${D1}T18:00:00+01:00` });
  const a9 = r.json.id;
  r = await mem('GET', `${WM}/yard/calendar?date=${D1}`);
  const C = Object.fromEntries(r.json.docks.map((d) => [d.code, d]));
  check('calendrier par quai : Q1 (2), Q2 (2), 1 sans quai ; l\'annulé n\'y est pas', C.Q1.appointments.length === 2 && C.Q2.appointments.length === 2 && r.json.unassigned.length === 1 && r.json.unassigned[0].slotStart === `${D1}T16:00:00.000Z` && !C.Q1.appointments.some((a) => a.id === a6), [C.Q1.appointments.map((a) => a.code), r.json.unassigned]);
  const v1 = C.Q1.appointments.find((a) => a.id === a1);
  check('rendez-vous : attente 15 min, 60 min à quai, à l\'heure, bon de commande et fournisseur', v1.waitMinutes === 15 && v1.dockMinutes === 60 && v1.late === false && v1.poNumber === 'BC-0001' && v1.supplier === 'Grossiste Douala' && v1.carrier === 'TransCam', v1);
  check('rendez-vous en retard signalé', C.Q2.appointments.find((a) => a.id === a2).late === true && C.Q2.appointments.find((a) => a.id === a2).shipmentCode, C.Q2.appointments);
  r = await mgr('PUT', `${WM}/yard/appointments/${a9}`, { dockId: q2, slotStart: T0('10:30'), slotEnd: T0('11:30') });
  check('modification : créneau libre (le rendez-vous parti ne bloque plus le quai)', r.status === 200, r.json);
  r = await mgr('PUT', `${WM}/yard/appointments/${a3}`, { slotStart: T0('16:30'), slotEnd: T0('17:30'), dockId: q2 });
  check('modification : un quai d\'expédition pour une réception refusé', r.status === 400, r.json);
  r = await mem('GET', `${WM}/scan?code=RDV-0001`);
  check('scan : un rendez-vous se reconnaît', r.json.type === 'appointment' && r.json.id === a1, r.json);
  r = await other('GET', `${ws(org2)}/stock/wms/yard/appointments/${a1}`);
  check('cloisonnement : rendez-vous introuvable depuis une autre organisation', r.status === 404, r.status);
  r = await other('POST', `${ws(org2)}/stock/wms/yard/appointments`, { direction: 'inbound', dockId: q1, slotStart: T0('08:00'), slotEnd: T0('09:00') });
  check('cloisonnement : quai d\'une autre organisation introuvable', r.status === 404, r.json);

  // ---------- Tableau de bord ----------
  await mgr('POST', `${WM}/picks`, { lines: [{ itemId: Y, quantity: 3 }] });
  r = await mem('GET', `${WM}/dashboard/live`);
  const B = r.json;
  check('tableau de bord : 1 ligne à prélever (3 unités), aucune vague', B.picking.lines === 1 && B.picking.units === 3 && B.waves.inProgress === 0, [B.picking, B.waves]);
  check('tableau de bord : 1 expédition en retard, alerte', B.shipments.late === 1 && B.alerts.some((a) => a.kind === 'late_shipments' && a.n === 1), [B.shipments, B.alerts]);
  check('tableau de bord : plus rien à ranger, aucune tâche ouverte', B.putaway.lines === 0 && B.tasks.replenishment === 0 && B.tasks.slotting === 0, [B.putaway, B.tasks]);
  const zA = B.zones.find((z) => z.zoneId === za);
  // Zone A : A-01 (riz 20) et A-02 (huile 10), capacité 2 × 100 → 30 / 200 = 15 % ; 2 emplacements sur 2 occupés.
  check('remplissage de la zone A : 15 %, 100 % des emplacements occupés', zA && zA.fill === 15 && zA.used === 100 && zA.capacity === 200 && zA.filled === 30, zA);
  check('quais du jour : 2 quais, aucun rendez-vous', B.yard.utilisation === 0 && B.yard.perDock.length === 2, B.yard);
  check('productivité : cachée à un membre', B.productivity === null, B.productivity);
  r = await mgr('GET', `${WM}/dashboard/live`);
  check('productivité du jour (responsable) : aucune opération depuis la remise à zéro', r.json.productivity && r.json.productivity.lines === 0 && r.json.productivity.byHour.length === 24, r.json.productivity);
  r = await mem('POST', `${WM}/move`, { itemId: Z, fromLocationId: L['B-02-01'].id, toLocationId: L['C-02-01'].id, quantity: 2 });
  r = await mgr('GET', `${WM}/dashboard/live`);
  const hr = Number(new Date().toISOString().slice(11, 13));
  check('productivité du jour : le déplacement compte (1 ligne)', r.json.productivity.lines === 1 && r.json.productivity.byTask[0].task === 'move' && r.json.productivity.byHour[hr].lines >= 1, r.json.productivity);
  r = await other('GET', `${ws(org2)}/stock/wms/dashboard/live`);
  check('cloisonnement : tableau de bord vide dans une autre organisation', r.status === 200 && r.json.picking.lines === 0 && r.json.shipments.late === 0 && r.json.zones.every((z) => z.filled === 0), r.json.picking);
  await ok('à la fin');
});
