'use strict';
// Administration · 5. Contrôle interne et séparation des tâches : fonctions (autoriser / exécuter / enregistrer / contrôler), règles d'incompatibilité,
// DÉTECTION AUTOMATIQUE des conflits (affectations directes, par rôle, par fiche de poste, et activité observée dans Achats), dérogations motivées,
// registre des contrôles (fréquence, preuve, résultat), registre des risques, plans d'actions correctifs, score de maturité.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const L = require('./adm-lib');
const T = require('./adm-templates');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const manage = L.needPerm('control_manage');
const CATS = ['authorize', 'execute', 'record', 'control'];
const CAT_LABEL = { authorize: 'Autoriser', execute: 'Exécuter', record: 'Enregistrer', control: 'Contrôler' };
const SEVERITY = ['low', 'medium', 'high'];
const SEV_W = { high: 25, medium: 12, low: 5 };

// ---------- Fonctions et règles ----------
router.get('/sod/functions', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM adm_sod_funcs WHERE org_id = ? ORDER BY category, name').all(req.org.id);
  res.json({ functions: rows.map((f) => ({ id: Number(f.id), code: f.code, name: f.name, category: f.category, categoryLabel: CAT_LABEL[f.category], description: f.description })), categories: CATS.map((c) => ({ key: c, label: CAT_LABEL[c] })) });
});
router.post('/sod/functions', manage, async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 120, { required: true, msg: 'Indiquez le nom de la fonction.' });
  const code = (A.text(b.code, 40) || name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (await db.prepare('SELECT 1 FROM adm_sod_funcs WHERE org_id = ? AND code = ?').get(req.org.id, code)) throw new HttpError(409, 'Une fonction porte déjà ce code.');
  if ((await db.prepare('SELECT COUNT(*) c FROM adm_sod_funcs WHERE org_id = ?').get(req.org.id)).c >= 120) throw new HttpError(403, 'Limite de 120 fonctions atteinte.');
  const id = (await db.prepare('INSERT INTO adm_sod_funcs (org_id, code, name, category, description) VALUES (?, ?, ?, ?, ?)').run(req.org.id, code, name, A.oneOf(b.category, CATS, 'execute', 'Catégorie inconnue.'), A.text(b.description, 400))).lastInsertRowid;
  res.status(201).json({ id: Number(id), code });
});
router.put('/sod/functions/:id', manage, async (req, res) => {
  const f = await db.prepare('SELECT * FROM adm_sod_funcs WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!f) throw new HttpError(404, 'Fonction introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE adm_sod_funcs SET name = ?, category = ?, description = ? WHERE id = ?').run(b.name === undefined ? f.name : A.text(b.name, 120, { required: true, msg: 'Le nom ne peut pas être vide.' }), A.oneOf(b.category, CATS, f.category, 'Catégorie inconnue.'), b.description === undefined ? f.description : A.text(b.description, 400), f.id);
  res.json({ ok: true });
});
router.delete('/sod/functions/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_sod_funcs WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Fonction introuvable.');
  res.json({ ok: true });
});
router.post('/sod/seed', manage, async (req, res) => { // fonctions et règles courantes d'une PME
  const have = new Map((await db.prepare('SELECT id, code FROM adm_sod_funcs WHERE org_id = ?').all(req.org.id)).map((f) => [f.code, Number(f.id)]));
  let nf = 0; let nr = 0;
  for (const f of T.SOD_FUNCTIONS) if (!have.has(f.code)) { have.set(f.code, Number((await db.prepare('INSERT INTO adm_sod_funcs (org_id, code, name, category, description) VALUES (?, ?, ?, ?, \'\')').run(req.org.id, f.code, f.name, f.category)).lastInsertRowid)); nf++; }
  for (const [a, b, sev, why] of T.SOD_RULES) {
    const [x, y] = [have.get(a), have.get(b)].sort((p, q) => p - q);
    const r = await db.prepare('INSERT INTO adm_sod_rules (org_id, func_a, func_b, severity, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, func_a, func_b) DO NOTHING').run(req.org.id, x, y, sev, why);
    nr += r.changes;
  }
  res.json({ ok: true, functionsAdded: nf, rulesAdded: nr });
});
router.get('/sod/rules', async (req, res) => {
  const rows = await db.prepare('SELECT r.*, a.name AS a_name, b.name AS b_name FROM adm_sod_rules r JOIN adm_sod_funcs a ON a.id = r.func_a JOIN adm_sod_funcs b ON b.id = r.func_b WHERE r.org_id = ? ORDER BY r.id').all(req.org.id);
  res.json({ rules: rows.map((r) => ({ id: Number(r.id), funcA: Number(r.func_a), funcB: Number(r.func_b), funcAName: r.a_name, funcBName: r.b_name, severity: r.severity, reason: r.reason })) });
});
router.post('/sod/rules', manage, async (req, res) => {
  const b = req.body || {};
  let x = A.id(b.funcA, 'Fonction A invalide.'); let y = A.id(b.funcB, 'Fonction B invalide.');
  if (x === y) throw new HttpError(400, 'Une règle oppose deux fonctions différentes.');
  for (const f of [x, y]) if (!await db.prepare('SELECT 1 FROM adm_sod_funcs WHERE id = ? AND org_id = ?').get(f, req.org.id)) throw new HttpError(400, 'Fonction inconnue.');
  [x, y] = [x, y].sort((p, q) => p - q);
  const r = await db.prepare('INSERT INTO adm_sod_rules (org_id, func_a, func_b, severity, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, func_a, func_b) DO NOTHING').run(req.org.id, x, y, A.oneOf(b.severity, SEVERITY, 'high', 'Gravité inconnue.'), A.text(b.reason, 400));
  if (!r.changes) throw new HttpError(409, 'Cette règle existe déjà.');
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
router.delete('/sod/rules/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_sod_rules WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Règle introuvable.');
  res.json({ ok: true });
});

// ---------- Affectations ----------
async function setAssign(req, kind, subjectId, role, funcIds) {
  const ids = [...new Set((Array.isArray(funcIds) ? funcIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 120);
  for (const f of ids) if (!await db.prepare('SELECT 1 FROM adm_sod_funcs WHERE id = ? AND org_id = ?').get(f, req.org.id)) throw new HttpError(400, 'Fonction inconnue.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM adm_sod_assign WHERE org_id = ? AND subject_kind = ? AND COALESCE(subject_id, 0) = ? AND subject_role = ?').run(req.org.id, kind, subjectId || 0, role);
    for (const f of ids) await db.prepare('INSERT INTO adm_sod_assign (org_id, func_id, subject_kind, subject_id, subject_role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, f, kind, subjectId, role, nowISO());
  })();
  await W.audit(req, 'adm_sod_assign', subjectId, 'set', null, { kind, role, funcs: ids });
  return ids.length;
}
router.put('/sod/assignments/user/:userId', manage, async (req, res) => {
  const uid = await A.memberOf(req, req.params.userId);
  res.json({ ok: true, count: await setAssign(req, 'user', uid, '', (req.body || {}).functionIds) });
});
router.put('/sod/assignments/role/:role', manage, async (req, res) => {
  const role = A.oneOf(req.params.role, ['member', 'manager', 'admin', 'owner'], undefined, 'Rôle inconnu.');
  res.json({ ok: true, count: await setAssign(req, 'role', null, role, (req.body || {}).functionIds) });
});

/** Activité observée dans Achats : qui a réellement créé la commande, approuvé, enregistré la facture, payé (180 derniers jours). */
async function observed(orgId) {
  const since = L.addDays(L.today(), -180);
  const out = [];
  const q = async (code, sql) => { for (const r of await L.safe(() => db.prepare(sql).all(orgId, since), [])) if (r.u) out.push({ code, userId: Number(r.u) }); };
  if (await L.hasTable('pur_orders')) {
    await q('purchase_order', 'SELECT DISTINCT created_by AS u FROM pur_orders WHERE org_id = ? AND created_at >= ? AND created_by IS NOT NULL');
    await q('purchase_approve', 'SELECT DISTINCT approved_by AS u FROM pur_orders WHERE org_id = ? AND created_at >= ? AND approved_by IS NOT NULL');
  }
  if (await L.hasTable('pur_invoices')) await q('invoice_record', 'SELECT DISTINCT created_by AS u FROM pur_invoices WHERE org_id = ? AND created_at >= ? AND created_by IS NOT NULL');
  if (await L.hasTable('pur_payments')) await q('payment_make', 'SELECT DISTINCT created_by AS u FROM pur_payments WHERE org_id = ? AND created_at >= ? AND created_by IS NOT NULL');
  return out;
}
/** Fonctions de chaque personne, avec la source (direct, rôle, poste, activité). */
async function functionsByUser(orgId, { withObserved = true } = {}) {
  const mem = await L.members(orgId);
  const funcs = await db.prepare('SELECT * FROM adm_sod_funcs WHERE org_id = ?').all(orgId);
  const byCode = new Map(funcs.map((f) => [f.code, Number(f.id)]));
  const assign = await db.prepare('SELECT * FROM adm_sod_assign WHERE org_id = ?').all(orgId);
  const posts = await db.prepare('SELECT a.functions, p.holder_id, p.title FROM adm_posts a JOIN positions p ON p.id = a.position_id WHERE a.org_id = ? AND p.holder_id IS NOT NULL').all(orgId);
  const out = new Map(mem.map((m) => [m.userId, { userId: m.userId, name: m.name, role: m.role, map: new Map() }]));
  const add = (u, fid, src) => { const x = out.get(Number(u)); if (!x || !fid) return; const s = x.map.get(Number(fid)) || new Set(); s.add(src); x.map.set(Number(fid), s); };
  for (const a of assign) {
    if (a.subject_kind === 'user') add(a.subject_id, a.func_id, 'direct');
    else for (const m of mem.filter((x) => x.role === a.subject_role)) add(m.userId, a.func_id, 'role');
  }
  for (const p of posts) for (const f of L.jparse(p.functions, [])) add(p.holder_id, f, 'poste');
  if (withObserved) for (const o of await observed(orgId)) add(o.userId, byCode.get(o.code), 'activité');
  return { users: [...out.values()], funcs };
}
async function conflicts(orgId, opts) {
  const { users, funcs } = await functionsByUser(orgId, opts);
  const rules = await db.prepare('SELECT * FROM adm_sod_rules WHERE org_id = ?').all(orgId);
  const waivers = await db.prepare('SELECT * FROM adm_sod_waivers WHERE org_id = ?').all(orgId);
  const fname = new Map(funcs.map((f) => [Number(f.id), f.name]));
  const today = L.today();
  const list = [];
  for (const u of users) {
    for (const r of rules) {
      const a = u.map.get(Number(r.func_a)); const b = u.map.get(Number(r.func_b));
      if (!a || !b) continue;
      const w = waivers.find((x) => Number(x.rule_id) === Number(r.id) && Number(x.user_id) === u.userId);
      const waived = Boolean(w && (!w.until_date || w.until_date >= today));
      list.push({ userId: u.userId, user: u.name, ruleId: Number(r.id), funcA: Number(r.func_a), funcAName: fname.get(Number(r.func_a)), funcB: Number(r.func_b), funcBName: fname.get(Number(r.func_b)), severity: r.severity, reason: r.reason, sourcesA: [...a], sourcesB: [...b], waived, waiver: w ? { reason: w.reason, compensating: w.compensating, until: w.until_date } : null });
    }
  }
  const open = list.filter((c) => !c.waived);
  return { conflicts: list.sort((x, y) => SEV_W[y.severity] - SEV_W[x.severity]), summary: { total: list.length, open: open.length, waived: list.length - open.length, high: open.filter((c) => c.severity === 'high').length, medium: open.filter((c) => c.severity === 'medium').length, low: open.filter((c) => c.severity === 'low').length, people: new Set(open.map((c) => c.userId)).size } };
}
router.get('/sod/conflicts', async (req, res) => res.json(await conflicts(req.org.id, { withObserved: req.query.observed !== '0' })));
router.get('/sod/matrix', async (req, res) => {
  const { users, funcs } = await functionsByUser(req.org.id, { withObserved: req.query.observed !== '0' });
  const c = await conflicts(req.org.id, { withObserved: req.query.observed !== '0' });
  const inConflict = new Set(c.conflicts.filter((x) => !x.waived).flatMap((x) => [`${x.userId}:${x.funcA}`, `${x.userId}:${x.funcB}`]));
  res.json({
    functions: funcs.map((f) => ({ id: Number(f.id), code: f.code, name: f.name, category: f.category })).sort((a, b) => CATS.indexOf(a.category) - CATS.indexOf(b.category)),
    users: users.map((u) => ({ userId: u.userId, name: u.name, role: u.role, cells: Object.fromEntries([...u.map.entries()].map(([fid, s]) => [fid, { sources: [...s], conflict: inConflict.has(`${u.userId}:${fid}`) }])), byCategory: Object.fromEntries(CATS.map((cat) => [cat, [...u.map.keys()].filter((fid) => (funcs.find((f) => Number(f.id) === fid) || {}).category === cat).length])) })),
    summary: c.summary,
  });
});
router.post('/sod/waivers', manage, async (req, res) => {
  const b = req.body || {};
  const rule = await db.prepare('SELECT id FROM adm_sod_rules WHERE id = ? AND org_id = ?').get(A.id(b.ruleId), req.org.id);
  if (!rule) throw new HttpError(404, 'Règle introuvable.');
  const uid = await A.memberOf(req, b.userId);
  if (!uid) throw new HttpError(400, 'Indiquez la personne.');
  const reason = A.text(b.reason, 500, { required: true, msg: 'Une dérogation doit être motivée.' });
  const comp = A.text(b.compensating, 500, { required: true, msg: 'Indiquez le contrôle compensatoire qui limite le risque.' });
  await db.prepare('INSERT INTO adm_sod_waivers (org_id, rule_id, user_id, reason, compensating, until_date, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (rule_id, user_id) DO UPDATE SET reason = EXCLUDED.reason, compensating = EXCLUDED.compensating, until_date = EXCLUDED.until_date, approved_by = EXCLUDED.approved_by')
    .run(req.org.id, rule.id, uid, reason, comp, A.date(b.untilDate), req.user.id, nowISO());
  await W.audit(req, 'adm_sod_waiver', uid, 'create', null, { ruleId: rule.id, reason });
  res.status(201).json({ ok: true });
});
router.delete('/sod/waivers', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_sod_waivers WHERE org_id = ? AND rule_id = ? AND user_id = ?').run(req.org.id, A.id(req.query.ruleId), A.id(req.query.userId));
  if (!r.changes) throw new HttpError(404, 'Dérogation introuvable.');
  res.json({ ok: true });
});

// ---------- Risques ----------
const riskView = (r, names, controls) => {
  const score = Number(r.likelihood) * Number(r.impact);
  const mine = controls.filter((c) => Number(c.risk_id) === Number(r.id) && Number(c.active));
  return { ...L.out(r, { owner: names.get(Number(r.owner_id)) || null, likelihood: Number(r.likelihood), impact: Number(r.impact) }), score, level: score >= 15 ? 'critical' : score >= 8 ? 'high' : score >= 4 ? 'medium' : 'low', controls: mine.length };
};
router.get('/risks', async (req, res) => {
  const names = await L.nameMap(req.org.id);
  const controls = await db.prepare('SELECT id, risk_id, active FROM adm_controls WHERE org_id = ?').all(req.org.id);
  const rows = await db.prepare('SELECT * FROM adm_risks WHERE org_id = ? ORDER BY (likelihood * impact) DESC, id').all(req.org.id);
  const risks = rows.map((r) => riskView(r, names, controls));
  res.json({ risks, summary: { total: risks.length, open: risks.filter((r) => r.status === 'open').length, critical: risks.filter((r) => r.status === 'open' && r.level === 'critical').length, uncovered: risks.filter((r) => r.status === 'open' && !r.controls).length },
    heatmap: Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => risks.filter((r) => r.status !== 'closed' && r.likelihood === 5 - i && r.impact === j + 1).length)) });
});
async function riskBody(req, b, base = {}) {
  return {
    title: b.title === undefined ? base.title : A.text(b.title, 200, { required: true, msg: 'Décrivez le risque.' }), process: b.process === undefined ? base.process || '' : A.text(b.process, 120), description: b.description === undefined ? base.description || '' : A.text(b.description, 1500),
    likelihood: b.likelihood === undefined ? base.likelihood || 3 : L.intIn(b.likelihood, 1, 5, 3), impact: b.impact === undefined ? base.impact || 3 : L.intIn(b.impact, 1, 5, 3), owner: b.ownerId === undefined ? base.owner || null : await A.memberOf(req, b.ownerId),
    status: A.oneOf(b.status, ['open', 'mitigated', 'accepted', 'closed'], base.status || 'open', 'Statut inconnu.'),
  };
}
router.post('/risks', manage, async (req, res) => {
  const r = await riskBody(req, req.body || {});
  const now = nowISO();
  const id = (await db.prepare('INSERT INTO adm_risks (org_id, title, process, description, likelihood, impact, owner_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, r.title, r.process, r.description, r.likelihood, r.impact, r.owner, r.status, now, now)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/risks/:id', manage, async (req, res) => {
  const x = await db.prepare('SELECT * FROM adm_risks WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Risque introuvable.');
  const r = await riskBody(req, req.body || {}, { ...x, owner: x.owner_id });
  await db.prepare('UPDATE adm_risks SET title = ?, process = ?, description = ?, likelihood = ?, impact = ?, owner_id = ?, status = ?, updated_at = ? WHERE id = ?').run(r.title, r.process, r.description, r.likelihood, r.impact, r.owner, r.status, nowISO(), x.id);
  res.json({ ok: true });
});
router.delete('/risks/:id', manage, async (req, res) => {
  const id = A.id(req.params.id);
  await db.prepare('UPDATE adm_controls SET risk_id = NULL WHERE org_id = ? AND risk_id = ?').run(req.org.id, id);
  const r = await db.prepare('DELETE FROM adm_risks WHERE id = ? AND org_id = ?').run(id, req.org.id);
  if (!r.changes) throw new HttpError(404, 'Risque introuvable.');
  res.json({ ok: true });
});

// ---------- Registre des contrôles ----------
const FREQS = Object.keys(L.FREQ_DAYS);
function controlView(c, runs, names) {
  const mine = runs.filter((r) => Number(r.control_id) === Number(c.id)).sort((a, b) => (a.done_on === b.done_on ? Number(b.id) - Number(a.id) : b.done_on.localeCompare(a.done_on)));
  const last = mine[0];
  const base = last ? last.done_on : c.start_date || String(c.created_at).slice(0, 10);
  const nextDue = last ? L.nextByFreq(base, c.frequency) : base; // jamais fait : à faire dès la date de début
  const today = L.today();
  return { ...L.out(c, { owner: names.get(Number(c.owner_id)) || null, active: Boolean(Number(c.active)) }), lastDone: last ? last.done_on : null, lastResult: last ? last.result : null, nextDue, overdue: Boolean(Number(c.active) && nextDue < today), dueInDays: L.daysBetween(today, nextDue), runs: mine.length, okRate: mine.length ? Math.round((mine.filter((r) => r.result === 'ok').length / mine.length) * 100) : null };
}
router.get('/controls', async (req, res) => {
  const names = await L.nameMap(req.org.id);
  const runs = await db.prepare('SELECT id, control_id, done_on, result FROM adm_control_runs WHERE org_id = ?').all(req.org.id);
  const risks = new Map((await db.prepare('SELECT id, title FROM adm_risks WHERE org_id = ?').all(req.org.id)).map((r) => [Number(r.id), r.title]));
  const controls = (await db.prepare('SELECT * FROM adm_controls WHERE org_id = ? ORDER BY id').all(req.org.id)).map((c) => ({ ...controlView(c, runs, names), risk: risks.get(Number(c.risk_id)) || null }));
  res.json({ controls, summary: { total: controls.length, active: controls.filter((c) => c.active).length, overdue: controls.filter((c) => c.overdue).length, failing: controls.filter((c) => c.active && c.lastResult === 'ko').length }, frequencies: FREQS });
});
async function controlBody(req, b, base = {}) {
  const risk = b.riskId === undefined ? base.risk_id || null : A.idOrNull(b.riskId);
  if (risk && !await db.prepare('SELECT 1 FROM adm_risks WHERE id = ? AND org_id = ?').get(risk, req.org.id)) throw new HttpError(400, 'Risque inconnu.');
  return { title: b.title === undefined ? base.title : A.text(b.title, 200, { required: true, msg: 'Indiquez l’intitulé du contrôle.' }), objective: b.objective === undefined ? base.objective || '' : A.text(b.objective, 800), process: b.process === undefined ? base.process || '' : A.text(b.process, 120), risk,
    kind: A.oneOf(b.kind, ['preventive', 'detective'], base.kind || 'preventive', 'Type inconnu.'), frequency: A.oneOf(b.frequency, FREQS, base.frequency || 'monthly', 'Fréquence inconnue.'), owner: b.ownerId === undefined ? base.owner_id || null : await A.memberOf(req, b.ownerId),
    start: b.startDate === undefined ? base.start_date || null : A.date(b.startDate), active: b.active === undefined ? (base.active === undefined ? 1 : Number(base.active)) : L.flag(b.active) };
}
router.post('/controls', manage, async (req, res) => {
  const c = await controlBody(req, req.body || {});
  const id = (await db.prepare('INSERT INTO adm_controls (org_id, title, objective, process, risk_id, kind, frequency, owner_id, start_date, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, c.title, c.objective, c.process, c.risk, c.kind, c.frequency, c.owner, c.start, c.active, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/controls/:id', manage, async (req, res) => {
  const x = await db.prepare('SELECT * FROM adm_controls WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!x) throw new HttpError(404, 'Contrôle introuvable.');
  const c = await controlBody(req, req.body || {}, x);
  await db.prepare('UPDATE adm_controls SET title = ?, objective = ?, process = ?, risk_id = ?, kind = ?, frequency = ?, owner_id = ?, start_date = ?, active = ? WHERE id = ?').run(c.title, c.objective, c.process, c.risk, c.kind, c.frequency, c.owner, c.start, c.active, x.id);
  res.json({ ok: true });
});
router.delete('/controls/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_controls WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Contrôle introuvable.');
  res.json({ ok: true });
});
/** Enregistre l'exécution d'un contrôle : le responsable du contrôle, ou un gestionnaire. Un échec propose un plan d'action. */
router.post('/controls/:id/runs', async (req, res) => {
  const c = await db.prepare('SELECT * FROM adm_controls WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Contrôle introuvable.');
  req.admCfg = await L.getConfig(req.org.id);
  if (Number(c.owner_id) !== req.user.id && !L.allowed(req, req.admCfg, 'control_manage')) throw new HttpError(403, 'Seul le responsable du contrôle (ou un gestionnaire) l’enregistre.');
  const b = req.body || {};
  const doneOn = A.date(b.doneOn) || L.today();
  if (doneOn > L.today()) throw new HttpError(400, 'Le contrôle ne peut pas être daté du futur.');
  const result = A.oneOf(b.result, ['ok', 'partial', 'ko'], undefined, 'Résultat inconnu (ok, partial ou ko).');
  const evidence = A.text(b.evidence, 1000);
  if (result !== 'ok' && !evidence && !A.text(b.notes, 1000)) throw new HttpError(400, 'Expliquez ce qui n’a pas fonctionné.');
  const id = (await db.prepare('INSERT INTO adm_control_runs (org_id, control_id, done_on, result, evidence, doc_id, notes, done_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, c.id, doneOn, result, evidence, A.idOrNull(b.docId), A.text(b.notes, 1000), req.user.id, nowISO())).lastInsertRowid;
  let actionId = null;
  if (result === 'ko' && b.createAction !== false) {
    actionId = Number((await db.prepare("INSERT INTO adm_actions (org_id, title, detail, source_kind, source_id, owner_id, due_date, status, created_by, created_at) VALUES (?, ?, ?, 'control', ?, ?, ?, 'todo', ?, ?)")
      .run(req.org.id, `Corriger : ${c.title}`, A.text(b.notes, 500) || evidence, c.id, c.owner_id, L.addDays(L.today(), 30), req.user.id, nowISO())).lastInsertRowid);
  }
  res.status(201).json({ id: Number(id), actionId });
});
router.get('/controls/:id/runs', async (req, res) => {
  const names = await L.nameMap(req.org.id);
  const rows = await db.prepare('SELECT * FROM adm_control_runs WHERE control_id = ? AND org_id = ? ORDER BY done_on DESC, id DESC LIMIT 100').all(A.id(req.params.id), req.org.id);
  res.json({ runs: rows.map((r) => L.out(r, { doneBy: names.get(Number(r.done_by)) || null })) });
});

// ---------- Plans d'actions correctifs ----------
router.get('/actions', async (req, res) => {
  const names = await L.nameMap(req.org.id);
  const rows = await db.prepare('SELECT * FROM adm_actions WHERE org_id = ? ORDER BY CASE status WHEN \'done\' THEN 2 WHEN \'cancelled\' THEN 3 ELSE 1 END, due_date, id').all(req.org.id);
  const today = L.today();
  const actions = rows.map((a) => L.out(a, { owner: names.get(Number(a.owner_id)) || null, progress: Number(a.progress), overdue: Boolean(['todo', 'doing'].includes(a.status) && a.due_date && a.due_date < today) }));
  res.json({ actions, summary: { total: actions.length, open: actions.filter((a) => ['todo', 'doing'].includes(a.status)).length, overdue: actions.filter((a) => a.overdue).length, done: actions.filter((a) => a.status === 'done').length } });
});
router.post('/actions', manage, async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare("INSERT INTO adm_actions (org_id, title, detail, source_kind, source_id, owner_id, due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)")
    .run(req.org.id, A.text(b.title, 200, { required: true, msg: 'Indiquez l’action à mener.' }), A.text(b.detail, 1500), A.oneOf(b.sourceKind, ['control', 'risk', 'conflict', 'audit', 'other'], 'other', 'Origine inconnue.'), A.idOrNull(b.sourceId), await A.memberOf(req, b.ownerId), A.date(b.dueDate), req.user.id, nowISO())).lastInsertRowid;
  if (b.ownerId) await W.push(req.org.id, Number(b.ownerId), 'administration', `Action corrective à mener : ${b.title}`, 'action:' + id);
  res.status(201).json({ id: Number(id) });
});
router.put('/actions/:id', async (req, res) => {
  const a = await db.prepare('SELECT * FROM adm_actions WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Action introuvable.');
  req.admCfg = await L.getConfig(req.org.id);
  const mgr = L.allowed(req, req.admCfg, 'control_manage');
  if (!mgr && Number(a.owner_id) !== req.user.id) throw new HttpError(403, 'Seul le responsable de l’action (ou un gestionnaire) peut la modifier.');
  const b = req.body || {};
  const status = A.oneOf(b.status, ['todo', 'doing', 'done', 'cancelled'], a.status, 'Statut inconnu.');
  const progress = status === 'done' ? 100 : b.progress === undefined ? Number(a.progress) : L.intIn(b.progress, 0, 100, 0);
  await db.prepare('UPDATE adm_actions SET title = ?, detail = ?, owner_id = ?, due_date = ?, status = ?, progress = ?, closed_at = ? WHERE id = ?').run(
    mgr && b.title !== undefined ? A.text(b.title, 200, { required: true, msg: 'Le titre ne peut pas être vide.' }) : a.title, b.detail === undefined ? a.detail : A.text(b.detail, 1500), mgr && b.ownerId !== undefined ? await A.memberOf(req, b.ownerId) : a.owner_id,
    mgr && b.dueDate !== undefined ? A.date(b.dueDate) : a.due_date, status, progress, ['done', 'cancelled'].includes(status) ? a.closed_at || nowISO() : null, a.id);
  res.json({ ok: true });
});
router.delete('/actions/:id', manage, async (req, res) => {
  const r = await db.prepare('DELETE FROM adm_actions WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Action introuvable.');
  res.json({ ok: true });
});

// ---------- Score de maturité ----------
const LEVELS = [[0, 'Initial'], [20, 'Répétable'], [40, 'Défini'], [60, 'Maîtrisé'], [80, 'Optimisé']];
async function maturity(orgId) {
  const today = L.today();
  const c = await conflicts(orgId, {});
  const nFuncs = Number((await db.prepare('SELECT COUNT(*) c FROM adm_sod_funcs WHERE org_id = ?').get(orgId)).c);
  const nRules = Number((await db.prepare('SELECT COUNT(*) c FROM adm_sod_rules WHERE org_id = ?').get(orgId)).c);
  const nAssigned = Number((await db.prepare('SELECT COUNT(*) c FROM adm_sod_assign WHERE org_id = ?').get(orgId)).c) + Number((await db.prepare("SELECT COUNT(*) c FROM adm_posts WHERE org_id = ? AND functions <> '[]'").get(orgId)).c);
  const risks = await db.prepare("SELECT id FROM adm_risks WHERE org_id = ? AND status <> 'closed'").all(orgId);
  const controls = await db.prepare('SELECT * FROM adm_controls WHERE org_id = ? AND active = 1').all(orgId);
  const runs = await db.prepare('SELECT * FROM adm_control_runs WHERE org_id = ?').all(orgId);
  const names = new Map();
  const cv = controls.map((x) => controlView(x, runs, names));
  const covered = risks.filter((r) => controls.some((x) => Number(x.risk_id) === Number(r.id))).length;
  const since = L.addDays(today, -180);
  const recent = runs.filter((r) => r.done_on >= since);
  const actions = await db.prepare("SELECT * FROM adm_actions WHERE org_id = ? AND status IN ('todo','doing')").all(orgId);
  const lateActions = actions.filter((a) => a.due_date && a.due_date < today).length;
  const sopsApproved = Number((await db.prepare("SELECT COUNT(*) c FROM adm_sops WHERE org_id = ? AND status = 'approved'").get(orgId)).c);
  const activities = Number((await db.prepare('SELECT COUNT(*) c FROM adm_activities WHERE org_id = ?').get(orgId)).c);
  const raciIssues = (await require('./adm-org').raciMatrix(orgId)).issues.length;
  const flows = Number((await db.prepare("SELECT COUNT(*) c FROM adm_flows WHERE org_id = ? AND status = 'active'").get(orgId)).c);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const comps = [
    { key: 'sod', label: 'Séparation des tâches', weight: 25, score: !nFuncs || !nRules || !nAssigned ? 0 : Math.max(0, 100 - c.conflicts.filter((x) => !x.waived).reduce((s, x) => s + SEV_W[x.severity], 0) - c.summary.waived * 2), detail: !nFuncs || !nRules ? 'Fonctions et règles non définies' : !nAssigned ? 'Aucune fonction affectée aux personnes' : `${c.summary.open} conflit(s) ouvert(s), ${c.summary.waived} dérogation(s)`, tip: 'Définissez les fonctions et règles, affectez-les, puis résolvez ou motivez chaque conflit.' },
    { key: 'coverage', label: 'Risques couverts par un contrôle', weight: 20, score: pct(covered, risks.length), detail: `${covered} / ${risks.length} risque(s) couvert(s)`, tip: 'Rattachez au moins un contrôle à chaque risque ouvert.' },
    { key: 'execution', label: 'Contrôles faits à temps', weight: 20, score: pct(cv.filter((x) => !x.overdue).length, cv.length), detail: `${cv.filter((x) => x.overdue).length} contrôle(s) en retard sur ${cv.length}`, tip: 'Enregistrez chaque exécution avec sa preuve.' },
    { key: 'results', label: 'Contrôles réussis (6 mois)', weight: 15, score: pct(recent.filter((r) => r.result === 'ok').length, recent.length), detail: `${recent.filter((r) => r.result === 'ok').length} réussi(s) sur ${recent.length}`, tip: 'Traitez les échecs par une action corrective.' },
    { key: 'actions', label: 'Actions correctives tenues', weight: 10, score: actions.length ? 100 - pct(lateActions, actions.length) : (cv.some((x) => x.lastResult === 'ko') ? 40 : 100), detail: `${lateActions} action(s) en retard sur ${actions.length} ouverte(s)`, tip: 'Fixez un responsable et une échéance à chaque action.' },
    { key: 'formal', label: 'Formalisation (procédures, RACI, circuits)', weight: 10, score: (sopsApproved >= 3 ? 40 : sopsApproved > 0 ? 20 : 0) + (activities > 0 && !raciIssues ? 30 : activities > 0 ? 15 : 0) + (flows > 0 ? 30 : 0), detail: `${sopsApproved} procédure(s) approuvée(s), ${raciIssues} anomalie(s) RACI, ${flows} circuit(s) en service`, tip: 'Approuvez vos procédures clés, complétez la matrice RACI et mettez des circuits en service.' },
  ];
  const score = Math.round(comps.reduce((s, x) => s + (x.score * x.weight) / 100, 0));
  const idx = LEVELS.reduce((acc, [min], i) => (score >= min ? i : acc), 0);
  return { score, level: idx + 1, levelLabel: LEVELS[idx][1], components: comps };
}
router.get('/maturity', async (req, res) => res.json(await maturity(req.org.id)));

/** Nombre de contrôles actifs en retard. */
async function overdueCount(orgId) {
  const runs = await db.prepare('SELECT id, control_id, done_on, result FROM adm_control_runs WHERE org_id = ?').all(orgId);
  const names = new Map();
  return (await db.prepare('SELECT * FROM adm_controls WHERE org_id = ? AND active = 1').all(orgId)).filter((c) => controlView(c, runs, names).overdue).length;
}

module.exports = { router, conflicts, maturity, functionsByUser, overdueCount };
