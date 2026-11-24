'use strict';
// Chat interne : tâches de fond (un seul processus) — messages programmés, rappels, appels sans réponse. Chaque passage est protégé : jamais d'arrêt du serveur.
const { db, nowISO } = require('../db');
const hub = require('./chat-hub');
const L = require('./chat-lib');
const { log, oneLine } = require('../util');

let busy = false;
async function sendDue() {
  const due = await db.prepare("SELECT * FROM ci_scheduled WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 50").all(nowISO());
  for (const s of due) {
    const claimed = await db.prepare("UPDATE ci_scheduled SET status = 'sending' WHERE id = ? AND status = 'pending'").run(s.id);
    if (!claimed.changes) continue;
    try {
      const org = await db.prepare('SELECT * FROM orgs WHERE id = ?').get(s.org_id);
      const user = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(s.sender_id);
      const mem = await db.prepare('SELECT role, branch_id FROM org_members WHERE org_id = ? AND user_id = ?').get(s.org_id, s.sender_id);
      const conv = org && user && mem ? await db.prepare(`SELECT c.*, m.role AS my_role, m.from_id AS my_from, m.last_read_id AS my_read FROM ci_conversations c JOIN ci_members m ON m.conv_id = c.id AND m.user_id = ? AND m.left_at IS NULL WHERE c.id = ? AND c.org_id = ?`).get(s.sender_id, s.conv_id, s.org_id) : null;
      if (!conv || (Number(conv.only_admins_post) === 1 && conv.my_role !== 'admin')) { await db.prepare("UPDATE ci_scheduled SET status = 'failed' WHERE id = ?").run(s.id); continue; } // la personne n'a plus accès : rien n'est envoyé
      const req = { org, user, member: mem };
      const view = await L.postMessage(req, conv, { body: s.body, urgent: Number(s.urgent) === 1, replyToId: s.reply_to_id || null });
      await db.prepare("UPDATE ci_scheduled SET status = 'sent', message_id = ? WHERE id = ?").run(view.id, s.id);
      hub.publish(s.org_id, [Number(s.sender_id)], 'scheduled', { id: Number(s.id), sent: true });
    } catch (e) { await db.prepare("UPDATE ci_scheduled SET status = 'failed' WHERE id = ?").run(s.id); log.warn('Chat : message programmé non envoyé :', oneLine(e.message, 120)); }
  }
}
async function remindDue() {
  const due = await db.prepare("SELECT r.*, c.kind AS ckind FROM ci_reminders r JOIN ci_conversations c ON c.id = r.conv_id WHERE r.status = 'pending' AND r.remind_at <= ? ORDER BY r.remind_at LIMIT 50").all(nowISO());
  for (const r of due) {
    const claimed = await db.prepare("UPDATE ci_reminders SET status = 'done' WHERE id = ? AND status = 'pending'").run(r.id);
    if (!claimed.changes) continue;
    hub.publish(r.org_id, [Number(r.user_id)], 'reminder', { id: Number(r.id), convId: Number(r.conv_id), messageId: Number(r.message_id), note: r.note });
    // Notification sans le contenu du message (l'e-mail ne doit jamais recopier un échange privé).
    require('./w3').push(r.org_id, Number(r.user_id), 'chat', r.note ? `Rappel du chat : ${oneLine(r.note, 120)}` : 'Rappel du chat : un message vous attend.', `chat:${r.conv_id}`).catch(() => {});
  }
}
async function tick() {
  if (busy) return;
  try { await db.ready; } catch { return; }
  busy = true;
  try { await sendDue(); await remindDue(); await require('./chat-calls').sweep(); if (Date.now() % 12 === 0 || !tick.lastPurge || Date.now() - tick.lastPurge > 3600000) { tick.lastPurge = Date.now(); await require('./chat-geo').purge(); } } catch (e) { log.warn('Chat : tâche de fond :', oneLine(e.message, 160)); } finally { busy = false; }
}
let timer = null;
function start() {
  if (timer || process.env.CHAT_JOBS === 'off') return;
  timer = setInterval(tick, 5000); // les tâches attendent que la base soit prête (migrations appliquées)
  if (timer.unref) timer.unref();
  db.ready.then(() => require('./chat-calls').closeStale()).catch(() => {});
}
// Démarre avec le serveur (le module est chargé une fois, au montage des routes). Les tests peuvent appeler tick() directement.
start();
module.exports = { tick, start };
