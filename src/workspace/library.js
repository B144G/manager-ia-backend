'use strict';
// Bibliothèque : blocs protégés (déverrouillage par le mot de passe de la personne), droits par bloc, réglages, journal d'audit, statistiques.
// Les documents sont dans library-docs.js. Les règles de sécurité sont dans library-core.js (à lire en premier).
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, nowISO } = require('../db');
const A = require('./access');
const C = require('./library-core');
const limits = require('../middleware/limits');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });

const unlockLimit = limits.make(15 * 60 * 1000, 40, 'Trop de tentatives. Réessayez dans 15 minutes.', { shared: true, prefix: 'libunlock' });
const HEX = /^#[0-9a-fA-F]{6}$/;
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

const blockView = (b, extra = {}) => ({ id: Number(b.id), slug: b.slug, name: b.name, color: b.color, icon: b.icon, personal: Number(b.personal) === 1, builtin: Number(b.builtin) === 1, hidden: Number(b.hidden) === 1, position: Number(b.position), ...extra });
/** Dans le bloc « Dossiers personnels », chacun ne voit que ses propres documents. */
const mineSql = (block, req) => (Number(block.personal) === 1 ? { sql: ' AND created_by = ?', args: [req.user.id] } : { sql: '', args: [] });

// ---------- Vue d'ensemble : statistiques et cartes ----------
router.get('/overview', async (req, res) => {
  await C.ensureBlocks(req.org.id);
  const all = await db.prepare('SELECT * FROM lib_blocks WHERE org_id = ? ORDER BY position, id').all(req.org.id);
  const grants = await C.openGrants(req);
  const counts = await db.prepare(`SELECT d.block_id, COUNT(*) AS n, COALESCE(SUM((SELECT SUM(v.size) FROM lib_versions v WHERE v.doc_id = d.id)), 0) AS vol
    FROM lib_docs d JOIN lib_blocks b ON b.id = d.block_id WHERE d.org_id = ? AND d.deleted_at IS NULL AND (b.personal = 0 OR d.created_by = ?) GROUP BY d.block_id`).all(req.org.id, req.user.id);
  const byBlock = Object.fromEntries(counts.map((c) => [Number(c.block_id), { n: Number(c.n), vol: Number(c.vol) }]));
  const blocks = [];
  let docs = 0; let used = 0; let volume = 0;
  for (const b of all) {
    const perms = await C.effectivePerms(req, b);
    if (!perms.view || (Number(b.hidden) === 1 && !A.can(req, 'admin'))) continue;
    const c = byBlock[Number(b.id)] || { n: 0, vol: 0 };
    docs += c.n; volume += c.vol; if (c.n > 0) used++;
    blocks.push(blockView(b, { docCount: c.n, volume: c.vol, unlocked: grants[Number(b.id)] !== undefined, expiresAt: grants[Number(b.id)] || null, perms: { view: perms.view, read: perms.read, add: perms.add, edit: perms.edit, delete: perms.delete } }));
  }
  const sc = A.scope(req);
  const projects = Number((await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE org_id = ? AND status = 'active'${sc.sql}`).get(req.org.id, ...sc.args)).n);
  const lim = await C.limitsOf(req.org);
  const st = await C.settings(req.org.id);
  res.json({
    stats: { documents: docs, modulesUsed: used, activeProjects: projects, volume },
    blocks, canManage: A.can(req, 'admin'),
    storage: { used: lim.used, quota: lim.quotaBytes, maxFile: lim.maxFileBytes },
    grantMinutes: st.grantMinutes, trashDays: C.TRASH_DAYS, icons: C.ICONS,
  });
});

// ---------- Déverrouillage : le mot de passe est comparé (bcrypt) au hash du compte connecté, jamais conservé, journalisé ni renvoyé ----------
router.post('/blocks/:bid/unlock', unlockLimit, async (req, res) => {
  const { block } = await C.blockFor(req, req.params.bid);
  const password = typeof (req.body || {}).password === 'string' ? req.body.password.slice(0, 200) : '';
  const ms = await C.lockedFor(req.user.id, block.id);
  const sec = require('../security');
  if (ms) {
    await C.logAudit(req, { blockId: block.id, action: 'unlock_locked' });
    throw new HttpError(429, 'Trop d’essais : ce bloc est fermé pour votre compte pendant 15 minutes.');
  }
  if (!password) throw new HttpError(400, 'Saisissez votre mot de passe.');
  if (!(await bcrypt.compare(password, req.user.pass_hash))) {
    const r = await C.recordFail(req.user.id, block.id);
    await C.logAudit(req, { blockId: block.id, action: 'unlock_fail', detail: `${r.left} essai(s) restant(s)` });
    await sec.audit.record(req, r.locked ? 'library.unlock_locked' : 'library.unlock_fail', { orgId: req.org.id, target: `block:${block.id}`, severity: r.locked ? 'high' : 'warn' });
    if (r.locked) throw new HttpError(429, 'Trop d’essais : ce bloc est fermé pour votre compte pendant 15 minutes.');
    throw new HttpError(403, 'Mot de passe incorrect.');
  }
  await C.clearFails(req.user.id, block.id);
  const st = await C.settings(req.org.id);
  const expiresAt = await C.createGrant(req, block, st);
  await C.logAudit(req, { blockId: block.id, action: 'unlock_ok' });
  res.json({ ok: true, expiresAt });
});

/** Referme un bloc : l'autorisation est révoquée aussitôt. */
router.post('/blocks/:bid/lock', async (req, res) => {
  const b = await db.prepare('SELECT id FROM lib_blocks WHERE id = ? AND org_id = ?').get(A.id(req.params.bid, 'Bloc introuvable.'), req.org.id);
  if (!b) throw new HttpError(404, 'Bloc introuvable.');
  const n = await C.revokeGrants('org_id = ? AND user_id = ? AND session_id = ? AND block_id = ?', [req.org.id, req.user.id, req.sessionId || '', b.id], 'fermé par la personne');
  if (n) await C.logAudit(req, { blockId: b.id, action: 'lock' });
  res.json({ ok: true });
});
router.post('/lock-all', async (req, res) => {
  const n = await C.revokeGrants('org_id = ? AND user_id = ? AND session_id = ?', [req.org.id, req.user.id, req.sessionId || ''], 'fermé par la personne');
  if (n) await C.logAudit(req, { action: 'lock', detail: 'Tous les blocs' });
  res.json({ ok: true });
});

// ---------- Contenu d'un bloc déverrouillé : voir library-docs.js (GET /blocks/:bid) ----------

// ---------- Gestion des blocs (administrateur) ----------
router.post('/blocks', A.need('admin'), async (req, res) => {
  await C.ensureBlocks(req.org.id);
  const b = req.body || {};
  const name = A.text(b.name, 60, { required: true, msg: 'Indiquez le nom du bloc.' });
  const color = b.color === undefined || b.color === '' ? '#2f6f5e' : String(b.color);
  if (!HEX.test(color)) throw new HttpError(400, 'Couleur invalide (format #RRGGBB).');
  const icon = A.oneOf(b.icon, C.ICONS, 'folder', 'Icône inconnue.');
  if (Number((await db.prepare('SELECT COUNT(*) AS n FROM lib_blocks WHERE org_id = ?').get(req.org.id)).n) >= 40) throw new HttpError(403, 'Vous avez atteint 40 blocs : supprimez-en un avant d’en ajouter.');
  const pos = Number((await db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM lib_blocks WHERE org_id = ?').get(req.org.id)).p) + 10;
  const id = await db.transaction(async () => {
    const bid = Number((await db.prepare('INSERT INTO lib_blocks (org_id, slug, name, color, icon, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, 'c' + crypto.randomBytes(5).toString('hex'), name, color.toLowerCase(), icon, pos, nowISO())).lastInsertRowid);
    await C.seedPerms(req.org.id, bid, 'general');
    return bid;
  })();
  await C.logAudit(req, { blockId: id, action: 'block_add', detail: name });
  res.status(201).json({ id });
});

router.put('/blocks/:bid', A.need('admin'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM lib_blocks WHERE id = ? AND org_id = ?').get(A.id(req.params.bid, 'Bloc introuvable.'), req.org.id);
  if (!row) throw new HttpError(404, 'Bloc introuvable.');
  const b = req.body || {};
  const name = b.name === undefined ? row.name : A.text(b.name, 60, { required: true, msg: 'Indiquez le nom du bloc.' });
  let color = row.color;
  if (b.color !== undefined) { if (!HEX.test(String(b.color))) throw new HttpError(400, 'Couleur invalide (format #RRGGBB).'); color = String(b.color).toLowerCase(); }
  const icon = b.icon === undefined ? row.icon : A.oneOf(b.icon, C.ICONS, undefined, 'Icône inconnue.');
  const hidden = b.hidden === undefined ? Number(row.hidden) : flag(b.hidden);
  const position = b.position === undefined ? Number(row.position) : Math.min(Math.max(Math.round(Number(b.position)) || 0, 0), 100000);
  await db.prepare('UPDATE lib_blocks SET name = ?, color = ?, icon = ?, hidden = ?, position = ? WHERE id = ?').run(name, color, icon, hidden, position, row.id);
  const what = [name !== row.name ? `nom « ${row.name} » → « ${name} »` : '', hidden !== Number(row.hidden) ? (hidden ? 'masqué' : 'affiché') : '', color !== row.color || icon !== row.icon ? 'apparence' : ''].filter(Boolean).join(', ');
  await C.logAudit(req, { blockId: row.id, action: 'block_edit', detail: what });
  res.json({ ok: true });
});

router.delete('/blocks/:bid', A.need('admin'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM lib_blocks WHERE id = ? AND org_id = ?').get(A.id(req.params.bid, 'Bloc introuvable.'), req.org.id);
  if (!row) throw new HttpError(404, 'Bloc introuvable.');
  if (Number(row.builtin) === 1) throw new HttpError(400, 'Un bloc de départ ne se supprime pas : masquez-le plutôt.');
  if (Number((await db.prepare('SELECT COUNT(*) AS n FROM lib_docs WHERE block_id = ?').get(row.id)).n) > 0) throw new HttpError(400, 'Ce bloc contient encore des documents (corbeille comprise) : videz-le avant de le supprimer.');
  await db.prepare('DELETE FROM lib_blocks WHERE id = ?').run(row.id);
  await C.logAudit(req, { blockId: null, action: 'block_delete', detail: row.name });
  res.json({ ok: true });
});

// ---------- Droits par bloc (administrateur) ----------
const permsOut = (r) => ({ ...C.fromRow(r) });
router.get('/blocks/:bid/perms', A.need('admin'), async (req, res) => {
  const b = await db.prepare('SELECT * FROM lib_blocks WHERE id = ? AND org_id = ?').get(A.id(req.params.bid, 'Bloc introuvable.'), req.org.id);
  if (!b) throw new HttpError(404, 'Bloc introuvable.');
  if (Number(b.personal) === 1) return res.json({ personal: true, roles: {}, users: [] });
  const rows = await db.prepare('SELECT * FROM lib_perms WHERE block_id = ?').all(b.id);
  const roles = { member: C.norm({}), manager: C.norm({}), admin: C.norm({}) };
  const users = [];
  for (const r of rows) {
    if (r.subject.startsWith('role:') && roles[r.subject.slice(5)]) roles[r.subject.slice(5)] = permsOut(r);
    else if (r.subject.startsWith('user:')) users.push({ userId: Number(r.subject.slice(5)), ...permsOut(r) });
  }
  const members = await db.prepare('SELECT m.user_id, m.role, m.title, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.id').all(req.org.id);
  res.json({
    personal: false, roles, owner: 'Le propriétaire a toujours tous les droits.',
    members: members.map((m) => ({ userId: Number(m.user_id), name: m.name, role: m.role, roleLabel: A.ROLE_LABEL[m.role], title: m.title })),
    users: users.filter((u) => members.some((m) => Number(m.user_id) === u.userId)),
  });
});

router.put('/blocks/:bid/perms', A.need('admin'), async (req, res) => {
  const b = await db.prepare('SELECT * FROM lib_blocks WHERE id = ? AND org_id = ?').get(A.id(req.params.bid, 'Bloc introuvable.'), req.org.id);
  if (!b) throw new HttpError(404, 'Bloc introuvable.');
  if (Number(b.personal) === 1) throw new HttpError(400, 'Les dossiers personnels sont privés : leurs droits ne se règlent pas.');
  const body = req.body || {};
  const isOwner = A.can(req, 'owner');
  const roles = body.roles && typeof body.roles === 'object' ? body.roles : {};
  const users = Array.isArray(body.users) ? body.users : [];
  if (users.length > 200) throw new HttpError(400, 'Trop d’exceptions personnelles.');
  const rows = []; // [subject, perms]
  for (const role of ['member', 'manager', 'admin']) {
    if (roles[role] === undefined) continue;
    if (role === 'admin' && !isOwner) throw new HttpError(403, 'Seul le propriétaire règle les droits des administrateurs.');
    rows.push(['role:' + role, C.norm(roles[role] || {})]);
  }
  const seen = new Set();
  for (const u of users) {
    const uid = await A.memberOf(req, (u || {}).userId);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const m = await db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
    if (m.role === 'owner') continue; // le propriétaire garde tous les droits
    if (m.role === 'admin' && !isOwner) continue; // les exceptions d'un administrateur ne changent que par le propriétaire (elles restent telles quelles)
    rows.push(['user:' + uid, C.norm(u)]);
  }
  const before = await db.prepare('SELECT subject, can_view, can_read, can_add, can_edit, can_delete FROM lib_perms WHERE block_id = ?').all(b.id);
  await db.transaction(async () => {
    const keepRoles = rows.filter((r) => r[0].startsWith('role:')).map((r) => r[0]);
    // Les rôles non fournis gardent leur réglage ; les exceptions personnelles sont remplacées dans leur ensemble (sauf celles d'un administrateur pour un simple administrateur).
    if (isOwner) await db.prepare("DELETE FROM lib_perms WHERE block_id = ? AND subject LIKE 'user:%'").run(b.id);
    else await db.prepare("DELETE FROM lib_perms WHERE block_id = ? AND subject LIKE 'user:%' AND substr(subject, 6)::bigint NOT IN (SELECT user_id FROM org_members WHERE org_id = ? AND role IN ('admin', 'owner'))").run(b.id, req.org.id);
    for (const s of keepRoles) await db.prepare('DELETE FROM lib_perms WHERE block_id = ? AND subject = ?').run(b.id, s);
    for (const [subject, p] of rows) await db.prepare('INSERT INTO lib_perms (org_id, block_id, subject, can_view, can_read, can_add, can_edit, can_delete) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, b.id, subject, p.view ? 1 : 0, p.read ? 1 : 0, p.add ? 1 : 0, p.edit ? 1 : 0, p.delete ? 1 : 0);
  })();
  const short = (p) => ['view', 'read', 'add', 'edit', 'delete'].filter((k) => p[k]).map((k) => ({ view: 'voir', read: 'lire', add: 'ajouter', edit: 'modifier', delete: 'supprimer' }[k])).join('/') || 'aucun';
  await C.logAudit(req, { blockId: b.id, action: 'perms', detail: `${rows.length} réglage(s) (avant : ${before.length}) — ` + rows.slice(0, 6).map(([s, p]) => `${s.replace('role:', '').replace('user:', 'personne ')} : ${short(p)}`).join(' ; ') });
  res.json({ ok: true });
});

// ---------- Réglages de sécurité (administrateur) ----------
const intIn = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, msg); return n; };
router.get('/settings', A.need('admin'), async (req, res) => {
  const lim = await C.limitsOf(req.org);
  res.json({ settings: await C.settings(req.org.id), storage: { used: lim.used, quota: lim.quotaBytes, maxFile: lim.maxFileBytes, plan: lim.plan }, ranges: { grantMinutes: [5, 60], grantMaxMinutes: [15, 480], maxFileMb: [0, 20] } });
});
router.put('/settings', A.need('admin'), async (req, res) => {
  const cur = await C.settings(req.org.id);
  const b = req.body || {};
  const next = {
    grantMinutes: b.grantMinutes === undefined ? cur.grantMinutes : intIn(b.grantMinutes, 5, 60, 'Durée d’autorisation : entre 5 et 60 minutes.'),
    grantMaxMinutes: b.grantMaxMinutes === undefined ? cur.grantMaxMinutes : intIn(b.grantMaxMinutes, 15, 480, 'Durée maximale : entre 15 minutes et 8 heures.'),
    maxFileMb: b.maxFileMb === undefined ? cur.maxFileMb : intIn(b.maxFileMb, 0, 20, 'Taille maximale d’un fichier : entre 0 (offre) et 20 Mo.'),
  };
  if (next.grantMaxMinutes < next.grantMinutes) throw new HttpError(400, 'La durée maximale ne peut pas être inférieure à la durée d’autorisation.');
  await db.prepare('INSERT INTO lib_settings (org_id, grant_minutes, grant_max_minutes, max_file_mb) VALUES (?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET grant_minutes = EXCLUDED.grant_minutes, grant_max_minutes = EXCLUDED.grant_max_minutes, max_file_mb = EXCLUDED.max_file_mb')
    .run(req.org.id, next.grantMinutes, next.grantMaxMinutes, next.maxFileMb);
  await C.logAudit(req, { action: 'settings', detail: `autorisation ${next.grantMinutes} min (plafond ${next.grantMaxMinutes} min), fichier ${next.maxFileMb || 'offre'} Mo` });
  res.json({ settings: next });
});

// ---------- Journal d'audit (administrateur) ----------
router.get('/audit', A.need('admin'), async (req, res) => {
  const q = req.query;
  const where = ['a.org_id = ?']; const args = [req.org.id];
  if (q.blockId) { where.push('a.block_id = ?'); args.push(A.id(q.blockId, 'Bloc invalide.')); }
  if (q.userId) { where.push('a.user_id = ?'); args.push(A.id(q.userId, 'Personne invalide.')); }
  if (q.action) { where.push('a.action = ?'); args.push(A.oneOf(String(q.action), Object.keys(C.AUDIT_LABEL), undefined, 'Action inconnue.')); }
  if (q.before) { where.push('a.id < ?'); args.push(A.id(q.before, 'Repère invalide.')); }
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
  const rows = await db.prepare(`SELECT a.*, u.name AS user_name, b.name AS block_name FROM lib_audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN lib_blocks b ON b.id = a.block_id
    WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`).all(...args, limit);
  res.json({
    actions: Object.entries(C.AUDIT_LABEL).map(([id, label]) => ({ id, label })),
    entries: rows.map((r) => ({ id: Number(r.id), at: r.created_at, userId: r.user_id == null ? null : Number(r.user_id), user: r.user_name || '', blockId: r.block_id == null ? null : Number(r.block_id), block: r.block_name || '', docId: r.doc_id == null ? null : Number(r.doc_id), action: r.action, label: C.AUDIT_LABEL[r.action] || r.action, detail: r.detail, ip: r.ip })),
    next: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
  });
});

router.use(require('./library-docs')({ blockView, mineSql }));

module.exports = router;
