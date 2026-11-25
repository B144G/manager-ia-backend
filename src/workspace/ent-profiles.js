'use strict';
// Compte d'entreprise, étape 3 : profils de rôle. Chaque poste a un profil : blocs du tableau de bord, modules, actions rapides, mode mobile.
// Le profil NE DONNE AUCUN DROIT : les droits viennent du poste (espaces, niveaux) et du système d'espaces par rôle. Un bloc ou un module qui n'est pas
// accessible à la personne est simplement absent de son profil (jamais de fuite). Les profils de base sont ici ; l'entreprise les modifie par organisation (ent_profiles).
const { db, nowISO } = require('../db');
const A = require('./access');
const { parseJSON } = require('../util');

const SPACE_IDS = ['direction', 'commercial', 'finances', 'stock', 'rh', 'operations', 'projets', 'gestion', 'compte'];
const LAYOUTS = ['standard', 'driver', 'compact'];
const BLOCK_TYPES = ['tiles', 'tasks', 'list', 'component'];
const COMPONENTS = { driver: 'logistics', fuel: 'logistics', incident: 'maintenance' }; // composant → module nécessaire
const today = () => nowISO().slice(0, 10);

// ---------- Listes disponibles pour les blocs (chacune exige l'accès au module et filtre par antenne) ----------
const SOURCES = {
  overdue_invoices: { module: 'crm', title: 'Factures en retard', q: (sc, d) => [`SELECT d.id, d.number AS t, d.due AS s FROM documents d WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'sent' AND d.paid < d.total AND d.due IS NOT NULL AND d.due < ?${sc.sql.replace(/branch_id/g, 'd.branch_id')} ORDER BY d.due LIMIT 6`, [d, ...sc.args]] },
  unpaid_invoices: { module: 'crm', title: 'Factures à encaisser', q: (sc) => [`SELECT d.id, d.number AS t, d.due AS s FROM documents d WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'sent' AND d.paid < d.total${sc.sql.replace(/branch_id/g, 'd.branch_id')} ORDER BY d.due LIMIT 6`, []] },
  pending_expenses: { module: 'budget', title: 'Dépenses à valider', q: () => ["SELECT id, label AS t, category AS s FROM expense_requests WHERE org_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 6", []] },
  low_stock: { module: 'stock', title: 'Articles sous le seuil', q: (sc) => [`SELECT id, name AS t, CAST(quantity AS TEXT) AS s FROM stock_items WHERE org_id = ? AND min_quantity > 0 AND quantity <= min_quantity${sc.sql} ORDER BY quantity LIMIT 6`, []] },
  pending_orders: { module: 'purchasing', title: 'Commandes à valider', q: () => ["SELECT p.id, COALESCE(i.name, 'Article') AS t, CAST(p.quantity AS TEXT) AS s FROM purchase_orders p LEFT JOIN stock_items i ON i.id = p.item_id WHERE p.org_id = ? AND p.status = 'pending' ORDER BY p.id DESC LIMIT 6", []] },
  open_tickets: { module: 'support', title: 'Demandes clients ouvertes', q: (sc) => [`SELECT id, subject AS t, customer_name AS s FROM tickets WHERE org_id = ? AND status = 'open'${sc.sql} ORDER BY id DESC LIMIT 6`, []] },
  pending_leaves: { module: 'hr', title: 'Congés à traiter', q: () => ["SELECT l.id, COALESCE(e.name, 'Personne') AS t, l.start AS s FROM leaves l LEFT JOIN employees e ON e.id = l.employee_id WHERE l.org_id = ? AND l.status = 'pending' ORDER BY l.start LIMIT 6", []] },
  deliveries_today: { module: 'logistics', title: 'Livraisons du jour', q: (sc, d) => ["SELECT id, customer_name AS t, address AS s FROM logistics_deliveries WHERE org_id = ? AND planned_date = ? AND status NOT IN ('delivered', 'cancelled') ORDER BY round_pos, id LIMIT 6", [d]] },
  open_maintenance: { module: 'maintenance', title: 'Interventions ouvertes', q: () => ["SELECT id, title AS t, priority AS s FROM maintenance_orders WHERE org_id = ? AND status = 'open' ORDER BY id DESC LIMIT 6", []] },
  production_open: { module: 'production', title: 'Ordres de production en cours', q: () => ["SELECT id, COALESCE(product_name, 'Produit') AS t, due_date AS s FROM production_orders WHERE org_id = ? AND status NOT IN ('done', 'cancelled', 'draft') ORDER BY due_date LIMIT 6", []] },
  sites_running: { module: 'construction', title: 'Chantiers en cours', q: () => ["SELECT id, name AS t, location AS s FROM construction_sites WHERE org_id = ? AND status NOT IN ('done', 'closed', 'cancelled') ORDER BY id DESC LIMIT 6", []] },
  tasks_late: { module: 'projects', title: 'Tâches en retard', q: (sc, d) => [`SELECT id, title AS t, due AS s FROM tasks WHERE org_id = ? AND status != 'done' AND due IS NOT NULL AND due < ?${sc.sql} ORDER BY due LIMIT 6`, [d]] },
};

// ---------- Profils de base (au moins une quinzaine) ----------
const tiles = (space) => ({ type: 'tiles', space });
const list = (source) => ({ type: 'list', source });
const comp = (name) => ({ type: 'component', name });
const tasks = () => ({ type: 'tasks' });
const P = (key, title, desc, tkeys, c) => ({ key, title, desc, tkeys, config: { blocks: c.blocks, modules: c.modules, quick: c.quick || [], mobile: { layout: c.layout || 'standard' }, spaces: c.spaces || {} } });
const q = (label, module) => ({ label, module });

const CATALOG = [
  P('dg', 'Directeur général', "Vue d'ensemble de toute l'entreprise : indicateurs de chaque espace, alertes, décisions.", ['dg'], { blocks: [tiles('direction'), tiles('finances'), tiles('commercial'), list('overdue_invoices'), list('pending_expenses'), tasks()], modules: ['dashboard', 'aifollow', 'decisions', 'accounting', 'crm', 'hr', 'meetings', 'chat'].filter((m) => m !== 'decisions'), quick: [q('Tableau de bord', 'dashboard'), q('Réunions', 'meetings'), q('Messagerie', 'chat')], spaces: { direction: 'manage', commercial: 'view', finances: 'view', stock: 'view', rh: 'view', operations: 'view' } }),
  P('daf', 'Directeur administratif et financier', 'Trésorerie, comptabilité, factures en retard, dépenses à valider.', ['dir_daf'], { blocks: [tiles('finances'), list('overdue_invoices'), list('pending_expenses'), tasks()], modules: ['accounting', 'treasury', 'budget', 'fiscal', 'payroll', 'crm', 'meetings', 'chat'], quick: [q('Comptabilité', 'accounting'), q('Trésorerie', 'treasury'), q('Budget', 'budget')], spaces: { finances: 'manage', direction: 'view', commercial: 'view' } }),
  P('comptable', 'Comptable', 'Écritures, factures à encaisser, rapprochements.', ['finance.comptable'], { blocks: [tiles('finances'), list('unpaid_invoices'), tasks()], modules: ['accounting', 'treasury', 'budget', 'fiscal', 'crm', 'chat'], quick: [q('Comptabilité', 'accounting'), q('Fiscalité et liasse', 'fiscal'), q('Clients et ventes', 'crm')], spaces: { finances: 'manage', commercial: 'view' } }),
  P('tresorier', 'Trésorier', 'Position de trésorerie, échéances, factures à encaisser.', ['finance.tresorier'], { blocks: [tiles('finances'), list('unpaid_invoices'), list('pending_expenses')], modules: ['treasury', 'accounting', 'budget', 'chat'], quick: [q('Trésorerie', 'treasury'), q('Budget', 'budget')], spaces: { finances: 'manage' } }),
  P('caissier', 'Caissier', 'Encaissements du jour et factures à encaisser.', ['finance.caissier'], { blocks: [list('unpaid_invoices'), tasks()], modules: ['crm', 'chat'], quick: [q('Clients et ventes', 'crm')], layout: 'compact', spaces: { finances: 'write' } }),
  P('controleur', 'Contrôleur de gestion', 'Indicateurs et écarts de gestion.', ['finance.controleur', 'pilotage.analyste', 'pilotage.resp_pilotage'], { blocks: [tiles('direction'), tiles('finances'), list('pending_expenses'), tasks()], modules: ['dashboard', 'budget', 'aifollow', 'history', 'chat'], quick: [q('Budget', 'budget'), q('Tableau de bord', 'dashboard')], spaces: { direction: 'write', finances: 'view' } }),
  P('dir_commercial', 'Directeur commercial', 'Clients, factures en retard, demandes ouvertes, équipe de vente.', ['dir_dcom', 'commercial.resp_com'], { blocks: [tiles('commercial'), list('overdue_invoices'), list('open_tickets'), tasks()], modules: ['commercial', 'crm', 'sales', 'parties', 'marketing', 'support', 'meetings', 'chat'], quick: [q('Commercial', 'commercial'), q('Clients et ventes', 'crm'), q('Service client', 'support')], spaces: { commercial: 'manage', stock: 'view', direction: 'view' } }),
  P('vendeur', 'Commercial / vendeur', 'Mes clients, mes factures à encaisser, mes demandes.', ['commercial.vendeur', 'commercial.assist_com', 'commercial.service_client'], { blocks: [tiles('commercial'), list('unpaid_invoices'), list('open_tickets'), tasks()], modules: ['crm', 'sales', 'commercial', 'support', 'chat'], quick: [q('Clients et ventes', 'crm'), q('Assistant commercial', 'sales'), q('Service client', 'support')], layout: 'compact', spaces: { commercial: 'write', stock: 'view' } }),
  P('dir_production', 'Directeur de production', 'Ordres de production, maintenance, matières.', ['dir_dprod', 'dir_dtech'], { blocks: [tiles('operations'), list('production_open'), list('open_maintenance'), list('low_stock')], modules: ['production', 'maintenance', 'stock', 'logistics', 'meetings', 'chat'], quick: [q('Production', 'production'), q('Maintenance', 'maintenance')], spaces: { operations: 'manage', stock: 'view', direction: 'view' } }),
  P('chef_production', 'Chef de production', 'Ordres en cours, interventions, tâches de l\'équipe.', ['production.chef_prod', 'production.operateur', 'production.qualite'], { blocks: [list('production_open'), list('open_maintenance'), tasks()], modules: ['production', 'maintenance', 'stock', 'chat'], quick: [q('Production', 'production'), q('Maintenance', 'maintenance')], spaces: { operations: 'manage', stock: 'view' } }),
  P('metreur', 'Métreur (BTP)', 'Chantiers en cours, métrés et situations de travaux.', ['production.metreur', 'production.conducteur', 'production.chef_chantier'], { blocks: [list('sites_running'), list('low_stock'), tasks()], modules: ['construction', 'stock', 'projects', 'chat'], quick: [q('Chantiers', 'construction'), q('Stock', 'stock')], layout: 'compact', spaces: { operations: 'write', stock: 'view' } }),
  P('dir_logistique', 'Directeur de la logistique', 'Livraisons du jour, flotte, tournées, interventions.', ['dir_dlog', 'logistique.resp_log', 'logistique.chef_parc'], { blocks: [tiles('operations'), list('deliveries_today'), list('open_maintenance')], modules: ['logistics', 'maintenance', 'stock', 'meetings', 'chat'], quick: [q('Logistique', 'logistics'), q('Maintenance', 'maintenance')], spaces: { operations: 'manage', stock: 'view', direction: 'view' } }),
  P('dispatcheur', 'Dispatcheur', 'Tournées et livraisons à répartir aujourd\'hui.', ['logistique.dispatcheur'], { blocks: [list('deliveries_today'), tiles('operations'), tasks()], modules: ['logistics', 'chat'], quick: [q('Logistique', 'logistics')], spaces: { operations: 'write' } }),
  P('chauffeur', 'Chauffeur', 'Écran mobile : missions du jour, itinéraire, preuve de livraison, carburant, incidents.', ['logistique.chauffeur', 'logistique.livreur'], { blocks: [comp('driver'), comp('fuel'), comp('incident')], modules: ['logistics', 'maintenance', 'chat'], quick: [q('Mes missions', 'logistics')], layout: 'driver', spaces: { operations: 'write' } }),
  P('acheteur', 'Acheteur', 'Commandes à valider et articles sous le seuil.', ['achats.acheteur'], { blocks: [list('pending_orders'), list('low_stock'), tasks()], modules: ['purchasing', 'stock', 'parties', 'chat'], quick: [q('Achats', 'purchasing'), q('Stock', 'stock')], spaces: { stock: 'write' } }),
  P('magasinier', 'Magasinier', 'Stock, réceptions, articles sous le seuil.', ['achats.magasinier'], { blocks: [tiles('stock'), list('low_stock'), tasks()], modules: ['stock', 'purchasing', 'chat'], quick: [q('Stock', 'stock'), q('Achats', 'purchasing')], layout: 'compact', spaces: { stock: 'write' } }),
  P('drh', 'Directeur des ressources humaines', 'Personnel, congés à traiter, paie, talents.', ['dir_drh', 'rh.resp_rh', 'rh.paie', 'rh.recrutement'], { blocks: [tiles('rh'), list('pending_leaves'), tasks()], modules: ['hr', 'talents', 'payroll', 'meetings', 'chat'], quick: [q('Ressources humaines', 'hr'), q('Paie', 'payroll'), q('Talents', 'talents')], spaces: { rh: 'manage', direction: 'view' } }),
  P('dir_it', 'Directeur informatique et maintenance', 'Interventions ouvertes, parc, équipements.', ['dir_dit', 'informatique.resp_it', 'informatique.technicien', 'informatique.mecanicien'], { blocks: [list('open_maintenance'), tiles('operations'), tasks()], modules: ['maintenance', 'logistics', 'integrations', 'chat'], quick: [q('Maintenance', 'maintenance')], spaces: { operations: 'manage', direction: 'view' } }),
  P('dir_securite', 'Directeur de la sécurité', 'Obligations, conformité et contrats.', ['dir_dsec', 'securite.resp_securite', 'securite.agent_securite'], { blocks: [tiles('gestion'), tasks()], modules: ['legal', 'administration', 'meetings', 'chat'], quick: [q('Juridique et conformité', 'legal'), q('Administration', 'administration')], spaces: { gestion: 'manage', direction: 'view' } }),
  P('dir_marketing', 'Directeur marketing', 'Campagnes, clients et demandes.', ['dir_dmkt', 'marketing.resp_mkt', 'marketing.community'], { blocks: [tiles('commercial'), list('open_tickets'), tasks()], modules: ['marketing', 'sales', 'crm', 'chat'], quick: [q('Marketing', 'marketing'), q('Assistant commercial', 'sales')], spaces: { commercial: 'manage' } }),
  P('dir_achats', 'Directeur du stockage et des achats', 'Stock, commandes à valider, fournisseurs.', ['dir_dstock', 'achats.resp_stock'], { blocks: [tiles('stock'), list('pending_orders'), list('low_stock')], modules: ['stock', 'purchasing', 'parties', 'meetings', 'chat'], quick: [q('Achats', 'purchasing'), q('Stock', 'stock')], spaces: { stock: 'manage', finances: 'view', direction: 'view' } }),
  P('assistant', 'Assistant(e) de direction', 'Agenda, tâches, documents.', ['pilotage.assistant_dir'], { blocks: [tasks(), tiles('projets')], modules: ['meetings', 'projects', 'administration', 'library', 'chat'], quick: [q('Réunions', 'meetings'), q('Tâches', 'projects')], spaces: { direction: 'write', gestion: 'write' } }),
  P('consultant', 'Chef de projet / consultant', 'Projets en cours, tâches et réunions.', ['production.chef_projet', 'production.consultant'], { blocks: [tiles('projets'), list('tasks_late'), tasks()], modules: ['projects', 'meetings', 'library', 'chat'], quick: [q('Projets et tâches', 'projects'), q('Réunions', 'meetings')], spaces: { projets: 'manage', commercial: 'view' } }),
];
const BASE = Object.fromEntries(CATALOG.map((p) => [p.key, p]));

// ---------- Validation d'une configuration (modifiée par l'entreprise) ----------
function cleanConfig(cfg, moduleIds, HttpError) {
  const bad = (m) => { throw new HttpError(400, m); };
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) bad('Profil non valide.');
  const blocks = Array.isArray(cfg.blocks) ? cfg.blocks : bad('Indiquez les blocs du tableau de bord.');
  if (blocks.length > 12) bad('12 blocs au plus.');
  const outB = blocks.map((b) => {
    if (!b || !BLOCK_TYPES.includes(b.type)) bad('Type de bloc inconnu.');
    if (b.type === 'tiles') { if (!SPACE_IDS.includes(b.space)) bad('Espace inconnu.'); return { type: 'tiles', space: b.space }; }
    if (b.type === 'list') { if (!SOURCES[b.source]) bad('Liste inconnue.'); return { type: 'list', source: b.source }; }
    if (b.type === 'component') { if (!COMPONENTS[b.name]) bad('Composant inconnu.'); return { type: 'component', name: b.name }; }
    return { type: 'tasks' };
  });
  const modules = Array.isArray(cfg.modules) ? [...new Set(cfg.modules.map(String))] : [];
  if (modules.length > 25 || modules.some((m) => !moduleIds.includes(m))) bad('Module inconnu.');
  const quick = (Array.isArray(cfg.quick) ? cfg.quick : []).slice(0, 8).map((x) => {
    if (!x || !moduleIds.includes(x.module)) bad('Action rapide : module inconnu.');
    const label = A.text(x.label, 40, { required: true, msg: 'Chaque action rapide a un nom.' });
    return { label, module: x.module };
  });
  const layout = cfg.mobile && cfg.mobile.layout !== undefined ? cfg.mobile.layout : 'standard';
  if (!LAYOUTS.includes(layout)) bad('Mode mobile inconnu.');
  const spaces = {};
  for (const [k, v] of Object.entries(cfg.spaces || {})) { if (!SPACE_IDS.includes(k) || !['view', 'write', 'manage'].includes(v)) bad('Accès du profil non valides.'); spaces[k] = v; }
  return { blocks: outB, modules, quick, mobile: { layout }, spaces };
}

/** Profil effectif d'une organisation : la version modifiée si elle existe, sinon le profil de base. */
async function profilesOf(orgId) {
  const rows = await db.prepare('SELECT key, config FROM ent_profiles WHERE org_id = ?').all(orgId);
  const over = Object.fromEntries(rows.map((r) => [r.key, parseJSON(r.config, null)]));
  return CATALOG.map((p) => ({ key: p.key, title: p.title, desc: p.desc, tkeys: p.tkeys, custom: Boolean(over[p.key]), config: over[p.key] || p.config }));
}

/** Clé de profil d'un poste : choisie, sinon déduite de son modèle (clé tkey du poste ou de sa direction). */
function keyOfPost(post) {
  if (post.profile_key && BASE[post.profile_key]) return post.profile_key;
  const t = post.tkey || '';
  const hit = CATALOG.find((p) => p.tkeys.includes(t));
  return hit ? hit.key : null;
}

/** Profil de la personne dans cette organisation : direction générale, sinon le poste le plus élevé (directeur > responsable > équipe). */
async function profileKeyFor(req) {
  const dg = await db.prepare('SELECT 1 FROM ent_dg g JOIN ent_people p ON p.id = g.person_id WHERE g.entreprise_id = ? AND p.user_id = ?').get(req.org.entreprise_id, req.user.id);
  const posts = await db.prepare(`SELECT po.title, po.kind, po.tkey, po.profile_key FROM ent_assignments a JOIN ent_people pe ON pe.id = a.person_id JOIN ent_posts po ON po.id = a.post_id
    LEFT JOIN ent_departments d ON d.id = po.department_id WHERE a.org_id = ? AND pe.user_id = ? AND po.active = 1 AND (po.department_id IS NULL OR d.active = 1)`).all(req.org.id, req.user.id);
  const rank = { director: 0, head: 1, staff: 2 };
  posts.sort((x, y) => (rank[x.kind] ?? 3) - (rank[y.kind] ?? 3));
  if (dg && !posts.some((p) => p.profile_key)) return { key: 'dg', posts };
  for (const p of posts) { const k = keyOfPost(p); if (k) return { key: k, posts }; }
  return dg ? { key: 'dg', posts } : { key: null, posts };
}

/** Résout les blocs du profil pour la personne : seuls ceux auxquels elle a accès (espace + module) sont renvoyés. */
async function resolve(req, profile, spacesInfo, dashboardOf) {
  const { modules: reg } = require('./modules');
  const spaces = spacesInfo && spacesInfo.enabled ? spacesInfo.spaces : null;
  const allowedMods = new Set(spaces ? spaces.flatMap((s) => s.modules.map((m) => m.id)) : reg.filter((m) => A.RANK[req.member.role] >= A.RANK[m.min]).map((m) => m.id));
  const spaceOk = (sp) => (spaces ? spaces.some((s) => s.id === sp) : A.can(req, 'admin') || ['projets'].includes(sp));
  const sc = A.scope(req); const d = today();
  const out = [];
  for (const b of profile.config.blocks) {
    try {
      if (b.type === 'tiles') { if (spaceOk(b.space)) { const x = await dashboardOf(req, b.space); out.push({ type: 'tiles', space: b.space, tiles: x.tiles }); } }
      else if (b.type === 'tasks') { out.push({ type: 'tasks', tasks: (await db.prepare("SELECT id, title, due FROM tasks WHERE org_id = ? AND status != 'done' AND assignee_id = ? ORDER BY CASE WHEN due IS NULL THEN 1 ELSE 0 END, due LIMIT 6").all(req.org.id, req.user.id)).map((t) => ({ id: Number(t.id), title: t.title, due: t.due })) }); }
      else if (b.type === 'list') {
        const s = SOURCES[b.source];
        if (s && allowedMods.has(s.module)) { const [sql, args] = s.q(sc, d); out.push({ type: 'list', source: b.source, title: s.title, module: s.module, rows: (await db.prepare(sql).all(req.org.id, ...args)).map((r) => ({ id: Number(r.id), title: r.t, sub: r.s })) }); }
      } else if (b.type === 'component' && allowedMods.has(COMPONENTS[b.name])) out.push({ type: 'component', name: b.name });
    } catch { /* un bloc qui échoue ne casse jamais le profil */ }
  }
  return { blocks: out, modules: profile.config.modules.filter((m) => allowedMods.has(m)), quick: profile.config.quick.filter((x) => allowedMods.has(x.module)) };
}

/** Résumé pour le site à l'ouverture d'une organisation : profil du poste et s'il faut arriver sur « Mon espace de travail » (seulement si la personne a un poste affecté). */
async function summaryFor(req) {
  try {
    if (!req.org.entreprise_id) return null;
    const { key, posts } = await profileKeyFor(req);
    if (!key) return null;
    const p = (await profilesOf(req.org.id)).find((x) => x.key === key);
    return { key, title: p.title, layout: p.config.mobile.layout, landing: posts.length > 0 };
  } catch { return null; }
}

module.exports = { summaryFor, CATALOG, BASE, SOURCES, COMPONENTS, LAYOUTS, BLOCK_TYPES, cleanConfig, profilesOf, keyOfPost, profileKeyFor, resolve };
