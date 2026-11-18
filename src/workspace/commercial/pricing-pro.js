'use strict';
// Politique tarifaire et marges : listes de prix par segment et canal, plafonds de remise par rôle (réglages), calcul de marge par ligne, devis, commande, facture,
// client et produit (coût issu du catalogue, sinon du stock/achats), alerte sous le seuil de marge, simulation de prix, historique des prix.
// Le prix plancher et les paliers restent ceux de pricing.js (un seul point de calcul) : une liste de prix ne fait jamais descendre sous le plancher.
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const Dt = require('./data');
const { HttpError } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;
const pr = () => require('../pricing');
const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

// ---------- Coût d'une ligne ----------
/** Renvoie une fonction ligne → coût unitaire (ou null si inconnu) : coût du catalogue, sinon coût moyen (ou dernier coût) de l'article du stock. */
async function costResolver(orgId) {
  const cat = await db.prepare('SELECT * FROM catalog WHERE org_id = ?').all(orgId);
  const stock = await db.prepare('SELECT id, name, avg_cost, unit_cost FROM stock_items WHERE org_id = ?').all(orgId);
  return (line) => {
    const it = cat.length ? pr().matchItem(cat, line) : null;
    if (it && N(it.cost) > 0) return N(it.cost);
    const w = pr().norm(line.label);
    let s = line.itemId ? stock.find((x) => Number(x.id) === Number(line.itemId) && (!w || pr().norm(x.name) === w)) : null;
    if (!s && w) s = stock.find((x) => pr().norm(x.name) === w);
    if (!s) return null;
    const c = N(s.avg_cost) > 0 ? N(s.avg_cost) : N(s.unit_cost);
    return c > 0 ? c : null;
  };
}
const docMargin = (d, org, costOf) => {
  const lines = parse(d.lines);
  const rate = d.vat_rate === null || d.vat_rate === undefined ? Number(org.vat_rate) : Number(d.vat_rate);
  const ms = lines.map((l) => ({ ...L.lineMargin(l, { vatRate: rate, pricesIncl: Number(d.prices_incl) === 1 }, costOf(l)), label: l.label }));
  return { lines: ms, ...L.sumMargins(ms) };
};

// ---------- Politique ----------
router.get('/pricing/policy', P.need('view'), async (req, res) => {
  const s = await B.settings(req.org.id);
  res.json({ discountCaps: s.discountCaps, marginMinPct: s.marginMinPct, quoteValidityDays: s.quoteValidityDays, elasticity: s.elasticity });
});
router.put('/pricing/policy', P.need('pricing'), async (req, res) => {
  const b = req.body || {};
  if (b.discountCaps) for (const v of Object.values(b.discountCaps)) if (!(Number(v) >= 0 && Number(v) <= 100)) throw new HttpError(400, 'Un plafond de remise va de 0 à 100 %.');
  if (b.marginMinPct !== undefined && !(Number(b.marginMinPct) >= 0 && Number(b.marginMinPct) < 100)) throw new HttpError(400, 'Le seuil de marge va de 0 à 99 %.');
  const s = await B.saveSettings(req.org.id, { discountCaps: b.discountCaps, marginMinPct: b.marginMinPct, quoteValidityDays: b.quoteValidityDays, elasticity: b.elasticity });
  await P.audit(req, 'pricing_policy', null, 'update', b);
  res.json({ discountCaps: s.discountCaps, marginMinPct: s.marginMinPct, quoteValidityDays: s.quoteValidityDays, elasticity: s.elasticity });
});

// ---------- Listes de prix ----------
const SEGMENTS = [...L.RFM_SEGMENTS, 'A', 'B', 'C'];
const CHANNELS = ['all', 'whatsapp', 'counter', 'field', 'web'];
const listView = (l, items) => ({ id: Number(l.id), name: l.name, segment: l.segment, channel: l.channel, discountPct: N(l.discount_pct), validFrom: l.valid_from, validUntil: l.valid_until, priority: N(l.priority), active: Boolean(Number(l.active)), items });
router.get('/pricing/lists', P.need('view'), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM cp_pricelists WHERE org_id = ? ORDER BY priority, id').all(req.org.id);
  const out = [];
  for (const l of rows) out.push(listView(l, (await db.prepare('SELECT i.item_id, i.price, c.name FROM cp_pricelist_items i JOIN catalog c ON c.id = i.item_id WHERE i.pricelist_id = ?').all(l.id)).map((i) => ({ itemId: Number(i.item_id), name: i.name, price: N(i.price) }))));
  res.json({ lists: out, segments: SEGMENTS, channels: CHANNELS });
});
async function saveList(req, id, b, cur = {}) {
  const items = b.items === undefined ? null : (Array.isArray(b.items) ? b.items : []);
  if (items && items.length > 200) throw new HttpError(400, 'Une liste compte 200 articles au plus.');
  const row = {
    name: b.name === undefined ? cur.name : A.text(b.name, 80, { required: true, msg: 'Nommez la liste de prix.' }),
    segment: b.segment === undefined ? cur.segment || '' : b.segment === '' ? '' : A.oneOf(b.segment, SEGMENTS, undefined, 'Segment inconnu.'),
    channel: b.channel === undefined ? cur.channel || 'all' : A.oneOf(b.channel, CHANNELS, undefined, 'Canal inconnu.'),
    discount: b.discountPct === undefined ? N(cur.discount_pct) : Number(b.discountPct), from: b.validFrom === undefined ? cur.valid_from || null : A.date(b.validFrom), until: b.validUntil === undefined ? cur.valid_until || null : A.date(b.validUntil),
    priority: b.priority === undefined ? N(cur.priority) || 100 : Math.round(Number(b.priority) || 100), active: b.active === undefined ? N(cur.active ?? 1) : b.active ? 1 : 0,
  };
  if (!(row.discount >= 0 && row.discount <= 90)) throw new HttpError(400, 'La remise de la liste va de 0 à 90 %.');
  await db.transaction(async () => {
    if (!id) id = Number((await db.prepare('INSERT INTO cp_pricelists (org_id, name, segment, channel, discount_pct, valid_from, valid_until, priority, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, row.name, row.segment, row.channel, row.discount, row.from, row.until, row.priority, row.active, nowISO())).lastInsertRowid);
    else await db.prepare('UPDATE cp_pricelists SET name = ?, segment = ?, channel = ?, discount_pct = ?, valid_from = ?, valid_until = ?, priority = ?, active = ? WHERE id = ?').run(row.name, row.segment, row.channel, row.discount, row.from, row.until, row.priority, row.active, id);
    if (items) {
      await db.prepare('DELETE FROM cp_pricelist_items WHERE pricelist_id = ?').run(id);
      for (const it of items) {
        const itemId = A.id(it.itemId);
        if (!await db.prepare('SELECT 1 FROM catalog WHERE id = ? AND org_id = ?').get(itemId, req.org.id)) throw new HttpError(400, 'Article inconnu.');
        await db.prepare('INSERT INTO cp_pricelist_items (pricelist_id, item_id, price) VALUES (?, ?, ?) ON CONFLICT (pricelist_id, item_id) DO UPDATE SET price = excluded.price').run(id, itemId, A.amount(it.price));
      }
    }
  })();
  return id;
}
router.post('/pricing/lists', P.need('pricing'), async (req, res) => { const id = await saveList(req, null, req.body || {}); await P.audit(req, 'pricelist', id, 'create', (req.body || {}).name); res.status(201).json({ id }); });
router.put('/pricing/lists/:id', P.need('pricing'), async (req, res) => {
  const l = await db.prepare('SELECT * FROM cp_pricelists WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!l) throw new HttpError(404, 'Liste introuvable.');
  await saveList(req, Number(l.id), req.body || {}, l);
  await P.audit(req, 'pricelist', l.id, 'update', Object.keys(req.body || {}).join(','));
  res.json({ ok: true });
});
router.delete('/pricing/lists/:id', P.need('pricing'), async (req, res) => {
  const x = await db.prepare('DELETE FROM cp_pricelists WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!x.changes) throw new HttpError(404, 'Liste introuvable.');
  res.json({ ok: true });
});

/** Prix proposé : prix de référence de pricing.js (liste, palier, prix négocié, remise client) comparé aux listes de prix valables pour le segment (RFM ou ABC) du client et le canal ; jamais sous le plancher. */
router.get('/pricing/resolve', P.need('view'), async (req, res) => {
  const item = await db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ?').get(A.id(req.query.itemId), req.org.id);
  if (!item) throw new HttpError(404, 'Article introuvable.');
  const customer = req.query.customerId ? await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(req.query.customerId), req.org.id) : null;
  if (req.query.customerId && (!customer || !A.visible(req, customer))) throw new HttpError(404, 'Client introuvable.');
  const channel = req.query.channel ? A.oneOf(req.query.channel, CHANNELS, 'all', 'Canal inconnu.') : 'all';
  const qty = Number(req.query.quantity) > 0 ? Number(req.query.quantity) : 1;
  const base = await pr().priceFor(req.org, item, customer, qty);
  let seg = []; if (customer) { const m = (await require('./segments').metrics(req)).rows.find((r) => r.id === Number(customer.id)); if (m) seg = [m.segment, m.abc].filter(Boolean); }
  const today = B.today();
  const lists = (await db.prepare('SELECT * FROM cp_pricelists WHERE org_id = ? AND active = 1 ORDER BY priority, id').all(req.org.id)).filter((l) => (!l.segment || seg.includes(l.segment)) && (l.channel === 'all' || l.channel === channel) && (!l.valid_from || l.valid_from <= today) && (!l.valid_until || l.valid_until >= today));
  const cands = [];
  for (const l of lists) {
    const it = await db.prepare('SELECT price FROM cp_pricelist_items WHERE pricelist_id = ? AND item_id = ?').get(l.id, item.id);
    const price = it ? N(it.price) : N(l.discount_pct) > 0 ? Math.round(N(item.price) * (1 - N(l.discount_pct) / 100)) : null;
    if (price !== null) cands.push({ listId: Number(l.id), name: l.name, price, source: it ? 'item' : 'discount' });
  }
  const best = cands.sort((a, b) => a.price - b.price)[0] || null;
  let suggested = base.reference; let reason = base.reasonCode;
  if (best && best.price < suggested) { suggested = best.price; reason = 'pricelist'; }
  const floored = base.floor && suggested < base.floor ? base.floor : suggested;
  if (floored !== suggested) { suggested = floored; reason = 'floor'; }
  const cost = (await costResolver(req.org.id))({ itemId: item.id, label: item.name });
  res.json({ itemId: Number(item.id), name: item.name, list: base.list, floor: base.floor, reference: base.reference, referenceReason: base.reasonCode, priceLists: cands, suggested, reason, cost, marginPct: cost !== null && suggested > 0 ? L.round(((suggested - cost) * 100) / suggested, 1) : null, segments: seg });
});

// ---------- Coûts et historique des prix ----------
router.put('/pricing/costs/:itemId', P.need('pricing'), async (req, res) => {
  const it = await db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ?').get(A.id(req.params.itemId), req.org.id);
  if (!it) throw new HttpError(404, 'Article introuvable.');
  const cost = (req.body || {}).cost === '' || Number((req.body || {}).cost) === 0 ? 0 : A.amount((req.body || {}).cost);
  await db.prepare('UPDATE catalog SET cost = ? WHERE id = ?').run(cost, it.id);
  await P.audit(req, 'catalog_cost', it.id, 'update', { from: N(it.cost), to: cost });
  res.json({ ok: true });
});
router.get('/pricing/items', P.need('view'), async (req, res) => {
  const costOf = await costResolver(req.org.id);
  const items = await db.prepare('SELECT * FROM catalog WHERE org_id = ? ORDER BY name').all(req.org.id);
  res.json({ items: items.map((i) => { const c = costOf({ itemId: i.id, label: i.name }); return { id: Number(i.id), name: i.name, price: N(i.price), floor: pr().floorOf(i) || null, cost: c, costSource: N(i.cost) > 0 ? 'catalog' : c !== null ? 'stock' : null, marginPct: c !== null && N(i.price) > 0 ? L.round(((N(i.price) - c) * 100) / N(i.price), 1) : null }; }) });
});
router.get('/pricing/history', P.need('view'), async (req, res) => {
  const item = await db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ?').get(A.id(req.query.itemId), req.org.id);
  if (!item) throw new HttpError(404, 'Article introuvable.');
  const names = await B.names(req.org.id);
  const changes = await db.prepare('SELECT * FROM cp_price_history WHERE item_id = ? ORDER BY id DESC LIMIT 100').all(item.id);
  const w = pr().norm(item.name);
  const sold = new Map();
  for (const d of await Dt.invoices(req.org.id, {})) for (const l of d.lines) if (pr().norm(l.label) === w && N(l.price) > 0) { const v = sold.get(d.month) || { q: 0, rev: 0 }; v.q += N(l.quantity); v.rev += N(l.quantity) * N(l.price); sold.set(d.month, v); }
  res.json({ current: N(item.price), changes: changes.map((c) => ({ at: c.created_at, from: N(c.old_price), to: N(c.new_price), by: names.get(Number(c.user_id)) || '', reason: c.reason })), sold: [...sold.entries()].sort().map(([month, v]) => ({ month, quantity: L.round(v.q, 2), avgPrice: Math.round(v.rev / v.q) })) });
});

// ---------- Marges ----------
router.get('/margins/documents', P.need('view'), async (req, res) => {
  const kind = A.oneOf(req.query.kind, ['quote', 'order', 'invoice'], 'invoice', 'Type de document inconnu.');
  const { from, to } = B.range({ ...req.query, from: req.query.from || L.addDays(B.today(), -90) });
  const costOf = await costResolver(req.org.id); const set = await B.settings(req.org.id);
  const sc = A.scope(req, 'd.branch_id');
  const rows = await db.prepare(`SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = ? AND d.status <> 'cancelled' AND d.issued >= ? AND d.issued <= ?${sc.sql} ORDER BY d.issued DESC, d.id DESC LIMIT 300`).all(req.org.id, kind, from, to, ...sc.args);
  const docs = rows.map((d) => { const m = docMargin(d, req.org, costOf); return { id: Number(d.id), number: d.number, customer: d.customer, status: d.status, issued: d.issued, revenue: m.revenue, cost: m.cost, margin: m.margin, marginPct: m.pct, coverage: m.coverage, below: m.pct !== null && m.pct < Number(set.marginMinPct) }; });
  res.json({ documents: docs, threshold: Number(set.marginMinPct), totals: L.sumMargins(rows.flatMap((d) => docMargin(d, req.org, costOf).lines)) });
});
router.get('/margins/summary', P.need('view'), async (req, res) => {
  const { from, to } = B.range({ ...req.query, from: req.query.from || L.addDays(B.today(), -90) });
  const costOf = await costResolver(req.org.id); const set = await B.settings(req.org.id);
  const invs = (await Dt.invoices(req.org.id, { from, to })).filter((d) => !(req.query.ownerId && d.ownerId !== Number(req.query.ownerId)));
  const rateOf = (d) => (d.vatRate === null || d.vatRate === undefined ? Number(req.org.vat_rate) : Number(d.vatRate));
  const byCust = new Map(); const byProd = new Map(); const all = [];
  for (const d of invs) for (const l of d.lines) {
    const m = L.lineMargin(l, { vatRate: rateOf(d), pricesIncl: d.pricesIncl }, costOf(l));
    all.push(m);
    const c = byCust.get(d.customerId) || { id: d.customerId, name: d.customer, ms: [] }; c.ms.push(m); byCust.set(d.customerId, c);
    const p = byProd.get(l.label) || { name: l.label, quantity: 0, ms: [] }; p.ms.push(m); p.quantity += N(l.quantity); byProd.set(l.label, p);
  }
  const fin = (x) => ({ ...x, ...L.sumMargins(x.ms), ms: undefined });
  res.json({ from, to, threshold: Number(set.marginMinPct), total: L.sumMargins(all), customers: [...byCust.values()].map(fin).sort((a, b) => b.revenue - a.revenue).slice(0, 50), products: [...byProd.values()].map(fin).sort((a, b) => b.revenue - a.revenue).slice(0, 50) });
});
router.get('/margins/alerts', P.need('view'), async (req, res) => {
  const costOf = await costResolver(req.org.id); const set = await B.settings(req.org.id); const thr = Number(set.marginMinPct);
  const rows = await db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind IN ('quote','order') AND d.status IN ('draft','sent','confirmed','accepted') ORDER BY d.id DESC LIMIT 200").all(req.org.id);
  const out = [];
  for (const d of rows) { const m = docMargin(d, req.org, costOf); if (m.pct !== null && m.pct < thr) out.push({ id: Number(d.id), kind: d.kind, number: d.number, customer: d.customer, status: d.status, revenue: m.revenue, marginPct: m.pct, threshold: thr, coverage: m.coverage }); }
  res.json({ threshold: thr, alerts: out.sort((a, b) => a.marginPct - b.marginPct) });
});

// ---------- Simulation de prix ----------
router.post('/pricing/simulate', P.need('view'), async (req, res) => {
  const b = req.body || {};
  const item = await db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ?').get(A.id(b.itemId), req.org.id);
  if (!item) throw new HttpError(404, 'Article introuvable.');
  const newPrice = A.amount(b.newPrice);
  const set = await B.settings(req.org.id);
  const elasticity = b.elasticity === undefined || b.elasticity === '' ? Number(set.elasticity) : Number(b.elasticity);
  if (!Number.isFinite(elasticity) || elasticity > 0 || elasticity < -10) throw new HttpError(400, "L'élasticité est un nombre négatif (de -10 à 0) : une hausse de prix fait baisser le volume.");
  const days = Math.min(Math.max(Math.round(Number(b.days)) || 90, 7), 730);
  const w = pr().norm(item.name); const from = L.addDays(B.today(), -days);
  let qty = 0; let rev = 0;
  for (const d of await Dt.invoices(req.org.id, { from })) for (const l of d.lines) if (pr().norm(l.label) === w) { qty += N(l.quantity); rev += N(l.quantity) * N(l.price); }
  const price = b.basePrice ? A.amount(b.basePrice) : qty > 0 ? Math.round(rev / qty) : N(item.price);
  const cost = (await costResolver(req.org.id))({ itemId: item.id, label: item.name });
  const sim = L.simulatePrice({ qty: b.baseQty !== undefined ? Number(b.baseQty) : qty, price, cost: cost || 0, newPrice, elasticity });
  const floor = pr().floorOf(item);
  res.json({ item: { id: Number(item.id), name: item.name }, days, elasticity, basePrice: price, newPrice, cost, costKnown: cost !== null, belowFloor: Boolean(floor && newPrice < floor), floor: floor || null, ...sim });
});

module.exports = { router, costResolver, docMargin };
