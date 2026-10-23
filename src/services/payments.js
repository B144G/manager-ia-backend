'use strict';
// Activation d'une offre après paiement : idempotente (jamais deux fois).
const config = require('../config');
const { db, nowISO } = require('../db');
const { addDays, isEmail } = require('../util');
const { notify, mailUser } = require('./notify');

const fmtDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });

/**
 * Règle : une offre payante ne se change qu'à la fin de l'abonnement (le renouvellement de la MÊME offre reste possible à tout moment).
 * Renvoie un message d'explication si le choix est refusé, sinon null.
 */
function planConflict(user, planName) {
  const exp = user.plan_expires ? new Date(user.plan_expires).getTime() : 0;
  if (user.plan && user.plan !== 'Gratuit' && exp > Date.now() && user.plan !== planName) {
    return `Votre offre ${user.plan} est active jusqu'au ${fmtDate(user.plan_expires)}. Un changement d'offre n'est possible qu'à la fin de l'abonnement : vous pourrez choisir l'offre ${planName} à partir de cette date (vous pouvez en attendant renouveler ${user.plan}).`;
  }
  return null;
}

const activate = db.transaction(async (paymentId) => {
  const p = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p || p.status === 'paid') return null; // déjà fait : on ne recommence pas
  const plan = config.plans[p.plan];
  if (!plan) return null;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(p.user_id);
  if (!user) return null;

  if (planConflict(user, plan.name)) return null; // jamais de changement d'offre en cours d'abonnement
  const now = Date.now();
  const current = user.plan !== 'Gratuit' && user.plan_expires ? new Date(user.plan_expires).getTime() : 0;
  const expires = addDays(new Date(Math.max(now, current)), config.durationDays).toISOString();

  await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ? AND status != 'paid'").run(nowISO(), p.id);
  await db.prepare('UPDATE users SET plan = ?, plan_expires = ?, reminded_for = NULL WHERE id = ?').run(plan.name, expires, user.id);
  return { payment: p, user, planName: plan.name, expires };
});

/**
 * Marque un paiement comme payé et active l'offre. Renvoie null s'il était déjà payé.
 * Envoie l'e-mail de confirmation et la notification admin en arrière-plan.
 */
async function markPaid(paymentId) {
  const r = await activate(paymentId);
  if (!r) return null;
  mailUser(
    r.user.contact,
    `Votre offre ${r.planName} est active - MANAGER-IA`,
    `Bonjour ${r.user.name},\n\nVotre paiement ${r.payment.reference} (${r.payment.amount_xaf} FCFA) est confirmé.\n` +
      `Votre offre ${r.planName} est active jusqu'au ${fmtDate(r.expires)}.\n\nMerci pour votre confiance.\nL'équipe MANAGER-IA`
  );
  notify('paiement_confirme', `Paiement confirmé : ${r.user.name} (${r.user.contact}) - offre ${r.planName} - ${r.payment.amount_xaf} FCFA - ${r.payment.reference}`);
  return r;
}

module.exports = { markPaid, fmtDate, isEmail, planConflict };
