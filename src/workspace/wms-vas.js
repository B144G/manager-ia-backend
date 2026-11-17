'use strict';
// Stock entrepôt (WMS) — services à valeur ajoutée (VAS) : étiquetage, reconditionnement, emballage cadeau, contrôle, mise en kit…
// Un type de service a un coût (par tâche ou par unité) et peut être obligatoire. Une tâche est rattachée à une liste de préparation,
// une expédition, une réception (WMS) ou une réception d'achat ; elle se crée à la main ou par une règle (tel article, tel client, toujours).
// Chaque personne voit sa liste de tâches ; une tâche se termine par scan de son code (VAS-0001). Les tâches obligatoires non terminées
// bloquent la sortie du stock : expédition et sortie directe d'une liste de préparation.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const H = () => require('./wms');
const CATEGORIES = { labeling: 'Étiquetage', repack: 'Reconditionnement', giftwrap: 'Emballage cadeau', control: 'Contrôle', kitting: 'Mise en kit', other: 'Autre' };
const REFS = { pick: 'Liste de préparation', shipment: 'Expédition', receipt: 'Réception', pur_receipt: "Réception d'achat" };
const STATUS = { open: 'À faire', in_progress: 'En cours', done: 'Terminée', cancelled: 'Annulée' };
const BASIS = { task: 'Par tâche', unit: 'Par unité' };

// ---------- Types de service ----------
async function typeOf(req, idv) {
  const t = await db.prepare('SELECT * FROM wms_vas_types WHERE id = ? AND org_id = ?').get(A.id(idv, 'Type de service introuvable.'), req.org.id);
  if (!t) throw new HttpError(404, 'Type de service introuvable.');
  return t;
}
const typeView = (t, m) => ({ id: Number(t.id), name: t.name, category: t.category, categoryLabel: CATEGORIES[t.category] || CATEGORIES.other, unitCost: m ? Number(t.unit_cost) : undefined, costBasis: t.cost_basis, costBasisLabel: BASIS[t.cost_basis],
  minutes: t.minutes == null ? null : Number(t.minutes), mandatory: Boolean(Number(t.mandatory)), instructions: t.instructions || '', active: Boolean(Number(t.active)) });
const cost0 = (v) => { if (v === undefined || v === null || v === '') return 0; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new HttpError(400, 'Coût invalide : un nombre positif ou zéro.'); return Math.round(n * 100) / 100; };
const mins = (v) => H().optNum(v, { min: 0, max: 100000, msg: 'Durée invalide (en minutes).' });
router.get('/vas/types', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM wms_vas_types WHERE org_id = ? ORDER BY active DESC, name').all(req.org.id);
  res.json({ types: rows.map((t) => typeView(t, A.can(req, 'manager'))), categories: CATEGORIES, refs: REFS, bases: BASIS });
});
function readType(b, cur = {}) {
  return {
    name: b.name === undefined ? cur.name : A.text(b.name, 80, { required: true, msg: 'Indiquez le nom du service.' }),
    category: b.category === undefined ? cur.category || 'other' : CATEGORIES[b.category] ? b.category : 'other',
    unitCost: b.unitCost === undefined ? Number(cur.unit_cost || 0) : cost0(b.unitCost),
    basis: b.costBasis === undefined ? cur.cost_basis || 'task' : BASIS[b.costBasis] ? b.costBasis : 'task',
    minutes: b.minutes === undefined ? (cur.minutes == null ? null : Number(cur.minutes)) : mins(b.minutes),
    mandatory: b.mandatory === undefined ? Number(cur.mandatory || 0) : (b.mandatory ? 1 : 0),
    instructions: b.instructions === undefined ? cur.instructions || '' : cleanText(String(b.instructions || ''), 500),
    active: b.active === undefined ? (cur.active === undefined ? 1 : Number(cur.active)) : (b.active ? 1 : 0),
  };
}
router.post('/vas/types', mgr, async (req, res) => {
  const v = readType(req.body || {});
  if (!v.name) throw new HttpError(400, 'Indiquez le nom du service.');
  const id = Number((await db.prepare('INSERT INTO wms_vas_types (org_id, name, category, unit_cost, cost_basis, minutes, mandatory, instructions, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, v.name, v.category, v.unitCost, v.basis, v.minutes, v.mandatory, v.instructions, v.active, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.put('/vas/types/:id', mgr, async (req, res) => {
  const t = await typeOf(req, req.params.id);
  const v = readType(req.body || {}, t);
  await db.prepare('UPDATE wms_vas_types SET name = ?, category = ?, unit_cost = ?, cost_basis = ?, minutes = ?, mandatory = ?, instructions = ?, active = ? WHERE id = ?').run(v.name, v.category, v.unitCost, v.basis, v.minutes, v.mandatory, v.instructions, v.active, t.id);
  res.json({ ok: true });
});
router.delete('/vas/types/:id', mgr, async (req, res) => {
  const t = await typeOf(req, req.params.id);
  if (await db.prepare('SELECT 1 FROM wms_vas_tasks WHERE type_id = ? LIMIT 1').get(t.id)) {
    await db.prepare('UPDATE wms_vas_types SET active = 0 WHERE id = ?').run(t.id);
    return res.json({ ok: true, deactivated: true });
  }
  await db.prepare('DELETE FROM wms_vas_types WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

// ---------- Règles (création automatique) ----------
router.get('/vas/rules', async (req, res) => {
  const rows = await db.prepare('SELECT r.*, t.name AS type, i.name AS item, c.name AS customer FROM wms_vas_rules r JOIN wms_vas_types t ON t.id = r.type_id LEFT JOIN stock_items i ON i.id = r.item_id LEFT JOIN customers c ON c.id = r.customer_id WHERE r.org_id = ? ORDER BY t.name, r.id').all(req.org.id);
  res.json({ rules: rows.map((r) => ({ id: Number(r.id), typeId: Number(r.type_id), type: r.type, applies: r.applies, appliesLabel: REFS[r.applies], itemId: r.item_id ? Number(r.item_id) : null, item: r.item || null, customerId: r.customer_id ? Number(r.customer_id) : null, customer: r.customer || null, mandatory: Boolean(Number(r.mandatory)) })) });
});
router.post('/vas/rules', mgr, async (req, res) => {
  const b = req.body || {};
  const t = await typeOf(req, b.typeId);
  const applies = ['pick', 'shipment', 'receipt'].includes(b.applies) ? b.applies : 'pick';
  const it = b.itemId ? await H().itemOf(req, b.itemId) : null;
  let cust = null;
  if (b.customerId) { cust = await db.prepare('SELECT id FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId), req.org.id); if (!cust) throw new HttpError(404, 'Client introuvable.'); }
  if (cust && applies === 'receipt') throw new HttpError(400, 'Une réception ne concerne pas un client : choisissez un article, ou rien (toutes les réceptions).');
  const id = Number((await db.prepare('INSERT INTO wms_vas_rules (org_id, type_id, applies, item_id, customer_id, mandatory, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, t.id, applies, it ? it.id : null, cust ? cust.id : null, b.mandatory === undefined ? Number(t.mandatory) : (b.mandatory ? 1 : 0), nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.delete('/vas/rules/:id', mgr, async (req, res) => {
  const r = await db.prepare('DELETE FROM wms_vas_rules WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Règle introuvable.');
  res.json({ ok: true });
});

// ---------- Tâches ----------
/** Le document visé : { id, code, label }. */
async function refOf(req, kind, idv, code) {
  if (!REFS[kind]) throw new HttpError(400, 'Rattachez le service à une préparation, une expédition ou une réception.');
  const table = { pick: 'wms_picks', shipment: 'wms_shipments', receipt: 'wms_receipts', pur_receipt: 'pur_receipts' }[kind];
  const col = kind === 'pur_receipt' ? 'number' : 'code';
  const row = idv !== undefined && idv !== null && idv !== ''
    ? await db.prepare(`SELECT id, ${col} AS code, ${kind === 'receipt' || kind === 'pur_receipt' ? "'' AS status" : 'status'} FROM ${table} WHERE id = ? AND org_id = ?`).get(A.id(idv), req.org.id)
    : await db.prepare(`SELECT id, ${col} AS code, ${kind === 'receipt' || kind === 'pur_receipt' ? "'' AS status" : 'status'} FROM ${table} WHERE UPPER(${col}) = UPPER(?) AND org_id = ?`).get(cleanText(String(code || ''), 40), req.org.id);
  if (!row) throw new HttpError(404, `${REFS[kind]} introuvable.`);
  if (kind === 'pick' && ['issued', 'cancelled'].includes(row.status)) throw new HttpError(400, 'Cette liste de préparation est déjà sortie du stock ou annulée.');
  if (kind === 'shipment' && ['shipped', 'cancelled'].includes(row.status)) throw new HttpError(400, 'Cette expédition est terminée ou annulée.');
  return { id: Number(row.id), code: row.code };
}
async function createTask(req, { type, refKind, refId, itemId = null, quantity = 1, mandatory, assignedTo = null, note = '', ruleId = null }) {
  const code = await W.nextCode(req.org.id, 'VAS');
  const q = r3(quantity || 1);
  const uc = Number(type.unit_cost) || 0;
  const id = Number((await db.prepare(`INSERT INTO wms_vas_tasks (org_id, code, type_id, name, ref_kind, ref_id, item_id, quantity, status, mandatory, rule_id, assigned_to, unit_cost, cost_basis, cost, minutes, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, code, type.id, type.name, refKind, refId, itemId, q, mandatory === undefined ? Number(type.mandatory) : (mandatory ? 1 : 0), ruleId, assignedTo,
    uc, type.cost_basis, Math.round(uc * (type.cost_basis === 'unit' ? q : 1) * 100) / 100, type.minutes, cleanText(String(note || ''), 300), req.user ? req.user.id : null, nowISO())).lastInsertRowid);
  return { id, code };
}
/**
 * Règles : crée les tâches d'un document (dans la transaction de l'appelant). items = [{ itemId, quantity }].
 * Règle d'un article : une tâche par article concerné (quantité de l'article) ; règle d'un client ou générale : une tâche par document.
 */
async function autoAttach(req, refKind, refId, { customerId = null, items = [], itemIds = [] } = {}) {
  const list = items.length ? items : itemIds.map((x) => ({ itemId: x, quantity: 1 }));
  const rules = await db.prepare('SELECT r.*, t.name, t.unit_cost, t.cost_basis, t.minutes, t.mandatory AS tm, t.active FROM wms_vas_rules r JOIN wms_vas_types t ON t.id = r.type_id WHERE r.org_id = ? AND r.applies = ? AND t.active = 1 ORDER BY r.id').all(req.org.id, refKind);
  const out = [];
  for (const r of rules) {
    const type = { id: r.type_id, name: r.name, unit_cost: r.unit_cost, cost_basis: r.cost_basis, minutes: r.minutes, mandatory: r.tm };
    if (r.customer_id && Number(r.customer_id) !== Number(customerId || 0)) continue;
    const exists = (itemId) => db.prepare('SELECT 1 FROM wms_vas_tasks WHERE ref_kind = ? AND ref_id = ? AND rule_id = ? AND COALESCE(item_id, 0) = ?').get(refKind, refId, r.id, itemId || 0);
    if (r.item_id) {
      const x = list.filter((l) => Number(l.itemId) === Number(r.item_id));
      if (!x.length || await exists(r.item_id)) continue;
      out.push(await createTask(req, { type, refKind, refId, itemId: Number(r.item_id), quantity: r3(x.reduce((s, l) => s + Number(l.quantity || 0), 0)) || 1, mandatory: Boolean(Number(r.mandatory)), ruleId: r.id }));
    } else {
      if (await exists(null)) continue;
      out.push(await createTask(req, { type, refKind, refId, quantity: 1, mandatory: Boolean(Number(r.mandatory)), ruleId: r.id }));
    }
  }
  return out;
}
/** Tâches obligatoires non terminées sur ces listes de préparation et cette expédition. */
async function blocking(orgId, { pickIds = [], shipmentId = null }) {
  const conds = []; const args = [orgId];
  if (pickIds.length) { conds.push(`(ref_kind = 'pick' AND ref_id IN (${pickIds.map(() => '?').join(',')}))`); args.push(...pickIds); }
  if (shipmentId) { conds.push("(ref_kind = 'shipment' AND ref_id = ?)"); args.push(shipmentId); }
  if (!conds.length) return [];
  return db.prepare(`SELECT * FROM wms_vas_tasks WHERE org_id = ? AND mandatory = 1 AND status IN ('open','in_progress') AND (${conds.join(' OR ')}) ORDER BY id`).all(...args);
}
async function assertDone(req, opts) {
  const list = await blocking(req.org.id, opts);
  if (list.length) throw new HttpError(409, `Services obligatoires à terminer avant la sortie du stock : ${list.slice(0, 10).map((t) => `${t.code} (${t.name})`).join(', ')}.`);
}

async function taskOf(req, idv) {
  const t = await db.prepare('SELECT * FROM wms_vas_tasks WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!t) throw new HttpError(404, 'Tâche introuvable.');
  return t;
}
const refCode = async (kind, id) => {
  const table = { pick: 'wms_picks', shipment: 'wms_shipments', receipt: 'wms_receipts', pur_receipt: 'pur_receipts' }[kind];
  if (!table) return null;
  const r = await db.prepare(`SELECT ${kind === 'pur_receipt' ? 'number' : 'code'} AS c FROM ${table} WHERE id = ?`).get(id);
  return r ? r.c : null;
};
async function taskView(req, t) {
  const m = A.can(req, 'manager');
  const it = t.item_id ? await db.prepare('SELECT name, unit FROM stock_items WHERE id = ?').get(t.item_id) : null;
  const ty = t.type_id ? await db.prepare('SELECT category, instructions FROM wms_vas_types WHERE id = ?').get(t.type_id) : null;
  const who = t.assigned_to ? await db.prepare('SELECT name FROM users WHERE id = ?').get(t.assigned_to) : null;
  const by = t.done_by ? await db.prepare('SELECT name FROM users WHERE id = ?').get(t.done_by) : null;
  return { id: Number(t.id), code: t.code, name: t.name, category: ty ? ty.category : 'other', categoryLabel: CATEGORIES[ty ? ty.category : 'other'] || CATEGORIES.other, instructions: ty ? ty.instructions || '' : '',
    refKind: t.ref_kind, refLabel: REFS[t.ref_kind], refId: Number(t.ref_id), refCode: await refCode(t.ref_kind, t.ref_id), itemId: t.item_id ? Number(t.item_id) : null, item: it ? it.name : null, unit: it ? it.unit : null,
    quantity: r3(t.quantity), status: t.status, statusLabel: STATUS[t.status], mandatory: Boolean(Number(t.mandatory)), auto: Boolean(t.rule_id), assignedTo: t.assigned_to ? Number(t.assigned_to) : null, assignedName: who ? who.name : null,
    mine: Number(t.assigned_to) === Number(req.user.id), cost: m ? Number(t.cost) : undefined, unitCost: m ? Number(t.unit_cost) : undefined, costBasis: t.cost_basis, minutes: t.minutes == null ? null : Number(t.minutes),
    note: t.note || '', result: t.result || '', createdAt: t.created_at, startedAt: t.started_at || null, doneAt: t.done_at || null, doneBy: by ? by.name : null };
}
router.get('/vas/tasks', async (req, res) => {
  const q = req.query || {};
  let where = ' WHERE org_id = ?'; const args = [req.org.id];
  if (q.status === 'todo' || !q.status) where += " AND status IN ('open','in_progress')";
  else if (STATUS[q.status]) { where += ' AND status = ?'; args.push(q.status); }
  if (String(q.mine) === '1') { where += ' AND (assigned_to = ? OR assigned_to IS NULL)'; args.push(req.user.id); }
  if (REFS[q.refKind] && q.refId) { where += ' AND ref_kind = ? AND ref_id = ?'; args.push(q.refKind, A.id(q.refId)); }
  const rows = await db.prepare(`SELECT * FROM wms_vas_tasks${where} ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, mandatory DESC, id DESC LIMIT 300`).all(...args);
  const out = []; for (const t of rows) out.push(await taskView(req, t));
  res.json({ tasks: out, statuses: STATUS });
});
router.post('/vas/tasks', mgr, async (req, res) => {
  const b = req.body || {};
  const type = await typeOf(req, b.typeId);
  if (!Number(type.active)) throw new HttpError(400, "Ce type de service n'est plus actif.");
  const ref = await refOf(req, b.refKind, b.refId, b.refCode);
  const it = b.itemId ? await H().itemOf(req, b.itemId) : null;
  const quantity = b.quantity === undefined || b.quantity === '' ? 1 : H().qty(b.quantity);
  const assigned = b.assignedTo === undefined || b.assignedTo === '' || b.assignedTo === null ? null : await A.memberOf(req, b.assignedTo);
  const out = await createTask(req, { type, refKind: b.refKind, refId: ref.id, itemId: it ? it.id : null, quantity, mandatory: b.mandatory === undefined ? undefined : Boolean(b.mandatory), assignedTo: assigned, note: b.note });
  res.status(201).json(out);
});
router.put('/vas/tasks/:id', mgr, async (req, res) => {
  const t = await taskOf(req, req.params.id);
  if (!['open', 'in_progress'].includes(t.status)) throw new HttpError(400, 'Cette tâche est terminée ou annulée.');
  const b = req.body || {};
  const assigned = b.assignedTo === undefined ? t.assigned_to : (b.assignedTo === '' || b.assignedTo === null ? null : await A.memberOf(req, b.assignedTo));
  await db.prepare('UPDATE wms_vas_tasks SET assigned_to = ?, mandatory = ?, note = ? WHERE id = ?').run(assigned, b.mandatory === undefined ? t.mandatory : (b.mandatory ? 1 : 0), b.note === undefined ? t.note : cleanText(String(b.note || ''), 300), t.id);
  res.json({ ok: true });
});
const mayWork = (req, t) => { if (t.assigned_to && Number(t.assigned_to) !== Number(req.user.id) && !A.can(req, 'manager')) throw new HttpError(403, 'Cette tâche est confiée à une autre personne.'); };
router.post('/vas/tasks/:id/start', async (req, res) => {
  const t = await taskOf(req, req.params.id);
  mayWork(req, t);
  const r = await db.prepare("UPDATE wms_vas_tasks SET status = 'in_progress', started_at = ?, assigned_to = COALESCE(assigned_to, ?) WHERE id = ? AND status = 'open'").run(nowISO(), req.user.id, t.id);
  if (!r.changes) throw new HttpError(400, 'Cette tâche est déjà commencée, terminée ou annulée.');
  res.json({ ok: true });
});
async function complete(req, t, b = {}) {
  mayWork(req, t);
  if (b.cost !== undefined && b.cost !== '' && !A.can(req, 'manager')) throw new HttpError(403, 'Seul un responsable peut saisir le coût réel.');
  const q = b.quantity === undefined || b.quantity === null || b.quantity === '' ? Number(t.quantity) : H().qty(b.quantity);
  const minutes = b.minutes === undefined || b.minutes === '' ? (t.minutes == null ? null : Number(t.minutes)) : mins(b.minutes);
  const cost = b.cost !== undefined && b.cost !== '' ? cost0(b.cost) : Math.round(Number(t.unit_cost) * (t.cost_basis === 'unit' ? q : 1) * 100) / 100;
  const r = await db.prepare("UPDATE wms_vas_tasks SET status = 'done', quantity = ?, minutes = ?, cost = ?, result = ?, done_by = ?, done_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status IN ('open','in_progress')")
    .run(q, minutes, cost, cleanText(String(b.result || ''), 300), req.user.id, nowISO(), nowISO(), t.id);
  if (!r.changes) throw new HttpError(400, 'Cette tâche est déjà terminée ou annulée.');
  return { code: t.code, name: t.name, cost: A.can(req, 'manager') ? cost : undefined };
}
router.post('/vas/tasks/:id/complete', async (req, res) => res.json({ ok: true, ...await complete(req, await taskOf(req, req.params.id), req.body || {}) }));
router.post('/vas/tasks/:id/cancel', mgr, async (req, res) => {
  const t = await taskOf(req, req.params.id);
  const r = await db.prepare("UPDATE wms_vas_tasks SET status = 'cancelled', result = ?, done_by = ?, done_at = ? WHERE id = ? AND status IN ('open','in_progress')").run(cleanText(String((req.body || {}).reason || ''), 300), req.user.id, nowISO(), t.id);
  if (!r.changes) throw new HttpError(400, 'Cette tâche est déjà terminée ou annulée.');
  res.json({ ok: true });
});
/** Scan : le code d'une tâche la termine ; le code d'une liste, d'une expédition ou d'une réception affiche ses tâches à faire. */
router.post('/vas/scan', async (req, res) => {
  const b = req.body || {};
  const code = cleanText(String(b.code || ''), 60);
  if (!code) throw new HttpError(400, 'Scannez un code.');
  const t = await db.prepare('SELECT * FROM wms_vas_tasks WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, code);
  if (t) return res.json({ ok: true, completed: await complete(req, t, b) });
  for (const kind of ['pick', 'shipment', 'receipt', 'pur_receipt']) {
    const table = { pick: 'wms_picks', shipment: 'wms_shipments', receipt: 'wms_receipts', pur_receipt: 'pur_receipts' }[kind];
    const row = await db.prepare(`SELECT id FROM ${table} WHERE org_id = ? AND UPPER(${kind === 'pur_receipt' ? 'number' : 'code'}) = UPPER(?)`).get(req.org.id, code);
    if (!row) continue;
    const rows = await db.prepare("SELECT * FROM wms_vas_tasks WHERE org_id = ? AND ref_kind = ? AND ref_id = ? AND status IN ('open','in_progress') ORDER BY mandatory DESC, id").all(req.org.id, kind, row.id);
    const out = []; for (const x of rows) out.push(await taskView(req, x));
    return res.json({ ok: true, refKind: kind, refLabel: REFS[kind], refCode: code.toUpperCase(), tasks: out });
  }
  throw new HttpError(404, 'Code inconnu : ni tâche de service, ni préparation, ni expédition, ni réception.');
});
/** Coûts des services terminés sur une période : par type et par document. */
router.get('/vas/costs', mgr, async (req, res) => {
  const from = A.date(req.query.from) || `${W.today().slice(0, 7)}-01`;
  const to = A.date(req.query.to) || W.today();
  const rows = await db.prepare("SELECT * FROM wms_vas_tasks WHERE org_id = ? AND status = 'done' AND SUBSTR(done_at, 1, 10) >= ? AND SUBSTR(done_at, 1, 10) <= ? ORDER BY done_at").all(req.org.id, from, to);
  const byType = new Map(); const byRef = new Map();
  for (const t of rows) {
    const k = t.name;
    if (!byType.has(k)) byType.set(k, { name: k, tasks: 0, quantity: 0, minutes: 0, cost: 0 });
    const x = byType.get(k); x.tasks++; x.quantity = r3(x.quantity + Number(t.quantity)); x.minutes = r3(x.minutes + Number(t.minutes || 0)); x.cost = Math.round((x.cost + Number(t.cost)) * 100) / 100;
    const rk = `${t.ref_kind}:${t.ref_id}`;
    if (!byRef.has(rk)) byRef.set(rk, { refKind: t.ref_kind, refLabel: REFS[t.ref_kind], refId: Number(t.ref_id), refCode: await refCode(t.ref_kind, t.ref_id), tasks: 0, cost: 0 });
    const y = byRef.get(rk); y.tasks++; y.cost = Math.round((y.cost + Number(t.cost)) * 100) / 100;
  }
  res.json({ from, to, tasks: rows.length, total: Math.round(rows.reduce((s, t) => s + Number(t.cost), 0) * 100) / 100, minutes: r3(rows.reduce((s, t) => s + Number(t.minutes || 0), 0)),
    byType: [...byType.values()].sort((a, b) => b.cost - a.cost), byRef: [...byRef.values()].sort((a, b) => b.cost - a.cost).slice(0, 100) });
});

module.exports = router;
Object.assign(module.exports, { autoAttach, blocking, assertDone, CATEGORIES });
