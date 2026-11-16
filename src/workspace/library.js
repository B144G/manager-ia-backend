'use strict';
// Bibliothèque : les documents de l'entreprise rangés en blocs protégés.
// - Entrer dans un bloc demande de ressaisir SON mot de passe : le serveur crée alors une autorisation courte (lib_grants),
//   liée à la session de connexion, renouvelée à chaque action, avec une durée maximale. Toutes les routes de documents la vérifient.
// - Droits par bloc : par rôle (membre, responsable, administrateur), avec des exceptions par personne qui remplacent ceux du rôle.
//   Le propriétaire a toujours tout. Seul le propriétaire règle les droits des administrateurs. Un bloc masqué n'est visible que des administrateurs.
// - Le bloc personnel est partagé par toute l'organisation, mais chacun n'y voit que ses propres documents (owner_id).
// - Fichiers reconnus d'après leur CONTENU (jamais d'après le seul nom), chiffrés (AES-256-GCM) dans la base, versions successives, corbeille de 30 jours.
// - Journal d'audit propre au module : entrées, mots de passe ratés, consultations, ajouts, suppressions, changements de droits. Jamais de mot de passe.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, nowISO } = require('../db');
const A = require('./access');
const X = require('./legal-extra');
const limits = require('../middleware/limits');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });

const MB = 1024 * 1024;
const HARD_MAX_FILE = 20 * MB;
const MAX_VERSIONS = 20;
const MAX_DEPTH = 6;
const MAX_FOLDERS = 500;
const MAX_BLOCKS = 40;
const MAX_EXCEPTIONS = 200;
const TRASH_DAYS = 30;
const FAIL_WINDOW_MIN = 15;
const FAIL_MAX = 5;
const PERM_KEYS = ['view', 'read', 'add', 'edit', 'delete'];
const ROLE_KEYS = ['member', 'manager', 'admin'];
const ICONS = ['folder', 'shield', 'cart', 'wallet', 'users', 'ruler', 'factory', 'hardhat', 'box', 'scale', 'book', 'mail', 'target', 'lock', 'chip', 'image', 'user', 'file', 'star', 'building'];

// Espace par offre (Mo) : réglable par variables d'environnement. Les fichiers sont dans la base PostgreSQL : gardez un œil sur la taille de la base.
const envMb = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 ? n : d; };
const QUOTA_MB = [envMb('LIB_QUOTA_MB_FREE', 50), envMb('LIB_QUOTA_MB_PRO', 500), envMb('LIB_QUOTA_MB_PROMAX', 1000), envMb('LIB_QUOTA_MB_MEGAPRO', 2000), envMb('LIB_QUOTA_MB_ILLIMITE', 5000)];
const FILE_MB = [5, 20, 20, 20, 20];

const err = (status, message, code) => { const e = new HttpError(status, message); if (code) e.errorCode = code; return e; };
const DENIED = 'Votre accès ne permet pas cette action.';
const LOCKED_MSG = 'Ce bloc est verrouillé : saisissez votre mot de passe pour y entrer.';

// ---------- Journal ----------
const ACTIONS = {
  unlock: 'Déverrouillage réussi',
  unlock_fail: 'Mot de passe incorrect',
  unlock_locked: 'Déverrouillage refusé (trop d’essais)',
  lock: 'Bloc refermé',
  open: 'Ouverture d’un bloc',
  download: 'Consultation d’un document',
  preview: 'Aperçu d’un document',
  upload: 'Ajout d’un document',
  version: 'Nouvelle version',
  version_restore: 'Version rétablie',
  version_delete: 'Version supprimée',
  edit: 'Modification d’un document',
  trash: 'Document mis à la corbeille',
  restore: 'Document restauré',
  purge: 'Suppression définitive',
  folder_create: 'Dossier créé',
  folder_rename: 'Dossier renommé',
  folder_delete: 'Dossier supprimé',
  perms: 'Changement de droits',
  block_create: 'Bloc ajouté',
  block_update: 'Bloc modifié',
  block_delete: 'Bloc supprimé',
  settings: 'Réglages modifiés',
  denied: 'Accès refusé',
  auto_purge: 'Corbeille vidée automatiquement',
};
async function audit(req, action, block, detail) {
  await db.prepare('INSERT INTO lib_audit (org_id, block_id, block_name, user_id, action, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, block ? block.id : null, block ? block.name : '', req.user ? req.user.id : null, action, String(detail || '').slice(0, 300), String(req.ip || '').slice(0, 64), nowISO());
}

// ---------- Réglages, espace, blocs de départ ----------
const DEFAULT_BLOCKS = [
  // [nom, couleur, icône, personnel, droits membre, responsable, administrateur] (v = voir, r = lire, a = ajouter, e = modifier, d = supprimer)
  ['Mes documents', '#4b5563', 'user', 1, '', '', ''],
  ['Administratif', '#2f6f5e', 'building', 0, 'vr', 'vrae', 'vraed'],
  ['Commercial', '#1d4ed8', 'cart', 0, 'vra', 'vraed', 'vraed'],
  ['Projets', '#7c3aed', 'target', 0, 'vra', 'vraed', 'vraed'],
  ['Ressources humaines', '#b45309', 'users', 0, '', 'vr', 'vraed'],
  ['Comptabilité et finances', '#0f766e', 'wallet', 0, '', 'vr', 'vraed'],
  ['Juridique', '#9f1239', 'scale', 0, '', 'vr', 'vraed'],
];
const letters = (s) => ({ view: s.includes('v'), read: s.includes('r'), add: s.includes('a'), edit: s.includes('e'), delete: s.includes('d') });

async function ensureDefaults(org) {
  const r = await db.prepare('INSERT INTO lib_settings (org_id, updated_at) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING').run(org.id, nowISO());
  if (!r.changes) return;
  const now = nowISO();
  await db.transaction(async () => {
    let pos = 0;
    for (const [name, color, icon, personal, m, g, a] of DEFAULT_BLOCKS) {
      const id = Number((await db.prepare('INSERT INTO lib_blocks (org_id, name, color, icon, personal, builtin, position, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(org.id, name, color, icon, personal, pos++, now)).lastInsertRowid);
      if (!personal) for (const [role, s] of [['member', m], ['manager', g], ['admin', a]]) await saveRolePerms(id, role, letters(s));
    }
  })();
}
async function saveRolePerms(blockId, role, p) {
  const v = normPerms(p);
  await db.prepare(`INSERT INTO lib_role_perms (block_id, role, p_view, p_read, p_add, p_edit, p_delete) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (block_id, role) DO UPDATE SET p_view = excluded.p_view, p_read = excluded.p_read, p_add = excluded.p_add, p_edit = excluded.p_edit, p_delete = excluded.p_delete`)
    .run(blockId, role, +v.view, +v.read, +v.add, +v.edit, +v.delete);
}
/** Un droit plus fort implique « voir » ; « modifier » et « supprimer » impliquent « lire ». */
function normPerms(p) {
  const o = {}; for (const k of PERM_KEYS) o[k] = Boolean(p && p[k]);
  if (o.edit || o.delete) o.read = true;
  if (o.read || o.add || o.edit || o.delete) o.view = true;
  return o;
}
const fromRow = (r) => ({ view: !!Number(r.p_view), read: !!Number(r.p_read), add: !!Number(r.p_add), edit: !!Number(r.p_edit), delete: !!Number(r.p_delete) });
const ALL = { view: true, read: true, add: true, edit: true, delete: true };
const NONE = { view: false, read: false, add: false, edit: false, delete: false };

async function settingsOf(org) {
  const s = await db.prepare('SELECT * FROM lib_settings WHERE org_id = ?').get(org.id);
  return { grantMinutes: Number(s ? s.grant_minutes : 15), grantMaxMinutes: Number(s ? s.grant_max_minutes : 120), maxFileMb: Number(s ? s.max_file_mb : 0) };
}
async function storageOf(org) {
  const plan = await A.ownerPlan(org);
  const rank = Math.max(0, Math.min(4, require('./features').rank(plan)));
  const set = await settingsOf(org);
  const planMax = FILE_MB[rank] * MB;
  const maxFile = Math.min(HARD_MAX_FILE, set.maxFileMb > 0 ? Math.min(set.maxFileMb * MB, planMax) : planMax);
  const used = Number((await db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM lib_versions WHERE org_id = ?').get(org.id)).s);
  return { used, quota: QUOTA_MB[rank] * MB, maxFile, plan: require('../services/custom-plan').label(plan) };
}

// ---------- Droits et autorisations ----------
async function permsFor(req, block) {
  if (Number(block.personal)) return { ...ALL };
  if (Number(block.hidden) && !A.can(req, 'admin')) return { ...NONE };
  if (req.member.role === 'owner') return { ...ALL };
  const u = await db.prepare('SELECT * FROM lib_user_perms WHERE block_id = ? AND user_id = ?').get(block.id, req.user.id);
  if (u) return normPerms(fromRow(u));
  const r = await db.prepare('SELECT * FROM lib_role_perms WHERE block_id = ? AND role = ?').get(block.id, req.member.role);
  if (r) return normPerms(fromRow(r));
  return req.member.role === 'admin' ? { ...ALL } : { ...NONE };
}
async function loadBlock(req, idv) {
  const b = await db.prepare('SELECT * FROM lib_blocks WHERE id = ? AND org_id = ?').get(A.id(idv, 'Bloc invalide.'), req.org.id);
  if (!b) throw new HttpError(404, 'Bloc introuvable.');
  const perms = await permsFor(req, b);
  if (!perms.view) throw new HttpError(404, 'Bloc introuvable.');
  return { b, perms };
}
const minIso = (a, b) => (a < b ? a : b);
/** Grants valides de cette session : { blockId: expiresAt }. */
async function liveGrants(req) {
  const now = nowISO();
  const rows = await db.prepare('SELECT block_id, expires_at, hard_expires_at FROM lib_grants WHERE session_id = ? AND org_id = ? AND user_id = ?').all(String(req.sessionId || ''), req.org.id, req.user.id);
  const out = {};
  for (const g of rows) if (g.expires_at > now && g.hard_expires_at > now) out[Number(g.block_id)] = g.expires_at;
  return out;
}
/** Vérifie l'autorisation de la session pour ce bloc et la renouvelle (sans dépasser la durée maximale). */
async function requireGrant(req, block) {
  const now = nowISO();
  const g = await db.prepare('SELECT * FROM lib_grants WHERE session_id = ? AND block_id = ? AND user_id = ?').get(String(req.sessionId || ''), block.id, req.user.id);
  if (!g || g.expires_at <= now || g.hard_expires_at <= now) {
    if (g) await db.prepare('DELETE FROM lib_grants WHERE session_id = ? AND block_id = ?').run(g.session_id, g.block_id);
    throw err(403, LOCKED_MSG, 'library_locked');
  }
  const set = await settingsOf(req.org);
  const exp = minIso(new Date(Date.now() + set.grantMinutes * 60000).toISOString(), g.hard_expires_at);
  await db.prepare('UPDATE lib_grants SET expires_at = ? WHERE session_id = ? AND block_id = ?').run(exp, g.session_id, g.block_id);
  return exp;
}
/** Bloc + droits + autorisation : pour toute lecture ou écriture de contenu. */
async function openBlock(req, idv, need) {
  const { b, perms } = await loadBlock(req, idv);
  const expiresAt = await requireGrant(req, b);
  if (need && !perms[need]) { await audit(req, 'denied', b, need); throw new HttpError(403, DENIED); }
  return { b, perms, expiresAt };
}
/** Document (non supprimé par défaut) dont le bloc est ouvert pour cette session. */
async function openDoc(req, idv, need, { deleted = false } = {}) {
  const d = await db.prepare('SELECT * FROM lib_docs WHERE id = ? AND org_id = ?').get(A.id(idv), req.org.id);
  if (!d || Boolean(d.deleted_at) !== deleted) throw new HttpError(404, 'Document introuvable.');
  const { b, perms, expiresAt } = await openBlock(req, d.block_id);
  if (Number(b.personal) && Number(d.owner_id) !== Number(req.user.id)) throw new HttpError(404, 'Document introuvable.');
  if (need && !perms[need]) { await audit(req, 'denied', b, `${need} · ${d.name}`); throw new HttpError(403, DENIED); }
  return { d, b, perms, expiresAt };
}
/** Blocs ouverts par cette session où la personne a le droit de voir : { id: { b, perms } }. */
async function unlockedBlocks(req) {
  const grants = await liveGrants(req);
  const ids = Object.keys(grants).map(Number);
  const out = {};
  if (!ids.length) return out;
  const rows = await db.prepare(`SELECT * FROM lib_blocks WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids);
  for (const b of rows) { const perms = await permsFor(req, b); if (perms.view) out[Number(b.id)] = { b, perms }; }
  return out;
}

// ---------- Vues ----------
const parseTags = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [];
  for (const x of list) { const t = cleanText(String(x), 30).replace(/\s+/g, ' '); if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t); if (out.length >= 10) break; }
  return out;
}
async function namesOf(ids) {
  const list = [...new Set(ids.filter((x) => x != null).map(Number))];
  if (!list.length) return {};
  const rows = await db.prepare(`SELECT id, name FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list);
  return Object.fromEntries(rows.map((r) => [Number(r.id), r.name]));
}
async function favSet(req, ids) {
  if (!ids.length) return new Set();
  const rows = await db.prepare(`SELECT doc_id FROM lib_favorites WHERE user_id = ? AND doc_id IN (${ids.map(() => '?').join(',')})`).all(req.user.id, ...ids);
  return new Set(rows.map((r) => Number(r.doc_id)));
}
async function docViews(req, rows, blocks) {
  const ids = rows.map((d) => Number(d.id));
  const fav = await favSet(req, ids);
  const names = await namesOf(rows.map((d) => d.created_by));
  return rows.map((d) => {
    const b = blocks && blocks[Number(d.block_id)];
    return {
      id: Number(d.id), name: d.name, mime: d.mime, size: Number(d.size), version: Number(d.version), tags: parseTags(d.tags),
      favorite: fav.has(Number(d.id)), author: names[Number(d.created_by)] || '', updatedAt: d.updated_at,
      block: b ? { id: Number(b.id), name: b.name, color: b.color } : undefined,
    };
  });
}
const blockView = (b) => ({ id: Number(b.id), name: b.name, color: b.color, icon: b.icon, hidden: Boolean(Number(b.hidden)), personal: Boolean(Number(b.personal)), builtin: Boolean(Number(b.builtin)) });
/** Filtre SQL des documents visibles d'un bloc (le bloc personnel ne montre que les siens). */
const ownFilter = (req, b) => (Number(b.personal) ? { sql: ' AND owner_id = ?', args: [req.user.id] } : { sql: '', args: [] });

// ---------- Fichiers : type reconnu d'après le contenu ----------
const MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', zip: 'application/zip',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  txt: 'text/plain', csv: 'text/csv', md: 'text/plain', mp3: 'audio/mpeg', mp4: 'video/mp4', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'video/webm',
};
const BLOCKED_EXT = /^(exe|msi|bat|cmd|com|scr|ps1|sh|js|mjs|vbs|jar|apk|dll|html?|xhtml|svg|php|py|rb|pl|hta|wsf|lnk|reg|dmg|app|iso)$/;
const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
/** Renvoie { ext, mime } d'après le contenu, ou lève une erreur claire. Le nom ne sert qu'à départager les formats à enveloppe commune (ZIP, OLE). */
function detect(buf, name) {
  const ext = extOf(name);
  if (BLOCKED_EXT.test(ext)) throw new HttpError(400, 'Ce type de fichier (programme, page web ou script) n’est pas accepté dans la bibliothèque.');
  const b = buf;
  const head = (n, enc = 'latin1') => b.toString(enc, 0, Math.min(n, b.length));
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) throw new HttpError(400, 'Ce type de fichier (programme, page web ou script) n’est pas accepté dans la bibliothèque.');
  if (b.length >= 4 && b[0] === 0x7f && head(4) === '\x7fELF') throw new HttpError(400, 'Ce type de fichier (programme, page web ou script) n’est pas accepté dans la bibliothèque.');
  const simple = X.sniff(b);
  if (simple) return { ext: simple.ext, mime: simple.mime };
  if (head(6) === 'GIF87a' || head(6) === 'GIF89a') return { ext: 'gif', mime: MIME.gif };
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const zipKinds = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'zip'];
    if (zipKinds.includes(ext)) {
      const inner = b.subarray(0, Math.min(b.length, 4096)).toString('latin1');
      const office = /\[Content_Types\]\.xml|word\/|xl\/|ppt\/|_rels\//.test(inner);
      const open = /mimetypeapplication\/vnd\.oasis\.opendocument/.test(inner);
      if (['docx', 'xlsx', 'pptx'].includes(ext) && !office) throw new HttpError(400, 'Le contenu du fichier ne correspond pas à son extension : envoi refusé.');
      if (['odt', 'ods', 'odp'].includes(ext) && !open) throw new HttpError(400, 'Le contenu du fichier ne correspond pas à son extension : envoi refusé.');
      return { ext, mime: MIME[ext] };
    }
    if (ext) throw new HttpError(400, 'Le contenu du fichier ne correspond pas à son extension : envoi refusé.');
    return { ext: 'zip', mime: MIME.zip };
  }
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    if (['doc', 'xls', 'ppt'].includes(ext)) return { ext, mime: MIME[ext] };
    throw new HttpError(400, 'Ancien format Office : donnez au fichier son extension (.doc, .xls ou .ppt).');
  }
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (/^M4A/.test(brand) || ext === 'm4a') return { ext: 'm4a', mime: MIME.m4a };
    return { ext: 'mp4', mime: MIME.mp4 };
  }
  if (head(3) === 'ID3' || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: MIME.mp3 };
  if (head(4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return { ext: 'wav', mime: MIME.wav };
  if (head(4) === 'OggS') return { ext: 'ogg', mime: MIME.ogg };
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm', mime: MIME.webm };
  if (['txt', 'csv', 'md'].includes(ext) && b.length && !b.includes(0)) {
    const s = b.toString('utf8');
    if (!s.includes('�') && !/<\s*(script|html|svg|iframe)\b/i.test(s.slice(0, 4096))) return { ext, mime: MIME[ext] };
  }
  throw new HttpError(400, 'Fichier non reconnu : formats acceptés : PDF, images, documents Office ou OpenDocument, texte, audio et vidéo courants.');
}
/** Nom propre ; l'extension suit toujours le type réellement reconnu. */
function fileName(raw, ext) {
  const base = cleanText(String(raw || ''), 120).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || 'document';
  return `${base.slice(0, 110)}.${ext}`;
}
const typeLabel = (mime) => (mime === 'application/pdf' ? 'PDF' : mime.startsWith('image/') ? 'Images' : /^(audio|video)\//.test(mime) ? 'Audio et vidéo' : /msword|ms-excel|ms-powerpoint|officedocument|opendocument/.test(mime) ? 'Documents Office' : 'Fichier');

const upLimit = limits.make(10 * 60 * 1000, 60, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");
const dlLimit = limits.make(10 * 60 * 1000, 300, 'Trop de téléchargements. Réessayez dans quelques minutes.');
const unlockLimit = limits.make(15 * 60 * 1000, 20, 'Trop de tentatives. Réessayez dans 15 minutes.', { shared: true, prefix: 'libunlock' });
const rawBody = express.raw({ type: () => true, limit: HARD_MAX_FILE + 1024 });

async function checkSpace(req, size) {
  const st = await storageOf(req.org);
  if (size > st.maxFile) throw new HttpError(413, 'Fichier trop lourd pour votre offre.');
  if (st.used + size > st.quota) throw new HttpError(403, 'Espace de la bibliothèque plein : supprimez des documents ou passez à une offre supérieure.');
}
const bodyBuf = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

// ---------- Toutes les routes : blocs de départ créés au premier passage ----------
router.use(async (req, res, next) => { await ensureDefaults(req.org); next(); });

// ---------- Accueil ----------
router.get('/overview', async (req, res) => {
  const all = await db.prepare('SELECT * FROM lib_blocks WHERE org_id = ? ORDER BY position, id').all(req.org.id);
  const grants = await liveGrants(req);
  const blocks = []; const seen = [];
  for (const b of all) {
    const perms = await permsFor(req, b);
    if (!perms.view) continue;
    const f = ownFilter(req, b);
    const c = await db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM lib_docs WHERE block_id = ? AND deleted_at IS NULL${f.sql}`).get(b.id, ...f.args);
    seen.push({ count: Number(c.c), size: Number(c.s) });
    const exp = grants[Number(b.id)];
    blocks.push({ ...blockView(b), docCount: Number(c.c), unlocked: Boolean(exp), expiresAt: exp || null });
  }
  const projects = Number((await db.prepare("SELECT COUNT(*) AS c FROM projects WHERE org_id = ? AND status = 'active'").get(req.org.id)).c);
  const st = await storageOf(req.org);
  res.json({
    blocks,
    stats: { documents: seen.reduce((s, x) => s + x.count, 0), modulesUsed: seen.filter((x) => x.count > 0).length, activeProjects: projects, volume: seen.reduce((s, x) => s + x.size, 0) },
    storage: { used: st.used, quota: st.quota },
  });
});

// ---------- Blocs (administrateurs) ----------
function blockInput(b, cur) {
  const name = b.name === undefined && cur ? cur.name : A.text(b.name, 60, { required: true, msg: 'Indiquez le nom du bloc.' });
  const color = b.color === undefined && cur ? cur.color : String(b.color || '#2f6f5e');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'Couleur invalide (format #RRGGBB).');
  const icon = b.icon === undefined && cur ? cur.icon : String(b.icon || 'folder');
  if (!ICONS.includes(icon)) throw new HttpError(400, 'Icône inconnue.');
  const hidden = b.hidden === undefined && cur ? Number(cur.hidden) : (b.hidden ? 1 : 0);
  return { name, color: color.toLowerCase(), icon, hidden };
}
router.post('/blocks', A.need('admin'), async (req, res) => {
  const v = blockInput(req.body || {});
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_blocks WHERE org_id = ?').get(req.org.id)).c);
  if (n >= MAX_BLOCKS) throw new HttpError(403, 'Vous avez atteint 40 blocs : supprimez-en un avant d’en ajouter.');
  const pos = Number((await db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM lib_blocks WHERE org_id = ?').get(req.org.id)).p) + 1;
  const id = Number((await db.prepare('INSERT INTO lib_blocks (org_id, name, color, icon, hidden, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, v.name, v.color, v.icon, v.hidden, pos, req.user.id, nowISO())).lastInsertRowid);
  // Par défaut : les administrateurs ont tout, les autres rien (à ouvrir dans « Droits d'accès »).
  await saveRolePerms(id, 'admin', ALL); await saveRolePerms(id, 'manager', NONE); await saveRolePerms(id, 'member', NONE);
  await audit(req, 'block_create', { id, name: v.name });
  res.status(201).json({ id });
});
router.put('/blocks/:id', A.need('admin'), async (req, res) => {
  const { b } = await loadBlock(req, req.params.id);
  const v = blockInput(req.body || {}, b);
  if (Number(b.personal)) v.hidden = 0; // le bloc personnel reste visible de chacun
  await db.prepare('UPDATE lib_blocks SET name = ?, color = ?, icon = ?, hidden = ? WHERE id = ?').run(v.name, v.color, v.icon, v.hidden, b.id);
  await audit(req, 'block_update', { id: b.id, name: v.name }, b.name !== v.name ? `ancien nom : ${b.name}` : '');
  res.json({ ok: true });
});
router.delete('/blocks/:id', A.need('admin'), async (req, res) => {
  const { b } = await loadBlock(req, req.params.id);
  if (Number(b.builtin)) throw new HttpError(400, 'Un bloc de départ ne se supprime pas : masquez-le plutôt.');
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_docs WHERE block_id = ?').get(b.id)).c);
  if (n) throw new HttpError(400, 'Ce bloc contient encore des documents (corbeille comprise) : videz-le avant de le supprimer.');
  await db.prepare('DELETE FROM lib_blocks WHERE id = ?').run(b.id);
  await audit(req, 'block_delete', null, b.name);
  res.json({ ok: true });
});

// ---------- Droits d'un bloc ----------
router.get('/blocks/:id/perms', A.need('admin'), async (req, res) => {
  const { b } = await loadBlock(req, req.params.id);
  const members = (await db.prepare('SELECT m.user_id, m.role, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name').all(req.org.id))
    .map((m) => ({ userId: Number(m.user_id), name: m.name, role: m.role, roleLabel: A.ROLE_LABEL[m.role] }));
  if (Number(b.personal)) return res.json({ personal: true, roles: {}, users: [], members });
  const roles = {};
  for (const r of ROLE_KEYS) { const row = await db.prepare('SELECT * FROM lib_role_perms WHERE block_id = ? AND role = ?').get(b.id, r); roles[r] = row ? normPerms(fromRow(row)) : (r === 'admin' ? { ...ALL } : { ...NONE }); }
  const users = (await db.prepare('SELECT * FROM lib_user_perms WHERE block_id = ? ORDER BY user_id').all(b.id)).map((u) => ({ userId: Number(u.user_id), ...normPerms(fromRow(u)) }));
  res.json({ personal: false, roles, users, members });
});
router.put('/blocks/:id/perms', A.need('admin'), async (req, res) => {
  const { b } = await loadBlock(req, req.params.id);
  if (Number(b.personal)) throw new HttpError(400, 'Les dossiers personnels sont privés : leurs droits ne se règlent pas.');
  const body = req.body || {};
  const isOwner = A.can(req, 'owner');
  const roles = body.roles && typeof body.roles === 'object' ? body.roles : {};
  const users = Array.isArray(body.users) ? body.users : [];
  if (users.length > MAX_EXCEPTIONS) throw new HttpError(400, 'Trop d’exceptions personnelles.');
  const members = Object.fromEntries((await db.prepare('SELECT user_id, role FROM org_members WHERE org_id = ?').all(req.org.id)).map((m) => [Number(m.user_id), m.role]));
  const wanted = new Map();
  for (const u of users) {
    const uid = A.id(u && u.userId);
    const role = members[uid];
    if (!role || role === 'owner') continue; // inconnu ou propriétaire (il a toujours tout)
    if (role === 'admin' && !isOwner) continue; // seul le propriétaire règle les droits d'un administrateur
    wanted.set(uid, normPerms(u));
  }
  await db.transaction(async () => {
    for (const r of ROLE_KEYS) {
      if (r === 'admin' && !isOwner) continue;
      if (roles[r]) await saveRolePerms(b.id, r, roles[r]);
    }
    const existing = await db.prepare('SELECT user_id FROM lib_user_perms WHERE block_id = ?').all(b.id);
    for (const e of existing) {
      const uid = Number(e.user_id);
      if (wanted.has(uid)) continue;
      if (members[uid] === 'admin' && !isOwner) continue; // garde l'exception d'un administrateur
      await db.prepare('DELETE FROM lib_user_perms WHERE block_id = ? AND user_id = ?').run(b.id, uid);
    }
    for (const [uid, p] of wanted) {
      await db.prepare(`INSERT INTO lib_user_perms (block_id, user_id, p_view, p_read, p_add, p_edit, p_delete) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (block_id, user_id) DO UPDATE SET p_view = excluded.p_view, p_read = excluded.p_read, p_add = excluded.p_add, p_edit = excluded.p_edit, p_delete = excluded.p_delete`)
        .run(b.id, uid, +p.view, +p.read, +p.add, +p.edit, +p.delete);
    }
  })();
  // Droits retirés : les autorisations ouvertes de ces personnes sont fermées tout de suite.
  for (const g of await db.prepare('SELECT DISTINCT user_id FROM lib_grants WHERE block_id = ?').all(b.id)) {
    const m = await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, g.user_id);
    if (!m) { await db.prepare('DELETE FROM lib_grants WHERE block_id = ? AND user_id = ?').run(b.id, g.user_id); continue; }
    const p = await permsFor({ ...req, member: m, user: { id: Number(g.user_id) } }, b);
    if (!p.view) await db.prepare('DELETE FROM lib_grants WHERE block_id = ? AND user_id = ?').run(b.id, g.user_id);
  }
  await audit(req, 'perms', b, `${wanted.size} exception(s)`);
  res.json({ ok: true });
});

// ---------- Entrer, refermer ----------
router.post('/blocks/:id/unlock', unlockLimit, async (req, res) => {
  const { b } = await loadBlock(req, req.params.id);
  const since = new Date(Date.now() - FAIL_WINDOW_MIN * 60000).toISOString();
  const fails = Number((await db.prepare("SELECT COUNT(*) AS c FROM lib_audit WHERE org_id = ? AND user_id = ? AND action = 'unlock_fail' AND at > ?").get(req.org.id, req.user.id, since)).c);
  if (fails >= FAIL_MAX) {
    await audit(req, 'unlock_locked', b);
    throw new HttpError(429, 'Trop d’essais : ce bloc est fermé pour votre compte pendant 15 minutes.');
  }
  const pass = typeof (req.body || {}).password === 'string' ? req.body.password.slice(0, 200) : '';
  if (!pass || !(await bcrypt.compare(pass, req.user.pass_hash))) {
    await audit(req, 'unlock_fail', b);
    const central = require('../security');
    await central.audit.record(req, 'library.unlock_fail', { severity: 'warn', orgId: req.org.id, target: `bloc ${b.id}` });
    await central.abuse.strike(req, 'login_fail');
    throw new HttpError(403, 'Mot de passe incorrect.');
  }
  const set = await settingsOf(req.org);
  const now = Date.now();
  const exp = new Date(now + set.grantMinutes * 60000).toISOString();
  const hard = new Date(now + Math.max(set.grantMaxMinutes, set.grantMinutes) * 60000).toISOString();
  await db.prepare(`INSERT INTO lib_grants (session_id, block_id, org_id, user_id, expires_at, hard_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id, block_id) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at, hard_expires_at = excluded.hard_expires_at, created_at = excluded.created_at`)
    .run(String(req.sessionId), b.id, req.org.id, req.user.id, exp, hard, nowISO());
  await audit(req, 'unlock', b);
  res.json({ ok: true, expiresAt: exp, hardExpiresAt: hard });
});
router.post('/blocks/:id/lock', async (req, res) => {
  const b = await db.prepare('SELECT * FROM lib_blocks WHERE id = ? AND org_id = ?').get(A.id(req.params.id, 'Bloc invalide.'), req.org.id);
  if (!b) throw new HttpError(404, 'Bloc introuvable.');
  const r = await db.prepare('DELETE FROM lib_grants WHERE session_id = ? AND block_id = ?').run(String(req.sessionId), b.id);
  if (r.changes) await audit(req, 'lock', b);
  res.json({ ok: true });
});
router.post('/lock-all', async (req, res) => {
  const r = await db.prepare('DELETE FROM lib_grants WHERE session_id = ? AND org_id = ?').run(String(req.sessionId), req.org.id);
  if (r.changes) await audit(req, 'lock', null, `${r.changes} bloc(s)`);
  res.json({ ok: true, closed: r.changes });
});

// ---------- Contenu d'un bloc ----------
async function breadcrumbs(folderId, blockId) {
  const out = []; let cur = folderId; let guard = 0;
  while (cur && guard++ < MAX_DEPTH + 2) {
    const f = await db.prepare('SELECT id, name, parent_id FROM lib_folders WHERE id = ? AND block_id = ?').get(cur, blockId);
    if (!f) break;
    out.unshift({ id: Number(f.id), name: f.name });
    cur = f.parent_id;
  }
  return out;
}
async function loadFolder(req, b, idv) {
  if (idv === undefined || idv === null || idv === '' || idv === 'null') return null;
  const f = await db.prepare('SELECT * FROM lib_folders WHERE id = ? AND block_id = ?').get(A.id(idv), b.id);
  if (!f || (Number(b.personal) && Number(f.owner_id) !== Number(req.user.id))) throw new HttpError(404, 'Dossier introuvable.');
  return f;
}
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

router.get('/blocks/:id', async (req, res) => {
  const { b, perms, expiresAt } = await openBlock(req, req.params.id);
  const q = req.query || {};
  const folder = await loadFolder(req, b, q.folderId);
  const own = ownFilter(req, b);
  const search = cleanText(String(q.q || ''), 100);
  const tag = cleanText(String(q.tag || ''), 30);
  const sort = { name: 'LOWER(name), id', date: 'updated_at DESC, id DESC', size: 'size DESC, id' }[q.sort] || 'LOWER(name), id';
  let where = `block_id = ? AND deleted_at IS NULL${own.sql}`; const args = [b.id, ...own.args];
  if (search || tag) {
    if (search) { where += " AND LOWER(name) LIKE ? ESCAPE '\\'"; args.push(`%${likeEsc(search.toLowerCase())}%`); }
  } else if (folder) { where += ' AND folder_id = ?'; args.push(folder.id); } else where += ' AND folder_id IS NULL';
  let rows = await db.prepare(`SELECT * FROM lib_docs WHERE ${where} ORDER BY ${sort} LIMIT 1000`).all(...args);
  if (tag) rows = rows.filter((d) => parseTags(d.tags).some((t) => t.toLowerCase() === tag.toLowerCase()));
  const fArgs = [b.id, ...(Number(b.personal) ? [req.user.id] : [])];
  const fOwn = Number(b.personal) ? ' AND owner_id = ?' : '';
  const folders = search || tag ? [] : await db.prepare(`SELECT f.id, f.name,
      (SELECT COUNT(*) FROM lib_docs d WHERE d.folder_id = f.id AND d.deleted_at IS NULL) AS docs,
      (SELECT COUNT(*) FROM lib_folders s WHERE s.parent_id = f.id) AS subfolders
    FROM lib_folders f WHERE f.block_id = ?${fOwn} AND ${folder ? 'f.parent_id = ?' : 'f.parent_id IS NULL'} ORDER BY LOWER(f.name), f.id`).all(...fArgs, ...(folder ? [folder.id] : []));
  const allTags = new Set();
  for (const d of await db.prepare(`SELECT tags FROM lib_docs WHERE block_id = ? AND deleted_at IS NULL${own.sql}`).all(b.id, ...own.args)) for (const t of parseTags(d.tags)) allTags.add(t);
  if (!folder && !search && !tag) await audit(req, 'open', b);
  res.json({
    block: blockView(b), perms, expiresAt,
    breadcrumbs: folder ? await breadcrumbs(folder.id, b.id) : [],
    folders: folders.map((f) => ({ id: Number(f.id), name: f.name, docs: Number(f.docs), subfolders: Number(f.subfolders) })),
    docs: await docViews(req, rows),
    tags: [...allTags].sort((x, y) => x.localeCompare(y, 'fr')),
  });
});
router.get('/blocks/:id/stats', async (req, res) => {
  const { b } = await openBlock(req, req.params.id);
  const own = ownFilter(req, b);
  const docs = await db.prepare(`SELECT mime, size, created_by, updated_at, deleted_at FROM lib_docs WHERE block_id = ?${own.sql}`).all(b.id, ...own.args);
  const live = docs.filter((d) => !d.deleted_at);
  const vol = Number((await db.prepare(`SELECT COALESCE(SUM(v.size), 0) AS s FROM lib_versions v JOIN lib_docs d ON d.id = v.doc_id WHERE d.block_id = ?${own.sql.replace('owner_id', 'd.owner_id')}`).get(b.id, ...own.args)).s);
  const folders = Number((await db.prepare(`SELECT COUNT(*) AS c FROM lib_folders WHERE block_id = ?${own.sql}`).get(b.id, ...own.args)).c);
  const byType = {}; const byAuthor = {};
  for (const d of live) { const t = typeLabel(d.mime); byType[t] = (byType[t] || 0) + 1; byAuthor[d.created_by] = (byAuthor[d.created_by] || 0) + 1; }
  const names = await namesOf(Object.keys(byAuthor).filter((k) => k !== 'null'));
  res.json({
    documents: live.length, folders, volume: vol, trash: docs.length - live.length,
    byType: Object.entries(byType).map(([type, count]) => ({ type, count })).sort((x, y) => y.count - x.count),
    byAuthor: Object.entries(byAuthor).map(([id, count]) => ({ author: names[Number(id)] || '—', count })).sort((x, y) => y.count - x.count),
    lastActivity: live.reduce((m, d) => (d.updated_at > m ? d.updated_at : m), '') || null,
  });
});

// ---------- Dossiers ----------
router.post('/blocks/:id/folders', async (req, res) => {
  const { b } = await openBlock(req, req.params.id, 'add');
  const body = req.body || {};
  const name = A.text(body.name, 80, { required: true, msg: 'Indiquez le nom du dossier.' }).replace(/[\\/]/g, '-');
  const parent = await loadFolder(req, b, body.parentId);
  if (parent && (await breadcrumbs(parent.id, b.id)).length >= MAX_DEPTH) throw new HttpError(400, 'Les dossiers ne vont pas au-delà de 6 niveaux.');
  const n = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_folders WHERE block_id = ?').get(b.id)).c);
  if (n >= MAX_FOLDERS) throw new HttpError(403, 'Ce bloc contient déjà 500 dossiers.');
  const id = Number((await db.prepare('INSERT INTO lib_folders (org_id, block_id, parent_id, owner_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, b.id, parent ? parent.id : null, Number(b.personal) ? req.user.id : null, name, req.user.id, nowISO())).lastInsertRowid);
  await audit(req, 'folder_create', b, name);
  res.status(201).json({ id });
});
async function folderAccess(req, need) {
  const f = await db.prepare('SELECT * FROM lib_folders WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!f) throw new HttpError(404, 'Dossier introuvable.');
  const { b } = await openBlock(req, f.block_id, need);
  if (Number(b.personal) && Number(f.owner_id) !== Number(req.user.id)) throw new HttpError(404, 'Dossier introuvable.');
  return { f, b };
}
router.put('/folders/:id', async (req, res) => {
  const { f, b } = await folderAccess(req, 'edit');
  const name = A.text((req.body || {}).name, 80, { required: true, msg: 'Indiquez le nom du dossier.' }).replace(/[\\/]/g, '-');
  await db.prepare('UPDATE lib_folders SET name = ? WHERE id = ?').run(name, f.id);
  await audit(req, 'folder_rename', b, `${f.name} → ${name}`);
  res.json({ ok: true });
});
router.delete('/folders/:id', async (req, res) => {
  const { f, b } = await folderAccess(req, 'delete');
  const docs = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_docs WHERE folder_id = ?').get(f.id)).c);
  const subs = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_folders WHERE parent_id = ?').get(f.id)).c);
  if (docs || subs) throw new HttpError(400, 'Ce dossier n’est pas vide (corbeille comprise) : videz-le avant de le supprimer.');
  await db.prepare('DELETE FROM lib_folders WHERE id = ?').run(f.id);
  await audit(req, 'folder_delete', b, f.name);
  res.json({ ok: true });
});

// ---------- Documents ----------
router.post('/blocks/:id/docs', upLimit, rawBody, async (req, res) => {
  const { b } = await openBlock(req, req.params.id, 'add');
  const folder = await loadFolder(req, b, (req.query || {}).folderId);
  const buf = bodyBuf(req);
  if (!buf.length) throw new HttpError(400, 'Fichier non reconnu : formats acceptés : PDF, images, documents Office ou OpenDocument, texte, audio et vidéo courants.');
  const t = detect(buf, req.query.name);
  await checkSpace(req, buf.length);
  const name = fileName(req.query.name, t.ext);
  const now = nowISO();
  const id = await db.transaction(async () => {
    const did = Number((await db.prepare('INSERT INTO lib_docs (org_id, block_id, folder_id, owner_id, name, mime, size, version, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
      .run(req.org.id, b.id, folder ? folder.id : null, Number(b.personal) ? req.user.id : null, name, t.mime, buf.length, req.user.id, req.user.id, now, now)).lastInsertRowid);
    await db.prepare('INSERT INTO lib_versions (org_id, doc_id, n, name, mime, size, data, note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, did, name, t.mime, buf.length, X.seal(buf), '', req.user.id, now);
    return did;
  })();
  await audit(req, 'upload', b, name);
  res.status(201).json({ id, name, mime: t.mime, size: buf.length });
});

router.get('/docs/:id', async (req, res) => {
  const { d, perms } = await openDoc(req, req.params.id, 'read');
  const versions = await db.prepare('SELECT n, name, size, note, created_by, created_at FROM lib_versions WHERE doc_id = ? ORDER BY n DESC').all(d.id);
  const names = await namesOf([d.created_by, d.updated_by, ...versions.map((v) => v.created_by)]);
  const [view] = await docViews(req, [d]);
  await db.prepare('INSERT INTO lib_recent (user_id, doc_id, at) VALUES (?, ?, ?) ON CONFLICT (user_id, doc_id) DO UPDATE SET at = excluded.at').run(req.user.id, d.id, nowISO());
  res.json({
    doc: { ...view, createdAt: d.created_at, editor: d.updated_by && Number(d.updated_by) !== Number(d.created_by) ? names[Number(d.updated_by)] || '' : '', linkType: d.link_type || null, linkId: d.link_id ? Number(d.link_id) : null },
    perms,
    versions: versions.map((v) => ({ n: Number(v.n), name: v.name, size: Number(v.size), note: v.note, author: names[Number(v.created_by)] || '', createdAt: v.created_at })),
  });
});
router.put('/docs/:id', async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'edit');
  const body = req.body || {};
  const ext = extOf(d.name);
  let name = d.name;
  if (body.name !== undefined) {
    const raw = A.text(body.name, 120, { required: true, msg: 'Indiquez le nom du document.' });
    name = fileName(raw, ext || 'bin'); // l'extension reste celle du contenu réel
  }
  const tags = body.tags === undefined ? parseTags(d.tags) : cleanTags(body.tags);
  let linkType = d.link_type; let linkId = d.link_id;
  if (body.linkType !== undefined) {
    if (body.linkType === null || body.linkType === '') { linkType = null; linkId = null; } else {
      if (!['project', 'contract'].includes(body.linkType)) throw new HttpError(400, 'Lien inconnu (project ou contract).');
      linkId = A.id(body.linkId, 'Lien invalide.');
      const table = body.linkType === 'project' ? 'projects' : 'legal_contracts';
      if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND org_id = ?`).get(linkId, req.org.id))) throw new HttpError(400, body.linkType === 'project' ? 'Projet inconnu.' : 'Contrat inconnu.');
      linkType = body.linkType;
    }
  }
  await db.prepare('UPDATE lib_docs SET name = ?, tags = ?, link_type = ?, link_id = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(tags), linkType, linkId, req.user.id, nowISO(), d.id);
  await audit(req, 'edit', b, name !== d.name ? `${d.name} → ${name}` : name);
  res.json({ ok: true, name });
});
router.delete('/docs/:id', async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'delete');
  await db.prepare('UPDATE lib_docs SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowISO(), req.user.id, d.id);
  await audit(req, 'trash', b, d.name);
  res.json({ ok: true });
});
router.post('/docs/:id/restore', async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'delete', { deleted: true });
  // Le dossier d'origine a pu disparaître : le document revient alors à la racine du bloc.
  const folderOk = d.folder_id ? await db.prepare('SELECT 1 FROM lib_folders WHERE id = ? AND block_id = ?').get(d.folder_id, b.id) : null;
  await db.prepare('UPDATE lib_docs SET deleted_at = NULL, deleted_by = NULL, folder_id = ? WHERE id = ?').run(folderOk ? d.folder_id : null, d.id);
  await audit(req, 'restore', b, d.name);
  res.json({ ok: true });
});
router.delete('/docs/:id/purge', async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'delete', { deleted: true });
  await db.prepare('DELETE FROM lib_docs WHERE id = ?').run(d.id);
  await audit(req, 'purge', b, d.name);
  res.json({ ok: true });
});
router.post('/docs/:id/favorite', async (req, res) => {
  const { d } = await openDoc(req, req.params.id, 'view');
  if ((req.body || {}).on) await db.prepare('INSERT INTO lib_favorites (user_id, doc_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, doc_id) DO NOTHING').run(req.user.id, d.id, nowISO());
  else await db.prepare('DELETE FROM lib_favorites WHERE user_id = ? AND doc_id = ?').run(req.user.id, d.id);
  res.json({ ok: true });
});

// ---------- Fichiers : téléchargement et aperçu ----------
async function versionOf(d, v) {
  if (v === undefined || v === '') return db.prepare('SELECT * FROM lib_versions WHERE doc_id = ? AND n = ?').get(d.id, d.version);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Version invalide.');
  const row = await db.prepare('SELECT * FROM lib_versions WHERE doc_id = ? AND n = ?').get(d.id, n);
  if (!row) throw new HttpError(404, 'Version introuvable.');
  return row;
}
const dispo = (kind, name) => `${kind}; filename="${name.replace(/[^A-Za-z0-9._ -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
router.get('/docs/:id/download', dlLimit, async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'read');
  const v = await versionOf(d, req.query.version);
  const data = X.unseal(v.data);
  if (!data) throw new HttpError(500, 'Fichier illisible.');
  await audit(req, 'download', b, `${v.name} (v${v.n})`);
  res.set({ 'Content-Type': v.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': dispo('attachment', v.name) });
  res.end(data);
});
router.get('/docs/:id/preview', dlLimit, async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'read');
  const v = await versionOf(d, req.query.version);
  const pdf = v.mime === 'application/pdf';
  if (!pdf && !/^image\/(jpeg|png|webp|gif)$/.test(v.mime)) throw new HttpError(400, 'Aperçu indisponible pour ce type de fichier : téléchargez-le.');
  const data = X.unseal(v.data);
  if (!data) throw new HttpError(500, 'Fichier illisible.');
  await audit(req, 'preview', b, `${v.name} (v${v.n})`);
  // Un PDF s'affiche dans un cadre du site (même origine) : le lecteur PDF du navigateur ne fonctionne pas dans un cadre « sandbox ».
  res.set({
    'Content-Type': v.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': pdf ? "frame-ancestors 'self'" : "default-src 'none'; sandbox", 'X-Frame-Options': 'SAMEORIGIN', 'Content-Disposition': dispo('inline', v.name),
  });
  res.end(data);
});

// ---------- Versions ----------
router.post('/docs/:id/versions', upLimit, rawBody, async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'edit');
  const buf = bodyBuf(req);
  if (!buf.length) throw new HttpError(400, 'Fichier non reconnu : formats acceptés : PDF, images, documents Office ou OpenDocument, texte, audio et vidéo courants.');
  const t = detect(buf, req.query.name || d.name);
  const count = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_versions WHERE doc_id = ?').get(d.id)).c);
  if (count >= MAX_VERSIONS) throw new HttpError(403, 'Ce document a déjà 20 versions : supprimez-en d’anciennes pour en ajouter.');
  await checkSpace(req, buf.length);
  const name = fileName(req.query.name || d.name, t.ext);
  const note = cleanText(String(req.query.note || ''), 200);
  const n = await addVersion(req, d, { name, mime: t.mime, size: buf.length, data: X.seal(buf), note });
  await audit(req, 'version', b, `${name} (v${n})`);
  res.status(201).json({ ok: true, version: n });
});
async function addVersion(req, d, v) {
  const now = nowISO();
  return db.transaction(async () => {
    const n = Number((await db.prepare('SELECT COALESCE(MAX(n), 0) AS m FROM lib_versions WHERE doc_id = ?').get(d.id)).m) + 1;
    await db.prepare('INSERT INTO lib_versions (org_id, doc_id, n, name, mime, size, data, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, d.id, n, v.name, v.mime, v.size, v.data, v.note, req.user.id, now);
    await db.prepare('UPDATE lib_docs SET name = ?, mime = ?, size = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(v.name, v.mime, v.size, n, req.user.id, now, d.id);
    return n;
  })();
}
router.post('/docs/:id/versions/:n/restore', async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'edit');
  const v = await versionOf(d, req.params.n);
  if (Number(v.n) === Number(d.version)) return res.json({ ok: true, version: Number(d.version) });
  const count = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_versions WHERE doc_id = ?').get(d.id)).c);
  if (count >= MAX_VERSIONS) throw new HttpError(403, 'Ce document a déjà 20 versions : supprimez-en d’anciennes pour en ajouter.');
  await checkSpace(req, Number(v.size));
  const n = await addVersion(req, d, { name: v.name, mime: v.mime, size: Number(v.size), data: v.data, note: `Version ${v.n} rétablie` });
  await audit(req, 'version_restore', b, `${d.name} : v${v.n} → v${n}`);
  res.json({ ok: true, version: n });
});
router.delete('/docs/:id/versions/:n', async (req, res) => {
  const { d, b } = await openDoc(req, req.params.id, 'delete');
  const v = await versionOf(d, req.params.n);
  if (Number(v.n) === Number(d.version)) throw new HttpError(400, 'La version actuelle ne se supprime pas : supprimez le document, ou rétablissez une autre version.');
  await db.prepare('DELETE FROM lib_versions WHERE id = ?').run(v.id);
  await audit(req, 'version_delete', b, `${d.name} (v${v.n})`);
  res.json({ ok: true });
});

// ---------- Listes transversales (seulement les blocs ouverts) ----------
async function docsAcross(req, extraSql, extraArgs, { deleted = false, order = 'd.updated_at DESC', limit = 200, join = '' } = {}) {
  const open = await unlockedBlocks(req);
  const ids = Object.keys(open).map(Number);
  if (!ids.length) return { rows: [], open };
  const rows = await db.prepare(`SELECT d.* FROM lib_docs d ${join} WHERE d.org_id = ? AND d.block_id IN (${ids.map(() => '?').join(',')}) AND d.deleted_at IS ${deleted ? 'NOT ' : ''}NULL ${extraSql} ORDER BY ${order} LIMIT ${limit}`)
    .all(req.org.id, ...ids, ...extraArgs);
  const blocks = Object.fromEntries(Object.entries(open).map(([k, v]) => [k, v.b]));
  return { rows: rows.filter((d) => !Number(blocks[Number(d.block_id)].personal) || Number(d.owner_id) === Number(req.user.id)), open, blocks };
}
router.get('/favorites', async (req, res) => {
  const { rows, blocks } = await docsAcross(req, '', [], { join: 'JOIN lib_favorites f ON f.doc_id = d.id AND f.user_id = ' + Number(req.user.id), order: 'f.created_at DESC' });
  res.json({ docs: await docViews(req, rows, blocks) });
});
router.get('/recent', async (req, res) => {
  const { rows, blocks } = await docsAcross(req, '', [], { join: 'JOIN lib_recent r ON r.doc_id = d.id AND r.user_id = ' + Number(req.user.id), order: 'r.at DESC', limit: 30 });
  res.json({ docs: await docViews(req, rows, blocks) });
});
router.get('/search', async (req, res) => {
  const q = cleanText(String((req.query || {}).q || ''), 100);
  const tag = cleanText(String((req.query || {}).tag || ''), 30);
  if (!q && !tag) throw new HttpError(400, 'Indiquez ce que vous cherchez.');
  const { rows, blocks } = await docsAcross(req, q ? "AND LOWER(d.name) LIKE ? ESCAPE '\\'" : '', q ? [`%${likeEsc(q.toLowerCase())}%`] : [], { limit: 500 });
  const hits = tag ? rows.filter((d) => parseTags(d.tags).some((t) => t.toLowerCase().includes(tag.toLowerCase()))) : rows;
  res.json({ docs: await docViews(req, hits.slice(0, 200), blocks) });
});
router.get('/trash', async (req, res) => {
  const { rows, blocks, open } = await docsAcross(req, '', [], { deleted: true, order: 'd.deleted_at DESC', limit: 500 });
  const visible = rows.filter((d) => open[Number(d.block_id)].perms.delete);
  res.json({
    docs: visible.map((d) => {
      const b = blocks[Number(d.block_id)];
      const left = TRASH_DAYS - Math.floor((Date.now() - new Date(d.deleted_at).getTime()) / 86400000);
      return { id: Number(d.id), name: d.name, size: Number(d.size), deletedAt: d.deleted_at, daysLeft: Math.max(0, left), block: { id: Number(b.id), name: b.name, color: b.color } };
    }),
  });
});

// ---------- Administration : journal et réglages ----------
router.get('/audit', A.need('admin'), async (req, res) => {
  const q = req.query || {};
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 100));
  let where = 'a.org_id = ?'; const args = [req.org.id];
  if (q.action) { if (!ACTIONS[q.action]) throw new HttpError(400, 'Action inconnue.'); where += ' AND a.action = ?'; args.push(q.action); }
  if (q.blockId) { where += ' AND a.block_id = ?'; args.push(A.id(q.blockId, 'Bloc invalide.')); }
  if (q.before) { where += ' AND a.id < ?'; args.push(A.id(q.before, 'Repère invalide.')); }
  const rows = await db.prepare(`SELECT a.*, u.name AS uname FROM lib_audit a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT ${limit + 1}`).all(...args);
  const more = rows.length > limit;
  const list = rows.slice(0, limit);
  res.json({
    entries: list.map((e) => ({ id: Number(e.id), action: e.action, label: ACTIONS[e.action] || e.action, user: e.uname || '', block: e.block_name || '', detail: e.detail, ip: e.ip, at: e.at })),
    actions: Object.entries(ACTIONS).map(([id, label]) => ({ id, label })),
    next: more ? Number(list[list.length - 1].id) : null,
  });
});
router.get('/settings', A.need('admin'), async (req, res) => {
  res.json({ settings: await settingsOf(req.org), storage: await storageOf(req.org) });
});
router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const cur = await settingsOf(req.org);
  const g = b.grantMinutes === undefined ? cur.grantMinutes : Number(b.grantMinutes);
  const m = b.grantMaxMinutes === undefined ? cur.grantMaxMinutes : Number(b.grantMaxMinutes);
  const f = b.maxFileMb === undefined ? cur.maxFileMb : Number(b.maxFileMb);
  if (!Number.isInteger(g) || g < 5 || g > 60) throw new HttpError(400, 'Durée d’autorisation : entre 5 et 60 minutes.');
  if (!Number.isInteger(m) || m < 15 || m > 480) throw new HttpError(400, 'Durée maximale : entre 15 minutes et 8 heures.');
  if (m < g) throw new HttpError(400, 'La durée maximale ne peut pas être inférieure à la durée d’autorisation.');
  if (!Number.isInteger(f) || f < 0 || f > 20) throw new HttpError(400, 'Taille maximale d’un fichier : entre 0 (offre) et 20 Mo.');
  await db.prepare('UPDATE lib_settings SET grant_minutes = ?, grant_max_minutes = ?, max_file_mb = ?, updated_at = ? WHERE org_id = ?').run(g, m, f, nowISO(), req.org.id);
  await audit(req, 'settings', null, `ouverture ${g} min, maximum ${m} min, fichier ${f || 'offre'} Mo`);
  res.json({ ok: true });
});

// ---------- Nettoyage (tâche horaire) : corbeille de plus de 30 jours, autorisations expirées ----------
async function cleanup() {
  const now = nowISO();
  await db.prepare('DELETE FROM lib_grants WHERE hard_expires_at <= ? OR expires_at <= ?').run(now, now);
  const cut = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
  const old = await db.prepare('SELECT d.id, d.org_id, d.name, d.block_id, b.name AS bname FROM lib_docs d JOIN lib_blocks b ON b.id = d.block_id WHERE d.deleted_at IS NOT NULL AND d.deleted_at <= ? LIMIT 1000').all(cut);
  for (const d of old) {
    await db.prepare('DELETE FROM lib_docs WHERE id = ?').run(d.id);
    await db.prepare('INSERT INTO lib_audit (org_id, block_id, block_name, user_id, action, detail, ip, at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run(d.org_id, d.block_id, d.bname, 'auto_purge', d.name, '', now);
  }
  return old.length;
}

module.exports = { router, cleanup, detect, normPerms };
