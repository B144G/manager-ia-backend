'use strict';
// Paiement automatique par Campay (MTN / Orange) : création de la demande, confirmation (webhook, suivi, réconciliation), activation manuelle par l'administrateur.
// RÈGLES : (1) le prix vient UNIQUEMENT du catalogue (config.plans / forfait sur mesure vérifié) ; (2) un webhook n'active JAMAIS rien à lui seul : l'état est
// toujours relu chez Campay, puis la référence, la référence externe, le montant et la devise sont comparés à la commande attendue ; (3) l'activation est idempotente
// (payments.markPaid) ; (4) aucun numéro complet dans les journaux (masqué), aucune clé dans les messages d'erreur.
const crypto = require('crypto');
const config = require('../config');
const { db, nowISO } = require('../db');
const client = require('./campay-client');
const { markPaid } = require('./payments');
const accounts = require('./accounts');
const custom = require('./custom-plan');
const { notify } = require('./notify');
const audit = require('../security/audit');
const { HttpError, genReference, log, oneLine } = require('../util');

const OP_NAMES = { mtn: 'MTN Mobile Money', orange: 'Orange Money' };
const cfg = () => config.campay;
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

/** « 237677777777 » -> « 237 6** *** 777 » : jamais le numéro complet dans les journaux, les listes ou la base. */
function maskPhone(p) {
  const d = String(p == null ? '' : p).replace(/\D/g, '');
  return d.length < 7 ? '***' : `${d.slice(0, 3)} ${d.slice(3, 4)}** *** ${d.slice(-3)}`;
}
/** Retire toute suite de 9 chiffres ou plus d'un texte destiné aux journaux. */
const scrub = (t) => String(t == null ? '' : t).replace(/\+?\d[\d ]{7,}\d/g, (m) => maskPhone(m));

const aud = (req, action, o) => audit.record(req || null, action, { ...o, detail: scrub(o && o.detail) }).catch(() => {});
const fmtAmount = (n) => `${Number(n).toLocaleString('fr-FR')} FCFA`;

/** Informations publiques sur le mode (jamais de secret). */
function modeInfo() {
  return { mode: cfg().mode, test: cfg().test, enabled: cfg().enabled, hasWebhookKey: Boolean(cfg().webhookKey), baseHost: (() => { try { return new URL(cfg().baseUrl).host; } catch { return ''; } })(), pendingTtlMin: cfg().pendingTtlMin };
}

const PUB_ERR = {
  ER101: 'Numéro invalide : saisissez un numéro camerounais Mobile Money (6XXXXXXXX).',
  ER102: 'Seuls les numéros MTN Mobile Money et Orange Money sont acceptés.',
  ER201: 'Montant refusé par l’opérateur. Contactez-nous.',
};

/**
 * Crée une demande de paiement. plan = { id, name, priceXAF } venant du catalogue (le client n'envoie jamais de prix).
 * Renvoie { payment, reused }. Un seul paiement en attente par client : un double clic renvoie la même demande.
 */
async function createPush({ req, user, plan, operator, phone }) {
  const stale = await db.prepare("SELECT * FROM payments WHERE user_id = ? AND mode = 'push' AND status = 'pending'").get(user.id);
  if (stale) {
    if (stale.expires_at && Date.parse(stale.expires_at) <= Date.now()) await recheck(stale, { via: 'poll' }); // périmée : on relit puis on la fait expirer
    else if (stale.plan === plan.id) return { payment: stale, reused: true };
    else throw new HttpError(409, 'Un paiement est déjà en cours. Confirmez-le sur votre téléphone ou attendez qu’il expire, puis réessayez.');
    // Campay injoignable alors que le délai est passé : on clôture la demande (une confirmation tardive reste prise en compte par la réconciliation)
    await db.prepare("UPDATE payments SET status = 'expired', last_error = 'expiré sans confirmation', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowISO(), stale.id);
    const done = await db.prepare('SELECT status FROM payments WHERE id = ?').get(stale.id);
    if (done.status === 'paid') throw new HttpError(409, 'Votre paiement précédent vient d’être confirmé : votre offre est active.');
  }
  const org = await db.prepare('SELECT id FROM orgs WHERE owner_id = ? ORDER BY id LIMIT 1').get(user.id);
  const extRef = crypto.randomUUID(); // Campay exige une référence externe UUID4 unique par demande
  const amount = Number(plan.priceXAF);
  let reference = '';
  let row = null;
  for (let i = 0; i < 5 && !row; i++) {
    reference = genReference();
    try {
      await db.prepare(`INSERT INTO payments (reference, user_id, plan, operator, phone, amount_xaf, mode, status, provider_ref, created_at, currency, org_id, ext_ref, expires_at, test_mode)
        VALUES (?, ?, ?, ?, ?, ?, 'push', 'pending', NULL, ?, 'XAF', ?, ?, ?, ?)`)
        .run(reference, user.id, plan.id, operator, maskPhone(phone), amount, nowISO(), org ? org.id : null, extRef, new Date(Date.now() + cfg().pendingTtlMin * 60000).toISOString(), cfg().test ? 1 : 0);
      row = await db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
    } catch (e) {
      if (e.code !== '23505') throw e;
      const cur = await db.prepare("SELECT * FROM payments WHERE user_id = ? AND mode = 'push' AND status = 'pending'").get(user.id);
      if (cur) { if (cur.plan === plan.id) return { payment: cur, reused: true }; throw new HttpError(409, 'Un paiement est déjà en cours. Confirmez-le sur votre téléphone ou attendez qu’il expire, puis réessayez.'); }
      // sinon : collision de référence interne, on retente avec une autre
    }
  }
  if (!row) throw new HttpError(503, 'Le paiement n’a pas pu être préparé. Réessayez.');

  let c = null; let lastErr = null;
  for (let i = 0; i < 2 && !c; i++) { // un seul nouvel essai, uniquement sur panne réseau : la référence externe rend la demande idempotente chez Campay
    try { c = await client.collect({ amount, from: phone, externalReference: extRef, externalUser: String(user.id), description: `MABAH ${custom.label(plan.name)} ${reference}` }); }
    catch (e) { lastErr = e; if (!e.network) break; }
  }
  if (!c) {
    const code = (lastErr && (lastErr.code || (lastErr.network ? 'RESEAU' : 'ERREUR'))) || 'ERREUR';
    await db.prepare("UPDATE payments SET status = 'failed', last_error = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(code, nowISO(), row.id);
    await aud(req, 'payment.start_failed', { userId: user.id, target: reference, severity: 'warn', detail: `${code} ${oneLine(lastErr && lastErr.message, 120)} ${maskPhone(phone)}` });
    log.warn('Campay : démarrage du paiement impossible :', reference, code, scrub(oneLine(lastErr && lastErr.message, 160)));
    if (PUB_ERR[code]) throw new HttpError(400, PUB_ERR[code]);
    throw new HttpError(502, "Le paiement mobile n'a pas pu démarrer. Réessayez dans un instant ou contactez-nous sur WhatsApp.");
  }
  await db.prepare('UPDATE payments SET provider_ref = ?, operator = ? WHERE id = ?').run(c.reference, OP_NAMES[c.operator] ? c.operator : operator, row.id);
  await accounts.recordEvent(user.id, 'paiement_initie', reference);
  await aud(req, 'payment.initiated', { userId: user.id, target: reference, detail: `${fmtAmount(amount)} ${plan.id} ${OP_NAMES[c.operator] ? c.operator : operator} ${maskPhone(phone)} mode ${cfg().mode}` });
  return { payment: await db.prepare('SELECT * FROM payments WHERE id = ?').get(row.id), reused: false, ussdCode: c.ussdCode };
}

/** Contrôles croisés entre la réponse de Campay et la commande attendue. Renvoie la liste des écarts (vide = conforme). */
function mismatches(p, tx) {
  const bad = [];
  if (p.provider_ref && tx.reference !== p.provider_ref) bad.push('référence');
  if (p.ext_ref && tx.externalReference !== p.ext_ref) bad.push('référence externe');
  if (tx.status === 'paid') {
    if (!Number.isFinite(tx.amount) || tx.amount !== Number(p.amount_xaf)) bad.push('montant');
    if (tx.currency !== (p.currency || 'XAF')) bad.push('devise');
  }
  return bad;
}

async function failNotice(p, text, kind = 'payment_failed') {
  await accounts.recordEvent(p.user_id, 'paiement_refuse', p.reference);
  await accounts.addNotice(p.user_id, kind, { title: 'Paiement non abouti', text, data: { reference: p.reference } });
}

/** Applique l'état relu chez Campay (jamais le corps d'un webhook) à la commande. Renvoie le statut interne à jour. */
async function applyRemote(p, tx, via, req) {
  const touch = nowISO();
  await db.prepare('UPDATE payments SET last_checked_at = ?, check_count = check_count + 1 WHERE id = ?').run(touch, p.id);
  if (p.status === 'paid') return 'paid';

  const bad = mismatches(p, tx);
  if (bad.length && tx.status === 'paid') { // argent reçu mais la commande ne correspond pas : on n'active rien, on prévient
    await db.prepare("UPDATE payments SET status = 'needs_review', last_error = ? WHERE id = ? AND status IN ('pending', 'expired', 'failed')").run(`écart : ${bad.join(', ')}`, p.id);
    await aud(req, 'payment.mismatch', { userId: p.user_id, target: p.reference, severity: 'critical', detail: `Campay annonce un paiement réussi mais ${bad.join(', ')} ne correspond pas (attendu ${fmtAmount(p.amount_xaf)}, reçu ${tx.amount} ${tx.currency}).` });
    return 'needs_review';
  }
  if (bad.length) await db.prepare('UPDATE payments SET last_error = ? WHERE id = ?').run(`écart : ${bad.join(', ')}`, p.id);
  const op = OP_NAMES[tx.operator] ? tx.operator : p.operator;
  const opRef = tx.code || tx.operatorReference || '';
  if (op !== p.operator || opRef) await db.prepare('UPDATE payments SET operator = ?, operator_ref = ? WHERE id = ?').run(op, opRef || p.operator_ref || '', p.id);

  if (tx.status === 'paid') {
    const r = await markPaid(p.id, { via });
    const now = await db.prepare('SELECT status FROM payments WHERE id = ?').get(p.id);
    if (r) await aud(req, 'payment.paid', { userId: p.user_id, target: p.reference, detail: `${fmtAmount(p.amount_xaf)} confirmé par ${via}` });
    if (now.status === 'paid') return 'paid';
    // Campay a encaissé mais l'offre n'a pas pu être activée (changement d'offre en cours d'abonnement, offre disparue…) : cas à traiter par l'administrateur.
    await db.prepare("UPDATE payments SET status = 'needs_review', last_error = 'activation refusée après encaissement' WHERE id = ? AND status IN ('pending', 'expired', 'failed')").run(p.id);
    await aud(req, 'payment.activation_blocked', { userId: p.user_id, target: p.reference, severity: 'critical', detail: 'Paiement encaissé chez Campay mais offre non activée : à traiter dans Administration > Paiements.' });
    notify('paiement_bloque', `PAIEMENT ENCAISSÉ MAIS OFFRE NON ACTIVÉE : ${p.reference} (${fmtAmount(p.amount_xaf)}). Ouvrez Administration > Paiements pour activer ou rembourser.`);
    return 'needs_review';
  }
  if (tx.status === 'failed') {
    const why = oneLine(tx.reason || 'refusé', 120);
    const up = await db.prepare("UPDATE payments SET status = 'failed', last_error = ?, decided_at = ? WHERE id = ? AND status IN ('pending', 'expired')").run(why, nowISO(), p.id);
    if (up.changes) {
      await failNotice(p, `Votre paiement ${p.reference} n'a pas abouti (refusé ou annulé sur le téléphone). Aucune somme n'est due : vous pouvez réessayer depuis « Abonnement ».`);
      await aud(req, 'payment.failed', { userId: p.user_id, target: p.reference, severity: 'warn', detail: why });
      await checkRepeatedFailures(p.user_id);
    }
    return 'failed';
  }
  // toujours en attente chez Campay
  if (p.status === 'pending' && p.expires_at && Date.parse(p.expires_at) <= Date.now()) {
    const up = await db.prepare("UPDATE payments SET status = 'expired', last_error = 'expiré sans confirmation', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowISO(), p.id);
    if (up.changes) {
      await failNotice(p, `Votre demande de paiement ${p.reference} a expiré sans confirmation sur le téléphone. Aucune somme n'est due : vous pouvez réessayer depuis « Abonnement ».`, 'payment_expired');
      await aud(req, 'payment.expired', { userId: p.user_id, target: p.reference, severity: 'warn', detail: 'aucune confirmation avant la fin du délai' });
      await checkRepeatedFailures(p.user_id);
    }
    return 'expired';
  }
  return p.status;
}

/** Relit la transaction chez Campay et applique le résultat. Ne lève jamais d'erreur : en cas de panne, le motif est gardé et le statut inchangé. */
async function recheck(p, { via = 'poll', req = null } = {}) {
  if (!p || p.mode !== 'push' || !p.provider_ref || p.status === 'paid') return p ? p.status : null;
  let tx;
  try { tx = await client.getTransaction(p.provider_ref); }
  catch (e) {
    await db.prepare('UPDATE payments SET last_checked_at = ?, check_count = check_count + 1, last_error = ? WHERE id = ?').run(nowISO(), `vérification impossible : ${e.code || (e.network ? 'réseau' : 'erreur')}`, p.id);
    log.warn('Campay : vérification impossible :', p.reference, scrub(oneLine(e.message, 140)));
    return p.status;
  }
  return applyRemote(p, tx, via, req);
}

/** Alerte e-mail à l'administrateur : échecs répétés d'un même client (24 h), ou vague d'échecs (panne probable) sur la dernière heure. Jamais plus d'une alerte par période. */
async function checkRepeatedFailures(userId) {
  try {
    const since = minutesAgo(24 * 60);
    const n = Number((await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND mode = 'push' AND status IN ('failed', 'expired') AND created_at >= ?").get(userId, since)).n);
    if (n >= cfg().failAlertCount) {
      const tag = `[client ${userId}]`;
      const seen = await db.prepare("SELECT 1 AS x FROM notifications WHERE type = 'paiement_echecs_repetes' AND text LIKE ? AND created_at >= ?").get(`%${tag}%`, since);
      if (!seen) {
        const u = await db.prepare('SELECT name, contact FROM users WHERE id = ?').get(userId);
        notify('paiement_echecs_repetes', `Échecs de paiement répétés ${tag} : ${u ? u.name + ' (' + u.contact + ')' : 'client inconnu'} - ${n} paiements Mobile Money non aboutis en 24 h. Vérifiez Administration > Paiements (numéro erroné, solde, ou aide à apporter au client).`);
        await aud(null, 'payment.repeated_failures', { userId, target: `user:${userId}`, severity: 'high', detail: `${n} échecs en 24 h` });
      }
    }
    const hourAgo = minutesAgo(60);
    const g = Number((await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE mode = 'push' AND status IN ('failed', 'expired') AND created_at >= ?").get(hourAgo)).n);
    if (g >= cfg().failAlertCount + 2) {
      const seen = await db.prepare("SELECT 1 AS x FROM notifications WHERE type = 'paiement_echecs_globaux' AND created_at >= ?").get(hourAgo);
      if (!seen) notify('paiement_echecs_globaux', `${g} paiements Mobile Money non aboutis en 1 heure (tous clients). Vérifiez l'état de Campay et de vos clés : Administration > Paiements.`);
    }
  } catch (e) { log.warn('Alerte échecs de paiement :', oneLine(e.message, 140)); }
}

/**
 * Webhook Campay. Renvoie { code, body }. Étapes : signature (JWT HS256 + clé de webhook) -> anti-rejeu (empreinte de la signature) -> recherche de la commande
 * par la référence Campay -> RELECTURE du statut chez Campay (le corps du webhook n'est jamais cru) -> contrôles croisés -> activation idempotente.
 */
async function handleWebhook(req) {
  if (!cfg().enabled) return { code: 200, body: { ok: true, ignored: true } }; // paiement automatique non configuré : rien à faire
  const src = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) };
  const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
  const sig = str(src.signature, 4096);
  if (!cfg().webhookKey) {
    await aud(req, 'payment.webhook_rejected', { severity: 'high', detail: 'CAMPAY_WEBHOOK_KEY absente : webhook refusé (la réconciliation prend le relais)' });
    return { code: 503, body: { ok: false } };
  }
  const payload = client.verifyJwtHS256(sig, cfg().webhookKey);
  if (!payload) {
    require('../security/abuse').strike(req, 'bad_signature');
    await aud(req, 'payment.webhook_rejected', { severity: 'warn', detail: sig ? 'signature invalide' : 'signature absente' });
    return { code: 401, body: { ok: false } };
  }
  const campayRef = str(src.reference, 80);
  const hash = crypto.createHash('sha256').update(sig).digest('hex');
  const ins = await db.prepare("INSERT INTO payment_webhook_events (sig_hash, received_at, campay_ref, outcome) VALUES (?, ?, ?, 'received') ON CONFLICT (sig_hash) DO UPDATE SET outcome = 'retry' WHERE payment_webhook_events.outcome = 'error'").run(hash, nowISO(), campayRef);
  if (!ins.changes) {
    await aud(req, 'payment.webhook_replay', { severity: 'warn', target: campayRef, detail: 'même signature déjà reçue : ignoré' });
    return { code: 200, body: { ok: true, duplicate: true } };
  }
  const done = (outcome) => db.prepare('UPDATE payment_webhook_events SET outcome = ? WHERE sig_hash = ?').run(outcome, hash).catch(() => {});
  if (str(src.endpoint, 20) === 'withdraw') { await done('ignored'); return { code: 200, body: { ok: true } }; }
  const p = campayRef ? await db.prepare("SELECT * FROM payments WHERE mode = 'push' AND provider_ref = ?").get(campayRef) : null;
  if (!p) { await done('unknown'); await aud(req, 'payment.webhook_unknown', { severity: 'warn', target: campayRef, detail: 'référence Campay inconnue' }); return { code: 200, body: { ok: true } }; }
  const ext = str(src.external_reference, 80);
  if (ext && p.ext_ref && ext !== p.ext_ref) await aud(req, 'payment.mismatch', { userId: p.user_id, target: p.reference, severity: 'high', detail: 'la référence externe du webhook ne correspond pas à la commande (corps du webhook ignoré, statut relu chez Campay)' });
  const before = p.status;
  const after = await recheck(p, { via: 'webhook', req });
  const fresh = await db.prepare('SELECT status, last_error FROM payments WHERE id = ?').get(p.id);
  await done(fresh.last_error && /vérification impossible/.test(fresh.last_error) && after === before ? 'error' : 'ok');
  return { code: 200, body: { ok: true } };
}

/** Tâche de réconciliation : revérifie les paiements en attente depuis plus de N minutes (webhook perdu) et les expirés récents (confirmation tardive). */
async function reconcile() {
  const out = { checked: 0, paid: 0, failed: 0, expired: 0 };
  // demande jamais partie chez Campay (panne du serveur au mauvais moment) : rien à vérifier, on la clôture
  await db.prepare("UPDATE payments SET status = 'failed', last_error = 'demande non transmise', decided_at = ? WHERE mode = 'push' AND status = 'pending' AND provider_ref IS NULL AND created_at <= ?").run(nowISO(), minutesAgo(cfg().pendingTtlMin + 1));
  const rows = await db.prepare(`SELECT * FROM payments WHERE mode = 'push' AND provider_ref IS NOT NULL AND (
      (status = 'pending' AND created_at <= ?) OR (status = 'expired' AND created_at >= ? AND (last_checked_at IS NULL OR last_checked_at <= ?))) ORDER BY id LIMIT 50`)
    .all(minutesAgo(cfg().reconcileAfterMin), minutesAgo(24 * 60), minutesAgo(15));
  for (const p of rows) {
    out.checked++;
    const s = await recheck(p, { via: 'reconciliation' });
    if (s === 'paid') out.paid++; else if (s === 'failed') out.failed++; else if (s === 'expired') out.expired++;
  }
  await db.prepare('DELETE FROM payment_webhook_events WHERE received_at < ?').run(minutesAgo(60 * 24 * 45));
  return out;
}

/** Activation manuelle par l'administrateur (webhook perdu, cas litigieux) : motif obligatoire, journal d'audit, revérification d'abord. */
async function adminActivate(req, p, reason) {
  const why = String(reason || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
  if (why.length < 5) throw new HttpError(400, 'Indiquez le motif de l’activation manuelle (au moins 5 caractères) : il est conservé dans le journal.');
  if (p.status === 'paid') throw new HttpError(409, 'Ce paiement est déjà validé.');
  if (p.mode !== 'push') throw new HttpError(400, 'Cette activation concerne les paiements automatiques ; utilisez « Valider » pour un paiement manuel.');
  await recheck(p, { via: 'admin', req }); // si Campay confirme, c'est la voie normale (montant et références contrôlés)
  let cur = await db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
  if (cur.status !== 'paid') {
    const r = await markPaid(p.id, { via: 'admin' });
    if (!r) throw new HttpError(409, 'Activation impossible : un changement d’offre est en cours ou l’offre n’existe plus. Corrigez l’abonnement à la main depuis la fiche du client, ou refusez le paiement (remboursement).');
    cur = await db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
  }
  await db.prepare('UPDATE payments SET admin_note = ? WHERE id = ?').run(why, p.id);
  await aud(req, 'payment.admin_activated', { userId: p.user_id, target: p.reference, severity: 'high', detail: `activation manuelle : ${why}` });
  return cur;
}

/** Totaux et files à traiter pour l'écran Paiements de l'administration. */
async function adminStats() {
  const one = async (sql, ...a) => Number((await db.prepare(sql).get(...a)).n || 0);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  return {
    paidCount: await one("SELECT COUNT(*) AS n FROM payments WHERE status = 'paid'"),
    paidXAF: await one("SELECT COALESCE(SUM(amount_xaf), 0) AS n FROM payments WHERE status = 'paid' AND test_mode = 0"),
    paidTestXAF: await one("SELECT COALESCE(SUM(amount_xaf), 0) AS n FROM payments WHERE status = 'paid' AND test_mode = 1"),
    paidMonthXAF: await one("SELECT COALESCE(SUM(amount_xaf), 0) AS n FROM payments WHERE status = 'paid' AND test_mode = 0 AND paid_at >= ?", monthStart),
    failedCount: await one("SELECT COUNT(*) AS n FROM payments WHERE status IN ('failed', 'expired') AND mode = 'push'"),
    pendingCount: await one("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending' AND mode = 'push'"),
    stuckCount: await one("SELECT COUNT(*) AS n FROM payments WHERE mode = 'push' AND status = 'pending' AND created_at <= ?", minutesAgo(cfg().pendingTtlMin)),
    reviewCount: await one("SELECT COUNT(*) AS n FROM payments WHERE status = 'needs_review'"),
  };
}

module.exports = { createPush, recheck, handleWebhook, reconcile, adminActivate, adminStats, modeInfo, maskPhone, scrub, mismatches, OP_NAMES };
