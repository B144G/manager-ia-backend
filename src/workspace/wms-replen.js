'use strict';
// Stock entrepôt (WMS) — réapprovisionnement des emplacements de préparation.
// Une règle fixe, pour un article et un emplacement de préparation, un minimum et un maximum. Sous le minimum, une tâche ramène de quoi
// remonter au maximum depuis le rayonnage du même entrepôt : des palettes ENTIÈRES d'abord (un seul scan), puis du stock en vrac.
// Le stock déjà promis à une liste de préparation dans un rayonnage n'est pas déplacé.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const H = () => require('./wms');
const HU = () => require('./wms-hu');
const TASK_STATUS = { open: 'À faire', done: 'Faite', cancelled: 'Annulée' };

async function ruleOf(req, idv) {
  const r = await db.prepare('SELECT * FROM wms_replen_rules WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!r) throw new HttpError(404, 'Règle de réapprovisionnement introuvable.');
  return r;
}
async function taskOf(req, idv) {
  const t = await db.prepare('SELECT * FROM wms_replen_tasks WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!t) throw new HttpError(404, 'Tâche de réapprovisionnement introuvable.');
  return t;
}
const openQty = async (locId, itemId) => r3(Number((await db.prepare("SELECT COALESCE(SUM(quantity - done_qty), 0) AS q FROM wms_replen_tasks WHERE to_location_id = ? AND item_id = ? AND status = 'open'").get(locId, itemId)).q));
/** Stock d'un emplacement déjà promis aux listes de préparation en cours. */
const promised = async (locId, itemId) => r3(Number((await db.prepare("SELECT COALESCE(SUM(pl.quantity - pl.picked_qty), 0) AS q FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id WHERE pl.location_id = ? AND pl.item_id = ? AND p.status IN ('open','in_progress') AND pl.done = 0").get(locId, itemId)).q));

/** État d'une règle : stock actuel, tâches en cours, besoin. */
async function stateOf(rule) {
  const current = await W.qtyAt(rule.location_id, rule.item_id);
  const open = await openQty(rule.location_id, rule.item_id);
  const below = current + open < Number(rule.min_qty) - W.EPS;
  return { current, open, below, need: below ? r3(Math.max(0, Number(rule.max_qty) - current - open)) : 0 };
}

/** D'où prendre `need` : palettes entières d'un seul article qui tiennent sous le maximum, puis vrac ; à défaut, la plus petite palette. */
async function sourcePlan(rule, need) {
  const to = await db.prepare('SELECT * FROM wms_locations WHERE id = ?').get(rule.location_id);
  const plan = []; let left = r3(need);
  const busyHu = new Set((await db.prepare("SELECT hu_id FROM wms_replen_tasks WHERE status = 'open' AND hu_id IS NOT NULL AND org_id = ?").all(rule.org_id)).map((x) => Number(x.hu_id)));
  const hus = await db.prepare(`SELECT h.id, h.code, h.location_id, l.code AS loc, SUM(c.quantity) AS q, MIN(c.expiry) AS ex FROM wms_hus h JOIN wms_hu_contents c ON c.hu_id = h.id JOIN wms_locations l ON l.id = h.location_id
    WHERE h.org_id = ? AND h.parent_id IS NULL AND h.pick_id IS NULL AND h.status = 'open' AND l.kind = 'storage' AND l.active = 1 AND l.warehouse_id = ? AND h.location_id != ?
      AND NOT EXISTS (SELECT 1 FROM wms_hu_contents c2 WHERE c2.hu_id = h.id AND c2.item_id != ?) AND NOT EXISTS (SELECT 1 FROM wms_hus k WHERE k.parent_id = h.id)
      AND c.item_id = ? GROUP BY h.id, h.code, h.location_id, l.code ORDER BY MIN(c.expiry) IS NULL, MIN(c.expiry), SUM(c.quantity) DESC, h.id`).all(rule.org_id, to.warehouse_id, to.id, rule.item_id, rule.item_id);
  const free = [];
  for (const h of hus) {
    if (busyHu.has(Number(h.id))) continue;
    // Le stock de l'emplacement promis à une préparation reste sur place.
    const spare = r3(await W.qtyAt(h.location_id, rule.item_id) - await promised(h.location_id, rule.item_id));
    if (spare + W.EPS < Number(h.q)) continue;
    free.push(h);
  }
  const usedHu = new Set();
  for (const h of free) {
    if (left <= W.EPS) break;
    if (Number(h.q) <= left + W.EPS) { plan.push({ huId: Number(h.id), huCode: h.code, fromLocationId: Number(h.location_id), from: h.loc, quantity: r3(h.q) }); left = r3(left - Number(h.q)); usedHu.add(Number(h.id)); }
  }
  if (left > W.EPS) {
    const locs = await db.prepare(`SELECT s.location_id, l.code FROM wms_stock s JOIN wms_locations l ON l.id = s.location_id WHERE s.item_id = ? AND s.quantity > 0 AND l.kind = 'storage' AND l.active = 1 AND l.warehouse_id = ? AND l.id != ? ORDER BY l.aisle, l.rack, l.bin, l.code`).all(rule.item_id, to.warehouse_id, to.id);
    for (const s of locs) {
      if (left <= W.EPS) break;
      const taken = r3(Number((await db.prepare("SELECT COALESCE(SUM(quantity - done_qty), 0) AS q FROM wms_replen_tasks WHERE from_location_id = ? AND item_id = ? AND hu_id IS NULL AND status = 'open'").get(s.location_id, rule.item_id)).q));
      const loose = r3(await W.looseAt(s.location_id, rule.item_id) - taken - await promised(s.location_id, rule.item_id));
      const q = r3(Math.min(left, Math.max(0, loose)));
      if (q > W.EPS) { plan.push({ huId: null, huCode: null, fromLocationId: Number(s.location_id), from: s.code, quantity: q }); left = r3(left - q); }
    }
  }
  // Rien de mieux : une palette entière, même si elle dépasse le maximum (plutôt que de laisser l'emplacement vide).
  if (!plan.length) {
    const h = free.filter((x) => !usedHu.has(Number(x.id))).sort((a, b) => Number(a.q) - Number(b.q))[0];
    if (h) { plan.push({ huId: Number(h.id), huCode: h.code, fromLocationId: Number(h.location_id), from: h.loc, quantity: r3(h.q), over: true }); left = 0; }
  }
  return { plan, short: r3(Math.max(0, left)) };
}

async function createTasks(req, rule, { auto = false } = {}) {
  const st = await stateOf(rule);
  if (!st.below || st.need <= W.EPS) return [];
  const { plan } = await sourcePlan(rule, st.need);
  const out = [];
  for (const p of plan) {
    const code = await W.nextCode(req.org.id, 'RA');
    const id = Number((await db.prepare('INSERT INTO wms_replen_tasks (org_id, code, rule_id, item_id, from_location_id, to_location_id, hu_id, quantity, status, auto, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, code, rule.id, rule.item_id, p.fromLocationId, rule.location_id, p.huId, p.quantity, 'open', auto ? 1 : 0, req.user ? req.user.id : null, nowISO())).lastInsertRowid);
    out.push({ id, code, quantity: p.quantity, huCode: p.huCode, from: p.from });
  }
  return out;
}
/** Appelé après une sortie d'un emplacement de préparation : sous le minimum, les tâches se créent toutes seules. */
async function autoCheck(req, locationId, itemId) {
  const rule = await db.prepare('SELECT * FROM wms_replen_rules WHERE location_id = ? AND item_id = ? AND active = 1').get(locationId, itemId);
  if (!rule) return [];
  return createTasks(req, rule, { auto: true });
}

// ---------- Règles ----------
router.get('/replenishment/rules', async (req, res) => {
  const rows = await db.prepare('SELECT r.*, i.name, i.unit, l.code FROM wms_replen_rules r JOIN stock_items i ON i.id = r.item_id JOIN wms_locations l ON l.id = r.location_id WHERE r.org_id = ? ORDER BY l.code, i.name').all(req.org.id);
  const out = [];
  for (const r of rows) out.push({ id: Number(r.id), itemId: Number(r.item_id), item: r.name, unit: r.unit, locationId: Number(r.location_id), location: r.code, min: Number(r.min_qty), max: Number(r.max_qty), active: Boolean(Number(r.active)), ...(await stateOf(r)) });
  res.json({ rules: out });
});
function minMax(b, cur = {}) {
  const min = b.min === undefined ? Number(cur.min_qty) : H().optNum(b.min, { min: 0, msg: 'Minimum invalide.' });
  const max = b.max === undefined ? Number(cur.max_qty) : H().optNum(b.max, { min: 0, msg: 'Maximum invalide.' });
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) throw new HttpError(400, 'Indiquez le minimum et le maximum.');
  if (max <= min) throw new HttpError(400, 'Le maximum doit être plus grand que le minimum.');
  return { min: r3(min), max: r3(max) };
}
router.post('/replenishment/rules', mgr, async (req, res) => {
  const b = req.body || {};
  const it = await H().itemOf(req, b.itemId);
  const l = await W.locationOf(req.org.id, A.id(b.locationId, 'Emplacement introuvable.'));
  if (l.kind !== 'picking' || !Number(l.active)) throw new HttpError(400, 'Choisissez un emplacement de préparation actif.');
  const { min, max } = minMax(b);
  if (await db.prepare('SELECT 1 FROM wms_replen_rules WHERE location_id = ? AND item_id = ?').get(l.id, it.id)) throw new HttpError(409, 'Une règle existe déjà pour cet article dans cet emplacement.');
  const id = Number((await db.prepare('INSERT INTO wms_replen_rules (org_id, item_id, location_id, min_qty, max_qty, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, it.id, l.id, min, max, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.put('/replenishment/rules/:id', mgr, async (req, res) => {
  const r = await ruleOf(req, req.params.id);
  const b = req.body || {};
  const { min, max } = minMax(b, r);
  await db.prepare('UPDATE wms_replen_rules SET min_qty = ?, max_qty = ?, active = ? WHERE id = ?').run(min, max, b.active === undefined ? Number(r.active) : (b.active ? 1 : 0), r.id);
  res.json({ ok: true });
});
router.delete('/replenishment/rules/:id', mgr, async (req, res) => {
  const r = await ruleOf(req, req.params.id);
  await db.prepare('DELETE FROM wms_replen_rules WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

// ---------- Suggestions et tâches ----------
router.get('/replenishment/suggestions', async (req, res) => {
  const rows = await db.prepare('SELECT r.*, i.name, i.unit, l.code FROM wms_replen_rules r JOIN stock_items i ON i.id = r.item_id JOIN wms_locations l ON l.id = r.location_id WHERE r.org_id = ? AND r.active = 1 ORDER BY l.aisle, l.rack, l.bin, l.code').all(req.org.id);
  const out = [];
  for (const r of rows) {
    const st = await stateOf(r);
    if (!st.below) continue;
    const sp = await sourcePlan(r, st.need);
    out.push({ ruleId: Number(r.id), itemId: Number(r.item_id), item: r.name, unit: r.unit, location: r.code, locationId: Number(r.location_id), min: Number(r.min_qty), max: Number(r.max_qty), ...st, sources: sp.plan, short: sp.short });
  }
  res.json({ suggestions: out });
});
router.post('/replenishment/generate', async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ruleIds) && b.ruleIds.length ? b.ruleIds.map((x) => A.id(x)) : null;
  const rules = await db.prepare(`SELECT * FROM wms_replen_rules WHERE org_id = ? AND active = 1${ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : ''}`).all(req.org.id, ...(ids || []));
  const created = await db.transaction(async () => { const out = []; for (const r of rules) out.push(...await createTasks(req, r)); return out; })();
  res.json({ created });
});
router.get('/replenishment/tasks', async (req, res) => {
  const st = TASK_STATUS[req.query.status] ? req.query.status : 'open';
  const rows = await db.prepare(`SELECT t.*, i.name, i.unit, i.sku, f.code AS fc, t2.code AS tc, h.code AS hc, u.name AS who FROM wms_replen_tasks t JOIN stock_items i ON i.id = t.item_id LEFT JOIN wms_locations f ON f.id = t.from_location_id
    LEFT JOIN wms_locations t2 ON t2.id = t.to_location_id LEFT JOIN wms_hus h ON h.id = t.hu_id LEFT JOIN users u ON u.id = t.done_by WHERE t.org_id = ? AND t.status = ? ORDER BY f.aisle, f.rack, f.bin, f.code, t.id LIMIT 300`).all(req.org.id, st);
  res.json({ tasks: rows.map((t) => ({ id: Number(t.id), code: t.code, status: t.status, statusLabel: TASK_STATUS[t.status], itemId: Number(t.item_id), item: t.name, unit: t.unit, sku: t.sku || '', from: t.fc || null, fromLocationId: t.from_location_id ? Number(t.from_location_id) : null,
    to: t.tc || null, toLocationId: t.to_location_id ? Number(t.to_location_id) : null, huId: t.hu_id ? Number(t.hu_id) : null, huCode: t.hc || null, quantity: r3(t.quantity), doneQty: r3(t.done_qty), auto: Boolean(Number(t.auto)), createdAt: t.created_at, doneAt: t.done_at || null, doneBy: t.who || null })) });
});
/** Exécution par scan : l'emplacement de départ (ou la palette), puis l'emplacement de préparation. */
router.post('/replenishment/tasks/:id/confirm', async (req, res) => {
  const t = await taskOf(req, req.params.id);
  if (t.status !== 'open') throw new HttpError(400, 'Cette tâche est terminée ou annulée.');
  const b = req.body || {};
  const to = await W.locationOf(req.org.id, t.to_location_id);
  if (b.toLocationCode && String(b.toLocationCode).trim().toUpperCase() !== to.code.toUpperCase()) throw new HttpError(400, `Ce n'est pas le bon emplacement : déposez en ${to.code}.`);
  let done;
  await db.transaction(async () => {
    // Double scan : le second envoi attend le premier puis trouve la tâche faite.
    if ((await W.lockRow('wms_replen_tasks', t.id)).status !== 'open') throw new HttpError(400, 'Cette tâche est terminée ou annulée.');
    if (t.hu_id) {
      const hu = await HU().huOf(req, t.hu_id);
      if (b.huCode && String(b.huCode).trim().toUpperCase() !== hu.code.toUpperCase()) throw new HttpError(400, `Ce n'est pas la bonne palette : prenez ${hu.code}.`);
      if (Number(hu.location_id) === Number(to.id)) throw new HttpError(400, 'Cette palette est déjà dans l\'emplacement de préparation.');
      done = r3(Number((await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM wms_hu_contents WHERE hu_id = ? AND item_id = ?').get(hu.id, t.item_id)).q));
      const last = Number((await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM wms_moves WHERE org_id = ?').get(req.org.id)).m);
      await HU().moveHu(req, hu, to);
      // Le déplacement de la palette est noté comme un réapprovisionnement (l'historique de la palette le garde).
      await db.prepare("UPDATE wms_moves SET kind = 'replenish', reason = ? WHERE org_id = ? AND id > ? AND kind = 'hu_move'").run(`Réapprovisionnement ${t.code} · palette ${hu.code}`, req.org.id, last);
    } else {
      const from = await W.locationOf(req.org.id, t.from_location_id);
      if (b.fromLocationCode && String(b.fromLocationCode).trim().toUpperCase() !== from.code.toUpperCase()) throw new HttpError(400, `Ce n'est pas le bon emplacement : prenez en ${from.code}.`);
      const remaining = r3(t.quantity - t.done_qty);
      done = b.quantity === undefined || b.quantity === '' || b.quantity === null ? remaining : H().qty(b.quantity);
      if (done > remaining + W.EPS) throw new HttpError(400, `Il reste ${remaining} à déplacer sur cette tâche.`);
      if (await W.looseAt(from.id, t.item_id) + W.EPS < done) throw new HttpError(400, 'Pas assez de stock en vrac dans cet emplacement (le reste est sur une palette).');
      await W.move(req, t.item_id, from.id, to.id, done, { kind: 'replenish', refKind: 'replen', refId: t.id, reason: `Réapprovisionnement ${t.code}` });
    }
    await db.prepare("UPDATE wms_replen_tasks SET done_qty = ?, status = 'done', done_by = ?, done_at = ? WHERE id = ?").run(r3(Number(t.done_qty) + done), req.user.id, nowISO(), t.id);
    await require('./wms-pilot').record(req, 'replenish', { lines: 1, units: done, refKind: 'replen', refId: t.id });
  })();
  res.json({ ok: true, quantity: done, to: to.code });
});
router.post('/replenishment/tasks/:id/cancel', async (req, res) => {
  const t = await taskOf(req, req.params.id);
  if (t.status !== 'open') throw new HttpError(400, 'Cette tâche est terminée ou annulée.');
  if (!A.can(req, 'manager') && !Number(t.auto)) throw new HttpError(403, 'Votre rôle ne permet pas cette action.');
  await db.prepare("UPDATE wms_replen_tasks SET status = 'cancelled', done_by = ?, done_at = ? WHERE id = ?").run(req.user.id, nowISO(), t.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.autoCheck = autoCheck;
