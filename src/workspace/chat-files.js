'use strict';
// Chat interne (2/5) : partage de fichiers et messages vocaux, historique et classement des fichiers, réglages de l'entreprise (formats, taille).
// Stockage : colonne BYTEA de PostgreSQL (le disque de Render peut être effacé à chaque déploiement). Téléversement en binaire brut (pas de base64).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./chat-lib');
const U = require('./chat-upload');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const uploadLimit = L.userLimit('upload', 60 * 1000, 20, 'Vous envoyez trop de fichiers à la suite. Patientez une minute.');

// ---------- Réglages de l'entreprise (administrateurs) ----------
router.get('/settings', async (req, res) => {
  res.json({ settings: await L.getSettings(req.org.id), hardMaxFileMb: L.HARD_MAX_FILE_MB, categories: U.CATEGORIES.map((c) => ({ id: c, label: U.CAT_LABEL[c] })), canEdit: A.can(req, 'admin') });
});
router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const cur = await L.getSettings(req.org.id);
  let kinds = cur.allowedKinds;
  if (b.allowedKinds !== undefined) {
    if (!Array.isArray(b.allowedKinds) || b.allowedKinds.some((k) => !U.CATEGORIES.includes(k))) throw new HttpError(400, 'Type de fichier inconnu dans la liste.');
    kinds = [...new Set(b.allowedKinds)];
  }
  const mb = b.maxFileMb === undefined ? cur.maxFileMb : Number(b.maxFileMb);
  if (!Number.isInteger(mb) || mb < 1 || mb > L.HARD_MAX_FILE_MB) throw new HttpError(400, `La taille maximale doit être un nombre entier de Mo entre 1 et ${L.HARD_MAX_FILE_MB}.`);
  const groupsBy = b.groupsBy === undefined ? cur.groupsBy : A.oneOf(b.groupsBy, ['all', 'manager'], undefined, 'Réglage inconnu.');
  const n = { maxFileMb: mb, allowedKinds: kinds, aiEnabled: b.aiEnabled === undefined ? cur.aiEnabled : Boolean(b.aiEnabled), callsEnabled: b.callsEnabled === undefined ? cur.callsEnabled : Boolean(b.callsEnabled), groupsBy };
  await db.prepare(`INSERT INTO ci_settings (org_id, max_file_mb, allowed_kinds, ai_enabled, calls_enabled, groups_by, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET max_file_mb = EXCLUDED.max_file_mb, allowed_kinds = EXCLUDED.allowed_kinds, ai_enabled = EXCLUDED.ai_enabled, calls_enabled = EXCLUDED.calls_enabled, groups_by = EXCLUDED.groups_by, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, n.maxFileMb, JSON.stringify(n.allowedKinds), n.aiEnabled ? 1 : 0, n.callsEnabled ? 1 : 0, n.groupsBy, req.user.id, nowISO());
  await W.audit(req, 'chat_settings', null, 'update', cur, n);
  res.json({ settings: n });
});

// ---------- Téléversement : corps binaire brut, ?conv=&name=&voice=1&durationMs=&caption=&replyTo= ----------
async function sizeGate(req, res, next) {
  try {
    const set = await L.getSettings(req.org.id);
    const max = set.maxFileMb * 1024 * 1024;
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > max) throw new HttpError(413, `Fichier trop volumineux : cette entreprise accepte ${set.maxFileMb} Mo au plus par fichier.`);
    req.chatSettings = set;
    next();
  } catch (e) { next(e); }
}
router.post('/files', uploadLimit, sizeGate, express.raw({ type: () => true, limit: L.HARD_MAX_FILE_MB * 1024 * 1024 + 1024 }), async (req, res) => {
  const conv = await L.loadConv(req, req.query.conv);
  if (Number(conv.only_admins_post) === 1 && conv.my_role !== 'admin') throw new HttpError(403, 'Dans ce groupe, seuls les administrateurs du groupe peuvent écrire.');
  const set = req.chatSettings;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'Aucun fichier reçu.');
  if (buf.length > set.maxFileMb * 1024 * 1024) throw new HttpError(413, `Fichier trop volumineux : cette entreprise accepte ${set.maxFileMb} Mo au plus par fichier.`);
  const voice = req.query.voice === '1';
  if (L.isE2ee(conv)) { // contenu chiffré par l'appareil : le serveur ne peut ni en lire le type, ni l'analyser (limite assumée, voir la documentation)
    const encName = String(req.query.name || '').slice(0, 400);
    if (!L.CIPHER_RX.test(encName)) throw new HttpError(400, 'Nom de fichier chiffré invalide.');
    const dur2 = voice ? Math.min(Math.max(parseInt(req.query.durationMs, 10) || 0, 0), 15 * 60 * 1000) : 0;
    const fid2 = Number((await db.prepare('INSERT INTO ci_files (org_id, conv_id, name, mime, category, size, duration_ms, data, uploader_id, scan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, conv.id, encName, 'application/octet-stream', 'encrypted', buf.length, dur2, buf, req.user.id, 'encrypted', nowISO())).lastInsertRowid);
    const cap = String(req.query.caption || '');
    const v2 = await L.postMessage(req, conv, { kind: voice ? 'voice' : 'file', body: cap && L.CIPHER_RX.test(cap) ? cap : encName, meta: voice ? { durationMs: dur2 } : {}, fileId: fid2 });
    return res.status(201).json({ message: v2 });
  }
  const info = U.inspect(buf, String(req.query.name || (voice ? 'message-vocal.webm' : 'fichier')), { voice });
  if (!voice && !set.allowedKinds.includes(info.category)) throw new HttpError(400, `Les fichiers de type « ${U.CAT_LABEL[info.category]} » ne sont pas autorisés dans cette entreprise.`);
  const scan = await U.antivirus(buf);
  const dur = voice ? Math.min(Math.max(parseInt(req.query.durationMs, 10) || 0, 0), 15 * 60 * 1000) : 0;
  const caption = String(req.query.caption || '').slice(0, 500);
  let replyTo = null;
  if (req.query.replyTo) { replyTo = await db.prepare('SELECT id FROM ci_messages WHERE id = ? AND conv_id = ? AND (visible_to IS NULL OR visible_to = ?)').get(A.id(req.query.replyTo), conv.id, req.user.id); }
  const fid = Number((await db.prepare('INSERT INTO ci_files (org_id, conv_id, name, mime, category, size, duration_ms, data, uploader_id, scan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, conv.id, info.name, info.mime, info.category, buf.length, dur, buf, req.user.id, scan === 'clean' ? 'clean' : 'ok', nowISO())).lastInsertRowid);
  const view = await L.postMessage(req, conv, { kind: voice ? 'voice' : 'file', body: voice ? '' : (caption || info.name), meta: voice ? { durationMs: dur } : {}, fileId: fid, replyToId: replyTo ? Number(replyTo.id) : null });
  res.status(201).json({ message: view });
});

// ---------- Historique et classement ----------
const fileRows = (req, where, args) => db.prepare(`SELECT f.id, f.conv_id, f.name, f.mime, f.category, f.folder, f.size, f.duration_ms, f.created_at, f.uploader_id, u.name AS uploader, c.kind AS conv_kind, c.name AS conv_name, f.message_id
  FROM ci_files f JOIN ci_members cm ON cm.conv_id = f.conv_id AND cm.user_id = ? AND cm.left_at IS NULL
  JOIN ci_conversations c ON c.id = f.conv_id LEFT JOIN users u ON u.id = f.uploader_id
  WHERE f.org_id = ? AND f.deleted_at IS NULL AND (f.message_id IS NULL OR f.message_id > cm.from_id) ${where} ORDER BY f.id DESC LIMIT 300`).all(req.user.id, req.org.id, ...args);
router.get('/files', async (req, res) => {
  const where = []; const args = [];
  if (req.query.conv) { where.push('f.conv_id = ?'); args.push(A.id(req.query.conv)); }
  if (req.query.category) { where.push('f.category = ?'); args.push(A.oneOf(req.query.category, U.CATEGORIES, undefined, 'Catégorie inconnue.')); }
  if (req.query.folder !== undefined && req.query.folder !== '') { where.push('f.folder = ?'); args.push(String(req.query.folder).slice(0, 60)); }
  if (req.query.mine === '1') { where.push('f.uploader_id = ?'); args.push(req.user.id); }
  if (req.query.q) { where.push("f.name ILIKE ? ESCAPE '\\'"); args.push('%' + String(req.query.q).slice(0, 60).replace(/[\\%_]/g, '\\$&') + '%'); }
  const rows = await fileRows(req, where.length ? 'AND ' + where.join(' AND ') : '', args);
  // Les conversations privées d'une autre personne n'apparaissent jamais : la jointure sur ci_members l'exclut.
  const direct = new Map();
  for (const r of rows) if (r.conv_kind === 'direct' && !direct.has(Number(r.conv_id))) { const o = await db.prepare('SELECT u.name FROM ci_members m JOIN users u ON u.id = m.user_id WHERE m.conv_id = ? AND m.user_id <> ? LIMIT 1').get(r.conv_id, req.user.id); direct.set(Number(r.conv_id), o ? o.name : ''); }
  res.json({ files: rows.map((r) => ({ id: Number(r.id), convId: Number(r.conv_id), convName: r.conv_kind === 'direct' ? direct.get(Number(r.conv_id)) || '' : r.conv_name, name: r.name, mime: r.mime, category: r.category, folder: r.folder, size: Number(r.size), durationMs: Number(r.duration_ms), at: r.created_at, uploaderId: r.uploader_id == null ? null : Number(r.uploader_id), uploader: r.uploader || '', messageId: r.message_id == null ? null : Number(r.message_id), previewable: U.PREVIEWABLE.includes(r.category) })) });
});

async function fileFor(req, id) {
  const f = await db.prepare('SELECT * FROM ci_files WHERE id = ? AND org_id = ?').get(A.id(id, 'Fichier introuvable.'), req.org.id);
  if (!f || f.deleted_at) throw new HttpError(404, 'Fichier introuvable.');
  const conv = await L.loadConv(req, f.conv_id); // 404 si la personne ne participe pas à la conversation
  if (f.message_id != null) {
    if (Number(f.message_id) <= Number(conv.my_from)) throw new HttpError(404, 'Fichier introuvable.');
    const m = await db.prepare('SELECT visible_to, deleted_at FROM ci_messages WHERE id = ?').get(f.message_id);
    if (!m || m.deleted_at || (m.visible_to != null && Number(m.visible_to) !== req.user.id)) throw new HttpError(404, 'Fichier introuvable.');
  }
  return { f, conv };
}
router.get('/files/:id/content', async (req, res) => {
  const { f } = await fileFor(req, req.params.id);
  const inline = req.query.inline === '1' && U.PREVIEWABLE.includes(f.category);
  const disp = `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  res.set({ 'Content-Type': f.mime, 'Content-Length': f.data.length, 'Content-Disposition': disp, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end(f.data);
});
router.put('/files/:id', async (req, res) => {
  const { f, conv } = await fileFor(req, req.params.id);
  if (Number(f.uploader_id) !== req.user.id && !L.isGroupAdmin(conv)) throw new HttpError(403, "Seule la personne qui a envoyé le fichier ou un administrateur du groupe peut le classer.");
  const folder = A.text((req.body || {}).folder, 60);
  await db.prepare('UPDATE ci_files SET folder = ? WHERE id = ?').run(folder, f.id);
  res.json({ ok: true, folder });
});
router.get('/folders', async (req, res) => {
  const rows = await db.prepare(`SELECT f.folder, COUNT(*) c FROM ci_files f JOIN ci_members cm ON cm.conv_id = f.conv_id AND cm.user_id = ? AND cm.left_at IS NULL WHERE f.org_id = ? AND f.deleted_at IS NULL AND f.folder <> '' GROUP BY f.folder ORDER BY f.folder`).all(req.user.id, req.org.id);
  res.json({ folders: rows.map((r) => ({ name: r.folder, count: Number(r.c) })) });
});

module.exports = { router };
