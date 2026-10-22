'use strict';
// Sous-application « Chantiers (BTP) » : chantiers, phases pondérées, dépenses vs budget, pointage, rapports journaliers, incidents/réserves,
// situations de travaux (acomptes). Droits : tout le monde consulte et peut saisir pointages, rapports et incidents ; les responsables (et le chef
// de chantier pour les phases) gèrent le reste. L'argent (marché, dépenses, facturation) n'est vu que par les responsables.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const U = require('./ops-util');
const { amap, HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const STATUS = ['preparation', 'active', 'suspended', 'done', 'received'];
const STATUS_FR = { preparation: 'en préparation', active: 'en cours', suspended: 'suspendu', done: 'terminé', received: 'réceptionné' };
const CATS = ['materials', 'labor', 'subcontract', 'equipment', 'transport', 'other'];
const CAT_FR = { materials: 'Matériaux', labor: "Main-d'œuvre", subcontract: 'Sous-traitance', equipment: "Location d'engins", transport: 'Transport', other: 'Divers' };
const ISSUE_KINDS = ['incident', 'safety', 'snag'];
const mgr = (req) => A.can(req, 'manager');
const OPEN_STATES = ['preparation', 'active', 'suspended'];

const siteOf = async (req, id) => {
  const s = await db.prepare('SELECT * FROM construction_sites WHERE id = ? AND org_id = ?').get(A.id(id, 'Chantier invalide.'), req.org.id);
  if (!s || !A.visible(req, s)) throw new HttpError(404, 'Chantier introuvable.');
  return s;
};
/** Fiche liée à un chantier (phase, dépense, etc.) : vérifie l'organisation et la visibilité du chantier. */
const childOf = async (req, table, id, msg) => {
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`).get(A.id(id), req.org.id);
  if (!row) throw new HttpError(404, msg);
  return { row, site: await siteOf(req, row.site_id) };
};
const isForeman = (req, site) => site.foreman_id === req.user.id;
const needSiteLead = (req, site) => { if (!mgr(req) && !isForeman(req, site)) throw new HttpError(403, 'Votre rôle ne permet pas cette action.'); };
const needOwnOrLead = (req, site, row) => { if (!mgr(req) && !isForeman(req, site) && row.created_by !== req.user.id) throw new HttpError(403, 'Vous ne pouvez modifier que vos propres saisies.'); };

// ---------- Calculs d'un chantier ----------
async function figures(s) {
  const phases = await db.prepare('SELECT * FROM construction_phases WHERE site_id = ? ORDER BY COALESCE(planned_start, planned_end, \'9999\'), id').all(s.id);
  const spent = (await db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM construction_expenses WHERE site_id = ?').get(s.id)).t;
  const bill = await db.prepare('SELECT COALESCE(SUM(amount), 0) AS billed, COALESCE(SUM(paid_amount), 0) AS paid FROM construction_billings WHERE site_id = ?').get(s.id);
  const totalW = phases.reduce((a, p) => a + p.weight, 0);
  const progress = totalW > 0 ? Math.round(phases.reduce((a, p) => a + p.weight * p.progress, 0) / totalW * 10) / 10 : 0;
  const today = U.today();
  const latePhases = phases.filter((p) => p.progress < 100 && p.planned_end && p.planned_end < today && !['done', 'received'].includes(s.status));
  const ceiling = s.cost_budget || s.budget;
  return {
    phases, progress, spent, billed: bill.billed, paid: bill.paid, ceiling, latePhases,
    siteLate: Boolean(s.end_date && s.end_date < today && OPEN_STATES.includes(s.status)),
    overrun: ceiling > 0 && spent > ceiling ? 'over' : ceiling > 0 && spent >= ceiling * 0.9 ? 'near' : 'ok',
    forecastMargin: s.budget - spent - s.remaining_estimate,
  };
}
async function siteView(req, s, f) {
  const m = mgr(req);
  return {
    id: s.id, name: s.name, client: s.client, location: s.location, foremanId: s.foreman_id, startDate: s.start_date, endDate: s.end_date, status: s.status, notes: s.notes, branchId: s.branch_id,
    progress: f.progress, late: f.siteLate || f.latePhases.length > 0, latePhases: f.latePhases.length, openIssues: (await db.prepare("SELECT COUNT(*) c FROM construction_issues WHERE site_id = ? AND status = 'open'").get(s.id)).c,
    budget: m ? s.budget : undefined, costBudget: m ? s.cost_budget : undefined, remainingEstimate: m ? s.remaining_estimate : undefined, spent: m ? f.spent : undefined, overrun: m ? f.overrun : undefined,
    forecastMargin: m ? f.forecastMargin : undefined, billed: m ? f.billed : undefined, paid: m ? f.paid : undefined, toPay: m ? f.billed - f.paid : undefined,
  };
}

function siteFields(b, cur) {
  const has = (k) => b[k] !== undefined;
  const start = has('startDate') ? A.date(b.startDate) : cur ? cur.start_date : null;
  const end = has('endDate') ? A.date(b.endDate) : cur ? cur.end_date : null;
  if (start && end && end < start) throw new HttpError(400, 'La date de fin ne peut pas précéder la date de début.');
  return {
    name: has('name') || !cur ? A.text(b.name, 120, { required: true, msg: 'Indiquez le nom du chantier.' }) : cur.name,
    client: has('client') ? A.text(b.client, 120) : cur ? cur.client : '', location: has('location') ? A.text(b.location, 150) : cur ? cur.location : '',
    start, end,
    budget: has('budget') ? U.nonneg(b.budget, 0, { int: true }) : cur ? cur.budget : 0, costBudget: has('costBudget') ? U.nonneg(b.costBudget, 0, { int: true }) : cur ? cur.cost_budget : 0,
    remaining: has('remainingEstimate') ? U.nonneg(b.remainingEstimate, 0, { int: true }) : cur ? cur.remaining_estimate : 0,
    status: has('status') ? A.oneOf(b.status, STATUS, undefined, 'Statut inconnu.') : cur ? cur.status : 'preparation', notes: has('notes') ? A.text(b.notes, 1000) : cur ? cur.notes : '',
  };
}

router.get('/', async (req, res) => {
  const sc = A.scope(req);
  const rows = await db.prepare(`SELECT * FROM construction_sites WHERE org_id = ?${sc.sql} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'preparation' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, id DESC`).all(req.org.id, ...sc.args);
  const calc = await amap(rows, async (s) => { const f = await figures(s); return { s, f, v: await siteView(req, s, f) }; });
  const active = calc.filter((c) => c.s.status === 'active');
  const open = calc.filter((c) => OPEN_STATES.includes(c.s.status));
  res.json({
    sites: calc.map((c) => c.v),
    summary: {
      active: active.length, total: rows.length, avgProgress: active.length ? Math.round(active.reduce((a, c) => a + c.f.progress, 0) / active.length * 10) / 10 : 0,
      late: open.filter((c) => c.v.late).length,
      forecastMargin: mgr(req) ? open.reduce((a, c) => a + c.f.forecastMargin, 0) : undefined, overBudget: mgr(req) ? open.filter((c) => c.f.overrun === 'over').length : undefined,
      toCollect: mgr(req) ? calc.reduce((a, c) => a + c.f.billed - c.f.paid, 0) : undefined,
    },
  });
});

router.post('/sites', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const f = siteFields(b, null);
  const id = (await db.prepare('INSERT INTO construction_sites (org_id, branch_id, name, client, location, foreman_id, start_date, end_date, budget, cost_budget, remaining_estimate, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, await A.branchOf(req, b.branchId), f.name, f.client, f.location, await A.memberOf(req, b.foremanId), f.start, f.end, f.budget, f.costBudget, f.remaining, f.status, f.notes, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'construction', `Chantier « ${f.name} » créé`);
  res.status(201).json({ id: Number(id) });
});

router.put('/sites/:id', A.need('manager'), async (req, res) => {
  const s = await siteOf(req, req.params.id);
  const b = req.body || {};
  const f = siteFields(b, s);
  await db.prepare('UPDATE construction_sites SET name = ?, client = ?, location = ?, foreman_id = ?, start_date = ?, end_date = ?, budget = ?, cost_budget = ?, remaining_estimate = ?, status = ?, notes = ? WHERE id = ?')
    .run(f.name, f.client, f.location, b.foremanId === undefined ? s.foreman_id : await A.memberOf(req, b.foremanId), f.start, f.end, f.budget, f.costBudget, f.remaining, f.status, f.notes, s.id);
  if (f.status !== s.status) await A.logActivity(req.org.id, req.user.id, 'construction', `Chantier « ${f.name} » : ${STATUS_FR[f.status]}`);
  res.json({ ok: true });
});

router.delete('/sites/:id', A.need('manager'), async (req, res) => {
  const s = await siteOf(req, req.params.id);
  await db.prepare('DELETE FROM construction_sites WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

router.get('/sites/:id', async (req, res) => {
  const s = await siteOf(req, req.params.id);
  const f = await figures(s);
  const m = mgr(req);
  const expenses = m ? await db.prepare('SELECT * FROM construction_expenses WHERE site_id = ? ORDER BY date DESC, id DESC LIMIT 200').all(s.id) : [];
  const byCat = CATS.map((c) => ({ category: c, label: CAT_FR[c], total: 0 }));
  if (m) {
    const sums = await db.prepare('SELECT category, COALESCE(SUM(amount), 0) AS t FROM construction_expenses WHERE site_id = ? GROUP BY category').all(s.id);
    for (const x of byCat) { const r = sums.find((q) => q.category === x.category); x.total = r ? r.t : 0; }
  }
  const ts = await db.prepare('SELECT t.*, u.name AS by_name FROM construction_timesheets t LEFT JOIN users u ON u.id = t.created_by WHERE t.site_id = ? ORDER BY t.date DESC, t.id DESC LIMIT 60').all(s.id);
  const tot = await db.prepare('SELECT COALESCE(SUM(headcount * hours), 0) AS ph FROM construction_timesheets WHERE site_id = ?').get(s.id);
  res.json({
    site: await siteView(req, s, f),
    phases: f.phases.map((p) => ({ id: p.id, name: p.name, weight: p.weight, progress: p.progress, plannedStart: p.planned_start, plannedEnd: p.planned_end, actualStart: p.actual_start, actualEnd: p.actual_end, notes: p.notes, late: f.latePhases.some((l) => l.id === p.id) })),
    expenses: expenses.map((e) => ({ id: e.id, category: e.category, label: e.label, amount: e.amount, date: e.date, inBudget: Boolean(e.budget_entry_id) })),
    byCategory: m ? byCat : [],
    timesheets: ts.map((t) => ({ id: t.id, date: t.date, worker: t.worker, headcount: t.headcount, hours: t.hours, personHours: U.round3(t.headcount * t.hours), notes: t.notes, by: t.by_name, own: t.created_by === req.user.id })),
    personHours: U.round3(tot.ph),
    reports: (await db.prepare('SELECT r.*, u.name AS by_name FROM construction_reports r LEFT JOIN users u ON u.id = r.created_by WHERE r.site_id = ? ORDER BY r.date DESC, r.id DESC LIMIT 40').all(s.id)).map((r) => ({ id: r.id, date: r.date, weather: r.weather, work: r.work, headcount: r.headcount, incidents: r.incidents, by: r.by_name, own: r.created_by === req.user.id })),
    issues: (await db.prepare('SELECT * FROM construction_issues WHERE site_id = ? ORDER BY CASE status WHEN \'open\' THEN 0 ELSE 1 END, id DESC LIMIT 100').all(s.id)).map((i) => ({ id: i.id, kind: i.kind, title: i.title, description: i.description, date: i.date, status: i.status, resolvedAt: i.resolved_at, own: i.created_by === req.user.id })),
    billings: m ? (await db.prepare('SELECT * FROM construction_billings WHERE site_id = ? ORDER BY billed_at, id').all(s.id)).map((b) => ({ id: b.id, label: b.label, amount: b.amount, billedAt: b.billed_at, dueDate: b.due_date, paid: b.paid_amount, paidAt: b.paid_at, left: b.amount - b.paid_amount, late: b.amount > b.paid_amount && Boolean(b.due_date) && b.due_date < U.today() })) : [],
  });
});

// ---------- Phases (responsables et chef de chantier) ----------
function phaseFields(b, cur) {
  const has = (k) => b[k] !== undefined;
  const ps = has('plannedStart') ? A.date(b.plannedStart) : cur ? cur.planned_start : null;
  const pe = has('plannedEnd') ? A.date(b.plannedEnd) : cur ? cur.planned_end : null;
  if (ps && pe && pe < ps) throw new HttpError(400, 'La fin prévue ne peut pas précéder le début prévu.');
  const weight = has('weight') ? U.nonneg(b.weight, 1, { max: 100000 }) : cur ? cur.weight : 1;
  if (weight <= 0) throw new HttpError(400, 'Le poids de la phase doit être supérieur à zéro.');
  const progress = has('progress') ? U.pct(b.progress) : cur ? cur.progress : 0;
  let as = has('actualStart') ? A.date(b.actualStart) : cur ? cur.actual_start : null;
  let ae = has('actualEnd') ? A.date(b.actualEnd) : cur ? cur.actual_end : null;
  if (progress > 0 && !as) as = U.today();
  if (progress >= 100 && !ae) ae = U.today();
  if (progress < 100 && !has('actualEnd')) ae = null;
  return { name: has('name') || !cur ? A.text(b.name, 120, { required: true, msg: 'Indiquez le nom de la phase.' }) : cur.name, weight, progress, ps, pe, as, ae, notes: has('notes') ? A.text(b.notes, 500) : cur ? cur.notes : '' };
}
router.post('/sites/:id/phases', async (req, res) => {
  const s = await siteOf(req, req.params.id);
  needSiteLead(req, s);
  const f = phaseFields(req.body || {}, null);
  if ((await db.prepare('SELECT COUNT(*) c FROM construction_phases WHERE site_id = ?').get(s.id)).c >= 60) throw new HttpError(400, 'Trop de phases (60 au plus).');
  const id = (await db.prepare('INSERT INTO construction_phases (org_id, site_id, name, weight, progress, planned_start, planned_end, actual_start, actual_end, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, s.id, f.name, f.weight, f.progress, f.ps, f.pe, f.as, f.ae, f.notes)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/phases/:pid', async (req, res) => {
  const { row, site } = await childOf(req, 'construction_phases', req.params.pid, 'Phase introuvable.');
  needSiteLead(req, site);
  const f = phaseFields(req.body || {}, row);
  await db.prepare('UPDATE construction_phases SET name = ?, weight = ?, progress = ?, planned_start = ?, planned_end = ?, actual_start = ?, actual_end = ?, notes = ? WHERE id = ?').run(f.name, f.weight, f.progress, f.ps, f.pe, f.as, f.ae, f.notes, row.id);
  res.json({ ok: true });
});
router.delete('/phases/:pid', async (req, res) => {
  const { row, site } = await childOf(req, 'construction_phases', req.params.pid, 'Phase introuvable.');
  needSiteLead(req, site);
  await db.prepare('DELETE FROM construction_phases WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ---------- Dépenses (responsables) ----------
const expFields = (b, cur) => ({
  category: b.category !== undefined || !cur ? A.oneOf(b.category, CATS, undefined, 'Catégorie inconnue.') : cur.category,
  label: b.label !== undefined ? A.text(b.label, 150) : cur ? cur.label : '', amount: b.amount !== undefined || !cur ? A.amount(b.amount) : cur.amount,
  date: b.date !== undefined || !cur ? A.date(b.date) || U.today() : cur.date,
});
router.post('/sites/:id/expenses', A.need('manager'), async (req, res) => {
  const s = await siteOf(req, req.params.id);
  const f = expFields(req.body || {}, null);
  const id = (await db.prepare('INSERT INTO construction_expenses (org_id, site_id, category, label, amount, date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, s.id, f.category, f.label, f.amount, f.date, req.user.id, nowISO())).lastInsertRowid;
  const spent = (await db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM construction_expenses WHERE site_id = ?').get(s.id)).t;
  const ceiling = s.cost_budget || s.budget;
  res.status(201).json({ id: Number(id), alert: ceiling > 0 && spent > ceiling ? `Attention : les dépenses (${spent}) dépassent le budget (${ceiling}).` : null });
});
router.put('/expenses/:eid', A.need('manager'), async (req, res) => {
  const { row } = await childOf(req, 'construction_expenses', req.params.eid, 'Dépense introuvable.');
  if (row.budget_entry_id) throw new HttpError(400, "Cette dépense est déjà inscrite au budget de l'organisation : elle ne peut plus être modifiée ici.");
  const f = expFields(req.body || {}, row);
  await db.prepare('UPDATE construction_expenses SET category = ?, label = ?, amount = ?, date = ? WHERE id = ?').run(f.category, f.label, f.amount, f.date, row.id);
  res.json({ ok: true });
});
router.delete('/expenses/:eid', A.need('manager'), async (req, res) => {
  const { row } = await childOf(req, 'construction_expenses', req.params.eid, 'Dépense introuvable.');
  await db.prepare('DELETE FROM construction_expenses WHERE id = ?').run(row.id);
  res.json({ ok: true });
});
/** Inscrit la dépense au budget de l'organisation, UNIQUEMENT après confirmation explicite ({ confirm: true }). */
router.post('/expenses/:eid/to-budget', A.need('manager'), async (req, res) => {
  const { row, site } = await childOf(req, 'construction_expenses', req.params.eid, 'Dépense introuvable.');
  if (!(req.body || {}).confirm) throw new HttpError(400, "Confirmez l'inscription de cette dépense au budget.");
  if (row.budget_entry_id) throw new HttpError(400, 'Cette dépense est déjà inscrite au budget.');
  await db.transaction(async () => {
    const id = (await db.prepare("INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?)")
      .run(req.org.id, site.branch_id, 'Chantiers', U.oneLine(`${site.name} : ${CAT_FR[row.category]}${row.label ? ' - ' + row.label : ''}`, 150), row.amount, row.date, req.user.id, nowISO())).lastInsertRowid;
    await db.prepare('UPDATE construction_expenses SET budget_entry_id = ? WHERE id = ?').run(id, row.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'construction', `Dépense du chantier « ${site.name} » inscrite au budget`);
  res.json({ ok: true });
});

// ---------- Pointage journalier ----------
router.post('/sites/:id/timesheets', async (req, res) => {
  const s = await siteOf(req, req.params.id);
  const b = req.body || {};
  const hours = U.nonneg(b.hours, 0, { max: 24, msg: 'Heures invalides (entre 0 et 24 par personne).' });
  if (hours <= 0) throw new HttpError(400, 'Indiquez les heures travaillées.');
  const head = U.nonneg(b.headcount, 1, { max: 5000, int: true, msg: 'Nombre de personnes invalide.' });
  if (head < 1) throw new HttpError(400, 'Indiquez au moins une personne.');
  const id = (await db.prepare('INSERT INTO construction_timesheets (org_id, site_id, date, worker, headcount, hours, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, s.id, A.date(b.date) || U.today(), A.text(b.worker, 100), head, hours, A.text(b.notes, 300), req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.delete('/timesheets/:tid', async (req, res) => {
  const { row, site } = await childOf(req, 'construction_timesheets', req.params.tid, 'Pointage introuvable.');
  needOwnOrLead(req, site, row);
  await db.prepare('DELETE FROM construction_timesheets WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ---------- Rapports journaliers ----------
router.post('/sites/:id/reports', async (req, res) => {
  const s = await siteOf(req, req.params.id);
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO construction_reports (org_id, site_id, date, weather, work, headcount, incidents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, s.id, A.date(b.date) || U.today(), A.text(b.weather, 60), A.text(b.work, 2000, { required: true, msg: 'Décrivez les travaux réalisés.' }), U.nonneg(b.headcount, 0, { max: 5000, int: true }), A.text(b.incidents, 1000), req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/reports/:rid', async (req, res) => {
  const { row, site } = await childOf(req, 'construction_reports', req.params.rid, 'Rapport introuvable.');
  needOwnOrLead(req, site, row);
  const b = req.body || {};
  await db.prepare('UPDATE construction_reports SET date = ?, weather = ?, work = ?, headcount = ?, incidents = ? WHERE id = ?').run(b.date === undefined ? row.date : A.date(b.date) || row.date, b.weather === undefined ? row.weather : A.text(b.weather, 60),
    b.work === undefined ? row.work : A.text(b.work, 2000, { required: true, msg: 'Décrivez les travaux réalisés.' }), b.headcount === undefined ? row.headcount : U.nonneg(b.headcount, 0, { max: 5000, int: true }), b.incidents === undefined ? row.incidents : A.text(b.incidents, 1000), row.id);
  res.json({ ok: true });
});
router.delete('/reports/:rid', async (req, res) => {
  const { row, site } = await childOf(req, 'construction_reports', req.params.rid, 'Rapport introuvable.');
  needOwnOrLead(req, site, row);
  await db.prepare('DELETE FROM construction_reports WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ---------- Incidents, sécurité et réserves ----------
router.post('/sites/:id/issues', async (req, res) => {
  const s = await siteOf(req, req.params.id);
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO construction_issues (org_id, site_id, kind, title, description, date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, s.id, A.oneOf(b.kind, ISSUE_KINDS, 'incident', 'Type inconnu (incident, sécurité ou réserve).'), A.text(b.title, 150, { required: true, msg: 'Indiquez le titre.' }), A.text(b.description, 1000), A.date(b.date) || U.today(), 'open', req.user.id, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'construction', `Chantier « ${s.name} » : ${{ incident: 'incident', safety: 'point de sécurité', snag: 'réserve' }[b.kind || 'incident']} signalé`);
  res.status(201).json({ id: Number(id) });
});
router.put('/issues/:iid', async (req, res) => {
  const { row, site } = await childOf(req, 'construction_issues', req.params.iid, 'Point introuvable.');
  needOwnOrLead(req, site, row);
  const b = req.body || {};
  const status = b.status === undefined ? row.status : A.oneOf(b.status, ['open', 'resolved'], undefined, 'Statut inconnu.');
  await db.prepare('UPDATE construction_issues SET title = ?, description = ?, status = ?, resolved_at = ? WHERE id = ?').run(b.title === undefined ? row.title : A.text(b.title, 150, { required: true, msg: 'Indiquez le titre.' }),
    b.description === undefined ? row.description : A.text(b.description, 1000), status, status === 'resolved' ? row.resolved_at || U.today() : null, row.id);
  res.json({ ok: true });
});
router.delete('/issues/:iid', async (req, res) => {
  const { row, site } = await childOf(req, 'construction_issues', req.params.iid, 'Point introuvable.');
  needOwnOrLead(req, site, row);
  await db.prepare('DELETE FROM construction_issues WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ---------- Situations de travaux / acomptes (responsables) ----------
router.post('/sites/:id/billings', A.need('manager'), async (req, res) => {
  const s = await siteOf(req, req.params.id);
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO construction_billings (org_id, site_id, label, amount, billed_at, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, s.id, A.text(b.label, 120, { required: true, msg: 'Indiquez le libellé (ex. Situation n° 1).' }), A.amount(b.amount), A.date(b.billedAt) || U.today(), A.date(b.dueDate), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/billings/:bid', A.need('manager'), async (req, res) => {
  const { row } = await childOf(req, 'construction_billings', req.params.bid, 'Situation introuvable.');
  const b = req.body || {};
  const amount = b.amount === undefined ? row.amount : A.amount(b.amount);
  if (amount < row.paid_amount) throw new HttpError(400, 'Le montant ne peut pas être inférieur à ce qui est déjà payé.');
  await db.prepare('UPDATE construction_billings SET label = ?, amount = ?, billed_at = ?, due_date = ? WHERE id = ?').run(b.label === undefined ? row.label : A.text(b.label, 120, { required: true, msg: 'Indiquez le libellé.' }), amount, b.billedAt === undefined ? row.billed_at : A.date(b.billedAt) || row.billed_at, b.dueDate === undefined ? row.due_date : A.date(b.dueDate), row.id);
  res.json({ ok: true });
});
router.delete('/billings/:bid', A.need('manager'), async (req, res) => {
  const { row } = await childOf(req, 'construction_billings', req.params.bid, 'Situation introuvable.');
  await db.prepare('DELETE FROM construction_billings WHERE id = ?').run(row.id);
  res.json({ ok: true });
});
/** Enregistre un paiement reçu du client sur une situation. */
router.post('/billings/:bid/pay', A.need('manager'), async (req, res) => {
  const { row } = await childOf(req, 'construction_billings', req.params.bid, 'Situation introuvable.');
  const a = A.amount((req.body || {}).amount);
  if (row.paid_amount + a > row.amount) throw new HttpError(400, `Ce paiement dépasse le reste dû (${row.amount - row.paid_amount}).`);
  await db.prepare('UPDATE construction_billings SET paid_amount = paid_amount + ?, paid_at = ? WHERE id = ?').run(a, A.date((req.body || {}).date) || U.today(), row.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.min = 'member';

// ---------- Aide à l'IA ----------
module.exports.ctx = async (req) => {
  const cur = req.org.currency;
  const m = mgr(req);
  const sc = A.scope(req);
  const rows = (await db.prepare(`SELECT * FROM construction_sites WHERE org_id = ?${sc.sql} AND status IN ('preparation','active','suspended') ORDER BY id DESC LIMIT 15`).all(req.org.id, ...sc.args));
  const lines = await amap(rows, async (s) => {
    const f = await figures(s);
    const open = (await db.prepare("SELECT COUNT(*) c FROM construction_issues WHERE site_id = ? AND status = 'open'").get(s.id)).c;
    return `- ${U.oneLine(s.name, 60)}${s.client ? ` (client ${U.oneLine(s.client, 40)})` : ''} [${STATUS_FR[s.status]}] avancement ${f.progress} %${f.siteLate ? ', DATE DE FIN DÉPASSÉE' : ''}${f.latePhases.length ? `, ${f.latePhases.length} phase(s) en retard (${f.latePhases.slice(0, 3).map((p) => U.oneLine(p.name, 30)).join(', ')})` : ''}${open ? `, ${open} point(s) ouvert(s)` : ''}`
      + (m ? `, marché ${U.money(s.budget, cur)}, dépensé ${U.money(f.spent, cur)}${f.overrun === 'over' ? ' DÉPASSEMENT' : ''}, marge prévisionnelle ${U.money(f.forecastMargin, cur)}, reste à encaisser ${U.money(f.billed - f.paid, cur)}` : '');
  });
  return ('CHANTIERS (BTP) :\n' + (lines.join('\n') || '(aucun chantier en cours)')).slice(0, 3000);
};
module.exports.prompt = "Module Chantiers (BTP) : chantiers, phases pondérées, dépenses comparées au budget, pointage, rapports journaliers, incidents et réserves, situations de travaux. Aide la personne à repérer les retards, les dépassements de budget et le reste à encaisser. La marge prévisionnelle = marché - dépenses - reste à faire estimé : c'est une estimation à vérifier. Tu ne modifies jamais rien toi-même : tu conseilles et la personne agit dans l'écran. Rappelle l'importance de la sécurité sur le chantier sans te substituer aux règles locales.";
