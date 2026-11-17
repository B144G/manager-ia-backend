'use strict';
// Achats · réglages (tolérances, seuils d'approbation) et demandes d'achat : brouillon → soumise → approuvée / refusée (motif obligatoire) → commandée.
// Tout membre demande ; un responsable ou plus approuve selon le montant (seuils réglables par l'administrateur), jamais sa propre demande sauf administrateur.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const P = require('./pur-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const ST = ['draft', 'submitted', 'approved', 'rejected', 'cancelled', 'ordered'];
const nameOf = async (id) => (id ? ((await db.prepare('SELECT name FROM users WHERE id = ?').get(id)) || {}).name || '' : '');

// ---------- Réglages ----------
async function settingsView(orgId) { return { ...(await P.settings(orgId)), thresholds: await P.thresholds(orgId), roles: P.APPROVER_ROLES.map((r) => ({ role: r, label: A.ROLE_LABEL[r] })) }; }
router.get('/settings', async (req, res) => res.json(await settingsView(req.org.id)));
router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const cur = await P.settings(req.org.id);
  const next = {
    tolQtyPct: P.pct(b.tolQtyPct, cur.tolQtyPct, 100), tolPricePct: P.pct(b.tolPricePct, cur.tolPricePct, 100),
    tolAmount: b.tolAmount === undefined || b.tolAmount === '' ? cur.tolAmount : A.money0(b.tolAmount),
    budgetBlock: b.budgetBlock === undefined ? cur.budgetBlock : (b.budgetBlock === true || b.budgetBlock === 1 ? 1 : b.budgetBlock === false || b.budgetBlock === 0 ? 0 : (() => { throw new HttpError(400, 'Blocage du budget : oui ou non.'); })()),
    defaultTermsDays: P.days(b.defaultTermsDays, cur.defaultTermsDays, 'Délai de paiement'),
  };
  let rules = null;
  if (b.thresholds !== undefined) {
    if (!b.thresholds || typeof b.thresholds !== 'object') throw new HttpError(400, 'Seuils invalides.');
    rules = [];
    for (const kind of P.KINDS) {
      const list = b.thresholds[kind] === undefined ? null : b.thresholds[kind];
      if (list === null) continue;
      if (!Array.isArray(list) || list.length > 10) throw new HttpError(400, 'Dix seuils au plus par type de document.');
      const seen = new Set();
      for (const r of list) {
        const minAmount = A.amount(r && r.minAmount);
        const role = A.oneOf(r && r.role, P.APPROVER_ROLES, undefined, 'Rôle d\'approbation : responsable, administrateur ou propriétaire.');
        if (seen.has(minAmount)) throw new HttpError(400, 'Deux seuils ont le même montant.');
        seen.add(minAmount);
        rules.push({ kind, minAmount, role });
      }
      rules.push({ kind, clear: true });
    }
  }
  await db.transaction(async () => {
    await db.prepare(`INSERT INTO pur_settings (org_id, tol_qty_pct, tol_price_pct, tol_amount, budget_block, default_terms_days) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id) DO UPDATE SET tol_qty_pct = EXCLUDED.tol_qty_pct, tol_price_pct = EXCLUDED.tol_price_pct, tol_amount = EXCLUDED.tol_amount, budget_block = EXCLUDED.budget_block, default_terms_days = EXCLUDED.default_terms_days`)
      .run(req.org.id, next.tolQtyPct, next.tolPricePct, next.tolAmount, next.budgetBlock, next.defaultTermsDays);
    for (const kind of P.KINDS) {
      const mine = (rules || []).filter((r) => r.kind === kind && !r.clear);
      if (!(rules || []).some((r) => r.kind === kind && r.clear)) continue; // ce type n'est pas dans la demande : inchangé
      await db.prepare('DELETE FROM pur_thresholds WHERE org_id = ? AND kind = ?').run(req.org.id, kind);
      for (const r of mine) await db.prepare('INSERT INTO pur_thresholds (org_id, kind, min_amount, role) VALUES (?, ?, ?, ?)').run(req.org.id, kind, r.minAmount, r.role);
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', 'Réglages des achats modifiés (tolérances, seuils d\'approbation)');
  res.json(await settingsView(req.org.id));
});

// ---------- Demandes ----------
async function linesOf(id) {
  return (await db.prepare(`SELECT l.*, i.name AS item_name FROM pur_request_lines l LEFT JOIN stock_items i ON i.id = l.item_id WHERE l.request_id = ? ORDER BY l.id`).all(id))
    .map((l) => ({ id: Number(l.id), itemId: l.item_id === null ? null : Number(l.item_id), item: l.item_name || '', description: l.description, unit: l.unit, quantity: Number(l.quantity), estPrice: Number(l.est_price), amount: P.lineAmount(l.quantity, l.est_price) }));
}
async function view(req, r, withLines) {
  const pr = r.project_id ? await db.prepare('SELECT name FROM projects WHERE id = ?').get(r.project_id) : null;
  const br = r.branch_id ? await db.prepare('SELECT name FROM branches WHERE id = ?').get(r.branch_id) : null;
  const out = {
    id: Number(r.id), number: r.number, title: r.title, justification: r.justification, neededDate: r.needed_date, category: r.category, branchId: r.branch_id === null ? null : Number(r.branch_id), branch: br ? br.name : '',
    projectId: r.project_id === null ? null : Number(r.project_id), project: pr ? pr.name : '', status: r.status, total: Number(r.total), requiredRole: r.required_role, requiredRoleLabel: A.ROLE_LABEL[r.required_role],
    requestedBy: Number(r.requested_by), requester: await nameOf(r.requested_by), decidedBy: r.decided_by === null ? null : Number(r.decided_by), decider: await nameOf(r.decided_by), decidedAt: r.decided_at, rejectReason: r.reject_reason,
    submittedAt: r.submitted_at, createdAt: r.created_at, mine: Number(r.requested_by) === Number(req.user.id),
  };
  out.canApprove = r.status === 'submitted' && !P.approvalError(req, r.required_role, r.requested_by);
  if (withLines) {
    out.lines = await linesOf(r.id);
    out.budget = r.category ? await P.budgetStatus(req.org.id, r.category, (r.needed_date || P.today()).slice(0, 4), r.status === 'submitted' || r.status === 'draft' ? Number(r.total) : 0) : null;
  }
  return out;
}
async function requestOf(req, id) {
  const r = await db.prepare('SELECT * FROM pur_requests WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  const sc = A.scope(req);
  const seen = r && (Number(r.requested_by) === Number(req.user.id) || (A.can(req, 'manager') && (sc.args.length === 0 || !r.branch_id || r.branch_id === sc.args[0])));
  if (!seen) throw new HttpError(404, "Demande d'achat introuvable.");
  return r;
}

router.get('/requests', async (req, res) => {
  const w = ['org_id = ?']; const a = [req.org.id];
  if (req.query.status) { w.push('status = ?'); a.push(A.oneOf(req.query.status, ST, undefined, 'Statut inconnu.')); }
  const own = req.query.mine === '1' || !A.can(req, 'manager');
  if (own) { w.push('requested_by = ?'); a.push(req.user.id); } else { const sc = A.scope(req); if (sc.sql) { w.push(`(requested_by = ? OR branch_id IS NULL OR branch_id = ?)`); a.push(req.user.id, sc.args[0]); } }
  const rows = await db.prepare(`SELECT * FROM pur_requests WHERE ${w.join(' AND ')} ORDER BY CASE status WHEN 'submitted' THEN 0 WHEN 'draft' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, id DESC LIMIT 200`).all(...a);
  const requests = []; for (const r of rows) requests.push(await view(req, r, false));
  res.json({ requests, counts: Object.fromEntries(ST.map((s) => [s, requests.filter((x) => x.status === s).length])) });
});

async function fieldsOf(req, b, cur) {
  const has = (k) => b[k] !== undefined;
  const title = has('title') || !cur ? A.text(b.title, 150, { required: true, msg: 'Donnez un titre à la demande (ex. Fournitures de bureau).' }) : cur.title;
  const needed = has('neededDate') ? A.date(b.neededDate) : cur ? cur.needed_date : null;
  if (needed && needed < P.today() && !cur) throw new HttpError(400, 'La date souhaitée est déjà passée.');
  return {
    title, justification: has('justification') ? A.text(b.justification, 1000) : cur ? cur.justification : '', needed,
    category: has('category') ? P.catOf(b.category) : cur ? cur.category : '',
    branchId: has('branchId') ? await A.branchOf(req, b.branchId) : cur ? cur.branch_id : null,
    projectId: has('projectId') ? await P.projectOf(req, b.projectId) : cur ? cur.project_id : null,
  };
}
async function writeLines(req, id, lines) {
  await db.prepare('DELETE FROM pur_request_lines WHERE request_id = ?').run(id);
  for (const l of lines) await db.prepare('INSERT INTO pur_request_lines (org_id, request_id, item_id, description, unit, quantity, est_price) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, l.itemId, l.description, l.unit, l.quantity, l.price);
}
const sumLines = (lines) => lines.reduce((s, l) => s + P.lineAmount(l.quantity, l.price), 0);

async function submit(req, r) {
  const total = Number(r.total);
  const role = await P.requiredRole(req.org.id, 'request', total);
  await db.prepare("UPDATE pur_requests SET status = 'submitted', submitted_at = ?, updated_at = ?, required_role = ?, reject_reason = '' WHERE id = ?").run(nowISO(), nowISO(), role, r.id);
  await W.pushRole(req.org.id, role, 'purchasing', `Demande d'achat ${r.number} « ${r.title} » (${total.toLocaleString('fr-FR')} FCFA) à approuver.`, `pur-req:${r.id}`);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number} soumise`);
}

router.post('/requests', async (req, res) => {
  const b = req.body || {};
  const f = await fieldsOf(req, b, null);
  const lines = await P.cleanLines(req, b.lines, 'est');
  const total = sumLines(lines);
  const id = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'request', 'DA', P.today());
    const now = nowISO();
    const rid = Number((await db.prepare(`INSERT INTO pur_requests (org_id, number, title, justification, needed_date, category, branch_id, project_id, status, total, required_role, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 'manager', ?, ?, ?)`).run(req.org.id, number, f.title, f.justification, f.needed, f.category, f.branchId, f.projectId, total, req.user.id, now, now)).lastInsertRowid);
    await writeLines(req, rid, lines);
    return rid;
  })();
  let r = await db.prepare('SELECT * FROM pur_requests WHERE id = ?').get(id);
  if (b.submit === true) { await submit(req, r); r = await db.prepare('SELECT * FROM pur_requests WHERE id = ?').get(id); } else await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number} créée`);
  res.status(201).json({ id, number: r.number, status: r.status });
});

router.get('/requests/:id', async (req, res) => res.json({ request: await view(req, await requestOf(req, req.params.id), true) }));

const mineOrAdmin = (req, r) => { if (Number(r.requested_by) !== Number(req.user.id) && !A.can(req, 'admin')) throw new HttpError(403, "Seul l'auteur de la demande (ou un administrateur) peut faire cela."); };

router.put('/requests/:id', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  mineOrAdmin(req, r);
  if (r.status !== 'draft') throw new HttpError(400, 'Seul un brouillon se modifie. Retirez la demande de la validation pour la corriger.');
  const b = req.body || {};
  const f = await fieldsOf(req, b, r);
  const lines = b.lines === undefined ? null : await P.cleanLines(req, b.lines, 'est');
  await db.transaction(async () => {
    const total = lines ? sumLines(lines) : Number(r.total);
    await db.prepare('UPDATE pur_requests SET title = ?, justification = ?, needed_date = ?, category = ?, branch_id = ?, project_id = ?, total = ?, updated_at = ? WHERE id = ?').run(f.title, f.justification, f.needed, f.category, f.branchId, f.projectId, total, nowISO(), r.id);
    if (lines) await writeLines(req, r.id, lines);
  })();
  if (b.submit === true) await submit(req, await db.prepare('SELECT * FROM pur_requests WHERE id = ?').get(r.id));
  res.json({ ok: true });
});

router.post('/requests/:id/submit', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  mineOrAdmin(req, r);
  if (r.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être soumis.');
  if (!(await db.prepare('SELECT 1 FROM pur_request_lines WHERE request_id = ?').get(r.id))) throw new HttpError(400, 'La demande n\'a aucune ligne.');
  await submit(req, r);
  res.json({ ok: true });
});
router.post('/requests/:id/withdraw', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  mineOrAdmin(req, r);
  if (r.status !== 'submitted') throw new HttpError(400, "Seule une demande soumise peut être retirée de l'approbation.");
  await db.prepare("UPDATE pur_requests SET status = 'draft', updated_at = ? WHERE id = ?").run(nowISO(), r.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number} retirée de l'approbation`);
  res.json({ ok: true });
});

router.post('/requests/:id/approve', A.need('manager'), async (req, res) => {
  const r = await requestOf(req, req.params.id);
  if (r.status !== 'submitted') throw new HttpError(400, 'Cette demande n\'est pas en attente de décision.');
  const err = P.approvalError(req, r.required_role, r.requested_by);
  if (err) throw new HttpError(403, err);
  const budget = r.category ? await P.budgetGuard(req, r.category, r.needed_date || P.today(), Number(r.total), 0, (req.body || {}).overrideBudget === true) : null;
  const upd = await db.prepare("UPDATE pur_requests SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'submitted'").run(req.user.id, nowISO(), nowISO(), r.id);
  if (!upd.changes) throw new HttpError(409, 'Cette demande vient de changer : rechargez la page.');
  await W.push(req.org.id, r.requested_by, 'purchasing', `Votre demande d'achat ${r.number} « ${r.title} » est approuvée.`, `pur-req:${r.id}`);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number} approuvée`);
  res.json({ ok: true, budgetWarning: budget && budget.over ? budget : null });
});
router.post('/requests/:id/reject', A.need('manager'), async (req, res) => {
  const r = await requestOf(req, req.params.id);
  const reason = A.text((req.body || {}).reason, 300, { required: true, msg: 'Indiquez le motif du refus.' });
  if (r.status !== 'submitted') throw new HttpError(400, 'Cette demande n\'est pas en attente de décision.');
  const err = P.approvalError(req, r.required_role, r.requested_by);
  if (err) throw new HttpError(403, err);
  await db.prepare("UPDATE pur_requests SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'submitted'").run(reason, req.user.id, nowISO(), nowISO(), r.id);
  await W.push(req.org.id, r.requested_by, 'purchasing', `Votre demande d'achat ${r.number} est refusée : ${reason}`, `pur-req:${r.id}`);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number} refusée`);
  res.json({ ok: true });
});
router.post('/requests/:id/cancel', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  mineOrAdmin(req, r);
  if (!['draft', 'submitted', 'approved'].includes(r.status)) throw new HttpError(400, 'Cette demande ne peut plus être annulée.');
  await db.prepare("UPDATE pur_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowISO(), r.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number} annulée`);
  res.json({ ok: true });
});
router.post('/requests/:id/duplicate', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  const id = await db.transaction(async () => {
    const now = nowISO();
    const number = await P.nextNumber(req.org.id, 'request', 'DA', P.today());
    const nid = Number((await db.prepare(`INSERT INTO pur_requests (org_id, number, title, justification, needed_date, category, branch_id, project_id, status, total, required_role, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'draft', ?, 'manager', ?, ?, ?)`).run(req.org.id, number, `${r.title} (copie)`.slice(0, 150), r.justification, r.category, r.branch_id, r.project_id, r.total, req.user.id, now, now)).lastInsertRowid);
    await db.prepare('INSERT INTO pur_request_lines (org_id, request_id, item_id, description, unit, quantity, est_price) SELECT org_id, ?, item_id, description, unit, quantity, est_price FROM pur_request_lines WHERE request_id = ?').run(nid, r.id);
    return nid;
  })();
  res.status(201).json({ id });
});
router.delete('/requests/:id', async (req, res) => {
  const r = await requestOf(req, req.params.id);
  mineOrAdmin(req, r);
  if (r.status !== 'draft') throw new HttpError(400, 'Seul un brouillon se supprime ; annulez les autres demandes.');
  await db.prepare('DELETE FROM pur_requests WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

// Demande approuvée → bon de commande en brouillon (prix : ceux de la demande, sinon le prix connu du fournisseur, sinon à préciser dans `prices`).
router.post('/requests/:id/to-order', A.need('manager'), async (req, res) => {
  const r = await requestOf(req, req.params.id);
  if (r.status !== 'approved') throw new HttpError(400, 'Seule une demande approuvée peut devenir un bon de commande.');
  const b = req.body || {};
  const sup = await P.supplierOf(req, b.supplierId);
  const prices = b.prices && typeof b.prices === 'object' ? b.prices : {};
  const lines = [];
  for (const l of await db.prepare('SELECT * FROM pur_request_lines WHERE request_id = ? ORDER BY id').all(r.id)) {
    let price = prices[l.id] !== undefined ? A.amount(prices[l.id]) : Number(l.est_price);
    if (!price && l.item_id) { const sp = await db.prepare('SELECT unit_price FROM supplier_prices WHERE item_id = ? AND supplier_id = ?').get(l.item_id, sup.id); price = sp ? Number(sp.unit_price) : 0; }
    if (!price) throw new HttpError(400, `Indiquez un prix pour « ${l.description} » (champ prices, clé ${l.id}).`);
    lines.push({ itemId: l.item_id === null ? null : Number(l.item_id), description: l.description, unit: l.unit, quantity: Number(l.quantity), price });
  }
  const id = await require('./pur-orders').createOrder(req, { supplier: sup, requestId: r.id, orderDate: P.today(), expectedDate: A.date(b.expectedDate) || r.needed_date, paymentDays: b.paymentDays, vatRate: b.vatRate, category: r.category, branchId: r.branch_id, projectId: r.project_id, notes: r.title, lines });
  await db.prepare("UPDATE pur_requests SET status = 'ordered', updated_at = ? WHERE id = ?").run(nowISO(), r.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Demande d'achat ${r.number} transformée en bon de commande`);
  res.status(201).json({ orderId: id });
});

module.exports = router;
module.exports.linesOf = linesOf;
