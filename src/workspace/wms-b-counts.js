'use strict';
// Entrepôt (fusion, apport de la ligne B) : inventaire PAR EMPLACEMENT et comptage à l'aveugle.
// C'est un inventaire normal (stock_counts : comptage → soumission → validation par une autre personne) limité à un emplacement :
// la quantité attendue est celle de l'emplacement, et l'écart ajuste CET emplacement (stock.js passe locationId à adjust).
// À l'aveugle : pendant le comptage, ni la quantité attendue ni l'écart ne sont visibles (stock.js les cache ; ils apparaissent à la soumission).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const L = require('./stock-lib');
const W = require('./wms-core');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager');

router.post('/location-counts', mgr, async (req, res) => {
  const b = req.body || {};
  const loc = await W.locationFor(req, A.id(b.locationId, 'Emplacement introuvable.'));
  if (loc.kind === 'transit') throw new HttpError(400, "L'emplacement « En transit » ne se compte pas : ouvrez le transfert.");
  if (await db.prepare("SELECT 1 FROM stock_counts WHERE org_id = ? AND status IN ('open','submitted')").get(req.org.id)) throw new HttpError(409, "Un inventaire est déjà en cours : terminez-le (validation ou rejet) avant d'en ouvrir un autre.");
  const rows = await db.prepare(`SELECT i.*, v.quantity AS at_loc FROM wms_stock v JOIN stock_items i ON i.id = v.item_id WHERE v.location_id = ? AND v.quantity > 0 AND i.tracking <> 'serial' ORDER BY i.name COLLATE NOCASE`).all(loc.id);
  const lines = rows.filter((i) => A.visible(req, i));
  if (!lines.length && !(Array.isArray(b.itemIds) && b.itemIds.length)) throw new HttpError(400, 'Cet emplacement est vide : indiquez les articles à compter (ceux que vous pensez y trouver).');
  const now = nowISO();
  const blind = b.blind === true || b.blind === 'true';
  const id = await db.transaction(async () => {
    const seq = Number((await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM stock_counts WHERE org_id = ?').get(req.org.id)).n);
    const cid = Number((await db.prepare('INSERT INTO stock_counts (org_id, branch_id, seq, status, note, created_by, created_at, location_id, blind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, loc.branch_id || null, seq, 'open', A.text(b.note, 300) || `Inventaire de l'emplacement ${loc.code}`, req.user.id, now, loc.id, blind ? 1 : 0)).lastInsertRowid);
    const seen = new Set();
    for (const i of lines) { seen.add(Number(i.id)); await db.prepare('INSERT INTO stock_count_lines (count_id, item_id, expected, unit_value) VALUES (?, ?, ?, ?)').run(cid, i.id, i.at_loc, L.unitValue(i)); }
    for (const raw of Array.isArray(b.itemIds) ? b.itemIds.slice(0, 200) : []) {
      const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(raw, 'Article invalide.'), req.org.id);
      if (!it || !A.visible(req, it) || it.tracking === 'serial' || seen.has(Number(it.id))) continue;
      seen.add(Number(it.id));
      await db.prepare('INSERT INTO stock_count_lines (count_id, item_id, expected, unit_value) VALUES (?, ?, ?, ?)').run(cid, it.id, await W.qtyAt(loc.id, it.id), L.unitValue(it));
    }
    return cid;
  })();
  await A.logActivity(req.org.id, req.user.id, 'stock', `Inventaire de l'emplacement ${loc.code} ouvert${blind ? " (à l'aveugle)" : ''}`);
  res.status(201).json({ id, items: lines.length });
});

/** Inventaire d'un emplacement : ajouter un article trouvé sur place alors qu'il n'était pas attendu. */
router.post('/location-counts/:id/lines', mgr, async (req, res) => {
  const c = await db.prepare('SELECT * FROM stock_counts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c || !c.location_id) throw new HttpError(404, 'Inventaire introuvable.');
  if (c.status !== 'open') throw new HttpError(400, 'Ce comptage est terminé : il ne se modifie plus.');
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id((req.body || {}).itemId, 'Article invalide.'), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable.');
  if (it.tracking === 'serial') throw new HttpError(400, 'Les articles suivis par numéro de série se contrôlent par leur liste de numéros.');
  const at = await W.qtyAt(c.location_id, it.id);
  const r = await db.prepare('INSERT INTO stock_count_lines (count_id, item_id, expected, unit_value) VALUES (?, ?, ?, ?) ON CONFLICT (count_id, item_id) DO NOTHING').run(c.id, it.id, at, L.unitValue(it));
  res.status(201).json({ added: r.changes });
});

module.exports = router;
