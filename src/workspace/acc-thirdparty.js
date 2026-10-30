'use strict';
// Comptabilité · tiers : lettrage clients (411) / fournisseurs (401), balance âgée, factures et dettes fournisseurs avec échéances
// (alimentées par les réceptions du module Stock et achats). Documents de travail.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting'); // require paresseux
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

// ---------- Lettrage ----------
const LETTER_ACCOUNTS = ['411', '401'];
const nextCode = (n) => { let s = ''; let i = n; do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0); return s; };
const sameParty = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

const linesOf = async (orgId, account) => await db.prepare(`SELECT l.id, l.debit, l.credit, l.memo, l.letter, e.number, e.date, e.label, e.piece, e.journal FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
  WHERE l.org_id = ? AND l.account = ? ORDER BY e.date, l.id`).all(orgId, account);

/** Propositions de lettrage : par tiers, une ligne au débit et une au crédit de même montant. */
function proposals(lines) {
  const open = lines.filter((l) => !l.letter);
  const by = new Map();
  for (const l of open) { const k = String(l.memo || '').trim().toLowerCase(); if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
  const out = [];
  for (const [party, list] of by) {
    const credits = list.filter((l) => l.credit > 0); const used = new Set();
    for (const d of list.filter((l) => l.debit > 0)) {
      const c = credits.find((x) => !used.has(x.id) && x.credit === d.debit);
      if (c) { used.add(c.id); out.push({ party: d.memo || party, amount: d.debit, lineIds: [d.id, c.id] }); }
    }
  }
  return out;
}

router.get('/lettering', async (req, res) => {
  const account = A.oneOf(req.query.account, LETTER_ACCOUNTS, '411', 'Compte : 411 (clients) ou 401 (fournisseurs).');
  const lines = await linesOf(req.org.id, account);
  const open = lines.filter((l) => !l.letter);
  const bal = open.reduce((a, l) => a + l.debit - l.credit, 0);
  res.json({
    account, open: open.map((l) => ({ id: l.id, date: l.date, number: l.number, label: l.label, piece: l.piece, party: l.memo, debit: l.debit, credit: l.credit })),
    lettered: lines.filter((l) => l.letter).length, unletteredBalance: bal, proposals: proposals(lines),
    note: 'Le lettrage rapproche les débits et crédits d\'un même tiers (ex. facture et son règlement) ; il ne modifie pas les écritures.',
  });
});

async function letter(req, account, ids) {
  const uniq = [...new Set(ids.map(Number))];
  if (uniq.length < 2 || uniq.length > 100 || uniq.some((x) => !Number.isInteger(x) || x < 1)) throw new HttpError(400, 'Choisissez au moins deux lignes à lettrer.');
  const rows = await db.prepare(`SELECT l.* FROM acc_lines l WHERE l.org_id = ? AND l.account = ? AND l.id IN (${uniq.map(() => '?').join(',')})`).all(req.org.id, account, ...uniq);
  if (rows.length !== uniq.length) throw new HttpError(400, `Certaines lignes n'appartiennent pas au compte ${account}.`);
  if (rows.some((l) => l.letter)) throw new HttpError(409, 'Une des lignes est déjà lettrée.');
  const d = rows.reduce((a, l) => a + l.debit, 0); const c = rows.reduce((a, l) => a + l.credit, 0);
  if (d !== c) throw new HttpError(400, `Le lettrage doit s'équilibrer : débit ${d.toLocaleString('fr-FR')} ≠ crédit ${c.toLocaleString('fr-FR')}.`);
  if (!(req.body || {}).force && new Set(rows.map((l) => String(l.memo || '').trim().toLowerCase())).size > 1) throw new HttpError(400, 'Ces lignes concernent des tiers différents. Confirmez avec « force » si c\'est voulu.');
  let code;
  await db.transaction(async () => {
    const n = (await db.prepare('SELECT COUNT(*) c FROM acc_lettering WHERE org_id = ? AND account = ?').get(req.org.id, account)).c;
    code = nextCode(n);
    await db.prepare('INSERT INTO acc_lettering (org_id, account, code, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, account, code, req.user.id, nowISO());
    await db.prepare(`UPDATE acc_lines SET letter = ? WHERE org_id = ? AND id IN (${uniq.map(() => '?').join(',')})`).run(code, req.org.id, ...uniq);
  })();
  return code;
}
router.post('/lettering', async (req, res) => {
  const account = A.oneOf((req.body || {}).account, LETTER_ACCOUNTS, undefined, 'Compte : 411 (clients) ou 401 (fournisseurs).');
  const code = await letter(req, account, Array.isArray(req.body.lineIds) ? req.body.lineIds : []);
  res.status(201).json({ code });
});
router.post('/lettering/auto', async (req, res) => {
  const account = A.oneOf((req.body || {}).account, LETTER_ACCOUNTS, undefined, 'Compte : 411 (clients) ou 401 (fournisseurs).');
  const props = proposals(await linesOf(req.org.id, account));
  const codes = [];
  for (const p of props) codes.push(await letter(req, account, p.lineIds));
  res.json({ lettered: codes.length, codes });
});
router.delete('/lettering/:account/:code', async (req, res) => {
  const account = A.oneOf(req.params.account, LETTER_ACCOUNTS, undefined, 'Compte inconnu.');
  const code = String(req.params.code).slice(0, 6);
  const r = await db.prepare('UPDATE acc_lines SET letter = \'\' WHERE org_id = ? AND account = ? AND letter = ?').run(req.org.id, account, code);
  if (!r.changes) throw new HttpError(404, 'Lettrage introuvable.');
  await db.prepare('DELETE FROM acc_lettering WHERE org_id = ? AND account = ? AND code = ?').run(req.org.id, account, code);
  res.json({ ok: true, unlettered: r.changes });
});

// ---------- Balance âgée ----------
const BUCKETS = [['current', 'Non échu'], ['d30', '1 à 30 jours'], ['d60', '31 à 60 jours'], ['d90', '61 à 90 jours'], ['over90', 'Plus de 90 jours']];
const bucketOf = (due, asOf) => { const late = Math.round((Date.parse(asOf) - Date.parse(due)) / 86400000); return late <= 0 ? 'current' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'over90'; };

async function openItems(org, kind, asOf) {
  if (kind === 'customers') {
    const rows = await db.prepare(`SELECT d.id, d.number, d.issued, d.due, d.total, d.paid, d.credited, c.name AS party FROM documents d JOIN customers c ON c.id = d.customer_id
      WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status = 'sent' AND d.total - d.paid - d.credited > 0 ORDER BY d.due, d.id`).all(org.id);
    return rows.map((d) => ({ id: d.id, kind: 'invoice', number: d.number, party: d.party, date: d.issued, due: d.due || d.issued, amount: d.total - d.paid - d.credited }));
  }
  const rows = await db.prepare(`SELECT b.*, COALESCE(NULLIF(b.supplier_name, ''), s.name, '') AS party FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.org_id = ? AND b.status IN ('open', 'partial') AND b.amount - b.paid > 0 ORDER BY b.due_date, b.id`).all(org.id);
  return rows.map((b) => ({ id: b.id, kind: 'bill', number: b.number, party: b.party || '(sans nom)', date: b.bill_date, due: b.due_date, amount: b.amount - b.paid }));
}

router.get('/aged', async (req, res) => {
  const kind = A.oneOf(req.query.kind, ['customers', 'suppliers'], 'customers', 'Choisissez clients ou fournisseurs.');
  const asOf = A.date(req.query.asOf) || today();
  const items = await openItems(req.org, kind, asOf);
  const parties = new Map();
  const totals = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 };
  for (const it of items) {
    const b = bucketOf(it.due, asOf);
    if (!parties.has(it.party)) parties.set(it.party, { party: it.party, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0, items: [] });
    const p = parties.get(it.party);
    p[b] += it.amount; p.total += it.amount; totals[b] += it.amount; totals.total += it.amount;
    p.items.push({ ...it, bucket: b, daysLate: Math.max(Math.round((Date.parse(asOf) - Date.parse(it.due)) / 86400000), 0) });
  }
  res.json({ kind, asOf, buckets: BUCKETS.map(([k, label]) => ({ key: k, label })), rows: [...parties.values()].sort((a, b) => b.total - a.total), totals, notice: 'Document de travail : soldes actuels classés par ancienneté de l\'échéance à la date choisie.' });
});

// ---------- Factures et dettes fournisseurs ----------
const PAY = { cash: ['571', 'CA'], bank: ['521', 'BQ'], mobile: ['589', 'MM'] };
const billView = (b, party) => {
  const left = b.amount - b.paid; const t = today();
  return { id: b.id, supplierId: b.supplier_id, supplier: party || b.supplier_name || '', number: b.number, billDate: b.bill_date, dueDate: b.due_date, amount: b.amount, paid: b.paid, balance: left, status: b.status, source: b.source, note: b.note,
    overdue: left > 0 && b.status !== 'cancelled' && b.due_date < t, daysLate: left > 0 && b.due_date < t ? Math.round((Date.parse(t) - Date.parse(b.due_date)) / 86400000) : 0, accEntryId: b.acc_entry_id };
};
const billOf = async (req, id) => {
  const b = await db.prepare('SELECT b.*, COALESCE(NULLIF(b.supplier_name, \'\'), s.name, \'\') AS party FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = ? AND b.org_id = ?').get(A.id(id), req.org.id);
  if (!b) throw new HttpError(404, 'Facture fournisseur introuvable.');
  return b;
};
const purchaseSplit = (req, total) => {
  const st = req.acc;
  if (!st.purchase_vat) return { ht: total, tva: 0 };
  const ht = st.vat_rate > 0 ? Math.round(total / (1 + st.vat_rate / 100)) : total;
  return { ht, tva: total - ht };
};

router.get('/payables', async (req, res) => {
  const st = ['open', 'partial', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const rows = await db.prepare(`SELECT b.*, COALESCE(NULLIF(b.supplier_name, ''), s.name, '') AS party FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.org_id = ?${st ? ' AND b.status = ?' : ''} ORDER BY b.due_date, b.id DESC LIMIT 300`).all(...(st ? [req.org.id, st] : [req.org.id]));
  const list = rows.map((b) => billView(b, b.party));
  const openL = list.filter((b) => ['open', 'partial'].includes(b.status));
  const t = today(); const in7 = addDays(t, 7);
  res.json({
    bills: list,
    summary: { count: openL.length, balance: openL.reduce((a, b) => a + b.balance, 0), overdue: openL.filter((b) => b.overdue).length, overdueAmount: openL.filter((b) => b.overdue).reduce((a, b) => a + b.balance, 0), dueIn7Days: openL.filter((b) => !b.overdue && b.dueDate <= in7).reduce((a, b) => a + b.balance, 0) },
  });
});

router.post('/payables', async (req, res) => {
  const b = req.body || {};
  let supplierId = null; let supplierName = A.text(b.supplierName, 120);
  if (b.supplierId !== undefined && b.supplierId !== '' && b.supplierId !== null) {
    const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND org_id = ?').get(A.id(b.supplierId, 'Fournisseur invalide.'), req.org.id);
    if (!s) throw new HttpError(404, 'Fournisseur introuvable.');
    supplierId = s.id; supplierName = s.name;
  }
  if (!supplierName) throw new HttpError(400, 'Indiquez le fournisseur.');
  const amount = A.amount(b.amount);
  const billDate = A.date(b.billDate) || today();
  const due = A.date(b.dueDate) || addDays(billDate, Math.min(Math.max(Number(b.termsDays) || 30, 0), 365));
  if (due < billDate) throw new HttpError(400, "L'échéance est avant la date de la facture.");
  const account = String(b.expenseAccount || '601').trim();
  if (b.post !== false && !await db.prepare('SELECT 1 FROM acc_accounts WHERE org_id = ? AND code = ?').get(req.org.id, account)) throw new HttpError(400, `Compte de charge inconnu : ${account}.`);
  let id; let entry = null;
  await db.transaction(async () => {
    id = Number((await db.prepare('INSERT INTO supplier_bills (org_id, supplier_id, supplier_name, number, bill_date, due_date, amount, source, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'manual\', ?, ?, ?)')
      .run(req.org.id, supplierId, supplierName, A.text(b.number, 60), billDate, due, amount, A.text(b.note, 200), req.user.id, nowISO())).lastInsertRowid);
    if (b.post !== false) {
      const { ht, tva } = purchaseSplit(req, amount);
      const lines = [{ account, debit: ht, memo: supplierName }]; if (tva > 0) lines.push({ account: '4452', debit: tva });
      lines.push({ account: '401', credit: amount, memo: supplierName });
      entry = await accounting().recordEntry(req.org, req.user.id, { journal: 'AC', date: billDate, label: `Facture fournisseur ${A.text(b.number, 60) || '#' + id} - ${supplierName}`.slice(0, 200), piece: A.text(b.number, 60) || `FF-${id}`, lines, source: 'supplier_bill', sourceId: id });
      await db.prepare('UPDATE supplier_bills SET acc_entry_id = ? WHERE id = ?').run(entry.id, id);
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Facture fournisseur ${supplierName} (${amount})`);
  res.status(201).json({ id, entry: entry ? entry.number : null });
});

// Alimente les dettes depuis le module Stock et achats : une dette par réception (ou ancienne commande reçue) pas encore facturée. Pas de nouvelle écriture :
// l'achat est déjà comptabilisé (achat -> 401) par « Comptabiliser maintenant » ; la dette ne fait que suivre l'échéance et le règlement.
router.post('/payables/from-purchases', async (req, res) => {
  const terms = Math.min(Math.max(Number((req.body || {}).termsDays) || 30, 0), 365);
  const rec = await db.prepare(`SELECT r.*, sp.name AS supplier, sp.id AS sid FROM purchase_receipts r JOIN purchase_orders o ON o.id = r.order_id LEFT JOIN suppliers sp ON sp.id = o.supplier_id
    WHERE r.org_id = ? AND r.unit_price > 0 AND NOT EXISTS (SELECT 1 FROM supplier_bills b WHERE b.org_id = r.org_id AND b.source = 'receipt' AND b.source_id = r.id) ORDER BY r.id`).all(req.org.id);
  const old = await db.prepare(`SELECT o.*, sp.name AS supplier FROM purchase_orders o LEFT JOIN suppliers sp ON sp.id = o.supplier_id WHERE o.org_id = ? AND o.status = 'received' AND o.unit_price > 0
    AND NOT EXISTS (SELECT 1 FROM purchase_receipts r WHERE r.order_id = o.id) AND NOT EXISTS (SELECT 1 FROM supplier_bills b WHERE b.org_id = o.org_id AND b.source = 'purchase' AND b.source_id = o.id) ORDER BY o.id`).all(req.org.id);
  let created = 0;
  await db.transaction(async () => {
    for (const r of rec) {
      const date = r.created_at.slice(0, 10); const total = Math.max(Math.round(r.quantity * r.unit_price), 1);
      const e = await db.prepare("SELECT id FROM acc_entries WHERE org_id = ? AND source = 'receipt' AND source_id = ?").get(req.org.id, r.id);
      await db.prepare("INSERT INTO supplier_bills (org_id, supplier_id, supplier_name, number, bill_date, due_date, amount, source, source_id, acc_entry_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'receipt', ?, ?, ?, ?)")
        .run(req.org.id, r.sid || null, r.supplier || '', `CMD-${r.order_id}`, date, addDays(date, terms), total, r.id, e ? e.id : null, req.user.id, nowISO());
      created++;
    }
    for (const o of old) {
      const date = o.updated_at.slice(0, 10); const total = Math.max(Math.round(o.quantity * o.unit_price), 1);
      const e = await db.prepare("SELECT id FROM acc_entries WHERE org_id = ? AND source = 'purchase' AND source_id = ?").get(req.org.id, o.id);
      await db.prepare("INSERT INTO supplier_bills (org_id, supplier_id, supplier_name, number, bill_date, due_date, amount, source, source_id, acc_entry_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'purchase', ?, ?, ?, ?)")
        .run(req.org.id, o.supplier_id || null, o.supplier || '', `CMD-${o.id}`, date, addDays(date, terms), total, o.id, e ? e.id : null, req.user.id, nowISO());
      created++;
    }
  })();
  if (created) await A.logActivity(req.org.id, req.user.id, 'accounting', `${created} dette(s) fournisseur créée(s) depuis les achats`);
  res.status(created ? 201 : 200).json({ created });
});

router.post('/payables/:id/pay', async (req, res) => {
  const bill = await billOf(req, req.params.id);
  if (!['open', 'partial'].includes(bill.status)) throw new HttpError(400, 'Cette facture n\'est plus à payer.');
  const b = req.body || {};
  const amount = A.amount(b.amount === undefined || b.amount === '' ? bill.amount - bill.paid : b.amount);
  if (amount > bill.amount - bill.paid) throw new HttpError(400, `Ce règlement dépasse le solde (${bill.amount - bill.paid}).`);
  const method = A.oneOf(b.method, Object.keys(PAY), 'bank', 'Mode de règlement : espèces, banque ou mobile money.');
  const date = A.date(b.date) || today();
  const [acct, journal] = PAY[method];
  let pid; let entry;
  await db.transaction(async () => {
    const upd = await db.prepare("UPDATE supplier_bills SET paid = paid + ?, status = CASE WHEN paid + ? >= amount THEN 'paid' ELSE 'partial' END WHERE id = ? AND status IN ('open', 'partial') AND paid + ? <= amount").run(amount, amount, bill.id, amount);
    if (!upd.changes) throw new HttpError(409, 'Cette facture vient de changer : rechargez la page.');
    pid = Number((await db.prepare('INSERT INTO supplier_payments (org_id, bill_id, amount, date, method, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, bill.id, amount, date, method, A.text(b.reference, 80), req.user.id, nowISO())).lastInsertRowid);
    entry = await accounting().recordEntry(req.org, req.user.id, { journal, date, label: `Règlement fournisseur ${bill.party || ''} ${bill.number || ''}`.trim().slice(0, 200), piece: A.text(b.reference, 60) || bill.number || `FF-${bill.id}`,
      lines: [{ account: '401', debit: amount, memo: bill.party || '' }, { account: acct, credit: amount, memo: A.text(b.reference, 80) }], source: 'supplier_payment', sourceId: pid });
    await db.prepare('UPDATE supplier_payments SET acc_entry_id = ? WHERE id = ?').run(entry.id, pid);
  })();
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Règlement fournisseur ${bill.party || ''} (${amount})`);
  res.status(201).json({ id: pid, entry: entry.number });
});

router.delete('/payables/:id', async (req, res) => {
  const bill = await billOf(req, req.params.id);
  if (bill.paid > 0) throw new HttpError(400, 'Une facture déjà réglée (même en partie) ne s\'annule pas.');
  if (bill.status === 'cancelled') throw new HttpError(400, 'Déjà annulée.');
  let reversed = null;
  if (bill.source === 'manual' && bill.acc_entry_id) reversed = (await accounting().reverseEntry(req.org, req.user.id, Number(bill.acc_entry_id))).reversed;
  await db.prepare("UPDATE supplier_bills SET status = 'cancelled' WHERE id = ? AND paid = 0").run(bill.id);
  res.json({ ok: true, reversedEntry: reversed });
});

module.exports = router;
module.exports.openItems = openItems;
module.exports.bucketOf = bucketOf;
