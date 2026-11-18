'use strict';
// Analyse de la performance commerciale : tableau de bord direction et commercial, comparaison de périodes, résumé en phrases (codes + chiffres, traduits par l'écran),
// rapports exportables en PDF, Excel (.xlsx) et CSV.
const express = require('express');
const { db } = require('../../db');
const A = require('../access');
const W = require('../w3');
const pdf = require('../../services/pdf');
const xlsx = require('./xlsx');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const Dt = require('./data');
const { HttpError } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;
const pct = (a, b) => (b ? L.round(((a - b) * 100) / b, 1) : null);

async function kpis(req, from, to, ownerId) {
  const costOf = await require('./pricing-pro').costResolver(req.org.id);
  const inv = (await Dt.invoices(req.org.id, { from, to })).filter((d) => !ownerId || d.ownerId === ownerId);
  const revenue = inv.reduce((a, d) => a + d.net, 0);
  const ms = []; for (const d of inv) for (const l of d.lines) ms.push(L.lineMargin(l, { vatRate: d.vatRate === null ? Number(req.org.vat_rate) : Number(d.vatRate), pricesIncl: d.pricesIncl }, costOf(l)));
  const mg = L.sumMargins(ms);
  const t0 = `${from}T00:00:00`; const t1 = `${L.addDays(to, 1)}T00:00:00`;
  const ow = (col) => (ownerId ? ` AND ${col} = ${Number(ownerId)}` : '');
  const leads = await db.prepare(`SELECT status FROM cp_leads WHERE org_id = ? AND created_at >= ? AND created_at < ?${ow('owner_id')}`).all(req.org.id, t0, t1);
  const closed = await db.prepare(`SELECT status, amount, created_at, closed_at FROM cp_opps WHERE org_id = ? AND status IN ('won','lost') AND closed_at >= ? AND closed_at < ?${ow('owner_id')}`).all(req.org.id, t0, t1);
  const won = closed.filter((o) => o.status === 'won'); const lost = closed.filter((o) => o.status === 'lost');
  const newCust = N((await db.prepare(`SELECT COUNT(*) c FROM customers WHERE org_id = ? AND created_at >= ? AND created_at < ?${ow('owner_id')}`).get(req.org.id, t0, t1)).c);
  let target = 0; for (const m of L.monthsBetween(from.slice(0, 7), to.slice(0, 7))) target += await require('./forecast').revenueTarget(req.org.id, m);
  const conv = leads.filter((l) => l.status === 'converted').length;
  return {
    revenue, invoices: inv.length, avgBasket: inv.length ? Math.round(revenue / inv.length) : 0, margin: mg.margin, marginPct: mg.pct, marginCoverage: mg.coverage, newCustomers: newCust,
    leads: leads.length, leadsConverted: conv, leadConversion: leads.length ? L.round((conv * 100) / leads.length, 1) : null, oppsWon: won.length, oppsLost: lost.length, wonAmount: won.reduce((a, o) => a + N(o.amount), 0),
    winRate: won.length + lost.length ? L.round((won.length * 100) / (won.length + lost.length), 1) : null, avgCycleDays: won.length ? L.round(won.reduce((a, o) => a + Math.max(0, L.daysBetween(o.created_at, o.closed_at)), 0) / won.length, 1) : null,
    target, attainment: target ? L.round((revenue * 100) / target, 1) : null, _inv: inv,
  };
}
const strip = ({ _inv, ...k }) => k;

router.get('/analytics/overview', P.need('view'), async (req, res) => {
  const { from, to } = B.range({ ...req.query, from: req.query.from || `${B.today().slice(0, 7)}-01` });
  const cp = await P.load(req);
  const ownerId = cp.scopeOwn ? req.user.id : req.query.ownerId ? A.id(req.query.ownerId) : null;
  const compare = A.oneOf(req.query.compare, ['previous', 'year', 'none'], 'previous', 'Comparaison inconnue.');
  const len = L.daysBetween(from, to) + 1;
  const pFrom = compare === 'year' ? L.addDays(from, -365) : L.addDays(from, -len); const pTo = compare === 'year' ? L.addDays(to, -365) : L.addDays(from, -1);
  const cur = await kpis(req, from, to, ownerId);
  const prev = compare === 'none' ? null : await kpis(req, pFrom, pTo, ownerId);
  const deltas = prev ? Object.fromEntries(['revenue', 'invoices', 'avgBasket', 'margin', 'newCustomers', 'leads', 'oppsWon'].map((k) => [k, pct(cur[k], prev[k])])) : null;
  const names = await B.names(req.org.id);
  const zones = new Map((await db.prepare('SELECT id, name FROM cp_zones WHERE org_id = ?').all(req.org.id)).map((z) => [Number(z.id), z.name]));
  const segRows = new Map((await require('./segments').metrics(req)).rows.map((r) => [r.id, r.segment || 'none']));
  const group = (fn) => { const m = new Map(); for (const d of cur._inv) for (const [k, v] of fn(d)) m.set(k, (m.get(k) || 0) + v); const tot = [...m.values()].reduce((a, b) => a + b, 0); return [...m.entries()].map(([key, revenue]) => ({ key, revenue, share: tot ? L.round((revenue * 100) / tot, 1) : 0 })).sort((a, b) => b.revenue - a.revenue); };
  const byProduct = group((d) => { const sum = d.lines.reduce((a, l) => a + N(l.quantity) * N(l.price), 0); return d.lines.map((l) => [l.label, sum ? Math.round((d.net * N(l.quantity) * N(l.price)) / sum) : 0]); }).slice(0, 15);
  const bySegment = group((d) => [[segRows.get(d.customerId) || 'none', d.net]]);
  const byZone = group((d) => [[d.zoneId ? zones.get(d.zoneId) || '' : '', d.net]]);
  const byOwner = group((d) => [[d.ownerId ? names.get(d.ownerId) || '' : '', d.net]]);
  const byCustomer = group((d) => [[d.customer, d.net]]).slice(0, 10);
  const monthsFrom = L.addMonths(to.slice(0, 7), -11);
  const map = Dt.byMonth(await Dt.invoices(req.org.id, { from: `${monthsFrom}-01`, to }), { ownerId });
  const series = []; for (const m of L.monthsBetween(monthsFrom, to.slice(0, 7))) series.push({ month: m, revenue: N(map.get(m)), target: await require('./forecast').revenueTarget(req.org.id, m) });
  const open = await db.prepare("SELECT o.amount, o.probability, s.probability sp FROM cp_opps o JOIN cp_stages s ON s.id = o.stage_id WHERE o.org_id = ? AND o.status = 'open'" + (ownerId ? ` AND o.owner_id = ${Number(ownerId)}` : '')).all(req.org.id);
  const pipeline = { count: open.length, amount: open.reduce((a, o) => a + N(o.amount), 0), weighted: open.reduce((a, o) => a + L.weighted(o.amount, o.probability === null ? o.sp : o.probability), 0) };
  // Résumé : codes + chiffres (l'écran fabrique les phrases dans la langue de la personne).
  const summary = [];
  if (prev && deltas.revenue !== null) summary.push({ code: deltas.revenue >= 0 ? 'revenue_up' : 'revenue_down', params: { pct: Math.abs(deltas.revenue), revenue: cur.revenue, previous: prev.revenue } });
  else summary.push({ code: 'revenue', params: { revenue: cur.revenue } });
  if (cur.marginPct !== null) summary.push({ code: 'margin', params: { pct: cur.marginPct, coverage: cur.marginCoverage } });
  if (cur.attainment !== null) summary.push({ code: 'target', params: { attainment: cur.attainment, target: cur.target } });
  if (cur.leadConversion !== null) summary.push({ code: 'lead_conversion', params: { pct: cur.leadConversion, leads: cur.leads } });
  if (cur.winRate !== null) summary.push({ code: 'win_rate', params: { pct: cur.winRate, won: cur.oppsWon, lost: cur.oppsLost } });
  if (cur.avgCycleDays !== null) summary.push({ code: 'cycle', params: { days: cur.avgCycleDays } });
  if (byProduct[0]) summary.push({ code: 'top_product', params: { name: byProduct[0].key, share: byProduct[0].share } });
  if (byOwner[0] && byOwner[0].key) summary.push({ code: 'top_seller', params: { name: byOwner[0].key, share: byOwner[0].share } });
  summary.push({ code: 'pipeline', params: { count: pipeline.count, weighted: pipeline.weighted } });
  res.json({ from, to, compare, previousPeriod: prev ? { from: pFrom, to: pTo } : null, kpis: strip(cur), previous: prev ? strip(prev) : null, deltas, series, byProduct, bySegment, byZone, byOwner, topCustomers: byCustomer, pipeline, summary });
});

// ---------- Rapports exportables ----------
async function reportData(req, kind, from, to) {
  const money = (n) => N(n);
  if (kind === 'sales') {
    const inv = await Dt.invoices(req.org.id, { from, to });
    return { title: 'Ventes', head: ['Facture', 'Date', 'Client', 'Net (après avoirs)', 'Encaissé'], rows: inv.map((d) => [d.number, d.issued, d.customer, money(d.net), money(d.paid)]), total: ['Total', '', '', inv.reduce((a, d) => a + d.net, 0), inv.reduce((a, d) => a + d.paid, 0)] };
  }
  if (kind === 'leads') {
    const rows = await db.prepare('SELECT name, company, source, status, score, bant_score, created_at FROM cp_leads WHERE org_id = ? AND created_at >= ? AND created_at < ? ORDER BY score DESC').all(req.org.id, `${from}T00:00:00`, `${L.addDays(to, 1)}T00:00:00`);
    return { title: 'Prospects', head: ['Nom', 'Entreprise', 'Source', 'Statut', 'Score', 'BANT', 'Créé le'], rows: rows.map((r) => [r.name, r.company, r.source, r.status, N(r.score), N(r.bant_score), r.created_at.slice(0, 10)]) };
  }
  if (kind === 'pipeline') {
    const rows = await db.prepare("SELECT o.name, c.name customer, s.name stage, o.amount, COALESCE(o.probability, s.probability) prob, o.close_date FROM cp_opps o LEFT JOIN customers c ON c.id = o.customer_id JOIN cp_stages s ON s.id = o.stage_id WHERE o.org_id = ? AND o.status = 'open' ORDER BY o.amount DESC").all(req.org.id);
    return { title: 'Pipeline', head: ['Opportunité', 'Client', 'Étape', 'Montant', 'Probabilité %', 'Pondéré', 'Clôture prévue'], rows: rows.map((r) => [r.name, r.customer || '', r.stage, N(r.amount), N(r.prob), L.weighted(r.amount, N(r.prob)), r.close_date || '']), total: ['Total', '', '', rows.reduce((a, r) => a + N(r.amount), 0), '', rows.reduce((a, r) => a + L.weighted(r.amount, N(r.prob)), 0), ''] };
  }
  if (kind === 'margins') {
    const costOf = await require('./pricing-pro').costResolver(req.org.id); const m = new Map();
    for (const d of await Dt.invoices(req.org.id, { from, to })) for (const l of d.lines) { const x = L.lineMargin(l, { vatRate: d.vatRate === null ? Number(req.org.vat_rate) : Number(d.vatRate), pricesIncl: d.pricesIncl }, costOf(l)); const v = m.get(l.label) || []; v.push(x); m.set(l.label, v); }
    const rows = [...m.entries()].map(([name, ms]) => ({ name, ...L.sumMargins(ms) })).sort((a, b) => b.revenue - a.revenue);
    return { title: 'Marges par produit', head: ['Produit', 'CA HT', 'Coût', 'Marge', 'Marge %', 'Couverture %'], rows: rows.map((r) => [r.name, r.revenue, r.cost, r.margin, r.pct === null ? '' : r.pct, r.coverage]) };
  }
  if (kind === 'commissions') {
    const rows = await require('./force').computeCommissions(req, from.slice(0, 7));
    return { title: 'Commissions', head: ['Commercial', 'Base', 'Atteinte %', 'Commission', 'Prime', 'Total'], rows: rows.map((r) => [r.name, r.basis, r.attainment === null ? '' : r.attainment, r.commission, r.bonus, r.total]), total: ['Total', '', '', rows.reduce((a, r) => a + r.commission, 0), rows.reduce((a, r) => a + r.bonus, 0), rows.reduce((a, r) => a + r.total, 0)] };
  }
  throw new HttpError(400, 'Rapport inconnu (ventes, prospects, pipeline, marges, commissions).');
}
router.get('/reports/export', P.need('export'), async (req, res) => {
  const kind = A.oneOf(req.query.kind, ['sales', 'leads', 'pipeline', 'margins', 'commissions'], undefined, 'Rapport inconnu.');
  const format = A.oneOf(req.query.format, ['pdf', 'xlsx', 'csv'], 'csv', 'Format inconnu (PDF, Excel, CSV).');
  const { from, to } = B.range({ ...req.query, from: req.query.from || `${B.today().slice(0, 7)}-01` });
  const d = await reportData(req, kind, from, to);
  const base = `commercial-${kind}-${from}_${to}`;
  const rows = d.total ? [...d.rows, d.total] : d.rows;
  await require('./perm').audit(req, 'report', null, 'export', { kind, format, from, to });
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="${base}.${format}"` });
  if (format === 'csv') return res.type('text/csv; charset=utf-8').send(W.toCsv(d.head, rows));
  if (format === 'xlsx') return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(xlsx.build([{ name: d.title, rows: [d.head, ...rows] }]));
  const buf = await pdf.render({ title: d.title, subtitle: `Du ${pdf.dfr(from)} au ${pdf.dfr(to)}`, org: req.org.name, blocks: [{ type: 'table', cols: d.head.map((h, i) => ({ key: 'c' + i, label: h, width: 1, align: i === 0 || typeof d.rows[0]?.[i] === 'string' ? 'left' : 'right' })), rows: rows.map((r) => Object.fromEntries(r.map((v, i) => ['c' + i, typeof v === 'number' ? v.toLocaleString('fr-FR') : String(v)]))) }] });
  return res.type('application/pdf').send(buf);
});

module.exports = { router, kpis };
