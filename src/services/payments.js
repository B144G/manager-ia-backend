'use strict';
// Activation d'une offre après paiement : idempotente (jamais deux fois).
const config = require('../config');
const { db, nowISO } = require('../db');
const { addDays, isEmail } = require('../util');
const { notify, sendMail } = require('./notify');
const { log, oneLine } = require('../util');
const custom = require('./custom-plan');

/** Offre d'un paiement : offre habituelle (clé « pro »…) ou forfait sur mesure (« Sur mesure|somme|jours »). Renvoie { name, days } ou null. */
function planOf(key) {
  if (Object.prototype.hasOwnProperty.call(config.plans, key)) return { name: custom.illimiteName(key), days: config.plans[key].days }; // Illimité d'un mois : « Illimité » ; les autres durées : forfait sur mesure au prix d'Illimité (quota propre à la durée)
  if (Object.prototype.hasOwnProperty.call(config.legacyPlans, key)) return { name: config.legacyPlans[key].name, days: config.durationDays }; // anciennes offres : paiements déjà créés
  const c = custom.parse(key);
  return c ? { name: c.name, days: c.days } : null;
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Reçu d'un paiement d'abonnement (données de la page imprimable). Document de travail : il ne remplace pas une facture comptable. */
function receiptOf(p, user) {
  const when = p.paid_at || nowISO();
  return { number: `R-${when.slice(0, 4)}-${String(p.id).padStart(5, '0')}`, reference: p.reference, plan: custom.label((planOf(p.plan) || {}).name || p.plan), amountXAF: Number(p.amount_xaf), operator: p.operator || '', mode: p.mode, paidAt: when,
    customer: { name: user.name, contact: user.contact }, durationDays: (planOf(p.plan) || {}).days || config.durationDays, issuer: config.payment.holder || 'Brij-IA', note: "Reçu de paiement d'abonnement Brij-IA. Document de travail : il ne tient pas lieu de facture fiscale." };
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
    return `Votre offre ${custom.label(user.plan)} est active jusqu'au ${fmtDate(user.plan_expires)}. Un changement d'offre n'est possible qu'à la fin de l'abonnement : vous pourrez choisir l'offre ${custom.label(planName)} à partir de cette date (vous pouvez en attendant renouveler ${custom.label(user.plan)}).`;
  }
  return null;
}

const activate = db.transaction(async (paymentId) => {
  const p = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p || p.status === 'paid') return null; // déjà fait : on ne recommence pas
  const plan = planOf(p.plan);
  if (!plan) return null;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(p.user_id);
  if (!user) return null;

  if (planConflict(user, plan.name)) return null; // jamais de changement d'offre en cours d'abonnement
  const now = Date.now();
  const current = user.plan !== 'Gratuit' && user.plan_expires ? new Date(user.plan_expires).getTime() : 0;
  const expires = addDays(new Date(Math.max(now, current)), plan.days).toISOString();

  // Le paiement est marqué « payé » EN PREMIER et le résultat est vérifié : deux validations simultanées (double clic, deux onglets) n'ajoutent jamais la durée deux fois.
  const t = nowISO();
  const upd = await db.prepare("UPDATE payments SET status = 'paid', paid_at = ?, decided_at = ?, reject_reason = '' WHERE id = ? AND status != 'paid'").run(t, t, p.id);
  if (!upd.changes) return null;
  await db.prepare('UPDATE users SET plan = ?, plan_expires = ?, reminded_for = NULL WHERE id = ?').run(plan.name, expires, user.id);
  return { payment: p, user, planName: plan.name, planLabel: custom.label(plan.name), expires };
});

/**
 * Marque un paiement comme payé et active l'offre. Renvoie null s'il était déjà payé.
 * Prévient l'utilisateur : notice dans l'application (toujours) + e-mail avec reçu (s'il a une adresse e-mail), puis la notification admin.
 */
async function markPaid(paymentId) {
  const r = await activate(paymentId);
  if (!r) return null;
  const receipt = receiptOf({ ...r.payment, paid_at: nowISO() }, r.user);
  const accounts = require('./accounts');
  await accounts.recordEvent(r.user.id, 'paiement_valide', r.payment.reference);
  await accounts.recordEvent(r.user.id, 'offre_changee', r.planLabel);
  await accounts.addNotice(r.user.id, 'payment_paid', {
    title: 'Paiement validé',
    text: `Votre paiement ${r.payment.reference} (${r.payment.amount_xaf} FCFA) est validé : votre offre ${r.planLabel} est active jusqu'au ${fmtDate(r.expires)}.`,
    data: { reference: r.payment.reference, plan: r.planLabel, planKey: r.planName, until: r.expires, amount: Number(r.payment.amount_xaf) },
  });
  if (isEmail(r.user.contact)) setImmediate(async () => {
    try {
      await sendMail({ to: r.user.contact, subject: `Votre offre ${r.planLabel} est active - Brij-IA`, text: `Bonjour ${r.user.name},\n\nVotre paiement ${r.payment.reference} (${r.payment.amount_xaf} FCFA) est confirmé.\n` +
      `Votre offre ${r.planLabel} est active jusqu'au ${fmtDate(r.expires)}.\n\nMerci pour votre confiance.\nL'équipe Brij-IA\n\nVotre reçu ${receipt.number} est joint à ce message (vous pouvez aussi le retrouver dans « Abonnement »).`,
        attachments: [{ filename: `recu-${receipt.number}.html`, content: Buffer.from(receiptHtml(receipt), 'utf8'), contentType: 'text/html' }] });
    } catch (e) { log.warn('Reçu non envoyé :', oneLine(e.message, 160)); }
  });
  notify('paiement_confirme', `Paiement confirmé : ${r.user.name} (${r.user.contact}) - offre ${r.planLabel} - ${r.payment.amount_xaf} FCFA - ${r.payment.reference}`);
  return r;
}

/**
 * Refuse un paiement (motif obligatoire, écrit par l'administrateur). Renvoie null si le paiement n'est plus refusable (déjà payé ou déjà refusé).
 * L'utilisateur est prévenu avec le motif : notice dans l'application (toujours) + e-mail (s'il a une adresse e-mail).
 */
async function rejectPayment(paymentId, reason) {
  const why = String(reason == null ? '' : reason).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
  const p = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return null;
  const upd = await db.prepare("UPDATE payments SET status = 'failed', reject_reason = ?, decided_at = ? WHERE id = ? AND status IN ('pending', 'awaiting_validation')").run(why, nowISO(), p.id);
  if (!upd.changes) return null;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(p.user_id);
  if (!user) return { payment: p, user: null };
  const plan = planOf(p.plan);
  const planLabel = plan ? custom.label(plan.name) : p.plan;
  const accounts = require('./accounts');
  await accounts.recordEvent(user.id, 'paiement_refuse', p.reference);
  await accounts.addNotice(user.id, 'payment_rejected', {
    title: 'Paiement refusé',
    text: `Votre paiement ${p.reference} (${p.amount_xaf} FCFA) n'a pas pu être validé. Motif : ${why}.`,
    data: { reference: p.reference, reason: why, plan: planLabel, amount: Number(p.amount_xaf) },
  });
  if (isEmail(user.contact)) setImmediate(async () => {
    try {
      await sendMail({ to: user.contact, subject: `Votre paiement ${p.reference} n'a pas pu être validé - Brij-IA`, text: `Bonjour ${user.name},\n\nNous n'avons pas pu valider votre paiement ${p.reference} (${p.amount_xaf} FCFA, offre ${planLabel}).\nMotif : ${why}\n\n` +
        `Aucune offre n'a été activée. Vous pouvez refaire un paiement depuis « Abonnement », ou nous écrire sur WhatsApp (+237 653 62 13 88) en indiquant la référence ${p.reference}.\n\nL'équipe Brij-IA` });
    } catch (e) { log.warn('E-mail de refus non envoyé :', oneLine(e.message, 160)); }
  });
  return { payment: p, user, planLabel };
}

module.exports = { markPaid, rejectPayment, fmtDate, isEmail, planConflict, receiptOf, receiptHtml, planOf };
