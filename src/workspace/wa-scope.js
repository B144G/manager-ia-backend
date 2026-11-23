'use strict';
// Portée des réponses automatiques de l'assistant sur WhatsApp : « uniquement les contacts venant d'une publicité », « uniquement les prospects » ou « tout le monde » (défaut = comportement historique).
// Hors périmètre : le message est enregistré normalement et l'équipe est prévenue (notice existante du Suivi de l'IA) ; l'assistant n'envoie RIEN.
// Inchangés : « STOP » / « REPRENDRE », exclusions du Suivi de l'IA, validation humaine (brouillons), plafonds et filtres de sécurité.
// Toute lecture/écriture est filtrée par org_id (aucune fuite entre entreprises).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const R = require('./ai-rules');
const waOrg = require('../services/waOrg');
const { HttpError, oneLine, stripAccents, log } = require('../util');

const MODES = ['all', 'prospects', 'ads'];
const SOURCES = ['ad', 'organic', 'import', 'manual'];
const KINDS = ['always', 'never'];
const MAX_KEYWORDS = 30;
const fold = (s) => stripAccents(String(s || '').toLowerCase()).replace(/\s+/g, ' ').trim();
const phone9 = R.phone9;
const digits = R.digits;
const channelOf = (org) => waOrg.modeOf(org); // 'meta' | 'qr' : ligne WhatsApp réellement utilisée par l'entreprise

// ---------- Réglage ----------
function parseKeywords(raw) { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }
async function settingsOf(orgId) {
  const r = await db.prepare('SELECT * FROM wa_scope_settings WHERE org_id = ?').get(orgId);
  if (!r) return { mode: 'all', modeMeta: null, modeQr: null, keywords: [], updatedAt: null, updatedBy: null };
  return { mode: MODES.includes(r.mode) ? r.mode : 'all', modeMeta: MODES.includes(r.mode_meta) ? r.mode_meta : null, modeQr: MODES.includes(r.mode_qr) ? r.mode_qr : null, keywords: parseKeywords(r.keywords), updatedAt: r.updated_at, updatedBy: r.updated_by ? Number(r.updated_by) : null };
}
/** Mode en vigueur pour la ligne WhatsApp utilisée : réglage propre à la ligne (Meta ou QR) sinon réglage de l'entreprise. */
const effectiveMode = (org, s) => (channelOf(org) === 'qr' ? s.modeQr : s.modeMeta) || s.mode;

function cleanKeywords(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Les mots-clés doivent former une liste.');
  const out = []; const seen = new Set();
  for (const w of list) {
    const k = oneLine(String(w || ''), 60).trim();
    if (!k) continue;
    if (fold(k).length < 3) throw new HttpError(400, `Mot-clé trop court : « ${k} » (3 caractères au moins, pour éviter de classer tout le monde en « publicité »).`);
    if (seen.has(fold(k))) continue;
    seen.add(fold(k)); out.push(k);
  }
  if (out.length > MAX_KEYWORDS) throw new HttpError(400, `${MAX_KEYWORDS} mots-clés au plus.`);
  return out;
}

async function addLog(orgId, userId, action, detail) {
  await db.prepare('INSERT INTO wa_scope_log (org_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(orgId, userId || null, action, oneLine(typeof detail === 'string' ? detail : JSON.stringify(detail || {}), 600), nowISO());
}

// ---------- Origine du contact ----------
const originOf = async (orgId, p9) => (p9 ? await db.prepare('SELECT * FROM wa_contact_origin WHERE org_id = ? AND phone9 = ?').get(orgId, p9) : null);

/** Signaux « publicité » d'un message de l'API officielle : champ referral (publicité cliquer-pour-discuter, source_type « ad » ou « post »). */
function adFromMeta(referral) {
  if (!referral || typeof referral !== 'object') return null;
  const adId = oneLine(String(referral.source_id || ''), 60);
  const clid = String(referral.ctwa_clid || '');
  const type = String(referral.source_type || '').toLowerCase();
  if (!adId && !clid && !['ad', 'post'].includes(type)) return null;
  return { via: 'referral', adId, detail: oneLine(String(referral.headline || referral.body || referral.source_url || ''), 160) };
}
/** Signaux « publicité » d'un message WhatsApp Web (Baileys) : contextInfo.externalAdReply, quand WhatsApp le fournit (pas toujours : le mot-clé sert alors de repli). */
function adFromBaileys(content) {
  if (!content || typeof content !== 'object') return null;
  for (const k of Object.keys(content)) {
    const part = content[k];
    const ctx = part && typeof part === 'object' ? part.contextInfo : null;
    const e = ctx && ctx.externalAdReply;
    if (!e || typeof e !== 'object') continue;
    const adId = oneLine(String(e.sourceId || ''), 60);
    const type = String(e.sourceType || '').toLowerCase();
    if (adId || e.ctwaClid || type === 'ad' || /\bad\b|ctwa/i.test(String(ctx.conversionSource || ''))) return { via: 'externalAdReply', adId, detail: oneLine(String(e.title || e.body || e.sourceUrl || ''), 160) };
  }
  return null;
}

/** Cherche, dans le message d'entrée, un mot-clé de campagne ou le marqueur #campagne du lien de publicité. */
function matchKeyword(keywords, text) {
  const t = fold(text);
  if (!t) return '';
  for (const k of keywords) if (t.includes(fold(k))) return k;
  return '';
}
function detectAd(settings, { text, campaign, ad }) {
  if (ad) return { isAd: true, via: ad.via, adId: ad.adId || '', campaign: '', detail: ad.detail || '' };
  if (campaign) return { isAd: true, via: 'campaign_tag', adId: '', campaign: String(campaign).slice(0, 40), detail: `#${String(campaign).slice(0, 40)}` };
  const k = matchKeyword(settings.keywords, text);
  if (k) return { isAd: true, via: 'keyword', adId: '', campaign: '', detail: oneLine(k, 60) };
  return { isAd: false };
}

async function syncLeadSource(orgId, p9, campaign) {
  try {
    await db.prepare(`UPDATE cp_leads SET source = 'ad', campaign = CASE WHEN campaign = '' THEN ? ELSE campaign END WHERE org_id = ? AND source = 'whatsapp' AND chat_id IN (SELECT id FROM chats WHERE org_id = ? AND channel = 'whatsapp' AND right(regexp_replace(contact, '\\D', '', 'g'), 9) = ?)`).run(campaign || '', orgId, orgId, p9);
  } catch (e) { log.warn('Portée WhatsApp : source du prospect :', oneLine(e.message, 120)); }
}

/**
 * Enregistre l'origine d'un contact à la réception d'un message. Première vue : publicité si un signal existe, sinon organique.
 * Un contact « organique » devient « publicité » si un signal de publicité arrive ensuite ; une origine posée à la main ou par import n'est jamais modifiée.
 */
async function observe(org, chat, signals) {
  const p9 = phone9(chat.contact);
  if (!p9) return null;
  const s = await settingsOf(org.id);
  const cur = await originOf(org.id, p9);
  const now = nowISO();
  const hint = signals.campaign || (!cur && chat.campaign) || '';
  const d = detectAd(s, { text: cur ? '' : signals.text, campaign: hint, ad: signals.ad }); // le mot-clé ne vaut que pour le message d'entrée
  if (!cur) {
    await db.prepare(`INSERT INTO wa_contact_origin (org_id, phone9, phone, source, is_ad, ad_id, campaign, detail, first_at, ad_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, phone9) DO NOTHING`)
      .run(org.id, p9, digits(chat.contact), d.isAd ? 'ad' : 'organic', d.isAd ? 1 : 0, d.adId || '', d.campaign || '', d.detail || '', now, d.isAd ? now : null, now);
    if (d.isAd) await syncLeadSource(org.id, p9, d.campaign || d.adId);
  } else if (!cur.is_ad && cur.source === 'organic' && d.isAd) {
    await db.prepare('UPDATE wa_contact_origin SET source = ?, is_ad = 1, ad_id = ?, campaign = ?, detail = ?, ad_at = ?, updated_at = ? WHERE org_id = ? AND phone9 = ?').run('ad', d.adId || '', d.campaign || '', d.detail || '', now, now, org.id, p9);
    await syncLeadSource(org.id, p9, d.campaign || d.adId);
  }
  return await originOf(org.id, p9);
}

/** Pose l'origine à la main (« publicité » ou non) ou par import. Réservé aux responsables ; remplace toute origine précédente. */
async function setOrigin(orgId, userId, phone, { ad, source = 'manual', campaign = '', adId = '' }) {
  const p9 = phone9(phone);
  if (!p9) throw new HttpError(400, "Numéro invalide : indiquez-le avec l'indicatif du pays, par exemple 237677112233.");
  const now = nowISO();
  const isAd = ad ? 1 : 0;
  const cur = await originOf(orgId, p9);
  // Un contact déjà reconnu comme venant d'une publicité garde sa source et son annonce (les statistiques restent justes) ; la campagne peut être précisée.
  if (cur && Number(cur.is_ad) && isAd && source === 'manual') { source = cur.source; adId = adId || cur.ad_id; campaign = campaign || cur.campaign; }
  await db.prepare(`INSERT INTO wa_contact_origin (org_id, phone9, phone, source, is_ad, ad_id, campaign, detail, first_at, ad_at, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, phone9) DO UPDATE SET source = EXCLUDED.source, is_ad = EXCLUDED.is_ad, ad_id = EXCLUDED.ad_id, campaign = EXCLUDED.campaign, detail = EXCLUDED.detail, ad_at = EXCLUDED.ad_at, set_by = EXCLUDED.set_by, updated_at = EXCLUDED.updated_at`)
    .run(orgId, p9, digits(phone), source, isAd, oneLine(adId, 60), oneLine(campaign, 40), source === 'import' ? 'import' : source === 'manual' ? 'marqué à la main' : (cur ? cur.detail : ''), cur ? cur.first_at : now, isAd ? ((cur && cur.ad_at) || now) : null, userId || null, now);
  if (isAd) await syncLeadSource(orgId, p9, campaign || adId);
  return p9;
}

// ---------- Prospect ----------
/**
 * Un contact est un prospect s'il n'est pas déjà client (fiche « client » ou commande / facture enregistrée), ni fournisseur, ni employé, ni « ne pas répondre automatiquement »,
 * ni prospect disqualifié ou converti du module Commercial. Un contact inconnu ou en pipeline commercial est un prospect.
 */
async function prospectState(orgId, p9, chat) {
  const cust = (chat && chat.customer_id ? await db.prepare('SELECT id, stage FROM customers WHERE id = ? AND org_id = ?').get(chat.customer_id, orgId) : null) || await R.customerByPhone(orgId, p9);
  if (cust) {
    if (cust.stage === 'client') return { prospect: false, why: 'client' };
    const sold = await db.prepare("SELECT 1 FROM documents WHERE org_id = ? AND customer_id = ? AND kind IN ('order', 'invoice') AND status NOT IN ('draft', 'cancelled') LIMIT 1").get(orgId, cust.id);
    if (sold) return { prospect: false, why: 'client' };
  }
  if (p9) {
    const sup = await db.prepare(`SELECT 1 FROM suppliers WHERE org_id = ? AND ((phone <> '' AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ?) OR (length(regexp_replace(contact, '\\D', '', 'g')) BETWEEN 8 AND 15 AND right(regexp_replace(contact, '\\D', '', 'g'), 9) = ?)) LIMIT 1`).get(orgId, p9, p9);
    if (sup) return { prospect: false, why: 'supplier' };
    const emp = await db.prepare("SELECT 1 FROM employees WHERE org_id = ? AND phone <> '' AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ? LIMIT 1").get(orgId, p9);
    if (emp) return { prospect: false, why: 'employee' };
    const lead = await db.prepare("SELECT status FROM cp_leads WHERE org_id = ? AND phone <> '' AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ? ORDER BY id DESC LIMIT 1").get(orgId, p9);
    if (lead && ['converted', 'disqualified'].includes(lead.status)) return { prospect: false, why: lead.status === 'converted' ? 'client' : 'disqualified' };
  }
  return { prospect: true, why: cust ? 'pipeline' : 'new' };
}

// ---------- Décision ----------
/**
 * La réponse automatique est-elle permise pour ce contact ? { allowed, reason, mode, source }.
 * Ordre : « jamais » > « toujours » > mode. Sans écriture. signals.ad / signals.text : signaux du message en cours (publicité, mot-clé d'entrée).
 */
async function evaluate(org, chat, signals = {}) {
  const s = await settingsOf(org.id);
  const mode = effectiveMode(org, s);
  const p9 = phone9(chat.contact);
  const exc = p9 ? await db.prepare('SELECT kind FROM wa_scope_exceptions WHERE org_id = ? AND phone9 = ?').get(org.id, p9) : null;
  const origin = await originOf(org.id, p9);
  const base = { mode, source: origin ? origin.source : null, isAd: Boolean(origin && Number(origin.is_ad)) };
  if (exc && exc.kind === 'never') return { ...base, allowed: false, reason: 'never_list' };
  if (exc && exc.kind === 'always') return { ...base, allowed: true, reason: 'always_list' };
  if (mode === 'all') return { ...base, allowed: true, reason: 'all' };
  if (mode === 'ads') {
    const fresh = !base.isAd && detectAd(s, { text: origin ? '' : signals.text, campaign: signals.campaign || (!origin && chat.campaign) || '', ad: signals.ad }).isAd;
    return base.isAd || fresh ? { ...base, allowed: true, reason: 'ad' } : { ...base, allowed: false, reason: 'not_ad' };
  }
  const p = await prospectState(org.id, p9, chat);
  return p.prospect ? { ...base, allowed: true, reason: 'prospect' } : { ...base, allowed: false, reason: p.why === 'new' || p.why === 'pipeline' ? 'not_prospect' : `not_prospect_${p.why}` };
}

const REASONS = {
  not_ad: "ce contact ne vient pas d'une publicité",
  not_prospect: "ce contact n'est pas un prospect",
  not_prospect_client: 'ce contact est déjà client',
  not_prospect_supplier: 'ce contact est un fournisseur',
  not_prospect_employee: 'ce contact est un employé',
  not_prospect_disqualified: 'ce prospect a été disqualifié',
  never_list: 'ce contact est dans la liste « jamais de réponse automatique »',
};

async function markChat(orgId, chatId, held, reason) {
  await db.prepare(`INSERT INTO wa_chat_scope (chat_id, org_id, held, reason, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (chat_id) DO UPDATE SET held = EXCLUDED.held, reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at`)
    .run(chatId, orgId, held ? 1 : 0, held ? reason : '', nowISO());
}

/** Appelé à chaque message WhatsApp reçu (avant la réponse) : note l'origine, décide, mémorise l'état de la conversation. Ne lève jamais d'erreur vers l'appelant. */
async function gate(org, chat, signals = {}) {
  if (chat.channel !== 'whatsapp') return { allowed: true, reason: 'all' };
  try {
    await observe(org, chat, signals);
    const d = await evaluate(org, chat, signals);
    await markChat(org.id, chat.id, !d.allowed, d.reason);
    return d;
  } catch (e) { log.warn('Portée WhatsApp :', oneLine(e.message, 160)); return { allowed: true, reason: 'error' }; }
}
/** Sans écriture : l'assistant a-t-il le droit d'envoyer un message automatique à ce numéro ? (réponses « je n'ai pas compris » avant même l'enregistrement du message). */
async function peek(org, contact, signals = {}) {
  try {
    const session = `wa-${org.id}-${contact}`;
    const chat = await db.prepare('SELECT * FROM chats WHERE session = ? AND org_id = ?').get(session, org.id) || { channel: 'whatsapp', contact, customer_id: null, campaign: '' };
    return await evaluate(org, chat, signals);
  } catch (e) { log.warn('Portée WhatsApp :', oneLine(e.message, 160)); return { allowed: true, reason: 'error' }; }
}
/** Dernier contrôle avant l'envoi différé (le mode a pu changer pendant l'attente). */
async function recheck(org, chat) {
  if (chat.channel !== 'whatsapp') return { allowed: true, reason: 'all' };
  try { const d = await evaluate(org, chat, {}); await markChat(org.id, chat.id, !d.allowed, d.reason); return d; } catch { return { allowed: true, reason: 'error' }; }
}

/** Prévient l'équipe (notice existante « Suivi de l'IA »). Une seule notice non lue par conversation. */
async function onHeld(org, chat, d) {
  await R.notifyTeam(org, chat, 'aifollow', `Nouveau message de ${await R.labelOfChat(chat)} : hors périmètre des réponses automatiques (${REASONS[d.reason] || 'réglage de l\'assistant'}). Répondez-lui vous-même, ou utilisez « répondre avec l'assistant quand même ».`);
}

/** Après un changement de réglage ou de liste : remet à jour l'état « hors périmètre » des conversations WhatsApp récentes. */
async function reevaluateOrg(org) {
  const chats = await db.prepare("SELECT * FROM chats WHERE org_id = ? AND channel = 'whatsapp' ORDER BY updated_at DESC LIMIT 300").all(org.id);
  let held = 0;
  for (const c of chats) { const d = await evaluate(org, c, {}); await markChat(org.id, c.id, !d.allowed, d.reason); if (!d.allowed) held++; }
  return held;
}

/** Informations de portée d'une conversation, pour l'écran. */
async function chatInfo(org, chat) {
  if (!chat || chat.channel !== 'whatsapp') return null;
  const m = await db.prepare('SELECT held, reason FROM wa_chat_scope WHERE chat_id = ? AND org_id = ?').get(chat.id, org.id);
  const o = await originOf(org.id, phone9(chat.contact));
  return { held: Boolean(m && Number(m.held)), reason: m && Number(m.held) ? m.reason : '', reasonText: m && Number(m.held) ? REASONS[m.reason] || '' : '', origin: o ? { source: o.source, isAd: Boolean(Number(o.is_ad)), adId: o.ad_id, campaign: o.campaign, at: o.ad_at || o.first_at } : null };
}

// ---------- Écrans ----------
const router = express.Router({ mergeParams: true });
const excView = (r) => ({ id: Number(r.id), phone: r.phone, kind: r.kind, label: r.label, at: r.created_at });

async function overview(org) {
  const s = await settingsOf(org.id);
  const bySource = await db.prepare('SELECT source, COUNT(*) AS n FROM wa_contact_origin WHERE org_id = ? GROUP BY source').all(org.id);
  const campaigns = await db.prepare("SELECT ad_id, campaign, MAX(detail) AS detail, COUNT(*) AS n FROM wa_contact_origin WHERE org_id = ? AND is_ad = 1 AND (ad_id <> '' OR campaign <> '') GROUP BY ad_id, campaign ORDER BY n DESC LIMIT 10").all(org.id);
  const heldN = await db.prepare('SELECT COUNT(*) AS n FROM wa_chat_scope WHERE org_id = ? AND held = 1').get(org.id);
  const log2 = await db.prepare('SELECT l.id, l.action, l.detail, l.created_at, u.name AS who FROM wa_scope_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 50').all(org.id);
  return {
    settings: s, channel: channelOf(org), effectiveMode: effectiveMode(org, s),
    exceptions: (await db.prepare('SELECT * FROM wa_scope_exceptions WHERE org_id = ? ORDER BY id DESC LIMIT 500').all(org.id)).map(excView),
    stats: { bySource: Object.fromEntries(SOURCES.map((k) => [k, Number((bySource.find((r) => r.source === k) || {}).n || 0)])), campaigns: campaigns.map((c) => ({ adId: c.ad_id, campaign: c.campaign, detail: c.detail, contacts: Number(c.n) })), held: Number(heldN.n) },
    log: log2.map((l) => ({ id: Number(l.id), action: l.action, detail: l.detail, at: l.created_at, who: l.who || '' })),
  };
}

router.get('/', A.need('manager'), async (req, res) => res.json(await overview(req.org)));

router.put('/', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const cur = await settingsOf(req.org.id);
  const pick = (v, name, nullable) => { if (v === undefined) return undefined; if (nullable && (v === null || v === '')) return null; if (!MODES.includes(v)) throw new HttpError(400, `${name} : choix inconnu (tout le monde, prospects, publicité).`); return v; };
  const mode = pick(b.mode, 'Mode', false) ?? cur.mode;
  const modeMeta = b.modeMeta === undefined ? cur.modeMeta : pick(b.modeMeta, 'Mode de la ligne officielle', true);
  const modeQr = b.modeQr === undefined ? cur.modeQr : pick(b.modeQr, 'Mode de la ligne par code QR', true);
  const keywords = b.keywords === undefined ? cur.keywords : cleanKeywords(b.keywords);
  const now = nowISO();
  await db.prepare(`INSERT INTO wa_scope_settings (org_id, mode, mode_meta, mode_qr, keywords, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET mode = EXCLUDED.mode, mode_meta = EXCLUDED.mode_meta, mode_qr = EXCLUDED.mode_qr, keywords = EXCLUDED.keywords, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, mode, modeMeta, modeQr, JSON.stringify(keywords), req.user.id, now);
  const changes = {};
  if (mode !== cur.mode) changes.mode = [cur.mode, mode];
  if (modeMeta !== cur.modeMeta) changes.modeMeta = [cur.modeMeta, modeMeta];
  if (modeQr !== cur.modeQr) changes.modeQr = [cur.modeQr, modeQr];
  if (JSON.stringify(keywords) !== JSON.stringify(cur.keywords)) changes.keywords = [cur.keywords.length, keywords.length];
  if (Object.keys(changes).length) { await addLog(req.org.id, req.user.id, 'settings', changes); await A.logActivity(req.org.id, req.user.id, 'sales', 'Portée des réponses automatiques WhatsApp modifiée'); await reevaluateOrg(req.org); }
  res.json({ ok: true, ...(await overview(req.org)) });
});

router.post('/exceptions', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, KINDS, undefined, 'Type de liste inconnu (toujours, jamais).');
  const p9 = phone9(b.phone);
  if (!p9) throw new HttpError(400, "Numéro invalide : indiquez-le avec l'indicatif du pays, par exemple 237677112233.");
  const count = await db.prepare('SELECT COUNT(*) AS n FROM wa_scope_exceptions WHERE org_id = ?').get(req.org.id);
  const had = await db.prepare('SELECT kind FROM wa_scope_exceptions WHERE org_id = ? AND phone9 = ?').get(req.org.id, p9);
  if (!had && Number(count.n) >= 500) throw new HttpError(400, '500 numéros au plus dans les listes.');
  await db.prepare(`INSERT INTO wa_scope_exceptions (org_id, phone9, phone, kind, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, phone9) DO UPDATE SET kind = EXCLUDED.kind, label = EXCLUDED.label, phone = EXCLUDED.phone, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`)
    .run(req.org.id, p9, digits(b.phone), kind, oneLine(b.label || '', 80), req.user.id, nowISO());
  await addLog(req.org.id, req.user.id, 'exception_add', { phone: `…${p9.slice(-4)}`, kind, was: had ? had.kind : null });
  await reevaluateOrg(req.org);
  res.status(201).json({ ok: true, ...(await overview(req.org)) });
});
router.delete('/exceptions/:id', A.need('admin'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM wa_scope_exceptions WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Numéro introuvable dans la liste.');
  await db.prepare('DELETE FROM wa_scope_exceptions WHERE id = ? AND org_id = ?').run(r.id, req.org.id);
  await addLog(req.org.id, req.user.id, 'exception_remove', { phone: `…${r.phone9.slice(-4)}`, kind: r.kind });
  await reevaluateOrg(req.org);
  res.json({ ok: true, ...(await overview(req.org)) });
});

/** Marquer un contact « venant d'une publicité » (ou non) à la main. */
router.put('/origin', A.need('manager'), async (req, res) => {
  const b = req.body || {};
  const p9 = await setOrigin(req.org.id, req.user.id, b.phone, { ad: Boolean(b.ad), source: 'manual', campaign: b.campaign || '', adId: b.adId || '' });
  await addLog(req.org.id, req.user.id, 'origin_set', { phone: `…${p9.slice(-4)}`, ad: Boolean(b.ad) });
  await reevaluateOrg(req.org);
  res.json({ ok: true });
});
/** Import d'une liste de contacts (jusqu'à 500) avec indication « publicité » : [{ phone, ad, campaign }]. */
router.post('/import', A.need('admin'), async (req, res) => {
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : null;
  if (!rows || !rows.length) throw new HttpError(400, 'Fournissez la liste des contacts à importer.');
  if (rows.length > 500) throw new HttpError(400, '500 contacts au plus par import.');
  let done = 0; let skipped = 0;
  for (const r of rows) {
    if (!phone9(r && r.phone)) { skipped++; continue; }
    await setOrigin(req.org.id, req.user.id, r.phone, { ad: Boolean(r.ad), source: 'import', campaign: r.campaign || '', adId: '' }); done++;
  }
  await addLog(req.org.id, req.user.id, 'import', { imported: done, skipped });
  await reevaluateOrg(req.org);
  res.json({ ok: true, imported: done, skipped });
});

async function chatOf(req) {
  const c = await db.prepare("SELECT * FROM chats WHERE id = ? AND org_id = ? AND channel = 'whatsapp'").get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Conversation introuvable.');
  return c;
}
/** « Ajouter ce contact au périmètre » : le numéro rejoint la liste « toujours autorisés ». */
router.post('/chats/:id/add-to-scope', A.need('manager'), async (req, res) => {
  const c = await chatOf(req);
  const p9 = phone9(c.contact);
  if (!p9) throw new HttpError(400, 'Cette conversation n\'a pas de numéro de téléphone.');
  const label = await R.labelOfChat(c);
  await db.prepare(`INSERT INTO wa_scope_exceptions (org_id, phone9, phone, kind, label, created_by, created_at) VALUES (?, ?, ?, 'always', ?, ?, ?) ON CONFLICT (org_id, phone9) DO UPDATE SET kind = 'always', label = EXCLUDED.label, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`)
    .run(req.org.id, p9, digits(c.contact), oneLine(label, 80), req.user.id, nowISO());
  await addLog(req.org.id, req.user.id, 'add_to_scope', { phone: `…${p9.slice(-4)}` });
  await markChat(req.org.id, c.id, false, '');
  res.json({ ok: true, scope: await chatInfo(req.org, c) });
});
/** « Répondre avec l'assistant quand même » : réponse déclenchée par un humain, une seule fois, sur le dernier message du client. */
router.post('/chats/:id/reply-anyway', A.need('manager'), async (req, res) => {
  const c = await chatOf(req);
  const out = await require('./inbound').replyNow(req.org, c);
  await addLog(req.org.id, req.user.id, 'reply_anyway', { chat: Number(c.id), sent: out.sent });
  await markChat(req.org.id, c.id, false, '');
  if (!out.sent) throw new HttpError(409, out.why || "L'assistant n'a rien envoyé (conversation reprise par un conseiller, contact exclu ou WhatsApp non connecté).");
  res.json({ ok: true });
});

module.exports = { router, MODES, SOURCES, REASONS, settingsOf, effectiveMode, evaluate, gate, peek, recheck, onHeld, observe, setOrigin, adFromMeta, adFromBaileys, matchKeyword, prospectState, chatInfo, reevaluateOrg, markChat, overview };
