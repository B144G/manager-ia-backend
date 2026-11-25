'use strict';
// Espaces de DIRECTION de département : chaque directeur a son PROPRE espace (pilotage, validations, rapports, tâches, notes, objectifs), séparé de l'espace opérationnel du personnel.
// Règles (appliquées côté SERVEUR : garde des espaces + contrôles ici) :
//  - le poste « directeur de X » donne l'espace Direction de X (responsable) et l'espace opérationnel de X en VISITEUR (lecture seule) ;
//  - un poste du personnel de X donne l'espace opérationnel de X et JAMAIS un espace de direction ;
//  - un directeur ne voit pas les autres départements (sauf affectation explicite en visiteur) ;
//  - propriétaire, administrateurs et direction générale voient tout.
// Tant que le propriétaire n'a pas activé le réglage « espaces de direction » (ou si DIRECTION_SPACES=off), AUCUN espace de direction n'existe : les entreprises actuelles ne changent pas.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError } = require('../util');

/** Espaces de direction : id → espace opérationnel du département, directions du modèle qui y mènent, départements du modèle (équipe). */
const DIRS = {
  dir_general: { title: 'Direction générale', icon: 'dashboard', desc: "Pilotage stratégique : résultats, projets, validations et décisions de la direction générale.", op: 'direction', directions: [], depts: ['pilotage'], dg: true },
  dir_technique: { title: 'Direction technique', icon: 'construction', desc: "Pilotage technique : avancement des chantiers, qualité, coûts, équipements, tâches et dossiers du directeur technique.", op: 'operations', directions: ['dtech'], depts: ['production'] },
  dir_commercial: { title: 'Direction commerciale', icon: 'crm', desc: "Pilotage commercial : indicateurs, objectifs, validations, tâches et dossiers du directeur.", op: 'commercial', directions: ['dcom'], depts: ['commercial'] },
  dir_finances: { title: 'Direction administrative et financière', icon: 'accounting', desc: "Pilotage financier : trésorerie, dépenses à valider, objectifs, tâches et dossiers du DAF.", op: 'finances', directions: ['daf'], depts: ['finance'] },
  dir_rh: { title: 'Direction des ressources humaines', icon: 'hr', desc: "Pilotage RH : effectifs, congés à valider, objectifs, tâches et dossiers du DRH.", op: 'rh', directions: ['drh'], depts: ['rh'] },
  dir_production: { title: 'Direction de la production', icon: 'production', desc: "Pilotage de la production et des travaux : ordres, chantiers, objectifs, tâches et dossiers du directeur.", op: 'operations', directions: ['dprod'], depts: ['production'] },
  dir_logistique: { title: 'Direction de la logistique', icon: 'logistics', desc: "Pilotage logistique : livraisons, flotte, objectifs, tâches et dossiers du directeur.", op: 'operations', directions: ['dlog'], depts: ['logistique'] },
  dir_stock: { title: 'Direction du stockage et des achats', icon: 'stock', desc: "Pilotage des stocks et des achats : ruptures, commandes à valider, objectifs, tâches et dossiers du directeur.", op: 'stock', directions: ['dstock'], depts: ['achats'] },
  dir_marketing: { title: 'Direction marketing', icon: 'marketing', desc: "Pilotage marketing : campagnes, clients, objectifs, tâches et dossiers du directeur.", op: 'commercial', directions: ['dmkt'], depts: ['marketing'] },
  dir_it: { title: 'Direction informatique et maintenance', icon: 'maintenance', desc: "Pilotage informatique et maintenance : interventions, parc, objectifs, tâches et dossiers du directeur.", op: 'operations', directions: ['dit'], depts: ['informatique'] },
  dir_securite: { title: 'Direction de la sécurité', icon: 'legal', desc: "Pilotage sécurité et conformité : obligations, objectifs, tâches et dossiers du directeur.", op: 'gestion', directions: ['dsec'], depts: ['securite'] },
};
const DIR_IDS = Object.keys(DIRS);
const isDir = (id) => Boolean(DIRS[id]);
const DIR_OF_DIRECTION = {}; for (const [id, d] of Object.entries(DIRS)) for (const k of d.directions) DIR_OF_DIRECTION[k] = id;

/** Interrupteur général (variable d'environnement) : DIRECTION_SPACES=off|0|false|non coupe les espaces de direction pour toutes les entreprises. */
const globalOff = () => /^(off|0|false|no|non|disabled|desactive|désactivé)$/i.test(String(process.env.DIRECTION_SPACES || '').trim());
/** Réglage de l'organisation (désactivé par défaut : aucune entreprise existante ne change tant que le propriétaire ne l'active pas). */
async function enabled(orgId) {
  if (globalOff()) return false;
  const r = await db.prepare('SELECT dir_spaces FROM ent_setup WHERE org_id = ?').get(orgId);
  return Boolean(r && Number(r.dir_spaces));
}
async function setEnabled(orgId, userId, on) {
  await db.prepare(`INSERT INTO ent_setup (org_id, steps, template, dir_spaces, updated_by, updated_at) VALUES (?, '{}', '', ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET dir_spaces = EXCLUDED.dir_spaces, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`).run(orgId, on ? 1 : 0, userId, nowISO());
}

/** Espace de direction d'un poste de directeur d'après sa direction (clé de modèle `tkey` de la direction). */
async function dirSpaceOfPost(post) {
  if (post.direction_id) { const d = await db.prepare('SELECT tkey FROM ent_directions WHERE id = ?').get(post.direction_id); if (d && DIR_OF_DIRECTION[d.tkey]) return DIR_OF_DIRECTION[d.tkey]; }
  const m = /^dir_(\w+)$/.exec(post.tkey || '');
  return m && DIR_OF_DIRECTION[m[1]] ? DIR_OF_DIRECTION[m[1]] : null;
}

// ---------- Routes d'un espace de direction (montées sous /<id> : le chemin est rattaché à l'espace par la garde des espaces) ----------
async function guardLevel(req, id) {
  const sp = require('./spaces');
  const eff = await sp.effective(req);
  if (!eff.enabled || !eff.levels[id]) throw Object.assign(new HttpError(403, "Cet espace de direction n'est pas dans vos espaces."), { errorCode: 'space_denied' });
  return eff.levels[id];
}
const audit = (req, id, entity, rid, action, before, after) => W.audit(req, 'dir_' + entity, rid, action, { space: id, ...(before || {}) }, after ? { space: id, ...after } : null);

function routerFor(id) {
  const D = DIRS[id];
  const r = express.Router({ mergeParams: true });
  const needManage = async (req) => { const lv = await guardLevel(req, id); if (lv !== 'manage') throw Object.assign(new HttpError(403, "Seul le directeur de ce département gère cet espace : vous y êtes en consultation."), { errorCode: 'space_readonly' }); return lv; };
  const who = async (req) => ({ level: await guardLevel(req, id) });

  // Pilotage : indicateurs de l'espace opérationnel, équipe (effectifs, charge), objectifs.
  r.get('/summary', async (req, res) => {
    const level = await guardLevel(req, id);
    const o = req.org.id; const sc = A.scope(req); const today = nowISO().slice(0, 10);
    const dash = await require('./spaces').dashboardOf(req, D.op);
    const posts = await db.prepare(`SELECT p.id, p.title, p.headcount, p.kind, d.name AS dept, (SELECT COUNT(*) FROM ent_assignments a WHERE a.post_id = p.id) AS n
      FROM ent_posts p JOIN ent_departments d ON d.id = p.department_id WHERE p.org_id = ? AND p.active = 1 AND d.active = 1 AND d.tkey IN (${D.depts.map(() => '?').join(',')})`).all(o, ...D.depts);
    const members = await db.prepare(`SELECT DISTINCT pe.user_id, pe.full_name FROM ent_assignments a JOIN ent_posts p ON p.id = a.post_id JOIN ent_departments d ON d.id = p.department_id JOIN ent_people pe ON pe.id = a.person_id
      WHERE a.org_id = ? AND pe.user_id IS NOT NULL AND d.tkey IN (${D.depts.map(() => '?').join(',')})`).all(o, ...D.depts);
    const load = [];
    for (const m of members) {
      const t = await db.prepare(`SELECT COUNT(*) FILTER (WHERE status != 'done') AS open, COUNT(*) FILTER (WHERE status != 'done' AND due IS NOT NULL AND due < ?) AS late, COUNT(*) FILTER (WHERE status = 'done') AS done FROM tasks WHERE org_id = ? AND assignee_id = ?${sc.sql}`).get(today, o, m.user_id, ...sc.args);
      load.push({ name: m.full_name, open: Number(t.open) || 0, late: Number(t.late) || 0, done: Number(t.done) || 0 });
    }
    load.sort((a, b) => b.late - a.late || b.open - a.open);
    const seats = posts.reduce((s, p) => s + Number(p.headcount), 0); const filled = posts.reduce((s, p) => s + Math.min(Number(p.n), Number(p.headcount)), 0);
    const objectives = (await db.prepare('SELECT * FROM dir_objectives WHERE org_id = ? AND space = ? ORDER BY CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, id').all(o, id)).map(objView);
    res.json({ space: { id, title: D.title, opSpace: D.op, level }, tiles: dash.tiles, team: { seats, filled, vacancies: Math.max(seats - filled, 0), members: members.length, load: load.slice(0, 8) }, objectives, today });
  });

  // Indicateurs réels du département (aucun chiffre inventé : « non disponible » + ce qu'il faut renseigner).
  r.get('/kpis', async (req, res) => {
    const level = await guardLevel(req, id);
    res.json({ space: { id, title: D.title, level }, kpis: await require('./ent-kpi').kpisFor(req, id), missions: MISSIONS[id] || [] });
  });

  // Circuits de validation de direction (moteur d'Administration) : à valider par la personne, décision, journal.
  r.get('/workflows', async (req, res) => {
    await guardLevel(req, id);
    const WF = require('./ent-workflows');
    res.json({ inbox: await WF.inboxOf(req) });
  });
  r.post('/workflows/requests/:rid/:decision', async (req, res, next) => {
    await needManage(req);
    const dec = req.params.decision;
    if (!['approve', 'reject'].includes(dec)) throw new HttpError(404, 'Introuvable.');
    req.params.id = req.params.rid; // le moteur de circuits lit :id
    await W.audit(req, 'dir_workflow', Number(req.params.rid), dec, { space: id }, { space: id });
    return require('./adm-flow').handlers[dec](req, res, next); // le moteur de circuits répond lui-même (et signale ses refus par next)
  });

  // Validations : file d'approbation du département.
  r.get('/validations', async (req, res) => {
    await guardLevel(req, id);
    const o = req.org.id; const out = [];
    const add = async (kind, title, module, sql, ...a) => { try { const rows = await db.prepare(sql).all(o, ...a); out.push({ kind, title, module, decide: kind === 'leave', items: rows.map((x) => ({ id: Number(x.id), title: x.t, sub: x.s, extra: x.x || '' })) }); } catch { /* source absente */ } };
    if (id === 'dir_rh') await add('leave', 'Congés à traiter', 'hr', "SELECT l.id, COALESCE(e.name, 'Personne') AS t, l.start || ' → ' || l.end AS s, l.kind AS x FROM leaves l LEFT JOIN employees e ON e.id = l.employee_id WHERE l.org_id = ? AND l.status = 'pending' ORDER BY l.start LIMIT 30");
    if (id === 'dir_finances') await add('expense', 'Dépenses à valider', 'budget', "SELECT id, label AS t, category || ' · ' || CAST(amount AS TEXT) AS s FROM expense_requests WHERE org_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 30");
    if (id === 'dir_stock') await add('order', 'Commandes à valider', 'purchasing', "SELECT p.id, COALESCE(i.name, 'Article') AS t, CAST(p.quantity AS TEXT) AS s FROM purchase_orders p LEFT JOIN stock_items i ON i.id = p.item_id WHERE p.org_id = ? AND p.status = 'pending' ORDER BY p.id DESC LIMIT 30");
    if (id === 'dir_commercial' || id === 'dir_marketing') await add('ticket', 'Demandes clients ouvertes', 'support', "SELECT id, subject AS t, customer_name AS s FROM tickets WHERE org_id = ? AND status = 'open' ORDER BY id DESC LIMIT 30");
    if (['dir_production', 'dir_it', 'dir_logistique'].includes(id)) await add('maintenance', 'Interventions ouvertes', 'maintenance', "SELECT id, title AS t, priority AS s FROM maintenance_orders WHERE org_id = ? AND status = 'open' ORDER BY id DESC LIMIT 30");
    res.json({ queues: out });
  });
  r.put('/validations/leave/:lid', async (req, res) => {
    if (id !== 'dir_rh') throw new HttpError(404, 'Introuvable.');
    await needManage(req);
    const l = await db.prepare('SELECT * FROM leaves WHERE id = ? AND org_id = ?').get(A.id(req.params.lid), req.org.id);
    if (!l) throw new HttpError(404, 'Demande introuvable.');
    if (l.status !== 'pending') throw new HttpError(400, 'Cette demande a déjà été traitée.');
    const e = await db.prepare('SELECT * FROM employees WHERE id = ? AND org_id = ?').get(l.employee_id, req.org.id);
    if (e && e.user_id && Number(e.user_id) === Number(req.user.id)) throw new HttpError(403, 'Une autre personne doit valider votre propre congé.');
    const status = A.oneOf((req.body || {}).decision, ['approved', 'refused'], undefined, 'Décision inconnue.');
    await db.prepare('UPDATE leaves SET status = ?, decided_by = ? WHERE id = ?').run(status, req.user.id, l.id);
    await A.logActivity(req.org.id, req.user.id, 'hr', `Congé de ${e ? e.name : 'une personne'} : ${status === 'approved' ? 'accepté' : 'refusé'} (direction RH)`);
    await audit(req, id, 'validation', l.id, 'leave_decision', { status: l.status }, { status });
    res.json({ ok: true });
  });

  // Rapports : écrans et exports existants du département, accessibles selon les droits de la personne.
  r.get('/reports', async (req, res) => { await guardLevel(req, id); res.json({ opSpace: D.op, links: REPORTS[id] || [] }); });

  // Tâches propres à la direction : jamais visibles du personnel (table séparée, accès par l'espace de direction seulement).
  r.get('/tasks', async (req, res) => {
    await guardLevel(req, id);
    const rows = await db.prepare("SELECT * FROM dir_tasks WHERE org_id = ? AND space = ? ORDER BY CASE status WHEN 'todo' THEN 0 ELSE 1 END, CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, id DESC LIMIT 200").all(req.org.id, id);
    res.json({ tasks: rows.map((t) => ({ id: Number(t.id), title: t.title, notes: t.notes, due: t.due, priority: t.priority, status: t.status, doneAt: t.done_at })) });
  });
  r.post('/tasks', async (req, res) => {
    await needManage(req); const b = req.body || {};
    const title = A.text(b.title, 150, { required: true, msg: 'Indiquez la tâche.' });
    const tid = Number((await db.prepare('INSERT INTO dir_tasks (org_id, space, title, notes, due, priority, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, title, A.text(b.notes, 1000), A.date(b.due), A.oneOf(b.priority, ['low', 'normal', 'high'], 'normal', 'Priorité inconnue.'), req.user.id, nowISO())).lastInsertRowid);
    await audit(req, id, 'task', tid, 'create', null, { title });
    res.status(201).json({ id: tid });
  });
  r.put('/tasks/:tid', async (req, res) => {
    await needManage(req); const b = req.body || {};
    const t = await db.prepare('SELECT * FROM dir_tasks WHERE id = ? AND org_id = ? AND space = ?').get(A.id(req.params.tid), req.org.id, id);
    if (!t) throw new HttpError(404, 'Tâche introuvable.');
    const status = b.status === undefined ? t.status : A.oneOf(b.status, ['todo', 'done'], undefined, 'État inconnu.');
    await db.prepare('UPDATE dir_tasks SET title = ?, notes = ?, due = ?, priority = ?, status = ?, done_at = ? WHERE id = ?').run(
      b.title === undefined ? t.title : A.text(b.title, 150, { required: true, msg: 'Indiquez la tâche.' }), b.notes === undefined ? t.notes : A.text(b.notes, 1000), b.due === undefined ? t.due : A.date(b.due),
      b.priority === undefined ? t.priority : A.oneOf(b.priority, ['low', 'normal', 'high'], undefined, 'Priorité inconnue.'), status, status === 'done' ? (t.done_at || nowISO()) : null, t.id);
    await audit(req, id, 'task', t.id, 'update', { status: t.status }, { status });
    res.json({ ok: true });
  });
  r.delete('/tasks/:tid', async (req, res) => {
    await needManage(req);
    const x = await db.prepare('DELETE FROM dir_tasks WHERE id = ? AND org_id = ? AND space = ?').run(A.id(req.params.tid), req.org.id, id);
    if (!x.changes) throw new HttpError(404, 'Tâche introuvable.');
    await audit(req, id, 'task', A.id(req.params.tid), 'delete', null, null);
    res.json({ ok: true });
  });

  // Dossiers (notes) du directeur.
  r.get('/notes', async (req, res) => {
    await guardLevel(req, id);
    res.json({ notes: (await db.prepare('SELECT * FROM dir_notes WHERE org_id = ? AND space = ? ORDER BY updated_at DESC LIMIT 200').all(req.org.id, id)).map((n) => ({ id: Number(n.id), title: n.title, body: n.body, updatedAt: n.updated_at })) });
  });
  r.post('/notes', async (req, res) => {
    await needManage(req); const b = req.body || {}; const now = nowISO();
    const nid = Number((await db.prepare('INSERT INTO dir_notes (org_id, space, title, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, A.text(b.title, 150, { required: true, msg: 'Donnez un titre au dossier.' }), A.text(b.body, 20000), req.user.id, now, now)).lastInsertRowid);
    await audit(req, id, 'note', nid, 'create', null, { title: A.text(b.title, 150) });
    res.status(201).json({ id: nid });
  });
  r.put('/notes/:nid', async (req, res) => {
    await needManage(req); const b = req.body || {};
    const n = await db.prepare('SELECT * FROM dir_notes WHERE id = ? AND org_id = ? AND space = ?').get(A.id(req.params.nid), req.org.id, id);
    if (!n) throw new HttpError(404, 'Dossier introuvable.');
    await db.prepare('UPDATE dir_notes SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(b.title === undefined ? n.title : A.text(b.title, 150, { required: true, msg: 'Donnez un titre au dossier.' }), b.body === undefined ? n.body : A.text(b.body, 20000), nowISO(), n.id);
    await audit(req, id, 'note', n.id, 'update', null, { title: n.title });
    res.json({ ok: true });
  });
  r.delete('/notes/:nid', async (req, res) => {
    await needManage(req);
    const x = await db.prepare('DELETE FROM dir_notes WHERE id = ? AND org_id = ? AND space = ?').run(A.id(req.params.nid), req.org.id, id);
    if (!x.changes) throw new HttpError(404, 'Dossier introuvable.');
    await audit(req, id, 'note', A.id(req.params.nid), 'delete', null, null);
    res.json({ ok: true });
  });

  // Objectifs du département.
  const num = (v, msg) => { const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : v; if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new HttpError(400, msg); return n; };
  r.post('/objectives', async (req, res) => {
    await needManage(req); const b = req.body || {}; const now = nowISO();
    const oid = Number((await db.prepare('INSERT INTO dir_objectives (org_id, space, title, unit, target, current, due, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, id,
      A.text(b.title, 150, { required: true, msg: "Indiquez l'objectif." }), A.text(b.unit, 20), num(b.target, 'Cible invalide.'), b.current === undefined || b.current === '' ? 0 : num(b.current, 'Valeur invalide.'), A.date(b.due), req.user.id, now, now)).lastInsertRowid);
    await audit(req, id, 'objective', oid, 'create', null, { title: A.text(b.title, 150) });
    res.status(201).json({ id: oid });
  });
  r.put('/objectives/:oid', async (req, res) => {
    await needManage(req); const b = req.body || {};
    const o = await db.prepare('SELECT * FROM dir_objectives WHERE id = ? AND org_id = ? AND space = ?').get(A.id(req.params.oid), req.org.id, id);
    if (!o) throw new HttpError(404, 'Objectif introuvable.');
    await db.prepare('UPDATE dir_objectives SET title = ?, unit = ?, target = ?, current = ?, due = ?, updated_at = ? WHERE id = ?').run(b.title === undefined ? o.title : A.text(b.title, 150, { required: true, msg: "Indiquez l'objectif." }), b.unit === undefined ? o.unit : A.text(b.unit, 20),
      b.target === undefined ? o.target : num(b.target, 'Cible invalide.'), b.current === undefined ? o.current : num(b.current, 'Valeur invalide.'), b.due === undefined ? o.due : A.date(b.due), nowISO(), o.id);
    await audit(req, id, 'objective', o.id, 'update', { current: Number(o.current) }, { current: b.current === undefined ? Number(o.current) : Number(b.current) });
    res.json({ ok: true });
  });
  r.delete('/objectives/:oid', async (req, res) => {
    await needManage(req);
    const x = await db.prepare('DELETE FROM dir_objectives WHERE id = ? AND org_id = ? AND space = ?').run(A.id(req.params.oid), req.org.id, id);
    if (!x.changes) throw new HttpError(404, 'Objectif introuvable.');
    await audit(req, id, 'objective', A.id(req.params.oid), 'delete', null, null);
    res.json({ ok: true });
  });
  void who;
  return r;
}
const objView = (o) => ({ id: Number(o.id), title: o.title, unit: o.unit, target: Number(o.target), current: Number(o.current), due: o.due, pct: Number(o.target) ? Math.max(0, Math.min(100, Math.round((Number(o.current) / Number(o.target)) * 100))) : 0 });

/** Missions du directeur : actions renvoyant vers les écrans existants (aucune donnée ici : le cockpit n'a que des liens). */
const MISSIONS = {
  dir_general: [{ label: 'Valider les budgets et les investissements', module: 'budget' }, { label: 'Suivre les résultats commerciaux et financiers', module: 'accounting' }, { label: 'Contrôler la rentabilité des projets', module: 'projects' }, { label: 'Superviser les risques de l\'entreprise', module: 'administration' }, { label: 'Suivre les décisions et les plans d\'action', module: 'dashboard' }],
  dir_finances: [{ label: 'Élaborer et suivre le budget annuel', module: 'budget' }, { label: 'Superviser la comptabilité', module: 'accounting' }, { label: 'Superviser la trésorerie et les banques', module: 'treasury' }, { label: 'Suivre créances et dettes', module: 'crm' }, { label: 'Superviser les déclarations fiscales', module: 'fiscal' }],
  dir_technique: [{ label: 'Suivre les chantiers et leur avancement', module: 'construction' }, { label: 'Planifier les travaux et les projets', module: 'projects' }, { label: 'Contrôler la qualité et les réserves', module: 'construction' }, { label: 'Suivre les équipements et la maintenance', module: 'maintenance' }, { label: 'Suivre les coûts techniques', module: 'budget' }],
  dir_production: [{ label: 'Organiser les activités et les ordres de fabrication', module: 'production' }, { label: 'Contrôler rendements et pertes', module: 'production' }, { label: 'Suivre les livraisons', module: 'logistics' }, { label: 'Identifier les blocages opérationnels', module: 'maintenance' }],
  dir_logistique: [{ label: 'Planifier les tournées et les livraisons', module: 'logistics' }, { label: 'Suivre la flotte et ses échéances', module: 'logistics' }, { label: 'Maîtriser les coûts de transport', module: 'logistics' }, { label: 'Suivre les interventions sur les véhicules', module: 'maintenance' }],
  dir_stock: [{ label: 'Identifier les besoins et élaborer le plan d\'achats', module: 'purchasing' }, { label: 'Consulter et comparer les fournisseurs', module: 'purchasing' }, { label: 'Prévenir les ruptures de stock', module: 'stock' }, { label: 'Organiser les inventaires', module: 'stock' }, { label: 'Suivre livraisons et réceptions', module: 'purchasing' }],
  dir_rh: [{ label: 'Suivre les effectifs et les affectations', module: 'hr' }, { label: 'Superviser les recrutements', module: 'hr' }, { label: 'Superviser congés, présences et paie', module: 'payroll' }, { label: 'Piloter formations et compétences', module: 'talents' }],
  dir_commercial: [{ label: 'Piloter le pipeline et les opportunités', module: 'commercial' }, { label: 'Suivre clients, devis et factures', module: 'crm' }, { label: 'Fixer et suivre les objectifs de vente', module: 'commercial' }, { label: 'Suivre la satisfaction et les demandes clients', module: 'support' }],
  dir_marketing: [{ label: 'Piloter les campagnes et leur budget', module: 'marketing' }, { label: 'Suivre les prospects générés', module: 'commercial' }, { label: 'Animer l\'assistant commercial', module: 'sales' }],
  dir_it: [{ label: 'Suivre les interventions et la disponibilité', module: 'maintenance' }, { label: 'Superviser les intégrations', module: 'integrations' }, { label: 'Suivre la sécurité des comptes', module: 'integrations' }],
  dir_securite: [{ label: 'Suivre obligations légales et conformité', module: 'legal' }, { label: 'Suivre contrats et litiges', module: 'legal' }, { label: 'Contrôler le contrôle interne', module: 'administration' }],
};

/** Écrans existants proposés comme « rapports » (liens ; la personne n'ouvre que ce que ses droits permettent). */
const REPORTS = {
  dir_general: [{ label: 'Tableau de bord', module: 'dashboard' }, { label: 'Comptabilité', module: 'accounting' }, { label: 'Clients et ventes', module: 'crm' }, { label: 'Projets et tâches', module: 'projects' }],
  dir_technique: [{ label: 'Chantiers (BTP)', module: 'construction' }, { label: 'Maintenance', module: 'maintenance' }, { label: 'Projets et tâches', module: 'projects' }],
  dir_commercial: [{ label: 'Clients et ventes', module: 'crm' }, { label: 'Suivi commercial', module: 'commercial' }, { label: 'Service client', module: 'support' }],
  dir_finances: [{ label: 'Comptabilité', module: 'accounting' }, { label: 'Trésorerie', module: 'treasury' }, { label: 'Budget', module: 'budget' }, { label: 'Fiscalité et liasse', module: 'fiscal' }],
  dir_rh: [{ label: 'Ressources humaines', module: 'hr' }, { label: 'Paie', module: 'payroll' }, { label: 'Talents et compétences', module: 'talents' }],
  dir_production: [{ label: 'Production', module: 'production' }, { label: 'Chantiers (BTP)', module: 'construction' }, { label: 'Maintenance', module: 'maintenance' }],
  dir_logistique: [{ label: 'Logistique', module: 'logistics' }, { label: 'Maintenance', module: 'maintenance' }],
  dir_stock: [{ label: 'Stock et achats', module: 'stock' }, { label: 'Achats', module: 'purchasing' }],
  dir_marketing: [{ label: 'Marketing', module: 'marketing' }, { label: 'Assistant commercial', module: 'sales' }],
  dir_it: [{ label: 'Maintenance', module: 'maintenance' }, { label: 'Intégrations', module: 'integrations' }],
  dir_securite: [{ label: 'Juridique et conformité', module: 'legal' }, { label: 'Administration', module: 'administration' }],
};

module.exports = { DIRS, DIR_IDS, isDir, DIR_OF_DIRECTION, routerFor, enabled, setEnabled, globalOff, dirSpaceOfPost };
