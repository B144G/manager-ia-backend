'use strict';
// Sous-application « Qualité, hygiène, sécurité, environnement » : incidents, accidents du travail, inspections, non-conformités, réserves, réceptions techniques.
// Droits : tout le monde déclare ; les responsables assignent, suivent et clôturent. Séparation des tâches : celui qui a déclaré ne clôture JAMAIS sa propre fiche ;
// une réception technique ne se clôture qu'une fois la demande de validation (circuit « Réception technique ») approuvée.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const KINDS = ['incident', 'accident', 'inspection', 'nonconformity', 'snag', 'reception'];
const SEVERITIES = ['low', 'normal', 'high', 'critical'];
const STATUSES = ['open', 'in_progress', 'closed'];
const PREFIX = { incident: 'INC', accident: 'ACC', inspection: 'INS', nonconformity: 'NC', snag: 'RES', reception: 'REC' };

const view = (r, names) => ({
  id: Number(r.id), kind: r.kind, ref: r.ref, title: r.title, detail: r.detail, place: r.place, siteId: r.site_id ? Number(r.site_id) : null, affaireId: r.affaire_id ? Number(r.affaire_id) : null,
  auditId: r.audit_id ? Number(r.audit_id) : null, severity: r.severity, status: r.status, declaredBy: r.declared_by ? Number(r.declared_by) : null, declaredByName: names[r.declared_by] || '',
  assigneeId: r.assignee_id ? Number(r.assignee_id) : null, assigneeName: names[r.assignee_id] || '', dueDate: r.due_date, corrective: r.corrective, persons: Number(r.persons), daysLost: Number(r.days_lost),
  requestId: r.request_id ? Number(r.request_id) : null, closedAt: r.closed_at, createdAt: r.created_at,
});
const namesOf = async (orgId) => { const rows = await db.prepare('SELECT u.id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?').all(orgId); const o = {}; for (const r of rows) o[r.id] = r.name; return o; };
const itemOf = async (req, id) => {
  const r = await db.prepare('SELECT * FROM qhse_items WHERE id = ? AND org_id = ?').get(A.id(id, 'Fiche invalide.'), req.org.id);
  if (!r) throw new HttpError(404, 'Fiche introuvable.');
  return r;
};
const mgr = (req) => A.can(req, 'manager');
const openOf = (r) => r.status !== 'closed';

/** Chiffres réels pour les indicateurs de direction (aussi utilisés par ent-kpi). */
async function stats(orgId) {
  const one = async (sql, ...a) => Number((await db.prepare(sql).get(orgId, ...a)).c);
  const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const q90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  return {
    total: await one('SELECT COUNT(*) c FROM qhse_items WHERE org_id = ?'),
    openIncidents: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND kind IN ('incident', 'accident') AND status <> 'closed'"),
    accidents: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND kind = 'accident' AND substr(created_at, 1, 10) >= ?", since),
    daysLost: await one("SELECT COALESCE(SUM(days_lost), 0) c FROM qhse_items WHERE org_id = ? AND kind = 'accident' AND substr(created_at, 1, 10) >= ?", since),
    openSnags: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND kind = 'snag' AND status <> 'closed'"),
    openNc: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND kind = 'nonconformity' AND status <> 'closed'"),
    ncRecent: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND kind = 'nonconformity' AND substr(created_at, 1, 10) >= ?", q90),
    controls: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND kind IN ('inspection', 'reception') AND substr(created_at, 1, 10) >= ?", q90),
    receptionsClosed: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND kind = 'reception' AND status = 'closed'"),
    receptionsAll: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND kind = 'reception'"),
    late: await one("SELECT COUNT(*) c FROM qhse_items WHERE org_id = ? AND status <> 'closed' AND due_date IS NOT NULL AND due_date <> '' AND due_date < ?", nowISO().slice(0, 10)),
  };
}

router.get('/', async (req, res) => {
  const kind = req.query.kind ? A.oneOf(req.query.kind, KINDS, undefined, 'Type inconnu.') : null;
  const rows = await db.prepare(`SELECT * FROM qhse_items WHERE org_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY (status = 'closed'), id DESC LIMIT 300`).all(...(kind ? [req.org.id, kind] : [req.org.id]));
  const names = await namesOf(req.org.id);
  res.json({ items: rows.map((r) => view(r, names)), stats: await stats(req.org.id), canManage: mgr(req), kinds: KINDS });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, KINDS, undefined, 'Type de fiche inconnu.');
  const title = A.text(b.title, 160, { required: true, msg: 'Indiquez un titre.' });
  const t = nowISO();
  const ins = { id: Number((await db.prepare(`INSERT INTO qhse_items (org_id, kind, title, detail, place, site_id, affaire_id, audit_id, severity, status, declared_by, assignee_id, due_date, persons, days_lost, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?) `).run(req.org.id, kind, title, A.text(b.detail, 2000), A.text(b.place, 120), A.idOrNull(b.siteId), A.idOrNull(b.affaireId),
    mgr(req) ? A.idOrNull(b.auditId) : null, A.oneOf(b.severity, SEVERITIES, 'normal', 'Gravité inconnue.'), req.user.id, mgr(req) ? A.idOrNull(b.assigneeId) : null, A.date(b.dueDate) || null,
    kind === 'accident' ? Math.min(999, Math.max(0, Math.floor(Number(b.persons) || 0))) : 0, kind === 'accident' ? Math.min(9999, Math.max(0, Math.floor(Number(b.daysLost) || 0))) : 0, t, t)).lastInsertRowid) };
  const ref = `${PREFIX[kind]}-${String(ins.id).padStart(4, '0')}`;
  await db.prepare('UPDATE qhse_items SET ref = ? WHERE id = ?').run(ref, ins.id);
  await A.logActivity(req.org.id, req.user.id, 'qhse', `${ref} déclaré : ${title}`);
  res.status(201).json({ id: Number(ins.id), ref });
});

router.put('/:id', async (req, res) => {
  const r = await itemOf(req, req.params.id);
  const b = req.body || {};
  const isAssignee = r.assignee_id && Number(r.assignee_id) === req.user.id;
  if (!mgr(req) && !isAssignee) throw new HttpError(403, "Seuls les responsables et la personne assignée peuvent modifier cette fiche.");
  if (r.status === 'closed') throw new HttpError(409, 'Cette fiche est clôturée.');
  const has = (k) => b[k] !== undefined;
  const status = has('status') ? A.oneOf(b.status, ['open', 'in_progress'], undefined, 'Statut inconnu (la clôture a sa propre action).') : r.status;
  await db.prepare('UPDATE qhse_items SET corrective = ?, status = ?, assignee_id = ?, due_date = ?, severity = ?, updated_at = ? WHERE id = ?').run(
    has('corrective') ? A.text(b.corrective, 2000) : r.corrective, status,
    mgr(req) && has('assigneeId') ? A.idOrNull(b.assigneeId) : r.assignee_id, mgr(req) && has('dueDate') ? (A.date(b.dueDate) || null) : r.due_date,
    mgr(req) && has('severity') ? A.oneOf(b.severity, SEVERITIES, undefined, 'Gravité inconnue.') : r.severity, nowISO(), r.id);
  res.json({ ok: true });
});

/** Clôture : un responsable, jamais la personne qui a déclaré ; réception technique = demande de validation approuvée. */
router.post('/:id/close', async (req, res) => {
  const r = await itemOf(req, req.params.id);
  if (!mgr(req)) throw new HttpError(403, 'Seul un responsable peut clôturer une fiche.');
  if (r.status === 'closed') throw new HttpError(409, 'Cette fiche est déjà clôturée.');
  if (Number(r.declared_by) === req.user.id) throw new HttpError(409, 'Vous ne pouvez pas clôturer une fiche que vous avez déclarée : un autre responsable doit le faire.');
  if (r.kind === 'reception') {
    const q = r.request_id ? await db.prepare('SELECT status FROM adm_requests WHERE id = ? AND org_id = ?').get(r.request_id, req.org.id) : null;
    if (!q || q.status !== 'approved') throw new HttpError(409, "La réception technique se clôture une fois la demande de validation approuvée par la direction technique.");
  }
  const t = nowISO();
  await db.prepare("UPDATE qhse_items SET status = 'closed', closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(req.user.id, t, t, r.id);
  await A.logActivity(req.org.id, req.user.id, 'qhse', `${r.ref} clôturé`);
  res.json({ ok: true });
});

/** Lance la validation d'une réception technique dans le circuit de l'entreprise (moteur d'Administration). */
router.post('/:id/reception-request', async (req, res, next) => {
  const r = await itemOf(req, req.params.id);
  if (r.kind !== 'reception') throw new HttpError(400, 'Seules les réceptions techniques passent par ce circuit.');
  if (r.status === 'closed') throw new HttpError(409, 'Cette fiche est clôturée.');
  if (r.request_id) throw new HttpError(409, 'Une demande de validation est déjà lancée.');
  let out = null;
  const fake = { status() { return this; }, json(x) { out = x; return this; } };
  req.body = { title: `Réception technique : ${r.title}`, detail: r.detail, linkType: 'qhse', linkId: Number(r.id) };
  await require('./ent-workflows').start(req, fake, 'reception_technique', next);
  const id = out && (out.id || (out.request && out.request.id));
  if (id) await db.prepare('UPDATE qhse_items SET request_id = ?, status = ?, updated_at = ? WHERE id = ?').run(Number(id), 'in_progress', nowISO(), r.id);
  res.status(201).json({ ok: true, requestId: id ? Number(id) : null });
});

router.delete('/:id', async (req, res) => {
  const r = await itemOf(req, req.params.id);
  if (!A.can(req, 'admin')) throw new HttpError(403, 'Seul un administrateur peut supprimer une fiche.');
  await db.prepare('DELETE FROM qhse_items WHERE id = ? AND org_id = ?').run(r.id, req.org.id);
  await A.logActivity(req.org.id, req.user.id, 'qhse', `${r.ref} supprimé`);
  res.json({ ok: true });
});

module.exports = router;
module.exports.stats = stats;
module.exports.openOf = openOf;
