'use strict';
// Parc de la Logistique : véhicules, chauffeurs, échéances réglementaires (assurance, visite technique, permis…), relevés de carburant
// (litres, kilométrage, consommation aux 100 km), lien avec les équipements de type « véhicule » de la Maintenance.
// Les routes sont montées par logistics.js. Lecture ouverte à l'équipe, écriture réservée aux responsables (le carburant se saisit par tous).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const today = () => nowISO().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const KINDS = ['truck', 'van', 'car', 'moto', 'other'];
const V_STATUS = ['active', 'maintenance', 'retired'];
const C_KINDS = { vehicle: ['insurance', 'inspection', 'tax', 'other'], driver: ['license', 'medical', 'other'] };
const num = (v, def = 0, max = 1e9) => { if (v === undefined || v === null || v === '') return def; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, 'Nombre invalide : indiquez un nombre positif ou zéro.'); return Math.round(n * 1000) / 1000; };

const vehicleOf = async (req, id) => {
  const v = await db.prepare('SELECT * FROM logistics_vehicles WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!v || !A.visible(req, v)) throw new HttpError(404, 'Véhicule introuvable.');
  return v;
};
const driverOf = async (req, id) => {
  const d = await db.prepare('SELECT * FROM logistics_drivers WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!d) throw new HttpError(404, 'Chauffeur introuvable.');
  return d;
};

/** Consommation (L/100 km) entre deux pleins consécutifs : litres du plein ÷ kilomètres depuis le plein précédent. */
async function consumption(vehicleId) {
  const rows = await db.prepare('SELECT * FROM logistics_fuel WHERE vehicle_id = ? ORDER BY odometer, id').all(vehicleId);
  const out = new Map(); let km = 0; let liters = 0; let amount = 0;
  rows.forEach((r, i) => {
    if (i === 0) return;
    const d = r.odometer - rows[i - 1].odometer;
    if (d > 0) { out.set(r.id, Math.round((r.liters / d) * 1000) / 10); km += d; liters += r.liters; amount += Number(r.amount); }
  });
  return { perFill: out, avg: km > 0 ? Math.round((liters / km) * 1000) / 10 : null, km, costPerKm: km > 0 && amount > 0 ? Math.round(amount / km) : null, total: rows.reduce((a, r) => a + r.liters, 0), spent: rows.reduce((a, r) => a + Number(r.amount), 0) };
}

/** Échéances : état selon la date (périmée, dans 30 jours, ok). */
const dueState = (d) => (d < today() ? 'expired' : d <= addDays(today(), 7) ? 'critical' : d <= addDays(today(), 30) ? 'soon' : 'ok');

async function complianceRows(req) {
  const rows = await db.prepare(`SELECT c.*, v.plate, v.label AS vlabel, v.branch_id AS vbranch, d.name AS dname FROM logistics_compliance c LEFT JOIN logistics_vehicles v ON v.id = c.vehicle_id LEFT JOIN logistics_drivers d ON d.id = c.driver_id WHERE c.org_id = ? ORDER BY c.expires_at, c.id`).all(req.org.id);
  return rows.filter((c) => !c.vehicle_id || A.visible(req, { branch_id: c.vbranch })).map((c) => ({ id: c.id, subject: c.subject, vehicleId: c.vehicle_id, driverId: c.driver_id, who: c.subject === 'vehicle' ? [c.plate, c.vlabel].filter(Boolean).join(' · ') : c.dname,
    kind: c.kind, reference: c.reference, expiresAt: c.expires_at, note: c.note, state: dueState(c.expires_at), daysLeft: Math.round((Date.parse(c.expires_at) - Date.parse(today())) / 86400000) }));
}

const vehicleView = (v, extra = {}) => ({ id: v.id, plate: v.plate, label: v.label, kind: v.kind, vin: v.vin, capacity: v.capacity, odometer: v.odometer, status: v.status, equipmentId: v.equipment_id, note: v.note, branchId: v.branch_id, ...extra });

router.get('/fleet', async (req, res) => {
  const sc = A.scope(req, 'v.branch_id');
  const vs = await db.prepare(`SELECT v.*, e.name AS equipment FROM logistics_vehicles v LEFT JOIN maintenance_equipment e ON e.id = v.equipment_id WHERE v.org_id = ?${sc.sql} ORDER BY v.plate`).all(req.org.id, ...sc.args);
  const comp = await complianceRows(req);
  const list = [];
  for (const v of vs) {
    const c = await consumption(v.id);
    const plans = v.equipment_id ? await db.prepare('SELECT task, next_due_at, next_meter FROM maintenance_plans WHERE equipment_id = ? ORDER BY next_due_at IS NULL, next_due_at LIMIT 3').all(v.equipment_id) : [];
    list.push(vehicleView(v, { equipment: v.equipment, avgConsumption: c.avg, fuelLiters: c.total, fuelSpent: A.can(req, 'manager') ? c.spent : undefined, costPerKm: A.can(req, 'manager') ? c.costPerKm : undefined,
      deadlines: comp.filter((x) => x.vehicleId === v.id), maintenance: plans.map((p) => ({ task: p.task, dueAt: p.next_due_at, dueMeter: p.next_meter })) }));
  }
  const drivers = (await db.prepare('SELECT * FROM logistics_drivers WHERE org_id = ? ORDER BY active DESC, name').all(req.org.id))
    .map((d) => ({ id: d.id, name: d.name, phone: d.phone, licenseNo: d.license_no, licenseCategory: d.license_category, active: Boolean(Number(d.active)), note: d.note, deadlines: comp.filter((x) => x.driverId === d.id) }));
  res.json({ vehicles: list, drivers, summary: { vehicles: vs.length, active: vs.filter((v) => v.status === 'active').length, expired: comp.filter((c) => c.state === 'expired').length, soon: comp.filter((c) => c.state === 'critical' || c.state === 'soon').length } });
});

// ---------- Véhicules ----------
function vFields(b, cur) {
  const has = (k) => b[k] !== undefined;
  const plate = has('plate') || !cur ? A.text(b.plate, 20, { required: true, msg: "Indiquez l'immatriculation." }).toUpperCase() : cur.plate;
  return {
    plate, label: has('label') ? A.text(b.label, 100) : cur ? cur.label : '', kind: has('kind') ? A.oneOf(b.kind, KINDS, undefined, 'Type de véhicule inconnu.') : cur ? cur.kind : 'van',
    vin: has('vin') ? A.text(b.vin, 30).toUpperCase() : cur ? cur.vin : '', capacity: has('capacity') ? A.text(b.capacity, 60) : cur ? cur.capacity : '',
    odometer: has('odometer') ? num(b.odometer) : cur ? cur.odometer : 0, status: has('status') ? A.oneOf(b.status, V_STATUS, undefined, 'Statut inconnu.') : cur ? cur.status : 'active', note: has('note') ? A.text(b.note, 300) : cur ? cur.note : '',
  };
}
async function equipmentLink(req, v) {
  if (v === undefined || v === null || v === '') return null;
  const e = await db.prepare('SELECT id, kind FROM maintenance_equipment WHERE id = ? AND org_id = ?').get(A.id(v), req.org.id);
  if (!e) throw new HttpError(400, 'Équipement de maintenance inconnu.');
  if (e.kind !== 'vehicle') throw new HttpError(400, "Seul un équipement de type « véhicule » peut être relié à un véhicule du parc.");
  if (await db.prepare('SELECT 1 FROM logistics_vehicles WHERE equipment_id = ?').get(e.id)) throw new HttpError(409, 'Cet équipement est déjà relié à un autre véhicule.');
  return e.id;
}
router.post('/vehicles', A.need('manager'), async (req, res) => {
  const b = req.body || {}; const f = vFields(b, null);
  if (await db.prepare('SELECT 1 FROM logistics_vehicles WHERE org_id = ? AND plate = ?').get(req.org.id, f.plate)) throw new HttpError(409, 'Un véhicule avec cette immatriculation existe déjà.');
  const eq = await equipmentLink(req, b.equipmentId);
  const id = (await db.prepare('INSERT INTO logistics_vehicles (org_id, branch_id, plate, label, kind, vin, capacity, odometer, status, equipment_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, await A.branchOf(req, b.branchId), f.plate, f.label, f.kind, f.vin, f.capacity, f.odometer, f.status, eq, f.note, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/vehicles/:id', A.need('manager'), async (req, res) => {
  const v = await vehicleOf(req, req.params.id); const b = req.body || {}; const f = vFields(b, v);
  if (f.plate !== v.plate && await db.prepare('SELECT 1 FROM logistics_vehicles WHERE org_id = ? AND plate = ?').get(req.org.id, f.plate)) throw new HttpError(409, 'Un véhicule avec cette immatriculation existe déjà.');
  let eq = v.equipment_id;
  if (b.equipmentId !== undefined && String(b.equipmentId || '') !== String(v.equipment_id || '')) eq = await equipmentLink(req, b.equipmentId);
  await db.prepare('UPDATE logistics_vehicles SET plate = ?, label = ?, kind = ?, vin = ?, capacity = ?, odometer = ?, status = ?, equipment_id = ?, note = ? WHERE id = ?').run(f.plate, f.label, f.kind, f.vin, f.capacity, f.odometer, f.status, eq, f.note, v.id);
  res.json({ ok: true });
});
router.delete('/vehicles/:id', A.need('manager'), async (req, res) => {
  const v = await vehicleOf(req, req.params.id);
  const fuel = (await db.prepare('SELECT COUNT(*) c FROM logistics_fuel WHERE vehicle_id = ?').get(v.id)).c;
  if (fuel) throw new HttpError(409, `Ce véhicule a ${fuel} relevé(s) de carburant : passez-le en « retiré du parc » pour garder l'historique.`);
  await db.prepare('DELETE FROM logistics_vehicles WHERE id = ?').run(v.id);
  res.json({ ok: true });
});

// ---------- Chauffeurs ----------
router.post('/drivers', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO logistics_drivers (org_id, name, phone, license_no, license_category, active, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du chauffeur.' }), A.text(b.phone, 40), A.text(b.licenseNo, 40), A.text(b.licenseCategory, 20), b.active === false ? 0 : 1, A.text(b.note, 300), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/drivers/:id', A.need('manager'), async (req, res) => {
  const d = await driverOf(req, req.params.id); const b = req.body || {};
  await db.prepare('UPDATE logistics_drivers SET name = ?, phone = ?, license_no = ?, license_category = ?, active = ?, note = ? WHERE id = ?').run(b.name === undefined ? d.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du chauffeur.' }),
    b.phone === undefined ? d.phone : A.text(b.phone, 40), b.licenseNo === undefined ? d.license_no : A.text(b.licenseNo, 40), b.licenseCategory === undefined ? d.license_category : A.text(b.licenseCategory, 20), b.active === undefined ? d.active : (b.active ? 1 : 0), b.note === undefined ? d.note : A.text(b.note, 300), d.id);
  res.json({ ok: true });
});
router.delete('/drivers/:id', A.need('manager'), async (req, res) => {
  const d = await driverOf(req, req.params.id);
  await db.prepare('DELETE FROM logistics_drivers WHERE id = ?').run(d.id); // tournées et relevés gardent leur trace, sans chauffeur
  res.json({ ok: true });
});

// ---------- Échéances réglementaires ----------
router.get('/compliance', async (req, res) => res.json({ items: await complianceRows(req), kinds: C_KINDS }));
router.post('/compliance', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const subject = A.oneOf(b.subject, ['vehicle', 'driver'], undefined, 'Choisissez un véhicule ou un chauffeur.');
  const v = subject === 'vehicle' ? await vehicleOf(req, b.vehicleId) : null; const d = subject === 'driver' ? await driverOf(req, b.driverId) : null;
  const kind = A.oneOf(b.kind, C_KINDS[subject], undefined, 'Type d\'échéance inconnu.');
  const exp = A.date(b.expiresAt); if (!exp) throw new HttpError(400, "Indiquez la date d'échéance.");
  const id = (await db.prepare('INSERT INTO logistics_compliance (org_id, subject, vehicle_id, driver_id, kind, reference, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, subject, v && v.id, d && d.id, kind, A.text(b.reference, 60), exp, A.text(b.note, 200), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/compliance/:id', A.need('manager'), async (req, res) => {
  const c = await db.prepare('SELECT * FROM logistics_compliance WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Échéance introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE logistics_compliance SET reference = ?, expires_at = ?, note = ? WHERE id = ?').run(b.reference === undefined ? c.reference : A.text(b.reference, 60), b.expiresAt === undefined ? c.expires_at : (A.date(b.expiresAt) || c.expires_at), b.note === undefined ? c.note : A.text(b.note, 200), c.id);
  res.json({ ok: true });
});
router.delete('/compliance/:id', A.need('manager'), async (req, res) => {
  const r = await db.prepare('DELETE FROM logistics_compliance WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Échéance introuvable.');
  res.json({ ok: true });
});

// ---------- Carburant ----------
router.get('/fuel', async (req, res) => {
  const vid = req.query.vehicleId ? (await vehicleOf(req, req.query.vehicleId)).id : null;
  const sc = A.scope(req, 'v.branch_id');
  const rows = await db.prepare(`SELECT f.*, v.plate, d.name AS driver FROM logistics_fuel f JOIN logistics_vehicles v ON v.id = f.vehicle_id LEFT JOIN logistics_drivers d ON d.id = f.driver_id WHERE f.org_id = ?${vid ? ' AND f.vehicle_id = ?' : ''}${sc.sql} ORDER BY f.date DESC, f.id DESC LIMIT 100`).all(req.org.id, ...(vid ? [vid] : []), ...sc.args);
  const cons = new Map(); for (const v of [...new Set(rows.map((r) => r.vehicle_id))]) cons.set(v, (await consumption(v)).perFill);
  res.json({ fuel: rows.map((r) => ({ id: r.id, vehicleId: r.vehicle_id, plate: r.plate, driver: r.driver, date: r.date, liters: r.liters, amount: A.can(req, 'manager') ? Number(r.amount) : undefined, odometer: r.odometer, station: r.station, consumption: cons.get(r.vehicle_id).get(r.id) || null })) });
});
router.post('/fuel', async (req, res) => {
  const b = req.body || {};
  const v = await vehicleOf(req, b.vehicleId);
  const liters = num(b.liters, 0, 5000); if (!liters) throw new HttpError(400, 'Indiquez les litres pris.');
  const odo = num(b.odometer, 0); if (!odo) throw new HttpError(400, 'Indiquez le kilométrage au compteur.');
  const date = A.date(b.date) || today();
  const last = await db.prepare('SELECT MAX(odometer) m FROM logistics_fuel WHERE vehicle_id = ?').get(v.id);
  const ref = Math.max(Number(last.m) || 0, v.odometer);
  if (odo < ref) throw new HttpError(400, `Kilométrage inférieur au dernier relevé (${ref} km) : vérifiez le compteur.`);
  const driver = b.driverId ? (await driverOf(req, b.driverId)).id : null;
  const amount = b.amount === undefined || b.amount === '' ? 0 : A.amount(b.amount);
  let id;
  await db.transaction(async () => {
    id = Number((await db.prepare('INSERT INTO logistics_fuel (org_id, vehicle_id, driver_id, date, liters, amount, odometer, station, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, v.id, driver, date, liters, amount, odo, A.text(b.station, 80), req.user.id, nowISO())).lastInsertRowid);
    await db.prepare('UPDATE logistics_vehicles SET odometer = ? WHERE id = ?').run(odo, v.id);
    if (v.equipment_id) await db.prepare('UPDATE maintenance_equipment SET meter = ? WHERE id = ? AND meter < ?').run(odo, v.equipment_id, odo); // les plans d'entretien au kilomètre se déclenchent
    if (b.toBudget === true && amount > 0 && A.can(req, 'manager')) await db.prepare("INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, ?, 'expense', 'Carburant', ?, ?, ?, ?, ?)").run(req.org.id, v.branch_id, `Carburant ${v.plate}`, amount, date, req.user.id, nowISO());
  })();
  res.status(201).json({ id, consumption: (await consumption(v.id)).perFill.get(id) || null });
});
router.delete('/fuel/:id', A.need('manager'), async (req, res) => {
  const r = await db.prepare('DELETE FROM logistics_fuel WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Relevé introuvable.');
  res.json({ ok: true });
});

/** Alertes du parc pour insights (échéances périmées ou à moins de 30 jours). */
async function alertItems(req) {
  return (await complianceRows(req)).filter((c) => c.state !== 'ok');
}

module.exports = router;
module.exports.alertItems = alertItems;
module.exports.complianceRows = complianceRows;
module.exports.vehicleOf = vehicleOf;
module.exports.driverOf = driverOf;
