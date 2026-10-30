'use strict';
// Négociation des prix par l'assistant commercial public : LE SERVEUR DÉCIDE, jamais l'IA seule.
// - Règles par organisation : activer/désactiver, nombre maximum de contre-offres, seuil de remise (en % du prix de liste) au-delà duquel un responsable
//   doit valider la commande, message de passage de relais.
// - L'IA reçoit, pour les articles évoqués, le prix de départ et UNIQUEMENT le prochain palier de concession autorisé (jamais le plancher brut).
// - Tout prix annoncé ou enregistré est validé ici : sous le plancher = refusé (repli : un conseiller reprend la main) ; la commande porte le prix accepté
//   (journal), l'indicateur « négocié » et le % de remise ; au-delà du seuil elle passe « à valider » avec une demande dans le circuit de décisions.
// - Journal de négociation par conversation et par commande : offres, contre-offres, prix accepté, auteur (client, assistant, humain).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const P = require('./pricing');
const { HttpError, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const DEFAULT_HANDOFF = "Pour cette demande de prix, un conseiller va vous répondre directement : il étudiera votre situation. Merci de votre patience.";
const ACTORS = { customer: 'Client', assistant: 'Assistant', human: 'Équipe' };

async function settingsOf(orgId) {
  const r = await db.prepare('SELECT * FROM neg_settings WHERE org_id = ?').get(orgId);
  return { enabled: Boolean(r && r.enabled), maxCounters: r ? Number(r.max_counters) : 3, approvalPct: r ? Number(r.approval_pct) : 10, handoffMessage: (r && r.handoff_message) || '' };
}
const handoffText = (s) => s.handoffMessage || DEFAULT_HANDOFF;
const money = (n, org) => `${Number(n).toLocaleString('fr-FR')} ${org.currency}`.replace(/[  ]/g, ' ');

async function log(orgId, e) {
  await db.prepare('INSERT INTO neg_log (org_id, chat_id, doc_id, item_id, item_label, actor, kind, price, quantity, discount_pct, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(orgId, e.chatId || null, e.docId || null, e.itemId || null, oneLine(e.label || '', 150), e.actor, e.kind, e.price == null ? null : Math.round(e.price), e.quantity || 1, e.pct || 0, oneLine(e.note || '', 300), e.userId || null, nowISO());
}
const entryView = (r) => ({ id: r.id, chatId: r.chat_id, docId: r.doc_id, item: r.item_label, actor: r.actor, actorLabel: ACTORS[r.actor] || r.actor, kind: r.kind, price: r.price == null ? null : Number(r.price), quantity: Number(r.quantity), discountPct: Number(r.discount_pct) || 0, note: r.note, user: r.user || null, at: r.created_at });
const entries = async (orgId, where, ...args) => (await db.prepare(`SELECT l.*, u.name AS user FROM neg_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? AND ${where} ORDER BY l.id LIMIT 200`).all(orgId, ...args)).map(entryView);
/** Journal d'une conversation (y compris les lignes liées à ses commandes). */
const logOfChat = (orgId, chatId) => entries(orgId, '(l.chat_id = ? OR l.doc_id IN (SELECT id FROM documents WHERE chat_id = ?))', chatId, chatId);
const logOfDoc = (orgId, docId) => entries(orgId, '(l.doc_id = ? OR l.chat_id = (SELECT chat_id FROM documents WHERE id = ? AND org_id = l.org_id))', docId, docId);

const pctOf = (list, price) => (list > 0 ? Math.round((1 - price / list) * 1000) / 10 : 0);
const findItem = (catalog, name) => { const w = P.norm(name); return w ? catalog.find((c) => P.norm(c.name) === w) || catalog.find((c) => P.norm(c.name).includes(w) || w.includes(P.norm(c.name))) : null; };
const lastPrice = async (orgId, chatId, itemId, kinds) => await db.prepare(`SELECT price FROM neg_log WHERE org_id = ? AND chat_id = ? AND item_id = ? AND actor = 'assistant' AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(orgId, chatId, itemId, ...kinds);
const countersUsed = async (orgId, chatId, itemId) => Number((await db.prepare("SELECT COUNT(*) c FROM neg_log WHERE org_id = ? AND chat_id = ? AND item_id = ? AND actor = 'assistant' AND kind = 'counter'").get(orgId, chatId, itemId)).c);

/** Contexte donné à l'IA pour les articles évoqués : jamais le plancher, seulement le prochain palier autorisé. */
async function contextFor(org, chat, customer, catalog, recentTexts) {
  const s = await settingsOf(org.id);
  const hay = P.norm(recentTexts.join(' '));
  const mentioned = catalog.filter((c) => { const n = P.norm(c.name); return n && hay.includes(n); }).slice(0, 6);
  const head = s.enabled
    ? `NÉGOCIATION : autorisée, dans les limites ci-dessous seulement. Tu ne décides d'AUCUN prix : tu proposes l'action "negotiate" et le système valide puis ajoute le prix exact. Maximum ${s.maxCounters} contre-offre(s) par article. Au-delà, ou si la personne veut descendre plus bas : "handoff".`
    : "NÉGOCIATION : désactivée. Les prix du catalogue sont fermes : ne propose aucune remise ; si la personne en demande une, utilise \"handoff\".";
  const lines = [head, "Quand le « prix de départ » d'un article diffère du catalogue, c'est lui qui s'applique à cette personne (palier de quantité, prix négocié ou remise de fidélité)."];
  for (const it of mentioned) {
    const pf = await P.priceFor(org, it, customer && customer.id ? { id: customer.id, default_discount: customer.default_discount } : null, 1, s.maxCounters);
    const used = await countersUsed(org.id, chat.id, it.id);
    let t = `- ${oneLine(it.name, 80)} : prix de départ ${money(pf.reference, org)} (${pf.reason})`;
    const tiers = P.readTiers(it.tiers);
    if (tiers.length) t += `, paliers publics : ${tiers.map((x) => `${money(x.price, org)} l'unité à partir de ${x.min} unités`).join(' ; ')}`;
    if (!s.enabled || !pf.negotiable) t += ' ; prix ferme, non négociable.';
    else {
      const next = pf.steps[used];
      t += ` ; contre-offres déjà faites : ${used}/${Math.min(s.maxCounters, pf.steps.length)}`;
      t += next && used < s.maxCounters ? ` ; prochain palier autorisé (le plus bas que tu puisses proposer maintenant) : ${money(next, org)} l'unité.` : ' ; plus aucun palier : le dernier prix est atteint, passe la main si la personne insiste.';
    }
    lines.push(t);
  }
  if (!mentioned.length) lines.push("(Aucun article évoqué pour l'instant : aucune marge à communiquer.)");
  return lines.join('\n');
}

/**
 * Valide et décide une étape de négociation demandée par l'IA : action { type: 'negotiate', item, quantity, customer_offer, price, decision }.
 * Renvoie { text, replace, handoff, decision, price, itemId } ou null si l'article n'est pas reconnu.
 */
async function negotiate(org, chat, customer, a, catalog) {
  const s = await settingsOf(org.id);
  const it = findItem(catalog, a.item);
  if (!it) return null;
  const qty = Number(a.quantity) > 0 && Number(a.quantity) <= 10000 ? Number(a.quantity) : 1;
  const offer = Number(a.customer_offer) > 0 ? Math.round(Number(a.customer_offer)) : 0;
  const claimed = Number(a.price) > 0 ? Math.round(Number(a.price)) : 0;
  const cu = customer && customer.id ? { id: customer.id, default_discount: customer.default_discount } : null;
  const pf = await P.priceFor(org, it, cu, qty, s.maxCounters);
  const base = { orgId: org.id, chatId: chat.id, itemId: it.id, label: it.name, quantity: qty };
  const per = (price) => `${money(price, org)} l'unité${qty > 1 ? ` (soit ${money(price * qty, org)} pour ${qty})` : ''}`;
  if (offer) await log(org.id, { ...base, actor: 'customer', kind: 'offer', price: offer, pct: pctOf(pf.list, offer) });
  // Prix annoncé par l'IA sous le meilleur prix autorisé : refusé, repli = un conseiller reprend la main.
  const allowedBest = s.enabled ? pf.best : pf.reference;
  if (claimed && claimed < allowedBest) {
    await log(org.id, { ...base, actor: 'assistant', kind: 'refused', price: claimed, note: 'prix annoncé sous le minimum autorisé : refusé par le serveur' });
    return { text: handoffText(s), replace: true, handoff: true, decision: 'refused', itemId: it.id };
  }
  if (!s.enabled || !pf.negotiable) {
    const wants = offer && offer < pf.reference;
    await log(org.id, { ...base, actor: 'assistant', kind: 'refused', price: pf.reference, note: s.enabled ? 'article non négociable' : 'négociation désactivée' });
    return { text: `Le prix de ${it.name} est ferme : ${per(pf.reference)}.${wants ? ' ' + handoffText(s) : ''}`, replace: true, handoff: Boolean(wants), decision: 'refused', price: pf.reference, itemId: it.id };
  }
  const used = await countersUsed(org.id, chat.id, it.id);
  const lastOffered = await lastPrice(org.id, chat.id, it.id, ['counter']);
  const ladder = lastOffered && Number(lastOffered.price) >= pf.best ? Math.min(Number(lastOffered.price), pf.reference) : pf.reference;
  const next = used < s.maxCounters ? pf.steps.find((p) => p < ladder) : undefined;
  let d; let price; let text; let handoff = false;
  if (offer && offer >= (next === undefined ? ladder : next)) {
    d = 'accept'; price = Math.min(offer, ladder); // jamais plus haut que ce qui a été offert, jamais sous le plancher
    text = `C'est d'accord : ${it.name} à ${per(price)}. Si vous confirmez, j'enregistre votre commande à ce prix.`;
  } else if (next !== undefined) {
    d = 'counter'; price = next;
    text = `Je peux vous proposer ${it.name} à ${per(price)}. Si cela vous convient, dites-le moi et j'enregistre votre commande.`;
  } else {
    d = 'final'; price = ladder; handoff = Boolean(offer);
    text = `Mon dernier prix pour ${it.name} est de ${per(price)}, je ne peux pas descendre plus bas.${offer ? ' ' + handoffText(s) : ''}`;
  }
  const kind = d === 'accept' ? 'accept' : d === 'counter' ? 'counter' : 'final';
  await log(org.id, { ...base, actor: 'assistant', kind, price, pct: pctOf(pf.list, price), note: claimed && claimed !== price ? `prix de l'IA (${claimed}) remplacé par le prix validé` : '' });
  // L'IA a annoncé le même prix : on garde son message et on ajoute la ligne validée ; sinon le message du serveur le remplace.
  const same = claimed === price;
  return { text: same ? `Prix validé : ${per(price)}.` : text, replace: !same, handoff, decision: d, price, itemId: it.id };
}

/** Prix d'une ligne de commande de l'assistant : le prix accepté dans la conversation (jamais celui que l'IA annonce seul). */
async function priceOrderLine(org, chat, customerId, it, qty, claimed, s) {
  const cu = customerId ? await db.prepare('SELECT id, default_discount FROM customers WHERE id = ?').get(customerId) : null;
  const pf = await P.priceFor(org, it, cu, qty, s.maxCounters);
  const allowedBest = s.enabled ? pf.best : pf.reference;
  if (claimed && claimed < allowedBest) return { refused: true, pf };
  let unit = pf.reference; let note = '';
  const acc = chat ? await lastPrice(org.id, chat.id, it.id, ['accept']) : null;
  if (acc && s.enabled && pf.negotiable) unit = Math.min(pf.reference, Math.max(Number(acc.price), pf.best));
  else if (claimed && claimed < pf.reference) note = 'remise non confirmée : prix de référence appliqué';
  return { unit, pf, negotiated: unit < pf.reference, note };
}

/** Demande de validation d'une commande remisée dans le circuit de décisions existant (avec notification interne et e-mail). */
async function requestApproval(org, doc, pct, customerName) {
  const D = require('./decisions');
  const title = `Remise de ${pct} % sur la commande ${doc.number}`;
  const levels = await D.circuitFor(org.id, doc.total);
  const did = Number((await db.prepare('INSERT INTO decisions (org_id, title, detail, amount, requested_by, link_kind, link_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(org.id, title, oneLine(`Commande négociée par l'assistant commercial pour ${customerName}. Remise de ${pct} % sur le prix de liste.`, 400), doc.total, org.owner_id, 'order', doc.id, nowISO())).lastInsertRowid);
  let n = 1;
  for (const role of levels) await db.prepare('INSERT INTO decision_steps (decision_id, org_id, step_no, role) VALUES (?, ?, ?, ?)').run(did, org.id, n++, role);
  await db.prepare("UPDATE documents SET approval = 'needed', decision_id = ? WHERE id = ?").run(did, doc.id);
  await W.pushRole(org.id, levels[0] || 'manager', 'decision', `Commande à valider par un responsable : ${doc.number} (${customerName}), remise de ${pct} %, total ${money(doc.total, org)}.`, 'decision:' + did);
  return did;
}

/** Appelé par decisions.js quand la demande liée à une commande est tranchée. */
async function onOrderDecision(req, d, final) {
  const ok = final === 'approved';
  await db.prepare('UPDATE documents SET approval = ?, updated_at = ? WHERE id = ? AND org_id = ?').run(ok ? 'approved' : 'rejected', nowISO(), d.link_id, req.org.id);
  const doc = await db.prepare('SELECT chat_id, number FROM documents WHERE id = ? AND org_id = ?').get(d.link_id, req.org.id);
  await log(req.org.id, { docId: d.link_id, chatId: doc && doc.chat_id, label: doc ? doc.number : '', actor: 'human', kind: ok ? 'approved' : 'rejected', userId: req.user.id, note: ok ? 'remise validée par un responsable' : 'remise refusée par un responsable' });
}

/**
 * Surveille le texte de l'IA : un montant en monnaie de l'organisation, au prix plausible d'un article cité, mais sous le meilleur prix autorisé, est refusé.
 * (Garde-fou en plus de la validation des actions : une phrase libre ne peut pas promettre un prix que le serveur n'autorise pas.)
 */
async function guardReply(org, chat, customer, reply, catalog, s) {
  const text = String(reply || '');
  const cur = String(org.currency || 'FCFA').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\d[\\d  .,]*\\d|\\d)\\s*(?:${cur}|F\\s?CFA|FCFA|XAF|XOF|francs?)`, 'gi');
  const amounts = [...text.matchAll(re)].map((m) => Number(m[1].replace(/[\s .,]/g, ''))).filter((n) => n > 0);
  if (!amounts.length) return null;
  const norm = P.norm(text);
  for (const it of catalog) {
    const n = P.norm(it.name);
    if (!n || !norm.includes(n)) continue;
    const pf = await P.priceFor(org, it, customer && customer.id ? { id: customer.id, default_discount: customer.default_discount } : null, 1, s.maxCounters);
    const min = s.enabled ? pf.best : pf.reference;
    if (amounts.some((x) => x < min && x >= pf.list * 0.3)) return it;
  }
  return null;
}

// ---------- Routes (sous /sales/negotiation : responsables ; réglages : administrateurs) ----------
router.get('/', A.need('manager'), async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const c = async (kind) => Number((await db.prepare('SELECT COUNT(*) c FROM neg_log WHERE org_id = ? AND kind = ? AND created_at >= ?').get(req.org.id, kind, since)).c);
  res.json({
    settings: await settingsOf(req.org.id), defaultHandoff: DEFAULT_HANDOFF,
    stats: { offers: await c('offer'), counters: await c('counter'), accepted: await c('accept'), refused: await c('refused'), overrides: await c('override') },
    log: (await db.prepare('SELECT l.*, u.name AS user FROM neg_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 60').all(req.org.id)).map(entryView),
  });
});
router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {}; const cur = await settingsOf(req.org.id);
  const enabled = b.enabled === undefined ? cur.enabled : Boolean(b.enabled);
  const max = b.maxCounters === undefined ? cur.maxCounters : Number(b.maxCounters);
  if (!Number.isInteger(max) || max < 1 || max > 6) throw new HttpError(400, 'Le nombre de contre-offres doit être un entier entre 1 et 6.');
  const pct = b.approvalPct === undefined ? cur.approvalPct : Number(String(b.approvalPct).replace(',', '.'));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'Le seuil de validation est un pourcentage entre 0 et 100.');
  const msg = b.handoffMessage === undefined ? cur.handoffMessage : A.text(b.handoffMessage, 400);
  await db.prepare(`INSERT INTO neg_settings (org_id, enabled, max_counters, approval_pct, handoff_message, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, max_counters = EXCLUDED.max_counters, approval_pct = EXCLUDED.approval_pct, handoff_message = EXCLUDED.handoff_message, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, enabled ? 1 : 0, max, pct, msg, nowISO());
  await W.audit(req, 'negotiation', null, 'update', cur, { enabled, maxCounters: max, approvalPct: pct, handoffMessage: msg });
  await A.logActivity(req.org.id, req.user.id, 'sales', `Négociation de l'assistant ${enabled ? 'activée' : 'désactivée'}`);
  res.json({ ok: true, settings: await settingsOf(req.org.id) });
});

module.exports = { router, settingsOf, handoffText, DEFAULT_HANDOFF, log, logOfChat, logOfDoc, contextFor, negotiate, priceOrderLine, requestApproval, onOrderDecision, guardReply, findItem, pctOf, money };
