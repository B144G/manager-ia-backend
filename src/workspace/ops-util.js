'use strict';
// Petits outils communs aux modules « production », « maintenance » et « chantiers » (aucune route ici).
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const today = () => nowISO().slice(0, 10);
/** Ajoute n jours à une date AAAA-MM-JJ. */
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const oneLine = (s, n = 80) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const round3 = (n) => Math.round(n * 1000) / 1000;
const money = (n, cur) => `${Number(n || 0).toLocaleString('fr-FR')} ${cur || ''}`.trim();

/** Nombre positif ou nul (vide = valeur par défaut). */
function nonneg(v, def = 0, { max = 1e12, msg = 'Nombre invalide : indiquez un nombre positif ou zéro.', int = false } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : v;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, msg);
  return int ? Math.round(n) : Math.round(n * 1000) / 1000;
}
const pct = (v, def = 0) => nonneg(v, def, { max: 100, msg: 'Pourcentage invalide (entre 0 et 100).' });

/** Article du stock de l'organisation (visible pour l'antenne de la personne). */
async function stockItem(req, id) {
  const it = await db.prepare('SELECT * FROM stock_items WHERE id = ? AND org_id = ?').get(A.id(id, 'Article invalide.'), req.org.id);
  if (!it || !A.visible(req, it)) throw new HttpError(404, 'Article introuvable dans le stock.');
  return it;
}

/**
 * Mouvement de stock (entrée si delta > 0, sortie si delta < 0) : met à jour la quantité ET écrit la ligne de l'historique, comme le module Stock.
 * Comme lui, il gère les lots (sortie FEFO/FIFO), les séries et le coût moyen (voir stock-lib.js ; opts = { unitCost, lotNo, expiry, serials… }).
 * À appeler dans une transaction. Refuse un stock négatif.
 */
async function moveStock(req, itemId, delta, reason, opts = {}) {
  const it = await stockItem(req, itemId);
  const r = await require('./stock-lib').adjust(req, it, delta, reason, opts);
  return { ...it, quantity: r.quantity };
}

module.exports = { today, addDays, diffDays, oneLine, round3, money, nonneg, pct, stockItem, moveStock };
