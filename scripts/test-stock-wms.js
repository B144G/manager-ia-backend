'use strict';
// Stock WMS (entrepôt) : emplacements, transferts, réservations, retours, coût d'arrivée, ABC, préparation, prévision, états.
// FUSION A+B : test de B adapté à la couche d'entrepôt de A (voir docs/fusion/matrice/entrepot.md pour la liste des adaptations).
// Prévision, réapprovisionnement, états et résolution des codes de B sont sous /stock/wms/b/… (formes de B ; les chemins de A sont inchangés).
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
    const bad = await dbx.prepare(`SELECT i.id, i.name, i.quantity, COALESCE(SUM(v.quantity), 0) AS lv FROM stock_items i LEFT JOIN wms_stock v ON v.item_id = i.id GROUP BY i.id HAVING ABS(i.quantity - COALESCE(SUM(v.quantity), 0)) > 0.0005`).all();
    const neg = await dbx.prepare('SELECT COUNT(*) c FROM wms_stock WHERE quantity < 0').get();
    const negItems = await dbx.prepare('SELECT COUNT(*) c FROM stock_items WHERE quantity < 0').get();
    check(`cohérence (${label}) : somme des emplacements = quantité de chaque article, rien de négatif`, bad.length === 0 && neg.c === 0 && negItems.c === 0, bad);
  };
  const valueOf = async (orgId) => Number((await dbx.prepare("SELECT COALESCE(SUM(v.quantity * CASE WHEN i.avg_cost > 0 THEN i.avg_cost ELSE i.unit_cost END), 0) v FROM wms_stock v JOIN stock_items i ON i.id = v.item_id WHERE v.org_id = ?").get(orgId)).v);
  const itemsValue = async (orgId) => Number((await dbx.prepare('SELECT COALESCE(SUM(quantity * CASE WHEN avg_cost > 0 THEN avg_cost ELSE unit_cost END), 0) v FROM stock_items WHERE org_id = ?').get(orgId)).v);
  const newItem = async (name, extra = {}) => (await mgr('POST', `${S}/items`, { name, unit: 'pièce', ...extra })).json.id;
  const qtyOf = async (id) => (await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(id)).quantity;
  const levels = async (id) => (await mgr('GET', `${W}/items/${id}/levels`)).json;
  const locId = async (c) => (await mgr('GET', `${W}/locations/lookup?code=${c}`)).json.location.id;

  // =====================================================================================================
  // LOT 1 · EMPLACEMENTS
  // =====================================================================================================
  // --- Migration sans perte : on rejoue les instructions de données de la migration sur un état « ancien » (stock global sans emplacements).
  await dbx.exec('DELETE FROM wms_putaway_rules; DELETE FROM wms_moves; DELETE FROM wms_stock; DELETE FROM wms_locations; DELETE FROM wms_zones; DELETE FROM wms_warehouses;');
  const now = new Date().toISOString();
  const ins = async (o, n, q, c) => Number((await dbx.prepare('INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, unit_cost, created_at, avg_cost) VALUES (?, ?, ?, ?, 0, ?, ?, ?)').run(o, n, 'pièce', q, c, now, c)).lastInsertRowid);
  const leg1 = await ins(org, 'Ancien riz', 12, 300); const leg2 = await ins(org, 'Ancienne huile', 7.5, 1000); const leg3 = await ins(org, 'Ancien vide', 0, 50); const leg4 = await ins(org2, 'Article autre org', 3, 200);
  // Adaptation A : la reprise sans perte est faite par wms-core.ensure() au premier usage (réglages absents = organisation à initialiser).
  await dbx.exec('DELETE FROM wms_settings');
  check('reprise : première lecture de l\'entrepôt (organisation 1 puis 2)', (await mgr('GET', `${W}/overview`)).status === 200 && (await other('GET', `${W2}/overview`)).status === 200);
  const legacy = await dbx.prepare('SELECT COUNT(*) c, COALESCE(SUM(quantity), 0) q FROM wms_stock').get();
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
  check('zone inconnue → 404 (adaptation : A répond 404 « Zone introuvable »)', r.status === 404, r.status);
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
  check('antenne : le membre voit son entrepôt et l\'entrepôt commun, pas celui d\'une autre antenne', JSON.stringify(names) === JSON.stringify(['DLA', 'PRINCIPAL', 'YDE']), names);
  r = await mem('GET', `${W}/locations/lookup?code=A-01-01`);
  check('antenne : l\'entrepôt Douala (commun) reste visible', r.status === 200, r.status);
  const bfmLoc = (await mgr('POST', `${W}/locations`, { warehouseId: (await dbx.prepare("SELECT id FROM wms_warehouses WHERE code = 'BFM' AND org_id = ?").get(org)).id, code: 'B-1' })).json.id;
  r = await mem('GET', `${W}/locations/${bfmLoc}`);
  check('antenne : un emplacement d\'une autre antenne → 404', r.status === 404, r.status);
  r = await mem('POST', `${S}/items/${riz}/move`, { kind: 'in', quantity: 1, locationId: bfmLoc });
  check('antenne : entrée dans l\'emplacement d\'une autre antenne refusée', r.status === 404, r.status);
  await dbx.prepare('UPDATE org_members SET branch_id = NULL WHERE org_id = ?').run(org);

  await coherent('fin du lot 1');

  // =====================================================================================================
  // LOT 2 · TRANSFERTS
  // =====================================================================================================
  const T = `${W}/transfers`;
  const wh = async (code) => (await dbx.prepare('SELECT id FROM wms_warehouses WHERE org_id = ? AND code = ?').get(org, code)).id;
  const whPrinc = await wh('PRINCIPAL'); const whDlaId = await wh('DLA');
  r = await mgr('GET', `${W}/locations?warehouseId=${whDlaId}`);
  check('un nouvel entrepôt reçoit un emplacement d\'arrivée par défaut (adaptation : A crée « Principal » du dépôt, B créait une « Réception »)', r.json.locations.some((l) => l.isDefault && l.code === 'DLA-PRINC'), r.json.locations.map((l) => l.code));
  const sac = await newItem('Sac de ciment', { unit: 'sac', unitCost: 5000 });
  await mgr('POST', `${S}/items/${sac}/move`, { kind: 'in', quantity: 40, unitCost: 5000 });
  const huile = await newItem('Huile', { unit: 'litre', unitCost: 1000, tracking: 'lot' });
  await mgr('POST', `${S}/items/${huile}/move`, { kind: 'in', quantity: 20, lotNo: 'H1', expiry: shift(100), unitCost: 1000 });

  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, lines: [] });
  check('transfert sans ligne → 400', r.status === 400, r.status);
  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, lines: [{ itemId: sac, quantity: 0 }] });
  check('quantité nulle → 400', r.status === 400, r.status);
  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, lines: [{ itemId: sac, quantity: 1 }, { itemId: sac, quantity: 2 }] });
  check('article en double → 400', r.status === 400, r.status);
  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whPrinc, lines: [{ itemId: sac, quantity: 1 }] });
  check('même entrepôt sans emplacements précisés → 400', r.status === 400, r.status);
  r = await mem('POST', T, { fromWarehouseId: 99999, toWarehouseId: whDlaId, lines: [{ itemId: sac, quantity: 1 }] });
  check('entrepôt inconnu → 404', r.status === 404, r.status);
  r = await other('POST', `${W2}/transfers`, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, lines: [{ itemId: leg4, quantity: 1 }] });
  check('isolation : entrepôts d\'une autre organisation → 404', r.status === 404, r.status);

  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, note: 'Chantier Douala', lines: [{ itemId: sac, quantity: 25 }, { itemId: huile, quantity: 10 }] });
  const tr1 = r.json.id;
  check('demande de transfert créée par un simple membre', r.status === 201 && tr1 > 0, r.json);
  r = await mem('GET', `${T}/${tr1}`);
  check('numéro TR-AAAA-001, statut « demandé », journal', /^TR-0001$/.test(r.json.transfer.code) && r.json.transfer.status === 'requested' && r.json.transfer.journal.length === 1, r.json.transfer);
  const code1 = r.json.transfer.code;
  r = await mem('POST', `${T}/${tr1}/ship`, {});
  check('droits : un membre n\'expédie pas', r.status === 403, r.status);
  r = await other('GET', `${W2}/transfers/${tr1}`);
  check('isolation : transfert d\'une autre organisation → 404', r.status === 404, r.status);
  r = await mgr('POST', `${T}/${tr1}/receive`, {});
  check('réception d\'un transfert non expédié → 400 (adaptation : A répond 400)', r.status === 400, r.status);

  r = await mgr('POST', `${T}/${tr1}/ship`, { lines: [{ lineId: (await mgr('GET', `${T}/${tr1}`)).json.transfer.lines[0].id, quantity: 99 }] });
  check('expédier plus que demandé → 400', r.status === 400, r.json);
  const sacBefore = await qtyOf(sac); const valBefore = await itemsValue(org);
  r = await mgr('POST', `${T}/${tr1}/ship`, {});
  check('expédition par un responsable', r.status === 200, r.json);
  check('en transit : quantité totale inchangée (le stock reste compté), valeur inchangée', (await qtyOf(sac)) === sacBefore && Math.abs((await itemsValue(org)) - valBefore) < 0.01, [await qtyOf(sac), sacBefore]);
  lv = await levels(sac);
  check('en transit : 25 sacs dans « TRANSIT », 15 disponibles', lv.levels.find((l) => l.code === 'TRANSIT').quantity === 25 && lv.usable === 15, lv);
  await coherent('expédition');
  r = await mem('POST', `${S}/items/${sac}/move`, { kind: 'out', quantity: 16 });
  check('le stock en transit n\'est pas prélevable (16 > 15 disponibles) → 400', r.status === 400 && /transit/.test(r.json.error), r.json);
  r = await mem('POST', `${S}/items/${sac}/move`, { kind: 'out', quantity: 15, reason: 'Vente' });
  check('les 15 disponibles se prélèvent', r.status === 200, r.json);
  await mgr('POST', `${S}/items/${sac}/move`, { kind: 'in', quantity: 15, unitCost: 5000 });
  r = await mgr('POST', `${T}/${tr1}/ship`, {});
  check('double expédition → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  r = await mgr('POST', `${T}/${tr1}/receive`, {});
  check('droits : celui qui a expédié ne reçoit pas (même responsable)', r.status === 403, r.json);
  r = await mem('POST', `${T}/${tr1}/receive`, {});
  check('droits : un membre ne reçoit pas', r.status === 403, r.status);
  r = await owner('POST', `${T}/${tr1}/receive`, { lines: (await owner('GET', `${T}/${tr1}`)).json.transfer.lines.map((l) => ({ lineId: l.id, receivedQty: l.itemId === sac ? 23 : l.shippedQty })) });
  check('écart à la réception (23 reçus sur 25) sans motif → 400, rien de reçu', r.status === 400 && /motif/.test(r.json.error) && (await qtyOf(sac)) === 40, r.json);
  lv = await levels(sac);
  check('refus : les 25 sacs sont toujours en transit', lv.levels.find((l) => l.code === 'TRANSIT').quantity === 25, lv);
  const trLines = (await owner('GET', `${T}/${tr1}`)).json.transfer.lines;
  r = await owner('POST', `${T}/${tr1}/receive`, { lines: trLines.map((l) => ({ lineId: l.id, receivedQty: l.itemId === sac ? 30 : l.shippedQty })) });
  check('reçu plus qu\'expédié → 400', r.status === 400, r.json);
  const dlaRec = (await mgr('GET', `${W}/locations?warehouseId=${whDlaId}`)).json.locations.find((l) => l.isDefault).id; // adaptation : emplacement par défaut du dépôt (A)
  const valBeforeRecv = await itemsValue(org);
  r = await owner('POST', `${T}/${tr1}/receive`, { lines: trLines.map((l) => (l.itemId === sac ? { lineId: l.id, receivedQty: 23, reason: 'Sacs éventrés au transport', toLocationId: A0101 } : { lineId: l.id, receivedQty: l.shippedQty })) });
  check('réception avec écart motivé (2 sacs cassés)', r.status === 200 && r.json.gapQty === 2 && r.json.gapValue === 10000, r.json);
  check('quantité : 40 − 2 sacs perdus = 38, huile intacte (20)', (await qtyOf(sac)) === 38 && (await qtyOf(huile)) === 20, [await qtyOf(sac), await qtyOf(huile)]);
  lv = await levels(sac);
  check('stock arrivé : 23 sacs à A-01-01, plus rien en transit', lv.levels.find((l) => l.code === 'A-01-01').quantity >= 23 && !lv.levels.some((l) => l.code === 'TRANSIT'), lv);
  lv = await levels(huile);
  check('huile (par lot) : 10 reçus à l\'emplacement d\'arrivée par défaut (réception DLA)', lv.levels.some((l) => l.code === 'DLA-PRINC' && l.quantity === 10), lv);
  await coherent('réception avec écart');
  check('valorisation : la perte de 10 000 FCFA (2 × 5 000) est la seule baisse', Math.abs(valBeforeRecv - (await itemsValue(org)) - 10000) < 0.01, [valBeforeRecv, await itemsValue(org)]);
  r = await owner('GET', `${T}/${tr1}`);
  check('transfert : statut reçu, écart et motif conservés, journal complet (3 étapes)', r.json.transfer.status === 'received' && r.json.transfer.gapQty === 2 && r.json.transfer.gapValue === 10000 && r.json.transfer.lines.find((l) => l.itemId === sac).gapReason === 'Sacs éventrés au transport' && r.json.transfer.journal.map((e) => e.action).join() === 'requested,shipped,received', r.json.transfer);
  r = await mgr('POST', `${T}/${tr1}/receive`, {});
  check('double réception → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  r = await mem('GET', `${T}/${tr1}`);
  check('un membre ne voit pas la valeur de l\'écart', r.json.transfer.gapValue === undefined, r.json.transfer.gapValue);
  r = await owner('GET', `${O}/accounting/stock-valuation?date=${shift(0)}&nature=goods`);
  check('comptabilité : valeur du stock = somme des emplacements après transfert', Math.abs(r.json.totalValue - (await valueOf(org))) <= r.json.items.length, [r.json.totalValue, await valueOf(org)]);
  r = await mem('GET', `${S}/items/${sac}/moves`);
  check('journal des mouvements : la perte de transfert y figure', r.json.moves.some((m) => /écart/i.test(m.reason) && m.delta === -2), r.json.moves.slice(0, 4));

  // Annulation d'une demande, d'un transfert en transit
  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, lines: [{ itemId: sac, quantity: 5 }] });
  const tr2 = r.json.id;
  r = await mem('POST', `${T}/${tr2}/cancel`, { reason: 'Plus besoin' });
  check('l\'auteur annule sa demande', r.status === 200, r.json);
  r = await mgr('POST', `${T}/${tr2}/ship`, {});
  check('transfert annulé : plus expédiable → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, lines: [{ itemId: sac, quantity: 6 }] });
  const tr3 = r.json.id;
  r = await owner('POST', `${T}/${tr3}/ship`, {});
  const sacPrincBefore = (await levels(sac)).levels.filter((l) => l.warehouseId === whPrinc).reduce((a, l) => a + l.quantity, 0);
  r = await mgr('POST', `${T}/${tr3}/cancel`, {});
  check('annuler un transfert en transit exige un motif → 400', r.status === 400, r.status);
  r = await mem('POST', `${T}/${tr3}/cancel`, { reason: 'x' });
  check('un membre n\'annule pas un transfert en transit → 403', r.status === 403, r.status);
  r = await mgr('POST', `${T}/${tr3}/cancel`, { reason: 'Camion en panne' });
  lv = await levels(sac);
  check('annulation en transit : le stock retourne au départ, rien en transit', r.status === 200 && !lv.levels.some((l) => l.code === 'TRANSIT') && lv.quantity === 38, lv);
  await coherent('annulation en transit');

  // Disponibilité : transfert demandé pour plus que disponible
  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, lines: [{ itemId: vis, quantity: 500 }] });
  const tr4 = r.json.id;
  r = await mgr('POST', `${T}/${tr4}/ship`, {});
  check('expédier plus que le stock du départ → 400, rien ne bouge', r.status === 400 && (await qtyOf(vis)) === 18, r.json);
  // Entre deux emplacements d'un même entrepôt
  r = await mem('POST', T, { fromWarehouseId: whDlaId, toWarehouseId: whDlaId, lines: [{ itemId: sac, quantity: 3, fromLocationId: A0101, toLocationId: B0101 }] });
  const tr5 = r.json.id;
  check('transfert entre deux emplacements d\'un même entrepôt accepté', r.status === 201, r.json);
  await owner('POST', `${T}/${tr5}/ship`, {});
  r = await mgr('POST', `${T}/${tr5}/receive`, {});
  lv = await levels(sac);
  check('même entrepôt : 3 sacs passés de A-01-01 à B-01-01', r.status === 200 && lv.levels.find((l) => l.code === 'B-01-01').quantity >= 3, lv);
  // Concurrence : deux réceptions simultanées → une seule
  r = await mem('POST', T, { fromWarehouseId: whDlaId, toWarehouseId: whDlaId, lines: [{ itemId: sac, quantity: 2, fromLocationId: B0101, toLocationId: A0101 }] });
  const tr6 = r.json.id;
  await owner('POST', `${T}/${tr6}/ship`, {});
  const rr = await Promise.all([mgr('POST', `${T}/${tr6}/receive`, {}), mgr('POST', `${T}/${tr6}/receive`, {}), owner('POST', `${T}/${tr6}/receive`, {})]);
  check('concurrence : trois réceptions simultanées → une seule passe', rr.filter((x) => x.status === 200).length === 1, rr.map((x) => x.status));
  await coherent('concurrence des transferts');
  r = await mem('GET', `${T}?status=received`);
  check('liste filtrée par statut', r.status === 200 && r.json.transfers.every((x) => x.status === 'received') && r.json.transfers.length >= 2, r.json.transfers.length);
  r = await mgr('DELETE', `${W}/warehouses/${whDlaId}`);
  check('entrepôt qui a des transferts : suppression refusée (adaptation : A répond 400)', r.status === 400, r.status);

  // =====================================================================================================
  // LOT 3 · RÉSERVATIONS
  // =====================================================================================================
  const RS = `${W}/reservations`;
  const mkItem = async (name, qty, cost = 100) => { const id = await newItem(name, { unitCost: cost }); await mgr('POST', `${S}/items/${id}/move`, { kind: 'in', quantity: qty, unitCost: cost }); return id; };
  const avail = async (id) => (await mem('GET', `${W}/items/${id}/availability`)).json;
  const clou = await mkItem('Clou 70', 20);
  let a = await avail(clou);
  check('disponibilité de départ : 20 en stock, 0 réservé, 20 à promettre', a.quantity === 20 && a.usable === 20 && a.reserved === 0 && a.available === 20, a);
  r = await mem('POST', RS, { itemId: clou, quantity: 5 });
  check('demande interne sans motif → 400', r.status === 400, r.json);
  r = await mem('POST', RS, { itemId: clou, quantity: 5, label: 'Atelier menuiserie' });
  const rsv1 = r.json.id;
  check('un membre réserve pour une demande interne', r.status === 201 && rsv1 > 0, r.json);
  r = await mem('POST', RS, { itemId: clou, quantity: 1, label: 'x', kind: 'manual' });
  check('droits : réservation libre réservée aux responsables', r.status === 403, r.status);
  r = await mem('POST', RS, { itemId: clou, quantity: 16, label: 'Trop' });
  check('réserver plus que le disponible à promettre (15) → 400 (adaptation : A répond 400)', r.status === 400, r.json);
  a = await avail(clou);
  check('disponible à promettre = 20 − 5 = 15 ; la quantité en stock ne change pas', a.reserved === 5 && a.available === 15 && a.quantity === 20, a);
  r = await mem('GET', S);
  const cv = r.json.items.find((i) => i.id === clou);
  check('liste du stock : réservé et disponible visibles', cv.reserved === 5 && cv.available === 15 && cv.quantity === 20, cv);
  r = await mem('POST', `${S}/items/${clou}/move`, { kind: 'out', quantity: 16 });
  check('sortie libre qui mord sur le réservé (16 > 15) → 400 (adaptation : A répond 400, test-wms.js le prouve)', r.status === 400 && /réserv/.test(r.json.error) && (await qtyOf(clou)) === 20, r.json);
  r = await mem('POST', `${S}/items/${clou}/move`, { kind: 'out', quantity: 15, reason: 'Vente comptoir' });
  check('sortie libre des 15 disponibles acceptée', r.status === 200 && (await qtyOf(clou)) === 5, r.json);
  await mgr('POST', `${S}/items/${clou}/move`, { kind: 'in', quantity: 15, unitCost: 100 });
  const valRes = await itemsValue(org);
  r = await owner('GET', `${O}/accounting/stock-valuation?date=${shift(0)}&nature=goods`);
  check('une réservation ne change pas la valeur du stock (comptabilité)', Math.abs(r.json.totalValue - valRes) <= r.json.items.length && Math.abs(r.json.totalValue - (await valueOf(org))) <= r.json.items.length, [r.json.totalValue, valRes]);
  r = await mem('POST', `${RS}/${rsv1}/release`, {});
  check('l\'auteur libère sa demande interne', r.status === 200, r.json);
  r = await mem('POST', `${RS}/${rsv1}/release`, {});
  check('libérer deux fois → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  a = await avail(clou);
  check('libération : tout redevient disponible', a.reserved === 0 && a.available === 20, a);

  // Concurrence : deux réservations simultanées de 12 sur 20
  const rr3 = await Promise.all([mgr('POST', RS, { itemId: clou, quantity: 12, label: 'A', kind: 'manual' }), mgr('POST', RS, { itemId: clou, quantity: 12, label: 'B', kind: 'manual' }), owner('POST', RS, { itemId: clou, quantity: 12, label: 'C', kind: 'manual' })]);
  check('concurrence : trois réservations de 12 sur 20 → une seule passe', rr3.filter((x) => x.status === 201).length === 1, rr3.map((x) => x.status));
  a = await avail(clou);
  check('concurrence : jamais plus de réservé que de stock', a.reserved === 12 && a.available === 8, a);
  await owner('POST', `${RS}/${rr3.find((x) => x.status === 201).json.id}/release`, {});

  // Commande client : réservation depuis un document
  r = await owner('POST', `${O}/crm/customers`, { name: 'Client Ndi' });
  const cust = r.json.id;
  const planche = await mkItem('Planche', 10, 2000); const colle = await mkItem('Colle', 3, 1500);
  const mkOrder = async (lines, num) => Number((await dbx.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, issued, created_by, created_at, updated_at) VALUES (?, ?, 'order', ?, 'pending', ?, 1000, ?, 1, ?, ?)").run(org, cust, num, JSON.stringify(lines), shift(0), new Date().toISOString(), new Date().toISOString())).lastInsertRowid);
  const ord1 = await mkOrder([{ itemId: planche, label: 'Planche', quantity: 6, price: 2000 }, { itemId: colle, label: 'Colle', quantity: 4, price: 1500 }, { label: 'Livraison', quantity: 1, price: 500 }], 'C-T-0001');
  r = await mem('POST', `${RS}/from-document`, { documentId: ord1 });
  check('droits : réserver pour une commande = responsable', r.status === 403, r.status);
  r = await mgr('POST', `${RS}/from-document`, { documentId: ord1, partial: false });
  check('commande avec stock insuffisant (colle : 3 pour 4) → 409, rien de réservé', r.status === 409 && /Colle/.test(r.json.error) && (await avail(planche)).reserved === 0, r.json);
  r = await mgr('POST', `${RS}/from-document`, { documentId: ord1, partial: true });
  check('réservation partielle : planches 6, colle 3 ; manque signalé ; ligne sans article ignorée', r.status === 200 && r.json.reserved.length === 2 && r.json.short.length === 1 && r.json.short[0].name === 'Colle' && r.json.ignoredLines === 1, r.json);
  a = await avail(planche);
  check('planches : 6 réservées, 4 à promettre', a.reserved === 6 && a.available === 4, a);
  r = await mgr('POST', `${RS}/from-document`, { documentId: ord1, partial: true });
  a = await avail(planche);
  check('rejouer la réservation ne double rien (6 réservées)', r.status === 200 && a.reserved === 6, a);
  r = await mgr('GET', `${W}/documents/${ord1}/reservations`);
  check('réservations de la commande listées avec son numéro', r.json.reservations.length === 2 && r.json.reservations[0].documentNumber === 'C-T-0001', r.json);
  r = await other('POST', `${W2}/reservations/from-document`, { documentId: ord1 });
  check('isolation : document d\'une autre organisation → 404', r.status === 404, r.status);
  r = await other('GET', `${W2}/reservations`);
  check('isolation : l\'autre organisation ne voit aucune réservation', r.json.reservations.length === 0, r.json);
  r = await mgr('GET', `${RS}?status=active`);
  const rsPl = r.json.reservations.find((x) => x.itemId === planche);
  r = await other('POST', `${W2}/reservations/${rsPl.id}/release`, {});
  check('isolation : libérer la réservation d\'une autre organisation → 404', r.status === 404, r.status);

  // Livrer une partie de la réservation
  r = await mgr('POST', `${RS}/${rsPl.id}/fulfill`, { quantity: 2 });
  check('livraison partielle de la réservation (2 sur 6)', r.status === 200 && r.json.status === 'active' && r.json.remaining === 4 && r.json.quantity === 8, r.json);
  a = await avail(planche);
  check('après livraison : 8 en stock, 4 réservées, 4 à promettre', a.quantity === 8 && a.reserved === 4 && a.available === 4, a);
  r = await mgr('POST', `${RS}/${rsPl.id}/fulfill`, { quantity: 5 });
  check('livrer plus que le reste de la réservation → 400', r.status === 400, r.json);
  await coherent('livraison de réservation');

  // Livraison (module Logistique) liée à la commande : consomme la réservation de la commande
  r = await owner('POST', `${O}/logistics/deliveries`, { docId: ord1, customerName: 'Client Ndi', items: [{ itemId: planche, quantity: 4 }] });
  const dlv = r.json.id;
  check('livraison créée pour la commande', r.status === 201 && dlv > 0, r.json);
  r = await owner('PUT', `${O}/logistics/deliveries/${dlv}/status`, { status: 'shipped' });
  a = await avail(planche);
  check('expédition de la livraison : la réservation de la commande est consommée (4 sorties, plus rien de réservé sur les planches)', r.status === 200 && a.quantity === 4 && a.reserved === 0 && a.available === 4, [r.json, a]);
  r = await mgr('GET', `${RS}?itemId=${planche}`);
  check('réservation soldée : statut « livrée »', r.json.reservations[0].status === 'fulfilled', r.json.reservations[0]);

  // Annulation automatique
  r = await owner('PUT', `${O}/sales/orders/${ord1}/status`, { status: 'cancelled' });
  check('commande refusée dans le module ventes', r.status === 200, r.json);
  a = await avail(colle);
  check('annulation de la commande : réservation de colle libérée automatiquement', a.reserved === 0 && a.available === 3, a);
  r = await mgr('GET', `${RS}?itemId=${colle}`);
  check('la réservation libérée garde son motif', r.json.reservations[0].status === 'released' && /refusée|annulé/.test(r.json.reservations[0].closeReason), r.json.reservations[0]);
  r = await mgr('POST', `${RS}/from-document`, { documentId: ord1 });
  check('une commande annulée ne réserve plus → 400', r.status === 400, r.json);
  // Devis (CRM) refusé / supprimé
  r = await owner('POST', `${O}/crm/documents`, { kind: 'quote', customerId: cust, lines: [{ itemId: colle, label: 'Colle', quantity: 2, price: 1500 }] });
  const qt = r.json.id;
  r = await mgr('POST', `${RS}/from-document`, { documentId: qt });
  check('un devis réserve du stock', r.status === 200 && (await avail(colle)).reserved === 2, r.json);
  r = await owner('PUT', `${O}/crm/documents/${qt}`, { status: 'refused' });
  check('devis refusé : réservation libérée', (await avail(colle)).reserved === 0, await avail(colle));
  r = await owner('POST', `${O}/crm/documents`, { kind: 'quote', customerId: cust, lines: [{ itemId: colle, label: 'Colle', quantity: 1, price: 1500 }] });
  const qt2 = r.json.id;
  await mgr('POST', `${RS}/from-document`, { documentId: qt2 });
  r = await owner('DELETE', `${O}/crm/documents/${qt2}`);
  check('devis supprimé : réservation libérée', r.status === 200 && (await avail(colle)).reserved === 0, [r.status, await avail(colle)]);
  // Document supprimé directement en base (sans passer par l'écran) : nettoyé au prochain calcul
  const ord2 = await mkOrder([{ itemId: colle, label: 'Colle', quantity: 1, price: 1500 }], 'C-T-0002');
  await mgr('POST', `${RS}/from-document`, { documentId: ord2 });
  await dbx.prepare("UPDATE documents SET status = 'cancelled' WHERE id = ?").run(ord2);
  check('commande annulée en base : libération automatique au prochain calcul', (await avail(colle)).reserved === 0, await avail(colle));

  // Date limite
  r = await mgr('POST', RS, { itemId: colle, quantity: 1, label: 'Chantier', kind: 'manual', expiresAt: shift(5) });
  const rsExp = r.json.id;
  await dbx.prepare('UPDATE wms_reservations SET expires_at = ? WHERE id = ?').run(shift(-1), rsExp);
  check('réservation à date limite dépassée : libérée automatiquement', (await avail(colle)).reserved === 0, await avail(colle));

  // Transfert et déplacement ne mordent pas sur le réservé
  const tubes = await mkItem('Tube PVC', 10);
  r = await mgr('POST', RS, { itemId: tubes, quantity: 8, label: 'Plomberie', kind: 'manual' });
  const rsTube = r.json.id;
  r = await mem('POST', T, { fromWarehouseId: whPrinc, toWarehouseId: whDlaId, lines: [{ itemId: tubes, quantity: 5 }] });
  const trT = r.json.id;
  r = await mgr('POST', `${T}/${trT}/ship`, {});
  check('transfert : expédier du stock réservé (5 > 2 disponibles) → 409', r.status === 409 && (await qtyOf(tubes)) === 10, r.json);
  await mgr('POST', `${T}/${trT}/cancel`, {});
  const tubeLoc = (await levels(tubes)).levels[0];
  r = await mem('POST', `${W}/move`, { itemId: tubes, fromLocationId: tubeLoc.locationId, toLocationId: locQua, quantity: 5 });
  check('déplacement vers la quarantaine de stock réservé → 409', r.status === 409, r.json);
  r = await mem('POST', `${W}/move`, { itemId: tubes, fromLocationId: tubeLoc.locationId, toLocationId: locQua, quantity: 2 });
  check('déplacement vers la quarantaine du seul stock libre (2) → ok', r.status === 200, r.json);
  a = await avail(tubes);
  check('quarantaine : 8 utilisables, 8 réservés, 0 à promettre, 10 en stock', a.quantity === 10 && a.usable === 8 && a.reserved === 8 && a.available === 0, a);
  // Inventaire : une perte constatée reste possible, le manque est signalé
  r = await mgr('POST', `${S}/counts`, { note: 'Contrôle' });
  const cnt = r.json.id;
  r = await mgr('GET', `${S}/counts/${cnt}`);
  const cl = r.json.count.items.map((x) => ({ itemId: x.itemId, counted: x.itemId === tubes ? 4 : x.expected }));
  await mgr('PUT', `${S}/counts/${cnt}/lines`, { lines: cl });
  await mgr('POST', `${S}/counts/${cnt}/submit`, {});
  r = await owner('POST', `${S}/counts/${cnt}/validate`, {});
  check('inventaire : l\'écart de −6 est appliqué malgré la réservation', r.status === 200 && (await qtyOf(tubes)) === 4, r.json);
  a = await avail(tubes);
  check('inventaire : réservation en défaut signalée (short = 4), plus rien à promettre', a.available === 0 && a.short > 0, a);
  r = await mgr('GET', `${W}/availability?onlyReserved=1`);
  check('liste de disponibilité : articles en défaut de réservation comptés', r.json.shortItems >= 1 && r.json.items.some((x) => x.itemId === tubes), r.json.shortItems);
  await coherent('fin du lot 3');

  // =====================================================================================================
  // LOT 4 · RETOURS CLIENT / FOURNISSEUR / REBUT
  // =====================================================================================================
  const RT = `${W}/returns`;
  const avg = async (id) => Number((await dbx.prepare('SELECT avg_cost FROM stock_items WHERE id = ?').get(id)).avg_cost);
  const moveRows = async (kind, id) => await dbx.prepare('SELECT * FROM stock_moves WHERE ref_kind = ? AND ref_id = ? ORDER BY id').all(kind, id);
  const cable = await newItem('Câble 2,5', { unitCost: 200 });
  await mgr('POST', `${S}/items/${cable}/move`, { kind: 'in', quantity: 10, unitCost: 200 });
  await mgr('POST', `${S}/items/${cable}/move`, { kind: 'in', quantity: 10, unitCost: 300 });
  check('départ : coût moyen pondéré 250', (await avg(cable)) === 250 && (await qtyOf(cable)) === 20, await avg(cable));
  await mgr('POST', `${S}/items/${cable}/move`, { kind: 'out', quantity: 8, reason: 'Vente' });
  const ordR = await mkOrder([{ itemId: cable, label: 'Câble', quantity: 8, price: 500 }], 'C-T-0100');

  r = await mem('POST', RT, { kind: 'customer', documentId: ordR, lines: [{ itemId: cable, quantity: 9, disposition: 'restock' }] });
  check('retour client : plus que vendu (9 > 8) → 400', r.status === 400 && /vendu/.test(r.json.error), r.json);
  r = await mem('POST', RT, { kind: 'customer', documentId: ordR, lines: [{ itemId: cable, quantity: 3, disposition: 'restock', reasonCode: 'unwanted' }, { itemId: leg4, quantity: 1, disposition: 'restock' }] });
  check('article d\'une autre organisation → 404', r.status === 404, r.status);
  r = await mem('POST', RT, { kind: 'customer', documentId: ordR, lines: [{ itemId: cable, quantity: 3, disposition: 'restock', reasonCode: 'unwanted', locationId: A0102 }], validate: true });
  check('droits : un membre ne valide pas un retour', r.status === 403, r.status);
  r = await mem('POST', RT, { kind: 'customer', documentId: ordR, reason: 'Client revient', lines: [{ itemId: cable, quantity: 3, disposition: 'restock', reasonCode: 'unwanted', locationId: A0102 }] });
  const ret1 = r.json.id;
  check('un membre enregistre un brouillon de retour client', r.status === 201, r.json);
  check('brouillon : le stock n\'a pas bougé', (await qtyOf(cable)) === 12, await qtyOf(cable));
  r = await mem('GET', `${RT}/${ret1}`);
  check('numéro RET-AAAA-001, lié à la commande, valeurs cachées à un membre', /^RT-0\d{3}$/.test(r.json.return.code) && r.json.return.documentNumber === 'C-T-0100' && r.json.return.value === undefined, r.json.return);
  r = await mem('POST', `${RT}/${ret1}/validate`, {});
  check('droits : un membre ne valide pas (route de validation)', r.status === 403, r.status);
  r = await mgr('POST', `${RT}/${ret1}/validate`, {});
  check('un responsable valide : 3 câbles remis en stock', r.status === 200 && (await qtyOf(cable)) === 15, r.json);
  check('remise en stock au coût moyen du jour : le coût moyen reste 250', (await avg(cable)) === 250, await avg(cable));
  lv = await levels(cable);
  check('la remise en stock va à l\'emplacement choisi (A-01-02)', lv.levels.find((l) => l.code === 'A-01-02').quantity >= 3, lv);
  const mv1 = await moveRows('return', ret1);
  check('le mouvement de stock porte le retour (ref_kind = return) et l\'emplacement', mv1.length === 1 && mv1[0].delta === 3 && mv1[0].location_id === A0102, mv1);
  r = await mgr('POST', `${RT}/${ret1}/validate`, {});
  check('valider deux fois → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  r = await mgr('POST', `${RT}/${ret1}/cancel`, {});
  check('un retour validé ne s\'annule pas → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  r = await mem('POST', RT, { kind: 'customer', documentId: ordR, lines: [{ itemId: cable, quantity: 6, disposition: 'restock' }] });
  check('retours cumulés plus grands que la vente (3 + 6 > 8) → 400', r.status === 400, r.json);
  // quarantaine puis décision
  r = await mgr('POST', RT, { kind: 'customer', documentId: ordR, validate: true, lines: [{ itemId: cable, quantity: 5, disposition: 'quarantine', reasonCode: 'defective' }] });
  const ret2 = r.json.id;
  lv = await levels(cable);
  check('marchandise à contrôler : entrée à l\'emplacement de quarantaine, comptée mais non disponible', r.status === 201 && lv.levels.find((l) => l.code === 'RETOURS').quantity === 5 && lv.quantity === 20 && lv.usable === 15, lv);
  r = await mgr('GET', `${RT}?status=done`);
  check('liste : une décision en attente', r.json.toDecide === 1, r.json.toDecide);
  const l2 = (await mgr('GET', `${RT}/${ret2}`)).json.return.lines[0];
  r = await mem('POST', `${RT}/${ret2}/lines/${l2.id}/dispose`, { disposition: 'scrap' });
  check('droits : décision de contrôle réservée aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${RT}/${ret2}/lines/${l2.id}/dispose`, { disposition: 'restock', locationId: locQua });
  check('remise en stock vers un emplacement non disponible → 400', r.status === 400, r.json);
  r = await mgr('POST', `${RT}/${ret2}/lines/${l2.id}/dispose`, { disposition: 'restock', locationId: A0101 });
  lv = await levels(cable);
  check('contrôle OK : 5 câbles quittent la quarantaine vers A-01-01, quantité totale inchangée (20)', r.status === 200 && !lv.levels.some((l) => l.code === 'RETOURS') && lv.quantity === 20 && lv.usable === 20, lv);
  r = await mgr('POST', `${RT}/${ret2}/lines/${l2.id}/dispose`, { disposition: 'scrap' });
  check('une ligne déjà décidée → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  await coherent('retours client');
  // quarantaine puis rebut
  r = await mgr('POST', RT, { kind: 'customer', customerId: cust, validate: true, lines: [{ itemId: cable, quantity: 2, disposition: 'quarantine', reasonCode: 'damaged' }] });
  const ret3 = r.json.id;
  r = await mgr('GET', `${RT}/${ret3}`);
  const l3 = r.json.return.lines[0];
  const valBeforeScrap = await itemsValue(org);
  r = await mgr('POST', `${RT}/${ret3}/lines/${l3.id}/dispose`, { disposition: 'scrap', reason: 'Gaine brûlée' });
  check('contrôle KO : 2 câbles mis au rebut, sortis du stock (20)', r.status === 200 && (await qtyOf(cable)) === 20, r.json);
  check('valorisation : le rebut retire 2 × 250 = 500', Math.abs(valBeforeScrap - (await itemsValue(org)) - 500) < 0.01, [valBeforeScrap, await itemsValue(org)]);
  // rebut direct (retour client sans réintégration)
  r = await mgr('POST', RT, { kind: 'customer', customerId: cust, validate: true, lines: [{ itemId: cable, quantity: 1, disposition: 'scrap', reasonCode: 'damaged' }] });
  check('retour client mis au rebut : aucun mouvement de stock, perte tracée', r.status === 201 && (await qtyOf(cable)) === 20 && (await moveRows('return', r.json.id)).length === 0, r.json);
  r = await mgr('GET', `${RT}/${r.json.id}`);
  check('rebut client : valeur de la perte 250 conservée sur la ligne', r.json.return.value === 250 && r.json.return.lines[0].final === 'scrap', r.json.return);
  // lots
  const lait = await newItem('Lait', { tracking: 'lot', unitCost: 400 });
  await mgr('POST', `${S}/items/${lait}/move`, { kind: 'in', quantity: 10, lotNo: 'LT1', expiry: shift(30), unitCost: 400 });
  r = await mgr('POST', RT, { kind: 'customer', customerId: cust, validate: true, lines: [{ itemId: lait, quantity: 2, disposition: 'restock' }] });
  check('article suivi par lot : numéro de lot exigé → 400', r.status === 400 && /lot/.test(r.json.error), r.json);
  r = await mgr('POST', RT, { kind: 'customer', customerId: cust, validate: true, lines: [{ itemId: lait, quantity: 2, disposition: 'restock', lotNo: 'LT1', expiry: shift(30) }] });
  lv = (await mgr('GET', `${S}/items/${lait}/lots`)).json;
  check('retour par lot : remis dans le lot d\'origine (12 en LT1)', r.status === 201 && lv.lots.length === 1 && lv.lots[0].quantity === 12, lv.lots);
  // série
  const phone = await newItem('Téléphone', { tracking: 'serial', unitCost: 50000 });
  await mgr('POST', `${S}/items/${phone}/move`, { kind: 'in', quantity: 2, serials: 'IMEI1, IMEI2', unitCost: 50000 });
  await mgr('POST', `${S}/items/${phone}/move`, { kind: 'out', quantity: 1, serials: 'IMEI1' });
  r = await mgr('POST', RT, { kind: 'customer', customerId: cust, validate: true, lines: [{ itemId: phone, quantity: 1, disposition: 'restock' }] });
  check('article suivi par numéro de série : numéro exigé → 400', r.status === 400, r.json);
  r = await mgr('POST', RT, { kind: 'customer', customerId: cust, validate: true, lines: [{ itemId: phone, quantity: 1, disposition: 'restock', serials: 'IMEI1' }] });
  const sr = await dbx.prepare("SELECT status FROM stock_serials WHERE serial = 'IMEI1' AND org_id = ?").get(org);
  check('retour d\'un téléphone : IMEI1 de nouveau en stock', r.status === 201 && sr.status === 'in_stock' && (await qtyOf(phone)) === 2, [r.json, sr]);

  // retour fournisseur
  const fourn = Number((await dbx.prepare("INSERT INTO suppliers (org_id, name, created_at) VALUES (?, 'Fournisseur Eto', ?)").run(org, new Date().toISOString())).lastInsertRowid);
  r = await mem('POST', RT, { kind: 'supplier', lines: [{ itemId: cable, quantity: 2 }] });
  check('retour fournisseur sans fournisseur → accepté (adaptation : A le permet, test-wms.js le prouve)', r.status === 201, r.status);
  const nSup0 = (await dbx.prepare("SELECT COUNT(*) c FROM wms_returns WHERE kind = 'supplier'").get()).c;
  r = await mgr('POST', RT, { kind: 'supplier', supplierId: fourn, reason: 'Gaine fendue', validate: true, lines: [{ itemId: cable, quantity: 4, reasonCode: 'defective' }, { itemId: planche, quantity: 99 }] });
  check('retour fournisseur : une ligne impossible (stock insuffisant) annule tout', r.status === 400 && (await qtyOf(cable)) === 20, r.json);
  check('aucun document ni mouvement laissé par l\'échec', (await dbx.prepare("SELECT COUNT(*) c FROM wms_returns WHERE kind = 'supplier'").get()).c === nSup0, true);
  r = await mgr('POST', RT, { kind: 'supplier', supplierId: fourn, reason: 'Gaine fendue', validate: true, lines: [{ itemId: cable, quantity: 4, reasonCode: 'defective' }] });
  const ret4 = r.json.id;
  check('retour fournisseur validé : 4 câbles sortis (16)', r.status === 201 && (await qtyOf(cable)) === 16, r.json);
  r = await mgr('GET', `${RT}/${ret4}`);
  check('retour fournisseur : valeur 4 × 250 = 1 000, fournisseur lié', r.json.return.value === 1000 && r.json.return.supplier === 'Fournisseur Eto' && r.json.return.lines[0].reasonLabel === 'Défectueux', r.json.return);
  r = await mgr('POST', `${RT}/${ret4}/credit`, { amount: 1200 });
  r = await mgr('GET', `${RT}/${ret4}`);
  check('avoir fournisseur enregistré (1 200)', r.json.return.creditAmount === 1200 && !!r.json.return.creditedAt, r.json.return);
  r = await mgr('POST', `${RT}/${ret1}/credit`, { amount: 10 });
  check('avoir sur un retour client → 400', r.status === 400, r.status);
  r = await mem('GET', `${RT}/${ret4}`);
  check('un membre ne voit ni valeur ni avoir', r.json.return.value === undefined && r.json.return.creditAmount === undefined, r.json.return);
  // le stock réservé ne retourne pas au fournisseur
  r = await mgr('POST', RS, { itemId: cable, quantity: 12, label: 'Chantier', kind: 'manual' });
  r = await mgr('POST', RT, { kind: 'supplier', supplierId: fourn, validate: true, lines: [{ itemId: cable, quantity: 5 }] });
  check('retour fournisseur de stock réservé (5 > 4 libres) → 409', r.status === 409 && (await qtyOf(cable)) === 16, r.json);
  await mgr('POST', `${RS}/${(await mgr('GET', `${RS}?itemId=${cable}&status=active`)).json.reservations[0].id}/release`, {});

  // mise au rebut
  r = await mem('POST', RT, { kind: 'scrap', lines: [{ itemId: cable, quantity: 1, reasonCode: 'other' }] });
  check('rebut : motif « autre » sans précision → 400', r.status === 400, r.json);
  r = await mgr('POST', RT, { kind: 'scrap', reason: 'Inondation du dépôt', validate: true, lines: [{ itemId: cable, quantity: 3, reasonCode: 'damaged', locationId: A0101 }] });
  check('mise au rebut validée : 3 câbles sortis de A-01-01 (13)', r.status === 201 && (await qtyOf(cable)) === 13, r.json);
  r = await mgr('GET', `${RT}?kind=scrap`);
  check('liste filtrée par type', r.json.returns.length === 1 && r.json.returns[0].kind === 'scrap' && r.json.returns[0].value === 750, r.json.returns);
  r = await mem('POST', RT, { kind: 'scrap', reason: 'Test', lines: [{ itemId: cable, quantity: 2, reasonCode: 'lost' }] });
  const ret5 = r.json.id;
  r = await mem('POST', `${RT}/${ret5}/cancel`, {});
  check('l\'auteur annule son brouillon', r.status === 200 && (await qtyOf(cable)) === 13, r.json);
  r = await mgr('POST', `${RT}/${ret5}/validate`, {});
  check('un brouillon annulé ne se valide pas → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  r = await other('GET', `${W2}/returns/${ret1}`);
  check('isolation : retour d\'une autre organisation → 404', r.status === 404, r.status);
  r = await other('GET', `${W2}/returns`);
  check('isolation : liste vide pour l\'autre organisation', r.json.returns.length === 0, r.json);
  // Comptabilité : la valeur du stock = somme des emplacements après les retours
  r = await owner('GET', `${O}/accounting/stock-valuation?date=${shift(0)}&nature=goods`);
  check('comptabilité : valeur du stock = somme des emplacements après les retours', Math.abs(r.json.totalValue - (await valueOf(org))) <= r.json.items.length, [r.json.totalValue, await valueOf(org)]);
  await coherent('fin du lot 4');

  // =====================================================================================================
  // LOT 5 · RÉCEPTIONS ET COÛTS D'ARRIVÉE
  // =====================================================================================================
  const RC = `${W}/receipts`;
  const pP = await newItem('Pneu 15"', { unitCost: 100 });
  const pQ = await newItem('Chambre à air', { unitCost: 400 });
  await mgr('POST', `${S}/items/${pP}/move`, { kind: 'in', quantity: 10, unitCost: 100 });
  r = await mem('POST', RC, { lines: [{ itemId: pP, quantity: 1, unitCost: 100 }] });
  check('droits : un membre ne reçoit pas via ce module', r.status === 403, r.status);
  r = await mem('GET', RC);
  check('droits : un membre ne lit pas les coûts d\'achat', r.status === 403, r.status);
  r = await mgr('POST', `${RC}/preview`, { lines: [{ itemId: pP, quantity: 10, unitCost: 100, weight: 2 }, { itemId: pQ, quantity: 5, unitCost: 400, weight: 4 }], costs: [{ kind: 'transport', amount: 300, basis: 'value' }, { kind: 'customs', amount: 450, basis: 'quantity' }, { kind: 'handling', amount: 100, basis: 'weight' }] });
  check('simulation : transport 300 par valeur (100/200), douane 450 par quantité (300/150), manutention 100 par poids (50/50)', r.status === 200 && r.json.lines[0].landedTotal === 450 && r.json.lines[1].landedTotal === 400 && r.json.lines[0].landedUnit === 145 && r.json.lines[1].landedUnit === 480, r.json);
  check('simulation : rien enregistré', (await qtyOf(pQ)) === 0 && (await dbx.prepare('SELECT COUNT(*) c FROM wms_receipts').get()).c === 0, true);
  for (const [lab, body] of [['sans ligne', { lines: [] }], ['quantité nulle', { lines: [{ itemId: pP, quantity: 0, unitCost: 1 }] }], ['coût de montant nul', { lines: [{ itemId: pP, quantity: 1, unitCost: 1 }], costs: [{ kind: 'transport', amount: 0 }] }],
    ['type de coût inconnu', { lines: [{ itemId: pP, quantity: 1, unitCost: 1 }], costs: [{ kind: 'x', amount: 10 }] }], ['base inconnue', { lines: [{ itemId: pP, quantity: 1, unitCost: 1 }], costs: [{ kind: 'transport', amount: 10, basis: 'x' }] }],
    ['répartition au poids sans poids', { lines: [{ itemId: pP, quantity: 1, unitCost: 1 }], costs: [{ kind: 'transport', amount: 10, basis: 'weight' }] }], ['article d\'une autre organisation', { lines: [{ itemId: leg4, quantity: 1, unitCost: 1 }] }]]) {
    r = await mgr('POST', RC, body);
    check(`réception refusée : ${lab}`, r.status === 400 || r.status === 404, [r.status, r.json]);
  }
  check('aucun reste des réceptions refusées', (await dbx.prepare('SELECT COUNT(*) c FROM wms_receipts').get()).c === 0 && (await qtyOf(pP)) === 10, true);
  const valBeforeRec = await itemsValue(org);
  r = await mgr('POST', RC, { reference: 'BL-778', note: 'Conteneur Douala', locationId: A0101, lines: [{ itemId: pP, quantity: 10, unitCost: 100, weight: 2 }, { itemId: pQ, quantity: 5, unitCost: 400, weight: 4 }],
    costs: [{ kind: 'transport', label: 'Camion Douala-Yaoundé', amount: 300, basis: 'value' }, { kind: 'customs', amount: 450, basis: 'quantity' }, { kind: 'handling', amount: 100, basis: 'weight' }] });
  const rec1 = r.json.id;
  check('réception multi-lignes avec 3 coûts d\'arrivée', r.status === 201 && /^RC-\d{4}$/.test(r.json.code) && r.json.costs.length === 3, r.json);
  check('stock : 20 pneus, 5 chambres, à l\'emplacement choisi', (await qtyOf(pP)) === 20 && (await qtyOf(pQ)) === 5 && (await levels(pQ)).levels[0].code === 'A-01-01', await levels(pQ));
  check('coût moyen pneu : (10 × 100 + 10 × 100 + 450) / 20 = 122,5 ; chambre : (5 × 400 + 400) / 5 = 480', (await avg(pP)) === 122.5 && (await avg(pQ)) === 480, [await avg(pP), await avg(pQ)]);
  check('valeur du stock : +3 000 de marchandises +850 de coûts incorporés', Math.abs((await itemsValue(org)) - valBeforeRec - 3850) < 0.01, [valBeforeRec, await itemsValue(org)]);
  r = await mgr('GET', `${RC}/${rec1}`);
  check('détail : coût de revient unitaire 145 / 480, valeur totale 3 850 + 1 000 déjà en stock', r.json.receipt.lines[0].landedUnit === 145 && r.json.receipt.lines[1].landedUnit === 480 && r.json.receipt.baseValue === 3000 && r.json.receipt.landedCost === 850 && r.json.receipt.incorporated === 850 && r.json.receipt.expensed === 0, r.json.receipt);
  check('détail : chaque coût garde sa base et son libellé', r.json.receipt.costs.length === 3 && r.json.receipt.costs[0].label === 'Camion Douala-Yaoundé' && r.json.receipt.costs[1].basisLabel === 'Quantité', r.json.receipt.costs);
  const mvLanded = await moveRows('landed_cost', rec1);
  check('journal : une trace par article et par coût (valeur seulement, quantité 0)', mvLanded.length === 6 && mvLanded.every((m) => m.delta === 0), mvLanded.length);
  r = await owner('GET', `${O}/accounting/stock-valuation?date=${shift(0)}&nature=goods`);
  check('comptabilité : la valeur du stock (acc-stock) inclut les coûts incorporés = somme des emplacements', Math.abs(r.json.totalValue - (await valueOf(org))) <= r.json.items.length && Math.abs(r.json.totalValue - (await itemsValue(org))) <= r.json.items.length, [r.json.totalValue, await valueOf(org)]);
  // Répartition exacte, sans franc perdu
  const t3 = []; for (const n of ['Trois A', 'Trois B', 'Trois C']) t3.push(await newItem(n, { unitCost: 10 }));
  r = await mgr('POST', RC, { lines: t3.map((id) => ({ itemId: id, quantity: 1, unitCost: 10 })), costs: [{ kind: 'transport', amount: 100, basis: 'quantity' }] });
  r = await mgr('GET', `${RC}/${r.json.id}`);
  const parts3 = r.json.receipt.lines.map((l) => l.landedTotal).sort((x, y) => y - x);
  check('répartition de 100 sur 3 lignes égales : 34 + 33 + 33, somme exacte', JSON.stringify(parts3) === '[34,33,33]' && parts3.reduce((a, x) => a + x, 0) === 100, parts3);
  // Coût arrivé après coup, une partie du stock est déjà sortie
  await mgr('POST', `${S}/items/${pP}/move`, { kind: 'out', quantity: 15, reason: 'Vente' });
  const avgBefore = await avg(pP);
  r = await mgr('POST', `${RC}/${rec1}/costs`, { kind: 'transport', label: 'Facture du transitaire', amount: 200, basis: 'value' });
  check('coût ajouté plus tard : accepté', r.status === 201, r.json);
  r = await mgr('GET', `${RC}/${rec1}`);
  const lp = r.json.receipt.lines.find((l) => l.itemId === pP); const lq = r.json.receipt.lines.find((l) => l.itemId === pQ);
  check('après coup : pneus (5 restants sur 10 reçus) → moitié incorporée (34), moitié à passer en charge (33) ; chambres tout incorporé (133)', lp.incorporated === 450 + 34 && lp.expensed === 33 && lq.incorporated === 400 + 133 && lq.expensed === 0, [lp, lq]);
  check('coût moyen des pneus : (5 × 122,5 + 34) / 5 = 129,3', Math.abs((await avg(pP)) - 129.3) < 0.011 && avgBefore === 122.5, [await avg(pP), avgBefore]);
  check('le total incorporé + à passer en charge = le coût (200)', r.json.receipt.costs[3].incorporated + r.json.receipt.costs[3].expensed === 200 && r.json.receipt.costs[3].amount === 200, r.json.receipt.costs[3]);
  // Concurrence : deux coûts simultanés sur une réception dont tout le stock est présent
  const solo = await newItem('Palette', { unitCost: 1000 });
  r = await mgr('POST', RC, { lines: [{ itemId: solo, quantity: 4, unitCost: 1000 }] });
  const recS = r.json.id;
  const cc = await Promise.all([1, 2, 3].map(() => mgr('POST', `${RC}/${recS}/costs`, { kind: 'handling', amount: 100, basis: 'quantity' })));
  check('concurrence : trois coûts de 100 simultanés tous appliqués, coût moyen 1 000 + 300/4 = 1 075', cc.every((x) => x.status === 201) && (await avg(solo)) === 1075, [cc.map((x) => x.status), await avg(solo)]);
  await coherent('coûts d\'arrivée');
  // La valorisation existante n'est pas cassée : une réception sans coût = ancien comportement
  const plain = await newItem('Simple', { unitCost: 50 });
  await mgr('POST', `${S}/items/${plain}/move`, { kind: 'in', quantity: 10, unitCost: 50 });
  r = await mgr('POST', RC, { lines: [{ itemId: plain, quantity: 10, unitCost: 80 }] });
  check('réception sans coût : CUMP classique (10 × 50 + 10 × 80) / 20 = 65', r.status === 201 && (await avg(plain)) === 65, await avg(plain));
  // Rattacher des coûts à des réceptions d'une commande d'achat (module existant)
  const supp = fourn;
  r = await mgr('POST', `${S}/orders`, { orders: [{ itemId: plain, quantity: 6, supplierId: supp, unitPrice: 100 }] });
  const po = (await dbx.prepare('SELECT id FROM purchase_orders WHERE org_id = ? ORDER BY id DESC LIMIT 1').get(org)).id;
  r = await owner('PUT', `${S}/orders/${po}/status`, { status: 'ordered' });
  r = await mgr('POST', `${S}/orders/${po}/receive`, { quantity: 6, locationId: B0101 });
  check('commande d\'achat reçue dans un emplacement choisi (point d\'accroche)', r.status === 200 && (await levels(plain)).levels.some((l) => l.code === 'B-01-01' && l.quantity >= 6), await levels(plain));
  const prId = (await dbx.prepare('SELECT id FROM purchase_receipts WHERE order_id = ?').get(po)).id;
  r = await mgr('GET', `${RC}/purchase-candidates`);
  check('réceptions d\'achat proposées pour y rattacher des frais', r.status === 200 && r.json.receipts.some((x) => x.id === prId && x.item === 'Simple' && x.supplier === 'Fournisseur Eto'), r.json);
  const avgPlain = await avg(plain);
  r = await mgr('POST', `${RC}/from-purchase`, { purchaseReceiptId: prId, costs: [{ kind: 'customs', label: 'Dédouanement', amount: 120, basis: 'quantity' }] });
  check('coût d\'arrivée sur une réception d\'achat : dossier créé, 120 incorporés au coût moyen', r.status === 201 && (await avg(plain)) > avgPlain, [r.json, await avg(plain), avgPlain]);
  const exp = Math.round(((26 * avgPlain) + 120) / 26 * 100) / 100;
  check('coût moyen : (26 × ancien + 120) / 26', Math.abs((await avg(plain)) - exp) < 0.011, [await avg(plain), exp]);
  r = await mgr('GET', `${RC}/purchase-candidates`);
  check('une réception d\'achat déjà rattachée n\'est plus proposée', !r.json.receipts.some((x) => x.id === prId), r.json);
  r = await mgr('POST', `${RC}/from-purchase`, { purchaseReceiptId: prId, costs: [] });
  check('même réception d\'achat rattachée deux fois → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  r = await mgr('POST', `${RC}/from-purchase`, { purchaseReceiptId: 99999 });
  check('réception d\'achat inconnue → 404', r.status === 404, r.status);
  r = await other('GET', `${W2}/receipts/${rec1}`);
  check('isolation : réception d\'une autre organisation → 404', r.status === 404, r.status);
  r = await other('POST', `${W2}/receipts/${rec1}/costs`, { kind: 'transport', amount: 10 });
  check('isolation : coût sur la réception d\'une autre organisation → 404', r.status === 404, r.status);
  await coherent('fin du lot 5');

  // =====================================================================================================
  // LOT 6 · CLASSEMENT ABC ET INVENTAIRES TOURNANTS
  // =====================================================================================================
  // On repart d'une organisation « neuve » côté mouvements : on isole l'analyse sur des articles dédiés en passant par la 2e organisation.
  const A2 = `${W2}`; const S2 = `${ws(org2)}/stock`;
  const o2 = (m, u, b) => other(m, u, b);
  const mk2 = async (name, qty, cost) => { const id = (await o2('POST', `${S2}/items`, { name, unitCost: cost })).json.id; await o2('POST', `${S2}/items/${id}/move`, { kind: 'in', quantity: qty, unitCost: cost }); return id; };
  const i1 = await mk2('Produit vedette', 1000, 100); const i2 = await mk2('Produit courant', 1000, 50); const i3 = await mk2('Produit moyen', 1000, 20); const i4 = await mk2('Produit lent', 1000, 10); const i5 = await mk2('Produit rare', 1000, 4); const i6 = await mk2('Produit dormant', 10, 1000);
  for (const [id, q] of [[i1, 70], [i2, 30], [i3, 40], [i4, 50], [i5, 50]]) await o2('POST', `${S2}/items/${id}/move`, { kind: 'out', quantity: q, reason: 'Vente' });
  // consommation : i1 7 000, i2 1 500, i3 800, i4 500, i5 200 (total 10 000)
  r = await other('GET', `${A2}/abc`);
  check('droits : le propriétaire de l\'autre organisation voit le classement', r.status === 200, r.status);
  const abc = Object.fromEntries(r.json.items.map((x) => [x.name, x]));
  check('ABC : total de consommation 10 000, partage 70 / 15 / 8 / 5 / 2 %', r.json.totalConsumption === 10000 && abc['Produit vedette'].share === 70 && abc['Produit courant'].share === 15 && abc['Produit rare'].share === 2, r.json.items.map((x) => [x.name, x.share]));
  check('ABC : vedette et courant = A (jusqu\'à 80 %), moyen et lent = B (jusqu\'à 95 %), rare = C', abc['Produit vedette'].class === 'A' && abc['Produit courant'].class === 'A' && abc['Produit moyen'].class === 'B' && abc['Produit lent'].class === 'B' && abc['Produit rare'].class === 'C', r.json.items.map((x) => [x.name, x.class]));
  check('ABC : article sans sortie → C, signalé sans mouvement', abc['Produit dormant'].class === 'C' && abc['Produit dormant'].noMovement === true && abc['Produit dormant'].stockValue === 10000, abc['Produit dormant']);
  check('ABC : cumul croissant jusqu\'à 100 %, rangs 1 à 6', abc['Produit vedette'].rank === 1 && abc['Produit rare'].cumShare === 100, [abc['Produit vedette'].rank, abc['Produit rare'].cumShare]);
  check('ABC : résumé par classe (A : 2 articles, 85 % de la consommation)', r.json.classes[0].class === 'A' && r.json.classes[0].items === 2 && r.json.classes[0].share === 85 && r.json.classes.reduce((a, c) => a + c.items, 0) === 7, r.json.classes);
  r = await mem('GET', `${W}/abc`);
  check('droits : un membre ne voit pas le classement', r.status === 403, r.status);
  r = await mgr('GET', `${W}/abc`);
  check('isolation : le classement de la 1re organisation ne contient pas les articles de la 2e', r.status === 200 && !r.json.items.some((x) => x.name === 'Produit vedette'), r.status);
  // Les écarts d'inventaire, pertes de transfert, retours ne sont pas de la consommation
  await dbx.prepare("INSERT INTO stock_moves (org_id, item_id, delta, reason, created_at, ref_kind) VALUES (?, ?, -500, 'Inventaire test', ?, 'count')").run(org2, i6, new Date().toISOString());
  await dbx.prepare("INSERT INTO stock_moves (org_id, item_id, delta, reason, created_at, ref_kind) VALUES (?, ?, -300, 'Ancienne vente', ?, '')").run(org2, i6, new Date(Date.now() - 400 * 86400000).toISOString());
  r = await other('GET', `${A2}/abc`);
  check('ABC : ni les écarts d\'inventaire ni les sorties plus vieilles que la période ne comptent', r.json.items.find((x) => x.itemId === i6).consumption === 0, r.json.items.find((x) => x.itemId === i6));
  r = await other('PUT', `${A2}/settings`, { abcA: 90, abcB: 99, abcDays: 100 });
  check('seuils réglables', r.status === 200 && r.json.settings.abcA === 90, r.json);
  r = await other('GET', `${A2}/abc`);
  check('seuils 90 / 99 : le produit moyen passe en A', r.json.items.find((x) => x.itemId === i3).class === 'A', r.json.items.map((x) => [x.name, x.class]));
  r = await other('PUT', `${A2}/settings`, { abcA: 95, abcB: 90 });
  check('seuils incohérents (A ≥ B) → 400', r.status === 400, r.status);
  r = await other('PUT', `${A2}/settings`, { abcA: 80, abcB: 95, abcDays: 365, cycleA: 30, cycleB: 90, cycleC: 180 });
  r = await mem('PUT', `${A2}/settings`, { abcA: 10 });
  check('droits : réglages réservés aux administrateurs (et isolation)', r.status === 403 || r.status === 404, r.status);
  r = await other('POST', `${A2}/abc/refresh`, {});
  check('classement enregistré', r.status === 200 && r.json.items === 7 && r.json.counts.A === 2 && r.json.counts.B === 2 && r.json.counts.C === 3, r.json);

  // Plan tournant
  r = await other('GET', `${A2}/cycle-counts/plan`);
  check('plan : tout est à compter au départ (jamais compté), fréquences 30 / 90 / 180', r.status === 200 && r.json.due === 7 && r.json.classes[0].everyDays === 30 && r.json.classes[2].everyDays === 180, r.json.classes);
  r = await other('POST', `${A2}/cycle-counts`, { classes: ['Z'] });
  check('classe inconnue → 400', r.status === 400, r.status);
  r = await other('POST', `${A2}/cycle-counts`, { classes: ['A'] });
  const cyc = r.json.id;
  check('inventaire tournant de la classe A : 2 articles', r.status === 201 && r.json.items === 2, r.json);
  r = await other('POST', `${A2}/cycle-counts`, { classes: ['B'] });
  check('un autre inventaire en cours → 409', r.status === 409, r.status);
  r = await other('GET', `${S2}/counts/${cyc}`);
  check('c\'est un inventaire normal : lignes attendues, classe indiquée', r.status === 200 && r.json.count.lines === 2 && r.json.count.cycleClass === 'A', r.json.count);
  // comptage : vedette 1 unité de moins (−100), courant exact
  await other('PUT', `${S2}/counts/${cyc}/lines`, { lines: r.json.count.items.map((x) => ({ itemId: x.itemId, counted: x.itemId === i1 ? x.expected - 1 : x.expected })) });
  await other('POST', `${S2}/counts/${cyc}/submit`, {});
  r = await other('POST', `${S2}/counts/${cyc}/validate`, {});
  check('inventaire tournant validé (par le propriétaire, administrateur) : 1 ajustement, écart −100', r.status === 200 && r.json.adjusted === 1 && r.json.gapValue === -100, r.json);
  r = await other('GET', `${A2}/cycle-counts/plan`);
  check('plan : les articles A comptés ne sont plus à compter, B et C oui', r.json.classes[0].due === 0 && r.json.classes[1].due === 2 && r.json.classes[2].due === 3 && r.json.due === 5, r.json.classes);
  check('plan : prochaine échéance des A dans 30 jours', r.json.classes[0].nextDue === shift(30), r.json.classes[0]);
  r = await other('GET', `${A2}/cycle-counts/variance`);
  const va = r.json.classes[0];
  check('écarts valorisés, classe A : 2 lignes, 1 écart, précision 50 %, manque 100', r.status === 200 && va.lines === 2 && va.withGap === 1 && va.accuracy === 50 && va.shortValue === -100 && va.netValue === -100 && r.json.netValue === -100, r.json.classes);
  check('écarts valorisés : le détail cite l\'article, le comptage et le manque', r.json.gaps.length === 1 && r.json.gaps[0].name === 'Produit vedette' && r.json.gaps[0].gap === -1, r.json.gaps);
  r = await other('POST', `${A2}/cycle-counts`, { classes: ['A'] });
  check('classe A à jour : rien à compter → 400', r.status === 400, r.status);
  r = await other('POST', `${A2}/cycle-counts`, { classes: ['C'], limit: 1 });
  check('limite d\'articles respectée (1 article de classe C)', r.status === 201 && r.json.items === 1, r.json);
  await other('DELETE', `${S2}/counts/${r.json.id}`);
  r = await mem('POST', `${W}/cycle-counts`, { classes: ['A'] });
  check('droits : un membre ne planifie pas d\'inventaire tournant', r.status === 403, r.status);
  check('cohérence des quantités après inventaire tournant', (await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(i1)).quantity === 929, (await dbx.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(i1)).quantity);
  await coherent('fin du lot 6');

  // =====================================================================================================
  // LOT 7 · LISTES DE PRÉPARATION ET RANGEMENT
  // =====================================================================================================
  const PK = `${W}/picks`;
  const pickLoc = (await mgr('POST', `${W}/locations`, { warehouseId: whPrinc, code: 'PICK-01', kind: 'picking' })).json.id;
  const savon = await newItem('Savon', { unitCost: 300, barcode: 'SAV-0001' }); const lessive = await newItem('Lessive', { unitCost: 900 });
  await mgr('POST', `${S}/items/${savon}/move`, { kind: 'in', quantity: 10, locationId: A0101, unitCost: 300 });
  await mgr('POST', `${S}/items/${savon}/move`, { kind: 'in', quantity: 20, locationId: B0101, unitCost: 300 });
  await mgr('POST', `${S}/items/${savon}/move`, { kind: 'in', quantity: 6, locationId: pickLoc, unitCost: 300 });
  await mgr('POST', `${S}/items/${lessive}/move`, { kind: 'in', quantity: 5, locationId: A0102, unitCost: 900 });
  const ordP = await mkOrder([{ itemId: savon, label: 'Savon', quantity: 8, price: 400 }, { itemId: lessive, label: 'Lessive', quantity: 3, price: 1200 }, { label: 'Transport', quantity: 1, price: 1000 }], 'C-T-0200');
  r = await mem('POST', PK, { documentId: ordP });
  check('droits : un membre ne crée pas de liste de préparation', r.status === 403, r.status);
  r = await mgr('POST', PK, { documentId: ordP, lines: [] , warehouseId: 99999 });
  check('entrepôt inconnu → 404', r.status === 404, r.status);
  r = await mgr('POST', PK, { lines: [{ itemId: savon, quantity: 100 }], strict: true });
  check('préparer plus que le stock (strict) → 409, rien créé', r.status === 409 && (await dbx.prepare('SELECT COUNT(*) c FROM wms_picks').get()).c === 0, r.json);
  r = await mgr('POST', PK, { documentId: ordP, assignedTo: 999999 });
  check('personne assignée inconnue → 400', r.status === 400, r.status);
  const memberId = (await dbx.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role = 'member'").get(org)).user_id;
  r = await mgr('POST', PK, { documentId: ordP, assignedTo: memberId, priority: 1 });
  const pk1 = r.json.id;
  check('liste créée depuis la commande, confiée à un membre, urgente', r.status === 201 && pk1 > 0, r.json);
  r = await mem('GET', `${PK}/${pk1}`);
  const P1 = r.json.pick;
  check('numéro PREP-AAAA-001, client et commande rappelés', /^PR-\d{4}$/.test(P1.code) && P1.documentNumber === 'C-T-0200' && P1.customer === 'Client Ndi' && P1.priorityLabel === 'Urgente', P1);
  check('4 lignes : savon 6 en préparation + 2 ailleurs, lessive 3 (la ligne sans article est ignorée)', P1.lines.length === 3 && P1.lines.filter((l) => l.itemId === savon).reduce((a, l) => a + l.quantity, 0) === 8 && P1.lines.find((l) => l.location === 'PICK-01').quantity === 6, P1.lines.map((l) => [l.location, l.name, l.quantity]));
  const codes = P1.lines.map((l) => l.location);
  check('parcours : emplacements dans l\'ordre allée → rayon → bac (adaptation : A met d\'abord les emplacements sans position, comme PICK-01)', JSON.stringify(codes) === JSON.stringify(['PICK-01', 'A-01-01', 'A-01-02']), codes);
  a = await avail(savon);
  check('créer la liste met le stock de côté : savon 8 réservé, 28 à promettre', a.reserved === 8 && a.available === 28 && a.quantity === 36, a);
  r = await mgr('POST', PK, { lines: [{ itemId: savon, quantity: 30 }], strict: true });
  check('une autre liste ne peut pas prendre le stock réservé (30 > 28 libres) → 409', r.status === 409, r.json);
  r = await mem('GET', `${PK}?mine=1`);
  check('le préparateur voit ses listes', r.json.picks.length === 1 && r.json.waiting === 1, r.json);
  r = await other('GET', `${W2}/picks/${pk1}`);
  check('isolation : liste d\'une autre organisation → 404', r.status === 404, r.status);
  const ln = Object.fromEntries(P1.lines.map((l) => [`${l.itemId}:${l.location}`, l]));
  const lPick = P1.lines.find((l) => l.location === 'PICK-01'); const lLess = P1.lines.find((l) => l.itemId === lessive); const lOther = P1.lines.find((l) => l.itemId === savon && l.location !== 'PICK-01');
  r = await mem('POST', `${PK}/${pk1}/lines/${lPick.id}/confirm`, { quantity: 6, itemCode: 'FAUX-CODE' });
  check('scan d\'un mauvais article → 400', r.status === 400 && /bon article/.test(r.json.error), r.json);
  r = await mem('POST', `${PK}/${pk1}/lines/${lPick.id}/confirm`, { quantity: 6, itemCode: 'SAV-0001', locationCode: 'A-01-01' });
  check('scan d\'un mauvais emplacement → 400', r.status === 400 && /bon emplacement/.test(r.json.error), r.json);
  r = await mem('POST', `${PK}/${pk1}/lines/${lPick.id}/confirm`, { quantity: 7 });
  check('prélever plus que prévu → 400', r.status === 400, r.json);
  r = await mem('POST', `${PK}/${pk1}/lines/${lPick.id}/confirm`, { quantity: 6, itemCode: 'SAV-0001', locationCode: 'pick-01' });
  check('prélèvement confirmé avec scans corrects (casse ignorée)', r.status === 200, r.json);
  r = await mem('POST', `${PK}/${pk1}/complete`, {});
  check('terminer avec des lignes incomplètes → 409', r.status === 409, r.json);
  r = await mem('POST', `${PK}/${pk1}/lines/${lOther.id}/confirm`, { quantity: 1 });
  r = await mem('POST', `${PK}/${pk1}/lines/${lLess.id}/confirm`, { quantity: 3 });
  r = await mem('POST', `${PK}/${pk1}/complete`, { allowShort: true, keepShortfall: true }); // adaptation : option explicite (A libère le manque par défaut)
  check('liste terminée avec un manque accepté (1 savon sur 2 prélevé)', r.status === 200, r.json);
  r = await mem('GET', `${PK}/${pk1}`);
  check('liste « préparée », manque signalé (adaptation : A signale le manque sur les lignes)', r.json.pick.status === 'picked' && r.json.pick.lines.some((l) => l.short), r.json.pick);
  check('rien n\'est sorti du stock avant l\'expédition', (await qtyOf(savon)) === 36 && (await qtyOf(lessive)) === 5, [await qtyOf(savon), await qtyOf(lessive)]);
  r = await mem('POST', `${PK}/${pk1}/issue`, {});
  check('droits : un membre n\'expédie pas', r.status === 403, r.status);
  const valBeforeIssue = await itemsValue(org);
  r = await mgr('POST', `${PK}/${pk1}/issue`, {});
  check('expédition par un responsable', r.status === 200, r.json);
  check('sorties : savon 36 − 7 = 29, lessive 5 − 3 = 2', (await qtyOf(savon)) === 29 && (await qtyOf(lessive)) === 2, [await qtyOf(savon), await qtyOf(lessive)]);
  lv = await levels(savon);
  check('sorties prises dans les emplacements de la liste (PICK-01 vidé)', !lv.levels.some((l) => l.code === 'PICK-01'), lv.levels.map((l) => [l.code, l.quantity]));
  check('valorisation : −7 × 300 − 3 × 900 = −4 800', Math.abs(valBeforeIssue - (await itemsValue(org)) - 4800) < 0.01, [valBeforeIssue, await itemsValue(org)]);
  a = await avail(savon);
  check('la réservation de la commande est consommée pour les 7 expédiés (reste 1 réservé)', a.reserved === 1 && a.quantity === 29, a);
  const mvPk = await moveRows('pick', pk1);
  check('mouvements liés à la liste (ref_kind = pick), un par emplacement', mvPk.length === 3 && mvPk.every((m) => m.delta < 0 && m.location_id), mvPk);
  r = await mgr('POST', `${PK}/${pk1}/issue`, {});
  check('double expédition → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  r = await mgr('POST', `${PK}/${pk1}/cancel`, {});
  check('une liste expédiée ne s\'annule pas → 400 (adaptation : A répond 400)', r.status === 400, r.status);
  await coherent('expédition de liste');
  // Liste libre : réserve pour elle-même, annulation libère
  r = await mgr('POST', PK, { label: 'Atelier', lines: [{ itemId: savon, quantity: 5 }] });
  const pk2 = r.json.id;
  a = await avail(savon);
  check('liste libre : 5 mis de côté (6 réservés au total)', r.status === 201 && a.reserved === 6, a);
  r = await mgr('POST', `${PK}/${pk2}/cancel`, {});
  a = await avail(savon);
  check('annulation : réservation libérée (retour à 1)', r.status === 200 && a.reserved === 1, a);
  r = await mgr('POST', `${PK}/${pk2}/start`, {});
  check('démarrer une liste annulée → 409', r.status === 409, r.status);
  // Liste libre expédiée : la réservation de la liste est consommée
  r = await mgr('POST', PK, { label: 'Atelier 2', lines: [{ itemId: savon, quantity: 4 }] });
  const pk3 = r.json.id;
  const lines3 = (await mgr('GET', `${PK}/${pk3}`)).json.pick.lines;
  for (const l of lines3) await mgr('POST', `${PK}/${pk3}/lines/${l.id}/confirm`, {});
  await mgr('POST', `${PK}/${pk3}/complete`, {});
  r = await mgr('POST', `${PK}/${pk3}/issue`, {});
  a = await avail(savon);
  check('liste libre expédiée : 4 sortis, plus de réservation de la liste', r.status === 200 && a.quantity === 25 && a.reserved === 1, a);
  // Concurrence : deux listes simultanées sur les 3 derniers articles libres
  const rare = await mkItem('Pièce rare', 3);
  const cp = await Promise.all([1, 2, 3].map((n) => mgr('POST', PK, { label: `Course ${n}`, lines: [{ itemId: rare, quantity: 2 }], strict: true })));
  check('concurrence : trois listes de 2 sur 3 en stock → une seule passe', cp.filter((x) => x.status === 201).length === 1, cp.map((x) => x.status));
  a = await avail(rare);
  check('concurrence : jamais plus de réservé que de stock', a.reserved === 2 && a.available === 1, a);
  // Substitution d'emplacement : le préparateur prend ailleurs
  r = await mgr('POST', PK, { label: 'Substitution', lines: [{ itemId: lessive, quantity: 1 }] });
  const pk4 = r.json.id; const lines4 = (await mgr('GET', `${PK}/${pk4}`)).json.pick.lines[0];
  r = await mgr('POST', `${PK}/${pk4}/lines/${lines4.id}/confirm`, { quantity: 1, fromLocationId: B0101 });
  check('prendre dans un emplacement sans cet article → 400 (adaptation : A répond 400)', r.status === 400, r.json);
  r = await mgr('POST', `${PK}/${pk4}/cancel`, {});

  // Rangement
  const recLoc = (await mgr('POST', `${W}/locations`, { warehouseId: whDlaId, code: 'REC-DLA', kind: 'reception' })).json.id; // adaptation : A attend la marchandise dans un emplacement de type « Réception »
  const ranger = await newItem('À ranger', { unitCost: 10 }); const ranger2 = await newItem('À ranger aussi', { unitCost: 10 });
  await mgr('POST', `${S}/items/${ranger}/move`, { kind: 'in', quantity: 12, locationId: recLoc });
  await mgr('POST', `${S}/items/${ranger2}/move`, { kind: 'in', quantity: 4, locationId: recLoc });
  await mgr('POST', `${W}/putaway-rules`, { itemId: ranger, locationId: B0101 });
  r = await mem('GET', `${PK.replace('/picks', '')}/putaway/pending`);
  const tk = r.json.tasks.find((x) => x.itemId === ranger); const tk2 = r.json.tasks.find((x) => x.itemId === ranger2);
  check('rangement : 2 articles attendent en réception ; la règle propose B-01-01 pour le premier, l\'emplacement par défaut pour le second', tk && tk.suggestion[0].code === 'B-01-01' && !tk.suggestion[0].fallback && tk2 && tk2.suggestion.length === 0, r.json.tasks);
  r = await mem('POST', `${W}/putaway`, { itemId: ranger2, fromLocationId: recLoc });
  lv = await levels(ranger2);
  check('sans règle : A refuse et demande de choisir la destination (adaptation : A répond 400, B rangeait à l\'emplacement par défaut)', r.status === 400 && /destination/.test(r.json.error), r.json);
  r = await mem('POST', `${W}/putaway`, { itemId: ranger, fromLocationId: recLoc, quantity: 5 });
  lv = await levels(ranger);
  check('rangement partiel suivant la règle : 5 vers B-01-01, 7 attendent encore', r.status === 200 && lv.levels.find((l) => l.code === 'B-01-01').quantity === 5 && lv.levels.find((l) => l.locationId === recLoc).quantity === 7 && lv.quantity === 12, lv);
  r = await mem('POST', `${W}/putaway`, { itemId: ranger, fromLocationId: recLoc, toLocationId: A0102 });
  lv = await levels(ranger);
  check('rangement du reste vers une destination choisie', r.status === 200 && lv.levels.find((l) => l.code === 'A-01-02').quantity === 7 && !lv.levels.some((l) => l.locationId === recLoc), lv);
  r = await mem('POST', `${W}/putaway`, { itemId: ranger, fromLocationId: recLoc, quantity: 99 });
  check('ranger plus que présent → 400', r.status === 400, r.status);
  await coherent('fin du lot 7');

  // =====================================================================================================
  // LOT 8 · PRÉVISION ET RÉAPPROVISIONNEMENT
  // =====================================================================================================
  const FC = `${W}/b/forecast`; const RO = `${W}/b/reorder`;
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const mkF = async (name, qty, weekly /* semaine récente d'abord */) => {
    const id = await newItem(name, { unitCost: 100 });
    await mgr('POST', `${S}/items/${id}/move`, { kind: 'in', quantity: qty, unitCost: 100 });
    await dbx.prepare('UPDATE stock_items SET created_at = ? WHERE id = ?').run(ago(120), id);
    for (let w = 0; w < weekly.length; w++) await dbx.prepare("INSERT INTO stock_moves (org_id, item_id, delta, reason, created_at, ref_kind) VALUES (?, ?, ?, 'Vente', ?, '')").run(org, id, -weekly[w], ago(w * 7 + 3));
    return id;
  };
  const f1 = await mkF('Farine', 25, [20, 20, 10, 10, 20, 20, 10, 10]);
  const f2 = await mkF('Sucre', 100, [40, 40, 40, 40, 10, 10, 10, 10]);
  await dbx.prepare("INSERT INTO stock_moves (org_id, item_id, delta, reason, created_at, ref_kind) VALUES (?, ?, -500, 'Inventaire', ?, 'count')").run(org, f1, ago(5));
  await dbx.prepare("INSERT INTO stock_moves (org_id, item_id, delta, reason, created_at, ref_kind) VALUES (?, ?, -90, 'Perte transfert', ?, 'transfer')").run(org, f1, ago(6));
  r = await mem('GET', FC);
  check('droits : la prévision est réservée aux responsables', r.status === 403, r.status);
  r = await mgr('GET', `${FC}/${f1}`);
  const F1 = r.json;
  check('prévision : 8 semaines, moyenne mobile 15 par semaine (écarts d\'inventaire et pertes de transfert ignorés)', r.status === 200 && F1.weeks === 8 && F1.avgWeekly === 15 && F1.ma4 === 15 && JSON.stringify(F1.series) === JSON.stringify([10, 10, 20, 20, 10, 10, 20, 20]), F1);
  check('prévision : écart-type hebdomadaire (échantillon) 5,35 ; tendance stable', Math.abs(F1.sdWeekly - 5.35) < 0.01 && F1.trend === 'flat' && F1.nextWeeks.length === 4 && F1.nextWeeks[0].quantity === 15, F1);
  r = await mgr('GET', `${FC}/${f2}`);
  check('tendance à la hausse : moyenne des 4 dernières semaines 40 contre 25 sur 8 semaines', r.json.avgWeekly === 25 && r.json.ma4 === 40 && r.json.trend === 'up', r.json);
  r = await mgr('GET', FC);
  const row1 = r.json.items.find((x) => x.itemId === f1);
  check('liste : article avec demande, autonomie 11,7 jours (25 en stock à 2,14 par jour)', row1 && row1.avgWeekly === 15 && Math.abs(row1.cover - 11.7) < 0.05 && row1.nextMonth === 65.18, row1);
  const young = await newItem('Article récent', { unitCost: 10 });
  await mgr('POST', `${S}/items/${young}/move`, { kind: 'in', quantity: 100 });
  await mem('POST', `${S}/items/${young}/move`, { kind: 'out', quantity: 14, reason: 'Vente' });
  r = await mgr('GET', `${FC}/${young}`);
  check('article créé aujourd\'hui : moyenné sur 1 semaine (14), pas sur 8', r.json.weeks === 1 && r.json.avgWeekly === 14, r.json);

  // Réapprovisionnement : point de commande = demande pendant le délai + stock de sécurité
  r = await mgr('PUT', `${W}/b/items/${f1}/params`, { leadDays: 10 });
  check('délai fournisseur fixé sur l\'article', r.status === 200 && r.json.params.leadDays === 10, r.json);
  r = await mgr('GET', RO);
  let sg = r.json.suggestions.find((x) => x.itemId === f1);
  const sdw = Math.sqrt((8 * 25) / 7); const safety = 1.6449 * sdw * Math.sqrt(10 / 7); const rop = (15 / 7) * 10 + safety;
  check('suggestion : stock de sécurité calculé 10,5 ; point de commande 31,9 ; délai de l\'article', sg && sg.safetyStock === Math.round(safety * 10) / 10 && sg.reorderPoint === Math.round(rop * 10) / 10 && sg.leadDays === 10 && sg.leadSource === 'article' && sg.safetySource === 'calculé', sg);
  check('suggestion : commander jusqu\'à ROP + 14 jours de demande = ⌈61,9 − 25⌉ = 37, urgence « bientôt »', sg.toOrder === Math.ceil(rop + (15 / 7) * 14 - 25) && sg.toOrder === 37 && sg.urgency === 'soon', sg);
  r = await mgr('PUT', `${W}/b/items/${f1}/params`, { orderMultiple: 12 });
  r = await mgr('GET', RO);
  sg = r.json.suggestions.find((x) => x.itemId === f1);
  check('multiple de commande 12 : 37 → 48', sg.toOrder === 48, sg.toOrder);
  r = await mgr('PUT', `${W}/b/items/${f1}/params`, { orderMultiple: null, safetyStock: 0 });
  r = await mgr('GET', RO);
  check('stock de sécurité fixé à 0 : point de commande 21,4 < position 25 → plus de suggestion', !r.json.suggestions.some((x) => x.itemId === f1), r.json.suggestions.map((x) => x.name));
  r = await mgr('PUT', `${W}/b/items/${f1}/params`, { safetyStock: null });
  // stock réservé : disponible à promettre diminue la position
  const rsF = (await mgr('POST', RS, { itemId: f1, quantity: 10, label: 'Boulangerie', kind: 'manual' })).json.id;
  r = await mgr('GET', RO);
  sg = r.json.suggestions.find((x) => x.itemId === f1);
  check('la réservation (10) réduit la position : 15 disponibles, à commander 47', sg.available === 15 && sg.reserved === 10 && sg.toOrder === 47, sg);
  await mgr('POST', `${RS}/${rsF}/release`, {});
  // déjà commandé
  await mgr('POST', `${S}/orders`, { orders: [{ itemId: f1, quantity: 20, unitPrice: 100 }] });
  r = await mgr('GET', RO);
  check('déjà commandé 20 : position 45 > point de commande → plus de suggestion', !r.json.suggestions.some((x) => x.itemId === f1), r.json.suggestions.map((x) => [x.name, x.onOrder]));
  await dbx.prepare("DELETE FROM purchase_orders WHERE item_id = ?").run(f1);
  // urgence critique : autonomie plus courte que le délai
  await mgr('POST', `${S}/items/${f1}/move`, { kind: 'out', quantity: 20, reason: 'Vente' });
  r = await mgr('GET', RO);
  sg = r.json.suggestions.find((x) => x.itemId === f1);
  check('autonomie ~2 jours < délai 10 jours → critique (la sortie du jour entre dans la demande), en tête de liste', sg.urgency === 'critical' && sg.coverDays < 3 && sg.avgWeekly === 17.5 && r.json.suggestions[0].urgency === 'critical' && r.json.critical >= 1, [sg, r.json.critical]);
  // délai du fournisseur au meilleur prix, sinon par défaut
  const f3 = await mkF('Café', 2, [7, 7, 7, 7, 7, 7, 7, 7]);
  await dbx.prepare('INSERT INTO supplier_prices (org_id, item_id, supplier_id, unit_price, lead_days) VALUES (?, ?, ?, 600, 3)').run(org, f3, fourn);
  r = await mgr('GET', RO);
  sg = r.json.suggestions.find((x) => x.itemId === f3);
  check('délai pris chez le fournisseur au meilleur prix (3 jours) ; montant estimé', sg.leadDays === 3 && sg.leadSource === 'fournisseur' && sg.supplier.name === 'Fournisseur Eto' && sg.estimate === sg.toOrder * 600, sg);
  await dbx.prepare('DELETE FROM supplier_prices WHERE item_id = ?').run(f3);
  r = await mgr('GET', RO);
  sg = r.json.suggestions.find((x) => x.itemId === f3);
  check('sans fournisseur ni réglage : délai par défaut (7 jours)', sg && sg.leadDays === 7 && sg.leadSource === 'défaut', sg);
  // niveau de service
  r = await mem('PUT', `${W}/settings`, { serviceLevel: 99 });
  check('droits : réglages réservés', r.status === 403, r.status);
  r = await owner('PUT', `${W}/settings`, { serviceLevel: 99 });
  check('niveau de service 99 % accepté', r.status === 200 && r.json.settings.serviceLevel === 99, r.json);
  r = await mgr('GET', RO);
  sg = r.json.suggestions.find((x) => x.itemId === f1);
  check('niveau de service 99 % (z = 2,33) : stock de sécurité plus grand', sg.safetyStock > Math.round(safety * 10) / 10 + 3 && r.json.z === 2.33, [sg.safetyStock, r.json.z]);
  r = await owner('PUT', `${W}/settings`, { serviceLevel: 95, forecastWeeks: 4 });
  r = await mgr('GET', `${FC}/${f1}`);
  check('fenêtre réglée à 4 semaines : moyenne des 4 dernières semaines (10, 10, 20, 40 → 20)', r.json.weeks === 4 && r.json.avgWeekly === 20, r.json);
  r = await owner('PUT', `${W}/settings`, { forecastWeeks: 8 });
  // validation
  for (const [lab, body] of [['délai non entier', { leadDays: 2.5 }], ['délai négatif', { leadDays: -1 }], ['multiple nul', { orderMultiple: 0 }], ['stock de sécurité négatif', { safetyStock: -3 }]]) {
    r = await mgr('PUT', `${W}/b/items/${f1}/params`, body);
    check(`paramètre refusé : ${lab}`, r.status === 400, [r.status, r.json]);
  }
  r = await mem('PUT', `${W}/b/items/${f1}/params`, { leadDays: 1 });
  check('droits : les paramètres d\'article sont réservés aux responsables', r.status === 403, r.status);
  r = await other('GET', `${W2}/b/forecast/${f1}`);
  check('isolation : prévision d\'un article d\'une autre organisation → 404', r.status === 404, r.status);
  r = await other('GET', `${W2}/b/reorder`);
  check('isolation : suggestions de l\'autre organisation sans nos articles', r.status === 200 && !r.json.suggestions.some((x) => x.itemId === f1), r.status);
  await coherent('fin du lot 8');

  // =====================================================================================================
  // LOT 10 · ÉTATS, EXPORTS CSV, CODES SCANNÉS
  // =====================================================================================================
  const RP = `${W}/b/reports`;
  r = await mem('GET', `${RP}/valuation`);
  check('droits : la valorisation est réservée aux responsables', r.status === 403, r.status);
  r = await mgr('GET', `${RP}/valuation`);
  const tv2 = await valueOf(org);
  check('valorisation par emplacement : total = somme de tous les emplacements = valeur des articles', r.status === 200 && Math.abs(r.json.totalValue - tv2) <= r.json.lines.length && Math.abs(r.json.totalValue - r.json.itemsValue) <= r.json.lines.length, [r.json.totalValue, tv2, r.json.itemsValue]);
  check('valorisation : sous-totaux par entrepôt et par emplacement cohérents', Math.abs(r.json.warehouses.reduce((a, w) => a + w.value, 0) - r.json.totalValue) < 1 && Math.abs(r.json.locations.reduce((a, l) => a + l.value, 0) - r.json.totalValue) < 1 && r.json.locations.some((l) => l.kind === 'transit' || l.kind === 'storage'), r.json.warehouses);
  r = await owner('GET', `${O}/accounting/stock-valuation?date=${shift(0)}&nature=goods`);
  const accNow = r.json.totalValue;
  r = await mgr('GET', `${RP}/valuation`);
  check('lien comptable : la valeur du rapport = valeur de stock de la comptabilité (à l\'arrondi par ligne près)', Math.abs(accNow - r.json.totalValue) <= r.json.lines.length, [accNow, r.json.totalValue]);
  r = await mgr('GET', `${RP}/valuation?format=csv`);
  check('export CSV : en-têtes, séparateur « ; », BOM, nom de fichier daté', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.charCodeAt(0) === 0xFEFF && /^﻿Entrepôt;Emplacement;Type;Article/.test(r.text) && /attachment; filename="valorisation-stock-\d{4}-\d{2}-\d{2}\.csv"/.test(r.headers.get('content-disposition')), r.text.slice(0, 100));
  const evil = await newItem('=HYPERLINK("http://x")', { unitCost: 5 });
  await mgr('POST', `${S}/items/${evil}/move`, { kind: 'in', quantity: 1, unitCost: 5 });
  r = await mgr('GET', `${RP}/valuation?format=csv`);
  check('export CSV : une cellule qui commence par « = » est neutralisée (pas de formule)', r.text.includes(`;"'=HYPERLINK(`) && !/;"?=HYPERLINK/.test(r.text), r.text.split('\n').find((l) => /HYPERLINK/.test(l)));
  r = await other('GET', `${W2}/b/reports/valuation`);
  check('isolation : l\'autre organisation ne voit pas nos lignes', r.status === 200 && !r.json.lines.some((l) => l.item === 'Riz parfumé'), r.status);

  // Rotation
  r = await mgr('GET', `${RP}/rotation?days=365`);
  const rotF = r.json.items.find((x) => x.itemId === f2);
  check('rotation : Sucre (160 sortis en 8 semaines) a une rotation et une couverture calculées', rotF && rotF.consumedQty === 200 && rotF.turnover > 0 && rotF.coverDays > 0 && rotF.status !== 'dormant', rotF);
  check('rotation : un article sans sortie est « dormant » (et compté)', r.json.items.some((x) => x.status === 'dormant' && x.quantity > 0) && r.json.dormant >= 1, r.json.dormant);
  r = await mgr('GET', `${RP}/rotation?format=csv`);
  check('rotation en CSV', r.status === 200 && /Rotation annuelle/.test(r.text), r.status);

  // Ruptures
  const zero = await newItem('Rupture sèche', { unitCost: 10, minQuantity: 3 });
  const bas = await newItem('Presque fini', { unitCost: 10, minQuantity: 5 });
  await mgr('POST', `${S}/items/${bas}/move`, { kind: 'in', quantity: 4 });
  r = await mem('GET', `${RP}/stockouts`);
  const so = Object.fromEntries(r.json.items.map((x) => [x.name, x]));
  check('ruptures (même pour un membre) : rupture, sous le seuil, réservations non couvertes', r.status === 200 && so['Rupture sèche'].kind === 'out' && so['Presque fini'].kind === 'low' && so['Tube PVC'] && so['Tube PVC'].kind === 'short', Object.keys(so));
  check('ruptures : un membre ne voit pas la valeur', so['Presque fini'].value === undefined, so['Presque fini']);
  check('ruptures : décompte', r.json.counts.out >= 1 && r.json.counts.low >= 1 && r.json.counts.short >= 1, r.json.counts);
  r = await mgr('GET', `${RP}/stockouts?format=csv`);
  check('ruptures en CSV', r.status === 200 && /Rupture de stock/.test(r.text), r.status);

  // Vieillissement : 10 il y a 200 jours, 5 il y a 10 jours, 3 sorties → 12 en stock : 5 récents + 7 anciens
  const vieux = await newItem('Stock ancien', { unitCost: 100 });
  await mgr('POST', `${S}/items/${vieux}/move`, { kind: 'in', quantity: 10, unitCost: 100 });
  await dbx.prepare('UPDATE stock_moves SET created_at = ? WHERE item_id = ?').run(ago(200), vieux);
  await mgr('POST', `${S}/items/${vieux}/move`, { kind: 'in', quantity: 5, unitCost: 100 });
  const lastIn = (await dbx.prepare('SELECT MAX(id) id FROM stock_moves WHERE item_id = ?').get(vieux)).id;
  await dbx.prepare('UPDATE stock_moves SET created_at = ? WHERE id = ?').run(ago(10), lastIn);
  await mgr('POST', `${S}/items/${vieux}/move`, { kind: 'out', quantity: 3, reason: 'Vente' });
  r = await mgr('GET', `${RP}/aging`);
  const ag = r.json.items.find((x) => x.itemId === vieux);
  check('vieillissement : 12 en stock = 5 (0-30 jours) + 7 (181-365 jours) ; valeur 1 200', r.status === 200 && ag.quantity === 12 && ag.buckets[0].quantity === 5 && ag.buckets[3].quantity === 7 && ag.stockValue === 1200, ag);
  check('vieillissement : totaux par tranche = somme des articles', Math.abs(r.json.buckets.reduce((a, b) => a + b.value, 0) - r.json.totalValue) <= r.json.items.length, [r.json.buckets, r.json.totalValue]);
  r = await mgr('GET', `${RP}/aging?format=csv`);
  check('vieillissement en CSV', r.status === 200 && /Plus ancienne entrée/.test(r.text), r.status);
  r = await mem('GET', `${RP}/aging`);
  check('droits : vieillissement réservé aux responsables', r.status === 403, r.status);

  // Journal des mouvements
  r = await mem('GET', `${RP}/moves?itemId=${sac}`);
  check('journal : un membre le lit, sans valeurs', r.status === 200 && r.json.moves.length > 3 && r.json.moves.every((m) => m.value === undefined), r.json.moves.length);
  check('journal : entrées, sorties et déplacements internes réunis (transfert, perte)', r.json.moves.some((m) => m.type === 'internal' && /Transfert/.test(m.label)) && r.json.moves.some((m) => m.type === 'out' && /écart/i.test(m.reason)) && r.json.moves.some((m) => m.type === 'in'), r.json.moves.map((m) => m.label));
  const dates = r.json.moves.map((m) => m.at); check('journal : du plus récent au plus ancien', JSON.stringify(dates) === JSON.stringify([...dates].sort().reverse()), dates.slice(0, 3));
  r = await mgr('GET', `${RP}/moves?itemId=${sac}&kind=internal`);
  check('journal filtré : seulement les déplacements internes, valeurs visibles pour un responsable', r.json.moves.length >= 3 && r.json.moves.every((m) => m.type === 'internal' && m.value !== undefined), r.json.moves.map((m) => m.type));
  r = await mgr('GET', `${RP}/moves?locationId=${A0101}`);
  check('journal filtré par emplacement', r.json.moves.length > 0 && r.json.moves.every((m) => m.from === 'A-01-01' || m.to === 'A-01-01'), r.json.moves.length);
  r = await mgr('GET', `${RP}/moves?limit=2`);
  check('journal : pagination', r.json.count === 2 && r.json.hasMore === true, r.json.count);
  r = await mgr('GET', `${RP}/moves?from=2999-01-01`);
  check('journal : filtre par date (rien dans le futur)', r.json.moves.length === 0, r.json.count);
  r = await mgr('GET', `${RP}/moves?from=pas-une-date`);
  check('journal : date invalide → 400', r.status === 400, r.status);
  r = await mgr('GET', `${RP}/moves?format=csv&itemId=${sac}`);
  check('journal en CSV', r.status === 200 && /Date;Type;Article/.test(r.text) && r.text.split('\r\n').length > 4, r.text.slice(0, 80));
  r = await other('GET', `${W2}/b/reports/moves?itemId=${sac}`);
  check('isolation : le journal de l\'autre organisation ne montre pas nos mouvements', r.status === 200 && r.json.moves.length === 0, r.json.count);

  // Résolution d'un code scanné
  r = await mem('GET', `${W}/b/scan?code=SAV-0001`);
  check('scan : code-barres d\'un article', r.status === 200 && r.json.type === 'item' && r.json.id === savon, r.json);
  r = await mem('GET', `${W}/b/scan?code=a-01-01`);
  check('scan : code d\'emplacement', r.json.type === 'location' && r.json.id === A0101, r.json);
  r = await mem('GET', `${W}/b/scan?code=${(await mgr('GET', `${PK}/${pk1}`)).json.pick.code}`);
  check('scan : liste de préparation', r.json.type === 'pick' && r.json.id === pk1, r.json);
  r = await mem('GET', `${W}/b/scan?code=${code1}`);
  check('scan : transfert', r.json.type === 'transfer' && r.json.id === tr1, r.json);
  r = await mem('GET', `${W}/b/scan?code=INCONNU-1`);
  check('scan : code inconnu → 404', r.status === 404, r.status);
  r = await other('GET', `${W2}/b/scan?code=SAV-0001`);
  check('isolation : un code d\'une autre organisation n\'est pas résolu', r.status === 404, r.status);
  // Retour fournisseur lié à une commande d'achat : pas plus que reçu
  {
    const poi = await newItem('Article commande', { unitCost: 100 });
    await mgr('POST', `${S}/orders`, { orders: [{ itemId: poi, quantity: 6, supplierId: fourn, unitPrice: 100 }] });
    const po2 = (await dbx.prepare('SELECT id FROM purchase_orders WHERE org_id = ? ORDER BY id DESC LIMIT 1').get(org)).id;
    await owner('PUT', `${S}/orders/${po2}/status`, { status: 'ordered' });
    await mgr('POST', `${S}/orders/${po2}/receive`, { quantity: 4 });
    r = await mgr('POST', `${RT}`, { kind: 'supplier', supplierId: fourn, orderId: po2, validate: true, lines: [{ itemId: poi, quantity: 5 }] });
    check('retour fournisseur : plus que reçu sur la commande (5 > 4) → 400', r.status === 400 && /reçu/.test(r.json.error), r.json);
    r = await mgr('POST', `${RT}`, { kind: 'supplier', supplierId: fourn, orderId: po2, validate: true, lines: [{ itemId: poi, quantity: 3 }] });
    check('retour de 3 sur 4 reçus accepté', r.status === 201, r.json);
    r = await mgr('POST', `${RT}`, { kind: 'supplier', supplierId: fourn, orderId: po2, validate: true, lines: [{ itemId: poi, quantity: 2 }] });
    check('retours cumulés (3 + 2 > 4) → 400', r.status === 400, r.json);
    r = await mgr('POST', `${RT}`, { kind: 'supplier', supplierId: fourn, orderId: po2, validate: true, lines: [{ itemId: sac, quantity: 1 }] });
    check('article absent de la commande → 400', r.status === 400, r.json);
  }
  // Saisonnalité : plus de 14 mois d'historique, forte demande à la même période l'an dernier
  {
    const sea = await newItem('Article saisonnier', { unitCost: 50 });
    await mgr('POST', `${S}/items/${sea}/move`, { kind: 'in', quantity: 1000, unitCost: 50 });
    await dbx.prepare('UPDATE stock_items SET created_at = ? WHERE id = ?').run(ago(430), sea);
    for (let w = 0; w < 52; w++) await dbx.prepare("INSERT INTO stock_moves (org_id, item_id, delta, reason, created_at, ref_kind) VALUES (?, ?, -10, 'Vente', ?, '')").run(org, sea, ago(w * 7 + 3));
    for (let w = 50; w < 55; w++) await dbx.prepare("INSERT INTO stock_moves (org_id, item_id, delta, reason, created_at, ref_kind) VALUES (?, ?, -40, 'Vente', ?, '')").run(org, sea, ago(w * 7 + 3));
    r = await mgr('GET', `${FC}/${sea}`);
    check('saisonnalité : même période l\'an dernier 4 fois plus forte → indice borné à 2, prévision relevée', r.status === 200 && r.json.seasonalIndex !== null && r.json.seasonalIndex > 1.5 && r.json.avgWeekly >= 20, r.json);
    r = await mgr('GET', `${FC}/${f1}`);
    check('sans 14 mois d\'historique : pas d\'indice saisonnier', r.json.seasonalIndex === null, r.json.seasonalIndex);
  }
  await coherent('fin du lot 10');

  // =====================================================================================================
  // LOT 11 · LOTS ET SÉRIES PAR EMPLACEMENT
  // =====================================================================================================
  const trackCoh = async (label) => {
    const lotBad = await dbx.prepare(`SELECT l.id FROM stock_lots l WHERE ABS(l.quantity - COALESCE((SELECT SUM(c.quantity) FROM wms_lot_levels c WHERE c.lot_id = l.id), 0)) > 0.0005`).all();
    const locBad = await dbx.prepare(`SELECT v.item_id, v.location_id FROM wms_stock v JOIN stock_items i ON i.id = v.item_id WHERE i.tracking = 'lot' AND ABS(v.quantity - COALESCE((SELECT SUM(c.quantity) FROM wms_lot_levels c JOIN stock_lots l ON l.id = c.lot_id WHERE l.item_id = v.item_id AND c.location_id = v.location_id), 0)) > 0.0005`).all();
    const serBad = await dbx.prepare(`SELECT v.item_id, v.location_id FROM wms_stock v JOIN stock_items i ON i.id = v.item_id WHERE i.tracking = 'serial' AND v.quantity <> (SELECT COUNT(*) FROM stock_serials s WHERE s.item_id = v.item_id AND s.status = 'in_stock' AND s.location_id = v.location_id)`).all();
    check(`lots et séries (${label}) : chaque lot et chaque emplacement concordent`, lotBad.length === 0 && locBad.length === 0 && serBad.length === 0, [lotBad, locBad, serBad]);
  };
  const yog = await newItem('Yaourt entrepôt', { tracking: 'lot', unitCost: 200, pickRule: 'fefo' });
  await mgr('POST', `${S}/items/${yog}/move`, { kind: 'in', quantity: 10, lotNo: 'Y1', expiry: shift(10), unitCost: 200, locationId: A0101 });
  await mgr('POST', `${S}/items/${yog}/move`, { kind: 'in', quantity: 10, lotNo: 'Y2', expiry: shift(40), unitCost: 200, locationId: B0101 });
  await mgr('POST', `${S}/items/${yog}/move`, { kind: 'in', quantity: 5, lotNo: 'Y0', expiry: shift(-2), unitCost: 200, locationId: B0101 });
  r = await mem('GET', `${W}/items/${yog}/tracking`);
  const yl = Object.fromEntries(r.json.lots.map((l) => [l.lotNo, l]));
  check('lots par emplacement : Y1 en A-01-01, Y2 et le périmé Y0 en B-01-01', yl.Y1.locations.length === 1 && yl.Y1.locations[0].code === 'A-01-01' && yl.Y2.locations[0].code === 'B-01-01' && yl.Y0.locations[0].quantity === 5, r.json.lots);
  await trackCoh('entrées');
  r = await mem('POST', `${W}/move`, { itemId: yog, fromLocationId: A0101, toLocationId: A0102, quantity: 4 });
  r = await mem('GET', `${W}/items/${yog}/tracking`);
  check('déplacer du lot Y1 de 4 : il suit (A-01-01 : 6, A-01-02 : 4)', r.json.lots.find((l) => l.lotNo === 'Y1').locations.map((c) => c.code + ':' + c.quantity).sort().join() === 'A-01-01:6,A-01-02:4', r.json.lots);
  await trackCoh('déplacement');
  r = await mem('POST', `${S}/items/${yog}/move`, { kind: 'out', quantity: 12 });
  check('sortie FEFO : tout Y1 (10) puis 2 de Y2 ; le lot périmé reste', r.status === 200 && r.json.lots[0].lotNo === 'Y1' && r.json.lots[0].quantity === 10 && r.json.lots[1].lotNo === 'Y2' && r.json.lots[1].quantity === 2, r.json);
  lv = await levels(yog);
  check('emplacements : A-01-01 et A-01-02 vidés (lot Y1), B-01-01 garde 8 de Y2 + 5 de Y0', !lv.levels.some((l) => l.code.startsWith('A-01')) && lv.levels.find((l) => l.code === 'B-01-01').quantity === 13, lv);
  await trackCoh('sortie FEFO');
  r = await mem('POST', `${S}/items/${yog}/move`, { kind: 'out', quantity: 9 });
  check('stock utilisable insuffisant hors périmé (8 + 5 périmés) → même message qu\'avant', r.status === 400 && /périmés/.test(r.json.error), r.json);
  // transfert : les lots suivent vers « En transit » puis l'arrivée
  await mgr('POST', `${S}/items/${yog}/move`, { kind: 'in', quantity: 6, lotNo: 'Y3', expiry: shift(90), unitCost: 200, locationId: A0101 });
  r = await mem('POST', T, { fromWarehouseId: whDlaId, toWarehouseId: whPrinc, lines: [{ itemId: yog, quantity: 6, fromLocationId: A0101, toLocationId: PRINC }] });
  const trY = r.json.id;
  await owner('POST', `${T}/${trY}/ship`, {});
  r = await mem('GET', `${W}/items/${yog}/tracking`);
  check('en transit : le lot Y3 est dans « TRANSIT »', r.json.lots.find((l) => l.lotNo === 'Y3').locations[0].code === 'TRANSIT', r.json.lots.find((l) => l.lotNo === 'Y3'));
  await trackCoh('en transit');
  await mgr('POST', `${T}/${trY}/receive`, { lines: [{ lineId: (await mgr('GET', `${T}/${trY}`)).json.transfer.lines[0].id, receivedQty: 5, reason: 'Un pot cassé' }] });
  r = await mem('GET', `${W}/items/${yog}/tracking`);
  check('arrivée avec 1 manquant : Y3 à PRINCIPAL (5), le manquant est retiré du lot', r.json.lots.find((l) => l.lotNo === 'Y3').quantity === 5 && r.json.lots.find((l) => l.lotNo === 'Y3').locations[0].code === 'PRINCIPAL', r.json.lots.find((l) => l.lotNo === 'Y3'));
  await trackCoh('arrivée avec écart');
  // sortie dans un emplacement précis : seuls les lots qui y sont
  r = await mem('POST', `${S}/items/${yog}/move`, { kind: 'out', quantity: 3, locationId: B0101 });
  check('sortie dans B-01-01 : lot Y2 (le lot Y3 de PRINCIPAL n\'est pas touché)', r.status === 200 && r.json.lots.length === 1 && r.json.lots[0].lotNo === 'Y2', r.json);
  r = await mem('POST', `${S}/items/${yog}/move`, { kind: 'out', quantity: 9, locationId: PRINC });
  check('sortie plus grande que l\'emplacement → 400', r.status === 400, r.json);
  // répartition cassée par une écriture directe : reconstruite au prochain mouvement
  await dbx.prepare('DELETE FROM wms_lot_levels WHERE lot_id IN (SELECT id FROM stock_lots WHERE item_id = ?)').run(yog);
  r = await mem('POST', `${S}/items/${yog}/move`, { kind: 'out', quantity: 1 });
  check('répartition effacée : reconstruite, la sortie passe', r.status === 200, r.json);
  await trackCoh('reconstruction');
  // séries
  const tel = await newItem('Radio', { tracking: 'serial', unitCost: 9000 });
  await mgr('POST', `${S}/items/${tel}/move`, { kind: 'in', quantity: 2, serials: 'R1, R2', unitCost: 9000, locationId: A0101 });
  await mgr('POST', `${S}/items/${tel}/move`, { kind: 'in', quantity: 1, serials: 'R3', unitCost: 9000, locationId: B0101 });
  r = await mem('GET', `${W}/items/${tel}/tracking`);
  check('séries par emplacement : R1 et R2 en A-01-01, R3 en B-01-01', JSON.stringify(r.json.serials.map((x) => x.serial + '@' + x.location)) === JSON.stringify(['R1@A-01-01', 'R2@A-01-01', 'R3@B-01-01']), r.json.serials);
  await trackCoh('séries');
  r = await mem('POST', `${W}/move`, { itemId: tel, fromLocationId: A0101, toLocationId: A0102, quantity: 1, serials: 'R2' });
  r = await mem('GET', `${W}/items/${tel}/tracking`);
  check('déplacer la série R2 : elle suit (A-01-02)', r.json.serials.find((x) => x.serial === 'R2').location === 'A-01-02', r.json.serials);
  r = await mem('POST', `${W}/move`, { itemId: tel, fromLocationId: A0101, toLocationId: A0102, quantity: 1, serials: 'R3' });
  check('déplacer une série qui n\'est pas là → 400', r.status === 400, r.json);
  r = await mem('POST', `${S}/items/${tel}/move`, { kind: 'out', quantity: 1, serials: 'R3' });
  lv = await levels(tel);
  check('sortie de R3 : l\'emplacement B-01-01 est vidé (le niveau suit la série)', r.status === 200 && !lv.levels.some((l) => l.code === 'B-01-01') && lv.quantity === 2, lv);
  r = await mem('POST', `${S}/items/${tel}/move`, { kind: 'out', quantity: 1, serials: 'R1', locationId: A0102 });
  check('sortie de R1 en demandant A-01-02 (elle est en A-01-01) → 400', r.status === 400, r.json);
  await trackCoh('sorties de séries');

  // =====================================================================================================
  // RÉSERVATIONS PAR ENTREPÔT
  // =====================================================================================================
  const pile = await newItem('Pile', { unitCost: 100 });
  await mgr('POST', `${S}/items/${pile}/move`, { kind: 'in', quantity: 10, unitCost: 100, locationId: PRINC });
  await mgr('POST', `${S}/items/${pile}/move`, { kind: 'in', quantity: 10, unitCost: 100, locationId: A0101 });
  r = await mgr('POST', RS, { itemId: pile, quantity: 8, label: 'Chantier Douala', kind: 'manual', warehouseId: whDlaId });
  const rsW = r.json.id;
  check('réservation pour l\'entrepôt de Douala (8 sur 10)', r.status === 201, r.json);
  r = await mgr('POST', RS, { itemId: pile, quantity: 5, label: 'Encore Douala', kind: 'manual', warehouseId: whDlaId });
  check('réserver 5 de plus pour Douala (2 libres seulement) → 409', r.status === 409 && /entrepôt/.test(r.json.error), r.json);
  r = await mgr('POST', RS, { itemId: pile, quantity: 5, label: 'Siège', kind: 'manual', warehouseId: whPrinc });
  check('réserver 5 pour l\'entrepôt principal → ok', r.status === 201, r.json);
  const rsP = r.json.id;
  r = await mgr('POST', RS, { itemId: pile, quantity: 1, label: 'x', kind: 'manual', warehouseId: 99999 });
  check('entrepôt inconnu → 404', r.status === 404, r.status);
  r = await mem('GET', `${W}/items/${pile}/availability`);
  const aw = Object.fromEntries(r.json.warehouses.map((w) => [w.warehouseId, w]));
  check('disponibilité par entrepôt : Douala 10 utilisables, 8 réservés, 2 libres ; principal 10, 5, 5', aw[whDlaId].usable === 10 && aw[whDlaId].reserved === 8 && aw[whDlaId].available === 2 && aw[whPrinc].reserved === 5 && aw[whPrinc].available === 5, r.json.warehouses);
  r = await mem('POST', `${S}/items/${pile}/move`, { kind: 'out', quantity: 3, locationId: A0101 });
  check('sortie de Douala de 3 (2 libres, 8 réservés pour Douala) → 409', r.status === 409 && /entrepôt/.test(r.json.error) && (await qtyOf(pile)) === 20, r.json);
  r = await mem('POST', `${S}/items/${pile}/move`, { kind: 'out', quantity: 2, locationId: A0101 });
  check('sortie de Douala de 2 → ok', r.status === 200, r.json);
  r = await mem('POST', `${S}/items/${pile}/move`, { kind: 'out', quantity: 6, locationId: PRINC });
  check('sortie du principal de 6 (5 libres) → 400 (adaptation : la garde « stock réservé » de A, 400, passe avant celle de l\'entrepôt)', r.status === 400, r.json);
  r = await mem('POST', T, { fromWarehouseId: whDlaId, toWarehouseId: whPrinc, lines: [{ itemId: pile, quantity: 1 }] });
  const trW = r.json.id;
  r = await owner('POST', `${T}/${trW}/ship`, {});
  check('transfert hors de Douala du stock réservé pour Douala → 409', r.status === 409 && /entrepôt/.test(r.json.error), r.json);
  await mgr('POST', `${T}/${trW}/cancel`, {});
  r = await mem('POST', `${W}/move`, { itemId: pile, fromLocationId: A0101, toLocationId: PRINC, quantity: 1 });
  check('déplacement de Douala vers le principal du stock réservé → 409', r.status === 409, r.json);
  r = await mgr('POST', `${RS}/${rsW}/fulfill`, { quantity: 8, locationId: A0101 });
  check('livrer la réservation de Douala depuis Douala → ok (8 sortis)', r.status === 200 && r.json.status === 'fulfilled' && (await qtyOf(pile)) === 10, r.json);
  r = await mem('POST', `${S}/items/${pile}/move`, { kind: 'out', quantity: 5, locationId: PRINC });
  check('une fois livrée, plus rien de réservé à Douala ; le principal garde ses 5 réservés (5 libres)', r.status === 200, r.json);
  await mgr('POST', `${RS}/${rsP}/release`, {});
  await coherent('réservations par entrepôt');

  // =====================================================================================================
  // INVENTAIRE PAR EMPLACEMENT ET À L'AVEUGLE
  // =====================================================================================================
  const LC = `${W}/location-counts`;
  const cpt = await newItem('Compté ici', { unitCost: 100 }); const cpt2 = await newItem('Compté aussi', { unitCost: 50 }); const cptAbs = await newItem('Pas attendu', { unitCost: 10 });
  await mgr('POST', `${S}/items/${cpt}/move`, { kind: 'in', quantity: 10, unitCost: 100, locationId: A0102 });
  await mgr('POST', `${S}/items/${cpt}/move`, { kind: 'in', quantity: 7, unitCost: 100, locationId: B0101 });
  await mgr('POST', `${S}/items/${cpt2}/move`, { kind: 'in', quantity: 4, unitCost: 50, locationId: A0102 });
  r = await mem('POST', LC, { locationId: A0102 });
  check('droits : un membre n\'ouvre pas d\'inventaire d\'emplacement', r.status === 403, r.status);
  r = await other('POST', `${W2}/location-counts`, { locationId: A0102 });
  check('isolation : emplacement d\'une autre organisation → 404', r.status === 404, r.status);
  const emptyLoc = (await mgr('POST', `${W}/locations`, { warehouseId: whDlaId, code: 'VIDE-9' })).json.id;
  r = await mgr('POST', LC, { locationId: emptyLoc });
  check('emplacement vide sans article attendu → 400', r.status === 400, r.status);
  const qtyAt = async (item, loc) => ((await levels(item)).levels.find((l) => l.locationId === loc) || { quantity: 0 }).quantity;
  const beforeValue = await itemsValue(org);
  r = await mgr('POST', LC, { locationId: A0102, blind: true, itemIds: [cptAbs] });
  const lc1 = r.json.id;
  check('inventaire de l\'emplacement A-01-02 (à l\'aveugle) ouvert, articles déjà présents ajoutés', r.status === 201 && lc1 > 0, r.json);
  r = await mgr('POST', LC, { locationId: B0101 });
  check('un autre inventaire en cours → 409', r.status === 409, r.status);
  r = await mem('GET', `${S}/counts/${lc1}`);
  const cl1 = r.json.count;
  const mine = cl1.items.find((x) => x.itemId === cpt);
  check('à l\'aveugle : quantité attendue et écart cachés pendant le comptage', cl1.blind === true && cl1.location === 'A-01-02' && mine.expected === null && mine.gap === null && cl1.withGap === undefined, cl1);
  check('l\'inventaire porte les articles de l\'emplacement (pas ceux d\'ailleurs)', cl1.items.some((x) => x.itemId === cpt) && cl1.items.some((x) => x.itemId === cpt2) && cl1.items.some((x) => x.itemId === cptAbs), cl1.items.map((x) => x.name));
  r = await mgr('POST', `${LC}/${lc1}/lines`, { itemId: bas });
  check('ajouter un article trouvé sur place', r.status === 201 && r.json.added === 1, r.json);
  // comptage : cpt 9 (au lieu de 10), cpt2 4 (ok), pas attendu 3 (surplus), riz 0
  await mem('PUT', `${S}/counts/${lc1}/lines`, { lines: [{ itemId: cpt, counted: 9 }, { itemId: cpt2, counted: 4 }, { itemId: cptAbs, counted: 3 }, { itemId: bas, counted: 0 }, ...(cl1.items.some((x) => x.itemId === riz) ? [{ itemId: riz, counted: await qtyAt(riz, A0102) }] : [])] });
  await mem('POST', `${S}/counts/${lc1}/submit`, {});
  r = await mgr('GET', `${S}/counts/${lc1}`);
  const cs = r.json.count;
  check('après soumission, l\'attendu et les écarts apparaissent (−1, +3)', cs.items.find((x) => x.itemId === cpt).expected === 10 && cs.items.find((x) => x.itemId === cpt).gap === -1 && cs.items.find((x) => x.itemId === cptAbs).gap === 3, cs.items);
  r = await mgr('POST', `${S}/counts/${lc1}/validate`, {});
  check('un responsable qui a ouvert l\'inventaire ne le valide pas (sauf administrateur)', r.status === 403, r.status);
  r = await owner('POST', `${S}/counts/${lc1}/validate`, {});
  check('validation par l\'administrateur : 2 ajustements', r.status === 200 && r.json.adjusted === 2, r.json);
  check('l\'écart ajuste l\'emplacement compté : A-01-02 : 9 et 3 ; B-01-01 (autre emplacement) inchangé à 7', (await qtyAt(cpt, A0102)) === 9 && (await qtyAt(cptAbs, A0102)) === 3 && (await qtyAt(cpt, B0101)) === 7 && (await qtyOf(cpt)) === 16, [await qtyAt(cpt, A0102), await qtyAt(cpt, B0101)]);
  check('valorisation : −1 × 100 + 3 × 10 = −70', Math.abs((await itemsValue(org)) - beforeValue - (-100 + 30)) < 0.01, [beforeValue, await itemsValue(org)]);
  await coherent('inventaire par emplacement');
  // inventaire d'un emplacement pour un article suivi par lot : l'écart suit le lot présent là
  await trackCoh('avant inventaire de lot');
  r = await mgr('POST', LC, { locationId: PRINC, itemIds: [yog] });
  const lc2 = r.json.id;
  const ylines = (await mgr('GET', `${S}/counts/${lc2}`)).json.count.items;
  await mgr('PUT', `${S}/counts/${lc2}/lines`, { lines: ylines.map((x) => ({ itemId: x.itemId, counted: x.itemId === yog ? Math.max(x.expected - 1, 0) : x.expected })) });
  await mgr('POST', `${S}/counts/${lc2}/submit`, {});
  r = await owner('POST', `${S}/counts/${lc2}/validate`, {});
  check('inventaire d\'un emplacement : écart sur un article suivi par lot', r.status === 200, r.json);
  await trackCoh('après inventaire de lot');
  await coherent('inventaire de lot');

  // =====================================================================================================
  // VAGUES, PALETTES, COLISAGE — ADAPTÉ (fusion) : A fournit ses propres vagues (wms-waves : brouillon → lancée → terminée, parcours en serpentin,
  // dépose, tri), unités de manutention (wms-hu) et colis (wms-ship), prouvés par test-wms4c.js / test-hu.js. Les contrôles de B ci-dessous visent l'API de B
  // (POST /waves {documentIds} créant des listes d'un coup, /units, /picks/:id/packages) : ils sont adaptés ci-dessous aux routes et formes de A (adaptations dans la matrice) et s'exécutent toujours.
  // Voir docs/fusion/matrice/entrepot.md (« non porté »).
  // =====================================================================================================
  {
  const WV = `${W}/waves`; // adaptation : une quantité inférieure donnée au prélèvement vaut « manque déclaré » chez A ; le test laisse donc la ligne B ouverte pour obtenir le 409 de B
   const UN = `${W}/units`; const B0102 = await locId('B-01-02');
    const vgA = await newItem('Vague A', { unitCost: 100, barcode: 'VAG-A-001' }); const vgB = await newItem('Vague B', { unitCost: 200 });
    await mgr('POST', `${S}/items/${vgA}/move`, { kind: 'in', quantity: 12, unitCost: 100, locationId: A0101 });
    await mgr('POST', `${S}/items/${vgB}/move`, { kind: 'in', quantity: 6, unitCost: 200, locationId: B0101 });
    const ordV1 = await mkOrder([{ itemId: vgA, label: 'A', quantity: 3, price: 1 }, { itemId: vgB, label: 'B', quantity: 2, price: 1 }], 'C-V-0001');
    const ordV2 = await mkOrder([{ itemId: vgA, label: 'A', quantity: 4, price: 1 }, { itemId: vgB, label: 'B', quantity: 1, price: 1 }], 'C-V-0002');
    const ordV3 = await mkOrder([{ itemId: vgA, label: 'A', quantity: 50, price: 1 }], 'C-V-0003');
    r = await mem('POST', WV, { documentIds: [ordV1, ordV2], strict: true });
    check('droits : un membre ne crée pas de vague', r.status === 403, r.status);
    r = await mgr('POST', WV, { documentIds: [ordV1], strict: true });
    check('une vague regroupe au moins 2 commandes → 400', r.status === 400, r.status);
    const picksBefore = (await dbx.prepare('SELECT COUNT(*) c FROM wms_picks').get()).c;
    r = await mgr('POST', WV, { documentIds: [ordV1, ordV3], strict: true });
    check('une commande impossible (50 > stock) annule toute la vague : aucune liste créée', r.status === 409 && (await dbx.prepare('SELECT COUNT(*) c FROM wms_picks').get()).c === picksBefore && (await dbx.prepare('SELECT COUNT(*) c FROM wms_waves').get()).c === 0, r.json);
    a = await avail(vgA);
    check('rien de réservé après l\'échec', a.reserved === 0, a);
    r = await mgr('POST', WV, { documentIds: [ordV1, ordV2], label: 'Tournée du matin', strict: true });
    const waveV1 = r.json.id;
    check('vague de 2 commandes créée', r.status === 201, r.json);
    r = await mem('GET', `${WV}/${waveV1}`);
    const WVw = r.json.wave;
    check('vague VG-0001 (adaptation : A, parcours dans « route ») : 2 listes, lignes regroupées par emplacement (A : 7 en A-01-01, B : 3 en B-01-01) dans l\'ordre du parcours', /^VG-\d{4}$/.test(WVw.code) && WVw.picks.length === 2 && WVw.route.length === 2 && WVw.route[0].location === 'A-01-01' && WVw.route[0].quantity === 7 && WVw.route[1].quantity === 3 && WVw.route[0].orders.length === 2, WVw);
    a = await avail(vgA);
    check('le stock de la vague est mis de côté (A : 7 réservés)', a.reserved === 7, a);
    await mgr('POST', `${WV}/${waveV1}/release`, {}); // adaptation : A lance la vague (brouillon → lancée) avant le prélèvement
    r = await mem('POST', `${WV}/${waveV1}/confirm`, { itemId: vgA, locationId: A0101, quantity: 7, itemCode: 'FAUX' });
    check('scan d\'un mauvais article → 400, rien prélevé', r.status === 400 && (await dbx.prepare('SELECT COALESCE(SUM(picked_qty), 0) q FROM wms_pick_lines WHERE item_id = ?').get(vgA)).q === 0, r.json);
    r = await mem('POST', `${WV}/${waveV1}/confirm`, { itemId: vgA, locationId: A0101, quantity: 7, itemCode: 'VAG-A-001', locationCode: 'a-01-01' });
    check('prélèvement regroupé de 7 : réparti 3 + 4 entre les deux commandes', r.status === 200, r.json);
    const pl = await dbx.prepare('SELECT picked_qty FROM wms_pick_lines WHERE item_id = ? ORDER BY id').all(vgA);
    check('réparti 3 et 4', pl.map((x) => x.picked_qty).join() === '3,4', pl);
    r = await mem('POST', `${WV}/${waveV1}/complete`, {});
    check('terminer la vague avec un manque (1 B non prélevé) → 409', r.status === 409, r.json);
    r = await mem('POST', `${WV}/${waveV1}/confirm`, { itemId: vgB, locationId: B0101, quantity: 5 });
    check('prélever plus que le reste → 400', r.status === 400, r.json);
    r = await mem('POST', `${WV}/${waveV1}/confirm`, { itemId: vgB, locationId: B0101 });
    r = await mem('POST', `${WV}/${waveV1}/complete`, {});
    check('vague préparée', r.status === 200, r.json);
    r = await mem('POST', `${WV}/${waveV1}/issue`, {});
    check('droits : un membre n\'expédie pas la vague', r.status === 403, r.status);
    r = await other('GET', `${W2}/waves/${waveV1}`);
    check('isolation : vague d\'une autre organisation → 404', r.status === 404, r.status);
    // colisage sur la première liste de la vague
    const pickV1 = (await mgr('GET', `${WV}/${waveV1}`)).json.wave.picks[0].pickId;
    r = await mem('GET', `${W}/picks/${pickV1}/packages`);
    check('colisage : tout est encore à emballer (3 A + 2 B)', r.status === 200 && r.json.unpacked.reduce((a2, x) => a2 + x.q, 0) === 5, r.json);
    r = await mem('POST', `${W}/picks/${pickV1}/packages`, { weight: 2.5, lines: [{ itemId: vgA, quantity: 4 }] });
    check('emballer plus que prélevé (4 > 3) → 400', r.status === 400, r.json);
    r = await mem('POST', `${W}/picks/${pickV1}/packages`, { weight: 2.5, lines: [{ itemId: vgA, quantity: 3 }] });
    const pkgV1 = r.json.id;
    check('premier colis (3 A, 2,5 kg)', r.status === 201, r.json);
    r = await mgr('POST', `${W}/picks/${pickV1}/issue`, {});
    check('expédier avec un colisage incomplet (2 B pas emballés) → 409', r.status === 409 && /Colisage incomplet/.test(r.json.error), r.json);
    r = await mem('POST', `${W}/picks/${pickV1}/packages`, { weight: 1, all: true });
    r = await mem('GET', `${W}/picks/${pickV1}/packages`);
    check('2e colis avec le reste ; plus rien à emballer, poids total 3,5 kg', r.json.packages.length === 2 && r.json.unpacked.length === 0 && r.json.weight === 3.5 && /^COL-\d{4}$/.test(r.json.packages[0].code), r.json);
    // expédition de la vague : la 2e liste n'a pas de colis (pas obligatoire), la 1re est complète
    const valBeforeWave = await itemsValue(org);
    r = await mgr('POST', `${WV}/${waveV1}/issue`, {});
    check('expédition de la vague : 2 commandes sorties', r.status === 200 && r.json.orders === 2 && (await qtyOf(vgA)) === 5 && (await qtyOf(vgB)) === 3, r.json);
    check('valorisation : −7 × 100 − 3 × 200 = −1 300', Math.abs(valBeforeWave - (await itemsValue(org)) - 1300) < 0.01, [valBeforeWave, await itemsValue(org)]);
    r = await mgr('GET', `${WV}/${waveV1}`);
    check('vague terminée', r.json.wave.status === 'picked', r.json.wave.status);
    r = await mem('DELETE', `${W}/packages/${pkgV1}`);
    check('un colis d\'une liste expédiée ne se défait plus → 409', r.status === 409, r.status);
    await coherent('vagues');
    // annulation d'une vague
    const ordV4 = await mkOrder([{ itemId: vgA, label: 'A', quantity: 1, price: 1 }, { itemId: vgB, label: 'B', quantity: 1, price: 1 }], 'C-V-0004'); const ordV5 = await mkOrder([{ itemId: vgA, label: 'A', quantity: 1, price: 1 }], 'C-V-0005');
    r = await mgr('POST', WV, { documentIds: [ordV4, ordV5], strict: true });
    const waveV2 = r.json.id;
    check('nouvelle vague : 2 A réservés', (await avail(vgA)).reserved === 2, await avail(vgA));
    a = await avail(vgA);
    r = await mgr('POST', `${WV}/${waveV2}/cancel`, { cancelPicks: true });
    check('annulation d\'une vague : listes annulées, vague annulée ; les commandes gardent leur réservation (elles existent toujours)', r.status === 200 && (await mgr('GET', `${WV}/${waveV2}`)).json.wave.status === 'cancelled' && (await avail(vgA)).reserved === 2, await avail(vgA));
    await mgr('PUT', `${O}/sales/orders/${ordV4}/status`, { status: 'cancelled' }).catch(() => {});
    await dbx.prepare("UPDATE documents SET status = 'cancelled' WHERE id IN (?, ?)").run(ordV4, ordV5);
    check('commandes annulées : réservations libérées', (await avail(vgA)).reserved === 0, await avail(vgA));
  
    // Palettes
    r = await mem('POST', UN, { kind: 'bateau', locationId: A0101 });
    check('type d\'unité inconnu → 400', r.status === 400, r.status);
    r = await mem('POST', UN, { kind: 'pallet', locationId: A0101, note: 'Palette de test' });
    const palV = r.json.id;
    check('un membre crée une palette (code PAL-AAAA-001)', r.status === 201, r.json);
    r = await mem('GET', `${UN}/${palV}`);
    check('code de palette et emplacement', /^PAL-\d{4}$/.test(r.json.unit.code) && r.json.unit.location === 'A-01-01', r.json.unit);
    const palCode = r.json.unit.code;
    r = await mem('POST', `${UN}/${palV}/items`, { itemId: vgA, quantity: 9 });
    check('ajouter 9 A alors que 5 sont libres → 409', r.status === 409, r.json);
    r = await mem('POST', `${UN}/${palV}/items`, { itemId: vgA, quantity: 4 });
    check('ajouter 4 A à la palette', r.status === 200, r.json);
    r = await mem('POST', `${UN}/${palV}/items`, { itemId: vgA, quantity: 2 });
    check('2 de plus alors qu\'1 seul est libre → 409', r.status === 409, r.json);
    r = await mem('POST', `${UN}/${palV}/items`, { itemId: vgA, quantity: 1 });
    r = await mem('GET', `${UN}/${palV}`);
    check('cumul : 5 A dans la palette (valeur cachée à un membre)', r.json.unit.items[0].quantity === 5 && r.json.unit.quantity === 5 && r.json.unit.value === undefined, r.json.unit);
    check('plus rien de libre : 1 de plus → 409', (await mem('POST', `${UN}/${palV}/items`, { itemId: vgA, quantity: 1 })).status === 409, true);
    r = await mem('POST', UN, { kind: 'carton', locationId: A0101, parentId: palV });
    const carV = r.json.id;
    await mem('POST', `${UN}/${carV}/items`, { itemId: vgB, quantity: 0.5 }).catch(() => {});
    r = await mem('POST', UN, { kind: 'carton', locationId: B0101, parentId: palV });
    check('un carton sur une palette d\'un autre emplacement → 400', r.status === 400, r.status);
    r = await mem('POST', `${UN}/${palV}/nest`, { parentId: carV });
    check('une palette ne se pose pas sur son propre carton → 400', r.status === 400, r.status);
    r = await mem('POST', `${UN}/${palV}/move`, { toLocationId: B0102 });
    check('déplacer la palette (5 A) vers B-01-02', r.status === 200, r.json);
    lv = await levels(vgA);
    check('le contenu a suivi : 5 A en B-01-02', lv.levels.find((l) => l.code === 'B-01-02').quantity === 5 && lv.quantity === 5 && (await mem('GET', `${UN}/${palV}`)).json.unit.location === 'B-01-02', lv);
    check('le carton posé sur la palette l\'a suivie', (await mem('GET', `${UN}/${carV}`)).json.unit.location === 'B-01-02', true);
    await coherent('palette déplacée');
    // du stock sort autrement : la palette ne peut pas contenir plus que ce qui est là
    r = await mem('POST', `${S}/items/${vgA}/move`, { kind: 'out', quantity: 3, locationId: B0102 });
    r = await mem('GET', `${UN}/${palV}`);
    check('3 A sortis par ailleurs : la palette n\'en contient plus que 2', r.json.unit.items[0].quantity === 2, r.json.unit);
    r = await mem('GET', `${W}/b/scan?code=${palCode}`);
    check('scan d\'une palette', r.json.type === 'unit' && r.json.id === palV, r.json);
    r = await other('GET', `${W2}/units/${palV}`);
    check('isolation : palette d\'une autre organisation → 404', r.status === 404, r.status);
    r = await mem('DELETE', `${UN}/${palV}`);
    check('dépalettiser : l\'unité disparaît, le stock reste (2 A), le carton est libéré', r.status === 200 && (await qtyOf(vgA)) === 2 && (await mem('GET', `${UN}/${carV}`)).json.unit.parentId === null, r.json);
    r = await mem('GET', `${UN}?locationId=${B0102}`);
    check('liste des unités d\'un emplacement', r.status === 200 && r.json.units.some((u) => u.id === carV), r.json.units);
    await coherent('fin des vagues et palettes');
  }

  // =====================================================================================================
  // SUPPRESSION D'UNE ORGANISATION : tout le stock d'entrepôt part avec elle (aucune ligne orpheline, aucune erreur)
  // =====================================================================================================
  const ownerId = (await dbx.prepare('SELECT owner_id FROM orgs WHERE id = ?').get(org)).owner_id;
  const orgX = Number((await dbx.prepare("INSERT INTO orgs (name, sector, description, currency, owner_id, intake_token, created_at) VALUES ('Société à supprimer', '', '', 'FCFA', ?, ?, ?)").run(ownerId, 'tok' + Date.now(), new Date().toISOString())).lastInsertRowid);
  await dbx.prepare("INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, 'owner', 'Dirigeant', ?)").run(orgX, ownerId, new Date().toISOString());
  {
    const SX = `${ws(orgX)}/stock`; const WX = `${SX}/wms`;
    const ix = (await owner('POST', `${SX}/items`, { name: 'Temp', unitCost: 10 })).json.id;
    await owner('POST', `${SX}/items/${ix}/move`, { kind: 'in', quantity: 5, unitCost: 10 });
    const whx = (await owner('POST', `${WX}/warehouses`, { name: 'Dépôt temporaire' })).json.id;
    await owner('POST', `${WX}/reservations`, { itemId: ix, quantity: 1, label: 'x', kind: 'manual' });
    const trx = (await owner('POST', `${WX}/transfers`, { fromWarehouseId: (await dbx.prepare('SELECT id FROM wms_warehouses WHERE org_id = ? AND is_default = 1').get(orgX)).id, toWarehouseId: whx, lines: [{ itemId: ix, quantity: 2 }] })).json.id;
    await owner('POST', `${WX}/transfers/${trx}/ship`, {});
    await owner('POST', `${WX}/returns`, { kind: 'scrap', reason: 'Test', validate: true, lines: [{ itemId: ix, quantity: 1, reasonCode: 'damaged' }] });
    await owner('POST', `${WX}/receipts`, { lines: [{ itemId: ix, quantity: 2, unitCost: 10 }], costs: [{ kind: 'transport', amount: 20 }] });
    await owner('POST', `${WX}/picks`, { label: 'p', lines: [{ itemId: ix, quantity: 1 }] });
    r = await owner('DELETE', ws(orgX), { confirm: 'Société à supprimer' });
    check('suppression d\'une organisation qui a des emplacements, transferts, réservations, retours, réceptions et listes → 200', r.status === 200, r.json);
    const left = await dbx.prepare('SELECT (SELECT COUNT(*) FROM wms_stock WHERE org_id = ?) + (SELECT COUNT(*) FROM wms_locations WHERE org_id = ?) + (SELECT COUNT(*) FROM wms_warehouses WHERE org_id = ?) + (SELECT COUNT(*) FROM wms_transfers WHERE org_id = ?) + (SELECT COUNT(*) FROM wms_returns WHERE org_id = ?) + (SELECT COUNT(*) FROM wms_receipts WHERE org_id = ?) + (SELECT COUNT(*) FROM wms_picks WHERE org_id = ?) AS n').get(orgX, orgX, orgX, orgX, orgX, orgX, orgX);
    check('rien d\'orphelin après la suppression', left.n === 0, left);
  }
});
