'use strict';
// Résumé du matin et alertes urgentes par WhatsApp pour les responsables (manager, admin, owner).
// - Jamais d'envoi sans consentement explicite (date enregistrée, lié au numéro) ; désabonnement en un clic.
// - Message composé par le serveur à partir des données (aucun appel à l'IA).
// - Planificateur : chaque tick (voir jobs.js), verrou en base par personne / type / jour (clé unique) : pas de doublon, même avec plusieurs serveurs.
// - Contrainte WhatsApp : un texte libre n'est livré que si la personne a écrit à l'entreprise dans les dernières 24 h. Sinon Meta refuse (code 131047) :
//   l'échec est enregistré, on bascule sur l'e-mail s'il existe, et un modèle approuvé peut être indiqué pour remplacer le texte libre.
// Les routes sont montées sous /mail/digest (module « Alertes », réservé aux responsables).
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const A = require('./access');
const waOrg = require('../services/waOrg');
const { sendMail, mailEnabled } = require('../services/notify');
const { HttpError, asyncHandler, oneLine, isEmail, log } = require('../util');

const router = express.Router({ mergeParams: true });

const DEFAULTS = { tz_offset: 60, urgent_max_day: 5, handoff_hours: 4, invoice_late_days: 30 };
const CATCHUP_MIN = 360; // rattrapage : un résumé manqué (serveur arrêté) part encore jusqu'à 6 h après l'heure choisie
const MAX_EVENTS = 5;
const CONSENT = "J'accepte de recevoir, sur ce numéro WhatsApp, le résumé du matin et/ou les alertes urgentes de mon organisation. Je peux me désabonner à tout moment.";
const KIND_LABEL = { morning: 'Résumé du matin', urgent: 'Alerte urgente', test: 'Test' };

const digits = (x) => String(x || '').replace(/\D/g, '');
const CC = String(process.env.DEFAULT_COUNTRY_CODE || '237').replace(/\D/g, '');
const intl = (x) => { let d = digits(x); if (d.startsWith('00')) d = d.slice(2); return d.length === 9 && /^[2368]/.test(d) ? CC + d : d; };
const phoneOk = (x) => { const d = intl(x); return d.length >= 8 && d.length <= 15; };
const fmtMoney = (n, cur) => `${Number(n).toLocaleString('fr-FR')} ${cur}`.replace(/[  ]/g, ' ');
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const rand = () => crypto.randomBytes(5).toString('hex');

async function settingsOf(orgId) {
  const r = await db.prepare('SELECT * FROM digest_settings WHERE org_id = ?').get(orgId);
  return { ...DEFAULTS, ...(r || {}) };
}
/** Heure locale de l'organisation (décalage en minutes par rapport à UTC ; UTC+1 par défaut). */
function localClock(off) {
  const d = new Date(Date.now() + off * 60000);
  const date = d.toISOString().slice(0, 10);
  return { date, minute: d.getUTCHours() * 60 + d.getUTCMinutes(), dayStartUTC: new Date(Date.parse(`${date}T00:00:00.000Z`) - off * 60000).toISOString() };
}
const addDaysStr = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const frDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const reqFor = (org, user, member) => ({ org, user, member });

// ---------- Composition (sans IA) ----------
async function composeMorning(req, date) {
  const o = req.org; const cur = o.currency;
  const lines = [];
  const crm = require('./crm');
  const late = await crm.overdueList(req);
  if (late.length) lines.push(`- Impayés : ${plural(late.length, 'facture en retard', 'factures en retard')}, ${fmtMoney(late.reduce((a, d) => a + d.total - d.paid, 0), cur)} au total.`);
  const items = await require('./stock').items(req);
  const out0 = items.filter((i) => i.quantity <= 0).length;
  const low = items.filter((i) => i.quantity > 0 && i.min_quantity > 0 && i.quantity <= i.min_quantity).length;
  if (out0 || low) lines.push(`- Stock : ${[out0 ? plural(out0, 'article en rupture', 'articles en rupture') : '', low ? `${plural(low, 'sous son seuil', 'sous leur seuil')}` : ''].filter(Boolean).join(', ')}.`);
  const sc = A.scope(req);
  const overdue = (await db.prepare(`SELECT COUNT(*) c FROM tasks WHERE org_id = ? AND status != 'done' AND due IS NOT NULL AND due < ?${sc.sql}`).get(o.id, date, ...sc.args)).c;
  if (overdue) lines.push(`- Tâches en retard : ${overdue}.`);
  const to = addDaysStr(date, 7);
  const tasksSoon = (await db.prepare(`SELECT COUNT(*) c FROM tasks WHERE org_id = ? AND status != 'done' AND due IS NOT NULL AND due >= ? AND due <= ?${sc.sql}`).get(o.id, date, to, ...sc.args)).c;
  const invSoon = (await db.prepare(`SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'invoice' AND status = 'sent' AND paid < total AND due IS NOT NULL AND due >= ? AND due <= ?${sc.sql}`).get(o.id, date, to, ...sc.args)).c;
  const projSoon = (await db.prepare(`SELECT COUNT(*) c FROM projects WHERE org_id = ? AND status = 'active' AND due IS NOT NULL AND due >= ? AND due <= ?${sc.sql}`).get(o.id, date, to, ...sc.args)).c;
  const soon = [tasksSoon ? plural(tasksSoon, 'tâche', 'tâches') : '', invSoon ? plural(invSoon, 'facture à encaisser', 'factures à encaisser') : '', projSoon ? plural(projSoon, 'projet', 'projets') : ''].filter(Boolean);
  if (soon.length) lines.push(`- Échéances dans 7 jours : ${soon.join(', ')}.`);
  const waiting = (await db.prepare("SELECT COUNT(*) c FROM chats WHERE org_id = ? AND status = 'handoff'").get(o.id)).c;
  if (waiting) lines.push(`- Conversations en attente d'un conseiller : ${waiting}.`);
  const first = String(req.user.name || '').trim().split(/\s+/)[0] || '';
  const head = `Bonjour${first ? ' ' + first : ''}, voici le point du matin de ${o.name} (${frDate(date)}).`;
  const body = lines.length ? lines.join('\n') : "Rien d'urgent ce matin : tout est à jour.";
  return { text: `${head}\n${body}\nOuvrez MANAGER-IA pour le détail. Pour ne plus recevoir ce message : Alertes > Résumé du matin.`.slice(0, 1500), empty: !lines.length };
}

/** Événements urgents du moment : rupture de stock, facture très en retard, conversation en attente trop longtemps. */
async function urgentEvents(req, st, date) {
  const o = req.org; const out = [];
  for (const i of (await require('./stock').items(req)).filter((x) => x.quantity <= 0).slice(0, 30)) out.push({ key: `stock:${i.id}`, text: `Rupture de stock : ${oneLine(i.name, 60)}` });
  for (const d of await require('./crm').overdueList(req)) {
    const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${d.due}T00:00:00Z`)) / 86400000);
    if (days > st.invoice_late_days) out.push({ key: `inv:${d.id}`, text: `Facture ${d.number} (${oneLine(d.customer, 40)}) impayée depuis ${days} jours : reste ${fmtMoney(d.total - d.paid, o.currency)}` });
  }
  const cut = new Date(Date.now() - st.handoff_hours * 3600000).toISOString();
  for (const c of await db.prepare("SELECT id, updated_at FROM chats WHERE org_id = ? AND status = 'handoff' AND updated_at < ? ORDER BY updated_at LIMIT 30").all(o.id, cut)) {
    const h = Math.round((Date.now() - Date.parse(c.updated_at)) / 3600000);
    out.push({ key: `chat:${c.id}`, text: `Une conversation client attend un conseiller depuis ${h} h` });
  }
  return out;
}
const composeUrgent = (org, events) => `Alerte urgente — ${org.name}\n${events.slice(0, MAX_EVENTS).map((e) => `- ${e.text}`).join('\n')}${events.length > MAX_EVENTS ? `\n- … et ${events.length - MAX_EVENTS} autre(s)` : ''}\nOuvrez MANAGER-IA pour agir.`.slice(0, 1500);

// ---------- Envoi : WhatsApp, puis e-mail si WhatsApp ne livre pas ----------
const isWindowError = (e) => e && (e.metaCode === 131047 || /re-?engagement|24[ -]?hour|outside the allowed window/i.test(String(e.message)));

async function deliver(org, user, sub, text, subject) {
  const to = intl(sub.phone);
  let waError = ''; let waStatus = 'failed';
  if (!waOrg.isConnected(org)) waError = "WhatsApp n'est pas connecté pour cette organisation.";
  else if (!phoneOk(to)) waError = 'Numéro de téléphone invalide.';
  else if (await require('./wa-out').isOptedOut(org.id, to)) { waError = 'Ce numéro a demandé à ne plus recevoir de messages WhatsApp (STOP).'; }
  else {
    try {
      if (sub.template_name && waOrg.modeOf(org) !== 'qr') await waOrg.sendTemplate(org, to, sub.template_name, 'fr', [oneLine(text, 900)]);
      else await waOrg.sendText(org, to, text);
      return { channel: 'whatsapp', status: 'delivered', waError: '' };
    } catch (e) {
      if (isWindowError(e)) { waStatus = 'window_closed'; waError = "WhatsApp a refusé le message : vous n'avez pas écrit au numéro de l'entreprise depuis plus de 24 h. Il faut un modèle de message approuvé par Meta."; }
      else waError = `WhatsApp a refusé l'envoi : ${oneLine(String(e.message).replace(/^.*HTTP \d+ : /, ''), 160)}`;
    }
  }
  if (isEmail(user.contact) && mailEnabled()) {
    try {
      if (await sendMail({ to: user.contact, subject: oneLine(`[${org.name}] ${subject}`, 150), text, fromName: org.name })) return { channel: 'email', status: 'emailed', waError };
    } catch (e) { log.warn('Résumé : e-mail de secours non envoyé :', oneLine(e.message, 160)); }
  }
  return { channel: 'whatsapp', status: waStatus, waError };
}

async function finish(where, args, r) {
  await db.prepare(`UPDATE digest_log SET channel = ?, status = ?, wa_error = ? WHERE ${where}`).run(r.channel, r.status, r.waError || '', ...args);
}
/** Prend le verrou (clé unique) : renvoie true si CE serveur doit envoyer. */
async function claim(orgId, userId, kind, key, batch) {
  return (await db.prepare('INSERT OR IGNORE INTO digest_log (org_id, user_id, kind, dedupe_key, batch, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(orgId, userId, kind, key, batch || '', nowISO())).changes === 1;
}

async function processSub(org, st, s) {
  const clock = localClock(st.tz_offset);
  const req = reqFor(org, { id: s.user_id, name: s.uname, contact: s.ucontact }, { user_id: s.user_id, org_id: s.org_id, role: s.role, branch_id: s.branch_id, title: s.title });
  const user = req.user;
  if (s.morning && clock.minute >= s.send_minute && clock.minute < s.send_minute + CATCHUP_MIN) {
    if (await claim(org.id, user.id, 'morning', clock.date)) {
      try {
        const { text } = await composeMorning(req, clock.date);
        await finish('org_id = ? AND user_id = ? AND kind = ? AND dedupe_key = ?', [org.id, user.id, 'morning', clock.date], await deliver(org, user, s, text, 'Votre résumé du matin'));
      } catch (e) {
        log.warn('Résumé du matin en échec :', oneLine(e.message, 160));
        await finish('org_id = ? AND user_id = ? AND kind = ? AND dedupe_key = ?', [org.id, user.id, 'morning', clock.date], { channel: '', status: 'failed', waError: 'Erreur interne : le résumé n\'a pas pu être préparé.' });
      }
    }
  }
}

async function processUrgent(org, st, s) {
  const clock = localClock(st.tz_offset);
  const req = reqFor(org, { id: s.user_id, name: s.uname, contact: s.ucontact }, { user_id: s.user_id, org_id: s.org_id, role: s.role, branch_id: s.branch_id, title: s.title });
  const user = req.user;
  const week = Math.floor(Date.now() / (7 * 86400000));
  const events = (await urgentEvents(req, st, clock.date)).map((e) => ({ ...e, key: `${e.key}:w${week}` }));
  if (!events.length) return;
  const known = new Set((await db.prepare("SELECT dedupe_key FROM digest_log WHERE org_id = ? AND user_id = ? AND kind = 'urgent' AND dedupe_key LIKE ?").all(org.id, user.id, `%:w${week}`)).map((r) => r.dedupe_key));
  const fresh = events.filter((e) => !known.has(e.key));
  if (!fresh.length) return;
  // Anti-spam : au plus N messages d'alerte par jour et par personne.
  const sent = (await db.prepare("SELECT COUNT(DISTINCT batch) c FROM digest_log WHERE org_id = ? AND user_id = ? AND kind = 'urgent' AND created_at >= ?").get(org.id, user.id, clock.dayStartUTC)).c;
  if (sent >= st.urgent_max_day) return;
  const batch = `b${rand()}`;
  const mine = [];
  for (const e of fresh.slice(0, 20)) if (await claim(org.id, user.id, 'urgent', e.key, batch)) mine.push(e);
  if (!mine.length) return;
  let r;
  try { r = await deliver(org, user, s, composeUrgent(org, mine), 'Alerte urgente'); } catch (e) { log.warn('Alerte urgente en échec :', oneLine(e.message, 160)); r = { channel: '', status: 'failed', waError: 'Erreur interne.' }; }
  await finish('org_id = ? AND user_id = ? AND kind = ? AND batch = ?', [org.id, user.id, 'urgent', batch], r);
}

let running = false;
let lastUrgent = 0;
/** Appelé régulièrement par jobs.js. Ne bloque rien, ne plante jamais ; plusieurs serveurs : le verrou en base évite les doublons. */
async function tick() {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const testing = process.env.NODE_ENV !== 'production';
    const everyUrgent = (testing && Number(process.env.DIGEST_URGENT_MS)) || 5 * 60 * 1000;
    const doUrgent = Date.now() - lastUrgent >= everyUrgent;
    if (doUrgent) lastUrgent = Date.now();
    const subs = await db.prepare(`SELECT s.*, u.name AS uname, u.contact AS ucontact, m.role, m.branch_id, m.title FROM digest_subs s
      JOIN users u ON u.id = s.user_id JOIN org_members m ON m.org_id = s.org_id AND m.user_id = s.user_id
      WHERE (s.morning = 1 OR s.urgent = 1) AND s.consent_at IS NOT NULL AND s.unsub_at IS NULL AND m.role IN ('manager', 'admin', 'owner') ORDER BY s.org_id, s.id LIMIT 2000`).all();
    const orgs = new Map(); const sets = new Map();
    for (const s of subs) {
      try {
        if (!orgs.has(s.org_id)) { orgs.set(s.org_id, await db.prepare('SELECT * FROM orgs WHERE id = ?').get(s.org_id)); sets.set(s.org_id, await settingsOf(s.org_id)); }
        const org = orgs.get(s.org_id); const st = sets.get(s.org_id);
        if (!org) continue;
        if (s.morning) { await processSub(org, st, s); n++; }
        if (s.urgent && doUrgent) { await processUrgent(org, st, s); n++; }
      } catch (e) { log.warn('Résumé / alertes WhatsApp :', oneLine(e.message, 160)); }
    }
  } finally { running = false; }
  return n;
}

// ---------- Routes ----------
const logView = (r, admin) => ({ id: r.id, at: r.created_at, kind: r.kind, kindLabel: KIND_LABEL[r.kind] || r.kind, channel: r.channel, status: r.status, waError: r.wa_error, who: (admin && r.who) || undefined });
const STATUS_TEXT = {
  delivered: 'Livré sur WhatsApp',
  window_closed: 'Non livré (fenêtre WhatsApp fermée)',
  emailed: "WhatsApp n'a pas livré : envoyé par e-mail à la place",
  failed: 'Non livré',
  pending: 'En cours',
};

router.get('/', async (req, res) => {
  const st = await settingsOf(req.org.id);
  const sub = await db.prepare('SELECT * FROM digest_subs WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  const admin = A.can(req, 'admin');
  const raw = await db.prepare(`SELECT l.*, u.name AS who FROM digest_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ?${admin ? '' : ' AND l.user_id = ?'} AND l.status != 'pending' ORDER BY l.id DESC LIMIT 120`)
    .all(...(admin ? [req.org.id] : [req.org.id, req.user.id]));
  const seen = new Set(); // une alerte regroupant plusieurs événements n'apparaît qu'une fois
  const rows = raw.filter((r) => { if (r.kind !== 'urgent') return true; const k = `${r.user_id}:${r.batch}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
  const mine = rows.find((r) => r.user_id === req.user.id);
  res.json({
    connected: waOrg.isConnected(req.org), mailEnabled: mailEnabled(), hasEmail: isEmail(req.user.contact), consentText: CONSENT, statusText: STATUS_TEXT,
    me: sub ? { phone: sub.phone, morning: Boolean(sub.morning), urgent: Boolean(sub.urgent), hour: hhmm(sub.send_minute), templateName: sub.template_name, consented: Boolean(sub.consent_at && !sub.unsub_at), consentAt: sub.consent_at, unsubAt: sub.unsub_at }
      : { phone: '', morning: false, urgent: false, hour: '08:00', templateName: '', consented: false, consentAt: null, unsubAt: null },
    settings: { tzOffset: st.tz_offset, urgentMaxPerDay: st.urgent_max_day, handoffHours: st.handoff_hours, invoiceLateDays: st.invoice_late_days, canEdit: admin },
    last: mine ? logView(mine, admin) : null,
    log: rows.map((r) => logView(r, admin)),
  });
});

router.put('/me', async (req, res) => {
  const b = req.body || {};
  const morning = Boolean(b.morning); const urgent = Boolean(b.urgent);
  const sub = await db.prepare('SELECT * FROM digest_subs WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  const phone = A.text(b.phone, 30);
  const hm = /^(\d{1,2}):(\d{2})$/.exec(String(b.hour || '08:00'));
  if (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 59) throw new HttpError(400, "Heure invalide (format HH:MM, par exemple 07:30).");
  const minute = Number(hm[1]) * 60 + Number(hm[2]);
  const tpl = A.text(b.templateName, 80);
  if (tpl && !/^[a-z0-9_]{1,80}$/.test(tpl)) throw new HttpError(400, "Le nom d'un modèle Meta ne contient que des minuscules, chiffres et « _ » (ex. resume_matin).");
  const now = nowISO();
  let consentAt = sub ? sub.consent_at : null; let unsubAt = sub ? sub.unsub_at : null;
  if (morning || urgent) {
    if (!phoneOk(phone)) throw new HttpError(400, 'Indiquez votre numéro WhatsApp avec l\'indicatif du pays (ex. 237 677 11 22 33).');
    // Le consentement est lié au numéro : un autre numéro demande un nouveau consentement.
    const need = !sub || !sub.consent_at || sub.unsub_at || intl(sub.phone) !== intl(phone);
    if (need && b.consent !== true) throw new HttpError(400, 'Cochez la case de consentement pour recevoir des messages sur ce numéro.');
    if (need) { consentAt = now; unsubAt = null; }
  } else if (sub && sub.consent_at && !sub.unsub_at) unsubAt = now; // tout décocher = se désabonner
  await db.prepare(`INSERT INTO digest_subs (org_id, user_id, phone, morning, urgent, send_minute, template_name, consent_at, consent_text, unsub_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, user_id) DO UPDATE SET phone = EXCLUDED.phone, morning = EXCLUDED.morning, urgent = EXCLUDED.urgent, send_minute = EXCLUDED.send_minute, template_name = EXCLUDED.template_name,
    consent_at = EXCLUDED.consent_at, consent_text = EXCLUDED.consent_text, unsub_at = EXCLUDED.unsub_at, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, req.user.id, phone, morning ? 1 : 0, urgent ? 1 : 0, minute, tpl, consentAt, consentAt ? CONSENT : '', unsubAt, now);
  await A.logActivity(req.org.id, req.user.id, 'alerts', morning || urgent ? 'Résumé et alertes WhatsApp : réglages enregistrés' : 'Résumé et alertes WhatsApp : désabonnement');
  res.json({ ok: true });
});

// Désabonnement en un clic
router.post('/me/unsubscribe', async (req, res) => {
  await db.prepare('UPDATE digest_subs SET morning = 0, urgent = 0, unsub_at = ?, updated_at = ? WHERE org_id = ? AND user_id = ?').run(nowISO(), nowISO(), req.org.id, req.user.id);
  await A.logActivity(req.org.id, req.user.id, 'alerts', 'Résumé et alertes WhatsApp : désabonnement');
  res.json({ ok: true });
});

router.post('/test', limits.make(60 * 1000, 10, 'Trop de tests. Patientez une minute.'), asyncHandler(async (req, res) => {
  const sub = await db.prepare('SELECT * FROM digest_subs WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  if (!sub || !sub.consent_at || sub.unsub_at || !phoneOk(sub.phone)) throw new HttpError(400, "Enregistrez d'abord votre numéro et votre consentement, puis réessayez.");
  const clock = localClock((await settingsOf(req.org.id)).tz_offset);
  const { text } = await composeMorning(req, clock.date);
  const key = `t${Date.now()}${rand()}`;
  await claim(req.org.id, req.user.id, 'test', key);
  const r = await deliver(req.org, req.user, sub, `[Test] ${text}`, 'Test du résumé du matin');
  await finish('org_id = ? AND user_id = ? AND kind = ? AND dedupe_key = ?', [req.org.id, req.user.id, 'test', key], r);
  res.json({ status: r.status, channel: r.channel, statusText: STATUS_TEXT[r.status] || r.status, waError: r.waError || '' });
}));

router.put('/settings', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const cur = await settingsOf(req.org.id);
  const num = (v, lo, hi, def, msg) => { if (v === undefined || v === '') return def; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, msg); return n; };
  const tz = num(b.tzOffset, -720, 840, cur.tz_offset, 'Décalage horaire invalide (en minutes par rapport à UTC, ex. 60 pour UTC+1).');
  const maxDay = num(b.urgentMaxPerDay, 1, 20, cur.urgent_max_day, "Le nombre d'alertes par jour doit être entre 1 et 20.");
  const hours = num(b.handoffHours, 1, 72, cur.handoff_hours, "L'attente d'un conseiller doit être entre 1 et 72 heures.");
  const days = num(b.invoiceLateDays, 1, 365, cur.invoice_late_days, 'Le retard de facture doit être entre 1 et 365 jours.');
  await db.prepare(`INSERT INTO digest_settings (org_id, tz_offset, urgent_max_day, handoff_hours, invoice_late_days, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET tz_offset = EXCLUDED.tz_offset, urgent_max_day = EXCLUDED.urgent_max_day, handoff_hours = EXCLUDED.handoff_hours, invoice_late_days = EXCLUDED.invoice_late_days, updated_at = EXCLUDED.updated_at`)
    .run(req.org.id, tz, maxDay, hours, days, nowISO());
  res.json({ ok: true });
});

module.exports = { router, tick, composeMorning, composeUrgent, localClock, intl };
