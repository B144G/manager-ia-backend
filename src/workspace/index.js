'use strict';
// Espace de travail IA : organisations, équipe, antennes, invitations. Chaque sous-application a son propre fichier.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const { requireUser } = require('../middleware/auth');
const limits = require('../middleware/limits');
const A = require('./access');
const { modules } = require('./modules');
const { HttpError, asyncHandler } = require('../util');

const router = express.Router();
const pub = express.Router();

// ---------- Entrée publique : formulaire de contact d'une organisation (crée un ticket) ----------
const intakeLimit = limits.make(10 * 60 * 1000, 8, 'Trop de messages envoyés. Réessayez dans quelques minutes.');
pub.post('/intake/:token', intakeLimit, (req, res) => {
  const org = db.prepare('SELECT id FROM orgs WHERE intake_token = ?').get(String(req.params.token).slice(0, 80));
  if (!org) throw new HttpError(404, 'Formulaire introuvable.');
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: 'Indiquez votre nom.' });
  const message = A.text(b.message, 2000, { required: true, msg: 'Écrivez votre message.' });
  const now = nowISO();
  const t = db.prepare("INSERT INTO tickets (org_id, customer_name, customer_contact, channel, subject, created_at, updated_at) VALUES (?, ?, ?, 'formulaire', ?, ?, ?)")
    .run(org.id, name, A.text(b.contact, 120), A.text(b.subject, 150) || message.slice(0, 80), now, now).lastInsertRowid;
  db.prepare("INSERT INTO ticket_messages (ticket_id, author, content, created_at) VALUES (?, 'customer', ?, ?)").run(t, message, now);
  A.logActivity(org.id, null, 'support', `Nouveau message client de ${name}`);
  res.status(201).json({ ok: true });
});

// Assistant commercial public (page chat.html) : sans connexion, avec limites de débit.
pub.use('/chat', require('./sales-public'));
pub.use('/whatsapp', require('./whatsapp'));

// ---------- Tout le reste exige une connexion ----------
router.use(requireUser);

const memberView = (m) => ({ userId: m.user_id, name: m.name, contact: m.contact, role: m.role, title: m.title, branchId: m.branch_id });
const orgView = (o) => ({ id: o.id, name: o.name, sector: o.sector, description: o.description, currency: o.currency });

router.get('/modules', (req, res) => res.json({ modules }));

router.get('/orgs', (req, res) => {
  const rows = db.prepare(`SELECT o.*, m.role FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.id`).all(req.user.id);
  res.json({ orgs: rows.map((o) => ({ ...orgView(o), role: o.role })) });
});

router.post('/orgs', (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'organisation." });
  const lim = A.limitsFor(req.user.plan);
  const owned = db.prepare('SELECT COUNT(*) c FROM orgs WHERE owner_id = ?').get(req.user.id).c;
  if (owned >= lim.orgs) throw new HttpError(403, `Votre offre ${req.user.plan} permet ${lim.orgs} organisation(s). Passez à une offre supérieure pour en créer d'autres.`);
  const now = nowISO();
  const id = db.transaction(() => {
    const oid = db.prepare('INSERT INTO orgs (name, sector, description, currency, owner_id, intake_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, A.text(b.sector, 100), A.text(b.description, 1000), A.text(b.currency, 10) || 'FCFA', req.user.id, crypto.randomBytes(16).toString('hex'), now).lastInsertRowid;
    db.prepare("INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, 'owner', 'Dirigeant', ?)").run(oid, req.user.id, now);
    return oid;
  })();
  A.logActivity(id, req.user.id, 'team', `Organisation « ${name} » créée`);
  res.status(201).json({ id });
});

router.post('/orgs/join', (req, res) => {
  const code = A.text((req.body || {}).code, 40, { required: true, msg: "Entrez le code d'invitation." }).toUpperCase();
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!inv || new Date(inv.expires_at).getTime() < Date.now()) throw new HttpError(400, "Code d'invitation invalide ou expiré.");
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(inv.org_id);
  if (db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(org.id, req.user.id)) return res.json({ id: org.id });
  const count = db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(org.id).c;
  if (count >= A.limitsFor(A.ownerPlan(org)).members) throw new HttpError(403, "Cette organisation a atteint le nombre de personnes permis par son offre.");
  db.transaction(() => {
    db.prepare('INSERT INTO org_members (org_id, user_id, role, title, branch_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(org.id, req.user.id, inv.role, inv.title, inv.branch_id, nowISO());
    db.prepare('DELETE FROM invites WHERE id = ?').run(inv.id); // un code = une personne
  })();
  A.logActivity(org.id, req.user.id, 'team', `${req.user.name} a rejoint l'équipe`);
  res.json({ id: org.id });
});

const orgRouter = express.Router({ mergeParams: true });
router.use('/orgs/:orgId', A.loadOrg, orgRouter);

orgRouter.get('/', (req, res) => {
  const lim = A.limitsFor(A.ownerPlan(req.org));
  const branches = db.prepare('SELECT id, name, location FROM branches WHERE org_id = ? ORDER BY name').all(req.org.id);
  const members = db.prepare('SELECT user_id, role, title, branch_id FROM org_members WHERE org_id = ?').all(req.org.id);
  const me = { role: req.member.role, roleLabel: A.ROLE_LABEL[req.member.role], title: req.member.title, branchId: req.member.branch_id, userId: req.user.id };
  const mods = modules.filter((m) => A.RANK[req.member.role] >= A.RANK[m.min]);
  res.json({
    org: { ...orgView(req.org), plan: A.ownerPlan(req.org) },
    me, branches, modules: mods,
    limits: { members: lim.members, branches: lim.branches, aiMonth: lim.aiMonth, aiUsed: A.aiUsed(req.org), aiResetAt: A.quotaWindow(req.org).end, membersUsed: members.length },
    intakeToken: A.can(req, 'admin') ? req.org.intake_token : undefined,
  });
});

orgRouter.put('/', A.need('admin'), (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100) || req.org.name;
  db.prepare('UPDATE orgs SET name = ?, sector = ?, description = ?, currency = ? WHERE id = ?').run(
    name, b.sector === undefined ? req.org.sector : A.text(b.sector, 100), b.description === undefined ? req.org.description : A.text(b.description, 1000),
    b.currency === undefined ? req.org.currency : A.text(b.currency, 10) || 'FCFA', req.org.id);
  res.json({ ok: true });
});

orgRouter.delete('/', A.need('owner'), (req, res) => {
  if ((req.body || {}).confirm !== req.org.name) throw new HttpError(400, "Pour supprimer, écrivez exactement le nom de l'organisation.");
  db.prepare('DELETE FROM orgs WHERE id = ?').run(req.org.id);
  res.json({ ok: true });
});

// ---------- Antennes (succursales / extensions) ----------
orgRouter.get('/branches', (req, res) => res.json({ branches: db.prepare('SELECT id, name, location FROM branches WHERE org_id = ? ORDER BY name').all(req.org.id) }));

orgRouter.post('/branches', A.need('admin'), (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'antenne." });
  const n = db.prepare('SELECT COUNT(*) c FROM branches WHERE org_id = ?').get(req.org.id).c;
  const lim = A.limitsFor(A.ownerPlan(req.org)).branches;
  if (n >= lim) throw new HttpError(403, `L'offre ${A.ownerPlan(req.org)} permet ${lim} antenne(s). Passez à une offre supérieure pour en ajouter.`);
  const id = db.prepare('INSERT INTO branches (org_id, name, location, created_at) VALUES (?, ?, ?, ?)').run(req.org.id, name, A.text(b.location, 200), nowISO()).lastInsertRowid;
  A.logActivity(req.org.id, req.user.id, 'team', `Antenne « ${name} » ajoutée`);
  res.status(201).json({ id: Number(id) });
});

orgRouter.put('/branches/:id', A.need('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM branches WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!row) throw new HttpError(404, 'Antenne introuvable.');
  const b = req.body || {};
  db.prepare('UPDATE branches SET name = ?, location = ? WHERE id = ?').run(A.text(b.name, 100) || row.name, b.location === undefined ? row.location : A.text(b.location, 200), row.id);
  res.json({ ok: true });
});

orgRouter.delete('/branches/:id', A.need('admin'), (req, res) => {
  const r = db.prepare('DELETE FROM branches WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Antenne introuvable.');
  res.json({ ok: true });
});

// ---------- Équipe ----------
orgRouter.get('/members', (req, res) => {
  const rows = db.prepare(`SELECT m.user_id, m.role, m.title, m.branch_id, u.name, u.contact FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.id`).all(req.org.id);
  // Les coordonnées ne sont montrées qu'aux responsables et plus.
  res.json({ members: rows.map((m) => ({ ...memberView(m), contact: A.can(req, 'manager') ? m.contact : undefined })) });
});

orgRouter.put('/members/:userId', A.need('admin'), (req, res) => {
  const uid = A.id(req.params.userId);
  const target = db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!target) throw new HttpError(404, 'Personne introuvable.');
  if (target.role === 'owner') throw new HttpError(403, 'Le propriétaire ne peut pas être modifié.');
  const b = req.body || {};
  const role = b.role === undefined ? target.role : A.oneOf(b.role, ['member', 'manager', 'admin'], undefined, 'Rôle inconnu.');
  if (role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut nommer un administrateur.');
  if (target.role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut modifier un administrateur.');
  const branch = b.branchId === undefined ? target.branch_id : A.branchOf(req, b.branchId);
  db.prepare('UPDATE org_members SET role = ?, title = ?, branch_id = ? WHERE id = ?').run(role, b.title === undefined ? target.title : A.text(b.title, 80), branch, target.id);
  res.json({ ok: true });
});

orgRouter.delete('/members/:userId', (req, res) => {
  const uid = A.id(req.params.userId);
  const target = db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!target) throw new HttpError(404, 'Personne introuvable.');
  if (target.role === 'owner') throw new HttpError(403, 'Le propriétaire ne peut pas quitter son organisation (supprimez-la à la place).');
  if (uid !== req.user.id) {
    if (!A.can(req, 'admin')) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
    if (target.role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut retirer un administrateur.');
  }
  db.transaction(() => {
    db.prepare('UPDATE tasks SET assignee_id = NULL WHERE org_id = ? AND assignee_id = ?').run(req.org.id, uid);
    db.prepare('UPDATE tickets SET assignee_id = NULL WHERE org_id = ? AND assignee_id = ?').run(req.org.id, uid);
    db.prepare('UPDATE positions SET holder_id = NULL WHERE org_id = ? AND holder_id = ?').run(req.org.id, uid);
    db.prepare('DELETE FROM org_members WHERE id = ?').run(target.id);
  })();
  A.logActivity(req.org.id, req.user.id, 'team', uid === req.user.id ? `${req.user.name} a quitté l'équipe` : 'Une personne a été retirée de l\'équipe');
  res.json({ ok: true });
});

// ---------- Invitations (code à usage unique) ----------
orgRouter.get('/invites', A.need('admin'), (req, res) => {
  res.json({ invites: db.prepare('SELECT code, role, title, branch_id AS branchId, expires_at AS expiresAt FROM invites WHERE org_id = ? AND expires_at > ? ORDER BY id DESC').all(req.org.id, nowISO()) });
});

orgRouter.post('/invites', A.need('admin'), (req, res) => {
  const b = req.body || {};
  const role = A.oneOf(b.role, ['member', 'manager', 'admin'], 'member', 'Rôle inconnu.');
  if (role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut inviter un administrateur.');
  const branch = A.branchOf(req, b.branchId);
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  const days = Math.min(Math.max(Number(b.days) || 7, 1), 30);
  db.prepare('INSERT INTO invites (org_id, code, role, title, branch_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, code, role, A.text(b.title, 80), branch, req.user.id, new Date(Date.now() + days * 86400000).toISOString(), nowISO());
  res.status(201).json({ code });
});

orgRouter.delete('/invites/:code', A.need('admin'), (req, res) => {
  db.prepare('DELETE FROM invites WHERE org_id = ? AND code = ?').run(req.org.id, String(req.params.code).slice(0, 40).toUpperCase());
  res.json({ ok: true });
});

orgRouter.get('/activity', (req, res) => {
  const rows = db.prepare(`SELECT a.module, a.text, a.created_at AS at, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT 30`).all(req.org.id);
  res.json({ activity: rows });
});

// ---------- Sous-applications ----------
orgRouter.use('/dashboard', require('./dashboard'));
orgRouter.use('/decisions', require('./decisions'));
orgRouter.use('/support', require('./support'));
orgRouter.use('/projects', require('./projects'));
orgRouter.use('/budget', require('./budget'));
orgRouter.use('/stock', require('./stock'));
orgRouter.use('/crm', require('./crm'));
orgRouter.use('/mail', require('./mail'));
orgRouter.use('/sales', require('./sales').router);
orgRouter.use('/sales-mine', require('./sales').mine);
orgRouter.use('/hr', require('./hr'));
orgRouter.use('/structure', require('./structure'));
orgRouter.use('/ai', require('./ai').router);

module.exports = { router, pub };
