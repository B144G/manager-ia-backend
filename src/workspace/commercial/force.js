'use strict';
// Management de la force de vente : objectifs (décomposition), classement, commissions et primes par règles, visites, tournées, agenda, coaching.
// Attribution des ventes : au commercial qui suit le compte (sinon à l'auteur de la facture).
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const W = require('../w3');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const Dt = require('./data');
const { HttpError } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;
const monthP = (v) => { const m = v || B.today().slice(0, 7); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new HttpError(400, 'Mois invalide (AAAA-MM).'); return m; };
const monthRange = (m) => ({ from: `${m}-01`, to: `${L.addMonths(m, 1)}-01` });

async function salesTeam(orgId) {
  return (await db.prepare("SELECT r.user_id, r.role, r.team_id, u.name FROM cp_roles r JOIN users u ON u.id = r.user_id WHERE r.org_id = ?").all(orgId)).map((r) => ({ userId: Number(r.user_id), role: r.role, teamId: r.team_id ? Number(r.team_id) : null, name: r.name }));
}
/** Chiffres du mois par commercial (réalisé, objectifs, activités, affaires, prospects). */
async function monthStats(req, month) {
  const { from, to } = monthRange(month);
  const team = await salesTeam(req.org.id);
  const inv = await Dt.invoices(req.org.id, { from, to: L.addDays(to, -1) });
  const tg = await db.prepare("SELECT user_id, metric, value FROM cp_targets WHERE org_id = ? AND period = ?").all(req.org.id, month);
  const acts = await db.prepare('SELECT user_id, kind, COUNT(*) n FROM cp_activities WHERE org_id = ? AND happened_at >= ? AND happened_at < ? GROUP BY user_id, kind').all(req.org.id, `${from}T00:00:00`, `${to}T00:00:00`);
  const won = await db.prepare("SELECT owner_id, COUNT(*) n, SUM(amount) s FROM cp_opps WHERE org_id = ? AND status = 'won' AND closed_at >= ? AND closed_at < ? GROUP BY owner_id").all(req.org.id, `${from}T00:00:00`, `${to}T00:00:00`);
  const lost = await db.prepare("SELECT owner_id, COUNT(*) n FROM cp_opps WHERE org_id = ? AND status = 'lost' AND closed_at >= ? AND closed_at < ? GROUP BY owner_id").all(req.org.id, `${from}T00:00:00`, `${to}T00:00:00`);
  const conv = await db.prepare("SELECT owner_id, COUNT(*) n FROM cp_leads WHERE org_id = ? AND status = 'converted' AND converted_at >= ? AND converted_at < ? GROUP BY owner_id").all(req.org.id, `${from}T00:00:00`, `${to}T00:00:00`);
  const visits = await db.prepare("SELECT user_id, COUNT(*) n FROM cp_visits WHERE org_id = ? AND status = 'done' AND date >= ? AND date < ? GROUP BY user_id").all(req.org.id, from, to);
  const open = await db.prepare("SELECT o.owner_id, o.amount, o.probability, s.probability AS sp FROM cp_opps o JOIN cp_stages s ON s.id = o.stage_id WHERE o.org_id = ? AND o.status = 'open'").all(req.org.id);
  const get = (rows, uid, col = 'user_id') => rows.filter((r) => Number(r[col]) === uid);
  return team.map((m) => {
    const revenue = inv.filter((d) => d.ownerId === m.userId).reduce((a, d) => a + d.net, 0);
    const target = N((get(tg, m.userId).find((t) => t.metric === 'revenue') || {}).value);
    const act = Object.fromEntries(get(acts, m.userId).map((a) => [a.kind, N(a.n)]));
    const w = get(won, m.userId, 'owner_id')[0]; const lo = get(lost, m.userId, 'owner_id')[0];
    const wonN = w ? N(w.n) : 0; const lostN = lo ? N(lo.n) : 0;
    const myOpen = get(open, m.userId, 'owner_id');
    const activities = Object.values(act).reduce((a, b) => a + b, 0) + N((get(visits, m.userId)[0] || {}).n);
    return { ...m, revenue, target, attainment: target ? L.round((revenue * 100) / target, 1) : null, invoices: inv.filter((d) => d.ownerId === m.userId).length, activities: { ...act, visits: N((get(visits, m.userId)[0] || {}).n), total: activities }, oppsWon: wonN, oppsWonAmount: w ? N(w.s) : 0, oppsLost: lostN, winRate: wonN + lostN ? L.round((wonN * 100) / (wonN + lostN), 1) : null, leadsConverted: N((get(conv, m.userId, 'owner_id')[0] || {}).n), pipelineWeighted: myOpen.reduce((a, o) => a + L.weighted(o.amount, o.probability === null ? o.sp : o.probability), 0), openOpps: myOpen.length };
  });
}

router.get('/force/overview', P.need('view'), async (req, res) => {
  const month = monthP(req.query.month);
  const cp = await P.load(req);
  let rows = await monthStats(req, month);
  rows = rows.filter((r) => ['sales_manager', 'sales_field', 'sales_assistant'].includes(r.role));
  rows.sort((a, b) => (b.attainment === null ? -1 : b.attainment) - (a.attainment === null ? -1 : a.attainment) || b.revenue - a.revenue);
  rows.forEach((r, i) => { r.rank = i + 1; });
  if (cp.scopeOwn) rows = rows.filter((r) => r.userId === req.user.id);
  const tot = (k) => rows.reduce((a, r) => a + N(r[k]), 0);
  res.json({ month, team: rows, totals: { revenue: tot('revenue'), target: tot('target'), attainment: tot('target') ? L.round((tot('revenue') * 100) / tot('target'), 1) : null, oppsWon: tot('oppsWon'), activities: rows.reduce((a, r) => a + r.activities.total, 0) } });
});

// ---------- Décomposition des objectifs ----------
router.post('/targets/decompose', P.need('targets'), async (req, res) => {
  const b = req.body || {};
  const total = Math.round(Number(b.total));
  if (!(total >= 0 && total < 1e13)) throw new HttpError(400, 'Objectif total invalide.');
  const periods = (Array.isArray(b.periods) ? b.periods : []).map(monthP);
  if (!periods.length || periods.length > 12 || new Set(periods).size !== periods.length) throw new HttpError(400, 'Indiquez de 1 à 12 mois distincts.');
  const metric = A.oneOf(b.metric, ['revenue', 'margin', 'new_customers', 'visits', 'opps_won'], 'revenue', 'Indicateur inconnu.');
  const pw = periods.map((p) => (b.periodWeights && b.periodWeights[p] !== undefined ? Number(b.periodWeights[p]) : 1));
  const users = []; for (const u of (Array.isArray(b.userIds) ? b.userIds : [])) users.push(await A.memberOf(req, u));
  const uw = users.map((u) => (b.userWeights && b.userWeights[u] !== undefined ? Number(b.userWeights[u]) : 1));
  if ([...pw, ...uw].some((w) => !Number.isFinite(w) || w < 0)) throw new HttpError(400, 'Les poids doivent être positifs ou nuls.');
  const perPeriod = L.decompose(total, pw);
  const rows = [];
  await db.transaction(async () => {
    for (let i = 0; i < periods.length; i++) {
      const put = async (uid, v) => { await db.prepare('INSERT INTO cp_targets (org_id, user_id, period, metric, value, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, user_id, period, metric) DO UPDATE SET value = excluded.value, created_by = excluded.created_by').run(req.org.id, uid, periods[i], metric, v, req.user.id, nowISO()); rows.push({ period: periods[i], userId: uid || null, value: v }); };
      await put(0, perPeriod[i]);
      if (users.length) { const split = L.decompose(perPeriod[i], uw); for (let k = 0; k < users.length; k++) await put(users[k], split[k]); }
    }
  })();
  await P.audit(req, 'target', null, 'decompose', { total, periods, users });
  res.json({ rows });
});

// ---------- Commissions ----------
const cleanTiers = (v) => {
  if (!Array.isArray(v) || !v.length || v.length > 8) throw new HttpError(400, 'Une règle compte de 1 à 8 tranches.');
  let prev = 0;
  return v.map((t, i) => {
    const rate = Number(t.rate); const up = t.upTo === null || t.upTo === undefined || t.upTo === '' ? null : Number(t.upTo);
    if (!(rate >= 0 && rate <= 100)) throw new HttpError(400, 'Le taux de commission va de 0 à 100 %.');
    if (up === null && i !== v.length - 1) throw new HttpError(400, 'Seule la dernière tranche est sans limite.');
    if (up !== null && !(up > prev)) throw new HttpError(400, 'Les plafonds de tranche doivent croître.');
    prev = up === null ? prev : up;
    return { upTo: up, rate };
  });
};
const ruleView = (r) => ({ id: Number(r.id), name: r.name, basis: r.basis, tiers: JSON.parse(r.tiers), bonuses: JSON.parse(r.bonuses), roles: JSON.parse(r.roles), active: Boolean(Number(r.active)) });
router.get('/commissions/rules', P.need('commissions'), async (req, res) => res.json({ rules: (await db.prepare('SELECT * FROM cp_commission_rules WHERE org_id = ? ORDER BY id').all(req.org.id)).map(ruleView) }));
async function saveRule(req, id, b) {
  const bonuses = (Array.isArray(b.bonuses) ? b.bonuses : []).slice(0, 6).map((x) => ({ attainmentPct: Number(x.attainmentPct), bonus: Math.round(Number(x.bonus)) }));
  if (bonuses.some((x) => !(x.attainmentPct > 0 && x.bonus >= 0))) throw new HttpError(400, 'Chaque prime a un seuil d’atteinte (%) et un montant.');
  const vals = [A.text(b.name, 80, { required: true, msg: 'Nommez la règle.' }), A.oneOf(b.basis, ['revenue', 'margin'], 'revenue', 'Base inconnue (chiffre d’affaires ou marge).'), JSON.stringify(cleanTiers(b.tiers)), JSON.stringify(bonuses), JSON.stringify((Array.isArray(b.roles) ? b.roles : []).filter((r) => P.CROLES.includes(r))), b.active === false ? 0 : 1];
  if (id) await db.prepare('UPDATE cp_commission_rules SET name = ?, basis = ?, tiers = ?, bonuses = ?, roles = ?, active = ? WHERE id = ? AND org_id = ?').run(...vals, id, req.org.id);
  else id = Number((await db.prepare('INSERT INTO cp_commission_rules (name, basis, tiers, bonuses, roles, active, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, req.org.id, nowISO())).lastInsertRowid);
  return id;
}
router.post('/commissions/rules', P.need('commissions'), async (req, res) => { const id = await saveRule(req, null, req.body || {}); await P.audit(req, 'commission_rule', id, 'create', (req.body || {}).name); res.status(201).json({ id }); });
router.put('/commissions/rules/:id', P.need('commissions'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM cp_commission_rules WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Règle introuvable.');
  await saveRule(req, Number(r.id), { ...ruleView(r), ...(req.body || {}) });
  await P.audit(req, 'commission_rule', r.id, 'update', Object.keys(req.body || {}).join(','));
  res.json({ ok: true });
});
router.delete('/commissions/rules/:id', P.need('commissions'), async (req, res) => {
  const x = await db.prepare('DELETE FROM cp_commission_rules WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!x.changes) throw new HttpError(404, 'Règle introuvable.');
  res.json({ ok: true });
});
async function computeCommissions(req, month) {
  const rules = (await db.prepare('SELECT * FROM cp_commission_rules WHERE org_id = ? AND active = 1 ORDER BY id').all(req.org.id)).map(ruleView);
  if (!rules.length) return [];
  const stats = await monthStats(req, month);
  const { from, to } = monthRange(month);
  const inv = await Dt.invoices(req.org.id, { from, to: L.addDays(to, -1) });
  const costOf = await require('./pricing-pro').costResolver(req.org.id);
  const out = [];
  for (const s of stats) {
    if (s.role === 'sales_assistant') continue;
    const rule = rules.find((r) => !r.roles.length || r.roles.includes(s.role));
    if (!rule) continue;
    let basis = s.revenue;
    if (rule.basis === 'margin') {
      const ms = []; for (const d of inv.filter((x) => x.ownerId === s.userId)) for (const l of d.lines) ms.push(L.lineMargin(l, { vatRate: d.vatRate === null ? Number(req.org.vat_rate) : Number(d.vatRate), pricesIncl: d.pricesIncl }, costOf(l)));
      basis = L.sumMargins(ms).margin;
    }
    const c = L.commission(basis, rule.tiers, rule.bonuses, s.attainment);
    out.push({ userId: s.userId, name: s.name, role: s.role, ruleId: rule.id, rule: rule.name, basisKind: rule.basis, basis, revenue: s.revenue, target: s.target, attainment: s.attainment, ...c });
  }
  return out;
}
router.get('/commissions/compute', P.need('view'), async (req, res) => {
  const cp = await P.load(req);
  if (!cp.perms.includes('commissions') && !cp.scopeOwn && !cp.perms.includes('write')) throw new HttpError(403, 'Votre rôle commercial ne permet pas cette action.');
  let rows = await computeCommissions(req, monthP(req.query.month));
  if (!cp.perms.includes('commissions')) rows = rows.filter((r) => r.userId === req.user.id);
  res.json({ month: monthP(req.query.month), rows, total: rows.reduce((a, r) => a + r.total, 0) });
});
router.post('/commissions/close', P.need('commissions'), async (req, res) => {
  const month = monthP((req.body || {}).month);
  const rows = await computeCommissions(req, month);
  let n = 0;
  for (const r of rows) {
    const ex = await db.prepare('SELECT * FROM cp_commission_statements WHERE org_id = ? AND period = ? AND user_id = ?').get(req.org.id, month, r.userId);
    if (ex && ex.status !== 'draft') continue;
    await db.prepare(`INSERT INTO cp_commission_statements (org_id, period, user_id, rule_id, basis_amount, commission, bonus, total, attainment_pct, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id, period, user_id) DO UPDATE SET rule_id = excluded.rule_id, basis_amount = excluded.basis_amount, commission = excluded.commission, bonus = excluded.bonus, total = excluded.total, attainment_pct = excluded.attainment_pct, detail = excluded.detail`)
      .run(req.org.id, month, r.userId, r.ruleId, r.basis, r.commission, r.bonus, r.total, r.attainment, JSON.stringify({ rule: r.rule, basisKind: r.basisKind, tiers: r.detail }), nowISO()); n++;
  }
  await P.audit(req, 'commission', null, 'close', { month, statements: n });
  res.json({ month, statements: n });
});
router.get('/commissions/statements', P.need('view'), async (req, res) => {
  const cp = await P.load(req); const names = await B.names(req.org.id);
  const rows = await db.prepare(`SELECT * FROM cp_commission_statements WHERE org_id = ?${req.query.month ? ' AND period = ?' : ''}${cp.perms.includes('commissions') ? '' : ' AND user_id = ?'} ORDER BY period DESC, id`).all(req.org.id, ...(req.query.month ? [monthP(req.query.month)] : []), ...(cp.perms.includes('commissions') ? [] : [req.user.id]));
  res.json({ statements: rows.map((r) => ({ id: Number(r.id), period: r.period, userId: Number(r.user_id), user: names.get(Number(r.user_id)) || '', basis: N(r.basis_amount), commission: N(r.commission), bonus: N(r.bonus), total: N(r.total), attainment: r.attainment_pct === null ? null : Number(r.attainment_pct), status: r.status, detail: JSON.parse(r.detail || '{}') })) });
});
router.post('/commissions/statements/:id/:action(approve|pay)', P.need('commissions'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM cp_commission_statements WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Relevé introuvable.');
  const next = req.params.action === 'approve' ? 'approved' : 'paid';
  if ((next === 'approved' && r.status !== 'draft') || (next === 'paid' && r.status !== 'approved')) throw new HttpError(409, 'Ce relevé ne peut pas passer à cet état.');
  await db.prepare('UPDATE cp_commission_statements SET status = ?, approved_by = ? WHERE id = ?').run(next, req.user.id, r.id);
  await P.audit(req, 'commission', r.id, next, { total: N(r.total) });
  await W.push(req.org.id, Number(r.user_id), 'commercial', `Votre relevé de commission ${r.period} est ${next === 'approved' ? 'validé' : 'payé'}.`, 'commission:' + r.id);
  res.json({ ok: true });
});

// ---------- Visites, tournées, agenda ----------
const visitView = (v, names) => ({ id: Number(v.id), userId: Number(v.user_id), user: names.get(Number(v.user_id)) || '', customerId: v.customer_id ? Number(v.customer_id) : null, customer: v.customer || '', leadId: v.lead_id ? Number(v.lead_id) : null, lead: v.lead || '', date: v.date, time: v.time, purpose: v.purpose, status: v.status, outcome: v.outcome, tourId: v.tour_id ? Number(v.tour_id) : null, order: N(v.order_idx), city: v.city || '' });
router.get('/visits', P.need('view'), async (req, res) => {
  const { from, to } = B.range({ ...req.query, from: req.query.from || B.today(), to: req.query.to || L.addDays(B.today(), 14) });
  const cp = await P.load(req); const names = await B.names(req.org.id);
  const uid = cp.scopeOwn ? req.user.id : req.query.userId ? A.id(req.query.userId) : null;
  const rows = await db.prepare(`SELECT v.*, c.name AS customer, c.city AS city, l.name AS lead FROM cp_visits v LEFT JOIN customers c ON c.id = v.customer_id LEFT JOIN cp_leads l ON l.id = v.lead_id WHERE v.org_id = ? AND v.date >= ? AND v.date <= ?${uid ? ' AND v.user_id = ?' : ''} ORDER BY v.date, v.order_idx, v.time, v.id`).all(req.org.id, from, to, ...(uid ? [uid] : []));
  res.json({ visits: rows.map((v) => visitView(v, names)) });
});
router.post('/visits', P.need('activity'), async (req, res) => {
  const b = req.body || {};
  const cp = await P.load(req);
  const uid = cp.scopeOwn || !b.userId ? req.user.id : await A.memberOf(req, b.userId);
  if (!b.customerId && !b.leadId) throw new HttpError(400, 'Rattachez la visite à un compte ou à un prospect.');
  const cust = b.customerId ? await require('./crm360').accountOf(req, b.customerId) : null;
  const lead = b.leadId ? await db.prepare('SELECT * FROM cp_leads WHERE id = ? AND org_id = ?').get(A.id(b.leadId), req.org.id) : null;
  if (b.leadId && !lead) throw new HttpError(404, 'Prospect introuvable.');
  let tour = null;
  if (b.tourId) { tour = await db.prepare('SELECT * FROM cp_tours WHERE id = ? AND org_id = ?').get(A.id(b.tourId), req.org.id); if (!tour) throw new HttpError(404, 'Tournée introuvable.'); }
  const date = A.date(b.date) || (tour && tour.date);
  if (!date) throw new HttpError(400, 'Indiquez la date de la visite.');
  const idx = N((await db.prepare('SELECT COALESCE(MAX(order_idx), 0) m FROM cp_visits WHERE org_id = ? AND user_id = ? AND date = ?').get(req.org.id, uid, date)).m) + 1;
  const id = (await db.prepare('INSERT INTO cp_visits (org_id, user_id, customer_id, lead_id, date, time, purpose, tour_id, order_idx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, uid, cust ? cust.id : null, lead ? lead.id : null, date, /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : '', A.text(b.purpose, 200), tour ? tour.id : null, idx, nowISO())).lastInsertRowid;
  if (uid !== req.user.id) await W.push(req.org.id, uid, 'commercial', `Visite planifiée le ${date} : ${cust ? cust.name : lead.name}`, 'visit:' + id);
  res.status(201).json({ id: Number(id) });
});
router.put('/visits/:id', P.need('activity'), async (req, res) => {
  const v = await db.prepare('SELECT * FROM cp_visits WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!v) throw new HttpError(404, 'Visite introuvable.');
  const cp = await P.load(req);
  if (cp.scopeOwn && Number(v.user_id) !== req.user.id) throw new HttpError(403, 'Cette visite est celle d’un autre commercial.');
  const b = req.body || {};
  const status = b.status === undefined ? v.status : A.oneOf(b.status, ['planned', 'done', 'missed', 'cancelled'], undefined, 'Statut inconnu.');
  await db.prepare('UPDATE cp_visits SET date = ?, time = ?, purpose = ?, status = ?, outcome = ?, order_idx = ? WHERE id = ?').run(b.date === undefined ? v.date : A.date(b.date), b.time === undefined ? v.time : A.text(b.time, 5), b.purpose === undefined ? v.purpose : A.text(b.purpose, 200), status, b.outcome === undefined ? v.outcome : A.text(b.outcome, 500), b.order === undefined ? v.order_idx : Math.round(Number(b.order)) || 0, v.id);
  if (status === 'done' && v.status !== 'done') await db.prepare("INSERT INTO cp_activities (org_id, kind, customer_id, lead_id, user_id, outcome, note, happened_at, created_at) VALUES (?, 'visit', ?, ?, ?, ?, ?, ?, ?)").run(req.org.id, v.customer_id, v.lead_id, v.user_id, A.text(b.outcome, 120), A.text(b.outcome, 500), nowISO(), nowISO());
  res.json({ ok: true });
});
router.delete('/visits/:id', P.need('activity'), async (req, res) => {
  const v = await db.prepare('SELECT * FROM cp_visits WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!v) throw new HttpError(404, 'Visite introuvable.');
  if ((await P.load(req)).scopeOwn && Number(v.user_id) !== req.user.id) throw new HttpError(403, 'Cette visite est celle d’un autre commercial.');
  await db.prepare('DELETE FROM cp_visits WHERE id = ?').run(v.id);
  res.json({ ok: true });
});
router.post('/tours', P.need('activity'), async (req, res) => {
  const b = req.body || {};
  const cp = await P.load(req);
  const uid = cp.scopeOwn || !b.userId ? req.user.id : await A.memberOf(req, b.userId);
  const id = (await db.prepare('INSERT INTO cp_tours (org_id, user_id, date, name, zone_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, uid, A.date(b.date) || B.today(), A.text(b.name, 80), b.zoneId ? A.id(b.zoneId) : null, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.get('/tours', P.need('view'), async (req, res) => {
  const { from, to } = B.range({ ...req.query, from: req.query.from || B.today(), to: req.query.to || L.addDays(B.today(), 14) });
  const cp = await P.load(req); const names = await B.names(req.org.id);
  const rows = await db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM cp_visits v WHERE v.tour_id = t.id) AS stops, (SELECT COUNT(*) FROM cp_visits v WHERE v.tour_id = t.id AND v.status = 'done') AS done FROM cp_tours t WHERE t.org_id = ? AND t.date >= ? AND t.date <= ?${cp.scopeOwn ? ' AND t.user_id = ?' : ''} ORDER BY t.date`).all(req.org.id, from, to, ...(cp.scopeOwn ? [req.user.id] : []));
  res.json({ tours: rows.map((t) => ({ id: Number(t.id), userId: Number(t.user_id), user: names.get(Number(t.user_id)) || '', date: t.date, name: t.name, zoneId: t.zone_id ? Number(t.zone_id) : null, stops: N(t.stops), done: N(t.done) })) });
});
/** Ordonne les visites d'une tournée par ville puis par heure (aucune carte : le regroupement par ville évite les allers-retours). */
router.post('/tours/:id/optimize', P.need('activity'), async (req, res) => {
  const t = await db.prepare('SELECT * FROM cp_tours WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t) throw new HttpError(404, 'Tournée introuvable.');
  const vs = await db.prepare('SELECT v.id, v.time, c.city FROM cp_visits v LEFT JOIN customers c ON c.id = v.customer_id WHERE v.tour_id = ?').all(t.id);
  vs.sort((a, b) => L.normName(a.city).localeCompare(L.normName(b.city)) || String(a.time || '99').localeCompare(String(b.time || '99')) || a.id - b.id);
  for (let i = 0; i < vs.length; i++) await db.prepare('UPDATE cp_visits SET order_idx = ? WHERE id = ?').run(i + 1, vs[i].id);
  res.json({ order: vs.map((v) => Number(v.id)) });
});
router.get('/agenda', P.need('view'), async (req, res) => {
  const { from, to } = B.range({ ...req.query, from: req.query.from || B.today(), to: req.query.to || L.addDays(B.today(), 7) });
  const cp = await P.load(req);
  const uid = cp.scopeOwn ? req.user.id : req.query.userId ? A.id(req.query.userId) : req.user.id;
  const items = [];
  for (const v of await db.prepare("SELECT v.*, c.name AS customer FROM cp_visits v LEFT JOIN customers c ON c.id = v.customer_id WHERE v.org_id = ? AND v.user_id = ? AND v.date >= ? AND v.date <= ? AND v.status <> 'cancelled'").all(req.org.id, uid, from, to)) items.push({ type: 'visit', id: Number(v.id), date: v.date, time: v.time, title: v.customer || v.purpose, status: v.status });
  for (const t of await db.prepare("SELECT * FROM cp_tasks WHERE org_id = ? AND assignee_id = ? AND status = 'open' AND due_at >= ? AND due_at < ?").all(req.org.id, uid, `${from}T00:00:00`, `${L.addDays(to, 1)}T00:00:00`)) items.push({ type: 'task', id: Number(t.id), date: t.due_at.slice(0, 10), time: t.due_at.slice(11, 16), title: t.title, status: t.status });
  for (const a of await db.prepare("SELECT a.*, c.name AS customer FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.org_id = ? AND c.owner_id = ? AND a.date >= ? AND a.date <= ? AND a.status <> 'cancelled'").all(req.org.id, uid, from, to)) items.push({ type: 'appointment', id: Number(a.id), date: a.date, time: a.time, title: a.customer, status: a.status });
  items.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  res.json({ userId: uid, from, to, items });
});

// ---------- Coaching ----------
router.get('/coaching/:userId', P.need('view'), async (req, res) => {
  const cp = await P.load(req); const uid = A.id(req.params.userId);
  if (!cp.perms.includes('coach') && uid !== req.user.id) throw new HttpError(403, 'Votre rôle commercial ne permet pas cette action.');
  const month = monthP(req.query.month);
  const stats = (await monthStats(req, month)).filter((s) => s.role !== 'sales_assistant');
  const me = stats.find((s) => s.userId === uid);
  if (!me) throw new HttpError(404, 'Ce commercial ne figure pas dans la force de vente.');
  const others = stats.filter((s) => s.userId !== uid);
  const avg = (f) => (others.length ? others.reduce((a, s) => a + f(s), 0) / others.length : null);
  const tips = [];
  const avgAct = avg((s) => s.activities.total);
  if (avgAct !== null && me.activities.total < avgAct * 0.7) tips.push({ code: 'low_activity', params: { mine: me.activities.total, team: L.round(avgAct, 1) } });
  const avgWin = avg((s) => N(s.winRate));
  if (me.winRate !== null && avgWin && me.winRate < avgWin * 0.8) tips.push({ code: 'low_win_rate', params: { mine: me.winRate, team: L.round(avgWin, 1) } });
  if (me.attainment !== null && me.attainment < 70) tips.push({ code: 'behind_target', params: { attainment: me.attainment } });
  const remaining = Math.max(0, me.target - me.revenue);
  if (me.target && remaining > 0 && me.pipelineWeighted < remaining * 1.5) tips.push({ code: 'thin_pipeline', params: { weighted: me.pipelineWeighted, remaining } });
  const stagn = await db.prepare("SELECT COUNT(*) n FROM cp_opps o JOIN cp_stages s ON s.id = o.stage_id WHERE o.org_id = ? AND o.owner_id = ? AND o.status = 'open' AND s.stagnant_days > 0 AND o.stage_entered_at < ?").get(req.org.id, uid, new Date(Date.now() - 14 * 86400000).toISOString());
  if (N(stagn.n) > 0) tips.push({ code: 'stagnant_opps', params: { count: N(stagn.n) } });
  const stale = await db.prepare("SELECT COUNT(*) n FROM cp_leads WHERE org_id = ? AND owner_id = ? AND status IN ('new','contacted') AND COALESCE(last_contact_at, created_at) < ?").get(req.org.id, uid, new Date(Date.now() - 7 * 86400000).toISOString());
  if (N(stale.n) > 0) tips.push({ code: 'untouched_leads', params: { count: N(stale.n) } });
  if (!tips.length) tips.push({ code: 'on_track', params: {} });
  res.json({ userId: uid, name: me.name, month, metrics: me, team: { activities: avgAct === null ? null : L.round(avgAct, 1), winRate: avgWin === null ? null : L.round(avgWin, 1) }, gaps: { activities: avgAct === null ? null : L.round(me.activities.total - avgAct, 1), revenue: me.target ? me.revenue - me.target : null }, tips });
});

module.exports = { router, monthStats, computeCommissions };
