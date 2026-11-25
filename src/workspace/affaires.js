'use strict';
// Sous-application « Gestion des affaires » : le dossier d'un marché, de la prospection à la clôture financière, qui relie les directions
// (commercial → technique → finances → achats → RH → opérations → contrôle de gestion → direction générale).
// Chaque passage d'étape appartient à une direction ; les deux décisions clés passent par les circuits de validation de l'entreprise (moteur d'Administration) :
// « Validation d'un marché » (lancée par la direction commerciale, linkType « affaire ») avant le contrat, « Clôture financière du projet » (linkType « affaire_cloture ») avant la clôture. Personne ne valide sa propre demande.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const STAGES = [
  { key: 'prospection', dir: 'dir_commercial' }, { key: 'negociation', dir: 'dir_commercial' }, { key: 'contrat', dir: 'dir_general' }, { key: 'etude', dir: 'dir_technique' },
  { key: 'execution', dir: 'dir_production' }, { key: 'reception', dir: 'dir_technique' }, { key: 'cloture_fin', dir: 'dir_finances' }, { key: 'close', dir: 'dir_general' },
];
const KEYS = STAGES.map((s) => s.key);
const mgr = (req) => A.can(req, 'manager');

// Les deux décisions clés sont des demandes du circuit de l'entreprise, reliées à l'affaire (link_type / link_id) : on lit l'état de la dernière.
const LINK = { market: ['affaire', 'contract'], closure: ['affaire_cloture', 'other'] };
const reqStatus = async (orgId, affaireId, which) => {
  const r = await db.prepare('SELECT status FROM adm_requests WHERE org_id = ? AND link_type = ? AND link_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(orgId, LINK[which][0], affaireId, LINK[which][1]);
  return r ? r.status : null;
};
const view = async (req, r) => ({
  id: Number(r.id), ref: r.ref, name: r.name, client: r.client, amount: Number(r.amount), budget: Number(r.budget), stage: r.stage, dir: (STAGES.find((s) => s.key === r.stage) || {}).dir || null,
  projectId: r.project_id ? Number(r.project_id) : null, siteId: r.site_id ? Number(r.site_id) : null, ownerId: r.owner_id ? Number(r.owner_id) : null, startDate: r.start_date, endDate: r.end_date,
  marketStatus: await reqStatus(req.org.id, r.id, 'market'), closureStatus: await reqStatus(req.org.id, r.id, 'closure'), notes: r.notes, createdAt: r.created_at,
});
const rowOf = async (req, id) => {
  const r = await db.prepare('SELECT * FROM affaires WHERE id = ? AND org_id = ?').get(A.id(id, 'Affaire invalide.'), req.org.id);
  if (!r) throw new HttpError(404, 'Affaire introuvable.');
  return r;
};
async function stats(orgId) {
  const one = async (sql, ...a) => Number((await db.prepare(sql).get(orgId, ...a)).c);
  return {
    open: await one("SELECT COUNT(*) c FROM affaires WHERE org_id = ? AND stage NOT IN ('close', 'perdu')"),
    won: await one("SELECT COUNT(*) c FROM affaires WHERE org_id = ? AND stage NOT IN ('prospection', 'negociation', 'perdu')"),
    lost: await one("SELECT COUNT(*) c FROM affaires WHERE org_id = ? AND stage = 'perdu'"),
    portfolio: await one("SELECT COALESCE(SUM(amount), 0) c FROM affaires WHERE org_id = ? AND stage NOT IN ('close', 'perdu')"),
  };
}
const fields = (b, cur) => {
  const has = (k) => b[k] !== undefined;
  const num = (v, msg) => { const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 1e13) throw new HttpError(400, msg); return n; };
  return {
    name: has('name') || !cur ? A.text(b.name, 160, { required: true, msg: "Indiquez le nom de l'affaire." }) : cur.name,
    client: has('client') ? A.text(b.client, 120) : cur ? cur.client : '',
    amount: has('amount') ? num(b.amount || 0, 'Montant invalide.') : cur ? Number(cur.amount) : 0,
    budget: has('budget') ? num(b.budget || 0, 'Budget invalide.') : cur ? Number(cur.budget) : 0,
    projectId: has('projectId') ? A.idOrNull(b.projectId) : cur ? cur.project_id : null,
    siteId: has('siteId') ? A.idOrNull(b.siteId) : cur ? cur.site_id : null,
    ownerId: has('ownerId') ? A.idOrNull(b.ownerId) : cur ? cur.owner_id : null,
    startDate: has('startDate') ? (A.date(b.startDate) || null) : cur ? cur.start_date : null,
    endDate: has('endDate') ? (A.date(b.endDate) || null) : cur ? cur.end_date : null,
    notes: has('notes') ? A.text(b.notes, 3000) : cur ? cur.notes : '',
  };
};

router.get('/', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM affaires WHERE org_id = ? ORDER BY id DESC LIMIT 300').all(req.org.id);
  res.json({ affaires: await Promise.all(rows.map((r) => view(req, r))), stats: await stats(req.org.id), stages: STAGES, canManage: mgr(req) });
});

router.post('/', async (req, res) => {
  const f = fields(req.body || {}); const t = nowISO();
  const id = Number((await db.prepare('INSERT INTO affaires (org_id, name, client, amount, budget, stage, project_id, site_id, owner_id, start_date, end_date, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, f.name, f.client, f.amount, f.budget, 'prospection', f.projectId, f.siteId, f.ownerId, f.startDate, f.endDate, f.notes, req.user.id, t, t)).lastInsertRowid);
  await db.prepare('UPDATE affaires SET ref = ? WHERE id = ?').run('AFF-' + String(id).padStart(4, '0'), id);
  await A.logActivity(req.org.id, req.user.id, 'affaires', `Affaire créée : ${f.name}`);
  res.status(201).json({ id });
});

/** Fiche de synthèse : ce que chaque direction apporte à l'affaire, calculé sur les données réelles reliées. */
router.get('/:id', async (req, res) => {
  const r = await rowOf(req, req.params.id);
  const o = req.org.id;
  const proj = r.project_id ? await db.prepare('SELECT id, name, status FROM projects WHERE id = ? AND org_id = ?').get(r.project_id, o) : null;
  const site = r.site_id ? await db.prepare('SELECT id, name, status FROM construction_sites WHERE id = ? AND org_id = ?').get(r.site_id, o) : null;
  let progress = null;
  if (site) { const p = await db.prepare('SELECT COALESCE(SUM(weight * progress), 0) w, COALESCE(SUM(weight), 0) t FROM construction_phases WHERE org_id = ? AND site_id = ?').get(o, site.id); if (Number(p.t)) progress = Math.round(Number(p.w) / Number(p.t) * 10) / 10; }
  const q = await db.prepare("SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status <> 'closed') open FROM qhse_items WHERE org_id = ? AND affaire_id = ?").get(o, r.id);
  res.json({
    affaire: await view(req, r), stages: STAGES,
    project: proj ? { id: Number(proj.id), name: proj.name, status: proj.status } : null,
    site: site ? { id: Number(site.id), name: site.name, status: site.status, progress } : null,
    qhse: { total: Number(q.total), open: Number(q.open) },
    margin: Number(r.amount) > 0 && Number(r.budget) > 0 ? { planned: Number(r.amount) - Number(r.budget), pct: Math.round((Number(r.amount) - Number(r.budget)) / Number(r.amount) * 1000) / 10 } : null,
  });
});

router.put('/:id', async (req, res) => {
  const r = await rowOf(req, req.params.id);
  if (!mgr(req)) throw new HttpError(403, 'Seul un responsable peut modifier une affaire.');
  const f = fields(req.body || {}, r);
  await db.prepare('UPDATE affaires SET name = ?, client = ?, amount = ?, budget = ?, project_id = ?, site_id = ?, owner_id = ?, start_date = ?, end_date = ?, notes = ?, updated_at = ? WHERE id = ?')
    .run(f.name, f.client, f.amount, f.budget, f.projectId, f.siteId, f.ownerId, f.startDate, f.endDate, f.notes, nowISO(), r.id);
  res.json({ ok: true });
});

/** Passage d'étape : une étape à la fois ; deux étapes exigent une décision approuvée dans le circuit ; « perdu » possible avant le contrat. */
router.post('/:id/stage', async (req, res) => {
  const r = await rowOf(req, req.params.id);
  if (!mgr(req)) throw new HttpError(403, "Seul un responsable fait avancer une affaire.");
  const to = A.oneOf((req.body || {}).stage, [...KEYS, 'perdu'], undefined, 'Étape inconnue.');
  const from = KEYS.indexOf(r.stage);
  if (r.stage === 'perdu' || r.stage === 'close') throw new HttpError(409, 'Cette affaire est terminée.');
  if (to === 'perdu') {
    if (from >= 2) throw new HttpError(409, "Une affaire sous contrat ne peut plus être déclarée perdue.");
  } else if (KEYS.indexOf(to) !== from + 1) throw new HttpError(409, "Une seule étape à la fois, dans l'ordre.");
  if (to === 'contrat' && await reqStatus(req.org.id, r.id, 'market') !== 'approved') throw new HttpError(409, "Le marché doit d'abord être validé par la direction générale (circuit « Validation d'un marché »).");
  if (to === 'close' && await reqStatus(req.org.id, r.id, 'closure') !== 'approved') throw new HttpError(409, 'La clôture financière doit être validée par la direction administrative et financière.');
  await db.prepare('UPDATE affaires SET stage = ?, updated_at = ? WHERE id = ?').run(to, nowISO(), r.id);
  await A.logActivity(req.org.id, req.user.id, 'affaires', `${r.ref} : étape « ${to} »`);
  res.json({ ok: true, stage: to });
});

router.delete('/:id', async (req, res) => {
  const r = await rowOf(req, req.params.id);
  if (!A.can(req, 'admin')) throw new HttpError(403, 'Seul un administrateur peut supprimer une affaire.');
  if (!['prospection', 'perdu'].includes(r.stage)) throw new HttpError(409, 'Une affaire engagée se conserve pour la traçabilité.');
  await db.prepare('DELETE FROM affaires WHERE id = ? AND org_id = ?').run(r.id, req.org.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.stats = stats;
module.exports.STAGES = STAGES;
