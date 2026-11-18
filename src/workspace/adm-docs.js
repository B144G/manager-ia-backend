'use strict';
// Administration · 3. Gestion documentaire (GED) et archives : plan de classement, métadonnées, versions chiffrées, droits par rôle et confidentialité,
// recherche plein texte (nom, métadonnées, contenu des fichiers texte et PDF), verrouillage / prêt, durées de conservation réglables par type,
// archivage scellé (empreinte SHA-256), destruction validée par une seconde personne, corbeille, journal d'accès.
// Cette GED est distincte de la Bibliothèque protégée (blocs à mot de passe) : elle ne la modifie pas.
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./adm-lib');
const T = require('./adm-templates');
const X = require('./legal-extra');
const limits = require('../middleware/limits');
const { HttpError, cleanText } = require('../util');

const router = express.Router({ mergeParams: true });
const manage = L.needPerm('docs_manage');
const destroyPerm = L.needPerm('docs_destroy');

const MAX_FILE = 8 * 1024 * 1024; const MAX_ORG = 150 * 1024 * 1024; const MAX_VERSIONS = 30; const TRASH_DAYS = 30;
const CONF = ['public', 'internal', 'restricted', 'secret']; // public et interne : tous les membres ; restreint : responsables et personnes désignées ; secret : administrateurs et personnes désignées
const CONF_RANK = { public: 0, internal: 1, restricted: 2, secret: 3 };
const likeEsc = (q) => '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
const upLimit = limits.make(10 * 60 * 1000, 60, "Trop d'envois de fichiers. Réessayez dans quelques minutes.");

// ---------- Fichiers : type d'après le CONTENU, texte extractible ----------
function detect(buf, name) {
  const t = X.sniff(buf);
  if (t) return t;
  const ext = (String(name).match(/\.([A-Za-z0-9]{1,5})$/) || [])[1];
  const e = ext ? ext.toLowerCase() : '';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && ['docx', 'xlsx', 'pptx'].includes(e)) {
    return { mime: { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }[e], ext: e };
  }
  if (['txt', 'md', 'csv', 'json'].includes(e) && !buf.subarray(0, 4096).includes(0) && buf.length > 0) return { mime: { txt: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json' }[e], ext: e };
  return null;
}
function pdfText(buf) {
  const s = buf.toString('latin1'); const parts = [];
  const unesc = (x) => x.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => (/^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8)) : { n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c]));
  const hex = (h) => { const c = h.replace(/\s/g, ''); let o = ''; for (let i = 0; i + 1 < c.length; i += 2) o += String.fromCharCode(parseInt(c.slice(i, i + 2), 16)); return o; };
  const tok = /\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]+)>/g;
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g; let m;
  while ((m = re.exec(s)) && parts.join('').length < 300000) {
    let txt = m[1];
    try { txt = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { /* flux non compressé */ }
    const re2 = /(\[(?:\\.|[^\]])*\]|\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>)\s*T[jJ]/g; let k;
    while ((k = re2.exec(txt))) {
      let q; tok.lastIndex = 0;
      while ((q = tok.exec(k[1]))) parts.push(q[1] !== undefined ? unesc(q[1]) : hex(q[2]));
      parts.push(' ');
    }
  }
  return parts.join('');
}
function extractText(buf, mime) {
  try {
    if (mime === 'application/pdf') return pdfText(buf).replace(/\s+/g, ' ').trim().slice(0, 200000);
    if (/^text\//.test(mime) || mime === 'application/json') return buf.toString('utf8').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, 200000);
  } catch { /* texte non extractible : la recherche reste possible par nom et métadonnées */ }
  return '';
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- Droits de lecture ----------
/** Le membre peut-il lire ce document ? (confidentialité + désignations par rôle ou personne + créateur + gestionnaires) */
function visible(req, cfg, d) {
  if (req.member.role === 'owner') return true;
  const allowedRoles = L.jparse(d.allowed_roles, []); const allowedUsers = L.jparse(d.allowed_users, []);
  if (Number(d.created_by) === req.user.id || allowedUsers.includes(req.user.id) || allowedRoles.includes(req.member.role)) return true;
  if (L.allowed(req, cfg, 'docs_manage') && d.confidentiality !== 'secret') return true;
  switch (d.confidentiality) {
    case 'public': case 'internal': return true;
    case 'restricted': return A.can(req, 'manager');
    default: return A.can(req, 'admin');
  }
}
const editable = (req, cfg, d) => Number(d.created_by) === req.user.id || L.allowed(req, cfg, 'docs_manage');

async function logDoc(req, docId, action, detail = '') {
  await db.prepare('INSERT INTO adm_doc_log (org_id, doc_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, docId, req.user ? req.user.id : null, action, String(detail).slice(0, 300), nowISO());
}

// ---------- Durées de conservation ----------
function dueDates(type, d) {
  const ref = (type && type.basis === 'created' ? String(d.created_at).slice(0, 10) : d.doc_date || String(d.created_at).slice(0, 10));
  if (!type) return { archiveDue: null, destroyDue: null };
  const active = Number(type.active_years); const keep = Number(type.retention_years);
  return { archiveDue: L.addYears(ref, active), destroyDue: keep > 0 ? L.addYears(ref, keep) : null }; // 0 = conservation permanente
}
async function applyRetention(orgId, docId) {
  const d = await db.prepare('SELECT * FROM adm_docs WHERE id = ? AND org_id = ?').get(docId, orgId);
  if (!d || d.status === 'destroyed') return;
  const type = d.type_id ? await db.prepare('SELECT * FROM adm_doc_types WHERE id = ? AND org_id = ?').get(d.type_id, orgId) : null;
  const due = dueDates(type, d);
  await db.prepare('UPDATE adm_docs SET archive_due = ?, destroy_due = ? WHERE id = ?').run(d.status === 'archived' ? d.archive_due : due.archiveDue, due.destroyDue, d.id);
}

function docView(d, names, extra = {}) {
  const today = L.today();
  const o = {
    id: Number(d.id), code: d.code, title: d.title, planId: d.plan_id == null ? null : Number(d.plan_id), typeId: d.type_id == null ? null : Number(d.type_id), confidentiality: d.confidentiality,
    allowedRoles: L.jparse(d.allowed_roles, []), allowedUsers: L.jparse(d.allowed_users, []), description: d.description, tags: L.jparse(d.tags, []), author: d.author, docDate: d.doc_date, version: Number(d.version),
    fileName: d.file_name, mime: d.mime, size: Number(d.size), status: d.status, hasFile: Number(d.version) > 0 && d.status !== 'destroyed',
    lock: d.lock_user_id ? { userId: Number(d.lock_user_id), user: names.get(Number(d.lock_user_id)) || null, kind: d.lock_kind, since: d.lock_at, due: d.lock_due, note: d.lock_note, overdue: Boolean(d.lock_due && d.lock_due < today) } : null,
    archiveDue: d.archive_due, destroyDue: d.destroy_due, archivedAt: d.archived_at, sealed: Boolean(d.seal_hash), sealHash: d.seal_hash, destroyState: d.destroy_state, destroyedAt: d.destroyed_at,
    deletedAt: d.deleted_at, createdBy: d.created_by == null ? null : Number(d.created_by), creator: names.get(Number(d.created_by)) || null, createdAt: d.created_at, updatedAt: d.updated_at,
    archiveOverdue: Boolean(d.status === 'active' && d.archive_due && d.archive_due <= today), destroyOverdue: Boolean(d.status !== 'destroyed' && d.destroy_due && d.destroy_due <= today),
  };
  return { ...o, ...extra };
}

// ---------- Plan de classement ----------
router.get('/plan', async (req, res) => res.json({ plan: (await db.prepare('SELECT id, parent_id AS "parentId", code, name FROM adm_plan WHERE org_id = ? ORDER BY code, name').all(req.org.id)).map((p) => ({ ...p, id: Number(p.id), parentId: p.parentId == null ? null : Number(p.parentId) })) }));
async function planParent(req, v, selfId) {
  const pid = A.idOrNull(v, 'Rubrique parente invalide.');
  if (pid === null) return null;
  if (!await db.prepare('SELECT 1 FROM adm_plan WHERE id = ? AND org_id = ?').get(pid, req.org.id)) throw new HttpError(400, 'Rubrique parente inconnue.');
  for (let cur = pid, n = 0; cur && n < 30; n++) { if (cur === selfId) throw new HttpError(400, 'Une rubrique ne peut pas se contenir elle-même.'); cur = Number((await db.prepare('SELECT parent_id FROM adm_plan WHERE id = ?').get(cur) || {}).parent_id) || null; }
  return pid;
}
router.post('/plan', manage, async (req, res) => {
  const b = req.body || {};
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_plan WHERE org_id = ?').get(req.org.id)).c >= 400) throw new HttpError(403, 'Limite de 400 rubriques atteinte.');
  const id = (await db.prepare('INSERT INTO adm_plan (org_id, parent_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, await planParent(req, b.parentId, null), A.text(b.code, 30), A.text(b.name, 120, { required: true, msg: 'Indiquez le nom de la rubrique.' }), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/plan/:id', manage, async (req, res) => {
  const p = await db.prepare('SELECT * FROM adm_plan WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Rubrique introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE adm_plan SET parent_id = ?, code = ?, name = ? WHERE id = ?').run(b.parentId === undefined ? p.parent_id : await planParent(req, b.parentId, p.id), b.code === undefined ? p.code : A.text(b.code, 30), b.name === undefined ? p.name : A.text(b.name, 120, { required: true, msg: 'Le nom ne peut pas être vide.' }), p.id);
  res.json({ ok: true });
});
router.delete('/plan/:id', manage, async (req, res) => {
  const id = A.id(req.params.id);
  await db.transaction(async () => {
    await db.prepare('UPDATE adm_plan SET parent_id = NULL WHERE org_id = ? AND parent_id = ?').run(req.org.id, id);
    await db.prepare('UPDATE adm_docs SET plan_id = NULL WHERE org_id = ? AND plan_id = ?').run(req.org.id, id);
    const r = await db.prepare('DELETE FROM adm_plan WHERE id = ? AND org_id = ?').run(id, req.org.id);
    if (!r.changes) throw new HttpError(404, 'Rubrique introuvable.');
  })();
  res.json({ ok: true });
});

// ---------- Types de documents et règles de conservation (réglables) ----------
const typeView = (t) => ({ id: Number(t.id), name: t.name, activeYears: Number(t.active_years), retentionYears: Number(t.retention_years), basis: t.basis, endAction: t.end_action, note: t.note });
router.get('/types', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM adm_doc_types WHERE org_id = ? ORDER BY name').all(req.org.id);
  const counts = Object.fromEntries((await db.prepare("SELECT type_id, COUNT(*) c FROM adm_docs WHERE org_id = ? AND status <> 'destroyed' GROUP BY type_id").all(req.org.id)).map((r) => [r.type_id, Number(r.c)]));
  res.json({ types: rows.map((t) => ({ ...typeView(t), documents: counts[t.id] || 0 })), suggestions: T.RETENTION_DEFAULTS });
});
function typeBody(b, base = {}) {
  const yrs = (v, def) => { if (v === undefined || v === '') return def; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, 'Durée invalide : entre 0 et 100 ans (0 = conservation permanente pour la durée totale).'); return n; };
  const active = yrs(b.activeYears, base.activeYears ?? 1); const keep = yrs(b.retentionYears, base.retentionYears ?? 5);
  if (keep > 0 && keep < active) throw new HttpError(400, 'La durée totale de conservation ne peut pas être plus courte que la durée en archivage courant.');
  return { name: b.name === undefined ? base.name : A.text(b.name, 120, { required: true, msg: 'Indiquez le nom du type.' }), activeYears: active, retentionYears: keep, basis: A.oneOf(b.basis, ['doc_date', 'created'], base.basis || 'doc_date', 'Base de calcul inconnue.'), endAction: A.oneOf(b.endAction, ['destroy', 'review', 'keep'], base.endAction || 'review', 'Action de fin inconnue.'), note: b.note === undefined ? base.note || '' : A.text(b.note, 400) };
}
router.post('/types', manage, async (req, res) => {
  const t = typeBody(req.body || {});
  if (!t.name) throw new HttpError(400, 'Indiquez le nom du type.');
  const id = (await db.prepare('INSERT INTO adm_doc_types (org_id, name, active_years, retention_years, basis, end_action, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, t.name, t.activeYears, t.retentionYears, t.basis, t.endAction, t.note, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.post('/types/seed', manage, async (req, res) => {
  const have = new Set((await db.prepare('SELECT name FROM adm_doc_types WHERE org_id = ?').all(req.org.id)).map((r) => r.name));
  let n = 0;
  for (const s of T.RETENTION_DEFAULTS) if (!have.has(s.name)) { await db.prepare('INSERT INTO adm_doc_types (org_id, name, active_years, retention_years, basis, end_action, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, s.name, s.activeYears, s.retentionYears, s.basis, s.endAction, s.note, nowISO()); n++; }
  res.json({ ok: true, added: n });
});
router.put('/types/:id', manage, async (req, res) => {
  const t = await db.prepare('SELECT * FROM adm_doc_types WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!t) throw new HttpError(404, 'Type introuvable.');
  const nt = typeBody(req.body || {}, typeView(t));
  await db.prepare('UPDATE adm_doc_types SET name = ?, active_years = ?, retention_years = ?, basis = ?, end_action = ?, note = ? WHERE id = ?').run(nt.name, nt.activeYears, nt.retentionYears, nt.basis, nt.endAction, nt.note, t.id);
  const docs = await db.prepare("SELECT id FROM adm_docs WHERE org_id = ? AND type_id = ? AND status <> 'destroyed'").all(req.org.id, t.id);
  for (const d of docs) await applyRetention(req.org.id, d.id); // la règle est réglable : les échéances suivent
  await W.audit(req, 'adm_doc_type', t.id, 'update', typeView(t), nt);
  res.json({ ok: true, recalculated: docs.length });
});
router.delete('/types/:id', manage, async (req, res) => {
  const id = A.id(req.params.id);
  await db.prepare('UPDATE adm_docs SET type_id = NULL, archive_due = NULL, destroy_due = NULL WHERE org_id = ? AND type_id = ? AND status NOT IN (\'destroyed\')').run(req.org.id, id);
  const r = await db.prepare('DELETE FROM adm_doc_types WHERE id = ? AND org_id = ?').run(id, req.org.id);
  if (!r.changes) throw new HttpError(404, 'Type introuvable.');
  res.json({ ok: true });
});

// ---------- Liste et recherche ----------
async function refs(req, b) {
  const plan = A.idOrNull(b.planId, 'Rubrique invalide.'); const type = A.idOrNull(b.typeId, 'Type invalide.');
  if (plan && !await db.prepare('SELECT 1 FROM adm_plan WHERE id = ? AND org_id = ?').get(plan, req.org.id)) throw new HttpError(400, 'Rubrique inconnue.');
  if (type && !await db.prepare('SELECT 1 FROM adm_doc_types WHERE id = ? AND org_id = ?').get(type, req.org.id)) throw new HttpError(400, 'Type inconnu.');
  return { plan, type };
}
router.get('/', async (req, res) => {
  const cfg = req.admCfg = await L.getConfig(req.org.id);
  const names = await L.nameMap(req.org.id);
  const q = String(req.query.q || '').trim().slice(0, 100);
  const where = ['org_id = ?']; const args = [req.org.id];
  const status = String(req.query.status || 'live');
  if (status === 'trash') where.push('deleted_at IS NOT NULL'); else { where.push('deleted_at IS NULL'); if (['active', 'archived', 'destroyed'].includes(status)) { where.push('status = ?'); args.push(status); } }
  if (req.query.planId) { where.push('plan_id = ?'); args.push(A.id(req.query.planId)); }
  if (req.query.typeId) { where.push('type_id = ?'); args.push(A.id(req.query.typeId)); }
  if (req.query.confidentiality && CONF.includes(req.query.confidentiality)) { where.push('confidentiality = ?'); args.push(req.query.confidentiality); }
  if (q) {
    const like = likeEsc(q.toLowerCase());
    where.push("(lower(title) LIKE ? OR lower(code) LIKE ? OR lower(description) LIKE ? OR lower(tags) LIKE ? OR lower(author) LIKE ? OR lower(file_name) LIKE ? OR lower(text_content) LIKE ?)");
    args.push(like, like, like, like, like, like, like);
  }
  const rows = await db.prepare(`SELECT * FROM adm_docs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 400`).all(...args);
  const docs = [];
  for (const d of rows) {
    if (!visible(req, cfg, d)) continue;
    let snippet = '';
    if (q) {
      const t = d.text_content || ''; const i = t.toLowerCase().indexOf(q.toLowerCase());
      if (i >= 0) snippet = (i > 50 ? '…' : '') + t.slice(Math.max(0, i - 50), i + q.length + 90) + '…';
    }
    docs.push(docView(d, names, snippet ? { snippet } : {}));
  }
  res.json({ docs, perms: { manage: L.allowed(req, cfg, 'docs_manage'), destroy: L.allowed(req, cfg, 'docs_destroy') } });
});

router.get('/stats', async (req, res) => {
  const cfg = await L.getConfig(req.org.id);
  const rows = (await db.prepare('SELECT * FROM adm_docs WHERE org_id = ? AND deleted_at IS NULL').all(req.org.id)).filter((d) => visible(req, cfg, d));
  const types = new Map((await db.prepare('SELECT id, name FROM adm_doc_types WHERE org_id = ?').all(req.org.id)).map((t) => [Number(t.id), t.name]));
  const by = (f) => { const m = {}; for (const d of rows) { const k = f(d); m[k] = (m[k] || 0) + 1; } return Object.entries(m).map(([key, count]) => ({ key, count })); };
  const today = L.today();
  res.json({
    total: rows.length, byStatus: by((d) => d.status), byConfidentiality: by((d) => d.confidentiality), byType: by((d) => types.get(Number(d.type_id)) || 'Sans type'),
    bytes: rows.reduce((s, d) => s + Number(d.size), 0), quotaBytes: MAX_ORG, locked: rows.filter((d) => d.lock_user_id).length,
    toArchive: rows.filter((d) => d.status === 'active' && d.archive_due && d.archive_due <= today).length,
    toDestroy: rows.filter((d) => d.status !== 'destroyed' && d.destroy_due && d.destroy_due <= today).length,
    awaitingDestruction: rows.filter((d) => d.destroy_state === 'requested').length,
  });
});

/** Échéances d'archivage et de destruction (avec le délai d'alerte réglé). */
async function dueLists(req, cfg) {
  const names = await L.nameMap(req.org.id);
  const lim = L.addDays(L.today(), cfg.docAlertDays);
  const rows = (await db.prepare("SELECT * FROM adm_docs WHERE org_id = ? AND deleted_at IS NULL AND status <> 'destroyed'").all(req.org.id)).filter((d) => visible(req, cfg, d));
  const types = new Map((await db.prepare('SELECT * FROM adm_doc_types WHERE org_id = ?').all(req.org.id)).map((t) => [Number(t.id), t]));
  const v = (d) => docView(d, names, { typeName: (types.get(Number(d.type_id)) || {}).name || null, endAction: (types.get(Number(d.type_id)) || {}).end_action || null });
  return {
    toArchive: rows.filter((d) => d.status === 'active' && d.archive_due && d.archive_due <= lim).map(v),
    toDestroy: rows.filter((d) => d.destroy_due && d.destroy_due <= lim && d.destroy_state !== 'requested' && (types.get(Number(d.type_id)) || {}).end_action !== 'keep').map(v),
    awaiting: rows.filter((d) => d.destroy_state === 'requested').map(v),
  };
}
router.get('/due', async (req, res) => { const cfg = req.admCfg = await L.getConfig(req.org.id); res.json(await dueLists(req, cfg)); });

router.get('/log', manage, async (req, res) => {
  const names = await L.nameMap(req.org.id);
  const where = ['l.org_id = ?']; const args = [req.org.id];
  if (req.query.docId) { where.push('l.doc_id = ?'); args.push(A.id(req.query.docId)); }
  const rows = await db.prepare(`SELECT l.*, d.title FROM adm_doc_log l LEFT JOIN adm_docs d ON d.id = l.doc_id WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT 300`).all(...args);
  res.json({ log: rows.map((r) => ({ id: Number(r.id), docId: r.doc_id == null ? null : Number(r.doc_id), title: r.title, user: names.get(Number(r.user_id)) || null, action: r.action, detail: r.detail, at: r.created_at })) });
});

// ---------- Création, détail, modification ----------
function metaFrom(b, base = {}) {
  const roles = b.allowedRoles === undefined ? base.allowedRoles : [...new Set((Array.isArray(b.allowedRoles) ? b.allowedRoles : []).filter((r) => A.ROLES.includes(r)))];
  const users = b.allowedUsers === undefined ? base.allowedUsers : [...new Set((Array.isArray(b.allowedUsers) ? b.allowedUsers : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100);
  return {
    title: b.title === undefined ? base.title : A.text(b.title, 200, { required: true, msg: 'Indiquez le titre du document.' }), code: b.code === undefined ? base.code : A.text(b.code, 60),
    confidentiality: A.oneOf(b.confidentiality, CONF, base.confidentiality || 'internal', 'Niveau de confidentialité inconnu.'), description: b.description === undefined ? base.description : A.text(b.description, 2000),
    tags: b.tags === undefined ? base.tags : L.strList(b.tags, 20, 40), author: b.author === undefined ? base.author : A.text(b.author, 120), docDate: b.docDate === undefined ? base.docDate : A.date(b.docDate),
    allowedRoles: roles || [], allowedUsers: users || [],
  };
}
router.post('/', async (req, res) => {
  const b = req.body || {};
  if ((await db.prepare("SELECT COUNT(*) c FROM adm_docs WHERE org_id = ? AND status <> 'destroyed'").get(req.org.id)).c >= 20000) throw new HttpError(403, 'Limite de 20 000 documents atteinte.');
  const m = metaFrom(b, { tags: [], allowedRoles: [], allowedUsers: [], description: '', author: '', code: '', docDate: null });
  if (!m.title) throw new HttpError(400, 'Indiquez le titre du document.');
  for (const u of m.allowedUsers) await A.memberOf(req, u);
  const { plan, type } = await refs(req, b);
  const now = nowISO();
  const id = Number((await db.prepare(`INSERT INTO adm_docs (org_id, code, title, plan_id, type_id, confidentiality, allowed_roles, allowed_users, description, tags, author, doc_date, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(req.org.id, m.code, m.title, plan, type, m.confidentiality, JSON.stringify(m.allowedRoles), JSON.stringify(m.allowedUsers), m.description, JSON.stringify(m.tags), m.author, m.docDate, req.user.id, now, now)).lastInsertRowid);
  await applyRetention(req.org.id, id);
  await logDoc(req, id, 'create', m.title);
  res.status(201).json({ id });
});

async function loadDoc(req, { allowTrash = false } = {}) {
  const d = await db.prepare('SELECT * FROM adm_docs WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  req.admCfg = req.admCfg || await L.getConfig(req.org.id);
  if (!d || !visible(req, req.admCfg, d) || (d.deleted_at && !allowTrash)) throw new HttpError(404, 'Document introuvable.');
  return d;
}
router.get('/:id', async (req, res) => {
  const d = await loadDoc(req, { allowTrash: true });
  const names = await L.nameMap(req.org.id);
  const versions = await db.prepare('SELECT n, name, mime, size, sha256, note, created_by, created_at, (data IS NOT NULL) AS has_data FROM adm_doc_versions WHERE doc_id = ? ORDER BY n DESC').all(d.id);
  const type = d.type_id ? await db.prepare('SELECT * FROM adm_doc_types WHERE id = ?').get(d.type_id) : null;
  const log = L.allowed(req, req.admCfg, 'docs_manage') || Number(d.created_by) === req.user.id
    ? (await db.prepare('SELECT user_id, action, detail, created_at FROM adm_doc_log WHERE doc_id = ? ORDER BY id DESC LIMIT 50').all(d.id)).map((r) => ({ user: names.get(Number(r.user_id)) || null, action: r.action, detail: r.detail, at: r.created_at })) : [];
  await logDoc(req, d.id, 'open');
  res.json({ doc: docView(d, names, { type: type ? typeView(type) : null, canEdit: editable(req, req.admCfg, d) && d.status !== 'archived' }), versions: versions.map((v) => ({ n: Number(v.n), name: v.name, mime: v.mime, size: Number(v.size), sha256: v.sha256, note: v.note, by: names.get(Number(v.created_by)) || null, at: v.created_at, hasData: Boolean(v.has_data) })), log });
});
router.put('/:id', async (req, res) => {
  const d = await loadDoc(req);
  if (!editable(req, req.admCfg, d)) throw new HttpError(403, "Seul l'auteur ou une personne désignée peut modifier ce document.");
  if (d.status !== 'active') throw new HttpError(409, 'Un document archivé est scellé : il ne se modifie plus.');
  if (d.lock_user_id && Number(d.lock_user_id) !== req.user.id) throw new HttpError(423, 'Document verrouillé par une autre personne.');
  const b = req.body || {};
  const m = metaFrom(b, { title: d.title, code: d.code, confidentiality: d.confidentiality, description: d.description, tags: L.jparse(d.tags, []), author: d.author, docDate: d.doc_date, allowedRoles: L.jparse(d.allowed_roles, []), allowedUsers: L.jparse(d.allowed_users, []) });
  if (CONF_RANK[m.confidentiality] < CONF_RANK[d.confidentiality] && !L.allowed(req, req.admCfg, 'docs_manage')) throw new HttpError(403, "Seul un gestionnaire des documents peut baisser le niveau de confidentialité.");
  for (const u of m.allowedUsers) await A.memberOf(req, u);
  const plan = b.planId === undefined ? d.plan_id : (await refs(req, { planId: b.planId })).plan;
  const type = b.typeId === undefined ? d.type_id : (await refs(req, { typeId: b.typeId })).type;
  await db.prepare('UPDATE adm_docs SET title = ?, code = ?, plan_id = ?, type_id = ?, confidentiality = ?, allowed_roles = ?, allowed_users = ?, description = ?, tags = ?, author = ?, doc_date = ?, updated_at = ? WHERE id = ?')
    .run(m.title, m.code, plan, type, m.confidentiality, JSON.stringify(m.allowedRoles), JSON.stringify(m.allowedUsers), m.description, JSON.stringify(m.tags), m.author, m.docDate, nowISO(), d.id);
  await applyRetention(req.org.id, d.id);
  await logDoc(req, d.id, 'edit', 'Métadonnées modifiées');
  res.json({ ok: true });
});

// ---------- Fichier et versions ----------
router.post('/:id/file', upLimit, express.raw({ type: () => true, limit: MAX_FILE + 1024 }), async (req, res) => {
  const d = await loadDoc(req);
  if (!editable(req, req.admCfg, d)) throw new HttpError(403, "Seul l'auteur ou une personne désignée peut ajouter une version.");
  if (d.status !== 'active') throw new HttpError(409, 'Un document archivé est scellé : aucune nouvelle version.');
  if (d.lock_user_id && Number(d.lock_user_id) !== req.user.id) throw new HttpError(423, 'Document verrouillé par une autre personne : attendez qu’elle le libère.');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw new HttpError(400, 'Fichier vide.');
  if (buf.length > MAX_FILE) throw new HttpError(413, 'Fichier trop lourd (8 Mo au plus).');
  const base = cleanText(String(req.query.name || ''), 120).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'document';
  const t = detect(buf, base);
  if (!t) throw new HttpError(400, 'Fichier non reconnu : PDF, image (JPEG, PNG, WebP), Word, Excel, PowerPoint, texte, CSV ou JSON.');
  const used = Number((await db.prepare('SELECT COALESCE(SUM(size), 0) s FROM adm_doc_versions WHERE org_id = ?').get(req.org.id)).s);
  if (used + buf.length > MAX_ORG) throw new HttpError(403, 'Espace de documents plein (150 Mo). Détruisez d’anciens documents.');
  if (Number((await db.prepare('SELECT COUNT(*) c FROM adm_doc_versions WHERE doc_id = ?').get(d.id)).c) >= MAX_VERSIONS) throw new HttpError(403, `Déjà ${MAX_VERSIONS} versions : supprimez les plus anciennes.`);
  const name = /\.[A-Za-z0-9]{1,5}$/.test(base) ? base : `${base}.${t.ext}`;
  const n = Number(d.version) + 1; const now = nowISO(); const text = extractText(buf, t.mime);
  await db.transaction(async () => {
    await db.prepare('INSERT INTO adm_doc_versions (org_id, doc_id, n, name, mime, size, sha256, data, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, d.id, n, name, t.mime, buf.length, sha(buf), X.seal(buf), A.text(req.query.note, 300), req.user.id, now);
    await db.prepare('UPDATE adm_docs SET version = ?, file_name = ?, mime = ?, size = ?, text_content = ?, updated_at = ? WHERE id = ?').run(n, name, t.mime, buf.length, text, now, d.id);
  })();
  await logDoc(req, d.id, 'version', `v${n} · ${name} · ${buf.length} octets`);
  res.status(201).json({ ok: true, version: n, textExtracted: text.length });
});
router.get('/:id/download', async (req, res) => {
  const d = await loadDoc(req);
  if (d.status === 'destroyed') throw new HttpError(410, 'Ce document a été détruit.');
  const n = req.query.v ? A.id(req.query.v) : Number(d.version);
  const v = await db.prepare('SELECT * FROM adm_doc_versions WHERE doc_id = ? AND n = ?').get(d.id, n);
  if (!v || !v.data) throw new HttpError(404, 'Aucun fichier pour ce document.');
  const buf = X.unseal(v.data);
  if (!buf) throw new HttpError(500, 'Fichier illisible.');
  await logDoc(req, d.id, 'download', `v${n}`);
  const inline = req.query.inline === '1' && /^(application\/pdf|image\/)/.test(v.mime);
  res.set({ 'Content-Type': v.mime, 'Content-Length': buf.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(v.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.end(buf);
});

// ---------- Verrouillage / prêt ----------
router.post('/:id/lock', async (req, res) => {
  const d = await loadDoc(req);
  if (d.status !== 'active') throw new HttpError(409, 'Un document archivé ne se verrouille pas.');
  if (d.lock_user_id && Number(d.lock_user_id) !== req.user.id) throw new HttpError(423, 'Déjà verrouillé par une autre personne.');
  const b = req.body || {};
  const kind = A.oneOf(b.kind, ['edit', 'loan'], 'edit', 'Type de verrou inconnu (edit ou loan).');
  const due = A.date(b.dueDate) || (kind === 'loan' ? L.addDays(L.today(), 7) : L.addDays(L.today(), 1));
  await db.prepare('UPDATE adm_docs SET lock_user_id = ?, lock_kind = ?, lock_at = ?, lock_due = ?, lock_note = ? WHERE id = ?').run(req.user.id, kind, nowISO(), due, A.text(b.note, 300), d.id);
  await logDoc(req, d.id, kind === 'loan' ? 'loan' : 'lock', `jusqu'au ${due}`);
  res.json({ ok: true, due });
});
router.post('/:id/unlock', async (req, res) => {
  const d = await loadDoc(req);
  if (!d.lock_user_id) return res.json({ ok: true });
  if (Number(d.lock_user_id) !== req.user.id && !L.allowed(req, req.admCfg, 'docs_manage')) throw new HttpError(403, 'Seule la personne qui l’a verrouillé (ou un gestionnaire) peut le libérer.');
  await db.prepare("UPDATE adm_docs SET lock_user_id = NULL, lock_kind = '', lock_at = NULL, lock_due = NULL, lock_note = '' WHERE id = ?").run(d.id);
  await logDoc(req, d.id, 'unlock', Number(d.lock_user_id) === req.user.id ? '' : 'Libéré par un gestionnaire');
  res.json({ ok: true });
});

// ---------- Corbeille ----------
router.post('/:id/trash', async (req, res) => {
  const d = await loadDoc(req);
  if (!editable(req, req.admCfg, d)) throw new HttpError(403, 'Action non permise.');
  if (d.status !== 'active') throw new HttpError(409, 'Un document archivé ne va pas à la corbeille : passez par la destruction validée.');
  if (d.lock_user_id && Number(d.lock_user_id) !== req.user.id) throw new HttpError(423, 'Document verrouillé.');
  await db.prepare('UPDATE adm_docs SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowISO(), req.user.id, d.id);
  await logDoc(req, d.id, 'trash');
  res.json({ ok: true });
});
router.post('/:id/restore', async (req, res) => {
  const d = await loadDoc(req, { allowTrash: true });
  if (!d.deleted_at) throw new HttpError(400, 'Ce document n’est pas à la corbeille.');
  if (!editable(req, req.admCfg, d)) throw new HttpError(403, 'Action non permise.');
  await db.prepare('UPDATE adm_docs SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(d.id);
  await logDoc(req, d.id, 'restore');
  res.json({ ok: true });
});
router.delete('/:id', manage, async (req, res) => {
  const d = await loadDoc(req, { allowTrash: true });
  if (!d.deleted_at) throw new HttpError(400, 'Mettez d’abord le document à la corbeille.');
  await db.prepare('DELETE FROM adm_docs WHERE id = ?').run(d.id);
  await logDoc(req, null, 'purge', d.title);
  res.json({ ok: true });
});

// ---------- Archivage scellé et vérification ----------
async function sealOf(d) {
  const vers = await db.prepare('SELECT n, sha256, size FROM adm_doc_versions WHERE doc_id = ? ORDER BY n').all(d.id);
  const payload = JSON.stringify({ id: Number(d.id), code: d.code, title: d.title, docDate: d.doc_date, archivedAt: d.archived_at, versions: vers.map((v) => [Number(v.n), v.sha256, Number(v.size)]) });
  return sha(Buffer.from(payload));
}
router.post('/:id/archive', manage, async (req, res) => {
  const d = await loadDoc(req);
  if (d.status !== 'active') throw new HttpError(409, 'Ce document est déjà archivé ou détruit.');
  if (d.lock_user_id) throw new HttpError(423, 'Libérez le verrou avant d’archiver.');
  const archivedAt = nowISO();
  const hash = await sealOf({ ...d, archived_at: archivedAt });
  await db.prepare("UPDATE adm_docs SET status = 'archived', archived_at = ?, archived_by = ?, seal_hash = ?, updated_at = ? WHERE id = ?").run(archivedAt, req.user.id, hash, archivedAt, d.id);
  await logDoc(req, d.id, 'archive', 'Scellé ' + hash.slice(0, 16));
  res.json({ ok: true, sealHash: hash, archivedAt });
});
router.get('/:id/verify', async (req, res) => {
  const d = await loadDoc(req);
  if (!d.seal_hash) throw new HttpError(400, 'Ce document n’est pas scellé (archivez-le d’abord).');
  const problems = [];
  const vers = await db.prepare('SELECT n, sha256, data FROM adm_doc_versions WHERE doc_id = ? ORDER BY n').all(d.id);
  for (const v of vers) {
    if (d.status === 'destroyed') break;
    const buf = v.data ? X.unseal(v.data) : null;
    if (!buf) problems.push(`Version ${v.n} : fichier illisible ou absent.`);
    else if (sha(buf) !== v.sha256) problems.push(`Version ${v.n} : le contenu ne correspond plus à son empreinte.`);
  }
  if (await sealOf(d) !== d.seal_hash) problems.push('Les métadonnées ou la liste des versions ont changé depuis le scellement.');
  await logDoc(req, d.id, 'verify', problems.length ? 'ÉCHEC' : 'conforme');
  res.json({ ok: !problems.length, sealHash: d.seal_hash, archivedAt: d.archived_at, destroyed: d.status === 'destroyed', problems });
});

// ---------- Destruction validée ----------
router.post('/:id/destroy-request', manage, async (req, res) => {
  const d = await loadDoc(req);
  if (d.status === 'destroyed') throw new HttpError(409, 'Déjà détruit.');
  const type = d.type_id ? await db.prepare('SELECT * FROM adm_doc_types WHERE id = ?').get(d.type_id) : null;
  if (!d.destroy_due) throw new HttpError(400, 'Ce document est à conservation permanente ou sans règle de conservation : il ne peut pas être détruit.');
  if (type && type.end_action === 'keep') throw new HttpError(400, 'La règle de ce type impose de conserver ce document.');
  if (d.destroy_due > L.today()) throw new HttpError(400, `La durée de conservation court jusqu’au ${d.destroy_due} : destruction impossible avant.`);
  if (d.lock_user_id) throw new HttpError(423, 'Document verrouillé ou prêté.');
  await db.prepare("UPDATE adm_docs SET destroy_state = 'requested', destroy_requested_by = ?, updated_at = ? WHERE id = ?").run(req.user.id, nowISO(), d.id);
  await logDoc(req, d.id, 'destroy_request', A.text((req.body || {}).reason, 300));
  for (const u of await L.ownerIds(req.org.id)) if (u !== req.user.id) await W.push(req.org.id, u, 'administration', `Destruction à valider : ${d.title}`, 'doc:' + d.id);
  res.json({ ok: true });
});
router.post('/:id/destroy-decision', destroyPerm, async (req, res) => {
  const d = await loadDoc(req);
  if (d.destroy_state !== 'requested') throw new HttpError(400, 'Aucune demande de destruction en attente.');
  const approve = (req.body || {}).approve === true || (req.body || {}).approve === 'true';
  if (Number(d.destroy_requested_by) === req.user.id) { // deux personnes : une autre valide, sauf si elle est seule à avoir ce droit
    const mem = await L.members(req.org.id); const cfg = req.admCfg;
    const others = mem.filter((m) => m.userId !== req.user.id && L.allowed({ user: { id: m.userId }, member: { role: m.role } }, cfg, 'docs_destroy'));
    if (others.length) throw new HttpError(403, 'La destruction doit être validée par une autre personne que celle qui l’a demandée.');
  }
  const now = nowISO();
  if (!approve) {
    await db.prepare("UPDATE adm_docs SET destroy_state = 'rejected', destroy_decided_by = ?, updated_at = ? WHERE id = ?").run(req.user.id, now, d.id);
    await logDoc(req, d.id, 'destroy_reject', A.text((req.body || {}).comment, 300));
    return res.json({ ok: true, destroyed: false });
  }
  await db.transaction(async () => {
    await db.prepare('UPDATE adm_doc_versions SET data = NULL WHERE doc_id = ?').run(d.id); // le fichier disparaît ; les empreintes restent comme preuve
    await db.prepare("UPDATE adm_docs SET status = 'destroyed', destroy_state = 'done', destroy_decided_by = ?, destroyed_at = ?, text_content = '', lock_user_id = NULL, updated_at = ? WHERE id = ?").run(req.user.id, now, now, d.id);
  })();
  await logDoc(req, d.id, 'destroy', `Détruit le ${now.slice(0, 10)} · empreinte conservée`);
  res.json({ ok: true, destroyed: true, destroyedAt: now });
});

/** Nettoyage et rappels (appelé à la lecture du tableau de bord, une fois par échéance). */
async function sweep(orgId) {
  const cfg = await L.getConfig(orgId);
  const limit = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
  const old = await db.prepare('SELECT id FROM adm_docs WHERE org_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?').all(orgId, limit);
  for (const d of old) await db.prepare('DELETE FROM adm_docs WHERE id = ?').run(d.id);
  const lim = L.addDays(L.today(), cfg.docAlertDays);
  const rows = await db.prepare("SELECT id, title, archive_due, destroy_due, status, created_by FROM adm_docs WHERE org_id = ? AND deleted_at IS NULL AND status <> 'destroyed' AND ((status = 'active' AND archive_due <= ?) OR destroy_due <= ?)").all(orgId, lim, lim);
  let n = 0;
  const admins = await L.ownerIds(orgId);
  for (const d of rows) {
    if (d.status === 'active' && d.archive_due && d.archive_due <= lim && await L.notifyOnce(orgId, `doc-archive:${d.id}:${d.archive_due}`, admins, `Document à archiver : ${d.title} (avant le ${d.archive_due})`, 'doc:' + d.id)) n++;
    if (d.destroy_due && d.destroy_due <= lim && await L.notifyOnce(orgId, `doc-destroy:${d.id}:${d.destroy_due}`, admins, `Document arrivé au terme de sa conservation : ${d.title} (${d.destroy_due})`, 'doc:' + d.id)) n++;
  }
  return { purged: old.length, reminders: n };
}

module.exports = { router, sweep, dueLists, dueDates, extractText, detect, visible, MAX_FILE };
