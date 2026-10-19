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

/** Envoie un e-mail. Renvoie true si envoyé, false si SMTP non configuré. Peut lancer une erreur. */
async function sendMail({ to, subject, text, replyTo, fromName, attachments }) {
  const t = getTransporter();
  if (!t) return false;
  const addr = config.smtp.from || config.smtp.user;
  const name = String(fromName || '').replace(/["<>\r\n]/g, '').slice(0, 80);
  await t.sendMail({ from: name ? `"${name}" <${String(addr).replace(/^.*<|>.*$/g, '')}>` : addr, to, subject, text, replyTo: replyTo || undefined, attachments: attachments || undefined });
  return true;
}
const mailEnabled = () => Boolean(config.smtp.host);

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
  const subject = `[MANAGER-IA] ${text}`.slice(0, 150);

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
