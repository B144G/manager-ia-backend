'use strict';
// Gestion des comptes clients côté administration : chronologie d'activité NON confidentielle, notices dans l'application,
// suspension / réactivation, notes de l'administrateur.
// RÈGLE DE VIE PRIVÉE : on n'enregistre ici que des TYPES d'événements et des dates (et au plus une référence technique : offre, référence de paiement).
// Jamais le contenu d'un message, d'une conversation, d'un fichier, ni une donnée métier (factures, clients de l'entreprise, salaires…).
const { db, nowISO } = require('../db');
const { HttpError, isEmail, log, oneLine } = require('../util');

/** Types d'événements autorisés dans la chronologie, avec leur libellé (en français simple). Tout autre type est ignoré. */
const EVENT_LABELS = {
  inscription: 'Inscription',
  connexion: 'Connexion',
  deconnexion: 'Déconnexion',
  organisation_creee: 'Organisation créée',
  offre_changee: 'Offre changée',
  offre_expiree: 'Offre expirée',
  paiement_initie: 'Paiement lancé',
  paiement_soumis: "Paiement envoyé avec l'ID de transaction",
  paiement_valide: 'Paiement validé',
  paiement_refuse: 'Paiement refusé',
  mot_de_passe_change: 'Mot de passe changé',
  mot_de_passe_reinitialise: 'Mot de passe réinitialisé',
  whatsapp_connecte: 'WhatsApp connecté',
  whatsapp_deconnecte: 'WhatsApp déconnecté',
  connexions_fermees: "Connexions fermées par l'administrateur",
  compte_suspendu: 'Compte suspendu',
  compte_reactive: 'Compte réactivé',
  note_admin: "Note de l'administrateur ajoutée",
};

/** Ce que l'administrateur voit et ne voit pas (affiché tel quel dans la fiche client). */
const SCOPE = {
  visible: [
    "Identité du compte : nom, e-mail ou téléphone, date d'inscription, dernière connexion",
    "Offre, date d'échéance, paiements et reçus",
    'Nombre d\'organisations et de membres, quota de messages IA utilisé (un nombre)',
    'Appareils connectés (type d\'appareil, adresse tronquée, dernière activité)',
    "Chronologie : types d'événements et dates (connexion, paiement, offre changée…)",
    "Vos propres notes d'administrateur",
  ],
  hidden: [
    'Le contenu des messages et des conversations (IA, WhatsApp, e-mails)',
    'Les fichiers et documents du client',
    "Les données de l'entreprise : factures, montants, clients de l'entreprise, salaires, stocks…",
    'Les mots de passe et codes de sécurité',
  ],
};

const clip = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** Ajoute un événement à la chronologie d'un compte. Ne lève jamais d'erreur. */
async function recordEvent(userId, kind, detail = '') {
  try {
    if (!userId || !Object.prototype.hasOwnProperty.call(EVENT_LABELS, kind)) return;
    await db.prepare('INSERT INTO account_events (user_id, kind, detail, at) VALUES (?, ?, ?, ?)').run(Number(userId), kind, clip(detail, 120), nowISO());
  } catch (e) { log.warn('Chronologie : événement non enregistré :', oneLine(e.message, 120)); }
}

/** Même chose pour le propriétaire d'une organisation (connexion / déconnexion WhatsApp). */
async function recordEventForOrgOwner(orgId, kind, detail = '') {
  try {
    const o = await db.prepare('SELECT owner_id FROM orgs WHERE id = ?').get(Number(orgId));
    if (o) await recordEvent(o.owner_id, kind, detail);
  } catch { /* ignoré : la chronologie ne doit jamais gêner */ }
}

/** Message affiché à l'utilisateur dans l'application (bandeau, lu / non lu). `data` : valeurs simples pour traduire le texte côté site. */
async function addNotice(userId, kind, { title = '', text = '', data = {} } = {}) {
  try {
    await db.prepare('INSERT INTO user_notices (user_id, kind, title, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Number(userId), clip(kind, 40), clip(title, 120), clip(text, 600), JSON.stringify(data || {}).slice(0, 800), nowISO());
  } catch (e) { log.warn('Notice utilisateur non enregistrée :', oneLine(e.message, 120)); }
}

const noticeView = (r) => { let data = {}; try { data = JSON.parse(r.data || '{}'); } catch { /* données illisibles */ } return { id: Number(r.id), kind: r.kind, title: r.title, text: r.text, data, read: Boolean(Number(r.is_read)), createdAt: r.created_at }; };
async function listNotices(userId, { limit = 20 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const rows = await db.prepare('SELECT * FROM user_notices WHERE user_id = ? ORDER BY id DESC LIMIT ' + n).all(userId);
  const unread = Number((await db.prepare('SELECT COUNT(*) AS n FROM user_notices WHERE user_id = ? AND is_read = 0').get(userId)).n);
  return { notices: rows.map(noticeView), unread };
}
async function markNoticesRead(userId, ids) {
  if (Array.isArray(ids) && ids.length) {
    const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
    for (const id of clean) await db.prepare('UPDATE user_notices SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, userId);
  } else await db.prepare('UPDATE user_notices SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
}

/** Adresse IP tronquée pour l'affichage (IPv4 : 3 premiers blocs ; IPv6 : 3 premiers groupes). */
function maskIp(ip) {
  const v = String(ip || '').replace(/^::ffff:/, '');
  if (!v) return '';
  if (v.includes(':')) return v.split(':').slice(0, 3).join(':') + ':…';
  const p = v.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : v.slice(0, 8) + '…';
}

const SUSPENDED_MSG = 'Compte suspendu, contactez le support.';
/** Lance une erreur 403 claire si le compte est suspendu. */
function assertNotSuspended(row) {
  if (row && row.suspended_at) { const e = new HttpError(403, SUSPENDED_MSG); e.errorCode = 'suspended'; throw e; }
}

const MAIL_FOOTER = "\n\nL'équipe Brij-IA";

/** Suspend un compte : connexion refusée, appareils déconnectés, WhatsApp (QR) des organisations coupé, notice, e-mail, journal. */
async function suspend(userId, reason, req) {
  const why = clip(reason, 300);
  if (why.length < 5) throw new HttpError(400, 'Indiquez le motif de la suspension (au moins 5 caractères).');
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw new HttpError(404, 'Compte introuvable.');
  if (u.suspended_at) throw new HttpError(409, 'Ce compte est déjà suspendu.');
  await db.prepare('UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?').run(nowISO(), why, u.id);
  const central = require('../security');
  const closed = await central.sessions.revokeAllForUser(u.id, '', 'compte suspendu');
  let wa = 0;
  const orgs = await db.prepare('SELECT id FROM orgs WHERE owner_id = ?').all(u.id);
  const waWeb = require('./waWeb');
  for (const o of orgs) {
    try { if (waWeb.status(o.id).status !== 'disconnected') { await waWeb.stop(o.id); wa++; } } catch (e) { log.warn('Suspension : WhatsApp non coupé :', oneLine(e.message, 100)); }
  }
  await recordEvent(u.id, 'compte_suspendu', why);
  await addNotice(u.id, 'account_suspended', { title: 'Compte suspendu', text: `Votre compte est suspendu. Motif : ${why}. Contactez le support pour le réactiver.`, data: { reason: why } });
  if (isEmail(u.contact)) require('./notify').mailUser(u.contact, 'Votre compte Brij-IA est suspendu', `Bonjour ${u.name},\n\nVotre compte Brij-IA a été suspendu.\nMotif : ${why}\n\nPour le réactiver, contactez le support (WhatsApp +237 653 62 13 88).${MAIL_FOOTER}`);
  await central.audit.record(req || null, 'admin.user_suspend', { target: `user:${u.id}`, severity: 'warn', detail: why.slice(0, 200), actor: { type: 'admin', id: null } });
  return { ok: true, sessionsClosed: closed, whatsappStopped: wa };
}

/** Réactive un compte suspendu. */
async function reactivate(userId, req) {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw new HttpError(404, 'Compte introuvable.');
  if (!u.suspended_at) throw new HttpError(409, "Ce compte n'est pas suspendu.");
  await db.prepare("UPDATE users SET suspended_at = NULL, suspended_reason = '' WHERE id = ?").run(u.id);
  await recordEvent(u.id, 'compte_reactive');
  await addNotice(u.id, 'account_reactivated', { title: 'Compte réactivé', text: 'Votre compte est de nouveau actif. Vous pouvez vous reconnecter.' });
  if (isEmail(u.contact)) require('./notify').mailUser(u.contact, 'Votre compte Brij-IA est de nouveau actif', `Bonjour ${u.name},\n\nVotre compte Brij-IA est de nouveau actif. Vous pouvez vous reconnecter.${MAIL_FOOTER}`);
  await require('../security').audit.record(req || null, 'admin.user_reactivate', { target: `user:${u.id}`, severity: 'warn', actor: { type: 'admin', id: null } });
  return { ok: true };
}

async function addNote(userId, text) {
  const t = clip(text, 1000);
  if (t.length < 2) throw new HttpError(400, 'Écrivez votre note.');
  const u = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!u) throw new HttpError(404, 'Compte introuvable.');
  const r = await db.prepare('INSERT INTO admin_notes (user_id, text, created_at) VALUES (?, ?, ?)').run(userId, t, nowISO());
  await recordEvent(userId, 'note_admin');
  return { id: Number(r.lastInsertRowid) };
}

async function sweep() {
  await db.prepare('DELETE FROM account_events WHERE at < ?').run(new Date(Date.now() - 400 * 86400000).toISOString());
  await db.prepare('DELETE FROM user_notices WHERE created_at < ?').run(new Date(Date.now() - 180 * 86400000).toISOString());
}

module.exports = { EVENT_LABELS, SCOPE, SUSPENDED_MSG, recordEvent, recordEventForOrgOwner, addNotice, listNotices, markNoticesRead, maskIp, assertNotSuspended, suspend, reactivate, addNote, sweep };
