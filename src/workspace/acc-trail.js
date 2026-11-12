'use strict';
// Comptabilité : écritures sans justificatif et piste d'audit (qui a passé quoi, quand). Lecture seule : rien n'est écrit ici.
// Réservé aux administrateurs (le routeur parent l'impose déjà).
const express = require('express');
const { db } = require('../db');

const router = express.Router({ mergeParams: true });

const yearOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : new Date().getUTCFullYear(); };

/** Écritures saisies à la main (hors factures, achats, annulations, etc.) dont le numéro de pièce est vide. */
router.get('/unsupported', async (req, res) => {
  const year = yearOf(req.query.year);
  const rows = await db.prepare(`SELECT e.id, e.journal, e.number, e.date, e.label, e.created_at,
      (SELECT COALESCE(SUM(l.debit), 0) FROM acc_lines l WHERE l.entry_id = e.id) AS total
    FROM acc_entries e
    WHERE e.org_id = ? AND e.date >= ? AND e.date <= ? AND COALESCE(TRIM(e.piece), '') = '' AND COALESCE(e.source, '') = '' AND e.reversed_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM acc_entries r WHERE r.org_id = e.org_id AND r.reversed_of = e.id)
    ORDER BY e.date DESC, e.id DESC LIMIT 300`).all(req.org.id, `${year}-01-01`, `${year}-12-31`);
  const total = rows.reduce((s, r) => s + Number(r.total), 0);
  res.json({ year, count: rows.length, total, entries: rows.map((r) => ({ id: Number(r.id), journal: r.journal, number: r.number, date: r.date, label: r.label, total: Number(r.total), createdAt: r.created_at })) });
});

/** Piste d'audit : les écritures de l'exercice, de la plus récente à la plus ancienne, avec l'auteur et l'origine. Les écritures ne se modifient pas : la piste est complète. */
router.get('/audit-trail', async (req, res) => {
  const year = yearOf(req.query.year);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = await db.prepare(`SELECT e.id, e.journal, e.number, e.date, e.label, e.piece, e.source, e.reversed_of, e.created_at, u.name AS author,
      (SELECT COALESCE(SUM(l.debit), 0) FROM acc_lines l WHERE l.entry_id = e.id) AS total,
      (SELECT r.number FROM acc_entries r WHERE r.id = e.reversed_of) AS reversed_number,
      (SELECT r.number FROM acc_entries r WHERE r.org_id = e.org_id AND r.reversed_of = e.id LIMIT 1) AS cancelled_by
    FROM acc_entries e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.org_id = ? AND e.date >= ? AND e.date <= ?
    ORDER BY e.id DESC LIMIT ?`).all(req.org.id, `${year}-01-01`, `${year}-12-31`, limit);
  const count = Number((await db.prepare('SELECT COUNT(*) AS n FROM acc_entries WHERE org_id = ? AND date >= ? AND date <= ?').get(req.org.id, `${year}-01-01`, `${year}-12-31`)).n);
  const byAuthor = await db.prepare(`SELECT COALESCE(u.name, '') AS author, COUNT(*) AS n FROM acc_entries e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.org_id = ? AND e.date >= ? AND e.date <= ? GROUP BY u.name ORDER BY n DESC`).all(req.org.id, `${year}-01-01`, `${year}-12-31`);
  res.json({
    year, count, shown: rows.length,
    byAuthor: byAuthor.map((a) => ({ author: a.author, count: Number(a.n) })),
    entries: rows.map((r) => ({
      id: Number(r.id), journal: r.journal, number: r.number, date: r.date, label: r.label, piece: r.piece || '', source: r.source || '',
      author: r.author || '', createdAt: r.created_at, total: Number(r.total),
      reversesNumber: r.reversed_number || '', cancelledBy: r.cancelled_by || '',
    })),
  });
});

module.exports = router;
