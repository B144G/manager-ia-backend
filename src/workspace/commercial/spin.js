'use strict';
// SPIN Selling : fiche d'appel ou de rendez-vous guidée (Situation, Problème, Implication, Besoin-bénéfice), notes structurées rattachées à l'opportunité,
// synthèse automatique du besoin. Les questions suggérées sont affichées par l'écran ; le serveur ne garde que ce qui a été demandé et répondu.
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const { HttpError, oneLine } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;
const parse = (s) => { try { const j = JSON.parse(s || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };

const cleanSection = (v) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 12) throw new HttpError(400, 'Chaque rubrique SPIN compte 12 questions au plus.');
  return v.map((x) => ({ q: A.text(x && x.q, 200), a: A.text(x && x.a, 600), key: Boolean(x && x.key) })).filter((x) => x.q || x.a);
};
const view = (s, names) => ({ id: Number(s.id), oppId: s.opp_id ? Number(s.opp_id) : null, customerId: s.customer_id ? Number(s.customer_id) : null, leadId: s.lead_id ? Number(s.lead_id) : null, userId: s.user_id ? Number(s.user_id) : null, by: names ? names.get(Number(s.user_id)) || '' : undefined, kind: s.kind, heldAt: s.held_at, situation: parse(s.situation), problem: parse(s.problem), implication: parse(s.implication), payoff: parse(s.payoff), notes: s.notes, nextStep: s.next_step, createdAt: s.created_at });
const sheetOf = async (req, id) => {
  const s = await db.prepare('SELECT * FROM cp_spin WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!s) throw new HttpError(404, 'Fiche SPIN introuvable.');
  return s;
};
async function refs(req, q) {
  const out = { opp_id: null, customer_id: null, lead_id: null };
  if (q.oppId) { const o = await db.prepare('SELECT * FROM cp_opps WHERE id = ? AND org_id = ?').get(A.id(q.oppId), req.org.id); if (!o) throw new HttpError(404, 'Opportunité introuvable.'); await P.mustOwn(req, o); out.opp_id = Number(o.id); out.customer_id = o.customer_id ? Number(o.customer_id) : null; out.lead_id = o.lead_id ? Number(o.lead_id) : null; }
  else if (q.leadId) { const l = await db.prepare('SELECT * FROM cp_leads WHERE id = ? AND org_id = ?').get(A.id(q.leadId), req.org.id); if (!l) throw new HttpError(404, 'Prospect introuvable.'); await P.mustOwn(req, l); out.lead_id = Number(l.id); }
  else if (q.customerId) { const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(A.id(q.customerId), req.org.id); if (!c || !A.visible(req, c)) throw new HttpError(404, 'Compte introuvable.'); await P.mustOwn(req, c); out.customer_id = Number(c.id); }
  else throw new HttpError(400, 'Rattachez la fiche à une opportunité, un prospect ou un compte.');
  return out;
}
const where = (r) => (r.opp_id ? ['opp_id', r.opp_id] : r.lead_id ? ['lead_id', r.lead_id] : ['customer_id', r.customer_id]);

router.get('/spin', P.need('view'), async (req, res) => {
  const r = await refs(req, req.query); const [col, v] = where(r);
  const names = await B.names(req.org.id);
  res.json({ sheets: (await db.prepare(`SELECT * FROM cp_spin WHERE org_id = ? AND ${col} = ? ORDER BY held_at DESC, id DESC`).all(req.org.id, v)).map((s) => view(s, names)) });
});
router.post('/spin', P.need('activity'), async (req, res) => {
  const b = req.body || {};
  const r = await refs(req, b);
  const held = b.heldAt ? new Date(b.heldAt) : new Date();
  if (Number.isNaN(held.getTime())) throw new HttpError(400, 'Date invalide.');
  const now = nowISO();
  const id = (await db.prepare('INSERT INTO cp_spin (org_id, opp_id, customer_id, lead_id, user_id, kind, held_at, situation, problem, implication, payoff, notes, next_step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, r.opp_id, r.customer_id, r.lead_id, req.user.id, A.oneOf(b.kind, ['call', 'meeting', 'visit'], 'call', "Type inconnu (appel, rendez-vous, visite)."), held.toISOString(), JSON.stringify(cleanSection(b.situation) || []), JSON.stringify(cleanSection(b.problem) || []), JSON.stringify(cleanSection(b.implication) || []), JSON.stringify(cleanSection(b.payoff) || []), A.text(b.notes, 1500), A.text(b.nextStep, 200), now, now)).lastInsertRowid;
  await P.audit(req, 'spin', id, 'create', r.opp_id ? 'opp ' + r.opp_id : '');
  res.status(201).json({ id: Number(id) });
});
router.put('/spin/:id', P.need('activity'), async (req, res) => {
  const s = await sheetOf(req, req.params.id);
  if (Number(s.user_id) !== req.user.id && !(await P.has(req, 'approve'))) throw new HttpError(403, 'Seul l’auteur de la fiche ou le responsable commercial la modifie.');
  const b = req.body || {};
  const sec = (k) => JSON.stringify(cleanSection(b[k]) || (b[k] === undefined ? parse(s[k]) : []));
  await db.prepare('UPDATE cp_spin SET situation = ?, problem = ?, implication = ?, payoff = ?, notes = ?, next_step = ?, updated_at = ? WHERE id = ?').run(sec('situation'), sec('problem'), sec('implication'), sec('payoff'), b.notes === undefined ? s.notes : A.text(b.notes, 1500), b.nextStep === undefined ? s.next_step : A.text(b.nextStep, 200), nowISO(), s.id);
  res.json({ ok: true });
});
router.delete('/spin/:id', P.need('activity'), async (req, res) => {
  const s = await sheetOf(req, req.params.id);
  if (Number(s.user_id) !== req.user.id && !(await P.has(req, 'delete'))) throw new HttpError(403, 'Seul l’auteur de la fiche ou le responsable commercial la supprime.');
  await db.prepare('DELETE FROM cp_spin WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

const textOf = (syn, who) => {
  const n = syn.need; const lines = [];
  if (who) lines.push(`Besoin de ${who} :`);
  if (n.problem) lines.push(`Problème : ${n.problem}`);
  if (n.implication) lines.push(`Conséquence : ${n.implication}`);
  if (n.payoff) lines.push(`Bénéfice attendu : ${n.payoff}`);
  return lines.join('\n');
};
router.get('/spin-synthesis', P.need('view'), async (req, res) => {
  const r = await refs(req, req.query); const [col, v] = where(r);
  const sheets = (await db.prepare(`SELECT * FROM cp_spin WHERE org_id = ? AND ${col} = ? ORDER BY held_at, id`).all(req.org.id, v)).map((s) => view(s));
  const syn = L.spinSynthesis(sheets);
  let who = ''; if (r.customer_id) { const c = await db.prepare('SELECT name FROM customers WHERE id = ?').get(r.customer_id); who = c ? c.name : ''; }
  res.json({ sheets: sheets.length, ...syn, text: textOf(syn, who) });
});
// Reporte la synthèse dans les notes de l'opportunité (une note structurée, relue par un humain avant tout envoi).
router.post('/spin-synthesis/note', P.need('write'), async (req, res) => {
  const r = await refs(req, req.body || {}); const [col, v] = where(r);
  const sheets = (await db.prepare(`SELECT * FROM cp_spin WHERE org_id = ? AND ${col} = ? ORDER BY held_at, id`).all(req.org.id, v)).map((s) => view(s));
  if (!sheets.length) throw new HttpError(400, "Aucune fiche SPIN à synthétiser.");
  const syn = L.spinSynthesis(sheets);
  const body = `Synthèse SPIN (${syn.completeness}/100)\n${textOf(syn, '')}`.slice(0, 2000);
  const id = (await db.prepare('INSERT INTO cp_notes (org_id, customer_id, lead_id, opp_id, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, r.customer_id, r.lead_id, r.opp_id, body, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id), body });
});

module.exports = { router };
