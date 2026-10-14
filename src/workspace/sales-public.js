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
const { HttpError, asyncHandler, cleanText, oneLine, stripAccents, log } = require('../util');

const router = express.Router();
const chatLimit = limits.make(10 * 60 * 1000, 60, 'Vous écrivez trop vite. Patientez quelques minutes puis réessayez.');
const voiceLimit = limits.make(10 * 60 * 1000, 20, 'Trop de messages vocaux. Patientez quelques minutes ou écrivez votre message.');

const HANDOFF_TEXT = 'Merci pour votre message. Un conseiller va reprendre cette conversation très bientôt et vous contactera.';
const TECH_TEXT = "Désolé, un petit souci technique est survenu. Un conseiller va vous répondre très bientôt.";

function orgOf(token) {
  const org = db.prepare('SELECT * FROM orgs WHERE intake_token = ?').get(String(token || '').slice(0, 80));
  if (!org) throw new HttpError(404, 'Page introuvable.');
  return org;
}
const catalogOf = (orgId) => db.prepare('SELECT * FROM catalog WHERE org_id = ? AND active = 1 ORDER BY name COLLATE NOCASE LIMIT 200').all(orgId);
const enabled = (org) => Boolean(org.chat_enabled) && catalogOf(org.id).length > 0;
const digits = (v) => String(v || '').replace(/\D/g, '');
const campaignOf = (v) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
const norm = (s) => stripAccents(String(s || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();

/** Enregistre (ou retrouve) la personne dans les clients, avec le statut « prospect » tant qu'elle n'a pas commandé. */
function upsertCustomer(org, chat, a) {
  const name = cleanText(a.name, 100);
  const phone = digits(a.phone) || digits(chat.contact);
  if (!name || phone.length < 8 || phone.length > 15) return null;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(a.email || '').trim()) ? String(a.email).trim().slice(0, 120) : '';
  const last = phone.slice(-9);
  let c = db.prepare('SELECT id, phone FROM customers WHERE org_id = ?').all(org.id).find((r) => digits(r.phone).slice(-9) === last);
  if (c) {
    db.prepare("UPDATE customers SET email = CASE WHEN email = '' THEN ? ELSE email END WHERE id = ?").run(email, c.id);
  } else {
    const id = db.prepare("INSERT INTO customers (org_id, name, phone, email, notes, stage, source, created_at) VALUES (?, ?, ?, ?, ?, 'prospect', ?, ?)")
      .run(org.id, name, a.phone ? cleanText(a.phone, 40) : phone, email, 'Enregistré par l\'assistant commercial', chat.campaign || 'assistant', nowISO()).lastInsertRowid;
    c = { id: Number(id) };
    A.logActivity(org.id, null, 'sales', `Nouveau prospect : ${name}`);
  }
  db.prepare('UPDATE chats SET customer_id = ? WHERE id = ?').run(c.id, chat.id);
  return c.id;
}

/** Crée une commande « à valider ». Prix et total viennent du catalogue. Renvoie null si aucun article reconnu. */
function createOrder(org, customerId, items, note, chatId) {
  const catalog = catalogOf(org.id);
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
  const number = crm.nextNumber(org.id, 'order');
  const id = db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, issued, note, created_by, created_at, updated_at, chat_id) VALUES (?, ?, 'order', ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(org.id, customerId, number, JSON.stringify(lines.map(({ label, quantity, price }) => ({ label, quantity, price }))), total, now.slice(0, 10), cleanText(note, 500), org.owner_id, now, now, chatId || null).lastInsertRowid;
  db.prepare("UPDATE customers SET stage = 'client' WHERE id = ?").run(customerId);
  A.logActivity(org.id, null, 'sales', `Nouvelle commande ${number} à valider`);
  return { order: { id: Number(id), number, total, lines: lines.map((l) => ({ label: l.label, quantity: l.quantity })) }, unknown };
}

function handoff(org, chat, reason) {
  if (chat.status === 'handoff') return;
  const cu = chat.customer_id ? db.prepare('SELECT name, phone, email FROM customers WHERE id = ?').get(chat.customer_id) : null;
  const msgs = db.prepare('SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 8').all(chat.id).reverse();
  const now = nowISO();
  const t = db.prepare("INSERT INTO tickets (org_id, customer_name, customer_contact, channel, subject, priority, created_at, updated_at) VALUES (?, ?, ?, 'assistant-web', ?, 'high', ?, ?)")
    .run(org.id, cu ? cu.name : 'Visiteur', cu ? (cu.phone || cu.email || '') : '', oneLine(`Conversation à reprendre : ${reason || 'demande d\'un conseiller'}`, 140), now, now).lastInsertRowid;
  const add = db.prepare('INSERT INTO ticket_messages (ticket_id, author, content, created_at) VALUES (?, ?, ?, ?)');
  const sum = L.leadSummary(chat.lead);
  if (sum) add.run(t, 'staff', `Fiche prospect :\n${sum}`, now);
  for (const m of msgs) add.run(t, m.role === 'user' ? 'customer' : 'staff', oneLine(m.content, 900), now);
  db.prepare("UPDATE chats SET status = 'handoff' WHERE id = ?").run(chat.id);
  A.logActivity(org.id, null, 'sales', 'Une conversation attend un conseiller');
  L.autoAssign(org, db.prepare('SELECT * FROM chats WHERE id = ?').get(chat.id)); // répartition automatique si elle est activée
}

const saveMsg = (chatId, role, content) => db.prepare('INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(chatId, role, String(content).slice(0, 4000), nowISO());

function newChat(org, session, campaign, channel, contact) {
  const now = nowISO();
  const id = db.prepare('INSERT INTO chats (org_id, session, campaign, channel, contact, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(org.id, session, campaignOf(campaign), channel, contact, now, now).lastInsertRowid;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  A.logActivity(org.id, null, 'sales', `Nouvelle conversation${channel === 'whatsapp' ? ' WhatsApp' : ''}${chat.campaign ? ` (campagne ${chat.campaign})` : ''}`);
  return chat;
}

/** Conversation sur la page web (chat.html). */
async function converse(org, sessionId, campaign, text, viaVoice) {
  let chat = /^[a-f0-9]{32}$/.test(String(sessionId || '')) ? db.prepare("SELECT * FROM chats WHERE session = ? AND org_id = ? AND channel = 'web'").get(sessionId, org.id) : null;
  if (!chat) chat = newChat(org, crypto.randomBytes(16).toString('hex'), campaign, 'web', '');
  return run(org, chat, text, viaVoice);
}

/** Conversation sur le WhatsApp de l'organisation : une conversation par numéro de téléphone. */
async function converseWhatsApp(org, phone, campaign, text, viaVoice) {
  const session = `wa-${org.id}-${phone}`;
  let chat = db.prepare('SELECT * FROM chats WHERE session = ? AND org_id = ?').get(session, org.id);
  if (!chat) chat = newChat(org, session, campaign, 'whatsapp', phone);
  else if (!chat.campaign && campaignOf(campaign)) { db.prepare('UPDATE chats SET campaign = ? WHERE id = ?').run(campaignOf(campaign), chat.id); chat.campaign = campaignOf(campaign); }
  return run(org, chat, text, viaVoice);
}

async function run(org, chat, text, viaVoice) {
  saveMsg(chat.id, 'user', viaVoice ? `[message vocal] ${text}` : text);
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(nowISO(), chat.id);
  const out = { sessionId: chat.session, reply: '', transcript: viaVoice ? text : undefined };

  if (chat.status === 'handoff') {
    out.handoff = true;
    if (chat.channel === 'whatsapp') { out.silent = true; return out; } // un conseiller a repris la conversation : l'IA se tait
    out.reply = HANDOFF_TEXT; saveMsg(chat.id, 'assistant', out.reply); return out;
  }

  const used = A.aiUsed(org);
  const limit = A.limitsFor(A.ownerPlan(org)).aiMonth;
  if (!claude.isConfigured() || used >= limit) {
    handoff(org, chat, claude.isConfigured() ? "quota d'IA atteint" : 'IA non activée');
    out.reply = HANDOFF_TEXT; out.handoff = true; saveMsg(chat.id, 'assistant', out.reply); return out;
  }

  const customer = chat.customer_id ? db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(chat.customer_id) : null;
  const history = db.prepare("SELECT role, content FROM chat_messages WHERE chat_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 16").all(chat.id).reverse();
  while (history.length && history[0].role !== 'user') history.shift();
  const messages = history.map((m) => ({ role: m.role, content: m.content.replace(/^\[message vocal\] /, '') }));

  let res;
  try {
    const raw = await claude.ask({ stable: agent.stable(), system: agent.dataBlock({ org, catalog: catalogOf(org.id), chat, customer, today: nowISO().slice(0, 10) }), messages, maxTokens: 600, tier: 'fast' });
    db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, 0, ?)').run(org.id, nowISO());
    res = agent.parse(raw);
  } catch (e) {
    log.warn('Assistant commercial : appel IA échoué :', oneLine(e.message, 200));
    handoff(org, chat, 'erreur technique');
    out.reply = TECH_TEXT; out.handoff = true; saveMsg(chat.id, 'assistant', out.reply); return out;
  }

  L.mergeLead(chat, res.lead, null);
  let reply = res.reply;
  const a = res.action || {};
  if (a.type === 'register' || a.type === 'order') {
    const cid = upsertCustomer(org, chat, a) || chat.customer_id;
    if (a.type === 'register') {
      out.registered = Boolean(cid);
      if (cid) L.mergeLead(chat, null, 'tiede');
      if (!cid) reply += '\n\n(Pour vous enregistrer, j\'ai besoin de votre nom et de votre numéro de téléphone.)';
    } else if (!cid) {
      reply += '\n\nPour enregistrer votre commande, j\'ai besoin de votre nom et de votre numéro de téléphone.';
    } else {
      const r = createOrder(org, cid, a.items, a.note, chat.id);
      if (r.order) {
        out.order = r.order; out.registered = true;
        L.mergeLead(chat, null, 'chaud');
        reply += `\n\nVotre commande ${r.order.number} est enregistrée :\n${r.order.lines.map((l) => `• ${l.label} × ${l.quantity}`).join('\n')}\nTotal : ${r.order.total.toLocaleString('fr-FR')} ${org.currency}.\nL'équipe va la confirmer et vous contacter très bientôt.`;
        if (r.unknown.length) reply += `\n(Non trouvé dans notre catalogue : ${r.unknown.join(', ')}.)`;
      } else {
        reply += `\n\nJe n'ai pas retrouvé ces articles dans notre catalogue${r.unknown.length ? ` (${r.unknown.join(', ')})` : ''}. Pouvez-vous me préciser lesquels vous souhaitez ?`;
      }
    }
  } else if (a.type === 'handoff') {
    handoff(org, chat, oneLine(a.reason, 120));
    out.handoff = true;
  }
  out.reply = reply;
  saveMsg(chat.id, 'assistant', reply);
  return out;
}

// ---------- Routes publiques ----------
router.get('/:token/info', chatLimit, (req, res) => {
  const org = orgOf(req.params.token);
  res.json({ name: org.name, enabled: enabled(org), voice: stt.isConfigured(), currency: org.currency, welcome: `Bonjour, bienvenue chez ${org.name}. Comment puis-je vous aider ?` });
});

router.post('/:token/message', chatLimit, asyncHandler(async (req, res) => {
  const org = orgOf(req.params.token);
  if (!enabled(org)) throw new HttpError(403, "Ce service n'est pas disponible pour le moment.");
  const b = req.body || {};
  const text = cleanText(b.message, 1000);
  if (!text) throw new HttpError(400, 'Écrivez votre message.');
  res.json(await converse(org, b.sessionId, b.campaign, text, false));
}));

// Message vocal : audio en base64 (3 Mo au plus) → texte → même conversation.
router.post('/:token/voice', voiceLimit, express.json({ limit: '3.5mb' }), asyncHandler(async (req, res) => {
  const org = orgOf(req.params.token);
  if (!enabled(org)) throw new HttpError(403, "Ce service n'est pas disponible pour le moment.");
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
module.exports.HANDOFF_TEXT = HANDOFF_TEXT;
