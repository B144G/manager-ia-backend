'use strict';
// Sous-application « Stock et achats » : articles, mouvements, fournisseurs et comparaison de prix, commandes à valider.
// Règle : une commande est d'abord « à valider » ; un responsable la valide (pas sa propre demande, sauf administrateur), puis on la
// marque « reçue » et le stock augmente automatiquement.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { amap, afilter, HttpError } = require('../util');

const router = express.Router({ mergeParams: true });

const itemOf = async (req, id) => {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  return it;
};
const supplierOf = async (req, id) => {
  const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!s) throw new HttpError(404, 'Fournisseur introuvable.');
  return s;
};

/** Meilleur prix connu (le plus bas) parmi les fournisseurs d'un article. */
const bestPrice = async (itemId) => await db.prepare('SELECT p.supplier_id AS supplierId, s.name AS supplier, p.unit_price AS unitPrice, p.lead_days AS leadDays FROM supplier_prices p JOIN suppliers s ON s.id = p.supplier_id WHERE p.item_id = ? ORDER BY p.unit_price, COALESCE(p.lead_days, 999) LIMIT 1').get(itemId) || null;

const view = async (it) => ({
  id: it.id, name: it.name, unit: it.unit, quantity: it.quantity, minQuantity: it.min_quantity, unitCost: it.unit_cost, branchId: it.branch_id,
  state: it.quantity <= 0 ? 'out' : it.quantity <= it.min_quantity && it.min_quantity > 0 ? 'low' : 'ok', best: await bestPrice(it.id),
});

/** Articles du stock visibles (filtrés par antenne). */
async function items(req) {
  const sc = A.scope(req);
  return await db.prepare(`SELECT * FROM stock_items WHERE org_id = ?${sc.sql} ORDER BY name COLLATE NOCASE`).all(req.org.id, ...sc.args);
}

/** Quantité conseillée pour revenir à deux fois le seuil (règle simple et explicable). */
const reorderQty = (it) => Math.max(Math.ceil((it.min_quantity * 2 - it.quantity) * 100) / 100, it.min_quantity || 1);

async function suggestions(req) {
  return (await amap((await items(req)).filter((it) => it.min_quantity > 0 && it.quantity <= it.min_quantity), async (it) => {
    const pending = (await db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM purchase_orders WHERE item_id = ? AND status IN ('pending','ordered')").get(it.id)).q;
    const b = await bestPrice(it.id);
    return { itemId: it.id, name: it.name, unit: it.unit, quantity: it.quantity, minQuantity: it.min_quantity, toOrder: pending >= reorderQty(it) ? 0 : reorderQty(it), alreadyOrdered: pending, best: b };
  })).filter((x) => x.toOrder > 0);
}

router.get('/', async (req, res) => {
  const list = await items(req);
  const v = await amap(list, view);
  res.json({
    items: v,
    summary: { count: v.length, low: v.filter((x) => x.state === 'low').length, out: v.filter((x) => x.state === 'out').length, value: A.can(req, 'manager') ? Math.round(list.reduce((a, it) => a + it.quantity * it.unit_cost, 0)) : undefined },
    pendingOrders: (await db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE org_id = ? AND status = 'pending'").get(req.org.id)).c,
  });
});

router.get('/reorder', A.need('manager'), async (req, res) => res.json({ suggestions: await suggestions(req) }));

router.post('/items', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO stock_items (org_id, branch_id, name, unit, quantity, min_quantity, unit_cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, await A.branchOf(req, b.branchId), A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'article." }), A.text(b.unit, 20) || 'pièce',
    b.quantity === undefined || b.quantity === '' ? 0 : A.qty(b.quantity, { allowZero: true }), b.minQuantity === undefined || b.minQuantity === '' ? 0 : A.qty(b.minQuantity, { allowZero: true }), A.money0(b.unitCost), nowISO())).lastInsertRowid;
  const q = (await db.prepare('SELECT quantity FROM stock_items WHERE id = ?').get(id)).quantity;
  if (q > 0) await db.prepare('INSERT INTO stock_moves (org_id, item_id, delta, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, id, q, 'Stock de départ', req.user.id, nowISO());
  await A.logActivity(req.org.id, req.user.id, 'stock', `Article « ${A.text(b.name, 100)} » ajouté au stock`);
  res.status(201).json({ id: Number(id) });
});

router.put('/items/:id', A.need('manager'), async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const b = req.body || {};
  await db.prepare('UPDATE stock_items SET name = ?, unit = ?, min_quantity = ?, unit_cost = ? WHERE id = ?').run(
    b.name === undefined ? it.name : A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'article." }), b.unit === undefined ? it.unit : A.text(b.unit, 20) || 'pièce',
    b.minQuantity === undefined ? it.min_quantity : A.qty(b.minQuantity === '' ? 0 : b.minQuantity, { allowZero: true }), b.unitCost === undefined ? it.unit_cost : A.money0(b.unitCost), it.id);
  res.json({ ok: true });
});

router.delete('/items/:id', A.need('manager'), async (req, res) => {
  const it = await itemOf(req, req.params.id);
  await db.prepare('DELETE FROM stock_items WHERE id = ?').run(it.id);
  res.json({ ok: true });
});

/** Ajoute ou retire du stock et garde la trace. Refuse un stock négatif. */
async function applyMove(req, it, delta, reason) {
  const next = Math.round((it.quantity + delta) * 1000) / 1000;
  if (next < 0) throw new HttpError(400, `Stock insuffisant : il reste ${it.quantity} ${it.unit}.`);
  await db.transaction(async () => {
    await db.prepare('UPDATE stock_items SET quantity = ? WHERE id = ?').run(next, it.id);
    await db.prepare('INSERT INTO stock_moves (org_id, item_id, delta, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, it.id, delta, reason, req.user.id, nowISO());
  })();
  return next;
}

router.post('/items/:id/move', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const b = req.body || {};
  const kind = A.oneOf(b.kind, ['in', 'out'], undefined, 'Choisissez entrée ou sortie.');
  const q = A.qty(b.quantity);
  const next = await applyMove(req, it, kind === 'in' ? q : -q, A.text(b.reason, 150) || (kind === 'in' ? 'Entrée' : 'Sortie'));
  res.json({ quantity: next });
});

router.get('/items/:id/moves', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  res.json({ moves: await db.prepare('SELECT m.delta, m.reason, m.created_at AS at, u.name FROM stock_moves m LEFT JOIN users u ON u.id = m.created_by WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 30').all(it.id) });
});

// ---------- Fournisseurs et comparaison de prix ----------
router.get('/suppliers', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM suppliers WHERE org_id = ? ORDER BY name COLLATE NOCASE').all(req.org.id);
  res.json({ suppliers: rows.map((s) => ({ id: s.id, name: s.name, contact: A.can(req, 'manager') ? s.contact : undefined, notes: A.can(req, 'manager') ? s.notes : undefined })) });
});
router.post('/suppliers', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO suppliers (org_id, name, contact, notes, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du fournisseur.' }), A.text(b.contact, 150), A.text(b.notes, 500), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/suppliers/:id', A.need('manager'), async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  const b = req.body || {};
  await db.prepare('UPDATE suppliers SET name = ?, contact = ?, notes = ? WHERE id = ?').run(b.name === undefined ? s.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du fournisseur.' }), b.contact === undefined ? s.contact : A.text(b.contact, 150), b.notes === undefined ? s.notes : A.text(b.notes, 500), s.id);
  res.json({ ok: true });
});
router.delete('/suppliers/:id', A.need('manager'), async (req, res) => {
  const s = await supplierOf(req, req.params.id);
  await db.prepare('DELETE FROM suppliers WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

router.get('/items/:id/prices', A.need('manager'), async (req, res) => {
  const it = await itemOf(req, req.params.id);
  res.json({ prices: await db.prepare('SELECT p.supplier_id AS supplierId, s.name AS supplier, p.unit_price AS unitPrice, p.lead_days AS leadDays FROM supplier_prices p JOIN suppliers s ON s.id = p.supplier_id WHERE p.item_id = ? ORDER BY p.unit_price').all(it.id) });
});
router.put('/items/:id/prices', A.need('manager'), async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const list = (req.body || {}).prices;
  if (!Array.isArray(list) || list.length > 30) throw new HttpError(400, 'Liste de prix invalide.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM supplier_prices WHERE item_id = ?').run(it.id);
    for (const p of list) {
      const s = await supplierOf(req, p && p.supplierId);
      const lead = p.leadDays === undefined || p.leadDays === null || p.leadDays === '' ? null : Math.min(Math.max(Math.round(Number(p.leadDays)), 0), 365);
      await db.prepare('INSERT INTO supplier_prices (org_id, item_id, supplier_id, unit_price, lead_days) VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_id, supplier_id) DO UPDATE SET org_id = excluded.org_id, unit_price = excluded.unit_price, lead_days = excluded.lead_days').run(req.org.id, it.id, s.id, A.amount(p.unitPrice), Number.isFinite(lead) ? lead : null);
    }
  })();
  res.json({ ok: true });
});

// ---------- Commandes (achats) ----------
const orderView = (o) => ({ id: o.id, itemId: o.item_id, item: o.item, unit: o.unit, supplierId: o.supplier_id, supplier: o.supplier, quantity: o.quantity, unitPrice: o.unit_price, total: Math.round(o.quantity * o.unit_price), status: o.status, requestedBy: o.requested_by, at: o.created_at });

router.get('/orders', async (req, res) => {
  const sc = A.scope(req, 'i.branch_id');
  const rows = await db.prepare(`SELECT o.*, i.name AS item, i.unit, s.name AS supplier FROM purchase_orders o JOIN stock_items i ON i.id = o.item_id LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ?${sc.sql} ORDER BY CASE o.status WHEN 'pending' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END, o.id DESC LIMIT 60`).all(req.org.id, ...sc.args);
  res.json({ orders: rows.map(orderView) });
});

/** Crée des commandes « à valider » (utilisé par l'écran et par l'IA après validation). Le prix vient du fournisseur choisi, sinon du meilleur prix connu. */
async function createOrders(req, list) {
  if (!Array.isArray(list) || !list.length || list.length > 30) throw new HttpError(400, 'Aucune commande à créer.');
  let n = 0;
  await db.transaction(async () => {
    for (const x of list) {
      const it = await itemOf(req, x && x.itemId);
      const sid = A.idOrNull(x.supplierId);
      const sup = sid ? await supplierOf(req, sid) : null;
      const priceRow = sup ? await db.prepare('SELECT unit_price FROM supplier_prices WHERE item_id = ? AND supplier_id = ?').get(it.id, sup.id) : null;
      const best = !sup ? await bestPrice(it.id) : null;
      const price = x.unitPrice !== undefined && x.unitPrice !== '' && x.unitPrice !== null ? A.amount(x.unitPrice) : priceRow ? priceRow.unit_price : best ? best.unitPrice : it.unit_cost;
      const now = nowISO();
      await db.prepare("INSERT INTO purchase_orders (org_id, item_id, supplier_id, quantity, unit_price, status, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
        .run(req.org.id, it.id, sup ? sup.id : best ? best.supplierId : null, A.qty(x.quantity), price, req.user.id, now, now);
      n++;
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `${n} commande(s) à valider créée(s)`);
  return n;
}

router.post('/orders', async (req, res) => {
  const b = req.body || {};
  res.status(201).json({ created: await createOrders(req, Array.isArray(b.orders) ? b.orders : [b]) });
});

router.put('/orders/:id/status', A.need('manager'), async (req, res) => {
  const o = await db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!o) throw new HttpError(404, 'Commande introuvable.');
  const it = await itemOf(req, o.item_id);
  const status = A.oneOf((req.body || {}).status, ['ordered', 'received', 'cancelled'], undefined, 'Statut inconnu.');
  const ok = (o.status === 'pending' && ['ordered', 'cancelled'].includes(status)) || (o.status === 'ordered' && ['received', 'cancelled'].includes(status));
  if (!ok) throw new HttpError(400, 'Ce changement de statut est impossible.');
  if (o.status === 'pending' && status === 'ordered' && o.requested_by === req.user.id && !A.can(req, 'admin')) throw new HttpError(403, 'Une autre personne doit valider votre demande de commande.');
  await db.transaction(async () => {
    await db.prepare('UPDATE purchase_orders SET status = ?, decided_by = ?, updated_at = ? WHERE id = ?').run(status, req.user.id, nowISO(), o.id);
    if (status === 'received') {
      await applyMove(req, it, o.quantity, `Commande #${o.id} reçue`);
      if (o.unit_price > 0) {
        await db.prepare('UPDATE stock_items SET unit_cost = ? WHERE id = ?').run(o.unit_price, it.id);
        // La dépense est aussi inscrite au budget (catégorie « Achats »), pour que les chiffres restent d'accord.
        await db.prepare("INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, ?, 'expense', 'Achats', ?, ?, ?, ?, ?)")
          .run(req.org.id, it.branch_id, `Commande #${o.id} : ${it.name}`, Math.max(Math.round(o.quantity * o.unit_price), 1), nowISO().slice(0, 10), req.user.id, nowISO());
      }
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Commande de « ${it.name} » : ${{ ordered: 'validée', received: 'reçue', cancelled: 'annulée' }[status]}`);
  res.json({ ok: true });
});

module.exports = router;
module.exports.items = items;
module.exports.suggestions = suggestions;
module.exports.createOrders = createOrders;
module.exports.bestPrice = bestPrice;
