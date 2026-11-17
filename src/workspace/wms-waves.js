'use strict';
// Stock entrepôt (WMS) — vagues de préparation : plusieurs commandes (listes de préparation) préparées en une seule tournée.
// Le parcours est consolidé (un arrêt par emplacement et par article, toutes commandes confondues) et optimisé en serpentin :
// allée par allée, rayons dans un sens puis dans l'autre. Chaque prélèvement va en dépose / emballage et se répartit entre les commandes
// (la plus prioritaire d'abord) : la consigne de tri est donnée au scan, puis l'écran de tri récapitule ce qui revient à chaque commande.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./wms-core');
const O = require('./wms-outbound');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');
const r3 = W.round3;
const H = () => require('./wms');
const F = () => require('./wms-flows');
const STATUS = { draft: 'Brouillon', released: 'Lancée', in_progress: 'En cours', picked: 'Terminée', cancelled: 'Annulée' };
const ACTIVE_PICK = ['open', 'in_progress'];

async function waveOf(req, idv) {
  const w = await db.prepare('SELECT * FROM wms_waves WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!w) throw new HttpError(404, 'Vague introuvable.');
  return w;
}
const picksOf = (waveId) => db.prepare(`SELECT p.*, d.number AS doc, c.name AS customer FROM wms_picks p LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN customers c ON c.id = d.customer_id
  WHERE p.wave_id = ? AND p.status != 'cancelled' ORDER BY p.priority, p.id`).all(waveId);

const natural = (a, b) => String(a || '').localeCompare(String(b || ''), 'fr', { numeric: true, sensitivity: 'base' });
/** Parcours en serpentin : allées dans l'ordre ; dans une allée sur deux, rayons et bacs en sens inverse. Les emplacements sans position finissent la tournée. */
function serpentine(stops) {
  const aisles = [...new Set(stops.filter((s) => s.aisle).map((s) => s.aisle))].sort(natural);
  const idx = new Map(aisles.map((a, i) => [a, i]));
  return stops.slice().sort((a, b) => {
    if (Boolean(a.aisle) !== Boolean(b.aisle)) return a.aisle ? -1 : 1;
    if (!a.aisle) return natural(a.location, b.location) || natural(a.name, b.name);
    if (a.aisle !== b.aisle) return idx.get(a.aisle) - idx.get(b.aisle);
    const dir = idx.get(a.aisle) % 2 === 0 ? 1 : -1;
    return dir * (natural(a.rack, b.rack) || natural(a.bin, b.bin) || natural(a.location, b.location)) || natural(a.name, b.name);
  });
}
/** Arrêts restants de la vague : lignes non terminées regroupées par emplacement et article. */
async function stopsOf(wave) {
  const lines = await db.prepare(`SELECT pl.*, p.code AS pick_code, p.priority, i.name, i.unit, i.sku, i.barcode, l.code, l.aisle, l.rack, l.bin FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id JOIN stock_items i ON i.id = pl.item_id
    LEFT JOIN wms_locations l ON l.id = pl.location_id WHERE p.wave_id = ? AND p.status IN ('open','in_progress') AND pl.done = 0 ORDER BY p.priority, p.id, pl.id`).all(wave.id);
  const by = new Map();
  for (const l of lines) {
    const k = `${l.location_id || 0}-${l.item_id}`;
    if (!by.has(k)) by.set(k, { key: k, locationId: l.location_id ? Number(l.location_id) : null, location: l.code || null, aisle: l.aisle || '', rack: l.rack || '', bin: l.bin || '', itemId: Number(l.item_id), name: l.name, unit: l.unit, sku: l.sku || '', quantity: 0, orders: [] });
    const s = by.get(k);
    const rem = r3(Number(l.quantity) - Number(l.picked_qty));
    s.quantity = r3(s.quantity + rem);
    s.orders.push({ pickId: Number(l.pick_id), pickCode: l.pick_code, lineId: Number(l.id), quantity: rem });
  }
  return serpentine([...by.values()]);
}
async function waveView(w, { full = false } = {}) {
  const picks = await picksOf(w.id);
  const tot = await db.prepare("SELECT COALESCE(SUM(pl.quantity), 0) AS q, COALESCE(SUM(pl.picked_qty), 0) AS p, COUNT(*) AS n, COALESCE(SUM(CASE WHEN pl.done = 1 THEN 1 ELSE 0 END), 0) AS d, COALESCE(SUM(pl.short), 0) AS sh FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id WHERE p.wave_id = ? AND p.status != 'cancelled'").get(w.id);
  const st = w.staging_location_id ? await db.prepare('SELECT code FROM wms_locations WHERE id = ?').get(w.staging_location_id) : null;
  const who = w.assigned_to ? await db.prepare('SELECT name FROM users WHERE id = ?').get(w.assigned_to) : null;
  const toPick = r3(tot.q); const picked = r3(tot.p);
  const v = { id: Number(w.id), code: w.code, status: w.status, statusLabel: STATUS[w.status], label: w.label || null, staging: st ? st.code : null, stagingLocationId: w.staging_location_id ? Number(w.staging_location_id) : null,
    assignedTo: w.assigned_to ? Number(w.assigned_to) : null, assignedName: who ? who.name : null, orders: picks.length, lines: Number(tot.n), linesDone: Number(tot.d), short: Number(tot.sh) > 0,
    toPick, picked, progress: toPick > 0 ? Math.round((100 * picked) / toPick) : 0, createdAt: w.created_at, releasedAt: w.released_at || null, doneAt: w.done_at || null };
  if (!full) return v;
  const orders = [];
  for (const p of picks) {
    const ps = await O.packState(p.id);
    orders.push({ pickId: Number(p.id), code: p.code, status: p.status, priority: Number(p.priority), documentNumber: p.doc || null, customer: p.customer || null, label: p.label || null,
      toPick: r3(ps.items.reduce((s, x) => s + x.quantity, 0)), picked: ps.picked, packedAt: p.packed_at || null, items: ps.items.map((x) => ({ itemId: x.itemId, name: x.name, unit: x.unit, quantity: x.quantity, picked: x.picked })) });
  }
  return { ...v, picks: orders, route: ['released', 'in_progress'].includes(w.status) || w.status === 'draft' ? await stopsOf(w) : [] };
}

// ---------- Lecture ----------
router.get('/waves', async (req, res) => {
  const st = STATUS[req.query.status] ? req.query.status : null;
  const rows = await db.prepare(`SELECT * FROM wms_waves WHERE org_id = ?${st ? ' AND status = ?' : " AND status != 'cancelled'"} ORDER BY CASE WHEN status IN ('draft','released','in_progress') THEN 0 ELSE 1 END, id DESC LIMIT 200`).all(req.org.id, ...(st ? [st] : []));
  const out = []; for (const w of rows) out.push(await waveView(w));
  res.json({ waves: out, statuses: STATUS });
});
/** Ce qu'on peut grouper : listes ouvertes sans vague (rien prélevé), commandes ouvertes rattachées au stock sans liste en cours. */
router.get('/waves/candidates', async (req, res) => {
  const picks = await db.prepare(`SELECT p.*, d.number AS doc, c.name AS customer, (SELECT COUNT(*) FROM wms_pick_lines l WHERE l.pick_id = p.id) AS n FROM wms_picks p LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN customers c ON c.id = d.customer_id
    WHERE p.org_id = ? AND p.status = 'open' AND p.wave_id IS NULL AND NOT EXISTS (SELECT 1 FROM wms_pick_lines l WHERE l.pick_id = p.id AND l.picked_qty > 0) ORDER BY p.priority, p.id LIMIT 200`).all(req.org.id);
  const docs = await db.prepare(`SELECT d.id, d.number, d.lines, d.created_at, c.name AS customer FROM documents d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = 'order' AND d.status IN ('pending','confirmed')
    AND NOT EXISTS (SELECT 1 FROM wms_picks p WHERE p.document_id = d.id AND p.status != 'cancelled') ORDER BY d.id LIMIT 200`).all(req.org.id);
  res.json({
    picks: picks.map((p) => ({ id: Number(p.id), code: p.code, priority: Number(p.priority), documentNumber: p.doc || null, customer: p.customer || null, label: p.label || null, lineCount: Number(p.n) })),
    orders: docs.map((d) => ({ id: Number(d.id), number: d.number, customer: d.customer || null, createdAt: d.created_at, lineCount: Object.keys(F().docNeeds(d)).length })).filter((d) => d.lineCount > 0),
  });
});
router.get('/waves/:id', async (req, res) => res.json({ wave: await waveView(await waveOf(req, req.params.id), { full: true }) }));

// ---------- Création, composition ----------
async function stagingFor(req, b, firstPickId) {
  if (b.stagingLocationId) {
    const l = await W.locationOf(req.org.id, A.id(b.stagingLocationId));
    if (l.kind !== 'staging' || !Number(l.active)) throw new HttpError(400, 'Choisissez un emplacement de dépose et emballage actif.');
    return l;
  }
  const w = firstPickId ? await db.prepare('SELECT l.warehouse_id FROM wms_pick_lines pl JOIN wms_locations l ON l.id = pl.location_id WHERE pl.pick_id = ? LIMIT 1').get(firstPickId) : null;
  return W.outboundOf(req.org.id, 'staging', w ? Number(w.warehouse_id) : undefined);
}
/** Ajoute des listes et des commandes à une vague (dans la transaction). Renvoie { added, skipped }. */
async function attach(req, wave, b) {
  const added = []; const skipped = [];
  const pickIds = Array.isArray(b.pickIds) ? b.pickIds : [];
  const docIds = Array.isArray(b.documentIds) ? b.documentIds : [];
  if (pickIds.length + docIds.length > 100) throw new HttpError(400, '100 commandes au plus par vague.');
  for (const pid of pickIds) {
    const p = await F().pickOf(req, pid);
    if (p.status !== 'open' || (p.wave_id && Number(p.wave_id) !== Number(wave.id))) throw new HttpError(400, `La liste ${p.code} est déjà commencée ou dans une autre vague.`);
    if (await db.prepare('SELECT 1 FROM wms_pick_lines WHERE pick_id = ? AND picked_qty > 0').get(p.id)) throw new HttpError(400, `La liste ${p.code} est déjà commencée.`);
    await db.prepare('UPDATE wms_picks SET wave_id = ? WHERE id = ?').run(wave.id, p.id);
    added.push(p.code);
  }
  for (const did of docIds) {
    const d = await F().documentOf(req, did);
    if (d.kind !== 'order') throw new HttpError(400, 'Seules des commandes clients entrent dans une vague.');
    if (await db.prepare("SELECT 1 FROM wms_picks WHERE document_id = ? AND status != 'cancelled'").get(d.id)) { skipped.push({ number: d.number, reason: 'Une liste de préparation existe déjà pour cette commande.' }); continue; }
    const need = F().docNeeds(d);
    if (!Object.keys(need).length) { skipped.push({ number: d.number, reason: "Aucune ligne n'est rattachée à un article du stock." }); continue; }
    try {
      const r = await F().createPick(req, { doc: d, wants: Object.entries(need).map(([k, v]) => ({ itemId: Number(k), quantity: v })), priority: 2, waveId: wave.id });
      added.push(r.code);
      if (r.short) skipped.push({ number: d.number, reason: 'Stock insuffisant : préparée en partie.' });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      skipped.push({ number: d.number, reason: e.message });
    }
  }
  return { added, skipped };
}
router.post('/waves', mgr, async (req, res) => {
  const b = req.body || {};
  let assigned = null;
  if (b.assignedTo !== undefined && b.assignedTo !== null && b.assignedTo !== '') assigned = await A.memberOf(req, b.assignedTo);
  // « strict » (ligne B) : une vague regroupe au moins 2 commandes et tout entre ou rien n'est créé (409, aucune liste, aucune réservation).
  if (b.strict === true && (new Set((Array.isArray(b.documentIds) ? b.documentIds : []).map(String))).size < 2) throw new HttpError(400, 'Une vague regroupe au moins 2 commandes.');
  await F().syncReservations(req.org.id);
  const out = await db.transaction(async () => {
    const code = await W.nextCode(req.org.id, 'VG');
    const id = Number((await db.prepare("INSERT INTO wms_waves (org_id, code, status, label, assigned_to, created_by, created_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)").run(req.org.id, code, cleanText(String(b.label || ''), 150), assigned, req.user.id, nowISO())).lastInsertRowid);
    const wave = await db.prepare('SELECT * FROM wms_waves WHERE id = ?').get(id);
    const r = await attach(req, wave, b);
    if (b.strict === true && r.skipped.length) throw new HttpError(409, `Vague refusée, rien n'est créé : ${r.skipped.map((x) => `${x.number} (${x.reason})`).join(' ; ')}`);
    const first = await db.prepare("SELECT id FROM wms_picks WHERE wave_id = ? AND status != 'cancelled' ORDER BY id LIMIT 1").get(id);
    if (!first) throw new HttpError(400, r.skipped.length ? `Aucune commande n'a pu entrer dans la vague : ${r.skipped.map((x) => `${x.number} (${x.reason})`).join(' ; ')}` : 'Choisissez au moins une commande ou une liste de préparation.');
    const st = await stagingFor(req, b, first.id);
    const wh = await db.prepare('SELECT warehouse_id FROM wms_locations WHERE id = ?').get(st.id);
    await db.prepare('UPDATE wms_waves SET staging_location_id = ?, warehouse_id = ? WHERE id = ?').run(st.id, wh.warehouse_id, id);
    return { id, code, ...r, staging: st.code };
  })();
  res.status(201).json(out);
});
router.post('/waves/:id/picks', mgr, async (req, res) => {
  const w = await waveOf(req, req.params.id);
  if (!['draft', 'released'].includes(w.status)) throw new HttpError(400, 'Cette vague est commencée : on ne peut plus y ajouter de commandes.');
  await F().syncReservations(req.org.id);
  res.json(await db.transaction(() => attach(req, w, req.body || {}))());
});
router.delete('/waves/:id/picks/:pickId', mgr, async (req, res) => {
  const w = await waveOf(req, req.params.id);
  const p = await F().pickOf(req, req.params.pickId);
  if (Number(p.wave_id) !== Number(w.id)) throw new HttpError(404, "Cette liste n'est pas dans la vague.");
  if (await db.prepare('SELECT 1 FROM wms_pick_lines WHERE pick_id = ? AND picked_qty > 0').get(p.id)) throw new HttpError(400, `La liste ${p.code} est déjà commencée : elle reste dans la vague.`);
  await db.prepare('UPDATE wms_picks SET wave_id = NULL WHERE id = ?').run(p.id);
  res.json({ ok: true });
});
router.put('/waves/:id', mgr, async (req, res) => {
  const w = await waveOf(req, req.params.id);
  const b = req.body || {};
  let assigned = w.assigned_to;
  if (b.assignedTo !== undefined) assigned = b.assignedTo === null || b.assignedTo === '' ? null : await A.memberOf(req, b.assignedTo);
  await db.prepare('UPDATE wms_waves SET label = ?, assigned_to = ? WHERE id = ?').run(b.label === undefined ? w.label : cleanText(String(b.label || ''), 150), assigned, w.id);
  // Les listes de la vague suivent la personne désignée.
  if (b.assignedTo !== undefined) await db.prepare("UPDATE wms_picks SET assigned_to = ? WHERE wave_id = ? AND status IN ('open','in_progress')").run(assigned, w.id);
  res.json({ ok: true });
});
router.post('/waves/:id/release', mgr, async (req, res) => {
  const w = await waveOf(req, req.params.id);
  if (w.status !== 'draft') throw new HttpError(400, 'Cette vague est déjà lancée.');
  if (!(await picksOf(w.id)).length) throw new HttpError(400, 'Cette vague est vide : ajoutez au moins une commande.');
  await db.prepare("UPDATE wms_waves SET status = 'released', released_at = ? WHERE id = ?").run(nowISO(), w.id);
  if (w.assigned_to) await db.prepare("UPDATE wms_picks SET assigned_to = ? WHERE wave_id = ? AND status IN ('open','in_progress')").run(w.assigned_to, w.id);
  res.json({ ok: true });
});
/** Expédie toute la vague (ligne B) : chaque liste préparée sort du stock ; un colisage incomplet (409) arrête tout. */
router.post('/waves/:id/issue', mgr, async (req, res) => {
  const w = await waveOf(req, req.params.id);
  const picks = (await picksOf(w.id)).filter((p) => p.status === 'picked');
  if (!picks.length) throw new HttpError(400, "Aucune liste préparée à expédier : terminez d'abord la vague.");
  await db.transaction(async () => { for (const p of picks) await F().issuePick(req, p); })();
  res.json({ ok: true, orders: picks.length });
});
router.post('/waves/:id/cancel', mgr, async (req, res) => {
  const w = await waveOf(req, req.params.id);
  if (!['draft', 'released'].includes(w.status)) throw new HttpError(400, 'Des articles ont déjà été prélevés : terminez la vague.');
  await db.transaction(async () => {
    // « cancelPicks » (ligne B) : les listes de la vague sont annulées avec elle (leurs réservations sont libérées) ; sinon elles redeviennent des listes ordinaires.
    if ((req.body || {}).cancelPicks === true) {
      const live = await db.prepare("SELECT * FROM wms_picks WHERE wave_id = ? AND status IN ('open','in_progress')").all(w.id);
      await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Vague annulée' WHERE status = 'active' AND pick_id IN (SELECT id FROM wms_picks WHERE wave_id = ? AND status IN ('open','in_progress'))").run(w.id);
      // La commande garde sa réservation (elle existe toujours) : elle est remise à son compte.
      for (const p of live.filter((x) => x.document_id)) for (const l of await db.prepare('SELECT item_id, SUM(quantity) AS q FROM wms_pick_lines WHERE pick_id = ? GROUP BY item_id').all(p.id))
        await db.prepare("INSERT INTO wms_reservations (org_id, item_id, quantity, status, source_kind, document_id, label, created_by, created_at) VALUES (?, ?, ?, 'active', 'document', ?, ?, ?, ?)").run(req.org.id, l.item_id, Number(l.q), p.document_id, p.label || '', req.user.id, nowISO());
      await db.prepare("UPDATE wms_picks SET status = 'cancelled' WHERE wave_id = ? AND status IN ('open','in_progress')").run(w.id);
    }
    await db.prepare('UPDATE wms_picks SET wave_id = NULL WHERE wave_id = ?').run(w.id);
    await db.prepare("UPDATE wms_waves SET status = 'cancelled', done_at = ? WHERE id = ?").run(nowISO(), w.id);
  })();
  res.json({ ok: true });
});

// ---------- Prélèvement consolidé ----------
function canWork(req, w) {
  if (!['released', 'in_progress'].includes(w.status)) throw new HttpError(400, w.status === 'draft' ? "Cette vague n'est pas encore lancée." : 'Cette vague est terminée ou annulée.');
  if (w.assigned_to && Number(w.assigned_to) !== Number(req.user.id) && !A.can(req, 'manager')) throw new HttpError(403, 'Cette vague est confiée à une autre personne.');
}
/** Un arrêt du parcours : emplacement + article. La quantité prélevée va en dépose et se répartit entre les commandes. */
router.post('/waves/:id/confirm', async (req, res) => {
  const w = await waveOf(req, req.params.id);
  canWork(req, w);
  const b = req.body || {};
  const it = await H().itemOf(req, b.itemId);
  const locId = b.locationId === undefined || b.locationId === null || b.locationId === '' ? 0 : A.id(b.locationId);
  const stop = (await stopsOf(w)).find((s) => Number(s.locationId || 0) === locId && s.itemId === Number(it.id));
  if (!stop) throw new HttpError(404, 'Cet arrêt est déjà fait (ou ne fait pas partie de la vague).');
  if (b.itemCode && ![it.barcode, it.sku].filter(Boolean).map((x) => x.toUpperCase()).includes(String(b.itemCode).trim().toUpperCase())) throw new HttpError(400, `Ce n'est pas le bon article : attendu « ${it.name} ».`);
  let from = stop.locationId;
  if (b.fromLocationId) {
    const l = await W.locationOf(req.org.id, A.id(b.fromLocationId));
    if (!W.isUsable(l)) throw new HttpError(400, 'Choisissez un emplacement actif (pas « En transit »).');
    from = Number(l.id);
  } else if (b.locationCode && stop.location && String(b.locationCode).trim().toUpperCase() !== stop.location.toUpperCase()) throw new HttpError(400, `Ce n'est pas le bon emplacement : allez en ${stop.location}.`);
  if (!from) throw new HttpError(400, "Cette ligne n'a pas d'emplacement : indiquez où vous prenez la marchandise.");
  const given = b.quantity !== undefined && b.quantity !== null && b.quantity !== '';
  if (given && H().qty(b.quantity) > stop.quantity + W.EPS) throw new HttpError(400, `Il reste ${stop.quantity} à prélever à cet arrêt.`);
  const q = given ? H().qty(b.quantity) : stop.quantity;
  if (await W.qtyAt(from, it.id) + W.EPS < q) throw new HttpError(400, 'Pas assez de stock dans cet emplacement.');
  const short = given && q + W.EPS < stop.quantity;
  const staging = w.staging_location_id ? await W.locationOf(req.org.id, w.staging_location_id) : await W.outboundOf(req.org.id, 'staging');
  const sort = [];
  await db.transaction(async () => {
    let left = q;
    for (const o of stop.orders) {
      const line = await db.prepare('SELECT * FROM wms_pick_lines WHERE id = ?').get(o.lineId);
      const t = r3(Math.min(left, o.quantity));
      if (t > W.EPS) {
        await W.move(req, it.id, from, staging.id, t, { kind: 'wave_pick', refKind: 'wave', refId: w.id, reason: `Vague ${w.code} · ${o.pickCode}` });
        await O.saveEntries(line.id, [...O.entriesOf(line), { locationId: Number(staging.id), quantity: t }]);
        await O.stageRes(o.pickId, it.id, t);
        sort.push({ pickId: o.pickId, pickCode: o.pickCode, quantity: t });
        left = r3(left - t);
      }
      const picked = r3(Number(line.picked_qty) + t);
      const done = picked + W.EPS >= Number(line.quantity) || short;
      await db.prepare('UPDATE wms_pick_lines SET picked_qty = ?, done = ?, short = ?, picked_by = ?, picked_at = ? WHERE id = ?').run(picked, done ? 1 : 0, done && picked + W.EPS < Number(line.quantity) ? 1 : 0, req.user.id, nowISO(), line.id);
      await db.prepare("UPDATE wms_picks SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'open'").run(nowISO(), o.pickId);
    }
    await db.prepare("UPDATE wms_waves SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'released'").run(nowISO(), w.id);
    await require('./wms-pilot').record(req, 'pick', { lines: 1, units: q, refKind: 'wave', refId: w.id });
    await require('./wms-replen').autoCheck(req, from, it.id);
  })();
  res.json({ ok: true, quantity: q, staging: staging.code, sort, remaining: (await stopsOf(w)).length });
});
/** Tri : à quelles commandes revient un article scanné (et combien). */
router.get('/waves/:id/sort', async (req, res) => {
  const w = await waveOf(req, req.params.id);
  const it = req.query.itemId ? await H().itemOf(req, req.query.itemId) : await O.itemByCode(req.org.id, req.query.code);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  const rows = await db.prepare(`SELECT p.id, p.code, d.number AS doc, c.name AS customer, SUM(pl.picked_qty) AS q FROM wms_pick_lines pl JOIN wms_picks p ON p.id = pl.pick_id LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN customers c ON c.id = d.customer_id
    WHERE p.wave_id = ? AND pl.item_id = ? AND p.status != 'cancelled' GROUP BY p.id, p.code, d.number, c.name, p.priority ORDER BY p.priority, p.id`).all(w.id, it.id);
  res.json({ item: { id: Number(it.id), name: it.name, unit: it.unit }, orders: rows.filter((r) => Number(r.q) > W.EPS).map((r) => ({ pickId: Number(r.id), code: r.code, documentNumber: r.doc || null, customer: r.customer || null, quantity: r3(r.q) })) });
});
router.post('/waves/:id/complete', async (req, res) => {
  const w = await waveOf(req, req.params.id);
  canWork(req, w);
  const picks = (await picksOf(w.id)).filter((p) => ACTIVE_PICK.includes(p.status));
  const lines = picks.length ? await db.prepare(`SELECT * FROM wms_pick_lines WHERE pick_id IN (${picks.map(() => '?').join(',')})`).all(...picks.map((p) => p.id)) : [];
  if (!lines.some((l) => Number(l.picked_qty) > W.EPS)) throw new HttpError(400, "Rien n'a encore été prélevé.");
  const open = lines.filter((l) => !Number(l.done));
  if (open.length && !(req.body || {}).allowShort) throw new HttpError(409, `${open.length} ligne(s) ne sont pas entièrement prélevées. Terminer quand même ? Le reste ne sera pas préparé.`);
  const result = { picked: [], cancelled: [] };
  await db.transaction(async () => {
    for (const p of picks) {
      const mine = lines.filter((l) => Number(l.pick_id) === Number(p.id));
      for (const l of mine.filter((x) => !Number(x.done))) await db.prepare('UPDATE wms_pick_lines SET done = 1, short = 1 WHERE id = ?').run(l.id);
      if (!mine.some((l) => Number(l.picked_qty) > W.EPS)) {
        await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Rien prélevé' WHERE pick_id = ? AND status = 'active'").run(p.id);
        await db.prepare("UPDATE wms_picks SET status = 'cancelled' WHERE id = ?").run(p.id);
        result.cancelled.push(p.code);
        continue;
      }
      const byItem = {}; for (const l of mine) byItem[l.item_id] = r3((byItem[l.item_id] || 0) + Number(l.picked_qty));
      for (const [itemId, q] of Object.entries(byItem)) await db.prepare("UPDATE wms_reservations SET quantity = ?, fulfilled_qty = LEAST(fulfilled_qty, ?) WHERE pick_id = ? AND item_id = ? AND status = 'active'").run(q, q, p.id, Number(itemId));
      await db.prepare("UPDATE wms_reservations SET status = 'released', close_reason = 'Rien prélevé' WHERE pick_id = ? AND status = 'active' AND quantity <= 0").run(p.id);
      await db.prepare("UPDATE wms_picks SET status = 'picked', picked_at = ? WHERE id = ?").run(nowISO(), p.id);
      result.picked.push(p.code);
    }
    await db.prepare("UPDATE wms_waves SET status = 'picked', done_at = ? WHERE id = ?").run(nowISO(), w.id);
  })();
  res.json({ ok: true, ...result });
});

module.exports = router;
module.exports.serpentine = serpentine;
