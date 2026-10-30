'use strict';
// Sous-application « Production » : nomenclatures (recettes), coût de revient, ordres de fabrication, planification.
// Règles : tout le monde peut consulter ; les responsables créent, lancent et clôturent. À la clôture, dans UNE transaction, les matières
// consommées sortent du stock et le produit fini y entre (mouvements « Production OF-xxxx »). Les coûts ne sont vus que par les responsables.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const U = require('./ops-util');
const { amap, HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const STATUS = ['draft', 'launched', 'done', 'cancelled'];

// ---------- Nomenclatures ----------
const bomRows = async (req, id) => {
  const sc = A.scope(req, 'i.branch_id');
  return await db.prepare(`SELECT b.*, i.name AS product_name, i.unit AS product_unit, i.quantity AS product_qty, i.unit_cost AS product_cost FROM production_boms b JOIN stock_items i ON i.id = b.product_id WHERE b.org_id = ?${id ? ' AND b.id = ?' : ''}${sc.sql} ORDER BY i.name COLLATE NOCASE`).all(req.org.id, ...(id ? [id] : []), ...sc.args);
};
const bomLines = async (bomId) => await db.prepare('SELECT l.id, l.item_id, l.quantity, i.name, i.unit, i.unit_cost, i.quantity AS stock FROM production_bom_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.bom_id = ? ORDER BY l.id').all(bomId);

/** Coût de revient d'UNE unité : matières (au dernier coût d'achat connu, celui de la fiche stock) + main-d'œuvre + autres frais. */
const costOf = (b, lines) => {
  const material = Math.round(lines.reduce((a, l) => a + l.quantity * l.unit_cost, 0));
  return { material, labor: b.labor_cost, other: b.other_cost, unit: material + b.labor_cost + b.other_cost };
};
/** Combien d'unités peut-on fabriquer avec le stock actuel (et quelle matière limite). */
const capacityOf = (lines) => {
  if (!lines.length) return { max: 0, limiting: null };
  let max = Infinity; let limiting = null;
  for (const l of lines) { const m = Math.floor(l.stock / l.quantity + 1e-9); if (m < max) { max = m; limiting = l.name; } }
  return { max: Math.max(max, 0), limiting };
};

async function bomView(req, b) {
  const lines = await bomLines(b.id);
  const mgr = A.can(req, 'manager');
  const c = costOf(b, lines);
  const cap = capacityOf(lines);
  return {
    id: b.id, productId: b.product_id, product: b.product_name, unit: b.product_unit, notes: b.notes,
    laborCost: mgr ? b.labor_cost : undefined, otherCost: mgr ? b.other_cost : undefined,
    materialCost: mgr ? c.material : undefined, unitCost: mgr ? c.unit : undefined,
    maxQuantity: cap.max, limiting: cap.limiting,
    lines: lines.map((l) => ({ itemId: l.item_id, name: l.name, unit: l.unit, quantity: l.quantity, stock: l.stock, unitCost: mgr ? l.unit_cost : undefined, lineCost: mgr ? Math.round(l.quantity * l.unit_cost) : undefined })),
  };
}

const bomOf = async (req, id) => {
  const b = (await bomRows(req, A.id(id)))[0];
  if (!b) throw new HttpError(404, 'Nomenclature introuvable.');
  return b;
};

async function readLines(req, productId, list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Ajoutez au moins une matière à la nomenclature.');
  if (list.length > 40) throw new HttpError(400, 'Trop de matières (40 au plus).');
  const seen = new Set();
  const out = [];
  for (const l of list) {
    const it = await U.stockItem(req, l && l.itemId);
    if (it.id === productId) throw new HttpError(400, 'Le produit fini ne peut pas être sa propre matière.');
    if (seen.has(it.id)) throw new HttpError(400, `« ${it.name} » apparaît deux fois : regroupez les quantités.`);
    seen.add(it.id);
    out.push({ itemId: it.id, quantity: A.qty(l.quantity) });
  }
  return out;
}

router.get('/boms', async (req, res) => res.json({ boms: await amap(await bomRows(req), (b) => bomView(req, b)) }));

router.post('/boms', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const product = await U.stockItem(req, b.productId);
  if (await db.prepare('SELECT 1 FROM production_boms WHERE product_id = ?').get(product.id)) throw new HttpError(400, 'Ce produit a déjà une nomenclature : modifiez-la.');
  const lines = await readLines(req, product.id, b.lines);
  const labor = U.nonneg(b.laborCost, 0, { int: true }); const other = U.nonneg(b.otherCost, 0, { int: true });
  let id;
  await db.transaction(async () => {
    id = (await db.prepare('INSERT INTO production_boms (org_id, product_id, labor_cost, other_cost, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, product.id, labor, other, A.text(b.notes, 500), nowISO())).lastInsertRowid;
    for (const l of lines) await db.prepare('INSERT INTO production_bom_lines (org_id, bom_id, item_id, quantity) VALUES (?, ?, ?, ?)').run(req.org.id, id, l.itemId, l.quantity);
  })();
  await A.logActivity(req.org.id, req.user.id, 'production', `Nomenclature de « ${product.name} » créée`);
  res.status(201).json({ id: Number(id) });
});

router.put('/boms/:id', A.need('manager'), async (req, res) => {
  const cur = await bomOf(req, req.params.id);
  const b = req.body || {};
  const lines = b.lines === undefined ? null : await readLines(req, cur.product_id, b.lines);
  await db.transaction(async () => {
    await db.prepare('UPDATE production_boms SET labor_cost = ?, other_cost = ?, notes = ? WHERE id = ?').run(
      b.laborCost === undefined ? cur.labor_cost : U.nonneg(b.laborCost, 0, { int: true }), b.otherCost === undefined ? cur.other_cost : U.nonneg(b.otherCost, 0, { int: true }), b.notes === undefined ? cur.notes : A.text(b.notes, 500), cur.id);
    if (lines) {
      await db.prepare('DELETE FROM production_bom_lines WHERE bom_id = ?').run(cur.id);
      for (const l of lines) await db.prepare('INSERT INTO production_bom_lines (org_id, bom_id, item_id, quantity) VALUES (?, ?, ?, ?)').run(req.org.id, cur.id, l.itemId, l.quantity);
    }
  })();
  res.json({ ok: true });
});

router.delete('/boms/:id', A.need('manager'), async (req, res) => {
  const cur = await bomOf(req, req.params.id);
  if (await db.prepare("SELECT 1 FROM production_orders WHERE bom_id = ? AND status IN ('draft','launched')").get(cur.id)) throw new HttpError(400, 'Des ordres de fabrication en cours utilisent cette nomenclature : annulez-les d\'abord.');
  await db.prepare('DELETE FROM production_boms WHERE id = ?').run(cur.id);
  res.json({ ok: true });
});

// ---------- Besoins en matières ----------
/** Besoin pour fabriquer `quantity` unités : par matière, besoin / en stock / manque. */
const needsFor = (lines, quantity) => lines.map((l) => {
  const needed = U.round3(l.quantity * quantity);
  return { itemId: l.item_id, name: l.name, unit: l.unit, needed, inStock: l.stock, missing: Math.max(U.round3(needed - l.stock), 0), unitCost: l.unit_cost };
});

// ---------- Ordres de fabrication ----------
const orderRows = async (req, id) => {
  return await db.prepare(`SELECT o.*, i.unit AS product_unit FROM production_orders o LEFT JOIN stock_items i ON i.id = o.product_id WHERE o.org_id = ?${id ? ' AND o.id = ?' : ''} ORDER BY CASE o.status WHEN 'launched' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, o.id DESC${id ? '' : ' LIMIT 100'}`).all(req.org.id, ...(id ? [id] : []));
};
const orderOf = async (req, id) => {
  const o = (await orderRows(req, A.id(id)))[0];
  if (!o) throw new HttpError(404, 'Ordre de fabrication introuvable.');
  return o;
};
const orderView = (req, o) => {
  const mgr = A.can(req, 'manager');
  return {
    id: o.id, code: o.code, bomId: o.bom_id, productId: o.product_id, product: o.product_name, unit: o.product_unit || '', quantity: o.quantity, dueDate: o.due_date, status: o.status,
    producedQty: o.produced_qty, scrapQty: o.scrap_qty, unitCost: mgr && o.status === 'done' ? o.unit_cost : undefined, totalCost: mgr && o.status === 'done' ? o.total_cost : undefined,
    notes: o.notes, createdAt: o.created_at, launchedAt: o.launched_at, closedAt: o.closed_at, late: Boolean(o.due_date && o.due_date < U.today() && ['draft', 'launched'].includes(o.status)),
  };
};

/** Matières nécessaires à un ordre (selon la nomenclature actuelle). */
async function orderNeeds(o) {
  if (!o.bom_id) throw new HttpError(400, 'La nomenclature de cet ordre a été supprimée : créez-en une nouvelle pour ce produit.');
  return needsFor(await bomLines(o.bom_id), o.quantity);
}

router.get('/', async (req, res) => {
  const rows = await orderRows(req);
  const { from, to } = A.monthRange();
  const done = rows.filter((o) => o.status === 'done' && o.closed_at >= from && o.closed_at < to);
  const produced = done.reduce((a, o) => a + o.produced_qty, 0);
  const scrap = done.reduce((a, o) => a + o.scrap_qty, 0);
  const mgr = A.can(req, 'manager');
  res.json({
    orders: rows.map((o) => orderView(req, o)),
    summary: {
      inProgress: rows.filter((o) => o.status === 'launched').length, drafts: rows.filter((o) => o.status === 'draft').length, late: rows.filter((o) => orderView(req, o).late).length,
      monthProduced: produced, monthScrap: scrap, yieldPct: produced + scrap > 0 ? Math.round(produced / (produced + scrap) * 1000) / 10 : null,
      avgUnitCost: mgr && produced > 0 ? Math.round(done.reduce((a, o) => a + o.unit_cost * o.produced_qty, 0) / produced) : undefined,
    },
  });
});

router.post('/orders', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const bom = await bomOf(req, b.bomId);
  const q = A.qty(b.quantity);
  const due = A.date(b.dueDate);
  let id;
  await db.transaction(async () => {
    const seq = (await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM production_orders WHERE org_id = ?').get(req.org.id)).n;
    id = (await db.prepare("INSERT INTO production_orders (org_id, seq, code, bom_id, product_id, product_name, quantity, due_date, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)")
      .run(req.org.id, seq, `OF-${String(seq).padStart(4, '0')}`, bom.id, bom.product_id, bom.product_name, q, due, A.text(b.notes, 500), req.user.id, nowISO())).lastInsertRowid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'production', `Ordre de fabrication créé : ${q} × « ${bom.product_name} »`);
  res.status(201).json({ id: Number(id) });
});

router.put('/orders/:id', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'draft') throw new HttpError(400, 'Seul un ordre en brouillon peut être modifié.');
  const b = req.body || {};
  await db.prepare('UPDATE production_orders SET quantity = ?, due_date = ?, notes = ? WHERE id = ?').run(b.quantity === undefined ? o.quantity : A.qty(b.quantity), b.dueDate === undefined ? o.due_date : A.date(b.dueDate), b.notes === undefined ? o.notes : A.text(b.notes, 500), o.id);
  res.json({ ok: true });
});

router.delete('/orders/:id', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['draft', 'cancelled'].includes(o.status)) throw new HttpError(400, 'Un ordre lancé ou terminé ne se supprime pas : annulez-le ou gardez-le dans l\'historique.');
  await db.prepare('DELETE FROM production_orders WHERE id = ?').run(o.id);
  res.json({ ok: true });
});

/** Vérifie la disponibilité des matières pour cet ordre (liste des manques). */
router.get('/orders/:id/check', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const needs = await orderNeeds(o);
  res.json({ ok: needs.every((n) => !n.missing), needs, shortages: needs.filter((n) => n.missing > 0) });
});

router.post('/orders/:id/launch', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être lancé.');
  const needs = await orderNeeds(o);
  const shortages = needs.filter((n) => n.missing > 0);
  if (shortages.length && !(req.body || {}).force) return res.status(409).json({ error: 'Matières manquantes : ' + shortages.map((s) => `${s.name} (il manque ${s.missing} ${s.unit})`).join(', ') + '.', shortages });
  await db.prepare("UPDATE production_orders SET status = 'launched', launched_at = ? WHERE id = ?").run(U.today(), o.id);
  await A.logActivity(req.org.id, req.user.id, 'production', `${o.code} lancé${shortages.length ? ' (avec des matières manquantes)' : ''}`);
  res.json({ ok: true, shortages });
});

router.post('/orders/:id/cancel', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['draft', 'launched'].includes(o.status)) throw new HttpError(400, 'Cet ordre ne peut plus être annulé.');
  await db.prepare("UPDATE production_orders SET status = 'cancelled', closed_at = ? WHERE id = ?").run(U.today(), o.id);
  res.json({ ok: true });
});

/**
 * Clôture : quantité réellement produite + rebut. Les matières consommées couvrent produit + rebut (le rebut a consommé des matières).
 * Une seule transaction : sorties de matières, entrée du produit fini, calcul du coût réel, mise à jour du coût moyen du produit.
 */
router.post('/orders/:id/close', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'launched') throw new HttpError(400, 'Seul un ordre lancé peut être clôturé.');
  const b = req.body || {};
  const produced = A.qty(b.producedQty === undefined || b.producedQty === '' ? o.quantity : b.producedQty, { allowZero: true });
  const scrap = A.qty(b.scrapQty === undefined || b.scrapQty === '' ? 0 : b.scrapQty, { allowZero: true });
  if (produced + scrap <= 0) throw new HttpError(400, 'Indiquez la quantité produite ou le rebut.');
  const bom = o.bom_id ? (await bomRows(req, o.bom_id))[0] : null;
  if (!bom || !o.product_id) throw new HttpError(400, 'La nomenclature ou le produit de cet ordre n\'existe plus.');
  const lines = await bomLines(bom.id);
  const needs = needsFor(lines, U.round3(produced + scrap));
  const miss = needs.filter((n) => n.missing > 0);
  if (miss.length) throw new HttpError(400, 'Stock insuffisant pour clôturer : ' + miss.map((s) => `${s.name} (il manque ${s.missing} ${s.unit})`).join(', ') + '. Faites d\'abord une entrée de stock.');
  const reason = `Production ${o.code}`;
  const material = Math.round(needs.reduce((a, n) => a + n.needed * n.unitCost, 0));
  const total = material + (bom.labor_cost + bom.other_cost) * Math.round((produced + scrap) * 1000) / 1000;
  const totalCost = Math.round(total);
  const unitCost = produced > 0 ? Math.round(totalCost / produced) : 0;
  await db.transaction(async () => {
    for (const n of needs) if (n.needed > 0) await U.moveStock(req, n.itemId, -n.needed, reason);
    if (produced > 0) {
      const prod = await U.stockItem(req, o.product_id);
      await U.moveStock(req, prod.id, produced, reason, { unitCost });
      const base = Math.max(prod.quantity, 0);
      const avg = Math.round((base * prod.unit_cost + produced * unitCost) / (base + produced));
      await db.prepare('UPDATE stock_items SET unit_cost = ? WHERE id = ?').run(avg, prod.id);
    }
    await db.prepare("UPDATE production_orders SET status = 'done', produced_qty = ?, scrap_qty = ?, unit_cost = ?, total_cost = ?, closed_at = ?, notes = ? WHERE id = ?").run(produced, scrap, unitCost, totalCost, U.today(), b.notes === undefined ? o.notes : A.text(b.notes, 500), o.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'production', `${o.code} terminé : ${produced} produit(s), ${scrap} de rebut`);
  res.json({ ok: true, unitCost, totalCost });
});

// ---------- Planification ----------
router.get('/plan/capacity', async (req, res) => {
  const mgr = A.can(req, 'manager');
  const list = await amap(await bomRows(req), async (b) => { const lines = await bomLines(b.id); const c = capacityOf(lines); return { bomId: b.id, productId: b.product_id, product: b.product_name, unit: b.product_unit, maxQuantity: c.max, limiting: c.limiting, unitCost: mgr ? costOf(b, lines).unit : undefined }; });
  res.json({ capacity: list });
});

/** Besoin en matières pour un plan de production : lines = [{ bomId, quantity }]. */
router.post('/plan/needs', async (req, res) => {
  const list = (req.body || {}).lines;
  if (!Array.isArray(list) || !list.length || list.length > 40) throw new HttpError(400, 'Indiquez au moins un produit à fabriquer.');
  const total = new Map();
  for (const x of list) {
    const bom = await bomOf(req, x && x.bomId);
    for (const n of needsFor(await bomLines(bom.id), A.qty(x.quantity))) {
      const t = total.get(n.itemId) || { ...n, needed: 0 };
      t.needed = U.round3(t.needed + n.needed);
      total.set(n.itemId, t);
    }
  }
  const mgr = A.can(req, 'manager');
  const needs = [...total.values()].map((t) => { const missing = Math.max(U.round3(t.needed - t.inStock), 0); return { itemId: t.itemId, name: t.name, unit: t.unit, needed: t.needed, inStock: t.inStock, missing, missingCost: mgr ? Math.round(missing * t.unitCost) : undefined }; });
  res.json({ needs, missingCount: needs.filter((n) => n.missing > 0).length, missingCost: mgr ? needs.reduce((a, n) => a + n.missingCost, 0) : undefined });
});

module.exports = router;
module.exports.STATUS = STATUS;
module.exports.min = 'member';

// ---------- Aide à l'IA ----------
module.exports.ctx = async (req) => {
  const cur = req.org.currency;
  const mgr = A.can(req, 'manager');
  const boms = await amap((await bomRows(req)).slice(0, 25), async (b) => {
    const lines = await bomLines(b.id);
    const c = costOf(b, lines);
    const cap = capacityOf(lines);
    return `- ${U.oneLine(b.product_name, 60)} : ${lines.slice(0, 8).map((l) => `${l.quantity} ${l.unit} de ${U.oneLine(l.name, 40)}`).join(', ')}${mgr ? `, coût de revient ${U.money(c.unit, cur)}/unité` : ''}, peut en fabriquer ${cap.max}${cap.limiting && cap.max < 1000 ? ` (limité par ${U.oneLine(cap.limiting, 40)})` : ''}`;
  });
  const orders = (await orderRows(req)).filter((o) => ['draft', 'launched'].includes(o.status)).slice(0, 15);
  return ('PRODUCTION :\nNomenclatures :\n' + (boms.join('\n') || '(aucune)') + '\nOrdres de fabrication ouverts :\n'
    + (orders.map((o) => `- ${o.code} ${U.oneLine(o.product_name, 60)} × ${o.quantity} [${o.status === 'draft' ? 'brouillon' : 'lancé'}]${o.due_date ? ` pour le ${o.due_date}` : ''}${o.due_date && o.due_date < U.today() ? ' EN RETARD' : ''}`).join('\n') || '(aucun)')).slice(0, 3000);
};
module.exports.prompt = "Module Production : nomenclatures (recettes), coût de revient, ordres de fabrication (brouillon, lancé, terminé, annulé) et planification. Aide la personne à comprendre ses coûts de revient, ses ruptures de matières et ce qu'elle peut fabriquer avec son stock. Le coût de revient vient du dernier coût d'achat des matières plus la main-d'œuvre et les frais estimés : dis-le et invite à vérifier les chiffres. Tu ne crées ni ne clôtures jamais un ordre toi-même : tu conseilles et la personne agit dans l'écran.";
