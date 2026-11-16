'use strict';
// Stock WMS · lot 7 : listes de préparation (picking) et tâches de rangement (putaway).
//  - Une liste de préparation vient d'une commande / devis / facture (lignes rattachées à un article) ou d'une saisie libre. Chaque ligne est affectée à un emplacement
//    (préparation d'abord, en tenant compte de ce que d'autres listes ouvertes ont déjà prévu), puis ordonnée selon le parcours dans l'entrepôt (allée → rayon → bac).
//  - Créer la liste met le stock de côté (réservation de la commande ou de la liste) : personne d'autre ne peut le prendre pendant la préparation.
//  - Le préparateur confirme chaque ligne (quantité réellement prélevée, scan optionnel de l'article et de l'emplacement) ; la sortie de stock ne se fait qu'à l'« expédition » de la liste
//    (responsable), qui consomme la réservation. Une ligne prélevée en moins reste signalée.
//  - Rangement : le stock arrivé en emplacement de « Réception » attend d'être rangé ; la destination vient des règles de rangement (lot 1).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgrOf = (req) => A.can(req, 'manager');
const STATUS = { open: 'À préparer', in_progress: 'En préparation', picked: 'Préparée', issued: 'Expédiée', cancelled: 'Annulée' };
const PRIORITY = { 1: 'Urgente', 2: 'Normale', 3: 'Basse' };
const natural = (a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true });

const pickOf = async (req, id) => {
  const p = await db.prepare('SELECT p.*, w.branch_id AS branch_id FROM wms_picks p LEFT JOIN wms_warehouses w ON w.id = p.warehouse_id WHERE p.id = ? AND p.org_id = ?').get(A.id(id, 'Liste invalide.'), req.org.id);
  if (!p || !A.visible(req, p)) throw new HttpError(404, 'Liste de préparation introuvable.');
  return p;
};

async function view(req, p, full) {
  const lines = await db.prepare(`SELECT l.*, i.name, i.unit, i.sku, i.barcode, i.tracking, loc.code, loc.aisle, loc.rack, loc.bin FROM wms_pick_lines l JOIN stock_items i ON i.id = l.item_id JOIN wms_locations loc ON loc.id = l.location_id WHERE l.pick_id = ? ORDER BY l.seq, l.id`).all(p.id);
  const doc = p.source_kind === 'document' && p.source_id ? await db.prepare('SELECT d.number, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?').get(p.source_id) : null;
  const who = p.assigned_to ? await db.prepare('SELECT name FROM users WHERE id = ?').get(p.assigned_to) : null;
  const out = { id: p.id, code: p.code, status: p.status, statusLabel: STATUS[p.status], priority: p.priority, priorityLabel: PRIORITY[p.priority], sourceKind: p.source_kind, documentId: p.source_kind === 'document' ? p.source_id : null, documentNumber: doc ? doc.number : null, customer: doc ? doc.customer : null,
    warehouseId: p.warehouse_id, label: p.label, note: p.note, assignedTo: p.assigned_to, assignedName: who ? who.name : null, createdAt: p.created_at, startedAt: p.started_at, pickedAt: p.picked_at, issuedAt: p.issued_at,
    lineCount: lines.length, toPick: W.round3(lines.reduce((a, l) => a + l.quantity, 0)), picked: W.round3(lines.reduce((a, l) => a + l.picked_qty, 0)),
    short: lines.some((l) => p.status !== 'open' && p.status !== 'in_progress' && l.picked_qty + W.EPS < l.quantity) };
  if (full) out.lines = lines.map((l) => ({ id: l.id, seq: l.seq, itemId: l.item_id, name: l.name, unit: l.unit, sku: l.sku, barcode: l.barcode, tracking: l.tracking, locationId: l.location_id, location: l.code, aisle: l.aisle, rack: l.rack, bin: l.bin, quantity: l.quantity, pickedQty: l.picked_qty, issuedQty: l.issued_qty, done: l.picked_qty + W.EPS >= l.quantity }));
  return out;
}

/** Quantité déjà promise aux autres listes ouvertes, par article et emplacement. */
async function pendingMap(orgId, exceptPick = 0) {
  const rows = await db.prepare("SELECT l.item_id, l.location_id, SUM(l.quantity - l.issued_qty) q FROM wms_pick_lines l JOIN wms_picks p ON p.id = l.pick_id WHERE p.org_id = ? AND p.status IN ('open','in_progress','picked') AND p.id <> ? GROUP BY l.item_id, l.location_id").all(orgId, exceptPick);
  return new Map(rows.map((r) => [`${r.item_id}:${r.location_id}`, r.q]));
}

/** Affecte chaque besoin à des emplacements : préparation d'abord, puis les emplacements qui couvrent seuls le besoin, puis les plus garnis. */
async function allocate(req, needs, whId) {
  const pend = await pendingMap(req.org.id);
  const lines = []; const short = [];
  for (const n of needs) {
    const rows = (await W.levelRows(n.it.id)).filter((l) => W.isUsable(l.kind) && (!whId || l.warehouse_id === whId));
    const free = rows.map((l) => ({ ...l, free: W.round3(l.quantity - (pend.get(`${n.it.id}:${l.location_id}`) || 0)) })).filter((l) => l.free > W.EPS);
    free.sort((a, b) => (a.kind === 'picking' ? 0 : 1) - (b.kind === 'picking' ? 0 : 1) || (b.free >= n.q ? 1 : 0) - (a.free >= n.q ? 1 : 0) || (a.free >= n.q && b.free >= n.q ? a.free - b.free : b.free - a.free) || a.location_id - b.location_id);
    let left = n.q;
    for (const l of free) {
      if (left <= W.EPS) break;
      const take = W.round3(Math.min(l.free, left));
      lines.push({ it: n.it, locationId: l.location_id, code: l.code, q: take });
      left = W.round3(left - take);
    }
    if (left > W.EPS) short.push({ itemId: n.it.id, name: n.it.name, wanted: n.q, missing: left });
  }
  // parcours : allée → rayon → bac (ordre naturel des codes)
  lines.sort((a, b) => natural(a.code, b.code) || a.it.name.localeCompare(b.it.name));
  return { lines, short };
}

router.get('/picks', async (req, res) => {
  const status = req.query.status ? A.oneOf(req.query.status, Object.keys(STATUS), undefined, 'Statut inconnu.') : null;
  const sc = A.scope(req, 'w.branch_id');
  const mine = req.query.mine === '1' || req.query.mine === 'true';
  const rows = await db.prepare(`SELECT p.*, w.branch_id AS branch_id FROM wms_picks p LEFT JOIN wms_warehouses w ON w.id = p.warehouse_id WHERE p.org_id = ?${status ? ' AND p.status = ?' : ''}${mine ? ' AND p.assigned_to = ?' : ''}${sc.sql} ORDER BY (p.status IN ('open','in_progress')) DESC, p.priority, p.id DESC LIMIT 100`).all(req.org.id, ...(status ? [status] : []), ...(mine ? [req.user.id] : []), ...sc.args);
  const out = []; for (const p of rows) out.push(await view(req, p, false));
  res.json({ picks: out, waiting: out.filter((p) => p.status === 'open' || p.status === 'in_progress').length });
});
router.get('/picks/:id', async (req, res) => res.json({ pick: await view(req, await pickOf(req, req.params.id), true) }));

// ---------- Création ----------
router.post('/picks', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  let doc = null; const need = new Map();
  if (b.documentId) {
    doc = await db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.org_id = ? AND d.kind IN ('order','invoice','quote')").get(A.id(b.documentId, 'Document invalide.'), req.org.id);
    if (!doc || !A.visible(req, doc)) throw new HttpError(404, 'Commande, devis ou facture introuvable.');
    if (['cancelled', 'refused'].includes(doc.status)) throw new HttpError(400, 'Ce document est annulé ou refusé.');
    for (const l of JSON.parse(doc.lines)) if (l.itemId) need.set(Number(l.itemId), W.round3((need.get(Number(l.itemId)) || 0) + Number(l.quantity)));
    if (!need.size) throw new HttpError(400, "Aucune ligne de ce document n'est rattachée à un article du stock.");
  } else {
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw new HttpError(400, 'Choisissez une commande ou ajoutez au moins une ligne (100 au plus).');
    for (const x of b.lines) { const id = A.id(x && x.itemId, 'Article invalide.'); if (need.has(id)) throw new HttpError(400, 'Un article apparaît deux fois : une seule ligne par article.'); need.set(id, A.qty(x.quantity)); }
  }
  const wh = b.warehouseId ? await db.prepare('SELECT * FROM wms_warehouses WHERE id = ? AND org_id = ?').get(A.id(b.warehouseId, 'Entrepôt invalide.'), req.org.id) : null;
  if (b.warehouseId && (!wh || !A.visible(req, wh))) throw new HttpError(404, 'Entrepôt introuvable.');
  const priority = b.priority === undefined || b.priority === '' ? 2 : A.oneOf(Number(b.priority), [1, 2, 3], undefined, 'Priorité inconnue (1 urgente, 2 normale, 3 basse).');
  const assignedTo = await A.memberOf(req, b.assignedTo);
  const partial = b.partial === true || b.partial === 'true';
  const needs = [];
  for (const [id, q] of need) {
    const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(id, req.org.id);
    if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
    if (it.tracking === 'serial' && !Number.isInteger(q)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : la quantité est un nombre entier.`);
    needs.push({ it, q });
  }
  const id = await db.transaction(async () => {
    // Le stock est mis de côté d'abord (un article verrouillé à la fois) : si ce n'est pas possible, rien n'est créé.
    for (const n of [...needs].sort((x, y) => x.it.id - y.it.id)) await W.lockItem(req.org.id, n.it.id);
    const { lines, short } = await allocate(req, needs, wh ? wh.id : null);
    if (short.length && !partial) throw new HttpError(409, `Stock insuffisant pour préparer : ${short.map((x) => `« ${x.name} » manque ${x.missing} sur ${x.wanted}`).join(' ; ')}.`);
    if (!lines.length) throw new HttpError(409, 'Rien à préparer : aucun stock disponible.');
    const code = await W.nextCode(req.org.id, 'wms_pick', 'PREP');
    const pid = Number((await db.prepare('INSERT INTO wms_picks (org_id, code, status, source_kind, source_id, warehouse_id, label, priority, assigned_to, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, code, 'open', doc ? 'document' : 'manual', doc ? doc.id : null, wh ? wh.id : null, doc ? `${doc.number} · ${doc.customer}`.slice(0, 150) : A.text(b.label, 150), priority, assignedTo, A.text(b.note, 300), req.user.id, nowISO())).lastInsertRowid);
    let seq = 0;
    for (const l of lines) await db.prepare('INSERT INTO wms_pick_lines (org_id, pick_id, item_id, location_id, seq, quantity) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, pid, l.it.id, l.locationId, ++seq, l.q);
    // mise de côté : la commande réserve (rejouable) ; une liste libre réserve pour elle-même
    const got = new Map(); for (const l of lines) got.set(l.it.id, W.round3((got.get(l.it.id) || 0) + l.q));
    if (doc) {
      const rv = await W.reserveDocument(req, doc, { partial: true, minimum: got, warehouseId: wh ? wh.id : null });
      if (rv.short.length) throw new HttpError(409, `Stock à promettre insuffisant (une partie est réservée pour d'autres) : ${rv.short.map((x) => `« ${x.name} » ${x.available} disponible(s) pour ${x.wanted}`).join(' ; ')}.`);
    }
    else for (const [itemId, q] of got) {
      const a = (await W.availabilityMap(req.org.id)).get(itemId);
      if (q - a.available > W.EPS) throw new HttpError(409, `« ${needs.find((n) => n.it.id === itemId).it.name} » : ${a.available} disponible(s) à promettre seulement (le reste est réservé).`);
      await db.prepare("INSERT INTO wms_reservations (org_id, item_id, quantity, source_kind, source_id, label, created_by, created_at, warehouse_id) VALUES (?, ?, ?, 'pick', ?, ?, ?, ?, ?)").run(req.org.id, itemId, q, pid, `Préparation ${code}`, req.user.id, nowISO(), wh ? wh.id : null);
    }
    return pid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Liste de préparation créée${doc ? ` pour ${doc.number}` : ''}`);
  res.status(201).json({ id });
});

// ---------- Exécution ----------
const canWork = (req, p) => { if (p.assigned_to && p.assigned_to !== req.user.id && !mgrOf(req)) throw new HttpError(403, 'Cette liste est confiée à une autre personne.'); };

router.post('/picks/:id/start', async (req, res) => {
  const p = await pickOf(req, req.params.id);
  canWork(req, p);
  const r = await db.prepare("UPDATE wms_picks SET status = 'in_progress', started_at = COALESCE(started_at, ?), assigned_to = COALESCE(assigned_to, ?) WHERE id = ? AND status IN ('open','in_progress')").run(nowISO(), req.user.id, p.id);
  if (!r.changes) throw new HttpError(409, 'Cette liste est terminée ou annulée.');
  res.json({ ok: true });
});

router.post('/picks/:id/lines/:lineId/confirm', async (req, res) => {
  const p = await pickOf(req, req.params.id);
  canWork(req, p);
  const b = req.body || {};
  await db.transaction(async () => {
    const pk = await db.prepare('SELECT * FROM wms_picks WHERE id = ? FOR UPDATE').get(p.id);
    if (!['open', 'in_progress'].includes(pk.status)) throw new HttpError(409, 'Cette liste est terminée ou annulée.');
    const l = await db.prepare('SELECT * FROM wms_pick_lines WHERE id = ? AND pick_id = ? FOR UPDATE').get(A.id(req.params.lineId), p.id);
    if (!l) throw new HttpError(404, 'Ligne introuvable.');
    const it = await db.prepare('SELECT * FROM stock_items WHERE id = ?').get(l.item_id);
    // Scans facultatifs : le code lu doit correspondre à l'article et à l'emplacement attendus (ou à celui où le préparateur a réellement pris).
    if (b.itemCode !== undefined && b.itemCode !== '' && ![it.barcode, it.sku].filter(Boolean).includes(String(b.itemCode).trim())) throw new HttpError(400, `Mauvais article : « ${it.name} » est attendu (code ${it.barcode || it.sku || 'non renseigné'}).`);
    let loc = await W.locationOf(req.org.id, l.location_id);
    if (b.locationCode !== undefined && b.locationCode !== '') {
      const c = String(b.locationCode).trim().toUpperCase();
      if (c !== loc.code) {
        const other = await db.prepare('SELECT l.*, w.branch_id AS branch_id FROM wms_locations l JOIN wms_warehouses w ON w.id = l.warehouse_id WHERE l.org_id = ? AND l.code = ?').get(req.org.id, c);
        if (!other || !A.visible(req, other)) throw new HttpError(404, 'Aucun emplacement avec ce code.');
        throw new HttpError(400, `Mauvais emplacement : allez en ${loc.code} (ou passez par « prendre ailleurs »).`);
      }
    }
    if (b.fromLocationId) { // le préparateur a pris dans un autre emplacement : permis s'il y a le stock
      const alt = await W.locationFor(req, b.fromLocationId);
      if (!W.isUsable(alt.kind)) throw new HttpError(400, `L'emplacement ${alt.code} n'est pas disponible à la préparation.`);
      loc = alt;
    }
    const left = W.round3(l.quantity - l.picked_qty);
    const q = b.quantity === undefined || b.quantity === '' ? left : A.qty(b.quantity, { allowZero: true });
    if (q - left > W.EPS) throw new HttpError(400, `Il ne reste que ${left} ${it.unit} à prélever sur cette ligne.`);
    const have = await W.levelAt(l.item_id, loc.id);
    if (have + W.EPS < q) throw new HttpError(409, `Il n'y a que ${have} ${it.unit} de « ${it.name} » à l'emplacement ${loc.code} : signalez l'écart ou comptez l'emplacement.`);
    await db.prepare('UPDATE wms_pick_lines SET picked_qty = ?, location_id = ? WHERE id = ?').run(W.round3(l.picked_qty + q), loc.id, l.id);
    await db.prepare("UPDATE wms_picks SET status = 'in_progress', started_at = COALESCE(started_at, ?), assigned_to = COALESCE(assigned_to, ?) WHERE id = ?").run(nowISO(), req.user.id, p.id);
  })();
  res.json({ ok: true });
});

router.post('/picks/:id/complete', async (req, res) => {
  const p = await pickOf(req, req.params.id);
  canWork(req, p);
  const allowShort = (req.body || {}).allowShort === true || (req.body || {}).allowShort === 'true';
  await db.transaction(async () => {
    const pk = await db.prepare('SELECT * FROM wms_picks WHERE id = ? FOR UPDATE').get(p.id);
    if (!['open', 'in_progress'].includes(pk.status)) throw new HttpError(409, 'Cette liste est terminée ou annulée.');
    const lines = await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ?').all(p.id);
    if (!lines.some((l) => l.picked_qty > 0)) throw new HttpError(400, "Rien n'a encore été prélevé.");
    const missing = lines.filter((l) => l.picked_qty + W.EPS < l.quantity);
    if (missing.length && !allowShort) throw new HttpError(409, `${missing.length} ligne(s) incomplète(s) : prélevez le reste ou terminez en acceptant le manque.`);
    await db.prepare("UPDATE wms_picks SET status = 'picked', picked_at = ? WHERE id = ?").run(nowISO(), p.id);
  })();
  res.json({ ok: true });
});

/** Expédition : la sortie de stock a lieu ici, emplacement par emplacement, en consommant la réservation de la liste ou de la commande. */
router.post('/picks/:id/issue', A.need('manager'), async (req, res) => {
  const p = await pickOf(req, req.params.id);
  const b = req.body || {};
  const serialsBy = b.serials && typeof b.serials === 'object' ? b.serials : {};
  let issued = 0;
  await db.transaction(async () => {
    const pk = await db.prepare('SELECT * FROM wms_picks WHERE id = ? FOR UPDATE').get(p.id);
    if (pk.status !== 'picked') throw new HttpError(409, pk.status === 'issued' ? 'Cette liste est déjà expédiée.' : "La liste doit d'abord être préparée.");
    const lines = (await db.prepare('SELECT * FROM wms_pick_lines WHERE pick_id = ? AND picked_qty > issued_qty ORDER BY item_id, id').all(p.id));
    const perItemSerials = new Map();
    for (const l of lines) {
      const it = await W.lockItem(req.org.id, l.item_id);
      const q = W.round3(l.picked_qty - l.issued_qty);
      let serials;
      if (it.tracking === 'serial') {
        const all = perItemSerials.get(it.id) || L.parseSerials(serialsBy[it.id] || serialsBy[String(it.id)]);
        perItemSerials.set(it.id, all);
        const total = lines.filter((x) => x.item_id === it.id).reduce((a, x) => a + (x.picked_qty - x.issued_qty), 0);
        if (all.length !== total) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : indiquez exactement ${total} numéro(s).`);
        serials = all.splice(0, q);
      }
      await L.adjust(req, it, -q, `Préparation ${pk.code}${pk.label ? ' · ' + pk.label : ''}`.slice(0, 150), { locationId: l.location_id, refKind: 'pick', refId: pk.id, serials });
      await db.prepare('UPDATE wms_pick_lines SET issued_qty = picked_qty WHERE id = ?').run(l.id);
      issued++;
    }
    // la part non prélevée n'est plus à garder de côté
    if (pk.source_kind !== 'document') await db.prepare("UPDATE wms_reservations SET status = CASE WHEN fulfilled_qty > 0 THEN 'fulfilled' ELSE 'released' END, closed_at = ?, close_reason = 'Liste expédiée' WHERE org_id = ? AND source_kind = 'pick' AND source_id = ? AND status = 'active'").run(nowISO(), req.org.id, pk.id);
    await db.prepare("UPDATE wms_picks SET status = 'issued', issued_at = ? WHERE id = ?").run(nowISO(), pk.id);
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Liste de préparation ${p.code} expédiée`);
  res.json({ ok: true, lines: issued });
});

router.post('/picks/:id/cancel', A.need('manager'), async (req, res) => {
  const p = await pickOf(req, req.params.id);
  await db.transaction(async () => {
    const pk = await db.prepare('SELECT * FROM wms_picks WHERE id = ? FOR UPDATE').get(p.id);
    if (['issued', 'cancelled'].includes(pk.status)) throw new HttpError(409, 'Cette liste est terminée.');
    await db.prepare("UPDATE wms_picks SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(nowISO(), pk.id);
    await db.prepare("UPDATE wms_reservations SET status = 'released', closed_at = ?, closed_by = ?, close_reason = 'Liste annulée' WHERE org_id = ? AND source_kind = 'pick' AND source_id = ? AND status = 'active'").run(nowISO(), req.user.id, req.org.id, pk.id);
  })();
  res.json({ ok: true });
});

// ---------- Rangement : le stock arrivé en emplacement de Réception attend sa place ----------
router.get('/putaway/pending', async (req, res) => {
  const sc = A.scope(req, 'w.branch_id');
  const rows = await db.prepare(`SELECT v.item_id, v.location_id, v.quantity, l.code, i.name, i.unit, i.sku, i.barcode, i.tracking, i.avg_cost, i.unit_cost, i.min_quantity FROM wms_levels v JOIN wms_locations l ON l.id = v.location_id JOIN wms_warehouses w ON w.id = l.warehouse_id JOIN stock_items i ON i.id = v.item_id
    WHERE v.org_id = ? AND l.kind = 'reception' AND v.quantity > 0${sc.sql} ORDER BY l.code, i.name COLLATE NOCASE`).all(req.org.id, ...sc.args);
  const codes = new Map((await db.prepare('SELECT id, code FROM wms_locations WHERE org_id = ?').all(req.org.id)).map((l) => [l.id, l.code]));
  const out = [];
  for (const r of rows) {
    const parts = await W.putawayParts(req.org.id, { id: r.item_id, tracking: r.tracking }, r.quantity);
    const only = parts.length === 1 && parts[0].locationId === r.location_id;
    out.push({ itemId: r.item_id, name: r.name, unit: r.unit, sku: r.sku, barcode: r.barcode, fromLocationId: r.location_id, from: r.code, quantity: r.quantity,
      suggestion: only ? [] : parts.map((x) => ({ locationId: x.locationId, code: codes.get(x.locationId), quantity: x.quantity, fallback: Boolean(x.fallback) })) });
  }
  res.json({ tasks: out, count: out.length });
});
router.post('/putaway', async (req, res) => {
  const b = req.body || {};
  const from = await W.locationFor(req, b.fromLocationId);
  const it0 = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(b.itemId, 'Article invalide.'), req.org.id);
  if (!it0 || !A.visible(req, it0)) throw new HttpError(404, 'Article introuvable.');
  const moved = [];
  await db.transaction(async () => {
    const it = await W.lockItem(req.org.id, it0.id);
    const have = await W.levelAt(it.id, from.id);
    const q = b.quantity === undefined || b.quantity === '' ? have : A.qty(b.quantity);
    if (q - have > W.EPS) throw new HttpError(400, `Il n'y a que ${have} ${it.unit} à l'emplacement ${from.code}.`);
    const parts = b.toLocationId ? [{ locationId: (await W.locationFor(req, b.toLocationId)).id, quantity: q }] : (await W.putawayParts(req.org.id, it, q)).filter((p) => p.locationId !== from.id);
    if (!parts.length) throw new HttpError(400, "Aucune règle de rangement ne désigne un autre emplacement : choisissez la destination.");
    for (const p of parts) { await W.relocate(req, it, from.id, p.locationId, p.quantity, { kind: 'putaway', reason: 'Rangement' }); moved.push(p); }
  })();
  res.json({ ok: true, moved });
});

module.exports = router;
