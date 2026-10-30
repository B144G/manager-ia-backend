'use strict';
// Prix et négociation, CÔTÉ SERVEUR : un seul point de calcul, priceFor(org, item, customer, qty), utilisé par le devis/facture, l'assistant commercial et l'API.
// Il renvoie : prix de liste, plancher, prix de référence (ce qui revient déjà au client : palier, prix négocié, remise client), meilleur prix autorisé,
// dernier prix payé par ce client (d'après ses factures), paliers de concession successifs et la raison.
// Règles :
// - Plancher = le plus strict de « prix plancher » et « liste moins la remise maximale ». Aucun des deux renseigné = article NON négociable.
// - Meilleur prix autorisé = plancher si l'article est négociable (jamais au-dessus du prix de référence), sinon prix de référence.
// - L'IA ne décide jamais d'un prix : elle propose, le serveur valide (voir negotiation.js). Un vendeur ne peut pas descendre sous le plancher,
//   sauf un administrateur avec un motif obligatoire (tracé dans le journal de négociation et le journal d'audit).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, stripAccents, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const today = () => nowISO().slice(0, 10);
const norm = (s) => stripAccents(String(s || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
const roundUp5 = (n) => Math.ceil(n / 5) * 5;

/** Paliers de quantité : [{min, price}] triés par quantité ; le texte JSON de la base est lu sans jamais planter. */
function readTiers(v) {
  let a = [];
  try { a = JSON.parse(v || '[]'); } catch { a = []; }
  return (Array.isArray(a) ? a : []).map((t) => ({ min: Number(t && t.min), price: Number(t && t.price) })).filter((t) => t.min >= 2 && t.price > 0).sort((x, y) => x.min - y.min);
}
/** Valide les paliers saisis : quantités croissantes (2 au moins), prix décroissants, sous le prix de liste et au moins égaux au plancher. */
function cleanTiers(v, list, floor) {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v) || v.length > 8) throw new HttpError(400, 'Paliers de quantité : 8 au plus.');
  const out = v.map((t) => ({ min: A.qty(t && t.min), price: A.amount(t && t.price) }));
  out.sort((x, y) => x.min - y.min);
  let prev = list;
  out.forEach((t, i) => {
    if (t.min < 2 || !Number.isInteger(t.min)) throw new HttpError(400, 'Un palier commence à 2 unités au moins (nombre entier).');
    if (i && t.min === out[i - 1].min) throw new HttpError(400, 'Deux paliers ont la même quantité.');
    if (t.price >= prev) throw new HttpError(400, 'Le prix de chaque palier doit être inférieur au précédent et au prix de liste.');
    if (floor > 0 && t.price < floor) throw new HttpError(400, `Le prix d'un palier (${t.price}) ne peut pas être inférieur au plancher (${floor}).`);
    prev = t.price;
  });
  return out;
}

/** Plancher effectif d'un article : 0 = non négociable. */
function floorOf(item) {
  const list = Number(item.price); const f = Number(item.floor_price) || 0; const d = Number(item.max_discount) || 0;
  const c = [];
  if (f > 0) c.push(f);
  if (d > 0) c.push(Math.ceil(list * (1 - Math.min(d, 100) / 100)));
  return c.length ? Math.max(...c) : 0;
}

/** Paliers de concession successifs entre le prix de référence et le meilleur prix (n étapes, dernier = meilleur prix). */
function stepsFor(reference, best, n) {
  if (!(best < reference) || n < 1) return [];
  const out = [];
  for (let k = 1; k <= n; k++) {
    let p = k === n ? best : Math.max(best, roundUp5(reference - (reference - best) * k / n));
    if (out.length && p >= out[out.length - 1]) continue;
    if (p >= reference) continue;
    out.push(p);
  }
  if (out[out.length - 1] !== best) out.push(best);
  return out;
}

/** Dernier prix payé par ce client pour cet article (ligne de facture envoyée ou payée, la plus récente). */
async function lastPaid(orgId, customerId, item) {
  if (!customerId) return null;
  const want = norm(item.name);
  const rows = await db.prepare("SELECT number, issued, lines FROM documents WHERE org_id = ? AND customer_id = ? AND kind = 'invoice' AND status IN ('sent','paid') ORDER BY issued DESC, id DESC LIMIT 30").all(orgId, customerId);
  for (const d of rows) {
    let ls = []; try { ls = JSON.parse(d.lines); } catch { ls = []; }
    const l = ls.find((x) => (x.itemId && Number(x.itemId) === Number(item.id)) || norm(x.label) === want);
    if (l && Number(l.price) > 0) return { price: Number(l.price), number: d.number, date: d.issued };
  }
  return null;
}

/**
 * Point de calcul unique. `customer` : ligne customers (ou null), `qty` : quantité demandée, `n` : nombre d'étapes de concession (réglage de l'organisation).
 * Les prix sont des unités entières de la monnaie de l'organisation.
 */
async function priceFor(org, item, customer, qty = 1, n = 3) {
  const q = Number(qty) > 0 ? Number(qty) : 1;
  const list = Number(item.price);
  const floor = floorOf(item);
  const tiers = readTiers(item.tiers);
  const tier = tiers.filter((t) => q >= t.min).sort((a, b) => a.price - b.price)[0] || null;
  let cp = null;
  if (customer) {
    const r = await db.prepare('SELECT * FROM customer_prices WHERE org_id = ? AND customer_id = ? AND item_id = ?').get(org.id, customer.id, item.id);
    if (r && (!r.valid_until || r.valid_until >= today())) cp = r;
  }
  const disc = customer ? Math.min(Math.max(Number(customer.default_discount) || 0, 0), 100) : 0;
  const cands = [{ price: list, why: 'liste', label: 'prix de liste' }];
  if (tier) cands.push({ price: tier.price, why: 'palier', label: `palier de quantité (à partir de ${tier.min})` });
  if (disc > 0) cands.push({ price: Math.round(list * (1 - disc / 100)), why: 'remise_client', label: `remise du client (${disc} %)` });
  if (cp) cands.push({ price: Number(cp.price), why: 'prix_client', label: 'prix négocié pour ce client' });
  const prio = { prix_client: 0, palier: 1, remise_client: 2, liste: 3 };
  cands.sort((a, b) => a.price - b.price || prio[a.why] - prio[b.why]);
  const ref = cands[0];
  const negotiable = floor > 0 && floor < ref.price;
  const best = negotiable ? floor : ref.price;
  const lp = await lastPaid(org.id, customer && customer.id, item);
  return {
    itemId: Number(item.id), name: item.name, quantity: q, list, floor: floor || null, negotiable,
    tierPrice: tier ? tier.price : null, tierMin: tier ? tier.min : null,
    customerPrice: cp ? { price: Number(cp.price), validUntil: cp.valid_until || null, note: cp.note } : null,
    customerDiscount: disc || null, lastPaid: lp,
    reference: ref.price, best, reason: ref.label, reasonCode: ref.why,
    steps: negotiable ? stepsFor(ref.price, best, Math.max(1, Math.min(Number(n) || 3, 10))) : [],
    discountPct: list > 0 ? Math.round((1 - ref.price / list) * 1000) / 10 : 0,
  };
}

const catalogAll = async (orgId) => await db.prepare('SELECT * FROM catalog WHERE org_id = ?').all(orgId);
/** Retrouve l'article du catalogue d'une ligne de devis/facture : par identifiant, sinon par nom exact (sans accents ni casse). */
function matchItem(items, line) {
  if (line.itemId) { const h = items.find((i) => Number(i.id) === Number(line.itemId)); if (h) return h; }
  const w = norm(line.label);
  return w ? items.find((i) => norm(i.name) === w) : null;
}

/**
 * Contrôle des lignes d'un devis ou d'une facture. Retourne la liste des lignes sous le plancher.
 * `override` : { reason } d'un administrateur. Sans motif, ou sans être administrateur, la saisie est refusée.
 */
async function guardLines(req, customer, lines, override, docLabel = '') {
  const items = await catalogAll(req.org.id);
  if (!items.length) return [];
  const bad = [];
  for (const l of lines) {
    if (!(Number(l.price) > 0)) continue;
    const it = matchItem(items, l);
    if (!it || !floorOf(it)) continue;
    const pf = await priceFor(req.org, it, customer, l.quantity);
    if (l.price < pf.best) bad.push({ label: l.label, price: l.price, minimum: pf.best, itemId: it.id, quantity: l.quantity });
  }
  if (!bad.length) return [];
  const reason = override && A.text(override.reason, 300);
  if (!A.can(req, 'admin')) throw new HttpError(403, `Prix sous le plancher pour « ${bad[0].label} » (minimum ${bad[0].minimum}). Seul un administrateur peut accepter ce prix, avec un motif.`);
  if (!reason) throw new HttpError(422, `Prix sous le plancher pour « ${bad[0].label} » (minimum ${bad[0].minimum}). Indiquez le motif de cette exception pour continuer.`);
  for (const b of bad) {
    await db.prepare("INSERT INTO neg_log (org_id, doc_id, item_id, item_label, actor, kind, price, quantity, note, user_id, created_at) VALUES (?, NULL, ?, ?, 'human', 'override', ?, ?, ?, ?, ?)")
      .run(req.org.id, b.itemId, oneLine(b.label, 150), b.price, b.quantity, oneLine(`${docLabel ? docLabel + ' : ' : ''}sous le plancher (minimum ${b.minimum}) : ${reason}`, 300), req.user.id, nowISO());
  }
  await W.audit(req, 'price_override', null, 'floor', null, { lines: bad.map((b) => ({ label: b.label, price: b.price, minimum: b.minimum })), reason });
  return bad;
}

// ---------- Routes : suggestions, prix par client, remise client, opposition aux relances ----------
const customerOf = async (req, id) => {
  const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!c || !A.visible(req, c)) throw new HttpError(404, 'Client introuvable.');
  return c;
};
const stepsCount = async (orgId) => { const r = await db.prepare('SELECT max_counters FROM neg_settings WHERE org_id = ?').get(orgId); return r ? Number(r.max_counters) : 3; };

// Suggestion de prix à la saisie d'une ligne : ?customerId=&itemId=|label=&quantity=
router.get('/price-suggest', A.need('manager'), async (req, res) => {
  const items = await catalogAll(req.org.id);
  const it = req.query.itemId ? items.find((i) => Number(i.id) === Number(req.query.itemId)) : matchItem(items, { label: req.query.label });
  if (!it) return res.json({ found: false });
  const c = req.query.customerId ? await customerOf(req, req.query.customerId) : null;
  const pf = await priceFor(req.org, it, c, Number(req.query.quantity) || 1, await stepsCount(req.org.id));
  const { steps, ...out } = pf;
  res.json({ found: true, ...out, canOverride: A.can(req, 'admin') });
});

const cpView = (r) => ({ itemId: r.item_id, item: r.item, price: Number(r.price), list: r.list === undefined ? undefined : Number(r.list), validUntil: r.valid_until || null, note: r.note, expired: Boolean(r.valid_until && r.valid_until < today()), at: r.created_at });
router.get('/customers/:id/prices', A.need('manager'), async (req, res) => {
  const c = await customerOf(req, req.params.id);
  const rows = await db.prepare('SELECT p.*, i.name AS item, i.price AS list FROM customer_prices p JOIN catalog i ON i.id = p.item_id WHERE p.customer_id = ? ORDER BY i.name').all(c.id);
  res.json({ defaultDiscount: Number(c.default_discount) || 0, followupOptout: Boolean(c.followup_optout), prices: rows.map(cpView) });
});
router.put('/customers/:id/discount', A.need('manager'), async (req, res) => {
  const c = await customerOf(req, req.params.id);
  const n = Number(String((req.body || {}).discount).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 90) throw new HttpError(400, 'Remise client invalide : un pourcentage entre 0 et 90.');
  const v = Math.round(n * 10) / 10;
  await db.prepare('UPDATE customers SET default_discount = ? WHERE id = ?').run(v, c.id);
  await W.audit(req, 'customer_discount', c.id, 'update', { discount: c.default_discount }, { discount: v });
  res.json({ ok: true, defaultDiscount: v });
});
router.put('/customers/:id/prices/:itemId', A.need('manager'), async (req, res) => {
  const c = await customerOf(req, req.params.id);
  const it = await db.prepare('SELECT * FROM catalog WHERE id = ? AND org_id = ?').get(A.id(req.params.itemId), req.org.id);
  if (!it) throw new HttpError(404, 'Article introuvable.');
  const b = req.body || {};
  const price = A.amount(b.price);
  const until = A.date(b.validUntil);
  if (until && until < today()) throw new HttpError(400, 'La date de fin de validité est déjà passée.');
  const floor = floorOf(it);
  if (floor && price < floor) {
    if (!A.can(req, 'admin')) throw new HttpError(403, `Ce prix (${price}) est sous le plancher de l'article (${floor}) : seul un administrateur peut l'accepter, avec un motif.`);
    const reason = A.text(b.reason, 300);
    if (!reason) throw new HttpError(422, `Ce prix (${price}) est sous le plancher de l'article (${floor}) : indiquez le motif de l'exception.`);
    await db.prepare("INSERT INTO neg_log (org_id, item_id, item_label, actor, kind, price, note, user_id, created_at) VALUES (?, ?, ?, 'human', 'override', ?, ?, ?, ?)").run(req.org.id, it.id, oneLine(it.name, 150), price, oneLine(`prix client ${c.name} sous le plancher (${floor}) : ${reason}`, 300), req.user.id, nowISO());
  }
  await db.prepare(`INSERT INTO customer_prices (org_id, customer_id, item_id, price, valid_until, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (customer_id, item_id) DO UPDATE SET price = EXCLUDED.price, valid_until = EXCLUDED.valid_until, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`).run(req.org.id, c.id, it.id, price, until, A.text(b.note, 200), req.user.id, nowISO());
  await W.audit(req, 'customer_price', c.id, 'set', null, { item: it.name, price, until });
  res.json({ ok: true });
});
router.delete('/customers/:id/prices/:itemId', A.need('manager'), async (req, res) => {
  const c = await customerOf(req, req.params.id);
  const r = await db.prepare('DELETE FROM customer_prices WHERE customer_id = ? AND item_id = ? AND org_id = ?').run(c.id, A.id(req.params.itemId), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Prix introuvable.');
  res.json({ ok: true });
});
// Opposition d'un client aux relances (à sa demande) ou reprise.
router.put('/customers/:id/followup-optout', A.need('manager'), async (req, res) => {
  const c = await customerOf(req, req.params.id);
  const on = (req.body || {}).optout ? 1 : 0;
  await db.prepare('UPDATE customers SET followup_optout = ?, followup_optout_at = ? WHERE id = ?').run(on, nowISO(), c.id);
  await W.audit(req, 'followup_optout', c.id, on ? 'optout' : 'optin', { optout: c.followup_optout }, { optout: on });
  res.json({ ok: true, followupOptout: Boolean(on) });
});

module.exports = { router, priceFor, floorOf, stepsFor, readTiers, cleanTiers, matchItem, guardLines, norm, lastPaid };
