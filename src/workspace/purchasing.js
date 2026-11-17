'use strict';
// Achats (1/5) : aperçu, réglages, demandes d'achat, appels d'offres. Les autres parties : purchasing-orders, -invoices, -suppliers, -reports.
// Tout membre fait une demande ; un responsable (ou plus, selon les seuils) l'approuve ; personne n'approuve sa propre demande (sauf le propriétaire).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const P = require('./purchasing-lib');
const W = require('./w3');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');

// ---------- Aperçu ----------
router.get('/summary', async (req, res) => {
  const mine = await db.prepare('SELECT status, COUNT(*) AS c FROM pur_requests WHERE org_id = ? AND requester_id = ? GROUP BY status').all(req.org.id, req.user.id);
  const myRequests = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
  for (const r of mine) if (r.status in myRequests) myRequests[r.status] = Number(r.c);
  const out = { myRequests, canManage: A.can(req, 'manager'), canAdmin: A.can(req, 'admin') };
  if (A.can(req, 'manager')) {
    const c = async (sql, ...a) => Number((await db.prepare(sql).get(req.org.id, ...a)).c);
    out.pending = {
      requests: await c("SELECT COUNT(*) AS c FROM pur_requests WHERE org_id = ? AND status = 'submitted'"),
      orders: await c("SELECT COUNT(*) AS c FROM pur_orders WHERE org_id = ? AND status = 'draft'"),
      late: await c("SELECT COUNT(*) AS c FROM pur_orders WHERE org_id = ? AND status IN ('approved','sent','partial') AND expected_date IS NOT NULL AND expected_date < ?", P.today()),
      invoices: await c("SELECT COUNT(*) AS c FROM pur_invoices WHERE org_id = ? AND status IN ('entered','matched','blocked')"),
      rfqs: await c("SELECT COUNT(*) AS c FROM pur_rfqs WHERE org_id = ? AND status = 'open'"),
    };
  }
  res.json(out);
});

/** Articles sous leur seuil, en tenant compte de ce qui est déjà commandé ; meilleur prix fournisseur connu. */
router.get('/reorder', mgr, async (req, res) => {
  const items = await db.prepare('SELECT * FROM stock_items WHERE org_id = ? AND min_quantity > 0 ORDER BY name').all(req.org.id);
  const open = await db.prepare(`SELECT o.id FROM pur_orders o WHERE o.org_id = ? AND o.status IN ('draft','approved','sent','partial')`).all(req.org.id);
  const pendingByItem = {};
  for (const o of open) for (const l of await P.orderLineState(o.id)) if (l.item_id) pendingByItem[Number(l.item_id)] = (pendingByItem[Number(l.item_id)] || 0) + l.remaining;
  const out = [];
  for (const it of items) {
    const q = Number(it.quantity); const min = Number(it.min_quantity); const ord = P.round3(pendingByItem[Number(it.id)] || 0);
    if (q + ord >= min) continue;
    const target = Number(it.max_quantity) > min ? Number(it.max_quantity) : min * 2;
    const suggested = P.round3(Math.max(min - q - ord, target - q - ord));
    const best = await db.prepare('SELECT p.unit_price, s.name FROM supplier_prices p JOIN suppliers s ON s.id = p.supplier_id WHERE p.item_id = ? AND s.blocked = 0 ORDER BY p.unit_price LIMIT 1').get(it.id);
    out.push({ itemId: Number(it.id), name: it.name, unit: it.unit, quantity: q, minQuantity: min, onOrder: ord, suggested, supplier: best ? { name: best.name, unitPrice: Number(best.unit_price) } : null });
  }
  res.json({ items: out });
});

router.get('/categories', async (req, res) => {
  const y = P.yearOf();
  const set = new Map();
  const add = (c) => { const s = String(c || '').trim(); if (s && !set.has(s.toLowerCase())) set.set(s.toLowerCase(), s); };
  for (const r of await db.prepare("SELECT DISTINCT category FROM budget_annual WHERE org_id = ? AND kind = 'expense' AND year IN (?, ?)").all(req.org.id, y, String(Number(y) + 1))) add(r.category);
  for (const r of await db.prepare('SELECT category FROM budget_plans WHERE org_id = ?').all(req.org.id)) add(r.category);
  for (const t of ['pur_requests', 'pur_orders', 'pur_rfqs']) for (const r of await db.prepare(`SELECT DISTINCT category FROM ${t} WHERE org_id = ? AND category != ''`).all(req.org.id)) add(r.category);
  res.json({ categories: [...set.values()].sort((a, b) => a.localeCompare(b, 'fr')) });
});

// ---------- Réglages ----------
const ROLE_OPTIONS = P.APPROVER_ROLES.map((role) => ({ role, label: A.ROLE_LABEL[role] }));
// Tout membre lit les réglages (seuils d'approbation, tolérances) : il sait ainsi qui devra approuver sa demande.
const settingsView = async (org) => ({ ...(await P.settingsOf(org)), roles: ROLE_OPTIONS });
router.get('/settings', async (req, res) => res.json(await settingsView(req.org)));
router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const num = (v, max, msg) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, msg); return n; };
  const rules = (list) => {
    if (!Array.isArray(list)) return [];
    if (list.length > 10) throw new HttpError(400, 'Dix seuils au plus.');
    const out = list.filter((r) => r && r.minAmount !== '' && r.minAmount !== null && r.minAmount !== undefined).map((r) => {
      if (!P.APPROVER_ROLES.includes(r.role)) throw new HttpError(400, "Rôle d'approbation : responsable, administrateur ou propriétaire.");
      return { minAmount: P.money(r.minAmount, 'Seuil invalide.'), role: r.role };
    }).sort((x, y) => x.minAmount - y.minAmount);
    if (new Set(out.map((r) => r.minAmount)).size !== out.length) throw new HttpError(400, 'Deux seuils ont le même montant.');
    return out;
  };
  const cur = await P.settingsOf(req.org);
  const data = {
    tolQtyPct: b.tolQtyPct === undefined ? cur.tolQtyPct : num(b.tolQtyPct, 50, 'Tolérance de quantité : entre 0 et 50 %.'),
    tolPricePct: b.tolPricePct === undefined ? cur.tolPricePct : num(b.tolPricePct, 50, 'Tolérance de prix : entre 0 et 50 %.'),
    tolAmount: b.tolAmount === undefined ? cur.tolAmount : Math.round(num(b.tolAmount, 1e9, 'Écart de total invalide.')),
    budgetBlock: b.budgetBlock === undefined ? cur.budgetBlock : Boolean(b.budgetBlock),
    defaultTermsDays: b.defaultTermsDays === undefined ? cur.defaultTermsDays : Math.round(num(b.defaultTermsDays, 365, 'Délai de paiement : entre 0 et 365 jours.')),
    thresholds: { request: b.thresholds ? rules(b.thresholds.request) : cur.thresholds.request, order: b.thresholds ? rules(b.thresholds.order) : cur.thresholds.order },
  };
  await db.prepare('INSERT INTO pur_settings (org_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(req.org.id, JSON.stringify(data), nowISO());
  await A.logActivity(req.org.id, req.user.id, 'purchasing', 'Réglages des achats modifiés');
  res.json({ ok: true, ...(await settingsView(req.org)) });
});

// ---------- Demandes d'achat ----------
const reqTotal = (lines) => lines.reduce((s, l) => s + P.amount(l.quantity, l.est_price), 0);
async function requestOf(req, idv) {
  const r = await db.prepare('SELECT * FROM pur_requests WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  // Un simple membre ne voit que ses demandes.
  if (!r || (Number(r.requester_id) !== Number(req.user.id) && (!A.can(req, 'manager') || !A.visible(req, r)))) throw new HttpError(404, "Demande d'achat introuvable.");
  return r;
}
const linesOfRequest = (id) => db.prepare('SELECT * FROM pur_request_lines WHERE request_id = ? ORDER BY position, id').all(id);
async function canApproveRequest(req, r, total) {
  if (r.status !== 'submitted' || !A.can(req, 'manager')) return false;
  if (Number(r.requester_id) === Number(req.user.id) && req.member.role !== 'owner') return false;
  const role = P.requiredRole(await P.settingsOf(req.org), 'request', total);
  return A.RANK[req.member.role] >= A.RANK[role];
}
async function saveRequestLines(requestId, lines) {
  await db.prepare('DELETE FROM pur_request_lines WHERE request_id = ?').run(requestId);
  let pos = 0;
  for (const l of lines) await db.prepare('INSERT INTO pur_request_lines (request_id, item_id, description, unit, quantity, est_price, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(requestId, l.itemId, l.description, l.unit, l.quantity, l.price, pos++);
}

router.get('/requests', async (req, res) => {
  const q = req.query || {};
  const onlyMine = !A.can(req, 'manager') || String(q.mine || '') === '1';
  let where = 'r.org_id = ?'; const args = [req.org.id];
  if (onlyMine) { where += ' AND r.requester_id = ?'; args.push(req.user.id); } else { const sc = A.scope(req, 'r.branch_id'); where += sc.sql; args.push(...sc.args); }
  const counts = {};
  for (const c of await db.prepare(`SELECT r.status, COUNT(*) AS c FROM pur_requests r WHERE ${where} GROUP BY r.status`).all(...args)) counts[c.status] = Number(c.c);
  const status = String(q.status || '').trim();
  if (status) { where += ' AND r.status = ?'; args.push(status); }
  const rows = await db.prepare(`SELECT r.*, u.name AS requester FROM pur_requests r LEFT JOIN users u ON u.id = r.requester_id WHERE ${where} ORDER BY r.id DESC LIMIT 500`).all(...args);
  const out = [];
  for (const r of rows) out.push({ id: Number(r.id), number: r.number, title: r.title, requester: r.requester || '', createdAt: r.created_at, category: r.category || null, neededDate: r.needed_date || null, total: reqTotal(await linesOfRequest(r.id)), status: r.status, projectId: r.project_id ? Number(r.project_id) : null, branchId: r.branch_id ? Number(r.branch_id) : null, requiredRole: r.required_role || 'manager' });
  res.json({ requests: out, counts });
});

async function readRequest(req, b, cur) {
  // Modification : ce qui n'est pas envoyé reste inchangé.
  const has = (k) => b[k] !== undefined;
  const title = A.text(has('title') || !cur ? b.title : cur.title, 150, { required: true, msg: 'Donnez un titre à la demande.' });
  const lines = !has('lines') && cur ? (await linesOfRequest(cur.id)).map((l) => ({ itemId: l.item_id ? Number(l.item_id) : null, description: l.description, unit: l.unit, quantity: Number(l.quantity), price: l.est_price === null ? null : Number(l.est_price) })) : await P.readLines(req, b.lines, 'estPrice');
  const needed = P.dateOrNull(has('neededDate') || !cur ? b.neededDate : cur.needed_date);
  // Une date souhaitée déjà passée est refusée à la création (et si on la change) ; une demande ancienne reste modifiable sans toucher à sa date.
  if (needed && needed < P.today() && !(cur && cur.needed_date === needed)) throw new HttpError(400, 'La date souhaitée est déjà passée.');
  const projectId = b.projectId === undefined && cur ? (cur.project_id ? Number(cur.project_id) : null) : await P.projectOf(req, b.projectId);
  const branchId = b.branchId === undefined && cur ? (cur.branch_id ? Number(cur.branch_id) : null) : await A.branchOf(req, b.branchId);
  return { title, justification: cleanText(String(has('justification') || !cur ? b.justification || '' : cur.justification || ''), 2000), neededDate: needed, category: P.category(has('category') || !cur ? b.category : cur.category), projectId, branchId, lines };
}
/** À la soumission : le rôle d'approbation requis est figé selon le montant et les approbateurs sont prévenus. */
async function onSubmitted(req, r, total) {
  const role = P.requiredRole(await P.settingsOf(req.org), 'request', total);
  await db.prepare('UPDATE pur_requests SET required_role = ?, submitted_at = ? WHERE id = ?').run(role, nowISO(), r.id);
  await W.pushRole(req.org.id, role, 'purchasing', `Demande d'achat ${r.number} « ${r.title} » (${total.toLocaleString('fr-FR')} FCFA) à approuver.`, `pur-req:${r.id}`);
}
router.post('/requests', async (req, res) => {
  const b = req.body || {};
  const v = await readRequest(req, b);
  const now = nowISO();
  const r = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'DA', now);
    const id = Number((await db.prepare('INSERT INTO pur_requests (org_id, number, title, justification, category, needed_date, status, requester_id, created_at, updated_at, project_id, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, number, v.title, v.justification, v.category, v.neededDate, b.submit ? 'submitted' : 'draft', req.user.id, now, now, v.projectId, v.branchId)).lastInsertRowid);
    await saveRequestLines(id, v.lines);
    return { id, number };
  })();
  if (b.submit) await onSubmitted(req, { ...r, title: v.title }, v.lines.reduce((s, l) => s + P.amount(l.quantity, l.price), 0));
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number}${b.submit ? ' envoyée pour approbation' : ' enregistrée'}`);
  const extra = b.submit && v.category ? await P.budgetCheck(req, v.category, P.yearOf(), v.lines.reduce((s, l) => s + P.amount(l.quantity, l.price), 0), { warnOnly: true }) : {};
  res.status(201).json({ ...r, status: b.submit ? 'submitted' : 'draft', ...extra });
});
router.put('/requests/:id', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  if (Number(r.requester_id) !== Number(req.user.id) && !A.can(req, 'admin')) throw new HttpError(403, 'Votre rôle ne permet pas cette action.');
  if (r.status !== 'draft') throw new HttpError(400, 'Seul un brouillon se modifie. Retirez la demande de la validation pour la corriger.');
  const v = await readRequest(req, req.body || {}, r);
  await db.transaction(async () => {
    if ((await P.lockRow('pur_requests', r.id)).status !== 'draft') throw new HttpError(400, 'Seul un brouillon se modifie. Retirez la demande de la validation pour la corriger.');
    await db.prepare('UPDATE pur_requests SET title = ?, justification = ?, category = ?, needed_date = ?, project_id = ?, branch_id = ?, updated_at = ? WHERE id = ?').run(v.title, v.justification, v.category, v.neededDate, v.projectId, v.branchId, nowISO(), r.id);
    await saveRequestLines(r.id, v.lines);
  })();
  res.json({ ok: true });
});

router.get('/requests/:id', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  const lines = await linesOfRequest(r.id);
  const total = reqTotal(lines);
  const names = await P.nameMap([r.requester_id, r.decided_by]);
  const settings = await P.settingsOf(req.org);
  const b = r.category ? await P.budgetOf(req.org.id, r.category, P.yearOf(r.created_at)) : null;
  res.json({ request: {
    id: Number(r.id), number: r.number, title: r.title, status: r.status, requester: names[Number(r.requester_id)] || '', createdAt: r.created_at,
    neededDate: r.needed_date || null, category: r.category || null, justification: r.justification || null,
    lines: lines.map((l) => ({ id: Number(l.id), itemId: l.item_id ? Number(l.item_id) : undefined, description: l.description, quantity: Number(l.quantity), unit: l.unit, estPrice: l.est_price === null ? null : Number(l.est_price), amount: P.amount(l.quantity, l.est_price) })),
    total, requiredRole: P.requiredRole(settings, 'request', total), requiredRoleLabel: A.ROLE_LABEL[P.requiredRole(settings, 'request', total)],
    projectId: r.project_id ? Number(r.project_id) : null, branchId: r.branch_id ? Number(r.branch_id) : null, submittedAt: r.submitted_at || null,
    budget: b ? { ...b, over: b.available < (['draft', 'submitted', 'approved'].includes(r.status) ? total : 0) } : null,
    decider: r.decided_by ? names[Number(r.decided_by)] || '' : null, decidedAt: r.decided_at || null,
    rejectReason: r.reject_reason || null, mine: Number(r.requester_id) === Number(req.user.id), canApprove: await canApproveRequest(req, r, total),
    orderId: r.order_id ? Number(r.order_id) : null,
  } });
});

/** Change le statut si la demande est encore dans l'état lu (`from`, par défaut r.status) : deux actions simultanées ne s'appliquent pas toutes les deux. */
async function setStatus(r, status, extra = {}, from = [r.status]) {
  const sets = ['status = ?', 'updated_at = ?']; const args = [status, nowISO()];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); args.push(v); }
  const x = await db.prepare(`UPDATE pur_requests SET ${sets.join(', ')} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`).run(...args, r.id, ...from);
  if (!x.changes) throw new HttpError(409, "Cette demande vient d'être modifiée par quelqu'un d'autre : rechargez-la.");
}
const mineOnly = (req, r) => { if (Number(r.requester_id) !== Number(req.user.id)) throw new HttpError(403, 'Seul le demandeur peut faire cette action.'); };
router.post('/requests/:id/submit', async (req, res) => {
  const r = await requestOf(req, req.params.id); mineOnly(req, r);
  if (r.status !== 'draft') throw new HttpError(400, 'Cette demande a déjà été envoyée.');
  await setStatus(r, 'submitted');
  const total = reqTotal(await linesOfRequest(r.id));
  await onSubmitted(req, r, total);
  res.json({ ok: true, ...(r.category ? await P.budgetCheck(req, r.category, P.yearOf(), total, { warnOnly: true }) : {}) });
});
router.post('/requests/:id/withdraw', async (req, res) => {
  const r = await requestOf(req, req.params.id); mineOnly(req, r);
  if (r.status !== 'submitted') throw new HttpError(400, "Seule une demande en attente d'approbation peut être retirée.");
  await setStatus(r, 'draft');
  res.json({ ok: true });
});
router.post('/requests/:id/approve', mgr, async (req, res) => {
  const r = await requestOf(req, req.params.id);
  if (r.status !== 'submitted') throw new HttpError(400, "Cette demande n'attend pas d'approbation.");
  if (Number(r.requester_id) === Number(req.user.id) && req.member.role !== 'owner') throw new HttpError(403, 'Vous ne pouvez pas approuver votre propre demande : un autre responsable doit le faire.');
  // Montant relu sous verrou : le demandeur ne peut pas retirer, gonfler puis renvoyer sa demande pendant l'approbation.
  const warn = await db.transaction(async () => {
    const cur = await P.lockRow('pur_requests', r.id);
    if (cur.status !== 'submitted') throw new HttpError(400, "Cette demande n'attend pas d'approbation.");
    const total = reqTotal(await linesOfRequest(r.id));
    const role = P.requiredRole(await P.settingsOf(req.org), 'request', total);
    if (A.RANK[req.member.role] < A.RANK[role]) throw new HttpError(403, `Ce montant demande l'approbation d'un ${A.ROLE_LABEL[role].toLowerCase()} ou d'un rôle supérieur.`);
    const w = r.category ? await P.budgetCheck(req, r.category, P.yearOf(r.created_at), total, { override: (req.body || {}).overrideBudget === true }) : {};
    await setStatus(cur, 'approved', { decided_by: req.user.id, decided_at: nowISO(), reject_reason: '' });
    return w;
  })();
  await W.push(req.org.id, r.requester_id, 'purchasing', `Votre demande d'achat ${r.number} « ${r.title} » est approuvée.`, `pur-req:${r.id}`);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number} approuvée`);
  res.json({ ok: true, ...warn });
});
router.post('/requests/:id/reject', mgr, async (req, res) => {
  const r = await requestOf(req, req.params.id);
  if (r.status !== 'submitted') throw new HttpError(400, "Cette demande n'attend pas d'approbation.");
  if (Number(r.requester_id) === Number(req.user.id) && req.member.role !== 'owner') throw new HttpError(403, 'Vous ne pouvez pas approuver votre propre demande : un autre responsable doit le faire.');
  const reason = cleanText(String((req.body || {}).reason || ''), 500);
  if (!reason) throw new HttpError(400, 'Indiquez le motif du refus.');
  const need = P.requiredRole(await P.settingsOf(req.org), 'request', reqTotal(await linesOfRequest(r.id)));
  if (A.RANK[req.member.role] < A.RANK[need]) throw new HttpError(403, `Ce montant doit être traité par : ${A.ROLE_LABEL[need]}.`);
  await setStatus(r, 'rejected', { decided_by: req.user.id, decided_at: nowISO(), reject_reason: reason });
  await W.push(req.org.id, r.requester_id, 'purchasing', `Votre demande d'achat ${r.number} est refusée : ${reason}`, `pur-req:${r.id}`);
  res.json({ ok: true });
});
router.post('/requests/:id/cancel', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  if (Number(r.requester_id) !== Number(req.user.id) && !A.can(req, 'admin')) throw new HttpError(403, 'Votre rôle ne permet pas cette action.');
  if (!['draft', 'submitted', 'approved'].includes(r.status)) throw new HttpError(400, 'Cette demande ne peut plus être annulée.');
  await setStatus(r, 'cancelled', {}, ['draft', 'submitted', 'approved']);
  res.json({ ok: true });
});
router.post('/requests/:id/duplicate', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  const lines = await linesOfRequest(r.id);
  const now = nowISO();
  const out = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'DA', now);
    const id = Number((await db.prepare("INSERT INTO pur_requests (org_id, number, title, justification, category, needed_date, status, requester_id, created_at, updated_at, project_id, branch_id) VALUES (?, ?, ?, ?, ?, NULL, 'draft', ?, ?, ?, ?, ?)")
      .run(req.org.id, number, r.title, r.justification, r.category, req.user.id, now, now, r.project_id, r.branch_id)).lastInsertRowid);
    await saveRequestLines(id, lines.map((l) => ({ itemId: l.item_id, description: l.description, unit: l.unit, quantity: l.quantity, price: l.est_price })));
    return { id, number };
  })();
  res.status(201).json(out);
});
router.delete('/requests/:id', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  if (Number(r.requester_id) !== Number(req.user.id) && !A.can(req, 'admin')) throw new HttpError(403, 'Votre rôle ne permet pas cette action.');
  if (r.status !== 'draft') throw new HttpError(400, 'Seul un brouillon se supprime.');
  await db.prepare("DELETE FROM pur_requests WHERE id = ? AND status = 'draft'").run(r.id);
  res.json({ ok: true });
});

/** Fournisseur utilisable pour une commande (de l'organisation, non bloqué). */
async function supplierForOrder(req, idv) {
  const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(idv, 'Choisissez le fournisseur.'), req.org.id);
  if (!s) throw new HttpError(404, 'Fournisseur introuvable.');
  if (Number(s.blocked)) throw new HttpError(400, 'Ce fournisseur est bloqué : il ne peut plus recevoir de commande.');
  return s;
}
/** Crée un bon de commande en brouillon (depuis une demande ou un appel d'offres). */
async function createDraftOrder(req, { supplier, lines, category, notes, requestId, rfqId, paymentDays, expectedDate, projectId, branchId }) {
  const now = nowISO();
  const settings = await P.settingsOf(req.org);
  const number = await P.nextNumber(req.org.id, 'BC', now);
  const pd = paymentDays !== undefined && paymentDays !== null ? Number(paymentDays) : (supplier.payment_days !== null && supplier.payment_days !== undefined ? Number(supplier.payment_days) : settings.defaultTermsDays);
  if (expectedDate && expectedDate < P.today()) expectedDate = null; // une date de livraison déjà passée n'a pas de sens pour un nouveau bon
  const id = Number((await db.prepare(`INSERT INTO pur_orders (org_id, number, supplier_id, supplier_name, status, order_date, expected_date, payment_days, vat_rate, category, notes, request_id, rfq_id, project_id, branch_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, number, supplier.id, supplier.name, P.today(), expectedDate || null, pd, Number(req.org.vat_rate) || 0, category || '', notes || '', requestId || null, rfqId || null, projectId || null, branchId || null, req.user.id, now, now)).lastInsertRowid);
  let pos = 0;
  for (const l of lines) await db.prepare('INSERT INTO pur_order_lines (order_id, item_id, description, unit, quantity, unit_price, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, l.itemId || null, l.description, l.unit || '', l.quantity, l.unitPrice || 0, pos++);
  await P.syncOrderTotals(id);
  return { id, number };
}
router.post('/requests/:id/to-order', mgr, async (req, res) => {
  const r = await requestOf(req, req.params.id);
  if (r.status !== 'approved') throw new HttpError(400, 'Seule une demande approuvée peut devenir un bon de commande.');
  const b = req.body || {};
  const supplier = await supplierForOrder(req, b.supplierId);
  const prices = b.prices && typeof b.prices === 'object' ? b.prices : {};
  const lines = [];
  for (const l of await linesOfRequest(r.id)) {
    let price = l.est_price !== null ? Number(l.est_price) : null;
    if (prices[l.id] !== undefined && prices[l.id] !== '' && prices[l.id] !== null) price = P.money(prices[l.id], 'Prix invalide.');
    if (price === null && l.item_id) { const sp = await db.prepare('SELECT unit_price FROM supplier_prices WHERE item_id = ? AND supplier_id = ?').get(l.item_id, supplier.id); if (sp) price = Number(sp.unit_price); }
    if (price === null && l.item_id) { const it = await db.prepare('SELECT unit_cost FROM stock_items WHERE id = ?').get(l.item_id); if (it && Number(it.unit_cost) > 0) price = Number(it.unit_cost); }
    if (!price) throw new HttpError(400, `Indiquez un prix pour « ${l.description} » (champ prices, clé ${l.id}).`);
    lines.push({ itemId: l.item_id, description: l.description, unit: l.unit, quantity: Number(l.quantity), unitPrice: price });
  }
  const o = await db.transaction(async () => {
    // Double envoi : une demande ne devient qu'un seul bon de commande.
    if ((await P.lockRow('pur_requests', r.id)).status !== 'approved') throw new HttpError(400, 'Seule une demande approuvée peut devenir un bon de commande.');
    const x = await createDraftOrder(req, { supplier, lines, category: r.category, notes: `Demande ${r.number} : ${r.title}`, requestId: r.id, expectedDate: (b.expectedDate ? P.dateOrNull(b.expectedDate) : r.needed_date), projectId: r.project_id, branchId: r.branch_id });
    await setStatus(r, 'ordered', { order_id: x.id });
    return x;
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Bon de commande ${o.number} créé depuis la demande ${r.number}`);
  res.status(201).json({ orderId: o.id, number: o.number });
});

// ---------- Appels d'offres ----------
async function rfqOf(req, idv) {
  const r = await db.prepare('SELECT * FROM pur_rfqs WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!r) throw new HttpError(404, "Appel d'offres introuvable.");
  return r;
}
async function comparison(r) {
  const lines = await db.prepare('SELECT * FROM pur_rfq_lines WHERE rfq_id = ? ORDER BY position, id').all(r.id);
  const sups = await db.prepare('SELECT q.*, s.name FROM pur_rfq_suppliers q JOIN suppliers s ON s.id = q.supplier_id WHERE q.rfq_id = ? ORDER BY s.name').all(r.id);
  const prices = await db.prepare('SELECT * FROM pur_rfq_prices WHERE rfq_id = ?').all(r.id);
  const today = P.today();
  const suppliers = sups.map((q) => {
    const p = {}; for (const x of prices) if (Number(x.supplier_id) === Number(q.supplier_id)) p[Number(x.line_id)] = Number(x.unit_price);
    const complete = q.status === 'quoted' && lines.every((l) => p[Number(l.id)] !== undefined);
    return {
      supplierId: Number(q.supplier_id), name: q.name, status: q.status, prices: p,
      total: complete ? lines.reduce((s, l) => s + P.amount(l.quantity, p[Number(l.id)]), 0) : null,
      deliveryDays: q.delivery_days === null ? null : Number(q.delivery_days), paymentDays: q.payment_days === null ? null : Number(q.payment_days),
      terms: q.terms || null, validUntil: q.valid_until || null, note: q.note || null, expired: Boolean(q.valid_until && q.valid_until < today),
      complete, partialTotal: lines.reduce((s, l) => s + (p[Number(l.id)] !== undefined ? P.amount(l.quantity, p[Number(l.id)]) : 0), 0),
    };
  });
  const usable = suppliers.filter((s) => s.total !== null && !s.expired);
  const recommended = usable.length ? usable.reduce((a, b) => (b.total < a.total ? b : a)).supplierId : null;
  const timed = usable.filter((s) => s.deliveryDays !== null);
  const fastest = timed.length ? timed.reduce((a, b) => (b.deliveryDays < a.deliveryDays ? b : a)).supplierId : null;
  const withRef = lines.filter((l) => l.ref_price !== null);
  const referenceTotal = withRef.length === lines.length && lines.length ? lines.reduce((s, l) => s + P.amount(l.quantity, l.ref_price), 0) : null;
  // Économie : mesurée par rapport au budget de référence ; à défaut, par rapport à la moyenne des devis complets (au moins deux).
  const completeAll = suppliers.filter((s) => s.status === 'quoted' && s.complete);
  const averageTotal = completeAll.length >= 2 ? Math.round(completeAll.reduce((s, x) => s + x.total, 0) / completeAll.length) : null;
  const baseline = referenceTotal !== null ? referenceTotal : averageTotal;
  [...usable].sort((a, b) => a.total - b.total || (a.deliveryDays === null ? 1e9 : a.deliveryDays) - (b.deliveryDays === null ? 1e9 : b.deliveryDays)).forEach((s, i) => { s.rank = i + 1; });
  return {
    lines: lines.map((l) => {
      const quoted = suppliers.filter((s) => s.status === 'quoted' && s.prices[Number(l.id)] !== undefined);
      const min = quoted.length ? Math.min(...quoted.map((s) => s.prices[Number(l.id)])) : null;
      return { id: Number(l.id), itemId: l.item_id ? Number(l.item_id) : null, description: l.description, quantity: Number(l.quantity), unit: l.unit, refPrice: l.ref_price === null ? null : Number(l.ref_price), bestPrice: min, bestSuppliers: min === null ? [] : quoted.filter((s) => s.prices[Number(l.id)] === min).map((s) => s.supplierId) };
    }),
    suppliers, recommended, fastest, baseline, referenceTotal, averageTotal,
  };
}
router.get('/rfqs', mgr, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM pur_rfqs WHERE org_id = ? ORDER BY id DESC LIMIT 300').all(req.org.id);
  const out = [];
  for (const r of rows) {
    const s = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS q FROM pur_rfq_suppliers WHERE rfq_id = ?").get(r.id);
    out.push({ id: Number(r.id), number: r.number, title: r.title, quotesCount: Number(s.q) || 0, suppliersCount: Number(s.n) || 0, deadline: r.deadline || null, late: r.status === 'open' && Boolean(r.deadline && r.deadline < P.today()), status: r.status, savings: Number(r.savings) || 0 });
  }
  res.json({ savings: out.filter((r) => r.status === 'awarded').reduce((s, r) => s + r.savings, 0), rfqs: out });
});
router.post('/rfqs', mgr, async (req, res) => {
  const b = req.body || {};
  const title = A.text(b.title, 150, { required: true, msg: "Donnez un titre à l'appel d'offres." });
  const ids = [...new Set((Array.isArray(b.supplierIds) ? b.supplierIds : []).map((x) => A.id(x, 'Fournisseur invalide.')))];
  if (!ids.length) throw new HttpError(400, 'Choisissez au moins un fournisseur à consulter.');
  if (ids.length > 30) throw new HttpError(400, '30 fournisseurs au plus.');
  for (const id of ids) await supplierForOrder(req, id);
  const deadline = P.dateOrNull(b.deadline);
  if (deadline && deadline < P.today()) throw new HttpError(400, 'La date limite est déjà passée.');
  // Depuis une demande approuvée : ses lignes et sa catégorie sont reprises.
  let requestId = null; let lines; let cat = P.category(b.category);
  if (b.requestId !== undefined && b.requestId !== null && b.requestId !== '') {
    const rq = await db.prepare('SELECT * FROM pur_requests WHERE id = ? AND org_id = ?').get(A.id(b.requestId, 'Demande invalide.'), req.org.id);
    if (!rq) throw new HttpError(400, "Demande d'achat introuvable.");
    if (rq.status !== 'approved') throw new HttpError(400, "Seule une demande approuvée peut donner lieu à un appel d'offres.");
    requestId = Number(rq.id); cat = cat || rq.category;
    if (b.lines === undefined) lines = (await linesOfRequest(rq.id)).map((l) => ({ itemId: l.item_id ? Number(l.item_id) : null, description: l.description, unit: l.unit, quantity: Number(l.quantity), price: l.est_price === null ? null : Number(l.est_price) }));
  }
  if (!lines) lines = await P.readLines(req, b.lines, 'refPrice');
  const now = nowISO();
  const out = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'AO', now);
    const id = Number((await db.prepare("INSERT INTO pur_rfqs (org_id, number, title, deadline, category, notes, status, created_by, created_at, request_id) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)")
      .run(req.org.id, number, title, deadline, cat, cleanText(String(b.notes || ''), 2000), req.user.id, now, requestId)).lastInsertRowid);
    let pos = 0;
    for (const l of lines) await db.prepare('INSERT INTO pur_rfq_lines (rfq_id, item_id, description, unit, quantity, ref_price, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, l.itemId, l.description, l.unit, l.quantity, l.price, pos++);
    for (const s of ids) await db.prepare("INSERT INTO pur_rfq_suppliers (rfq_id, supplier_id, status) VALUES (?, ?, 'pending')").run(id, s);
    return { id, number };
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Appel d'offres ${out.number} lancé`);
  res.status(201).json(out);
});
router.get('/rfqs/:id', mgr, async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  const cnt = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS q FROM pur_rfq_suppliers WHERE rfq_id = ?").get(r.id);
  res.json({ rfq: {
    suppliersCount: Number(cnt.n) || 0, late: r.status === 'open' && Boolean(r.deadline && r.deadline < P.today()),
    id: Number(r.id), number: r.number, title: r.title, status: r.status, deadline: r.deadline || null, category: r.category || null, notes: r.notes || null,
    awardedTotal: r.awarded_total === null ? null : Number(r.awarded_total), savings: Number(r.savings) || 0, awardReason: r.award_reason || null,
    requestId: r.request_id ? Number(r.request_id) : null, quotesCount: Number(cnt.q) || 0,
    awardedSupplierId: r.awarded_supplier_id ? Number(r.awarded_supplier_id) : null, orderId: r.order_id ? Number(r.order_id) : null, cancelReason: r.cancel_reason || null,
    comparison: await comparison(r),
  } });
});
// Ajouter ou retirer un fournisseur consulté tant que l'appel d'offres est ouvert.
router.post('/rfqs/:id/suppliers', mgr, async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
  const sup = await supplierForOrder(req, (req.body || {}).supplierId);
  if (await db.prepare('SELECT 1 FROM pur_rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?').get(r.id, sup.id)) throw new HttpError(409, 'Ce fournisseur est déjà consulté.');
  if (Number((await db.prepare('SELECT COUNT(*) AS c FROM pur_rfq_suppliers WHERE rfq_id = ?').get(r.id)).c) >= 30) throw new HttpError(400, '30 fournisseurs au plus.');
  await db.prepare("INSERT INTO pur_rfq_suppliers (rfq_id, supplier_id, status) VALUES (?, ?, 'pending')").run(r.id, sup.id);
  res.status(201).json({ ok: true });
});
router.delete('/rfqs/:id/suppliers/:supplierId', mgr, async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
  const q = await db.prepare('SELECT * FROM pur_rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?').get(r.id, A.id(req.params.supplierId));
  if (!q) throw new HttpError(404, "Ce fournisseur n'est pas consulté dans cet appel d'offres.");
  if (q.status === 'quoted') throw new HttpError(400, 'Ce fournisseur a déjà remis un devis : marquez-le « décliné » plutôt que de le retirer.');
  if (Number((await db.prepare('SELECT COUNT(*) AS c FROM pur_rfq_suppliers WHERE rfq_id = ?').get(r.id)).c) <= 1) throw new HttpError(400, "Un appel d'offres garde au moins un fournisseur consulté.");
  await db.prepare('DELETE FROM pur_rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?').run(r.id, q.supplier_id);
  res.json({ ok: true });
});
router.put('/rfqs/:id/quotes/:supplierId', mgr, async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
  const sid = A.id(req.params.supplierId);
  const q = await db.prepare('SELECT * FROM pur_rfq_suppliers WHERE rfq_id = ? AND supplier_id = ?').get(r.id, sid);
  if (!q) throw new HttpError(404, "Ce fournisseur n'est pas consulté dans cet appel d'offres.");
  const b = req.body || {};
  const note = cleanText(String(b.note || ''), 500);
  if (b.declined) {
    await db.transaction(async () => {
      if ((await P.lockRow('pur_rfqs', r.id)).status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
      await db.prepare('DELETE FROM pur_rfq_prices WHERE rfq_id = ? AND supplier_id = ?').run(r.id, sid);
      await db.prepare("UPDATE pur_rfq_suppliers SET status = 'declined', note = ?, updated_at = ? WHERE rfq_id = ? AND supplier_id = ?").run(note, nowISO(), r.id, sid);
    })();
    return res.json({ ok: true, status: 'declined' });
  }
  const valid = new Set((await db.prepare('SELECT id FROM pur_rfq_lines WHERE rfq_id = ?').all(r.id)).map((l) => Number(l.id)));
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const days = (v, msg) => (v === undefined || v === null || v === '' ? null : (() => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 3650) throw new HttpError(400, msg); return n; })());
  const dd = days(b.deliveryDays, 'Délai de livraison invalide.'); const pd = days(b.paymentDays, 'Délai de paiement invalide.');
  const vu = P.dateOrNull(b.validUntil);
  if (!lines.length) throw new HttpError(400, 'Indiquez au moins un prix.');
  const seenLines = new Set();
  const prices = lines.map((l) => {
    const lid = A.id(l && l.rfqLineId);
    if (!valid.has(lid)) throw new HttpError(400, 'Ligne inconnue.');
    if (seenLines.has(lid)) throw new HttpError(400, 'Une ligne apparaît deux fois dans le devis.');
    seenLines.add(lid);
    const price = P.money(l.unitPrice, 'Prix invalide.');
    if (price <= 0) throw new HttpError(400, 'Prix invalide : indiquez un prix supérieur à zéro.');
    return [lid, price];
  });
  await db.transaction(async () => {
    if ((await P.lockRow('pur_rfqs', r.id)).status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
    await db.prepare('DELETE FROM pur_rfq_prices WHERE rfq_id = ? AND supplier_id = ?').run(r.id, sid);
    for (const [lid, p] of prices) await db.prepare('INSERT INTO pur_rfq_prices (rfq_id, supplier_id, line_id, unit_price) VALUES (?, ?, ?, ?)').run(r.id, sid, lid, p);
    await db.prepare("UPDATE pur_rfq_suppliers SET status = 'quoted', delivery_days = ?, payment_days = ?, terms = ?, valid_until = ?, note = ?, updated_at = ? WHERE rfq_id = ? AND supplier_id = ?")
      .run(dd, pd, cleanText(String(b.terms || ''), 500), vu, note, nowISO(), r.id, sid);
  })();
  res.json({ ok: true, status: 'quoted' });
});
router.post('/rfqs/:id/award', mgr, async (req, res) => {
  const r0 = await rfqOf(req, req.params.id);
  const b = req.body || {};
  const sid = A.id(b.supplierId, 'Choisissez le fournisseur.');
  const reason = cleanText(String(b.reason || ''), 500);
  // Sous verrou : un double envoi ne crée pas deux bons de commande, et les devis comparés sont ceux du moment de l'attribution.
  const { r, s, savings, o } = await db.transaction(async () => {
    const r = await P.lockRow('pur_rfqs', r0.id);
    if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
    const cmp = await comparison(r);
    const s = cmp.suppliers.find((x) => x.supplierId === sid);
    if (!s || s.total === null) throw new HttpError(400, "Le fournisseur n'a pas remis de devis.");
    if (s.expired) throw new HttpError(400, "Ce devis n'est plus valable (date de validité dépassée) : demandez au fournisseur de le renouveler.");
    if (sid !== cmp.recommended && !reason) throw new HttpError(400, "Indiquez le motif : pourquoi ne pas retenir l'offre la moins chère ?");
    const supplier = await supplierForOrder(req, sid);
    const savings = cmp.baseline !== null ? Math.max(0, cmp.baseline - s.total) : 0;
    const lines = cmp.lines.map((l) => ({ itemId: l.itemId, description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: s.prices[l.id] }));
    const rq = r.request_id ? await db.prepare('SELECT * FROM pur_requests WHERE id = ?').get(r.request_id) : null;
    const expected = s.deliveryDays !== null ? P.addDays(P.today(), s.deliveryDays) : (rq && rq.needed_date && rq.needed_date >= P.today() ? rq.needed_date : null);
    const o = await createDraftOrder(req, { supplier, lines, category: r.category, notes: `Appel d'offres ${r.number} : ${r.title}`, rfqId: r.id, requestId: rq ? rq.id : null, projectId: rq ? rq.project_id : null, branchId: rq ? rq.branch_id : null, paymentDays: s.paymentDays, expectedDate: expected });
    await db.prepare("UPDATE pur_rfqs SET status = 'awarded', awarded_supplier_id = ?, awarded_total = ?, baseline = ?, savings = ?, award_reason = ?, order_id = ?, awarded_at = ?, closed_at = ? WHERE id = ?").run(sid, s.total, cmp.baseline, savings, reason, o.id, nowISO(), nowISO(), r.id);
    // La demande d'origine passe à « commandée ».
    if (rq && rq.status === 'approved') await db.prepare("UPDATE pur_requests SET status = 'ordered', order_id = ?, updated_at = ? WHERE id = ?").run(o.id, nowISO(), rq.id);
    // Les prix obtenus deviennent les prix connus du fournisseur pour ces articles.
    for (const l of lines) if (l.itemId) await db.prepare('INSERT INTO supplier_prices (org_id, item_id, supplier_id, unit_price, lead_days) VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_id, supplier_id) DO UPDATE SET unit_price = excluded.unit_price, lead_days = COALESCE(excluded.lead_days, supplier_prices.lead_days)').run(req.org.id, l.itemId, sid, l.unitPrice, s.deliveryDays);
    return { r, s, savings, o };
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Appel d'offres ${r.number} attribué à ${s.name}`);
  res.json({ ok: true, savings, total: s.total, orderId: o.id, number: o.number });
});
router.post('/rfqs/:id/cancel', mgr, async (req, res) => {
  const r = await rfqOf(req, req.params.id);
  if (r.status !== 'open') throw new HttpError(400, "Cet appel d'offres est terminé.");
  const reason = cleanText(String((req.body || {}).reason || ''), 500);
  if (!reason) throw new HttpError(400, 'Indiquez le motif.');
  const c = await db.prepare("UPDATE pur_rfqs SET status = 'cancelled', cancel_reason = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(reason, nowISO(), r.id);
  if (!c.changes) throw new HttpError(400, "Cet appel d'offres est terminé.");
  res.json({ ok: true });
});

router.use('/', require('./purchasing-orders'));
router.use('/', require('./purchasing-invoices'));
router.use('/', require('./purchasing-suppliers'));
router.use('/', require('./purchasing-reports'));

module.exports = { router, supplierForOrder };
