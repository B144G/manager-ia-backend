'use strict';
// Agents · vague 3 : lancement planifié (digest hebdomadaire ou quotidien) et boutons « créer la tâche » / « créer la relance » depuis la synthèse.
// L'IA ne modifie RIEN seule : le digest est un texte à lire ; toute création passe par un clic avec confirmation explicite d'une personne.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, oneLine, log } = require('../util');

const router = express.Router({ mergeParams: true });

const schedView = (r) => ({ enabled: Boolean(r && Number(r.enabled)), weekday: r ? Number(r.weekday) : 1, hour: r ? Number(r.hour) : 8, agentKey: r ? r.agent_key : 'direction', lastRun: r ? r.last_run : null, lastStatus: r ? r.last_status : '' });
router.get('/schedule', A.need('manager'), async (req, res) => {
  res.json({ schedule: schedView(await db.prepare('SELECT * FROM agent_schedules WHERE org_id = ?').get(req.org.id)), note: "Le digest est un texte de synthèse déposé dans vos notifications : l'IA ne crée ni ne modifie rien. Chaque digest compte pour un message IA." });
});
router.put('/schedule', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const cur = await db.prepare('SELECT * FROM agent_schedules WHERE org_id = ?').get(req.org.id);
  const weekday = b.weekday === undefined ? (cur ? Number(cur.weekday) : 1) : Math.round(Number(b.weekday)); const hour = b.hour === undefined ? (cur ? Number(cur.hour) : 8) : Math.round(Number(b.hour));
  if (!(weekday >= 0 && weekday <= 7) || !(hour >= 0 && hour <= 23)) throw new HttpError(400, 'Jour (0 à 6, 7 = tous les jours) ou heure (0 à 23) invalide.');
  const key = b.agentKey === undefined ? (cur ? cur.agent_key : 'direction') : String(b.agentKey);
  if (!require('./agents').BY_KEY[key]) throw new HttpError(400, 'Agent inconnu.');
  const enabled = b.enabled === undefined ? (cur ? Number(cur.enabled) : 0) : (b.enabled ? 1 : 0);
  await db.prepare('INSERT INTO agent_schedules (org_id, enabled, weekday, hour, agent_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, weekday = EXCLUDED.weekday, hour = EXCLUDED.hour, agent_key = EXCLUDED.agent_key').run(req.org.id, enabled, weekday, hour, key);
  await W.audit(req, 'agent_schedule', req.org.id, 'update', cur ? schedView(cur) : null, { enabled, weekday, hour, agentKey: key });
  res.json({ ok: true });
});

const DIGEST_Q = "Fais le point de la période : les 3 priorités à traiter en premier et les risques à surveiller, avec des actions concrètes.";
/** Lance le digest d'une organisation (propriétaire comme demandeur). Renvoie un statut lisible. */
async function runDigest(org, sch) {
  const owner = await db.prepare('SELECT * FROM users WHERE id = ?').get(org.owner_id);
  const member = await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(org.id, org.owner_id);
  if (!owner || !member) return 'propriétaire introuvable';
  const AG = require('./agents'); const ai = require('./ai'); const claude = require('../services/claude');
  if (!claude.isConfigured()) return "IA non configurée sur ce serveur";
  const req = { org, user: owner, member, query: {}, body: {} };
  const a = AG.BY_KEY[sch.agent_key];
  const cfg = await AG.configs(req);
  if (!a || !AG.allowed(req, a) || !AG.isOn(cfg, a)) return 'agent indisponible';
  try {
    await ai.checkQuota(req);
    const r = await AG.askAgent(req, ai, a, cfg, DIGEST_Q);
    await db.prepare('INSERT INTO agents_log (org_id, user_id, mode, question, result, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(org.id, owner.id, 'scheduled', DIGEST_Q, JSON.stringify({ mode: 'scheduled', question: DIGEST_Q, answers: [{ agent: { key: a.key, name: a.name, role: a.role }, text: r.text, data: r.data }] }).slice(0, 60000), nowISO());
    await W.pushRole(org.id, 'admin', 'agents', `Digest de ${a.name} prêt : ${oneLine(r.text, 160)}`, 'agents');
    return 'ok';
  } catch (e) { return oneLine(e.message, 120); }
}
/** Planificateur (appelé chaque minute) : une exécution par jour au plus, à l'heure locale choisie (UTC+1 par défaut). */
async function tick() {
  const rows = await db.prepare('SELECT * FROM agent_schedules WHERE enabled = 1').all();
  let n = 0;
  for (const s of rows) {
    try {
      const off = Number((await db.prepare('SELECT tz_offset FROM digest_settings WHERE org_id = ?').get(s.org_id) || {}).tz_offset ?? 60);
      const local = new Date(Date.now() + off * 60000); const day = local.toISOString().slice(0, 10);
      if (s.last_run === day) continue;
      if (!(Number(s.weekday) === 7 || local.getUTCDay() === Number(s.weekday)) || local.getUTCHours() < Number(s.hour)) continue;
      const claimed = await db.prepare('UPDATE agent_schedules SET last_run = ? WHERE org_id = ? AND (last_run IS NULL OR last_run <> ?)').run(day, s.org_id, day);
      if (!claimed.changes) continue; // un autre serveur l'a pris
      const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(s.org_id);
      if (!org) continue;
      const status = await runDigest(org, s);
      await db.prepare('UPDATE agent_schedules SET last_status = ? WHERE org_id = ?').run(status, s.org_id);
      n++;
    } catch (e) { log.warn('Agents planifiés :', oneLine(e.message, 140)); }
  }
  return n;
}
router.post('/schedule/run', A.need('admin'), async (req, res) => {
  const sch = (await db.prepare('SELECT * FROM agent_schedules WHERE org_id = ?').get(req.org.id)) || { agent_key: 'direction' };
  const status = await runDigest(req.org, sch);
  await db.prepare('INSERT INTO agent_schedules (org_id, last_status) VALUES (?, ?) ON CONFLICT (org_id) DO UPDATE SET last_status = EXCLUDED.last_status').run(req.org.id, status);
  res.json({ status });
});

// ---------- Actions confirmées par une personne ----------
router.post('/actions', async (req, res) => {
  const b = req.body || {};
  if (b.confirm !== true) throw new HttpError(400, 'Confirmation requise : une personne doit valider la création (l\'IA ne crée rien seule).');
  const type = A.oneOf(b.type, ['task', 'followup'], undefined, 'Action inconnue (task ou followup).');
  const title = A.text(b.title, 160, { required: true, msg: 'Indiquez le titre.' });
  const days = b.dueInDays === undefined || b.dueInDays === '' ? 3 : Math.min(Math.max(Math.round(Number(b.dueInDays)), 0), 365);
  if (!Number.isFinite(days)) throw new HttpError(400, 'Délai invalide.');
  const due = W.addDays(W.today(), days);
  let description = A.text(b.why, 800); let finalTitle = title; let assignee = req.user.id; let ref = null;
  if (type === 'followup') {
    const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId, 'Choisissez le client à relancer.'), req.org.id);
    if (!c || !A.visible(req, c)) throw new HttpError(404, 'Client introuvable.');
    if (!A.can(req, 'manager')) throw new HttpError(403, 'Seuls les responsables créent une relance client.');
    const owed = Number((await db.prepare("SELECT COALESCE(SUM(total - credited - paid), 0) s FROM documents WHERE customer_id = ? AND kind = 'invoice' AND status = 'sent'").get(c.id)).s);
    finalTitle = `Relancer ${c.name} : ${title}`.slice(0, 160);
    description = [description, c.phone ? `Téléphone : ${c.phone}` : '', c.email ? `E-mail : ${c.email}` : '', owed > 0 ? `Reste à payer : ${owed.toLocaleString('fr-FR')} ${req.org.currency}` : ''].filter(Boolean).join('\n');
    ref = c.id;
  }
  if (b.assigneeId) assignee = await A.memberOf(req, b.assigneeId);
  const id = Number((await db.prepare('INSERT INTO tasks (org_id, branch_id, title, description, priority, assignee_id, due, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, A.can(req, 'admin') ? null : req.member.branch_id, finalTitle, description, 'normal', assignee, due, req.user.id, nowISO())).lastInsertRowid);
  await db.prepare('INSERT INTO agent_actions (org_id, user_id, kind, title, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, req.user.id, type, finalTitle, id, nowISO());
  await W.audit(req, 'agent_action', id, type, null, { title: finalTitle, due, assignee, customerId: ref });
  await A.logActivity(req.org.id, req.user.id, 'agents', `Tâche créée depuis une suggestion d'agent : ${finalTitle}`);
  res.status(201).json({ taskId: id, due });
});
router.get('/actions', A.need('manager'), async (req, res) => {
  const rows = await db.prepare('SELECT a.*, u.name AS who FROM agent_actions a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT 30').all(req.org.id);
  res.json({ items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, taskId: r.ref_id, who: r.who, at: r.created_at })) });
});

module.exports = router;
module.exports.tick = tick;
module.exports.runDigest = runDigest;
