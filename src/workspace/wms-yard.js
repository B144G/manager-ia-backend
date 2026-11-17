'use strict';
// Stock entrepôt (WMS) — cour et quais (4E) : quais (rattachés à un emplacement de réception ou d'expédition), rendez-vous des camions
// (entrée : bon de commande fournisseur ; sortie : expédition), arrivée au portail, mise à quai, départ.
// États : planned (prévu) → arrived (au portail) → docked (à quai) → departed (parti) ; cancelled (annulé), no_show (pas venu).
// Indicateurs (minutes) : attente = mise à quai − arrivée ; temps à quai = départ − mise à quai ; séjour = départ − arrivée ;
//   ponctualité = arrivées au plus tard « début du créneau + tolérance » ÷ arrivées ;
//   occupation des quais = minutes occupées dans la période ÷ (quais actifs × heures d'ouverture par jour × 60 × jours) ;
//   minutes occupées : de la mise à quai au départ (ou à maintenant), sinon le créneau prévu pour un rendez-vous pas encore à quai.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const P = require('./wms-pilot');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const DIRECTIONS = { inbound: 'Réception', outbound: 'Expédition', both: 'Réception et expédition' };
const STATUS = { planned: 'Prévu', arrived: 'Au portail', docked: 'À quai', departed: 'Parti', cancelled: 'Annulé', no_show: 'Pas venu' };
const LIVE = ['planned', 'arrived', 'docked'];
const codeOf = (s, max = 20) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);

// ---------- Quais ----------
async function dockOf(req, idv) {
  const d = await db.prepare('SELECT * FROM wms_docks WHERE id = ? AND org_id = ?').get(A.id(idv, 'Choisissez un quai.'), req.org.id);
  if (!d) throw new HttpError(404, 'Quai introuvable.');
  return d;
}
async function dockLocation(req, v, direction) {
  if (v === undefined || v === null || v === '') return null;
  const l = await W.locationOf(req.org.id, A.id(v));
  const ok = direction === 'inbound' ? ['reception'] : direction === 'outbound' ? ['shipping', 'staging'] : ['reception', 'shipping', 'staging'];
  if (!ok.includes(l.kind)) throw new HttpError(400, "Rattachez le quai à un emplacement de réception ou à un quai d'expédition.");
  return l;
}
const dockView = (d) => ({ id: Number(d.id), code: d.code, name: d.name || d.code, direction: d.direction, directionLabel: DIRECTIONS[d.direction], warehouseId: d.warehouse_id ? Number(d.warehouse_id) : null, warehouse: d.warehouse || null,
  locationId: d.location_id ? Number(d.location_id) : null, location: d.loc || null, active: Boolean(Number(d.active)) });
const docksOf = (orgId, onlyActive) => db.prepare(`SELECT d.*, w.name AS warehouse, l.code AS loc FROM wms_docks d LEFT JOIN wms_warehouses w ON w.id = d.warehouse_id LEFT JOIN wms_locations l ON l.id = d.location_id
  WHERE d.org_id = ?${onlyActive ? ' AND d.active = 1' : ''} ORDER BY d.code`).all(orgId);
router.get('/yard/docks', async (req, res) => res.json({ docks: (await docksOf(req.org.id)).map(dockView), directions: DIRECTIONS }));
router.post('/yard/docks', mgr, async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 60);
  const code = codeOf(b.code || name);
  if (!code) throw new HttpError(400, 'Indiquez le code du quai (Q1, PORTE-2…).');
  const direction = DIRECTIONS[b.direction] ? b.direction : 'both';
  if (await db.prepare('SELECT 1 FROM wms_docks WHERE org_id = ? AND code = ?').get(req.org.id, code)) throw new HttpError(409, 'Ce code de quai existe déjà.');
  const loc = await dockLocation(req, b.locationId, direction);
  let wh = loc ? Number(loc.warehouse_id) : null;
  if (!wh) { const w = b.warehouseId ? await db.prepare('SELECT id FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(b.warehouseId), req.org.id) : await db.prepare('SELECT id FROM wms_warehouses WHERE org_id = ? AND is_default = 1').get(req.org.id); if (!w) throw new HttpError(404, 'Entrepôt introuvable.'); wh = Number(w.id); }
  const id = Number((await db.prepare('INSERT INTO wms_docks (org_id, warehouse_id, code, name, direction, location_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, wh, code, name || code, direction, loc ? loc.id : null, nowISO())).lastInsertRowid);
  res.status(201).json({ id, code });
});
router.put('/yard/docks/:id', mgr, async (req, res) => {
  const d = await dockOf(req, req.params.id);
  const b = req.body || {};
  const direction = b.direction === undefined ? d.direction : DIRECTIONS[b.direction] ? b.direction : d.direction;
  const loc = b.locationId === undefined ? (d.location_id ? { id: d.location_id } : null) : await dockLocation(req, b.locationId, direction);
  const active = b.active === undefined ? Number(d.active) : b.active ? 1 : 0;
  await db.prepare('UPDATE wms_docks SET name = ?, direction = ?, location_id = ?, active = ? WHERE id = ?').run(b.name === undefined ? d.name : A.text(b.name, 60) || d.code, direction, loc ? loc.id : null, active, d.id);
  res.json({ ok: true });
});
router.delete('/yard/docks/:id', mgr, async (req, res) => {
  const d = await dockOf(req, req.params.id);
  if (await db.prepare('SELECT 1 FROM wms_appointments WHERE dock_id = ? LIMIT 1').get(d.id)) throw new HttpError(400, "Ce quai a des rendez-vous dans l'historique : désactivez-le plutôt que de le supprimer.");
  await db.prepare('DELETE FROM wms_docks WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

// ---------- Rendez-vous ----------
async function apptOf(req, idv) {
  const a = await db.prepare('SELECT * FROM wms_appointments WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!a) throw new HttpError(404, 'Rendez-vous introuvable.');
  return a;
}
/** Le quai est-il déjà réservé sur ce créneau (rendez-vous encore actifs) ? */
async function overlap(dockId, start, end, exceptId) {
  return db.prepare(`SELECT code FROM wms_appointments WHERE dock_id = ? AND status IN ('planned','arrived','docked') AND slot_start < ? AND slot_end > ?${exceptId ? ' AND id != ?' : ''} LIMIT 1`).get(dockId, end, start, ...(exceptId ? [exceptId] : []));
}
function checkDock(d, direction) {
  if (!Number(d.active)) throw new HttpError(400, 'Ce quai est désactivé.');
  if (d.direction !== 'both' && d.direction !== direction) throw new HttpError(400, direction === 'inbound' ? "Ce quai ne sert qu'aux expéditions." : "Ce quai ne sert qu'aux réceptions.");
}
async function readAppt(req, b, cur) {
  const direction = cur ? cur.direction : A.oneOf(b.direction, ['inbound', 'outbound'], undefined, 'Indiquez le sens : réception ou expédition.');
  const start = b.slotStart === undefined && cur ? cur.slot_start : P.isoOf(b.slotStart, 'Indiquez le début du créneau (date et heure).');
  const end = b.slotEnd === undefined && cur ? cur.slot_end : P.isoOf(b.slotEnd, 'Indiquez la fin du créneau (date et heure).');
  if (end <= start) throw new HttpError(400, 'La fin du créneau doit suivre son début.');
  if (Date.parse(end) - Date.parse(start) > 24 * 3600000) throw new HttpError(400, 'Un créneau dure 24 heures au plus.');
  let dock = cur && cur.dock_id ? { id: cur.dock_id } : null;
  if (b.dockId !== undefined) { dock = b.dockId === '' || b.dockId === null ? null : await dockOf(req, b.dockId); if (dock) checkDock(dock, direction); }
  let carrierId = cur ? cur.carrier_id : null; let carrierName = cur ? cur.carrier_name : '';
  if (b.carrierId !== undefined && b.carrierId !== '' && b.carrierId !== null) {
    const c = await db.prepare('SELECT * FROM logistics_carriers WHERE id = ? AND org_id = ?').get(A.id(b.carrierId), req.org.id);
    if (!c) throw new HttpError(404, 'Transporteur introuvable.');
    carrierId = Number(c.id); carrierName = c.name;
  } else if (b.carrierId === '' || b.carrierId === null) carrierId = null;
  if (b.carrierName !== undefined && !(b.carrierId !== undefined && b.carrierId !== '' && b.carrierId !== null)) carrierName = cleanText(String(b.carrierName || ''), 100);
  let poId = cur ? cur.po_id : null; let shipmentId = cur ? cur.shipment_id : null;
  if (b.poId !== undefined) {
    poId = null;
    if (b.poId !== '' && b.poId !== null) {
      if (direction !== 'inbound') throw new HttpError(400, "Un bon de commande fournisseur se rattache à un rendez-vous de réception.");
      const po = await db.prepare('SELECT id FROM pur_orders WHERE id = ? AND org_id = ?').get(A.id(b.poId), req.org.id);
      if (!po) throw new HttpError(404, 'Bon de commande introuvable.');
      poId = Number(po.id);
    }
  }
  if (b.shipmentId !== undefined) {
    shipmentId = null;
    if (b.shipmentId !== '' && b.shipmentId !== null) {
      if (direction !== 'outbound') throw new HttpError(400, "Une expédition se rattache à un rendez-vous d'expédition.");
      const s = await db.prepare('SELECT id FROM wms_shipments WHERE id = ? AND org_id = ?').get(A.id(b.shipmentId), req.org.id);
      if (!s) throw new HttpError(404, 'Expédition introuvable.');
      shipmentId = Number(s.id);
    }
  }
  const txt = (k, n, def) => (b[k] === undefined ? def : cleanText(String(b[k] || ''), n));
  return { direction, start, end, dockId: dock ? Number(dock.id) : null, carrierId, carrierName, poId, shipmentId,
    plate: txt('plate', 20, cur ? cur.plate : '').toUpperCase(), driver: txt('driver', 80, cur ? cur.driver : ''), driverPhone: txt('driverPhone', 30, cur ? cur.driver_phone : ''), note: txt('note', 500, cur ? cur.note : '') };
}
async function apptView(a, tolerance) {
  const d = a.dock_id ? await db.prepare('SELECT code, name FROM wms_docks WHERE id = ?').get(a.dock_id) : null;
  const po = a.po_id ? await db.prepare('SELECT o.number, s.name AS supplier FROM pur_orders o LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?').get(a.po_id) : null;
  const sh = a.shipment_id ? await db.prepare('SELECT code, customer_name, status FROM wms_shipments WHERE id = ?').get(a.shipment_id) : null;
  const wait = a.arrived_at ? P.minutes(a.arrived_at, a.docked_at || (a.status === 'arrived' ? nowISO() : null)) : null;
  return {
    id: Number(a.id), code: a.code, direction: a.direction, directionLabel: DIRECTIONS[a.direction], status: a.status, statusLabel: STATUS[a.status],
    dockId: a.dock_id ? Number(a.dock_id) : null, dock: d ? d.code : null, slotStart: a.slot_start, slotEnd: a.slot_end,
    carrierId: a.carrier_id ? Number(a.carrier_id) : null, carrier: a.carrier_name || null, plate: a.plate || '', driver: a.driver || '', driverPhone: a.driver_phone || '', note: a.note || '',
    poId: a.po_id ? Number(a.po_id) : null, poNumber: po ? po.number : null, supplier: po ? po.supplier : null, shipmentId: a.shipment_id ? Number(a.shipment_id) : null, shipmentCode: sh ? sh.code : null, customer: sh ? sh.customer_name || null : null,
    arrivedAt: a.arrived_at || null, dockedAt: a.docked_at || null, departedAt: a.departed_at || null,
    waitMinutes: wait === null ? null : Math.round(wait), dockMinutes: a.docked_at && a.departed_at ? Math.round(P.minutes(a.docked_at, a.departed_at)) : null,
    late: a.status === 'planned' ? Date.now() > Date.parse(a.slot_start) + tolerance * 60000 : a.arrived_at ? Date.parse(a.arrived_at) > Date.parse(a.slot_start) + tolerance * 60000 : false,
  };
}
router.get('/yard/appointments', async (req, res) => {
  const per = P.period(req.query, 1);
  const st = STATUS[req.query.status] ? req.query.status : null;
  const rows = await db.prepare(`SELECT * FROM wms_appointments WHERE org_id = ? AND slot_start < ? AND slot_end > ?${st ? ' AND status = ?' : ''} ORDER BY slot_start, id LIMIT 500`).all(req.org.id, per.end, per.start, ...(st ? [st] : []));
  const tol = Number((await P.pilotOf(req.org.id)).yardTolerance);
  const out = []; for (const a of rows) out.push(await apptView(a, tol));
  res.json({ from: per.from, to: per.to, appointments: out, statuses: STATUS });
});
/** À la cour maintenant : camions arrivés (au portail ou à quai), quel que soit le jour du créneau. */
router.get('/yard/now', async (req, res) => {
  const rows = await db.prepare("SELECT * FROM wms_appointments WHERE org_id = ? AND status IN ('arrived','docked') ORDER BY arrived_at, id").all(req.org.id);
  const tol = Number((await P.pilotOf(req.org.id)).yardTolerance);
  const out = []; for (const a of rows) out.push(await apptView(a, tol));
  res.json({ appointments: out });
});
router.get('/yard/appointments/:id', async (req, res) => res.json({ appointment: await apptView(await apptOf(req, req.params.id), Number((await P.pilotOf(req.org.id)).yardTolerance)) }));
router.post('/yard/appointments', mgr, async (req, res) => {
  const v = await readAppt(req, req.body || {}, null);
  const id = await db.transaction(async () => {
    if (v.dockId) { await W.lockRow('wms_docks', v.dockId); const o = await overlap(v.dockId, v.start, v.end); if (o) throw new HttpError(409, `Ce quai est déjà réservé sur ce créneau (${o.code}).`); }
    const code = await W.nextCode(req.org.id, 'RDV');
    return { id: Number((await db.prepare(`INSERT INTO wms_appointments (org_id, code, direction, status, dock_id, carrier_id, carrier_name, plate, driver, driver_phone, slot_start, slot_end, po_id, shipment_id, note, created_by, created_at)
      VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org.id, code, v.direction, v.dockId, v.carrierId, v.carrierName, v.plate, v.driver, v.driverPhone, v.start, v.end, v.poId, v.shipmentId, v.note, req.user.id, nowISO())).lastInsertRowid), code };
  })();
  res.status(201).json(id);
});
router.put('/yard/appointments/:id', mgr, async (req, res) => {
  const a0 = await apptOf(req, req.params.id);
  const v = await readAppt(req, req.body || {}, a0);
  await db.transaction(async () => {
    const a = await W.lockRow('wms_appointments', a0.id);
    if (!LIVE.includes(a.status)) throw new HttpError(400, 'Ce rendez-vous est terminé ou annulé.');
    if (v.dockId) { await W.lockRow('wms_docks', v.dockId); const o = await overlap(v.dockId, v.start, v.end, a.id); if (o) throw new HttpError(409, `Ce quai est déjà réservé sur ce créneau (${o.code}).`); }
    if (a.status === 'docked' && Number(v.dockId || 0) !== Number(a.dock_id || 0)) throw new HttpError(400, 'Le camion est à quai : faites-le partir avant de changer de quai.');
    await db.prepare('UPDATE wms_appointments SET dock_id = ?, carrier_id = ?, carrier_name = ?, plate = ?, driver = ?, driver_phone = ?, slot_start = ?, slot_end = ?, po_id = ?, shipment_id = ?, note = ? WHERE id = ?')
      .run(v.dockId, v.carrierId, v.carrierName, v.plate, v.driver, v.driverPhone, v.start, v.end, v.poId, v.shipmentId, v.note, a.id);
  })();
  res.json({ ok: true });
});
/** Arrivée au portail (le gardien ou le magasinier) : plaque et chauffeur peuvent être complétés. */
router.post('/yard/appointments/:id/arrive', async (req, res) => {
  const a0 = await apptOf(req, req.params.id);
  const b = req.body || {};
  await db.transaction(async () => {
    const a = await W.lockRow('wms_appointments', a0.id);
    if (a.status !== 'planned') throw new HttpError(400, a.status === 'arrived' || a.status === 'docked' ? 'Ce camion est déjà arrivé.' : 'Ce rendez-vous est terminé ou annulé.');
    await db.prepare("UPDATE wms_appointments SET status = 'arrived', arrived_at = ?, arrived_by = ?, plate = ?, driver = ? WHERE id = ?")
      .run(nowISO(), req.user.id, b.plate ? cleanText(String(b.plate), 20).toUpperCase() : a.plate, b.driver ? cleanText(String(b.driver), 80) : a.driver, a.id);
  })();
  res.json({ ok: true });
});
/** Mise à quai : le quai doit être libre (aucun autre camion à quai). Une expédition rattachée prend ce quai si elle n'en a pas. */
router.post('/yard/appointments/:id/dock', async (req, res) => {
  const a0 = await apptOf(req, req.params.id);
  const b = req.body || {};
  let dock = null;
  await db.transaction(async () => {
    const a = await W.lockRow('wms_appointments', a0.id);
    if (a.status !== 'arrived') throw new HttpError(400, a.status === 'planned' ? "Notez d'abord l'arrivée du camion au portail." : a.status === 'docked' ? 'Ce camion est déjà à quai.' : 'Ce rendez-vous est terminé ou annulé.');
    const dockId = b.dockId !== undefined && b.dockId !== '' && b.dockId !== null ? A.id(b.dockId) : a.dock_id;
    if (!dockId) throw new HttpError(400, 'Choisissez le quai.');
    dock = await dockOf(req, dockId);
    checkDock(dock, a.direction);
    await W.lockRow('wms_docks', dock.id);
    const busy = await db.prepare("SELECT code, plate FROM wms_appointments WHERE dock_id = ? AND status = 'docked' AND id != ? LIMIT 1").get(dock.id, a.id);
    if (busy) throw new HttpError(409, `Ce quai est occupé (${busy.code}${busy.plate ? ' · ' + busy.plate : ''}).`);
    await db.prepare("UPDATE wms_appointments SET status = 'docked', dock_id = ?, docked_at = ?, docked_by = ? WHERE id = ?").run(dock.id, nowISO(), req.user.id, a.id);
    if (a.shipment_id && dock.location_id) {
      const l = await db.prepare('SELECT kind FROM wms_locations WHERE id = ?').get(dock.location_id);
      if (l && l.kind === 'shipping') await db.prepare("UPDATE wms_shipments SET dock_location_id = ?, dock = ? WHERE id = ? AND dock_location_id IS NULL AND status IN ('open','loading')").run(dock.location_id, dock.code, a.shipment_id);
    }
  })();
  res.json({ ok: true, dock: dock.code });
});
router.post('/yard/appointments/:id/depart', async (req, res) => {
  const a0 = await apptOf(req, req.params.id);
  await db.transaction(async () => {
    const a = await W.lockRow('wms_appointments', a0.id);
    if (!['arrived', 'docked'].includes(a.status)) throw new HttpError(400, a.status === 'planned' ? "Ce camion n'est pas encore arrivé." : 'Ce rendez-vous est déjà terminé ou annulé.');
    await db.prepare("UPDATE wms_appointments SET status = 'departed', departed_at = ?, departed_by = ? WHERE id = ?").run(nowISO(), req.user.id, a.id);
  })();
  res.json({ ok: true });
});
router.post('/yard/appointments/:id/cancel', mgr, async (req, res) => {
  const a0 = await apptOf(req, req.params.id);
  const b = req.body || {};
  const noShow = Boolean(b.noShow);
  await db.transaction(async () => {
    const a = await W.lockRow('wms_appointments', a0.id);
    if (noShow ? a.status !== 'planned' : !['planned', 'arrived'].includes(a.status)) throw new HttpError(400, noShow ? 'Seul un rendez-vous encore prévu peut être noté « pas venu ».' : 'Ce rendez-vous ne peut plus être annulé.');
    await db.prepare('UPDATE wms_appointments SET status = ?, cancel_reason = ? WHERE id = ?').run(noShow ? 'no_show' : 'cancelled', cleanText(String(b.reason || ''), 200), a.id);
  })();
  res.json({ ok: true });
});

// ---------- Indicateurs et calendrier ----------
/** Minutes d'occupation d'un rendez-vous dans [start, end[. */
function occupied(a, start, end, now) {
  let s; let e;
  if (a.docked_at) { s = a.docked_at; e = a.departed_at || now; } else if (['planned', 'arrived'].includes(a.status)) { s = a.slot_start; e = a.slot_end; } else return 0;
  const from = Math.max(Date.parse(s), Date.parse(start)); const to = Math.min(Date.parse(e), Date.parse(end));
  return to > from ? (to - from) / 60000 : 0;
}
async function kpis(orgId, per) {
  const pilot = await P.pilotOf(orgId);
  const tol = Number(pilot.yardTolerance) * 60000;
  const rows = await db.prepare('SELECT * FROM wms_appointments WHERE org_id = ? AND ((slot_start < ? AND slot_end > ?) OR (docked_at IS NOT NULL AND docked_at < ? AND COALESCE(departed_at, ?) > ?))').all(orgId, per.end, per.start, per.end, nowISO(), per.start);
  const inPeriod = rows.filter((a) => a.slot_start < per.end && a.slot_end > per.start);
  const arrived = inPeriod.filter((a) => a.arrived_at);
  const waits = arrived.filter((a) => a.docked_at).map((a) => P.minutes(a.arrived_at, a.docked_at));
  const dwell = arrived.filter((a) => a.departed_at).map((a) => P.minutes(a.arrived_at, a.departed_at));
  const atDock = inPeriod.filter((a) => a.docked_at && a.departed_at).map((a) => P.minutes(a.docked_at, a.departed_at));
  const avg = (l) => (l.length ? P.round1(l.reduce((s, x) => s + x, 0) / l.length) : null);
  const docks = await db.prepare('SELECT id, code FROM wms_docks WHERE org_id = ? AND active = 1 ORDER BY code').all(orgId);
  const now = nowISO();
  const capacity = docks.length * Number(pilot.yardHoursPerDay) * 60 * per.days;
  const perDock = docks.map((d) => {
    const m = rows.filter((a) => Number(a.dock_id) === Number(d.id)).reduce((s, a) => s + occupied(a, per.start, per.end, now), 0);
    const cap = Number(pilot.yardHoursPerDay) * 60 * per.days;
    return { dockId: Number(d.id), code: d.code, minutes: Math.round(m), utilisation: cap > 0 ? P.round1((100 * m) / cap) : 0 };
  });
  const used = rows.filter((a) => a.dock_id && docks.some((d) => Number(d.id) === Number(a.dock_id))).reduce((s, a) => s + occupied(a, per.start, per.end, now), 0);
  return {
    from: per.from, to: per.to, appointments: inPeriod.filter((a) => a.status !== 'cancelled').length,
    inbound: inPeriod.filter((a) => a.direction === 'inbound' && a.status !== 'cancelled').length, outbound: inPeriod.filter((a) => a.direction === 'outbound' && a.status !== 'cancelled').length,
    arrived: arrived.length, departed: inPeriod.filter((a) => a.status === 'departed').length, noShows: inPeriod.filter((a) => a.status === 'no_show').length, cancelled: inPeriod.filter((a) => a.status === 'cancelled').length,
    onTimeRate: arrived.length ? P.round1((100 * arrived.filter((a) => Date.parse(a.arrived_at) <= Date.parse(a.slot_start) + tol).length) / arrived.length) : null,
    avgWaitMinutes: avg(waits), maxWaitMinutes: waits.length ? Math.round(Math.max(...waits)) : null, avgDwellMinutes: avg(dwell), avgDockMinutes: avg(atDock),
    waitingNow: (await db.prepare("SELECT COUNT(*) AS c FROM wms_appointments WHERE org_id = ? AND status = 'arrived'").get(orgId)).c * 1,
    atDockNow: (await db.prepare("SELECT COUNT(*) AS c FROM wms_appointments WHERE org_id = ? AND status = 'docked'").get(orgId)).c * 1,
    docks: docks.length, utilisation: capacity > 0 ? P.round1((100 * used) / capacity) : 0, perDock,
  };
}
router.get('/yard/kpis', async (req, res) => res.json(await kpis(req.org.id, P.period(req.query, 1))));
/** Calendrier par quai (une journée par défaut, UTC) : rendez-vous de chaque quai, et ceux qui n'ont pas encore de quai. */
router.get('/yard/calendar', async (req, res) => {
  const per = P.period(req.query.date ? { from: req.query.date, to: req.query.date } : req.query, 1);
  const pilot = await P.pilotOf(req.org.id);
  const rows = await db.prepare("SELECT * FROM wms_appointments WHERE org_id = ? AND slot_start < ? AND slot_end > ? AND status != 'cancelled' ORDER BY slot_start, id").all(req.org.id, per.end, per.start);
  const views = []; for (const a of rows) views.push(await apptView(a, Number(pilot.yardTolerance)));
  const docks = (await docksOf(req.org.id, true)).map(dockView);
  res.json({ from: per.from, to: per.to, start: per.start, end: per.end, hoursPerDay: Number(pilot.yardHoursPerDay),
    docks: docks.map((d) => ({ ...d, appointments: views.filter((a) => a.dockId === d.id) })), unassigned: views.filter((a) => !a.dockId || !docks.some((d) => d.id === a.dockId)) });
});
router.get('/yard/config', async (req, res) => { const p = await P.pilotOf(req.org.id); res.json({ config: { hoursPerDay: p.yardHoursPerDay, tolerance: p.yardTolerance, waitAlert: p.yardWaitAlert } }); });
router.put('/yard/config', mgr, async (req, res) => {
  const b = req.body || {}; const patch = {};
  const int = (v, min, max, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, msg); return n; };
  if (b.hoursPerDay !== undefined && b.hoursPerDay !== '') patch.yardHoursPerDay = int(b.hoursPerDay, 1, 24, "Heures d'ouverture des quais : un nombre entier de 1 à 24.");
  if (b.tolerance !== undefined && b.tolerance !== '') patch.yardTolerance = int(b.tolerance, 0, 240, 'Tolérance de retard : un nombre entier de minutes, de 0 à 240.');
  if (b.waitAlert !== undefined && b.waitAlert !== '') patch.yardWaitAlert = int(b.waitAlert, 1, 1440, "Alerte d'attente : un nombre entier de minutes, de 1 à 1440.");
  const p = await P.savePilot(req.org.id, patch);
  res.json({ ok: true, config: { hoursPerDay: p.yardHoursPerDay, tolerance: p.yardTolerance, waitAlert: p.yardWaitAlert } });
});

module.exports = router;
module.exports.kpis = kpis;
module.exports.STATUS = STATUS;
