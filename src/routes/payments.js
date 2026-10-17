'use strict';
// Offres et paiements : Campay (automatique) ou paiement manuel validé par l'administrateur.
const express = require('express');
const config = require('../config');
const { db, nowISO, getUserFresh } = require('../db');
const limits = require('../middleware/limits');
const { requireUser } = require('../middleware/auth');
const campay = require('../services/campay');
const { markPaid, planConflict } = require('../services/payments');
const { notify } = require('../services/notify');
const A = require('../workspace/access');
const { asyncHandler, HttpError, cleanText, genReference, log, oneLine } = require('../util');

const router = express.Router();
const OP_NAMES = { mtn: 'MTN Mobile Money', orange: 'Orange Money' };

router.get('/plans', (req, res) => {
  res.json({
    plans: Object.values(config.plans).map((p) => ({ id: p.id, name: p.name, priceXAF: p.priceXAF })),
    durationDays: config.durationDays,
    manual: { mtn: config.payment.mtn, orange: config.payment.orange, holder: config.payment.holder },
    automatic: config.campay.enabled,
  });
});

// Page « Abonnement » : offre actuelle, quotas, offres disponibles (avec la raison si un changement est refusé) et historique.
router.get('/billing', requireUser, (req, res) => {
  const u = getUserFresh(req.user.id);
  const exp = u.plan !== 'Gratuit' && u.plan_expires ? Date.parse(u.plan_expires) : 0;
  const active = exp > Date.now();
  const lim = (name) => { const l = A.limitsFor(name); return { orgs: l.orgs, members: l.members, branches: l.branches, aiMonth: l.aiMonth, emailDay: l.emailDay }; };
  const plans = Object.values(config.plans).map((p) => {
    const reason = planConflict(u, p.name);
    return { id: p.id, name: p.name, priceXAF: p.priceXAF, limits: lim(p.name), current: active && u.plan === p.name, available: !reason, reason: reason || '' };
  });
  const orgs = db.prepare('SELECT * FROM orgs WHERE owner_id = ? ORDER BY id').all(u.id).map((o) => ({ id: o.id, name: o.name, aiUsed: A.aiUsed(o), aiMax: A.limitsFor(u.plan).aiMonth, periodEnd: A.quotaWindow(o).end }));
  const history = db.prepare('SELECT reference, plan, operator, amount_xaf, mode, status, created_at, paid_at FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id)
    .map((p) => ({ reference: p.reference, plan: (config.plans[p.plan] || {}).name || p.plan, operator: p.operator, amountXAF: p.amount_xaf, mode: p.mode, status: p.status, createdAt: p.created_at, paidAt: p.paid_at }));
  res.json({
    plan: active ? u.plan : 'Gratuit', expiresAt: active ? u.plan_expires : null, daysLeft: active ? Math.ceil((exp - Date.now()) / 86400000) : 0,
    freeLimits: lim('Gratuit'), plans, orgs, history, durationDays: config.durationDays, automatic: config.campay.enabled,
  });
});

/** En mode "push", relit l'état chez Campay et met à jour la base. Renvoie le statut à jour. */
async function syncPush(p) {
  if (p.mode !== 'push' || !p.provider_ref || p.status === 'paid') return p.status;
  try {
    const st = await campay.getStatus(p.provider_ref);
    if (st === 'paid') {
      markPaid(p.id);
      return 'paid';
    }
    if (st === 'failed' && p.status === 'pending') {
      db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(p.id);
      return 'failed';
    }
  } catch (e) {
    log.warn('Campay : lecture du statut impossible :', oneLine(e.message, 200));
  }
  return db.prepare('SELECT status FROM payments WHERE id = ?').get(p.id).status;
}

router.post('/payments/initiate', requireUser, limits.paymentsInit, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const planId = typeof b.plan === 'string' ? b.plan : '';
  const plan = Object.prototype.hasOwnProperty.call(config.plans, planId) ? config.plans[planId] : null;
  if (!plan) throw new HttpError(400, 'Offre inconnue. Choisissez une des offres proposées.');
  const conflict = planConflict(getUserFresh(req.user.id), plan.name);
  if (conflict) throw new HttpError(409, conflict);
  const operator = b.operator;
  if (operator !== 'mtn' && operator !== 'orange') throw new HttpError(400, 'Choisissez MTN ou Orange.');

  let phone = String(b.phone == null ? '' : b.phone).replace(/\D/g, '');
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (/^6\d{8}$/.test(phone)) phone = '237' + phone;
  const push = config.campay.enabled;
  if (push && !/^237[26]\d{8}$/.test(phone)) throw new HttpError(400, 'Numéro invalide. Exemple : 6XXXXXXXX (9 chiffres).');
  if (!push && (phone.length < 8 || phone.length > 15)) throw new HttpError(400, 'Numéro de téléphone invalide.');

  const reference = genReference();
  const amount = plan.priceXAF;
  let providerRef = null;
  let instructions;

  if (push) {
    try {
      const c = await campay.collect({
        amount, from: phone, externalReference: reference,
        description: `MANAGER-IA offre ${plan.name} (${reference})`,
      });
      providerRef = c.reference;
    } catch (e) {
      log.warn('Campay : démarrage du paiement impossible :', oneLine(e.message, 250));
      throw new HttpError(502, "Le paiement mobile n'a pas pu démarrer. Réessayez dans un instant ou contactez-nous sur WhatsApp.");
    }
    instructions = `Une demande de paiement de ${amount} FCFA a été envoyée au ${phone} (${OP_NAMES[operator]}). ` +
      `Confirmez-la sur votre téléphone avec votre code secret. Votre offre ${plan.name} s'activera automatiquement dès la confirmation. Référence : ${reference}.`;
  } else {
    const number = config.payment[operator];
    const holder = config.payment.holder;
    instructions = number
      ? `Envoyez ${amount} FCFA par ${OP_NAMES[operator]} au ${number}${holder ? ' (au nom de ' + holder + ')' : ''}. ` +
        `Dans le motif du transfert, écrivez la référence ${reference}. Ensuite, saisissez ici l'ID de transaction reçu par SMS : nous validons votre paiement et activons votre offre ${plan.name}.`
      : `Le numéro de paiement n'est pas encore disponible. Contactez-nous sur WhatsApp (+237 653 62 13 88) en indiquant la référence ${reference}.`;
  }

  db.prepare(`INSERT INTO payments (reference, user_id, plan, operator, phone, amount_xaf, mode, status, provider_ref, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(reference, req.user.id, plan.id, operator, phone, amount, push ? 'push' : 'manual', providerRef, nowISO());

  res.json({ reference, mode: push ? 'push' : 'manual', status: 'pending', amountXAF: amount, instructions });
}));

router.post('/payments/confirm-manual', requireUser, (req, res) => {
  const b = req.body || {};
  const reference = cleanText(b.reference, 20).toUpperCase();
  const transactionId = cleanText(b.transactionId, 64);
  if (!/^[A-Za-z0-9._ -]{4,64}$/.test(transactionId)) throw new HttpError(400, "ID de transaction invalide (4 à 64 caractères : lettres, chiffres).");

  const p = db.prepare('SELECT * FROM payments WHERE reference = ? AND user_id = ?').get(reference, req.user.id);
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  if (p.mode !== 'manual') throw new HttpError(400, 'Ce paiement est automatique : aucune confirmation manuelle nécessaire.');
  if (p.status === 'paid') throw new HttpError(409, 'Ce paiement est déjà validé.');

  db.prepare("UPDATE payments SET transaction_id = ?, status = 'awaiting_validation' WHERE id = ? AND status != 'paid'").run(transactionId, p.id);
  const plan = config.plans[p.plan];
  notify('paiement_a_valider', `Paiement à valider : ${req.user.name} (${req.user.contact}) - ${plan ? plan.name : p.plan} - ${p.amount_xaf} FCFA - ${p.operator} - ID transaction ${transactionId} - réf. ${p.reference}`);
  res.json({ ok: true, status: 'awaiting_validation' });
});

// Webhook Campay : on ne fait JAMAIS confiance au contenu reçu, on relit le statut chez Campay.
async function campayWebhook(req, res) {
  res.json({ ok: true }); // réponse immédiate
  try {
    const src = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
    const campayRef = cleanText(String(src.reference || ''), 80);
    const ext = cleanText(String(src.external_reference || ''), 40);
    if (!campayRef && !ext) return;
    const p = db.prepare("SELECT * FROM payments WHERE mode = 'push' AND (provider_ref = ? OR reference = ?)").get(campayRef || '-', ext || '-');
    if (p) await syncPush(p);
  } catch (e) {
    log.warn('Webhook Campay : traitement échoué :', oneLine(e.message, 200));
  }
}
router.post('/payments/webhook/campay', asyncHandler(campayWebhook));
router.get('/payments/webhook/campay', asyncHandler(campayWebhook));

router.get('/payments/:reference', requireUser, asyncHandler(async (req, res) => {
  const reference = cleanText(req.params.reference, 20).toUpperCase();
  const p = db.prepare('SELECT * FROM payments WHERE reference = ? AND user_id = ?').get(reference, req.user.id);
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  const status = p.status === 'pending' ? await syncPush(p) : p.status;
  res.json({ status, plan: p.plan });
}));

module.exports = router;
