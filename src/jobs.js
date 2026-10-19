'use strict';
// Tâches automatiques (toutes les heures) : expiration des offres, rappels, nettoyage.
const { db, nowISO } = require('./db');
const { notify, mailUser } = require('./services/notify');
const { fmtDate } = require('./services/payments');
const { log, addDays, oneLine } = require('./util');

async function runOnce() {
  const now = nowISO();

  // 1) Offres expirées -> retour à "Gratuit"
  const expired = await db.prepare("UPDATE users SET plan = 'Gratuit', plan_expires = NULL WHERE plan != 'Gratuit' AND plan_expires IS NOT NULL AND plan_expires <= ?").run(now);
  if (expired.changes) log.info(`Tâches : ${expired.changes} offre(s) expirée(s) repassée(s) à Gratuit.`);

  // 2) Rappel 3 jours avant l'expiration (une seule fois par période)
  const soon = addDays(new Date(), 3).toISOString();
  const rows = await db.prepare(
    "SELECT * FROM users WHERE plan != 'Gratuit' AND plan_expires > ? AND plan_expires <= ? AND (reminded_for IS NULL OR reminded_for != plan_expires)"
  ).all(now, soon);
  for (const u of rows) {
    await db.prepare('UPDATE users SET reminded_for = ? WHERE id = ?').run(u.plan_expires, u.id);
    mailUser(
      u.contact,
      'Votre offre MANAGER-IA expire bientôt',
      `Bonjour ${u.name},\n\nVotre offre ${u.plan} expire le ${fmtDate(u.plan_expires)}. Pour continuer sans interruption, pensez à la renouveler depuis votre compte.\n\nL'équipe MANAGER-IA`
    );
    notify('rappel', `Offre ${u.plan} de ${u.name} (${u.contact}) expire le ${fmtDate(u.plan_expires)}.`);
  }

  // 3) Nettoyage des vieilles données techniques
  await db.prepare('DELETE FROM conversations WHERE created_at < ?').run(addDays(new Date(), -90).toISOString());
  await require('./services/security').sweep();
  await require('./services/signedUrl').purge();
  await db.prepare('DELETE FROM chat_media WHERE created_at < ?').run(addDays(new Date(), -90).toISOString());
  await db.prepare('DELETE FROM notifications WHERE created_at < ?').run(addDays(new Date(), -180).toISOString());
}

async function safeRun() {
  try {
    await runOnce();
    require('./workspace/wa-out').runAllAuto().catch(() => {});
  } catch (e) {
    log.error('Tâches automatiques en erreur :', oneLine(e.message, 200));
  }
}

function start() {
  setTimeout(safeRun, 20 * 1000).unref();
  setInterval(safeRun, 3600 * 1000).unref();
}

module.exports = { start, runOnce };
