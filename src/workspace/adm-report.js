'use strict';
// Administration · 8. Reporting administratif : tableau de bord (procédures à réviser, documents à archiver, circuits en retard, conflits de séparation des tâches,
// contrats à échéance, conformité en retard, demandes de moyens), liens vers Réunions et objectifs (lus seulement si ces modules sont présents),
// rapport mensuel en PDF et Excel.
// Réunions = module Réunions (tables mtg_) ; management par objectifs = RH talents (table rh_goals) : jamais modifiés ici. Sans RH talents,
// un petit tableau d'objectifs administratifs (adm_goals) tient lieu de suivi.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./adm-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });

async function sweepAll(orgId) {
  const out = {};
  for (const [k, f] of [['sops', () => require('./adm-sop').sweep(orgId)], ['docs', () => require('./adm-docs').sweep(orgId)], ['flow', () => require('./adm-flow').sweep(orgId)], ['contracts', () => require('./adm-contracts').sweep(orgId)], ['assets', () => require('./adm-assets').sweep(orgId)]]) out[k] = await L.safe(f, 0);
  return out;
}

/** Réunions : si le module est présent, prochaines réunions non confidentielles ; sinon un simple lien vide. */
async function meetings(orgId) {
  if (!await L.hasTable('mtg_meetings')) return { available: false, upcoming: [], count: 0 };
  return L.safe(async () => {
    const today = L.today();
    const rows = await db.prepare("SELECT id, title, date, start_time, status FROM mtg_meetings WHERE org_id = ? AND date >= ? AND date <= ? AND confidential = 0 AND status NOT IN ('cancelled','held','closed') ORDER BY date, start_time LIMIT 20").all(orgId, today, L.addDays(today, 30));
    return { available: true, count: rows.length, upcoming: rows.slice(0, 5).map((m) => ({ id: Number(m.id), title: m.title, date: m.date, time: m.start_time })) };
  }, { available: false, upcoming: [], count: 0 });
}
/** Objectifs : RH talents s'il est là (objectifs d'entreprise et de service seulement, jamais individuels), sinon le suivi administratif. */
async function objectives(orgId) {
  if (await L.hasTable('rh_goals')) {
    const r = await L.safe(async () => {
      const rows = await db.prepare("SELECT id, title, level, unit, target_value, current_value, due_date, status FROM rh_goals WHERE org_id = ? AND level <> 'individual' AND status NOT IN ('draft','cancelled') ORDER BY due_date LIMIT 50").all(orgId);
      const pct = (g) => (g.target_value ? Math.max(0, Math.min(100, Math.round((Number(g.current_value) / Number(g.target_value)) * 100))) : 0);
      return { source: 'rh', count: rows.length, avgProgress: rows.length ? Math.round(rows.reduce((s, g) => s + pct(g), 0) / rows.length) : 0, items: rows.slice(0, 6).map((g) => ({ id: Number(g.id), title: g.title, level: g.level, progress: pct(g), dueDate: g.due_date, status: g.status })) };
    }, null);
    if (r) return r;
  }
  const rows = await db.prepare('SELECT * FROM adm_goals WHERE org_id = ? ORDER BY due_date LIMIT 50').all(orgId);
  const pct = (g) => (Number(g.target) ? Math.max(0, Math.min(100, Math.round((Number(g.current) / Number(g.target)) * 100))) : 0);
  return { source: 'adm', count: rows.length, avgProgress: rows.length ? Math.round(rows.reduce((s, g) => s + pct(g), 0) / rows.length) : 0, items: rows.slice(0, 6).map((g) => ({ id: Number(g.id), title: g.title, level: 'admin', progress: pct(g), dueDate: g.due_date, status: g.status })) };
}

async function dashboard(req) {
  const orgId = req.org.id; const today = L.today();
  const cfg = req.admCfg = await L.getConfig(orgId);
  await sweepAll(orgId);
  const C = require('./adm-control'); const D = require('./adm-docs'); const F = require('./adm-flow'); const K = require('./adm-contracts'); const M = require('./adm-assets');
  const names = await L.nameMap(orgId);
  const sops = await db.prepare("SELECT id, title, next_review, owner_id FROM adm_sops WHERE org_id = ? AND status = 'approved' AND next_review IS NOT NULL AND next_review <= ? ORDER BY next_review").all(orgId, L.addDays(today, cfg.sopReminderDays));
  const sopAll = await db.prepare('SELECT status FROM adm_sops WHERE org_id = ?').all(orgId);
  const docs = await D.dueLists(req, cfg);
  const stepsLate = await db.prepare("SELECT s.name, s.due_at, r.id AS rid, r.title, r.ref, r.requester_id FROM adm_request_steps s JOIN adm_requests r ON r.id = s.request_id WHERE s.org_id = ? AND s.status = 'active' AND r.status = 'pending' AND s.due_at IS NOT NULL AND s.due_at < ? ORDER BY s.due_at").all(orgId, nowISO());
  const flow = await F.stats(orgId);
  const conflicts = await C.conflicts(orgId, {});
  const maturity = await C.maturity(orgId);
  const contracts = await K.summary(orgId); const means = await M.summary(orgId);
  const controlsLate = await C.overdueCount(orgId);
  const actionsLate = Number((await db.prepare("SELECT COUNT(*) c FROM adm_actions WHERE org_id = ? AND status IN ('todo','doing') AND due_date < ?").get(orgId, today)).c);
  const reqOpen = await db.prepare("SELECT id, title, kind, requester_id FROM adm_means_requests WHERE org_id = ? AND status = 'new' ORDER BY id DESC LIMIT 5").all(orgId);
  const unitsN = Number((await db.prepare('SELECT COUNT(*) c FROM adm_units WHERE org_id = ?').get(orgId)).c);
  const raci = await require('./adm-org').raciMatrix(orgId);
  const delegs = await require('./adm-org').activeDelegations(orgId);
  const costs = await db.prepare('SELECT event_date, amount FROM adm_asset_events WHERE org_id = ? AND event_date >= ?').all(orgId, L.addMonths(today, -5).slice(0, 7) + '-01');
  const costByMonth = []; for (let i = 5; i >= 0; i--) { const m = L.addMonths(today, -i).slice(0, 7); costByMonth.push({ month: m, amount: costs.filter((c) => c.event_date.slice(0, 7) === m).reduce((s, c) => s + Number(c.amount), 0) }); }
  const kpis = {
    sopsToReview: sops.length, docsToArchive: docs.toArchive.length, docsToDestroy: docs.toDestroy.length, awaitingDestruction: docs.awaiting.length, flowsLate: stepsLate.length, flowsPending: flow.pending,
    sodConflicts: conflicts.summary.open, contractAlerts: contracts.contractAlerts, complianceLate: contracts.complianceOverdue, complianceSoon: contracts.complianceSoon, meansRequests: means.requestsNew, assetDeadlinesLate: means.deadlinesOverdue,
    controlsLate, actionsLate, raciIssues: raci.issues.length, maturityScore: maturity.score,
  };
  const severity = { flowsLate: 3, sodConflicts: 3, complianceLate: 3, contractAlerts: 2, docsToDestroy: 1, docsToArchive: 1, sopsToReview: 1, assetDeadlinesLate: 2, controlsLate: 2, actionsLate: 2, meansRequests: 1, awaitingDestruction: 2 };
  const LABEL = { flowsLate: 'circuit(s) de validation en retard', sodConflicts: 'conflit(s) de séparation des tâches', complianceLate: 'obligation(s) de conformité en retard', contractAlerts: 'contrat(s) à échéance ou préavis', docsToDestroy: 'document(s) arrivé(s) au terme de leur conservation', docsToArchive: 'document(s) à archiver', sopsToReview: 'procédure(s) à réviser', assetDeadlinesLate: 'échéance(s) de moyens dépassée(s)', controlsLate: 'contrôle(s) en retard', actionsLate: 'action(s) corrective(s) en retard', meansRequests: 'demande(s) de moyens à traiter', awaitingDestruction: 'destruction(s) à valider' };
  const todo = Object.keys(severity).filter((k) => kpis[k] > 0).map((k) => ({ key: k, count: kpis[k], label: LABEL[k], severity: severity[k] })).sort((a, b) => b.severity - a.severity || b.count - a.count);
  return {
    generatedAt: nowISO(), kpis, todo, maturity: { score: maturity.score, level: maturity.level, levelLabel: maturity.levelLabel },
    lists: {
      sops: sops.slice(0, 5).map((s) => ({ id: Number(s.id), title: s.title, nextReview: s.next_review, owner: names.get(Number(s.owner_id)) || null, overdue: s.next_review < today })),
      docsToArchive: docs.toArchive.slice(0, 5).map((d) => ({ id: d.id, title: d.title, due: d.archiveDue })), docsToDestroy: docs.toDestroy.slice(0, 5).map((d) => ({ id: d.id, title: d.title, due: d.destroyDue })),
      flows: stepsLate.slice(0, 5).map((s) => ({ requestId: Number(s.rid), ref: s.ref, title: s.title, step: s.name, dueAt: s.due_at, requester: names.get(Number(s.requester_id)) || null })),
      conflicts: conflicts.conflicts.filter((c) => !c.waived).slice(0, 5).map((c) => ({ user: c.user, funcA: c.funcAName, funcB: c.funcBName, severity: c.severity })),
      contracts: contracts.alertList.slice(0, 5).map((c) => ({ id: c.id, title: c.title, alert: c.alert, alertLabel: c.alertLabel, effectiveEnd: c.effectiveEnd, noticeDeadline: c.noticeDeadline })),
      compliance: contracts.overdueList.slice(0, 5).map((c) => ({ id: c.id, title: c.title, dueDate: c.dueDate, responsible: c.responsible })),
      means: reqOpen.map((r) => ({ id: Number(r.id), title: r.title, kind: r.kind, requester: names.get(Number(r.requester_id)) || null })),
    },
    charts: {
      requestsByMonth: flow.byMonth, requestsByKind: flow.byKind, sopsByStatus: ['draft', 'reviewed', 'approved', 'obsolete'].map((s) => ({ key: s, count: sopAll.filter((x) => x.status === s).length })),
      conflictsBySeverity: ['high', 'medium', 'low'].map((s) => ({ key: s, count: conflicts.summary[s] })), maturity: maturity.components.map((c) => ({ key: c.key, label: c.label, score: c.score, weight: c.weight })), costsByMonth: costByMonth,
    },
    figures: { units: unitsN, activeDelegations: delegs.length, flow: { total: flow.total, approvalRate: flow.approvalRate, avgCycleHours: flow.avgCycleHours, escalated: flow.escalatedTotal }, contracts: { active: contracts.contractsActive, annualValue: contracts.annualValue }, means: { assets: means.assets, value: means.value, lowSupplies: means.lowSupplies } },
    links: { meetings: await meetings(orgId), objectives: await objectives(orgId) },
  };
}
router.get('/dashboard', A.need('manager'), async (req, res) => res.json(await dashboard(req)));
router.get('/meetings', async (req, res) => res.json(await meetings(req.org.id)));
router.get('/objectives', async (req, res) => res.json(await objectives(req.org.id)));
router.post('/sweep', async (req, res) => res.json({ ok: true, ...await sweepAll(req.org.id) }));

// ---------- Suivi des objectifs administratifs (seulement sans RH talents) ----------
const goalView = (g) => ({ id: Number(g.id), title: g.title, area: g.area, ownerId: g.owner_id == null ? null : Number(g.owner_id), target: Number(g.target), current: Number(g.current), unit: g.unit, dueDate: g.due_date, status: g.status, progress: Number(g.target) ? Math.max(0, Math.min(100, Math.round((Number(g.current) / Number(g.target)) * 100))) : 0 });
router.get('/goals', async (req, res) => {
  const rh = await L.hasTable('rh_goals');
  const rows = await db.prepare('SELECT * FROM adm_goals WHERE org_id = ? ORDER BY due_date, id').all(req.org.id);
  res.json({ managedByRh: rh, goals: rows.map(goalView) });
});
const needGoals = L.needPerm('org_manage');
async function goalGuard() { if (await L.hasTable('rh_goals')) throw new HttpError(409, 'Les objectifs sont gérés dans RH talents : ce tableau n’est pas utilisé.'); }
router.post('/goals', needGoals, async (req, res) => {
  await goalGuard();
  const b = req.body || {}; const now = nowISO();
  const target = Number(b.target); if (b.target !== undefined && (!Number.isFinite(target) || target <= 0)) throw new HttpError(400, 'La cible doit être un nombre positif.');
  const id = (await db.prepare('INSERT INTO adm_goals (org_id, title, area, owner_id, target, current, unit, due_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, A.text(b.title, 200, { required: true, msg: 'Indiquez l’objectif.' }), A.text(b.area, 80), await A.memberOf(req, b.ownerId), b.target === undefined ? 100 : target, Math.max(0, Number(b.current) || 0), A.text(b.unit, 20) || '%', A.date(b.dueDate), 'open', now, now)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/goals/:id', needGoals, async (req, res) => {
  await goalGuard();
  const g = await db.prepare('SELECT * FROM adm_goals WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!g) throw new HttpError(404, 'Objectif introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE adm_goals SET title = ?, area = ?, owner_id = ?, target = ?, current = ?, unit = ?, due_date = ?, status = ?, updated_at = ? WHERE id = ?').run(
    b.title === undefined ? g.title : A.text(b.title, 200, { required: true, msg: 'Le titre ne peut pas être vide.' }), b.area === undefined ? g.area : A.text(b.area, 80), b.ownerId === undefined ? g.owner_id : await A.memberOf(req, b.ownerId),
    b.target === undefined ? g.target : Math.max(0.0001, Number(b.target) || 1), b.current === undefined ? g.current : Math.max(0, Number(b.current) || 0), b.unit === undefined ? g.unit : A.text(b.unit, 20) || '%', b.dueDate === undefined ? g.due_date : A.date(b.dueDate),
    A.oneOf(b.status, ['open', 'achieved', 'cancelled'], g.status, 'Statut inconnu.'), nowISO(), g.id);
  res.json({ ok: true });
});
router.delete('/goals/:id', needGoals, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_goals WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Objectif introuvable.');
  res.json({ ok: true });
});

// ---------- Rapport mensuel ----------
async function monthly(req, month) {
  const orgId = req.org.id; const from = `${month}-01`; const to = L.addMonths(from, 1);
  const in_ = (col) => `${col} >= '${from}' AND ${col} < '${to}'`; // mois validé par motif : pas d'entrée utilisateur libre
  const n = async (sql, ...a) => Number((await db.prepare(sql).get(...a)).c);
  const d = await dashboard(req);
  const reqs = await db.prepare(`SELECT status, kind, created_at, closed_at FROM adm_requests WHERE org_id = ? AND ${in_('created_at')}`).all(orgId);
  const sections = [
    { key: 'flow', title: 'Circuits de validation', rows: [['Demandes déposées', reqs.length], ['Approuvées', reqs.filter((r) => r.status === 'approved').length], ['Refusées', reqs.filter((r) => r.status === 'rejected').length], ['Encore en attente', reqs.filter((r) => r.status === 'pending').length], ['Étapes escaladées (depuis l’origine)', d.figures.flow.escalated], ['Délai moyen de traitement (heures)', d.figures.flow.avgCycleHours]] },
    { key: 'docs', title: 'Documents et archives', rows: [['Documents ajoutés', await n(`SELECT COUNT(*) c FROM adm_docs WHERE org_id = ? AND ${in_('created_at')}`, orgId)], ['Documents archivés', await n(`SELECT COUNT(*) c FROM adm_docs WHERE org_id = ? AND archived_at IS NOT NULL AND ${in_('archived_at')}`, orgId)], ['Documents détruits', await n(`SELECT COUNT(*) c FROM adm_docs WHERE org_id = ? AND destroyed_at IS NOT NULL AND ${in_('destroyed_at')}`, orgId)], ['À archiver (échéance atteinte ou proche)', d.kpis.docsToArchive], ['Au terme de leur conservation', d.kpis.docsToDestroy]] },
    { key: 'sops', title: 'Procédures', rows: [['Procédures approuvées ce mois', await n(`SELECT COUNT(*) c FROM adm_sops WHERE org_id = ? AND approved_at IS NOT NULL AND ${in_('approved_at')}`, orgId)], ['À réviser', d.kpis.sopsToReview], ['Accusés de lecture reçus', await n(`SELECT COUNT(*) c FROM adm_sop_acks WHERE org_id = ? AND ${in_('read_at')}`, orgId)]] },
    { key: 'control', title: 'Contrôle interne', rows: [['Contrôles réalisés', await n(`SELECT COUNT(*) c FROM adm_control_runs WHERE org_id = ? AND ${in_('done_on')}`, orgId)], ['dont échecs', await n(`SELECT COUNT(*) c FROM adm_control_runs WHERE org_id = ? AND result = 'ko' AND ${in_('done_on')}`, orgId)], ['Conflits de séparation des tâches ouverts', d.kpis.sodConflicts], ['Actions correctives en retard', d.kpis.actionsLate], ['Score de maturité (/100)', d.kpis.maturityScore]] },
    { key: 'means', title: 'Moyens généraux', rows: [['Demandes de moyens à traiter', d.kpis.meansRequests], ['Échéances dépassées', d.kpis.assetDeadlinesLate], ['Coûts du mois', await n(`SELECT COALESCE(SUM(amount), 0) c FROM adm_asset_events WHERE org_id = ? AND ${in_('event_date')}`, orgId)], ['Valeur des biens inventoriés', d.figures.means.value]] },
    { key: 'contracts', title: 'Contrats et conformité', rows: [['Contrats actifs', d.figures.contracts.active], ['Contrats à échéance ou préavis', d.kpis.contractAlerts], ['Obligations en retard', d.kpis.complianceLate], ['Obligations à venir', d.kpis.complianceSoon], ['Obligations accomplies ce mois', await n(`SELECT COUNT(*) c FROM adm_compliance_log WHERE org_id = ? AND ${in_('done_on')}`, orgId)]] },
  ];
  return { month, org: req.org.name, generatedAt: nowISO(), kpis: d.kpis, todo: d.todo, sections };
}
const monthOf = (req) => { const m = req.query.month ? String(req.query.month) : nowISO().slice(0, 7); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new HttpError(400, 'Mois invalide (format AAAA-MM).'); return m; };
router.get('/monthly', A.need('manager'), async (req, res) => res.json(await monthly(req, monthOf(req))));
router.get('/monthly.pdf', A.need('manager'), async (req, res) => {
  const r = await monthly(req, monthOf(req));
  const blocks = [{ type: 'heading', text: 'À traiter en priorité' }];
  blocks.push(r.todo.length ? { type: 'table', cols: [{ key: 'a', label: 'Sujet', width: 4 }, { key: 'b', label: 'Nombre', width: 1, align: 'right' }], rows: r.todo.map((t) => ({ a: t.label, b: t.count })) } : { type: 'text', text: 'Rien de urgent : tout est à jour.' });
  for (const s of r.sections) { blocks.push({ type: 'heading', text: s.title }); blocks.push({ type: 'table', cols: [{ key: 'a', label: 'Indicateur', width: 4 }, { key: 'b', label: 'Valeur', width: 1, align: 'right' }], rows: s.rows.map(([a, b]) => ({ a, b: String(b) })) }); }
  const buf = await require('../services/pdf').render({ title: 'Rapport administratif mensuel', subtitle: r.month, org: r.org, blocks, footer: 'Généré par Brij-IA le ' + r.generatedAt.slice(0, 10) });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="rapport-administratif-${r.month}.pdf"`, 'Cache-Control': 'private, no-store' }).send(buf);
});
router.get('/monthly.xlsx', A.need('manager'), async (req, res) => {
  const r = await monthly(req, monthOf(req));
  const buf = require('../services/mini-xlsx').build([
    { name: 'Synthèse', rows: [['Indicateur', 'Valeur'], ...Object.entries(r.kpis).map(([k, v]) => [k, v])] },
    { name: 'À traiter', rows: [['Sujet', 'Nombre', 'Gravité'], ...r.todo.map((t) => [t.label, t.count, t.severity])] },
    ...r.sections.map((s) => ({ name: s.title, rows: [['Indicateur', 'Valeur'], ...s.rows] })),
  ]);
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="rapport-administratif-${r.month}.xlsx"`, 'Cache-Control': 'private, no-store' }).send(buf);
});

module.exports = { router, dashboard, sweepAll, meetings, objectives };
