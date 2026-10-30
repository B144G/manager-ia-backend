'use strict';
// Sous-application « Marketing » : campagnes (liées à l'assistant commercial par leur code), dépenses, calendrier de contenu, offres.
// Ouverte à toute l'équipe ; la création/suppression de campagnes, les dépenses et la suppression des offres sont réservées aux responsables.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError, oneLine } = require('../util');

const money0 = (v) => (v === undefined || v === null || v === '' || Number(v) === 0 ? 0 : A.amount(v));
const router = express.Router({ mergeParams: true });

const CHANNELS = ['whatsapp', 'facebook', 'instagram', 'tiktok', 'poster', 'radio', 'wordofmouth', 'other'];
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', poster: 'Affiche', radio: 'Radio', wordofmouth: 'Bouche-à-oreille', other: 'Autre' };
const STATUSES = ['draft', 'active', 'ended'];
const STATUS_LABEL = { draft: 'Brouillon', active: 'Active', ended: 'Terminée' };
const POST_STATUSES = ['idea', 'ready', 'published'];
const today = () => nowISO().slice(0, 10);

function code(v) {
  const c = A.text(v, 40);
  if (c && !/^[A-Za-z0-9_-]+$/.test(c)) throw new HttpError(400, 'Le code de campagne ne peut contenir que des lettres, des chiffres, « - » et « _ » (sans espace).');
  return c;
}
function period(start, end) {
  if (start && end && end < start) throw new HttpError(400, 'La date de fin est avant la date de début.');
}

const campOf = async (req, id) => {
  const c = await db.prepare('SELECT * FROM marketing_campaigns WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!c) throw new HttpError(404, 'Campagne introuvable.');
  return c;
};
async function codeFree(req, c, exceptId) {
  if (!c) return;
  const dup = await db.prepare('SELECT id FROM marketing_campaigns WHERE org_id = ? AND LOWER(code) = LOWER(?)').get(req.org.id, c);
  if (dup && dup.id !== exceptId) throw new HttpError(400, 'Ce code est déjà utilisé par une autre campagne.');
}

/**
 * Résultats par code de campagne, lus dans l'assistant commercial : conversations (chats.campaign), prospects (clients dont la source
 * ou la conversation porte ce code), clients convertis (fiche passée au statut « client »), commandes non annulées et chiffre d'affaires
 * (commandes confirmées ou facturées). Les codes sont comparés sans tenir compte des majuscules.
 */
async function results(orgId) {
  const out = {};
  const get = (k) => (out[k] = out[k] || { chats: 0, people: new Set(), orders: 0, revenue: 0 });
  for (const r of await db.prepare("SELECT LOWER(campaign) AS k, COUNT(*) AS n FROM chats WHERE org_id = ? AND campaign != '' GROUP BY LOWER(campaign)").all(orgId)) get(r.k).chats = Number(r.n);
  const cust = new Map((await db.prepare('SELECT id, stage, LOWER(source) AS src FROM customers WHERE org_id = ?').all(orgId)).map((c) => [Number(c.id), c]));
  for (const c of cust.values()) if (c.src && c.src !== 'assistant') get(c.src).people.add(Number(c.id));
  for (const r of await db.prepare("SELECT LOWER(campaign) AS k, customer_id FROM chats WHERE org_id = ? AND campaign != '' AND customer_id IS NOT NULL").all(orgId)) get(r.k).people.add(Number(r.customer_id));
  for (const r of await db.prepare("SELECT LOWER(c.campaign) AS k, d.status, d.total FROM documents d JOIN chats c ON c.id = d.chat_id WHERE d.org_id = ? AND d.kind = 'order' AND c.campaign != ''").all(orgId)) {
    if (['cancelled', 'refused'].includes(r.status)) continue;
    const g = get(r.k);
    g.orders += 1;
    if (['confirmed', 'invoiced'].includes(r.status)) g.revenue += Number(r.total);
  }
  const res = {};
  for (const [k, g] of Object.entries(out)) {
    const ids = [...g.people];
    res[k] = { chats: g.chats, prospects: ids.length, converted: ids.filter((i) => cust.get(i) && cust.get(i).stage === 'client').length, orders: g.orders, revenue: g.revenue };
  }
  return res;
}

async function campaigns(req) {
  const rows = await db.prepare('SELECT * FROM marketing_campaigns WHERE org_id = ? ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'draft\' THEN 1 ELSE 2 END, id DESC LIMIT 200').all(req.org.id);
  const res = await results(req.org.id);
  const spent = Object.fromEntries((await db.prepare('SELECT campaign_id, SUM(amount) AS s FROM marketing_expenses WHERE org_id = ? GROUP BY campaign_id').all(req.org.id)).map((r) => [Number(r.campaign_id), Number(r.s)]));
  return rows.map((c) => {
    const r = (c.code && res[c.code.toLowerCase()]) || { chats: 0, prospects: 0, converted: 0, orders: 0, revenue: 0 };
    const sp = spent[c.id] || 0;
    const cost = sp > 0 ? sp : Number(c.budget);
    return {
      id: c.id, name: c.name, channel: c.channel, channelLabel: CHANNEL_LABEL[c.channel], objective: c.objective, budget: Number(c.budget), startDate: c.start_date, endDate: c.end_date,
      status: c.status, code: c.code, notes: c.notes, spent: sp, ...r,
      costPerProspect: cost > 0 && r.prospects > 0 ? Math.round(cost / r.prospects) : null,
      roi: cost > 0 && c.code ? Math.round(((r.revenue - cost) / cost) * 100) : null,
    };
  });
}

// ---------- Tableau de bord + listes ----------
router.get('/', async (req, res) => {
  const list = await campaigns(req);
  const m = A.monthRange();
  const monthSpend = Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM marketing_expenses WHERE org_id = ? AND date >= ? AND date < ?').get(req.org.id, m.from, m.to)).s);
  const codes = new Set(list.filter((c) => c.code).map((c) => c.code.toLowerCase()));
  const monthStart = `${m.month}-01`;
  const sources = (await db.prepare('SELECT LOWER(source) AS s, created_at FROM customers WHERE org_id = ? AND created_at >= ?').all(req.org.id, monthStart)).filter((c) => codes.has(c.s)).length;
  const withData = list.filter((c) => c.code && (c.revenue > 0 || c.prospects > 0));
  const best = withData.slice().sort((a, b) => b.revenue - a.revenue || b.prospects - a.prospects)[0] || null;
  const seen = new Set((await db.prepare("SELECT DISTINCT LOWER(campaign) AS k FROM chats WHERE org_id = ? AND campaign != ''").all(req.org.id)).map((r) => r.k));
  const posts = await db.prepare('SELECT p.*, c.name AS campaign FROM marketing_posts p LEFT JOIN marketing_campaigns c ON c.id = p.campaign_id WHERE p.org_id = ? ORDER BY p.date, p.id LIMIT 300').all(req.org.id);
  const offers = await db.prepare('SELECT * FROM marketing_offers WHERE org_id = ? ORDER BY id DESC LIMIT 100').all(req.org.id);
  res.json({
    summary: { active: list.filter((c) => c.status === 'active').length, best: best ? { id: best.id, name: best.name, revenue: best.revenue, prospects: best.prospects } : null, monthSpend, prospectsMonth: sources },
    campaigns: list,
    unknownCodes: [...seen].filter((k) => !codes.has(k)).slice(0, 20),
    channels: CHANNEL_LABEL,
    posts: posts.map((p) => ({ id: p.id, date: p.date, channel: p.channel, channelLabel: CHANNEL_LABEL[p.channel], text: p.text, status: p.status, campaignId: p.campaign_id, campaign: p.campaign })),
    offers: offers.map((o) => ({ id: o.id, name: o.name, kind: o.kind, value: Number(o.value), startDate: o.start_date, endDate: o.end_date, description: o.description, expired: Boolean(o.end_date && o.end_date < today()) })),
  });
});

// ---------- Campagnes ----------
router.post('/campaigns', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const start = A.date(b.startDate); const end = A.date(b.endDate);
  period(start, end);
  const c = code(b.code);
  await codeFree(req, c);
  const id = (await db.prepare('INSERT INTO marketing_campaigns (org_id, name, channel, objective, budget, start_date, end_date, status, code, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, A.text(b.name, 120, { required: true, msg: 'Indiquez le nom de la campagne.' }), A.oneOf(b.channel, CHANNELS, 'other', 'Canal inconnu.'), A.text(b.objective, 300), money0(b.budget), start, end,
    A.oneOf(b.status, STATUSES, 'draft', 'Statut inconnu.'), c, A.text(b.notes, 800), req.user.id, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'marketing', `Campagne « ${A.text(b.name, 120)} » créée`);
  res.status(201).json({ id: Number(id) });
});

router.put('/campaigns/:id', async (req, res) => {
  const c = await campOf(req, req.params.id);
  const b = req.body || {};
  const start = b.startDate === undefined ? c.start_date : A.date(b.startDate);
  const end = b.endDate === undefined ? c.end_date : A.date(b.endDate);
  period(start, end);
  const cd = b.code === undefined ? c.code : code(b.code);
  await codeFree(req, cd, c.id);
  const budget = b.budget === undefined || !A.can(req, 'manager') ? c.budget : money0(b.budget);
  await db.prepare('UPDATE marketing_campaigns SET name = ?, channel = ?, objective = ?, budget = ?, start_date = ?, end_date = ?, status = ?, code = ?, notes = ? WHERE id = ?').run(
    b.name === undefined ? c.name : A.text(b.name, 120, { required: true, msg: 'Indiquez le nom de la campagne.' }), b.channel === undefined ? c.channel : A.oneOf(b.channel, CHANNELS, undefined, 'Canal inconnu.'),
    b.objective === undefined ? c.objective : A.text(b.objective, 300), budget, start, end, b.status === undefined ? c.status : A.oneOf(b.status, STATUSES, undefined, 'Statut inconnu.'), cd,
    b.notes === undefined ? c.notes : A.text(b.notes, 800), c.id);
  res.json({ ok: true });
});

router.delete('/campaigns/:id', A.need('manager'), async (req, res) => {
  const c = await campOf(req, req.params.id);
  await db.prepare('DELETE FROM marketing_campaigns WHERE id = ?').run(c.id); // supprime aussi ses dépenses ; les lignes du budget déjà créées restent
  res.json({ ok: true });
});

// ---------- Dépenses de campagne (responsables) ----------
router.get('/campaigns/:id/expenses', A.need('manager'), async (req, res) => {
  const c = await campOf(req, req.params.id);
  const rows = await db.prepare('SELECT * FROM marketing_expenses WHERE campaign_id = ? AND org_id = ? ORDER BY date DESC, id DESC LIMIT 200').all(c.id, req.org.id);
  res.json({ expenses: rows.map((e) => ({ id: e.id, label: e.label, amount: Number(e.amount), date: e.date, inBudget: Boolean(e.budget_entry_id) })) });
});

// Une dépense ne va au budget (sortie « Marketing ») que si toBudget === true, après confirmation côté écran.
router.post('/campaigns/:id/expenses', A.need('manager'), async (req, res) => {
  const c = await campOf(req, req.params.id);
  const b = req.body || {};
  const amount = A.amount(b.amount);
  const date = A.date(b.date) || today();
  const label = A.text(b.label, 150);
  let id;
  await db.transaction(async () => {
    let entry = null;
    if (b.toBudget === true) {
      entry = Number((await db.prepare("INSERT INTO budget_entries (org_id, branch_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, NULL, 'expense', 'Marketing', ?, ?, ?, ?, ?)")
        .run(req.org.id, oneLine(`Campagne ${c.name}${label ? ' : ' + label : ''}`, 150), amount, date, req.user.id, nowISO())).lastInsertRowid);
    }
    id = Number((await db.prepare('INSERT INTO marketing_expenses (org_id, campaign_id, label, amount, date, budget_entry_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, c.id, label, amount, date, entry, req.user.id, nowISO())).lastInsertRowid);
  })();
  await A.logActivity(req.org.id, req.user.id, 'marketing', `Dépense de campagne « ${c.name} » enregistrée`);
  res.status(201).json({ id, inBudget: b.toBudget === true });
});

router.delete('/expenses/:id', A.need('manager'), async (req, res) => {
  const e = await db.prepare('SELECT * FROM marketing_expenses WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!e) throw new HttpError(404, 'Dépense introuvable.');
  await db.transaction(async () => {
    if (e.budget_entry_id) await db.prepare('DELETE FROM budget_entries WHERE id = ? AND org_id = ?').run(e.budget_entry_id, req.org.id);
    await db.prepare('DELETE FROM marketing_expenses WHERE id = ?').run(e.id);
  })();
  res.json({ ok: true });
});

// ---------- Calendrier de contenu ----------
async function postFields(req, b, p) {
  let campaignId = p ? p.campaign_id : null;
  if (b.campaignId !== undefined) campaignId = b.campaignId === null || b.campaignId === '' ? null : (await campOf(req, b.campaignId)).id;
  const date = b.date === undefined ? (p && p.date) : A.date(b.date);
  if (!date) throw new HttpError(400, 'Indiquez la date de publication.');
  return [campaignId, date, b.channel === undefined ? (p ? p.channel : 'other') : A.oneOf(b.channel, CHANNELS, 'other', 'Canal inconnu.'),
    b.text === undefined ? (p ? p.text : '') : A.text(b.text, 2000, { required: true, msg: 'Écrivez le texte de la publication.' }), b.status === undefined ? (p ? p.status : 'idea') : A.oneOf(b.status, POST_STATUSES, undefined, 'Statut inconnu.')];
}
router.post('/posts', async (req, res) => {
  const b = req.body || {};
  if (b.text === undefined) throw new HttpError(400, 'Écrivez le texte de la publication.');
  const f = await postFields(req, b, null);
  const id = (await db.prepare('INSERT INTO marketing_posts (org_id, campaign_id, date, channel, text, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, ...f, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/posts/:id', async (req, res) => {
  const p = await db.prepare('SELECT * FROM marketing_posts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Publication introuvable.');
  const f = await postFields(req, req.body || {}, p);
  await db.prepare('UPDATE marketing_posts SET campaign_id = ?, date = ?, channel = ?, text = ?, status = ? WHERE id = ?').run(...f, p.id);
  res.json({ ok: true });
});
router.delete('/posts/:id', async (req, res) => {
  const p = await db.prepare('SELECT id FROM marketing_posts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!p) throw new HttpError(404, 'Publication introuvable.');
  await db.prepare('DELETE FROM marketing_posts WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// ---------- Offres et promotions ----------
function offerFields(b, o) {
  const kind = b.kind === undefined ? (o ? o.kind : 'percent') : A.oneOf(b.kind, ['percent', 'amount'], undefined, 'Type de remise inconnu.');
  const value = b.value === undefined ? Number(o ? o.value : 0) : A.amount(b.value);
  if (kind === 'percent' && (value < 1 || value > 100)) throw new HttpError(400, 'Une remise en pourcentage doit être comprise entre 1 et 100.');
  if (!value) throw new HttpError(400, 'Indiquez la remise.');
  const start = b.startDate === undefined ? (o ? o.start_date : null) : A.date(b.startDate);
  const end = b.endDate === undefined ? (o ? o.end_date : null) : A.date(b.endDate);
  period(start, end);
  return [b.name === undefined ? o.name : A.text(b.name, 120, { required: true, msg: "Indiquez le nom de l'offre." }), kind, value, start, end, b.description === undefined ? (o ? o.description : '') : A.text(b.description, 400)];
}
router.post('/offers', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  if (b.name === undefined) throw new HttpError(400, "Indiquez le nom de l'offre.");
  const id = (await db.prepare('INSERT INTO marketing_offers (org_id, name, kind, value, start_date, end_date, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, ...offerFields(b, null), req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.put('/offers/:id', A.need('manager'), async (req, res) => {
  const o = await db.prepare('SELECT * FROM marketing_offers WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!o) throw new HttpError(404, 'Offre introuvable.');
  await db.prepare('UPDATE marketing_offers SET name = ?, kind = ?, value = ?, start_date = ?, end_date = ?, description = ? WHERE id = ?').run(...offerFields(req.body || {}, o), o.id);
  res.json({ ok: true });
});
router.delete('/offers/:id', A.need('manager'), async (req, res) => {
  const o = await db.prepare('SELECT id FROM marketing_offers WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!o) throw new HttpError(404, 'Offre introuvable.');
  await db.prepare('DELETE FROM marketing_offers WHERE id = ?').run(o.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.results = results;
module.exports.campaigns = campaigns;
// Crochets lus par ai.js : ctx(req) = données vues par l'IA ; prompt = consignes propres au module ; min = rôle minimal pour l'IA.
module.exports.ctx = async (req) => {
  const cur = req.org.currency;
  const fmt = (n) => `${Number(n).toLocaleString('fr-FR')} ${cur}`;
  const list = await campaigns(req);
  const t = today();
  const posts = await db.prepare("SELECT date, channel, text, status FROM marketing_posts WHERE org_id = ? AND date >= ? AND status != 'published' ORDER BY date LIMIT 10").all(req.org.id, t);
  const offers = (await db.prepare('SELECT name, kind, value, end_date FROM marketing_offers WHERE org_id = ? ORDER BY id DESC LIMIT 10').all(req.org.id)).filter((o) => !o.end_date || o.end_date >= t);
  const canMoney = A.can(req, 'manager');
  const out = ['MARKETING — campagnes (les résultats viennent de l\'assistant commercial, via le code de campagne) :'];
  for (const c of list.slice(0, 12)) {
    out.push(`- ${oneLine(c.name, 60)} [${STATUS_LABEL[c.status]}, ${c.channelLabel}]${c.code ? ` code ${c.code}` : ' (sans code : pas de suivi)'} : ${c.chats} conversation(s), ${c.prospects} prospect(s), ${c.converted} client(s) converti(s), ${c.orders} commande(s)${canMoney ? `, CA ${fmt(c.revenue)}${c.budget ? `, budget ${fmt(c.budget)}` : ''}${c.spent ? `, dépensé ${fmt(c.spent)}` : ''}${c.roi !== null ? `, retour ${c.roi} %` : ''}` : ''}${c.objective ? ` — objectif : ${oneLine(c.objective, 80)}` : ''}`);
  }
  if (!list.length) out.push('(aucune campagne)');
  out.push('Publications à venir :', ...(posts.map((p) => `- ${p.date} ${CHANNEL_LABEL[p.channel]} [${p.status === 'ready' ? 'prête' : 'idée'}] ${oneLine(p.text, 80)}`)), ...(posts.length ? [] : ['(aucune)']));
  out.push('Offres en cours :', ...(offers.map((o) => `- ${oneLine(o.name, 60)} : ${o.kind === 'percent' ? `${o.value} %` : fmt(o.value)}${o.end_date ? ` jusqu'au ${o.end_date}` : ''}`)), ...(offers.length ? [] : ['(aucune)']));
  return out.join('\n').slice(0, 3000);
};
module.exports.prompt = "Tu aides à préparer et suivre les campagnes de marketing (WhatsApp, Facebook, Instagram, TikTok, affiches, radio, bouche-à-oreille). Tu peux rédiger des textes de publicité et de messages courts en français simple, adaptés au canal et au public local, proposer des idées de promotions et lire les résultats des campagnes (conversations, prospects, commandes, coût par prospect, retour sur investissement) pour conseiller. N'invente jamais de chiffres ni de promesses (prix, délais, garanties) : utilise [à confirmer] pour ce que tu ne sais pas. Tu ne modifies rien toi-même : la personne crée ou change ses campagnes dans l'écran.";
module.exports.min = 'member';
