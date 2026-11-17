'use strict';
// Stock entrepôt (WMS) — poste d'emballage et expéditions.
// Emballage : la marchandise prélevée d'une liste va dans des colis (unités de manutention « box » rattachées à la liste) au poste
// d'emballage (emplacement « Dépose et emballage »), avec poids et dimensions ; un scan de contrôle compare ce qui est emballé à ce qui a été
// prélevé ; la liste de colisage de chaque colis s'imprime en PDF. Expédition : des colis fermés (ou des palettes de colis) sont regroupés,
// avec transporteur, numéro de suivi et quai ; chaque unité est chargée par scan, puis la validation sort le stock, marque les colis
// « expédiés », crée la livraison dans la Logistique et produit le bon de livraison.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const L = require('./stock-lib');
const O = require('./wms-outbound');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const H = () => require('./wms');
const HU = () => require('./wms-hu');
const F = () => require('./wms-flows');
const SHIP_STATUS = { open: 'En préparation', loading: 'Chargement', shipped: 'Expédiée', cancelled: 'Annulée' };

// =====================================================================
// Poste d'emballage
// =====================================================================
async function packPick(req, idv) {
  const p = await F().pickOf(req, idv);
  if (p.status !== 'picked') throw new HttpError(400, p.status === 'issued' ? 'Cette liste est déjà sortie du stock.' : "Terminez d'abord la préparation de cette liste.");
  return p;
}
async function boxOf(req, idv, pick) {
  const h = await HU().huOf(req, idv);
  if (h.type !== 'box' || !h.pick_id) throw new HttpError(400, "Ce n'est pas un colis d'expédition : créez le colis depuis le poste d'emballage.");
  if (pick && Number(h.pick_id) !== Number(pick.id)) throw new HttpError(400, "Ce colis appartient à une autre commande.");
  if (h.status === 'shipped') throw new HttpError(400, 'Ce colis est déjà expédié.');
  return h;
}
const activeShipmentOf = (huId) => db.prepare("SELECT s.* FROM wms_shipment_units u JOIN wms_shipments s ON s.id = u.shipment_id WHERE u.hu_id = ? AND s.status IN ('open','loading')").get(huId);
/** Poste d'emballage d'une liste : choisi, sinon là où la marchandise est déposée, sinon la dépose de la vague ou de l'entrepôt. */
async function stationFor(req, pick, b = {}) {
  if (b.stationId) {
    const l = await W.locationOf(req.org.id, A.id(b.stationId));
    if (l.kind !== 'staging' || !Number(l.active)) throw new HttpError(400, 'Choisissez un emplacement de dépose et emballage actif.');
    return l;
  }
  for (const l of await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ? ORDER BY id').all(pick.id)) for (const e of O.entriesOf(l)) if (!e.huId && e.locationId && (await O.kindOf(e.locationId)) === 'staging') return W.locationOf(req.org.id, e.locationId);
  if (pick.wave_id) { const w = await db.prepare('SELECT staging_location_id FROM wms_waves WHERE id = ?').get(pick.wave_id); if (w && w.staging_location_id) return W.locationOf(req.org.id, w.staging_location_id); }
  const wh = await db.prepare('SELECT l.warehouse_id FROM wms_pick_lines pl JOIN wms_locations l ON l.id = pl.location_id WHERE pl.pick_id = ? LIMIT 1').get(pick.id);
  return W.outboundOf(req.org.id, 'staging', wh ? Number(wh.warehouse_id) : undefined);
}
const dims = (b, h = {}) => {
  const n = (k, col, label) => (b[k] === undefined ? (h[col] === undefined ? null : h[col]) : H().optNum(b[k], { min: 0, max: 100000, msg: `${label} invalide.` }));
  return { weight: n('weight', 'weight', 'Poids'), length: n('length', 'length_cm', 'Longueur'), width: n('width', 'width_cm', 'Largeur'), height: n('height', 'height_cm', 'Hauteur') };
};

async function packView(req, p) {
  const st = await O.packState(p.id);
  const d = p.document_id ? await db.prepare('SELECT d.number, c.name AS customer FROM documents d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = ?').get(p.document_id) : null;
  const boxes = await O.boxesOf(p.id);
  const station = p.status === 'picked' ? await stationFor(req, p) : null;
  return { id: Number(p.id), code: p.code, status: p.status, documentNumber: d ? d.number : null, customer: d ? d.customer : null, label: p.label || null, waveId: p.wave_id ? Number(p.wave_id) : null,
    packedAt: p.packed_at || null, shippedAt: p.shipped_at || null, station: station ? station.code : null, stationId: station ? Number(station.id) : null,
    picked: st.picked, packed: st.packed, toPack: st.toPack, complete: st.picked > W.EPS && st.toPack <= W.EPS,
    items: st.items.map((x) => ({ itemId: x.itemId, name: x.name, unit: x.unit, sku: x.sku, barcode: x.barcode, quantity: x.quantity, picked: x.picked, packed: x.packed, toPack: x.toPack })),
    boxes, weight: r3(boxes.reduce((s, b) => s + (b.weight || 0), 0)) };
}
router.get('/packing', async (req, res) => {
  const rows = await db.prepare(`SELECT p.*, d.number AS doc, c.name AS customer, wv.code AS wave FROM wms_picks p LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN wms_waves wv ON wv.id = p.wave_id
    WHERE p.org_id = ? AND p.status = 'picked' ORDER BY p.packed_at IS NOT NULL, p.priority, p.id LIMIT 300`).all(req.org.id);
  const out = [];
  for (const p of rows) {
    const st = await O.packState(p.id);
    const n = Number((await db.prepare("SELECT COUNT(*) AS c FROM wms_hus WHERE pick_id = ? AND status NOT IN ('empty','shipped')").get(p.id)).c);
    out.push({ id: Number(p.id), code: p.code, documentNumber: p.doc || null, customer: p.customer || null, label: p.label || null, waveCode: p.wave || null, picked: st.picked, packed: st.packed, toPack: st.toPack, boxes: n, packedAt: p.packed_at || null });
  }
  res.json({ picks: out });
});
router.get('/packing/:pickId', async (req, res) => res.json({ pick: await packView(req, await F().pickOf(req, req.params.pickId)) }));
router.post('/packing/:pickId/boxes', async (req, res) => {
  const p = await packPick(req, req.params.pickId);
  const b = req.body || {};
  const station = await stationFor(req, p, b);
  const d = dims(b);
  const box = await db.transaction(async () => {
    const h = await HU().createHu(req, { type: 'box', locationId: station.id, note: cleanText(String(b.note || ''), 200) });
    await db.prepare('UPDATE wms_hus SET pick_id = ?, weight = ?, length_cm = ?, width_cm = ?, height_cm = ? WHERE id = ?').run(p.id, d.weight, d.length, d.width, d.height, h.id);
    return h;
  })();
  res.status(201).json({ id: Number(box.id), code: box.code, station: station.code });
});
/** Met `q` d'un article de la liste dans le colis : la marchandise passe d'abord au poste d'emballage si elle n'y est pas encore. */
async function packInto(req, pick, box, it, q) {
  const st = await O.packState(pick.id);
  const x = st.items.find((i) => i.itemId === Number(it.id));
  if (!x) throw new HttpError(400, `« ${it.name} » ne fait pas partie de cette commande.`);
  if (q > x.toPack + W.EPS) throw new HttpError(400, x.toPack > W.EPS ? `Il ne reste que ${x.toPack} ${it.unit} de « ${it.name} » à emballer.` : `« ${it.name} » est déjà entièrement emballé.`);
  const station = Number(box.location_id);
  let left = r3(q);
  for (const line of st.lines.filter((l) => Number(l.item_id) === Number(it.id))) {
    if (left <= W.EPS) break;
    const entries = O.entriesOf(line);
    const order = entries.map((e, i) => i).sort((a, b) => (Number(entries[a].locationId) === station ? 0 : 1) - (Number(entries[b].locationId) === station ? 0 : 1));
    const add = [];
    for (const i of order) {
      const e = entries[i];
      if (e.huId || left <= W.EPS || !(Number(e.quantity) > W.EPS)) continue;
      if (!e.locationId) throw new HttpError(400, "La marchandise prélevée n'a pas d'emplacement connu : déplacez-la d'abord au poste d'emballage.");
      const t = r3(Math.min(left, Number(e.quantity)));
      if (Number(e.locationId) !== station) {
        const outbound = await O.isOutbound(e.locationId);
        await W.move(req, it.id, e.locationId, station, t, { kind: 'pack', refKind: 'pick', refId: pick.id, reason: `Emballage ${pick.code} · colis ${box.code}` });
        if (!outbound) await O.stageRes(pick.id, it.id, t);
      }
      e.quantity = r3(Number(e.quantity) - t);
      add.push({ locationId: station, quantity: t, huId: Number(box.id) });
      left = r3(left - t);
    }
    await O.saveEntries(line.id, [...entries, ...add]);
  }
  if (left > W.EPS) throw new HttpError(400, `Il ne reste que ${r3(q - left)} ${it.unit} de « ${it.name} » à emballer.`);
  await HU().pack(req, await db.prepare('SELECT * FROM wms_hus WHERE id = ?').get(box.id), it, r3(q), {});
}
router.post('/packing/:pickId/pack', async (req, res) => {
  const p = await packPick(req, req.params.pickId);
  const b = req.body || {};
  const box = await boxOf(req, b.boxId, p);
  let it;
  if (b.itemCode && !b.itemId) { it = await O.itemByCode(req.org.id, b.itemCode); if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article inconnu : ce code ne correspond à aucun article.'); } else it = await H().itemOf(req, b.itemId);
  const st = await O.packState(p.id);
  const x = st.items.find((i) => i.itemId === Number(it.id));
  const q = b.quantity === undefined || b.quantity === null || b.quantity === '' ? (b.itemCode ? 1 : (x ? x.toPack : 0)) : H().qty(b.quantity);
  if (!(q > W.EPS)) throw new HttpError(400, x ? `« ${it.name} » est déjà entièrement emballé.` : `« ${it.name} » ne fait pas partie de cette commande.`);
  await db.transaction(async () => { await packInto(req, p, box, it, q); await require('./wms-pilot').record(req, 'pack', { lines: 1, units: q, refKind: 'pick', refId: p.id }); })();
  const after = await O.packState(p.id);
  res.json({ ok: true, item: it.name, quantity: q, box: box.code, toPack: after.toPack, complete: after.toPack <= W.EPS });
});
router.post('/packing/:pickId/unpack', async (req, res) => {
  const p = await packPick(req, req.params.pickId);
  const b = req.body || {};
  const box = await boxOf(req, b.boxId, p);
  if (box.status === 'closed') throw new HttpError(400, 'Ce colis est fermé : rouvrez-le pour en retirer des articles.');
  const it = await H().itemOf(req, b.itemId);
  const rows = await db.prepare('SELECT * FROM wms_hu_contents WHERE hu_id = ? AND item_id = ? ORDER BY id').all(box.id, it.id);
  const have = r3(rows.reduce((s, c) => s + Number(c.quantity), 0));
  const q = b.quantity === undefined || b.quantity === '' ? have : H().qty(b.quantity);
  if (have + W.EPS < q || !(have > W.EPS)) throw new HttpError(400, `Il n'y a que ${have} ${it.unit} de « ${it.name} » dans ce colis.`);
  await db.transaction(async () => {
    let left = q;
    for (const c of rows) {
      if (left <= W.EPS) break;
      const t = r3(Math.min(left, Number(c.quantity)));
      if (Number(c.quantity) - t <= W.EPS) await db.prepare('DELETE FROM wms_hu_contents WHERE id = ?').run(c.id);
      else await db.prepare('UPDATE wms_hu_contents SET quantity = ? WHERE id = ?').run(r3(Number(c.quantity) - t), c.id);
      left = r3(left - t);
    }
    left = q;
    for (const line of await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ? AND item_id = ? ORDER BY id').all(p.id, it.id)) {
      if (left <= W.EPS) break;
      const entries = O.entriesOf(line); const add = [];
      for (const e of entries) {
        if (Number(e.huId) !== Number(box.id) || left <= W.EPS) continue;
        const t = r3(Math.min(left, Number(e.quantity)));
        e.quantity = r3(Number(e.quantity) - t); add.push({ locationId: Number(box.location_id), quantity: t }); left = r3(left - t);
      }
      await O.saveEntries(line.id, [...entries, ...add]);
    }
    await W.markEmpty(box.id);
  })();
  res.json({ ok: true });
});
router.put('/packing/boxes/:id', async (req, res) => {
  const box = await boxOf(req, req.params.id);
  const d = dims(req.body || {}, box);
  await db.prepare('UPDATE wms_hus SET weight = ?, length_cm = ?, width_cm = ?, height_cm = ?, updated_at = ? WHERE id = ?').run(d.weight, d.length, d.width, d.height, nowISO(), box.id);
  res.json({ ok: true });
});
router.post('/packing/boxes/:id/close', async (req, res) => {
  const box = await boxOf(req, req.params.id);
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM wms_hu_contents WHERE hu_id = ?').get(box.id)).c);
  if (!n) throw new HttpError(400, 'Ce colis est vide : emballez au moins un article avant de le fermer.');
  const d = dims(req.body || {}, box);
  await db.prepare("UPDATE wms_hus SET status = 'closed', weight = ?, length_cm = ?, width_cm = ?, height_cm = ?, updated_at = ? WHERE id = ?").run(d.weight, d.length, d.width, d.height, nowISO(), box.id);
  res.json({ ok: true });
});
router.post('/packing/boxes/:id/reopen', async (req, res) => {
  const box = await boxOf(req, req.params.id);
  const s = await activeShipmentOf(box.id);
  if (s) throw new HttpError(400, `Ce colis est sur l'expédition ${s.code} : retirez-le d'abord de l'expédition.`);
  if (box.parent_id) { const par = await db.prepare('SELECT * FROM wms_hus WHERE id = ?').get(box.parent_id); const s2 = par && await activeShipmentOf(par.id); if (s2) throw new HttpError(400, `Ce colis est sur l'expédition ${s2.code} : retirez-le d'abord de l'expédition.`); }
  await db.prepare("UPDATE wms_hus SET status = 'open', updated_at = ? WHERE id = ?").run(nowISO(), box.id);
  if (box.pick_id) await db.prepare('UPDATE wms_picks SET packed_at = NULL WHERE id = ?').run(box.pick_id);
  res.json({ ok: true });
});
/** Contrôle par scan : chaque code scanné compte pour une unité (ou { code, quantity }). Compare au colis, ou à tout ce qui a été prélevé. */
router.post('/packing/:pickId/verify', async (req, res) => {
  const p = await F().pickOf(req, req.params.pickId);
  const b = req.body || {};
  const list = Array.isArray(b.codes) ? b.codes : [];
  if (!list.length || list.length > 2000) throw new HttpError(400, 'Scannez au moins un article (2000 au plus).');
  const scanned = new Map(); const unknown = []; const cache = new Map();
  for (const x of list) {
    const code = String(typeof x === 'object' && x ? x.code : x || '').trim();
    const q = typeof x === 'object' && x && x.quantity !== undefined ? H().qty(x.quantity) : 1;
    if (!cache.has(code.toUpperCase())) cache.set(code.toUpperCase(), await O.itemByCode(req.org.id, code));
    const it = cache.get(code.toUpperCase());
    if (!it) { unknown.push(code); continue; }
    if (!scanned.has(Number(it.id))) scanned.set(Number(it.id), { itemId: Number(it.id), name: it.name, unit: it.unit, scanned: 0 });
    scanned.get(Number(it.id)).scanned = r3(scanned.get(Number(it.id)).scanned + q);
  }
  const expected = new Map();
  if (b.boxId) {
    const box = await boxOf(req, b.boxId, p);
    for (const c of await db.prepare('SELECT c.item_id, SUM(c.quantity) AS q, i.name, i.unit FROM wms_hu_contents c JOIN stock_items i ON i.id = c.item_id WHERE c.hu_id = ? GROUP BY c.item_id, i.name, i.unit').all(box.id)) expected.set(Number(c.item_id), { itemId: Number(c.item_id), name: c.name, unit: c.unit, expected: r3(c.q) });
  } else for (const x of (await O.packState(p.id)).items) expected.set(x.itemId, { itemId: x.itemId, name: x.name, unit: x.unit, expected: x.picked });
  const keys = new Set([...expected.keys(), ...scanned.keys()]);
  const lines = [...keys].map((k) => { const e = expected.get(k); const s = scanned.get(k); return { itemId: k, name: (e || s).name, unit: (e || s).unit, expected: e ? e.expected : 0, scanned: s ? s.scanned : 0 }; })
    .map((l) => ({ ...l, diff: r3(l.scanned - l.expected) }));
  res.json({ ok: !unknown.length && lines.every((l) => Math.abs(l.diff) <= W.EPS), lines, unknown });
});
/** Fin d'emballage : tout ce qui a été prélevé doit être dans un colis ; les colis encore ouverts sont fermés. */
router.post('/packing/:pickId/finish', async (req, res) => {
  const p = await packPick(req, req.params.pickId);
  const st = await O.packState(p.id);
  if (st.picked <= W.EPS) throw new HttpError(400, "Rien n'a été prélevé sur cette liste.");
  const missing = st.items.filter((x) => x.toPack > W.EPS);
  if (missing.length) throw new HttpError(409, `Tout n'est pas emballé : ${missing.map((x) => `${x.toPack} ${x.unit} de « ${x.name} »`).join(', ')}.`);
  await db.transaction(async () => {
    await db.prepare("UPDATE wms_hus SET status = 'closed', updated_at = ? WHERE pick_id = ? AND status = 'open'").run(nowISO(), p.id);
    await db.prepare('UPDATE wms_picks SET packed_at = ?, packed_by = ? WHERE id = ?').run(nowISO(), req.user.id, p.id);
  })();
  res.json({ ok: true, boxes: (await O.boxesOf(p.id)).length });
});

// ---------- PDF ----------
const pdf = () => require('../services/pdf');
const sendPdf = (res, buf, name) => {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${name}.pdf"` });
  res.end(buf);
};
const fmtDims = (b) => (b.length && b.width && b.height ? `${b.length} × ${b.width} × ${b.height} cm` : '');
router.get('/packing/boxes/:id/packing-list', async (req, res) => {
  const h = await HU().huOf(req, req.params.id);
  if (h.type !== 'box' || !h.pick_id) throw new HttpError(400, "Ce n'est pas un colis d'expédition : créez le colis depuis le poste d'emballage.");
  const p = await db.prepare('SELECT p.*, d.number AS doc, c.name AS customer FROM wms_picks p LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN customers c ON c.id = d.customer_id WHERE p.id = ?').get(h.pick_id);
  let rows = await db.prepare('SELECT c.*, i.name, i.unit, i.sku FROM wms_hu_contents c JOIN stock_items i ON i.id = c.item_id WHERE c.hu_id = ? ORDER BY i.name').all(h.id);
  if (!rows.length && h.status === 'shipped') rows = await db.prepare("SELECT sl.item_id, sl.lot_no, sl.quantity, sl.name, sl.unit, '' AS sku FROM wms_shipment_lines sl WHERE sl.hu_code = ? AND sl.pick_id = ?").all(h.code, h.pick_id);
  const all = await db.prepare("SELECT id FROM wms_hus WHERE pick_id = ? AND status != 'empty' ORDER BY id").all(h.pick_id);
  const n = all.findIndex((x) => Number(x.id) === Number(h.id)) + 1;
  const box = { length: h.length_cm, width: h.width_cm, height: h.height_cm };
  const buf = await pdf().render({
    title: 'Liste de colisage', subtitle: `Colis ${h.code} · ${n} / ${all.length}`, org: req.org.name,
    meta: [['Commande', p.doc || p.label || p.code], ['Client', p.customer || '—'], ['Liste de préparation', p.code], ['Poids', h.weight ? `${h.weight} kg` : '—'], ['Dimensions', fmtDims(box) || '—']],
    blocks: [{ type: 'table', cols: [{ key: 'name', label: 'Article', width: 4 }, { key: 'sku', label: 'Référence', width: 2 }, { key: 'lot', label: 'Lot', width: 2 }, { key: 'q', label: 'Quantité', width: 2, align: 'right' }],
      rows: rows.map((r) => ({ name: r.name, sku: r.sku || '', lot: r.lot_no || '', q: `${r3(r.quantity)} ${r.unit}` })), totals: [['Total', `${r3(rows.reduce((s, r) => s + Number(r.quantity), 0))}`, true]] }],
    footer: `Colis préparé le ${pdf().dfr(String(h.created_at).slice(0, 10))}.`,
  });
  sendPdf(res, buf, `colisage-${h.code}`);
});

// =====================================================================
// Expéditions
// =====================================================================
async function shipmentOf(req, idv) {
  const s = await db.prepare('SELECT * FROM wms_shipments WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!s) throw new HttpError(404, 'Expédition introuvable.');
  return s;
}
const isOpen = (s) => ['open', 'loading'].includes(s.status);
/** Une unité expédiable : colis fermé d'une commande, ou palette / conteneur portant uniquement des colis fermés. */
async function unitCheck(req, hu) {
  if (hu.status === 'shipped') throw new HttpError(400, `${HU().TYPES[hu.type]} ${hu.code} : déjà expédié.`);
  if (hu.parent_id) { const par = await db.prepare('SELECT code FROM wms_hus WHERE id = ?').get(hu.parent_id); throw new HttpError(400, `Le colis ${hu.code} est posé sur ${par ? par.code : 'une palette'} : ajoutez la palette entière.`); }
  const fam = await HU().family(hu.id);
  const rows = await db.prepare(`SELECT * FROM wms_hus WHERE id IN (${fam.map(() => '?').join(',')})`).all(...fam);
  let boxes = 0;
  for (const m of rows) {
    const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM wms_hu_contents WHERE hu_id = ?').get(m.id)).c);
    if (m.pick_id) {
      if (m.status === 'empty' || !n) continue;
      if (m.status !== 'closed') throw new HttpError(400, `Fermez d'abord le colis ${m.code} au poste d'emballage.`);
      boxes++;
    } else if (n) throw new HttpError(400, `${HU().TYPES[m.type]} ${m.code} contient de la marchandise qui n'est emballée pour aucune commande.`);
  }
  if (!boxes) throw new HttpError(400, `${HU().TYPES[hu.type]} ${hu.code} ne contient aucun colis emballé.`);
  const s = await activeShipmentOf(hu.id);
  if (s) throw new HttpError(409, `${HU().TYPES[hu.type]} ${hu.code} est déjà sur l'expédition ${s.code}.`);
  return rows;
}
async function unitFrom(req, b) {
  if (b.huId !== undefined && b.huId !== null && b.huId !== '') return HU().huOf(req, b.huId);
  return HU().huByCode(req, b.huCode || b.code);
}
async function dockFrom(req, b, cur) {
  if (b.dockLocationId === undefined && b.dockCode === undefined) return cur ? cur.dock_location_id : null;
  if (b.dockLocationId === null || b.dockLocationId === '' || b.dockCode === '') return null;
  const l = b.dockLocationId ? await W.locationOf(req.org.id, A.id(b.dockLocationId)) : await db.prepare('SELECT * FROM wms_locations WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, cleanText(String(b.dockCode || ''), 60));
  if (!l) throw new HttpError(404, 'Aucun emplacement avec ce code.');
  if (l.kind !== 'shipping' || !Number(l.active)) throw new HttpError(400, "Choisissez un quai d'expédition actif (emplacement de type « Quai d'expédition »).");
  return Number(l.id);
}
async function carrierFrom(req, b, cur) {
  if (b.carrierId === undefined) return { id: cur ? cur.carrier_id : null, name: b.carrierName === undefined ? (cur ? cur.carrier_name : '') : cleanText(String(b.carrierName || ''), 100) };
  if (b.carrierId === null || b.carrierId === '') return { id: null, name: cleanText(String(b.carrierName || ''), 100) };
  const c = await db.prepare('SELECT * FROM logistics_carriers WHERE id = ? AND org_id = ?').get(A.id(b.carrierId), req.org.id);
  if (!c) throw new HttpError(404, 'Transporteur introuvable.');
  return { id: Number(c.id), name: c.name };
}
async function shipmentView(req, s, { full = false } = {}) {
  const units = await db.prepare('SELECT u.*, h.code, h.type, h.status AS hs, h.weight, l.code AS loc FROM wms_shipment_units u JOIN wms_hus h ON h.id = u.hu_id LEFT JOIN wms_locations l ON l.id = h.location_id WHERE u.shipment_id = ? ORDER BY u.id').all(s.id);
  const dock = s.dock_location_id ? await db.prepare('SELECT code FROM wms_locations WHERE id = ?').get(s.dock_location_id) : null;
  const doc = s.document_id ? await db.prepare('SELECT number FROM documents WHERE id = ?').get(s.document_id) : null;
  const v = { id: Number(s.id), code: s.code, status: s.status, statusLabel: SHIP_STATUS[s.status], carrierId: s.carrier_id ? Number(s.carrier_id) : null, carrier: s.carrier_name || null, tracking: s.tracking || '',
    dockLocationId: s.dock_location_id ? Number(s.dock_location_id) : null, dock: dock ? dock.code : (s.dock || null), dockNote: s.dock || '', customerName: s.customer_name || '', address: s.address || '',
    documentId: s.document_id ? Number(s.document_id) : null, documentNumber: doc ? doc.number : null, plannedDate: s.planned_date || null, note: s.note || '', deliveryId: s.delivery_id ? Number(s.delivery_id) : null,
    units: units.length, loaded: units.filter((u) => Number(u.loaded)).length, createdAt: s.created_at, shippedAt: s.shipped_at || null };
  if (!full) return v;
  const list = [];
  let weight = 0;
  for (const u of units) {
    const fam = await HU().family(u.hu_id);
    const boxes = await db.prepare(`SELECT h.id, h.code, h.weight, h.pick_id, p.code AS pick FROM wms_hus h LEFT JOIN wms_picks p ON p.id = h.pick_id WHERE h.id IN (${fam.map(() => '?').join(',')}) AND h.pick_id IS NOT NULL ORDER BY h.code`).all(...fam);
    const w = r3(Number(u.weight || 0) + boxes.filter((x) => Number(x.id) !== Number(u.hu_id)).reduce((a, x) => a + Number(x.weight || 0), 0));
    weight += w;
    list.push({ huId: Number(u.hu_id), code: u.code, type: u.type, typeLabel: HU().TYPES[u.type], status: u.hs, location: u.loc || null, loaded: Boolean(Number(u.loaded)), loadedAt: u.loaded_at || null, weight: w || null,
      boxes: boxes.map((x) => ({ id: Number(x.id), code: x.code, pick: x.pick || null })) });
  }
  const lines = s.status === 'shipped' ? (await db.prepare('SELECT * FROM wms_shipment_lines WHERE shipment_id = ? ORDER BY hu_code, name').all(s.id)).map((l) => ({ hu: l.hu_code, itemId: l.item_id ? Number(l.item_id) : null, name: l.name, unit: l.unit, lotNo: l.lot_no || null, quantity: r3(l.quantity) })) : [];
  return { ...v, unitList: list, weight: r3(weight), lines };
}
router.get('/shipments', async (req, res) => {
  const st = SHIP_STATUS[req.query.status] ? req.query.status : null;
  const rows = await db.prepare(`SELECT * FROM wms_shipments WHERE org_id = ?${st ? ' AND status = ?' : " AND status != 'cancelled'"} ORDER BY CASE WHEN status IN ('open','loading') THEN 0 ELSE 1 END, id DESC LIMIT 200`).all(req.org.id, ...(st ? [st] : []));
  const out = []; for (const s of rows) out.push(await shipmentView(req, s));
  res.json({ shipments: out, statuses: SHIP_STATUS });
});
/** Unités prêtes à expédier : colis fermés et palettes de colis fermés, hors expédition en cours. */
router.get('/shipments/ready', async (req, res) => {
  const tops = await db.prepare(`SELECT DISTINCT top.* FROM wms_hus b JOIN wms_hus top ON top.id = COALESCE(b.parent_id, b.id) WHERE b.org_id = ? AND b.pick_id IS NOT NULL AND b.status = 'closed' AND top.parent_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM wms_shipment_units u JOIN wms_shipments s ON s.id = u.shipment_id WHERE u.hu_id = top.id AND s.status IN ('open','loading')) ORDER BY top.id LIMIT 300`).all(req.org.id);
  const out = [];
  for (const h of tops) {
    try { await unitCheck(req, h); } catch (e) { if (e instanceof HttpError) continue; throw e; }
    const fam = await HU().family(h.id);
    const info = await db.prepare(`SELECT p.id, p.code, d.number AS doc, c.name AS customer FROM wms_hus x JOIN wms_picks p ON p.id = x.pick_id LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN customers c ON c.id = d.customer_id WHERE x.id IN (${fam.map(() => '?').join(',')}) GROUP BY p.id, p.code, d.number, c.name`).all(...fam);
    const loc = h.location_id ? await db.prepare('SELECT code FROM wms_locations WHERE id = ?').get(h.location_id) : null;
    out.push({ huId: Number(h.id), code: h.code, type: h.type, typeLabel: HU().TYPES[h.type], location: loc ? loc.code : null, weight: h.weight == null ? null : Number(h.weight), orders: info.map((i) => ({ pickId: Number(i.id), pickCode: i.code, documentNumber: i.doc || null, customer: i.customer || null })) });
  }
  res.json({ units: out });
});
router.get('/shipments/:id', async (req, res) => res.json({ shipment: await shipmentView(req, await shipmentOf(req, req.params.id), { full: true }) }));
async function addUnit(req, s, hu) {
  await unitCheck(req, hu);
  await db.prepare('INSERT INTO wms_shipment_units (shipment_id, hu_id) VALUES (?, ?) ON CONFLICT (hu_id) DO UPDATE SET shipment_id = excluded.shipment_id, loaded = 0, loaded_at = NULL, loaded_by = NULL').run(s.id, hu.id);
}
router.post('/shipments', mgr, async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.huIds) ? b.huIds : []; const codes = Array.isArray(b.huCodes) ? b.huCodes : [];
  if (ids.length + codes.length > 200) throw new HttpError(400, '200 unités au plus par expédition.');
  const hus = [];
  for (const x of ids) hus.push(await HU().huOf(req, x));
  for (const x of codes) hus.push(await HU().huByCode(req, x));
  const dock = await dockFrom(req, b, null);
  const carrier = await carrierFrom(req, b, null);
  // Client et commande : ceux de la première unité si non précisés.
  let docId = b.documentId ? Number((await F().documentOf(req, b.documentId)).id) : null;
  let customer = cleanText(String(b.customerName || ''), 100); let address = cleanText(String(b.address || ''), 300);
  if (hus.length && (!docId || !customer)) {
    const fam = await HU().family(hus[0].id);
    const p = await db.prepare(`SELECT p.document_id, c.name, c.address FROM wms_hus x JOIN wms_picks p ON p.id = x.pick_id LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN customers c ON c.id = d.customer_id WHERE x.id IN (${fam.map(() => '?').join(',')}) AND p.document_id IS NOT NULL LIMIT 1`).get(...fam);
    if (p) { docId = docId || Number(p.document_id); customer = customer || p.name || ''; address = address || p.address || ''; }
  }
  const wh = dock ? (await db.prepare('SELECT warehouse_id FROM wms_locations WHERE id = ?').get(dock)).warehouse_id : null;
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'EX');
    const id = Number((await db.prepare("INSERT INTO wms_shipments (org_id, code, status, warehouse_id, dock_location_id, dock, carrier_id, carrier_name, tracking, document_id, customer_name, address, planned_date, note, created_by, created_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(req.org.id, code, wh, dock, cleanText(String(b.dock || ''), 60), carrier.id, carrier.name, cleanText(String(b.tracking || ''), 80), docId, customer, address, A.date(b.plannedDate) || null, cleanText(String(b.note || ''), 500), req.user.id, nowISO())).lastInsertRowid);
    const s = await db.prepare('SELECT * FROM wms_shipments WHERE id = ?').get(id);
    for (const h of hus) await addUnit(req, s, h);
    const cust = docId ? await db.prepare('SELECT customer_id FROM documents WHERE id = ?').get(docId) : null;
    await require('./wms-vas').autoAttach(req, 'shipment', id, { customerId: cust ? cust.customer_id : null });
    return { id, code };
  })();
  res.status(201).json(out);
});
router.put('/shipments/:id', mgr, async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  const b = req.body || {};
  if (!isOpen(s) && Object.keys(b).some((k) => k !== 'tracking')) throw new HttpError(400, 'Cette expédition est terminée : seul le numéro de suivi se modifie encore.');
  const dock = await dockFrom(req, b, s);
  const carrier = await carrierFrom(req, b, s);
  const t = (k, col, max) => (b[k] === undefined ? s[col] : cleanText(String(b[k] || ''), max));
  await db.prepare('UPDATE wms_shipments SET dock_location_id = ?, dock = ?, carrier_id = ?, carrier_name = ?, tracking = ?, customer_name = ?, address = ?, planned_date = ?, note = ? WHERE id = ?')
    .run(dock, t('dock', 'dock', 60), carrier.id, carrier.name, t('tracking', 'tracking', 80), t('customerName', 'customer_name', 100), t('address', 'address', 300), b.plannedDate === undefined ? s.planned_date : A.date(b.plannedDate) || null, t('note', 'note', 500), s.id);
  if (s.delivery_id && b.tracking !== undefined) await db.prepare('UPDATE logistics_deliveries SET tracking = ?, updated_at = ? WHERE id = ?').run(cleanText(String(b.tracking || ''), 80), nowISO(), s.delivery_id);
  res.json({ ok: true });
});
router.post('/shipments/:id/units', async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  if (!isOpen(s)) throw new HttpError(400, 'Cette expédition est terminée ou annulée.');
  const hu = await unitFrom(req, req.body || {});
  await db.transaction(() => addUnit(req, s, hu))();
  res.json({ ok: true, code: hu.code });
});
router.delete('/shipments/:id/units/:huId', async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  if (!isOpen(s)) throw new HttpError(400, 'Cette expédition est terminée ou annulée.');
  const r = await db.prepare('DELETE FROM wms_shipment_units WHERE shipment_id = ? AND hu_id = ?').run(s.id, A.id(req.params.huId));
  if (!r.changes) throw new HttpError(404, "Cette unité n'est pas sur l'expédition.");
  res.json({ ok: true });
});
/** Mise à quai : toutes les unités vont sur le quai de l'expédition. */
async function toDock(req, s, hu) {
  if (!s.dock_location_id || Number(hu.location_id) === Number(s.dock_location_id)) return false;
  const last = Number((await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM wms_moves WHERE org_id = ?').get(req.org.id)).m);
  await HU().moveHu(req, hu, await W.locationOf(req.org.id, s.dock_location_id));
  await db.prepare("UPDATE wms_moves SET kind = 'ship_stage' WHERE org_id = ? AND id > ? AND kind = 'hu_move'").run(req.org.id, last);
  return true;
}
router.post('/shipments/:id/stage', async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  if (!isOpen(s)) throw new HttpError(400, 'Cette expédition est terminée ou annulée.');
  if (!s.dock_location_id) throw new HttpError(400, "Choisissez d'abord le quai d'expédition.");
  let moved = 0;
  await db.transaction(async () => { for (const u of await db.prepare('SELECT * FROM wms_shipment_units WHERE shipment_id = ?').all(s.id)) if (await toDock(req, s, await HU().huOf(req, u.hu_id))) moved++; })();
  res.json({ ok: true, moved });
});
/** Chargement : chaque unité est scannée au quai. Un colis posé sur une palette se charge avec elle. */
router.post('/shipments/:id/load', async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  if (!isOpen(s)) throw new HttpError(400, 'Cette expédition est terminée ou annulée.');
  const hu = await unitFrom(req, req.body || {});
  let u = await db.prepare('SELECT * FROM wms_shipment_units WHERE shipment_id = ? AND hu_id = ?').get(s.id, hu.id);
  if (!u && hu.parent_id) {
    const par = await db.prepare('SELECT * FROM wms_hus WHERE id = ?').get(hu.parent_id);
    if (par && await db.prepare('SELECT 1 FROM wms_shipment_units WHERE shipment_id = ? AND hu_id = ?').get(s.id, par.id)) throw new HttpError(400, `Ce colis est sur la palette ${par.code} : scannez la palette.`);
  }
  if (!u) throw new HttpError(400, `${HU().TYPES[hu.type]} ${hu.code} ne fait pas partie de l'expédition ${s.code}.`);
  if (Number(u.loaded)) return res.json({ ok: true, already: true, code: hu.code, loaded: Number((await db.prepare('SELECT COUNT(*) AS c FROM wms_shipment_units WHERE shipment_id = ? AND loaded = 1').get(s.id)).c) });
  await db.transaction(async () => {
    await toDock(req, s, hu);
    await db.prepare('UPDATE wms_shipment_units SET loaded = 1, loaded_at = ?, loaded_by = ? WHERE id = ?').run(nowISO(), req.user.id, u.id);
    await require('./wms-pilot').record(req, 'load', { lines: 1, units: 0, refKind: 'shipment', refId: s.id });
    await db.prepare("UPDATE wms_shipments SET status = 'loading' WHERE id = ? AND status = 'open'").run(s.id);
  })();
  u = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(loaded), 0) AS l FROM wms_shipment_units WHERE shipment_id = ?').get(s.id);
  res.json({ ok: true, code: hu.code, loaded: Number(u.l), units: Number(u.n) });
});
router.post('/shipments/:id/unload', async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  if (!isOpen(s)) throw new HttpError(400, 'Cette expédition est terminée ou annulée.');
  const hu = await unitFrom(req, req.body || {});
  const r = await db.prepare('UPDATE wms_shipment_units SET loaded = 0, loaded_at = NULL, loaded_by = NULL WHERE shipment_id = ? AND hu_id = ?').run(s.id, hu.id);
  if (!r.changes) throw new HttpError(400, `${HU().TYPES[hu.type]} ${hu.code} ne fait pas partie de l'expédition ${s.code}.`);
  res.json({ ok: true });
});
/** Validation : le stock sort (colis par colis), les unités passent « expédiées », les listes sont soldées, la livraison est créée. */
router.post('/shipments/:id/ship', mgr, async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  if (!isOpen(s)) throw new HttpError(400, 'Cette expédition est terminée ou annulée.');
  const b = req.body || {};
  let units = await db.prepare('SELECT * FROM wms_shipment_units WHERE shipment_id = ? ORDER BY id').all(s.id);
  const notLoaded = units.filter((u) => !Number(u.loaded));
  if (notLoaded.length && !b.allowPartial) throw new HttpError(409, `${notLoaded.length} unité(s) ne sont pas encore chargées. Expédier sans elles ? Elles seront retirées de l'expédition.`);
  units = units.filter((u) => Number(u.loaded));
  if (!units.length) throw new HttpError(400, "Aucune unité n'est chargée : scannez les colis et palettes au quai.");
  // Services à valeur ajoutée obligatoires (étiquetage, contrôle…) : l'expédition attend qu'ils soient faits.
  const shipPicks = new Set();
  for (const u of units) { const fam = await HU().family(u.hu_id); for (const r of await db.prepare(`SELECT DISTINCT pick_id FROM wms_hus WHERE id IN (${fam.map(() => '?').join(',')}) AND pick_id IS NOT NULL`).all(...fam)) shipPicks.add(Number(r.pick_id)); }
  await require('./wms-vas').assertDone(req, { pickIds: [...shipPicks], shipmentId: Number(s.id) });
  const serialLeft = {};
  for (const [k, v] of Object.entries(b.serials || {})) serialLeft[Number(k)] = L.parseSerials(v);
  const result = await db.transaction(async () => {
    for (const u of notLoaded) await db.prepare('DELETE FROM wms_shipment_units WHERE id = ?').run(u.id);
    const picks = new Set(); let lines = 0; const now = nowISO();
    for (const u of units) {
      const hu = await HU().huOf(req, u.hu_id);
      await unitCheck(req, hu).catch((e) => { if (e instanceof HttpError && e.status === 409) return; throw e; });
      const fam = await HU().family(hu.id);
      for (const m of await db.prepare(`SELECT * FROM wms_hus WHERE id IN (${fam.map(() => '?').join(',')}) ORDER BY id`).all(...fam)) {
        const contents = await db.prepare('SELECT c.*, i.name, i.unit, i.tracking FROM wms_hu_contents c JOIN stock_items i ON i.id = c.item_id WHERE c.hu_id = ? ORDER BY c.id').all(m.id);
        for (const c of contents) {
          // Le contenu quitte d'abord le colis : la sortie de stock ne touche ainsi aucun autre colis posé au même endroit.
          await db.prepare('DELETE FROM wms_hu_contents WHERE id = ?').run(c.id);
          let sr;
          if (c.tracking === 'serial') { const all = serialLeft[Number(c.item_id)] || []; sr = all.splice(0, Math.round(Number(c.quantity))); }
          await L.adjust(req, c.item_id, -Number(c.quantity), `Expédition ${s.code} · colis ${m.code}`, { locationId: m.location_id, serials: sr, refKind: 'shipment', refId: s.id });
          await db.prepare('INSERT INTO wms_shipment_lines (shipment_id, hu_code, pick_id, item_id, name, unit, lot_no, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(s.id, m.code, m.pick_id, c.item_id, c.name, c.unit, c.lot_no || '', r3(c.quantity));
          lines++;
        }
        if (m.pick_id) {
          picks.add(Number(m.pick_id));
          for (const l of await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ?').all(m.pick_id)) {
            const e = O.entriesOf(l);
            if (e.some((x) => Number(x.huId) === Number(m.id))) await O.saveEntries(l.id, e.filter((x) => Number(x.huId) !== Number(m.id)));
          }
        }
      }
      await db.prepare(`UPDATE wms_hus SET status = 'shipped', location_id = NULL, updated_at = ? WHERE id IN (${fam.map(() => '?').join(',')})`).run(now, ...fam);
    }
    const closed = [];
    for (const pid of picks) if (await O.closeIfShipped(req, pid)) closed.push(pid);
    // Logistique : la livraison suit l'expédition (le stock est déjà sorti par l'entrepôt : la livraison ne porte pas d'articles).
    let deliveryId = s.delivery_id ? Number(s.delivery_id) : null;
    if (!deliveryId && b.createDelivery !== false) {
      const cust = s.document_id ? await db.prepare('SELECT c.name, c.phone, c.address, d.branch_id FROM documents d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = ?').get(s.document_id) : null;
      const note = `Expédition ${s.code} : ${units.length} unité(s), stock sorti par l'entrepôt.`;
      deliveryId = Number((await db.prepare("INSERT INTO logistics_deliveries (org_id, branch_id, doc_id, customer_name, phone, address, carrier_id, fee, planned_date, status, tracking, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'shipped', ?, ?, ?, ?, ?)")
        .run(req.org.id, cust ? cust.branch_id || null : null, s.document_id, s.customer_name || (cust && cust.name) || 'Client', (cust && cust.phone) || '', s.address || (cust && cust.address) || '', s.carrier_id, s.planned_date, s.tracking || '', note, req.user.id, now, now)).lastInsertRowid);
      await db.prepare('INSERT INTO logistics_events (org_id, delivery_id, status, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, deliveryId, 'shipped', note, req.user.id, now);
    }
    await db.prepare("UPDATE wms_shipments SET status = 'shipped', shipped_at = ?, shipped_by = ?, delivery_id = ? WHERE id = ?").run(now, req.user.id, deliveryId, s.id);
    return { units: units.length, lines, picksClosed: closed.length, deliveryId };
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Expédition ${s.code} validée (${result.units} unité(s))`);
  res.json({ ok: true, ...result });
});
router.post('/shipments/:id/cancel', mgr, async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  if (!isOpen(s)) throw new HttpError(400, 'Cette expédition est terminée ou annulée.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM wms_shipment_units WHERE shipment_id = ?').run(s.id);
    await db.prepare("UPDATE wms_shipments SET status = 'cancelled' WHERE id = ?").run(s.id);
    await db.prepare("UPDATE wms_vas_tasks SET status = 'cancelled', result = 'Expédition annulée' WHERE ref_kind = 'shipment' AND ref_id = ? AND status IN ('open','in_progress')").run(s.id);
  })();
  res.json({ ok: true });
});
router.get('/shipments/:id/delivery-note', async (req, res) => {
  const s = await shipmentOf(req, req.params.id);
  const v = await shipmentView(req, s, { full: true });
  let rows = v.lines;
  if (s.status !== 'shipped') {
    rows = [];
    for (const u of v.unitList) for (const bx of u.boxes) for (const c of await db.prepare('SELECT c.*, i.name, i.unit FROM wms_hu_contents c JOIN stock_items i ON i.id = c.item_id WHERE c.hu_id = ? ORDER BY i.name').all(bx.id)) rows.push({ hu: bx.code, name: c.name, unit: c.unit, lotNo: c.lot_no || null, quantity: r3(c.quantity) });
  }
  const totals = {};
  for (const r of rows) { const k = `${r.name}|${r.unit}`; totals[k] = r3((totals[k] || 0) + r.quantity); }
  const boxes = new Set(rows.map((r) => r.hu)).size;
  const P = pdf();
  const buf = await P.render({
    title: 'Bon de livraison', subtitle: `${s.code}${v.documentNumber ? ' · commande ' + v.documentNumber : ''}`, org: req.org.name,
    meta: [['Client', v.customerName || '—'], ['Adresse', v.address || '—'], ['Transporteur', v.carrier || '—'], ['Numéro de suivi', v.tracking || '—'], ['Quai', v.dock || '—'],
      ['Date', P.dfr(String(s.shipped_at || s.planned_date || s.created_at).slice(0, 10))], ['Colis', `${boxes} colis · ${v.units} unité(s) de chargement${v.weight ? ' · ' + v.weight + ' kg' : ''}`]],
    blocks: [
      { type: 'heading', text: 'Détail par colis' },
      { type: 'table', cols: [{ key: 'hu', label: 'Colis', width: 2 }, { key: 'name', label: 'Article', width: 4 }, { key: 'lot', label: 'Lot', width: 2 }, { key: 'q', label: 'Quantité', width: 2, align: 'right' }],
        rows: rows.map((r) => ({ hu: r.hu, name: r.name, lot: r.lotNo || '', q: `${r.quantity} ${r.unit}` })) },
      { type: 'heading', text: 'Récapitulatif' },
      { type: 'table', cols: [{ key: 'name', label: 'Article', width: 6 }, { key: 'q', label: 'Quantité', width: 2, align: 'right' }], rows: Object.entries(totals).map(([k, q]) => ({ name: k.split('|')[0], q: `${q} ${k.split('|')[1]}` })) },
      { type: 'space' },
      { type: 'kv', rows: [['Remis par', '______________________'], ['Reçu par (nom, date, signature)', '______________________']] },
    ],
    footer: s.status === 'shipped' ? 'Marchandise expédiée : le stock est sorti.' : 'Document provisoire : expédition non encore validée.',
  });
  sendPdf(res, buf, `bon-livraison-${s.code}`);
});

module.exports = router;
