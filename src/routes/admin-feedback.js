'use strict';
// Administration — avis et recommandations (fondateur). Monté dans routes/admin.js APRÈS requireAdmin sous /feedback.
//   GET  /feedback                 liste filtrable (type, module, note, statut, recherche, période) + pagination
//   GET  /feedback/stats           indicateurs : note moyenne, NPS, évolution, répartition, modules les plus cités
//   GET  /feedback/digest          résumé quotidien (?day=AAAA-MM-JJ, par défaut hier)
//   GET  /feedback/export.csv      export CSV (mêmes filtres)
//   GET  /feedback/:id             détail + notes internes (passe un avis « nouveau » à « lu »)
//   GET  /feedback/:id/screenshot  capture jointe
//   PUT  /feedback/:id             statut, note interne (réponse interne), approbation du témoignage public
// Les écritures sont aussi inscrites au journal d'audit par le routeur d'administration. Un avis anonyme n'affiche ni nom ni organisation.
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const central = require('../security');
const F = require('../services/feedback');
const { HttpError } = require('../util');

const router = express.Router();
const likeEsc = (q) => '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
const num = (v) => Number(v) || 0;
router.use(limits.make(60 * 1000, 120, 'Trop de requêtes. Patientez une minute.'));

function filters(q) {
  const w = []; const a = [];
  if (q.kind) { if (!F.KINDS.includes(q.kind)) throw new HttpError(400, 'Type inconnu.'); w.push('f.kind = ?'); a.push(q.kind); }
  if (q.module) { w.push('f.module = ?'); a.push(String(q.module).slice(0, 40)); }
  if (q.stars) { const n = F.intIn(q.stars, 1, 5, 'Note invalide.'); w.push('f.stars = ?'); a.push(n); }
  if (q.maxStars) { const n = F.intIn(q.maxStars, 1, 5, 'Note invalide.'); w.push('f.stars <= ?'); a.push(n); }
  if (q.status) { if (!F.STATUSES.includes(q.status)) throw new HttpError(400, 'Statut inconnu.'); w.push('f.status = ?'); a.push(q.status); }
  else if (q.open === '1') w.push("f.status IN ('new', 'read', 'in_progress')");
  if (q.public === 'pending') w.push('f.public_consent = 1 AND f.approved_at IS NULL');
  else if (q.public === 'approved') w.push('f.public_consent = 1 AND f.approved_at IS NOT NULL');
  if (q.q) { w.push("f.body ILIKE ? ESCAPE '\\'"); a.push(likeEsc(String(q.q).slice(0, 100))); }
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { w.push('f.created_at >= ?'); a.push(q.from); }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { w.push('f.created_at < ?'); a.push(new Date(Date.parse(q.to) + 86400000).toISOString()); }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
}

const FROM = 'FROM fb_feedback f JOIN orgs o ON o.id = f.org_id LEFT JOIN users u ON u.id = f.user_id';
const view = (r, full) => {
  const anon = Number(r.anonymous) === 1;
  return {
    id: Number(r.id), kind: r.kind, kindLabel: F.KIND_LABEL[r.kind], module: r.module, moduleTitle: F.moduleTitle(r.module), stars: Number(r.stars), nps: r.nps == null ? null : Number(r.nps),
    body: full ? r.body : String(r.body).slice(0, 220), truncated: !full && String(r.body).length > 220, anonymous: anon,
    author: anon ? null : { name: r.u_name || r.display_name || '', org: r.org_name, orgId: Number(r.org_id) },
    page: r.page, lang: r.lang, status: r.status, statusLabel: F.STATUS_LABEL[r.status], publicConsent: Number(r.public_consent) === 1, approved: !!r.approved_at, approvedAt: r.approved_at,
    publicName: anon ? '' : r.display_name, hasScreenshot: Number(r.shot_size) > 0, notes: num(r.notes), createdAt: r.created_at, updatedAt: r.updated_at,
  };
};

router.get('/', async (req, res) => {
  const { where, args } = filters(req.query);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100); const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const total = num((await db.prepare(`SELECT COUNT(*) AS n ${FROM} ${where}`).get(...args)).n);
  const rows = await db.prepare(`SELECT f.*, o.name AS org_name, u.name AS u_name, (SELECT COUNT(*) FROM fb_notes n WHERE n.feedback_id = f.id) AS notes ${FROM} ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({ total, limit, offset, items: rows.map((r) => view(r, false)) });
});

router.get('/stats', async (req, res) => res.json(await F.stats(req.query.days)));

router.get('/digest', async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? req.query.day : new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  res.json({ ...(await F.digest(day)), channels: { email: F.channelOn('email'), whatsapp: F.channelOn('whatsapp') } });
});

// CSV : UTF-8 avec BOM, séparateur point-virgule (s'ouvre dans Excel) ; le texte commençant par = + - @ est neutralisé (injection de formule).
const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
router.get('/export.csv', async (req, res) => {
  const { where, args } = filters(req.query);
  const rows = await db.prepare(`SELECT f.*, o.name AS org_name, u.name AS u_name, (SELECT COUNT(*) FROM fb_notes n WHERE n.feedback_id = f.id) AS notes ${FROM} ${where} ORDER BY f.id DESC LIMIT 20000`).all(...args);
  const lines = [['id', 'date', 'type', 'module', 'note', 'recommandation_0_10', 'statut', 'anonyme', 'auteur', 'organisation', 'consentement_public', 'approuve', 'page', 'langue', 'capture', 'notes_internes', 'message'].join(';')];
  for (const r of rows) {
    const v = view(r, true);
    lines.push([v.id, v.createdAt, v.kindLabel, v.moduleTitle, v.stars, v.nps == null ? '' : v.nps, v.statusLabel, v.anonymous ? 'oui' : 'non', v.author ? v.author.name : '', v.author ? v.author.org : '', v.publicConsent ? 'oui' : 'non', v.approved ? 'oui' : 'non', v.page, v.lang, v.hasScreenshot ? 'oui' : 'non', v.notes, v.body].map(csvCell).join(';'));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="avis-${nowISO().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

async function load(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'Avis introuvable.');
  const r = await db.prepare(`SELECT f.*, o.name AS org_name, u.name AS u_name, (SELECT COUNT(*) FROM fb_notes n WHERE n.feedback_id = f.id) AS notes ${FROM} WHERE f.id = ?`).get(n);
  if (!r) throw new HttpError(404, 'Avis introuvable.');
  return r;
}
const notesOf = async (id) => (await db.prepare('SELECT id, body, created_at FROM fb_notes WHERE feedback_id = ? ORDER BY id').all(id)).map((n) => ({ id: Number(n.id), body: n.body, createdAt: n.created_at }));

router.get('/:id', async (req, res) => {
  let r = await load(req.params.id);
  if (r.status === 'new') { await db.prepare("UPDATE fb_feedback SET status = 'read', updated_at = ? WHERE id = ? AND status = 'new'").run(nowISO(), r.id); r = await load(r.id); }
  res.json({ item: view(r, true), notes: await notesOf(r.id) });
});

router.get('/:id/screenshot', async (req, res) => {
  const r = await load(req.params.id);
  const data = Number(r.shot_size) > 0 ? require('../workspace/legal-extra').unseal(r.shot) : null;
  if (!data) throw new HttpError(404, 'Aucune capture.');
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Type': r.shot_mime, 'Content-Length': data.length });
  res.end(data);
});

router.put('/:id', async (req, res) => {
  const r = await load(req.params.id);
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const sets = []; const args = []; const changes = [];
  if (b.status !== undefined) {
    if (!F.STATUSES.includes(b.status)) throw new HttpError(400, 'Statut inconnu.');
    if (b.status !== r.status) { sets.push('status = ?'); args.push(b.status); changes.push(`statut ${r.status}→${b.status}`); }
  }
  if (b.approved !== undefined) {
    const on = F.bool(b.approved);
    if (on) { // jamais sans le consentement de l'auteur, et seulement pour un avis rédigé
      if (Number(r.public_consent) !== 1) throw new HttpError(409, "L'auteur n'a pas consenti à l'affichage public : impossible d'approuver.");
      if (r.kind !== 'review' || String(r.body).length < 10) throw new HttpError(409, 'Seul un avis rédigé peut devenir un témoignage.');
      if (!r.approved_at) { sets.push('approved_at = ?'); args.push(nowISO()); changes.push('témoignage approuvé'); }
    } else if (r.approved_at) { sets.push('approved_at = NULL'); changes.push('témoignage retiré'); }
  }
  const note = F.clean(b.note, F.NOTE_MAX);
  if (b.note !== undefined && typeof b.note !== 'string') throw new HttpError(400, 'Note invalide.');
  if (b.status === undefined && b.approved === undefined && !note) throw new HttpError(400, 'Rien à modifier.');
  await db.transaction(async () => {
    if (sets.length) await db.prepare(`UPDATE fb_feedback SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, nowISO(), r.id);
    if (note) { await db.prepare('INSERT INTO fb_notes (feedback_id, body, created_at) VALUES (?, ?, ?)').run(r.id, note, nowISO()); changes.push('note interne'); }
  })();
  await central.audit.record(req, 'feedback.admin_update', { target: `feedback:${r.id}`, detail: changes.join(', ') });
  const nr = await load(r.id);
  res.json({ item: view(nr, true), notes: await notesOf(r.id) });
});

module.exports = router;
