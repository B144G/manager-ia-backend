'use strict';
// Espaces par rôle : chaque personne a SON espace (comptabilité, commercial, stock…) selon son compte et sa fonction dans l'entreprise.
// ACTIVÉS PAR DÉFAUT pour toutes les entreprises (existantes et nouvelles) : décision du fondateur, à la fusion. Retour arrière à deux niveaux :
//   - le propriétaire d'une entreprise peut désactiver le réglage (PUT /spaces/settings) : l'entreprise retrouve l'ancien menu général ;
//   - la variable d'environnement SPACES_BY_ROLE=off désactive les espaces pour TOUTES les entreprises (interrupteur général, sans redéploiement du site).
// Une personne sans espace affecté garde ses accès actuels : ses espaces sont dérivés de ses droits (voir levelsFor, « repli sûr »).
//
// Niveaux d'accès à un espace (jamais un droit « au-dessus » de ce que le propriétaire a accordé) :
//   view   Visiteur : lecture seule. Toute écriture est REFUSÉE par le serveur (403 space_readonly), quel que soit le rôle de la personne.
//   write  Membre de l'espace : travaille avec ses droits habituels (rôle de l'organisation + rôles propres des modules).
//   manage Responsable de l'espace : dans les écrans de CET espace seulement, ses droits sont relevés au niveau « administrateur »
//          (ex. un comptable de rôle « membre » accède à la Comptabilité). Jamais relevé dans l'espace « compte » (équipe, intégrations, abonnement).
// Les droits sont TOUJOURS appliqués ici, côté serveur : l'interface ne fait que refléter.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const LEVELS = ['none', 'view', 'write', 'manage'];
const LV = { none: 0, view: 1, write: 2, manage: 3 };

// ---------- Catalogue des espaces : un module appartient à UN espace ----------
const SPACES = [
  { id: 'direction', icon: 'dashboard', title: 'Direction et pilotage', desc: "Vue d'ensemble de l'entreprise, indicateurs, organisation.", modules: ['dashboard', 'aifollow', 'structure', 'processes', 'memory', 'history', 'agents', 'alerts'] },
  { id: 'commercial', icon: 'crm', title: 'Commercial', desc: 'Clients, devis, factures, prospects, marketing, service client.', modules: ['commercial', 'crm', 'sales', 'parties', 'marketing', 'support'] },
  { id: 'finances', icon: 'accounting', title: 'Comptabilité et finances', desc: 'Comptabilité, trésorerie, budget, fiscalité.', modules: ['accounting', 'treasury', 'budget', 'fiscal'] },
  { id: 'stock', icon: 'stock', title: 'Stock et achats', desc: 'Stock, entrepôt, achats, fournisseurs.', modules: ['stock', 'purchasing'] },
  { id: 'rh', icon: 'hr', title: 'Ressources humaines', desc: 'Personnel, congés, paie, talents et compétences.', modules: ['hr', 'talents', 'payroll'] },
  { id: 'operations', icon: 'production', title: 'Opérations', desc: 'Production, logistique, chantiers, maintenance.', modules: ['production', 'logistics', 'construction', 'maintenance'] },
  { id: 'projets', icon: 'projects', title: 'Projets et réunions', desc: 'Mes tâches, projets, réunions, bibliothèque. Ouvert à tout le monde.', modules: ['projects', 'meetings', 'chat', 'library'], baseline: true },
  { id: 'gestion', icon: 'legal', title: 'Administration et juridique', desc: 'Documents administratifs, contrats, conformité.', modules: ['administration', 'legal'] },
  { id: 'compte', icon: 'team', title: 'Administration du compte', desc: 'Équipe, sécurité, intégrations, abonnement.', modules: ['team', 'entreprise', 'integrations', 'billing'] },
];
const SPACE_IDS = SPACES.map((s) => s.id);
const SPACE_OF = {};
for (const s of SPACES) for (const m of s.modules) SPACE_OF[m] = s.id;
const NO_ELEVATE = new Set(['compte']);

// ---------- Rôles fonctionnels : un modèle d'affectation (le propriétaire peut l'ajuster espace par espace) ----------
const FUNC_ROLES = [
  { id: 'dirigeant', title: 'Directeur / dirigeant', desc: "Vue d'ensemble : responsable de la Direction, visiteur dans les autres espaces.", spaces: { direction: 'manage' }, others: 'view' },
  { id: 'pilotage', title: 'Pilotage / contrôle de gestion', desc: 'Suit les indicateurs de tous les espaces en consultation.', spaces: { direction: 'write' }, others: 'view' },
  { id: 'comptable', title: 'Comptable', desc: 'Gère la comptabilité ; consulte le commercial.', spaces: { finances: 'manage', commercial: 'view' } },
  { id: 'tresorier', title: 'Trésorier', desc: 'Gère la trésorerie et le budget ; consulte la comptabilité.', spaces: { finances: 'manage' } },
  { id: 'resp_commercial', title: 'Responsable commercial', desc: 'Dirige le commercial ; consulte le stock.', spaces: { commercial: 'manage', stock: 'view' } },
  { id: 'commercial', title: 'Commercial / vendeur', desc: 'Travaille dans le commercial ; consulte le stock.', spaces: { commercial: 'write', stock: 'view' } },
  { id: 'resp_stock', title: 'Responsable stock et achats', desc: 'Gère le stock et les achats ; consulte le commercial.', spaces: { stock: 'manage', commercial: 'view' } },
  { id: 'acheteur', title: 'Acheteur / magasinier', desc: 'Travaille dans le stock et les achats.', spaces: { stock: 'write' } },
  { id: 'rh', title: 'Responsable RH', desc: 'Gère le personnel, les congés et la paie.', spaces: { rh: 'manage' } },
  { id: 'resp_operations', title: 'Responsable opérations / production', desc: 'Dirige production, logistique, chantiers, maintenance ; consulte le stock.', spaces: { operations: 'manage', stock: 'view' } },
  { id: 'chef_projet', title: 'Chef de projet', desc: 'Dirige les projets et réunions ; consulte le commercial.', spaces: { projets: 'manage', commercial: 'view' } },
  { id: 'juriste', title: 'Juriste / conformité', desc: 'Contrats, obligations, documents administratifs.', spaces: { gestion: 'manage' } },
  { id: 'assistant', title: 'Assistant administratif', desc: 'Documents administratifs et juridiques (sans droits de responsable).', spaces: { gestion: 'write' } },
  { id: 'admin_compte', title: "Administrateur du compte", desc: 'Équipe, intégrations (selon son rôle dans l\'organisation).', spaces: { compte: 'write' } },
];
const FUNC_IDS = FUNC_ROLES.map((f) => f.id);
/** Niveaux proposés par un rôle fonctionnel (modèle, sans écrire en base). */
function presetOf(ids) {
  const out = {};
  const up = (sp, lv) => { if (LV[lv] > LV[out[sp] || 'none']) out[sp] = lv; };
  for (const s of SPACES) if (s.baseline) out[s.id] = 'write'; // Projets et réunions : ouvert à tout le monde, jamais rétrogradé
  for (const id of ids) {
    const f = FUNC_ROLES.find((x) => x.id === id);
    if (!f) continue;
    if (f.others) for (const s of SPACES) if (s.id !== 'compte' && !s.baseline) up(s.id, f.others);
    for (const [sp, lv] of Object.entries(f.spaces)) up(sp, lv);
  }
  return out;
}

// ---------- Correspondance chemin d'API → module ----------
// null = commun à tous (jamais bloqué ici : il garde ses propres règles de rôle). Un chemin inconnu est traité comme commun.
const SEG = {
  dashboard: null, entreprise: null, decisions: null, share: null, geo: null, mail: null, feedback: null, profile: null, ai: null, data: null, notices: null, spaces: null,
  support: 'support', projects: 'projects', budget: 'budget', stock: 'stock', crm: 'crm', parties: 'parties', sales: 'sales', 'sales-mine': 'sales', commercial: 'commercial',
  aifollow: 'aifollow', 'wa-scope': 'sales', hr: 'hr', talents: 'talents', accounting: 'accounting', treasury: 'treasury', library: 'library', history: 'history',
  purchasing: 'purchasing', meetings: 'meetings', chat: 'chat', integrations: 'integrations', payroll: 'payroll', fiscal: 'fiscal', marketing: 'marketing', logistics: 'logistics',
  production: 'production', construction: 'construction', maintenance: 'maintenance', legal: 'legal', memory: 'memory', agents: 'agents', structure: 'structure',
  administration: 'administration', audit: 'team', 'ownership-transfer': 'team',
};
const moduleOfPath = (p) => { const seg = String(p || '').split('/')[1] || ''; return SEG[seg] === undefined ? null : SEG[seg]; };

// ---------- Réglage de l'organisation et droits effectifs ----------
/** Interrupteur général (variable d'environnement SPACES_BY_ROLE=off|0|false|non) : retour arrière pour toutes les entreprises. */
const globalOff = () => /^(off|0|false|no|non|disabled|desactive|désactivé)$/i.test(String(process.env.SPACES_BY_ROLE || '').trim());
async function settingsOf(orgId) {
  const r = await db.prepare('SELECT enabled, open_read FROM space_settings WHERE org_id = ?').get(orgId);
  const off = globalOff();
  // Sans réglage enregistré (entreprises existantes comme nouvelles) : ACTIVÉ. Un réglage du propriétaire (activé ou désactivé) est respecté, sauf interrupteur général.
  return { enabled: !off && (r ? Boolean(Number(r.enabled)) : true), openRead: Boolean(r && Number(r.open_read)), explicit: Boolean(r), globalOff: off };
}

/**
 * Niveau de la personne sur chaque espace, avec l'origine : explicite (affecté par le propriétaire), dérivé de l'ancien modèle
 * (rôle de l'organisation, rôles propres Trésorerie / RH / Commercial) ou de base (tout le monde : Projets et réunions).
 */
async function levelsFor(orgId, userId, role) {
  const rows = await db.prepare('SELECT space, access FROM member_spaces WHERE org_id = ? AND user_id = ?').all(orgId, userId);
  const explicit = {}; for (const r of rows) if (SPACE_IDS.includes(r.space) && LEVELS.includes(r.access)) explicit[r.space] = r.access;
  const derived = {};
  const up = (sp, lv) => { if (LV[lv] > LV[derived[sp] || 'none']) derived[sp] = lv; };
  for (const s of SPACES) if (s.baseline) up(s.id, 'write');
  // Repli sûr : une personne à qui le propriétaire n'a affecté AUCUN espace garde ses accès actuels. Ses espaces sont dérivés de ses droits :
  // tout espace dont au moins un écran est ouvert à son rôle lui est accordé en « membre » (ses droits habituels, jamais relevés).
  // Compte d'entreprise : la structure (postes, direction générale) donne des espaces à la personne AFFECTÉE ; null = affectée à rien, rien ne change.
  const struct = await require('./ent-lib').structureLevels(orgId, userId);
  const fallback = rows.length === 0 && !struct && A.RANK[role] < A.RANK.admin;
  if (fallback) {
    const { modules } = require('./modules');
    const seen = new Set(modules.filter((m) => A.RANK[role] >= A.RANK[m.min]).map((m) => m.id));
    for (const s of SPACES) if (s.modules.some((m) => seen.has(m))) up(s.id, 'write');
  }
  if (A.RANK[role] >= A.RANK.admin) for (const s of SPACES) up(s.id, 'manage');
  else {
    if (A.RANK[role] >= A.RANK.manager) up('direction', 'view');
    if (await db.prepare('SELECT 1 FROM tre_roles WHERE org_id = ? AND user_id = ?').get(orgId, userId)) up('finances', 'write');
    if (await db.prepare('SELECT 1 FROM rh_roles WHERE org_id = ? AND user_id = ?').get(orgId, userId)) up('rh', 'write');
    const cp = await db.prepare('SELECT role FROM cp_roles WHERE org_id = ? AND user_id = ?').get(orgId, userId);
    if (cp) up('commercial', cp.role === 'sales_manager' ? 'manage' : 'write');
  }
  const levels = {}; const via = {};
  for (const s of SPACES) {
    const e = explicit[s.id] !== undefined ? explicit[s.id] : (struct ? struct[s.id] : undefined); const d = derived[s.id] || 'none'; // l'affectation explicite du propriétaire (même « aucun ») l'emporte sur la structure
    // Le propriétaire et les administrateurs gardent toujours l'accès complet (ils affectent les espaces : jamais de blocage de leur propre compte).
    const fixed = A.RANK[role] >= A.RANK.admin;
    const lv = fixed ? 'manage' : (e !== undefined ? e : d);
    if (lv !== 'none') { levels[s.id] = lv; via[s.id] = fixed ? 'role' : e !== undefined ? 'assigned' : s.baseline && d === 'write' ? 'base' : 'role'; }
  }
  return { levels, via, explicit, fallback, structure: struct || {} };
}

async function effective(req) {
  if (req._spaces) return req._spaces;
  const st = await settingsOf(req.org.id);
  const real = req.member._realRole || req.member.role;
  const l = st.enabled ? await levelsFor(req.org.id, req.user.id, real) : { levels: {}, via: {}, explicit: {} };
  const funcs = st.enabled ? (await db.prepare('SELECT func_role FROM member_func_roles WHERE org_id = ? AND user_id = ?').all(req.org.id, req.user.id)).map((r) => r.func_role) : [];
  req._spaces = { ...st, ...l, funcs, role: real };
  return req._spaces;
}

/** Espace d'atterrissage à la connexion. choose = true quand la personne doit choisir entre plusieurs espaces. */
function landing(eff, last) {
  const ids = Object.keys(eff.levels);
  const main = ids.filter((id) => LV[eff.levels[id]] >= LV.write && !SPACES.find((s) => s.id === id).baseline);
  const cand = main.length ? main : ids.filter((id) => LV[eff.levels[id]] >= LV.write);
  if (last && eff.levels[last]) return { space: last, choose: false };
  if (eff.levels.direction === 'manage' || (eff.levels.direction && A.RANK[eff.role] >= A.RANK.admin)) return { space: 'direction', choose: false };
  if (cand.length === 1) return { space: cand[0], choose: false };
  if (cand.length > 1) return { space: null, choose: true };
  return { space: ids[0] || null, choose: false };
}

/** Ce que l'interface reçoit à propos de la personne connectée (jamais plus que ce que le serveur appliquera). */
async function forMember(req) {
  const eff = await effective(req);
  if (!eff.enabled) return { enabled: false };
  const pref = await db.prepare('SELECT last_space FROM member_space_prefs WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  const last = pref && eff.levels[pref.last_space] ? pref.last_space : null;
  const { modules } = require('./modules');
  const visible = new Set(modules.filter((m) => A.RANK[eff.role] >= A.RANK[m.min]).map((m) => m.id));
  const spaces = SPACES.filter((s) => eff.levels[s.id]).map((s) => ({
    id: s.id, icon: s.icon, title: s.title, desc: s.desc, level: eff.levels[s.id], via: eff.via[s.id],
    // (Seulement pour un espace AFFECTÉ par le propriétaire ; un espace dérivé des droits actuels ne montre que les écrans déjà ouverts au rôle.)
    // Un visiteur ou un responsable peut ouvrir des écrans que son rôle d'organisation ne montre pas (le serveur relève ses droits dans l'espace).
    modules: s.modules.filter((m) => visible.has(m) || (eff.via[s.id] === 'assigned' && LV[eff.levels[s.id]] >= LV.view && !NO_ELEVATE.has(s.id))).map((m) => ({ id: m, title: (modules.find((x) => x.id === m) || {}).title || m })),
  }));
  const l = landing(eff, last);
  return { enabled: true, openRead: eff.openRead, spaces, funcRoles: eff.funcs, last, landing: l.space, choose: l.choose, fallback: Boolean(eff.fallback) };
}

// ---------- Garde des routes : appliquée à chaque requête vers un module ----------
async function guard(req, res, next) {
  const mod = moduleOfPath(req.path);
  if (!mod) return next();
  const eff = await effective(req);
  if (!eff.enabled) return next();
  const read = req.method === 'GET' || req.method === 'HEAD';
  const sp = SPACE_OF[mod];
  const lv = sp ? eff.levels[sp] : null;
  if (!lv) {
    if (read && eff.openRead) return next(); // réglage « consultation ouverte » : lecture avec les droits habituels
    throw Object.assign(new HttpError(403, "Cet écran n'est pas dans vos espaces. Demandez au propriétaire de vous y donner accès (en consultation ou en travail)."), { errorCode: 'space_denied' });
  }
  if (lv === 'view' && !read) throw Object.assign(new HttpError(403, 'Consultation seule : vous êtes visiteur dans cet espace, aucune modification n\'est possible.'), { errorCode: 'space_readonly' });
  const real = req.member.role;
  // Relèvement des droits SEULEMENT pour un espace affecté par le propriétaire : un niveau dérivé des droits actuels (repli sûr) ne donne jamais plus que ce que la personne avait avant.
  const raise = eff.via[sp] === 'assigned' && !NO_ELEVATE.has(sp) && A.RANK[real] < A.RANK.admin && (lv === 'manage' || (lv === 'view' && read));
  if (raise) req.member = { ...req.member, role: 'admin', _realRole: real, _elevated: true }; // pour CETTE requête seulement, dans cet espace seulement
  next();
}

// ---------- Tableau de bord d'un espace ----------
async function dashboardOf(req, space) {
  const o = req.org.id; const sc = A.scope(req);
  const today = nowISO().slice(0, 10);
  const n = async (sql, ...a) => { try { return Number((await db.prepare(sql).get(o, ...a)).c) || 0; } catch { return 0; } };
  const tile = (id, label, value, to, tone) => ({ id, label, value, to, tone: tone || (value ? undefined : 'ok') });
  const T = [];
  if (space === 'commercial') {
    T.push(tile('customers', 'Clients', await n(`SELECT COUNT(*) c FROM customers WHERE org_id = ?${sc.sql}`, ...sc.args), 'crm', 'plain'));
    T.push(tile('unpaid', 'Factures à encaisser', await n(`SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'invoice' AND status = 'sent' AND paid < total${sc.sql}`, ...sc.args), 'crm', 'warn'));
    T.push(tile('overdue', 'Factures en retard', await n(`SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'invoice' AND status = 'sent' AND paid < total AND due IS NOT NULL AND due < ?${sc.sql}`, today, ...sc.args), 'crm', 'bad'));
    T.push(tile('tickets', 'Demandes clients ouvertes', await n(`SELECT COUNT(*) c FROM tickets WHERE org_id = ? AND status = 'open'${sc.sql}`, ...sc.args), 'support', 'warn'));
  } else if (space === 'finances') {
    T.push(tile('unpaid', 'Factures à encaisser', await n(`SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'invoice' AND status = 'sent' AND paid < total${sc.sql}`, ...sc.args), 'accounting', 'warn'));
    T.push(tile('expenses', 'Dépenses à valider', await n("SELECT COUNT(*) c FROM expense_requests WHERE org_id = ? AND status = 'pending'"), 'budget', 'warn'));
    T.push(tile('entries', 'Écritures comptables', await n('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ?'), 'accounting', 'plain'));
  } else if (space === 'stock') {
    T.push(tile('items', 'Articles en stock', await n(`SELECT COUNT(*) c FROM stock_items WHERE org_id = ?${sc.sql}`, ...sc.args), 'stock', 'plain'));
    T.push(tile('low', 'Articles sous le seuil', await n(`SELECT COUNT(*) c FROM stock_items WHERE org_id = ? AND min_quantity > 0 AND quantity <= min_quantity${sc.sql}`, ...sc.args), 'stock', 'bad'));
    T.push(tile('orders', 'Commandes à valider', await n("SELECT COUNT(*) c FROM purchase_orders WHERE org_id = ? AND status = 'pending'"), 'purchasing', 'warn'));
  } else if (space === 'rh') {
    T.push(tile('staff', 'Personnel actif', await n(`SELECT COUNT(*) c FROM employees WHERE org_id = ? AND status = 'active'${sc.sql}`, ...sc.args), 'hr', 'plain'));
    T.push(tile('leaves', 'Congés à traiter', await n("SELECT COUNT(*) c FROM leaves WHERE org_id = ? AND status = 'pending'"), 'hr', 'warn'));
  } else if (space === 'operations') {
    T.push(tile('prod', 'Ordres de production en cours', await n("SELECT COUNT(*) c FROM production_orders WHERE org_id = ? AND status NOT IN ('done','cancelled','draft')"), 'production', 'plain'));
    T.push(tile('deliv', 'Livraisons à préparer', await n("SELECT COUNT(*) c FROM logistics_deliveries WHERE org_id = ? AND status = 'to_prepare'"), 'logistics', 'warn'));
    T.push(tile('maint', 'Maintenances ouvertes', await n("SELECT COUNT(*) c FROM maintenance_orders WHERE org_id = ? AND status = 'open'"), 'maintenance', 'warn'));
    T.push(tile('sites', 'Chantiers en cours', await n("SELECT COUNT(*) c FROM construction_sites WHERE org_id = ? AND status NOT IN ('done','closed','cancelled')"), 'construction', 'plain'));
  } else if (space === 'projets') {
    T.push(tile('mine', 'Mes tâches à faire', await n("SELECT COUNT(*) c FROM tasks WHERE org_id = ? AND status != 'done' AND assignee_id = ?", req.user.id), 'projects', 'plain'));
    T.push(tile('late', 'Tâches en retard', await n(`SELECT COUNT(*) c FROM tasks WHERE org_id = ? AND status != 'done' AND due IS NOT NULL AND due < ?${sc.sql}`, today, ...sc.args), 'projects', 'bad'));
    T.push(tile('projects', 'Projets en cours', await n(`SELECT COUNT(*) c FROM projects WHERE org_id = ? AND status = 'active'${sc.sql}`, ...sc.args), 'projects', 'plain'));
  } else if (space === 'gestion') {
    T.push(tile('contracts', 'Contrats actifs', await n("SELECT COUNT(*) c FROM legal_contracts WHERE org_id = ? AND status = 'active'"), 'legal', 'plain'));
    T.push(tile('ending', 'Contrats qui arrivent à échéance (60 jours)', await n("SELECT COUNT(*) c FROM legal_contracts WHERE org_id = ? AND status = 'active' AND end_date IS NOT NULL AND end_date <= ?", new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)), 'legal', 'warn'));
  } else if (space === 'compte') {
    T.push(tile('members', "Personnes dans l'équipe", await n('SELECT COUNT(*) c FROM org_members WHERE org_id = ?'), 'team', 'plain'));
    T.push(tile('branches', 'Antennes', await n('SELECT COUNT(*) c FROM branches WHERE org_id = ?'), 'team', 'plain'));
  }
  const mine = await db.prepare("SELECT t.id, t.title, t.due, t.status FROM tasks t WHERE t.org_id = ? AND t.status != 'done' AND t.assignee_id = ? ORDER BY CASE WHEN t.due IS NULL THEN 1 ELSE 0 END, t.due LIMIT 5").all(o, req.user.id);
  const hasPhoto = Boolean(await db.prepare('SELECT 1 FROM member_photos WHERE org_id = ? AND user_id = ?').get(o, req.user.id));
  const person = { userId: Number(req.user.id), name: req.user.name, title: req.member.title || '', hasPhoto };
  return { space, person, tiles: T, myTasks: mine.map((t) => ({ id: t.id, title: t.title, due: t.due })) };
}

// ---------- Routes ----------
const router = express.Router({ mergeParams: true });
const log = (req, action, detail) => db.prepare('INSERT INTO space_log (org_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, req.user.id, action, String(detail).slice(0, 400), nowISO());

router.get('/me', async (req, res) => res.json(await forMember(req)));

router.put('/last', async (req, res) => {
  const eff = await effective(req);
  const sp = (req.body || {}).space;
  if (!eff.enabled || !eff.levels[sp]) throw new HttpError(400, 'Espace inconnu ou non accordé.');
  await db.prepare(`INSERT INTO member_space_prefs (org_id, user_id, last_space, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (org_id, user_id) DO UPDATE SET last_space = EXCLUDED.last_space, updated_at = EXCLUDED.updated_at`).run(req.org.id, req.user.id, sp, nowISO());
  res.json({ ok: true });
});

// Photo de profil (facultative) : chacun la sienne ; visible des membres de la même organisation seulement.
const IMG = [['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/webp', [0x52, 0x49, 0x46, 0x46]]];
router.put('/photo', express.raw({ type: () => true, limit: '400kb' }), async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const mime = (IMG.find(([, sig]) => sig.every((v, i) => buf[i] === v)) || [])[0];
  if (!mime || buf.length < 32) throw new HttpError(400, 'Photo non valide : utilisez une image JPEG, PNG ou WebP de 400 Ko au plus.');
  await db.prepare(`INSERT INTO member_photos (org_id, user_id, mime, data, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (org_id, user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`).run(req.org.id, req.user.id, mime, buf, nowISO());
  res.json({ ok: true });
});
router.delete('/photo', async (req, res) => { await db.prepare('DELETE FROM member_photos WHERE org_id = ? AND user_id = ?').run(req.org.id, req.user.id); res.json({ ok: true }); });
router.get('/photo/:userId', async (req, res) => {
  const r = await db.prepare('SELECT mime, data FROM member_photos WHERE org_id = ? AND user_id = ?').get(req.org.id, A.id(req.params.userId));
  if (!r) throw new HttpError(404, 'Pas de photo.');
  res.set({ 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.end(r.data);
});

router.get('/dashboard/:space', async (req, res) => {
  const eff = await effective(req);
  const sp = req.params.space;
  if (!eff.enabled || !SPACE_IDS.includes(sp) || !eff.levels[sp]) throw new HttpError(403, "Cet espace ne fait pas partie de vos espaces.");
  res.json(await dashboardOf(req, sp));
});

/** Direction : vue d'ensemble, une carte par espace (visible si la personne a l'espace Direction, ou l'accès transversal du propriétaire). */
router.get('/overview', async (req, res) => {
  const eff = await effective(req);
  if (!eff.enabled || !(eff.levels.direction || A.can(req, 'admin'))) throw new HttpError(403, "Vue d'ensemble réservée à la direction.");
  const out = [];
  for (const s of SPACES) {
    if (s.id === 'direction') continue;
    // Chaque carte n'est calculée que pour un espace que la personne peut au moins consulter (jamais de fuite d'indicateurs).
    if (!eff.levels[s.id] && !A.can(req, 'admin')) continue;
    const d = await dashboardOf(req, s.id);
    out.push({ id: s.id, icon: s.icon, title: s.title, level: eff.levels[s.id] || 'manage', tiles: d.tiles });
  }
  res.json({ spaces: out });
});

router.put('/settings', A.need('owner'), async (req, res) => {
  const b = req.body || {};
  const cur = await settingsOf(req.org.id);
  const raw = await db.prepare('SELECT enabled FROM space_settings WHERE org_id = ?').get(req.org.id);
  const enabled = b.enabled === undefined ? (raw ? Boolean(Number(raw.enabled)) : true) : Boolean(b.enabled); // enregistré tel quel : le réglage du propriétaire survit à l'interrupteur général
  const openRead = b.openRead === undefined ? cur.openRead : Boolean(b.openRead);
  await db.prepare(`INSERT INTO space_settings (org_id, enabled, open_read, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, open_read = EXCLUDED.open_read, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, enabled ? 1 : 0, openRead ? 1 : 0, req.user.id, nowISO());
  await log(req, 'settings', `enabled=${enabled} openRead=${openRead}`);
  res.json({ ok: true, enabled: enabled && !globalOff(), openRead, globalOff: globalOff() });
});

router.get('/settings', A.need('admin'), async (req, res) => res.json({ ...(await settingsOf(req.org.id)), catalogue: SPACES.map(({ id, icon, title, desc, modules }) => ({ id, icon, title, desc, modules })), funcRoles: FUNC_ROLES.map((f) => ({ id: f.id, title: f.title, desc: f.desc, preset: presetOf([f.id]) })) }));

router.get('/assignments', A.need('admin'), async (req, res) => {
  const members = await db.prepare('SELECT m.user_id, m.role, m.title, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.id').all(req.org.id);
  const out = [];
  for (const m of members) {
    const l = await levelsFor(req.org.id, m.user_id, m.role);
    const funcs = (await db.prepare('SELECT func_role FROM member_func_roles WHERE org_id = ? AND user_id = ?').all(req.org.id, m.user_id)).map((r) => r.func_role);
    out.push({ userId: Number(m.user_id), name: m.name, role: m.role, title: m.title, funcRoles: funcs, explicit: l.explicit, effective: l.levels, via: l.via, fixed: A.RANK[m.role] >= A.RANK.admin });
  }
  res.json({ members: out });
});

router.put('/assignments/:userId', A.need('admin'), async (req, res) => {
  const uid = A.id(req.params.userId);
  const t = await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!t) throw new HttpError(404, 'Personne introuvable.');
  if (A.RANK[t.role] >= A.RANK.admin) throw new HttpError(400, "Le propriétaire et les administrateurs ont accès à tous les espaces : rien à affecter.");
  const b = req.body || {};
  const funcs = b.funcRoles === undefined ? null : [...new Set((Array.isArray(b.funcRoles) ? b.funcRoles : []).map(String))];
  if (funcs && funcs.some((f) => !FUNC_IDS.includes(f))) throw new HttpError(400, 'Rôle fonctionnel inconnu.');
  let spaces = null;
  if (b.spaces !== undefined) {
    if (!b.spaces || typeof b.spaces !== 'object' || Array.isArray(b.spaces)) throw new HttpError(400, 'Espaces non valides.');
    spaces = {};
    for (const [k, v] of Object.entries(b.spaces)) {
      if (!SPACE_IDS.includes(k) || !LEVELS.includes(v)) throw new HttpError(400, 'Espace ou niveau inconnu.');
      spaces[k] = v;
    }
  }
  const now = nowISO();
  await db.transaction(async () => {
    if (funcs) {
      await db.prepare('DELETE FROM member_func_roles WHERE org_id = ? AND user_id = ?').run(req.org.id, uid);
      for (const f of funcs) await db.prepare('INSERT INTO member_func_roles (org_id, user_id, func_role, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, uid, f, req.user.id, now);
      if (spaces === null && b.applyPreset) spaces = presetOf(funcs); // le modèle du rôle fonctionnel remplit les espaces
    }
    if (spaces) {
      // Ne jamais donner plus que ce que l'on a : un administrateur ne peut pas donner « responsable de l'espace compte » (réservé au propriétaire).
      if (spaces.compte && LV[spaces.compte] >= LV.manage && !A.can(req, 'owner')) throw new HttpError(403, "Seul le propriétaire peut nommer un responsable de l'espace compte.");
      await db.prepare('DELETE FROM member_spaces WHERE org_id = ? AND user_id = ?').run(req.org.id, uid);
      for (const [sp, lv] of Object.entries(spaces)) await db.prepare('INSERT INTO member_spaces (org_id, user_id, space, access, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, uid, sp, lv, req.user.id, now);
    }
  })();
  await log(req, 'assign', `user=${uid} funcs=${funcs ? funcs.join(',') : '-'} spaces=${spaces ? JSON.stringify(spaces) : '-'}`);
  await require('./w3').audit(req, 'member_spaces', uid, 'update', null, { funcRoles: funcs, spaces });
  res.json({ ok: true });
});

router.get('/log', A.need('admin'), async (req, res) => {
  const rows = await db.prepare('SELECT l.action, l.detail, l.created_at AS at, u.name FROM space_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 50').all(req.org.id);
  res.json({ log: rows });
});

module.exports = { router, guard, forMember, effective, settingsOf, levelsFor, presetOf, moduleOfPath, SPACES, SPACE_OF, FUNC_ROLES, SEG };
