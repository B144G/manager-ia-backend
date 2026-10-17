'use strict';
// Réception d'un message client, tous canaux confondus (WhatsApp, Messenger, Instagram) :
//   1. le message est enregistré tout de suite (l'équipe le voit en direct) ;
//   2. l'IA répond immédiatement, ou après le DÉLAI choisi par l'organisation (0 à 180 s) : les messages reçus pendant l'attente sont lus ensemble,
//      ce qui donne une seule réponse plus pertinente. L'attente est gardée en base : un redémarrage du serveur ne fait perdre aucune réponse ;
//   3. la réponse part en texte, avec les photos/vidéos demandées et, selon le réglage, en message vocal.
const { db, nowISO } = require('../db');
const sales = require('./sales-public');
const channels = require('./channels');
const waMedia = require('./wa-media');
const { oneLine, log } = require('../util');

// En production : toujours des secondes réelles. Les variables servent uniquement aux tests automatiques.
const testing = () => process.env.NODE_ENV !== 'production';
const scale = () => (testing() && Number(process.env.REPLY_DELAY_SCALE)) || 1000;
const tickMs = () => (testing() && Number(process.env.REPLY_TICK_MS)) || 2000;
const MAX_SPOKEN = 700; // caractères lus à voix haute au plus

const delayMs = (org) => Math.max(0, Math.min(180, Number(org.reply_delay) || 0)) * scale();
const wantsVoice = (org, viaVoice) => channels.voiceReady() && (org.voice_reply === 'always' || (org.voice_reply === 'mirror' && Boolean(viaVoice)));

async function deliver(org, chat0, { viaVoice, mediaId, heard }) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chat0.id);
  if (!chat || chat.status === 'handoff') return;          // un conseiller a repris la main pendant l'attente
  if (!channels.isConnected(org, chat.channel)) return;
  const out = await sales.respond(org, chat, { text: heard, viaVoice, media: sales.mediaById(chat.id, mediaId) });
  if (out.silent || !out.reply) return;
  await channels.sendText(org, chat, viaVoice && heard ? `(J'ai compris : « ${oneLine(heard, 200)} »)\n\n${out.reply}` : out.reply);
  if (out.media && out.media.length) await waMedia.sendForChat(org, chat, out.media);
  const spoken = String(out.spoken || '').trim();
  if (spoken && spoken.length <= MAX_SPOKEN && wantsVoice(org, viaVoice)) {
    try {
      await channels.sendVoice(org, chat, spoken);
      db.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, 0, ?)').run(org.id, nowISO()); // une réponse vocale compte comme un message IA de plus
      db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").run(chat.id, '[réponse vocale envoyée]', nowISO());
    } catch (e) { log.warn('Réponse vocale impossible :', oneLine(e.message, 160)); }
  }
}

/** Point d'entrée unique : appelé par les webhooks WhatsApp, Messenger et Instagram. */
async function receive(org, channel, contact, { campaign = '', text = '', viaVoice = false, attachment = null } = {}) {
  const chat = sales.ensureChat(org, channel, contact, campaign);
  const ing = sales.ingest(org, chat, text, viaVoice, attachment);
  if (ing.bad) return void (await channels.sendText(org, chat, sales.FILE_TEXT));
  const cur = db.prepare('SELECT status FROM chats WHERE id = ?').get(chat.id);
  if (cur.status === 'handoff') return;                    // conversation reprise par un humain : l'IA se tait
  const ms = delayMs(org);
  if (!ms) return deliver(org, chat, { viaVoice, mediaId: ing.media && ing.media.id, heard: text });
  // Attente : la date de réponse est celle du PREMIER message du groupe (l'attente ne se prolonge jamais).
  db.prepare(`INSERT INTO reply_queue (chat_id, org_id, due_at, via_voice, media_id, last_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET via_voice = MAX(via_voice, excluded.via_voice), media_id = COALESCE(excluded.media_id, media_id), last_text = excluded.last_text`)
    .run(chat.id, org.id, new Date(Date.now() + ms).toISOString(), viaVoice ? 1 : 0, ing.media ? ing.media.id : null, text, nowISO());
}

let busy = false; let timer = null;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const rows = db.prepare('SELECT * FROM reply_queue WHERE due_at <= ? ORDER BY due_at LIMIT 10').all(nowISO());
    for (const r of rows) {
      if (!db.prepare('DELETE FROM reply_queue WHERE chat_id = ? AND due_at = ?').run(r.chat_id, r.due_at).changes) continue; // déjà pris
      try {
        const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(r.org_id);
        const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(r.chat_id);
        if (org && chat) await deliver(org, chat, { viaVoice: Boolean(r.via_voice), mediaId: r.media_id, heard: r.last_text });
      } catch (e) { log.warn('Réponse différée : erreur :', oneLine(e.message, 200)); }
    }
  } finally { busy = false; }
}
function start() { if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, tickMs()); if (timer.unref) timer.unref(); } }

module.exports = { receive, start, tick, delayMs };
