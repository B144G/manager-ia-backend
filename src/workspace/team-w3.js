'use strict';
// Équipe · vague 3 : notifications internes, journal d'audit consultable (valeurs avant / après) et transfert de propriété de l'organisation.
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, parseJSON } = require('../util');

const router = express.Router({ mergeParams: true });

// ---------- Notifications de la personne connectée ----------
router.get('/notices', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM notices WHERE org_id = ? AND user_id = ? ORDER BY id DESC LIMIT 50').all(req.org.id, req.user.id);
  const unread = Number((await db.prepare('SELECT COUNT(*) c FROM notices WHERE org_id = ? AND user_id = ? AND is_read = 0').get(req.org.id, req.user.id)).c);
  res.json({ unread, items: rows.map((n) => ({ id: n.id, kind: n.kind, text: n.text, ref: n.ref, read: Boolean(Number(n.is_read)), at: n.created_at })) });
});
router.post('/notices/read', async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n)) : null;
  if (ids && ids.length) await db.prepare(`UPDATE notices SET is_read = 1 WHERE org_id = ? AND user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).run(req.org.id, req.user.id, ...ids);
  else await db.prepare('UPDATE notices SET is_read = 1 WHERE org_id = ? AND user_id = ?').run(req.org.id, req.user.id);
  res.json({ ok: true });
});

// ---------- Journal d'audit (administrateurs) ----------
router.get('/audit', A.need('admin'), async (req, res) => {
  const where = ['a.org_id = ?']; const args = [req.org.id]; const q = req.query;
  if (q.entity) { where.push('a.entity = ?'); args.push(String(q.entity).slice(0, 40)); }
  if (q.userId) { where.push('a.user_id = ?'); args.push(A.id(q.userId)); }
  if (q.action) { where.push('a.action = ?'); args.push(String(q.action).slice(0, 30)); }
  if (q.from) { where.push('a.created_at >= ?'); args.push(A.date(q.from)); }
  if (q.to) { where.push('a.created_at < ?'); args.push(W.addDays(A.date(q.to), 1)); }
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 300);
  const rows = await db.prepare(`SELECT a.*, u.name AS who FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ${limit}`).all(...args);
  const entities = (await db.prepare('SELECT DISTINCT entity FROM audit_log WHERE org_id = ? ORDER BY entity').all(req.org.id)).map((r) => r.entity);
  res.json({ entities, items: rows.map((r) => ({ id: r.id, at: r.created_at, who: r.who, userId: r.user_id, entity: r.entity, entityId: r.entity_id, action: r.action, before: parseJSON(r.before_json, null), after: parseJSON(r.after_json, null) })) });
});

// ---------- Transfert de propriété ----------
router.post('/ownership-transfer', A.need('owner'), async (req, res) => {
  const b = req.body || {};
  if (b.confirm !== req.org.name) throw new HttpError(400, "Pour confirmer, écrivez exactement le nom de l'organisation.");
  const to = A.id(b.userId, 'Choisissez la personne qui devient propriétaire.');
  if (to === req.user.id) throw new HttpError(400, 'Vous êtes déjà propriétaire.');
  const target = await db.prepare('SELECT m.*, u.plan, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?').get(req.org.id, to);
  if (!target) throw new HttpError(404, "Cette personne ne fait pas partie de l'organisation.");
  const lim = A.limitsFor(await A.ownerPlan({ owner_id: to }));
  const owned = Number((await db.prepare('SELECT COUNT(*) c FROM orgs WHERE owner_id = ?').get(to)).c);
  if (owned >= lim.orgs) throw new HttpError(403, `L'offre de ${target.name} ne permet pas d'être propriétaire d'une organisation de plus.`);
  const members = Number((await db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(req.org.id)).c);
  if (members > lim.members) throw new HttpError(403, `L'offre de ${target.name} permet ${lim.members} personne(s) : l'organisation en compte ${members}.`);
  await db.transaction(async () => {
    await db.prepare('UPDATE orgs SET owner_id = ? WHERE id = ?').run(to, req.org.id);
    await db.prepare("UPDATE org_members SET role = 'owner' WHERE org_id = ? AND user_id = ?").run(req.org.id, to);
    await db.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND user_id = ?").run(req.org.id, req.user.id);
  })();
  await W.audit(req, 'ownership', req.org.id, 'transfer', { owner: req.user.id }, { owner: to });
  await A.logActivity(req.org.id, req.user.id, 'team', `Propriété transférée à ${target.name}`);
  await W.push(req.org.id, to, 'team', `${req.user.name} vous a transféré la propriété de « ${req.org.name} ».`, 'org');
  res.json({ ok: true, newOwnerId: to });
});

module.exports = router;
