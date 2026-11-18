'use strict';
// Bibliothèque — gestion documentaire des versions : statut (brouillon / publié / obsolète), verrouillage pendant la modification,
// comparaison de deux versions (empreinte, taille, différences ligne à ligne pour les fichiers texte).
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const A = require('./access');
const X = require('./legal-extra');
const { HttpError } = require('../util');

const STATUSES = ['draft', 'published', 'obsolete'];
const MAX_LINES = 1500;

/** Différences ligne à ligne (plus longue sous-suite commune). */
function lineDiff(a, b) {
  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: '=', text: a[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] }); else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}
/** Garde seulement les lignes modifiées et 2 lignes de contexte autour. */
function collapse(lines, ctx = 2) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => { if (l.op !== '=') for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true; });
  const out = []; let skipped = 0;
  lines.forEach((l, i) => { if (keep[i]) { if (skipped) { out.push({ op: '~', text: String(skipped) }); skipped = 0; } out.push(l); } else skipped++; });
  if (skipped) out.push({ op: '~', text: String(skipped) });
  return out;
}

module.exports = function register(router, h) {
  const { audit } = h;
  Object.assign(h.ACTIONS, { doc_lock: 'Document verrouillé pour modification', doc_unlock: 'Document déverrouillé', doc_status: 'Statut du document modifié' });

  /** Refuse la modification d'un document verrouillé par quelqu'un d'autre. */
  h.checkLock = async (req, d) => {
    const cur = await db.prepare('SELECT locked_by FROM lib_docs WHERE id = ?').get(d.id);
    if (cur && cur.locked_by && Number(cur.locked_by) !== Number(req.user.id)) { const e = new HttpError(423, 'Ce document est verrouillé : une autre personne est en train de le modifier.'); e.errorCode = 'doc_locked'; throw e; }
  };

  router.post('/docs/:id/lock', async (req, res) => {
    const { d, b } = await h.openDoc(req, req.params.id, 'edit');
    await h.checkLock(req, d);
    await db.prepare('UPDATE lib_docs SET locked_by = ?, locked_at = ? WHERE id = ?').run(req.user.id, nowISO(), d.id);
    await audit(req, 'doc_lock', b, d.name);
    res.json({ ok: true });
  });
  router.post('/docs/:id/unlock', async (req, res) => {
    const { d, b } = await h.openDoc(req, req.params.id, 'edit');
    if (!d.locked_by) return res.json({ ok: true });
    // Le verrou se lève par la personne qui l'a posé, ou par un administrateur (personne absente, session perdue).
    if (Number(d.locked_by) !== Number(req.user.id) && !A.can(req, 'admin')) throw new HttpError(403, 'Seule la personne qui a verrouillé le document, ou un administrateur, peut le déverrouiller.');
    await db.prepare('UPDATE lib_docs SET locked_by = NULL, locked_at = NULL WHERE id = ?').run(d.id);
    await audit(req, 'doc_unlock', b, d.name);
    res.json({ ok: true });
  });
  router.put('/docs/:id/status', async (req, res) => {
    const { d, b } = await h.openDoc(req, req.params.id, 'edit');
    const status = A.oneOf((req.body || {}).status, STATUSES, undefined, 'Statut inconnu (brouillon, publié ou obsolète).');
    await h.checkLock(req, d);
    await db.prepare('UPDATE lib_docs SET doc_status = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(status, req.user.id, nowISO(), d.id);
    await audit(req, 'doc_status', b, `${d.name} : ${status}`);
    res.json({ ok: true, status });
  });

  router.get('/docs/:id/compare', async (req, res) => {
    const { d } = await h.openDoc(req, req.params.id, 'read');
    const q = req.query || {};
    const va = await h.versionOf(d, q.a); const vb = await h.versionOf(d, q.b);
    const names = await h.namesOf([va.created_by, vb.created_by]);
    const pa = X.unseal(va.data); const pb = X.unseal(vb.data);
    if (!pa || !pb) throw new HttpError(500, 'Fichier illisible.');
    const meta = (v, buf) => ({ n: Number(v.n), label: h.labelOf(v), name: v.name, mime: v.mime, size: Number(v.size), note: v.note, author: names[Number(v.created_by)] || '', createdAt: v.created_at, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    const A_ = meta(va, pa); const B_ = meta(vb, pb);
    const out = { a: A_, b: B_, identical: A_.sha256 === B_.sha256, sizeDelta: B_.size - A_.size, text: null };
    const isText = (m) => /^text\/(plain|csv)/.test(m);
    if (isText(va.mime) && isText(vb.mime) && !out.identical) {
      const la = pa.toString('utf8').split(/\r?\n/); const lb = pb.toString('utf8').split(/\r?\n/);
      if (la.length > MAX_LINES || lb.length > MAX_LINES) out.text = { tooLarge: true };
      else {
        const lines = lineDiff(la, lb);
        out.text = { tooLarge: false, added: lines.filter((l) => l.op === '+').length, removed: lines.filter((l) => l.op === '-').length, lines: collapse(lines) };
      }
    }
    res.json(out);
  });
};
module.exports.lineDiff = lineDiff;
