'use strict';
// Stock entrepôt (WMS) — kits et assemblage.
// Un kit est une nomenclature de la Production (production_boms, colonne kit = 1) : produit fini + composants et quantités. Toute nomenclature
// de la Production peut aussi servir à un ordre d'assemblage (aucune définition en double).
// Ordre d'assemblage : à la création, les composants sont mis de côté (réservation « kit ») ; à l'exécution, ils sortent des emplacements
// utilisables de l'entrepôt (préparation, rayonnage, réception — jamais le stock déjà promis à une liste de préparation), lots dans l'ordre FEFO,
// numéros de série saisis ; le kit entre en stock à son coût réel = somme des coûts des composants consommés (coût du lot, sinon CUMP)
// + main-d'œuvre (celle de la nomenclature, ou saisie). Un kit suivi par lot reçoit un lot (par défaut le code de l'ordre) qui prend la
// péremption la plus proche de ses composants. Désassemblage : l'inverse ; la valeur du kit se répartit sur les composants au prorata de leur valeur.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const L = require('./stock-lib');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const H = () => require('./wms');
const KIND = { assembly: 'Assemblage', disassembly: 'Désassemblage' };
const STATUS = { planned: 'Planifié', done: 'Terminé', cancelled: 'Annulé' };

// ---------- Définitions (nomenclatures) ----------
async function bomOf(req, idv) {
  const b = await db.prepare('SELECT b.*, i.name AS product, i.unit, i.tracking, i.branch_id FROM production_boms b JOIN stock_items i ON i.id = b.product_id WHERE b.id = ? AND b.org_id = ?').get(A.id(idv, 'Kit introuvable.'), req.org.id);
  if (!b || !A.visible(req, b)) throw new HttpError(404, 'Kit introuvable.');
  return b;
}
const bomLines = (bomId) => db.prepare('SELECT i.*, l.item_id, l.quantity AS per_unit FROM production_bom_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.bom_id = ? ORDER BY l.id').all(bomId);
async function kitView(req, b) {
  const m = A.can(req, 'manager');
  const lines = await bomLines(b.id);
  const comps = [];
  let buildable = lines.length ? Infinity : 0; let material = 0;
  for (const l of lines) {
    const av = Math.max(0, (await W.availability(Number(l.item_id))).available);
    buildable = Math.min(buildable, Math.floor(av / Number(l.per_unit) + 1e-9));
    material += Number(l.per_unit) * L.unitValue(l);
    comps.push({ itemId: Number(l.item_id), name: l.name, unit: l.unit, tracking: l.tracking || 'none', quantity: r3(l.per_unit), available: r3(av), unitValue: m ? Math.round(L.unitValue(l)) : undefined });
  }
  const labor = Number(b.labor_cost) + Number(b.other_cost);
  return { id: Number(b.id), productId: Number(b.product_id), product: b.product, unit: b.unit, tracking: b.tracking || 'none', kit: Boolean(Number(b.kit)), notes: b.notes || '',
    laborCost: m ? Number(b.labor_cost) : undefined, otherCost: m ? Number(b.other_cost) : undefined, unitCost: m ? Math.round(material + labor) : undefined,
    buildable: Number.isFinite(buildable) ? buildable : 0, components: comps };
}
router.get('/kits', async (req, res) => {
  const rows = await db.prepare('SELECT b.*, i.name AS product, i.unit, i.tracking, i.branch_id FROM production_boms b JOIN stock_items i ON i.id = b.product_id WHERE b.org_id = ? ORDER BY b.kit DESC, i.name').all(req.org.id);
  const out = []; for (const b of rows) if (A.visible(req, b)) out.push(await kitView(req, b));
  res.json({ kits: out });
});
router.get('/kits/:id', async (req, res) => res.json({ kit: await kitView(req, await bomOf(req, req.params.id)) }));
async function readComponents(req, productId, list) {
  if (!Array.isArray(list) || !list.length || list.length > 40) throw new HttpError(400, 'Ajoutez au moins un composant (40 au plus).');
  const seen = new Set(); const out = [];
  for (const x of list) {
    const it = await H().itemOf(req, x && x.itemId);
    if (Number(it.id) === Number(productId)) throw new HttpError(400, 'Le kit ne peut pas être son propre composant.');
    if (seen.has(Number(it.id))) throw new HttpError(400, `« ${it.name} » apparaît deux fois : regroupez les quantités.`);
    seen.add(Number(it.id));
    out.push({ itemId: Number(it.id), quantity: H().qty(x.quantity) });
  }
  return out;
}
const money = (v) => (v === undefined || v === null || v === '' ? 0 : A.amount(v));
router.post('/kits', mgr, async (req, res) => {
  const b = req.body || {};
  const product = await H().itemOf(req, b.productId);
  if (await db.prepare('SELECT 1 FROM production_boms WHERE product_id = ?').get(product.id)) throw new HttpError(400, 'Cet article a déjà une nomenclature (Production) : elle sert aussi de kit.');
  const lines = await readComponents(req, product.id, b.lines);
  const id = await db.transaction(async () => {
    const bid = Number((await db.prepare('INSERT INTO production_boms (org_id, product_id, labor_cost, other_cost, notes, created_at, kit) VALUES (?, ?, ?, 0, ?, ?, 1)').run(req.org.id, product.id, money(b.laborCost), A.text(b.notes, 500), nowISO())).lastInsertRowid);
    for (const l of lines) await db.prepare('INSERT INTO production_bom_lines (org_id, bom_id, item_id, quantity) VALUES (?, ?, ?, ?)').run(req.org.id, bid, l.itemId, l.quantity);
    return bid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Kit « ${product.name} » créé`);
  res.status(201).json({ id });
});
router.put('/kits/:id', mgr, async (req, res) => {
  const k = await bomOf(req, req.params.id);
  if (!Number(k.kit)) throw new HttpError(400, 'Cette nomenclature vient de la Production : modifiez-la dans le module Production.');
  const b = req.body || {};
  const lines = b.lines === undefined ? null : await readComponents(req, k.product_id, b.lines);
  await db.transaction(async () => {
    await db.prepare('UPDATE production_boms SET labor_cost = ?, notes = ? WHERE id = ?').run(b.laborCost === undefined ? k.labor_cost : money(b.laborCost), b.notes === undefined ? k.notes : A.text(b.notes, 500), k.id);
    if (lines) {
      await db.prepare('DELETE FROM production_bom_lines WHERE bom_id = ?').run(k.id);
      for (const l of lines) await db.prepare('INSERT INTO production_bom_lines (org_id, bom_id, item_id, quantity) VALUES (?, ?, ?, ?)').run(req.org.id, k.id, l.itemId, l.quantity);
    }
  })();
  res.json({ ok: true });
});
router.delete('/kits/:id', mgr, async (req, res) => {
  const k = await bomOf(req, req.params.id);
  if (!Number(k.kit)) throw new HttpError(400, 'Cette nomenclature vient de la Production : modifiez-la dans le module Production.');
  if (await db.prepare("SELECT 1 FROM wms_kit_orders WHERE bom_id = ? AND status = 'planned'").get(k.id)) throw new HttpError(400, "Des ordres d'assemblage en cours utilisent ce kit : terminez-les ou annulez-les d'abord.");
  if (await db.prepare("SELECT 1 FROM production_orders WHERE bom_id = ? AND status IN ('draft','launched')").get(k.id)) throw new HttpError(400, "Des ordres de fabrication en cours utilisent cette nomenclature : annulez-les d'abord.");
  await db.prepare('DELETE FROM production_boms WHERE id = ?').run(k.id);
  res.json({ ok: true });
});

// ---------- Ordres d'assemblage / désassemblage ----------
async function orderOf(req, idv) {
  const o = await db.prepare('SELECT * FROM wms_kit_orders WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!o) throw new HttpError(404, "Ordre d'assemblage introuvable.");
  return o;
}
const json = (v, d) => { try { const x = JSON.parse(v); return x == null ? d : x; } catch { return d; } };
/** Ce que l'ordre consomme (sortie) : composants pour un assemblage, le kit pour un désassemblage. [{ itemId, name, unit, perUnit }]. */
function inputsOf(o) {
  if (o.kind === 'assembly') return json(o.components, []);
  return [{ itemId: Number(o.product_id), perUnit: 1 }];
}
const holdLabel = (o) => o.code;
const releaseHolds = (o) => db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = ? WHERE org_id = ? AND source_kind = 'kit' AND label = ? AND status = 'active'").run(`Ordre ${o.code}`, o.org_id, holdLabel(o));
/** Emplacements utilisables de l'entrepôt d'où prendre `need` (préparation, rayonnage, réception), hors stock promis aux listes en cours. */
async function plan(itemId, need, warehouseId) {
  const rows = await db.prepare(`SELECT s.location_id, s.quantity, l.code FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND s.quantity > 0 AND l.active = 1 AND l.kind IN ('picking','storage','reception')${warehouseId ? ' AND l.warehouse_id = ?' : ''}
    ORDER BY CASE l.kind WHEN 'picking' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END, l.aisle, l.rack, l.bin, l.code`).all(itemId, ...(warehouseId ? [warehouseId] : []));
  let left = r3(need); const out = [];
  for (const s of rows) {
    if (left <= W.EPS) break;
    const held = r3(Number((await db.prepare("SELECT COALESCE(SUM(pl.quantity - pl.picked_qty), 0) AS q FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id WHERE pl.location_id = ? AND pl.item_id = ? AND pl.done = 0 AND p.status IN ('open','in_progress')").get(s.location_id, itemId)).q));
    const q = r3(Math.min(left, Number(s.quantity) - held));
    if (q <= W.EPS) continue;
    out.push({ locationId: Number(s.location_id), code: s.code, quantity: q }); left = r3(left - q);
  }
  return { plan: out, short: r3(Math.max(0, left)) };
}
/** Lots qui seraient pris (FEFO ou FIFO, hors périmés) : aperçu seulement. */
async function lotPreview(it, qty) {
  if (it.tracking !== 'lot') return [];
  const order = it.pick_rule === 'fifo' ? 'received_at, id' : 'expiry IS NULL, expiry, received_at, id';
  const rows = (await db.prepare(`SELECT * FROM stock_lots WHERE item_id = ? AND quantity > 0 ORDER BY ${order}`).all(it.id)).filter((l) => !l.expiry || l.expiry >= W.today());
  let left = qty; const out = [];
  for (const l of rows) { if (left <= W.EPS) break; const t = r3(Math.min(left, Number(l.quantity))); out.push({ lotNo: l.lot_no, expiry: l.expiry || null, quantity: t }); left = r3(left - t); }
  return out;
}
async function orderView(req, o, { full = false } = {}) {
  const m = A.can(req, 'manager');
  const p = await db.prepare('SELECT name, unit, tracking FROM stock_items WHERE id = ?').get(o.product_id);
  const wh = o.warehouse_id ? await db.prepare('SELECT name FROM wms_warehouses WHERE id = ?').get(o.warehouse_id) : null;
  const loc = o.location_id ? await db.prepare('SELECT code FROM wms_locations WHERE id = ?').get(o.location_id) : null;
  const who = o.done_by ? await db.prepare('SELECT name FROM users WHERE id = ?').get(o.done_by) : null;
  const v = { id: Number(o.id), code: o.code, kind: o.kind, kindLabel: KIND[o.kind], status: o.status, statusLabel: STATUS[o.status], bomId: o.bom_id ? Number(o.bom_id) : null, productId: Number(o.product_id), product: p ? p.name : '', unit: p ? p.unit : '',
    quantity: r3(o.quantity), doneQty: r3(o.done_qty), remaining: r3(Number(o.quantity) - Number(o.done_qty)), warehouse: wh ? wh.name : null, location: loc ? loc.code : null, lotNo: o.lot_no || null, note: o.note || '',
    materialCost: m ? Math.round(Number(o.material_cost)) : undefined, laborCost: m ? (Number(o.done_qty) > 0 ? Math.round(Number(o.total_cost) - Number(o.material_cost)) : o.labor_cost != null ? Math.round(Number(o.labor_cost)) : null) : undefined, totalCost: m ? Math.round(Number(o.total_cost)) : undefined, unitCost: m ? Math.round(Number(o.unit_cost) * 100) / 100 : undefined,
    createdAt: o.created_at, doneAt: o.done_at || null, doneBy: who ? who.name : null };
  if (!full) return v;
  const comps = json(o.components, []);
  const consumed = json(o.consumed, []);
  const inputs = [];
  if (o.status === 'planned') {
    for (const c of inputsOf(o)) {
      const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(c.itemId);
      if (!it) continue;
      const need = r3(Number(c.perUnit) * v.remaining);
      const pl = await plan(it.id, need, o.warehouse_id);
      inputs.push({ itemId: Number(it.id), name: it.name, unit: it.unit, tracking: it.tracking || 'none', need, plan: pl.plan, short: pl.short, lots: await lotPreview(it, need) });
    }
  }
  return { ...v, components: comps.map((c) => ({ itemId: c.itemId, name: c.name, unit: c.unit, tracking: c.tracking || 'none', perUnit: c.perUnit, quantity: r3(c.perUnit * Number(o.quantity)) })), inputs,
    consumed: consumed.map((c) => ({ ...c, cost: m ? c.cost : undefined })) };
}
router.get('/kit-orders', async (req, res) => {
  const st = STATUS[req.query.status] ? req.query.status : null;
  const rows = await db.prepare(`SELECT * FROM wms_kit_orders WHERE org_id = ?${st ? ' AND status = ?' : ''} ORDER BY CASE status WHEN 'planned' THEN 0 ELSE 1 END, id DESC LIMIT 300`).all(req.org.id, ...(st ? [st] : []));
  const out = []; for (const o of rows) out.push(await orderView(req, o));
  res.json({ orders: out, kinds: KIND, statuses: STATUS });
});
router.get('/kit-orders/:id', async (req, res) => res.json({ order: await orderView(req, await orderOf(req, req.params.id), { full: true }) }));
router.post('/kit-orders', mgr, async (req, res) => {
  const b = req.body || {};
  const k = await bomOf(req, b.bomId);
  const kind = KIND[b.kind] ? b.kind : 'assembly';
  const q = H().qty(b.quantity);
  const lines = await bomLines(k.id);
  if (!lines.length) throw new HttpError(400, "Ce kit n'a aucun composant.");
  if ((k.tracking === 'serial' || lines.some((l) => l.tracking === 'serial')) && !Number.isInteger(q)) throw new HttpError(400, 'Un article suivi par numéro de série se compte en unités entières.');
  let warehouseId = null; let locationId = null;
  if (b.warehouseId) { const w = await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(b.warehouseId), req.org.id); if (!w) throw new HttpError(404, 'Entrepôt introuvable.'); warehouseId = Number(w.id); }
  if (b.locationId) {
    const l = await W.locationOf(req.org.id, A.id(b.locationId));
    if (!W.isUsable(l)) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
    if (warehouseId && Number(l.warehouse_id) !== warehouseId) throw new HttpError(400, "Cet emplacement n'est pas dans l'entrepôt choisi.");
    locationId = Number(l.id); warehouseId = warehouseId || Number(l.warehouse_id);
  }
  const comps = lines.map((l) => ({ itemId: Number(l.item_id), name: l.name, unit: l.unit, tracking: l.tracking || 'none', perUnit: r3(l.per_unit) }));
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, kind === 'assembly' ? 'AS' : 'DS');
    const id = Number((await db.prepare("INSERT INTO wms_kit_orders (org_id, code, kind, status, bom_id, product_id, quantity, warehouse_id, location_id, components, labor_cost, lot_no, note, created_by, created_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(req.org.id, code, kind, k.id, k.product_id, q, warehouseId, locationId, JSON.stringify(comps), b.laborCost === undefined || b.laborCost === '' ? null : money(b.laborCost), cleanText(String(b.lotNo || ''), 40), cleanText(String(b.note || ''), 300), req.user.id, nowISO())).lastInsertRowid);
    const o = await db.prepare('SELECT * FROM wms_kit_orders WHERE id = ?').get(id);
    // Ce qui sera consommé est mis de côté (dans la limite du disponible) : la vente ne le promet plus à quelqu'un d'autre.
    const short = [];
    for (const c of inputsOf(o)) {
      await W.lockItem(req.org.id, c.itemId);
      const need = r3(Number(c.perUnit) * q);
      const av = Math.max(0, (await W.availability(c.itemId)).available);
      const take = r3(Math.min(need, av));
      if (take > W.EPS) await db.prepare("INSERT INTO wms_reservations (org_id, item_id, quantity, status, source_kind, label, created_by, created_at) VALUES (?, ?, ?, 'active', 'kit', ?, ?, ?)").run(req.org.id, c.itemId, take, holdLabel(o), req.user.id, nowISO());
      if (take + W.EPS < need) { const it = await db.prepare('SELECT name, unit FROM stock_items WHERE id = ?').get(c.itemId); short.push({ itemId: c.itemId, name: it.name, missing: r3(need - take), unit: it.unit }); }
    }
    return { id, code, short };
  })();
  res.status(201).json(out);
});
router.post('/kit-orders/:id/cancel', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'planned') throw new HttpError(400, 'Cet ordre est terminé ou annulé.');
  await db.transaction(async () => {
    if ((await W.lockRow('wms_kit_orders', o.id)).status !== 'planned') throw new HttpError(400, 'Cet ordre est terminé ou annulé.');
    await releaseHolds(o);
    await db.prepare("UPDATE wms_kit_orders SET status = 'cancelled', done_by = ?, done_at = ? WHERE id = ?").run(req.user.id, nowISO(), o.id);
  })();
  res.json({ ok: true });
});

/** Sort `need` d'un article de l'entrepôt de l'ordre (emplacements dans l'ordre utile, lots FEFO) ; renvoie [{ locationId, code, quantity, lots, cost }]. */
async function consume(req, o, it, need, serials, reason) {
  const pl = await plan(it.id, need, o.warehouse_id);
  if (pl.short > W.EPS) throw new HttpError(400, `Stock insuffisant pour « ${it.name} » dans l'entrepôt : il manque ${pl.short} ${it.unit} (hors stock promis aux préparations).`);
  const left = serials ? [...serials] : [];
  const out = [];
  for (const p of pl.plan) {
    const sr = it.tracking === 'serial' ? left.splice(0, Math.round(p.quantity)) : undefined;
    const r = await L.adjust(req, it.id, -p.quantity, reason, { locationId: p.locationId, serials: sr, refKind: 'kit_order', refId: o.id });
    let cost = 0; const lots = [];
    if (it.tracking === 'lot' && r.allocations.length) {
      for (const a of r.allocations) {
        const lot = await db.prepare('SELECT unit_cost FROM stock_lots WHERE id = ?').get(a.lotId);
        const uc = lot && Number(lot.unit_cost) > 0 ? Number(lot.unit_cost) : L.unitValue(it);
        cost += a.quantity * uc; lots.push({ lotNo: a.lotNo, expiry: a.expiry || null, quantity: a.quantity });
      }
    } else cost = p.quantity * L.unitValue(it);
    out.push({ itemId: Number(it.id), name: it.name, unit: it.unit, locationId: p.locationId, location: p.code, quantity: p.quantity, lots, serials: sr || [], cost: Math.round(cost * 100) / 100 });
  }
  return out;
}
const minExpiry = (rows) => rows.flatMap((r) => r.lots).map((l) => l.expiry).filter(Boolean).sort()[0] || null;
router.post('/kit-orders/:id/complete', async (req, res) => {
  const o0 = await orderOf(req, req.params.id);
  if (o0.status !== 'planned') throw new HttpError(400, 'Cet ordre est terminé ou annulé.');
  const b = req.body || {};
  if (b.laborCost !== undefined && b.laborCost !== '' && !A.can(req, 'manager')) throw new HttpError(403, 'Seul un responsable peut saisir le coût de main-d\'œuvre.');
  const remaining = r3(Number(o0.quantity) - Number(o0.done_qty));
  const q = b.quantity === undefined || b.quantity === null || b.quantity === '' ? remaining : H().qty(b.quantity);
  if (q > remaining + W.EPS) throw new HttpError(400, `Il reste ${remaining} à ${o0.kind === 'assembly' ? 'assembler' : 'désassembler'} sur cet ordre.`);
  const serialsOf = (k) => { const v = (b.componentSerials || {})[k]; return v === undefined ? null : L.parseSerials(v); };
  const result = await db.transaction(async () => {
    const o = await W.lockRow('wms_kit_orders', o0.id);
    if (o.status !== 'planned') throw new HttpError(400, 'Cet ordre est terminé ou annulé.');
    const k = o.bom_id ? await db.prepare('SELECT * FROM production_boms WHERE id = ?').get(o.bom_id) : null;
    const product = await W.lockItem(req.org.id, o.product_id);
    const comps = json(o.components, []);
    const reason = `${KIND[o.kind]} ${o.code}`;
    // La mise de côté de l'ordre est libérée juste avant la consommation : le disponible se vérifie sans elle.
    await releaseHolds(o);
    for (const c of inputsOf(o)) {
      await W.lockItem(req.org.id, c.itemId);
      const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(c.itemId);
      const need = r3(Number(c.perUnit) * q);
      const av = (await W.availability(c.itemId)).available;
      if (av + W.EPS < need) throw new HttpError(400, `Stock disponible insuffisant pour « ${it.name} » : ${Math.max(0, av)} ${it.unit} (il en faut ${need}).`);
    }
    const laborTotal = b.laborCost !== undefined && b.laborCost !== '' ? money(b.laborCost) : o.labor_cost != null ? Math.round(Number(o.labor_cost) * q / Number(o.quantity)) : k ? Math.round((Number(k.labor_cost) + Number(k.other_cost)) * q) : 0;
    let consumed = []; let material = 0;
    if (o.kind === 'assembly') {
      for (const c of comps) {
        const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(c.itemId);
        if (!it) throw new HttpError(400, 'Un composant de ce kit a été supprimé du stock.');
        consumed = consumed.concat(await consume(req, o, it, r3(c.perUnit * q), serialsOf(String(c.itemId)), reason));
      }
      material = consumed.reduce((s, x) => s + x.cost, 0);
      const total = material + laborTotal;
      const unitCost = Math.round((total / q) * 100) / 100;
      const lotNo = product.tracking === 'lot' ? (cleanText(String(b.lotNo || ''), 40) || o.lot_no || o.code) : undefined;
      await L.adjust(req, product.id, q, reason, { unitCost, lotNo, expiry: product.tracking === 'lot' ? minExpiry(consumed) || undefined : undefined, serials: b.serials, locationId: o.location_id || undefined, warehouseId: o.warehouse_id || undefined, refKind: 'kit_order', refId: o.id });
      await db.prepare('UPDATE wms_kit_orders SET lot_no = ? WHERE id = ?').run(lotNo || '', o.id);
    } else {
      consumed = await consume(req, o, product, q, b.serials ? L.parseSerials(b.serials) : null, reason);
      const value = consumed.reduce((s, x) => s + x.cost, 0);
      material = value;
      // La valeur du kit (plus la main-d'œuvre éventuelle) se répartit sur les composants au prorata de leur valeur habituelle.
      const items = [];
      for (const c of comps) { const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(c.itemId); if (it) items.push({ it, qty: r3(c.perUnit * q) }); }
      const weights = items.map((x) => x.qty * L.unitValue(x.it));
      const wsum = weights.reduce((s, x) => s + x, 0);
      const totalQty = items.reduce((s, x) => s + x.qty, 0);
      const expiry = minExpiry(consumed);
      for (let i = 0; i < items.length; i++) {
        const { it, qty } = items[i];
        const share = (value + laborTotal) * (wsum > 0 ? weights[i] / wsum : qty / totalQty);
        const lotNo = it.tracking === 'lot' ? (cleanText(String((b.componentLots || {})[String(it.id)] || ''), 40) || o.code) : undefined;
        await L.adjust(req, it.id, qty, reason, { unitCost: Math.round((share / qty) * 100) / 100, lotNo, expiry: it.tracking === 'lot' ? expiry || undefined : undefined, serials: serialsOf(String(it.id)) || undefined, locationId: o.location_id || undefined, warehouseId: o.warehouse_id || undefined, refKind: 'kit_order', refId: o.id });
      }
    }
    const done = r3(Number(o.done_qty) + q);
    const full = done + W.EPS >= Number(o.quantity);
    const prev = json(o.consumed, []);
    // Coûts cumulés (ordre exécuté en plusieurs fois) : la main-d'œuvre réelle = coût total − matières.
    const mat = Math.round((Number(o.material_cost) + material) * 100) / 100;
    const total = Math.round((Number(o.total_cost) + material + laborTotal) * 100) / 100;
    await db.prepare('UPDATE wms_kit_orders SET done_qty = ?, status = ?, consumed = ?, material_cost = ?, total_cost = ?, unit_cost = ?, done_by = ?, done_at = ? WHERE id = ?')
      .run(done, full ? 'done' : 'planned', JSON.stringify(prev.concat(consumed)), mat, total, Math.round((total / done) * 100) / 100, req.user.id, nowISO(), o.id);
    // Ordre partiel : le reste est à nouveau mis de côté.
    if (!full) {
      for (const c of inputsOf(o)) {
        const need = r3(Number(c.perUnit) * (Number(o.quantity) - done));
        const av = Math.max(0, (await W.availability(c.itemId)).available);
        const take = r3(Math.min(need, av));
        if (take > W.EPS) await db.prepare("INSERT INTO wms_reservations (org_id, item_id, quantity, status, source_kind, label, created_by, created_at) VALUES (?, ?, ?, 'active', 'kit', ?, ?, ?)").run(req.org.id, c.itemId, take, holdLabel(o), req.user.id, nowISO());
      }
    }
    return { quantity: q, done: full, materialCost: Math.round(material), laborCost: laborTotal, unitCost: Math.round(((material + laborTotal) / q) * 100) / 100 };
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `${KIND[o0.kind]} ${o0.code} : ${q} unité(s)`);
  const m = A.can(req, 'manager');
  res.json({ ok: true, quantity: result.quantity, done: result.done, materialCost: m ? result.materialCost : undefined, laborCost: m ? result.laborCost : undefined, unitCost: m ? result.unitCost : undefined });
});

module.exports = router;
