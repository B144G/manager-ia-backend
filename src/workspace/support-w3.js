'use strict';
// Service client · vague 3 : réglages des délais (SLA), base de connaissances / FAQ (lue aussi par l'IA), rapports, satisfaction publique (CSAT).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const limits = require('../middleware/limits');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const pub = express.Router();
const SLA_KEYS = ['sla_first_high', 'sla_first_normal', 'sla_first_low', 'sla_resolve_high', 'sla_resolve_normal', 'sla_resolve_low', 'alert_ticket_hours'];
W.settingsRoutes(router, SLA_KEYS, 'admin', 'manager');

// ---------- Base de connaissances ----------
W.crud(router, { path: '/kb', table: 'kb_articles', entity: 'kb_article', read: 'member', write: 'manager', order: 'category, title', insertExtra: (req) => ({ created_by: req.user.id, updated_at: nowISO() }),
  fields: [{ k: 'title', t: 'text', max: 150, req: true, msg: "Indiquez la question ou le titre de l'article." }, { k: 'body', t: 'text', max: 4000, req: true, msg: 'Écrivez la réponse.' }, { k: 'category', t: 'text', max: 60 }, { k: 'published', t: 'bool' }],
  onUpdate: async (req, cur) => { await db.prepare('UPDATE kb_articles SET updated_at = ? WHERE id = ?').run(nowISO(), cur.id); },
  decorate: async (req, rows) => {
    const q = String(req.query.q || '').toLowerCase().slice(0, 80);
    return rows.filter((r) => (A.can(req, 'manager') || Number(r.published) === 1) && (!q || `${r.title} ${r.body} ${r.category}`.toLowerCase().includes(q)))
      .map((r) => ({ ...r, _view: { ...W.camelRow(r, ['created_by']), published: Boolean(Number(r.published)) } }));
  } });
/** Articles publiés lus par l'IA (service client) : titre + réponse, en taille limitée. */
async function kbForAi(orgId, limit = 12) {
  return (await db.prepare('SELECT title, body, category FROM kb_articles WHERE org_id = ? AND published = 1 ORDER BY updated_at DESC LIMIT ?').all(orgId, limit)).map((a) => ({ title: a.title, body: a.body, category: a.category }));
}

// ---------- Rapports ----------
router.get('/report', A.need('manager'), async (req, res) => {
  const from = A.date(req.query.from) || W.addDays(W.today(), -30); const to = A.date(req.query.to) || W.today();
  const sc = A.scope(req, 't.branch_id');
  const rows = await db.prepare(`SELECT t.*, u.name AS assignee FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.org_id = ? AND t.created_at >= ? AND t.created_at < ?${sc.sql}`).all(req.org.id, from, W.addDays(to, 1), ...sc.args);
  const by = (k, f = (r) => r[k]) => { const o = {}; for (const r of rows) { const v = f(r) || '—'; o[v] = (o[v] || 0) + 1; } return o; };
  const mins = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
  const firsts = rows.filter((r) => r.first_response_at).map((r) => mins(r.created_at, r.first_response_at));
  const ress = rows.filter((r) => r.resolved_at).map((r) => mins(r.created_at, r.resolved_at) / 60);
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  const rate = (arr) => (arr.length ? Math.round((100 * arr.filter(Boolean).length) / arr.length) : null);
  const firstOk = rows.filter((r) => r.first_response_at && r.first_due_at).map((r) => r.first_response_at <= r.first_due_at);
  const resOk = rows.filter((r) => r.resolved_at && r.due_at).map((r) => r.resolved_at <= r.due_at);
  const scores = rows.filter((r) => r.csat).map((r) => Number(r.csat));
  const perAssignee = {};
  for (const r of rows) { const k = r.assignee || '—'; const o = perAssignee[k] || (perAssignee[k] = { name: k, total: 0, resolved: 0, csat: [] }); o.total++; if (r.status === 'resolved') o.resolved++; if (r.csat) o.csat.push(Number(r.csat)); }
  res.json({ from, to, total: rows.length, byStatus: by('status'), byChannel: by('channel'), byPriority: by('priority'),
    avgFirstResponseMinutes: avg(firsts), avgResolutionHours: avg(ress), slaFirstRate: rate(firstOk), slaResolveRate: rate(resOk),
    open: rows.filter((r) => r.status !== 'resolved').length,
    csat: { average: avg(scores), count: scores.length }, perAssignee: Object.values(perAssignee).map((o) => ({ name: o.name, total: o.total, resolved: o.resolved, csat: avg(o.csat) })) });
});

// ---------- Satisfaction publique (lien envoyé au client à la résolution) ----------
const csatLimit = limits.make(10 * 60 * 1000, 20, 'Trop de tentatives. Réessayez dans quelques minutes.');
const byToken = async (token) => {
  const t = /^[a-f0-9]{24}$/.test(String(token)) ? await db.prepare('SELECT t.*, o.name AS org_name FROM tickets t JOIN orgs o ON o.id = t.org_id WHERE t.csat_token = ?').get(String(token)) : null;
  if (!t) throw new HttpError(404, 'Lien introuvable ou expiré.');
  return t;
};
pub.get('/csat/:token', csatLimit, async (req, res) => {
  const t = await byToken(req.params.token);
  res.json({ organisation: t.org_name, subject: t.subject, ref: t.ref, answered: t.csat != null });
});
pub.post('/csat/:token', csatLimit, async (req, res) => {
  const t = await byToken(req.params.token);
  if (t.csat != null) throw new HttpError(409, 'Merci, votre avis a déjà été enregistré.');
  if (t.status !== 'resolved') throw new HttpError(400, "Cette demande n'est pas encore résolue.");
  const score = Number((req.body || {}).score);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new HttpError(400, 'Choisissez une note de 1 à 5.');
  const comment = A.text((req.body || {}).comment, 500);
  await db.prepare('UPDATE tickets SET csat = ?, csat_comment = ?, csat_at = ? WHERE id = ?').run(score, comment, nowISO(), t.id);
  await A.logActivity(t.org_id, null, 'support', `Avis client reçu : ${score}/5 (${t.ref})`);
  if (score <= 2) await W.pushRole(t.org_id, 'manager', 'support', `Client peu satisfait (${score}/5) : ${t.subject} (${t.ref})`, 'ticket:' + t.id);
  res.json({ ok: true });
});
// Page publique de demande : nom de l'organisation et questions fréquentes publiées
pub.get('/intake/:token/info', limits.make(60 * 1000, 60, 'Trop de requêtes.'), async (req, res) => {
  const org = await db.prepare('SELECT id, name FROM orgs WHERE intake_token = ?').get(String(req.params.token).slice(0, 80));
  if (!org) throw new HttpError(404, 'Formulaire introuvable.');
  res.json({ organisation: org.name, faq: (await kbForAi(org.id, 30)).map((a) => ({ question: a.title, answer: a.body, category: a.category })) });
});

module.exports = router;
module.exports.pub = pub;
module.exports.kbForAi = kbForAi;
