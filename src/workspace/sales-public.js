'use strict';
// Assistant commercial PUBLIC : la page « chat.html?o=<jeton>&c=<campagne> » (lien de publicité, QR code…) parle à un prospect.
// Il renseigne d'après le catalogue, enregistre la personne comme prospect/client et prend des commandes « à valider ».
// L'IA ne fixe JAMAIS un prix : les montants viennent du catalogue, calculés ici. Tout ce qui vient du visiteur est une donnée.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const config = require('../config');
const limits = require('../middleware/limits');
const claude = require('../services/claude');
const stt = require('../services/stt');
const agent = require('../ai/sales-agent');
const A = require('./access');
const crm = require('./crm');
const L = require('./sales-assign');
const wh = require('../services/webhooks');
const appt = require('./sales-appt');
const briefAI = require('./sales-brief');
const { HttpError, asyncHandler, cleanText, oneLine, stripAccents, log } = require('../util');

const router = express.Router();
const chatLimit = limits.make(10 * 60 * 1000, 60, 'Vous écrivez trop vite. Patientez quelques minutes puis réessayez.');
const voiceLimit = limits.make(10 * 60 * 1000, 20, 'Trop de messages vocaux. Patientez quelques minutes ou écrivez votre message.');

const HANDOFF_TEXT = 'Merci pour votre message. Un conseiller va reprendre cette conversation très bientôt et vous contactera.';
const TECH_TEXT = "Désolé, un petit souci technique est survenu. Un conseiller va vous répondre très bientôt.";

async function orgOf(token) {
  const org = await db.prepare('SELECT * FROM orgs WHERE intake_token = ?').get(String(token || '').slice(0, 80));
  if (!org) throw new HttpError(404, 'Page introuvable.');
  return org;
}
const catalogOf = async (orgId) => await db.prepare("SELECT c.*, (SELECT COUNT(*) FROM catalog_media m WHERE m.item_id = c.id AND m.kind = 'image') AS n_img, (SELECT COUNT(*) FROM catalog_media m WHERE m.item_id = c.id AND m.kind = 'video') AS n_vid FROM catalog c WHERE c.org_id = ? AND c.active = 1 ORDER BY c.name COLLATE NOCASE LIMIT 200").all(orgId);
const enabled = async (org) => Boolean(org.chat_enabled) && (await catalogOf(org.id)).length > 0;
const digits = (v) => String(v || '').replace(/\D/g, '');
const campaignOf = (v) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
const norm = (s) => stripAccents(String(s || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();

/** Enregistre (ou retrouve) la personne dans les clients, avec le statut « prospect » tant qu'elle n'a pas commandé. */
async function upsertCustomer(org, chat, a) {
  const name = cleanText(a.name, 100);
  const phone = digits(a.phone) || (chat.channel === 'whatsapp' ? digits(chat.contact) : '');
  if (!name || phone.length < 8 || phone.length > 15) return null;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(a.email || '').trim()) ? String(a.email).trim().slice(0, 120) : '';
  const last = phone.slice(-9);
  let c = (await db.prepare('SELECT id, phone FROM customers WHERE org_id = ?').all(org.id)).find((r) => digits(r.phone).slice(-9) === last);
  if (c) {
    await db.prepare("UPDATE customers SET email = CASE WHEN email = '' THEN ? ELSE email END WHERE id = ?").run(email, c.id);
  } else {
    const id = (await db.prepare("INSERT INTO customers (org_id, name, phone, email, notes, stage, source, created_at) VALUES (?, ?, ?, ?, ?, 'prospect', ?, ?)")
      .run(org.id, name, a.phone ? cleanText(a.phone, 40) : phone, email, 'Enregistré par l\'assistant commercial', chat.campaign || 'assistant', nowISO())).lastInsertRowid;
    c = { id: Number(id) };
    await A.logActivity(org.id, null, 'sales', `Nouveau prospect : ${name}`);
    wh.emit(org.id, 'prospect.created', { id: c.id, name, phone: a.phone ? cleanText(a.phone, 40) : phone, email, source: chat.campaign || 'assistant', channel: chat.channel });
  }
  await db.prepare('UPDATE chats SET customer_id = ? WHERE id = ?').run(c.id, chat.id);
  return c.id;
}

/** Crée une commande « à valider ». Prix et total viennent du catalogue. Renvoie null si aucun article reconnu. */
async function createOrder(org, customerId, items, note, chatId) {
  const catalog = await catalogOf(org.id);
  const lines = []; const unknown = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 20)) {
    const want = norm(it && it.name);
    if (!want) continue;
    const q = Math.round(Number(it.quantity) * 1000) / 1000;
    const qty = Number.isFinite(q) && q > 0 && q <= 10000 ? q : 1;
    const hit = catalog.find((c) => norm(c.name) === want) || catalog.find((c) => norm(c.name).includes(want) || want.includes(norm(c.name)));
    if (!hit) { unknown.push(oneLine(it.name, 60)); continue; }
    const ex = lines.find((l) => l.id === hit.id);
    if (ex) ex.quantity += qty; else lines.push({ id: hit.id, label: hit.name, quantity: qty, price: hit.price });
  }
  if (!lines.length) return { order: null, unknown };
  const total = lines.reduce((a, l) => a + Math.round(l.quantity * l.price), 0);
  const now = nowISO();
  const number = await crm.nextNumber(org.id, 'order');
  const id = (await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, issued, note, created_by, created_at, updated_at, chat_id) VALUES (?, ?, 'order', ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(org.id, customerId, number, JSON.stringify(lines.map(({ label, quantity, price }) => ({ label, quantity, price }))), total, now.slice(0, 10), cleanText(note, 500), org.owner_id, now, now, chatId || null)).lastInsertRowid;
  await db.prepare("UPDATE customers SET stage = 'client' WHERE id = ?").run(customerId);
  await A.logActivity(org.id, null, 'sales', `Nouvelle commande ${number} à valider`);
  wh.emit(org.id, 'order.created', { id: Number(id), number, total, currency: org.currency, customer_id: customerId, lines: lines.map((l) => ({ label: l.label, quantity: l.quantity, price: l.price })) });
  return { order: { id: Number(id), number, total, lines: lines.map((l) => ({ label: l.label, quantity: l.quantity })) }, unknown };
}

async function handoff(org, chat, reason) {
  if (chat.status === 'handoff') return;
  const cu = chat.customer_id ? await db.prepare('SELECT name, phone, email FROM customers WHERE id = ?').get(chat.customer_id) : null;
  const msgs = (await db.prepare('SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 8').all(chat.id)).reverse();
  const now = nowISO();
  const t = (await db.prepare("INSERT INTO tickets (org_id, customer_name, customer_contact, channel, subject, priority, created_at, updated_at) VALUES (?, ?, ?, 'assistant-web', ?, 'high', ?, ?)")
    .run(org.id, cu ? cu.name : 'Visiteur', cu ? (cu.phone || cu.email || '') : '', oneLine(`Conversation à reprendre : ${reason || 'demande d\'un conseiller'}`, 140), now, now)).lastInsertRowid;
  const add = db.prepare('INSERT INTO ticket_messages (ticket_id, author, content, created_at) VALUES (?, ?, ?, ?)');
  const sum = L.leadSummary(chat.lead);
  if (sum) await add.run(t, 'staff', `Fiche prospect :\n${sum}`, now);
  for (const m of msgs) await add.run(t, m.role === 'user' ? 'customer' : 'staff', oneLine(m.content, 900), now);
  await db.prepare("UPDATE chats SET status = 'handoff' WHERE id = ?").run(chat.id);
  await A.logActivity(org.id, null, 'sales', 'Une conversation attend un conseiller');
  wh.emit(org.id, 'chat.handoff', { chat_id: chat.id, channel: chat.channel, reason: oneLine(reason, 120), customer: cu ? cu.name : null });
  await L.autoAssign(org, await db.prepare('SELECT * FROM chats WHERE id = ?').get(chat.id)); // répartition automatique si elle est activée
}

const saveMsg = async (chatId, role, content) => await db.prepare('INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(chatId, role, String(content).slice(0, 4000), nowISO());

async function newChat(org, session, campaign, channel, contact) {
  const now = nowISO();
  const id = (await db.prepare('INSERT INTO chats (org_id, session, campaign, channel, contact, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(org.id, session, campaignOf(campaign), channel, contact, now, now)).lastInsertRowid;
  const chat = await db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  await A.logActivity(org.id, null, 'sales', `Nouvelle conversation${{ whatsapp: ' WhatsApp', messenger: ' Messenger', instagram: ' Instagram' }[channel] || ''}${chat.campaign ? ` (campagne ${chat.campaign})` : ''}`);
  return chat;
}

/** Conversation sur la page web (chat.html). */
async function converse(org, sessionId, campaign, text, viaVoice) {
  let chat = /^[a-f0-9]{32}$/.test(String(sessionId || '')) ? await db.prepare("SELECT * FROM chats WHERE session = ? AND org_id = ? AND channel = 'web'").get(sessionId, org.id) : null;
  if (!chat) chat = await newChat(org, crypto.randomBytes(16).toString('hex'), campaign, 'web', '');
  return await run(org, chat, text, viaVoice);
}

/** Conversation sur un canal de messagerie de l'organisation (WhatsApp, Messenger, Instagram) : une conversation par personne. */
const SESSION_PREFIX = { whatsapp: 'wa', messenger: 'ms', instagram: 'ig' };
async function ensureChat(org, channel, contact, campaign) {
  const session = `${SESSION_PREFIX[channel]}-${org.id}-${contact}`;
  let chat = await db.prepare('SELECT * FROM chats WHERE session = ? AND org_id = ?').get(session, org.id);
  if (!chat) chat = await newChat(org, session, campaign, channel, contact);
  else if (!chat.campaign && campaignOf(campaign)) { await db.prepare('UPDATE chats SET campaign = ? WHERE id = ?').run(campaignOf(campaign), chat.id); chat.campaign = campaignOf(campaign); }
  return chat;
}
async function converseChannel(org, channel, contact, campaign, text, viaVoice, attachment) {
  return await run(org, await ensureChat(org, channel, contact, campaign), text, viaVoice, attachment);
}
const converseWhatsApp = async (org, phone, campaign, text, viaVoice, attachment) => await converseChannel(org, 'whatsapp', phone, campaign, text, viaVoice, attachment);

// Pièce jointe d'un prospect : image (JPEG, PNG, WebP) ou PDF de 5 Mo au plus ; 30 par conversation. Le type est reconnu d'après le contenu du fichier, jamais d'après son nom.
const MAX_MEDIA_PER_CHAT = 30;
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
async function storeMedia(org, chat, buf) {
  const mime = sniffMime(buf);
  if (!mime || buf.length > 5 * 1024 * 1024) return null;
  if ((await db.prepare('SELECT COUNT(*) c FROM chat_media WHERE chat_id = ?').get(chat.id)).c >= MAX_MEDIA_PER_CHAT) return null;
  const id = (await db.prepare('INSERT INTO chat_media (chat_id, org_id, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(chat.id, org.id, mime, buf.length, buf, nowISO())).lastInsertRowid;
  return { id: Number(id), mime, buf };
}

const FILE_TEXT = "Je ne peux lire que les photos (JPEG, PNG, WebP) et les PDF de 5 Mo au plus. Pouvez-vous réessayer ou m'écrire votre demande ?";
/** Enregistre le message du client (et sa pièce jointe) dans la conversation. Ne répond pas. */
async function ingest(org, chat, text, viaVoice, attachment) {
  const media = attachment ? await storeMedia(org, chat, attachment) : null;
  if (attachment && !media) { await saveMsg(chat.id, 'user', '[fichier non pris en charge]'); await db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(nowISO(), chat.id); return { bad: true }; }
  await saveMsg(chat.id, 'user', media ? `[${media.mime === 'application/pdf' ? 'document' : 'image'} #${media.id}] ${text}`.trim() : viaVoice ? `[message vocal] ${text}` : text);
  await db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(nowISO(), chat.id);
  return { media };
}
const mediaById = async (chatId, id) => { const m = id ? await db.prepare('SELECT id, mime, data FROM chat_media WHERE id = ? AND chat_id = ?').get(id, chatId) : null; return m ? { id: m.id, mime: m.mime, buf: m.data } : null; };

async function run(org, chat, text, viaVoice, attachment) {
  const ing = await ingest(org, chat, text, viaVoice, attachment);
  if (ing.bad) { const o = { sessionId: chat.session, reply: FILE_TEXT }; await saveMsg(chat.id, 'assistant', o.reply); return o; }
  return await respond(org, chat, { text, viaVoice, media: ing.media });
}

/** Fait répondre l'IA au dernier message (déjà enregistré). Renvoie { reply, spoken, media, ... }. */
async function respond(org, chat, { text = '', viaVoice = false, media = null } = {}) {
  chat = await db.prepare('SELECT * FROM chats WHERE id = ?').get(chat.id) || chat;
  const out = { sessionId: chat.session, chatId: chat.id, reply: '', transcript: viaVoice ? text : undefined };

  if (chat.status === 'handoff') {
    out.handoff = true;
    if (chat.channel !== 'web') { out.silent = true; return out; } // un conseiller a repris la conversation : l'IA se tait
    out.reply = HANDOFF_TEXT; await saveMsg(chat.id, 'assistant', out.reply); return out;
  }

  const used = await A.aiUsed(org);
  const limit = A.limitsFor(await A.ownerPlan(org)).aiMonth;
  if (!claude.isConfigured() || used >= limit) {
    await handoff(org, chat, claude.isConfigured() ? "quota d'IA atteint" : 'IA non activée');
    out.reply = HANDOFF_TEXT; out.handoff = true; await saveMsg(chat.id, 'assistant', out.reply); return out;
  }

  const customer = chat.customer_id ? await db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(chat.customer_id) : null;
  const history = (await db.prepare("SELECT role, content FROM chat_messages WHERE chat_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 16").all(chat.id)).reverse();
  while (history.length && history[0].role !== 'user') history.shift();
  const messages = history.map((m) => ({ role: m.role, content: m.content.replace(/^\[message vocal\] /, '').replace(/^\[(image|document) #\d+\]\s*/, '[Le client a envoyé une pièce jointe] ') }));
  if (media) { // la dernière pièce jointe est transmise à l'IA (les précédentes ne sont que mentionnées)
    const last = messages[messages.length - 1];
    last.content = [{ type: 'text', text: text || (media.mime === 'application/pdf' ? 'Le client envoie ce document.' : 'Le client envoie cette image.') }, { type: media.mime === 'application/pdf' ? 'document' : 'image', mime: media.mime, data: media.buf.toString('base64') }];
  }

  let res;
  try {
    const raw = await claude.ask({ stable: agent.stable(), system: agent.dataBlock({ org, catalog: await catalogOf(org.id), chat, customer, today: nowISO().slice(0, 10), weekday: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][new Date(Date.now() + 3600000).getUTCDay()], busy: await appt.busyText(org.id) }), messages, maxTokens: 600, tier: 'fast' });
    await db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, 0, ?)').run(org.id, nowISO());
    res = agent.parse(raw);
    out.spoken = res.reply;
  } catch (e) {
    log.warn('Assistant commercial : appel IA échoué :', oneLine(e.message, 200));
    await handoff(org, chat, 'erreur technique');
    out.reply = TECH_TEXT; out.handoff = true; await saveMsg(chat.id, 'assistant', out.reply); return out;
  }

  await L.mergeLead(chat, res.lead, null);
  let reply = res.reply;
  const a = res.action || {};
  let toHuman = '';                 // raison du passage automatique à l'équipe (commande ou rendez-vous enregistré)
  if (a.type === 'register' || a.type === 'order') {
    const cid = await upsertCustomer(org, chat, a) || chat.customer_id;
    if (a.type === 'register') {
      out.registered = Boolean(cid);
      if (cid) await L.mergeLead(chat, null, 'tiede');
      if (!cid) reply += '\n\n(Pour vous enregistrer, j\'ai besoin de votre nom et de votre numéro de téléphone.)';
    } else if (!cid) {
      reply += '\n\nPour enregistrer votre commande, j\'ai besoin de votre nom et de votre numéro de téléphone.';
    } else {
      const r = await createOrder(org, cid, a.items, a.note, chat.id);
      if (r.order) {
        out.order = r.order; out.registered = true;
        await L.mergeLead(chat, null, 'chaud');
        if (org.handoff_order) toHuman = `commande ${r.order.number} enregistrée`;
        reply += `\n\nVotre commande ${r.order.number} est enregistrée :\n${r.order.lines.map((l) => `• ${l.label} × ${l.quantity}`).join('\n')}\nTotal : ${r.order.total.toLocaleString('fr-FR')} ${org.currency}.\nL'équipe va la confirmer et vous contacter très bientôt.`;
        if (r.unknown.length) reply += `\n(Non trouvé dans notre catalogue : ${r.unknown.join(', ')}.)`;
      } else {
        reply += `\n\nJe n'ai pas retrouvé ces articles dans notre catalogue${r.unknown.length ? ` (${r.unknown.join(', ')})` : ''}. Pouvez-vous me préciser lesquels vous souhaitez ?`;
      }
    }
  } else if (a.type === 'appointment') {
    const cid = await upsertCustomer(org, chat, a) || chat.customer_id;
    if (!cid) reply += "\n\nPour fixer le rendez-vous, j'ai besoin de votre nom et de votre numéro de téléphone.";
    else {
      const r = await appt.create(org, chat, a, cid);
      if (r.appt) {
        out.appointment = r.appt; out.registered = true;
        await L.mergeLead(chat, null, 'chaud');
        reply += `\n\nVotre demande de rendez-vous est enregistrée : ${r.appt.label}${r.appt.purpose ? ' (' + r.appt.purpose + ')' : ''}. L'équipe va la confirmer très bientôt.`;
        if (org.handoff_appt) toHuman = `rendez-vous demandé : ${r.appt.label}`;
      } else reply += `\n\n(${r.error} Proposez-moi un autre jour ou une autre heure.)`;
    }
  } else if (a.type === 'send_media') {
    // Photos et vidéos du catalogue : envoyées par WhatsApp après la réponse écrite (voir whatsapp.js).
    const kind = ['image', 'video'].includes(a.kind) ? a.kind : 'all';
    const cat = await catalogOf(org.id);
    const picks = [];
    for (const nm of (Array.isArray(a.items) ? a.items : []).slice(0, 3)) {
      const want = norm(nm); const hit = want && cat.find((c) => norm(c.name) === want);
      if (hit && ((kind !== 'video' && hit.n_img) || (kind !== 'image' && hit.n_vid))) picks.push({ itemId: hit.id, kind });
    }
    if (chat.channel !== 'web' && picks.length) { out.media = picks; out.chatId = chat.id; }
    else reply += chat.channel !== 'web' ? "\n\n(Je n'ai pas de " + (kind === 'video' ? 'vidéo' : kind === 'image' ? 'photo' : 'photo ni de vidéo') + " de cet article pour le moment : un conseiller peut vous en envoyer.)" : "\n\n(Je ne peux envoyer les photos et vidéos que sur WhatsApp, Messenger et Instagram : un conseiller pourra vous les envoyer.)";
  } else if (a.type === 'handoff') {
    await handoff(org, chat, oneLine(a.reason, 120));
    out.handoff = true;
  }
  if (toHuman) {
    // Commande ou rendez-vous enregistré : un conseiller prend le relais (attribution automatique si elle est activée), et l'IA interne prépare son dossier.
    reply += "\n\nUn conseiller de l'équipe va prendre le relais pour finaliser avec vous.";
    await handoff(org, chat, toHuman);
    out.handoff = true; out.toHuman = true;
    setImmediate(async () => { briefAI.build(org, chat.id).catch(() => {}); });
  }
  out.reply = reply;
  await saveMsg(chat.id, 'assistant', reply);
  return out;
}

// ---------- Routes publiques ----------
router.get('/:token/info', chatLimit, async (req, res) => {
  const org = await orgOf(req.params.token);
  res.json({ name: org.name, enabled: await enabled(org), voice: stt.isConfigured(), currency: org.currency, welcome: `Bonjour, bienvenue chez ${org.name}. Comment puis-je vous aider ?` });
});

router.post('/:token/message', chatLimit, asyncHandler(async (req, res) => {
  const org = await orgOf(req.params.token);
  if (!await enabled(org)) throw new HttpError(403, "Ce service n'est pas disponible pour le moment.");
  const b = req.body || {};
  const text = cleanText(b.message, 1000);
  if (!text) throw new HttpError(400, 'Écrivez votre message.');
  res.json(await converse(org, b.sessionId, b.campaign, text, false));
}));

// Message vocal : audio en base64 (3 Mo au plus) → texte → même conversation.
router.post('/:token/voice', voiceLimit, express.json({ limit: '3.5mb' }), asyncHandler(async (req, res) => {
  const org = await orgOf(req.params.token);
  if (!await enabled(org)) throw new HttpError(403, "Ce service n'est pas disponible pour le moment.");
  if (!stt.isConfigured()) throw new HttpError(503, "Les messages vocaux ne sont pas activés. Écrivez votre message.");
  const b = req.body || {};
  const buf = Buffer.from(String(b.audio || ''), 'base64');
  if (!buf.length || buf.length > 2.6 * 1024 * 1024) throw new HttpError(413, 'Message vocal vide ou trop long (60 secondes au plus).');
  let text;
  try { text = cleanText(await stt.transcribe(buf), 1000); } catch (e) {
    if (e instanceof HttpError) throw e;
    log.warn('Transcription échouée :', oneLine(e.message, 200));
    throw new HttpError(502, "Je n'ai pas pu comprendre le message vocal. Réessayez ou écrivez-le.");
  }
  if (!text) throw new HttpError(422, "Je n'ai rien entendu. Réessayez en parlant plus près du micro, ou écrivez votre message.");
  res.json(await converse(org, b.sessionId, b.campaign, text, true));
}));

module.exports = router;
module.exports.converseWhatsApp = converseWhatsApp;
module.exports.converseChannel = converseChannel;
module.exports.ensureChat = ensureChat;
module.exports.ingest = ingest;
module.exports.respond = respond;
module.exports.mediaById = mediaById;
module.exports.FILE_TEXT = FILE_TEXT;
module.exports.sniffMime = sniffMime;
module.exports.HANDOFF_TEXT = HANDOFF_TEXT;
