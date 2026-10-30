'use strict';
// Notifications à l'administrateur : e-mail + WhatsApp (modèle). Ne bloque JAMAIS la requête principale.
const nodemailer = require('nodemailer');
const config = require('../config');
const { db, nowISO } = require('../db');
const { log, isEmail, oneLine } = require('../util');
const wa = require('./whatsappApi');

let transporter = null;
function getTransporter() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

const apiMailOn = () => config.mailApi.provider === 'brevo' && Boolean(config.mailApi.key);
const addrOf = (v) => String(v || '').replace(/^.*<|>.*$/g, '').trim();

/** Envoi par l'API web de Brevo (HTTPS) : fonctionne là où le SMTP est bloqué. */
async function sendViaApi({ to, subject, text, html, headers, replyTo, fromName, attachments }) {
  const sender = addrOf(config.smtp.from || config.smtp.user);
  if (!isEmail(sender)) throw new Error("Adresse d'expéditeur absente : renseignez SMTP_FROM (adresse validée chez Brevo).");
  const name = String(fromName || (/^\s*"?([^"<]+?)"?\s*</.exec(config.smtp.from || '') || [])[1] || 'Brij-IA').replace(/["<>\r\n]/g, '').slice(0, 80);
  const body = { sender: { name, email: sender }, to: [{ email: addrOf(to) }], subject: String(subject || '').slice(0, 300), textContent: String(text || '') };
  if (html) body.htmlContent = String(html);
  if (headers && Object.keys(headers).length) body.headers = headers;
  if (replyTo && isEmail(addrOf(replyTo))) body.replyTo = { email: addrOf(replyTo) };
  if (attachments && attachments.length) body.attachment = attachments.filter((a) => a && a.content != null).map((a) => ({ name: String(a.filename || 'piece-jointe').slice(0, 120), content: Buffer.from(a.content).toString('base64') }));
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`${config.mailApi.baseUrl}/smtp/email`, { method: 'POST', headers: { 'api-key': config.mailApi.key, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Service e-mail : refus (${res.status}) ${oneLine(t, 160)}`); }
  } finally { clearTimeout(timer); }
}

/** Envoie un e-mail (texte, et HTML en option ; en-têtes facultatifs, ex. List-Unsubscribe). Renvoie true si envoyé, false si aucun envoi n'est configuré. Peut lancer une erreur. */
async function sendMail({ to, subject, text, html, headers, replyTo, fromName, attachments }) {
  if (apiMailOn()) { await sendViaApi({ to, subject, text, html, headers, replyTo, fromName, attachments }); return true; }
  const t = getTransporter();
  if (!t) return false;
  const addr = config.smtp.from || config.smtp.user;
  const name = String(fromName || '').replace(/["<>\r\n]/g, '').slice(0, 80);
  await t.sendMail({ from: name ? `"${name}" <${String(addr).replace(/^.*<|>.*$/g, '')}>` : addr, to, subject, text, html: html || undefined, headers: headers || undefined, replyTo: replyTo || undefined, attachments: attachments || undefined });
  return true;
}
const mailEnabled = () => apiMailOn() || Boolean(config.smtp.host);

/** E-mail à un utilisateur (seulement si son contact est un e-mail). N'attend pas, ne plante pas. */
function mailUser(contact, subject, text) {
  if (!isEmail(contact)) return;
  setImmediate(async () => {
    try {
      const ok = await sendMail({ to: contact, subject, text });
      if (!ok) log.info('[e-mail non configuré] message pour un utilisateur non envoyé :', subject);
    } catch (e) {
      log.warn('Échec e-mail utilisateur :', oneLine(e.message, 200));
    }
  });
}

async function run(type, text) {
  const channels = [];
  const subject = `[Brij-IA] ${text}`.slice(0, 150);

  try {
    if (await sendMail({ to: config.admin.email, subject, text })) channels.push('email');
  } catch (e) {
    log.warn('Notification e-mail échouée :', oneLine(e.message, 200));
  }

  try {
    if (wa.isConfigured() && config.admin.whatsapp) {
      await wa.sendTemplate(config.admin.whatsapp, text);
      channels.push('whatsapp');
    }
  } catch (e) {
    log.warn('Notification WhatsApp échouée :', oneLine(e.message, 250));
  }

  if (channels.length === 0) log.info(`[notification ${type}] ${text}  (aucun canal configuré : affichée ici seulement)`);

  await db.prepare('INSERT INTO notifications (type, text, channels, created_at) VALUES (?, ?, ?, ?)').run(
    type, oneLine(text, 1000), channels.join(','), nowISO()
  );
}

/** Lance la notification en arrière-plan. À appeler SANS await. */
function notify(type, text) {
  setImmediate(async () => {
    run(type, text).catch((e) => log.warn('Notification impossible :', oneLine(e.message, 200)));
  });
}

module.exports = { notify, sendMail, mailUser, mailEnabled };
