'use strict';
// Rendez-vous pris par l'assistant public (ou saisis par l'équipe) : créneaux vérifiés par le serveur (jamais confiés à l'IA),
// pas de double réservation, liste et suivi pour l'équipe, confirmation envoyée au client sur son canal.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const crypto = require('crypto');
const channels = require('./channels');
const waOut = require('./wa-out');
const waOrg = require('../services/waOrg');
const { HttpError, asyncHandler, cleanText, oneLine, log } = require('../util');

const DURATION = 60;                 // minutes par rendez-vous
const OPEN = '06:00'; const CLOSE = '21:00';
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const frDate = (d) => { const [y, m, j] = d.split('-').map(Number); const wd = DAYS[new Date(Date.UTC(y, m - 1, j)).getUTCDay()]; return `${wd} ${String(j).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`; };
const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const localNow = () => new Date(Date.now() + 3600000); // heure du Cameroun (UTC+1)
const todayStr = () => localNow().toISOString().slice(0, 10);
const nowTime = () => localNow().toISOString().slice(11, 16);

/** Vérifie date, heure et disponibilité. Renvoie '' si le créneau est libre, sinon la raison. */
async function slotProblem(orgId, date, time, ignoreId) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(date)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) return 'Date ou heure invalide.';
  const t = todayStr();
  if (date < t || (date === t && time <= nowTime())) return 'Ce créneau est déjà passé.';
  if (date > new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10)) return 'Les rendez-vous se prennent dans les 6 prochains mois.';
  if (time < OPEN || mins(time) + DURATION > mins(CLOSE) + 0) return `Les rendez-vous ont lieu entre ${OPEN.replace(':', 'h')} et ${CLOSE.replace(':', 'h')}.`;
  const same = await db.prepare("SELECT time FROM appointments WHERE org_id = ? AND date = ? AND status IN ('pending','confirmed') AND id != ?").all(orgId, date, ignoreId || 0);
  if (same.some((r) => Math.abs(mins(r.time) - mins(time)) < DURATION)) return 'Ce créneau est déjà pris.';
  return '';
}
/** Créneaux déjà réservés les 14 prochains jours, pour que l'IA n'en propose pas. */
async function busyText(orgId) {
  const rows = await db.prepare("SELECT date, time FROM appointments WHERE org_id = ? AND status IN ('pending','confirmed') AND date >= ? AND date <= ? ORDER BY date, time LIMIT 40").all(orgId, todayStr(), new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
  return rows.length ? rows.map((r) => `${frDate(r.date)} à ${r.time}`).join(' ; ') : 'aucun';
}

/** Création demandée par l'IA. Renvoie { appt } ou { error }. */
async function create(org, chat, a, customerId) {
  const date = String(a.date || '').trim(); const time = String(a.time || '').trim();
  const bad = await slotProblem(org.id, date, time);
  if (bad) return { error: bad };
  const now = nowISO();
  const id = (await db.prepare("INSERT INTO appointments (org_id, customer_id, chat_id, date, time, duration, purpose, place, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assistant', ?, ?)")
    .run(org.id, customerId || null, chat.id, date, time, DURATION, cleanText(a.purpose, 200), cleanText(a.place, 160), now, now)).lastInsertRowid;
  await A.logActivity(org.id, null, 'sales', `Nouveau rendez-vous : ${frDate(date)} à ${time}`);
  return { appt: { id: Number(id), date, time, label: `${frDate(date)} à ${time.replace(':', 'h')}`, purpose: cleanText(a.purpose, 200) } };
}

// ---------- Routes (responsables et plus ; chacun voit tous les rendez-vous de l'organisation) ----------
const router = express.Router({ mergeParams: true });
const view = (r) => ({ id: r.id, date: r.date, time: r.time, label: `${frDate(r.date)} à ${r.time.replace(':', 'h')}`, purpose: r.purpose, place: r.place, note: r.note, status: r.status, source: r.source, customerId: r.customer_id, customer: r.customer || null, phone: r.phone || null, chatId: r.chat_id, channel: r.channel || null });
const ST = ['pending', 'confirmed', 'cancelled', 'done'];

router.get('/appointments', async (req, res) => {
  const filter = ST.includes(req.query.status) ? req.query.status : null;
  const rows = await db.prepare(`SELECT a.*, c.name AS customer, c.phone, ch.channel FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN chats ch ON ch.id = a.chat_id
    WHERE a.org_id = ?${filter ? ' AND a.status = ?' : " AND a.status IN ('pending','confirmed')"} ORDER BY a.date, a.time LIMIT 200`).all(...(filter ? [req.org.id, filter] : [req.org.id]));
  res.json({ appointments: rows.map(view), today: todayStr() });
});
router.post('/appointments', async (req, res) => {
  const b = req.body || {};
  const cid = b.customerId ? await db.prepare('SELECT id FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId), req.org.id) : null;
  const bad = await slotProblem(req.org.id, b.date, b.time);
  if (bad) throw new HttpError(400, bad);
  const now = nowISO();
  const id = (await db.prepare("INSERT INTO appointments (org_id, customer_id, date, time, duration, purpose, place, note, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'equipe', ?, ?)")
    .run(req.org.id, cid ? cid.id : null, b.date, b.time, DURATION, cleanText(b.purpose, 200), cleanText(b.place, 160), cleanText(b.note, 500), now, now)).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'sales', `Rendez-vous ajouté : ${frDate(b.date)} à ${b.time}`);
  res.status(201).json({ id: Number(id) });
});
router.put('/appointments/:id', asyncHandler(async (req, res) => {
  const a = await db.prepare('SELECT * FROM appointments WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Rendez-vous introuvable.');
  const b = req.body || {};
  const status = b.status === undefined ? a.status : A.oneOf(b.status, ST, undefined, 'Statut inconnu.');
  const date = b.date === undefined ? a.date : b.date; const time = b.time === undefined ? a.time : b.time;
  if ((date !== a.date || time !== a.time) && status !== 'cancelled') { const bad = await slotProblem(req.org.id, date, time, a.id); if (bad) throw new HttpError(400, bad); }
  await db.prepare('UPDATE appointments SET status = ?, date = ?, time = ?, purpose = ?, place = ?, note = ?, updated_at = ? WHERE id = ?').run(status, date, time,
    b.purpose === undefined ? a.purpose : cleanText(b.purpose, 200), b.place === undefined ? a.place : cleanText(b.place, 160), b.note === undefined ? a.note : cleanText(b.note, 500), nowISO(), a.id);
  // Confirmation ou changement : le client est prévenu sur son canal (s'il a écrit il y a moins de 24 h).
  let notified = false;
  if (b.notify && a.chat_id && (status !== a.status || date !== a.date || time !== a.time) && ['confirmed', 'cancelled'].includes(status)) {
    const chat = await db.prepare('SELECT * FROM chats WHERE id = ?').get(a.chat_id);
    const last = chat && await db.prepare("SELECT created_at FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chat.id);
    if (chat && chat.channel !== 'web' && channels.isConnected(req.org, chat.channel) && last && Date.now() - Date.parse(last.created_at) < 24 * 3600000) {
      const text = status === 'confirmed' ? `Votre rendez-vous du ${frDate(date)} à ${time.replace(':', 'h')} est confirmé. À bientôt !` : `Votre rendez-vous du ${frDate(a.date)} à ${a.time.replace(':', 'h')} est annulé. Écrivez-nous pour en fixer un autre.`;
      try { await channels.sendText(req.org, chat, text); await db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'staff', ?, ?)").run(chat.id, text, nowISO()); notified = true; } catch (e) { log.warn('Confirmation de rendez-vous non envoyée :', oneLine(e.message, 120)); }
    }
  }
  await A.logActivity(req.org.id, req.user.id, 'sales', `Rendez-vous ${status === 'confirmed' ? 'confirmé' : status === 'cancelled' ? 'annulé' : status === 'done' ? 'terminé' : 'modifié'}`);
  res.json({ ok: true, notified });
}));
router.delete('/appointments/:id', A.need('admin'), async (req, res) => { await db.prepare('DELETE FROM appointments WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id); res.json({ ok: true }); });


// ---------- Agenda (Google Agenda, Outlook, Apple Calendrier) : lien d'abonnement en lecture seule ----------
const icsEsc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) { // lignes de 75 octets au plus (norme iCalendar), sans couper un caractère
  const out = []; let cur = ''; let bytes = 0;
  for (const ch of line) { const b = Buffer.byteLength(ch); if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; } cur += ch; bytes += b; }
  out.push(cur); return out.join('\r\n ');
}
/** Date et heure du Cameroun (UTC+1) -> UTC au format iCalendar. */
const utcStamp = (date, time, plusMin = 0) => { const [y, m, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number); return new Date(Date.UTC(y, m - 1, d, h - 1, mi + plusMin)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
function icsEvent(org, a) {
  const st = a.status === 'confirmed' || a.status === 'done' ? 'CONFIRMED' : a.status === 'cancelled' ? 'CANCELLED' : 'TENTATIVE';
  const lines = ['BEGIN:VEVENT', `UID:appt-${a.id}-${org.id}@manager-ia`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`, `LAST-MODIFIED:${utcStamp(a.updated_at.slice(0, 10), a.updated_at.slice(11, 16), 60)}`,
    `DTSTART:${utcStamp(a.date, a.time)}`, `DTEND:${utcStamp(a.date, a.time, a.duration)}`, `SUMMARY:${icsEsc(`Rendez-vous : ${a.customer || 'client'}${a.purpose ? ' - ' + a.purpose : ''}`)}`,
    `DESCRIPTION:${icsEsc([a.customer && `Client : ${a.customer}`, a.phone && `Téléphone : ${a.phone}`, a.channel && `Canal : ${a.channel}`, a.note, 'Géré avec Brij-IA'].filter(Boolean).join('\n'))}`, `STATUS:${st}`, 'TRANSP:OPAQUE'];
  if (a.place) lines.push(`LOCATION:${icsEsc(a.place)}`);
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Rendez-vous dans 1 heure', 'TRIGGER:-PT1H', 'END:VALARM', 'END:VEVENT');
  return lines.map(fold).join('\r\n');
}
/** Contenu du fichier .ics : rendez-vous des 30 derniers jours et des 180 prochains (les annulés sont marqués annulés pour disparaître des agendas). */
async function icsFeed(org) {
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10); const to = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  const rows = await db.prepare(`SELECT a.*, c.name AS customer, c.phone, ch.channel FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN chats ch ON ch.id = a.chat_id WHERE a.org_id = ? AND a.date >= ? AND a.date <= ? ORDER BY a.date, a.time`).all(org.id, from, to);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brij-IA//Rendez-vous//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(`Rendez-vous - ${org.name}`)}`, 'X-WR-TIMEZONE:Africa/Douala', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...rows.map((a) => icsEvent(org, a)), 'END:VCALENDAR'].map((l) => (l.includes('\r\n') ? l : fold(l))).join('\r\n') + '\r\n';
}

router.get('/calendar', A.need('admin'), (req, res) => {
  const base = (require('../config').apiPublicUrl || '').replace(/\/+$/, '');
  res.json({ configured: Boolean(req.org.cal_token), path: req.org.cal_token ? `/api/ws/public/calendar/${req.org.cal_token}.ics` : '', url: req.org.cal_token && base ? `${base}/api/ws/public/calendar/${req.org.cal_token}.ics` : '' });
});
router.post('/calendar/regenerate', A.need('admin'), async (req, res) => {
  const t = crypto.randomBytes(18).toString('hex');
  await db.prepare('UPDATE orgs SET cal_token = ? WHERE id = ?').run(t, req.org.id);
  await A.logActivity(req.org.id, req.user.id, 'sales', "Lien d'agenda (re)généré : l'ancien lien ne marche plus");
  res.json({ path: `/api/ws/public/calendar/${t}.ics` });
});
router.get('/appointments/:id/ics', async (req, res) => {
  const a = await db.prepare('SELECT a.*, c.name AS customer, c.phone, ch.channel FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN chats ch ON ch.id = a.chat_id WHERE a.id = ? AND a.org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!a) throw new HttpError(404, 'Rendez-vous introuvable.');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="rendez-vous-${a.date}.ics"`, 'Cache-Control': 'no-store' });
  res.send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brij-IA//Rendez-vous//FR', icsEvent(req.org, a), 'END:VCALENDAR'].join('\r\n') + '\r\n');
});

// ---------- Rappels automatiques la veille ----------
// Le rendez-vous CONFIRMÉ de demain est rappelé au client sur son canal, à partir de 16 h (heure du Cameroun). Dans les 24 h après son dernier message : texte libre.
// Sinon, WhatsApp exige un modèle approuvé par Meta (type « Rappel de rendez-vous ») ; Messenger et Instagram n'ont pas de modèle : pas de rappel dans ce cas.
const testing = () => process.env.NODE_ENV !== 'production';
const reminderHour = () => (testing() && process.env.REMINDER_HOUR !== undefined ? Number(process.env.REMINDER_HOUR) : 16);
async function runReminders() {
  const l = localNow();
  if (l.getUTCHours() < reminderHour()) return 0;
  const tomorrow = new Date(l.getTime() + 86400000).toISOString().slice(0, 10);
  let n = 0;
  for (const org of await db.prepare('SELECT * FROM orgs WHERE appt_reminder = 1').all()) {
    const rows = await db.prepare("SELECT a.*, c.name AS customer, c.phone FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id WHERE a.org_id = ? AND a.status = 'confirmed' AND a.date = ? AND a.reminded_at IS NULL").all(org.id, tomorrow);
    for (const a of rows) {
      try {
        const chat = a.chat_id ? await db.prepare('SELECT * FROM chats WHERE id = ?').get(a.chat_id) : null;
        const first = waOut.firstName(a.customer);
        const text = `Rappel : vous avez rendez-vous demain, ${frDate(a.date)} à ${a.time.replace(':', 'h')}${a.purpose ? ' (' + a.purpose + ')' : ''}, chez ${org.name}. Répondez à ce message si vous devez le déplacer.`;
        let sent = false;
        if (chat && chat.channel !== 'web' && channels.isConnected(org, chat.channel)) {
          const last = await db.prepare("SELECT created_at FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chat.id);
          if (last && Date.now() - Date.parse(last.created_at) < 24 * 3600000) { await channels.sendText(org, chat, text); await db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").run(chat.id, `[rappel] ${text}`, nowISO()); sent = true; }
          else if (chat.channel === 'whatsapp') { const tpl = await waOut.tplOf(org.id, 'rdv'); if (tpl) sent = (await waOut.sendTemplate(org, { phone: chat.contact, tpl, params: [first, frDate(a.date), a.time.replace(':', 'h'), org.name], chat, refKind: 'appt', refId: a.id })).ok; }
        } else if (!chat && a.phone && waOrg.isConnected(org)) {
          const tpl = await waOut.tplOf(org.id, 'rdv'); if (tpl) sent = (await waOut.sendTemplate(org, { phone: a.phone, tpl, params: [first, frDate(a.date), a.time.replace(':', 'h'), org.name], refKind: 'appt', refId: a.id })).ok;
        }
        if (sent) { await db.prepare('UPDATE appointments SET reminded_at = ? WHERE id = ?').run(nowISO(), a.id); n++; }
      } catch (e) { log.warn('Rappel de rendez-vous :', oneLine(e.message, 140)); }
    }
  }
  if (n) log.info(`Rappels de rendez-vous envoyés : ${n}.`);
  return n;
}
let remTimer = null;
function startReminders() {
  if (remTimer) return;
  const every = (testing() && Number(process.env.REMINDER_TICK_MS)) || 10 * 60 * 1000;
  remTimer = setInterval(async () => { runReminders().catch(() => {}); }, every);
  if (remTimer.unref) remTimer.unref();
}

module.exports = { router, create, busyText, frDate, todayStr, slotProblem, icsFeed, runReminders, startReminders };

