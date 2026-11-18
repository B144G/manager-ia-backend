'use strict';
// Pipeline commercial : étapes paramétrables (probabilité, règle de passage BANT, délai de stagnation), opportunités, vue kanban,
// valeur pondérée, durée dans chaque étape, opportunités stagnantes, motifs de gain et de perte, entonnoir de conversion.
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const W = require('../w3');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const { HttpError, oneLine } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

const stageView = (s) => ({ id: Number(s.id), name: s.name, position: N(s.position), probability: N(s.probability), kind: s.kind, minBant: N(s.min_bant), stagnantDays: N(s.stagnant_days) });
const stagesOf = async (orgId) => { await B.ensureDefaults(orgId); return (await db.prepare('SELECT * FROM cp_stages WHERE org_id = ? ORDER BY position, id').all(orgId)).map(stageView); };
const oppProb = (o, st) => (o.probability === null || o.probability === undefined ? st.probability : N(o.probability));
const daysIn = (o) => Math.max(0, L.daysBetween(o.stage_entered_at, o.closed_at || B.today()));

function oppView(o, st, names, extra = {}) {
  const prob = oppProb(o, st);
  const days = daysIn(o);
  return {
    id: Number(o.id), name: o.name, customerId: o.customer_id ? Number(o.customer_id) : null, customer: o.customer || '', leadId: o.lead_id ? Number(o.lead_id) : null, ownerId: o.owner_id ? Number(o.owner_id) : null, owner: names ? names.get(Number(o.owner_id)) || '' : undefined,
    stageId: Number(o.stage_id), stage: st.name, stageKind: st.kind, amount: N(o.amount), probability: prob, probabilityOverride: o.probability !== null && o.probability !== undefined, weighted: L.weighted(o.amount, prob),
    closeDate: o.close_date, product: o.product, zoneId: o.zone_id ? Number(o.zone_id) : null, source: o.source, status: o.status, reasonId: o.reason_id ? Number(o.reason_id) : null, reasonText: o.reason_text,
    bantScore: N(o.bant_score), nextStep: o.next_step, daysInStage: days, stagnant: o.status === 'open' && st.stagnantDays > 0 && days > st.stagnantDays, stagnantDays: st.stagnantDays,
    createdAt: o.created_at, closedAt: o.closed_at, ...extra,
  };
}
async function oppOf(req, id) {
  const o = await db.prepare('SELECT * FROM cp_opps WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!o) throw new HttpError(404, 'Opportunité introuvable.');
  await P.mustOwn(req, o);
  return o;
}

async function createOpp(req, o) {
  const stages = await stagesOf(req.org.id);
  const first = stages.find((s) => s.kind === 'open');
  const stage = o.stageId ? stages.find((s) => s.id === Number(o.stageId) && s.kind === 'open') : first;
  if (!stage) throw new HttpError(400, 'Étape inconnue ou terminale : une opportunité naît dans une étape ouverte.');
  const cp = await P.load(req);
  const owner = cp.scopeOwn ? req.user.id : o.ownerId ? await A.memberOf(req, o.ownerId) : req.user.id;
  let customerId = null;
  if (o.customerId) { const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(o.customerId), req.org.id); if (!c || !A.visible(req, c)) throw new HttpError(404, 'Compte introuvable.'); customerId = Number(c.id); }
  const amount = o.amount === undefined || o.amount === '' || Number(o.amount) === 0 ? 0 : A.amount(o.amount);
  const prob = o.probability === undefined || o.probability === null || o.probability === '' ? null : Math.min(Math.max(Number(o.probability), 0), 100);
  if (prob !== null && !Number.isFinite(prob)) throw new HttpError(400, 'Probabilité invalide (0 à 100).');
  const zone = o.zoneId ? A.id(o.zoneId) : null;
  const now = nowISO();
  const id = (await db.prepare('INSERT INTO cp_opps (org_id, name, customer_id, lead_id, owner_id, stage_id, amount, probability, close_date, product, zone_id, source, bant, bant_score, next_step, stage_entered_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, A.text(o.name, 120, { required: true, msg: "Nommez l'opportunité." }), customerId, o.leadId || null, owner, stage.id, amount, prob, A.date(o.closeDate), A.text(o.product, 120), zone, A.text(o.source, 40), JSON.stringify(o.bant || {}), N(o.bantScore), A.text(o.nextStep, 200), now, req.user.id, now, now)).lastInsertRowid;
  await db.prepare('INSERT INTO cp_stage_history (org_id, opp_id, from_stage_id, to_stage_id, user_id, entered_at) VALUES (?, ?, NULL, ?, ?, ?)').run(req.org.id, id, stage.id, req.user.id, now);
  await P.audit(req, 'opportunity', id, 'create', `${A.text(o.name, 120)} (${amount})`);
  return Number(id);
}

/** Déplace une opportunité. Les règles de passage (score BANT minimal) sont appliquées ICI, jamais seulement à l'écran. */
async function moveOpp(req, o, stage, { overrideReason, reasonId, reasonText, note } = {}) {
  if (o.status !== 'open') throw new HttpError(409, 'Cette opportunité est clôturée : rouvrez-la pour la déplacer.');
  if (Number(o.stage_id) === stage.id) return;
  const now = nowISO();
  let reason = null; let reasonLabel = '';
  if (stage.kind === 'open' && stage.minBant > N(o.bant_score)) {
    const may = await P.has(req, 'approve');
    if (!(may && overrideReason)) throw Object.assign(new HttpError(422, `Score BANT de ${N(o.bant_score)}/100 : l'étape « ${stage.name} » exige ${stage.minBant}. Qualifiez le budget, l'autorité, le besoin et le délai${may ? ', ou passez outre avec un motif' : ''}.`), { code: 'bant_required' });
    await P.audit(req, 'opportunity', o.id, 'bant_override', { stage: stage.name, bant: N(o.bant_score), min: stage.minBant, reason: overrideReason });
  }
  if (stage.kind === 'lost') {
    if (reasonId) { reason = await db.prepare("SELECT * FROM cp_reasons WHERE id = ? AND org_id = ? AND kind = 'loss'").get(A.id(reasonId), req.org.id); if (!reason) throw new HttpError(400, 'Motif de perte inconnu.'); reasonLabel = reason.label; }
    if (!reasonLabel && !A.text(reasonText, 200)) throw new HttpError(400, 'Indiquez le motif de la perte.');
  }
  if (stage.kind === 'won') {
    if (N(o.amount) <= 0) throw new HttpError(400, "Indiquez le montant de l'affaire avant de la déclarer gagnée.");
    if (reasonId) { reason = await db.prepare("SELECT * FROM cp_reasons WHERE id = ? AND org_id = ? AND kind = 'win'").get(A.id(reasonId), req.org.id); if (!reason) throw new HttpError(400, 'Motif de gain inconnu.'); reasonLabel = reason.label; }
  }
  const closed = stage.kind !== 'open';
  await db.transaction(async () => {
    await db.prepare('UPDATE cp_opps SET stage_id = ?, stage_entered_at = ?, status = ?, reason_id = ?, reason_text = ?, closed_at = ?, updated_at = ? WHERE id = ?')
      .run(stage.id, now, closed ? stage.kind : 'open', reason ? reason.id : null, closed ? (A.text(reasonText, 200) || reasonLabel) : '', closed ? now : null, now, o.id);
    await db.prepare('INSERT INTO cp_stage_history (org_id, opp_id, from_stage_id, to_stage_id, user_id, note, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, o.id, o.stage_id, stage.id, req.user.id, A.text(note || overrideReason, 200), now);
    if (stage.kind === 'won' && o.customer_id) await db.prepare("UPDATE customers SET stage = 'client' WHERE id = ?").run(o.customer_id);
  })();
  await P.audit(req, 'opportunity', o.id, 'move', { to: stage.name });
  if (closed && o.owner_id && Number(o.owner_id) !== req.user.id) await W.push(req.org.id, Number(o.owner_id), 'commercial', `Opportunité « ${o.name} » : ${stage.kind === 'won' ? 'gagnée' : 'perdue'}.`, 'opp:' + o.id);
}

// ---------- Étapes ----------
router.get('/pipeline/stages', P.need('view'), async (req, res) => res.json({ stages: await stagesOf(req.org.id) }));
const cleanStage = (b, cur = {}) => {
  const kind = b.kind === undefined ? cur.kind || 'open' : A.oneOf(b.kind, ['open', 'won', 'lost'], undefined, 'Type d’étape inconnu.');
  const prob = kind === 'won' ? 100 : kind === 'lost' ? 0 : b.probability === undefined ? N(cur.probability) : Number(b.probability);
  if (!Number.isFinite(prob) || prob < 0 || prob > 100) throw new HttpError(400, 'La probabilité va de 0 à 100 %.');
  const minBant = b.minBant === undefined ? N(cur.min_bant) : Math.round(Number(b.minBant));
  const stag = b.stagnantDays === undefined ? N(cur.stagnant_days) : Math.round(Number(b.stagnantDays));
  if (!(minBant >= 0 && minBant <= 100)) throw new HttpError(400, 'Le score BANT exigé va de 0 à 100.');
  if (!(stag >= 0 && stag <= 365)) throw new HttpError(400, 'Le délai de stagnation va de 0 à 365 jours.');
  return { name: b.name === undefined ? cur.name : A.text(b.name, 60, { required: true, msg: "Nommez l'étape." }), kind, probability: prob, min_bant: kind === 'open' ? minBant : 0, stagnant_days: kind === 'open' ? stag : 0 };
};
router.post('/pipeline/stages', P.need('rules'), async (req, res) => {
  const stages = await stagesOf(req.org.id);
  const c = cleanStage(req.body || {});
  if (stages.some((s) => s.name.toLowerCase() === c.name.toLowerCase())) throw new HttpError(409, 'Une étape porte déjà ce nom.');
  const firstTerminal = stages.find((s) => s.kind !== 'open');
  const pos = firstTerminal ? firstTerminal.position : stages.length;
  const id = await db.transaction(async () => {
    if (c.kind === 'open') await db.prepare('UPDATE cp_stages SET position = position + 1 WHERE org_id = ? AND position >= ?').run(req.org.id, pos);
    return (await db.prepare('INSERT INTO cp_stages (org_id, name, position, probability, kind, min_bant, stagnant_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, c.name, c.kind === 'open' ? pos : stages.length + 1, c.probability, c.kind, c.min_bant, c.stagnant_days, nowISO())).lastInsertRowid;
  })();
  await P.audit(req, 'stage', id, 'create', c.name);
  res.status(201).json({ id: Number(id) });
});
router.put('/pipeline/stages/:id', P.need('rules'), async (req, res) => {
  const s = await db.prepare('SELECT * FROM cp_stages WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Étape introuvable.');
  const c = cleanStage(req.body || {}, s);
  if (c.kind !== s.kind) {
    if (N((await db.prepare('SELECT COUNT(*) c FROM cp_opps WHERE stage_id = ?').get(s.id)).c)) throw new HttpError(409, "Cette étape contient des opportunités : on ne change pas son type.");
    const others = (await stagesOf(req.org.id)).filter((x) => x.id !== Number(s.id));
    if (s.kind !== 'open' && !others.some((x) => x.kind === s.kind)) throw new HttpError(409, 'Il faut garder au moins une étape « gagné » et une étape « perdu ».');
  }
  await db.prepare('UPDATE cp_stages SET name = ?, kind = ?, probability = ?, min_bant = ?, stagnant_days = ? WHERE id = ?').run(c.name, c.kind, c.probability, c.min_bant, c.stagnant_days, s.id);
  await P.audit(req, 'stage', s.id, 'update', { before: stageView(s), after: c });
  res.json({ ok: true });
});
router.put('/pipeline/stages-order', P.need('rules'), async (req, res) => {
  const stages = await stagesOf(req.org.id);
  const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(Number);
  if (ids.length !== stages.length || new Set(ids).size !== ids.length || !stages.every((s) => ids.includes(s.id))) throw new HttpError(400, 'La liste doit contenir toutes les étapes, une fois chacune.');
  await db.transaction(async () => { for (let i = 0; i < ids.length; i++) await db.prepare('UPDATE cp_stages SET position = ? WHERE id = ? AND org_id = ?').run(i, ids[i], req.org.id); })();
  await P.audit(req, 'stage', null, 'reorder', ids.join(','));
  res.json({ ok: true });
});
router.delete('/pipeline/stages/:id', P.need('rules'), async (req, res) => {
  const stages = await stagesOf(req.org.id);
  const s = stages.find((x) => x.id === Number(req.params.id));
  if (!s) throw new HttpError(404, 'Étape introuvable.');
  if (N((await db.prepare('SELECT COUNT(*) c FROM cp_opps WHERE stage_id = ?').get(s.id)).c)) throw new HttpError(409, 'Cette étape contient des opportunités : déplacez-les d’abord.');
  if (s.kind !== 'open' && stages.filter((x) => x.kind === s.kind).length < 2) throw new HttpError(409, 'Il faut garder au moins une étape « gagné » et une étape « perdu ».');
  await db.prepare('DELETE FROM cp_stage_history WHERE to_stage_id = ? OR from_stage_id = ?').run(s.id, s.id);
  await db.prepare('DELETE FROM cp_stages WHERE id = ?').run(s.id);
  await P.audit(req, 'stage', s.id, 'delete', s.name);
  res.json({ ok: true });
});
router.get('/pipeline/reasons', P.need('view'), async (req, res) => { await B.ensureDefaults(req.org.id); res.json({ reasons: (await db.prepare('SELECT * FROM cp_reasons WHERE org_id = ? ORDER BY kind, id').all(req.org.id)).map((r) => ({ id: Number(r.id), kind: r.kind, label: r.label })) }); });
router.post('/pipeline/reasons', P.need('rules'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO cp_reasons (org_id, kind, label, created_at) VALUES (?, ?, ?, ?)').run(req.org.id, A.oneOf(b.kind, ['win', 'loss'], undefined, 'Type de motif inconnu (gain ou perte).'), A.text(b.label, 80, { required: true, msg: 'Écrivez le motif.' }), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.delete('/pipeline/reasons/:id', P.need('rules'), async (req, res) => {
  const x = await db.prepare('DELETE FROM cp_reasons WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!x.changes) throw new HttpError(404, 'Motif introuvable.');
  res.json({ ok: true });
});

// ---------- Opportunités ----------
const OPP_SQL = 'SELECT o.*, c.name AS customer FROM cp_opps o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.org_id = ?';
async function filteredOpps(req) {
  const ow = await P.own(req, 'o.owner_id');
  let rows = await db.prepare(`${OPP_SQL}${ow.sql} ORDER BY o.id DESC`).all(req.org.id, ...ow.args);
  const q = req.query;
  if (q.ownerId) rows = rows.filter((o) => Number(o.owner_id) === Number(q.ownerId));
  if (q.zoneId) rows = rows.filter((o) => Number(o.zone_id) === Number(q.zoneId));
  if (q.product) rows = rows.filter((o) => L.normName(o.product).includes(L.normName(q.product)));
  if (q.customerId) rows = rows.filter((o) => Number(o.customer_id) === Number(q.customerId));
  return rows;
}
router.get('/opps', P.need('view'), async (req, res) => {
  const stages = await stagesOf(req.org.id); const sm = new Map(stages.map((s) => [s.id, s])); const names = await B.names(req.org.id);
  let rows = await filteredOpps(req);
  if (req.query.status) rows = rows.filter((o) => o.status === req.query.status);
  res.json({ opportunities: rows.slice(0, B.pageLimit(req.query.limit, 200, 500)).map((o) => oppView(o, sm.get(Number(o.stage_id)), names)), total: rows.length });
});
router.post('/opps', P.need('write'), async (req, res) => res.status(201).json({ id: await createOpp(req, req.body || {}) }));

router.get('/opps/:id', P.need('view'), async (req, res) => {
  const o = await oppOf(req, req.params.id);
  const stages = await stagesOf(req.org.id); const sm = new Map(stages.map((s) => [s.id, s])); const names = await B.names(req.org.id);
  const cu = o.customer_id ? await db.prepare('SELECT name FROM customers WHERE id = ?').get(o.customer_id) : null;
  const hist = await db.prepare('SELECT * FROM cp_stage_history WHERE opp_id = ? ORDER BY id').all(o.id);
  const history = hist.map((h, i) => { const end = hist[i + 1] ? hist[i + 1].entered_at : (o.closed_at || nowISO()); return { stage: (sm.get(Number(h.to_stage_id)) || {}).name || '', stageId: Number(h.to_stage_id), at: h.entered_at, days: Math.max(0, L.daysBetween(h.entered_at, end)), by: names.get(Number(h.user_id)) || '', note: h.note }; });
  const tasks = await db.prepare("SELECT * FROM cp_tasks WHERE opp_id = ? ORDER BY id DESC LIMIT 20").all(o.id);
  const acts = await db.prepare('SELECT * FROM cp_activities WHERE opp_id = ? ORDER BY happened_at DESC LIMIT 20').all(o.id);
  res.json({
    opportunity: oppView({ ...o, customer: cu && cu.name }, sm.get(Number(o.stage_id)), names, { bant: parse(o.bant) }), history,
    tasks: tasks.map((t) => require('./crm360').taskView(t, names)), activities: acts.map((a) => ({ id: Number(a.id), kind: a.kind, outcome: a.outcome, note: a.note, at: a.happened_at, by: names.get(Number(a.user_id)) || '' })),
  });
});
router.put('/opps/:id', P.need('write'), async (req, res) => {
  const o = await oppOf(req, req.params.id);
  if (o.status !== 'open') throw new HttpError(409, 'Cette opportunité est clôturée.');
  const b = req.body || {};
  let owner = o.owner_id;
  if (b.ownerId !== undefined && Number(b.ownerId || 0) !== Number(o.owner_id || 0)) {
    if (!(await P.has(req, 'rules'))) throw new HttpError(403, 'Seul le responsable commercial réattribue une opportunité.');
    owner = b.ownerId ? await A.memberOf(req, b.ownerId) : null;
    await P.audit(req, 'opportunity', o.id, 'reassign', { from: o.owner_id, to: owner });
  }
  const prob = b.probability === undefined ? o.probability : b.probability === null || b.probability === '' ? null : Math.min(Math.max(Number(b.probability), 0), 100);
  if (prob !== null && !Number.isFinite(Number(prob))) throw new HttpError(400, 'Probabilité invalide (0 à 100).');
  if (b.probability !== undefined && !(await P.has(req, 'approve')) && prob !== null) { const st = (await stagesOf(req.org.id)).find((s) => s.id === Number(o.stage_id)); if (Math.abs(prob - st.probability) > 20) throw new HttpError(403, "Seul le responsable commercial s'écarte de plus de 20 points de la probabilité de l'étape."); }
  await db.prepare('UPDATE cp_opps SET name = ?, owner_id = ?, amount = ?, probability = ?, close_date = ?, product = ?, zone_id = ?, source = ?, next_step = ?, updated_at = ? WHERE id = ?')
    .run(A.text(b.name, 120) || o.name, owner, b.amount === undefined ? o.amount : Number(b.amount) === 0 ? 0 : A.amount(b.amount), prob, b.closeDate === undefined ? o.close_date : A.date(b.closeDate), b.product === undefined ? o.product : A.text(b.product, 120), b.zoneId === undefined ? o.zone_id : b.zoneId ? A.id(b.zoneId) : null, b.source === undefined ? o.source : A.text(b.source, 40), b.nextStep === undefined ? o.next_step : A.text(b.nextStep, 200), nowISO(), o.id);
  res.json({ ok: true });
});
router.post('/opps/:id/move', P.need('write'), async (req, res) => {
  const o = await oppOf(req, req.params.id);
  const b = req.body || {};
  const stage = (await stagesOf(req.org.id)).find((s) => s.id === Number(b.stageId));
  if (!stage) throw new HttpError(404, 'Étape introuvable.');
  try { await moveOpp(req, o, stage, b); } catch (e) { if (e.code) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
  res.json({ ok: true });
});
router.post('/opps/:id/reopen', P.need('approve'), async (req, res) => {
  const o = await oppOf(req, req.params.id);
  if (o.status === 'open') throw new HttpError(409, 'Cette opportunité est déjà ouverte.');
  const stages = await stagesOf(req.org.id);
  const stage = req.body && req.body.stageId ? stages.find((s) => s.id === Number(req.body.stageId) && s.kind === 'open') : stages.find((s) => s.kind === 'open');
  if (!stage) throw new HttpError(400, 'Étape ouverte inconnue.');
  const now = nowISO();
  await db.prepare("UPDATE cp_opps SET stage_id = ?, stage_entered_at = ?, status = 'open', reason_id = NULL, reason_text = '', closed_at = NULL, updated_at = ? WHERE id = ?").run(stage.id, now, now, o.id);
  await db.prepare('INSERT INTO cp_stage_history (org_id, opp_id, from_stage_id, to_stage_id, user_id, note, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, o.id, o.stage_id, stage.id, req.user.id, 'réouverture', now);
  await P.audit(req, 'opportunity', o.id, 'reopen', stage.name);
  res.json({ ok: true });
});
router.delete('/opps/:id', P.need('delete'), async (req, res) => {
  const x = await db.prepare('DELETE FROM cp_opps WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!x.changes) throw new HttpError(404, 'Opportunité introuvable.');
  await P.audit(req, 'opportunity', req.params.id, 'delete', '');
  res.json({ ok: true });
});

// ---------- Kanban, stagnation, entonnoir ----------
router.get('/pipeline/board', P.need('view'), async (req, res) => {
  const stages = await stagesOf(req.org.id); const sm = new Map(stages.map((s) => [s.id, s])); const names = await B.names(req.org.id);
  const rows = await filteredOpps(req);
  const since = L.addDays(B.today(), -30);
  const cols = stages.map((s) => {
    let list = rows.filter((o) => Number(o.stage_id) === s.id);
    if (s.kind !== 'open') list = list.filter((o) => (o.closed_at || '').slice(0, 10) >= since);
    const cards = list.map((o) => oppView(o, sm.get(Number(o.stage_id)), names));
    return { stage: s, count: cards.length, amount: cards.reduce((a, c) => a + c.amount, 0), weighted: cards.reduce((a, c) => a + c.weighted, 0), cards };
  });
  const open = cols.filter((c) => c.stage.kind === 'open');
  res.json({ columns: cols, totals: { count: open.reduce((a, c) => a + c.count, 0), amount: open.reduce((a, c) => a + c.amount, 0), weighted: open.reduce((a, c) => a + c.weighted, 0), stagnant: open.reduce((a, c) => a + c.cards.filter((x) => x.stagnant).length, 0) } });
});
router.get('/pipeline/stagnant', P.need('view'), async (req, res) => {
  const stages = await stagesOf(req.org.id); const sm = new Map(stages.map((s) => [s.id, s])); const names = await B.names(req.org.id);
  const list = (await filteredOpps(req)).filter((o) => o.status === 'open').map((o) => oppView(o, sm.get(Number(o.stage_id)), names)).filter((o) => o.stagnant).sort((a, b) => b.daysInStage - a.daysInStage);
  res.json({ opportunities: list, count: list.length, amount: list.reduce((a, o) => a + o.amount, 0) });
});
router.get('/pipeline/funnel', P.need('view'), async (req, res) => {
  const { from, to } = B.range({ ...req.query, from: req.query.from || L.addDays(B.today(), -365) });
  const stages = await stagesOf(req.org.id); const sm = new Map(stages.map((s) => [s.id, s]));
  const rows = (await filteredOpps(req)).filter((o) => o.created_at.slice(0, 10) >= from && o.created_at.slice(0, 10) <= to);
  const ids = new Set(rows.map((o) => Number(o.id)));
  const hist = (await db.prepare('SELECT * FROM cp_stage_history WHERE org_id = ? ORDER BY id').all(req.org.id)).filter((h) => ids.has(Number(h.opp_id)));
  const maxPos = new Map();
  for (const h of hist) { const s = sm.get(Number(h.to_stage_id)); if (s && s.kind !== 'lost') maxPos.set(Number(h.opp_id), Math.max(maxPos.get(Number(h.opp_id)) ?? -1, s.position)); }
  const open = stages.filter((s) => s.kind === 'open');
  const steps = open.map((s, i) => ({ stageId: s.id, stage: s.name, count: rows.filter((o) => (maxPos.get(Number(o.id)) ?? -1) >= s.position).length }));
  steps.forEach((s, i) => { s.rateFromPrev = i ? (steps[i - 1].count ? L.round((s.count * 100) / steps[i - 1].count, 1) : 0) : 100; s.rateFromStart = steps[0].count ? L.round((s.count * 100) / steps[0].count, 1) : 0; });
  const won = rows.filter((o) => o.status === 'won'); const lost = rows.filter((o) => o.status === 'lost');
  // Durée moyenne dans chaque étape (étapes quittées ou en cours).
  const dur = new Map();
  const byOpp = new Map(); for (const h of hist) { if (!byOpp.has(Number(h.opp_id))) byOpp.set(Number(h.opp_id), []); byOpp.get(Number(h.opp_id)).push(h); }
  for (const o of rows) { const hs = byOpp.get(Number(o.id)) || []; hs.forEach((h, i) => { const end = hs[i + 1] ? hs[i + 1].entered_at : (o.closed_at || nowISO()); const sid = Number(h.to_stage_id); if (!dur.has(sid)) dur.set(sid, []); dur.get(sid).push(Math.max(0, L.daysBetween(h.entered_at, end))); }); }
  const avgDays = open.map((s) => { const d = dur.get(s.id) || []; return { stageId: s.id, stage: s.name, avgDays: d.length ? L.round(d.reduce((a, b) => a + b, 0) / d.length, 1) : 0, samples: d.length }; });
  const cycle = won.length ? L.round(won.reduce((a, o) => a + Math.max(0, L.daysBetween(o.created_at, o.closed_at)), 0) / won.length, 1) : 0;
  const lossBy = new Map(); for (const o of lost) { const k = o.reason_text || '—'; const v = lossBy.get(k) || { reason: k, count: 0, amount: 0 }; v.count++; v.amount += N(o.amount); lossBy.set(k, v); }
  const winBy = new Map(); for (const o of won) { const k = o.reason_text || '—'; const v = winBy.get(k) || { reason: k, count: 0, amount: 0 }; v.count++; v.amount += N(o.amount); winBy.set(k, v); }
  res.json({
    from, to, created: rows.length, steps, won: won.length, wonAmount: won.reduce((a, o) => a + N(o.amount), 0), lost: lost.length, lostAmount: lost.reduce((a, o) => a + N(o.amount), 0),
    winRate: won.length + lost.length ? L.round((won.length * 100) / (won.length + lost.length), 1) : 0, avgCycleDays: cycle, avgDaysByStage: avgDays,
    lossReasons: [...lossBy.values()].sort((a, b) => b.count - a.count), winReasons: [...winBy.values()].sort((a, b) => b.count - a.count),
  });
});

module.exports = { router, createOpp, moveOpp, stagesOf, oppView, oppProb };
