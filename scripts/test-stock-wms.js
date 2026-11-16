'use strict';
// Stock WMS (entrepôt) : emplacements, transferts, réservations, retours, coût d'arrivée, ABC, préparation, prévision, états.
// Lancez-le avec : node scripts/test-stock-wms.js
const fs = require('fs');
const path = require('path');
const { run } = require('./lib/wave2');

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (n) => iso(new Date(Date.now() + n * 86400000));
const near = (a, b, e = 0.001) => Math.abs(a - b) <= e;

run('Stock WMS : emplacements, transferts, réservations, retours…', async (t) => {
  const { check, owner, mgr, mem, other, org, org2, O, ws, dbx } = t;
  const S = `${O}/stock`; const W = `${S}/wms`; const W2 = `${ws(org2)}/stock/wms`;
  let r;

  // Cohérence : la somme des emplacements doit toujours égaler la quantité des articles (et rien de négatif).
  const coherent = async (label) => {
    const bad = await dbx.prepare(`SELECT i.id, i.name, i.quantity, COALESCE(SUM(v.quantity), 0) AS lv FROM stock_items i LEFT JOIN wms_levels v ON v.item_id = i.id GROUP BY i.id HAVING ABS(i.quantity - COALESCE(SUM(v.quantity), 0)) > 0.0005`).all();
    const neg = await dbx.prepare('SELECT COUNT(*) c FROM wms_levels WHERE quantity < 0').get();
    const negItems = await dbx.prepare('SELECT COUNT(*) c FROM stock_items WHERE quantity < 0').get();
    check(`cohérence (${label}) : somme des emplacements = quantité de chaque article, rien de négatif`, bad.length === 0 && neg.c === 0 && negItems.c === 0, bad);
  };
  const valueOf = async (orgId) => Number((await dbx.prepare("SELECT COALESCE(SUM(v.quantity * CASE WHEN i.avg_cost > 0 THEN i.avg_cost ELSE i.unit_cost END), 0) v FROM wms_levels v JOIN stock_items i ON i.id = v.item_id WHERE v.org_id = ?").get(orgId)).v);
  const itemsValue = async (orgId) => Number((await dbx.prepare('SELECT COALESCE(SUM(quantity * CASE WHEN avg_cost > 0 THEN avg_cost ELSE unit_cost END), 0) v FROM stock_items WHERE org_id = ?').get(orgId)).v);
  const newItem = async (name, extra = {}) => (await mgr('POST', `${S}/items`, { name, unit: 'pièce', ...extra })).json.id;
  const qtyOf = async (id) => (await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(id)).quantity;
  const levels = async (id) => (await mgr('GET', `${W}/items/${id}/levels`)).json;
  const locId = async (c) => (await mgr('GET', `${W}/locations/lookup?code=${c}`)).json.location.id;

  // =====================================================================================================
  // LOT 1 · EMPLACEMENTS
  // =====================================================================================================
  // --- Migration sans perte : on rejoue les instructions de données de la migration sur un état « ancien » (stock global sans emplacements).
  await dbx.exec('DELETE FROM wms_putaway_rules; DELETE FROM wms_moves; DELETE FROM wms_levels; DELETE FROM wms_locations; DELETE FROM wms_zones; DELETE FROM wms_warehouses;');
  const now = new Date().toISOString();
  const ins = async (o, n, q, c) => Number((await dbx.prepare('INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, unit_cost, created_at, avg_cost) VALUES (?, ?, ?, ?, 0, ?, ?, ?)').run(o, n, 'pièce', q, c, now, c)).lastInsertRowid);
  const leg1 = await ins(org, 'Ancien riz', 12, 300); const leg2 = await ins(org, 'Ancienne huile', 7.5, 1000); const leg3 = await ins(org, 'Ancien vide', 0, 50); const leg4 = await ins(org2, 'Article autre org', 3, 200);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  const mig = src.slice(src.indexOf('/* STOCK WMS · lot 1'));
  const sqls = [...mig.matchAll(/(INSERT INTO wms_(?:warehouses|locations|levels)[\s\S]*?;)/g)].map((m) => m[1]).filter((q) => /SELECT/.test(q));
  check('migration : 3 instructions de reprise des données trouvées', sqls.length === 3, sqls.length);
  for (const q of sqls) await dbx.exec(q);
  const legacy = await dbx.prepare('SELECT COUNT(*) c, COALESCE(SUM(quantity), 0) q FROM wms_levels').get();
  check('migration : quantités reprises sans perte (12 + 7,5 + 3), article à 0 sans ligne', legacy.c === 3 && near(legacy.q, 22.5), legacy);
  const defs = await dbx.prepare('SELECT org_id, COUNT(*) c FROM wms_locations WHERE is_default = 1 GROUP BY org_id').all();
  check('migration : un emplacement « Principal » par organisation', defs.length >= 2 && defs.every((d) => d.c === 1), defs);
  await coherent('après migration');
  r = await mgr('GET', `${W}/items/${leg1}/levels`);
  check('migration : l\'article ancien est entièrement dans « Principal »', r.status === 200 && r.json.levels.length === 1 && r.json.levels[0].code === 'PRINCIPAL' && r.json.levels[0].quantity === 12, r.json);

  // --- Droits et isolation
  r = await mem('POST', `${W}/warehouses`, { name: 'Dépôt Douala' });
  check('droits : un membre ne crée pas d\'entrepôt', r.status === 403, r.status);
  r = await mem('POST', `${W}/locations`, { code: 'A-01' });
  check('droits : un membre ne crée pas d\'emplacement', r.status === 403, r.status);
  r = await mem('GET', `${W}/overview`);
  check('lecture : un membre voit l\'entrepôt principal, sans valeur', r.status === 200 && r.json.warehouses.length === 1 && r.json.warehouses[0].isDefault && r.json.warehouses[0].value === undefined, r.json);
  r = await mgr('GET', `${W}/overview`);
  check('un responsable voit la valeur de l\'entrepôt (22,5 × coût)', r.status === 200 && r.json.warehouses[0].value === Math.round(12 * 300 + 7.5 * 1000), r.json.warehouses[0]);

  // --- Structure : entrepôts → zones → emplacements
  r = await mgr('POST', `${W}/warehouses`, { name: 'Dépôt Douala', code: 'dla', address: 'Bonabéri' });
  const whDla = r.json.id;
  check('entrepôt créé', r.status === 201 && whDla > 0, r.json);
  r = await mgr('POST', `${W}/warehouses`, { name: 'Autre', code: 'DLA' });
  check('code d\'entrepôt en double (casse ignorée) → 409', r.status === 409, r.status);
  r = await mgr('POST', `${W}/zones`, { warehouseId: whDla, name: 'Froid', code: 'FR', kind: 'storage' });
  const zFroid = r.json.id;
  r = await mgr('POST', `${W}/zones`, { warehouseId: whDla, name: 'Quarantaine', code: 'QR', kind: 'quarantine' });
  const zQuar = r.json.id;
  check('zones créées', zFroid > 0 && zQuar > 0, r.json);
  r = await mgr('POST', `${W}/zones`, { warehouseId: whDla, name: 'Doublon', code: 'fr' });
  check('code de zone en double → 409', r.status === 409, r.status);
  r = await mgr('POST', `${W}/zones`, { warehouseId: whDla, name: 'X', kind: 'inconnu' });
  check('type de zone inconnu → 400', r.status === 400, r.status);
  r = await mgr('POST', `${W}/locations/bulk`, { warehouseId: whDla, zoneId: zFroid, aisles: 'A,B', racks: 2, bins: 2, capacity: 100 });
  check('création en série : 2 allées × 2 rayons × 2 bacs = 8 emplacements', r.status === 201 && r.json.created === 8, r.json);
  r = await mgr('POST', `${W}/locations/bulk`, { warehouseId: whDla, zoneId: zFroid, aisles: 'A,B', racks: 2, bins: 2 });
  check('création en série rejouée : rien de dupliqué', r.json.created === 0 && r.json.skipped === 8, r.json);
  r = await mgr('POST', `${W}/locations/bulk`, { warehouseId: whDla, aisles: 'A,B,C,D,E', racks: 10, bins: 10 });
  check('création en série : plafond de 300 → 400', r.status === 400, r.status);
  r = await mgr('POST', `${W}/locations`, { warehouseId: whDla, zoneId: zQuar, code: 'QUA-1' });
  const locQua = r.json.id;
  r = await mgr('GET', `${W}/locations/${locQua}`);
  check('emplacement d\'une zone de quarantaine : type quarantaine, non disponible', r.json.location.kind === 'quarantine' && r.json.location.usable === false, r.json.location);
  r = await mgr('POST', `${W}/locations`, { warehouseId: whDla, code: 'a-01-01' });
  check('code d\'emplacement unique dans l\'organisation → 409', r.status === 409, r.status);
  r = await mgr('POST', `${W}/locations`, { warehouseId: whDla, code: 'a b/c', kind: 'transit' });
  check('type « En transit » non choisissable à la main → 400', r.status === 400, r.status);
  r = await mgr('POST', `${W}/locations`, { warehouseId: whDla, code: '***' });
  check('code invalide → 400', r.status === 400, r.status);
  r = await mgr('POST', `${W}/locations`, { warehouseId: whDla, zoneId: 99999, code: 'ZZ-1' });
  check('zone inconnue → 400', r.status === 400, r.status);
  const A0101 = await locId('A-01-01'); const A0102 = await locId('A-01-02'); const B0101 = await locId('B-01-01'); const PRINC = await locId('PRINCIPAL');
  check('codes générés « allée-rayon-bac » retrouvés par scan', A0101 > 0 && A0102 > 0 && B0101 > 0, [A0101, A0102, B0101]);

  // Isolation entre organisations
  r = await other('GET', `${W2}/locations`);
  const otherLocs = r.json.locations.map((l) => l.code);
  check('isolation : l\'autre organisation ne voit aucun emplacement de la première', r.status === 200 && !otherLocs.includes('A-01-01') && otherLocs.includes('PRINCIPAL'), otherLocs);
  r = await other('GET', `${W2}/locations/${A0101}`);
  check('isolation : un emplacement d\'une autre organisation → 404', r.status === 404, r.status);
  r = await other('GET', `${W2}/locations/lookup?code=A-01-01`);
  check('isolation : scan d\'un code d\'une autre organisation → 404', r.status === 404, r.status);
  r = await other('POST', `${W2}/move`, { itemId: leg4, fromLocationId: A0101, toLocationId: PRINC, quantity: 1 });
  check('isolation : déplacer avec un emplacement étranger → 404', r.status === 404, r.status);
  r = await owner('GET', `${W2}/locations`);
  check('isolation : le propriétaire de la première organisation n\'accède pas à la seconde', r.status === 404, r.status);

  // --- Entrées dans un emplacement précis, règles de sortie automatiques
  const riz = await newItem('Riz parfumé', { unit: 'sac', unitCost: 1000, minQuantity: 2 });
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 30, locationId: A0101, reason: 'Réception' });
  check('entrée dans A-01-01 (tout membre)', r.status === 200, r.json);
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 20, locationId: B0101 });
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 5 });
  let lv = await levels(riz);
  check('entrée sans emplacement → « Principal » ; quantité = somme des emplacements (55)', lv.quantity === 55 && lv.levels.length === 3 && lv.levels.find((l) => l.code === 'PRINCIPAL').quantity === 5, lv);
  await coherent('entrées');
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 1, locationId: 99999 });
  check('entrée dans un emplacement inconnu → 404', r.status === 404, r.status);
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'out', quantity: 100, locationId: A0101 });
  check('sortie plus grande que l\'emplacement → 400, rien de changé', r.status === 400 && (await qtyOf(riz)) === 55, r.json);
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'out', quantity: 45 });
  check('sortie sans emplacement : prélevée sur plusieurs emplacements (plus petits d\'abord)', r.status === 200 && (await qtyOf(riz)) === 10, r.json);
  lv = await levels(riz);
  check('après sortie auto : 10 restants, bacs vidés disparaissent', lv.quantity === 10 && lv.levels.every((l) => l.quantity > 0) && near(lv.levels.reduce((a, l) => a + l.quantity, 0), 10), lv);
  await coherent('sortie automatique');
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'out', quantity: 11 });
  check('stock insuffisant → 400 (jamais négatif)', r.status === 400 && (await qtyOf(riz)) === 10, r.json);
  r = await mem('GET', `${S}/items/${riz}/moves`);
  check('journal des mouvements conservé', r.status === 200 && r.json.moves.length >= 4, r.json.moves.length);

  // --- Déplacement interne
  r = await mem('POST', `${W}/move`, { itemId: riz, fromLocationId: A0101, toLocationId: A0102, quantity: 1 });
  const before = await levels(riz);
  const have = (c) => (before.levels.find((l) => l.code === c) || { quantity: 0 }).quantity;
  const from = before.levels[0];
  r = await mem('POST', `${W}/move`, { itemId: riz, fromLocationId: from.locationId, toLocationId: A0102, quantity: from.quantity + 1 });
  check('déplacement de plus que l\'emplacement ne contient → 400', r.status === 400, r.json);
  r = await mem('POST', `${W}/move`, { itemId: riz, fromLocationId: from.locationId, toLocationId: from.locationId, quantity: 1 });
  check('déplacement vers le même emplacement → 400', r.status === 400, r.status);
  r = await mem('POST', `${W}/move`, { itemId: riz, fromLocationId: from.locationId, toLocationId: A0102, quantity: 0 });
  check('déplacement de 0 → 400', r.status === 400, r.status);
  r = await mem('POST', `${W}/move`, { itemId: riz, fromLocationId: from.locationId, toLocationId: A0102, quantity: from.quantity });
  check('déplacement complet accepté', r.status === 200, r.json);
  lv = await levels(riz);
  check('déplacement : quantité totale inchangée (10), emplacement d\'arrivée alimenté', lv.quantity === 10 && lv.levels.find((l) => l.code === 'A-01-02').quantity >= from.quantity, lv);
  await coherent('déplacement interne');
  r = await mem('GET', `${W}/locations/lookup?code=a-01-02`);
  check('scan d\'emplacement : contenu listé (casse ignorée)', r.status === 200 && r.json.content.some((c) => c.itemId === riz), r.json);
  check('valeur de l\'emplacement cachée à un simple membre', r.json.content[0].value === undefined, r.json.content[0]);

  // Capacité
  r = await mgr('PUT', `${W}/locations/${A0102}`, { capacity: 3 });
  check('capacité inférieure au contenu → 409', r.status === 409, r.json);
  const small = (await mgr('POST', `${W}/locations`, { warehouseId: whDla, code: 'PETIT', capacity: 2 })).json.id;
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 3, locationId: small });
  check('emplacement plein (capacité 2, entrée de 3) → 400', r.status === 400 && /plein/.test(r.json.error), r.json);
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 2, locationId: small });
  check('entrée de 2 dans la capacité de 2 → ok', r.status === 200, r.json);
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 1, locationId: small });
  check('emplacement plein → 400', r.status === 400, r.status);

  // Désactivation / suppression
  r = await mgr('PUT', `${W}/locations/${small}`, { active: false });
  check('désactiver un emplacement qui contient du stock → 409', r.status === 409, r.status);
  r = await mgr('DELETE', `${W}/locations/${small}`);
  check('supprimer un emplacement qui contient du stock → 409', r.status === 409, r.status);
  r = await mgr('DELETE', `${W}/locations/${PRINC}`);
  check('l\'emplacement par défaut ne se supprime pas', r.status === 400, r.status);
  r = await mgr('DELETE', `${W}/warehouses/${whDla}`);
  check('entrepôt qui contient du stock : suppression refusée', r.status === 409, r.status);
  const lonely = (await mgr('POST', `${W}/locations`, { warehouseId: whDla, code: 'SEUL-1' })).json.id;
  r = await mgr('DELETE', `${W}/locations/${lonely}`);
  check('emplacement vide supprimé', r.status === 200, r.status);
  r = await mem('DELETE', `${W}/locations/${lonely}`);
  check('droits : un membre ne supprime rien', r.status === 403 || r.status === 404, r.status);

  // Entrée refusée dans un emplacement désactivé
  const off = (await mgr('POST', `${W}/locations`, { warehouseId: whDla, code: 'OFF-1' })).json.id;
  await mgr('PUT', `${W}/locations/${off}`, { active: false });
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 1, locationId: off });
  check('emplacement désactivé : entrée refusée', r.status === 400, r.json);

  // --- Règles de rangement
  const vis = await newItem('Vis', { unitCost: 10 });
  r = await mem('POST', `${W}/putaway-rules`, { itemId: vis, locationId: A0101 });
  check('droits : règle de rangement réservée aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${W}/putaway-rules`, { locationId: A0101 });
  check('règle sans article ni type de suivi → 400', r.status === 400, r.status);
  r = await mgr('POST', `${W}/putaway-rules`, { itemId: vis, locationId: small, priority: 1 });
  r = await mgr('POST', `${W}/putaway-rules`, { itemId: vis, locationId: A0102, priority: 2 });
  r = await mgr('GET', `${W}/putaway-suggest?itemId=${vis}&quantity=5`);
  check('rangement : « PETIT » est plein, la règle suivante (A-01-02) est proposée', r.status === 200 && r.json.parts.length === 1 && r.json.parts[0].code === 'A-01-02', r.json);
  r = await mem('POST', `${S}/items/${vis}/move`, { kind: 'in', quantity: 8 });
  lv = await levels(vis);
  check('entrée sans emplacement suit la règle de rangement', lv.levels.length === 1 && lv.levels[0].code === 'A-01-02' && lv.levels[0].quantity === 8, lv);
  await mgr('PUT', `${W}/locations/${small}`, { capacity: 6 });
  await mem('POST', `${S}/items/${riz}/move`, { kind: 'out', quantity: 2, locationId: small });
  r = await mgr('POST', `${W}/putaway-rules`, { itemId: vis, locationId: small, priority: 1 });
  r = await mem('POST', `${S}/items/${vis}/move`, { kind: 'in', quantity: 10 });
  lv = await levels(vis);
  check('rangement réparti : « PETIT » rempli (4 de place) puis le reste ailleurs', r.status === 200 && lv.quantity === 18 && lv.levels.find((l) => l.code === 'PETIT').quantity >= 1, lv);
  await coherent('rangement');

  // --- Valorisation et lien comptable
  const tv = await valueOf(org); const iv = await itemsValue(org);
  check('valeur par emplacements = valeur des articles (aucun écart)', Math.abs(tv - iv) < 0.01 && tv > 0, [tv, iv]);
  r = await owner('GET', `${O}/accounting/stock-valuation?date=${shift(0)}&nature=goods`);
  const accVal = r.json.totalValue;
  check('comptabilité : la valeur du stock (acc-stock) = somme de tous les emplacements', r.status === 200 && Math.abs(accVal - tv) <= r.json.items.length, [accVal, tv]);

  // --- Ancien stock modifié directement (script, import) : remis d'accord au prochain mouvement
  const drift = await ins(org, 'Écriture directe', 9, 100);
  r = await mgr('GET', `${W}/integrity`);
  check('contrôle de cohérence : l\'écart d\'une écriture directe est signalé', r.status === 200 && r.json.ok === false && r.json.mismatches.some((m) => m.itemId === drift), r.json);
  r = await mem('POST', `${S}/items/${drift}/move`, { kind: 'in', quantity: 1 });
  lv = await levels(drift);
  check('au prochain mouvement : emplacements remis d\'accord (10)', r.status === 200 && lv.quantity === 10 && near(lv.levels.reduce((a, l) => a + l.quantity, 0), 10), lv);
  r = await mgr('GET', `${W}/integrity`);
  check('contrôle de cohérence : tout est d\'accord', r.json.ok === true, r.json);

  // --- Concurrence : deux sorties simultanées de 8 sur un stock de 10 → une seule passe
  const conc = await newItem('Concurrence', { unitCost: 100 });
  await mem('POST', `${S}/items/${conc}/move`, { kind: 'in', quantity: 10, locationId: A0101 });
  const rs = await Promise.all([1, 2, 3, 4].map(() => mem('POST', `${S}/items/${conc}/move`, { kind: 'out', quantity: 4 })));
  const okc = rs.filter((x) => x.status === 200).length;
  check('concurrence : 4 sorties de 4 sur un stock de 10 → exactement 2 passent', okc === 2 && (await qtyOf(conc)) === 2, rs.map((x) => x.status));
  await coherent('concurrence');
  const rs2 = await Promise.all([1, 2, 3].map(() => mem('POST', `${W}/move`, { itemId: riz, fromLocationId: B0101, toLocationId: A0102, quantity: 1 })));
  await coherent('déplacements simultanés');

  // --- Antennes : un membre rattaché à une antenne ne voit que son entrepôt et le commun
  const mkBranch = async (n) => Number((await dbx.prepare('INSERT INTO branches (org_id, name, location, created_at) VALUES (?, ?, ?, ?)').run(org, n, '', new Date().toISOString())).lastInsertRowid);
  const brY = await mkBranch('Yaoundé'); const brB = await mkBranch('Bafoussam');
  r = await mgr('POST', `${W}/warehouses`, { name: 'Dépôt Yaoundé', code: 'YDE', branchId: brY });
  const whYde = r.json.id;
  r = await mgr('POST', `${W}/warehouses`, { name: 'Dépôt Bafoussam', code: 'BFM', branchId: brB });
  await mgr('POST', `${W}/locations`, { warehouseId: whYde, code: 'Y-1' });
  await dbx.prepare("UPDATE org_members SET branch_id = ? WHERE org_id = ? AND role = 'member'").run(brY, org);
  r = await mem('GET', `${W}/overview`);
  const names = r.json.warehouses.map((w) => w.code).sort();
  check('antenne : le membre voit son entrepôt et l\'entrepôt commun, pas celui d\'une autre antenne', JSON.stringify(names) === JSON.stringify(['DLA', 'PRINC', 'YDE']), names);
  r = await mem('GET', `${W}/locations/lookup?code=A-01-01`);
  check('antenne : l\'entrepôt Douala (commun) reste visible', r.status === 200, r.status);
  const bfmLoc = (await mgr('POST', `${W}/locations`, { warehouseId: (await dbx.prepare("SELECT id FROM wms_warehouses WHERE code = 'BFM' AND org_id = ?").get(org)).id, code: 'B-1' })).json.id;
  r = await mem('GET', `${W}/locations/${bfmLoc}`);
  check('antenne : un emplacement d\'une autre antenne → 404', r.status === 404, r.status);
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 1, locationId: bfmLoc });
  check('antenne : entrée dans l\'emplacement d\'une autre antenne refusée', r.status === 404, r.status);
  await dbx.prepare('UPDATE org_members SET branch_id = NULL WHERE org_id = ?').run(org);

  await coherent('fin du lot 1');
});
