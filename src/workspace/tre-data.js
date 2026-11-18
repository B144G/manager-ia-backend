'use strict';
// Trésorerie : lecture des données de l'organisation. (1) Collecte des flux futurs (factures clients et fournisseurs, commandes, paie, emprunts, impôts,
// éléments prévisionnels, opérations en attente, tendance) ; (2) analyses du grand livre : tableau des flux, BFR / FRNG / trésorerie nette, DSO / DPO / DIO / CCC,
// écarts prévu / réalisé. Chaque section ne lit qu'UNE organisation (org_id dans toutes les requêtes).
const { db } = require('../db');
const T = require('./tre-lib');
const F = require('./tre-forecast');
const C = require('./tre-calc');
const { sumAcc, workingCapital, kpiFormulas, interpret, kpiAlerts } = C;

const { today, addDays, diffDays, addMonths, lastDay, num } = T;
const r0 = Math.round;
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
const monthOf = (d) => d.slice(0, 7);
const prevMonths = (month, n) => Array.from({ length: n }, (_, i) => addMonths(`${month}-01`, -(n - 1 - i)).slice(0, 7));

// ---------- Balance du grand livre ----------
/** Soldes cumulés par compte jusqu'à `to` (toutes écritures, à-nouveaux compris) : { compte: débit − crédit }. */
async function ledger(orgId, to) {
  const rows = await db.prepare('SELECT l.account, SUM(l.debit) - SUM(l.credit) AS b FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND e.date <= ? GROUP BY l.account').all(orgId, to);
  const m = {}; for (const r of rows) m[r.account] = num(r.b);
  return m;
}
const hasLedger = async (orgId) => num((await db.prepare('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ?').get(orgId)).c) > 0;

// ---------- Collecte des flux ----------
async function customerDelays(orgId, from) {
  const rows = await db.prepare(`SELECT d.customer_id, d.due, MAX(p.date) AS pdate FROM documents d JOIN doc_payments p ON p.doc_id = d.id AND p.status = 'confirmed'
    WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'paid' AND d.due IS NOT NULL AND d.issued >= ? GROUP BY d.id, d.customer_id, d.due`).all(orgId, addDays(from, -400));
  const per = new Map(); let all = [];
  for (const r of rows) { const late = Math.max(diffDays(r.due, r.pdate), 0); all.push(late); const k = Number(r.customer_id); if (!per.has(k)) per.set(k, []); per.get(k).push(late); }
  const avg = (a) => (a.length ? sum(a) / a.length : 0);
  return { org: avg(all), orgCount: all.length, byCustomer: (id) => { const a = per.get(Number(id)) || []; return a.length >= 2 ? { avgDelay: Math.round(avg(a)), n: a.length } : { avgDelay: Math.round(avg(all)), n: a.length }; }, history: Object.fromEntries([...per].map(([k, a]) => [k, { avgDelay: Math.round(avg(a)), n: a.length }])) };
}

async function openInvoices(orgId) {
  return (await db.prepare(`SELECT d.id, d.number, d.customer_id, c.name AS customer, d.total, d.paid, d.credited, d.due, d.issued FROM documents d JOIN customers c ON c.id = d.customer_id
    WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'sent' AND d.total - d.paid - d.credited > 0 ORDER BY d.due NULLS LAST, d.id`).all(orgId))
    .map((d) => ({ id: Number(d.id), number: d.number, customerId: Number(d.customer_id), customer: d.customer, total: num(d.total), left: num(d.total) - num(d.paid) - num(d.credited), due: d.due || addDays(d.issued, 30), issued: d.issued, hasDue: Boolean(d.due) }));
}

/** Date d'encaissement attendue d'une facture et part qu'on compte réellement (selon l'ancienneté du retard et les taux de provision). */
function expectInvoice(inv, from, delays, prov) {
  const late = diffDays(inv.due, from); const b = F.bucketOf(late);
  const prob = 1 - (prov[b] || 0) / 100;
  let date;
  if (late <= 0) date = addDays(inv.due, delays.byCustomer(inv.customerId).avgDelay);
  else date = addDays(from, b === 'd30' ? 7 : b === 'd60' ? 21 : b === 'd90' ? 45 : 90);
  if (date <= from) date = addDays(from, 1);
  return { date, prob, bucket: b };
}

async function collect(org, st, opts = {}) {
  const from = opts.from || today(); const orgId = org.id; const flows = []; const info = {};
  const add = (f) => { flows.push(f); info[f.source] = (info[f.source] || 0) + 1; };
  const pendingOps = await db.prepare("SELECT * FROM tre_ops WHERE org_id = ? AND status IN ('prepared', 'half') AND kind <> 'transfer'").all(orgId);
  const override = new Map(pendingOps.filter((o) => o.ref_id).map((o) => [`${o.ref_kind}:${o.ref_id}`, o.date]));

  // 1. Factures clients ouvertes
  const delays = await customerDelays(orgId, from);
  for (const inv of await openInvoices(orgId)) {
    const e = expectInvoice(inv, from, delays, st.provision);
    const ov = override.get(`invoice:${inv.id}`);
    add({ date: ov && ov >= from ? ov : e.date, amount: r0(inv.left * e.prob), group: 'clients', source: 'invoice', label: `Facture ${inv.number} · ${inv.customer}`, ref: `invoice:${inv.id}`, gross: inv.left });
  }
  // 2. Dettes fournisseurs ouvertes
  const bills = await db.prepare("SELECT b.*, COALESCE(NULLIF(b.supplier_name, ''), s.name, '') AS party FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.org_id = ? AND b.status IN ('open', 'partial') AND b.amount > b.paid ORDER BY b.due_date, b.id").all(orgId);
  for (const b of bills) {
    const left = num(b.amount) - num(b.paid); const ov = override.get(`bill:${b.id}`);
    const due = b.due_date < from ? addDays(from, 3) : b.due_date;
    add({ date: ov && ov >= from ? ov : due, amount: -left, group: 'fournisseurs', source: 'bill', label: `${b.party || 'Fournisseur'} ${b.number || ''}`.trim(), ref: `bill:${b.id}` });
  }
  // 3. Commandes d'achat en cours, pas encore facturées (stock et achats)
  const orders = await db.prepare(`SELECT o.id, o.number, o.expected_date, o.order_date, o.payment_days, o.vat_rate, s.name AS supplier,
      COALESCE((SELECT SUM(GREATEST(l.quantity - COALESCE((SELECT SUM(rl.received_qty) FROM pur_receipt_lines rl WHERE rl.order_line_id = l.id), 0), 0) * l.unit_price) FROM pur_order_lines l WHERE l.order_id = o.id), 0) AS ht
    FROM pur_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? AND o.status IN ('approved', 'sent', 'partial')`).all(orgId);
  for (const o of orders) {
    const amount = r0(num(o.ht) * (1 + num(o.vat_rate) / 100)); if (amount <= 0) continue;
    let date = addDays(o.expected_date || addDays(o.order_date, 7), num(o.payment_days) || 30); if (date <= from) date = addDays(from, 7);
    add({ date, amount: -amount, group: 'fournisseurs', source: 'order', label: `Commande ${o.number} · ${o.supplier}`, ref: `order:${o.id}` });
  }
  // 4. Paie : mois connus puis moyenne des derniers mois
  const slips = await db.prepare("SELECT month, status, SUM(net) AS net, SUM(employee_deductions + employer_charges) AS social FROM payroll_slips WHERE org_id = ? AND status IN ('validated', 'paid') GROUP BY month, status ORDER BY month").all(orgId);
  if (slips.length) {
    const byMonth = new Map();
    for (const s of slips) { const m = byMonth.get(s.month) || { net: 0, social: 0, paid: true }; m.net += num(s.net); m.social += num(s.social); if (s.status !== 'paid') m.paid = false; byMonth.set(s.month, m); }
    const months = [...byMonth.keys()].sort(); const recent = months.slice(-3);
    const avgNet = r0(sum(recent, (m) => byMonth.get(m).net) / recent.length); const avgSoc = r0(sum(recent, (m) => byMonth.get(m).social) / recent.length);
    const payDay = (m) => `${m}-${String(Math.min(st.payday, Number(lastDay(m).slice(8)))).padStart(2, '0')}`;
    for (let i = -1; i < 13; i++) {
      const m = addMonths(`${monthOf(from)}-01`, i).slice(0, 7); const known = byMonth.get(m);
      const net = known ? known.net : avgNet; const soc = known ? known.social : avgSoc;
      if (net > 0 && !(known && known.paid)) { let d = payDay(m); if (d < from) d = i < 0 ? '' : addDays(from, 1); if (d) add({ date: d, amount: -net, group: 'personnel', source: 'payroll', label: `Salaires ${m}`, ref: `payroll:${m}` }); }
      let sd = `${addMonths(`${m}-01`, 1).slice(0, 7)}-15`;
      if (soc > 0 && sd >= from) add({ date: sd, amount: -soc, group: 'personnel', source: 'payroll', label: `Cotisations ${m}`, ref: `social:${m}` });
    }
  }
  // 5. Échéances d'emprunts
  for (const l of await db.prepare('SELECT l.*, a.label FROM acc_loan_lines l JOIN acc_loans a ON a.id = l.loan_id WHERE a.org_id = ? AND l.due_date >= ? ORDER BY l.due_date').all(orgId, from)) {
    add({ date: l.due_date, amount: -(num(l.principal) + num(l.interest)), group: 'emprunts', source: 'loan', label: `Emprunt ${l.label} · échéance ${l.n}`, ref: `loan:${l.id}` });
  }
  // 6. Obligations fiscales et sociales à payer
  for (const o of await db.prepare("SELECT * FROM fiscal_obligations WHERE org_id = ? AND status <> 'done' AND amount > 0 ORDER BY due_date").all(orgId)) {
    add({ date: o.due_date < from ? addDays(from, 3) : o.due_date, amount: -num(o.amount), group: 'impots', source: 'tax', label: o.title, ref: `tax:${o.id}` });
  }
  // 7. Éléments prévisionnels saisis
  for (const p of await db.prepare('SELECT * FROM tre_plan WHERE org_id = ? AND active = 1').all(orgId)) {
    const grp = (T.CATEGORIES[p.category] || {}).group || 'autres'; const sign = p.direction === 'in' ? 1 : -1; const end = addDays(from, 400);
    let d = p.start_date; let guard = 0;
    while (d <= end && guard++ < 500) {
      if (p.end_date && d > p.end_date) break;
      if (d >= from || p.recurrence === 'none') add({ date: d, amount: sign * num(p.amount), group: grp, source: 'plan', label: p.label, ref: `plan:${p.id}` });
      if (p.recurrence === 'none') break;
      d = p.recurrence === 'weekly' ? addDays(d, 7) : p.recurrence === 'monthly' ? addMonths(d, 1) : p.recurrence === 'quarterly' ? addMonths(d, 3) : addMonths(d, 12);
    }
  }
  // 8. Opérations préparées en attente de validation (sans lien avec une facture : sinon la date de la facture est déplacée plus haut)
  for (const o of pendingOps.filter((x) => !x.ref_id)) {
    add({ date: o.date < from ? from : o.date, amount: (o.kind === 'receipt' ? 1 : -1) * num(o.amount_base), group: (T.CATEGORIES[o.category] || {}).group || 'autres', source: 'pending', label: o.label || 'Opération en attente', ref: `op:${o.id}` });
  }
  // 9. Tendance : ventes et achats courants des 3 derniers mois, encaissés / payés avec le délai habituel
  if (opts.trend !== false && st.includeTrend) {
    const months = prevMonths(monthOf(from), 4).slice(0, 3).filter((m) => m < monthOf(from));
    const start = `${months[0]}-01`; const endD = lastDay(months[months.length - 1]); const nd = diffDays(start, endD) + 1;
    const salesTtc = num((await db.prepare("SELECT COALESCE(SUM(total - credited), 0) s FROM documents WHERE org_id = ? AND kind = 'invoice' AND status IN ('sent', 'paid', 'credited') AND issued >= ? AND issued <= ?").get(orgId, start, endD)).s);
    const buyTtc = num((await db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM supplier_bills WHERE org_id = ? AND status <> 'cancelled' AND bill_date >= ? AND bill_date <= ?").get(orgId, start, endD)).s);
    const termRow = await db.prepare("SELECT AVG(CAST(substr(due_date, 1, 4) AS INT) * 372 + CAST(substr(due_date, 6, 2) AS INT) * 31 + CAST(substr(due_date, 9, 2) AS INT) - (CAST(substr(bill_date, 1, 4) AS INT) * 372 + CAST(substr(bill_date, 6, 2) AS INT) * 31 + CAST(substr(bill_date, 9, 2) AS INT))) AS t FROM supplier_bills WHERE org_id = ? AND status <> 'cancelled' AND bill_date >= ?").get(orgId, start);
    const dsoLag = Math.min(Math.max(r0(num(opts.dso) || 30), 0), 120); const dpoLag = Math.min(Math.max(r0(num(termRow && termRow.t) || 30), 0), 120);
    info.trendBase = { months, sales: r0(salesTtc / months.length), purchases: r0(buyTtc / months.length), dsoLag, dpoLag };
    for (let w = 0; w < 58; w++) {
      const issue = addDays(from, w * 7);
      if (salesTtc > 0) add({ date: addDays(issue, dsoLag), amount: r0(salesTtc / nd * 7), group: 'clients', source: 'trend_sales', label: 'Ventes à venir (tendance)', ref: 'trend' });
      if (buyTtc > 0) add({ date: addDays(issue, dpoLag), amount: -r0(buyTtc / nd * 7), group: 'fournisseurs', source: 'trend_purchases', label: 'Achats à venir (tendance)', ref: 'trend' });
    }
  }
  return { flows: flows.filter((f) => f.amount !== 0), info, delays };
}

/** Solde de départ de la prévision : somme des soldes consolidés des comptes actifs (monnaie de l'organisation). */
async function openingBalance(org, accountIds) {
  const rt = await T.rates(org); let total = 0; const views = [];
  for (const a of await T.accountsOf(org.id)) {
    if (accountIds && !accountIds.includes(Number(a.id))) continue;
    const v = await T.accountView(org, a, rt); views.push(v); total += v.consolidated;
  }
  return { total, accounts: views };
}

// ---------- Tableau des flux de trésorerie (grand livre) ----------
const OPEN_SRC = "('year_open', 'year_open_rev')";
/** Mouvements de trésorerie classés par la contrepartie comptable. Renvoie lignes { date, entryId, group, section, amount (+ encaissement) }. */
async function cashMoves(orgId, from, to) {
  const ents = await db.prepare(`SELECT l.entry_id, e.date, e.source, l.account, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? AND e.source NOT IN ${OPEN_SRC}
      AND l.entry_id IN (SELECT entry_id FROM acc_lines WHERE org_id = ? AND (account ~ '^(52|53|54|57)' OR account LIKE '589%')) ORDER BY l.entry_id, l.id`).all(orgId, from, to, orgId);
  const by = new Map();
  for (const r of ents) { if (!by.has(r.entry_id)) by.set(r.entry_id, { date: r.date, lines: [] }); by.get(r.entry_id).lines.push({ account: r.account, d: num(r.debit), c: num(r.credit) }); }
  const out = [];
  for (const [id, e] of by) {
    const cash = e.lines.filter((l) => T.isCash(l.account)); const other = e.lines.filter((l) => !T.isCash(l.account));
    const net = sum(cash, (l) => l.d - l.c); if (!net) continue;
    const counter = sum(other, (l) => l.c - l.d); // ce que les contreparties « apportent » à la trésorerie
    if (!other.length) continue; // virement entre deux comptes de trésorerie : sans effet sur le total
    // répartition de l'effet net entre les contreparties, au prorata de leurs montants
    const w = sum(other, (l) => Math.abs(l.c - l.d)) || 1;
    for (const l of other) {
      const share = counter ? (l.c - l.d) : 0; const part = counter ? net * (share / counter) : net * (Math.abs(l.c - l.d) / w);
      if (!part) continue; const k = T.classify(l.account);
      out.push({ entryId: Number(id), date: e.date, account: l.account, section: k.section, group: k.group, amount: Math.round(part * 1) });
    }
  }
  return out;
}

async function cashStatement(orgId, from, to) {
  const moves = (await cashMoves(orgId, from, to)).filter((m) => m.section !== 'internal');
  const adj = await db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? AND e.source IN ${OPEN_SRC} AND (l.account ~ '^(52|53|54|57)' OR l.account LIKE '589%')`).get(orgId, from, to);
  const opening = (await cashBalance(orgId, addDays(from, -1))) + num(adj.s); const closing = await cashBalance(orgId, to);
  const sec = {}; for (const s of ['operating', 'investing', 'financing']) sec[s] = { total: 0, rows: [] };
  const key = (s, g) => sec[s].rows.find((r) => r.group === g);
  for (const m of moves) { const s = sec[m.section]; let row = key(m.section, m.group); if (!row) { row = { group: m.group, in: 0, out: 0, amount: 0 }; s.rows.push(row); } if (m.amount > 0) row.in += m.amount; else row.out += -m.amount; row.amount += m.amount; s.total += m.amount; }
  const net = sum(Object.values(sec), (s) => s.total);
  // l'écart éventuel vient d'écritures qui touchent plusieurs comptes de trésorerie avec des contreparties mixtes : il est affiché, jamais caché
  return { from, to, opening, sections: sec, net, closing, check: { expectedClosing: opening + net, gap: closing - (opening + net), ok: closing === opening + net } };
}

async function cashBalance(orgId, to) {
  const m = await ledger(orgId, to);
  return sumAcc(m, (a) => T.isCash(a));
}

/** Encaissements / décaissements par mois et par groupe sur `months` mois (pour les graphiques). */
async function cashByMonth(orgId, month, months = 12) {
  const list = prevMonths(month, months);
  const moves = (await cashMoves(orgId, `${list[0]}-01`, lastDay(month))).filter((m) => m.section !== 'internal');
  return list.map((m) => { const mm = moves.filter((x) => x.date.slice(0, 7) === m); return { month: m, in: sum(mm.filter((x) => x.amount > 0), (x) => x.amount), out: -sum(mm.filter((x) => x.amount < 0), (x) => x.amount), net: sum(mm, (x) => x.amount),
    operating: sum(mm.filter((x) => x.section === 'operating'), (x) => x.amount), investing: sum(mm.filter((x) => x.section === 'investing'), (x) => x.amount), financing: sum(mm.filter((x) => x.section === 'financing'), (x) => x.amount) }; });
}

// ---------- Jours de crédit clients / fournisseurs / stock ----------
async function windowSums(orgId, from, to) {
  const r = await db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN l.account LIKE '411%' AND e.source <> 'payment' THEN l.debit ELSE 0 END), 0) AS sales,
      COALESCE(SUM(CASE WHEN l.account LIKE '411%' AND e.source = 'credit_note' THEN l.credit ELSE 0 END), 0) AS credits,
      COALESCE(SUM(CASE WHEN l.account LIKE '401%' THEN l.credit ELSE 0 END), 0) AS purchases,
      COALESCE(SUM(CASE WHEN l.account LIKE '60%' THEN l.debit - l.credit ELSE 0 END), 0) AS cogs
    FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND e.date > ? AND e.date <= ? AND e.source NOT IN ${OPEN_SRC}`).get(orgId, from, to);
  return { sales: num(r.sales) - num(r.credits), purchases: num(r.purchases), cogs: num(r.cogs) };
}

/** Indicateurs du mois `month` sur les 90 derniers jours. */
async function kpiAt(orgId, month, windowDays = 90) {
  const to = month === today().slice(0, 7) ? today() : lastDay(month);
  const from = addDays(to, -windowDays);
  const m = await ledger(orgId, to); const w = await windowSums(orgId, from, to);
  const f = kpiFormulas({ receivables: sumAcc(m, (a) => a.startsWith('41')), payables: sumAcc(m, (a) => a.startsWith('40')), stock: sumAcc(m, (a) => /^3/.test(a)), sales: w.sales, purchases: w.purchases, cogs: w.cogs, days: windowDays });
  const wc = workingCapital(m);
  return { month, to, windowDays, ...f, bfr: wc.bfr, frng: wc.frng, treasuryNet: wc.treasuryNet, cash: wc.cashBooks, sales: w.sales, purchases: w.purchases, cogs: w.cogs, receivables: sumAcc(m, (a) => a.startsWith('41')), payables: -sumAcc(m, (a) => a.startsWith('40')), stock: sumAcc(m, (a) => /^3/.test(a)) };
}

/** Sans comptabilité : indicateurs tirés des factures, des dettes et du stock (instantané). */
async function kpiFromOperations(orgId, windowDays = 90) {
  const to = today(); const from = addDays(to, -windowDays);
  const recv = sum(await openInvoices(orgId), (i) => i.left);
  const sales = num((await db.prepare("SELECT COALESCE(SUM(total - credited), 0) s FROM documents WHERE org_id = ? AND kind = 'invoice' AND status IN ('sent', 'paid', 'credited') AND issued > ? AND issued <= ?").get(orgId, from, to)).s);
  const pay = num((await db.prepare("SELECT COALESCE(SUM(amount - paid), 0) s FROM supplier_bills WHERE org_id = ? AND status IN ('open', 'partial')").get(orgId)).s);
  const purch = num((await db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM supplier_bills WHERE org_id = ? AND status <> 'cancelled' AND bill_date > ? AND bill_date <= ?").get(orgId, from, to)).s);
  const stock = num((await db.prepare('SELECT COALESCE(SUM(quantity * CASE WHEN avg_cost > 0 THEN avg_cost ELSE unit_cost END), 0) s FROM stock_items WHERE org_id = ?').get(orgId)).s);
  const f = kpiFormulas({ receivables: recv, payables: -pay, stock, sales, purchases: purch, cogs: purch, days: windowDays });
  return { month: to.slice(0, 7), to, windowDays, ...f, sales, purchases: purch, cogs: purch, receivables: recv, payables: pay, stock, bfr: recv + stock - pay, frng: null, treasuryNet: null, cash: null, fromOperations: true };
}

// ---------- Écarts prévu / réalisé ----------
/** Ce qui était attendu sur la période (par groupe), d'après les échéances : factures dues, dettes dues, paie, emprunts, impôts, éléments prévisionnels. */
async function plannedByGroup(orgId, from, to, st) {
  const g = {}; const add = (k, v) => { g[k] = (g[k] || 0) + v; };
  for (const d of await db.prepare("SELECT total, credited, due, issued FROM documents WHERE org_id = ? AND kind = 'invoice' AND status IN ('sent', 'paid') AND COALESCE(due, issued) >= ? AND COALESCE(due, issued) <= ?").all(orgId, from, to)) add('clients', num(d.total) - num(d.credited));
  for (const b of await db.prepare("SELECT amount FROM supplier_bills WHERE org_id = ? AND status <> 'cancelled' AND due_date >= ? AND due_date <= ?").all(orgId, from, to)) add('fournisseurs', -num(b.amount));
  for (const s of await db.prepare("SELECT SUM(net) AS net, SUM(employee_deductions + employer_charges) AS soc, month FROM payroll_slips WHERE org_id = ? AND status IN ('validated', 'paid') GROUP BY month").all(orgId)) {
    const pd = `${s.month}-${String(Math.min(st.payday, 28)).padStart(2, '0')}`; const sd = `${addMonths(`${s.month}-01`, 1).slice(0, 7)}-15`;
    if (pd >= from && pd <= to) add('personnel', -num(s.net)); if (sd >= from && sd <= to) add('personnel', -num(s.soc));
  }
  for (const l of await db.prepare('SELECT l.principal, l.interest FROM acc_loan_lines l JOIN acc_loans a ON a.id = l.loan_id WHERE a.org_id = ? AND l.due_date >= ? AND l.due_date <= ?').all(orgId, from, to)) add('emprunts', -(num(l.principal) + num(l.interest)));
  for (const o of await db.prepare('SELECT amount FROM fiscal_obligations WHERE org_id = ? AND due_date >= ? AND due_date <= ? AND amount > 0').all(orgId, from, to)) add('impots', -num(o.amount));
  for (const p of await db.prepare('SELECT * FROM tre_plan WHERE org_id = ? AND active = 1').all(orgId)) {
    const grp = (T.CATEGORIES[p.category] || {}).group || 'autres'; let d = p.start_date; let guard = 0;
    while (d <= to && guard++ < 500) { if (p.end_date && d > p.end_date) break; if (d >= from) add(grp, (p.direction === 'in' ? 1 : -1) * num(p.amount)); if (p.recurrence === 'none') break; d = p.recurrence === 'weekly' ? addDays(d, 7) : p.recurrence === 'monthly' ? addMonths(d, 1) : p.recurrence === 'quarterly' ? addMonths(d, 3) : addMonths(d, 12); }
  }
  return g;
}

const CAUSE_TEXT = { clients: 'late_customers', fournisseurs: 'supplier_timing', personnel: 'payroll_gap', impots: 'tax_gap', emprunts: 'loan_gap', autres: 'other_gap', investissements: 'capex_gap', financiers: 'fin_gap', capital: 'cap_gap' };
async function variance(orgId, from, to, st) {
  const planned = await plannedByGroup(orgId, from, to, st);
  const moves = (await cashMoves(orgId, from, to)).filter((m) => m.section !== 'internal');
  const actual = {}; for (const m of moves) actual[m.group] = (actual[m.group] || 0) + m.amount;
  const keys = [...new Set([...Object.keys(planned), ...Object.keys(actual)])].sort((a, b) => Object.keys(T.GROUPS).indexOf(a) - Object.keys(T.GROUPS).indexOf(b));
  const rows = keys.map((k) => ({ group: k, planned: planned[k] || 0, actual: actual[k] || 0, gap: (actual[k] || 0) - (planned[k] || 0), gapPct: planned[k] ? Math.round(((actual[k] || 0) - planned[k]) / Math.abs(planned[k]) * 1000) / 10 : null }));
  const overdue = (await openInvoices(orgId)).filter((i) => i.due >= from && i.due <= to && i.due < today());
  const causes = [];
  const row = (k) => rows.find((r) => r.group === k);
  if (row('clients') && row('clients').gap < 0) causes.push({ code: 'late_customers', group: 'clients', amount: -row('clients').gap, p: { count: overdue.length, amount: sum(overdue, (i) => i.left) } });
  if (row('fournisseurs') && row('fournisseurs').gap > 0) causes.push({ code: 'suppliers_later', group: 'fournisseurs', amount: row('fournisseurs').gap, p: {} });
  if (row('fournisseurs') && row('fournisseurs').gap < 0) causes.push({ code: 'suppliers_more', group: 'fournisseurs', amount: -row('fournisseurs').gap, p: {} });
  for (const r of rows) if (!['clients', 'fournisseurs'].includes(r.group) && Math.abs(r.gap) > 0 && (r.planned !== 0 || Math.abs(r.gap) > 0)) causes.push({ code: r.planned === 0 && r.actual !== 0 ? 'unplanned' : (CAUSE_TEXT[r.group] || 'other_gap'), group: r.group, amount: Math.abs(r.gap), p: { sign: r.gap >= 0 ? 'plus' : 'minus' } });
  const pNet = sum(rows, (r) => r.planned); const aNet = sum(rows, (r) => r.actual);
  // cascade : départ = prévu net, une marche par groupe, arrivée = réalisé net
  const waterfall = [{ key: 'planned', value: pNet, kind: 'total' }, ...rows.filter((r) => r.gap !== 0).map((r) => ({ key: r.group, value: r.gap, kind: 'delta' })), { key: 'actual', value: aNet, kind: 'total' }];
  return { from, to, rows, plannedNet: pNet, actualNet: aNet, gap: aNet - pNet, causes: causes.sort((a, b) => b.amount - a.amount), waterfall, check: { ok: pNet + sum(rows, (r) => r.gap) === aNet } };
}

/** Sorties moyennes par jour sur les 90 derniers jours (base du fonds de sécurité en jours de charges). */
async function dailyOutflow(orgId, st) {
  const to = today(); const from = addDays(to, -90);
  if (await hasLedger(orgId)) {
    const moves = (await cashMoves(orgId, from, to)).filter((m) => m.section === 'operating' && m.group !== 'clients' && m.amount < 0); // les annulations d'encaissements ne sont pas des charges
    const v = -sum(moves, (m) => m.amount) / 90;
    if (v > 0) return v;
  }
  // sans écritures : dettes payées + paie sur la période, d'après les opérations
  const p = num((await db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM supplier_payments WHERE org_id = ? AND date > ?").get(orgId, from)).s);
  const sl = num((await db.prepare("SELECT COALESCE(SUM(net + employee_deductions + employer_charges), 0) s FROM payroll_slips WHERE org_id = ? AND status IN ('validated', 'paid') AND month >= ?").get(orgId, addDays(to, -90).slice(0, 7))).s);
  void st;
  return (p + sl) / 90;
}

module.exports = { ledger, sumAcc, hasLedger, collect, openInvoices, expectInvoice, customerDelays, openingBalance, cashMoves, cashStatement, cashBalance, cashByMonth, workingCapital, kpiFormulas, kpiAt, kpiFromOperations, interpret, kpiAlerts, plannedByGroup, variance, dailyOutflow, prevMonths, windowSums };
