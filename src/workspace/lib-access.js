'use strict';
// Bibliothèque — droits d'accès par classe et par notice (rôle, personne, service), délégations temporaires, journal de consultation.
// Cohérence avec les blocs protégés : ces droits s'ajoutent à ceux du bloc, jamais à la place. Un document d'un bloc protégé reste verrouillé tant que la
// personne n'a pas ressaisi SON mot de passe, et les droits du bloc (voir, lire, modifier…) s'appliquent toujours. Ici : une règle « refuser » retire un droit
// sur une notice ou une classe ; une règle « autoriser » ou une délégation donne un droit sur la NOTICE (fiche, prêt) mais ne contourne ni le bloc ni son mot de passe.
// Le propriétaire n'est jamais bloqué par ces règles (comme pour les blocs).
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError, cleanText } = require('../util');

const OPS = ['read', 'download', 'edit', 'loan'];
const SUBJECT_TYPES = ['role', 'user', 'branch'];
const ROLES = ['member', 'manager', 'admin'];
const MAX_RULES = 60;
const MAX_DELEG_DAYS = 90;
const DAY = 86400000;

module.exports = function register(router, h) {
  const { audit } = h;
  const R = () => h.recordHelpers;
  Object.assign(h.ACTIONS, { acl_edit: 'Droits d’accès modifiés', delegation_add: 'Délégation accordée', delegation_revoke: 'Délégation retirée', consult_view: 'Fiche consultée' });

  async function loadCtx(req) {
    const now = nowISO();
    const rules = await db.prepare('SELECT * FROM lib_acl WHERE org_id = ?').all(req.org.id);
    const delegs = await db.prepare('SELECT * FROM lib_delegations WHERE org_id = ? AND to_user = ? AND revoked_at IS NULL AND until > ?').all(req.org.id, req.user.id, now);
    const classes = new Map((await db.prepare('SELECT id, parent_id FROM lib_classes WHERE org_id = ?').all(req.org.id)).map((c) => [Number(c.id), c.parent_id ? Number(c.parent_id) : null]));
    const m = await db.prepare('SELECT branch_id FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
    return { rules, delegs, classes, branch: m && m.branch_id ? Number(m.branch_id) : null, rank: A.RANK[req.member.role], role: req.member.role, owner: req.member.role === 'owner', uid: Number(req.user.id) };
  }
  const chainOf = (ctx, classId) => { const out = []; let c = classId ? Number(classId) : null; let n = 0; while (c && n++ < 12) { out.push(c); c = ctx.classes.get(c) || null; } return out; };
  const subjectMatches = (ctx, e) => (e.subject_type === 'role' ? ctx.role === e.subject : e.subject_type === 'user' ? Number(e.subject) === ctx.uid : e.subject_type === 'branch' ? ctx.branch !== null && Number(e.subject) === ctx.branch : false);
  /** true / false si une règle ou une délégation tranche pour cette opération ; undefined sinon (les droits de base décident). */
  function decide(ctx, r, op) {
    const ch = chainOf(ctx, r.class_id);
    const col = `p_${op}`;
    const mine = ctx.rules.filter((e) => Number(e[col]) && subjectMatches(ctx, e) && ((e.scope === 'record' && Number(e.scope_id) === Number(r.id)) || (e.scope === 'class' && ch.includes(Number(e.scope_id)))));
    if (!ctx.owner && mine.some((e) => e.effect === 'deny')) return false;
    if (mine.some((e) => e.effect === 'allow')) return true;
    if (ctx.delegs.some((d) => Number(d[col]) && (d.scope === 'all' || (d.scope === 'record' && Number(d.scope_id) === Number(r.id)) || (d.scope === 'class' && ch.includes(Number(d.scope_id)))))) return true;
    return undefined;
  }
  // La visibilité d'une notice (catalogue, recherche, prêts) passe par ce crochet.
  h.visibilityHooks = async (req) => { const ctx = await loadCtx(req); return { ctx, override: (r) => decide(ctx, r, 'read') }; };
  /** Droit effectif d'une personne sur une notice pour une opération (read, download, edit, loan). */
  async function can(req, r, op, ctxIn) {
    const ctx = ctxIn || await loadCtx(req);
    const d = decide(ctx, r, op);
    if (d !== undefined) return d;
    const see = ctx.rank >= A.RANK[R().CONF_MIN[r.confidentiality] || 'admin'] || Number(r.created_by) === ctx.uid;
    if (op === 'read' || op === 'download') return see;
    if (op === 'edit') return see && ctx.rank >= A.RANK.manager;
    return see && Boolean(Number(r.loanable));
  }
  h.can = can;
  async function effective(req, r) { const ctx = await loadCtx(req); const out = {}; for (const op of OPS) out[op] = await can(req, r, op, ctx); return out; }
  h.effectiveAccess = effective;

  // ---------- Journal de consultation ----------
  /** Enregistre une consultation (fiche, aperçu, téléchargement, prêt). Ne plante jamais l'action d'origine. */
  h.consult = async (req, recordId, docId, action) => {
    try { await db.prepare('INSERT INTO lib_consult (org_id, record_id, doc_id, user_id, action, at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, recordId || null, docId || null, req.user.id, action, nowISO()); } catch { /* journal : jamais bloquant */ }
  };
  /** Contrôle d'un document lié à des notices : un refus sur une notice liée refuse aussi le document ; journalise la consultation. */
  h.docAccess = async (req, d, action) => {
    const recs = await db.prepare(`${R().RECORD_SQL} WHERE r.org_id = ? AND r.doc_id = ? AND r.deleted_at IS NULL`).all(req.org.id, d.id);
    const op = action === 'download' ? 'download' : 'read';
    if (recs.length) {
      const ctx = await loadCtx(req);
      for (const r of recs) if (!(await can(req, r, op, ctx))) { await audit(req, 'denied', null, `${action} · ${d.name}`); throw new HttpError(403, 'Votre accès ne permet pas cette action.'); }
    }
    if (recs.length) for (const r of recs) await h.consult(req, r.id, d.id, action);
    else await h.consult(req, null, d.id, action);
  };

  // ---------- Règles d'accès par notice ou par classe ----------
  async function subjects(req) {
    const people = await db.prepare('SELECT m.user_id, m.role, u.name, m.branch_id FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY LOWER(u.name)').all(req.org.id);
    const branches = await db.prepare('SELECT id, name FROM branches WHERE org_id = ? ORDER BY LOWER(name)').all(req.org.id);
    return { roles: ROLES, people: people.map((p) => ({ userId: Number(p.user_id), name: p.name, role: p.role })), branches: branches.map((b) => ({ id: Number(b.id), name: b.name })) };
  }
  router.get('/access/subjects', A.need('admin'), async (req, res) => res.json(await subjects(req)));
  const ruleView = (e, names, branches) => ({ id: Number(e.id), scope: e.scope, scopeId: Number(e.scope_id), subjectType: e.subject_type, subject: e.subject, label: e.subject_type === 'user' ? names[Number(e.subject)] || '' : e.subject_type === 'branch' ? branches[Number(e.subject)] || '' : e.subject, effect: e.effect, read: Boolean(Number(e.p_read)), download: Boolean(Number(e.p_download)), edit: Boolean(Number(e.p_edit)), loan: Boolean(Number(e.p_loan)) });
  async function listRules(req, scope, id) {
    const rows = await db.prepare('SELECT * FROM lib_acl WHERE org_id = ? AND scope = ? AND scope_id = ? ORDER BY id').all(req.org.id, scope, id);
    const names = await h.namesOf(rows.filter((e) => e.subject_type === 'user').map((e) => e.subject));
    const br = Object.fromEntries((await db.prepare('SELECT id, name FROM branches WHERE org_id = ?').all(req.org.id)).map((b) => [Number(b.id), b.name]));
    return rows.map((e) => ruleView(e, names, br));
  }
  async function saveRules(req, scope, id, body) {
    const list = Array.isArray((body || {}).rules) ? body.rules : null;
    if (!list) throw new HttpError(400, 'Liste de règles manquante.');
    if (list.length > MAX_RULES) throw new HttpError(400, 'Trop de règles (60 au plus).');
    const clean = [];
    for (const x of list) {
      const subjectType = A.oneOf(x.subjectType, SUBJECT_TYPES, undefined, 'Type de destinataire inconnu.');
      let subject = String(x.subject === undefined || x.subject === null ? '' : x.subject);
      if (subjectType === 'role') { if (!ROLES.includes(subject)) throw new HttpError(400, 'Rôle inconnu.'); } else if (subjectType === 'user') {
        const u = A.id(subject, 'Personne invalide.'); if (!await db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, u)) throw new HttpError(400, 'Cette personne ne fait pas partie de l\'organisation.'); subject = String(u);
      } else { const b = A.id(subject, 'Service invalide.'); if (!await db.prepare('SELECT 1 FROM branches WHERE id = ? AND org_id = ?').get(b, req.org.id)) throw new HttpError(400, 'Service inconnu.'); subject = String(b); }
      const effect = A.oneOf(x.effect, ['allow', 'deny'], undefined, 'Effet inconnu (autoriser ou refuser).');
      const p = Object.fromEntries(OPS.map((op) => [op, x[op] ? 1 : 0]));
      if (!OPS.some((op) => p[op])) throw new HttpError(400, 'Cochez au moins un droit pour chaque règle.');
      clean.push({ subjectType, subject, effect, p });
    }
    await db.transaction(async () => {
      await db.prepare('DELETE FROM lib_acl WHERE org_id = ? AND scope = ? AND scope_id = ?').run(req.org.id, scope, id);
      for (const c of clean) await db.prepare('INSERT INTO lib_acl (org_id, scope, scope_id, subject_type, subject, effect, p_read, p_download, p_edit, p_loan, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, scope, id, c.subjectType, c.subject, c.effect, c.p.read, c.p.download, c.p.edit, c.p.loan, req.user.id, nowISO());
    })();
    return clean.length;
  }
  router.get('/records/:id/access', A.need('admin'), async (req, res) => {
    const r = await R().loadRecord(req, req.params.id); const cls = await R().classMap(req.org.id);
    const ctx = await loadCtx(req); const inherited = [];
    for (const cid of chainOf(ctx, r.class_id)) for (const e of await listRules(req, 'class', cid)) inherited.push({ ...e, classCode: cls.get(cid) ? cls.get(cid).code : '' });
    res.json({ rules: await listRules(req, 'record', Number(r.id)), inherited, effective: await effective(req, r), confidentiality: r.confidentiality });
  });
  router.put('/records/:id/access', A.need('admin'), async (req, res) => {
    const r = await R().loadRecord(req, req.params.id);
    const n = await saveRules(req, 'record', Number(r.id), req.body);
    await audit(req, 'acl_edit', null, `${r.title} (${n} règle(s))`);
    res.json({ ok: true, count: n });
  });
  router.get('/classes/:id/access', A.need('admin'), async (req, res) => {
    const c = await db.prepare('SELECT id FROM lib_classes WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
    if (!c) throw new HttpError(404, 'Classe introuvable.');
    res.json({ rules: await listRules(req, 'class', Number(c.id)) });
  });
  router.put('/classes/:id/access', A.need('admin'), async (req, res) => {
    const c = await db.prepare('SELECT * FROM lib_classes WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
    if (!c) throw new HttpError(404, 'Classe introuvable.');
    const n = await saveRules(req, 'class', Number(c.id), req.body);
    await audit(req, 'acl_edit', null, `${c.code} (${n} règle(s))`);
    res.json({ ok: true, count: n });
  });

  // ---------- Délégations temporaires ----------
  router.post('/delegations', async (req, res) => {
    const b = req.body || {};
    const to = await A.memberOf(req, b.toUserId);
    if (!to || Number(to) === Number(req.user.id)) throw new HttpError(400, 'Choisissez une autre personne.');
    const scope = A.oneOf(b.scope, ['record', 'class', 'all'], 'record', 'Portée inconnue.');
    const perms = Object.fromEntries(OPS.map((op) => [op, (b.perms || {})[op] ? 1 : 0]));
    if (!OPS.some((op) => perms[op])) throw new HttpError(400, 'Cochez au moins un droit à déléguer.');
    const days = Number(b.days === undefined ? 7 : b.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DELEG_DAYS) throw new HttpError(400, 'Durée de la délégation : entre 1 et 90 jours.');
    let scopeId = null;
    // On ne délègue que ce que l'on possède soi-même sur la portée choisie.
    if (scope === 'record') {
      scopeId = A.id(b.scopeId, 'Notice invalide.'); const rec = await R().loadRecord(req, scopeId);
      for (const op of OPS) if (perms[op] && !(await can(req, rec, op))) throw new HttpError(403, 'Vous ne pouvez pas déléguer un droit que vous n’avez pas.');
    } else if (scope === 'class') {
      scopeId = A.id(b.scopeId, 'Classe invalide.');
      if (!await db.prepare('SELECT 1 FROM lib_classes WHERE id = ? AND org_id = ?').get(scopeId, req.org.id)) throw new HttpError(400, 'Classe inconnue.');
      if (!A.can(req, 'manager')) throw new HttpError(403, 'Seul un responsable délègue l’accès à une classe entière.');
      if ((perms.edit) && !A.can(req, 'manager')) throw new HttpError(403, 'Vous ne pouvez pas déléguer un droit que vous n’avez pas.');
    } else if (!A.can(req, 'admin')) throw new HttpError(403, 'Seul un administrateur délègue l’accès à tout le catalogue.');
    const until = new Date(Date.now() + days * DAY).toISOString();
    const id = Number((await db.prepare('INSERT INTO lib_delegations (org_id, from_user, to_user, scope, scope_id, p_read, p_download, p_edit, p_loan, until, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, req.user.id, to, scope, scopeId, perms.read, perms.download, perms.edit, perms.loan, until, cleanText(String(b.reason || ''), 200), nowISO())).lastInsertRowid);
    await audit(req, 'delegation_add', null, '');
    require('./w3').push(req.org.id, to, 'library', 'Un accès à la bibliothèque vous a été délégué temporairement.', `libdeleg:${id}`);
    res.status(201).json({ id, until });
  });
  router.get('/delegations', async (req, res) => {
    const scope = String((req.query || {}).scope || 'mine');
    if (scope === 'all' && !A.can(req, 'admin')) throw new HttpError(403, 'Réservé aux administrateurs.');
    const where = scope === 'all' ? '' : 'AND (from_user = ? OR to_user = ?)';
    const rows = await db.prepare(`SELECT * FROM lib_delegations WHERE org_id = ? ${where} ORDER BY id DESC LIMIT 200`).all(req.org.id, ...(scope === 'all' ? [] : [req.user.id, req.user.id]));
    const names = await h.namesOf(rows.flatMap((d) => [d.from_user, d.to_user]));
    const now = nowISO();
    res.json({ delegations: rows.map((d) => ({ id: Number(d.id), from: names[Number(d.from_user)] || '', to: names[Number(d.to_user)] || '', toUserId: Number(d.to_user), mine: Number(d.from_user) === Number(req.user.id), scope: d.scope, scopeId: d.scope_id ? Number(d.scope_id) : null, read: Boolean(Number(d.p_read)), download: Boolean(Number(d.p_download)), edit: Boolean(Number(d.p_edit)), loan: Boolean(Number(d.p_loan)), until: d.until, reason: d.reason, active: !d.revoked_at && d.until > now, revokedAt: d.revoked_at })) });
  });
  router.delete('/delegations/:id', async (req, res) => {
    const d = await db.prepare('SELECT * FROM lib_delegations WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
    if (!d || (Number(d.from_user) !== Number(req.user.id) && !A.can(req, 'admin'))) throw new HttpError(404, 'Délégation introuvable.');
    await db.prepare('UPDATE lib_delegations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowISO(), d.id);
    await audit(req, 'delegation_revoke', null, '');
    res.json({ ok: true });
  });

  // ---------- Journal de consultation ----------
  router.get('/records/:id/consultations', A.need('manager'), async (req, res) => {
    const r = await R().loadRecord(req, req.params.id);
    const rows = await db.prepare('SELECT * FROM lib_consult WHERE org_id = ? AND record_id = ? ORDER BY id DESC LIMIT 200').all(req.org.id, r.id);
    const names = await h.namesOf(rows.map((x) => x.user_id));
    res.json({ consultations: rows.map((x) => ({ id: Number(x.id), user: names[Number(x.user_id)] || '', action: x.action, at: x.at })) });
  });
  router.get('/consultations', A.need('admin'), async (req, res) => {
    const days = Math.min(365, Math.max(1, Number((req.query || {}).days) || 30));
    const since = new Date(Date.now() - days * DAY).toISOString();
    const vis = await R().visibility(req);
    const rows = await db.prepare('SELECT c.*, r.title FROM lib_consult c LEFT JOIN lib_records r ON r.id = c.record_id WHERE c.org_id = ? AND c.at >= ? ORDER BY c.id DESC LIMIT 500').all(req.org.id, since);
    const visibleIds = new Set((await R().visibleRecords(req, vis)).map((r) => Number(r.id)));
    const names = await h.namesOf(rows.map((x) => x.user_id));
    res.json({ days, consultations: rows.filter((x) => !x.record_id || visibleIds.has(Number(x.record_id))).map((x) => ({ id: Number(x.id), recordId: x.record_id ? Number(x.record_id) : null, title: x.title || '', user: names[Number(x.user_id)] || '', action: x.action, at: x.at })) });
  });

  // ---------- Fiche d'une notice : droits effectifs ----------
  const prev = h.recordDetails;
  h.recordDetails = async (req, r, vis) => {
    const out = prev ? await prev(req, r, vis) : {};
    out.access = await effective(req, r);
    await h.consult(req, r.id, r.doc_id, 'view');
    return out;
  };
};
