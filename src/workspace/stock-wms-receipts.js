'use strict';
// Stock WMS · lot 5 : réceptions multi-lignes et coûts d'arrivée (transport, douane, manutention, assurance…).
// Un coût d'arrivée est réparti sur les lignes d'une réception (au prorata de la valeur, de la quantité ou du poids ; somme exacte, aucun franc perdu)
// puis incorporé au coût moyen pondéré (CUMP) de chaque article pour la part encore en stock. La part déjà sortie (vendue, consommée) est indiquée « à passer en charge ».
// Le coût peut arriver après la réception (facture du transitaire) : même calcul. Aucune écriture comptable ici : la facture du transport ou de la douane reste
// enregistrée en charge par la comptabilité ; le stock valorisé (acc-stock.js) monte du coût incorporé. Réservé aux responsables (valeurs d'achat).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use('/receipts', A.need('manager'));

const COST_KINDS = { transport: 'Transport', customs: 'Droits de douane', handling: 'Manutention', insurance: 'Assurance', other: 'Autre frais' };
const BASES = { value: 'Valeur', quantity: 'Quantité', weight: 'Poids' };
const r2 = (n) => Math.round(n * 100) / 100;

const recOf = async (req, id) => {
  const r = await db.prepare('SELECT * FROM wms_receipts WHERE id = ? AND org_id = ?').get(A.id(id, 'Réception invalide.'), req.org.id);
  if (!r) throw new HttpError(404, 'Réception introuvable.');
  return r;
};
const itemOf = async (req, id) => {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(id, 'Article invalide.'), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  return it;
};

function cleanCosts(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'Liste de coûts invalide (20 au plus).');
  return list.map((c) => ({
    kind: A.oneOf(c && c.kind, Object.keys(COST_KINDS), 'other', "Type de coût inconnu (transport, douane, manutention, assurance, autre)."),
    label: A.text(c && c.label, 120), amount: A.amount(c && c.amount),
    basis: A.oneOf(c && c.basis, Object.keys(BASES), 'value', 'Base de répartition inconnue (valeur, quantité, poids).'),
  }));
}
/** Poids de répartition de chaque ligne pour une base donnée. */
function weightsOf(lines, basis) {
  const w = lines.map((l) => (basis === 'quantity' ? l.quantity : basis === 'weight' ? Number(l.weight) * l.quantity : l.quantity * l.unit_cost));
  if (basis === 'weight' && w.some((x) => !(x > 0))) throw new HttpError(400, 'Répartition au poids : indiquez le poids unitaire de chaque ligne.');
  return w;
}

/** Applique un coût d'arrivée à une réception : répartition, incorporation au CUMP (part en stock), traces. Dans une transaction. */
async function applyCost(req, rec, lines, cost) {
  const parts = W.allocate(cost.amount, weightsOf(lines, cost.basis));
  const cid = Number((await db.prepare('INSERT INTO wms_landed_costs (org_id, receipt_id, kind, label, amount, basis, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, rec.id, cost.kind, cost.label, cost.amount, cost.basis, req.user.id, nowISO())).lastInsertRowid);
  let incTotal = 0; let expTotal = 0;
  const order = lines.map((l, i) => ({ l, amt: parts[i] })).sort((a, b) => a.l.item_id - b.l.item_id);
  for (const { l, amt } of order) {
    const it = await W.lockItem(req.org.id, l.item_id);
    const uv = L.unitValue(it);
    const inStock = Math.max(Math.min(l.quantity, it.quantity), 0);
    const frac = l.quantity > 0 ? inStock / l.quantity : 0;
    const inc = Math.round(amt * frac); const exp = amt - inc;
    if (inc > 0 && it.quantity > 0) {
      await db.prepare('UPDATE stock_items SET avg_cost = ? WHERE id = ?').run(r2((it.quantity * uv + inc) / it.quantity), it.id);
      await db.prepare('INSERT INTO stock_moves (org_id, item_id, delta, reason, created_by, created_at, ref_kind, ref_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?)').run(req.org.id, it.id, `Coût d'arrivée ${rec.code} (${COST_KINDS[cost.kind]}) : +${inc} incorporé au coût moyen`.slice(0, 150), req.user.id, nowISO(), 'landed_cost', rec.id);
    }
    await db.prepare('INSERT INTO wms_landed_alloc (cost_id, line_id, amount, incorporated) VALUES (?, ?, ?, ?)').run(cid, l.id, amt, inc);
    await db.prepare('UPDATE wms_receipt_lines SET landed_total = landed_total + ?, incorporated = incorporated + ?, expensed = expensed + ? WHERE id = ?').run(amt, inc, exp, l.id);
    incTotal += inc; expTotal += exp;
  }
  await db.prepare('UPDATE wms_landed_costs SET incorporated = ?, expensed = ? WHERE id = ?').run(incTotal, expTotal, cid);
  return { id: cid, incorporated: incTotal, expensed: expTotal };
}

async function view(req, r, full) {
  const lines = await db.prepare('SELECT l.*, i.name, i.unit FROM wms_receipt_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.receipt_id = ? ORDER BY l.id').all(r.id);
  const costs = await db.prepare('SELECT * FROM wms_landed_costs WHERE receipt_id = ? ORDER BY id').all(r.id);
  const sup = r.supplier_id ? await db.prepare('SELECT name FROM suppliers WHERE id = ?').get(r.supplier_id) : null;
  const base = lines.reduce((a, l) => a + Math.round(l.quantity * l.unit_cost), 0);
  const landed = costs.reduce((a, c) => a + Number(c.amount), 0);
  const out = { id: r.id, code: r.code, source: r.source, supplierId: r.supplier_id, supplier: sup ? sup.name : null, reference: r.reference, orderId: r.order_id, note: r.note, createdAt: r.created_at, lineCount: lines.length,
    baseValue: base, landedCost: landed, incorporated: lines.reduce((a, l) => a + Number(l.incorporated), 0), expensed: lines.reduce((a, l) => a + Number(l.expensed), 0), totalValue: base + landed };
  if (full) {
    out.lines = lines.map((l) => ({ id: l.id, itemId: l.item_id, name: l.name, unit: l.unit, quantity: l.quantity, unitCost: l.unit_cost, weight: l.weight, lotNo: l.lot_no, expiry: l.expiry, purchaseReceiptId: l.purchase_receipt_id,
      baseValue: Math.round(l.quantity * l.unit_cost), landedTotal: Number(l.landed_total), landedUnit: l.quantity > 0 ? r2(l.unit_cost + Number(l.landed_total) / l.quantity) : l.unit_cost, incorporated: Number(l.incorporated), expensed: Number(l.expensed) }));
    out.costs = costs.map((c) => ({ id: c.id, kind: c.kind, kindLabel: COST_KINDS[c.kind], label: c.label, amount: Number(c.amount), basis: c.basis, basisLabel: BASES[c.basis], incorporated: Number(c.incorporated), expensed: Number(c.expensed), createdAt: c.created_at }));
  }
  return out;
}

router.get('/receipts/kinds', (req, res) => res.json({ costKinds: COST_KINDS, bases: BASES }));
router.get('/receipts', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM wms_receipts WHERE org_id = ? ORDER BY id DESC LIMIT 100').all(req.org.id);
  const out = []; for (const r of rows) out.push(await view(req, r, false));
  res.json({ receipts: out });
});
router.get('/receipts/:id', async (req, res) => res.json({ receipt: await view(req, await recOf(req, req.params.id), true) }));

/** Simulation : répartition des coûts sur des lignes, sans rien enregistrer. */
router.post('/receipts/preview', async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw new HttpError(400, 'Ajoutez au moins une ligne (100 au plus).');
  const lines = []; for (const x of b.lines) { const it = await itemOf(req, x && x.itemId); lines.push({ item_id: it.id, name: it.name, quantity: A.qty(x.quantity), unit_cost: Number(A.money0(x.unitCost)), weight: Number(x.weight) > 0 ? Number(x.weight) : 0 }); }
  const costs = cleanCosts(b.costs);
  const add = lines.map(() => 0);
  for (const c of costs) W.allocate(c.amount, weightsOf(lines, c.basis)).forEach((v, i) => { add[i] += v; });
  res.json({ lines: lines.map((l, i) => ({ itemId: l.item_id, name: l.name, quantity: l.quantity, unitCost: l.unit_cost, baseValue: Math.round(l.quantity * l.unit_cost), landedTotal: add[i], landedUnit: r2(l.unit_cost + add[i] / l.quantity) })), baseValue: lines.reduce((a, l) => a + Math.round(l.quantity * l.unit_cost), 0), landedCost: costs.reduce((a, c) => a + c.amount, 0) });
});

// ---------- Réception directe (hors commande d'achat) : entre en stock, puis les coûts sont appliqués ----------
router.post('/receipts', async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw new HttpError(400, 'Ajoutez au moins une ligne (100 au plus).');
  const costs = cleanCosts(b.costs);
  let supplierId = null;
  if (b.supplierId) { const s = await db.prepare('SELECT id FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(b.supplierId, 'Fournisseur invalide.'), req.org.id); if (!s) throw new HttpError(404, 'Fournisseur introuvable.'); supplierId = s.id; }
  let orderId = null;
  if (b.orderId) { const o = await db.prepare('SELECT id FROM purchase_orders WHERE id = ? AND org_id = ?').get(A.id(b.orderId, 'Commande invalide.'), req.org.id); if (!o) throw new HttpError(404, "Commande d'achat introuvable."); orderId = o.id; }
  const seen = new Set(); const lines = [];
  for (const x of b.lines) {
    const it = await itemOf(req, x && x.itemId);
    const q = A.qty(x.quantity);
    const key = `${it.id}:${A.text(x.lotNo, 40)}`;
    if (seen.has(key)) throw new HttpError(400, `« ${it.name} » apparaît deux fois (même lot) : une seule ligne.`);
    seen.add(key);
    if (it.tracking === 'lot' && !A.text(x.lotNo, 40)) throw new HttpError(400, `« ${it.name} » est suivi par lot : indiquez le numéro de lot reçu.`);
    const serials = it.tracking === 'serial' ? L.parseSerials(x.serials) : undefined;
    if (it.tracking === 'serial' && serials.length !== q) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : indiquez exactement ${q} numéro(s).`);
    const loc = x.locationId || b.locationId ? await W.locationFor(req, x.locationId || b.locationId) : null;
    lines.push({ it, q, unitCost: A.money0(x.unitCost), weight: Number(x.weight) > 0 ? Number(x.weight) : 0, lotNo: A.text(x.lotNo, 40), expiry: A.date(x.expiry), serials, loc });
  }
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'wms_receipt', 'REC');
    const rid = Number((await db.prepare("INSERT INTO wms_receipts (org_id, code, source, supplier_id, reference, order_id, note, created_by, created_at) VALUES (?, ?, 'direct', ?, ?, ?, ?, ?, ?)").run(req.org.id, code, supplierId, A.text(b.reference, 80), orderId, A.text(b.note, 300), req.user.id, nowISO())).lastInsertRowid);
    for (const l of [...lines].sort((a, c) => a.it.id - c.it.id)) {
      await L.adjust(req, l.it, l.q, `Réception ${code}`, { unitCost: l.unitCost > 0 ? l.unitCost : undefined, lotNo: l.lotNo || undefined, expiry: l.expiry || undefined, serials: l.serials, strict: true, refKind: 'receipt', refId: rid, locationId: l.loc ? l.loc.id : undefined });
      if (l.unitCost > 0) await db.prepare('UPDATE stock_items SET unit_cost = ? WHERE id = ?').run(l.unitCost, l.it.id);
      await db.prepare('INSERT INTO wms_receipt_lines (org_id, receipt_id, item_id, quantity, unit_cost, weight, lot_no, expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, rid, l.it.id, l.q, l.unitCost, l.weight, l.lotNo, l.expiry);
    }
    const rec = await db.prepare('SELECT * FROM wms_receipts WHERE id = ?').get(rid);
    const rl = await db.prepare('SELECT * FROM wms_receipt_lines WHERE receipt_id = ? ORDER BY id').all(rid);
    const applied = [];
    for (const c of costs) applied.push(await applyCost(req, rec, rl, c));
    return { id: rid, code, costs: applied };
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Réception ${out.code} enregistrée (${lines.length} ligne(s))`);
  res.status(201).json(out);
});

// ---------- Réceptions d'une commande d'achat déjà passées en stock : on y rattache seulement les coûts d'arrivée ----------
router.post('/receipts/from-purchase', async (req, res) => {
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.purchaseReceiptIds) ? b.purchaseReceiptIds : [b.purchaseReceiptId]).filter((x) => x !== undefined && x !== null && x !== '').map((x) => A.id(x, 'Réception invalide.')))];
  if (!ids.length || ids.length > 50) throw new HttpError(400, "Indiquez les réceptions d'achat à regrouper (50 au plus).");
  const rows = await db.prepare(`SELECT r.id, r.quantity, r.unit_price, r.lot_no, r.expiry, o.item_id, o.supplier_id, o.id AS order_id FROM purchase_receipts r JOIN purchase_orders o ON o.id = r.order_id WHERE r.org_id = ? AND r.id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id`).all(req.org.id, ...ids);
  if (rows.length !== ids.length) throw new HttpError(404, "Réception d'achat introuvable.");
  if (await db.prepare(`SELECT 1 FROM wms_receipt_lines WHERE org_id = ? AND purchase_receipt_id IN (${ids.map(() => '?').join(',')})`).get(req.org.id, ...ids)) throw new HttpError(409, "Une de ces réceptions a déjà un dossier de coûts d'arrivée : ajoutez le coût à ce dossier.");
  for (const r of rows) await itemOf(req, r.item_id);
  const costs = cleanCosts(b.costs);
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'wms_receipt', 'REC');
    const sup = [...new Set(rows.map((r) => r.supplier_id))];
    const rid = Number((await db.prepare("INSERT INTO wms_receipts (org_id, code, source, supplier_id, reference, order_id, note, created_by, created_at) VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?, ?)").run(req.org.id, code, sup.length === 1 ? sup[0] : null, A.text(b.reference, 80), rows.length === 1 ? rows[0].order_id : null, A.text(b.note, 300), req.user.id, nowISO())).lastInsertRowid);
    for (const r of rows) await db.prepare('INSERT INTO wms_receipt_lines (org_id, receipt_id, item_id, quantity, unit_cost, weight, lot_no, expiry, purchase_receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, rid, r.item_id, r.quantity, r.unit_price, Number(b.weights && b.weights[r.id]) > 0 ? Number(b.weights[r.id]) : 0, r.lot_no || '', r.expiry || null, r.id);
    const rec = await db.prepare('SELECT * FROM wms_receipts WHERE id = ?').get(rid);
    const rl = await db.prepare('SELECT * FROM wms_receipt_lines WHERE receipt_id = ? ORDER BY id').all(rid);
    const applied = []; for (const c of costs) applied.push(await applyCost(req, rec, rl, c));
    return { id: rid, code, costs: applied };
  })();
  res.status(201).json(out);
});

// ---------- Coût d'arrivée ajouté plus tard (facture du transitaire, de la douane…) ----------
router.post('/receipts/:id/costs', async (req, res) => {
  const rec = await recOf(req, req.params.id);
  const [cost] = cleanCosts([req.body || {}]);
  const out = await db.transaction(async () => {
    await db.prepare('SELECT id FROM wms_receipts WHERE id = ? FOR UPDATE').get(rec.id);
    const rl = await db.prepare('SELECT * FROM wms_receipt_lines WHERE receipt_id = ? ORDER BY id').all(rec.id);
    return await applyCost(req, rec, rl, cost);
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Coût d'arrivée de ${cost.amount} ${req.org.currency} ajouté à ${rec.code}`);
  res.status(201).json(out);
});

module.exports = router;
