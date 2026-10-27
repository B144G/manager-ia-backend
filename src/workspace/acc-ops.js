'use strict';
// Comptabilité · opérations de fin de période : registre des immobilisations (plan d'amortissement linéaire, dotation mensuelle),
// clôture mensuelle guidée (liste de contrôle, provisions, charges constatées d'avance) et écarts de caisse. Documents de travail
// à faire valider par un expert-comptable : les durées d'amortissement sont choisies par l'organisation (aucune durée n'est imposée ici).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting'); // require paresseux
const today = () => nowISO().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const addMonth = (month, n) => { const [y, m] = month.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };
const monthOf = (v, msg = 'Mois invalide (format AAAA-MM).') => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''))) throw new HttpError(400, msg); return String(v); };
const NOTICE = "Document de travail : à faire valider par un expert-comptable avant toute utilisation officielle.";

// ---------- Immobilisations ----------
// catégorie -> [compte d'immobilisation, compte d'amortissement]
const CATS = {
  building: ['231', '2831', 'Bâtiments'], equipment: ['241', '2841', 'Matériel et outillage'], office: ['244', '2844', 'Mobilier et matériel de bureau'],
  transport: ['245', '2845', 'Matériel de transport'], it: ['2183', '28183', 'Matériel informatique'], software: ['213', '2813', 'Logiciels'],
};

/** Plan linéaire : (coût - valeur résiduelle) / durée en mois, le dernier mois absorbe l'arrondi. Mois entier dès le mois de mise en service. */
function plan(a) {
  const dep = Number(a.cost) - Number(a.residual); const n = Number(a.life_months);
  const monthly = Math.floor(dep / n);
  const stop = a.disposed_on ? a.disposed_on.slice(0, 7) : null;
  const rows = [];
  for (let k = 0; k < n; k++) {
    const period = addMonth(a.start_month, k);
    if (stop && period > stop) break;
    rows.push({ period, amount: k === n - 1 ? dep - monthly * (n - 1) : monthly });
  }
  return rows;
}
const assetOf = async (req, id) => {
  const a = await db.prepare('SELECT * FROM fixed_assets WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!a) throw new HttpError(404, 'Immobilisation introuvable.');
  return a;
};
async function assetView(a) {
  const posted = new Map((await db.prepare('SELECT period, amount FROM asset_depreciations WHERE asset_id = ?').all(a.id)).map((r) => [r.period, r.amount]));
  const rows = plan(a);
  const accumulated = [...posted.values()].reduce((x, y) => x + y, 0);
  return { id: a.id, label: a.label, category: a.category, categoryLabel: (CATS[a.category] || [])[2] || a.category, acquiredOn: a.acquired_on, startMonth: a.start_month, cost: a.cost, residual: a.residual, lifeMonths: a.life_months,
    assetAccount: a.asset_account, amortAccount: a.amort_account, status: a.status, disposedOn: a.disposed_on, note: a.note, monthly: Math.floor((a.cost - a.residual) / a.life_months),
    accumulated, netBookValue: a.cost - accumulated, postedMonths: posted.size, remainingMonths: rows.filter((r) => !posted.has(r.period)).length };
}

router.get('/assets', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM fixed_assets WHERE org_id = ? ORDER BY id DESC').all(req.org.id);
  const assets = []; for (const a of rows) assets.push(await assetView(a));
  res.json({ assets, categories: Object.entries(CATS).map(([k, v]) => ({ key: k, label: v[2], assetAccount: v[0], amortAccount: v[1] })), notice: NOTICE,
    totals: { cost: assets.reduce((a, x) => a + x.cost, 0), accumulated: assets.reduce((a, x) => a + x.accumulated, 0), netBookValue: assets.reduce((a, x) => a + x.netBookValue, 0) } });
});
router.post('/assets', async (req, res) => {
  const b = req.body || {};
  const cat = A.oneOf(b.category, Object.keys(CATS), 'equipment', 'Catégorie inconnue.');
  const acquired = A.date(b.acquiredOn) || today();
  const start = b.startMonth ? monthOf(b.startMonth) : acquired.slice(0, 7);
  const cost = A.amount(b.cost);
  const residual = b.residual === undefined || b.residual === '' || Number(b.residual) === 0 ? 0 : A.amount(b.residual);
  if (residual >= cost) throw new HttpError(400, 'La valeur résiduelle doit être inférieure au coût.');
  const life = Number(b.lifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 600) throw new HttpError(400, "Indiquez la durée d'amortissement en mois (1 à 600) : elle dépend de votre bien et de votre fiscalité.");
  const id = (await db.prepare('INSERT INTO fixed_assets (org_id, label, category, acquired_on, start_month, cost, residual, life_months, asset_account, amort_account, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, A.text(b.label, 120, { required: true, msg: 'Indiquez le nom du bien.' }), cat, acquired, start, cost, residual, life, CATS[cat][0], CATS[cat][1], A.text(b.note, 200), req.user.id, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Immobilisation « ${A.text(b.label, 120)} » enregistrée`);
  res.status(201).json({ id: Number(id) });
});
router.get('/assets/:id/plan', async (req, res) => {
  const a = await assetOf(req, req.params.id);
  const posted = new Map((await db.prepare('SELECT period, acc_entry_id FROM asset_depreciations WHERE asset_id = ?').all(a.id)).map((r) => [r.period, r.acc_entry_id]));
  let cum = 0;
  res.json({ asset: await assetView(a), plan: plan(a).map((r) => { cum += r.amount; return { period: r.period, amount: r.amount, cumulated: cum, netBookValue: a.cost - cum, posted: posted.has(r.period) }; }), notice: NOTICE });
});
router.post('/assets/:id/dispose', async (req, res) => {
  const a = await assetOf(req, req.params.id);
  if (a.status === 'disposed') throw new HttpError(400, 'Ce bien est déjà sorti du registre.');
  const date = A.date((req.body || {}).date) || today();
  await db.prepare("UPDATE fixed_assets SET status = 'disposed', disposed_on = ? WHERE id = ?").run(date, a.id);
  res.json({ ok: true, note: "Les dotations futures s'arrêtent. L'écriture de cession (produit, valeur nette comptable) est à saisir à la main dans le journal." });
});
router.delete('/assets/:id', async (req, res) => {
  const a = await assetOf(req, req.params.id);
  if ((await db.prepare('SELECT COUNT(*) c FROM asset_depreciations WHERE asset_id = ?').get(a.id)).c) throw new HttpError(400, 'Des dotations sont déjà comptabilisées : sortez le bien du registre à la place.');
  await db.prepare('DELETE FROM fixed_assets WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

/** Dotations à comptabiliser jusqu'à `month` (inclus) : { period, asset, amount } triées par période. */
async function dueDepreciation(orgId, month, only) {
  const assets = await db.prepare("SELECT * FROM fixed_assets WHERE org_id = ? AND status IN ('active', 'disposed') ORDER BY id").all(orgId);
  const done = new Set((await db.prepare('SELECT asset_id, period FROM asset_depreciations WHERE org_id = ?').all(orgId)).map((r) => `${r.asset_id}|${r.period}`));
  const out = [];
  for (const a of assets) for (const r of plan(a)) if ((only ? r.period === month : r.period <= month) && !done.has(`${a.id}|${r.period}`) && r.amount > 0) out.push({ period: r.period, asset: a, amount: r.amount });
  return out.sort((x, y) => x.period.localeCompare(y.period) || x.asset.id - y.asset.id);
}

// Dotation mensuelle : UNE écriture par mois (débit 681, crédit des comptes d'amortissement). Jamais deux fois la même dotation.
router.post('/assets/depreciate', async (req, res) => {
  const month = monthOf((req.body || {}).month);
  const catchUp = Boolean((req.body || {}).catchUp);
  const due = await dueDepreciation(req.org.id, month, !catchUp);
  const byPeriod = new Map();
  for (const d of due) { if (!byPeriod.has(d.period)) byPeriod.set(d.period, []); byPeriod.get(d.period).push(d); }
  const out = { entries: [], total: 0, skipped: [] };
  for (const [period, list] of byPeriod) {
    try {
      await db.transaction(async () => {
        const credits = new Map();
        for (const d of list) credits.set(d.asset.amort_account, (credits.get(d.asset.amort_account) || 0) + d.amount);
        const total = list.reduce((a, d) => a + d.amount, 0);
        const runs = (await db.prepare('SELECT COUNT(DISTINCT acc_entry_id) c FROM asset_depreciations WHERE org_id = ? AND period = ?').get(req.org.id, period)).c;
        const e = await accounting().recordEntry(req.org, req.user.id, { journal: 'OD', date: lastDay(period), label: `Dotation aux amortissements ${period}`, piece: `AMORT-${period}`,
          lines: [{ account: '681', debit: total, memo: `${list.length} bien(s)` }, ...[...credits].map(([account, credit]) => ({ account, credit }))], source: `asset_dep:${period}`, sourceId: runs + 1 });
        for (const d of list) await db.prepare('INSERT INTO asset_depreciations (org_id, asset_id, period, amount, acc_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, d.asset.id, period, d.amount, e.id, nowISO());
        out.entries.push({ period, number: e.number, amount: total, assets: list.length });
        out.total += total;
      })();
    } catch (e) { if (!(e instanceof HttpError)) throw e; out.skipped.push({ period, reason: e.message }); }
  }
  if (out.entries.length) await A.logActivity(req.org.id, req.user.id, 'accounting', `Dotation aux amortissements ${month} : ${out.total}`);
  res.status(out.entries.length ? 201 : 200).json({ ...out, notice: NOTICE });
});

// ---------- Clôture mensuelle guidée ----------
const closingOf = async (orgId, month) => await db.prepare('SELECT * FROM month_closings WHERE org_id = ? AND month = ?').get(orgId, month);
const parseChecks = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const MANUAL = [
  ['adjustments', 'Provisions et charges constatées d\'avance passées (ou rien à passer)'],
  ['vat', 'TVA du mois vérifiée'],
  ['review', 'Journal relu (écritures inhabituelles, montants anormaux)'],
];

async function checklist(req, month) {
  const end = lastDay(month); const items = [];
  const add = (key, label, status, detail, extra) => items.push({ key, label, status, detail: detail || '', manual: false, ...(extra || {}) });
  const acc = accounting();
  // 1. Écritures automatiques en attente
  const p = await acc.pending(req.org);
  const nPending = p.inv.filter((d) => d.issued <= end).length + p.cn.filter((d) => d.issued <= end).length + p.pay.filter((x) => x.date <= end).length
    + p.buy.filter((o) => o.updated_at.slice(0, 10) <= end).length + p.rec.filter((r) => r.created_at.slice(0, 10) <= end).length;
  add('auto', 'Factures, paiements et achats comptabilisés', nPending ? 'todo' : 'ok', nPending ? `${nPending} opération(s) à comptabiliser` : '', { count: nPending });
  // 2. Rapprochements bancaires
  const banks = await db.prepare('SELECT * FROM bank_accounts WHERE org_id = ?').all(req.org.id);
  let unm = 0;
  for (const b of banks) unm += (await db.prepare("SELECT COUNT(*) c FROM bank_lines WHERE bank_id = ? AND status = 'unmatched' AND date <= ?").get(b.id, end)).c;
  add('bank', 'Relevés bancaires rapprochés', !banks.length ? 'warn' : unm ? 'warn' : 'ok', !banks.length ? 'Aucun compte bancaire suivi' : unm ? `${unm} ligne(s) de relevé non pointée(s)` : '', { count: unm });
  // 3. Dotations aux amortissements
  const dep = await dueDepreciation(req.org.id, month, false);
  add('assets', 'Dotations aux amortissements comptabilisées', dep.length ? 'todo' : 'ok', dep.length ? `${dep.length} dotation(s) à comptabiliser` : '', { count: dep.length });
  // 4. Paie
  const slips = await db.prepare('SELECT status, acc_entry_id FROM payroll_slips WHERE org_id = ? AND month = ?').all(req.org.id, month);
  const emps = (await db.prepare("SELECT COUNT(*) c FROM employees WHERE org_id = ? AND status = 'active' AND salary > 0").get(req.org.id)).c;
  const draft = slips.filter((s) => s.status === 'draft').length; const noEntry = slips.filter((s) => s.status !== 'draft' && !s.acc_entry_id).length;
  add('payroll', 'Paie du mois validée et comptabilisée', !slips.length ? (emps ? 'warn' : 'ok') : draft || noEntry ? 'warn' : 'ok',
    !slips.length ? (emps ? 'Aucun bulletin ce mois-ci' : '') : draft ? `${draft} bulletin(s) en brouillon` : noEntry ? `${noEntry} bulletin(s) validé(s) non comptabilisé(s)` : '');
  // 5. Dettes et créances échues
  const t = end;
  const od = (await db.prepare("SELECT COUNT(*) c FROM supplier_bills WHERE org_id = ? AND status IN ('open', 'partial') AND due_date < ?").get(req.org.id, t)).c;
  add('payables', 'Dettes fournisseurs échues examinées', od ? 'warn' : 'ok', od ? `${od} facture(s) fournisseur échue(s)` : '', { count: od });
  const rc = (await db.prepare("SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'invoice' AND status = 'sent' AND total - paid - credited > 0 AND due IS NOT NULL AND due < ?").get(req.org.id, t)).c;
  add('receivables', 'Créances clients échues relancées', rc ? 'warn' : 'ok', rc ? `${rc} facture(s) client échue(s)` : '', { count: rc });
  // 6. Caisse
  const mv = (await db.prepare("SELECT COUNT(*) c FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account = '571' AND e.date >= ? AND e.date <= ?").get(req.org.id, `${month}-01`, end)).c;
  const cc = (await db.prepare('SELECT COUNT(*) c FROM cash_counts WHERE org_id = ? AND date >= ? AND date <= ?').get(req.org.id, `${month}-01`, end)).c;
  add('cash', 'Caisse comptée', mv && !cc ? 'warn' : 'ok', mv && !cc ? 'Mouvements de caisse sans comptage du mois' : '');
  // 7. Contrôles manuels
  const row = await closingOf(req.org.id, month); const checks = parseChecks(row && row.checks);
  for (const [key, label] of MANUAL) items.push({ key, label, status: checks[key] ? 'ok' : 'todo', detail: '', manual: true, checked: Boolean(checks[key]) });
  return { items, row };
}

router.get('/closing', async (req, res) => {
  const month = monthOf(req.query.month || today().slice(0, 7));
  const { items, row } = await checklist(req, month);
  const adjustments = (await db.prepare('SELECT * FROM acc_adjustments WHERE org_id = ? AND month = ? ORDER BY id').all(req.org.id, month)).map((a) => ({ id: a.id, month: a.month, kind: a.kind, label: a.label, amount: a.amount, account: a.account, entryId: a.entry_id, reversalId: a.reversal_id }));
  res.json({
    month, status: row ? row.status : 'open', closedAt: row ? row.closed_at : null, note: row ? row.note : '', reopenReason: row ? row.reopen_reason : '',
    items, blockers: items.filter((i) => i.status === 'todo').length, warnings: items.filter((i) => i.status === 'warn').length, adjustments, notice: NOTICE,
  });
});
router.put('/closing/check', async (req, res) => {
  const b = req.body || {}; const month = monthOf(b.month);
  const key = A.oneOf(b.key, MANUAL.map((m) => m[0]), undefined, 'Contrôle inconnu.');
  const row = await closingOf(req.org.id, month);
  if (row && row.status === 'closed') throw new HttpError(409, 'Ce mois est clôturé.');
  const checks = { ...parseChecks(row && row.checks), [key]: Boolean(b.checked) };
  if (row) await db.prepare('UPDATE month_closings SET checks = ? WHERE org_id = ? AND month = ?').run(JSON.stringify(checks), req.org.id, month);
  else await db.prepare("INSERT INTO month_closings (org_id, month, status, checks) VALUES (?, ?, 'open', ?)").run(req.org.id, month, JSON.stringify(checks));
  res.json({ ok: true });
});
router.post('/closing/close', async (req, res) => {
  const b = req.body || {}; const month = monthOf(b.month);
  if (month > today().slice(0, 7)) throw new HttpError(400, 'On ne clôture pas un mois à venir.');
  const { items, row } = await checklist(req, month);
  if (row && row.status === 'closed') throw new HttpError(409, 'Ce mois est déjà clôturé.');
  const blockers = items.filter((i) => i.status === 'todo');
  const note = A.text(b.note, 300);
  if (blockers.length && !b.force) throw new HttpError(400, `Clôture impossible, il reste à faire : ${blockers.map((x) => x.label).join(' ; ')}.`);
  if (blockers.length && note.length < 5) throw new HttpError(400, 'Pour clôturer malgré des points ouverts, indiquez le motif (5 caractères au moins).');
  const checks = row ? row.checks : '{}';
  if (row) await db.prepare("UPDATE month_closings SET status = 'closed', note = ?, closed_by = ?, closed_at = ? WHERE org_id = ? AND month = ?").run(note, req.user.id, nowISO(), req.org.id, month);
  else await db.prepare("INSERT INTO month_closings (org_id, month, status, checks, note, closed_by, closed_at) VALUES (?, ?, 'closed', ?, ?, ?, ?)").run(req.org.id, month, checks, note, req.user.id, nowISO());
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Mois ${month} clôturé${blockers.length ? ' (avec points ouverts)' : ''}`);
  try { await require('../security/audit').record(req, 'accounting.month_close', { orgId: req.org.id, target: `month:${month}`, severity: blockers.length ? 'warn' : 'info', detail: `${month}${blockers.length ? ' ; forcé : ' + note : ''}` }); } catch { /* l'audit ne bloque jamais */ }
  res.json({ ok: true, forced: blockers.length > 0 });
});
router.post('/closing/reopen', async (req, res) => {
  const b = req.body || {}; const month = monthOf(b.month);
  const reason = A.text(b.reason, 200, { required: true, msg: 'Indiquez le motif de la réouverture.' });
  if (reason.length < 5) throw new HttpError(400, 'Le motif de la réouverture est trop court (5 caractères au moins).');
  const r = await db.prepare("UPDATE month_closings SET status = 'open', reopen_reason = ?, closed_at = NULL WHERE org_id = ? AND month = ? AND status = 'closed'").run(reason, req.org.id, month);
  if (!r.changes) throw new HttpError(404, "Ce mois n'est pas clôturé.");
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Mois ${month} rouvert : ${reason}`);
  try { await require('../security/audit').record(req, 'accounting.month_reopen', { orgId: req.org.id, target: `month:${month}`, severity: 'warn', detail: `${month} : ${reason}` }); } catch { /* l'audit ne bloque jamais */ }
  res.json({ ok: true });
});

// Provisions et charges constatées d'avance / à payer. Les deux dernières sont contre-passées automatiquement le 1er du mois suivant.
const ADJ = { prepaid: 'Charge constatée d\'avance', accrued: 'Charge à payer (facture non parvenue)', provision: 'Provision pour risques' };
router.post('/closing/adjustments', async (req, res) => {
  const b = req.body || {}; const month = monthOf(b.month);
  const kind = A.oneOf(b.kind, Object.keys(ADJ), undefined, 'Type : charge constatée d\'avance, charge à payer ou provision.');
  const row = await closingOf(req.org.id, month);
  if (row && row.status === 'closed') throw new HttpError(409, 'Ce mois est clôturé.');
  const amount = A.amount(b.amount);
  const label = A.text(b.label, 150, { required: true, msg: 'Indiquez le libellé (ex. assurance payée d\'avance).' });
  const account = kind === 'provision' ? '691' : String(b.account || '').trim();
  if (kind !== 'provision' && !/^6\d{2,7}$/.test(account)) throw new HttpError(400, 'Indiquez le compte de charge concerné (classe 6, ex. 625 assurances).');
  if (!await db.prepare('SELECT 1 FROM acc_accounts WHERE org_id = ? AND code = ?').get(req.org.id, account) && !(kind === 'provision')) throw new HttpError(400, `Compte inconnu : ${account}.`);
  const lines = kind === 'prepaid' ? [{ account: '476', debit: amount, memo: label }, { account, credit: amount, memo: label }]
    : kind === 'accrued' ? [{ account, debit: amount, memo: label }, { account: '408', credit: amount, memo: label }]
      : [{ account: '691', debit: amount, memo: label }, { account: '191', credit: amount, memo: label }];
  let out;
  await db.transaction(async () => {
    const id = Number((await db.prepare('INSERT INTO acc_adjustments (org_id, month, kind, label, amount, account, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, month, kind, label, amount, account, req.user.id, nowISO())).lastInsertRowid);
    const e = await accounting().recordEntry(req.org, req.user.id, { journal: 'OD', date: lastDay(month), label: `${ADJ[kind]} ${month} : ${label}`.slice(0, 200), piece: `CLOT-${month}`, lines, source: 'adjustment', sourceId: id });
    let rev = null;
    if (kind !== 'provision') rev = await accounting().reverseEntry(req.org, req.user.id, e.id, `${addMonth(month, 1)}-01`);
    await db.prepare('UPDATE acc_adjustments SET entry_id = ?, reversal_id = ? WHERE id = ?').run(e.id, rev ? rev.id : null, id);
    out = { id, entry: e.number, reversal: rev ? rev.number : null };
  })();
  await A.logActivity(req.org.id, req.user.id, 'accounting', `${ADJ[kind]} ${month} : ${amount}`);
  res.status(201).json(out);
});

// ---------- Écarts de caisse ----------
const cashView = (c) => ({ id: c.id, date: c.date, expected: c.expected, counted: c.counted, diff: c.diff, note: c.note, entryId: c.entry_id, branchId: c.branch_id });
router.get('/cash-counts', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM cash_counts WHERE org_id = ? ORDER BY date DESC, id DESC LIMIT 100').all(req.org.id);
  const bal = (await db.prepare("SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account = '571' AND e.date <= ?").get(req.org.id, today())).b;
  res.json({ counts: rows.map(cashView), glBalance: bal });
});
router.post('/cash-counts', async (req, res) => {
  const b = req.body || {};
  const date = A.date(b.date) || today();
  const counted = Number(typeof b.counted === 'string' ? b.counted.replace(/\s/g, '').replace(',', '.') : b.counted);
  if (!Number.isFinite(counted) || counted < 0 || counted > 1e12) throw new HttpError(400, 'Montant compté invalide (zéro ou plus).');
  const c = Math.round(counted);
  const expected = (await db.prepare("SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account = '571' AND e.date <= ?").get(req.org.id, date)).b;
  const diff = c - expected;
  const note = A.text(b.note, 200);
  if (diff !== 0 && b.post && note.length < 3) throw new HttpError(400, "Pour comptabiliser l'écart, indiquez une explication.");
  let entry = null; let id;
  await db.transaction(async () => {
    id = Number((await db.prepare('INSERT INTO cash_counts (org_id, branch_id, date, expected, counted, diff, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, await A.branchOf(req, b.branchId), date, expected, c, diff, note, req.user.id, nowISO())).lastInsertRowid);
    if (diff !== 0 && b.post) {
      const amt = Math.abs(diff);
      entry = await accounting().recordEntry(req.org, req.user.id, { journal: 'CA', date, label: diff < 0 ? `Écart de caisse (manque) ${date}` : `Écart de caisse (excédent) ${date}`, piece: `CAISSE-${id}`,
        lines: diff < 0 ? [{ account: '658', debit: amt, memo: note }, { account: '571', credit: amt }] : [{ account: '571', debit: amt }, { account: '758', credit: amt, memo: note }], source: 'cash_count', sourceId: id });
      await db.prepare('UPDATE cash_counts SET entry_id = ? WHERE id = ?').run(entry.id, id);
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Comptage de caisse ${date} : écart ${diff}`);
  res.status(201).json({ id, expected, counted: c, diff, entry: entry ? entry.number : null });
});

module.exports = router;
module.exports.plan = plan;
module.exports.dueDepreciation = dueDepreciation;
