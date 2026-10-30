'use strict';
// Sous-application « Logistique » : livraisons (liées ou non à une commande/facture), transporteurs, zones, tournées, retards, prévenir le client par WhatsApp.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const { HttpError, oneLine } = require('../util');

const money0 = (v) => (v === undefined || v === null || v === '' || Number(v) === 0 ? 0 : A.amount(v));
const router = express.Router({ mergeParams: true });
// Parc : véhicules, chauffeurs, échéances réglementaires, carburant (logistics-fleet.js)
const fleet = require('./logistics-fleet');
router.use(fleet);

const STATUSES = ['to_prepare', 'shipped', 'on_route', 'delivered', 'failed', 'returned'];
const STATUS_LABEL = { to_prepare: 'À préparer', shipped: 'Expédiée', on_route: 'En route', delivered: 'Livrée', failed: 'Échec', returned: 'Retournée' };
const OPEN = ['to_prepare', 'shipped', 'on_route'];
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const one = async (req, table, id, label) => {
  const r = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`).get(A.id(id), req.org.id);
  if (!r) throw new HttpError(404, `${label} introuvable.`);
  return r;
};
const optional = async (req, table, v, label) => (v === undefined || v === null || v === '' ? null : (await one(req, table, v, label)).id);
const delOf = async (req, id) => {
  const d = await one(req, 'logistics_deliveries', id, 'Livraison');
  if (!A.visible(req, d)) throw new HttpError(404, 'Livraison introuvable.');
  return d;
};

const isLate = (d) => OPEN.includes(d.status) && d.planned_date && d.planned_date < today();
const view = (d, names = {}) => ({
  id: d.id, docId: d.doc_id, docNumber: names.docNumber || null, customerName: d.customer_name, phone: d.phone, address: d.address, zoneId: d.zone_id, zone: names.zone || null,
  carrierId: d.carrier_id, carrier: names.carrier || null, roundId: d.round_id, roundPos: Number(d.round_pos), fee: Number(d.fee), plannedDate: d.planned_date, status: d.status,
  statusLabel: STATUS_LABEL[d.status], tracking: d.tracking, receivedBy: d.received_by, proof: d.proof, note: d.note, branchId: d.branch_id, late: isLate(d), createdAt: d.created_at, updatedAt: d.updated_at,
});
const BASE = `SELECT d.*, z.name AS zone_name, c.name AS carrier_name, o.number AS doc_number FROM logistics_deliveries d
  LEFT JOIN logistics_zones z ON z.id = d.zone_id LEFT JOIN logistics_carriers c ON c.id = d.carrier_id LEFT JOIN documents o ON o.id = d.doc_id`;
const names = (r) => ({ zone: r.zone_name, carrier: r.carrier_name, docNumber: r.doc_number });

// ---------- Pont avec le stock : expédier sort du stock, un retour le réintègre (une seule fois chacun) ----------
const itemsOf = async (deliveryId) => (await db.prepare('SELECT x.*, i.name, i.unit, i.tracking FROM logistics_delivery_items x JOIN stock_items i ON i.id = x.item_id WHERE x.delivery_id = ? ORDER BY x.id').all(deliveryId))
  .map((x) => ({ id: x.id, itemId: x.item_id, name: x.name, unit: x.unit, tracking: x.tracking, quantity: x.quantity, serials: JSON.parse(x.serials) }));

async function cleanItems(req, list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 40) throw new HttpError(400, 'Liste d\'articles invalide (40 au plus).');
  const seen = new Set(); const out = [];
  for (const x of list) {
    const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(x && x.itemId, 'Article invalide.'), req.org.id);
    if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable dans le stock.');
    if (seen.has(it.id)) throw new HttpError(400, `L'article « ${it.name} » apparaît deux fois.`);
    seen.add(it.id);
    const serials = it.tracking === 'serial' ? L.parseSerials(x.serials) : [];
    out.push({ itemId: it.id, quantity: it.tracking === 'serial' ? serials.length : A.qty(x.quantity), serials });
    if (it.tracking === 'serial' && !serials.length) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : indiquez les numéros expédiés.`);
  }
  return out;
}
async function saveItems(req, deliveryId, list) {
  await db.prepare('DELETE FROM logistics_delivery_items WHERE delivery_id = ?').run(deliveryId);
  for (const x of list) await db.prepare('INSERT INTO logistics_delivery_items (org_id, delivery_id, item_id, quantity, serials) VALUES (?, ?, ?, ?, ?)').run(req.org.id, deliveryId, x.itemId, x.quantity, JSON.stringify(x.serials));
}
/** Sortie (expédition) ou retour de stock d'une livraison. Dans la transaction du changement d'état. */
async function stockBridge(req, d, status) {
  const rows = await db.prepare('SELECT * FROM logistics_delivery_items WHERE delivery_id = ?').all(d.id);
  if (!rows.length) return '';
  if (['shipped', 'on_route', 'delivered'].includes(status) && (!d.stock_out || d.stock_back)) {
    for (const x of rows) {
      const r = await L.adjust(req, x.item_id, -x.quantity, `Expédition livraison #${d.id}`, { serials: JSON.parse(x.serials), refKind: 'delivery', refId: d.id });
      await db.prepare('UPDATE logistics_delivery_items SET allocations = ? WHERE id = ?').run(JSON.stringify(r.allocations), x.id);
    }
    await db.prepare('UPDATE logistics_deliveries SET stock_out = 1, stock_back = 0 WHERE id = ?').run(d.id);
    return 'Stock sorti';
  }
  if (status === 'returned' && d.stock_out && !d.stock_back) {
    for (const x of rows) await L.adjust(req, x.item_id, x.quantity, `Retour livraison #${d.id}`, { serials: JSON.parse(x.serials), allocations: JSON.parse(x.allocations), refKind: 'delivery', refId: d.id });
    await db.prepare('UPDATE logistics_deliveries SET stock_back = 1 WHERE id = ?').run(d.id);
    return 'Stock réintégré';
  }
  return '';
}

async function addEvent(req, d, status, note) {
  await db.prepare('INSERT INTO logistics_events (org_id, delivery_id, status, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, d, status, A.text(note, 300), req.user.id, nowISO());
}

// ---------- Tableau de bord ----------
router.get('/', async (req, res) => {
  const sc = A.scope(req, 'd.branch_id');
  const t = today();
  const m = A.monthRange();
  const all = (await db.prepare(`${BASE} WHERE d.org_id = ?${sc.sql} ORDER BY d.planned_date IS NULL, d.planned_date, d.id DESC LIMIT 500`).all(req.org.id, ...sc.args));
  const finished = all.filter((d) => ['delivered', 'failed', 'returned'].includes(d.status));
  const day = (d) => d.planned_date || d.created_at.slice(0, 10);
  res.json({
    summary: {
      today: all.filter((d) => d.planned_date === t && OPEN.includes(d.status)).length,
      late: all.filter(isLate).length,
      successRate: finished.length ? Math.round((100 * finished.filter((d) => d.status === 'delivered').length) / finished.length) : null,
      monthCost: all.filter((d) => day(d) >= m.from && day(d) < m.to && d.status !== 'returned').reduce((a, d) => a + Number(d.fee), 0),
      open: all.filter((d) => OPEN.includes(d.status)).length,
    },
    deliveries: all.map((d) => view(d, names(d))),
    statuses: STATUS_LABEL,
  });
});

// Commandes et factures qu'on peut lier à une livraison (sans les montants : réservés aux responsables).
router.get('/documents', async (req, res) => {
  const sc = A.scope(req, 'd.branch_id');
  const rows = await db.prepare(`SELECT d.id, d.kind, d.number, d.status, c.name AS customer, c.phone,
      (SELECT COUNT(*) FROM logistics_deliveries l WHERE l.doc_id = d.id) AS deliveries
    FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind IN ('order','invoice') AND d.status NOT IN ('cancelled','refused','draft')${sc.sql} ORDER BY d.id DESC LIMIT 100`).all(req.org.id, ...sc.args);
  res.json({ documents: rows.map((d) => ({ id: d.id, kind: d.kind, number: d.number, status: d.status, customer: d.customer, phone: d.phone, deliveries: Number(d.deliveries) })) });
});

// ---------- Livraisons ----------
router.put('/deliveries/:id/items', async (req, res) => {
  const d = await delOf(req, req.params.id);
  if (d.stock_out && !d.stock_back) throw new HttpError(400, 'Le stock est déjà sorti pour cette livraison : les articles ne se modifient plus.');
  await db.transaction(async () => { await saveItems(req, d.id, await cleanItems(req, (req.body || {}).items)); })();
  res.json({ ok: true });
});

router.get('/deliveries/:id', async (req, res) => {
  const d = await delOf(req, req.params.id);
  const full = await db.prepare(`${BASE} WHERE d.id = ?`).get(d.id);
  const events = await db.prepare('SELECT e.id, e.status, e.note, e.created_at, u.name AS who FROM logistics_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.delivery_id = ? ORDER BY e.id').all(d.id);
  res.json({ delivery: { ...view(full, names(full)), stockOut: Boolean(Number(d.stock_out)), stockBack: Boolean(Number(d.stock_back)), items: await itemsOf(d.id) }, events: events.map((e) => ({ id: e.id, status: e.status, statusLabel: STATUS_LABEL[e.status] || e.status, note: e.note, at: e.created_at, who: e.who })) });
});

async function checkLinks(req, b, cur) {
  const get = async (k, table, label, old) => (b[k] === undefined ? old : await optional(req, table, b[k], label));
  return {
    zoneId: await get('zoneId', 'logistics_zones', 'Zone', cur ? cur.zone_id : null),
    carrierId: await get('carrierId', 'logistics_carriers', 'Transporteur', cur ? cur.carrier_id : null),
    roundId: await get('roundId', 'logistics_rounds', 'Tournée', cur ? cur.round_id : null),
  };
}

router.post('/deliveries', async (req, res) => {
  const b = req.body || {};
  let docId = null; let cust = ''; let phone = ''; let branch = null;
  if (b.docId !== undefined && b.docId !== null && b.docId !== '') {
    const d = await db.prepare("SELECT d.*, c.name AS cname, c.phone AS cphone FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.org_id = ? AND d.kind IN ('order','invoice')").get(A.id(b.docId), req.org.id);
    if (!d || !A.visible(req, d)) throw new HttpError(404, 'Commande ou facture introuvable.');
    docId = d.id; cust = d.cname; phone = d.cphone; branch = d.branch_id;
  }
  const name = A.text(b.customerName, 100) || cust;
  if (!name) throw new HttpError(400, 'Indiquez le nom du client.');
  const links = await checkLinks(req, b, null);
  const zone = links.zoneId ? await db.prepare('SELECT * FROM logistics_zones WHERE id = ?').get(links.zoneId) : null;
  const fee = b.fee === undefined || b.fee === '' || b.fee === null ? (zone ? Number(zone.fee) : 0) : money0(b.fee);
  const planned = A.date(b.plannedDate) || (zone ? addDays(today(), Number(zone.delay_days)) : null);
  const now = nowISO();
  let id;
  await db.transaction(async () => {
    id = Number((await db.prepare('INSERT INTO logistics_deliveries (org_id, branch_id, doc_id, customer_name, phone, address, zone_id, carrier_id, round_id, fee, planned_date, status, tracking, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.org.id, branch === null && b.branchId !== undefined ? await A.branchOf(req, b.branchId) : branch, docId, name, A.text(b.phone, 40) || phone, A.text(b.address, 300), links.zoneId, links.carrierId, links.roundId, fee, planned,
      'to_prepare', A.text(b.tracking, 80), A.text(b.note, 500), req.user.id, now, now)).lastInsertRowid);
    await saveItems(req, id, await cleanItems(req, b.items));
    await addEvent(req, id, 'to_prepare', 'Livraison créée');
  })();
  await A.logActivity(req.org.id, req.user.id, 'logistics', `Livraison pour ${name} créée`);
  res.status(201).json({ id });
});

router.put('/deliveries/:id', async (req, res) => {
  const d = await delOf(req, req.params.id);
  const b = req.body || {};
  const links = await checkLinks(req, b, d);
  const upd = (k, v) => (b[k] === undefined ? v : A.text(b[k], k === 'address' ? 300 : k === 'note' ? 500 : 100));
  await db.prepare('UPDATE logistics_deliveries SET customer_name = ?, phone = ?, address = ?, zone_id = ?, carrier_id = ?, round_id = ?, fee = ?, planned_date = ?, tracking = ?, note = ?, updated_at = ? WHERE id = ?').run(
    b.customerName === undefined ? d.customer_name : A.text(b.customerName, 100, { required: true, msg: 'Indiquez le nom du client.' }), upd('phone', d.phone), upd('address', d.address), links.zoneId, links.carrierId, links.roundId,
    b.fee === undefined ? d.fee : money0(b.fee), b.plannedDate === undefined ? d.planned_date : A.date(b.plannedDate), upd('tracking', d.tracking), upd('note', d.note), nowISO(), d.id);
  res.json({ ok: true });
});

// Changement d'état : horodaté dans l'historique ; la preuve de livraison est demandée pour « Livrée ».
router.put('/deliveries/:id/status', async (req, res) => {
  const d = await delOf(req, req.params.id);
  const b = req.body || {};
  const st = A.oneOf(b.status, STATUSES, undefined, 'Statut inconnu.');
  const receivedBy = A.text(b.receivedBy, 100);
  const proof = A.text(b.proof, 500);
  if (st === 'delivered' && !receivedBy && !proof) throw new HttpError(400, 'Indiquez le nom de la personne qui a reçu le colis ou une preuve de livraison.');
  if (['failed', 'returned'].includes(st) && !A.text(b.note, 300)) throw new HttpError(400, 'Indiquez le motif (client absent, adresse introuvable, refus…).');
  await db.transaction(async () => {
    const stock = await stockBridge(req, d, st);
    await db.prepare('UPDATE logistics_deliveries SET status = ?, received_by = ?, proof = ?, updated_at = ? WHERE id = ?').run(st, st === 'delivered' ? receivedBy : d.received_by, st === 'delivered' ? proof : d.proof, nowISO(), d.id);
    await addEvent(req, d.id, st, [A.text(b.note, 300), st === 'delivered' && receivedBy ? `Reçu par ${receivedBy}` : '', stock].filter(Boolean).join(' · '));
  })();
  res.json({ ok: true });
});

router.delete('/deliveries/:id', A.need('manager'), async (req, res) => {
  const d = await delOf(req, req.params.id);
  await db.prepare('DELETE FROM logistics_deliveries WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

// « Prévenir le client » : lien wa.me avec un message prérempli. Rien n'est envoyé automatiquement : la personne appuie sur Envoyer dans WhatsApp.
router.get('/deliveries/:id/notify', async (req, res) => {
  const d = await delOf(req, req.params.id);
  const digits = String(d.phone || '').replace(/\D/g, '').replace(/^00/, '');
  const when = d.planned_date ? ` prévue le ${d.planned_date.split('-').reverse().join('/')}` : '';
  const org = req.org.name;
  const msg = {
    to_prepare: `Bonjour ${d.customer_name}, votre commande chez ${org} est en préparation. Livraison${when}.`,
    shipped: `Bonjour ${d.customer_name}, votre commande chez ${org} a été expédiée. Livraison${when}.${d.tracking ? ` Numéro de suivi : ${d.tracking}.` : ''}`,
    on_route: `Bonjour ${d.customer_name}, votre commande chez ${org} est en route${d.planned_date ? ` (prévue le ${d.planned_date.split('-').reverse().join('/')})` : ''}. Merci de rester joignable.`,
    delivered: `Bonjour ${d.customer_name}, votre commande chez ${org} a été livrée. Merci de votre confiance !`,
    failed: `Bonjour ${d.customer_name}, nous n'avons pas pu vous livrer. Pouvez-vous nous dire quand vous serez disponible ? ${org}`,
    returned: `Bonjour ${d.customer_name}, votre colis nous a été retourné. Contactez-nous pour convenir d'une nouvelle livraison. ${org}`,
  }[d.status];
  const message = isLate(d) ? `Bonjour ${d.customer_name}, nous vous prions de nous excuser : la livraison de votre commande chez ${org} a du retard. Nous revenons vers vous très vite avec une nouvelle date.` : msg;
  res.json({ phone: digits, message, url: digits.length >= 8 ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null, warning: digits.length < 8 ? "Ajoutez le numéro de téléphone du client (avec l'indicatif du pays) pour générer le lien." : digits.length <= 9 ? "Vérifiez que le numéro commence par l'indicatif du pays (ex. 237 pour le Cameroun), sinon WhatsApp ne le trouvera pas." : '' });
});

// ---------- Transporteurs ----------
router.get('/carriers', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM logistics_carriers WHERE org_id = ? ORDER BY active DESC, name').all(req.org.id);
  res.json({ carriers: rows.map((c) => ({ id: c.id, name: c.name, contact: c.contact, zones: c.zones, rate: Number(c.rate), note: c.note, active: Boolean(Number(c.active)) })) });
});
router.post('/carriers', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO logistics_carriers (org_id, name, contact, zones, rate, note, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du transporteur.' }), A.text(b.contact, 100), A.text(b.zones, 200), money0(b.rate), A.text(b.note, 300), b.active === false ? 0 : 1, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/carriers/:id', A.need('manager'), async (req, res) => {
  const c = await one(req, 'logistics_carriers', req.params.id, 'Transporteur');
  const b = req.body || {};
  await db.prepare('UPDATE logistics_carriers SET name = ?, contact = ?, zones = ?, rate = ?, note = ?, active = ? WHERE id = ?').run(b.name === undefined ? c.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du transporteur.' }),
    b.contact === undefined ? c.contact : A.text(b.contact, 100), b.zones === undefined ? c.zones : A.text(b.zones, 200), b.rate === undefined ? c.rate : money0(b.rate), b.note === undefined ? c.note : A.text(b.note, 300), b.active === undefined ? c.active : (b.active ? 1 : 0), c.id);
  res.json({ ok: true });
});
router.delete('/carriers/:id', A.need('manager'), async (req, res) => {
  const c = await one(req, 'logistics_carriers', req.params.id, 'Transporteur');
  await db.prepare('DELETE FROM logistics_carriers WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// ---------- Zones ----------
router.get('/zones', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM logistics_zones WHERE org_id = ? ORDER BY name').all(req.org.id);
  res.json({ zones: rows.map((z) => ({ id: z.id, name: z.name, fee: Number(z.fee), delayDays: Number(z.delay_days), note: z.note })) });
});
const delay = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 90) throw new HttpError(400, 'Délai invalide : indiquez un nombre de jours entre 0 et 90.'); return n; };
router.post('/zones', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO logistics_zones (org_id, name, fee, delay_days, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom de la zone.' }), money0(b.fee), b.delayDays === undefined || b.delayDays === '' ? 1 : delay(b.delayDays), A.text(b.note, 300), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/zones/:id', A.need('manager'), async (req, res) => {
  const z = await one(req, 'logistics_zones', req.params.id, 'Zone');
  const b = req.body || {};
  await db.prepare('UPDATE logistics_zones SET name = ?, fee = ?, delay_days = ?, note = ? WHERE id = ?').run(b.name === undefined ? z.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom de la zone.' }), b.fee === undefined ? z.fee : money0(b.fee),
    b.delayDays === undefined ? z.delay_days : delay(b.delayDays), b.note === undefined ? z.note : A.text(b.note, 300), z.id);
  res.json({ ok: true });
});
router.delete('/zones/:id', A.need('manager'), async (req, res) => {
  const z = await one(req, 'logistics_zones', req.params.id, 'Zone');
  await db.prepare('DELETE FROM logistics_zones WHERE id = ?').run(z.id);
  res.json({ ok: true });
});

// ---------- Tournées ----------
router.get('/rounds', async (req, res) => {
  const sc = A.scope(req, 'd.branch_id');
  const rounds = await db.prepare('SELECT r.*, c.name AS carrier, v.plate AS vehicle, dr.name AS driver FROM logistics_rounds r LEFT JOIN logistics_carriers c ON c.id = r.carrier_id LEFT JOIN logistics_vehicles v ON v.id = r.vehicle_id LEFT JOIN logistics_drivers dr ON dr.id = r.driver_id WHERE r.org_id = ? ORDER BY r.date DESC, r.id DESC LIMIT 60').all(req.org.id);
  const ds = await db.prepare(`${BASE} WHERE d.org_id = ? AND d.round_id IS NOT NULL${sc.sql} ORDER BY d.round_pos, d.id`).all(req.org.id, ...sc.args);
  res.json({ rounds: rounds.map((r) => ({ id: r.id, name: r.name, date: r.date, carrierId: r.carrier_id, carrier: r.carrier, vehicleId: r.vehicle_id, vehicle: r.vehicle, driverId: r.driver_id, driver: r.driver, note: r.note, deliveries: ds.filter((d) => d.round_id === r.id).map((d) => view(d, names(d))) })) });
});
/** Affectation d'un véhicule et d'un chauffeur à une tournée : actifs, et pas déjà pris par une autre tournée le même jour. */
async function assignment(req, b, cur, date) {
  const vid = b.vehicleId === undefined ? (cur ? cur.vehicle_id : null) : (b.vehicleId === null || b.vehicleId === '' ? null : A.id(b.vehicleId));
  const did = b.driverId === undefined ? (cur ? cur.driver_id : null) : (b.driverId === null || b.driverId === '' ? null : A.id(b.driverId));
  const other = (col, v) => db.prepare(`SELECT name FROM logistics_rounds WHERE org_id = ? AND date = ? AND ${col} = ?${cur ? ' AND id <> ?' : ''}`).get(req.org.id, date, v, ...(cur ? [cur.id] : []));
  if (vid) {
    const v = await fleet.vehicleOf(req, vid);
    if (v.status !== 'active') throw new HttpError(400, `Le véhicule ${v.plate} n'est pas disponible (${v.status === 'maintenance' ? 'en maintenance' : 'retiré du parc'}).`);
    const o = await other('vehicle_id', vid); if (o) throw new HttpError(409, `Le véhicule ${v.plate} est déjà affecté à la tournée « ${o.name} » ce jour-là.`);
  }
  if (did) {
    const d = await fleet.driverOf(req, did);
    if (!Number(d.active)) throw new HttpError(400, `Le chauffeur ${d.name} est en pause.`);
    const o = await other('driver_id', did); if (o) throw new HttpError(409, `Le chauffeur ${d.name} est déjà affecté à la tournée « ${o.name} » ce jour-là.`);
    // Permis périmé : on refuse l'affectation.
    const lic = await db.prepare("SELECT 1 FROM logistics_compliance WHERE driver_id = ? AND kind = 'license' AND expires_at < ?").get(did, date);
    const valid = await db.prepare("SELECT 1 FROM logistics_compliance WHERE driver_id = ? AND kind = 'license' AND expires_at >= ?").get(did, date);
    if (lic && !valid) throw new HttpError(400, `Le permis de ${d.name} est périmé à la date de la tournée.`);
  }
  return { vehicleId: vid, driverId: did };
}
router.post('/rounds', async (req, res) => {
  const b = req.body || {};
  const date = A.date(b.date);
  if (!date) throw new HttpError(400, 'Indiquez le jour de la tournée.');
  const asg = await assignment(req, b, null, date);
  const id = (await db.prepare('INSERT INTO logistics_rounds (org_id, name, date, carrier_id, note, created_by, created_at, vehicle_id, driver_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 100, { required: true, msg: 'Donnez un nom à la tournée.' }), date, await optional(req, 'logistics_carriers', b.carrierId, 'Transporteur'), A.text(b.note, 300), req.user.id, nowISO(), asg.vehicleId, asg.driverId)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/rounds/:id', async (req, res) => {
  const r = await one(req, 'logistics_rounds', req.params.id, 'Tournée');
  const b = req.body || {};
  const asg = await assignment(req, b, r, b.date === undefined ? r.date : (A.date(b.date) || r.date));
  await db.prepare('UPDATE logistics_rounds SET vehicle_id = ?, driver_id = ? WHERE id = ?').run(asg.vehicleId, asg.driverId, r.id);
  await db.prepare('UPDATE logistics_rounds SET name = ?, date = ?, carrier_id = ?, note = ? WHERE id = ?').run(b.name === undefined ? r.name : A.text(b.name, 100, { required: true, msg: 'Donnez un nom à la tournée.' }), b.date === undefined ? r.date : (A.date(b.date) || r.date),
    b.carrierId === undefined ? r.carrier_id : await optional(req, 'logistics_carriers', b.carrierId, 'Transporteur'), b.note === undefined ? r.note : A.text(b.note, 300), r.id);
  res.json({ ok: true });
});
router.delete('/rounds/:id', A.need('manager'), async (req, res) => {
  const r = await one(req, 'logistics_rounds', req.params.id, 'Tournée');
  await db.prepare('DELETE FROM logistics_rounds WHERE id = ?').run(r.id); // les livraisons restent, simplement sans tournée
  res.json({ ok: true });
});
// Ordre de passage : liste des livraisons de la tournée, dans l'ordre voulu ; les livraisons listées rejoignent la tournée.
router.put('/rounds/:id/order', async (req, res) => {
  const r = await one(req, 'logistics_rounds', req.params.id, 'Tournée');
  const ids = (req.body || {}).deliveryIds;
  if (!Array.isArray(ids) || ids.length > 100) throw new HttpError(400, 'Liste de livraisons invalide.');
  const clean = ids.map((i) => A.id(i));
  if (new Set(clean).size !== clean.length) throw new HttpError(400, 'Une livraison apparaît deux fois.');
  const ds = [];
  for (const i of clean) ds.push(await delOf(req, i));
  await db.transaction(async () => {
    await db.prepare('UPDATE logistics_deliveries SET round_id = NULL, round_pos = 0 WHERE round_id = ? AND org_id = ?').run(r.id, req.org.id);
    for (let k = 0; k < ds.length; k++) await db.prepare('UPDATE logistics_deliveries SET round_id = ?, round_pos = ? WHERE id = ?').run(r.id, k + 1, ds[k].id);
  })();
  res.json({ ok: true });
});

module.exports = router;
module.exports.STATUS_LABEL = STATUS_LABEL;
// Crochets lus par ai.js
module.exports.ctx = async (req) => {
  const cur = req.org.currency;
  const sc = A.scope(req, 'd.branch_id');
  const t = today();
  const all = await db.prepare(`${BASE} WHERE d.org_id = ?${sc.sql} ORDER BY d.planned_date IS NULL, d.planned_date, d.id DESC LIMIT 300`).all(req.org.id, ...sc.args);
  const open = all.filter((d) => OPEN.includes(d.status));
  const late = open.filter(isLate);
  const fin = all.filter((d) => ['delivered', 'failed', 'returned'].includes(d.status));
  const m = A.monthRange();
  const cost = all.filter((d) => (d.planned_date || d.created_at.slice(0, 10)) >= m.from && (d.planned_date || d.created_at.slice(0, 10)) < m.to && d.status !== 'returned').reduce((a, d) => a + Number(d.fee), 0);
  const line = (d) => `- #${d.id} ${oneLine(d.customer_name, 50)}${d.zone_name ? `, zone ${oneLine(d.zone_name, 40)}` : ''} [${STATUS_LABEL[d.status]}]${d.planned_date ? ` prévue ${d.planned_date}` : ''}${isLate(d) ? ' EN RETARD' : ''}${d.carrier_name ? `, par ${oneLine(d.carrier_name, 40)}` : ''}`;
  return [`LOGISTIQUE : ${open.length} livraison(s) en cours, ${open.filter((d) => d.planned_date === t).length} prévue(s) aujourd'hui, ${late.length} en retard, taux de réussite ${fin.length ? Math.round((100 * fin.filter((d) => d.status === 'delivered').length) / fin.length) + ' %' : 'inconnu'}, frais de livraison du mois ${Number(cost).toLocaleString('fr-FR')} ${cur}.`,
    'Livraisons en retard :', ...(late.slice(0, 8).map(line)), ...(late.length ? [] : ['(aucune)']), 'Autres livraisons en cours :', ...(open.filter((d) => !isLate(d)).slice(0, 12).map(line)),
    `PARC : ${(await db.prepare("SELECT COUNT(*) c FROM logistics_vehicles WHERE org_id = ? AND status = 'active'").get(req.org.id)).c} véhicule(s) actif(s), ${(await db.prepare('SELECT COUNT(*) c FROM logistics_drivers WHERE org_id = ? AND active = 1').get(req.org.id)).c} chauffeur(s).`,
    'Échéances réglementaires à surveiller (périmées ou à moins de 30 jours) :', ...((await fleet.alertItems(req)).slice(0, 10).map((c) => `- ${oneLine(c.who, 60)} : ${c.kind}${c.reference ? ' ' + oneLine(c.reference, 30) : ''} ${c.state === 'expired' ? 'PÉRIMÉE depuis' : 'échéance'} ${c.expiresAt}`)), ...((await fleet.alertItems(req)).length ? [] : ['(aucune)'])].join('\n').slice(0, 3500);
};
module.exports.prompt = "Tu aides à suivre les livraisons : retards, tournées du jour, messages courts pour prévenir les clients, organisation des livreurs et des zones. Réponds en français simple. Tu ne modifies rien toi-même et tu n'envoies aucun message : tu proposes un texte que la personne envoie elle-même. Ne promets pas de date de livraison que les données ne confirment pas. Parc : tu peux rappeler les échéances d'assurance, de visite technique et de permis et la consommation de carburant, sans inventer de dates ni de chiffres.";
module.exports.min = 'member';
