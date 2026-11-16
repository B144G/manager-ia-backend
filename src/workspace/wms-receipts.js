'use strict';
// Stock entrepôt (WMS) — réceptions avec coûts d'arrivée (transport, douane, manutention, assurance…).
// Les frais sont répartis sur les lignes (selon la valeur, la quantité ou le poids) et intégrés au coût moyen pondéré (CUMP).
// Un frais ajouté après coup ne s'intègre qu'au stock encore présent : la part des quantités déjà sorties est « à passer en charge ».
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

const COST_KINDS = { transport: 'Transport', customs: 'Droits de douane', handling: 'Manutention', insurance: 'Assurance', other: 'Autre frais' };
const BASES = { value: 'Valeur', quantity: 'Quantité', weight: 'Poids' };
router.get('/receipts/kinds', mgr, (req, res) => res.json({ costKinds: COST_KINDS, bases: BASES }));

function readCosts(list, { noWeight = false } = {}) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'Liste de coûts invalide (20 au plus).');
  return list.map((c) => {
    const x = c || {};
    const amount = A.amount(x.amount);
    const basis = BASES[x.basis] && !(noWeight && x.basis === 'weight') ? x.basis : 'value';
    return { kind: COST_KINDS[x.kind] ? x.kind : 'other', label: cleanText(String(x.label || ''), 100), amount, basis };
  }).filter((c) => c.amount > 0);
}
/** Répartit `amount` sur les lignes selon la base ; arrondi à l'unité, le reste va à la dernière ligne. */
function spread(lines, amount, basis) {
  const w = lines.map((l) => (basis === 'quantity' ? l.quantity : basis === 'weight' ? (l.weight === null || l.weight === undefined ? NaN : l.quantity * l.weight) : l.quantity * l.unitCost));
  if (basis === 'weight' && w.some((x) => !Number.isFinite(x))) throw new HttpError(400, 'Répartition au poids : indiquez le poids unitaire de chaque ligne.');
  const total = w.reduce((s, x) => s + x, 0);
  if (!(total > 0)) throw new HttpError(400, 'Impossible de répartir : la base de répartition (valeur, quantité ou poids) est nulle.');
  let given = 0;
  return w.map((x, i) => { if (i === w.length - 1) return amount - given; const s = Math.round((amount * x) / total); given += s; return s; });
}
function allocate(lines, costs) {
  const extra = lines.map(() => 0);
  for (const c of costs) spread(lines, c.amount, c.basis).forEach((s, i) => { extra[i] += s; });
  return lines.map((l, i) => ({ ...l, landedTotal: extra[i], landedUnit: Math.round(((l.quantity * l.unitCost + extra[i]) / l.quantity) * 100) / 100 }));
}
async function readLines(req, list) {
  if (!Array.isArray(list) || !list.length || list.length > 100) throw new HttpError(400, 'Ajoutez au moins une ligne (100 au plus).');
  const seen = new Set(); const out = [];
  for (const x of list) {
    const it = await H().itemOf(req, x && x.itemId);
    if (seen.has(Number(it.id))) throw new HttpError(400, 'Un article apparaît deux fois : une seule ligne par article.');
    seen.add(Number(it.id));
    const unitCost = x.unitCost === undefined || x.unitCost === '' ? Number(it.unit_cost) || 0 : Number(String(x.unitCost).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(unitCost) || unitCost < 0) throw new HttpError(400, 'Coût unitaire invalide.');
    const weight = x.weight === undefined || x.weight === '' || x.weight === null ? null : Number(String(x.weight).replace(',', '.'));
    if (weight !== null && (!Number.isFinite(weight) || weight < 0)) throw new HttpError(400, 'Poids invalide.');
    out.push({ it, itemId: Number(it.id), name: it.name, quantity: H().qty(x.quantity), unitCost: Math.round(unitCost * 100) / 100, weight, lotNo: cleanText(String(x.lotNo || ''), 40), expiry: A.date(x.expiry) || undefined, serials: x.serials });
  }
  return out;
}
const view = (l) => ({ name: l.name, quantity: l.quantity, unitCost: l.unitCost, landedUnit: l.landedUnit, landedTotal: l.landedTotal });

router.post('/receipts/preview', mgr, async (req, res) => {
  const b = req.body || {};
  const lines = allocate(await readLines(req, b.lines), readCosts(b.costs));
  res.json({ lines: lines.map(view), baseValue: Math.round(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0)), landedCost: lines.reduce((s, l) => s + l.landedTotal, 0) });
});
router.post('/receipts', mgr, async (req, res) => {
  const b = req.body || {};
  const lines = allocate(await readLines(req, b.lines), readCosts(b.costs));
  const costs = readCosts(b.costs);
  let supplierId = null;
  if (b.supplierId) { const s = await db.prepare('SELECT id FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(b.supplierId), req.org.id); if (!s) throw new HttpError(404, 'Fournisseur introuvable.'); supplierId = s.id; }
  let locationId;
  if (b.locationId) { const l = await W.locationOf(req.org.id, A.id(b.locationId)); if (!Number(l.active) || l.kind === 'transit') throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).'); locationId = l.id; }
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'RC');
    const id = Number((await db.prepare('INSERT INTO wms_receipts (org_id, code, supplier_id, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, code, supplierId, cleanText(String(b.reference || ''), 80), req.user.id, nowISO())).lastInsertRowid);
    for (const l of lines) {
      await L.adjust(req, l.it, l.quantity, `Réception ${code}${b.reference ? ' (' + cleanText(String(b.reference), 60) + ')' : ''}`, { unitCost: l.landedUnit, lotNo: l.lotNo, expiry: l.expiry, serials: l.serials, strict: true, locationId, refKind: 'wms_receipt', refId: id });
      await db.prepare('UPDATE stock_items SET unit_cost = ? WHERE id = ?').run(Math.round(l.unitCost), l.itemId);
      await db.prepare('INSERT INTO wms_receipt_lines (receipt_id, item_id, quantity, unit_cost, weight, landed_total) VALUES (?, ?, ?, ?, ?, ?)').run(id, l.itemId, l.quantity, l.unitCost, l.weight, l.landedTotal);
    }
    for (const c of costs) await db.prepare('INSERT INTO wms_receipt_costs (receipt_id, kind, label, amount, basis, expensed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(id, c.kind, c.label, c.amount, c.basis, nowISO());
    return { id, code };
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Réception ${out.code} enregistrée`);
  res.status(201).json(out);
});

async function receiptOf(req, idv) {
  const r = await db.prepare('SELECT r.*, s.name AS supplier FROM wms_receipts r LEFT JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ? AND r.org_id = ?').get(A.id(idv), req.org.id);
  if (!r) throw new HttpError(404, 'Réception introuvable.');
  return r;
}
router.get('/receipts', mgr, async (req, res) => {
  const rows = await db.prepare(`SELECT r.*, s.name AS supplier, (SELECT COUNT(*) FROM wms_receipt_lines l WHERE l.receipt_id = r.id) AS n,
      (SELECT COALESCE(SUM(amount), 0) FROM wms_receipt_costs c WHERE c.receipt_id = r.id) AS lc, (SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM wms_receipt_lines l WHERE l.receipt_id = r.id) AS bv
    FROM wms_receipts r LEFT JOIN suppliers s ON s.id = r.supplier_id WHERE r.org_id = ? ORDER BY r.id DESC LIMIT 300`).all(req.org.id);
  res.json({ receipts: rows.map((r) => ({ id: Number(r.id), code: r.code, supplier: r.supplier || null, reference: r.reference || '', lineCount: Number(r.n), createdAt: r.created_at, landedCost: Number(r.lc), totalValue: Math.round(Number(r.bv) + Number(r.lc)) })) });
});
router.get('/receipts/purchase-candidates', mgr, async (req, res) => {
  const rows = await db.prepare(`SELECT pr.*, o.item_id, o.id AS oid, i.name AS item, s.name AS supplier FROM purchase_receipts pr JOIN purchase_orders o ON o.id = pr.order_id JOIN stock_items i ON i.id = o.item_id LEFT JOIN suppliers s ON s.id = o.supplier_id
    WHERE pr.org_id = ? AND NOT EXISTS (SELECT 1 FROM wms_receipt_lines l WHERE l.purchase_receipt_id = pr.id) ORDER BY pr.id DESC LIMIT 200`).all(req.org.id);
  res.json({ receipts: rows.map((r) => ({ id: Number(r.id), item: r.item, quantity: r3(r.quantity), supplier: r.supplier || null, orderId: Number(r.oid), at: r.created_at, unitPrice: Number(r.unit_price) })) });
});
router.get('/receipts/:id', mgr, async (req, res) => {
  const r = await receiptOf(req, req.params.id);
  const lines = await db.prepare('SELECT l.*, i.name FROM wms_receipt_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.receipt_id = ? ORDER BY l.id').all(r.id);
  const costs = await db.prepare('SELECT * FROM wms_receipt_costs WHERE receipt_id = ? ORDER BY id').all(r.id);
  const landed = costs.reduce((s, c) => s + Number(c.amount), 0); const expensed = costs.reduce((s, c) => s + Number(c.expensed), 0);
  res.json({ receipt: {
    id: Number(r.id), code: r.code, supplier: r.supplier || null, reference: r.reference || '', createdAt: r.created_at,
    baseValue: Math.round(lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost), 0)), landedCost: landed, incorporated: landed - expensed, expensed,
    lines: lines.map((l) => ({ id: Number(l.id), itemId: Number(l.item_id), name: l.name, quantity: r3(l.quantity), unitCost: Number(l.unit_cost), baseValue: Math.round(Number(l.quantity) * Number(l.unit_cost)), landedTotal: Number(l.landed_total), landedUnit: Math.round(((Number(l.quantity) * Number(l.unit_cost) + Number(l.landed_total)) / Number(l.quantity)) * 100) / 100 })),
    costs: costs.map((c) => ({ id: Number(c.id), kind: c.kind, kindLabel: COST_KINDS[c.kind] || 'Autre frais', label: c.label || '', basis: c.basis, basisLabel: BASES[c.basis], amount: Number(c.amount), expensed: Number(c.expensed) })),
  } });
});

/** Ajoute un frais à une réception déjà en stock : la part du stock encore présent entre dans le CUMP, le reste est « à passer en charge ». */
async function addCost(req, receiptId, c) {
  const lines = (await db.prepare('SELECT l.*, i.quantity AS on_hand, i.avg_cost, i.name FROM wms_receipt_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.receipt_id = ? ORDER BY l.id').all(receiptId))
    .map((l) => ({ ...l, quantity: Number(l.quantity), unitCost: Number(l.unit_cost), weight: l.weight === null ? null : Number(l.weight) }));
  const shares = spread(lines, c.amount, c.basis);
  let expensed = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; const share = shares[i];
    const still = Math.max(0, Math.min(l.quantity, Number(l.on_hand)));
    const inStock = l.quantity > 0 ? Math.round((share * still) / l.quantity) : 0;
    expensed += share - inStock;
    if (inStock > 0 && Number(l.on_hand) > 0) {
      const avg = Math.round((Number(l.avg_cost) + inStock / Number(l.on_hand)) * 100) / 100;
      await db.prepare('UPDATE stock_items SET avg_cost = ? WHERE id = ?').run(avg, l.item_id);
      await db.prepare("INSERT INTO stock_moves (org_id, item_id, delta, reason, created_by, created_at, unit_cost, ref_kind, ref_id) VALUES (?, ?, 0, ?, ?, ?, ?, 'landed_cost', ?)").run(req.org.id, l.item_id, `Coût d'arrivée : ${c.label || COST_KINDS[c.kind]}`, req.user.id, nowISO(), inStock, receiptId);
    }
    await db.prepare('UPDATE wms_receipt_lines SET landed_total = landed_total + ? WHERE id = ?').run(share, l.id);
  }
  await db.prepare('INSERT INTO wms_receipt_costs (receipt_id, kind, label, amount, basis, expensed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(receiptId, c.kind, c.label, c.amount, c.basis, expensed, nowISO());
  return expensed;
}
router.post('/receipts/:id/costs', mgr, async (req, res) => {
  const r = await receiptOf(req, req.params.id);
  const [c] = readCosts([req.body || {}]);
  if (!c) throw new HttpError(400, 'Montant invalide.');
  const expensed = await db.transaction(() => addCost(req, r.id, c))();
  res.status(201).json({ ok: true, expensed });
});
router.post('/receipts/from-purchase', mgr, async (req, res) => {
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.purchaseReceiptIds) ? b.purchaseReceiptIds : []).map((x) => A.id(x)))];
  if (!ids.length || ids.length > 50) throw new HttpError(400, "Indiquez les réceptions d'achat à regrouper (50 au plus).");
  const costs = readCosts(b.costs, { noWeight: true });
  const rows = [];
  for (const id of ids) {
    const pr = await db.prepare('SELECT pr.*, o.item_id, o.supplier_id FROM purchase_receipts pr JOIN purchase_orders o ON o.id = pr.order_id WHERE pr.id = ? AND pr.org_id = ?').get(id, req.org.id);
    if (!pr) throw new HttpError(404, "Réception d'achat introuvable.");
    if (await db.prepare('SELECT 1 FROM wms_receipt_lines WHERE purchase_receipt_id = ?').get(id)) throw new HttpError(400, "Une de ces réceptions a déjà un dossier de coûts d'arrivée : ajoutez le coût à ce dossier.");
    rows.push(pr);
  }
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'RC');
    const sup = [...new Set(rows.map((r) => r.supplier_id).filter(Boolean))];
    const id = Number((await db.prepare('INSERT INTO wms_receipts (org_id, code, supplier_id, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, code, sup.length === 1 ? sup[0] : null, `Commandes ${[...new Set(rows.map((r) => '#' + r.order_id))].join(', ')}`.slice(0, 80), req.user.id, nowISO())).lastInsertRowid);
    for (const pr of rows) await db.prepare('INSERT INTO wms_receipt_lines (receipt_id, item_id, quantity, unit_cost, purchase_receipt_id) VALUES (?, ?, ?, ?, ?)').run(id, pr.item_id, pr.quantity, Number(pr.unit_price), pr.id);
    for (const c of costs) await addCost(req, id, c);
    return { id, code };
  })();
  res.status(201).json(out);
});

module.exports = router;
