'use strict';
// Bibliothèque : dossiers, documents, versions, favoris, récents, corbeille, recherche et statistiques par bloc.
// RÈGLE : toute route qui touche un bloc ou un document passe par « guardBlock » ou « loadDoc », qui exigent (1) le droit de la personne sur le bloc
// et (2) une autorisation de déverrouillage valable pour CETTE session. Un document d'un bloc non autorisé répond « introuvable », comme s'il n'existait pas.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const C = require('./library-core');
const X = require('./legal-extra');
const limits = require('../middleware/limits');
const { HttpError } = require('../util');

const upLimit = limits.make(10 * 60 * 1000, 60, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");
const dlLimit = limits.make(10 * 60 * 1000, 400, 'Trop de téléchargements. Réessayez dans quelques minutes.');
const LOCKED_CODE = 'library_locked';

function lockedError() { const e = new HttpError(403, 'Ce bloc est verrouillé : saisissez votre mot de passe pour y entrer.'); e.errorCode = LOCKED_CODE; return e; }

module.exports = ({ blockView, mineSql }) => {
  const router = express.Router({ mergeParams: true });
  const S = (block, text) => (Number(block.personal) === 1 ? '' : text); // dans les dossiers personnels, le journal ne retient pas les noms

  /** Droit sur le bloc + autorisation de déverrouillage. Place { block, perms } dans req.lib. */
  const guardBlock = (perm, bidParam = 'bid') => async (req, res, next) => {
    const { block, perms } = await C.blockFor(req, req.params[bidParam]);
    req.lib = await checkAccess(req, block, perms, perm);
    next();
  };
  async function checkAccess(req, block, perms, perm, docId = null) {
    if (!(await C.findGrant(req, block.id))) {
      await C.logAudit(req, { blockId: block.id, docId, action: 'denied', detail: 'Bloc non déverrouillé' });
      throw lockedError();
    }
    await C.requireGrant(req, block.id); // renouvelle l'autorisation
    if (perm && !perms[perm]) {
      await C.logAudit(req, { blockId: block.id, docId, action: 'denied', detail: `Droit « ${perm} » manquant` });
      throw new HttpError(403, 'Votre accès ne permet pas cette action.');
    }
    return { block, perms };
  }
  /** Un document de l'organisation, dans un bloc visible, dont la personne a le droit demandé et le bloc est déverrouillé. */
  async function loadDoc(req, id, perm, { trashed = false } = {}) {
    const d = await db.prepare('SELECT * FROM lib_docs WHERE id = ? AND org_id = ?').get(A.id(id, 'Document introuvable.'), req.org.id);
    if (!d) throw new HttpError(404, 'Document introuvable.');
    const { block, perms } = await C.blockFor(req, d.block_id).catch(() => { throw new HttpError(404, 'Document introuvable.'); }); // même réponse qu'un identifiant inexistant
    if (Number(block.personal) === 1 && Number(d.created_by) !== req.user.id) throw new HttpError(404, 'Document introuvable.');
    await checkAccess(req, block, perms, perm, Number(d.id));
    if (trashed !== (d.deleted_at != null)) throw new HttpError(404, 'Document introuvable.');
    return { doc: d, block, perms };
  }

  // ---------- Vues ----------
  const docSelect = `SELECT d.*, u.name AS author, u2.name AS editor, EXISTS (SELECT 1 FROM lib_favs f WHERE f.doc_id = d.id AND f.user_id = ?) AS fav
    FROM lib_docs d LEFT JOIN users u ON u.id = d.created_by LEFT JOIN users u2 ON u2.id = d.updated_by`;
  const docView = (d) => ({
    id: Number(d.id), blockId: Number(d.block_id), folderId: d.folder_id == null ? null : Number(d.folder_id), name: d.name, tags: C.tagsOut(d.tags), mime: d.mime, size: Number(d.size), version: Number(d.version),
    linkType: d.link_type || '', linkId: d.link_id == null ? null : Number(d.link_id), author: d.author || '', editor: d.editor || '', createdAt: d.created_at, updatedAt: d.updated_at,
    favorite: d.fav === true || Number(d.fav) === 1, previewable: C.PREVIEWABLE.has(d.mime), deletedAt: d.deleted_at || null,
  });
  const folderView = (f) => ({ id: Number(f.id), name: f.name, parentId: f.parent_id == null ? null : Number(f.parent_id), docs: Number(f.docs || 0), subfolders: Number(f.subs || 0) });

  // ---------- Dossiers ----------
  async function folderIn(req, block, id) {
    const f = await db.prepare('SELECT * FROM lib_folders WHERE id = ? AND org_id = ? AND block_id = ?').get(A.id(id, 'Dossier introuvable.'), req.org.id, block.id);
    if (!f || (Number(block.personal) === 1 && Number(f.created_by) !== req.user.id)) throw new HttpError(404, 'Dossier introuvable.');
    return f;
  }
  async function depthOf(f) { let d = 1; let cur = f; while (cur && cur.parent_id != null && d < 20) { cur = await db.prepare('SELECT parent_id FROM lib_folders WHERE id = ?').get(cur.parent_id); d++; } return d; }

  router.post('/blocks/:bid/folders', guardBlock('add'), async (req, res) => {
    const { block } = req.lib;
    const name = A.text((req.body || {}).name, 80, { required: true, msg: 'Indiquez le nom du dossier.' }).replace(/[\u0000-\u001f]/g, '');
    let parent = null;
    if ((req.body || {}).parentId !== undefined && req.body.parentId !== null && req.body.parentId !== '') {
      parent = await folderIn(req, block, req.body.parentId);
      if (await depthOf(parent) >= C.MAX_FOLDER_DEPTH) throw new HttpError(400, `Les dossiers ne vont pas au-delà de ${C.MAX_FOLDER_DEPTH} niveaux.`);
    }
    if (Number((await db.prepare('SELECT COUNT(*) AS n FROM lib_folders WHERE block_id = ?').get(block.id)).n) >= 500) throw new HttpError(403, 'Ce bloc contient déjà 500 dossiers.');
    const id = Number((await db.prepare('INSERT INTO lib_folders (org_id, block_id, parent_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, block.id, parent ? parent.id : null, name, req.user.id, nowISO())).lastInsertRowid);
    await C.logAudit(req, { blockId: block.id, action: 'folder_add', detail: S(block, name) });
    res.status(201).json({ id });
  });
  router.put('/folders/:fid', async (req, res) => {
    const f = await db.prepare('SELECT * FROM lib_folders WHERE id = ? AND org_id = ?').get(A.id(req.params.fid, 'Dossier introuvable.'), req.org.id);
    if (!f) throw new HttpError(404, 'Dossier introuvable.');
    const { block, perms } = await C.blockFor(req, f.block_id);
    await checkAccess(req, block, perms, 'edit');
    await folderIn(req, block, f.id);
    const name = A.text((req.body || {}).name, 80, { required: true, msg: 'Indiquez le nom du dossier.' }).replace(/[\u0000-\u001f]/g, '');
    await db.prepare('UPDATE lib_folders SET name = ? WHERE id = ?').run(name, f.id);
    await C.logAudit(req, { blockId: block.id, action: 'folder_edit', detail: S(block, `${f.name} → ${name}`) });
    res.json({ ok: true });
  });
  router.delete('/folders/:fid', async (req, res) => {
    const f = await db.prepare('SELECT * FROM lib_folders WHERE id = ? AND org_id = ?').get(A.id(req.params.fid, 'Dossier introuvable.'), req.org.id);
    if (!f) throw new HttpError(404, 'Dossier introuvable.');
    const { block, perms } = await C.blockFor(req, f.block_id);
    await checkAccess(req, block, perms, 'delete');
    await folderIn(req, block, f.id);
    const used = Number((await db.prepare('SELECT (SELECT COUNT(*) FROM lib_docs WHERE folder_id = ?) + (SELECT COUNT(*) FROM lib_folders WHERE parent_id = ?) AS n').get(f.id, f.id)).n);
    if (used > 0) throw new HttpError(400, 'Ce dossier n’est pas vide (corbeille comprise) : videz-le avant de le supprimer.');
    await db.prepare('DELETE FROM lib_folders WHERE id = ?').run(f.id);
    await C.logAudit(req, { blockId: block.id, action: 'folder_delete', detail: S(block, f.name) });
    res.json({ ok: true });
  });

  // ---------- Contenu d'un bloc ----------
  router.get('/blocks/:bid', guardBlock('view'), async (req, res) => {
    const { block, perms } = req.lib;
    const q = req.query;
    const mine = mineSql(block, req);
    let folder = null;
    const fid = q.folderId === undefined || q.folderId === '' || q.folderId === 'root' ? null : A.id(q.folderId, 'Dossier introuvable.');
    if (fid) folder = await folderIn(req, block, fid);
    const where = ['d.org_id = ?', 'd.block_id = ?', 'd.deleted_at IS NULL']; const args = [req.org.id, block.id];
    const search = A.text(q.q, 80);
    const tag = A.text(q.tag, 30).toLowerCase();
    if (search) { where.push("(d.name ILIKE ? ESCAPE '\\' OR d.tags ILIKE ? ESCAPE '\\')"); args.push(C.likeEsc(search), C.likeEsc(search)); }
    else if (!tag) { where.push(fid ? 'd.folder_id = ?' : 'd.folder_id IS NULL'); if (fid) args.push(fid); }
    if (tag) { where.push("d.tags LIKE ? ESCAPE '\\'"); args.push(C.likeEsc('|' + tag + '|')); }
    if (mine.sql) { where.push('d.created_by = ?'); args.push(req.user.id); }
    const order = { name: 'LOWER(d.name) ASC', size: 'd.size DESC', date: 'd.updated_at DESC' }[q.sort] || 'LOWER(d.name) ASC';
    const docs = await db.prepare(`${docSelect} WHERE ${where.join(' AND ')} ORDER BY ${order}, d.id LIMIT 500`).all(req.user.id, ...args);
    const folders = (search || tag) ? [] : await db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM lib_docs d WHERE d.folder_id = f.id AND d.deleted_at IS NULL) AS docs, (SELECT COUNT(*) FROM lib_folders s WHERE s.parent_id = f.id) AS subs
      FROM lib_folders f WHERE f.org_id = ? AND f.block_id = ? AND ${fid ? 'f.parent_id = ?' : 'f.parent_id IS NULL'}${mine.sql ? ' AND f.created_by = ?' : ''} ORDER BY LOWER(f.name)`).all(req.org.id, block.id, ...(fid ? [fid] : []), ...(mine.sql ? [req.user.id] : []));
    const crumbs = []; let cur = folder;
    while (cur && crumbs.length < 12) { crumbs.unshift({ id: Number(cur.id), name: cur.name }); cur = cur.parent_id == null ? null : await db.prepare('SELECT * FROM lib_folders WHERE id = ?').get(cur.parent_id); }
    const tagRows = await db.prepare(`SELECT tags FROM lib_docs WHERE org_id = ? AND block_id = ? AND deleted_at IS NULL AND tags <> ''${mine.sql ? ' AND created_by = ?' : ''}`).all(req.org.id, block.id, ...(mine.sql ? [req.user.id] : []));
    const tagSet = new Set(); for (const t of tagRows) for (const x of C.tagsOut(t.tags)) tagSet.add(x);
    const g = await C.findGrant(req, block.id);
    await C.logAudit(req, { blockId: block.id, action: 'open', detail: folder ? S(block, folder.name) : '' });
    res.json({ block: blockView(block), perms: { view: perms.view, read: perms.read, add: perms.add, edit: perms.edit, delete: perms.delete }, folder: folder ? { id: Number(folder.id), name: folder.name } : null, breadcrumbs: crumbs, folders: folders.map(folderView), docs: docs.map(docView), tags: [...tagSet].sort().slice(0, 100), expiresAt: g ? g.expires_at : null });
  });

  // ---------- Statistiques détaillées d'un bloc (exigent le déverrouillage) ----------
  router.get('/blocks/:bid/stats', guardBlock('view'), async (req, res) => {
    const { block } = req.lib;
    const mine = mineSql(block, req);
    const m = mine.sql ? ' AND d.created_by = ?' : ''; const ma = mine.sql ? [req.user.id] : [];
    const docs = await db.prepare(`SELECT d.mime, d.size, d.created_by, d.updated_at, u.name AS author FROM lib_docs d LEFT JOIN users u ON u.id = d.created_by WHERE d.org_id = ? AND d.block_id = ? AND d.deleted_at IS NULL${m}`).all(req.org.id, block.id, ...ma);
    const vol = Number((await db.prepare(`SELECT COALESCE(SUM(v.size), 0) AS s FROM lib_versions v JOIN lib_docs d ON d.id = v.doc_id WHERE d.org_id = ? AND d.block_id = ? AND d.deleted_at IS NULL${m}`).get(req.org.id, block.id, ...ma)).s);
    const trash = Number((await db.prepare(`SELECT COUNT(*) AS n FROM lib_docs d WHERE d.org_id = ? AND d.block_id = ? AND d.deleted_at IS NOT NULL${m}`).get(req.org.id, block.id, ...ma)).n);
    const folders = Number((await db.prepare(`SELECT COUNT(*) AS n FROM lib_folders WHERE org_id = ? AND block_id = ?${mine.sql}`).get(req.org.id, block.id, ...ma)).n);
    const kind = (mime) => (mime.startsWith('image/') ? 'Images' : mime === 'application/pdf' ? 'PDF' : /^(audio|video)\//.test(mime) ? 'Audio et vidéo' : mime === 'text/plain' ? 'Texte' : 'Documents Office');
    const byType = {}; const byAuthor = {};
    for (const d of docs) { const k = kind(d.mime); byType[k] = (byType[k] || 0) + 1; const a = d.author || 'Inconnu'; byAuthor[a] = (byAuthor[a] || 0) + 1; }
    const last = docs.map((d) => d.updated_at).sort().pop() || null;
    res.json({ documents: docs.length, folders, volume: vol, trash, lastActivity: last, byType: Object.entries(byType).map(([type, count]) => ({ type, count })), byAuthor: Object.entries(byAuthor).map(([author, count]) => ({ author, count })).sort((a, b) => b.count - a.count).slice(0, 10) });
  });

  // ---------- Liens avec un projet ou un contrat (seulement s'ils existent dans l'organisation) ----------
  async function linkIn(req, type, id) {
    if (!type) return { type: '', id: null };
    const T = { project: ['projects', 'Projet'], contract: ['legal_contracts', 'Contrat'] }[type];
    if (!T) throw new HttpError(400, 'Lien inconnu (project ou contract).');
    const n = A.id(id, 'Lien invalide.');
    const row = await db.prepare(`SELECT * FROM ${T[0]} WHERE id = ? AND org_id = ?`).get(n, req.org.id);
    if (!row || (type === 'project' && !A.visible(req, row)) || (type === 'contract' && !A.can(req, 'manager'))) throw new HttpError(400, `${T[1]} inconnu.`);
    return { type, id: n };
  }

  // ---------- Envoi d'un document (corps brut) ----------
  const rawBody = express.raw({ type: () => true, limit: 21 * 1024 * 1024 });
  const early = async (req, res, next) => { // refuse sans lire un fichier manifestement trop gros
    const lim = await C.limitsOf(req.org);
    req.libLimits = lim;
    const len = Number(req.get('content-length') || 0);
    if (len > lim.maxFileBytes + 1024) throw new HttpError(413, `Fichier trop lourd (${Math.round(lim.maxFileBytes / 1048576)} Mo au plus avec votre offre).`);
    next();
  };
  /** Écrit un document ou une version en respectant les quotas ; verrou par organisation pour que deux envois simultanés ne dépassent pas l'espace. */
  async function store(req, fn, size) {
    await db.transaction(async () => {
      await db.prepare('SELECT pg_advisory_xact_lock(?)').get(7270200000 + Number(req.org.id));
      const lim = await C.limitsOf(req.org);
      if (size > lim.maxFileBytes) throw new HttpError(413, `Fichier trop lourd (${Math.round(lim.maxFileBytes / 1048576)} Mo au plus avec votre offre).`);
      if (lim.used + size > lim.quotaBytes) throw new HttpError(403, `Espace de la bibliothèque plein (${Math.round(lim.quotaBytes / 1048576)} Mo avec l’offre ${lim.plan}). Supprimez des documents ou passez à une offre supérieure.`);
      await fn();
    })();
  }

  router.post('/blocks/:bid/docs', upLimit, guardBlock('add'), early, rawBody, async (req, res) => {
    const { block } = req.lib;
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const f = C.checkUpload(buf, req.query.name);
    const tags = C.tagsIn(String(req.query.tags || ''));
    let folderId = null;
    if (req.query.folderId) folderId = Number((await folderIn(req, block, req.query.folderId)).id);
    const link = await linkIn(req, String(req.query.linkType || ''), req.query.linkId);
    let id;
    await store(req, async () => {
      const now = nowISO();
      id = Number((await db.prepare('INSERT INTO lib_docs (org_id, block_id, folder_id, name, tags, mime, size, version, link_type, link_id, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)')
        .run(req.org.id, block.id, folderId, f.name, tags, f.mime, buf.length, link.type, link.id, req.user.id, now, req.user.id, now)).lastInsertRowid);
      await db.prepare('INSERT INTO lib_versions (org_id, doc_id, n, name, mime, size, data, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)').run(req.org.id, id, f.name, f.mime, buf.length, X.seal(buf), req.user.id, now);
    }, buf.length);
    await C.logAudit(req, { blockId: block.id, docId: id, action: 'add', detail: S(block, `${f.name} (${buf.length} o)`) });
    res.status(201).json({ id, name: f.name, mime: f.mime, size: buf.length });
  });

  // ---------- Un document ----------
  router.get('/docs/:id', async (req, res) => {
    const { doc, block, perms } = await loadDoc(req, req.params.id, 'read');
    const d = await db.prepare(`${docSelect} WHERE d.id = ?`).get(req.user.id, doc.id);
    const versions = await db.prepare('SELECT v.n, v.name, v.mime, v.size, v.note, v.created_at, u.name AS author FROM lib_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.doc_id = ? ORDER BY v.n DESC').all(doc.id);
    await db.prepare('INSERT INTO lib_recent (user_id, doc_id, at) VALUES (?, ?, ?) ON CONFLICT (user_id, doc_id) DO UPDATE SET at = EXCLUDED.at').run(req.user.id, doc.id, nowISO());
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: 'view_doc', detail: S(block, doc.name) });
    res.json({ doc: docView(d), perms: { read: perms.read, add: perms.add, edit: perms.edit, delete: perms.delete }, versions: versions.map((v) => ({ n: Number(v.n), name: v.name, mime: v.mime, size: Number(v.size), note: v.note, createdAt: v.created_at, author: v.author || '' })) });
  });

  const SEC = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const dispo = (kind, name) => `${kind}; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
  async function send(req, res, inline) {
    const { doc, block } = await loadDoc(req, req.params.id, 'read');
    const n = req.query.version === undefined ? Number(doc.version) : Number(req.query.version);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Version invalide.');
    const v = await db.prepare('SELECT * FROM lib_versions WHERE doc_id = ? AND n = ? AND org_id = ?').get(doc.id, n, req.org.id);
    if (!v) throw new HttpError(404, 'Version introuvable.');
    if (inline && !C.PREVIEWABLE.has(v.mime)) throw new HttpError(415, 'Aperçu indisponible pour ce type de fichier : téléchargez-le.');
    const data = X.unseal(v.data);
    if (!data) throw new HttpError(500, 'Ce fichier ne peut pas être relu (clé de chiffrement modifiée).');
    await db.prepare('INSERT INTO lib_recent (user_id, doc_id, at) VALUES (?, ?, ?) ON CONFLICT (user_id, doc_id) DO UPDATE SET at = EXCLUDED.at').run(req.user.id, doc.id, nowISO());
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: inline ? 'preview' : 'download', detail: S(block, `${v.name} v${n}`) });
    res.set({ ...SEC, 'Content-Type': v.mime, 'Content-Length': data.length, 'Content-Disposition': dispo(inline ? 'inline' : 'attachment', v.name),
      'Content-Security-Policy': inline ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'" : "default-src 'none'; sandbox" });
    res.end(data);
  }
  router.get('/docs/:id/download', dlLimit, (req, res) => send(req, res, false));
  router.get('/docs/:id/preview', dlLimit, (req, res) => send(req, res, true));

  router.put('/docs/:id', async (req, res) => {
    const { doc, block } = await loadDoc(req, req.params.id, 'edit');
    const b = req.body || {};
    let name = doc.name;
    if (b.name !== undefined) {
      const n = C.cleanName(b.name, '');
      if (!n) throw new HttpError(400, 'Indiquez le nom du document.');
      const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(doc.name) || [])[1];
      const given = (/\.([A-Za-z0-9]{1,8})$/.exec(n) || [])[1];
      name = given && ext && given.toLowerCase() === ext.toLowerCase() ? n : (given ? n.slice(0, -given.length - 1) : n) + (ext ? '.' + ext : ''); // l'extension reste celle du contenu
    }
    const tags = b.tags === undefined ? doc.tags : C.tagsIn(b.tags);
    let folderId = doc.folder_id == null ? null : Number(doc.folder_id);
    if (b.folderId !== undefined) folderId = b.folderId === null || b.folderId === '' ? null : Number((await folderIn(req, block, b.folderId)).id);
    let link = { type: doc.link_type, id: doc.link_id };
    if (b.linkType !== undefined) link = await linkIn(req, String(b.linkType || ''), b.linkId);
    await db.prepare('UPDATE lib_docs SET name = ?, tags = ?, folder_id = ?, link_type = ?, link_id = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(name, tags, folderId, link.type, link.id, req.user.id, nowISO(), doc.id);
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: 'edit', detail: S(block, name !== doc.name ? `${doc.name} → ${name}` : doc.name) });
    res.json({ ok: true, name });
  });

  // ---------- Versions ----------
  router.post('/docs/:id/versions', upLimit, async (req, res, next) => { req.libDoc = await loadDoc(req, req.params.id, 'edit'); next(); }, early, rawBody, async (req, res) => {
    const { doc, block } = req.libDoc;
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const f = C.checkUpload(buf, req.query.name || doc.name);
    const note = A.text(req.query.note, 200);
    const n = Number((await db.prepare('SELECT COUNT(*) AS n FROM lib_versions WHERE doc_id = ?').get(doc.id)).n);
    if (n >= C.MAX_VERSIONS) throw new HttpError(403, `Ce document a déjà ${C.MAX_VERSIONS} versions : supprimez-en d’anciennes pour en ajouter.`);
    let next;
    await store(req, async () => {
      const cur = await db.prepare('SELECT version FROM lib_docs WHERE id = ? FOR UPDATE').get(doc.id);
      next = Number(cur.version) + 1; const now = nowISO();
      await db.prepare('INSERT INTO lib_versions (org_id, doc_id, n, name, mime, size, data, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, doc.id, next, f.name, f.mime, buf.length, X.seal(buf), note, req.user.id, now);
      await db.prepare('UPDATE lib_docs SET version = ?, name = ?, mime = ?, size = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(next, req.query.name ? f.name : doc.name.replace(/\.[A-Za-z0-9]{1,8}$/, '') + '.' + f.name.split('.').pop(), f.mime, buf.length, req.user.id, now, doc.id);
    }, buf.length);
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: 'version', detail: S(block, `${doc.name} → version ${next}`) });
    res.status(201).json({ ok: true, version: next });
  });
  router.post('/docs/:id/versions/:n/restore', async (req, res) => {
    const { doc, block } = await loadDoc(req, req.params.id, 'edit');
    const n = A.id(req.params.n, 'Version invalide.');
    const v = await db.prepare('SELECT * FROM lib_versions WHERE doc_id = ? AND n = ? AND org_id = ?').get(doc.id, n, req.org.id);
    if (!v) throw new HttpError(404, 'Version introuvable.');
    if (Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_versions WHERE doc_id = ?').get(doc.id)).c) >= C.MAX_VERSIONS) throw new HttpError(403, `Ce document a déjà ${C.MAX_VERSIONS} versions : supprimez-en d’anciennes d’abord.`);
    let next;
    await store(req, async () => {
      const cur = await db.prepare('SELECT version FROM lib_docs WHERE id = ? FOR UPDATE').get(doc.id);
      next = Number(cur.version) + 1; const now = nowISO();
      await db.prepare('INSERT INTO lib_versions (org_id, doc_id, n, name, mime, size, data, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, doc.id, next, v.name, v.mime, v.size, v.data, `Rétablissement de la version ${n}`, req.user.id, now);
      await db.prepare('UPDATE lib_docs SET version = ?, name = ?, mime = ?, size = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(next, v.name, v.mime, v.size, req.user.id, now, doc.id);
    }, Number(v.size));
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: 'restore_version', detail: S(block, `${doc.name} : version ${n} rétablie (nouvelle version ${next})`) });
    res.json({ ok: true, version: next });
  });
  router.delete('/docs/:id/versions/:n', async (req, res) => {
    const { doc, block } = await loadDoc(req, req.params.id, 'delete');
    const n = A.id(req.params.n, 'Version invalide.');
    if (n === Number(doc.version)) throw new HttpError(400, 'La version actuelle ne se supprime pas : supprimez le document, ou rétablissez une autre version.');
    const r = await db.prepare('DELETE FROM lib_versions WHERE doc_id = ? AND n = ? AND org_id = ?').run(doc.id, n, req.org.id);
    if (!r.changes) throw new HttpError(404, 'Version introuvable.');
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: 'version_delete', detail: S(block, `${doc.name} : version ${n}`) });
    res.json({ ok: true });
  });

  // ---------- Favoris, récents ----------
  router.post('/docs/:id/favorite', async (req, res) => {
    const { doc } = await loadDoc(req, req.params.id, 'read');
    const on = (req.body || {}).on !== false;
    if (on) await db.prepare('INSERT INTO lib_favs (user_id, doc_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(req.user.id, doc.id);
    else await db.prepare('DELETE FROM lib_favs WHERE user_id = ? AND doc_id = ?').run(req.user.id, doc.id);
    res.json({ ok: true, favorite: on });
  });

  /** Documents (hors corbeille) des blocs déverrouillés par cette session, dont la personne peut lire la liste. Les autres blocs n'apparaissent pas. */
  async function unlockedDocs(req, extraWhere, extraArgs, order, limit) {
    const grants = await C.openGrants(req);
    const ids = Object.keys(grants).map(Number);
    if (!ids.length) return [];
    const blocks = await db.prepare(`SELECT * FROM lib_blocks WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids);
    const ok = [];
    for (const b of blocks) { const p = await C.effectivePerms(req, b); if (p.view && !(Number(b.hidden) === 1 && !A.can(req, 'admin'))) ok.push(b); }
    if (!ok.length) return [];
    const info = Object.fromEntries(ok.map((b) => [Number(b.id), b]));
    const personal = ok.filter((b) => Number(b.personal) === 1).map((b) => Number(b.id));
    const rows = await db.prepare(`${docSelect} WHERE d.org_id = ? AND d.block_id IN (${ok.map(() => '?').join(',')}) ${personal.length ? `AND (d.block_id NOT IN (${personal.join(',')}) OR d.created_by = ?)` : ''} AND ${extraWhere} ORDER BY ${order} LIMIT ${Number(limit) || 100}`)
      .all(req.user.id, req.org.id, ...ok.map((b) => Number(b.id)), ...(personal.length ? [req.user.id] : []), ...extraArgs);
    for (const id of Object.keys(grants)) if (info[id]) await C.requireGrant(req, Number(id)).catch(() => {}); // l'activité renouvelle les autorisations utilisées
    return rows.map((r) => ({ ...docView(r), block: { id: Number(r.block_id), name: info[Number(r.block_id)].name, color: info[Number(r.block_id)].color } }));
  }
  router.get('/favorites', async (req, res) => {
    res.json({ docs: await unlockedDocs(req, 'd.deleted_at IS NULL AND EXISTS (SELECT 1 FROM lib_favs f WHERE f.doc_id = d.id AND f.user_id = ?)', [req.user.id], 'd.updated_at DESC', 200) });
  });
  router.get('/recent', async (req, res) => {
    res.json({ docs: await unlockedDocs(req, 'd.deleted_at IS NULL AND EXISTS (SELECT 1 FROM lib_recent r WHERE r.doc_id = d.id AND r.user_id = ?)', [req.user.id], '(SELECT r.at FROM lib_recent r WHERE r.doc_id = d.id AND r.user_id = ' + Number(req.user.id) + ') DESC', 30) });
  });

  // ---------- Recherche (nom, étiquettes) dans les blocs déverrouillés uniquement ----------
  router.get('/search', async (req, res) => {
    const q = A.text(req.query.q, 80); const tag = A.text(req.query.tag, 30).toLowerCase();
    const lt = String(req.query.linkType || '');
    if (!q && !tag && !lt) throw new HttpError(400, 'Indiquez ce que vous cherchez.');
    const where = ['d.deleted_at IS NULL']; const args = [];
    if (q) { where.push("(d.name ILIKE ? ESCAPE '\\' OR d.tags ILIKE ? ESCAPE '\\')"); args.push(C.likeEsc(q), C.likeEsc(q)); }
    if (tag) { where.push("d.tags LIKE ? ESCAPE '\\'"); args.push(C.likeEsc('|' + tag + '|')); }
    if (lt) { if (!['project', 'contract'].includes(lt)) throw new HttpError(400, 'Lien inconnu (project ou contract).'); where.push('d.link_type = ?', 'd.link_id = ?'); args.push(lt, A.id(req.query.linkId, 'Lien invalide.')); }
    res.json({ docs: await unlockedDocs(req, where.join(' AND '), args, 'LOWER(d.name)', 100) });
  });

  // ---------- Corbeille ----------
  router.get('/trash', async (req, res) => {
    await C.purgeTrash(req.org.id);
    const grants = await C.openGrants(req);
    const out = [];
    for (const idStr of Object.keys(grants)) {
      const b = await db.prepare('SELECT * FROM lib_blocks WHERE id = ? AND org_id = ?').get(Number(idStr), req.org.id);
      if (!b) continue;
      const perms = await C.effectivePerms(req, b);
      if (!perms.delete) continue;
      const mine = mineSql(b, req);
      const rows = await db.prepare(`${docSelect} WHERE d.org_id = ? AND d.block_id = ? AND d.deleted_at IS NOT NULL${mine.sql ? ' AND d.created_by = ?' : ''} ORDER BY d.deleted_at DESC LIMIT 200`).all(req.user.id, req.org.id, b.id, ...mine.args);
      for (const r of rows) out.push({ ...docView(r), block: { id: Number(b.id), name: b.name, color: b.color }, daysLeft: Math.max(C.TRASH_DAYS - Math.floor((Date.now() - Date.parse(r.deleted_at)) / 86400000), 0) });
    }
    res.json({ docs: out, days: C.TRASH_DAYS });
  });
  router.delete('/docs/:id', async (req, res) => {
    const { doc, block } = await loadDoc(req, req.params.id, 'delete');
    await db.prepare('UPDATE lib_docs SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowISO(), req.user.id, doc.id);
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: 'delete', detail: S(block, doc.name) });
    res.json({ ok: true });
  });
  router.post('/docs/:id/restore', async (req, res) => {
    const { doc, block } = await loadDoc(req, req.params.id, 'delete', { trashed: true });
    const folder = doc.folder_id == null ? null : await db.prepare('SELECT id FROM lib_folders WHERE id = ?').get(doc.folder_id);
    await db.prepare('UPDATE lib_docs SET deleted_at = NULL, deleted_by = NULL, folder_id = ?, updated_at = ? WHERE id = ?').run(folder ? folder.id : null, nowISO(), doc.id);
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: 'restore', detail: S(block, doc.name) });
    res.json({ ok: true });
  });
  router.delete('/docs/:id/purge', async (req, res) => {
    const { doc, block } = await loadDoc(req, req.params.id, 'delete', { trashed: true });
    await db.prepare('DELETE FROM lib_docs WHERE id = ?').run(doc.id);
    await C.logAudit(req, { blockId: block.id, docId: doc.id, action: 'purge', detail: S(block, doc.name) });
    res.json({ ok: true });
  });

  return router;
};
