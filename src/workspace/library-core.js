'use strict';
// Bibliothèque : socle de sécurité et de données.
//   - blocs par défaut (créés à la première visite d'une organisation) et droits par bloc (rôle ou personne) ;
//   - autorisations temporaires (« grants ») créées par un déverrouillage réussi : liées à la personne, au bloc ET à la session de connexion ;
//   - limitation des tentatives de mot de passe (par personne et par bloc, plus un plafond global par personne) ;
//   - journal d'audit de la bibliothèque ;
//   - reconnaissance du type d'un fichier d'après son CONTENU, quotas, corbeille.
// Le mot de passe n'est jamais lu ici : la vérification (bcrypt contre le hash du compte connecté) est dans library.js et rien n'est conservé.
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError, log, oneLine } = require('../util');

// ---------- Réglages de sécurité ----------
const MAX_FAILS = 5;            // essais ratés (par personne et par bloc) avant blocage
const MAX_FAILS_ALL = 12;       // essais ratés (par personne, tous blocs confondus) avant blocage
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const TRASH_DAYS = 30;
const MAX_VERSIONS = 20;
const MAX_FOLDER_DEPTH = 6;
const PERMS = ['view', 'read', 'add', 'edit', 'delete'];

const ago = (ms) => new Date(Date.now() - ms).toISOString();

// ---------- Blocs par défaut ----------
// kind : 'general' (membres : voir et lire), 'sensitive' (membres : rien ; responsables : voir et lire), 'personal' (privé).
const DEFAULT_BLOCKS = [
  { slug: 'procedures', name: 'Procédures et qualité', color: '#2f6f5e', icon: 'shield', kind: 'general' },
  { slug: 'commercial', name: 'Commercial', color: '#c8641e', icon: 'cart', kind: 'general' },
  { slug: 'comptabilite', name: 'Comptabilité et finance', color: '#1f6f8b', icon: 'wallet', kind: 'sensitive' },
  { slug: 'rh', name: 'RH et personnel', color: '#8e4585', icon: 'users', kind: 'sensitive' },
  { slug: 'technique', name: 'Technique et bureau d’études', color: '#4a5d8f', icon: 'ruler', kind: 'general' },
  { slug: 'production', name: 'Production', color: '#a8641a', icon: 'factory', kind: 'general' },
  { slug: 'chantier', name: 'Chantier', color: '#b5483a', icon: 'hardhat', kind: 'general' },
  { slug: 'achats', name: 'Achats et stock', color: '#3d7a3d', icon: 'box', kind: 'general' },
  { slug: 'juridique', name: 'Juridique et administratif', color: '#5b4a8a', icon: 'scale', kind: 'sensitive' },
  { slug: 'formation', name: 'Formation', color: '#2c7f7a', icon: 'book', kind: 'general' },
  { slug: 'correspondance', name: 'Correspondance', color: '#6b7280', icon: 'mail', kind: 'general' },
  { slug: 'projets', name: 'Projets', color: '#2b6cb0', icon: 'target', kind: 'general' },
  { slug: 'securite', name: 'Sécurité', color: '#a32d2d', icon: 'lock', kind: 'sensitive' },
  { slug: 'it', name: 'IT et systèmes', color: '#37474f', icon: 'chip', kind: 'sensitive' },
  { slug: 'multimedia', name: 'Multimédia', color: '#b0498b', icon: 'image', kind: 'general' },
  { slug: 'personnel', name: 'Dossiers personnels', color: '#7a5c2e', icon: 'user', kind: 'personal' },
];
const ICONS = ['folder', 'shield', 'cart', 'wallet', 'users', 'ruler', 'factory', 'hardhat', 'box', 'scale', 'book', 'mail', 'target', 'lock', 'chip', 'image', 'user', 'file', 'star', 'building'];

const P = (view, read, add, edit, del) => ({ view, read, add, edit, delete: del });
const ROLE_DEFAULTS = {
  general: { member: P(1, 1, 0, 0, 0), manager: P(1, 1, 1, 1, 0), admin: P(1, 1, 1, 1, 1) },
  sensitive: { member: P(0, 0, 0, 0, 0), manager: P(1, 1, 0, 0, 0), admin: P(1, 1, 1, 1, 1) },
};
const FULL = P(1, 1, 1, 1, 1);

/** Crée (une seule fois par organisation) les blocs par défaut avec leurs droits de départ. Sûr si deux requêtes arrivent ensemble. */
async function ensureBlocks(orgId) {
  const have = Number((await db.prepare('SELECT COUNT(*) AS n FROM lib_blocks WHERE org_id = ?').get(orgId)).n);
  if (have > 0) return;
  await db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(?)').get(7270100000 + Number(orgId));
    if (Number((await db.prepare('SELECT COUNT(*) AS n FROM lib_blocks WHERE org_id = ?').get(orgId)).n) > 0) return;
    let pos = 0;
    for (const b of DEFAULT_BLOCKS) {
      const id = Number((await db.prepare('INSERT INTO lib_blocks (org_id, slug, name, color, icon, position, personal, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
        .run(orgId, b.slug, b.name, b.color, b.icon, pos += 10, b.kind === 'personal' ? 1 : 0, nowISO())).lastInsertRowid);
      if (b.kind !== 'personal') await seedPerms(orgId, id, b.kind);
    }
  })();
}
async function seedPerms(orgId, blockId, kind) {
  const d = ROLE_DEFAULTS[kind] || ROLE_DEFAULTS.general;
  for (const role of ['member', 'manager', 'admin']) {
    const p = d[role];
    await db.prepare('INSERT INTO lib_perms (org_id, block_id, subject, can_view, can_read, can_add, can_edit, can_delete) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (block_id, subject) DO NOTHING')
      .run(orgId, blockId, 'role:' + role, p.view, p.read, p.add, p.edit, p.delete);
  }
}

// ---------- Droits ----------
const fromRow = (r) => ({ view: Number(r.can_view) === 1, read: Number(r.can_read) === 1, add: Number(r.can_add) === 1, edit: Number(r.can_edit) === 1, delete: Number(r.can_delete) === 1 });
const norm = (p) => { const o = { view: !!p.view, read: !!p.read, add: !!p.add, edit: !!p.edit, delete: !!p.delete }; if (o.read || o.add || o.edit || o.delete) o.view = true; return o; };

/** Droits effectifs de la personne connectée sur un bloc : le propriétaire a tout ; sinon réunion des droits de son rôle et des siens. « Dossiers personnels » : privé. */
async function effectivePerms(req, block) {
  if (Number(block.personal) === 1) return { ...norm(FULL), personal: true };
  if (req.member.role === 'owner') return norm(FULL);
  const rows = await db.prepare('SELECT * FROM lib_perms WHERE block_id = ? AND subject IN (?, ?)').all(block.id, 'role:' + req.member.role, 'user:' + req.user.id);
  // Une exception personnelle remplace les droits du rôle (elle peut donner plus, ou retirer l'accès à une seule personne).
  const mine = rows.find((r) => r.subject === 'user:' + req.user.id);
  const row = mine || rows.find((r) => r.subject === 'role:' + req.member.role);
  return row ? norm(fromRow(row)) : norm({});
}

/** Bloc de l'organisation visible pour la personne (droit « voir » et non masqué), sinon 404 : un bloc non autorisé n'existe pas pour elle. */
async function blockFor(req, blockId) {
  const b = await db.prepare('SELECT * FROM lib_blocks WHERE id = ? AND org_id = ?').get(A.id(blockId, 'Bloc introuvable.'), req.org.id);
  if (!b) throw new HttpError(404, 'Bloc introuvable.');
  const perms = await effectivePerms(req, b);
  if (!perms.view || (Number(b.hidden) === 1 && !A.can(req, 'admin'))) throw new HttpError(404, 'Bloc introuvable.');
  return { block: b, perms };
}

// ---------- Réglages ----------
const SETTINGS_DEFAULT = { grantMinutes: 15, grantMaxMinutes: 120, maxFileMb: 0 };
async function settings(orgId) {
  const r = await db.prepare('SELECT * FROM lib_settings WHERE org_id = ?').get(orgId);
  return r ? { grantMinutes: Number(r.grant_minutes), grantMaxMinutes: Number(r.grant_max_minutes), maxFileMb: Number(r.max_file_mb) } : { ...SETTINGS_DEFAULT };
}

// ---------- Autorisations (déverrouillage) ----------
const passStamp = (user) => String(user.pass_changed_at || '');

/** Crée l'autorisation d'entrée dans un bloc pour cette session. Les anciennes autorisations de la même session sur ce bloc sont fermées. */
async function createGrant(req, block, st) {
  const now = Date.now();
  await db.prepare("UPDATE lib_grants SET revoked_at = ?, revoked_reason = 'renouvelée' WHERE user_id = ? AND session_id = ? AND block_id = ? AND revoked_at IS NULL").run(nowISO(), req.user.id, req.sessionId, block.id);
  const hard = now + st.grantMaxMinutes * 60000;
  const exp = Math.min(now + st.grantMinutes * 60000, hard);
  await db.prepare('INSERT INTO lib_grants (org_id, user_id, block_id, session_id, pass_stamp, created_at, last_used_at, expires_at, hard_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, req.user.id, block.id, req.sessionId, passStamp(req.user), nowISO(), nowISO(), new Date(exp).toISOString(), new Date(hard).toISOString());
  return new Date(exp).toISOString();
}
/** Autorisation valable (même personne, même session, même organisation, pas révoquée ni expirée, mot de passe inchangé) ou null. */
async function findGrant(req, blockId) {
  const g = await db.prepare('SELECT * FROM lib_grants WHERE org_id = ? AND user_id = ? AND session_id = ? AND block_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(req.org.id, req.user.id, req.sessionId || '', blockId);
  if (!g) return null;
  const now = Date.now();
  if (Date.parse(g.expires_at) <= now || Date.parse(g.hard_expires_at) <= now || g.pass_stamp !== passStamp(req.user)) return null;
  return g;
}
/** Exige l'autorisation ; chaque usage la renouvelle (durée courte), sans jamais dépasser le plafond. */
async function requireGrant(req, blockId) {
  const g = await findGrant(req, blockId);
  if (!g) throw new HttpError(403, 'Ce bloc est verrouillé : saisissez votre mot de passe pour y entrer.');
  const st = await settings(req.org.id);
  const exp = Math.min(Date.now() + st.grantMinutes * 60000, Date.parse(g.hard_expires_at));
  await db.prepare('UPDATE lib_grants SET last_used_at = ?, expires_at = ? WHERE id = ?').run(nowISO(), new Date(exp).toISOString(), g.id);
  g.expires_at = new Date(exp).toISOString();
  return g;
}
/** Blocs actuellement déverrouillés par cette session : { blockId: expiresAt }. */
async function openGrants(req) {
  const rows = await db.prepare('SELECT * FROM lib_grants WHERE org_id = ? AND user_id = ? AND session_id = ? AND revoked_at IS NULL AND expires_at > ? AND hard_expires_at > ?')
    .all(req.org.id, req.user.id, req.sessionId || '', nowISO(), nowISO());
  const out = {};
  for (const g of rows) if (g.pass_stamp === passStamp(req.user)) out[Number(g.block_id)] = g.expires_at;
  return out;
}
async function revokeGrants(where, args, reason) {
  return (await db.prepare(`UPDATE lib_grants SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL AND ${where}`).run(nowISO(), reason, ...args)).changes;
}

// ---------- Tentatives ----------
/** Le blocage en cours (en millisecondes restantes) pour cette personne sur ce bloc, ou 0. */
async function lockedFor(userId, blockId) {
  const rows = await db.prepare('SELECT locked_until FROM lib_attempts WHERE user_id = ? AND block_id IN (?, 0) AND locked_until IS NOT NULL').all(userId, blockId);
  let ms = 0;
  for (const r of rows) ms = Math.max(ms, Date.parse(r.locked_until) - Date.now());
  return ms > 0 ? ms : 0;
}
async function bump(userId, key, max) {
  const now = Date.now();
  const r = await db.prepare('SELECT * FROM lib_attempts WHERE user_id = ? AND block_id = ?').get(userId, key);
  let fails = 1; let start = new Date(now).toISOString();
  if (r && now - Date.parse(r.window_start) < FAIL_WINDOW_MS) { fails = Number(r.fails) + 1; start = r.window_start; }
  const locked = fails >= max ? new Date(now + LOCK_MS).toISOString() : null;
  await db.prepare('INSERT INTO lib_attempts (user_id, block_id, fails, window_start, locked_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, block_id) DO UPDATE SET fails = EXCLUDED.fails, window_start = EXCLUDED.window_start, locked_until = EXCLUDED.locked_until')
    .run(userId, key, locked ? 0 : fails, start, locked);
  return { fails, locked: !!locked };
}
/** Enregistre un échec. Renvoie { locked, left } (essais restants avant blocage sur ce bloc). */
async function recordFail(userId, blockId) {
  const a = await bump(userId, blockId, MAX_FAILS);
  const g = await bump(userId, 0, MAX_FAILS_ALL);
  return { locked: a.locked || g.locked, left: Math.max(MAX_FAILS - a.fails, 0) };
}
async function clearFails(userId, blockId) { await db.prepare('DELETE FROM lib_attempts WHERE user_id = ? AND block_id = ?').run(userId, blockId); }

// ---------- Journal ----------
const AUDIT_LABEL = {
  unlock_ok: 'Déverrouillage réussi', unlock_fail: 'Mot de passe incorrect', unlock_locked: 'Déverrouillage refusé (trop d’essais)', lock: 'Bloc refermé', open: 'Ouverture d’un bloc',
  view_doc: 'Consultation d’un document', preview: 'Aperçu d’un document', download: 'Téléchargement', add: 'Ajout d’un document', version: 'Nouvelle version', restore_version: 'Version rétablie',
  edit: 'Modification d’un document', delete: 'Document mis à la corbeille', restore: 'Document restauré', purge: 'Suppression définitive', folder_add: 'Dossier créé', folder_edit: 'Dossier renommé',
  folder_delete: 'Dossier supprimé', perms: 'Changement de droits', block_add: 'Bloc ajouté', block_edit: 'Bloc modifié', block_delete: 'Bloc supprimé', settings: 'Réglages modifiés', denied: 'Accès refusé',
  version_delete: 'Version supprimée', trash_auto: 'Corbeille vidée automatiquement',
};
async function logAudit(req, { blockId = null, docId = null, action, detail = '' }) {
  try {
    await db.prepare('INSERT INTO lib_audit (org_id, user_id, block_id, doc_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, req.user ? req.user.id : null, blockId, docId, action, oneLine(detail, 300), String(req.ip || '').slice(0, 64), nowISO());
  } catch (e) { log.warn('Journal de la bibliothèque :', oneLine(e.message, 120)); }
}

// ---------- Fichiers : reconnaissance d'après le contenu ----------
const has = (b, s) => b.indexOf(s) !== -1;
/** Renvoie { mime, exts, family } d'après le CONTENU du fichier, ou null s'il n'est pas reconnu. L'extension annoncée n'est qu'une indication à comparer. */
function sniff(b) {
  if (!b || b.length < 8) return null;
  const asc = (o, n) => b.toString('latin1', o, o + n);
  if (asc(0, 5) === '%PDF-') return { mime: 'application/pdf', exts: ['pdf'], family: 'pdf' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', exts: ['jpg', 'jpeg'], family: 'image' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', exts: ['png'], family: 'image' };
  if (asc(0, 4) === 'RIFF' && asc(8, 4) === 'WEBP') return { mime: 'image/webp', exts: ['webp'], family: 'image' };
  if (asc(0, 6) === 'GIF87a' || asc(0, 6) === 'GIF89a') return { mime: 'image/gif', exts: ['gif'], family: 'image' };
  if (asc(0, 4) === 'RIFF' && asc(8, 4) === 'WAVE') return { mime: 'audio/wav', exts: ['wav'], family: 'media' };
  if (asc(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', exts: ['mp3'], family: 'media' };
  if (asc(4, 4) === 'ftyp') return { mime: 'video/mp4', exts: ['mp4', 'm4a', 'm4v', 'mov'], family: 'media' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', exts: ['webm', 'mkv'], family: 'media' };
  if (asc(0, 4) === 'OggS') return { mime: 'audio/ogg', exts: ['ogg', 'oga'], family: 'media' };
  if (asc(0, 4) === 'PK\u0003\u0004') { // ZIP : documents Office et OpenDocument reconnus d'après leurs parties internes ; un ZIP quelconque est refusé
    if (has(b, '[Content_Types].xml') && has(b, 'word/')) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: ['docx'], family: 'office' };
    if (has(b, '[Content_Types].xml') && has(b, 'xl/')) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', exts: ['xlsx'], family: 'office' };
    if (has(b, '[Content_Types].xml') && has(b, 'ppt/')) return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', exts: ['pptx'], family: 'office' };
    if (b.toString('latin1', 30, 38) === 'mimetype') {
      const m = b.toString('latin1', 38, 100);
      if (m.startsWith('application/vnd.oasis.opendocument.text')) return { mime: 'application/vnd.oasis.opendocument.text', exts: ['odt'], family: 'office' };
      if (m.startsWith('application/vnd.oasis.opendocument.spreadsheet')) return { mime: 'application/vnd.oasis.opendocument.spreadsheet', exts: ['ods'], family: 'office' };
      if (m.startsWith('application/vnd.oasis.opendocument.presentation')) return { mime: 'application/vnd.oasis.opendocument.presentation', exts: ['odp'], family: 'office' };
    }
    return null;
  }
  if (b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return { mime: 'application/x-ole-storage', exts: ['doc', 'xls', 'ppt'], family: 'office', ole: true };
  // Texte : UTF-8 valide, sans octet nul, ne ressemblant pas à une page web ou à un programme.
  if (b.length <= 5 * 1024 * 1024 && !b.includes(0)) {
    let t = null;
    try { t = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { t = null; }
    if (t !== null) {
      const head = t.slice(0, 2000).toLowerCase().trimStart();
      if (/^(<!doctype|<html|<\?xml|<svg|<script|<\?php|#!)/.test(head) || /<script[\s>]/.test(head)) return null;
      return { mime: 'text/plain', exts: ['txt', 'csv', 'tsv', 'md', 'json', 'log'], family: 'text' };
    }
  }
  return null;
}
const OLE_MIME = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' };
const DANGEROUS = /^(exe|dll|bat|cmd|com|scr|js|mjs|vbs|ps1|sh|jar|msi|html|htm|svg|php|py|app|apk|dmg|lnk|hta|wsf)$/i;

/** Nom de fichier sûr : jamais de chemin, pas de caractère de contrôle ni de séparateur ; l'extension finale est fixée d'après le contenu. */
function cleanName(raw, fallback = 'document') {
  let n = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '');
  n = n.split(/[\\/]/).pop().trim();
  n = n.replace(/[:*?"<>|]/g, '_').replace(/^\.+/, '').slice(0, 120).trim();
  return n || fallback;
}
/** Valide un envoi : renvoie { name, mime } ou lève une erreur claire. */
function checkUpload(buf, rawName) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, 'Aucun fichier reçu.');
  const name0 = cleanName(rawName);
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name0);
  const ext = m ? m[1].toLowerCase() : '';
  const base = m ? name0.slice(0, -m[0].length) : name0;
  if (ext && DANGEROUS.test(ext)) throw new HttpError(400, `Les fichiers « .${ext} » ne sont pas acceptés dans la bibliothèque.`);
  const t = sniff(buf);
  if (!t) throw new HttpError(400, 'Fichier non reconnu : formats acceptés : PDF, images, documents Office ou OpenDocument, texte, audio et vidéo courants.');
  if (ext && !t.exts.includes(ext)) throw new HttpError(400, `Le contenu du fichier ne correspond pas à son extension « .${ext} » : envoi refusé.`);
  if (t.ole && !ext) throw new HttpError(400, 'Ancien format Office : donnez au fichier son extension (.doc, .xls ou .ppt).');
  const finalExt = ext || t.exts[0];
  return { name: `${base || 'document'}.${finalExt}`.slice(0, 130), mime: t.ole ? OLE_MIME[finalExt] : t.mime, family: t.family };
}
const PREVIEWABLE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// ---------- Quotas ----------
const QUOTA_MB = { Gratuit: 50, Pro: 500, 'Pro Max': 2000, 'Méga Pro': 5000, 'Illimité': 20000 };
const FILE_MB = { Gratuit: 5, Pro: 15, 'Pro Max': 20, 'Méga Pro': 20, 'Illimité': 20 };
const HARD_FILE_MB = 20;
async function limitsOf(org) {
  const plan = await A.ownerPlan(org);
  const st = await settings(org.id);
  const fileMb = Math.min(FILE_MB[plan] || FILE_MB.Gratuit, st.maxFileMb > 0 ? st.maxFileMb : HARD_FILE_MB, HARD_FILE_MB);
  const quotaBytes = (QUOTA_MB[plan] || QUOTA_MB.Gratuit) * 1024 * 1024;
  const used = Number((await db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM lib_versions WHERE org_id = ?').get(org.id)).s);
  return { plan, maxFileBytes: fileMb * 1024 * 1024, quotaBytes, used };
}

// ---------- Étiquettes ----------
/** « facture, 2026 » ou ['facture'] → '|facture|2026|' (10 étiquettes de 30 caractères au plus). */
function tagsIn(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = [];
  for (const x of list) {
    const t = String(x == null ? '' : x).replace(/[|\u0000-\u001f]/g, ' ').trim().toLowerCase().slice(0, 30);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 10) break;
  }
  return out.length ? '|' + out.join('|') + '|' : '';
}
const tagsOut = (s) => String(s || '').split('|').filter(Boolean);
const likeEsc = (q) => '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';

// ---------- Corbeille ----------
/** Supprime définitivement ce qui est à la corbeille depuis plus de 30 jours (une organisation, ou toutes si orgId est omis). */
async function purgeTrash(orgId) {
  const cut = ago(TRASH_DAYS * 86400000);
  const rows = orgId
    ? await db.prepare('SELECT id, org_id, block_id FROM lib_docs WHERE org_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?').all(orgId, cut)
    : await db.prepare('SELECT id, org_id, block_id FROM lib_docs WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cut);
  for (const d of rows) {
    await db.prepare('DELETE FROM lib_docs WHERE id = ?').run(d.id);
    await db.prepare('INSERT INTO lib_audit (org_id, user_id, block_id, doc_id, action, detail, ip, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)')
      .run(d.org_id, d.block_id, d.id, 'trash_auto', 'Plus de 30 jours à la corbeille', '', nowISO());
  }
  return rows.length;
}
/** Nettoyage périodique (tâches automatiques) : corbeille, autorisations périmées, compteurs d'essais anciens. */
async function sweep() {
  const n = await purgeTrash();
  await db.prepare('DELETE FROM lib_grants WHERE hard_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(ago(86400000), ago(86400000));
  await db.prepare('DELETE FROM lib_attempts WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)').run(ago(86400000), nowISO());
  return n;
}

module.exports = {
  MAX_FAILS, MAX_FAILS_ALL, FAIL_WINDOW_MS, LOCK_MS, TRASH_DAYS, MAX_VERSIONS, MAX_FOLDER_DEPTH, PERMS, DEFAULT_BLOCKS, ICONS, AUDIT_LABEL, PREVIEWABLE,
  ensureBlocks, seedPerms, effectivePerms, blockFor, norm, fromRow, settings, SETTINGS_DEFAULT,
  createGrant, findGrant, requireGrant, openGrants, revokeGrants, lockedFor, recordFail, clearFails, logAudit,
  sniff, cleanName, checkUpload, limitsOf, tagsIn, tagsOut, likeEsc, purgeTrash, sweep,
};
