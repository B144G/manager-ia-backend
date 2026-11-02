'use strict';
// Projets · vague 6 : planning (frise des tâches), décalage des tâches qui suivent un retard, alerte de budget, coûts venus des achats et du stock,
// fiabilité des données et prévision. Déclaré AVANT projects-w3.js et projects.js (chemins plus précis d'abord).
// Règle de fond : les dates, les coûts et les alertes sont calculés par le serveur à partir des données saisies ; l'IA ne fixe rien.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, log, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const DAY = 86400000;
const diffDays = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);

async function projectOf(req, id) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(404, 'Projet introuvable.');
  return p;
}

// ---------- Planning : durée d'une tâche et enchaînement ----------
/** Début et fin d'une tâche. Sans date de début : la durée vient de l'estimation (8 h par jour, au moins 1 jour) et se termine à l'échéance. Sans échéance : pas de planning. */
function span(t) {
  if (!t.due) return null;
  const end = t.due;
  let start = t.start_date;
  if (!start) start = W.addDays(end, -(Math.max(1, Math.ceil(Number(t.estimate_hours || 0) / 8)) - 1));
  if (start > end) start = end;
  return { start, end };
}

/**
 * Calcule les décalages nécessaires : une tâche ne peut pas commencer avant la fin de celle dont elle dépend.
 * Une tâche non terminée dont l'échéance est passée ne finira pas avant aujourd'hui. Les tâches terminées ne bougent pas.
 * Calendrier en jours entiers (samedi, dimanche et jours fériés ne sont pas retirés). Renvoie la liste des changements, sans rien écrire.
 */
function computeReplan(tasks, today) {
  const byId = new Map(tasks.map((t) => [Number(t.id), { t, cur: span(t), orig: span(t) }]));
  const shifted = new Map();
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (const node of byId.values()) {
      const t = node.t;
      if (!t.depends_on || t.status === 'done' || !node.cur) continue;
      const pre = byId.get(Number(t.depends_on));
      if (!pre || pre.t.status === 'done' || !pre.cur) continue;
      const preEnd = pre.cur.end < today ? today : pre.cur.end;
      if (node.cur.start > preEnd) continue;
      const days = diffDays(W.addDays(preEnd, 1), node.cur.start);
      node.cur = { start: W.addDays(node.cur.start, days), end: W.addDays(node.cur.end, days) };
      shifted.set(Number(t.id), pre.t.title);
      moved = true;
    }
    if (!moved) break;
  }
  const changes = [];
  for (const [id, because] of shifted) {
    const n = byId.get(id);
    changes.push({ id, title: n.t.title, assigneeId: n.t.assignee_id || null, fromStart: n.orig.start, fromEnd: n.orig.end, toStart: n.cur.start, toEnd: n.cur.end, days: diffDays(n.cur.end, n.orig.end), because });
  }
  let forecastEnd = null;
  for (const n of byId.values()) if (n.t.status !== 'done' && n.cur && (!forecastEnd || n.cur.end > forecastEnd)) forecastEnd = n.cur.end;
  return { changes, forecastEnd };
}

const tasksOfProject = (pid) => db.prepare(`SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id = ? ORDER BY t.id`).all(pid);

async function applyChanges(orgId, changes) {
  await db.transaction(async () => {
    for (const c of changes) await db.prepare('UPDATE tasks SET start_date = ?, due = ? WHERE id = ? AND org_id = ?').run(c.toStart, c.toEnd, c.id, orgId);
  })();
}

/** Une seule alerte par projet et par jour. */
async function noticeOnce(orgId, ref, text, role = 'manager') {
  const done = await db.prepare('SELECT 1 FROM notices WHERE org_id = ? AND ref = ? AND created_at >= ? LIMIT 1').get(orgId, ref, W.today());
  if (done) return false;
  await W.pushRole(orgId, role, 'project', text, ref);
  return true;
}

async function notifyShift(orgId, project, changes) {
  const names = new Set();
  for (const c of changes) if (c.assigneeId && !names.has(c.assigneeId)) { names.add(c.assigneeId); await W.push(orgId, c.assigneeId, 'task', `Calendrier du projet « ${oneLine(project.name, 60)} » ajusté : « ${oneLine(c.title, 70)} » passe au ${c.toEnd}.`, 'task:' + c.id); }
}

/** Décalage automatique, seulement si le réglage est actif. Utilisé après un changement de date et par la tâche planifiée. */
async function autoReplan(orgId, projectId) {
  const st = await W.settings(orgId);
  if (!st.project_auto_shift) return null;
  const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(projectId, orgId);
  if (!p || p.status === 'done') return null;
  const r = computeReplan(await tasksOfProject(p.id), W.today());
  if (!r.changes.length) return r;
  await applyChanges(orgId, r.changes);
  await notifyShift(orgId, p, r.changes);
  await noticeOnce(orgId, `replan:${p.id}`, `Projet « ${oneLine(p.name, 60)} » : ${r.changes.length} tâche(s) décalée(s) automatiquement après un retard.${p.due && r.forecastEnd && r.forecastEnd > p.due ? ` Fin prévue le ${r.forecastEnd}, après l'échéance du ${p.due}.` : ''}`);
  return r;
}

// ---------- Budget : coût réel, alertes ----------
async function projectSpent(orgId, p, st) {
  const settings = st || await W.settings(orgId);
  const hours = Number((await db.prepare('SELECT COALESCE(SUM(hours), 0) h FROM time_entries WHERE org_id = ? AND project_id = ?').get(orgId, p.id)).h);
  const expenses = Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM project_costs WHERE project_id = ?').get(p.id)).s);
  const timeCost = Math.round(hours * settings.project_hourly_cost);
  return { hours, expenses, timeCost, spent: expenses + timeCost };
}

/** Prévient les responsables quand le coût atteint le seuil réglé, puis quand il dépasse le budget. Un seul message par palier. */
async function checkBudget(orgId, projectId) {
  try {
    const p = await db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(projectId, orgId);
    if (!p) return null;
    const budget = Number(p.budget);
    const st = await W.settings(orgId);
    if (!budget || p.status === 'done') { if (Number(p.budget_alert)) await db.prepare('UPDATE projects SET budget_alert = 0 WHERE id = ?').run(p.id); return null; }
    const c = await projectSpent(orgId, p, st);
    const pct = Math.min(Math.max(Math.round(st.project_budget_alert_pct), 0), 99);
    const level = c.spent >= budget ? 100 : pct > 0 && c.spent * 100 >= budget * pct ? pct : 0;
    const before = Number(p.budget_alert);
    if (level !== before) await db.prepare('UPDATE projects SET budget_alert = ? WHERE id = ?').run(level, p.id);
    if (level > before) {
      const org = await db.prepare('SELECT currency FROM orgs WHERE id = ?').get(orgId);
      const money = (n) => `${Math.round(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} ${(org && org.currency) || ''}`.trim();
      const text = level === 100
        ? `Budget dépassé : projet « ${oneLine(p.name, 60)} », coût ${money(c.spent)} pour un budget de ${money(budget)} (dépassement ${money(c.spent - budget)}).`
        : `Projet « ${oneLine(p.name, 60)} » : ${Math.round(c.spent * 100 / budget)} % du budget consommé (${money(c.spent)} sur ${money(budget)}).`;
      await W.pushRole(orgId, 'manager', 'project', text, `projbud:${p.id}:${level}`);
    }
    return { level, ...c, budget };
  } catch (e) { log.warn('Alerte de budget projet :', oneLine(e.message, 140)); return null; }
}

/** Projets dont le coût dépasse le budget (pour l'alerte urgente du matin). */
async function overBudget(orgId) {
  const out = [];
  for (const p of await db.prepare("SELECT * FROM projects WHERE org_id = ? AND status != 'done' AND budget > 0 AND budget_alert = 100 ORDER BY id LIMIT 20").all(orgId)) out.push({ id: p.id, name: p.name, budget: Number(p.budget) });
  return out;
}

// ---------- Coûts qui viennent des achats et du stock ----------
/** Inscrit au projet le coût d'une réception de commande. Une seule fois par réception. */
async function costFromReceipt(req, order, item, receiptId, qty, price) {
  if (!order.project_id || !(price > 0)) return;
  const amount = Math.max(Math.round(qty * price), 1);
  await db.prepare("INSERT INTO project_costs (org_id, project_id, label, amount, date, created_by, created_at, source, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'purchase', ?) ON CONFLICT DO NOTHING")
    .run(req.org.id, order.project_id, oneLine(`Achat : ${item.name} (commande #${order.id})`, 150), amount, W.today(), req.user ? req.user.id : null, nowISO(), receiptId);
}
/** Inscrit au projet la valeur d'une sortie de stock (coût moyen de l'article). */
async function costFromStockOut(req, projectId, item, qty, unitValue, moveId) {
  const amount = Math.round(qty * unitValue);
  if (!(amount > 0)) return false;
  await db.prepare("INSERT INTO project_costs (org_id, project_id, label, amount, date, created_by, created_at, source, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'stock', ?) ON CONFLICT DO NOTHING")
    .run(req.org.id, projectId, oneLine(`Matière prise en stock : ${item.name} (${qty} ${item.unit || ''})`, 150), amount, W.today(), req.user ? req.user.id : null, nowISO(), moveId);
  return true;
}
/** Vérifie qu'un projet existe et est visible avant d'y rattacher un achat ou une sortie de stock. Renvoie son numéro, ou null si rien n'est choisi. */
async function linkableProject(req, id) {
  if (id === undefined || id === null || id === '') return null;
  return (await projectOf(req, id)).id;
}
/** Rattache une commande déjà passée à un projet : les réceptions déjà faites deviennent des coûts du projet. */
async function attachOrder(req, order, item, projectId) {
  await db.prepare('UPDATE purchase_orders SET project_id = ? WHERE id = ?').run(projectId, order.id);
  if (!projectId) return;
  for (const r of await db.prepare('SELECT * FROM purchase_receipts WHERE order_id = ? ORDER BY id').all(order.id)) await costFromReceipt(req, { ...order, project_id: projectId }, item, r.id, Number(r.quantity), Number(r.unit_price));
  await checkBudget(req.org.id, projectId);
}

// ---------- Fiabilité des données et prévision ----------
async function insight(orgId, p, st) {
  const settings = st || await W.settings(orgId);
  const tasks = await tasksOfProject(p.id);
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  const logged = new Map((await db.prepare('SELECT task_id, SUM(hours) h FROM time_entries WHERE org_id = ? AND project_id = ? GROUP BY task_id').all(orgId, p.id)).map((r) => [Number(r.task_id), Number(r.h)]));
  const gaps = [];
  const noEst = open.filter((t) => !(Number(t.estimate_hours) > 0)).length;
  const noWho = open.filter((t) => !t.assignee_id).length;
  const noDue = open.filter((t) => !t.due).length;
  const doneNoTime = done.filter((t) => !logged.get(Number(t.id))).length;
  if (noEst) gaps.push({ code: 'estimate', count: noEst, text: `${noEst} tâche(s) ouverte(s) sans estimation d'heures` });
  if (noWho) gaps.push({ code: 'assignee', count: noWho, text: `${noWho} tâche(s) ouverte(s) sans responsable` });
  if (noDue) gaps.push({ code: 'due', count: noDue, text: `${noDue} tâche(s) ouverte(s) sans date` });
  if (!Number(p.budget)) gaps.push({ code: 'budget', count: 1, text: 'aucun budget fixé' });
  if (!(settings.project_hourly_cost > 0)) gaps.push({ code: 'rate', count: 1, text: "coût horaire non réglé : le temps passé n'est pas valorisé" });
  if (done.length && doneNoTime) gaps.push({ code: 'time', count: doneNoTime, text: `${doneNoTime} tâche(s) terminée(s) sans temps saisi` });
  const total = Math.max(tasks.length, 1);
  // Chaque manque retire des points selon la part de tâches concernée (ou une part fixe pour le budget et le coût horaire).
  let score = 100;
  score -= Math.round(30 * noEst / Math.max(open.length, 1)) + Math.round(20 * noWho / Math.max(open.length, 1)) + Math.round(20 * noDue / Math.max(open.length, 1));
  if (!Number(p.budget)) score -= 10;
  if (!(settings.project_hourly_cost > 0)) score -= 10;
  if (done.length && doneNoTime) score -= Math.round(10 * doneNoTime / done.length);
  if (!tasks.length) score = 0;
  score = Math.min(Math.max(score, 0), 100);
  const level = score >= 80 ? 'good' : score >= 50 ? 'medium' : 'low';

  // Écart entre l'estimation et le temps réellement passé sur les tâches terminées (sert à corriger la prévision, jamais à la remplacer).
  const meas = done.filter((t) => Number(t.estimate_hours) > 0 && logged.get(Number(t.id)) > 0);
  const estSum = meas.reduce((a, t) => a + Number(t.estimate_hours), 0);
  const realSum = meas.reduce((a, t) => a + logged.get(Number(t.id)), 0);
  const ratio = meas.length >= 2 && estSum > 0 ? Math.round(realSum / estSum * 100) / 100 : null;
  const openEst = open.reduce((a, t) => a + Number(t.estimate_hours || 0), 0);
  const c = await projectSpent(orgId, p, settings);
  const plan = computeReplan(tasks, W.today());
  const budget = Number(p.budget);
  const rate = settings.project_hourly_cost;
  const projected = rate > 0 && openEst > 0 ? Math.round(c.spent + openEst * (ratio || 1) * rate) : null;
  const confidence = level === 'good' && meas.length >= 3 ? 'good' : level === 'low' || !tasks.length ? 'low' : 'medium';
  const notes = [];
  if (ratio && ratio > 1.15) notes.push(`Sur les tâches terminées, le temps réel est ${Math.round((ratio - 1) * 100)} % au-dessus des estimations : la prévision en tient compte.`);
  if (ratio && ratio < 0.85) notes.push(`Sur les tâches terminées, le temps réel est ${Math.round((1 - ratio) * 100)} % sous les estimations.`);
  notes.push('La prévision de coût ne compte que le temps restant estimé : les achats et dépenses à venir ne sont pas prévus.');
  notes.push('Le calendrier compte les jours entiers (week-ends et jours fériés non retirés).');
  return {
    quality: { score, level, gaps },
    forecast: {
      endDate: plan.forecastEnd, dueDate: p.due || null, lateDays: p.due && plan.forecastEnd && plan.forecastEnd > p.due ? diffDays(plan.forecastEnd, p.due) : 0,
      conflicts: plan.changes.length, remainingHours: openEst, estimateRatio: ratio, projectedCost: projected, budget: budget || null,
      overBudgetProjected: Boolean(budget && projected && projected > budget), confidence, notes,
    },
    costs: c,
  };
}

// ---------- Routes ----------
router.get('/:id/schedule', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const tasks = await tasksOfProject(p.id);
  const today = W.today();
  const plan = computeReplan(tasks, today);
  const bySlip = new Map(plan.changes.map((c) => [c.id, c]));
  const ms = await db.prepare('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY due IS NULL, due, id').all(p.id);
  const items = tasks.map((t) => {
    const s = span(t); const ch = bySlip.get(Number(t.id));
    return { id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assignee || null, assigneeId: t.assignee_id, dependsOn: t.depends_on, estimateHours: Number(t.estimate_hours),
      start: s ? s.start : null, end: s ? s.end : null, late: Boolean(t.status !== 'done' && t.due && t.due < today), needsShift: ch ? { toStart: ch.toStart, toEnd: ch.toEnd, days: ch.days, because: ch.because } : null };
  });
  const dates = items.flatMap((i) => (i.start ? [i.start, i.end] : [])).concat(p.due ? [p.due] : [], ms.filter((m) => m.due).map((m) => m.due), [today]);
  res.json({ project: { id: p.id, name: p.name, due: p.due }, today, from: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : today, to: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : today,
    tasks: items, milestones: ms.map((m) => ({ id: m.id, title: m.title, due: m.due, done: Boolean(Number(m.done)) })),
    forecast: { endDate: plan.forecastEnd, lateDays: p.due && plan.forecastEnd && plan.forecastEnd > p.due ? diffDays(plan.forecastEnd, p.due) : 0, conflicts: plan.changes.length } });
});

router.get('/:id/replan', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const r = computeReplan(await tasksOfProject(p.id), W.today());
  res.json({ changes: r.changes, forecastEnd: r.forecastEnd, dueDate: p.due || null, lateDays: p.due && r.forecastEnd && r.forecastEnd > p.due ? diffDays(r.forecastEnd, p.due) : 0 });
});
router.post('/:id/replan', mgr, async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const r = computeReplan(await tasksOfProject(p.id), W.today());
  if (r.changes.length) {
    await applyChanges(req.org.id, r.changes);
    await W.audit(req, 'project', p.id, 'replan', null, { shifted: r.changes.map((c) => ({ id: c.id, to: c.toEnd })) });
    await notifyShift(req.org.id, p, r.changes);
    await A.logActivity(req.org.id, req.user.id, 'projects', `Projet « ${p.name} » : ${r.changes.length} tâche(s) décalée(s)`);
  }
  res.json({ applied: r.changes.length, changes: r.changes, forecastEnd: r.forecastEnd });
});

/** Décale une tâche de N jours (positif ou négatif) ; celles qui en dépendent suivent si c'est nécessaire. `apply` absent = simple aperçu. */
router.post('/tasks/:id/shift', mgr, async (req, res) => {
  const t = await db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t || !A.visible(req, t)) throw new HttpError(404, 'Tâche introuvable.');
  if (!t.project_id) throw new HttpError(400, "Cette tâche n'est dans aucun projet.");
  if (!t.due) throw new HttpError(400, "Donnez d'abord une date à cette tâche.");
  const days = Math.round(Number((req.body || {}).days));
  if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 365) throw new HttpError(400, 'Indiquez un nombre de jours différent de zéro (365 au plus).');
  const s = span(t);
  const own = { ...t, start_date: W.addDays(s.start, days), due: W.addDays(s.end, days) };
  const tasks = (await tasksOfProject(t.project_id)).map((x) => (Number(x.id) === Number(t.id) ? own : x));
  const r = computeReplan(tasks, W.today());
  const changes = [{ id: t.id, title: t.title, assigneeId: t.assignee_id || null, fromStart: s.start, fromEnd: s.end, toStart: own.start_date, toEnd: own.due, days, because: null }].concat(r.changes);
  if (!(req.body || {}).apply) return res.json({ preview: true, changes, forecastEnd: r.forecastEnd });
  await applyChanges(req.org.id, changes);
  await W.audit(req, 'task', t.id, 'shift', { due: t.due }, { due: own.due, followers: r.changes.length });
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(t.project_id);
  await notifyShift(req.org.id, p, changes.filter((c) => c.id !== t.id));
  res.json({ applied: changes.length, changes, forecastEnd: r.forecastEnd });
});

router.get('/:id/insight', async (req, res) => {
  const p = await projectOf(req, req.params.id);
  const r = await insight(req.org.id, p);
  const mg = A.can(req, 'manager');
  res.json({ quality: r.quality, forecast: mg ? r.forecast : { ...r.forecast, projectedCost: undefined, budget: undefined, overBudgetProjected: undefined } });
});

/** Contrôle de fond (tâche planifiée) : alertes de budget et retards qui bousculent les tâches suivantes. */
async function watchAll() {
  let n = 0;
  for (const p of await db.prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY id LIMIT 2000").all()) {
    try {
      await checkBudget(p.org_id, p.id);
      const st = await W.settings(p.org_id);
      if (st.project_auto_shift) { const r = await autoReplan(p.org_id, p.id); if (r && r.changes.length) n++; continue; }
      const r = computeReplan(await tasksOfProject(p.id), W.today());
      if (r.changes.length) {
        const late = p.due && r.forecastEnd && r.forecastEnd > p.due;
        await noticeOnce(p.org_id, `replan:${p.id}`, `Projet « ${oneLine(p.name, 60)} » : ${r.changes.length} tâche(s) à décaler à cause d'un retard.${late ? ` Fin prévue le ${r.forecastEnd}, après l'échéance du ${p.due}.` : ''} Ouvrez le planning pour les décaler en un clic.`);
        n++;
      }
    } catch (e) { log.warn('Contrôle des projets :', oneLine(e.message, 140)); }
  }
  return n;
}

module.exports = router;
Object.assign(module.exports, { computeReplan, span, checkBudget, autoReplan, watchAll, overBudget, costFromReceipt, costFromStockOut, linkableProject, attachOrder, insight, projectSpent });
