'use strict';
// Trésorerie : prévision glissante (13 semaines, 12 mois, calendrier), éléments prévisionnels, scénarios, créances clients (balance âgée, risque, provision, relances),
// dettes fournisseurs (échéancier, paiements optimisés), écarts prévu / réalisé, indicateurs (tableau des flux, BFR, FRNG, trésorerie nette, DSO, DPO, DIO, CCC),
// fonds de sécurité, tableau de bord et exports PDF / Excel.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const T = require('./tre-lib');
const F = require('./tre-forecast');
const D = require('./tre-data');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const { num, today } = T;
const any = T.need('any'); const mgr = T.need('manager');
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
const r0 = Math.round;

// ---------- Contexte de prévision (réutilisé par le tableau de bord, les scénarios et les exports) ----------
async function context(req, { accounts, scenario, trend } = {}) {
  const st = await T.settings(req.org.id); const from = today();
  const open = await D.openingBalance(req.org, accounts);
  let dso = null;
  try { const k = (await D.hasLedger(req.org.id)) ? await D.kpiAt(req.org.id, from.slice(0, 7)) : await D.kpiFromOperations(req.org.id); dso = k.dso; } catch { dso = null; }
  const col = await D.collect(req.org, st, { from, dso, trend });
  let flows = col.flows;
  if (scenario) flows = F.applyScenario(flows, scenario);
  return { st, from, open, flows, info: col.info, delays: col.delays };
}
const accountsParam = (q) => (q ? String(q).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined);

router.get('/forecast', any, async (req, res) => {
  const c = await context(req, { accounts: accountsParam(req.query.accounts), scenario: req.query.scenarioId ? await scenarioParams(req, req.query.scenarioId) : undefined });
  const fc = F.forecast({ flows: c.flows, opening: c.open.total, from: c.from, minBalance: c.st.minBalance });
  res.json({ ...fc, currency: req.org.currency, minBalance: c.st.minBalance, sources: c.info, accounts: c.open.accounts.map((a) => ({ id: a.id, name: a.name, balance: a.consolidated })),
    flowsList: c.flows.filter((f) => f.date <= T.addDays(c.from, 90)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 400).map((f) => ({ date: f.date < c.from ? c.from : f.date, amount: f.amount, group: f.group, source: f.source, label: f.label })) });
});

router.get('/calendar', any, async (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  if (!T.isMonth(month)) throw new HttpError(400, 'Mois invalide (format AAAA-MM).');
  const c = await context(req, { accounts: accountsParam(req.query.accounts) });
  const proj = F.project({ flows: c.flows, opening: c.open.total, from: c.from, days: 400, minBalance: c.st.minBalance });
  const days = F.calendar(proj, c.flows, month);
  res.json({ month, currency: req.org.currency, from: c.from, days, minBalance: c.st.minBalance, overdraft: proj.overdraft, belowMin: proj.belowMin, low: proj.low,
    note: month < c.from.slice(0, 7) ? 'past' : '' });
});

// ---------- Éléments prévisionnels ----------
const planView = (p) => ({ id: Number(p.id), direction: p.direction, category: p.category, label: p.label, amount: num(p.amount), startDate: p.start_date, recurrence: p.recurrence, endDate: p.end_date, active: Boolean(num(p.active)) });
router.get('/plan', any, async (req, res) => res.json({ items: (await db.prepare('SELECT * FROM tre_plan WHERE org_id = ? ORDER BY start_date, id').all(req.org.id)).map(planView), categories: T.catView() }));
async function planFields(b) {
  const direction = A.oneOf(b.direction, ['in', 'out'], undefined, 'Sens : encaissement ou décaissement.');
  const category = A.oneOf(b.category, Object.keys(T.CATEGORIES).filter((k) => T.CATEGORIES[k].dir === direction), undefined, 'Catégorie inconnue.');
  return { direction, category, label: A.text(b.label, 120, { required: true, msg: 'Indiquez un libellé.' }), amount: A.amount(b.amount), start: A.date(b.startDate) || today(), recurrence: A.oneOf(b.recurrence, ['none', 'weekly', 'monthly', 'quarterly', 'yearly'], 'none', 'Récurrence inconnue.'), end: A.date(b.endDate) };
}
router.post('/plan', mgr, async (req, res) => {
  const f = await planFields(req.body || {});
  const id = (await db.prepare('INSERT INTO tre_plan (org_id, direction, category, label, amount, start_date, recurrence, end_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, f.direction, f.category, f.label, f.amount, f.start, f.recurrence, f.end, req.user.id, nowISO())).lastInsertRowid;
  await T.log(req.org.id, req.user.id, 'plan.create', 'plan', Number(id), { label: f.label, amount: f.amount });
  res.status(201).json({ id: Number(id) });
});
router.put('/plan/:id', mgr, async (req, res) => {
  const p = await db.prepare('SELECT * FROM tre_plan WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Élément introuvable.');
  const b = req.body || {};
  if (b.active !== undefined && Object.keys(b).length === 1) { await db.prepare('UPDATE tre_plan SET active = ? WHERE id = ?').run(b.active ? 1 : 0, p.id); return res.json({ ok: true }); }
  const f = await planFields({ direction: p.direction, category: p.category, label: p.label, amount: p.amount, startDate: p.start_date, recurrence: p.recurrence, endDate: p.end_date, ...b });
  await db.prepare('UPDATE tre_plan SET direction = ?, category = ?, label = ?, amount = ?, start_date = ?, recurrence = ?, end_date = ? WHERE id = ?').run(f.direction, f.category, f.label, f.amount, f.start, f.recurrence, f.end, p.id);
  await T.log(req.org.id, req.user.id, 'plan.update', 'plan', Number(p.id), { label: f.label, amount: f.amount });
  res.json({ ok: true });
});
router.delete('/plan/:id', mgr, async (req, res) => {
  const r = await db.prepare('DELETE FROM tre_plan WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Élément introuvable.');
  await T.log(req.org.id, req.user.id, 'plan.delete', 'plan', A.id(req.params.id), {});
  res.json({ ok: true });
});

// ---------- Scénarios ----------
const scView = (s) => ({ id: Number(s.id), name: s.name, params: F.cleanParams(JSON.parse(s.params || '{}')), createdAt: s.created_at, updatedAt: s.updated_at });
async function scenarioParams(req, id) {
  const s = await db.prepare('SELECT * FROM tre_scenarios WHERE id = ? AND org_id = ?').get(A.id(id, 'Scénario invalide.'), req.org.id);
  if (!s) throw new HttpError(404, 'Scénario introuvable.');
  return JSON.parse(s.params || '{}');
}
router.get('/scenarios', any, async (req, res) => res.json({ scenarios: (await db.prepare('SELECT * FROM tre_scenarios WHERE org_id = ? ORDER BY id').all(req.org.id)).map(scView), presets: [
  { name: 'Ventes −20 %', params: { salesPct: -20 } }, { name: 'Clients en retard de 15 jours', params: { delayDays: 15 } }, { name: 'Hausse des coûts de 10 %', params: { costPct: 10 } },
  { name: 'Gros investissement', params: { capex: [{ date: T.addDays(today(), 45), amount: 5000000, label: 'Investissement' }] } }, { name: 'Nouveau prêt', params: { loan: { amount: 10000000, date: T.addDays(today(), 30), months: 24, ratePct: 9 } } } ] }));
router.post('/scenarios', mgr, async (req, res) => {
  const b = req.body || {}; const name = A.text(b.name, 80, { required: true, msg: 'Donnez un nom au scénario.' });
  if (num((await db.prepare('SELECT COUNT(*) c FROM tre_scenarios WHERE org_id = ?').get(req.org.id)).c) >= 50) throw new HttpError(400, 'Limite atteinte : 50 scénarios.');
  const id = (await db.prepare('INSERT INTO tre_scenarios (org_id, name, params, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, name, JSON.stringify(F.cleanParams(b.params)), req.user.id, nowISO(), nowISO())).lastInsertRowid;
  await T.log(req.org.id, req.user.id, 'scenario.create', 'scenario', Number(id), { name });
  res.status(201).json({ id: Number(id) });
});
router.put('/scenarios/:id', mgr, async (req, res) => {
  const s = await db.prepare('SELECT * FROM tre_scenarios WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Scénario introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE tre_scenarios SET name = ?, params = ?, updated_at = ? WHERE id = ?').run(A.text(b.name, 80) || s.name, b.params ? JSON.stringify(F.cleanParams(b.params)) : s.params, nowISO(), s.id);
  res.json({ ok: true });
});
router.delete('/scenarios/:id', mgr, async (req, res) => {
  const r = await db.prepare('DELETE FROM tre_scenarios WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Scénario introuvable.');
  res.json({ ok: true });
});
/** Compare : le scénario central + les scénarios cochés (ids) + un scénario libre (params). Sans choix : pessimiste / central / optimiste. */
router.post('/scenarios/compare', any, async (req, res) => {
  const b = req.body || {}; const c = await context(req, { trend: true });
  let list = [];
  if (Array.isArray(b.ids) && b.ids.length) {
    list.push({ name: 'Central', key: 'central', params: null });
    for (const id of b.ids.slice(0, 6)) { const s = await db.prepare('SELECT * FROM tre_scenarios WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id); if (s) list.push({ id: Number(s.id), name: s.name, params: JSON.parse(s.params) }); }
  } else if (b.params) list = [{ name: 'Central', key: 'central', params: null }, { name: A.text(b.name, 80) || 'Mon scénario', params: b.params }];
  else list = F.BASE_SCENARIOS.map((x) => ({ ...x }));
  res.json({ currency: req.org.currency, opening: c.open.total, minBalance: c.st.minBalance, results: F.compare({ flows: c.flows, opening: c.open.total, from: c.from, minBalance: c.st.minBalance, scenarios: list }) });
});

// ---------- Créances clients ----------
async function receivables(req) {
  const st = await T.settings(req.org.id); const invs = await D.openInvoices(req.org.id); const delays = await D.customerDelays(req.org.id, today());
  const ag = F.aging(invs.map((i) => ({ id: i.id, customerId: i.customerId, customer: i.customer, number: i.number, due: i.due, left: i.left, total: i.total })), today(), st.provision, delays.history);
  const fu = await db.prepare("SELECT ref_id, MAX(step) AS step, MAX(state) AS state FROM fu_items WHERE org_id = ? AND kind = 'invoice' GROUP BY ref_id").all(req.org.id);
  const sent = await db.prepare("SELECT ref_id, COUNT(*) n, MAX(created_at) last FROM fu_log WHERE org_id = ? AND kind = 'invoice' AND result IN ('sent', 'ok') GROUP BY ref_id").all(req.org.id);
  const fuBy = new Map(fu.map((f) => [Number(f.ref_id), f])); const sentBy = new Map(sent.map((f) => [Number(f.ref_id), f]));
  ag.items = ag.items.map((i) => ({ ...i, reminders: sentBy.get(i.id) ? num(sentBy.get(i.id).n) : 0, lastReminder: sentBy.get(i.id) ? sentBy.get(i.id).last : null, reminderState: fuBy.get(i.id) ? fuBy.get(i.id).state : '' }));
  const sales90 = await D.windowSums(req.org.id, T.addDays(today(), -90), today()).catch(() => ({ sales: 0 }));
  return { ...ag, provisionRates: st.provision, avgDelay: Math.round(delays.org), history: delays.history, sales90: sales90.sales, currency: req.org.currency };
}
router.get('/receivables', any, async (req, res) => res.json(await receivables(req)));
/** Relances : on réutilise le centre de relances de l'Assistant commercial (cadence, canaux, journal) ; ceci lance le balayage des factures échues. */
router.post('/receivables/reminders', mgr, async (req, res) => {
  const fu = require('./followups');
  const out = await fu.scan(req.org, await fu.settingsOf(req.org.id, true));
  await T.log(req.org.id, req.user.id, 'reminders.scan', 'receivables', null, {});
  res.json({ ok: true, scan: out || null });
});

// ---------- Dettes fournisseurs ----------
async function payablesData(req) {
  const rows = await db.prepare(`SELECT b.*, COALESCE(NULLIF(b.supplier_name, ''), s.name, '') AS party, COALESCE(t.discount_pct, 0) AS dpct, COALESCE(t.discount_days, 0) AS ddays, COALESCE(t.priority, 2) AS prio
    FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id LEFT JOIN tre_terms t ON t.org_id = b.org_id AND t.supplier_id = b.supplier_id
    WHERE b.org_id = ? AND b.status IN ('open', 'partial') AND b.amount > b.paid ORDER BY b.due_date, b.id`).all(req.org.id);
  return rows.map((b) => ({ id: Number(b.id), supplierId: b.supplier_id === null ? null : Number(b.supplier_id), supplier: b.party || '—', number: b.number, billDate: b.bill_date, due: b.due_date, left: num(b.amount) - num(b.paid), amount: num(b.amount), priority: num(b.prio), discountPct: Number(b.dpct), discountDays: num(b.ddays) }));
}
router.get('/payables', any, async (req, res) => {
  const bills = await payablesData(req); const t = today();
  const weeks = Array.from({ length: 13 }, (_, i) => ({ label: `S${i + 1}`, from: T.addDays(t, i * 7), to: T.addDays(t, i * 7 + 6), amount: 0 })); let overdue = 0; let later = 0;
  for (const b of bills) { if (b.due < t) overdue += b.left; else { const w = weeks.find((x) => b.due >= x.from && b.due <= x.to); if (w) w.amount += b.left; else later += b.left; } }
  const bySupplier = {}; for (const b of bills) bySupplier[b.supplier] = (bySupplier[b.supplier] || 0) + b.left;
  const terms = await db.prepare('SELECT t.*, s.name FROM tre_terms t JOIN suppliers s ON s.id = t.supplier_id WHERE t.org_id = ? ORDER BY s.name').all(req.org.id);
  res.json({ total: sum(bills, (b) => b.left), overdue, later, weeks, bills: bills.map((b) => ({ ...b, late: Math.max(T.diffDays(b.due, t), 0) })), bySupplier: Object.entries(bySupplier).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount).slice(0, 10),
    terms: terms.map((x) => ({ supplierId: Number(x.supplier_id), name: x.name, discountPct: Number(x.discount_pct), discountDays: num(x.discount_days), priority: num(x.priority) })) });
});
router.put('/terms/:supplierId', mgr, async (req, res) => {
  const sid = A.id(req.params.supplierId, 'Fournisseur invalide.');
  if (!await db.prepare('SELECT 1 FROM suppliers WHERE id = ? AND org_id = ?').get(sid, req.org.id)) throw new HttpError(404, 'Fournisseur introuvable.');
  const b = req.body || {}; const pct = Number(b.discountPct || 0); const days = Math.round(Number(b.discountDays || 0)); const prio = Math.round(Number(b.priority || 2));
  if (!(pct >= 0 && pct <= 30)) throw new HttpError(400, 'Escompte : entre 0 et 30 %.'); if (!(days >= 0 && days <= 120)) throw new HttpError(400, 'Délai d\'escompte : 0 à 120 jours.'); if (![1, 2, 3].includes(prio)) throw new HttpError(400, 'Priorité : 1 (critique), 2 (normale) ou 3 (reportable).');
  await db.prepare('INSERT INTO tre_terms (org_id, supplier_id, discount_pct, discount_days, priority) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, supplier_id) DO UPDATE SET discount_pct = EXCLUDED.discount_pct, discount_days = EXCLUDED.discount_days, priority = EXCLUDED.priority').run(req.org.id, sid, pct, days, prio);
  await T.log(req.org.id, req.user.id, 'terms', 'supplier', sid, { pct, days, prio });
  res.json({ ok: true });
});
router.get('/payables/optimize', mgr, async (req, res) => {
  const st = await T.settings(req.org.id); const open = await D.openingBalance(req.org); const g = await safety(req, st, open.total);
  const bills = await payablesData(req);
  const keep = req.query.keepSafety === '0' ? 0 : g.target;
  const plan = F.optimizePayments({ bills, available: open.total - keep, today: today() });
  res.json({ cash: open.total, safetyTarget: keep, ...plan, currency: req.org.currency });
});

// ---------- Fonds de sécurité ----------
async function safety(req, st, cash) {
  const daily = await D.dailyOutflow(req.org.id, st);
  return F.safetyGauge({ mode: st.safetyMode, days: st.safetyDays, amount: st.safetyAmount, dailyOut: daily, available: cash });
}
router.get('/safety', any, async (req, res) => {
  const st = await T.settings(req.org.id); const open = await D.openingBalance(req.org); const g = await safety(req, st, open.total);
  const c = await context(req); const fc = F.forecast({ flows: c.flows, opening: open.total, from: c.from, minBalance: c.st.minBalance });
  const weeksBelow = fc.weeks.filter((w) => w.closing < g.target).length;
  res.json({ ...g, currency: req.org.currency, weeksBelowTarget: g.target > 0 ? weeksBelow : 0, projection: fc.weeks.map((w) => ({ label: w.label, closing: w.closing, target: g.target })), mode: st.safetyMode, days: st.safetyDays, amount: st.safetyAmount });
});

// ---------- Écarts prévu / réalisé ----------
router.get('/variance', any, async (req, res) => {
  const st = await T.settings(req.org.id);
  const month = req.query.month || T.addMonths(`${today().slice(0, 7)}-01`, -1).slice(0, 7);
  if (!T.isMonth(month)) throw new HttpError(400, 'Mois invalide (format AAAA-MM).');
  const cur = await D.variance(req.org.id, `${month}-01`, T.lastDay(month), st);
  const trend = []; for (const m of D.prevMonths(month, 6)) { const v = await D.variance(req.org.id, `${m}-01`, T.lastDay(m), st); trend.push({ month: m, planned: v.plannedNet, actual: v.actualNet, gap: v.gap }); }
  res.json({ month, currency: req.org.currency, ...cur, trend, hasLedger: await D.hasLedger(req.org.id) });
});

// ---------- Indicateurs ----------
router.get('/cashflow', any, async (req, res) => {
  const year = String(req.query.year || today().slice(0, 4)); if (!/^\d{4}$/.test(year)) throw new HttpError(400, 'Année invalide.');
  const from = req.query.from && A.date(req.query.from) || `${year}-01-01`; const to = req.query.to && A.date(req.query.to) || `${year}-12-31`;
  const stmt = await D.cashStatement(req.org.id, from, to);
  const months = await D.cashByMonth(req.org.id, to.slice(0, 7), 12);
  res.json({ ...stmt, months, currency: req.org.currency });
});

router.get('/kpis', any, async (req, res) => {
  const st = await T.settings(req.org.id); const n = Math.min(Math.max(Math.round(Number(req.query.months)) || 12, 3), 24);
  const ledger = await D.hasLedger(req.org.id);
  const series = [];
  if (ledger) for (const m of D.prevMonths(today().slice(0, 7), n)) series.push(await D.kpiAt(req.org.id, m));
  const current = ledger ? series[series.length - 1] : await D.kpiFromOperations(req.org.id);
  const to = current.to; const wc = ledger ? D.workingCapital(await D.ledger(req.org.id, to)) : null;
  res.json({ currency: req.org.currency, fromLedger: ledger, current, series, targets: st.targets, interpretation: D.interpret(current, st.targets), alerts: D.kpiAlerts(current, st.targets), workingCapital: wc,
    formulas: { dso: 'Créances clients ÷ ventes TTC × 90 jours', dpo: 'Dettes fournisseurs ÷ achats TTC × 90 jours', dio: 'Stock ÷ coût des achats consommés × 90 jours', ccc: 'DSO + DIO − DPO', tn: 'FRNG − BFR' } });
});

// ---------- Tableau de bord ----------
router.get('/dashboard', any, async (req, res) => {
  const manager = await T.isManager(req);
  const c = await context(req); const fc = F.forecast({ flows: c.flows, opening: c.open.total, from: c.from, minBalance: c.st.minBalance });
  const g = await safety(req, c.st, c.open.total);
  const ledger = await D.hasLedger(req.org.id);
  const kpi = ledger ? await D.kpiAt(req.org.id, today().slice(0, 7)) : await D.kpiFromOperations(req.org.id);
  const rec = await receivables(req);
  const pend = num((await db.prepare("SELECT COUNT(*) c FROM tre_ops WHERE org_id = ? AND status IN ('prepared', 'half')").get(req.org.id)).c);
  const bills = await payablesData(req);
  const t = today();
  const upcoming = c.flows.filter((f) => f.date <= T.addDays(t, 14)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12).map((f) => ({ date: f.date < t ? t : f.date, amount: f.amount, label: f.label, group: f.group }));
  const alerts = [];
  if (fc.overdraft) alerts.push({ code: 'overdraft', level: 'alert', date: fc.overdraft.date, amount: fc.overdraft.balance, daysAway: fc.overdraft.daysAway });
  else if (fc.belowMin) alerts.push({ code: 'below_min', level: 'warn', date: fc.belowMin.date, amount: fc.belowMin.balance, daysAway: fc.belowMin.daysAway });
  if (g.level === 'low' || g.level === 'alert' || g.level === 'critical') alerts.push({ code: 'safety', level: g.level === 'low' ? 'warn' : 'alert', amount: g.gap, ratio: g.ratio });
  if (rec.total > 0 && rec.overdue / rec.total > 0.3) alerts.push({ code: 'overdue_receivables', level: 'warn', amount: rec.overdue, ratio: Math.round(rec.overdue / rec.total * 100) });
  if (manager && pend) alerts.push({ code: 'pending_ops', level: 'info', count: pend });
  const overdueBills = sum(bills.filter((b) => b.due < t), (b) => b.left); if (overdueBills > 0) alerts.push({ code: 'overdue_payables', level: 'warn', amount: overdueBills });
  for (const k of D.kpiAlerts(kpi, c.st.targets)) alerts.push({ code: `kpi_${k.code}`, level: k.level, value: k.value, target: k.target });
  let stock = null; try { const sc = require('./stock-compta'); if (typeof sc.cashSnapshot === 'function') stock = await sc.cashSnapshot(req); } catch { stock = null; } // état « trésorerie du stock » de l'intégration Stock, quand elle est présente
  const consolidatedByKind = {}; for (const a of c.open.accounts) consolidatedByKind[a.kind] = (consolidatedByKind[a.kind] || 0) + a.consolidated;
  res.json({ currency: req.org.currency, role: await T.treRole(req), cash: c.open.total, accounts: c.open.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, currency: a.currency, balance: a.consolidated, pending: a.pending })), byKind: consolidatedByKind,
    forecast: { weeks: fc.weeks.map((w) => ({ label: w.label, from: w.from, closing: w.closing, in: w.in, out: w.out, net: w.net })), low: fc.low13, overdraft: fc.overdraft, belowMin: fc.belowMin, closing13: fc.closing13, closing12m: fc.closing12m, totals13: fc.totals13, months: fc.months.map((m) => ({ label: m.label, closing: m.closing, in: m.in, out: m.out })) },
    safety: g, kpi: { dso: kpi.dso, dpo: kpi.dpo, dio: kpi.dio, ccc: kpi.ccc, bfr: kpi.bfr, frng: kpi.frng, treasuryNet: kpi.treasuryNet }, interpretation: D.interpret(kpi, c.st.targets),
    receivables: { total: rec.total, overdue: rec.overdue, provision: rec.provision, buckets: rec.buckets, topRisk: rec.customers.slice(0, 5).map((x) => ({ customer: x.customer, total: x.total, overdue: x.overdue, risk: x.risk })) },
    payables: { total: sum(bills, (b) => b.left), overdue: overdueBills, next7: sum(bills.filter((b) => b.due <= T.addDays(t, 7)), (b) => b.left) },
    pending: pend, upcoming, alerts, stock, sources: c.info, updatedAt: nowISO() });
});

// ---------- Exports PDF / Excel du plan de trésorerie ----------
async function planData(req) {
  const c = await context(req); const fc = F.forecast({ flows: c.flows, opening: c.open.total, from: c.from, minBalance: c.st.minBalance });
  const g = await safety(req, c.st, c.open.total); const rec = await receivables(req); const bills = await payablesData(req);
  const proj = F.project({ flows: c.flows, opening: c.open.total, from: c.from, days: 91, minBalance: c.st.minBalance });
  return { c, fc, g, rec, bills, proj };
}
const n0 = (n) => Math.round(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ');
router.get('/export/plan.xlsx', mgr, async (req, res) => {
  const { c, fc, g, rec, bills } = await planData(req); const cur = req.org.currency; const B = (v) => ({ v, bold: true });
  const sheets = [
    { name: 'Synthèse', widths: [38, 20, 20], rows: [[B(`Plan de trésorerie · ${req.org.name}`)], [`Établi le ${c.from}`], [], [B('Trésorerie actuelle'), c.open.total], [B('Point bas à 13 semaines'), fc.low13.balance, fc.low13.date], [B('Solde dans 13 semaines'), fc.closing13], [B('Solde dans 12 mois'), fc.closing12m], [B('Découvert prévu'), fc.overdraft ? fc.overdraft.date : 'Aucun'], [B('Fonds de sécurité cible'), g.target], [B('Fonds de sécurité actuel'), g.available], [B('Créances clients'), rec.total], [B('Dont échues'), rec.overdue], [B('Dettes fournisseurs'), sum(bills, (b) => b.left)], [], [`Montants en ${cur}`]] },
    { name: '13 semaines', widths: [10, 12, 12, 16, 16, 16, 16], rows: [[B('Semaine'), B('Du'), B('Au'), B('Solde début'), B('Encaissements'), B('Décaissements'), B('Solde fin')], ...fc.weeks.map((w) => [w.label, w.from, w.to, w.opening, w.in, -w.out, w.closing])] },
    { name: '12 mois', widths: [10, 16, 16, 16, 16], rows: [[B('Mois'), B('Solde début'), B('Encaissements'), B('Décaissements'), B('Solde fin')], ...fc.months.map((m) => [m.label, m.opening, m.in, -m.out, m.closing])] },
    { name: 'Calendrier', widths: [12, 16, 16, 16], rows: [[B('Date'), B('Encaissements'), B('Décaissements'), B('Solde fin de journée')], ...fc.daily.slice(0, 91).map((d) => [d.date, d.in, -d.out, d.balance])] },
    { name: 'Créances', widths: [26, 16, 14, 14, 14], rows: [[B('Client'), B('Reste dû'), B('Échu'), B('Retard max (j)'), B('Risque')], ...rec.customers.map((x) => [x.customer, x.total, x.overdue, x.maxLate, x.risk])] },
    { name: 'Dettes', widths: [26, 16, 14, 14], rows: [[B('Fournisseur'), B('Facture'), B('Échéance'), B('Reste à payer')], ...bills.map((b) => [b.supplier, b.number, b.due, b.left])] },
  ];
  await T.log(req.org.id, req.user.id, 'export', 'plan', null, { format: 'xlsx' });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="plan-de-tresorerie.xlsx"', 'Cache-Control': 'private, no-store' });
  res.send(require('../services/xlsx-lite').workbook(sheets));
});
router.get('/export/plan.pdf', mgr, async (req, res) => {
  const { c, fc, g, rec, bills } = await planData(req); const cur = req.org.currency;
  const spec = {
    title: 'Plan de trésorerie', subtitle: `Prévision glissante à 13 semaines et 12 mois · établi le ${c.from.split('-').reverse().join('/')}`, org: req.org.name,
    meta: [['Trésorerie actuelle', `${n0(c.open.total)} ${cur}`], ['Point bas à 13 semaines', `${n0(fc.low13.balance)} ${cur} (${fc.low13.date})`], ['Découvert prévu', fc.overdraft ? `${fc.overdraft.date} (${n0(fc.overdraft.balance)} ${cur})` : 'Aucun sur 12 mois']],
    blocks: [
      { type: 'heading', text: 'Fonds de sécurité' }, { type: 'kv', rows: [['Cible', `${n0(g.target)} ${cur}`], ['Trésorerie disponible', `${n0(g.available)} ${cur}`], ['Couverture', g.coverageDays === null ? '—' : `${g.coverageDays} jours de charges`]] },
      { type: 'heading', text: '13 semaines glissantes' },
      { type: 'table', cols: [{ key: 'w', label: 'Sem.', width: 36 }, { key: 'f', label: 'Du', width: 64 }, { key: 'o', label: 'Solde début', width: 82, align: 'right' }, { key: 'i', label: 'Encaiss.', width: 82, align: 'right' }, { key: 'u', label: 'Décaiss.', width: 82, align: 'right' }, { key: 'c', label: 'Solde fin', width: 82, align: 'right' }],
        rows: fc.weeks.map((w) => ({ w: w.label, f: w.from, o: n0(w.opening), i: n0(w.in), u: n0(-w.out), c: n0(w.closing) })) },
      { type: 'heading', text: '12 mois glissants' },
      { type: 'table', cols: [{ key: 'm', label: 'Mois', width: 60 }, { key: 'o', label: 'Solde début', width: 100, align: 'right' }, { key: 'i', label: 'Encaissements', width: 100, align: 'right' }, { key: 'u', label: 'Décaissements', width: 100, align: 'right' }, { key: 'c', label: 'Solde fin', width: 100, align: 'right' }],
        rows: fc.months.map((m) => ({ m: m.label, o: n0(m.opening), i: n0(m.in), u: n0(-m.out), c: n0(m.closing) })) },
      { type: 'heading', text: 'Créances clients (balance âgée)' },
      { type: 'table', cols: [{ key: 'b', label: 'Tranche', width: 180 }, { key: 'a', label: 'Montant', width: 120, align: 'right' }, { key: 's', label: 'Part', width: 80, align: 'right' }], rows: rec.buckets.map((b) => ({ b: b.label, a: n0(b.amount), s: `${b.share} %` })), totals: [['Total', `${n0(rec.total)} ${cur}`], ['Provision conseillée', `${n0(rec.provision)} ${cur}`]] },
      { type: 'heading', text: 'Dettes fournisseurs' }, { type: 'kv', rows: [['Total à payer', `${n0(sum(bills, (b) => b.left))} ${cur}`], ['Dont en retard', `${n0(sum(bills.filter((b) => b.due < c.from), (b) => b.left))} ${cur}`]] },
      { type: 'note', text: 'Prévision établie à partir des factures clients et fournisseurs, des commandes, de la paie, des emprunts, des impôts et de la tendance des ventes et des achats. Mise à jour automatique à chaque ouverture.' },
    ],
  };
  await T.log(req.org.id, req.user.id, 'export', 'plan', null, { format: 'pdf' });
  const buf = await require('../services/pdf').render(spec);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="plan-de-tresorerie.pdf"', 'Cache-Control': 'private, no-store' });
  res.send(buf);
});

module.exports = router;
