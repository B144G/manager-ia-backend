'use strict';
// Mouvements de stock « avancés », partagés par Stock, Production, Maintenance, Logistique et Inventaire (aucune route ici) :
//  - lots avec date de péremption : les sorties consomment les lots dans l'ordre FEFO (le plus proche de la péremption d'abord) ou FIFO (le plus ancien d'abord) ;
//  - numéros de série (ou VIN pour un véhicule) : un numéro = une unité, jamais en double dans l'organisation ;
//  - coût moyen pondéré (CUMP) recalculé à chaque entrée valorisée.
// Tout passe par adjust() : la quantité de l'article, l'historique (stock_moves), les lots et les séries restent toujours d'accord.
const { db, nowISO } = require('../db');
const { HttpError } = require('../util');

const round3 = (n) => Math.round(n * 1000) / 1000;
const today = () => nowISO().slice(0, 10);
const TRACKING = ['none', 'lot', 'serial'];

/** Liste de numéros de série depuis un tableau ou un texte (un par ligne, virgule ou point-virgule). */
function parseSerials(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\n,;]+/);
  const out = raw.map((s) => String(s).trim().toUpperCase().replace(/\s+/g, '')).filter(Boolean);
  if (out.some((s) => s.length > 40 || !/^[A-Z0-9._\/-]+$/.test(s))) throw new HttpError(400, 'Numéro de série invalide : lettres, chiffres, tirets et points seulement (40 caractères au plus).');
  if (new Set(out).size !== out.length) throw new HttpError(400, 'Un numéro de série apparaît deux fois dans la liste.');
  if (out.length > 500) throw new HttpError(400, '500 numéros de série au plus par opération.');
  return out;
}

/** Sort `qty` des lots (FEFO ou FIFO). Les lots périmés sont ignorés sauf allowExpired. Renvoie les lots utilisés. */
async function consumeLots(it, qty, { allowExpired = false } = {}) {
  const order = it.pick_rule === 'fifo' ? 'received_at, id' : 'expiry IS NULL, expiry, received_at, id';
  const all = await db.prepare(`SELECT * FROM stock_lots WHERE item_id = ? AND quantity > 0 ORDER BY ${order}`).all(it.id);
  const usable = allowExpired ? all : all.filter((l) => !l.expiry || l.expiry >= today());
  const have = round3(usable.reduce((a, l) => a + l.quantity, 0));
  if (have + 1e-9 < qty) {
    const expired = round3(all.reduce((a, l) => a + l.quantity, 0) - have);
    throw new HttpError(400, expired > 0 ? `Stock utilisable insuffisant pour « ${it.name} » : il reste ${have} ${it.unit} hors lots périmés (${expired} ${it.unit} périmés).` : `Stock insuffisant pour « ${it.name} » : il reste ${have} ${it.unit}.`);
  }
  let left = qty; const used = [];
  for (const l of usable) {
    if (left <= 1e-9) break;
    const take = round3(Math.min(l.quantity, left));
    await db.prepare('UPDATE stock_lots SET quantity = ? WHERE id = ?').run(round3(l.quantity - take), l.id);
    used.push({ lotId: l.id, lotNo: l.lot_no, expiry: l.expiry, quantity: take });
    left = round3(left - take);
  }
  return used;
}

/** Ajoute `qty` dans le lot (même numéro et même péremption = même lot). */
async function addToLot(orgId, it, { lotNo, expiry, quantity, unitCost, lotId }) {
  if (lotId) {
    const l = await db.prepare('SELECT * FROM stock_lots WHERE id = ? AND item_id = ?').get(lotId, it.id);
    if (l) { await db.prepare('UPDATE stock_lots SET quantity = ? WHERE id = ?').run(round3(l.quantity + quantity), l.id); return l.id; }
  }
  const no = String(lotNo || 'SANS-LOT').slice(0, 40);
  const ex = expiry || null;
  const same = await db.prepare('SELECT * FROM stock_lots WHERE item_id = ? AND lot_no = ? AND COALESCE(expiry, \'\') = ?').get(it.id, no, ex || '');
  if (same) { await db.prepare('UPDATE stock_lots SET quantity = ? WHERE id = ?').run(round3(same.quantity + quantity), same.id); return same.id; }
  const now = nowISO();
  return Number((await db.prepare('INSERT INTO stock_lots (org_id, item_id, lot_no, expiry, quantity, unit_cost, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(orgId, it.id, no, ex, quantity, Math.round(unitCost || 0), now, now)).lastInsertRowid);
}

/**
 * Mouvement de stock d'un article (entrée si delta > 0, sortie si delta < 0). Dans une transaction.
 *  opts : unitCost (valorise l'entrée : met à jour le CUMP), lotNo / expiry (article suivi par lot), serials (article suivi par série),
 *         allocations (retour : remet les quantités dans les lots d'origine), strict (réclame lot / séries : saisie manuelle),
 *         refKind / refId (origine : livraison, inventaire…), allowExpired.
 * Renvoie { quantity, allocations, serials }.
 */
async function adjust(req, itemOrId, delta, reason, opts = {}) {
  return await db.transaction(async () => {
    const id = typeof itemOrId === 'object' ? itemOrId.id : itemOrId;
    const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ? FOR UPDATE').get(id, req.org.id);
    if (!it) throw new HttpError(404, 'Article introuvable.');
    delta = round3(delta);
    if (!delta) return { quantity: it.quantity, allocations: [], serials: [] };
    const next = round3(it.quantity + delta);
    if (next < 0) throw new HttpError(400, `Stock insuffisant pour « ${it.name} » : il reste ${it.quantity} ${it.unit}.`);
    let allocations = []; let serials = [];
    if (it.tracking === 'lot') {
      if (delta > 0) {
        if (opts.allocations && opts.allocations.length) {
          for (const a of opts.allocations) await addToLot(req.org.id, it, { lotId: a.lotId, lotNo: a.lotNo, expiry: a.expiry, quantity: a.quantity, unitCost: opts.unitCost });
          allocations = opts.allocations;
        } else {
          if (opts.strict && !String(opts.lotNo || '').trim()) throw new HttpError(400, `« ${it.name} » est suivi par lot : indiquez le numéro de lot.`);
          if (opts.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(opts.expiry)) throw new HttpError(400, 'Date de péremption invalide (AAAA-MM-JJ).');
          const lotId = await addToLot(req.org.id, it, { lotNo: String(opts.lotNo || '').trim() || 'SANS-LOT', expiry: opts.expiry, quantity: delta, unitCost: opts.unitCost });
          allocations = [{ lotId, lotNo: String(opts.lotNo || '').trim() || 'SANS-LOT', expiry: opts.expiry || null, quantity: delta }];
        }
      } else allocations = await consumeLots(it, -delta, { allowExpired: opts.allowExpired });
    } else if (it.tracking === 'serial') {
      if (!Number.isInteger(delta)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : la quantité est un nombre entier.`);
      const list = parseSerials(opts.serials);
      if (list.length !== Math.abs(delta)) throw new HttpError(400, `« ${it.name} » est suivi par numéro de série : indiquez exactement ${Math.abs(delta)} numéro(s) (${list.length} reçu(s)).`);
      const now = nowISO();
      for (const s of list) {
        const row = await db.prepare('SELECT * FROM stock_serials WHERE org_id = ? AND serial = ?').get(req.org.id, s);
        if (delta > 0) {
          if (row && row.status === 'in_stock') throw new HttpError(409, `Le numéro de série ${s} est déjà en stock.`);
          if (row && row.item_id !== it.id) throw new HttpError(409, `Le numéro de série ${s} appartient à un autre article.`);
          if (row) await db.prepare("UPDATE stock_serials SET status = 'in_stock', out_at = NULL, out_note = '' WHERE id = ?").run(row.id);
          else await db.prepare("INSERT INTO stock_serials (org_id, item_id, serial, status, received_at, created_at) VALUES (?, ?, ?, 'in_stock', ?, ?)").run(req.org.id, it.id, s, now, now);
        } else {
          if (!row || row.item_id !== it.id || row.status !== 'in_stock') throw new HttpError(400, `Le numéro de série ${s} n'est pas en stock pour « ${it.name} ».`);
          await db.prepare("UPDATE stock_serials SET status = 'out', out_at = ?, out_note = ? WHERE id = ?").run(now, String(reason).slice(0, 150), row.id);
        }
      }
      serials = list;
    }
    // Coût moyen pondéré : seulement sur une entrée valorisée.
    let avg = Number(it.avg_cost) || 0;
    if (delta > 0 && opts.unitCost !== undefined && opts.unitCost !== null && Number.isFinite(Number(opts.unitCost))) {
      const base = Math.max(it.quantity, 0);
      avg = base + delta > 0 ? (base * avg + delta * Number(opts.unitCost)) / (base + delta) : Number(opts.unitCost);
      avg = Math.round(avg * 100) / 100;
    }
    await db.prepare('UPDATE stock_items SET quantity = ?, avg_cost = ? WHERE id = ?').run(next, avg, it.id);
    await db.prepare('INSERT INTO stock_moves (org_id, item_id, delta, reason, created_by, created_at, unit_cost, ref_kind, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, it.id, delta, String(reason).slice(0, 150), req.user ? req.user.id : null, nowISO(), opts.unitCost === undefined ? null : Number(opts.unitCost), opts.refKind || '', opts.refId || null);
    return { quantity: next, allocations, serials };
  })();
}

/** Valeur unitaire retenue pour valoriser le stock : CUMP si connu, sinon dernier coût d'achat. */
const unitValue = (it) => (Number(it.avg_cost) > 0 ? Number(it.avg_cost) : Number(it.unit_cost) || 0);

module.exports = { adjust, consumeLots, addToLot, parseSerials, unitValue, round3, TRACKING };
