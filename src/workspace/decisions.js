'use strict';
// Demandes de validation : une personne soumet, un circuit de validation à un ou plusieurs niveaux décide selon des seuils de montant
// (vague 3 : seuils réglables, délégation, rappels, notification du demandeur, lien vers un achat, une dépense ou un projet).
// Sans seuil configuré, le fonctionnement reste celui d'avant : un responsable valide.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const wh = require('../services/webhooks');
const { HttpError, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const LEVELS = ['manager', 'admin', 'owner'];
const LEVEL_LABEL = { manager: 'Responsable', admin: 'Administrateur', owner: 'Propriétaire' };
const LINKS = { purchase: ['purchase_orders', 'Achat'], expense: ['expense_requests', 'Dépense'], project: ['projects', 'Projet'] };

const view = (d, steps) => ({ id: d.id, title: d.title, detail: d.detail, amount: d.amount, status: d.status, requestedBy: d.requested_by, requester: d.requester || null, note: d.note, createdAt: d.created_at, decidedAt: d.decided_at,
  link: d.link_kind ? { kind: d.link_kind, id: d.link_id, label: (LINKS[d.link_kind] || [])[1] || d.link_kind } : null,
  steps: (steps || []).map((s) => ({ id: s.id, role: s.role, roleLabel: LEVEL_LABEL[s.role], status: s.status, decidedBy: s.who || null, decidedAt: s.decided_at, note: s.note })),
  currentRole: d.status === 'pending' ? (((steps || []).find((s) => s.status === 'pending')) || {}).role || 'manager' : null });

async function stepsOf(ids) {
  if (!ids.length) return new Map();
  const rows = await db.prepare(`SELECT s.*, u.name AS who FROM decision_steps s LEFT JOIN users u ON u.id = s.decided_by WHERE s.decision_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.step_no`).all(...ids);
  const m = new Map();
  for (const r of rows) { if (!m.has(Number(r.decision_id))) m.set(Number(r.decision_id), []); m.get(Number(r.decision_id)).push(r); }
  return m;
}
async function pending(req, limit = 20) {
  const own = A.can(req, 'manager') ? '' : ' AND d.requested_by = ?';
  const args = A.can(req, 'manager') ? [req.org.id] : [req.org.id, req.user.id];
  const rows = await db.prepare(`SELECT d.*, u.name AS requester FROM decisions d LEFT JOIN users u ON u.id = d.requested_by WHERE d.org_id = ? AND d.status = 'pending'${own} ORDER BY d.id DESC LIMIT ${limit}`).all(...args);
  const st = await stepsOf(rows.map((r) => Number(r.id)));
  return rows.map((d) => view(d, st.get(Number(d.id))));
}

/** Rang effectif d'une personne : son rôle, ou celui de la personne qui lui a délégué (délégation en cours). */
async function effectiveRank(req) {
  let rank = A.RANK[req.member.role];
  for (const d of await db.prepare('SELECT * FROM decision_delegations WHERE org_id = ? AND to_user = ? AND until_date >= ?').all(req.org.id, req.user.id, W.today())) {
    const m = await db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, d.from_user);
    if (m) rank = Math.max(rank, A.RANK[m.role]);
  }
  return rank;
}
/** Niveaux du circuit pour un montant : un niveau par rôle dont le seuil est atteint, du plus bas au plus haut. */
async function circuitFor(orgId, amount) {
  if (!amount) return [];
  const rules = await db.prepare('SELECT * FROM decision_rules WHERE org_id = ? AND min_amount <= ?').all(orgId, amount);
  return [...new Set(rules.map((r) => r.role))].sort((a, b) => A.RANK[a] - A.RANK[b]);
}

router.get('/', async (req, res) => {
  if (req.query.status !== 'all') return res.json({ decisions: await pending(req, 50) });
  const rows = (await db.prepare('SELECT d.*, u.name AS requester FROM decisions d LEFT JOIN users u ON u.id = d.requested_by WHERE d.org_id = ? ORDER BY d.id DESC LIMIT 50').all(req.org.id))
    .filter((d) => A.can(req, 'manager') || d.requested_by === req.user.id);
  const st = await stepsOf(rows.map((r) => Number(r.id)));
  res.json({ decisions: rows.map((d) => view(d, st.get(Number(d.id)))) });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const title = A.text(b.title, 120, { required: true, msg: 'Indiquez ce que vous soumettez à validation.' });
  const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : A.amount(b.amount);
  let linkKind = ''; let linkId = null;
  if (b.linkKind) {
    const L = LINKS[b.linkKind];
    if (!L) throw new HttpError(400, 'Lien inconnu (purchase, expense ou project).');
    linkId = A.id(b.linkId);
    if (!await db.prepare(`SELECT 1 FROM ${L[0]} WHERE id = ? AND org_id = ?`).get(linkId, req.org.id)) throw new HttpError(404, `${L[1]} introuvable.`);
    linkKind = b.linkKind;
  }
  const levels = await circuitFor(req.org.id, amount);
  const id = await db.transaction(async () => {
    const did = Number((await db.prepare('INSERT INTO decisions (org_id, title, detail, amount, requested_by, link_kind, link_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, title, A.text(b.detail, 600), amount, req.user.id, linkKind, linkId, nowISO())).lastInsertRowid);
    let n = 1;
    for (const role of levels) await db.prepare('INSERT INTO decision_steps (decision_id, org_id, step_no, role) VALUES (?, ?, ?, ?)').run(did, req.org.id, n++, role);
    return did;
  })();
  await A.logActivity(req.org.id, req.user.id, 'dashboard', `Demande de validation : ${title}`);
  await W.pushRole(req.org.id, levels[0] || 'manager', 'decision', `Décision à valider : ${title}${amount ? ` (${amount.toLocaleString('fr-FR')} ${req.org.currency})` : ''}`, 'decision:' + id);
  wh.emit(req.org.id, 'decision.created', { id, title, amount });
  res.status(201).json({ id, levels });
});

// ---------- Seuils du circuit ----------
router.get('/rules', A.need('manager'), async (req, res) => {
  res.json({ rules: (await db.prepare('SELECT min_amount, role FROM decision_rules WHERE org_id = ? ORDER BY min_amount, role').all(req.org.id)).map((r) => ({ minAmount: Number(r.min_amount), role: r.role, roleLabel: LEVEL_LABEL[r.role] })),
    note: "Chaque seuil atteint ajoute un niveau de validation. Exemple : 0 → Responsable, 500 000 → Administrateur, 2 000 000 → Propriétaire. Sans seuil, un responsable suffit." });
});
router.put('/rules', A.need('admin'), async (req, res) => {
  const list = (req.body || {}).rules;
  if (!Array.isArray(list) || list.length > 10) throw new HttpError(400, 'Liste de seuils invalide (10 au plus).');
  const rows = list.map((r) => ({ min: r && r.minAmount === 0 ? 0 : A.amount(r && r.minAmount), role: A.oneOf(r && r.role, LEVELS, undefined, 'Niveau inconnu (manager, admin ou owner).') }));
  const before = await db.prepare('SELECT min_amount, role FROM decision_rules WHERE org_id = ?').all(req.org.id);
  await db.transaction(async () => {
    await db.prepare('DELETE FROM decision_rules WHERE org_id = ?').run(req.org.id);
    for (const r of rows) await db.prepare('INSERT INTO decision_rules (org_id, min_amount, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(req.org.id, r.min, r.role);
  })();
  await W.audit(req, 'decision_rules', null, 'update', { rules: before }, { rules: rows });
  res.json({ ok: true, rules: rows.length });
});

router.put('/:id', async (req, res) => {
  const d = await db.prepare('SELECT * FROM decisions WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Demande introuvable.');
  if (d.status !== 'pending') throw new HttpError(409, 'Cette demande a déjà été traitée.');
  const rank = await effectiveRank(req);
  if (rank < A.RANK.manager) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  if (d.requested_by === req.user.id && !A.can(req, 'admin')) throw new HttpError(403, 'Vous ne pouvez pas valider votre propre demande.');
  const status = A.oneOf((req.body || {}).status, ['approved', 'rejected'], undefined, 'Choisissez valider ou refuser.');
  const note = A.text((req.body || {}).note, 200);
  const steps = await db.prepare('SELECT * FROM decision_steps WHERE decision_id = ? ORDER BY step_no').all(d.id);
  const cur = steps.find((s) => s.status === 'pending');
  if (cur && rank < A.RANK[cur.role]) throw new HttpError(403, `Cette demande est au niveau « ${LEVEL_LABEL[cur.role]} » : votre rôle (ou votre délégation) ne suffit pas.`);
  let final = status; let nextRole = null;
  await db.transaction(async () => {
    if (cur) {
      await db.prepare('UPDATE decision_steps SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?').run(status, req.user.id, nowISO(), note, cur.id);
      const rest = steps.filter((s) => s.status === 'pending' && s.id !== cur.id);
      if (status === 'approved' && rest.length) { final = 'pending'; nextRole = rest[0].role; }
      else if (status === 'rejected') await db.prepare("UPDATE decision_steps SET status = 'skipped' WHERE decision_id = ? AND status = 'pending'").run(d.id);
    }
    if (final !== 'pending') await db.prepare('UPDATE decisions SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?').run(final, req.user.id, note, nowISO(), d.id);
  })();
  await W.audit(req, 'decision', d.id, final === 'pending' ? 'level_approved' : 'decision', { status: d.status }, { status: final, note });
  if (final === 'pending') {
    await W.pushRole(req.org.id, nextRole, 'decision', `Décision à valider (niveau suivant) : ${d.title}`, 'decision:' + d.id);
    await W.push(req.org.id, d.requested_by, 'decision', `Votre demande « ${oneLine(d.title, 60)} » a passé un niveau de validation.`, 'decision:' + d.id);
  } else {
    await A.logActivity(req.org.id, req.user.id, 'dashboard', `${final === 'approved' ? 'Décision validée' : 'Décision refusée'} : ${d.title}`);
    await W.push(req.org.id, d.requested_by, 'decision', `Votre demande « ${oneLine(d.title, 60)} » est ${final === 'approved' ? 'validée' : 'refusée'}${note ? ` : ${note}` : '.'}`, 'decision:' + d.id);
    wh.emit(req.org.id, 'decision.decided', { id: d.id, title: d.title, status: final });
  }
  res.json({ ok: true, status: final });
});

// ---------- Délégation ----------
router.get('/delegations', A.need('manager'), async (req, res) => {
  const rows = await db.prepare('SELECT d.*, f.name AS from_name, t.name AS to_name FROM decision_delegations d JOIN users f ON f.id = d.from_user JOIN users t ON t.id = d.to_user WHERE d.org_id = ? AND d.until_date >= ? ORDER BY d.id DESC').all(req.org.id, W.today());
  res.json({ delegations: rows.map((d) => ({ id: d.id, fromUserId: d.from_user, from: d.from_name, toUserId: d.to_user, to: d.to_name, until: d.until_date })) });
});
router.post('/delegations', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const to = await A.memberOf(req, b.toUserId);
  if (!to || to === req.user.id) throw new HttpError(400, 'Choisissez une autre personne de l\'équipe.');
  const until = A.date(b.until);
  if (!until || until < W.today() || until > W.addDays(W.today(), 90)) throw new HttpError(400, "Indiquez une date de fin d'ici 90 jours.");
  const id = Number((await db.prepare('INSERT INTO decision_delegations (org_id, from_user, to_user, until_date, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, req.user.id, to, until, nowISO())).lastInsertRowid);
  await W.audit(req, 'delegation', id, 'create', null, { to, until });
  await W.push(req.org.id, to, 'decision', `${req.user.name} vous délègue ses validations jusqu'au ${until}.`, 'delegation:' + id);
  res.status(201).json({ id });
});
router.delete('/delegations/:id', A.need('manager'), async (req, res) => {
  const d = await db.prepare('SELECT * FROM decision_delegations WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Délégation introuvable.');
  if (d.from_user !== req.user.id && !A.can(req, 'admin')) throw new HttpError(403, 'Seul son auteur ou un administrateur peut la retirer.');
  await db.prepare('DELETE FROM decision_delegations WHERE id = ?').run(d.id);
  await W.audit(req, 'delegation', d.id, 'delete', { to: d.to_user, until: d.until_date }, null);
  res.json({ ok: true });
});

// ---------- Rappels ----------
async function remindOne(orgId, d) {
  const cur = await db.prepare("SELECT role FROM decision_steps WHERE decision_id = ? AND status = 'pending' ORDER BY step_no LIMIT 1").get(d.id);
  await W.pushRole(orgId, (cur && cur.role) || 'manager', 'decision', `Rappel : « ${oneLine(d.title, 70)} » attend votre validation depuis le ${d.created_at.slice(0, 10)}.`, 'decision:' + d.id);
  await db.prepare('UPDATE decisions SET reminded_at = ? WHERE id = ?').run(nowISO(), d.id);
}
router.post('/:id/remind', A.need('manager'), async (req, res) => {
  const d = await db.prepare("SELECT * FROM decisions WHERE id = ? AND org_id = ? AND status = 'pending'").get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Demande en attente introuvable.');
  await remindOne(req.org.id, d);
  res.json({ ok: true });
});
/** Rappel automatique (appelé chaque heure) : décisions en attente depuis plus de 48 h, au plus un rappel par 24 h. Renvoie le nombre de rappels. */
async function remindAll() {
  const old = new Date(Date.now() - 48 * 3600000).toISOString(); const recent = new Date(Date.now() - 24 * 3600000).toISOString();
  const rows = await db.prepare("SELECT * FROM decisions WHERE status = 'pending' AND created_at < ? AND (reminded_at IS NULL OR reminded_at < ?) LIMIT 200").all(old, recent);
  for (const d of rows) await remindOne(d.org_id, d);
  return rows.length;
}

module.exports = router;
module.exports.pending = pending;
module.exports.remindAll = remindAll;
module.exports.circuitFor = circuitFor;
