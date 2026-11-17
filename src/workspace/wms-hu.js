'use strict';
// Stock entrepôt (WMS) — unités de manutention : palettes, colis, conteneurs, bacs.
// Une unité a une étiquette scannable (Code 128), un emplacement et un contenu (article, lot, péremption). Son contenu fait partie du stock
// de l'emplacement : on la reçoit, la déplace ou la range EN UN SCAN ; on peut y ajouter, en retirer, l'imbriquer (colis sur palette) ou la défaire.
const express = require('express');
const PDFDocument = require('pdfkit');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const L = require('./stock-lib');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const r3 = W.round3;
const H = () => require('./wms');

const TYPES = { pallet: 'Palette', box: 'Colis', container: 'Conteneur', tote: 'Bac' };
const PREFIX = { pallet: 'PAL', box: 'COL', container: 'CNT', tote: 'BAC' };
const CAN_HOLD = { pallet: ['box', 'tote'], container: ['pallet', 'box', 'tote'], box: [], tote: [] };
const STATUS = { open: 'En cours', empty: 'Vide', closed: 'Fermé', shipped: 'Expédié' };

async function huOf(req, idv) {
  const h = await db.prepare('SELECT * FROM wms_hus WHERE id = ? AND org_id = ?').get(A.id(idv, 'Palette introuvable.'), req.org.id);
  if (!h) throw new HttpError(404, 'Palette introuvable.');
  return h;
}
async function huByCode(req, code) {
  const h = await db.prepare('SELECT * FROM wms_hus WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, cleanText(String(code || ''), 40));
  if (!h) throw new HttpError(404, 'Aucune palette ou colis avec ce code.');
  return h;
}
/** Emplacement de destination : par identifiant ou par code scanné. */
async function locFrom(req, id, code, msg = 'Choisissez un emplacement actif (pas « En transit »).') {
  let l = null;
  if (id !== undefined && id !== null && id !== '') l = await W.locationOf(req.org.id, A.id(id));
  else if (code) l = await db.prepare('SELECT * FROM wms_locations WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, cleanText(String(code), 60));
  if (!l) throw new HttpError(404, 'Aucun emplacement avec ce code.');
  if (!Number(l.active) || l.kind === 'transit') throw new HttpError(400, msg);
  return l;
}
/** L'unité et toutes celles qu'elle contient (colis posés sur la palette…). */
async function family(huId) {
  const out = [huId]; let i = 0;
  while (i < out.length && out.length < 500) { for (const k of await db.prepare('SELECT id FROM wms_hus WHERE parent_id = ?').all(out[i])) out.push(Number(k.id)); i++; }
  return out;
}
const lotKey = (v) => cleanText(String(v || ''), 40);

/** Met `qty` d'un article (stock en vrac de l'emplacement de l'unité) dans l'unité. */
async function pack(req, hu, it, qty, { lotNo = '', expiry = null } = {}) {
  if (hu.status === 'shipped') throw new HttpError(400, 'Ce colis est déjà expédié.');
  if (hu.status === 'closed') throw new HttpError(400, 'Ce colis est fermé : rouvrez-le pour y ajouter des articles.');
  if (!hu.location_id) throw new HttpError(400, "Cette palette n'a pas d'emplacement.");
  await W.lockItem(req.org.id, it.id); // le stock « en vrac » se relit sous le verrou de l'article
  const loose = await W.looseAt(hu.location_id, it.id);
  if (loose + W.EPS < qty) throw new HttpError(400, `Pas assez de « ${it.name} » en vrac dans cet emplacement : ${Math.max(0, loose)} ${it.unit}.`);
  const lot = lotKey(lotNo);
  const ex = expiry || null;
  const cur = await db.prepare('SELECT * FROM wms_hu_contents WHERE hu_id = ? AND item_id = ? AND lot_no = ?').get(hu.id, it.id, lot);
  if (cur) await db.prepare('UPDATE wms_hu_contents SET quantity = ?, expiry = COALESCE(expiry, ?) WHERE id = ?').run(r3(Number(cur.quantity) + qty), ex, cur.id);
  else await db.prepare('INSERT INTO wms_hu_contents (hu_id, item_id, lot_no, expiry, quantity) VALUES (?, ?, ?, ?, ?)').run(hu.id, it.id, lot, ex, qty);
  await db.prepare("UPDATE wms_hus SET status = 'open', updated_at = ? WHERE id = ?").run(nowISO(), hu.id);
}
async function createHu(req, { type, locationId, parentId = null, note = '' }) {
  const code = await nextHuCode(req.org.id, type);
  const now = nowISO();
  const id = Number((await db.prepare("INSERT INTO wms_hus (org_id, code, type, status, location_id, parent_id, note, created_by, created_at, updated_at) VALUES (?, ?, ?, 'empty', ?, ?, ?, ?, ?, ?)")
    .run(req.org.id, code, type, locationId, parentId, note, req.user.id, now, now)).lastInsertRowid);
  return db.prepare('SELECT * FROM wms_hus WHERE id = ?').get(id);
}
async function nextHuCode(orgId, type) {
  const row = await db.prepare("INSERT INTO wms_counters (org_id, kind, n) VALUES (?, 'HU', 1) ON CONFLICT (org_id, kind) DO UPDATE SET n = wms_counters.n + 1 RETURNING n").get(orgId);
  return `${PREFIX[type]}${String(row.n).padStart(8, '0')}`;
}
const typeOf = (v) => (TYPES[v] ? v : 'pallet');
async function readLines(req, list, { allowEmpty = false } = {}) {
  if (!Array.isArray(list) || list.length > 100) throw new HttpError(400, 'Ajoutez au moins une ligne (100 au plus).');
  if (!list.length && !allowEmpty) throw new HttpError(400, 'Ajoutez au moins une ligne (100 au plus).');
  const out = [];
  for (const x of list) {
    const it = await H().itemOf(req, x && x.itemId);
    out.push({ it, quantity: H().qty(x.quantity), lotNo: lotKey(x.lotNo), expiry: A.date(x.expiry) || null, unitCost: x.unitCost, serials: x.serials });
  }
  return out;
}

// ---------- Lecture ----------
async function huView(h) {
  const c = await db.prepare('SELECT COUNT(DISTINCT item_id) AS n, COALESCE(SUM(quantity), 0) AS q FROM wms_hu_contents WHERE hu_id = ?').get(h.id);
  const kids = Number((await db.prepare('SELECT COUNT(*) AS c FROM wms_hus WHERE parent_id = ?').get(h.id)).c);
  return { id: Number(h.id), code: h.code, type: h.type, typeLabel: TYPES[h.type], status: h.status, statusLabel: STATUS[h.status] || h.status, locationId: h.location_id ? Number(h.location_id) : null, location: h.loc || null, warehouse: h.wh || null,
    parentId: h.parent_id ? Number(h.parent_id) : null, parentCode: h.parent_code || null, pickId: h.pick_id ? Number(h.pick_id) : null,
    weight: h.weight === null || h.weight === undefined ? null : Number(h.weight), length: h.length_cm == null ? null : Number(h.length_cm), width: h.width_cm == null ? null : Number(h.width_cm), height: h.height_cm == null ? null : Number(h.height_cm), items: Number(c.n), quantity: r3(Number(c.q)), children: kids, note: h.note || '', createdAt: h.created_at, updatedAt: h.updated_at };
}
const BASE = `SELECT h.*, l.code AS loc, w.name AS wh, p.code AS parent_code FROM wms_hus h LEFT JOIN wms_locations l ON l.id = h.location_id LEFT JOIN wms_warehouses w ON w.id = l.warehouse_id LEFT JOIN wms_hus p ON p.id = h.parent_id`;
router.get('/hus', async (req, res) => {
  const q = req.query || {};
  let where = ' WHERE h.org_id = ?'; const args = [req.org.id];
  if (q.status === 'empty') where += " AND h.status = 'empty'"; else if (q.status === 'shipped') where += " AND h.status = 'shipped'"; else if (q.status !== 'all') where += " AND h.status NOT IN ('empty','shipped')";
  if (q.locationId) { where += ' AND h.location_id = ?'; args.push(A.id(q.locationId)); }
  if (TYPES[q.type]) { where += ' AND h.type = ?'; args.push(q.type); }
  if (q.itemId) { where += ' AND EXISTS (SELECT 1 FROM wms_hu_contents c WHERE c.hu_id = h.id AND c.item_id = ?)'; args.push(A.id(q.itemId)); }
  const rows = await db.prepare(`${BASE}${where} ORDER BY h.id DESC LIMIT 500`).all(...args);
  const out = []; for (const h of rows) out.push(await huView(h));
  res.json({ hus: out, types: TYPES, counts: { open: out.filter((h) => h.status === 'open').length } });
});
router.get('/hus/lookup', async (req, res) => { const h = await huByCode(req, req.query.code); res.json({ hu: { id: Number(h.id), code: h.code } }); });
router.get('/hus/:id', async (req, res) => {
  const h = await db.prepare(`${BASE} WHERE h.id = ? AND h.org_id = ?`).get(A.id(req.params.id), req.org.id);
  if (!h) throw new HttpError(404, 'Palette introuvable.');
  const m = A.can(req, 'manager');
  const contents = await db.prepare('SELECT c.*, i.name, i.unit, i.sku, i.avg_cost, i.unit_cost FROM wms_hu_contents c JOIN stock_items i ON i.id = c.item_id WHERE c.hu_id = ? ORDER BY i.name, c.expiry').all(h.id);
  const kids = await db.prepare('SELECT * FROM wms_hus WHERE parent_id = ? ORDER BY code').all(h.id);
  const hist = await db.prepare("SELECT wm.*, f.code AS fc, t.code AS tc, u.name AS who FROM wms_moves wm LEFT JOIN wms_locations f ON f.id = wm.from_location_id LEFT JOIN wms_locations t ON t.id = wm.to_location_id LEFT JOIN users u ON u.id = wm.created_by WHERE wm.ref_kind = 'hu' AND wm.ref_id = ? ORDER BY wm.id DESC LIMIT 50").all(h.id);
  res.json({ hu: {
    ...(await huView(h)),
    contents: contents.map((c) => ({ itemId: Number(c.item_id), name: c.name, sku: c.sku || '', unit: c.unit, lotNo: c.lot_no || null, expiry: c.expiry || null, quantity: r3(Number(c.quantity)), value: m ? Math.round(Number(c.quantity) * L.unitValue(c)) : undefined })),
    children: kids.map((k) => ({ id: Number(k.id), code: k.code, type: k.type, typeLabel: TYPES[k.type], status: k.status })),
    history: hist.map((x) => ({ at: x.created_at, from: x.fc || null, to: x.tc || null, by: x.who || null, reason: x.reason || null })),
  } });
});

// ---------- Création ----------
router.post('/hus', async (req, res) => {
  const b = req.body || {};
  const type = typeOf(b.type);
  const loc = await locFrom(req, b.locationId, b.locationCode);
  const lines = await readLines(req, b.lines || [], { allowEmpty: true });
  let parent = null;
  if (b.parentId) { parent = await huOf(req, b.parentId); if (!CAN_HOLD[parent.type].includes(type)) throw new HttpError(400, `Un ${TYPES[type].toLowerCase()} ne se pose pas dans ${TYPES[parent.type].toLowerCase() === 'palette' ? 'une palette' : 'ce contenant'}.`); if (Number(parent.location_id) !== Number(loc.id)) throw new HttpError(400, "La palette d'accueil est dans un autre emplacement."); }
  const hu = await db.transaction(async () => {
    const h = await createHu(req, { type, locationId: loc.id, parentId: parent ? parent.id : null, note: cleanText(String(b.note || ''), 200) });
    for (const l of lines) await pack(req, h, l.it, l.quantity, l);
    if (parent) await W.markEmpty(parent.id);
    return h;
  })();
  res.status(201).json({ id: Number(hu.id), code: hu.code });
});
/** Réception directe sur une nouvelle palette : la marchandise entre en stock à l'emplacement choisi et se range sur la palette. */
router.post('/hus/receive', async (req, res) => {
  const b = req.body || {};
  const type = typeOf(b.type);
  const loc = b.locationId || b.locationCode ? await locFrom(req, b.locationId, b.locationCode) : await W.defaultOf(req.org.id);
  const lines = await readLines(req, b.lines);
  if (lines.some((l) => l.unitCost !== undefined && l.unitCost !== '') && !A.can(req, 'manager')) throw new HttpError(403, 'Seul un responsable peut valoriser une entrée.');
  const ref = cleanText(String(b.reference || ''), 80);
  const crossDock = [];
  const hu = await db.transaction(async () => {
    const h = await createHu(req, { type, locationId: loc.id, note: ref });
    for (const l of lines) {
      const cost = l.unitCost === undefined || l.unitCost === '' ? undefined : A.amount(l.unitCost);
      await L.adjust(req, l.it, l.quantity, `Réception sur ${TYPES[type].toLowerCase()} ${h.code}${ref ? ' (' + ref + ')' : ''}`, { unitCost: cost, lotNo: l.lotNo, expiry: l.expiry || undefined, serials: l.serials, strict: true, locationId: loc.id, refKind: 'hu', refId: h.id });
      await pack(req, h, l.it, l.quantity, l);
      crossDock.push(...await require('./wms-xdock').onReceipt(req, { itemId: l.it.id, quantity: l.quantity, locationId: loc.id, huId: h.id, sourceKind: 'hu', sourceId: h.id, sourceCode: h.code }));
    }
    await require('./wms-pilot').record(req, 'receive', { lines: lines.length, units: lines.reduce((s, l) => s + Number(l.quantity), 0), refKind: 'hu', refId: h.id });
    return h;
  })();
  res.status(201).json({ id: Number(hu.id), code: hu.code, location: loc.code, crossDock });
});

// ---------- Déplacement en un scan (avec les colis posés dessus) ----------
async function moveHu(req, hu, to) {
  if (Number(hu.location_id) === Number(to.id)) throw new HttpError(400, "L'emplacement de départ et celui d'arrivée sont identiques.");
  const from = hu.location_id;
  const ids = await family(hu.id);
  const contents = await db.prepare(`SELECT item_id, SUM(quantity) AS q FROM wms_hu_contents WHERE hu_id IN (${ids.map(() => '?').join(',')}) GROUP BY item_id`).all(...ids);
  // L'unité change d'emplacement AVANT le stock : ainsi le contenu ne compte plus comme « posé » au départ et rien n'est retiré de la palette.
  await db.prepare(`UPDATE wms_hus SET location_id = ?, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(to.id, nowISO(), ...ids);
  // Une ligne « hu » par opération (historique de la palette) ; les autres articles du même déplacement sont notés « hu_item ».
  let first = true;
  for (const c of contents) if (Number(c.q) > W.EPS) { await W.move(req, c.item_id, from, to.id, Number(c.q), { kind: 'hu_move', refKind: first ? 'hu' : 'hu_item', refId: hu.id, reason: `${TYPES[hu.type]} ${hu.code}` }); first = false; }
}
router.post('/hus/:id/move', async (req, res) => {
  const hu = await huOf(req, req.params.id);
  if (hu.status === 'shipped') throw new HttpError(400, 'Ce colis est déjà expédié.');
  if (hu.parent_id) throw new HttpError(400, `Ce ${TYPES[hu.type].toLowerCase()} est posé sur une palette : déplacez la palette, ou retirez-le d'abord.`);
  const b = req.body || {};
  const to = await locFrom(req, b.toLocationId, b.toLocationCode);
  await db.transaction(async () => {
    const cur = await W.lockRow('wms_hus', hu.id); // deux déplacements simultanés de la même palette : un seul part de l'emplacement d'origine
    if (cur.parent_id) throw new HttpError(400, `Ce ${TYPES[cur.type].toLowerCase()} est posé sur une palette : déplacez la palette, ou retirez-le d'abord.`);
    const from = cur.location_id ? await db.prepare('SELECT kind FROM wms_locations WHERE id = ?').get(cur.location_id) : null;
    await moveHu(req, cur, to);
    await require('./wms-pilot').record(req, from && from.kind === 'reception' ? 'putaway' : 'move', { lines: 1, units: 0, refKind: 'hu', refId: cur.id });
  })();
  res.json({ ok: true, to: to.code });
});

// ---------- Contenu ----------
const packingGuard = (hu) => { if (hu.pick_id) throw new HttpError(400, "Ce colis appartient à une commande : modifiez-le depuis le poste d'emballage."); };
router.post('/hus/:id/add', async (req, res) => {
  const hu = await huOf(req, req.params.id);
  packingGuard(hu);
  const b = req.body || {};
  const it = await H().itemOf(req, b.itemId);
  await db.transaction(() => pack(req, hu, it, H().qty(b.quantity), { lotNo: b.lotNo, expiry: A.date(b.expiry) || null }))();
  res.json({ ok: true });
});
router.post('/hus/:id/remove', async (req, res) => {
  const hu = await huOf(req, req.params.id);
  packingGuard(hu);
  const b = req.body || {};
  const it = await H().itemOf(req, b.itemId);
  const q = H().qty(b.quantity);
  const rows = await db.prepare('SELECT * FROM wms_hu_contents WHERE hu_id = ? AND item_id = ?' + (b.lotNo !== undefined && b.lotNo !== '' ? ' AND lot_no = ?' : '') + ' ORDER BY expiry IS NULL, expiry, id').all(hu.id, it.id, ...(b.lotNo !== undefined && b.lotNo !== '' ? [lotKey(b.lotNo)] : []));
  const have = r3(rows.reduce((s, c) => s + Number(c.quantity), 0));
  if (have + W.EPS < q) throw new HttpError(400, `Il n'y a que ${have} ${it.unit} de « ${it.name} » sur cette palette.`);
  await db.transaction(async () => {
    let left = q;
    for (const c of rows) {
      if (left <= W.EPS) break;
      const t = r3(Math.min(left, Number(c.quantity)));
      if (Number(c.quantity) - t <= W.EPS) await db.prepare('DELETE FROM wms_hu_contents WHERE id = ?').run(c.id);
      else await db.prepare('UPDATE wms_hu_contents SET quantity = ? WHERE id = ?').run(r3(Number(c.quantity) - t), c.id);
      left = r3(left - t);
    }
    await W.markEmpty(hu.id);
  })();
  res.json({ ok: true });
});
/** Défaire l'unité : tout son contenu redevient du stock en vrac au même emplacement (les colis posés dessus sont détachés). */
router.post('/hus/:id/unpack', async (req, res) => {
  const hu = await huOf(req, req.params.id);
  packingGuard(hu);
  await db.transaction(async () => {
    await db.prepare('DELETE FROM wms_hu_contents WHERE hu_id = ?').run(hu.id);
    await db.prepare('UPDATE wms_hus SET parent_id = NULL, updated_at = ? WHERE parent_id = ?').run(nowISO(), hu.id);
    await W.markEmpty(hu.id);
    if (hu.parent_id) await W.markEmpty(hu.parent_id);
  })();
  res.json({ ok: true });
});
router.post('/hus/:id/nest', async (req, res) => {
  const hu = await huOf(req, req.params.id);
  const b = req.body || {};
  const parent = b.parentId ? await huOf(req, b.parentId) : await huByCode(req, b.parentCode);
  if (hu.status === 'shipped' || parent.status === 'shipped') throw new HttpError(400, 'Ce colis est déjà expédié.');
  if (Number(parent.id) === Number(hu.id) || (await family(hu.id)).includes(Number(parent.id))) throw new HttpError(400, 'Une palette ne peut pas être posée sur elle-même.');
  if (!CAN_HOLD[parent.type].includes(hu.type)) throw new HttpError(400, `Un ${TYPES[hu.type].toLowerCase()} ne se pose pas sur ce contenant (${TYPES[parent.type].toLowerCase()}).`);
  await db.transaction(async () => {
    const cur = await W.lockRow('wms_hus', hu.id);
    if (Number(parent.location_id) !== Number(cur.location_id)) await moveHu(req, cur, await W.locationOf(req.org.id, parent.location_id));
    await db.prepare('UPDATE wms_hus SET parent_id = ?, updated_at = ? WHERE id = ?').run(parent.id, nowISO(), hu.id);
    await W.markEmpty(parent.id);
    if (hu.parent_id) await W.markEmpty(hu.parent_id);
  })();
  res.json({ ok: true, parent: parent.code });
});
router.post('/hus/:id/unnest', async (req, res) => {
  const hu = await huOf(req, req.params.id);
  if (!hu.parent_id) return res.json({ ok: true });
  await db.prepare('UPDATE wms_hus SET parent_id = NULL, updated_at = ? WHERE id = ?').run(nowISO(), hu.id);
  await W.markEmpty(hu.parent_id);
  res.json({ ok: true });
});
router.delete('/hus/:id', A.need('manager'), async (req, res) => {
  const hu = await huOf(req, req.params.id);
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM wms_hu_contents WHERE hu_id = ?').get(hu.id)).c);
  if (n) throw new HttpError(400, "Cette palette n'est pas vide : défaites-la d'abord (le stock reste dans l'emplacement).");
  await db.prepare('UPDATE wms_hus SET parent_id = NULL WHERE parent_id = ?').run(hu.id);
  await db.prepare('DELETE FROM wms_hus WHERE id = ?').run(hu.id);
  res.json({ ok: true });
});

// ---------- Étiquette (Code 128, jeu B) ----------
const { code128 } = require('../services/code128');
function labelPdf({ code, typeLabel, org, location, lines, created }) {
  return new Promise((resolve, reject) => {
    const W2 = 283; const H2 = 425; // 100 × 150 mm
    const doc = new PDFDocument({ size: [W2, H2], margin: 14, info: { Title: code, Creator: 'Brij-IA' } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const clean = require('../services/pdf').clean;
    doc.font('Helvetica-Bold').fontSize(16).text(clean(`${typeLabel} ${code}`), 14, 14, { width: W2 - 28 });
    doc.font('Helvetica').fontSize(9).fillColor('#444').text(clean(`${org}${location ? ' · Emplacement ' + location : ''}`), { width: W2 - 28 });
    // Code-barres : largeur totale ajustée à la page, zones blanches de 10 modules de chaque côté.
    const widths = code128(code).split('').map(Number);
    const modules = widths.reduce((s, x) => s + x, 0) + 20;
    const mod = (W2 - 28) / modules; let x = 14 + 10 * mod; const y = 70;
    doc.fillColor('#000');
    widths.forEach((w, i) => { if (i % 2 === 0) doc.rect(x, y, w * mod, 90).fill(); x += w * mod; });
    doc.font('Courier-Bold').fontSize(14).text(code, 14, y + 96, { width: W2 - 28, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(10).text('Contenu', 14, y + 125);
    doc.font('Helvetica').fontSize(9);
    for (const l of lines.slice(0, 14)) doc.text(clean(`${l.quantity} ${l.unit}  ${l.name}${l.lotNo ? '  · lot ' + l.lotNo : ''}${l.expiry ? '  · pér. ' + l.expiry.split('-').reverse().join('/') : ''}`), { width: W2 - 28 });
    if (lines.length > 14) doc.text(clean(`… et ${lines.length - 14} autre(s) ligne(s)`));
    doc.fontSize(7).fillColor('#666').text(clean(`Créée le ${String(created).slice(0, 10).split('-').reverse().join('/')}`), 14, H2 - 26);
    doc.end();
  });
}
router.get('/hus/:id/label', async (req, res) => {
  const h = await db.prepare(`${BASE} WHERE h.id = ? AND h.org_id = ?`).get(A.id(req.params.id), req.org.id);
  if (!h) throw new HttpError(404, 'Palette introuvable.');
  const lines = (await db.prepare('SELECT c.*, i.name, i.unit FROM wms_hu_contents c JOIN stock_items i ON i.id = c.item_id WHERE c.hu_id = ? ORDER BY i.name').all(h.id)).map((c) => ({ name: c.name, unit: c.unit, quantity: r3(Number(c.quantity)), lotNo: c.lot_no, expiry: c.expiry }));
  const buf = await labelPdf({ code: h.code, typeLabel: TYPES[h.type], org: req.org.name, location: h.loc, lines, created: h.created_at });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${h.code}.pdf"` });
  res.end(buf);
});

module.exports = router;
Object.assign(module.exports, { TYPES, STATUS, huOf, huByCode, locFrom, family, pack, createHu, moveHu, huView, labelPdf });
