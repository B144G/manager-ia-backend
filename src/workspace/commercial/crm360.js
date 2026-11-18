'use strict';
// CRM : rôles commerciaux, zones, comptes (entreprises et particuliers, = table customers du module « Clients et ventes »), contacts, historique à 360°,
// tâches et rappels, notes, pièces jointes, activités, détection et fusion des doublons. Rien n'est dupliqué : un compte EST une fiche client existante.
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const W = require('../w3');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const { HttpError, oneLine, amap } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;
const MERGE_TABLES = ['documents', 'chats', 'appointments', 'tickets', 'wms_vas_rules', 'fu_items', 'cp_contacts', 'cp_leads', 'cp_opps', 'cp_activities', 'cp_notes', 'cp_attachments', 'cp_tasks', 'cp_cadence_runs']; // les étapes suivantes y ajoutent leurs tables

// ---------- Moi, rôles, équipes, zones ----------
router.get('/me', async (req, res) => {
  const c = await P.load(req);
  res.json({ role: c.crole, roleLabel: P.LABEL[c.crole], perms: c.perms, boss: c.boss, scopeOwn: c.scopeOwn, teamId: c.teamId, zones: c.zones, userId: req.user.id });
});

router.get('/roles', P.need('view'), async (req, res) => {
  const rows = await db.prepare('SELECT m.user_id, m.role AS org_role, m.title, u.name, r.role, r.team_id, r.zone_ids FROM org_members m JOIN users u ON u.id = m.user_id LEFT JOIN cp_roles r ON r.org_id = m.org_id AND r.user_id = m.user_id WHERE m.org_id = ? ORDER BY m.id').all(req.org.id);
  res.json({
    roles: Object.keys(P.LABEL).filter((k) => k !== 'none' && k !== 'viewer').map((k) => ({ id: k, label: P.LABEL[k] })),
    members: rows.map((m) => {
      const boss = A.RANK[m.org_role] >= A.RANK.admin;
      let zoneIds = []; try { zoneIds = JSON.parse(m.zone_ids || '[]'); } catch { zoneIds = []; }
      return { userId: Number(m.user_id), name: m.name, title: m.title, orgRole: m.org_role, crole: boss ? 'sales_manager' : m.role || null, roleLabel: P.LABEL[boss ? 'sales_manager' : m.role || 'none'], implicit: boss, teamId: m.team_id ? Number(m.team_id) : null, zoneIds };
    }),
  });
});
router.put('/roles/:userId', async (req, res) => {
  const c = await P.load(req);
  if (!c.perms.includes('roles') && !c.perms.includes('roles_light')) throw new HttpError(403, 'Votre rôle commercial ne permet pas cette action.');
  const uid = A.id(req.params.userId);
  const target = await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!target) throw new HttpError(404, 'Personne introuvable.');
  if (A.RANK[target.role] >= A.RANK.admin) throw new HttpError(400, "Le propriétaire et les administrateurs ont déjà tous les droits commerciaux : aucun rôle à leur désigner.");
  const b = req.body || {};
  const role = A.oneOf(b.role, [...P.CROLES, 'none'], undefined, 'Rôle commercial inconnu.');
  const cur = await db.prepare('SELECT * FROM cp_roles WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!c.perms.includes('roles') && (role === 'sales_manager' || (cur && cur.role === 'sales_manager'))) throw new HttpError(403, 'Seul le responsable du compte (propriétaire ou administrateur) désigne ou retire un responsable commercial.');
  if (uid === req.user.id && !c.boss) throw new HttpError(403, 'Vous ne pouvez pas modifier votre propre rôle commercial.');
  if (role === 'none') {
    await db.prepare('DELETE FROM cp_roles WHERE org_id = ? AND user_id = ?').run(req.org.id, uid);
  } else {
    const teamId = b.teamId ? A.id(b.teamId) : null;
    if (teamId && !await db.prepare('SELECT 1 FROM cp_teams WHERE id = ? AND org_id = ?').get(teamId, req.org.id)) throw new HttpError(400, 'Équipe inconnue.');
    const zoneIds = (Array.isArray(b.zoneIds) ? b.zoneIds : cur ? JSON.parse(cur.zone_ids || '[]') : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
    for (const z of zoneIds) if (!await db.prepare('SELECT 1 FROM cp_zones WHERE id = ? AND org_id = ?').get(z, req.org.id)) throw new HttpError(400, 'Zone inconnue.');
    await db.prepare(`INSERT INTO cp_roles (org_id, user_id, role, team_id, zone_ids, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role, team_id = excluded.team_id, zone_ids = excluded.zone_ids`).run(req.org.id, uid, role, b.teamId === undefined && cur ? cur.team_id : teamId, JSON.stringify(zoneIds), req.user.id, nowISO());
  }
  await P.audit(req, 'role', uid, 'set', { from: cur ? cur.role : null, to: role });
  await W.audit(req, 'cp_role', uid, 'update', { role: cur ? cur.role : null }, { role });
  if (role !== 'none') await W.push(req.org.id, uid, 'commercial', `Vous êtes désigné(e) « ${P.LABEL[role]} » dans le module Commercial.`, 'commercial');
  res.json({ ok: true });
});

router.get('/zones', P.need('view'), async (req, res) => res.json({ zones: (await db.prepare('SELECT * FROM cp_zones WHERE org_id = ? ORDER BY name').all(req.org.id)).map((z) => ({ id: Number(z.id), name: z.name, cities: z.cities })) }));
router.post('/zones', P.need('rules'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO cp_zones (org_id, name, cities, created_at) VALUES (?, ?, ?, ?)').run(req.org.id, A.text(b.name, 80, { required: true, msg: 'Indiquez le nom de la zone.' }), A.text(b.cities, 400), nowISO())).lastInsertRowid;
  await P.audit(req, 'zone', id, 'create', b.name);
  res.status(201).json({ id: Number(id) });
});
router.put('/zones/:id', P.need('rules'), async (req, res) => {
  const z = await db.prepare('SELECT * FROM cp_zones WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!z) throw new HttpError(404, 'Zone introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE cp_zones SET name = ?, cities = ? WHERE id = ?').run(A.text(b.name, 80) || z.name, b.cities === undefined ? z.cities : A.text(b.cities, 400), z.id);
  await P.audit(req, 'zone', z.id, 'update', b);
  res.json({ ok: true });
});
router.delete('/zones/:id', P.need('rules'), async (req, res) => {
  const r = await db.prepare('DELETE FROM cp_zones WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Zone introuvable.');
  await P.audit(req, 'zone', req.params.id, 'delete', '');
  res.json({ ok: true });
});
router.get('/teams', P.need('view'), async (req, res) => {
  const rows = await db.prepare('SELECT t.*, (SELECT COUNT(*) FROM cp_roles r WHERE r.team_id = t.id) AS members FROM cp_teams t WHERE t.org_id = ? ORDER BY t.name').all(req.org.id);
  res.json({ teams: rows.map((t) => ({ id: Number(t.id), name: t.name, leaderId: t.leader_id ? Number(t.leader_id) : null, members: N(t.members) })) });
});
router.post('/teams', P.need('rules'), async (req, res) => {
  const b = req.body || {};
  const leader = b.leaderId ? await A.memberOf(req, b.leaderId) : null;
  const id = (await db.prepare('INSERT INTO cp_teams (org_id, name, leader_id, created_at) VALUES (?, ?, ?, ?)').run(req.org.id, A.text(b.name, 80, { required: true, msg: "Indiquez le nom de l'équipe." }), leader, nowISO())).lastInsertRowid;
  await P.audit(req, 'team', id, 'create', b.name);
  res.status(201).json({ id: Number(id) });
});
router.put('/teams/:id', P.need('rules'), async (req, res) => {
  const t = await db.prepare('SELECT * FROM cp_teams WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t) throw new HttpError(404, 'Équipe introuvable.');
  const b = req.body || {};
  const leader = b.leaderId === undefined ? t.leader_id : await A.memberOf(req, b.leaderId);
  await db.prepare('UPDATE cp_teams SET name = ?, leader_id = ? WHERE id = ?').run(A.text(b.name, 80) || t.name, leader, t.id);
  res.json({ ok: true });
});
router.delete('/teams/:id', P.need('rules'), async (req, res) => {
  const r = await db.prepare('DELETE FROM cp_teams WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Équipe introuvable.');
  res.json({ ok: true });
});
router.get('/audit', P.need('rules'), async (req, res) => {
  const names = await B.names(req.org.id);
  const rows = await db.prepare('SELECT * FROM cp_audit WHERE org_id = ? ORDER BY id DESC LIMIT ?').all(req.org.id, B.pageLimit(req.query.limit, 100, 300));
  res.json({ events: rows.map((r) => ({ id: Number(r.id), at: r.created_at, userId: r.user_id ? Number(r.user_id) : null, user: names.get(Number(r.user_id)) || '', crole: r.crole, roleLabel: P.LABEL[r.crole] || r.crole, entity: r.entity, entityId: r.entity_id ? Number(r.entity_id) : null, action: r.action, detail: r.detail })) });
});
router.get('/settings', P.need('view'), async (req, res) => res.json({ settings: await B.settings(req.org.id), defaults: L.DEFAULTS }));
router.put('/settings', P.need('rules'), async (req, res) => {
  const s = await B.saveSettings(req.org.id, req.body);
  await P.audit(req, 'settings', null, 'update', req.body);
  res.json({ settings: s });
});

// ---------- Comptes ----------
const KINDS = ['company', 'person'];
const POTENTIALS = ['', 'high', 'medium', 'low'];
const cleanAccount = async (req, b, cur = {}) => {
  const pick = (k, max) => (b[k] === undefined ? cur[k] || '' : A.text(b[k], max));
  const owner = b.ownerId === undefined ? cur.owner_id || null : b.ownerId === null || b.ownerId === '' ? null : await A.memberOf(req, b.ownerId);
  let zone = b.zoneId === undefined ? cur.zone_id || null : b.zoneId ? A.id(b.zoneId) : null;
  if (zone && !await db.prepare('SELECT 1 FROM cp_zones WHERE id = ? AND org_id = ?').get(zone, req.org.id)) throw new HttpError(400, 'Zone inconnue.');
  return {
    name: b.name === undefined ? cur.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du compte.' }),
    account_kind: b.kind === undefined ? cur.account_kind || 'company' : A.oneOf(b.kind, KINDS, undefined, "Type de compte inconnu (entreprise ou particulier)."),
    phone: pick('phone', 40), email: pick('email', 120), sector: pick('sector', 80), city: pick('city', 80), address: pick('address', 300), niu: pick('niu', 40), notes: pick('notes', 800),
    potential: b.potential === undefined ? cur.potential || '' : A.oneOf(b.potential, POTENTIALS, undefined, 'Potentiel inconnu.'),
    stage: b.stage === undefined ? cur.stage || 'client' : A.oneOf(b.stage, ['prospect', 'client'], undefined, 'Statut inconnu (prospect ou client).'),
    source: pick('source', 60), owner_id: owner, zone_id: zone,
  };
};
const salesOf = async (orgId) => {
  const rows = await db.prepare(`SELECT customer_id, COUNT(*) n, SUM(total - credited) rev, MAX(issued) last FROM documents WHERE org_id = ? AND kind = 'invoice' AND status IN ('sent','paid') GROUP BY customer_id`).all(orgId);
  return new Map(rows.map((r) => [Number(r.customer_id), { invoices: N(r.n), revenue: N(r.rev), last: r.last }]));
};
const accountView = (c, s, extra = {}) => ({
  id: Number(c.id), name: c.name, kind: c.account_kind, phone: c.phone, email: c.email, sector: c.sector, city: c.city, address: c.address, niu: c.niu, notes: c.notes, stage: c.stage, source: c.source,
  ownerId: c.owner_id ? Number(c.owner_id) : null, zoneId: c.zone_id ? Number(c.zone_id) : null, potential: c.potential, branchId: c.branch_id ? Number(c.branch_id) : null, createdAt: c.created_at,
  revenue: (s && s.revenue) || 0, invoices: (s && s.invoices) || 0, lastPurchase: (s && s.last) || null, ...extra,
});
const accountOf = async (req, id) => {
  const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!c || !A.visible(req, c)) throw new HttpError(404, 'Compte introuvable.');
  return c;
};

router.get('/accounts', P.need('view'), async (req, res) => {
  const sc = A.scope(req, 'c.branch_id'); const ow = await P.own(req, 'c.owner_id');
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = await db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM cp_opps o WHERE o.customer_id = c.id AND o.status = 'open') AS open_opps, (SELECT COUNT(*) FROM cp_tasks t WHERE t.customer_id = c.id AND t.status = 'open') AS open_tasks FROM customers c WHERE c.org_id = ?${sc.sql}${ow.sql} ORDER BY c.name`).all(req.org.id, ...sc.args, ...ow.args);
  const sales = await salesOf(req.org.id); const names = await B.names(req.org.id);
  let list = rows.map((c) => accountView(c, sales.get(Number(c.id)), { openOpps: N(c.open_opps), openTasks: N(c.open_tasks), owner: names.get(Number(c.owner_id)) || '' }));
  for (const k of ['kind', 'stage', 'city', 'sector', 'potential']) if (req.query[k]) list = list.filter((a) => String(a[k]).toLowerCase() === String(req.query[k]).toLowerCase());
  if (req.query.ownerId) list = list.filter((a) => a.ownerId === Number(req.query.ownerId));
  if (q) list = list.filter((a) => L.stripAccents(`${a.name} ${a.phone} ${a.email} ${a.city} ${a.sector}`).toLowerCase().includes(L.stripAccents(q)));
  res.json({ total: list.length, accounts: list.slice(0, B.pageLimit(req.query.limit, 200, 500)) });
});

const similar = async (req, c, exceptId) => {
  const rows = (await db.prepare('SELECT id, name, phone, email FROM customers WHERE org_id = ?').all(req.org.id)).filter((r) => Number(r.id) !== exceptId);
  const probe = { id: -1, name: c.name, phone: c.phone, email: c.email };
  const groups = L.duplicateGroups([probe, ...rows]);
  const g = groups.find((x) => x.rows.some((r) => r.id === -1));
  return g ? g.rows.filter((r) => r.id !== -1).map((r) => ({ id: Number(r.id), name: r.name, phone: r.phone, email: r.email })) : [];
};

router.post('/accounts', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const c = await cleanAccount(req, b);
  const cp = await P.load(req);
  if (cp.scopeOwn) c.owner_id = req.user.id; // un commercial terrain suit les comptes qu'il crée
  if (!b.force) {
    const dup = await similar(req, c, 0);
    if (dup.length) return res.status(409).json({ error: 'Des fiches semblables existent déjà : vérifiez avant de créer un doublon.', duplicates: dup });
  }
  const branch = await A.branchOf(req, b.branchId === undefined ? req.member.branch_id : b.branchId);
  const id = (await db.prepare(`INSERT INTO customers (org_id, branch_id, name, phone, email, notes, niu, address, stage, source, account_kind, sector, city, owner_id, zone_id, potential, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.org.id, branch, c.name, c.phone, c.email, c.notes, c.niu, c.address, c.stage, c.source, c.account_kind, c.sector, c.city, c.owner_id, c.zone_id, c.potential, nowISO())).lastInsertRowid;
  await P.audit(req, 'account', id, 'create', c.name);
  require('../../services/webhooks').emit(req.org.id, 'customer.created', { id: Number(id), name: c.name });
  res.status(201).json({ id: Number(id) });
});

router.put('/accounts/:id', P.need('write'), async (req, res) => {
  const cur = await accountOf(req, req.params.id);
  await P.mustOwn(req, cur);
  const c = await cleanAccount(req, req.body || {}, cur);
  if (c.owner_id !== cur.owner_id && !(await P.has(req, 'rules'))) { if ((await P.load(req)).scopeOwn || cur.owner_id) throw new HttpError(403, "Seul le responsable commercial change le commercial qui suit un compte."); }
  await db.prepare('UPDATE customers SET name = ?, phone = ?, email = ?, notes = ?, niu = ?, address = ?, stage = ?, source = ?, account_kind = ?, sector = ?, city = ?, owner_id = ?, zone_id = ?, potential = ? WHERE id = ?')
    .run(c.name, c.phone, c.email, c.notes, c.niu, c.address, c.stage, c.source, c.account_kind, c.sector, c.city, c.owner_id, c.zone_id, c.potential, cur.id);
  if (c.owner_id !== cur.owner_id) await P.audit(req, 'account', cur.id, 'owner', { from: cur.owner_id, to: c.owner_id });
  else await P.audit(req, 'account', cur.id, 'update', Object.keys(req.body || {}).join(','));
  res.json({ ok: true });
});

router.get('/accounts/:id', P.need('view'), async (req, res) => {
  const c = await accountOf(req, req.params.id);
  await P.mustOwn(req, c);
  const sales = (await salesOf(req.org.id)).get(Number(c.id));
  const names = await B.names(req.org.id);
  const owed = N((await db.prepare("SELECT COALESCE(SUM(total - credited - paid), 0) s FROM documents WHERE customer_id = ? AND kind = 'invoice' AND status = 'sent'").get(c.id)).s);
  const contacts = (await db.prepare('SELECT * FROM cp_contacts WHERE customer_id = ? ORDER BY is_primary DESC, id').all(c.id)).map(contactView);
  const opps = await db.prepare(`SELECT o.id, o.name, o.amount, o.status, o.probability, s.name AS stage, s.probability AS stage_prob FROM cp_opps o JOIN cp_stages s ON s.id = o.stage_id WHERE o.customer_id = ? ORDER BY o.id DESC LIMIT 30`).all(c.id);
  res.json({
    account: accountView(c, sales, { owner: names.get(Number(c.owner_id)) || '', owed, defaultDiscount: Number(c.default_discount) || 0, followupOptout: Boolean(Number(c.followup_optout)) }),
    contacts, opportunities: opps.map((o) => ({ id: Number(o.id), name: o.name, amount: N(o.amount), status: o.status, stage: o.stage, probability: o.probability === null ? N(o.stage_prob) : N(o.probability) })),
  });
});
router.delete('/accounts/:id', P.need('delete'), async (req, res) => {
  const c = await accountOf(req, req.params.id);
  const issued = N((await db.prepare("SELECT COUNT(*) c FROM documents WHERE customer_id = ? AND kind IN ('invoice','credit') AND status <> 'draft'").get(c.id)).c);
  if (issued) throw new HttpError(409, `Ce compte a ${issued} facture(s) ou avoir(s) émis : ils doivent être conservés. Fusionnez ou modifiez la fiche plutôt que de la supprimer.`);
  await db.transaction(async () => { await db.prepare('DELETE FROM documents WHERE customer_id = ?').run(c.id); await db.prepare('DELETE FROM customers WHERE id = ?').run(c.id); })();
  await P.audit(req, 'account', c.id, 'delete', c.name);
  res.json({ ok: true });
});

// ---------- Contacts ----------
const contactView = (c) => ({ id: Number(c.id), customerId: Number(c.customer_id), name: c.name, jobTitle: c.job_title, phone: c.phone, email: c.email, isPrimary: Boolean(Number(c.is_primary)), isDecider: Boolean(Number(c.is_decider)), notes: c.notes });
router.get('/accounts/:id/contacts', P.need('view'), async (req, res) => { const c = await accountOf(req, req.params.id); await P.mustOwn(req, c); res.json({ contacts: (await db.prepare('SELECT * FROM cp_contacts WHERE customer_id = ? ORDER BY is_primary DESC, id').all(c.id)).map(contactView) }); });
router.post('/accounts/:id/contacts', P.need('write'), async (req, res) => {
  const c = await accountOf(req, req.params.id); await P.mustOwn(req, c);
  const b = req.body || {};
  const id = await db.transaction(async () => {
    if (b.isPrimary) await db.prepare('UPDATE cp_contacts SET is_primary = 0 WHERE customer_id = ?').run(c.id);
    return (await db.prepare('INSERT INTO cp_contacts (org_id, customer_id, name, job_title, phone, email, is_primary, is_decider, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, c.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du contact.' }), A.text(b.jobTitle, 100), A.text(b.phone, 40), A.text(b.email, 120), b.isPrimary ? 1 : 0, b.isDecider ? 1 : 0, A.text(b.notes, 500), nowISO())).lastInsertRowid;
  })();
  res.status(201).json({ id: Number(id) });
});
router.put('/contacts/:id', P.need('write'), async (req, res) => {
  const k = await db.prepare('SELECT * FROM cp_contacts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!k) throw new HttpError(404, 'Contact introuvable.');
  await P.mustOwn(req, await accountOf(req, k.customer_id));
  const b = req.body || {};
  await db.transaction(async () => {
    if (b.isPrimary) await db.prepare('UPDATE cp_contacts SET is_primary = 0 WHERE customer_id = ?').run(k.customer_id);
    await db.prepare('UPDATE cp_contacts SET name = ?, job_title = ?, phone = ?, email = ?, is_primary = ?, is_decider = ?, notes = ? WHERE id = ?')
      .run(A.text(b.name, 100) || k.name, b.jobTitle === undefined ? k.job_title : A.text(b.jobTitle, 100), b.phone === undefined ? k.phone : A.text(b.phone, 40), b.email === undefined ? k.email : A.text(b.email, 120),
        b.isPrimary === undefined ? k.is_primary : b.isPrimary ? 1 : 0, b.isDecider === undefined ? k.is_decider : b.isDecider ? 1 : 0, b.notes === undefined ? k.notes : A.text(b.notes, 500), k.id);
  })();
  res.json({ ok: true });
});
router.delete('/contacts/:id', P.need('write'), async (req, res) => {
  const k = await db.prepare('SELECT * FROM cp_contacts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!k) throw new HttpError(404, 'Contact introuvable.');
  await P.mustOwn(req, await accountOf(req, k.customer_id));
  await db.prepare('DELETE FROM cp_contacts WHERE id = ?').run(k.id);
  res.json({ ok: true });
});

// ---------- Historique à 360° ----------
router.get('/accounts/:id/timeline', P.need('view'), async (req, res) => {
  const c = await accountOf(req, req.params.id);
  await P.mustOwn(req, c);
  const names = await B.names(req.org.id);
  const ev = [];
  const push = (type, at, title, extra = {}) => ev.push({ type, at: at || '', title, ...extra });
  for (const m of await db.prepare(`SELECT m.id, m.role, m.content, m.created_at, ch.channel FROM chat_messages m JOIN chats ch ON ch.id = m.chat_id WHERE ch.customer_id = ? AND ch.org_id = ? ORDER BY m.id DESC LIMIT 40`).all(c.id, req.org.id))
    push('message', m.created_at, oneLine(m.content, 160), { role: m.role, channel: m.channel });
  for (const a of await db.prepare('SELECT * FROM cp_activities WHERE customer_id = ? ORDER BY happened_at DESC LIMIT 50').all(c.id)) push(a.kind, a.happened_at, oneLine(a.note || a.outcome, 160), { outcome: a.outcome, durationMin: N(a.duration_min), by: names.get(Number(a.user_id)) || '', ref: Number(a.id) });
  for (const a of await db.prepare('SELECT * FROM appointments WHERE customer_id = ? ORDER BY date DESC LIMIT 20').all(c.id)) push('appointment', `${a.date}T${a.time || '00:00'}`, oneLine(a.purpose || 'Rendez-vous', 120), { status: a.status, place: a.place, ref: Number(a.id) });
  for (const d of await db.prepare('SELECT id, kind, number, status, total, paid, credited, issued FROM documents WHERE customer_id = ? ORDER BY id DESC LIMIT 60').all(c.id)) push(d.kind, `${d.issued}T00:00:00.000Z`, d.number, { status: d.status, amount: N(d.total), paid: N(d.paid), ref: Number(d.id) });
  for (const p of await db.prepare("SELECT p.id, p.amount, p.date, p.method, d.number FROM doc_payments p JOIN documents d ON d.id = p.doc_id WHERE d.customer_id = ? AND p.status = 'confirmed' ORDER BY p.id DESC LIMIT 40").all(c.id)) push('payment', `${p.date}T00:00:00.000Z`, p.number, { amount: N(p.amount), method: p.method, ref: Number(p.id) });
  for (const t of await db.prepare('SELECT id, subject, status, created_at FROM tickets WHERE org_id = ? AND (customer_id = ?) ORDER BY id DESC LIMIT 20').all(req.org.id, c.id)) push('ticket', t.created_at, oneLine(t.subject, 140), { status: t.status, ref: Number(t.id) });
  for (const n of await db.prepare('SELECT * FROM cp_notes WHERE customer_id = ? ORDER BY id DESC LIMIT 40').all(c.id)) push('note', n.created_at, oneLine(n.body, 300), { by: names.get(Number(n.user_id)) || '', ref: Number(n.id) });
  for (const t of await db.prepare('SELECT * FROM cp_tasks WHERE customer_id = ? ORDER BY id DESC LIMIT 30').all(c.id)) push('task', t.due_at || t.created_at, t.title, { status: t.status, by: names.get(Number(t.assignee_id)) || '', ref: Number(t.id) });
  for (const o of await db.prepare('SELECT id, name, amount, status, created_at FROM cp_opps WHERE customer_id = ? ORDER BY id DESC LIMIT 20').all(c.id)) push('opportunity', o.created_at, o.name, { status: o.status, amount: N(o.amount), ref: Number(o.id) });
  for (const f of await db.prepare('SELECT id, name, size, created_at FROM cp_attachments WHERE customer_id = ? ORDER BY id DESC LIMIT 20').all(c.id)) push('attachment', f.created_at, f.name, { size: N(f.size), ref: Number(f.id) });
  ev.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const counts = {}; for (const e of ev) counts[e.type] = (counts[e.type] || 0) + 1;
  res.json({ events: ev.slice(0, B.pageLimit(req.query.limit, 150, 400)), counts });
});

// ---------- Activités, notes, tâches, pièces jointes ----------
const REF_COLS = { customerId: ['customer_id', 'customers'], leadId: ['lead_id', 'cp_leads'], oppId: ['opp_id', 'cp_opps'] };
/** Rattache une saisie à (au plus) un compte, un prospect ou une opportunité DE CETTE ORGANISATION. */
async function refsOf(req, b) {
  const out = { customer_id: null, lead_id: null, opp_id: null };
  for (const [k, [col, table]] of Object.entries(REF_COLS)) {
    if (b[k] === undefined || b[k] === null || b[k] === '') continue;
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`).get(A.id(b[k]), req.org.id);
    if (!row || (table === 'customers' && !A.visible(req, row))) throw new HttpError(404, 'Fiche introuvable.');
    if (table !== 'customers') await P.mustOwn(req, row); else await P.mustOwn(req, row);
    out[col] = Number(row.id);
    if (table === 'cp_opps' && !out.customer_id && row.customer_id) out.customer_id = Number(row.customer_id);
  }
  if (!out.customer_id && !out.lead_id && !out.opp_id) throw new HttpError(400, 'Rattachez la saisie à un compte, un prospect ou une opportunité.');
  return out;
}
const ACT_KINDS = ['call', 'visit', 'meeting', 'message', 'email'];
router.get('/activities', P.need('view'), async (req, res) => {
  const ref = req.query.customerId ? ['customer_id', req.query.customerId] : req.query.leadId ? ['lead_id', req.query.leadId] : req.query.oppId ? ['opp_id', req.query.oppId] : null;
  const { from, to } = B.range(ref ? { ...req.query, from: req.query.from || '2000-01-01' } : req.query);
  const ow = await P.own(req, 'a.user_id');
  const names = await B.names(req.org.id);
  const rows = await db.prepare(`SELECT a.*, c.name AS customer, l.name AS lead FROM cp_activities a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN cp_leads l ON l.id = a.lead_id WHERE a.org_id = ? AND a.happened_at >= ? AND a.happened_at < ?${ow.sql}${req.query.userId ? ' AND a.user_id = ?' : ''}${ref ? ` AND a.${ref[0]} = ?` : ''} ORDER BY a.happened_at DESC LIMIT 300`)
    .all(req.org.id, `${from}T00:00:00`, `${L.addDays(to, 1)}T00:00:00`, ...ow.args, ...(req.query.userId ? [A.id(req.query.userId)] : []), ...(ref ? [A.id(ref[1])] : []));
  res.json({ activities: rows.map((a) => ({ id: Number(a.id), kind: a.kind, customerId: a.customer_id ? Number(a.customer_id) : null, customer: a.customer || '', leadId: a.lead_id ? Number(a.lead_id) : null, lead: a.lead || '', oppId: a.opp_id ? Number(a.opp_id) : null, userId: Number(a.user_id), user: names.get(Number(a.user_id)) || '', outcome: a.outcome, durationMin: N(a.duration_min), note: a.note, at: a.happened_at })) });
});
router.post('/activities', P.need('activity'), async (req, res) => {
  const b = req.body || {};
  const refs = await refsOf(req, b);
  const kind = A.oneOf(b.kind, ACT_KINDS, undefined, "Type d'activité inconnu (appel, visite, rendez-vous, message, e-mail).");
  const at = b.happenedAt ? new Date(b.happenedAt) : new Date();
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'Date invalide.');
  const dur = Math.min(Math.max(Math.round(Number(b.durationMin) || 0), 0), 600);
  const id = (await db.prepare('INSERT INTO cp_activities (org_id, kind, customer_id, lead_id, opp_id, user_id, outcome, duration_min, note, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, kind, refs.customer_id, refs.lead_id, refs.opp_id, req.user.id, A.text(b.outcome, 120), dur, A.text(b.note, 1000), at.toISOString(), nowISO())).lastInsertRowid;
  if (refs.lead_id) await db.prepare("UPDATE cp_leads SET last_contact_at = ?, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = ? WHERE id = ?").run(at.toISOString(), nowISO(), refs.lead_id);
  res.status(201).json({ id: Number(id) });
});
router.post('/notes', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const refs = await refsOf(req, b);
  const id = (await db.prepare('INSERT INTO cp_notes (org_id, customer_id, lead_id, opp_id, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, refs.customer_id, refs.lead_id, refs.opp_id, A.text(b.body, 2000, { required: true, msg: 'Écrivez la note.' }), req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.get('/notes', P.need('view'), async (req, res) => {
  const names = await B.names(req.org.id);
  const col = req.query.oppId ? 'opp_id' : req.query.leadId ? 'lead_id' : 'customer_id';
  const v = A.id(req.query.oppId || req.query.leadId || req.query.customerId);
  res.json({ notes: (await db.prepare(`SELECT * FROM cp_notes WHERE org_id = ? AND ${col} = ? ORDER BY id DESC LIMIT 100`).all(req.org.id, v)).map((n) => ({ id: Number(n.id), body: n.body, by: names.get(Number(n.user_id)) || '', at: n.created_at })) });
});
router.delete('/notes/:id', P.need('write'), async (req, res) => {
  const n = await db.prepare('SELECT * FROM cp_notes WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!n) throw new HttpError(404, 'Note introuvable.');
  if (Number(n.user_id) !== req.user.id && !(await P.has(req, 'delete'))) throw new HttpError(403, 'Vous ne pouvez supprimer que vos propres notes.');
  await db.prepare('DELETE FROM cp_notes WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

const taskView = (t, names, extra = {}) => ({ id: Number(t.id), title: t.title, kind: t.kind, dueAt: t.due_at, status: t.status, assigneeId: t.assignee_id ? Number(t.assignee_id) : null, assignee: names.get(Number(t.assignee_id)) || '', customerId: t.customer_id ? Number(t.customer_id) : null, leadId: t.lead_id ? Number(t.lead_id) : null, oppId: t.opp_id ? Number(t.opp_id) : null, doneAt: t.done_at, overdue: t.status === 'open' && Boolean(t.due_at) && t.due_at < nowISO(), ...extra });
router.get('/tasks', P.need('view'), async (req, res) => {
  const names = await B.names(req.org.id);
  const cp = await P.load(req);
  const conds = ['t.org_id = ?']; const args = [req.org.id];
  if (cp.scopeOwn || req.query.mine) { conds.push('(t.assignee_id = ? OR t.created_by = ?)'); args.push(req.user.id, req.user.id); }
  if (req.query.status) { conds.push('t.status = ?'); args.push(A.oneOf(req.query.status, ['open', 'done'])); }
  if (req.query.customerId) { conds.push('t.customer_id = ?'); args.push(A.id(req.query.customerId)); }
  if (req.query.oppId) { conds.push('t.opp_id = ?'); args.push(A.id(req.query.oppId)); }
  if (req.query.leadId) { conds.push('t.lead_id = ?'); args.push(A.id(req.query.leadId)); }
  const rows = await db.prepare(`SELECT t.*, c.name AS customer FROM cp_tasks t LEFT JOIN customers c ON c.id = t.customer_id WHERE ${conds.join(' AND ')} ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.due_at IS NULL, t.due_at LIMIT 300`).all(...args);
  const now = nowISO();
  res.json({ tasks: rows.map((t) => taskView(t, names, { customer: t.customer || '' })), overdue: rows.filter((t) => t.status === 'open' && t.due_at && t.due_at < now).length });
});
router.post('/tasks', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const refs = { customer_id: null, lead_id: null, opp_id: null };
  if (b.customerId || b.leadId || b.oppId) Object.assign(refs, await refsOf(req, b));
  const due = b.dueAt ? new Date(b.dueAt) : null;
  if (due && Number.isNaN(due.getTime())) throw new HttpError(400, 'Date invalide.');
  const cp = await P.load(req);
  const assignee = cp.scopeOwn ? req.user.id : b.assigneeId ? await A.memberOf(req, b.assigneeId) : req.user.id;
  const id = (await db.prepare('INSERT INTO cp_tasks (org_id, customer_id, lead_id, opp_id, title, kind, due_at, assignee_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, refs.customer_id, refs.lead_id, refs.opp_id, A.text(b.title, 200, { required: true, msg: 'Indiquez ce qu’il faut faire.' }), A.oneOf(b.kind, ['todo', 'call', 'visit', 'message', 'quote', 'reminder'], 'todo'), due ? due.toISOString() : null, assignee, req.user.id, nowISO())).lastInsertRowid;
  if (assignee !== req.user.id) await W.push(req.org.id, assignee, 'commercial', `Nouvelle tâche commerciale : ${A.text(b.title, 120)}`, 'task:' + id);
  res.status(201).json({ id: Number(id) });
});
router.put('/tasks/:id', P.need('write'), async (req, res) => {
  const t = await db.prepare('SELECT * FROM cp_tasks WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t) throw new HttpError(404, 'Tâche introuvable.');
  const cp = await P.load(req);
  if (cp.scopeOwn && Number(t.assignee_id) !== req.user.id && Number(t.created_by) !== req.user.id) throw new HttpError(403, 'Cette tâche est attribuée à un autre commercial.');
  const b = req.body || {};
  const status = b.status === undefined ? t.status : A.oneOf(b.status, ['open', 'done']);
  const due = b.dueAt === undefined ? t.due_at : b.dueAt ? new Date(b.dueAt).toISOString() : null;
  await db.prepare('UPDATE cp_tasks SET title = ?, due_at = ?, status = ?, done_at = ?, assignee_id = ?, notified_at = CASE WHEN ? <> COALESCE(due_at, \'\') THEN NULL ELSE notified_at END WHERE id = ?')
    .run(A.text(b.title, 200) || t.title, due, status, status === 'done' ? (t.done_at || nowISO()) : null, b.assigneeId && !cp.scopeOwn ? await A.memberOf(req, b.assigneeId) : t.assignee_id, due || '', t.id);
  res.json({ ok: true });
});
router.delete('/tasks/:id', P.need('write'), async (req, res) => {
  const t = await db.prepare('SELECT * FROM cp_tasks WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t) throw new HttpError(404, 'Tâche introuvable.');
  const cp = await P.load(req);
  if (cp.scopeOwn && Number(t.created_by) !== req.user.id) throw new HttpError(403, 'Vous ne pouvez supprimer que vos propres tâches.');
  await db.prepare('DELETE FROM cp_tasks WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

const MIMES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'text/plain': 'txt', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' };
const MAX_FILE = 1400 * 1024;
router.post('/attachments', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const refs = await refsOf(req, b);
  const mime = A.oneOf(b.mime, Object.keys(MIMES), undefined, 'Type de fichier non accepté (PDF, image PNG/JPEG, texte, Word, Excel).');
  const raw = String(b.data || '').replace(/^data:[^,]*,/, '');
  if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new HttpError(400, 'Fichier illisible.');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new HttpError(400, 'Fichier vide.');
  if (buf.length > MAX_FILE) throw new HttpError(413, 'Fichier trop volumineux (1,4 Mo au plus).');
  const name = A.text(b.name, 120, { required: true, msg: 'Donnez un nom au fichier.' }).replace(/[\\/:*?"<>|]+/g, '_');
  const id = (await db.prepare('INSERT INTO cp_attachments (org_id, customer_id, lead_id, opp_id, name, mime, size, data, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, refs.customer_id, refs.lead_id, refs.opp_id, name, mime, buf.length, buf, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.get('/attachments', P.need('view'), async (req, res) => {
  const col = req.query.oppId ? 'opp_id' : req.query.leadId ? 'lead_id' : 'customer_id';
  const v = A.id(req.query.oppId || req.query.leadId || req.query.customerId);
  const names = await B.names(req.org.id);
  res.json({ attachments: (await db.prepare(`SELECT id, name, mime, size, user_id, created_at FROM cp_attachments WHERE org_id = ? AND ${col} = ? ORDER BY id DESC LIMIT 100`).all(req.org.id, v)).map((f) => ({ id: Number(f.id), name: f.name, mime: f.mime, size: N(f.size), by: names.get(Number(f.user_id)) || '', at: f.created_at })) });
});
router.get('/attachments/:id/file', P.need('view'), async (req, res) => {
  const f = await db.prepare('SELECT * FROM cp_attachments WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!f) throw new HttpError(404, 'Fichier introuvable.');
  res.set({ 'Content-Type': f.mime, 'Content-Length': f.data.length, 'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.end(f.data);
});
router.delete('/attachments/:id', P.need('write'), async (req, res) => {
  const f = await db.prepare('SELECT id, user_id FROM cp_attachments WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!f) throw new HttpError(404, 'Fichier introuvable.');
  if (Number(f.user_id) !== req.user.id && !(await P.has(req, 'delete'))) throw new HttpError(403, 'Vous ne pouvez supprimer que vos propres fichiers.');
  await db.prepare('DELETE FROM cp_attachments WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

// ---------- Doublons et fusion ----------
router.get('/duplicates', P.need('merge'), async (req, res) => {
  const sc = A.scope(req, 'branch_id');
  const rows = await db.prepare(`SELECT id, name, phone, email, city, stage FROM customers WHERE org_id = ?${sc.sql}`).all(req.org.id, ...sc.args);
  const sales = await salesOf(req.org.id);
  const groups = L.duplicateGroups(rows.map((r) => ({ ...r, id: Number(r.id) })));
  res.json({ groups: groups.map((g) => ({ reasons: g.reasons, accounts: g.rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, city: r.city, revenue: (sales.get(r.id) || {}).revenue || 0, invoices: (sales.get(r.id) || {}).invoices || 0 })) })) });
});
router.post('/accounts/merge', P.need('merge'), async (req, res) => {
  const b = req.body || {};
  const keepId = A.id(b.keepId, 'Choisissez la fiche à conserver.');
  const ids = [...new Set((Array.isArray(b.mergeIds) ? b.mergeIds : []).map((x) => A.id(x)))].filter((x) => x !== keepId);
  if (!ids.length || ids.length > 10) throw new HttpError(400, 'Choisissez de 1 à 10 fiches à fusionner dans la fiche conservée.');
  const keep = await accountOf(req, keepId);
  const olds = []; for (const i of ids) olds.push(await accountOf(req, i));
  const moved = {};
  await db.transaction(async () => {
    const patch = {};
    for (const o of olds) {
      for (const k of ['phone', 'email', 'niu', 'address', 'sector', 'city', 'source']) if (!(patch[k] || keep[k]) && o[k]) patch[k] = o[k];
      if (!(patch.owner_id || keep.owner_id) && o.owner_id) patch.owner_id = o.owner_id;
      if (!(patch.zone_id || keep.zone_id) && o.zone_id) patch.zone_id = o.zone_id;
      if (!(patch.potential || keep.potential) && o.potential) patch.potential = o.potential;
      if (o.stage === 'client') patch.stage = 'client';
      if (Number(o.default_discount) > Number(patch.default_discount ?? keep.default_discount)) patch.default_discount = o.default_discount;
      if (Number(o.marketing_consent) && !Number(keep.marketing_consent)) patch.marketing_consent = 1;
      if (Number(o.followup_optout)) patch.followup_optout = 1; // une opposition aux relances n'est jamais perdue
      if (o.notes && !String(patch.notes ?? keep.notes).includes(o.notes)) patch.notes = `${patch.notes ?? keep.notes}${(patch.notes ?? keep.notes) ? '\n' : ''}[Fusion de « ${o.name} »] ${o.notes}`.slice(0, 1500);
    }
    for (const [k, v] of Object.entries(patch)) await db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, keep.id);
    for (const o of olds) {
      // Prix négociés : on garde ceux de la fiche conservée en cas d'article commun (UNIQUE client + article).
      await db.prepare('DELETE FROM customer_prices WHERE customer_id = ? AND item_id IN (SELECT item_id FROM customer_prices WHERE customer_id = ?)').run(o.id, keep.id);
      await db.prepare('UPDATE customer_prices SET customer_id = ? WHERE customer_id = ?').run(keep.id, o.id);
      for (const t of MERGE_TABLES) { const r = await db.prepare(`UPDATE ${t} SET customer_id = ? WHERE customer_id = ?`).run(keep.id, o.id); if (r.changes) moved[t] = (moved[t] || 0) + r.changes; }
      await db.prepare('DELETE FROM customers WHERE id = ?').run(o.id);
    }
  })();
  await P.audit(req, 'account', keep.id, 'merge', { merged: olds.map((o) => ({ id: Number(o.id), name: o.name })), moved });
  await W.audit(req, 'customer', keep.id, 'merge', null, { merged: ids });
  res.json({ ok: true, keepId, merged: ids, moved });
});

module.exports = { router, MERGE_TABLES, accountOf, accountView, salesOf, refsOf, taskView };
