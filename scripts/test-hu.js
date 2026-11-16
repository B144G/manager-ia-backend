'use strict';
// Stock entrepôt (WMS) — unités de manutention (palettes, colis) : réception sur palette, déplacement en un scan, contenu, imbrication,
// cohérence avec le stock par emplacement (sorties, préparation), étiquette Code 128. Lancez-le avec : node scripts/test-hu.js
const { run } = require('./lib/wave1');

run('Palettes et colis (unités de manutention)', async ({ check, owner, mem, other, org, org2, ws, O, dbx }) => {
  const WM = `${O}/stock/wms`;
  let r;
  const coherent = async () => {
    const a = await dbx.prepare('SELECT i.id, i.quantity, COALESCE((SELECT SUM(s.quantity) FROM wms_stock s WHERE s.item_id = i.id), 0) AS loc FROM stock_items i WHERE i.org_id = ?').all(org);
    const b = await dbx.prepare(`SELECT s.location_id, s.item_id, s.quantity, COALESCE((SELECT SUM(c.quantity) FROM wms_hu_contents c JOIN wms_hus h ON h.id = c.hu_id WHERE h.location_id = s.location_id AND c.item_id = s.item_id), 0) AS hu FROM wms_stock s WHERE s.org_id = ?`).all(org);
    const orphan = await dbx.prepare('SELECT c.* FROM wms_hu_contents c JOIN wms_hus h ON h.id = c.hu_id WHERE h.org_id = ? AND NOT EXISTS (SELECT 1 FROM wms_stock s WHERE s.location_id = h.location_id AND s.item_id = c.item_id)').all(org);
    return [...a.filter((x) => Math.abs(Number(x.quantity) - Number(x.loc)) > 1e-6), ...b.filter((x) => Number(x.hu) > Number(x.quantity) + 1e-6), ...orphan];
  };

  // Le code-barres : le tableau Code 128 est complet et chaque motif a la bonne largeur.
  const { C128, code128 } = require('../src/services/code128');
  check('Code 128 : 107 motifs distincts de 11 modules (stop : 13)', C128.length === 107 && new Set(C128).size === 107 && C128.every((p, i) => [...p].reduce((s, x) => s + Number(x), 0) === (i === 106 ? 13 : 11)), null);
  const enc = code128('PAL00000001');
  check('Code 128 : départ B, données, contrôle, arrêt', enc.startsWith('211214') && enc.endsWith('2331112') && enc.length === (1 + 11 + 1) * 6 + 7, enc.length);

  r = await owner('POST', `${O}/stock/items`, { name: 'Ciment 50 kg', unit: 'sac', unitCost: 4500 });
  const ciment = r.json.id;
  r = await owner('POST', `${O}/stock/items`, { name: 'Lait en poudre', unit: 'carton', unitCost: 12000, tracking: 'lot' });
  const lait = r.json.id;
  await owner('POST', `${WM}/locations/bulk`, { warehouseId: (await owner('GET', `${WM}/overview`)).json.warehouses[0].id, aisles: 'A', racks: '1', bins: '3' });
  r = await owner('POST', `${WM}/locations`, { warehouseId: (await owner('GET', `${WM}/overview`)).json.warehouses[0].id, code: 'QUAI', kind: 'reception' });
  const L = Object.fromEntries((await owner('GET', `${WM}/locations`)).json.locations.map((l) => [l.code, l]));

  // ---------- Réception sur palette ----------
  r = await mem('POST', `${WM}/hus/receive`, { type: 'pallet', locationCode: 'quai', reference: 'BL-12', lines: [{ itemId: ciment, quantity: '40' }, { itemId: lait, quantity: '20', lotNo: 'L-7', expiry: '2030-06-30' }] });
  check('réception sur une nouvelle palette (code PAL…)', r.status === 201 && /^PAL\d{8}$/.test(r.json.code) && r.json.location === 'QUAI', r.json);
  const pal = r.json.id; const palCode = r.json.code;
  r = await mem('POST', `${WM}/hus/receive`, { type: 'pallet', lines: [{ itemId: lait, quantity: '5' }] });
  check('réception : numéro de lot exigé pour un article suivi par lot', r.status === 400 && /lot/.test(r.json.error), r.json);
  r = await mem('POST', `${WM}/hus/receive`, { type: 'pallet', lines: [{ itemId: ciment, quantity: '1', unitCost: '1' }] });
  check('réception : un membre ne valorise pas l\'entrée', r.status === 403, r.json);
  r = await mem('GET', `${WM}/hus/${pal}`);
  const h1 = r.json.hu;
  check('palette : contenu (lot et péremption), emplacement, historique', h1.location === 'QUAI' && h1.items === 2 && h1.quantity === 60 && h1.contents.find((c) => c.itemId === lait).lotNo === 'L-7' && h1.contents.find((c) => c.itemId === lait).expiry === '2030-06-30' && h1.status === 'open', h1);
  check('palette : sans valeur pour un membre', h1.contents.every((c) => c.value === undefined), h1.contents);
  r = await owner('GET', `${O}/stock`);
  check('stock : les articles reçus sont bien en stock', Number(r.json.items.find((i) => i.id === ciment).quantity) === 40, r.json.items);
  check('cohérence après réception', (await coherent()).length === 0, await coherent());

  // ---------- Scan ----------
  r = await mem('GET', `${WM}/scan?code=${palCode.toLowerCase()}`);
  check('scan : la palette est reconnue', r.json.type === 'hu' && r.json.id === pal, r.json);
  r = await mem('GET', `${WM}/hus/lookup?code=${palCode}`);
  check('recherche de palette par code', r.json.hu.id === pal, r.json);
  r = await other('GET', `${ws(org2)}/stock/wms/hus/${pal}`);
  check('cloisonnement : palette introuvable depuis une autre organisation', r.status === 404, r.status);

  // ---------- Déplacement en un scan ----------
  r = await mem('POST', `${WM}/move`, { itemId: ciment, fromLocationId: L.QUAI.id, toLocationId: L['A-01-01'].id, quantity: '10' });
  check('déplacement article par article : refusé si le stock est sur une palette', r.status === 400 && /palette/.test(r.json.error), r.json);
  r = await mem('POST', `${WM}/hus/${pal}/move`, { toLocationCode: 'A-01-01' });
  check('palette déplacée en un scan', r.status === 200 && r.json.to === 'A-01-01', r.json);
  r = await owner('GET', `${WM}/locations/${L['A-01-01'].id}`);
  check('arrivée : tout le contenu est dans A-01-01, la palette y est listée', r.json.content.find((c) => c.itemId === ciment).quantity === 40 && r.json.content.find((c) => c.itemId === lait).quantity === 20 && r.json.hus.some((h) => h.code === palCode), r.json);
  r = await owner('GET', `${WM}/locations/${L.QUAI.id}`);
  check('départ : le quai est vide', r.json.content.length === 0, r.json.content);
  r = await mem('POST', `${WM}/hus/${pal}/move`, { toLocationCode: 'TRANSIT' });
  check('déplacement : « En transit » refusé', r.status === 400, r.json);
  r = await mem('GET', `${WM}/hus/${pal}`);
  check('historique : le déplacement est tracé (une ligne par opération)', r.json.hu.history.length === 1 && r.json.hu.history[0].from === 'QUAI' && r.json.hu.history[0].to === 'A-01-01', r.json.hu.history);
  check('cohérence après déplacement', (await coherent()).length === 0, await coherent());

  // ---------- Colis sur palette ----------
  r = await mem('POST', `${WM}/hus`, { type: 'box', locationId: L['A-01-01'].id, parentId: pal, lines: [{ itemId: ciment, quantity: '5' }] });
  check('colis : refusé s\'il n\'y a pas assez de stock en vrac', r.status === 400 && /vrac/.test(r.json.error), r.json);
  r = await mem('POST', `${O}/stock/items/${ciment}/move`, { kind: 'in', quantity: 10, locationId: L['A-01-01'].id });
  r = await mem('POST', `${WM}/hus`, { type: 'box', locationId: L['A-01-01'].id, parentId: pal, lines: [{ itemId: ciment, quantity: '5' }] });
  check('colis (COL…) posé sur la palette', r.status === 201 && /^COL/.test(r.json.code), r.json);
  const box = r.json.id;
  r = await mem('POST', `${WM}/hus/${pal}/nest`, { parentId: box });
  check('imbrication : une palette ne va pas dans un colis', r.status === 400, r.json);
  r = await mem('POST', `${WM}/hus/${box}/move`, { toLocationCode: 'A-01-02' });
  check('un colis posé sur une palette se déplace avec elle', r.status === 400 && /posé sur une palette/.test(r.json.error), r.json);
  r = await mem('POST', `${WM}/hus/${pal}/move`, { toLocationCode: 'A-01-02' });
  r = await mem('GET', `${WM}/hus/${box}`);
  check('palette déplacée : le colis suit', r.json.hu.location === 'A-01-02' && r.json.hu.parentCode === palCode, r.json.hu);
  r = await owner('GET', `${WM}/items/${ciment}/levels`);
  check('stock en vrac resté en A-01-01 (5), palette + colis en A-01-02 (45)', r.json.levels.find((l) => l.code === 'A-01-01').quantity === 5 && r.json.levels.find((l) => l.code === 'A-01-02').quantity === 45, r.json.levels);
  check('cohérence après imbrication', (await coherent()).length === 0, await coherent());

  // ---------- Ajouter, retirer ----------
  r = await mem('POST', `${WM}/hus/${pal}/remove`, { itemId: ciment, quantity: '15' });
  check('retirer de la palette : le stock reste à l\'emplacement, en vrac', r.status === 200, r.json);
  r = await mem('POST', `${WM}/hus/${pal}/remove`, { itemId: ciment, quantity: '500' });
  check('retirer : pas plus que le contenu', r.status === 400, r.json);
  r = await mem('POST', `${WM}/hus/${pal}/add`, { itemId: ciment, quantity: '15' });
  check('remettre sur la palette', r.status === 200, r.json);
  r = await mem('POST', `${WM}/hus/${pal}/add`, { itemId: ciment, quantity: '1' });
  check('ajouter : pas plus que le vrac disponible', r.status === 400, r.json);

  // ---------- Sorties : la palette se vide d'autant ----------
  r = await owner('POST', `${O}/stock/items/${lait}/move`, { kind: 'out', quantity: 8, locationId: L['A-01-02'].id, reason: 'Vente' });
  check('sortie de stock depuis l\'emplacement de la palette', r.status === 200, r.json);
  r = await mem('GET', `${WM}/hus/${pal}`);
  check('la palette a perdu les 8 cartons sortis', r.json.hu.contents.find((c) => c.itemId === lait).quantity === 12, r.json.hu.contents);
  check('cohérence après une sortie', (await coherent()).length === 0, await coherent());
  // Préparation de commande : prélever sur l'emplacement de la palette
  r = await owner('POST', `${WM}/picks`, { lines: [{ itemId: lait, quantity: '12' }], label: 'Commande Ali' });
  const pick = r.json.id;
  const ln = (await mem('GET', `${WM}/picks/${pick}`)).json.pick.lines[0];
  await mem('POST', `${WM}/picks/${pick}/lines/${ln.id}/confirm`, {});
  await mem('POST', `${WM}/picks/${pick}/complete`, { allowShort: true });
  r = await owner('POST', `${WM}/picks/${pick}/issue`, {});
  check('préparation sortie depuis la palette', r.status === 200, r.json);
  r = await mem('GET', `${WM}/hus/${pal}`);
  check('la palette n\'a plus de lait', !r.json.hu.contents.some((c) => c.itemId === lait), r.json.hu.contents);
  check('cohérence après préparation', (await coherent()).length === 0, await coherent());

  // ---------- Défaire, supprimer ----------
  r = await mem('DELETE', `${WM}/hus/${box}`);
  check('suppression : réservée aux responsables', r.status === 403, r.status);
  r = await owner('DELETE', `${WM}/hus/${box}`);
  check('suppression : refusée si l\'unité n\'est pas vide', r.status === 400, r.json);
  r = await mem('POST', `${WM}/hus/${box}/unpack`, {});
  check('colis défait : son contenu reste en vrac dans l\'emplacement', r.status === 200, r.json);
  r = await mem('GET', `${WM}/hus/${box}`);
  check('colis vide', r.json.hu.status === 'empty' && r.json.hu.quantity === 0, r.json.hu);
  r = await owner('DELETE', `${WM}/hus/${box}`);
  check('colis vide supprimé', r.status === 200, r.json);
  r = await mem('GET', `${WM}/hus`);
  check('liste : seule la palette en cours', r.json.hus.length === 1 && r.json.hus[0].code === palCode && r.json.types.pallet === 'Palette', r.json);
  r = await mem('GET', `${WM}/hus?itemId=${ciment}`);
  check('liste : filtre par article', r.json.hus.length === 1, r.json);

  // ---------- Étiquette ----------
  r = await mem('GET', `${WM}/hus/${pal}/label`);
  check('étiquette PDF (100 × 150 mm)', r.status === 200 && r.buf.subarray(0, 5).toString() === '%PDF-' && /application\/pdf/.test(r.headers.get('content-type')), r.status);

  r = await owner('GET', `${WM}/reports/moves?kind=internal`);
  check('journal : déplacements de palette', r.json.moves.some((m) => m.label === 'Déplacement de palette'), r.json.moves.slice(0, 3));
  check('cohérence finale (stock, emplacements, palettes)', (await coherent()).length === 0, await coherent());
});
