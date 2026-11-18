'use strict';
// Trésorerie : dates (chaînes AAAA-MM-JJ, UTC) et nombres. Fonctions pures, sans base de données.
const dayMs = 86400000;
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => new Date(toMs(d) + n * dayMs).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / dayMs);
function addMonths(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}
const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
module.exports = { toMs, addDays, diffDays, addMonths, lastDay, num, isMonth };
