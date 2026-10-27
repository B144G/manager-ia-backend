'use strict';
// Sous-application « Stock et achats » : articles, mouvements, fournisseurs et comparaison de prix, commandes à valider, réceptions.
// Règle : une commande est d'abord « à valider » ; un responsable la valide (pas sa propre demande, sauf administrateur), puis on enregistre
// la réception (totale ou partielle) et le stock augmente automatiquement.
// Vague 1 : lots avec péremption (FEFO/FIFO), numéros de série / VIN, valorisation au coût moyen pondéré (CUMP), inventaire physique validé par
// un responsable, date promise et taux de retard des fournisseurs, stock maximum (surstock), SKU et code-barres, refus de supprimer un article utilisé.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const { amap, afilter, HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

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

const stateOf = (it) => (it.quantity <= 0 ? 'out' : it.quantity <= it.min_quantity && it.min_quantity > 0 ? 'low' : it.max_quantity > 0 && it.quantity > it.max_quantity ? 'over' : 'ok');
const view = async (it, mgr) => ({
  id: it.id, name: it.name, unit: it.unit, quantity: it.quantity, minQuantity: it.min_quantity, maxQuantity: it.max_quantity, unitCost: it.unit_cost, avgCost: mgr ? Math.round(L.unitValue(it) * 100) / 100 : undefined,
  value: mgr ? Math.round(it.quantity * L.unitValue(it)) : undefined, sku: it.sku, barcode: it.barcode, tracking: it.tracking, pickRule: it.pick_rule, branchId: it.branch_id,
  state: stateOf(it), best: await bestPrice(it.id),
});

/** Articles du stock visibles (filtrés par antenne). */
async function items(req) {
  const sc = A.scope(req);
  return await db.prepare(`SELECT * FROM stock_items WHERE org_id = ?${sc.sql} ORDER BY name COLLATE NOCASE`).all(req.org.id, ...sc.args);
}

/** Lots (avec quantité) qui périment dans `days` jours ou sont déjà périmés, pour les articles visibles. */
async function expiringLots(req, days = 30) {
  const sc = A.scope(req, 'i.branch_id');
  const limit = addDays(today(), days);
  return (await db.prepare(`SELECT l.*, i.name AS item, i.unit FROM stock_lots l JOIN stock_items i ON i.id = l.item_id WHERE l.org_id = ? AND l.quantity > 0 AND l.expiry IS NOT NULL AND l.expiry <= ?${sc.sql} ORDER BY l.expiry, l.id`).all(req.org.id, limit, ...sc.args))
    .map((l) => ({ id: l.id, itemId: l.item_id, item: l.item, unit: l.unit, lotNo: l.lot_no, expiry: l.expiry, quantity: l.quantity, expired: l.expiry < today(), daysLeft: Math.round((Date.parse(l.expiry) - Date.parse(today())) / 86400000) }));
}

/** Quantité conseillée pour revenir à deux fois le seuil (règle simple et explicable), sans dépasser le stock maximum s'il est fixé. */
const reorderQty = (it) => {
  const q = Math.max(Math.ceil((it.min_quantity * 2 - it.quantity) * 100) / 100, it.min_quantity || 1);
  return it.max_quantity > 0 ? Math.max(Math.min(q, Math.floor((it.max_quantity - it.quantity) * 100) / 100), 0) : q;
};

async function suggestions(req) {
  return (await amap((await items(req)).filter((it) => it.min_quantity > 0 && it.quantity <= it.min_quantity), async (it) => {
    const pending = (await db.prepare("SELECT COALESCE(SUM(quantity - received_qty),0) q FROM purchase_orders WHERE item_id = ? AND status IN ('pending','ordered','partial')").get(it.id)).q;
    const b = await bestPrice(it.id);
    return { itemId: it.id, name: it.name, unit: it.unit, quantity: it.quantity, minQuantity: it.min_quantity, toOrder: pending >= reorderQty(it) ? 0 : reorderQty(it), alreadyOrdered: pending, best: b };
  })).filter((x) => x.toOrder > 0);
}

router.get('/', async (req, res) => {
  const list = await items(req);
  const mgr = A.can(req, 'manager');
  const v = await amap(list, (it) => view(it, mgr));
  const exp = await expiringLots(req, 30);
  res.json({
    items: v,
    summary: { count: v.length, low: v.filter((x) => x.state === 'low').length, out: v.filter((x) => x.state === 'out').length, over: v.filter((x) => x.state === 'over').length, expiring: exp.filter((l) => !l.expired).length, expired: exp.filter((l) => l.expired).length,
      value: mgr ? Math.round(list.reduce((a, it) => a + it.quantity * L.unitValue(it), 0)) : undefined, valuation: 'cump' },
    pendingOrders: (await db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE org_id = ? AND status = 'pending'").get(req.org.id)).c,
  });
});

router.get('/reorder', A.need('manager'), async (req, res) => res.json({ suggestions: await suggestions(req) }));
router.get('/expiring', async (req, res) => res.json({ lots: await expiringLots(req, Math.min(Math.max(Number(req.query.days) || 30, 0), 365)) }));

// Recherche par code-barres ou SKU (lecteur, ou saisie).
router.get('/lookup', async (req, res) => {
  const code = A.text(req.query.code, 60, { required: true, msg: 'Indiquez un code-barres ou un SKU.' });
  const it = await db.prepare('SELECT * FROM stock_items WHERE org_id = ? AND (barcode = ? OR sku = ?)').get(req.org.id, code, code);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Aucun article avec ce code.');
  res.json({ item: await view(it, A.can(req, 'manager')) });
});

/** Champs d'un article validés (création ou modification). */
async function fields(req, b, cur) {
  const has = (k) => b[k] !== undefined;
  const sku = has('sku') ? A.text(b.sku, 40) : cur ? cur.sku : '';
  const barcode = has('barcode') ? A.text(b.barcode, 40) : cur ? cur.barcode : '';
  if (barcode && !/^[A-Za-z0-9._-]{4,40}$/.test(barcode)) throw new HttpError(400, 'Code-barres invalide : 4 à 40 lettres, chiffres, points ou tirets.');
  for (const [col, v, label] of [['sku', sku, 'SKU'], ['barcode', barcode, 'code-barres']]) {
    if (v && await db.prepare(`SELECT 1 FROM stock_items WHERE org_id = ? AND ${col} = ?${cur ? ' AND id <> ?' : ''}`).get(req.org.id, v, ...(cur ? [cur.id] : []))) throw new HttpError(409, `Ce ${label} est déjà utilisé par un autre article.`);
  }
  const min = has('minQuantity') ? (b.minQuantity === '' ? 0 : A.qty(b.minQuantity, { allowZero: true })) : cur ? cur.min_quantity : 0;
  const max = has('maxQuantity') ? (b.maxQuantity === '' ? 0 : A.qty(b.maxQuantity, { allowZero: true })) : cur ? cur.max_quantity : 0;
  if (max > 0 && min > max) throw new HttpError(400, 'Le stock maximum doit être supérieur au seuil d\'alerte.');
  return {
    name: has('name') || !cur ? A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'article." }) : cur.name,
    unit: has('unit') ? A.text(b.unit, 20) || 'pièce' : cur ? cur.unit : A.text(b.unit, 20) || 'pièce',
    min, max, sku, barcode, unitCost: has('unitCost') ? A.money0(b.unitCost) : cur ? cur.unit_cost : 0,
    tracking: has('tracking') ? A.oneOf(b.tracking, L.TRACKING, undefined, 'Suivi inconnu (aucun, par lot ou par numéro de série).') : cur ? cur.tracking : 'none',
    pickRule: has('pickRule') ? A.oneOf(b.pickRule, ['fefo', 'fifo'], undefined, 'Règle de sortie inconnue (FEFO ou FIFO).') : cur ? cur.pick_rule : 'fefo',
  };
}

router.post('/items', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const f = await fields(req, b, null);
  const q = b.quantity === undefined || b.quantity === '' ? 0 : A.qty(b.quantity, { allowZero: true });
  const id = await db.transaction(async () => {
    const iid = Number((await db.prepare('INSERT INTO stock_items (org_id, branch_id, name, unit, quantity, min_quantity, unit_cost, created_at, sku, barcode, max_quantity, tracking, pick_rule, avg_cost) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.org.id, await A.branchOf(req, b.branchId), f.name, f.unit, f.min, f.unitCost, nowISO(), f.sku, f.barcode, f.max, f.tracking, f.pickRule, f.unitCost)).lastInsertRowid);
    if (q > 0) await L.adjust(req, iid, q, 'Stock de départ', { unitCost: f.unitCost || undefined, lotNo: b.lotNo || 'INITIAL', expiry: A.date(b.expiry) || undefined, serials: b.serials });
    return iid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Article « ${f.name} » ajouté au stock`);
  res.status(201).json({ id });
});

router.put('/items/:id', A.need('manager'), async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const f = await fields(req, req.body || {}, it);
  await db.transaction(async () => {
    if (f.tracking !== it.tracking) {
      // Changer de suivi n'est possible que sans quantité en stock, sauf passage à « par lot » (la quantité existante devient le lot INITIAL).
      if (f.tracking === 'lot' && it.tracking === 'none') { if (it.quantity > 0) await db.prepare('INSERT INTO stock_lots (org_id, item_id, lot_no, expiry, quantity, unit_cost, received_at, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run(req.org.id, it.id, 'INITIAL', it.quantity, it.unit_cost, nowISO(), nowISO()); }
      else if (it.quantity > 0) throw new HttpError(400, `Pour changer le suivi de « ${it.name} », sa quantité doit d'abord être à zéro (sortie ou inventaire).`);
    }
    await db.prepare('UPDATE stock_items SET name = ?, unit = ?, min_quantity = ?, max_quantity = ?, unit_cost = ?, sku = ?, barcode = ?, tracking = ?, pick_rule = ? WHERE id = ?').run(f.name, f.unit, f.min, f.max, f.unitCost, f.sku, f.barcode, f.tracking, f.pickRule, it.id);
  })();
  res.json({ ok: true });
});

/** Ce qui lie déjà un article au reste de l'application (pour refuser sa suppression). */
async function usage(it) {
  const n = async (sql, ...a) => Number((await db.prepare(sql).get(...a)).c);
  const parts = [
    [await n("SELECT COUNT(*) c FROM stock_moves WHERE item_id = ? AND reason <> 'Stock de départ'", it.id), 'mouvement(s) de stock'],
    [await n('SELECT COUNT(*) c FROM purchase_orders WHERE item_id = ?', it.id), 'commande(s) d\'achat'],
    [await n('SELECT COUNT(*) c FROM production_bom_lines WHERE item_id = ?', it.id) + await n('SELECT COUNT(*) c FROM production_boms WHERE product_id = ?', it.id), 'nomenclature(s) de production'],
    [await n('SELECT COUNT(*) c FROM maintenance_parts WHERE item_id = ?', it.id), 'pièce(s) de maintenance'],
    [await n('SELECT COUNT(*) c FROM logistics_delivery_items WHERE item_id = ?', it.id), 'ligne(s) de livraison'],
    [await n('SELECT COUNT(*) c FROM stock_count_lines WHERE item_id = ?', it.id), 'ligne(s) d\'inventaire'],
    [await n('SELECT COUNT(*) c FROM stock_serials WHERE item_id = ?', it.id), 'numéro(s) de série'],
  ].filter((x) => x[0] > 0);
  return parts;
}

router.delete('/items/:id', A.need('manager'), async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const used = await usage(it);
  if (used.length || it.quantity > 0) throw new HttpError(409, `« ${it.name} » ne peut pas être supprimé : ${used.length ? 'il est utilisé (' + used.map((x) => `${x[0]} ${x[1]}`).join(', ') + ')' : `il reste ${it.quantity} ${it.unit} en stock`}. Sortez le stock restant ou gardez l'article pour conserver l'historique.`);
  await db.prepare('DELETE FROM stock_items WHERE id = ?').run(it.id);
  res.json({ ok: true });
});

/** Ajoute ou retire du stock et garde la trace (lots, séries et coût moyen compris). Refuse un stock négatif. */
async function applyMove(req, it, delta, reason, opts) {
  return (await L.adjust(req, it, delta, reason, opts)).quantity;
}

router.post('/items/:id/move', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const b = req.body || {};
  const kind = A.oneOf(b.kind, ['in', 'out'], undefined, 'Choisissez entrée ou sortie.');
  const serials = it.tracking === 'serial' ? L.parseSerials(b.serials) : undefined;
  const q = it.tracking === 'serial' && (b.quantity === undefined || b.quantity === '') ? serials.length : A.qty(b.quantity);
  if (kind === 'in' && b.unitCost !== undefined && b.unitCost !== '' && !A.can(req, 'manager')) throw new HttpError(403, "Seul un responsable peut valoriser une entrée.");
  const r = await L.adjust(req, it, kind === 'in' ? q : -q, A.text(b.reason, 150) || (kind === 'in' ? 'Entrée' : 'Sortie'),
    { strict: true, lotNo: A.text(b.lotNo, 40), expiry: A.date(b.expiry) || undefined, serials, unitCost: kind === 'in' && b.unitCost !== undefined && b.unitCost !== '' ? A.amount(b.unitCost) : undefined });
  res.json({ quantity: r.quantity, lots: r.allocations.map((a) => ({ lotNo: a.lotNo, expiry: a.expiry, quantity: a.quantity })) });
});

router.get('/items/:id/moves', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  res.json({ moves: await db.prepare('SELECT m.delta, m.reason, m.created_at AS at, u.name FROM stock_moves m LEFT JOIN users u ON u.id = m.created_by WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 30').all(it.id) });
});

// Lots (avec péremption) et numéros de série d'un article.
router.get('/items/:id/lots', async (req, res) => {
  const it = await itemOf(req, req.params.id);
  const t = today();
  const lots = await db.prepare('SELECT * FROM stock_lots WHERE item_id = ? AND quantity > 0 ORDER BY expiry IS NULL, expiry, received_at, id').all(it.id);
  const serials = await db.prepare('SELECT serial, status, received_at, out_at, out_note FROM stock_serials WHERE item_id = ? ORDER BY id DESC LIMIT 300').all(it.id);
  res.json({ tracking: it.tracking, rule: it.pick_rule, unit: it.unit,
    lots: lots.map((l) => ({ id: l.id, lotNo: l.lot_no, expiry: l.expiry, quantity: l.quantity, expired: Boolean(l.expiry && l.expiry < t), daysLeft: l.expiry ? Math.round((Date.parse(l.expiry) - Date.parse(t)) / 86400000) : null })),
    serials: serials.map((s) => ({ serial: s.serial, status: s.status, receivedAt: s.received_at, outAt: s.out_at, note: s.out_note })) });
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
const isLateOrder = (o) => Boolean(o.promised_date) && (['ordered', 'partial'].includes(o.status) ? o.promised_date < today() : o.status === 'received' && o.received_at && o.received_at.slice(0, 10) > o.promised_date);
const orderView = (o) => ({ id: o.id, itemId: o.item_id, item: o.item, unit: o.unit, supplierId: o.supplier_id, supplier: o.supplier, quantity: o.quantity, unitPrice: o.unit_price, total: Math.round(o.quantity * o.unit_price), status: o.status,
  receivedQty: o.received_qty, remaining: Math.max(Math.round((o.quantity - o.received_qty) * 1000) / 1000, 0), promisedDate: o.promised_date, receivedAt: o.received_at, late: isLateOrder(o), tracking: o.tracking, requestedBy: o.requested_by, at: o.created_at });

router.get('/orders', async (req, res) => {
  const sc = A.scope(req, 'i.branch_id');
  const rows = await db.prepare(`SELECT o.*, i.name AS item, i.unit, i.tracking, s.name AS supplier FROM purchase_orders o JOIN stock_items i ON i.id = o.item_id LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ?${sc.sql} ORDER BY CASE o.status WHEN 'pending' THEN 0 WHEN 'ordered' THEN 1 WHEN 'partial' THEN 1 ELSE 2 END, o.id DESC LIMIT 60`).all(req.org.id, ...sc.args);
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
      await db.prepare("INSERT INTO purchase_orders (org_id, item_id, supplier_id, quantity, unit_price, status, requested_by, created_at, updated_at, promised_date) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)")
        .run(req.org.id, it.id, sup ? sup.id : best ? best.supplierId : null, A.qty(x.quantity), price, req.user.id, now, now, A.date(x.promisedDate));
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

const orderOf = async (req, id) => {
  const o = await db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!o) throw new HttpError(404, 'Commande introuvable.');
  return o;
};

// Date promise par le fournisseur (sert au calcul du taux de retard).
router.put('/orders/:id', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  await itemOf(req, o.item_id);
  if (['received', 'cancelled'].includes(o.status)) throw new HttpError(400, 'Cette commande est terminée.');
  await db.prepare('UPDATE purchase_orders SET promised_date = ?, updated_at = ? WHERE id = ?').run((req.body || {}).promisedDate === undefined ? o.promised_date : A.date(req.body.promisedDate), nowISO(), o.id);
  res.json({ ok: true });
});

/** Réception (totale ou partielle) : entre en stock (lot / séries / CUMP), enregistre la réception, inscrit la dépense au budget. Dans une transaction. */
async function receive(req, o, it, qtyIn, opts = {}) {
  const remaining = Math.round((o.quantity - o.received_qty) * 1000) / 1000;
  const q = qtyIn === undefined || qtyIn === '' || qtyIn === null ? remaining : A.qty(qtyIn);
  if (q > remaining + 1e-9) throw new HttpError(400, `Il ne reste que ${remaining} ${it.unit} à recevoir sur cette commande.`);
  const price = opts.unitPrice !== undefined && opts.unitPrice !== '' && opts.unitPrice !== null ? A.amount(opts.unitPrice) : o.unit_price;
  const done = Math.round((o.received_qty + q) * 1000) / 1000;
  const complete = done >= o.quantity - 1e-9;
  await db.transaction(async () => {
    await L.adjust(req, it, q, complete && o.received_qty === 0 ? `Commande #${o.id} reçue` : `Commande #${o.id} : réception ${complete ? 'du solde' : 'partielle'}`,
      { unitCost: price > 0 ? price : undefined, lotNo: opts.lotNo || `CMD-${o.id}`, expiry: opts.expiry, serials: opts.serials, strict: opts.strict, refKind: 'order', refId: o.id });
    await db.prepare('INSERT INTO purchase_receipts (org_id, order_id, quantity, unit_price, lot_no, expiry, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, o.id, q, price, opts.lotNo || '', opts.expiry || null, A.text(opts.note, 200), req.user.id, nowISO());
    await db.prepare('UPDATE purchase_orders SET status = ?, received_qty = ?, received_at = ?, decided_by = COALESCE(decided_by, ?), updated_at = ? WHERE id = ?').run(complete ? 'received' : 'partial', done, nowISO(), req.user.id, nowISO(), o.id);
    if (price > 0) {
      await db.prepare('UPDATE stock_items SET unit_cost = ? WHERE id = ?').run(price, it.id);
      // La dépense est aussi inscrite au budget (catégorie « Achats »), pour que les chiffres restent d'accord.
      await db.prepare("INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, ?, 'expense', 'Achats', ?, ?, ?, ?, ?)")
        .run(req.org.id, it.branch_id, `Commande #${o.id} : ${it.name}${complete ? '' : ' (réception partielle)'}`, Math.max(Math.round(q * price), 1), today(), req.user.id, nowISO());
    }
  })();
  return { received: q, receivedQty: done, status: complete ? 'received' : 'partial' };
}

router.post('/orders/:id/receive', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const it = await itemOf(req, o.item_id);
  if (!['ordered', 'partial'].includes(o.status)) throw new HttpError(400, o.status === 'pending' ? "Validez d'abord la commande avant d'enregistrer une réception." : 'Cette commande est terminée.');
  const b = req.body || {};
  if (it.tracking === 'lot' && !A.text(b.lotNo, 40)) throw new HttpError(400, `« ${it.name} » est suivi par lot : indiquez le numéro de lot reçu.`);
  const serials = it.tracking === 'serial' ? L.parseSerials(b.serials) : undefined;
  const r = await receive(req, o, it, it.tracking === 'serial' && (b.quantity === undefined || b.quantity === '') ? serials.length : b.quantity, { lotNo: A.text(b.lotNo, 40), expiry: A.date(b.expiry) || undefined, serials, unitPrice: b.unitPrice, note: b.note, strict: true });
  await A.logActivity(req.org.id, req.user.id, 'stock', `Commande de « ${it.name} » : ${r.status === 'received' ? 'reçue' : 'réception partielle'} (${r.received})`);
  res.json(r);
});

router.put('/orders/:id/status', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const it = await itemOf(req, o.item_id);
  const status = A.oneOf((req.body || {}).status, ['ordered', 'received', 'cancelled'], undefined, 'Statut inconnu.');
  const ok = (o.status === 'pending' && ['ordered', 'cancelled'].includes(status)) || (['ordered', 'partial'].includes(o.status) && ['received', 'cancelled'].includes(status));
  if (!ok) throw new HttpError(400, 'Ce changement de statut est impossible.');
  if (o.status === 'pending' && status === 'ordered' && o.requested_by === req.user.id && !A.can(req, 'admin')) throw new HttpError(403, 'Une autre personne doit valider votre demande de commande.');
  if (status === 'received') {
    if (it.tracking === 'serial') throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : enregistrez la réception avec les numéros.`);
    await receive(req, o, it, undefined, {});
  } else {
    await db.prepare('UPDATE purchase_orders SET status = ?, decided_by = ?, updated_at = ?, promised_date = COALESCE(?, promised_date) WHERE id = ?').run(status, req.user.id, nowISO(), A.date((req.body || {}).promisedDate), o.id);
  }
  await A.logActivity(req.org.id, req.user.id, 'stock', `Commande de « ${it.name} » : ${{ ordered: 'validée', received: 'reçue', cancelled: 'annulée' }[status]}`);
  res.json({ ok: true });
});

// Fiabilité des fournisseurs : part des commandes livrées en retard par rapport à la date promise, retard moyen, taux de livraison.
async function supplierStats(req) {
  const rows = await db.prepare(`SELECT o.*, s.name AS supplier FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND o.status IN ('ordered','partial','received','cancelled') ORDER BY o.id`).all(req.org.id);
  const by = new Map();
  for (const o of rows) {
    const s = by.get(o.supplier_id) || { supplierId: o.supplier_id, supplier: o.supplier, orders: 0, promised: 0, onTime: 0, late: 0, delayDays: 0, qtyOrdered: 0, qtyReceived: 0 };
    by.set(o.supplier_id, s);
    s.orders++;
    if (o.status !== 'cancelled') { s.qtyOrdered += o.quantity; s.qtyReceived += o.received_qty; }
    if (!o.promised_date || o.status === 'cancelled') continue;
    if (o.status === 'received' && o.received_at) {
      s.promised++;
      const d = Math.round((Date.parse(o.received_at.slice(0, 10)) - Date.parse(o.promised_date)) / 86400000);
      if (d > 0) { s.late++; s.delayDays += d; } else s.onTime++;
    } else if (o.promised_date < today()) { s.promised++; s.late++; s.delayDays += Math.round((Date.parse(today()) - Date.parse(o.promised_date)) / 86400000); }
  }
  return [...by.values()].map((s) => ({ supplierId: s.supplierId, supplier: s.supplier, orders: s.orders, promised: s.promised, onTime: s.onTime, late: s.late, lateRate: s.promised ? Math.round((100 * s.late) / s.promised) : null,
    avgDelayDays: s.late ? Math.round((s.delayDays / s.late) * 10) / 10 : 0, fillRate: s.qtyOrdered ? Math.round((100 * s.qtyReceived) / s.qtyOrdered) : null }));
}
router.get('/supplier-stats', A.need('manager'), async (req, res) => res.json({ suppliers: await supplierStats(req) }));

// ---------- Inventaire physique : comptage -> écart valorisé -> ajustement tracé, validé par un responsable ----------
const countOf = async (req, id) => {
  const c = await db.prepare('SELECT * FROM stock_counts WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!c || !A.visible(req, c)) throw new HttpError(404, 'Inventaire introuvable.');
  return c;
};
async function countView(req, c, withLines) {
  const mgr = A.can(req, 'manager');
  const lines = await db.prepare('SELECT l.*, i.name, i.unit, i.tracking FROM stock_count_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.count_id = ? ORDER BY i.name COLLATE NOCASE').all(c.id);
  const gaps = lines.filter((l) => l.counted !== null).map((l) => ({ gap: Math.round((l.counted - l.expected) * 1000) / 1000, value: Math.round((l.counted - l.expected) * l.unit_value) }));
  const out = { id: c.id, seq: c.seq, code: `INV-${c.created_at.slice(0, 4)}-${String(c.seq).padStart(3, '0')}`, status: c.status, note: c.note, createdAt: c.created_at, submittedAt: c.submitted_at, decidedAt: c.decided_at, decisionNote: c.decision_note, createdBy: c.created_by,
    lines: lines.length, counted: lines.filter((l) => l.counted !== null).length, withGap: gaps.filter((g) => g.gap !== 0).length,
    gapValue: mgr ? gaps.reduce((a, g) => a + g.value, 0) : undefined, shortValue: mgr ? gaps.filter((g) => g.value < 0).reduce((a, g) => a + g.value, 0) : undefined, surplusValue: mgr ? gaps.filter((g) => g.value > 0).reduce((a, g) => a + g.value, 0) : undefined };
  if (withLines) out.items = lines.map((l) => ({ itemId: l.item_id, name: l.name, unit: l.unit, tracking: l.tracking, expected: l.expected, counted: l.counted, gap: l.counted === null ? null : Math.round((l.counted - l.expected) * 1000) / 1000, unitValue: mgr ? l.unit_value : undefined, gapValue: mgr && l.counted !== null ? Math.round((l.counted - l.expected) * l.unit_value) : undefined }));
  return out;
}

router.get('/counts', async (req, res) => {
  const sc = A.scope(req);
  const rows = await db.prepare(`SELECT * FROM stock_counts WHERE org_id = ?${sc.sql} ORDER BY id DESC LIMIT 30`).all(req.org.id, ...sc.args);
  res.json({ counts: await amap(rows, (c) => countView(req, c, false)) });
});
router.post('/counts', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  if (await db.prepare("SELECT 1 FROM stock_counts WHERE org_id = ? AND status IN ('open','submitted')").get(req.org.id)) throw new HttpError(409, 'Un inventaire est déjà en cours : terminez-le (validation ou rejet) avant d\'en ouvrir un autre.');
  const list = (await items(req)).filter((i) => i.tracking !== 'serial');
  if (!list.length) throw new HttpError(400, 'Aucun article à compter (les articles suivis par numéro de série se contrôlent par leur liste de numéros).');
  const now = nowISO();
  const id = await db.transaction(async () => {
    const seq = Number((await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM stock_counts WHERE org_id = ?').get(req.org.id)).n);
    const cid = Number((await db.prepare('INSERT INTO stock_counts (org_id, branch_id, seq, status, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, await A.branchOf(req, b.branchId === undefined ? req.member.branch_id : b.branchId), seq, 'open', A.text(b.note, 300), req.user.id, now)).lastInsertRowid);
    for (const it of list) await db.prepare('INSERT INTO stock_count_lines (count_id, item_id, expected, unit_value) VALUES (?, ?, ?, ?)').run(cid, it.id, it.quantity, L.unitValue(it));
    return cid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', 'Inventaire physique ouvert');
  res.status(201).json({ id });
});
router.get('/counts/:id', async (req, res) => res.json({ count: await countView(req, await countOf(req, req.params.id), true) }));
router.put('/counts/:id/lines', async (req, res) => {
  const c = await countOf(req, req.params.id);
  if (c.status !== 'open') throw new HttpError(400, 'Ce comptage est terminé : il ne se modifie plus.');
  const list = (req.body || {}).lines;
  if (!Array.isArray(list) || !list.length || list.length > 1000) throw new HttpError(400, 'Liste de comptages invalide.');
  await db.transaction(async () => {
    for (const x of list) {
      const counted = x.counted === null || x.counted === '' || x.counted === undefined ? null : A.qty(x.counted, { allowZero: true });
      const r = await db.prepare('UPDATE stock_count_lines SET counted = ? WHERE count_id = ? AND item_id = ?').run(counted, c.id, A.id(x.itemId));
      if (!r.changes) throw new HttpError(404, 'Article absent de cet inventaire.');
    }
  })();
  res.json({ ok: true });
});
router.post('/counts/:id/submit', async (req, res) => {
  const c = await countOf(req, req.params.id);
  if (c.status !== 'open') throw new HttpError(400, 'Ce comptage a déjà été soumis.');
  const n = (await db.prepare('SELECT COUNT(*) c FROM stock_count_lines WHERE count_id = ? AND counted IS NOT NULL').get(c.id)).c;
  if (!n) throw new HttpError(400, "Saisissez d'abord au moins une quantité comptée.");
  await db.prepare("UPDATE stock_counts SET status = 'submitted', submitted_at = ? WHERE id = ?").run(nowISO(), c.id);
  await A.logActivity(req.org.id, req.user.id, 'stock', `Inventaire #${c.seq} soumis à validation`);
  res.json({ ok: true });
});
// Validation : seul un responsable (pas la personne qui a ouvert l'inventaire, sauf administrateur) ; ajuste le stock, une ligne d'historique par écart.
router.post('/counts/:id/validate', A.need('manager'), async (req, res) => {
  const c = await countOf(req, req.params.id);
  if (c.status !== 'submitted') throw new HttpError(400, "Seul un inventaire soumis peut être validé.");
  if (c.created_by === req.user.id && !A.can(req, 'admin')) throw new HttpError(403, "Une autre personne doit valider cet inventaire (vous l'avez ouvert).");
  const lines = await db.prepare('SELECT * FROM stock_count_lines WHERE count_id = ? AND counted IS NOT NULL').all(c.id);
  let adjusted = 0; let value = 0;
  await db.transaction(async () => {
    for (const l of lines) {
      const gap = Math.round((l.counted - l.expected) * 1000) / 1000;
      if (!gap) continue;
      const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(l.item_id, req.org.id);
      if (!it || !A.visible(req, it)) continue;
      await L.adjust(req, it, gap, `Inventaire #${c.seq} : ajustement`, { lotNo: `INV-${c.seq}`, refKind: 'count', refId: c.id, allowExpired: true });
      adjusted++; value += Math.round(gap * l.unit_value);
    }
    await db.prepare("UPDATE stock_counts SET status = 'validated', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(req.user.id, nowISO(), A.text((req.body || {}).note, 300), c.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Inventaire #${c.seq} validé : ${adjusted} ajustement(s), écart ${value} ${req.org.currency}`);
  res.json({ adjusted, gapValue: value });
});
router.post('/counts/:id/reject', A.need('manager'), async (req, res) => {
  const c = await countOf(req, req.params.id);
  if (c.status !== 'submitted') throw new HttpError(400, "Seul un inventaire soumis peut être rejeté.");
  await db.prepare("UPDATE stock_counts SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(req.user.id, nowISO(), A.text((req.body || {}).note, 300), c.id);
  res.json({ ok: true });
});
router.delete('/counts/:id', A.need('manager'), async (req, res) => {
  const c = await countOf(req, req.params.id);
  if (c.status !== 'open') throw new HttpError(400, 'Seul un inventaire encore ouvert peut être abandonné.');
  await db.prepare('DELETE FROM stock_counts WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.items = items;
module.exports.suggestions = suggestions;
module.exports.createOrders = createOrders;
module.exports.bestPrice = bestPrice;
module.exports.expiringLots = expiringLots;
module.exports.supplierStats = supplierStats;
module.exports.isLateOrder = isLateOrder;
