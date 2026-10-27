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
      'Votre offre Brij-IA expire bientôt',
      `Bonjour ${u.name},\n\nVotre offre ${u.plan} expire le ${fmtDate(u.plan_expires)}. Pour continuer sans interruption, pensez à la renouveler depuis votre compte.\n\nL'équipe Brij-IA`
    );
    notify('rappel', `Offre ${u.plan} de ${u.name} (${u.contact}) expire le ${fmtDate(u.plan_expires)}.`);
  }

  // 3) Nettoyage des vieilles données techniques
  await db.prepare('DELETE FROM conversations WHERE created_at < ?').run(addDays(new Date(), -90).toISOString());
  await require('./services/security').sweep();
  await require('./services/signedUrl').purge();
  await db.prepare('DELETE FROM chat_media WHERE created_at < ?').run(addDays(new Date(), -90).toISOString());
  await db.prepare('DELETE FROM notifications WHERE created_at < ?').run(addDays(new Date(), -180).toISOString());
  await db.prepare('DELETE FROM notices WHERE created_at < ?').run(addDays(new Date(), -120).toISOString());
  await db.prepare('DELETE FROM webhook_deliveries WHERE created_at < ?').run(addDays(new Date(), -30).toISOString());

  // 4) Vague 3 : tâches récurrentes à créer, rappels des décisions en attente (chacun isolé : un échec n'arrête pas les autres)
  for (const [name, fn] of [['tâches récurrentes', () => require('./workspace/projects-w3').runRecurring()], ['rappels de décisions', () => require('./workspace/decisions').remindAll()]]) {
    try { await fn(); } catch (e) { log.warn(`Tâches automatiques (${name}) :`, oneLine(e.message, 160)); }
  }
}

async function safeRun() {
  try {
    await runOnce();
    require('./workspace/wa-out').runAllAuto().catch(() => {});
  } catch (e) {
    log.error('Tâches automatiques en erreur :', oneLine(e.message, 200));
  }
}

// Résumé du matin et alertes WhatsApp : vérification chaque minute (sans bloquer ; verrou en base contre les doublons, même avec plusieurs serveurs).
function startDigest() {
  const every = (process.env.NODE_ENV !== 'production' && Number(process.env.DIGEST_TICK_MS)) || 60 * 1000;
  const run = () => {
    require('./workspace/digest').tick().catch((e) => log.warn('Résumé du matin :', oneLine(e.message, 160)));
    require('./workspace/agents-w3').tick().catch((e) => log.warn('Agents planifiés :', oneLine(e.message, 160)));
  };
  setTimeout(run, 30 * 1000).unref();
  setInterval(run, every).unref();
}

function start() {
  setTimeout(safeRun, 20 * 1000).unref();
  setInterval(safeRun, 3600 * 1000).unref();
  startDigest();
}

module.exports = { start, runOnce };
