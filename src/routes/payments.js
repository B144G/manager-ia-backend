'use strict';
// Offres et paiements : Campay (automatique) ou paiement manuel validé par l'administrateur.
const crypto = require('crypto');
const express = require('express');
const audit = require('../security/audit');
const config = require('../config');
const { db, nowISO, getUserFresh } = require('../db');
const limits = require('../middleware/limits');
const { requireUser } = require('../middleware/auth');
const campayClient = require('../services/campay-client');
const cpay = require('../services/campay-pay');
const { planConflict, planOf } = require('../services/payments');
const custom = require('../services/custom-plan');
const { notify } = require('../services/notify');
const A = require('../workspace/access');
const accounts = require('../services/accounts');
const { amap, asyncHandler, HttpError, cleanText, genReference } = require('../util');

const router = express.Router();
const OP_NAMES = { mtn: 'MTN Mobile Money', orange: 'Orange Money' };

router.get('/plans', (req, res) => {
  res.json({
    plans: Object.values(config.plans).map((p) => ({ id: p.id, name: p.name, period: p.period, days: p.days, priceXAF: p.priceXAF })),
    durationDays: config.durationDays,
    custom: custom.info(),
    manual: config.manualPay.available() ? { mtn: config.payment.mtn, orange: config.payment.orange, holder: config.payment.holder } : null,
    manualAvailable: config.manualPay.available(),
    automatic: config.campay.enabled, testMode: config.campay.enabled && config.campay.test,
  });
});

// Aperçu d'un forfait sur mesure : ce que donne une somme pour une durée (semaine, mois ou an). Public : aucune donnée personnelle.
router.get('/plans/custom/quote', (req, res) => {
  try { res.json({ quote: custom.quote(Number(req.query.amount), String(req.query.period || '')) }); }
  catch (e) { throw new HttpError(e.status || 400, e.message); }
});

// Page « Abonnement » : offre actuelle, quotas, offres disponibles (avec la raison si un changement est refusé) et historique.
router.get('/billing', requireUser, async (req, res) => {
  const u = await getUserFresh(req.user.id);
  const exp = u.plan !== 'Gratuit' && u.plan_expires ? Date.parse(u.plan_expires) : 0;
  const active = exp > Date.now();
  const lim = (name) => { const l = A.limitsFor(name); return { orgs: l.orgs, members: l.members, branches: l.branches, aiMonth: l.aiMonth, emailDay: l.emailDay }; };
  const plans = Object.values(config.plans).map((p) => {
    const stored = planOf(p.id).name; // nom enregistré pour cette offre (Illimité d'un mois : « Illimité » ; autres durées : forfait au prix d'Illimité)
    const reason = planConflict(u, stored);
    return { id: p.id, name: p.name, period: p.period, days: p.days, priceXAF: p.priceXAF, limits: lim(stored), current: active && u.plan === stored, available: !reason, reason: reason || '' };
  });
  const orgs = await amap(await db.prepare('SELECT * FROM orgs WHERE owner_id = ? ORDER BY id').all(u.id), async (o) => ({ id: o.id, name: o.name, aiUsed: await A.aiUsed(o), aiMax: A.limitsFor(u.plan).aiMonth, periodEnd: (await A.quotaWindow(o)).end }));
  const history = (await db.prepare('SELECT reference, plan, operator, amount_xaf, mode, status, created_at, paid_at, reject_reason FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id))
    .map((p) => ({ reference: p.reference, plan: custom.label((planOf(p.plan) || {}).name || p.plan), planKey: custom.isCustom(p.plan) ? p.plan : '', operator: p.operator, amountXAF: p.amount_xaf, mode: p.mode, status: p.status, createdAt: p.created_at, paidAt: p.paid_at, rejectReason: p.status === 'failed' ? p.reject_reason || '' : '' }));
  res.json({
    plan: active ? u.plan : 'Gratuit', planLabel: active ? custom.label(u.plan) : 'Gratuit', currentLimits: lim(active ? u.plan : 'Gratuit'), custom: custom.info(), expiresAt: active ? u.plan_expires : null, daysLeft: active ? Math.ceil((exp - Date.now()) / 86400000) : 0,
    freeLimits: lim('Gratuit'), plans, orgs, history, durationDays: config.durationDays, automatic: config.campay.enabled, manualAvailable: config.manualPay.available(), manual: config.manualPay.available() ? { mtn: config.payment.mtn, orange: config.payment.orange, holder: config.payment.holder } : null, testMode: config.campay.enabled && config.campay.test, pendingTtlMin: config.campay.pendingTtlMin,
  });
});

// Reçu d'un paiement confirmé (page imprimable du site : le navigateur en fait un PDF).
router.get('/payments/:reference/receipt', requireUser, async (req, res) => {
  const p = await db.prepare("SELECT * FROM payments WHERE reference = ? AND user_id = ? AND status = 'paid'").get(String(req.params.reference).slice(0, 60), req.user.id);
  if (!p) return res.status(404).json({ error: 'Reçu introuvable : seul un paiement confirmé en a un.' });
  res.json({ receipt: require('../services/payments').receiptOf(p, await getUserFresh(req.user.id)) });
});

router.post('/payments/initiate', requireUser, limits.paymentsInit, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const planId = typeof b.plan === 'string' ? b.plan : '';
  let plan = Object.prototype.hasOwnProperty.call(config.plans, planId) ? config.plans[planId] : null;
  if (!plan && b.custom && typeof b.custom === 'object') { // forfait sur mesure : la somme et la durée sont vérifiées par le serveur
    let q; try { q = custom.quote(Number(b.custom.amount), String(b.custom.period || '')); } catch (e) { throw new HttpError(e.status || 400, e.message); }
    plan = { id: q.plan, name: q.plan, priceXAF: q.amount };
  }
  if (!plan) throw new HttpError(400, 'Offre inconnue. Choisissez une des offres proposées.');
  const conflict = planConflict(await getUserFresh(req.user.id), plan.name);
  if (conflict) throw new HttpError(409, conflict);
  const operator = b.operator;
  if (operator !== 'mtn' && operator !== 'orange') throw new HttpError(400, 'Choisissez MTN ou Orange.');

  const manualOk = config.manualPay.available();
  const method = b.method === 'manual' ? 'manual' : b.method === 'campay' ? 'campay' : (config.campay.enabled ? 'campay' : 'manual');
  if (method === 'manual' && !manualOk) throw new HttpError(400, "Le paiement par Mobile Money direct n'est pas disponible pour le moment.");
  if (method === 'campay' && !config.campay.enabled) throw new HttpError(400, "Le paiement automatique n'est pas disponible pour le moment.");
  const push = method === 'campay';
  let phone = '';
  if (push) {
    phone = campayClient.normalizePhone(b.phone);
    if (!phone) throw new HttpError(400, 'Numéro invalide. Exemple : 6XXXXXXXX (9 chiffres, MTN ou Orange).');
  } else if (b.phone) { // facultatif en mode manuel : on ne garde qu'une version masquée
    const d = String(b.phone).replace(/\D/g, '');
    if (d.length < 8 || d.length > 15) throw new HttpError(400, 'Numéro de téléphone invalide.');
    phone = cpay.maskPhone(d);
  }

  if (push) { // paiement automatique : le montant est celui du catalogue (jamais fourni par le client), la demande part chez Campay
    const user = await getUserFresh(req.user.id);
    const { payment, reused, ussdCode } = await cpay.createPush({ req, user, plan, operator, phone });
    return res.json({
      reference: payment.reference, mode: 'push', status: payment.status, amountXAF: Number(payment.amount_xaf), reused: Boolean(reused), expiresAt: payment.expires_at, testMode: config.campay.test, ussdCode: ussdCode || '',
      instructions: `Une demande de paiement de ${payment.amount_xaf} FCFA a été envoyée au ${cpay.maskPhone(phone)} (${OP_NAMES[payment.operator] || OP_NAMES[operator]}). ` +
        `Confirmez-la sur votre téléphone avec votre code secret. Votre offre ${custom.label(plan.name)} s'activera automatiquement dès la confirmation. Référence : ${payment.reference}.`,
    });
  }

  // Mobile Money direct (secours) : le serveur calcule le montant et crée une commande « en attente » avec un code lisible, unique, tiré au hasard.
  const amount = plan.priceXAF;
  const pendingManual = await db.prepare("SELECT * FROM payments WHERE user_id = ? AND mode = 'manual' AND status = 'pending' AND plan = ? AND amount_xaf = ? ORDER BY id DESC LIMIT 1").get(req.user.id, plan.id, amount);
  let reference; let reused = false;
  if (pendingManual && (!pendingManual.expires_at || Date.parse(pendingManual.expires_at) > Date.now())) { reference = pendingManual.reference; reused = true; } // double clic : même commande
  else {
    for (let i = 0; i < 8 && !reference; i++) {
      const code = 'BRIJ-' + String(crypto.randomInt(100000, 1000000));
      try {
        await db.prepare(`INSERT INTO payments (reference, user_id, plan, operator, phone, amount_xaf, mode, status, provider_ref, created_at, expires_at, currency)
          VALUES (?, ?, ?, ?, ?, ?, 'manual', 'pending', NULL, ?, ?, 'XAF')`)
          .run(code, req.user.id, plan.id, operator, phone, amount, nowISO(), new Date(Date.now() + config.manualPay.ttlHours * 3600000).toISOString());
        reference = code;
      } catch (e) { if (e.code !== '23505') throw e; }
    }
    if (!reference) throw new HttpError(503, 'Le paiement n’a pas pu être préparé. Réessayez.');
    await accounts.recordEvent(req.user.id, 'paiement_initie', reference);
    await audit.record(req, 'payment.manual_created', { userId: req.user.id, target: reference, detail: `${amount} FCFA ${plan.id} ${operator}` });
  }
  const number = config.payment[operator] || config.payment.mtn || config.payment.orange;
  const holder = config.payment.holder;
  const instructions = `Envoyez ${amount} FCFA par ${OP_NAMES[operator]} au ${number}${holder ? ' (au nom de ' + holder + ')' : ''}. ` +
    `Dans le motif du transfert, écrivez la référence ${reference}. Ensuite, saisissez ici l'ID de transaction reçu par SMS : nous validons votre paiement et activons votre offre ${custom.label(plan.name)}.`;
  res.json({ reference, mode: 'manual', status: 'pending', amountXAF: amount, instructions, reused, payTo: { operator, number, holder: holder || '', mtn: config.payment.mtn, orange: config.payment.orange }, expiresAt: config.manualPay.ttlHours });
}));

router.post('/payments/confirm-manual', requireUser, limits.paymentsConfirm, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const reference = cleanText(b.reference, 20).toUpperCase();
  const transactionId = cleanText(b.transactionId, 64);
  const payerName = cleanText(b.payerName, 80);
  if (!/^[A-Za-z0-9._ -]{4,64}$/.test(transactionId)) throw new HttpError(400, "ID de transaction invalide (4 à 64 caractères : lettres, chiffres).");
  if (payerName.length < 2) throw new HttpError(400, 'Indiquez le nom de la personne qui a payé (comme sur le SMS).');
  const norm = transactionId.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const p = await db.prepare('SELECT * FROM payments WHERE reference = ? AND user_id = ?').get(reference, req.user.id);
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  if (p.mode !== 'manual') throw new HttpError(400, 'Ce paiement est automatique : aucune confirmation manuelle nécessaire.');
  if (p.status === 'paid') throw new HttpError(409, 'Ce paiement est déjà validé.');
  if (p.status === 'failed') throw new HttpError(409, "Ce paiement a été refusé. Faites un nouveau paiement depuis « Abonnement » (ou contactez-nous sur WhatsApp).");
  if (p.status === 'expired' || (p.status === 'pending' && p.expires_at && Date.parse(p.expires_at) <= Date.now())) throw new HttpError(409, 'Cette commande a expiré. Faites un nouveau paiement depuis « Abonnement ».');
  if (!config.manualPay.available()) throw new HttpError(400, "Le paiement par Mobile Money direct n'est pas disponible pour le moment.");
  // Double clic / renvoi du même ID : on ne prévient pas l'administrateur deux fois.
  if (p.status === 'awaiting_validation' && p.tx_norm === norm && p.payer_name === payerName) return res.json({ ok: true, status: 'awaiting_validation', already: true });
  if (Number(p.attempts) >= config.manualPay.maxAttempts) throw new HttpError(429, 'Trop de tentatives pour cette commande. Contactez-nous sur WhatsApp en indiquant la référence ' + p.reference + '.');
  // Anti-rejeu : un même identifiant de transaction ne sert qu'une fois, pour une seule commande.
  const used = await db.prepare('SELECT id FROM payments WHERE tx_norm = ? AND id != ?').get(norm, p.id);
  if (used) { await audit.record(req, 'payment.manual_replay', { userId: req.user.id, target: p.reference, severity: 'warn', detail: 'identifiant de transaction déjà utilisé' }); throw new HttpError(409, 'Cet identifiant de transaction a déjà été utilisé pour un autre paiement.'); }

  let upd;
  try { upd = await db.prepare("UPDATE payments SET transaction_id = ?, tx_norm = ?, payer_name = ?, attempts = attempts + 1, submitted_at = ?, status = 'awaiting_validation' WHERE id = ? AND status IN ('pending', 'awaiting_validation')").run(transactionId, norm, payerName, nowISO(), p.id); }
  catch (e) { if (e.code === '23505') throw new HttpError(409, 'Cet identifiant de transaction a déjà été utilisé pour un autre paiement.'); throw e; }
  if (!upd.changes) throw new HttpError(409, 'Ce paiement ne peut plus être modifié.');
  const plan = planOf(p.plan);
  const corrected = p.status === 'awaiting_validation';
  await accounts.recordEvent(req.user.id, 'paiement_soumis', p.reference);
  await audit.record(req, 'payment.manual_submitted', { userId: req.user.id, target: p.reference, detail: `${p.amount_xaf} FCFA${corrected ? ' (identifiant corrigé)' : ''}` });
  notify('paiement_a_valider', `Paiement à valider${corrected ? ' (ID corrigé)' : ''} (vérifier le SMS de réception) : ${req.user.name} (${req.user.contact}) - ${plan ? custom.label(plan.name) : p.plan} (${plan ? plan.days : '?'} jours) - ${p.amount_xaf} FCFA - ${p.operator} - payeur ${payerName} - ID transaction ${transactionId} - code ${p.reference}. Vérifiez le SMS de réception, puis Administration > Paiements pour confirmer ou refuser.`);
  res.json({ ok: true, status: 'awaiting_validation' });
}));

// Webhook Campay (public, GET ou POST selon le réglage de l'application Campay). Signature JWT HS256 vérifiée, rejeu bloqué, statut RELU chez Campay : voir services/campay-pay.js.
async function campayWebhook(req, res) {
  const r = await cpay.handleWebhook(req);
  res.status(r.code).json(r.body);
}
router.post('/payments/webhook/campay', limits.campayWebhook, asyncHandler(campayWebhook));
router.get('/payments/webhook/campay', limits.campayWebhook, asyncHandler(campayWebhook));

// Suivi d'un paiement (la page d'attente interroge cette route toutes les quelques secondes) : relit Campay au plus toutes les 4 secondes.
router.get('/payments/:reference', requireUser, asyncHandler(async (req, res) => {
  const reference = cleanText(req.params.reference, 20).toUpperCase();
  let p = await db.prepare('SELECT * FROM payments WHERE reference = ? AND user_id = ?').get(reference, req.user.id);
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  if (p.mode === 'push' && p.status === 'pending' && (!p.last_checked_at || Date.now() - Date.parse(p.last_checked_at) > 4000)) {
    await cpay.recheck(p, { via: 'suivi' });
    p = await db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
  }
  res.json({ status: p.status === 'needs_review' ? 'pending' : p.status, plan: p.plan, amountXAF: Number(p.amount_xaf), expiresAt: p.expires_at || null, testMode: Boolean(Number(p.test_mode)), mode: p.mode, review: p.status === 'needs_review' });
}));

module.exports = router;
