'use strict';
// Tableau de bord · vague 3 : chiffre d'affaires, marge estimée, créances par âge, trésorerie, objectifs, seuils d'alertes réglables, export CSV.
// Les chiffres viennent des factures et du budget de l'organisation ; la « marge » est une estimation de gestion (chiffre d'affaires HT - sorties du budget).
const express = require('express');
const { db } = require('../db');
const A = require('./access');
const W = require('./w3');
const D = require('./invoice-doc');

const router = express.Router({ mergeParams: true });
const KEYS = ['alert_overdue_days', 'alert_ticket_hours', 'alert_cash_min', 'alert_receivable_max', 'alert_contract_days', 'goal_revenue_month', 'goal_new_customers_month', 'goal_csat'];
W.settingsRoutes(router, KEYS, 'admin', 'manager');

const monthsBack = (n) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };

async function kpis(req, month) {
  const sc = A.scope(req, 'branch_id');
  const m = A.monthRange(month);
  const st = await W.settings(req.org.id);
  const docs = (await db.prepare(`SELECT * FROM documents WHERE org_id = ? AND kind IN ('invoice','credit') AND status NOT IN ('draft','cancelled')${sc.sql}`).all(req.org.id, ...sc.args));
  const ht = (d) => D.amounts(d, req.org).ht * (d.kind === 'credit' ? -1 : 1);
  const sumIn = (from, to) => docs.filter((d) => d.issued >= from && d.issued < to).reduce((a, d) => a + ht(d), 0);
  const ytdFrom = `${m.month.slice(0, 4)}-01-01`;
  const revenue = sumIn(m.from, m.to);
  const exp = (await db.prepare(`SELECT COALESCE(SUM(amount), 0) s FROM budget_entries WHERE org_id = ? AND kind = 'expense' AND date >= ? AND date < ?${sc.sql}`).get(req.org.id, m.from, m.to, ...sc.args)).s;
  const today = W.today();
  const open = docs.filter((d) => d.kind === 'invoice' && d.status === 'sent' && d.paid < d.total - d.credited);
  const aging = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
  for (const d of open) {
    const bal = d.total - d.credited - d.paid; const late = d.due ? Math.floor((Date.parse(today) - Date.parse(d.due)) / 86400000) : 0;
    if (late <= 0) aging.notDue += bal; else if (late <= 30) aging.d1_30 += bal; else if (late <= 60) aging.d31_60 += bal; else if (late <= 90) aging.d61_90 += bal; else aging.d90 += bal;
  }
  const receivables = Object.values(aging).reduce((a, b) => a + b, 0);
  const cashRow = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE -amount END), 0) s FROM budget_entries WHERE org_id = ?${sc.sql}`).get(req.org.id, ...sc.args);
  let forecast = null;
  if (A.can(req, 'admin')) { try { const cf = await require('./budget-annual').cashflow(req, 3, 100); forecast = { months: cf.months.map((x) => ({ month: x.month, closing: x.closing })), alert: cf.alert || null }; } catch { forecast = null; } }
  const series = [];
  for (let i = 5; i >= 0; i--) { const mo = monthsBack(i); const r = A.monthRange(mo); series.push({ month: mo, revenue: sumIn(r.from, r.to) }); }
  const newCust = Number((await db.prepare(`SELECT COUNT(*) c FROM customers WHERE org_id = ? AND created_at >= ? AND created_at < ?${sc.sql}`).get(req.org.id, m.from, m.to, ...sc.args)).c);
  const csat = await db.prepare(`SELECT AVG(csat) a, COUNT(csat) n FROM tickets WHERE org_id = ? AND csat IS NOT NULL AND csat_at >= ? AND csat_at < ?${sc.sql}`).get(req.org.id, m.from, m.to, ...sc.args);
  const goal = (value, target) => (target > 0 ? { target, value, percent: Math.round((100 * value) / target) } : null);
  let hr = { due: 0 }; let payrollMissing = false;
  if (A.can(req, 'manager')) {
    hr = { due: (await require('./hr-w3').dueItems(req)).length };
    if (A.can(req, 'admin') && today.slice(8, 10) >= '25') {
      const active = Number((await db.prepare("SELECT COUNT(*) c FROM employees WHERE org_id = ? AND status = 'active' AND salary IS NOT NULL").get(req.org.id)).c);
      const slips = Number((await db.prepare('SELECT COUNT(*) c FROM payroll_slips WHERE org_id = ? AND month = ?').get(req.org.id, today.slice(0, 7))).c);
      payrollMissing = active > 0 && slips === 0;
    }
  }
  return { month: m.month, currency: req.org.currency, revenue, revenueYtd: sumIn(ytdFrom, m.to), expenses: Number(exp), margin: revenue - Number(exp), marginNote: "Estimation de gestion : chiffre d'affaires HT moins les sorties du budget du mois.",
    receivables: { total: receivables, aging }, cash: { balance: Number(cashRow.s), forecast }, series,
    goals: { revenue: goal(revenue, st.goal_revenue_month), newCustomers: goal(newCust, st.goal_new_customers_month), csat: goal(csat.a ? Math.round(Number(csat.a) * 10) / 10 : 0, st.goal_csat) },
    thresholds: { cashMin: st.alert_cash_min, receivableMax: st.alert_receivable_max, overdueDays: st.alert_overdue_days }, hr: { ...hr, payrollMissing }, csat: { average: csat.a ? Math.round(Number(csat.a) * 10) / 10 : null, count: Number(csat.n) } };
}
router.get('/kpis', A.need('manager'), async (req, res) => res.json(await kpis(req, req.query.month)));
router.get('/kpis.csv', A.need('manager'), async (req, res) => {
  const k = await kpis(req, req.query.month);
  const rows = [['Mois', k.month], ['Chiffre d\'affaires HT', k.revenue], ['Chiffre d\'affaires HT depuis janvier', k.revenueYtd], ['Sorties du budget', k.expenses], ['Marge estimée', k.margin], ['Créances clients', k.receivables.total],
    ['Créances non échues', k.receivables.aging.notDue], ['Créances 1-30 jours', k.receivables.aging.d1_30], ['Créances 31-60 jours', k.receivables.aging.d31_60], ['Créances 61-90 jours', k.receivables.aging.d61_90], ['Créances plus de 90 jours', k.receivables.aging.d90], ['Trésorerie (solde du budget)', k.cash.balance]];
  for (const s of k.series) rows.push([`CA ${s.month}`, s.revenue]);
  W.sendCsv(res, `tableau-de-bord-${k.month}.csv`, ['Indicateur', 'Valeur'], rows);
});

module.exports = router;
module.exports.kpis = kpis;
