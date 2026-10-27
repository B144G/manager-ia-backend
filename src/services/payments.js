'use strict';
// Activation d'une offre après paiement : idempotente (jamais deux fois).
const config = require('../config');
const { db, nowISO } = require('../db');
const { addDays, isEmail } = require('../util');
const { notify, sendMail } = require('./notify');
const { log, oneLine } = require('../util');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Reçu d'un paiement d'abonnement (données de la page imprimable). Document de travail : il ne remplace pas une facture comptable. */
function receiptOf(p, user) {
  const when = p.paid_at || nowISO();
  return { number: `R-${when.slice(0, 4)}-${String(p.id).padStart(5, '0')}`, reference: p.reference, plan: (config.plans[p.plan] || {}).name || p.plan, amountXAF: Number(p.amount_xaf), operator: p.operator || '', mode: p.mode, paidAt: when,
    customer: { name: user.name, contact: user.contact }, durationDays: config.durationDays, issuer: config.payment.holder || 'MANAGER-IA', note: "Reçu de paiement d'abonnement MANAGER-IA. Document de travail : il ne tient pas lieu de facture fiscale." };
}
function receiptHtml(r) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Reçu ${esc(r.number)}</title><style>body{font-family:Arial,sans-serif;max-width:640px;margin:32px auto;color:#111}h1{font-size:22px}table{width:100%;border-collapse:collapse}td{padding:8px 0;border-bottom:1px solid #ddd}td:last-child{text-align:right}.n{color:#555;font-size:12px;margin-top:24px}</style></head><body>
<h1>Reçu de paiement ${esc(r.number)}</h1><p>${esc(r.issuer)}</p><table><tr><td>Client</td><td>${esc(r.customer.name)} (${esc(r.customer.contact)})</td></tr><tr><td>Offre</td><td>${esc(r.plan)} (${r.durationDays} jours)</td></tr><tr><td>Référence</td><td>${esc(r.reference)}</td></tr><tr><td>Date de paiement</td><td>${esc(r.paidAt.slice(0, 10))}</td></tr><tr><td>Montant</td><td><b>${r.amountXAF.toLocaleString('fr-FR')} FCFA</b></td></tr></table><p class="n">${esc(r.note)}</p></body></html>`;
}
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
  const receipt = receiptOf({ ...r.payment, paid_at: nowISO() }, r.user);
  if (isEmail(r.user.contact)) setImmediate(async () => {
    try {
      await sendMail({ to: r.user.contact, subject: `Votre offre ${r.planName} est active - MANAGER-IA`, text: `Bonjour ${r.user.name},\n\nVotre paiement ${r.payment.reference} (${r.payment.amount_xaf} FCFA) est confirmé.\n` +
      `Votre offre ${r.planName} est active jusqu'au ${fmtDate(r.expires)}.\n\nMerci pour votre confiance.\nL'équipe MANAGER-IA\n\nVotre reçu ${receipt.number} est joint à ce message (vous pouvez aussi le retrouver dans « Abonnement »).`,
        attachments: [{ filename: `recu-${receipt.number}.html`, content: Buffer.from(receiptHtml(receipt), 'utf8'), contentType: 'text/html' }] });
    } catch (e) { log.warn('Reçu non envoyé :', oneLine(e.message, 160)); }
  });
  notify('paiement_confirme', `Paiement confirmé : ${r.user.name} (${r.user.contact}) - offre ${r.planName} - ${r.payment.amount_xaf} FCFA - ${r.payment.reference}`);
  return r;
}

module.exports = { markPaid, fmtDate, isEmail, planConflict, receiptOf, receiptHtml };
