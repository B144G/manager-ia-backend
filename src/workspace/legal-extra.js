'use strict';
// Juridique : modèles de documents de l'organisation et pièces jointes (contrats, obligations, litiges).
// Pièces jointes : PDF ou image (JPEG, PNG, WebP) de 2 Mo au plus, type reconnu d'après le CONTENU, chiffrées (AES-256-GCM) dans la base,
// téléchargées seulement par un responsable de la même organisation, avec les mêmes en-têtes de sécurité que les fichiers du catalogue.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const config = require('../config');
const A = require('./access');
const limits = require('../middleware/limits');
const lib = require('./legal-library');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });

// ---------- Chiffrement des fichiers ----------
let key = null;
const getKey = () => key || (key = crypto.scryptSync(config.dataKey || config.jwtSecret, 'manager-ia-legal-files-v1', 32));
function seal(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function unseal(raw) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  } catch { return null; }
}
function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b.toString('latin1', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

const MAX_FILE = 2 * 1024 * 1024; const MAX_PER_PARENT = 10; const MAX_ORG = 40 * 1024 * 1024;
const PARENTS = { contract: ['legal_contracts', 'Contrat'], obligation: ['legal_obligations', 'Obligation'], dispute: ['legal_disputes', 'Dossier'] };
const fileView = (x) => ({ id: x.id, parentType: x.parent_type, parentId: x.parent_id, name: x.name, mime: x.mime, size: Number(x.size), createdAt: x.created_at });

async function parentOf(req, type, id) {
  const p = PARENTS[type];
  if (!p) throw new HttpError(400, 'Type de dossier inconnu (contract, obligation ou dispute).');
  const row = await db.prepare(`SELECT id FROM ${p[0]} WHERE id = ? AND org_id = ?`).get(A.id(id), req.org.id);
  if (!row) throw new HttpError(404, `${p[1]} introuvable.`);
  return Number(row.id);
}
/** Supprime les pièces jointes d'un élément qui disparaît. */
async function dropFiles(orgId, type, id) { await db.prepare('DELETE FROM legal_files WHERE org_id = ? AND parent_type = ? AND parent_id = ?').run(orgId, type, id); }
/** Nombre de pièces jointes par élément : { id: n }. */
async function countFiles(orgId, type) {
  const rows = await db.prepare('SELECT parent_id, COUNT(*) AS n FROM legal_files WHERE org_id = ? AND parent_type = ? GROUP BY parent_id').all(orgId, type);
  return Object.fromEntries(rows.map((r) => [Number(r.parent_id), Number(r.n)]));
}

const upLimit = limits.make(10 * 60 * 1000, 40, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");

router.get('/files', async (req, res) => {
  const pid = await parentOf(req, String(req.query.parentType || ''), req.query.parentId);
  const rows = await db.prepare('SELECT id, parent_type, parent_id, name, mime, size, created_at FROM legal_files WHERE org_id = ? AND parent_type = ? AND parent_id = ? ORDER BY id').all(req.org.id, req.query.parentType, pid);
  res.json({ files: rows.map(fileView), limits: { maxBytes: MAX_FILE, perItem: MAX_PER_PARENT } });
});
router.post('/files', upLimit, express.raw({ type: () => true, limit: MAX_FILE + 1024 }), async (req, res) => {
  const type = String(req.query.parentType || '');
  const pid = await parentOf(req, type, req.query.parentId);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const t = sniff(buf);
  if (!t) throw new HttpError(400, 'Fichier non reconnu : envoyez un PDF ou une image (JPEG, PNG, WebP).');
  if (buf.length > MAX_FILE) throw new HttpError(413, 'Fichier trop lourd (2 Mo au plus).');
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM legal_files WHERE org_id = ? AND parent_type = ? AND parent_id = ?').get(req.org.id, type, pid)).c);
  if (n >= MAX_PER_PARENT) throw new HttpError(403, `Il y a déjà ${MAX_PER_PARENT} fichiers ici. Supprimez-en un pour en ajouter.`);
  const used = Number((await db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM legal_files WHERE org_id = ?').get(req.org.id)).s);
  if (used + buf.length > MAX_ORG) throw new HttpError(403, "Espace de fichiers juridiques plein (40 Mo). Supprimez d'anciens fichiers.");
  const base = cleanText(String(req.query.name || ''), 80).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'document';
  const name = `${base}.${t.ext}`;
  const id = (await db.prepare('INSERT INTO legal_files (org_id, parent_type, parent_id, name, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, type, pid, name, t.mime, buf.length, seal(buf), req.user.id, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'legal', `Pièce jointe « ${name} » ajoutée`);
  res.status(201).json({ id: Number(id), name, mime: t.mime });
});
router.get('/files/:id/file', async (req, res) => {
  const x = await db.prepare('SELECT * FROM legal_files WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x || !PARENTS[x.parent_type]) throw new HttpError(404, 'Fichier introuvable.'); // les pièces du personnel et des projets ont leurs propres routes
  const data = unseal(x.data);
  if (!data) throw new HttpError(500, 'Ce fichier ne peut pas être relu (clé de chiffrement modifiée).');
  await A.logActivity(req.org.id, req.user.id, 'legal', `Pièce jointe « ${x.name} » téléchargée`);
  res.set({ 'Content-Type': x.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `attachment; filename="${x.name.replace(/[^A-Za-z0-9._ -]/g, '_')}"` });
  res.end(data);
});
router.delete('/files/:id', async (req, res) => {
  const x = await db.prepare('SELECT * FROM legal_files WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x || !PARENTS[x.parent_type]) throw new HttpError(404, 'Fichier introuvable.');
  if (!A.can(req, 'admin') && Number(x.created_by) !== Number(req.user.id)) throw new HttpError(403, 'Seul son auteur ou un administrateur peut supprimer ce fichier.');
  await db.prepare('DELETE FROM legal_files WHERE id = ?').run(x.id);
  res.json({ ok: true });
});

// ---------- Modèles ----------
const KINDS = ['document', 'obligation', 'privacy'];
const KIND_LABEL = { document: 'Document', obligation: 'Obligation', privacy: 'Registre des données' };
const OB_KINDS = ['license', 'authorization', 'insurance', 'declaration', 'display', 'inspection', 'other'];
const humanize = (k) => { const t = k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
/** Champs {{nom}} du texte : un champ par nom, dans l'ordre d'apparition. */
function fieldsOf(body) {
  const seen = [];
  for (const m of String(body).matchAll(/\{\{(\w{1,40})\}\}/g)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen.map((k) => ({ key: k, label: humanize(k) }));
}
const view = (t) => {
  let data = {};
  try { data = JSON.parse(t.data || '{}'); } catch { /* ignoré */ }
  return { id: String(t.id), builtin: false, kind: t.kind, kindLabel: KIND_LABEL[t.kind], title: t.title, body: t.body, fields: t.kind === 'document' ? fieldsOf(t.body) : [], data, updatedAt: t.updated_at };
};
const builtinView = (t) => ({ ...t, kindLabel: KIND_LABEL[t.kind] });
function templateFields(b, kind) {
  const title = A.text(b.title, 120, { required: true, msg: 'Donnez un nom au modèle.' });
  if (kind === 'document') {
    if (typeof b.body === 'string' && b.body.length > 12000) throw new HttpError(400, 'Texte trop long (12 000 caractères au plus).');
    const body = cleanText(b.body, 12000);
    if (!body) throw new HttpError(400, 'Écrivez le texte du modèle.');
    if (fieldsOf(body).length > 40) throw new HttpError(400, 'Trop de champs {{nom}} (40 au plus).');
    return { title, body, data: '{}' };
  }
  const d = b.data && typeof b.data === 'object' ? b.data : {};
  const data = kind === 'obligation'
    ? { title: A.text(d.title, 150, { required: true, msg: "Donnez un titre à l'obligation." }), kind: A.oneOf(d.kind, OB_KINDS, 'other', "Type d'obligation inconnu."), recurrenceMonths: (() => { const n = d.recurrenceMonths === undefined || d.recurrenceMonths === '' ? 0 : Number(d.recurrenceMonths); if (!Number.isInteger(n) || n < 0 || n > 120) throw new HttpError(400, 'Récurrence invalide : indiquez un nombre de mois entre 0 et 120.'); return n; })(), notes: A.text(d.notes, 800) }
    : { dataKind: A.text(d.dataKind, 150, { required: true, msg: 'Indiquez la donnée collectée.' }), people: A.text(d.people, 150), purpose: A.text(d.purpose, 300), retention: A.text(d.retention, 150), notes: A.text(d.notes, 500) };
  return { title, body: '', data: JSON.stringify(data) };
}
const kindOf = (v) => A.oneOf(v, KINDS, 'document', 'Type de modèle inconnu.');

router.get('/templates', async (req, res) => {
  const mine = (await db.prepare('SELECT * FROM legal_templates WHERE org_id = ? ORDER BY id LIMIT 300').all(req.org.id)).map(view);
  res.json({ templates: [...lib.builtins().map(builtinView), ...mine], mention: lib.MENTION });
});
router.post('/templates', async (req, res) => {
  const b = req.body || {};
  const kind = kindOf(b.kind);
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM legal_templates WHERE org_id = ?').get(req.org.id)).c);
  if (n >= 300) throw new HttpError(403, 'Vous avez atteint 300 modèles. Supprimez-en pour en ajouter.');
  const f = templateFields(b, kind);
  const now = nowISO();
  const id = (await db.prepare('INSERT INTO legal_templates (org_id, kind, title, body, data, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, kind, f.title, f.body, f.data, req.user.id, now, now)).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'legal', `Modèle « ${f.title} » créé`);
  res.status(201).json({ id: String(id) });
});
// Copie d'un modèle (fourni ou de l'organisation) en un modèle modifiable de l'organisation.
router.post('/templates/:id/duplicate', async (req, res) => {
  const id = String(req.params.id);
  let src;
  if (id.startsWith('b:')) src = lib.builtins().find((t) => t.id === id);
  else { const r = await db.prepare('SELECT * FROM legal_templates WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id); src = r && view(r); }
  if (!src) throw new HttpError(404, 'Modèle introuvable.');
  const now = nowISO();
  const title = `${src.title} (copie)`.slice(0, 120);
  const nid = (await db.prepare('INSERT INTO legal_templates (org_id, kind, title, body, data, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, src.kind, title, src.body, JSON.stringify(src.data || {}), req.user.id, now, now)).lastInsertRowid;
  res.status(201).json({ id: String(nid) });
});
const ownTemplate = async (req) => {
  if (String(req.params.id).startsWith('b:')) throw new HttpError(403, 'Ce modèle est fourni par MANAGER-IA : dupliquez-le pour en faire votre propre version.');
  const r = await db.prepare('SELECT * FROM legal_templates WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Modèle introuvable.');
  return r;
};
router.put('/templates/:id', async (req, res) => {
  const t = await ownTemplate(req);
  const f = templateFields({ ...view(t), ...(req.body || {}), data: (req.body || {}).data === undefined ? view(t).data : req.body.data }, t.kind);
  await db.prepare('UPDATE legal_templates SET title = ?, body = ?, data = ?, updated_at = ? WHERE id = ?').run(f.title, f.body, f.data, nowISO(), t.id);
  res.json({ ok: true });
});
router.delete('/templates/:id', async (req, res) => {
  const t = await ownTemplate(req);
  await db.prepare('DELETE FROM legal_templates WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

module.exports = { router, dropFiles, countFiles, seal, unseal, sniff, fileView };
