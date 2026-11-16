'use strict';
// Achats (2/5) : bons de commande, envoi au fournisseur (PDF), réceptions (entrée en stock : lots, péremptions, numéros de série), contrôle qualité.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const P = require('./purchasing-lib');
const L = require('./stock-lib');
const pdf = require('../services/pdf');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const supplierForOrder = (req, id) => require('./purchasing').supplierForOrder(req, id);

async function orderOf(req, idv) {
  const o = await db.prepare('SELECT * FROM pur_orders WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!o) throw new HttpError(404, 'Bon de commande introuvable.');
  return o;
}
async function refreshStatus(o) {
  if (!['approved', 'sent', 'partial', 'received'].includes(o.status)) return o.status;
  const lines = await P.orderLineState(o.id);
  const anyIn = lines.some((l) => l.received > 0 || l.pending > 0 || l.rejected > 0);
  const all = lines.every((l) => l.remaining <= 0);
  const next = all ? 'received' : anyIn ? 'partial' : (o.sent_at ? 'sent' : 'approved');
  if (next !== o.status) await db.prepare('UPDATE pur_orders SET status = ?, updated_at = ? WHERE id = ?').run(next, nowISO(), o.id);
  return next;
}

// ---------- Liste et création ----------
router.get('/orders', mgr, async (req, res) => {
  const status = String((req.query || {}).status || '').trim();
  const all = await db.prepare('SELECT o.*, s.name AS supplier FROM pur_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.org_id = ? ORDER BY o.id DESC LIMIT 1000').all(req.org.id);
  const counts = {}; let late = 0;
  for (const o of all) { counts[o.status] = (counts[o.status] || 0) + 1; if (P.isLate(o)) late++; }
  const out = [];
  for (const o of all.filter((x) => !status || x.status === status)) out.push({ id: Number(o.id), number: o.number, supplier: o.supplier, supplierId: Number(o.supplier_id), orderDate: o.order_date, expectedDate: o.expected_date || null, category: o.category || null, late: Boolean(P.isLate(o)), totalTtc: (await P.orderTotalsOf(o)).ttc, status: o.status });
  res.json({ orders: out, counts, late });
});
async function readOrder(req, b) {
  const supplier = await supplierForOrder(req, b.supplierId);
  const lines = await P.readLines(req, b.lines, 'unitPrice', { priceRequired: true });
  const orderDate = P.dateOrNull(b.orderDate) || P.today();
  const expected = P.dateOrNull(b.expectedDate);
  if (expected && expected < orderDate) throw new HttpError(400, 'La livraison prévue ne peut pas précéder la date de commande.');
  const settings = await P.settingsOf(req.org);
  const pdRaw = b.paymentDays === undefined || b.paymentDays === null || b.paymentDays === '' ? (supplier.payment_days !== null ? Number(supplier.payment_days) : settings.defaultTermsDays) : Number(b.paymentDays);
  if (!Number.isInteger(pdRaw) || pdRaw < 0 || pdRaw > 365) throw new HttpError(400, 'Délai de paiement : entre 0 et 365 jours.');
  const vat = b.vatRate === undefined || b.vatRate === null || b.vatRate === '' ? Number(req.org.vat_rate) || 0 : P.pct(b.vatRate);
  return { supplier, lines, orderDate, expected, paymentDays: pdRaw, vat, category: P.category(b.category), address: cleanText(String(b.deliveryAddress || ''), 200), notes: cleanText(String(b.notes || ''), 2000) };
}
router.post('/orders', mgr, async (req, res) => {
  const v = await readOrder(req, req.body || {});
  const now = nowISO();
  const out = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'BC', v.orderDate);
    const id = Number((await db.prepare(`INSERT INTO pur_orders (org_id, number, supplier_id, status, order_date, expected_date, payment_days, vat_rate, category, delivery_address, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, number, v.supplier.id, v.orderDate, v.expected, v.paymentDays, v.vat, v.category, v.address, v.notes, req.user.id, now, now)).lastInsertRowid);
    let pos = 0;
    for (const l of v.lines) await db.prepare('INSERT INTO pur_order_lines (order_id, item_id, description, unit, quantity, unit_price, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, l.itemId, l.description, l.unit, l.quantity, l.price, pos++);
    return { id, number };
  })();
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Bon de commande ${out.number} créé`);
  res.status(201).json(out);
});
router.put('/orders/:id', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'draft') throw new HttpError(400, 'Seul un bon de commande en brouillon se modifie.');
  const v = await readOrder(req, req.body || {});
  await db.transaction(async () => {
    await db.prepare('UPDATE pur_orders SET supplier_id = ?, order_date = ?, expected_date = ?, payment_days = ?, vat_rate = ?, category = ?, delivery_address = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(v.supplier.id, v.orderDate, v.expected, v.paymentDays, v.vat, v.category, v.address, v.notes, nowISO(), o.id);
    await db.prepare('DELETE FROM pur_order_lines WHERE order_id = ?').run(o.id);
    let pos = 0;
    for (const l of v.lines) await db.prepare('INSERT INTO pur_order_lines (order_id, item_id, description, unit, quantity, unit_price, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(o.id, l.itemId, l.description, l.unit, l.quantity, l.price, pos++);
  })();
  res.json({ ok: true });
});

// ---------- Détail ----------
async function canApproveOrder(req, o, ttc) {
  if (o.status !== 'draft') return false;
  const role = P.requiredRole(await P.settingsOf(req.org), 'order', ttc);
  return A.RANK[req.member.role] >= A.RANK[role];
}
router.get('/orders/:id', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const s = await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(o.supplier_id);
  const lines = await P.orderLineState(o.id);
  const items = {};
  for (const l of lines) if (l.item_id && !items[l.item_id]) items[l.item_id] = await db.prepare('SELECT tracking FROM stock_items WHERE id = ?').get(l.item_id);
  const t = P.orderTotals(lines, o.vat_rate);
  const names = await P.nameMap([o.created_by, o.approved_by]);
  const settings = await P.settingsOf(req.org);
  const b = o.category ? await P.budgetOf(req.org.id, o.category, P.yearOf(o.order_date), { exceptOrder: o.status === 'draft' ? o.id : 0 }) : null;
  const receipts = await db.prepare('SELECT id, number, date, delivery_note FROM pur_receipts WHERE order_id = ? ORDER BY id').all(o.id);
  const invoices = [];
  for (const i of await db.prepare("SELECT * FROM pur_invoices WHERE order_id = ? AND status != 'cancelled' ORDER BY id").all(o.id)) invoices.push({ id: Number(i.id), number: i.number, supplierRef: i.supplier_ref, status: i.status, totalTtc: (await P.invoiceTotalsOf(i)).ttc });
  res.json({ order: {
    id: Number(o.id), number: o.number, supplierId: Number(o.supplier_id), supplier: s ? s.name : '', supplierEmail: s && s.email ? s.email : null, status: o.status, late: Boolean(P.isLate(o)),
    orderDate: o.order_date, expectedDate: o.expected_date || null, paymentDays: Number(o.payment_days), category: o.category || null, deliveryAddress: o.delivery_address || null, notes: o.notes || null,
    creator: names[Number(o.created_by)] || '', approver: o.approved_by ? names[Number(o.approved_by)] || '' : null,
    sentAt: o.sent_at || null, sentTo: o.sent_to || null, cancelReason: o.cancel_reason || null,
    requiredRoleLabel: A.ROLE_LABEL[P.requiredRole(settings, 'order', t.ttc)], canApprove: await canApproveOrder(req, o, t.ttc),
    lines: lines.map((l) => ({ id: Number(l.id), itemId: l.item_id ? Number(l.item_id) : null, description: l.description, quantity: l.quantity, unit: l.unit, receivedQty: l.received, rejectedQty: l.rejected, pendingQty: l.pending, invoicedQty: l.invoiced, remainingQty: l.remaining, unitPrice: l.unit_price, amount: P.amount(l.quantity, l.unit_price), tracking: l.item_id && items[l.item_id] && ['lot', 'serial'].includes(items[l.item_id].tracking) ? items[l.item_id].tracking : null })),
    totalHt: t.ht, vatRate: Number(o.vat_rate), vatAmount: t.vat, totalTtc: t.ttc,
    budget: b ? { category: b.category, planned: b.planned, engaged: b.engaged, invoiced: b.invoiced, over: b.engaged + b.invoiced + (o.status === 'draft' ? t.ttc : 0) > b.planned } : null,
    receipts: receipts.map((r) => ({ id: Number(r.id), number: r.number, date: r.date, deliveryNote: r.delivery_note || null })),
    invoices,
  } });
});

// ---------- Cycle de vie ----------
router.post('/orders/:id/approve', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'draft') throw new HttpError(400, 'Ce bon de commande est déjà approuvé.');
  const s = await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(o.supplier_id);
  if (s && Number(s.blocked)) throw new HttpError(400, 'Ce fournisseur est bloqué : il ne peut plus recevoir de commande.');
  const t = await P.orderTotalsOf(o);
  const role = P.requiredRole(await P.settingsOf(req.org), 'order', t.ttc);
  if (A.RANK[req.member.role] < A.RANK[role]) throw new HttpError(403, `Ce montant doit être approuvé par : ${A.ROLE_LABEL[role]}.`);
  const warn = o.category ? await P.budgetCheck(req, o.category, P.yearOf(o.order_date), t.ttc, { exceptOrder: o.id }) : {};
  await db.prepare("UPDATE pur_orders SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(req.user.id, nowISO(), nowISO(), o.id);
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Bon de commande ${o.number} approuvé`);
  res.json({ ok: true, ...warn });
});

async function orderPdf(req, o) {
  const s = await db.prepare('SELECT * FROM suppliers WHERE id = ?').get(o.supplier_id);
  const lines = await db.prepare('SELECT * FROM pur_order_lines WHERE order_id = ? ORDER BY position, id').all(o.id);
  const t = P.orderTotals(lines, o.vat_rate);
  const cur = req.org.currency || 'FCFA';
  return pdf.render({
    title: `Bon de commande ${o.number}`, org: req.org.name,
    meta: [['Date', pdf.dfr(o.order_date)], ['Livraison prévue', pdf.dfr(o.expected_date) || '—'], ['Paiement', `${o.payment_days} jours`]],
    blocks: [
      { type: 'kv', rows: [['Fournisseur', s ? s.name : ''], ['Adresse', s ? [s.address, s.city].filter(Boolean).join(', ') : ''], ['NIU', s ? s.tax_id : ''], ['Livrer à', o.delivery_address || req.org.name]] },
      { type: 'table', cols: [{ key: 'd', label: 'Désignation', width: 0.46 }, { key: 'q', label: 'Quantité', width: 0.16, align: 'right' }, { key: 'p', label: 'Prix unitaire HT', width: 0.19, align: 'right' }, { key: 'a', label: 'Montant HT', width: 0.19, align: 'right' }],
        rows: lines.map((l) => ({ d: l.description, q: `${Number(l.quantity)} ${l.unit || ''}`.trim(), p: pdf.money(l.unit_price, cur), a: pdf.money(P.amount(l.quantity, l.unit_price), cur) })),
        totals: [['Total HT', pdf.money(t.ht, cur)], [`TVA ${Number(o.vat_rate)} %`, pdf.money(t.vat, cur)], ['Total TTC', pdf.money(t.ttc, cur), true]] },
      ...(o.notes ? [{ type: 'note', text: o.notes }] : []),
    ],
  });
}
const sendPdf = (res, buf, name) => { res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"` }); res.end(buf); };
router.get('/orders/:id/pdf', mgr, async (req, res) => { const o = await orderOf(req, req.params.id); sendPdf(res, await orderPdf(req, o), `${o.number}.pdf`); });

router.post('/orders/:id/send', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['approved', 'sent', 'partial'].includes(o.status)) throw new HttpError(400, 'Approuvez le bon de commande avant de l\'envoyer.');
  const b = req.body || {};
  const via = b.via === 'email' ? 'email' : 'manual';
  let to = cleanText(String(b.to || ''), 150);
  if (via === 'email') {
    const notify = require('../services/notify');
    if (!notify.mailEnabled()) throw new HttpError(400, "L'envoi d'e-mails n'est pas activé sur ce serveur. Téléchargez le PDF, puis choisissez « Marquer comme envoyé ».");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new HttpError(400, 'Adresse e-mail invalide.');
    const buf = await orderPdf(req, o);
    await notify.sendMail({ to, subject: `Bon de commande ${o.number} - ${req.org.name}`, text: `Bonjour,\n\nVeuillez trouver ci-joint notre bon de commande ${o.number}.\n\nCordialement,\n${req.org.name}`, fromName: req.org.name, attachments: [{ filename: `${o.number}.pdf`, content: buf }] });
  } else to = to || '';
  await db.prepare('UPDATE pur_orders SET status = ?, sent_at = ?, sent_to = ?, updated_at = ? WHERE id = ?').run(o.status === 'approved' ? 'sent' : o.status, nowISO(), via === 'email' ? to : (to || 'envoi manuel'), nowISO(), o.id);
  res.json({ ok: true, via, to });
});
router.post('/orders/:id/close', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['partial', 'received'].includes(o.status)) throw new HttpError(400, 'Seul un bon de commande reçu (même en partie) se clôt.');
  await db.prepare("UPDATE pur_orders SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(nowISO(), nowISO(), o.id);
  res.json({ ok: true });
});
async function releaseRequest(o) {
  if (o.request_id) await db.prepare("UPDATE pur_requests SET status = 'approved', order_id = NULL, updated_at = ? WHERE id = ? AND status = 'ordered'").run(nowISO(), o.request_id);
}
router.post('/orders/:id/cancel', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['draft', 'approved', 'sent'].includes(o.status)) throw new HttpError(400, 'Ce bon de commande ne peut plus être annulé.');
  if (await db.prepare('SELECT 1 FROM pur_receipts WHERE order_id = ?').get(o.id)) throw new HttpError(400, 'Des marchandises ont déjà été reçues : clôturez le bon de commande à la place.');
  const reason = cleanText(String((req.body || {}).reason || ''), 500);
  if (o.status !== 'draft' && !reason) throw new HttpError(400, 'Indiquez le motif.');
  await db.transaction(async () => {
    await db.prepare("UPDATE pur_orders SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(reason, nowISO(), o.id);
    await releaseRequest(o);
  })();
  res.json({ ok: true });
});
router.delete('/orders/:id', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (o.status !== 'draft') throw new HttpError(400, 'Seul un brouillon se supprime.');
  await db.transaction(async () => {
    await releaseRequest(o);
    if (o.rfq_id) await db.prepare("UPDATE pur_rfqs SET order_id = NULL WHERE id = ?").run(o.rfq_id);
    await db.prepare('DELETE FROM pur_orders WHERE id = ?').run(o.id);
  })();
  res.json({ ok: true });
});

/** Préparation d'une facture : ce qui a été reçu et pas encore facturé. */
router.get('/orders/:id/invoice-draft', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  const lines = (await P.orderLineState(o.id)).map((l) => ({ orderLineId: Number(l.id), description: l.description, unit: l.unit, quantity: P.round3(Math.max(0, l.received - l.invoiced)), unitPrice: l.unit_price })).filter((l) => l.quantity > 0);
  res.json({ supplierId: Number(o.supplier_id), vatRate: Number(o.vat_rate), paymentDays: Number(o.payment_days), lines });
});

// ---------- Réceptions ----------
const entryReason = (rc, o) => `Réception ${rc} (commande ${o.number})`;
router.post('/orders/:id/receipts', mgr, async (req, res) => {
  const o = await orderOf(req, req.params.id);
  if (!['approved', 'sent', 'partial'].includes(o.status)) throw new HttpError(400, "Approuvez le bon de commande avant d'enregistrer une réception.");
  const b = req.body || {};
  const date = P.dateOrNull(b.receiptDate) || P.today();
  if (date > P.today()) throw new HttpError(400, 'La date de réception ne peut pas être dans le futur.');
  const state = Object.fromEntries((await P.orderLineState(o.id)).map((l) => [Number(l.id), l]));
  const settings = await P.settingsOf(req.org);
  const todo = [];
  for (const x of Array.isArray(b.lines) ? b.lines : []) {
    const l = state[A.id(x && x.orderLineId, 'Ligne inconnue.')];
    if (!l) throw new HttpError(400, 'Ligne inconnue.');
    const acc = P.qtyOf(x.receivedQty || 0, { zero: true }); const rej = P.qtyOf(x.rejectedQty || 0, { zero: true });
    if (!acc && !rej) continue;
    if (acc > P.round3(l.remaining * (1 + settings.tolQtyPct / 100)) + 1e-9) throw new HttpError(400, `Quantité reçue supérieure à la quantité restante pour « ${l.description} » (${l.remaining} ${l.unit}).`);
    if (rej && !cleanText(String(x.reason || ''), 200)) throw new HttpError(400, `Indiquez le motif du refus pour « ${l.description} ».`);
    todo.push({ l, acc, rej, x });
  }
  if (!todo.length) throw new HttpError(400, 'Aucune quantité reçue ou refusée : rien à enregistrer.');
  const now = nowISO();
  const out = await db.transaction(async () => {
    const number = await P.nextNumber(req.org.id, 'BR', date);
    const rid = Number((await db.prepare('INSERT INTO pur_receipts (org_id, number, order_id, date, delivery_note, note, received_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, number, o.id, date, cleanText(String(b.deliveryNote || ''), 60), cleanText(String(b.note || ''), 500), req.user.id, now)).lastInsertRowid);
    for (const { l, acc, rej, x } of todo) {
      const it = l.item_id ? await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(l.item_id, req.org.id) : null;
      const inspection = Boolean(x.inspection) && it && it.tracking !== 'serial';
      const lotNo = cleanText(String(x.lotNo || ''), 40); const expiry = P.dateOrNull(x.expiry, 'Date de péremption invalide (AAAA-MM-JJ).');
      const serials = it && it.tracking === 'serial' ? L.parseSerials(x.serials) : [];
      if (it && it.tracking === 'lot' && acc && !lotNo) throw new HttpError(400, `« ${it.name} » est suivi par lot : indiquez le numéro de lot reçu.`);
      await db.prepare(`INSERT INTO pur_receipt_lines (receipt_id, order_line_id, received_qty, rejected_qty, reason, lot_no, expiry, serials, location_id, inspection, insp_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rid, l.id, acc, rej, cleanText(String(x.reason || ''), 200), lotNo, expiry, serials.join('\n'), x.locationId ? A.id(x.locationId) : null, inspection ? 1 : 0, inspection ? acc : 0);
      // Seules les quantités acceptées (hors contrôle qualité) entrent dans le stock, au prix de la commande.
      // Les quantités acceptées entrent en stock au prix de la commande : à l'emplacement choisi (sinon règles de rangement),
      // ou en QUARANTAINE (stock présent mais non disponible) tant que le contrôle qualité n'est pas fait.
      if (it && acc) {
        const W = require('./wms-core');
        const locationId = inspection ? (await W.quarantineOf(req.org.id)).id : (x.locationId ? (await W.locationOf(req.org.id, A.id(x.locationId))).id : undefined);
        await L.adjust(req, it, acc, entryReason(number, o) + (inspection ? ' : quarantaine' : ''), { unitCost: l.unit_price, lotNo, expiry, serials, strict: true, refKind: 'pur_receipt', refId: rid, locationId });
      }
      if (it && acc) {
        await db.prepare('UPDATE stock_items SET unit_cost = ? WHERE id = ?').run(l.unit_price, it.id);
        await db.prepare('INSERT INTO supplier_prices (org_id, item_id, supplier_id, unit_price) VALUES (?, ?, ?, ?) ON CONFLICT (item_id, supplier_id) DO UPDATE SET unit_price = excluded.unit_price').run(req.org.id, it.id, o.supplier_id, l.unit_price);
      }
    }
    return { id: rid, number };
  })();
  const status = await refreshStatus(await orderOf(req, o.id));
  await A.logActivity(req.org.id, req.user.id, 'purchasing', `Réception ${out.number} enregistrée (commande ${o.number})`);
  res.status(201).json({ ...out, status });
});

async function receiptRows(req, where, args) {
  const rows = await db.prepare(`SELECT r.*, o.number AS order_number, s.name AS supplier, u.name AS receiver FROM pur_receipts r JOIN pur_orders o ON o.id = r.order_id JOIN suppliers s ON s.id = o.supplier_id LEFT JOIN users u ON u.id = r.received_by WHERE r.org_id = ?${where} ORDER BY r.id DESC LIMIT 300`).all(req.org.id, ...args);
  const out = [];
  for (const r of rows) {
    const lines = await db.prepare('SELECT rl.*, ol.description, ol.quantity AS ordered, ol.unit FROM pur_receipt_lines rl JOIN pur_order_lines ol ON ol.id = rl.order_line_id WHERE rl.receipt_id = ? ORDER BY rl.id').all(r.id);
    out.push({
      id: Number(r.id), number: r.number, orderId: Number(r.order_id), orderNumber: r.order_number, supplier: r.supplier, date: r.date, deliveryNote: r.delivery_note || null, note: r.note || null, receiver: r.receiver || '',
      lines: lines.map((l) => ({ id: Number(l.id), description: l.description, ordered: Number(l.ordered), unit: l.unit, lotNo: l.lot_no || null, expiry: l.expiry || null, reason: [l.reason, l.insp_reason].filter(Boolean).join(' · ') || null, receivedQty: P.round3(Number(l.received_qty) - Number(l.insp_rejected)), rejectedQty: P.round3(Number(l.rejected_qty) + Number(l.insp_rejected)), inspectionPending: Number(l.insp_pending) })),
    });
  }
  return out;
}
router.get('/receipts', mgr, async (req, res) => res.json({ receipts: await receiptRows(req, '', []) }));
router.get('/receipts/:id/pdf', mgr, async (req, res) => {
  const [r] = await receiptRows(req, ' AND r.id = ?', [A.id(req.params.id)]);
  if (!r) throw new HttpError(404, 'Bon de réception introuvable.');
  const buf = await pdf.render({
    title: `Bon de réception ${r.number}`, org: req.org.name,
    meta: [['Date', pdf.dfr(r.date)], ['Commande', r.orderNumber], ['Bon de livraison', r.deliveryNote || '—']],
    blocks: [
      { type: 'kv', rows: [['Fournisseur', r.supplier], ['Reçu par', r.receiver]] },
      { type: 'table', cols: [{ key: 'd', label: 'Désignation', width: 0.4 }, { key: 'o', label: 'Commandé', width: 0.14, align: 'right' }, { key: 'r', label: 'Accepté', width: 0.14, align: 'right' }, { key: 'j', label: 'Refusé', width: 0.12, align: 'right' }, { key: 'l', label: 'Lot / motif', width: 0.2 }],
        rows: r.lines.map((l) => ({ d: l.description, o: `${l.ordered} ${l.unit || ''}`.trim(), r: String(l.receivedQty), j: l.rejectedQty ? String(l.rejectedQty) : '', l: [l.lotNo, l.expiry ? pdf.dfr(l.expiry) : '', l.reason].filter(Boolean).join(' · ') })) },
      ...(r.note ? [{ type: 'note', text: r.note }] : []),
    ],
  });
  sendPdf(res, buf, `${r.number}.pdf`);
});

// ---------- Contrôle qualité (quarantaine) ----------
router.get('/inspections', mgr, async (req, res) => {
  const rows = await db.prepare(`SELECT rl.*, ol.description, ol.unit, r.number AS receipt, r.date, o.number AS order_number, s.name AS supplier
    FROM pur_receipt_lines rl JOIN pur_receipts r ON r.id = rl.receipt_id JOIN pur_order_lines ol ON ol.id = rl.order_line_id JOIN pur_orders o ON o.id = r.order_id JOIN suppliers s ON s.id = o.supplier_id
    WHERE r.org_id = ? AND rl.insp_pending > 0 ORDER BY r.date, rl.id`).all(req.org.id);
  res.json({ inspections: rows.map((l) => ({ receiptLineId: Number(l.id), description: l.description, receipt: l.receipt, order: l.order_number, supplier: l.supplier, date: l.date, lotNo: l.lot_no || null, expiry: l.expiry || null, pending: Number(l.insp_pending), unit: l.unit })) });
});
router.post('/inspections', mgr, async (req, res) => {
  const list = Array.isArray((req.body || {}).lines) ? req.body.lines : [];
  const touched = new Set();
  await db.transaction(async () => {
    for (const x of list) {
      const rl = await db.prepare(`SELECT rl.*, ol.item_id, ol.unit_price, ol.description, r.number AS receipt, r.order_id, r.org_id FROM pur_receipt_lines rl JOIN pur_receipts r ON r.id = rl.receipt_id JOIN pur_order_lines ol ON ol.id = rl.order_line_id WHERE rl.id = ? AND r.org_id = ?`).get(A.id(x && x.receiptLineId), req.org.id);
      if (!rl) throw new HttpError(404, 'Ligne de contrôle introuvable.');
      const acc = P.qtyOf(x.acceptedQty || 0, { zero: true }); const rej = P.qtyOf(x.rejectedQty || 0, { zero: true });
      if (!acc && !rej) continue;
      if (P.round3(acc + rej) > Number(rl.insp_pending) + 1e-9) throw new HttpError(400, `« ${rl.description} » : ${rl.insp_pending} en attente de contrôle au plus.`);
      const reason = cleanText(String(x.reason || ''), 200);
      if (rej && !reason) throw new HttpError(400, `Indiquez le motif du refus pour « ${rl.description} ».`);
      const o = await db.prepare('SELECT * FROM pur_orders WHERE id = ?').get(rl.order_id);
      if (rl.item_id) {
        const W = require('./wms-core');
        const q = await W.quarantineOf(req.org.id);
        // Accepté : sort de quarantaine vers l'emplacement choisi (sinon règles de rangement). Refusé : sort du stock (retour au fournisseur).
        if (acc) {
          const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(rl.item_id);
          const dests = x.toLocationId ? [{ location: await W.locationOf(req.org.id, A.id(x.toLocationId)), quantity: acc }] : await W.destinationsFor(req.org.id, it, acc);
          for (const d of dests) await W.move(req, rl.item_id, q.id, d.location.id, d.quantity, { kind: 'internal', refKind: 'pur_receipt', refId: rl.receipt_id, reason: `Contrôle qualité ${rl.receipt} : libéré` });
        }
        if (rej) await L.adjust(req, rl.item_id, -rej, `Contrôle qualité ${rl.receipt} : refusé (${reason})`, { locationId: q.id, refKind: 'pur_receipt', refId: rl.receipt_id, allowExpired: true });
      }
      await db.prepare('UPDATE pur_receipt_lines SET insp_pending = ?, insp_accepted = insp_accepted + ?, insp_rejected = insp_rejected + ?, insp_reason = ?, insp_at = ? WHERE id = ?')
        .run(P.round3(Number(rl.insp_pending) - acc - rej), acc, rej, reason || rl.insp_reason, nowISO(), rl.id);
      touched.add(Number(rl.order_id));
    }
  })();
  for (const id of touched) await refreshStatus(await db.prepare('SELECT * FROM pur_orders WHERE id = ?').get(id));
  res.json({ ok: true });
});

module.exports = router;
module.exports.refreshStatus = refreshStatus;
