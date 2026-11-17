'use strict';
// Transport (TMS) — coûts et tarifs. Monté par logistics.js. Réservé aux responsables, sauf la saisie des frais de route par le chauffeur.
//  - Grilles tarifaires : par transporteur (ou flotte propre), zone, tranche de poids ; base, prix au kg, au km, par palette,
//    minimum de perception, surcharge carburant (%). Devis d'une livraison ou d'une course libre.
//  - Coûts réels d'une tournée (carburant, péages, indemnités, stationnement, réparations…), validation : répartition sur les livraisons
//    au prorata du poids et écriture comptable (charges / caisse, banque ou mobile money).
//  - Factures des transporteurs rapprochées des livraisons : coût attendu (grille) contre montant facturé, écarts signalés
//    (au-delà de la tolérance), doublons, livraisons d'un autre transporteur ou non livrées ; validation → écriture d'achat (612 / 4454 / 401).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const T = require('./tms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const LG = () => require('./logistics');
const TM = () => require('./tms');
const acc = () => require('./accounting');
const today = () => nowISO().slice(0, 10);
const COST_KINDS = { fuel: 'Carburant', toll: 'Péage', allowance: 'Indemnité du chauffeur', parking: 'Stationnement', repair: 'Réparation', handling: 'Manutention', other: 'Autre frais' };
const COST_ACCOUNT = { fuel: '6042', toll: '618', allowance: '663', parking: '618', repair: '624', handling: '618', other: '618' };
const PAY_JOURNAL = { 571: 'CA', 521: 'BQ', 589: 'MM' };
const INV_STATUS = { draft: 'À vérifier', approved: 'Validée', cancelled: 'Annulée' };
const FLAG_TEXT = { ok: 'Conforme', over: 'Facturé plus que prévu', under: 'Facturé moins que prévu', no_rate: 'Aucun tarif pour cette livraison', other_carrier: "Livraison confiée à un autre transporteur", not_delivered: "Livraison non livrée", duplicate: 'Déjà facturée', no_delivery: 'Ligne sans livraison' };
const money = (v, msg) => { if (v === undefined || v === null || v === '' || Number(v) === 0) return 0; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new HttpError(400, msg || 'Montant invalide.'); return Math.round(n); };
const num = (v, msg, max = 1e9) => { if (v === undefined || v === null || v === '') return 0; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, msg); return n; };

// ---------- Grilles tarifaires ----------
const cardView = (c) => ({ id: c.id, name: c.name, carrierId: c.carrier_id, zoneId: c.zone_id, minKg: Number(c.min_kg || 0), maxKg: c.max_kg === null ? null : Number(c.max_kg), base: Number(c.base), perKg: Number(c.per_kg), perKm: Number(c.per_km),
  perPallet: Number(c.per_pallet), minCharge: Number(c.min_charge), fuelPct: Number(c.fuel_pct), validFrom: c.valid_from, validTo: c.valid_to, active: Number(c.active), carrier: c.carrier || null, zone: c.zone || null });
async function cardsOf(orgId) { return (await db.prepare('SELECT c.*, k.name AS carrier, z.name AS zone FROM logistics_rate_cards c LEFT JOIN logistics_carriers k ON k.id = c.carrier_id LEFT JOIN logistics_zones z ON z.id = c.zone_id WHERE c.org_id = ? ORDER BY k.name NULLS FIRST, z.name NULLS FIRST, c.min_kg, c.id').all(orgId)).map(cardView); }

router.get('/tms/rates', mgr, async (req, res) => res.json({ rates: await cardsOf(req.org.id) }));
async function cardFields(req, b, cur) {
  const has = (k) => b[k] !== undefined; const c = cur ? cardView(cur) : {};
  const f = {
    name: has('name') || !cur ? A.text(b.name, 100, { required: true, msg: 'Donnez un nom à la grille.' }) : c.name,
    carrierId: has('carrierId') ? (b.carrierId ? (await LG().one(req, 'logistics_carriers', b.carrierId, 'Transporteur')).id : null) : c.carrierId || null,
    zoneId: has('zoneId') ? (b.zoneId ? (await LG().one(req, 'logistics_zones', b.zoneId, 'Zone')).id : null) : c.zoneId || null,
    minKg: has('minKg') ? num(b.minKg, 'Poids minimum invalide.', 1e6) : c.minKg || 0, maxKg: has('maxKg') ? (b.maxKg === '' || b.maxKg === null ? null : num(b.maxKg, 'Poids maximum invalide.', 1e6)) : (cur ? c.maxKg : null),
    base: has('base') ? money(b.base, 'Prix de base invalide.') : c.base || 0, perKg: has('perKg') ? money(b.perKg, 'Prix au kg invalide.') : c.perKg || 0, perKm: has('perKm') ? money(b.perKm, 'Prix au km invalide.') : c.perKm || 0,
    perPallet: has('perPallet') ? money(b.perPallet, 'Prix par palette invalide.') : c.perPallet || 0, minCharge: has('minCharge') ? money(b.minCharge, 'Minimum de perception invalide.') : c.minCharge || 0,
    fuelPct: has('fuelPct') ? num(b.fuelPct, 'Surcharge carburant invalide (0 à 100 %).', 100) : c.fuelPct || 0,
    validFrom: has('validFrom') ? A.date(b.validFrom) : c.validFrom || null, validTo: has('validTo') ? A.date(b.validTo) : c.validTo || null, active: has('active') ? (b.active === false || b.active === 0 || b.active === 'no' ? 0 : 1) : (cur ? c.active : 1),
  };
  if (f.maxKg !== null && f.maxKg <= f.minKg) throw new HttpError(400, 'La tranche de poids doit finir au-dessus de son début.');
  if (f.validFrom && f.validTo && f.validTo < f.validFrom) throw new HttpError(400, 'La fin de validité précède le début.');
  if (!f.base && !f.perKg && !f.perKm && !f.perPallet && !f.minCharge) throw new HttpError(400, 'Indiquez au moins un prix (base, au kg, au km, par palette ou minimum).');
  return f;
}
router.post('/tms/rates', mgr, async (req, res) => {
  const f = await cardFields(req, req.body || {}, null);
  const id = Number((await db.prepare('INSERT INTO logistics_rate_cards (org_id, name, carrier_id, zone_id, min_kg, max_kg, base, per_kg, per_km, per_pallet, min_charge, fuel_pct, valid_from, valid_to, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, f.name, f.carrierId, f.zoneId, f.minKg, f.maxKg, f.base, f.perKg, f.perKm, f.perPallet, f.minCharge, f.fuelPct, f.validFrom, f.validTo, f.active, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.put('/tms/rates/:id', mgr, async (req, res) => {
  const cur = await LG().one(req, 'logistics_rate_cards', req.params.id, 'Grille tarifaire');
  const f = await cardFields(req, req.body || {}, cur);
  await db.prepare('UPDATE logistics_rate_cards SET name = ?, carrier_id = ?, zone_id = ?, min_kg = ?, max_kg = ?, base = ?, per_kg = ?, per_km = ?, per_pallet = ?, min_charge = ?, fuel_pct = ?, valid_from = ?, valid_to = ?, active = ? WHERE id = ?')
    .run(f.name, f.carrierId, f.zoneId, f.minKg, f.maxKg, f.base, f.perKg, f.perKm, f.perPallet, f.minCharge, f.fuelPct, f.validFrom, f.validTo, f.active, cur.id);
  res.json({ ok: true });
});
router.delete('/tms/rates/:id', mgr, async (req, res) => {
  const cur = await LG().one(req, 'logistics_rate_cards', req.params.id, 'Grille tarifaire');
  await db.prepare('DELETE FROM logistics_rate_cards WHERE id = ?').run(cur.id);
  res.json({ ok: true });
});

/** Distance dépôt → livraison (km) : GPS (haversine × coefficient routier) ou « distance depuis le dépôt » de sa zone. */
async function kmOf(orgId, d) {
  const s = await TM().settings(orgId); const ctx = await TM().ctxOf(orgId, s);
  return T.distanceFn(ctx)(TM().depotOf(s), TM().pointOf(d, ctx));
}
/** Devis d'une livraison (ligne de la base) pour un transporteur (ou la flotte propre). null si aucune grille ne s'applique. */
async function quoteDelivery(req, d, { carrierId = null, cards } = {}) {
  cards = cards || await cardsOf(req.org.id);
  const card = T.pickCard(cards, { carrierId, zoneId: d.zone_id, weight: d.weight_kg, date: d.planned_date || today() });
  if (!card) return null;
  const km = await kmOf(req.org.id, d);
  const p = T.priceOf(card, { weight: Number(d.weight_kg || 0), km: km || 0, pallets: Number(d.pallets || 0) });
  return { cardId: card.id, card: card.name, km, kmKnown: km !== null, weight: Number(d.weight_kg || 0), pallets: Number(d.pallets || 0), ...p };
}
router.post('/tms/rates/quote', mgr, async (req, res) => {
  const b = req.body || {};
  const zone = b.zoneId ? (await LG().one(req, 'logistics_zones', b.zoneId, 'Zone')).id : null;
  const carrierId = b.carrierId ? (await LG().one(req, 'logistics_carriers', b.carrierId, 'Transporteur')).id : null;
  const fake = { id: 0, zone_id: zone, weight_kg: num(b.weight, 'Poids invalide.', 1e6), pallets: num(b.pallets, 'Nombre de palettes invalide.', 1000), lat: b.lat === '' ? null : b.lat ?? null, lng: b.lng === '' ? null : b.lng ?? null, planned_date: A.date(b.date) || today() };
  const cards = await cardsOf(req.org.id);
  const card = T.pickCard(cards, { carrierId, zoneId: zone, weight: fake.weight_kg, date: fake.planned_date });
  if (!card) throw new HttpError(404, 'Aucune grille tarifaire ne correspond (transporteur, zone, poids, dates).');
  const km = b.km !== undefined && b.km !== '' ? num(b.km, 'Distance invalide (km).', 1e5) : await kmOf(req.org.id, fake);
  res.json({ quote: { cardId: card.id, card: card.name, km, kmKnown: km !== null, ...T.priceOf(card, { weight: fake.weight_kg, km: km || 0, pallets: fake.pallets }) } });
});
router.get('/tms/deliveries/:id/cost', mgr, async (req, res) => {
  const d = await LG().delOf(req, req.params.id);
  const q = await quoteDelivery(req, d, { carrierId: d.carrier_id });
  if (q) await db.prepare('UPDATE logistics_deliveries SET est_cost = ? WHERE id = ?').run(q.total, d.id);
  const lines = await db.prepare("SELECT l.amount, i.number, i.status FROM logistics_carrier_invoice_lines l JOIN logistics_carrier_invoices i ON i.id = l.invoice_id WHERE l.delivery_id = ? AND i.status <> 'cancelled'").all(d.id);
  res.json({ quote: q, allocated: Number(d.alloc_cost || 0), invoiced: lines.map((l) => ({ number: l.number, status: l.status, amount: Number(l.amount) })) });
});

// ---------- Coûts réels d'une tournée ----------
router.get('/tms/trips/:id/costs', async (req, res) => {
  const r = await TM().tripOf(req, req.params.id);
  if (!A.can(req, 'manager') && !(r.driver_id && await db.prepare('SELECT 1 FROM logistics_drivers WHERE id = ? AND user_id = ?').get(r.driver_id, req.user.id))) throw new HttpError(403, "Votre rôle ne permet pas cette action.");
  const rows = await db.prepare('SELECT * FROM logistics_trip_costs WHERE round_id = ? ORDER BY id').all(r.id);
  res.json({ costs: rows.map((c) => ({ id: c.id, kind: c.kind, kindLabel: COST_KINDS[c.kind], label: c.label, amount: Number(c.amount), createdAt: c.created_at })), total: rows.reduce((a, c) => a + Number(c.amount), 0), approved: Boolean(r.costs_approved_at), kinds: COST_KINDS, estCost: A.can(req, 'manager') ? Number(r.est_cost || 0) : undefined });
});
router.post('/tms/trips/:id/costs', async (req, res) => {
  const r = await TM().tripOf(req, req.params.id);
  const driver = r.driver_id && await db.prepare('SELECT 1 FROM logistics_drivers WHERE id = ? AND user_id = ?').get(r.driver_id, req.user.id);
  if (!A.can(req, 'manager') && !driver) throw new HttpError(403, 'Seuls le chauffeur de la tournée et les responsables saisissent ses frais.');
  if (r.costs_approved_at) throw new HttpError(400, 'Les frais de cette tournée sont déjà validés.');
  if (r.status === 'cancelled') throw new HttpError(400, 'Cette tournée est annulée.');
  const b = req.body || {};
  const kind = A.oneOf(b.kind, Object.keys(COST_KINDS), undefined, 'Type de frais inconnu.');
  const amount = A.amount(b.amount);
  const id = Number((await db.prepare('INSERT INTO logistics_trip_costs (org_id, round_id, kind, label, amount, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, r.id, kind, A.text(b.label, 120), amount, req.user.id, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.delete('/tms/trip-costs/:id', mgr, async (req, res) => {
  const c = await LG().one(req, 'logistics_trip_costs', req.params.id, 'Frais');
  const r = await TM().tripOf(req, c.round_id);
  if (r.costs_approved_at) throw new HttpError(400, 'Les frais de cette tournée sont déjà validés.');
  await db.prepare('DELETE FROM logistics_trip_costs WHERE id = ?').run(c.id);
  res.json({ ok: true });
});
/**
 * Validation des frais réels : chaque livraison de la tournée reçoit sa part (au prorata du poids, à parts égales si aucun poids),
 * puis une écriture : débit des comptes de charges par nature (6042 carburant, 618 péages et frais, 663 indemnités, 624 réparations),
 * crédit du compte de règlement (571 caisse par défaut, 521 banque, 589 mobile money). Une seule écriture par tournée.
 */
router.post('/tms/trips/:id/costs/approve', mgr, async (req, res) => {
  const r = await TM().tripOf(req, req.params.id);
  if (r.costs_approved_at) throw new HttpError(400, 'Les frais de cette tournée sont déjà validés.');
  if (r.status !== 'done') throw new HttpError(400, 'Terminez la tournée avant de valider ses frais.');
  const rows = await db.prepare('SELECT * FROM logistics_trip_costs WHERE round_id = ? ORDER BY id').all(r.id);
  if (!rows.length) throw new HttpError(400, 'Aucun frais saisi pour cette tournée.');
  const b = req.body || {};
  const account = A.oneOf(String(b.account || '571'), Object.keys(PAY_JOURNAL), '571', 'Compte de règlement inconnu (571, 521 ou 589).');
  const total = rows.reduce((a, c) => a + Number(c.amount), 0);
  const stops = await db.prepare('SELECT id, weight_kg FROM logistics_deliveries WHERE round_id = ? ORDER BY round_pos, id').all(r.id);
  const shares = T.allocate(total, stops.map((d) => Number(d.weight_kg || 0)));
  const byAcc = {};
  for (const c of rows) byAcc[COST_ACCOUNT[c.kind]] = (byAcc[COST_ACCOUNT[c.kind]] || 0) + Number(c.amount);
  let entry = null;
  await db.transaction(async () => {
    for (const [i, d] of stops.entries()) await db.prepare('UPDATE logistics_deliveries SET alloc_cost = ? WHERE id = ?').run(shares[i], d.id);
    const lines = Object.entries(byAcc).map(([a, v]) => ({ account: a, debit: v, memo: `Tournée ${r.name}` })).concat([{ account, credit: total, memo: `Frais de tournée ${r.name}` }]);
    entry = await acc().recordEntry(req.org, req.user.id, { journal: PAY_JOURNAL[account], date: r.date, label: `Frais de tournée : ${r.name}`.slice(0, 200), piece: `TRN-${r.id}`, lines, source: 'tms_trip', sourceId: r.id });
    await db.prepare('UPDATE logistics_rounds SET costs_entry_id = ?, costs_approved_at = ? WHERE id = ?').run(entry.id, nowISO(), r.id);
  })();
  res.json({ ok: true, total, entry: { id: entry.id, number: entry.number }, allocation: stops.map((d, i) => ({ deliveryId: d.id, amount: shares[i] })) });
});

// ---------- Factures des transporteurs ----------
const invOf = async (req, id) => {
  const i = await db.prepare('SELECT * FROM logistics_carrier_invoices WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!i) throw new HttpError(404, 'Facture introuvable.');
  return i;
};
/** Rapprochement d'une ligne : coût attendu (grille du transporteur), écart au-delà de la tolérance max(pourcentage, montant minimum). */
async function checkLine(req, inv, line, s, cards) {
  if (!line.delivery_id) return { expected: null, flag: 'no_delivery' };
  const d = await db.prepare('SELECT * FROM logistics_deliveries WHERE id = ? AND org_id = ?').get(line.delivery_id, req.org.id);
  if (!d) return { expected: null, flag: 'no_delivery' };
  const dup = await db.prepare("SELECT i.number FROM logistics_carrier_invoice_lines l JOIN logistics_carrier_invoices i ON i.id = l.invoice_id WHERE l.delivery_id = ? AND i.id <> ? AND i.status <> 'cancelled' LIMIT 1").get(d.id, inv.id);
  const q = await quoteDelivery(req, d, { carrierId: inv.carrier_id, cards });
  const expected = q ? q.total : null;
  if (dup) return { expected, flag: 'duplicate', ref: dup.number };
  if (d.carrier_id && Number(d.carrier_id) !== Number(inv.carrier_id)) return { expected, flag: 'other_carrier' };
  if (!['delivered', 'returned', 'failed'].includes(d.status)) return { expected, flag: 'not_delivered' };
  if (expected === null) return { expected, flag: 'no_rate' };
  const tol = Math.max(Math.round((expected * Number(s.tolerance_pct)) / 100), Number(s.tolerance_min));
  const amt = Number(line.amount);
  return { expected, flag: amt > expected + tol ? 'over' : amt < expected - tol ? 'under' : 'ok', tolerance: tol };
}
async function rematch(req, inv) {
  const s = await TM().settings(req.org.id); const cards = await cardsOf(req.org.id);
  const lines = await db.prepare('SELECT * FROM logistics_carrier_invoice_lines WHERE invoice_id = ? ORDER BY id').all(inv.id);
  for (const l of lines) { const c = await checkLine(req, inv, l, s, cards); await db.prepare('UPDATE logistics_carrier_invoice_lines SET expected = ?, flag = ? WHERE id = ?').run(c.expected, c.flag, l.id); }
}
async function invView(req, i, { full = false } = {}) {
  const car = await db.prepare('SELECT name FROM logistics_carriers WHERE id = ?').get(i.carrier_id);
  const lines = await db.prepare('SELECT l.*, d.customer_name, d.planned_date, d.status AS dstatus FROM logistics_carrier_invoice_lines l LEFT JOIN logistics_deliveries d ON d.id = l.delivery_id WHERE l.invoice_id = ? ORDER BY l.id').all(i.id);
  const expected = lines.reduce((a, l) => a + Number(l.expected || 0), 0);
  const issues = lines.filter((l) => l.flag && l.flag !== 'ok').length;
  return { id: i.id, number: i.number, ref: i.ref, date: i.date, carrierId: i.carrier_id, carrier: car ? car.name : '', amountHt: Number(i.amount_ht), vat: Number(i.vat), total: Number(i.amount_ht) + Number(i.vat), status: i.status, statusLabel: INV_STATUS[i.status],
    expected, gap: Number(i.amount_ht) - expected, issues, entryId: i.entry_id, note: i.note, approvedAt: i.approved_at,
    lines: full ? lines.map((l) => ({ id: l.id, deliveryId: l.delivery_id, customerName: l.customer_name || null, date: l.planned_date || null, deliveryStatus: l.dstatus || null, label: l.label, amount: Number(l.amount), expected: l.expected === null ? null : Number(l.expected), gap: l.expected === null ? null : Number(l.amount) - Number(l.expected), flag: l.flag, flagLabel: FLAG_TEXT[l.flag] || '' })) : undefined };
}
router.get('/tms/carrier-invoices', mgr, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM logistics_carrier_invoices WHERE org_id = ? ORDER BY date DESC, id DESC LIMIT 200').all(req.org.id);
  const list = []; for (const i of rows) list.push(await invView(req, i));
  res.json({ invoices: list, statuses: INV_STATUS, flags: FLAG_TEXT });
});
router.get('/tms/carrier-invoices/:id', mgr, async (req, res) => res.json({ invoice: await invView(req, await invOf(req, req.params.id), { full: true }) }));
/** Livraisons d'un transporteur pas encore facturées (pour préparer le rapprochement). */
router.get('/tms/carriers/:id/unbilled', mgr, async (req, res) => {
  const c = await LG().one(req, 'logistics_carriers', req.params.id, 'Transporteur');
  const rows = await db.prepare(`SELECT d.* FROM logistics_deliveries d WHERE d.org_id = ? AND d.carrier_id = ? AND d.status IN ('delivered','returned','failed')
    AND NOT EXISTS (SELECT 1 FROM logistics_carrier_invoice_lines l JOIN logistics_carrier_invoices i ON i.id = l.invoice_id WHERE l.delivery_id = d.id AND i.status <> 'cancelled') ORDER BY d.planned_date, d.id LIMIT 300`).all(req.org.id, c.id);
  const cards = await cardsOf(req.org.id); const out = [];
  for (const d of rows) { const q = await quoteDelivery(req, d, { carrierId: c.id, cards }); out.push({ id: d.id, customerName: d.customer_name, date: d.planned_date, status: d.status, weight: Number(d.weight_kg || 0), expected: q ? q.total : null }); }
  res.json({ deliveries: out });
});
async function nextNumber(orgId) {
  const y = today().slice(0, 4);
  const n = Number((await db.prepare("SELECT COUNT(*) AS c FROM logistics_carrier_invoices WHERE org_id = ? AND number LIKE ?").get(orgId, `FT-${y}-%`)).c) + 1;
  return `FT-${y}-${String(n).padStart(4, '0')}`;
}
router.post('/tms/carrier-invoices', mgr, async (req, res) => {
  const b = req.body || {};
  const c = await LG().one(req, 'logistics_carriers', b.carrierId, 'Transporteur');
  const ref = A.text(b.ref, 60, { required: true, msg: 'Indiquez le numéro de la facture du transporteur.' });
  if (await db.prepare("SELECT 1 FROM logistics_carrier_invoices WHERE org_id = ? AND carrier_id = ? AND ref = ? AND status <> 'cancelled'").get(req.org.id, c.id, ref)) throw new HttpError(409, `La facture ${ref} de ce transporteur est déjà saisie.`);
  const date = A.date(b.date) || today();
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 300) throw new HttpError(400, 'Ajoutez les lignes de la facture (300 au plus).');
  const lines = []; const seen = new Set();
  for (const l of b.lines) {
    const amount = A.amount(l && l.amount);
    let did = null;
    if (l.deliveryId) { did = (await LG().delOf(req, l.deliveryId)).id; if (seen.has(did)) throw new HttpError(400, `La livraison #${did} apparaît deux fois sur la facture.`); seen.add(did); }
    lines.push({ did, amount, label: A.text(l.label, 120) });
  }
  const ht = lines.reduce((a, l) => a + l.amount, 0);
  const vat = money(b.vat, 'TVA invalide.');
  let id;
  await db.transaction(async () => {
    id = Number((await db.prepare("INSERT INTO logistics_carrier_invoices (org_id, carrier_id, number, ref, date, amount_ht, vat, status, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)").run(req.org.id, c.id, await nextNumber(req.org.id), ref, date, ht, vat, A.text(b.note, 300), req.user.id, nowISO())).lastInsertRowid);
    for (const l of lines) await db.prepare('INSERT INTO logistics_carrier_invoice_lines (invoice_id, delivery_id, label, amount) VALUES (?, ?, ?, ?)').run(id, l.did, l.label, l.amount);
    await rematch(req, { id, carrier_id: c.id });
  })();
  res.status(201).json({ invoice: await invView(req, await invOf(req, id), { full: true }) });
});
router.post('/tms/carrier-invoices/:id/rematch', mgr, async (req, res) => {
  const i = await invOf(req, req.params.id);
  if (i.status !== 'draft') throw new HttpError(400, 'Seule une facture à vérifier se rapproche à nouveau.');
  await rematch(req, i);
  res.json({ invoice: await invView(req, i, { full: true }) });
});
router.post('/tms/carrier-invoices/:id/approve', mgr, async (req, res) => {
  const i = await invOf(req, req.params.id);
  if (i.status !== 'draft') throw new HttpError(400, 'Cette facture est déjà validée ou annulée.');
  await rematch(req, i);
  const v = await invView(req, i, { full: true });
  const b = req.body || {};
  if (v.issues && !b.force) throw new HttpError(409, `${v.issues} ligne(s) à vérifier (${[...new Set(v.lines.filter((l) => l.flag !== 'ok').map((l) => l.flagLabel))].join(', ')}). Corrigez, ou validez quand même en expliquant pourquoi.`);
  const note = A.text(b.note, 300);
  if (v.issues && !note) throw new HttpError(400, 'Expliquez pourquoi vous validez malgré les écarts.');
  let entry;
  await db.transaction(async () => {
    const lines = [{ account: '612', debit: v.amountHt, memo: `Facture ${i.ref}` }];
    if (v.vat) lines.push({ account: '4454', debit: v.vat, memo: 'TVA récupérable sur services' });
    lines.push({ account: '401', credit: v.total, memo: v.carrier || 'Transporteur' });
    entry = await acc().recordEntry(req.org, req.user.id, { journal: 'AC', date: i.date, label: `Transport ${i.ref} - ${v.carrier}`.slice(0, 200), piece: i.number, lines: lines.filter((l) => (l.debit || l.credit) > 0), source: 'tms_carrier_invoice', sourceId: i.id });
    for (const l of v.lines) if (l.deliveryId) await db.prepare('UPDATE logistics_deliveries SET alloc_cost = ? WHERE id = ?').run(l.amount, l.deliveryId);
    await db.prepare("UPDATE logistics_carrier_invoices SET status = 'approved', entry_id = ?, approved_by = ?, approved_at = ?, note = CASE WHEN ? = '' THEN note ELSE ? END WHERE id = ?").run(entry.id, req.user.id, nowISO(), note, note, i.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'logistics', `Facture transporteur ${i.ref} validée`);
  res.json({ ok: true, entry: { id: entry.id, number: entry.number } });
});
router.post('/tms/carrier-invoices/:id/cancel', mgr, async (req, res) => {
  const i = await invOf(req, req.params.id);
  if (i.status === 'cancelled') throw new HttpError(400, 'Cette facture est déjà annulée.');
  await db.transaction(async () => {
    if (i.entry_id) await acc().reverseEntry(req.org, req.user.id, i.entry_id, today(), { source: 'tms_carrier_invoice_cancel', sourceId: i.id });
    if (i.status === 'approved') await db.prepare('UPDATE logistics_deliveries SET alloc_cost = 0 WHERE id IN (SELECT delivery_id FROM logistics_carrier_invoice_lines WHERE invoice_id = ? AND delivery_id IS NOT NULL)').run(i.id);
    await db.prepare("UPDATE logistics_carrier_invoices SET status = 'cancelled' WHERE id = ?").run(i.id);
  })();
  res.json({ ok: true });
});

module.exports = router;
Object.assign(module.exports, { quoteDelivery, cardsOf, COST_KINDS, FLAG_TEXT });
