'use strict';
// Budget · annuel par catégorie (12 mois), prévisionnel vs réalisé, engagements, prévision de trésorerie sur 3 mois, validation des dépenses au-delà d'un seuil.
//
// UNE SEULE SOURCE DE VÉRITÉ avec la comptabilité : le « réalisé » est lu dans les écritures comptables (classes 6 et 7, rangées par catégorie
// grâce à une table de correspondance modifiable). Les lignes du budget saisies à la main ne s'y ajoutent que si elles ne sont PAS déjà
// couvertes par la compta :
//   - lignes « miroir » (créées automatiquement par un paiement de facture, une réception d'achat, un bulletin de paie) : ignorées dès que la
//     compta contient l'écriture correspondante (même source) ;
//   - lignes marquées « déjà en compta » ou liées à une écriture : ignorées ;
//   - les autres (saisies à la main, carburant, marketing, chantiers…) : comptées « hors compta », visibles à part.
// Rien n'est supprimé ni modifié dans les données existantes ; les doublons probables sont proposés à la liaison (jamais liés d'office).
// Réservé aux administrateurs (la comptabilité l'est) : un responsable garde la vue mensuelle par antenne du module Budget.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const today = () => nowISO().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const addMonth = (month, n) => { const [y, m] = month.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };
const yearOf = (v) => { const y = String(v || today().slice(0, 4)); if (!/^\d{4}$/.test(y)) throw new HttpError(400, 'Année invalide.'); return y; };
const NOTICE = "Estimation de gestion à partir de vos données : ce n'est ni un engagement bancaire ni un conseil financier ; à confirmer avec votre expert-comptable.";
const accounting = () => require('./accounting');

// ---------- Correspondance compte comptable -> catégorie du budget ----------
const DEFAULT_MAP = [
  ['expense', '601', 'Achats'], ['expense', '602', 'Achats'], ['expense', '603', 'Achats'], ['expense', '604', 'Achats'], ['expense', '605', 'Achats'], ['expense', '608', 'Achats'], ['expense', '60', 'Achats'],
  ['expense', '61', 'Transport'], ['expense', '622', 'Loyer'], ['expense', '624', 'Maintenance'], ['expense', '625', 'Assurances'], ['expense', '627', 'Marketing'], ['expense', '628', 'Télécoms'],
  ['expense', '62', 'Services extérieurs'], ['expense', '631', 'Frais bancaires'], ['expense', '632', 'Honoraires'], ['expense', '63', 'Autres services extérieurs'],
  ['expense', '64', 'Impôts et taxes'], ['expense', '65', 'Autres charges'], ['expense', '66', 'Salaires'], ['expense', '67', 'Frais financiers'], ['expense', '68', 'Amortissements'], ['expense', '69', 'Provisions'],
  ['income', '70', 'Ventes'], ['income', '71', 'Subventions'], ['income', '72', 'Production immobilisée'], ['income', '75', 'Autres produits'], ['income', '77', 'Produits financiers'], ['income', '78', 'Reprises et transferts'],
];
async function mapOf(orgId) {
  const rows = await db.prepare('SELECT prefix, category FROM budget_account_map WHERE org_id = ?').all(orgId);
  const m = new Map(DEFAULT_MAP.map(([kind, prefix, cat]) => [prefix, { kind, cat }]));
  for (const r of rows) m.set(r.prefix, { kind: r.prefix[0] === '7' ? 'income' : 'expense', cat: r.category });
  return m;
}
/** Catégorie d'un compte : plus long préfixe d'abord. */
function categoryOf(map, account) {
  for (let n = account.length; n >= 1; n--) { const h = map.get(account.slice(0, n)); if (h) return h.cat; }
  return account[0] === '7' ? 'Autres produits' : 'Autres charges';
}

// ---------- Réalisé : compta + lignes manuelles non couvertes ----------
const COVERED = `NOT (b.source <> '' AND EXISTS (SELECT 1 FROM acc_entries e WHERE e.org_id = b.org_id AND e.source_id = b.source_id AND (e.source = b.source OR (b.source = 'payroll' AND e.source LIKE 'payroll-r%'))))`;
const UNCOVERED = `b.in_ledger = 0 AND b.acc_entry_id IS NULL AND ${COVERED}`;

async function realized(orgId, year) {
  const map = await mapOf(orgId);
  const lines = await db.prepare(`SELECT l.account, substr(e.date, 6, 2) AS m, SUM(l.debit) AS d, SUM(l.credit) AS c FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? AND (l.account LIKE '6%' OR l.account LIKE '7%') GROUP BY l.account, substr(e.date, 6, 2)`).all(orgId, `${year}-01-01`, `${year}-12-31`);
  const out = new Map(); // "kind|catégorie" -> { kind, category, ledger[12], manual[12] }
  const slot = (kind, category) => { const k = `${kind}|${category}`; if (!out.has(k)) out.set(k, { kind, category, ledger: Array(12).fill(0), manual: Array(12).fill(0) }); return out.get(k); };
  for (const l of lines) {
    const kind = l.account[0] === '7' ? 'income' : 'expense';
    const amt = kind === 'expense' ? l.d - l.c : l.c - l.d;
    slot(kind, categoryOf(map, l.account)).ledger[Number(l.m) - 1] += amt;
  }
  const manual = await db.prepare(`SELECT b.kind, b.category, substr(b.date, 6, 2) AS m, SUM(b.amount) AS t FROM budget_entries b WHERE b.org_id = ? AND b.date >= ? AND b.date <= ? AND ${UNCOVERED} GROUP BY b.kind, b.category, substr(b.date, 6, 2)`).all(orgId, `${year}-01-01`, `${year}-12-31`);
  for (const r of manual) slot(r.kind, r.category).manual[Number(r.m) - 1] += r.t;
  return out;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const arr12 = (v) => { try { const a = JSON.parse(v); return Array.from({ length: 12 }, (_, i) => Number(a[i]) || 0); } catch { return Array(12).fill(0); } };

// ---------- Budget annuel ----------
async function annualView(req, year) {
  const real = await realized(req.org.id, year);
  const plans = await db.prepare('SELECT * FROM budget_annual WHERE org_id = ? AND year = ? ORDER BY kind DESC, category').all(req.org.id, year);
  const keys = new Map();
  for (const p of plans) keys.set(`${p.kind}|${p.category}`, { kind: p.kind, category: p.category, planned: arr12(p.amounts) });
  for (const [k, v] of real) if (!keys.has(k)) keys.set(k, { kind: v.kind, category: v.category, planned: Array(12).fill(0) });
  const commit = await commitments(req);
  const thisMonth = today().startsWith(year) ? Number(today().slice(5, 7)) : (year < today().slice(0, 4) ? 12 : 0);
  const lines = [...keys.values()].map((l) => {
    const r = real.get(`${l.kind}|${l.category}`) || { ledger: Array(12).fill(0), manual: Array(12).fill(0) };
    const realz = r.ledger.map((x, i) => x + r.manual[i]);
    const committed = l.kind === 'expense' && l.category === 'Achats' ? commit.total : 0;
    const gap = sum(realz) - sum(l.planned);
    return { kind: l.kind, category: l.category, planned: l.planned, plannedTotal: sum(l.planned), ledger: r.ledger, manual: r.manual, realized: realz, realizedTotal: sum(realz), manualTotal: sum(r.manual),
      gap, gapPct: sum(l.planned) ? Math.round(gap / sum(l.planned) * 1000) / 10 : null, favorable: l.kind === 'expense' ? gap <= 0 : gap >= 0,
      ytdPlanned: sum(l.planned.slice(0, thisMonth)), ytdRealized: sum(realz.slice(0, thisMonth)), committed, overBudget: l.kind === 'expense' && sum(l.planned) > 0 && sum(realz) + committed > sum(l.planned) };
  }).sort((a, b) => (a.kind === b.kind ? b.realizedTotal + b.plannedTotal - (a.realizedTotal + a.plannedTotal) : a.kind === 'income' ? -1 : 1));
  const tot = (kind, f) => sum(lines.filter((l) => l.kind === kind).map(f));
  const entriesInLedger = (await db.prepare('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ?').get(req.org.id)).c;
  return {
    year, lines, hasPlan: plans.length > 0, currentMonth: thisMonth, commitments: commit,
    totals: { incomePlanned: tot('income', (l) => l.plannedTotal), incomeRealized: tot('income', (l) => l.realizedTotal), expensePlanned: tot('expense', (l) => l.plannedTotal), expenseRealized: tot('expense', (l) => l.realizedTotal), manual: sum(lines.map((l) => l.manualTotal)) },
    source: { ledgerEntries: entriesInLedger, note: "Le réalisé vient de la comptabilité. Les lignes « hors compta » sont des saisies du budget que la comptabilité ne contient pas encore." }, notice: NOTICE,
  };
}
router.get('/annual', A.need('admin'), async (req, res) => res.json(await annualView(req, yearOf(req.query.year))));

router.put('/annual', A.need('admin'), async (req, res) => {
  const b = req.body || {}; const year = yearOf(b.year);
  if (!Array.isArray(b.lines) || b.lines.length > 80) throw new HttpError(400, 'Liste de lignes invalide (80 au plus).');
  const clean = new Map();
  for (const l of b.lines) {
    const kind = A.oneOf((l || {}).kind, ['income', 'expense'], undefined, 'Type : entrée ou sortie.');
    const category = A.text(l.category, 60, { required: true, msg: 'Chaque ligne a une catégorie.' });
    let amounts;
    if (Array.isArray(l.amounts)) { if (l.amounts.length !== 12) throw new HttpError(400, 'Il faut 12 montants (un par mois).'); amounts = l.amounts.map((x) => { const n = Number(String(x === '' || x == null ? 0 : x).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new HttpError(400, 'Montant mensuel invalide.'); return Math.round(n); }); }
    else if (l.monthly !== undefined) { const n = A.amount(l.monthly); amounts = Array(12).fill(n); } else throw new HttpError(400, 'Indiquez 12 montants ou un montant mensuel.');
    clean.set(`${kind}|${category}`, { kind, category, amounts });
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM budget_annual WHERE org_id = ? AND year = ?').run(req.org.id, year);
    for (const l of clean.values()) await db.prepare('INSERT INTO budget_annual (org_id, year, kind, category, amounts) VALUES (?, ?, ?, ?, ?)').run(req.org.id, year, l.kind, l.category, JSON.stringify(l.amounts));
  })();
  await A.logActivity(req.org.id, req.user.id, 'budget', `Budget annuel ${year} enregistré (${clean.size} ligne(s))`);
  res.json({ ok: true, lines: clean.size });
});

// Point de départ : les limites mensuelles existantes, répétées sur 12 mois (dépenses).
router.post('/annual/init', A.need('admin'), async (req, res) => {
  const year = yearOf((req.body || {}).year);
  if ((await db.prepare('SELECT COUNT(*) c FROM budget_annual WHERE org_id = ? AND year = ?').get(req.org.id, year)).c) throw new HttpError(409, 'Un budget existe déjà pour cette année.');
  const plans = await db.prepare('SELECT category, monthly_limit FROM budget_plans WHERE org_id = ?').all(req.org.id);
  if (!plans.length) throw new HttpError(400, "Aucune limite mensuelle à reprendre : saisissez le budget directement.");
  for (const p of plans) await db.prepare('INSERT INTO budget_annual (org_id, year, kind, category, amounts) VALUES (?, ?, ?, ?, ?)').run(req.org.id, year, 'expense', p.category, JSON.stringify(Array(12).fill(p.monthly_limit)));
  res.status(201).json({ ok: true, lines: plans.length });
});

router.get('/map', A.need('admin'), async (req, res) => {
  const m = await mapOf(req.org.id);
  res.json({ map: [...m].map(([prefix, v]) => ({ prefix, kind: v.kind, category: v.cat })).sort((a, b) => a.prefix.localeCompare(b.prefix)), note: "Chaque compte de charges (6) ou de produits (7) est rangé dans la catégorie de son préfixe le plus précis." });
});
router.put('/map', A.need('admin'), async (req, res) => {
  const list = (req.body || {}).map;
  if (!Array.isArray(list) || list.length > 60) throw new HttpError(400, 'Liste invalide.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM budget_account_map WHERE org_id = ?').run(req.org.id);
    for (const x of list) {
      const prefix = String((x || {}).prefix || '').trim();
      if (!/^[67]\d{0,7}$/.test(prefix)) throw new HttpError(400, 'Préfixe de compte invalide (commence par 6 ou 7).');
      await db.prepare('INSERT INTO budget_account_map (org_id, prefix, category) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(req.org.id, prefix, A.text(x.category, 60, { required: true, msg: 'Catégorie manquante.' }));
    }
  })();
  res.json({ ok: true });
});

// ---------- Engagements ----------
async function commitments(req) {
  const orders = await db.prepare(`SELECT o.id, o.status, o.quantity, o.received_qty, o.unit_price, o.promised_date, s.name AS item, sp.name AS supplier FROM purchase_orders o JOIN stock_items s ON s.id = o.item_id LEFT JOIN suppliers sp ON sp.id = o.supplier_id
    WHERE o.org_id = ? AND o.status IN ('pending', 'ordered', 'partial') AND o.unit_price > 0 ORDER BY o.id`).all(req.org.id);
  const ord = orders.map((o) => ({ id: o.id, status: o.status, item: o.item, supplier: o.supplier || '', amount: Math.round((o.quantity - o.received_qty) * o.unit_price), promisedDate: o.promised_date }));
  const bills = (await db.prepare(`SELECT b.*, COALESCE(NULLIF(b.supplier_name, ''), s.name, '') AS party FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.org_id = ? AND b.status IN ('open', 'partial') AND b.amount - b.paid > 0 ORDER BY b.due_date`).all(req.org.id))
    .map((b) => ({ id: b.id, supplier: b.party, number: b.number, dueDate: b.due_date, amount: b.amount - b.paid }));
  const ordered = ord.filter((o) => o.status !== 'pending');
  const sumA = (l) => l.reduce((a, x) => a + x.amount, 0);
  return { orders: ord, ordersAmount: sumA(ordered), pendingOrdersAmount: sumA(ord.filter((o) => o.status === 'pending')), bills, billsAmount: sumA(bills), total: sumA(ordered) + sumA(bills),
    note: "Engagé = commandes validées pas encore reçues + factures fournisseurs à payer. Les commandes en attente de validation sont comptées à part." };
}
router.get('/commitments', A.need('admin'), async (req, res) => res.json({ ...(await commitments(req)), notice: NOTICE }));

// ---------- Prévision de trésorerie ----------
async function cashflow(req, months, collectRate) {
  const t = today(); const start = t.slice(0, 7);
  const opening = await db.prepare("SELECT COALESCE(SUM(l.debit - l.credit), 0) b, COUNT(*) n FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account LIKE '5%' AND l.account NOT LIKE '59%' AND e.date <= ?").get(req.org.id, t);
  const slot = (m) => (m < start ? start : m);
  const list = Array.from({ length: months }, (_, i) => addMonth(start, i));
  const M = new Map(list.map((m) => [m, { month: m, inflows: [], outflows: [] }]));
  const put = (m, side, label, amount, extra) => { const x = M.get(slot(m)); if (x && amount > 0) x[side].push({ label, amount, ...(extra || {}) }); };
  const horizon = addMonth(start, months - 1);
  // Encaissements : factures clients non soldées, à leur échéance (en retard : le 1er mois).
  const inv = await db.prepare(`SELECT d.number, d.issued, d.due, d.total - d.paid - d.credited AS remaining, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id
    WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'sent' AND d.total - d.paid - d.credited > 0`).all(req.org.id);
  for (const d of inv) { const due = d.due || d.issued; const m = due.slice(0, 7); if (m <= horizon) put(m, 'inflows', `Facture ${d.number} - ${d.customer}`, Math.round(d.remaining * collectRate / 100), { kind: 'invoice', overdue: due < t, dueDate: due }); }
  // Décaissements : dettes fournisseurs à l'échéance, commandes validées (date promise, sinon dans 30 jours).
  const c = await commitments(req);
  for (const b of c.bills) { const m = b.dueDate.slice(0, 7); if (m <= horizon) put(m, 'outflows', `Dette fournisseur ${b.supplier}${b.number ? ' ' + b.number : ''}`, b.amount, { kind: 'bill', overdue: b.dueDate < t, dueDate: b.dueDate }); }
  for (const o of c.orders.filter((x) => x.status !== 'pending')) { const m = (o.promisedDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)).slice(0, 7); if (m <= horizon) put(m, 'outflows', `Commande #${o.id} ${o.item}`, o.amount, { kind: 'order', estimated: !o.promisedDate }); }
  // Paie : bulletins du mois non payés ; mois sans bulletin = estimation d'après le dernier mois connu (ou les salaires actuels).
  const last = await db.prepare('SELECT month, SUM(employer_cost) c FROM payroll_slips WHERE org_id = ? GROUP BY month ORDER BY month DESC LIMIT 1').get(req.org.id);
  const actives = (await db.prepare("SELECT COALESCE(SUM(salary), 0) s FROM employees WHERE org_id = ? AND status = 'active'").get(req.org.id)).s;
  for (const m of list) {
    const s = await db.prepare("SELECT COALESCE(SUM(employer_cost), 0) c, COUNT(*) n FROM payroll_slips WHERE org_id = ? AND month = ? AND status <> 'paid'").get(req.org.id, m);
    const any = (await db.prepare('SELECT COUNT(*) c FROM payroll_slips WHERE org_id = ? AND month = ?').get(req.org.id, m)).c;
    if (any) put(m, 'outflows', 'Paie (bulletins non payés)', s.c, { kind: 'payroll' });
    else if (last && last.c) put(m, 'outflows', 'Paie (estimation d\'après le dernier mois)', last.c, { kind: 'payroll', estimated: true });
    else if (actives) put(m, 'outflows', 'Paie (estimation d\'après les salaires)', actives, { kind: 'payroll', estimated: true });
  }
  // Échéances fiscales avec montant (les déclarations « sociales » sont déjà dans le coût de la paie).
  const fis = await db.prepare("SELECT title, due_date, amount FROM fiscal_obligations WHERE org_id = ? AND status = 'todo' AND amount > 0 AND kind <> 'social' ORDER BY due_date").all(req.org.id);
  for (const f of fis) { const m = f.due_date.slice(0, 7); if (m <= horizon) put(m, 'outflows', f.title, f.amount, { kind: 'tax', overdue: f.due_date < t, dueDate: f.due_date }); }
  let bal = opening.b; const out = [];
  for (const m of list) {
    const x = M.get(m); const i = sum(x.inflows.map((y) => y.amount)); const o = sum(x.outflows.map((y) => y.amount));
    bal += i - o;
    out.push({ month: m, opening: bal - i + o, inflows: i, outflows: o, net: i - o, closing: bal, inflowItems: x.inflows, outflowItems: x.outflows });
  }
  const firstNeg = out.find((x) => x.closing < 0);
  return { today: t, openingKnown: opening.n > 0, opening: opening.b, collectRate, months: out, alert: firstNeg ? { month: firstNeg.month, closing: firstNeg.closing } : null,
    assumptions: ['Factures clients encaissées à leur échéance (en retard : le mois courant), au taux d\'encaissement indiqué.', 'Dettes fournisseurs payées à l\'échéance ; commandes validées à la date promise (sinon dans 30 jours).', 'Paie : bulletins non payés, sinon dernier coût connu.', 'Échéances fiscales avec montant ; ventes futures et dépenses courantes non facturées ne sont PAS prévues.'], notice: NOTICE };
}
router.get('/cashflow', A.need('admin'), async (req, res) => {
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 3, 1), 12);
  const rate = Math.min(Math.max(req.query.collectRate === undefined ? 100 : Number(req.query.collectRate), 0), 100);
  if (!Number.isFinite(rate)) throw new HttpError(400, "Taux d'encaissement invalide (0 à 100).");
  res.json(await cashflow(req, months, rate));
});

// ---------- Doublons budget / compta ----------
router.get('/duplicates', A.need('admin'), async (req, res) => {
  const year = yearOf(req.query.year);
  const man = await db.prepare(`SELECT b.id, b.kind, b.category, b.label, b.amount, b.date FROM budget_entries b WHERE b.org_id = ? AND b.date >= ? AND b.date <= ? AND ${UNCOVERED} ORDER BY b.date`).all(req.org.id, `${year}-01-01`, `${year}-12-31`);
  const gl = await db.prepare(`SELECT e.id AS entry_id, e.number, e.date, e.label, l.account, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? AND (l.account LIKE '6%' OR l.account LIKE '7%') AND NOT EXISTS (SELECT 1 FROM budget_entries x WHERE x.acc_entry_id = e.id)`).all(req.org.id, `${year}-01-01`, `${year}-12-31`);
  const used = new Set(); const out = [];
  for (const b of man) {
    const c = gl.find((g) => !used.has(g.entry_id) && (b.kind === 'expense' ? g.account[0] === '6' && g.debit === b.amount : g.account[0] === '7' && g.credit === b.amount) && Math.abs(Date.parse(g.date) - Date.parse(b.date)) <= 3 * 86400000);
    if (c) { used.add(c.entry_id); out.push({ budgetEntryId: b.id, budgetLabel: `${b.category}${b.label ? ' · ' + b.label : ''}`, amount: b.amount, date: b.date, accEntryId: c.entry_id, number: c.number, accLabel: c.label, accDate: c.date }); }
  }
  res.json({ duplicates: out, manualCount: man.length, note: 'Ces lignes du budget semblent déjà être dans la comptabilité (même montant, dates proches). Liez-les pour ne plus les compter deux fois.' });
});
router.post('/duplicates/link', A.need('admin'), async (req, res) => {
  const pairs = Array.isArray((req.body || {}).pairs) ? req.body.pairs.slice(0, 200) : [];
  let linked = 0;
  for (const p of pairs) {
    const e = await db.prepare('SELECT id FROM acc_entries WHERE id = ? AND org_id = ?').get(A.id((p || {}).accEntryId), req.org.id);
    if (!e) continue;
    const r = await db.prepare('UPDATE budget_entries SET in_ledger = 1, acc_entry_id = ? WHERE id = ? AND org_id = ? AND acc_entry_id IS NULL').run(e.id, A.id(p.budgetEntryId), req.org.id);
    linked += r.changes;
  }
  if (linked) await A.logActivity(req.org.id, req.user.id, 'budget', `${linked} ligne(s) du budget liée(s) à la comptabilité`);
  res.json({ linked });
});
router.put('/entries/:id/ledger', A.need('admin'), async (req, res) => {
  const r = await db.prepare('UPDATE budget_entries SET in_ledger = ? WHERE id = ? AND org_id = ?').run((req.body || {}).inLedger === false ? 0 : 1, A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Ligne introuvable.');
  res.json({ ok: true });
});

// ---------- Validation des dépenses au-dessus d'un seuil ----------
async function thresholdOf(orgId) {
  const r = await db.prepare('SELECT approval_threshold t FROM budget_settings WHERE org_id = ?').get(orgId);
  return r ? Number(r.t) : 0;
}
router.get('/settings', async (req, res) => res.json({ approvalThreshold: await thresholdOf(req.org.id) }));
router.put('/settings', A.need('admin'), async (req, res) => {
  const v = (req.body || {}).approvalThreshold;
  const n = v === undefined || v === '' || v === null || Number(v) === 0 ? 0 : A.amount(v);
  await db.prepare('INSERT INTO budget_settings (org_id, approval_threshold) VALUES (?, ?) ON CONFLICT (org_id) DO UPDATE SET approval_threshold = EXCLUDED.approval_threshold').run(req.org.id, n);
  await A.logActivity(req.org.id, req.user.id, 'budget', n ? `Seuil de validation des dépenses : ${n}` : 'Validation des dépenses par seuil désactivée');
  res.json({ ok: true, approvalThreshold: n });
});
const reqView = (r, names) => ({ id: r.id, category: r.category, label: r.label, amount: r.amount, date: r.date, status: r.status, requestedBy: r.requested_by, requester: names.get(r.requested_by) || '', decidedBy: r.decided_by, decisionNote: r.decision_note, decidedAt: r.decided_at, budgetEntryId: r.budget_entry_id, branchId: r.branch_id, createdAt: r.created_at });
router.get('/requests', async (req, res) => {
  const st = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const sc = A.scope(req, 'branch_id');
  const rows = (await db.prepare(`SELECT * FROM expense_requests WHERE org_id = ?${st ? ' AND status = ?' : ''}${sc.sql} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC LIMIT 100`).all(...[req.org.id, ...(st ? [st] : []), ...sc.args]))
    .filter((r) => A.can(req, 'admin') || r.requested_by === req.user.id);
  const users = await db.prepare('SELECT u.id, u.name FROM users u JOIN org_members m ON m.user_id = u.id WHERE m.org_id = ?').all(req.org.id);
  res.json({ requests: rows.map((r) => reqView(r, new Map(users.map((u) => [u.id, u.name])))), threshold: await thresholdOf(req.org.id) });
});
router.post('/requests/:id/decide', A.need('admin'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM expense_requests WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Demande introuvable.');
  if (r.status !== 'pending') throw new HttpError(400, 'Cette demande a déjà été traitée.');
  const decision = A.oneOf((req.body || {}).decision, ['approved', 'rejected'], undefined, 'Décision : acceptée ou refusée.');
  const note = A.text((req.body || {}).note, 200);
  if (decision === 'rejected' && !note) throw new HttpError(400, 'Indiquez le motif du refus.');
  let entryId = null;
  await db.transaction(async () => {
    const upd = await db.prepare("UPDATE expense_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'").run(decision, req.user.id, nowISO(), note, r.id);
    if (!upd.changes) throw new HttpError(409, 'Cette demande vient d\'être traitée.');
    if (decision === 'approved') {
      entryId = Number((await db.prepare("INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at, source, source_id) VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, 'request', ?)")
        .run(req.org.id, r.branch_id, r.category, r.label, r.amount, r.date, r.requested_by, nowISO(), r.id)).lastInsertRowid);
      await db.prepare('UPDATE expense_requests SET budget_entry_id = ? WHERE id = ?').run(entryId, r.id);
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'budget', `Dépense de ${r.amount} (${r.category}) : ${decision === 'approved' ? 'acceptée' : 'refusée'}`);
  res.json({ ok: true, budgetEntryId: entryId });
});

module.exports = router;
module.exports.thresholdOf = thresholdOf;
module.exports.realized = realized;
module.exports.annualView = annualView;
module.exports.cashflow = cashflow;
module.exports.commitments = commitments;
module.exports.NOTICE = NOTICE;
