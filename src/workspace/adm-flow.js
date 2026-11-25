'use strict';
// Administration · 4. Circuits de validation (workflow) : éditeur de circuits (étapes séquentielles, approbateurs en parallèle « un seul » ou « tous »,
// approbateur par rôle / poste / personne, seuils de montant, délai, escalade automatique, suppléant, délégations et intérim), demandes, boîte « à valider »,
// historique et indicateurs de délai.
// DROITS : le responsable du compte désigne qui CRÉE les circuits (flow_design) et qui les VALIDE / met en service (flow_validate) ; par défaut, le propriétaire seul.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./adm-lib');
const O = require('./adm-org');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const design = L.needPerm('flow_design');
const validate = L.needPerm('flow_validate');

const KINDS = ['purchase', 'leave', 'expense', 'document', 'contract', 'access', 'other'];
const KIND_LABEL = { purchase: 'Achat', leave: 'Congé', expense: 'Dépense', document: 'Document', contract: 'Contrat', access: 'Accès', other: 'Autre' };
const MAX_STEPS = 12; const MAX_APPROVERS = 10;

// ---------- Étapes d'un circuit ----------
async function normApprover(req, a) {
  const kind = A.oneOf(a && a.kind, ['role', 'user', 'position', 'epost', 'edg'], undefined, 'Type d’approbateur inconnu (role, user, position, epost ou edg).');
  if (kind === 'role') return { kind, role: A.oneOf(a.role, ['member', 'manager', 'admin', 'owner'], undefined, 'Rôle inconnu.') };
  if (kind === 'edg') return { kind }; // direction générale de l'entreprise (compte d'entreprise)
  if (kind === 'epost') { const pid = A.id(a.id, 'Approbateur invalide.'); if (!await db.prepare('SELECT 1 FROM ent_posts WHERE id = ? AND org_id = ?').get(pid, req.org.id)) throw new HttpError(400, 'Poste inconnu.'); return { kind, id: pid }; } // poste de l'organigramme (directeur d'un département…)
  const id = A.id(a.id, 'Approbateur invalide.');
  if (kind === 'user') await A.memberOf(req, id);
  else if (!await db.prepare('SELECT 1 FROM positions WHERE id = ? AND org_id = ?').get(id, req.org.id)) throw new HttpError(400, 'Poste inconnu.');
  return { kind, id };
}
async function normSteps(req, v) {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'Un circuit a besoin d’au moins une étape.');
  if (v.length > MAX_STEPS) throw new HttpError(400, `Un circuit a ${MAX_STEPS} étapes au plus.`);
  const out = [];
  for (const [i, s] of v.entries()) {
    const approvers = [];
    if (!Array.isArray(s && s.approvers) || !s.approvers.length) throw new HttpError(400, `Étape ${i + 1} : indiquez au moins un approbateur.`);
    if (s.approvers.length > MAX_APPROVERS) throw new HttpError(400, `Étape ${i + 1} : ${MAX_APPROVERS} approbateurs au plus.`);
    for (const a of s.approvers) approvers.push(await normApprover(req, a));
    const min = L.money(s.minAmount); const max = L.money(s.maxAmount);
    if (max && max < min) throw new HttpError(400, `Étape ${i + 1} : le seuil maximum est inférieur au minimum.`);
    const delay = Number(s.delayHours || 0);
    if (!Number.isFinite(delay) || delay < 0 || delay > 24 * 60) throw new HttpError(400, `Étape ${i + 1} : délai invalide (0 à 1440 heures).`);
    out.push({
      name: A.text(s.name, 100) || `Étape ${i + 1}`, mode: A.oneOf(s.mode, ['any', 'all'], 'any', 'Mode inconnu (any ou all).'), approvers, minAmount: min, maxAmount: max, delayHours: delay,
      escalateTo: s.escalateTo ? await normApprover(req, s.escalateTo) : null, deputy: s.deputy ? await normApprover(req, { kind: 'user', id: s.deputy.id ?? s.deputy }) : null,
    });
  }
  return out;
}
const flowView = (f, names) => ({ ...L.out(f, { steps: L.jparse(f.steps, []), kindLabel: KIND_LABEL[f.kind] || f.kind, creator: names.get(Number(f.created_by)) || null, validator: names.get(Number(f.validated_by)) || null, version: Number(f.version), minAmount: Number(f.min_amount), maxAmount: Number(f.max_amount) }) });

router.get('/flows', async (req, res) => {
  const cfg = req.admCfg = await L.getConfig(req.org.id);
  const names = await L.nameMap(req.org.id);
  const seeAll = L.allowed(req, cfg, 'flow_design') || L.allowed(req, cfg, 'flow_validate');
  const rows = await db.prepare(`SELECT * FROM adm_flows WHERE org_id = ?${seeAll ? '' : " AND status = 'active'"} ORDER BY kind, name`).all(req.org.id);
  res.json({ flows: rows.map((f) => flowView(f, names)), kinds: KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] })), perms: { design: L.allowed(req, cfg, 'flow_design'), validate: L.allowed(req, cfg, 'flow_validate') } });
});
router.post('/flows', design, async (req, res) => {
  const b = req.body || {};
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_flows WHERE org_id = ?').get(req.org.id)).c >= 200) throw new HttpError(403, 'Limite de 200 circuits atteinte.');
  const steps = await normSteps(req, b.steps);
  const now = nowISO();
  const id = (await db.prepare("INSERT INTO adm_flows (org_id, name, kind, description, steps, min_amount, max_amount, status, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)")
    .run(req.org.id, A.text(b.name, 120, { required: true, msg: 'Indiquez le nom du circuit.' }), A.oneOf(b.kind, KINDS, 'other', 'Type de demande inconnu.'), A.text(b.description, 1000), JSON.stringify(steps), L.money(b.minAmount), L.money(b.maxAmount), req.user.id, now, now)).lastInsertRowid;
  await W.audit(req, 'adm_flow', id, 'create', null, { name: b.name, steps: steps.length });
  res.status(201).json({ id: Number(id) });
});
async function loadFlow(req, id = req.params.id) {
  const f = await db.prepare('SELECT * FROM adm_flows WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  req.admCfg = req.admCfg || await L.getConfig(req.org.id);
  if (!f || (f.status !== 'active' && !L.allowed(req, req.admCfg, 'flow_design') && !L.allowed(req, req.admCfg, 'flow_validate'))) throw new HttpError(404, 'Circuit introuvable.');
  return f;
}
router.get('/flows/:id', async (req, res) => { const f = await loadFlow(req); res.json({ flow: flowView(f, await L.nameMap(req.org.id)) }); });
router.put('/flows/:id', design, async (req, res) => {
  const f = await loadFlow(req);
  if (f.status === 'active' && !L.allowed(req, req.admCfg, 'flow_validate')) throw new HttpError(409, 'Ce circuit est en service : dupliquez-le pour proposer une nouvelle version, qu’une personne habilitée validera.');
  if (f.status === 'archived') throw new HttpError(409, 'Circuit archivé : dupliquez-le.');
  const b = req.body || {};
  const steps = b.steps === undefined ? L.jparse(f.steps, []) : await normSteps(req, b.steps);
  const bump = f.status === 'active' ? 1 : 0;
  await db.prepare('UPDATE adm_flows SET name = ?, kind = ?, description = ?, steps = ?, min_amount = ?, max_amount = ?, version = version + ?, updated_at = ? WHERE id = ?').run(
    b.name === undefined ? f.name : A.text(b.name, 120, { required: true, msg: 'Le nom ne peut pas être vide.' }), b.kind === undefined ? f.kind : A.oneOf(b.kind, KINDS, 'other', 'Type de demande inconnu.'),
    b.description === undefined ? f.description : A.text(b.description, 1000), JSON.stringify(steps), b.minAmount === undefined ? f.min_amount : L.money(b.minAmount), b.maxAmount === undefined ? f.max_amount : L.money(b.maxAmount), bump, nowISO(), f.id);
  await W.audit(req, 'adm_flow', f.id, 'update', { version: f.version }, { version: Number(f.version) + bump });
  res.json({ ok: true });
});
router.post('/flows/:id/duplicate', design, async (req, res) => {
  const f = await loadFlow(req);
  const now = nowISO();
  const id = (await db.prepare("INSERT INTO adm_flows (org_id, name, kind, description, steps, min_amount, max_amount, status, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)")
    .run(req.org.id, f.name, f.kind, f.description, f.steps, f.min_amount, f.max_amount, Number(f.version) + 1, req.user.id, now, now)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.post('/flows/:id/publish', validate, async (req, res) => {
  const f = await loadFlow(req);
  if (f.status !== 'draft') throw new HttpError(400, 'Seul un brouillon se met en service.');
  if (req.admCfg.distinct && Number(f.created_by) === req.user.id) {
    const mem = await L.members(req.org.id);
    if (mem.some((m) => m.userId !== req.user.id && L.allowed({ user: { id: m.userId }, member: { role: m.role } }, req.admCfg, 'flow_validate'))) throw new HttpError(403, 'Le réglage « deux personnes » impose qu’une autre personne valide un circuit que vous avez créé.');
  }
  const now = nowISO();
  await db.transaction(async () => {
    await db.prepare("UPDATE adm_flows SET status = 'archived', updated_at = ? WHERE org_id = ? AND status = 'active' AND lower(name) = lower(?) AND id <> ?").run(now, req.org.id, f.name, f.id); // la nouvelle version remplace l'ancienne
    await db.prepare("UPDATE adm_flows SET status = 'active', validated_by = ?, validated_at = ?, updated_at = ? WHERE id = ?").run(req.user.id, now, now, f.id);
  })();
  await W.audit(req, 'adm_flow', f.id, 'publish', { status: 'draft' }, { status: 'active' });
  res.json({ ok: true });
});
router.post('/flows/:id/archive', validate, async (req, res) => {
  const f = await loadFlow(req);
  await db.prepare("UPDATE adm_flows SET status = 'archived', updated_at = ? WHERE id = ?").run(nowISO(), f.id);
  await W.audit(req, 'adm_flow', f.id, 'archive', { status: f.status }, { status: 'archived' });
  res.json({ ok: true });
});
router.delete('/flows/:id', design, async (req, res) => {
  const f = await loadFlow(req);
  if (f.status === 'active') throw new HttpError(400, 'Archivez d’abord un circuit en service.');
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_requests WHERE flow_id = ?').get(f.id)).c) throw new HttpError(400, 'Des demandes utilisent ce circuit : archivez-le plutôt.');
  await db.prepare('DELETE FROM adm_flows WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

// ---------- Résolution des approbateurs (rôle / poste / personne, intérim, délégations, suppléant) ----------
async function resolveSpec(orgId, spec, mem) {
  if (spec.kind === 'user') return mem.some((m) => m.userId === Number(spec.id)) ? [Number(spec.id)] : [];
  if (spec.kind === 'role') return mem.filter((m) => m.role === spec.role).map((m) => m.userId);
  if (spec.kind === 'edg') { // direction générale : les directeurs généraux de l'entreprise qui font partie de cette organisation
    const rows = await db.prepare('SELECT pe.user_id FROM ent_dg g JOIN ent_people pe ON pe.id = g.person_id JOIN orgs o ON o.entreprise_id = g.entreprise_id WHERE o.id = ? AND pe.user_id IS NOT NULL').all(orgId);
    return rows.map((r) => Number(r.user_id)).filter((u) => mem.some((m) => m.userId === u));
  }
  if (spec.kind === 'epost') { // personnes affectées à un poste de l'organigramme DE CETTE organisation (affectations propres à chaque organisation)
    const rows = await db.prepare('SELECT pe.user_id FROM ent_assignments a JOIN ent_people pe ON pe.id = a.person_id WHERE a.post_id = ? AND a.org_id = ? AND pe.user_id IS NOT NULL').all(Number(spec.id), orgId);
    return rows.map((r) => Number(r.user_id)).filter((u) => mem.some((m) => m.userId === u));
  }
  if (spec.kind === 'position') { const p = await db.prepare('SELECT holder_id FROM positions WHERE id = ? AND org_id = ?').get(Number(spec.id), orgId); return p && p.holder_id && mem.some((m) => m.userId === Number(p.holder_id)) ? [Number(p.holder_id)] : []; }
  return [];
}
/** Personnes habilitées pour un groupe d'approbateurs, en tenant compte des absences (intérim) et des délégations avec plafond. */
async function eligible(orgId, spec, step, req, mem, dels) {
  const base = await resolveSpec(orgId, spec, mem);
  const set = new Set(base);
  const amount = Number(req.amount || 0); const scopeOk = (d) => d.scopeKey === 'all' || d.scopeKey === req.kind;
  const ceilOk = (d) => !d.ceiling || amount <= d.ceiling;
  for (const u of base) {
    for (const d of dels.filter((x) => x.delegatorId === u && scopeOk(x) && ceilOk(x))) {
      set.add(d.delegateId);
      if (d.kind === 'interim') set.delete(u); // intérim : la personne est absente, son remplaçant décide à sa place
    }
  }
  if (step.deputy && base.length && ![...set].some((u) => !base.includes(u)) && ![...set].some((u) => base.includes(u))) set.add(Number(step.deputy.id)); // tous absents et sans remplaçant utile : le suppléant du circuit
  if (!set.size && step.deputy) set.add(Number(step.deputy.id));
  return [...set];
}
async function startStep(orgId, request, st, mem, dels) {
  const specs = L.jparse(st.groups, []);
  const requester = Number(request.requester_id);
  const groups = [];
  for (const g of specs) {
    let ids = await eligible(orgId, g.spec, { deputy: g.deputy }, request, mem, dels);
    const others = ids.filter((u) => u !== requester);
    if (others.length) ids = others;
    else { // on ne valide pas sa propre demande : à défaut, un dirigeant (autre que le demandeur) décide ; la personne seule ne le fait qu'en dernier recours
      const lead = mem.filter((m) => ['owner', 'admin'].includes(m.role) && m.userId !== requester).map((m) => m.userId);
      if (lead.length) ids = lead;
    }
    groups.push({ spec: g.spec, label: g.label, userIds: ids, approvedBy: null });
  }
  if (groups.every((g) => !g.userIds.length)) { // personne d'habilité : les dirigeants décident
    const fb = mem.filter((m) => ['owner', 'admin'].includes(m.role) && m.userId !== requester).map((m) => m.userId);
    const any = fb.length ? fb : mem.filter((m) => m.role === 'owner').map((m) => m.userId);
    groups[0].userIds = any;
  }
  const now = nowISO(); const delay = Number(st.delay_hours);
  const due = delay > 0 ? new Date(Date.now() + delay * 3600000).toISOString() : null;
  await db.prepare("UPDATE adm_request_steps SET status = 'active', groups = ?, started_at = ?, due_at = ? WHERE id = ?").run(JSON.stringify(groups), now, due, st.id);
  await db.prepare('UPDATE adm_requests SET current_step = ? WHERE id = ?').run(st.idx, request.id);
  for (const u of new Set(groups.flatMap((g) => g.userIds))) await W.push(orgId, u, 'administration', `À valider : ${request.title}${request.amount ? ' (' + request.amount + ')' : ''}`, 'request:' + request.id);
}
async function logAction(orgId, requestId, idx, userId, action, comment = '', via = '') {
  await db.prepare('INSERT INTO adm_request_actions (org_id, request_id, idx, user_id, action, comment, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(orgId, requestId, idx, userId, action, String(comment).slice(0, 500), via, nowISO());
}
/** Passe à l'étape suivante utile, ou conclut la demande. */
async function advance(orgId, requestId) {
  const r = await db.prepare('SELECT * FROM adm_requests WHERE id = ?').get(requestId);
  const next = await db.prepare("SELECT * FROM adm_request_steps WHERE request_id = ? AND status = 'queued' ORDER BY idx LIMIT 1").get(requestId);
  if (next) { await startStep(orgId, r, next, await L.members(orgId), await O.activeDelegations(orgId)); return 'pending'; }
  await db.prepare("UPDATE adm_requests SET status = 'approved', closed_at = ? WHERE id = ?").run(nowISO(), requestId);
  await W.push(orgId, Number(r.requester_id), 'administration', `Demande approuvée : ${r.title}`, 'request:' + requestId);
  return 'approved';
}

// ---------- Demandes ----------
async function pickFlow(req, b, kind, amount) {
  if (b.flowId) {
    const f = await db.prepare("SELECT * FROM adm_flows WHERE id = ? AND org_id = ? AND status = 'active'").get(A.id(b.flowId), req.org.id);
    if (!f) throw new HttpError(400, 'Circuit inconnu ou pas en service.');
    return f;
  }
  const rows = await db.prepare("SELECT * FROM adm_flows WHERE org_id = ? AND status = 'active' AND kind = ? ORDER BY min_amount DESC, id").all(req.org.id, kind);
  const f = rows.find((x) => amount >= Number(x.min_amount) && (!Number(x.max_amount) || amount <= Number(x.max_amount)));
  if (!f) throw new HttpError(400, 'Aucun circuit en service pour ce type de demande et ce montant : demandez au responsable d’en mettre un en service.');
  return f;
}
const reqView = (r, names, steps) => ({
  ...L.out(r, { requester: names.get(Number(r.requester_id)) || null, kindLabel: KIND_LABEL[r.kind] || r.kind, amount: Number(r.amount) }),
  ...(steps ? { steps: steps.map((s) => ({ idx: Number(s.idx), name: s.name, mode: s.mode, status: s.status, startedAt: s.started_at, dueAt: s.due_at, escalated: Boolean(Number(s.escalated)), doneAt: s.done_at, groups: L.jparse(s.groups, []).map((g) => ({ label: g.label, approvers: (g.userIds || []).map((u) => names.get(u) || '?'), approvedBy: g.approvedBy ? names.get(g.approvedBy) || '?' : null, escalation: Boolean(g.escalation) })) })) } : {}),
});
router.post('/requests', async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, KINDS, 'other', 'Type de demande inconnu.');
  const amount = L.money(b.amount);
  const title = A.text(b.title, 160, { required: true, msg: 'Indiquez l’objet de la demande.' });
  const flow = await pickFlow(req, b, b.flowId ? (await db.prepare('SELECT kind FROM adm_flows WHERE id = ?').get(A.id(b.flowId)) || {}).kind || kind : kind, amount);
  const steps = L.jparse(flow.steps, []);
  const now = nowISO();
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM adm_requests WHERE org_id = ?').get(req.org.id)).c) + 1;
  let id;
  await db.transaction(async () => {
    id = Number((await db.prepare("INSERT INTO adm_requests (org_id, ref, flow_id, flow_version, kind, title, detail, amount, requester_id, status, link_type, link_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
      .run(req.org.id, 'DEM-' + String(n).padStart(4, '0'), flow.id, flow.version, flow.kind === kind || b.flowId ? flow.kind : kind, title, A.text(b.detail, 3000), amount, req.user.id, A.text(b.linkType, 40), A.idOrNull(b.linkId), now)).lastInsertRowid);
    for (const [i, s] of steps.entries()) {
      const applies = amount >= Number(s.minAmount || 0) && (!Number(s.maxAmount) || amount <= Number(s.maxAmount));
      const groups = s.approvers.map((a) => ({ spec: a, deputy: s.deputy, label: a.kind === 'role' ? `Rôle : ${a.role}` : a.kind === 'user' ? 'Personne' : a.kind === 'edg' ? 'Direction générale' : 'Poste' }));
      await db.prepare('INSERT INTO adm_request_steps (org_id, request_id, idx, name, mode, groups, delay_hours, escalate_to, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.org.id, id, i, s.name, s.mode, JSON.stringify(groups), s.delayHours || 0, s.escalateTo ? JSON.stringify(s.escalateTo) : '', applies ? 'queued' : 'skipped');
    }
  })();
  await logAction(req.org.id, id, null, req.user.id, 'submit', title);
  const status = await advance(req.org.id, id);
  if (status === 'approved') await logAction(req.org.id, id, null, null, 'auto', 'Aucune étape ne s’applique à ce montant : approbation automatique');
  res.status(201).json({ id, ref: 'DEM-' + String(n).padStart(4, '0'), status });
});

async function canSee(req, r) {
  req.admCfg = req.admCfg || await L.getConfig(req.org.id);
  if (Number(r.requester_id) === req.user.id || A.can(req, 'admin') || L.allowed(req, req.admCfg, 'flow_validate') || L.allowed(req, req.admCfg, 'flow_design')) return true;
  const steps = await db.prepare('SELECT groups FROM adm_request_steps WHERE request_id = ?').all(r.id);
  return steps.some((s) => L.jparse(s.groups, []).some((g) => (g.userIds || []).includes(req.user.id)));
}
router.get('/requests', async (req, res) => {
  await sweep(req.org.id);
  const names = await L.nameMap(req.org.id);
  const where = ['org_id = ?']; const args = [req.org.id];
  if (req.query.status && ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
  if (req.query.kind && KINDS.includes(req.query.kind)) { where.push('kind = ?'); args.push(req.query.kind); }
  if (req.query.mine === '1') { where.push('requester_id = ?'); args.push(req.user.id); }
  const rows = await db.prepare(`SELECT * FROM adm_requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`).all(...args);
  const out = [];
  for (const r of rows) if (await canSee(req, r)) out.push(reqView(r, names));
  res.json({ requests: out });
});
router.get('/requests/:id', async (req, res) => {
  await sweep(req.org.id);
  const r = await db.prepare('SELECT * FROM adm_requests WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r || !await canSee(req, r)) throw new HttpError(404, 'Demande introuvable.');
  const names = await L.nameMap(req.org.id);
  const steps = await db.prepare('SELECT * FROM adm_request_steps WHERE request_id = ? ORDER BY idx').all(r.id);
  const acts = await db.prepare('SELECT * FROM adm_request_actions WHERE request_id = ? ORDER BY id').all(r.id);
  const flow = r.flow_id ? await db.prepare('SELECT name FROM adm_flows WHERE id = ?').get(r.flow_id) : null;
  res.json({ request: { ...reqView(r, names, steps), flowName: flow ? flow.name : null }, actions: acts.map((a) => ({ idx: a.idx == null ? null : Number(a.idx), user: names.get(Number(a.user_id)) || null, action: a.action, comment: a.comment, via: a.via, at: a.created_at })) });
});

async function activeStep(requestId) { return db.prepare("SELECT * FROM adm_request_steps WHERE request_id = ? AND status = 'active'").get(requestId); }
async function loadPending(req) {
  const r = await db.prepare('SELECT * FROM adm_requests WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r || !await canSee(req, r)) throw new HttpError(404, 'Demande introuvable.');
  if (r.status !== 'pending') throw new HttpError(409, 'Cette demande est déjà clôturée.');
  const st = await activeStep(r.id);
  if (!st) throw new HttpError(409, 'Aucune étape en cours.');
  return { r, st, groups: L.jparse(st.groups, []) };
}
router.post('/requests/:id/approve', async (req, res) => {
  await sweep(req.org.id);
  const { r, st, groups } = await loadPending(req);
  const mine = groups.filter((g) => g.userIds.includes(req.user.id) && !g.approvedBy);
  if (!mine.length) throw new HttpError(403, groups.some((g) => g.approvedBy === req.user.id) ? 'Vous avez déjà approuvé cette étape.' : 'Vous n’êtes pas approbateur de cette étape.');
  if (Number(r.requester_id) === req.user.id && groups.some((g) => g.userIds.some((u) => u !== req.user.id))) throw new HttpError(403, 'Vous ne pouvez pas approuver votre propre demande.');
  const esc = mine.some((g) => g.escalation);
  for (const g of esc ? groups.filter((x) => !x.approvedBy) : mine) g.approvedBy = req.user.id; // l'escalade vaut pour tous les groupes restants
  const real = groups.filter((g) => !g.escalation);
  const done = esc || (st.mode === 'all' ? real.every((g) => g.approvedBy) : real.some((g) => g.approvedBy));
  const comment = A.text((req.body || {}).comment, 500);
  await logAction(req.org.id, r.id, st.idx, req.user.id, 'approve', comment, esc ? 'escalade' : '');
  let status = 'pending';
  if (done) {
    await db.prepare("UPDATE adm_request_steps SET status = 'done', done_at = ?, groups = ? WHERE id = ?").run(nowISO(), JSON.stringify(groups), st.id);
    status = await advance(req.org.id, r.id);
  } else await db.prepare('UPDATE adm_request_steps SET groups = ? WHERE id = ?').run(JSON.stringify(groups), st.id);
  res.json({ ok: true, status, stepDone: done });
});
router.post('/requests/:id/reject', async (req, res) => {
  await sweep(req.org.id);
  const { r, st, groups } = await loadPending(req);
  if (!groups.some((g) => g.userIds.includes(req.user.id))) throw new HttpError(403, 'Vous n’êtes pas approbateur de cette étape.');
  const comment = A.text((req.body || {}).comment, 500, { required: true, msg: 'Indiquez le motif du refus.' });
  await db.transaction(async () => {
    await db.prepare("UPDATE adm_request_steps SET status = 'done', done_at = ? WHERE id = ?").run(nowISO(), st.id);
    await db.prepare("UPDATE adm_requests SET status = 'rejected', closed_at = ? WHERE id = ?").run(nowISO(), r.id);
  })();
  await logAction(req.org.id, r.id, st.idx, req.user.id, 'reject', comment);
  await W.push(req.org.id, Number(r.requester_id), 'administration', `Demande refusée : ${r.title} — ${comment}`, 'request:' + r.id);
  res.json({ ok: true, status: 'rejected' });
});
router.post('/requests/:id/comment', async (req, res) => {
  const r = await db.prepare('SELECT * FROM adm_requests WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r || !await canSee(req, r)) throw new HttpError(404, 'Demande introuvable.');
  await logAction(req.org.id, r.id, r.current_step, req.user.id, 'comment', A.text((req.body || {}).comment, 500, { required: true, msg: 'Écrivez un commentaire.' }));
  res.json({ ok: true });
});
router.post('/requests/:id/cancel', async (req, res) => {
  const { r } = await loadPending(req);
  if (Number(r.requester_id) !== req.user.id && !A.can(req, 'admin')) throw new HttpError(403, 'Seul le demandeur (ou un administrateur) peut annuler.');
  await db.prepare("UPDATE adm_requests SET status = 'cancelled', closed_at = ? WHERE id = ?").run(nowISO(), r.id);
  await db.prepare("UPDATE adm_request_steps SET status = 'skipped' WHERE request_id = ? AND status IN ('active','queued')").run(r.id);
  await logAction(req.org.id, r.id, null, req.user.id, 'cancel', A.text((req.body || {}).comment, 300));
  res.json({ ok: true });
});

// ---------- Boîte « à valider » ----------
router.get('/inbox', async (req, res) => {
  await sweep(req.org.id);
  const names = await L.nameMap(req.org.id);
  const rows = await db.prepare("SELECT s.*, r.title, r.ref, r.kind, r.amount, r.requester_id, r.created_at AS req_at, r.id AS rid FROM adm_request_steps s JOIN adm_requests r ON r.id = s.request_id WHERE s.org_id = ? AND s.status = 'active' AND r.status = 'pending' ORDER BY s.due_at, s.id").all(req.org.id);
  const now = nowISO(); const items = [];
  for (const s of rows) {
    const groups = L.jparse(s.groups, []);
    if (!groups.some((g) => g.userIds.includes(req.user.id) && !g.approvedBy)) continue;
    items.push({ requestId: Number(s.rid), ref: s.ref, title: s.title, kind: s.kind, kindLabel: KIND_LABEL[s.kind] || s.kind, amount: Number(s.amount), requester: names.get(Number(s.requester_id)) || null, step: s.name, stepIdx: Number(s.idx), startedAt: s.started_at, dueAt: s.due_at, overdue: Boolean(s.due_at && s.due_at < now), escalated: Boolean(Number(s.escalated)), createdAt: s.req_at, escalation: groups.some((g) => g.escalation && g.userIds.includes(req.user.id)) });
  }
  res.json({ items, count: items.length, overdue: items.filter((i) => i.overdue).length });
});

// ---------- Escalade automatique ----------
/** Étapes en retard : les personnes d'escalade (ou, à défaut, les dirigeants) peuvent trancher. Une fois par étape. */
async function sweep(orgId) {
  const now = nowISO();
  const late = await db.prepare("SELECT s.*, r.title, r.requester_id, r.id AS rid FROM adm_request_steps s JOIN adm_requests r ON r.id = s.request_id WHERE s.org_id = ? AND s.status = 'active' AND s.escalated = 0 AND s.due_at IS NOT NULL AND s.due_at < ? AND r.status = 'pending'").all(orgId, now);
  if (!late.length) return 0;
  const mem = await L.members(orgId);
  let n = 0;
  for (const s of late) {
    const spec = L.jparse(s.escalate_to, null);
    let ids = spec ? await resolveSpec(orgId, spec, mem) : [];
    if (!ids.length) ids = mem.filter((m) => ['owner', 'admin'].includes(m.role)).map((m) => m.userId);
    const groups = L.jparse(s.groups, []);
    const pending = new Set(groups.filter((g) => !g.approvedBy).flatMap((g) => g.userIds));
    ids = ids.filter((u) => u !== Number(s.requester_id) || ids.length === 1);
    groups.push({ spec: { kind: 'escalation' }, label: 'Escalade', userIds: ids, approvedBy: null, escalation: true });
    const delay = Number(s.delay_hours);
    const res = await db.prepare('UPDATE adm_request_steps SET groups = ?, escalated = 1, due_at = ? WHERE id = ? AND escalated = 0').run(JSON.stringify(groups), delay > 0 ? new Date(Date.now() + delay * 3600000).toISOString() : null, s.id);
    if (!res.changes) continue;
    await logAction(orgId, s.rid, s.idx, null, 'escalate', `Délai dépassé à l’étape « ${s.name} »`, ids.map((u) => (mem.find((m) => m.userId === u) || {}).name).join(', '));
    for (const u of ids) await W.push(orgId, u, 'administration', `Escalade : « ${s.title} » attend depuis trop longtemps (${s.name})`, 'request:' + s.rid);
    for (const u of pending) await W.push(orgId, u, 'administration', `Rappel : « ${s.title} » est en retard à l’étape ${s.name}`, 'request:' + s.rid);
    await W.push(orgId, Number(s.requester_id), 'administration', `Votre demande « ${s.title} » a été escaladée (retard)`, 'request:' + s.rid);
    n++;
  }
  return n;
}
router.post('/sweep', async (req, res) => res.json({ escalated: await sweep(req.org.id) }));

// ---------- Aperçu d'un circuit (qui valide, à partir de quel montant) ----------
router.get('/flows/:id/simulate', async (req, res) => {
  const f = await loadFlow(req);
  const amount = L.money(req.query.amount);
  const mem = await L.members(req.org.id); const dels = await O.activeDelegations(req.org.id);
  const names = new Map(mem.map((m) => [m.userId, m.name]));
  const out = [];
  for (const [i, s] of L.jparse(f.steps, []).entries()) {
    const applies = amount >= Number(s.minAmount || 0) && (!Number(s.maxAmount) || amount <= Number(s.maxAmount));
    const groups = [];
    for (const a of s.approvers) groups.push({ spec: a, approvers: (await eligible(req.org.id, a, s, { amount, kind: f.kind }, mem, dels)).map((u) => names.get(u)) });
    out.push({ idx: i, name: s.name, mode: s.mode, applies, delayHours: s.delayHours, groups });
  }
  res.json({ amount, steps: out });
});

// ---------- Indicateurs ----------
async function stats(orgId) {
  const rows = await db.prepare('SELECT * FROM adm_requests WHERE org_id = ?').all(orgId);
  const steps = await db.prepare('SELECT * FROM adm_request_steps WHERE org_id = ?').all(orgId);
  const now = nowISO();
  const closed = rows.filter((r) => r.closed_at && ['approved', 'rejected'].includes(r.status));
  const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : 0);
  const kinds = {};
  for (const r of rows) { const k = kinds[r.kind] || (kinds[r.kind] = { kind: r.kind, label: KIND_LABEL[r.kind] || r.kind, total: 0, pending: 0, approved: 0, rejected: 0, hours: [] }); k.total++; k[r.status] = (k[r.status] || 0) + 1; if (r.closed_at && r.status !== 'cancelled') k.hours.push(hours(r.created_at, r.closed_at)); }
  const stepDur = steps.filter((s) => s.done_at && s.started_at).map((s) => hours(s.started_at, s.done_at));
  const months = {};
  for (const r of rows) { const m = r.created_at.slice(0, 7); const x = months[m] || (months[m] = { month: m, created: 0, approved: 0, rejected: 0 }); x.created++; if (r.status === 'approved') x.approved++; if (r.status === 'rejected') x.rejected++; }
  const overdueNow = steps.filter((s) => s.status === 'active' && s.due_at && s.due_at < now).length;
  return {
    total: rows.length, pending: rows.filter((r) => r.status === 'pending').length, approved: rows.filter((r) => r.status === 'approved').length, rejected: rows.filter((r) => r.status === 'rejected').length, cancelled: rows.filter((r) => r.status === 'cancelled').length,
    approvalRate: closed.length ? Math.round((closed.filter((r) => r.status === 'approved').length / closed.length) * 100) : null,
    avgCycleHours: avg(closed.map((r) => hours(r.created_at, r.closed_at))), avgStepHours: avg(stepDur),
    overdue: overdueNow, escalatedTotal: steps.filter((s) => Number(s.escalated)).length,
    byKind: Object.values(kinds).map((k) => ({ kind: k.kind, label: k.label, total: k.total, pending: k.pending || 0, approved: k.approved || 0, rejected: k.rejected || 0, avgHours: avg(k.hours) })),
    byMonth: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).slice(-6),
  };
}
router.get('/stats', async (req, res) => { await sweep(req.org.id); res.json(await stats(req.org.id)); });

/** Gestionnaires des demandes (création, approbation, refus), réutilisés par les cockpits de direction : un SEUL moteur de validation, pas de moteur parallèle. */
const handlerOf = (method, path) => router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]).route.stack.slice(-1)[0].handle;
const handlers = { create: handlerOf('post', '/requests'), approve: handlerOf('post', '/requests/:id/approve'), reject: handlerOf('post', '/requests/:id/reject') };

module.exports = { router, sweep, stats, resolveSpec, KINDS, handlers };
