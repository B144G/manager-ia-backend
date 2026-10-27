'use strict';
// Résumé du matin et alertes urgentes pour les responsables (manager, admin, owner), UNIQUEMENT PAR E-MAIL (le canal WhatsApp a été retiré de ce module :
// WhatsApp sert désormais au passage de relais vers un humain, voir relay.js). Les anciennes colonnes `channel` / `phone` / `template_name` restent en base sans effet.
// - Jamais d'envoi sans consentement explicite (date enregistrée, lié à l'adresse e-mail ou au numéro) ; désabonnement en un clic (lien dans chaque e-mail).
// - Envoi direct à l'adresse du compte (ou à une adresse dédiée), quota d'e-mails de l'offre respecté (journal `outbox`).
// - Message composé par le serveur à partir des données (aucun appel à l'IA).
// - Planificateur : chaque tick (voir jobs.js), verrou en base par personne / type / jour (clé unique) : pas de doublon, même avec plusieurs serveurs.
// Les routes sont montées sous /mail/digest (module « Alertes », réservé aux responsables).
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const A = require('./access');
const { sendMail, mailEnabled } = require('../services/notify');
const { HttpError, asyncHandler, oneLine, safeEqual, log } = require('../util');

const router = express.Router({ mergeParams: true });
const pub = express.Router(); // lien de désinscription des e-mails (sans connexion, signé)

const DEFAULTS = { tz_offset: 60, urgent_max_day: 5, handoff_hours: 4, invoice_late_days: 30 };
const CATCHUP_MIN = 360; // rattrapage : un résumé manqué (serveur arrêté) part encore jusqu'à 6 h après l'heure choisie
const MAX_EVENTS = 5;
const CONSENT_EMAIL = "J'accepte de recevoir, par e-mail à l'adresse indiquée, le résumé du matin et/ou les alertes urgentes de mon organisation. Je peux me désabonner à tout moment (lien dans chaque e-mail).";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Adresse de réception : l'adresse dédiée de l'abonnement si elle est valide, sinon le contact du compte s'il s'agit d'une e-mail. */
const emailOf = (sub, user) => { const e = String((sub && sub.email) || '').trim(); if (EMAIL_RE.test(e)) return e; const c = String((user && user.contact) || '').trim(); return EMAIL_RE.test(c) ? c : ''; };
const KIND_LABEL = { morning: 'Résumé du matin', urgent: 'Alerte urgente', test: 'Test' };

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
  if (late.length) lines.push(`- Impayés : ${plural(late.length, 'facture en retard', 'factures en retard')}, ${fmtMoney(late.reduce((a, d) => a + d.total - d.credited - d.paid, 0), cur)} au total.`);
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
  return { text: `${head}\n${body}\nOuvrez Brij-IA pour le détail. Pour ne plus recevoir ce message : Alertes > Résumé du matin.`.slice(0, 1500), empty: !lines.length, head, lines: lines.map((l) => l.replace(/^- /, '')), none: body };
}

/** Événements urgents du moment : rupture de stock, facture très en retard, conversation en attente trop longtemps. */
async function urgentEvents(req, st, date) {
  const o = req.org; const out = [];
  for (const i of (await require('./stock').items(req)).filter((x) => x.quantity <= 0).slice(0, 30)) out.push({ key: `stock:${i.id}`, text: `Rupture de stock : ${oneLine(i.name, 60)}` });
  for (const d of await require('./crm').overdueList(req)) {
    const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${d.due}T00:00:00Z`)) / 86400000);
    if (days > st.invoice_late_days) out.push({ key: `inv:${d.id}`, text: `Facture ${d.number} (${oneLine(d.customer, 40)}) impayée depuis ${days} jours : reste ${fmtMoney(d.total - d.credited - d.paid, o.currency)}` });
  }
  const cut = new Date(Date.now() - st.handoff_hours * 3600000).toISOString();
  for (const c of await db.prepare("SELECT id, updated_at FROM chats WHERE org_id = ? AND status = 'handoff' AND updated_at < ? ORDER BY updated_at LIMIT 30").all(o.id, cut)) {
    const h = Math.round((Date.now() - Date.parse(c.updated_at)) / 3600000);
    out.push({ key: `chat:${c.id}`, text: `Une conversation client attend un conseiller depuis ${h} h` });
  }
  return out;
}
const urgentLines = (events) => [...events.slice(0, MAX_EVENTS).map((e) => e.text), ...(events.length > MAX_EVENTS ? [`… et ${events.length - MAX_EVENTS} autre(s)`] : [])];
const composeUrgent = (org, events) => `Alerte urgente — ${org.name}\n${urgentLines(events).map((l) => `- ${l}`).join('\n')}\nOuvrez Brij-IA pour agir.`.slice(0, 1500);

// ---------- Envoi : e-mail (défaut), ou WhatsApp puis e-mail de secours ----------
// Lien de désinscription signé (un clic, sans connexion). Il pointe vers l'adresse publique de CE serveur (API_PUBLIC_URL ou SITE_URL) ; sans elle, pas de lien.
const sign = (o, u) => crypto.createHmac('sha256', config.jwtSecret).update(`digest-unsub:${o}:${u}`).digest('hex').slice(0, 24);
const unsubLink = (orgId, userId) => (config.apiPublicUrl ? `${config.apiPublicUrl}/api/ws/public/digest-unsub/${orgId}.${userId}.${sign(orgId, userId)}` : '');

/** Sujet, texte et HTML simple de l'e-mail. msg = { intro, lines, none, prefix }. */
function buildEmail(org, user, msg, subject) {
  const link = unsubLink(org.id, user.id); const app = config.siteUrl || '';
  const pre = msg.prefix || '';
  const items = msg.lines && msg.lines.length ? msg.lines : [msg.none || ''];
  const open = app ? `Ouvrez Brij-IA pour le détail : ${app}` : 'Ouvrez Brij-IA pour le détail.';
  const stop = link ? `Pour ne plus recevoir ces e-mails, cliquez ici : ${link}` : 'Pour ne plus recevoir ces e-mails : ouvrez Brij-IA > Alertes > « Résumé du matin et alertes », puis cliquez sur « Me désabonner ».';
  const text = `${pre}${msg.intro}\n\n${items.map((l) => `- ${l}`).join('\n')}\n\n${open}\n\n—\n${org.name}\n${stop}`;
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.5;max-width:600px;margin:0 auto;padding:16px">`
    + `<p>${esc(pre + msg.intro)}</p><ul style="padding-left:20px">${items.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    + `<p>${app ? `<a href="${esc(app)}">Ouvrez Brij-IA pour le détail</a>` : 'Ouvrez Brij-IA pour le détail.'}</p>`
    + `<hr style="border:none;border-top:1px solid #ddd"><p style="font-size:12px;color:#666">${esc(org.name)}<br>${link ? `<a href="${esc(link)}">Se désabonner de ces e-mails</a>` : esc(stop)}</p></body></html>`;
  return { subject: oneLine(`[${org.name}] ${subject}`, 150), text, html, headers: link ? { 'List-Unsubscribe': `<${link}>` } : undefined };
}

/** E-mail direct à l'adresse de la personne. Respecte le quota quotidien de l'offre et le journal des envois (outbox). Ne plante jamais. */
async function deliverEmail(org, user, sub, msg, subject) {
  const to = emailOf(sub, user);
  if (!mailEnabled()) return { channel: 'email', status: 'mail_off', waError: "L'envoi d'e-mails n'est pas activé sur ce serveur." };
  if (!to) return { channel: 'email', status: 'no_email', waError: "Aucune adresse e-mail pour vous écrire : indiquez-en une dans vos réglages." };
  const lim = A.limitsFor(await A.ownerPlan(org)).emailDay;
  const used = Number((await db.prepare("SELECT COUNT(*) c FROM outbox WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(org.id, `${nowISO().slice(0, 10)}T00:00:00.000Z`)).c);
  if (used >= lim) return { channel: 'email', status: 'quota', waError: `Limite de ${lim} e-mails par jour atteinte pour votre offre.` };
  const m = buildEmail(org, user, msg, subject);
  let status = 'sent'; let error = '';
  try { if (!(await sendMail({ to, subject: m.subject, text: m.text, html: m.html, headers: m.headers, fromName: org.name }))) { status = 'failed'; error = "L'envoi d'e-mails n'est pas activé sur ce serveur."; } } catch (e) { status = 'failed'; error = oneLine(e.message, 160); log.warn('Résumé : e-mail non envoyé :', error); }
  try { await db.prepare('INSERT INTO outbox (org_id, user_id, customer_id, to_email, subject, body, attachments, status, error, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)').run(org.id, user.id, to, m.subject, m.text.slice(0, 5000), '[]', status, error, nowISO()); } catch (e) { log.warn('Résumé : journal des e-mails :', oneLine(e.message, 120)); }
  return status === 'sent' ? { channel: 'email', status: 'email_sent', waError: '' } : { channel: 'email', status: 'failed', waError: `L'e-mail n'a pas pu partir : ${error}` };
}

const deliver = async (org, user, sub, msg, subject) => await deliverEmail(org, user, sub, msg, subject);

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
  if (!mailEnabled()) return; // e-mails non configurés : rien n'est consommé, le résumé partira dès que le serveur enverra des e-mails (dans la fenêtre de rattrapage)
  if (s.morning && clock.minute >= s.send_minute && clock.minute < s.send_minute + CATCHUP_MIN) {
    if (await claim(org.id, user.id, 'morning', clock.date)) {
      try {
        const m = await composeMorning(req, clock.date);
        await finish('org_id = ? AND user_id = ? AND kind = ? AND dedupe_key = ?', [org.id, user.id, 'morning', clock.date], await deliver(org, user, s, { text: m.text, intro: m.head, lines: m.lines, none: m.none }, 'Votre résumé du matin'));
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
  if (!mailEnabled()) return; // les alertes restent « neuves » tant que l'envoi d'e-mails n'est pas configuré
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
  try { r = await deliver(org, user, s, { text: composeUrgent(org, mine), intro: `Alerte urgente — ${org.name}`, lines: urgentLines(mine) }, 'Alerte urgente'); } catch (e) { log.warn('Alerte urgente en échec :', oneLine(e.message, 160)); r = { channel: '', status: 'failed', waError: 'Erreur interne.' }; }
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
      } catch (e) { log.warn('Résumé / alertes :', oneLine(e.message, 160)); }
    }
  } finally { running = false; }
  return n;
}

// ---------- Routes ----------
const logView = (r, admin) => ({ id: r.id, at: r.created_at, kind: r.kind, kindLabel: KIND_LABEL[r.kind] || r.kind, channel: r.channel, status: r.status, waError: r.wa_error, who: (admin && r.who) || undefined });
const STATUS_TEXT = {
  email_sent: 'Envoyé par e-mail',
  mail_off: "Non envoyé (l'envoi d'e-mails n'est pas activé sur le serveur)",
  no_email: 'Non envoyé (aucune adresse e-mail)',
  quota: "Non envoyé (limite d'e-mails du jour atteinte)",
  delivered: 'Ancien envoi WhatsApp (canal retiré)',
  window_closed: 'Ancien envoi WhatsApp (canal retiré)',
  emailed: 'Envoyé par e-mail',
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
    mailEnabled: mailEnabled(), hasEmail: Boolean(emailOf(null, req.user)), accountEmail: emailOf(null, req.user), consentText: CONSENT_EMAIL, statusText: STATUS_TEXT,
    me: sub ? { email: sub.email || '', address: emailOf(sub, req.user), morning: Boolean(sub.morning), urgent: Boolean(sub.urgent), hour: hhmm(sub.send_minute), consented: Boolean(sub.consent_at && !sub.unsub_at), consentAt: sub.consent_at, unsubAt: sub.unsub_at }
      : { email: '', address: emailOf(null, req.user), morning: false, urgent: false, hour: '08:00', consented: false, consentAt: null, unsubAt: null },
    settings: { tzOffset: st.tz_offset, urgentMaxPerDay: st.urgent_max_day, handoffHours: st.handoff_hours, invoiceLateDays: st.invoice_late_days, canEdit: admin },
    last: mine ? logView(mine, admin) : null,
    log: rows.map((r) => logView(r, admin)),
  });
});

router.put('/me', async (req, res) => {
  const b = req.body || {};
  const morning = Boolean(b.morning); const urgent = Boolean(b.urgent);
  const sub = await db.prepare('SELECT * FROM digest_subs WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  const email = A.text(b.email, 120).trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  const hm = /^(\d{1,2}):(\d{2})$/.exec(String(b.hour || '08:00'));
  if (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 59) throw new HttpError(400, "Heure invalide (format HH:MM, par exemple 07:30).");
  const minute = Number(hm[1]) * 60 + Number(hm[2]);
  const now = nowISO();
  let consentAt = sub ? sub.consent_at : null; let unsubAt = sub ? sub.unsub_at : null; let consentText = sub ? sub.consent_text : '';
  const address = emailOf({ email }, req.user);
  if (morning || urgent) {
    if (!address) throw new HttpError(400, "Indiquez l'adresse e-mail où recevoir le résumé et les alertes.");
    // Le consentement est lié à l'adresse e-mail : en changer demande un nouveau consentement.
    const need = !sub || !sub.consent_at || sub.unsub_at || emailOf(sub, req.user).toLowerCase() !== address.toLowerCase();
    if (need && b.consent !== true) throw new HttpError(400, 'Cochez la case de consentement pour recevoir des e-mails à cette adresse.');
    if (need) { consentAt = now; unsubAt = null; consentText = CONSENT_EMAIL; }
  } else if (sub && sub.consent_at && !sub.unsub_at) unsubAt = now; // tout décocher = se désabonner
  await db.prepare(`INSERT INTO digest_subs (org_id, user_id, phone, morning, urgent, send_minute, template_name, consent_at, consent_text, unsub_at, updated_at, channel, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, user_id) DO UPDATE SET phone = EXCLUDED.phone, morning = EXCLUDED.morning, urgent = EXCLUDED.urgent, send_minute = EXCLUDED.send_minute, template_name = EXCLUDED.template_name,
    consent_at = EXCLUDED.consent_at, consent_text = EXCLUDED.consent_text, unsub_at = EXCLUDED.unsub_at, updated_at = EXCLUDED.updated_at, channel = EXCLUDED.channel, email = EXCLUDED.email`)
    .run(req.org.id, req.user.id, sub ? sub.phone : '', morning ? 1 : 0, urgent ? 1 : 0, minute, sub ? sub.template_name : '', consentAt, consentAt ? consentText : '', unsubAt, now, 'email', email);
  await A.logActivity(req.org.id, req.user.id, 'alerts', morning || urgent ? 'Résumé et alertes : réglages enregistrés' : 'Résumé et alertes : désabonnement');
  res.json({ ok: true });
});

// Désabonnement en un clic
router.post('/me/unsubscribe', async (req, res) => {
  await db.prepare('UPDATE digest_subs SET morning = 0, urgent = 0, unsub_at = ?, updated_at = ? WHERE org_id = ? AND user_id = ?').run(nowISO(), nowISO(), req.org.id, req.user.id);
  await A.logActivity(req.org.id, req.user.id, 'alerts', 'Résumé et alertes : désabonnement');
  res.json({ ok: true });
});

router.post('/test', limits.make(60 * 1000, 10, 'Trop de tests. Patientez une minute.'), asyncHandler(async (req, res) => {
  const sub = await db.prepare('SELECT * FROM digest_subs WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
  if (!sub || !sub.consent_at || sub.unsub_at || !emailOf(sub, req.user)) throw new HttpError(400, !sub ? "Enregistrez d'abord vos réglages et votre consentement, puis réessayez." : "Enregistrez d'abord votre adresse e-mail et votre consentement, puis réessayez.");
  const clock = localClock((await settingsOf(req.org.id)).tz_offset);
  const m = await composeMorning(req, clock.date);
  const key = `t${Date.now()}${rand()}`;
  await claim(req.org.id, req.user.id, 'test', key);
  const r = await deliver(req.org, req.user, sub, { text: `[Test] ${m.text}`, intro: m.head, lines: m.lines, none: m.none, prefix: '[Test] ' }, 'Test du résumé du matin');
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

// Désabonnement par le lien des e-mails (un clic, sans connexion) : signature obligatoire.
pub.get('/digest-unsub/:token', limits.make(60 * 1000, 30, 'Trop de requêtes.'), async (req, res) => {
  const [o, u, sig] = String(req.params.token).split('.');
  const ok = /^\d+$/.test(o || '') && /^\d+$/.test(u || '') && sig && safeEqual(sig, sign(o, u));
  const row = ok ? await db.prepare('SELECT s.id, g.name AS org FROM digest_subs s JOIN orgs g ON g.id = s.org_id WHERE s.org_id = ? AND s.user_id = ?').get(Number(o), Number(u)) : null;
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  const page = (body, code) => res.status(code).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Désinscription</title><body style="font-family:sans-serif;padding:24px;max-width:520px;margin:auto">${body}</body>`);
  if (!row) return page('<p>Lien invalide ou expiré.</p>', 404);
  await db.prepare('UPDATE digest_subs SET morning = 0, urgent = 0, unsub_at = ?, updated_at = ? WHERE id = ?').run(nowISO(), nowISO(), row.id);
  await A.logActivity(Number(o), Number(u), 'alerts', 'Résumé et alertes : désabonnement par le lien de l\'e-mail');
  return page(`<h1 style="font-size:20px">C'est fait</h1><p>Vous ne recevrez plus le résumé du matin ni les alertes de ${esc(row.org)}. Vous pouvez vous réabonner à tout moment depuis Brij-IA, module Alertes.</p>`, 200);
});

module.exports = { router, pub, tick, composeMorning, composeUrgent, localClock };
