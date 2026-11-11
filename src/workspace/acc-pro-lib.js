'use strict';
// Comptabilité pro : petits outils communs (dates, montants, CSV, classement produits/charges, soldes). Aucune route ici.
const { db, nowISO } = require('../db');
const { HttpError } = require('../util');

const isDate = (s) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(s || '')) && !Number.isNaN(Date.parse(String(s)));
const today = () => nowISO().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const lastDayOf = (y, m) => new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
const int = (v) => (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 1e12 ? Math.round(Number(v)) : NaN);
const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const yearOf = (v) => {
  const y = String(v === undefined || v === null || v === '' ? today().slice(0, 4) : v);
  if (!/^\d{4}$/.test(y) || Number(y) < 1900) throw new HttpError(400, 'Année invalide.');
  return y;
};
/** Nombre de jours écoulés dans l'exercice (365 pour une année passée, jusqu'à aujourd'hui pour l'année en cours). */
const daysIn = (year) => {
  const t = today();
  if (String(year) < t.slice(0, 4)) return 365;
  if (String(year) > t.slice(0, 4)) return 0;
  return Math.max(1, Math.round((Date.parse(t) - Date.parse(`${year}-01-01`)) / 86400000) + 1);
};

// Mêmes classements que « statements() » : produits = classe 7 + 82, 84, 86, 88 ; charges = classe 6 + 81, 83, 85, 87, 89.
const isProduit = (a) => a[0] === '7' || /^8[2468]/.test(a);
const isCharge = (a) => a[0] === '6' || /^8[13579]/.test(a);

// Fragments SQL (alias « e » = acc_entries) : écritures de clôture du résultat et d'à-nouveaux, et leurs annulations.
const NOT_CLOSE = "e.source NOT IN ('year_end', 'year_end_rev')";
const NOT_OPEN = "e.source NOT IN ('year_open', 'year_open_rev')";

/** Soldes par compte entre deux dates ; opts.noClose / opts.noOpen comme accounting.balance. */
async function balances(orgId, from, to, opts = {}) {
  const extra = (opts.noClose ? ` AND ${NOT_CLOSE}` : '') + (opts.noOpen ? ` AND ${NOT_OPEN}` : '');
  const rows = await db.prepare(`SELECT l.account, a.label, SUM(l.debit) AS debit, SUM(l.credit) AS credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id LEFT JOIN acc_accounts a ON a.org_id = l.org_id AND a.code = l.account
    WHERE l.org_id = ? AND e.date >= ? AND e.date <= ?${extra} GROUP BY l.account, a.label ORDER BY l.account`).all(orgId, from, to);
  return rows.map((r) => ({ account: r.account, label: r.label || '', debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.debit) - Number(r.credit) }));
}
/** Somme des soldes (débit moins crédit) des comptes qui satisfont f. */
const sumBal = (rows, f) => rows.filter((r) => f(r.account)).reduce((a, r) => a + r.balance, 0);
const startsAny = (...p) => (a) => p.some((x) => a.startsWith(x));

// ---------- CSV (séparateur « ; », BOM UTF-8, comme export.csv) ----------
const cell = (v) => {
  if (typeof v === 'number') return `"${v}"`;
  let t = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // pas de formule Excel injectée par un libellé
  return `"${t.replace(/"/g, '""')}"`;
};
function sendCsv(res, filename, header, rows) {
  const out = [header.join(';'), ...rows.map((r) => r.map(cell).join(';'))];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.send('﻿' + out.join('\r\n'));
}

module.exports = { isDate, today, pad, lastDayOf, int, fmt, yearOf, daysIn, isProduit, isCharge, NOT_CLOSE, NOT_OPEN, balances, sumBal, startsAny, cell, sendCsv };

/** Opérations (factures, avoirs, paiements, achats) pas encore comptabilisées dont la date tombe entre from et to. */
async function pendingIn(org, from, to) {
  const p = await require('./accounting').pending(org);
  const ok = (d) => d >= from && d <= to;
  const out = {
    invoices: p.inv.filter((d) => ok(d.issued)).length + p.cn.filter((d) => ok(d.issued)).length,
    payments: p.pay.filter((x) => ok(x.date)).length,
    purchases: p.buy.filter((o) => ok(o.updated_at.slice(0, 10))).length + p.rec.filter((r) => ok(r.created_at.slice(0, 10))).length,
  };
  out.total = out.invoices + out.payments + out.purchases;
  return out;
}
module.exports.pendingIn = pendingIn;
