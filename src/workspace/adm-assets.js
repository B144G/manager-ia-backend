'use strict';
// Administration · 6. Moyens généraux : inventaire des biens (lien avec les immobilisations de la Comptabilité si elles existent), attribution à une personne
// ou un service avec historique, véhicules, locaux et salles avec réservations sans chevauchement, fournitures avec seuil d'alerte, demandes de moyens,
// échéances (assurance, contrôle technique, entretien) récurrentes et coûts.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./adm-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const manage = L.needPerm('assets_manage');
const CATS = ['furniture', 'it', 'vehicle', 'equipment', 'tool', 'other'];
const CAT_LABEL = { furniture: 'Mobilier', it: 'Informatique', vehicle: 'Véhicule', equipment: 'Équipement', tool: 'Outillage', other: 'Autre' };
const STATUSES = ['in_use', 'stock', 'repair', 'retired', 'lost'];
const DL_KINDS = ['insurance', 'inspection', 'maintenance', 'warranty', 'tax', 'license', 'other'];
const EV_KINDS = ['purchase', 'maintenance', 'repair', 'fuel', 'insurance', 'tax', 'other'];

const assetView = (a, names, units) => ({
  ...L.out(a, { categoryLabel: CAT_LABEL[a.category] || a.category, cost: Number(a.cost), mileage: Number(a.mileage), assignee: names.get(Number(a.assignee_id)) || null, unit: (units.get(Number(a.unit_id)) || null) }),
});
const unitMap = async (orgId) => new Map((await db.prepare('SELECT id, name FROM adm_units WHERE org_id = ?').all(orgId)).map((u) => [Number(u.id), u.name]));

// ---------- Inventaire ----------
router.get('/assets', async (req, res) => {
  const names = await L.nameMap(req.org.id); const units = await unitMap(req.org.id);
  const where = ['org_id = ?']; const args = [req.org.id];
  if (req.query.category && CATS.includes(req.query.category)) { where.push('category = ?'); args.push(req.query.category); }
  if (req.query.status && STATUSES.includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
  if (req.query.assigneeId) { where.push('assignee_id = ?'); args.push(A.id(req.query.assigneeId)); }
  if (req.query.mine === '1') { where.push('assignee_id = ?'); args.push(req.user.id); }
  if (req.query.q) { where.push("(lower(name) LIKE ? OR lower(code) LIKE ? OR lower(serial) LIKE ? OR lower(plate) LIKE ?)"); const l = '%' + String(req.query.q).toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c).slice(0, 60) + '%'; args.push(l, l, l, l); }
  const rows = await db.prepare(`SELECT * FROM adm_assets WHERE ${where.join(' AND ')} ORDER BY category, name LIMIT 1000`).all(...args);
  const all = await db.prepare('SELECT category, status, cost FROM adm_assets WHERE org_id = ?').all(req.org.id);
  res.json({
    assets: rows.map((a) => assetView(a, names, units)),
    summary: { total: all.length, value: all.reduce((s, a) => s + Number(a.cost), 0), byCategory: CATS.map((c) => ({ key: c, label: CAT_LABEL[c], count: all.filter((a) => a.category === c).length, value: all.filter((a) => a.category === c).reduce((s, a) => s + Number(a.cost), 0) })), byStatus: STATUSES.map((s) => ({ key: s, count: all.filter((a) => a.status === s).length })) },
    categories: CATS.map((c) => ({ key: c, label: CAT_LABEL[c] })),
  });
});
/** Immobilisations de la Comptabilité pas encore reliées à un bien (administrateurs seulement : la Comptabilité leur est réservée). */
router.get('/assets/linkable', A.need('admin'), async (req, res) => {
  if (!await L.hasTable('fixed_assets')) return res.json({ available: false, assets: [] });
  const used = new Set((await db.prepare('SELECT fixed_asset_id FROM adm_assets WHERE org_id = ? AND fixed_asset_id IS NOT NULL').all(req.org.id)).map((r) => Number(r.fixed_asset_id)));
  const rows = await db.prepare("SELECT id, label, category, acquired_on, cost, status FROM fixed_assets WHERE org_id = ? AND status = 'active' ORDER BY id").all(req.org.id);
  res.json({ available: true, assets: rows.filter((f) => !used.has(Number(f.id))).map((f) => ({ id: Number(f.id), label: f.label, category: f.category, acquiredOn: f.acquired_on, cost: Number(f.cost) })) });
});
async function assetBody(req, b, base = {}) {
  let fixed = b.fixedAssetId === undefined ? base.fixed_asset_id || null : A.idOrNull(b.fixedAssetId);
  if (fixed) {
    if (!A.can(req, 'admin')) throw new HttpError(403, 'Le lien avec la Comptabilité est réservé aux administrateurs.');
    if (!await L.hasTable('fixed_assets') || !await db.prepare('SELECT 1 FROM fixed_assets WHERE id = ? AND org_id = ?').get(fixed, req.org.id)) throw new HttpError(400, 'Immobilisation inconnue.');
    const dup = await db.prepare('SELECT id FROM adm_assets WHERE org_id = ? AND fixed_asset_id = ? AND id <> ?').get(req.org.id, fixed, base.id || 0);
    if (dup) throw new HttpError(409, 'Cette immobilisation est déjà reliée à un autre bien.');
  }
  const unit = b.unitId === undefined ? base.unit_id || null : A.idOrNull(b.unitId);
  if (unit && !await db.prepare('SELECT 1 FROM adm_units WHERE id = ? AND org_id = ?').get(unit, req.org.id)) throw new HttpError(400, 'Service inconnu.');
  const t = (k, col, max) => (b[k] === undefined ? base[col] || '' : A.text(b[k], max));
  return {
    code: t('code', 'code', 40), name: b.name === undefined ? base.name : A.text(b.name, 160, { required: true, msg: 'Indiquez le nom du bien.' }), category: A.oneOf(b.category, CATS, base.category || 'equipment', 'Catégorie inconnue.'),
    brand: t('brand', 'brand', 120), serial: t('serial', 'serial', 80), plate: t('plate', 'plate', 30), mileage: b.mileage === undefined ? Number(base.mileage || 0) : L.money(b.mileage), location: t('location', 'location', 160),
    purchaseDate: b.purchaseDate === undefined ? base.purchase_date || null : A.date(b.purchaseDate), cost: b.cost === undefined ? Number(base.cost || 0) : L.money(b.cost), status: A.oneOf(b.status, STATUSES, base.status || 'in_use', 'Statut inconnu.'), unit, fixed, notes: t('notes', 'notes', 1000),
  };
}
router.post('/assets', manage, async (req, res) => {
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_assets WHERE org_id = ?').get(req.org.id)).c >= 5000) throw new HttpError(403, 'Limite de 5 000 biens atteinte.');
  const a = await assetBody(req, req.body || {});
  if (!a.name) throw new HttpError(400, 'Indiquez le nom du bien.');
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM adm_assets WHERE org_id = ?').get(req.org.id)).c) + 1;
  const id = (await db.prepare('INSERT INTO adm_assets (org_id, code, name, category, brand, serial, plate, mileage, location, purchase_date, cost, status, unit_id, fixed_asset_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, a.code || 'BIEN-' + String(n).padStart(4, '0'), a.name, a.category, a.brand, a.serial, a.plate, a.mileage, a.location, a.purchaseDate, a.cost, a.status, a.unit, a.fixed, a.notes, req.user.id, nowISO())).lastInsertRowid;
  if (a.cost && a.purchaseDate) await db.prepare("INSERT INTO adm_asset_events (org_id, asset_id, kind, event_date, amount, note, created_by, created_at) VALUES (?, ?, 'purchase', ?, ?, 'Achat', ?, ?)").run(req.org.id, id, a.purchaseDate, a.cost, req.user.id, nowISO());
  res.status(201).json({ id: Number(id) });
});
router.get('/assets/:id', async (req, res) => {
  const a = await db.prepare('SELECT * FROM adm_assets WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Bien introuvable.');
  const names = await L.nameMap(req.org.id); const units = await unitMap(req.org.id);
  const hist = await db.prepare('SELECT * FROM adm_asset_assign WHERE asset_id = ? ORDER BY id DESC').all(a.id);
  const events = await db.prepare('SELECT * FROM adm_asset_events WHERE asset_id = ? ORDER BY event_date DESC, id DESC LIMIT 100').all(a.id);
  const dls = await db.prepare('SELECT * FROM adm_asset_deadlines WHERE asset_id = ? ORDER BY due_date').all(a.id);
  res.json({
    asset: assetView(a, names, units),
    history: hist.map((h) => ({ id: Number(h.id), user: names.get(Number(h.user_id)) || null, unit: units.get(Number(h.unit_id)) || null, from: h.from_date, to: h.to_date, note: h.note })),
    events: events.map((e) => L.out(e, { amount: Number(e.amount) })), deadlines: dls.map((d) => dlView(d, null)),
    totalCost: events.reduce((s, e) => s + Number(e.amount), 0),
  });
});
router.put('/assets/:id', manage, async (req, res) => {
  const x = await db.prepare('SELECT * FROM adm_assets WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Bien introuvable.');
  const a = await assetBody(req, req.body || {}, x);
  await db.prepare('UPDATE adm_assets SET code = ?, name = ?, category = ?, brand = ?, serial = ?, plate = ?, mileage = ?, location = ?, purchase_date = ?, cost = ?, status = ?, unit_id = ?, fixed_asset_id = ?, notes = ? WHERE id = ?')
    .run(a.code, a.name, a.category, a.brand, a.serial, a.plate, a.mileage, a.location, a.purchaseDate, a.cost, a.status, a.unit, a.fixed, a.notes, x.id);
  res.json({ ok: true });
});
router.delete('/assets/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_assets WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Bien introuvable.');
  res.json({ ok: true });
});
/** Attribue un bien à une personne et/ou un service : l'attribution précédente est close, l'historique est conservé. */
router.post('/assets/:id/assign', manage, async (req, res) => {
  const a = await db.prepare('SELECT * FROM adm_assets WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Bien introuvable.');
  const b = req.body || {};
  const user = await A.memberOf(req, b.userId);
  const unit = A.idOrNull(b.unitId);
  if (unit && !await db.prepare('SELECT 1 FROM adm_units WHERE id = ? AND org_id = ?').get(unit, req.org.id)) throw new HttpError(400, 'Service inconnu.');
  if (!user && !unit) throw new HttpError(400, 'Indiquez une personne ou un service.');
  if (['retired', 'lost'].includes(a.status)) throw new HttpError(409, 'Un bien réformé ou perdu ne s’attribue pas.');
  const today = L.today();
  await db.transaction(async () => {
    await db.prepare('UPDATE adm_asset_assign SET to_date = ? WHERE asset_id = ? AND to_date IS NULL').run(today, a.id);
    await db.prepare('INSERT INTO adm_asset_assign (org_id, asset_id, user_id, unit_id, from_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, a.id, user, unit, today, A.text(b.note, 300), req.user.id);
    await db.prepare("UPDATE adm_assets SET assignee_id = ?, unit_id = ?, status = 'in_use' WHERE id = ?").run(user, unit, a.id);
  })();
  if (user) await W.push(req.org.id, user, 'administration', `Un bien vous est attribué : ${a.name}`, 'asset:' + a.id);
  res.json({ ok: true });
});
router.post('/assets/:id/return', manage, async (req, res) => {
  const a = await db.prepare('SELECT * FROM adm_assets WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Bien introuvable.');
  await db.transaction(async () => {
    await db.prepare('UPDATE adm_asset_assign SET to_date = ? WHERE asset_id = ? AND to_date IS NULL').run(L.today(), a.id);
    await db.prepare("UPDATE adm_assets SET assignee_id = NULL, unit_id = NULL, status = 'stock' WHERE id = ?").run(a.id);
  })();
  res.json({ ok: true });
});
router.post('/assets/:id/events', manage, async (req, res) => {
  const a = await db.prepare('SELECT id FROM adm_assets WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Bien introuvable.');
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO adm_asset_events (org_id, asset_id, kind, event_date, amount, vendor, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, a.id, A.oneOf(b.kind, EV_KINDS, 'maintenance', 'Type inconnu.'), A.date(b.date) || L.today(), L.money(b.amount), A.text(b.vendor, 120), A.text(b.note, 400), req.user.id, nowISO())).lastInsertRowid;
  if (b.mileage !== undefined) await db.prepare('UPDATE adm_assets SET mileage = ? WHERE id = ?').run(L.money(b.mileage), a.id);
  res.status(201).json({ id: Number(id) });
});

// ---------- Échéances (assurance, contrôle technique, entretien…) ----------
function dlView(d, names, assetNames) {
  const today = L.today();
  return { ...L.out(d, { cost: Number(d.cost), recurrenceMonths: Number(d.recurrence_months), asset: assetNames ? assetNames.get(Number(d.asset_id)) || null : undefined }), daysLeft: L.daysBetween(today, d.due_date), overdue: d.status === 'open' && d.due_date < today };
}
router.get('/deadlines', async (req, res) => {
  const cfg = await L.getConfig(req.org.id);
  const an = new Map((await db.prepare('SELECT id, name FROM adm_assets WHERE org_id = ?').all(req.org.id)).map((a) => [Number(a.id), a.name]));
  const rows = await db.prepare("SELECT * FROM adm_asset_deadlines WHERE org_id = ? AND status = 'open' ORDER BY due_date LIMIT 500").all(req.org.id);
  const list = rows.map((d) => dlView(d, null, an));
  res.json({ deadlines: list, summary: { open: list.length, overdue: list.filter((d) => d.overdue).length, soon: list.filter((d) => !d.overdue && d.daysLeft <= cfg.assetAlertDays).length } });
});
router.post('/deadlines', manage, async (req, res) => {
  const b = req.body || {};
  let asset = A.idOrNull(b.assetId);
  if (asset && !await db.prepare('SELECT 1 FROM adm_assets WHERE id = ? AND org_id = ?').get(asset, req.org.id)) throw new HttpError(400, 'Bien inconnu.');
  const due = A.date(b.dueDate);
  if (!due) throw new HttpError(400, 'Indiquez la date d’échéance.');
  const id = (await db.prepare('INSERT INTO adm_asset_deadlines (org_id, asset_id, kind, title, due_date, recurrence_months, cost, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, asset, A.oneOf(b.kind, DL_KINDS, 'maintenance', 'Type d’échéance inconnu.'), A.text(b.title, 200, { required: true, msg: 'Indiquez l’objet de l’échéance.' }), due, L.intIn(b.recurrenceMonths, 0, 120, 0), L.money(b.cost), A.text(b.notes, 500), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.post('/deadlines/:id/done', manage, async (req, res) => {
  const d = await db.prepare("SELECT * FROM adm_asset_deadlines WHERE id = ? AND org_id = ? AND status = 'open'").get(A.id(req.params.id), req.org.id);
  if (!d) throw new HttpError(404, 'Échéance introuvable ou déjà traitée.');
  const b = req.body || {};
  const doneOn = A.date(b.doneOn) || L.today(); const cost = b.cost === undefined ? Number(d.cost) : L.money(b.cost);
  let next = null;
  await db.transaction(async () => {
    if (cost || b.vendor) await db.prepare('INSERT INTO adm_asset_events (org_id, asset_id, kind, event_date, amount, vendor, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, d.asset_id, ['insurance', 'tax'].includes(d.kind) ? d.kind : 'maintenance', doneOn, cost, A.text(b.vendor, 120), d.title, req.user.id, nowISO());
    if (Number(d.recurrence_months) > 0) { // prochaine échéance : on repart de la date prévue, jamais dans le passé
      next = L.addMonths(d.due_date, Number(d.recurrence_months));
      while (next <= doneOn) next = L.addMonths(next, Number(d.recurrence_months));
      await db.prepare("UPDATE adm_asset_deadlines SET due_date = ?, last_done = ? WHERE id = ?").run(next, doneOn, d.id);
    } else await db.prepare("UPDATE adm_asset_deadlines SET status = 'done', last_done = ? WHERE id = ?").run(doneOn, d.id);
  })();
  res.json({ ok: true, next });
});
router.delete('/deadlines/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_asset_deadlines WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Échéance introuvable.');
  res.json({ ok: true });
});

// ---------- Coûts ----------
router.get('/costs', manage, async (req, res) => {
  const since = L.addMonths(L.today(), -11).slice(0, 7) + '-01';
  const rows = await db.prepare('SELECT e.*, a.name AS asset_name FROM adm_asset_events e LEFT JOIN adm_assets a ON a.id = e.asset_id WHERE e.org_id = ? AND e.event_date >= ? ORDER BY e.event_date').all(req.org.id, since);
  const sum = (m, k, v) => { m[k] = (m[k] || 0) + v; };
  const byMonth = {}; const byKind = {}; const byAsset = {};
  for (const e of rows) { const v = Number(e.amount); sum(byMonth, e.event_date.slice(0, 7), v); sum(byKind, e.kind, v); sum(byAsset, e.asset_name || 'Sans bien', v); }
  const months = []; for (let i = 11; i >= 0; i--) { const m = L.addMonths(L.today(), -i).slice(0, 7); months.push({ month: m, amount: byMonth[m] || 0 }); }
  res.json({ total: rows.reduce((s, e) => s + Number(e.amount), 0), byMonth: months, byKind: Object.entries(byKind).map(([key, amount]) => ({ key, amount })), top: Object.entries(byAsset).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount).slice(0, 5) });
});

// ---------- Locaux, salles et réservations ----------
const PLACE_KINDS = ['premises', 'room', 'storeroom', 'parking'];
router.get('/places', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM adm_places WHERE org_id = ? ORDER BY kind, name').all(req.org.id);
  res.json({ places: rows.map((p) => L.out(p, { capacity: Number(p.capacity), monthlyRent: Number(p.monthly_rent), surface: Number(p.surface) })), totalRent: rows.reduce((s, p) => s + Number(p.monthly_rent), 0) });
});
router.post('/places', manage, async (req, res) => {
  const b = req.body || {};
  const parent = A.idOrNull(b.parentId);
  if (parent && !await db.prepare('SELECT 1 FROM adm_places WHERE id = ? AND org_id = ?').get(parent, req.org.id)) throw new HttpError(400, 'Local parent inconnu.');
  const id = (await db.prepare('INSERT INTO adm_places (org_id, kind, name, parent_id, address, capacity, surface, monthly_rent, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, A.oneOf(b.kind, PLACE_KINDS, 'room', 'Type de local inconnu.'), A.text(b.name, 120, { required: true, msg: 'Indiquez le nom du local.' }), parent, A.text(b.address, 200), L.intIn(b.capacity, 0, 10000, 0), Math.max(0, Number(b.surface) || 0), L.money(b.monthlyRent), A.text(b.notes, 500), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/places/:id', manage, async (req, res) => {
  const p = await db.prepare('SELECT * FROM adm_places WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Local introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE adm_places SET kind = ?, name = ?, address = ?, capacity = ?, surface = ?, monthly_rent = ?, notes = ? WHERE id = ?').run(
    A.oneOf(b.kind, PLACE_KINDS, p.kind, 'Type de local inconnu.'), b.name === undefined ? p.name : A.text(b.name, 120, { required: true, msg: 'Le nom ne peut pas être vide.' }), b.address === undefined ? p.address : A.text(b.address, 200),
    b.capacity === undefined ? p.capacity : L.intIn(b.capacity, 0, 10000, 0), b.surface === undefined ? p.surface : Math.max(0, Number(b.surface) || 0), b.monthlyRent === undefined ? p.monthly_rent : L.money(b.monthlyRent), b.notes === undefined ? p.notes : A.text(b.notes, 500), p.id);
  res.json({ ok: true });
});
router.delete('/places/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_places WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Local introuvable.');
  res.json({ ok: true });
});
const dt = (v, msg) => { const s = typeof v === 'string' ? v : ''; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, msg); return new Date(Date.parse(s.length === 16 ? s + ':00Z' : s)).toISOString().slice(0, 16); };
router.get('/bookings', async (req, res) => {
  const names = await L.nameMap(req.org.id);
  const from = req.query.from ? String(req.query.from).slice(0, 10) : L.today(); const to = req.query.to ? String(req.query.to).slice(0, 10) : L.addDays(from, 30);
  const where = ["b.org_id = ?", "b.status = 'booked'", "b.end_at >= ?", "b.start_at <= ?"]; const args = [req.org.id, from, to + 'T23:59'];
  if (req.query.placeId) { where.push('b.place_id = ?'); args.push(A.id(req.query.placeId)); }
  const rows = await db.prepare(`SELECT b.*, p.name AS place FROM adm_bookings b JOIN adm_places p ON p.id = b.place_id WHERE ${where.join(' AND ')} ORDER BY b.start_at LIMIT 500`).all(...args);
  res.json({ bookings: rows.map((b) => L.out(b, { user: names.get(Number(b.user_id)) || null, mine: Number(b.user_id) === req.user.id })) });
});
router.post('/bookings', async (req, res) => {
  const b = req.body || {};
  const place = await db.prepare('SELECT * FROM adm_places WHERE id = ? AND org_id = ?').get(A.id(b.placeId, 'Local invalide.'), req.org.id);
  if (!place) throw new HttpError(404, 'Local introuvable.');
  const start = dt(b.startAt, 'Début invalide (AAAA-MM-JJTHH:MM).'); const end = dt(b.endAt, 'Fin invalide (AAAA-MM-JJTHH:MM).');
  if (end <= start) throw new HttpError(400, 'La fin doit suivre le début.');
  const clash = await db.prepare("SELECT title, start_at, end_at FROM adm_bookings WHERE place_id = ? AND status = 'booked' AND start_at < ? AND end_at > ? LIMIT 1").get(place.id, end, start);
  if (clash) throw new HttpError(409, `Déjà réservé : « ${clash.title} » de ${clash.start_at.slice(11)} à ${clash.end_at.slice(11)}.`);
  const id = (await db.prepare("INSERT INTO adm_bookings (org_id, place_id, title, user_id, start_at, end_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'booked', ?)").run(req.org.id, place.id, A.text(b.title, 160, { required: true, msg: 'Indiquez l’objet de la réservation.' }), req.user.id, start, end, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.delete('/bookings/:id', async (req, res) => {
  const b = await db.prepare('SELECT * FROM adm_bookings WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!b) throw new HttpError(404, 'Réservation introuvable.');
  req.admCfg = await L.getConfig(req.org.id);
  if (Number(b.user_id) !== req.user.id && !L.allowed(req, req.admCfg, 'assets_manage')) throw new HttpError(403, 'Seule la personne qui a réservé (ou un gestionnaire) peut annuler.');
  await db.prepare("UPDATE adm_bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
  res.json({ ok: true });
});

// ---------- Fournitures ----------
const supplyView = (s) => ({ ...L.out(s, { quantity: Number(s.quantity), minQuantity: Number(s.min_quantity), unitCost: Number(s.unit_cost) }), low: Number(s.min_quantity) > 0 && Number(s.quantity) <= Number(s.min_quantity), value: Math.round(Number(s.quantity) * Number(s.unit_cost)) });
router.get('/supplies', async (req, res) => {
  const rows = (await db.prepare('SELECT * FROM adm_supplies WHERE org_id = ? ORDER BY name').all(req.org.id)).map(supplyView);
  res.json({ supplies: rows, summary: { total: rows.length, low: rows.filter((s) => s.low).length, value: rows.reduce((s, x) => s + x.value, 0) } });
});
const qtyN = (v, d) => { if (v === undefined || v === '') return d; const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new HttpError(400, 'Quantité invalide.'); return Math.round(n * 1000) / 1000; };
router.post('/supplies', manage, async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO adm_supplies (org_id, name, unit, quantity, min_quantity, unit_cost, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, A.text(b.name, 120, { required: true, msg: 'Indiquez le nom de la fourniture.' }), A.text(b.unit, 30) || 'pièce', qtyN(b.quantity, 0), qtyN(b.minQuantity, 0), L.money(b.unitCost), A.text(b.location, 120), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/supplies/:id', manage, async (req, res) => {
  const s = await db.prepare('SELECT * FROM adm_supplies WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Fourniture introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE adm_supplies SET name = ?, unit = ?, min_quantity = ?, unit_cost = ?, location = ? WHERE id = ?').run(b.name === undefined ? s.name : A.text(b.name, 120, { required: true, msg: 'Le nom ne peut pas être vide.' }), b.unit === undefined ? s.unit : A.text(b.unit, 30) || 'pièce', qtyN(b.minQuantity, s.min_quantity), b.unitCost === undefined ? s.unit_cost : L.money(b.unitCost), b.location === undefined ? s.location : A.text(b.location, 120), s.id);
  res.json({ ok: true });
});
router.post('/supplies/:id/move', manage, async (req, res) => {
  const s = await db.prepare('SELECT * FROM adm_supplies WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Fourniture introuvable.');
  const delta = Number(String((req.body || {}).delta).replace(',', '.'));
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1e9) throw new HttpError(400, 'Indiquez une quantité (positive pour une entrée, négative pour une sortie).');
  const q = Math.round((Number(s.quantity) + delta) * 1000) / 1000;
  if (q < 0) throw new HttpError(400, `Stock insuffisant : il reste ${Number(s.quantity)}.`);
  await db.prepare('UPDATE adm_supplies SET quantity = ? WHERE id = ?').run(q, s.id);
  res.json({ ok: true, quantity: q, low: Number(s.min_quantity) > 0 && q <= Number(s.min_quantity) });
});
router.delete('/supplies/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_supplies WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Fourniture introuvable.');
  res.json({ ok: true });
});

// ---------- Demandes de moyens ----------
const REQ_KINDS = ['supply', 'equipment', 'vehicle', 'room', 'maintenance', 'other'];
router.get('/requests', async (req, res) => {
  req.admCfg = await L.getConfig(req.org.id);
  const all = L.allowed(req, req.admCfg, 'assets_manage');
  const names = await L.nameMap(req.org.id);
  const rows = await db.prepare(`SELECT * FROM adm_means_requests WHERE org_id = ?${all && req.query.mine !== '1' ? '' : ' AND requester_id = ?'} ORDER BY id DESC LIMIT 300`).all(...(all && req.query.mine !== '1' ? [req.org.id] : [req.org.id, req.user.id]));
  const list = rows.map((r) => L.out(r, { requester: names.get(Number(r.requester_id)) || null, quantity: Number(r.quantity), estCost: Number(r.est_cost) }));
  res.json({ requests: list, summary: { open: list.filter((r) => ['new', 'approved'].includes(r.status)).length, new: list.filter((r) => r.status === 'new').length } });
});
router.post('/requests', async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare("INSERT INTO adm_means_requests (org_id, kind, title, detail, quantity, need_date, est_cost, requester_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)")
    .run(req.org.id, A.oneOf(b.kind, REQ_KINDS, 'supply', 'Type de demande inconnu.'), A.text(b.title, 200, { required: true, msg: 'Indiquez ce que vous demandez.' }), A.text(b.detail, 1500), qtyN(b.quantity, 1) || 1, A.date(b.needDate), L.money(b.estCost), req.user.id, nowISO())).lastInsertRowid;
  const cfg = await L.getConfig(req.org.id); // les gestionnaires désignés sont prévenus
  const mem = await L.members(req.org.id);
  for (const m of mem) if (m.userId !== req.user.id && L.allowed({ user: { id: m.userId }, member: { role: m.role } }, cfg, 'assets_manage')) await W.push(req.org.id, m.userId, 'administration', `Demande de moyens : ${A.text(b.title, 80)}`, 'means:' + id);
  res.status(201).json({ id: Number(id) });
});
router.post('/requests/:id/decide', manage, async (req, res) => {
  const r = await db.prepare('SELECT * FROM adm_means_requests WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Demande introuvable.');
  if (['rejected', 'fulfilled', 'cancelled'].includes(r.status)) throw new HttpError(409, 'Demande déjà clôturée.');
  const b = req.body || {};
  const status = A.oneOf(b.status, ['approved', 'rejected', 'fulfilled'], undefined, 'Décision inconnue.');
  if (status === 'rejected' && !A.text(b.note, 400)) throw new HttpError(400, 'Indiquez le motif du refus.');
  const supply = status === 'fulfilled' ? A.idOrNull(b.supplyId || r.supply_id) : null; const asset = A.idOrNull(b.assetId);
  await db.transaction(async () => {
    if (supply) {
      const s = await db.prepare('SELECT * FROM adm_supplies WHERE id = ? AND org_id = ?').get(supply, req.org.id);
      if (!s) throw new HttpError(400, 'Fourniture inconnue.');
      if (Number(s.quantity) < Number(r.quantity)) throw new HttpError(400, `Stock insuffisant : il reste ${Number(s.quantity)} ${s.unit}.`);
      await db.prepare('UPDATE adm_supplies SET quantity = quantity - ? WHERE id = ?').run(r.quantity, s.id); // la sortie de stock suit la remise
    }
    if (asset && !await db.prepare('SELECT 1 FROM adm_assets WHERE id = ? AND org_id = ?').get(asset, req.org.id)) throw new HttpError(400, 'Bien inconnu.');
    await db.prepare('UPDATE adm_means_requests SET status = ?, handled_by = ?, handled_note = ?, supply_id = ?, asset_id = ?, closed_at = ? WHERE id = ?').run(status, req.user.id, A.text(b.note, 400), supply, asset, status === 'approved' ? null : nowISO(), r.id);
  })();
  await W.push(req.org.id, Number(r.requester_id), 'administration', `Votre demande « ${r.title} » : ${{ approved: 'acceptée', rejected: 'refusée', fulfilled: 'satisfaite' }[status]}`, 'means:' + r.id);
  res.json({ ok: true, status });
});
router.post('/requests/:id/cancel', async (req, res) => {
  const r = await db.prepare('SELECT * FROM adm_means_requests WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r || Number(r.requester_id) !== req.user.id) throw new HttpError(404, 'Demande introuvable.');
  if (r.status !== 'new') throw new HttpError(409, 'Seule une demande non traitée s’annule.');
  await db.prepare("UPDATE adm_means_requests SET status = 'cancelled', closed_at = ? WHERE id = ?").run(nowISO(), r.id);
  res.json({ ok: true });
});

async function summary(orgId) {
  const cfg = await L.getConfig(orgId); const today = L.today();
  const assets = await db.prepare('SELECT status, cost FROM adm_assets WHERE org_id = ?').all(orgId);
  const dls = await db.prepare("SELECT due_date FROM adm_asset_deadlines WHERE org_id = ? AND status = 'open'").all(orgId);
  const sup = await db.prepare('SELECT quantity, min_quantity FROM adm_supplies WHERE org_id = ?').all(orgId);
  const reqs = await db.prepare("SELECT status FROM adm_means_requests WHERE org_id = ? AND status IN ('new','approved')").all(orgId);
  return { assets: assets.length, value: assets.reduce((s, a) => s + Number(a.cost), 0), inRepair: assets.filter((a) => a.status === 'repair').length, deadlinesOverdue: dls.filter((d) => d.due_date < today).length, deadlinesSoon: dls.filter((d) => d.due_date >= today && d.due_date <= L.addDays(today, cfg.assetAlertDays)).length, lowSupplies: sup.filter((s) => Number(s.min_quantity) > 0 && Number(s.quantity) <= Number(s.min_quantity)).length, requestsOpen: reqs.length, requestsNew: reqs.filter((r) => r.status === 'new').length };
}
router.get('/summary', async (req, res) => res.json(await summary(req.org.id)));

/** Rappels des échéances de moyens (une fois par échéance). */
async function sweep(orgId) {
  const cfg = await L.getConfig(orgId);
  const lim = L.addDays(L.today(), cfg.assetAlertDays);
  const rows = await db.prepare("SELECT d.id, d.title, d.due_date, a.name FROM adm_asset_deadlines d LEFT JOIN adm_assets a ON a.id = d.asset_id WHERE d.org_id = ? AND d.status = 'open' AND d.due_date <= ?").all(orgId, lim);
  let n = 0;
  for (const d of rows) if (await L.notifyOnce(orgId, `asset-dl:${d.id}:${d.due_date}`, await L.ownerIds(orgId), `Échéance de moyens généraux : ${d.title}${d.name ? ' (' + d.name + ')' : ''} — ${d.due_date}`, 'asset-deadline:' + d.id)) n++;
  return n;
}

module.exports = { router, summary, sweep };
