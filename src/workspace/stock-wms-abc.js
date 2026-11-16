'use strict';
// Stock WMS · lot 6 : classement ABC par valeur de consommation et inventaires tournants planifiés par classe.
//  - Valeur de consommation = quantités sorties sur la période (ventes, livraisons, ateliers, chantiers…) × valeur unitaire actuelle. Sont exclus : écarts d'inventaire,
//    pertes de transfert, retours et rebuts (ce ne sont pas de la consommation). A = articles qui font les premiers 80 % de la valeur consommée, B = jusqu'à 95 %, C = le reste
//    (seuils réglables). Un article sans sortie est classé C et signalé « sans mouvement ».
//  - Inventaire tournant : chaque classe a sa fréquence (A : 30 jours, B : 90, C : 180 par défaut). Un inventaire tournant est un inventaire normal (stock_counts : comptage →
//    soumission → validation par une autre personne) limité aux articles « à compter » ; ses écarts sont valorisés au coût moyen, par classe.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(['/abc', '/cycle-counts', '/settings'], A.need('manager'));
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const CLASSES = ['A', 'B', 'C'];
const NOT_CONSUMPTION = ['count', 'transfer', 'return', 'scrap'];

/** Classement ABC calculé à partir des sorties de la période. */
async function classify(req, cfg) {
  const since = `${addDays(today(), -cfg.abcDays)}T00:00:00.000Z`;
  const sc = A.scope(req, 'i.branch_id');
  const items = await db.prepare(`SELECT i.id, i.name, i.unit, i.sku, i.quantity, i.avg_cost, i.unit_cost, i.tracking FROM stock_items i WHERE i.org_id = ?${sc.sql}`).all(req.org.id, ...sc.args);
  const out = await db.prepare(`SELECT m.item_id, SUM(-m.delta) q FROM stock_moves m WHERE m.org_id = ? AND m.delta < 0 AND m.created_at >= ? AND m.ref_kind NOT IN (${NOT_CONSUMPTION.map(() => '?').join(',')}) GROUP BY m.item_id`).all(req.org.id, since, ...NOT_CONSUMPTION);
  const q = new Map(out.map((x) => [x.item_id, x.q]));
  const rows = items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, sku: i.sku, tracking: i.tracking, quantity: i.quantity, consumedQty: W.round3(q.get(i.id) || 0), unitValue: L.unitValue(i), stockValue: Math.round(i.quantity * L.unitValue(i)) }));
  for (const r of rows) r.consumption = Math.round(r.consumedQty * r.unitValue);
  rows.sort((a, b) => b.consumption - a.consumption || b.stockValue - a.stockValue || a.name.localeCompare(b.name));
  const total = rows.reduce((a, r) => a + r.consumption, 0);
  let cum = 0;
  rows.forEach((r, i) => {
    const before = total > 0 ? (100 * cum) / total : 100;
    r.class = r.consumption <= 0 ? 'C' : before < cfg.abcA ? 'A' : before < cfg.abcB ? 'B' : 'C';
    cum += r.consumption;
    r.rank = i + 1; r.share = total > 0 ? Math.round((1000 * r.consumption) / total) / 10 : 0; r.cumShare = total > 0 ? Math.round((1000 * cum) / total) / 10 : 0;
    r.noMovement = r.consumedQty <= 0;
  });
  return { rows, total, since: since.slice(0, 10) };
}
async function lastCounted(orgId) {
  const rows = await db.prepare("SELECT l.item_id, MAX(c.decided_at) d FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id WHERE c.org_id = ? AND c.status = 'validated' AND l.counted IS NOT NULL GROUP BY l.item_id").all(orgId);
  return new Map(rows.map((r) => [r.item_id, r.d]));
}
const freqOf = (cfg, c) => cfg[`cycle${c}`];

router.get('/settings', async (req, res) => res.json({ settings: await W.settings(req.org.id) }));
router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {}; const patch = {};
  const num = (k, lo, hi, label) => { if (b[k] === undefined) return; const n = Number(b[k]); if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${label} : entre ${lo} et ${hi}.`); patch[k] = Math.round(n * 10) / 10; };
  num('abcA', 1, 99, 'Seuil de la classe A (%)'); num('abcB', 2, 100, 'Seuil de la classe B (%)'); num('abcDays', 30, 1095, 'Période de calcul (jours)');
  num('cycleA', 1, 730, 'Fréquence classe A (jours)'); num('cycleB', 1, 730, 'Fréquence classe B (jours)'); num('cycleC', 1, 730, 'Fréquence classe C (jours)');
  num('forecastWeeks', 2, 52, 'Semaines de prévision'); num('serviceLevel', 50, 99.9, 'Niveau de service (%)'); num('defaultLeadDays', 0, 365, 'Délai fournisseur par défaut (jours)');
  const cur = { ...(await W.settings(req.org.id)), ...patch };
  if (cur.abcA >= cur.abcB) throw new HttpError(400, 'Le seuil A doit être plus petit que le seuil B.');
  res.json({ settings: await W.saveSettings(req.org.id, patch) });
});

// ---------- Classement ABC ----------
router.get('/abc', async (req, res) => {
  const cfg = await W.settings(req.org.id);
  const { rows, total, since } = await classify(req, cfg);
  const sumBy = (c) => { const x = rows.filter((r) => r.class === c); return { class: c, items: x.length, consumption: x.reduce((a, r) => a + r.consumption, 0), stockValue: x.reduce((a, r) => a + r.stockValue, 0), share: total > 0 ? Math.round((1000 * x.reduce((a, r) => a + r.consumption, 0)) / total) / 10 : 0 }; };
  const stockTotal = rows.reduce((a, r) => a + r.stockValue, 0);
  res.json({ since, days: cfg.abcDays, thresholds: { a: cfg.abcA, b: cfg.abcB }, totalConsumption: total, totalStockValue: stockTotal, classes: CLASSES.map(sumBy).map((c) => ({ ...c, stockShare: stockTotal > 0 ? Math.round((1000 * c.stockValue) / stockTotal) / 10 : 0 })),
    items: rows.map((r) => ({ itemId: r.id, name: r.name, unit: r.unit, sku: r.sku, class: r.class, rank: r.rank, consumedQty: r.consumedQty, consumption: r.consumption, share: r.share, cumShare: r.cumShare, quantity: r.quantity, stockValue: r.stockValue, noMovement: r.noMovement })) });
});
/** Enregistre le classement (utilisé pour planifier les inventaires tournants). */
router.post('/abc/refresh', async (req, res) => {
  const cfg = await W.settings(req.org.id);
  const { rows } = await classify(req, cfg);
  await db.transaction(async () => {
    for (const r of rows) await db.prepare('INSERT INTO wms_item_class (item_id, org_id, class, consumption, rank, computed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET class = EXCLUDED.class, consumption = EXCLUDED.consumption, rank = EXCLUDED.rank, computed_at = EXCLUDED.computed_at').run(r.id, req.org.id, r.class, r.consumption, r.rank, nowISO());
  })();
  res.json({ ok: true, items: rows.length, counts: Object.fromEntries(CLASSES.map((c) => [c, rows.filter((r) => r.class === c).length])) });
});

// ---------- Inventaires tournants ----------
/** Articles à compter : pas comptés depuis plus longtemps que la fréquence de leur classe (jamais comptés = à compter). */
async function due(req, cfg, classes) {
  const { rows } = await classify(req, cfg);
  const last = await lastCounted(req.org.id);
  const t = today();
  return rows.filter((r) => r.tracking !== 'serial' && (!classes || classes.includes(r.class))).map((r) => {
    const lc = last.get(r.id) ? last.get(r.id).slice(0, 10) : null;
    const dueOn = lc ? addDays(lc, freqOf(cfg, r.class)) : t;
    return { itemId: r.id, name: r.name, unit: r.unit, class: r.class, rank: r.rank, quantity: r.quantity, stockValue: r.stockValue, lastCounted: lc, dueOn, overdueDays: Math.max(Math.round((Date.parse(t) - Date.parse(dueOn)) / 86400000), 0), due: dueOn <= t };
  }).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.rank - b.rank);
}

router.get('/cycle-counts/plan', async (req, res) => {
  const cfg = await W.settings(req.org.id);
  const list = await due(req, cfg);
  const by = (c) => { const x = list.filter((i) => i.class === c); return { class: c, everyDays: freqOf(cfg, c), items: x.length, due: x.filter((i) => i.due).length, nextDue: x.length ? x[0].dueOn : null, stockValue: x.reduce((a, i) => a + i.stockValue, 0) }; };
  res.json({ classes: CLASSES.map(by), due: list.filter((i) => i.due).length, upcoming: list.filter((i) => !i.due).slice(0, 30), dueItems: list.filter((i) => i.due).slice(0, 200) });
});

router.post('/cycle-counts', async (req, res) => {
  const b = req.body || {};
  const classes = (Array.isArray(b.classes) && b.classes.length ? b.classes : CLASSES).map((c) => A.oneOf(String(c).toUpperCase(), CLASSES, undefined, 'Classe inconnue (A, B ou C).'));
  const limit = b.limit === undefined || b.limit === '' ? 50 : Math.min(Math.max(Math.round(Number(b.limit)) || 50, 1), 500);
  if (await db.prepare("SELECT 1 FROM stock_counts WHERE org_id = ? AND status IN ('open','submitted')").get(req.org.id)) throw new HttpError(409, "Un inventaire est déjà en cours : terminez-le (validation ou rejet) avant d'en ouvrir un autre.");
  const cfg = await W.settings(req.org.id);
  const list = (await due(req, cfg, classes)).filter((i) => i.due).slice(0, limit);
  if (!list.length) throw new HttpError(400, 'Aucun article à compter pour ces classes : tout est à jour.');
  const now = nowISO();
  const id = await db.transaction(async () => {
    const seq = Number((await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM stock_counts WHERE org_id = ?').get(req.org.id)).n);
    const cid = Number((await db.prepare('INSERT INTO stock_counts (org_id, branch_id, seq, status, note, created_by, created_at, cycle_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, await A.branchOf(req, b.branchId === undefined ? req.member.branch_id : b.branchId), seq, 'open', A.text(b.note, 300) || `Inventaire tournant : classe ${classes.join(', ')}`, req.user.id, now, classes.join(''))).lastInsertRowid);
    for (const i of list) {
      const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(i.itemId);
      await db.prepare('INSERT INTO stock_count_lines (count_id, item_id, expected, unit_value) VALUES (?, ?, ?, ?)').run(cid, it.id, it.quantity, L.unitValue(it));
    }
    return cid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Inventaire tournant ouvert (classe ${classes.join(', ')}, ${list.length} article(s))`);
  res.status(201).json({ id, items: list.length });
});

/** Écarts valorisés des inventaires validés, par classe (précision = part des lignes comptées sans écart). */
router.get('/cycle-counts/variance', async (req, res) => {
  const cfg = await W.settings(req.org.id);
  const days = Math.min(Math.max(Math.round(Number(req.query.days)) || 365, 1), 1095);
  const since = `${addDays(today(), -days)}T00:00:00.000Z`;
  const { rows } = await classify(req, cfg);
  const cls = new Map(rows.map((r) => [r.id, r.class]));
  const lines = await db.prepare(`SELECT l.item_id, l.expected, l.counted, l.unit_value, c.id AS count_id, c.seq, c.decided_at, i.name, i.unit FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id JOIN stock_items i ON i.id = l.item_id
    WHERE c.org_id = ? AND c.status = 'validated' AND c.decided_at >= ? AND l.counted IS NOT NULL ORDER BY c.decided_at DESC`).all(req.org.id, since);
  const items = lines.map((l) => { const gap = W.round3(l.counted - l.expected); return { countId: l.count_id, seq: l.seq, at: l.decided_at, itemId: l.item_id, name: l.name, unit: l.unit, class: cls.get(l.item_id) || 'C', expected: l.expected, counted: l.counted, gap, gapValue: Math.round(gap * l.unit_value) }; });
  const byClass = CLASSES.map((c) => {
    const x = items.filter((i) => i.class === c);
    return { class: c, lines: x.length, withGap: x.filter((i) => i.gap !== 0).length, accuracy: x.length ? Math.round((1000 * x.filter((i) => i.gap === 0).length) / x.length) / 10 : null, shortValue: x.filter((i) => i.gapValue < 0).reduce((a, i) => a + i.gapValue, 0), surplusValue: x.filter((i) => i.gapValue > 0).reduce((a, i) => a + i.gapValue, 0), netValue: x.reduce((a, i) => a + i.gapValue, 0) };
  });
  res.json({ days, classes: byClass, netValue: items.reduce((a, i) => a + i.gapValue, 0), gaps: items.filter((i) => i.gap !== 0).slice(0, 200) });
});

module.exports = router;
