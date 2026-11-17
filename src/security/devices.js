'use strict';
// Connexion inhabituelle : un appareil (navigateur + système) jamais vu pour ce compte déclenche un message d'alerte au titulaire
// (e-mail si possible, et message dans l'application) et une ligne au journal d'audit. La toute première connexion ne prévient pas.
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const sessions = require('./sessions');
const audit = require('./audit');
const { log } = require('../util');

const fpOf = (userId, device) => crypto.createHash('sha256').update(`${userId}|${device}`).digest('hex').slice(0, 32);
const coarseIp = (ip) => { const v = String(ip || '').replace(/^::ffff:/, ''); return v.includes(':') ? v.split(':').slice(0, 3).join(':') + '::' : v.split('.').slice(0, 3).join('.') + '.x'; };

/** À appeler après chaque vraie connexion. Ne lève jamais d'erreur. Renvoie true si l'appareil est nouveau (et que ce n'est pas la première connexion). */
async function noteLogin(req, userId) {
  try {
    const device = sessions.deviceName(req && req.get && req.get('user-agent'));
    const fp = fpOf(userId, device);
    const now = nowISO();
    const known = await db.prepare('SELECT 1 FROM login_devices WHERE user_id = ? AND fp = ?').get(userId, fp);
    const any = known || await db.prepare('SELECT 1 FROM login_devices WHERE user_id = ?').get(userId);
    if (known) { await db.prepare('UPDATE login_devices SET last_seen = ?, ip = ? WHERE user_id = ? AND fp = ?').run(now, coarseIp(req.ip), userId, fp); return false; }
    await db.prepare('INSERT INTO login_devices (user_id, fp, ip, device, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(userId, fp, coarseIp(req.ip), device, now, now);
    if (!any) return false; // première connexion de ce compte
    await audit.record(req, 'login.new_device', { userId, severity: 'warn', detail: device });
    const u = await db.prepare('SELECT name, contact FROM users WHERE id = ?').get(userId);
    const accounts = require('../services/accounts');
    await accounts.addNotice(userId, 'connexion_inhabituelle', { title: 'Nouvel appareil connecté', text: `Une connexion à votre compte a eu lieu depuis un appareil jamais utilisé (${device}). Si ce n'est pas vous, changez votre mot de passe et fermez les appareils inconnus dans Sécurité du compte.` }).catch(() => {});
    if (u && u.contact.includes('@')) require('../services/notify').mailUser(u.contact, 'Nouvelle connexion à votre compte Brij-IA', `Bonjour ${u.name},\n\nUne connexion à votre compte vient d'avoir lieu depuis un appareil que nous ne connaissions pas : ${device}, le ${now.slice(0, 16).replace('T', ' ')} (UTC).\n\nSi c'est vous, rien à faire. Sinon, changez votre mot de passe tout de suite (« Mot de passe oublié » sur la page de connexion) et fermez les appareils inconnus dans Sécurité du compte.\n\nL'équipe Brij-IA`);
    return true;
  } catch (e) { log.warn('Appareils connus : ' + String(e.message).slice(0, 100)); return false; }
}

module.exports = { noteLogin, fpOf };
