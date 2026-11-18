'use strict';
// Devis du module Commercial : versions et variantes, validité, conditions, remise comparée au prix de liste avec circuit de validation selon le plafond du rôle,
// acceptation par lien secret, suivi et relances. Le devis RESTE un document du module « Clients et ventes » (table documents, numérotation, conversion en commande et facture).
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const W = require('../w3');
const D = require('../invoice-doc');
const limits = require('../../middleware/limits');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const { HttpError } = require('../../util');

const router = express.Router({ mergeParams: true });
const pub = express.Router();
const { N } = B;
const crm = () => require('../crm');
const pricing = () => require('../pricing');
const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

const quoteOf = async (req, id) => {
  const d = await db.prepare("SELECT * FROM documents WHERE id = ? AND org_id = ? AND kind = 'quote'").get(A.id(id), req.org.id);
  if (!d || !A.visible(req, d)) throw new HttpError(404, 'Devis introuvable.');
  return d;
};
const metaOf = (docId) => db.prepare('SELECT * FROM cp_quote_meta WHERE doc_id = ?').get(docId);

/** Lignes avec le prix de liste du catalogue (si l'article est connu), pour calculer la remise. */
async function withList(orgId, lines) {
  const items = await db.prepare('SELECT * FROM catalog WHERE org_id = ?').all(orgId);
  return lines.map((l) => { const it = items.length ? pricing().matchItem(items, l) : null; return { ...l, listPrice: it ? N(it.price) : 0 }; });
}
async function computeMeta(req, lines, creatorRole, boss) {
  const set = await B.settings(req.org.id);
  const ll = await withList(req.org.id, lines);
  const pct = L.discountPct(ll);
  const cap = L.discountCap(creatorRole, boss, set.discountCaps);
  return { discount_pct: pct, list_total: ll.reduce((a, l) => a + Math.round(N(l.quantity) * Math.max(N(l.listPrice), N(l.price))), 0), approval_required: pct > cap ? 1 : 0, cap, set };
}
const view = (d, m, names, extra = {}) => {
  const today = B.today();
  return {
    id: Number(d.id), number: d.number, status: d.status, total: N(d.total), customerId: Number(d.customer_id), customer: d.customer, issued: d.issued, lines: parse(d.lines),
    groupId: m ? Number(m.group_id) : Number(d.id), version: m ? N(m.version) : 1, variant: m ? m.variant : '', superseded: m ? Boolean(Number(m.superseded)) : false, oppId: m && m.opp_id ? Number(m.opp_id) : null,
    validUntil: m ? m.valid_until : null, expired: Boolean(m && m.valid_until && m.valid_until < today && ['draft', 'sent'].includes(d.status)), conditions: m ? m.conditions : '',
    discountPct: m ? N(m.discount_pct) : 0, approvalRequired: m ? Boolean(Number(m.approval_required)) : false, approval: m ? m.approval : 'none', approvalReason: m ? m.approval_reason : '', approvalComment: m ? m.approval_comment : '',
    sentAt: m ? m.sent_at : null, viewedAt: m ? m.viewed_at : null, acceptedAt: m ? m.accepted_at : null, acceptedName: m ? m.accepted_name : '', refusedAt: m ? m.refused_at : null, refuseReason: m ? m.refuse_reason : '',
    daysSinceSent: m && m.sent_at && d.status === 'sent' ? Math.max(0, L.daysBetween(m.sent_at, today)) : null, hasLink: Boolean(m && m.accept_token), createdBy: m && m.created_by ? names.get(Number(m.created_by)) || '' : '', ...extra,
  };
};

// ---------- Liste, détail, statistiques ----------
router.get('/quotes', P.need('view'), async (req, res) => {
  const names = await B.names(req.org.id);
  const sc = A.scope(req, 'd.branch_id');
  const cp = await P.load(req);
  let rows = await db.prepare(`SELECT d.*, c.name AS customer, c.owner_id AS c_owner, m.doc_id AS m_doc FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN cp_quote_meta m ON m.doc_id = d.id WHERE d.org_id = ? AND d.kind = 'quote'${sc.sql} ORDER BY d.id DESC LIMIT 400`).all(req.org.id, ...sc.args);
  if (cp.scopeOwn) rows = rows.filter((d) => Number(d.c_owner) === req.user.id || Number(d.created_by) === req.user.id);
  const out = [];
  for (const d of rows) out.push(view(d, await metaOf(d.id), names));
  let list = req.query.all ? out : out.filter((q) => !q.superseded);
  for (const k of ['status', 'approval']) if (req.query[k]) list = list.filter((q) => q[k] === req.query[k]);
  if (req.query.customerId) list = list.filter((q) => q.customerId === Number(req.query.customerId));
  if (req.query.oppId) list = list.filter((q) => q.oppId === Number(req.query.oppId));
  res.json({ quotes: list.map((q) => ({ ...q, lines: undefined })) });
});
router.get('/quotes/stats', P.need('view'), async (req, res) => {
  const { from, to } = B.range({ ...req.query, from: req.query.from || L.addDays(B.today(), -180) });
  const rows = await db.prepare("SELECT d.id, d.status, d.total, d.issued, m.sent_at, m.accepted_at, m.superseded FROM documents d LEFT JOIN cp_quote_meta m ON m.doc_id = d.id WHERE d.org_id = ? AND d.kind = 'quote' AND d.issued >= ? AND d.issued <= ?").all(req.org.id, from, to);
  const live = rows.filter((r) => !N(r.superseded));
  const sent = live.filter((r) => ['sent', 'accepted', 'refused'].includes(r.status));
  const acc = live.filter((r) => r.status === 'accepted'); const ref = live.filter((r) => r.status === 'refused'); const wait = live.filter((r) => r.status === 'sent');
  const times = acc.filter((r) => r.sent_at && r.accepted_at).map((r) => (Date.parse(r.accepted_at) - Date.parse(r.sent_at)) / 86400000);
  const sum = (a) => a.reduce((x, r) => x + N(r.total), 0);
  res.json({ from, to, created: live.length, sent: sent.length, accepted: acc.length, refused: ref.length, waiting: wait.length, acceptanceRate: acc.length + ref.length ? L.round((acc.length * 100) / (acc.length + ref.length), 1) : 0, acceptedAmount: sum(acc), waitingAmount: sum(wait), avgDaysToAccept: times.length ? L.round(times.reduce((a, b) => a + b, 0) / times.length, 1) : 0 });
});
router.get('/quotes/pending', P.need('view'), async (req, res) => {
  const names = await B.names(req.org.id);
  const rows = await db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id JOIN cp_quote_meta m ON m.doc_id = d.id WHERE d.org_id = ? AND d.kind = 'quote' AND d.status = 'sent' AND m.superseded = 0").all(req.org.id);
  const out = [];
  for (const d of rows) out.push(view(d, await metaOf(d.id), names, { lines: undefined }));
  res.json({ quotes: out.sort((a, b) => (b.daysSinceSent || 0) - (a.daysSinceSent || 0)) });
});
router.get('/quotes/:id', P.need('view'), async (req, res) => {
  const d = await quoteOf(req, req.params.id);
  const names = await B.names(req.org.id);
  const cu = await db.prepare('SELECT name FROM customers WHERE id = ?').get(d.customer_id);
  const m = await metaOf(d.id);
  const grp = m ? await db.prepare('SELECT d.id, d.number, d.status, d.total, m.version, m.variant, m.superseded FROM cp_quote_meta m JOIN documents d ON d.id = m.doc_id WHERE m.group_id = ? ORDER BY m.version, m.variant').all(m.group_id) : [];
  const orders = await db.prepare("SELECT id, number, status, total FROM documents WHERE org_id = ? AND kind = 'order' AND note = ?").all(req.org.id, `Suite au devis ${d.number}`);
  const invoices = await db.prepare("SELECT id, number, status, total, paid FROM documents WHERE org_id = ? AND kind = 'invoice' AND (note = ? OR note = ?)").all(req.org.id, `Suite au devis ${d.number}`, ...(orders[0] ? [`Suite à la commande ${orders[0].number}`] : ['—']));
  res.json({ quote: view({ ...d, customer: cu && cu.name }, m, names), versions: grp.map((g) => ({ id: Number(g.id), number: g.number, status: g.status, total: N(g.total), version: N(g.version), variant: g.variant, superseded: Boolean(Number(g.superseded)) })), chain: { orders: orders.map((o) => ({ id: Number(o.id), number: o.number, status: o.status, total: N(o.total) })), invoices: invoices.map((o) => ({ id: Number(o.id), number: o.number, status: o.status, total: N(o.total), paid: N(o.paid) })) } });
});

// ---------- Création, modification, versions, variantes ----------
router.post('/quotes', P.need('quote'), async (req, res) => {
  const b = req.body || {};
  const cp = await P.load(req);
  const lines = crm().cleanLines(b.lines);
  if (b.oppId) { const o = await db.prepare('SELECT id FROM cp_opps WHERE id = ? AND org_id = ?').get(A.id(b.oppId), req.org.id); if (!o) throw new HttpError(404, 'Opportunité introuvable.'); }
  const set = await B.settings(req.org.id);
  const valid = A.date(b.validUntil) || L.addDays(B.today(), Math.min(Math.max(Math.round(Number(b.validityDays)) || N(set.quoteValidityDays), 1), 365));
  const id = await crm().createDoc(req, { ...b, lines }, 'quote');
  const mt = await computeMeta(req, lines, cp.crole, cp.boss);
  await db.prepare('INSERT INTO cp_quote_meta (doc_id, org_id, opp_id, group_id, version, variant, valid_until, conditions, discount_pct, list_total, approval_required, created_role, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.org.id, b.oppId ? Number(b.oppId) : null, id, A.text(b.variant, 40), valid, A.text(b.conditions, 1500), mt.discount_pct, mt.list_total, mt.approval_required, cp.boss ? 'boss' : cp.crole, req.user.id, nowISO());
  await P.audit(req, 'quote', id, 'create', { discount: mt.discount_pct, approvalRequired: Boolean(mt.approval_required) });
  res.status(201).json({ id, discountPct: mt.discount_pct, approvalRequired: Boolean(mt.approval_required), cap: mt.cap, validUntil: valid });
});
router.put('/quotes/:id', P.need('quote'), async (req, res) => {
  const d = await quoteOf(req, req.params.id);
  const m = await metaOf(d.id);
  if (!m) throw new HttpError(409, "Ce devis a été créé hors du module Commercial : modifiez-le dans Clients et ventes.");
  const b = req.body || {};
  if (b.lines !== undefined) {
    if (d.status !== 'draft') throw new HttpError(400, 'Seul un brouillon change de lignes : créez une nouvelle version.');
    const lines = crm().cleanLines(b.lines);
    const cu = await db.prepare('SELECT * FROM customers WHERE id = ?').get(d.customer_id);
    await pricing().guardLines(req, cu, lines, b.priceOverride, d.number);
    const rate = d.vat_rate === null ? Number(req.org.vat_rate) : Number(d.vat_rate); const incl = Number(d.prices_incl) === 1;
    const t = D.totals(lines, rate, incl);
    await db.prepare('UPDATE documents SET lines = ?, total = ?, subtotal_ht = ?, vat_amount = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(lines), t.total, t.ht, t.vat, nowISO(), d.id);
    const cp = await P.load(req);
    const role = m.created_role || cp.crole; const isBoss = role === 'boss';
    const mt = await computeMeta(req, lines, role, isBoss);
    await db.prepare("UPDATE cp_quote_meta SET discount_pct = ?, list_total = ?, approval_required = ?, approval = 'none', approval_reason = '', approval_comment = '' WHERE doc_id = ?").run(mt.discount_pct, mt.list_total, mt.approval_required, d.id); // toute modification annule une validation antérieure
  }
  if (b.validUntil !== undefined || b.conditions !== undefined || b.variant !== undefined) await db.prepare('UPDATE cp_quote_meta SET valid_until = ?, conditions = ?, variant = ? WHERE doc_id = ?').run(b.validUntil === undefined ? m.valid_until : A.date(b.validUntil), b.conditions === undefined ? m.conditions : A.text(b.conditions, 1500), b.variant === undefined ? m.variant : A.text(b.variant, 40), d.id);
  if (b.note !== undefined) await db.prepare('UPDATE documents SET note = ? WHERE id = ?').run(A.text(b.note, 500), d.id);
  await P.audit(req, 'quote', d.id, 'update', Object.keys(b).join(','));
  res.json({ ok: true });
});
async function clone(req, d, m, { newVersion }) {
  const cp = await P.load(req);
  const lines = parse(d.lines);
  const id = await crm().createDoc(req, { customerId: d.customer_id, lines, note: d.note, vatRate: d.vat_rate === null ? undefined : Number(d.vat_rate), pricesIncl: Number(d.prices_incl) === 1 }, 'quote', { skipFloor: true, vatRate: d.vat_rate === null ? undefined : Number(d.vat_rate), pricesIncl: Number(d.prices_incl) === 1 });
  const mt = await computeMeta(req, lines, cp.crole, cp.boss);
  const version = newVersion ? N(m.version) + 1 : N(m.version);
  await db.prepare('INSERT INTO cp_quote_meta (doc_id, org_id, opp_id, group_id, version, valid_until, conditions, discount_pct, list_total, approval_required, created_role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.org.id, m.opp_id, m.group_id, version, L.addDays(B.today(), N((await B.settings(req.org.id)).quoteValidityDays)), m.conditions, mt.discount_pct, mt.list_total, mt.approval_required, cp.boss ? 'boss' : cp.crole, req.user.id, nowISO());
  return id;
}
router.post('/quotes/:id/version', P.need('quote'), async (req, res) => {
  const d = await quoteOf(req, req.params.id); const m = await metaOf(d.id);
  if (!m) throw new HttpError(409, "Ce devis a été créé hors du module Commercial.");
  const id = await clone(req, d, m, { newVersion: true });
  await db.prepare('UPDATE cp_quote_meta SET superseded = 1 WHERE doc_id = ?').run(d.id);
  await P.audit(req, 'quote', d.id, 'new_version', { to: id });
  res.status(201).json({ id });
});
router.post('/quotes/:id/variant', P.need('quote'), async (req, res) => {
  const d = await quoteOf(req, req.params.id); const m = await metaOf(d.id);
  if (!m) throw new HttpError(409, "Ce devis a été créé hors du module Commercial.");
  const id = await clone(req, d, m, { newVersion: false });
  await db.prepare('UPDATE cp_quote_meta SET variant = ? WHERE doc_id = ?').run(A.text((req.body || {}).variant, 40) || 'Variante', id);
  res.status(201).json({ id });
});
router.post('/quotes/:id/extend', P.need('quote'), async (req, res) => {
  const d = await quoteOf(req, req.params.id); const m = await metaOf(d.id);
  if (!m) throw new HttpError(409, "Ce devis a été créé hors du module Commercial.");
  const b = req.body || {};
  const until = A.date(b.validUntil) || L.addDays(B.today(), Math.min(Math.max(Math.round(Number(b.days)) || 15, 1), 365));
  await db.prepare('UPDATE cp_quote_meta SET valid_until = ? WHERE doc_id = ?').run(until, d.id);
  res.json({ validUntil: until });
});

// ---------- Circuit de validation des remises ----------
router.post('/quotes/:id/request-approval', P.need('quote'), async (req, res) => {
  const d = await quoteOf(req, req.params.id); const m = await metaOf(d.id);
  if (!m || !N(m.approval_required)) throw new HttpError(409, "Cette remise est dans le plafond de votre rôle : aucune validation nécessaire.");
  if (m.approval === 'pending') throw new HttpError(409, 'Une validation est déjà demandée.');
  await db.prepare("UPDATE cp_quote_meta SET approval = 'pending', approval_reason = ?, requested_by = ?, approval_comment = '' WHERE doc_id = ?").run(A.text((req.body || {}).reason, 300), req.user.id, d.id);
  const approvers = await db.prepare("SELECT user_id FROM cp_roles WHERE org_id = ? AND role = 'sales_manager'").all(req.org.id);
  for (const a of approvers) await W.push(req.org.id, Number(a.user_id), 'commercial', `Remise de ${N(m.discount_pct)} % à valider sur le devis ${d.number}`, 'quote:' + d.id);
  await W.pushRole(req.org.id, 'admin', 'commercial', `Remise de ${N(m.discount_pct)} % à valider sur le devis ${d.number}`, 'quote:' + d.id);
  await P.audit(req, 'quote', d.id, 'approval_requested', { discount: N(m.discount_pct) });
  res.json({ ok: true });
});
router.post('/quotes/:id/decide', P.need('approve'), async (req, res) => {
  const d = await quoteOf(req, req.params.id); const m = await metaOf(d.id);
  const b = req.body || {};
  if (!m || m.approval !== 'pending') throw new HttpError(409, "Aucune validation n'est en attente pour ce devis.");
  const decision = A.oneOf(b.decision, ['approve', 'reject'], undefined, 'Décision inconnue (valider ou refuser).');
  const cp = await P.load(req); const set = await B.settings(req.org.id);
  if (decision === 'approve' && N(m.discount_pct) > L.discountCap(cp.crole, cp.boss, set.discountCaps)) throw new HttpError(403, `Remise de ${N(m.discount_pct)} % : au-delà de vos pouvoirs (${L.discountCap(cp.crole, cp.boss, set.discountCaps)} %). Seul le responsable du compte la valide.`);
  if (decision === 'reject' && !A.text(b.comment, 300)) throw new HttpError(400, 'Indiquez la raison du refus.');
  await db.prepare('UPDATE cp_quote_meta SET approval = ?, approval_comment = ?, decided_by = ?, decided_at = ? WHERE doc_id = ?').run(decision === 'approve' ? 'approved' : 'rejected', A.text(b.comment, 300), req.user.id, nowISO(), d.id);
  await W.push(req.org.id, Number(m.requested_by || m.created_by), 'commercial', `Remise ${decision === 'approve' ? 'validée' : 'refusée'} sur le devis ${d.number}`, 'quote:' + d.id);
  await P.audit(req, 'quote', d.id, decision === 'approve' ? 'approved' : 'rejected', { discount: N(m.discount_pct), comment: A.text(b.comment, 300) });
  await W.audit(req, 'quote_discount', d.id, decision, null, { discount: N(m.discount_pct) });
  res.json({ ok: true });
});
router.get('/quotes-approvals', P.need('approve'), async (req, res) => {
  const names = await B.names(req.org.id);
  const rows = await db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id JOIN cp_quote_meta m ON m.doc_id = d.id WHERE d.org_id = ? AND m.approval = 'pending'").all(req.org.id);
  const out = []; for (const d of rows) out.push(view(d, await metaOf(d.id), names, { lines: undefined }));
  res.json({ quotes: out });
});

/** Appelé par le module Clients et ventes : un devis dont la remise dépasse le plafond ne part, ne s'accepte et ne devient commande qu'une fois validé. */
async function guardSend(req, d) {
  const m = await metaOf(d.id);
  if (!m) return;
  if (N(m.approval_required) && m.approval !== 'approved') throw new HttpError(409, `Remise de ${N(m.discount_pct)} % : validation du responsable commercial requise avant l'envoi (état : ${m.approval === 'pending' ? 'en attente' : m.approval === 'rejected' ? 'refusée' : 'non demandée'}).`);
  if (m.valid_until && m.valid_until < B.today() && d.status === 'draft') throw new HttpError(409, 'Ce devis a dépassé sa date de validité : prolongez-le avant de l’envoyer.');
}
async function onQuoteStatus(req, d, status) {
  if (['sent', 'accepted'].includes(status)) await guardSend(req, d);
  const m = await metaOf(d.id);
  if (!m) return;
  if (status === 'sent' && !m.sent_at) await db.prepare('UPDATE cp_quote_meta SET sent_at = ? WHERE doc_id = ?').run(nowISO(), d.id);
  if (status === 'accepted') await db.prepare('UPDATE cp_quote_meta SET accepted_at = COALESCE(accepted_at, ?) WHERE doc_id = ?').run(nowISO(), d.id);
  if (status === 'refused') await db.prepare('UPDATE cp_quote_meta SET refused_at = COALESCE(refused_at, ?) WHERE doc_id = ?').run(nowISO(), d.id);
}

// ---------- Lien d'acceptation, relance ----------
router.post('/quotes/:id/link', P.need('quote'), async (req, res) => {
  const d = await quoteOf(req, req.params.id); const m = await metaOf(d.id);
  if (!m) throw new HttpError(409, "Ce devis a été créé hors du module Commercial.");
  if (!['draft', 'sent'].includes(d.status)) throw new HttpError(409, 'Ce devis est déjà accepté ou refusé.');
  let token = m.accept_token;
  if (!token) { token = crypto.randomBytes(24).toString('hex'); await db.prepare('UPDATE cp_quote_meta SET accept_token = ? WHERE doc_id = ?').run(token, d.id); }
  res.json({ token, path: `/devis/${token}`, note: "Acceptation simple par le client (nom et horodatage conservés) ; ce n'est pas une signature électronique qualifiée." });
});
router.delete('/quotes/:id/link', P.need('quote'), async (req, res) => {
  const d = await quoteOf(req, req.params.id);
  await db.prepare('UPDATE cp_quote_meta SET accept_token = NULL WHERE doc_id = ?').run(d.id);
  res.json({ ok: true });
});
router.post('/quotes/:id/followup', P.need('activity'), async (req, res) => {
  const d = await quoteOf(req, req.params.id);
  if (d.status !== 'sent') throw new HttpError(409, 'Seul un devis envoyé et sans réponse se relance.');
  let cad = req.body && req.body.cadenceId ? await db.prepare("SELECT * FROM cp_cadences WHERE id = ? AND org_id = ? AND target = 'quote'").get(A.id(req.body.cadenceId), req.org.id) : await db.prepare("SELECT * FROM cp_cadences WHERE org_id = ? AND target = 'quote' AND active = 1 ORDER BY id LIMIT 1").get(req.org.id);
  if (!cad) {
    const steps = [{ day: 0, channel: 'whatsapp', text: 'Bonjour {prenom}, avez-vous pu consulter notre devis {numero} de {montant} ?' }, { day: 4, channel: 'whatsapp', text: 'Bonjour {prenom}, je reviens vers vous au sujet du devis {numero}. Souhaitez-vous des précisions ?' }, { day: 9, channel: 'task', text: 'Appeler {prenom} : devis {numero} sans réponse' }];
    const id = (await db.prepare("INSERT INTO cp_cadences (org_id, name, target, steps, created_by, created_at) VALUES (?, 'Relance de devis', 'quote', ?, ?, ?)").run(req.org.id, JSON.stringify(steps), req.user.id, nowISO())).lastInsertRowid;
    cad = await db.prepare('SELECT * FROM cp_cadences WHERE id = ?').get(id);
  }
  if (await db.prepare("SELECT 1 FROM cp_cadence_runs WHERE cadence_id = ? AND doc_id = ? AND state IN ('active','sending')").get(cad.id, d.id)) throw new HttpError(409, 'Une relance est déjà en cours pour ce devis.');
  const id = (await db.prepare('INSERT INTO cp_cadence_runs (org_id, cadence_id, doc_id, step_idx, next_at, started_by, started_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)').run(req.org.id, cad.id, d.id, nowISO(), req.user.id, nowISO(), nowISO())).lastInsertRowid;
  res.status(201).json({ runId: Number(id), cadenceId: Number(cad.id) });
});

// ---------- Acceptation publique par lien secret ----------
const publicLimit = limits.make(10 * 60 * 1000, 40, 'Trop de requêtes. Réessayez dans quelques minutes.');
const byToken = async (token) => {
  if (!/^[a-f0-9]{48}$/.test(String(token))) throw new HttpError(404, 'Lien introuvable ou expiré.');
  const m = await db.prepare('SELECT * FROM cp_quote_meta WHERE accept_token = ?').get(token);
  if (!m) throw new HttpError(404, 'Lien introuvable ou expiré.');
  const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(m.doc_id);
  const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(m.org_id);
  return { m, d, org };
};
pub.get('/quote/:token', publicLimit, async (req, res) => {
  const { m, d, org } = await byToken(req.params.token);
  const cu = await db.prepare('SELECT name FROM customers WHERE id = ?').get(d.customer_id);
  const a = D.amounts(d, org);
  const expired = Boolean(m.valid_until && m.valid_until < B.today());
  if (!m.viewed_at) {
    await db.prepare('UPDATE cp_quote_meta SET viewed_at = ? WHERE doc_id = ?').run(nowISO(), d.id);
    if (m.created_by) await W.push(org.id, Number(m.created_by), 'commercial', `Le client a ouvert le devis ${d.number}.`, 'quote:' + d.id);
  }
  res.json({ organisation: org.name, currency: org.currency, number: d.number, customer: cu ? cu.name : '', issued: d.issued, lines: parse(d.lines).map((l) => ({ label: l.label, quantity: l.quantity, price: l.price })), subtotalHt: a.ht, vatRate: a.rate, vatAmount: a.vat, total: N(d.total), validUntil: m.valid_until, conditions: m.conditions, status: d.status, expired, canAnswer: d.status === 'sent' && !expired && !N(m.superseded) && m.approval !== 'pending' && m.approval !== 'rejected', acceptedAt: m.accepted_at, acceptedName: m.accepted_name });
});
async function answer(req, res, accept) {
  const { m, d, org } = await byToken(req.params.token);
  if (d.status !== 'sent') throw new HttpError(409, d.status === 'draft' ? "Ce devis n'a pas encore été envoyé." : 'Ce devis a déjà reçu une réponse.');
  if (m.valid_until && m.valid_until < B.today()) throw new HttpError(410, 'Ce devis a dépassé sa date de validité : demandez-en un nouveau.');
  if (N(m.superseded)) throw new HttpError(410, 'Une version plus récente de ce devis existe.');
  const name = A.text((req.body || {}).name, 100, { required: accept, msg: 'Indiquez votre nom pour accepter le devis.' });
  if (accept && name.length < 2) throw new HttpError(400, 'Indiquez votre nom pour accepter le devis.');
  const claim = await db.prepare("UPDATE documents SET status = ?, updated_at = ? WHERE id = ? AND status = 'sent'").run(accept ? 'accepted' : 'refused', nowISO(), d.id);
  if (!claim.changes) throw new HttpError(409, 'Ce devis a déjà reçu une réponse.');
  if (accept) await db.prepare('UPDATE cp_quote_meta SET accepted_at = ?, accepted_name = ? WHERE doc_id = ?').run(nowISO(), name, d.id);
  else await db.prepare('UPDATE cp_quote_meta SET refused_at = ?, refuse_reason = ? WHERE doc_id = ?').run(nowISO(), A.text((req.body || {}).reason, 300), d.id);
  const txt = accept ? `Devis ${d.number} accepté par ${name}. À transformer en commande.` : `Devis ${d.number} refusé par le client.`;
  if (m.created_by) await W.push(org.id, Number(m.created_by), 'commercial', txt, 'quote:' + d.id);
  await W.pushRole(org.id, 'manager', 'commercial', txt, 'quote:' + d.id);
  await db.prepare("UPDATE cp_cadence_runs SET state = 'stopped', stop_reason = ?, updated_at = ? WHERE doc_id = ? AND state = 'active'").run(accept ? 'accepted' : 'refused', nowISO(), d.id);
  res.json({ ok: true, status: accept ? 'accepted' : 'refused' });
}
pub.post('/quote/:token/accept', publicLimit, (req, res) => answer(req, res, true));
pub.post('/quote/:token/refuse', publicLimit, (req, res) => answer(req, res, false));

module.exports = { router, pub, guardSend, onQuoteStatus };
