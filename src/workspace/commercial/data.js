'use strict';
// Lecture commune des ventes (factures émises, nettes des avoirs) pour la prévision, la performance, les marges et la fidélité.
const { db } = require('../../db');
const L = require('./lib');

const N = (v) => Number(v) || 0;
/** Factures émises (envoyées ou payées) entre deux dates, avec leur client (propriétaire, zone, ville, secteur) et leurs lignes. */
async function invoices(orgId, { from, to } = {}) {
  const rows = await db.prepare(`SELECT d.id, d.number, d.customer_id, d.issued, d.total, d.credited, d.paid, d.status, d.lines, d.created_by, d.vat_rate, d.prices_incl, d.subtotal_ht, c.name AS customer, c.owner_id, c.zone_id, c.city, c.sector, c.stage
    FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.org_id = ? AND d.kind = 'invoice' AND d.status IN ('sent','paid')${from ? ' AND d.issued >= ?' : ''}${to ? ' AND d.issued <= ?' : ''} ORDER BY d.issued, d.id`)
    .all(orgId, ...(from ? [from] : []), ...(to ? [to] : []));
  return rows.map((d) => {
    let lines = []; try { lines = JSON.parse(d.lines || '[]'); } catch { lines = []; }
    return { id: Number(d.id), number: d.number, customerId: Number(d.customer_id), customer: d.customer, issued: d.issued, month: d.issued.slice(0, 7), total: N(d.total), credited: N(d.credited), net: N(d.total) - N(d.credited), paid: N(d.paid), lines,
      ownerId: d.owner_id ? Number(d.owner_id) : (d.created_by ? Number(d.created_by) : null), zoneId: d.zone_id ? Number(d.zone_id) : null, city: d.city || '', sector: d.sector || '', vatRate: d.vat_rate, pricesIncl: Number(d.prices_incl) === 1, subtotalHt: d.subtotal_ht === null ? null : N(d.subtotal_ht), createdBy: d.created_by ? Number(d.created_by) : null, ownerKnown: Boolean(d.owner_id) };
  });
}
const matchProduct = (lines, product) => { const p = L.normName(product); return !p || lines.some((l) => L.normName(l.label).includes(p)); };
/** Ventes nettes par mois : Map mois → montant. Filtres facultatifs : commercial, zone, produit (lignes dont le libellé contient le texte). */
function byMonth(list, { ownerId, zoneId, product } = {}) {
  const m = new Map();
  for (const d of list) {
    if (ownerId && d.ownerId !== Number(ownerId)) continue;
    if (zoneId && d.zoneId !== Number(zoneId)) continue;
    let amount = d.net;
    if (product) {
      if (!matchProduct(d.lines, product)) continue;
      const p = L.normName(product);
      const sum = d.lines.reduce((a, l) => a + N(l.quantity) * N(l.price), 0);
      const part = d.lines.filter((l) => L.normName(l.label).includes(p)).reduce((a, l) => a + N(l.quantity) * N(l.price), 0);
      amount = sum ? Math.round((d.net * part) / sum) : 0;
    }
    m.set(d.month, (m.get(d.month) || 0) + amount);
  }
  return m;
}
const series = (map, from, to) => L.monthsBetween(from, to).map((mo) => map.get(mo) || 0);
module.exports = { invoices, byMonth, series, matchProduct, N };
