'use strict';
// Administration · 2. Procédures (SOP) : bibliothèque, modèles de PME, statuts, versions avec comparaison, accusé de lecture, rappels de révision.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./adm-lib');
const T = require('./adm-templates');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const write = L.needPerm('sop_write');
const approve = L.needPerm('sop_approve');
const STATUSES = ['draft', 'reviewed', 'approved', 'obsolete'];

const normSteps = (v) => (Array.isArray(v) ? v : []).slice(0, 80).map((s) => (typeof s === 'string' ? { text: A.text(s, 600) } : { text: A.text(s && s.text, 600), role: A.text(s && s.role, 80), tool: A.text(s && s.tool, 120) })).filter((s) => s.text);
const normAudience = (v) => {
  const a = v && typeof v === 'object' ? v : {};
  return { all: Boolean(a.all), roles: [...new Set((Array.isArray(a.roles) ? a.roles : []).filter((r) => A.ROLES.includes(r)))], users: [...new Set((Array.isArray(a.users) ? a.users : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200) };
};
const snapshotOf = (s) => ({ title: s.title, purpose: s.purpose, domain: s.domain, ownerId: s.owner_id == null ? null : Number(s.owner_id), steps: L.jparse(s.steps, []), linkedDocs: L.jparse(s.linked_docs, []), indicators: L.jparse(s.indicators, []), reviewMonths: Number(s.review_months), audience: L.jparse(s.audience, {}), mandatoryRead: Number(s.mandatory_read) });

function audienceUsers(aud, mem) {
  const a = normAudience(aud);
  if (a.all) return mem.map((m) => m.userId);
  return mem.filter((m) => a.users.includes(m.userId) || a.roles.includes(m.role)).map((m) => m.userId);
}
async function view(req, s, mem, withAcks = true) {
  const o = L.out(s, { steps: L.jparse(s.steps, []), linkedDocs: L.jparse(s.linked_docs, []), indicators: L.jparse(s.indicators, []), audience: L.jparse(s.audience, {}), version: Number(s.version) });
  delete o.linkedDocs; o.linkedDocs = L.jparse(s.linked_docs, []);
  const names = new Map(mem.map((m) => [m.userId, m.name]));
  o.owner = s.owner_id ? names.get(Number(s.owner_id)) || null : null;
  const today = L.today();
  o.reviewDue = Boolean(s.next_review && s.status === 'approved' && s.next_review <= today);
  o.reviewInDays = s.next_review ? L.daysBetween(today, s.next_review) : null;
  if (withAcks) {
    const targets = audienceUsers(o.audience, mem);
    const acks = await db.prepare('SELECT user_id FROM adm_sop_acks WHERE sop_id = ? AND version = ?').all(s.id, s.version);
    const done = new Set(acks.map((a) => Number(a.user_id)));
    o.readers = { total: targets.length, done: targets.filter((u) => done.has(u)).length };
    o.iRead = done.has(req.user.id);
    o.iMustRead = Boolean(Number(s.mandatory_read)) && s.status === 'approved' && targets.includes(req.user.id) && !done.has(req.user.id);
  }
  return o;
}
const canSeeDraft = (req, cfg) => L.allowed(req, cfg, 'sop_write') || L.allowed(req, cfg, 'sop_approve');

router.get('/templates', (req, res) => res.json({ templates: T.SOP_TEMPLATES.map((t) => ({ key: t.key, title: t.title, domain: t.domain, purpose: t.purpose, steps: t.steps.length, reviewMonths: t.reviewMonths })) }));

router.get('/', async (req, res) => {
  const cfg = req.admCfg = await L.getConfig(req.org.id);
  const mem = await L.members(req.org.id);
  const where = ['org_id = ?']; const args = [req.org.id];
  if (!canSeeDraft(req, cfg)) where.push("status = 'approved'");
  else if (req.query.status && STATUSES.includes(String(req.query.status))) { where.push('status = ?'); args.push(String(req.query.status)); }
  if (req.query.domain) { where.push('domain = ?'); args.push(String(req.query.domain).slice(0, 80)); }
  const rows = await db.prepare(`SELECT * FROM adm_sops WHERE ${where.join(' AND ')} ORDER BY domain, title LIMIT 500`).all(...args);
  const sops = [];
  for (const s of rows) sops.push(await view(req, s, mem));
  const all = await db.prepare('SELECT status, next_review FROM adm_sops WHERE org_id = ?').all(req.org.id);
  const today = L.today();
  res.json({
    sops,
    summary: { total: all.length, ...Object.fromEntries(STATUSES.map((st) => [st, all.filter((x) => x.status === st).length])), reviewDue: all.filter((x) => x.status === 'approved' && x.next_review && x.next_review <= today).length },
    perms: { write: L.allowed(req, cfg, 'sop_write'), approve: L.allowed(req, cfg, 'sop_approve') },
  });
});

router.get('/my/pending', async (req, res) => {
  const mem = await L.members(req.org.id);
  const rows = await db.prepare("SELECT * FROM adm_sops WHERE org_id = ? AND status = 'approved' AND mandatory_read = 1").all(req.org.id);
  const pending = [];
  for (const s of rows) { const v = await view(req, s, mem); if (v.iMustRead) pending.push({ id: v.id, title: v.title, version: v.version, domain: v.domain }); }
  res.json({ pending });
});

async function insertSop(req, d) {
  const now = nowISO();
  const id = (await db.prepare(`INSERT INTO adm_sops (org_id, code, title, purpose, domain, owner_id, steps, linked_docs, indicators, version, status, review_months, next_review, audience, mandatory_read, template_key, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, NULL, ?, ?, ?, ?, ?, ?)`).run(req.org.id, d.code, d.title, d.purpose, d.domain, d.ownerId, JSON.stringify(d.steps), JSON.stringify(d.linkedDocs), JSON.stringify(d.indicators), d.reviewMonths, JSON.stringify(d.audience), d.mandatoryRead, d.templateKey || '', req.user.id, now, now)).lastInsertRowid;
  await db.prepare('INSERT INTO adm_sop_versions (org_id, sop_id, version, snapshot, note, status, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(req.org.id, id, JSON.stringify({ title: d.title, purpose: d.purpose, domain: d.domain, ownerId: d.ownerId, steps: d.steps, linkedDocs: d.linkedDocs, indicators: d.indicators, reviewMonths: d.reviewMonths, audience: d.audience, mandatoryRead: d.mandatoryRead }), 'Création', 'draft', req.user.id, now);
  return Number(id);
}
async function parseBody(req, b, base = {}) {
  const pick = (k, f) => (b[k] === undefined ? base[k] : f(b[k]));
  const owner = b.ownerId === undefined ? base.ownerId : await A.memberOf(req, b.ownerId);
  const linked = b.linkedDocs === undefined ? base.linkedDocs : (Array.isArray(b.linkedDocs) ? b.linkedDocs : []).slice(0, 30).map((x) => (typeof x === 'object' && x ? { docId: Number(x.docId) || null, label: A.text(x.label, 200) } : { docId: null, label: A.text(x, 200) })).filter((x) => x.docId || x.label);
  const inds = b.indicators === undefined ? base.indicators : L.strList(b.indicators, 20, 200);
  return {
    code: pick('code', (v) => A.text(v, 40)) || '', title: pick('title', (v) => A.text(v, 160, { required: true, msg: 'Indiquez le titre de la procédure.' })), purpose: pick('purpose', (v) => A.text(v, 1500)) || '',
    domain: pick('domain', (v) => A.text(v, 80)) || '', ownerId: owner === undefined ? null : owner, steps: pick('steps', normSteps) || [], linkedDocs: linked || [], indicators: inds || [],
    reviewMonths: pick('reviewMonths', (v) => L.intIn(v, 1, 60, 12)) || 12, audience: pick('audience', normAudience) || { all: false, roles: [], users: [] }, mandatoryRead: pick('mandatoryRead', (v) => L.flag(v)) || 0, templateKey: base.templateKey,
  };
}

router.post('/', write, async (req, res) => {
  const b = req.body || {};
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_sops WHERE org_id = ?').get(req.org.id)).c >= 500) throw new HttpError(403, 'Limite de 500 procédures atteinte.');
  let base = {};
  if (b.templateKey) {
    const t = T.SOP_TEMPLATES.find((x) => x.key === b.templateKey);
    if (!t) throw new HttpError(400, 'Modèle inconnu.');
    base = { title: t.title, purpose: t.purpose, domain: t.domain, steps: t.steps, indicators: t.indicators, reviewMonths: t.reviewMonths, templateKey: t.key, audience: { all: true, roles: [], users: [] } };
  }
  const d = await parseBody(req, b, base);
  if (!d.title) throw new HttpError(400, 'Indiquez le titre de la procédure.');
  if (!d.code) d.code = 'SOP-' + String((await db.prepare('SELECT COUNT(*) c FROM adm_sops WHERE org_id = ?').get(req.org.id)).c + 1).padStart(3, '0');
  const id = await insertSop(req, d);
  await W.audit(req, 'adm_sop', id, 'create', null, { title: d.title });
  res.status(201).json({ id });
});

async function load(req) {
  const s = await db.prepare('SELECT * FROM adm_sops WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Procédure introuvable.');
  req.admCfg = req.admCfg || await L.getConfig(req.org.id);
  if (s.status !== 'approved' && !canSeeDraft(req, req.admCfg)) throw new HttpError(404, 'Procédure introuvable.');
  return s;
}
router.get('/:id', async (req, res) => {
  const s = await load(req);
  const mem = await L.members(req.org.id);
  const o = await view(req, s, mem);
  const versions = await db.prepare('SELECT version, note, status, created_by, created_at FROM adm_sop_versions WHERE sop_id = ? ORDER BY version DESC').all(s.id);
  const names = new Map(mem.map((m) => [m.userId, m.name]));
  o.versions = versions.map((v) => ({ version: Number(v.version), note: v.note, status: v.status, by: names.get(Number(v.created_by)) || null, at: v.created_at }));
  res.json({ sop: o });
});

router.put('/:id', write, async (req, res) => {
  const s = await load(req);
  const b = req.body || {};
  const cur = snapshotOf(s);
  const d = await parseBody(req, b, { ...cur, code: s.code, templateKey: s.template_key });
  const now = nowISO();
  const content = JSON.stringify({ title: d.title, purpose: d.purpose, domain: d.domain, ownerId: d.ownerId, steps: d.steps, linkedDocs: d.linkedDocs, indicators: d.indicators, reviewMonths: d.reviewMonths, audience: d.audience, mandatoryRead: d.mandatoryRead });
  const changed = content !== JSON.stringify(cur) || (b.code !== undefined && d.code !== s.code);
  const newVersion = changed && s.status !== 'draft'; // modifier une procédure relue / approuvée ouvre une nouvelle version en brouillon
  const version = newVersion ? Number(s.version) + 1 : Number(s.version);
  await db.transaction(async () => {
    await db.prepare(`UPDATE adm_sops SET code = ?, title = ?, purpose = ?, domain = ?, owner_id = ?, steps = ?, linked_docs = ?, indicators = ?, review_months = ?, audience = ?, mandatory_read = ?, version = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(d.code, d.title, d.purpose, d.domain, d.ownerId, JSON.stringify(d.steps), JSON.stringify(d.linkedDocs), JSON.stringify(d.indicators), d.reviewMonths, JSON.stringify(d.audience), d.mandatoryRead, version, newVersion ? 'draft' : s.status, now, s.id);
    if (changed) {
      await db.prepare(`INSERT INTO adm_sop_versions (org_id, sop_id, version, snapshot, note, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
        ON CONFLICT (sop_id, version) DO UPDATE SET snapshot = EXCLUDED.snapshot, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`).run(req.org.id, s.id, version, content, A.text(b.note, 300) || (newVersion ? 'Révision' : 'Modification du brouillon'), req.user.id, now);
    }
  })();
  await W.audit(req, 'adm_sop', s.id, 'update', { version: s.version, status: s.status }, { version, status: newVersion ? 'draft' : s.status });
  res.json({ ok: true, version, status: newVersion ? 'draft' : s.status, newVersion });
});

async function setStatus(req, s, to, extra = {}) {
  await db.prepare('UPDATE adm_sops SET status = ?, updated_at = ? WHERE id = ?').run(to, nowISO(), s.id);
  await db.prepare('UPDATE adm_sop_versions SET status = ? WHERE sop_id = ? AND version = ?').run(to, s.id, s.version);
  await W.audit(req, 'adm_sop', s.id, 'status', { status: s.status }, { status: to, ...extra });
}
router.post('/:id/review', write, async (req, res) => {
  const s = await load(req);
  if (s.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être marqué « relu ».');
  await setStatus(req, s, 'reviewed');
  res.json({ ok: true, status: 'reviewed' });
});
router.post('/:id/approve', approve, async (req, res) => {
  const s = await load(req);
  if (s.status !== 'reviewed') throw new HttpError(400, 'Une procédure doit être relue avant d’être approuvée.');
  const cfg = req.admCfg;
  const last = await db.prepare('SELECT created_by FROM adm_sop_versions WHERE sop_id = ? AND version = ?').get(s.id, s.version);
  if (cfg.distinct && last && Number(last.created_by) === req.user.id && req.member.role !== 'owner') throw new HttpError(403, 'Le réglage « deux personnes » impose qu’une autre personne approuve cette procédure.');
  const now = nowISO(); const next = L.addMonths(now.slice(0, 10), Number(s.review_months));
  // les versions précédentes approuvées deviennent « remplacées » côté historique (le statut courant reste celui de la procédure)
  await db.prepare('UPDATE adm_sops SET approved_by = ?, approved_at = ?, next_review = ? WHERE id = ?').run(req.user.id, now, next, s.id);
  await setStatus(req, s, 'approved', { nextReview: next });
  if (Number(s.mandatory_read)) {
    const mem = await L.members(req.org.id);
    for (const u of audienceUsers(L.jparse(s.audience, {}), mem)) if (u !== req.user.id) await W.push(req.org.id, u, 'administration', `Procédure à lire et à accuser : ${s.title} (v${s.version})`, 'sop:' + s.id);
  }
  res.json({ ok: true, status: 'approved', nextReview: next });
});
router.post('/:id/revalidate', approve, async (req, res) => { // revue périodique sans changement
  const s = await load(req);
  if (s.status !== 'approved') throw new HttpError(400, 'Seule une procédure approuvée se revalide.');
  const next = L.addMonths(L.today(), Number(s.review_months));
  await db.prepare('UPDATE adm_sops SET next_review = ?, updated_at = ? WHERE id = ?').run(next, nowISO(), s.id);
  await W.audit(req, 'adm_sop', s.id, 'revalidate', { nextReview: s.next_review }, { nextReview: next });
  res.json({ ok: true, nextReview: next });
});
router.post('/:id/obsolete', approve, async (req, res) => {
  const s = await load(req);
  if (s.status === 'obsolete') throw new HttpError(400, 'Déjà obsolète.');
  await setStatus(req, s, 'obsolete');
  res.json({ ok: true });
});
router.delete('/:id', approve, async (req, res) => {
  const s = await load(req);
  if (s.status === 'approved') throw new HttpError(400, 'Rendez d’abord la procédure obsolète : une procédure approuvée ne se supprime pas.');
  await db.prepare('DELETE FROM adm_sops WHERE id = ?').run(s.id);
  await W.audit(req, 'adm_sop', s.id, 'delete', { title: s.title }, null);
  res.json({ ok: true });
});

router.post('/:id/ack', async (req, res) => {
  const s = await load(req);
  if (s.status !== 'approved') throw new HttpError(400, 'Seule une procédure approuvée se lit et s’accuse.');
  const mem = await L.members(req.org.id);
  if (!audienceUsers(L.jparse(s.audience, {}), mem).includes(req.user.id)) throw new HttpError(403, 'Cette procédure ne vous est pas destinée.');
  await db.prepare('INSERT INTO adm_sop_acks (org_id, sop_id, version, user_id, read_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (sop_id, version, user_id) DO NOTHING').run(req.org.id, s.id, s.version, req.user.id, nowISO());
  res.json({ ok: true, version: Number(s.version) });
});
router.get('/:id/acks', write, async (req, res) => {
  const s = await load(req);
  const mem = await L.members(req.org.id);
  const targets = audienceUsers(L.jparse(s.audience, {}), mem);
  const acks = new Map((await db.prepare('SELECT user_id, read_at FROM adm_sop_acks WHERE sop_id = ? AND version = ?').all(s.id, s.version)).map((a) => [Number(a.user_id), a.read_at]));
  const people = targets.map((u) => ({ userId: u, name: (mem.find((m) => m.userId === u) || {}).name, readAt: acks.get(u) || null }));
  res.json({ version: Number(s.version), people, done: people.filter((p) => p.readAt).length, total: people.length });
});
router.post('/:id/remind', write, async (req, res) => {
  const s = await load(req);
  const mem = await L.members(req.org.id);
  const acks = new Set((await db.prepare('SELECT user_id FROM adm_sop_acks WHERE sop_id = ? AND version = ?').all(s.id, s.version)).map((a) => Number(a.user_id)));
  let n = 0;
  for (const u of audienceUsers(L.jparse(s.audience, {}), mem)) if (!acks.has(u)) { await W.push(req.org.id, u, 'administration', `Rappel : lisez et accusez la procédure « ${s.title} »`, 'sop:' + s.id); n++; }
  res.json({ ok: true, reminded: n });
});

// ---------- Historique : comparaison de deux versions ----------
const FIELDS = [['title', 'Titre'], ['purpose', 'But'], ['domain', 'Domaine'], ['ownerId', 'Responsable'], ['reviewMonths', 'Révision (mois)'], ['mandatoryRead', 'Lecture obligatoire']];
function listDiff(a, b, key = (x) => JSON.stringify(x)) {
  const ka = a.map(key); const kb = b.map(key);
  return { removed: a.filter((x, i) => !kb.includes(ka[i])), added: b.filter((x, i) => !ka.includes(kb[i])), kept: b.filter((x, i) => ka.includes(kb[i])).length };
}
function compare(a, b) {
  const changes = [];
  for (const [k, label] of FIELDS) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changes.push({ field: k, label, before: a[k] ?? null, after: b[k] ?? null });
  const steps = listDiff(a.steps || [], b.steps || [], (x) => x.text);
  const indicators = listDiff(a.indicators || [], b.indicators || [], (x) => x);
  const linked = listDiff(a.linkedDocs || [], b.linkedDocs || []);
  const audienceChanged = JSON.stringify(a.audience) !== JSON.stringify(b.audience);
  return { changes, steps, indicators, linkedDocs: linked, audienceChanged, identical: !changes.length && !steps.added.length && !steps.removed.length && !indicators.added.length && !indicators.removed.length && !linked.added.length && !linked.removed.length && !audienceChanged };
}
router.get('/:id/compare', async (req, res) => {
  const s = await load(req);
  const from = A.id(req.query.from, 'Version de départ invalide.'); const to = A.id(req.query.to, 'Version d’arrivée invalide.');
  const get = async (n) => { const r = await db.prepare('SELECT snapshot FROM adm_sop_versions WHERE sop_id = ? AND version = ?').get(s.id, n); if (!r) throw new HttpError(404, `Version ${n} introuvable.`); return L.jparse(r.snapshot, {}); };
  res.json({ from, to, ...compare(await get(from), await get(to)) });
});
router.get('/:id/versions/:n', write, async (req, res) => {
  const s = await load(req);
  const r = await db.prepare('SELECT * FROM adm_sop_versions WHERE sop_id = ? AND version = ?').get(s.id, A.id(req.params.n));
  if (!r) throw new HttpError(404, 'Version introuvable.');
  res.json({ version: Number(r.version), note: r.note, status: r.status, createdAt: r.created_at, snapshot: L.jparse(r.snapshot, {}) });
});

/** Rappels de révision (une seule fois par échéance). */
async function sweep(orgId) {
  const cfg = await L.getConfig(orgId);
  const lim = L.addDays(L.today(), cfg.sopReminderDays);
  const rows = await db.prepare("SELECT id, title, owner_id, next_review FROM adm_sops WHERE org_id = ? AND status = 'approved' AND next_review IS NOT NULL AND next_review <= ?").all(orgId, lim);
  let n = 0;
  for (const s of rows) if (await L.notifyOnce(orgId, `sop-review:${s.id}:${s.next_review}`, [s.owner_id, ...await L.ownerIds(orgId)], `Procédure à réviser avant le ${s.next_review} : ${s.title}`, 'sop:' + s.id)) n++;
  return n;
}

module.exports = { router, sweep, compare, audienceUsers };
