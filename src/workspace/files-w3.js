'use strict';
// Pièces jointes chiffrées pour le dossier du personnel et les projets : mêmes règles que le juridique (PDF ou image reconnus d'après le CONTENU,
// 2 Mo, chiffrement AES-256-GCM dans la base, en-têtes de sécurité), réutilisant la table legal_files et les fonctions de legal-extra.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const X = require('./legal-extra');
const limits = require('../middleware/limits');
const W = require('./w3');
const { HttpError, cleanText } = require('../util');

const MAX_FILE = 2 * 1024 * 1024; const MAX_PER_PARENT = 10; const MAX_ORG = 40 * 1024 * 1024;
const upLimit = limits.make(10 * 60 * 1000, 40, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");

/** opts = { type: 'employee', table: 'employees', role: 'admin', label, scopeCheck?(req, row) } ; routes : GET/POST {base}/:id/files, GET/DELETE {base}/files/:fid */
function mount(router, base, opts) {
  const parent = async (req) => {
    const row = await db.prepare(`SELECT * FROM ${opts.table} WHERE id = ? AND org_id = ?`).get(A.id(req.params.id), req.org.id);
    if (!row || (opts.scopeCheck && !opts.scopeCheck(req, row))) throw new HttpError(404, `${opts.label} introuvable.`);
    return row;
  };
  router.get(`${base}/:id/files`, A.need(opts.role), async (req, res) => {
    const p = await parent(req);
    const rows = await db.prepare('SELECT id, parent_type, parent_id, name, mime, size, created_at FROM legal_files WHERE org_id = ? AND parent_type = ? AND parent_id = ? ORDER BY id').all(req.org.id, opts.type, p.id);
    res.json({ files: rows.map(X.fileView), limits: { maxBytes: MAX_FILE, perItem: MAX_PER_PARENT } });
  });
  router.post(`${base}/:id/files`, A.need(opts.role), upLimit, express.raw({ type: () => true, limit: MAX_FILE + 1024 }), async (req, res) => {
    const p = await parent(req);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const t = X.sniff(buf);
    if (!t) throw new HttpError(400, 'Fichier non reconnu : envoyez un PDF ou une image (JPEG, PNG, WebP).');
    if (buf.length > MAX_FILE) throw new HttpError(413, 'Fichier trop lourd (2 Mo au plus).');
    const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM legal_files WHERE org_id = ? AND parent_type = ? AND parent_id = ?').get(req.org.id, opts.type, p.id)).c);
    if (n >= MAX_PER_PARENT) throw new HttpError(403, `Il y a déjà ${MAX_PER_PARENT} fichiers ici. Supprimez-en un pour en ajouter.`);
    const used = Number((await db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM legal_files WHERE org_id = ?').get(req.org.id)).s);
    if (used + buf.length > MAX_ORG) throw new HttpError(403, "Espace de fichiers plein (40 Mo). Supprimez d'anciens fichiers.");
    const baseName = cleanText(String(req.query.name || ''), 80).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'document';
    const name = `${baseName}.${t.ext}`;
    const id = Number((await db.prepare('INSERT INTO legal_files (org_id, parent_type, parent_id, name, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, opts.type, p.id, name, t.mime, buf.length, X.seal(buf), req.user.id, nowISO())).lastInsertRowid);
    await W.audit(req, opts.type + '_file', id, 'create', null, { name, parent: p.id });
    await A.logActivity(req.org.id, req.user.id, opts.module, `Pièce jointe « ${name} » ajoutée`);
    res.status(201).json({ id, name, mime: t.mime });
  });
  const file = async (req) => {
    const x = await db.prepare('SELECT * FROM legal_files WHERE id = ? AND org_id = ? AND parent_type = ?').get(A.id(req.params.fid), req.org.id, opts.type);
    if (!x) throw new HttpError(404, 'Fichier introuvable.');
    const p = await db.prepare(`SELECT * FROM ${opts.table} WHERE id = ? AND org_id = ?`).get(x.parent_id, req.org.id);
    if (!p || (opts.scopeCheck && !opts.scopeCheck(req, p))) throw new HttpError(404, 'Fichier introuvable.');
    return x;
  };
  router.get(`${base}/files/:fid/file`, A.need(opts.role), async (req, res) => {
    const x = await file(req);
    const data = X.unseal(x.data);
    if (!data) throw new HttpError(500, 'Ce fichier ne peut pas être relu (clé de chiffrement modifiée).');
    await W.audit(req, opts.type + '_file', x.id, 'download', null, { name: x.name });
    res.set({ 'Content-Type': x.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `attachment; filename="${x.name.replace(/[^\w.\- ]/g, '_')}"` });
    res.end(data);
  });
  router.delete(`${base}/files/:fid`, A.need(opts.role), async (req, res) => {
    const x = await file(req);
    await db.prepare('DELETE FROM legal_files WHERE id = ?').run(x.id);
    await W.audit(req, opts.type + '_file', x.id, 'delete', { name: x.name }, null);
    res.json({ ok: true });
  });
}
const dropFor = async (orgId, type, id) => { await db.prepare('DELETE FROM legal_files WHERE org_id = ? AND parent_type = ? AND parent_id = ?').run(orgId, type, id); };

module.exports = { mount, dropFor };
