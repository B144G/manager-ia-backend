'use strict';
// Production avancée : un document par organisation et par technique (MPS, MRP, capacités, ordonnancement, kanban, 5S, Six Sigma, TPM, qualité…).
// GET /production/adv/:kind renvoie { doc, result } ; PUT enregistre (responsables) et recalcule. Le serveur calcule tout ; le site dessine.
// Lectures seules des tables Stock, Achats et Maintenance (suggestions) : rien n'est écrit dans leurs tables.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const Plan = require('./prod-plan-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** Registre des techniques : clean(doc) nettoie, compute(doc, docs) calcule. docs : les autres documents déjà nettoyés (liens MPS → MRP / capacités). */
const KINDS = {
  mps: { empty: { periods: 8, level: false, products: [] }, clean: Plan.cleanMps, compute: (d) => Plan.computeMps(d) },
  mrp: { empty: { periods: 8, useMps: true, items: [] }, clean: Plan.cleanMrp, compute: (d, o) => Plan.computeMrp(d, mpsPlans(o.mps)) },
  capacity: { empty: { periods: 8, useMps: true, overtimeMaxPct: 20, centers: [], routings: [], manual: [] }, clean: Plan.cleanCapacity, compute: (d, o) => Plan.computeCapacity(d, o.mps ? Plan.computeMps(o.mps).products : []) },
  schedule: { empty: { hoursPerDay: 8, rule: 'edd', jobs: [] }, clean: Plan.cleanSchedule, compute: (d) => Plan.computeSchedule(d) },
};
function mpsPlans(mps) {
  const out = {}; if (!mps) return out;
  for (const p of Plan.computeMps(mps).products) { out[p.id] = p.plan; out[p.name] = p.plan; }
  return out;
}
const reg = (kind, def) => { KINDS[kind] = def; };
module.exports.register = reg;
module.exports.KINDS = KINDS;

async function docOf(req, kind) {
  const r = await db.prepare('SELECT data, updated_at FROM production_docs WHERE org_id = ? AND kind = ?').get(req.org.id, kind);
  return r ? { doc: json(r.data, null), at: r.updated_at } : { doc: null, at: null };
}
async function allDocs(req) {
  const rows = await db.prepare('SELECT kind, data FROM production_docs WHERE org_id = ?').all(req.org.id);
  const o = {};
  for (const r of rows) if (KINDS[r.kind]) { try { o[r.kind] = KINDS[r.kind].clean(json(r.data, {})); } catch { /* document abîmé : ignoré */ } }
  return o;
}
function kindOf(req) {
  const k = req.params.kind;
  if (!KINDS[k]) throw new HttpError(404, 'Technique inconnue.');
  return k;
}

/** Suggestions tirées du stock, des recettes (nomenclatures) et des commandes d'achat en cours : lecture seule. */
router.get('/import/stock', async (req, res) => {
  const stock = (await db.prepare('SELECT id, name, unit, quantity, min_quantity, unit_cost FROM stock_items WHERE org_id = ? ORDER BY name LIMIT 300').all(req.org.id))
    .map((s) => ({ id: Number(s.id), name: s.name, unit: s.unit, onHand: Number(s.quantity), safety: Number(s.min_quantity), unitCost: Number(s.unit_cost) }));
  const boms = await db.prepare('SELECT b.id, b.product_id FROM production_boms b WHERE b.org_id = ? LIMIT 100').all(req.org.id);
  const lines = await db.prepare('SELECT l.bom_id, l.item_id, l.quantity FROM production_bom_lines l WHERE l.org_id = ?').all(req.org.id);
  const orders = await db.prepare("SELECT item_id, SUM(quantity) q FROM purchase_orders WHERE org_id = ? AND status IN ('pending', 'approved', 'ordered') GROUP BY item_id").all(req.org.id);
  const name = new Map(stock.map((s) => [s.id, s.name]));
  res.json({
    stock,
    boms: boms.map((b) => ({ product: name.get(Number(b.product_id)) || null, productId: Number(b.product_id), lines: lines.filter((l) => Number(l.bom_id) === Number(b.id)).map((l) => ({ item: name.get(Number(l.item_id)) || null, itemId: Number(l.item_id), qty: Number(l.quantity) })) })),
    openPurchases: orders.map((o) => ({ itemId: Number(o.item_id), item: name.get(Number(o.item_id)) || null, qty: Number(o.q) })),
  });
});

router.get('/:kind', async (req, res) => {
  const kind = kindOf(req); const K = KINDS[kind];
  const { doc, at } = await docOf(req, kind);
  let clean; try { clean = K.clean(doc || K.empty); } catch { clean = K.clean(K.empty); }
  const others = await allDocs(req);
  res.json({ doc: clean, saved: Boolean(doc), updatedAt: at, result: K.compute(clean, others, req) });
});

router.put('/:kind', mgr, async (req, res) => {
  const kind = kindOf(req); const K = KINDS[kind];
  let clean; try { clean = K.clean(req.body || {}); } catch (e) { throw new HttpError(400, e.message); }
  await db.prepare('INSERT INTO production_docs (org_id, kind, data, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at')
    .run(req.org.id, kind, JSON.stringify(clean), req.user.id, nowISO());
  await W.audit(req, 'production_doc', 0, kind, null, { size: JSON.stringify(clean).length });
  const others = await allDocs(req);
  res.json({ doc: clean, saved: true, result: K.compute(clean, others, req) });
});

module.exports.router = router;
