'use strict';
// Qualification BANT (Budget, Autorité, Besoin, Délai) d'un prospect ou d'une opportunité : note de 0 à 4 par critère, score de 0 à 100.
// L'IA peut SUGGÉRER une note d'après la conversation WhatsApp : la suggestion est rangée à part et ne compte JAMAIS tant qu'un humain ne l'a pas validée.
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const { HttpError, oneLine } = require('../../util');

const router = express.Router({ mergeParams: true });
const TABLE = { lead: 'cp_leads', opp: 'cp_opps' };
const parse = (s) => { try { const j = JSON.parse(s || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };

async function rowOf(req, kind, id) {
  const table = TABLE[kind];
  if (!table) throw new HttpError(404, 'Type de fiche inconnu.');
  const r = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`).get(A.id(id), req.org.id);
  if (!r) throw new HttpError(404, 'Fiche introuvable.');
  await P.mustOwn(req, r);
  return r;
}
const view = (row, set) => {
  const bant = parse(row.bant);
  return { bant, score: L.bantScore(bant, set.bantWeights), weights: set.bantWeights };
};
const clean = (c, prev, userId) => {
  const rating = Math.round(Number(c.rating));
  if (!Number.isFinite(rating) || rating < 0 || rating > 4) throw new HttpError(400, 'La note BANT va de 0 (inconnu) à 4 (confirmé).');
  return { ...(prev || {}), rating, note: oneLine(c.note || '', 300), validated: true, validatedBy: userId, validatedAt: nowISO(), suggestion: undefined };
};

router.get('/bant/:kind/:id', P.need('view'), async (req, res) => {
  const row = await rowOf(req, req.params.kind, req.params.id);
  res.json(view(row, await B.settings(req.org.id)));
});

// Saisie humaine : chaque critère envoyé est noté ET validé par la personne connectée.
router.put('/bant/:kind/:id', P.need('write'), async (req, res) => {
  const row = await rowOf(req, req.params.kind, req.params.id);
  const set = await B.settings(req.org.id);
  const bant = parse(row.bant);
  const b = req.body || {};
  let n = 0;
  for (const k of L.BANT_KEYS) if (b[k] !== undefined) { bant[k] = clean(b[k] || {}, bant[k], req.user.id); n++; }
  if (!n) throw new HttpError(400, 'Indiquez au moins un critère (budget, authority, need, timing).');
  const score = L.bantScore(bant, set.bantWeights);
  await db.prepare(`UPDATE ${TABLE[req.params.kind]} SET bant = ?, bant_score = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(bant), score, nowISO(), row.id);
  await P.audit(req, 'bant_' + req.params.kind, row.id, 'update', { score, criteria: Object.keys(b).filter((k) => L.BANT_KEYS.includes(k)) });
  if (req.params.kind === 'lead') await require('./prospect').rescore(req.org.id, row.id).catch(() => {});
  res.json({ bant, score });
});

// ---------- Suggestion à partir de la conversation WhatsApp (jamais définitive) ----------
const RX = {
  amount: /\b\d[\d\s.,]*\s?(k|m|millions?|mille)?\s?(fcfa|xaf|f\s?cfa|francs?|cfa)\b/i,
  budgetOk: /\b(budget|j'ai (l'argent|les moyens)|disponible|valid[ée]|approuv[ée])\b/i,
  boss: /\b(g[ée]rant|directeur|directrice|patron(ne)?|propri[ée]taire|dg\b|pdg|je d[ée]cide|c'est moi qui)/i,
  asks: /\b(je dois (en )?(parler|demander)|mon (chef|patron|sup[ée]rieur)|ma direction|mon associ[ée]|je vous reviens)/i,
  want: /\b(je (veux|cherche|voudrais)|besoin de|j'ai besoin|il me faut|nous cherchons)/i,
  urgent: /\b(urgent|aujourd'hui|demain|d[èe]s que possible|cette semaine|tout de suite)/i,
  month: /\b(ce mois|le mois prochain|dans \d+ (jours?|semaines?)|fin du mois|d'ici)/i,
};
function suggestFrom(lead, texts, customer) {
  const all = texts.join('\n');
  const out = {};
  const bits = [];
  const has = (v) => v && String(v).trim();
  // Budget
  if (has(lead.budget) || RX.amount.test(all)) out.budget = { rating: RX.budgetOk.test(all) ? 3 : 2, evidence: has(lead.budget) ? `Budget cité : ${lead.budget}` : 'Un montant est évoqué dans la conversation.' };
  else out.budget = { rating: 0, evidence: 'Aucun budget évoqué.' };
  // Autorité
  if (RX.boss.test(all) || (customer && /g[ée]rant|directeur|patron/i.test(customer.notes || ''))) out.authority = { rating: 3, evidence: 'La personne se présente comme décisionnaire.' };
  else if (RX.asks.test(all)) out.authority = { rating: 1, evidence: 'La personne doit consulter quelqu’un avant de décider.' };
  else out.authority = { rating: 0, evidence: 'Pouvoir de décision inconnu.' };
  // Besoin
  if (has(lead.need) && has(lead.quantity)) out.need = { rating: 4, evidence: `Besoin précis : ${lead.need} (${lead.quantity}).` };
  else if (has(lead.need)) out.need = { rating: 3, evidence: `Besoin exprimé : ${lead.need}.` };
  else if (RX.want.test(all)) out.need = { rating: 2, evidence: 'Une demande est formulée mais reste vague.' };
  else out.need = { rating: 0, evidence: 'Besoin non exprimé.' };
  // Délai
  if (has(lead.deadline) && RX.urgent.test(lead.deadline + ' ' + all)) out.timing = { rating: 4, evidence: `Échéance proche : ${lead.deadline || 'urgent'}.` };
  else if (has(lead.deadline) || RX.month.test(all)) out.timing = { rating: 3, evidence: `Échéance indiquée : ${lead.deadline || 'à court terme'}.` };
  else if (RX.urgent.test(all)) out.timing = { rating: 3, evidence: 'Urgence exprimée dans la conversation.' };
  else out.timing = { rating: 0, evidence: 'Aucune échéance.' };
  for (const k of L.BANT_KEYS) bits.push(`${k}:${out[k].rating}`);
  return out;
}

async function chatOf(req, kind, row) {
  let chatId = kind === 'lead' ? row.chat_id : null;
  let customerId = row.customer_id || null;
  if (kind === 'opp' && row.lead_id) { const l = await db.prepare('SELECT chat_id FROM cp_leads WHERE id = ?').get(row.lead_id); if (l) chatId = l.chat_id; }
  if (!chatId && customerId) { const c = await db.prepare("SELECT id FROM chats WHERE org_id = ? AND customer_id = ? ORDER BY updated_at DESC LIMIT 1").get(req.org.id, customerId); if (c) chatId = c.id; }
  return chatId ? await db.prepare('SELECT * FROM chats WHERE id = ? AND org_id = ?').get(chatId, req.org.id) : null;
}
router.post('/bant/:kind/:id/suggest', P.need('write'), async (req, res) => {
  const kind = req.params.kind;
  const row = await rowOf(req, kind, req.params.id);
  const chat = await chatOf(req, kind, row);
  if (!chat) throw new HttpError(404, "Aucune conversation WhatsApp n'est liée à cette fiche : saisissez les critères à la main.");
  const lead = parse(chat.lead);
  const texts = (await db.prepare("SELECT content FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 40").all(chat.id)).map((m) => m.content.replace(/^\[(message vocal|image #\d+|document #\d+)\]\s*/, ''));
  const customer = row.customer_id ? await db.prepare('SELECT notes FROM customers WHERE id = ?').get(row.customer_id) : null;
  const sug = suggestFrom(lead, texts, customer);
  const bant = parse(row.bant);
  for (const k of L.BANT_KEYS) bant[k] = { ...(bant[k] || { rating: 0, validated: false }), suggestion: { ...sug[k], source: 'whatsapp', chatId: Number(chat.id), at: nowISO() } };
  // Seules les suggestions sont écrites : rating, validated et score restent ceux de l'humain.
  await db.prepare(`UPDATE ${TABLE[kind]} SET bant = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(bant), nowISO(), row.id);
  await P.audit(req, 'bant_' + kind, row.id, 'suggest', 'suggestion issue de la conversation WhatsApp, à valider');
  res.json({ suggestion: sug, needsValidation: true, ...view({ bant: JSON.stringify(bant) }, await B.settings(req.org.id)) });
});
// Validation humaine d'une suggestion (tout ou partie), éventuellement avec une note corrigée.
router.post('/bant/:kind/:id/validate', P.need('write'), async (req, res) => {
  const kind = req.params.kind;
  const row = await rowOf(req, kind, req.params.id);
  const set = await B.settings(req.org.id);
  const bant = parse(row.bant);
  const b = req.body || {};
  const keys = (Array.isArray(b.criteria) && b.criteria.length ? b.criteria : L.BANT_KEYS).filter((k) => L.BANT_KEYS.includes(k));
  let n = 0;
  for (const k of keys) {
    const c = bant[k];
    if (!c || !c.suggestion) continue;
    const rating = b.ratings && b.ratings[k] !== undefined ? b.ratings[k] : c.suggestion.rating;
    bant[k] = clean({ rating, note: c.suggestion.evidence }, c, req.user.id); n++;
  }
  if (!n) throw new HttpError(400, 'Aucune suggestion à valider : demandez d’abord une suggestion.');
  const score = L.bantScore(bant, set.bantWeights);
  await db.prepare(`UPDATE ${TABLE[kind]} SET bant = ?, bant_score = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(bant), score, nowISO(), row.id);
  await P.audit(req, 'bant_' + kind, row.id, 'validate', { score, criteria: keys });
  if (kind === 'lead') await require('./prospect').rescore(req.org.id, row.id).catch(() => {});
  res.json({ bant, score });
});

module.exports = { router, suggestFrom, parse };
