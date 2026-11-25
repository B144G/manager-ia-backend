'use strict';
// Espace de travail IA : organisations, équipe, antennes, invitations. Chaque sous-application a son propre fichier.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const config = require('../config');
const { requireUser } = require('../middleware/auth');
const limits = require('../middleware/limits');
const A = require('./access');
const W = require('./w3');
const { modules } = require('./modules');
const { HttpError, asyncHandler } = require('../util');

const router = express.Router();
const pub = express.Router();

pub.use('/testimonials', require('./feedback').pubRouter); // témoignages approuvés et consentis (aucune donnée privée)

// ---------- Entrée publique : formulaire de contact d'une organisation (crée un ticket) ----------
const intakeLimit = limits.make(10 * 60 * 1000, 8, 'Trop de messages envoyés. Réessayez dans quelques minutes.');
pub.post('/intake/:token', intakeLimit, async (req, res) => {
  const org = await db.prepare('SELECT * FROM orgs WHERE intake_token = ?').get(String(req.params.token).slice(0, 80));
  if (!org) throw new HttpError(404, 'Formulaire introuvable.');
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: 'Indiquez votre nom.' });
  const message = A.text(b.message, 2000, { required: true, msg: 'Écrivez votre message.' });
  const email = A.text(b.email, 120); const phone = A.text(b.phone, 40);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  const id = await require('./support').createTicket(org, { name, contact: A.text(b.contact, 120) || email || phone, email, phone, channel: 'formulaire', subject: A.text(b.subject, 150) || message.slice(0, 80), message });
  await A.logActivity(org.id, null, 'support', `Nouveau message client de ${name}`);
  const t = await db.prepare('SELECT ref FROM tickets WHERE id = ?').get(id);
  res.status(201).json({ ok: true, ref: t.ref });
});

// Assistant commercial public (page chat.html) : sans connexion, avec limites de débit.
pub.use('/chat', require('./sales-public'));
// Fichier à lien signé et temporaire : Messenger et Instagram téléchargent eux-mêmes les photos, vidéos et voix à envoyer.
pub.get('/file/:token', limits.make(60 * 1000, 120, 'Trop de requêtes.'), async (req, res) => {
  const d = require('../services/signedUrl').read(req.params.token);
  const row = d ? (d.k === 'cm' ? await db.prepare('SELECT mime, data FROM catalog_media WHERE id = ?').get(d.i) : await db.prepare('SELECT mime, data FROM tmp_files WHERE id = ? AND expires_at > ?').get(d.i, nowISO())) : null;
  if (!row) return res.status(404).json({ error: 'Lien expiré ou invalide.' });
  res.set({ 'Content-Type': row.mime, 'Content-Length': row.data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  return res.end(row.data);
});
// Agenda des rendez-vous (abonnement Google Agenda / Outlook / Apple par adresse secrète, en lecture seule)
pub.get('/calendar/:token.ics', limits.make(60 * 1000, 60, 'Trop de requêtes.'), async (req, res) => {
  const org = /^[a-f0-9]{36}$/.test(req.params.token) ? await db.prepare('SELECT * FROM orgs WHERE cal_token = ?').get(req.params.token) : null;
  if (!org) return res.status(404).type('text/plain').send('Agenda introuvable.');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="rendez-vous.ics"' });
  return res.send(await require('./sales-appt').icsFeed(org));
});
pub.use('/', require('./support-w3').pub);
pub.use('/', require('./marketing-w3').pub);
pub.use('/', require('./digest').pub);
pub.use('/', require('./followups').pub);
// Suivi de livraison par lien secret (Transport) : /api/ws/public/track/:token
pub.use('/', require('./tms').pub);
// Localisation du client par lien secret (Transport · géolocalisation) : /api/ws/public/geo/:token
pub.use('/', require('./tms-geo').pub);
pub.use('/', require('./commercial').pub);
pub.use('/', require('./brand').pub); // images de marque (jeton secret) et marque des pages publiques
pub.use('/whatsapp', require('./whatsapp'));
pub.use('/meta', require('./meta-channels'));

// ---------- Tout le reste exige une connexion ----------
router.use(requireUser);

const memberView = (m) => ({ userId: m.user_id, name: m.name, contact: m.contact, role: m.role, title: m.title, branchId: m.branch_id });
const orgView = (o) => ({ id: o.id, name: o.name, sector: o.sector, description: o.description, currency: o.currency, vatRate: Number(o.vat_rate) });

router.get('/modules', (req, res) => res.json({ modules }));

router.get('/orgs', async (req, res) => {
  const rows = await db.prepare(`SELECT o.*, m.role FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.id`).all(req.user.id);
  res.json({ orgs: rows.map((o) => ({ ...orgView(o), role: o.role })) });
});

router.post('/orgs', async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'organisation." });
  const L = require('./ent-links');
  const assoc = b.associationCode ? await L.usableLink(b.associationCode) : null; // lien d'association : l'organisation rejoint l'entreprise du lien (abonnement de l'entreprise principale)
  if (assoc) await L.assertOrgRoom(assoc.ent);
  const lim = A.limitsFor(req.user.plan);
  const owned = (await db.prepare('SELECT COUNT(*) c FROM orgs WHERE owner_id = ?').get(req.user.id)).c;
  if (!assoc && owned >= lim.orgs) throw new HttpError(403, `Votre offre ${require('../services/custom-plan').label(req.user.plan)} permet ${lim.orgs} organisation(s). Passez à une offre supérieure pour en créer d'autres.`);
  const now = nowISO();
  const id = await db.transaction(async () => {
    const oid = (await db.prepare('INSERT INTO orgs (name, sector, description, currency, owner_id, intake_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, A.text(b.sector, 100), A.text(b.description, 1000), A.text(b.currency, 10) || 'FCFA', req.user.id, crypto.randomBytes(16).toString('hex'), now)).lastInsertRowid;
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, 'owner', 'Dirigeant', ?)").run(oid, req.user.id, now);
    if (assoc) await L.attach(oid, name, assoc, req.user.id); // organisation liée : même entreprise, direction générale commune, structure copiée
    else await require('./ent-lib').createFor({ id: oid, name, currency: A.text(b.currency, 10) || 'FCFA', owner_id: req.user.id }, now); // l'entreprise, avec le créateur comme directeur général
    return oid;
  })();
  await A.logActivity(id, req.user.id, 'team', `Organisation « ${name} » créée`);
  await require('../services/accounts').recordEvent(req.user.id, 'organisation_creee'); // chronologie admin : le type d'événement seulement, jamais le nom ni le contenu
  res.status(201).json({ id });
});

router.post('/orgs/join', async (req, res) => {
  const code = A.text((req.body || {}).code, 40, { required: true, msg: "Entrez le code d'invitation." }).toUpperCase();
  const inv = await db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!inv || new Date(inv.expires_at).getTime() < Date.now()) throw new HttpError(400, "Code d'invitation invalide ou expiré.");
  const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(inv.org_id);
  if (await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(org.id, req.user.id)) return res.json({ id: org.id });
  const count = (await db.prepare('SELECT COUNT(*) c FROM org_members WHERE org_id = ?').get(org.id)).c;
  if (count >= A.limitsFor(await A.ownerPlan(org)).members) throw new HttpError(403, "Cette organisation a atteint le nombre de personnes permis par son offre.");
  await db.transaction(async () => {
    await db.prepare('INSERT INTO org_members (org_id, user_id, role, title, branch_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(org.id, req.user.id, inv.role, inv.title, inv.branch_id, nowISO());
    await db.prepare('DELETE FROM invites WHERE id = ?').run(inv.id); // un code = une personne
  })();
  await require('./ent-lib').onJoin(org, req.user, code); // relie le compte à sa fiche (code d'invitation personnel de l'assistant d'entreprise)
  await A.logActivity(org.id, req.user.id, 'team', `${req.user.name} a rejoint l'équipe`);
  res.json({ id: org.id });
});

/** Avant de créer une organisation liée : à quelle entreprise le lien d'association rattache-t-il ? (aucune donnée sensible) */
router.post('/orgs/link/preview', limits.make(15 * 60 * 1000, 30, 'Trop de tentatives. Réessayez dans quelques minutes.', { shared: true, prefix: 'entlinkpreview' }), async (req, res) => {
  const { link, ent } = await require('./ent-links').usableLink((req.body || {}).code);
  res.json({ company: ent.name, copyStructure: Boolean(Number(link.copy_structure)), expiresAt: link.expires_at });
});

const orgRouter = express.Router({ mergeParams: true });
router.use('/orgs/:orgId', A.loadOrg, require('../services/brand-lib').context, orgRouter); // la marque de l'entreprise est disponible à tout le code appelé ensuite (PDF, e-mails, invites de l'IA)

orgRouter.get('/', async (req, res) => {
  const lim = A.limitsFor(await A.ownerPlan(req.org));
  const branches = await db.prepare('SELECT id, name, location FROM branches WHERE org_id = ? ORDER BY name').all(req.org.id);
  const members = await db.prepare('SELECT user_id, role, title, branch_id FROM org_members WHERE org_id = ?').all(req.org.id);
  const me = { role: req.member.role, roleLabel: A.ROLE_LABEL[req.member.role], title: req.member.title, branchId: req.member.branch_id, userId: req.user.id };
  let mods = modules.filter((m) => A.RANK[req.member.role] >= A.RANK[m.min]);
  if (!await require('./tre-lib').hasAccess(req)) mods = mods.filter((m) => m.id !== 'treasury'); // Trésorerie : réservée au responsable, aux trésoriers et aux administrateurs
  res.json({
    org: { ...orgView(req.org), plan: await A.ownerPlan(req.org) },
    me, branches, modules: mods, brand: req.brand, // marque de l'entreprise (valeurs par défaut = affichage d'origine)
    limits: { members: lim.members, branches: lim.branches, aiMonth: lim.aiMonth, aiUsed: await A.aiUsed(req.org), aiResetAt: (await A.quotaWindow(req.org)).end, membersUsed: members.length },
    intakeToken: A.can(req, 'admin') ? req.org.intake_token : undefined,
    profile: await require('./ent-profiles').summaryFor(req), // profil de rôle du poste (étape 3) ; null = aucun poste, écran habituel inchangé
    spaces: await require('./spaces').forMember(req), // Espaces par rôle (réglage d'entreprise, désactivé par défaut)
    features: { metaChannels: config.metaChannelsVisible, waQr: config.waQr.enabled },
  });
});

orgRouter.put('/', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100) || req.org.name;
  await db.prepare('UPDATE orgs SET name = ?, sector = ?, description = ?, currency = ? WHERE id = ?').run(
    name, b.sector === undefined ? req.org.sector : A.text(b.sector, 100), b.description === undefined ? req.org.description : A.text(b.description, 1000),
    b.currency === undefined ? req.org.currency : A.text(b.currency, 10) || 'FCFA', req.org.id);
  res.json({ ok: true });
});

orgRouter.delete('/', A.need('owner'), async (req, res) => {
  if ((req.body || {}).confirm !== req.org.name) throw new HttpError(400, "Pour supprimer, écrivez exactement le nom de l'organisation.");
  await require('../services/waWeb').dropOrg(req.org.id).catch(() => {}); // ferme la session WhatsApp par QR code ; la base efface le reste en cascade
  await db.transaction(async () => {
    await require('../security/privacy').purgeOrgOrphans(req.org.id); // tables sans liaison en cascade : rien ne doit rester
    await db.prepare('DELETE FROM orgs WHERE id = ?').run(req.org.id);
    if (req.org.entreprise_id) await db.prepare('DELETE FROM entreprises WHERE id = ? AND NOT EXISTS (SELECT 1 FROM orgs WHERE entreprise_id = ?)').run(req.org.entreprise_id, req.org.entreprise_id); // une entreprise sans organisation disparaît avec elle
  })();
  res.json({ ok: true });
});

// ---------- Antennes (succursales / extensions) ----------
orgRouter.get('/branches', async (req, res) => res.json({ branches: await db.prepare('SELECT id, name, location FROM branches WHERE org_id = ? ORDER BY name').all(req.org.id) }));

orgRouter.post('/branches', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: "Indiquez le nom de l'antenne." });
  const n = (await db.prepare('SELECT COUNT(*) c FROM branches WHERE org_id = ?').get(req.org.id)).c;
  const lim = A.limitsFor(await A.ownerPlan(req.org)).branches;
  if (n >= lim) throw new HttpError(403, `L'offre ${require('../services/custom-plan').label(await A.ownerPlan(req.org))} permet ${lim} antenne(s). Passez à une offre supérieure pour en ajouter.`);
  const id = (await db.prepare('INSERT INTO branches (org_id, name, location, created_at) VALUES (?, ?, ?, ?)').run(req.org.id, name, A.text(b.location, 200), nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'team', `Antenne « ${name} » ajoutée`);
  res.status(201).json({ id: Number(id) });
});

orgRouter.put('/branches/:id', A.need('admin'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM branches WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!row) throw new HttpError(404, 'Antenne introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE branches SET name = ?, location = ? WHERE id = ?').run(A.text(b.name, 100) || row.name, b.location === undefined ? row.location : A.text(b.location, 200), row.id);
  res.json({ ok: true });
});

orgRouter.delete('/branches/:id', A.need('admin'), async (req, res) => {
  const r = await db.prepare('DELETE FROM branches WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Antenne introuvable.');
  res.json({ ok: true });
});

// ---------- Équipe ----------
orgRouter.get('/members', async (req, res) => {
  const rows = await db.prepare(`SELECT m.user_id, m.role, m.title, m.branch_id, u.name, u.contact FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.id`).all(req.org.id);
  // Les coordonnées ne sont montrées qu'aux responsables et plus.
  res.json({ members: rows.map((m) => ({ ...memberView(m), contact: A.can(req, 'manager') ? m.contact : undefined })) });
});

orgRouter.put('/members/:userId', A.need('admin'), async (req, res) => {
  const uid = A.id(req.params.userId);
  const target = await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!target) throw new HttpError(404, 'Personne introuvable.');
  if (target.role === 'owner') throw new HttpError(403, 'Le propriétaire ne peut pas être modifié.');
  const b = req.body || {};
  const role = b.role === undefined ? target.role : A.oneOf(b.role, ['member', 'manager', 'admin'], undefined, 'Rôle inconnu.');
  if (role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut nommer un administrateur.');
  if (target.role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut modifier un administrateur.');
  const branch = b.branchId === undefined ? target.branch_id : await A.branchOf(req, b.branchId);
  await db.prepare('UPDATE org_members SET role = ?, title = ?, branch_id = ? WHERE id = ?').run(role, b.title === undefined ? target.title : A.text(b.title, 80), branch, target.id);
  await W.audit(req, 'member', uid, 'update', { role: target.role, title: target.title, branchId: target.branch_id }, { role, title: b.title === undefined ? target.title : A.text(b.title, 80), branchId: branch });
  res.json({ ok: true });
});

orgRouter.delete('/members/:userId', async (req, res) => {
  const uid = A.id(req.params.userId);
  const target = await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!target) throw new HttpError(404, 'Personne introuvable.');
  if (target.role === 'owner') throw new HttpError(403, 'Le propriétaire ne peut pas quitter son organisation (supprimez-la à la place).');
  if (uid !== req.user.id) {
    if (!A.can(req, 'admin')) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
    if (target.role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut retirer un administrateur.');
  }
  await db.transaction(async () => {
    await db.prepare('UPDATE tasks SET assignee_id = NULL WHERE org_id = ? AND assignee_id = ?').run(req.org.id, uid);
    await db.prepare('UPDATE tickets SET assignee_id = NULL WHERE org_id = ? AND assignee_id = ?').run(req.org.id, uid);
    await db.prepare('UPDATE positions SET holder_id = NULL WHERE org_id = ? AND holder_id = ?').run(req.org.id, uid);
    await db.prepare('DELETE FROM ent_assignments WHERE org_id = ? AND person_id IN (SELECT id FROM ent_people WHERE user_id = ?)').run(req.org.id, uid); // plus aucun poste ni droit lié à la structure dans cette organisation
    await db.prepare('DELETE FROM org_members WHERE id = ?').run(target.id);
  })();
  await W.audit(req, 'member', uid, 'remove', { role: target.role }, null);
  await A.logActivity(req.org.id, req.user.id, 'team', uid === req.user.id ? `${req.user.name} a quitté l'équipe` : 'Une personne a été retirée de l\'équipe');
  res.json({ ok: true });
});

// ---------- Invitations (code à usage unique) ----------
orgRouter.get('/invites', A.need('admin'), async (req, res) => {
  res.json({ invites: await db.prepare('SELECT code, role, title, branch_id AS branchId, expires_at AS expiresAt FROM invites WHERE org_id = ? AND expires_at > ? ORDER BY id DESC').all(req.org.id, nowISO()) });
});

orgRouter.post('/invites', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const role = A.oneOf(b.role, ['member', 'manager', 'admin'], 'member', 'Rôle inconnu.');
  if (role === 'admin' && !A.can(req, 'owner')) throw new HttpError(403, 'Seul le propriétaire peut inviter un administrateur.');
  const branch = await A.branchOf(req, b.branchId);
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  const days = Math.min(Math.max(Number(b.days) || 7, 1), 30);
  await db.prepare('INSERT INTO invites (org_id, code, role, title, branch_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, code, role, A.text(b.title, 80), branch, req.user.id, new Date(Date.now() + days * 86400000).toISOString(), nowISO());
  res.status(201).json({ code });
});

orgRouter.delete('/invites/:code', A.need('admin'), async (req, res) => {
  await db.prepare('DELETE FROM invites WHERE org_id = ? AND code = ?').run(req.org.id, String(req.params.code).slice(0, 40).toUpperCase());
  res.json({ ok: true });
});

orgRouter.get('/activity', async (req, res) => {
  const rows = await db.prepare(`SELECT a.module, a.text, a.created_at AS at, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT 30`).all(req.org.id);
  res.json({ activity: rows });
});

// ---------- Sous-applications ----------
// Espaces par rôle : routes de gestion, puis garde appliquée à TOUTES les routes de sous-applications ci-dessous (sans effet tant que le réglage est désactivé).
orgRouter.use('/spaces', require('./spaces').router);
orgRouter.use('/entreprise', require('./entreprise').router); // compte d'entreprise : structure, postes, personnes, affectations (droits vérifiés dans le routeur)
orgRouter.use(require('./spaces').guard);
// Vague 3 : routes plus précises déclarées AVANT celles des sous-applications existantes (qui gardent leur comportement).
for (const [p, f] of [['', 'team-w3'], ['/hr', 'hr-w3'], ['/projects', 'projects-ro'], ['/projects', 'projects-fin'], ['/production/flows', 'production-flows'], ['/production/adv', 'production-adv-router'], ['/projects', 'projects-pro'], ['/projects', 'projects-w6'], ['/projects', 'projects-w3'], ['/legal', 'legal-w3'], ['/support', 'support-w3'], ['/marketing', 'marketing-w3'], ['/dashboard', 'dashboard-w3'], ['/data', 'data-w3'], ['/agents', 'agents-w3']]) orgRouter.use(p || '/', require('./' + f));
orgRouter.use('/dashboard', require('./dashboard'));
orgRouter.use('/decisions', require('./decisions'));
orgRouter.use('/support', require('./support'));
orgRouter.use('/projects', require('./projects'));
orgRouter.use('/share', require('./share'));
orgRouter.use('/budget', require('./budget'));
orgRouter.use('/stock/wms', require('./wms').router);
orgRouter.use('/stock', require('./stock'));
orgRouter.use('/crm', require('./crm'));
orgRouter.use('/parties', require('./parties')); // clients et fournisseurs typés (simple, temporaire, permanent, haut de gamme) : étend customers et suppliers
orgRouter.use('/brand', require('./brand')); // marque de l'entreprise : nom, assistant, logo, couleur, menu, tableau de bord, vocabulaire
orgRouter.use('/geo', require('./org-geo')); // position de l'entreprise, partagée volontairement avec l'administration de la plateforme
orgRouter.use('/mail', require('./mail'));
orgRouter.use('/sales', require('./sales').router);
orgRouter.use('/sales-mine', require('./sales').mine);
orgRouter.use('/commercial', require('./commercial').router);
orgRouter.use('/aifollow', require('./ai-follow').router);
orgRouter.use('/wa-scope', require('./wa-scope').router); // portée des réponses automatiques WhatsApp
orgRouter.use('/hr', require('./hr'));
orgRouter.use('/talents', require('./rh-talents')); // RH Talents : droits propres (rôles RH désignés), accessible aux membres pour ce qui les concerne
orgRouter.use('/accounting', require('./accounting'));
orgRouter.use('/treasury', require('./treasury'));
orgRouter.use('/library', require('./library').router);
orgRouter.use('/history', require('./history'));
orgRouter.use('/feedback', require('./feedback').router); // avis et recommandations (bouton discret, tables fb_)
orgRouter.use('/purchasing', require('./purchasing').router);
orgRouter.use('/meetings', require('./meetings').router);
orgRouter.use('/chat', require('./chat').router); // chat interne (tables chat_) : conversations, groupes, fichiers, appels, assistante
orgRouter.use('/integrations', require('./integrations'));
for (const id of ['payroll', 'fiscal', 'marketing', 'logistics', 'production', 'construction', 'maintenance', 'legal', 'memory', 'agents']) orgRouter.use('/' + id, require('./' + id));
orgRouter.use('/structure', require('./structure'));
orgRouter.use('/profile', require('./profile').router);
orgRouter.use('/administration', require('./administration').router); // module Administration (tables adm_)
orgRouter.use('/ai', require('./ai').router);

module.exports = { router, pub };
