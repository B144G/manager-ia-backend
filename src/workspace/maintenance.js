'use strict';
// Sous-application « Maintenance » : parc d'équipements, plans préventifs avec échéances, interventions (ordres de travail), pièces, indicateurs.
// Droits : tout le monde consulte et peut signaler une panne ; les responsables gèrent le parc, les plans et les interventions ;
// la personne assignée peut démarrer et clôturer son intervention. Les coûts et la valeur ne sont vus que par les responsables.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const U = require('./ops-util');
const { amap, HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const KINDS = ['machine', 'vehicle', 'building', 'tool', 'it'];
const EQ_STATUS = ['running', 'broken', 'stopped', 'retired'];
const PERIODS = ['days', 'hours', 'km'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const SOON_DAYS = 7;

// ---------- Équipements ----------
const eqOf = async (req, id) => {
  const e = await db.prepare('SELECT * FROM maintenance_equipment WHERE id = ? AND org_id = ?').get(A.id(id, 'Équipement invalide.'), req.org.id);
  if (!e || !A.visible(req, e)) throw new HttpError(404, 'Équipement introuvable.');
  return e;
};
const eqList = async (req) => {
  const sc = A.scope(req);
  return await db.prepare(`SELECT * FROM maintenance_equipment WHERE org_id = ?${sc.sql} ORDER BY name COLLATE NOCASE`).all(req.org.id, ...sc.args);
};
const eqView = (req, e) => ({ id: e.id, name: e.name, kind: e.kind, reference: e.reference, location: e.location, purchasedAt: e.purchased_at, value: A.can(req, 'manager') ? e.value : undefined, status: e.status, meter: e.meter, notes: e.notes, branchId: e.branch_id });

function eqFields(b, cur) {
  const has = (k) => b[k] !== undefined;
  return {
    name: has('name') || !cur ? A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'équipement." }) : cur.name,
    kind: has('kind') ? A.oneOf(b.kind, KINDS, undefined, "Type d'équipement inconnu.") : cur ? cur.kind : 'machine',
    reference: has('reference') ? A.text(b.reference, 60) : cur ? cur.reference : '',
    location: has('location') ? A.text(b.location, 100) : cur ? cur.location : '',
    purchasedAt: has('purchasedAt') ? A.date(b.purchasedAt) : cur ? cur.purchased_at : null,
    value: has('value') ? U.nonneg(b.value, 0, { int: true }) : cur ? cur.value : 0,
    status: has('status') ? A.oneOf(b.status, EQ_STATUS, undefined, 'Statut inconnu.') : cur ? cur.status : 'running',
    meter: has('meter') ? U.nonneg(b.meter, 0) : cur ? cur.meter : 0,
    notes: has('notes') ? A.text(b.notes, 500) : cur ? cur.notes : '',
  };
}

router.post('/equipment', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const f = eqFields(b, null);
  const id = (await db.prepare('INSERT INTO maintenance_equipment (org_id, branch_id, name, kind, reference, location, purchased_at, value, status, meter, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, await A.branchOf(req, b.branchId), f.name, f.kind, f.reference, f.location, f.purchasedAt, f.value, f.status, f.meter, f.notes, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'maintenance', `Équipement « ${f.name} » ajouté`);
  res.status(201).json({ id: Number(id) });
});

router.put('/equipment/:id', A.need('manager'), async (req, res) => {
  const e = await eqOf(req, req.params.id);
  const f = eqFields(req.body || {}, e);
  await db.prepare('UPDATE maintenance_equipment SET name = ?, kind = ?, reference = ?, location = ?, purchased_at = ?, value = ?, status = ?, meter = ?, notes = ? WHERE id = ?').run(f.name, f.kind, f.reference, f.location, f.purchasedAt, f.value, f.status, f.meter, f.notes, e.id);
  res.json({ ok: true });
});

router.delete('/equipment/:id', A.need('manager'), async (req, res) => {
  const e = await eqOf(req, req.params.id);
  await db.transaction(async () => {
    // Les pièces prélevées du stock retournent au stock : on ne perd aucune quantité.
    const parts = await db.prepare('SELECT p.*, o.code FROM maintenance_parts p JOIN maintenance_orders o ON o.id = p.order_id WHERE o.equipment_id = ? AND p.from_stock = 1 AND p.item_id IS NOT NULL').all(e.id);
    for (const p of parts) await U.moveStock(req, p.item_id, p.quantity, `Retour pièces ${p.code} (équipement supprimé)`).catch(() => {});
    await db.prepare('DELETE FROM maintenance_equipment WHERE id = ?').run(e.id);
  })();
  res.json({ ok: true });
});

// ---------- Plans préventifs ----------
/** Calcule la prochaine échéance (date en jours, ou relevé de compteur en heures/km). */
function planNext(kind, value, lastDoneAt, lastMeter) {
  if (kind === 'days') return { nextDueAt: U.addDays(lastDoneAt, Math.round(value)), nextMeter: null };
  return { nextDueAt: null, nextMeter: U.round3(lastMeter + value) };
}
function planState(p, e) {
  if (e.status === 'retired') return { state: 'ok', left: null };
  if (p.period_kind === 'days') {
    const left = U.diffDays(U.today(), p.next_due_at);
    return { state: left < 0 ? 'late' : left <= SOON_DAYS ? 'soon' : 'ok', left };
  }
  const left = U.round3(p.next_meter - e.meter);
  return { state: left <= 0 ? 'late' : left <= p.period_value * 0.1 ? 'soon' : 'ok', left };
}
const planView = (p, e) => ({ id: p.id, equipmentId: p.equipment_id, equipment: e.name, task: p.task, periodKind: p.period_kind, periodValue: p.period_value, lastDoneAt: p.last_done_at, lastMeter: p.last_meter, nextDueAt: p.next_due_at, nextMeter: p.next_meter, ...planState(p, e) });

async function plansFor(req, eqId) {
  const eqs = new Map((await eqList(req)).map((e) => [e.id, e]));
  const rows = await db.prepare(`SELECT * FROM maintenance_plans WHERE org_id = ?${eqId ? ' AND equipment_id = ?' : ''} ORDER BY id`).all(req.org.id, ...(eqId ? [eqId] : []));
  return rows.filter((p) => eqs.has(p.equipment_id)).map((p) => planView(p, eqs.get(p.equipment_id)))
    .sort((a, b) => ({ late: 0, soon: 1, ok: 2 }[a.state] - { late: 0, soon: 1, ok: 2 }[b.state]) || (a.left - b.left));
}
const planOf = async (req, id) => {
  const p = await db.prepare('SELECT * FROM maintenance_plans WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p) throw new HttpError(404, 'Plan introuvable.');
  return { p, e: await eqOf(req, p.equipment_id) };
};

function planFields(b, e, cur) {
  const kind = b.periodKind !== undefined ? A.oneOf(b.periodKind, PERIODS, undefined, 'Périodicité inconnue (jours, heures ou km).') : cur ? cur.period_kind : 'days';
  const value = b.periodValue !== undefined ? A.qty(b.periodValue) : cur ? cur.period_value : A.qty(b.periodValue);
  const last = b.lastDoneAt !== undefined ? A.date(b.lastDoneAt) : cur ? cur.last_done_at : null;
  const lastMeter = b.lastMeter !== undefined && b.lastMeter !== '' ? U.nonneg(b.lastMeter) : cur ? cur.last_meter : e.meter;
  const n = planNext(kind, value, last || U.today(), lastMeter);
  return { task: b.task !== undefined || !cur ? A.text(b.task, 150, { required: true, msg: 'Indiquez la tâche à réaliser.' }) : cur.task, kind, value, last, lastMeter, ...n };
}

router.get('/plans', async (req, res) => res.json({ plans: await plansFor(req) }));

router.post('/plans', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const e = await eqOf(req, b.equipmentId);
  const f = planFields(b, e, null);
  const id = (await db.prepare('INSERT INTO maintenance_plans (org_id, equipment_id, task, period_kind, period_value, last_done_at, last_meter, next_due_at, next_meter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, e.id, f.task, f.kind, f.value, f.last, f.lastMeter, f.nextDueAt, f.nextMeter, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});

router.put('/plans/:id', A.need('manager'), async (req, res) => {
  const { p, e } = await planOf(req, req.params.id);
  const f = planFields(req.body || {}, e, p);
  await db.prepare('UPDATE maintenance_plans SET task = ?, period_kind = ?, period_value = ?, last_done_at = ?, last_meter = ?, next_due_at = ?, next_meter = ? WHERE id = ?').run(f.task, f.kind, f.value, f.last, f.lastMeter, f.nextDueAt, f.nextMeter, p.id);
  res.json({ ok: true });
});

router.delete('/plans/:id', A.need('manager'), async (req, res) => {
  const { p } = await planOf(req, req.params.id);
  await db.prepare('DELETE FROM maintenance_plans WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// ---------- Interventions ----------
const SEL = 'SELECT o.*, e.name AS equipment, e.branch_id AS eq_branch, COALESCE((SELECT SUM(p.quantity * p.unit_cost) FROM maintenance_parts p WHERE p.order_id = o.id), 0) AS parts_cost FROM maintenance_orders o JOIN maintenance_equipment e ON e.id = o.equipment_id WHERE o.org_id = ?';
const orderOf = async (req, id) => {
  const o = await db.prepare(SEL + ' AND o.id = ?').get(req.org.id, A.id(id, 'Intervention invalide.'));
  if (!o || !A.visible(req, { branch_id: o.eq_branch })) throw new HttpError(404, 'Intervention introuvable.');
  return o;
};
const orderView = (req, o) => {
  const mgr = A.can(req, 'manager');
  return {
    id: o.id, code: o.code, equipmentId: o.equipment_id, equipment: o.equipment, planId: o.plan_id, kind: o.kind, title: o.title, description: o.description, priority: o.priority,
    assigneeId: o.assignee_id, contractor: o.contractor, status: o.status, openedAt: o.opened_at, startedAt: o.started_at, closedAt: o.closed_at, downtimeHours: o.downtime_hours, notes: o.notes,
    laborCost: mgr ? o.labor_cost : undefined, partsCost: mgr ? Math.round(o.parts_cost) : undefined, cost: mgr ? o.labor_cost + Math.round(o.parts_cost) : undefined,
  };
};
const canWork = (req, o) => A.can(req, 'manager') || o.assignee_id === req.user.id;
const partsOf = async (id) => (await db.prepare('SELECT * FROM maintenance_parts WHERE order_id = ? ORDER BY id').all(id)).map((p) => ({ id: p.id, itemId: p.item_id, name: p.name, quantity: p.quantity, unitCost: p.unit_cost, total: Math.round(p.quantity * p.unit_cost), fromStock: Boolean(p.from_stock) }));

async function listOrders(req, where = '', args = [], limit = 120) {
  const sc = A.scope(req, 'e.branch_id');
  return await db.prepare(`${SEL}${sc.sql}${where} ORDER BY CASE o.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, CASE o.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, o.id DESC LIMIT ${limit}`).all(req.org.id, ...sc.args, ...args);
}

router.get('/orders', async (req, res) => res.json({ orders: (await listOrders(req)).map((o) => orderView(req, o)) }));

router.get('/orders/:id', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  res.json({ order: orderView(req, o), parts: A.can(req, 'manager') || o.assignee_id === req.user.id ? await partsOf(o.id) : (await partsOf(o.id)).map((p) => ({ ...p, unitCost: undefined, total: undefined })) });
});

async function nextSeq(orgId) { return (await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM maintenance_orders WHERE org_id = ?').get(orgId)).n; }

/** Crée une intervention. Un simple membre ne peut que signaler une panne (corrective, sans assignation). */
async function createOrder(req, b) {
  const e = await eqOf(req, b.equipmentId);
  const mgr = A.can(req, 'manager');
  const kind = mgr ? A.oneOf(b.kind, ['corrective', 'preventive'], 'corrective', 'Type inconnu (corrective ou préventive).') : 'corrective';
  const plan = mgr && b.planId ? (await planOf(req, b.planId)).p : null;
  if (plan && plan.equipment_id !== e.id) throw new HttpError(400, 'Ce plan ne concerne pas cet équipement.');
  const title = A.text(b.title, 150, { required: true, msg: 'Décrivez le problème ou la tâche.' });
  let id;
  await db.transaction(async () => {
    const seq = await nextSeq(req.org.id);
    id = (await db.prepare("INSERT INTO maintenance_orders (org_id, seq, code, equipment_id, plan_id, kind, title, description, priority, assignee_id, contractor, status, opened_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)")
      .run(req.org.id, seq, `OT-${String(seq).padStart(4, '0')}`, e.id, plan ? plan.id : null, kind, title, A.text(b.description, 1000), A.oneOf(b.priority, PRIORITIES, 'normal', 'Priorité inconnue.'),
        mgr ? await A.memberOf(req, b.assigneeId) : null, mgr ? A.text(b.contractor, 100) : '', A.date(b.openedAt) || U.today(), req.user.id, nowISO())).lastInsertRowid;
    if (kind === 'corrective' && e.status === 'running') await db.prepare("UPDATE maintenance_equipment SET status = 'broken' WHERE id = ?").run(e.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'maintenance', `Intervention ${kind === 'corrective' ? 'corrective' : 'préventive'} ouverte sur « ${e.name} »`);
  return Number(id);
}
router.post('/orders', async (req, res) => res.status(201).json({ id: await createOrder(req, req.body || {}) }));

/** Crée l'intervention préventive d'un plan (bouton « Planifier »). */
router.post('/plans/:id/order', A.need('manager'), async (req, res) => {
  const { p } = await planOf(req, req.params.id);
  res.status(201).json({ id: await createOrder(req, { equipmentId: p.equipment_id, planId: p.id, kind: 'preventive', title: p.task, priority: (req.body || {}).priority, assigneeId: (req.body || {}).assigneeId, contractor: (req.body || {}).contractor }) });
});

router.put('/orders/:id', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const b = req.body || {};
  if (o.status === 'done') throw new HttpError(400, 'Une intervention terminée ne se modifie plus.');
  await db.prepare('UPDATE maintenance_orders SET title = ?, description = ?, priority = ?, assignee_id = ?, contractor = ?, labor_cost = ?, notes = ? WHERE id = ?').run(
    b.title === undefined ? o.title : A.text(b.title, 150, { required: true, msg: 'Décrivez le problème ou la tâche.' }), b.description === undefined ? o.description : A.text(b.description, 1000),
    b.priority === undefined ? o.priority : A.oneOf(b.priority, PRIORITIES, undefined, 'Priorité inconnue.'), b.assigneeId === undefined ? o.assignee_id : await A.memberOf(req, b.assigneeId),
    b.contractor === undefined ? o.contractor : A.text(b.contractor, 100), b.laborCost === undefined ? o.labor_cost : U.nonneg(b.laborCost, 0, { int: true }), b.notes === undefined ? o.notes : A.text(b.notes, 500), o.id);
  res.json({ ok: true });
});

router.delete('/orders/:id', A.need('manager'), async (req, res) => {
  const o = await orderOf(req, req.params.id);
  await db.transaction(async () => {
    for (const p of await db.prepare('SELECT * FROM maintenance_parts WHERE order_id = ? AND from_stock = 1 AND item_id IS NOT NULL').all(o.id)) await U.moveStock(req, p.item_id, p.quantity, `Retour pièces ${o.code} (intervention supprimée)`).catch(() => {});
    await db.prepare('DELETE FROM maintenance_orders WHERE id = ?').run(o.id);
  })();
  res.json({ ok: true });
});

router.post('/orders/:id/start', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!canWork(req, o)) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  if (o.status !== 'open') throw new HttpError(400, 'Seule une intervention ouverte peut être démarrée.');
  await db.prepare("UPDATE maintenance_orders SET status = 'in_progress', started_at = ? WHERE id = ?").run(U.today(), o.id);
  res.json({ ok: true });
});

/** Clôture : durée d'arrêt, coût de main-d'œuvre, relevé de compteur ; replanifie le plan lié ; remet l'équipement en service si plus aucune panne ouverte. */
router.post('/orders/:id/close', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!canWork(req, o)) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  if (o.status === 'done') throw new HttpError(400, 'Cette intervention est déjà terminée.');
  const b = req.body || {};
  const e = await eqOf(req, o.equipment_id);
  const downtime = b.downtimeHours === undefined ? o.downtime_hours : U.nonneg(b.downtimeHours, 0, { max: 100000 });
  const labor = b.laborCost === undefined ? o.labor_cost : U.nonneg(b.laborCost, 0, { int: true });
  const meter = b.meter === undefined || b.meter === '' ? e.meter : U.nonneg(b.meter);
  const day = U.today();
  await db.transaction(async () => {
    await db.prepare("UPDATE maintenance_orders SET status = 'done', closed_at = ?, downtime_hours = ?, labor_cost = ?, notes = ? WHERE id = ?").run(day, downtime, labor, b.notes === undefined ? o.notes : A.text(b.notes, 500), o.id);
    if (meter !== e.meter) await db.prepare('UPDATE maintenance_equipment SET meter = ? WHERE id = ?').run(meter, e.id);
    if (o.kind === 'preventive' && o.plan_id) {
      const p = await db.prepare('SELECT * FROM maintenance_plans WHERE id = ?').get(o.plan_id);
      if (p) { const n = planNext(p.period_kind, p.period_value, day, meter); await db.prepare('UPDATE maintenance_plans SET last_done_at = ?, last_meter = ?, next_due_at = ?, next_meter = ? WHERE id = ?').run(day, meter, n.nextDueAt, n.nextMeter, p.id); }
    }
    if (o.kind === 'corrective' && e.status === 'broken' && !await db.prepare("SELECT 1 FROM maintenance_orders WHERE equipment_id = ? AND kind = 'corrective' AND status <> 'done' AND id <> ?").get(e.id, o.id)) {
      await db.prepare("UPDATE maintenance_equipment SET status = 'running' WHERE id = ?").run(e.id);
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'maintenance', `${o.code} terminée sur « ${e.name} »`);
  res.json({ ok: true });
});

// ---------- Pièces (option : prélevées du stock) ----------
router.post('/orders/:id/parts', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!canWork(req, o)) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  if (o.status === 'done') throw new HttpError(400, 'Cette intervention est terminée.');
  const b = req.body || {};
  const q = A.qty(b.quantity);
  let id;
  await db.transaction(async () => {
    if (b.itemId) {
      const it = await U.moveStock(req, b.itemId, -q, `Maintenance ${o.code}`);
      id = (await db.prepare('INSERT INTO maintenance_parts (org_id, order_id, item_id, name, quantity, unit_cost, from_stock) VALUES (?, ?, ?, ?, ?, ?, 1)').run(req.org.id, o.id, it.id, it.name, q, b.unitCost === undefined || b.unitCost === '' ? it.unit_cost : U.nonneg(b.unitCost, 0, { int: true }))).lastInsertRowid;
    } else {
      id = (await db.prepare('INSERT INTO maintenance_parts (org_id, order_id, name, quantity, unit_cost, from_stock) VALUES (?, ?, ?, ?, ?, 0)').run(req.org.id, o.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom de la pièce.' }), q, U.nonneg(b.unitCost, 0, { int: true }))).lastInsertRowid;
    }
  })();
  res.status(201).json({ id: Number(id) });
});

router.delete('/orders/:id/parts/:partId', async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!canWork(req, o)) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  if (o.status === 'done') throw new HttpError(400, 'Cette intervention est terminée.');
  const p = await db.prepare('SELECT * FROM maintenance_parts WHERE id = ? AND order_id = ?').get(A.id(req.params.partId), o.id);
  if (!p) throw new HttpError(404, 'Pièce introuvable.');
  await db.transaction(async () => {
    if (p.from_stock && p.item_id) await U.moveStock(req, p.item_id, p.quantity, `Retour pièces ${o.code}`);
    await db.prepare('DELETE FROM maintenance_parts WHERE id = ?').run(p.id);
  })();
  res.json({ ok: true });
});

// ---------- Historique par équipement ----------
router.get('/equipment/:id', async (req, res) => {
  const e = await eqOf(req, req.params.id);
  const orders = await db.prepare(`${SEL} AND o.equipment_id = ? ORDER BY o.id DESC LIMIT 100`).all(req.org.id, e.id);
  const done = orders.filter((o) => o.status === 'done');
  const mgr = A.can(req, 'manager');
  res.json({
    equipment: eqView(req, e), plans: await plansFor(req, e.id), orders: orders.map((o) => orderView(req, o)),
    totals: { interventions: orders.length, breakdowns: orders.filter((o) => o.kind === 'corrective').length, downtimeHours: U.round3(done.reduce((a, o) => a + o.downtime_hours, 0)), cost: mgr ? done.reduce((a, o) => a + o.labor_cost + Math.round(o.parts_cost), 0) : undefined },
  });
});

// ---------- Tableau de bord et indicateurs ----------
async function stats(req) {
  const eqs = await eqList(req);
  const active = eqs.filter((e) => e.status !== 'retired');
  const ids = new Set(eqs.map((e) => e.id));
  const { from, to } = A.monthRange();
  const orders = (await listOrders(req, '', [], 2000));
  const monthDone = orders.filter((o) => o.status === 'done' && o.closed_at >= from && o.closed_at < to);
  const downtime = U.round3(monthDone.reduce((a, o) => a + o.downtime_hours, 0));
  const elapsedHours = Number(U.today().slice(8, 10)) * 24;
  const availability = active.length ? Math.round(Math.max(0, 1 - downtime / (active.length * elapsedHours)) * 1000) / 10 : null;
  const yearAgo = U.addDays(U.today(), -365);
  const byEq = new Map();
  for (const o of orders) if (o.kind === 'corrective' && o.opened_at >= yearAgo && ids.has(o.equipment_id)) { const t = byEq.get(o.equipment_id) || { equipmentId: o.equipment_id, name: o.equipment, breakdowns: 0, downtimeHours: 0 }; t.breakdowns++; t.downtimeHours = U.round3(t.downtimeHours + o.downtime_hours); byEq.set(o.equipment_id, t); }
  const plans = await plansFor(req);
  return {
    equipment: { total: eqs.length, running: eqs.filter((e) => e.status === 'running').length, broken: eqs.filter((e) => e.status === 'broken').length, stopped: eqs.filter((e) => e.status === 'stopped').length, retired: eqs.filter((e) => e.status === 'retired').length },
    availability, downtimeHours: downtime,
    monthCost: A.can(req, 'manager') ? monthDone.reduce((a, o) => a + o.labor_cost + Math.round(o.parts_cost), 0) : undefined,
    openOrders: orders.filter((o) => o.status !== 'done').length, latePlans: plans.filter((p) => p.state === 'late').length, soonPlans: plans.filter((p) => p.state === 'soon').length,
    topBreakdowns: [...byEq.values()].sort((a, b) => b.breakdowns - a.breakdowns || b.downtimeHours - a.downtimeHours).slice(0, 5), plans, orders,
  };
}

router.get('/', async (req, res) => {
  const s = await stats(req);
  const { plans, orders, ...summary } = s;
  res.json({ equipment: (await eqList(req)).map((e) => eqView(req, e)), summary, alerts: plans.filter((p) => p.state !== 'ok'), orders: orders.map((o) => orderView(req, o)) });
});

module.exports = router;
module.exports.min = 'member';

// ---------- Aide à l'IA ----------
module.exports.ctx = async (req) => {
  const cur = req.org.currency;
  const s = await stats(req);
  const eqs = await eqList(req);
  const L = { running: 'en service', broken: 'EN PANNE', stopped: "à l'arrêt", retired: 'réformé' };
  return ([
    `MAINTENANCE : ${s.equipment.total} équipement(s) (${s.equipment.broken} en panne, ${s.equipment.stopped} à l'arrêt). Disponibilité du mois : ${s.availability == null ? 'n/a' : s.availability + ' %'}, arrêts : ${s.downtimeHours} h${s.monthCost !== undefined ? `, coût de maintenance du mois : ${U.money(s.monthCost, cur)}` : ''}.`,
    'Équipements :', eqs.slice(0, 30).map((e) => `- ${U.oneLine(e.name, 60)} [${L[e.status]}]${e.location ? ` (${U.oneLine(e.location, 40)})` : ''}`).join('\n') || '(aucun)',
    'Échéances préventives à surveiller :', s.plans.filter((p) => p.state !== 'ok').slice(0, 12).map((p) => `- ${U.oneLine(p.equipment, 50)} : ${U.oneLine(p.task, 60)} [${p.state === 'late' ? 'EN RETARD' : 'bientôt'}]`).join('\n') || '(aucune)',
    'Interventions ouvertes :', s.orders.filter((o) => o.status !== 'done').slice(0, 12).map((o) => `- ${o.code} ${U.oneLine(o.equipment, 40)} : ${U.oneLine(o.title, 70)} [${o.kind === 'corrective' ? 'corrective' : 'préventive'}, priorité ${o.priority}, ${o.status === 'open' ? 'ouverte' : 'en cours'}]`).join('\n') || '(aucune)',
    s.topBreakdowns.length ? 'Équipements les plus en panne (12 mois) : ' + s.topBreakdowns.map((t) => `${U.oneLine(t.name, 40)} (${t.breakdowns})`).join(', ') : '',
  ].filter(Boolean).join('\n')).slice(0, 3000);
};
module.exports.prompt = "Module Maintenance : parc d'équipements, plans préventifs, interventions correctives et préventives, pièces, indicateurs (disponibilité, arrêts, coûts). Aide la personne à prioriser les pannes, à repérer les échéances en retard et les équipements qui coûtent trop cher. Tu ne crées ni ne clôtures jamais une intervention toi-même : tu conseilles et la personne agit dans l'écran. Pour la sécurité, rappelle de suivre les consignes du constructeur.";
